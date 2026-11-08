"""給 B-9：S&P 500 歷史成分股（2009 起）ticker → CIK 對照表，以及 EDGAR 硬事件申報掃描。

做什麼：
  階段 map：
    1. 從 fja05680 名單取出 2009-01-01 以後出現過的所有代號，記錄每個代號在指數內的第一天與最後一天。
    2. 先用 SEC company_tickers.json（只有現存代號）對應 CIK。
    3. 對不到的：用 Wikipedia 異動表的公司名稱（剔除／加入那一列）查 EDGAR 實體搜尋
       （efts.sec.gov/LATEST/search-index?keysTyped=名稱），候選 CIK 再用 submissions 檢查
       「在指數期間內有沒有 10-K／10-Q」，選有的那一個。
    4. 所有對到的 CIK 都檢查：最早申報日 ≤ 加入指數日（否則可能是代號被別家公司重用）。
  階段 scan：
    對每個 CIK 抓 submissions（含 filingTo ≥ 2009 的分頁），篩出 B-9 需要的申報：
    8-K／8-K/A 的 items 含 4.01、4.02（另記 1.01、1.03、2.03、3.02）；NT 10-K／NT 10-Q；
    PREM14A／DEFM14A／SC TO-T／SC 14D9（含 /A）；S-3／S-3ASR；424B1～424B8。

用法：
  uv run python research/data_sources/s08_cik_map_and_scan.py map
  uv run python research/data_sources/s08_cik_map_and_scan.py scan
  （SEC 限速每秒 ≤ 4 次；所有回應快取在 raw/http_cache，重跑不重抓）
輸出：
  raw/b9_sp500_cik_map.csv       ticker, cik, name, first_in, last_in, method, flag
  raw/b9_unmapped.csv            對不到的代號
  raw/b9_edgar_events.csv        cik, ticker, form, items, filingDate, acceptanceDateTime, accessionNumber, primaryDocument
  raw/b9_scan_stats.json         請求數、各類申報筆數
"""
from __future__ import annotations

import csv
import json
import re
import sys
from collections import Counter
from difflib import SequenceMatcher
from urllib.parse import quote

import pandas as pd

from common import RAW, cik10, sec_get, sec_json

START = "2009-01-01"
REQ = Counter()


def sj(url):
    REQ["sec"] += 1
    return sec_json(url)


def membership():
    rows = list(csv.DictReader(open(RAW / "s01_fja_now.csv", encoding="utf-8")))
    first, last = {}, {}
    for r in rows:
        d = r["date"]
        for t in r["tickers"].split(","):
            t = t.strip().upper()
            if not t:
                continue
            first.setdefault(t, d)
            last[t] = d
    end = rows[-1]["date"]
    return {t: (first[t], last[t]) for t in first if last[t] >= START}, end


def norm(name: str) -> str:
    n = str(name).lower()
    n = re.sub(r"\([^)]*\)", " ", n)  # 去掉「(DIS)」之類的代號
    n = re.sub(r"[.,&'/]", " ", n)
    n = re.sub(r"\b(inc|corp|corporation|co|company|ltd|plc|llc|nv|sa|bv|the|holdings?|group|incorporated"
               r"|class [ab]|de|ca|ny)\b", " ", n)
    return re.sub(r"\s+", " ", n).strip()


def sub_info(cik: int):
    j = sj(f"https://data.sec.gov/submissions/CIK{cik10(cik)}.json")
    if not j:
        return None
    rec = j["filings"]["recent"]
    dates = rec["filingDate"]
    forms = rec["form"]
    earliest = min([f["filingFrom"] for f in j["filings"].get("files", [])] + (dates[-1:] if dates else ["9999"]))
    latest = dates[0] if dates else None
    return dict(name=j.get("name"), tickers=j.get("tickers", []), earliest=earliest, latest=latest,
                n_10k=sum(1 for f in forms if f in ("10-K", "10-Q", "10-K405")), sic=j.get("sic"),
                files=j["filings"].get("files", []), formerNames=j.get("formerNames", []))


