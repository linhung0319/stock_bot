"""驗證 2：point-in-time 市值 = XBRL 股數 × 價格；成交金額口徑。

做什麼：
  1. 抓 companyfacts，取 dei:EntityCommonStockSharesOutstanding（封面股數）與 us-gaap 備案
     （CommonStockSharesOutstanding、WeightedAverageNumberOfSharesOutstandingBasic），
     每筆保留 end／filed／form／accn。
  2. 某一天 t 的市值：用 filed ≤ t 的最新一筆股數；股數日期 end 到 t 之間（及之後）的分割
     用 yfinance 的 splits 換算到「今天的股數口徑」，再乘 yfinance 的 Close（已分割調整、未除息）。
  3. 和公開報導的市值里程碑比對（收盤價口徑；里程碑多半是盤中，誤差幾 % 正常）。
  4. 多類股：GOOGL／GOOG、BRK.B 的 companyfacts 有沒有分類別股數；沒有時要從哪補。
  5. 每家公司 dei 股數最早出現的 filed 日期（XBRL 從哪年可用）。
  6. 成交金額：比較 Close×Volume（分割調整）與「原始價×原始量」：兩者在分割前後相同（價÷k、量×k），
     所以只差在 auto_adjust（除息調整）會讓價格被壓低。

用法：
  uv run python research/data_sources/s02_market_cap_xbrl.py
輸出：stdout；raw/s02_cap_checks.csv
"""
from __future__ import annotations

import pandas as pd
import yfinance as yf

from common import RAW, cik10, sec_json

CIK = {"NVDA": 1045810, "AAPL": 320193, "TSLA": 1318605, "MSFT": 789019, "GOOGL": 1652044,
       "BRK-B": 1067983, "META": 1326801, "JPM": 19617, "XOM": 34088, "MU": 723125, "AMZN": 1018724}

# 里程碑：(ticker, 日期, 報導的市值 USD, 依據)
MILESTONES = [
    ("AAPL", "2018-08-02", 1.00e12, "第一家收盤市值破 1 兆（2018-08-02）"),
    ("AAPL", "2022-01-03", 2.99e12, "盤中破 3 兆、收盤約 2.99 兆"),
    ("AAPL", "2023-06-30", 3.04e12, "第一次收盤破 3 兆"),
    ("NVDA", "2023-05-30", 1.00e12, "盤中破 1 兆"),
    ("NVDA", "2024-06-18", 3.34e12, "超越 MSFT 成為市值第一，約 3.34 兆"),
    ("NVDA", "2025-07-10", 4.0e12, "第一家收盤破 4 兆（約 2025-07-10）"),
    ("TSLA", "2021-10-25", 1.0e12, "收盤破 1 兆"),
    ("MSFT", "2019-04-25", 1.0e12, "盤中破 1 兆"),
    ("GOOGL", "2020-01-16", 1.0e12, "Alphabet 破 1 兆（兩類股合計）"),
    ("BRK-B", "2024-08-28", 1.0e12, "Berkshire 收盤破 1 兆（A＋B 合計）"),
    ("META", "2021-06-28", 1.0e12, "收盤破 1 兆"),
    ("AMZN", "2020-02-04", 1.0e12, "收盤破 1 兆（約 2020-02-04）"),
]

CONCEPTS = [("dei", "EntityCommonStockSharesOutstanding"),
            ("us-gaap", "CommonStockSharesOutstanding"),
            ("us-gaap", "WeightedAverageNumberOfSharesOutstandingBasic")]


def facts(cik: int) -> dict:
    return sec_json(f"https://data.sec.gov/api/xbrl/companyfacts/CIK{cik10(cik)}.json")


def share_series(cf: dict, taxonomy: str, concept: str) -> pd.DataFrame:
    node = cf["facts"].get(taxonomy, {}).get(concept)
    if not node:
        return pd.DataFrame()
    rows = node["units"].get("shares", [])
    df = pd.DataFrame(rows)
    if df.empty:
        return df
    df["end"] = pd.to_datetime(df["end"])
    df["filed"] = pd.to_datetime(df["filed"])
    return df


_px: dict[str, pd.DataFrame] = {}


def prices(tk: str):
    if tk not in _px:
        p = RAW / f"s02_yf_{tk}.pkl"
        if p.exists():
            _px[tk] = pd.read_pickle(p)
        else:
            t = yf.Ticker(tk)
            h = t.history(start="2008-01-01", auto_adjust=False, actions=True)
            h.index = h.index.tz_localize(None)
            h.to_pickle(p)
            _px[tk] = h
    return _px[tk]


def cap_on(tk: str, day: str, sh: pd.DataFrame) -> tuple[float, dict]:
    d = pd.Timestamp(day)
    h = prices(tk)
    known = sh[sh.filed <= d]
    if known.empty:
        return float("nan"), {}
    # 同一份申報可能有多個值（多類股會被 companyfacts 丟掉維度，見下）；取最新申報、end 最新
    last = known.sort_values(["filed", "end"]).iloc[-1]
    splits = h["Stock Splits"][h["Stock Splits"] > 0]
    cum = float(splits[splits.index > last["end"]].prod()) if len(splits) else 1.0
    px = h.loc[:d].iloc[-1]
    cap = px["Close"] * last["val"] * cum
    return cap, dict(shares=last["val"], share_end=last["end"].date(), filed=last["filed"].date(), form=last["form"],
                     split_cum_since=cum, close=round(px["Close"], 2))


