"""驗證 6：價格來源（yfinance 與備援）。

做什麼：
  1. yfinance（auto_adjust=False / True）抓 8 檔：Close、Adj Close、分割、股利；缺值天數（以 SPY 交易日為準）。
  2. 和 LEAN 資料夾裡 2026-10-14 抓的 Yahoo 快取比：同一天的未調整收盤、還原權值報酬是否一致
     （檢查 Yahoo 歷史會不會事後變動）。
  3. 已下市代號：yfinance 拿不拿得到。
  4. 備援：Nasdaq 非官方 API（historical）、Alpha Vantage TIME_SERIES_DAILY（免費）、
     TIME_SERIES_DAILY_ADJUSTED（是否付費）、LISTING_STATUS（下市清單）；Stooq（已確認需 JavaScript，見 s01 紀錄）。
  5. yfinance vs Nasdaq 收盤比對（2024-01～2026-10）。

用法：
  uv run python research/data_sources/s07_prices.py
  （Alpha Vantage 免費每天 25 次，本腳本最多打 4 次，結果快取）
輸出：stdout；raw/s07_*.csv / .pkl
"""
from __future__ import annotations

import io
import json
import zipfile

import numpy as np
import pandas as pd
import yfinance as yf

from common import LEAN, RAW, env, get, redact

TICKERS = ["AAPL", "MSFT", "NVDA", "XOM", "KO", "MU", "BRK-B", "SPY"]
DELISTED = ["ATVI", "LEH", "TWTR", "CELG", "XLNX", "SIVB", "FRC", "ABMD", "WFM", "MON"]
BROWSER = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36",
           "Accept": "application/json"}


def yf_hist(tk, adjust):
    p = RAW / f"s07_yf_{tk}_{'adj' if adjust else 'raw'}.pkl"
    if p.exists():
        return pd.read_pickle(p)
    h = yf.Ticker(tk).history(start="1996-01-01", auto_adjust=adjust, actions=True)
    if len(h):
        h.index = h.index.tz_localize(None).normalize()
    h.to_pickle(p)
    return h


def lean_bars(tk):
    path = LEAN / "equity" / "usa" / "daily" / f"{tk.lower().replace('-', '.')}.zip"
    if not path.exists():
        return None
    with zipfile.ZipFile(path) as z:
        raw = z.read(z.namelist()[0]).decode()
    b = pd.read_csv(io.StringIO(raw), header=None, names=["date", "open", "high", "low", "close", "volume"])
    b.index = pd.to_datetime(b.pop("date").astype(str).str[:8], format="%Y%m%d")
    b[["open", "high", "low", "close"]] /= 10000.0
    return b


