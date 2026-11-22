// 清單：把每一格的目標金額換成股數，核心吸收差額，再按代號合併。
// 設計：§2.1.1（清單以股數為單位、買單上限 98%）、§2.3（合併下單）、§2.5（通知分級）。
import { halveShares } from './slowRule';
import { CASH, cellKey, coreCfg, parseCell, type Bucket, type CellMap, type EngineConfig, type Reason } from './types';
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
    else if (tgt < cur) sh = -Math.min(have, reason === '出金' ? Math.ceil((cur - tgt) / px - 1e-9) : roundNear((cur - tgt) / px, digits));
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
  /** 短債 ETF 的代號（核心裡不放股票的那一邊，allocation_redesign §1.1）。 */
  bondTicker: string;
  /** 總資產（判斷「差額太小不動」用）。 */
  total: number;
  /** 要留下不投入的現金（例如等著轉出的出金）。 */
  reserveCash?: number;
  /**
   * 這份清單帶進來、已經算在 cash 裡的新錢（入金）：和其他桶賣出的錢一樣照比例進核心（allocation_redesign §1.4）。
   * 其餘的帳上現金本來就算在短債那一邊，不照比例分。
   */
  fresh?: number;
  /** 月報：帳上原本的現金順便買成短債（allocation_redesign §1.2 的搭便車行）。其他清單不動它。 */
  sweepCash?: boolean;
}

export interface Composed {
  /** 所有的行（各桶＋核心）。 */
  lines: OrderLine[];
  /** 按代號合併後的淨買賣；同一代號兩桶對沖時 shares = 0 但 parts 有兩行（劃撥，不用下單）。 */
  merged: { ticker: string; shares: number; parts: OrderLine[] }[];
  /** 照清單做完之後估計的現金。 */
  cashAfter: number;
  /** 核心不夠付時，買單從最後一行往回減了哪些（C14）；沒有減就沒有這個欄位。 */
  capped?: { ticker: string; cut: number }[];
}

/** 買單總額的上限：「現有現金＋同一份清單的賣單金額」的 98%（設計 §2.1.1）。 */
export const BUY_CASH_FRACTION = 0.98;

/** 買單合計不超過預算：從最後面的行開始減（入金：缺口最小的在最後；C14：核心不夠付時）。 */
export function capBuys(lines: OrderLine[], budget: number, price: (t: string) => number): OrderLine[] {
  return capLines(lines, budget, price).filter((l) => l.shares !== 0);
}

/** 同 capBuys，但留下減到 0 的行（和輸入一一對應）。 */
function capLines(lines: OrderLine[], budget: number, price: (t: string) => number): OrderLine[] {
  const out = lines.map((l) => ({ ...l }));
  let spent = out.reduce((a, l) => a + (l.shares > 0 ? l.shares * price(l.ticker) : 0), 0);
  for (let k = out.length - 1; k >= 0 && spent > budget; k--) {
    const l = out[k];
    if (l.shares <= 0) continue;
    const cut = Math.min(l.shares, Math.ceil((spent - budget) / price(l.ticker)));
    l.shares -= cut;
    spent -= cut * price(l.ticker);
  }
  return out;
}

// ---------------------------------------------------------------- 核心的固定比例（allocation_redesign §1.1～§1.3）

export interface CoreSplitInput {
  /** 正：進核心的金額。負：要從核心拿的金額（含帳上現金先出的部分）。 */
  amount: number;
  /** 短債那一邊的目標比例（0.20）。 */
  bond: number;
  priceCore: number;
  priceBond: number;
  /** 從核心拿時可以賣的股數。 */
  coreShares?: number;
  bondShares?: number;
  /** 從核心拿時可以先用的帳上現金（它本來就算在短債那一邊）。 */
  cash?: number;
}

export interface CoreSplit {
  /** 核心 ETF、短債 ETF 的股數變動（買是正、賣是負）。 */
  core: number;
  bond: number;
  /** 從核心拿時先用了多少帳上現金。 */
  cashUsed: number;
  /** 兩邊都賣光了還不夠的金額（0 = 夠）。 */
  short: number;
}

/**
 * 錢進出核心怎麼分（allocation_redesign §1.2，純函式）：
 *   進核心：核心 ETF 買 floor(金額 × 八成 ÷ 價格) 股、短債買 floor(金額 × 兩成 ÷ 價格) 股；配不到整股的零頭留在帳上（算短債那一邊）。
 *   從核心拿：先用帳上現金；短債那一邊該出「總額 × 兩成」，現金已經出的先抵掉，剩下的賣短債（四捨五入到整股，不到半股就不賣）；
 *     其餘賣核心 ETF（無條件進位到夠用，多的零頭留現金）。一邊不夠賣，不夠的那一份由另一邊補。
 */
