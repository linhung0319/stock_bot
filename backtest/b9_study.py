"""B-9 事件研究（由 b9_events.py study|jump 呼叫）。

study：每個事件從第一個可交易開盤（acceptanceDateTime 換成美東後判斷）買進，持有 63／126／252 個交易日
       （約 3、6、12 個月）到收盤；相對 SPY、相對 SPDR 產業 ETF、相對同月配對組（同一市值五分位 × 同一 252 日
       報酬五分位、±365 天內沒有同類事件的 S&P 500 成分股，同一個買進日與賣出日）。
       觀察期內下市（價格資料中斷）的，報酬算到最後一個有價格的交易日（SPY、產業 ETF、配對組也算到同一天）。
       兩組：ALL（事件當時在 S&P 500）、TOP50（事件當月在動能股票池＝市值前 50）。
jump：每月換股日（第一個交易日）的橫斷面：ONE_OFF_JUMP 規則版本（最大單日／3 日占 12 個月對數報酬的比例
       > 門檻，且該日之後 63 個交易日相對 SPY ≤ 0，而且這 63 天在決策日以前已經走完）與資訊離散度 ID。
"""
from __future__ import annotations

import pickle
import sys
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import b9_common as C  # noqa: E402
from momentum_backtest import DEFAULT_LEAN, LeanData  # noqa: E402

GROUP_DEFS = [
    # (標籤, 篩選函式)
    ("4.02 財報不可信賴", lambda e: e.cls == "ACC_402"),
    ("4.01 會計師辭任", lambda e: (e.cls == "ACC_401") & (e["sub"] == "RESIGN")),
    ("4.01 公司解任（含只公告新會計師）", lambda e: (e.cls == "ACC_401") & e["sub"].isin(["DISMISS", "MIXED", "UNKNOWN", "NEW_ONLY"])),
    ("4.01 排除項（退休計畫、合併後統一、同網路轉所）", lambda e: (e.cls == "ACC_401") & e["sub"].isin(["PLAN", "MERGER", "NETWORK"])),
    ("4.01 全部", lambda e: e.cls == "ACC_401"),
    ("NT 10-K", lambda e: (e.cls == "ACC_NT") & (e["sub"] == "NT 10-K")),
    ("NT 10-Q", lambda e: (e.cls == "ACC_NT") & (e["sub"] == "NT 10-Q")),
    ("NT 全部", lambda e: e.cls == "ACC_NT"),
    ("ACCOUNTING 嚴格（4.02＋NT＋4.01 辭任）", lambda e: (e.cls.isin(["ACC_402", "ACC_NT"])) | ((e.cls == "ACC_401") & (e["sub"] == "RESIGN"))),
    ("被收購（規則判定）", lambda e: e.cls == "PENDING_MA"),
    ("被收購：事後 18 個月內離開指數", lambda e: (e.cls == "PENDING_MA") & (e.completed_expost == True)),  # noqa: E712
    ("被收購：沒有離開指數", lambda e: (e.cls == "PENDING_MA") & (e.completed_expost == False)),  # noqa: E712
    ("合併申報：收購方或不明（對照）", lambda e: e.cls == "MA_OTHER"),
    ("增資：普通股 424B（全部）", lambda e: (e.cls == "DILUTION") & (e["sub"] == "EQUITY")),
    ("增資：普通股 ≥ 5% 市值", lambda e: (e.cls == "DILUTION") & (e["sub"] == "EQUITY") & (e["size"] >= 0.05)),
    ("增資：普通股 2～5%", lambda e: (e.cls == "DILUTION") & (e["sub"] == "EQUITY") & (e["size"] >= 0.02) & (e["size"] < 0.05)),
    ("增資：普通股 < 2%", lambda e: (e.cls == "DILUTION") & (e["sub"] == "EQUITY") & (e["size"] < 0.02)),
    ("增資：普通股 規模不明", lambda e: (e.cls == "DILUTION") & (e["sub"] == "EQUITY") & e["size"].isna()),
    ("增資：普通股 ATM 計畫", lambda e: (e.cls == "DILUTION") & (e["sub"] == "EQUITY") & (e.atm == True)),  # noqa: E712
    ("增資：可轉債", lambda e: (e.cls == "DILUTION") & (e["sub"] == "CONVERTIBLE")),
    ("8-K 3.02 未登記股票發行", lambda e: e.cls == "DILUTION_302"),
    ("S-3／S-3ASR 儲架登記（對照）", lambda e: e.cls == "SHELF_S3"),
]
SAME_CLASS = {"ACC_402": "ACC", "ACC_401": "ACC", "ACC_NT": "ACC", "PENDING_MA": "MA", "MA_OTHER": "MA",
              "DILUTION": "DIL", "DILUTION_302": "DIL", "SHELF_S3": "S3"}


