"""
B-1：純規則（L0）長期回測。

規則（依 tradingagents_evaluation_2026-11-07.md §4、§9、§11）：
  R1       ：收盤 < MA(ma) 且 MACD(12,26,9) 柱狀圖 < 0           （use_r1=False 時關閉）
  嚴重暴跌 ：收盤距 sev_win 日高點跌幅 ≤ severe_dd → 不受冷卻期限制，一次就切換
  兩次確認 ：R1 連續 confirm_days 天成立才切換（confirm_days=1 即不確認）
  冷卻期   ：切換後 cooldown 個交易日內不再切換（嚴重暴跌除外）
  加回     ：收盤 > MA(ma) 連續 readd_days 天、冷卻期已過、且嚴重暴跌條件已解除
  部位     ：標準 = 1.0；減持 = mult（0.67 / 0.5 / 0.33），其餘現金（報酬 0）
  大盤疊加 ：QQQ 收盤 < QQQ MA(overlay_ma)（同樣確認天數＋冷卻）→ 部位再 × 0.75（40% → 30%）
  不交易區間：實際比重偏離目標超過 band（相對）才再平衡；band=inf 表示只在狀態改變時交易
  執行時點 ：訊號在 t 日收盤算出，t+1 日開盤執行（通知台灣清晨、當晚美股開盤操作）

基準：
  買進持有
  追蹤停損 -10%（收盤跌破進場後最高收盤的 90% 即全賣，再進場規則與加回相同）

輸出（results/）：
  B1_results.csv          每股 × 每組參數 × 期間
  B1_portfolio.csv        四股等權組合（MU/NVDA/MSFT/META）：通知日數/年、年化、最大回檔
  B1_regimes.csv          不同行情區段的報酬
  B1_trades_<tk>_<tag>.csv 交易明細
  B1_summary.md           表格
"""
from __future__ import annotations

import itertools
import math
import os
import sys
from dataclasses import dataclass, asdict, replace

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(HERE, "data")
OUT_DIR = os.path.join(HERE, "results")
os.makedirs(DATA_DIR, exist_ok=True)
os.makedirs(OUT_DIR, exist_ok=True)

TICKERS = ["MU", "NVDA", "MSFT", "META", "QQQ"]
PORTFOLIO = ["MU", "NVDA", "MSFT", "META"]
MARKET = "QQQ"

PERIODS = {
    "2013-2026": ("2013-01-01", "2026-11-06"),
    "2000-2012": ("2000-01-01", "2012-12-31"),
}

REGIMES = {
    "2020 V型(2/19-8/31)": ("2020-02-19", "2020-08-31"),
    "2022 緩跌": ("2022-01-01", "2022-12-31"),
    "2023 緩漲": ("2023-01-01", "2023-12-31"),
    "2025 關稅急跌反轉(2/19-7/31)": ("2025-02-19", "2025-07-31"),
    "2025/10-2026/09 AI大漲": ("2025-10-01", "2026-09-30"),
    "2026/10-11 AI修正": ("2026-10-01", "2026-11-06"),
    "2008 金融海嘯": ("2008-01-01", "2009-03-31"),
    "2000-2002 網路泡沫": ("2000-03-01", "2002-10-31"),
}


# ---------------------------------------------------------------- data
def load(ticker: str) -> pd.DataFrame:
    path = os.path.join(DATA_DIR, f"{ticker}.csv")
    if os.path.exists(path):
        df = pd.read_csv(path, index_col=0, parse_dates=True)
    else:
        import yfinance as yf

        df = yf.Ticker(ticker).history(period="max", auto_adjust=True)
        df.index = pd.to_datetime(df.index).tz_localize(None)
        df = df[["Open", "High", "Low", "Close", "Volume"]]
        df.to_csv(path)
    df.index = pd.to_datetime(df.index)
    return df


def indicators(df: pd.DataFrame) -> pd.DataFrame:
    c = df["Close"]
    out = df.copy()
    for w in (50, 200):
        out[f"sma{w}"] = c.rolling(w).mean()
    ema12 = c.ewm(span=12, adjust=False).mean()
    ema26 = c.ewm(span=26, adjust=False).mean()
    macd = ema12 - ema26
    out["macd_h"] = macd - macd.ewm(span=9, adjust=False).mean()
    for w in (60, 252):
        out[f"dd{w}"] = c / c.rolling(w).max() - 1.0
    return out


