// T85 丙段：草稿、非價格的進場條件、月底確認、一年的提醒、討論包（allocation_redesign §4.5 第 18～25 點）。
// 完成條件：
//   1. 候補也可以草擬：證據包是候補的說法（R1 還沒持有、沒有 R3）、輸出多 entries 1～3 條；寫了價格條件整份退回；持有中的草稿不收 entries
//   2. 一鍵採用：entries 整組取代非價格的進場條件，你填的價格條件不動；財報門檻現在已經成立的直接標成立、記進 watch[t].entry
//   3. 自動草擬：加入 7 天內那一次（DRAFT_AUTO_DAILY 的限制、30 天防線）；T72 的觸發不替候補開
//   4. 候補期間只看 ENTRY：出場與加碼條件不會被用掉；進場後的下一次每日流程補比一次財報類條件
//   5. 非價格進場條件的確認：新申報 → F25（只讀申報）；月底檢查點有新證據才開 own_condition_v2，沒有就不開；引用照 condCite
//   6. 編輯論點頁的進場條件：走改寫、確認時另算 3 條；只有預設前提的候補擋下；持股不收
//   7. 一年沒進場的「要看的事」、討論包與 /admin/own/list 帶候補
// AI 的回覆一律是假的；對外請求全部是假的（EDGAR、RSS、雲端排程）。
import { describe, expect, it } from 'vitest';
import type { CheckedSample, EvidencePack, Outcome, PackDoc } from '../src/ai/check';
import { checkDraft, ownDraftPack, ENTRY_PRICE_ISSUE } from '../src/ai/ownDraft';
import { ownCheckResult } from '../src/ai/ownCheck';
import { OWN_CONDITION, conditionDecision } from '../src/ai/ownReview';
import { parseThesisBlock } from '../src/ai/discussion';
import type { ApplyCtx, StartCtx } from '../src/app/aiCtx';
import { finalizeRun, getRun } from '../src/app/aiRuns';
import type { Env, Fetcher } from '../src/app/env';
import { runFlow } from '../src/app/flow';
import { loadAccount, saveAccount } from '../src/app/ledgerStore';
import { applyOwnCondition, ownFacts, ownXbrlConditions, startWatchRuns, watchNewEvidence } from '../src/app/ownAi';
import { DRAFT_AUTO_DAILY, draftAdoptPlan, loadDrafts, settleDrafts, startAutoDrafts, startTriggerDrafts, watchDraftBlock, wouldBuyOf } from '../src/app/ownDraft';
import { entryConditions, fileConditions, loadConditions, monthOwnAttention, thesisFile, watchAttention, WATCH_STALE_DAYS } from '../src/app/thesis';
import type { HoldingDetail } from '../src/app/site/views';
import { buildMarketView } from '../src/data/marketView';
import { loadSeries } from '../src/data/store';
import type { QuarterRow } from '../src/data/edgar';
import { SYSTEM_DEFAULT_PREMISES, addWatch, createAccount, promoteWatch, type Account, type MarketView } from '../src/engine';
import { handle } from '../src/index';
import { freshDb } from './helpers/d1';
import { cronTime, fakeFetcher, newWorld, type World } from './helpers/fakeSources';

// ---------------------------------------------------------------- 假的世界

const Q_REV = 'Revenue for the third quarter was $160 million, up 33% from a year ago';
const RISK1 = 'Our three largest customers accounted for 61% of revenue';
const RISK2 = 'Export restrictions may limit our ability to sell to certain customers';
const RISK3 = 'Inventory provisions increased to $1.2 billion this quarter';
const TENQ_TEXT = `${Q_REV}. ${RISK1}. ${RISK2}. ${RISK3}.`;
const TENQ = { accession: '0000002488-26-000300', form: '10-Q', items: '', acceptanceDateTime: '2026-10-30T20:10:00.000Z', filingDate: '2026-10-30', primaryDocument: 'q.htm' };
const TENQ_HTML = `<html><body><p>Item 2. Management’s Discussion and Analysis of Financial Condition and Results of Operations</p><p>${TENQ_TEXT}</p><p>Item 3. Quantitative and Qualitative Disclosures About Market Risk</p></body></html>`;
const FACTS = { cik: 2488, facts: { 'us-gaap': { Revenues: { units: { USD: [{ start: '2025-07-01', end: '2025-09-30', val: 120, accn: 'a1', form: '10-Q', filed: '2025-11-01' }, { start: '2026-07-01', end: '2026-09-30', val: 160, accn: 'a2', form: '10-Q', filed: '2026-10-30' }] } } } } };

function fetcherOf(w: World, fire: { n: number }): Fetcher {
  const base = fakeFetcher(w);
  return async (url, init) => {
    if (url === 'https://api.example/fire') {
      fire.n++;
      return Response.json({ claude_code_session_url: 'https://claude.ai/code/x' });
    }
    if (url.includes('sec.gov/files/company_tickers.json')) return Response.json({ 0: { cik_str: 1045810, ticker: 'NVDA' }, 1: { cik_str: 2488, ticker: 'AMD' }, 2: { cik_str: 50863, ticker: 'INTC' }, 3: { cik_str: 789019, ticker: 'MSFT' } });
    if (/data\.sec\.gov\/submissions\/CIK\d+\.json/.test(url)) return Response.json({ cik: '2488', name: 'ADVANCED MICRO DEVICES', tickers: [], filings: { recent: { accessionNumber: [TENQ.accession], form: [TENQ.form], items: [TENQ.items], acceptanceDateTime: [TENQ.acceptanceDateTime], filingDate: [TENQ.filingDate], primaryDocument: [TENQ.primaryDocument] } } });
    if (/companyfacts\/CIK\d+\.json/.test(url)) return Response.json(FACTS);
    const doc = /Archives\/edgar\/data\/\d+\/(\d+)\/(.+)$/.exec(url);
    if (doc) return doc[2] === 'index.json' ? Response.json({ directory: { item: [{ name: 'q.htm' }] } }) : new Response(TENQ_HTML);
    if (url.startsWith('https://www.nasdaq.com/feed/rssoutbound') || url.startsWith('https://feeds.finance.yahoo.com/rss/2.0/headline')) return new Response('<rss><channel></channel></rss>');
    return base(url, init);
  };
}

interface Ctx {
  db: D1Database;
  env: Env;
  fire: { n: number };
  fetcher: Fetcher;
  view: MarketView;
  axis: string[];
  api: <T = Record<string, unknown>>(method: 'GET' | 'POST', path: string, body?: unknown, now?: Date) => Promise<{ status: number; body: T }>;
}

