"""B-9 B：把規則偵測段放進動能策略（不用 LLM）。

沿用 momentum_backtest.py 的股票池、排名（b2_ranks 快取）、交易假設（前一交易日收盤算訊號、
當月第一個交易日開盤成交、每單位成交金額 5 bp）、lazy 交易方式、出場名次 15。規則只在 2009-01 以後啟用，
之前與 B-2 完全相同。

規則：
  進場否決（F1）：本月要進場的股票（排名前 5、未持有）若命中規則 → 不進場，由下一名遞補；
    每格最多審 2 檔（原本＋1 檔遞補），遞補者再被否決 → 那一格留在核心（SPY）到下個月；每月最多審 3 檔。
  持股提早出場（F19，只限 PENDING_MA、ACCOUNTING）：
    next_open  事件可得後的第一個開盤賣出，錢放 SPY 到下個換股日
    next_month 下一個換股日賣出（即使排名仍在前 15）
  事件有效期間：PENDING_MA 365 天（或到下市）；ACCOUNTING 180 天；DILUTION 180 天（F1 卡「過去 6 個月」）；
    ONE_OFF_JUMP 每月重算。

執行：uv run python backtest/b9_strategy.py
輸出：backtest/results/B9_strategy.csv、B9_strategy_hits.csv、B9_strategy_summary.md
"""
from __future__ import annotations

import pickle
import sys
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import b9_common as C  # noqa: E402
from momentum_backtest import (DEFAULT_LEAN, FEE, LAZY_BAND, PORTFOLIO, VOL_MIN_HISTORY, LeanData, Prices,  # noqa: E402
                               excess_vol, stats)

RULE_START = pd.Timestamp("2009-01-01")
PERIODS = [("2009-01", "2026-09", "2009–2026"), ("2016-01", "2026-09", "2016–2026")]
WINDOW = {"PENDING_MA": 365, "PENDING_MA_ANY": 365, "ACCOUNTING": 180, "ACCOUNTING_BROAD": 180, "DILUTION": 180, "DILUTION_ANY": 180}


@dataclass(frozen=True)
class Rule:
    name: str
    veto: tuple = ()          # 進場否決的代碼
    exit: tuple = ()          # 持股提早出場的代碼
    exit_timing: str = "next_open"
    jump: str | None = None   # 例如 "j1:0.5" 或 "j3:0.5"；"id" = 資訊離散度最高五分之一
    exit_rank: int = 15
    overlay: str = "none"
    core: float = 0.0


def load_hits():
    """事件表 → {代碼: {代號: [(可得日, 失效日, 說明)]}}。"""
    ev = pd.read_csv(C.OUT / "B9_events.csv", dtype={"cik": str})
    ev["avail"] = pd.to_datetime(ev["avail"])
    ev = ev[ev.avail.notna()]
    codes = {
        "PENDING_MA": ev.cls == "PENDING_MA",
        "PENDING_MA_ANY": ev.cls.isin(["PENDING_MA", "MA_OTHER"]),
        "ACCOUNTING": ev.cls.isin(["ACC_402", "ACC_NT"]) | ((ev.cls == "ACC_401") & (ev["sub"] == "RESIGN")),
        "ACCOUNTING_BROAD": ev.cls.isin(["ACC_402", "ACC_NT"]) | ((ev.cls == "ACC_401") & ~ev["sub"].isin(["PLAN", "MERGER", "NETWORK", "NEW_ONLY"])),
        "DILUTION": ((ev.cls == "DILUTION") & (ev["sub"] == "EQUITY") & (ev["size"] >= 0.05)) | ((ev.cls == "DILUTION") & (ev["sub"] == "CONVERTIBLE")),
        "DILUTION_ANY": ev.cls.isin(["DILUTION", "DILUTION_302"]),
    }
    out = {}
    for code, mask in codes.items():
        d = {}
        for r in ev[mask].itertuples():
            d.setdefault(r.ticker, []).append((r.avail, r.avail + pd.Timedelta(days=WINDOW[code]), f"{r.cls}:{r.sub}:{r.filingDate}"))
        out[code] = d
    return out


def active(hits, code, ticker, day):
    for a, b, desc in hits.get(code, {}).get(ticker, []):
        if a <= day <= b:
            return desc
    return None


class JumpCalc:
    def __init__(self, prices: Prices):
        self.adj = prices.close
        self.spy = prices.close["SPY"]
        self.cache = {}

    def get(self, t, day):
        key = (t, day)
        if key not in self.cache:
            i = self.adj.index.searchsorted(day) - 1
            self.cache[key] = C.jump_metrics(self.adj[t], self.spy, i) if t in self.adj else None
        return self.cache[key]


