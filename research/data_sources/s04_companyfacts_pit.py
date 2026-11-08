"""驗證 3b：XBRL companyfacts／frames 能不能還原「某一天當時看得到的數字」。

做什麼：
  1. 對有重編（8-K 4.02）的公司，取幾個概念，列出同一個會計期間（start, end）在不同申報裡的值：
     如果 companyfacts 保留修正前與修正後兩個值，就能用「filed ≤ as_of 的最早／最新申報」還原當時的數字。
  2. frames API（/api/xbrl/frames/us-gaap/{concept}/USD/CY2017.json）回傳的是哪一個值（原始或重編後）。
  3. 統計：在這些公司的所有 USD 概念裡，同一期間有 ≥2 個不同值的比例（修正很常見還是罕見）。
  4. 每筆欄位：accn、fy、fp、form、filed、frame。

用法：
  uv run python research/data_sources/s04_companyfacts_pit.py [CIK ...]
  不給參數時用預設名單（Molson Coors 2019 年重編等，見 CASES）。
輸出：stdout；raw/s04_restated_periods.csv
"""
from __future__ import annotations

import sys

import pandas as pd

from common import RAW, cik10, sec_json

# (CIK, 名稱, 重編說明, 要看的概念)
CASES = [
    (24545, "Molson Coors (TAP)", "8-K 4.02 2019-02：重編 2016–2017（所得稅）",
     ["IncomeTaxExpenseBenefit", "NetIncomeLoss", "ProfitLoss"]),
    (1637459, "Kraft Heinz (KHC)", "2019 年重編 2016–2018（供應商回扣）",
     ["CostOfGoodsAndServicesSold", "NetIncomeLoss", "CostOfRevenue"]),
]


def facts_df(cik: int) -> pd.DataFrame:
    cf = sec_json(f"https://data.sec.gov/api/xbrl/companyfacts/CIK{cik10(cik)}.json")
    rows = []
    for tax, concepts in cf["facts"].items():
        for con, node in concepts.items():
            for unit, arr in node["units"].items():
                for r in arr:
                    rows.append(dict(tax=tax, concept=con, unit=unit, **r))
    df = pd.DataFrame(rows)
    df["filed"] = pd.to_datetime(df["filed"])
    return df


def main():
    extra = [(int(c), f"CIK {c}", "命令列指定", None) for c in sys.argv[1:]]
    out = []
    for cik, name, why, concepts in CASES + extra:
        df = facts_df(cik)
        usd = df[df.unit == "USD"].copy()
        usd["start"] = usd["start"].fillna("")
        g = usd.groupby(["concept", "start", "end"])["val"].nunique()
        multi = g[g > 1]
        share = len(multi) / len(g)
        print(f"\n=== {name}（{why}）：USD 事實 {len(usd)} 筆、{len(g)} 個（概念×期間）；"
              f"同一期間有 ≥2 個不同值的 {len(multi)} 個（{share:.1%}）")
        print("欄位：", list(df.columns))
        show = concepts or list(multi.reset_index().concept.value_counts().index[:3])
        for con in show:
            sub = usd[usd.concept == con]
            if sub.empty:
                print(f"  {con}: 無")
                continue
            periods = multi.loc[con].index.tolist() if con in multi.index.get_level_values(0) else []
            for st, en in periods[:4]:
                p = sub[(sub.start == st) & (sub.end == en)].sort_values("filed")
                print(f"  {con} {st}→{en}:")
                print(p[["val", "filed", "form", "fy", "fp", "frame", "accn"]].to_string(index=False))
                out.append(dict(cik=cik, concept=con, start=st, end=en, n_values=p.val.nunique(),
                                first_val=p.val.iloc[0], first_filed=p.filed.iloc[0].date(),
                                last_val=p.val.iloc[-1], last_filed=p.filed.iloc[-1].date(),
                                frame_on=p[p.frame.notna()].accn.tolist()))
            # frames：看 CY 年度值是哪一個
            fy_periods = [(s, e) for s, e in periods if s and (pd.Timestamp(e) - pd.Timestamp(s)).days > 350]
            for st, en in fy_periods[:2]:
                cy = f"CY{pd.Timestamp(en).year if pd.Timestamp(en).month >= 7 else pd.Timestamp(en).year - 1}"
                fr = sec_json(f"https://data.sec.gov/api/xbrl/frames/us-gaap/{con}/USD/{cy}.json")
                if fr:
                    hit = [d for d in fr["data"] if d["cik"] == cik]
                    print(f"  frames {con} {cy}: {hit}")
    pd.DataFrame(out).to_csv(RAW / "s04_restated_periods.csv", index=False)


if __name__ == "__main__":
    main()
