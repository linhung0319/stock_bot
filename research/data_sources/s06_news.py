"""驗證 5：新聞來源（F18 每日掃描、F25 事件條件）。

做什麼：
  1. Alpha Vantage NEWS_SENTIMENT（免費 key）：是否可用。（每天 25 次額度，只打 1 次，結果快取。）
  2. Google News RSS（搜尋）：各公司近 7 天筆數、欄位、有沒有原文、連結是不是導向原站。
  3. SEC 新聞稿、訴訟公告 RSS。
  4. 公司 IR 的 RSS（常見的 Q4／GlobeNewswire 路徑）。
  5. EDGAR 8-K 附件 EX-99.1（新聞稿原文）：最近一次 8-K 2.02 的全文長度；
     acceptanceDateTime 和新聞稿時間比（延遲）。
  6. EDGAR 即時 Atom（getcurrent）與每家公司的 Atom。
  7. GDELT DOC 2.0：能不能查 2020 年的文章（回溯範圍）。
  8. Nasdaq 個股 RSS、yfinance Ticker.news。

用法：
  uv run python research/data_sources/s06_news.py
輸出：stdout；raw/s06_news_coverage.csv
"""
from __future__ import annotations

import json
import re
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime

import pandas as pd

from common import RAW, cik10, env, get, redact, sec_get, sec_json

BROWSER = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36"}
COS = {  # ticker: (查詢字, CIK, IR RSS 候選)
    "MU": ("Micron Technology", 723125, ["https://investors.micron.com/rss/news-releases.xml"]),
    "NVDA": ("Nvidia", 1045810, ["https://nvidianews.nvidia.com/releases.xml", "https://investor.nvidia.com/rss/news-releases.xml"]),
    "MSFT": ("Microsoft", 789019, ["https://news.microsoft.com/feed/"]),
    "META": ("Meta Platforms", 1326801, ["https://investor.atmeta.com/rss/news-releases.xml", "https://about.fb.com/feed/"]),
    "LSTR": ("Landstar System", 853816, ["https://investor.landstar.com/rss/news-releases.xml"]),
    "EXP": ("Eagle Materials", 918646, ["https://ir.eaglematerials.com/rss/news-releases.xml"]),
    "CELH": ("Celsius Holdings", 1341766, ["https://ir.celsiusholdingsinc.com/rss/news-releases.xml"]),
}


def rss_items(text: str):
    try:
        root = ET.fromstring(text.encode("utf-8") if isinstance(text, str) else text)
    except ET.ParseError:
        return None
    items = root.findall(".//item")
    if not items:  # Atom
        ns = {"a": "http://www.w3.org/2005/Atom"}
        items = root.findall(".//a:entry", ns)
        return [dict(title=(e.findtext("a:title", namespaces=ns) or "").strip(),
                     date=e.findtext("a:updated", namespaces=ns),
                     link=(e.find("a:link", ns).get("href") if e.find("a:link", ns) is not None else None),
                     desc_len=len(e.findtext("a:summary", namespaces=ns) or "")) for e in items]
    return [dict(title=(i.findtext("title") or "").strip(), date=i.findtext("pubDate"), link=i.findtext("link"),
                 desc_len=len(i.findtext("description") or ""), source=i.findtext("source")) for i in items]


