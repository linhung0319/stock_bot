"""B-9 共用：價格面板、成分股區段、EDGAR 事件可得時點、事件分類。

資料（全部唯讀）：
  - LEAN 資料夾 lean_strategies/data-sp500-long（與 momentum_backtest.py 相同；Yahoo 還原權值）
  - research/data_sources/raw/b9_sp500_cik_map.csv、b9_edgar_events.csv（資料源驗證已建好的快取）
  - backtest/data/b9_docs/（b9_fetch.py 抓的申報原文）
  - backtest/data/b9_sector_etfs.csv（yfinance 抓一次，SPDR 產業 ETF）
"""
from __future__ import annotations

import json
import pickle
import re
import sys
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "research" / "data_sources"))
from momentum_backtest import DEFAULT_LEAN, LeanData  # noqa: E402

RAW = HERE.parent / "research" / "data_sources" / "raw"
DATA = HERE / "data"
OUT = HERE / "results"
START = pd.Timestamp("2009-01-01")
END = pd.Timestamp("2026-09-15")
HORIZONS = {"3m": 63, "6m": 126, "12m": 252}
BANKS = {"19617", "886982", "831001", "895421", "70858"}  # JPM GS C MS BAC（424B2 結構型債券）


# ---------------------------------------------------------------- prices

def load_panel(lean: Path = DEFAULT_LEAN):
    """全部 LEAN 代號的還原收盤、還原開盤、原始收盤；以 SPY 交易日為準。快取在 backtest/data/b9_panel.pkl。"""
    cache = DATA / "b9_panel.pkl"
    if cache.exists():
        return pickle.loads(cache.read_bytes())
    data = LeanData(lean)
    days = data.bars("SPY").loc[:END].index
    adj, opn, raw = {}, {}, {}
    for p in sorted((data.root / "daily").glob("*.zip")):
        t = p.stem.upper()
        b = data.bars(t)
        if b is None or b.empty:
            continue
        b = b.loc[:END]
        adj[t], opn[t], raw[t] = b["adj"], b["adj_open"], b["close"]
    panel = {
        "days": days,
        "adj": pd.DataFrame(adj).reindex(days).astype("float32"),
        "open": pd.DataFrame(opn).reindex(days).astype("float32"),
        "raw": pd.DataFrame(raw).reindex(days).astype("float32"),
    }
    cache.write_bytes(pickle.dumps(panel))
    return panel


def lean_ticker(t: str) -> str:
    return t.replace(".", "").replace("-", "").upper()


def sector_etfs() -> pd.DataFrame:
    """SPDR 產業 ETF 的還原收盤／開盤（yfinance，抓一次存檔）。"""
    path = DATA / "b9_sector_etfs.csv"
    if path.exists():
        return pd.read_csv(path, index_col=0, parse_dates=True, header=[0, 1])
    import yfinance as yf
    tick = ["XLK", "XLF", "XLE", "XLV", "XLI", "XLY", "XLP", "XLU", "XLB", "XLRE", "XLC"]
    df = yf.download(tick, start="2008-01-01", end="2026-09-16", auto_adjust=True, progress=False)
    df = df[["Open", "Close"]]
    df.to_csv(path)
    return df


# ---------------------------------------------------------------- membership

def cik_map() -> pd.DataFrame:
    m = pd.read_csv(RAW / "b9_sp500_cik_map.csv", dtype=str)
    m["ltk"] = m.ticker.map(lean_ticker)
    return m


def segment_ticker(m: pd.DataFrame, cik: str, date: str, have: set) -> str | None:
    """事件日落在哪一段（該 CIK 在指數內的期間）→ 該段的代號；同時多個代號時取有價格的第一個。"""
    g = m[(m.cik == cik) & (m.valid_from <= date) & (m.valid_to >= date)]
    if g.empty:
        return None
    for t in g.ltk:
        if t in have:
            return t
    return g.ltk.iloc[0]


def sic_of(cik: str) -> str | None:
    """submissions JSON（資料源驗證的 http_cache，不重抓）的 SIC。"""
    from common import cache_path  # research/data_sources/common.py
    p = cache_path(f"https://data.sec.gov/submissions/CIK{int(cik):010d}.json", ".body")
    if not p.exists():
        return None
    try:
        return json.loads(p.read_bytes()).get("sic") or None
    except Exception:
        return None