/** 2026-11-19 建立帳戶：NVDA 是自選（有論點）。AMD 由各測試加進候補。 */
async function withWorld(fn: (c: Ctx) => Promise<void>) {
  const d = await freshDb();
  try {
    const db = d.db;
    const w = newWorld('2026-11-19');
    const fire = { n: 0 };
    const env: Env = { DB: db, ADMIN_TOKEN: 't', AI_TASK_SECRET: 's', EDGAR_USER_AGENT: 'test bot test@example.com', SITE_URL: 'https://bot.example', DEV_NO_AUTH: '1', ROUTINE_FIRE_URL: 'https://api.example/fire', ROUTINE_TOKEN: 'rt' };
    const fetcher = fetcherOf(w, fire);
    const api: Ctx['api'] = async (method, path, body, now = new Date('2026-11-20T02:00:00Z')) => {
      const r = await handle(new Request(`https://bot.example/api/${path}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env, fetcher, now);
      return { status: r.status, body: (await r.json()) as never };
    };
    await runFlow(env, fetcher, { now: cronTime('2026-11-19'), attempt: 'FIRST' });
    const { view, axis } = buildMarketView(await loadSeries(db, ['VOO', 'SGOV', 'NVDA', 'AMD', 'INTC', 'MSFT']), '2026-11-19', 'VOO');
    const acct = createAccount({ paper: true, cash: 5000, core: { VOO: Math.floor(140_000 / view.close.VOO[view.i]) }, own: { NVDA: { shares: Math.floor(10_000 / view.close.NVDA[view.i]), stdWeight: 0.1, premises: [{ id: 'P1', text: '資料中心需求延續到 2027', origin: 'USER' }] } } }, view);
    acct.own.NVDA.thesis = { text: 'NVDA 的論點', setAt: '2026-11-19', source: 'TYPED', version: 1, afterBreak: 0, lastAfterBreakAt: null };
    await saveAccount(db, acct, null, '建立帳戶', new Date('2026-11-19T12:00:00Z'));
    await fn({ db, env, fire, fetcher, view, axis, api });
  } finally {
    await d.dispose();
  }
}

const acctOf = async (db: D1Database): Promise<Account> => (await loadAccount(db))!.acct;
async function mutate(db: D1Database, f: (a: Account) => Account | void) {
  const loaded = (await loadAccount(db))!;
  const a = structuredClone(loaded.acct);
  await saveAccount(db, f(a) ?? a, loaded, '測試', new Date('2026-11-20T00:30:00Z'));
}
const startCtx = async (c: Ctx, session: string, now: Date, checks: StartCtx['checks'] = []): Promise<StartCtx> => ({ env: c.env, fetcher: c.fetcher, acct: await acctOf(c.db), view: { ...c.view, date: session }, axis: c.axis, session, ov: {}, now, checks, res: { created: [], started: [], log: [], alerts: [] }, extras: {} });
const applyCtx = async (c: Ctx, session: string): Promise<ApplyCtx> => ({ db: c.db, acct: await acctOf(c.db), view: c.view, axis: c.axis, session, now: new Date(`${session}T23:00:00Z`), stmts: [], log: [] });

/** 直接寫一條條件（進場條件 action ENTRY）。 */
async function seed(db: D1Database, o: { ticker?: string; fileId: string; text: string; kind?: string; check: Record<string, unknown>; action: string; status?: string; origin?: string; condId?: string }): Promise<number> {
  const r = await db
    .prepare("INSERT INTO own_conditions (ticker, run_id, cond_id, direction, kind, text, check_json, tier_if_met, status, created_at, note, origin, file_id, accepted_at, action, auto) VALUES (?, 'seed', ?, ?, ?, ?, ?, NULL, ?, '2026-11-19T12:00:00Z', NULL, ?, ?, '2026-11-19T12:00:00Z', ?, 1)")
    .bind(o.ticker ?? 'AMD', o.condId ?? 'S1', o.action === 'EXIT' || o.action === 'HALF' || o.action === 'REVIEW' ? 'DOWN' : 'UP', o.kind ?? 'EVENT', o.text, JSON.stringify(o.check), o.status ?? 'ACTIVE', o.origin ?? 'USER', o.fileId, o.action)
    .run();
  return r.meta.last_row_id;
}
const byId = async (db: D1Database, id: number) => (await loadConditions(db, undefined, undefined)).concat(await loadConditions(db, undefined, undefined, 'only')).find((c) => c.id === id)!;

const AMD_FILE = 'AMD@2026-11-19';
const REV_ABOVE = (level: number) => ({ type: 'xbrl_metric_above', metric: 'RevenueYoY', level, quarters: 1 });
const EV = (by: string[]) => ({ type: 'event', confirm_by: by });

// ---------------------------------------------------------------- 草稿的 payload

const PREMISES = [
  { text: '資料中心 GPU 的營收逐季成長', keep_id: null, confirms_if: '10-Q 的資料中心營收季增', breaks_if: ['資料中心營收連兩季季減'], verify: { by: 'FILING' }, evidence_ids: ['E1'] },
  { text: '營收年增率維持正的', keep_id: null, confirms_if: '10-Q 的營收年增為正', breaks_if: ['之後任一季營收年增轉負'], verify: { by: 'XBRL' }, evidence_ids: ['E1'] },
  { text: '大客戶不會自研取代', keep_id: null, confirms_if: null, breaks_if: ['大客戶宣布自研晶片量產'], verify: { by: 'NONE' }, evidence_ids: [] },
];
const EXITS = [
  { text: '營收年增率連兩季低於 0%', action: 'HALF', kind: 'XBRL', check: { type: 'xbrl_metric_below', metric: 'RevenueYoY', level: 0, quarters: 2 }, premise_index: 1, evidence_ids: ['E1'] },
  { text: '公司在 8-K 下修全年財測', action: 'REVIEW', kind: 'EVENT', check: EV(['8-K']), premise_index: 0, evidence_ids: [] },
];
const ENTRY_MET = { text: '最近一季營收年增高於 20%（最新一季 33%）', action: 'ENTRY', kind: 'XBRL', check: REV_ABOVE(0.2), premise_index: 1, evidence_ids: ['E1'] };
const ENTRY_EV = { text: '公司在 8-K 宣布拿到大型雲端客戶的 MI 系列訂單', action: 'ENTRY', kind: 'EVENT', check: EV(['8-K']), premise_index: 0, evidence_ids: [] };
function draftPayload(o: { entries?: unknown[] | null } = {}): Record<string, unknown> {
  return {
    thesis: '想等 AMD 的資料中心營收證實再買：靠 GPU 營收成長與營收年增。',
    premises: PREMISES,
    exits: EXITS,
    ...(o.entries === null ? {} : { entries: o.entries ?? [ENTRY_MET, ENTRY_EV] }),
    sources: { peers: [] },
    against: [
      { text: '營收集中在三家客戶', evidence_ids: ['E2'] },
      { text: '出口管制', evidence_ids: ['E3'] },
      { text: '存貨提列變大', evidence_ids: ['E4'] },
    ],
    would_buy_today: { answer: 'NO', why: '資料中心營收還沒證實，現在的價格先不買' },
    not_checkable: [],
  };
}
const evOf = (q: Pick<PackDoc, 'source_id' | 'date'>) => [Q_REV, RISK1, RISK2, RISK3].map((quote, k) => ({ id: `E${k + 1}`, source_id: q.source_id, date: q.date, quote, claim: '測試' }));

/** 一票草稿的 CheckedSample（純函式測試用：引用都算通過）。 */
const sampleOf = (payload: Record<string, unknown>, doc: PackDoc): CheckedSample => ({ index: 0, valid: true, verdict: 'DONE', rawVerdict: 'DONE', issues: [], evidence: evOf(doc).map((e) => ({ ...e, ok: true })) as never, premises: [], conditions: [], abstainReason: null, dataMissing: [], model: null, payload, report: null });
const DOC: PackDoc = { id: 'F-1', source_id: 'edgar:x', kind: 'filing', date: '2026-10-30', title: '10-Q', text: TENQ_TEXT };
const QROWS = [{ end: '2026-09-30', revenue: 160, grossMarginPct: null, operatingMarginPct: null, netMarginPct: null, revenueYoY: 1 / 3, epsDiluted: null, cfoToNetIncome: null }];
const METRICS = new Set(['GrossMarginPct', 'OperatingMarginPct', 'NetMarginPct', 'RevenueYoY', 'EPSDiluted', 'CfoToNetIncome', 'Revenue']);
const packOf = (watch: boolean): Pick<EvidencePack, 'documents' | 'premises' | 'rule'> => ({ documents: [DOC], premises: [], rule: { action: '', detail: { quarters: QROWS, ...(watch ? { watch: true } : {}) } } as never });

// ---------------------------------------------------------------- 1. 草稿的程式檢查（純函式）

describe('T85 丙 ①：候補的草稿多進場條件；價格條件整份退回；持有中的不收', () => {
  it('候補：1～3 條進場條件，action ENTRY、kind XBRL／EVENT；財報門檻現在已經成立的記 met_now', () => {
    const r = checkDraft(sampleOf(draftPayload(), DOC), packOf(true), METRICS);
    expect(r.errors).toEqual([]);
    expect(r.draft!.entries).toHaveLength(2);
    expect(r.draft!.entries![0]).toMatchObject({ action: 'ENTRY', kind: 'XBRL', threshold: true, met_now: { end: '2026-09-30' } });
    expect(r.draft!.entries![1]).toMatchObject({ action: 'ENTRY', kind: 'EVENT', check: { type: 'event', confirm_by: ['8-K'] }, met_now: null });
    // 沒寫門檻的財報條件沒成立
    const notYet = checkDraft(sampleOf(draftPayload({ entries: [{ ...ENTRY_MET, check: REV_ABOVE(0.5) }] }), DOC), packOf(true), METRICS);
    expect(notYet.draft!.entries![0].met_now).toBeNull();
  });

  it('候補寫了價格條件、沒有進場條件、超過 3 條 → 整份退回；持有中的草稿寫了 entries → 整份退回', () => {
    const price = checkDraft(sampleOf(draftPayload({ entries: [ENTRY_EV, { text: '比 52 週高點低 25% 以上', action: 'ENTRY', kind: 'PRICE', check: null }] }), DOC), packOf(true), METRICS);
    expect(price.draft).toBeNull();
    expect(price.errors.join('；')).toContain(ENTRY_PRICE_ISSUE);
    expect(checkDraft(sampleOf(draftPayload({ entries: null }), DOC), packOf(true), METRICS).errors.join('；')).toContain('候補的草稿要 1～3 條進場條件（送回 0 條）');
    expect(checkDraft(sampleOf(draftPayload({ entries: [ENTRY_EV, ENTRY_EV, ENTRY_EV, ENTRY_EV] }), DOC), packOf(true), METRICS).errors.join('；')).toContain('送回 4 條');
    const held = checkDraft(sampleOf(draftPayload(), DOC), packOf(false), METRICS);
    expect(held.draft).toBeNull();
    expect(held.errors.join('；')).toContain('這檔已經持有，草稿不收進場條件');
    // 持有中、沒有 entries → 照舊過
    expect(checkDraft(sampleOf(draftPayload({ entries: null }), DOC), packOf(false), METRICS).errors).toEqual([]);
  });

  it('證據包：候補的題目寫還沒持有、多進場條件；rule.detail.watch', () => {
    const { pack } = ownDraftPack({ runId: 'd', asOf: '2026-11-19', ticker: 'AMD', trigger: 'AUTO', held: false, watch: { addedAt: '2026-11-19' }, premises: [], facts: [], docs: [DOC], dataQuality: {}, thesisVersion: 0, fileId: AMD_FILE, broken: null, webDomains: [], now: new Date() });
    expect(pack.question).toContain('使用者還沒持有 AMD，2026-11-19 把它放進候補名單');
    expect(pack.question).toContain('1～3 條進場條件（payload.entries');
    expect(pack.question).toContain('不收價格條件');
    expect((pack.rule.detail as Record<string, unknown>).watch).toBe(true);
    const held = ownDraftPack({ runId: 'd', asOf: '2026-11-19', ticker: 'NVDA', trigger: 'AUTO', held: true, premises: [], facts: [], docs: [DOC], dataQuality: {}, thesisVersion: 0, fileId: null, broken: null, webDomains: [], now: new Date() }).pack;
    expect(held.question).not.toContain('進場條件');
    expect((held.rule.detail as Record<string, unknown>).watch).toBeUndefined();
  });
});

// ---------------------------------------------------------------- 2. 草擬與一鍵採用（真實模式）

/** 使用者按「請 stock bot 草擬」AMD、草稿回來（finalizeRun 直接收結果）。 */
async function draftBack(c: Ctx, payload: Record<string, unknown>, now = new Date('2026-11-20T02:00:00Z')) {
  const r = await c.api<{ runId: string }>('POST', 'ops/own-draft', { ticker: 'AMD' }, now);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  const run = (await getRun(c.db, r.body.runId))!;
  const q = run.pack.documents.find((d) => d.kind === 'filing')!;
  const task = await c.db.prepare('SELECT * FROM ai_tasks WHERE id = ?').bind(run.taskId).first();
  await finalizeRun(c.db, task as never, { samples: [{ run_id: run.runId, verdict: 'DONE', evidence: evOf(q), payload, report: '草稿。' }] }, new Date(now.getTime() + 600_000));
  await settleDrafts(c.db, new Date(now.getTime() + 600_000));
  return { run, row: (await loadDrafts(c.db, 'AMD'))[0] };
}

describe('T85 丙 ②：候補的草擬與一鍵採用', () => {
  it('按「請 stock bot 草擬」：候補可以按；證據包 R1 還沒持有、R2 打算放的比重、沒有 R3；草稿帶進場條件', async () => {
    await withWorld(async (c) => {
      expect((await c.api('POST', 'ops/watch-add', { ticker: 'AMD', note: 'AI 晶片的第二供應商', stdWeight: 4 / 100 })).status).toBe(200);
      const { run, row } = await draftBack(c, draftPayload());
      const facts = new Map(run.pack.facts.map((f) => [f.id, f]));
      expect(facts.get('R1')!.value).toBe('還沒持有（候補，11/19 加入）');
      expect(facts.get('R2')).toMatchObject({ label: '打算放的比重', value: '4.0%' });
      expect(facts.has('R3')).toBe(false);
      expect(facts.get('R4')!.label).toBe('自選合計占總資產');
      expect(facts.get('B1')!.value).toBe('AI 晶片的第二供應商');
      expect(run.pack.question).toContain('候補名單');
      expect(row.status, row.error ?? '').toBe('READY');
      expect(row.file_id).toBe(AMD_FILE);
      // 候補的詳細頁、編輯論點頁讀得到草稿；「今天會不會買」可以給 F29 用
      const dr = await c.api<{ draft: { payload: { entries: unknown[] } } }>('GET', 'own/AMD/draft');
      expect(dr.body.draft.payload.entries).toHaveLength(2);
      expect(await wouldBuyOf(c.db, 'AMD', AMD_FILE)).toEqual({ answer: '不會買（資料中心營收還沒證實，現在的價格先不買）', date: '2026-11-20' });
    });
  });

  it('一鍵採用：進場條件整組取代非價格的那一組、你填的價格條件不動；已經成立的財報門檻直接標成立、記進 watch[t].entry；出場條件寫進去但候補期間不監測', async () => {
    await withWorld(async (c) => {
      expect((await c.api('POST', 'ops/watch-add', { ticker: 'AMD' })).status).toBe(200);
      expect((await c.api('POST', 'ops/watch-price', { ticker: 'AMD', conds: [{ type: 'drawdown', value: 25 }] })).status).toBe(200);
      // 先寫一份論點（有自己的前提）與一條你寫的非價格進場條件
      await mutate(c.db, (a) => {
        a.watch!.AMD.premises = [{ id: 'P4', text: '舊的前提', origin: 'USER' }];
        a.watch!.AMD.thesis = { text: '舊的論點', setAt: '2026-11-19', source: 'TYPED', version: 1, afterBreak: 0, lastAfterBreakAt: null };
      });
      const old = await seed(c.db, { fileId: AMD_FILE, text: '公司在 8-K 宣布新的大客戶', check: EV(['8-K']), action: 'ENTRY' });
      const { row } = await draftBack(c, draftPayload());
      // 預覽：撤下舊的非價格進場條件、新增兩條進場條件；對照的標題寫進場條件
      const pv = await c.api<{ preview: { draft: { exitPlan: { add: { text: string; action: string }[]; retire: { id: number; entry?: boolean }[] } } } }>('POST', 'ops/own-draft/adopt', { ticker: 'AMD', id: row.id, dry: true });
      expect(pv.status, JSON.stringify(pv.body)).toBe(200);
      expect(pv.body.preview.draft.exitPlan.retire).toEqual([{ id: old, text: '公司在 8-K 宣布新的大客戶', entry: true }]);
      expect(pv.body.preview.draft.exitPlan.add.filter((x) => x.action === 'ENTRY').map((x) => x.text)).toEqual([ENTRY_MET.text, ENTRY_EV.text]);
      const res = await c.api<{ ok: boolean; conds: { added: number; retired: number[]; entryMet?: string[]; errors: string[] } }>('POST', 'ops/own-draft/adopt', { ticker: 'AMD', id: row.id });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.conds).toMatchObject({ added: 4, retired: [old], entryMet: [ENTRY_MET.text], errors: [] });
      const acct = await acctOf(c.db);
      const entries = await entryConditions(c.db, acct, 'AMD');
      const price = entries.find((x) => x.kind === 'PRICE')!;
      expect(price).toMatchObject({ status: 'ACTIVE', origin: 'USER', text: '比 52 週高點低 25% 以上' });
      expect((await byId(c.db, old)).status).toBe('RETIRED');
      const met = entries.find((x) => x.text === ENTRY_MET.text)!;
      const ev = entries.find((x) => x.text === ENTRY_EV.text)!;
      expect(met).toMatchObject({ status: 'MET', metBasis: 'XBRL', origin: 'AI_DRAFT_ACCEPTED', direction: 'UP', action: 'ENTRY' });
      expect(ev).toMatchObject({ status: 'ACTIVE', origin: 'AI_DRAFT_ACCEPTED', direction: 'UP', action: 'ENTRY' });
      expect(acct.watch!.AMD.entry).toEqual([expect.objectContaining({ id: met.id, text: ENTRY_MET.text, metOn: '2026-11-19' })]);
      // 出場條件寫進論點檔（候補期間不監測，進場後才開始）；不占進場條件、進場條件不占 8 條
      expect((await fileConditions(c.db, acct, 'AMD')).map((x) => [x.text, x.action])).toEqual([
        [EXITS[0].text, 'HALF'],
        [EXITS[1].text, 'REVIEW'],
      ]);
      expect(acct.watch!.AMD.thesis!.source).toBe('DRAFT');
      // 候補那一塊：等月報的那一條、其他條件的狀態、可以撤下的
      const hd = (await c.api<HoldingDetail>('GET', 'holding/AMD')).body;
      expect(hd.watch!.entries.find((e) => e.text === ENTRY_MET.text)!.state).toBe('已成立（11/19），等下一份月報');
      expect(hd.watch!.entries.find((e) => e.text === ENTRY_EV.text)).toMatchObject({ state: '監測中：新申報出來時由 AI 確認', retire: true, price: false });
      expect(hd.watch!.entries.find((e) => e.price)).toMatchObject({ retire: false });
      // 單條撤下非價格的進場條件（conditionOp 接上了）
      expect((await c.api('POST', 'ops/own-condition', { ticker: 'AMD', id: ev.id, op: 'retire' })).status).toBe(200);
      expect((await byId(c.db, ev.id)).status).toBe('RETIRED');
    });
  });

  it('draftAdoptPlan（純函式）：進場條件和出場條件分組比對，字一樣也不互相沿用', () => {
    const plan = draftAdoptPlan({ premises: [], exits: [{ text: 'X', action: 'REVIEW', premise_index: null, evidence_ids: [], kind: 'EVENT', check: EV(['8-K']), threshold: false }], entries: [{ text: 'X', action: 'ENTRY', premise_index: null, evidence_ids: [], kind: 'EVENT', check: EV(['8-K']), threshold: false }] }, [{ id: 7, text: 'X', action: 'ENTRY', status: '監測中', code: 'ACTIVE' }]);
    expect(plan.keep).toEqual([{ k: 1, id: 7, text: 'X', action: 'ENTRY', was: 'ENTRY' }]);
    expect(plan.add.map((x) => [x.k, x.action])).toEqual([[0, 'REVIEW']]);
    expect(plan.retire).toEqual([]);
  });
});

// ---------------------------------------------------------------- 3. 自動草擬

describe('T85 丙 ③：候補的自動草擬（加入 7 天內那一次）', () => {
  it('加入 7 天內、沒有論點 → 每日第一次流程開；一次加 3 檔分兩天開（DRAFT_AUTO_DAILY）；開過的不重開', async () => {
    await withWorld(async (c) => {
      for (const t of ['AMD', 'INTC', 'MSFT']) expect((await c.api('POST', 'ops/watch-add', { ticker: t })).status).toBe(200);
      const sc = await startCtx(c, '2026-11-20', new Date('2026-11-20T23:30:00Z'));
      await startAutoDrafts(sc);
      expect(sc.res.started).toHaveLength(DRAFT_AUTO_DAILY);
      expect(sc.res.log.join('\n')).toContain('今天已經自動草擬 2 檔，排到之後的日子');
      const runs = (await c.db.prepare("SELECT ticker FROM own_drafts WHERE trigger = 'AUTO' ORDER BY ticker").all<{ ticker: string }>()).results.map((r) => r.ticker);
      expect(runs).toEqual(['AMD', 'INTC']);
      // 隔天：剩下那一檔
      const sc2 = await startCtx(c, '2026-11-23', new Date('2026-11-23T23:30:00Z'));
      await startAutoDrafts(sc2);
      expect(sc2.res.started).toHaveLength(1);
      expect(sc2.res.started[0]).toContain('OWN_DRAFT_MSFT');
      // 第三天：都開過了（還在準備中的、回來的都算），不重開
      const sc3 = await startCtx(c, '2026-11-24', new Date('2026-11-24T23:30:00Z'));
      await startAutoDrafts(sc3);
      expect(sc3.res.started).toEqual([]);
    });
  });

  it('不開的：超過 7 天、已經有論點、上一份論點檔 30 天內前提被判不成立（防找理由買回）；T72 的觸發不替候補開', async () => {
    await withWorld(async (c) => {
      const acct = await acctOf(c.db);
      // 前提被判不成立而出清的 NVDA（移出自選時 brokenAt 抄進 ownClosed，甲段）、之後加進候補
      delete acct.own.NVDA;
      delete acct.rule.own.NVDA;
      acct.lots.own.NVDA = 0;
      acct.ownClosed = { NVDA: { fileId: 'NVDA@2026-11-19', reason: 'PICK_REMOVED' as never, date: '2026-11-13', brokenAt: '2026-11-12' } };
      const a = addWatch(acct, c.view, 'NVDA');
      expect(a.ownClosed!.NVDA.brokenAt).toBe('2026-11-12');
      expect(watchDraftBlock(a, 'NVDA', [], '2026-11-20')).toContain('上一份論點檔的前提被判不成立（30 天內），不自動草擬');
      expect(watchDraftBlock(a, 'NVDA', [], '2026-12-13')).toContain('加入候補超過 7 天');
      // 31 天之後就不擋（但已經超過 7 天了；這裡只看防線本身：把加入日往後挪）
      const late = structuredClone(a);
      late.watch!.NVDA.addedAt = '2026-12-13';
      expect(watchDraftBlock(late, 'NVDA', [], '2026-12-14')).toBeNull();
      // 有論點 → 不開
      const th = structuredClone(late);
      th.watch!.NVDA.thesis = { text: 'x', setAt: '2026-12-13', source: 'TYPED', version: 1, afterBreak: 0, lastAfterBreakAt: null };
      expect(watchDraftBlock(th, 'NVDA', [], '2026-12-14')).toBe('已經有論點');
      expect(watchDraftBlock(late, 'NVDA', [{ trigger: 'AUTO', status: 'FAILED', attn_keys: null }, { trigger: 'AUTO', status: 'FAILED', attn_keys: null }], '2026-12-14')).toContain('失敗 2 次');
      // T72 的觸發只看自選：只有預設前提、滿一年…都不會替候補開
      await saveAccount(c.db, late, (await loadAccount(c.db))!, '測試', new Date('2026-11-20T00:40:00Z'));
      const sc = await startCtx(c, '2027-12-20', new Date('2027-12-20T23:30:00Z'));
      await startTriggerDrafts(sc);
      expect(sc.res.started).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------- 4. 候補期間只看 ENTRY；進場後補比一次

const rowsOf = (yoy: number): QuarterRow[] => [{ end: '2026-09-30', filed: '2026-10-30', form: '10-Q', revenue: 160, revenueYoY: yoy, grossMarginPct: null, operatingMarginPct: null, netMarginPct: null, epsDiluted: null, cfoToNetIncome: null } as unknown as QuarterRow];

describe('T85 丙 ④：候補期間出場與加碼條件休眠，只看進場條件；進場後的下一次每日流程補比一次', () => {
  it('財報比對：候補只比進場條件（成立 → watch[t].entry）；出場、加碼條件不會被用掉；轉成持股後補比一次、記 xbrlAt', async () => {
    await withWorld(async (c) => {
      expect((await c.api('POST', 'ops/watch-add', { ticker: 'AMD' })).status).toBe(200);
      const exit = await seed(c.db, { fileId: AMD_FILE, text: '營收年增高於 10% → 重新審查', kind: 'XBRL', check: REV_ABOVE(0.1), action: 'REVIEW', condId: 'X1' });
      const add = await seed(c.db, { fileId: AMD_FILE, text: '營收年增高於 20% → 加碼', kind: 'XBRL', check: REV_ABOVE(0.2), action: 'RAISE', condId: 'A1' });
      const entry = await seed(c.db, { fileId: AMD_FILE, text: '營收年增高於 30%', kind: 'XBRL', check: REV_ABOVE(0.3), action: 'ENTRY', condId: 'D1' });
      const ctx = await applyCtx(c, '2026-11-20');
      await ownXbrlConditions(ctx, new Map([['AMD', rowsOf(1 / 3)]]));
      await c.db.batch(ctx.stmts);
      expect((await byId(c.db, entry)).status).toBe('MET');
      expect((await byId(c.db, exit)).status).toBe('ACTIVE');
      expect((await byId(c.db, add)).status).toBe('ACTIVE');
      expect(ctx.acct.watch!.AMD.entry!.map((e) => e.id)).toEqual([entry]);
      // 轉成持股（自己先買）：下一次每日流程沒有新財報也抓 XBRL、補比一次
      const a = structuredClone(ctx.acct);
      a.lots.own.AMD = 20;
      expect(promoteWatch(a, c.view, 'AMD', 'SELF', { shares: 20 })).toBe(true);
      await saveAccount(c.db, a, (await loadAccount(c.db))!, '測試', new Date('2026-11-21T00:00:00Z'));
      const check = { ticker: 'AMD', cik: '0000002488', names: [], sic: null, all: [], fresh: [], latest: '' };
      const facts = await ownFacts(c.env, c.fetcher, [check], new Set(['AMD']), '2026-11-23', [], new Set(['AMD']));
      expect(facts.has('AMD')).toBe(true);
      expect((await ownFacts(c.env, c.fetcher, [check], new Set(['AMD']), '2026-11-23', [])).has('AMD')).toBe(false);
      const ctx2 = await applyCtx(c, '2026-11-23');
      await ownXbrlConditions(ctx2, new Map([['AMD', rowsOf(1 / 3)]]));
      await c.db.batch(ctx2.stmts);
      expect((await byId(c.db, exit)).status).toBe('MET');
      expect((await byId(c.db, add)).status).toBe('MET');
      expect(ctx2.acct.own.AMD.entered!.xbrlAt).toBe('2026-11-23');
      expect(ctx2.acct.own.AMD.condReviewDue).toBe('2026-11-23');
      expect(ctx2.log.join('\n')).toContain('從候補進場之後第一次每日流程：補比一次財報類條件');
    });
  });

  it('條件確認（F25）套用：候補只認進場條件；同一個條件編號的出場條件不會被標成立', async () => {
    await withWorld(async (c) => {
      expect((await c.api('POST', 'ops/watch-add', { ticker: 'AMD' })).status).toBe(200);
      const exit = await seed(c.db, { fileId: AMD_FILE, text: '公司在 8-K 宣布裁員', check: EV(['8-K']), action: 'REVIEW', condId: 'U1' });
      const entry = await seed(c.db, { fileId: AMD_FILE, text: '公司在 8-K 宣布新的大客戶', check: EV(['8-K']), action: 'ENTRY', condId: 'U1' });
      const s = { valid: true, verdict: 'MET', payload: { condition_id: 'U1' }, evidence: [] };
      const outcome = { status: 'AGREED', verdict: 'MET', votes: { MET: 3 }, actionable: true, followRule: false, reason: '', samples: [s, s, s] } as unknown as Outcome;
      const ctx = await applyCtx(c, '2026-11-20');
      await applyOwnCondition(ctx, { runId: 'f25-w', fn: OWN_CONDITION, ticker: 'AMD', asOf: '2026-11-20', outcome, pack: { documents: [], rule: { detail: { conditions: ['U1'], ids: { U1: entry }, mode: 'FILING' } } } } as unknown as Parameters<typeof applyOwnCondition>[1]);
      await c.db.batch(ctx.stmts);
      expect((await byId(c.db, entry))).toMatchObject({ status: 'MET', metBasis: 'FILING_VOTE' });
      expect((await byId(c.db, exit)).status).toBe('ACTIVE');
      expect(ctx.acct.watch!.AMD.entry!.map((e) => e.id)).toEqual([entry]);
    });
  });
});

// ---------------------------------------------------------------- 5. 非價格進場條件的確認

describe('T85 丙 ⑤：新申報 → F25；月底檢查點有新證據才開 own_condition_v2', () => {
  it('watchNewEvidence（純函式）：上次確認之後的新 8-K／10-Q／10-K；指名網頁的滿 25 天；都沒有 → 不開', () => {
    const cond = (by: string[]) => ({ check: EV(by), acceptedAt: '2026-11-19T12:00:00Z', createdAt: '2026-11-19T12:00:00Z' });
    const f = (form: string, filingDate: string) => ({ form, filingDate });
    expect(watchNewEvidence([cond(['earnings_call'])], [f('8-K', '2026-11-10')], null, null, '2026-11-19', '2026-11-27').reasons).toEqual([]);
    expect(watchNewEvidence([cond(['earnings_call'])], [f('8-K', '2026-11-24'), f('4', '2026-11-25')], null, null, '2026-11-19', '2026-11-27')).toMatchObject({ reasons: ['FILING'], filings: [{ form: '8-K' }] });
    // 上一次條件確認之後才算新的
    expect(watchNewEvidence([cond(['earnings_call'])], [f('8-K', '2026-11-24')], '2026-11-25', null, '2026-11-19', '2026-11-27').reasons).toEqual([]);
    // 指名網頁：距條件定下（沒有上一次月底檢查）不到 25 天不開；滿 25 天開
    expect(watchNewEvidence([cond(['web:trendforce.com'])], [], null, null, '2026-11-19', '2026-11-27').reasons).toEqual([]);
    expect(watchNewEvidence([cond(['web:trendforce.com'])], null, null, null, '2026-11-19', '2026-12-30').reasons).toEqual(['WEB']);
    expect(watchNewEvidence([cond(['web:trendforce.com'])], [], null, '2026-12-20', '2026-11-19', '2026-12-30').reasons).toEqual([]);
  });

  it('startWatchRuns：新申報對上確認來源 → F25（只讀申報、不能取文件）；月底檢查點沒有新證據不開、有新的 8-K 就開 MONTH_END（可以取文件）', async () => {
    await withWorld(async (c) => {
      expect((await c.api('POST', 'ops/watch-add', { ticker: 'AMD' })).status).toBe(200);
      await mutate(c.db, (a) => void (a.watch!.AMD.premises = [{ id: 'P4', text: '自己的前提', origin: 'USER' }]));
      await seed(c.db, { fileId: AMD_FILE, text: '公司在 8-K 宣布新的大客戶', check: EV(['8-K']), action: 'ENTRY', condId: 'U1' });
      await seed(c.db, { fileId: AMD_FILE, text: 'TrendForce 報 MI 系列出貨季增', check: EV(['web:trendforce.com']), action: 'ENTRY', status: 'REVIEW_ONLY', condId: 'U2' });
      // 出場條件（候補期間不確認）
      await seed(c.db, { fileId: AMD_FILE, text: '公司在 8-K 宣布裁員', check: EV(['8-K']), action: 'REVIEW', condId: 'X1' });
      const k8 = { accession: '0000002488-26-000400', form: '8-K', items: ['8.01'], acceptedAt: '2026-11-24T21:00:00Z', filingDate: '2026-11-24', primaryDocument: 'k.htm' };
      const check = { ticker: 'AMD', cik: '0000002488', names: [], sic: null, all: [k8], fresh: [k8], latest: k8.acceptedAt };
      // 不是月底檢查點：新申報 → F25
      const sc = await startCtx(c, '2026-11-24', new Date('2026-11-24T23:30:00Z'), [check]);
      await startWatchRuns(sc);
      expect(sc.res.started).toHaveLength(1);
      const f25 = (await getRun(c.db, sc.res.started[0]))!;
      expect(f25.fn).toBe(OWN_CONDITION);
      expect(f25.pack.prompt_version).toBe('own_condition_v2');
      expect((f25.pack.rule.detail as Record<string, unknown>).mode).toBe('FILING');
      expect((f25.pack.rule.detail as Record<string, unknown>).conditions).toEqual(['U1']);
      expect(f25.pack.facts.find((x) => x.id === 'E1')!.label).toContain('進場條件（成立時：候補進場，先買一半）');
      const ctxRow = await c.db.prepare('SELECT doc_ctx FROM ai_runs WHERE run_id = ?').bind(f25.runId).first<{ doc_ctx: string }>();
      expect(JSON.parse(ctxRow!.doc_ctx).off).toContain('只讀申報原文');
      // 月底檢查點（11-27 的下一個交易日是月底最後一天）：上次確認（11-24 那一次）之後沒有新申報、指名網頁不到 25 天 → 不開
      const noNews = await startCtx(c, '2026-11-27', new Date('2026-11-27T23:30:00Z'), [{ ...check, fresh: [] }]);
      await startWatchRuns(noNews);
      expect(noNews.res.started).toEqual([]);
      expect(noNews.res.log.join('\n')).toContain('月底檢查點，上次條件確認之後沒有新的申報、指名的網頁距上次不到 25 天，不開條件確認');
      // 有一份新的 8-K（11-26）→ 開 MONTH_END
      const k8b = { ...k8, accession: '0000002488-26-000401', acceptedAt: '2026-11-26T21:00:00Z', filingDate: '2026-11-26' };
      const news = await startCtx(c, '2026-11-27', new Date('2026-11-27T23:40:00Z'), [{ ...check, all: [k8b, k8], fresh: [] }]);
      await startWatchRuns(news);
      expect(news.res.started).toHaveLength(1);
      const m = (await getRun(c.db, news.res.started[0]))!;
      expect((m.pack.rule.detail as Record<string, unknown>).mode).toBe('MONTH_END');
      expect((m.pack.rule.detail as Record<string, unknown>).named).toEqual({ U2: ['trendforce.com'] });
      expect(m.pack.question).toContain('月底檢查');
      expect(m.pack.documents.some((d) => d.source_id === `edgar:${k8b.accession}`)).toBe(true);
      const mRow = await c.db.prepare('SELECT doc_ctx FROM ai_runs WHERE run_id = ?').bind(m.runId).first<{ doc_ctx: string }>();
      expect(JSON.parse(mRow!.doc_ctx).off ?? null).toBeNull();
      // 只有這兩種：沒有審查、掃描、硬事件、新眼光
      expect((await c.db.prepare("SELECT DISTINCT fn FROM ai_runs WHERE ticker = 'AMD'").all<{ fn: string }>()).results.map((r) => r.fn)).toEqual([OWN_CONDITION]);
    });
  });

  it('月底檢查的結論照 condCite：指名的網站而且是產業研究機構 → WEB_VOTE；沒指名、或只當線索的 → 不算成立', () => {
    const web = (domain: string, tier: string): PackDoc => ({ id: 'A1', source_id: `web:${domain}/a`, kind: 'web', date: '2026-11-25', title: 't', text: 'x', url: `https://${domain}/a`, ...({ domain, tier } as object) }) as PackDoc;
    const vote = (src: string) => ({ valid: true, verdict: 'MET', payload: { condition_id: 'U2' }, evidence: [{ id: 'E1', ok: true, source_id: src }] });
    const out = (src: string) => ({ status: 'AGREED', verdict: 'MET', votes: { MET: 3 }, actionable: true, followRule: false, reason: '', samples: [vote(src), vote(src), vote(src)] }) as unknown as Outcome;
    const pack = (d: PackDoc) => ({ documents: [d], rule: { action: '', detail: { mode: 'MONTH_END', ids: { U2: 9 }, named: { U2: ['trendforce.com'] } } } }) as never;
    expect(conditionDecision(out('web:trendforce.com/a'), pack(web('trendforce.com', 'NAMED')))).toMatchObject({ condId: 'U2', basis: 'WEB_VOTE', rowId: 9 });
    expect(conditionDecision(out('web:other.com/a'), pack(web('other.com', 'NAMED'))).condId).toBeNull();
    expect(conditionDecision(out('web:trendforce.com/a'), pack(web('trendforce.com', 'LEAD'))).condId).toBeNull();
    // 申報原文 → FILING_VOTE
    expect(conditionDecision(out('edgar:x'), pack(DOC))).toMatchObject({ condId: 'U2', basis: 'FILING_VOTE' });
  });
});

// ---------------------------------------------------------------- 6. 編輯論點頁的進場條件

describe('T85 丙 ⑥：編輯論點頁的「進場條件」（改寫、確認、另算 3 條）', () => {
  it('只有預設前提的候補擋下；持股不收；超過 3 條擋下；有前提的候補送去改寫（U 寫進場條件），確認後是 ENTRY、方向 UP、不占 8 條', async () => {
    await withWorld(async (c) => {
      expect((await c.api('POST', 'ops/watch-add', { ticker: 'AMD' })).status).toBe(200);
      const base = { ticker: 'AMD', thesis: '想買 AMD', exitConditions: [], source: 'TYPED' };
      const r0 = await c.api<{ error: string }>('POST', 'ops/own-thesis', { ...base, premises: [], entryConditions: ['下一季營收年增轉正'] });
      expect(r0.status).toBe(422);
      expect(r0.body.error).toContain('只有系統預設前提的候補只能有價格條件');
      expect((await c.api<{ error: string }>('POST', 'ops/own-thesis', { ...base, ticker: 'NVDA', premises: [{ id: 'P1', text: '資料中心需求延續到 2027' }], entryConditions: ['x'] })).body.error).toContain('已經是持股，沒有進場條件');
      expect((await c.api<{ error: string }>('POST', 'ops/own-thesis', { ...base, premises: [{ text: 'GPU 營收成長' }], entryConditions: ['a', 'b', 'c', 'd'] })).body.error).toContain('進場條件最多 3 條');
      const r = await c.api<{ rewrite: { status: string; runId: string } }>('POST', 'ops/own-thesis', { ...base, premises: [{ text: 'GPU 營收成長' }], entryConditions: ['下一季營收年增轉正', '公司在 8-K 宣布大客戶訂單'] });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.rewrite.status).toBe('SENT');
      const run = (await getRun(c.db, r.body.rewrite.runId))!;
      expect(run.pack.facts.filter((f) => f.id.startsWith('U')).map((f) => f.label)).toEqual(['使用者要的進場條件（整組取代目前監測中的；成立時：候補進場（先買一半））', '使用者要的進場條件（整組取代目前監測中的；成立時：候補進場（先買一半））']);
      expect(run.pack.question).toContain('與 2 條進場條件');
      // AI 改寫回來：一條財報門檻、一條寫成價格（擋下）
      const price = run.pack.documents.find((d) => d.source_id === 'price:AMD')!;
      const task = await c.db.prepare('SELECT * FROM ai_tasks WHERE id = ?').bind(run.taskId).first();
      const evidence = [{ id: 'E1', source_id: 'price:AMD', date: price.date, quote: price.text.split('\n').at(-1)!, claim: '最新收盤' }];
      await finalizeRun(c.db, task as never, { samples: [{ run_id: run.runId, verdict: 'DONE', evidence, payload: { conditions: [
        { id: 'C1', line: 'U1', direction: 'UP', kind: 'XBRL', text: '下一季營收年增高於 0%', check: REV_ABOVE(0), basis: ['E1'] },
        { id: 'C2', line: 'U2', direction: 'UP', kind: 'PRICE', text: '跌到 $100', check: { type: 'price_below', level: 100 }, basis: ['E1'] },
      ] }, report: '改寫好了。' }] }, new Date('2026-11-20T02:10:00Z'));
      const hd = (await c.api<HoldingDetail & { rewrites: { results: { conditions: { condId: string; action: string; blocked: string | null }[] }[] } }>('GET', 'holding/AMD')).body;
      const rw = hd.rewrites.results[0];
      expect(rw.conditions.map((x) => [x.condId, x.action, !!x.blocked])).toEqual([['U1', 'ENTRY', false], ['U2', 'ENTRY', true]]);
      const acc = await c.api<{ added: number }>('POST', 'ops/own-conditions', { ticker: 'AMD', runId: run.runId, ids: ['U1', 'U2'] });
      expect(acc.status, JSON.stringify(acc.body)).toBe(200);
      expect(acc.body.added).toBe(1);
      const acct = await acctOf(c.db);
      expect((await entryConditions(c.db, acct, 'AMD')).map((x) => [x.text, x.action, x.direction, x.origin, x.status])).toEqual([['下一季營收年增高於 0%', 'ENTRY', 'UP', 'USER', 'ACTIVE']]);
      expect(await fileConditions(c.db, acct, 'AMD')).toEqual([]);
      // 之後存論點沒送進場條件（例如貼回討論）→ 進場條件不動
      const r2 = await c.api<{ rewrite: { status: string } }>('POST', 'ops/own-thesis', { ...base, premises: [{ text: 'GPU 營收成長' }, { text: '營收年增為正' }] });
      expect(r2.body.rewrite.status).toBe('NONE');
      expect((await entryConditions(c.db, acct, 'AMD')).filter((x) => x.status === 'ACTIVE')).toHaveLength(1);
    });
  });

  it('改寫結果（純函式）：進場條件方向 UP；寫成價格的擋下', () => {
    const s = { valid: true, verdict: 'DONE', conditions: [{ from: 'payload.conditions', auto: true, raw: { line: 'U1', kind: 'PRICE', text: '跌到 $100', check: {} } }], report: '' };
    const r = ownCheckResult({ samples: [s] } as unknown as Outcome, 'AMD', [{ text: '跌到 100 就買', action: 'ENTRY' }]);
    expect(r.conditions[0]).toMatchObject({ action: 'ENTRY', direction: 'UP', manual: true });
    expect(r.conditions[0].blocked).toContain('進場的價格條件在候補那一塊自己填數字');
  });
});

