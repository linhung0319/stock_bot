// T54：時機——月底的 PEER／WEB_DUE、大跌無申報、減半檢視（web_evidence_design_2026-11-20 §1.7）。
// 完成條件：
//   有需要外部資料的前提、滿 25 天 → 月底照審；沒有的照舊跳過（24 天、都成立、只有預設前提）
//   同業有新的財報新聞稿 → 照審（PEER）；同業別種 8-K、抓不到、沒有同業 → 不算
//   大跌無申報：有論點開提前審查（受 30 天上限）、只有預設前提照舊列——在 t29b-early.test.ts 的兩個「③」測試
//   減半檢視的分析師可以找：證據包有目錄與清單內的網頁來源、可以取文件、取回的網頁可以判前提不成立；prompt 升成 own_drop_v3
//   減半通知的推播時間不變——t31b-drop.test.ts 的「K3：23:30 開了減半檢視還在等 → 通知產生但不推 LINE；01:30 …」（現在跑的是 v3 與目錄）
//   PREMISE_DATA_NOTE 的文字——t27-discussion.test.ts；「要看的事」PREMISE_NO_DATA 的文字——t37-attention.test.ts
// 對外請求全部是假的（價格、成分股、EDGAR、RSS、網頁、雲端排程、LINE）；AI 的回覆一律是假的。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { OWN_DROP_PROMPT, dropDecision } from '../src/ai/drops';
import { ownReviewPack } from '../src/ai/ownReview';
import type { StartCtx } from '../src/app/aiCtx';
import { getRun, listRuns, type AiRun } from '../src/app/aiRuns';
import { startDropRuns } from '../src/app/dropAi';
import type { Env, Fetcher } from '../src/app/env';
import type { FilingCheck } from '../src/app/filings';
import { runFlow } from '../src/app/flow';
import { LINE_PUSH_URL } from '../src/app/line';
import { loadAccount, saveAccount } from '../src/app/ledgerStore';
import { checkpointSection } from '../src/app/opsReport';
import { checkpointKey, insertConditionStmts, lookForText, startEarlyReviews, startOwnRuns } from '../src/app/ownAi';
import { foundView } from '../src/app/site/aiViews';
import { EARLY_NOTE, EVIDENCE_TEXT, WEB_DUE_DAYS, externalNeeds, newEvidence, type FileCondition, type ThesisFile, type ThesisPremise } from '../src/app/thesis';
import type { CompanyFacts, XbrlFact } from '../src/data/edgar';
import { buildMarketView } from '../src/data/marketView';
import { loadSeries } from '../src/data/store';
import { SYSTEM_DEFAULT_PREMISES, createAccount, type Account, type MarketView, type OwnWebSources } from '../src/engine';
import { handle } from '../src/index';
import { freshDb } from './helpers/d1';
import { cronTime, fakeFetcher, newWorld, type World } from './helpers/fakeSources';

// ---------------------------------------------------------------- 純函式：newEvidence 的 PEER、WEB_DUE

const ASOF = '2026-12-30';
const LAST = { runId: 'rev-1', asOf: '2026-12-01', createdAt: '2026-12-01T23:40:00.000Z', thesisVersion: 0 };
const prem = (id: string, status: string | null, origin = 'USER'): ThesisPremise => ({ id, text: `前提 ${id}`, origin, addedAt: '2026-11-19', lastCheck: status ? { date: '2026-12-01', runId: 'rev-1', status } : null, splitAfter: false });
const cond = (o: Partial<FileCondition> = {}): FileCondition =>
  ({
    id: 7,
    ticker: 'NVDA',
    runId: 'u',
    condId: 'U1',
    direction: 'DOWN',
    kind: 'EVENT',
    text: 'TrendForce 公布 HBM 合約價季跌',
    check: { type: 'event', confirm_by: ['web:trendforce.com'] },
    tierIfMet: 'HALF',
    status: 'REVIEW_ONLY',
    createdAt: '2026-11-20T00:00:00.000Z',
    metAt: null,
    note: null,
    origin: 'USER',
    acceptedAt: '2026-11-20T00:00:00.000Z',
    ...o,
  }) as FileCondition;
function fileOf(o: Partial<ThesisFile> = {}): ThesisFile {
  return {
    ticker: 'NVDA',
    fileId: 'NVDA@2026-11-19',
    openedAt: '2026-11-19',
    origin: 'INITIAL',
    kind: 'THESIS',
    status: 'OPEN',
    thesis: null,
    premises: [prem('P1', 'HOLDS'), prem('P2', 'HOLDS')],
    conditions: [],
    events: [],
    reviews: [],
    disputes: [],
    flags: [],
    lastReview: LAST,
    newSince: '2026-09-01',
    log: [],
    ...o,
  };
}
const OLD = [{ form: '10-Q', filingDate: '2026-10-30', acceptedAt: '2026-10-30T20:10:00.000Z' }];
const at = (asOf: string) => ({ ...LAST, asOf, createdAt: `${asOf}T23:40:00.000Z` });
const peerK = (filingDate: string, items: string[], acceptedAt = `${filingDate}T21:00:00.000Z`) => ({ form: '8-K', filingDate, acceptedAt, items });

