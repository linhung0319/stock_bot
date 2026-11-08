"""驗證 3a：SEC EDGAR submissions JSON、舊申報分頁、季度 index、全文搜尋。

做什麼：
  1. 抓幾家公司的 submissions JSON（含 filings.files 分頁的舊申報），統計：
     - 8-K 的 items 欄位每年有值的比例、最早有值的 8-K；
     - 最早一筆申報日期、分頁數；
  2. acceptanceDateTime 的時區：和申報索引頁（-index.htm）上的「Accepted」時間比對。
  3. full-index/ 季度 form.idx 的欄位（有沒有 items）。
  4. EDGAR 全文搜尋 efts.sec.gov：最早可查日期、回傳欄位有沒有 items、筆數上限。

用法：
  uv run python research/data_sources/s03_edgar_submissions.py
  （需要專案根目錄 .env 的 SEC_EDGAR_USER_AGENT；限速每秒 ≤ 4 次；結果快取在 raw/http_cache）
輸出：stdout；raw/s03_8k_items_by_year.csv
"""
from __future__ import annotations

import json
import re
from collections import Counter, defaultdict

import pandas as pd

from common import RAW, cik10, sec_get, sec_json

COMPANIES = {  # ticker: CIK
    "AAPL": 320193, "MSFT": 789019, "JPM": 19617, "XOM": 34088, "GE": 40545,
    "NVDA": 1045810, "MU": 723125, "KO": 21344, "C": 831001, "WMT": 104169,
}


def all_filings(cik: int) -> tuple[pd.DataFrame, dict]:
    sub = sec_json(f"https://data.sec.gov/submissions/CIK{cik10(cik)}.json")
    frames = [pd.DataFrame(sub["filings"]["recent"])]
    for f in sub["filings"].get("files", []):
        page = sec_json(f"https://data.sec.gov/submissions/{f['name']}")
        frames.append(pd.DataFrame(page))
    df = pd.concat(frames, ignore_index=True)
    df["filingDate"] = pd.to_datetime(df["filingDate"])
    return df, sub


