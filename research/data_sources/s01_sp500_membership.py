"""驗證 1：歷史 S&P 500 成分股（point-in-time）的來源比較、抽查與價格覆蓋率。

做什麼：
  1. 下載 fja05680/sp500 目前版本（GitHub，(Updated).csv），和 LEAN 資料夾裡的快取
     （data-sp500-long/.cache/membership/sp500-github.csv，唯讀）比對差異。
  2. 下載 Wikipedia「List of S&P 500 companies」：目前成分股表與「Selected changes」異動表。
  3. 抽查已知加入／剔除日期（S&P DJI 公告的生效日，寫在 KNOWN 裡），算每個來源的誤差天數。
  4. 每年第一個交易日的成分股中，有幾檔在 LEAN 資料夾有價格（Yahoo 快取），算比例。
  5. 目前成分股：fja05680 最新一列 vs Wikipedia 目前表，列出差異。

用法：
  uv run python research/data_sources/s01_sp500_membership.py
輸出：
  research/data_sources/raw/s01_*.csv / .txt（不 commit）；主要數字印在 stdout。
"""
from __future__ import annotations

import csv
import io
from datetime import date, datetime
from pathlib import Path

import pandas as pd

from common import LEAN, RAW, get

FJA_URL = ("https://raw.githubusercontent.com/fja05680/sp500/master/"
           "S%26P%20500%20Historical%20Components%20%26%20Changes%20(Updated).csv")
WIKI_URL = "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies"
# 2026 起「Selected changes」異動表搬到這一頁
WIKI_HIST_URL = "https://en.wikipedia.org/wiki/Historical_components_of_the_S%26P_500"
UA = {"User-Agent": "Mozilla/5.0 (research script; data source validation)"}

# 日期口徑：一律用「第一個以新名單開盤的交易日」。Wikipedia 有時記收盤後生效的那一天（早一個交易日）。
# 抽查用的「真值」：S&P Dow Jones Indices 公告的生效日（生效日＝第一個以成分股身分開盤的交易日）。
# (代號, 事件, 生效日, 在 fja05680 裡可能用的代號別名, 依據)
KNOWN = [
    ("ENRNQ", "remove", "2001-11-30", ["ENRNQ", "ENE"], "Enron 由 NVDA 取代；第一個不在指數的交易日＝NVDA 第一天（記憶，未取得 S&P 原文）"),
    ("NVDA", "add", "2001-11-30", ["NVDA"], "同上"),
    ("LEHMQ", "remove", "2008-09-17", ["LEHMQ", "LEH"], "Lehman 9/15 破產；HRS 取代，9/16 收盤後生效（記憶，未取得 S&P 原文）"),
    ("NFLX", "add", "2010-12-20", ["NFLX"], "2010-12-17 收盤後生效（Wikipedia 記 12/17、被取代者 ODP）"),
    ("FB", "add", "2013-12-23", ["META", "FB"], "S&P 2013-12-11 公告：取代 Teradyne，12/23 開盤前生效"),
    ("TSLA", "add", "2020-12-21", ["TSLA"], "S&P 2020-11-16 公告：12/21 開盤前生效"),
    ("SMCI", "add", "2024-03-18", ["SMCI"], "S&P 2024-03-01 公告：3/18 開盤前生效"),
    ("PLTR", "add", "2024-09-23", ["PLTR"], "S&P 2024-09-06 公告：9/23 開盤前生效"),
    ("AAL", "remove", "2024-09-23", ["AAL"], "同 PLTR 那次調整"),
    ("UBER", "add", "2023-12-18", ["UBER"], "S&P 2023-12-01 公告"),
    ("GOOG", "add", "2014-04-03", ["GOOG"], "Google C 股分拆，2014-04-03 起兩類股都在指數"),
    ("BRK.B", "add", "2010-02-16", ["BRK.B", "BRK-B"], "BNSF 收購完成後加入，2010-02-16 生效"),
    ("DELL", "add", "2024-09-23", ["DELL"], "同 PLTR 那次調整"),
    ("COIN", "add", "2025-05-19", ["COIN"], "S&P 2025-05-02 公告：取代 Discover"),
]


