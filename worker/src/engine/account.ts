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
  /** 加入的訊號日（own_thesis §1.2；T25 之前的前提沒有這個欄位）。 */
  addedAt?: string;
}

/** 系統預設前提（own_thesis §1.12；2026-11-15 起三條，拿掉原本的第四條「慢規則本身」）。證據包另附程式算好的 D1～D3。 */
export const SYSTEM_DEFAULT_PREMISES: Premise[] = [
  { id: 'P1', text: '財報可信、沒有硬事件（重編、會計師辭任、延遲申報、被收購、重大監管處分）', origin: 'SYSTEM_DEFAULT' },
  { id: 'P2', text: '營收年增率沒有連兩季是負的', origin: 'SYSTEM_DEFAULT' },
  { id: 'P3', text: '稀釋每股盈餘沒有連兩季低於去年同季', origin: 'SYSTEM_DEFAULT' },
];

/** 論點本文（own_thesis §1.2；編輯在 T27）。 */
export interface Thesis {
  text: string;
  setAt: string;
  source: 'TYPED' | 'DISCUSSION';
  version: number;
  afterBreak: number;
  lastAfterBreakAt: string | null;
}

/** 論點檔結案的原因（own_thesis §1.2 的 own_thesis_log `CLOSE`）。 */
export type CloseReason = 'REMOVED' | 'SOLD_OUT' | 'EXIT_AI' | 'EXIT_CONDITION' | 'HARD_EVENT';

export interface OwnMeta {
  /** 慢規則狀態機（每天收盤後前進）。 */
  slow: SlowRuleState;
  /** 已觸發、還沒列進清單的訊號（變動 < 5%，等月報）。 */
  pending: { action: OwnAction; date: string } | null;
  r1: boolean | null;
  premises: Premise[];
  origin: 'INITIAL' | 'NEW' | 'TRANSFER' | 'ADOPT' | 'MANUAL';
  /**
   * 最近一次 F24 的檔位（AI 層給的輸入）。suggest = 3 票一致、和目前不同、有一條不成立的前提 → 月報並列。
   * premiseId：三票都判不成立（有申報或財報引用）的那條前提，有多條時取編號最小的（own_thesis §1.6 第 1 點）。
   */
  aiTier: { tier: Tier; date: string; runId?: string; suggest: boolean; premiseId?: string } | null;
  raisedAt: string | null;
  /** 未解除的硬事件標記。 */
  flags: string[];
  /** 每個月已發幾則 F25 當天通知。 */
  f25Sent: Record<string, number>;
  /** 上一次 F24 之後已成立、還沒被新的審查處理的降級條件（F8 加回時註明）。 */
  metConds?: string[];
  /**
   * 論點檔的編號 `<代號>@<開檔的訊號日>`（own_thesis §1.2）；同一天結案又重開的加 `#2`、`#3`。
   * 條件與 own_thesis_log 都帶這個編號，讀條件時只讀現在這份的。T25 之前建立的自選沒有這個欄位。
   */
  fileId?: string;
  /** 論點本文；還沒寫是 null（T27 編輯）。 */
  thesis?: Thesis | null;
  /** 下一條前提的編號：前提的 id 發出去就不重用、不重排（修 N7）。 */
  premiseSeq?: number;
  /** 開檔時的慢規則狀態與距 52 週高點的跌幅（寫 log 的 OPEN 用；own_thesis §3.8）。 */
  opened?: { startState: 'STD' | 'HALF'; drawdownAtOpen: number | null };
  /** 「不同意」之後的靜默期（own_thesis §1.10；由 T30 寫入，論點檔與證據包會列出來）。 */
  disputes?: { premiseId: string; since: string; until: string; reason: string; notif: number | null }[];
  /**
   * 「要看的事」上次列進月報的訊號日（own_thesis §3.6.6）：鍵是那一件事的鍵（`NO_THESIS`、`COND_NEAR:<列編號>@<季末日>`…），
   * 由 `app/thesis.ts` 的 dueAttention 決定多久再列。沒有這個欄位（舊資料）= 都還沒列過。
   */
  attnShown?: Record<string, string>;
}

/**
 * 「要看的事」的一件（own_thesis §3.6.6；動能的見 momentum_ai §3.6）：不用下單、但值得知道的事。
 * 不是通知：不提醒、不用回覆。src：哪一段（自選股／動能持股），沒有 = 自選股。
 */
