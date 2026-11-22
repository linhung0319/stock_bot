"""
B-10（T74）：動能的開關與出場名次。只看動能部位本身（沒有核心、沒有自選），和 B-2 的「沒有核心」表同一個框架。

部位規則（沿用 B-2 lazy，加上 B-8 的波動度緩衝 0.10）：
  名單      ：前 5 名進場、掉出前 exit_rank 名才賣；部位內等權；留任股偏離 ±50% 才拉回
  波動度    ：Barroso & Santa-Clara 2015，以 1/3 為單位、緩衝 0.10；減下來的放 SPY
  200 日線  ：換股日 SPY 前一天收盤 < 200 日均線 → 名單比重再減半，減下來的放現金（現況）
  開關      ：bear24      SPY 過去 24 個月報酬為負（Daniel & Moskowitz 2016）
              bear24hv    空頭且 SPY 過去 126 日波動 > 歷史中位數（Daniel & Moskowitz 2016 的交互項）
              bear36(hv)  同上，36 個月（Cooper, Gutierrez & Hameed 2004），敏感度
              開關打開時名單比重 = 0，動能的錢全部放 SPY（不放現金）；打開期間 200 日線不再另外減
  現金      ：SGOV（2020-06 前用 3 個月國庫券）
  成本      ：每單位成交金額 5 bp（現金不計）

另外：重現「前 5 名、無緩衝、無風險層」和 lean_strategies 的 LEAN 結果比對。

執行：uv run python backtest/b10_momentum.py
輸出：backtest/results/B10_results.csv、B10_events.csv、B10_summary.md
"""
from __future__ import annotations

import json
from dataclasses import dataclass, asdict

import numpy as np
import pandas as pd

import b10_common as bc
from b10_common import mb, pct

LEAN_RESULT = mb.HERE.parents[1] / "Stock" / "lean_strategies" / "results" / "momentum_effect_top5_1997_2026" / "MomentumEffect.json"
OFFSETS = (0, 5, 10)
PERIODS = [("1998-02", "2026-09", "1998–2026"), ("2000-01", "2019-12", "2000–2019"), ("2016-01", "2026-09", "2016–2026")]


@dataclass(frozen=True)
class MomCfg:
    name: str
    offset: int = 0
    exit_rank: int = 15
    vol: bool = True
    sma200: bool = False
    switch: str | None = None
    skip: bool = False


COMBOS = [
    MomCfg("1 現況：波動度＋200 日線減半", sma200=True),
    MomCfg("2 只有波動度"),
    MomCfg("3 波動度＋空頭（24 月）", switch="bear24"),
    MomCfg("4 波動度＋空頭加高波動（24 月）", switch="bear24hv"),
    MomCfg("5a 第 3 項＋200 日線減半", switch="bear24", sma200=True),
    MomCfg("5b 第 4 項＋200 日線減半", switch="bear24hv", sma200=True),
    MomCfg("3' 波動度＋空頭（36 月）", switch="bear36"),
    MomCfg("4' 波動度＋空頭加高波動（36 月）", switch="bear36hv"),
    MomCfg("5a' 第 3' 項＋200 日線減半", switch="bear36", sma200=True),
    MomCfg("5b' 第 4' 項＋200 日線減半", switch="bear36hv", sma200=True),
    MomCfg("參考：不做任何風險層", vol=False),
    MomCfg("參考：現況，排名跳過最近一個月", sma200=True, skip=True),
    MomCfg("參考：只有波動度，排名跳過最近一個月", skip=True),
]


