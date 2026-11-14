// T11：F5／F6 崩盤規則的 AI 檢視（ai_layer_design F5／F6 卡片、§3.3、§9.2；design_v2 §4.4）。
// 權限 A2：只說明＋記影子，不能否決或延後；LINE 只附一行「AI 檢視：照做／延後」。
// 純函式：總經儀表板（程式算好）、基準率表、證據包、檢查、結論。資料抓取與排程在 src/app/crashAi.ts。
import { sma, type MarketView } from '../engine';
import type { FredSeries } from '../data/fred';
import { MACRO_SERIES, TRUE_BEARS } from '../data/fred';
import type { CheckedSample, EvidencePack, Outcome, PackDoc, PackPremise } from './check';
import { buildPack } from './pack';

export const CRASH_REVIEW = 'CRASH_REVIEW';
export const CRASH_REVIEW_PROMPT = 'crash_review_v1';

/** §3.3：2000–2026 每次啟動（SPY 代替 VOO）。 */
export const CRASH_EPISODES: { on: string; off: string; months: number; gap: number; buyBack: number; low: number }[] = [
  { on: '2000-10', off: '2002-04', months: 18, gap: -0.005, buyBack: -0.193, low: -0.317 },
  { on: '2002-05', off: '2003-05', months: 12, gap: -0.043, buyBack: -0.134, low: -0.271 },
  { on: '2008-01', off: '2009-06', months: 17, gap: -0.01, buyBack: -0.341, low: -0.524 },
  { on: '2010-06', off: '2010-10', months: 4, gap: -0.006, buyBack: 0.072, low: -0.052 },
  { on: '2011-09', off: '2012-01', months: 4, gap: -0.044, buyBack: 0.057, low: -0.096 },
  { on: '2015-09', off: '2015-11', months: 2, gap: -0.042, buyBack: 0.084, low: -0.021 },
  { on: '2016-01', off: '2016-04', months: 3, gap: -0.001, buyBack: 0.025, low: -0.088 },
  { on: '2018-11', off: '2018-12', months: 1, gap: -0.014, buyBack: 0.032, low: -0.031 },
  { on: '2019-01', off: '2019-03', months: 2, gap: -0.08, buyBack: 0.14, low: -0.007 },
  { on: '2019-06', off: '2019-07', months: 1, gap: -0.001, buyBack: 0.083, low: -0.003 },
  { on: '2020-03', off: '2020-06', months: 3, gap: -0.021, buyBack: 0.024, low: -0.248 },
  { on: '2022-03', off: '2022-04', months: 1, gap: -0.015, buyBack: 0.045, low: -0.043 },
  { on: '2022-05', off: '2022-12', months: 7, gap: -0.076, buyBack: 0, low: -0.127 },
  { on: '2023-01', off: '2023-02', months: 1, gap: -0.036, buyBack: 0.054, low: -0.013 },
  { on: '2023-11', off: '2023-12', months: 1, gap: -0.006, buyBack: 0.087, low: 0.008 },
  { on: '2025-04', off: '2025-06', months: 2, gap: -0.02, buyBack: 0.054, low: -0.109 },
  { on: '2026-04', off: '2026-05', months: 1, gap: -0.012, buyBack: 0.103, low: 0.002 },
];

export function baseRateText(): string {
  const p = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;
  return [
    '2000-2026: crash rule switched ON 17 times. 3 were true bear markets (bought back 13-34% cheaper), 1 flat, 13 bought back higher (+2% to +14%).',
    'Prior probability that a switch-on is a true bear: about 18%. All 3 true bears lasted 12+ months; 7 of the 13 false alarms lasted 1 month.',
    'Distance below the 200-day average at the trigger does not separate true from false (true: -0.5%, -4.3%, -1.0%; false: -0.1% to -8.0%).',
    'ON | OFF | months | gap to MA | buy-back vs sell | lowest vs sell',
    ...CRASH_EPISODES.map((e) => `${e.on} | ${e.off} | ${e.months} | ${p(e.gap)} | ${p(e.buyBack)} | ${p(e.low)}`),
  ].join('\n');
}

// ---------------------------------------------------------------- 儀表板

export interface DashRow {
  id: string;
  label: string;
  date: string | null;
  value: number | null;
  change6m: number | null;
  /** 衍生的數字（年增率、倒掛天數、相對 12 個月平均…）。 */
  derived: string | null;
  /** 過去真空頭開始時的值（現在修正後的數字）。 */
  atBears: Record<string, number | null>;
  note: string;
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
    return { id: m.id, label: m.label, date, value, change6m: v6 === null ? null : value - v6, derived, atBears, note: m.note };
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
  const lines = ['series | date | value | 6m change | derived | at bear starts (' + TRUE_BEARS.join(', ') + ', revised values) | note'];
  for (const r of rows) lines.push(`${r.id} ${r.label} | ${r.date ?? '-'} | ${f(r.value)} | ${f(r.change6m)} | ${r.derived ?? '-'} | ${TRUE_BEARS.map((b) => f(r.atBears[b] ?? null)).join(' / ')} | ${r.note}`);
  if (br) lines.push(`breadth | | ${br.n ? ((br.above / br.n) * 100).toFixed(0) : '-'}% of top-50 universe above 200-day MA (${br.above}/${br.n}) | | | | computed from stored prices`);
  if (core) lines.push(`${core.ticker} | | close ${core.close.toFixed(2)} vs 200-day MA ${core.ma.toFixed(2)} (${((core.close / core.ma - 1) * 100).toFixed(1)}%) | | | |`);
  return lines.join('\n');
}