def main():
    out = []
    first_dei = {}
    for tk, cik in CIK.items():
        cf = facts(cik)
        for tax, con in CONCEPTS:
            s = share_series(cf, tax, con)
            if not s.empty:
                first_dei.setdefault(tk, {})[con] = (s.filed.min().date(), len(s))
    print("[XBRL 股數最早 filed 日與筆數]")
    for tk, d in first_dei.items():
        print(f"  {tk:6}", {k: f"{v[0]} ({v[1]})" for k, v in d.items()})

    for tk, day, ref, why in MILESTONES:
        cf = facts(CIK[tk])
        for tax, con in CONCEPTS[:2]:
            sh = share_series(cf, tax, con)
            if sh.empty:
                out.append(dict(ticker=tk, day=day, concept=con, cap=None, ref=ref, err=None, note="無此概念"))
                continue
            cap, info = cap_on(tk, day, sh)
            out.append(dict(ticker=tk, day=day, concept=con, cap=cap, ref=ref, err=round(cap / ref - 1, 3), **info, why=why))
    df = pd.DataFrame(out)
    df.to_csv(RAW / "s02_cap_checks.csv", index=False)
    pd.set_option("display.width", 250)
    print("\n[市值里程碑比對]（err = 算出 / 報導 - 1）")
    print(df[["ticker", "day", "concept", "cap", "ref", "err", "shares", "share_end", "filed", "split_cum_since", "close"]]
          .to_string(index=False, float_format=lambda x: f"{x:,.3g}"))

    # 分割前後口徑：NVDA 2024-06-10 10:1 分割；看分割前申報的股數
    cf = facts(CIK["NVDA"])
    sh = share_series(cf, "dei", "EntityCommonStockSharesOutstanding")
    print("\n[NVDA dei 股數 2023-2025（看分割前後的口徑：申報值是當時股數，不回溯調整）]")
    print(sh[(sh.end >= "2023-01-01") & (sh.end <= "2025-12-31")][["end", "val", "filed", "form", "accn"]]
          .drop_duplicates().to_string(index=False))

    # 多類股：dei 股數在多類股公司是「按類別」申報（帶維度），companyfacts 不收帶維度的值
    for tk in ["GOOGL", "BRK-B", "META"]:
        cf = facts(CIK[tk])
        print(f"\n[{tk}] companyfacts 有的股數概念：")
        for tax, con in CONCEPTS:
            sh = share_series(cf, tax, con)
            if sh.empty:
                print(f"  {con}: 無")
            else:
                print(f"  {con}: {len(sh)} 筆，最後 filed {sh.filed.max().date()}，最後值 {sh.sort_values('filed').iloc[-1]['val']:,.0f}")
    # 備案：加權平均股數（EPS 用，跨類別合計；Berkshire 是「A 股約當股數」）
    for tk, px_tk, day, ref in [("META", "META", "2021-06-28", 1.0e12), ("BRK-B", "BRK-A", "2024-08-28", 1.0e12),
                                ("GOOGL", "GOOGL", "2020-01-16", 1.0e12)]:
        sh = share_series(facts(CIK[tk]), "us-gaap", "WeightedAverageNumberOfSharesOutstandingBasic")
        # 只取季度（約 90 天）期間，避免拿到年度加權
        sh = sh[(sh["end"] - pd.to_datetime(sh["start"])).dt.days.between(80, 100)] if "start" in sh else sh
        if sh.empty:
            print(f"  {tk}: 加權平均股數無季度值")
            continue
        cap, info = cap_on(px_tk, day, sh)
        print(f"[備案 加權平均股數×{px_tk}] {tk} {day}: {cap:,.3g} vs 報導 {ref:,.3g}，err {cap/ref-1:+.3f}；{info}")
        out.append(dict(ticker=tk, day=day, concept="WeightedAverageBasic×" + px_tk, cap=cap, ref=ref,
                        err=round(cap / ref - 1, 3), **info))
    pd.DataFrame(out).to_csv(RAW / "s02_cap_checks.csv", index=False)

    # 成交金額口徑
    h = prices("NVDA")
    adj = yf.Ticker("NVDA").history(start="2024-06-03", end="2024-06-14", auto_adjust=True)
    adj.index = adj.index.tz_localize(None)
    w = h.loc["2024-06-03":"2024-06-13", ["Close", "Adj Close", "Volume", "Stock Splits"]].copy()
    w["dv_close"] = w.Close * w.Volume
    w["dv_autoadj"] = adj["Close"] * adj["Volume"]
    print("\n[NVDA 分割前後成交金額（Close 已分割調整、量也已調整，乘積＝當天實際成交金額）]")
    print(w.to_string(float_format=lambda x: f"{x:,.4g}"))


if __name__ == "__main__":
    main()
