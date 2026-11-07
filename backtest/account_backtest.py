"""
B-5：整個帳戶的模擬 —— 分桶 + 核心當清算中心（design_v2_momentum_2026-11-07.md §2.1、§4.4、§6A）。

兩部分：
  B-5a  自選股慢規則（B-1 的 SLOW）：減下來的錢放現金 vs 放 SPY，單股比較
  B-5b  整個帳戶：自選桶 + 動能桶 + 核心桶，每天模擬，同一天的指令按股票代號合併後才下單

規則：
  自選桶   ：每檔標準比重 = own_total / 檔數。
             減持：收盤距 252 日高點 ≤ -20% → 隔天開盤賣掉目前持有的一半
             加回：收盤 > 200 日均線連續 10 天、距上次切換 ≥ 15 個交易日、且不在暴跌狀態 → 隔天開盤買回到標準比重
             上限：每月檢查，單檔超過 own_cap_hi（15%）→ 減到 own_cap（10%）
             桶上限（選用）：每月檢查，自選桶合計超過 own_bucket_hi（例如 25%）→ 按比例減回 own_total（20%）
  動能桶   ：系統部位（總值 − 自選桶）的 mom_frac（40%）；排名前 5 進場、掉出前 15 名出場、lazy；
             依波動度減碼（以 1/3 為單位）；崩盤規則啟動時再 × 0.5
  跨桶上限 （選用）：同一檔股票自選＋動能合計。動能買進或調整時最多買到 cross_cap（10%）；
             每月檢查，合計超過 cross_cap_hi（15%）→ 減回 cross_cap，先減動能那部分，不夠再減自選。
             被上限擋下的動能金額留在核心，不分給其他動能股
  核心桶   ：系統部位扣掉動能後的全部。崩盤規則啟動時一半放現金；
             其他桶減下來的錢進核心（崩盤時進現金、平時進 SPY），加回的錢從核心出
  崩盤規則 ：每月換股日，SPY 前一日收盤 < 200 日均線 → 啟動
  現金報酬 ：0（保守；實際放短期美債 ETF 有利息）
  成本     ：每單位成交金額 5 bp（按股票代號合併後的淨額）
  「下單日」：當天合併後有任一檔淨交易超過總值 0.25%

執行：uv run python backtest/account_backtest.py
輸出：backtest/results/B5_summary.md、B5a_parking.csv、B5b_account.csv、B5b_orders_<情境>.csv
"""
from __future__ import annotations

import sys
from dataclasses import dataclass, replace
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
import momentum_backtest as mb  # noqa: E402

OUT = mb.OUT_DIR
FEE = mb.FEE
ORDER_MIN = 0.0025


# ---------------------------------------------------------------- 自選股慢規則（與 l0_backtest.py 的 SLOW 相同）

def slow_signals(close: pd.Series, start) -> pd.DataFrame:
    """每天收盤後的訊號：'REDUCE' / 'READD' / None，以及狀態。從 start 起以 STD 狀態開始。"""
    sma = close.rolling(200).mean()
    dd = close / close.rolling(252).max() - 1
    severe = (dd <= -0.20).to_numpy()
    above = (close > sma).to_numpy()
    idx = close.index
    i0 = idx.searchsorted(pd.Timestamp(start))
    state, last, run = "STD", -10**9, 0
    sig = [None] * len(idx)
    for i in range(len(idx)):
        run = run + 1 if above[i] else 0
        if i < i0:
            continue
        if state == "STD" and severe[i]:
            state, last, sig[i] = "RED", i, "REDUCE"
        elif state == "RED" and run >= 10 and i - last >= 15 and not severe[i]:
            state, last, sig[i] = "STD", i, "READD"
    return pd.Series(sig, index=idx)


# ---------------------------------------------------------------- B-5a

