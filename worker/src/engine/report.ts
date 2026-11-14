// 每日檢查與月報：把規則的結果變成「通知＋清單」，每一項附選項（照規則／照 AI／這次不做）。
// 設計：§2.0 觸發總表、§2.2 自選、§2.3 操作方式、§2.5 觸發與通知。
import {
  TIER_NAME,
  bucketValue,
  cellValues,
  clone,
  makeItem,
  newNotif,
  priceOf,
  shareCells,
  totalValue,
  type Account,
  type Choice,
  type Item,
  type MarketView,
  type MonthlyContext,
  type Notif,
  type Tier,
} from './account';
import { dueOwnActions, ownSignalChange, planDay, type FlowInput, type PlanResult } from './allocator';
import { excessVol, r1 as r1Of } from './indicators';
import { composeWithCore, crashCoreLines, mergeByTicker, planToLines, type Composed, type CoreContext, type OrderLine } from './orders';
import { crashRuleOn } from './risk';
import { halveShares, slowDayInput, stepSlowRule } from './slowRule';
import type { OwnAction, OwnState } from './types';

// ---------------------------------------------------------------- 共用

export function coreContext(acct: Account, view: MarketView, reserveCash = 0): CoreContext {
  return {
    cfg: acct.cfg,
    price: (t) => priceOf(view, t),
    cash: acct.cash,
    coreShares: acct.lots.core[acct.cfg.coreTicker] ?? 0,
    bondShares: acct.lots.core[acct.bondTicker] ?? 0,
    bondTicker: acct.bondTicker,
    crash: acct.rule.crash,
    total: totalValue(acct, view),
    reserveCash,
  };
}

/** 照每一項目前選的選項合成清單；核心吸收差額。 */
export function composeNotif(acct: Account, view: MarketView, n: Notif): Composed {
  const lines: OrderLine[] = [];
  for (const it of n.items) {
    if (it.cancelled) continue;
    const c = it.choices.find((x) => x.id === it.choice);
    if (c) for (const l of c.lines) if (l.shares) lines.push(l);
  }
  if (!n.coreAbsorb) {
    let cashAfter = acct.cash - (n.withdraw ?? 0);
    for (const l of lines) cashAfter -= l.shares * priceOf(view, l.ticker);
    return { lines, merged: mergeByTicker(lines), cashAfter };
  }
  return composeWithCore(lines, coreContext(acct, view, n.withdraw ?? 0));
}

/** AI 檔位換成股數（設計 §0：AI 選檔位，程式算股數）。stateBefore 是這次規則動作之前的慢規則狀態。 */
export function tierShares(acct: Account, view: MarketView, ticker: string, tier: Tier, stateBefore: OwnState): number {
  const cur = acct.lots.own[ticker] ?? 0;
  const std = acct.rule.own[ticker]?.stdWeight ?? 0;
  const total = totalValue(acct, view);
  const px = priceOf(view, ticker);
  switch (tier) {
    case 'EXIT':
      return -cur;
    case 'HALF':
      // 和規則的減半是同一個動作：正常狀態時賣掉當時股數的一半；已經減半就不動
      return stateBefore === 'STD' ? -halveShares(cur) : 0;
    case 'HOLD':
      return 0;
    case 'STANDARD':
      return Math.max(0, Math.floor((std * total) / px) - cur);
    case 'RAISE':
      return Math.max(0, Math.floor((std * 1.25 * total) / px) - cur);
  }
}

function sharesText(n: number): string {
  return n < 0 ? `賣 ${-n} 股` : n > 0 ? `買 ${n} 股` : '不動，0 股';
}

/**
 * 慢規則減半（F7）或加回（F8）時，並列最近一次 F24 的檔位（設計 §2.2）。
 * 回傳 null = 沒有 AI 檔位，或 AI 和規則一致（只顯示一行）。
 */
