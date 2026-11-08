"""B-9：AI 層「規則偵測段」的事件研究（不用 LLM）。

階段（依序）：
  fetch    抓分類需要的申報原文（8-K 4.01 全文、合併委託書／SC TO-T／424B 封面、dei 股數），快取在 backtest/data/b9_docs
  classify 依原文把事件分類（4.01 辭任／解任／退休計畫／合併；被收購方 vs 收購方；424B 股票／可轉債／債券與規模）
           → backtest/results/B9_events.csv（每個事件一列，含第一個可交易開盤日）
  study    事件研究：3、6、12 個月相對 SPY、相對產業 ETF、相對同月配對組 → B9_event_study.csv、B9_event_rows.csv
  jump     ONE_OFF_JUMP／資訊離散度：每月決策日的橫斷面 → B9_jump_study.csv

執行：uv run python backtest/b9_events.py fetch|classify|study|jump
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import b9_common as C  # noqa: E402
import b9_fetch as F  # noqa: E402

WB = r"\b"  # 單字邊界
MA_FORMS = ["PREM14A", "DEFM14A", "PREM14C", "DEFM14C"]
B_FORMS = ["424B1", "424B4", "424B5"]


# ---------------------------------------------------------------- fetch

def candidates():
    e = C.load_raw_events()
    w = e[e.inwin].copy()
    is8k = w.form.isin(["8-K", "8-K/A"])
    a401 = w[is8k & C.has_item(w["items"], "4.01")]
    ma = w[w.form.isin(MA_FORMS)]
    tot = w[w.form == "SC TO-T"]
    b424 = w[w.form.isin(B_FORMS)]
    return w, a401, ma, tot, b424


def do_fetch():
    w, a401, ma, tot, b424 = candidates()
    jobs = []
    for _, r in a401.iterrows():
        jobs.append((F.doc_url(r.cik, r.accessionNumber, r.primaryDocument), 400_000))
    for _, r in ma.iterrows():
        jobs.append((F.doc_url(r.cik, r.accessionNumber, r.primaryDocument), 120_000))
    for _, r in tot.iterrows():
        jobs.append((F.header_url(r.cik, r.accessionNumber), 30_000))
        jobs.append((F.doc_url(r.cik, r.accessionNumber, r.primaryDocument), 60_000))
    for _, r in b424.iterrows():
        jobs.append((F.doc_url(r.cik, r.accessionNumber, r.primaryDocument), 60_000))
    print(f"4.01 {len(a401)}、委託書 {len(ma)}、SC TO-T {len(tot)}、424B1/4/5 {len(b424)}；共 {len(jobs)} 個網址", flush=True)
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(10) as ex:  # 10 條連線，但全域限速 ≤ 4 次／秒（b9_fetch）
        for k, _ in enumerate(ex.map(lambda j: F.fetch(*j), jobs), 1):
            if k % 250 == 0:
                print(f"  {k}/{len(jobs)} {F.STATS}", flush=True)
    print("完成", F.STATS, flush=True)


def fetch_shares(ciks):
    """dei:EntityCommonStockSharesOutstanding（companyconcept，小檔）。"""
    import json
    out = {}
    for c in sorted(set(ciks)):
        u = f"https://data.sec.gov/api/xbrl/companyconcept/CIK{int(c):010d}/dei/EntityCommonStockSharesOutstanding.json"
        t = F.fetch(u)
        rows = []
        if t:
            try:
                j = json.loads(t)
                for unit, vals in j.get("units", {}).items():
                    for v in vals:
                        rows.append((v["filed"], v["end"], float(v["val"])))
            except Exception:
                pass
        out[c] = pd.DataFrame(rows, columns=["filed", "end", "val"]).sort_values(["filed", "end"]) if rows else None
    return out


# ---------------------------------------------------------------- classify helpers

def text_of(url, hb):
    raw = F.fetch(url, hb)
    return F.to_text(raw) if raw else ""


AUD_RESIGN = re.compile(r"(resign|declin\w* to stand for re-?(?:election|appointment|engagement)|"
                        r"not (?:to )?stand for re-?(?:election|appointment)|will not seek re-?(?:election|appointment)|"
                        r"informed .{0,80}? (?:that it|of its decision) .{0,60}?(?:not|decline))", re.I)
AUD_DISMISS = re.compile(r"(dismiss|approved the (?:engagement|appointment) of .{0,120}? (?:to replace|as the company's new)|"
                         r"decided to (?:engage|change|replace)|(?:selected|appointed|engaged) .{0,120}? as (?:its|the company's) (?:new )?independent registered)", re.I)
AUD_PLAN = re.compile(r"((?:401\(k\)|retirement|savings|thrift|stock purchase|investment|profit sharing|incentive savings)\s+plan[s]?\b.{0,200}?"
                      r"(?:auditor|accountant|financial statements|form 11-k)|form 11-k|financial statements of the plan|the plan's)", re.I)
AUD_MERGER = re.compile(r"(merger|acquisition|business combination|consummation of the|spin-off|separation).{0,300}?"
                        r"(dismiss|engage|auditor|accounting firm)", re.I)
DISAGREE = re.compile(r"there (?:were|have been) (?:no|not been any) (?:\"|“)?disagreements", re.I)


# 逐筆讀過原文後的人工修正（關鍵字分類分不清楚的 20 筆；代號取 cik_map 的第一個代號，日期為 filingDate）
MANUAL_401 = {
    ("SMCI", "2024-10-30"): "RESIGN",    # EY 辭任，信中提到對治理與內控的疑慮
    ("ISRG", "2014-02-14"): "RESIGN",    # EY 拒絕回應 RFP 並表示不再續任
    ("WTW", "2017-03-03"): "NETWORK",    # Deloitte UK 辭任，改由同一聯盟的美國所（同一事務所網路內轉換）
    ("AMCR", "2026-08-14"): "NETWORK",   # 公司要求 PwC Switzerland 辭任，改由 PwC US（遷冊後）
    ("VAR", "2010-02-23"): "PLAN", ("GRMN", "2014-07-25"): "PLAN", ("GRMN", "2014-10-30"): "PLAN",
    ("PRU", "2013-06-25"): "PLAN", ("PRU", "2014-01-13"): "PLAN", ("CMCSA", "2010-03-22"): "PLAN",
    ("AAL", "2014-03-03"): "MERGER", ("AAL", "2014-03-07"): "MERGER", ("DD", "2018-12-19"): "MERGER",
    ("MRK", "2009-11-04"): "MERGER", ("GAS", "2011-12-15"): "MERGER", ("PLD", "2011-06-08"): "MERGER",
    ("TMUS", "2013-05-02"): "MERGER", ("DXC", "2017-04-06"): "MERGER",
    ("MSI", "2018-05-17"): "DISMISS", ("HSY", "2017-02-27"): "DISMISS",
}


def classify_401(text: str) -> dict:
    """8-K 4.01：會計師辭任／公司解任／退休計畫／合併後統一。看 Item 4.01 那一節的文字。"""
    t = text
    k = re.search(r"item\s*4\.?01", t, re.I)
    sec = t[k.start():k.start() + 6000] if k else t[:6000]
    plan = bool(AUD_PLAN.search(sec[:2500]))
    resign = bool(AUD_RESIGN.search(sec))
    dismiss = bool(re.search(r"dismiss", sec, re.I))
    merger = bool(AUD_MERGER.search(sec[:3000]))
    no_disagree = bool(DISAGREE.search(sec))
    if plan:
        kind = "PLAN"
    elif resign and not dismiss:
        kind = "RESIGN"
    elif dismiss and not resign:
        kind = "MERGER" if merger else "DISMISS"
    elif resign and dismiss:
        kind = "MIXED"
    elif re.search(r"engage|appoint|select", sec, re.I):
        kind = "NEW_ONLY"  # 只公告新會計師（通常是先前解任的補充）
    else:
        kind = "UNKNOWN"
    return {"kind401": kind, "no_disagree": no_disagree, "snippet": sec[:400]}


PER_SHARE = re.compile(r"\$\s?(\d{1,4}(?:\.\d{1,4})?)\s*(?:per share)?,?\s*in cash", re.I)


def short_names(name: str) -> list[str]:
    """公司名稱的簡稱（例：'AON PLC' → ['Aon']；'Newmont Corp /DE/' → ['Newmont']）。"""
    n = re.sub(r"/[A-Z]{2}/?", "", name or "")
    n = re.sub(r"[,.]", " ", n)
    words = [w for w in n.split() if w.upper() not in {"INC", "CORP", "CORPORATION", "CO", "PLC", "LTD", "LLC", "THE",
                                                       "COMPANY", "HOLDINGS", "GROUP", "NV", "SA", "AG", "LP", "DEL", "NEW"}]
    out = []
    if words:
        out.append(re.escape(words[0]))
        if len(words) > 1:
            out.append(re.escape(" ".join(words[:2])))
    return out


def classify_proxy(text: str, own_name) -> dict:
    """PREM14A／DEFM14A：被收購方 or 收購方（只看封面信，前 30,000 字元）。
    被收購方：「(我們／公司) 的每一股普通股將轉換成收取…的權利」「Merger Sub 將併入本公司」「本公司將成為 X 的完全子公司」。
    收購方：「發行本公司股票給對方股東」（share issuance），而且沒有上面任何一句。"""
    t = text[:30000]
    own = own_name if isinstance(own_name, (list, tuple)) else [own_name]
    names = list(dict.fromkeys(n for x in own for n in short_names(x)))
    # 委託書裡的簡稱定義：「Kansas City Southern (which we refer to as “KCS”)」「Celgene Corporation (“Celgene”)」
    for n in list(names):
        for m in re.finditer(n + r"[^()“”\"]{0,60}\((?:which (?:we|is) (?:refer|referred) to (?:herein )?as |referred to as |the |hereinafter )?[“\"]([A-Z][\w&.\- ]{1,30})[”\"]", t, re.I):
            names.append(re.escape(m.group(1)))
    names = list(dict.fromkeys(names))
    alt = "|".join(names)
    self_ = r"(?:the company|our company|us|" + alt + r")" if names else r"(?:the company|us)"
    self_poss = r"(?:the company[’']s|our|" + "|".join(n + r"(?:[’']s)?" for n in names) + r")" if names else r"(?:the company[’']s|our)"
    conv = re.search(r"each (?:issued and )?(?:outstanding )?share of (?:" + self_poss + r"\s+)?(?:class [a-z] )?(?:common|ordinary) (?:stock|shares?)"
                     r"[^.]{0,250}?(?:converted into|right to receive|exchanged for|cancell?ed)", t, re.I)
    into_us = re.search(r"merged? (?:with and )?into " + self_ + r"\b", t, re.I)
    sub_of = re.search(self_ + r"\b[^.]{0,80}?(?:(?:will|would) (?:become|continue as)|surviv\w*[^.]{0,40}?as) (?:a |an )?(?:direct |indirect )?(?:wholly[- ]owned )?subsidiary of", t, re.I)
    acquired = re.search(self_ + r"\b[^.]{0,40}?(?:will|would) be acquired by|(?:acquisition|purchase) of " + self_ + r"\b by", t, re.I)
    issuance = re.search(r"(issuance of (?:shares of )?" + self_poss + r"\s+(?:class a )?common stock|share issuance proposal|stock issuance proposal|"
                         r"issue shares of " + self_poss + r")", t, re.I)
    sale = re.search(r"(sale of (?:all or )?substantially all|asset sale)", t, re.I)
    px = [float(x) for x in PER_SHARE.findall(t) if float(x) >= 1]
    reorg = re.search(r"(redomesticat|redomicil|holding company (?:reorganization|structure)|reorganization (?:transaction|merger)|"
                      r"change (?:the|our|its) (?:place|jurisdiction) of (?:incorporation|organization)|convert\w* to a REIT|REIT conversion|"
                      r"qualify (?:as|to be taxed as) a real estate investment trust)", t[:12000], re.I)
    if conv or ((into_us or sub_of or acquired) and (not issuance or px)):
        role = "TARGET"
    elif issuance:
        role = "ACQUIRER"
    elif sale:
        role = "ASSET_SALE"
    else:
        role = "UNCLEAR"
    if reorg and not px and role == "TARGET":
        role = "REORG"
    return {"role": role, "cash": bool(px), "offer_px": px[0] if px else np.nan,
            "flags": f"conv={int(bool(conv))} into={int(bool(into_us))} sub={int(bool(sub_of))} acq={int(bool(acquired))} iss={int(bool(issuance))}"}


def subject_cik(header_text: str):
    """index-headers：SUBJECT COMPANY 區塊的 CIK。"""
    m = re.search(r"SUBJECT COMPANY:.*?CENTRAL INDEX KEY:\s*(\d+)", header_text, re.S)
    return str(int(m.group(1))) if m else None


AMT = r"\$\s?([\d,]+(?:\.\d+)?)\s*(million|billion)?"
COVER_EQ = re.compile(r"\b(?:shares of (?:our |its )?(?:class [ab] )?common stock|common shares|ordinary shares|common stock)\b", re.I)
COVER_DEBT = re.compile(r"\b(notes due|% notes|senior notes|debentures|floating rate notes|subordinated notes|medium-term notes|"
                        r"principal amount|bonds due|% senior|trust preferred|depositary shares|preferred stock|warrants? (?:linked|due))", re.I)
# 只認「本次發行的就是可轉換證券」；排除 "will not be convertible"、"are not convertible into" 這類否定句（抽查 15 筆有 7 筆是否定句）
CONVERT = re.compile(r"(?:(?<!not )(?<!not be )\bconvertible (?:senior |subordinated |unsecured |exchangeable )*(?:notes|debentures|bonds)\b"
                     r"|\bmandatory convertible\b|\bconvertible (?:perpetual )?preferred\b(?! stock[^.]{0,40}not convertible))", re.I)


def classify_424(text: str) -> dict:
    """424B1/B4/B5 封面：普通股／可轉債／債券或優先股；規模（金額或股數、每股價格）。"""
    t = text
    k = re.search(r"\(\s*to (?:the )?prospectus dated", t, re.I)
    start = max(0, k.start() - 600) if k else 0
    cover = t[start:start + 2600]
    eq = bool(COVER_EQ.search(cover))
    debt = bool(COVER_DEBT.search(cover))
    conv = bool(CONVERT.search(cover))
    atm = bool(re.search(r"(at[- ]the[- ]market|sales agent|equity distribution|distribution agreement|equity sales agreement)", cover, re.I))
    selling = bool(re.search(r"(selling (?:stock|share)holders?|selling shareholder|we will not receive any (?:of the )?proceeds|"
                             r"the selling stockholder|being sold by|offered by the selling)", cover, re.I))
    drip = bool(re.search(r"(dividend reinvestment|direct stock purchase|employee stock|stock purchase plan|savings plan)", cover, re.I))
    if conv:
        kind = "CONVERTIBLE"
    elif eq and not debt:
        kind = "EQUITY"
    elif eq and debt:
        # 封面同時提到：以第一個出現者為主
        me, md = COVER_EQ.search(cover), COVER_DEBT.search(cover)
        kind = "EQUITY" if me.start() < md.start() else "DEBT"
    else:
        kind = "DEBT" if debt else "OTHER"
    if kind == "EQUITY" and selling:
        kind = "EQUITY_SECONDARY"
    if kind == "EQUITY" and drip:
        kind = "EQUITY_PLAN"
    amt = np.nan
    m = re.search(r"\$\s?([\d,]{5,}(?:\.\d+)?|\d+(?:\.\d+)?\s*(?:million|billion))\s*(million|billion)?[^$]{0,80}?common (?:stock|shares)", cover, re.I)
    if m:
        g1 = m.group(1).replace(",", "")
        unit = (m.group(2) or (re.search(r"(million|billion)", g1, re.I) or [None, ""])[1] or "").lower()
        num = float(re.sub(r"[^\d.]", "", g1) or 0)
        amt = num * {"million": 1e6, "billion": 1e9}.get(unit, 1)
        if amt < 5e6:  # 申報費、面額之類的小數字
            amt = np.nan
    sh = np.nan
    m2 = re.search(r"([\d,]{5,})\s+(?:shares|common shares)", cover, re.I)
    if m2:
        sh = float(m2.group(1).replace(",", ""))
    px = np.nan
    m3 = re.search(r"\$\s?(\d{1,4}\.\d{2,4})\s*per (?:share|common share)", cover, re.I) or \
        re.search(r"(?:public offering price|price to (?:the )?public)[^$]{0,60}\$\s?(\d{1,4}\.\d{2,4})", cover, re.I)
    if m3:
        px = float(m3.group(1))
    return {"kind424": kind, "atm": atm, "amount": amt, "shares": sh, "px": px, "cover": cover[:300]}


def shares_asof(sh: pd.DataFrame | None, date: str):
    if sh is None or sh.empty:
        return np.nan
    s = sh[sh.filed <= date]
    if s.empty:
        return np.nan
    return float(s.iloc[-1].val)


# ---------------------------------------------------------------- classify → events table

def dedupe(df: pd.DataFrame, gap_days: int) -> pd.DataFrame:
    """同一 CIK、同一類：與上一個事件相隔 < gap_days 天的併入第一筆（8-K/A 補充、NT 10-Q 接著 NT 10-K）。"""
    df = df.sort_values(["cik", "acceptanceDateTime"])
    keep, last = [], {}
    for idx, r in df.iterrows():
        d = pd.Timestamp(r.filingDate)
        if r.cik in last and (d - last[r.cik]).days < gap_days:
            continue
        last[r.cik] = d
        keep.append(idx)
    return df.loc[keep]


def do_classify():
    panel = C.load_panel()
    days = panel["days"]
    have = set(panel["adj"].columns)
    m = C.cik_map()
    w, a401, ma, tot, b424 = candidates()
    name_of = m.groupby("cik").name.first().to_dict()
    rows = []

    def base(r, cls, sub, **kw):
        d = C.avail_day(r.acceptanceDateTime, days)
        tk = C.segment_ticker(m, r.cik, r.filingDate, have)
        rows.append(dict(cls=cls, sub=sub, cik=r.cik, ticker=tk, form=r.form, items=r["items"], filingDate=r.filingDate,
                         accept=r.acceptanceDateTime, avail=d, accn=r.accessionNumber, **kw))

    is8k = w.form.isin(["8-K", "8-K/A"])
    # 1. 4.02
    for _, r in dedupe(w[is8k & C.has_item(w["items"], "4.02")], 180).iterrows():
        base(r, "ACC_402", "4.02")
    # 2. 4.01：逐筆讀原文分類，再去重（同一家 180 天內的先解任、後公告新會計師算一次，取最嚴重的分類）
    a = a401.copy()
    info = [classify_401(text_of(F.doc_url(r.cik, r.accessionNumber, r.primaryDocument), 400_000)) for _, r in a.iterrows()]
    a = pd.concat([a.reset_index(drop=True), pd.DataFrame(info)], axis=1)
    a["auto401"] = a.kind401
    a["kind401"] = [MANUAL_401.get((t.split(",")[0], d), k) for t, d, k in zip(a.ticker, a.filingDate, a.kind401)]
    a[["cik", "ticker", "filingDate", "form", "items", "auto401", "kind401", "no_disagree", "snippet"]].to_csv(C.OUT / "B9_401_classified.csv", index=False)
    sev = {"RESIGN": 0, "MIXED": 1, "DISMISS": 2, "UNKNOWN": 3, "MERGER": 4, "NETWORK": 5, "NEW_ONLY": 6, "PLAN": 7}
    for cik, g in a.sort_values("acceptanceDateTime").groupby("cik"):
        g = g.copy()
        g["ep"] = (pd.to_datetime(g.filingDate).diff().dt.days.fillna(9999) >= 180).cumsum()
        for _, gg in g.groupby("ep"):
            first = gg.iloc[0]
            kinds = sorted(gg.kind401, key=lambda k: sev[k])
            base(first, "ACC_401", kinds[0], no_disagree=bool(gg.no_disagree.all()))
    # 3. NT 10-K／NT 10-Q
    for _, r in dedupe(w[w.form.isin(["NT 10-K", "NT 10-Q"])], 180).iterrows():
        base(r, "ACC_NT", r.form)
    # 4. 被收購：SC 14D9（只有被收購方）、SC TO-T（索引頁 Subject Company＝自己）、合併委託書（封面判斷被收購方）
    ma_rows = []
    for _, r in w[w.form == "SC 14D9"].iterrows():
        ma_rows.append((r, "SC 14D9", "TARGET", np.nan, ""))
    for _, r in tot.iterrows():
        # 索引頁 header 多半 404（申報放在收購方的資料夾）→ 改讀 Schedule TO 封面「X (Name of Subject Company (Issuer))」
        txt = text_of(F.doc_url(r.cik, r.accessionNumber, r.primaryDocument), 60_000)
        mm = re.search(r"([^()]{3,160}?)\s*\(\s*Name of Subject Company", txt[:15000], re.I)
        subj = mm.group(1).strip()[-120:] if mm else ""
        own = [n for x in [name_of.get(r.cik, "")] + C.names_of(r.cik) for n in short_names(x)[-1:]]
        hit = bool(subj) and any(re.search(WB + n + WB, subj, re.I) for n in own if n)
        px = [float(x) for x in PER_SHARE.findall(txt[:20000]) if float(x) >= 1]
        ma_rows.append((r, "SC TO-T", "TARGET" if hit else ("ACQUIRER" if subj else "UNCLEAR"),
                        px[0] if px else np.nan, f"subject={subj[-60:]}"))
    for _, r in ma.iterrows():
        c = classify_proxy(text_of(F.doc_url(r.cik, r.accessionNumber, r.primaryDocument), 120_000), [name_of.get(r.cik, "")] + C.names_of(r.cik))
        ma_rows.append((r, r.form, c["role"], c["offer_px"], c["flags"]))
    mdf = pd.DataFrame([dict(r._asdict() if hasattr(r, "_asdict") else r.to_dict(), ma_form=f, role=role, offer_px=px, flags=fl)
                        for r, f, role, px, fl in ma_rows])
    mdf[["cik", "ticker", "form", "filingDate", "role", "offer_px", "flags"]].to_csv(C.OUT / "B9_ma_classified.csv", index=False)
    seg_last = m.assign(valid_to=pd.to_datetime(m.valid_to)).groupby("cik").valid_to.max().to_dict()
    tgt = mdf[mdf.role == "TARGET"]
    for cik, g in tgt.sort_values("acceptanceDateTime").groupby("cik"):
        g = g.copy()
        g["ep"] = (pd.to_datetime(g.filingDate).diff().dt.days.fillna(9999) >= 365).cumsum()
        for _, gg in g.groupby("ep"):
            first = gg.iloc[0]
            left = seg_last.get(cik)
            # 事後標籤（只用來描述，規則不能用）：18 個月內離開指數 ≈ 收購完成
            done = bool(left is not None and left < C.END - pd.Timedelta(days=30) and
                        (left - pd.Timestamp(first.filingDate)).days <= 548)
            base(first, "PENDING_MA", first.ma_form, offer_px=gg.offer_px.dropna().iloc[0] if gg.offer_px.notna().any() else np.nan,
                 forms="+".join(sorted(set(gg.ma_form))), left_index=str(left.date()) if left is not None else "",
                 completed_expost=done)
    # 收購方／不明的也記下來（給分類準確度的描述用）
    tgt_days = {c: pd.to_datetime(g.filingDate) for c, g in tgt.groupby("cik")}
    for cik, g in mdf[mdf.role != "TARGET"].sort_values("acceptanceDateTime").groupby("cik"):
        g = g.copy()
        g["ep"] = (pd.to_datetime(g.filingDate).diff().dt.days.fillna(9999) >= 365).cumsum()
        for _, gg in g.groupby("ep"):
            first = gg.iloc[0]
            near = tgt_days.get(cik)
            if near is not None and ((near - pd.Timestamp(first.filingDate)).abs().dt.days <= 365).any():
                continue  # 同一筆交易已有被收購方的判定
            base(first, "MA_OTHER", first.role, forms="+".join(sorted(set(gg.ma_form))))
    # 5. 增資：424B1/B4/B5 封面
    binfo = [classify_424(text_of(F.doc_url(r.cik, r.accessionNumber, r.primaryDocument), 60_000)) for _, r in b424.iterrows()]
    b = pd.concat([b424.reset_index(drop=True), pd.DataFrame(binfo)], axis=1)
    eqc = b[b.kind424.isin(["EQUITY", "CONVERTIBLE"])]
    shares = fetch_shares(eqc.cik.unique())
    sizes = []
    for _, r in b.iterrows():
        so = shares_asof(shares.get(r.cik), r.filingDate) if r.kind424 in ("EQUITY", "CONVERTIBLE") else np.nan
        tk = C.segment_ticker(m, r.cik, r.filingDate, have)
        rawpx = np.nan
        if tk in have:
            s = panel["raw"][tk].loc[:r.filingDate].dropna()
            rawpx = float(s.iloc[-1]) if len(s) else np.nan
        mcap = so * rawpx if np.isfinite(so) and np.isfinite(rawpx) else np.nan
        if np.isfinite(r.shares) and np.isfinite(so) and so > 0:
            size = r.shares / so
        elif np.isfinite(r.amount) and np.isfinite(mcap) and mcap > 0:
            size = r.amount / mcap
        else:
            size = np.nan
        sizes.append(dict(shares_out=so, mcap=mcap, size=size))
    b = pd.concat([b, pd.DataFrame(sizes)], axis=1)
    b[["cik", "ticker", "form", "filingDate", "kind424", "atm", "amount", "shares", "px", "shares_out", "mcap", "size", "cover"]].to_csv(
        C.OUT / "B9_424_classified.csv", index=False)
    dil = b[b.kind424.isin(["EQUITY", "CONVERTIBLE"])]
    for _, r in dedupe(dil, 30).iterrows():
        # 同一次發行的初步與正式補充說明書：規模取 30 天內的最大值
        same = dil[(dil.cik == r.cik) & (dil.filingDate >= r.filingDate) &
                   (pd.to_datetime(dil.filingDate) <= pd.Timestamp(r.filingDate) + pd.Timedelta(days=30))]
        sz = same["size"].max()
        base(r, "DILUTION", r.kind424, size=sz, atm=bool(same.atm.any()))
    # 8-K 3.02（未登記股票發行；規模未知）
    for _, r in dedupe(w[is8k & C.has_item(w["items"], "3.02")], 30).iterrows():
        base(r, "DILUTION_302", "3.02")
    # S-3／S-3ASR（只是儲架登記，參考用）
    for _, r in dedupe(w[w.form.isin(["S-3", "S-3ASR"])], 30).iterrows():
        base(r, "SHELF_S3", r.form)
    ev = pd.DataFrame(rows)
    ev.loc[ev["size"] > 1, "size"] = np.nan  # > 100% 市值不合理（優先股轉換、正則抓錯數字），當成規模不明
    ev["sic"] = ev.cik.map(lambda c: C.sic_of(c))
    ev.to_csv(C.OUT / "B9_events.csv", index=False)
    print(ev.groupby(["cls", "sub"]).size().to_string())
    print("沒有價格的事件：", ev[~ev.ticker.isin(have)].groupby("cls").size().to_dict())
    print(F.STATS)


if __name__ == "__main__":
    stage = sys.argv[1]
    if stage == "fetch":
        do_fetch()
    elif stage == "classify":
        do_classify()
    elif stage in ("study", "jump"):
        import b9_study
        getattr(b9_study, f"do_{stage}")()
