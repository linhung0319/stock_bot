// 每日檢查與月報：把規則的結果變成「通知＋清單」，每一項附選項（照規則／照 AI／這次不做）。
// 設計：§2.0 觸發總表、§2.2 自選、§2.3 操作方式、§2.5 觸發與通知。
import {
  CORE_OWE_UNANSWERED_REASON,
  TIER_NAME,
  bucketValue,
  cellValues,
  clone,
  makeItem,
  newNotif,
  priceOf,
  shareCells,
  syncRunIds,
  totalValue,
  type Account,
  type Choice,
  type CondNotice,
  type CoreOwe,
  type CrashReviewInfo,
  type DropStatus,
  type Item,
  type MarketView,
  type MonthlyContext,
  type Notif,
  type OwnMeta,
  type ReviewTrigger,
  type SavedState,
  type Tier,
  usd,
} from './account';
import { dueOwnActions, ownSignalChange, planDay, type FlowInput, type PlanResult } from './allocator';
import { drawdownFromHigh, excessVol } from './indicators';
import { composeWithCore, crashCoreLines, mergeByTicker, planToLines, type Composed, type CoreContext, type OrderLine } from './orders';
import { crashDecision, validBars } from './risk';
import { SLOW, halveShares, slowDayInput, stepSlowRule } from './slowRule';
import { cellKey, type OwnAction, type OwnState } from './types';

// ---------------------------------------------------------------- 共用

export function coreContext(acct: Account, view: MarketView, reserveCash = 0, halfUpTo = 0): CoreContext {
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
    halfUpTo,
  };
}

/**
 * 還沒填快照的清單都照做之後的持股與現金（T38 走一遍的缺口）：另一份清單已經回覆、還沒成交時，
 * 入金、出金、改比例與「核心吸收現金」原本都用成交前的持股與現金算，會把那一份已經要買、要賣的再列一次，
 * 同一筆閒置現金也會再交給核心一次。
 *   已回覆的照合成的清單（composed，含核心吸收的部分）；pending = true 時，還沒回覆的也照每一項目前選的選項算（不含核心吸收）。
 *   except：正在算的那一則；before：只算編號比它小的。
 *   規則狀態：月報、減半在產生清單時就已經改了目標，不再動；只有成交時才生效的選項效果（移出自選、照 AI 的檔位、動能照 AI 出場）
 *   照樣套到 rule 上（不然移出自選的那一檔賣光之後，入金會照它的標準比重再買回來）。
 */
export function afterOpenLists(acct: Account, view: MarketView, opt: { except?: number; before?: number; pending?: boolean } = {}): Account {
  const open = acct.notifs.filter((n) => n.id !== opt.except && (opt.before === undefined || n.id < opt.before) && n.kind !== 'INFO' && ((n.status === 'RESPONDED' && !!n.composed) || (!!opt.pending && n.status === 'PENDING' && n.items.length > 0)));
  if (!open.length) return acct;
  const lots = { own: { ...acct.lots.own }, mom: { ...acct.lots.mom }, core: { ...acct.lots.core }, unc: { ...acct.lots.unc } };
  let cash = acct.cash;
  let rule = acct.rule;
  const ruleW = () => (rule === acct.rule ? (rule = clone(acct.rule)) : rule);
  for (const n of open) {
    const chosen = n.items.filter((it) => !it.cancelled).map((it) => it.choices.find((c) => c.id === it.choice));
    const lines = n.status === 'RESPONDED' ? n.composed!.lines : chosen.flatMap((c) => c?.lines ?? []);
    for (const l of lines) {
      if (!l.shares) continue;
      const v = (lots[l.bucket][l.ticker] ?? 0) + l.shares;
      if (Math.abs(v) < 1e-9) delete lots[l.bucket][l.ticker];
      else lots[l.bucket][l.ticker] = v;
      cash -= l.shares * priceOf(view, l.ticker);
    }
    cash -= n.withdraw ?? 0;
    for (const e of chosen.flatMap((c) => c?.effects ?? [])) {
      if (e.type === 'REMOVE_OWN' || (e.type === 'APPLY_TIER' && e.tier === 'EXIT')) {
        if (rule.own[e.ticker]) delete ruleW().own[e.ticker];
      } else if (e.type === 'MOM_DROP') {
        if (rule.heldMom.includes(e.ticker)) ruleW().heldMom = rule.heldMom.filter((t) => t !== e.ticker);
      } else if (e.type === 'APPLY_TIER' && rule.own[e.ticker]) {
        const o = ruleW().own[e.ticker];
        if (e.tier === 'HALF') o.applied = 'HALF';
        else if (e.tier === 'STANDARD') o.applied = 'STD';
        else if (e.tier === 'RAISE') o.stdWeight *= 1.25;
      }
    }
  }
  return { ...acct, lots, cash, rule };
}

