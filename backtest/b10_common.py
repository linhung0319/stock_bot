"""
階段十二（B-10～B-12）共用：資料、現金報酬、大盤狀態訊號、跳過一個月的排名、依波動度減碼。

只從凍結的舊腳本 import，不修改它們。

  現金報酬  ：SGOV 2020-06 上市前用 3 個月國庫券利率（FRED DTB3，backtest/data/fred_dtb3.csv），
              之後用 SGOV 還原權值收盤（backtest/data/sgov.csv，yfinance）。
  大盤狀態  ：都用 SPY 還原權值收盤，在換股日用前一個交易日收盤以前的資料。
              bear24 / bear36  過去 24 / 36 個月報酬為負（Daniel & Moskowitz 2016 / Cooper, Gutierrez & Hameed 2004）
              hv               過去 126 個交易日的日報酬年化波動 > 這個數列到當天為止的中位數（只用當時以前的資料）
              below200         收盤 < 200 日均線（現在的崩盤規則）
  跳過一個月：學界 12-1 動能 = 252 日前到 21 日前的報酬；股票池與現在相同（沿用 B-2 的排名快取的 50 檔）。
"""
from __future__ import annotations

import pickle
import sys
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import momentum_backtest as mb  # noqa: E402

OUT = mb.OUT_DIR
DATA = mb.DATA_DIR
SKIP = 21

# 事件窗：前五個與 account_backtest.EVENTS 相同；另加 2009 反彈（動能崩盤的典型時段，Daniel & Moskowitz 2016）
EVENTS = {"2000–02": ("2000-03-01", "2002-10-31"), "2008": ("2007-10-01", "2009-03-31"),
          "2009 反彈": ("2009-03-09", "2009-12-31"), "2020": ("2020-02-19", "2020-04-30"),
          "2022": ("2022-01-01", "2022-10-31"), "2026-07": ("2026-06-30", "2026-09-15")}


def pct(x, d=1):
    return "—" if x is None or (isinstance(x, float) and np.isnan(x)) else f"{x*100:.{d}f}%"


# ---------------------------------------------------------------- data

class World:
    """一次載入全部要用的東西。"""

    def __init__(self, offsets=(0,), extra=()):
        self.data = mb.LeanData(mb.DEFAULT_LEAN)
        spy = self.data.bars("SPY").loc[:mb.END]
        self.days = spy.index
        self.ranks = {o: mb.load_ranks(self.data, mb.DEFAULT_LEAN, self.days, o) for o in offsets}
        tickers = sorted({t for r in self.ranks.values() for s in r.values() for t in s.index} | {"SPY"} | set(extra))
        self.prices = mb.Prices(self.data, tickers, self.days)
        self.cash = cash_index(self.days)
        self.reg = regimes(self.prices.close["SPY"])
        self._skip = {}

    def skip_ranks(self, offset):
        if offset not in self._skip:
            self._skip[offset] = load_skip_ranks(self.data, self.ranks[offset], offset)
        return self._skip[offset]


def fetch_cash_data():
    """backtest/data/ 不進 git；缺檔時下載（FRED 公開 CSV、yfinance）。"""
    if not (DATA / "fred_dtb3.csv").exists():
        import requests
        r = requests.get("https://fred.stlouisfed.org/graph/fredgraph.csv?id=DTB3", timeout=60)
        r.raise_for_status()
        (DATA / "fred_dtb3.csv").write_bytes(r.content)
    if not (DATA / "sgov.csv").exists():
        import yfinance as yf
        d = yf.download("SGOV", start="2020-05-01", end="2026-09-16", auto_adjust=True, progress=False)
        d["Close"].to_csv(DATA / "sgov.csv")


def cash_index(days: pd.DatetimeIndex) -> pd.Series:
    """現金（SGOV）的累積報酬指數，對齊 days。"""
    fetch_cash_data()
    tb = pd.read_csv(DATA / "fred_dtb3.csv", index_col=0, parse_dates=True).iloc[:, 0]
    tb = pd.to_numeric(tb, errors="coerce").ffill().reindex(days, method="ffill").bfill()
    gap = pd.Series(days, index=days).diff().dt.days.fillna(0)
    r_tb = tb.shift(1).bfill() / 100 * gap / 360
    sg = pd.read_csv(DATA / "sgov.csv", index_col=0, parse_dates=True).iloc[:, 0].reindex(days)
    r_sg = sg.pct_change(fill_method=None)
    start = sg.first_valid_index()
    r = r_tb.where(days <= start, r_sg.fillna(0))
    return (1 + r).cumprod()


