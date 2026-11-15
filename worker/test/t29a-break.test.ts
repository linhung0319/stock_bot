// T29a：審查的建議與兩種失效通知（own_thesis §1.9、§1.10 的甲類與乙類、§1.6「程式怎麼用結論」第 3 點）。
// 完成條件：
//   財報後的審查三票減半、同一條前提有申報引用 → 第二次排程當天通知
//   30 天內第二次 → 進月報；月審 → 月報；月底沒有一致結論時月中的建議留著；當天通知過的不再進月報
//   三票各判不同的前提 → 沒有資格
//   你定的財報條件成立 → 當天通知、預設照當時的決定、文字有誰哪天定的
//   「這次不做」沒寫理由送不出去；同一個月兩條條件成立都通知
//   動作是重新審查 → 開審查不通知；已經減半又成立減半 → 不通知、列進清單
// 另外：靜默期（disputes）、有還沒回覆的慢規則通知與乙類時不另發、月審確認的甲類進月報、LINE 的文字、BREAK_NOTICE 與 RESPONSE。
// 重放驗收不變由 test/replay.test.ts 鎖住（這個任務沒有動規則引擎的參數與狀態機）。
// 對外請求全部是假的：價格、成分股（固定檔）、EDGAR、Nasdaq RSS、雲端排程、LINE。
import { describe, expect, it } from 'vitest';
import { judge, type EvidencePack, type PackDoc } from '../src/ai/check';
import { PAYLOAD_HOOKS } from '../src/ai/hooks';
import { OWN_REVIEW, ownReviewPack } from '../src/ai/ownReview';
import type { ApplyCtx, StartCtx } from '../src/app/aiCtx';
import { finalizeRun, getRun, listRuns, type AiRun } from '../src/app/aiRuns';
import type { Env, Fetcher } from '../src/app/env';
import { runFlow, type Attempt } from '../src/app/flow';
import { LINE_PUSH_URL, notifText } from '../src/app/line';
import { loadAccount, saveAccount } from '../src/app/ledgerStore';
import { applyOwnReview, ownXbrlConditions, startCondReviews } from '../src/app/ownAi';
import { breakLogs, condFacts, dueAttention, loadConditions, ownAttention, thesisFile } from '../src/app/thesis';
import type { CompanyFacts, QuarterRow, XbrlFact } from '../src/data/edgar';
import { buildMarketView } from '../src/data/marketView';
import { loadSeries } from '../src/data/store';
import { createAccount, missingReasons, monthlyReport, respond, routeReview, type Account, type MarketView, type Notif } from '../src/engine';
import { handle } from '../src/index';
import { freshDb } from './helpers/d1';
import { cronTime, fakeFetcher, newWorld, type World } from './helpers/fakeSources';

// ---------------------------------------------------------------- 假的 EDGAR、世界（和 t26 相同的做法）

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
const NEW_10Q: FakeFiling = { accession: '0001045810-26-000330', form: '10-Q/A', items: '', acceptanceDateTime: '2026-11-23T21:00:00.000Z', filingDate: '2026-11-23', primaryDocument: 'qa.htm', html: TENQ };