def main():
    spy = yf_hist("SPY", False)
    cal = spy.index
    rows = []
    for tk in TICKERS:
        raw, adj = yf_hist(tk, False), yf_hist(tk, True)
        span = cal[(cal >= raw.index[0]) & (cal <= raw.index[-1])]
        miss = span.difference(raw.index)
        nan_close = int(raw["Close"].isna().sum())
        zero_vol = int((raw["Volume"] == 0).sum())
        splits = raw["Stock Splits"][raw["Stock Splits"] > 0]
        divs = raw["Dividends"][raw["Dividends"] > 0]
        # auto_adjust=True 的 Close 應等於 auto_adjust=False 的 Adj Close
        common = raw.index.intersection(adj.index)
        diff = (adj.loc[common, "Close"] / raw.loc[common, "Adj Close"] - 1).abs().max()
        # 和 LEAN（2026-10-14 抓的 Yahoo）比：未調整收盤 = yfinance Close × 之後的分割倍數
        lb = lean_bars(tk)
        lean_cmp = None
        if lb is not None:
            cum = pd.Series(1.0, index=raw.index)
            for d, r in splits.items():
                cum[cum.index < d] *= r
            unadj = raw["Close"] * cum
            c2 = lb.index.intersection(unadj.index)
            c2 = c2[c2 <= pd.Timestamp("2026-09-15")]
            rel = (lb.loc[c2, "close"] / unadj.loc[c2] - 1).abs()
            lean_cmp = f"{len(c2)} 天，|差|>0.1% {int((rel > 0.001).sum())} 天，最大 {rel.max():.4%}"
        rows.append(dict(ticker=tk, first=raw.index[0].date(), days=len(raw), missing_vs_spy=len(miss),
                         nan_close=nan_close, zero_volume=zero_vol, splits=len(splits), dividends=len(divs),
                         autoadj_vs_adjclose_maxdiff=f"{diff:.2e}", vs_lean_cache=lean_cmp))
    df = pd.DataFrame(rows)
    pd.set_option("display.width", 250, "display.max_colwidth", 80)
    print("[yfinance 8 檔]")
    print(df.to_string(index=False))
    df.to_csv(RAW / "s07_yf_quality.csv", index=False)

    # 還原權值報酬：yfinance Adj Close vs LEAN factor 檔（同為 Yahoo，抓取時間不同）
    print("\n[252 日還原報酬：yfinance 今天 vs LEAN 快取（2026-10-14）]")
    for tk in ["AAPL", "XOM", "KO", "MU"]:
        raw = yf_hist(tk, False)
        lb = lean_bars(tk)
        f = pd.read_csv(LEAN / "equity" / "usa" / "factor_files" / f"{tk.lower()}.csv", header=None,
                        names=["date", "price", "split", "ref"])
        f.index = pd.to_datetime(f["date"].astype(str), format="%Y%m%d")
        scale = (f["price"] * f["split"]).sort_index()
        pos = scale.index.searchsorted(lb.index, side="left")
        lean_adj = lb["close"] * scale.iloc[np.minimum(pos, len(scale) - 1)].to_numpy()
        a = raw["Adj Close"].pct_change(252)
        b = lean_adj.pct_change(252)
        c = a.index.intersection(b.index)
        c = c[(c >= "2000-01-01") & (c <= "2026-09-15")]
        d = (a.loc[c] - b.loc[c]).abs()
        print(f"  {tk}: {len(c)} 天，|差| 中位數 {d.median():.4%}，最大 {d.max():.4%}（{d.idxmax().date()}）")

    # 已下市
    print("\n[yfinance 已下市代號]")
    for tk in DELISTED:
        try:
            h = yf.Ticker(tk).history(period="max", auto_adjust=False)
            print(f"  {tk}: {len(h)} 筆" + (f"，{h.index[0].date()}→{h.index[-1].date()}" if len(h) else ""))
        except Exception as e:  # noqa: BLE001
            print(f"  {tk}: 例外 {type(e).__name__}")

    # Nasdaq 非官方 API
    st, b, _ = get("https://api.nasdaq.com/api/quote/AAPL/historical?assetclass=stocks&fromdate=2014-01-01"
                   "&todate=2026-11-06&limit=9999", headers=BROWSER, timeout=40)
    nq = None
    try:
        j = json.loads(b)
        rows = j["data"]["tradesTable"]["rows"]
        nq = pd.DataFrame(rows)
        nq["date"] = pd.to_datetime(nq["date"])
        nq["close"] = nq["close"].str.replace("[$,]", "", regex=True).astype(float)
        nq = nq.set_index("date").sort_index()
        print(f"\n[Nasdaq API] AAPL {len(nq)} 筆，{nq.index[0].date()}→{nq.index[-1].date()}；欄位 {list(rows[0].keys())}")
        raw = yf_hist("AAPL", False)
        c = nq.index.intersection(raw.index)
        rel = (nq.loc[c, "close"] / raw.loc[c, "Close"] - 1).abs()
        print(f"  vs yfinance Close：{len(c)} 天，|差|>0.1% {int((rel > 0.001).sum())} 天，最大 {rel.max():.4%}")
        # 分割前：Nasdaq 是否已分割調整
        print("  2020-08-28（4:1 分割前一天）Nasdaq close", nq.loc["2020-08-28", "close"] if "2020-08-28" in nq.index else None,
              "yfinance Close", round(raw.loc["2020-08-28", "Close"], 2))
    except Exception as e:  # noqa: BLE001
        print(f"\n[Nasdaq API] status {st}，解析失敗 {type(e).__name__}: {str(b)[:200]}")
    st, b, _ = get("https://api.nasdaq.com/api/quote/ATVI/historical?assetclass=stocks&fromdate=2022-01-01"
                   "&todate=2023-12-31&limit=9999", headers=BROWSER, timeout=40)
    print(f"  ATVI（已下市）：status {st}，{str(b)[:160]}")

    # Alpha Vantage
    k = env("ALPHA_VANTAGE_API_KEY")
    for fn, sym, extra in [("TIME_SERIES_DAILY", "AAPL", "&outputsize=full"),
                           ("TIME_SERIES_DAILY_ADJUSTED", "AAPL", "&outputsize=compact"),
                           ("TIME_SERIES_DAILY", "ATVI", "&outputsize=compact")]:
        st, b, meta = get(f"https://www.alphavantage.co/query?function={fn}&symbol={sym}{extra}&apikey={k}", min_interval=2.0)
        if "spreading out" in b:  # 每秒限流的回應不要留在快取
            from common import cache_path
            cache_path(f"https://www.alphavantage.co/query?function={fn}&symbol={sym}{extra}&apikey={k}", ".body").unlink(missing_ok=True)
        j = json.loads(b)
        ts = next((v for kk, v in j.items() if "Time Series" in kk), None)
        msg = j.get("Information") or j.get("Note") or j.get("Error Message")
        if ts:
            ds = sorted(ts)
            print(f"\n[Alpha Vantage {fn} {sym}{extra}] {len(ts)} 筆 {ds[0]}→{ds[-1]}；欄位 {list(ts[ds[-1]].keys())}")
        else:
            print(f"\n[Alpha Vantage {fn} {sym}{extra}] {redact(str(msg))[:200]}")
    st, b, _ = get(f"https://www.alphavantage.co/query?function=LISTING_STATUS&state=delisted&apikey={k}", min_interval=2.0)
    lst = pd.read_csv(io.StringIO(b)) if st == 200 and b.startswith("symbol") else None
    if lst is not None:
        lst.to_csv(RAW / "s07_av_delisted.csv", index=False)
        print(f"\n[Alpha Vantage LISTING_STATUS delisted] {len(lst)} 筆；欄位 {list(lst.columns)}；"
              f"delistingDate 範圍 {lst.delistingDate.min()}→{lst.delistingDate.max()}")
        print("  抽查：", lst[lst.symbol.isin(["ATVI", "LEH", "TWTR", "CELG", "XLNX", "SIVB"])].to_dict("records"))
    else:
        print("\n[Alpha Vantage LISTING_STATUS]", redact(str(b))[:200])


if __name__ == "__main__":
    main()
