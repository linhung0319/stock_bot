// Worker 進入點：路由與排程。
//   /health                      不需要驗證
//   /ai/task/:id/evidence|result 雲端排程用，Bearer AI_TASK_SECRET
//   /admin/*                     管理用，Bearer ADMIN_TOKEN（Cloudflare Access 設好之前）
import { acceptResult, createTask, fireRoutine, getTask, readEvidence, sweepTimeouts, taskTimings } from './app/aiTasks';
import { bearerOk, json, type Env, type Fetcher } from './app/env';
import { loadAccount, requiredTickers } from './app/ledgerStore';
import { probeSummary, runProbe, saveProbe } from './app/probe';
import { runIngest, type IngestResult } from './data/ingest';
import { loadConstituents, loadRanking, recentAlerts, recentRuns, saveRun, seriesFreshness } from './data/store';
import { errText } from './data/util';

export const VERSION = '0.3.0';

/** 每日資料抓取的排程（美股收盤後；UTC 23:30 = 美東 18:30 或 19:30）。 */
export const INGEST_CRON = '30 23 * * 1-5';

const realFetch: Fetcher = (url, init) => fetch(url, init);

/** 每日資料抓取：必要的代號從帳戶讀（還沒建立帳戶時只有核心 ETF 與短債）。出錯也會留一筆紀錄與告警。 */
export async function ingest(env: Env, fetcher: Fetcher, now: Date, forceRank = false): Promise<IngestResult | { error: string }> {
  try {
    const loaded = await loadAccount(env.DB);
    return await runIngest(env.DB, fetcher, { now, required: requiredTickers(loaded?.acct ?? null), forceRank });
  } catch (e) {
    const error = errText(e);
    console.error('每日資料抓取失敗', e);
    await saveRun(env.DB, { session: '', at: now.toISOString(), status: 'FAILED', signalsOk: false, rebalanceOk: false, ranked: false, ms: 0, detail: { error } }, [{ kind: 'INGEST_ERROR', message: '每日資料抓取出錯，今天不產生訊號：' + error }]);
    return { error };
  }
}

async function dataStatus(db: D1Database) {
  const [runs, alerts, fresh, ranking, members] = await Promise.all([recentRuns(db, 5), recentAlerts(db, 20), seriesFreshness(db), loadRanking(db), loadConstituents(db)]);
  const byDate: Record<string, number> = {};
  for (const f of fresh) byDate[f.last_date] = (byDate[f.last_date] ?? 0) + 1;
  return {
    runs,
    alerts,
    series: { n: fresh.length, byLastDate: byDate },
    ranking: ranking && { session: ranking.session, top15: ranking.order.slice(0, 15), n: ranking.order.length, missing: ranking.detail.missing },
    constituents: members && { session: members.session, n: members.holdings.length, nWiki: members.nWiki, spyAsOf: members.spyAsOf, consistent: members.consistent, onlySpy: members.onlySpy, onlyWiki: members.onlyWiki },
  };
}

export async function handle(request: Request, env: Env, fetcher: Fetcher = realFetch, now: Date = new Date()): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === '/health') return json({ ok: true, version: VERSION });

  const ai = /^\/ai\/task\/([0-9a-f]{32})\/(evidence|result)$/.exec(path);
  if (ai) {
    if (!bearerOk(request, env.AI_TASK_SECRET)) return json({ error: 'unauthorized' }, 401);
    if (ai[2] === 'evidence' && request.method === 'GET') return readEvidence(env.DB, ai[1], now);
    if (ai[2] === 'result' && request.method === 'POST') return acceptResult(env.DB, ai[1], await request.text(), now);
    return json({ error: 'method_not_allowed' }, 405);
  }

  if (path.startsWith('/admin/')) {
    if (!bearerOk(request, env.ADMIN_TOKEN)) return json({ error: 'unauthorized' }, 401);
    if (path === '/admin/probe' && request.method === 'POST') {
      const part = url.searchParams.get('part') === 'B' ? 'B' : 'A';
      const rows = await runProbe(env, part, fetcher);
      await saveProbe(env.DB, now.toISOString(), rows);
      return json({ part, n: rows.length, ok: rows.filter((r) => r.ok).length, failed: rows.filter((r) => !r.ok) });
    }
    if (path === '/admin/probe/summary') return json(await probeSummary(env.DB));
    if (path === '/admin/ingest' && request.method === 'POST') {
      const r = await ingest(env, fetcher, now, url.searchParams.get('rank') === '1');
      if ('error' in r) return json(r, 500);
      const { ranking, ...rest } = r;
      return json({ ...rest, ranking: ranking && { session: ranking.session, order: ranking.order } });
    }
    if (path === '/admin/data/status') return json(await dataStatus(env.DB));
    if (path === '/admin/ai/ping' && request.method === 'POST') {
      // T5：建一份假的證據包，觸發雲端排程，等它取回並送回結果
      const nonce = crypto.randomUUID();
      const id = await createTask(env.DB, 'PING', { nonce, note: '這是測試用的假證據包', created: now.toISOString() }, now);
      const fired = await fireRoutine(env, id, fetcher, now);
      return json({ id, fired }, fired.ok ? 200 : 502);
    }
    const task = /^\/admin\/ai\/task\/([0-9a-f]{32})$/.exec(path);
    if (task) {
      const t = await getTask(env.DB, task[1]);
      return t ? json(taskTimings(t)) : json({ error: 'not_found' }, 404);
    }
    return json({ error: 'not_found' }, 404);
  }
  return new Response('stock bot', { status: 200 });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handle(request, env);
    } catch (e) {
      console.error('未處理的錯誤', e);
      return json({ error: 'internal_error' }, 500);
    }
  },
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const now = new Date(controller.scheduledTime);
    if (controller.cron === INGEST_CRON) {
      const r = await ingest(env, realFetch, now);
      console.log(JSON.stringify('error' in r ? r : { ingest: r.session, status: r.status, signalsOk: r.signalsOk, rebalanceOk: r.rebalanceOk, ranked: r.ranked, alerts: r.alerts.length, ms: r.ms }));
      return;
    }
    // T4 實測：每天兩次，各跑一半
    const part = now.getUTCMinutes() < 8 ? 'A' : 'B';
    const rows = await runProbe(env, part, realFetch);
    await saveProbe(env.DB, now.toISOString(), rows);
    const timedOut = await sweepTimeouts(env.DB, now);
    console.log(JSON.stringify({ probe: part, n: rows.length, ok: rows.filter((r) => r.ok).length, timedOut }));
  },
} satisfies ExportedHandler<Env>;