interface Ctx {
  db: D1Database;
  w: World;
  e: Edgar;
  env: Env;
  fetcher: Fetcher;
  run: (date: string, attempt?: Attempt) => ReturnType<typeof runFlow>;
  viewAt: (date: string) => Promise<{ view: MarketView; axis: string[] }>;
  api: (path: string, body: unknown) => Promise<{ status: number; body: Record<string, unknown> }>;
}

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
    const api = async (path: string, body: unknown) => {
      const r = await handle(new Request(`https://bot.example/api/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env, fetcher, new Date('2026-11-20T02:00:00Z'));
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    };
    await run('2026-11-19');
    const { view } = await viewAt('2026-11-19');
    const acct = createAccount(
      {
        paper: true,
        cash: 5000,
        core: { VOO: Math.floor(140_000 / view.close.VOO[view.i]) },
        own: {
          NVDA: {
            shares: Math.floor(40_000 / view.close.NVDA[view.i]),
            stdWeight: 0.15,
            premises: [
              { id: 'P1', text: '資料中心需求延續到 2027', origin: 'USER' },
              { id: 'P2', text: '毛利率維持在 65% 以上', origin: 'USER' },
            ],
          },
        },
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
type CondSeed = { condId?: string; kind?: 'XBRL' | 'EVENT'; status?: string; text?: string; check?: Record<string, unknown>; origin?: 'AI' | 'USER'; action?: string; acceptedAt?: string };
/** 你定的條件（預設：你寫的財報條件，11/20 定，成立時出清）；回傳列編號。 */
async function seed(db: D1Database, o: CondSeed = {}): Promise<number> {
  const r = await db
    .prepare('INSERT INTO own_conditions (ticker, run_id, cond_id, direction, kind, text, check_json, tier_if_met, status, created_at, origin, file_id, accepted_at, action, auto) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)')
    .bind('NVDA', 'r0', o.condId ?? 'U1', 'DOWN', o.kind ?? 'XBRL', o.text ?? '毛利率低於 70%', JSON.stringify(o.check ?? { type: 'xbrl_metric_below', metric: 'GrossMarginPct', level: 0.7, quarters: 1 }), null, o.status ?? 'ACTIVE', '2026-11-19T12:00:00.000Z', o.origin ?? 'USER', FILE, o.acceptedAt ?? '2026-11-20T01:00:00.000Z', o.action ?? 'EXIT')
    .run();
  return r.meta.last_row_id;
}
function qrow(end: string, gm: number): QuarterRow {
  return { end, filed: '2026-11-23', form: '10-Q', accn: 'a', revenue: 100, grossProfit: gm * 100, operatingIncome: null, netIncome: null, epsDiluted: null, cfo: null, grossMarginPct: gm, operatingMarginPct: null, netMarginPct: null, revenueYoY: null, cfoToNetIncome: null };
}
const ROWS = [qrow('2026-09-30', 0.684), qrow('2026-06-30', 0.72)];

// ---------------------------------------------------------------- 審查的票（直接組證據包、檢查、套用）

const TENQ_DOC: PackDoc = { id: 'D1', source_id: 'edgar:x', kind: 'filing', date: '2026-10-30', title: '10-Q 2026-10-30：MD&A', text: 'Revenue for the third quarter was $160 million, up 33% from a year ago. Gross margin was 60.0%, down from 70.0% a year ago.' };
const Q_FILING = 'Gross margin was 60.0%, down from 70.0% a year ago';
const Q_REV = 'Revenue for the third quarter was $160 million, up 33% from a year ago';

/** 一票：verdict 與每條前提（都引用 10-Q）。 */
function vote(pack: EvidencePack, verdict: string, premises: [string, string][]) {
  return {
    run_id: pack.run_id,
    verdict,
    premise_checks: premises.map(([id, status]) => ({ premise_id: id, status, evidence_ids: [id === 'P1' ? 'E2' : 'E1'] })),
    evidence: [
      { id: 'E1', source_id: 'edgar:x', date: '2026-10-30', quote: Q_FILING, claim: '毛利率 60%' },
      { id: 'E2', source_id: 'edgar:x', date: '2026-10-30', quote: Q_REV, claim: '營收' },
    ],
    payload: { tier: verdict, condition_checks: [], proposed_conditions: [] },
    report: '測試',
  };
}
const HALF_P2 = (pack: EvidencePack) => vote(pack, 'HALF', [['P2', 'BROKEN']]);
const EXIT_P2 = (pack: EvidencePack) => vote(pack, 'EXIT', [['P2', 'BROKEN']]);

async function reviewPack(db: D1Database, acct: Account, view: MarketView, axis: string[], trigger: 'EARNINGS' | 'MONTHLY' | 'THESIS', dataQuality: EvidencePack['data_quality'] = { filings: 'ok' }) {
  const tf = (await thesisFile(db, acct, 'NVDA', view.date))!;
  return ownReviewPack({ acct, view, axis, ticker: 'NVDA', runId: `rev-${Math.random().toString(36).slice(2, 8)}`, trigger, xbrl: null, filings: [TENQ_DOC], news: null, conds: condFacts(tf, null), dataQuality, now: new Date('2026-11-20T01:00:00Z') }).pack;
}

/** 套用一次審查（三票）。trigger：觸發原因；votes(pack) 回傳三票。 */
async function review(c: Ctx, acct: Account, trigger: 'EARNINGS' | 'MONTHLY' | 'THESIS', votes: (pack: EvidencePack) => unknown[], date = '2026-11-19', dataQuality?: EvidencePack['data_quality']): Promise<ApplyCtx> {
  const { view, axis } = await c.viewAt(date);
  const pack = await reviewPack(c.db, acct, view, axis, trigger, dataQuality);
  const outcome = judge(pack, votes(pack), PAYLOAD_HOOKS[OWN_REVIEW]);
  const ctx: ApplyCtx = { db: c.db, acct, view, axis, session: view.date, now: new Date(`${date}T23:40:00Z`), stmts: [], log: [] };
  await applyOwnReview(ctx, { runId: pack.run_id, fn: OWN_REVIEW, ticker: 'NVDA', asOf: view.date, outcome, pack } as unknown as AiRun);
  if (ctx.stmts.length) await c.db.batch(ctx.stmts);
  return ctx;
}
const three = (f: (p: EvidencePack) => unknown) => (p: EvidencePack) => [f(p), f(p), f(p)];
const urgents = (a: Account) => a.notifs.filter((n) => n.kind === 'URGENT');
const newOnes = (before: Account, after: Account) => after.notifs.filter((n) => !before.notifs.some((x) => x.id === n.id));

async function setup(c: Ctx) {
  const acct = (await loadAccount(c.db))!.acct;
  const { view, axis } = await c.viewAt('2026-11-19');
  return { acct, view, axis };
}

async function postResult(db: D1Database, runId: string, samples: unknown[], at: Date) {
  const run = (await getRun(db, runId))!;
  const task = await db.prepare('SELECT * FROM ai_tasks WHERE id = ?').bind(run.taskId).first();
  return finalizeRun(db, task as never, { samples }, at);
}
const logRows = async (db: D1Database, kind: string) => (await db.prepare('SELECT * FROM own_thesis_log WHERE kind = ? ORDER BY id').bind(kind).all<{ ref: string; session: string; body: string }>()).results.map((r) => ({ ...r, body: JSON.parse(r.body) as Record<string, unknown> }));

// ---------------------------------------------------------------- 乙類：審查的建議什麼時候給（§1.9）

describe('T29a：乙類（AI 判斷前提不成立）', () => {
  it('財報後的審查三票減半、同一條前提有申報引用 → 第二次排程當天通知；LINE 的文字；log 寫 BREAK_NOTICE', async () => {
    await withWorld(async (c) => {
      await c.run('2026-11-20'); // 第一次看 EDGAR，只記下最新的申報
      c.e.filings.push(NEW_10Q);
      await c.run('2026-11-23');
      const runs = (await listRuns(c.db, new Date('2026-11-24T00:00:00Z'))).filter((r) => r.fn === 'OWN_REVIEW');
      expect(runs).toHaveLength(1);
      const r1 = runs[0];
      expect(r1.pack.rule.detail).toMatchObject({ trigger: 'EARNINGS' });
      const doc = r1.pack.documents.find((d) => d.kind === 'filing' && d.text.includes(Q_FILING))!;
      const v = {
        run_id: r1.pack.run_id,
        verdict: 'HALF',
        model: 'claude-opus-5-5',
        premise_checks: [
          { premise_id: 'P1', status: 'HOLDS', evidence_ids: ['E1'] },
          { premise_id: 'P2', status: 'BROKEN', evidence_ids: ['E2'] },
        ],
        evidence: [
          { id: 'E1', source_id: doc.source_id, date: doc.date, quote: Q_REV, claim: '營收' },
          { id: 'E2', source_id: doc.source_id, date: doc.date, quote: Q_FILING, claim: '毛利率 60%' },
        ],
        payload: { tier: 'HALF', condition_checks: [], proposed_conditions: [] },
        report: '毛利率跌破前提寫的 65%。',
      };
      await postResult(c.db, r1.runId, [v, v, v], new Date('2026-11-24T00:10:00Z'));
      const lineBefore = c.e.line.length;
      const fin = await c.run('2026-11-23', 'FINAL');
      const acct = (await loadAccount(c.db))!.acct;
      const n = urgents(acct).find((x) => x.title === 'NVDA：AI 審查認為你的前提不成立')!;
      expect(fin.created).toContain(n.id);
      const it = n.items[0];
      const half = Math.round((acct.lots.own.NVDA ?? 0) / 2);
      expect(it).toMatchObject({ f: 'F24', kind: 'AI_ONLY', title: 'NVDA：前提「毛利率維持在 65% 以上」3 票都判不成立', aiLine: `AI 建議減半，賣 ${half} 股`, choice: 'SKIP', ruleChoice: 'SKIP', reasonRequired: true, brk: { type: 'B', premiseId: 'P2' } });
      expect(it.choices.map((x) => [x.id, x.label])).toEqual([
        ['AI', `照 AI（減半，賣 ${half} 股）`],
        ['SKIP', '不同意，不動'],
      ]);
      expect(it.why).toBe('依據：10-Q/A 2026-11-23（引用在網站）。你沒有為這件事定過出場條件，由你決定。');
      // 30 天上限的日子、當天給過的不再進月報
      expect(acct.own.NVDA.aiNotifiedAt).toBe('2026-11-23');
      expect(acct.own.NVDA.aiTier).toMatchObject({ tier: 'HALF', suggest: false, premiseId: 'P2', trigger: 'EARNINGS', basis: '10-Q/A 2026-11-23' });
      // LINE：標題、哪條前提、AI 建議（要不要做由你決定）、連結
      const pushed = c.e.line.slice(lineBefore).find((t) => t.includes('AI 審查認為你的前提不成立'))!;
      expect(pushed.split('\n')).toEqual(['【紙上】【當天】NVDA：AI 審查認為你的前提不成立', '前提「毛利率維持在 65% 以上」：3 票判不成立', `AI 建議減半，賣 ${half} 股（要不要做由你決定）`, `https://bot.example/?openExternalBrowser=1#/n/${n.id}`]);
      // 論點檔：BREAK_NOTICE（type B、當天），審查連到這則通知
      const logs = await logRows(c.db, 'BREAK_NOTICE');
      expect(logs.map((l) => l.body)).toEqual([{ type: 'B', notif: n.id, runIds: [r1.runId], conditionId: null, premiseId: 'P2', tier: 'HALF', sameDay: true }]);
      expect((await thesisFile(c.db, acct, 'NVDA'))!.reviews.find((x) => x.runId === r1.runId)!.notif).toBe(n.id);
    });
  });

  it('30 天內第二次 → 進月報；當天通知過的不再進月報；月審 → 月報（月報裡是同一種項目，不用寫理由）', async () => {
    await withWorld(async (c) => {
      const { acct, view } = await setup(c);
      const a = await review(c, acct, 'EARNINGS', three(HALF_P2));
      const first = urgents(a.acct);
      expect(first).toHaveLength(1);
      expect(a.acct.own.NVDA.aiNotifiedAt).toBe('2026-11-19');
      // 當天給過的不再進月報
      expect(monthlyReport(a.acct, view, { order: [], month: '2026-12' }).notif.items.some((i) => i.f === 'F24')).toBe(false);
      // 使用者回了（不同意、寫理由）→ 下一次財報後的審查在 30 天內 → 不另發，記著進月報
      const replied = respond(a.acct, view, first[0].id, { mode: 'DO', reasons: { [first[0].items[0].key]: '毛利率下滑是一次性的' } });
      expect(replied.notifs.find((n) => n.id === first[0].id)!.items[0].reason).toBe('毛利率下滑是一次性的');
      const b = await review(c, replied, 'EARNINGS', three(EXIT_P2));
      expect(newOnes(replied, b.acct)).toEqual([]);
      expect(b.acct.own.NVDA.aiTier).toMatchObject({ tier: 'EXIT', suggest: true });
      expect(b.log.join('\n')).toContain('30 天內');
      const m = monthlyReport(b.acct, view, { order: [], month: '2026-12' });
      const it = m.notif.items.find((i) => i.f === 'F24')!;
      expect(it).toMatchObject({ kind: 'AI_ONLY', title: 'NVDA：前提「毛利率維持在 65% 以上」3 票都判不成立', choice: 'SKIP', brk: { type: 'B', premiseId: 'P2' } });
      expect(it.reasonRequired).toBeUndefined();
      expect(m.acct.own.NVDA.aiTier!.suggest).toBe(false);
      // 月報裡的乙類 → BREAK_NOTICE 的 sameDay 是 false
      expect(breakLogs(m.acct, [m.notif])[0].body).toMatchObject({ type: 'B', sameDay: false, tier: 'EXIT' });
      // 30 天之後（12-21）：又可以當天通知
      const c2 = structuredClone(b.acct);
      c2.own.NVDA.aiTier = null;
      c2.own.NVDA.aiNotifiedAt = '2026-10-19';
      const later = routeReview(c2, view, 'NVDA', { tier: 'HALF', suggest: true, consensus: true, premiseId: 'P2', trigger: 'EARNINGS', date: '2026-11-19' });
      expect(later.route).toBe('SAME_DAY');

      // 月審：不當天通知，記著進隔天的月報
      const fresh = (await loadAccount(c.db))!.acct;
      const mo = await review(c, fresh, 'MONTHLY', three(HALF_P2));
      expect(urgents(mo.acct)).toEqual([]);
      expect(mo.acct.own.NVDA.aiTier).toMatchObject({ suggest: true, trigger: 'MONTHLY' });
      expect(monthlyReport(mo.acct, view, { order: [], month: '2026-12' }).notif.items.find((i) => i.f === 'F24')).toMatchObject({ brk: { type: 'B' } });
    });
  });

  it('月底沒有一致結論時月中的建議留著（票數不一致、資料缺漏）；之後一次有三票結論的審查才取代', async () => {
    await withWorld(async (c) => {
      const { acct, view } = await setup(c);
      // 月中：論點變動後的審查，但 30 天內發過 → 記著等月報
      acct.own.NVDA.aiNotifiedAt = '2026-11-10';
      const mid = await review(c, acct, 'THESIS', three(HALF_P2));
      expect(mid.acct.own.NVDA.aiTier).toMatchObject({ tier: 'HALF', suggest: true, trigger: 'THESIS' });
      // 月底：票數不一致 → 留著
      const split = await review(c, mid.acct, 'MONTHLY', (p) => [HALF_P2(p), HALF_P2(p), vote(p, 'HOLD', [['P2', 'HOLDS']])]);
      expect(split.acct.own.NVDA.aiTier).toEqual(mid.acct.own.NVDA.aiTier);
      // 資料缺漏 → 留著
      const dm = await review(c, split.acct, 'MONTHLY', three(EXIT_P2), '2026-11-19', { filings: 'ok', xbrl: 'missing' });
      expect(dm.acct.own.NVDA.aiTier).toEqual(mid.acct.own.NVDA.aiTier);
      expect(dm.log.join('\n')).toContain('建議留著進月報');
      expect(monthlyReport(dm.acct, view, { order: [], month: '2026-12' }).notif.items.some((i) => i.f === 'F24' && i.brk?.type === 'B')).toBe(true);
      // 三票一致選「不動」→ 取代，不再進月報
      const hold = await review(c, dm.acct, 'MONTHLY', three((p) => vote(p, 'HOLD', [['P2', 'HOLDS']])));
      expect(hold.acct.own.NVDA.aiTier).toMatchObject({ tier: 'HOLD', suggest: false });
      expect(monthlyReport(hold.acct, view, { order: [], month: '2026-12' }).notif.items.some((i) => i.f === 'F24')).toBe(false);
    });
  });

  it('三票各判不同的前提 → 沒有資格（只放網站）；回到標準只進月報', async () => {
    await withWorld(async (c) => {
      const { acct } = await setup(c);
      const mixed = await review(c, acct, 'EARNINGS', (p) => [vote(p, 'HALF', [['P1', 'BROKEN']]), HALF_P2(p), HALF_P2(p)]);
      expect(urgents(mixed.acct)).toEqual([]);
      expect(mixed.acct.own.NVDA.aiTier).toMatchObject({ tier: 'HALF', suggest: false });
      expect(mixed.acct.own.NVDA.aiTier!.premiseId).toBeUndefined();
      expect(mixed.acct.own.NVDA.aiNotifiedAt).toBeUndefined();
      expect(mixed.log.join('\n')).toContain('沒有資格');
    });
  });

  it('靜默期：同一條前提不同意之後不通知、不進月報；別條前提照給；檔位加重（減半 → 出清）照給', async () => {
    await withWorld(async (c) => {
      const { acct, view } = await setup(c);
      const first = await review(c, acct, 'EARNINGS', three(HALF_P2));
      const n = urgents(first.acct)[0];
      const disputed = respond(first.acct, view, n.id, { mode: 'DO', reasons: { [n.items[0].key]: '一次性' } });
      disputed.own.NVDA.disputes = [{ premiseId: 'P2', since: '2026-11-19', until: '2027-02-27', reason: '一次性', notif: n.id }];
      disputed.own.NVDA.aiNotifiedAt = null;
      // 同一條前提、同樣減半 → 只放網站
      const same = await review(c, disputed, 'EARNINGS', three(HALF_P2));
      expect(newOnes(disputed, same.acct)).toEqual([]);
      expect(same.acct.own.NVDA.aiTier).toMatchObject({ suggest: false });
      expect(same.log.join('\n')).toContain('靜默期');
      // 月報也不列（月審）
      const mo = await review(c, disputed, 'MONTHLY', three(HALF_P2));
      expect(monthlyReport(mo.acct, view, { order: [], month: '2026-12' }).notif.items.some((i) => i.f === 'F24')).toBe(false);
      // 別條前提不成立 → 照給
      const other = await review(c, disputed, 'EARNINGS', three((p) => vote(p, 'HALF', [['P1', 'BROKEN']])));
      expect(newOnes(disputed, other.acct).map((x) => x.items[0].brk)).toEqual([{ type: 'B', premiseId: 'P1' }]);
      // 檔位比不同意時重（減半 → 出清）→ 照給
      const heavier = await review(c, disputed, 'EARNINGS', three(EXIT_P2));
      expect(newOnes(disputed, heavier.acct).map((x) => x.items[0].choices[0].tier)).toEqual(['EXIT']);
    });
  });

  it('有還沒回覆的乙類 → 不另發，檔位變了就更新那一則；有還沒回覆的慢規則通知 → 不另發，更新那則的照 AI', async () => {
    await withWorld(async (c) => {
      const { acct, view } = await setup(c);
      const first = await review(c, acct, 'EARNINGS', three(HALF_P2));
      const n = urgents(first.acct)[0];
      first.acct.own.NVDA.aiNotifiedAt = null; // 就算 30 天上限沒擋，也不另發
      const upd = await review(c, first.acct, 'EARNINGS', three(EXIT_P2));
      expect(newOnes(first.acct, upd.acct)).toEqual([]);
      const it = upd.acct.notifs.find((x) => x.id === n.id)!.items[0];
      expect(it.key).toBe(n.items[0].key);
      expect(it.choices[0]).toMatchObject({ id: 'AI', tier: 'EXIT', label: `照 AI（出清，賣 ${upd.acct.lots.own.NVDA} 股）` });
      expect(it.runIds).toHaveLength(2);
      expect(upd.acct.own.NVDA.aiTier).toMatchObject({ tier: 'EXIT', suggest: false });
      // 慢規則的減半通知還沒回覆：審查建議出清 → 那則多一個「照 AI」，不另發
      const ruled = structuredClone(acct);
      ruled.notifs.push({ id: 900, kind: 'URGENT', date: '2026-11-19', seq: view.i, title: 'NVDA 慢規則減半', status: 'PENDING', coreAbsorb: true, reminded: false, items: [{ key: 'k1', f: 'F7', kind: 'OWN_RULE', ticker: 'NVDA', title: 'NVDA 慢規則減半', choices: [{ id: 'RULE', label: '照規則', lines: [] }, { id: 'SKIP', label: '這次不做', lines: [] }], choice: 'RULE', ruleChoice: 'RULE' }] } as Notif);
      const r = await review(c, ruled, 'EARNINGS', three(EXIT_P2));
      expect(newOnes(ruled, r.acct)).toEqual([]);
      expect(r.acct.notifs.find((x) => x.id === 900)!.items[0].choices.map((x) => x.id)).toEqual(['RULE', 'AI', 'SKIP']);
      expect(r.log.join('\n')).toContain('慢規則通知 #900');
    });
  });
});

