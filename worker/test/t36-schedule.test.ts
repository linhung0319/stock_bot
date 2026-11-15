// T36：三次排程（UTC 23:30、01:30、03:30）、Worker 與雲端排程的溝通修補（own_thesis_design_2026-11-15 §2.7；thesis_plan T23 的三點）。
//   ① 03:30 只套用回來的結論、推播、標記逾時：不呼叫任何資料來源、不開新的執行
//   ② 01:30 套用掃描的結果之後接著開硬事件法庭（不等到隔天）
//   ③ 逾時已經標記之後才送到的結果：留 LATE 紀錄、不套用
//   ④ 逾時的兩種原因：沒有來取證據包、取了沒有送回
// 全部用假資料：假的 EDGAR、假的雲端排程、假的 LINE（repo 是公開的）。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeStaleRuns, getRun, listRuns, startRun } from '../src/app/aiRuns';
import { TASK_TIMEOUT_MS, sweepTimeoutTasks, timeoutAlert, timeoutReason } from '../src/app/aiTasks';
import type { Env, Fetcher } from '../src/app/env';
import { loadEvents } from '../src/app/filings';
import { getFlowState, runFlow } from '../src/app/flow';
import { LINE_PUSH_URL } from '../src/app/line';
import { loadAccount, saveAccount } from '../src/app/ledgerStore';
import { CRONS, SCHEDULE, attemptOfCron, type Attempt } from '../src/app/schedule';
import { buildPack } from '../src/ai/pack';
import type { EvidencePack } from '../src/ai/check';
import { buildMarketView } from '../src/data/marketView';
import { loadConstituents, loadSeries } from '../src/data/store';
import { createAccount } from '../src/engine';
import worker, { APPLY_CRON, FINAL_CRON, INGEST_CRON, handle } from '../src/index';
import { freshDb } from './helpers/d1';
import { fakeFetcher, newWorld, type World } from './helpers/fakeSources';

// ---------------------------------------------------------------- 假的 EDGAR、雲端排程、LINE

interface FakeFiling {
  accession: string;
  form: string;
  items: string;
  acceptanceDateTime: string;
  filingDate: string;
  primaryDocument: string;
  html: string;
}
interface Net {
  cos: Map<number, { name: string; filings: FakeFiling[] }>;
  /** 每一個對外請求的網址（依順序）。 */
  calls: string[];
  fired: string[];
  line: string[];
}