describe('newEvidence：WEB_DUE（需要外部資料的前提或條件，滿 25 天）', () => {
  it('你的前提最近一次是三票一致的證據不足、或還沒檢查過 → 滿 25 天算 WEB_DUE；24 天不算', () => {
    expect(WEB_DUE_DAYS).toBe(25);
    const insufficient = { premises: [prem('P1', 'HOLDS'), prem('P2', 'INSUFFICIENT')] };
    expect(newEvidence(fileOf({ ...insufficient, lastReview: at('2026-12-05') }), OLD, ASOF)).toEqual(['WEB_DUE']); // 25 天
    expect(newEvidence(fileOf({ ...insufficient, lastReview: at('2026-12-06') }), OLD, ASOF)).toEqual([]); // 24 天
    expect(newEvidence(fileOf({ premises: [prem('P1', 'HOLDS'), prem('P3', null)] }), OLD, ASOF)).toEqual(['WEB_DUE']); // 還沒檢查過
    expect(EVIDENCE_TEXT.WEB_DUE).toBe('有要上網查的前提或條件，距上次審查滿 25 天');
  });

  it('你定的、監測中的條件指名了網頁來源 → WEB_DUE；建議中、已撤下、沒指名的不算', () => {
    expect(newEvidence(fileOf({ conditions: [cond()] }), OLD, ASOF)).toEqual(['WEB_DUE']);
    expect(newEvidence(fileOf({ conditions: [cond({ status: 'ACTIVE', check: { type: 'event', confirm_by: ['8-K', 'web:trendforce.com'] } })] }), OLD, ASOF)).toEqual(['WEB_DUE']);
    expect(newEvidence(fileOf({ conditions: [cond({ status: 'PROPOSED', origin: 'AI', acceptedAt: null })] }), OLD, ASOF)).toEqual([]);
    expect(newEvidence(fileOf({ conditions: [cond({ status: 'RETIRED' })] }), OLD, ASOF)).toEqual([]);
    expect(newEvidence(fileOf({ conditions: [cond({ check: { type: 'event', confirm_by: ['major_news'] } })] }), OLD, ASOF)).toEqual([]);
  });

  it('沒有的照舊：前提都成立或不成立、系統預設前提的證據不足、只有預設前提的論點檔都不算；舊的呼叫端（沒給前提與條件）不算', () => {
    expect(newEvidence(fileOf({ premises: [prem('P1', 'HOLDS'), prem('P2', 'BROKEN')] }), OLD, ASOF)).toEqual([]);
    expect(newEvidence(fileOf({ premises: [prem('P1', 'HOLDS'), prem('P3', 'INSUFFICIENT', 'SYSTEM_DEFAULT')] }), OLD, ASOF)).toEqual([]);
    expect(newEvidence(fileOf({ kind: 'DEFAULT_ONLY', premises: [prem('P1', 'INSUFFICIENT', 'SYSTEM_DEFAULT'), prem('P2', null, 'SYSTEM_DEFAULT')] }), OLD, ASOF)).toEqual([]);
    const { kind: _k, premises: _p, conditions: _c, ...partial } = fileOf({ premises: [prem('P2', 'INSUFFICIENT')] });
    expect(newEvidence(partial, OLD, ASOF)).toEqual([]);
    // 還沒有過有結論的審查：照舊只回 NEVER
    expect(newEvidence(fileOf({ lastReview: null, premises: [prem('P2', 'INSUFFICIENT')] }), OLD, ASOF)).toEqual(['NEVER']);
  });

  it('externalNeeds：列出是哪幾條（前提編號、條件的列編號）；只有預設前提的是空的', () => {
    expect(externalNeeds(fileOf({ premises: [prem('P1', 'HOLDS'), prem('P2', 'INSUFFICIENT'), prem('P3', null)], conditions: [cond(), cond({ id: 8, check: { type: 'event', confirm_by: ['8-K'] } })] }))).toEqual({ premises: ['P2', 'P3'], conds: [7] });
    expect(externalNeeds(fileOf({ kind: 'DEFAULT_ONLY', premises: [prem('P1', null, 'SYSTEM_DEFAULT')], conditions: [cond()] }))).toEqual({ premises: [], conds: [] });
  });
});

