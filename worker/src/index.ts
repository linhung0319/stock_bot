// Worker 進入點：路由與排程。
//   /health                      不需要驗證
//   /ai/task/:id/evidence|result 雲端排程用，Bearer AI_TASK_SECRET
//   /ai/task/:id/docs            分析師取文件（T52，web_evidence_design §1.5；src/app/webEvidence.ts），同一把金鑰
//   /ai/task/:id/fresh           給新眼光的那一份證據（T63，composite_layer_design §3；沒有前提、論點本文與歷次審查），同一把金鑰
//   /admin/*                     管理用，Bearer ADMIN_TOKEN（/admin/export：紀錄匯出到本機，src/app/export.ts；/admin/ops-report：運作統計，src/app/opsReport.ts；
//                                /admin/own/*：在 repo 用 Claude Code 討論論點，src/app/site/api.ts 的 handleAdminThesis）
//   /auth/line/login|callback    網站的 LINE 登入（src/app/site/lineLogin.ts）
//   /line/webhook                LINE 關鍵字回覆，驗 X-Line-Signature（src/app/lineWebhook.ts）
//   /api/*、/demo/api/*          網站的 API（LINE 登入的 cookie；src/app/site/）
//   其他                         網站的靜態檔（public/，由 Cloudflare 直接回應，不會進到這裡）
import { acceptResult, createTask, fireRoutine, getTask, readEvidence, taskTimings } from './app/aiTasks';
import { finalizeRun, listRuns } from './app/aiRuns';
import { handleExport } from './app/export';
import { handleOpsReport } from './app/opsReport';
import { bearerOk, json, type Env, type Fetcher } from './app/env';
import { getFlowState, ingest, pushPending, recentFlowRuns, runFlow, sendTestPush } from './app/flow';
import { loadAccount, requiredTickers } from './app/ledgerStore';
import { startOwnReview } from './app/ownAi';
import { entryEvidence } from './app/momAi';
import { buildSnapshot, macroMonthOf, saveSnapshot } from './app/crashAi';
import { entryRuleVerdict } from './ai/momEntry';
import { buildMarketView } from './data/marketView';
import { lineConfigured } from './app/line';
import { handleLineWebhook } from './app/lineWebhook';
import { probeSummary, runProbe, saveProbe } from './app/probe';
import { NEWS_SOURCES, tryHeadlineSource } from './data/edgar';
import { probeRss, probeWebPage } from './data/webProbe';
import { handleAdminThesis, handleSite } from './app/site/api';
import { handleTaskDocs, handleTaskFresh } from './app/webEvidence';
import { pushDraftLines, settleDrafts } from './app/ownDraft';
import { BriefError, manualBrief, settleBriefs } from './app/marketBrief';
import { handleLineLogin } from './app/site/lineLogin';
import { APPLY_CRON, FINAL_CRON, INGEST_CRON, attemptOfCron } from './app/schedule';
import { loadCalendarOverrides, loadConstituents, loadRanking, loadSeries, recentAlerts, recentRuns, saveAlerts, seriesFreshness } from './data/store';

export const VERSION = '0.16.1';

