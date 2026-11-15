// T38 第 2 項：用假的 AI 回覆把三次排程（23:30、01:30、03:30）與一次月報整個跑一遍，確認沒有丟錯。
// 假市場（fakeSources）、假的雲端排程與 LINE；EDGAR、FRED 等沒有假資料的來源一律回 404（流程要能當成抓不到、照常走完）。
// AI 回覆：每一個開出來的執行都照它自己的 policy 回「棄權」那個 verdict（格式合格、沒有證據），票數照 policy。
import { describe, expect, it } from 'vitest';
import { listRuns } from '../src/app/aiRuns';
import type { Env, Fetcher } from '../src/app/env';
import { runFlow, type FlowResult } from '../src/app/flow';
import { LINE_PUSH_URL } from '../src/app/line';
import { loadAccount, saveAccount } from '../src/app/ledgerStore';
import type { Attempt } from '../src/app/schedule';
import { isTradingDay, addDays } from '../src/data/calendar';
import { buildMarketView } from '../src/data/marketView';
import { loadSeries } from '../src/data/store';
import { createAccount } from '../src/engine';
import { handle } from '../src/index';
import { freshDb } from './helpers/d1';
import { fakeFetcher, newWorld } from './helpers/fakeSources';

const slotTime = (date: string, attempt: Attempt) => new Date(Date.parse(date + 'T23:30:00Z') + ({ FIRST: 0, MANUAL: 0, FINAL: 2, APPLY: 4 }[attempt]) * 3600_000);

describe('T38：三次排程與月報整個跑一遍（假的 AI 回覆）', () => {
  it('11-19 到 12-02 每個交易日跑 23:30、01:30、03:30，跨過 11 月底的月報：流程不丟錯、沒有 ERROR、AI 回覆都收下、月報有出', async () => {
    const d = await freshDb();
    try {
      const db = d.db;
      const w = newWorld('2026-11-19');
      const line: string[] = [];
      const fired: string[] = [];
      const unknown = new Set<string>();
      const base = fakeFetcher(w);
      const fetcher: Fetcher = async (url, init) => {
        if (url === LINE_PUSH_URL) {
          line.push((JSON.parse(String(init?.body)) as { messages: { text: string }[] }).messages[0].text);
          return Response.json({});
        }
        if (url === 'https://api.example/fire') {
          fired.push(String(init?.body));
          return Response.json({ claude_code_session_url: 'https://claude.ai/code/x' });
        }
        try {
          return await base(url, init);
        } catch {
          unknown.add(url.replace(/\?.*$/, '').replace(/\d{4,}/g, 'N'));
          return new Response('not found', { status: 404 });
        }
      };
      const env: Env = { DB: db, ADMIN_TOKEN: 't', AI_TASK_SECRET: 's', EDGAR_USER_AGENT: 'test bot test@example.com', SITE_URL: 'https://bot.example', LINE_CHANNEL_TOKEN: 'lt', LINE_USER_ID: 'U1', ROUTINE_FIRE_URL: 'https://api.example/fire', ROUTINE_TOKEN: 'rt' };
      const results: FlowResult[] = [];
      const run = async (date: string, attempt: Attempt) => {
        w.dataDate = date;
        const r = await runFlow(env, fetcher, { now: slotTime(date, attempt), attempt });
        results.push(r);
        return r;
      };
      const statuses: number[] = [];
      const answer = async (at: Date) => {
        const runs = (await listRuns(db, at, { limit: 500 })).filter((r) => r.status === 'PENDING' && r.taskId);
        for (const r of runs) {
          const pol = r.pack.policy;
          const samples = Array.from({ length: pol.samples }, () => ({ run_id: r.runId, verdict: pol.abstain, evidence: [], payload: {} }));
          const res = await handle(new Request(`https://bot.example/ai/task/${r.taskId}/result`, { method: 'POST', headers: { Authorization: 'Bearer s' }, body: JSON.stringify({ task_id: r.taskId, kind: 'RUN', run_id: r.runId, samples }) }), env, async () => new Response('no net', { status: 599 }), at);
          statuses.push(res.status);
        }
        return runs.length;
      };

      await run('2026-11-19', 'FIRST');
      const { view } = buildMarketView(await loadSeries(db, ['VOO', 'SGOV', 'NVDA', 'MU']), '2026-11-19', 'VOO');
      const acct = createAccount(
        {
          paper: true,
          cash: 5000,
          core: { VOO: Math.floor(120_000 / view.close.VOO[view.i]) },
          own: {
            NVDA: { shares: Math.floor(30_000 / view.close.NVDA[view.i]), stdWeight: 0.12, premises: [{ id: 'P1', text: '資料中心需求延續到 2027', origin: 'USER' }] },
            MU: { shares: Math.floor(15_000 / view.close.MU[view.i]), stdWeight: 0.06 },
          },
        },
        view,
      );
      await saveAccount(db, acct, null, '建立帳戶', new Date('2026-11-19T12:00:00Z'));

      let answered = 0;
      for (let day = '2026-11-19'; day <= '2026-12-02'; day = addDays(day, 1)) {
        if (!isTradingDay(day)) continue;
        if (day !== '2026-11-19') await run(day, 'FIRST');
        answered += await answer(new Date(slotTime(day, 'FIRST').getTime() + 40 * 60_000));
        await run(day, 'FINAL');
        answered += await answer(new Date(slotTime(day, 'FINAL').getTime() + 40 * 60_000));
        await run(day, 'APPLY');
      }

      expect(results.filter((r) => r.status === 'ERROR')).toEqual([]);
      expect(results.some((r) => r.monthly !== null)).toBe(true);
      expect(answered).toBeGreaterThan(0);
      expect(statuses.filter((s) => s !== 200)).toEqual([]);
      expect(results.flatMap((r) => r.push.errors)).toEqual([]);
      const after = await loadAccount(db);
      expect(after?.acct.notifs.some((n) => n.kind === 'MONTHLY')).toBe(true);
      // 給主持者看的摘要（不是斷言）：告警種類、開了哪些 AI、沒有假資料的來源
      const alerts = [...new Set(results.flatMap((r) => r.alerts))];
      const fns = (await listRuns(db, new Date('2026-12-04T00:00:00Z'), { limit: 500 })).map((r) => `${r.fn}:${r.outcome?.status ?? r.status}`);
      console.log(JSON.stringify({ runs: results.length, statuses: results.map((r) => `${r.session}/${r.attempt}/${r.status}`), alerts, fns: [...new Set(fns)], answered, fired: fired.length, line: line.length, unknown: [...unknown] }, null, 1));
    } finally {
      await d.dispose();
    }
  }, 300_000);
});
