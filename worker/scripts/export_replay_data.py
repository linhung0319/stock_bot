"""
T2 重放驗收用：把 Python 回測的輸入與對照答案匯出成固定檔，給 Node 的 TypeScript 引擎重放。

只讀 backtest/（凍結，不修改）與 lean_strategies 的 LEAN 資料夾（唯讀）。
執行（在 repo 根目錄）：
    uv run python worker/scripts/export_replay_data.py

輸出到 worker/fixtures/replay/（不進 git，檔案大）：
    meta.json        交易日、代號、兩次重放的設定
    close.f64        還原收盤，代號 × 交易日，float64 little-endian，沒有資料是 NaN
    open.f64         還原開盤（缺的用前一日收盤補，和回測的 Prices 相同）
    ranks.json       每個換股日的股票池排名（代號由高到低）
    universe.json    每個換股日排名用的原始資料（成分股、權重、收盤、成交金額、252 日報酬），
                     用來驗證 TypeScript 的股票池與排名
    expected_<年>.json  回測「緩衝 0.10」情境的每日單位淨值、下單紀錄、事件（對照答案）
"""
from __future__ import annotations

import json
import sys
from dataclasses import replace
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backtest"))
import account_backtest as ab  # noqa: E402
import momentum_backtest as mb  # noqa: E402

OUT = ROOT / "worker" / "fixtures" / "replay"

RUNS = [("2000", ["MU", "NVDA", "MSFT"], "2000-02-01"),
        ("2013", ["MU", "NVDA", "MSFT", "META"], "2013-06-03")]


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    data = mb.LeanData(mb.DEFAULT_LEAN)
    spy = data.bars("SPY").loc[:mb.END]
    days = spy.index
    ranks = mb.load_ranks(data, mb.DEFAULT_LEAN, days, 0)
    own_all = ["MU", "NVDA", "MSFT", "META"]
    tickers = sorted({t for s in ranks.values() for t in s.index} | {"SPY"} | set(own_all))
    prices = mb.Prices(data, tickers, days)
    cols = list(prices.close.columns)

    prices.close[cols].to_numpy(dtype="<f8").T.copy().tofile(OUT / "close.f64")
    prices.open[cols].to_numpy(dtype="<f8").T.copy().tofile(OUT / "open.f64")

    (OUT / "ranks.json").write_text(json.dumps(
        {d.strftime("%Y-%m-%d"): list(s.index) for d, s in sorted(ranks.items())}), encoding="utf-8")

    # 排名用的原始資料（和 mb.rank_universe 讀的相同）
    uni = {}
    for d in sorted(ranks):
        file_date = data.files[data.files < d][-1]
        rows = []
        for ticker, weight in data.constituents(file_date).items():
            b = data.bars(ticker)
            if b is None:
                continue
            i = b.index.searchsorted(d, side="left") - 1
            if i < 0:
                continue
            bar = b.iloc[i]
            dv = bar.close * bar.volume
            rows.append([ticker, weight, float(bar.close), None if pd.isna(dv) else float(dv),
                         None if pd.isna(bar.momp) else float(bar.momp)])
        uni[d.strftime("%Y-%m-%d")] = rows
    (OUT / "universe.json").write_text(json.dumps(uni), encoding="utf-8")

    # 對照答案：B-8「緩衝 0.10」（= run_b8 寫出 B8_orders_*.csv 的那個情境）
    sc = replace(ab.Scenario("緩衝 0.10", own_monthly=True, cross_cap=0.10, piggyback=True,
                             mom_frac=0.30 / 0.80, urgent_frac=0.05), vol_hyst=0.10)
    runs_meta = []
    spy_c = prices.last_close["SPY"]
    for tag, own, start in RUNS:
        v, orders, events, extra = ab.simulate_account(sc, own, start, mb.END, ranks, prices)
        st = ab.account_stats(v, spy_c, orders)
        exp = dict(
            dates=[d.strftime("%Y-%m-%d") for d in v.index],
            nav=[float(x) for x in v.to_numpy()],
            orders=[dict(date=pd.Timestamp(r["date"]).strftime("%Y-%m-%d"), n_orders=int(r["n_orders"]),
                         reasons=r["reasons"], ratio_only=bool(r["ratio_only"]), orders=r["orders"])
                    for r in orders.to_dict("records")],
            events=[dict(date=pd.Timestamp(r["date"]).strftime("%Y-%m-%d"), ticker=r["ticker"], action=r["action"])
                    for r in events.to_dict("records")],
            stats={k: float(st[k]) for k in ("年化", "Sharpe", "最大回撤", "下單日每年", "每次平均單數")},
            extra={k: float(x) for k, x in extra.items()},
        )
        (OUT / f"expected_{tag}.json").write_text(json.dumps(exp, ensure_ascii=False), encoding="utf-8")
        runs_meta.append(dict(tag=tag, own=own, start=start, end=mb.END))
        print(tag, f"年化 {st['年化']*100:.2f}%  Sharpe {st['Sharpe']:.3f}  最大回撤 {st['最大回撤']*100:.1f}%  下單日 {len(orders)}")

    meta = dict(days=[d.strftime("%Y-%m-%d") for d in days], tickers=cols, runs=runs_meta,
                fee=mb.FEE, vol_window=mb.VOL_WINDOW, source=str(mb.DEFAULT_LEAN.name))
    (OUT / "meta.json").write_text(json.dumps(meta), encoding="utf-8")
    print(f"完成：{len(days)} 個交易日、{len(cols)} 檔、{len(ranks)} 個換股日 → {OUT}")


if __name__ == "__main__":
    main()
