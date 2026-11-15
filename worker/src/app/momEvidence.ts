// T32b：動能的證據由一個函式組（momentum_ai_design_2026-11-15 §3.1，修 Q18、Q19、Q9）。
// F1 的規則偵測與法庭、F19 對動能持股的法庭都用它（§3.6 的大跌那一行在 T32d）。即時組出來，不存成物件。
//
//   申報清單：365 天內、決策日以前；抓不到 → dataQuality.filings = missing、filingsMissing（呼叫端不能把它當成「沒有命中」）
//   命中：規則偵測（被收購方、NT、4.02、會計師辭任、增資、單日跳漲、EPS 背離、股數、資料可疑）
//         ＋ sec_events 轉來的（每日掃描與進場前回看標的：三種候選、申報來的財測下修；不看狀態）
//         每筆帶 basis：申報 FILING、新聞標題 NEWS、程式算的 CALC
//   原文：一份法庭的證據包最多 6 份申報原文；放不下的寫進 omitted、備註加「略過 N 份：…」
import type { PackDoc } from '../ai/check';
import { JUMP_SHARE, earningsDivergence, epsQuarters, jumpMetrics, oneOffJump, shareGrowth, suspectMoves } from '../ai/detect';
import { courtHits, type EntryHit } from '../ai/momEntry';
import { fetchCompanyFacts, fetchFilingDoc, quarterTable } from '../data/edgar';
import { HIT_WINDOW, activeHits, classifyFilings, fetchConcept, fetchPrimaryText, needsCover, quickHits, type FilingHit } from '../data/secEvents';
import { fetchEdgarSubmissions, type Filing } from '../data/sources';
import { errText } from '../data/util';
import type { MarketView } from '../engine';
import type { Env, Fetcher } from './env';
import { accOf, cikFor, loadEvents, type SecEventRow } from './filings';
import { docOf, newsDoc, xbrlDoc } from './ownAi';

/** 一份法庭的證據包最多幾份申報原文（§3.1）。 */
export const MOM_DOC_MAX = 6;
/** sec_events 轉來的命中往回看幾天（event_date）：三種候選照 HIT_WINDOW，財測下修 100 天。 */
export const GUIDANCE_CUT_DAYS = 100;
const DAY = 86400_000;
const CANDIDATE_CODES = ['ACCOUNTING', 'REGULATORY', 'PENDING_MA'];

export interface MomEvidence {
  cik: string | null;
  /** 365 天內、決策日以前的申報。 */
  filings: Filing[];
  hits: EntryHit[];
  /** 這一檔 180 天內的 sec_events（含 INFO），顯示用。 */
  events: SecEventRow[];
  /** want.docs 時：命中對應的申報原文、EPS 表、新聞標題。 */
  docs: PackDoc[];
  /** want.xbrlTable 時：XBRL 季度表（F19 的重大性數字）。 */
  xbrl: PackDoc | null;
  /** 因為上限沒放進去的申報（「8-K 2027-01-06」）。 */
  omitted: string[];
  dataQuality: Record<string, 'ok' | 'partial' | 'missing'>;
  notes: string[];
  r12: number;
  /** 申報清單抓不到時的原因。 */
  filingsMissing?: string;
}

export interface MomWant {
  docs: boolean;
  xbrlTable: boolean;
  /** 跑規則偵測（預設 true）。F19 只要申報原文與 XBRL 表，不用重新偵測。 */
  hits?: boolean;
  /** F19：只取這幾份申報的原文（sec_events.accession；edgar: 前綴可有可無），不看命中。 */
  focus?: string[];
  /** 附新聞標題（預設 = docs）。 */
  news?: boolean;
}

const toEntryHit = (h: FilingHit): EntryHit => ({ code: h.code, sub: h.sub, detail: h.detail ?? h.sub, date: h.date, byRule: h.byRule, displayOnly: h.displayOnly, accession: h.accession, basis: 'FILING' });

/**
 * sec_events 轉來的命中（§3.1 的表）：這一檔、source = SCAN、不看狀態。
 *   ACCOUNTING、REGULATORY、PENDING_MA（掃描的三種候選）→ 同一個代碼，往回看 180、180、365 天
 *   GUIDANCE_CUT、細項 CUT 或 WITHDRAWN、來源是申報 → EARNINGS_DIVERGENCE（SCAN_GUIDANCE_CUT），往回看 100 天
 * 申報來的 basis = FILING，新聞標題來的 NEWS。同一份來源、同一細項只算一次。
 */