export function coreSplit(inp: CoreSplitInput): CoreSplit {
  const { amount, bond, priceCore: pv, priceBond: pb } = inp;
  if (amount >= 0) {
    return { core: Math.floor((amount * (1 - bond)) / pv + 1e-9), bond: Math.floor((amount * bond) / pb + 1e-9), cashUsed: 0, short: 0 };
  }
  const want = -amount;
  const cashUsed = Math.min(Math.max(0, inp.cash ?? 0), want);
  let need = want - cashUsed;
  if (need <= 1e-9) return { core: 0, bond: 0, cashUsed, short: 0 };
  const haveCore = Math.max(0, inp.coreShares ?? 0);
  const haveBond = Math.max(0, inp.bondShares ?? 0);
  const bondPart = Math.min(need, Math.max(0, want * bond - cashUsed));
  let nb = Math.min(haveBond, Math.round(bondPart / pb));
  need -= nb * pb;
  let nc = 0;
  if (need > 1e-9) {
    nc = Math.min(haveCore, Math.ceil(need / pv - 1e-9));
    need -= nc * pv;
  }
  if (need > 1e-9 && nb < haveBond) {
    // 核心 ETF 不夠賣：不夠的那一份由短債補
    const extra = Math.min(haveBond - nb, Math.ceil(need / pb - 1e-9));
    nb += extra;
    need -= extra * pb;
  }
  return { core: nc ? -nc : 0, bond: nb ? -nb : 0, cashUsed, short: Math.max(0, need) };
}

export interface CoreBand {
  /** 短債那一邊（短債 ETF＋帳上現金）占核心的比例；核心是 0 時是 0。 */
  s: number;
  /** 核心的市值。 */
  core: number;
  /** 目標比例與界線。 */
  bond: number;
  band: number;
  /** 超出界線（s < bond − band 或 s > bond + band）。 */
  out: boolean;
  /** 超出界線時，短債那一邊要增加（正）或減少（負）多少金額才回到目標；界線內是 0。 */
  move: number;
}

/** 核心比例的界線檢查（allocation_redesign §1.3，純函式）：bondSide = 短債 ETF 市值＋帳上現金，core = 核心的市值。 */
export function coreBandCheck(bondSide: number, core: number, cfg: Partial<Pick<EngineConfig, 'coreBond' | 'coreBand'>>): CoreBand {
  const { bond, band } = coreCfg(cfg);
  const s = core > 0 ? bondSide / core : 0;
  const out = core > 0 && Math.abs(s - bond) > band;
  return { s, core, bond, band, out, move: out ? core * bond - bondSide : 0 };
}

/** 幾成：0.8 → 八成、0.2 → 兩成；不是整數成的寫百分比。 */
export function tenths(x: number): string {
  const n = Math.round(x * 10);
  return Math.abs(x * 10 - n) < 1e-9 && n >= 1 && n <= 9 ? `${'一兩三四五六七八九'[n - 1]}成` : `${Math.round(x * 1000) / 10}%`;
}

/** 核心那幾行的原因文字（allocation_redesign §1.2）。 */
export function coreReasons(cfg: EngineConfig, bondTicker: string): { give: string; take: string; sweep: string } {
  const { bond } = coreCfg(cfg);
  const mix = `（${cfg.coreTicker} ${tenths(1 - bond)}、${bondTicker} ${tenths(bond)}）`;
  return { give: `錢交給核心${mix}`, take: `從核心拿錢${mix}`, sweep: `帳上的現金買 ${bondTicker}` };
}

/**
 * 核心比例調回（F26）的行（allocation_redesign §1.3）：ctx 是「這份清單其他單做完之後」的核心（股數與現金）。
 *   短債那一邊太少 → 賣核心 ETF、買短債（買的時候帳上現金一起用）；太多 → 先用帳上現金、不夠再賣短債，買核心 ETF。
 * 買單照 98% 的規矩留緩衝。界線內、或換算出來沒有整股可以動 → 空陣列。
 */
export function coreBandLines(ctx: Pick<CoreContext, 'cfg' | 'price' | 'cash' | 'coreShares' | 'bondShares' | 'bondTicker'>): { check: CoreBand; lines: OrderLine[] } {
  const pv = ctx.price(ctx.cfg.coreTicker);
  const pb = ctx.price(ctx.bondTicker);
  const cash = Math.max(0, ctx.cash);
  const check = coreBandCheck(ctx.bondShares * pb + ctx.cash, ctx.coreShares * pv + ctx.bondShares * pb + ctx.cash, ctx.cfg);
  if (!check.out) return { check, lines: [] };
  const lines: OrderLine[] = [];
  if (check.move > 0) {
    const sell = Math.min(ctx.coreShares, Math.round(check.move / pv));
    const buy = Math.floor((BUY_CASH_FRACTION * (sell * pv + cash)) / pb + 1e-9);
    if (sell) lines.push({ ticker: ctx.cfg.coreTicker, bucket: 'core', shares: -sell, reason: '核心比例' });
    if (buy) lines.push({ ticker: ctx.bondTicker, bucket: 'core', shares: buy, reason: '核心比例' });
  } else {
    const buy = Math.floor(-check.move / pv + 1e-9);
    const sell = Math.min(ctx.bondShares, Math.ceil(Math.max(0, (buy * pv) / BUY_CASH_FRACTION - cash) / pb - 1e-9));
    // 短債不夠賣（那一邊大多是現金）→ 買得起多少買多少
    const afford = Math.min(buy, Math.floor((BUY_CASH_FRACTION * (sell * pb + cash)) / pv + 1e-9));
    if (sell) lines.push({ ticker: ctx.bondTicker, bucket: 'core', shares: -sell, reason: '核心比例' });
    if (afford) lines.push({ ticker: ctx.cfg.coreTicker, bucket: 'core', shares: afford, reason: '核心比例' });
  }
  return { check, lines };
}

