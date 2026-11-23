// 總經儀表板的純函式（core_ai §3.5；T11 原本寫在 ai/crash.ts，崩盤規則檢視 2026-11-22 退場後，T88 把留下來的這一半搬到這裡）。
// 市場摘要（app/marketBrief.ts）與網站「AI 紀錄」上方的儀表板用；抓取、儲存、01:30 重抓在 app/macro.ts。
import { sma, type MarketView } from '../engine';
import type { FredSeries } from '../data/fred';
import { MACRO_SERIES, MACRO_STALE_DAYS, TRUE_BEARS } from '../data/fred';

// ---------------------------------------------------------------- 儀表板

export interface DashRow {
  id: string;
  label: string;
  date: string | null;
  value: number | null;
  change6m: number | null;
  /** 衍生的數字（年增率、倒掛天數、相對 12 個月平均…）。 */
  derived: string | null;
  /** 過去真空頭開始時的值（現在修正後的數字）。崩盤規則檢視退場後沒有地方讀（儀表板文字與網站都不顯示）；照舊算、存，舊的儀表板相容（allocation_redesign §1.6）。 */
  atBears: Record<string, number | null>;
  note: string;
  /** 最新一筆觀察值距儀表板的日期太久（core_ai §3.5：日 10、週 21、月 75 個日曆天），不能當證據。舊的儀表板沒有這個欄位 = 沒過期。 */
  stale?: boolean;
}

/** 這個序列在 asOf 這天算不算過期（core_ai §3.5）。 */
export function isStale(id: string, date: string | null, asOf: string): boolean {
  const m = MACRO_SERIES.find((x) => x.id === id);
  if (!m || !date) return false;
  return (Date.parse(asOf) - Date.parse(date)) / 86400_000 > MACRO_STALE_DAYS[m.freq];
}

/** 總經資料夠不夠（core_ai §3.5）：可用 = 有值而且沒過期。10 個 ok、6～9 個 partial（寫明缺哪些）、0～5 個 missing（記 macro:retry，01:30 重抓；還是不足推 MACRO_MISSING）。 */
export type MacroQuality = 'ok' | 'partial' | 'missing';
export const MACRO_MIN_USABLE = 6;
export function macroUsable(rows: Pick<DashRow, 'value' | 'stale'>[]): number {
  return rows.filter((r) => r.value !== null && !r.stale).length;
}
export function macroQuality(rows: Pick<DashRow, 'value' | 'stale'>[]): MacroQuality {
  const n = macroUsable(rows);
  return n >= MACRO_SERIES.length ? 'ok' : n >= MACRO_MIN_USABLE ? 'partial' : 'missing';
}

function at(s: FredSeries, date: string): number | null {
  let v: number | null = null;
  for (let k = 0; k < s.dates.length && s.dates[k] <= date; k++) v = s.values[k];
  return v;
}

const minus = (date: string, days: number) => new Date(Date.parse(date) - days * 86400_000).toISOString().slice(0, 10);

/** 一張固定的表（每月都算）：目前值、6 個月變化、衍生數字、過去真空頭開始時的值。只用 asOf 以前的觀察值。 */
export function macroDashboard(series: Map<string, FredSeries>, asOf: string): DashRow[] {
  return MACRO_SERIES.map((m) => {
    const s = series.get(m.id);
    if (!s) return { id: m.id, label: m.label, date: null, value: null, change6m: null, derived: null, atBears: {}, note: `${m.note}（抓不到）` };
    let last = -1;
    for (let k = 0; k < s.dates.length && s.dates[k] <= asOf; k++) last = k;
    if (last < 0) return { id: m.id, label: m.label, date: null, value: null, change6m: null, derived: null, atBears: {}, note: m.note };
    const date = s.dates[last];
    const value = s.values[last];
    const v6 = at(s, minus(date, 182));
    let derived: string | null = null;
    if (m.id === 'T10Y3M' && value < 0) {
      let k = last;
      while (k > 0 && s.values[k - 1] < 0) k--;
      derived = `倒掛 ${Math.round((Date.parse(date) - Date.parse(s.dates[k])) / 86400_000)} 天（從 ${s.dates[k]}）`;
    }
    if (m.id === 'UNRATE') {
      const xs = s.values.slice(Math.max(0, last - 11), last + 1);
      derived = `12 個月平均 ${(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2)}`;
    }
    if (m.id === 'ICSA') {
      const four = s.values.slice(Math.max(0, last - 3), last + 1);
      const avg = four.reduce((a, b) => a + b, 0) / four.length;
      const lows: number[] = [];
      for (let k = Math.max(3, last - 51); k <= last; k++) lows.push((s.values[k] + s.values[k - 1] + s.values[k - 2] + s.values[k - 3]) / 4);
      const low = Math.min(...lows);
      derived = `4 週平均 ${Math.round(avg / 1000)}k，比 52 週低點高 ${((avg / low - 1) * 100).toFixed(1)}%`;
    }
    if (m.id === 'RRSFS' || m.id === 'INDPRO') {
      const y = at(s, minus(date, 365));
      if (y) derived = `年增 ${((value / y - 1) * 100).toFixed(1)}%`;
    }
    const atBears: Record<string, number | null> = {};
    for (const b of TRUE_BEARS) atBears[b] = at(s, `${b}-01`);
    return { id: m.id, label: m.label, date, value, change6m: v6 === null ? null : value - v6, derived, atBears, note: m.note, stale: isStale(m.id, date, asOf) };
  });
}

/** 市場廣度：市值前 50 大（排名用的股票池）裡收盤在 200 日均線之上的比例。 */
export function breadth(view: MarketView, tickers: string[]): { above: number; n: number } {
  let above = 0;
  let n = 0;
  for (const t of tickers) {
    const c = view.close[t];
    if (!c || !Number.isFinite(c[view.i])) continue;
    const ma = sma(c, view.i, 200);
    if (!Number.isFinite(ma)) continue;
    n++;
    if (c[view.i] > ma) above++;
  }
  return { above, n };
}

export function dashboardText(rows: DashRow[], br: { above: number; n: number } | null, core: { ticker: string; close: number; ma: number } | null): string {
  const f = (x: number | null, d = 2) => (x === null || !Number.isFinite(x) ? '-' : x.toFixed(d));
  const lines = ['series | date | value | 6m change | derived | note'];
  // 過期的列在 note 後面寫明（core_ai §3.5）
  for (const r of rows) lines.push(`${r.id} ${r.label} | ${r.date ?? '-'} | ${f(r.value)} | ${f(r.change6m)} | ${r.derived ?? '-'} | ${r.note}${r.stale ? `（資料停在 ${r.date}，不能當證據）` : ''}`);
  if (br) lines.push(`breadth | | ${br.n ? ((br.above / br.n) * 100).toFixed(0) : '-'}% of top-50 universe above 200-day MA (${br.above}/${br.n}) | | | computed from stored prices`);
  if (core) lines.push(`${core.ticker} | | close ${core.close.toFixed(2)} vs 200-day MA ${core.ma.toFixed(2)} (${((core.close / core.ma - 1) * 100).toFixed(1)}%) | | |`);
  return lines.join('\n');
}

