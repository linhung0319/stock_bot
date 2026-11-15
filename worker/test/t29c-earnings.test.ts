// T29c：財報新聞稿當天確認條件（own_thesis §1.11、§3.6.2、§3.6.6 的 PRESS_MISMATCH）。
// 完成條件：
//   六項檢查各有一個「不過就不採用」的測試；成立時的通知文字有「依財報新聞稿」；要連續兩季的條件用擷取的本季加 XBRL 的上一季；
//   核對一致與不一致；CfoToNetIncome 的條件不開；同一批有 10-Q 時不開；EX-99.1 的取法用一份真實的財報新聞稿當測試資料。
// 財報新聞稿、8-K 本文、目錄與 XBRL 用 test/fixtures/edgar-press 的真實資料（Amazon 2026 年第三季，見那裡的 sources.json）；
// 三票是手寫的（引用照抄真實原文）；價格、雲端排程、LINE 是假的。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { judge, type EvidencePack, type PackDoc } from '../src/ai/check';
import { EARNINGS_ITEMS, OWN_EARNINGS, earningsDecision, earningsPack, figureInQuote, parseFigure, pressRow, type EarningsDetail } from '../src/ai/earnings';
import { PAYLOAD_HOOKS } from '../src/ai/hooks';
import type { ApplyCtx } from '../src/app/aiCtx';
import { finalizeRun, getRun, listRuns, type AiRun } from '../src/app/aiRuns';
import { applyOwnEarnings, pressWhy } from '../src/app/earningsAi';
import type { Env, Fetcher } from '../src/app/env';
import { runFlow, type Attempt } from '../src/app/flow';
import { LINE_PUSH_URL } from '../src/app/line';
import { loadAccount, saveAccount } from '../src/app/ledgerStore';
import { ownXbrlConditions } from '../src/app/ownAi';
import { dueAttention, loadConditions, ownAttention, thesisFile } from '../src/app/thesis';
import { PRESS_FALLBACK, PRESS_GAP, PRESS_HEAD, PRESS_STATEMENTS, exhibit991FromIndex, fetchPressRelease, pickExhibit991, pressExcerpt, quarterTable, xbrlConditionMet, type CompanyFacts, type QuarterRow } from '../src/data/edgar';
import { buildMarketView } from '../src/data/marketView';
import { loadSeries } from '../src/data/store';
import { createAccount, type Account, type MarketView } from '../src/engine';
import { freshDb } from './helpers/d1';
import { cronTime, fakeFetcher, newWorld, type World } from './helpers/fakeSources';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'edgar-press');
const read = (f: string) => readFileSync(join(FIX, f), 'utf8');
const EX991 = read('amzn-2026-10-29-ex991.txt').trim();
const BODY = read('amzn-2026-10-29-8k.txt').trim();
const DIR = JSON.parse(read('amzn-2026-10-29-dir.json')) as unknown;
const FACTS = JSON.parse(read('amzn-companyfacts.json')) as CompanyFacts;
const NVDA_INDEX = read('nvda-2026-08-26-index.html');

const ACC = '0001018724-26-000038';
const PR_SRC = `edgar:${ACC}:EX-99.1`;
/** 8-K 那天（2026-10-29）看得到的 XBRL：最新一季是 2026-06-30。 */
const ROWS = quarterTable(FACTS, '2026-10-29');

// 真實新聞稿裡的損益表（Consolidated Statements of Operations，三個月那兩欄是 2025、2026）
const Q = {
  revenue: 'Total net sales 180,169 201,944 503,538 584,069',
  cost: 'Cost of sales 88,670 94,573 246,455 277,814',
  op: 'Operating income 17,422 28,076 54,998 79,389',
  net: 'Net income $ 21,187 $ 20,685 $ 56,478 $ 113,587',
  eps: 'Diluted earnings per share $ 1.95 $ 1.89 $ 5.22 $ 10.42',
  basic: 'Basic earnings per share $ 1.98 $ 1.92 $ 5.31 $ 10.55',
};

// ---------------------------------------------------------------- 證據包與三票（純函式）

const docOfText = (id: string, source: string, title: string, text: string): PackDoc => ({ id, source_id: source, kind: 'filing', date: '2026-10-29', title, text });
const BODY_DOC = docOfText(`F-${ACC}`, `edgar:${ACC}`, '8-K（Item 2.02、9.01） 2026-10-29', BODY);
const PR_DOC = docOfText(`P-${ACC}`, PR_SRC, '8-K 2026-10-29 的財報新聞稿（EX-99.1）', pressExcerpt(EX991));
const XBRL_DOC: PackDoc = { id: 'X-AMZN', source_id: 'xbrl:AMZN', kind: 'xbrl', date: ROWS[0].filed, title: 'AMZN XBRL', text: 'AMZN quarterly figures 2025-09-30 revenue 180169M' };

function pack(rows: QuarterRow[] = ROWS): EvidencePack {
  const detail: EarningsDetail = { accession: ACC, filingDate: '2026-10-29', conds: [], xbrl: rows };
  return earningsPack({ ticker: 'AMZN', runId: `earn-${Math.random().toString(36).slice(2, 8)}`, asOf: '2026-10-29', body: BODY_DOC, exhibit: PR_DOC, xbrlDoc: XBRL_DOC, detail, now: new Date('2026-10-29T23:40:00Z') }).pack;
}