function fetcherOf(w: World, net: Net): Fetcher {
  const base = fakeFetcher(w);
  const findFiling = (acc: string) => [...net.cos.values()].flatMap((c) => c.filings).find((f) => f.accession.replace(/-/g, '') === acc);
  return async (url, init) => {
    net.calls.push(url);
    if (url === LINE_PUSH_URL) {
      net.line.push((JSON.parse(String(init?.body)) as { messages: { text: string }[] }).messages[0].text);
      return Response.json({});
    }
    if (url === 'https://api.example/fire') {
      net.fired.push(String(init?.body));
      return Response.json({ claude_code_session_url: 'https://claude.ai/code/x' });
    }
    const sub = /data\.sec\.gov\/submissions\/CIK(\d+)\.json/.exec(url);
    if (sub) {
      const co = net.cos.get(Number(sub[1])) ?? { name: 'SOME CORP', filings: [] };
      const fs = [...co.filings].reverse();
      return Response.json({ cik: sub[1], name: co.name, tickers: [], sic: '3674', formerNames: [], filings: { recent: { accessionNumber: fs.map((f) => f.accession), form: fs.map((f) => f.form), items: fs.map((f) => f.items), acceptanceDateTime: fs.map((f) => f.acceptanceDateTime), filingDate: fs.map((f) => f.filingDate), primaryDocument: fs.map((f) => f.primaryDocument) } } });
    }
    if (/companyfacts\/CIK\d+\.json/.test(url)) {
      const q = (start: string, end: string, val: number, filed: string) => ({ start, end, val, filed, form: '10-Q', accn: `a-${filed}` });
      return Response.json({ cik: 1, facts: { 'us-gaap': { Revenues: { units: { USD: [q('2026-01-01', '2026-03-31', 1000, '2026-04-30'), q('2026-04-01', '2026-06-30', 1100, '2026-07-30'), q('2026-07-01', '2026-09-30', 1200, '2026-10-30')] } } } } });
    }
    if (/companyconcept\//.test(url)) return new Response('nf', { status: 404 });
    const doc = /Archives\/edgar\/data\/\d+\/(\d+)\/(.+)$/.exec(url);
    if (doc) {
      const f = findFiling(doc[1]);
      if (!f) return new Response('nf', { status: 404 });
      if (doc[2] === 'index.json') return Response.json({ directory: { item: [{ name: f.primaryDocument }] } });
      return new Response(f.html);
    }
    if (/nasdaq\.com\/feed\/rssoutbound/.test(url)) return new Response('<rss><channel></channel></rss>');
    return base(url, init);
  };
}

/** 各排程的時間：23:30 收盤後、兩小時後 01:30、再兩小時後 03:30（UTC）。 */
const slotTime = (date: string, attempt: Attempt) => new Date(Date.parse(date + 'T23:30:00Z') + ({ FIRST: 0, MANUAL: 0, FINAL: 2, APPLY: 4 }[attempt]) * 3600_000);

interface Ctx {
  db: D1Database;
  env: Env;
  net: Net;
  cik: (t: string) => number;
  run: (date: string, attempt?: Attempt) => ReturnType<typeof runFlow>;
}

async function withWorld(fn: (c: Ctx) => Promise<void>) {
  const d = await freshDb();
  try {
    const db = d.db;
    const w = newWorld('2026-11-19');
    const net: Net = { cos: new Map(), calls: [], fired: [], line: [] };
    const env: Env = { DB: db, ADMIN_TOKEN: 't', AI_TASK_SECRET: 's', EDGAR_USER_AGENT: 'test bot test@example.com', SITE_URL: 'https://bot.example', LINE_CHANNEL_TOKEN: 'lt', LINE_USER_ID: 'U1', ROUTINE_FIRE_URL: 'https://api.example/fire', ROUTINE_TOKEN: 'rt' };
    const fetcher = fetcherOf(w, net);
    const run = (date: string, attempt: Attempt = 'FIRST') => {
      w.dataDate = date;
      return runFlow(env, fetcher, { now: slotTime(date, attempt), attempt });
    };
    await run('2026-11-19');
    const members = (await loadConstituents(db))!;
    const cik = (t: string) => Number(members.holdings.find((h) => h[0] === t)![2]);
    const { view } = buildMarketView(await loadSeries(db, ['VOO', 'SGOV', 'NVDA']), '2026-11-19', 'VOO');
    const acct = createAccount(
      {
        paper: true,
        cash: 5000,
        core: { VOO: Math.floor(140_000 / view.close.VOO[view.i]) },
        own: { NVDA: { shares: Math.floor(40_000 / view.close.NVDA[view.i]), stdWeight: 0.15, premises: [{ id: 'P1', text: '資料中心需求延續到 2027', origin: 'USER' }] } },
      },
      view,
    );
    await saveAccount(db, acct, null, '建立帳戶', new Date('2026-11-19T12:00:00Z'));
    await fn({ db, env, net, cik, run });
  } finally {
    await d.dispose();
  }
}

const addFiling = (net: Net, cik: number, f: FakeFiling) => {
  const co = net.cos.get(cik) ?? { name: 'NVIDIA CORP', filings: [] };
  co.filings.push(f);
  net.cos.set(cik, co);
};

const runsOf = async (db: D1Database, fn: string) => (await listRuns(db, new Date('2026-11-01T00:00:00Z'), { limit: 500 })).filter((r) => r.fn === fn);
const postResult = (env: Env, taskId: string, body: unknown, at: Date) => handle(new Request(`https://bot.example/ai/task/${taskId}/result`, { method: 'POST', headers: { Authorization: 'Bearer s' }, body: JSON.stringify(body) }), env, async () => new Response('no net', { status: 599 }), at);

const ACC = '0001045810-26-000500';
const SUBPOENA = '<html><body><p>Item 8.01 Other Events.</p><p>On November 23, 2026, the Company received a subpoena from the U.S. Department of Justice requesting documents related to its export practices in China.</p></body></html>';
const QUOTE = 'received a subpoena from the U.S. Department of Justice requesting documents';

/**
 * 11-20 第一次看申報（只記下最新的一筆）→ 11-23 NVDA 申報一份 8-K 8.01（規則分不出輕重，交給每日掃描）
 * → 23:30 開每日掃描 → 00:10 掃描回來：標成監管候選。回傳那份掃描。
 */
async function scanFlagsHardCandidate({ db, env, net, cik, run }: Ctx) {
  addFiling(net, cik('NVDA'), { accession: '0001045810-26-000300', form: '10-Q', items: '', acceptanceDateTime: '2026-10-30T20:10:00.000Z', filingDate: '2026-10-30', primaryDocument: 'q.htm', html: '<p>10-Q</p>' });
  await run('2026-11-20');
  addFiling(net, cik('NVDA'), { accession: ACC, form: '8-K', items: '8.01', acceptanceDateTime: '2026-11-23T21:05:00.000Z', filingDate: '2026-11-23', primaryDocument: 'nvda-801.htm', html: SUBPOENA });
  await run('2026-11-23');
  expect(await runsOf(db, 'HARD_EVENT')).toEqual([]); // 規則段沒有命中，23:30 不開法庭
  const [scan] = await runsOf(db, 'EVENT_SCAN');
  expect(scan.pack.documents.map((x) => x.source_id)).toEqual([`edgar:${ACC}`]);
  const flag = { run_id: scan.pack.run_id, verdict: 'FLAGGED', evidence: [{ id: 'E1', source_id: `edgar:${ACC}`, date: '2026-11-23', quote: QUOTE, claim: '司法部傳票' }], payload: { events: [{ ticker: 'NVDA', class: 'REGULATORY_CANDIDATE', source_id: `edgar:${ACC}` }] } };
  const r = await postResult(env, scan.taskId!, { task_id: scan.taskId, kind: 'RUN', run_id: scan.runId, samples: [flag] }, new Date('2026-11-24T00:10:00Z'));
  expect(r.status).toBe(200);
  return scan;
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------- 排程表

describe('三次排程集中在 schedule.ts', () => {
  it('cron 對到哪一次；03:30 不抓資料、不開執行，只套用、推播、標記逾時', () => {
    expect(CRONS).toEqual([INGEST_CRON, FINAL_CRON, APPLY_CRON]);
    expect(APPLY_CRON).toBe('30 3 * * TUE-SAT');
    expect(attemptOfCron(INGEST_CRON)).toBe('FIRST');
    expect(attemptOfCron(FINAL_CRON)).toBe('FINAL');
    expect(attemptOfCron(APPLY_CRON)).toBe('APPLY');
    expect(SCHEDULE.APPLY).toMatchObject({ daily: false, startNewDay: false, finalStarts: false, sweep: true, missedAlert: false });
    expect(SCHEDULE.FINAL).toMatchObject({ daily: true, finalStarts: true, sweep: true, missedAlert: true });
    expect(SCHEDULE.FIRST).toMatchObject({ daily: true, startNewDay: true, finalStarts: false, sweep: false });
  });

  it('Cloudflare 送來 03:30 的 cron → 走 APPLY：沒有帳戶也不會對外連線', async () => {
    const d = await freshDb();
    try {
      const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        throw new Error('03:30 不應該對外連線');
      });
      await worker.scheduled({ cron: APPLY_CRON, scheduledTime: Date.parse('2026-11-24T03:30:00Z'), noRetry() {} } as ScheduledController, { DB: d.db } as Env);
      expect(spy).not.toHaveBeenCalled();
      const row = await d.db.prepare('SELECT session, attempt, status FROM flow_runs ORDER BY id DESC LIMIT 1').first();
      expect(row).toMatchObject({ session: '2026-11-23', attempt: 'APPLY', status: 'SKIPPED' });
    } finally {
      await d.dispose();
    }
  });
});

