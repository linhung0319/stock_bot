"""驗證 1b：上線用的「目前成分股」與市值排序來源。

做什麼：
  1. SSGA SPY 每日持股檔（xlsx，免費、免登入）：日期、檔數、權重（＝浮動市值占比）。
  2. 和 Wikipedia 目前成分股表、fja05680 最新一列比對代號差異。
  3. iShares IVV 持股 CSV（含 asOfDate 歷史參數）是否可程式化下載。
  4. SPY 權重排序 vs XBRL 股數×價格排序：前 50 名重疊幾檔（市值口徑：浮動 vs 全部股數）。

用法：
  uv run python research/data_sources/s01b_live_membership.py
輸出：stdout；raw/s01b_spy_holdings.csv
"""
from __future__ import annotations

import io

import pandas as pd

from common import RAW, get

BROWSER = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "Accept": "*/*"}
SPY_URL = "https://www.ssga.com/us/en/intermediary/library-content/products/fund-data/etfs/us/holdings-daily-us-en-spy.xlsx"


def main():
    st, b, meta = get(SPY_URL, headers=BROWSER, binary=True)
    head = pd.read_excel(io.BytesIO(b), header=None, nrows=4)
    asof = head.iloc[2, 1]
    h = pd.read_excel(io.BytesIO(b), skiprows=4)
    h = h[h["Ticker"].notna() & h["Weight"].notna()]
    h = h[h["Ticker"] != "-"]
    h.to_csv(RAW / "s01b_spy_holdings.csv", index=False)
    print(f"[SPY 持股] {asof}（抓取 {meta['fetched_at']}），{len(h)} 列，權重合計 {h.Weight.sum():.2f}%")
    print("  非股票列：", h[~h.Ticker.str.match(r"^[A-Z.]+$")][["Name", "Ticker", "Weight"]].to_dict("records"))
    spy = set(h.Ticker.str.upper())
    wiki_html = get("https://en.wikipedia.org/wiki/List_of_S%26P_500_companies",
                    headers={"User-Agent": "Mozilla/5.0 (research script; data source validation)"})[1]
    wiki = {str(s).upper() for s in pd.read_html(io.StringIO(wiki_html))[0]["Symbol"]}
    fja = pd.read_csv(RAW / "s01_fja_now.csv")
    fja_last = set(fja.iloc[-1]["tickers"].split(","))
    print(f"  SPY {len(spy)} 檔；Wikipedia {len(wiki)}；fja 最新列（{fja.iloc[-1]['date']}）{len(fja_last)}")
    print(f"  只在 SPY：{sorted(spy - wiki)}；只在 Wikipedia：{sorted(wiki - spy)}")
    print(f"  fja 和 SPY 差：只在 fja {sorted(fja_last - spy)}；只在 SPY {sorted(spy - fja_last)}")

    # iShares
    for q in ["", "&asOfDate=20200131"]:
        st, txt, _ = get("https://www.ishares.com/us/products/239726/ishares-core-sp-500-etf/1467271812596.ajax"
                         f"?fileType=csv&fileName=IVV_holdings&dataType=fund{q}", headers=BROWSER)
        print(f"[iShares IVV{q or ' 今天'}] status {st}，開頭 {txt[:60]!r}")

    # SPY 權重前 50 vs 前 100 名
    top = h.sort_values("Weight", ascending=False)
    print("  SPY 權重前 10：", top.Ticker.head(10).tolist())


if __name__ == "__main__":
    main()