class Ctx:
    def __init__(self):
        self.p = C.load_panel()
        self.days = self.p["days"]
        self.adj = self.p["adj"]
        self.open = self.p["open"]
        self.A = self.adj.to_numpy(dtype=float)
        self.O = self.open.to_numpy(dtype=float)
        self.cols = {t: k for k, t in enumerate(self.adj.columns)}
        # 最後一個有價格的位置（下市判斷）
        valid = ~np.isnan(self.A)
        self.last_valid = np.where(valid.any(0), len(self.days) - 1 - np.argmax(valid[::-1], axis=0), -1)
        self.Aff = pd.DataFrame(self.A).ffill().to_numpy()
        self.spy = self.cols["SPY"]
        etf = C.sector_etfs()
        self.etf_c = etf["Close"].reindex(self.days)
        self.etf_o = etf["Open"].reindex(self.days)
        self.lean = LeanData(DEFAULT_LEAN)
        self._cons = {}
        ranks = pickle.loads((C.DATA / "b2_ranks_data-sp500-long_off0.pkl").read_bytes())
        self.ranks = ranks
        self.rdays = pd.DatetimeIndex(sorted(ranks))

    def cons(self, day):
        f = self.lean.files[self.lean.files < day][-1]
        if f not in self._cons:
            self._cons[f] = self.lean.constituents(f)
        return self._cons[f]

    def window_ret(self, col: int, i0: int, h: int):
        """col 在 i0 開盤買進、持有 h 天（到 i0+h-1 收盤）。回傳 (報酬, 實際結束位置, 是否下市, 是否可觀察)。"""
        i1 = i0 + h - 1
        if i1 >= len(self.days):
            return np.nan, None, False, False
        o = self.O[i0, col]
        if not np.isfinite(o) or o <= 0:
            return np.nan, None, False, True
        lv = self.last_valid[col]
        delisted = lv < i1 and lv < len(self.days) - 1
        end = min(i1, lv) if delisted else i1
        c = self.Aff[end, col]
        return c / o - 1, end, delisted, True

    def bench_ret(self, col, i0, end):
        return self.Aff[end, col] / self.O[i0, col] - 1

    def mom(self, col, i):
        if i - 253 < 0:
            return np.nan
        a, b = self.A[i - 1, col], self.A[i - 253, col]
        return a / b - 1 if np.isfinite(a) and np.isfinite(b) and b > 0 else np.nan


def quint(x: pd.Series, q=5):
    return pd.qcut(x.rank(method="first"), q, labels=False)


