"""給 B-9：補 b9_sp500_cik_map.csv 的前身 CIK（人工核對用的查詢工具）。

做什麼：
  對每個代號，用幾個公司名稱查 EDGAR 實體搜尋（efts keysTyped），列出候選 CIK 的
  submissions 名稱、前名、最早／最晚申報、10-K/10-Q 數量，以及 2009 年以後在指數內的區段（fja05680），
  讓人判斷每一段期間該用哪個 CIK。判斷結果寫進 s08_cik_map_and_scan.py 的 MANUAL 表。

用法：
  uv run python research/data_sources/s09_predecessor_lookup.py [TICKER ...]
輸出：stdout；raw/s09_candidates.csv
"""
from __future__ import annotations

import csv
import json
import sys
from urllib.parse import quote

import pandas as pd

from common import RAW, sec_get
from s08_cik_map_and_scan import sub_info

SEARCH = {
    "APA": ["Apache Corp"], "ARNC": ["Arconic Inc", "Alcoa Inc", "Howmet Aerospace"], "BG": ["Bunge Ltd", "Bunge Limited"],
    "BMS": ["Bemis Co"], "CCE": ["Coca-Cola Enterprises"], "DELL": ["Dell Inc"],
    "DISCA": ["Discovery Communications", "Discovery Inc", "Warner Bros Discovery"], "DOW": ["Dow Chemical"],
    "DXC": ["Computer Sciences Corp"], "ETN": ["Eaton Corp"], "FOX": ["Twenty-First Century Fox", "News Corp"],
    "FOXA": ["Twenty-First Century Fox", "News Corp"], "FTI": ["FMC Technologies"], "GGP": ["General Growth Properties"],
    "HLT": ["Hilton Worldwide"], "IR": ["Ingersoll-Rand", "Gardner Denver"], "LO": ["Lorillard"],
    "MYL": ["Mylan Inc", "Mylan N.V.", "Mylan"], "NE": ["Noble Corp"], "Q": ["Qwest Communications", "IQVIA", "Qnity"],
    "SUN": ["Sunoco Inc", "Sunoco"], "TT": ["Trane Technologies", "Ingersoll-Rand plc"], "TWX": ["Time Warner Inc"],
    "WBA": ["Walgreen Co", "Walgreens Boots Alliance"], "WFT": ["Weatherford International"],
    "WIN": ["Windstream Corp", "Windstream Holdings"], "WLTW": ["Willis Towers Watson", "Willis Group Holdings"],
    "WRK": ["WestRock", "Rock-Tenn", "MeadWestvaco"],
    "NLSN": ["Nielsen Holdings", "Nielsen N.V."], "SNDK": ["SanDisk", "Sandisk Corp"], "BHGE": ["Baker Hughes"],
    "AVGO": ["Avago Technologies", "Broadcom Ltd", "Broadcom Corp"], "CEG": ["Constellation Energy"],
    "COV": ["Covidien"], "KMI": ["Kinder Morgan"], "ICE": ["Intercontinental Exchange"], "PRGO": ["Perrigo"],
    "RDC": ["Rowan Companies"], "CBE": ["Cooper Industries"], "DTV": ["DIRECTV"], "ESRX": ["Express Scripts"],
    "FRX": ["Forest Laboratories"], "AGN": ["Allergan"], "CI": ["Cigna"], "MDT": ["Medtronic"], "WFM": ["Whole Foods Market"],
    "XRX": ["Xerox"],
}


def segments(t: str):
    rows = list(csv.DictReader(open(RAW / "s01_fja_now.csv", encoding="utf-8")))
    seg, prev, start = [], False, None
    for r in rows:
        now = t in r["tickers"].split(",")
        if now and not prev:
            start = r["date"]
        if prev and not now:
            seg.append((start, r["date"]))
        prev = now
    if prev:
        seg.append((start, "now"))
    return [s for s in seg if s[1] == "now" or s[1] >= "2009-01-01"]


def main():
    ticks = sys.argv[1:] or list(SEARCH)
    out = []
    for t in ticks:
        print(f"\n### {t} 指數區段 {segments(t)}")
        seen = set()
        for q in SEARCH.get(t, [t]):
            st, b, _ = sec_get("https://efts.sec.gov/LATEST/search-index?keysTyped=" + quote(q))
            if st != 200:
                continue
            for h in json.loads(b)["hits"]["hits"][:8]:
                c = int(h["_id"])
                if c in seen:
                    continue
                seen.add(c)
                inf = sub_info(c)
                if not inf or not inf["n_10k"]:
                    continue
                fn = "; ".join(f"{f['name']}({f.get('from', '')[:10]}–{f.get('to', '')[:10]})" for f in inf["formerNames"][:3])
                print(f"  {c:>8} {inf['name'][:45]:45} {inf['earliest']}→{inf['latest']} 10K/Q {inf['n_10k']:>3} 前名 {fn[:120]}")
                out.append(dict(ticker=t, cik=c, name=inf["name"], earliest=inf["earliest"], latest=inf["latest"],
                                n_10k_recent=inf["n_10k"], former=fn))
    pd.DataFrame(out).to_csv(RAW / "s09_candidates.csv", index=False)


if __name__ == "__main__":
    main()