// ---------------------------------------------------------------- ① ② 01:30 開法庭、03:30 只套用

describe('01:30 與 03:30', () => {
  it('掃描標到硬事件候選 → 同一次 01:30 就開法庭（申報原文另外抓）；23:30 的流程不會再開一次', async () => {
    await withWorld(async (c) => {
      await scanFlagsHardCandidate(c);
      c.net.calls.length = 0;
      const firedBefore = c.net.fired.length;
      const fin = await c.run('2026-11-23', 'FINAL');
      expect(fin).toMatchObject({ status: 'SKIPPED', processed: [] });
      const [court] = await runsOf(c.db, 'HARD_EVENT');
      expect(court).toMatchObject({ ticker: 'NVDA', status: 'PENDING', createdAt: '2026-11-24T01:30:00.000Z' });
      expect(court.pack.rule.detail).toMatchObject({ codes: ['REGULATORY'], role: 'OWN' });
      // 這次沒有看新申報（sc.checks 是空的）：只為有申報類事件的那一檔抓申報清單，原文進證據包
      expect(c.net.calls.filter((u) => u.includes('/submissions/')).length).toBe(1);
      expect(c.net.calls.some((u) => u.includes(`/submissions/CIK${String(c.cik('NVDA')).padStart(10, '0')}.json`))).toBe(true);
      expect(court.pack.documents.find((x) => x.source_id === `edgar:${ACC}`)!.text).toContain('received a subpoena');
      expect(c.net.fired.length).toBe(firedBefore + 1);
      expect((await loadEvents(c.db, { ticker: 'NVDA', status: 'NEW' })).length).toBe(0);
      // 隔天的流程：事件已經交給法庭，不再開
      await c.run('2026-11-24');
      expect((await runsOf(c.db, 'HARD_EVENT')).filter((r) => r.ticker === 'NVDA')).toHaveLength(1);
    });
  });

  it('03:30：不呼叫任何資料來源、不開執行，但會套用一筆完成的法庭結論並推播', async () => {
    await withWorld(async (c) => {
      await scanFlagsHardCandidate(c);
      await c.run('2026-11-23', 'FINAL');
      const [court] = await runsOf(c.db, 'HARD_EVENT');
      const doc = court.pack.documents.find((x) => x.source_id === `edgar:${ACC}`)!;
      const exit = { run_id: court.pack.run_id, verdict: 'EXIT', model: 'claude-opus-5-5', premise_checks: [{ premise_id: 'PX', status: 'BROKEN', evidence_ids: ['E1'] }], evidence: [{ id: 'E1', source_id: doc.source_id, date: doc.date, quote: QUOTE, claim: '司法部調查出口' }], payload: { reason_code: 'REGULATORY', recommend_exit: true }, report: '監管風險重大，建議出場。' };
      expect((await postResult(c.env, court.taskId!, { task_id: court.taskId, kind: 'RUN', run_id: court.runId, samples: [exit, exit, exit] }, new Date('2026-11-24T02:00:00Z'))).status).toBe(200);

      const before = await loadAccount(c.db);
      const runsBefore = (await listRuns(c.db, new Date('2026-11-24T02:00:00Z'), { limit: 500 })).length;
      const lastSession = await getFlowState(c.db, 'lastSession');
      c.net.calls.length = 0;
      c.net.line.length = 0;
      const firedBefore = c.net.fired.length;

      const r = await c.run('2026-11-23', 'APPLY');
      expect(r).toMatchObject({ session: '2026-11-23', attempt: 'APPLY', status: 'SKIPPED', processed: [] });
      // 只有 LINE：沒有價格、EDGAR、新聞、FRED，也沒有觸發雲端排程
      expect(c.net.calls.length).toBeGreaterThan(0);
      expect(c.net.calls.every((u) => u === LINE_PUSH_URL)).toBe(true);
      expect(c.net.fired.length).toBe(firedBefore);
      expect((await listRuns(c.db, new Date('2026-11-24T03:30:00Z'), { limit: 500 })).length).toBe(runsBefore);
      // 每日檢查沒有跑：處理到哪一天不變
      expect(await getFlowState(c.db, 'lastSession')).toBe(lastSession);
      // 套用了：當天通知、推播
      const acct = (await loadAccount(c.db))!;
      expect(acct.rev).toBeGreaterThan(before!.rev);
      const hard = acct.acct.notifs.find((n) => n.title === 'NVDA 硬事件（REGULATORY）')!;
      expect(r.created).toEqual([hard.id]);
      expect(hard.items[0].choices[0]).toMatchObject({ id: 'AI', tier: 'EXIT' });
      expect(c.net.line.find((t) => t.includes('NVDA 硬事件'))).toBeTruthy();
      expect((await getRun(c.db, court.runId))!.status).toBe('DONE');
      expect((await c.db.prepare('SELECT applied_at FROM ai_runs WHERE run_id = ?').bind(court.runId).first<{ applied_at: string }>())!.applied_at).toBe('2026-11-24T03:30:00.000Z');
      const row = await c.db.prepare('SELECT attempt, status FROM flow_runs ORDER BY id DESC LIMIT 1').first();
      expect(row).toMatchObject({ attempt: 'APPLY', status: 'SKIPPED' });
    });
  });

  it('03:30：今天的每日流程還沒做完 → 不套用（等下一次流程），也不推缺席告警', async () => {
    await withWorld(async (c) => {
      await scanFlagsHardCandidate(c);
      await c.run('2026-11-23', 'FINAL');
      const [court] = await runsOf(c.db, 'HARD_EVENT');
      const doc = court.pack.documents.find((x) => x.source_id === `edgar:${ACC}`)!;
      const exit = { run_id: court.pack.run_id, verdict: 'EXIT', premise_checks: [{ premise_id: 'PX', status: 'BROKEN', evidence_ids: ['E1'] }], evidence: [{ id: 'E1', source_id: doc.source_id, date: doc.date, quote: QUOTE, claim: '司法部調查出口' }], payload: { reason_code: 'REGULATORY', recommend_exit: true } };
      await postResult(c.env, court.taskId!, { task_id: court.taskId, kind: 'RUN', run_id: court.runId, samples: [exit, exit, exit] }, new Date('2026-11-24T02:00:00Z'));
      // 11-24 收盤後的流程沒有跑（排程沒跑）；11-25 03:30 的那一次訊號日是 11-24
      c.net.calls.length = 0;
      const r = await c.run('2026-11-24', 'APPLY');
      expect(r).toMatchObject({ session: '2026-11-24', status: 'SKIPPED', created: [] });
      expect(r.alerts).not.toContain('FLOW_MISSED');
      expect(c.net.calls.every((u) => u === LINE_PUSH_URL)).toBe(true);
      expect((await c.db.prepare('SELECT applied_at FROM ai_runs WHERE run_id = ?').bind(court.runId).first<{ applied_at: string | null }>())!.applied_at).toBeNull();
      const detail = JSON.parse((await c.db.prepare('SELECT detail FROM flow_runs ORDER BY id DESC LIMIT 1').first<{ detail: string }>())!.detail) as { ai: { log: string[] } };
      expect(detail.ai.log[0]).toContain('還沒做完');
      // 下一次流程補做 11-24 時照常套用
      const first = await c.run('2026-11-24');
      const acct = (await loadAccount(c.db))!.acct;
      expect(first.created).toContain(acct.notifs.find((n) => n.title === 'NVDA 硬事件（REGULATORY）')!.id);
    });
  });
});

