// T30：失效之後的回應與靜默期（own_thesis §1.10 乙類的回應與「靜默期」、§1.8 預覽的那個勾選、§1.6 證據包裡的回應）。
// 完成條件：
//   三種回應各一個測試（照做 FOLLOW、修正論點 REVISE、不同意 DISAGREE）
//   不同意之後同一條前提的建議不通知、不進月報；別條前提不成立照給；檔位加重照給
//   滿 45 天後的第一份 10-Q 結束靜默期；最長 100 天
//   修正論點但保留那條前提 → 進靜默期
//   月報的 SKIPPED
//   下一次審查的證據包有上次的回應與理由
// 另外：一直沒回的記 NONE；改決定收回靜默期；持股頁與討論包顯示「失效後修改第 N 次」與靜默中的前提。
// 重放驗收不變由 test/replay.test.ts 鎖住（這個任務沒有動規則引擎的參數與狀態機）。
// 對外請求全部是假的：價格、成分股（固定檔）、EDGAR、Nasdaq RSS、雲端排程、LINE。
import { describe, expect, it } from 'vitest';
import type { EvidencePack } from '../src/ai/check';
import { finalizeRun, getRun, listRuns } from '../src/app/aiRuns';
import type { Env, Fetcher } from '../src/app/env';
import { runFlow, type Attempt } from '../src/app/flow';
import { LINE_PUSH_URL } from '../src/app/line';
import { loadAccount, saveAccount, thesisLogStmt } from '../src/app/ledgerStore';
import { startOwnReview } from '../src/app/ownAi';
import { breakLogs, noneResponses, thesisFile, thesisNote } from '../src/app/thesis';
import type { CompanyFacts, XbrlFact } from '../src/data/edgar';
import { buildMarketView } from '../src/data/marketView';
import { loadSeries } from '../src/data/store';
import {
  DISPUTE_MAX_DAYS,
  KEPT_REASON,
  SKIPPED_REASON,
  addDispute,
  applySnapshot,
  breakNotice,
  createAccount,
  endDisputes,
  monthlyReport,
  priceOf,
  reopen,
  respond,
  routeReview,
  silenced,
  type Account,
  type MarketView,
  type Notif,
  notifName,
} from '../src/engine';
import { handle } from '../src/index';
import { freshDb } from './helpers/d1';
import { cronTime, fakeFetcher, newWorld, type World } from './helpers/fakeSources';

// ---------------------------------------------------------------- 假的 EDGAR、世界（和 t29a 相同的做法）

function quarterFacts(qs: { end: string; rev: number; filed: string }[]): CompanyFacts {
  const rev: XbrlFact[] = [];
  for (const q of qs) {
    const [y, m] = q.end.split('-').map(Number);
    rev.push({ start: `${y}-${String(m - 2).padStart(2, '0')}-01`, end: q.end, val: q.rev, accn: `acc-${q.filed}`, form: '10-Q', filed: q.filed });
  }
  return { cik: 1045810, facts: { 'us-gaap': { Revenues: { units: { USD: rev } } } } };
}
const BASE = quarterFacts([
  { end: '2025-06-30', rev: 110, filed: '2025-08-01' },
  { end: '2025-09-30', rev: 120, filed: '2025-11-01' },
  { end: '2026-06-30', rev: 150, filed: '2026-08-01' },
  { end: '2026-09-30', rev: 160, filed: '2026-10-30' },
]);

interface FakeFiling {
  accession: string;
  form: string;
  items: string;
  acceptanceDateTime: string;
  filingDate: string;
  primaryDocument: string;
  html: string;
}
interface Edgar {
  filings: FakeFiling[];
  facts: CompanyFacts;
  line: string[];
}

function fetcherOf(w: World, e: Edgar): Fetcher {
  const base = fakeFetcher(w);
  return async (url, init) => {
    if (url === LINE_PUSH_URL) {
      e.line.push((JSON.parse(String(init?.body)) as { messages: { text: string }[] }).messages[0].text);
      return Response.json({});
    }
    if (url === 'https://api.example/fire') return Response.json({ claude_code_session_url: 'https://claude.ai/code/x' });
    if (/data\.sec\.gov\/submissions\/CIK\d+\.json/.test(url)) {
      const fs = [...e.filings].sort((a, b) => b.acceptanceDateTime.localeCompare(a.acceptanceDateTime));
      return Response.json({ cik: '1045810', name: 'NVIDIA CORP', tickers: ['NVDA'], filings: { recent: { accessionNumber: fs.map((f) => f.accession), form: fs.map((f) => f.form), items: fs.map((f) => f.items), acceptanceDateTime: fs.map((f) => f.acceptanceDateTime), filingDate: fs.map((f) => f.filingDate), primaryDocument: fs.map((f) => f.primaryDocument) } } });
    }
    if (/companyfacts\/CIK\d+\.json/.test(url)) return Response.json(e.facts);
    const doc = /Archives\/edgar\/data\/\d+\/(\d+)\/(.+)$/.exec(url);
    if (doc) {
      const f = e.filings.find((x) => x.accession.replace(/-/g, '') === doc[1]);
      if (!f) return new Response('nf', { status: 404 });
      if (doc[2] === 'index.json') return Response.json({ directory: { item: [{ name: f.primaryDocument }] } });
      return new Response(f.html);
    }
    if (url.startsWith('https://www.nasdaq.com/feed/rssoutbound')) return new Response('<rss><channel></channel></rss>');
    return base(url, init);
  };
}