describe('newEvidence：PEER（同業有新的財報新聞稿）', () => {
  it('同業在上次有結論的審查之後的 8-K Item 2.02 → PEER；別種 8-K、審查之前的、決策日之後的不算；同一天看接受時間', () => {
    expect(newEvidence(fileOf(), OLD, ASOF, [peerK('2026-12-17', ['2.02', '9.01'])])).toEqual(['PEER']);
    expect(newEvidence(fileOf(), OLD, ASOF, [peerK('2026-12-17', ['8.01']), peerK('2026-11-20', ['2.02'])])).toEqual([]);
    expect(newEvidence(fileOf(), OLD, ASOF, [peerK('2026-12-31', ['2.02'])])).toEqual([]);
    expect(newEvidence(fileOf(), OLD, ASOF, [peerK('2026-12-01', ['2.02'], '2026-12-01T23:50:00.000Z')])).toEqual(['PEER']);
    expect(newEvidence(fileOf(), OLD, ASOF, [peerK('2026-12-01', ['2.02'], '2026-12-01T21:00:00.000Z')])).toEqual([]);
    expect(EVIDENCE_TEXT.PEER).toBe('同業有新的財報新聞稿');
  });

  it('同業的申報抓不到（null）或沒給 → 不算（不是這檔自己的資料，不當成新證據）', () => {
    expect(newEvidence(fileOf(), OLD, ASOF, null)).toEqual([]);
    expect(newEvidence(fileOf(), OLD, ASOF)).toEqual([]);
    expect(newEvidence(fileOf(), OLD, ASOF, [])).toEqual([]);
  });

  it('月底審查的題目：PEER 請分析師看目錄；WEB_DUE 寫明是哪幾條（證據包的編號）', () => {
    const f = fileOf({ premises: [prem('P1', 'HOLDS'), prem('P2', 'INSUFFICIENT')], conditions: [cond()] });
    expect(lookForText(['FILING'], f, {})).toBeNull();
    expect(lookForText(['PEER'], f, {})).toBe('這次是月底檢查點：同業在上次有結論的審查之後有新的財報新聞稿（在 facts 的 M 開頭的目錄裡），請分析師看要不要取來讀。');
    expect(lookForText(['WEB_DUE'], f, { C1: 7 })).toBe(`這次是月底檢查點：前提 P2，以及指名網頁來源的條件 C1 在公司的申報與財報裡可能查不到（上次證據不足、還沒檢查過，或要用指名的網頁來源確認），距上次有結論的審查已經滿 25 天，請分析師找有沒有清單內來源的新消息。`);
  });
});

// ---------------------------------------------------------------- 假的 EDGAR（NVDA 自己、同業 MU）、RSS、網頁

const PARA = (s: string) => `<p>${s.repeat(Math.ceil(260 / s.length))}</p>`;
const body = (tag: string) => Array.from({ length: 8 }, (_, i) => PARA(`Paragraph ${i} of ${tag}: contract prices for DRAM fell in the fourth quarter according to the survey. `)).join('\n');
const TF = 'https://www.trendforce.com/presscenter/news/20261111-memory.html';
const TF_PAGE = `<!doctype html><html><head><title>Site | TrendForce story</title><meta property="article:published_time" content="2026-11-11T08:00:00Z"></head><body><ul><li>Home</li></ul><h1>TrendForce story</h1>${body('TF')}</body></html>`;
const TF_QUOTE = 'contract prices for DRAM fell in the fourth quarter according to the survey';

function quarterFacts(qs: { end: string; rev: number; filed: string }[]): CompanyFacts {
  const rev: XbrlFact[] = qs.map((q) => {
    const [y, m] = q.end.split('-').map(Number);
    return { start: `${y}-${String(m - 2).padStart(2, '0')}-01`, end: q.end, val: q.rev, accn: `acc-${q.filed}`, form: '10-Q', filed: q.filed };
  });
  return { cik: 1045810, facts: { 'us-gaap': { Revenues: { units: { USD: rev } } } } };
}
const BASE = quarterFacts([
  { end: '2025-09-30', rev: 120, filed: '2025-11-01' },
  { end: '2026-09-30', rev: 160, filed: '2026-10-30' },
]);
interface FakeFiling {
  accession: string;
  form: string;
  items: string;
  acceptanceDateTime: string;
  filingDate: string;
  primaryDocument: string;
  html: string;
}
const TENQ: FakeFiling = { accession: '0001045810-26-000300', form: '10-Q', items: '', acceptanceDateTime: '2026-10-30T20:10:00.000Z', filingDate: '2026-10-30', primaryDocument: 'q.htm', html: '<html><body><p>Item 2. Management’s Discussion and Analysis</p><p>Revenue for the third quarter was $160 million.</p><p>Item 3. Quantitative</p></body></html>' };
const muK = (n: number, date: string, items: string): FakeFiling => ({ accession: `0000723125-26-00010${n}`, form: '8-K', items, acceptanceDateTime: `${date}T21:00:00.000Z`, filingDate: date, primaryDocument: `mu${n}.htm`, html: `<html><body><p>Item ${items.split(',')[0]} Micron reported record HBM revenue.</p></body></html>` });
const subs = (cik: string, name: string, fs: FakeFiling[]) => {
  const s = [...fs].sort((a, b) => b.acceptanceDateTime.localeCompare(a.acceptanceDateTime));
  return Response.json({ cik, name, tickers: [], filings: { recent: { accessionNumber: s.map((f) => f.accession), form: s.map((f) => f.form), items: s.map((f) => f.items), acceptanceDateTime: s.map((f) => f.acceptanceDateTime), filingDate: s.map((f) => f.filingDate), primaryDocument: s.map((f) => f.primaryDocument) } } });
};