/** 照每一項目前選的選項合成清單；核心吸收差額。已回覆、還沒填快照的其他清單先當成做完了（afterOpenLists）。 */
export function composeNotif(acct0: Account, view: MarketView, n: Notif): Composed {
  const acct = afterOpenLists(acct0, view, { except: n.id });
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
  // 崩盤規則啟動中多的錢（core_ai §3.8）：切換那一份（有 F5）照舊一半一半；入金在入金金額以內一半一半；其他全部放短債
  const halfUpTo = n.items.some((i) => i.f === 'F5' && !i.cancelled) ? Infinity : (n.deposit ?? 0);
  return composeWithCore(lines, coreContext(acct, view, n.withdraw ?? 0, halfUpTo));
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

// ---------------------------------------------------------------- 慢規則通知上的 AI 那一行與選項（own_thesis §3.4）

/** 跌幅的歸類（減半檢視的 cause_class）的白話。 */
export const DROP_CAUSE_TEXT: Record<string, string> = { MARKET: '大盤一起跌', SECTOR: '產業一起跌', FUNDAMENTAL: '公司基本面', ONE_OFF: '一次性事件', UNKNOWN: '看不出原因' };
/** 減半項目的理由（慢規則是底線，§3.2）。 */
export const REDUCE_WHY = '收盤距 52 週高點跌 ≥ 20%。慢規則是底線：你沒有另外決定時照它做。';
/** 只有預設前提的股票，理由後面加的那一句（§3.4）。 */
export const DEFAULT_ONLY_WHY = '這檔還沒有你的論點，AI 只檢查系統預設前提。';
/** AI 建議出清、你選了照規則（沒有另外寫理由）時，靜默期記的理由（§3.4）。 */
export const RULE_OVER_EXIT_REASON = '照規則減半，沒有照 AI 出清';

/** 慢規則項目上 AI 的那一部分：那一行、「照 AI」選項（有才有）、狀態。 */
interface OwnAi {
  choice?: Choice;
  aiLine?: string;
  runIds?: string[];
  drop?: DropStatus;
  /** 帶「出清」那一行時：哪一條前提（寫 BREAK_NOTICE、拿去討論、靜默期用）。 */
  exitPremise?: string;
}

const premiseText = (meta: OwnMeta, id: string) => meta.premises.find((p) => p.id === id)?.text ?? id;

/** 那條前提在靜默中 → `（你在 M/D 對這條前提表示不同意）`；靜默期不擋慢規則通知上的那一行（§3.4）。 */
function disputeNote(meta: OwnMeta, premiseId: string, date: string): string {
  const d = (meta.disputes ?? []).find((x) => x.premiseId === premiseId && x.until >= date);
  return d ? `（你在 ${mdOf(d.since)} 對這條前提表示不同意）` : '';
}

/**
 * 觸發之後另外回來的審查（§3.4）：aiTier 的日期不早於觸發日、不是減半檢視自己寫的、三票一致而且資料沒有缺漏、有一條不成立的前提（還在現行的前提裡）、
 * 檔位是出清或減半。靜默期不看。沒有的話看併進來的乙類通知（absorbed）。
 * since：沒有 dropReview（開減半檢視時的狀態沒有存成、舊通知）時，用通知的訊號日當觸發日。
 */
function reviewOnTop(meta: OwnMeta, absorbed: Item['absorbed'], since: string): { tier: 'EXIT' | 'HALF'; premiseId: string; date: string; runIds: string[] } | null {
  const live = (id: string) => meta.premises.some((p) => p.id === id);
  const ai = meta.aiTier;
  const dr = meta.dropReview;
  if (ai && ai.date >= (dr?.session ?? since) && ai.trigger !== 'DROP' && ai.agreed && ai.premiseId && live(ai.premiseId) && (ai.tier === 'EXIT' || ai.tier === 'HALF')) {
    return { tier: ai.tier, premiseId: ai.premiseId, date: ai.date, runIds: ai.runId ? [ai.runId] : [] };
  }
  if (absorbed && live(absorbed.premiseId)) return { tier: absorbed.tier, premiseId: absorbed.premiseId, date: absorbed.date, runIds: absorbed.runIds ?? [] };
  return null;
}

/**
 * 減半項目（F7）的 AI 那一部分（§3.4 的表）。原則：「照 AI」只來自看過這次觸發的結論（修 K1、K2）——
 * 減半檢視的結果（dropReview），或觸發之後另外回來的審查；觸發之前的審查檔位不用。
 */
function reduceAi(acct: Account, view: MarketView, ticker: string, absorbed: Item['absorbed'], since: string): OwnAi {
  const meta = acct.own[ticker];
  if (!meta) return {};
  const dr = meta.dropReview ?? null;
  const top = reviewOnTop(meta, absorbed, since);
  const exit = (premiseId: string, lead: string, runIds: string[]): OwnAi => {
    const sh = tierShares(acct, view, ticker, 'EXIT', 'STD');
    const act = `出清，${sharesText(sh)}`;
    return {
      choice: { id: 'AI', label: `照 AI：${act}`, tier: 'EXIT', lines: sh ? [{ ticker, bucket: 'own', shares: sh, reason: 'AI 建議' }] : [], effects: [{ type: 'APPLY_TIER', ticker, tier: 'EXIT' }] },
      aiLine: `${lead}前提「${premiseText(meta, premiseId)}」不成立。AI 建議${act}${disputeNote(meta, premiseId, view.date)}`,
      drop: 'EXIT',
      exitPremise: premiseId,
      ...(runIds.length ? { runIds } : {}),
    };
  };
  const drRun = dr?.runId ? [dr.runId] : [];
  if (dr?.status === 'EXIT' && dr.premiseId) return exit(dr.premiseId, '論點檢查（3 票）：', drRun);
  if (top?.tier === 'EXIT') return exit(top.premiseId, `${mdOf(top.date)} 的審查（3 票）：`, top.runIds);
  // 另外的審查認為有一條前提不成立、同意減半 → 沒有「不動」選項
  if (top) return { aiLine: `${mdOf(top.date)} 的審查認為前提「${premiseText(meta, top.premiseId)}」不成立，同意減半${disputeNote(meta, top.premiseId, view.date)}`, drop: 'AGREE', ...(top.runIds.length ? { runIds: top.runIds } : {}) };
  if (!dr) return {};
  const runIds = drRun.length ? { runIds: drRun } : {};
  switch (dr.status) {
    case 'PENDING':
      return { aiLine: 'AI 論點檢查進行中，台灣 09:30 前更新', drop: 'PENDING', ...runIds };
    case 'HOLD':
      // 只有預設前提的股票不會有「不動」（§3.3：沒有論點就沒有東西可檢查）；萬一出現，當成沒有可用的結論
      if (defaultOnly(meta)) break;
      return {
        choice: { id: 'AI', label: '照 AI：不動', tier: 'HOLD', lines: [], effects: [{ type: 'APPLY_TIER', ticker, tier: 'HOLD' }] },
        aiLine: `論點檢查（3 票）：跌幅主要是${dr.cause === 'MARKET' ? '大盤一起跌' : '產業一起跌'}；你的 ${meta.premises.length} 條前提都沒有被判不成立。AI 建議不動`,
        drop: 'HOLD',
        ...runIds,
      };
    case 'AGREE':
      return { aiLine: `論點檢查（3 票）：同意減半${dr.cause && DROP_CAUSE_TEXT[dr.cause] ? `（歸類：${DROP_CAUSE_TEXT[dr.cause]}）` : ''}`, drop: 'AGREE', ...runIds };
    default:
      break;
  }
  return { aiLine: 'AI 論點檢查沒有一致結論，照規則', drop: 'NONE', ...runIds };
}

/**
 * 加回項目（F8）的「照 AI」（維持減半／出清）：只在 aiTier 的檔位是減半或出清、三票判同一條前提不成立（有 premiseId）、
 * 而且那條前提還在現行的前提裡時列（§3.4）。審查在減半狀態下選了「減半」但沒有不成立的前提，不算異議（修 K5）。
 */
function readdAi(acct: Account, view: MarketView, ticker: string): OwnAi {
  const meta = acct.own[ticker];
  const ai = meta?.aiTier;
  if (!meta || !ai || !ai.agreed || !ai.premiseId || (ai.tier !== 'HALF' && ai.tier !== 'EXIT') || !meta.premises.some((p) => p.id === ai.premiseId)) return {};
  const sh = tierShares(acct, view, ticker, ai.tier, 'HALF');
  const act = ai.tier === 'HALF' ? '維持減半' : `出清，${sharesText(sh)}`;
  return {
    choice: { id: 'AI', label: `照 AI：${act}`, tier: ai.tier, lines: sh ? [{ ticker, bucket: 'own', shares: sh, reason: 'AI 建議' }] : [], effects: [{ type: 'APPLY_TIER', ticker, tier: ai.tier }] },
    aiLine: `${mdOf(ai.date)} 的審查認為前提「${premiseText(meta, ai.premiseId)}」不成立：AI 建議${act}${disputeNote(meta, ai.premiseId, view.date)}`,
    ...(ai.runId ? { runIds: [ai.runId] } : {}),
  };
}

/** 把 AI 那一部分寫到項目上（選項順序固定：照規則、照 AI、這次不做）。回傳有沒有變。 */
function setOwnAi(acct: Account, it: Item, ai: OwnAi): boolean {
  const before = JSON.stringify([it.choices, it.aiLine, it.runIds, it.drop, it.brk, it.why, it.choice]);
  const keep = it.choices.filter((c) => c.id !== 'AI');
  it.choices = ai.choice ? [keep[0], ai.choice, ...keep.slice(1)] : keep;
  const set = <K extends 'aiLine' | 'runIds' | 'drop' | 'brk'>(k: K, v: Item[K] | undefined) => {
    if (v === undefined) delete it[k];
    else it[k] = v;
  };
  set('aiLine', ai.aiLine);
  set('runIds', ai.runIds);
  if (it.f === 'F7') {
    set('drop', ai.drop);
    set('brk', ai.exitPremise ? { type: 'B', premiseId: ai.exitPremise, withRule: true } : undefined);
    const meta = it.ticker ? acct.own[it.ticker] : undefined;
    it.why = REDUCE_WHY + (meta && ai.drop && defaultOnly(meta) ? DEFAULT_ONLY_WHY : '');
  }
  if (it.choice === 'AI' && !ai.choice) it.choice = it.ruleChoice;
  return before !== JSON.stringify([it.choices, it.aiLine, it.runIds, it.drop, it.brk, it.why, it.choice]);
}

/**
 * 慢規則的通知產生時，同一檔有還沒回覆的乙類通知（§3.4、§1.9）：那一項取消、整則只剩取消的就標 SUPERSEDED，內容併進慢規則項目。
 * 沒有乙類、但月中有記著等月報的建議（往下的檔位、有不成立的前提）→ 一樣併進來，不再另列一項。
 */
function absorbBreak(acct: Account, view: MarketView, ticker: string): Item['absorbed'] {
  const meta = acct.own[ticker];
  if (!meta) return undefined;
  const pb = pendingBreak(acct, ticker);
  if (pb && pb.it.brk?.type === 'B') {
    const tier = pb.it.choices.find((c) => c.id === 'AI')?.tier === 'EXIT' ? 'EXIT' : 'HALF';
    const premiseId = pb.it.brk.premiseId;
    const date = meta.aiTier?.premiseId === premiseId && meta.aiTier.date <= pb.n.date ? meta.aiTier.date : pb.n.date;
    pb.it.cancelled = true;
    pb.it.note = `慢規則也觸發減半了，這一項併進 ${ticker} 的慢規則減半通知（在那裡決定）`;
    if (pb.n.items.every((i) => i.cancelled)) pb.n.status = 'SUPERSEDED';
    else pb.n.preview = composeNotif(acct, view, pb.n);
    return { notif: pb.n.id, tier, premiseId, date, ...(pb.it.runIds?.length ? { runIds: [...pb.it.runIds] } : {}) };
  }
  const ai = meta.aiTier;
  if (ai?.suggest && ai.premiseId && (ai.tier === 'EXIT' || ai.tier === 'HALF')) {
    ai.suggest = false;
    return { notif: 0, tier: ai.tier, premiseId: ai.premiseId, date: ai.date, ...(ai.runId ? { runIds: [ai.runId] } : {}) };
  }
  // 月報重算（入金合併、排除）：被取代的那一份月報上這檔的減半項目併過的，沿用
  for (let k = acct.notifs.length - 1; k >= 0; k--) {
    const old = acct.notifs[k].items.find((i) => i.f === 'F7' && i.ticker === ticker);
    if (!old) continue;
    return acct.notifs[k].status === 'SUPERSEDED' && old.absorbed ? clone(old.absorbed) : undefined;
  }
  return undefined;
}

/** dd：觸發那天距 52 週高點的跌幅（減半項目的標題用；沒有就用訊號日的）。 */
function ownRuleItem(acct: Account, view: MarketView, ticker: string, action: OwnAction, lines: OrderLine[], note: string, dd?: number): Item {
  const meta = acct.own[ticker];
  if (action === 'REDUCE') {
    const absorbed = absorbBreak(acct, view, ticker);
    const c = view.close[ticker];
    const d = dd ?? (c ? drawdownFromHigh(c, view.i, SLOW.highDays) : NaN);
    const it = makeItem({
      f: 'F7',
      kind: 'OWN_RULE',
      ticker,
      title: Number.isFinite(d) ? `${ticker}：比 52 週高點低 ${(-d * 100).toFixed(1)}% → 慢規則減半${note}` : `${ticker} 慢規則減半${note}`,
      choices: [{ id: 'RULE', label: '照規則', lines }],
      why: REDUCE_WHY,
      // 「這次不做」要寫一句理由（§3.4；整則通知選這次不做時也要）
      reasonRequired: true,
      ...(absorbed ? { absorbed } : {}),
    });
    setOwnAi(acct, it, reduceAi(acct, view, ticker, absorbed, view.date));
    return it;
  }
  // F8：加回時註明未解除的硬事件標記、已成立的降級條件（ai_layer F8 卡片）
  const warn = meta ? [...(meta.flags.length ? [`未解除的硬事件標記：${meta.flags.join('、')}`] : []), ...((meta.metConds ?? []).length ? [`已成立的降級條件：${meta.metConds!.join('；')}`] : [])] : [];
  const it = makeItem({
    f: 'F8',
    kind: 'OWN_RULE',
    ticker,
    title: `${ticker} 慢規則加回${note}`,
    choices: [{ id: 'RULE', label: '照規則', lines }],
    why: '收盤站上 200 日均線連續 10 天、距上次切換 ≥ 15 個交易日',
    ...(warn.length ? { note: `注意：${warn.join('；')}` } : {}),
  });
  setOwnAi(acct, it, readdAi(acct, view, ticker));
  return it;
}

/**
 * 還沒回覆的通知裡，這檔的慢規則項目照現在的狀態重算 AI 那一行與「照 AI」選項（§3.4）：
 * 減半檢視的結果回來、觸發之後另外有審查回來、開減半檢視時寫 PENDING 都會呼叫。已經回覆的不動。回傳改了哪幾則通知。
 */
export function refreshOwnAiChoice(acct0: Account, view: MarketView, ticker: string): { acct: Account; changed: number[] } {
  const acct = clone(acct0);
  const changed: number[] = [];
  for (const n of acct.notifs) {
    if (n.status !== 'PENDING') continue;
    for (const it of n.items) {
      if (it.kind !== 'OWN_RULE' || it.ticker !== ticker || it.cancelled) continue;
      const ai = it.f === 'F7' ? reduceAi(acct, view, ticker, it.absorbed, n.date) : readdAi(acct, view, ticker);
      if (!setOwnAi(acct, it, ai)) continue;
      syncRunIds(n);
      changed.push(n.id);
    }
  }
  return { acct, changed: [...new Set(changed)] };
}

/** 把規則的計畫（每一格的目標金額）變成清單項目。 */
function itemsFromPlan(acct: Account, view: MarketView, plan: PlanResult, values: Record<string, number>, ctx: { crashReview?: CrashReviewInfo; ownNotes?: Record<string, string>; coreBefore: CoreContext; runIds?: MonthlyContext['runIds'] }): Item[] {
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
        items.push(ownRuleItem(acct, view, t, action, [l], ctx.ownNotes?.[t] ?? '', action === 'REDUCE' ? (acct.own[t]?.reduceDd ?? undefined) : undefined));
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
              ...(ctx.runIds?.entry?.[t] ? { runIds: [ctx.runIds.entry[t]] } : {}),
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
        // 檢視的狀態（core_ai §3.2）：aiLine 只在三票一致時寫（LINE 讀它）；runIds 只要有執行就帶
        ...crashReviewFields(ctx.crashReview, ctx.runIds?.crash),
        why: on ? '核心 ETF 前一日收盤低於 200 日均線' : '核心 ETF 前一日收盤回到 200 日均線之上',
        // 「這次不做」要寫一句理由（core_ai §3.6；整則月報選這次不做時也要）
        reasonRequired: true,
      }),
    );
  } else if (crashLines.length) {
    volLines.push(...crashLines);
  }
  if (volLines.length) {
    items.push(makeItem({ f: 'F4', kind: 'STRATEGY', title: '動能部位調整（依波動度減碼）', choices: [{ id: 'DO', label: '照做', lines: volLines }], why: plan.vol?.ratio != null ? `σ̃/σ = ${plan.vol.ratio.toFixed(2)}` : undefined }));
  }
  // 策略項目每一行的目標占總資產的比例（晚回覆時用回覆當天的價格重算，T39b）；核心那兩檔不在 plan 的格子裡，另外重算
  const total = plan.total;
  if (total > 0) {
    for (const it of items) {
      if (it.kind !== 'STRATEGY') continue;
      const tw: Record<string, number> = {};
      for (const l of it.choices[0]?.lines ?? []) if (l.bucket !== 'core') tw[cellKey(l.bucket, l.ticker)] = (plan.targets[cellKey(l.bucket, l.ticker)] ?? 0) / total;
      if (Object.keys(tw).length) it.targetW = tw;
    }
  }
  return items;
}