def consecutive(flags: np.ndarray) -> np.ndarray:
    out = np.zeros(len(flags), dtype=int)
    run = 0
    for i, f in enumerate(flags):
        run = run + 1 if f else 0
        out[i] = run
    return out


# ---------------------------------------------------------------- params
@dataclass(frozen=True)
class Params:
    strategy: str = "L0"  # L0 | buyhold | stop10
    use_r1: bool = True
    ma: int = 50
    confirm_days: int = 2
    mult: float = 0.5
    readd_days: int = 5
    cooldown: int = 15
    sev_win: int = 60
    severe_dd: float = -0.15
    overlay: bool = True
    overlay_ma: int = 50
    overlay_mult: float = 0.75
    band: float = math.inf
    stop_pct: float = 0.10

    def label(self) -> str:
        if self.strategy != "L0":
            return self.strategy
        b = "inf" if math.isinf(self.band) else self.band
        return (
            f"L0 r1={int(self.use_r1)} ma{self.ma} c{self.confirm_days} m{self.mult} rd{self.readd_days} "
            f"cd{self.cooldown} sev{self.sev_win}/{self.severe_dd} ov{int(self.overlay)}@{self.overlay_ma} b{b}"
        )


DEFAULT = Params()
SLOW = Params(use_r1=False, ma=200, sev_win=252, severe_dd=-0.20, readd_days=10, overlay_ma=200)


# ---------------------------------------------------------------- engine
def simulate(df: pd.DataFrame, mkt: pd.DataFrame, p: Params):
    mkt = mkt.reindex(df.index).ffill()
    n = len(df)
    open_ = df["Open"].to_numpy()
    close = df["Close"].to_numpy()
    sma = df[f"sma{p.ma}"].to_numpy()
    r1 = (close < sma) & (df["macd_h"].to_numpy() < 0) if p.use_r1 else np.zeros(n, dtype=bool)
    r1_run = consecutive(r1)
    up_run = consecutive(close > sma)
    dd = df[f"dd{p.sev_win}"].to_numpy()
    severe = dd <= p.severe_dd
    msma = mkt[f"sma{p.overlay_ma}"].to_numpy()
    mclose = mkt["Close"].to_numpy()
    mkt_down_run = consecutive(mclose < msma)
    mkt_up_run = consecutive(mclose > msma)

    state = "STD"
    last_switch = -10**9
    mkt_state = False
    mkt_last_switch = -10**9
    peak = -math.inf

    shares = 1.0 / open_[0]
    cash = 0.0
    equity = np.empty(n)
    trades = []
    notifications = 0
    pending = None

    def target_frac(st, mk):
        if p.strategy == "buyhold":
            return 1.0
        if p.strategy == "stop10":
            return 1.0 if st == "STD" else 0.0
        base = 1.0 if st == "STD" else p.mult
        if p.overlay and mk:
            base *= p.overlay_mult
        return base

    for t in range(n):
        if pending is not None:
            action, tf = pending
            px = open_[t]
            val = shares * px + cash
            cur = shares * px / val if val > 0 else 0
            shares = val * tf / px
            cash = val * (1 - tf)
            trades.append((df.index[t], action, px, round(cur, 4), round(tf, 4)))
            pending = None

        equity[t] = shares * close[t] + cash
        if p.strategy == "buyhold" or t == n - 1:
            continue

        changed = False
        action = None
        if p.strategy == "stop10":
            if state == "STD":
                peak = max(peak, close[t])
                if close[t] <= peak * (1 - p.stop_pct):
                    state, last_switch, changed, action = "RED", t, True, "STOP"
            elif up_run[t] >= p.readd_days and t - last_switch >= p.cooldown:
                state, last_switch, peak, changed, action = "STD", t, close[t], True, "REENTER"
            if changed:
                pending = (action, target_frac(state, mkt_state))
                notifications += 1
            continue

        in_cd = t - last_switch < p.cooldown
        if state == "STD":
            if severe[t]:
                state, last_switch, changed, action = "RED", t, True, "REDUCE_SEVERE"
            elif r1_run[t] >= p.confirm_days and not in_cd:
                state, last_switch, changed, action = "RED", t, True, "REDUCE"
        else:
            if up_run[t] >= p.readd_days and not in_cd and not severe[t]:
                state, last_switch, changed, action = "STD", t, True, "READD"

        if p.overlay:
            m_in_cd = t - mkt_last_switch < p.cooldown
            if not mkt_state and mkt_down_run[t] >= p.confirm_days and not m_in_cd:
                mkt_state, mkt_last_switch = True, t
                action = action or "MKT_ON"
                changed = True
            elif mkt_state and mkt_up_run[t] >= p.readd_days and not m_in_cd:
                mkt_state, mkt_last_switch = False, t
                action = action or "MKT_OFF"
                changed = True

        tf = target_frac(state, mkt_state)
        if changed:
            pending = (action, tf)
            notifications += 1
        elif not math.isinf(p.band):
            val = shares * close[t] + cash
            cur = shares * close[t] / val
            if tf > 0 and abs(cur - tf) / tf > p.band:
                pending = ("REBAL", tf)
                notifications += 1

    eq = pd.Series(equity, index=df.index)
    tr = pd.DataFrame(trades, columns=["date", "action", "price", "frac_before", "frac_after"])
    return eq, tr, notifications