interface Net {
  mu: FakeFiling[];
  muDown: boolean;
  calls: string[];
}
function fetcherOf(w: World, net: Net): Fetcher {
  const base = fakeFetcher(w);
  return async (url, init) => {
    net.calls.push(url);
    if (url === LINE_PUSH_URL) return Response.json({});
    if (url === 'https://api.example/fire') return Response.json({ claude_code_session_url: 'https://claude.ai/code/x' });
    if (url.includes('submissions/CIK0001045810.json')) return subs('1045810', 'NVIDIA CORP', [TENQ]);
    if (url.includes('submissions/CIK0000723125.json')) return net.muDown ? new Response('down', { status: 503 }) : subs('723125', 'MICRON TECHNOLOGY INC', net.mu);
    if (/companyfacts\/CIK\d+\.json/.test(url)) return Response.json(BASE);
    const doc = /Archives\/edgar\/data\/(\d+)\/(\d+)\/(.+)$/.exec(url);
    if (doc) {
      const f = [TENQ, ...net.mu].find((x) => x.accession.replace(/-/g, '') === doc[2]);
      if (!f) return new Response('nf', { status: 404 });
      return doc[3] === 'index.json' ? Response.json({ directory: { item: [{ name: f.primaryDocument }] } }) : new Response(f.html);
    }
    if (url.startsWith('https://www.nasdaq.com/feed/rssoutbound') || url.startsWith('https://feeds.finance.yahoo.com/rss/2.0/headline')) return new Response('<rss><channel></channel></rss>');
    if (url === TF) return new Response(TF_PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    return base(url, init);
  };
}

const USER_PREMISES = [
  { id: 'P1', text: '資料中心需求延續到 2027', origin: 'USER' as const },
  { id: 'P2', text: 'HBM 供給持續吃緊', origin: 'USER' as const },
];

interface Ctx {
  db: D1Database;
  env: Env;
  net: Net;
  fetcher: Fetcher;
  view: MarketView;
  axis: string[];
  call: <T = Record<string, unknown>>(method: 'GET' | 'POST', path: string, body?: unknown) => Promise<{ status: number; body: T }>;
}

async function withWorld(fn: (c: Ctx) => Promise<void>, opt: { defaults?: boolean; sources?: OwnWebSources | null } = {}) {
  const d = await freshDb();
  try {
    const db = d.db;
    const w = newWorld('2026-11-19');
    const net: Net = { mu: [], muDown: false, calls: [] };
    const env: Env = { DB: db, ADMIN_TOKEN: 't', AI_TASK_SECRET: 's', EDGAR_USER_AGENT: 'test bot test@example.com', SITE_URL: 'https://bot.example', LINE_CHANNEL_TOKEN: 'lt', LINE_USER_ID: 'U1', DEV_NO_AUTH: '1', ROUTINE_FIRE_URL: 'https://api.example/fire', ROUTINE_TOKEN: 'rt' };
    const fetcher = fetcherOf(w, net);
    await runFlow(env, fetcher, { now: cronTime('2026-11-19'), attempt: 'FIRST' });
    const { view, axis } = buildMarketView(await loadSeries(db, ['VOO', 'SGOV', 'NVDA']), '2026-11-19', 'VOO');
    const acct = createAccount({ paper: true, cash: 5000, core: { VOO: Math.floor(140_000 / view.close.VOO[view.i]) }, own: { NVDA: { shares: Math.floor(40_000 / view.close.NVDA[view.i]), stdWeight: 0.15, premises: opt.defaults ? structuredClone(SYSTEM_DEFAULT_PREMISES) : USER_PREMISES } } }, view);
    if (opt.sources) acct.own.NVDA.webSources = structuredClone(opt.sources);
    await saveAccount(db, acct, null, '建立帳戶', new Date('2026-11-19T12:00:00Z'));
    const call: Ctx['call'] = async (method, path, b) => {
      const r = await handle(new Request(`https://bot.example${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer s' }, ...(b === undefined ? {} : { body: JSON.stringify(b) }) }), env, fetcher, new Date('2026-11-20T00:10:00Z'));
      return { status: r.status, body: (await r.json()) as never };
    };
    await fn({ db, env, net, fetcher, view, axis, call });
  } finally {
    await d.dispose();
  }
}

const acctOf = async (db: D1Database): Promise<Account> => (await loadAccount(db))!.acct;
const CHECKS: FilingCheck[] = [{ ticker: 'NVDA', cik: '0001045810', names: [], sic: null, all: [{ accession: TENQ.accession, form: '10-Q', filingDate: TENQ.filingDate, acceptedAt: TENQ.acceptanceDateTime, items: [], primaryDocument: 'q.htm' }], fresh: [], latest: '' }];

/** 直接呼叫開執行的函式用的 StartCtx（view 的日子改成 session：價格只到 11-19，只看日期判斷）。 */
async function startCtx(c: Ctx, session: string, o: { reduced?: { ticker: string; session: string }[] } = {}): Promise<StartCtx> {
  return { env: c.env, fetcher: c.fetcher, acct: await acctOf(c.db), view: { ...c.view, date: session }, axis: c.axis, session, ov: {}, now: new Date(`${session}T23:45:00Z`), checks: CHECKS, res: { created: [], started: [], log: [], alerts: [] }, extras: { reduced: o.reduced ?? [] } };
}

/** 一次之前有結論的定期審查（三票一致不動）：每一票對每條前提的判斷照 prem；applied_at 先填好，流程不會再套用它。 */
async function addReview(c: Ctx, runId: string, asOf: string, prem: Record<string, string>) {
  const pack = ownReviewPack({ acct: await acctOf(c.db), view: { ...c.view, date: asOf }, axis: c.axis, ticker: 'NVDA', runId, trigger: 'MANUAL', xbrl: null, filings: [], news: null, dataQuality: {}, now: new Date(`${asOf}T23:40:00Z`) }).pack;
  const sample = (index: number) => ({ index, valid: true, verdict: 'HOLD', rawVerdict: 'HOLD', issues: [], evidence: [], premises: Object.entries(prem).map(([premise_id, status]) => ({ premise_id, status, evidence_ids: [] })), conditions: [], abstainReason: null, dataMissing: [], model: 'm', payload: {}, report: '維持' });
  const outcome = { status: 'AGREED', verdict: 'HOLD', votes: { HOLD: 3 }, actionable: false, followRule: true, reason: '', samples: [0, 1, 2].map(sample) };
  await c.db
    .prepare("INSERT INTO ai_runs (run_id, fn, ticker, as_of, created_at, status, prompt_version, pack_hash, pack, outcome, applied_at) VALUES (?, 'OWN_REVIEW', 'NVDA', ?, ?, 'DONE', 'own_review_v3', 'h', ?, ?, ?)")
    .bind(runId, asOf, `${asOf}T23:40:00.000Z`, JSON.stringify(pack), JSON.stringify(outcome), `${asOf}T23:41:00.000Z`)
    .run();
}
const reviewsSince = async (db: D1Database, from: string): Promise<AiRun[]> => (await listRuns(db, new Date('2027-01-05T00:00:00Z'), { limit: 500 })).filter((r) => r.fn === 'OWN_REVIEW' && r.asOf >= from);
const stateOf = async (db: D1Database, key: string) => JSON.parse((await db.prepare('SELECT value FROM flow_state WHERE key = ?').bind(key).first<{ value: string }>())!.value) as Record<string, unknown>;

// 12-30 是月報（12-31）前一天 = 月底檢查點
const CHECKPOINT = '2026-12-30';

// ---------------------------------------------------------------- 月底檢查點

describe('月底檢查點：WEB_DUE（web_evidence_design §1.7）', () => {
  it('有證據不足的前提、距上次有結論的審查滿 25 天 → 照審（MONTHLY，原因 WEB_DUE），題目寫明哪一條、請分析師找；運作統計算進 web_due', async () => {
    await withWorld(async (c) => {
      await addReview(c, 'rev-1201', '2026-12-01', { P1: 'HOLDS', P2: 'INSUFFICIENT' }); // 29 天
      const sc = await startCtx(c, CHECKPOINT);
      await startOwnRuns(sc);
      const [r] = await reviewsSince(c.db, CHECKPOINT);
      expect(sc.res.started).toEqual([r.runId]);
      expect(r.pack.rule.detail).toMatchObject({ trigger: 'MONTHLY', reasons: ['WEB_DUE'] });
      expect(r.pack.question.startsWith('這次是月底檢查點：前提 P2 在公司的申報與財報裡可能查不到')).toBe(true);
      expect(r.pack.question).toContain('請分析師找有沒有清單內來源的新消息。');
      expect(sc.res.log.join('\n')).toContain('NVDA：月底檢查點有新證據（有要上網查的前提或條件，距上次審查滿 25 天），開審查');
      expect(await stateOf(c.db, checkpointKey(CHECKPOINT))).toMatchObject({ reviewed: [{ ticker: 'NVDA', reasons: ['WEB_DUE'] }], skipped: [] });
      const sec = await checkpointSection(c.db, { from: '2026-12-01', to: '2026-12-31', fromSource: 'param' });
      expect(sec.rows[0]).toMatchObject({ reviewed: 1, web_due: 1, peer: 0, filing: 0 });
      // 可以取文件：證據包有清單內的網頁來源（S），doc_ctx 沒有被關掉
      expect(r.pack.facts.some((f) => /^S\d+$/.test(f.id))).toBe(true);
      expect(r.docCtx?.off ?? null).toBeNull();
    });
  });

  it('你定的條件指名了網頁來源（前提都成立）→ 也照審，題目寫條件在證據包的編號', async () => {
    await withWorld(async (c) => {
      const fileId = (await acctOf(c.db)).own.NVDA.fileId ?? null;
      await c.db.batch(insertConditionStmts(c.db, 'NVDA', 'u-1', [{ ticker: 'NVDA', runId: 'u-1', condId: 'U1', direction: 'DOWN', kind: 'EVENT', text: 'TrendForce 公布 HBM 合約價季跌', check: { type: 'event', confirm_by: ['web:trendforce.com'] }, tierIfMet: 'HALF', manual: false, action: 'HALF' }], '2026-11-25T00:00:00.000Z', 'USER', fileId));
      await addReview(c, 'rev-1201', '2026-12-01', { P1: 'HOLDS', P2: 'HOLDS' });
      const sc = await startCtx(c, CHECKPOINT);
      await startOwnRuns(sc);
      const [r] = await reviewsSince(c.db, CHECKPOINT);
      expect(r.pack.rule.detail).toMatchObject({ trigger: 'MONTHLY', reasons: ['WEB_DUE'] });
      expect(r.pack.question.startsWith('這次是月底檢查點：指名網頁來源的條件 C1 在公司的申報與財報裡可能查不到')).toBe(true);
      expect(r.pack.facts.find((f) => f.id === 'C1')!.value).toContain('TrendForce 公布 HBM 合約價季跌');
    });
  });

  it('沒有的照舊跳過：前提都成立；證據不足但只隔 24 天；只有系統預設前提（證據不足也不算）', async () => {
    for (const [label, setup] of [
      ['都成立', async (c: Ctx) => addReview(c, 'rev-1201', '2026-12-01', { P1: 'HOLDS', P2: 'HOLDS' })],
      ['24 天', async (c: Ctx) => addReview(c, 'rev-1206', '2026-12-06', { P1: 'HOLDS', P2: 'INSUFFICIENT' })],
    ] as const) {
      await withWorld(async (c) => {
        await setup(c);
        const sc = await startCtx(c, CHECKPOINT);
        await startOwnRuns(sc);
        expect(sc.res.started, label).toEqual([]);
        expect((await acctOf(c.db)).own.NVDA.reviewSkip, label).toMatchObject({ month: '2026-12' });
        expect((await stateOf(c.db, checkpointKey(CHECKPOINT))).reviewed, label).toEqual([]);
      });
    }
    await withWorld(
      async (c) => {
        await addReview(c, 'rev-1201', '2026-12-01', { P1: 'INSUFFICIENT', P2: 'INSUFFICIENT', P3: 'INSUFFICIENT' });
        const sc = await startCtx(c, CHECKPOINT);
        await startOwnRuns(sc);
        expect(sc.res.started).toEqual([]);
        expect((await acctOf(c.db)).own.NVDA.reviewSkip).toMatchObject({ month: '2026-12', since: '2026-12-01' });
      },
      { defaults: true },
    );
  });
});

describe('月底檢查點：PEER（同業有新的財報新聞稿）', () => {
  const WS: OwnWebSources = { peers: [{ name: 'Micron', edgar: 'MU' }], domains: [] };

  it('同業在上次有結論的審查之後送了 8-K Item 2.02 → 照審（原因 PEER），題目請分析師看目錄，目錄第一項就是那份新聞稿', async () => {
    await withWorld(
      async (c) => {
        c.net.mu = [muK(1, '2026-09-25', '2.02'), muK(2, '2026-12-17', '2.02,9.01')];
        await addReview(c, 'rev-1210', '2026-12-10', { P1: 'HOLDS', P2: 'HOLDS' });
        const sc = await startCtx(c, CHECKPOINT);
        await startOwnRuns(sc);
        const [r] = await reviewsSince(c.db, CHECKPOINT);
        expect(r.pack.rule.detail).toMatchObject({ trigger: 'MONTHLY', reasons: ['PEER'] });
        expect(r.pack.question.startsWith('這次是月底檢查點：同業在上次有結論的審查之後有新的財報新聞稿')).toBe(true);
        expect(r.pack.facts.find((f) => f.id === 'M1')!.value).toBe('Micron｜8-K 2.02（財報新聞稿）｜2026-12-17');
        const sec = await checkpointSection(c.db, { from: '2026-12-01', to: '2026-12-31', fromSource: 'param' });
        expect(sec.rows[0]).toMatchObject({ reviewed: 1, peer: 1, web_due: 0 });
      },
      { sources: WS },
    );
  });

  it('同業只有別種 8-K、或財報新聞稿在上次審查之前 → 不算，照舊跳過', async () => {
    await withWorld(
      async (c) => {
        c.net.mu = [muK(1, '2026-12-05', '2.02'), muK(2, '2026-12-17', '8.01')];
        await addReview(c, 'rev-1210', '2026-12-10', { P1: 'HOLDS', P2: 'HOLDS' });
        const sc = await startCtx(c, CHECKPOINT);
        await startOwnRuns(sc);
        expect(sc.res.started).toEqual([]);
        expect((await acctOf(c.db)).own.NVDA.reviewSkip).toMatchObject({ month: '2026-12', since: '2026-12-10' });
      },
      { sources: WS },
    );
  });

  it('同業的申報抓不到 → 不算、寫進紀錄，照舊跳過；沒有填同業 → 不去抓同業', async () => {
    await withWorld(
      async (c) => {
        c.net.muDown = true;
        await addReview(c, 'rev-1210', '2026-12-10', { P1: 'HOLDS', P2: 'HOLDS' });
        const sc = await startCtx(c, CHECKPOINT);
        await startOwnRuns(sc);
        expect(sc.res.started).toEqual([]);
        expect(sc.res.log.join('\n')).toContain('NVDA 的同業 Micron（MU）的申報抓不到（月底檢查點不算同業的新申報）');
      },
      { sources: WS },
    );
    await withWorld(async (c) => {
      await addReview(c, 'rev-1210', '2026-12-10', { P1: 'HOLDS', P2: 'HOLDS' });
      const before = c.net.calls.length;
      await startOwnRuns(await startCtx(c, CHECKPOINT));
      expect(c.net.calls.slice(before).some((u) => u.includes('CIK0000723125'))).toBe(false);
    });
  });
});

describe('大跌無申報、有論點、月審在 3 個交易日內（留給月審）', () => {
  it('提前審查標「留給月審」；月底檢查點把它當成新的事件照審（價格規則的事件原本不算新證據）', async () => {
    await withWorld(async (c) => {
      await addReview(c, 'rev-1210', '2026-12-10', { P1: 'HOLDS', P2: 'HOLDS' });
      const id = (await c.db
        .prepare("INSERT INTO sec_events (ticker, accession, form, event_date, accepted_at, code, sub, by_rule, display_only, source, detail, status, created_at, detail_code) VALUES ('NVDA', 'price:NVDA:2026-12-24', 'RULE', '2026-12-24', NULL, 'PRICE_DROP', 'RULE_IDIO_21D', 1, 0, 'PRICE', '最近 21 個交易日：個股 -18.2%，大盤（VOO）-5.1%，個股自身 -13.1%', 'NEW', '2026-12-24T23:35:00.000Z', 'IDIO_21D') RETURNING id")
        .first<{ id: number }>())!.id;
      const sc = await startCtx(c, '2026-12-24');
      await startEarlyReviews(sc);
      expect(sc.res.started).toEqual([]);
      expect(await c.db.prepare('SELECT status, handled_note FROM sec_events WHERE id = ?').bind(id).first()).toEqual({ status: 'HANDLED', handled_note: EARLY_NOTE.monthly });
      const sc2 = await startCtx(c, CHECKPOINT);
      await startOwnRuns(sc2);
      const [r] = await reviewsSince(c.db, CHECKPOINT);
      expect(r.pack.rule.detail).toMatchObject({ trigger: 'MONTHLY', reasons: ['EVENT'] });
    });
  });
});

// ---------------------------------------------------------------- 減半檢視（F7）：分析師可以找

describe('減半檢視：分析師可以另外找資料（web_evidence_design §1.7、§1.8）', () => {
  it('prompt 升成 own_drop_v3：多分析師找資料、三票不上網、送回 lookups；v2 標不再使用', () => {
    // T61 升成 v4（判成立要有正面的引用）：T54 的這些內容 v4 要照樣有
    expect(OWN_DROP_PROMPT).toBe('own_drop_v4');
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'ai', 'prompts');
    const v3 = readFileSync(join(root, `${OWN_DROP_PROMPT}.md`), 'utf8');
    expect(v3).toContain('**只有分析師可以用 WebSearch、可以取文件。**');
    expect(v3).toContain('**三票不要用 WebSearch、不要取文件。**');
    expect(v3).toContain('"lookups": {');
    expect(v3).toContain('你這一票要引用**兩個不同網域**的文件才算');
    expect(readFileSync(join(root, 'own_drop_v2.md'), 'utf8').split('\n')[0]).toContain('不再使用（2026-11-20）：T54 起改用 `own_drop_v3.md`');
  });

  it('有論點：證據包有清單內的網頁來源（S）與目錄（M）、doc_ctx 記可以取什麼；分析師取回 TrendForce 的網頁，三票引用它判前提不成立 → 建議出清；紀錄列出另外找了什麼', async () => {
    await withWorld(
      async (c) => {
        c.net.mu = [muK(1, '2026-11-05', '2.02')];
        const sc = await startCtx(c, '2026-11-19', { reduced: [{ ticker: 'NVDA', session: '2026-11-19' }] });
        await startDropRuns(sc);
        const drop = (await listRuns(c.db, new Date('2026-11-20T00:00:00Z'), { limit: 50 })).find((x) => x.fn === 'OWN_DROP')!;
        expect(sc.res.started).toContain(drop.runId);
        expect(drop.promptVersion).toBe('own_drop_v4');
        expect(drop.pack.facts.some((f) => /^S\d+$/.test(f.id))).toBe(true);
        expect(drop.pack.facts.find((f) => f.id === 'M1')!.value).toBe('Micron｜8-K 2.02（財報新聞稿）｜2026-11-05');
        expect(drop.docCtx).toMatchObject({ menu: [{ id: 'M1', kind: 'filing', peer: 'Micron' }] });
        expect(drop.docCtx!.off ?? null).toBeNull();
        // 分析師：先取證據包，再向 Worker 取網頁
        expect((await c.call('GET', `/ai/task/${drop.taskId}/evidence`)).status).toBe(200);
        const got = await c.call<{ docs: { source_id: string; date: string; kind: string; tier: string; text: string }[] }>('POST', `/ai/task/${drop.taskId}/docs`, { role: '分析師', want: [{ url: TF, title: 'DRAM contract prices fall', for: 'P2', why: '跌是不是因為合約價轉弱' }] });
        expect(got.status).toBe(200);
        const doc = got.body.docs[0];
        expect(doc).toMatchObject({ kind: 'web', tier: 'NAMED', date: '2026-11-11' });
        expect(doc.text).toContain(TF_QUOTE);
        // 三票出清，都判 P2 不成立、引用取回的網頁（指名的產業來源）
        const v = { run_id: drop.runId, verdict: 'EXIT', model: 'claude-sonnet-5-5', premise_checks: [{ premise_id: 'P1', status: 'INSUFFICIENT', evidence_ids: [] }, { premise_id: 'P2', status: 'BROKEN', evidence_ids: ['E1'] }], evidence: [{ id: 'E1', source_id: doc.source_id, date: doc.date, quote: TF_QUOTE, claim: 'TrendForce 2026-11-11 的新聞稿說 DRAM 合約價下跌' }], payload: { tier: 'EXIT', cause_class: 'FUNDAMENTAL' }, report: 'P2 不成立：TrendForce 的新聞稿說合約價下跌。' };
        const lookups = { questions: [{ for: 'P2', ask: '跌是不是因為合約價轉弱' }], queries: ['TrendForce DRAM contract price'], wanted: [{ url: TF, for: 'P2', why: '合約價', got: doc.source_id }] };
        const res = await c.call('POST', `/ai/task/${drop.taskId}/result`, { task_id: drop.taskId, kind: 'RUN', run_id: drop.runId, samples: [v, v, v], process: [{ role: '分析師', text: '摘要' }], lookups });
        expect(res.status).toBe(200);
        const done = (await getRun(c.db, drop.runId))!;
        expect(dropDecision(done.outcome!, done.pack)).toMatchObject({ status: 'EXIT', premiseId: 'P2' });
        const found = foundView(done)!;
        expect(found.state).toBe('GOT');
        expect(found.docs[0]).toMatchObject({ source: 'TrendForce', votes: 3 });
        expect(found.queries).toEqual(['TrendForce DRAM contract price']);
      },
      { sources: { peers: [{ name: 'Micron', edgar: 'MU' }], domains: [] } },
    );
  });

  it('只有系統預設前提：沒有目錄與網頁來源、doc_ctx 關掉，取文件回 403', async () => {
    await withWorld(
      async (c) => {
        const sc = await startCtx(c, '2026-11-19', { reduced: [{ ticker: 'NVDA', session: '2026-11-19' }] });
        await startDropRuns(sc);
        const drop = (await listRuns(c.db, new Date('2026-11-20T00:00:00Z'), { limit: 50 })).find((x) => x.fn === 'OWN_DROP')!;
        expect(drop.promptVersion).toBe('own_drop_v4');
        expect(drop.pack.facts.some((f) => /^[SM]\d+$/.test(f.id))).toBe(false);
        expect(drop.docCtx!.off).toBe('只有系統預設前提：不用網頁證據');
        await c.call('GET', `/ai/task/${drop.taskId}/evidence`);
        expect((await c.call('POST', `/ai/task/${drop.taskId}/docs`, { want: [{ url: TF, for: 'P1', why: 'x' }] })).status).toBe(403);
      },
      { defaults: true },
    );
  });
});
