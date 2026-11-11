// 帳戶狀態（可序列化）與共用的小工具。帳本是快照式的（設計 §2.1.1）：
// 使用者填每檔股數與現金，系統把兩份快照的差異拆成事件、分到各桶。
// 這裡的函式都是純函式：輸入狀態與市場資料，回傳新的狀態。
import { annualizedVol, drawdownFromHigh } from './indicators';
import type { OrderLine, Composed } from './orders';
import { initialSlowState, initialStateForNewPick, type SlowRuleState } from './slowRule';
import { CASH, DEFAULT_CONFIG, cellKey, emptyRuleState, type CellMap, type EngineConfig, type OwnAction, type RuleState } from './types';

/** AI 的固定檔位（設計 §0）。HALF 原稱「標準的一半」，2026-11-11 起和規則的「減半」是同一個動作。 */
export type Tier = 'EXIT' | 'HALF' | 'HOLD' | 'STANDARD' | 'RAISE';
export const TIER_NAME: Record<Tier, string> = { EXIT: '出清', HALF: '減半', HOLD: '不動', STANDARD: '回到標準', RAISE: '提高到標準的 125%' };

export interface Premise {
  id: string;
  text: string;
  origin: 'USER' | 'AI_DRAFT_ACCEPTED' | 'SYSTEM_DEFAULT';
  breaksIf?: string;
}

export const SYSTEM_DEFAULT_PREMISES: Premise[] = [
  { id: 'P1', text: '沒有硬事件（重編、換會計師、被收購、重大監管）', origin: 'SYSTEM_DEFAULT' },
  { id: 'P2', text: '營收年增率沒有連兩季轉負', origin: 'SYSTEM_DEFAULT' },
  { id: 'P3', text: '稀釋 EPS 沒有連兩季年減', origin: 'SYSTEM_DEFAULT' },
  { id: 'P4', text: '慢規則本身（距高點 -20% 減半）', origin: 'SYSTEM_DEFAULT' },
];

export interface OwnMeta {
  /** 慢規則狀態機（每天收盤後前進）。 */
  slow: SlowRuleState;
  /** 已觸發、還沒列進清單的訊號（變動 < 5%，等月報）。 */
  pending: { action: OwnAction; date: string } | null;
  r1: boolean | null;
  premises: Premise[];
  origin: 'INITIAL' | 'NEW' | 'TRANSFER' | 'ADOPT' | 'MANUAL';
  /** 最近一次 F24 的檔位（AI 層給的輸入）。suggest = 3 票一致、和目前不同、有通過檢查的證據 → 月報並列。 */
  aiTier: { tier: Tier; date: string; runId?: string; suggest: boolean } | null;
  raisedAt: string | null;
  /** 未解除的硬事件標記。 */
  flags: string[];
  /** 每個月已發幾則 F25 當天通知。 */
  f25Sent: Record<string, number>;
}

export interface Lots {
  own: Record<string, number>;
  mom: Record<string, number>;
  core: Record<string, number>;
  /** 快照出現、還沒分類的變動（設計 §2.1.1：標記之前月報不下單）。 */
  unc: Record<string, number>;
}

export type ItemKind = 'STRATEGY' | 'OWN_RULE' | 'AI_ONLY' | 'HARD' | 'CASHFLOW' | 'FIX';
export type ChoiceId = 'RULE' | 'AI' | 'DO' | 'SKIP';

/** 清單上的選項做完之後，帳戶狀態要跟著改的事（存成資料，不存函式）。 */
export type Effect =
  | { type: 'APPLY_TIER'; ticker: string; tier: Tier }
  | { type: 'REMOVE_OWN'; ticker: string }
  | { type: 'CLEAR_FLAG'; ticker: string };

export interface Choice {
  id: ChoiceId;
  label: string;
  lines: OrderLine[];
  tier?: Tier;
  effects?: Effect[];
}

export interface Item {
  key: string;
  /** 觸發功能編號（設計 §2.0），例如 F7。 */
  f: string;
  kind: ItemKind;
  ticker?: string;
  title: string;
  choices: Choice[];
  /** 目前選的選項。 */
  choice: ChoiceId;
  /** 規則的選項（影子組合的「照規則」那條線）。規則沒有動作時是 SKIP。 */
  ruleChoice: ChoiceId;
  /** 給 LINE 顯示的一行 AI 說明。 */
  aiLine?: string;
  /** 這一項可以做的額外動作。 */
  actions?: ('TRANSFER' | 'EXCLUDE' | 'ADOPT')[];
  cancelled?: boolean;
  note?: string;
  why?: string;
}

