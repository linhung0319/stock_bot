"""
B-2：設計 v2 正式回測 —— VOO 核心 + 動能部位（緩衝區）+ 風險層。

規則（design_v2_momentum_2026-11-07.md §3、§4）：
  股票池  ：當月 S&P 500 成分股 → 股價 > 5 → 前一日成交金額前 100 → 市值前 50
  排名    ：252 個交易日還原權值報酬（MOMP），用換股日前一個交易日的收盤
  進出場  ：買排名前 5；持股排名掉出前 exit_rank 名（或掉出股票池）才賣；部位內等權
  換股日  ：每月第 offset+1 個交易日開盤成交（offset 用來檢查換股時點運氣）
  風險層  ：none           不減碼
            vol_thirds     依波動度減碼（Barroso & Santa-Clara 2015），w = min(1, 中位數 σ / σ)，無條件捨去到 1/3
            vol_raw        同上，不取整
            lights         三盞燈（French 資料，延遲 1 個月），w = 1 - 亮燈數/3
  核心    ：core 比例放 SPY（VOO 的代理，資料較長），動能部位減下來的也放 SPY
  交易方式：reset  每次換股日把所有部位拉回目標
            lazy   只做必要交易：換股、風險層比例改變、或某檔偏離目標超過 ±50%；SPY 吸收差額
  成本    ：每單位成交金額 5 bp

基準：SPY 買進持有。

驗證：offset=0、exit_rank=5、none、core=0、reset 應重現
lean_strategies/research/momentum_effect 的 16.8% 年化（pandas 版，已與 LEAN 逐月比對一致）。

資料：lean_strategies 的 LEAN 格式資料夾（data-sp500-long，1996 起 S&P 500 歷史成分股＋Yahoo 價格），唯讀。
三盞燈旗號：backtest/data/three_lights.csv（由 lean_strategies/research/momentum_effect/regimes.py 匯出）。

執行：
  uv run python backtest/momentum_backtest.py [--data <LEAN 資料夾>]

輸出（backtest/results/）：
  B2_results.csv          每組參數 × 期間
  B2_events.csv           每組參數在各崩盤事件中相對 SPY 的報酬
  B2_monthly_main.csv     主要方案的每月權重與報酬
  B2_trades_main.csv      主要方案的交易明細
  B2_summary.md           表格
"""
from __future__ import annotations

import argparse
import io
import itertools
import os
import pickle
import zipfile
from dataclasses import dataclass, asdict
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
DATA_DIR = HERE / "data"
OUT_DIR = HERE / "results"
DEFAULT_LEAN = HERE.parents[1] / "Stock" / "lean_strategies" / "data-sp500-long"

LOOKBACK, LIQUID, UNIVERSE, PORTFOLIO = 252, 100, 50, 5
FEE = 0.0005
START, END = "1997-02-01", "2026-09-15"
VOL_WINDOW, VOL_MIN_HISTORY = 126, 24
LAZY_BAND = 0.5

PERIODS = [("1998-02", "2026-09", "1998–2026"), ("2000-01", "2019-12", "2000–2019"),
           ("2008-01", "2026-09", "2008–2026"), ("2016-01", "2026-09", "2016–2026")]
EVENTS = {"2000 網路泡沫": ("2000-03", "2002-09"), "2008 金融海嘯": ("2008-07", "2009-12"),
          "2020–21 輪動": ("2020-09", "2022-01"), "2026-07 記憶體": ("2026-06", "2026-09")}


# ---------------------------------------------------------------- data