// ---------------------------------------------------------------- 7. 一年的提醒、討論包、/admin/own/list

describe('T85 丙 ⑦：一年沒進場的「要看的事」；討論包與 /admin/own/list 帶候補', () => {
  it('watchAttention：滿 365 天才列、每年一次；進場條件都用掉時換一句；草稿好了也列', async () => {
    await withWorld(async (c) => {
      expect((await c.api('POST', 'ops/watch-add', { ticker: 'AMD' })).status).toBe(200);
      const acct = await acctOf(c.db);
      const tf = (await thesisFile(c.db, acct, 'AMD', '2026-11-19'))!;
      expect(watchAttention([tf], acct, { date: '2027-11-18' })).toEqual([]);
      const hit = watchAttention([tf], acct, { date: '2027-11-19' });
      expect(WATCH_STALE_DAYS).toBe(365);
      expect(hit).toEqual([{ ticker: 'AMD', kind: 'WATCH_STALE', src: 'watch', key: 'WATCH_STALE', every: 12, since: '2027-11-19', text: 'AMD 在候補名單一年了，目前沒有進場條件。要重新定，還是移除？' }]);
      await seed(c.db, { fileId: AMD_FILE, text: '公司在 8-K 宣布新的大客戶', check: EV(['8-K']), action: 'ENTRY' });
      const tf2 = (await thesisFile(c.db, acct, 'AMD', '2027-12-01'))!;
      expect(watchAttention([tf2], acct, { date: '2027-12-01' })[0].text).toBe('AMD 在候補名單一年了，進場條件還沒成立。要留著、改條件，還是移除？');
      // 月報：列一次，記在 watch[t].attnShown；下個月不再列
      const vw = { ...c.view, date: '2027-12-01' };
      const m1 = await monthOwnAttention(c.db, acct, vw);
      expect(m1.items.filter((x) => x.ticker === 'AMD')).toEqual([expect.objectContaining({ kind: 'WATCH_STALE', src: 'watch' })]);
      expect(m1.acct.watch!.AMD.attnShown).toEqual({ WATCH_STALE: '2027-12-01' });
      const m2 = await monthOwnAttention(c.db, m1.acct, { ...c.view, date: '2028-01-03' });
      expect(m2.items.filter((x) => x.ticker === 'AMD')).toEqual([]);
      // 候補的持股頁「要看的事」：只有候補自己的那兩種
      const hd = (await c.api<HoldingDetail & { attention: unknown[] }>('GET', 'holding/AMD')).body;
      expect(hd.attention).toEqual([]);
    });
  });

  it('討論包：開場是「還沒持有，放在候補」、列進場條件（不收進收尾區塊）、數字寫打算放的比重；貼回的區塊不收進場條件；/admin/own/list 標 watch', async () => {
    await withWorld(async (c) => {
      expect((await c.api('POST', 'ops/watch-add', { ticker: 'AMD', note: 'AI 晶片的第二供應商', stdWeight: 0.04 })).status).toBe(200);
      expect((await c.api('POST', 'ops/watch-price', { ticker: 'AMD', conds: [{ type: 'drawdown', value: 25 }] })).status).toBe(200);
      const d = await c.api<{ text: string; mode: string }>('GET', 'own/AMD/discussion');
      expect(d.status).toBe(200);
      expect(d.body.mode).toBe('NEW');
      expect(d.body.text).toContain('這檔我還沒持有：2026-11-19 放進候補名單');
      expect(d.body.text).toContain('## 我想買它的原因');
      expect(d.body.text).toContain('## 進場條件（在 stock bot 的網站改，不要寫進收尾區塊）');
      expect(d.body.text).toContain('- 比 52 週高點低 25% 以上（我填的價格條件，程式每天比收盤）');
      expect(d.body.text).toContain('打算放的比重：4.0%');
      expect(d.body.text).not.toContain('慢規則狀態');
      // 持股的討論包沒有這幾節
      const n = await c.api<{ text: string }>('GET', 'own/NVDA/discussion');
      expect(n.body.text).not.toContain('## 進場條件');
      // 貼回：寫了進場條件的那一行不算進去
      const p = parseThesisBlock('===STOCKBOT 論點 v3 AMD===\n論點：\n想買\n前提：\n1. GPU 營收成長\n出場條件：\n1. 營收年增連兩季為負 → 減半\n2. 跌到 100 → 候補進場\n這次的結論：維持\n理由：x\n===END===', 'AMD');
      expect(p.exits.map((x) => x.text)).toEqual(['營收年增連兩季為負']);
      expect(p.notes.join('\n')).toContain('收尾區塊不收進場條件');
      // /admin/own/list
      const r = await handle(new Request('https://bot.example/admin/own/list', { headers: { Authorization: 'Bearer t' } }), c.env, c.fetcher, new Date('2026-11-20T02:00:00Z'));
      const list = (await r.json()) as { own: { ticker: string; watch?: boolean; pendingBreak: number | null }[] };
      expect(list.own.map((x) => [x.ticker, !!x.watch])).toEqual([['NVDA', false], ['AMD', true]]);
    });
  });
});

// 防止沒用到的 import（型別用）
void SYSTEM_DEFAULT_PREMISES;
void cronTime;
