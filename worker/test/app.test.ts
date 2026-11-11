// T4／T5（本機部分）：Worker 的端點。對外請求全部用假的 fetcher，D1 用本機模擬器。
// 還沒在 Cloudflare 上跑過；實測要等部署。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TASK_TIMEOUT_MS, createTask, sweepTimeouts } from '../src/app/aiTasks';
import type { Env, Fetcher } from '../src/app/env';
import { PROBE_CIKS, PROBE_TICKERS, probeSummary } from '../src/app/probe';
import { handle } from '../src/index';
import { freshDb } from './helpers/d1';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
let env: Env;
let dispose: () => Promise<void>;
beforeAll(async () => {
  const d = await freshDb();
  dispose = d.dispose;
  env = { DB: d.db, ADMIN_TOKEN: 'admin-secret', AI_TASK_SECRET: 'task-secret', ROUTINE_FIRE_URL: 'https://api.anthropic.com/v1/claude_code/routines/trig_test/fire', ROUTINE_TOKEN: 'routine-token' };
});
afterAll(() => dispose());

const req = (path: string, init: RequestInit & { token?: string } = {}) =>
  new Request('https://bot.example' + path, { ...init, headers: { ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}), ...(init.headers ?? {}) } });
const noNet: Fetcher = async (url) => {
  throw new Error('測試不應該連網：' + url);
};

/** 兩年份的假 Yahoo 回應。 */
function yahooBody(symbol: string) {
  const n = 500;
  const ts = Array.from({ length: n }, (_, i) => 1731335400 + i * 86400);
  const px = Array.from({ length: n }, (_, i) => 100 + i * 0.1);
  return { chart: { result: [{ meta: { symbol, currency: 'USD', gmtoffset: -18000 }, timestamp: ts, indicators: { quote: [{ open: px, high: px, low: px, close: px, volume: px.map(() => 1000) }], adjclose: [{ adjclose: px }] } }], error: null } };
}
const edgarBody = {
  cik: '1',
  name: 'X',
  tickers: [],
  filings: { recent: { accessionNumber: ['a'], form: ['8-K'], items: ['2.02'], acceptanceDateTime: ['2026-11-10T21:00:00.000Z'], filingDate: ['2026-11-10'], primaryDocument: ['x.htm'] } },
};

describe('驗證', () => {
  it('/health 不用驗證', async () => {
    expect((await handle(req('/health'), env, noNet)).status).toBe(200);
  });
  it('管理端點與 AI 端點：沒有 token、token 錯、沒設定金鑰 → 一律 401', async () => {
    const id = '0'.repeat(32);
    const cases = [
      ['/admin/probe/summary', 'admin-secret'],
      [`/ai/task/${id}/evidence`, 'task-secret'],
    ] as const;
    for (const [path, good] of cases) {
      expect((await handle(req(path), env, noNet)).status).toBe(401);
      expect((await handle(req(path, { token: 'wrong' }), env, noNet)).status).toBe(401);
      expect((await handle(req(path, { token: good.slice(0, -1) }), env, noNet)).status).toBe(401);
      expect((await handle(req(path, { token: good + 'x' }), env, noNet)).status).toBe(401);
      expect((await handle(req(path, { token: good }), { ...env, ADMIN_TOKEN: undefined, AI_TASK_SECRET: undefined }, noNet)).status).toBe(401);
    }
    // 兩把金鑰不能互用
    expect((await handle(req('/admin/probe/summary', { token: 'task-secret' }), env, noNet)).status).toBe(401);
    expect((await handle(req(`/ai/task/${id}/evidence`, { token: 'admin-secret' }), env, noNet)).status).toBe(401);
  });
});

