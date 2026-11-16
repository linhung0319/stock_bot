// T42：出場條件整組取代、由改寫的 AI 對照；前提沿用編號但字改了時靜默期結束（own_thesis §1.7、§1.8、§1.10，2026-11-16 使用者同意改）。
// 完成條件：
//   1. 討論包與貼回：v3 討論包沒有 C 編號；v2 區塊帶 [C12] 照收但只看文字
//   2. 編輯論點頁：出場條件沒改不送改寫、只改動作直接改；改了字或少一條 → 整組送改寫、確認前舊的仍是監測中
//   3、4. 改寫的 AI 與持股頁確認：same 不新增、supersedes 確認後舊的撤下、沒被提到的確認後撤下、沒確認時都不撤
//   5. 跟著論點版本走：新一版出場條件改動後，舊版的改寫結果與「還沒送去改寫」不列、勾選與重送被擋
//   6. 前提的靜默期：沿用編號字改了的前提靜默期結束、只改標點的不結束
// 對外請求全部是假的：價格、成分股（固定檔）、EDGAR、Nasdaq RSS、雲端排程、LINE。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DISCUSSION_V3, discussionPack, parseThesisBlock, type DiscussionNumbers } from '../src/ai/discussion';
import { OWN_CHECK_PROMPT, ownCheckResult } from '../src/ai/ownCheck';
import { finalizeRun, getRun } from '../src/app/aiRuns';
import type { Env, Fetcher } from '../src/app/env';
import { runFlow } from '../src/app/flow';
import { LINE_PUSH_URL } from '../src/app/line';
import { loadAccount, saveAccount } from '../src/app/ledgerStore';
import { loadConditions, metaFile, type FileCondition } from '../src/app/thesis';
import type { CompanyFacts, XbrlFact } from '../src/data/edgar';
import { buildMarketView } from '../src/data/marketView';
import { loadSeries } from '../src/data/store';
import { EDITED_REASON, createAccount, silenced, type Account, type MarketView } from '../src/engine';
import { handle } from '../src/index';
import { freshDb } from './helpers/d1';
import { cronTime, fakeFetcher, newWorld, type World } from './helpers/fakeSources';

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- 假的世界（和 T40 的測試同一套寫法）

function quarterFacts(qs: { end: string; rev: number; filed: string }[]): CompanyFacts {
  const rev: XbrlFact[] = qs.map((q) => {
    const [y, m] = q.end.split('-').map(Number);
    return { start: `${y}-${String(m - 2).padStart(2, '0')}-01`, end: q.end, val: q.rev, accn: `acc-${q.filed}`, form: '10-Q', filed: q.filed };
  });
  return { cik: 1045810, facts: { 'us-gaap': { Revenues: { units: { USD: rev } } } } };
}
const BASE = quarterFacts([
  { end: '2025-06-30', rev: 110, filed: '2025-08-01' },
  { end: '2025-09-30', rev: 120, filed: '2025-11-01' },
  { end: '2026-06-30', rev: 150, filed: '2026-08-01' },
  { end: '2026-09-30', rev: 160, filed: '2026-10-30' },
]);
const TENQ = `<html><body><p>Item 2. Management’s Discussion and Analysis</p><p>Revenue for the third quarter was $160 million. Gross margin was 60.0%, down from 70.0% a year ago.</p><p>Item 3. Quantitative</p></body></html>`;
const TENQ_FILING = { accession: '0001045810-26-000300', form: '10-Q', items: '', acceptanceDateTime: '2026-10-30T20:10:00.000Z', filingDate: '2026-10-30', primaryDocument: 'q.htm', html: TENQ };

function fetcherOf(w: World): Fetcher {
  const base = fakeFetcher(w);
  return async (url, init) => {
    if (url === LINE_PUSH_URL) return Response.json({});
    if (url === 'https://api.example/fire') return Response.json({ claude_code_session_url: 'https://claude.ai/code/x' });
    if (/data\.sec\.gov\/submissions\/CIK\d+\.json/.test(url)) {
      const f = TENQ_FILING;
      return Response.json({ cik: '1045810', name: 'NVIDIA CORP', tickers: ['NVDA'], filings: { recent: { accessionNumber: [f.accession], form: [f.form], items: [f.items], acceptanceDateTime: [f.acceptanceDateTime], filingDate: [f.filingDate], primaryDocument: [f.primaryDocument] } } });
    }
    if (/companyfacts\/CIK\d+\.json/.test(url)) return Response.json(BASE);
    const doc = /Archives\/edgar\/data\/\d+\/(\d+)\/(.+)$/.exec(url);
    if (doc) return doc[2] === 'index.json' ? Response.json({ directory: { item: [{ name: TENQ_FILING.primaryDocument }] } }) : new Response(TENQ_FILING.html);
    if (url.startsWith('https://www.nasdaq.com/feed/rssoutbound')) return new Response('<rss><channel></channel></rss>');
    return base(url, init);
  };
}

interface Ctx {
  db: D1Database;
  env: Env;
  viewAt: (date: string) => Promise<{ view: MarketView; axis: string[] }>;
  api: <T = Record<string, unknown>>(method: 'GET' | 'POST', path: string, body?: unknown, now?: Date) => Promise<{ status: number; body: T }>;
}

const USER_PREMISES = [
  { id: 'P1', text: '資料中心需求延續到 2027', origin: 'USER' as const },
  { id: 'P2', text: '毛利率維持在 65% 以上', origin: 'USER' as const },
];

