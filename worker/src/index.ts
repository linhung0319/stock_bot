// Worker 進入點：路由與排程。
//   /health                      不需要驗證
//   /ai/task/:id/evidence|result 雲端排程用，Bearer AI_TASK_SECRET
//   /admin/*                     管理用，Bearer ADMIN_TOKEN
//   /api/*、/demo/api/*          網站的 API（Cloudflare Access；src/app/site/）
//   其他                         網站的靜態檔（public/，由 Cloudflare 直接回應，不會進到這裡）
import { acceptResult, createTask, fireRoutine, getTask, readEvidence, taskTimings } from './app/aiTasks';
import { finalizeRun, listRuns } from './app/aiRuns';
import { bearerOk, json, type Env, type Fetcher } from './app/env';
import { getFlowState, ingest, pushPending, recentFlowRuns, runFlow, sendTestPush } from './app/flow';
import { loadAccount, requiredTickers } from './app/ledgerStore';
import { startOwnReview } from './app/ownAi';
import { entryEvidence } from './app/momAi';
import { buildSnapshot, saveSnapshot } from './app/crashAi';
import { entryRuleVerdict } from './ai/momEntry';
import { buildMarketView } from './data/marketView';
import { lineConfigured } from './app/line';
import { probeSummary, runProbe, saveProbe } from './app/probe';
import { handleSite } from './app/site/api';
import { loadConstituents, loadRanking, loadSeries, recentAlerts, recentRuns, saveAlerts, seriesFreshness } from './data/store';

export const VERSION = '0.6.0';

/** 每日流程（美股收盤後；UTC 23:30 = 美東 18:30 或 19:30 = 台灣早上 7:30）：抓資料、每日檢查、月報、LINE。 */
export const INGEST_CRON = '30 23 * * 1-5';
/** 兩小時後再試一次（UTC 01:30，週二到週六）：今天沒跑完就重跑，還是不行就告警；AI 任務逾時也在這裡查。 */
export const FINAL_CRON = '30 1 * * 2-6';

const realFetch: Fetcher = (url, init) => fetch(url, init);