// ---------------------------------------------------------------- ③ ④ 逾時

const T0 = new Date('2026-11-30T23:40:00Z');
const fireOk: Fetcher = async () => Response.json({ claude_code_session_url: 'https://claude.ai/code/session_x' });
const DOC = 'Gross margin was 61.2% in the third quarter, compared with 64.0% in the prior quarter.';

function pack(runId: string): EvidencePack {
  return buildPack({
    runId,
    fn: 'OWN_REVIEW',
    promptVersion: 'own_review_v1',
    asOf: '2026-11-30',
    subject: { ticker: 'ZZZ' },
    question: '前提哪些成立？',
    policy: { level: 'A3', verdicts: ['EXIT', 'HALF', 'HOLD', 'STANDARD'], abstain: 'HOLD', min_evidence: 1, samples: 3 },
    rule: { action: '規則沒有動作' },
    premises: [{ id: 'P1', text: '毛利率維持在 60% 以上', origin: 'USER' }],
    documents: [{ id: 'D1', source_id: 'edgar:0000000000-26-000001', kind: 'filing', date: '2026-10-02', title: '假的 10-Q', text: DOC }],
    now: T0,
  }).pack;
}
const vote = (runId: string) => ({ run_id: runId, verdict: 'HOLD', model: 'claude-opus-5-5', premise_checks: [{ premise_id: 'P1', status: 'HOLDS', evidence_ids: ['E1'] }], evidence: [{ id: 'E1', source_id: 'edgar:0000000000-26-000001', date: '2026-10-02', quote: 'Gross margin was 61.2% in the third quarter', claim: '毛利率仍在 60% 以上' }], payload: {}, report: '前提成立。' });