class LeanData:
    """LEAN 格式的日線、還原因子與 S&P 500 成分股檔（與 lean_strategies 的 long_backtest.py 同邏輯）。"""

    def __init__(self, folder: Path):
        self.root = Path(folder) / "equity" / "usa"
        files = sorted((self.root / "universes" / "etf" / "spy").glob("*.csv"))
        if not files:
            raise SystemExit(f"找不到成分股檔：{self.root}")
        self.files = pd.DatetimeIndex([pd.Timestamp(p.stem) for p in files])
        self._bars: dict[str, pd.DataFrame | None] = {}

    def bars(self, ticker: str) -> pd.DataFrame | None:
        if ticker in self._bars:
            return self._bars[ticker]
        path = self.root / "daily" / f"{ticker.lower()}.zip"
        bars = None
        if path.exists():
            with zipfile.ZipFile(path) as archive:
                raw = archive.read(archive.namelist()[0]).decode()
            bars = pd.read_csv(io.StringIO(raw), header=None,
                               names=["date", "open", "high", "low", "close", "volume"])
            bars.index = pd.to_datetime(bars.pop("date").astype(str).str[:8], format="%Y%m%d")
            bars[["open", "high", "low", "close"]] /= 10000.0
            factors = pd.read_csv(self.root / "factor_files" / f"{ticker.lower()}.csv", header=None,
                                  names=["date", "price", "split", "ref"])
            factors.index = pd.to_datetime(factors["date"].astype(str), format="%Y%m%d")
            scale = (factors["price"] * factors["split"]).sort_index()
            pos = scale.index.searchsorted(bars.index, side="left")
            factor = scale.iloc[np.minimum(pos, len(scale) - 1)].to_numpy()
            bars["adj"] = bars["close"] * factor
            bars["adj_open"] = bars["open"] * factor
            bars["momp"] = bars["adj"].pct_change(LOOKBACK, fill_method=None) * 100
        self._bars[ticker] = bars
        return bars

    def constituents(self, file_date):
        path = self.root / "universes" / "etf" / "spy" / f"{file_date:%Y%m%d}.csv"
        rows = [line.split(",") for line in path.read_text().splitlines() if line.strip()]
        return {r[0]: float(r[3]) for r in rows if r[3]}


def rank_universe(data: LeanData, day: pd.Timestamp) -> pd.Series:
    """換股日 day 開盤前可知的 50 檔股票池與 MOMP 排名（由高到低）。"""
    file_date = data.files[data.files < day][-1]
    rows = []
    for ticker, weight in data.constituents(file_date).items():
        b = data.bars(ticker)
        if b is None:
            continue
        i = b.index.searchsorted(day, side="left") - 1
        if i < 0:
            continue
        bar = b.iloc[i]
        dv = bar.close * bar.volume
        if bar.close > 5 and dv > 0:  # dv > 0 也排除 NaN（NaN 會讓排序默默出錯）
            rows.append((ticker, weight, dv, bar.momp))
    f = pd.DataFrame(rows, columns=["ticker", "weight", "dv", "momp"]).set_index("ticker")
    liquid = f.sort_values("dv", kind="stable").iloc[-LIQUID:]
    large = liquid.sort_values("weight", ascending=False, kind="stable").iloc[:UNIVERSE]
    return large["momp"].dropna().sort_values(ascending=False)


def rebalance_days(days: pd.DatetimeIndex, offset: int) -> list[pd.Timestamp]:
    out = []
    for _, g in pd.Series(days, index=days).groupby(days.to_period("M")):
        if len(g) > offset:
            out.append(g.iloc[offset])
    return [d for d in out if d >= pd.Timestamp(START)]


def load_ranks(data: LeanData, folder: Path, days, offset: int) -> dict:
    cache = DATA_DIR / f"b2_ranks_{Path(folder).name}_off{offset}.pkl"
    if cache.exists():
        return pickle.loads(cache.read_bytes())
    ranks = {}
    for d in rebalance_days(days, offset):
        ranks[d] = rank_universe(data, d)
    cache.write_bytes(pickle.dumps(ranks))
    print(f"  已建立排名快取 offset={offset}（{len(ranks)} 個月）", flush=True)
    return ranks


# ---------------------------------------------------------------- simulation

@dataclass(frozen=True)
class Config:
    offset: int = 0
    exit_rank: int = 10
    overlay: str = "vol_thirds"
    core: float = 0.6
    policy: str = "lazy"

    @property
    def tag(self):
        return f"off{self.offset}_exit{self.exit_rank}_{self.overlay}_core{int(self.core*100)}_{self.policy}"


class Prices:
    def __init__(self, data: LeanData, tickers, days):
        close, opn = {}, {}
        for t in tickers:
            b = data.bars(t)
            if b is None:
                continue
            close[t] = b["adj"]
            opn[t] = b["adj_open"]
        self.close = pd.DataFrame(close).reindex(days)
        self.open = pd.DataFrame(opn).reindex(days)
        # 下市後沒有價格：維持最後價格（與 lean_strategies 的做法相同），下次換股時賣出
        self.last_close = self.close.ffill()
        self.open = self.open.fillna(self.last_close.shift(1)).fillna(self.last_close)
        self.ret = self.close.pct_change(fill_method=None)


def excess_vol(prices: Prices, names, day) -> float:
    i = prices.close.index.searchsorted(day)
    window = prices.ret.iloc[max(0, i - VOL_WINDOW):i]
    ex = window[names].mean(axis=1) - window["SPY"]
    return float(ex.std() * np.sqrt(252))


