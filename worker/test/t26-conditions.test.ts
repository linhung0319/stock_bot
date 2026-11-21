// T26：條件的所有權（own_thesis §1.5、§1.6「輸出」與「程式怎麼用結論」第 1、2、4 點、§3.6.2）。
// 完成條件：
//   F24 回來後你定的條件不變
//   建議的條件沒勾選就不通知；勾選後成立會通知
//   證據不足、資料缺漏、票數不一致的審查不動條件
//   第 9 條勾不進去
//   有 supersedes 的勾選後舊的那條變 RETIRED
//   這次審查有寫入時舊的建議變 EXPIRED、沒提時留著
//   只有新聞標題或價格當引用的「不成立」不算
//   REVIEW_ONLY 的條件由三票確認成立
//   財報類條件每次比對都有 progress_json
// 另外：F24、F7 的證據包有 C、W；勾選、撤下、改動作的 API 與 log 的 CONDITION；持股頁的資料。
// 對外請求全部是假的：價格、成分股（固定檔）、EDGAR、Nasdaq RSS、雲端排程、LINE。
import { describe, expect, it } from 'vitest';
import { judge, type EvidencePack, type PackDoc } from '../src/ai/check';
import { PAYLOAD_HOOKS } from '../src/ai/hooks';
import { OWN_REVIEW, ownReviewPack, reviewDecision } from '../src/ai/ownReview';
import type { ApplyCtx } from '../src/app/aiCtx';
import { finalizeRun, getRun, listRuns, type AiRun } from '../src/app/aiRuns';
import type { Env, Fetcher } from '../src/app/env';
import { runFlow, type Attempt } from '../src/app/flow';
import { LINE_PUSH_URL } from '../src/app/line';
import { loadAccount, saveAccount } from '../src/app/ledgerStore';
import { applyOwnReview, ownXbrlConditions, startOwnReview } from '../src/app/ownAi';
import { monitorView } from '../src/app/ownCheckAi';
import { CondError, conditionOp } from '../src/app/ownConds';
import { condFacts, loadConditions, thesisFile, xbrlProgress, type FileCondition } from '../src/app/thesis';
import type { CompanyFacts, QuarterRow, XbrlFact } from '../src/data/edgar';
import { buildMarketView } from '../src/data/marketView';
import { loadSeries } from '../src/data/store';
import { createAccount, type Account, type MarketView } from '../src/engine';
import { handle } from '../src/index';
import { freshDb } from './helpers/d1';
import { cronTime, fakeFetcher, newWorld, type World } from './helpers/fakeSources';

// ---------------------------------------------------------------- 假的 EDGAR、世界

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

interface Ctx {
  db: D1Database;
  w: World;
  e: Edgar;
  env: Env;
  fetcher: Fetcher;
  run: (date: string, attempt?: Attempt) => ReturnType<typeof runFlow>;
  viewAt: (date: string) => Promise<{ view: MarketView; axis: string[] }>;
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
    await fn({ db, w, e, env, fetcher, run, viewAt });
  } finally {
    await d.dispose();
  }
}

const FILE = 'NVDA@2026-11-19';
const GM = (level: number, quarters = 1) => ({ type: 'xbrl_metric_below', metric: 'GrossMarginPct', level, quarters });
type CondSeed = { condId?: string; kind?: 'XBRL' | 'EVENT' | 'PRICE'; status: string; text?: string; check?: Record<string, unknown>; tier?: string | null; origin?: 'AI' | 'USER'; accepted?: boolean; action?: string | null; auto?: boolean; supersedes?: number | null; createdAt?: string };