export function scanEventHits(events: Pick<SecEventRow, 'source' | 'code' | 'sub' | 'detail' | 'event_date' | 'accession' | 'form' | 'detail_code'>[], asOf: string): EntryHit[] {
  const out = new Map<string, EntryHit>();
  const t = Date.parse(asOf);
  for (const e of events) {
    if (e.source !== 'SCAN' || e.event_date > asOf) continue;
    const age = (t - Date.parse(e.event_date)) / DAY;
    const basis = accOf(e.accession).kind === 'FILING' ? 'FILING' : 'NEWS';
    let hit: EntryHit | null = null;
    if (CANDIDATE_CODES.includes(e.code) && age <= (HIT_WINDOW[e.code] ?? 180)) hit = { code: e.code, sub: e.sub, detail: e.detail ?? e.sub, date: e.event_date, byRule: false, accession: e.accession, basis };
    else if (e.code === 'GUIDANCE_CUT' && ['CUT', 'WITHDRAWN'].includes(e.detail_code ?? '') && e.form !== 'NEWS' && basis === 'FILING' && age <= GUIDANCE_CUT_DAYS)
      hit = { code: 'EARNINGS_DIVERGENCE', sub: 'SCAN_GUIDANCE_CUT', detail: e.detail ?? '掃描標記：財測下修', date: e.event_date, byRule: false, accession: e.accession, basis: 'FILING' };
    if (hit) out.set(`${hit.code}|${hit.sub}|${hit.accession}`, hit);
  }
  return [...out.values()];
}

/** 這份申報給人讀的樣子（「8-K 2027-01-06」）。 */
const fileLabel = (f: Filing) => `${f.form} ${f.filingDate}`;