// ---------------------------------------------------------------- 甲類：你定的條件成立（§1.10）

describe('T29a：甲類（你定的條件成立）', () => {
  it('你定的財報條件成立 → 當天通知、預設照當時的決定、文字有誰哪天定的；LINE；log 寫 BREAK_NOTICE', async () => {
    await withWorld(async (c) => {
      await c.run('2026-11-20');
      // 營收年增率低於 50%（最新一季 33%）：新的 10-Q 出來就比對
      const id = await seed(c.db, { text: '營收年增率低於 50%', check: { type: 'xbrl_metric_below', metric: 'RevenueYoY', level: 0.5, quarters: 1 }, action: 'HALF' });
      c.e.filings.push(NEW_10Q);
      const lineBefore = c.e.line.length;
      const r = await c.run('2026-11-23');
      const acct = (await loadAccount(c.db))!.acct;
      const n = urgents(acct).find((x) => x.title === 'NVDA：你定的出場條件成立')!;
      expect(r.created).toContain(n.id);
      const half = Math.round((acct.lots.own.NVDA ?? 0) / 2);
      expect(n.items[0]).toMatchObject({ f: 'F25', kind: 'OWN_COND', title: 'NVDA：你在 2026-11-20 定的條件「營收年增率低於 50%」成立', choice: 'DO', ruleChoice: 'DO', reasonRequired: true, brk: { type: 'A', conditionId: id, premiseId: null } });
      expect(n.items[0].why).toBe('最新一季營收年增率 33.3%（10-Q 2026-10-30）');
      expect(n.items[0].choices.map((x) => [x.id, x.label])).toEqual([
        ['DO', `照當時的決定：減半，賣 ${half} 股`],
        ['SKIP', '這次不做'],
      ]);
      expect((await loadConditions(c.db, 'NVDA')).find((x) => x.id === id)).toMatchObject({ status: 'MET', metBasis: 'XBRL' });
      // LINE：第二行是誰哪天定的、成立時做什麼；下單清單照現有格式（預設照當時的決定）
      const pushed = c.e.line.slice(lineBefore).find((t) => t.includes('你定的出場條件成立'))!;
      expect(pushed.split('\n').slice(0, 2)).toEqual(['【紙上】【當天】NVDA：你定的出場條件成立', '你在 11/20 定的「營收年增率低於 50%」→ 減半']);
      expect(pushed).toContain(`賣 NVDA ${half} 股 · 你定的條件`);
      expect(pushed).not.toContain('AI 建議（預設不做）');
      expect((await logRows(c.db, 'BREAK_NOTICE')).map((l) => l.body)).toEqual([{ type: 'A', notif: n.id, runIds: ['r0'], conditionId: id, premiseId: null, tier: 'HALF', sameDay: true }]);
    });
  });

  it('「這次不做」沒寫理由送不出去；寫了理由 → 記在項目、影子紀錄與論點檔的 RESPONSE；照當時的決定 → FOLLOW', async () => {
    await withWorld(async (c) => {
      const loaded = (await loadAccount(c.db))!;
      const { view, axis } = await c.viewAt('2026-11-19');
      const id = await seed(c.db);
      const ctx: ApplyCtx = { db: c.db, acct: loaded.acct, view, axis, session: view.date, now: new Date('2026-11-19T23:40:00Z'), stmts: [], log: [] };
      await ownXbrlConditions(ctx, new Map([['NVDA', ROWS]]));
      await saveAccount(c.db, ctx.acct, loaded, '測試', new Date('2026-11-19T23:41:00Z'), ctx.stmts);
      const n = urgents(ctx.acct)[0];
      const key = n.items[0].key;
      // 純函式：選了不做、沒寫理由
      expect(missingReasons(n, { mode: 'DO', choices: { [key]: 'SKIP' } }).map((i) => i.key)).toEqual([key]);
      expect(missingReasons(n, { mode: 'SKIP' })).toHaveLength(1);
      expect(missingReasons(n, { mode: 'DO' })).toEqual([]); // 預設照當時的決定，不用寫
      // 網站：沒寫理由 → 422，通知還在等你決定
      const bad = await c.api(`notif/${n.id}/respond`, { mode: 'DO', choices: { [key]: 'SKIP' } });
      expect(bad.status).toBe(422);
      expect(String(bad.body.error)).toContain('要寫一句理由');
      expect((await c.api(`notif/${n.id}/respond`, { mode: 'SKIP', reasons: { [key]: '   ' } })).status).toBe(422);
      expect((await c.api(`notif/${n.id}/respond`, { mode: 'DO', choices: { [key]: 'SKIP' }, reasons: { [key]: 'x'.repeat(201) } })).status).toBe(422);
      expect((await loadAccount(c.db))!.acct.notifs.find((x) => x.id === n.id)!.status).toBe('PENDING');
      // 寫了理由 → 送出
      const ok = await c.api(`notif/${n.id}/respond`, { mode: 'DO', choices: { [key]: 'SKIP' }, reasons: { [key]: '財報電話會議說毛利率下季回升' } });
      expect(ok).toMatchObject({ status: 200, body: { status: 'SKIPPED' } });
      const after = (await loadAccount(c.db))!.acct.notifs.find((x) => x.id === n.id)!;
      expect(after.items[0].reason).toBe('財報電話會議說毛利率下季回升');
      expect((await logRows(c.db, 'RESPONSE')).map((l) => l.body)).toEqual([{ notif: n.id, type: 'A', outcome: 'SKIPPED', reason: '財報電話會議說毛利率下季回升' }]);
      // 一次性：選了不做，這條也不會再觸發
      expect((await loadConditions(c.db, 'NVDA')).find((x) => x.id === id)!.status).toBe('MET');
      const again: ApplyCtx = { ...ctx, acct: (await loadAccount(c.db))!.acct, stmts: [], log: [] };
      await ownXbrlConditions(again, new Map([['NVDA', ROWS]]));
      expect(urgents(again.acct)).toHaveLength(1);
    });
  });

  it('同一個月兩條條件成立都通知（不設每月上限）；照當時的決定的回應是 FOLLOW', async () => {
    await withWorld(async (c) => {
      const loaded = (await loadAccount(c.db))!;
      const { view, axis } = await c.viewAt('2026-11-19');
      await seed(c.db, { condId: 'U1', text: '毛利率低於 70%', action: 'HALF' });
      const ctx: ApplyCtx = { db: c.db, acct: loaded.acct, view, axis, session: view.date, now: new Date('2026-11-19T23:40:00Z'), stmts: [], log: [] };
      await ownXbrlConditions(ctx, new Map([['NVDA', ROWS]]));
      await c.db.batch(ctx.stmts);
      // 同一個月稍後：另一條（事件條件，申報三票確認）成立
      await seed(c.db, { condId: 'U2', text: '毛利率低於 69%', check: { type: 'xbrl_metric_below', metric: 'GrossMarginPct', level: 0.69, quarters: 1 }, action: 'EXIT' });
      const ctx2: ApplyCtx = { ...ctx, session: '2026-11-27', now: new Date('2026-11-27T23:40:00Z'), stmts: [], log: [] };
      await ownXbrlConditions(ctx2, new Map([['NVDA', ROWS]]));
      const ns = urgents(ctx2.acct);
      expect(ns.map((n) => n.items[0].title)).toEqual(['NVDA：你在 2026-11-20 定的條件「毛利率低於 70%」成立', 'NVDA：你在 2026-11-20 定的條件「毛利率低於 69%」成立']);
      expect(ctx2.acct.own.NVDA.f25Sent).toEqual({}); // 每月的計數不再用
      await saveAccount(c.db, ctx2.acct, loaded, '測試', new Date('2026-11-27T23:41:00Z'));
      expect((await c.api(`notif/${ns[1].id}/respond`, { mode: 'DO' })).status).toBe(200);
      expect((await logRows(c.db, 'RESPONSE')).map((l) => l.body)).toEqual([{ notif: ns[1].id, type: 'A', outcome: 'FOLLOW', reason: null }]);
    });
  });

  it('動作是重新審查 → 不通知、開一次審查（觸發原因 CONDITION）；今天已經有審查就只清掉', async () => {
    await withWorld(async (c) => {
      const loaded = (await loadAccount(c.db))!;
      const { view, axis } = await c.viewAt('2026-11-19');
      await seed(c.db, { action: 'REVIEW' });
      const ctx: ApplyCtx = { db: c.db, acct: loaded.acct, view, axis, session: view.date, now: new Date('2026-11-19T23:40:00Z'), stmts: [], log: [] };
      await ownXbrlConditions(ctx, new Map([['NVDA', ROWS]]));
      expect(urgents(ctx.acct)).toEqual([]);
      expect(ctx.acct.own.NVDA.condReviewDue).toBe('2026-11-19');
      expect(ctx.log.join('\n')).toContain('不通知，開一次審查');
      await saveAccount(c.db, ctx.acct, loaded, '測試', new Date('2026-11-19T23:41:00Z'), ctx.stmts);
      const sc = (acct: Account): StartCtx => ({ env: c.env, fetcher: c.fetcher, acct, view, axis, session: view.date, ov: {}, now: new Date('2026-11-20T01:30:00Z'), checks: [], res: { created: [], started: [], log: [], alerts: [] }, extras: {} });
      const s1 = sc((await loadAccount(c.db))!.acct);
      await startCondReviews(s1);
      expect(s1.res.started).toHaveLength(1);
      const run = (await getRun(c.db, s1.res.started[0]))!;
      expect(run).toMatchObject({ fn: 'OWN_REVIEW', ticker: 'NVDA' });
      expect(run.pack.rule.detail).toMatchObject({ trigger: 'CONDITION' });
      expect((await loadAccount(c.db))!.acct.own.NVDA.condReviewDue).toBeNull();
      // 同一天又有一條「重新審查」成立 → 今天已經有審查，只清掉
      const again = (await loadAccount(c.db))!;
      again.acct.own.NVDA.condReviewDue = '2026-11-19';
      await saveAccount(c.db, again.acct, again, '測試', new Date('2026-11-20T01:31:00Z'));
      const s2 = sc((await loadAccount(c.db))!.acct);
      await startCondReviews(s2);
      expect(s2.res.started).toEqual([]);
      expect(s2.res.log.join('\n')).toContain('今天已經有審查');
      expect((await loadAccount(c.db))!.acct.own.NVDA.condReviewDue).toBeNull();
      // CONDITION 觸發的審查有資格 → 當天通知（§1.9）
      const r = routeReview(again.acct, view, 'NVDA', { tier: 'HALF', suggest: true, consensus: true, premiseId: 'P2', trigger: 'CONDITION', date: '2026-11-19' });
      expect(r.route).toBe('SAME_DAY');
    });
  });

  it('已經減半又成立減半 → 不通知、列進「要看的事」（成立後的第一份月報一次）', async () => {
    await withWorld(async (c) => {
      const loaded = (await loadAccount(c.db))!;
      loaded.acct.rule.own.NVDA.applied = 'HALF';
      loaded.acct.own.NVDA.slow.state = 'HALF';
      const { view, axis } = await c.viewAt('2026-11-19');
      const id = await seed(c.db, { action: 'HALF' });
      const ctx: ApplyCtx = { db: c.db, acct: loaded.acct, view, axis, session: view.date, now: new Date('2026-11-19T23:40:00Z'), stmts: [], log: [] };
      await ownXbrlConditions(ctx, new Map([['NVDA', ROWS]]));
      await c.db.batch(ctx.stmts);
      expect(urgents(ctx.acct)).toEqual([]);
      expect(ctx.log.join('\n')).toContain('不通知（換算出來不用賣（目前已經是減半））');
      expect((await loadConditions(c.db, 'NVDA')).find((x) => x.id === id)!.status).toBe('MET');
      const file = (await thesisFile(c.db, ctx.acct, 'NVDA', view.date))!;
      const hits = ownAttention([file], ctx.acct, view).filter((x) => x.kind === 'COND_MET_NO_SELL');
      expect(hits.map((x) => [x.key, x.text, x.since])).toEqual([[`COND_MET_NO_SELL:${id}`, 'NVDA：你定的條件「毛利率低於 70%」成立；目前已經是減半，不用再賣', '2026-11-19']]);
      // 月報列一次，下個月不再列
      const d1 = dueAttention(hits, {}, '2026-11-30');
      expect(d1.due).toHaveLength(1);
      expect(dueAttention(hits, d1.shown, '2026-12-31').due).toEqual([]);
      // 成立日之後有月報了 → 持股頁也不再列
      const withMonthly = structuredClone(ctx.acct);
      withMonthly.notifs.push({ id: 901, kind: 'MONTHLY', date: '2026-11-30', seq: 0, title: '2026-12 月報', items: [], status: 'PENDING', coreAbsorb: true, reminded: false });
      expect(ownAttention([file], withMonthly, view).filter((x) => x.kind === 'COND_MET_NO_SELL')).toEqual([]);
      // 對照：有發通知的（不是減半中）不列
      const told = structuredClone(file);
      told.log.push({ id: 1, kind: 'BREAK_NOTICE', session: '2026-11-19', at: '', ref: '1', body: { type: 'A', conditionId: id }, accountVersion: null });
      expect(ownAttention([told], ctx.acct, view).filter((x) => x.kind === 'COND_MET_NO_SELL')).toEqual([]);
    });
  });

  it('月審確認你定的條件成立 → 不當天通知，進隔天的月報（項目和當天通知相同）', async () => {
    await withWorld(async (c) => {
      const { acct, view } = await setup(c);
      const id = await seed(c.db, { condId: 'U1', kind: 'EVENT', status: 'REVIEW_ONLY', text: '法說會上下修財測', check: { type: 'event', confirm_by: ['earnings_call'] }, action: 'HALF' });
      const ctx = await review(c, acct, 'MONTHLY', three((p) => ({ ...vote(p, 'HOLD', [['P2', 'HOLDS']]), payload: { tier: 'HOLD', condition_checks: [{ id: 'C1', status: 'MET', evidence_ids: ['E1'] }], proposed_conditions: [] } })));
      expect(urgents(ctx.acct)).toEqual([]);
      expect(ctx.acct.own.NVDA.condMonthly).toMatchObject([{ id, action: 'HALF', setAt: '2026-11-20', why: '2026-11-19 的審查 3 票確認（引用在網站）' }]);
      const m = monthlyReport(ctx.acct, view, { order: [], month: '2026-12' });
      const it = m.notif.items.find((i) => i.kind === 'OWN_COND')!;
      expect(it).toMatchObject({ f: 'F25', title: 'NVDA：你在 2026-11-20 定的條件「法說會上下修財測」成立', choice: 'DO', brk: { type: 'A', conditionId: id } });
      expect(m.acct.own.NVDA.condMonthly).toBeUndefined();
      expect(breakLogs(m.acct, [m.notif]).find((l) => l.body.type === 'A')!.body).toMatchObject({ conditionId: id, sameDay: false });
    });
  });
});