export type NotifKind = 'MONTHLY' | 'MONTHLY_EMPTY' | 'URGENT' | 'CASHFLOW' | 'FIX' | 'INFO' | 'CLASSIFY' | 'CASH_DIFF';
export type NotifStatus = 'PENDING' | 'RESPONDED' | 'DONE' | 'SKIPPED' | 'READ' | 'SUPERSEDED';

export interface FollowUp {
  ticker: string;
  listed: number;
  done: number;
}

export interface Notif {
  id: number;
  kind: NotifKind;
  /** 訊號日（清單用這一天的收盤換算股數）。 */
  date: string;
  /** 訊號日的交易日序號。 */
  seq: number;
  title: string;
  text?: string;
  items: Item[];
  status: NotifStatus;
  /** 是否由核心吸收差額。 */
  coreAbsorb: boolean;
  /** 出金：做完清單後要轉出的金額。 */
  withdraw?: number;
  deposit?: number;
  reminded: boolean;
  /** 產生時照預設選項合成的清單。 */
  preview?: Composed;
  /** 回覆時合成的清單（之後和快照比對）。 */
  composed?: Composed;
  respondedAt?: string;
  followUp?: FollowUp[];
  followUpOpen?: boolean;
  /** CLASSIFY：哪一檔、變動幾股。CASH_DIFF：金額。 */
  ticker?: string;
  quantity?: number;
  amount?: number;
  /** 月報：重算用的輸入與月報前的狀態（排除、入金合併時重算）。 */
  monthly?: { input: MonthlyContext; before: SavedState };
  ref?: number;
  note?: string;
}

/** 月報需要、引擎自己算不出來的輸入。 */
export interface MonthlyContext {
  /** 股票池照動能排名由高到低的代號。 */
  order: string[];
  /** 本月被任務 A 否決的代號。 */
  vetoed?: string[];
  /** 遞補者也被否決、留在核心到下個月的格數（設計 §2.4）。 */
  emptySlots?: number;
  /** 月份標籤，例如 2026-12。 */
  month: string;
  /** 崩盤規則切換時 AI 檢視的一行意見（只顯示，設計 §4.4）。 */
  crashOpinion?: '照做' | '延後';
}

export interface SavedState {
  rule: RuleState;
  own: Record<string, OwnMeta>;
  owe: Account['mom']['owe'];
  cash: number;
}

export interface ShadowRecord {
  date: string;
  f: string;
  ticker: string | null;
  title: string;
  /** 照規則、照 AI、使用者實際的股數變動。 */
  rule: number;
  ai: number | null;
  actual: number;
  price: number;
  choice: string;
  note?: string;
}

export type LedgerEventKind = 'TRADE' | 'TRANSFER' | 'DEPOSIT' | 'WITHDRAW' | 'DIVIDEND' | 'CASH_OTHER' | 'UNCLASSIFIED' | 'CLASSIFIED';
export interface LedgerEvent {
  date: string;
  kind: LedgerEventKind;
  ticker?: string;
  bucket?: string;
  shares?: number;
  amount?: number;
  reason?: string;
  notif?: number;
}

export interface Account {
  cfg: EngineConfig;
  /** 短期美債 ETF（崩盤規則啟動時核心的現金去處）。 */
  bondTicker: string;
  /** 紙上交易（流程全跑，帳本標記為紙上）。 */
  paper: boolean;
  cash: number;
  lots: Lots;
  rule: RuleState;
  own: Record<string, OwnMeta>;
  mom: {
    excluded: Record<string, { reason: string; date: string }>;
    adopted: Record<string, { reason: string; date: string }>;
    /** 策略單沒照做，下個月要再列（設計 §2.3.1）。 */
    owe: Record<string, { since: string; notif: number }>;
  };
  notifs: Notif[];
  nextId: number;
  shadow: ShadowRecord[];
  events: LedgerEvent[];
  /** 單位數：每一桶像一檔基金，入金買單位、出金贖單位（設計 §2.1.1）。 */
  units: { total: number; own: number; mom: number; core: number };
  /** 有未分類的變動，月報暫停中。 */
  monthlyBlocked: boolean;
  /** 上一份快照的日期。 */
  snapshotDate: string | null;
}

/** 市場資料：到訊號日為止的收盤（所有代號對齊同一組交易日）。i 是訊號日的位置。 */
export interface MarketView {
  date: string;
  i: number;
  close: Record<string, ArrayLike<number>>;
  /** 算超額波動用的基準；預設用核心 ETF。 */
  benchmark?: string;
}

