// Worker 進入點：路由與排程。
//   /health                      不需要驗證
//   /ai/task/:id/evidence|result 雲端排程用，Bearer AI_TASK_SECRET
//   /admin/*                     管理用，Bearer ADMIN_TOKEN（Cloudflare Access 設好之前）
import { acceptResult, createTask, fireRoutine, getTask, readEvidence, sweepTimeouts, taskTimings } from './app/aiTasks';
import { bearerOk, json, type Env, type Fetcher } from './app/env';
import { probeSummary, runProbe, saveProbe } from './app/probe';

export const VERSION = '0.2.0';

const realFetch: Fetcher = (url, init) => fetch(url, init);

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
    // T4 實測：每天兩次，各跑一半
    const part = now.getUTCMinutes() < 8 ? 'A' : 'B';
    const rows = await runProbe(env, part, realFetch);
    await saveProbe(env.DB, now.toISOString(), rows);
    const timedOut = await sweepTimeouts(env.DB, now);
    console.log(JSON.stringify({ probe: part, n: rows.length, ok: rows.filter((r) => r.ok).length, timedOut }));
  },
} satisfies ExportedHandler<Env>;