# ---------------------------------------------------------------- metrics
def max_drawdown(eq: pd.Series) -> float:
    return float((eq / eq.cummax() - 1).min())


def cagr(eq: pd.Series) -> float:
    yrs = (eq.index[-1] - eq.index[0]).days / 365.25
    return float(eq.iloc[-1] / eq.iloc[0]) ** (1 / yrs) - 1


def whipsaws(tr: pd.DataFrame) -> tuple[int, int]:
    """減持(或停損)後第一次加回(或再進場)的價格 > 減持價 → 被洗。回傳 (被洗次數, 減持次數)。"""
    cuts = tr[tr["action"].str.startswith(("REDUCE", "STOP"))]
    adds = tr[tr["action"].isin(["READD", "REENTER"])]
    w = 0
    for _, c in cuts.iterrows():
        nxt = adds[adds["date"] > c["date"]]
        if len(nxt) and nxt.iloc[0]["price"] > c["price"]:
            w += 1
    return w, len(cuts)


def time_reduced(tr: pd.DataFrame, idx: pd.DatetimeIndex) -> float:
    if tr.empty:
        return 0.0
    frac = pd.Series(1.0, index=idx)
    for _, r in tr.iterrows():
        frac.loc[r["date"]:] = r["frac_after"]
    return float((frac < 0.999).mean())


def regime_returns(eq: pd.Series, bh: pd.Series) -> dict:
    out = {}
    for name, (a, b) in REGIMES.items():
        s, h = eq.loc[a:b], bh.loc[a:b]
        if len(s) < 15:
            continue
        out[name] = (float(s.iloc[-1] / s.iloc[0] - 1), float(h.iloc[-1] / h.iloc[0] - 1))
    return out


# ---------------------------------------------------------------- run
def build_grid() -> list[Params]:
    fast = [
        Params(confirm_days=c, mult=m, readd_days=r, overlay=o)
        for c, m, r, o in itertools.product([1, 2], [0.67, 0.5, 0.33], [3, 5, 10], [False, True])
    ]
    slow = [
        Params(use_r1=u, ma=ma, sev_win=sw, severe_dd=sd, readd_days=10, overlay_ma=om)
        for u, ma, sw, sd, om in itertools.product([True, False], [50, 200], [60, 252], [-0.15, -0.20, -0.25], [50, 200])
    ]
    extra = [
        Params(band=0.2), Params(band=0.1),
        Params(cooldown=0), Params(cooldown=30),
        Params(severe_dd=-1.0),
        replace(SLOW, overlay=False),
        replace(SLOW, mult=0.33),
        replace(SLOW, severe_dd=-0.25),
        Params(strategy="buyhold"), Params(strategy="stop10"),
        Params(strategy="stop10", stop_pct=0.15, readd_days=10),
        Params(strategy="stop10", stop_pct=0.20, readd_days=10),
    ]
    seen, grid = set(), []
    for p in fast + slow + extra:
        if p not in seen:
            seen.add(p)
            grid.append(p)
    return grid