def simulate(cfg: MomCfg, ranks: dict, w: bc.World):
    P = w.prices
    days = P.close.index
    cash = w.cash
    rdays = sorted(ranks)
    sw_ser = w.reg[cfg.switch].shift(1, fill_value=False) if cfg.switch else None
    c200_ser = w.reg["below200"].shift(1, fill_value=False)

    def px(t, d, field="open"):
        if t == "CASH":
            return float(cash.at[d])
        return float((P.open if field == "open" else P.last_close).at[d, t])

    units = {"SPY": 1.0 / px("SPY", rdays[0])}
    held: list[str] = []
    vs = bc.VolScaler(0.10)
    eff_prev, sw_prev, c_prev = None, None, None
    n_sw, n_c200 = 0, 0
    monthly = []
    values = pd.Series(index=days, dtype=float)
    r_iter = iter(rdays + [None])
    next_r = next(r_iter)
    for day in days[days.searchsorted(rdays[0]):]:
        if day == next_r:
            order = list(ranks[day].index)
            pos = {t: k for k, t in enumerate(order)}
            keep = [t for t in held if t in pos and pos[t] < cfg.exit_rank]
            new = [t for t in order if t not in keep][: max(0, mb.PORTFOLIO - len(keep))]
            names = keep + new
            vw = vs.step(mb.excess_vol(P, names, day)) if cfg.vol else 1.0
            sw = bool(sw_ser.at[day]) if cfg.switch else False
            c2 = bool(c200_ser.at[day]) if cfg.sma200 else False
            if sw_prev is not None and sw != sw_prev:
                n_sw += 1
            if c_prev is not None and c2 != c_prev:
                n_c200 += 1
            if sw:
                eff, cash_w = 0.0, 0.0
            else:
                eff = vw * (0.5 if c2 else 1.0)
                cash_w = vw * 0.5 if c2 else 0.0
            val = {t: u * px(t, day) for t, u in units.items()}
            total = sum(val.values())
            cur = {t: v / total for t, v in val.items()}
            name_w = eff / mb.PORTFOLIO
            tgt = {t: 0.0 for t in cur if t not in ("SPY", "CASH")}
            if eff > 0:
                for t in names:
                    tgt[t] = name_w
            changed = eff_prev is None or eff != eff_prev
            if not changed and eff > 0:
                for t in keep:
                    if abs(cur.get(t, 0) - name_w) <= mb.LAZY_BAND * name_w:
                        tgt[t] = cur.get(t, 0)
            tgt["CASH"] = cash_w if changed else cur.get("CASH", 0.0)
            if sum(tgt.values()) > 1:
                for t in names:
                    tgt[t] = name_w
            tgt["SPY"] = 1 - sum(v for t, v in tgt.items() if t != "SPY")
            traded = sum(abs(tgt.get(t, 0) - cur.get(t, 0)) for t in set(tgt) | set(cur) if t != "CASH") * total
            n_tr = sum(1 for t in set(tgt) | set(cur) if t not in ("SPY", "CASH") and abs(tgt.get(t, 0) - cur.get(t, 0)) > 1e-9)
            total_after = total - traded * mb.FEE
            units = {t: tgt[t] * total_after / px(t, day) for t in tgt if tgt[t] > 1e-12}
            now_held = names if eff > 0 else []
            monthly.append(dict(date=day, eff=eff, sw=sw, c200=c2, n_trades=n_tr,
                                sold=len(set(held) - set(now_held)), names=",".join(now_held)))
            held, eff_prev, sw_prev, c_prev = now_held, eff, sw, c2
            next_r = next(r_iter)
        values[day] = sum(u * px(t, day, "close") for t, u in units.items())
    return values.dropna(), pd.DataFrame(monthly).set_index("date"), n_sw, n_c200


def lean_check(w: bc.World):
    """前 5 名、無緩衝、無風險層、reset：和 LEAN 結果比對（整段，以及兩者選股一致的 1998-12 以後）。"""
    v, m, _ = mb.simulate(mb.Config(0, 5, "none", 0.0, "reset"), w.ranks[0], w.prices, None)
    d = json.loads(LEAN_RESULT.read_text())
    eq = d["charts"]["Strategy Equity"]["series"]["Equity"]["values"]
    le = pd.Series([x[4] for x in eq], index=pd.to_datetime([x[0] for x in eq], unit="s").normalize())
    le = le[~le.index.duplicated(keep="last")]
    le = le[le.index.day_of_week < 5]
    rows = []
    for lo, hi, label in [("1997-02-03", "2026-09-15", "1997-02 → 2026-09（LEAN 全段）"),
                          ("1998-12-01", "2026-09-15", "1998-12 → 2026-09（選股逐月一致的一段）"),
                          ("2016-01-01", "2026-09-15", "2016-01 → 2026-09")]:
        out = {}
        for nm, s in (("pandas", v), ("LEAN", le)):
            x = s.loc[lo:hi]
            yrs = (x.index[-1] - x.index[0]).days / 365.25
            out[nm] = ((x.iloc[-1] / x.iloc[0]) ** (1 / yrs) - 1, (x / x.cummax() - 1).min())
        rows.append((label, out))
    stat = d["statistics"]
    return rows, stat["Compounding Annual Return"], stat["Drawdown"], stat["Total Fees"]


def main():
    w = bc.World(OFFSETS)
    spy = w.prices.last_close["SPY"]
    lean_rows, lean_cagr, lean_dd, lean_fees = lean_check(w)
    for label, o in lean_rows:
        print(label, {k: (pct(a), pct(b)) for k, (a, b) in o.items()})

    rows, ev_rows = [], []
    for base in COMBOS:
        for exit_rank in (15, 5):
            for off in OFFSETS:
                cfg = MomCfg(base.name, off, exit_rank, base.vol, base.sma200, base.switch, base.skip)
                ranks = w.skip_ranks(off) if cfg.skip else w.ranks[off]
                v, m, n_sw, n_c200 = simulate(cfg, ranks, w)
                for lo, hi, label in PERIODS:
                    p = bc.perf(v, spy, lo, hi)
                    mm = m.loc[lo:hi]
                    rows.append(dict(asdict(cfg), period=label, **p,
                                     trade_months=(mm.n_trades > 0).sum() / p["yrs"],
                                     sold=mm.sold.sum() / p["yrs"],
                                     sw_toggles=mm.sw.astype(int).diff().abs().sum(),
                                     c200_toggles=mm.c200.astype(int).diff().abs().sum(),
                                     sw_on_frac=mm.sw.mean(), avg_eff=mm.eff.mean()))
                ev_rows.append(dict(asdict(cfg), **bc.event_rel(v.loc["1998-02":], spy)))
            print(base.name, exit_rank, flush=True)
    res, evs = pd.DataFrame(rows), pd.DataFrame(ev_rows)
    res.to_csv(bc.OUT / "B10_results.csv", index=False)
    evs.to_csv(bc.OUT / "B10_events.csv", index=False)
    # 開關打開的月份（24 月版），供紀錄引用
    reg = w.reg[["bear24", "bear24hv", "bear36", "bear36hv", "below200"]].astype(bool).shift(1, fill_value=False)
    rd = sorted(w.ranks[0])
    sw_months = pd.DataFrame({k: reg[k].reindex(rd) for k in ("bear24", "bear24hv", "bear36", "bear36hv", "below200")})
    sw_months.to_csv(bc.OUT / "B10_switch_months.csv")
    write_summary(res, evs, lean_rows, lean_cagr, lean_dd, lean_fees, sw_months, w)
    print("完成，見 backtest/results/B10_summary.md")