def load_fja(text: str) -> list[tuple[date, frozenset[str]]]:
    rows = []
    for r in csv.DictReader(io.StringIO(text)):
        d = datetime.strptime(r["date"].strip(), "%Y-%m-%d").date()
        rows.append((d, frozenset(t.strip().upper() for t in r["tickers"].split(",") if t.strip())))
    rows.sort()
    return rows


def transitions(rows, aliases):
    """回傳 [(event, date)]：從不在到在 = add（那一列的日期），在到不在 = remove。"""
    out, prev = [], False
    for d, members in rows:
        now = any(a in members for a in aliases)
        if now and not prev:
            out.append(("add", d))
        if prev and not now:
            out.append(("remove", d))
        prev = now
    return out


def _weights(d) -> int:
    """LEAN 成分股檔中有權重（價格×股數都有）的檔數 —— 回測股票池實際能用的。"""
    f = LEAN / "equity" / "usa" / "universes" / "etf" / "spy" / f"{d:%Y%m%d}.csv"
    if not f.exists():
        return -1
    return sum(1 for line in f.read_text().splitlines() if line.strip() and line.split(",")[3])


def main():
    # ---------- 1. fja05680 current vs cached
    status, text_now, meta = get(FJA_URL, headers=UA)
    assert status == 200, status
    cached = (LEAN / ".cache" / "membership" / "sp500-github.csv").read_text(encoding="utf-8")
    now_rows, old_rows = load_fja(text_now), load_fja(cached)
    print(f"[fja05680] 目前版本 {len(now_rows)} 列，{now_rows[0][0]} → {now_rows[-1][0]}；抓取 {meta['fetched_at']}")
    print(f"[fja05680] LEAN 快取 {len(old_rows)} 列，{old_rows[0][0]} → {old_rows[-1][0]}")
    old_map = dict(old_rows)
    diff_days = [d for d, m in now_rows if d in old_map and old_map[d] != m]
    print(f"[fja05680] 兩版本共同日期 {sum(1 for d,_ in now_rows if d in old_map)}，名單不同的日期 {len(diff_days)}"
          f"{'（例 ' + ', '.join(map(str, diff_days[:5])) + '）' if diff_days else ''}")
    sizes = pd.Series({d: len(m) for d, m in now_rows})
    print(f"[fja05680] 名單大小 min {sizes.min()} max {sizes.max()} 中位數 {sizes.median():.0f}")
    by_year = sizes.groupby([d.year for d in sizes.index]).agg(["min", "max", "count"])
    by_year.to_csv(RAW / "s01_fja_sizes_by_year.csv")
    (RAW / "s01_fja_now.csv").write_text(text_now, encoding="utf-8")

    # ---------- 2. Wikipedia
    status, html, wmeta = get(WIKI_URL, headers=UA)
    assert status == 200, status
    cur = pd.read_html(io.StringIO(html))[0]
    status, hhtml, hmeta = get(WIKI_HIST_URL, headers=UA)
    assert status == 200, status
    chg = pd.read_html(io.StringIO(hhtml))[0]
    chg.columns = ["date", "add_ticker", "add_name", "rem_ticker", "rem_name", "reason", "refs"][:len(chg.columns)]
    chg["date"] = pd.to_datetime(chg["date"], format="%B %d, %Y", errors="coerce")
    chg.to_csv(RAW / "s01_wiki_changes.csv", index=False)
    print(f"[wiki] 目前表 {len(cur)} 列；異動表 {len(chg)} 列，最早 {chg['date'].min().date()}，最新 {chg['date'].max().date()}"
          f"；抓取 {wmeta['fetched_at']}")
    per_year = chg.groupby(chg["date"].dt.year).size()
    print("[wiki] 每年異動列數（看早年是否稀疏）:", per_year.loc[1996:2026].to_dict() if len(per_year) else {})

    # ---------- 3. spot checks
    print("\n[抽查] 代號 事件 真值 | fja05680 | 誤差天 | wiki | 誤差天")
    out = []
    for tk, ev, truth, aliases, why in KNOWN:
        t = date.fromisoformat(truth)
        trs = [d for e, d in transitions(now_rows, aliases) if e == ev]
        fja = min(trs, key=lambda d: abs((d - t).days)) if trs else None
        col = "add_ticker" if ev == "add" else "rem_ticker"
        names = {a.replace("-", ".") for a in aliases} | set(aliases)
        w = chg[chg[col].astype(str).str.upper().isin(names)]["date"].dropna()
        wd = min(w, key=lambda d: abs((d.date() - t).days)).date() if len(w) else None
        e1 = (fja - t).days if fja else None
        e2 = (wd - t).days if wd else None
        print(f"  {tk:6} {ev:6} {truth} | {fja} | {e1} | {wd} | {e2}")
        out.append(dict(ticker=tk, event=ev, truth=truth, fja=fja, fja_err_days=e1, wiki=wd, wiki_err_days=e2, basis=why))
    pd.DataFrame(out).to_csv(RAW / "s01_spot_checks.csv", index=False)

    # ---------- 4. price coverage per year (LEAN folder = Yahoo cache)
    daily = LEAN / "equity" / "usa" / "daily"
    have = {p.stem.upper() for p in daily.glob("*.zip")}
    missing_marked = {p.stem.upper() for p in (LEAN / ".cache").glob("*.missing")}
    cov = []
    for y in range(1997, 2027):
        cands = [(d, m) for d, m in now_rows if d.year == y]
        if not cands:
            continue
        d, m = cands[0]
        n_have = sum(1 for t in m if t in have)
        cov.append(dict(year=y, as_of=d, members=len(m), with_price=n_have, share=round(n_have / len(m), 3),
                        marked_missing=sum(1 for t in m if t in missing_marked),
                        with_weight=_weights(d), weight_share=round(_weights(d) / len(m), 3)))
    cov = pd.DataFrame(cov)
    cov.to_csv(RAW / "s01_price_coverage.csv", index=False)
    print("\n[價格覆蓋] 每年第一筆名單中，LEAN 資料夾（Yahoo）有價格的比例")
    print(cov.to_string(index=False))

    # 缺價格的是哪些：最新名單外的（下市／改名）
    latest = now_rows[-1][1]
    all_ever = set().union(*[m for _, m in now_rows])
    gone = all_ever - latest
    print(f"\n[代號] 1996 起出現過 {len(all_ever)} 個代號，目前名單 {len(latest)}，已離開 {len(gone)}；"
          f"已離開者有價格 {len(gone & have)}（{len(gone & have)/len(gone):.0%}）")
    pd.Series(sorted(gone - have)).to_csv(RAW / "s01_gone_without_price.csv", index=False, header=["ticker"])

    # ---------- 4b. 目前成分股：Wikipedia「Date added」vs fja 最後一次加入日（大量比對）
    rows = []
    for _, r in cur.iterrows():
        tk = str(r["Symbol"]).upper()
        da = pd.to_datetime(r["Date added"], errors="coerce")
        if pd.isna(da) or da.year < 1997:
            continue
        adds = [d for e, d in transitions(now_rows, [tk, tk.replace(".", "-")]) if e == "add"]
        if not adds:
            rows.append(dict(ticker=tk, wiki_added=da.date(), fja_added=None, diff=None)); continue
        fa = adds[-1]
        rows.append(dict(ticker=tk, wiki_added=da.date(), fja_added=fa, diff=(fa - da.date()).days))
    da = pd.DataFrame(rows)
    da.to_csv(RAW / "s01_date_added_compare.csv", index=False)
    d = da["diff"].dropna()
    print(f"\n[加入日大量比對] 目前成分股中 Wikipedia 加入日 ≥1997 的 {len(da)} 檔；fja 找不到加入紀錄 {da['fja_added'].isna().sum()} 檔")
    print(f"  差 0 天 {int((d==0).sum())}；1～3 天 {int(((d.abs()>=1)&(d.abs()<=3)).sum())}；4～31 天 {int(((d.abs()>3)&(d.abs()<=31)).sum())}；>31 天 {int((d.abs()>31).sum())}")
    for y0, y1 in [(1997, 2008), (2009, 2015), (2016, 2026)]:
        sub = da[(pd.to_datetime(da.wiki_added).dt.year >= y0) & (pd.to_datetime(da.wiki_added).dt.year <= y1)]["diff"].dropna()
        if len(sub):
            print(f"  {y0}–{y1}: n={len(sub)} 差 0 天 {(sub==0).mean():.0%}，|差|≤3 天 {(sub.abs()<=3).mean():.0%}，|差|>31 天 {(sub.abs()>31).sum()}")
    print("  |差|>31 天的例子:", da[da["diff"].abs() > 31].head(12).to_dict("records"))

    # ---------- 5. current list fja vs wiki
    wiki_now = {str(s).upper().replace("-", ".") for s in cur["Symbol"]}
    fja_now = {s.replace("-", ".") for s in latest}
    print(f"\n[目前名單] fja 最新列 {now_rows[-1][0]}：{len(fja_now)} 檔；wiki {len(wiki_now)} 檔；"
          f"只在 fja {sorted(fja_now - wiki_now)}；只在 wiki {sorted(wiki_now - fja_now)}")