function ownAiChoice(acct: Account, view: MarketView, ticker: string, action: OwnAction, stateBefore: OwnState): { choice: Choice; aiLine: string } | null {
  const ai = acct.own[ticker]?.aiTier;
  if (!ai) return null;
  const tier = ai.tier;
  if (action === 'REDUCE' && tier === 'HALF') return null; // 同一個動作
  if (action === 'READD' && (tier === 'STANDARD' || tier === 'HOLD' || tier === 'RAISE')) return null; // 「不動」當成沒有異議（原型假設 2）
  const eff: Tier = action === 'REDUCE' && (tier === 'STANDARD' || tier === 'RAISE') ? 'HOLD' : tier;
  const sh = tierShares(acct, view, ticker, eff, stateBefore);
  const label = action === 'READD' && tier === 'HALF' ? '維持減半' : TIER_NAME[eff];
  return {
    choice: {
      id: 'AI',
      label: '照 AI',
      tier: eff,
      lines: sh ? [{ ticker, bucket: 'own', shares: sh, reason: 'AI 建議' }] : [],
      effects: [{ type: 'APPLY_TIER', ticker, tier: action === 'READD' && tier === 'HALF' ? 'HALF' : eff }],
    },
    aiLine: `AI（最近一次審查的檔位：${label}）：${sharesText(sh)}`,
  };
}

function ownRuleItem(acct: Account, view: MarketView, ticker: string, action: OwnAction, lines: OrderLine[], note: string): Item {
  const stateBefore: OwnState = action === 'REDUCE' ? 'STD' : 'HALF';
  const f = action === 'REDUCE' ? 'F7' : 'F8';
  const ai = ownAiChoice(acct, view, ticker, action, stateBefore);
  const choices: Choice[] = [{ id: 'RULE', label: '照規則', lines }];
  if (ai) choices.push(ai.choice);
  // F8：加回時註明未解除的硬事件標記、已成立的降級條件（ai_layer F8 卡片）
  const meta = acct.own[ticker];
  const warn = action === 'READD' && meta ? [...(meta.flags.length ? [`未解除的硬事件標記：${meta.flags.join('、')}`] : []), ...((meta.metConds ?? []).length ? [`已成立的降級條件：${meta.metConds!.join('；')}`] : [])] : [];
  return makeItem({
    f,
    kind: 'OWN_RULE',
    ticker,
    title: `${ticker} 慢規則${action === 'REDUCE' ? '減半' : '加回'}${note}`,
    choices,
    aiLine: ai?.aiLine,
    why: action === 'REDUCE' ? '收盤距 52 週高點跌 ≥ 20%' : '收盤站上 200 日均線連續 10 天、距上次切換 ≥ 15 個交易日',
    ...(warn.length ? { note: `注意：${warn.join('；')}` } : {}),
  });
}

/**
 * F7 的 AI 檢視晚一點才回來：還沒回覆的通知裡，這檔的慢規則項目照最新的 AI 檔位重算「照 AI」那個選項。
 * 已經回覆的不動。回傳改了哪幾則通知。
 */
export function refreshOwnAiChoice(acct0: Account, view: MarketView, ticker: string): { acct: Account; changed: number[] } {
  const acct = clone(acct0);
  const changed: number[] = [];
  for (const n of acct.notifs) {
    if (n.status !== 'PENDING') continue;
    for (const it of n.items) {
      if (it.kind !== 'OWN_RULE' || it.ticker !== ticker || it.cancelled) continue;
      const action: OwnAction = it.f === 'F7' ? 'REDUCE' : 'READD';
      const ai = ownAiChoice(acct, view, ticker, action, action === 'REDUCE' ? 'STD' : 'HALF');
      const keep = it.choices.filter((c) => c.id !== 'AI');
      it.choices = ai ? [keep[0], ai.choice, ...keep.slice(1)] : keep;
      it.aiLine = ai?.aiLine;
      if (it.choice === 'AI' && !ai) it.choice = it.ruleChoice;
      changed.push(n.id);
    }
  }
  return { acct, changed: [...new Set(changed)] };
}

