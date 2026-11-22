"""
B-12（T76）：整個帳戶合起來。

框架：B-8 主要方案（20 / 30 / 50、跨桶上限、搭便車、自選 5% 分級、波動度緩衝 0.10、出場名次 15），
換動能的開關與核心的規則，自選跑有慢規則／沒有慢規則兩個上下界。

  動能（T74 的候選）  M1 現況：波動度＋200 日線減半
                      M2 只有波動度
                      M4 波動度＋空頭加高波動（24 月）
                      M5b M4＋200 日線減半
  核心（T75 的候選）  不留現金；SGOV 10 / 20 / 30%，界線 ±5 pp，每月檢查
  現在的完整設計      M1＋崩盤規則＋自選慢規則（B-8 主要方案，現金計息）
  自選                有慢規則（B-1 SLOW）／沒有慢規則（買進持有，仍有單檔上限、跨桶上限）
  換股日偏移          每月第 1、6、11 個交易日（月報日跟著移）
另加對照：M1、M2 × SGOV 20% × 出場名次 5。

執行：uv run python backtest/b12_account.py
輸出：backtest/results/B12_account.csv、B12_summary.md
"""
from __future__ import annotations

from dataclasses import replace

import pandas as pd

import b10_common as bc
import b10_account as ba
from b10_common import pct

END = "2026-09-15"
OFFSETS = (0, 5, 10)
MOM = {"M1 現況（波動度＋200 日線）": dict(mom_200=True),
       "M2 只有波動度": dict(mom_200=False),
       "M4 波動度＋空頭加高波動": dict(mom_200=False, switch="bear24hv"),
       "M5b M4＋200 日線": dict(mom_200=True, switch="bear24hv")}
CORE = {"不留現金": dict(core_policy="none"),
        "SGOV 10%": dict(core_policy="ratio", sgov=0.10, band=0.05),
        "SGOV 20%": dict(core_policy="ratio", sgov=0.20, band=0.05),
        "SGOV 30%": dict(core_policy="ratio", sgov=0.30, band=0.05)}
OWN = {"有慢規則": True, "沒有慢規則": False}
EV = ["2000–02", "2008", "2009 反彈", "2020", "2022", "2026-07"]


def grid():
    out = [("現在的完整設計", "崩盤規則", own, 15, dict(mom_200=True, core_policy="crash", own_rule=r)) for own, r in OWN.items()]
    for m, mk in MOM.items():
        for c, ck in CORE.items():
            for own, r in OWN.items():
                out.append((m, c, own, 15, dict(**mk, **ck, own_rule=r)))
    for m in list(MOM)[:2]:
        out.append((m, "SGOV 20%", "有慢規則", 5, dict(**MOM[m], **CORE["SGOV 20%"], own_rule=True)))
    return out


def main():
    w = bc.World(OFFSETS, extra=["MU", "NVDA", "MSFT", "META"])
    spy = w.prices.last_close["SPY"]
    base = ba.Acct("x", **ba.B8_MAIN)
    rows = []
    for m, c, own, ex, kw in grid():
        for label, tickers, start in ba.RUNS:
            for off in OFFSETS:
                sc = replace(base, name=m, exit_rank=ex, **kw)
                v, od, ev, extra = ba.simulate(sc, tickers, start, END, w.ranks[off], w)
                r = ba.stats_row(label, m, sc, v, od, extra, spy)
                r.update(動能=m, 核心=c, 自選=own, 出場名次=ex, 偏移=off)
                r.update({f"相對_{k}": x for k, x in bc.event_rel(v, spy).items()})
                rows.append(r)
        print(m, c, own, ex, flush=True)
    res = pd.DataFrame(rows)
    res.to_csv(bc.OUT / "B12_account.csv", index=False)
    write_summary(res)
    print("完成，見 backtest/results/B12_summary.md")


def write_summary(res: pd.DataFrame):
    keys = ["動能", "核心", "自選", "出場名次"]
    L = ["# B-12 原始表格", "", "由 `backtest/b12_account.py` 產生。解讀見 `docs/test-records/backtest_B12_2026-11-22.md`。", "",
         "數字為偏移 0；「三偏移平均」「範圍」為每月第 1、6、11 個交易日換股的平均與最低～最高。事件欄為帳戶在事件窗內的絕對報酬（偏移 0）。", ""]
    for label in res.期間.unique():
        sub = res[res.期間 == label]
        L += [f"## {label}", ""]
        rows = []
        for k, g in sub.groupby(keys, sort=False):
            r0 = g[g.偏移 == 0].iloc[0]
            rows.append(list(k) + [pct(r0.年化), f"{pct(g.年化.mean())}（{pct(g.年化.min())}～{pct(g.年化.max())}）",
                                   f"{r0.Sharpe:.2f}", f"{g.Sharpe.mean():.2f}", pct(r0.最大回撤, 0),
                                   f"{pct(g.最大回撤.min(), 0)}～{pct(g.最大回撤.max(), 0)}", pct(r0.相對SPY最大回撤, 0),
                                   f"{r0.下單日每年:.1f}", f"{r0.崩盤規則下單日每年:.2f}", f"{r0.動能開關下單日每年:.2f}",
                                   f"{r0.核心比例單獨下單日每年:.2f}", pct(r0.現金占總資產平均, 0)]
                        + [pct(r0[e], 0) for e in EV])
        L += bc.md_table(keys + ["年化", "三偏移平均（範圍）", "Sharpe", "Sharpe 三偏移平均", "最大回撤", "最大回撤範圍", "相對 SPY 最大回撤",
                                 "下單日/年", "含 200 日線/年", "含開關/年", "比例單獨/年", "現金占總資產"] + EV, rows) + [""]
    (bc.OUT / "B12_summary.md").write_text("\n".join(L), encoding="utf-8")


if __name__ == "__main__":
    main()
