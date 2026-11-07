"""崩盤規則的參考類別：每次觸發的結果，以及「延後一個月」的對照。

ai_layer_design_2026-11-08.md §3.3、附錄 B。
規則：每月第一個交易日，SPY 前一日收盤 < 200 日均線 → 啟動；回到均線之上 → 解除；當天開盤成交。
confirm_on / confirm_off = 需要連續幾個月同方向才切換（1 = 目前規則）。
只看價格：不算現金利息、複利、期間長短。

執行：uv run python backtest/crash_episodes.py
"""
import pandas as pd
import yfinance as yf

START_REPORT = pd.Timestamp("2000-06-01")


def load():
    px = yf.download("SPY", start="1998-01-01", end="2026-11-07", auto_adjust=True, progress=False)
    px.columns = [c[0] if isinstance(c, tuple) else c for c in px.columns]
    return px


def monthly_states(px):
    c = px["Close"]
    sma = c.rolling(200).mean()
    days = px.index
    firsts = pd.Series(days, index=days).groupby([days.year, days.month]).first()
    firsts = [d for d in firsts if days.get_loc(d) > 201]
    below = {}
    for d in firsts:
        prev = days[days.get_loc(d) - 1]
        below[d] = (bool(c[prev] < sma[prev]), c[prev] / sma[prev] - 1)
    return firsts, below


def episodes(px, firsts, below, confirm_on=1, confirm_off=1):
    o, c = px["Open"], px["Close"]
    state, on, out = False, None, []
    for k, d in enumerate(firsts):
        win_on = [below[firsts[j]][0] for j in range(max(0, k - confirm_on + 1), k + 1)]
        win_off = [not below[firsts[j]][0] for j in range(max(0, k - confirm_off + 1), k + 1)]
        if not state and len(win_on) == confirm_on and all(win_on):
            state, on = True, d
        elif state and len(win_off) == confirm_off and all(win_off):
            state = False
            seg = c[on:d]
            out.append(dict(on=on.date(), off=d.date(), months=round((d - on).days / 30.4),
                            dist=below[on][1], buyback_vs_sell=o[d] / o[on] - 1,
                            min_vs_sell=seg.min() / o[on] - 1))
    if state:
        out.append(dict(on=on.date(), off=None))
    df = pd.DataFrame(out)
    return df[pd.to_datetime(df["on"]) >= START_REPORT]


def main():
    px = load()
    firsts, below = monthly_states(px)
    pd.set_option("display.width", 200)
    fmt = lambda x: f"{x:+.1%}"
    for name, (a, b) in {"目前規則": (1, 1), "啟動延後一個月": (2, 1),
                         "解除延後一個月": (1, 2), "兩者都延後": (2, 2)}.items():
        df = episodes(px, firsts, below, a, b)
        r = df["buyback_vs_sell"].dropna()
        print(f"\n== {name}: {len(df)} 次，買回更貴 {(r > 0).sum()}，買回價／賣出價-1 加總 {r.sum():+.1%}")
        print(df.to_string(index=False, float_format=fmt))


if __name__ == "__main__":
    main()