def wiki_names():
    w = pd.read_csv(RAW / "s01_wiki_changes.csv")
    names = {}
    for _, r in w.iterrows():
        for tcol, ncol in (("rem_ticker", "rem_name"), ("add_ticker", "add_name")):
            t, n = str(r[tcol]).upper(), r[ncol]
            if t != "NAN" and isinstance(n, str):
                names.setdefault(t, n)
    return names


def do_map():
    mem, end = membership()
    st, body, _ = sec_get("https://www.sec.gov/files/company_tickers.json")
    REQ["sec"] += 1
    ct = {v["ticker"].upper(): (v["cik_str"], v["title"]) for v in json.loads(body).values()}
    wn = wiki_names()
    out, unm = [], []
    for t, (fi, la) in sorted(mem.items()):
        key = t.replace(".", "-")
        cand = []
        method = None
        if key in ct:
            cand = [ct[key][0]]
            method = "company_tickers"
        else:
            base = t[:-1] if t.endswith("Q") and len(t) >= 4 else t
            name = wn.get(t) or wn.get(base)
            if name:
                st, b, _ = sec_get("https://efts.sec.gov/LATEST/search-index?keysTyped=" + quote(name))
                REQ["sec"] += 1
                if st == 200:
                    hits = json.loads(b)["hits"]["hits"][:6]
                    scored = sorted(((SequenceMatcher(None, norm(name), norm(h["_source"]["entity"])).ratio(), int(h["_id"]))
                                     for h in hits), reverse=True)
                    cand = [c for s, c in scored if s >= 0.6][:3]
                method = f"wiki_name:{name}"
        chosen, info = None, None
        for c in cand:
            inf = sub_info(c)
            if not inf:
                continue
            # 指數期間內要有申報：最早申報 ≤ 最後在指數日，最新申報 ≥ 加入日
            if inf["n_10k"] or inf["earliest"] <= la:
                if inf["earliest"] <= la and (inf["latest"] or "") >= fi:
                    chosen, info = c, inf
                    break
        if chosen is None:
            unm.append(dict(ticker=t, first_in=fi, last_in=la, method=method, candidates=";".join(map(str, cand))))
            continue
        flag = ""
        if info["earliest"] > fi:
            flag = f"最早申報 {info['earliest']} 晚於加入日：可能代號重用或公司改組"
        out.append(dict(ticker=t, cik=chosen, name=info["name"], first_in=fi, last_in=la,
                        still_member=(la == end), method=method, sec_tickers_now=",".join(info["tickers"]),
                        earliest_filing=info["earliest"], flag=flag))
    pd.DataFrame(out).to_csv(RAW / "b9_sp500_cik_map.csv", index=False)
    pd.DataFrame(unm).to_csv(RAW / "b9_unmapped.csv", index=False)
    print(f"代號 {len(mem)}；對到 {len(out)}（company_tickers {sum(1 for o in out if o['method']=='company_tickers')}，"
          f"名稱搜尋 {sum(1 for o in out if o['method']!='company_tickers')}）；對不到 {len(unm)}；"
          f"有旗標 {sum(1 for o in out if o['flag'])}；SEC 請求 {REQ['sec']}")