/** 直接寫一條條件到現在這份論點檔；回傳列編號。 */
async function seed(db: D1Database, o: CondSeed): Promise<number> {
  const r = await db
    .prepare('INSERT INTO own_conditions (ticker, run_id, cond_id, direction, kind, text, check_json, tier_if_met, status, created_at, origin, file_id, accepted_at, action, auto, supersedes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind('NVDA', 'r0', o.condId ?? 'C1', 'DOWN', o.kind ?? 'XBRL', o.text ?? '毛利率低於 55%', JSON.stringify(o.check ?? GM(0.55)), o.tier === undefined ? 'HALF' : o.tier, o.status, o.createdAt ?? '2026-11-19T12:00:00.000Z', o.origin ?? 'AI', FILE, o.accepted ? '2026-11-20T01:00:00.000Z' : null, o.action ?? null, o.auto === false ? 0 : 1, o.supersedes ?? null)
    .run();
  return r.meta.last_row_id;
}
const statusOf = async (db: D1Database) => Object.fromEntries((await loadConditions(db, 'NVDA')).map((c) => [c.id, c.status]));
const byId = async (db: D1Database, id: number) => (await loadConditions(db, 'NVDA')).find((c) => c.id === id)!;

// ---------------------------------------------------------------- 審查的票（直接組證據包、檢查、套用）

const TENQ_DOC: PackDoc = { id: 'D1', source_id: 'edgar:x', kind: 'filing', date: '2026-10-30', title: '10-Q', text: 'Revenue for the third quarter was $160 million, up 33% from a year ago. Gross margin was 60.0%, down from 70.0% a year ago.' };
const NEWS_DOC: PackDoc = { id: 'N-NVDA', source_id: 'nasdaq-rss:NVDA', kind: 'news', date: '2026-11-18', title: '新聞標題', text: '2026-11-18 | NVIDIA shares slide on margin worries' };
const Q_FILING = 'Gross margin was 60.0%, down from 70.0% a year ago';

interface VoteOpt {
  verdict?: string;
  /** 每條前提的判斷與引用的來源：filing／news／price。 */
  premises?: [string, string, 'filing' | 'news' | 'price'][];
  checks?: [string, string, 'filing' | 'news' | 'price'][];
  proposed?: unknown[];
  /** 引用全部壞掉（逐字檢查不過）。 */
  badQuotes?: boolean;
}
function vote(pack: EvidencePack, o: VoteOpt = {}) {
  const price = pack.documents.find((d) => d.source_id === 'price:NVDA')!;
  const ev = {
    filing: { id: 'E1', source_id: 'edgar:x', date: '2026-10-30', quote: Q_FILING, claim: '毛利率 60%' },
    news: { id: 'E2', source_id: 'nasdaq-rss:NVDA', date: '2026-11-18', quote: 'NVIDIA shares slide on margin worries', claim: '新聞說毛利率有疑慮' },
    price: { id: 'E3', source_id: 'price:NVDA', date: price.date, quote: price.text.split('\n').at(-1)!, claim: '最新收盤' },
  };
  const eid = { filing: 'E1', news: 'E2', price: 'E3' } as const;
  const verdict = o.verdict ?? 'HALF';
  return {
    run_id: pack.run_id,
    verdict,
    premise_checks: (o.premises ?? [['P2', 'BROKEN', 'filing']]).map(([id, status, src]) => ({ premise_id: id, status, evidence_ids: [eid[src]] })),
    evidence: Object.values(ev).map((e) => (o.badQuotes ? { ...e, quote: e.quote + '（改寫過）' } : e)),
    payload: { tier: verdict, condition_checks: (o.checks ?? []).map(([id, status, src]) => ({ id, status, evidence_ids: [eid[src]] })), proposed_conditions: o.proposed ?? [] },
    report: '測試',
  };
}
const proposal = (id: string, extra: Record<string, unknown> = {}) => ({ id, direction: 'DOWN', kind: 'XBRL', text: `毛利率低於 50%（${id}）`, check: GM(0.5), basis: ['E1'], tier_if_met: 'HALF', ...extra });

/** 照現在的論點檔組 F24 的證據包（C、W 由 condFacts 組）。 */
async function reviewPack(db: D1Database, acct: Account, view: MarketView, axis: string[], dataQuality: EvidencePack['data_quality'] = { filings: 'ok' }) {
  const tf = (await thesisFile(db, acct, 'NVDA', view.date))!;
  return ownReviewPack({ acct, view, axis, ticker: 'NVDA', runId: `rev-${Math.random().toString(36).slice(2, 8)}`, trigger: 'EARNINGS', xbrl: null, filings: [TENQ_DOC], news: NEWS_DOC, conds: condFacts(tf, null), dataQuality, now: new Date('2026-11-20T01:00:00Z') }).pack;
}

/** 套用一次審查（三票），回傳 ctx（帳戶、log）。 */
async function apply(db: D1Database, acct: Account, view: MarketView, axis: string[], pack: EvidencePack, votes: unknown[]): Promise<ApplyCtx> {
  const outcome = judge(pack, votes, PAYLOAD_HOOKS[OWN_REVIEW]);
  const ctx: ApplyCtx = { db, acct, view, axis, session: view.date, now: new Date('2026-11-20T01:30:00Z'), stmts: [], log: [] };
  await applyOwnReview(ctx, { runId: pack.run_id, fn: OWN_REVIEW, ticker: 'NVDA', asOf: view.date, outcome, pack } as unknown as AiRun);
  if (ctx.stmts.length) await db.batch(ctx.stmts);
  return ctx;
}

async function setup(c: Ctx) {
  const acct = (await loadAccount(c.db))!.acct;
  const { view, axis } = await c.viewAt('2026-11-19');
  return { acct, view, axis };
}

// ---------------------------------------------------------------- 審查不再整組替換條件

describe('T26：審查只寫建議，你定的條件換不掉', () => {
  // T71（confirm_audit_design §3）改了這個行為：建議寫入就是 AI 監測中（不是 PROPOSED）
  it('F24 回來後你定的條件不變；這次有寫入時舊的建議變 EXPIRED，下一次沒提時建議留著', async () => {
    await withWorld(async (c) => {
      const { acct, view, axis } = await setup(c);
      const mine = await seed(c.db, { condId: 'U1', status: 'ACTIVE', origin: 'USER', accepted: true, action: 'EXIT', text: '毛利率低於 40%', check: GM(0.4) });
      const oldW = await seed(c.db, { condId: 'C7', status: 'PROPOSED', text: '舊的建議' });
      const before = await byId(c.db, mine);
      const pack = await reviewPack(c.db, acct, view, axis);
      // 證據包：你定的 C1、觀察項 W1，對照表在 rule.detail.conds
      expect(pack.facts.filter((f) => /^[CW]\d$/.test(f.id)).map((f) => [f.id, f.value])).toEqual([
        ['C1', '毛利率低於 40%'],
        ['W1', '舊的建議'],
      ]);
      expect((pack.rule.detail as { conds: Record<string, number> }).conds).toEqual({ C1: mine, W1: oldW });
      expect(pack.prompt_version).toBe('own_review_v5'); // T53：分析師可以另外找資料、網頁證據（v3）；T61：判成立要有正面的引用（v4）
      expect(pack.question).toContain('payload.condition_checks');
      expect(pack.question).toContain('payload.proposed_conditions');

      // 三票一致減半、提兩條建議（其中一條想取代 C1）
      const v = vote(pack, { proposed: [proposal('N1', { premise_id: 'P2', supersedes: 'C1' }), proposal('N2')] });
      const ctx = await apply(c.db, acct, view, axis, pack, [v, v, v]);
      expect(await byId(c.db, mine)).toEqual(before); // 你定的那一條一個欄位都沒變
      const after = await loadConditions(c.db, 'NVDA');
      expect(after.map((x) => [x.condId, x.status])).toEqual([
        ['U1', 'ACTIVE'],
        ['C7', 'EXPIRED'],
        ['N1', 'ACTIVE'],
        ['N2', 'ACTIVE'],
      ]);
      expect(after.find((x) => x.condId === 'N1')).toMatchObject({ origin: 'AI', acceptedAt: null, action: 'REVIEW', premiseId: 'P2', supersedes: mine, tierIfMet: 'HALF', auto: true, runId: pack.run_id });
      // 建議不發通知（T29a：這次審查 3 票判 P2 不成立，發的是乙類的當天通知，和建議的條件無關）
      expect(ctx.acct.notifs.filter((n) => n.kind === 'URGENT' && !n.items.every((i) => i.brk?.type === 'B'))).toEqual([]);

      // 下一次審查（一致不動）一條都沒提 → 建議留著
      const pack2 = await reviewPack(c.db, ctx.acct, view, axis);
      const v2 = vote(pack2, { verdict: 'HOLD', premises: [['P2', 'HOLDS', 'filing']] });
      await apply(c.db, ctx.acct, view, axis, pack2, [v2, v2, v2]);
      expect((await loadConditions(c.db, 'NVDA')).map((x) => [x.condId, x.status])).toEqual([
        ['U1', 'ACTIVE'],
        ['C7', 'EXPIRED'],
        ['N1', 'ACTIVE'],
        ['N2', 'ACTIVE'],
      ]);
    });
  });

  it('證據不足、資料缺漏、票數不一致的審查不動條件（不寫建議、不確認成立）；一致選「不動」的照樣動', async () => {
    await withWorld(async (c) => {
      const { acct, view, axis } = await setup(c);
      const ro = await seed(c.db, { condId: 'U1', kind: 'EVENT', status: 'REVIEW_ONLY', origin: 'USER', accepted: true, action: 'HALF', text: '法說會上下修財測', check: { type: 'event', confirm_by: ['earnings_call'] } });
      const w = await seed(c.db, { condId: 'C7', status: 'PROPOSED', text: '舊的建議' });
      const snapshot = await statusOf(c.db);
      const opt: VoteOpt = { checks: [['C1', 'MET', 'filing']], proposed: [proposal('N1')] };
      const pack = await reviewPack(c.db, acct, view, axis);
      // 票數不一致
      const split = await apply(c.db, acct, view, axis, pack, [vote(pack, opt), vote(pack, opt), vote(pack, { ...opt, verdict: 'EXIT' })]);
      expect(split.log.join('\n')).toContain('沒有三票一致的結論，條件不動');
      // 證據不足（引用全部壞掉 → 三票都被改成 HOLD，不是自己選的）
      const ins = await apply(c.db, acct, view, axis, pack, [1, 2, 3].map(() => vote(pack, { ...opt, badQuotes: true })));
      expect(ins.log.join('\n')).toContain('條件不動');
      // 資料缺漏
      const packMissing = await reviewPack(c.db, acct, view, axis, { filings: 'ok', xbrl: 'missing' });
      const dm = await apply(c.db, acct, view, axis, packMissing, [1, 2, 3].map(() => vote(packMissing, opt)));
      expect(judge(packMissing, [vote(packMissing, opt)], PAYLOAD_HOOKS[OWN_REVIEW]).samples[0].dataMissing).toEqual(['xbrl']);
      expect(dm.log.join('\n')).toContain('條件不動');
      expect(await statusOf(c.db)).toEqual(snapshot);
      expect((await loadConditions(c.db, 'NVDA')).map((x) => x.condId)).toEqual(['U1', 'C7']);
      // 對照：三票一致選「不動」（每一票自己選的）→ 條件照樣動（確認成立、寫建議）
      const hold = { ...opt, verdict: 'HOLD', premises: [['P2', 'HOLDS', 'filing']] as VoteOpt['premises'] };
      await apply(c.db, acct, view, axis, pack, [vote(pack, hold), vote(pack, hold), vote(pack, hold)]);
      const s = await statusOf(c.db);
      expect([s[ro], s[w]]).toEqual(['MET', 'EXPIRED']);
    });
  });
});

// ---------------------------------------------------------------- 不成立的前提

describe('T26：不成立的前提（§1.6 第 1 點）', () => {
  it('只有新聞標題或價格當引用的「不成立」不算；三票要判同一條；多條時取編號最小的；寫進 aiTier.premiseId', async () => {
    await withWorld(async (c) => {
      const { acct, view, axis } = await setup(c);
      const pack = await reviewPack(c.db, acct, view, axis);
      const decide = (votes: unknown[]) => reviewDecision(judge(pack, votes, PAYLOAD_HOOKS[OWN_REVIEW]), acct, 'NVDA', view.date, pack);
      const three = (o: VoteOpt) => [vote(pack, o), vote(pack, o), vote(pack, o)];
      // 新聞標題當引用 → 不算
      expect(decide(three({ premises: [['P2', 'BROKEN', 'news']] }))).toMatchObject({ tier: 'HALF', premiseId: null, suggest: false });
      // 價格當引用 → 不算
      expect(decide(three({ premises: [['P2', 'BROKEN', 'price']] }))).toMatchObject({ premiseId: null, suggest: false });
      // 申報原文 → 算
      expect(decide(three({ premises: [['P2', 'BROKEN', 'filing']] }))).toMatchObject({ premiseId: 'P2', brokenPremises: ['P2'], suggest: true });
      // 每一票判不成立的是不同的前提（修 N5）→ 沒有交集
      const mixed = decide([vote(pack, { premises: [['P1', 'BROKEN', 'filing']] }), vote(pack, { premises: [['P2', 'BROKEN', 'filing']] }), vote(pack, { premises: [['P2', 'BROKEN', 'filing']] })]);
      expect(mixed).toMatchObject({ premiseId: null, suggest: false });
      // 兩條都不成立 → 主要的是編號最小的那條
      const both = decide(three({ premises: [['P2', 'BROKEN', 'filing'], ['P1', 'BROKEN', 'filing']] }));
      expect(both).toMatchObject({ premiseId: 'P1', brokenPremises: ['P1', 'P2'] });
      // 套用：aiTier 記下那條前提
      const ctx = await apply(c.db, acct, view, axis, pack, three({ premises: [['P2', 'BROKEN', 'filing']] }));
      // T29a：財報後的審查有資格 → 當天發了乙類，所以不再記著進月報（suggest = false）
      expect(ctx.acct.own.NVDA.aiTier).toMatchObject({ tier: 'HALF', suggest: false, premiseId: 'P2', trigger: 'EARNINGS' });
      expect(ctx.acct.notifs.find((n) => n.kind === 'URGENT')!.items[0].brk).toEqual({ type: 'B', premiseId: 'P2' });
      const ctx2 = await apply(c.db, acct, view, axis, pack, three({ premises: [['P2', 'BROKEN', 'news']] }));
      expect(ctx2.acct.own.NVDA.aiTier).toMatchObject({ tier: 'HALF', suggest: false });
      expect(ctx2.acct.own.NVDA.aiTier!.premiseId).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------- 審查確認你定的條件成立

describe('T26：審查三票確認你定的條件成立（§1.6 第 2 點）', () => {
  it('REVIEW_ONLY 的條件由三票確認成立 → MET（REVIEW_VOTE）與通知；財報類只記錄；觀察項不動；只有新聞的引用不算', async () => {
    await withWorld(async (c) => {
      const { acct, view, axis } = await setup(c);
      const ro = await seed(c.db, { condId: 'U1', kind: 'EVENT', status: 'REVIEW_ONLY', origin: 'USER', accepted: true, action: 'HALF', text: '法說會上下修財測', check: { type: 'event', confirm_by: ['earnings_call'] } });
      const xb = await seed(c.db, { condId: 'U2', status: 'ACTIVE', origin: 'USER', accepted: true, action: 'EXIT', text: '毛利率低於 62%', check: GM(0.62) });
      const w = await seed(c.db, { condId: 'C7', kind: 'EVENT', status: 'PROPOSED', text: '公司宣布裁員', check: { type: 'event', confirm_by: ['8-K'] } });
      const pack = await reviewPack(c.db, acct, view, axis);
      const ids = (pack.rule.detail as { conds: Record<string, number> }).conds;
      expect(ids).toEqual({ C1: ro, C2: xb, W1: w });
      // 只有新聞標題當引用 → 不算成立
      const news: VoteOpt = { verdict: 'HOLD', premises: [['P2', 'HOLDS', 'filing']], checks: [['C1', 'MET', 'news']] };
      await apply(c.db, acct, view, axis, pack, [vote(pack, news), vote(pack, news), vote(pack, news)]);
      expect((await byId(c.db, ro)).status).toBe('REVIEW_ONLY');
      // 三票都寫 MET、引用申報原文
      const ok: VoteOpt = { verdict: 'HOLD', premises: [['P2', 'HOLDS', 'filing']], checks: [['C1', 'MET', 'filing'], ['C2', 'MET', 'filing'], ['W1', 'MET', 'filing']] };
      const ctx = await apply(c.db, acct, view, axis, pack, [vote(pack, ok), vote(pack, ok), vote(pack, ok)]);
      expect(await byId(c.db, ro)).toMatchObject({ status: 'MET', metBasis: 'REVIEW_VOTE' });
      // 持股頁：已成立的寫怎麼確認的（白話，不放執行編號）
      expect((await monitorView(c.env, 'NVDA')).find((x) => x.id === ro)).toMatchObject({ status: '已成立', note: '11/20 的定期審查，AI 3 票確認成立', recordOnly: false });
      expect((await byId(c.db, xb)).status).toBe('ACTIVE'); // 財報類以程式比對為準
      expect(ctx.log.join('\n')).toContain('以程式比對財報數字為準，只記錄');
      expect((await byId(c.db, w)).status).toBe('PROPOSED'); // 觀察項成立與否只是輸入
      // 通知（T29a 改成甲類）：減半，預設照當時的決定
      const n = ctx.acct.notifs.find((x) => x.kind === 'URGENT')!;
      expect(n.title).toBe('NVDA：你定的出場條件成立');
      expect(n.items[0]).toMatchObject({ f: 'F25', kind: 'OWN_COND', choice: 'DO', title: 'NVDA：你在 2026-11-20 定的條件「法說會上下修財測」成立' });
      expect(n.items[0].choices[0].tier).toBe('HALF');
      expect(n.items[0].runIds).toEqual([pack.run_id, 'r0']);
      // 一張票沒寫 MET → 不成立（另一份世界的狀態不用；這裡用純函式看）
      const one = reviewDecision(judge(pack, [vote(pack, ok), vote(pack, ok), vote(pack, { ...ok, checks: [] })], PAYLOAD_HOOKS[OWN_REVIEW]), acct, 'NVDA', view.date, pack);
      expect(one.metChecks).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------- 勾選、撤下、改動作

describe('T26：勾選、撤下、改動作', () => {
  it('建議的條件沒勾選就不通知；勾選後成立會通知（財報條件，程式比對）', async () => {
    await withWorld(async (c) => {
      const { acct, view, axis } = await setup(c);
      const p = await seed(c.db, { condId: 'N1', status: 'PROPOSED', text: '毛利率低於 55%', check: GM(0.55), tier: 'EXIT' });
      const rows = [qrow('2026-09-30', 0.5), qrow('2026-06-30', 0.6)];
      const xbrl = async (a: Account) => {
        const ctx: ApplyCtx = { db: c.db, acct: a, view, axis, session: '2026-11-23', now: new Date('2026-11-24T00:00:00Z'), stmts: [], log: [] };
        await ownXbrlConditions(ctx, new Map([['NVDA', rows]]));
        await c.db.batch(ctx.stmts);
        return ctx;
      };
      // 沒勾選：比對成立也不通知、不標成立
      const a = await xbrl(acct);
      expect(a.acct.notifs.filter((n) => n.kind === 'URGENT')).toEqual([]);
      expect(a.log.join('\n')).toContain('你還沒勾選，不通知');
      expect((await byId(c.db, p)).status).toBe('PROPOSED');
      // 勾選（預設帶 AI 建議的檔位：出清）→ 監測中
      expect(await conditionOp(c.db, acct, 'NVDA', p, 'accept', undefined, '2026-11-23', new Date('2026-11-24T01:00:00Z'))).toEqual({ id: p, status: 'ACTIVE', action: 'EXIT' });
      expect(await byId(c.db, p)).toMatchObject({ status: 'ACTIVE', action: 'EXIT', acceptedAt: '2026-11-24T01:00:00.000Z' });
      // 成立 → 通知
      const b = await xbrl(acct);
      const n = b.acct.notifs.find((x) => x.kind === 'URGENT')!;
      // T29a：甲類，文字有誰哪天定的（AI 建議、你勾選）
      expect(n.items[0]).toMatchObject({ f: 'F25', kind: 'OWN_COND', title: 'NVDA：你在 2026-11-24 定的條件「毛利率低於 55%」成立' });
      expect(n.items[0].choices[0].tier).toBe('EXIT');
      expect(await byId(c.db, p)).toMatchObject({ status: 'MET', metBasis: 'XBRL' });
    });
  });

  it('第 9 條勾不進去；被取代的那一條不算；有 supersedes 的勾選後舊的那條變 RETIRED；log 寫 CONDITION', async () => {
    await withWorld(async (c) => {
      const { acct } = await setup(c);
      const mine: number[] = [];
      for (let k = 1; k <= 8; k++) mine.push(await seed(c.db, { condId: `U${k}`, status: k % 2 ? 'ACTIVE' : 'REVIEW_ONLY', origin: 'USER', accepted: true, action: 'HALF', text: `你定的第 ${k} 條` }));
      await seed(c.db, { condId: 'M1', kind: 'PRICE', status: 'MANUAL', origin: 'USER', accepted: true, action: 'REVIEW', text: '收盤跌破 100（只記錄，不算在 8 條裡）', check: { type: 'price_close_below', level: 100 } });
      const ninth = await seed(c.db, { condId: 'N1', status: 'PROPOSED', text: '第 9 條' });
      const sup = await seed(c.db, { condId: 'N2', status: 'PROPOSED', text: '取代第 3 條', supersedes: mine[2] });
      const price = await seed(c.db, { condId: 'N3', kind: 'PRICE', status: 'PROPOSED', text: '收盤跌破 90', check: { type: 'price_close_below', level: 90 }, auto: false });
      const op = (id: number, o: 'accept' | 'retire' | 'action', action?: string) => conditionOp(c.db, acct, 'NVDA', id, o, action, '2026-11-20', new Date('2026-11-21T01:00:00Z'));
      await expect(op(ninth, 'accept')).rejects.toThrow(CondError);
      await expect(op(ninth, 'accept')).rejects.toThrow('你定的條件已經有 8 條（上限 8 條），先撤下一條才能再加。');
      expect((await byId(c.db, ninth)).status).toBe('PROPOSED');
      // 只記錄的建議（價格）勾得進去：不算在 8 條裡
      expect((await monitorView(c.env, 'NVDA')).find((x) => x.id === price)).toMatchObject({ code: 'PROPOSED', recordOnly: true });
      expect(await op(price, 'accept', 'REVIEW')).toMatchObject({ status: 'MANUAL', action: 'REVIEW' });
      // 取代第 3 條：數量不變，勾得進去；第 3 條 RETIRED
      expect(await op(sup, 'accept', 'EXIT')).toEqual({ id: sup, status: 'ACTIVE', action: 'EXIT', retired: mine[2] });
      expect(await byId(c.db, mine[2])).toMatchObject({ status: 'RETIRED' });
      expect((await byId(c.db, mine[2])).note).toContain('取代');
      // 撤下一條之後第 9 條就勾得進去
      expect(await op(mine[0], 'retire')).toMatchObject({ status: 'RETIRED' });
      expect(await op(ninth, 'accept', 'HALF')).toMatchObject({ status: 'ACTIVE', action: 'HALF' });
      // 改動作
      expect(await op(mine[1], 'action', 'EXIT')).toMatchObject({ status: 'REVIEW_ONLY', action: 'EXIT' });
      expect((await byId(c.db, mine[1])).action).toBe('EXIT');
      // 不能做的
      await expect(op(mine[0], 'retire')).rejects.toThrow('只有你定的');
      await expect(op(ninth, 'accept')).rejects.toThrow('不是建議中的條件');
      await expect(op(mine[1], 'action', 'SELL')).rejects.toThrow('出清、減半或重新審查');
      // log：每一次一筆 CONDITION（帳戶沒有存檔，不跟著快照的版本）
      const log = (await c.db.prepare("SELECT ref, body, account_version, session FROM own_thesis_log WHERE kind = 'CONDITION' ORDER BY id").all<{ ref: string; body: string; account_version: number | null; session: string }>()).results;
      expect(log.map((l) => JSON.parse(l.body))).toEqual([
        { id: price, change: 'ACCEPTED', action: 'REVIEW', by: 'USER' },
        { id: sup, change: 'ACCEPTED', action: 'EXIT', by: 'USER' },
        { id: mine[2], change: 'RETIRED', action: 'HALF', by: 'USER' },
        { id: mine[0], change: 'RETIRED', action: 'HALF', by: 'USER' },
        { id: ninth, change: 'ACCEPTED', action: 'HALF', by: 'USER' },
        { id: mine[1], change: 'ACTION_CHANGED', action: 'EXIT', by: 'USER' },
      ]);
      expect(log.every((l) => l.account_version === null && l.session === '2026-11-20')).toBe(true);
    });
  });

  it('網站 API：/api/ops/own-condition 勾選、改動作、撤下；超過上限回 422；持股頁的資料（誰定的、成立時做什麼、進度）', async () => {
    await withWorld(async (c) => {
      const p = await seed(c.db, { condId: 'N1', status: 'PROPOSED', text: '毛利率低於 55%', tier: 'HALF', createdAt: '2026-11-20T01:00:00.000Z' });
      await c.db.prepare('UPDATE own_conditions SET progress_json = ? WHERE id = ?').bind(JSON.stringify(xbrlProgress([qrow('2026-09-30', 0.6), qrow('2026-06-30', 0.5)], GM(0.55, 2), '2026-11-20')), p).run();
      const now = new Date('2026-11-21T02:00:00Z');
      const post = (body: unknown) => handle(new Request('https://bot.example/api/ops/own-condition', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), c.env, c.fetcher, now);
      // 持股頁：建議中的條件
      let m = (await monitorView(c.env, 'NVDA'))[0];
      expect(m).toMatchObject({ id: p, code: 'PROPOSED', status: '建議中', owned: false, action: 'HALF', actionText: '減半', origin: 'AI 建議，11/20 的審查寫的', confirm: '新財報出來時比對', progress: '最新一季 60.0%（2026-09-30，門檻 55.0%）；已連續 0／2 季' });
      // 勾選
      let r = await post({ ticker: 'NVDA', id: p, op: 'accept', action: 'EXIT' });
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ ok: true, id: p, status: 'ACTIVE', action: 'EXIT' });
      m = (await monitorView(c.env, 'NVDA'))[0];
      expect(m).toMatchObject({ code: 'ACTIVE', status: '監測中', owned: true, action: 'EXIT', actionText: '出清', origin: 'AI 建議，你在 11/21 定下' }); // T71：「勾選」改「定下」
      // 改動作、撤下
      r = await post({ ticker: 'NVDA', id: p, op: 'action', action: 'HALF' });
      expect(await r.json()).toMatchObject({ ok: true, action: 'HALF' });
      r = await post({ ticker: 'NVDA', id: p, op: 'retire' });
      expect(await r.json()).toMatchObject({ ok: true, status: 'RETIRED' });
      expect(await monitorView(c.env, 'NVDA')).toEqual([]); // 撤下的不列
      // 不能做的回 422 與白話的原因
      for (let k = 1; k <= 8; k++) await seed(c.db, { condId: `U${k}`, status: 'ACTIVE', origin: 'USER', accepted: true, action: 'HALF' });
      const n9 = await seed(c.db, { condId: 'N9', status: 'PROPOSED' });
      r = await post({ ticker: 'NVDA', id: n9, op: 'accept' });
      expect(r.status).toBe(422);
      expect(((await r.json()) as { error: string }).error).toContain('上限 8 條');
      expect((await post({ ticker: 'NVDA', id: n9, op: 'delete' })).status).toBe(422);
      expect((await post({ ticker: 'NVDA', op: 'accept' })).status).toBe(422);
    });
  });
});

// ---------------------------------------------------------------- 財報類條件的進度

function qrow(end: string, gm: number | null): QuarterRow {
  return { end, filed: end.replace(/-\d\d$/, '-28'), form: '10-Q', accn: 'a', revenue: 100, grossProfit: gm === null ? null : gm * 100, operatingIncome: null, netIncome: null, epsDiluted: null, cfo: null, grossMarginPct: gm, operatingMarginPct: null, netMarginPct: null, revenueYoY: null, cfoToNetIncome: null };
}

describe('T26：財報類條件的進度（§3.6.2）', () => {
  it('每次比對都寫 progress_json：監測中與建議中的都寫、成立與否都寫；不認得的指標不寫', async () => {
    await withWorld(async (c) => {
      const { acct, view, axis } = await setup(c);
      const a1 = await seed(c.db, { condId: 'U1', status: 'ACTIVE', origin: 'USER', accepted: true, action: 'EXIT', text: '毛利率連兩季低於 58%', check: GM(0.58, 2) });
      const w1 = await seed(c.db, { condId: 'N1', status: 'PROPOSED', text: '毛利率低於 40%', check: GM(0.4) });
      const bad = await seed(c.db, { condId: 'N2', status: 'PROPOSED', text: '自由現金流殖利率', check: { type: 'xbrl_metric_below', metric: 'FcfYield', level: 0.02 } });
      const ev = await seed(c.db, { condId: 'U2', kind: 'EVENT', status: 'ACTIVE', origin: 'USER', accepted: true, action: 'HALF', text: '8-K 下修財測', check: { type: 'event', confirm_by: ['8-K'] } });
      const run = async (rows: QuarterRow[], session: string) => {
        const ctx: ApplyCtx = { db: c.db, acct, view, axis, session, now: new Date(session + 'T23:40:00Z'), stmts: [], log: [] };
        await ownXbrlConditions(ctx, new Map([['NVDA', rows]]));
        await c.db.batch(ctx.stmts);
        return ctx;
      };
      // 第一季低於 58%：已連續 1／2 季，沒成立
      await run([qrow('2026-09-30', 0.56), qrow('2026-06-30', 0.6), qrow('2026-03-31', 0.61)], '2026-11-03');
      expect((await byId(c.db, a1)).progress).toEqual({ at: '2026-11-03', basis: 'XBRL', period: '2026-09-30', values: [0.56, 0.6, 0.61], level: 0.58, streak: 1, need: 2 });
      expect((await byId(c.db, a1)).status).toBe('ACTIVE');
      expect((await byId(c.db, w1)).progress).toMatchObject({ period: '2026-09-30', streak: 0, need: 1 });
      expect((await byId(c.db, bad)).progress).toBeNull();
      expect((await byId(c.db, ev)).progress).toBeNull();
      // 下一季也低於：成立（照樣寫進度）
      const ctx = await run([qrow('2026-12-31', 0.55), qrow('2026-09-30', 0.56), qrow('2026-06-30', 0.6)], '2027-02-05');
      expect(await byId(c.db, a1)).toMatchObject({ status: 'MET', metBasis: 'XBRL', progress: { at: '2027-02-05', period: '2026-12-31', streak: 2, need: 2 } });
      expect(ctx.acct.notifs.some((n) => n.kind === 'URGENT')).toBe(true);
      expect((await byId(c.db, w1)).progress).toMatchObject({ at: '2027-02-05', period: '2026-12-31', streak: 0 });
    });
  });

  it('xbrlProgress：連續幾季從最新一季算、缺值就斷；高於門檻的條件；最多記 4 季', () => {
    const rows = [qrow('2026-12-31', 0.5), qrow('2026-09-30', 0.5), qrow('2026-06-30', null), qrow('2026-03-31', 0.5), qrow('2025-12-31', 0.5)];
    expect(xbrlProgress(rows, GM(0.55, 4), 'x')).toMatchObject({ values: [0.5, 0.5, null, 0.5], streak: 2, need: 4 });
    expect(xbrlProgress(rows, { type: 'xbrl_metric_above', metric: 'GrossMarginPct', level: 0.4, quarters: 1 }, 'x')).toMatchObject({ streak: 1, need: 1 });
    expect(xbrlProgress([], GM(0.5), 'x')).toBeNull();
  });
});

// ---------------------------------------------------------------- 證據包的 C、W

describe('T26：F24、F7 的證據包有你定的條件（C）與觀察項（W）', () => {
  it('condFacts：C 寫誰哪天定的、成立時做什麼、怎麼確認、目前狀態；上次審查之後成立的也列；W 附程式比對的結果', () => {
    const cond = (o: Partial<FileCondition>): FileCondition => ({ ticker: 'NVDA', runId: 'r', condId: 'C', direction: 'DOWN', kind: 'XBRL', text: 't', check: GM(0.55), tierIfMet: 'HALF', status: 'ACTIVE', createdAt: '2026-11-20T01:00:00.000Z', metAt: null, note: null, id: 1, origin: 'AI', fileId: FILE, acceptedAt: null, action: null, premiseId: null, supersedes: null, metBasis: null, verifiedAt: null, progress: null, auto: true, ...o });
    const tf = {
      lastReview: { runId: 'rv', asOf: '2026-11-27', createdAt: '2026-11-27T23:35:00.000Z' },
      newSince: '2026-07-30',
      conditions: [
        cond({ id: 11, text: '毛利率連兩季低於 55%', origin: 'USER', acceptedAt: '2026-11-20T01:00:00.000Z', action: 'EXIT', premiseId: 'P2', check: GM(0.55, 2), progress: { at: '2026-11-03', basis: 'XBRL', period: '2026-09-30', values: [0.5, 0.6], level: 0.55, streak: 1, need: 2 } }),
        cond({ id: 12, kind: 'EVENT', text: '法說會下修', status: 'REVIEW_ONLY', acceptedAt: '2026-11-21T01:00:00.000Z', action: 'HALF', check: { type: 'event', confirm_by: ['earnings_call'] } }),
        cond({ id: 13, text: '上次審查之前成立的', status: 'MET', acceptedAt: '2026-11-21T01:00:00.000Z', action: 'HALF', metAt: '2026-11-25T00:00:00.000Z' }),
        cond({ id: 14, text: '上次審查之後成立的', status: 'MET', acceptedAt: '2026-11-21T01:00:00.000Z', action: 'HALF', metAt: '2026-12-01T23:40:00.000Z' }),
        cond({ id: 15, text: '撤下的', status: 'RETIRED', acceptedAt: '2026-11-21T01:00:00.000Z' }),
        cond({ id: 16, text: '建議：毛利率低於 55%', status: 'PROPOSED' }),
        cond({ id: 17, text: '建議：公司宣布裁員', kind: 'EVENT', status: 'PROPOSED', tierIfMet: 'EXIT', check: { type: 'event', confirm_by: ['8-K'] } }),
        cond({ id: 18, text: '過期的建議', status: 'EXPIRED' }),
      ],
    };
    const rows = [qrow('2026-12-31', 0.5), qrow('2026-09-30', 0.6)];
    const { facts, map } = condFacts(tf, rows);
    expect(map).toEqual({ C1: 11, C2: 12, C3: 14, W1: 16, W2: 17 });
    const f = Object.fromEntries(facts.map((x) => [x.id, x]));
    expect(f.C1.label).toBe('你定的條件 C1（財報；你寫的，11/20 定；對應前提 P2）');
    expect(f.C1.note).toBe('成立時：出清；怎麼確認：新財報出來時比對；目前：監測中；最新一季 50.0%（2026-09-30，門檻 55.0%）；已連續 1／2 季');
    expect(f.C2.label).toContain('AI 建議，你在 11/21 定下'); // T71：不再勾選，誰定的寫「定下」
    expect(f.C2.note).toBe('成立時：減半；怎麼確認：只在定期審查時檢查；目前：只在定期審查時檢查');
    expect(f.C3.note).toContain('目前：已成立（2026-12-01）');
    expect(f.W1.label).toBe('觀察項 W1（AI 建議、使用者還沒勾選；財報；11/20 的審查寫的）');
    expect(f.W1.note).toBe('程式比對：成立（最新一季 2026-12-31（10-Q 2026-12-28）：50.0%，門檻 55.0%）；AI 建議成立時：減半');
    expect(f.W2.note).toBe('怎麼確認：新申報出來時由 AI 確認；AI 建議成立時：出清');
    // XBRL 抓不到 → 資料還沒更新
    expect(condFacts(tf, null).facts.find((x) => x.id === 'W1')!.note).toContain('程式比對：資料還沒更新（XBRL 抓不到）');
    // 建議寫下之後沒有新財報 → 註明
    expect(condFacts(tf, [qrow('2026-09-30', 0.5)]).facts.find((x) => x.id === 'W1')!.note).toContain('建議寫下之後還沒有新財報');
  });

  it('整條流程：F24 的證據包有 C、W 與對照表（財報類觀察項用這次的 XBRL 比對）；F7 的證據包也有 C、W（接在最後）', async () => {
    await withWorld(async (c) => {
      const yoy = { type: 'xbrl_metric_below', metric: 'RevenueYoY', level: 0.4, quarters: 1 };
      const u = await seed(c.db, { condId: 'U1', kind: 'EVENT', status: 'ACTIVE', origin: 'USER', accepted: true, action: 'EXIT', text: '8-K 下修財測', check: { type: 'event', confirm_by: ['8-K'] } });
      const w = await seed(c.db, { condId: 'N1', status: 'PROPOSED', text: '營收年增率低於 40%', check: yoy });
      const acct = (await loadAccount(c.db))!.acct;
      const { view, axis } = await c.viewAt('2026-11-19');
      const r = await startOwnReview(c.env, c.fetcher, acct, view, axis, 'NVDA', 'MANUAL', new Date('2026-11-20T01:00:00Z'));
      expect((r.pack.rule.detail as { conds: Record<string, number> }).conds).toEqual({ C1: u, W1: w });
      expect(r.pack.facts.find((f) => f.id === 'W1')!.note).toContain('程式比對：成立（最新一季 2026-09-30（10-Q 2026-10-30）：33.3%，門檻 40.0%');
      // F7：自選暴跌
      await c.run('2026-11-20');
      c.w.shock.NVDA = { from: '2026-11-23', factor: 0.7 };
      await c.run('2026-11-23');
      const [drop] = (await listRuns(c.db, new Date('2026-11-24T00:00:00Z'), { limit: 50 })).filter((x) => x.fn === 'OWN_DROP');
      const ids = drop.pack.facts.map((f) => f.id);
      // T54：C、W 之後再接清單內的網頁來源（S*；減半檢視的分析師可以另外找資料）
      expect(ids.filter((x) => !/^S\d+$/.test(x)).slice(-2)).toEqual(['C1', 'W1']);
      expect(drop.pack.facts.find((f) => f.id === 'W1')!.note).toContain('程式比對：成立');
      expect(drop.pack.rule.detail).not.toHaveProperty('conds'); // F7 不確認條件
      void getRun;
      void finalizeRun;
    });
  });
});