/** 把規則的計畫（每一格的目標金額）變成清單項目。 */
function itemsFromPlan(acct: Account, view: MarketView, plan: PlanResult, values: Record<string, number>, ctx: { crashOpinion?: string; ownNotes?: Record<string, string>; coreBefore: CoreContext }): Item[] {
  const lines = planToLines(plan, values, { price: (t) => priceOf(view, t), shares: shareCells(acct) });
  const items: Item[] = [];
  const crashLines: OrderLine[] = [];
  const volLines: OrderLine[] = [];
  const reduced = new Set(plan.events.filter((e) => e.kind === 'REDUCE').map((e) => e.ticker));
  const added = new Set(plan.selection?.added ?? []);
  for (const l of lines) {
    const t = l.ticker;
    switch (l.reason) {
      case '崩盤規則':
        crashLines.push(l);
        break;
      case '波動度減碼':
        volLines.push(l);
        break;
      case '自選訊號': {
        const action: OwnAction = reduced.has(t) ? 'REDUCE' : 'READD';
        items.push(ownRuleItem(acct, view, t, action, [l], ctx.ownNotes?.[t] ?? ''));
        break;
      }
      case '動能換股':
        if (l.shares < 0) {
          const x = plan.selection?.exits.find((e) => e.ticker === t);
          const why = x ? (x.why === 'RANK_OUT' ? `排名第 ${x.rank}，掉出前 ${acct.cfg.exitRank} 名` : '掉出股票池') : '不在動能名單（上次的出場沒照做，策略類持續列入）';
          items.push(makeItem({ f: 'F2', kind: 'STRATEGY', ticker: t, title: `${t} 動能出場（${why}）`, choices: [{ id: 'DO', label: '照做', lines: [l] }], actions: ['TRANSFER'], why }));
        } else {
          items.push(
            makeItem({
              f: 'F1',
              kind: 'STRATEGY',
              ticker: t,
              title: `${t} 動能進場`,
              choices: [{ id: 'DO', label: '照做', lines: [l] }],
              actions: added.has(t) ? ['EXCLUDE', 'ADOPT'] : [],
              why: '排名前 5 且目前未持有',
            }),
          );
        }
        break;
      case '策略單補做':
        items.push(makeItem({ f: 'F17', kind: 'STRATEGY', ticker: t, title: `${t}：上次的策略單沒照做，差額再列一次`, choices: [{ id: 'DO', label: '照做', lines: [l] }], why: '策略類的偏離持續列入月報（設計 §2.3.1）' }));
        break;
      case '動能比例回調':
        items.push(makeItem({ f: 'F3', kind: 'STRATEGY', ticker: t, title: `${t} 動能比例回調（偏離目標超過 ±50%，搭本月其他單）`, choices: [{ id: 'DO', label: '照做', lines: [l] }], why: '只在本月本來就有其他單時才做' }));
        break;
      case '單檔上限':
      case '跨桶上限': {
        const ex = items.find((i) => i.f === 'F10' && i.ticker === t);
        if (ex) ex.choices[0].lines.push(l);
        else items.push(makeItem({ f: 'F10', kind: 'STRATEGY', ticker: t, title: l.reason === '單檔上限' ? `${t} 自選單檔超過 15% → 減回 10%` : `${t} 自選＋動能合計超過 15% → 減回 10%（先減動能）`, choices: [{ id: 'DO', label: '照做', lines: [l] }], why: '上限是風險控制，不需要搭便車' }));
        break;
      }
      default:
        items.push(makeItem({ f: 'SYS', kind: 'STRATEGY', ticker: t, title: `${t} ${l.reason}`, choices: [{ id: 'DO', label: '照做', lines: [l] }] }));
    }
  }
  if (plan.crashChanged) {
    const on = acct.rule.crash;
    const core = crashCoreLines(ctx.coreBefore, on);
    items.unshift(
      makeItem({
        f: on ? 'F5' : 'F6',
        kind: 'STRATEGY',
        ticker: acct.cfg.coreTicker,
        title: on ? '崩盤規則啟動：核心一半換短債、動能部位減半' : '崩盤規則解除：短債換回核心 ETF、動能部位恢復',
        choices: [{ id: 'DO', label: '照做', lines: [...core, ...crashLines] }],
        aiLine: ctx.crashOpinion ? `AI 檢視：${ctx.crashOpinion}` : undefined,
        why: on ? '核心 ETF 前一日收盤低於 200 日均線' : '核心 ETF 前一日收盤回到 200 日均線之上',
      }),
    );
  } else if (crashLines.length) {
    volLines.push(...crashLines);
  }
  if (volLines.length) {
    items.push(makeItem({ f: 'F4', kind: 'STRATEGY', title: '動能部位調整（依波動度減碼）', choices: [{ id: 'DO', label: '照做', lines: volLines }], why: plan.vol?.ratio != null ? `σ̃/σ = ${plan.vol.ratio.toFixed(2)}` : undefined }));
  }
  return items;
}

function excessVolOf(view: MarketView, benchmark: string) {
  const cache: Record<string, Float64Array> = {};
  const retOf = (t: string) => {
    const c = view.close[t];
    if (!c) return undefined;
    if (!cache[t]) {
      const r = new Float64Array(view.i + 1).fill(NaN);
      for (let k = Math.max(1, view.i - 130); k <= view.i; k++) r[k] = c[k] / c[k - 1] - 1;
      cache[t] = r;
    }
    return cache[t];
  };
  return (names: string[]) => excessVol(retOf, names, benchmark, view.i - 125, view.i + 1);
}

