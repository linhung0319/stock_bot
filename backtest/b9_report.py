"""B-9：把 results/B9_*.csv 整理成 Markdown 原始表格 → backtest/results/B9_summary.md。

執行：uv run python backtest/b9_report.py（先跑 b9_events.py classify|study|jump 與 b9_strategy.py）
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import b9_common as C  # noqa: E402


def pct(x, d=1, sign=True):
    if x is None or not np.isfinite(x):
        return "—"
    return f"{x*100:+.{d}f}%" if sign else f"{x*100:.{d}f}%"


def p2(x):
    return "—" if x is None or not np.isfinite(x) else f"{x:.2f}"


def table(rows, header):
    out = ["| " + " | ".join(header) + " |", "|" + "---|" * len(header)]
    out += ["| " + " | ".join(str(c) for c in r) + " |" for r in rows]
    return out


def event_tables(L):
    es = pd.read_csv(C.OUT / "B9_event_study.csv")
    for uni, title in (("ALL", "全部 S&P 500 成分股"), ("TOP50", "動能股票池（當月市值前 50）")):
        L += [f"## 事件研究：{title}", "",
              "相對 SPY＝(1+個股)/(1+SPY)−1，從第一個可交易開盤到第 63／126／252 個交易日收盤。"
              "超額＝相對 SPY − 配對組相對 SPY 的中位數（ALL：同月、同市值五分位 × 同動能五分位、±365 天無同類事件；"
              "TOP50：同月前 50 名中同一動能半邊）。區間為 bootstrap 90%；P(落後)是 Beta(1,1) 後驗中位數與 90% 區間。", ""]
        rows = []
        for _, r in es[es.universe == uni].iterrows():
            if r.n_events == 0:
                continue
            rows.append([r.group, r.horizon, f"{int(r.n)}/{int(r.n_events)}", int(r.n_delisted), int(r.n_noprice),
                         pct(r.med_rel), f"{pct(r.med_lo)}～{pct(r.med_hi)}", pct(r.mean_rel),
                         pct(r.get("med_abn")), f"{pct(r.get('abn_lo'))}～{pct(r.get('abn_hi'))}",
                         f"{p2(r.get('p_under'))}（{p2(r.get('p_under_lo'))}～{p2(r.get('p_under_hi'))}）",
                         f"{p2(r.get('p_below_ctrl'))}（{p2(r.get('p_below_ctrl_lo'))}～{p2(r.get('p_below_ctrl_hi'))}）",
                         p2(r.get("ctrl_under_base")), pct(r.get("med_rel_sector"))])
        L += table(rows, ["事件", "期間", "可算/全部", "期間內下市", "無價格", "相對 SPY 中位數", "90% 區間", "平均",
                          "超額中位數", "90% 區間", "P(落後 SPY)", "P(落後配對組)", "配對組落後 SPY 比例", "相對產業 ETF 中位數"]) + [""]


def jump_tables(L):
    js = pd.read_csv(C.OUT / "B9_jump_study.csv")
    L += ["## ONE_OFF_JUMP 與資訊離散度（每月第一個交易日的橫斷面，2009-01 起）", "",
          "命中－未命中＝每月（命中平均 − 未命中平均）再對有命中的月份平均；區間以月 bootstrap。", ""]
    rows = []
    for _, r in js.iterrows():
        rows.append([r.population, r.flag, r.horizon, int(r.n_hit), pct(r.hit_rate, 1, False), pct(r.get("hit_med")),
                     pct(r.get("non_med")), pct(r.get("diff_mean")), f"{pct(r.get('diff_lo'))}～{pct(r.get('diff_hi'))}",
                     f"{p2(r.get('p_under'))}（{p2(r.get('p_under_lo'))}～{p2(r.get('p_under_hi'))}）", p2(r.get("non_under"))])
    L += table(rows, ["族群", "規則", "期間", "命中數", "命中率", "命中中位數", "未命中中位數", "命中−未命中（同月）",
                      "90% 區間", "命中 P(落後 SPY)", "未命中落後比例"]) + [""]


def strategy_tables(L):
    st = pd.read_csv(C.OUT / "B9_strategy.csv")
    L += ["## 動能策略（出場名次 15、lazy、核心 0%、無風險層，除非註明）", ""]
    rows = []
    for _, r in st.iterrows():
        rows.append([r.rule, r.period, pct(r.cagr, 1, False), p2(r.sharpe), pct(r.maxdd, 0, False), pct(r.turnover, 0, False),
                     f"{r.names_sold:.1f}", int(r.n_veto), int(r.n_exit), int(r.n_core_slot)])
    L += table(rows, ["規則", "期間", "年化", "Sharpe", "最大回撤", "換手率/年", "賣出檔數/年", "否決次數", "提早出場", "留在核心的格數"]) + [""]
    h = pd.read_csv(C.OUT / "B9_strategy_hits.csv")
    h = h[h.kind.isin(["否決", "提早出場", "換股日出場"])]
    h = h.drop_duplicates(["kind", "date", "ticker", "code"])
    L += ["## 命中案例（各規則合併，去重）", "", "相對 SPY 從該換股日（或出場日）開盤算起；遞補者同一天開盤買進。", ""]
    rows = []
    for _, r in h.sort_values("date").iterrows():
        rows.append([str(r.date)[:10], r.kind, r.ticker, r.code, str(r.detail)[:60], "" if pd.isna(r.get("rank")) else int(r["rank"]),
                     pct(r.rel_3m), pct(r.rel_6m), pct(r.rel_12m), r.get("replacement") if isinstance(r.get("replacement"), str) else "",
                     pct(r.get("repl_rel_3m")), pct(r.get("repl_rel_6m")), pct(r.get("repl_rel_12m"))])
    L += table(rows, ["日期", "類型", "代號", "代碼", "細節", "排名", "3 個月", "6 個月", "12 個月", "遞補", "遞補 3 個月",
                      "遞補 6 個月", "遞補 12 個月"]) + [""]


def main():
    L = ["# B-9 原始表格", "", "由 `backtest/b9_report.py` 產生。解讀見 `backtest_B9_2026-11-08.md`。", ""]
    ev = pd.read_csv(C.OUT / "B9_events.csv")
    L += ["## 事件數（去重後、指數期間內、2009 起）", ""]
    g = ev.groupby(["cls", "sub"]).agg(n=("cik", "size"), firms=("cik", "nunique"),
                                         no_price=("ticker", lambda s: 0)).reset_index()
    L += table(g.values.tolist(), ["類別", "子類", "事件數", "公司數", "—"]) + [""]
    event_tables(L)
    jump_tables(L)
    strategy_tables(L)
    (C.OUT / "B9_summary.md").write_text("\n".join(L), encoding="utf-8")
    print("完成：backtest/results/B9_summary.md")


if __name__ == "__main__":
    main()