def run_all():
    raw = {t: indicators(load(t)) for t in TICKERS}
    mkt_all = raw[MARKET]
    grid = build_grid()
    print(f"{len(grid)} parameter sets", file=sys.stderr)

    rows, regime_rows, port_rows = [], [], []
    for period, (a, b) in PERIODS.items():
        eqs: dict[str, dict[str, pd.Series]] = {}
        trs: dict[str, dict[str, pd.DataFrame]] = {}
        for tk in TICKERS:
            df = raw[tk].loc[a:b].dropna(subset=["sma200", "dd252"])
            if len(df) < 500:
                continue
            mkt = mkt_all.loc[: df.index[-1]]
            bh_eq, _, _ = simulate(df, mkt, Params(strategy="buyhold"))
            for p in grid:
                eq, tr, notif = simulate(df, mkt, p)
                yrs = (eq.index[-1] - eq.index[0]).days / 365.25
                w, cuts = whipsaws(tr)
                rows.append(dict(
                    period=period, ticker=tk, label=p.label(), **asdict(p), years=round(yrs, 1),
                    cagr=cagr(eq), bh_cagr=cagr(bh_eq),
                    total_ret=float(eq.iloc[-1] / eq.iloc[0] - 1), bh_total_ret=float(bh_eq.iloc[-1] / bh_eq.iloc[0] - 1),
                    mdd=max_drawdown(eq), bh_mdd=max_drawdown(bh_eq),
                    notif_per_year=notif / yrs, cuts=cuts, whipsaw=w,
                    whipsaw_rate=(w / cuts) if cuts else float("nan"),
                    time_reduced=time_reduced(tr, eq.index),
                ))
                eqs.setdefault(p.label(), {})[tk] = eq
                trs.setdefault(p.label(), {})[tk] = tr
                if p in (DEFAULT, SLOW) or p.strategy != "L0":
                    for name, (sr, hr) in regime_returns(eq, bh_eq).items():
                        regime_rows.append(dict(period=period, ticker=tk, label=p.label(), regime=name, strat=sr, bh=hr, excess=sr - hr))
                if period == "2013-2026" and p in (DEFAULT, SLOW):
                    tag = "default" if p == DEFAULT else "slow"
                    tr.to_csv(os.path.join(OUT_DIR, f"B1_trades_{tk}_{tag}.csv"), index=False)

        # 四股等權組合（不再平衡），通知日 = 任一股或大盤疊加有交易的日子
        members = [t for t in PORTFOLIO if t in eqs.get("buyhold", {})]
        if len(members) >= 3:
            bh_port = sum(eqs["buyhold"][t] / eqs["buyhold"][t].iloc[0] for t in members) / len(members)
            for lab, d in eqs.items():
                if not all(t in d for t in members):
                    continue
                idx = d[members[0]].index
                for t in members:
                    idx = idx.intersection(d[t].index)
                port = sum(d[t].loc[idx] / d[t].loc[idx].iloc[0] for t in members) / len(members)
                bhp = bh_port.loc[idx]
                days = set()
                for t in members:
                    days |= set(trs[lab][t]["date"])
                yrs = (idx[-1] - idx[0]).days / 365.25
                port_rows.append(dict(
                    period=period, label=lab, members="+".join(members), years=round(yrs, 1),
                    cagr=cagr(port), bh_cagr=cagr(bhp), mdd=max_drawdown(port), bh_mdd=max_drawdown(bhp),
                    notif_days_per_year=len(days) / yrs,
                ))

    res = pd.DataFrame(rows)
    res.to_csv(os.path.join(OUT_DIR, "B1_results.csv"), index=False)
    reg = pd.DataFrame(regime_rows)
    reg.to_csv(os.path.join(OUT_DIR, "B1_regimes.csv"), index=False)
    port = pd.DataFrame(port_rows)
    port.to_csv(os.path.join(OUT_DIR, "B1_portfolio.csv"), index=False)
    return res, reg, port


def pct(x):
    return f"{x*100:+.1f}%" if pd.notna(x) else "n/a"


def table_for(sub: pd.DataFrame, labels: list[tuple[str, str]]) -> list[str]:
    L = ["| 股票 | 策略 | 年化 | 買進持有年化 | 最大回檔 | 買進持有最大回檔 | 通知/年 | 減持次數 | 被洗率 | 減碼時間占比 |",
         "|---|---|---|---|---|---|---|---|---|---|"]
    for tk in TICKERS:
        for lab, name in labels:
            r = sub[(sub.ticker == tk) & (sub.label == lab)]
            if r.empty:
                continue
            r = r.iloc[0]
            L.append(f"| {tk} | {name} | {pct(r.cagr)} | {pct(r.bh_cagr)} | {pct(r.mdd)} | {pct(r.bh_mdd)} | "
                     f"{r.notif_per_year:.1f} | {int(r.cuts)} | {pct(r.whipsaw_rate)} | {pct(r.time_reduced)} |")
    return L