def do_study():
    X = Ctx()
    ev = pd.read_csv(C.OUT / "B9_events.csv", dtype={"cik": str})
    ev["avail"] = pd.to_datetime(ev["avail"])
    ev = ev[ev.avail.notna() & (ev.avail >= C.START)].copy()
    ev["fam"] = ev.cls.map(SAME_CLASS)
    # 每個 CIK、每一類的事件日（±365 天內有同類事件的不當配對組）
    tick_events = ev.groupby(["fam", "ticker"]).avail.apply(list).to_dict()
    # 代號重用檢查：被收購且已離開指數的公司，若同一代號的價格在離開指數 180 天後仍持續，
    # 代表 Yahoo 把別家公司（之後用同一代號）的價格接在一起（例：MWW→MNST、SNDK、CSRA），事件報酬不可信 → 排除
    m = C.cik_map()
    gone = m.assign(vt=pd.to_datetime(m.valid_to)).groupby("cik").vt.max()
    last_px = {t: X.adj[t].last_valid_index() for t in X.adj.columns}
    ev["reuse_suspect"] = [bool(c == "PENDING_MA" and done == True and t in last_px and last_px[t] is not None and  # noqa: E712
                                (last_px[t] - gone.get(k, last_px[t])).days > 180)
                           for c, done, t, k in zip(ev.cls, ev.completed_expost, ev.ticker, ev.cik)]
    rows = []
    month_cache = {}
    for k, e in enumerate(ev.itertuples(index=False)):
        i0 = X.days.searchsorted(e.avail)
        col = X.cols.get(e.ticker)
        has_price = col is not None and i0 < len(X.days) and bool(np.isfinite(X.O[i0, col]))
        base = dict(cls=e.cls, sub=e.sub, ticker=e.ticker, cik=e.cik,
                    filingDate=e.filingDate, avail=e.avail.date(), has_price=has_price)
        fam = SAME_CLASS[e.cls]
        bad = {t for (f_, t), ds in tick_events.items() if f_ == fam and any(abs((d - e.avail).days) <= 365 for d in ds)}
        # 月橫斷面（S&P 成分股、市值與動能五分位）
        mkey = (e.avail.to_period("M"), i0)
        if mkey not in month_cache:
            cons = X.cons(e.avail)
            cs = pd.DataFrame([(t, w) for t, w in cons.items() if t in X.cols], columns=["t", "w"]).set_index("t")
            cs["mom"] = [X.mom(X.cols[t], i0) for t in cs.index]
            cs = cs.dropna()
            cs["cq"] = quint(cs.w)
            cs["mq"] = quint(cs.mom)
            r_i = X.rdays[X.rdays <= e.avail]
            top = X.ranks[r_i[-1]] if len(r_i) else pd.Series(dtype=float)
            month_cache[mkey] = (cs, top)
        cs, top = month_cache[mkey]
        base["top50"] = e.ticker in top.index
        base["top5"] = e.ticker in list(top.index[:5])
        base["top15"] = e.ticker in list(top.index[:15])
        base["sector"] = C.sic_to_etf(None if pd.isna(e.sic) else str(int(e.sic)), e.avail)
        for hname, h in C.HORIZONS.items():
            r = dict(base, horizon=hname)
            if not base["has_price"]:
                rows.append(dict(r, status="no_price"))
                continue
            if e.reuse_suspect:
                rows.append(dict(r, status="ticker_reuse"))
                continue
            ret, end, dl, obs = X.window_ret(col, i0, h)
            if not obs:
                rows.append(dict(r, status="not_yet"))
                continue
            spy = X.bench_ret(X.spy, i0, end)
            r.update(status="delisted" if dl else "ok", ret=ret, spy=spy, rel_spy=(1 + ret) / (1 + spy) - 1)
            sec = base["sector"]
            if sec and sec in X.etf_c and np.isfinite(X.etf_o[sec].iloc[i0]) and np.isfinite(X.etf_c[sec].iloc[end]):
                sr = X.etf_c[sec].iloc[end] / X.etf_o[sec].iloc[i0] - 1
                r["rel_sector"] = (1 + ret) / (1 + sr) - 1
            # 配對組：ALL 用同一市值 × 動能五分位；TOP50 用同月前 50 的其他股票、同一動能半邊
            if e.ticker in cs.index:
                me = cs.loc[e.ticker]
                ctrl = cs[(cs.cq == me.cq) & (cs.mq == me.mq) & ~cs.index.isin(bad)].index
            else:
                ctrl = []
            r["ctrl_rel"], r["ctrl_n"], r["ctrl_under"] = ctrl_stats(X, ctrl, i0, end)
            if base["top50"]:
                tm = top.drop(e.ticker, errors="ignore")
                half = tm >= tm.median()
                mine = top.get(e.ticker) >= tm.median()
                ctrl50 = [t for t in tm.index[half == mine] if t not in bad]
                r["ctrl50_rel"], r["ctrl50_n"], _ = ctrl_stats(X, ctrl50, i0, end)
            rows.append(r)
        if k % 500 == 0:
            print(f"  {k}/{len(ev)}", flush=True)
    rr = pd.DataFrame(rows)
    rr["abn"] = rr.rel_spy - rr.ctrl_rel
    rr["abn50"] = rr.rel_spy - rr.get("ctrl50_rel")
    rr.to_csv(C.OUT / "B9_event_rows.csv", index=False)
    summarize(rr, ev)