// ---------------------------------------------------------------- 每日檢查（收盤後）

export interface DailyResult {
  acct: Account;
  /** 今天新產生的通知。 */
  created: Notif[];
  /** 只記錄、不通知的事（R1 改變、訊號累積到月報、互相抵銷）。 */
  log: { ticker: string; what: string }[];
}

/**
 * 每天收盤後：自選慢規則前進一步、記錄 R1；單筆變動 ≥ 總資產 5% → 當天通知（隔天開盤執行），
 * 其餘累積到月報；發出 2 個交易日沒回報的通知提醒一次。
 */
export function dailyCheck(acct0: Account, view: MarketView): DailyResult {
  const acct = clone(acct0);
  const created: Notif[] = [];
  const log: DailyResult['log'] = [];
  for (const [tk, meta] of Object.entries(acct.own)) {
    const c = view.close[tk];
    if (!c) continue;
    const r1 = r1Of(c, view.i);
    if (meta.r1 !== null && meta.r1 !== r1) log.push({ ticker: tk, what: r1 ? 'R1 成立（只記錄）' : 'R1 解除（只記錄）' });
    meta.r1 = r1;
    const step = stepSlowRule(meta.slow, slowDayInput(c, view.i));
    meta.slow = step.next;
    if (step.signal) {
      if (meta.pending && meta.pending.action !== step.signal) {
        // 還沒下單的切換和這次互相抵銷
        meta.pending = null;
        log.push({ ticker: tk, what: '慢規則切換和尚未下單的上一次互相抵銷，月報不列' });
      } else {
        meta.pending = { action: step.signal, date: view.date };
      }
    }
  }
  // 單筆變動夠大的訊號 → 當天通知
  const pending: Record<string, OwnAction> = {};
  for (const [tk, m] of Object.entries(acct.own)) if (m.pending) pending[tk] = m.pending.action;
  const values = cellValues(acct, view);
  const due = dueOwnActions({ cfg: acct.cfg, pending, state: acct.rule, values, isMonthly: false });
  const total = totalValue(acct, view);
  for (const [tk, act] of Object.entries(pending)) {
    if (!(tk in due.todo)) {
      const chg = ownSignalChange(acct.rule, values, tk, act, total);
      if (acct.own[tk].pending?.date === view.date) log.push({ ticker: tk, what: `慢規則${act === 'REDUCE' ? '減半' : '加回'}：變動 ${((chg / total) * 100).toFixed(1)}% < 5%，累積到月報` });
    }
  }
  for (const [tk, act] of Object.entries(due.todo)) {
    const coreBefore = coreContext(acct, view);
    const plan = planDay({ cfg: acct.cfg, values, state: acct.rule, ownActions: { [tk]: act } });
    acct.rule = plan.state;
    acct.own[tk].pending = null;
    const items = itemsFromPlan(acct, view, plan, values, { coreBefore, ownNotes: { [tk]: '' } });
    if (!items.length) continue;
    const n = newNotif(acct, view, { kind: 'URGENT', title: `${tk} 慢規則${act === 'REDUCE' ? '減半' : '加回'}`, items });
    n.preview = composeNotif(acct, view, n);
    created.push(n);
  }
  // 提醒：發出後 2 個交易日沒有回報
  for (const n of acct.notifs) {
    if (n.status === 'PENDING' && !n.reminded && n.items.length && n.kind !== 'INFO' && view.i - n.seq >= 2) {
      n.reminded = true;
      created.push(newNotif(acct, view, { kind: 'INFO', title: `提醒：通知 #${n.id}（${n.date}）還沒回報`, text: '照做了嗎？回覆時選「忘了」會用當天價格重算清單；選「這次不做」就不再提醒。', ref: n.id, coreAbsorb: false }));
    }
  }
  return { acct, created, log };
}

// ---------------------------------------------------------------- 月報（每月第一個交易日開盤前）

export interface MonthlyResult {
  acct: Account;
  notif: Notif;
  plan: PlanResult | null;
}

const companyOfInput = (input: MonthlyContext) => (input.company ? (t: string) => input.company![t] ?? t : undefined);

/** 目前的動能名單裡，哪些新進場的代號要先過任務 A（給 AI 層用；不改狀態）。 */
export function monthlyCandidates(acct: Account, view: MarketView, input: MonthlyContext): string[] {
  const blocked = [...(input.vetoed ?? []), ...Object.keys(acct.mom.excluded), ...Object.keys(acct.mom.adopted)];
  const values = cellValues(acct, view);
  const plan = planDay({
    cfg: acct.cfg,
    values,
    state: acct.rule,
    monthly: { order: input.order, excessVol: () => NaN, coreBelow200: acct.rule.crash, blocked, emptySlots: input.emptySlots, companyOf: companyOfInput(input) },
  });
  return plan.selection?.added ?? [];
}