export { ingest };

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
    if (ai[2] === 'result' && request.method === 'POST') return acceptResult(env.DB, ai[1], await request.text(), now, (task, result) => (task.kind === 'RUN' ? finalizeRun(env.DB, task, result, now) : Promise.resolve()));
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
    if (path === '/admin/flow' && request.method === 'POST') {
      // 手動跑一次每日流程（同一個交易日已經做過就只補推失敗的訊息）
      const r = await runFlow(env, fetcher, { now, attempt: 'MANUAL', forceRank: url.searchParams.get('rank') === '1' });
      return json(r, r.status === 'ERROR' ? 500 : 200);
    }
    if (path === '/admin/flow/status') {
      const [runs, last, pushes] = await Promise.all([
        recentFlowRuns(env.DB, 10),
        getFlowState(env.DB, 'lastSession'),
        env.DB.prepare('SELECT at, kind, ref, ok, status, error FROM pushes ORDER BY id DESC LIMIT 20').all(),
      ]);
      return json({ lastSession: last, line: lineConfigured(env), siteUrl: env.SITE_URL ?? null, runs, pushes: pushes.results });
    }
    if (path === '/admin/alert/test' && request.method === 'POST') {
      // 走告警的推播路徑：存一則測試告警，照每日流程的方式合成一則推出去
      await saveAlerts(env.DB, now.toISOString(), null, [{ kind: 'TEST', message: '這是測試告警：收到表示告警的推播可以用。' }]);
      const acct = (await loadAccount(env.DB))?.acct ?? null;
      const push = await pushPending(env, fetcher, now, acct, [], true);
      return json(push, push.failed || !push.configured ? 502 : 200);
    }
    if (path === '/admin/line/test' && request.method === 'POST') {
      const r = await sendTestPush(env, fetcher, now, `stock bot 測試訊息（${now.toISOString()}）：收到這則表示 LINE 推播設定好了。`);
      return json(r, r.ok ? 200 : 502);
    }
    if (path === '/admin/ai/ping' && request.method === 'POST') {
      // T5：建一份假的證據包，觸發雲端排程，等它取回並送回結果
      const nonce = crypto.randomUUID();
      const id = await createTask(env.DB, 'PING', { nonce, note: '這是測試用的假證據包', created: now.toISOString() }, now);
      const fired = await fireRoutine(env, id, fetcher, now);
      return json({ id, fired }, fired.ok ? 200 : 502);
    }
    if (path === '/admin/ai/review' && request.method === 'POST') {
      // 手動開一次自選定期審查（F24），T10 實測與量 Max 用量用
      const t = (url.searchParams.get('ticker') ?? '').toUpperCase();
      const loaded = await loadAccount(env.DB);
      if (!loaded?.acct.own[t]) return json({ error: `${t || '（沒有代號）'} 不是自選股` }, 400);
      const series = await loadSeries(env.DB, requiredTickers(loaded.acct));
      const session = series.get(loaded.acct.cfg.coreTicker)?.d.at(-1);
      if (!session) return json({ error: '還沒有價格資料' }, 409);
      const built = buildMarketView(series, session, loaded.acct.cfg.coreTicker);
      const run = await startOwnReview(env, fetcher, loaded.acct, built.view, built.axis, t, 'MANUAL', now);
      return json({ runId: run.runId, taskId: run.taskId, status: run.status, outcome: run.outcome, notes: run.packNotes, documents: run.pack.documents.map((d) => ({ source: d.source_id, title: d.title, chars: d.text.length })), dataQuality: run.pack.data_quality });
    }
    if (path === '/admin/ai/entry' && request.method === 'GET') {
      // T11：對一檔股票跑 F1 的規則偵測（不開法庭、不寫任何東西），部署後驗證 EDGAR、XBRL 小檔、單日漲幅占比
      const t = (url.searchParams.get('ticker') ?? '').toUpperCase();
      const loaded = await loadAccount(env.DB);
      if (!t || !loaded) return json({ error: '要有帳戶與 ?ticker=' }, 400);
      const series = await loadSeries(env.DB, [...requiredTickers(loaded.acct), t]);
      const session = series.get(loaded.acct.cfg.coreTicker)?.d.at(-1);
      if (!session || !series.get(t)) return json({ error: `沒有 ${t} 的價格資料（只看股票池與持股）` }, 409);
      const built = buildMarketView(series, session, loaded.acct.cfg.coreTicker);
      const ev = await entryEvidence(env, fetcher, built.view, built.axis, t, loaded.acct.cfg.coreTicker, false);
      return json({ ticker: t, asOf: session, rule: entryRuleVerdict(ev.hits), hits: ev.hits, notes: ev.notes, dataQuality: ev.dataQuality, docs: ev.docs.map((d) => ({ source: d.source_id, title: d.title, chars: d.text.length })) });
    }
    if (path === '/admin/macro' && request.method === 'POST') {
      // T11：抓 FRED、算一次總經儀表板並存起來（每月的月報前一天會自動做）
      const loaded = await loadAccount(env.DB);
      if (!loaded) return json({ error: '還沒有帳戶' }, 400);
      const ranking = await loadRanking(env.DB);
      const series = await loadSeries(env.DB, [...requiredTickers(loaded.acct), ...(ranking?.order ?? [])]);
      const session = series.get(loaded.acct.cfg.coreTicker)?.d.at(-1);
      if (!session) return json({ error: '還沒有價格資料' }, 409);
      const built = buildMarketView(series, session, loaded.acct.cfg.coreTicker);
      const snap = await buildSnapshot(env.DB, fetcher, loaded.acct, built.view, session.slice(0, 7));
      await saveSnapshot(env.DB, snap, now);
      return json(snap);
    }
    if (path === '/admin/ai/runs') return json((await listRuns(env.DB, now, { limit: 30 })).map((r) => ({ runId: r.runId, fn: r.fn, ticker: r.ticker, asOf: r.asOf, status: r.status, outcome: r.outcome && { status: r.outcome.status, verdict: r.outcome.verdict, votes: r.outcome.votes, reason: r.outcome.reason } })));
    const task = /^\/admin\/ai\/task\/([0-9a-f]{32})$/.exec(path);
    if (task) {
      const t = await getTask(env.DB, task[1]);
      return t ? json(taskTimings(t)) : json({ error: 'not_found' }, 404);
    }
    return json({ error: 'not_found' }, 404);
  }

  const site = await handleSite(request, env, fetcher, now);
  if (site) return site;
  // 靜態檔由 Cloudflare 在 Worker 之前回應；會走到這裡的是不存在的路徑
  return new Response('stock bot', { status: 404 });
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
    const attempt = controller.cron === FINAL_CRON ? 'FINAL' : 'FIRST';
    const r = await runFlow(env, realFetch, { now, attempt });
    console.log(JSON.stringify({ flow: r.session, attempt, status: r.status, processed: r.processed, created: r.created, monthly: r.monthly, alerts: r.alerts, push: r.push, error: r.error, ms: r.ms }));
  },
} satisfies ExportedHandler<Env>;