def simulate(cfg: Config, ranks: dict, prices: Prices, lights: pd.Series | None):
    days = prices.close.index
    rdays = sorted(ranks)
    units: dict[str, float] = {"SPY": 1.0 / prices.open["SPY"].loc[rdays[0]]}  # 起始 1 元，先放 SPY
    held: list[str] = []
    w_prev = None
    vol_hist: list[float] = []
    trades, monthly = [], []
    pure_level, pure_hist = 1.0, []  # 純動能部位（不含風險層、核心）用於策略檢討
    values = pd.Series(index=days, dtype=float)
    r_iter = iter(rdays + [None])
    next_r = next(r_iter)
    for day in days[days.searchsorted(rdays[0]):]:
        if day == next_r:
            ranked = ranks[day]
            order = list(ranked.index)
            pos = {t: k for k, t in enumerate(order)}
            keep = [t for t in held if t in pos and pos[t] < cfg.exit_rank]
            new = [t for t in order if t not in keep][: max(0, PORTFOLIO - len(keep))]
            target_names = keep + new

            # 風險層
            if cfg.overlay.startswith("vol"):
                sigma = excess_vol(prices, target_names, day)
                w = 1.0
                if len(vol_hist) >= VOL_MIN_HISTORY:
                    w = min(1.0, float(np.median(vol_hist)) / sigma)
                    if cfg.overlay == "vol_thirds":
                        w = np.floor(w * 3 + 1e-9) / 3
                vol_hist.append(sigma)
            elif cfg.overlay == "lights":
                known = lights.loc[: (day.to_period("M") - 2).to_timestamp("M")]
                n = int(known.iloc[-1]) if len(known) else 0
                w = 1 - n / 3
            else:
                w = 1.0

            open_px = prices.open.loc[day]
            val = {t: u * open_px[t] for t, u in units.items()}
            total = sum(val.values())
            cur_w = {t: v / total for t, v in val.items()}
            name_w = (1 - cfg.core) * w / PORTFOLIO
            tgt = {t: 0.0 for t in cur_w if t != "SPY"}
            for t in target_names:
                tgt[t] = name_w
            if cfg.policy == "lazy" and w_prev is not None and w == w_prev:
                for t in keep:  # 留任股只在偏離超過 ±50% 時才調整
                    if abs(cur_w.get(t, 0) - name_w) <= LAZY_BAND * name_w:
                        tgt[t] = cur_w.get(t, 0)
            if sum(tgt.values()) > 1:  # 留任股漲太多，SPY 不夠吸收 → 全部拉回目標
                for t in target_names:
                    tgt[t] = name_w
            tgt["SPY"] = 1 - sum(v for t, v in tgt.items() if t != "SPY")

            traded = 0.0
            for t in set(tgt) | set(cur_w):
                dw = tgt.get(t, 0) - cur_w.get(t, 0)
                if abs(dw) > 1e-9:
                    traded += abs(dw) * total
                    if t != "SPY":
                        trades.append(dict(date=day, ticker=t, from_w=round(cur_w.get(t, 0), 4),
                                           to_w=round(tgt.get(t, 0), 4),
                                           action="賣出" if tgt.get(t, 0) == 0 else
                                           ("買進" if cur_w.get(t, 0) == 0 else "調整")))
            total_after = total - traded * FEE
            units = {t: tgt[t] * total_after / open_px[t] for t in tgt if tgt[t] > 1e-12}
            month_trades = sum(1 for x in trades if x["date"] == day)
            monthly.append(dict(date=day, w=w, names=",".join(target_names), n_trades=month_trades,
                                sold=len(set(held) - set(target_names)),
                                bought=len(set(target_names) - set(held))))
            held, w_prev = target_names, w
            next_r = next(r_iter)
        values[day] = sum(u * prices.last_close.at[day, t] for t, u in units.items())
    values = values.dropna()
    m = pd.DataFrame(monthly).set_index("date")
    # 每月報酬：換股日到下一個換股日
    lvl = values.reindex(m.index.append(pd.DatetimeIndex([values.index[-1]])))
    spy = prices.last_close["SPY"].reindex(lvl.index)
    m["r"] = (lvl.shift(-1) / lvl - 1).iloc[:-1].to_numpy()
    m["spy"] = (spy.shift(-1) / spy - 1).iloc[:-1].to_numpy()
    # 純動能部位（等權持有 target_names，換股日到下一換股日），用於策略檢討
    pure = []
    idx = list(m.index) + [values.index[-1]]
    for a, b, names in zip(idx[:-1], idx[1:], m["names"]):
        ns = names.split(",")
        start = prices.open.loc[a, ns]
        end = prices.last_close.loc[b, ns] if b == idx[-1] else prices.open.loc[b, ns]
        pure.append(float((end / start).mean() - 1))
    m["pure_mom"] = pure
    return values, m, pd.DataFrame(trades)