def ctrl_stats(X: Ctx, tickers, i0, end):
    vals = []
    for t in tickers:
        c = X.cols[t]
        o = X.O[i0, c]
        if not np.isfinite(o) or o <= 0:
            continue
        lv = X.last_valid[c]
        e2 = min(end, lv)
        r = X.Aff[e2, c] / o - 1
        s = X.Aff[e2, X.spy] / X.O[i0, X.spy] - 1
        vals.append((1 + r) / (1 + s) - 1)
    if not vals:
        return np.nan, 0, np.nan
    v = np.array(vals)
    return float(np.median(v)), len(v), float((v < 0).mean())


def summarize(rr: pd.DataFrame, ev: pd.DataFrame):
    # rr 的 sub/cls 欄位重建篩選需要的欄位
    extra = ev.drop_duplicates(["cls", "ticker", "filingDate"]).set_index(["cls", "ticker", "filingDate"])[["size", "atm", "completed_expost"]]
    rr = rr.join(extra, on=["cls", "ticker", "filingDate"])
    out = []
    for label, f in GROUP_DEFS:
        for grp in ("ALL", "TOP50"):
            for hname in C.HORIZONS:
                g = rr[(rr.horizon == hname) & f(rr)]
                if grp == "TOP50":
                    g = g[g.top50 == True]  # noqa: E712
                n_events = len(g)
                ok = g[g.status.isin(["ok", "delisted"])]
                n = len(ok)
                row = dict(group=label, universe=grp, horizon=hname, n_events=n_events,
                           n_noprice=int(g.status.isin(["no_price", "ticker_reuse"]).sum()), n_reuse=int((g.status == "ticker_reuse").sum()), n_notyet=int((g.status == "not_yet").sum()),
                           n=n, n_delisted=int((ok.status == "delisted").sum()), n_firms=ok.cik.nunique())
                if n:
                    x = ok.rel_spy.to_numpy()
                    row.update(med_rel=np.median(x), med_lo=C.boot_ci(x)[0], med_hi=C.boot_ci(x)[1],
                               mean_rel=x.mean(), mean_lo=C.boot_ci(x, np.mean)[0], mean_hi=C.boot_ci(x, np.mean)[1])
                    k = int((x < 0).sum())
                    pm, plo, phi, pgt = C.beta_post(k, n)
                    row.update(k_under=k, p_under=pm, p_under_lo=plo, p_under_hi=phi, P_under_gt_half=pgt)
                    a = (ok.abn if grp == "ALL" else ok.abn50).dropna().to_numpy()
                    if len(a):
                        row.update(n_abn=len(a), med_abn=np.median(a), abn_lo=C.boot_ci(a)[0], abn_hi=C.boot_ci(a)[1],
                                   mean_abn=a.mean(), mabn_lo=C.boot_ci(a, np.mean)[0], mabn_hi=C.boot_ci(a, np.mean)[1])
                        ka = int((a < 0).sum())
                        pm, plo, phi, pgt = C.beta_post(ka, len(a))
                        row.update(p_below_ctrl=pm, p_below_ctrl_lo=plo, p_below_ctrl_hi=phi, P_below_ctrl_gt_half=pgt)
                    row["ctrl_under_base"] = ok.ctrl_under.mean()
                    s = ok.rel_sector.dropna()
                    row.update(n_sector=len(s), med_rel_sector=s.median() if len(s) else np.nan)
                out.append(row)
    res = pd.DataFrame(out)
    res.to_csv(C.OUT / "B9_event_study.csv", index=False)
    print(res[(res.horizon == "6m")][["group", "universe", "n", "n_delisted", "med_rel", "med_abn", "p_under", "p_below_ctrl"]].to_string())


# ---------------------------------------------------------------- jump / ID

