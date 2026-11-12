// 示範模式的時間驅動：照日曆一天一天走，在對的時點呼叫引擎（每日檢查、月報），並餵入腳本裡的 AI 輸入。
// 時間模型和 test/helpers/sim.ts 相同：使用者永遠站在「某個交易日的早上」（台灣時間；美股還沒開盤），
// 看到的是前一個交易日的收盤；填快照時以當天開盤價估成交金額。
// 真正的系統裡這些由 Worker 的排程做（T7）；這裡只給示範模式與驗收測試用。
import {
  bookShares,
  composeNotif,
  conditionMet,
  createAccount,
  dailyCheck,
  excessVol,
  monthlyReport,
  recordAiTier,
  type Account,
  type InitialAccount,
  type MarketView,
  type Snapshot,
} from '../engine';
import { DEMO_SCRIPTS, type DemoId, type DemoScript } from './demoScripts';
import { ranksAt, viewAt, type Market } from './market';
import { scenarios } from './scenarios';

export interface DemoState {
  scenario: DemoId;
  /** 今天是第幾個交易日（market.days 的位置）。使用者站在這一天的早上。 */
  d: number;
  acct: Account;
}

/** 每次引擎產生新通知之後呼叫（網站用它替每一項寫下理由）。 */
export type OnNotifs = (acct: Account, view: MarketView, rankOrder: string[]) => void;

const marketCache = new Map<DemoId, Market>();
export function demoMarket(id: DemoId): Market {
  let m = marketCache.get(id);
  if (!m) {
    m = scenarios[id]().market;
    marketCache.set(id, m);
  }
  return m;
}

/**
 * 情境的起始帳戶。動能的 σ 歷史 = 開始時的 σ × sigmaMedianFactor（預設 1.35：一開始不減碼），
 * 這樣不用真的跑兩年歷史。
 */
export function createDemoAccount(market: Market, init: InitialAccount, sigmaMedianFactor = 1.35): Account {
  const v0 = viewAt(market, market.idx0 - 1);
  const model = init.momModel ?? Object.keys(init.mom ?? {});
  const cache: Record<string, Float64Array> = {};
  const retOf = (t: string) => {
    if (!cache[t]) {
      const c = market.close[t];
      cache[t] = Float64Array.from(c.map((x, k) => (k ? x / c[k - 1] - 1 : NaN)));
    }
    return cache[t];
  };
  const s0 = excessVol(retOf, model, 'VOO', v0.i - 125, v0.i + 1);
  return createAccount({ volW: 1, volHist: Array.from({ length: 24 }, () => s0 * sigmaMedianFactor), ...init }, v0);
}

const isFirstOfMonth = (m: Market, d: number) => m.days[d - 1].slice(0, 7) !== m.days[d].slice(0, 7);

/** 早上：先記下腳本裡這一天的 F24 檔位，月報日就出月報。 */
function morning(st: DemoState, m: Market, script: DemoScript, on?: OnNotifs): void {
  const date = m.days[st.d];
  for (const t of script.aiTiers ?? []) if (t.on === date) st.acct = recordAiTier(st.acct, t.ticker, t.tier, t.date, t.suggest);
  if (!isFirstOfMonth(m, st.d)) return;
  const view = viewAt(m, st.d - 1);
  const month = date.slice(0, 7);
  const order = ranksAt(m, st.d - 1);
  st.acct = monthlyReport(st.acct, view, { order, vetoed: script.vetoes?.[month], month }).acct;
  on?.(st.acct, view, order);
}

/** 收盤後：每日檢查，再看腳本裡這一天有沒有成立的條件（F25）。 */
function evening(st: DemoState, m: Market, script: DemoScript, on?: OnNotifs): void {
  const view = viewAt(m, st.d);
  const date = m.days[st.d];
  st.acct = dailyCheck(st.acct, view).acct;
  for (const c of script.conditions ?? []) if (c.on === date) st.acct = conditionMet(st.acct, view, c.ticker, c.tier, c.text, date.slice(0, 7)).acct;
  on?.(st.acct, view, ranksAt(m, st.d));
}

export const demoAtEnd = (st: DemoState): boolean => st.d >= demoMarket(st.scenario).days.length - 1;

/** 從頭開始一個情境，走到腳本指定的那一天早上。 */
export function resetDemo(id: DemoId, on?: OnNotifs): DemoState {
  const sc = scenarios[id]();
  const m = demoMarket(id);
  const script = DEMO_SCRIPTS[id];
  const st: DemoState = { scenario: id, d: m.idx0, acct: createDemoAccount(m, sc.init) };
  morning(st, m, script, on);
  while (m.days[st.d] < script.startAt && !demoAtEnd(st)) {
    evening(st, m, script, on);
    st.d++;
    morning(st, m, script, on);
  }
  return st;
}

export type AdvanceMode = 'day' | 'notif' | 'month';

/**
 * 時間前進：day = 到下一個交易日的早上；notif = 一直走到有新通知；month = 走到下一份月報。
 * 回傳走了幾天、這段時間新產生的通知編號。
 */
export function advanceDemo(st0: DemoState, mode: AdvanceMode, on?: OnNotifs): { state: DemoState; days: number; created: number[] } {
  const st: DemoState = { ...st0 };
  const m = demoMarket(st.scenario);
  const script = DEMO_SCRIPTS[st.scenario];
  const before = new Set(st.acct.notifs.map((n) => n.id));
  const fresh = () => st.acct.notifs.filter((n) => !before.has(n.id));
  let days = 0;
  while (!demoAtEnd(st)) {
    evening(st, m, script, on);
    st.d++;
    morning(st, m, script, on);
    days++;
    if (mode === 'day') break;
    if (mode === 'notif' && fresh().length) break;
    if (mode === 'month' && isFirstOfMonth(m, st.d)) break;
  }
  return { state: st, days, created: fresh().map((n) => n.id) };
}

/** 早上看到的市場（前一個交易日的收盤）。 */
export function demoView(st: DemoState): MarketView {
  return viewAt(demoMarket(st.scenario), st.d - 1);
}

/** 今天的開盤價（估成交金額用）。 */
export function demoFill(st: DemoState): (ticker: string) => number {
  const m = demoMarket(st.scenario);
  return (t) => {
    const o = m.open[t];
    if (!o) throw new Error(`示範資料沒有 ${t}`);
    return o[st.d];
  };
}

/**
 * 「照清單下單、以今天開盤價成交」之後券商會顯示的數字（示範模式沒有真的券商，用這個代替）。
 * extra：實際成交和清單不同的地方（代號 → 這一檔實際的股數變動，取代清單上的數字）。
 */
export function demoFilledSnapshot(st: DemoState, extra: Record<string, number> = {}, exact = false): Snapshot {
  const fill = demoFill(st);
  const view = demoView(st);
  const shares = bookShares(st.acct);
  let cash = st.acct.cash;
  const delta: Record<string, number> = {};
  for (const n of st.acct.notifs) {
    if (n.status !== 'RESPONDED') continue;
    const comp = n.composed ?? composeNotif(st.acct, view, n);
    for (const x of comp.merged) delta[x.ticker] = (delta[x.ticker] ?? 0) + x.shares;
    if (n.withdraw) cash -= n.withdraw;
  }
  Object.assign(delta, extra);
  for (const [t, q] of Object.entries(delta)) {
    shares[t] = (shares[t] ?? 0) + q;
    cash -= q * fill(t);
  }
  // 畫面上的數字四捨五入到分；驗收測試要和引擎逐位相同時用 exact
  return { shares, cash: exact ? cash : Math.round(cash * 100) / 100 };
}