def main():
    out = []
    # 1. Alpha Vantage
    k = env("ALPHA_VANTAGE_API_KEY")
    st, b, meta = get(f"https://www.alphavantage.co/query?function=NEWS_SENTIMENT&tickers=MU&sort=EARLIEST"
                      f"&time_from=20100101T0000&limit=1000&apikey={k}")
    j = json.loads(b)
    print("[Alpha Vantage NEWS_SENTIMENT]", redact(j.get("Information") or j.get("Note") or f"feed {len(j.get('feed', []))}"),
          "（抓取", meta["fetched_at"], "）")

    # 2. Google News RSS
    now = datetime.now(timezone.utc)
    for tk, (q, cik, irs) in COS.items():
        url = f"https://news.google.com/rss/search?q=%22{q.replace(' ', '+')}%22+when:7d&hl=en-US&gl=US&ceid=US:en"
        st, txt, meta = get(url, headers=BROWSER)
        it = rss_items(txt) if st == 200 else None
        if it:
            ages = [(now - parsedate_to_datetime(i["date"])).total_seconds() / 3600 for i in it if i["date"]]
            srcs = pd.Series([i.get("source") for i in it]).value_counts().head(5).to_dict()
            out.append(dict(source="google_news", ticker=tk, status=st, n=len(it), newest_age_h=round(min(ages), 1),
                            link_example=it[0]["link"][:80], desc_len_max=max(i["desc_len"] for i in it), top_sources=srcs))
        else:
            out.append(dict(source="google_news", ticker=tk, status=st, n=0))
        # 4. IR RSS
        for u in irs:
            st, txt, meta = get(u, headers=BROWSER)
            it = rss_items(txt) if st == 200 else None
            out.append(dict(source="ir_rss", ticker=tk, url=u, status=st, n=len(it) if it else 0,
                            newest=(it[0]["date"] if it else None), title0=(it[0]["title"][:70] if it else None),
                            desc_len_max=(max(i["desc_len"] for i in it) if it else None)))
        # 8. Nasdaq RSS
        st, txt, meta = get(f"https://www.nasdaq.com/feed/rssoutbound?symbol={tk}", headers=BROWSER, timeout=20)
        it = rss_items(txt) if st == 200 else None
        out.append(dict(source="nasdaq_rss", ticker=tk, status=st, n=len(it) if it else 0,
                        newest=(it[0]["date"] if it else None)))
    df = pd.DataFrame(out)
    df.to_csv(RAW / "s06_news_coverage.csv", index=False)
    pd.set_option("display.width", 250, "display.max_colwidth", 80)
    print(df.to_string(index=False))

    # Google News 連結能不能直接拿到原文
    st, txt, _ = get("https://news.google.com/rss/search?q=%22Micron+Technology%22+when:7d&hl=en-US&gl=US&ceid=US:en", headers=BROWSER)
    it = rss_items(txt) or []
    if it:
        st2, page, _ = get(it[0]["link"], headers=BROWSER)
        print(f"\n[Google News 連結] {it[0]['link'][:90]}… → status {st2}，回傳 {len(page)} 字元；"
              f"是否含原站 canonical：{'canonical' in page[:20000]}")
        print("  description 範例：", re.sub("<[^>]+>", "", txt[txt.find("<description>"):txt.find("</description>")])[:200])

    # 3. SEC RSS
    for u in ["https://www.sec.gov/news/pressreleases.rss", "https://www.sec.gov/enforcement-litigation/litigation-releases/rss",
              "https://www.sec.gov/rss/litigation/litreleases.xml"]:
        st, txt, _ = sec_get(u)
        it = rss_items(txt) if st == 200 else None
        print(f"\n[SEC RSS] {u} → {st}，{len(it) if it else 0} 筆；"
              f"{(it[0]['date'], it[-1]['date'], it[0]['title'][:80]) if it else txt[:120]}")

    # 5. EDGAR 8-K 2.02 的 EX-99.1
    print("\n[EDGAR 8-K 2.02 附件 EX-99.1]")
    for tk in ["MU", "NVDA", "MSFT", "META", "LSTR"]:
        cik = COS[tk][1]
        sub = sec_json(f"https://data.sec.gov/submissions/CIK{cik10(cik)}.json")
        r = pd.DataFrame(sub["filings"]["recent"])
        e = r[(r.form == "8-K") & r["items"].str.contains("2.02")].iloc[0]
        acc = e.accessionNumber.replace("-", "")
        st, idx, _ = sec_get(f"https://www.sec.gov/Archives/edgar/data/{cik}/{acc}/index.json")
        files = json.loads(idx)["directory"]["item"] if st == 200 else []
        # 附件類型以索引頁的 Type 欄為準（檔名沒有固定規則，例如 NVDA 用 q2fy27pr.htm）
        st, ihtml, _ = sec_get(f"https://www.sec.gov/Archives/edgar/data/{cik}/{acc}/{e.accessionNumber}-index.htm")
        ex = [re.search(r'href="[^"]*/([^"/]+)"', row).group(1) for row in ihtml.split("<tr")[1:]
              if re.search(r">EX-99\.0?1<", row) and 'href="' in row] if st == 200 else []
        txtlen, dateline = None, None
        if ex:
            st, html, _ = sec_get(f"https://www.sec.gov/Archives/edgar/data/{cik}/{acc}/{ex[0]}")
            plain = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", html))
            txtlen = len(plain)
            m = re.search(r"([A-Z][A-Za-z\.]+(?:, [A-Za-z\.]+)?)[^A-Za-z]{0,5}[–-]{1,2}\s*\(?(?:BUSINESS WIRE|GLOBE NEWSWIRE|PR Newswire)?\)?.{0,40}?"
                          r"((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.? \d{1,2}, 20\d\d)", plain)
            dateline = m.group(0)[:90] if m else plain[:120]
        acc_et = pd.Timestamp(e.acceptanceDateTime).tz_convert("America/New_York")
        print(f"  {tk}: 8-K {e.filingDate} items {e['items']} 接收 {acc_et:%Y-%m-%d %H:%M} ET；附件 {ex[:2]}；"
              f"純文字 {txtlen} 字元；開頭：{dateline}")

    # 6. EDGAR Atom
    for u in ["https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=8-K&count=40&output=atom",
              "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0000723125&type=8-K&count=10&output=atom"]:
        st, txt, meta = sec_get(u, refresh=True)
        it = rss_items(txt) if st == 200 else None
        if it:
            newest = pd.Timestamp(it[0]["date"])
            print(f"\n[EDGAR Atom] {u[:90]} → {len(it)} 筆，最新 {it[0]['date']}（抓取 {meta['fetched_at']}，"
                  f"差 {(pd.Timestamp.now(tz='UTC') - newest).total_seconds()/60:.0f} 分）；{it[0]['title'][:80]}")
        else:
            print(f"\n[EDGAR Atom] {u} → {st}")

    # 5b. Google News 的歷史查詢（after:/before:）與延遲：MU 2026-09-30 16:02 ET 的財報 8-K
    for a, bdate in [("2026-09-30", "2026-10-01"), ("2020-03-16", "2020-03-17"), ("2015-06-25", "2015-06-26")]:
        u = f"https://news.google.com/rss/search?q=%22Micron%22+after:{a}+before:{bdate}&hl=en-US&gl=US&ceid=US:en"
        st, txt, _ = get(u, headers=BROWSER)
        it = rss_items(txt) or []
        ds = sorted(parsedate_to_datetime(i["date"]) for i in it if i["date"])
        print(f"\n[Google News 歷史] {a}～{bdate}: {len(it)} 筆；最早 {ds[0] if ds else None}；最晚 {ds[-1] if ds else None}")
        if a == "2026-09-30":
            hits = [(parsedate_to_datetime(i['date']).astimezone(timezone.utc), i['title'][:80]) for i in it
                    if re.search(r"(fourth|Q4|quarter|results|earnings)", i["title"], re.I)]
            for h in sorted(hits)[:5]:
                print("   ", h[0].strftime("%Y-%m-%d %H:%M UTC"), h[1])
    st, robots, _ = get("https://news.google.com/robots.txt", headers=BROWSER)
    print("\n[news.google.com robots.txt 與 /rss 有關的行]", [l for l in robots.splitlines() if "rss" in l.lower() or l.startswith("User-agent: *")][:8])
    # Nasdaq RSS 內容長度
    st, txt, _ = get("https://www.nasdaq.com/feed/rssoutbound?symbol=MU", headers=BROWSER, timeout=20)
    it = rss_items(txt) or []
    print(f"[Nasdaq RSS] MU {len(it)} 筆；description 最長 {max((i['desc_len'] for i in it), default=0)} 字元；例 {it[0]['title'][:70] if it else ''} {it[0]['link'][:80] if it else ''}")

    # 7. GDELT
    time.sleep(12)
    for rng in [("20200302000000", "20200306000000"), ("20250901000000", "20250905000000"), ("20261101000000", "20261106000000")]:
        u = (f"https://api.gdeltproject.org/api/v2/doc/doc?query=%22Micron%20Technology%22&mode=artlist&format=json"
             f"&maxrecords=50&startdatetime={rng[0]}&enddatetime={rng[1]}")
        st, txt, _ = get(u, headers=BROWSER, timeout=40)
        try:
            arts = json.loads(txt).get("articles", [])
            print(f"\n[GDELT] {rng[0][:8]}–{rng[1][:8]}: status {st}，{len(arts)} 篇；例 {arts[0]['title'][:70] if arts else ''}"
                  f" {arts[0].get('seendate') if arts else ''}")
        except Exception:
            print(f"\n[GDELT] {rng}: status {st}，非 JSON：{txt[:150]}")
        time.sleep(12)

    # yfinance news
    import yfinance as yf
    n = yf.Ticker("MU").news
    print(f"\n[yfinance Ticker.news] MU {len(n)} 筆；欄位 {list(n[0].keys()) if n else None}；"
          f"內容欄位 {list(n[0].get('content', {}).keys())[:15] if n else None}")


if __name__ == "__main__":
    main()