type Fig = { item: string; cur: string; ago: string; scale?: number; quote: string; source?: string };
const FIGS: Fig[] = [
  { item: 'revenue', cur: '201,944', ago: '180,169', quote: Q.revenue },
  { item: 'cost_of_revenue', cur: '94,573', ago: '88,670', quote: Q.cost },
  { item: 'operating_income', cur: '28,076', ago: '17,422', quote: Q.op },
  { item: 'net_income', cur: '20,685', ago: '21,187', quote: Q.net },
  { item: 'eps_diluted', cur: '1.89', ago: '1.95', scale: 1, quote: Q.eps },
];

/** 一票：每個數字一條引用。 */
function vote(p: EvidencePack, figs: Fig[] = FIGS, period = '2026-09-30') {
  return {
    run_id: p.run_id,
    verdict: 'EXTRACTED',
    evidence: figs.map((f, k) => ({ id: `E${k + 1}`, source_id: f.source ?? PR_SRC, date: '2026-10-29', quote: f.quote, claim: f.item })),
    payload: { period_end: period, figures: figs.map((f, k) => ({ item: f.item, current_text: f.cur, year_ago_text: f.ago, scale: f.scale ?? 1_000_000, evidence_ids: [`E${k + 1}`] })) },
    report: '三個月那一欄。',
  };
}
const decide = (p: EvidencePack, votes: unknown[], rows: QuarterRow[] = ROWS) => earningsDecision(judge(p, votes, PAYLOAD_HOOKS[OWN_EARNINGS]), p, rows);
const three = (p: EvidencePack, f: (p: EvidencePack) => unknown = vote) => [f(p), f(p), f(p)];

// ---------------------------------------------------------------- EX-99.1 的取法（真實的財報新聞稿）

describe('T29c：EX-99.1 的取法（真實的 Amazon 2026Q3 財報新聞稿）', () => {
  it('開頭 15,000 字＋從第一個損益表標題起 45,000 字：財務報表在後段也拿得到', () => {
    const at = EX991.search(/consolidated statements? of (operations|income|earnings)/i);
    expect(EX991.length).toBeGreaterThan(30_000); // 原本只取前 30,000 字
    expect(at).toBeGreaterThan(PRESS_HEAD);
    const ex = pressExcerpt(EX991);
    expect(ex.startsWith(EX991.slice(0, PRESS_HEAD))).toBe(true);
    expect(ex).toBe(EX991.slice(0, PRESS_HEAD) + PRESS_GAP + EX991.slice(at, at + PRESS_STATEMENTS));
    expect(ex.slice(PRESS_HEAD + PRESS_GAP.length)).toMatch(/^Consolidated Statements of Operations/);
    // 損益表的每一行都在（三票引用的就是這幾行），後面的分部資訊也在
    for (const line of Object.values(Q)) expect(ex.replace(/\s+/g, ' ')).toContain(line);
    expect(ex).toContain('Segment Information');
    // 開頭和損益表之間省略的那段不在（例如現金流量表）
    expect(ex).not.toContain(EX991.slice(PRESS_HEAD + 100, PRESS_HEAD + 400));
  });

  it('標題在開頭 15,000 字內 → 一整段；找不到標題 → 前 60,000 字', () => {
    const early = 'a'.repeat(5_000) + 'CONDENSED CONSOLIDATED STATEMENTS OF INCOME' + 'b'.repeat(80_000);
    const at = early.search(/consolidated statements? of/i);
    expect(at).toBe(5_010);
    expect(pressExcerpt(early)).toBe(early.slice(0, at + PRESS_STATEMENTS));
    const none = 'x'.repeat(90_000);
    expect(pressExcerpt(none)).toBe(none.slice(0, PRESS_FALLBACK));
  });

  it('附件的檔名：Amazon 的目錄找得到 ex991；NVIDIA 的 q2fy27pr.htm 沒有 99，改讀索引頁的 Type 欄', () => {
    expect(pickExhibit991(DIR)).toBe('amzn-20260930xex991.htm');
    expect(pickExhibit991({ directory: { item: [{ name: 'nvda-20260826.htm' }, { name: 'q2fy27pr.htm' }, { name: 'q2fy27cfocommentary.htm' }] } })).toBeNull();
    expect(exhibit991FromIndex(NVDA_INDEX)).toBe('q2fy27pr.htm');
  });

  it('fetchPressRelease：8-K 本文從 Item 起、新聞稿照新的取法；目錄找不到時讀索引頁', async () => {
    const urls: string[] = [];
    const fetcher: Fetcher = async (url) => {
      urls.push(url);
      if (url.endsWith('/index.json')) return Response.json(url.includes('1045810') ? { directory: { item: [{ name: 'nvda-20260826.htm' }, { name: 'q2fy27pr.htm' }] } } : DIR);
      if (url.endsWith('-index.html')) return new Response(NVDA_INDEX);
      if (url.endsWith('amzn-20260930xex991.htm')) return new Response(EX991);
      if (url.endsWith('q2fy27pr.htm')) return new Response('<html><body><p>NVIDIA Announces Financial Results</p></body></html>');
      return new Response(BODY);
    };
    const ref = { accession: ACC, form: '8-K', items: ['2.02', '9.01'], filingDate: '2026-10-29', acceptedAt: '2026-10-29T20:05:27.000Z', primaryDocument: 'amzn-20261029.htm' };
    const r = await fetchPressRelease(fetcher, '1018724', ref, 'ua');
    expect(r.body.text).toMatch(/^ITEM 2\.02\. RESULTS OF OPERATIONS/);
    expect(r.exhibit).toEqual({ name: 'amzn-20260930xex991.htm', url: `https://www.sec.gov/Archives/edgar/data/1018724/${ACC.replace(/-/g, '')}/amzn-20260930xex991.htm`, text: pressExcerpt(EX991) });
    const nv = await fetchPressRelease(fetcher, '1045810', { ...ref, accession: '0001045810-26-000073', primaryDocument: 'nvda-20260826.htm' }, 'ua');
    expect(nv.exhibit?.name).toBe('q2fy27pr.htm');
    expect(urls).toContain('https://www.sec.gov/Archives/edgar/data/1045810/000104581026000073/0001045810-26-000073-index.html');
  });
});