/**
 * 核心吸收差額（allocation_redesign §1.2；取代設計 §2.1 資金流規則 1、2）：
 *   清單做完有多的錢（其他桶賣出的、入金補完各格剩下的）→ 交給核心，照比例買核心 ETF 與短債（coreSplit）；
 *     金額不到總資產 orderMin 的那一行不列，錢留在帳上（算短債那一邊）。
 *   月報（sweepCash）：帳上原本的現金順便買成短債。
 *   錢不夠 → 從核心照比例拿，帳上現金先用（coreSplit）；核心也不夠付 → 買單從最後一行往回減（C14）。
 * 買單合計不超過「現金＋賣單」的 98%，留緩衝給價格差。
 */
export function composeWithCore(lines0: OrderLine[], ctx: CoreContext): Composed {
  const { cfg } = ctx;
  const reserve = ctx.reserveCash ?? 0;
  const vooT = cfg.coreTicker;
  const bondT = ctx.bondTicker;
  const { bond } = coreCfg(cfg);
  const why = coreReasons(cfg, bondT);
  let lines = lines0;
  let capped: Composed['capped'];
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
  const min = cfg.orderMin * ctx.total;
  const coreLines: OrderLine[] = [];
  const pending = (ticker: string) => lines.filter((l) => l.ticker === ticker && l.bucket === 'core').reduce((a, l) => a + l.shares, 0);
  if (lines.length || (ctx.fresh ?? 0) > 0 || reserve > 0) {
    if (net - buffer > 0) {
      // 能投入的錢：其中「這份清單新進核心的」照比例分；其餘是帳上原本的現金，月報才順便買成短債
      const inv = net - buffer;
      const fresh = Math.max(0, Math.min(ctx.fresh ?? 0, ctx.cash));
      const split = Math.min(inv, Math.max(0, sells + fresh - buys - reserve));
      const idle = ctx.sweepCash ? inv - split : 0;
      const pv = ctx.price(vooT);
      const pb = ctx.price(bondT);
      const sp = coreSplit({ amount: split, bond, priceCore: pv, priceBond: pb });
      const b = Math.floor((split * bond + idle) / pb + 1e-9);
      if (sp.core && sp.core * pv >= min) coreLines.push({ ticker: vooT, bucket: 'core', shares: sp.core, reason: why.give });
      if (b && b * pb >= min) {
        if (sp.bond) coreLines.push({ ticker: bondT, bucket: 'core', shares: sp.bond, reason: why.give });
        if (b - sp.bond) coreLines.push({ ticker: bondT, bucket: 'core', shares: b - sp.bond, reason: why.sweep });
      }
    } else if (net < 0) {
      // 要從核心拿的總額 = 帳上現金先出的＋還缺的；還缺的部分多賣一點，留 98% 的緩衝
      const cash = Math.max(0, ctx.cash);
      const sp = coreSplit({
        amount: -(cash - net / BUY_CASH_FRACTION),
        bond,
        priceCore: ctx.price(vooT),
        priceBond: ctx.price(bondT),
        coreShares: ctx.coreShares + pending(vooT),
        bondShares: ctx.bondShares + pending(bondT),
        cash,
      });
      if (sp.bond) coreLines.push({ ticker: bondT, bucket: 'core', shares: sp.bond, reason: why.take });
      if (sp.core) coreLines.push({ ticker: vooT, bucket: 'core', shares: sp.core, reason: why.take });
      if (sp.short > 1e-6) {
        // C14：核心賣光了還不夠 → 買單合計壓在「現金＋賣單＋核心賣得」的 98% 以內，從最後一行往回減
        const coreSold = -(sp.bond * ctx.price(bondT) + sp.core * ctx.price(vooT));
        const budget = BUY_CASH_FRACTION * Math.max(0, cashAvail + coreSold - reserve);
        const kept = capLines(lines, budget, ctx.price);
        const out = lines.flatMap((l, k) => (kept[k].shares < l.shares ? [{ ticker: l.ticker, cut: l.shares - kept[k].shares }] : []));
        if (out.length) {
          lines = kept.filter((l) => l.shares !== 0);
          capped = out;
        }
      }
    }
  }
  const all = [...lines, ...coreLines];
  let cashAfter = ctx.cash - reserve;
  for (const l of all) cashAfter -= l.shares * ctx.price(l.ticker);
  return { lines: all, merged: mergeByTicker(all), cashAfter, ...(capped ? { capped } : {}) };
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
    // 帳上現金不算在這裡：現金由 composeWithCore 照一半一半交給核心
    const coreVal = ctx.coreShares * pv + ctx.bondShares * pb;
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
