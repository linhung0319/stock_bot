"""
B-13（T77 前的補測）：核心折衷版 —— 平時固定 SGOV 20%，持續跌破 200 日線才加碼現金。

規則（看結果前定好）：
  平時      SGOV 20%（分母是核心），界線 ±5 pp，每月換股日檢查
  加碼      換股日 SPY 前一天收盤 < 200 日均線，連續 N 次（N = 3，主要）→ SGOV 目標改成 50%
            （50% = 現在崩盤規則的「核心一半現金」）
  解除      某次換股日回到 200 日均線之上 → 回到 20%
  敏感度    N = 2、N = 1（N = 1 = 崩盤規則疊在 20% 上）
N = 3 是在 T76 之後的說明裡提出的（看過「19 次啟動有 11 次只維持一到兩個月」），所以有樣本內的成分，
紀錄要寫明；N = 2、1 一起列出，不挑。

兩個層次與 B-11、B-12 相同：甲 只有核心；乙 整個帳戶（B-8 主要方案，動能 M2 只有波動度／M1 現況，
自選有／沒有慢規則，三種換股日偏移）。

執行：uv run python backtest/b13_hybrid.py
輸出：backtest/results/B13_core_only.csv、B13_segments.csv、B13_account.csv、B13_summary.md
"""
from __future__ import annotations

from dataclasses import replace

import pandas as pd

import b10_common as bc
import b10_account as ba
from b10_common import pct

END = "2026-09-15"
OFFSETS = (0, 5, 10)
CORES = {"崩盤規則（現在）": dict(core_policy="crash"),
         "SGOV 20%": dict(core_policy="ratio", sgov=0.20, band=0.05),
         "SGOV 30%": dict(core_policy="ratio", sgov=0.30, band=0.05),
         "折衷 N=3（20%→50%）": dict(core_policy="ratio", sgov=0.20, band=0.05, hyb_n=3),
         "折衷 N=2": dict(core_policy="ratio", sgov=0.20, band=0.05, hyb_n=2),
         "折衷 N=1": dict(core_policy="ratio", sgov=0.20, band=0.05, hyb_n=1)}
MOM = {"M2 只有波動度": dict(mom_200=False), "M1 現況（波動度＋200 日線）": dict(mom_200=True)}
OWN = {"有慢規則": True, "沒有慢規則": False}
CORE_RUNS = [("1998–2026", "1998-02-02"), ("2000–2026", "2000-02-01"), ("2013–2026", "2013-06-03")]
SEGS = [("1998-02", "1999-12", "1998–99 多頭"), ("2000-01", "2003-03", "2000–03 空頭"), ("2003-04", "2007-09", "2003–07 多頭"),
        ("2007-10", "2009-06", "2007–09 空頭"), ("2009-07", "2019-12", "2009–19 多頭"), ("2020-01", "2020-12", "2020 V 型"),
        ("2021-01", "2021-12", "2021 多頭"), ("2022-01", "2022-12", "2022 空頭"), ("2023-01", "2026-09", "2023–26 多頭")]
EV = ["2000–02", "2008", "2020", "2022", "2026-07"]


def core_only(w, spy):
    rows, seg_rows = [], []
    curves = {}
    for name, kw in CORES.items():
        for label, start in CORE_RUNS:
            sc = ba.Acct(name, own_rule=False, vol_scale=False, crash_rule=False, spy_only=True, mom_200=False, **kw)
            v, od, ev, ex = ba.simulate(sc, [], start, END, w.ranks[0], w)
            rows.append(ba.stats_row(label, name, sc, v, od, ex, spy))
            if label == "1998–2026":
                curves[name] = v
    curves["不留現金"] = spy.reindex(curves["SGOV 20%"].index)
    for a, b, seg in SEGS:
        r = {"期間": seg}
        for name, v in curves.items():
            x = v.loc[a:b]
            r[name] = x.iloc[-1] / x.iloc[0] - 1
        seg_rows.append(r)
    return pd.DataFrame(rows), pd.DataFrame(seg_rows)


def account(w, spy):
    base = ba.Acct("x", **ba.B8_MAIN)
    combos = [(m, c) for m in MOM for c in CORES if not (c.startswith("崩盤") and m.startswith("M2"))]
    rows = []
    for m, c in combos:
        for own, rule in OWN.items():
            for label, tickers, start in ba.RUNS:
                for off in OFFSETS:
                    sc = replace(base, name=c, own_rule=rule, **MOM[m], **CORES[c])
                    v, od, ev, ex = ba.simulate(sc, tickers, start, END, w.ranks[off], w)
                    r = ba.stats_row(label, c, sc, v, od, ex, spy)
                    r.update(動能=m, 核心=c, 自選=own, 偏移=off)
                    rows.append(r)
        print(m, c, flush=True)
    return pd.DataFrame(rows)