export function monthlyReport(acct0: Account, view: MarketView, input: MonthlyContext, flow?: FlowInput, flowCashAlreadyIn = false): MonthlyResult {
  const acct = clone(acct0);
  if (Object.values(acct.lots.unc).some((x) => x)) {
    // 清單外的變動還沒分類 → 月報暫停（設計 §2.1.1）
    acct.monthlyBlocked = true;
    const notif = newNotif(acct, view, { kind: 'INFO', title: '月報暫停：有未分類的持股變動', text: '請先回答那筆變動是手動交易、新增自選還是轉入自選，屬於哪一桶。分類後會重算月報。', coreAbsorb: false });
    // 留下這份月報的輸入（訊號日的排名），分類後用它重算（resumeMonthly）
    notif.monthly = { input: clone(input), before: { rule: clone(acct.rule), own: clone(acct.own), owe: clone(acct.mom.owe), cash: acct.cash } };
    return { acct, notif, plan: null };
  }
  acct.monthlyBlocked = false;
  const before = { rule: clone(acct.rule), own: clone(acct.own), owe: clone(acct.mom.owe), cash: acct.cash };
  // 入金遇到月報日：合成一份（規則引擎先把入金加進總資產，再跑月報規則）
  if (flow?.kind === '入金' && flowCashAlreadyIn) acct.cash -= flow.amount;
  const values = cellValues(acct, view);
  if (flow?.kind === '入金') {
    acct.cash += flow.amount;
    if (!flowCashAlreadyIn) recordExternalFlow(acct, view, flow.amount);
  }
  const coreBefore = coreContext(acct, view);
  const ownActions: Record<string, OwnAction> = {};
  const ownNotes: Record<string, string> = {};
  for (const [tk, m] of Object.entries(acct.own)) {
    if (m.pending) {
      ownActions[tk] = m.pending.action;
      ownNotes[tk] = `（${m.pending.date} 觸發，變動 < 5%，併入月報）`;
    }
  }
  const core = acct.cfg.coreTicker;
  const blocked = [...(input.vetoed ?? []), ...Object.keys(acct.mom.excluded), ...Object.keys(acct.mom.adopted)];
  const plan = planDay({
    cfg: acct.cfg,
    values,
    state: acct.rule,
    ownActions,
    flow,
    monthly: {
      order: input.order,
      excessVol: excessVolOf(view, view.benchmark ?? core),
      coreBelow200: crashRuleOn(view.close[core], view.i),
      blocked,
      owed: Object.keys(acct.mom.owe),
      emptySlots: input.emptySlots,
      companyOf: companyOfInput(input),
    },
  });
  acct.rule = plan.state;
  for (const tk of Object.keys(ownActions)) acct.own[tk].pending = null;
  acct.mom.owe = {};
  let items = itemsFromPlan(acct, view, plan, values, { coreBefore, ownNotes, crashOpinion: input.crashOpinion });
  // 任務 A 准許但觀察：進場那一項註明觀察理由
  for (const it of items) if (it.f === 'F1' && it.ticker && input.watch?.[it.ticker]) it.note = `准許但觀察：${input.watch[it.ticker]}`;
  if (flow) {
    // 入金合併在月報裡：入金補的格子併成一項
    const flowLines = items.filter((i) => i.f === 'SYS').flatMap((i) => i.choices[0].lines);
    items = items.filter((i) => i.f !== 'SYS');
    items.push(makeItem({ f: 'F11', kind: 'CASHFLOW', title: `入金 ${flow.amount}：只買不賣（和月報合成一份）`, choices: [{ id: 'DO', label: '照做', lines: flowLines }], noSkip: true }));
  }
  // F24／F23：AI 的月報建議（規則沒有動作的自選股）
  for (const [tk, m] of Object.entries(acct.own)) {
    if (!m.aiTier?.suggest || items.some((i) => i.ticker === tk && i.kind === 'OWN_RULE')) continue;
    const tier = m.aiTier.tier;
    const state = acct.rule.own[tk].applied;
    if (tier === 'HOLD' || (tier === 'HALF' && state === 'HALF') || (tier === 'STANDARD' && state === 'STD')) continue;
    const sh = tierShares(acct, view, tk, tier, state);
    m.aiTier.suggest = false;
    if (!sh) continue;
    const raise = tier === 'RAISE';
    items.push(
      makeItem({
        f: raise ? 'F23' : 'F24',
        kind: 'AI_ONLY',
        ticker: tk,
        title: raise ? `${tk} 提高標準比重的建議` : `${tk} 自選定期審查的建議`,
        aiLine: `AI 建議：${TIER_NAME[tier]}，${sharesText(sh)}`,
        choices: [{ id: 'AI', label: '照 AI', tier, lines: [{ ticker: tk, bucket: 'own', shares: sh, reason: 'AI 建議' }], effects: [{ type: 'APPLY_TIER', ticker: tk, tier }] }],
        choice: 'SKIP',
        ruleChoice: 'SKIP',
      }),
    );
  }
  // 還沒回覆的「補做差額」清單和本月重列的策略單重疊 → 以月報為準（原型假設 10）
  for (const old of acct.notifs) {
    if (old.status !== 'PENDING' || old.kind !== 'FIX') continue;
    for (const it of old.items) {
      if (!it.cancelled && items.some((i) => i.ticker === it.ticker && i.kind === 'STRATEGY')) {
        it.cancelled = true;
        it.note = `已併入 ${input.month} 月報`;
      }
    }
    if (old.items.every((i) => i.cancelled)) old.status = 'READ';
  }
  const status = `崩盤規則：${acct.rule.crash ? '啟動中' : '未啟動'}；動能比例 ${thirdLabel(acct.rule.volW ?? 1)}` + (input.paused ? `；本月暫停換股（${input.paused}），動能名單不變` : '') + (input.notes?.length ? `\n${input.notes.join('\n')}` : '');
  const probe: Notif = { id: 0, kind: 'MONTHLY', date: view.date, seq: view.i, title: '', items, status: 'PENDING', coreAbsorb: true, reminded: false };
  const preview = composeNotif(acct, view, probe);
  if (!items.length && preview.lines.length) {
    // 沒有規則單，但帳上有閒置現金（例如股利）→ 月報一起交給核心（設計 §2.1 第 3 點）
    items.push(makeItem({ f: 'CORE', kind: 'STRATEGY', title: '帳上的現金交給核心', choices: [{ id: 'DO', label: '照做', lines: [] }], why: '股利與零頭現金在月報一起處理' }));
  }
  const notif = newNotif(acct, view, {
    kind: items.length ? 'MONTHLY' : 'MONTHLY_EMPTY',
    title: items.length ? `${input.month} 月報` : `${input.month} 月報：本月不用動`,
    text: status,
    items,
    coreAbsorb: items.length > 0,
    monthly: { input: clone(input), before },
    deposit: flow?.kind === '入金' ? flow.amount : undefined,
  });
  notif.preview = composeNotif(acct, view, notif);
  return { acct, notif, plan };
}