def names_of(cik: str) -> list[str]:
    """submissions JSON 的現名與 formerNames（不重抓）。"""
    from common import cache_path
    p = cache_path(f"https://data.sec.gov/submissions/CIK{int(cik):010d}.json", ".body")
    if not p.exists():
        return []
    try:
        j = json.loads(p.read_bytes())
    except Exception:
        return []
    return [j.get("name") or ""] + [f.get("name", "") for f in j.get("formerNames", [])]


def sic_to_etf(sic: str | None, day: pd.Timestamp) -> str | None:
    """SIC → SPDR 產業 ETF（近似 GICS）。XLRE 2015-10、XLC 2018-06 以前分別併入 XLF、XLK/XLY。"""
    if not sic:
        return None
    s = int(sic)
    reit = "XLRE" if day >= pd.Timestamp("2015-10-08") else "XLF"
    comm_tech = "XLC" if day >= pd.Timestamp("2018-06-19") else "XLK"
    comm_disc = "XLC" if day >= pd.Timestamp("2018-06-19") else "XLY"
    if s in (6798,) or 6500 <= s <= 6553:
        return reit
    if 6000 <= s <= 6411 and s != 6324 or 6700 <= s <= 6799:
        return "XLF"
    if s == 6324 or 2833 <= s <= 2836 or 3841 <= s <= 3851 or 8000 <= s <= 8099 or s in (5122, 5047, 8731, 3826):
        return "XLV"
    if s in (1311, 1381, 1382, 1389, 2911, 2990, 1221, 1222, 4922, 4923, 5171, 5172, 4610, 4612, 4613, 3533):
        return "XLE"
    if 4900 <= s <= 4949 or s == 4991:
        return "XLU"
    if s in (4812, 4813, 4899, 7370, 7374) or s in (2711, 2721, 4832):
        return comm_tech if s in (4812, 4813, 4899, 7370, 7374) else comm_disc
    if s in (4833, 4841, 7812, 7822, 7990, 7997):
        return comm_disc
    if 3570 <= s <= 3579 or 3600 <= s <= 3699 and s not in (3630, 3634, 3651) or 7371 <= s <= 7379 or s in (3577, 3825, 3827, 5045, 7389):
        return "XLK"
    if 2000 <= s <= 2199 or 2840 <= s <= 2844 or s in (5411, 5912, 5331, 5141, 5180, 5190, 2676):
        return "XLP"
    if 1000 <= s <= 1499 or 2600 <= s <= 2699 or 2800 <= s <= 2829 or 2850 <= s <= 2899 or 3200 <= s <= 3299 or 3300 <= s <= 3399 or s in (2400, 2421, 2430, 2451):
        return "XLB"
    if 5000 <= s <= 5999 or 7000 <= s <= 7099 or 5800 <= s <= 5899 or 3710 <= s <= 3716 or 2300 <= s <= 2399 or 3630 <= s <= 3659 or s in (3140, 3942, 3944, 3949, 7200, 7900, 1531, 1520, 8200, 8211, 8600, 7500, 7510, 2510, 2520, 3021):
        return "XLY"
    return "XLI"


# ---------------------------------------------------------------- availability

def avail_day(accept_utc: str, days: pd.DatetimeIndex) -> pd.Timestamp | None:
    """acceptanceDateTime（UTC）→ 第一個可交易的開盤日。
    美東 < 09:30 且當天是交易日 → 當天開盤；其他（盤中、盤後、假日）→ 下一個交易日開盤。"""
    t = pd.Timestamp(accept_utc)
    if t.tzinfo is None:
        t = t.tz_localize("UTC")
    et = t.tz_convert("America/New_York")
    d = pd.Timestamp(et.date())
    pre = (et.hour, et.minute) < (9, 30)
    i = days.searchsorted(d, side="left" if pre else "right")
    if i >= len(days):
        return None
    return days[i]