def parking_test(prices: mb.Prices, tickers, periods):
    rows = []
    for tk in tickers:
        close, opn = prices.close[tk].dropna(), prices.open[tk]
        for lo, hi in periods:
            c = close.loc[:hi]
            if c.index[0] > pd.Timestamp(lo) - pd.Timedelta(days=370):
                continue
            sig = slow_signals(c, lo)
            days = c.loc[lo:].index
            spy_c, spy_o = prices.last_close["SPY"], prices.open["SPY"]
            for park in ("現金", "SPY", "買進持有"):
                sh, other, pending = 1.0 / opn[days[0]], 0.0, None  # other = 現金金額或 SPY 股數
                eq, n_sw = [], 0
                for d in days:
                    if pending and park != "買進持有":
                        po = opn[d]
                        so = spy_o[d]
                        oth_val = other * so if park == "SPY" else other
                        val = sh * po + oth_val
                        tgt = sh * po * 0.5 if pending == "REDUCE" else val  # 加回：全部回到股票
                        sh = tgt / po
                        rest = val - tgt
                        other = rest / so if park == "SPY" else rest
                        n_sw += 1
                    pending = sig[d] if isinstance(sig[d], str) else None
                    oth_val = other * spy_c[d] if park == "SPY" else other
                    eq.append(sh * c[d] + oth_val)
                e = pd.Series(eq, index=days)
                yrs = (days[-1] - days[0]).days / 365.25
                rows.append(dict(股票=tk, 期間=f"{lo[:4]}–{hi[:4]}", 減下來放=park,
                                 年化=(e.iloc[-1] / e.iloc[0]) ** (1 / yrs) - 1,
                                 最大回撤=(e / e.cummax() - 1).min(), 切換次數每年=n_sw / yrs))
    return pd.DataFrame(rows)


# ---------------------------------------------------------------- B-5b

@dataclass(frozen=True)
class Scenario:
    name: str
    own_rule: bool = True
    vol_scale: bool = True
    crash_rule: bool = True
    crash_cut: float = 0.5
    own_total: float = 0.20
    own_cap: float = 0.10
    own_cap_hi: float = 0.15
    mom_frac: float = 0.40
    exit_rank: int = 15
    spy_only: bool = False
    own_monthly: bool = False  # True：自選訊號累積到每月換股日才執行（併入月報）
    own_bucket_hi: float | None = None  # 自選桶合計超過這個比例 → 按比例減回 own_total
    cross_cap: float | None = None      # 同一檔跨桶合計的目標上限
    cross_cap_hi: float = 0.15          # 跨桶合計超過這個比例才減回 cross_cap
    mom_lazy_band: float | None = 0.5   # 動能留任股偏離目標超過這個比例才拉回；None = 永不拉回（只在換股、比例改變時交易）


# 每張單的原因。RATIO_REASONS 是「只因為比例漂移」的原因，其餘是訊號
RATIO_REASONS = {"動能比例回調", "單檔上限", "自選桶上限", "跨桶上限"}