# ---------------------------------------------------------------- metrics

def stats(values: pd.Series, m: pd.DataFrame, spy_close: pd.Series, lo, hi):
    v = values.loc[lo:hi]
    s = spy_close.reindex(v.index)
    yrs = (v.index[-1] - v.index[0]).days / 365.25
    mv = v.resample("ME").last()
    mr = mv.pct_change().dropna()
    rel = v / s
    mm = m.loc[lo:hi]
    return dict(
        cagr=(v.iloc[-1] / v.iloc[0]) ** (1 / yrs) - 1,
        spy_cagr=(s.iloc[-1] / s.iloc[0]) ** (1 / yrs) - 1,
        vol=mr.std() * np.sqrt(12),
        sharpe=mr.mean() / mr.std() * np.sqrt(12),
        maxdd=(v / v.cummax() - 1).min(),
        spy_maxdd=(s / s.cummax() - 1).min(),
        rel_maxdd=(rel / rel.cummax() - 1).min(),
        trade_months=(mm["n_trades"] > 0).sum() / yrs,
        names_sold=mm["sold"].sum() / yrs,
        avg_w=mm["w"].mean(),
    )


def review_trigger(m: pd.DataFrame):
    """策略檢討：純動能相對 SPY 自高點落後 > 20%，且最近 6 個月仍落後。回傳觸發月份。"""
    rel = (1 + m["pure_mom"]).cumprod() / (1 + m["spy"]).cumprod()
    dd = rel / rel.cummax() - 1
    r6 = rel / rel.shift(6) - 1
    flag = (dd < -0.20) & (r6 < 0)
    starts = flag & ~flag.shift(1, fill_value=False)
    return flag, list(starts[starts].index.strftime("%Y-%m"))


def spy_sharpe(spy_close, lo, hi):
    mr = spy_close.loc[lo:hi].resample("ME").last().pct_change().dropna()
    return mr.mean() / mr.std() * np.sqrt(12)


# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=str(DEFAULT_LEAN))
    args = ap.parse_args()
    DATA_DIR.mkdir(exist_ok=True)
    OUT_DIR.mkdir(exist_ok=True)

    data = LeanData(Path(args.data))
    spy = data.bars("SPY").loc[:END]
    days = spy.index
    offsets = (0, 5, 10)
    ranks_by_off = {o: load_ranks(data, Path(args.data), days, o) for o in offsets}
    tickers = sorted({t for r in ranks_by_off.values() for s in r.values() for t in s.index} | {"SPY"})
    prices = Prices(data, tickers, days)
    lights_path = DATA_DIR / "three_lights.csv"
    lights = None
    if lights_path.exists():
        lights = pd.read_csv(lights_path, index_col=0, parse_dates=True).iloc[:, 0]

    overlays = ["none", "vol_thirds", "vol_raw"] + (["lights"] if lights is not None else [])
    grid = [Config(o, e, ov, c, p) for o, e, ov, c, p in itertools.product(
        offsets, (5, 10, 15), overlays, (0.0, 0.6), ("reset", "lazy"))]
    main_cfg = Config()
    spy_close = prices.last_close["SPY"]

    rows, ev_rows = [], []
    for k, cfg in enumerate(grid, 1):
        values, m, trades = simulate(cfg, ranks_by_off[cfg.offset], prices, lights)
        for lo, hi, label in PERIODS:
            s = stats(values, m, spy_close, lo, hi)
            rows.append(dict(asdict(cfg), period=label, **s, spy_sharpe=spy_sharpe(spy_close, lo, hi)))
        ev = dict(asdict(cfg))
        for name, (lo, hi) in EVENTS.items():
            x = m.loc[lo:hi]
            ev[name] = (1 + x["r"]).prod() / (1 + x["spy"]).prod() - 1
        ev_rows.append(ev)
        if cfg == main_cfg:
            flag, review_starts = review_trigger(m)
            m.assign(review_flag=flag).to_csv(OUT_DIR / "B2_monthly_main.csv")
            trades.to_csv(OUT_DIR / "B2_trades_main.csv", index=False)
        if k % 12 == 0:
            print(f"  {k}/{len(grid)}", flush=True)
    # 驗證：原版設定應重現 lean_strategies 的 1997-02 → 2026-09 年化約 16.8%
    v, m, _ = simulate(Config(0, 5, "none", 0.0, "reset"), ranks_by_off[0], prices, lights)
    s = stats(v, m, spy_close, "1997-02", "2026-09")
    print(f"驗證（原版）：年化 {pct(s['cagr'])}，最大回撤 {pct(s['maxdd'])}；SPY 年化 {pct(s['spy_cagr'])}")
    res = pd.DataFrame(rows)
    evs = pd.DataFrame(ev_rows)
    res.to_csv(OUT_DIR / "B2_results.csv", index=False)
    evs.to_csv(OUT_DIR / "B2_events.csv", index=False)
    write_summary(res, evs, review_starts)
    print("完成，見 backtest/results/B2_summary.md")