# 人工核對（2026-11-08，s09_predecessor_lookup.py 查候選、submissions 核對名稱、前名與申報期間）：
# 這些代號的所有列以下表為準（每段 = 這個代號在指數內、由這個 CIK 申報的期間）。
# 轉換日：控股公司改組／合併完成的生效日（記憶＋後繼 CIK 最早申報日佐證），誤差可能有幾天。
# 「無前身」的代號只有一段，note 寫原因。
MANUAL_SEGMENTS = {
    "APA": [(6769, "2009-01-01", "2021-03-01", "Apache Corp"), (1841666, "2021-03-01", None, "APA Corp 控股改組")],
    "ARNC": [(4281, "2009-01-01", "2020-04-06", "Alcoa Inc → Arconic Inc（同一 CIK，今 Howmet）；2020 分拆的 Arconic Corp 不在指數")],
    "BG": [(1144519, "2023-03-15", "2023-11-01", "Bunge Ltd"), (1996862, "2023-11-01", None, "Bunge Global SA 遷冊瑞士")],
    "BMS": [(11199, "2009-01-01", "2014-12-05", "Bemis Co Inc（今 Amcor Flexibles NA）；1491863 是沒有 10-K 的關係企業")],
    "CCE": [(804055, "2009-01-01", "2010-10-01", "舊 Coca-Cola Enterprises（北美業務賣給 KO）"),
            (1491675, "2010-10-01", "2016-05-31", "新 Coca-Cola Enterprises（今 CCEP US）")],
    "DELL": [(826083, "2009-01-01", "2013-10-29", "Dell Inc（2013 私有化）"), (1571996, "2024-09-23", None, "Dell Technologies 重新加入")],
    "DISCA": [(1437107, "2010-03-01", "2022-04-11", "Discovery Communications／Discovery Inc（今 WBD）；1601040 是無 10-K 子公司")],
    "DOW": [(29915, "2009-01-01", "2017-09-01", "Dow Chemical（DWDP 合併前）"), (1751788, "2019-04-02", None, "Dow Inc 分拆")],
    "DXC": [(23082, "2009-01-01", "2015-12-01", "Computer Sciences Corp"), (1688568, "2017-04-04", "2023-10-02", "DXC Technology")],
    "ETN": [(31277, "2009-01-01", "2012-11-30", "Eaton Corp（Cooper 合併前）"), (1551182, "2012-11-30", None, "Eaton Corp plc")],
    "FOX": [(1308161, "2015-09-21", "2019-03-19", "Twenty-First Century Fox"), (1754301, "2019-03-19", None, "Fox Corp 分拆")],
    "FOXA": [(1308161, "2009-01-01", "2019-03-19", "News Corp → Twenty-First Century Fox（同一 CIK）"),
             (1754301, "2019-03-19", None, "Fox Corp 分拆")],
    "FTI": [(1135152, "2009-06-05", "2017-01-17", "FMC Technologies"), (1681459, "2017-01-17", "2021-02-12", "TechnipFMC")],
    "GGP": [(1496048, "2013-12-10", "2018-08-28", "無前身：2009–2013-12 不在指數；2013 重新加入時已是新 GGP（2010 破產重整後的 CIK）")],
    "HLT": [(1585689, "2017-06-19", None, "無前身：Hilton 2007 私有化，2017 才重新加入")],
    "IR": [(1160497, "2009-01-01", "2009-07-01", "Ingersoll-Rand Co Ltd（百慕達）"),
           (1466258, "2010-11-17", "2020-03-02", "Ingersoll-Rand plc（2020 改名 Trane，代號改 TT）"),
           (1699150, "2020-03-02", None, "Ingersoll Rand Inc（原 Gardner Denver）")],
    "LO": [(1424847, "2009-01-01", "2015-06-12", "Lorillard Inc；862178 是無 10-K 的子公司")],
    "MYL": [(69499, "2009-01-01", "2015-02-27", "Mylan Inc"), (1623613, "2015-02-27", "2020-11-17", "Mylan N.V.")],
    "NE": [(1169055, "2009-01-01", "2009-03-27", "Noble Corp（開曼，今 Noble Finance）"),
           (1458891, "2011-01-18", "2015-07-20", "Noble Corp（瑞士／英國）")],
    "Q": [(1037949, "2009-01-01", "2011-04-01", "Qwest（被 CenturyLink 收購）"), (2058873, "2025-11-03", None, "Qnity 分拆；IQVIA 不是這個代號")],
    "SUN": [(95304, "2009-01-01", "2012-10-05", "Sunoco Inc；Sunoco LP 是另一家")],
    "TT": [(1466258, "2020-03-03", None, "無前身：TT 代號 2020 起；之前同一 CIK 用 IR 代號（見 IR）")],
    "TWX": [(1105705, "2009-01-01", "2018-06-15", "Time Warner Inc（今 Warner Media LLC）；1463870 是無 10-K 子公司")],
    "WBA": [(104207, "2009-01-01", "2014-12-31", "Walgreen Co"), (1618921, "2014-12-31", "2025-08-28", "Walgreens Boots Alliance")],
    "WFT": [(1170565, "2009-01-01", "2009-02-26", "Weatherford International Ltd（百慕達）")],
    "WIN": [(1282266, "2009-01-01", "2015-04-07", "Windstream Corp／Holdings；1494367 是無 10-K 子公司")],
    "WLTW": [(1140536, "2016-01-05", "2022-01-10", "Willis Towers Watson plc；1745902 是無 10-K 子公司")],
    "WRK": [(1636023, "2015-07-02", "2018-11-02", "WestRock Co（今 WRKCo）"), (1732845, "2018-11-02", "2024-07-08", "WestRock Co（KapStone 後的新控股）")],
    # ---- 自動 predecessor 抽查後的結果
    "AGN": [(850693, "2009-01-01", "2015-03-17", "Allergan Inc（自動正確，轉換日修正）"),
            (1578845, "2015-03-17", "2020-05-12", "Actavis plc → Allergan plc")],
    "AVGO": [(1441634, "2014-05-08", "2016-02-01", "Avago Technologies（自動錯成舊 Broadcom Corp 1054374）"),
             (1649338, "2016-02-01", "2018-04-04", "Broadcom Ltd"), (1730168, "2018-04-04", None, "Broadcom Inc")],
    "BHGE": [(808362, "2009-01-01", "2017-07-03", "Baker Hughes Inc（自動正確）"), (1701605, "2017-07-03", "2019-10-18", "BHGE")],
    "CBE": [(1141982, "2009-01-01", "2012-12-03", "Cooper Industries Ltd／plc（自動錯：24454 是舊俄亥俄公司、1505206 無 10-K）")],
    "CEG": [(1004440, "2009-01-01", "2012-03-13", "Constellation Energy Group（自動正確）"), (1868275, "2022-02-02", None, "Constellation Energy Corp 分拆")],
    "CI": [(701221, "2009-01-01", "2018-12-20", "舊 Cigna Corp（自動正確）"), (1739940, "2018-12-20", None, "Cigna Group")],
    "COV": [(1385187, "2009-01-01", "2015-01-27", "Covidien Ltd／plc 同一 CIK（自動正確；1494396 無 10-K）")],
    "DTV": [(944868, "2009-01-01", "2009-11-19", "DIRECTV Group（自動正確）"), (1465112, "2009-11-19", "2015-07-27", "DIRECTV")],
    "ESRX": [(885721, "2009-01-01", "2012-04-02", "Express Scripts Inc（自動正確，轉換日修正）"), (1532063, "2012-04-02", "2018-12-21", "Express Scripts Holding")],
    "FRX": [(38074, "2009-01-01", "2014-07-01", "Forest Laboratories（自動正確；1591352 無 10-K）")],
    "ICE": [(1174746, "2009-01-01", "2013-11-13", "IntercontinentalExchange Inc（自動正確）"), (1571949, "2013-11-13", None, "ICE Group／Inc")],
    "KMI": [(1506307, "2012-05-25", None, "無前身：KMI 2012 才加入，已是 2010 年的新 CIK（自動找的 54502 錯）")],
    "MDT": [(64670, "2009-01-01", "2015-01-27", "Medtronic Inc（自動正確）"), (1613103, "2015-01-27", None, "Medtronic plc")],
    "NLSN": [(1492633, "2013-07-09", "2022-10-12", "Nielsen Holdings（自動錯成子公司 1397410）")],
    "PRGO": [(820096, "2011-12-19", "2013-12-18", "Perrigo Co（自動正確，轉換日修正）"), (1585364, "2013-12-18", "2021-09-20", "Perrigo plc")],
    "RDC": [(85408, "2009-01-01", "2014-08-19", "Rowan Companies Inc／plc 同一 CIK（自動正確；1549937 無 10-K）")],
    "SNDK": [(1000180, "2009-01-01", "2016-05-12", "舊 SanDisk（自動正確，區段修正）"), (2023554, "2025-11-28", None, "新 Sandisk 分拆")],
    "WFM": [(865436, "2009-01-01", "2017-08-28", "Whole Foods Market（自動正確；1681416 無 10-K）")],
    "XRX": [(108772, "2009-01-01", "2019-07-31", "Xerox Corp（自動正確）"), (1770450, "2019-07-31", "2021-03-22", "Xerox Holdings")],
    # ---- map_v1（company_tickers／名稱搜尋）抽查：對到子公司或代號被別家重用的，改正
    "AKS": [(918160, "2009-01-01", "2011-12-14", "AK Steel Holding（v1 錯成子公司 AK Steel Corp 918192）")],
    "DISCK": [(1437107, "2014-08-07", "2022-04-11", "Discovery C 股，同 DISCA 的 CIK（v1 錯成 X1 Discovery）")],
    "ETFC": [(1015780, "2009-01-01", "2020-09-21", "E*TRADE Financial（v1 錯成 Eco-Trade Corp：代號重用）")],
    "HNZ": [(46640, "2009-01-01", "2013-06-07", "H.J. Heinz（v1 錯成 Frey Heinz：名稱誤配）")],
    "JNY": [(874016, "2009-01-01", "2009-03-02", "Jones Apparel Group（v1 錯成子公司）")],
    "LVLT": [(794323, "2014-11-05", "2017-11-01", "Level 3 Communications Inc（v1 錯成子公司 LLC）")],
    "SEE": [(1012100, "2009-01-01", "2023-10-18", "Sealed Air Corp（v1 錯成子公司 Sealed Air Corp US）")],
    "STR": [(751652, "2009-01-01", "2010-06-29", "Questar Corp（v1 錯成子公司 Questar Gas）")],
    "TWC": [(1377013, "2009-03-30", "2016-05-18", "Time Warner Cable Inc（v1 錯成子公司 LLC）")],
}