// ---------------------------------------------------------------- 證據包

export type CrashDirection = 'ON' | 'OFF' | 'NONE';

const PREMISES: Record<CrashDirection, PackPremise[]> = {
  ON: [
    { id: 'P1', text: '這次跌破反映的是持續一年以上的空頭（通常伴隨衰退、信用緊縮、企業盈餘下修），不是一兩個月的修正', origin: 'SYSTEM_DEFAULT' },
    { id: 'P2', text: '趨勢會延續（跌破後繼續下跌的機率高於反轉）', origin: 'SYSTEM_DEFAULT' },
  ],
  OFF: [{ id: 'P3', text: '空頭已結束，站回均線不是空頭中的反彈', origin: 'SYSTEM_DEFAULT' }],
  NONE: [],
};

export interface CrashInput {
  runId: string;
  asOf: string;
  direction: CrashDirection;
  dashboard: PackDoc;
  news: PackDoc | null;
  facts: EvidencePack['facts'];
  dataQuality: EvidencePack['data_quality'];
  now: Date;
}

export function crashPack(inp: CrashInput) {
  const full = inp.direction !== 'NONE';
  const q = full
    ? inp.direction === 'ON'
      ? '核心 ETF 收盤跌破 200 日均線，崩盤規則要啟動（核心一半換短債、動能減半）。'
      : '核心 ETF 回到 200 日均線之上，崩盤規則要解除（短債換回核心、動能恢復）。'
    : '這個月崩盤規則不會切換。請讀總經儀表板寫一段評語，並估「12 個月內出現持續一年以上空頭」的機率（payload.bear_prob，0～1）。這份評語只記錄，用來事後檢查 AI 是不是只跟著近期漲跌走。';
  return buildPack({
    runId: inp.runId,
    fn: CRASH_REVIEW,
    promptVersion: CRASH_REVIEW_PROMPT,
    asOf: inp.asOf,
    subject: { name: full ? `崩盤規則${inp.direction === 'ON' ? '啟動' : '解除'}檢視` : '每月總經評語' },
    question:
      q +
      (full
        ? '報告第一段固定寫基準率（過去 17 次啟動中 3 次是真空頭）。正方寫照規則做的理由，反方寫這次只是修正（或空頭中的反彈）的理由，法官逐條判前提，最後給「照做（FOLLOW）」或「延後（DELAY）」的意見。' +
          '提醒：2000、2008 這種空頭開始時，新聞看起來通常也像「這次只是修正」。AI 的意見只記錄、不能改變規則的動作。'
        : ''),
    policy: full ? { level: 'A2', verdicts: ['FOLLOW', 'DELAY', 'INSUFFICIENT'], abstain: 'INSUFFICIENT', min_evidence: 0, samples: 3 } : { level: 'A1', verdicts: ['NOTED', 'INSUFFICIENT'], abstain: 'INSUFFICIENT', min_evidence: 0, samples: 1 },
    rule: { action: full ? (inp.direction === 'ON' ? '崩盤規則啟動' : '崩盤規則解除') : '崩盤規則不切換', detail: { direction: inp.direction } },
    facts: inp.facts,
    premises: PREMISES[inp.direction],
    documents: [{ id: 'BASE', source_id: 'base-rate:crash', kind: 'table', date: inp.asOf, title: '崩盤規則 2000–2026 每次啟動的結果（基準率）', text: baseRateText() }, inp.dashboard, inp.news].filter((d): d is PackDoc => !!d),
    dataQuality: inp.dataQuality,
    conditionTypes: ['fred_above', 'fred_below', 'price_close_above', 'price_close_below', 'ma_cross_above', 'ma_cross_below', 'date_after'],
    now: inp.now,
  });
}

/** bear_prob 在 0～1；意見（opinion）和 verdict 一致。 */
export function checkCrashPayload(s: CheckedSample, pack: EvidencePack): void {
  const p = s.payload ?? {};
  if (p.bear_prob !== undefined && (typeof p.bear_prob !== 'number' || p.bear_prob < 0 || p.bear_prob > 1)) {
    s.issues.push('bear_prob 要是 0～1 的數字，不採用');
    s.payload = { ...p, bear_prob: null };
  }
  if ((pack.rule.detail as { direction?: string })?.direction !== 'NONE' && p.opinion !== undefined && p.opinion !== s.rawVerdict) s.issues.push(`payload.opinion（${String(p.opinion)}）和 verdict 不同`);
}

/** 給月報的一行（只有 3 票一致才寫；其他只放網站）。 */
export function crashOpinionOf(outcome: Outcome | null): '照做' | '延後' | null {
  if (!outcome || outcome.status !== 'AGREED') return null;
  return outcome.verdict === 'FOLLOW' ? '照做' : outcome.verdict === 'DELAY' ? '延後' : null;
}