// ---------------------------------------------------------------- 崩盤規則檢視的狀態（core_ai §3.2）

/** 月報輸入裡的檢視狀態；舊月報只有 crashOpinion → 當成 { state: 'OPINION', opinion }。 */
export function monthlyCrashReview(input: Pick<MonthlyContext, 'crashReview' | 'crashOpinion'>): CrashReviewInfo | undefined {
  if (input.crashReview) return input.crashReview;
  return input.crashOpinion ? { state: 'OPINION', opinion: input.crashOpinion } : undefined;
}

/** F5／F6 項目上和檢視有關的欄位：crashReview；aiLine 只在 OPINION 時寫；runIds 只要有執行就帶（舊月報用 runIds.crash）。 */
function crashReviewFields(info: CrashReviewInfo | undefined, legacyRun?: string): Pick<Item, 'crashReview' | 'aiLine' | 'runIds'> {
  if (!info) return {};
  const runId = info.runId ?? legacyRun;
  return { crashReview: clone(info), ...(info.state === 'OPINION' && info.opinion ? { aiLine: `AI 檢視：${info.opinion}` } : {}), ...(runId ? { runIds: [runId] } : {}) };
}

/**
 * 月報之後才回來的檢視結果寫進 F5／F6 項目（core_ai §3.2 的 applyCrashReview 第 3 步；直接改傳進來的通知）：
 * crashReview、aiLine、runIds 換成新的，通知的 runIds 跟著重算。回傳有沒有改。
 */
export function setCrashReview(n: Notif, it: Item, info: CrashReviewInfo): boolean {
  const before = JSON.stringify([it.crashReview, it.aiLine, it.runIds]);
  const f = crashReviewFields(info);
  it.crashReview = f.crashReview;
  if (f.aiLine) it.aiLine = f.aiLine;
  else delete it.aiLine;
  if (f.runIds) it.runIds = f.runIds;
  syncRunIds(n);
  return before !== JSON.stringify([it.crashReview, it.aiLine, it.runIds]);
}

/** F5／F6 項目上的檢視狀態；舊通知沒有 crashReview 時由 aiLine 推回（「AI 檢視：照做／延後」= 三票一致）。 */
export function crashReviewOf(it: Pick<Item, 'crashReview' | 'aiLine'>): CrashReviewInfo | undefined {
  if (it.crashReview) return it.crashReview;
  const m = /^AI 檢視：(照做|延後)$/.exec(it.aiLine ?? '');
  return m ? { state: 'OPINION', opinion: m[1] as '照做' | '延後' } : undefined;
}

// ---------------------------------------------------------------- 崩盤項目「這次不做」之後（core_ai §3.6）

/**
 * 欠的核心的單（coreOwe）重列時的行：用現在的市值重算（啟動：核心的一半減掉已經有的短債；解除：短債全部換回）。
 * 股數是 0 的行拿掉；動到的金額不到總資產的 orderMin（0.25%）就當成沒有要動的（例如之後自己補做了、只剩零頭）。
 */
export function owedCoreLines(ctx: CoreContext, direction: CoreOwe['direction']): OrderLine[] {
  const lines = crashCoreLines(ctx, direction === 'ON').filter((l) => l.shares !== 0);
  const moved = lines.reduce((a, l) => Math.max(a, Math.abs(l.shares * ctx.price(l.ticker))), 0);
  return moved > ctx.cfg.orderMin * ctx.total ? lines : [];
}

/** 欠的那一次是哪一份月報（月份標籤，例如 2027-01）；找不到通知就用訊號日的年月。 */
export function coreOweMonth(acct: Pick<Account, 'notifs'>, owe: CoreOwe): string {
  return acct.notifs.find((n) => n.id === owe.notif)?.monthly?.input.month ?? owe.since.slice(0, 7);
}