def other_github():
    """6. 其他 GitHub 整理：hanshof（fja 同格式，Wikipedia 爬蟲）、lawcal（Wikipedia 每日快照＋CIK，2007 起）。"""
    H = {"User-Agent": "research"}
    st, b, _ = get("https://raw.githubusercontent.com/hanshof/sp500_constituents/main/sp_500_historical_components.csv", headers=H)
    han = load_fja(b)
    st, lb, _ = get("https://raw.githubusercontent.com/lawcal/sp500-components-history/main/data/components_history.csv", headers=H)
    (RAW / "s01_lawcal_components_history.csv").write_text(lb, encoding="utf-8")
    law = pd.read_csv(io.StringIO(lb), dtype=str)
    print(f"\n[其他來源] hanshof {len(han)} 列，{han[0][0]} → {han[-1][0]}；lawcal {len(law)} 列（代號×CIK×加入／剔除日），"
          f"created_at 最早 {law.created_at.min()}，最新 {law.created_at.max()}；帶 * 的日期＝lawcal 自己標「不確定」"
          f" {int(law.date_added.str.contains('[*]', na=False).sum() + law.date_removed.str.contains('[*]', na=False).sum())} 個")
    print("  代號 事件 真值 | hanshof 誤差 | lawcal 日期 誤差")
    for tk, ev, truth, aliases, _ in KNOWN:
        t = date.fromisoformat(truth)
        trs = [d for e, d in transitions(han, aliases) if e == ev]
        h = min(trs, key=lambda d: abs((d - t).days)) if trs else None
        col = "date_added" if ev == "add" else "date_removed"
        ls = law[law.symbol.isin([a.replace("-", ".") for a in aliases])][col].dropna().str.rstrip("*")
        ld = [date.fromisoformat(x) for x in ls if re.match(r"\d{4}-\d\d-\d\d$", x)]
        l = min(ld, key=lambda d: abs((d - t).days)) if ld else None
        print(f"  {tk:6} {ev:6} {truth} | {(h - t).days if h else None} | {l} {(l - t).days if l else None}")


if __name__ == "__main__":
    import re  # noqa: E402
    import sys
    if len(sys.argv) > 1 and sys.argv[1] == "others":
        other_github()
        sys.exit()
    main()
    other_github()
