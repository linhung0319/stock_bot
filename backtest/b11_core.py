"""
B-11（T75）：核心固定 VOO：SGOV 比例。

兩個層次：
  甲  只有核心（整個帳戶都是核心）：看比例本身的報酬、回撤、只因為比例而下單的日數
  乙  放進現在的整個帳戶（B-8 主要方案：20/30/50、跨桶上限、搭便車、自選 5% 分級、波動度緩衝 0.10；
      動能維持現況：波動度＋200 日線減半），只換核心的規則：看下單日數會不會變多、報酬差多少

核心規則：
  none      核心全部 VOO（SPY 代理）
  crash     現在的崩盤規則：換股日 SPY < 200 日均線 → 核心一半現金
  ratio     SGOV 比例 p（10%、20%、30%）、界線 ±3 / ±5 / ±10 pp；只在每月換股日檢查，超出才調回 p；
            另有一列每天檢查；另有一列「分母改用總資產」（SGOV = 總資產 10%，界線 ±2.5 pp）
入金情境：每月一次、月報日後第 10 個交易日、金額 = 當時總資產的 1%（同 B-6）。

現金：SGOV（2020-06 前用 3 個月國庫券）。成本 5 bp（SGOV 不計），SGOV 的買賣算一張單。

執行：uv run python backtest/b11_core.py
輸出：backtest/results/B11_core_only.csv、B11_account.csv、B11_summary.md
"""
from __future__ import annotations

from dataclasses import replace

import pandas as pd

import b10_common as bc
import b10_account as ba
from b10_common import pct

END = "2026-09-15"
CORE_RUNS = [("1998–2026", [], "1998-02-02"), ("2000–2026", [], "2000-02-01"), ("2013–2026", [], "2013-06-03")]


def policies():
    out = [("核心不留現金", dict(core_policy="none")),
           ("現在的崩盤規則", dict(core_policy="crash"))]
    for p in (0.10, 0.20, 0.30):
        for b in (0.03, 0.05, 0.10):
            out.append((f"SGOV {int(p*100)}%，界線 ±{int(b*100)} pp", dict(core_policy="ratio", sgov=p, band=b)))
    out.append(("SGOV 20%，界線 ±5 pp，每天檢查", dict(core_policy="ratio", sgov=0.20, band=0.05, ratio_daily=True)))
    return out


def run_core_only(w, spy):
    rows = []
    for name, kw in policies():
        for label, own, start in CORE_RUNS:
            for dep in (0.0, 0.01):
                sc = ba.Acct(name, own_rule=False, vol_scale=False, crash_rule=False, spy_only=True,
                             mom_200=False, deposit=dep, **kw)
                v, od, ev, ex = ba.simulate(sc, own, start, END, w.ranks[0], w)
                r = ba.stats_row(label, name, sc, v, od, ex, spy)
                r["入金"] = dep > 0
                rows.append(r)
        print("甲", name, flush=True)
    return pd.DataFrame(rows)


def run_account(w, spy):
    rows = []
    pol = policies() + [("分母改用總資產：SGOV 10%，界線 ±2.5 pp", dict(core_policy="ratio", sgov=0.10, band=0.025, denom="total"))]
    base = ba.Acct("x", **ba.B8_MAIN)
    for name, kw in pol:
        for label, own, start in ba.RUNS:
            for dep in (0.0, 0.01):
                sc = replace(base, name=name, deposit=dep, **kw)
                v, od, ev, ex = ba.simulate(sc, own, start, END, w.ranks[0], w)
                r = ba.stats_row(label, name, sc, v, od, ex, spy)
                r["入金"] = dep > 0
                rows.append(r)
        print("乙", name, flush=True)
    return pd.DataFrame(rows)


def write_summary(co: pd.DataFrame, ac: pd.DataFrame):
    L = ["# B-11 原始表格", "", "由 `backtest/b11_core.py` 產生。解讀見 `docs/test-records/backtest_B11_2026-11-22.md`。", "",
         "「比例單獨下單日」= 當天唯一的下單原因是核心比例超出界線。年化、Sharpe、回撤用單位淨值（入金不算報酬）。", ""]
    ev_cols = ["2008", "2020", "2022"]
    for label in co.期間.unique():
        L += [f"## 甲 只有核心：{label}", ""]
        rows = []
        for nm in co.情境.unique():
            a = co[(co.期間 == label) & (co.情境 == nm) & (~co.入金)].iloc[0]
            b = co[(co.期間 == label) & (co.情境 == nm) & (co.入金)].iloc[0]
            rows.append([nm, pct(a.年化), f"{a.Sharpe:.2f}", pct(a.最大回撤, 0), pct(a.核心現金平均占比, 0),
                         f"{a.核心比例單獨下單日每年:.2f}", f"{b.核心比例單獨下單日每年:.2f}", f"{a.崩盤規則下單日每年:.2f}"]
                        + [pct(a[e], 0) for e in ev_cols])
        L += bc.md_table(["情境", "年化", "Sharpe", "最大回撤", "平均現金占核心", "比例單獨下單日/年", "同左（入金）",
                          "崩盤規則下單日/年"] + [f"{e} 事件" for e in ev_cols], rows) + [""]
    for label in ac.期間.unique():
        L += [f"## 乙 整個帳戶（B-8 主要方案，只換核心）：{label}", ""]
        rows = []
        for nm in ac.情境.unique():
            a = ac[(ac.期間 == label) & (ac.情境 == nm) & (~ac.入金)].iloc[0]
            b = ac[(ac.期間 == label) & (ac.情境 == nm) & (ac.入金)].iloc[0]
            rows.append([nm, pct(a.年化), f"{a.Sharpe:.2f}", pct(a.最大回撤, 0), pct(a.相對SPY最大回撤, 0),
                         f"{a.下單日每年:.1f}", f"{a.核心比例單獨下單日每年:.2f}", f"{b.下單日每年:.1f}", f"{b.核心比例單獨下單日每年:.2f}",
                         pct(a.現金占總資產平均, 0)] + [pct(a[e], 0) for e in ev_cols])
        L += bc.md_table(["情境", "年化", "Sharpe", "最大回撤", "相對 SPY 最大回撤", "下單日/年", "比例單獨下單日/年",
                          "下單日/年（入金）", "比例單獨（入金）", "平均現金占總資產"] + [f"{e} 事件" for e in ev_cols], rows) + [""]
    (bc.OUT / "B11_summary.md").write_text("\n".join(L), encoding="utf-8")


def main():
    w = bc.World((0,), extra=["MU", "NVDA", "MSFT", "META"])
    spy = w.prices.last_close["SPY"]
    co = run_core_only(w, spy)
    co.to_csv(bc.OUT / "B11_core_only.csv", index=False)
    ac = run_account(w, spy)
    ac.to_csv(bc.OUT / "B11_account.csv", index=False)
    write_summary(co, ac)
    print("完成，見 backtest/results/B11_summary.md")


if __name__ == "__main__":
    main()