def summarize(res: pd.DataFrame, reg: pd.DataFrame, port: pd.DataFrame) -> str:
    L = ["# B-1 純規則長期回測結果（腳本自動產生）\n",
         "執行腳本：`backtest/l0_backtest.py`（`uv run python backtest/l0_backtest.py`）。yfinance 調整後價格，訊號收盤算、次日開盤執行，現金報酬 0，無手續費與滑價。\n",
         f"- 預設（快）規則：`{DEFAULT.label()}`",
         f"- 慢規則：`{SLOW.label()}`\n"]
    bench = [(DEFAULT.label(), "L0 預設(快)"), (SLOW.label(), "L0 慢規則"), ("stop10", "追蹤停損 -10%"),
             (Params(strategy="stop10", stop_pct=0.15, readd_days=10).label() + "", "追蹤停損 -15%")]

    for period in PERIODS:
        sub = res[res.period == period]
        if sub.empty:
            continue
        L.append(f"\n## 期間 {period}\n")
        L.append("### 主要策略 vs 基準\n")
        # stop10 variants share label 'stop10'; distinguish by stop_pct
        sub2 = sub.copy()
        sub2.loc[(sub2.strategy == "stop10"), "label"] = sub2.loc[(sub2.strategy == "stop10")].apply(lambda r: f"stop{int(r.stop_pct*100)}", axis=1)
        L += table_for(sub2, [(DEFAULT.label(), "L0 預設(快)"), (SLOW.label(), "L0 慢規則"), ("stop10", "追蹤停損 -10%"), ("stop15", "追蹤停損 -15%"), ("stop20", "追蹤停損 -20%")])

        # 四股組合
        pp = port[port.period == period].copy()
        if not pp.empty:
            pp.loc[pp.label == "stop10", "label"] = "stop10"
            L.append("\n### 四股等權組合（MU/NVDA/MSFT/META，不再平衡）\n")
            L.append("| 策略 | 年化 | 買進持有年化 | 最大回檔 | 買進持有最大回檔 | 通知日/年 |")
            L.append("|---|---|---|---|---|---|")
            for lab, name in [(DEFAULT.label(), "L0 預設(快)"), (SLOW.label(), "L0 慢規則"), ("stop10", "追蹤停損 -10%")]:
                r = pp[pp.label == lab]
                if r.empty:
                    continue
                r = r.iloc[0]
                L.append(f"| {name} | {pct(r.cagr)} | {pct(r.bh_cagr)} | {pct(r.mdd)} | {pct(r.bh_mdd)} | {r.notif_days_per_year:.1f} |")
            L.append("\n通知日/年 最少的 10 組（組合層）：\n")
            L.append("| 參數 | 通知日/年 | 年化差 | 最大回檔 | 買進持有最大回檔 |")
            L.append("|---|---|---|---|---|")
            q = pp[pp.label.str.startswith("L0")].sort_values("notif_days_per_year").head(10)
            for _, r in q.iterrows():
                L.append(f"| `{r.label}` | {r.notif_days_per_year:.1f} | {pct(r.cagr - r.bh_cagr)} | {pct(r.mdd)} | {pct(r.bh_mdd)} |")

        # 參數敏感度（快規則 grid）
        l0 = sub[(sub.strategy == "L0") & (sub.ticker != MARKET)]
        L.append("\n### 快規則參數敏感度（MU/NVDA/MSFT/META 平均；年化差 = 策略 − 買進持有）\n")
        for col, title in [("confirm_days", "確認天數"), ("mult", "減持倍數"), ("readd_days", "加回天數"), ("overlay", "大盤疊加"),
                           ("cooldown", "冷卻期"), ("band", "不交易區間"), ("severe_dd", "嚴重暴跌門檻(60日高點)")]:
            mask = pd.Series(True, index=l0.index)
            for f in ["use_r1", "ma", "confirm_days", "mult", "readd_days", "cooldown", "sev_win", "severe_dd", "overlay", "overlay_ma", "band"]:
                if f == col:
                    continue
                dv = getattr(DEFAULT, f)
                if isinstance(dv, float) and math.isinf(dv):
                    mask &= l0[f].apply(lambda v: isinstance(v, float) and math.isinf(v))
                else:
                    mask &= l0[f] == dv
            g = l0[mask].groupby(col).agg(cagr=("cagr", "mean"), bh=("bh_cagr", "mean"), mdd=("mdd", "mean"), bh_mdd=("bh_mdd", "mean"),
                                           notif=("notif_per_year", "mean"), ws=("whipsaw_rate", "mean"), tr=("time_reduced", "mean"))
            if len(g) < 2:
                continue
            L.append(f"\n**{title}**\n")
            L.append("| 值 | 年化差 | 最大回檔(策略/買進持有) | 通知/年 | 被洗率 | 減碼時間 |")
            L.append("|---|---|---|---|---|---|")
            for v, r in g.iterrows():
                vv = "inf(不再平衡)" if isinstance(v, float) and math.isinf(v) else v
                L.append(f"| {vv} | {pct(r.cagr - r.bh)} | {pct(r.mdd)} / {pct(r.bh_mdd)} | {r.notif:.1f} | {pct(r.ws)} | {pct(r.tr)} |")

        # 慢規則 grid
        slow = l0[(l0.readd_days == 10) & (l0.cooldown == 15) & (l0.mult == 0.5) & (l0.confirm_days == 2) & l0.overlay & l0.band.apply(lambda v: isinstance(v, float) and math.isinf(v))]
        L.append("\n### 慢規則參數敏感度（MU/NVDA/MSFT/META 平均）\n")
        for col, title in [("use_r1", "是否用 R1"), ("ma", "均線長度"), ("sev_win", "高點回看窗"), ("severe_dd", "嚴重暴跌門檻"), ("overlay_ma", "大盤均線")]:
            g = slow.groupby(col).agg(cagr=("cagr", "mean"), bh=("bh_cagr", "mean"), mdd=("mdd", "mean"), bh_mdd=("bh_mdd", "mean"),
                                      notif=("notif_per_year", "mean"), ws=("whipsaw_rate", "mean"), tr=("time_reduced", "mean"))
            if len(g) < 2:
                continue
            L.append(f"\n**{title}**（其他慢規則參數平均）\n")
            L.append("| 值 | 年化差 | 最大回檔(策略/買進持有) | 通知/年 | 被洗率 | 減碼時間 |")
            L.append("|---|---|---|---|---|---|")
            for v, r in g.iterrows():
                L.append(f"| {v} | {pct(r.cagr - r.bh)} | {pct(r.mdd)} / {pct(r.bh_mdd)} | {r.notif:.1f} | {pct(r.ws)} | {pct(r.tr)} |")

        L.append("\n### 所有 L0 參數組合：年化差分佈（每股）\n")
        L.append("| 股票 | 組數 | 最差 | 中位數 | 最好 | 贏買進持有的組數 | 最大回檔中位數 | 通知/年 中位數 |")
        L.append("|---|---|---|---|---|---|---|---|")
        core = sub[(sub.strategy == "L0")]
        for tk in TICKERS:
            g = core[core.ticker == tk]
            if g.empty:
                continue
            d = g.cagr - g.bh_cagr
            L.append(f"| {tk} | {len(d)} | {pct(d.min())} | {pct(d.median())} | {pct(d.max())} | {(d > 0).sum()} | {pct(g.mdd.median())} | {g.notif_per_year.median():.1f} |")

    L.append("\n## 不同行情下的表現（區段報酬；括號 = 買進持有）\n")
    for period in PERIODS:
        for lab, name in [(DEFAULT.label(), "L0 預設(快)"), (SLOW.label(), "L0 慢規則"), ("stop10", "追蹤停損 -10%")]:
            r = reg[(reg.period == period) & (reg.label == lab)]
            if r.empty:
                continue
            regimes = [x for x in REGIMES if x in set(r.regime)]
            L.append(f"\n### {period} · {name}\n")
            L.append("| 股票 | " + " | ".join(regimes) + " |")
            L.append("|---|" + "---|" * len(regimes))
            for tk in TICKERS:
                cells = []
                for rg in regimes:
                    x = r[(r.ticker == tk) & (r.regime == rg)]
                    cells.append(f"{pct(x.iloc[0].strat)} ({pct(x.iloc[0].bh)})" if len(x) else "")
                if any(cells):
                    L.append(f"| {tk} | " + " | ".join(cells) + " |")
    return "\n".join(L)


if __name__ == "__main__":
    res, reg, port = run_all()
    md = summarize(res, reg, port)
    with open(os.path.join(OUT_DIR, "B1_summary.md"), "w", encoding="utf-8") as f:
        f.write(md)
    sys.stdout.reconfigure(encoding="utf-8")
    print(md)