export function priceOf(view: MarketView, ticker: string): number {
  if (ticker === CASH) return 1;
  const c = view.close[ticker];
  if (!c) throw new Error(`沒有 ${ticker} 的價格`);
  const p = c[view.i];
  if (!Number.isFinite(p)) throw new Error(`${ticker} 在 ${view.date} 沒有價格`);
  return p;
}

export function clone<T>(x: T): T {
  return structuredClone(x);
}

/** 每一格的股數（給 planToLines 用）。 */
export function shareCells(acct: Account): Record<string, number> {
  const out: Record<string, number> = {};
  for (const b of ['own', 'mom'] as const) for (const [t, n] of Object.entries(acct.lots[b])) if (n) out[cellKey(b, t)] = n;
  const v = acct.lots.core[acct.cfg.coreTicker];
  if (v) out[cellKey('core', acct.cfg.coreTicker)] = v;
  return out;
}

/** 每一格的市值。核心的現金格 = 短債 ETF ＋ 帳上現金。 */
export function cellValues(acct: Account, view: MarketView): CellMap {
  const out: CellMap = {};
  for (const b of ['own', 'mom'] as const) {
    for (const [t, n] of Object.entries(acct.lots[b])) if (n) out[cellKey(b, t)] = n * priceOf(view, t);
  }
  for (const [t, n] of Object.entries(acct.lots.core)) {
    if (!n) continue;
    const k = t === acct.cfg.coreTicker ? cellKey('core', t) : cellKey('core', CASH);
    out[k] = (out[k] ?? 0) + n * priceOf(view, t);
  }
  if (acct.cash) out[cellKey('core', CASH)] = (out[cellKey('core', CASH)] ?? 0) + acct.cash;
  return out;
}

export function bucketValue(acct: Account, view: MarketView, bucket: 'own' | 'mom' | 'core'): number {
  let v = bucket === 'core' ? acct.cash : 0;
  for (const [t, n] of Object.entries(acct.lots[bucket])) if (n) v += n * priceOf(view, t);
  return v;
}

/** 總資產 = 各桶市值 ＋ 現金（未分類的持股也算）。 */
export function totalValue(acct: Account, view: MarketView): number {
  let v = bucketValue(acct, view, 'own') + bucketValue(acct, view, 'mom') + bucketValue(acct, view, 'core');
  for (const [t, n] of Object.entries(acct.lots.unc)) if (n) v += n * priceOf(view, t);
  return v;
}

/** 帳本上每一檔的總股數（各桶合計）。 */
export function bookShares(acct: Account): Record<string, number> {
  const out: Record<string, number> = {};
  for (const b of ['own', 'mom', 'core', 'unc'] as const) {
    for (const [t, n] of Object.entries(acct.lots[b])) if (n) out[t] = (out[t] ?? 0) + n;
  }
  return out;
}

export function addLot(acct: Account, bucket: keyof Lots, ticker: string, n: number): void {
  const v = (acct.lots[bucket][ticker] ?? 0) + n;
  if (Math.abs(v) < 1e-9) delete acct.lots[bucket][ticker];
  else acct.lots[bucket][ticker] = v;
}

export function newNotif(acct: Account, view: MarketView, o: Partial<Notif> & Pick<Notif, 'kind' | 'title'>): Notif {
  const n: Notif = { id: acct.nextId++, date: view.date, seq: view.i, items: [], status: 'PENDING', coreAbsorb: true, reminded: false, ...o };
  acct.notifs.push(n);
  return n;
}

let itemCounter = 0;
export function makeItem(o: Omit<Item, 'key' | 'choice' | 'ruleChoice'> & { choice?: ChoiceId; ruleChoice?: ChoiceId; noSkip?: boolean }): Item {
  const { noSkip, ...rest } = o;
  const choices = [...o.choices];
  if (!noSkip && !choices.some((c) => c.id === 'SKIP')) choices.push({ id: 'SKIP', label: '這次不做', lines: [] });
  const first = choices[0].id;
  return { ...rest, key: `i${++itemCounter}`, choices, choice: o.choice ?? first, ruleChoice: o.ruleChoice ?? first };
}

/** 單位淨值：每一桶與整個帳戶。 */
export function navPerUnit(acct: Account, view: MarketView): { total: number; own: number; mom: number; core: number } {
  const per = (v: number, u: number) => (u > 0 ? v / u : 1);
  return {
    total: per(totalValue(acct, view), acct.units.total),
    own: per(bucketValue(acct, view, 'own'), acct.units.own),
    mom: per(bucketValue(acct, view, 'mom'), acct.units.mom),
    core: per(bucketValue(acct, view, 'core'), acct.units.core),
  };
}