// ---------------------------------------------------------------- 六項程式檢查（真實原文、真實 XBRL）

describe('T29c：六項程式檢查（任何一項不過就不採用）', () => {
  it('都過：採用五個項目；程式算的毛利率、營業利益率、營收年增率', () => {
    const p = pack();
    const d = decide(p, three(p));
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.period).toBe('2026-09-30');
    expect(d.figures).toEqual({ revenue: { current: 201_944e6, yearAgo: 180_169e6 }, cost_of_revenue: { current: 94_573e6, yearAgo: 88_670e6 }, operating_income: { current: 28_076e6, yearAgo: 17_422e6 }, net_income: { current: 20_685e6, yearAgo: 21_187e6 }, eps_diluted: { current: 1.89, yearAgo: 1.95 } });
    expect(d.dropped).toEqual([]);
    const row = pressRow(d.period, d.figures, ROWS, { filingDate: '2026-10-29', accession: ACC });
    expect(row.grossMarginPct).toBeCloseTo((201_944 - 94_573) / 201_944, 10);
    expect(row.operatingMarginPct).toBeCloseTo(28_076 / 201_944, 10);
    expect(row.revenueYoY).toBeCloseTo(201_944 / 180_169 - 1, 10); // 去年同季用 XBRL
    expect(row.cfoToNetIncome).toBeNull();
  });

  it('檢查 1：數字不在引用的原文裡 → 不採用；引用 XBRL 表也不算', () => {
    const p = pack();
    const typo = (q: EvidencePack) => vote(q, FIGS.map((f) => (f.item === 'revenue' ? { ...f, cur: '201,945' } : f)));
    expect(decide(p, three(p, typo))).toMatchObject({ ok: false, check: 1 });
    // 部分相符不算：1.9 不是 1.95
    expect(figureInQuote('1.9', Q.eps)).toBe(false);
    expect(figureInQuote('$1.95', Q.eps)).toBe(true);
    const xbrlQuote = (q: EvidencePack) => vote(q, [...FIGS.slice(1), { item: 'revenue', cur: '201,944', ago: '180,169', quote: 'AMZN quarterly figures 2025-09-30 revenue 180169M', source: 'xbrl:AMZN' }]);
    expect(decide(p, three(p, xbrlQuote))).toMatchObject({ ok: false, check: 1 });
  });

  it('檢查 2：三票的季末不同、或同一項相差超過 0.1%、或有一票不合格 → 不採用', () => {
    const p = pack();
    expect(decide(p, [vote(p), vote(p), vote(p, FIGS, '2026-10-31')])).toMatchObject({ ok: false, check: 2 });
    const thousand = (q: EvidencePack) => vote(q, FIGS.map((f) => (f.item === 'net_income' ? { ...f, scale: 1000 } : f)));
    expect(decide(p, [vote(p), vote(p), thousand(p)])).toMatchObject({ ok: false, check: 2, why: expect.stringContaining('淨利') });
    // 一票說抄不到 → 不是三票一致
    const ins = { run_id: p.run_id, verdict: 'INSUFFICIENT', evidence: [], payload: {} };
    expect(decide(p, [vote(p), vote(p), ins])).toMatchObject({ ok: false, check: 0 });
    // 只有兩票抄到的項目不算（三票都有的才採用）
    const noEps = (q: EvidencePack) => vote(q, FIGS.slice(0, 4));
    const d = decide(p, [vote(p), vote(p), noEps(p)]);
    expect(d.ok && Object.keys(d.figures)).toEqual(['revenue', 'cost_of_revenue', 'operating_income', 'net_income']);
  });

  it('檢查 3：季末不是 XBRL 最新一季的下一季 → 不採用', () => {
    const p = pack(ROWS.slice(1)); // XBRL 最新一季是 2026-03-31 → 差 183 天
    expect(decide(p, three(p), ROWS.slice(1))).toMatchObject({ ok: false, check: 3, why: expect.stringContaining('183 天') });
  });

  it('檢查 4：去年同季和 XBRL 對不上的項目不採用（抄成基本每股盈餘、XBRL 改過的營收）；全部對不上 → 不採用', () => {
    const p = pack();
    const basic = (q: EvidencePack) => vote(q, FIGS.map((f) => (f.item === 'eps_diluted' ? { ...f, cur: '1.92', ago: '1.98', quote: Q.basic } : f)));
    const d = decide(p, three(p, basic));
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.figures.eps_diluted).toBeUndefined();
    expect(d.dropped).toEqual(['稀釋每股盈餘：去年同季新聞稿 1.98，XBRL 1.95，對不上']);
    // XBRL 的去年同季營收差 1%（例如抄到別的欄）→ 營收不採用，比率都算不出來
    const off = ROWS.map((r) => (r.end === '2025-09-30' ? { ...r, revenue: r.revenue! * 1.01 } : r));
    const po = pack(off);
    const d2 = decide(po, three(po), off);
    expect(d2.ok).toBe(true);
    expect(d2.ok && d2.figures.revenue).toBeUndefined();
    if (d2.ok) expect(pressRow(d2.period, d2.figures, off, { filingDate: '2026-10-29', accession: ACC }).grossMarginPct).toBeNull();
    // 只抄了每股盈餘，又對不上 → 整份不採用
    const onlyBasic = (q: EvidencePack) => vote(q, [{ item: 'eps_diluted', cur: '1.92', ago: '1.98', scale: 1, quote: Q.basic }]);
    expect(decide(p, three(p, onlyBasic))).toMatchObject({ ok: false, check: 4 });
  });

  it('檢查 5：指標要的項目沒採用就算不出來（只抄淨利與每股盈餘 → 毛利率、營業利益率、營收年增率都是空的）', () => {
    const p = pack();
    const d = decide(p, three(p, (q) => vote(q, FIGS.slice(3))));
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    const row = pressRow(d.period, d.figures, ROWS, { filingDate: '2026-10-29', accession: ACC });
    expect([row.grossMarginPct, row.operatingMarginPct, row.netMarginPct, row.revenueYoY]).toEqual([null, null, null, null]);
    expect(row.epsDiluted).toBe(1.89);
    expect(xbrlConditionMet([row, ...ROWS], { type: 'xbrl_metric_below', metric: 'GrossMarginPct', level: 0.6 })).toBeNull();
  });

  it('檢查 6：要連續兩季的用擷取的本季加 XBRL 的上一季；XBRL 缺一季（第四季沒有單季每股盈餘）就不判斷', () => {
    const p = pack();
    const d = decide(p, three(p));
    if (!d.ok) throw new Error(d.why);
    const all = [pressRow(d.period, d.figures, ROWS, { filingDate: '2026-10-29', accession: ACC }), ...ROWS];
    const two = xbrlConditionMet(all, { type: 'xbrl_metric_below', metric: 'OperatingMarginPct', level: 0.14, quarters: 2 })!;
    expect(two.met).toBe(true);
    expect(two.values[0]).toBeCloseTo(28_076 / 201_944, 10); // 本季：新聞稿
    expect(two.values[1]).toBeCloseTo(27_461 / 200_606, 10); // 上一季：XBRL 2026-06-30
    // 連 4 季：2025-12-31 是第四季，XBRL 沒有單季的稀釋每股盈餘 → 算不出來，不判斷
    expect(xbrlConditionMet(all, { type: 'xbrl_metric_below', metric: 'EPSDiluted', level: 10, quarters: 4 })).toBeNull();
  });

  it('parseFigure：千分位、括號負數、$；不是數字就是 null', () => {
    expect(parseFigure('201,944')).toBe(201944);
    expect(parseFigure('(1,207)')).toBe(-1207);
    expect(parseFigure('$ 1.89')).toBe(1.89);
    expect(parseFigure('—')).toBeNull();
    expect(EARNINGS_ITEMS).toHaveLength(6);
  });
});