def hyb_spans(w):
    """折衷 N=3 的加碼期間（換股日，偏移 0）。"""
    rd = [d for d in sorted(w.ranks[0]) if d >= pd.Timestamp("1998-02-02")]
    below = w.reg["below200"].astype(bool).shift(1, fill_value=False).reindex(rd)
    out = {}
    for n in (3, 2, 1):
        cnt, on, spans, start = 0, False, [], None
        for d, b in below.items():
            cnt = cnt + 1 if b else 0
            new = cnt >= n
            if new and not on:
                start = d
            if on and not new:
                spans.append((start, d))
            on = new
        if on:
            spans.append((start, None))
        out[n] = spans
    return out


def write_summary(co, seg, ac, spans):
    L = ["# B-13 原始表格", "", "由 `backtest/b13_hybrid.py` 產生。解讀見 `docs/test-records/backtest_B13_2026-11-22.md`。", ""]
    for label in co.期間.unique():
        L += [f"## 甲 只有核心：{label}", ""]
        rows = []
        for _, r in co[co.期間 == label].iterrows():
            rows.append([r.情境, pct(r.年化), f"{r.Sharpe:.2f}", pct(r.最大回撤, 0), pct(r.核心現金平均占比, 0),
                         f"{r.崩盤規則下單日每年 + r.崩盤加碼下單日每年:.2f}", f"{r.核心比例單獨下單日每年:.2f}"] + [pct(r[e], 0) for e in EV])
        L += bc.md_table(["核心", "年化", "Sharpe", "最大回撤", "平均現金占核心", "崩盤規則／加碼下單日/年", "比例單獨/年"] + [f"{e} 事件" for e in EV], rows) + [""]
    L += ["## 甲 只有核心：各段報酬（1998–2026 的同一條曲線切段）", ""]
    cols = [c for c in seg.columns if c != "期間"]
    L += bc.md_table(["期間"] + cols, [[r.期間] + [pct(r[c], 0) for c in cols] for _, r in seg.iterrows()]) + [""]
    L += ["## 加碼期間（換股日，偏移 0）", ""]
    for n, sp in spans.items():
        L.append(f"- N={n}：{len(sp)} 次；" + "、".join(f"{a:%Y-%m}～{b:%Y-%m}" if b is not None else f"{a:%Y-%m}～" for a, b in sp))
    L.append("")
    for label in ac.期間.unique():
        L += [f"## 乙 整個帳戶：{label}（三偏移平均；括號為偏移 0）", ""]
        rows = []
        sub = ac[ac.期間 == label]
        for (m, c, own), g in sub.groupby(["動能", "核心", "自選"], sort=False):
            r0 = g[g.偏移 == 0].iloc[0]
            rows.append([m, c, own, f"{pct(g.年化.mean())}（{pct(r0.年化)}）", f"{g.Sharpe.mean():.2f}", pct(g.最大回撤.mean(), 0),
                         pct(g.相對SPY最大回撤.mean(), 0), f"{g.下單日每年.mean():.1f}",
                         f"{(g.崩盤規則下單日每年 + g.崩盤加碼下單日每年).mean():.2f}", pct(g.現金占總資產平均.mean(), 0)]
                        + [pct(g[e].mean(), 0) for e in EV])
        L += bc.md_table(["動能", "核心", "自選", "年化", "Sharpe", "最大回撤", "相對 SPY 最大回撤", "下單日/年", "崩盤規則／加碼下單日/年",
                          "現金占總資產"] + EV, rows) + [""]
    (bc.OUT / "B13_summary.md").write_text("\n".join(L), encoding="utf-8")


def main():
    w = bc.World(OFFSETS, extra=["MU", "NVDA", "MSFT", "META"])
    spy = w.prices.last_close["SPY"]
    co, seg = core_only(w, spy)
    co.to_csv(bc.OUT / "B13_core_only.csv", index=False)
    seg.to_csv(bc.OUT / "B13_segments.csv", index=False)
    ac = account(w, spy)
    ac.to_csv(bc.OUT / "B13_account.csv", index=False)
    write_summary(co, seg, ac, hyb_spans(w))
    print("完成，見 backtest/results/B13_summary.md")


if __name__ == "__main__":
    main()