def pct(x, d=1):
    return f"{x*100:.{d}f}%"


def write_summary(res: pd.DataFrame, evs: pd.DataFrame, review_starts):
    keys = ["offset", "exit_rank", "overlay", "core", "policy"]
    L = ["# B-2 正式回測：原始表格", "",
         "由 `backtest/momentum_backtest.py` 產生。解讀見 `backtest_B2_2026-11-07.md`。", ""]

    def table(df, cols, header):
        out = ["| " + " | ".join(header) + " |", "|" + "---|" * len(header)]
        for _, r in df.iterrows():
            out.append("| " + " | ".join(str(r[c]) for c in cols) + " |")
        return out

    def fmt(df):
        d = df.copy()
        for c in ("cagr", "spy_cagr", "vol", "maxdd", "spy_maxdd", "rel_maxdd"):
            d[c] = d[c].map(pct)
        for c in ("sharpe", "spy_sharpe", "avg_w"):
            d[c] = d[c].map(lambda x: f"{x:.2f}")
        for c in ("trade_months", "names_sold"):
            d[c] = d[c].map(lambda x: f"{x:.1f}")
        d["core"] = d["core"].map(lambda x: f"{int(x*100)}%")
        return d

    cols = keys + ["cagr", "spy_cagr", "sharpe", "spy_sharpe", "maxdd", "rel_maxdd", "trade_months", "names_sold", "avg_w"]
    head = ["偏移", "出場名次", "風險層", "核心", "交易方式", "年化", "SPY 年化", "Sharpe", "SPY Sharpe",
            "最大回撤", "相對 SPY 最大回撤", "有交易月數/年", "賣出檔數/年", "平均動能比例"]
    for label in [p[2] for p in PERIODS]:
        sub = res[(res.period == label) & (res.offset == 0)]
        L += [f"## {label}（換股日偏移 0）", ""] + table(fmt(sub), cols, head) + [""]

    L += ["## 換股日偏移的敏感度（1998–2026）", "",
          "同一組設定在每月第 1、6、11 個交易日換股的年化與 Sharpe。", ""]
    sub = res[res.period == "1998–2026"]
    piv = sub.pivot_table(index=["exit_rank", "overlay", "core", "policy"], columns="offset",
                          values=["cagr", "sharpe"]).reset_index()
    piv.columns = ["_".join(str(x) for x in c if x != "") for c in piv.columns]
    hdr = ["出場名次", "風險層", "核心", "交易方式"] + [f"年化 偏移{o}" for o in (0, 5, 10)] + [f"Sharpe 偏移{o}" for o in (0, 5, 10)]
    L += ["| " + " | ".join(hdr) + " |", "|" + "---|" * len(hdr)]
    for _, r in piv.iterrows():
        L.append("| " + " | ".join([str(r.exit_rank), r.overlay, f"{int(r.core*100)}%", r.policy]
                                   + [pct(r[f"cagr_{o}"]) for o in (0, 5, 10)]
                                   + [f"{r[f'sharpe_{o}']:.2f}" for o in (0, 5, 10)]) + " |")
    L += ["", "## 崩盤事件中相對 SPY 的報酬（偏移 0）", ""]
    e = evs[evs.offset == 0].copy()
    for name in EVENTS:
        e[name] = e[name].map(pct)
    e["core"] = e["core"].map(lambda x: f"{int(x*100)}%")
    L += table(e, keys + list(EVENTS), ["偏移", "出場名次", "風險層", "核心", "交易方式"] + list(EVENTS))
    L += ["", "## 策略檢討觸發（主要方案的純動能部位）", "",
          "條件：純動能相對 SPY 自高點落後 > 20%，且最近 6 個月仍落後。",
          "", "觸發開始月份：" + ("、".join(review_starts) if review_starts else "無"), ""]
    (OUT_DIR / "B2_summary.md").write_text("\n".join(L), encoding="utf-8")


if __name__ == "__main__":
    main()