describe('T4 資料來源實測（假的對外請求）', () => {
  const seenUa: Record<string, string> = {};
  let calls = 0;
  const fake: Fetcher = async (url, init) => {
    calls++;
    const host = new URL(url).host;
    seenUa[host] = new Headers(init?.headers).get('User-Agent') ?? '';
    if (host.includes('yahoo')) {
      const sym = decodeURIComponent(/chart\/([^?]+)/.exec(url)![1]);
      if (sym === 'TSLA') return new Response('rate limited', { status: 429 });
      return Response.json(yahooBody(sym));
    }
    if (host.includes('ssga')) return new Response(readFileSync(join(FIX, 'spy-holdings-2026-11-10.xlsx')));
    if (host.includes('wikipedia')) return new Response(readFileSync(join(FIX, 'wiki-sp500-2026-11-11.txt'), 'utf8'));
    if (host.includes('sec.gov')) return Response.json(edgarBody);
    throw new Error('沒預期的網址 ' + url);
  };

  it('A 半：SSGA、Wikipedia、名單比對、40 檔 Yahoo；每次不超過 50 個對外請求；失敗的會被記下來', async () => {
    calls = 0;
    const res = await handle(req('/admin/probe?part=A', { method: 'POST', token: 'admin-secret' }), env, fake, new Date('2026-11-12T23:05:00Z'));
    const j = (await res.json()) as { n: number; ok: number; failed: { target: string; status: number }[] };
    expect(calls).toBe(42);
    expect(j.n).toBe(43);
    expect(j.failed).toEqual([expect.objectContaining({ source: 'yahoo', target: 'TSLA', status: 429 })]);
    expect(seenUa['data.sec.gov']).toBeUndefined();
  });
  it('B 半：其餘 Yahoo；沒有設定 EDGAR 的 User-Agent 就不連 SEC', async () => {
    calls = 0;
    const res = await handle(req('/admin/probe?part=B', { method: 'POST', token: 'admin-secret' }), env, fake, new Date('2026-11-12T23:10:00Z'));
    const j = (await res.json()) as { failed: { source: string; detail: string }[] };
    expect(calls).toBe(PROBE_TICKERS.length - 40);
    expect(j.failed).toEqual([expect.objectContaining({ source: 'edgar', detail: expect.stringContaining('沒有設定') })]);
  });
  it('B 半：設定了 User-Agent 才連 SEC，而且用的是設定的值；每次不超過 50 個對外請求', async () => {
    calls = 0;
    await handle(req('/admin/probe?part=B', { method: 'POST', token: 'admin-secret' }), { ...env, EDGAR_USER_AGENT: 'configured-agent' }, fake, new Date('2026-11-13T23:10:00Z'));
    expect(calls).toBe(PROBE_TICKERS.length - 40 + PROBE_CIKS.length);
    expect(calls).toBeLessThanOrEqual(50);
    expect(seenUa['data.sec.gov']).toBe('configured-agent');
    expect(seenUa['en.wikipedia.org']).not.toContain('@');
  });
  it('彙總：每天、每個來源的成功率與耗時', async () => {
    const s = await probeSummary(env.DB);
    const row = (day: string, source: string) => s.summary.find((r) => r.day === day && r.source === source)!;
    expect(row('2026-11-12', 'yahoo')).toMatchObject({ n: 60, ok: 59 });
    expect(row('2026-11-12', 'ssga')).toMatchObject({ n: 1, ok: 1 });
    expect(row('2026-11-12', 'membership')).toMatchObject({ n: 1, ok: 1 });
    expect(row('2026-11-13', 'edgar')).toMatchObject({ n: 20, ok: 20 });
    expect(s.failures.length).toBeGreaterThan(0);
  });
});