MANUAL_PRED = {"BLK": 1364742, "DIS": 1001039, "XOM": 34088, "GOOGL": 1288776, "GOOG": 1288776, "DD": 30554}

KEEP_FORMS = {"NT 10-K", "NT 10-Q", "NT 10-K/A", "NT 10-Q/A", "PREM14A", "DEFM14A", "PREM14C", "DEFM14C",
              "SC TO-T", "SC TO-T/A", "SC 14D9", "SC 14D9/A", "S-3", "S-3ASR", "S-3/A", "S-4"}
KEEP_ITEMS = {"4.01", "4.02", "1.01", "1.03", "2.03", "3.02"}


def name_ok(a: str, b: str, formers=()) -> float:
    names = [b] + [f.get("name", "") for f in formers]
    return max(SequenceMatcher(None, norm(a), norm(x)).ratio() for x in names if x)


def predecessor(name: str, successor_earliest: str, window_start: str):
    """名稱相同、申報在後繼 CIK 出現前後結束的舊 CIK（控股公司改組、合併後改名）。"""
    q = norm(name)
    st, b, _ = sec_get("https://efts.sec.gov/LATEST/search-index?keysTyped=" + quote(q))
    REQ["sec"] += 1
    if st != 200:
        return None
    best = None
    for h in json.loads(b)["hits"]["hits"][:12]:
        c = int(h["_id"])
        if SequenceMatcher(None, q, norm(h["_source"]["entity"])).ratio() < 0.6:
            continue
        inf = sub_info(c)
        # 前身：有 10-K/10-Q、比後繼早出現、在指數期間開始時還在申報
        if inf and inf["n_10k"] and inf["earliest"] < successor_earliest and inf["earliest"] <= window_start \
                and (inf["latest"] or "") >= min(window_start, successor_earliest):
            if best is None or inf["earliest"] < best[1]["earliest"]:
                best = (c, inf)
    return best


