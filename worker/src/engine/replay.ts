// 重放：用歷史價格與排名，以「比重模式」（不取整股、每單位成交金額收手續費）逐日跑引擎。
// 這是 backtest/account_backtest.py 的 simulate_account 外層迴圈的 TypeScript 版，用來驗收引擎（T2）。
// 純函式：資料由呼叫端讀好傳進來。
import { dueOwnActions, planDay, summarizeOrders, type PlanEvent } from './allocator';
import { excessVol, sma } from './indicators';
import { slowSignals } from './slowRule';
import { CASH, cellKey, emptyRuleState, parseCell, type CellMap, type EngineConfig, type OwnAction } from './types';

export interface ReplayData {
  /** 交易日（ISO 日期，由舊到新）。 */
  days: string[];
  /** 還原收盤；沒有資料是 NaN。 */
  close: Record<string, Float64Array>;
  /** 還原開盤；缺的已用前一日收盤補上。 */
  open: Record<string, Float64Array>;
  /** 每個換股日的股票池排名（代號由高到低）。 */
  ranks: Record<string, string[]>;
}

export interface ReplayOptions {
  cfg: EngineConfig;
  own: string[];
  start: string;
  end: string;
  /** 每單位成交金額的成本（回測用 5 bp）。 */
  fee: number;
  volWindow?: number;
  crashRule?: boolean;
}

export interface ReplayOrder {
  date: string;
  nOrders: number;
  reasons: string;
  ratioOnly: boolean;
  /** 例如「買 BA 5.8%；賣 SPY 1.9%」（和回測的格式相同）。 */
  orders: string;
}

export interface ReplayResult {
  dates: string[];
  /** 每日收盤的帳戶價值（起始 1）。 */
  nav: number[];
  orders: ReplayOrder[];
  events: { date: string; kind: PlanEvent['kind']; ticker?: string; detail?: string }[];
  /** 每個換股日的波動度比例。 */
  volPath: number[];
  urgentDays: number;
}

function ffill(xs: Float64Array): Float64Array {
  const out = new Float64Array(xs.length);
  let last = NaN;
  for (let i = 0; i < xs.length; i++) {
    if (Number.isFinite(xs[i])) last = xs[i];
    out[i] = last;
  }
  return out;
}

function dailyReturns(xs: Float64Array): Float64Array {
  const out = new Float64Array(xs.length).fill(NaN);
  for (let i = 1; i < xs.length; i++) out[i] = xs[i] / xs[i - 1] - 1;
  return out;
}