/** 解除那個月：上次啟動沒做時 F6 的備註（§3.6 的表）。 */
export const RELIST_OFF_NOTE = '上次啟動你沒有做，這次沒有短債要換回';
export const RELIST_OFF_NOTE_PART = '上次啟動你沒有做；這次只換回後來放進短債的部分';

/** 重列的 F5／F6（relist）：預設照做、不開檢視（§3.1 的 MAKEUP 排除它）、「這次不做」仍要寫理由。沒有要動的行 → null。 */
function relistItem(acct: Account, owe: CoreOwe, ctx: CoreContext): Item | null {
  const lines = owedCoreLines(ctx, owe.direction);
  if (!lines.length) return null;
  const on = owe.direction === 'ON';
  const month = coreOweMonth(acct, owe);
  return makeItem({
    f: on ? 'F5' : 'F6',
    kind: 'STRATEGY',
    ticker: acct.cfg.coreTicker,
    title: on ? `崩盤規則啟動中：上次（${month}）沒做，核心的一半換短債再列一次` : `崩盤規則已解除：上次（${month}）沒做，短債換回核心 ETF 再列一次`,
    choices: [{ id: 'DO', label: '照做', lines }],
    why: owe.reason === CORE_OWE_UNANSWERED_REASON ? `${month} 月報一直沒有回覆，以這份為準` : `上次的理由：${owe.reason || '（沒有寫）'}`,
    relist: true,
    reasonRequired: true,
  });
}

/**
 * 月報產生時讀 coreOwe（§3.6 的表），讀完清掉（使用者再選「這次不做」會再寫一次）：
 *   ON、仍在啟動中 → 加一項重列的 F5；ON、這個月解除 → 不加，F6 加備註；
 *   OFF、仍是未啟動 → 加一項重列的 F6；OFF、這個月啟動 → 不加（F5 照常，會扣掉已經有的短債）。
 * 回傳有沒有重列。
 */