async function withDb(fn: (db: D1Database, env: Env) => Promise<void>) {
  const d = await freshDb();
  try {
    await fn(d.db, { DB: d.db, ADMIN_TOKEN: 'a', AI_TASK_SECRET: 's', ROUTINE_FIRE_URL: 'https://api.example/fire', ROUTINE_TOKEN: 'rt' });
  } finally {
    await d.dispose();
  }
}
const getEvidence = (env: Env, taskId: string, at: Date) => handle(new Request(`https://bot.example/ai/task/${taskId}/evidence`, { headers: { Authorization: 'Bearer s' } }), env, fireOk, at);

describe('逾時之後才送到的結果', () => {
  it('掃過逾時（TIMEOUT）之後才送到 → 410、ai_rejections 有 LATE 紀錄；不套用（結論維持照規則的逾時）', async () => {
    await withDb(async (db, env) => {
      const run = await startRun(env, fireOk, pack('2026-11-30_OWN_REVIEW_ZZZ_late01'), T0);
      expect((await getEvidence(env, run.taskId!, new Date(T0.getTime() + 60_000))).status).toBe(200);
      const swept = new Date(T0.getTime() + TASK_TIMEOUT_MS + 60_000);
      expect(await sweepTimeoutTasks(db, swept)).toEqual([{ id: run.taskId, fetched: true }]);
      await closeStaleRuns(db, swept);
      const body = { task_id: run.taskId, kind: 'RUN', run_id: run.runId, samples: [vote(run.runId), vote(run.runId), vote(run.runId)] };
      const res = await postResult(env, run.taskId!, body, new Date(swept.getTime() + 5 * 60_000));
      expect(res.status).toBe(410);
      expect(await res.json()).toEqual({ error: 'task_expired' });
      const rows = (await db.prepare('SELECT * FROM ai_rejections WHERE task_id = ?').bind(run.taskId).all<Record<string, unknown>>()).results;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ kind: 'RUN', status: 'LATE', http_status: 410, raw: JSON.stringify(body) });
      expect(String(rows[0].reason)).toContain('逾時已經標記之後才送到');
      // 不套用：任務還是 TIMEOUT、沒有存結果；執行的結論還是逾時照規則（沒有表決）
      const task = await db.prepare('SELECT status, result FROM ai_tasks WHERE id = ?').bind(run.taskId).first();
      expect(task).toMatchObject({ status: 'TIMEOUT', result: null });
      const r = (await getRun(db, run.runId))!;
      expect(r.outcome).toMatchObject({ status: 'TIMEOUT', followRule: true, samples: [] });
      // 其他已結束的狀態照舊回 409、不留紀錄
      const run2 = await startRun(env, fireOk, pack('2026-11-30_OWN_REVIEW_ZZZ_late02'), T0);
      expect((await postResult(env, run2.taskId!, { task_id: run2.taskId, kind: 'RUN', run_id: run2.runId, samples: [vote(run2.runId)] }, new Date(T0.getTime() + 60_000))).status).toBe(200);
      expect((await postResult(env, run2.taskId!, { task_id: run2.taskId, kind: 'RUN', run_id: run2.runId, samples: [vote(run2.runId)] }, new Date(T0.getTime() + 120_000))).status).toBe(409);
      expect((await db.prepare('SELECT COUNT(*) AS n FROM ai_rejections WHERE task_id = ?').bind(run2.taskId).first<{ n: number }>())!.n).toBe(0);
    });
  });
});

