// T33b：崩盤規則檢視的排程、顯示與影子（core_ai_design_2026-11-15 §5 的 T33b 那一列；§3.1～§3.5、§3.12）。
// 整條流程用假的價格（helpers/fakeSources）、假的雲端排程、假的 LINE、可以設定哪些序列抓不到的假 FRED。
// 方向看假價格的 VOO 是漲是跌：漲 → 帳戶設成啟動中（月報解除，F6）；跌 → 未啟動（月報啟動，F5）。
import { describe, expect, it } from 'vitest';
import { macroDashboard, dashboardText, isStale, macroQuality } from '../src/ai/crash';
import { finalizeRun, getRun, listRuns } from '../src/app/aiRuns';
import { crashFailText, crashReviewFor, macroMissingText, macroMonthOf } from '../src/app/crashAi';
import type { Env, Fetcher } from '../src/app/env';
import { runFlow, type Attempt } from '../src/app/flow';
import { loadAccount, saveAccount } from '../src/app/ledgerStore';
import { LINE_PUSH_URL, notifText } from '../src/app/line';
import { buildOpsReport, crashSection } from '../src/app/opsReport';
import { crashFollowUpText, crashWaiter, PUSH_WAITERS } from '../src/app/pushHold';
import { crashReviewText, explainItem } from '../src/app/site/explain';
import { crashLogView, crashPreviewUnused } from '../src/app/site/views';
import { buildMarketView } from '../src/data/marketView';
import { loadSeries } from '../src/data/store';
import type { FredSeries } from '../src/data/fred';
import { clone, createAccount, monthlyReport, newNotif, respond, type Account, type CrashReviewInfo, type Item, type Notif, type ShadowRecord } from '../src/engine';
import { handle } from '../src/index';
import { freshDb } from './helpers/d1';
import { cronTime, fakeFetcher, fakeParams, newWorld, type World } from './helpers/fakeSources';
import { ranksAt } from './helpers/market';
import { scenarios } from './helpers/scenarios';
import { Sim } from './helpers/sim';

// ---------------------------------------------------------------- 假的世界

interface Sec {
  line: string[];
  /** 這幾個 FRED 序列抓不到（HTTP 500，重試也一樣）。 */
  fredDown: Set<string>;
  /** 雲端排程觸發失敗。 */
  fireDown: boolean;
}