/** 資金流入（正）或流出（負）某一桶：用流動前的市值換算成單位。 */
export function flowUnits(units: number, valueBefore: number, amount: number): number {
  if (units <= 1e-9 || valueBefore <= 1e-9) return Math.max(0, valueBefore + amount);
  const u = units + amount / (valueBefore / units);
  return u < 1e-9 ? 0 : u;
}

/** 依波動度反比，在自選預算內推薦每檔的標準比重（設計 §2.2）。 */
export function recommendStdWeights(view: MarketView, tickers: string[], ownBudget: number): Record<string, number> {
  const inv = tickers.map((t) => 1 / annualizedVol(view.close[t], view.i, 126));
  const s = inv.reduce((a, b) => a + b, 0);
  const out: Record<string, number> = {};
  tickers.forEach((t, k) => {
    out[t] = (ownBudget * inv[k]) / s;
  });
  return out;
}

export function newOwnMeta(view: MarketView, ticker: string, origin: OwnMeta['origin'], premises: Premise[]): OwnMeta {
  const dd = drawdownFromHigh(view.close[ticker], view.i);
  const slow = initialSlowState(initialStateForNewPick(dd));
  slow.sinceSwitch = 0;
  return { slow, pending: null, r1: null, premises, origin, aiTier: null, raisedAt: null, flags: [], f25Sent: {} };
}

export interface InitialAccount {
  cfg?: Partial<EngineConfig>;
  bondTicker?: string;
  paper?: boolean;
  cash: number;
  own?: Record<string, { shares: number; stdWeight: number; state?: 'STD' | 'HALF'; premises?: Premise[] }>;
  mom?: Record<string, number>;
  core?: Record<string, number>;
  /** 動能模型名單；預設 = mom 持有的代號。 */
  momModel?: string[];
  volW?: number | null;
  volHist?: number[];
  crash?: boolean;
}

/** 上線那天：使用者填第一份快照並決定每一檔放哪一桶（設計 §2.3 起步）。 */
export function createAccount(init: InitialAccount, view: MarketView): Account {
  const cfg = { ...DEFAULT_CONFIG, ...init.cfg };
  const rule = emptyRuleState();
  const acct: Account = {
    cfg,
    bondTicker: init.bondTicker ?? 'SGOV',
    paper: init.paper ?? false,
    cash: init.cash,
    lots: { own: {}, mom: { ...(init.mom ?? {}) }, core: { ...(init.core ?? {}) }, unc: {} },
    rule,
    own: {},
    mom: { excluded: {}, adopted: {}, owe: {} },
    notifs: [],
    nextId: 1,
    shadow: [],
    events: [],
    units: { total: 0, own: 0, mom: 0, core: 0 },
    monthlyBlocked: false,
    snapshotDate: view.date,
  };
  for (const [t, o] of Object.entries(init.own ?? {})) {
    acct.lots.own[t] = o.shares;
    const state = o.state ?? 'STD';
    rule.own[t] = { applied: state, stdWeight: o.stdWeight };
    // 「連續站上 200 日均線幾天」從歷史暖機
    const meta = newOwnMeta(view, t, 'INITIAL', o.premises ?? clone(SYSTEM_DEFAULT_PREMISES));
    meta.slow = warmSlowState(view, t, state);
    acct.own[t] = meta;
  }
  rule.heldMom = init.momModel ?? Object.keys(init.mom ?? {});
  rule.crash = init.crash ?? false;
  rule.volW = init.volW ?? null;
  rule.volHist = init.volHist ?? [];
  rule.effPrev = rule.heldMom.length ? (rule.volW ?? 1) * (rule.crash ? cfg.crashCut : 1) : null;
  acct.units = {
    total: totalValue(acct, view),
    own: bucketValue(acct, view, 'own'),
    mom: bucketValue(acct, view, 'mom'),
    core: bucketValue(acct, view, 'core'),
  };
  return acct;
}

/** 用歷史算出「連續站上 200 日均線的天數」，狀態由呼叫端指定。 */
export function warmSlowState(view: MarketView, ticker: string, state: 'STD' | 'HALF'): SlowRuleState {
  const c = view.close[ticker];
  let run = 0;
  for (let k = Math.max(199, view.i - 60); k <= view.i; k++) {
    let s = 0;
    for (let j = k - 199; j <= k; j++) s += c[j];
    run = c[k] > s / 200 ? run + 1 : 0;
  }
  const st = initialSlowState(state, run);
  if (state === 'HALF') st.sinceSwitch = 30;
  return st;
}