THRESH = [0.3, 0.4, 0.5, 0.6, 0.7]


def do_jump():
    X = Ctx()
    spy = X.adj["SPY"]
    rows = []
    rdays = [d for d in X.rdays if d >= C.START]
    for d in rdays:
        i = X.days.searchsorted(d)
        cons = X.cons(d)
        top = X.ranks[d]
        order = list(top.index)
        for t in cons:
            if t not in X.cols:
                continue
            col = X.cols[t]
            if not np.isfinite(X.O[i, col]):
                continue
            jm = C.jump_metrics(X.adj[t], spy, i - 1)
            if jm is None or jm["r12"] <= 0:
                continue
            r = dict(date=d.date(), ticker=t, in_top50=t in top.index, rank=order.index(t) + 1 if t in top.index else np.nan, **jm)
            for hname, h in C.HORIZONS.items():
                ret, end, dl, obs = X.window_ret(col, i, h)
                if not obs or not np.isfinite(ret):
                    continue
                s = X.bench_ret(X.spy, i, end)
                r[f"rel_{hname}"] = (1 + ret) / (1 + s) - 1
                r[f"dl_{hname}"] = dl
            rows.append(r)
        print(f"  {d.date()} {len(rows)}", flush=True) if d.month == 1 else None
    df = pd.DataFrame(rows)
    df.to_csv(C.DATA / "B9_jump_rows.csv", index=False)  # 13 MB，放 backtest/data（不 commit）
    summarize_jump(df)


def jump_flags(df: pd.DataFrame):
    flags = {}
    for k in ("j1", "j3"):
        for th in THRESH:
            flags[f"{k}>{int(th*100)}%＋事後≤0"] = (df[f"{k}_share"] > th) & (df[f"{k}_post"] <= 0)
            flags[f"{k}>{int(th*100)}%（不看事後）"] = df[f"{k}_share"] > th
    # 資訊離散度：同一天、同一群內 ID 最高的五分之一（離散型）
    return flags


def summarize_jump(df: pd.DataFrame):
    out = []
    pops = {"S&P 500（12 個月報酬 > 0）": df, "動能股票池（前 50）": df[df.in_top50], "前 15 名": df[df["rank"] <= 15],
            "前 5 名": df[df["rank"] <= 5]}
    for pname, g in pops.items():
        g = g.copy()
        g["id_q5"] = g.groupby("date").id.transform(lambda s: s.rank(pct=True) > 0.8)
        fl = jump_flags(g)
        fl["ID 最高五分之一（離散）"] = g.id_q5
        for fname, f in fl.items():
            for hname in C.HORIZONS:
                col = f"rel_{hname}"
                sub = g[g[col].notna()]
                hit = sub[f.loc[sub.index]]
                non = sub[~f.loc[sub.index]]
                row = dict(population=pname, flag=fname, horizon=hname, n=len(sub), n_hit=len(hit),
                           hit_rate=len(hit) / len(sub) if len(sub) else np.nan, months_with_hit=hit.date.nunique())
                if len(hit) >= 1:
                    # 同月差：每月（命中平均 − 未命中平均），再對有命中的月份平均；以月重抽
                    mm = sub.assign(h=f.loc[sub.index]).groupby(["date", "h"])[col].mean().unstack()
                    if True in mm and False in mm:
                        diff = (mm[True] - mm[False]).dropna()
                        lo, hi = C.boot_ci(diff.to_numpy(), np.mean)
                        row.update(diff_mean=diff.mean(), diff_lo=lo, diff_hi=hi, n_months=len(diff))
                    x = hit[col].to_numpy()
                    k = int((x < 0).sum())
                    pm, plo, phi, pgt = C.beta_post(k, len(x))
                    y = non[col].to_numpy()
                    row.update(hit_med=np.median(x), non_med=np.median(y), hit_mean=x.mean(), non_mean=y.mean(),
                               p_under=pm, p_under_lo=plo, p_under_hi=phi, non_under=(y < 0).mean())
                out.append(row)
    res = pd.DataFrame(out)
    res.to_csv(C.OUT / "B9_jump_study.csv", index=False)
    print(res[res.horizon == "6m"].to_string())