def simulate_account(sc: Scenario, own: list[str], start: str, end: str,
                     ranks: dict, prices: mb.Prices):
    days = prices.close.loc[start:end].index
    rdays = [d for d in sorted(ranks) if days[0] <= d <= days[-1]]
    days = days[days.searchsorted(rdays[0]):]
    rset = set(rdays)
    O, C, L = prices.open, prices.last_close, prices.close
    spy_sma200 = L["SPY"].rolling(200).mean()
    sigs = {tk: slow_signals(L[tk].dropna(), days[0]) for tk in own} if sc.own_rule else {}

    lots: dict[tuple[str, str], float] = {}  # (桶, 代號) -> 股數；現金代號 "CASH"，價格 1
    held_mom: list[str] = []
    w_prev, crash, vol_hist = None, False, []
    pending: dict[str, str] = {}
    applied = {tk: "STD" for tk in own}  # 已執行到帳上的自選狀態
    std_w = sc.own_total / len(own) if own else 0
    values, orders, events = [], [], []
    own_w, max_w = [], []  # 每天收盤：自選桶占比、單一代號（跨桶合計，不含 SPY）最大占比

    def px_open(tk, d):
        return 1.0 if tk == "CASH" else float(O.at[d, tk])

    for i, d in enumerate(days):
        is_r = d in rset
        first = i == 0
        act_own = bool(pending) and (is_r or not sc.own_monthly)
        if first or is_r or act_own:
            val = {k: u * px_open(k[1], d) for k, u in lots.items()}
            total = sum(val.values()) if val else 1.0
            tgt = dict(val)  # 目標金額；先等於現值
            why: dict[tuple[str, str], str] = {}  # 這一格為什麼被改

            # 自選桶
            if first:
                for tk in (own if not sc.spy_only else []):
                    tgt[("own", tk)] = std_w * total
            for tk, act in (pending.items() if act_own else []):
                cur = tgt.get(("own", tk), 0.0)
                if act == "REDUCE" and applied[tk] == "STD":
                    tgt[("own", tk)] = cur * 0.5
                    why[("own", tk)] = "自選訊號"
                    applied[tk] = "RED"
                    events.append(dict(date=d, ticker=tk, action=act))
                elif act == "READD" and applied[tk] == "RED":
                    tgt[("own", tk)] = max(cur, std_w * total)
                    why[("own", tk)] = "自選訊號"
                    applied[tk] = "STD"
                    events.append(dict(date=d, ticker=tk, action=act))
            if is_r:
                for tk in own:
                    cur = tgt.get(("own", tk), 0.0)
                    if cur > sc.own_cap_hi * total:
                        tgt[("own", tk)] = sc.own_cap * total
                        why[("own", tk)] = "單檔上限"
                        events.append(dict(date=d, ticker=tk, action="TRIM"))
            own_val = sum(v for k, v in tgt.items() if k[0] == "own")
            if is_r and sc.own_bucket_hi is not None and own_val > sc.own_bucket_hi * total:
                f = sc.own_total * total / own_val
                before = {k[1]: v / total for k, v in tgt.items() if k[0] == "own"}
                for k in [k for k in tgt if k[0] == "own"]:
                    tgt[k] *= f
                    why.setdefault(k, "自選桶上限")
                events.append(dict(date=d, ticker="*", action="TRIM_BUCKET",
                                   detail="；".join(f"{t} {w*100:.1f}%→{w*f*100:.1f}%" for t, w in before.items())))
                own_val = sc.own_total * total
            sys_val = total - own_val

            # 動能桶（只在換股日決定）
            if is_r and not sc.spy_only:
                order = list(ranks[d].index)
                pos = {t: k for k, t in enumerate(order)}
                keep = [t for t in held_mom if t in pos and pos[t] < sc.exit_rank]
                new = [t for t in order if t not in keep][: max(0, 5 - len(keep))]
                names = keep + new
                w = 1.0
                if sc.vol_scale:
                    sigma = mb.excess_vol(prices, names, d)
                    if len(vol_hist) >= mb.VOL_MIN_HISTORY:
                        w = np.floor(min(1.0, np.median(vol_hist) / sigma) * 3 + 1e-9) / 3
                    vol_hist.append(sigma)
                new_crash = bool(sc.crash_rule and C["SPY"].shift(1).at[d] < spy_sma200.shift(1).at[d])
                eff = w * (sc.crash_cut if new_crash else 1.0)
                name_t = sys_val * sc.mom_frac * eff / 5
                for k in [k for k in tgt if k[0] == "mom" and k[1] not in names]:
                    tgt[k] = 0.0
                    why[k] = "動能換股"
                changed = (w_prev is None) or eff != w_prev
                crash_flip = new_crash != crash
                w_reason = "崩盤規則" if crash_flip else "波動度減碼"
                for t in names:
                    cur = tgt.get(("mom", t), 0.0)
                    own_t = tgt.get(("own", t), 0.0)
                    t_t = name_t
                    if sc.cross_cap is not None:
                        t_t = min(name_t, max(0.0, sc.cross_cap * total - own_t))
                        if t_t < name_t and (t in new or changed):
                            events.append(dict(date=d, ticker=t, action="CROSS_LIMIT_BUY"))
                    if t in new:
                        tgt[("mom", t)], why[("mom", t)] = t_t, "動能換股"
                    elif changed:
                        tgt[("mom", t)], why[("mom", t)] = t_t, w_reason
                    elif sc.mom_lazy_band is not None and abs(cur - t_t) > sc.mom_lazy_band * t_t:
                        tgt[("mom", t)], why[("mom", t)] = t_t, "動能比例回調"
                    if sc.cross_cap is not None:
                        m = tgt.get(("mom", t), 0.0)
                        if own_t + m > sc.cross_cap_hi * total:
                            excess = own_t + m - sc.cross_cap * total
                            cut = min(m, excess)
                            tgt[("mom", t)] = m - cut
                            why[("mom", t)] = "跨桶上限"
                            if excess - cut > 0:
                                tgt[("own", t)] = own_t - (excess - cut)
                                why[("own", t)] = "跨桶上限"
                            events.append(dict(date=d, ticker=t, action="CROSS_TRIM"))
                held_mom, w_prev = names, eff
                crash_changed = new_crash != crash
                crash = new_crash
            else:
                crash_changed = False
            if sc.spy_only and is_r:
                new_crash = bool(sc.crash_rule and C["SPY"].shift(1).at[d] < spy_sma200.shift(1).at[d])
                crash_changed, crash = new_crash != crash, new_crash

            # 核心桶 = 系統部位 − 動能
            mom_val = sum(v for k, v in tgt.items() if k[0] == "mom")
            core = total - own_val - mom_val
            cur_spy, cur_cash = tgt.get(("core", "SPY"), 0.0), tgt.get(("core", "CASH"), 0.0)
            if first or crash_changed:
                cash_t = core * (1 - sc.crash_cut) if crash else 0.0
                tgt[("core", "CASH")], tgt[("core", "SPY")] = cash_t, core - cash_t
            else:  # 差額由清算中心吸收：崩盤時進出現金，平時進出 SPY
                delta = core - cur_spy - cur_cash
                a, b = (("core", "CASH"), ("core", "SPY")) if crash else (("core", "SPY"), ("core", "CASH"))
                tgt[a] = tgt.get(a, 0.0) + delta
                if tgt[a] < 0:
                    tgt[b] = tgt.get(b, 0.0) + tgt[a]
                    tgt[a] = 0.0

            # 按代號合併後的淨交易
            net: dict[str, float] = {}
            for k in set(tgt) | set(val):
                dv = tgt.get(k, 0.0) - val.get(k, 0.0)
                if k[1] != "CASH":
                    net[k[1]] = net.get(k[1], 0.0) + dv
            traded = sum(abs(x) for x in net.values())
            fee = traded * FEE
            big = {t: x for t, x in net.items() if abs(x) > ORDER_MIN * total}
            # 原因：改到的非核心格子；核心只在崩盤規則切換時算原因（其餘是被動吸收）
            reasons = {why.get(k, "其他") for k in set(tgt) | set(val)
                       if k[0] != "core" and k[1] in big and abs(tgt.get(k, 0.0) - val.get(k, 0.0)) > ORDER_MIN * total}
            if crash_changed:
                reasons.add("崩盤規則")
            reasons.discard("其他")
            if big and not first:
                orders.append(dict(date=d, n_orders=len(big), reasons="、".join(sorted(reasons)),
                                   ratio_only=bool(reasons) and reasons <= RATIO_REASONS,
                                   orders="；".join(f"{'買' if x > 0 else '賣'} {t} {abs(x)/total*100:.1f}%"
                                                   for t, x in sorted(big.items(), key=lambda z: -abs(z[1])))))
            # 手續費從核心扣
            ck = ("core", "CASH") if tgt.get(("core", "CASH"), 0) >= fee else ("core", "SPY")
            tgt[ck] = tgt.get(ck, 0.0) - fee
            lots = {k: v / px_open(k[1], d) for k, v in tgt.items() if v > 1e-12}
            if act_own:
                pending = {}

        cv = {k: u * (1.0 if k[1] == "CASH" else float(C.at[d, k[1]])) for k, u in lots.items()}
        tv = sum(cv.values())
        values.append(tv)
        by_tk: dict[str, float] = {}
        for k, x in cv.items():
            if k[0] != "core":
                by_tk[k[1]] = by_tk.get(k[1], 0.0) + x
        own_w.append(sum(x for k, x in cv.items() if k[0] == "own") / tv)
        max_w.append(max(by_tk.values(), default=0.0) / tv)
        for tk, s in sigs.items():
            a = s.get(d); a = a if isinstance(a, str) else None
            if a:
                pending[tk] = a
    v = pd.Series(values, index=days)
    ev = pd.DataFrame(events, columns=["date", "ticker", "action", "detail"])
    yrs = (days[-1] - days[0]).days / 365.25
    cnt = ev.action.value_counts()
    ow, mw = pd.Series(own_w, index=days), pd.Series(max_w, index=days)
    od = pd.DataFrame(orders)
    n_ratio = int(od.ratio_only.sum()) if len(od) else 0
    extra = dict(純比例下單日每年=n_ratio / yrs,
                 含比例原因下單日每年=(od.reasons.str.contains("|".join(RATIO_REASONS)).sum() / yrs if len(od) else 0),
                 自選桶平均占比=ow.mean(), 自選桶最高占比=ow.max(), 單一代號最高占比=mw.max(),
                 單一代號超過15天數比例=(mw > 0.15).mean(),
                 桶上限次數每年=cnt.get("TRIM_BUCKET", 0) / yrs, 跨桶減碼次數每年=cnt.get("CROSS_TRIM", 0) / yrs,
                 跨桶限買次數每年=cnt.get("CROSS_LIMIT_BUY", 0) / yrs)
    return v, pd.DataFrame(orders), ev, extra


