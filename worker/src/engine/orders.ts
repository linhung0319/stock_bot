// 清單：把每一格的目標金額換成股數，核心吸收差額，再按代號合併。
// 設計：§2.1.1（清單以股數為單位、買單上限 98%）、§2.3（合併下單）、§2.5（通知分級）。
import { halveShares } from './slowRule';
import { CASH, cellKey, parseCell, type Bucket, type CellMap, type EngineConfig, type Reason } from './types';
import type { PlanResult } from './allocator';

/** 一行清單：某一桶的某一檔買（正）或賣（負）幾股。 */
export interface OrderLine {
  ticker: string;
  bucket: Bucket;
  shares: number;
  reason: Reason | string;
}

/** 每一格持有的股數。 */
export type ShareMap = Record<string, number>;

export interface ShareContext {
  /** 換算用的價格：前一日收盤（設計 §2.1.1）。 */
  price: (ticker: string) => number;
  /** 每一格目前的股數（key 同 CellMap）。 */
  shares: ShareMap;
  /** 可用零股時給到小數幾位；0 = 整股（預設）。 */
  fractionalDigits?: number;
}

function roundDown(x: number, digits: number): number {
  const f = 10 ** digits;
  return Math.floor(x * f + 1e-9) / f;
}
function roundNear(x: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

/**
 * 把計畫裡「非核心格子」的變動換成股數。
 *   出場（目標 0）       → 全部賣出
 *   自選慢規則減半       → 賣掉當時持有股數的一半，四捨五入到整股
 *   其他賣出             → 金額差 ÷ 價格，四捨五入，不超過持有
 *   買進                 → 金額差 ÷ 價格，無條件捨去
 * 核心（VOO／短債）不在這裡處理，交給 composeWithCore。
 */
export function planToLines(plan: Pick<PlanResult, 'targets' | 'why' | 'events'>, values: CellMap, ctx: ShareContext): OrderLine[] {
  const digits = ctx.fractionalDigits ?? 0;
  const reduced = new Set(plan.events.filter((e) => e.kind === 'REDUCE').map((e) => e.ticker));
  const lines: OrderLine[] = [];
  const keys = [...new Set([...Object.keys(plan.targets), ...Object.keys(values)])].sort();
  for (const k of keys) {
    const { bucket, ticker } = parseCell(k);
    if (bucket === 'core') continue;
    const reason = plan.why[k];
    if (!reason) continue;
    const cur = values[k] ?? 0;
    const tgt = plan.targets[k] ?? 0;
    const have = ctx.shares[k] ?? 0;
    const px = ctx.price(ticker);
    let sh: number;
    if (tgt <= 1e-9) sh = -have;
    else if (reason === '自選訊號' && bucket === 'own' && reduced.has(ticker)) sh = -(digits ? roundNear(have / 2, digits) : halveShares(have));
    else if (tgt < cur) sh = -Math.min(have, roundNear((cur - tgt) / px, digits));
    else sh = roundDown((tgt - cur) / px, digits);
    if (sh !== 0) lines.push({ ticker, bucket, shares: sh, reason });
  }
  return lines;
}

export interface CoreContext {
  cfg: EngineConfig;
  price: (ticker: string) => number;
  /** 帳上現金。 */
  cash: number;
  /** 核心桶持有的核心 ETF 與短債 ETF 股數。 */
  coreShares: number;
  bondShares: number;
  /** 短債 ETF 的代號（現金的去處，設計 §4.4）。 */
  bondTicker: string;
  /** 崩盤規則是否啟動中（決定錢進出短債還是核心 ETF）。 */
  crash: boolean;
  /** 總資產（判斷「差額太小不動」用）。 */
  total: number;
  /** 要留下不投入的現金（例如等著轉出的出金）。 */
  reserveCash?: number;
}

export interface Composed {
  /** 所有的行（各桶＋核心）。 */
  lines: OrderLine[];
  /** 按代號合併後的淨買賣；同一代號兩桶對沖時 shares = 0 但 parts 有兩行（劃撥，不用下單）。 */
  merged: { ticker: string; shares: number; parts: OrderLine[] }[];
  /** 照清單做完之後估計的現金。 */
  cashAfter: number;
}

/** 買單總額的上限：「現有現金＋同一份清單的賣單金額」的 98%（設計 §2.1.1）。 */
export const BUY_CASH_FRACTION = 0.98;

/**
 * 核心吸收差額（設計 §2.1 資金流規則 1、2）：
 *   清單做完有多的錢 → 交給核心（平時買核心 ETF；崩盤規則啟動時一半買核心 ETF、一半放短債）
 *   錢不夠 → 從核心拿（平時賣核心 ETF；崩盤規則啟動時先用短債）
 * 買單合計不超過「現金＋賣單」的 98%，留緩衝給價格差。
 */
export function composeWithCore(lines: OrderLine[], ctx: CoreContext): Composed {
  const { cfg } = ctx;
  const reserve = ctx.reserveCash ?? 0;
  const vooT = cfg.coreTicker;
  let sells = 0;
  let buys = 0;
  for (const l of lines) {
    const v = l.shares * ctx.price(l.ticker);
    if (v < 0) sells -= v;
    else buys += v;
  }
  const cashAvail = ctx.cash + sells;
  const net = cashAvail - buys - reserve;
  const buffer = (1 - BUY_CASH_FRACTION) * Math.max(0, cashAvail);
  const coreLines: OrderLine[] = [];
  const pending = (ticker: string) => lines.filter((l) => l.ticker === ticker && l.bucket === 'core').reduce((a, l) => a + l.shares, 0);
  if (lines.length || Math.abs(ctx.cash) > cfg.orderMin * ctx.total) {
    if (net - buffer > cfg.orderMin * ctx.total) {
      const inv = net - buffer;
      if (ctx.crash) {
        const keepCash = 1 - cfg.crashCut;
        const a = Math.floor((inv * (1 - keepCash)) / ctx.price(vooT));
        const b = Math.floor((inv * keepCash) / ctx.price(ctx.bondTicker));
        if (a) coreLines.push({ ticker: vooT, bucket: 'core', shares: a, reason: '錢交給核心（崩盤規則啟動中：一半買核心 ETF）' });
        if (b) coreLines.push({ ticker: ctx.bondTicker, bucket: 'core', shares: b, reason: '錢交給核心（崩盤規則啟動中：一半放短債）' });
      } else {
        const a = Math.floor(inv / ctx.price(vooT));
        if (a) coreLines.push({ ticker: vooT, bucket: 'core', shares: a, reason: '錢交給核心（買核心 ETF）' });
      }
    } else if (net < 0) {
      let need = -net / BUY_CASH_FRACTION;
      const order: [string, number][] = ctx.crash
        ? [
            [ctx.bondTicker, ctx.bondShares],
            [vooT, ctx.coreShares],
          ]
        : [
            [vooT, ctx.coreShares],
            [ctx.bondTicker, ctx.bondShares],
          ];
      for (const [tk, have] of order) {
        if (need <= 0) break;
        const avail = have + pending(tk);
        const n = Math.min(avail, Math.ceil(need / ctx.price(tk)));
        if (n > 0) {
          coreLines.push({ ticker: tk, bucket: 'core', shares: -n, reason: tk === ctx.bondTicker ? '從核心拿錢（先用短債）' : '從核心拿錢（賣核心 ETF）' });
          need -= n * ctx.price(tk);
        }
      }
    }
  }
  const all = [...lines, ...coreLines];
  let cashAfter = ctx.cash - reserve;
  for (const l of all) cashAfter -= l.shares * ctx.price(l.ticker);
  return { lines: all, merged: mergeByTicker(all), cashAfter };
}

/** 按代號合併成淨買賣（設計 §2.3 合併下單）。 */
export function mergeByTicker(lines: OrderLine[]): Composed['merged'] {
  const m = new Map<string, { ticker: string; shares: number; parts: OrderLine[] }>();
  for (const l of lines) {
    const e = m.get(l.ticker) ?? { ticker: l.ticker, shares: 0, parts: [] };
    e.shares += l.shares;
    e.parts.push(l);
    m.set(l.ticker, e);
  }
  return [...m.values()].filter((e) => e.shares !== 0 || e.parts.length > 1);
}

/**
 * 崩盤規則切換時核心自己的單（設計 §4.4）：
 *   啟動：核心（含現金）的一半換成短債；解除：短債全部換回核心 ETF。
 */
export function crashCoreLines(ctx: CoreContext, turnOn: boolean): OrderLine[] {
  const pv = ctx.price(ctx.cfg.coreTicker);
  const pb = ctx.price(ctx.bondTicker);
  if (turnOn) {
    const coreVal = ctx.coreShares * pv + ctx.bondShares * pb + ctx.cash;
    const move = coreVal * (1 - ctx.cfg.crashCut) - ctx.bondShares * pb;
    if (move <= 0) return [];
    return [
      { ticker: ctx.cfg.coreTicker, bucket: 'core', shares: -Math.min(ctx.coreShares, Math.round(move / pv)), reason: '崩盤規則' },
      { ticker: ctx.bondTicker, bucket: 'core', shares: Math.floor(move / pb), reason: '崩盤規則' },
    ];
  }
  if (ctx.bondShares <= 0) return [];
  return [
    { ticker: ctx.bondTicker, bucket: 'core', shares: -ctx.bondShares, reason: '崩盤規則' },
    { ticker: ctx.cfg.coreTicker, bucket: 'core', shares: Math.floor((ctx.bondShares * pb) / pv), reason: '崩盤規則' },
  ];
}

// ---------------------------------------------------------------- 通知分級（§2.5）

export type NotifyTier = 'SAME_DAY' | 'MONTHLY';

/** 自選慢規則的一次減半或加回：變動 ≥ 總資產 5% → 當天通知、隔天開盤執行；其餘累積到月報。 */
export function ownSignalTier(changeValue: number, total: number, cfg: EngineConfig): NotifyTier {
  if (cfg.urgentFrac === null) return 'MONTHLY';
  return changeValue >= cfg.urgentFrac * total ? 'SAME_DAY' : 'MONTHLY';
}

/** 各種觸發的通知等級（設計 §2.5 的表）。自選訊號要另外看變動大小（ownSignalTier）。 */
export function reasonTier(reason: Reason): NotifyTier {
  switch (reason) {
    case '入金':
    case '出金':
    case '改比例':
    case '新增自選':
    case '移除自選':
      return 'SAME_DAY';
    default:
      return 'MONTHLY';
  }
}

/** 由股數與價格算每一格的市值。 */
export function valuesFromShares(shares: ShareMap, price: (ticker: string) => number, cash: number): CellMap {
  const out: CellMap = {};
  for (const [k, n] of Object.entries(shares)) {
    if (!n) continue;
    out[k] = n * price(parseCell(k).ticker);
  }
  const ck = cellKey('core', CASH);
  if (cash) out[ck] = (out[ck] ?? 0) + cash;
  return out;
}