def do_map2():
    """第二版：以 lawcal（Wikipedia 歷史＋CIK，2007 起）為主、company_tickers 與名稱搜尋為輔，
    並檢查名稱相似度（擋掉代號被別家重用）與「CIK 出現晚於指數期間」（找前身 CIK）。"""
    mem, end = membership()
    law = pd.read_csv(RAW / "s01_lawcal_components_history.csv", dtype=str)
    law["cik"] = law["cik"].astype(int)
    old = pd.read_csv(RAW / "b9_sp500_cik_map_v1.csv")
    oldmap = dict(zip(old.ticker, old.cik))
    wn = wiki_names()
    rows, unm = [], []
    for t, (fi, la) in sorted(mem.items()):
        w0 = max(fi, START)
        lrows = law[law.symbol.str.upper() == t.replace("-", ".")]
        cands = [(int(r.cik), r["name"], "lawcal") for _, r in lrows.iterrows()]
        if t in oldmap:
            cands.append((int(oldmap[t]), wn.get(t) or "", "map_v1"))
        seen, got = set(), []
        for c, nm, src in cands:
            if c in seen:
                continue
            seen.add(c)
            inf = sub_info(c)
            if not inf:
                continue
            ref = nm or wn.get(t) or ""
            sim = name_ok(ref, inf["name"], inf["formerNames"]) if ref else None
            if inf["latest"] < w0 or inf["earliest"] > la:
                continue  # 申報期間和指數期間沒有重疊
            if src == "map_v1":
                lname = lrows["name"].iloc[0] if len(lrows) else ref
                vs = name_ok(lname, inf["name"], inf["formerNames"]) if lname else None
                if (len(lrows) and (vs is None or vs < 0.6)) or (vs is not None and vs < 0.45):
                    continue  # 名稱差太多：多半是代號被別家公司重用（例 CA → CASH TECHNOLOGIES）
                sim = vs
            got.append((c, inf, src, sim))
        if not got:
            unm.append(dict(ticker=t, first_in=fi, last_in=la, candidates=";".join(str(c) for c, *_ in cands)))
            continue
        for c, inf, src, sim in got:
            flag = ""
            if inf["earliest"] > w0:
                pre = predecessor(inf["name"], inf["earliest"], w0)
                if pre:
                    pc, pinf = pre
                    rows.append(dict(ticker=t, cik=pc, name=pinf["name"], first_in=fi, last_in=la, valid_from=w0,
                                     valid_to=inf["earliest"], source="predecessor", name_sim=None,
                                     earliest_filing=pinf["earliest"], latest_filing=pinf["latest"], flag="前身 CIK（自動找到，需人工確認）"))
                    flag = f"此 CIK 從 {inf['earliest']} 起；之前用前身 {pc}"
                else:
                    flag = f"此 CIK 從 {inf['earliest']} 起，指數期間較早的部分找不到前身 CIK"
            rows.append(dict(ticker=t, cik=c, name=inf["name"], first_in=fi, last_in=la, valid_from=max(w0, inf["earliest"]),
                             valid_to=min(la, inf["latest"] or la), source=src, name_sim=None if sim is None else round(sim, 2),
                             earliest_filing=inf["earliest"], latest_filing=inf["latest"], flag=flag))
    out = pd.DataFrame(rows)
    # 人工確認過的前身 CIK（submissions 的名稱與申報期間已核對，2026-11-08）
    out = out[~((out.ticker == "BLK") & (out.cik == 1370755))]  # 自動找錯成 BlackRock TCP Capital（BDC）
    for t, c in MANUAL_PRED.items():
        inf = sub_info(c)
        succ = out[(out.ticker == t) & (out.source != "predecessor")]
        if succ.empty:
            continue
        s0 = succ.iloc[0]
        out.loc[succ.index, "flag"] = f"此 CIK 從 {s0.earliest_filing} 起；之前用前身 {c}（人工）"
        out = pd.concat([out, pd.DataFrame([dict(ticker=t, cik=c, name=inf["name"], first_in=s0.first_in, last_in=s0.last_in,
                                                 valid_from=max(s0.first_in, START), valid_to=s0.earliest_filing,
                                                 source="manual_predecessor", earliest_filing=inf["earliest"],
                                                 latest_filing=inf["latest"], flag="")])], ignore_index=True)
    out.to_csv(RAW / "b9_sp500_cik_map.csv", index=False)
    pd.DataFrame(unm).to_csv(RAW / "b9_unmapped.csv", index=False)
    print(f"代號 {len(mem)}；有 CIK 的代號 {out.ticker.nunique()}；列數 {len(out)}（lawcal {sum(out.source=='lawcal')}，"
          f"v1 {sum(out.source=='map_v1')}，前身 {sum(out.source=='predecessor')}）；對不到 {len(unm)}；"
          f"仍缺前身 {out.flag.str.contains('找不到前身').sum()}；SEC 請求 {REQ['sec']}")