// ---------------------------------------------------------------- 每日流程（假的 EDGAR 回真實的申報）

interface FakeFiling {
  accession: string;
  form: string;
  items: string;
  acceptanceDateTime: string;
  filingDate: string;
  primaryDocument: string;
  html: string;
  dir?: unknown;
  files?: Record<string, string>;
}
interface Edgar {
  filings: FakeFiling[];
  line: string[];
}
const PR_8K: FakeFiling = { accession: ACC, form: '8-K', items: '2.02,9.01', acceptanceDateTime: '2026-10-29T20:05:27.000Z', filingDate: '2026-10-29', primaryDocument: 'amzn-20261029.htm', html: BODY, dir: DIR, files: { 'amzn-20260930xex991.htm': EX991 } };
const TENQ = '<html><body><p>Item 2. Management’s Discussion and Analysis of Financial Condition and Results of Operations</p><p>Total net sales increased 12% in Q3 2026 compared to the prior year period.</p><p>Item 3. Quantitative and Qualitative Disclosures About Market Risk</p></body></html>';
/** 已經在 EDGAR 上的上一份 10-Q（第一次看 EDGAR 時記下它，之後的才算新申報）。 */
const Q2_10Q: FakeFiling = { accession: '0001018724-26-000020', form: '10-Q', items: '', acceptanceDateTime: '2026-07-31T20:10:00.000Z', filingDate: '2026-07-31', primaryDocument: 'amzn-20260630.htm', html: TENQ };
const Q3_10Q: FakeFiling = { accession: '0001018724-26-000040', form: '10-Q', items: '', acceptanceDateTime: '2026-10-30T20:10:00.000Z', filingDate: '2026-10-30', primaryDocument: 'amzn-20260930.htm', html: TENQ };

