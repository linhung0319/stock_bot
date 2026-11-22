// 每日檢查與月報：把規則的結果變成「通知＋清單」，每一項附選項（照規則／照 AI／這次不做）。
// 設計：§2.0 觸發總表、§2.2 自選、§2.3 操作方式、§2.5 觸發與通知。
import {
  TIER_NAME,
  bucketValue,
  cellValues,
  clone,
  makeItem,
  newNotif,
  normRule,
  priceOf,
  shareCells,
  syncRunIds,
  totalValue,
  type Account,
  type AddNotice,
  type Choice,
  type CondNotice,
  type CoreOwe,
  type CrashReviewInfo,
  type DropStatus,
  dropReviewOpen,
  type Effect,
  type Item,
  type MarketView,
  type MonthlyContext,
  type Notif,
  type OwnMeta,
  type ReviewTrigger,
  type SavedState,
  type ShadowRecord,
  type Tier,
  type WatchEntryInput,
  type WatchMeta,
  usd,
} from './account';
import { dueOwnActions, ownSignalChange, planDay, type FlowInput, type PlanResult } from './allocator';
import { drawdownFromHigh, excessVol } from './indicators';
import { composeWithCore, coreBandLines, crashCoreLines, mergeByTicker, planToLines, tenths, type Composed, type CoreBand, type CoreContext, type OrderLine } from './orders';
import { WATCH_ENTRY_EXPIRE_DAYS, WATCH_LIST_GAP_DAYS, buyAllowed, buyCheck, raiseGapWhy, watchBuyFacts, watchRecWeight } from './buy';
import { DROP_LADDER, SLOW, dropLadder, halveShares, slowDayInput, stepSlowRule, stepWatch } from './slowRule';
import { cellKey, coreCfg, setApplied, type OwnAction, type OwnState } from './types';

// ---------------------------------------------------------------- 共用