def do_fix():
    """把 MANUAL_SEGMENTS 套到 b9_sp500_cik_map.csv（map2 之後跑）。"""
    m = pd.read_csv(RAW / "b9_sp500_cik_map.csv")
    keep = m[~m.ticker.isin(MANUAL_SEGMENTS)]
    rows = []
    for t, segs in MANUAL_SEGMENTS.items():
        old = m[m.ticker == t]
        fi = old.first_in.min() if len(old) else None
        la = old.last_in.max() if len(old) else None
        for cik, vf, vt, note in segs:
            inf = sub_info(cik)
            rows.append(dict(ticker=t, cik=cik, name=inf["name"], first_in=fi, last_in=la, valid_from=vf,
                             valid_to=vt or la, source="manual_verified", name_sim=None,
                             earliest_filing=inf["earliest"], latest_filing=inf["latest"],
                             flag=note if note.startswith("無前身") else "", note=note))
    out = pd.concat([keep, pd.DataFrame(rows)], ignore_index=True)
    # 其餘舊旗標：還在 flag 裡寫「找不到前身」的，應該都已被上表取代
    left = out[out.flag.fillna("").str.contains("找不到前身")]
    out.to_csv(RAW / "b9_sp500_cik_map.csv", index=False)
    print(f"套用 {len(MANUAL_SEGMENTS)} 個代號、{len(rows)} 列；總列數 {len(out)}、CIK {out.cik.nunique()}；"
          f"仍標「找不到前身」{left.ticker.nunique()} 個：{sorted(set(left.ticker))}；"
          f"source 分布 {out.source.value_counts().to_dict()}")