describe('逾時的兩種原因', () => {
  it('沒有來取證據包、取了沒有送回 → 「照規則」結論的原因與 AI_TIMEOUT 告警各寫各的', async () => {
    await withDb(async (db, env) => {
      const never = await startRun(env, fireOk, pack('2026-11-30_OWN_REVIEW_ZZZ_never1'), T0);
      const fetched = await startRun(env, fireOk, pack('2026-11-30_OWN_REVIEW_ZZZ_fetch1'), T0);
      expect((await getEvidence(env, fetched.taskId!, new Date(T0.getTime() + 2 * 60_000))).status).toBe(200);

      // 03:30 的那一次（沒有帳戶也照樣標記逾時；不對外連線）
      const noNet: Fetcher = async (url) => {
        throw new Error(`不應該連線：${url}`);
      };
      const r = await runFlow(env, noNet, { now: new Date('2026-12-01T03:30:00Z'), attempt: 'APPLY' });
      expect(r.alerts).toContain('AI_TIMEOUT');
      const alert = await db.prepare("SELECT message FROM alerts WHERE kind = 'AI_TIMEOUT'").first<{ message: string }>();
      expect(alert!.message).toBe(`2 個 AI 任務逾時，已照規則處理：雲端排程沒有來取證據包（多半是額度用完或 session 沒開成）：1 個（${never.taskId}）；雲端排程取了證據包，但 45 分鐘內沒有送回結果：1 個（${fetched.taskId}）。`);

      expect((await getRun(db, never.runId))!.outcome!.reason).toBe('超過 45 分鐘沒有收到結果：雲端排程沒有來取證據包（多半是額度用完或 session 沒開成），照規則。');
      expect((await getRun(db, fetched.runId))!.outcome!.reason).toBe('超過 45 分鐘沒有收到結果：雲端排程取了證據包，但 45 分鐘內沒有送回結果，照規則。');
    });
  });

  it('同一句給其他「沒有結論」的告警用；只有一種原因時只列那一種', () => {
    expect(timeoutReason(false)).toBe('雲端排程沒有來取證據包（多半是額度用完或 session 沒開成）');
    expect(timeoutReason(true)).toBe('雲端排程取了證據包，但 45 分鐘內沒有送回結果');
    expect(timeoutAlert([{ id: 'a', fetched: true }, { id: 'b', fetched: true }])).toBe('2 個 AI 任務逾時，已照規則處理：雲端排程取了證據包，但 45 分鐘內沒有送回結果：2 個（a、b）。');
  });
});