function applyCoreOwe(acct: Account, items: Item[], crashChanged: boolean, ctx: CoreContext): boolean {
  const owe = acct.coreOwe;
  if (!owe) return false;
  delete acct.coreOwe;
  const on = owe.direction === 'ON';
  if (!crashChanged) {
    if (acct.rule.crash !== on) return false;
    const it = relistItem(acct, owe, ctx);
    if (!it) return false;
    items.unshift(it);
    return true;
  }
  const f6 = on && !acct.rule.crash ? items.find((i) => i.f === 'F6' && !i.relist) : undefined;
  if (f6) {
    const note = f6.choices[0].lines.some((l) => l.bucket === 'core') ? RELIST_OFF_NOTE_PART : RELIST_OFF_NOTE;
    f6.note = f6.note ? `${f6.note}；${note}` : note;
  }
  return false;
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

/**
 * 月報的超額波動（momentum_ai §3.11）：input 已經有 excessVol（重算）→ 用它（null = 算不出來）；
 * 沒有（第一次產生、或沒有這個欄位的舊月報）→ 用現在的 view 算，record 把算到的值寫進要存的 input。
 */
function volSource(view: MarketView, input: MonthlyContext, core: string): { fn: (names: string[]) => number; record: (inp: MonthlyContext) => MonthlyContext } {
  if (input.excessVol !== undefined) {
    const v = input.excessVol ?? NaN;
    return { fn: () => v, record: (inp) => clone(inp) };
  }
  const live = excessVolOf(view, view.benchmark ?? core);
  let got: number | undefined;
  return {
    fn: (names) => (got = live(names)),
    record: (inp) => (got === undefined ? clone(inp) : { ...clone(inp), excessVol: Number.isFinite(got) ? got : null }),
  };
}

/** 月報暫停時：照訊號日的名單先算好超額波動，存進暫停那一則的輸入（之後的重算用它）。 */
function withSignalVol(acct: Account, view: MarketView, input: MonthlyContext): MonthlyContext {
  if (input.excessVol !== undefined || !acct.cfg.volScale) return clone(input);
  const vol = volSource(view, input, acct.cfg.coreTicker);
  const blocked = [...(input.vetoed ?? []), ...Object.keys(acct.mom.excluded), ...Object.keys(acct.mom.adopted)];
  planDay({
    cfg: acct.cfg,
    values: cellValues(acct, view),
    state: acct.rule,
    monthly: { order: input.order, excessVol: vol.fn, coreBelow200: acct.rule.crash, blocked, owed: Object.keys(acct.mom.owe), emptySlots: input.emptySlots, companyOf: companyOfInput(input) },
  });
  return vol.record(input);
}

/**
 * 崩盤規則用訊號日的判斷（core_ai §3.7）：input 已經有 crash（重算）→ 照用；沒有（第一次產生、舊月報）→ 用現在的 view 算好寫進去。
 * 均線算不出來時維持原狀態（§3.10 的 crashDecision）。
 */
function withSignalCrash(acct: Account, view: MarketView, input: MonthlyContext): MonthlyContext {
  if (input.crash) return input;
  const c = view.close[acct.cfg.coreTicker];
  const d = crashDecision(c, view.i, acct.rule.crash);
  const close = c && Number.isFinite(c[view.i]) ? c[view.i] : null;
  return { ...input, crash: { below: d.below, date: view.date, close, ma: d.ok ? d.ma : null, ...(d.ok ? {} : { bars: validBars(c, view.i) }) } };
}

// ---------------------------------------------------------------- 每日檢查（收盤後）

export interface DailyResult {
  acct: Account;
  /** 今天新產生的通知。 */
  created: Notif[];
  /** 只記錄、不通知的事（訊號累積到月報、互相抵銷）。 */
  log: { ticker: string; what: string }[];
}

/**
 * 每天收盤後：自選慢規則前進一步（R1 在 2026-11-15 拿掉，own_thesis §3.9）；單筆變動 ≥ 總資產 5% → 當天通知（隔天開盤執行），
 * 其餘累積到月報；發出 2 個交易日沒回報的通知提醒一次。
 */
export function dailyCheck(acct0: Account, view: MarketView): DailyResult {
  const acct = clone(acct0);
  const created: Notif[] = [];
  const log: DailyResult['log'] = [];
  for (const [tk, meta] of Object.entries(acct.own)) {
    const c = view.close[tk];
    if (!c) continue;
    const step = stepSlowRule(meta.slow, slowDayInput(c, view.i));
    meta.slow = step.next;
    if (step.signal) {
      // 慢規則切換（或和尚未下單的那次互相抵銷）：上一次減半的論點檢查不再對應（own_thesis §3.3）
      delete meta.dropReview;
      if (step.signal === 'REDUCE') {
        const dd = drawdownFromHigh(c, view.i, SLOW.highDays);
        meta.reduceDd = Number.isFinite(dd) ? dd : null;
      }
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
      created.push(newNotif(acct, view, { kind: 'INFO', title: `提醒：「${n.title}」（${mdOf(n.date)}）還沒回報`, text: '照做了嗎？還沒回覆的話，打開原來那則通知選一項；選「整則這次不做」就不再提醒。', ref: n.id, coreAbsorb: false }));
    }
    // 決定了、2 個交易日還沒填快照（設計 §10 第 40 點）
    if (n.status === 'RESPONDED' && n.composed && !n.fillReminded && n.kind !== 'INFO' && view.i - (n.respondedSeq ?? n.seq) >= 2) {
      n.fillReminded = true;
      created.push(newNotif(acct, view, { kind: 'INFO', title: `提醒：「${n.title}」（${mdOf(n.date)}）決定了還沒填快照`, text: '下單了就去填快照（股數、現金照券商填）；沒下單就回上一步改「這次不做」。月報日還沒填，月報會先暫停。', ref: n.id, coreAbsorb: false }));
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

/**
 * 月報要先等的事：有未分類的持股變動（設計 §2.1.1），或有清單決定了還沒填快照（帳本還不是下單後的樣子，月報會重複下單；設計 §10 第 40 點）。
 */
export function monthlyWait(acct: Account): { kind: 'UNC' } | { kind: 'FILL'; notif: Notif } | null {
  if (Object.values(acct.lots.unc).some((x) => x)) return { kind: 'UNC' };
  const open = acct.notifs.find((n) => n.status === 'RESPONDED' && !!n.composed && n.kind !== 'INFO');
  return open ? { kind: 'FILL', notif: open } : null;
}

/** 月報前的狀態（暫停後、入金合併、排除重算時還原；restoreSaved）。 */
function savedState(acct: Account): SavedState {
  return { rule: clone(acct.rule), own: clone(acct.own), owe: clone(acct.mom.owe), ...(acct.coreOwe ? { coreOwe: clone(acct.coreOwe) } : {}), cash: acct.cash };
}

/** 還原月報前的狀態（規則、自選、策略單與核心的欠單）；舊的 SavedState 沒有 coreOwe = 那時沒有欠的。 */
export function restoreSaved(acct: Account, before: SavedState): void {
  acct.rule = clone(before.rule);
  acct.own = clone(before.own);
  acct.mom.owe = clone(before.owe);
  if (before.coreOwe) acct.coreOwe = clone(before.coreOwe);
  else delete acct.coreOwe;
}

export function monthlyReport(acct0: Account, view: MarketView, input0: MonthlyContext, flow?: FlowInput, flowCashAlreadyIn = false): MonthlyResult {
  const acct = clone(acct0);
  const input = withSignalCrash(acct, view, input0);
  const wait = monthlyWait(acct);
  if (wait) {
    // 先等：未分類的變動、或決定了還沒填快照的清單 → 月報暫停，等完用今天的輸入重算
    acct.monthlyBlocked = true;
    const notif =
      wait.kind === 'UNC'
        ? newNotif(acct, view, { kind: 'INFO', title: '月報暫停：有未分類的持股變動', text: '請先回答那筆變動是手動交易、新增自選還是轉入自選，屬於哪一桶。分類後會重算月報。', coreAbsorb: false })
        : newNotif(acct, view, { kind: 'INFO', title: `月報暫停：「${wait.notif.title}」決定了還沒填快照`, text: `「${wait.notif.title}」（${wait.notif.date}）決定了還沒填快照，帳本還是下單前的樣子，這時出月報會叫你重複下單。下單了就去填快照；沒下單就回上一步改「這次不做」。之後會用今天的排名重算月報。`, ref: wait.notif.id, coreAbsorb: false });
    // 留下這份月報的輸入（訊號日的排名與超額波動），分類後用它重算（resumeMonthly）
    notif.monthly = { input: withSignalVol(acct, view, input), before: savedState(acct) };
    return { acct, notif, plan: null };
  }
  acct.monthlyBlocked = false;
  owePendingMonthly(acct);
  const before = savedState(acct);
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
      ownNotes[tk] = `（${m.pending.date} 觸發；這一筆不到總資產的 5%，所以併入月報）`;
    }
  }
  const core = acct.cfg.coreTicker;
  const blocked = [...(input.vetoed ?? []), ...Object.keys(acct.mom.excluded), ...Object.keys(acct.mom.adopted)];
  // 依波動度減碼用訊號日的值（momentum_ai §3.11）：重算時用 input.excessVol；第一次產生時當場算、記下來
  const vol = volSource(view, input, core);
  const plan = planDay({
    cfg: acct.cfg,
    values,
    state: acct.rule,
    ownActions,
    flow,
    monthly: {
      order: input.order,
      excessVol: vol.fn,
      coreBelow200: input.crash!.below,
      blocked,
      owed: Object.keys(acct.mom.owe),
      emptySlots: input.emptySlots,
      companyOf: companyOfInput(input),
    },
  });
  acct.rule = plan.state;
  for (const tk of Object.keys(ownActions)) acct.own[tk].pending = null;
  acct.mom.owe = {};
  let items = itemsFromPlan(acct, view, plan, values, { coreBefore, ownNotes, crashReview: monthlyCrashReview(input), runIds: input.runIds });
  // 崩盤項目上次選了「這次不做」（core_ai §3.6）：規則還在同一個狀態就再列一次核心的單
  const relisted = applyCoreOwe(acct, items, plan.crashChanged, coreBefore);
  // 核心 ETF 的價格和基準對不上（core_ai §3.10）：切換的那一項寫明要核對；月報照規則出、不改判斷
  if (plan.crashChanged && input.coreNote && input.coreCheck?.some((c) => c === 'DAY_GAP' || c === 'MA_GAP')) {
    const sw = items.find((i) => (i.f === 'F5' || i.f === 'F6') && !i.relist);
    if (sw) sw.note = sw.note ? `${sw.note}；${input.coreNote}` : input.coreNote;
  }
  // 任務 A：進場那一項的說明（准許，附註、法庭的結論、沿用、還在審…；momentum_ai §3.3）。舊月報只有觀察理由
  for (const it of items) {
    if (it.f !== 'F1' || !it.ticker) continue;
    const note = input.entryNotes ? input.entryNotes[it.ticker] : input.watch?.[it.ticker] ? `准許，附註：${input.watch[it.ticker]}` : undefined;
    if (note) it.note = note;
  }
  if (flow) {
    // 入金合併在月報裡：入金補的格子併成一項
    const sys = items.filter((i) => i.f === 'SYS');
    const flowLines = sys.flatMap((i) => i.choices[0].lines);
    const flowW = Object.assign({}, ...sys.map((i) => i.targetW ?? {})) as Record<string, number>;
    items = items.filter((i) => i.f !== 'SYS');
    items.push(makeItem({ f: 'F11', kind: 'CASHFLOW', title: `入金 ${usd(flow.amount)}：只買不賣（和月報合成一份）`, choices: [{ id: 'DO', label: '照做', lines: flowLines }], noSkip: true, ...(Object.keys(flowW).length ? { targetW: flowW } : {}) }));
  }
  // 月審確認成立的你定的條件（甲類，own_thesis §1.10）：進月報，項目和當天通知相同
  for (const [tk, m] of Object.entries(acct.own)) {
    for (const c of m.condMonthly ?? []) {
      const it = condMetItem(acct, view, tk, c);
      if (it) items.push(it);
      m.metConds = [...(m.metConds ?? []), c.text];
    }
    delete m.condMonthly;
  }
  // F24／F23：AI 的月報建議（規則沒有動作的自選股）
  for (const [tk, m] of Object.entries(acct.own)) {
    // 這檔有慢規則項目：AI 的看法已經列在那一項上（§3.4），不另列一項；往下的建議算給過了
    const ruleIt = items.find((i) => i.ticker === tk && i.kind === 'OWN_RULE');
    if (ruleIt) {
      if (m.aiTier?.suggest && ruleIt.choices.some((c) => c.id === 'AI')) m.aiTier.suggest = false;
      continue;
    }
    if (!m.aiTier?.suggest) continue;
    const tier = m.aiTier.tier;
    const state = acct.rule.own[tk].applied;
    if (tier === 'HOLD' || (tier === 'HALF' && state === 'HALF') || (tier === 'STANDARD' && state === 'STD')) continue;
    const sh = tierShares(acct, view, tk, tier, state);
    m.aiTier.suggest = false;
    if (!sh) continue;
    // 乙類（own_thesis §1.10）：月報裡是同一種項目（預設不動）；那條前提在靜默期內就不列
    if ((tier === 'EXIT' || tier === 'HALF') && m.aiTier.premiseId) {
      if (silenced(acct, tk, m.aiTier.premiseId, view.date, tier)) continue;
      const it = breakItem(acct, view, tk, { tier, premiseId: m.aiTier.premiseId, basis: m.aiTier.basis ?? null, basisNote: m.aiTier.basisNote ?? null, runIds: m.aiTier.runId ? [m.aiTier.runId] : [] }, false);
      if (it) items.push(it);
      continue;
    }
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
        ...(m.aiTier.runId ? { runIds: [m.aiTier.runId] } : {}),
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
  // 上一份月報一直沒回覆（T38 走一遍的缺口）：這份月報用同樣的帳本又把動能、上限的單列了一次，舊的那幾項還在「等你決定」，
  // 兩份都照做就重複下單。策略類「下一份月報把差額再列一次」（§2.3.1）→ 舊月報的策略項目以這份為準、取消；
  // 併在舊月報裡的入金（F11）也一樣：入金的錢已經在帳上，這份月報會用它。
  // 自選的項目（慢規則、AI 建議、條件成立）是一次性的、這份不會再列，照舊留著。
  // 崩盤切換的項目也取消（T39b）；策略項目與切換在產生這份之前已經照「這次不做」記成欠單（owePendingMonthly），這份照實際持股重列。
  for (const old of acct.notifs) {
    if (old.status !== 'PENDING' || old.kind !== 'MONTHLY') continue;
    for (const it of old.items) {
      if (it.cancelled || (it.kind !== 'STRATEGY' && it.f !== 'F11')) continue;
      it.cancelled = true;
      it.note = `上一份月報沒有回覆，這一項以 ${input.month} 月報為準`;
    }
    if (old.items.every((i) => i.cancelled)) {
      old.status = 'SUPERSEDED';
      old.coreAbsorb = false;
    }
  }
  const status = `崩盤規則：${acct.rule.crash ? '啟動中' : '未啟動'}${relisted ? '（上次沒做，這份再列）' : ''}；動能比例 ${thirdLabel(acct.rule.volW ?? 1)}` + (input.paused ? `；本月暫停換股（${input.paused}），動能名單不變` : '');
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
    monthly: { input: vol.record(input), before },
    deposit: flow?.kind === '入金' ? flow.amount : undefined,
    // 「要看的事」：「本月不用動」的月報也列（own_thesis §3.6.6）
    ...(input.attention?.length ? { attention: clone(input.attention) } : {}),
  });
  // 不屬於任何項目的 AI 執行：被否決的代號（F1）。F20 的說明 T32d 拿掉（momentum_ai §3.6），不再接在狀態文字後面
  syncRunIds(notif, (input.vetoed ?? []).map((t) => input.runIds?.entry?.[t]));
  notif.preview = composeNotif(acct, view, notif);
  return { acct, notif, plan };
}

/**
 * 上一份月報一直沒回覆（T39b 第 4 項）：新的月報只從實際持股算動能每一格與核心吸收的差額，但只在「這個月有理由」時才把一格拉回目標——
 * 新進場、比例格子變了、欠單；其他只靠 ±50% 的回調（而且要搭便車，當天沒有別的單就撤回）。舊月報的進場（F1）、依波動度減碼（F4）、
 * 崩盤切換（F5／F6，含重列的）在下個月都不是「這個月的理由」，所以新月報不會自己涵蓋（探測測試：T39b ④ 延伸）。
 * 做法和那一項選「這次不做」相同（§2.3.1、core_ai §3.6）：策略項目動能那幾檔記進 mom.owe；崩盤切換核心的單記成 coreOwe（理由 CORE_OWE_UNANSWERED_REASON）。
 * 接下來的規則照實際持股重列（策略單補做 F17、重列的 F5／F6）；舊的那幾項在 monthlyReport 後面以新月報為準取消。
 * 在 savedState 之前做：入金併進月報、排除重算時還原的狀態裡有這些欠單，重算時照樣重列。
 */
function owePendingMonthly(acct: Account): void {
  for (const old of acct.notifs) {
    if (old.status !== 'PENDING' || old.kind !== 'MONTHLY') continue;
    for (const it of old.items) {
      if (it.cancelled || it.kind !== 'STRATEGY') continue;
      const lines = it.choices.find((c) => c.id === it.ruleChoice)?.lines ?? [];
      for (const l of lines) if (l.bucket === 'mom' && l.shares) acct.mom.owe[l.ticker] = { since: old.date, notif: old.id };
      if ((it.f === 'F5' || it.f === 'F6') && lines.some((l) => l.bucket === 'core' && l.shares)) acct.coreOwe = { direction: it.f === 'F5' ? 'ON' : 'OFF', since: old.date, notif: old.id, reason: CORE_OWE_UNANSWERED_REASON };
    }
  }
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

/**
 * AI 層回報：這檔自選的最新 F24 檔位。suggest = 3 票一致、和目前不同、有一條不成立的前提（還沒給使用者的）；
 * extra.premiseId = 那條前提（own_thesis §1.6）、trigger = 觸發原因、basis = 判不成立的依據（乙類的理由用；basisNote 是後面括號裡的字）、
 * agreed = 三票同一個檔位而且資料沒有缺漏（慢規則通知上的「照 AI」只認這種，§3.4）。
 */
export function recordAiTier(acct0: Account, ticker: string, tier: Tier, date: string, suggest: boolean, runId?: string, extra?: { premiseId?: string | null; trigger?: ReviewTrigger; basis?: string | null; basisNote?: string | null; agreed?: boolean }): Account {
  const acct = clone(acct0);
  if (acct.own[ticker]) acct.own[ticker].aiTier = { tier, date, suggest, runId, ...(extra?.premiseId ? { premiseId: extra.premiseId } : {}), ...(extra?.trigger ? { trigger: extra.trigger } : {}), ...(extra?.basis ? { basis: extra.basis } : {}), ...(extra?.basis && extra.basisNote ? { basisNote: extra.basisNote } : {}), ...(extra?.agreed ? { agreed: true } : {}) };
  return acct;
}

// ---------------------------------------------------------------- 失效通知（own_thesis §1.9、§1.10）

/** AI 發起的當天通知（乙類），每檔幾個日曆天最多 1 則（§1.9）。 */
export const AI_NOTICE_GAP = 30;
/** 有資格的審查建議，觸發原因是這幾種時當天通知（§1.9 的表；月審與其他進月報）。 */
export const SAME_DAY_TRIGGERS: readonly ReviewTrigger[] = ['EARNINGS', 'EARLY', 'CONDITION', 'THESIS', 'DROP'];
const calDays = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400_000);
const mdOf = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
const defaultOnly = (meta: Pick<OwnMeta, 'premises'>) => meta.premises.every((p) => p.origin === 'SYSTEM_DEFAULT');

/** 靜默期最長幾個日曆天；滿幾天之後的第一份財報類申報結束靜默期（§1.10「靜默期」）。 */
export const DISPUTE_MAX_DAYS = 100;
export const DISPUTE_MIN_DAYS = 45;
/** 月報裡的乙類項目沒動它（沒按照 AI、沒寫理由）→ 記成 SKIPPED，和不同意一樣進靜默期（§1.10）。 */
export const SKIPPED_REASON = '月報裡沒有動它（AI 的建議是一次性的）';
/** 修正論點、但新的論點原封不動留著被判不成立的那條前提（同一個 id、字沒改）→ 當成不同意（§1.10；字改了的不算，T46）。 */
export const KEPT_REASON = '修正論點但保留這條前提';
const plusDays = (d: string, n: number) => new Date(Date.parse(d) + n * 86400_000).toISOString().slice(0, 10);

/**
 * 這條前提進靜默期（§1.10）：since = 這一天，until = 加 100 天。同一條前提還在靜默中的那一筆換成這一筆（過期的留著給網站顯示）。
 */
export function addDispute(meta: OwnMeta, premiseId: string, date: string, reason: string, notif: number | null): void {
  const keep = (meta.disputes ?? []).filter((d) => d.premiseId !== premiseId || d.until < date);
  meta.disputes = [...keep, { premiseId, since: date, until: plusDays(date, DISPUTE_MAX_DAYS), reason, notif }];
}

/** 前提沿用編號、但字改了時靜默期結束的原因（T42，§1.10）。 */
export const EDITED_REASON = '前提的字改了';

/**
 * 這幾條前提的靜默期提早結束（T42，own_thesis §1.10）：還在期間內（until ≥ date）的那一筆，until 改成前一天、記結束日與原因。
 * 沿用編號但字改了的前提：舊的「不同意」針對的是舊的字，不能蓋住意思已經變了的新前提。回傳結束了哪幾條。
 */
export function endDisputesFor(meta: OwnMeta, premiseIds: string[], date: string, reason: string): string[] {
  if (!premiseIds.length || !meta.disputes?.length) return [];
  const ended: string[] = [];
  meta.disputes = meta.disputes.map((d) => {
    if (!premiseIds.includes(d.premiseId) || d.until < date) return d;
    ended.push(d.premiseId);
    return { ...d, until: plusDays(date, -1), ended: { date, reason } };
  });
  return ended;
}

/** 財報類申報（§1.10「靜默期」）：10-Q、10-K、8-K Item 2.02。修正版（/A）是舊的期間，不算。 */
export const endsSilence = (f: { form: string; items?: string[] }): boolean => f.form === '10-Q' || f.form === '10-K' || (f.form === '8-K' && (f.items ?? []).includes('2.02'));

/**
 * 每日流程看到這檔有新的財報類申報（§1.10「靜默期」的實作）：還在靜默中、距 since 已滿 45 天的 → until 改成那份申報的前一天。
 * 也就是到下一季的數字出來為止。沒有變動時回傳原本的帳戶。
 */
export function endDisputes(acct0: Account, ticker: string, filings: { form: string; items?: string[]; filingDate: string }[]): { acct: Account; ended: { premiseId: string; until: string }[] } {
  const ds = acct0.own[ticker]?.disputes ?? [];
  const fin = filings.filter(endsSilence).map((f) => f.filingDate).sort();
  const ended: { premiseId: string; until: string }[] = [];
  const next = ds.map((d) => {
    // 已經提早結束的（T42：前提的字改了）不再動
    if (d.ended) return d;
    const first = fin.find((day) => day <= d.until && calDays(d.since, day) >= DISPUTE_MIN_DAYS);
    if (!first) return d;
    const until = plusDays(first, -1);
    ended.push({ premiseId: d.premiseId, until });
    return { ...d, until };
  });
  if (!ended.length) return { acct: acct0, ended };
  const acct = clone(acct0);
  acct.own[ticker].disputes = next;
  return { acct, ended };
}

/**
 * 這條前提在靜默期內嗎（§1.10「靜默期」）：disputes 裡同一條前提、until ≥ 這一天。
 * 例外：AI 的檔位比不同意時更重（減半 → 出清）照常給。不同意時的檔位取那則通知上「照 AI」的檔位；找不到就當成一樣重（照樣靜默）。
 */
export function silenced(acct: Pick<Account, 'own' | 'notifs'>, ticker: string, premiseId: string, date: string, tier: Tier): boolean {
  for (const d of acct.own[ticker]?.disputes ?? []) {
    if (d.premiseId !== premiseId || d.until < date) continue;
    const n = d.notif !== null ? acct.notifs.find((x) => x.id === d.notif) : undefined;
    const then = n?.items.flatMap((i) => (i.ticker === ticker ? i.choices : [])).find((c) => c.id === 'AI')?.tier;
    if (tier === 'EXIT' && then === 'HALF') continue;
    return true;
  }
  return false;
}

/**
 * 甲類的項目（§1.10）：`MU：你在 2026-11-20 定的條件「…」成立`；預設「照當時的決定」（ruleChoice 也是 DO：影子紀錄的「照規則」記當時的決定，沒有 AI 那條線），
 * 「這次不做」要寫理由。換算出來不用賣（例如動作是減半、但已經在減半）→ null。
 */
export function condMetItem(acct: Account, view: MarketView, ticker: string, c: CondNotice): Item | null {
  const state = acct.rule.own[ticker]?.applied;
  if (!acct.own[ticker] || !state) return null;
  const sh = tierShares(acct, view, ticker, c.action, state);
  if (sh >= 0) return null;
  return makeItem({
    f: 'F25',
    kind: 'OWN_COND',
    ticker,
    title: `${ticker}：你在 ${c.setAt} 定的條件「${c.text}」成立`,
    why: c.why,
    choices: [
      { id: 'DO', label: `照當時的決定：${TIER_NAME[c.action]}，${sharesText(sh)}`, tier: c.action, lines: [{ ticker, bucket: 'own', shares: sh, reason: '你定的條件' }], effects: [{ type: 'APPLY_TIER', ticker, tier: c.action }] },
      { id: 'SKIP', label: '這次不做', lines: [] },
    ],
    choice: 'DO',
    ruleChoice: 'DO',
    reasonRequired: true,
    brk: { type: 'A', conditionId: c.id, premiseId: c.premiseId ?? null },
    ...(c.runIds?.length ? { runIds: [...c.runIds] } : {}),
  });
}

/**
 * 甲類的當天通知（§1.10）：不設上限（每條條件只成立一次）。不用賣 → 不發（notif = null），條件照樣算成立（列進「要看的事」由論點檔判斷）。
 * 不論發不發，這檔的 metConds 記下這條（慢規則加回時註明）。
 */
export function condMetNotice(acct0: Account, view: MarketView, ticker: string, c: CondNotice): { acct: Account; notif: Notif | null; why: string } {
  const acct = clone(acct0);
  const meta = acct.own[ticker];
  if (!meta) return { acct, notif: null, why: '不是自選股' };
  meta.metConds = [...(meta.metConds ?? []), c.text];
  const it = condMetItem(acct, view, ticker, c);
  if (!it) return { acct, notif: null, why: `換算出來不用賣（目前${acct.rule.own[ticker]?.applied === 'HALF' ? '已經是減半' : '沒有要賣的股數'}）` };
  const notif = newNotif(acct, view, { kind: 'URGENT', title: `${ticker}：你定的出場條件成立`, text: `你在 ${mdOf(c.setAt)} 定的「${c.text}」→ ${TIER_NAME[c.action]}`, items: [it] });
  notif.preview = composeNotif(acct, view, notif);
  return { acct, notif, why: '當天通知' };
}

/**
 * 乙類的內容：哪條前提、建議什麼、依據（例如「8-K 2027-01-06」）。
 * basisNote：依據後面括號裡的字（web_evidence_design §1.6）：依據是網頁時「網頁；引用與連結在網站」；沒給 = 「引用在網站」。
 */
export interface BreakSpec {
  tier: 'EXIT' | 'HALF';
  premiseId: string;
  basis?: string | null;
  basisNote?: string | null;
  runIds?: string[];
}

/**
 * 乙類的項目（§1.10）：`MU：前提「…」3 票都判不成立`；預設不動（choice、ruleChoice 都是 SKIP）。
 * sameDay：當天通知的「不同意，不動」要寫理由；月報裡的不用（沒動它記成 SKIPPED，T30）。換算出來不用賣 → null。
 */
export function breakItem(acct: Account, view: MarketView, ticker: string, s: BreakSpec, sameDay: boolean): Item | null {
  const meta = acct.own[ticker];
  const state = acct.rule.own[ticker]?.applied;
  if (!meta || !state) return null;
  const sh = tierShares(acct, view, ticker, s.tier, state);
  if (sh >= 0) return null;
  const p = meta.premises.find((x) => x.id === s.premiseId);
  const act = `${TIER_NAME[s.tier]}，${sharesText(sh)}`;
  return makeItem({
    f: 'F24',
    kind: 'AI_ONLY',
    ticker,
    title: `${ticker}：前提「${p?.text ?? s.premiseId}」3 票都判不成立`,
    aiLine: `AI 建議${act}`,
    why: `依據：${s.basis ?? '審查引用的申報'}（${(s.basis && s.basisNote) || '引用在網站'}）。你沒有為這件事定過出場條件，由你決定。${defaultOnly(meta) ? '這檔還沒有你的論點，檢查的是系統預設前提。' : ''}`,
    choices: [
      { id: 'AI', label: `照 AI（${act}）`, tier: s.tier, lines: [{ ticker, bucket: 'own', shares: sh, reason: 'AI 建議' }], effects: [{ type: 'APPLY_TIER', ticker, tier: s.tier }] },
      { id: 'SKIP', label: '不同意，不動', lines: [] },
    ],
    choice: 'SKIP',
    ruleChoice: 'SKIP',
    ...(sameDay ? { reasonRequired: true } : {}),
    brk: { type: 'B', premiseId: s.premiseId },
    ...(s.runIds?.length ? { runIds: [...s.runIds] } : {}),
  });
}

/** 乙類的當天通知（§1.10）。換算出來不用賣 → notif = null。 */
export function breakNotice(acct0: Account, view: MarketView, ticker: string, s: BreakSpec): { acct: Account; notif: Notif | null } {
  const acct = clone(acct0);
  const it = breakItem(acct, view, ticker, s, true);
  if (!it) return { acct, notif: null };
  const meta = acct.own[ticker];
  const p = meta.premises.find((x) => x.id === s.premiseId);
  const notif = newNotif(acct, view, {
    kind: 'URGENT',
    title: `${ticker}：AI 審查認為${defaultOnly(meta) ? '預設前提' : '你的前提'}不成立`,
    text: `前提「${p?.text ?? s.premiseId}」：3 票判不成立\n${it.aiLine}（要不要做由你決定）`,
    items: [it],
  });
  notif.preview = composeNotif(acct, view, notif);
  return { acct, notif };
}

/** 還沒回覆的乙類項目（當天通知或月報裡的）。 */
function pendingBreak(acct: Account, ticker: string): { n: Notif; it: Item } | null {
  for (const n of acct.notifs) {
    if (n.status !== 'PENDING') continue;
    const it = n.items.find((i) => i.ticker === ticker && !i.cancelled && i.kind === 'AI_ONLY' && i.f === 'F24' && i.brk?.type === 'B');
    if (it) return { n, it };
  }
  return null;
}

/** 一次定期審查的結論（app 層由 reviewDecision 算好）。 */
export interface ReviewResult {
  tier: Tier;
  /** 有資格（3 票一致、和目前不同、資料沒有缺漏、有一條不成立的前提）。 */
  suggest: boolean;
  /** 三票一致（含一致選「不動」）。 */
  consensus: boolean;
  premiseId: string | null;
  trigger: ReviewTrigger;
  date: string;
  runId?: string;
  basis?: string | null;
  basisNote?: string | null;
}

/** KEPT 月中的建議留著；NONE 只放網站；SILENT 靜默期內；MONTHLY 記著進月報；RULE_NOTICE 更新還沒回覆的慢規則通知；BREAK_UPDATE 更新還沒回覆的乙類；SAME_DAY 當天通知。 */
export type ReviewRoute = 'KEPT' | 'NONE' | 'SILENT' | 'MONTHLY' | 'RULE_NOTICE' | 'BREAK_UPDATE' | 'SAME_DAY';

/**
 * 審查的建議什麼時候給使用者（own_thesis §1.9）。先看資格，再照表：
 *   沒有三票一致的結論、而且月中有記著等月報的建議 → 留著（修 N6）
 *   資格不夠、或那條前提在靜默期內 → 只放網站
 *   回到標準、提高到 125% → 只進月報
 *   有還沒回覆的慢規則通知 → 不另發，更新那則的「照 AI」（refreshOwnAiChoice）
 *   有還沒回覆的乙類 → 不另發；檔位變了就更新那一則
 *   觸發原因是財報後、提前審查、你定的「重新審查」條件、論點變動後、減半檢視 → 30 天內沒發過 AI 的當天通知就當天發乙類（aiNotifiedAt 記今天），否則進月報
 *   月審（與其他）→ 進月報
 * 當天給過（當天通知、更新了還沒回覆的通知）的不再進月報（aiTier.suggest = false）。
 */
export function routeReview(acct0: Account, view: MarketView, ticker: string, r: ReviewResult): { acct: Account; route: ReviewRoute; notif: Notif | null; changed: number[]; why: string } {
  const meta0 = acct0.own[ticker];
  if (!meta0) return { acct: acct0, route: 'NONE', notif: null, changed: [], why: '不是自選股' };
  if (!r.consensus && meta0.aiTier?.suggest) return { acct: acct0, route: 'KEPT', notif: null, changed: [], why: `這次沒有三票一致的結論，${meta0.aiTier.date} 的建議留著進月報` };
  const down = r.tier === 'EXIT' || r.tier === 'HALF';
  const silent = r.suggest && down && !!r.premiseId && silenced(acct0, ticker, r.premiseId, r.date, r.tier);
  let acct = recordAiTier(acct0, ticker, r.tier, r.date, r.suggest && !silent, r.runId, { premiseId: r.premiseId, trigger: r.trigger, basis: r.basis, basisNote: r.basisNote, agreed: r.consensus });
  const done = (route: ReviewRoute, why: string, notif: Notif | null = null, changed: number[] = []) => {
    if (route !== 'MONTHLY' && acct.own[ticker]?.aiTier) acct.own[ticker].aiTier!.suggest = false;
    return { acct, route, notif, changed: [...new Set([...ruleChanged, ...changed])], why };
  };
  // 這檔有還沒回覆的慢規則通知：那則通知上 AI 的那一行照 §3.4 重算（哪些結論會變成那一行或選項由 refreshOwnAiChoice 判斷）。
  // 三票一致、往下的檔位、有不成立的前提 → 不另發（§1.9 的表）；靜默期不擋那一行，審查的檔位和規則已經做的相同（減半）也照寫
  const ruleN0 = acct.notifs.find((n) => n.status === 'PENDING' && n.items.some((i) => i.kind === 'OWN_RULE' && i.ticker === ticker && !i.cancelled));
  let ruleChanged: number[] = [];
  if (ruleN0) {
    const rr = refreshOwnAiChoice(acct, view, ticker);
    acct = rr.acct;
    ruleChanged = rr.changed;
    if (down && r.consensus && r.premiseId) return done('RULE_NOTICE', `有還沒回覆的慢規則通知 #${ruleN0.id}，不另發，更新那則的 AI 那一行`, null, ruleChanged);
  }
  if (silent) return done('SILENT', `前提 ${r.premiseId} 在靜默期內（你之前表示不同意），只放網站`);
  if (!r.suggest) return done('NONE', '沒有資格（只放網站）');
  if (!down || !r.premiseId) return done('MONTHLY', '回到標準、提高到 125% 只進月報');
  const ruleN = acct.notifs.find((n) => n.status === 'PENDING' && n.items.some((i) => i.kind === 'OWN_RULE' && i.ticker === ticker && !i.cancelled));
  if (ruleN) {
    const rr = refreshOwnAiChoice(acct, view, ticker);
    acct = rr.acct;
    return done('RULE_NOTICE', `有還沒回覆的慢規則通知 #${ruleN.id}，不另發，更新那則的 AI 選項`, null, rr.changed);
  }
  const pb = pendingBreak(acct, ticker);
  if (pb) {
    const cur = pb.it.choices.find((c) => c.id === 'AI')?.tier;
    if (cur === r.tier) return done('BREAK_UPDATE', `有還沒回覆的乙類通知 #${pb.n.id}，檔位相同，不另發`);
    const fresh = breakItem(acct, view, ticker, { tier: r.tier as 'EXIT' | 'HALF', premiseId: r.premiseId, basis: r.basis, basisNote: r.basisNote, runIds: [...new Set([...(pb.it.runIds ?? []), ...(r.runId ? [r.runId] : [])])] }, !!pb.it.reasonRequired);
    if (fresh) {
      const keep = { key: pb.it.key, choice: pb.it.choice === 'AI' ? 'AI' : 'SKIP' } as const;
      for (const k of Object.keys(pb.it)) delete (pb.it as unknown as Record<string, unknown>)[k];
      Object.assign(pb.it, fresh, keep);
      syncRunIds(pb.n);
      pb.n.preview = composeNotif(acct, view, pb.n);
    }
    return done('BREAK_UPDATE', `有還沒回覆的乙類通知 #${pb.n.id}，不另發，檔位改成${TIER_NAME[r.tier]}`, null, [pb.n.id]);
  }
  if (!SAME_DAY_TRIGGERS.includes(r.trigger)) return done('MONTHLY', '月審的建議進隔天的月報');
  const last = acct.own[ticker].aiNotifiedAt;
  if (last && calDays(last, r.date) < AI_NOTICE_GAP) return done('MONTHLY', `${last} 已經發過 AI 的當天通知（${AI_NOTICE_GAP} 天內），進下一份月報`);
  const b = breakNotice(acct, view, ticker, { tier: r.tier as 'EXIT' | 'HALF', premiseId: r.premiseId, basis: r.basis, basisNote: r.basisNote, runIds: r.runId ? [r.runId] : [] });
  if (!b.notif) return done('NONE', '換算出來不用賣，只放網站');
  acct = b.acct;
  acct.own[ticker].aiNotifiedAt = r.date;
  return done('SAME_DAY', `當天通知 #${b.notif.id}`, b.notif);
}

/**
 * F19 硬事件：建議提早出場，使用者確認才做（設計 §6.2）。
 * byRule = true：動能持股被收購（PENDING_MA）或 NT 10-K／10-Q，由規則直接提出，不需要 AI。
 */
/** 硬事件法庭對動能持股的出場建議：同一檔同一類多少個日曆天內只通知一次（momentum_ai §3.5；和規則直接提出的一致）。 */
export const HARD_TOLD_DAYS: Record<string, number> = { PENDING_MA: 365 };
export const hardToldDays = (code: string) => HARD_TOLD_DAYS[code] ?? 180;

/** 這一檔這一類在 date 之前的期間內已經通知過 → 那一次的訊號日；沒有 → null。 */
export function hardToldWithin(acct: Pick<Account, 'mom'>, ticker: string, code: string, date: string): string | null {
  const told = acct.mom?.hardTold?.[ticker]?.[code];
  if (!told) return null;
  return (Date.parse(date) - Date.parse(told)) / 86400_000 < hardToldDays(code) ? told : null;
}

/**
 * 硬事件的通知（F19）。byRule = 規則直接提出；否則是法庭的建議（runIds）。
 * 動能持股的法庭建議：同一檔同一類 180 天（被收購 365 天）內已經通知過就不再列那一項（momToldOn = 上次的訊號日），
 * 通知了就記進 acct.mom.hardTold；自選那一項不受這個上限影響（own_thesis §1.9：硬事件照舊）。
 */
export function hardEvent(acct0: Account, view: MarketView, ticker: string, code: 'PENDING_MA' | 'ACCOUNTING' | 'REGULATORY', byRule: boolean, runIds?: string[]): { acct: Account; notif: Notif | null; momToldOn?: string } {
  const acct = clone(acct0);
  let momToldOn: string | undefined;
  const items: Item[] = [];
  const ai = runIds?.length ? { runIds: [...runIds] } : {};
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
        ...ai,
      }),
    );
  }
  const told = momSh > 0 && !byRule ? hardToldWithin(acct, ticker, code, view.date) : null;
  if (told) momToldOn = told;
  else if (momSh > 0) {
    if (!byRule) ((acct.mom.hardTold ??= {})[ticker] ??= {})[code] = view.date;
    items.push(
      makeItem({
        f: 'F19',
        kind: 'HARD',
        ticker,
        title: byRule ? `${ticker} ${code}：規則提出提早出場（動能）` : `${ticker} ${code}：AI 建議提早出場（動能）`,
        // AI 的建議：選「照 AI」才把這一檔拿出名單（MOM_DROP）；預設「不做」→ 名單不變，之後照排名進出（momentum_ai §3.5，修 Q11）
        choices: [{ id: byRule ? 'DO' : 'AI', label: byRule ? '確認出場' : '照 AI（出場）', lines: [{ ticker, bucket: 'mom', shares: -momSh, reason: '動能換股' }], ...(byRule ? {} : { effects: [{ type: 'MOM_DROP' as const, ticker }] }) }],
        choice: byRule ? 'DO' : 'SKIP',
        ruleChoice: byRule ? 'DO' : 'SKIP',
        ...ai,
      }),
    );
    // 規則直接提出：名單拿掉這一檔，下個月照排名遞補；沒確認出場的話，下個月月報會再列一次
    if (byRule) acct.rule.heldMom = acct.rule.heldMom.filter((t) => t !== ticker);
  }
  const told2 = momToldOn ? { momToldOn } : {};
  if (!items.length) return { acct, notif: null, ...told2 };
  const notif = newNotif(acct, view, { kind: 'URGENT', title: `${ticker} 硬事件（${code}）`, items });
  notif.preview = composeNotif(acct, view, notif);
  return { acct, notif, ...told2 };
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