// ---------------------------------------------------------------- LINE 的文字（純函式）

describe('T29a：LINE 與畫面的資料', () => {
  it('乙類只有標題、前提、AI 建議與連結；只有預設前提的股票標「預設前提」；甲類照清單格式', async () => {
    await withWorld(async (c) => {
      const { acct, view } = await setup(c);
      const def = structuredClone(acct);
      def.own.NVDA.premises = [{ id: 'P1', text: '財報可信、沒有硬事件', origin: 'SYSTEM_DEFAULT' }];
      const r = routeReview(def, view, 'NVDA', { tier: 'EXIT', suggest: true, consensus: true, premiseId: 'P1', trigger: 'EARLY', date: '2026-11-19', basis: '8-K 2026-11-18' });
      expect(r.route).toBe('SAME_DAY');
      const n = r.notif!;
      expect(n.title).toBe('NVDA：AI 審查認為預設前提不成立');
      expect(n.items[0].why).toBe('依據：8-K 2026-11-18（引用在網站）。你沒有為這件事定過出場條件，由你決定。這檔還沒有你的論點，檢查的是系統預設前提。');
      expect(notifText(r.acct, n, 'https://x/#/n/1').split('\n')).toEqual(['【紙上】【當天】NVDA：AI 審查認為預設前提不成立', '前提「財報可信、沒有硬事件」：3 票判不成立', `AI 建議出清，賣 ${acct.lots.own.NVDA} 股（要不要做由你決定）`, 'https://x/#/n/1']);
    });
  });
});