function fetcherOf(w: World, e: Edgar): Fetcher {
  const base = fakeFetcher(w);
  return async (url, init) => {
    if (url === LINE_PUSH_URL) {
      e.line.push((JSON.parse(String(init?.body)) as { messages: { text: string }[] }).messages[0].text);
      return Response.json({});
    }
    if (url === 'https://api.example/fire') return Response.json({ claude_code_session_url: 'https://claude.ai/code/x' });
    if (/data\.sec\.gov\/submissions\/CIK\d+\.json/.test(url)) {
      const fs = [...e.filings].sort((a, b) => b.acceptanceDateTime.localeCompare(a.acceptanceDateTime));
      return Response.json({ cik: '1018724', name: 'AMAZON COM INC', tickers: ['AMZN'], filings: { recent: { accessionNumber: fs.map((f) => f.accession), form: fs.map((f) => f.form), items: fs.map((f) => f.items), acceptanceDateTime: fs.map((f) => f.acceptanceDateTime), filingDate: fs.map((f) => f.filingDate), primaryDocument: fs.map((f) => f.primaryDocument) } } });
    }
    if (/companyfacts\/CIK\d+\.json/.test(url)) return Response.json(FACTS);
    const doc = /Archives\/edgar\/data\/\d+\/(\d+)\/(.+)$/.exec(url);
    if (doc) {
      const f = e.filings.find((x) => x.accession.replace(/-/g, '') === doc[1]);
      if (!f) return new Response('nf', { status: 404 });
      if (doc[2] === 'index.json') return Response.json(f.dir ?? { directory: { item: [{ name: f.primaryDocument }] } });
      if (doc[2] === f.primaryDocument) return new Response(f.html);
      const extra = f.files?.[doc[2]];
      return extra === undefined ? new Response('nf', { status: 404 }) : new Response(extra);
    }
    if (url.startsWith('https://www.nasdaq.com/feed/rssoutbound')) return new Response('<rss><channel></channel></rss>');
    return base(url, init);
  };
}

interface Ctx {
  db: D1Database;
  w: World;
  e: Edgar;
  env: Env;
  fetcher: Fetcher;
  run: (date: string, attempt?: Attempt) => ReturnType<typeof runFlow>;
  viewAt: (date: string) => Promise<{ view: MarketView; axis: string[] }>;
}

const FILE = 'AMZN@2026-10-27';

async function withWorld(fn: (c: Ctx) => Promise<void>) {
  const d = await freshDb();
  try {
    const db = d.db;
    const w = newWorld('2026-10-27');
    const e: Edgar = { filings: [Q2_10Q], line: [] };
    const env: Env = { DB: db, ADMIN_TOKEN: 't', AI_TASK_SECRET: 's', EDGAR_USER_AGENT: 'test bot test@example.com', SITE_URL: 'https://bot.example', LINE_CHANNEL_TOKEN: 'lt', LINE_USER_ID: 'U1', ROUTINE_FIRE_URL: 'https://api.example/fire', ROUTINE_TOKEN: 'rt', DEV_NO_AUTH: '1' };
    const fetcher = fetcherOf(w, e);
    const run = (date: string, attempt: Attempt = 'FIRST') => {
      w.dataDate = date;
      return runFlow(env, fetcher, { now: attempt === 'FINAL' ? new Date(Date.parse(date + 'T23:30:00Z') + 2 * 3600_000) : cronTime(date), attempt });
    };
    const viewAt = async (date: string) => buildMarketView(await loadSeries(db, ['VOO', 'SGOV', 'AMZN']), date, 'VOO');
    await run('2026-10-27');
    const { view } = await viewAt('2026-10-27');
    const acct = createAccount(
      { paper: true, cash: 5000, core: { VOO: Math.floor(140_000 / view.close.VOO[view.i]) }, own: { AMZN: { shares: Math.floor(40_000 / view.close.AMZN[view.i]), stdWeight: 0.15, premises: [{ id: 'P1', text: 'AWS 成長加速', origin: 'USER' }] } } },
      view,
    );
    await saveAccount(db, acct, null, '建立帳戶', new Date('2026-10-27T12:00:00Z'));
    await fn({ db, w, e, env, fetcher, run, viewAt });
  } finally {
    await d.dispose();
  }
}

type Seed = { condId?: string; text?: string; check?: Record<string, unknown>; status?: string; action?: string; accepted?: boolean; metBasis?: string; progress?: unknown; note?: string; ticker?: string; file?: string };
/** 一條條件（預設：你寫的、10/27 定、毛利率低於 53.5%、成立時減半）；回傳列編號。 */
async function seed(db: D1Database, o: Seed = {}): Promise<number> {
  const r = await db
    .prepare('INSERT INTO own_conditions (ticker, run_id, cond_id, direction, kind, text, check_json, tier_if_met, status, created_at, origin, file_id, accepted_at, action, auto, met_basis, progress_json, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)')
    .bind(o.ticker ?? 'AMZN', 'r0', o.condId ?? 'U1', 'DOWN', 'XBRL', o.text ?? '毛利率低於 53.5%', JSON.stringify(o.check ?? { type: 'xbrl_metric_below', metric: 'GrossMarginPct', level: 0.535, quarters: 1 }), null, o.status ?? 'ACTIVE', '2026-10-27T12:00:00.000Z', o.accepted === false ? 'AI' : 'USER', o.file ?? FILE, o.accepted === false ? null : '2026-10-27T13:00:00.000Z', o.action ?? 'HALF', o.metBasis ?? null, o.progress ? JSON.stringify(o.progress) : null, o.note ?? null)
    .run();
  return r.meta.last_row_id;
}

async function postResult(db: D1Database, runId: string, samples: unknown[], at: Date) {
  const run = (await getRun(db, runId))!;
  const task = await db.prepare('SELECT * FROM ai_tasks WHERE id = ?').bind(run.taskId).first();
  return finalizeRun(db, task as never, { samples }, at);
}
// listRuns 會先把超過時限的執行照規則結束，所以時間要在開的那一刻附近
const earningsRuns = async (db: D1Database) => (await listRuns(db, new Date('2026-10-29T23:45:00Z'))).filter((r) => r.fn === OWN_EARNINGS);
const aiLog = async (db: D1Database) => {
  const r = await db.prepare('SELECT detail FROM flow_runs ORDER BY id DESC LIMIT 1').first<{ detail: string }>();
  return ((JSON.parse(r!.detail) as { ai: { log: string[] } | null }).ai?.log ?? []).join('\n');
};
const urgents = (a: Account) => a.notifs.filter((n) => n.kind === 'URGENT');