export interface Attention {
  ticker: string;
  kind: string;
  text: string;
  /** 從哪一天起成立（訊號日）。 */
  since: string;
  src?: 'own' | 'mom';
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
  | { type: 'CLEAR_FLAG'; ticker: string }
  /** 動能持股照 AI 的硬事件建議出場：這一檔拿出動能名單，下個月照排名遞補（momentum_ai §3.5）。 */
  | { type: 'MOM_DROP'; ticker: string };

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
  /** 這一項的 AI 建議或說明來自哪幾次 AI 執行（ai_runs.run_id，T13 起；之前的通知沒有這個欄位）。 */
  runIds?: string[];
  /** F5／F6：上次選了「這次不做」、這份月報重列的那一項（core_ai §3.6，由 T33c 產生；重列的不開檢視）。 */
  relist?: boolean;
}

export type NotifKind = 'MONTHLY' | 'MONTHLY_EMPTY' | 'URGENT' | 'CASHFLOW' | 'FIX' | 'INFO' | 'CLASSIFY' | 'CASH_DIFF';
export type NotifStatus = 'PENDING' | 'RESPONDED' | 'DONE' | 'SKIPPED' | 'READ' | 'SUPERSEDED' | 'CANCELLED';

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
  /** 回覆那天的交易日序號（決定了還沒填快照的提醒用）。 */
  respondedSeq?: number;
  /** 決定了還沒填快照，已經提醒過。 */
  fillReminded?: boolean;
  /** 改比例：改之前的比例與每檔自選的標準比重（取消時改回去）。 */
  ratioBefore?: { ratio: { own: number; strat: number; core: number }; std: Record<string, number> };
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
  /** CLASSIFY：填快照時寫的「這次自己交易的原因」，分類時預先帶進理由欄。 */
  userNote?: string;
  /** 這則通知用到的所有 AI 執行（各項目的 runIds，加上不屬於任何項目的：F1 否決、F20 說明；T13 起）。 */
  runIds?: string[];
  /** 月報：這個月該列的「要看的事」（own_thesis §3.6.6）；沒有就不留這個欄位。 */
  attention?: Attention[];
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
  /** 同一家公司的不同類股：代號 → 公司（CIK）。同公司已經有一類在名單裡時，另一類不進場（設計 §2.4）。 */
  company?: Record<string, string>;
  /** 本月暫停換股的原因（成分股名單不一致、排名沒有產生）；order 這時是目前的動能名單，名單不變。 */
  paused?: string;
  /** 任務 A 准許但觀察（ALLOW_WATCH）的代號 → 觀察理由（月報列出）。 */
  watch?: Record<string, string>;
  /** 附在月報的說明（任務 C：持股單月跌 > 20% 的原因）。 */
  notes?: string[];
  /** 這份月報用到的 AI 執行（ai_runs.run_id，T13）：崩盤規則檢視、F1 每檔的審查、F20 說明。 */
  runIds?: { crash?: string; entry?: Record<string, string>; notes?: string[] };
  /**
   * 訊號日的超額波動（依波動度減碼用；momentum_ai §3.11）。第一次產生月報時算好寫進來；之後的重算（暫停後、入金合併、排除）用它。
   * null = 算不出來；沒有這個欄位（舊月報）= 當場算。
   */
  excessVol?: number | null;
  /**
   * 訊號日崩盤規則的判斷（core_ai §3.7）：第一次產生月報時用當時的 view 算好寫進來；之後的重算用 below，不重算。
   * ma 是 null = 均線算不出來（不滿 200 根有效收盤，§3.10），below 維持原狀態；bars 是那時有幾根有效收盤。
   * 沒有這個欄位（舊月報）= 當場算。
   */
  crash?: { below: boolean; date: string; close: number | null; ma: number | null; bars?: number };
  /**
   * 這個月該列的「要看的事」（own_thesis §3.6.6、momentum_ai §3.6）：每日流程在產生月報前算好（頻率已經過濾）。
   * 月報照抄到通知的 attention；重算（暫停後、入金合併、排除）沿用這一份。
   */
  attention?: Attention[];
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
  /** 哪一則通知的回覆產生的（改決定時用來作廢）。 */
  notif?: number;
  /** 這一項的 AI 建議來自哪幾次 AI 執行（ai_runs.run_id，T13 起；之前的紀錄沒有這個欄位）。 */
  runIds?: string[];
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
  /** 已經記成出金、但券商的現金還沒扣掉（錢還沒轉出）的金額；填快照時從券商現金扣掉再對帳（設計 §10 第 40 點）。 */
  pendingWithdraw?: number;
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
  /**
   * 每檔最近一次結案的論點檔（own_thesis §1.2）：存檔時寫 log 的 `CLOSE` 用它的原因；
   * 同一天結案又重新加入時，用它避免論點檔編號重複。
   */
  ownClosed?: Record<string, { fileId: string; reason: CloseReason; date: string }>;
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
  syncRunIds(n);
  acct.notifs.push(n);
  return n;
}