def check(rule: Rule, codes, hits, jc: JumpCalc, ticker, day, universe):
    """回傳命中的 (代碼, 說明) 或 None。"""
    if day < RULE_START:
        return None
    for code in codes:
        desc = active(hits, code, ticker, day)
        if desc:
            return code, desc
    if rule.jump:
        jm = jc.get(ticker, day)
        if jm:
            if rule.jump == "id":
                ids = [jc.get(t, day) for t in universe]
                ids = [x["id"] for x in ids if x]
                if ids and jm["id"] >= np.quantile(ids, 0.8):
                    return "ONE_OFF_JUMP", f"ID={jm['id']:.3f}"
            else:
                k, th = rule.jump.split(":")
                th = float(th)
                share, post = jm[f"{k}_share"], jm[f"{k}_post"]
                if jm["r12"] > 0 and share > th and np.isfinite(post) and post <= 0:
                    return "ONE_OFF_JUMP", f"{k}_share={share:.2f} post={post:+.1%} ago={jm[f'{k}_ago']}d"
    return None


def simulate(rule: Rule, ranks: dict, prices: Prices, hits, jc: JumpCalc):
    days = prices.close.index
    rdays = sorted(ranks)
    units = {"SPY": 1.0 / prices.open["SPY"].loc[rdays[0]]}
    held: list[str] = []
    w_prev, vol_hist = None, []
    monthly, cases, exits_sched = [], [], {}
    values = pd.Series(index=days, dtype=float)
    traded_total = []
    r_iter = iter(rdays + [None])
    next_r = next(r_iter)
    first = True
    for day in days[days.searchsorted(rdays[0]):]:
        # 月中提早出場（next_open）
        if day in exits_sched and day != next_r:
            open_px = prices.open.loc[day]
            for t, desc in exits_sched.pop(day):
                if t in units and t in held:
                    v = units.pop(t) * open_px[t]
                    units["SPY"] = units.get("SPY", 0) + v * (1 - FEE) / open_px["SPY"]
                    traded_total.append((day, 2 * v))
                    held = [x for x in held if x != t]
                    cases.append(dict(kind="提早出場", date=day, ticker=t, code=desc[0], detail=desc[1]))
        if day == next_r:
            ranked = ranks[day]
            order = list(ranked.index)
            pos = {t: k for k, t in enumerate(order)}
            keep = [t for t in held if t in pos and pos[t] < rule.exit_rank]
            if rule.exit and day >= RULE_START:
                prev = monthly[-1]["date"] if monthly else day
                for t in list(keep):
                    for code in rule.exit:
                        hit = [(a, desc) for a, b, desc in hits.get(code, {}).get(t, []) if a <= day <= b and
                               (rule.exit_timing == "next_month" and a > prev or a == day)]
                        if hit:
                            keep.remove(t)
                            cases.append(dict(kind="換股日出場", date=day, ticker=t, code=code, detail=hit[0][1], rank=pos[t] + 1))
                            break
            slots = max(0, PORTFOLIO - len(keep))
            cand = [t for t in order if t not in keep]
            veto_codes = tuple(dict.fromkeys(rule.veto + rule.exit))
            if day < RULE_START or not (veto_codes or rule.jump):
                new = cand[:slots]
            else:
                new, reviews, ci = [], 0, 0
                for s_ in range(slots):
                    filled, tried = False, 0
                    while tried < 2 and ci < len(cand) and reviews < 3:
                        t = cand[ci]
                        ci += 1
                        reviews += 1
                        tried += 1
                        h = check(rule, veto_codes, hits, jc, t, day, order)
                        if h is None:
                            new.append(t)
                            filled = True
                            break
                        cases.append(dict(kind="否決", date=day, ticker=t, code=h[0], detail=h[1], rank=pos[t] + 1))
                    if not filled:
                        if tried == 0 and ci < len(cand):  # 審查上限用完、這一格沒審過：照 B-2 補上（只記次數）
                            new.append(cand[ci])
                            ci += 1
                            cases.append(dict(kind="審查上限", date=day, ticker=new[-1], code="", detail="未審查直接進場"))
                        else:
                            cases.append(dict(kind="留在核心", date=day, ticker="", code="", detail="遞補者也被否決或審查上限"))
                for c in cases:
                    if c["date"] == day and c["kind"] == "否決" and "replacement" not in c:
                        later = [t for t in new if pos[t] > c["rank"] - 1]
                        c["replacement"] = later[0] if later else "核心"
            target_names = keep + new

            if rule.overlay.startswith("vol"):
                sigma = excess_vol(prices, keep + cand[:slots], day)  # 波動度用 B-2 的名單算，避免否決改變風險層
                w = 1.0
                if len(vol_hist) >= VOL_MIN_HISTORY:
                    w = min(1.0, float(np.median(vol_hist)) / sigma)
                    w = np.floor(w * 3 + 1e-9) / 3
                vol_hist.append(sigma)
            else:
                w = 1.0
            open_px = prices.open.loc[day]
            val = {t: u * open_px[t] for t, u in units.items()}
            total = sum(val.values())
            cur_w = {t: v / total for t, v in val.items()}
            name_w = (1 - rule.core) * w / PORTFOLIO
            tgt = {t: 0.0 for t in cur_w if t != "SPY"}
            for t in target_names:
                tgt[t] = name_w
            if w_prev is not None and w == w_prev:
                for t in keep:
                    if abs(cur_w.get(t, 0) - name_w) <= LAZY_BAND * name_w:
                        tgt[t] = cur_w.get(t, 0)
            if sum(tgt.values()) > 1:
                for t in target_names:
                    tgt[t] = name_w
            tgt["SPY"] = 1 - sum(v for t, v in tgt.items() if t != "SPY")
            traded = sum(abs(tgt.get(t, 0) - cur_w.get(t, 0)) for t in set(tgt) | set(cur_w)) * total
            n_tr = sum(1 for t in set(tgt) | set(cur_w) if t != "SPY" and abs(tgt.get(t, 0) - cur_w.get(t, 0)) > 1e-9)
            traded_total.append((day, traded))
            total_after = total - traded * FEE
            units = {t: tgt[t] * total_after / open_px[t] for t in tgt if tgt[t] > 1e-12}
            monthly.append(dict(date=day, w=w, names=",".join(target_names), n_trades=n_tr,
                                sold=len(set(held) - set(target_names)), bought=len(set(target_names) - set(held)), total=total))
            held, w_prev = target_names, w
            # 這個月的持股若之後有事件 → 排程提早出場
            if rule.exit and rule.exit_timing == "next_open":
                nxt = next_r_peek(rdays, day)
                for t in held:
                    for code in rule.exit:
                        for a, b, desc in hits.get(code, {}).get(t, []):
                            if a >= RULE_START and day < a < nxt:
                                exits_sched.setdefault(a, []).append((t, (code, desc)))
            next_r = next(r_iter)
        values[day] = sum(u * prices.last_close.at[day, t] for t, u in units.items())
    values = values.dropna()
    m = pd.DataFrame(monthly).set_index("date")
    tv = pd.DataFrame(traded_total, columns=["date", "traded"]).set_index("date")["traded"]
    return values, m, pd.DataFrame(cases), tv