def do_stats():
    """指數期間內的事件數：filingDate 落在該 CIK 任一列的 [valid_from, valid_to]（按區段，不是整體最早到最晚）。"""
    e = pd.read_csv(RAW / "b9_edgar_events.csv", dtype=str)
    e["items"] = e["items"].fillna("")
    m = pd.read_csv(RAW / "b9_sp500_cik_map.csv", dtype=str)
    segs = m.groupby("cik")[["valid_from", "valid_to"]].apply(lambda g: list(zip(g.valid_from, g.valid_to))).to_dict()
    e["inwin"] = [any(a <= d <= b for a, b in segs.get(c, [])) for c, d in zip(e.cik, e.filingDate)]
    w = e[e.inwin]
    groups = {
        "8-K 4.02": e["items"].str.contains("4.02"),
        "8-K 4.01": e["items"].str.contains("4.01"),
        "NT 10-K/10-Q": e.form.str.startswith("NT "),
        "M&A 原始申報（PREM14A/DEFM14A/14C/SC TO-T/SC 14D9）": e.form.isin(
            ["PREM14A", "DEFM14A", "PREM14C", "DEFM14C", "SC TO-T", "SC 14D9"]),
        "SC 14D9（只有被收購方會申報）": e.form == "SC 14D9",
        "S-3/S-3ASR": e.form.isin(["S-3", "S-3ASR"]),
        "424B*": e.form.str.startswith("424B"),
        "424B2": e.form == "424B2",
        "8-K 1.03": e["items"].str.contains("1.03"),
        "8-K 3.02": e["items"].str.contains("3.02"),
    }
    rows = []
    for name, mask in groups.items():
        s = e[mask & e.inwin]
        rows.append(dict(event=name, all=int(mask.sum()), in_index=len(s), companies=s.cik.nunique(),
                         by_year=s.filingDate.str[:4].value_counts().sort_index().to_dict()))
        print(f"{name}: 全部 {int(mask.sum())}，指數期間內 {len(s)}（{s.cik.nunique()} 家）；每年 {rows[-1]['by_year']}")
    pd.DataFrame(rows).to_csv(RAW / "b9_event_counts.csv", index=False)
    k = w[w["items"].str.contains("4.01") & (w.filingDate.str[:4] == "2014")]
    print("\n2014 年 4.01：", k[["ticker", "filingDate", "items"]].to_string(index=False))
    k.to_csv(RAW / "b9_401_2014.csv", index=False)


