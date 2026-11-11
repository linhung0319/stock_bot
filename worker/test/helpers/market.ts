// 測試用的假市場：prototype/js/market.js 與 scenarios.js 的產生器移植過來（可重現的亂數，價格全部虛構）。
// 每段用「布朗橋」：雜訊照產生，但整段的總報酬固定成指定值，所以情境可以精確控制排名、距高點、均線。
import type { MarketView } from '../../src/engine';

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(r: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = r();
  while (v === 0) v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
const iso = (dt: Date) => dt.toISOString().slice(0, 10);
const HOLIDAYS = new Set(['2026-11-26', '2026-12-25', '2027-01-01', '2027-01-18', '2027-02-15', '2027-04-02', '2026-09-07', '2026-07-03', '2026-05-25', '2026-06-19']);
function tradingDays(startIso: string, nBefore: number, nAfter: number): string[] {
  const start = new Date(startIso + 'T00:00:00Z');
  const before: string[] = [];
  let dt = new Date(start);
  while (before.length < nBefore) {
    dt.setUTCDate(dt.getUTCDate() - 1);
    const wd = dt.getUTCDay();
    if (wd !== 0 && wd !== 6 && !HOLIDAYS.has(iso(dt))) before.push(iso(dt));
  }
  const out = before.reverse();
  dt = new Date(start);
  while (out.length < nBefore + nAfter) {
    const wd = dt.getUTCDay();
    if (wd !== 0 && wd !== 6 && !HOLIDAYS.has(iso(dt))) out.push(iso(dt));
    dt.setUTCDate(dt.getUTCDate() + 1);
  }
  return out;
}

export const PRE = 330;
export const UNIVERSE = ['MU', 'NVDA', 'MSFT', 'META', 'AAPL', 'AMZN', 'GOOGL', 'AVGO', 'TSLA', 'LLY', 'JPM', 'V', 'XOM', 'UNH', 'COST', 'NFLX', 'ORCL', 'AMD', 'WMT', 'PLTR', 'APP', 'GE', 'GS', 'CAT', 'IBM', 'KO'];

interface Seg {
  n: number;
  ret: number;
  vol?: number;
}
interface TickerSpec {
  p0: number;
  vol: number;
  r252: number;
  hist: Seg[];
  path: Seg[];
}
export interface Over {
  p0?: number;
  vol?: number;
  r252?: number;
  hist?: Seg[];
  path?: Seg[];
  alpha?: number;
}
export interface MarketOptions {
  market?: Seg[];
  over?: Record<string, Over>;
  noise?: number;
  seed?: number;
}

// 情境開始前一天的價格、過去 252 日報酬、年化波動、beta
const BASE: Record<string, [number, number, number, number]> = {
  VOO: [610, 0.14, 0.16, 1], SGOV: [100.4, 0.045, 0.004, 0],
  PLTR: [180, 1.4, 0.55, 1.6], APP: [600, 1.13, 0.6, 1.7], AVGO: [340, 0.85, 0.4, 1.4], GE: [290, 0.7, 0.3, 1.1],
  NFLX: [115, 0.62, 0.35, 1.1], AMD: [240, 0.58, 0.5, 1.6], GS: [780, 0.5, 0.3, 1.2], MU: [240, 0.45, 0.5, 1.6],
  NVDA: [185, 0.4, 0.45, 1.6], GOOGL: [280, 0.35, 0.3, 1.1], CAT: [520, 0.3, 0.3, 1.0], JPM: [300, 0.28, 0.25, 1.0],
  META: [640, 0.25, 0.35, 1.3], TSLA: [420, 0.24, 0.6, 1.8], ORCL: [210, 0.22, 0.4, 1.3], MSFT: [505, 0.2, 0.25, 1.1],
  IBM: [290, 0.18, 0.25, 0.8], WMT: [100, 0.15, 0.2, 0.5], COST: [900, 0.12, 0.2, 0.6], AAPL: [270, 0.13, 0.28, 1.1],
  V: [340, 0.1, 0.2, 0.9], AMZN: [230, 0.08, 0.32, 1.2], LLY: [1000, 0.05, 0.3, 0.5], KO: [70, 0.04, 0.15, 0.4],
  XOM: [115, 0.02, 0.25, 0.6], UNH: [330, -0.25, 0.35, 0.6],
};

export interface Market {
  days: string[];
  idx0: number;
  close: Record<string, number[]>;
  open: Record<string, number[]>;
  universe: string[];
}

function bridge(r: () => number, n: number, totalRet: number, annVol: number): number[] {
  const dv = annVol / Math.sqrt(252);
  const z: number[] = [];
  for (let i = 0; i < n; i++) z.push(gauss(r) * dv);
  const m = z.reduce((a, b) => a + b, 0) / n;
  const target = Math.log(1 + totalRet) / n;
  return z.map((x) => x - m + target);
}

export function makeMarket(start: string, nAfter: number, opt: MarketOptions = {}): Market {
  const mkt = opt.market ?? [{ n: nAfter, ret: (0.1 * nAfter) / 252 }];
  const seed = opt.seed ?? 7;
  const days = tradingDays(start, PRE, nAfter);
  const close: Record<string, number[]> = {};
  const open: Record<string, number[]> = {};
  for (const [tk, [p0b, r252b, volb, beta]] of Object.entries(BASE)) {
    const o = opt.over?.[tk] ?? {};
    const vol = o.vol || volb * (opt.noise ?? 0.5);
    const t: TickerSpec = {
      p0: o.p0 || p0b,
      vol,
      r252: o.r252 === undefined ? r252b : o.r252,
      hist: [],
      path: [],
    };
    t.hist = o.hist ?? [
      { n: PRE - 252, ret: 0.04, vol },
      { n: 252, ret: t.r252, vol },
    ];
    if (o.path) t.path = o.path;
    else if (tk === 'SGOV') t.path = [{ n: nAfter, ret: (0.045 * nAfter) / 252, vol: 0.004 }];
    else t.path = mkt.map((s) => ({ n: s.n, ret: Math.pow(1 + s.ret, beta) * (1 + ((o.alpha ?? 0) * s.n) / 252) - 1, vol: s.vol === undefined ? vol : s.vol * (tk === 'VOO' ? 0.4 : 1) }));
    const r = rng(hashStr(tk + ':' + seed));
    const rets = [0];
    const gaps = [0];
    for (const s of [...t.hist, ...t.path]) {
      if (s.vol === 0 || s.n === 1) {
        for (let i = 0; i < s.n; i++) {
          rets.push(Math.log(1 + s.ret) / s.n);
          gaps.push(0.9);
        }
      } else {
        for (const x of bridge(r, s.n, s.ret, s.vol === undefined ? t.vol : s.vol)) {
          rets.push(x);
          gaps.push(0.35);
        }
      }
    }
    const dv = t.vol / Math.sqrt(252);
    while (rets.length < days.length) {
      rets.push(Math.log(1.08) / 252 + gauss(r) * dv);
      gaps.push(0.35);
    }
    const c = [1];
    for (let i = 1; i < days.length; i++) c.push(c[i - 1] * Math.exp(rets[i]));
    const scale = t.p0 / c[PRE - 1];
    const cc = c.map((x) => x * scale);
    close[tk] = cc;
    open[tk] = cc.map((x, i) => (i === 0 ? x : cc[i - 1] * Math.exp(Math.log(cc[i] / cc[i - 1]) * gaps[i])));
  }
  return { days, idx0: PRE, close, open, universe: UNIVERSE };
}

/** 第 i 個交易日收盤後看到的市場。 */
export function viewAt(m: Market, i: number): MarketView {
  return { date: m.days[i], i, close: m.close };
}

/** 股票池照 252 日報酬由高到低。removed：已經掉出股票池的代號。 */
export function ranksAt(m: Market, i: number, removed: string[] = []): string[] {
  return m.universe
    .filter((t) => !removed.includes(t))
    .map((t) => ({ t, r: m.close[t][i] / m.close[t][i - 252] - 1 }))
    .sort((a, b) => b.r - a.r)
    .map((x) => x.t);
}