def account_stats(v: pd.Series, spy: pd.Series, orders: pd.DataFrame):
    yrs = (v.index[-1] - v.index[0]).days / 365.25
    mr = v.resample("ME").last().pct_change().dropna()
    s = spy.reindex(v.index)
    rel = v / s
    n_days = len(orders)
    return dict(年化=(v.iloc[-1] / v.iloc[0]) ** (1 / yrs) - 1,
                SPY年化=(s.iloc[-1] / s.iloc[0]) ** (1 / yrs) - 1,
                Sharpe=mr.mean() / mr.std() * np.sqrt(12),
                最大回撤=(v / v.cummax() - 1).min(),
                SPY最大回撤=(s / s.cummax() - 1).min(),
                相對SPY最大回撤=(rel / rel.cummax() - 1).min(),
                下單日每年=n_days / yrs,
                每次平均單數=(orders["n_orders"].mean() if n_days else 0))


EVENTS = {"2000–02": ("2000-03-01", "2002-10-31"), "2008": ("2007-10-01", "2009-03-31"),
          "2020": ("2020-02-19", "2020-04-30"), "2022": ("2022-01-01", "2022-10-31"),
          "2026-07": ("2026-06-30", "2026-09-15")}


def main():
    data = mb.LeanData(mb.DEFAULT_LEAN)
    spy = data.bars("SPY").loc[:mb.END]
    days = spy.index
    ranks = mb.load_ranks(data, mb.DEFAULT_LEAN, days, 0)
    own_all = ["MU", "NVDA", "MSFT", "META"]
    tickers = sorted({t for s in ranks.values() for t in s.index} | {"SPY"} | set(own_all))
    prices = mb.Prices(data, tickers, days)

    # B-5a
    pk = parking_test(prices, own_all, [("2000-02-01", "2012-12-31"), ("2013-06-03", "2026-09-15")])
    pk.to_csv(OUT / "B5a_parking.csv", index=False)

    # B-5b
    base = Scenario("完整設計")
    scenarios = [
        Scenario("SPY 買進持有", own_rule=False, vol_scale=False, crash_rule=False, spy_only=True),
        Scenario("SPY + 崩盤規則", own_rule=False, vol_scale=False, spy_only=True),
        Scenario("分桶但全不管", own_rule=False, vol_scale=False, crash_rule=False),
        replace(base, name="完整設計（無崩盤規則）", crash_rule=False),
        replace(base, name="完整設計（自選不用規則）", own_rule=False),
        base,
        replace(base, name="完整設計（崩盤時全換現金）", crash_cut=0.0),
        replace(base, name="完整設計（自選訊號併入月報）", own_monthly=True),
    ]
    main_sc = replace(base, name="完整設計＋桶上限＋跨桶上限（主要方案）", own_monthly=True,
                      own_bucket_hi=0.25, cross_cap=0.10)
    scenarios += [
        replace(base, name="月報版＋自選桶上限 25%→20%", own_monthly=True, own_bucket_hi=0.25),
        replace(base, name="月報版＋跨桶上限 15%→10%", own_monthly=True, cross_cap=0.10),
        main_sc,
        replace(main_sc, name="主要方案，自選桶上限改 22%→20%", own_bucket_hi=0.22),
        replace(main_sc, name="主要方案，跨桶上限改 12%→8%", cross_cap=0.08, cross_cap_hi=0.12),
    ]
    runs = [("2000–2026（自選 MU/NVDA/MSFT）", ["MU", "NVDA", "MSFT"], "2000-02-01"),
            ("2013–2026（自選 MU/NVDA/MSFT/META）", own_all, "2013-06-03")]
    rows = []
    spy_c = prices.last_close["SPY"]
    for label, own, start in runs:
        for sc in scenarios:
            v, orders, events, extra = simulate_account(sc, own, start, mb.END, ranks, prices)
            st = account_stats(v, spy_c, orders)
            st.update(extra)
            for ev, (a, b) in EVENTS.items():
                x = v.loc[a:b]
                st[ev] = x.iloc[-1] / x.iloc[0] - 1 if len(x) > 1 and x.index[0] <= pd.Timestamp(a) + pd.Timedelta(days=7) else np.nan
            rows.append(dict(期間=label, 情境=sc.name, **st))
            if sc == main_sc:
                tag = start[:4]
                orders.to_csv(OUT / f"B5b_orders_{tag}.csv", index=False)
                events.to_csv(OUT / f"B5b_own_events_{tag}.csv", index=False)
            print(label, sc.name, f"{st['年化']*100:.1f}%", flush=True)
    res = pd.DataFrame(rows)
    res.to_csv(OUT / "B5b_account.csv", index=False)
    write_summary(pk, res)
    print("完成，見 backtest/results/B5_summary.md")