/** 通知的 runIds = 各項目的 runIds ＋ 原本就掛在通知上的（例如 F1 否決），去重；沒有就不留這個欄位。 */
export function syncRunIds(n: Notif, extra: (string | undefined)[] = []): void {
  const ids = [...new Set([...(n.runIds ?? []), ...n.items.flatMap((i) => i.runIds ?? []), ...extra].filter((x): x is string => !!x))];
  if (ids.length) n.runIds = ids;
  else delete n.runIds;
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

/** 推薦標準比重用的波動度：最多 126 天；上市不久的股票用現有的天數，至少 20 天，不夠回傳 NaN。 */
export const STD_VOL_DAYS = 126;
export const STD_VOL_MIN_DAYS = 20;
export function recentVol(close: ArrayLike<number> | undefined, i: number): number {
  if (!close) return NaN;
  let n = 0;
  while (n < STD_VOL_DAYS && i - n - 1 >= 0 && Number.isFinite(close[i - n]) && Number.isFinite(close[i - n - 1]) && close[i - n - 1] > 0) n++;
  if (n < STD_VOL_MIN_DAYS) return NaN;
  const v = annualizedVol(close, i, n);
  return Number.isFinite(v) && v > 0 ? v : NaN;
}

/**
 * 依波動度反比，在自選預算內推薦每檔的標準比重（設計 §2.2）。
 * 歷史不到 126 天的用現有的天數；不到 20 天的用其他檔的平均波動度；全部都算不出來就平分（設計 §10 第 37 點）。
 */
export function recommendStdWeights(view: MarketView, tickers: string[], ownBudget: number): Record<string, number> {
  const vols = tickers.map((t) => recentVol(view.close[t], view.i));
  const known = vols.filter((v) => Number.isFinite(v));
  const fallback = known.length ? known.reduce((a, b) => a + b, 0) / known.length : 1;
  const inv = vols.map((v) => 1 / (Number.isFinite(v) ? v : fallback));
  const s = inv.reduce((a, b) => a + b, 0);
  const out: Record<string, number> = {};
  tickers.forEach((t, k) => {
    out[t] = (ownBudget * inv[k]) / s;
  });
  return out;
}

/** 前提 id 的數字部分（P3 → 3；不是 P 開頭的數字就是 0）。 */
const premiseNo = (id: string) => (/^P(\d+)$/.test(id) ? Number(id.slice(1)) : 0);

/** 下一條前提的編號：帳戶狀態有記就用它，否則（T25 之前的資料）用現有最大的編號加 1。 */
export function nextPremiseSeq(meta: Pick<OwnMeta, 'premises' | 'premiseSeq'>): number {
  return Math.max(meta.premiseSeq ?? 0, ...meta.premises.map((p) => premiseNo(p.id) + 1), 1);
}

/** 論點檔編號：`<代號>@<訊號日>`；這一檔上一次結案的也是同一天開的，就加 `#2`、`#3`。 */
export function newFileId(ticker: string, date: string, lastClosed?: string): string {
  const base = `${ticker}@${date}`;
  if (!lastClosed || (lastClosed !== base && !lastClosed.startsWith(base + '#'))) return base;
  const n = lastClosed === base ? 1 : Number(lastClosed.slice(base.length + 1)) || 1;
  return `${base}#${n + 1}`;
}

/**
 * 開一份新的論點檔（新增自選、轉入、認養、手動買進、上線那天）。
 * lastClosed：這一檔上一次結案的論點檔編號（Account.ownClosed），同一天又加回時編號才不會重複。
 */
export function newOwnMeta(view: MarketView, ticker: string, origin: OwnMeta['origin'], premises: Premise[], lastClosed?: string): OwnMeta {
  const dd = drawdownFromHigh(view.close[ticker], view.i);
  const startState = initialStateForNewPick(dd);
  const slow = initialSlowState(startState);
  slow.sinceSwitch = 0;
  const ps = premises.map((p) => ({ ...p, addedAt: p.addedAt ?? view.date }));
  return {
    slow,
    pending: null,
    r1: null,
    premises: ps,
    origin,
    aiTier: null,
    raisedAt: null,
    flags: [],
    f25Sent: {},
    fileId: newFileId(ticker, view.date, lastClosed),
    thesis: null,
    premiseSeq: nextPremiseSeq({ premises: ps }),
    opened: { startState, drawdownAtOpen: Number.isFinite(dd) ? dd : null },
  };
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
    meta.opened = { startState: state, drawdownAtOpen: meta.opened?.drawdownAtOpen ?? null };
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