def main():
    rows = []
    summary = []
    for tk, cik in COMPANIES.items():
        df, sub = all_filings(cik)
        n_pages = len(sub["filings"].get("files", []))
        k8 = df[df["form"].isin(["8-K", "8-K/A"])].copy()
        k8["has_items"] = k8["items"].fillna("").str.len() > 0
        first_items = k8[k8.has_items]["filingDate"].min()
        first_8k = k8["filingDate"].min()
        summary.append(dict(ticker=tk, filings=len(df), pages=n_pages, first_filing=df["filingDate"].min().date(),
                            n_8k=len(k8), first_8k=first_8k.date() if pd.notna(first_8k) else None,
                            first_8k_with_items=first_items.date() if pd.notna(first_items) else None,
                            recent_count=len(sub["filings"]["recent"]["form"]),
                            tickers_now=",".join(sub.get("tickers", [])),
                            former_names=len(sub.get("formerNames", []))))
        for y, g in k8.groupby(k8.filingDate.dt.year):
            rows.append(dict(ticker=tk, year=y, n_8k=len(g), with_items=int(g.has_items.sum())))
        # 舊格式 items 長什麼樣（2004-08 以前 8-K 是 Item 1～12 的舊編號）
        newstyle = k8[k8["items"].fillna("").str.contains(r"\d\.\d\d")]["filingDate"].min()
        oldstyle_last = k8[k8.has_items & ~k8["items"].fillna("").str.contains(r"\d\.\d\d")]["filingDate"].max()
        print(f"{tk}: 第一筆新式 items（x.xx）{newstyle.date()}；最後一筆舊式 items {oldstyle_last.date() if pd.notna(oldstyle_last) else None}")
        early = k8[k8.has_items].sort_values("filingDate").head(3)[["filingDate", "form", "items"]]
        print(f"{tk}: 最早有 items 的 8-K\n{early.to_string(index=False)}")
    s = pd.DataFrame(summary)
    print("\n[submissions 摘要]")
    print(s.to_string(index=False))
    by = pd.DataFrame(rows)
    by.to_csv(RAW / "s03_8k_items_by_year.csv", index=False)
    agg = by.groupby("year")[["n_8k", "with_items"]].sum()
    agg["share"] = (agg.with_items / agg.n_8k).round(3)
    print("\n[10 家合計] 每年 8-K 數與 items 有值比例")
    print(agg.loc[1996:].to_string())

    # ---------- items 的值分布（2005 起）
    df, _ = all_filings(COMPANIES["AAPL"])
    c = Counter()
    for tk, cik in COMPANIES.items():
        d, _ = all_filings(cik)
        for it in d[d.form == "8-K"]["items"].dropna():
            for x in str(it).split(","):
                if x:
                    c[x] += 1
    print("\n[items 值的種類，前 25]", c.most_common(25))

    # ---------- 2. acceptanceDateTime 時區
    print("\n[acceptanceDateTime 時區] JSON 值 vs 索引頁 Accepted")
    for tk in ["AAPL", "NVDA", "MU"]:
        d, _ = all_filings(COMPANIES[tk])
        recent = d[d.form.isin(["10-K", "10-Q", "8-K"])].head(3)
        for _, r in recent.iterrows():
            acc = r["accessionNumber"]
            url = f"https://www.sec.gov/Archives/edgar/data/{COMPANIES[tk]}/{acc.replace('-', '')}/{acc}-index.htm"
            st, html, _ = sec_get(url)
            m = re.search(r"Accepted</div>\s*<div class=\"info\">([^<]+)<", html) if st == 200 else None
            print(f"  {tk} {r['form']:5} JSON={r['acceptanceDateTime']}  索引頁={m.group(1) if m else st}")
    # 盤後申報比例
    allacc = []
    for tk, cik in COMPANIES.items():
        d, _ = all_filings(cik)
        d = d[d.form.isin(["8-K", "10-K", "10-Q"]) & (d.filingDate >= "2015-01-01")]
        # JSON 的 "Z" 是真的 UTC（和索引頁的美東時間差 4／5 小時，見上），換成美東
        t = pd.to_datetime(d["acceptanceDateTime"], utc=True).dt.tz_convert("America/New_York").dt.tz_localize(None)
        allacc.append(pd.DataFrame({"form": d.form.values, "t": t.values, "filingDate": d.filingDate.values}))
    a = pd.concat(allacc)
    hhmm = a.t.dt.hour * 100 + a.t.dt.minute
    a["bucket"] = pd.cut(hhmm, [-1, 929, 1559, 1729, 2400], labels=["盤前(<9:30)", "盤中", "盤後 16:00–17:30", "17:30 以後"])
    a["accept_date_ne_filing_date"] = a.t.dt.normalize() != a.filingDate
    print("\n[2015 起 8-K/10-K/10-Q 的接收時段（美東）]")
    print(a.groupby(["form", "bucket"], observed=False).size().unstack().to_string())
    print(f"  接收日 ≠ filingDate 的筆數：{int(a.accept_date_ne_filing_date.sum())} / {len(a)}")
    print("  例：", a[a.accept_date_ne_filing_date].head(5).to_dict("records"))

    # ---------- 3. full-index
    for q in ["2003/QTR1", "2005/QTR1", "2026/QTR3"]:
        st, txt, _ = sec_get(f"https://www.sec.gov/Archives/edgar/full-index/{q}/form.idx")
        lines = txt.splitlines() if st == 200 else []
        hdr = next((i for i, l in enumerate(lines) if l.startswith("Form Type")), None)
        n8 = sum(1 for l in lines if l.startswith("8-K "))
        print(f"\n[full-index {q}] status {st}，{len(lines)} 行，8-K {n8} 筆；欄位：{lines[hdr].split() if hdr is not None else None}")
        if hdr is not None:
            print("  範例：", lines[hdr + 2][:140])

    # ---------- 4. EFTS 全文搜尋
    for qs in ["q=%22non-reliance%22&forms=8-K&dateRange=custom&startdt=2001-01-01&enddt=2001-12-31",
               "q=%22restatement%22&forms=8-K&dateRange=custom&startdt=2000-01-01&enddt=2000-12-31",
               "q=%22Item%204.02%22&forms=8-K&dateRange=custom&startdt=2010-01-01&enddt=2010-12-31"]:
        st, body, _ = sec_get(f"https://efts.sec.gov/LATEST/search-index?{qs}")
        if st != 200:
            print(f"[efts] {qs} → {st}")
            continue
        j = json.loads(body)
        hits = j.get("hits", {})
        tot = hits.get("total", {})
        src = hits.get("hits", [{}])[0].get("_source", {}) if hits.get("hits") else {}
        print(f"\n[efts] {qs}\n  total={tot}；每頁 {len(hits.get('hits', []))} 筆；_source 欄位={sorted(src.keys())}")
        if src:
            print("  第一筆：", {k: src.get(k) for k in ["file_date", "form", "items", "ciks", "display_names", "adsh"]})


if __name__ == "__main__":
    main()