describe('T29c：財報新聞稿當天確認你定的財報條件（每日流程）', () => {
  it('整條：8-K 2.02 → 開擷取 → 三票 → 第二次排程當天通知（依財報新聞稿）；連兩季的條件用本季加 XBRL 上一季；隔天 10-Q 核對一致', async () => {
    await withWorld(async (c) => {
      await c.run('2026-10-28'); // 第一次看 EDGAR，只記下最新的申報
      const gm = await seed(c.db, { condId: 'U1', text: '毛利率低於 53.5%', action: 'HALF' });
      const om = await seed(c.db, { condId: 'U2', text: '營業利益率連兩季低於 14%', check: { type: 'xbrl_metric_below', metric: 'OperatingMarginPct', level: 0.14, quarters: 2 }, action: 'EXIT' });
      const watch = await seed(c.db, { condId: 'W1', text: '營收年增率低於 15%', check: { type: 'xbrl_metric_below', metric: 'RevenueYoY', level: 0.15, quarters: 1 }, status: 'PROPOSED', accepted: false });
      c.e.filings.push(PR_8K);
      await c.run('2026-10-29');
      const runs = await earningsRuns(c.db);
      expect(runs).toHaveLength(1);
      const r = runs[0];
      expect(r.pack.prompt_version).toBe('own_earnings_v1');
      expect(r.pack.policy).toMatchObject({ level: 'A3', verdicts: ['EXTRACTED', 'INSUFFICIENT'], samples: 3 });
      // 證據包：8-K 本文、EX-99.1（新的取法）、XBRL 表；XBRL 的完整數字在 rule.detail
      expect(r.pack.documents.map((x) => x.source_id)).toEqual([`edgar:${ACC}`, PR_SRC, 'xbrl:AMZN']);
      expect(r.pack.documents[1].text).toBe(pressExcerpt(EX991));
      const detail = r.pack.rule.detail as EarningsDetail;
      expect(detail).toMatchObject({ accession: ACC, filingDate: '2026-10-29', conds: [gm, om] });
      expect(detail.xbrl[0].end).toBe('2026-06-30');

      const v = vote(r.pack);
      await postResult(c.db, r.runId, [v, v, v], new Date('2026-10-30T00:10:00Z'));
      const fin = await c.run('2026-10-29', 'FINAL');
      const acct = (await loadAccount(c.db))!.acct;
      const ns = urgents(acct).filter((n) => fin.created.includes(n.id));
      expect(ns.map((n) => n.title)).toEqual(['AMZN：你定的出場條件成立', 'AMZN：你定的出場條件成立']);
      const byTitle = Object.fromEntries(ns.map((n) => [n.items[0].title, n.items[0]]));
      const gmItem = byTitle['AMZN：你在 2026-10-27 定的條件「毛利率低於 53.5%」成立'];
      expect(gmItem).toMatchObject({ f: 'F25', kind: 'OWN_COND', choice: 'DO', brk: { type: 'A', conditionId: gm } });
      expect(gmItem.why).toBe('最新一季毛利率 53.2%（依財報新聞稿 8-K 2026-10-29；10-Q 出來後再核對）');
      expect(gmItem.runIds).toEqual([r.runId, 'r0']);
      const omItem = byTitle['AMZN：你在 2026-10-27 定的條件「營業利益率連兩季低於 14%」成立'];
      expect(omItem.why).toBe('最近 2 季營業利益率 13.9%、13.7%（新到舊；最新一季依財報新聞稿 8-K 2026-10-29；10-Q 出來後再核對，之前的季取自 XBRL）');
      // 條件：MET、met_basis = PRESS；進度 basis = PRESS（你定的與觀察項都寫）；觀察項成立也不通知
      const conds = await loadConditions(c.db, 'AMZN');
      const get = (id: number) => conds.find((x) => x.id === id)!;
      expect(get(gm)).toMatchObject({ status: 'MET', metBasis: 'PRESS', verifiedAt: null });
      expect(get(gm).progress).toMatchObject({ basis: 'PRESS', period: '2026-09-30', level: 0.535, streak: 1, need: 1 });
      expect(get(om).progress).toMatchObject({ basis: 'PRESS', period: '2026-09-30', streak: 2, need: 2 });
      expect(get(om).progress!.values[1]).toBeCloseTo(27_461 / 200_606, 10);
      expect(get(watch)).toMatchObject({ status: 'PROPOSED', progress: { basis: 'PRESS', period: '2026-09-30', streak: 1 } });
      expect(get(watch).progress!.values[0]).toBeCloseTo(201_944 / 180_169 - 1, 10);
      expect(await aiLog(c.db)).toContain('建議中的財報條件 W1 依財報新聞稿成立；你還沒勾選，不通知');

      // 隔天 10-Q：XBRL 有這一季了 → 核對一致，寫 verified_at；不再通知
      c.e.filings.push(Q3_10Q);
      const next = await c.run('2026-10-30');
      const after = await loadConditions(c.db, 'AMZN');
      for (const id of [gm, om]) {
        const x = after.find((y) => y.id === id)!;
        expect(x.verifiedAt).not.toBeNull();
        expect(x.note).toMatch(/10-Q 核對一致$/);
      }
      expect(urgents((await loadAccount(c.db))!.acct).filter((n) => next.created.includes(n.id))).toEqual([]);
      expect(await earningsRuns(c.db)).toHaveLength(1); // 10-Q 那天不開擷取
      const file = (await thesisFile(c.db, (await loadAccount(c.db))!.acct, 'AMZN', '2026-10-30'))!;
      expect(file.log.filter((l) => l.kind === 'PRESS_CHECK')).toEqual([]);
      expect(file.reviews.find((x) => x.runId === r.runId)).toMatchObject({ label: '財報數字擷取', trigger: '財報新聞稿' });
    });
  });

  it('同一批新申報裡有 10-Q → 不開擷取（財報條件由程式直接比對 XBRL）', async () => {
    await withWorld(async (c) => {
      await c.run('2026-10-28');
      await seed(c.db, { text: '毛利率低於 50%', check: { type: 'xbrl_metric_below', metric: 'GrossMarginPct', level: 0.5, quarters: 1 } }); // 10-Q 比對後沒有成立，仍在監測中
      c.e.filings.push(PR_8K, { ...Q3_10Q, acceptanceDateTime: '2026-10-29T21:00:00.000Z', filingDate: '2026-10-29' });
      await c.run('2026-10-29');
      expect(await earningsRuns(c.db)).toEqual([]);
      expect(await aiLog(c.db)).toContain('和 10-Q／10-K 同一批出來');
    });
  });

  it('只有 CfoToNetIncome 的條件 → 不開；只有建議中的條件、或沒有財報條件 → 不開', async () => {
    await withWorld(async (c) => {
      await c.run('2026-10-28');
      await seed(c.db, { text: '營業現金流對淨利低於 1', check: { type: 'xbrl_metric_below', metric: 'CfoToNetIncome', level: 1, quarters: 1 } });
      await seed(c.db, { condId: 'W1', status: 'PROPOSED', accepted: false });
      c.e.filings.push(PR_8K);
      await c.run('2026-10-29');
      expect(await earningsRuns(c.db)).toEqual([]);
      expect(await aiLog(c.db)).toContain('新聞稿算不出來，等 10-Q／10-K');
    });
  });
});

