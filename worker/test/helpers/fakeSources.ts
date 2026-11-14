// 測試用的假資料來源：SPY 持股檔與 Wikipedia 用 2026-11 抓的真實固定檔，Yahoo 日線用可重現的假價格。
// 每檔的價格 = p0 × exp(g × 交易日序號)，p0、g、成交量由代號決定，所以排名可以另外獨立算出來對照。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tradingDaysBetween } from '../../src/data/calendar';
import { SPY_HOLDINGS_URL, WIKI_SP500_URL, yahooSymbol, type Fetcher } from '../../src/data/sources';

const FIX = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
export const SPY_XLSX = new Uint8Array(readFileSync(join(FIX, 'spy-holdings-2026-11-10.xlsx')));
export const WIKI_TEXT = readFileSync(join(FIX, 'wiki-sp500-2026-11-11.txt'), 'utf8');

const ALL_DAYS = tradingDaysBetween('2023-01-03', '2027-12-31');
const ORD = new Map(ALL_DAYS.map((d, k) => [d, k]));

function hash(s: string, seed = 2166136261): number {
  let h = seed;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** 代號（Yahoo 的寫法，例如 BRK-B）→ 假價格的參數。 */
export function fakeParams(ticker: string): { p0: number; g: number; volume: number } {
  const sym = yahooSymbol(ticker);
  const h = hash(sym);
  return { p0: 20 + (h % 300), g: ((h % 20011) - 6000) / 1e7, volume: 1_000_000 + (hash(sym, 97) % 50_000_000) };
}
export function fakeClose(ticker: string, date: string): number {
  const { p0, g } = fakeParams(ticker);
  return p0 * Math.exp(g * ORD.get(date)!);
}

export interface World {
  /** 所有代號最新一根 K 線的日期。 */
  dataDate: string;
  /** 個別代號最新只到某一天（資料沒更新）。 */
  lastBar: Record<string, string>;
  /** 個別代號只有幾根 K 線（剛上市）。 */
  bars: Record<string, number>;
  /** Yahoo 回 500 的代號（Yahoo 的寫法）。 */
  fail: Set<string>;
  ssgaDown: boolean;
  wikiText: string;
  calls: string[];
  /** 個別代號從某一天起價格乘上一個倍數（Yahoo 的寫法；做暴跌用）。 */
  shock: Record<string, { from: string; factor: number }>;
}

export function newWorld(dataDate: string): World {
  return { dataDate, lastBar: {}, bars: {}, fail: new Set(), ssgaDown: false, wikiText: WIKI_TEXT, calls: [], shock: {} };
}

function yahooBody(sym: string, range: string, w: World) {
  const last = w.lastBar[sym] ?? w.dataDate;
  const n = Math.min(range === '5d' ? 5 : 501, w.bars[sym] ?? 501);
  const end = ORD.get(last);
  if (end === undefined) throw new Error(`假資料：${last} 不是交易日`);
  const days = ALL_DAYS.slice(Math.max(0, end - n + 1), end + 1);
  const { volume } = fakeParams(sym);
  const sh = w.shock[sym];
  const px = days.map((d) => fakeClose(sym, d) * (sh && d >= sh.from ? sh.factor : 1));
  // 14:30 UTC = 美東 09:30；gmtoffset 固定 -18000，換回來是同一天
  const ts = days.map((d) => Date.parse(d + 'T14:30:00Z') / 1000);
  return { chart: { result: [{ meta: { symbol: sym, currency: 'USD', gmtoffset: -18000 }, timestamp: ts, indicators: { quote: [{ open: px, high: px, low: px, close: px, volume: px.map(() => volume) }], adjclose: [{ adjclose: px }] } }], error: null } };
}

export function fakeFetcher(w: World): Fetcher {
  return async (url) => {
    w.calls.push(url);
    if (url === SPY_HOLDINGS_URL) return w.ssgaDown ? new Response('unavailable', { status: 503 }) : new Response(SPY_XLSX);
    if (url === WIKI_SP500_URL) return new Response(w.wikiText);
    const m = /\/chart\/([^?]+)\?range=(\w+)/.exec(url);
    if (m) {
      const sym = decodeURIComponent(m[1]);
      if (w.fail.has(sym)) return new Response('error', { status: 500 });
      return Response.json(yahooBody(sym, m[2], w));
    }
    throw new Error('測試沒有預期到的網址：' + url);
  };
}

/** 某一天 23:30 UTC（每日排程的時間）。 */
export const cronTime = (date: string) => new Date(date + 'T23:30:00Z');