/** 因為未分類的變動而暫停的月報（還沒處理的那一則）。 */
export function blockedMonthly(acct: Account): Notif | null {
  return acct.notifs.find((n) => n.kind === 'INFO' && n.status === 'PENDING' && !!n.monthly && n.title.startsWith('月報暫停')) ?? null;
}

/**
 * 分類完之後重算暫停的月報：用暫停那一則留下的輸入（訊號日的排名），價格用現在的 view。
 * 沒有留下輸入的舊通知用 fallback。暫停的那一則改成已讀。
 */
export function resumeMonthly(acct0: Account, view: MarketView, fallback?: MonthlyContext): { acct: Account; notif: Notif | null } {
  const blocked = blockedMonthly(acct0);
  const input = blocked?.monthly?.input ?? fallback;
  if (!input) return { acct: acct0, notif: null };
  const r = monthlyReport(acct0, view, input);
  for (const x of r.acct.notifs) if (x.kind === 'INFO' && x.status === 'PENDING' && x.title.startsWith('月報暫停') && x.id !== r.notif.id) x.status = 'READ';
  return { acct: r.acct, notif: r.notif };
}

function thirdLabel(w: number): string {
  if (w >= 0.999) return '1';
  if (Math.abs(w - 2 / 3) < 0.01) return '2/3';
  if (Math.abs(w - 1 / 3) < 0.01) return '1/3';
  return '0';
}