const TENQ = `<html><body><p>Item 2. Management’s Discussion and Analysis of Financial Condition and Results of Operations</p><p>Revenue for the third quarter was $160 million, up 33% from a year ago. Gross margin was 60.0%, down from 70.0% a year ago.</p><p>Item 3. Quantitative and Qualitative Disclosures About Market Risk</p></body></html>`;
const TENQ_FILING: FakeFiling = { accession: '0001045810-26-000300', form: '10-Q', items: '', acceptanceDateTime: '2026-10-30T20:10:00.000Z', filingDate: '2026-10-30', primaryDocument: 'q.htm', html: TENQ };
const NEW_10Q: FakeFiling = { accession: '0001045810-26-000330', form: '10-Q', items: '', acceptanceDateTime: '2026-11-23T21:00:00.000Z', filingDate: '2026-11-23', primaryDocument: 'q2.htm', html: TENQ };
const Q_FILING = 'Gross margin was 60.0%, down from 70.0% a year ago';
const Q_REV = 'Revenue for the third quarter was $160 million, up 33% from a year ago';

type Api = <T = Record<string, unknown>>(method: 'GET' | 'POST', path: string, body?: unknown, now?: Date) => Promise<{ status: number; body: T }>;
interface Ctx {
  db: D1Database;
  w: World;
  e: Edgar;
  env: Env;
  fetcher: Fetcher;
  run: (date: string, attempt?: Attempt) => ReturnType<typeof runFlow>;
  viewAt: (date: string) => Promise<{ view: MarketView; axis: string[] }>;
  api: Api;
}

const PREMISES = [
  { id: 'P1', text: '資料中心需求延續到 2027', origin: 'USER' as const },
  { id: 'P2', text: '毛利率維持在 65% 以上', origin: 'USER' as const },
];