/** fresh：這份清單帶進來的新錢（入金）；sweepCash：月報順便把帳上原本的現金買成短債（allocation_redesign §1.2）。 */
export function coreContext(acct: Account, view: MarketView, reserveCash = 0, opt: { fresh?: number; sweepCash?: boolean } = {}): CoreContext {
  return {
    cfg: acct.cfg,
    price: (t) => priceOf(view, t),
    cash: acct.cash,
    coreShares: acct.lots.core[acct.cfg.coreTicker] ?? 0,
    bondShares: acct.lots.core[acct.bondTicker] ?? 0,
    bondTicker: acct.bondTicker,
    total: totalValue(acct, view),
    reserveCash,
    ...(opt.fresh ? { fresh: opt.fresh } : {}),
    ...(opt.sweepCash ? { sweepCash: true } : {}),
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
        if (e.tier === 'HALF') setApplied(o, 'HALF');
        else if (e.tier === 'STANDARD') setApplied(o, 'STD');
        else if (e.tier === 'RAISE') o.stdWeight *= 1.25;
      } else if (e.type === 'WATCH_ENTER') {
        // 候補進場照做之後（allocation_redesign §4.5）：自選桶有了股數才算進場；目標是標準比重的一半（先買一半，或只有預設前提跌深的從減半開始）
        if (!rule.own[e.ticker] && (lots.own[e.ticker] ?? 0) > 0) ruleW().own[e.ticker] = { applied: e.half ? 'HALF' : 'BUILD', stdWeight: e.std };
      } else if (e.type === 'BUILD_END' && rule.own[e.ticker]?.applied === 'BUILD') {
        // 補滿照做：目標回到標準比重；不做：標準比重改成那時的實際比重（allocation_redesign §4.1）
        const o = ruleW().own[e.ticker];
        setApplied(o, 'STD');
        if (e.keep) {
          const total = totalValue({ ...acct, lots, cash }, view);
          const w = total > 0 ? ((lots.own[e.ticker] ?? 0) * priceOf(view, e.ticker)) / total : 0;
          if (w > 0) o.stdWeight = Math.min(acct.cfg.ownCapHi, w);
        }
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
  // 錢進出核心一律照比例（allocation_redesign §1.2）：入金的錢算新進核心的；帳上原本的現金只有月報順便買成短債
  return composeWithCore(lines, coreContext(acct, view, n.withdraw ?? 0, { fresh: n.deposit ?? 0, sweepCash: n.kind === 'MONTHLY' }));
}

// ---------------------------------------------------------------- 核心比例調回（F26，allocation_redesign §1.3）

/** 這份清單（合成之後，含核心吸收的行）做完時核心的樣子：核心 ETF、短債的股數與帳上現金。其他已回覆、還沒填快照的清單先當成做完了。 */
export function coreAfterList(acct0: Account, view: MarketView, composed: Pick<Composed, 'lines' | 'cashAfter'>, except?: number): Pick<CoreContext, 'cfg' | 'price' | 'cash' | 'coreShares' | 'bondShares' | 'bondTicker'> {
  const acct = afterOpenLists(acct0, view, { except });
  let coreShares = acct.lots.core[acct.cfg.coreTicker] ?? 0;
  let bondShares = acct.lots.core[acct.bondTicker] ?? 0;
  for (const l of composed.lines) {
    if (l.bucket !== 'core') continue;
    if (l.ticker === acct.cfg.coreTicker) coreShares += l.shares;
    else if (l.ticker === acct.bondTicker) bondShares += l.shares;
  }
  return { cfg: acct.cfg, price: (t) => priceOf(view, t), cash: composed.cashAfter, coreShares, bondShares, bondTicker: acct.bondTicker };
}

const pct1 = (x: number) => `${(x * 100).toFixed(1)}%`;
const pct0 = (x: number) => `${Math.round(x * 1000) / 10}%`;

/** 第一次的 F26 多的那一句（allocation_redesign §1.5）。 */
export const CORE_SWITCH_NOTE = '這是從崩盤規則換到固定比例的一次性調整。';
/** 晚回覆重算時已經回到界線內。 */
export const CORE_BAND_BACK_NOTE = '重算後已經回到界線內，這一項不用做';

/** 從崩盤規則換過來、還沒有照做過核心比例調回（§1.5 的「第一次」；選了這次不做的不算做過）。 */
function coreSwitchPending(acct: Pick<Account, 'fromCrashRule' | 'notifs'>): boolean {
  if (!acct.fromCrashRule) return false;
  return !acct.notifs.some((n) => (n.status === 'DONE' || n.status === 'RESPONDED') && n.items.some((i) => i.f === 'F26' && !i.cancelled && i.choice === 'DO'));
}

/**
 * 月報狀態文字的核心那一段（allocation_redesign §1.6）：`核心：SGOV 與現金 19.2%（15%～25% 之內不調）`。
 * 超出界線時說明這份月報怎麼處理：有 F26 就寫「下面有調回 20% 的一項」；換算不出整股就寫這次不動、下個月再算。
 */
export function coreStatusText(acct: Pick<Account, 'cfg' | 'bondTicker'>, check: CoreBand, hasItem: boolean): string {
  const { bond, band } = coreCfg(acct.cfg);
  const lo = pct0(bond - band);
  const hi = pct0(bond + band);
  const head = `核心：${acct.bondTicker} 與現金 ${pct1(check.s)}`;
  // T86 P12e：這個比例是這份月報其他單做完之後的（首頁的核心比例是現在的，兩個數字不同）
  const after = '這份月報其他單做完之後';
  if (!check.out) return `${head}（${after}，${lo}～${hi} 之內不調）`;
  const side = check.s > bond ? `超過 ${hi}` : `低於 ${lo}`;
  return `${head}（${after}，${side}，${hasItem ? `下面有調回 ${pct0(bond)} 的一項` : '這次換算不出整股，下個月再算'}）`;
}

/** F26 的標題與理由（allocation_redesign §1.3 的項目文字）。 */
function coreBandText(acct: Account, check: CoreBand, first: boolean): { title: string; why: string } {
  const { bond, band } = coreCfg(acct.cfg);
  const b = acct.bondTicker;
  const v = acct.cfg.coreTicker;
  const high = check.s > bond;
  const title = `核心比例調回：${b} 那一邊占核心 ${pct1(check.s)}，${high ? `超過 ${pct0(bond + band)}` : `低於 ${pct0(bond - band)}`} → 調回 ${pct0(bond)}`;
  const base = `核心固定放 ${v} ${tenths(1 - bond)}、${b} 與現金${tenths(bond)}。平常不調，超出 ${pct0(bond - band)}～${pct0(bond + band)} 才調回。`;
  // T86 P5：不猜原因（自己買賣、出金、從全 VOO 起步也會偏離），只描述事實與調回的方向
  const dir = `${b} 那一邊占核心 ${pct1(check.s)}，${high ? `超過 ${pct0(bond + band)}` : `低於 ${pct0(bond - band)}`}，調回 ${pct0(bond)}：${high ? `賣 ${b}、買 ${v}` : `賣 ${v}、買 ${b}`}。`;
  return { title, why: base + (first ? '' : dir) };
}

/**
 * 核心比例的界線檢查（allocation_redesign §1.3）：用這份清單其他單合成之後的預期持股與訊號日收盤價算 s；
 * 超出界線、而且換算得出整股 → 一項 F26（預設照做、這次不做不用理由、不記欠單）。check 一律回傳（月報記下來顯示用）。
 */
export function coreBandItem(acct: Account, view: MarketView, composed: Pick<Composed, 'lines' | 'cashAfter'>, except?: number): { check: CoreBand; item: Item | null } {
  const { check, lines } = coreBandLines(coreAfterList(acct, view, composed, except));
  if (!lines.length) return { check, item: null };
  const first = coreSwitchPending(acct);
  const item = makeItem({ f: 'F26', kind: 'CORE_BAND', ...coreBandText(acct, check, first), choices: [{ id: 'DO', label: '照做', lines }], ...(first ? { note: CORE_SWITCH_NOTE } : {}) });
  return { check, item };
}

/**
 * 晚回覆（提醒過才回）時 F26 的行照回覆當天的價格與持股重算（設計 §2.3.1「忘了」）：其他項目照目前選的選項合成之後再檢查一次；
 * 已經回到界線內 → 行清空（不用做）。直接改傳進來的通知。
 */
export function refreshCoreBand(acct: Account, view: MarketView, n: Notif): void {
  const it = n.items.find((i) => i.f === 'F26' && i.kind === 'CORE_BAND' && !i.cancelled);
  if (!it) return;
  const rest: Notif = { ...n, items: n.items.filter((i) => i !== it) };
  const { lines } = coreBandLines(coreAfterList(acct, view, composeNotif(acct, view, rest), n.id));
  it.choices[0].lines = lines;
  const note = lines.length ? `晚回覆：用 ${view.date} 收盤價重算` : CORE_BAND_BACK_NOTE;
  it.note = it.note && !it.note.includes('晚回覆') && !it.note.includes(CORE_BAND_BACK_NOTE) ? `${it.note}；${note}` : note;
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
      // 和規則的減半是同一個動作：正常狀態時賣掉當時股數的一半；已經減半就不動。
      // 先買一半（BUILD，allocation_redesign §4.1）也可以被減半：賣掉一半的一半，之後是減半
      return stateBefore === 'STD' || stateBefore === 'BUILD' ? -halveShares(cur) : 0;
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
function absorbBreak(acct: Account, view: MarketView, ticker: string, thesis = false): Item['absorbed'] {
  const meta = acct.own[ticker];
  if (!meta) return undefined;
  const pb = pendingBreak(acct, ticker);
  if (pb && pb.it.brk?.type === 'B') {
    const tier = pb.it.choices.find((c) => c.id === 'AI')?.tier === 'EXIT' ? 'EXIT' : 'HALF';
    const premiseId = pb.it.brk.premiseId;
    const date = meta.aiTier?.premiseId === premiseId && meta.aiTier.date <= pb.n.date ? meta.aiTier.date : pb.n.date;
    pb.it.cancelled = true;
    pb.it.note = thesis ? `比高點低 20% 以上，觸發跌幅審查了，這一項併進 ${ticker} 的跌幅審查通知（在那裡決定）` : `慢規則也觸發減半了，這一項併進 ${ticker} 的慢規則減半通知（在那裡決定）`;
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
      if (it.thesisDrop) {
        // 有論點的股票的跌幅審查：選項與預設跟著結果變（allocation_redesign §3.2），試算的清單也要重算
        if (!setThesisDrop(acct, view, it, n.date)) continue;
        syncRunIds(n);
        n.preview = composeNotif(acct, view, n);
        changed.push(n.id);
        continue;
      }
      const ai = it.f === 'F7' ? reduceAi(acct, view, ticker, it.absorbed, n.date) : readdAi(acct, view, ticker);
      if (!setOwnAi(acct, it, ai)) continue;
      syncRunIds(n);
      changed.push(n.id);
    }
  }
  return { acct, changed: [...new Set(changed)] };
}

// ---------------------------------------------------------------- 有論點的股票：跌幅審查（allocation_redesign §3.2、§3.3）

/** 跌幅審查項目的理由：跌幅只觸發審查，不是賣出的理由。 */
export const THESIS_DROP_WHY = '收盤距 52 週高點跌 ≥ 20%。這檔有你的論點：跌幅只觸發論點檢查，不是賣出的理由；3 票判同一條前提不成立才減半。';
/** 2 個交易日沒有回覆、自動照預設（不動）結案時，影子紀錄的備註。 */
export const AUTO_DEFAULT_NOTE = '2 個交易日沒有回覆，自動照預設（不動）結案';
/** 預設不下單的通知幾個交易日沒有回覆就自動結案（§3.2）。 */
export const AUTO_DEFAULT_DAYS = 2;
/** 審查後持有時，快照顯示你自己賣掉原本股數的這個比例以上（還沒賣光）→ 照減半處理（§3.6）。 */
export const SELF_HALVE_MIN = 0.25;

/** DROP_LADDER 第幾級的白話：`20%`、`30%`…（超出範圍取最近的一級）。 */
export const ladderPct = (level: number): string => `${Math.round(-DROP_LADDER[Math.min(Math.max(level, 0), DROP_LADDER.length - 1)] * 100)}%`;
const signedPct = (x: number) => {
  const r = Math.round(x * 100);
  return `${r > 0 ? '+' : r < 0 ? '-' : ''}${Math.abs(r)}%`;
};

/** 跌幅拆解的那一句（只是資訊，§3.2）：`這次下跌：大盤 -8%、產業比大盤 -9%、個股自身 -5%`。算不出來是空字串。 */
export function dropAttrText(a: NonNullable<OwnMeta['dropReview']>['attr']): string {
  if (!a || !Number.isFinite(a.market) || !Number.isFinite(a.idio)) return '';
  return `這次下跌：大盤 ${signedPct(a.market)}${a.sector === null || !Number.isFinite(a.sector) ? '' : `、產業比大盤 ${signedPct(a.sector)}`}、個股自身 ${signedPct(a.idio)}`;
}

/** 預設不下單的跌幅審查項目（有論點、沒有前提被判不成立）。 */
export const holdsByDefault = (it: Pick<Item, 'thesisDrop' | 'drop' | 'cancelled'>): boolean => !!it.thesisDrop && !it.cancelled && it.drop !== 'BROKEN';
/** 整則通知都是預設不下單的跌幅審查（不用回覆、不提醒、2 個交易日自動結案；§3.2）。 */
export const isHoldNotice = (n: Pick<Notif, 'kind' | 'items'>): boolean => n.kind === 'URGENT' && n.items.some((i) => !i.cancelled) && n.items.every((i) => i.cancelled || holdsByDefault(i));

/**
 * 有論點的股票的跌幅審查項目（F7，§3.2 的表）：照現在的審查結果（dropReview）、觸發之後另外回來的審查或併進來的乙類，重寫那一行、選項與預設。
 *   前提不成立（審查 3 票判同一條；或另外的審查、併進來的乙類判的）→ 預設減半；3 票都選出清時多「照 AI：出清」；這次不做要寫理由
 *   前提都沒有被判不成立／票數不一致／沒跑完／還在跑 → 預設不動；另一個選項是減半（你自己想賣時用，不用理由）
 * 規則的那條線（ruleChoice）一律是減半：影子紀錄記「照舊的慢規則會怎樣」。股數照現在的持股算。直接改 it，回傳有沒有變。
 */
function setThesisDrop(acct: Account, view: MarketView, it: Item, since: string): boolean {
  const ticker = it.ticker;
  const meta = ticker ? acct.own[ticker] : undefined;
  if (!ticker || !meta) return false;
  const sig = () => JSON.stringify([it.choices, it.aiLine, it.runIds, it.drop, it.brk, it.why, it.choice, it.reasonRequired, it.dipAdd]);
  const before = sig();
  const wasBroken = it.drop === 'BROKEN';
  const dr = meta.dropReview ?? null;
  const top = reviewOnTop(meta, it.absorbed, since);
  const drRun = dr?.runId ? [dr.runId] : [];
  const half = -halveShares(acct.lots.own[ticker] ?? 0);
  const halfChoice: Choice = { id: 'RULE', label: '減半', tier: 'HALF', lines: half ? [{ ticker, bucket: 'own', shares: half, reason: '自選訊號' }] : [], effects: [{ type: 'APPLY_TIER', ticker, tier: 'HALF' }] };
  // 哪一條前提不成立：審查自己判的（3 票都選出清的優先）→ 另外的審查判出清的 → 審查判的 → 另外的審查判的
  const own = dr?.status === 'BROKEN' && dr.premiseId ? { premiseId: dr.premiseId, exit: !!dr.exit, lead: '論點檢查（3 票）：', runIds: drRun } : null;
  const other = top ? { premiseId: top.premiseId, exit: top.tier === 'EXIT', lead: `${mdOf(top.date)} 的審查（3 票）：`, runIds: top.runIds } : null;
  const broken = own?.exit ? own : other?.exit ? other : (own ?? other);
  const set = <K extends 'aiLine' | 'runIds' | 'drop' | 'brk' | 'reasonRequired'>(k: K, v: Item[K] | undefined) => {
    if (v === undefined) delete it[k];
    else it[k] = v;
  };
  if (broken) {
    const sh = tierShares(acct, view, ticker, 'EXIT', 'STD');
    const exitChoice: Choice[] = broken.exit ? [{ id: 'AI', label: `照 AI：出清，${sharesText(sh)}`, tier: 'EXIT', lines: sh ? [{ ticker, bucket: 'own', shares: sh, reason: 'AI 建議' }] : [], effects: [{ type: 'APPLY_TIER', ticker, tier: 'EXIT' }] }] : [];
    it.choices = [halfChoice, ...exitChoice, { id: 'SKIP', label: '這次不做', lines: [] }];
    set('aiLine', `${broken.lead}前提「${premiseText(meta, broken.premiseId)}」不成立${broken.exit ? `。AI 建議出清，${sharesText(sh)}` : ''}${disputeNote(meta, broken.premiseId, view.date)}`);
    set('runIds', broken.runIds.length ? broken.runIds : undefined);
    set('drop', 'BROKEN');
    set('brk', { type: 'B', premiseId: broken.premiseId, withRule: true });
    set('reasonRequired', true);
    delete it.dipAdd;
    // 預設減半：剛變成前提不成立、或原本選的選項已經不在了，就回到預設
    if (!wasBroken || !it.choices.some((c) => c.id === it.choice)) it.choice = 'RULE';
  } else {
    it.choices = [{ id: 'SKIP', label: '不動', lines: [] }, halfChoice];
    const attr = dropAttrText(dr?.attr);
    let line: string | undefined;
    let drop: DropStatus | undefined;
    if (dr?.status === 'PENDING') {
      line = 'AI 論點檢查進行中，台灣 09:30 前更新；結果出來之前先不動';
      drop = 'PENDING';
    } else if (dr?.status === 'CLEAR') {
      line = `論點檢查（3 票）：你的 ${meta.premises.length} 條前提都沒有被判不成立${attr ? `。${attr}` : ''}`;
      drop = 'CLEAR';
    } else if (dr?.status === 'SPLIT') {
      // 3 票都判了同一條、但不是每一票都有合格的引用（只有新聞標題或價格、引用沒過檢查）：不算數，另外寫清楚
      line = !dr.splitPremise || !dr.splitVotes ? '論點檢查：3 票的結論不一致，沒有前提被 3 票判不成立' : dr.splitVotes >= 3 ? `論點檢查：3 票都認為前提「${premiseText(meta, dr.splitPremise)}」不成立，但不是每一票都有合格的引用，不算數` : `論點檢查：3 票裡有 ${dr.splitVotes} 票認為前提「${premiseText(meta, dr.splitPremise)}」不成立，沒有一致結論`;
      drop = 'SPLIT';
    } else if (dr) {
      // 沒跑完（NONE；其他狀態也當成沒有結論）
      line = dr.failed ? 'AI 論點檢查沒有跑完，不動；之後財報後的審查與再跌一級時仍會檢查' : 'AI 論點檢查還沒有結論，先不動；會再檢查';
      drop = 'NONE';
    }
    // 下跌加碼（allocation_redesign §4.4，T84）：前提都沒有被判不成立、而且更嚴的那幾項也過了 → 多一個加碼的選項（預設仍是不動）
    // dip：審查面的結果（T84 之後的審查才有；沒有的不算，也不在持股頁寫原因）
    const offer = dr?.status === 'CLEAR' && dr.thesis && dr.dip ? dipOffer(acct, view, ticker, it.thesisDrop?.level ?? 0, it.key) : null;
    if (dr?.status === 'CLEAR') dr.dipOffer = offer ? { ok: offer.ok, why: offer.why, ...(offer.ok ? { mode: offer.mode, shares: offer.shares } : {}) } : null;
    if (offer?.ok && offer.mode && offer.shares) {
      const n = offer.shares;
      const effects: Effect[] = [{ type: 'DIP_ADD', ticker, episode: offer.episode }, offer.mode === 'RAISE' ? { type: 'APPLY_TIER', ticker, tier: 'RAISE' } : { type: 'BUILD_END', ticker, keep: false }];
      it.choices.push({ id: 'AI', label: offer.mode === 'RAISE' ? `加碼：提高到標準的 125%，買 ${n} 股` : `補滿到標準比重，買 ${n} 股`, ...(offer.mode === 'RAISE' ? { tier: 'RAISE' as Tier } : {}), lines: [{ ticker, bucket: 'own', shares: n, reason: '下跌加碼' }], effects });
      it.dipAdd = { mode: offer.mode, shares: n, note: offer.cut ? `${DIP_ADD_NOTE}（${offer.cut}）` : DIP_ADD_NOTE };
      // 一次下跌只提一次：記下這一次下跌在哪一級提過（同一級的這一項重算時照樣給）
      if (meta.dipAdd?.episode !== offer.episode) meta.dipAdd = { episode: offer.episode, level: it.thesisDrop?.level ?? 0, offered: view.date };
    } else delete it.dipAdd;
    set('aiLine', line);
    set('runIds', drop && drRun.length ? drRun : undefined);
    set('drop', drop);
    set('brk', undefined);
    set('reasonRequired', undefined);
    // 預設不動；你已經選了加碼、而且這個選項還在（重算股數時）就留著
    it.choice = it.choice === 'AI' && it.choices.some((c) => c.id === 'AI') ? 'AI' : 'SKIP';
  }
  it.ruleChoice = 'RULE';
  it.why = THESIS_DROP_WHY;
  return before !== sig();
}

/** 下跌加碼選項說明固定的那一句（allocation_redesign §4.4）。 */
export const DIP_ADD_NOTE = 'AI 檢查的是論點有沒有壞，不是會不會繼續跌。下跌時加碼，跌更深時虧得更多；這一次下跌只會提這一次。';

/** 下跌加碼的選項算出來的樣子（dipOffer）。episode：這一次下跌（審查後持有從哪一天開始）；cut：被上限砍掉一部分時的說明。 */
export interface DipOffer {
  ok: boolean;
  why: string;
  episode: string;
  mode?: 'RAISE' | 'FILL';
  shares?: number;
  cut?: string | null;
}

/**
 * 下跌加碼（allocation_redesign §4.4，D5，T84）：這檔這一級的跌幅審查通知上能不能多一個加碼的選項。限制寫死在程式，AI 不能放寬：
 *   1. 審查面（dropReview.dip，dropDecision 算的）：前提都沒有被判不成立，而且 3 票對每一條可驗證的前提都判成立、引用有申報或財報，
 *      程式核對跌幅拆解（個股自身不超過整段一半）
 *   2. 只有有論點的股票（跌幅審查本身就只有它們）；減半中沒有
 *   3. 一次下跌只提一次：這一次下跌（watchSince）已經在別的一級提過 → 不給（不論上次有沒有選）
 *   4. 標準、審查後持有 → 提高到標準的 125%，和 125% 共用 12 個月的間隔；先買一半 → 補滿到標準比重，不看間隔（補滿不算提高）
 *   5. 買進前的程式檢查（§4.0；這一項本身不算還沒結案的跌幅審查）；超過上限的砍掉，砍到 0 不給
 * level：這一項審的是第幾級；itemKey：這一項的 key。純函式（不改帳戶）。
 */
export function dipOffer(acct: Account, view: MarketView, ticker: string, level: number, itemKey?: string): DipOffer {
  const meta = acct.own[ticker];
  const rule = acct.rule.own[ticker];
  const dr = meta?.dropReview;
  const episode = meta?.watchSince ?? dr?.session ?? view.date;
  const no = (why: string): DipOffer => ({ ok: false, why, episode });
  if (!meta || !rule || !dr?.thesis) return no('不是有論點的股票的跌幅審查');
  if (dr.status !== 'CLEAR') return no('跌幅審查的結果不是「前提都沒有被判不成立」');
  if (!dr.dip?.ok) return no(dr.dip?.why ?? '審查沒有證實每一條前提');
  if (defaultOnly(meta)) return no('這檔只有系統預設前提');
  if (meta.slow.state === 'HALF' || rule.applied === 'HALF') return no('這檔在減半中');
  if (meta.dipAdd && meta.dipAdd.episode === episode && meta.dipAdd.level !== level) return no(`這一次下跌已經在比高點低 ${ladderPct(meta.dipAdd.level)} 那一級提過加碼（一次下跌只提一次）`);
  const mode: 'RAISE' | 'FILL' = meta.build && rule.applied === 'BUILD' ? 'FILL' : 'RAISE';
  if (mode === 'RAISE') {
    const gap = raiseGapWhy(meta, view.date);
    if (gap) return no(`${gap}（和提高到 125% 共用間隔）`);
  }
  const want = Math.floor((rule.stdWeight * (mode === 'RAISE' ? 1.25 : 1) * totalValue(acct, view)) / priceOf(view, ticker) + 1e-9) - (acct.lots.own[ticker] ?? 0);
  if (want <= 0) return no(mode === 'RAISE' ? '現在的持股已經到標準的 125%' : '現在的持股已經到標準比重');
  const v = buyCheck(acct, view, ticker, view.date, want, itemKey);
  if (!v.ok) return no(v.why ?? '買進前的程式檢查沒過');
  return { ok: true, why: dr.dip.why, episode, mode, shares: v.shares, cut: v.cut ? v.why : null };
}

/** 跌幅審查的項目（有論點的股票）。dd：觸發那天距 52 週高點的跌幅；note 接在標題後面（併入月報的那一句）。 */
function thesisDropItem(acct: Account, view: MarketView, ticker: string, note: string, dd?: number | null): Item {
  const meta = acct.own[ticker];
  const absorbed = absorbBreak(acct, view, ticker, true);
  const c = view.close[ticker];
  const d = dd ?? (c ? drawdownFromHigh(c, view.i, SLOW.highDays) : NaN);
  const level = meta?.watchLevel ?? 0;
  const it = makeItem({
    f: 'F7',
    kind: 'OWN_RULE',
    ticker,
    title: Number.isFinite(d) ? `${ticker}：比 52 週高點低 ${(-d * 100).toFixed(1)}% → 跌幅審查${note}` : `${ticker} 跌幅審查${note}`,
    choices: [{ id: 'SKIP', label: '不動', lines: [] }],
    why: THESIS_DROP_WHY,
    thesisDrop: { level },
    ...(level > 0 ? { note: `上一次審的是比高點低 ${ladderPct(level - 1)} 那一級；又跌到 ${ladderPct(level)} 以上，重新審查` } : {}),
    ...(absorbed ? { absorbed } : {}),
  });
  setThesisDrop(acct, view, it, view.date);
  return it;
}

/** 這檔還沒回覆的跌幅審查項目（有論點的那一種）。 */
function openThesisDrop(acct: Account, ticker: string): { n: Notif; it: Item } | null {
  for (const n of acct.notifs) {
    if (n.status !== 'PENDING') continue;
    const it = n.items.find((i) => i.ticker === ticker && !i.cancelled && i.f === 'F7' && !!i.thesisDrop);
    if (it) return { n, it };
  }
  return null;
}

/**
 * 這檔的跌幅審查你已經選了減半（或照 AI 出清）、還在等下單填快照的那則通知；沒有是 null。
 * 這時規則的狀態還是審查後持有（照做了才變），但不能再為同一件事另外發一張減半的單。
 */
export function decidedThesisDrop(acct: Pick<Account, 'notifs'>, ticker: string): Notif | null {
  // 選了下跌加碼（前提都沒有被判不成立時的 AI 選項，T84）不是要賣
  return acct.notifs.find((n) => n.status === 'RESPONDED' && n.items.some((i) => i.ticker === ticker && !i.cancelled && i.f === 'F7' && !!i.thesisDrop && (i.choice === 'RULE' || (i.choice === 'AI' && i.drop === 'BROKEN')))) ?? null;
}

/** 還沒回覆的跌幅審查項目取消（回到標準了、又跌一級重新審查、併入月報、你自己賣了一半）。整則都取消（月報以外）→ 通知跟著結束。回傳改了哪幾則。 */
export function cancelThesisDrop(acct: Account, ticker: string, note: string, status: 'CANCELLED' | 'SUPERSEDED' = 'CANCELLED'): number[] {
  const out: number[] = [];
  for (const n of acct.notifs) {
    if (n.status !== 'PENDING') continue;
    let hit = false;
    for (const it of n.items) {
      if (it.cancelled || it.ticker !== ticker || it.f !== 'F7' || !it.thesisDrop) continue;
      it.cancelled = true;
      it.note = note;
      hit = true;
    }
    if (!hit) continue;
    out.push(n.id);
    if (n.kind !== 'MONTHLY' && n.items.every((i) => i.cancelled)) {
      n.status = status;
      n.coreAbsorb = false;
      delete n.preview;
    } else n.preview = undefined;
  }
  return out;
}

/** 這檔離開審查後持有（回到標準、減半、你自己賣了一半）：審到第幾級、這一次的審查結果、等月報的減半都清掉。 */
export function leaveWatch(meta: OwnMeta): void {
  delete meta.watchLevel;
  delete meta.watchSince;
  delete meta.dropReview;
  if (meta.pending?.action === 'REDUCE') meta.pending = null;
}

/** 減半這一筆占總資產夠不夠大（≥ urgentFrac，5%）：夠大當天通知，否則併入月報（設計 §2.5，照舊）。 */
function halveIsUrgent(acct: Account, view: MarketView, ticker: string): boolean {
  if (acct.cfg.urgentFrac === null) return false;
  const chg = halveShares(acct.lots.own[ticker] ?? 0) * priceOf(view, ticker);
  return chg > 0 && chg >= acct.cfg.urgentFrac * totalValue(acct, view);
}

/** UPDATED 更新還沒回覆的通知；MONTHLY 減半併入下一份月報；SAME_DAY 另發一則當天通知；NONE 只放網站。 */
export type DropRoute = 'UPDATED' | 'MONTHLY' | 'SAME_DAY' | 'NONE';

/**
 * 有論點的股票的跌幅審查結果寫進 dropReview 之後（allocation_redesign §3.2）：通知跟著變。
 *   有還沒回覆的跌幅審查項目 → 就地重算那一行、選項與預設。例外：結果是前提不成立、這一筆不到總資產 5%、而且今天的月報還沒出
 *     → 那一項取消，記成等月報的減半（下一份月報列，預設減半）；今天的月報已經出了就留在當天那一則，免得多等一個月
 *   沒有（已經自動結案、你先選了不動）而且結果是前提不成立、這檔還在審查後持有 → ≥ 5%（或今天的月報已經出了）發一則當天通知，否則等月報
 *   你已經先選了減半、還在等下單（decidedThesisDrop）→ 不另外發
 *   其他 → 只放網站（持股頁）
 */
export function applyDropResult(acct0: Account, view: MarketView, ticker: string): { acct: Account; route: DropRoute; notif: Notif | null; changed: number[]; why: string } {
  const meta0 = acct0.own[ticker];
  const dr = meta0?.dropReview;
  if (!meta0 || !dr?.thesis) return { acct: acct0, route: 'NONE', notif: null, changed: [], why: '不是有論點的股票的跌幅審查' };
  const broken = dr.status === 'BROKEN' && !!dr.premiseId;
  const monthlyToday = acct0.notifs.some((n) => !!n.monthly && n.date === view.date);
  const small = !halveIsUrgent(acct0, view, ticker);
  const open0 = openThesisDrop(acct0, ticker);
  if (open0) {
    if (broken && open0.n.kind === 'URGENT' && small && !monthlyToday && !open0.it.absorbed) {
      const acct = clone(acct0);
      const meta = acct.own[ticker];
      const changed = cancelThesisDrop(acct, ticker, `論點檢查（3 票）：前提「${premiseText(meta, dr.premiseId!)}」不成立 → 減半。這一筆不到總資產的 5%，併入下一份月報`, 'SUPERSEDED');
      meta.pending = { action: 'REDUCE', date: dr.session };
      return { acct, route: 'MONTHLY', notif: null, changed, why: `前提不成立、變動不到 5%：通知 #${changed.join('、#')} 的那一項取消，減半併入下一份月報` };
    }
    const r = refreshOwnAiChoice(acct0, view, ticker);
    return { acct: r.acct, route: 'UPDATED', notif: null, changed: r.changed, why: r.changed.length ? `更新通知 #${r.changed.join('、#')}` : '通知不用改' };
  }
  if (!broken) return { acct: acct0, route: 'NONE', notif: null, changed: [], why: '沒有還沒回覆的通知，只放網站' };
  const decided = decidedThesisDrop(acct0, ticker);
  if (decided) return { acct: acct0, route: 'NONE', notif: null, changed: [], why: `通知 #${decided.id} 已經選了要賣、等下單，不另外發` };
  if (meta0.slow.state !== 'WATCH') return { acct: acct0, route: 'NONE', notif: null, changed: [], why: '這檔已經不在審查後持有（已經減半或回到標準），只放網站' };
  if (meta0.pending?.action === 'REDUCE') return { acct: acct0, route: 'NONE', notif: null, changed: [], why: '減半已經在等月報' };
  const acct = clone(acct0);
  if (small && !monthlyToday) {
    acct.own[ticker].pending = { action: 'REDUCE', date: dr.session };
    return { acct, route: 'MONTHLY', notif: null, changed: [], why: '前提不成立、變動不到 5%：減半併入下一份月報' };
  }
  const it = thesisDropItem(acct, view, ticker, '', acct.own[ticker].reduceDd);
  const notif = newNotif(acct, view, { kind: 'URGENT', title: `${ticker} 跌幅審查：前提不成立`, items: [it] });
  notif.preview = composeNotif(acct, view, notif);
  return { acct, route: 'SAME_DAY', notif, changed: [], why: `前提不成立：當天通知 #${notif.id}` };
}

/**
 * 跌幅審查項目的影子紀錄（三條線，§3.2）：照舊的慢規則（減半的股數）、照 AI（前提不成立 → 減半，3 票出清時是出清；
 * 都沒有被判不成立 → 0 股；沒有一致結論、沒跑完 → 沒有）、實際。每一次回覆（含自動結案）都記。
 */
export function thesisDropShadow(view: MarketView, n: Notif, it: Item, note?: string): ShadowRecord {
  const tk = it.ticker!;
  const sum = (c?: Choice) => (c?.lines ?? []).filter((l) => l.ticker === tk).reduce((a, l) => a + l.shares, 0);
  const rule = sum(it.choices.find((c) => c.id === 'RULE'));
  const aiC = it.choices.find((c) => c.id === 'AI');
  const ai = it.drop === 'BROKEN' ? (aiC ? sum(aiC) : rule) : it.drop === 'CLEAR' ? 0 : null;
  // 下跌加碼（T84）：AI 的那條線仍是審查的結論（不動，0 股）；實際買了的那一筆備註寫明
  const reason = note ?? it.reason ?? (it.dipAdd && it.choice === 'AI' ? `下跌加碼：${it.dipAdd.mode === 'RAISE' ? '提高到標準的 125%' : '補滿到標準比重'}` : undefined);
  return { date: view.date, f: it.f, ticker: tk, title: it.title, rule, ai, actual: sum(it.choices.find((c) => c.id === it.choice)), price: view.close[tk] ? priceOf(view, tk) : 0, choice: it.choice, notif: n.id, ...(it.runIds?.length ? { runIds: [...it.runIds] } : {}), ...(reason ? { note: reason } : {}) };
}

/** 晚回覆時跌幅審查項目照今天的持股重算股數（ops.ts 的 recomputeLate 用）。直接改 it。 */
export function rebuildThesisDrop(acct: Account, view: MarketView, n: Notif, it: Item): void {
  setThesisDrop(acct, view, it, n.date);
}

/** 把規則的計畫（每一格的目標金額）變成清單項目。 */
function itemsFromPlan(acct: Account, view: MarketView, plan: PlanResult, values: Record<string, number>, ctx: { ownNotes?: Record<string, string>; runIds?: MonthlyContext['runIds'] }): Item[] {
  const lines = planToLines(plan, values, { price: (t) => priceOf(view, t), shares: shareCells(acct) });
  const items: Item[] = [];
  const volLines: OrderLine[] = [];
  const reduced = new Set(plan.events.filter((e) => e.kind === 'REDUCE').map((e) => e.ticker));
  const added = new Set(plan.selection?.added ?? []);
  for (const l of lines) {
    const t = l.ticker;
    switch (l.reason) {
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
  // 崩盤規則的項目（F5／F6）2026-11-22 起不再產生（allocation_redesign §1.6）；動能整體的增減只剩依波動度減碼
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
    monthly: { order: input.order, excessVol: vol.fn, blocked, owed: Object.keys(acct.mom.owe), emptySlots: input.emptySlots, companyOf: companyOfInput(input) },
  });
  return vol.record(input);
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
  /** 今天要開跌幅審查的（有論點的股票：第一次到 -20%，或審查後持有時又跌了一級）。 */
  const reviews: string[] = [];
  for (const [tk, meta] of Object.entries(acct.own)) {
    const c = view.close[tk];
    if (!c) continue;
    const day = slowDayInput(c, view.i);
    const wasWatch = meta.slow.state === 'WATCH';
    // 先買一半（BUILD，allocation_redesign §4.1）：賣出的規則和標準狀態相同（-20% 照 §3），所以照標準狀態前進一步；
    // 沒有切換就留在先買一半。stepSlowRule 本身不改（它不認得 BUILD）
    const wasBuild = meta.slow.state === 'BUILD';
    const step = stepSlowRule(wasBuild ? { ...meta.slow, state: 'STD' } : meta.slow, day);
    if (wasBuild && !step.signal) step.next.state = 'BUILD';
    if (wasWatch) {
      // 審查後持有（allocation_redesign §3.3）：stepSlowRule 只更新了兩個計數；進出在這裡判
      const w = stepWatch(step.next, meta.watchLevel ?? 0, day);
      meta.slow = w.next;
      if (w.event === 'BACK') {
        leaveWatch(meta);
        // 先買一半期間跌 20%、審查之後沒有減半的：站回均線回到先買一半（還沒補滿，§4.1）
        if (meta.build) meta.slow = { ...meta.slow, state: 'BUILD' };
        cancelThesisDrop(acct, tk, `${mdOf(view.date)} 已經站回 200 日均線連續 ${SLOW.aboveRun} 天，回到一般狀態，這一項取消`);
        log.push({ ticker: tk, what: '審查後持有 → 站回 200 日均線，回到標準（不下單、不通知）' });
      } else if (w.event === 'DEEPER') {
        meta.watchLevel = w.level;
        if (meta.pending?.action === 'REDUCE') log.push({ ticker: tk, what: `比高點低 ${ladderPct(w.level)} 以上；上一次審查已經判前提不成立、減半在等月報，不另外審查` });
        else {
          meta.reduceDd = Number.isFinite(day.drawdown) ? day.drawdown : null;
          reviews.push(tk);
        }
      }
      continue;
    }
    // 有論點的股票（種類以觸發當天的為準，§3.1）：比高點低 20% 只觸發審查，不減半，進審查後持有（§3.2、§3.3）。
    // 還沒下單的加回和這次互相抵銷的照舊（下面：留在減半，月報不列）
    if (step.signal === 'REDUCE' && !defaultOnly(meta) && meta.pending?.action !== 'READD') {
      meta.slow = { state: 'WATCH', aboveRun: step.next.aboveRun, sinceSwitch: 0 };
      meta.watchLevel = Math.max(0, dropLadder(day.drawdown));
      // 這一次下跌從今天開始（下跌加碼的「一次下跌一次」，§4.4）
      meta.watchSince = view.date;
      meta.reduceDd = Number.isFinite(day.drawdown) ? day.drawdown : null;
      meta.pending = null;
      reviews.push(tk);
      continue;
    }
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
        // 先買一半時觸發、還沒下單的減半被抵銷：回到先買一半（目標還沒改，§4.1）
        if (meta.build && acct.rule.own[tk]?.applied === 'BUILD') meta.slow = { ...meta.slow, state: 'BUILD' };
        log.push({ ticker: tk, what: '慢規則切換和尚未下單的上一次互相抵銷，月報不列' });
      } else {
        meta.pending = { action: step.signal, date: view.date };
      }
    }
  }
  // 跌幅審查（有論點的股票）：當天產生一則通知，不分金額大小；預設不動，等審查的結果（§3.2）
  for (const tk of reviews) {
    const meta = acct.own[tk];
    // 上一級的審查不再對應；還沒回覆的那一則以新的為準
    delete meta.dropReview;
    const level = meta.watchLevel ?? 0;
    const it = thesisDropItem(acct, view, tk, '', meta.reduceDd);
    cancelThesisDrop(acct, tk, `又跌到比高點低 ${ladderPct(level)} 以上，重新審查；這一項以新的跌幅審查通知為準`, 'SUPERSEDED');
    const n = newNotif(acct, view, { kind: 'URGENT', title: `${tk} 跌幅審查`, items: [it] });
    n.preview = composeNotif(acct, view, n);
    created.push(n);
    log.push({ ticker: tk, what: `比高點低 ${ladderPct(level)} 以上：有論點，只觸發跌幅審查（不減半）` });
  }
  // 單筆變動夠大的訊號 → 當天通知（審查後持有、等月報的減半不走這裡：它在月報列成跌幅審查的項目）
  const pending: Record<string, OwnAction> = {};
  for (const [tk, m] of Object.entries(acct.own)) if (m.pending && m.slow.state !== 'WATCH') pending[tk] = m.pending.action;
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
    const plan = planDay({ cfg: acct.cfg, values, state: acct.rule, ownActions: { [tk]: act } });
    acct.rule = plan.state;
    acct.own[tk].pending = null;
    syncBuild(acct);
    const items = itemsFromPlan(acct, view, plan, values, { ownNotes: { [tk]: '' } });
    if (!items.length) continue;
    const n = newNotif(acct, view, { kind: 'URGENT', title: `${tk} 慢規則${act === 'REDUCE' ? '減半' : '加回'}`, items });
    n.preview = composeNotif(acct, view, n);
    created.push(n);
  }
  // 預設不下單的跌幅審查通知（§3.2）：2 個交易日沒有回覆就自動以「不動」結案，不提醒；審查還沒有結果（還在跑、還會重派）時先不結案
  for (const n of acct.notifs) {
    if (n.status !== 'PENDING' || !isHoldNotice(n) || view.i - n.seq < AUTO_DEFAULT_DAYS) continue;
    if (n.items.some((it) => !it.cancelled && !!it.ticker && dropReviewOpen(acct.own[it.ticker]?.dropReview))) continue;
    for (const it of n.items) {
      if (it.cancelled) continue;
      it.choice = 'SKIP';
      acct.shadow.push(thesisDropShadow(view, n, it, AUTO_DEFAULT_NOTE));
    }
    n.status = 'AUTO_DEFAULT';
    n.respondedAt = view.date;
    n.respondedSeq = view.i;
    log.push({ ticker: n.items.find((i) => !i.cancelled)?.ticker ?? '', what: `通知 #${n.id}（${n.title}）${AUTO_DEFAULT_DAYS} 個交易日沒有回覆，自動以「不動」結案` });
  }
  // 提醒：發出後 2 個交易日沒有回報（預設不下單的跌幅審查通知不提醒）
  for (const n of acct.notifs) {
    if (n.status === 'PENDING' && !n.reminded && n.items.length && n.kind !== 'INFO' && !isHoldNotice(n) && view.i - n.seq >= 2) {
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
    monthly: { order: input.order, excessVol: () => NaN, blocked, emptySlots: input.emptySlots, companyOf: companyOfInput(input) },
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
  const watch = Object.fromEntries(Object.entries(acct.watch ?? {}).map(([t, w]) => [t, clone({ lastListed: w.lastListed, ...(w.entry ? { entry: w.entry } : {}), ...(w.blocked ? { blocked: w.blocked } : {}) })]));
  return { rule: clone(acct.rule), own: clone(acct.own), owe: clone(acct.mom.owe), cash: acct.cash, ...(Object.keys(watch).length ? { watch } : {}) };
}

/**
 * 還原月報前的狀態（規則、自選、策略單的欠單）。2026-11-22 之前存的狀態：規則照 normRule 轉成現在的（拿掉崩盤、effPrev 只含波動度比例），
 * 核心的欠單（coreOwe）不還原（allocation_redesign §1.3、§1.5）。
 */
export function restoreSaved(acct: Account, before: SavedState): void {
  acct.rule = normRule(clone(before.rule));
  acct.own = clone(before.own);
  acct.mom.owe = clone(before.owe);
  delete acct.coreOwe;
  // 候補裡月報會改的欄位（上次列進月報、等月報的進場條件、沒提的原因）：還在候補名單裡的才還原，重算時進場項目照同一份輸入再列一次
  for (const [t, w0] of Object.entries(before.watch ?? {})) {
    const w = acct.watch?.[t];
    if (!w) continue;
    w.lastListed = w0.lastListed;
    if (w0.entry) w.entry = clone(w0.entry);
    else delete w.entry;
    if (w0.blocked) w.blocked = clone(w0.blocked);
    else delete w.blocked;
  }
}

/**
 * lazyFree：動能的比例回調這一次不受「搭便車」限制。只給這個函式自己用：第一次算出來有核心比例調回（F26）、而且有回調因為沒有其他單被撤回時，
 * 用它重算一次（F26 本身就是單，allocation_redesign §1.5）。
 */
export function monthlyReport(acct0: Account, view: MarketView, input: MonthlyContext, flow?: FlowInput, flowCashAlreadyIn = false, lazyFree = false): MonthlyResult {
  const acct = clone(acct0);
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
  const ownActions: Record<string, OwnAction> = {};
  const ownNotes: Record<string, string> = {};
  /** 審查後持有、審查判前提不成立、變動不到 5% 而等月報的減半（allocation_redesign §3.2）：不走規則引擎（狀態照做了才變），另外列成跌幅審查的項目。 */
  const watchReduce: Record<string, string> = {};
  for (const [tk, m] of Object.entries(acct.own)) {
    if (!m.pending) continue;
    const note = `（${m.pending.date} 觸發；這一筆不到總資產的 5%，所以併入月報）`;
    if (m.slow.state === 'WATCH') {
      if (m.pending.action === 'REDUCE') watchReduce[tk] = note;
      continue;
    }
    ownActions[tk] = m.pending.action;
    ownNotes[tk] = note;
  }
  const core = acct.cfg.coreTicker;
  const blocked = [...(input.vetoed ?? []), ...Object.keys(acct.mom.excluded), ...Object.keys(acct.mom.adopted)];
  // 依波動度減碼用訊號日的值（momentum_ai §3.11）：重算時用 input.excessVol；第一次產生時當場算、記下來
  const vol = volSource(view, input, core);
  const plan = planDay({
    cfg: lazyFree ? { ...acct.cfg, piggyback: false } : acct.cfg,
    values,
    state: acct.rule,
    ownActions,
    flow,
    monthly: {
      order: input.order,
      excessVol: vol.fn,
      blocked,
      owed: Object.keys(acct.mom.owe),
      emptySlots: input.emptySlots,
      companyOf: companyOfInput(input),
    },
  });
  acct.rule = plan.state;
  for (const tk of Object.keys(ownActions)) acct.own[tk].pending = null;
  syncBuild(acct);
  acct.mom.owe = {};
  let items = itemsFromPlan(acct, view, plan, values, { ownNotes, runIds: input.runIds });
  for (const [tk, note] of Object.entries(watchReduce)) {
    acct.own[tk].pending = null;
    items.push(thesisDropItem(acct, view, tk, note, acct.own[tk].reduceDd));
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
  // F28：你定的加碼條件成立（allocation_redesign §4.2，T84）：買進前的程式檢查過了才列，預設照做；沒過的寫在持股頁、不留到下個月（條件是一次性的）。
  // 同一檔同一個月只列一項（提高到 125% 優先）；這一項會讓先買一半結束的（BUILD_END），同一份月報不再列補滿（F27）
  const addBuild = new Set<string>();
  for (const [tk, m] of Object.entries(acct.own)) {
    const queued = [...(m.addMonthly ?? [])].sort((a, b) => (a.action === b.action ? 0 : a.action === 'RAISE' ? -1 : 1));
    delete m.addMonthly;
    for (const c of queued) {
      if (items.some((i) => i.f === 'F28' && i.ticker === tk)) {
        m.buyBlocked = { date: view.date, what: '加碼', text: '同一份月報已經列了這檔的另一條加碼條件', line: `你定的加碼條件「${c.text}」成立；同一份月報已經列了這檔的另一條加碼條件，這一條不另外列` };
        continue;
      }
      const it = addItem(acct, view, tk, c);
      if (!it) continue;
      items.push(it);
      if (it.choices[0].effects?.some((e) => e.type === 'BUILD_END')) addBuild.add(tk);
    }
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
    // 先買一半的補滿看財報後的審查（F27，allocation_redesign §4.1），AI 的「回到標準」不另外列
    if (tier === 'HOLD' || (tier === 'HALF' && state === 'HALF') || (tier === 'STANDARD' && (state === 'STD' || state === 'BUILD'))) continue;
    let sh = tierShares(acct, view, tk, tier, state);
    m.aiTier.suggest = false;
    if (!sh) continue;
    // 同一份月報已經列了你定的加碼條件（F28）：AI 的提高到 125% 不另外列（兩條路共用 12 個月的間隔，§4.3）
    if (tier === 'RAISE' && items.some((i) => i.f === 'F28' && i.ticker === tk)) continue;
    // 提高到 125%：買進前的程式檢查（allocation_redesign §4.0、§4.3）——沒過不列（持股頁寫原因），超過上限的部分砍掉
    let cutNote: string | null = null;
    if (tier === 'RAISE') {
      const v = buyCheck(acct, view, tk, view.date, sh);
      if (!v.ok) {
        m.buyBlocked = { date: view.date, what: '提高到 125%', text: v.why ?? '' };
        continue;
      }
      if (m.buyBlocked?.what === '提高到 125%') delete m.buyBlocked;
      sh = v.shares;
      cutNote = v.cut ? v.why : null;
    }
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
        ...(cutNote ? { note: cutNote } : {}),
        ...(m.aiTier.runId ? { runIds: [m.aiTier.runId] } : {}),
      }),
    );
  }
  // F27：先買一半的補滿（allocation_redesign §4.1）：開檔後第一份財報的審查過關、買進前的程式檢查也過了 → 列一項，預設照做
  for (const tk of Object.keys(acct.own)) {
    if (addBuild.has(tk)) continue;
    const it = fillItem(acct, view, tk);
    if (it) items.push(it);
  }
  // F29：候補進場（allocation_redesign §4.5）：進場條件成立、程式檢查過了 → 列一項，預設照做；沒過的寫在候補那一塊，下個月再看
  expireWatchEntries(acct, view.date);
  for (const t of new Set([...(input.watchEntries ?? []).map((e) => e.ticker), ...Object.entries(acct.watch ?? {}).filter(([, w]) => w.entry?.length).map(([t]) => t)])) {
    const it = watchEntryItem(acct, view, input.watchEntries?.find((e) => e.ticker === t) ?? null, t);
    if (it) items.push(it);
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
  // 崩盤切換的項目也取消（T39b）；策略項目在產生這份之前已經照「這次不做」記成欠單（owePendingMonthly），這份照實際持股重列。
  // 核心比例調回（F26）也取消：這份月報照現在的持股重算（allocation_redesign §1.3）。
  for (const old of acct.notifs) {
    if (old.status !== 'PENDING' || old.kind !== 'MONTHLY') continue;
    for (const it of old.items) {
      if (it.cancelled || (it.kind !== 'STRATEGY' && it.kind !== 'CORE_BAND' && it.f !== 'F11')) continue;
      it.cancelled = true;
      it.note = `上一份月報沒有回覆，這一項以 ${input.month} 月報為準`;
    }
    if (old.items.every((i) => i.cancelled)) {
      old.status = 'SUPERSEDED';
      old.coreAbsorb = false;
    }
  }
  // 核心比例的界線檢查（allocation_redesign §1.3）：其他單照預設選項合成之後算；超出界線加一項 F26（可以是這份月報唯一的一項）。
  // 帳上的閒置現金不再單獨成一項（§1.2：現金算短債那一邊；有其他單時合成的清單順便加一行買短債）
  const probe: Notif = { id: 0, kind: 'MONTHLY', date: view.date, seq: view.i, title: '', items, status: 'PENDING', coreAbsorb: true, reminded: false, ...(flow?.kind === '入金' ? { deposit: flow.amount } : {}) };
  const band = coreBandItem(acct, view, composeNotif(acct, view, probe));
  if (band.item && !lazyFree && plan.events.some((e) => e.kind === 'LAZY_SKIPPED')) {
    // 有回調因為「沒有其他單」被撤回，但 F26 本身就是單（§1.5）：這一次不受搭便車限制，重算；重算後還要調回才採用
    const alt = monthlyReport(acct0, view, input, flow, flowCashAlreadyIn, true);
    if (alt.notif.items.some((i) => i.f === 'F26')) return alt;
  }
  if (band.item) {
    // 核心價格和基準對不上（core_ai §3.10；T86 P14）：F26 的股數就是照這個價格算的，項目上也寫一句
    if (input.coreNote) band.item.note = [band.item.note, input.coreNote].filter(Boolean).join('；');
    items.push(band.item);
  }
  const coreBand = { s: band.check.s, bond: band.check.bond, core: band.check.core };
  // 狀態文字（allocation_redesign §1.6）：核心比例；崩盤規則已經退場
  const status = `${coreStatusText(acct, band.check, !!band.item)}；動能部位${thirdLabel(acct.rule.volW ?? 1) === '1' ? '全額' : ` ${thirdLabel(acct.rule.volW ?? 1)}`}` + (input.paused ? `；本月暫停換股（${input.paused}），動能名單不變` : '');
  const notif = newNotif(acct, view, {
    kind: items.length ? 'MONTHLY' : 'MONTHLY_EMPTY',
    title: items.length ? `${input.month} 月報` : `${input.month} 月報：本月不用動`,
    text: status,
    items,
    coreAbsorb: items.length > 0,
    monthly: { input: { ...vol.record(input), coreBand }, before },
    deposit: flow?.kind === '入金' ? flow.amount : undefined,
    // 「要看的事」：「本月不用動」的月報也列（own_thesis §3.6.6）
    ...(input.attention?.length ? { attention: clone(input.attention) } : {}),
  });
  // 補滿列在哪一則月報（還沒回覆時下一份月報不重列）
  for (const it of items) if (it.f === 'F27' && it.ticker && acct.own[it.ticker]?.build) acct.own[it.ticker].build!.listed = notif.id;
  // 不屬於任何項目的 AI 執行：被否決的代號（F1）。F20 的說明 T32d 拿掉（momentum_ai §3.6），不再接在狀態文字後面
  syncRunIds(notif, (input.vetoed ?? []).map((t) => input.runIds?.entry?.[t]));
  notif.preview = composeNotif(acct, view, notif);
  return { acct, notif, plan };
}