/** 外部資金流（入金正、出金負）：整個帳戶與核心桶的單位數跟著變。 */
export function recordExternalFlow(acct: Account, view: MarketView, amount: number): void {
  // 呼叫前現金已經加上（或扣掉）這筆金額
  const totalBefore = totalValue(acct, view) - amount;
  const coreBefore = bucketValue(acct, view, 'core') - amount;
  const per = (v: number, u: number) => (u > 1e-9 && v > 1e-9 ? v / u : 1);
  acct.units.total = Math.max(0, acct.units.total + amount / per(totalBefore, acct.units.total));
  acct.units.core = Math.max(0, acct.units.core + amount / per(coreBefore, acct.units.core));
  acct.events.push({ date: view.date, kind: amount > 0 ? 'DEPOSIT' : 'WITHDRAW', amount: Math.abs(amount) });
}

// ---------------------------------------------------------------- AI 層與硬事件給的輸入

/** AI 層回報：這檔自選的最新 F24 檔位。suggest = 3 票一致、和目前不同、有通過檢查的證據。 */
export function recordAiTier(acct0: Account, ticker: string, tier: Tier, date: string, suggest: boolean, runId?: string): Account {
  const acct = clone(acct0);
  if (acct.own[ticker]) acct.own[ticker].aiTier = { tier, date, suggest, runId };
  return acct;
}

/**
 * F25：自選降級條件成立（3 票確認、引用通過檢查）→ 當天通知 AI 建議；規則沒有動作，所以只有 AI 一行＋「不做」。
 * 每檔每月最多 perMonth 則（只算 F25，原型假設 6）。回傳 notif = null 表示這次不發。
 */
export function conditionMet(acct0: Account, view: MarketView, ticker: string, tier: Tier, text: string, month: string, perMonth = 1): { acct: Account; notif: Notif | null; why?: string } {
  const acct = clone(acct0);
  const meta = acct.own[ticker];
  if (!meta) return { acct, notif: null, why: '不是自選股' };
  if ((meta.f25Sent[month] ?? 0) >= perMonth) return { acct, notif: null, why: `本月已發過 ${perMonth} 則，只放網站` };
  const sh = tierShares(acct, view, ticker, tier, acct.rule.own[ticker].applied);
  if (sh >= 0) return { acct, notif: null, why: '檔位不需要賣' };
  meta.f25Sent[month] = (meta.f25Sent[month] ?? 0) + 1;
  meta.metConds = [...(meta.metConds ?? []), text];
  const item = makeItem({
    f: 'F25',
    kind: 'AI_ONLY',
    ticker,
    title: `${ticker}：條件「${text}」成立`,
    aiLine: `AI 建議${TIER_NAME[tier]}，${sharesText(sh)}`,
    choices: [{ id: 'AI', label: '照 AI', tier, lines: [{ ticker, bucket: 'own', shares: sh, reason: 'AI 建議' }], effects: [{ type: 'APPLY_TIER', ticker, tier }] }],
    choice: 'SKIP',
    ruleChoice: 'SKIP',
  });
  const notif = newNotif(acct, view, { kind: 'URGENT', title: `${ticker} 條件成立（F25）`, items: [item] });
  notif.preview = composeNotif(acct, view, notif);
  return { acct, notif };
}

/**
 * F19 硬事件：建議提早出場，使用者確認才做（設計 §6.2）。
 * byRule = true：動能持股被收購（PENDING_MA）或 NT 10-K／10-Q，由規則直接提出，不需要 AI。
 */