function fetcherOf(w: World, sec: Sec): Fetcher {
  const base = fakeFetcher(w);
  return async (url, init) => {
    if (url === LINE_PUSH_URL) {
      sec.line.push((JSON.parse(String(init?.body)) as { messages: { text: string }[] }).messages[0].text);
      return Response.json({});
    }
    if (url === 'https://api.example/fire') return sec.fireDown ? new Response('down', { status: 503 }) : Response.json({ claude_code_session_url: 'https://claude.ai/code/x' });
    const sub = /data\.sec\.gov\/submissions\/CIK(\d+)\.json/.exec(url);
    if (sub) return Response.json({ cik: sub[1], name: 'SOME CORP', tickers: [], sic: '3674', formerNames: [], filings: { recent: { accessionNumber: [], form: [], items: [], acceptanceDateTime: [], filingDate: [], primaryDocument: [] } } });
    if (/companyfacts\/CIK\d+\.json/.test(url)) return Response.json({ cik: 1, facts: {} });
    if (/companyconcept\//.test(url)) return new Response('nf', { status: 404 });
    if (url.startsWith('https://www.nasdaq.com/feed/rssoutbound')) return new Response('<rss><channel></channel></rss>');
    const fred = /fredgraph\.csv\?id=([A-Z0-9]+)/.exec(url);
    if (fred) return sec.fredDown.has(fred[1]) ? new Response('down', { status: 500 }) : new Response(`observation_date,X\n2000-10-02,1.0\n2026-05-01,1.2\n${w.dataDate},1.5\n`);
    if (url.startsWith('https://mba.tuck.dartmouth.edu/')) return new Response('nf', { status: 404 });
    return base(url, init);
  };
}

interface Ctx {
  db: D1Database;
  w: World;
  sec: Sec;
  env: Env;
  run: (date: string, attempt?: Attempt) => ReturnType<typeof runFlow>;
  acct: () => Promise<Account>;
  api: (method: 'GET' | 'POST', path: string, body: unknown, now: Date) => Promise<{ status: number; body: Record<string, unknown> }>;
}

const HOURS: Record<Attempt, number> = { FIRST: 0, FINAL: 2, APPLY: 4, MANUAL: 0 };
/** 假價格的 VOO 在漲：帳戶從啟動中開始，月報是解除（F6）。 */
const UP = fakeParams('VOO').g > 0;
const F = UP ? 'F6' : 'F5';
const DIR = UP ? 'OFF' : 'ON';
const MOM = 'AAPL';

async function withWorld(fn: (c: Ctx) => Promise<void>) {
  const d = await freshDb();
  try {
    const db = d.db;
    const w = newWorld('2026-11-19');
    const sec: Sec = { line: [], fredDown: new Set(), fireDown: false };
    const env: Env = { DB: db, ADMIN_TOKEN: 't', AI_TASK_SECRET: 's', EDGAR_USER_AGENT: 'test bot test@example.com', SITE_URL: 'https://bot.example', LINE_CHANNEL_TOKEN: 'lt', LINE_USER_ID: 'U1', DEV_NO_AUTH: '1', ROUTINE_FIRE_URL: 'https://api.example/fire', ROUTINE_TOKEN: 'rt' };
    const fetcher = fetcherOf(w, sec);
    const run = (date: string, attempt: Attempt = 'FIRST') => {
      w.dataDate = date;
      return runFlow(env, fetcher, { now: new Date(cronTime(date).getTime() + HOURS[attempt] * 3600_000), attempt });
    };
    await run('2026-11-19');
    const { view } = buildMarketView(await loadSeries(db, ['VOO', 'SGOV', MOM]), '2026-11-19', 'VOO');
    const acct = createAccount(
      {
        paper: true,
        cash: 5000,
        crash: UP,
        // 啟動中的帳戶有短債（解除時換回來）
        core: { VOO: Math.floor((UP ? 70_000 : 140_000) / view.close.VOO[view.i]), ...(UP ? { SGOV: Math.floor(70_000 / view.close.SGOV[view.i]) } : {}) },
        mom: { [MOM]: Math.floor(10_000 / view.close[MOM][view.i]) },
      },
      view,
    );
    await saveAccount(db, acct, null, '建立帳戶', new Date('2026-11-19T12:00:00Z'));
    const api: Ctx['api'] = async (method, path, body, now) => {
      const r = await handle(new Request(`https://bot.example/api/${path}`, method === 'GET' ? {} : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env, fetcher, now);
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    };
    await fn({ db, w, sec, env, run, acct: async () => (await loadAccount(db))!.acct, api });
  } finally {
    await d.dispose();
  }
}

const crashRuns = async (db: D1Database) =>
  (await listRuns(db, new Date('2026-11-01T00:00:00Z'), { limit: 500 })).filter((r) => r.fn === 'CRASH_REVIEW' && (r.pack.rule.detail as { direction?: string }).direction !== 'NONE').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
async function postResult(db: D1Database, runId: string, samples: unknown[], at: Date) {
  const run = (await getRun(db, runId))!;
  const task = await db.prepare('SELECT * FROM ai_tasks WHERE id = ?').bind(run.taskId).first();
  return finalizeRun(db, task as never, { samples }, at);
}
const votes = (runId: string, ...vs: ('FOLLOW' | 'DELAY')[]) => vs.map((v) => ({ run_id: runId, verdict: v, evidence: [], payload: { direction: DIR, opinion: v }, report: '過去 17 次中 3 次是真空頭。' }));
const monthlyOf = (a: Account): Notif => [...a.notifs].reverse().find((n) => n.kind === 'MONTHLY')!;
const crashItem = (a: Account): Item => monthlyOf(a).items.find((i) => i.f === F)!;
const monthlyTexts = (sec: Sec) => sec.line.filter((t) => t.includes('【月報】'));
const alertsOf = async (db: D1Database, kind: string) => (await db.prepare('SELECT message FROM alerts WHERE kind = ? ORDER BY id').bind(kind).all<{ message: string }>()).results.map((r) => r.message);
const shadowOf = async (db: D1Database) => (await db.prepare("SELECT body FROM shadow_records WHERE f IN ('F5', 'F6') ORDER BY id").all<{ body: string }>()).results.map((r) => JSON.parse(r.body) as ShadowRecord);
/** 月報前一天（11-27）的流程不跑：11-30 一次補做兩天 → 沒有預估的檢視，月報之後補開（MAKEUP）。 */
async function unpredicted(run: Ctx['run']) {
  for (const d of ['2026-11-20', '2026-11-23', '2026-11-24', '2026-11-25']) await run(d);
  return run('2026-11-30');
}
const at = (iso: string) => new Date(iso);

// ---------------------------------------------------------------- 整條流程（§3.1、§3.2）

describe('T33b：沒預估到的切換 → 月報等到 01:30 才推（§3.2）', () => {
  it('月報 23:30 補開檢視、不推；01:30 帶著「AI 檢視：延後」推；回覆後影子每一檔都有紀錄、延後時 ai 是 0', async () => {
    await withWorld(async ({ db, sec, run, acct, api }) => {
      const r = await unpredicted(run);
      expect(r.processed).toEqual(['2026-11-27', '2026-11-30']);
      const [cr] = await crashRuns(db);
      expect(cr.pack.rule.detail).toMatchObject({ direction: DIR, month: '2026-12', kind: 'MAKEUP', basis: '2026-11-30', try: 1 });
      let a = await acct();
      expect(crashItem(a).crashReview).toMatchObject({ state: 'PENDING', runId: cr.runId, kind: 'MAKEUP' });
      expect(r.push.held).toEqual([monthlyOf(a).id]);
      expect(monthlyTexts(sec)).toEqual([]);
      // 結果在 01:30 之前回來
      await postResult(db, cr.runId, votes(cr.pack.run_id, 'DELAY', 'DELAY', 'DELAY'), at('2026-12-01T00:10:00Z'));
      await run('2026-11-30', 'FINAL');
      a = await acct();
      const it = crashItem(a);
      expect(it.crashReview).toMatchObject({ state: 'OPINION', opinion: '延後', votes: '3 票一致', told: true });
      expect(it.aiLine).toBe('AI 檢視：延後');
      expect(it.runIds).toEqual([cr.runId]);
      expect(monthlyOf(a).runIds).toContain(cr.runId);
      const texts = monthlyTexts(sec);
      expect(texts).toHaveLength(1);
      expect(texts[0]).toContain('AI 檢視：延後');
      // 網站：那一列、收合時的一行、理由欄先填
      const v = (await api('GET', `notif/${monthlyOf(a).id}`, null, at('2026-12-01T02:00:00Z'))).body as { items: { key: string; explain: { short: string; facts: { label: string; value: string; note?: string }[] }; reasonText: { prefill: string } | null }[] };
      const iv = v.items.find((x) => x.key === it.key)!;
      expect(iv.explain.facts.find((f) => f.label === 'AI 檢視')).toEqual({ label: 'AI 檢視', value: '延後（3 票一致）；月報之後補開的', note: 'AI 的意見只供參考並記錄，不能否決或延後這條規則。' });
      expect(iv.explain.short).toContain('AI 檢視：延後');
      expect(iv.reasonText?.prefill).toBe('照 AI 檢視：延後');
      // 照做 → 影子每一檔一筆（VOO、短債、動能），規則與實際相同，AI 延後 = 0 股
      const resp = await api('POST', `notif/${monthlyOf(a).id}/respond`, { mode: 'DO' }, at('2026-12-01T02:05:00Z'));
      expect(resp.status).toBe(200);
      const tickers = [...new Set(it.choices.find((c) => c.id === 'DO')!.lines.map((l) => l.ticker))];
      expect(tickers.length).toBeGreaterThanOrEqual(2);
      const sh = await shadowOf(db);
      expect(sh.map((s) => s.ticker).sort()).toEqual([...tickers].sort());
      for (const s of sh) {
        expect(s.rule).not.toBe(0);
        expect(s.actual).toBe(s.rule);
        expect(s.ai).toBe(0);
        expect(s.runIds).toEqual([cr.runId]);
      }
    });
  });

  it('01:30 還沒回來（第一次逾時、01:30 重開）照推、沒有那一行；03:30 回來 → 補推一行，只補一次；運作統計記一次補推', async () => {
    await withWorld(async ({ db, sec, run, acct }) => {
      await unpredicted(run);
      const [first] = await crashRuns(db);
      await run('2026-11-30', 'FINAL');
      const runs = await crashRuns(db);
      expect(runs.map((x) => (x.pack.rule.detail as { try: number }).try)).toEqual([1, 2]);
      expect((await getRun(db, first.runId))!.outcome!.status).toBe('TIMEOUT');
      let a = await acct();
      expect(crashItem(a).crashReview).toMatchObject({ state: 'PENDING', runId: runs[1].runId });
      const texts = monthlyTexts(sec);
      expect(texts).toHaveLength(1);
      expect(texts[0]).not.toContain('AI 檢視');
      await postResult(db, runs[1].runId, votes(runs[1].pack.run_id, 'DELAY', 'DELAY', 'DELAY'), at('2026-12-01T02:00:00Z'));
      await run('2026-11-30', 'APPLY');
      a = await acct();
      const m = monthlyOf(a);
      expect(crashItem(a).crashReview).toMatchObject({ state: 'OPINION', opinion: '延後', told: true });
      const follow = sec.line.filter((t) => t.includes('崩盤規則的 AI 檢視回來了'));
      expect(follow).toHaveLength(1);
      expect(follow[0].startsWith(`【紙上】${crashFollowUpText('延後', '2026-12', m.id)}\n`)).toBe(true);
      expect(follow[0]).toContain('崩盤規則的 AI 檢視回來了：延後。12 月月報 #');
      expect(follow[0]).toContain('已更新；規則的動作不變，預設仍是照做。');
      await run('2026-11-30', 'APPLY');
      expect(sec.line.filter((t) => t.includes('崩盤規則的 AI 檢視回來了'))).toHaveLength(1);
      // 運作統計：這次切換、狀態、開了 2 次、沒有結論 1 次、補推 1 次
      const rep = await buildOpsReport(db, { from: '2026-11-01', to: '2026-12-31', fromSource: 'param' }, at('2026-12-02T00:00:00Z'), [crashSection]);
      expect(rep.sections[0].rows).toEqual([
        { month: '2026-12', direction: DIR, notif: m.id, date: '2026-11-30', state: 'OPINION', kind: 'MAKEUP', runs: 2, no_conclusion: 1, followups: 1 },
        { month: '合計', direction: null, notif: null, date: null, state: null, kind: null, runs: 2, no_conclusion: 1, followups: 1, switches: 1 },
      ]);
    });
  });

  it('回覆之後才回來 → 不推 LINE、那一項標「在你決定之後才回來」、影子紀錄的 ai 從 null 補上', async () => {
    await withWorld(async ({ db, sec, run, acct, api }) => {
      await unpredicted(run);
      const [cr] = await crashRuns(db);
      let a = await acct();
      const id = monthlyOf(a).id;
      // 還在等檢視時就選了「這次不做」（要寫理由）
      const key = crashItem(a).key;
      expect((await api('POST', `notif/${id}/respond`, { mode: 'DO', choices: { [key]: 'SKIP' } }, at('2026-12-01T00:05:00Z'))).status).toBe(422);
      expect((await api('POST', `notif/${id}/respond`, { mode: 'DO', choices: { [key]: 'SKIP' }, reasons: { [key]: '想再觀察一個月' } }, at('2026-12-01T00:05:00Z'))).status).toBe(200);
      let sh = await shadowOf(db);
      expect(sh.length).toBeGreaterThanOrEqual(2);
      expect(sh.every((s) => s.ai === null && s.actual === 0 && s.note === '想再觀察一個月')).toBe(true);
      await postResult(db, cr.runId, votes(cr.pack.run_id, 'DELAY', 'DELAY', 'DELAY'), at('2026-12-01T00:10:00Z'));
      await run('2026-11-30', 'FINAL');
      a = await acct();
      const it = crashItem(a);
      expect(it.crashReview).toMatchObject({ state: 'OPINION', opinion: '延後', late: true, told: true });
      expect(crashReviewText(it.crashReview!)).toBe('延後（3 票一致）；月報之後補開的；在你決定之後才回來');
      expect(sec.line.filter((t) => t.includes('AI 檢視'))).toEqual([]);
      expect(monthlyTexts(sec)).toEqual([]);
      sh = await shadowOf(db);
      expect(sh.every((s) => s.ai === 0 && s.note === '想再觀察一個月（AI 檢視在回覆之後才回來）')).toBe(true);
      // 之後再跑一次也不再推、不再改
      await run('2026-11-30', 'APPLY');
      expect(sec.line.filter((t) => t.includes('AI 檢視'))).toEqual([]);
      expect((await shadowOf(db)).every((s) => s.note === '想再觀察一個月（AI 檢視在回覆之後才回來）')).toBe(true);
    });
  });
});

describe('T33b：沒有結論的重開與告警（§3.1）', () => {
  it('預估的檢視逾時 → 01:30 重開 → 再逾時 → 告警；月報那一項寫「2 次都沒有結論」；第 3 次也沒有 → 再告警「已經停止重試」', async () => {
    await withWorld(async ({ db, sec, run, acct }) => {
      for (const d of ['2026-11-20', '2026-11-23', '2026-11-24', '2026-11-25', '2026-11-27']) await run(d);
      expect((await crashRuns(db)).map((x) => x.pack.rule.detail)).toMatchObject([{ kind: 'PREVIEW', basis: '2026-11-27', try: 1 }]);
      await run('2026-11-27', 'FINAL');
      const two = await crashRuns(db);
      expect(two.map((x) => (x.pack.rule.detail as { try: number; kind: string }).try)).toEqual([1, 2]);
      expect(two[1].asOf).toBe('2026-11-27');
      expect(await alertsOf(db, 'CRASH_REVIEW_FAILED')).toEqual([]);
      await run('2026-11-27', 'APPLY');
      const msg2 = crashFailText(DIR, ['逾時', '逾時']);
      expect(msg2).toBe(`崩盤規則${UP ? '解除' : '啟動'}的 AI 檢視連續 2 次沒有結論（逾時、逾時）。規則照常，月報照規則出；下一次流程會再開一次。`);
      expect(await alertsOf(db, 'CRASH_REVIEW_FAILED')).toEqual([msg2]);
      expect(sec.line.some((t) => t.includes('【告警】') && t.includes(msg2))).toBe(true);
      // 月報那一天：月報產生時那一項是「2 次都沒有結論」；第 3 次補開時觸發失敗
      sec.fireDown = true;
      await run('2026-11-30');
      const a = await acct();
      const m = monthlyOf(a);
      expect(m.monthly!.input.crashReview).toMatchObject({ state: 'FAILED', fails: ['逾時', '逾時'], kind: 'PREVIEW', basis: '2026-11-27' });
      expect(crashReviewText(m.monthly!.input.crashReview!)).toBe('2 次都沒有結論（逾時、逾時）；依 11/27 收盤預估時做的');
      const three = await crashRuns(db);
      expect(three).toHaveLength(3);
      expect(three[2].pack.rule.detail).toMatchObject({ kind: 'MAKEUP', try: 3 });
      expect(crashItem(a).crashReview).toMatchObject({ state: 'FAILED', fails: ['逾時', '逾時', '沒觸發成功'] });
      expect(crashItem(a).aiLine).toBeUndefined();
      // 沒有在等的檢視：月報當場推，沒有那一行
      expect(monthlyTexts(sec)).toHaveLength(1);
      expect(monthlyTexts(sec)[0]).not.toContain('AI 檢視');
      sec.fireDown = false;
      await run('2026-11-30', 'FINAL');
      expect(await alertsOf(db, 'CRASH_REVIEW_FAILED')).toEqual([msg2, crashFailText(DIR, ['逾時', '逾時', '沒觸發成功'])]);
      expect(crashFailText(DIR, ['逾時', '逾時', '沒觸發成功']).endsWith('已經停止重試。')).toBe(true);
      expect(await crashRuns(db)).toHaveLength(3); // 不再開
    });
  });

  it('票數不一致 → 跑完了、沒有意見：那一項寫「沒有意見（照做 2、延後 1）」、LINE 沒有那一行、月報當場推', async () => {
    await withWorld(async ({ db, sec, run, acct, api }) => {
      for (const d of ['2026-11-20', '2026-11-23', '2026-11-24', '2026-11-25', '2026-11-27']) await run(d);
      const [cr] = await crashRuns(db);
      await postResult(db, cr.runId, votes(cr.pack.run_id, 'FOLLOW', 'DELAY', 'FOLLOW'), at('2026-11-28T00:10:00Z'));
      await run('2026-11-27', 'FINAL');
      const r = await run('2026-11-30');
      const a = await acct();
      const it = crashItem(a);
      expect(it.crashReview).toMatchObject({ state: 'NO_OPINION', votes: '照做 2、延後 1', runId: cr.runId, kind: 'PREVIEW', basis: '2026-11-27' });
      expect(it.aiLine).toBeUndefined();
      expect(it.runIds).toEqual([cr.runId]);
      expect(r.push.held).toBeUndefined();
      const texts = monthlyTexts(sec);
      expect(texts).toHaveLength(1);
      expect(texts[0]).not.toContain('AI 檢視');
      const v = (await api('GET', `notif/${monthlyOf(a).id}`, null, at('2026-12-01T00:00:00Z'))).body as { items: { key: string; explain: { facts: { label: string; value: string }[] }; reasonText: { prefill: string } | null }[] };
      const iv = v.items.find((x) => x.key === it.key)!;
      expect(iv.explain.facts.find((f) => f.label === 'AI 檢視')!.value).toBe('沒有意見（照做 2、延後 1）；依 11/27 收盤預估時做的');
      expect(iv.reasonText?.prefill).toBe('');
      expect(await crashRuns(db)).toHaveLength(1); // 跑完了不重開
    });
  });
});

describe('T33b：總經資料（§3.5）', () => {
  const FAIL6 = ['T10Y3M', 'ICSA', 'BAA10Y', 'BAMLH0A0HYM2', 'NFCI', 'VIXCLS'];

  it('FRED 只有 4 個可用 → 不開檢視、記下要重抓；01:30 只重抓缺的，夠了就開', async () => {
    await withWorld(async ({ db, sec, run }) => {
      for (const d of ['2026-11-20', '2026-11-23', '2026-11-24', '2026-11-25']) await run(d);
      sec.fredDown = new Set(FAIL6);
      await run('2026-11-27');
      expect(await crashRuns(db)).toEqual([]);
      expect(await db.prepare("SELECT value FROM flow_state WHERE key = 'macro:retry:2026-12'").first()).not.toBeNull();
      const snap = JSON.parse((await db.prepare("SELECT data FROM macro_snapshots WHERE month = '2026-12'").first<{ data: string }>())!.data);
      expect(snap.missing).toEqual(FAIL6);
      expect(macroQuality(snap.rows)).toBe('missing');
      sec.fredDown = new Set();
      await run('2026-11-27', 'FINAL');
      const runs = await crashRuns(db);
      expect(runs).toHaveLength(1);
      expect(runs[0].pack.rule.detail).toMatchObject({ direction: DIR, month: '2026-12', kind: 'PREVIEW', basis: '2026-11-27', try: 1 });
      expect(runs[0].pack.data_quality).toMatchObject({ macro: 'ok' });
      const after = JSON.parse((await db.prepare("SELECT data FROM macro_snapshots WHERE month = '2026-12'").first<{ data: string }>())!.data);
      expect(after.missing).toEqual([]);
      expect(after.asOf).toBe('2026-11-27');
      expect(await db.prepare("SELECT value FROM flow_state WHERE key = 'macro:retry:2026-12'").first()).toBeNull();
      expect(await alertsOf(db, 'MACRO_MISSING')).toEqual([]);
    });
  });

  it('01:30 重抓之後仍不足 → 告警一次（之後同一個月份不再推）；切換那一項寫「沒有：總經資料抓不到」、沒有任何檢視', async () => {
    await withWorld(async ({ db, sec, run, acct }) => {
      for (const d of ['2026-11-20', '2026-11-23', '2026-11-24', '2026-11-25']) await run(d);
      sec.fredDown = new Set(FAIL6);
      await run('2026-11-27');
      await run('2026-11-27', 'FINAL');
      const msg = '總經資料抓不到：FRED 的 10 個序列只有 4 個可用（缺 T10Y3M、ICSA、BAA10Y、BAMLH0A0HYM2、NFCI、VIXCLS）。崩盤規則照常；這個月如果切換，不會有 AI 檢視。可以用 POST /admin/macro 重抓。';
      expect(await alertsOf(db, 'MACRO_MISSING')).toEqual([msg]);
      expect(sec.line.some((t) => t.includes('【告警】') && t.includes(msg))).toBe(true);
      await run('2026-11-30');
      const a = await acct();
      const it = crashItem(a);
      expect(it.crashReview).toEqual({ state: 'NO_DATA' });
      expect(crashReviewText(it.crashReview!)).toBe('沒有：總經資料抓不到');
      expect(it.aiLine).toBeUndefined();
      expect(monthlyTexts(sec)).toHaveLength(1);
      expect(monthlyTexts(sec)[0]).not.toContain('AI 檢視');
      await run('2026-11-30', 'FINAL');
      await run('2026-12-01');
      await run('2026-12-01', 'FINAL');
      expect(await alertsOf(db, 'MACRO_MISSING')).toEqual([msg]);
      expect(await crashRuns(db)).toEqual([]);
      expect(crashItem(await acct()).crashReview).toEqual({ state: 'NO_DATA' });
    });
  });

  it('過期：月資料停在 80 天前算過期、70 天前不算；日資料 11 天、週資料 22 天算過期；儀表板與 AI 看的文字標出來', () => {
    const asOf = '2026-11-27';
    const minus = (d: number) => new Date(Date.parse(asOf) - d * 86400_000).toISOString().slice(0, 10);
    expect(isStale('UNRATE', minus(80), asOf)).toBe(true);
    expect(isStale('UNRATE', minus(70), asOf)).toBe(false);
    expect(isStale('T10Y3M', minus(11), asOf)).toBe(true);
    expect(isStale('T10Y3M', minus(10), asOf)).toBe(false);
    expect(isStale('ICSA', minus(22), asOf)).toBe(true);
    expect(isStale('ICSA', minus(21), asOf)).toBe(false);
    const s = (date: string): FredSeries => ({ id: 'x', dates: ['2025-01-02', date], values: [4.0, 4.1] });
    const series = new Map<string, FredSeries>([
      ['UNRATE', s(minus(80))],
      ['INDPRO', s(minus(70))],
      ['T10Y3M', s(minus(1))],
    ]);
    const rows = macroDashboard(series, asOf);
    expect(rows.find((r) => r.id === 'UNRATE')).toMatchObject({ value: 4.1, stale: true });
    expect(rows.find((r) => r.id === 'INDPRO')).toMatchObject({ stale: false });
    expect(rows.find((r) => r.id === 'T10Y3M')).toMatchObject({ stale: false });
    expect(dashboardText(rows, null, null)).toContain(`（資料停在 ${minus(80)}，不能當證據）`);
    // 可用 = 有值而且沒過期：這裡只有 2 個 → 不足
    expect(macroQuality(rows)).toBe('missing');
    expect(macroMissingText({ rows })).toContain('只有 2 個可用（缺 SAHMREALTIME、ICSA、RRSFS、BAA10Y、BAMLH0A0HYM2、NFCI、VIXCLS；過期 UNRATE）');
  });

  it('/admin/macro 的月份標籤：月報前一天與訊號日是下個月，其他日子是當月', () => {
    expect(macroMonthOf('2026-11-27', {})).toBe('2026-12');
    expect(macroMonthOf('2026-11-30', {})).toBe('2026-12');
    expect(macroMonthOf('2026-12-02', {})).toBe('2026-12');
    expect(macroMonthOf('2026-11-20', {})).toBe('2026-11');
  });
});

// ---------------------------------------------------------------- 純函式：顯示、影子、等推

describe('T33b：月報項目上的那一列（§3.3）', () => {
  it('六種狀態的文字；預估與補開、晚到的後綴；舊通知照舊（有 aiLine 才顯示）', () => {
    const t = (cr: CrashReviewInfo) => crashReviewText(cr);
    expect(t({ state: 'OPINION', opinion: '照做', votes: '3 票一致', kind: 'PREVIEW', basis: '2026-11-27' })).toBe('照做（3 票一致）；依 11/27 收盤預估時做的');
    expect(t({ state: 'NO_OPINION', votes: '3 票都是證據不足' })).toBe('沒有意見（3 票都是證據不足）');
    expect(t({ state: 'PENDING', kind: 'MAKEUP', basis: '2026-11-30' })).toBe('進行中，台灣 11:30 前更新；月報之後補開的');
    expect(t({ state: 'FAILED', fails: ['逾時', '被退回'] })).toBe('2 次都沒有結論（逾時、被退回）');
    expect(t({ state: 'FAILED', fails: ['逾時'] })).toBe('沒有結論（逾時）');
    expect(t({ state: 'NO_DATA' })).toBe('沒有：總經資料抓不到');
    expect(t({ state: 'OFF' })).toBe('沒有開');
    expect(t({ state: 'OPINION', opinion: '延後', votes: '3 票一致', kind: 'MAKEUP', basis: '2026-11-30', late: true })).toBe('延後（3 票一致）；月報之後補開的；在你決定之後才回來');

    const sc = scenarios.s3();
    const sim = new Sim(sc.market, sc.init);
    sim.runUntil('2027-01-04');
    const ctx = { acct: sim.acct, view: sim.pre, axis: [], rankOrder: [], aiNotes: [] };
    const make = (input: Record<string, unknown>) => {
      const r = monthlyReport(sim.acct, sim.pre, { order: ranksAt(sim.market, sim.d - 1), month: '2027-01', ...input });
      const it = r.notif.items.find((i) => i.f === 'F5')!;
      return { n: r.notif, it, fact: explainItem(ctx as never, r.notif, it).facts?.find((f) => f.label === 'AI 檢視') };
    };
    // 每一種狀態都有那一列；只有三票一致才有 aiLine（LINE 那一行）
    for (const [cr, line] of [
      [{ state: 'OPINION', opinion: '延後', votes: '3 票一致', runId: 'r1' }, 'AI 檢視：延後'],
      [{ state: 'NO_OPINION', votes: '照做 2、延後 1', runId: 'r1' }, undefined],
      [{ state: 'PENDING', runId: 'r1' }, undefined],
      [{ state: 'FAILED', fails: ['逾時'], runId: 'r1' }, undefined],
      [{ state: 'NO_DATA' }, undefined],
      [{ state: 'OFF' }, undefined],
    ] as [CrashReviewInfo, string | undefined][]) {
      const x = make({ crashReview: cr });
      expect(x.it.crashReview).toEqual(cr);
      expect(x.it.aiLine).toBe(line);
      expect(x.it.runIds).toEqual(cr.runId ? [cr.runId] : undefined);
      expect(x.fact?.value).toBe(crashReviewText(cr));
      expect(notifText(sim.acct, x.n, null).includes('AI 檢視')).toBe(!!line);
    }
    // 舊月報（只有 crashOpinion）照讀成三票一致
    const old = make({ crashOpinion: '照做', runIds: { crash: 'old-run' } });
    expect(old.it.aiLine).toBe('AI 檢視：照做');
    expect(old.it.runIds).toEqual(['old-run']);
    // 舊通知沒有 crashReview：有 aiLine 才顯示
    const bare = make({});
    expect(bare.it.crashReview).toBeUndefined();
    expect(bare.fact).toBeUndefined();
  });

  it('crashReviewFor：沒有任何執行時，AI 層沒設定 → 沒有開；儀表板不足 → 總經資料抓不到', async () => {
    const d = await freshDb();
    try {
      expect(await crashReviewFor(d.db, '2026-12', 'ON', { ready: false })).toEqual({ state: 'OFF' });
      expect(await crashReviewFor(d.db, '2026-12', 'ON', { ready: true })).toEqual({ state: 'OFF' });
      const rows = macroDashboard(new Map(), '2026-11-27');
      await d.db.prepare("INSERT INTO macro_snapshots (month, as_of, data, created_at) VALUES ('2026-12', '2026-11-27', ?, 'x')").bind(JSON.stringify({ month: '2026-12', asOf: '2026-11-27', rows, breadth: null, core: null, missing: [] })).run();
      expect(await crashReviewFor(d.db, '2026-12', 'ON', { ready: true })).toEqual({ state: 'NO_DATA' });
      expect(await crashReviewFor(d.db, '2026-12', 'ON', { ready: false })).toEqual({ state: 'OFF' });
    } finally {
      await d.dispose();
    }
  });
});

describe('T33b：影子紀錄（§3.4）', () => {
  /** 情境 ③：1 月崩盤規則啟動的月報，檢視狀態由參數給。 */
  function janMonthly(cr: CrashReviewInfo | undefined) {
    const sc = scenarios.s3();
    const sim = new Sim(sc.market, sc.init);
    sim.runUntil('2027-01-04');
    const r = monthlyReport(sim.acct, sim.pre, { order: ranksAt(sim.market, sim.d - 1), month: '2027-01', ...(cr ? { crashReview: cr } : {}) });
    return { sim, acct: r.acct, n: r.notif, it: r.notif.items.find((i) => i.f === 'F5')! };
  }

  it('照做：每一檔都記（VOO、短債、動能那幾檔），rule = 照做的股數；AI 照做 → ai = rule、延後 → 0、其他狀態 → null', () => {
    for (const [cr, aiOf] of [
      [{ state: 'OPINION', opinion: '照做' }, (r: number) => r],
      [{ state: 'OPINION', opinion: '延後' }, () => 0],
      [{ state: 'NO_OPINION', votes: '照做 2、延後 1' }, () => null],
      [{ state: 'FAILED', fails: ['逾時'] }, () => null],
    ] as [CrashReviewInfo, (r: number) => number | null][]) {
      const { sim, acct, n, it } = janMonthly(cr);
      const lines = it.choices.find((c) => c.id === 'DO')!.lines;
      const out = respond(acct, sim.pre, n.id, { mode: 'DO' });
      const recs = out.shadow.filter((s) => s.f === 'F5');
      const tickers = [...new Set(lines.map((l) => l.ticker))];
      expect(tickers.length).toBeGreaterThanOrEqual(3);
      expect(recs.map((s) => s.ticker).sort()).toEqual([...tickers].sort());
      for (const s of recs) {
        const rule = lines.filter((l) => l.ticker === s.ticker).reduce((a, l) => a + l.shares, 0);
        expect(s).toMatchObject({ rule, actual: rule, ai: aiOf(rule), choice: 'DO', notif: n.id });
      }
    }
  });

  it('這次不做：actual 是 0、note 是理由；重列的那一項 ai 是 null', () => {
    const { sim, acct, n, it } = janMonthly({ state: 'OPINION', opinion: '延後' });
    const out = respond(acct, sim.pre, n.id, { mode: 'DO', choices: { [it.key]: 'SKIP' }, reasons: { [it.key]: '照 AI 檢視：延後' } });
    const recs = out.shadow.filter((s) => s.f === 'F5');
    expect(recs.length).toBeGreaterThanOrEqual(3);
    for (const s of recs) expect(s).toMatchObject({ actual: 0, ai: 0, note: '照 AI 檢視：延後', choice: 'SKIP' });
    // 重列的（core_ai §3.6；不開檢視、沒有 crashReview）
    const a2 = clone(acct);
    const n2 = a2.notifs.find((x) => x.id === n.id)!;
    const it2 = n2.items.find((i) => i.f === 'F5')!;
    it2.relist = true;
    delete it2.crashReview;
    delete it2.aiLine;
    const out2 = respond(a2, sim.pre, n.id, { mode: 'DO' });
    const recs2 = out2.shadow.filter((s) => s.f === 'F5');
    expect(recs2.length).toBeGreaterThanOrEqual(2);
    expect(recs2.every((s) => s.ai === null && s.actual === s.rule)).toBe(true);
  });

  it('檢視紀錄的表：每次切換一列（同一則通知合成一列），三個金額；上方那一句', () => {
    const notifs = [
      { id: 7, kind: 'MONTHLY', monthly: { input: { month: '2027-01' } }, items: [{ f: 'F5', key: 'a', crashReview: { state: 'OPINION', opinion: '延後', votes: '3 票一致', runId: 'run-1' } }] },
      { id: 9, kind: 'MONTHLY', monthly: { input: { month: '2027-03' } }, items: [{ f: 'F6', key: 'b', crashReview: { state: 'NO_OPINION', votes: '照做 2、延後 1', runId: 'run-2' } }] },
    ] as unknown as Notif[];
    const rec = (o: Partial<ShadowRecord>): ShadowRecord => ({ date: '2027-01-04', f: 'F5', ticker: 'VOO', title: '崩盤規則啟動', rule: -10, ai: 0, actual: 0, price: 100, choice: 'SKIP', notif: 7, note: '想再看看', ...o });
    const records = [rec({}), rec({ ticker: 'SGOV', rule: 20, price: 50 }), rec({ date: '2027-03-01', f: 'F6', notif: 9, ticker: 'VOO', rule: 10, ai: null, actual: 10, choice: 'DO', note: undefined })];
    // 價格：VOO 一路漲 10%／月，SGOV 不動；時間軸每月 21 個交易日
    const axis = Array.from({ length: 200 }, (_, k) => `2027-${String(1 + Math.floor(k / 21)).padStart(2, '0')}-${String(4 + (k % 21)).padStart(2, '0')}`);
    const book = { axis, adj: (t: string, k: number) => (k < 0 || k >= axis.length ? NaN : t === 'VOO' ? 100 * Math.pow(1.1, k / 21) : 50) };
    const v = crashLogView({ notifs }, records, book);
    expect(v.head).toBe('崩盤規則切換過 2 次；AI 說延後 1 次，其中 1 次延後一個月比較好。');
    expect(v.rows.map((r) => [r.label, r.ai, r.runId, r.choice])).toEqual([
      ['2027-03 解除', '沒有意見', 'run-2', '照做'],
      ['2027-01 啟動', '延後（3 票一致）', 'run-1', '這次不做：想再看看'],
    ]);
    // 1 月：照規則賣 10 股 VOO（價格 100），1 個月後 VOO 漲 10% → 照規則比你實際少賺 100；AI 延後 = 你實際 → 0；照規則比延後 = −100
    const jan = v.rows[1].at['1m']!;
    expect(jan.rule).toBeCloseTo(-100);
    expect(jan.ai).toBeCloseTo(0);
    expect(jan.delay).toBeCloseTo(-100);
    expect(v.rows[0].at['1m']!.ai).toBeNull();
    expect(crashLogView({ notifs: [] }, [], book).head).toBe('還沒有紀錄');
  });

  it('AI 紀錄的列表：預估的檢視在訊號日沒有切換 → 標「沒有用到」；有切換、還沒有月報、補開的都不標', () => {
    const run = (detail: Record<string, string>) => ({ fn: 'CRASH_REVIEW', pack: { rule: { detail } } }) as never;
    const pv = { kind: 'PREVIEW', month: '2026-12', direction: 'ON' };
    const monthly = (items: { f: string }[]) => ({ notifs: [{ id: 3, kind: 'MONTHLY', monthly: { input: { month: '2026-12' } }, items }] }) as unknown as Account;
    expect(crashPreviewUnused(run(pv), monthly([{ f: 'F1' }]))).toBe('預估會啟動，訊號日沒有切換，沒有用到');
    expect(crashPreviewUnused(run(pv), monthly([{ f: 'F5' }]))).toBeNull();
    expect(crashPreviewUnused(run(pv), { notifs: [] } as unknown as Account)).toBeNull();
    expect(crashPreviewUnused(run({ ...pv, kind: 'MAKEUP' }), monthly([]))).toBeNull();
  });
});

describe('T33b：月報等推的判斷（pushHold 共用的那一段）', () => {
  it('PENDING 才等；推出去時有那一行的標成講過了；補推只給三票一致、還沒講過、還沒回覆的', () => {
    expect(PUSH_WAITERS).toContain(crashWaiter);
    const sc = scenarios.s3();
    const sim = new Sim(sc.market, sc.init);
    sim.runUntil('2027-01-04');
    const mk = (cr: CrashReviewInfo) => {
      const r = monthlyReport(sim.acct, sim.pre, { order: ranksAt(sim.market, sim.d - 1), month: '2027-01', crashReview: cr });
      return { a: r.acct, n: r.notif };
    };
    expect(crashWaiter.waiting(sim.acct, mk({ state: 'PENDING', runId: 'r' }).n)).toBe(true);
    for (const s of ['OPINION', 'NO_OPINION', 'FAILED', 'NO_DATA', 'OFF'] as const) expect(crashWaiter.waiting(sim.acct, mk({ state: s }).n)).toBe(false);
    const { a, n } = mk({ state: 'OPINION', opinion: '延後', runId: 'r' });
    expect(crashWaiter.followUps!(a).map((f) => f.text)).toEqual([crashFollowUpText('延後', '2027-01', n.id)]);
    expect(crashFollowUpText('延後', '2027-01', n.id)).toBe(`崩盤規則的 AI 檢視回來了：延後。1 月月報 #${n.id} 已更新；規則的動作不變，預設仍是照做。`);
    const told = clone(a);
    crashWaiter.told!(told, told.notifs.find((x) => x.id === n.id)!);
    expect(crashWaiter.followUps!(told)).toEqual([]);
    const answered = clone(a);
    answered.notifs.find((x) => x.id === n.id)!.status = 'RESPONDED';
    expect(crashWaiter.followUps!(answered)).toEqual([]);
    // 不是月報的通知不管
    const other = clone(sim.acct);
    const u = newNotif(other, sim.pre, { kind: 'URGENT', title: 'x', items: [] });
    expect(crashWaiter.waiting(other, u)).toBe(false);
  });
});
