// T16：運作統計 /admin/ops-report。
//   構造幾則通知、失敗紀錄、推播失敗、AI 執行與回覆，各段的數字要對；可以指定期間；預設從上線日算起；一段算失敗不影響其他段。
// 全部用假資料（repo 是公開的）。
import { describe, expect, it } from 'vitest';
import type { Env, Fetcher } from '../src/app/env';
import { OPS_SECTIONS, buildOpsReport, nextDay, resolvePeriod, validDate, type OpsReport, type Row, type SectionFn } from '../src/app/opsReport';
import { handle } from '../src/index';
import { freshDb } from './helpers/d1';

async function withDb(fn: (db: D1Database, env: Env) => Promise<void>) {
  const d = await freshDb();
  try {
    await fn(d.db, { DB: d.db, ADMIN_TOKEN: 'admin-secret', AI_TASK_SECRET: 'task-secret' });
  } finally {
    await d.dispose();
  }
}

const NOW = new Date('2026-11-25T03:00:00Z');
const fetcher: Fetcher = async () => new Response('x');
const get = (env: Env, query: string, token: string | null = 'admin-secret') => handle(new Request(`https://bot.example/admin/ops-report${query}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} }), env, fetcher, NOW);
const report = async (env: Env, query = ''): Promise<OpsReport> => {
  const res = await get(env, query);
  expect(res.status).toBe(200);
  return (await res.json()) as OpsReport;
};
const rows = (r: OpsReport, id: string): Row[] => {
  const s = r.sections.find((x) => x.id === id);
  if (!s) throw new Error(`沒有 ${id} 這一段`);
  return s.rows;
};
const row = (r: OpsReport, id: string, key: string, value: string): Row => {
  const found = rows(r, id).find((x) => x[key] === value);
  if (!found) throw new Error(`${id} 沒有 ${key} = ${value} 的列`);
  return found;
};

// ---------------------------------------------------------------- 構造資料

const run = (db: D1Database, sql: string, ...args: unknown[]) => db.prepare(sql).bind(...args).run();

const item = (f: string, choice: string, ruleChoice: string, extra: Record<string, unknown> = {}) => ({ key: `${f}-${choice}`, f, choice, ruleChoice, ...extra });
async function notif(db: D1Database, id: number, kind: string, date: string, status: string, items: unknown[]) {
  await run(db, 'INSERT INTO notifications (id, kind, date, status, updated_at, body) VALUES (?, ?, ?, ?, ?, ?)', id, kind, date, status, `${date}T23:40:00.000Z`, JSON.stringify({ id, kind, date, status, items }));
}
async function shadow(db: D1Database, date: string, f: string, body: Record<string, unknown>) {
  await run(db, 'INSERT INTO shadow_records (rev, date, f, ticker, body) VALUES (1, ?, ?, ?, ?)', date, f, (body.ticker as string) ?? null, JSON.stringify({ date, f, ticker: null, title: f, rule: 0, ai: null, actual: 0, price: 10, choice: 'RULE', ...body }));
}
async function dataRun(db: D1Database, at: string, status: string, signalsOk: number, rebalanceOk: number, ms: number) {
  await run(db, "INSERT INTO data_runs (session, at, status, signals_ok, rebalance_ok, ranked, ms, detail) VALUES ('2026-11-16', ?, ?, ?, ?, 0, ?, '{}')", at, status, signalsOk, rebalanceOk, ms);
}
async function flowRun(db: D1Database, at: string, attempt: string, status: string) {
  await run(db, "INSERT INTO flow_runs (session, at, attempt, status, detail) VALUES ('2026-11-16', ?, ?, ?, '{}')", at, attempt, status);
}
async function alert(db: D1Database, at: string, kind: string, sentAt: string | null) {
  await run(db, "INSERT INTO alerts (at, session, kind, message, sent_at) VALUES (?, NULL, ?, '訊息', ?)", at, kind, sentAt);
}
async function push(db: D1Database, at: string, kind: string, ref: number | null, ok: boolean) {
  await run(db, "INSERT INTO pushes (at, kind, ref, ok, status, error, text) VALUES (?, ?, ?, ?, ?, NULL, '文字')", at, kind, ref, ok ? 1 : 0, ok ? 200 : 500);
}
const sample = (valid: boolean) => ({ index: 0, valid, verdict: 'HOLD', rawVerdict: 'HOLD', issues: [], evidence: [], premises: [], conditions: [], abstainReason: null, dataMissing: [], model: 'm' });
async function aiRun(db: D1Database, id: string, fn: string, createdAt: string, status: string, outcome: { status: string; actionable?: boolean; valid?: boolean[] } | null) {
  const o = outcome && JSON.stringify({ status: outcome.status, verdict: 'HOLD', votes: {}, actionable: outcome.actionable ?? false, followRule: !outcome.actionable, reason: '', samples: (outcome.valid ?? []).map(sample) });
  await run(db, "INSERT INTO ai_runs (run_id, fn, ticker, as_of, created_at, status, prompt_version, pack_hash, pack, outcome) VALUES (?, ?, 'ZZZ', '2026-11-16', ?, ?, 'v1', 'h', '{}', ?)", id, fn, createdAt, status, o);
}
async function task(db: D1Database, id: string, kind: string, status: string, createdAt: string, opts: { fetched?: boolean; minutes?: number } = {}) {
  const done = opts.minutes === undefined ? null : new Date(Date.parse(createdAt) + opts.minutes * 60_000).toISOString();
  await run(db, "INSERT INTO ai_tasks (id, kind, status, evidence, created_at, fetched_at, completed_at) VALUES (?, ?, ?, '{}', ?, ?, ?)", id, kind, status, createdAt, opts.fetched ? createdAt : null, done);
}
async function rejection(db: D1Database, taskId: string, at: string, status: string, truncated: boolean) {
  await run(db, "INSERT INTO ai_rejections (task_id, kind, at, status, reason, http_status, raw, raw_bytes, truncated) VALUES (?, 'RUN', ?, ?, '原因', 422, 'raw', 3, ?)", taskId, at, status, truncated ? 1 : 0);
}

/** 上線日 2026-11-15；11-10 的各一筆是上線前的（預設期間不算）。 */
async function seed(db: D1Database) {
  await run(db, "INSERT INTO flow_state (key, value, updated_at) VALUES ('launch_date', '2026-11-15', '2026-11-15T00:00:00.000Z')");
  // 通知
  await notif(db, 1, 'MONTHLY', '2026-11-10', 'RESPONDED', [item('F7', 'RULE', 'RULE')]);
  await notif(db, 2, 'MONTHLY', '2026-11-16', 'RESPONDED', [
    item('F7', 'AI', 'RULE'),
    item('F7', 'RULE', 'RULE'),
    item('F24', 'SKIP', 'RULE'),
    item('F24', 'SKIP', 'SKIP'),
    item('F24', 'DO', 'RULE', { cancelled: true }),
    item('F24', 'DO', 'SKIP'),
  ]);
  await notif(db, 3, 'URGENT', '2026-11-17', 'DONE', [item('F7', 'RULE', 'RULE')]);
  await notif(db, 4, 'URGENT', '2026-11-18', 'PENDING', [item('F7', 'RULE', 'RULE')]);
  await notif(db, 5, 'INFO', '2026-11-19', 'READ', []);
  await notif(db, 6, 'URGENT', '2026-11-20', 'SUPERSEDED', []);
  // 沒照做的紀錄（3 號通知先回覆、改決定、再回覆）
  await shadow(db, '2026-11-10', 'F7', { ticker: 'OLD', rule: -1, actual: 0, choice: 'SKIP', notif: 1 });
  await shadow(db, '2026-11-16', 'F7', { ticker: 'MU', rule: -10, ai: -5, actual: -5, choice: 'AI', notif: 2 });
  await shadow(db, '2026-11-16', 'F24', { ticker: 'NVDA', rule: -10, actual: 0, choice: 'SKIP', notif: 2 });
  await shadow(db, '2026-11-17', 'F17', { ticker: 'MU', rule: 0, actual: 5, choice: 'MANUAL' });
  await shadow(db, '2026-11-17', 'F7', { ticker: 'AMD', rule: -1, actual: -1, choice: 'RULE', notif: 3 });
  await shadow(db, '2026-11-17', 'REOPEN', { rule: 0, actual: 0, choice: 'REOPEN', notif: 3 });
  await shadow(db, '2026-11-17', 'F7', { ticker: 'AMD', rule: -1, actual: 0, choice: 'SKIP', notif: 3 });
  // 資料與排程
  await dataRun(db, '2026-11-10T22:00:00.000Z', 'FAILED', 0, 0, 100);
  await dataRun(db, '2026-11-16T22:00:00.000Z', 'OK', 1, 1, 1000);
  await dataRun(db, '2026-11-17T22:00:00.000Z', 'DEGRADED', 1, 0, 2000);
  await dataRun(db, '2026-11-18T22:00:00.000Z', 'FAILED', 0, 0, 3000);
  await flowRun(db, '2026-11-16T23:30:00.000Z', 'FIRST', 'DONE');
  await flowRun(db, '2026-11-17T01:30:00.000Z', 'FINAL', 'SKIPPED');
  await flowRun(db, '2026-11-17T23:30:00.000Z', 'FIRST', 'ERROR');
  await flowRun(db, '2026-11-18T01:30:00.000Z', 'FINAL', 'ERROR');
  await flowRun(db, '2026-11-19T23:30:00.000Z', 'FIRST', 'DONE');
  await flowRun(db, '2026-11-10T23:30:00.000Z', 'FIRST', 'ERROR');
  await alert(db, '2026-11-17T00:00:00.000Z', 'FLOW_ERROR', '2026-11-17T00:01:00.000Z');
  await alert(db, '2026-11-17T01:00:00.000Z', 'FLOW_ERROR', 'RESOLVED');
  await alert(db, '2026-11-18T01:00:00.000Z', 'FLOW_ERROR', 'SKIPPED_OLD');
  await alert(db, '2026-11-18T02:00:00.000Z', 'AI_TIMEOUT', null);
  await alert(db, '2026-11-09T02:00:00.000Z', 'AI_TIMEOUT', null);
  // 推播：通知 2 失敗一次後補成功、通知 3 失敗兩次一直沒成功
  await push(db, '2026-11-16T23:40:00.000Z', 'NOTIF', 2, false);
  await push(db, '2026-11-17T01:40:00.000Z', 'NOTIF', 2, true);
  await push(db, '2026-11-17T23:40:00.000Z', 'NOTIF', 3, false);
  await push(db, '2026-11-18T01:40:00.000Z', 'NOTIF', 3, false);
  await push(db, '2026-11-18T03:00:00.000Z', 'ALERT', null, true);
  await push(db, '2026-11-18T04:00:00.000Z', 'REPLY', null, true);
  await push(db, '2026-11-18T05:00:00.000Z', 'TEST', null, false);
  await push(db, '2026-11-10T05:00:00.000Z', 'NOTIF', 1, false);
  // AI 執行
  await aiRun(db, 'r1', 'OWN_REVIEW', '2026-11-16T00:00:00.000Z', 'DONE', { status: 'AGREED', actionable: true, valid: [true, true, true] });
  await aiRun(db, 'r2', 'OWN_REVIEW', '2026-11-17T00:00:00.000Z', 'DONE', { status: 'SPLIT', valid: [true, true, false] });
  await aiRun(db, 'r3', 'OWN_REVIEW', '2026-11-18T00:00:00.000Z', 'DONE', { status: 'TIMEOUT' });
  await aiRun(db, 'r4', 'MOM_ENTRY', '2026-11-18T00:00:00.000Z', 'DONE', { status: 'INVALID', valid: [false, false] });
  await aiRun(db, 'r5', 'MOM_ENTRY', '2026-11-19T00:00:00.000Z', 'PENDING', null);
  await aiRun(db, 'r0', 'OWN_REVIEW', '2026-11-10T00:00:00.000Z', 'DONE', { status: 'AGREED', actionable: true, valid: [true] });
  // 雲端任務與被退回的輸出
  await task(db, 't1', 'RUN', 'DONE', '2026-11-16T00:00:00.000Z', { fetched: true, minutes: 10 });
  await task(db, 't2', 'RUN', 'DONE', '2026-11-16T01:00:00.000Z', { fetched: true, minutes: 20 });
  await task(db, 't3', 'RUN', 'REJECTED', '2026-11-16T02:00:00.000Z', { fetched: true, minutes: 5 });
  await task(db, 't4', 'RUN', 'TIMEOUT', '2026-11-16T03:00:00.000Z');
  await task(db, 't5', 'RUN', 'TIMEOUT', '2026-11-16T04:00:00.000Z', { fetched: true });
  await task(db, 't6', 'RUN', 'FIRE_FAILED', '2026-11-16T05:00:00.000Z');
  await task(db, 't7', 'RUN', 'PENDING', '2026-11-16T06:00:00.000Z');
  await task(db, 't8', 'PING', 'DONE', '2026-11-16T07:00:00.000Z', { fetched: true, minutes: 3 });
  await task(db, 't0', 'RUN', 'REJECTED', '2026-11-10T00:00:00.000Z', { fetched: true, minutes: 1 });
  await rejection(db, 't3', '2026-11-16T02:05:00.000Z', 'REJECTED', false);
  await rejection(db, 't5', '2026-11-17T09:00:00.000Z', 'LATE', true);
  await rejection(db, 't0', '2026-11-10T00:01:00.000Z', 'REJECTED', false);
}

// ---------------------------------------------------------------- 完成條件

describe('T16 運作統計：各段的數字（指定期間 2026-11-11～2026-11-24）', () => {
  const Q = '?from=2026-11-11&to=2026-11-24';

  it('通知：依種類的次數與處理狀態；上線前的不算', async () => {
    await withDb(async (db, env) => {
      await seed(db);
      const r = await report(env, Q);
      expect(row(r, 'notifications', 'kind', 'MONTHLY')).toMatchObject({ total: 1, responded: 1, pending: 0 });
      expect(row(r, 'notifications', 'kind', 'URGENT')).toMatchObject({ total: 3, responded: 1, pending: 1, superseded: 1 });
      expect(row(r, 'notifications', 'kind', 'INFO')).toMatchObject({ total: 1, read: 1 });
      expect(row(r, 'notifications', 'kind', '合計')).toMatchObject({ total: 5, responded: 2, pending: 1, read: 1, superseded: 1 });
    });
  });

  it('資料抓取與每日流程：失敗的次數', async () => {
    await withDb(async (db, env) => {
      await seed(db);
      const r = await report(env, Q);
      expect(row(r, 'data_runs', 'status', 'OK')).toMatchObject({ runs: 1, no_signal: 0, no_rebalance: 0, avg_ms: 1000 });
      expect(row(r, 'data_runs', 'status', 'DEGRADED')).toMatchObject({ runs: 1, no_signal: 0, no_rebalance: 1 });
      expect(row(r, 'data_runs', 'status', 'FAILED')).toMatchObject({ runs: 1, no_signal: 1, no_rebalance: 1 });
      expect(row(r, 'data_runs', 'status', '合計')).toMatchObject({ runs: 3, no_signal: 1, no_rebalance: 2 });
      const flow = rows(r, 'flow_runs');
      expect(flow.find((x) => x.attempt === 'FIRST' && x.status === 'DONE')?.runs).toBe(2);
      expect(flow.find((x) => x.attempt === 'FIRST' && x.status === 'ERROR')?.runs).toBe(1);
      expect(flow.find((x) => x.attempt === 'FINAL' && x.status === 'ERROR')?.runs).toBe(1);
      expect(flow.find((x) => x.attempt === 'FINAL' && x.status === 'SKIPPED')?.runs).toBe(1);
      expect(flow.find((x) => x.attempt === '合計')?.runs).toBe(5);
      // 告警
      expect(row(r, 'alerts', 'kind', 'FLOW_ERROR')).toMatchObject({ total: 3, pushed: 1, resolved: 1, skipped_old: 1, unsent: 0 });
      expect(row(r, 'alerts', 'kind', 'AI_TIMEOUT')).toMatchObject({ total: 1, unsent: 1 });
    });
  });

  it('推播：依種類的次數、失敗、一直沒推成功的通知', async () => {
    await withDb(async (db, env) => {
      await seed(db);
      const r = await report(env, Q);
      expect(row(r, 'pushes', 'kind', 'NOTIF')).toMatchObject({ total: 4, ok: 1, failed: 3, never_delivered: 1 });
      expect(row(r, 'pushes', 'kind', 'ALERT')).toMatchObject({ total: 1, ok: 1, failed: 0 });
      expect(row(r, 'pushes', 'kind', 'REPLY')).toMatchObject({ total: 1, ok: 1 });
      expect(row(r, 'pushes', 'kind', 'TEST')).toMatchObject({ total: 1, failed: 1, never_delivered: 0 });
      expect(row(r, 'pushes', 'kind', '合計')).toMatchObject({ total: 7, ok: 3, failed: 4, never_delivered: 1 });
    });
  });

  it('AI 執行：依功能的結論狀態與通過檢查的比例；每一票合格的比例', async () => {
    await withDb(async (db, env) => {
      await seed(db);
      const r = await report(env, Q);
      expect(row(r, 'ai_runs', 'fn', 'OWN_REVIEW')).toMatchObject({ runs: 3, pending: 0, done: 3, agreed: 1, split: 1, timeout: 1, actionable: 1, usable: 2, usable_ratio: 0.667 });
      expect(row(r, 'ai_runs', 'fn', 'MOM_ENTRY')).toMatchObject({ runs: 2, pending: 1, done: 1, invalid: 1, usable: 0, usable_ratio: 0 });
      expect(row(r, 'ai_runs', 'fn', '合計')).toMatchObject({ runs: 5, pending: 1, done: 4, usable: 2, usable_ratio: 0.5 });
      expect(row(r, 'ai_votes', 'fn', 'OWN_REVIEW')).toMatchObject({ votes: 6, valid: 5, valid_ratio: 0.833 });
      expect(row(r, 'ai_votes', 'fn', 'MOM_ENTRY')).toMatchObject({ votes: 2, valid: 0, valid_ratio: 0 });
      expect(row(r, 'ai_votes', 'fn', '合計')).toMatchObject({ votes: 8, valid: 5, valid_ratio: 0.625 });
    });
  });

  it('雲端任務與被退回的輸出：結局、逾時的兩種原因、通過外層檢查的比例', async () => {
    await withDb(async (db, env) => {
      await seed(db);
      const r = await report(env, Q);
      expect(row(r, 'ai_tasks', 'kind', 'RUN')).toMatchObject({ tasks: 7, open: 1, done: 2, rejected: 1, timeout: 2, timeout_not_fetched: 1, timeout_after_fetch: 1, fire_failed: 1, late: 1, avg_minutes: 15, pass_ratio: 0.5 });
      expect(row(r, 'ai_tasks', 'kind', 'PING')).toMatchObject({ tasks: 1, done: 1, pass_ratio: 1 });
      expect(row(r, 'ai_tasks', 'kind', '合計')).toMatchObject({ tasks: 8, done: 3, rejected: 1, late: 1, pass_ratio: 0.6 });
      const rej = rows(r, 'ai_rejections');
      expect(rej.find((x) => x.status === 'LATE')).toMatchObject({ kind: 'RUN', n: 1, truncated: 1 });
      expect(rej.find((x) => x.status === 'REJECTED')).toMatchObject({ kind: 'RUN', n: 1, truncated: 0 });
      expect(rej.find((x) => x.kind === '合計')).toMatchObject({ n: 2, truncated: 1 });
    });
  });

  it('照做／沒照做：通知上的選擇 vs 規則（取消的項目不算）；影子紀錄濾掉被作廢的', async () => {
    await withDb(async (db, env) => {
      await seed(db);
      const r = await report(env, Q);
      expect(row(r, 'choices', 'f', 'F7')).toMatchObject({ items: 3, same_as_rule: 2, took_ai: 1, skipped: 0, other: 0, pending_items: 1, same_ratio: 0.667 });
      expect(row(r, 'choices', 'f', 'F24')).toMatchObject({ items: 3, same_as_rule: 1, took_ai: 0, skipped: 1, other: 1, pending_items: 0 });
      expect(row(r, 'choices', 'f', '合計')).toMatchObject({ items: 6, same_as_rule: 3, took_ai: 1, skipped: 1, other: 1, pending_items: 1, same_ratio: 0.5 });
      // 影子紀錄：F7 有 2 筆（11-16 的 AI、改決定之後的那筆；改決定之前的那筆和記號本身不算；11-10 的在期間外）
      expect(row(r, 'shadow', 'f', 'F7')).toMatchObject({ records: 2, not_followed_rule: 2, followed_rule: 0, with_ai: 1, followed_ai: 1 });
      expect(row(r, 'shadow', 'f', 'F24')).toMatchObject({ records: 1, not_followed_rule: 1 });
      expect(row(r, 'shadow', 'f', 'F17')).toMatchObject({ records: 1, manual: 1, not_followed_rule: 0 });
      expect(rows(r, 'shadow').find((x) => x.f === 'REOPEN')).toBeUndefined();
      expect(row(r, 'shadow', 'f', '合計')).toMatchObject({ records: 4, manual: 1, with_ai: 1 });
    });
  });
});

describe('T16 運作統計：期間', () => {
  it('預設從上線日算起、到今天：上線前的紀錄不算', async () => {
    await withDb(async (db, env) => {
      await seed(db);
      const r = await report(env);
      expect(r.period).toEqual({ from: '2026-11-15', to: '2026-11-25', from_source: 'launch_date' });
      expect(r.launch_date).toBe('2026-11-15');
      expect(row(r, 'notifications', 'kind', '合計').total).toBe(5);
      expect(row(r, 'data_runs', 'status', '合計').runs).toBe(3);
      expect(row(r, 'ai_runs', 'fn', '合計').runs).toBe(5);
      expect(row(r, 'ai_rejections', 'kind', '合計').n).toBe(2);
    });
  });

  it('指定 from／to：含頭尾；只給 from 時 to 是今天；沒有上線日又沒指定就從頭算', async () => {
    await withDb(async (db, env) => {
      await seed(db);
      // 只看 11-17 一天：時間戳欄位照 UTC 日期切
      const one = await report(env, '?from=2026-11-17&to=2026-11-17');
      expect(row(one, 'data_runs', 'status', '合計').runs).toBe(1);
      expect(row(one, 'notifications', 'kind', '合計').total).toBe(1);
      expect(row(one, 'flow_runs', 'attempt', '合計').runs).toBe(2);
      expect(row(one, 'pushes', 'kind', '合計').total).toBe(2);
      expect(one.period).toEqual({ from: '2026-11-17', to: '2026-11-17', from_source: 'param' });
      // 包含上線前
      const all = await report(env, '?from=2026-11-01');
      expect(row(all, 'notifications', 'kind', '合計').total).toBe(6);
      expect(row(all, 'data_runs', 'status', '合計').runs).toBe(4);
      expect(row(all, 'ai_tasks', 'kind', '合計').tasks).toBe(9);
      // 沒有上線日
      await run(db, "DELETE FROM flow_state WHERE key = 'launch_date'");
      const none = await report(env);
      expect(none.period).toEqual({ from: null, to: '2026-11-25', from_source: 'none' });
      expect(row(none, 'notifications', 'kind', '合計').total).toBe(6);
    });
  });

  it('期間的參數錯誤 → 400；沒帶或帶錯 ADMIN_TOKEN → 401', async () => {
    await withDb(async (db, env) => {
      await seed(db);
      for (const q of ['?from=2026-13-01', '?to=yesterday', '?from=2026-11-20&to=2026-11-10', '?from=2026-02-30']) {
        const res = await get(env, q);
        expect(res.status, q).toBe(400);
        expect(await res.json()).toMatchObject({ error: 'bad_period' });
      }
      expect((await get(env, '', null)).status).toBe(401);
      expect((await get(env, '', 'wrong')).status).toBe(401);
      expect((await handle(new Request('https://bot.example/admin/ops-report', { method: 'POST', headers: { Authorization: 'Bearer admin-secret' } }), env, fetcher, NOW)).status).not.toBe(200);
    });
  });

  it('日期的小工具', async () => {
    expect(validDate('2026-11-15')).toBe(true);
    expect(validDate('2026-02-29')).toBe(false);
    expect(validDate('2026-1-5')).toBe(false);
    expect(nextDay('2026-11-30')).toBe('2026-12-01');
    expect(nextDay('2026-12-31')).toBe('2027-01-01');
    await withDb(async (db) => {
      expect(await resolvePeriod(db, null, null, NOW)).toEqual({ from: null, to: '2026-11-25', fromSource: 'none' });
    });
  });
});

describe('T16 運作統計：結構', () => {
  it('空的資料庫：每一段都有、列是空的、沒有錯誤', async () => {
    await withDb(async (_db, env) => {
      const r = await report(env);
      expect(r.sections.map((s) => s.id)).toEqual(['notifications', 'choices', 'shadow', 'data_runs', 'flow_runs', 'alerts', 'pushes', 'ai_runs', 'ai_votes', 'ai_tasks', 'ai_rejections', 'checkpoints', 'crash_reviews']);
      for (const s of r.sections) {
        expect(s.error, s.id).toBeUndefined();
        expect(s.rows, s.id).toEqual([]);
        expect(s.title.length).toBeGreaterThan(0);
      }
      expect(r.launch_date).toBeNull();
      expect(r.generated_at).toBe(NOW.toISOString());
    });
  });

  it('報表由 OPS_SECTIONS 的函式組成；加一段只要加一個函式，一段算失敗不影響其他段', async () => {
    await withDb(async (db) => {
      await seed(db);
      const extra: SectionFn = async () => ({ id: 'extra', title: '後面的任務加的一段', rows: [{ x: 1 }] });
      const broken: SectionFn = async () => {
        throw new Error('這一段壞了');
      };
      const p = await resolvePeriod(db, '2026-11-11', '2026-11-24', NOW);
      if ('error' in p) throw new Error(p.error);
      const rep = await buildOpsReport(db, p, NOW, [...OPS_SECTIONS, extra, broken]);
      expect(rep.sections.at(-2)).toEqual({ id: 'extra', title: '後面的任務加的一段', rows: [{ x: 1 }] });
      expect(rep.sections.at(-1)).toMatchObject({ id: 'broken', rows: [], error: '這一段壞了' });
      expect(rep.sections.find((s) => s.id === 'notifications')?.rows.length).toBeGreaterThan(0);
    });
  });
});