def next_r_peek(rdays, day):
    i = rdays.index(day)
    return rdays[i + 1] if i + 1 < len(rdays) else pd.Timestamp("2100-01-01")


def fwd(prices: Prices, t, day, h):
    """t 在 day 開盤買進持有 h 個交易日的報酬與相對 SPY（下市：算到最後價格）。"""
    if t in ("", "核心") or t not in prices.close:
        t = "SPY"
    i0 = prices.close.index.searchsorted(day)
    i1 = i0 + h - 1
    if i1 >= len(prices.close.index):
        return np.nan, np.nan
    o = prices.open[t].iloc[i0]
    c = prices.last_close[t].iloc[i1]
    s = prices.last_close["SPY"].iloc[i1] / prices.open["SPY"].iloc[i0]
    r = c / o - 1
    return r, (1 + r) / s - 1


def main():
    OUT = C.OUT
    data = LeanData(DEFAULT_LEAN)
    ranks = pickle.loads((C.DATA / "b2_ranks_data-sp500-long_off0.pkl").read_bytes())
    days = data.bars("SPY").loc[:"2026-09-15"].index
    tickers = sorted({t for s in ranks.values() for t in s.index} | {"SPY"})
    prices = Prices(data, tickers, days)
    hits = load_hits()
    jc = JumpCalc(prices)
    spy_close = prices.last_close["SPY"]
    rules = [Rule("基準（B-2，無規則）")]
    rules += [Rule("否決 PENDING_MA", veto=("PENDING_MA",)),
              Rule("否決 PENDING_MA（任何合併申報，不分角色）", veto=("PENDING_MA_ANY",)),
              Rule("否決 ACCOUNTING（4.02＋NT＋4.01 辭任）", veto=("ACCOUNTING",)),
              Rule("否決 ACCOUNTING 寬（含 4.01 解任）", veto=("ACCOUNTING_BROAD",)),
              Rule("否決 DILUTION（普通股 ≥ 5% 或可轉債）", veto=("DILUTION",)),
              Rule("否決 DILUTION 寬（任何股票 424B／8-K 3.02）", veto=("DILUTION_ANY",))]
    for k in ("j1", "j3"):
        for th in (0.3, 0.4, 0.5, 0.6, 0.7):
            rules.append(Rule(f"否決 ONE_OFF_JUMP {k} > {int(th*100)}%", jump=f"{k}:{th}"))
    rules.append(Rule("否決 ID 最高五分之一", jump="id"))
    for timing in ("next_open", "next_month"):
        rules.append(Rule(f"出場 PENDING_MA（{timing}）", exit=("PENDING_MA",), exit_timing=timing))
        rules.append(Rule(f"出場 ACCOUNTING（{timing}）", exit=("ACCOUNTING",), exit_timing=timing))
    full = ("PENDING_MA", "ACCOUNTING", "DILUTION")
    rules.append(Rule("全部規則（否決 PM＋ACC＋DIL＋j1>50%；出場 PM＋ACC next_open）", veto=full, jump="j1:0.5",
                      exit=("PENDING_MA", "ACCOUNTING"), exit_timing="next_open"))
    rules.append(Rule("全部規則，B-2 主方案（核心 60%、波動度 1/3）", veto=full, jump="j1:0.5",
                      exit=("PENDING_MA", "ACCOUNTING"), exit_timing="next_open", overlay="vol_thirds", core=0.6))
    rules.append(Rule("基準，B-2 主方案（核心 60%、波動度 1/3）", overlay="vol_thirds", core=0.6))
    res, allcases = [], []
    for rule in rules:
        values, m, cases, tv = simulate(rule, ranks, prices, hits, jc)
        for lo, hi, label in PERIODS:
            s = stats(values, m, spy_close, lo, hi)
            v = values.loc[lo:hi]
            yrs = (v.index[-1] - v.index[0]).days / 365.25
            lvl = values.reindex(tv.index).ffill()
            turn = (tv.loc[lo:hi] / lvl.loc[lo:hi]).sum() / 2 / yrs
            nc = cases[(cases.date >= lo) & (cases.date <= pd.Timestamp(hi) + pd.offsets.MonthEnd(0))] if len(cases) else cases
            res.append(dict(rule=rule.name, period=label, cagr=s["cagr"], sharpe=s["sharpe"], maxdd=s["maxdd"],
                            spy_cagr=s["spy_cagr"], turnover=turn, names_sold=s["names_sold"], trade_months=s["trade_months"],
                            n_veto=int((nc.kind == "否決").sum()) if len(nc) else 0,
                            n_exit=int(nc.kind.isin(["提早出場", "換股日出場"]).sum()) if len(nc) else 0,
                            n_core_slot=int((nc.kind == "留在核心").sum()) if len(nc) else 0))
        if len(cases):
            cases = cases.copy()
            cases["rule"] = rule.name
            allcases.append(cases)
        print(f"  {rule.name}: {res[-2]['cagr']:.2%} / {res[-1]['cagr']:.2%}", flush=True)
    res = pd.DataFrame(res)
    res.to_csv(OUT / "B9_strategy.csv", index=False)
    cases = pd.concat(allcases, ignore_index=True) if allcases else pd.DataFrame()
    # 命中案例的事後報酬
    for hname, h in C.HORIZONS.items():
        rr = [fwd(prices, r.ticker, r.date, h) if r.kind != "留在核心" else (np.nan, np.nan) for r in cases.itertuples()]
        cases[f"rel_{hname}"] = [x[1] for x in rr]
        cases[f"ret_{hname}"] = [x[0] for x in rr]
        rp = [fwd(prices, r.replacement, r.date, h) if r.kind == "否決" else (np.nan, np.nan) for r in cases.itertuples()]
        cases[f"repl_rel_{hname}"] = [x[1] for x in rp]
    cases.to_csv(OUT / "B9_strategy_hits.csv", index=False)
    print(res.to_string())


if __name__ == "__main__":
    main()