async function withWorld(fn: (c: Ctx) => Promise<void>) {
  const d = await freshDb();
  try {
    const db = d.db;
    const w = newWorld('2026-11-19');
    const e: Edgar = { filings: [TENQ_FILING], facts: BASE, line: [] };
    const env: Env = { DB: db, ADMIN_TOKEN: 't', AI_TASK_SECRET: 's', EDGAR_USER_AGENT: 'test bot test@example.com', SITE_URL: 'https://bot.example', LINE_CHANNEL_TOKEN: 'lt', LINE_USER_ID: 'U1', ROUTINE_FIRE_URL: 'https://api.example/fire', ROUTINE_TOKEN: 'rt', DEV_NO_AUTH: '1' };
    const fetcher = fetcherOf(w, e);
    const run = (date: string, attempt: Attempt = 'FIRST') => {
      w.dataDate = date;
      return runFlow(env, fetcher, { now: attempt === 'FINAL' ? new Date(Date.parse(date + 'T23:30:00Z') + 2 * 3600_000) : cronTime(date), attempt });
    };
    const viewAt = async (date: string) => buildMarketView(await loadSeries(db, ['VOO', 'SGOV', 'NVDA']), date, 'VOO');
    const api: Api = async (method, path, body, now = new Date('2026-11-20T02:00:00Z')) => {
      const r = await handle(new Request(`https://bot.example/api/${path}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env, fetcher, now);
      return { status: r.status, body: (await r.json()) as never };
    };
    await run('2026-11-19');
    const { view } = await viewAt('2026-11-19');
    const acct = createAccount(
      {
        paper: true,
        cash: 5000,
        core: { VOO: Math.floor(140_000 / view.close.VOO[view.i]) },
        own: { NVDA: { shares: Math.floor(40_000 / view.close.NVDA[view.i]), stdWeight: 0.15, premises: structuredClone(PREMISES) } },
      },
      view,
    );
    await saveAccount(db, acct, null, '建立帳戶', new Date('2026-11-19T12:00:00Z'));
    await fn({ db, w, e, env, fetcher, run, viewAt, api });
  } finally {
    await d.dispose();
  }
}

const FILE = 'NVDA@2026-11-19';
const logRows = async (db: D1Database, kind: string) => (await db.prepare('SELECT * FROM own_thesis_log WHERE kind = ? ORDER BY id').bind(kind).all<{ ref: string; session: string; body: string; file_id: string }>()).results.map((r) => ({ ...r, body: JSON.parse(r.body) as Record<string, unknown> }));
const acctNow = async (db: D1Database) => (await loadAccount(db))!.acct;
const notifOf = (a: Account, id: number) => a.notifs.find((n) => n.id === id)!;

/** 存一則乙類的當天通知（和每日流程一樣寫 BREAK_NOTICE）；回傳通知。 */
async function seedBreak(c: Ctx, tier: 'HALF' | 'EXIT' = 'HALF', premiseId = 'P2'): Promise<Notif> {
  const loaded = (await loadAccount(c.db))!;
  const { view } = await c.viewAt('2026-11-19');
  const b = breakNotice(loaded.acct, view, 'NVDA', { tier, premiseId, basis: '10-Q 2026-10-30', runIds: ['rev-1'] });
  const at = new Date('2026-11-19T13:00:00Z');
  await saveAccount(c.db, b.acct, loaded, '測試：乙類', at, breakLogs(b.acct, [b.notif!]).map((l) => thesisLogStmt(c.db, l, null, at.toISOString())));
  return b.notif!;
}

/** 一票：verdict 與每條前提（都引用 10-Q）。 */
function vote(pack: EvidencePack, doc: { source_id: string; date: string }, verdict: string, premises: [string, string][]) {
  return {
    run_id: pack.run_id,
    verdict,
    model: 'claude-opus-5-5',
    premise_checks: premises.map(([id, status]) => ({ premise_id: id, status, evidence_ids: [id === 'P1' ? 'E1' : 'E2'] })),
    evidence: [
      { id: 'E1', source_id: doc.source_id, date: doc.date, quote: Q_REV, claim: '營收' },
      { id: 'E2', source_id: doc.source_id, date: doc.date, quote: Q_FILING, claim: '毛利率 60%' },
    ],
    payload: { tier: verdict, condition_checks: [], proposed_conditions: [] },
    report: '毛利率跌破前提寫的 65%。',
  };
}
async function postResult(db: D1Database, runId: string, samples: unknown[], at: Date) {
  const run = (await getRun(db, runId))!;
  const task = await db.prepare('SELECT * FROM ai_tasks WHERE id = ?').bind(run.taskId).first();
  return finalizeRun(db, task as never, { samples }, at);
}

/** 整條流程：新的 10-Q → 財報後的審查（11-23）三票減半 → 第二次排程當天通知乙類。回傳審查的 run_id 與通知。 */
async function breakByFlow(c: Ctx): Promise<{ runId: string; n: Notif }> {
  await c.run('2026-11-20'); // 第一次看 EDGAR，只記下最新的申報
  c.e.filings.push(NEW_10Q);
  await c.run('2026-11-23');
  const r1 = (await listRuns(c.db, new Date('2026-11-24T00:00:00Z'))).find((r) => r.fn === 'OWN_REVIEW')!;
  const doc = r1.pack.documents.find((d) => d.kind === 'filing' && d.text.includes(Q_FILING))!;
  const v = vote(r1.pack, doc, 'HALF', [
    ['P1', 'HOLDS'],
    ['P2', 'BROKEN'],
  ]);
  await postResult(c.db, r1.runId, [v, v, v], new Date('2026-11-24T00:10:00Z'));
  await c.run('2026-11-23', 'FINAL');
  const n = (await acctNow(c.db)).notifs.find((x) => x.kind === 'URGENT' && x.items.some((i) => i.brk?.type === 'B'))!;
  return { runId: r1.runId, n };
}

// ---------------------------------------------------------------- 三種回應

describe('T30：乙類的三種回應', () => {
  it('照做（FOLLOW）：照 AI 減半 → log 記 FOLLOW、不進靜默期，填快照後慢規則進減半；照 AI 出清 → 填快照後論點檔結案（CLOSE：EXIT_AI）', async () => {
    await withWorld(async (c) => {
      // 減半
      const n = await seedBreak(c, 'HALF');
      const key = n.items[0].key;
      const r = await c.api('POST', `notif/${n.id}/respond`, { mode: 'DO', choices: { [key]: 'AI' } });
      expect(r).toMatchObject({ status: 200, body: { status: 'RESPONDED' } });
      expect((await logRows(c.db, 'RESPONSE')).map((l) => l.body)).toEqual([{ notif: n.id, type: 'B', outcome: 'FOLLOW', reason: null, premiseId: 'P2' }]);
      const loaded = (await loadAccount(c.db))!;
      expect(loaded.acct.own.NVDA.disputes ?? []).toEqual([]);
      const { view } = await c.viewAt('2026-11-19');
      const sh = loaded.acct.lots.own.NVDA;
      const half = notifOf(loaded.acct, n.id).items[0].choices.find((x) => x.id === 'AI')!.lines[0].shares;
      const lots = { own: { NVDA: sh + half }, mom: {}, core: { ...loaded.acct.lots.core } };
      const s = applySnapshot(loaded.acct, view, { shares: { ...lots.core, NVDA: sh + half }, lots, cash: loaded.acct.cash - half * priceOf(view, 'NVDA') });
      expect(s.completed).toContain(n.id);
      expect(s.acct.rule.own.NVDA.applied).toBe('HALF');
      expect(s.acct.own.NVDA.slow.state).toBe('HALF');
    });
    await withWorld(async (c) => {
      // 出清 → 填快照（賣光）→ 論點檔結案
      const n = await seedBreak(c, 'EXIT');
      await c.api('POST', `notif/${n.id}/respond`, { mode: 'DO', choices: { [n.items[0].key]: 'AI' } });
      expect((await logRows(c.db, 'RESPONSE')).map((l) => l.body.outcome)).toEqual(['FOLLOW']);
      const loaded = (await loadAccount(c.db))!;
      const { view } = await c.viewAt('2026-11-19');
      const lots = { own: { NVDA: 0 }, mom: {}, core: { ...loaded.acct.lots.core } };
      const s = applySnapshot(loaded.acct, view, { shares: { ...lots.core }, lots, cash: loaded.acct.cash + loaded.acct.lots.own.NVDA * priceOf(view, 'NVDA') });
      expect(s.acct.own.NVDA).toBeUndefined();
      await saveAccount(c.db, s.acct, loaded, '快照', new Date('2026-11-20T03:00:00Z'));
      expect((await logRows(c.db, 'CLOSE')).map((l) => [l.file_id, l.body.reason])).toEqual([[FILE, 'EXIT_AI']]);
    });
  });

  it('不同意（DISAGREE）：沒寫理由送不出去；寫了 → 通知結案、那條前提進靜默期（100 天）、log 記 DISAGREE 與理由；持股頁那條前提顯示靜默中', async () => {
    await withWorld(async (c) => {
      const n = await seedBreak(c, 'HALF');
      const key = n.items[0].key;
      expect((await c.api('POST', `notif/${n.id}/respond`, { mode: 'DO' })).status).toBe(422); // 預設不動，但當天的乙類要寫理由
      const ok = await c.api('POST', `notif/${n.id}/respond`, { mode: 'DO', reasons: { [key]: '毛利率下滑是一次性的' } });
      expect(ok).toMatchObject({ status: 200, body: { status: 'SKIPPED' } });
      const a = await acctNow(c.db);
      const day = a.notifs.find((x) => x.id === n.id)!.respondedAt!;
      expect(a.own.NVDA.disputes).toEqual([{ premiseId: 'P2', since: day, until: new Date(Date.parse(day) + DISPUTE_MAX_DAYS * 86400_000).toISOString().slice(0, 10), reason: '毛利率下滑是一次性的', notif: n.id }]);
      expect((await logRows(c.db, 'RESPONSE')).map((l) => l.body)).toEqual([{ notif: n.id, type: 'B', outcome: 'DISAGREE', reason: '毛利率下滑是一次性的', premiseId: 'P2' }]);
      const h = await c.api<{ own: { premises: { id: string; silenced: string | null }[] } }>('GET', 'holding/NVDA');
      expect(h.body.own.premises.find((p) => p.id === 'P2')!.silenced).toContain(`靜默中，到 ${a.own.NVDA.disputes![0].until}`);
      expect(h.body.own.premises.find((p) => p.id === 'P2')!.silenced).toContain('毛利率下滑是一次性的');
      expect(h.body.own.premises.find((p) => p.id === 'P1')!.silenced).toBeNull();
    });
  });

  it('修正論點（REVISE）：編輯論點頁勾「這是對通知 #N 的回應」、拿掉那條前提 → 通知結案、afterBreak 加 1 並記日期、log 記 REVISE、不進靜默期；持股頁與討論包顯示「失效後修改第 1 次」；再回應一次 → 409', async () => {
    await withWorld(async (c) => {
      const n = await seedBreak(c, 'HALF');
      // 持股頁：這檔有還沒回覆的乙類（編輯論點頁的勾選預設勾著）
      expect((await c.api<{ own: { pendingBreak: unknown } }>('GET', 'holding/NVDA')).body.own.pendingBreak).toEqual({ notif: n.id, tier: 'HALF', premiseId: 'P2' });
      const body = { ticker: 'NVDA', thesis: 'AI 需求延續；毛利率會因為新產品線短暫下滑，看營業利益率。', premises: [{ id: 'P1', text: '資料中心需求延續到 2027' }, { text: '營業利益率維持在 50% 以上' }], exitConditions: [], source: 'DISCUSSION', replyTo: n.id };
      // 試算（dry）不結案
      expect((await c.api('POST', 'ops/own-thesis', { ...body, dry: true })).status).toBe(200);
      expect(notifOf(await acctNow(c.db), n.id).status).toBe('PENDING');
      const r = await c.api<{ revised: unknown }>('POST', 'ops/own-thesis', body);
      expect(r.status).toBe(200);
      expect(r.body.revised).toEqual({ notif: n.id, kept: false, premiseId: 'P2' });
      const a = await acctNow(c.db);
      const nn = notifOf(a, n.id);
      expect(nn.status).toBe('DONE');
      expect(nn.preview!.lines).toEqual([]); // 結案的通知不會列出要下的單（核心也不吸收現金）
      expect(nn.items[0]).toMatchObject({ cancelled: true, revised: a.own.NVDA.thesis!.setAt });
      expect(nn.items[0].note).toContain('修正了論點（失效後修改第 1 次），部位不動');
      expect(a.own.NVDA.thesis).toMatchObject({ afterBreak: 1, lastAfterBreakAt: a.own.NVDA.thesis!.setAt, version: 1 });
      expect(a.own.NVDA.disputes ?? []).toEqual([]);
      expect((await logRows(c.db, 'THESIS')).map((l) => l.body)).toMatchObject([{ afterBreak: true, replyTo: n.id, retired: ['P2'] }]);
      expect((await logRows(c.db, 'RESPONSE')).map((l) => l.body)).toEqual([{ notif: n.id, type: 'B', outcome: 'REVISE', reason: null, premiseId: 'P2' }]);
      const shadow = (await c.db.prepare("SELECT body FROM shadow_records WHERE f = 'F24'").all<{ body: string }>()).results.map((x) => JSON.parse(x.body) as { choice: string; note: string; notif: number });
      expect(shadow).toMatchObject([{ choice: 'SKIP', note: '修正論點', notif: n.id }]);
      // 持股頁：失效後修改第 1 次；沒有還沒回覆的乙類了
      const h = await c.api<{ own: { thesis: { afterBreak: number }; pendingBreak: unknown } }>('GET', 'holding/NVDA');
      expect(h.body.own.thesis.afterBreak).toBe(1);
      expect(h.body.own.pendingBreak).toBeNull();
      // 討論包
      const d = await c.api<{ text: string }>('GET', 'own/NVDA/discussion');
      expect(d.body.text).toContain('失效後修改第 1 次');
      // 已經結案的通知再回應 → 409，論點不動
      const again = await c.api<{ error: string }>('POST', 'ops/own-thesis', { ...body, thesis: '再改一次' });
      expect(again.status).toBe(409);
      expect(again.body.error).toContain(`${notifName(n)}已經回覆過了`);
      expect((await acctNow(c.db)).own.NVDA.thesis!.version).toBe(1);
      // 不是乙類的通知（例如還沒回覆的慢規則通知）→ 409：慢規則通知不能用修正論點結案（§3.4）
      const l2 = (await loadAccount(c.db))!;
      const a2 = structuredClone(l2.acct);
      a2.notifs.push({ id: 900, kind: 'URGENT', date: '2026-11-19', seq: 0, title: 'NVDA 慢規則減半', status: 'PENDING', coreAbsorb: true, reminded: false, items: [{ key: 'k1', f: 'F7', kind: 'OWN_RULE', ticker: 'NVDA', title: 'NVDA 慢規則減半', choices: [{ id: 'RULE', label: '照規則', lines: [] }], choice: 'RULE', ruleChoice: 'RULE' }] } as Notif);
      await saveAccount(c.db, a2, l2, '測試', new Date('2026-11-19T14:00:00Z'));
      const other = await c.api<{ error: string }>('POST', 'ops/own-thesis', { ...body, replyTo: 900 });
      expect(other.status).toBe(409);
      expect(other.body.error).toContain('不是 NVDA 的「AI 判斷前提不成立」通知');
    });
  });

  // T46（2026-11-17 使用者同意改）：原本這一個測試用的是「同一個 id、字改了」（加「（看全年）」），那時也當成不同意；
  // 現在只有原封不動留著（只改標點或空白算沒改）才當成不同意，字改了的在下一個測試。
  it('修正論點但原封不動保留那條前提（同一個 id、字沒改，只多了標點與空白）→ 當成不同意：通知結案、那條前提進靜默期、log 記 DISAGREE「修正論點但保留這條前提」，afterBreak 照樣加 1', async () => {
    await withWorld(async (c) => {
      const n = await seedBreak(c, 'HALF');
      const r = await c.api<{ revised: unknown; preview: { edited: unknown[] } }>('POST', 'ops/own-thesis', { ticker: 'NVDA', thesis: '論點補充', premises: [{ id: 'P1', text: '資料中心需求延續到 2027' }, { id: 'P2', text: '毛利率 維持在 65% 以上。' }], exitConditions: [], replyTo: n.id });
      expect(r.body.preview.edited).toEqual([]);
      expect(r.body.revised).toEqual({ notif: n.id, kept: true, premiseId: 'P2' });
      const a = await acctNow(c.db);
      expect(notifOf(a, n.id).status).toBe('DONE');
      expect(notifOf(a, n.id).items[0].note).toContain('新的論點還留著前提 P2，當成不同意：這條前提進靜默期');
      expect(a.own.NVDA.thesis!.afterBreak).toBe(1);
      expect(a.own.NVDA.disputes).toMatchObject([{ premiseId: 'P2', reason: KEPT_REASON, notif: n.id }]);
      expect((await logRows(c.db, 'RESPONSE')).map((l) => l.body)).toEqual([{ notif: n.id, type: 'B', outcome: 'DISAGREE', reason: KEPT_REASON, premiseId: 'P2' }]);
      // 靜默期內：同一條前提再被判不成立 → 只放網站
      const { view } = await c.viewAt('2026-11-19');
      expect(routeReview(a, view, 'NVDA', { tier: 'HALF', suggest: true, consensus: true, premiseId: 'P2', trigger: 'EARNINGS', date: '2026-12-10' }).route).toBe('SILENT');
    });
  });

  it('T46 修正論點、被判不成立的那條前提沿用編號但字改了 → 照修正論點（REVISE）：通知結案、不進靜默期、隔天審新的字；新的字再被判不成立時照常給（不是只放網站）', async () => {
    await withWorld(async (c) => {
      const n = await seedBreak(c, 'HALF');
      const body = { ticker: 'NVDA', thesis: '論點補充', premises: [{ id: 'P1', text: '資料中心需求延續到 2027' }, { id: 'P2', text: '毛利率維持在 65% 以上（看全年）' }], exitConditions: [], replyTo: n.id };
      // 預覽：P2 是「沿用，但字改了」
      const dry = await c.api<{ preview: { edited: { id: string }[]; kept: { id: string }[] } }>('POST', 'ops/own-thesis', { ...body, dry: true });
      expect(dry.body.preview.edited.map((e) => e.id)).toEqual(['P2']);
      expect(dry.body.preview.kept.map((e) => e.id)).toEqual(['P1', 'P2']);
      const r = await c.api<{ revised: unknown; preview: { edited: { id: string }[] } }>('POST', 'ops/own-thesis', body);
      expect(r.status).toBe(200);
      expect(r.body.revised).toEqual({ notif: n.id, kept: false, premiseId: 'P2' });
      expect(r.body.preview.edited.map((e) => e.id)).toEqual(['P2']);
      const a = await acctNow(c.db);
      const nn = notifOf(a, n.id);
      expect(nn.status).toBe('DONE');
      expect(nn.items[0]).toMatchObject({ cancelled: true });
      expect(nn.items[0].note).toContain('修正了論點（失效後修改第 1 次），部位不動。前提 P2 的字改了：不進靜默期');
      expect(nn.items[0].note).not.toContain('當成不同意');
      // 編號沿用、字是新的；沒有靜默期；隔天開論點變動後的審查
      expect(a.own.NVDA.premises.find((p) => p.id === 'P2')!.text).toBe('毛利率維持在 65% 以上（看全年）');
      expect(a.own.NVDA.thesis!.afterBreak).toBe(1);
      expect(a.own.NVDA.disputes ?? []).toEqual([]);
      expect(a.own.NVDA.thesisReviewDue).toBe(a.own.NVDA.thesis!.setAt);
      expect((await logRows(c.db, 'RESPONSE')).map((l) => l.body)).toEqual([{ notif: n.id, type: 'B', outcome: 'REVISE', reason: null, premiseId: 'P2' }]);
      const shadow = (await c.db.prepare("SELECT body FROM shadow_records WHERE f = 'F24'").all<{ body: string }>()).results.map((x) => JSON.parse(x.body) as { choice: string; note: string; notif: number });
      expect(shadow).toMatchObject([{ choice: 'SKIP', note: '修正論點', notif: n.id }]);
      // 新的字再被 3 票判不成立：不是 SILENT（30 天內發過 AI 的當天通知 → 進月報；超過 30 天 → 當天通知）
      const { view } = await c.viewAt('2026-11-19');
      const again = { tier: 'HALF' as const, suggest: true, consensus: true, premiseId: 'P2' };
      expect(routeReview(a, view, 'NVDA', { ...again, trigger: 'THESIS', date: '2026-11-20' }).route).not.toBe('SILENT');
      expect(routeReview(a, view, 'NVDA', { ...again, trigger: 'EARNINGS', date: '2027-01-15' }).route).toBe('SAME_DAY');
    });
  });

  it('月報裡的乙類：沒動它（沒按照 AI、沒寫理由）→ SKIPPED 並進靜默期；寫了理由 → DISAGREE；改決定收回那筆靜默期', async () => {
    await withWorld(async (c) => {
      const loaded = (await loadAccount(c.db))!;
      const { view } = await c.viewAt('2026-11-19');
      const a0 = structuredClone(loaded.acct);
      a0.own.NVDA.aiTier = { tier: 'HALF', date: '2026-11-18', suggest: true, runId: 'rev-m', premiseId: 'P2', trigger: 'MONTHLY', basis: '10-Q 2026-10-30' };
      const m = monthlyReport(a0, view, { order: [], month: '2026-12' });
      const it = m.notif.items.find((i) => i.brk?.type === 'B')!;
      expect(it.reasonRequired).toBeUndefined();
      await saveAccount(c.db, m.acct, loaded, '月報', new Date('2026-11-19T13:00:00Z'));
      const r = await c.api('POST', `notif/${m.notif.id}/respond`, { mode: 'DO' });
      expect(r.status).toBe(200);
      const a = await acctNow(c.db);
      expect(a.own.NVDA.disputes).toMatchObject([{ premiseId: 'P2', reason: SKIPPED_REASON, notif: m.notif.id }]);
      expect((await logRows(c.db, 'RESPONSE')).map((l) => l.body)).toEqual([{ notif: m.notif.id, type: 'B', outcome: 'SKIPPED', reason: null, premiseId: 'P2' }]);
      // 下一份月報不再列這條前提的建議
      const a1 = structuredClone(a);
      a1.own.NVDA.aiTier = { tier: 'HALF', date: '2026-12-20', suggest: true, premiseId: 'P2', trigger: 'MONTHLY' };
      expect(monthlyReport(a1, view, { order: [], month: '2027-01' }).notif.items.some((i) => i.brk?.type === 'B')).toBe(false);

      // 寫了理由 → DISAGREE（純函式）
      const w = respond(m.acct, view, m.notif.id, { mode: 'DO', reasons: { [it.key]: '下一季就會回來' } });
      expect(w.own.NVDA.disputes).toMatchObject([{ premiseId: 'P2', reason: '下一季就會回來' }]);
    });
  });

  it('改決定（退回等你決定）：回覆時「不同意」寫的靜默期一起收回；修正論點寫的不動', async () => {
    await withWorld(async (c) => {
      const loaded = (await loadAccount(c.db))!;
      const { view } = await c.viewAt('2026-11-19');
      const b = breakNotice(loaded.acct, view, 'NVDA', { tier: 'HALF', premiseId: 'P2' });
      // 同一則再加一項要下單的（讓回覆之後是「等你下單」，才能改決定）
      const n = notifOf(b.acct, b.notif!.id);
      n.items.push({ key: 'extra', f: 'F8', kind: 'OWN_RULE', ticker: 'NVDA', title: 'NVDA 加回', choices: [{ id: 'RULE', label: '照規則', lines: [{ ticker: 'NVDA', bucket: 'own', shares: 1, reason: '自選訊號' }] }, { id: 'SKIP', label: '這次不做', lines: [] }], choice: 'RULE', ruleChoice: 'RULE' });
      const r = respond(b.acct, view, n.id, { mode: 'DO', reasons: { [n.items[0].key]: '不同意' } });
      expect(notifOf(r, n.id).status).toBe('RESPONDED');
      expect(r.own.NVDA.disputes).toHaveLength(1);
      const back = reopen(r, view, n.id);
      expect(back.ok).toBe(true);
      expect(back.acct.own.NVDA.disputes).toEqual([]);
      // 別則通知寫的不動
      const other = structuredClone(r);
      other.own.NVDA.disputes = [...other.own.NVDA.disputes!, { premiseId: 'P1', since: '2026-11-01', until: '2027-02-09', reason: '修正論點但保留這條前提', notif: 77 }];
      expect(reopen(other, view, n.id).acct.own.NVDA.disputes!.map((d) => d.premiseId)).toEqual(['P1']);
    });
  });
});

// ---------------------------------------------------------------- 靜默期

describe('T30：靜默期', () => {
  it('不同意之後：同一條前提的建議不通知、不進月報；別條前提不成立照給；檔位加重（減半 → 出清）照給', async () => {
    await withWorld(async (c) => {
      const n = await seedBreak(c, 'HALF');
      await c.api('POST', `notif/${n.id}/respond`, { mode: 'DO', reasons: { [n.items[0].key]: '一次性' } });
      const a = await acctNow(c.db);
      a.own.NVDA.aiNotifiedAt = null; // 不讓 30 天上限干擾
      const { view } = await c.viewAt('2026-11-19');
      const base = { suggest: true, consensus: true, trigger: 'EARNINGS' as const, date: '2026-12-10' };
      // 同一條前提、同樣減半 → 只放網站；記著的建議也不進月報
      const same = routeReview(a, view, 'NVDA', { ...base, tier: 'HALF', premiseId: 'P2' });
      expect(same.route).toBe('SILENT');
      expect(same.acct.own.NVDA.aiTier).toMatchObject({ suggest: false });
      expect(monthlyReport(same.acct, view, { order: [], month: '2027-01' }).notif.items.some((i) => i.f === 'F24')).toBe(false);
      // 月審也一樣
      const mo = routeReview(a, view, 'NVDA', { ...base, tier: 'HALF', premiseId: 'P2', trigger: 'MONTHLY' });
      expect(mo.route).toBe('SILENT');
      expect(monthlyReport(mo.acct, view, { order: [], month: '2027-01' }).notif.items.some((i) => i.f === 'F24')).toBe(false);
      // 別條前提 → 當天通知
      const other = routeReview(a, view, 'NVDA', { ...base, tier: 'HALF', premiseId: 'P1' });
      expect(other.route).toBe('SAME_DAY');
      expect(other.notif!.items[0].brk).toEqual({ type: 'B', premiseId: 'P1' });
      // 檔位加重 → 當天通知
      const heavier = routeReview(a, view, 'NVDA', { ...base, tier: 'EXIT', premiseId: 'P2' });
      expect(heavier.route).toBe('SAME_DAY');
      expect(heavier.notif!.items[0].choices[0].tier).toBe('EXIT');
    });
  });

  it('最長 100 天：第 100 天還在靜默期，第 101 天結束；同一條前提再進一次，換成新的那一筆（過期的留著）', () => {
    const meta = { premises: [], disputes: [] } as unknown as Account['own'][string];
    addDispute(meta, 'P2', '2026-11-19', '一次性', 5);
    expect(meta.disputes).toEqual([{ premiseId: 'P2', since: '2026-11-19', until: '2027-02-27', reason: '一次性', notif: 5 }]);
    const acct = { own: { NVDA: meta }, notifs: [] } as unknown as Account;
    expect(silenced(acct, 'NVDA', 'P2', '2027-02-27', 'HALF')).toBe(true);
    expect(silenced(acct, 'NVDA', 'P2', '2027-02-28', 'HALF')).toBe(false);
    // 還在靜默中又不同意一次 → 換成新的；已經過期的留著
    meta.disputes!.push({ premiseId: 'P1', since: '2026-01-01', until: '2026-04-11', reason: '舊的', notif: 1 });
    addDispute(meta, 'P2', '2026-12-01', '又不同意', 9);
    expect(meta.disputes!.map((d) => [d.premiseId, d.since, d.until])).toEqual([
      ['P1', '2026-01-01', '2026-04-11'],
      ['P2', '2026-12-01', '2027-03-11'],
    ]);
  });

  it('滿 45 天之後的第一份財報類申報（10-Q、10-K、8-K 2.02）結束靜默期，到那份申報的前一天；45 天內的、修正版、其他 8-K 不算', () => {
    const acct = { own: { NVDA: { disputes: [{ premiseId: 'P2', since: '2026-11-19', until: '2027-02-27', reason: 'x', notif: 3 }] } } } as unknown as Account;
    // 45 天內的 10-Q（同一季後來才補上的）、修正版、別的 8-K → 不動
    expect(endDisputes(acct, 'NVDA', [{ form: '10-Q', items: [], filingDate: '2027-01-02' }]).ended).toEqual([]);
    expect(endDisputes(acct, 'NVDA', [{ form: '10-Q/A', items: [], filingDate: '2027-01-20' }]).ended).toEqual([]);
    expect(endDisputes(acct, 'NVDA', [{ form: '8-K', items: ['5.02'], filingDate: '2027-01-20' }]).ended).toEqual([]);
    expect(endDisputes(acct, 'NVDA', [{ form: '8-K', items: ['2.02'], filingDate: '2027-01-02' }]).acct).toBe(acct);
    // 滿 45 天（01-03）的 8-K 2.02 → 到 01-02
    const r = endDisputes(acct, 'NVDA', [{ form: '8-K', items: ['2.02', '9.01'], filingDate: '2027-01-03' }]);
    expect(r.ended).toEqual([{ premiseId: 'P2', until: '2027-01-02' }]);
    expect(r.acct.own.NVDA.disputes![0].until).toBe('2027-01-02');
    expect(acct.own.NVDA.disputes![0].until).toBe('2027-02-27'); // 純函式
    // 同一批有兩份：取第一份；已經結束的不再動
    const r2 = endDisputes(acct, 'NVDA', [{ form: '10-K', items: [], filingDate: '2027-02-20' }, { form: '10-Q', items: [], filingDate: '2027-02-10' }]);
    expect(r2.acct.own.NVDA.disputes![0].until).toBe('2027-02-09');
    expect(endDisputes(r2.acct, 'NVDA', [{ form: '10-K', items: [], filingDate: '2027-02-20' }]).ended).toEqual([]);
  });

  it('每日流程看到新的 10-Q、距不同意滿 45 天 → 靜默期到前一天結束；同一天的審查建議照給', async () => {
    await withWorld(async (c) => {
      await c.run('2026-11-20'); // 第一次看 EDGAR，只記下最新的申報
      const loaded = (await loadAccount(c.db))!;
      const a = structuredClone(loaded.acct);
      a.own.NVDA.disputes = [{ premiseId: 'P2', since: '2026-10-01', until: '2027-01-09', reason: '一次性', notif: null }];
      await saveAccount(c.db, a, loaded, '測試：靜默中', new Date('2026-11-20T12:00:00Z'));
      c.e.filings.push(NEW_10Q);
      const r = await c.run('2026-11-23');
      const after = await acctNow(c.db);
      expect(after.own.NVDA.disputes).toEqual([{ premiseId: 'P2', since: '2026-10-01', until: '2026-11-22', reason: '一次性', notif: null }]);
      expect(JSON.stringify(r)).not.toContain('"ERROR"');
      expect(silenced(after, 'NVDA', 'P2', '2026-11-23', 'HALF')).toBe(false);
      const { view } = await c.viewAt('2026-11-23');
      expect(routeReview(after, view, 'NVDA', { tier: 'HALF', suggest: true, consensus: true, premiseId: 'P2', trigger: 'EARNINGS', date: '2026-11-23' }).route).toBe('SAME_DAY');
    });
  });
});

// ---------------------------------------------------------------- 下一次審查的證據包（§1.6）

describe('T30：下一次審查的證據包有上次的回應與理由', () => {
  it('不同意的回應與理由、靜默中的前提寫在論點那一份 note', async () => {
    await withWorld(async (c) => {
      const { runId, n } = await breakByFlow(c);
      const key = n.items[0].key;
      const ok = await c.api('POST', `notif/${n.id}/respond`, { mode: 'DO', reasons: { [key]: '毛利率下滑是一次性的' } }, new Date('2026-11-24T02:00:00Z'));
      expect(ok.status).toBe(200);
      const acct = await acctNow(c.db);
      const { view, axis } = await c.viewAt('2026-11-23');
      const r2 = await startOwnReview(c.env, c.fetcher, acct, view, axis, 'NVDA', 'MANUAL', new Date('2026-11-24T03:00:00Z'));
      const note = r2.pack.documents.find((d) => d.source_id === `thesis:${FILE}`)!;
      expect(note.text).toContain(runId);
      expect(note.text).toContain('你的回應：不同意（毛利率下滑是一次性的）');
      expect(note.text).toContain('靜默中的前提');
      expect(note.text).toMatch(/- P2 到 \d{4}-\d{2}-\d{2}（\d{4}-\d{2}-\d{2} 起）：毛利率下滑是一次性的/);
    });
  });

  it('一直沒回（提醒過）→ 下一次審查開始時記 NONE，證據包寫「上次的失效通知沒有回應」；之後才回覆的以回覆為準、不重複記', async () => {
    await withWorld(async (c) => {
      const { n } = await breakByFlow(c);
      const { view, axis } = await c.viewAt('2026-11-23');
      // 還沒提醒（發出不到 2 個交易日）→ 不記
      const fresh = await acctNow(c.db);
      const tf0 = (await thesisFile(c.db, fresh, 'NVDA', view.date))!;
      expect(noneResponses(fresh, tf0, view.date)).toEqual([]);
      // 2 個交易日後提醒
      await c.run('2026-11-24');
      await c.run('2026-11-25');
      const acct = await acctNow(c.db);
      expect(notifOf(acct, n.id)).toMatchObject({ status: 'PENDING', reminded: true });
      const v25 = await c.viewAt('2026-11-25');
      const r2 = await startOwnReview(c.env, c.fetcher, acct, v25.view, v25.axis, 'NVDA', 'MANUAL', new Date('2026-11-26T03:00:00Z'));
      const note = r2.pack.documents.find((d) => d.source_id === `thesis:${FILE}`)!;
      expect(note.text).toContain('你的回應：上次的失效通知沒有回應');
      expect((await logRows(c.db, 'RESPONSE')).map((l) => l.body)).toEqual([{ notif: n.id, type: 'B', outcome: 'NONE', reason: null, premiseId: 'P2' }]);
      // 再開一次審查不重複記
      await startOwnReview(c.env, c.fetcher, acct, v25.view, v25.axis, 'NVDA', 'MANUAL', new Date('2026-11-26T04:00:00Z'));
      expect(await logRows(c.db, 'RESPONSE')).toHaveLength(1);
      // 之後才回覆 → 論點檔以回覆為準
      await c.api('POST', `notif/${n.id}/respond`, { mode: 'DO', reasons: { [n.items[0].key]: '晚了但不同意' } }, new Date('2026-11-26T05:00:00Z'));
      const tf = (await thesisFile(c.db, await acctNow(c.db), 'NVDA', '2026-11-25'))!;
      const rv = tf.reviews.find((x) => x.notif === n.id)!;
      expect(rv.response).toEqual({ outcome: 'DISAGREE', reason: '晚了但不同意', type: 'B' });
      expect(thesisNote(tf, '2026-11-25')!.text).toContain('你的回應：不同意（晚了但不同意）');
      void axis;
    });
  });
});