/** 第一個 ≥ x 的位置。 */
function lowerBound(xs: string[], x: string): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function replay(data: ReplayData, opt: ReplayOptions): ReplayResult {
  const { cfg } = opt;
  const core = cfg.coreTicker;
  const volWindow = opt.volWindow ?? 126;
  const allDays = data.days;
  const lo = lowerBound(allDays, opt.start);
  let hi = lowerBound(allDays, opt.end);
  if (hi < allDays.length && allDays[hi] === opt.end) hi++;
  const rdays = Object.keys(data.ranks)
    .filter((d) => d >= allDays[lo] && d <= allDays[hi - 1])
    .sort();
  const g0 = lowerBound(allDays, rdays[0]);
  const rset = new Set(rdays);

  const lastClose: Record<string, Float64Array> = {};
  const rets: Record<string, Float64Array> = {};
  const lc = (t: string) => (lastClose[t] ??= ffill(data.close[t]));
  const retOf = (t: string) => (data.close[t] ? (rets[t] ??= dailyReturns(data.close[t])) : undefined);
  const openPx = (t: string, g: number) => (t === CASH ? 1 : data.open[t][g]);
  const closePx = (t: string, g: number) => (t === CASH ? 1 : lc(t)[g]);

  // 自選慢規則的訊號：在這檔有資料的交易日上跑狀態機（和回測相同）
  const sigs: Record<string, Map<number, OwnAction>> = {};
  for (const tk of opt.own) {
    const c = data.close[tk];
    const idx: number[] = [];
    const vals: number[] = [];
    for (let g = 0; g < c.length; g++) {
      if (Number.isFinite(c[g])) {
        idx.push(g);
        vals.push(c[g]);
      }
    }
    let startPos = idx.findIndex((g) => g >= g0);
    if (startPos < 0) startPos = idx.length;
    const s = slowSignals(vals, startPos);
    const m = new Map<number, OwnAction>();
    s.forEach((a, k) => {
      if (a) m.set(idx[k], a);
    });
    sigs[tk] = m;
  }

  let state = emptyRuleState();
  for (const tk of opt.own) state.own[tk] = { applied: 'STD', stdWeight: cfg.ratio.own / opt.own.length };
  let lots: CellMap = {};
  const pending: Record<string, OwnAction> = {};
  const out: ReplayResult = { dates: [], nav: [], orders: [], events: [], volPath: [], urgentDays: 0 };

  for (let g = g0; g < hi; g++) {
    const date = allDays[g];
    const isR = rset.has(date);
    const first = g === g0;
    const values: CellMap = {};
    for (const [k, u] of Object.entries(lots)) values[k] = u * openPx(parseCell(k).ticker, g);
    const due = dueOwnActions({ cfg, pending, state, values, isMonthly: isR });
    if (due.urgent) out.urgentDays++;
    if (first || isR || Object.keys(due.todo).length) {
      if (first && !Object.keys(values).length) values[cellKey('core', CASH)] = 1;
      const plan = planDay({
        cfg,
        values,
        state,
        first,
        ownActions: due.todo,
        monthly: isR
          ? {
              order: data.ranks[date],
              excessVol: (names) => excessVol(retOf, names, core, g - volWindow, g),
              coreBelow200: (opt.crashRule ?? true) && lc(core)[g - 1] < sma(data.close[core], g - 1, 200),
            }
          : undefined,
      });
      state = plan.state;
      if (isR && plan.vol && plan.vol.nextW !== null) out.volPath.push(plan.vol.w);
      for (const e of plan.events) out.events.push({ date, ...e });
      const s = summarizeOrders(cfg, values, plan);
      if (s.orders.length && !first) {
        out.orders.push({
          date,
          nOrders: s.orders.length,
          reasons: s.reasons.join('、'),
          ratioOnly: s.ratioOnly,
          orders: s.orders.map((o) => `${o.amount > 0 ? '買' : '賣'} ${o.ticker} ${(o.frac * 100).toFixed(1)}%`).join('；'),
        });
      }
      // 手續費從核心扣
      const tgt = { ...plan.targets };
      const fee = s.traded * opt.fee;
      const ck = (tgt[cellKey('core', CASH)] ?? 0) >= fee ? cellKey('core', CASH) : cellKey('core', core);
      tgt[ck] = (tgt[ck] ?? 0) - fee;
      lots = {};
      for (const [k, v] of Object.entries(tgt)) if (v > 1e-12) lots[k] = v / openPx(parseCell(k).ticker, g);
      for (const tk of Object.keys(due.todo)) delete pending[tk];
    }
    let nav = 0;
    for (const [k, u] of Object.entries(lots)) nav += u * closePx(parseCell(k).ticker, g);
    out.dates.push(date);
    out.nav.push(nav);
    for (const tk of opt.own) {
      const a = sigs[tk].get(g);
      if (a) pending[tk] = a;
    }
  }
  return out;
}

export interface ReplayStats {
  cagr: number;
  sharpe: number;
  maxDrawdown: number;
  orderDaysPerYear: number;
  avgOrders: number;
  years: number;
}

/** 年化、Sharpe（月底淨值的月報酬 × √12）、最大回撤；算法和回測的 account_stats 相同。 */
export function replayStats(r: Pick<ReplayResult, 'dates' | 'nav' | 'orders'>): ReplayStats {
  const t0 = Date.parse(r.dates[0] + 'T00:00:00Z');
  const t1 = Date.parse(r.dates[r.dates.length - 1] + 'T00:00:00Z');
  const years = (t1 - t0) / 86_400_000 / 365.25;
  const cagr = (r.nav[r.nav.length - 1] / r.nav[0]) ** (1 / years) - 1;
  const monthEnd: number[] = [];
  for (let i = 0; i < r.dates.length; i++) {
    if (i === r.dates.length - 1 || r.dates[i].slice(0, 7) !== r.dates[i + 1].slice(0, 7)) monthEnd.push(r.nav[i]);
  }
  const mr: number[] = [];
  for (let i = 1; i < monthEnd.length; i++) mr.push(monthEnd[i] / monthEnd[i - 1] - 1);
  const m = mr.reduce((a, b) => a + b, 0) / mr.length;
  const sd = Math.sqrt(mr.reduce((a, b) => a + (b - m) ** 2, 0) / (mr.length - 1));
  let peak = -Infinity;
  let mdd = 0;
  for (const v of r.nav) {
    if (v > peak) peak = v;
    mdd = Math.min(mdd, v / peak - 1);
  }
  return {
    cagr,
    sharpe: (m / sd) * Math.sqrt(12),
    maxDrawdown: mdd,
    orderDaysPerYear: r.orders.length / years,
    avgOrders: r.orders.length ? r.orders.reduce((a, o) => a + o.nOrders, 0) / r.orders.length : 0,
    years,
  };
}