// 三次排程（UTC 23:30、01:30、03:30）各做什麼寫在 src/app/schedule.ts
export { APPLY_CRON, FINAL_CRON, INGEST_CRON };

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

  if (path === '/line/webhook') return handleLineWebhook(request, env, fetcher, now);

  const login = await handleLineLogin(request, env, fetcher, now);
  if (login) return login;

  const ai = /^\/ai\/task\/([0-9a-f]{32})\/(evidence|result|docs|fresh)$/.exec(path);
  if (ai) {
    if (!bearerOk(request, env.AI_TASK_SECRET)) return json({ error: 'unauthorized' }, 401);
    if (ai[2] === 'evidence' && request.method === 'GET') return readEvidence(env.DB, ai[1], now);
    if (ai[2] === 'docs' && request.method === 'POST') return handleTaskDocs(env, fetcher, ai[1], await request.text(), now);
    // 給新眼光的那一份（T63，composite_layer_design §3）：沒有前提、論點本文與歷次審查
    if (ai[2] === 'fresh' && request.method === 'GET') return handleTaskFresh(env, ai[1], now);
    // 論點草稿（T55）收下之後當場結算成 READY 或 FAILED（使用者在等的回覆不用等到下一次每日流程）
    // 使用者按的草稿回來或失敗：推 LINE 一行（T56，web_evidence_design §2.5）
    if (ai[2] === 'result' && request.method === 'POST')
      return acceptResult(env.DB, ai[1], await request.text(), now, (task, result) =>
        task.kind === 'RUN'
          ? finalizeRun(env.DB, task, result, now)
              .then(() => settleDrafts(env.DB, now))
              // 市場摘要（T64）收下之後當場結算成 READY 或 FAILED；這裡出錯不擋下面草稿的推播（每日流程套用時會再結算一次）
              .then(() => settleBriefs(env.DB, now).catch((e) => console.error('市場摘要的結算出錯', e)))
              .then(() => pushDraftLines(env, fetcher, now))
          : Promise.resolve(),
      );
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
    // 從 Cloudflare 逐一試每個新聞來源（不寫資料庫）：?ticker=MU,SPY
    if (path === '/admin/news/test') {
      const tickers = (url.searchParams.get('ticker') ?? 'MU,SPY').split(',').map((t) => t.trim().toUpperCase()).filter(Boolean).slice(0, 5);
      const out = [];
      for (const t of tickers)
        for (const src of NEWS_SOURCES) {
          const r = await tryHeadlineSource(fetcher, src, t);
          out.push(r.ok ? { ticker: t, source: src.key, ok: true, items: r.items.length, newest: r.items[0] ? `${r.items[0].at} ${r.items[0].title}` : null, oldest: r.items.at(-1)?.at ?? null } : { ticker: t, source: src.key, ok: false, error: r.error });
        }
      return json(out);
    }
    // T50 的實測：Worker 抓不抓得到網頁全文（只量、不存）。?url= 可以重複最多 8 個；?rss=<代號> 抓 Yahoo RSS 並探前 3 則的連結
    if (path === '/admin/web/test') {
      const out: unknown[] = [];
      for (const u of url.searchParams.getAll('url').slice(0, 8)) out.push(await probeWebPage(fetcher, u));
      for (const t of url.searchParams.getAll('rss').slice(0, 3)) out.push(await probeRss(fetcher, NEWS_SOURCES[1].url(t.trim().toUpperCase())));
      return json(out);
    }
    if (path === '/admin/ingest' && request.method === 'POST') {
      const r = await ingest(env, fetcher, now, url.searchParams.get('rank') === '1');
      if ('error' in r) return json(r, 500);
      const { ranking, ...rest } = r;
      return json({ ...rest, ranking: ranking && { session: ranking.session, order: ranking.order } });
    }
    if (path === '/admin/data/status') return json(await dataStatus(env.DB));
    if (path === '/admin/export' && request.method === 'GET') return handleExport(env.DB, url, VERSION, now);
    if (path === '/admin/ops-report' && request.method === 'GET') return handleOpsReport(env.DB, url, now);
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
    if (path === '/admin/ai/brief' && request.method === 'POST') {
      // 手動開一次市場摘要的暫定稿（T64；composite_layer_design §5 的 M7：量一次要多久、用多少額度）。不佔頻率上限、不屬於任何事件
      try {
        const run = await manualBrief(env, fetcher, now);
        return json({ runId: run.runId, taskId: run.taskId, status: run.status, outcome: run.outcome, notes: run.packNotes, period: (run.pack.rule.detail as { period?: unknown }).period, facts: run.pack.facts.map((f) => `${f.id} ${f.value}`), documents: run.pack.documents.map((d) => ({ source: d.source_id, title: d.title, chars: d.text.length })), dataQuality: run.pack.data_quality });
      } catch (e) {
        if (e instanceof BriefError) return json({ error: e.message }, e.status);
        throw e;
      }
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
      // 月份標籤和排程一致（core_ai §3.5）：月報前一天與訊號日用 monthOfSignal，其他日子用當月
      const snap = await buildSnapshot(env.DB, fetcher, loaded.acct, built.view, macroMonthOf(session, await loadCalendarOverrides(env.DB)));
      await saveSnapshot(env.DB, snap, now);
      return json(snap);
    }
    if (path === '/admin/ai/runs') return json((await listRuns(env.DB, now, { limit: 30 })).map((r) => ({ runId: r.runId, fn: r.fn, ticker: r.ticker, asOf: r.asOf, status: r.status, outcome: r.outcome && { status: r.outcome.status, verdict: r.outcome.verdict, votes: r.outcome.votes, reason: r.outcome.reason } })));
    const task = /^\/admin\/ai\/task\/([0-9a-f]{32})$/.exec(path);
    if (task) {
      const t = await getTask(env.DB, task[1]);
      return t ? json(taskTimings(t)) : json({ error: 'not_found' }, 404);
    }
    // T48：在 repo 用 Claude Code 討論論點（取討論包、預覽、回填）；/admin/own/*
    const ownThesis = await handleAdminThesis(request, env, fetcher, now);
    if (ownThesis) return ownThesis;
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
    const attempt = attemptOfCron(controller.cron);
    const r = await runFlow(env, realFetch, { now, attempt });
    console.log(JSON.stringify({ flow: r.session, attempt, status: r.status, processed: r.processed, created: r.created, monthly: r.monthly, alerts: r.alerts, push: r.push, error: r.error, ms: r.ms }));
  },
} satisfies ExportedHandler<Env>;