/** 一檔動能股的證據（§3.1）。 */
export async function momEvidence(env: Env, fetcher: Fetcher, view: MarketView, axis: string[], ticker: string, benchmark: string, want: MomWant): Promise<MomEvidence> {
  const ua = env.EDGAR_USER_AGENT ?? '';
  const asOf = view.date;
  const withHits = want.hits !== false;
  const out: MomEvidence = { cik: null, filings: [], hits: [], events: [], docs: [], xbrl: null, omitted: [], dataQuality: {}, notes: [], r12: NaN };
  const c = view.close[ticker];
  if (withHits) {
    const jm = c && view.close[benchmark] ? jumpMetrics(c, view.close[benchmark], view.i) : null;
    out.r12 = jm?.r12 ?? NaN;
    const jump = oneOffJump(jm);
    if (jm && jump?.hit) {
      // 最大單日（或 3 日）的日期（證據指紋用，§3.4）
      const hit1 = jm.j1Share !== null && jm.j1Share > JUMP_SHARE && jm.j1Post !== null && jm.j1Post <= 0;
      const ago = hit1 ? jm.j1Ago : jm.j3Ago;
      out.hits.push({ code: 'ONE_OFF_JUMP', sub: 'JUMP_SHARE', detail: jump.detail, date: axis[view.i - ago] ?? undefined, byRule: false, basis: 'CALC' });
    }
  }
  try {
    out.cik = await cikFor(env, fetcher, ticker);
    if (!out.cik || !ua) throw new Error(out.cik ? '沒有設定 EDGAR 的 User-Agent' : '找不到 CIK');
    const sub = await fetchEdgarSubmissions(fetcher, out.cik, ua);
    const since = new Date(Date.parse(asOf) - 365 * DAY).toISOString().slice(0, 10);
    out.filings = sub.filings.filter((f) => f.filingDate <= asOf && f.filingDate >= since);
    if (withHits) {
      const want0 = out.filings.filter((f) => quickHits(f).length || needsCover(f));
      const hits = activeHits(await classifyFilings(fetcher, out.cik, [sub.name, ...sub.formerNames], want0, ua, out.notes), asOf);
      out.hits.push(...hits.filter((h) => !(h.displayOnly && h.code !== 'DILUTION')).map(toEntryHit));
    }
    out.dataQuality.filings = 'ok';
  } catch (e) {
    out.notes.push(`申報：${errText(e)}`);
    out.dataQuality.filings = 'missing';
    out.filingsMissing = errText(e);
  }
  const cik = out.cik && ua ? out.cik : null;
  if (withHits) {
    if (c) {
      const sus = suspectMoves(c, axis, view.i, out.filings.map((f) => f.filingDate));
      if (sus.length) out.hits.push({ code: 'DATA_SUSPECT', sub: 'PRICE_JUMP_NO_FILING', detail: `日變動超過 25%、前後一天沒有申報：${sus.join('、')}`, byRule: true, basis: 'CALC' });
    }
    if (cik) {
      try {
        const qs = epsQuarters(await fetchConcept(fetcher, cik, 'us-gaap', 'EarningsPerShareDiluted', ua), asOf);
        const d = earningsDivergence(qs, out.r12);
        if (d?.hit) out.hits.push({ code: 'EARNINGS_DIVERGENCE', sub: 'EPS_DOWN_PRICE_UP', detail: d.detail, date: qs[0].end, byRule: false, basis: 'CALC' });
        if (qs.length && want.docs) out.docs.push({ id: `E-${ticker}`, source_id: `xbrl:${ticker}:eps`, kind: 'xbrl', date: qs[0].filed, title: `${ticker} 稀釋 EPS（XBRL，每期最早申報的值）`, text: qs.map((q) => `${q.end} EPS diluted ${q.eps.toFixed(2)} (filed ${q.filed}${q.derived ? ', Q4 derived = annual - 9M' : ''})`).join('\n') });
        out.dataQuality.xbrl = 'ok';
      } catch (e) {
        out.notes.push(`EPS：${errText(e)}`);
        out.dataQuality.xbrl = 'missing';
      }
      try {
        const g = shareGrowth(await fetchConcept(fetcher, cik, 'dei', 'EntityCommonStockSharesOutstanding', ua), asOf);
        if (g && g.growth > 0.05) out.hits.push({ code: 'DILUTION', sub: 'SHARES_6M', detail: `流通股數 6 個月增加 ${(g.growth * 100).toFixed(1)}%`, byRule: true, displayOnly: true, basis: 'CALC' });
      } catch (e) {
        out.notes.push(`股數：${errText(e)}`);
      }
    }
  }
  const since180 = new Date(Date.parse(asOf) - 180 * DAY).toISOString().slice(0, 10);
  const since365 = new Date(Date.parse(asOf) - 365 * DAY).toISOString().slice(0, 10);
  const evs = await loadEvents(env.DB, { ticker, since: since365 });
  out.events = evs.filter((e) => e.event_date >= since180);
  if (withHits) out.hits.push(...scanEventHits(evs, asOf));

  if (want.docs && cik) {
    // 要讀原文的申報：F19 照 focus；F1 是要法庭判斷的命中對應的申報（新到舊），有盈餘或財測背離時加最近一份 8-K 2.02
    const byAcc = new Map(out.filings.map((f) => [f.accession, f]));
    const newest = (a: Filing, b: Filing) => (a.filingDate === b.filingDate ? (a.acceptedAt < b.acceptedAt ? 1 : -1) : a.filingDate < b.filingDate ? 1 : -1);
    let pick: Filing[];
    if (want.focus) {
      const accs = new Set(want.focus.map((a) => accOf(a)).flatMap((r) => (r.kind === 'FILING' ? [r.acc] : [])));
      pick = out.filings.filter((f) => accs.has(f.accession)).sort(newest);
    } else {
      const court = courtHits(out.hits);
      const accs = new Set(court.map((h) => accOf(h.accession)).flatMap((r) => (r.kind === 'FILING' ? [r.acc] : [])));
      pick = [...accs].map((a) => byAcc.get(a)).filter((f): f is Filing => !!f).sort(newest);
      const pr = [...out.filings].sort(newest).find((f) => f.form.startsWith('8-K') && f.items.includes('2.02'));
      if (pr && court.some((h) => h.code === 'EARNINGS_DIVERGENCE') && !pick.includes(pr)) pick.push(pr);
    }
    const keep = pick.slice(0, MOM_DOC_MAX);
    out.omitted = pick.slice(MOM_DOC_MAX).map(fileLabel);
    if (out.omitted.length) out.notes.push(`略過 ${out.omitted.length} 份：${out.omitted.join('、')}（一份證據包最多 ${MOM_DOC_MAX} 份申報原文）`);
    for (const f of keep) {
      try {
        if (out.docs.some((d) => d.source_id === `edgar:${f.accession}`)) continue;
        if (f.form.startsWith('8-K')) out.docs.push(docOf(await fetchFilingDoc(fetcher, cik, f, ua)));
        else {
          const p = await fetchPrimaryText(fetcher, cik, f, ua, 40_000);
          out.docs.push({ id: `F-${f.accession}`, source_id: `edgar:${f.accession}`, kind: 'filing', date: f.filingDate, title: `${f.form} ${f.filingDate}（開頭）`, url: p.url, text: p.text });
        }
      } catch (e) {
        out.notes.push(`${f.form} ${f.accession} 抓不到：${errText(e)}`);
      }
    }
  }
  if (want.docs && (want.news ?? true)) {
    try {
      const n = await newsDoc(fetcher, ticker, asOf);
      if (n) out.docs.push(n);
    } catch {
      // 新聞只有標題，抓不到不擋
    }
    out.dataQuality.news = 'partial';
  }
  if (want.xbrlTable && cik) {
    try {
      out.xbrl = xbrlDoc(ticker, quarterTable(await fetchCompanyFacts(fetcher, cik, ua), asOf));
      out.dataQuality.xbrl = out.xbrl ? 'ok' : 'missing';
    } catch (e) {
      out.dataQuality.xbrl = 'missing';
      out.notes.push(`XBRL：${errText(e)}`);
    }
  }
  return out;
}