// ---------------------------------------------------------------- 套用與核對（直接呼叫）

function qrow(end: string, gm: number, form = '10-Q'): QuarterRow {
  return { end, filed: '2026-11-05', form, accn: 'a', revenue: 100, grossProfit: gm * 100, operatingIncome: null, netIncome: null, epsDiluted: null, cfo: null, grossMarginPct: gm, operatingMarginPct: null, netMarginPct: null, revenueYoY: null, cfoToNetIncome: null };
}

/** 套用的狀態（價格停在建立帳戶那天 2026-10-27，訊號日也是那天）。 */
async function applyCtx(c: Ctx): Promise<{ ctx: ApplyCtx; loaded: NonNullable<Awaited<ReturnType<typeof loadAccount>>> }> {
  const loaded = (await loadAccount(c.db))!;
  const { view, axis } = await c.viewAt('2026-10-27');
  return { loaded, ctx: { db: c.db, acct: loaded.acct, view, axis, session: view.date, now: new Date('2026-10-27T23:40:00Z'), stmts: [], log: [] } };
}

describe('T29c：10-Q／10-K 出來後核對；不採用時什麼都不做', () => {
  const PRESS = { at: '2026-10-29', basis: 'PRESS', period: '2026-09-30', values: [0.684, 0.72], level: 0.7, streak: 1, need: 1 };

  it('核對不一致：說明寫明兩個數字、論點檔記一筆、列進「要看的事」（核對後的第一份月報一次）；已經做的不撤回', async () => {
    await withWorld(async (c) => {
      const id = await seed(c.db, { text: '毛利率低於 70%', check: { type: 'xbrl_metric_below', metric: 'GrossMarginPct', level: 0.7, quarters: 1 }, status: 'MET', metBasis: 'PRESS', progress: PRESS, note: '財報新聞稿（8-K 2026-10-29）：0.6840' });
      const { ctx, loaded } = await applyCtx(c);
      await ownXbrlConditions(ctx, new Map([['AMZN', [qrow('2026-09-30', 0.703), qrow('2026-06-30', 0.72)]]]));
      await saveAccount(c.db, ctx.acct, loaded, '測試', new Date('2026-10-27T23:41:00Z'), ctx.stmts);
      const x = (await loadConditions(c.db, 'AMZN')).find((y) => y.id === id)!;
      expect(x).toMatchObject({ status: 'MET', metBasis: 'PRESS' });
      expect(x.verifiedAt).not.toBeNull();
      expect(x.note).toBe('財報新聞稿（8-K 2026-10-29）：0.6840；10-Q 核對不一致：依財報新聞稿 68.4%，10-Q 算出來是 70.3%，沒有過門檻 70.0%');
      expect(urgents(ctx.acct)).toEqual([]);
      const acct = (await loadAccount(c.db))!.acct;
      const file = (await thesisFile(c.db, acct, 'AMZN', '2026-10-27'))!;
      expect(file.log.filter((l) => l.kind === 'PRESS_CHECK').map((l) => l.body)).toEqual([{ id, ok: false, metric: 'GrossMarginPct', level: 0.7, period: '2026-09-30', press: [0.684], xbrl: [0.703], form: '10-Q', filed: '2026-11-05' }]);
      const hits = ownAttention([file], acct, ctx.view).filter((h) => h.kind === 'PRESS_MISMATCH');
      expect(hits.map((h) => [h.key, h.text, h.since])).toEqual([[`PRESS_MISMATCH:${id}`, 'AMZN：條件「毛利率低於 70%」依財報新聞稿成立（68.4%），10-Q 算出來是 70.3%，沒有過門檻', '2026-10-27']]);
      const d1 = dueAttention(hits, {}, '2026-10-30');
      expect(d1.due).toHaveLength(1);
      expect(dueAttention(hits, d1.shown, '2026-11-27').due).toEqual([]);
      // 核對之後有月報了 → 持股頁也不再列
      const withMonthly = structuredClone(acct);
      withMonthly.notifs.push({ id: 901, kind: 'MONTHLY', date: '2026-10-30', seq: 0, title: '2026-11 月報', items: [], status: 'PENDING', coreAbsorb: true, reminded: false });
      expect(ownAttention([file], withMonthly, ctx.view).filter((h) => h.kind === 'PRESS_MISMATCH')).toEqual([]);
      // 核對過的不再核對
      const again = (await applyCtx(c)).ctx;
      await ownXbrlConditions(again, new Map([['AMZN', [qrow('2026-09-30', 0.703)]]]));
      expect(again.stmts).toEqual([]);
    });
  });

  it('核對一致 → 說明加「10-Q 核對一致」，不記 log、不列；XBRL 還沒有那一季 → 這次不核對', async () => {
    await withWorld(async (c) => {
      const id = await seed(c.db, { text: '毛利率低於 70%', check: { type: 'xbrl_metric_below', metric: 'GrossMarginPct', level: 0.7, quarters: 1 }, status: 'MET', metBasis: 'PRESS', progress: PRESS, note: '財報新聞稿（8-K 2026-10-29）：0.6840' });
      const early = (await applyCtx(c)).ctx;
      await ownXbrlConditions(early, new Map([['AMZN', [qrow('2026-06-30', 0.72)]]]));
      expect(early.stmts).toEqual([]);
      expect(early.log.join('\n')).toContain('新財報還沒有那一季（2026-09-30），這次不核對');
      const { ctx } = await applyCtx(c);
      await ownXbrlConditions(ctx, new Map([['AMZN', [qrow('2026-09-30', 0.69, '10-K'), qrow('2026-06-30', 0.72)]]]));
      await c.db.batch(ctx.stmts);
      const x = (await loadConditions(c.db, 'AMZN')).find((y) => y.id === id)!;
      expect(x.verifiedAt).not.toBeNull();
      expect(x.note).toBe('財報新聞稿（8-K 2026-10-29）：0.6840；10-K 核對一致');
      const file = (await thesisFile(c.db, ctx.acct, 'AMZN', '2026-10-27'))!;
      expect(file.log.filter((l) => l.kind === 'PRESS_CHECK')).toEqual([]);
      expect(ownAttention([file], ctx.acct, ctx.view).filter((h) => h.kind === 'PRESS_MISMATCH')).toEqual([]);
    });
  });

  it('不採用（檢查不過）→ 條件不動、不寫進度；同一次套用裡財報新聞稿剛成立的，XBRL 比對不再通知一次', async () => {
    await withWorld(async (c) => {
      const id = await seed(c.db);
      const p = pack();
      const run = (votes: unknown[]) => ({ runId: p.run_id, fn: OWN_EARNINGS, ticker: 'AMZN', asOf: '2026-10-29', outcome: judge(p, votes, PAYLOAD_HOOKS[OWN_EARNINGS]), pack: p }) as unknown as AiRun;
      // 檢查 3 不過（季末寫錯）→ 什麼都不做
      const bad = (await applyCtx(c)).ctx;
      await applyOwnEarnings(bad, run([vote(p, FIGS, '2026-12-31'), vote(p, FIGS, '2026-12-31'), vote(p, FIGS, '2026-12-31')]));
      expect(bad.stmts).toEqual([]);
      expect(bad.log.join('\n')).toContain('財報新聞稿的數字不採用（檢查 3 不過）');
      expect(urgents(bad.acct)).toEqual([]);
      // 採用 → 成立、通知一次；同一次套用的 10-Q 比對跳過這一條
      const { ctx } = await applyCtx(c);
      await applyOwnEarnings(ctx, run(three(p)));
      await ownXbrlConditions(ctx, new Map([['AMZN', quarterTable(FACTS, '2026-10-30')]]));
      expect(urgents(ctx.acct)).toHaveLength(1);
      expect(urgents(ctx.acct)[0].items[0].why).toContain('依財報新聞稿');
      expect(ctx.met?.has(id)).toBe(true);
    });
  });

  it('pressWhy 的文字（設計 §1.10 的 PRESS 那一格）', () => {
    expect(pressWhy({ metric: 'GrossMarginPct' }, [0.684], '2027-01-06')).toBe('最新一季毛利率 68.4%（依財報新聞稿 8-K 2027-01-06；10-Q 出來後再核對）');
  });

  it('雲端排程讀得到 prompt：ai/prompts/own_earnings_v1.md 存在，寫了六個項目', () => {
    const md = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'ai', 'prompts', 'own_earnings_v1.md'), 'utf8');
    for (const it of EARNINGS_ITEMS) expect(md).toContain(`\`${it}\``);
  });
});