def write_summary(pk: pd.DataFrame, res: pd.DataFrame):
    L = ["# B-5 原始表格", "", "由 `backtest/account_backtest.py` 產生。解讀見 `backtest_B5_2026-11-07.md`。", "",
         "## B-5a 自選股慢規則：減下來的錢放哪裡", "",
         "| 股票 | 期間 | 減下來放 | 年化 | 最大回撤 | 切換次數/年 |", "|---|---|---|---|---|---|"]
    for _, r in pk.iterrows():
        L.append(f"| {r.股票} | {r.期間} | {r.減下來放} | {r.年化*100:.1f}% | {r.最大回撤*100:.0f}% | {r.切換次數每年:.1f} |")
    for label in res.期間.unique():
        sub = res[res.期間 == label]
        L += ["", f"## B-5b 整個帳戶：{label}", "",
              "| 情境 | 年化 | Sharpe | 最大回撤 | 相對 SPY 最大回撤 | 下單日/年 | 每次平均單數 | " + " | ".join(EVENTS) + " |",
              "|" + "---|" * (7 + len(EVENTS))]
        for _, r in sub.iterrows():
            evs = " | ".join("—" if pd.isna(r[e]) else f"{r[e]*100:.0f}%" for e in EVENTS)
            L.append(f"| {r.情境} | {r.年化*100:.1f}% | {r.Sharpe:.2f} | {r.最大回撤*100:.0f}% | "
                     f"{r.相對SPY最大回撤*100:.0f}% | {r.下單日每年:.1f} | {r.每次平均單數:.1f} | {evs} |")
        L += ["", f"### 上限相關：{label}", "",
              "| 情境 | 自選桶平均 | 自選桶最高 | 單一代號最高 | 單一代號 >15% 的天數 | 桶上限次數/年 | 跨桶減碼/年 | 跨桶限買/年 |",
              "|---|---|---|---|---|---|---|---|"]
        for _, r in sub.iterrows():
            L.append(f"| {r.情境} | {r.自選桶平均占比*100:.0f}% | {r.自選桶最高占比*100:.0f}% | {r.單一代號最高占比*100:.0f}% | "
                     f"{r.單一代號超過15天數比例*100:.0f}% | {r.桶上限次數每年:.2f} | {r.跨桶減碼次數每年:.2f} | {r.跨桶限買次數每年:.2f} |")
    (OUT / "B5_summary.md").write_text("\n".join(L), encoding="utf-8")


if __name__ == "__main__":
    main()