def do_scan():
    m = pd.read_csv(RAW / "b9_sp500_cik_map.csv")
    events, n_pages = [], 0
    for cik, g in m.groupby("cik"):
        tick = ",".join(g.ticker)
        j = sj(f"https://data.sec.gov/submissions/CIK{cik10(cik)}.json")
        frames = [pd.DataFrame(j["filings"]["recent"])]
        for f in j["filings"].get("files", []):
            if f["filingTo"] >= START:
                frames.append(pd.DataFrame(sj(f"https://data.sec.gov/submissions/{f['name']}")))
                n_pages += 1
        df = pd.concat(frames, ignore_index=True)
        df = df[df.filingDate >= START]
        is8k = df.form.isin(["8-K", "8-K/A"]) & df["items"].fillna("").apply(
            lambda s: bool(KEEP_ITEMS & set(s.split(","))))
        keep = df[is8k | df.form.isin(KEEP_FORMS) | df.form.str.startswith("424B")]
        for _, r in keep.iterrows():
            events.append(dict(cik=cik, ticker=tick, form=r.form, items=r["items"], filingDate=r.filingDate,
                               acceptanceDateTime=r.acceptanceDateTime, accessionNumber=r.accessionNumber,
                               primaryDocument=r.primaryDocument))
    ev = pd.DataFrame(events)
    ev.to_csv(RAW / "b9_edgar_events.csv", index=False)
    stats = {"ciks": int(m.cik.nunique()), "pages_fetched": n_pages, "sec_requests": REQ["sec"],
             "forms": ev.form.value_counts().head(40).to_dict()}
    items = Counter(x for s in ev[ev.form.isin(["8-K", "8-K/A"])]["items"] for x in s.split(",") if x in KEEP_ITEMS)
    stats["8k_items"] = dict(items)
    (RAW / "b9_scan_stats.json").write_text(json.dumps(stats, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps(stats, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    {"map": do_map, "map2": do_map2, "fix": do_fix, "stats": do_stats, "scan": do_scan}[sys.argv[1]]()
