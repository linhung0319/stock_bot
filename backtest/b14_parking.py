"""
B-14（T77 前的補測）：錢移出／移回動能、自選時，暫放在哪裡。

問題（使用者 2026-11-22）：動能減碼、自選減持的錢，是直接進核心照比例分，還是撤到 SGOV 等著移回？

  core  移出的錢進核心照比例分到 VOO / SGOV；移回時從核心照比例拿（B-11～B-13 的做法）
  sgov  移出的錢留在原桶、放 SGOV；移回時先用這筆，不夠才從核心拿
  voo   同上，放 VOO（動能減碼放 SPY，是 B-2 / 先前研究的做法）

動能：只有比例改變（波動度、200 日線）減下來的錢暫放；換股、跨桶上限照舊進出核心。
自選：用慢規則（-20% 減半、站回 200 日線加回）當代理；以論點為主的實際做法回測不出來。
      自選的暫放錢在沒有減半中的股票時還給核心。

框架：B-8 主要方案、自選有慢規則；核心 SGOV 20%（±5 pp）與折衷 N=3；動能 M2（只有波動度）與 M1（現況）；
三種換股日偏移、兩個期間。

執行：uv run python backtest/b14_parking.py
輸出：backtest/results/B14_account.csv、B14_summary.md
"""
from __future__ import annotations

from dataclasses import replace

import pandas as pd

import b10_common as bc
import b10_account as ba
from b10_common import pct

END = "2026-09-15"
OFFSETS = (0, 5, 10)
CORES = {"SGOV 20%": dict(core_policy="ratio", sgov=0.20, band=0.05),
         "折衷 N=3": dict(core_policy="ratio", sgov=0.20, band=0.05, hyb_n=3)}
MOM = {"M2 只有波動度": dict(mom_200=False), "M1 現況（波動度＋200 日線）": dict(mom_200=True)}
PARK = {"都進核心（B-11～13 的做法）": dict(mom_park="core", own_park="core"),
        "動能減碼 → 動能的 SGOV": dict(mom_park="sgov"),
        "動能減碼 → 動能的 VOO": dict(mom_park="voo"),
        "自選減持 → 自選的 SGOV": dict(own_park="sgov"),
        "自選減持 → 自選的 VOO": dict(own_park="voo"),
        "兩者都 → 各自的 SGOV": dict(mom_park="sgov", own_park="sgov")}
EV = ["2000–02", "2008", "2020", "2022", "2026-07"]


def main():
    w = bc.World(OFFSETS, extra=["MU", "NVDA", "MSFT", "META"])
    spy = w.prices.last_close["SPY"]
    base = ba.Acct("x", **ba.B8_MAIN)
    rows = []
    for m, mk in MOM.items():
        for c, ck in CORES.items():
            for pname, pk in PARK.items():
                for label, tickers, start in ba.RUNS:
                    for off in OFFSETS:
                        sc = replace(base, name=pname, own_rule=True, **mk, **ck, **pk)
                        v, od, ev, ex = ba.simulate(sc, tickers, start, END, w.ranks[off], w)
                        r = ba.stats_row(label, pname, sc, v, od, ex, spy)
                        r.update(動能=m, 核心=c, 暫放=pname, 偏移=off)
                        rows.append(r)
                print(m, c, pname, flush=True)
    res = pd.DataFrame(rows)
    res.to_csv(bc.OUT / "B14_account.csv", index=False)
    L = ["# B-14 原始表格", "", "由 `backtest/b14_parking.py` 產生。解讀見 `docs/test-records/backtest_B14_2026-11-22.md`。",
         "三偏移平均（括號為偏移 0）。現金占總資產包含各桶暫放的 SGOV。", ""]
    for label in res.期間.unique():
        L += [f"## {label}", ""]
        rows = []
        for (m, c, p), g in res[res.期間 == label].groupby(["動能", "核心", "暫放"], sort=False):
            r0 = g[g.偏移 == 0].iloc[0]
            rows.append([m, c, p, f"{pct(g.年化.mean())}（{pct(r0.年化)}）", f"{g.Sharpe.mean():.2f}", pct(g.最大回撤.mean(), 0),
                         pct(g.相對SPY最大回撤.mean(), 0), f"{g.下單日每年.mean():.1f}", f"{g.每次平均單數.mean():.1f}",
                         pct(g.現金占總資產平均.mean(), 0)] + [pct(g[e].mean(), 0) for e in EV])
        L += bc.md_table(["動能", "核心", "暫放", "年化", "Sharpe", "最大回撤", "相對 SPY 最大回撤", "下單日/年", "每次單數",
                          "現金占總資產"] + EV, rows) + [""]
    (bc.OUT / "B14_summary.md").write_text("\n".join(L), encoding="utf-8")
    print("完成，見 backtest/results/B14_summary.md")


if __name__ == "__main__":
    main()