export function hardEvent(acct0: Account, view: MarketView, ticker: string, code: 'PENDING_MA' | 'ACCOUNTING' | 'REGULATORY', byRule: boolean): { acct: Account; notif: Notif | null } {
  const acct = clone(acct0);
  const items: Item[] = [];
  const ownSh = acct.lots.own[ticker] ?? 0;
  const momSh = acct.lots.mom[ticker] ?? 0;
  if (ownSh > 0 && acct.own[ticker]) {
    if (!acct.own[ticker].flags.includes(code)) acct.own[ticker].flags.push(code);
    // 規則直接提出（自選股的 NT 10-K／10-Q）：和動能一樣預設「確認出清」，使用者回覆才算做了
    items.push(
      makeItem({
        f: 'F19',
        kind: 'HARD',
        ticker,
        title: byRule ? `${ticker} ${code}：規則提出提早出場（自選）` : `${ticker} ${code}：AI 建議提早出場（自選）`,
        choices: [{ id: byRule ? 'DO' : 'AI', label: byRule ? '確認出清' : '照 AI（出清）', tier: 'EXIT', lines: [{ ticker, bucket: 'own', shares: -ownSh, reason: byRule ? '硬事件' : 'AI 建議' }], effects: [{ type: 'APPLY_TIER', ticker, tier: 'EXIT' }] }],
        choice: byRule ? 'DO' : 'SKIP',
        ruleChoice: byRule ? 'DO' : 'SKIP',
      }),
    );
  }
  if (momSh > 0) {
    items.push(
      makeItem({
        f: 'F19',
        kind: 'HARD',
        ticker,
        title: byRule ? `${ticker} ${code}：規則提出提早出場（動能）` : `${ticker} ${code}：AI 建議提早出場（動能）`,
        choices: [{ id: byRule ? 'DO' : 'AI', label: byRule ? '確認出場' : '照 AI（出場）', lines: [{ ticker, bucket: 'mom', shares: -momSh, reason: '動能換股' }] }],
        choice: byRule ? 'DO' : 'SKIP',
        ruleChoice: byRule ? 'DO' : 'SKIP',
      }),
    );
    // 名單拿掉這一檔，下個月照排名遞補；沒確認出場的話，下個月月報會再列一次
    acct.rule.heldMom = acct.rule.heldMom.filter((t) => t !== ticker);
  }
  if (!items.length) return { acct, notif: null };
  const notif = newNotif(acct, view, { kind: 'URGENT', title: `${ticker} 硬事件（${code}）`, items });
  notif.preview = composeNotif(acct, view, notif);
  return { acct, notif };
}

// ---------------------------------------------------------------- 策略檢討（設計 §7）

export interface StrategyReviewState {
  /** 純動能部位相對基準的累積表現。 */
  rel: number;
  peak: number;
  /** 這次落後事件從哪一天開始；null = 不在事件中。 */
  eventStart: string | null;
  /** 這次事件已經提醒過的門檻（-0.2、-0.3…）。 */
  notified: number[];
  /** 這次事件已經提醒過滿幾年。 */
  yearsNotified: number;
}

export const REVIEW_THRESHOLDS = [-0.2, -0.3, -0.4, -0.5];

export function initialReviewState(): StrategyReviewState {
  return { rel: 1, peak: 1, eventStart: null, notified: [], yearsNotified: 0 };
}

/**
 * 每個交易日更新一次：modelReturn 是動能名單等權的日報酬，benchReturn 是基準的日報酬。
 * 落後首次超過 20% 開始一次事件；加深到 30／40／50% 各提醒一次；每滿一年提醒一次；創新高時事件結束。
 * 永不自動停用，只提醒。
 */
export function stepStrategyReview(s0: StrategyReviewState, date: string, modelReturn: number, benchReturn: number): { state: StrategyReviewState; alerts: string[] } {
  const s = clone(s0);
  const alerts: string[] = [];
  s.rel *= 1 + modelReturn - benchReturn;
  if (s.rel > s.peak) {
    s.peak = s.rel;
    if (s.eventStart) {
      s.eventStart = null;
      s.notified = [];
      s.yearsNotified = 0;
    }
    return { state: s, alerts };
  }
  const dd = s.rel / s.peak - 1;
  for (const th of REVIEW_THRESHOLDS) {
    if (dd <= th && !s.notified.includes(th)) {
      s.notified.push(th);
      if (!s.eventStart) s.eventStart = date;
      alerts.push(`動能相對基準落後超過 ${Math.round(-th * 100)}%（目前 ${(dd * 100).toFixed(0)}%，事件從 ${s.eventStart} 開始）`);
    }
  }
  if (s.eventStart) {
    const years = Math.floor((Date.parse(date) - Date.parse(s.eventStart)) / (365.25 * 86_400_000));
    if (years > s.yearsNotified) {
      s.yearsNotified = years;
      alerts.push(`動能落後事件已滿 ${years} 年（從 ${s.eventStart} 開始，目前 ${(dd * 100).toFixed(0)}%）`);
    }
  }
  return { state: s, alerts };
}

/** F21：策略檢討提醒（不附清單的提醒，設計 §2.5 的例外；永不自動停用）。 */
export function strategyReminder(acct0: Account, view: MarketView, text: string): { acct: Account; notif: Notif } {
  const acct = clone(acct0);
  const notif = newNotif(acct, view, { kind: 'INFO', title: '策略檢討提醒', text: `${text}。系統不會自動停用策略；AI 會逐條列出前提的正反證據（不給停用或繼續的建議），報告在網站。`, coreAbsorb: false });
  return { acct, notif };
}