/**
 * 上一份月報一直沒回覆（T39b 第 4 項）：新的月報只從實際持股算動能每一格與核心吸收的差額，但只在「這個月有理由」時才把一格拉回目標——
 * 新進場、比例格子變了、欠單；其他只靠 ±50% 的回調（而且要搭便車，當天沒有別的單就撤回）。舊月報的進場（F1）、依波動度減碼（F4）、
 * 崩盤切換（F5／F6，含重列的）在下個月都不是「這個月的理由」，所以新月報不會自己涵蓋（探測測試：T39b ④ 延伸）。
 * 做法和那一項選「這次不做」相同（§2.3.1）：策略項目動能那幾檔記進 mom.owe。
 * 接下來的規則照實際持股重列（策略單補做 F17）；舊的那幾項在 monthlyReport 後面以新月報為準取消。
 * 在 savedState 之前做：入金併進月報、排除重算時還原的狀態裡有這些欠單，重算時照樣重列。
 * 2026-11-22 起（allocation_redesign §1.3、§1.5）：舊月報的崩盤項目（F5／F6）不記欠單（規則已經退場）；核心比例調回（F26）也不記，新月報重算。
 */
function owePendingMonthly(acct: Account): void {
  for (const old of acct.notifs) {
    if (old.status !== 'PENDING' || old.kind !== 'MONTHLY') continue;
    for (const it of old.items) {
      if (it.cancelled || it.kind !== 'STRATEGY' || it.f === 'F5' || it.f === 'F6') continue;
      const lines = it.choices.find((c) => c.id === it.ruleChoice)?.lines ?? [];
      for (const l of lines) if (l.bucket === 'mom' && l.shares) acct.mom.owe[l.ticker] = { since: old.date, notif: old.id };
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
  // 有前提被 3 票判不成立：記下日期，30 個日曆天內不提買進（buyAllowed，allocation_redesign §4.0）；之後的審查蓋掉 aiTier 也留著
  if (acct.own[ticker] && extra?.premiseId && !(acct.own[ticker].brokenAt && acct.own[ticker].brokenAt! > date)) acct.own[ticker].brokenAt = date;
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

/** 策略檢討提醒的固定說明（allocation_redesign §2.3）：動能沒有「大盤跌就撤」的規則，帳戶的緩衝是核心的 SGOV。 */
export const STRATEGY_COST_NOTE = `動能沒有「大盤跌就撤」的規則；整個帳戶的緩衝是核心的 SGOV。`;

/** F21：策略檢討提醒（不附清單的提醒，設計 §2.5 的例外；永不自動停用）。 */
export function strategyReminder(acct0: Account, view: MarketView, text: string): { acct: Account; notif: Notif } {
  const acct = clone(acct0);
  const notif = newNotif(acct, view, { kind: 'INFO', title: '策略檢討提醒', text: `${text}。系統不會自動停用策略；AI 會逐條列出前提的正反證據（不給停用或繼續的建議），報告在網站。${STRATEGY_COST_NOTE}`, coreAbsorb: false });
  return { acct, notif };
}

// ---------------------------------------------------------------- 先買一半，確認後補滿（allocation_redesign §4.1，T83）

/** 開檔後幾份財報的審查都沒過關、或滿幾個日曆天還沒過關 → 「要看的事」與持股頁的兩個按鈕（§4.1）。 */
export const BUILD_MAX_EARNINGS = 2;
export const BUILD_MAX_DAYS = 200;

/** 先買一半拖太久了嗎（還沒過關，而且兩份財報都沒過、或開檔滿 200 個日曆天）。不是先買一半是 false。 */
export function buildStale(meta: Pick<OwnMeta, 'build'>, date: string): boolean {
  const b = meta.build;
  if (!b || b.ok) return false;
  return b.misses >= BUILD_MAX_EARNINGS || (!!b.since && calDays(b.since, date) >= BUILD_MAX_DAYS);
}

/**
 * 離開先買一半（直接改傳進來的帳戶）：keep = false 目標回到標準比重；keep = true 標準比重改成現在的實際比重（不超過單檔上限 15%）。
 * 慢規則狀態：先買一半 → 標準；在審查後持有的留著（目標變成標準比重）；已經減半的不動。
 */
export function clearBuild(acct: Account, view: MarketView, ticker: string, keep: boolean): void {
  const meta = acct.own[ticker];
  const rule = acct.rule.own[ticker];
  if (!meta || !rule || !meta.build) return;
  delete meta.build;
  delete meta.buildAsk;
  if (meta.slow.state === 'BUILD') meta.slow = { ...meta.slow, state: 'STD' };
  if (rule.applied === 'BUILD') setApplied(rule, 'STD');
  if (keep) {
    const total = totalValue(acct, view);
    const w = total > 0 ? ((acct.lots.own[ticker] ?? 0) * priceOf(view, ticker)) / total : 0;
    if (w > 0) rule.stdWeight = Math.min(acct.cfg.ownCapHi, w);
  }
}

/** 規則引擎把先買一半的股票減半了（目標已經是 HALF，§4.1「減半的話賣掉一半的一半，並離開 BUILD」）：先買一半的紀錄拿掉。 */
function syncBuild(acct: Account): void {
  for (const [tk, m] of Object.entries(acct.own)) {
    if (m.build && acct.rule.own[tk]?.applied === 'HALF') {
      delete m.build;
      delete m.buildAsk;
    }
  }
}

/**
 * 月報的補滿（F27，§4.1）：開檔後第一份財報的審查過關（build.ok）→ 補到標準比重，預設照做；照做或不做之後都離開先買一半（BUILD_END）。
 *   已經列在還沒回覆（或決定了還沒填快照）的月報 → 不重列
 *   現在已經到標準比重（沒有要買的）→ 直接離開先買一半，不列（目標本來就該是標準比重；不用下單）
 *   買進前的程式檢查（buyAllowed，§4.0）沒過 → 不列，OwnMeta.buyBlocked 記原因（持股頁那一行），下個月再試；超過上限的部分砍掉
 * 直接改傳進來的帳戶（blocked、離開先買一半）。
 */
export function fillItem(acct: Account, view: MarketView, ticker: string): Item | null {
  const meta = acct.own[ticker];
  const rule = acct.rule.own[ticker];
  const b = meta?.build;
  if (!meta || !rule || !b?.ok) return null;
  if (b.listed && acct.notifs.some((n) => n.id === b.listed && (n.status === 'PENDING' || n.status === 'RESPONDED') && n.items.some((i) => i.f === 'F27' && i.ticker === ticker && !i.cancelled))) return null;
  const px = priceOf(view, ticker);
  const cur = acct.lots.own[ticker] ?? 0;
  const want = Math.floor((rule.stdWeight * totalValue(acct, view)) / px + 1e-9) - cur;
  if (want <= 0) {
    clearBuild(acct, view, ticker, false);
    return null;
  }
  const v = buyCheck(acct, view, ticker, view.date, want);
  if (!v.ok) {
    meta.buyBlocked = { date: view.date, what: '補滿', text: v.why ?? '' };
    return null;
  }
  if (meta.buyBlocked?.what === '補滿') delete meta.buyBlocked;
  return makeItem({
    f: 'F27',
    kind: 'OWN_FILL',
    ticker,
    title: `${ticker}：先買的一半已確認（${b.ok.text}）→ 補滿到標準比重，買 ${v.shares} 股`,
    why: b.ok.cond
      ? '你開檔時選了先買一半、確認後再補滿；你另外定的加碼條件成立，和開檔之後第一份財報過關一樣算確認（兩者先到的算）。這是你事先定的，預設照做；不做的話標準比重改成現在的比重，之後不再提。'
      : '你開檔時選了先買一半、確認後再補滿；確認的條件是開檔之後的第一份財報過關。這是你事先定的，預設照做；不做的話標準比重改成現在的比重，之後不再提。',
    choices: [
      { id: 'RULE', label: `照做：補滿，買 ${v.shares} 股`, // T86 P12c：原因寫「自選補滿」（原本「自選訊號」，LINE 上看不出是先買一半的補滿）
        lines: [{ ticker, bucket: 'own', shares: v.shares, reason: '自選補滿' }], effects: [{ type: 'BUILD_END', ticker, keep: false }] },
      { id: 'SKIP', label: '這次不做（維持現在的大小）', lines: [], effects: [{ type: 'BUILD_END', ticker, keep: true }] },
    ],
    choice: 'RULE',
    ruleChoice: 'RULE',
    ...(v.cut && v.why ? { note: v.why } : {}),
    ...(b.ok.runId ? { runIds: [b.ok.runId] } : {}),
  });
}

/**
 * 月報的你定的加碼條件（F28，allocation_redesign §4.2，T84）：成立時的動作是補到標準比重（FILL）或提高到標準的 125%（RAISE）。預設照做、不做不用理由。
 *   減半中 → 不列，持股頁寫「條件成立；這檔在減半中，加回看 200 日線」（減半是價格底線或論點出問題造成的，加回只看 §3.4）
 *   RAISE：和 125% 共用 12 個月的間隔（沒滿 → 不列）；先買一半的股票直接提高到 125%（照做時先離開先買一半、再提高：你定的條件就是確認）
 *   FILL：補到標準比重（先買一半的在條件成立時就當成確認、走 F27；這裡還是先買一半的，照做時一樣離開先買一半）
 *   不用買（已經到那個比例）→ 不列；買進前的程式檢查（§4.0）沒過 → 不列；兩種都寫持股頁（OwnMeta.buyBlocked），不留到下個月
 * 直接改傳進來的帳戶（buyBlocked）。
 */
export function addItem(acct: Account, view: MarketView, ticker: string, c: AddNotice): Item | null {
  const meta = acct.own[ticker];
  const rule = acct.rule.own[ticker];
  if (!meta || !rule) return null;
  const goal = c.action === 'RAISE' ? '提高到標準的 125%' : '補到標準比重';
  const block = (text: string, line?: string): null => {
    meta.buyBlocked = { date: view.date, what: '加碼', text, ...(line ? { line } : {}) };
    return null;
  };
  if (meta.slow.state === 'HALF' || rule.applied === 'HALF') return block('這檔在減半中', `你定的加碼條件「${c.text}」成立；這檔在減半中，加回看 200 日線`);
  if (c.action === 'RAISE') {
    const gap = raiseGapWhy(meta, view.date);
    if (gap) return block(`${gap}（和 AI 提的 125% 共用間隔）`);
  }
  const build = !!meta.build && rule.applied === 'BUILD';
  const level = c.action === 'RAISE' ? '標準的 125%' : '標準比重';
  const want = Math.floor((rule.stdWeight * (c.action === 'RAISE' ? 1.25 : 1) * totalValue(acct, view)) / priceOf(view, ticker) + 1e-9) - (acct.lots.own[ticker] ?? 0);
  if (want <= 0) return block(`現在的持股已經到${level}`, `你定的加碼條件「${c.text}」成立；現在的持股已經到${level}，不用買`);
  const v = buyCheck(acct, view, ticker, view.date, want);
  if (!v.ok) return block(v.why ?? '買進前的程式檢查沒過');
  if (meta.buyBlocked?.what === '加碼') delete meta.buyBlocked;
  const effects: Effect[] = [...(build ? [{ type: 'BUILD_END', ticker, keep: false } as Effect] : []), ...(c.action === 'RAISE' ? [{ type: 'APPLY_TIER', ticker, tier: 'RAISE' } as Effect] : [])];
  return makeItem({
    f: 'F28',
    kind: 'OWN_ADD',
    ticker,
    title: `${ticker}：你在 ${c.setAt} 定的加碼條件「${c.text}」成立 → ${goal}，買 ${v.shares} 股`,
    why: `${c.why}。這是你事先定的，預設照做；不做不用寫理由（不買沒有風險要記），這條條件已經用掉，要再用就重新定一條。${c.action === 'RAISE' ? '提高之後標準比重變成原本的 1.25 倍，和 AI 提的 125% 共用 12 個月的間隔。' : ''}${build ? '這檔還在先買一半：照做就當成確認，一起離開先買一半。' : ''}`,
    choices: [
      { id: 'DO', label: `照做：${goal}，買 ${v.shares} 股`, ...(c.action === 'RAISE' ? { tier: 'RAISE' as Tier } : {}), lines: [{ ticker, bucket: 'own', shares: v.shares, reason: '你定的加碼條件' }], ...(effects.length ? { effects } : {}) },
      { id: 'SKIP', label: '這次不做', lines: [] },
    ],
    choice: 'DO',
    ruleChoice: 'DO',
    ...(v.cut && v.why ? { note: v.why } : {}),
    ...(c.runIds?.length ? { runIds: [...c.runIds] } : {}),
  });
}

/**
 * 開檔後一份財報的審查結果（§4.1 的確認條件；app 層判好 pass）：
 *   過關 → build.ok（下一份月報列補滿）
 *   沒過關（沒有一致結論、資料缺漏、有前提被判不成立）→ misses + 1，last 記原因；等下一份財報。有前提被判不成立的另外走乙類，先買一半留著
 * 已經過關、或不是先買一半 → 原樣回傳。
 */
export function buildEarnings(acct0: Account, ticker: string, r: { date: string; runId?: string; pass: boolean; text: string }): Account {
  const b0 = acct0.own[ticker]?.build;
  if (!b0 || b0.ok) return acct0;
  const acct = clone(acct0);
  const b = acct.own[ticker].build!;
  if (r.pass) {
    b.ok = { date: r.date, ...(r.runId ? { runId: r.runId } : {}), text: r.text };
    delete b.last;
  } else {
    b.misses = (b.misses ?? 0) + 1;
    b.last = { date: r.date, text: r.text };
  }
  return acct;
}

/** 記下這次財報後審查有沒有證實前提（提高到 125% 的門檻，§4.3）：只留最近兩筆。 */
export function recordEarnCheck(acct0: Account, ticker: string, c: { date: string; runId?: string; confirmed: boolean; why: string }): Account {
  if (!acct0.own[ticker]) return acct0;
  const acct = clone(acct0);
  const m = acct.own[ticker];
  m.earnChecks = [...(m.earnChecks ?? []).filter((x) => x.date !== c.date || x.runId !== c.runId), { date: c.date, ...(c.runId ? { runId: c.runId } : {}), confirmed: c.confirmed, why: c.why }].slice(-2);
  return acct;
}

// ---------------------------------------------------------------- 候補進場（F29，allocation_redesign §4.5，T85 乙段）

const plusDaysOf = (d: string, n: number) => new Date(Date.parse(d) + n * 86400_000).toISOString().slice(0, 10);

/** 成立超過 100 個日曆天還沒列進月報的非價格進場條件：丟掉，候補那一塊寫「要再用就重新定」（§4.5 第 16 點）。直接改傳進來的帳戶。 */
export function expireWatchEntries(acct: Account, date: string): void {
  for (const w of Object.values(acct.watch ?? {})) {
    const old = (w.entry ?? []).filter((x) => calDays(x.metOn, date) > WATCH_ENTRY_EXPIRE_DAYS);
    if (!old.length) continue;
    w.entry = (w.entry ?? []).filter((x) => !old.includes(x));
    if (!w.entry.length) delete w.entry;
    w.blocked = { date, text: `進場條件「${old[0].text}」${mdOf(old[0].metOn)} 成立，超過 ${WATCH_ENTRY_EXPIRE_DAYS} 天都沒能列進月報，已經丟掉；要再用就重新定一條。` };
  }
}

/** 候補進場買幾股（先買一半）：floor(標準比重 × 0.5 × 總資產 ÷ 價格)。 */
export const watchEntryWant = (acct: Account, view: MarketView, ticker: string, std: number): number => Math.floor((std * 0.5 * totalValue(acct, view)) / priceOf(view, ticker) + 1e-9);

/**
 * 月報的候補進場（F29，§4.5 第 13～16 點）：這檔候補有成立的進場條件（e.conds：訊號日收盤仍成立的價格條件；加上 watch.entry：成立後等月報的非價格條件）
 * → 先買一半，預設照做、不做不用理由。以下任何一項不過就不列，原因寫在候補那一塊（watch.blocked），**留到下個月再看**（進場條件是唯一的入口）：
 *   自選的比例是 0%；訊號日沒有收盤價；距上次列進月報不到 90 個日曆天；這個月的進場前檢查沒有跑（e 是 null）；申報清單抓不到；
 *   規則偵測到硬傷；你定的財報類出場條件已經成立；買進前的程式檢查（§4.0：30 天內前提被判不成立、跨桶上限砍到 0、算不到 1 股）
 * 列了：lastListed = 這份月報的訊號日，watch.entry 清掉（同一份月報同一檔只列一項，其他成立的在說明裡帶過、一起算用掉）。
 * 這一行是 bucket own，但 rule.own 還沒有這檔：照做、快照的自選桶有股數才轉成持股（選項的 WATCH_ENTER 效果）。直接改傳進來的帳戶。
 */
export function watchEntryItem(acct: Account, view: MarketView, e: WatchEntryInput | null, ticker: string): Item | null {
  const w: WatchMeta | undefined = acct.watch?.[ticker];
  if (!w || acct.own[ticker]) return null;
  const seen = new Set((e?.conds ?? []).map((c) => c.id));
  const conds = [...(e?.conds ?? []), ...(w.entry ?? []).filter((x) => !seen.has(x.id)).map((x) => ({ id: x.id, text: x.text, setAt: x.setAt, why: x.why, price: false }))];
  if (!conds.length) return null;
  const c0 = conds[0];
  const block = (reason: string): null => {
    w.blocked = { date: view.date, text: `進場條件「${c0.text}」成立，但${/^[0-9A-Za-z]/.test(reason) ? ' ' : ''}${reason}，這個月不提進場；下個月月報再看一次。` };
    return null;
  };
  if (!(acct.cfg.ratio.own > 0)) return block('自選的比例是 0%');
  const c = view.close[ticker];
  if (!c || !Number.isFinite(c[view.i]) || !(c[view.i] > 0)) return block(`${mdOf(view.date)} 沒有它的收盤價`);
  if (w.lastListed && w.lastListed < view.date && calDays(w.lastListed, view.date) < WATCH_LIST_GAP_DAYS)
    return block(`${mdOf(w.lastListed)} 的月報已經列過這檔的進場（每 ${WATCH_LIST_GAP_DAYS} 天最多列一次，${mdOf(plusDaysOf(w.lastListed, WATCH_LIST_GAP_DAYS))} 之後才會再列）`);
  if (!e) return block('這個月的進場前檢查（申報、財報類出場條件）沒有跑成');
  if (e.noFilings) return block(`申報清單抓不到（${e.noFilings}），沒辦法檢查有沒有硬傷`);
  if (e.hard) return block(`規則偵測到硬傷（${e.hard}）`);
  if (e.exitMet) return block(`你定的財報類出場條件已經成立（${e.exitMet}）`);
  const rec = w.stdWeight === null ? watchRecWeight(acct, view, ticker) : null;
  const std = w.stdWeight ?? rec;
  if (!std || !(std > 0)) return block('算不出推薦的標準比重（到候補那一塊填一個比重）');
  const want = watchEntryWant(acct, view, ticker, std);
  if (want <= 0) return block(`照標準比重 ${pct1(std)} 的一半算不到 1 股`);
  const v = buyAllowed(watchBuyFacts(acct, view, ticker, view.date, want));
  if (!v.ok) return block(v.why ?? '買進前的程式檢查沒過');
  const dd = drawdownFromHigh(c, view.i, SLOW.highDays);
  // 只有預設前提、已經比高點低 20% 以上：照 §4.1 既有規則從減半開始（目標一樣是標準的一半，補回看 200 日線）；有論點的先買一半、之後照 §3 審查
  const half = defaultOnly(w) && dd <= SLOW.drawdown;
  const total = totalValue(acct, view);
  const ownShare = total > 0 ? bucketValue(acct, view, 'own') / total : 0;
  const others = conds.slice(1);
  const notes = [
    others.length ? `另外成立的進場條件：${others.map((x) => `「${x.text}」`).join('、')}（一起算用掉）` : '',
    rec !== null ? `比重你留空，用今天的推薦值 ${pct1(std)}` : '',
    ownShare > acct.cfg.ratio.own + 1e-9 ? `自選目前占 ${pct0(ownShare)}（預算 ${pct0(acct.cfg.ratio.own)}）` : '',
    v.cut && v.why ? v.why : '',
  ].filter(Boolean);
  w.lastListed = view.date;
  delete w.blocked;
  delete w.entry;
  const cids = conds.map((x) => x.id);
  return makeItem({
    f: 'F29',
    kind: 'WATCH_ENTRY',
    ticker,
    title: `候補 ${ticker}：你在 ${c0.setAt} 定的進場條件「${c0.text}」成立${Number.isFinite(dd) && dd < -0.0005 ? `（現在比 52 週高點低 ${(-dd * 100).toFixed(1)}%）` : ''} → 先買一半：買 ${v.shares} 股（標準比重 ${pct1(std)}，錢從核心拿）${half ? '；只有預設前提、已經比高點低 20% 以上，進場後從減半開始' : ''}`,
    why: `${c0.why}。這是你事先定的，預設照做；不做不用寫理由（不買沒有風險要記），這條進場條件已經用掉，候補留著，要再等就重新定條件。照做、在快照的自選桶填了股數之後，候補轉成持股，論點沿用；${half ? '這檔只有系統預設前提、已經比高點低 20% 以上，所以從減半開始（目標一樣是標準比重的一半），補回看 200 日線。' : '先買標準比重的一半，開始持有之後第一份財報過關再補滿。'}同一檔的進場項目每 ${WATCH_LIST_GAP_DAYS} 天最多列一次。`,
    choices: [
      { id: 'DO', label: `照做：先買一半，買 ${v.shares} 股`, lines: [{ ticker, bucket: 'own', shares: v.shares, reason: '候補進場' }], effects: [{ type: 'WATCH_ENTER', ticker, std, ...(half ? { half: true } : {}), conds: cids }] },
      { id: 'SKIP', label: '這次不做', lines: [] },
    ],
    choice: 'DO',
    ruleChoice: 'DO',
    ...(notes.length ? { note: notes.join('；') } : {}),
    watchEntry: { std, recUsed: rec !== null, conds: conds.map((x) => ({ id: x.id, price: x.price })), fromHigh: Number.isFinite(dd) ? dd : null, half, wouldBuy: e.wouldBuy ?? null },
  });
}
