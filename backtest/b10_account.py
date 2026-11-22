"""
階段十二的整個帳戶模擬（T75、T76 共用）。

複製 account_backtest.simulate_account（凍結，不修改）後擴充：
  核心政策  core_policy
      crash   現在的崩盤規則：換股日 SPY < 200 日均線 → 核心一半現金（舊版）
      none    核心全部 VOO（SPY 代理），不留現金
      ratio   核心固定 VOO：SGOV 比例 sgov；進核心的錢照比例分、出核心的錢照比例拿；
              超出界線 ±band 才調回 sgov（ratio_daily=False：只在每月換股日檢查；True：每天開盤前檢查）
              denom='total' 時 SGOV 目標 = sgov × 總資產（參考用）
      ratio＋hyb_n>0（B-13 折衷）：換股日 SPY 連續 hyb_n 次 < 200 日均線 → SGOV 目標改成 hyb_sgov；
              某次換股日回到 200 日均線之上 → 回到 sgov。狀態一變就調到新目標
  暫放（B-14）mom_park / own_park
      core    移出的錢進核心照比例分、移回時從核心照比例拿（B-11～B-13 的做法）
      sgov    移出的錢留在原桶、放 SGOV（格子 (桶, 'CASH')）；移回時先從這裡拿，不夠才從核心拿
      voo     同上，但放 VOO（格子 (桶, 'SPY')）
      動能：只有「比例改變」（波動度、200 日線、開關）減下來的錢暫放；換股、跨桶上限的照舊進出核心
      自選：只有慢規則減半的錢暫放；加回時先用暫放的錢；沒有減半中的股票時，剩下的暫放錢還給核心
  動能      mom_200   200 日線減半（舊版跟著 crash_rule；這裡獨立）
            switch    'bear24' / 'bear24hv' / 'bear36' / 'bear36hv' 開關：打開時動能比重 0，錢進核心
  現金      cash_ret  True：現金照 SGOV／國庫券計息（舊版為 0）
            count_cash True：SGOV 的買賣也算一張單（舊版只在入金出金日算）

legacy=True 的設定（core_policy='crash'、mom_200=True、cash_ret=False、count_cash=False）應重現 B-8 的數字。
出金情境沒有為 ratio 改寫（出金順序是 T78 的設計題），這次也不跑出金。
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

import b10_common as bc
from b10_common import mb
import account_backtest as ab

FEE, ORDER_MIN = ab.FEE, ab.ORDER_MIN
RATIO_REASONS = ab.RATIO_REASONS | {"核心比例"}


@dataclass(frozen=True)
class Acct(ab.Scenario):
    core_policy: str = "crash"
    sgov: float = 0.0
    band: float = 0.05
    denom: str = "core"
    ratio_daily: bool = False
    mom_200: bool = True
    switch: str | None = None
    cash_ret: bool = True
    count_cash: bool = True
    hyb_n: int = 0
    hyb_sgov: float = 0.5
    mom_park: str = "core"
    own_park: str = "core"


# B-8 主要方案（緩衝 0.10）＝現在線上的設計
B8_MAIN = dict(own_monthly=True, cross_cap=0.10, piggyback=True, mom_frac=0.30 / 0.80, urgent_frac=0.05, vol_hyst=0.10)

RUNS = [("2000–2026（自選 MU/NVDA/MSFT）", ["MU", "NVDA", "MSFT"], "2000-02-01"),
        ("2013–2026（自選 MU/NVDA/MSFT/META）", ["MU", "NVDA", "MSFT", "META"], "2013-06-03")]


def simulate(sc: Acct, own: list[str], start: str, end: str, ranks: dict, w: bc.World):
    prices = w.prices
    days = prices.close.loc[start:end].index
    rdays = [d for d in sorted(ranks) if days[0] <= d <= days[-1]]
    days = days[days.searchsorted(rdays[0]):]
    rset = set(rdays)
    O, C, L = prices.open, prices.last_close, prices.close
    below200 = (C["SPY"] < L["SPY"].rolling(200).mean()).shift(1, fill_value=False)
    sw_ser = w.reg[sc.switch].astype(bool).shift(1, fill_value=False) if sc.switch else None
    cidx = w.cash if sc.cash_ret else pd.Series(1.0, index=prices.close.index)
    sigs = {tk: ab.slow_signals(L[tk].dropna(), days[0]) for tk in own} if sc.own_rule else {}
    use200 = sc.core_policy == "crash" or sc.mom_200
    PARK = {"sgov": "CASH", "voo": "SPY"}
    mpk = ("mom", PARK[sc.mom_park]) if sc.mom_park != "core" else None
    opk = ("own", PARK[sc.own_park]) if sc.own_park != "core" else None

    lots: dict[tuple[str, str], float] = {}
    held_mom: list[str] = []
    w_prev, crash, sw_prev = None, False, False
    vs = bc.VolScaler(sc.vol_hyst)
    vol_path = []
    pending: dict[str, str] = {}
    applied = {tk: "STD" for tk in own}
    std_w = sc.own_total / len(own) if own else 0
    values, orders, events = [], [], []
    own_w, mom_w, cash_core, cash_tot = [], [], [], []
    flows = ab.flow_schedule(sc, days, rdays)
    units, n_dep = 1.0, 0
    n_urgent, n_sw = 0, 0
    hyb_cnt, hyb_on = 0, False

    def own_state_target(tk, tot):
        return std_w * tot * (0.5 if applied[tk] == "RED" else 1.0)

    def px_open(tk, d):
        return float(cidx.at[d]) if tk == "CASH" else float(O.at[d, tk])

    def ratio_breach(d):
        if sc.core_policy != "ratio" or not sc.ratio_daily or not lots:
            return False
        v = {k: u * px_open(k[1], d) for k, u in lots.items()}
        tot = sum(v.values())
        cs, sp = v.get(("core", "CASH"), 0.0), v.get(("core", "SPY"), 0.0)
        den = (cs + sp) if sc.denom == "core" else tot
        return den > 0 and abs(cs / den - sc.sgov) > sc.band

    for i, d in enumerate(days):
        is_r = d in rset
        first = i == 0
        todo: dict = {}
        if pending and (is_r or not sc.own_monthly):
            todo = dict(pending)
        elif pending and sc.urgent_frac is not None:
            v0 = {k: u * px_open(k[1], d) for k, u in lots.items()}
            t0 = sum(v0.values())
            for tk, act in pending.items():
                cur = v0.get(("own", tk), 0.0)
                if act == "REDUCE" and applied[tk] == "STD":
                    chg = cur * 0.5
                elif act == "READD" and applied[tk] == "RED":
                    chg = max(0.0, std_w * t0 - cur)
                else:
                    chg = 0.0
                if chg >= sc.urgent_frac * t0:
                    todo[tk] = act
            if todo:
                n_urgent += 1
        flow = flows.get(d) if not first else None
        breach = (not is_r) and ratio_breach(d)
        if first or is_r or todo or flow or breach:
            val = {k: u * px_open(k[1], d) for k, u in lots.items()}
            total = sum(val.values()) if val else 1.0
            tgt = dict(val)
            why: dict[tuple[str, str], str] = {}

            if flow:  # 只用入金（出金沒有為 ratio 改寫）
                kind, x = flow
                assert kind == "入金", "b10_account 不跑出金"
                amt = x * total
                units += amt / (total / units)
                new_total = total + amt
                cells = {}
                for tk in own:
                    cells[("own", tk)] = min(own_state_target(tk, new_total), sc.own_cap * new_total)
                if held_mom and w_prev is not None:
                    nt = new_total * (1 - sc.own_total) * sc.mom_frac * w_prev / 5
                    for t in held_mom:
                        o = cells.get(("own", t), tgt.get(("own", t), 0.0))
                        cells[("mom", t)] = min(nt, max(0.0, sc.cross_cap * new_total - o)) if sc.cross_cap else nt
                left = amt
                if not sc.deposit_naive:
                    gaps = sorted(((c - tgt.get(k, 0.0), k) for k, c in cells.items()), reverse=True)
                    for g, k in gaps:
                        if left <= 0:
                            break
                        if g <= ORDER_MIN * new_total:
                            continue
                        b = min(g, left)
                        tgt[k] = tgt.get(k, 0.0) + b
                        why[k] = kind
                        left -= b
                if sc.core_policy == "crash":
                    cash_frac = (1 - sc.crash_cut) if crash else 0.0
                    tgt[("core", "CASH")] = tgt.get(("core", "CASH"), 0.0) + left * cash_frac
                    tgt[("core", "SPY")] = tgt.get(("core", "SPY"), 0.0) + left * (1 - cash_frac)
                # none / ratio：剩下的錢不先放，下面核心那段以「核心的差額」照比例分
                n_dep += 1
                total = new_total

            # 自選桶
            if first:
                for tk in (own if not sc.spy_only else []):
                    tgt[("own", tk)] = std_w * total
            for tk, act in todo.items():
                cur = tgt.get(("own", tk), 0.0)
                if act == "REDUCE" and applied[tk] == "STD":
                    tgt[("own", tk)] = cur * 0.5
                    why[("own", tk)] = "自選訊號"
                    applied[tk] = "RED"
                    if opk:
                        tgt[opk] = tgt.get(opk, 0.0) + cur * 0.5
                        why[opk] = "自選訊號"
                    events.append(dict(date=d, ticker=tk, action=act))
                elif act == "READD" and applied[tk] == "RED":
                    tgt[("own", tk)] = max(cur, std_w * total)
                    why[("own", tk)] = "自選訊號"
                    applied[tk] = "STD"
                    if opk:
                        take = min(tgt[("own", tk)] - cur, tgt.get(opk, 0.0))
                        tgt[opk] = tgt.get(opk, 0.0) - take
                        why[opk] = "自選訊號"
                        if all(a == "STD" for a in applied.values()):
                            tgt[opk] = 0.0
                    events.append(dict(date=d, ticker=tk, action=act))
            if is_r:
                for tk in own:
                    cur = tgt.get(("own", tk), 0.0)
                    if cur > sc.own_cap_hi * total:
                        tgt[("own", tk)] = sc.own_cap * total
                        why[("own", tk)] = "單檔上限"
                        events.append(dict(date=d, ticker=tk, action="TRIM"))
            own_val = sum(v for k, v in tgt.items() if k[0] == "own")
            sys_val = total - own_val

            lazy_prev: dict = {}
            crash_changed = False
            if is_r:
                new_c200 = bool(below200.at[d]) if use200 else False
                crash_changed = new_c200 != crash
            if is_r and not sc.spy_only:
                order = list(ranks[d].index)
                pos = {t: k for k, t in enumerate(order)}
                keep = [t for t in held_mom if t in pos and pos[t] < sc.exit_rank]
                new = [t for t in order if t not in keep][: max(0, 5 - len(keep))]
                names = keep + new
                wv = 1.0
                if sc.vol_scale:
                    wv = vs.step(mb.excess_vol(prices, names, d))
                    if vs.w is not None:
                        vol_path.append(wv)
                sw = bool(sw_ser.at[d]) if sc.switch else False
                sw_changed = sw != sw_prev
                n_sw += int(sw_changed and not first)
                eff = 0.0 if sw else wv * (sc.crash_cut if (sc.mom_200 and new_c200) else 1.0)
                name_t = sys_val * sc.mom_frac * eff / 5
                if sw:  # 開關打開：動能全部出場，關上時重新買前 5 名
                    names, new = [], []
                for k in [k for k in tgt if k[0] == "mom" and k[1] not in names and k != mpk]:
                    tgt[k] = 0.0
                    why[k] = "動能開關" if sw_changed else "動能換股"
                changed = (w_prev is None) or eff != w_prev
                w_reason = "動能開關" if sw_changed else ("崩盤規則" if (crash_changed and sc.mom_200) else "波動度減碼")
                for t in names:
                    cur = tgt.get(("mom", t), 0.0)
                    own_t = tgt.get(("own", t), 0.0)
                    t_t = name_t
                    if sc.cross_cap is not None:
                        t_t = min(name_t, max(0.0, sc.cross_cap * total - own_t))
                    if t in new:
                        tgt[("mom", t)], why[("mom", t)] = t_t, ("動能開關" if sw_changed and not first else "動能換股")
                    elif changed:
                        tgt[("mom", t)], why[("mom", t)] = t_t, w_reason
                    elif sc.mom_lazy_band is not None and abs(cur - t_t) > sc.mom_lazy_band * t_t:
                        lazy_prev[("mom", t)] = cur
                        tgt[("mom", t)], why[("mom", t)] = t_t, "動能比例回調"
                    if sc.cross_cap is not None:
                        m = tgt.get(("mom", t), 0.0)
                        if own_t + m > sc.cross_cap_hi * total:
                            excess = own_t + m - sc.cross_cap * total
                            cut = min(m, excess)
                            tgt[("mom", t)] = m - cut
                            why[("mom", t)] = "跨桶上限"
                            if excess - cut > 0:
                                tgt[("own", t)] = own_t - (excess - cut)
                                why[("own", t)] = "跨桶上限"
                            events.append(dict(date=d, ticker=t, action="CROSS_TRIM"))
                if mpk and changed:
                    tgt[mpk] = sys_val * sc.mom_frac * (1 - eff)
                    why[mpk] = w_reason
                held_mom, w_prev, sw_prev = names, eff, sw
            if is_r:
                crash = new_c200
            hyb_changed = False
            if is_r and sc.hyb_n:
                hyb_cnt = hyb_cnt + 1 if bool(below200.at[d]) else 0
                new_on = hyb_cnt >= sc.hyb_n
                hyb_changed, hyb_on = new_on != hyb_on, new_on

            if sc.piggyback and lazy_prev and not first:
                others = crash_changed or any(
                    r != "動能比例回調" and abs(tgt.get(k, 0.0) - val.get(k, 0.0)) > ORDER_MIN * total
                    for k, r in why.items())
                if not others:
                    for k, c0 in lazy_prev.items():
                        tgt[k] = c0
                        why.pop(k, None)

            # 核心
            mom_val = sum(v for k, v in tgt.items() if k[0] == "mom")
            core = total - own_val - mom_val
            cur_spy, cur_cash = tgt.get(("core", "SPY"), 0.0), tgt.get(("core", "CASH"), 0.0)
            core_rebal = False
            if sc.core_policy == "crash":
                core_crash_changed = crash_changed
                if first or core_crash_changed:
                    cash_t = core * (1 - sc.crash_cut) if crash else 0.0
                    tgt[("core", "CASH")], tgt[("core", "SPY")] = cash_t, core - cash_t
                else:
                    delta = core - cur_spy - cur_cash
                    a, b = (("core", "CASH"), ("core", "SPY")) if crash else (("core", "SPY"), ("core", "CASH"))
                    tgt[a] = tgt.get(a, 0.0) + delta
                    if tgt[a] < 0:
                        tgt[b] = tgt.get(b, 0.0) + tgt[a]
                        tgt[a] = 0.0
            elif sc.core_policy == "none":
                tgt[("core", "CASH")], tgt[("core", "SPY")] = 0.0, core
            else:
                den = core if sc.denom == "core" else total
                p_now = sc.hyb_sgov if hyb_on else sc.sgov
                target_cash = min(core, p_now * den)
                if first:
                    cs = target_cash
                else:
                    p_t = target_cash / core if core > 0 else 0.0
                    delta = core - cur_spy - cur_cash
                    cs = cur_cash + p_t * delta
                    sp = cur_spy + (1 - p_t) * delta
                    if cs < 0:
                        cs = 0.0
                    if sp < 0:
                        cs = core
                    if hyb_changed:
                        cs = target_cash
                    elif (is_r or sc.ratio_daily) and den > 0 and abs(cs / den - p_now) > sc.band:
                        cs = target_cash
                        core_rebal = True
                tgt[("core", "CASH")], tgt[("core", "SPY")] = cs, core - cs

            net: dict[str, float] = {}
            for k in set(tgt) | set(val):
                dv = tgt.get(k, 0.0) - val.get(k, 0.0)
                if k[1] != "CASH":
                    net[k[1]] = net.get(k[1], 0.0) + dv
            traded = sum(abs(x) for x in net.values())
            fee = traded * FEE
            dc = sum(tgt.get(k, 0.0) - val.get(k, 0.0) for k in set(tgt) | set(val) if k[1] == "CASH")
            if (flow or sc.count_cash) and abs(dc) > 1e-12:
                net["SGOV"] = dc
            big = {t: x for t, x in net.items() if abs(x) > ORDER_MIN * total}
            reasons = {why.get(k, "其他") for k in set(tgt) | set(val)
                       if k[0] != "core" and ("SGOV" if k[1] == "CASH" else k[1]) in big and abs(tgt.get(k, 0.0) - val.get(k, 0.0)) > ORDER_MIN * total}
            if crash_changed and use200:
                reasons.add("崩盤規則")
            if core_rebal:
                reasons.add("核心比例")
            if hyb_changed:
                reasons.add("崩盤加碼")
            reasons.discard("其他")
            if flow:
                reasons.add(flow[0])
                if not big:
                    big = {t: x for t, x in net.items() if abs(x) > 1e-9}
            if big and not first:
                orders.append(dict(date=d, n_orders=len(big), reasons="、".join(sorted(reasons)),
                                   ratio_only=bool(reasons) and reasons <= RATIO_REASONS,
                                   orders="；".join(f"{'買' if x > 0 else '賣'} {t} {abs(x)/total*100:.1f}%"
                                                   for t, x in sorted(big.items(), key=lambda z: (-round(abs(z[1]), 12), z[0])))))
            ck = ("core", "CASH") if tgt.get(("core", "CASH"), 0) >= fee else ("core", "SPY")
            tgt[ck] = tgt.get(ck, 0.0) - fee
            lots = {k: v / px_open(k[1], d) for k, v in tgt.items() if v > 1e-12}
            for tk in todo:
                pending.pop(tk, None)

        cv = {k: u * (float(cidx.at[d]) if k[1] == "CASH" else float(C.at[d, k[1]])) for k, u in lots.items()}
        tv = sum(cv.values())
        values.append(tv / units)
        own_w.append(sum(x for k, x in cv.items() if k[0] == "own") / tv)
        mom_w.append(sum(x for k, x in cv.items() if k[0] == "mom") / tv)
        cc, cs_ = cv.get(("core", "CASH"), 0.0), cv.get(("core", "SPY"), 0.0)
        cash_core.append(cc / (cc + cs_) if cc + cs_ > 0 else 0.0)
        cash_tot.append(sum(x for k, x in cv.items() if k[1] == "CASH") / tv)
        for tk, s in sigs.items():
            a = s.get(d)
            a = a if isinstance(a, str) else None
            if a:
                pending[tk] = a
    v = pd.Series(values, index=days)
    yrs = (days[-1] - days[0]).days / 365.25
    od = pd.DataFrame(orders, columns=["date", "n_orders", "reasons", "ratio_only", "orders"])
    rs = od.reasons.fillna("")
    vp = np.array(vol_path)
    extra = dict(
        核心比例單獨下單日每年=(rs == "核心比例").sum() / yrs,
        含核心比例下單日每年=rs.str.contains("核心比例").sum() / yrs,
        崩盤規則下單日每年=rs.str.contains("崩盤規則").sum() / yrs,
        動能開關下單日每年=rs.str.contains("動能開關").sum() / yrs,
        崩盤加碼下單日每年=rs.str.contains("崩盤加碼").sum() / yrs,
        純比例下單日每年=od.ratio_only.sum() / yrs,
        入金下單日每年=rs.str.contains("入金").sum() / yrs,
        開關切換次數=n_sw,
        緊急通知每年=n_urgent / yrs,
        自選桶平均占比=float(np.mean(own_w)), 動能平均占比=float(np.mean(mom_w)),
        核心現金平均占比=float(np.mean(cash_core)), 現金占總資產平均=float(np.mean(cash_tot)),
        波動度平均比例=vp.mean() if len(vp) else 1.0)
    return v, od, pd.DataFrame(events), extra


def stats_row(label, name, sc, v, od, extra, spy):
    st = ab.account_stats(v, spy, od)
    st.update(extra)
    st.update(bc.event_abs(v))
    return dict(期間=label, 情境=name, **st)


def legacy(sc: Acct) -> Acct:
    from dataclasses import replace
    return replace(sc, core_policy="crash", mom_200=True, cash_ret=False, count_cash=False)