describe('T5 AI 任務來回（假的雲端排程）', () => {
  const fired: { url: string; headers: Headers; body: string }[] = [];
  const fakeFire: Fetcher = async (url, init) => {
    fired.push({ url, headers: new Headers(init?.headers), body: String(init?.body) });
    return Response.json({ type: 'routine_fire', claude_code_session_id: 'session_x', claude_code_session_url: 'https://claude.ai/code/session_x' });
  };
  const t0 = new Date('2026-11-12T10:00:00Z');
  const at = (min: number) => new Date(t0.getTime() + min * 60_000);
  const ping = async () => ((await (await handle(req('/admin/ai/ping', { method: 'POST', token: 'admin-secret' }), env, fakeFire, t0)).json()) as { id: string }).id;
  const evidence = (id: string, when = at(1)) => handle(req(`/ai/task/${id}/evidence`, { token: 'task-secret' }), env, noNet, when);
  const post = (id: string, body: unknown, when = at(3)) =>
    handle(req(`/ai/task/${id}/result`, { method: 'POST', token: 'task-secret', body: typeof body === 'string' ? body : JSON.stringify(body) }), env, noNet, when);
  const status = async (id: string) => (await (await handle(req(`/admin/ai/task/${id}`, { token: 'admin-secret' }), env, noNet)).json()) as Record<string, unknown>;

  it('完整來回：觸發文字只帶任務編號 → 取證據包 → 送回結果 → 檢查通過；量得到每一段的時間', async () => {
    const id = await ping();
    const f = fired.at(-1)!;
    expect(f.url).toBe(env.ROUTINE_FIRE_URL);
    expect(f.headers.get('Authorization')).toBe('Bearer routine-token');
    expect(f.headers.get('anthropic-beta')).toBe('experimental-cc-routine-2026-04-01');
    expect(JSON.parse(f.body)).toEqual({ text: `task_id=${id}` });
    const ev = (await (await evidence(id)).json()) as { task_id: string; kind: string; evidence: { nonce: string } };
    expect(ev).toMatchObject({ task_id: id, kind: 'PING' });
    const res = await post(id, { task_id: id, kind: 'PING', echo: ev.evidence.nonce, model: 'claude-x', observations: { haiku_subagent: true, blocked_host_status: 403 } });
    expect(res.status).toBe(200);
    expect(await status(id)).toMatchObject({ status: 'DONE', session_url: 'https://claude.ai/code/session_x', fire_to_fetch_ms: 60_000, fetch_to_result_ms: 120_000, fire_to_result_ms: 180_000 });
  });
  it('結果只收一次；做完的任務拿不到證據包', async () => {
    const id = await ping();
    const ev = (await (await evidence(id)).json()) as { evidence: { nonce: string } };
    expect((await post(id, { task_id: id, kind: 'PING', echo: ev.evidence.nonce })).status).toBe(200);
    expect((await post(id, { task_id: id, kind: 'PING', echo: ev.evidence.nonce })).status).toBe(409);
    expect((await evidence(id)).status).toBe(410);
  });
  it('不合格的結果一律拒絕並記下原因：不是 JSON、編號不符、多了欄位、內容不對、太大', async () => {
    const cases: [unknown, string][] = [
      ['not json {', '不是合法的 JSON'],
      [[1, 2], '結果要是 JSON 物件'],
      [{ task_id: 'f'.repeat(32), kind: 'PING', echo: 'x' }, 'task_id 和網址不同'],
      [{ task_id: 'ID', kind: 'F24', echo: 'x' }, 'kind 和任務不同'],
      [{ task_id: 'ID', kind: 'PING', echo: 'wrong' }, 'echo 和證據包的 nonce 不同'],
      [{ task_id: 'ID', kind: 'PING', echo: 'NONCE', decision: 'VETO' }, '多了不認得的欄位：decision'],
      [{ task_id: 'ID', kind: 'PING', echo: 'NONCE', observations: { 'Bad Key': 1 } }, 'observations 的欄位名稱不合格'],
      [{ task_id: 'ID', kind: 'PING', echo: 'NONCE', observations: { note: 'x'.repeat(501) } }, '500 字以內'],
    ];
    for (const [body, why] of cases) {
      const id = await ping();
      const ev = (await (await evidence(id)).json()) as { evidence: { nonce: string } };
      const b = typeof body === 'string' ? body : JSON.parse(JSON.stringify(body).replaceAll('"ID"', `"${id}"`).replaceAll('NONCE', ev.evidence.nonce));
      const res = await post(id, b);
      expect(res.status, why).toBe(422);
      const st = await status(id);
      expect(st.status).toBe('REJECTED');
      expect(String(st.error)).toContain(why);
      // 被拒絕之後不能再送一次
      expect((await post(id, { task_id: id, kind: 'PING', echo: ev.evidence.nonce })).status).toBe(409);
    }
    const id = await ping();
    expect((await post(id, JSON.stringify({ task_id: id, kind: 'PING', echo: 'x', pad: 'x'.repeat(300_000) }))).status).toBe(413);
  });
  it('只能讀寫自己那個任務編號：不存在的編號 404；格式不對的路徑不透露任何資料', async () => {
    expect((await evidence('a'.repeat(32))).status).toBe(404);
    expect((await post('a'.repeat(32), {})).status).toBe(404);
    const r = await handle(req('/ai/task/short/evidence', { token: 'task-secret' }), env, noNet);
    expect(await r.text()).toBe('stock bot');
  });
  it('逾時：太晚才來取或送回 → 410；排程掃描會把沒有結果的任務標成 TIMEOUT（給缺席告警）', async () => {
    const late = new Date(t0.getTime() + TASK_TIMEOUT_MS + 1000);
    const a = await ping();
    expect((await evidence(a, late)).status).toBe(410);
    const b = await ping();
    await evidence(b);
    expect((await post(b, { task_id: b, kind: 'PING', echo: 'x' }, late)).status).toBe(410);
    expect((await status(b)).status).toBe('TIMEOUT');
    const c = await createTask(env.DB, 'PING', { nonce: 'n' }, t0);
    expect(await sweepTimeouts(env.DB, at(10))).not.toContain(c);
    expect(await sweepTimeouts(env.DB, late)).toContain(c);
    expect((await status(c)).status).toBe('TIMEOUT');
  });
  it('觸發失敗（沒設定、HTTP 錯誤、連不上）→ 記成 FIRE_FAILED，管理端點回 502', async () => {
    const r1 = await handle(req('/admin/ai/ping', { method: 'POST', token: 'admin-secret' }), { ...env, ROUTINE_TOKEN: undefined }, noNet, t0);
    expect(r1.status).toBe(502);
    const r2 = await handle(req('/admin/ai/ping', { method: 'POST', token: 'admin-secret' }), env, async () => new Response('{"error":"rate_limited"}', { status: 429 }), t0);
    const j2 = (await r2.json()) as { id: string; fired: { error: string } };
    expect(j2.fired.error).toContain('429');
    expect((await status(j2.id)).status).toBe('FIRE_FAILED');
    const r3 = await handle(req('/admin/ai/ping', { method: 'POST', token: 'admin-secret' }), env, noNet, t0);
    expect(r3.status).toBe(502);
  });
});