def load_raw_events() -> pd.DataFrame:
    e = pd.read_csv(RAW / "b9_edgar_events.csv", dtype=str)
    e["items"] = e["items"].fillna("")
    m = pd.read_csv(RAW / "b9_sp500_cik_map.csv", dtype=str)
    segs = m.groupby("cik")[["valid_from", "valid_to"]].apply(lambda g: list(zip(g.valid_from, g.valid_to))).to_dict()
    e["inwin"] = [any(a <= d <= b for a, b in segs.get(c, [])) for c, d in zip(e.cik, e.filingDate)]
    return e


def has_item(items: pd.Series, code: str) -> pd.Series:
    return items.apply(lambda s: code in s.split(","))


# ---------------------------------------------------------------- jump share / ID

def jump_metrics(adj: pd.Series, spy: pd.Series, i: int, lookback: int = 252, post: int = 63):
    """決策日前一交易日（位置 i）為止可知的單日漲幅占比、3 日占比、事件後相對 SPY、資訊離散度 ID。
    占比 = 最大單日（或 3 日）對數報酬 ÷ 12 個月對數報酬（只在 12 個月報酬 > 0 時有意義）。
    post_rel：最大單日（3 日）之後 63 個交易日的相對 SPY 報酬；只有在決策日之前已經觀察得到（jump 位置 ≤ i−63）才有值。"""
    if i - lookback < 0:
        return None
    w = adj.iloc[i - lookback:i + 1].to_numpy(dtype=float)
    if np.isnan(w).any() or w[0] <= 0:
        return None
    lr = np.diff(np.log(w))
    tot = lr.sum()
    s = spy.iloc[i - lookback:i + 1].to_numpy(dtype=float)
    out = {"r12": float(np.exp(tot) - 1)}
    n = len(lr)
    out["id"] = float(np.sign(tot) * ((lr < 0).mean() - (lr > 0).mean()))
    for k, name in ((1, "j1"), (3, "j3")):
        roll = np.convolve(lr, np.ones(k), "valid") if k > 1 else lr
        j = int(np.argmax(roll))
        end_pos = j + k  # 在 w 裡的位置（跳空結束那天的收盤）
        out[f"{name}_share"] = float(roll[j] / tot) if tot > 0 else np.nan
        if end_pos + post <= n:  # 決策日前已觀察到 63 天
            rel = (w[end_pos + post] / w[end_pos]) / (s[end_pos + post] / s[end_pos]) - 1
            out[f"{name}_post"] = float(rel)
        else:
            out[f"{name}_post"] = np.nan
        out[f"{name}_ago"] = int(n - end_pos)
    return out


# ---------------------------------------------------------------- stats helpers

def boot_ci(x, stat=np.median, n=4000, q=(0.05, 0.95), seed=0):
    x = np.asarray([v for v in x if np.isfinite(v)])
    if len(x) < 3:
        return (np.nan, np.nan)
    rng = np.random.default_rng(seed)
    bs = stat(rng.choice(x, size=(n, len(x)), replace=True), axis=1)
    return tuple(np.quantile(bs, q))


def cluster_boot_ci(values, clusters, stat=np.mean, n=4000, q=(0.05, 0.95), seed=0):
    """以群（月）重抽，回傳統計量的區間。"""
    df = pd.DataFrame({"v": values, "c": clusters}).dropna()
    if df.c.nunique() < 3:
        return (np.nan, np.nan)
    groups = [g.v.to_numpy() for _, g in df.groupby("c")]
    rng = np.random.default_rng(seed)
    out = []
    for _ in range(n):
        pick = rng.integers(0, len(groups), len(groups))
        out.append(stat(np.concatenate([groups[k] for k in pick])))
    return tuple(np.quantile(out, q))


def beta_post(k: int, n: int, q=(0.05, 0.95)):
    """Beta(1,1) 先驗；回傳後驗中位數、90% 區間、P(p > 0.5)。"""
    from scipy.stats import beta
    a, b = 1 + k, 1 + n - k
    return float(beta.median(a, b)), float(beta.ppf(q[0], a, b)), float(beta.ppf(q[1], a, b)), float(1 - beta.cdf(0.5, a, b))