def spans(flag: pd.Series):
    """連續為 True 的區段（換股日）。"""
    out, start, prev = [], None, None
    for d, x in flag.items():
        if x and start is None:
            start = d
        if not x and start is not None:
            out.append((start, prev))
            start = None
        prev = d
    if start is not None:
        out.append((start, prev))
    return out


def write_summary(res, evs, lean_rows, lean_cagr, lean_dd, lean_fees, sw_months, w):
    L = ["# B-10 原始表格", "", "由 `backtest/b10_momentum.py` 產生。解讀見 `docs/test-records/backtest_B10_2026-11-22.md`。", "",
         "## LEAN 比對（前 5 名、無緩衝、無風險層、每月拉回等權）", "",
         f"LEAN 摘要：年化 {lean_cagr}、最大回撤 {lean_dd}、手續費 {lean_fees}（IB 預設）。pandas：5 bp。", ""]
    L += bc.md_table(["期間", "pandas 年化", "LEAN 年化", "pandas 最大回撤", "LEAN 最大回撤"],
                     [(lab, pct(o["pandas"][0], 2), pct(o["LEAN"][0], 2), pct(o["pandas"][1]), pct(o["LEAN"][1])) for lab, o in lean_rows])
    names = [c.name for c in COMBOS]
    for label in [p[2] for p in PERIODS]:
        L += ["", f"## {label}（偏移 0）", ""]
        rows = []
        for nm in names:
            for ex in (15, 5):
                r = res[(res.name == nm) & (res.exit_rank == ex) & (res.offset == 0) & (res.period == label)].iloc[0]
                rows.append((nm, ex, pct(r.cagr), f"{r.sharpe:.2f}", pct(r.maxdd, 0), pct(r.rel_maxdd, 0),
                             int(r.sw_toggles), int(r.c200_toggles), pct(r.sw_on_frac, 0), f"{r.avg_eff:.2f}",
                             f"{r.trade_months:.1f}", f"{r.sold:.1f}"))
        L += bc.md_table(["組合", "出場名次", "年化", "Sharpe", "最大回撤", "相對 SPY 最大回撤", "開關切換次數", "200 日線切換次數",
                          "開關打開比例", "平均名單比重", "有交易月數/年", "賣出檔數/年"], rows)
        L += ["", f"### {label}：三種偏移（第 1、6、11 個交易日）的最低～最高", ""]
        rows = []
        for nm in names:
            for ex in (15, 5):
                s = res[(res.name == nm) & (res.exit_rank == ex) & (res.period == label)]
                rows.append((nm, ex, f"{pct(s.cagr.min())}～{pct(s.cagr.max())}", f"{s.sharpe.min():.2f}～{s.sharpe.max():.2f}",
                             f"{pct(s.maxdd.min(), 0)}～{pct(s.maxdd.max(), 0)}", f"{pct(s.rel_maxdd.min(), 0)}～{pct(s.rel_maxdd.max(), 0)}"))
        L += bc.md_table(["組合", "出場名次", "年化", "Sharpe", "最大回撤", "相對 SPY 最大回撤"], rows)
    L += ["", "## 事件中相對 SPY 的報酬（偏移 0；括號內為三種偏移的最低～最高）", ""]
    rows = []
    for nm in names:
        for ex in (15, 5):
            s = evs[(evs.name == nm) & (evs.exit_rank == ex)]
            r0 = s[s.offset == 0].iloc[0]
            rows.append([nm, ex] + [f"{pct(r0[e], 0)}（{pct(s[e].min(), 0)}～{pct(s[e].max(), 0)}）" for e in bc.EVENTS])
    L += bc.md_table(["組合", "出場名次"] + list(bc.EVENTS), rows)
    L += ["", "## 開關打開的期間（換股日，偏移 0）", ""]
    for k in ("bear24", "bear24hv", "bear36", "bear36hv"):
        sp = spans(sw_months[k].loc["1998-02":])
        L.append(f"- {k}：" + "、".join(f"{a:%Y-%m}～{b:%Y-%m}" for a, b in sp))
    (bc.OUT / "B10_summary.md").write_text("\n".join(L), encoding="utf-8")


if __name__ == "__main__":
    main()