async function withWorld(fn: (c: Ctx) => Promise<void>, opt: { acct?: (a: Account) => Account } = {}) {
  const d = await freshDb();
  try {
    const db = d.db;
    const w = newWorld('2026-11-19');
    const env: Env = { DB: db, ADMIN_TOKEN: 't', AI_TASK_SECRET: 's', EDGAR_USER_AGENT: 'test bot test@example.com', SITE_URL: 'https://bot.example', LINE_CHANNEL_TOKEN: 'lt', LINE_USER_ID: 'U1', DEV_NO_AUTH: '1', ROUTINE_FIRE_URL: 'https://api.example/fire', ROUTINE_TOKEN: 'rt' };
    const fetcher = fetcherOf(w);
    const viewAt = async (date: string) => buildMarketView(await loadSeries(db, ['VOO', 'SGOV', 'NVDA']), date, 'VOO');
    const api: Ctx['api'] = async (method, path, body, now = new Date('2026-11-20T02:00:00Z')) => {
      const r = await handle(new Request(`https://bot.example/api/${path}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env, fetcher, now);
      return { status: r.status, body: (await r.json()) as never };
    };
    w.dataDate = '2026-11-19';
    await runFlow(env, fetcher, { now: cronTime('2026-11-19'), attempt: 'FIRST' });
    const { view } = await viewAt('2026-11-19');
    let acct = createAccount(
      {
        paper: true,
        cash: 5000,
        core: { VOO: Math.floor(140_000 / view.close.VOO[view.i]) },
        own: { NVDA: { shares: Math.floor(40_000 / view.close.NVDA[view.i]), stdWeight: 0.15, premises: USER_PREMISES } },
      },
      view,
    );
    if (opt.acct) acct = opt.acct(acct);
    await saveAccount(db, acct, null, '建立帳戶', new Date('2026-11-19T12:00:00Z'));
    await fn({ db, env, viewAt, api });
  } finally {
    await d.dispose();
  }
}

const FILE = 'NVDA@2026-11-19';
const GM = (level: number, quarters = 1) => ({ type: 'xbrl_metric_below', metric: 'GrossMarginPct', level, quarters });
const EV = { type: 'event', confirm_by: ['8-K'] };

interface CondSeed { text: string; kind?: string; check?: Record<string, unknown>; status?: string; action: string }
async function seed(db: D1Database, o: CondSeed): Promise<number> {
  const r = await db
    .prepare('INSERT INTO own_conditions (ticker, run_id, cond_id, direction, kind, text, check_json, tier_if_met, status, created_at, origin, file_id, accepted_at, action, auto) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind('NVDA', 'r0', 'U1', 'DOWN', o.kind ?? 'XBRL', o.text, JSON.stringify(o.check ?? GM(0.58, 2)), o.action === 'REVIEW' ? null : o.action, o.status ?? 'ACTIVE', '2026-11-19T12:00:00.000Z', 'USER', FILE, '2026-11-19T12:00:00.000Z', o.action, 1)
    .run();
  return r.meta.last_row_id;
}
const statusOf = async (db: D1Database) => Object.fromEntries((await loadConditions(db, 'NVDA')).map((c) => [c.id, c.status]));
const byText = async (db: D1Database, text: string) => (await loadConditions(db, 'NVDA')).filter((c) => c.text === text);
const ownCheckRuns = async (db: D1Database) => (await db.prepare("SELECT run_id FROM ai_runs WHERE fn = 'OWN_CHECK' ORDER BY created_at").all<{ run_id: string }>()).results.map((r) => r.run_id);
const logsOf = async (db: D1Database, kind: string) => (await db.prepare('SELECT body FROM own_thesis_log WHERE kind = ? ORDER BY id').bind(kind).all<{ body: string }>()).results.map((r) => JSON.parse(r.body) as Record<string, unknown>);

const PREMS = USER_PREMISES.map((p) => ({ id: p.id, text: p.text }));
const save = (c: Ctx, exitConditions: { text: string; action: string }[], extra: Record<string, unknown> = {}, now?: Date) =>
  c.api<{ rewrite: { status: string; runId?: string; error?: string }; exits: { text: string }[]; conds: { actionChanged: number[]; errors: string[] }; preview: { version: number; exits: { changed: boolean; live: number; actionChanged: unknown[]; pendingVersion: number | null } } }>('POST', 'ops/own-thesis', { ticker: 'NVDA', thesis: '論點', premises: PREMS, exitConditions, source: 'DISCUSSION', ...extra }, now);

/** 改寫回來（一票）：conditions 是 payload.conditions（每一條帶 line、same 或 supersedes）。 */
async function answer(c: Ctx, runId: string, conditions: Record<string, unknown>[], at = new Date('2026-11-20T02:10:00Z')) {
  const run = (await getRun(c.db, runId))!;
  const price = run.pack.documents.find((d) => d.source_id === 'price:NVDA')!;
  const task = await c.db.prepare('SELECT * FROM ai_tasks WHERE id = ?').bind(run.taskId).first();
  const evidence = [{ id: 'E1', source_id: 'price:NVDA', date: price.date, quote: price.text.split('\n').at(-1)!, claim: '最新收盤' }];
  await finalizeRun(c.db, task as never, { samples: [{ run_id: runId, verdict: 'DONE', evidence, payload: { conditions: conditions.map((x) => ({ direction: 'DOWN', basis: ['E1'], ...x })) }, report: '對照與改寫好了。' }] }, at);
}

type RwView = {
  results: { runId: string; status: string; failed: boolean; exitsVersion: number | null; conditions: { condId: string; text: string; same: number | null; supersedes: number | null; action: string }[]; sames: Record<string, { text: string; actionTo: string | null }>; replaces: Record<string, string>; retire: { id: number; text: string }[]; unmatched: { text: string }[] }[];
  unsent: { exits: { text: string }[]; version: number } | null;
  dropAll: { version: number; retire: { id: number; text: string }[] } | null;
};
const rewrites = async (c: Ctx, now = new Date('2026-11-20T03:00:00Z')) => (await c.api<{ rewrites: RwView }>('GET', 'holding/NVDA', undefined, now)).body.rewrites;

const NUMS: DiscussionNumbers = { date: '2026-11-19', close: 181.23, fromHigh: -0.12, ma200: 160.5, vsMa: 0.129, slow: 'STD', ret1y: 0.42, weight: 0.062, stdWeight: 0.05, ownTotal: 0.23, ownBudget: 0.2, xbrl: null, openedHalf: null };

// ---------------------------------------------------------------- 1. 討論包與貼回

describe('T42 ①：討論包與貼回（own_thesis §1.7、§1.8）', () => {
  it('v3 討論包：出場條件沒有 C 編號；固定指示要收尾時寫全部的出場條件（沒改的照抄、沒寫的確認後撤下）；區塊標記 v3', async () => {
    await withWorld(async (c) => {
      const id = await seed(c.db, { text: '毛利率連兩季低於 58%', action: 'EXIT' });
      const t = (await c.api<{ text: string }>('GET', 'own/NVDA/discussion')).body.text;
      expect(t).toContain('# NVDA 論點討論包（stock bot，2026-11-19，discussion_v3）');
      expect(t).toContain('你定的（目前監測中；收尾時要留的照抄進區塊，沒寫進去的會在我確認後撤下）：');
      expect(t).toContain('- 毛利率連兩季低於 58% → 出清（11/19 定；監測中）');
      expect(t).not.toMatch(/\bC\d+[.\]]/);
      expect(t).not.toContain(`C${id}`);
      expect(t).toContain('出場條件不用編號：收尾區塊的「出場條件」要寫討論完我要的全部出場條件，沒改的也照抄原文；沒寫進去的，會在我確認之後撤下。');
      expect(t).toContain('===STOCKBOT 論點 v3 NVDA===');
      expect(t).not.toContain('[C12]');
      // 前提照舊帶編號
      expect(t).toContain('P2. 毛利率維持在 65% 以上');
      expect(DISCUSSION_V3).toContain('1. [P2] （沒改的前提：照抄原文，保留編號）');
    });
    // 已成立的另列、不帶編號
    const f = metaFile({ own: { NVDA: { premises: USER_PREMISES, thesis: null, fileId: FILE, origin: 'NEW', flags: [] } as never } }, 'NVDA', '2026-11-19')!;
    const met = { id: 5, ticker: 'NVDA', runId: 'r', condId: 'U1', direction: 'DOWN', kind: 'XBRL', text: '營收年增轉負', check: GM(0), tierIfMet: 'HALF', status: 'MET', createdAt: '2026-10-01T00:00:00Z', metAt: '2026-11-01T00:00:00Z', note: null, origin: 'USER', fileId: FILE, acceptedAt: '2026-10-01T00:00:00Z', action: 'HALF', premiseId: null, supersedes: null, metBasis: 'XBRL', verifiedAt: null, progress: null, auto: true } as FileCondition;
    const t = discussionPack({ ...f, conditions: [met] }, NUMS, 'ROUTINE');
    expect(t).toContain('已成立（一次性，不再監測；要再監測就寫成新的一條）：\n營收年增轉負（2026-11-01 成立）');
  });

  it('解析：v2 區塊帶 [C12] 照收但只看文字（沒有條件編號）；v3 區塊照常；前提的 [P2] 照讀', () => {
    const v2 = ['===STOCKBOT 論點 v2 NVDA===', '論點：', 'x', '前提：', '1. [P2] 毛利率維持在 65% 以上', '出場條件：', '1. [C12] 毛利率連兩季低於 60% → 出清', '2. ［C7］公司在 8-K 下修全年財測 → 減半', '===END==='].join('\n');
    const p = parseThesisBlock(v2, 'NVDA');
    expect(p.found).toBe(true);
    expect(p.premiseIds).toEqual(['P2']);
    expect(p.exits).toEqual([
      { text: '毛利率連兩季低於 60%', action: 'EXIT', guessed: false },
      { text: '公司在 8-K 下修全年財測', action: 'HALF', guessed: false },
    ]);
    expect(p.exits.every((x) => !('ref' in x))).toBe(true);
    const v3 = parseThesisBlock(['===STOCKBOT 論點 v3 NVDA===', '論點：', 'x', '出場條件：', '1. 毛利率連兩季低於 60% → 減半', '===END==='].join('\n'), 'NVDA');
    expect(v3).toMatchObject({ found: true, error: null, exits: [{ text: '毛利率連兩季低於 60%', action: 'HALF' }] });
  });

  it('網站：解析 v2 區塊之後送存檔，帶 ref 也不會被當成沿用（伺服器不收 ref，整組比對文字）', async () => {
    await withWorld(async (c) => {
      const gm = await seed(c.db, { text: '毛利率連兩季低於 70%', action: 'EXIT' });
      // T41 第 3 條的情境：保留 [C] 編號但門檻改了 → 以前會被當成沿用、新字丟掉
      const s = await save(c, [{ text: '毛利率連兩季低於 65%', action: 'EXIT', ref: gm } as never]);
      expect(s.body.preview.exits.changed).toBe(true);
      expect(s.body.rewrite.status).toBe('SENT');
      const run = (await getRun(c.db, s.body.rewrite.runId!))!;
      expect(run.pack.facts.find((f) => f.id === 'U1')!.value).toBe('毛利率連兩季低於 65%');
      expect(run.pack.facts.find((f) => f.id === 'C1')!.value).toBe('毛利率連兩季低於 70%');
    });
  });
});

// ---------------------------------------------------------------- 2. 編輯論點頁：沒改不送、改了整組送

describe('T42 ②：出場條件沒改不送改寫、有改動整組送（own_thesis §1.8）', () => {
  it('沒改（預填的監測中條件原樣送回，只差空白標點）→ 不送改寫、條件不動；只改動作 → 直接改動作', async () => {
    await withWorld(async (c) => {
      const a = await seed(c.db, { text: '毛利率連兩季低於 58%', action: 'EXIT' });
      const b = await seed(c.db, { text: '公司在 8-K 下修全年財測', kind: 'EVENT', check: EV, action: 'HALF' });
      const same = [
        { text: '毛利率連兩季低於 58%。', action: 'EXIT' },
        { text: '公司在 8-K 下修全年財測', action: 'HALF' },
      ];
      const s1 = await save(c, same);
      expect(s1.body.preview.exits).toEqual({ changed: false, live: 2, actionChanged: [], pendingVersion: null });
      expect(s1.body.rewrite.status).toBe('NONE');
      expect(await ownCheckRuns(c.db)).toEqual([]);
      expect(await statusOf(c.db)).toEqual({ [a]: 'ACTIVE', [b]: 'ACTIVE' });
      const s2 = await save(c, [same[0], { ...same[1], action: 'EXIT' }]);
      expect(s2.body.preview.exits.actionChanged).toEqual([{ id: b, text: '公司在 8-K 下修全年財測', action: 'EXIT', was: 'HALF' }]);
      expect(s2.body.rewrite.status).toBe('NONE');
      expect(s2.body.conds.actionChanged).toEqual([b]);
      expect((await loadConditions(c.db, 'NVDA')).find((x) => x.id === b)!.action).toBe('EXIT');
      expect(await ownCheckRuns(c.db)).toEqual([]);
      // 純手寫、只改論點文字：沒有監測中的條件、右邊也沒寫 → 沒改動
      expect((await logsOf(c.db, 'THESIS')).every((l) => l.exitsChanged === false)).toBe(true);
    });
  });

  it('改了一條的字 → 整組（含沒改的）連同監測中的條件送改寫；log 記這一版的全部出場條件；確認之前舊的仍是監測中', async () => {
    await withWorld(async (c) => {
      const a = await seed(c.db, { text: '毛利率連兩季低於 58%', action: 'EXIT' });
      const b = await seed(c.db, { text: '公司在 8-K 下修全年財測', kind: 'EVENT', check: EV, action: 'HALF' });
      const s = await save(c, [
        { text: '毛利率連兩季低於 55%', action: 'EXIT' },
        { text: '公司在 8-K 下修全年財測', action: 'HALF' },
      ]);
      expect(s.body.preview.exits).toMatchObject({ changed: true, live: 2 });
      expect(s.body.rewrite.status).toBe('SENT');
      expect(s.body.exits.map((x) => x.text)).toEqual(['毛利率連兩季低於 55%', '公司在 8-K 下修全年財測']);
      const run = (await getRun(c.db, s.body.rewrite.runId!))!;
      expect(run.pack.prompt_version).toBe(OWN_CHECK_PROMPT);
      expect(OWN_CHECK_PROMPT).toBe('own_check_v4');
      expect(run.pack.facts.filter((f) => f.id.startsWith('U')).map((f) => f.value)).toEqual(['毛利率連兩季低於 55%', '公司在 8-K 下修全年財測']);
      expect(run.pack.facts.filter((f) => /^C\d/.test(f.id)).map((f) => f.value)).toEqual(['毛利率連兩季低於 58%', '公司在 8-K 下修全年財測']);
      expect(run.pack.question).toContain('same');
      expect(run.pack.rule.detail).toMatchObject({ exitsVersion: 1, live: [a, b], sameByText: { U2: b }, condMap: { C1: a, C2: b } });
      expect((await logsOf(c.db, 'THESIS')).at(-1)).toMatchObject({ version: 1, exitsChanged: true, exitLines: ['毛利率連兩季低於 55%', '公司在 8-K 下修全年財測'], exitActions: ['EXIT', 'HALF'], exitsLive: [a, b], exitSame: { U2: b } });
      expect(await statusOf(c.db)).toEqual({ [a]: 'ACTIVE', [b]: 'ACTIVE' });
      // 改寫中：持股頁寫「正在改寫」，舊的照舊
      const rw = await rewrites(c, new Date('2026-11-20T02:05:00Z'));
      expect(rw.results.map((x) => [x.status, x.exitsVersion])).toEqual([['PENDING', 1]]);
    });
  });

  it('少一條 → 也是有改動、整組送改寫；確認之前兩條都還在監測', async () => {
    await withWorld(async (c) => {
      const a = await seed(c.db, { text: '毛利率連兩季低於 58%', action: 'EXIT' });
      const b = await seed(c.db, { text: '公司在 8-K 下修全年財測', kind: 'EVENT', check: EV, action: 'HALF' });
      const s = await save(c, [{ text: '毛利率連兩季低於 58%', action: 'EXIT' }]);
      expect(s.body.preview.exits).toMatchObject({ changed: true, live: 2 });
      expect(s.body.rewrite.status).toBe('SENT');
      expect(await statusOf(c.db)).toEqual({ [a]: 'ACTIVE', [b]: 'ACTIVE' });
    });
  });
});

// ---------------------------------------------------------------- 3、4. 改寫的 AI 對照、持股頁確認

describe('T42 ③④：same、supersedes、沒被提到的；確認才生效（own_thesis §1.8）', () => {
  it('same 不新增、supersedes 確認後舊的撤下、沒被提到的確認後撤下；確認之前、沒確認時都不撤', async () => {
    await withWorld(async (c) => {
      const a = await seed(c.db, { text: '毛利率連兩季低於 58%', action: 'EXIT' });
      const b = await seed(c.db, { text: '營收年增率連兩季是負的', action: 'HALF' });
      const d = await seed(c.db, { text: '公司在 8-K 下修全年財測', kind: 'EVENT', check: EV, action: 'HALF' });
      const s = await save(c, [
        { text: '毛利率連續兩季低於 58%', action: 'EXIT' }, // 寫法不同、同一件事 → AI 標 same
        { text: '營收年增率連三季是負的', action: 'HALF' }, // 更新 → supersedes
        { text: '執行長離職', action: 'REVIEW' }, // 新的
      ]);
      const runId = s.body.rewrite.runId!;
      await answer(c, runId, [
        { id: 'C1', line: 'U1', same: 'C1', kind: 'XBRL', text: '毛利率連兩季低於 58%', check: GM(0.58, 2), tier_if_met: 'EXIT' },
        { id: 'C2', line: 'U2', supersedes: 'C2', kind: 'XBRL', text: '營收年增率連三季是負的', check: { type: 'xbrl_metric_below', metric: 'RevenueYoY', level: 0, quarters: 3 }, tier_if_met: 'HALF' },
        { id: 'C3', line: 'U3', kind: 'EVENT', text: '公司在 8-K 宣布執行長離職', check: EV },
      ]);
      const rw = await rewrites(c);
      expect(rw.results).toHaveLength(1);
      const r = rw.results[0];
      expect(r.conditions.map((x) => [x.condId, x.same, x.supersedes])).toEqual([
        ['U1', a, null],
        ['U2', null, b],
        ['U3', null, null],
      ]);
      expect(r.sames).toEqual({ U1: { text: '毛利率連兩季低於 58%', actionTo: null } });
      expect(r.replaces).toEqual({ U2: '營收年增率連兩季是負的' });
      expect(r.retire).toEqual([{ id: d, text: '公司在 8-K 下修全年財測' }]);
      expect(r.unmatched).toEqual([]);
      // 確認之前：全部照舊監測
      expect(await statusOf(c.db)).toEqual({ [a]: 'ACTIVE', [b]: 'ACTIVE', [d]: 'ACTIVE' });
      // 確認（勾 U2、U3；U1 是 same 沒有勾選框）
      const acc = await c.api<{ added: number; retired: number[]; actionChanged: number[] }>('POST', 'ops/own-conditions', { ticker: 'NVDA', runId, ids: ['U1', 'U2', 'U3'] }, new Date('2026-11-20T03:05:00Z'));
      expect(acc.status).toBe(200);
      expect(acc.body).toEqual({ ok: true, added: 2, retired: [b, d], actionChanged: [] });
      const conds = await loadConditions(c.db, 'NVDA');
      expect(conds.find((x) => x.id === a)!.status).toBe('ACTIVE'); // same：舊的保留
      expect(await byText(c.db, '毛利率連兩季低於 58%')).toHaveLength(1); // 不新增
      expect(conds.find((x) => x.id === b)).toMatchObject({ status: 'RETIRED' });
      expect(conds.find((x) => x.id === b)!.note).toContain('取代');
      expect(conds.find((x) => x.id === d)).toMatchObject({ status: 'RETIRED', note: '你在 2026-11-19 確認第 1 版論點的出場條件時撤下（這次的出場條件沒有提到）' });
      expect((await byText(c.db, '營收年增率連三季是負的'))[0]).toMatchObject({ status: 'ACTIVE', origin: 'USER', supersedes: b });
      expect((await byText(c.db, '公司在 8-K 宣布執行長離職'))[0]).toMatchObject({ status: 'ACTIVE', origin: 'USER', action: 'REVIEW' });
      // log：每一條 CONDITION、沒提到的寫原因；一筆 EXITS_CONFIRMED
      const cl = await logsOf(c.db, 'CONDITION');
      expect(cl.filter((l) => l.change === 'RETIRED').map((l) => [l.id, l.reason ?? null])).toEqual([
        [b, null],
        [d, 'NOT_IN_EXITS'],
      ]);
      expect(await logsOf(c.db, 'EXITS_CONFIRMED')).toMatchObject([{ runId, version: 1, retired: [b, d] }]);
      // 確認之後這一版不再列；再確認一次被擋
      expect((await rewrites(c)).results).toEqual([]);
      expect((await c.api('POST', 'ops/own-conditions', { ticker: 'NVDA', runId, ids: ['U3'] })).status).toBe(409);
    });
  });

  it('沒勾取代它的新條件：被取代的那一條照舊監測（只撤下沒被提到的）', async () => {
    await withWorld(async (c) => {
      const b = await seed(c.db, { text: '營收年增率連兩季是負的', action: 'HALF' });
      const s = await save(c, [{ text: '營收年增率連三季是負的', action: 'HALF' }]);
      await answer(c, s.body.rewrite.runId!, [{ id: 'C1', line: 'U1', supersedes: 'C1', kind: 'XBRL', text: '營收年增率連三季是負的', check: { type: 'xbrl_metric_below', metric: 'RevenueYoY', level: 0, quarters: 3 }, tier_if_met: 'HALF' }]);
      // 什麼都不勾、也沒有要撤下的 → 沒有東西可以確認
      const r0 = await c.api<{ error: string }>('POST', 'ops/own-conditions', { ticker: 'NVDA', runId: s.body.rewrite.runId, ids: [] });
      expect(r0.status).toBe(422);
      expect(r0.body.error).toBe('至少勾一條');
      expect((await loadConditions(c.db, 'NVDA')).find((x) => x.id === b)!.status).toBe('ACTIVE');
    });
  });

  it('AI 沒標 same：文字和監測中的一條相同的當成 same（程式的後備）；動作不同的確認時改動作；AI 沒改寫出來的列出來', async () => {
    await withWorld(async (c) => {
      const a = await seed(c.db, { text: '毛利率連兩季低於 58%', action: 'EXIT' });
      const b = await seed(c.db, { text: '公司在 8-K 下修全年財測', kind: 'EVENT', check: EV, action: 'HALF' });
      const s = await save(c, [
        { text: '毛利率連兩季低於 58%', action: 'HALF' },
        { text: '公司在 8-K 下修全年財測', action: 'HALF' },
        { text: '基本面轉差', action: 'EXIT' },
      ]);
      await answer(c, s.body.rewrite.runId!, [
        { id: 'C1', line: 'U1', kind: 'XBRL', text: '毛利率連兩季低於 58%', check: GM(0.58, 2), tier_if_met: 'HALF' },
        { id: 'C2', line: 'U2', kind: 'EVENT', text: '公司在 8-K 下修全年財測', check: EV, tier_if_met: 'HALF' },
      ]);
      const r = (await rewrites(c)).results[0];
      expect(r.conditions.map((x) => x.same)).toEqual([a, b]);
      expect(r.sames).toEqual({ U1: { text: '毛利率連兩季低於 58%', actionTo: 'HALF' }, U2: { text: '公司在 8-K 下修全年財測', actionTo: null } });
      expect(r.retire).toEqual([]);
      expect(r.unmatched.map((x) => x.text)).toEqual(['基本面轉差']);
      const acc = await c.api<{ added: number; retired: number[]; actionChanged: number[] }>('POST', 'ops/own-conditions', { ticker: 'NVDA', runId: r.runId, ids: [] });
      expect(acc.body).toMatchObject({ added: 0, retired: [], actionChanged: [a] });
      expect((await loadConditions(c.db, 'NVDA')).find((x) => x.id === a)).toMatchObject({ status: 'ACTIVE', action: 'HALF' });
      expect((await loadConditions(c.db, 'NVDA')).length).toBe(2);
    });
  });

  it('全部都是 same、沒有要撤下或改動作的 → 不列、不用確認', async () => {
    await withWorld(async (c) => {
      const a = await seed(c.db, { text: '毛利率連兩季低於 58%', action: 'EXIT' });
      const s = await save(c, [{ text: '毛利率連續兩季低於百分之五十八', action: 'EXIT' }]);
      await answer(c, s.body.rewrite.runId!, [{ id: 'C1', line: 'U1', same: 'C1', kind: 'XBRL', text: '毛利率連兩季低於 58%', check: GM(0.58, 2), tier_if_met: 'EXIT' }]);
      expect((await rewrites(c)).results).toEqual([]);
      expect(await statusOf(c.db)).toEqual({ [a]: 'ACTIVE' });
    });
  });

  it('沒確認：30 天後這份結果不再列，舊的仍照舊監測（不自動撤下）', async () => {
    await withWorld(async (c) => {
      const a = await seed(c.db, { text: '毛利率連兩季低於 58%', action: 'EXIT' });
      const s = await save(c, [{ text: '執行長離職', action: 'REVIEW' }]);
      await answer(c, s.body.rewrite.runId!, [{ id: 'C1', line: 'U1', kind: 'EVENT', text: '公司在 8-K 宣布執行長離職', check: EV }]);
      expect((await rewrites(c)).results[0].retire).toEqual([{ id: a, text: '毛利率連兩季低於 58%' }]);
      expect((await rewrites(c, new Date('2026-12-25T00:00:00Z'))).results).toEqual([]);
      expect(await statusOf(c.db)).toEqual({ [a]: 'ACTIVE' });
    });
  });

  it('全部拿掉：不送 AI；持股頁列「確認後會撤下」，確認前照舊監測；版本不對的確認被擋', async () => {
    await withWorld(async (c) => {
      const a = await seed(c.db, { text: '毛利率連兩季低於 58%', action: 'EXIT' });
      const b = await seed(c.db, { text: '公司在 8-K 下修全年財測', kind: 'EVENT', check: EV, action: 'HALF' });
      const s = await save(c, []);
      expect(s.body.preview.exits).toMatchObject({ changed: true, live: 2 });
      expect(s.body.rewrite.status).toBe('NONE');
      expect(await ownCheckRuns(c.db)).toEqual([]);
      const rw = await rewrites(c);
      expect(rw.dropAll).toEqual({ at: expect.any(String), version: 1, retire: [{ id: a, text: '毛利率連兩季低於 58%' }, { id: b, text: '公司在 8-K 下修全年財測' }] });
      expect(rw.unsent).toBeNull();
      expect(await statusOf(c.db)).toEqual({ [a]: 'ACTIVE', [b]: 'ACTIVE' });
      expect((await c.api('POST', 'ops/own-exits-retire', { ticker: 'NVDA', version: 9 })).status).toBe(409);
      const r = await c.api<{ retired: number[] }>('POST', 'ops/own-exits-retire', { ticker: 'NVDA', version: 1 });
      expect(r.body.retired).toEqual([a, b]);
      expect(await statusOf(c.db)).toEqual({ [a]: 'RETIRED', [b]: 'RETIRED' });
      expect((await rewrites(c)).dropAll).toBeNull();
    });
  });
});

// ---------------------------------------------------------------- 5. 跟著論點版本走

describe('T42 ⑤：改寫結果與「還沒送去改寫」跟著論點版本走（own_thesis §1.8）', () => {
  it('只改論點文字的版本不影響；新一版出場條件改動後，舊版的改寫結果不列，勾選與重送被擋', async () => {
    await withWorld(async (c) => {
      const a = await seed(c.db, { text: '毛利率連兩季低於 58%', action: 'EXIT' });
      // 第 1 版：改了出場條件
      const s1 = await save(c, [{ text: '毛利率連兩季低於 55%', action: 'EXIT' }], {}, new Date('2026-11-20T02:00:00Z'));
      const run1 = s1.body.rewrite.runId!;
      await answer(c, run1, [{ id: 'C1', line: 'U1', supersedes: 'C1', kind: 'XBRL', text: '毛利率連兩季低於 55%', check: GM(0.55, 2), tier_if_met: 'EXIT' }]);
      // 第 2 版：只改論點文字（出場條件預填監測中的，沒動）→ 第 1 版的結果照列
      const s2 = await save(c, [{ text: '毛利率連兩季低於 58%', action: 'EXIT' }], { thesis: '論點第二版' }, new Date('2026-11-20T02:20:00Z'));
      expect(s2.body.preview.exits).toMatchObject({ changed: false });
      expect((await rewrites(c)).results.map((x) => [x.runId, x.exitsVersion])).toEqual([[run1, 1]]);
      // 第 3 版：出場條件又改了 → 預覽提醒第 1 版還沒確認；存檔後第 1 版不再列
      const dry = await save(c, [{ text: '毛利率連兩季低於 50%', action: 'EXIT' }], { dry: true }, new Date('2026-11-20T02:30:00Z'));
      expect(dry.body.preview.exits).toMatchObject({ changed: true, pendingVersion: 1 });
      const s3 = await save(c, [{ text: '毛利率連兩季低於 50%', action: 'EXIT' }], {}, new Date('2026-11-20T02:30:00Z'));
      expect(s3.body.preview.version).toBe(3);
      const run3 = s3.body.rewrite.runId!;
      const rw = await rewrites(c, new Date('2026-11-20T02:40:00Z'));
      expect(rw.results.map((x) => [x.runId, x.exitsVersion])).toEqual([[run3, 3]]);
      // 第 1 版的結果：勾選被擋（伺服器），重送被擋
      const acc = await c.api<{ error: string }>('POST', 'ops/own-conditions', { ticker: 'NVDA', runId: run1, ids: ['U1'] }, new Date('2026-11-20T02:45:00Z'));
      expect(acc.status).toBe(409);
      expect(acc.body.error).toContain('之前版本');
      const re = await c.api<{ error: string }>('POST', 'ops/own-check', { ticker: 'NVDA', exits: [{ text: '毛利率連兩季低於 55%', action: 'EXIT' }], version: 1 }, new Date('2026-11-20T02:45:00Z'));
      expect(re.status).toBe(409);
      expect(re.body.error).toContain('第 1 版');
      expect(await statusOf(c.db)).toEqual({ [a]: 'ACTIVE' });
      expect(await byText(c.db, '毛利率連兩季低於 55%')).toEqual([]);
    });
  });

  it('「還沒送去改寫」只列最新一版：舊版送不出去的，新一版出場條件改動後不再列、不能重送；最新一版重送送的是存下來的那一組', async () => {
    await withWorld(async (c) => {
      await seed(c.db, { text: '毛利率連兩季低於 58%', action: 'EXIT' });
      const fire = c.env.ROUTINE_FIRE_URL;
      c.env.ROUTINE_FIRE_URL = undefined;
      const s1 = await save(c, [{ text: '公司在 8-K 下修全年財測', action: 'HALF' }], {}, new Date('2026-11-20T02:00:00Z'));
      expect(s1.body.rewrite.status).toBe('FAILED');
      expect((await rewrites(c)).unsent).toMatchObject({ version: 1, exits: [{ text: '公司在 8-K 下修全年財測' }] });
      // 第 2 版改了出場條件（也送不出去）→ 只列第 2 版的
      await save(c, [{ text: '執行長離職', action: 'REVIEW' }], {}, new Date('2026-11-20T02:10:00Z'));
      expect((await rewrites(c)).unsent).toMatchObject({ version: 2, exits: [{ text: '執行長離職' }] });
      c.env.ROUTINE_FIRE_URL = fire;
      // 重送第 1 版 → 擋下；重送第 2 版 → 送的是第 2 版存下來的那一組（不是網頁送來的字）
      expect((await c.api('POST', 'ops/own-check', { ticker: 'NVDA', exits: [{ text: '公司在 8-K 下修全年財測', action: 'HALF' }], version: 1 })).status).toBe(409);
      const re = await c.api<{ runId: string }>('POST', 'ops/own-check', { ticker: 'NVDA', exits: [{ text: '別的字', action: 'EXIT' }], version: 2 }, new Date('2026-11-20T02:20:00Z'));
      expect(re.status).toBe(200);
      const run = (await getRun(c.db, re.body.runId))!;
      expect(run.pack.facts.filter((f) => f.id.startsWith('U')).map((f) => f.value)).toEqual(['執行長離職']);
      expect(run.pack.rule.detail).toMatchObject({ exitsVersion: 2 });
      const rw = await rewrites(c, new Date('2026-11-20T02:25:00Z'));
      expect(rw.unsent).toBeNull();
      expect(rw.results.map((x) => x.runId)).toEqual([re.body.runId]);
    });
  });

  it('ownCheckResult：same 只認證據包的 C、而且是存檔時監測中的；supersedes 和 same 不會同時有', () => {
    const outcome = { status: 'AGREED', verdict: 'DONE', votes: { DONE: 1 }, reason: null, samples: [{ valid: true, verdict: 'DONE', conditions: [
      { from: 'payload.conditions', auto: true, raw: { line: 'U1', same: 'C1', supersedes: 'C1', kind: 'XBRL', text: 'x', check: GM(0.5) } },
      { from: 'payload.conditions', auto: true, raw: { line: 'U2', same: 'W1', kind: 'XBRL', text: 'y', check: GM(0.5) } },
      { from: 'payload.conditions', auto: true, raw: { line: 'U3', same: 'C2', kind: 'XBRL', text: 'z', check: GM(0.5) } },
    ], report: 'r' }] } as never;
    const r = ownCheckResult(outcome, 'NVDA', [{ text: 'x', action: 'EXIT' }, { text: 'y', action: 'HALF' }, { text: 'z', action: 'REVIEW' }], { C1: 11, C2: 12, W1: 21 }, {}, [11]);
    expect(r.conditions.map((c) => [c.same, c.supersedes, c.line])).toEqual([
      [11, null, 0],
      [null, null, 1],
      [null, null, 2],
    ]);
  });
});

// ---------------------------------------------------------------- 6. 前提的靜默期

describe('T42 ⑥：沿用編號但字改了的前提，靜默期結束（own_thesis §1.10）', () => {
  const disputed = (a: Account) => {
    a.own.NVDA.disputes = [{ premiseId: 'P2', since: '2026-11-10', until: '2027-02-18', reason: '不同意：毛利率只是短期', notif: null }];
    return a;
  };

  it('字改了 → 這條前提的靜默期結束（記結束日與原因），持股頁不再寫靜默中；審查判不成立會照常通知', async () => {
    await withWorld(
      async (c) => {
        const body = { premises: [{ id: 'P1', text: '資料中心需求延續到 2027' }, { id: 'P2', text: '毛利率維持在 60% 以上' }] };
        const dry = await c.api<{ preview: { edited: unknown[]; silenceEnded: string[] } }>('POST', 'ops/own-thesis', { ticker: 'NVDA', thesis: '論點', exitConditions: [], source: 'DISCUSSION', dry: true, ...body });
        expect(dry.body.preview.silenceEnded).toEqual(['P2']);
        expect((await loadAccount(c.db))!.acct.own.NVDA.disputes![0].until).toBe('2027-02-18'); // 預覽不存
        const r = await c.api('POST', 'ops/own-thesis', { ticker: 'NVDA', thesis: '論點', exitConditions: [], source: 'DISCUSSION', ...body });
        expect(r.status).toBe(200);
        const acct = (await loadAccount(c.db))!.acct;
        expect(acct.own.NVDA.disputes).toEqual([{ premiseId: 'P2', since: '2026-11-10', until: '2026-11-18', reason: '不同意：毛利率只是短期', notif: null, ended: { date: '2026-11-19', reason: EDITED_REASON } }]);
        expect(EDITED_REASON).toBe('前提的字改了');
        expect(silenced(acct, 'NVDA', 'P2', '2026-11-19', 'HALF')).toBe(false);
        expect((await logsOf(c.db, 'THESIS')).at(-1)).toMatchObject({ silenceEnded: ['P2'] });
        const h = await c.api<{ thesis: { silenced: unknown[] } }>('GET', 'holding/NVDA');
        expect(h.body.thesis.silenced).toEqual([]);
      },
      { acct: disputed },
    );
  });

  it('只改標點或空白 → 靜默期不結束', async () => {
    await withWorld(
      async (c) => {
        const r = await c.api<{ preview: { silenceEnded: string[] } }>('POST', 'ops/own-thesis', { ticker: 'NVDA', thesis: '論點', exitConditions: [], source: 'DISCUSSION', premises: [{ id: 'P1', text: '資料中心需求延續到 2027' }, { id: 'P2', text: '毛利率 維持在 65% 以上。' }] });
        expect(r.body.preview.silenceEnded).toEqual([]);
        const acct = (await loadAccount(c.db))!.acct;
        expect(acct.own.NVDA.disputes).toEqual([{ premiseId: 'P2', since: '2026-11-10', until: '2027-02-18', reason: '不同意：毛利率只是短期', notif: null }]);
        expect(silenced(acct, 'NVDA', 'P2', '2026-11-19', 'HALF')).toBe(true);
      },
      { acct: disputed },
    );
  });
});

// ---------------------------------------------------------------- prompt 升版

describe('T42：prompt 升版（共用規則第 7 點）', () => {
  it('own_check_v4.md 存在、寫 same 與 supersedes；v3 開頭標「不再使用」', () => {
    const dir = join(HERE, '..', '..', 'ai', 'prompts');
    const v4 = readFileSync(join(dir, 'own_check_v4.md'), 'utf8');
    expect(v4).toContain('"same": "C2"');
    expect(v4).toContain('supersedes');
    expect(v4).toContain('沒有被任何一條標到的 `C`，使用者確認後會撤下');
    expect(readFileSync(join(dir, 'own_check_v3.md'), 'utf8').split('\n')[0]).toContain('不再使用');
  });
});