def regimes(spy_close: pd.Series) -> pd.DataFrame:
    """每天收盤後的大盤狀態（換股日要用 .shift(1) 取前一天）。"""
    c = spy_close.dropna()
    out = pd.DataFrame(index=spy_close.index)
    for m in (24, 36):
        prev = c.reindex(c.index - pd.DateOffset(months=m), method="ffill").to_numpy()
        r = c.to_numpy() / prev - 1
        known = (c.index - pd.DateOffset(months=m)) >= c.index[0]
        out[f"bear{m}"] = pd.Series(np.where(known, r < 0, False), index=c.index).reindex(out.index).fillna(False).astype(bool)
    vol = c.pct_change().rolling(126).std() * np.sqrt(252)
    med = vol.expanding(min_periods=126).median()
    out["vol126"] = vol.reindex(out.index)
    out["vol_med"] = med.reindex(out.index)
    out["hv"] = (out["vol126"] > out["vol_med"]).fillna(False)
    sma = c.rolling(200).mean()
    out["below200"] = (c < sma).reindex(out.index).fillna(False)
    for m in (24, 36):
        out[f"bear{m}hv"] = out[f"bear{m}"] & out["hv"]
    return out


def load_skip_ranks(data: mb.LeanData, ranks: dict, offset: int) -> dict:
    """同一個 50 檔股票池，改用 12-1 動能排名。"""
    cache = DATA / f"b10_ranks_skip1_off{offset}.pkl"
    if cache.exists():
        return pickle.loads(cache.read_bytes())
    out = {}
    for d, s in ranks.items():
        vals = {}
        for t in s.index:
            b = data.bars(t)
            i = b.index.searchsorted(d, side="left") - 1
            if i - mb.LOOKBACK < 0:
                continue
            a = b["adj"].iloc
            vals[t] = (a[i - SKIP] / a[i - mb.LOOKBACK] - 1) * 100
        out[d] = pd.Series(vals, name="mom12_1").dropna().sort_values(ascending=False)
    cache.write_bytes(pickle.dumps(out))
    print(f"  已建立 12-1 排名快取 offset={offset}", flush=True)
    return out


# ---------------------------------------------------------------- 依波動度減碼（B-8 的緩衝版，與 account_backtest 相同）

def f3(x):
    return np.floor(min(1.0, max(0.0, x)) * 3 + 1e-9) / 3


class VolScaler:
    def __init__(self, hyst=0.10):
        self.hist: list[float] = []
        self.w = None
        self.hyst = hyst

    def step(self, sigma: float) -> float:
        w = 1.0
        if len(self.hist) >= mb.VOL_MIN_HISTORY:
            raw = min(1.0, float(np.median(self.hist)) / sigma)
            cand = f3(raw)
            if self.w is not None and self.hyst > 0:
                if cand > self.w:
                    cand = max(self.w, f3(raw - self.hyst))
                elif cand < self.w:
                    cand = min(self.w, f3(raw + self.hyst))
            self.w = cand
            w = cand
        self.hist.append(sigma)
        return w


# ---------------------------------------------------------------- metrics

def perf(v: pd.Series, spy: pd.Series, lo=None, hi=None) -> dict:
    v = v.loc[lo:hi].dropna()
    s = spy.reindex(v.index)
    yrs = (v.index[-1] - v.index[0]).days / 365.25
    mr = v.resample("ME").last().pct_change().dropna()
    rel = v / s
    return dict(cagr=(v.iloc[-1] / v.iloc[0]) ** (1 / yrs) - 1,
                spy_cagr=(s.iloc[-1] / s.iloc[0]) ** (1 / yrs) - 1,
                sharpe=mr.mean() / mr.std() * np.sqrt(12),
                maxdd=(v / v.cummax() - 1).min(),
                rel_maxdd=(rel / rel.cummax() - 1).min(),
                yrs=yrs)


def event_rel(v: pd.Series, spy: pd.Series) -> dict:
    """各事件窗內相對 SPY 的報酬：(1+策略)/(1+SPY) − 1。"""
    out = {}
    for name, (a, b) in EVENTS.items():
        x = v.loc[a:b].dropna()
        if len(x) < 2 or x.index[0] > pd.Timestamp(a) + pd.Timedelta(days=7):
            out[name] = np.nan
            continue
        s = spy.reindex(x.index)
        out[name] = (x.iloc[-1] / x.iloc[0]) / (s.iloc[-1] / s.iloc[0]) - 1
    return out


def event_abs(v: pd.Series) -> dict:
    out = {}
    for name, (a, b) in EVENTS.items():
        x = v.loc[a:b].dropna()
        ok = len(x) > 1 and x.index[0] <= pd.Timestamp(a) + pd.Timedelta(days=7)
        out[name] = x.iloc[-1] / x.iloc[0] - 1 if ok else np.nan
    return out


def md_table(header, rows):
    L = ["| " + " | ".join(header) + " |", "|" + "---|" * len(header)]
    L += ["| " + " | ".join(str(c) for c in r) + " |" for r in rows]
    return L
