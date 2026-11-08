"""驗證 4：FRED／ALFRED 的 vintage（point-in-time）與實際可得期間。

做什麼（每個系列）：
  1. fred/series：觀測期間、頻率、最後更新。
  2. fred/series/vintagedates：第一個 vintage 日期、vintage 數。
  3. 用 realtime_start = realtime_end = 某一天，取「那天看得到的」觀測值，和今天的值比（修正幅度）。
  4. BAMLH0A0HYM2（ICE 授權）：現在 FRED 給到哪天開始；舊 vintage 裡是否還保留更長的歷史。
  5. output_type=2（每個 vintage 一欄）／4（只要首次公布值）是否可用。

用法：
  uv run python research/data_sources/s05_fred_alfred.py
  （FRED_API_KEY 從 TradingAgents/.env 讀，不印出；快取檔名不含 key）
輸出：stdout；raw/s05_fred_summary.csv
"""
from __future__ import annotations

import json

import pandas as pd

from common import RAW, env, get, redact

KEY = env("FRED_API_KEY")
BASE = "https://api.stlouisfed.org/fred"
SERIES = ["BAA10Y", "NFCI", "ICSA", "UNRATE", "INDPRO", "BAMLH0A0HYM2", "T10Y2Y", "T10Y3M", "VIXCLS",
          "SAHMREALTIME", "PAYEMS", "BAMLH0A2HYB", "BAMLC0A0CM"]


def fred(path: str, **params):
    q = "&".join(f"{k}={v}" for k, v in params.items())
    url = f"{BASE}/{path}?{q}&file_type=json&api_key={KEY}"
    st, body, _ = get(url, min_interval=0.6)
    if st != 200:
        return {"error": st, "body": redact(body[:300])}
    return json.loads(body)


def obs(sid, **kw):
    j = fred("series/observations", series_id=sid, **kw)
    if "observations" not in j:
        return pd.DataFrame(), j
    df = pd.DataFrame(j["observations"])
    if not df.empty and "value" in df:
        df["value"] = pd.to_numeric(df["value"], errors="coerce")
    return df, j


def main():
    rows = []
    for sid in SERIES:
        info = fred("series", series_id=sid)
        s = info.get("seriess", [{}])[0] if "seriess" in info else {}
        vd = fred("series/vintagedates", series_id=sid, limit=10000)
        vds = vd.get("vintage_dates", [])
        cur, _ = obs(sid)
        first_obs = cur["date"].iloc[0] if len(cur) else None
        row = dict(series=sid, freq=s.get("frequency_short"), obs_start_meta=s.get("observation_start"),
                   obs_end=s.get("observation_end"), last_updated=s.get("last_updated"),
                   first_obs_now=first_obs, n_obs_now=len(cur), first_vintage=vds[0] if vds else None,
                   n_vintages=len(vds), vintage_error=vd.get("error"))
        # 2008-10-15 那天看得到的資料
        for asof in ["2008-10-15", "2020-04-15", "2024-01-02"]:
            df, j = obs(sid, realtime_start=asof, realtime_end=asof)
            ok = df.dropna(subset=["value"]) if len(df) else df
            row[f"asof_{asof}_last_obs"] = ok["date"].iloc[-1] if len(ok) else (j.get("error") or "none")
            row[f"asof_{asof}_first_obs"] = ok["date"].iloc[0] if len(ok) else None
            if len(ok):
                d, v = ok["date"].iloc[-1], ok["value"].iloc[-1]
                now = cur[cur.date == d]["value"]
                row[f"asof_{asof}_value"] = v
                row[f"asof_{asof}_value_now"] = float(now.iloc[0]) if len(now) and pd.notna(now.iloc[0]) else None
        rows.append(row)
        print(sid, {k: v for k, v in row.items() if k != "series"})
    df = pd.DataFrame(rows)
    df.to_csv(RAW / "s05_fred_summary.csv", index=False)

    # output_type 測試（UNRATE 2008 年）
    for ot in (2, 4):
        d, j = obs("UNRATE", observation_start="2008-06-01", observation_end="2008-12-01",
                   realtime_start="2008-06-01", realtime_end="2009-12-31", output_type=ot)
        print(f"\n[UNRATE output_type={ot}] 欄位 {list(d.columns)[:8]}… 共 {d.shape}；錯誤 {j.get('error')}")
        print(d.head(3).to_string()[:800])

    # BAMLH0A0HYM2 舊 vintage 的歷史長度
    print("\n[BAMLH0A0HYM2 不同 vintage 的第一筆觀測]")
    for asof in ["2015-01-02", "2020-01-02", "2023-01-03", "2025-06-02", "2026-03-02", "2026-05-01", "2026-11-06"]:
        d, j = obs("BAMLH0A0HYM2", realtime_start=asof, realtime_end=asof)
        dd = d.dropna(subset=["value"]) if len(d) else d
        print(f"  as of {asof}: {len(dd)} 筆，{dd['date'].iloc[0] if len(dd) else j.get('error')} → "
              f"{dd['date'].iloc[-1] if len(dd) else ''}")

    # ICSA 修正幅度：2020-03-21 那週初值 vs 現值
    d, _ = obs("ICSA", observation_start="2020-03-14", observation_end="2020-04-11",
               realtime_start="2020-01-01", realtime_end="9999-12-31")
    print("\n[ICSA 2020-03／04 各 vintage 的值]")
    print(d[["date", "realtime_start", "realtime_end", "value"]].to_string(index=False)[:2500])


if __name__ == "__main__":
    main()
