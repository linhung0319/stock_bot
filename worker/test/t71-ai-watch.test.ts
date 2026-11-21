// T71：AI 建議的條件自動監測、新風險（confirm_audit_design §3、§4）。
// 完成條件：
//   三票一致的建議寫入就是監測中、動作重新審查、accepted_at 空
//   成立時開審查（condReviewDue）而不是甲類通知
//   改動作成減半 → 變你定的、之後的審查換不掉
//   新建議寫入時舊的 AI 條件 EXPIRED、使用者改過的與 MET 不動、沒提時留著
//   AI 監測中最多 3 條、不佔你定的 8 條
//   票數不一致不寫入（照舊）
//   舊的 PROPOSED 列讀得出來不壞
//   「要看的事」沒有 PROPOSED_CONDS、沒有 NEW_RISK
//   反覆出現的偵測（同文件同原文算、不同文件不算、同一次審查裡兩件不算）
// 採用草稿時的 8 條上限在 t70-draft-adopt.test.ts（用那邊的草稿世界）。
// 對外請求全部是假的（價格、成分股固定檔）；AI 的回覆一律是假的；check.ts 沒有動。
import { describe, expect, it } from 'vitest';
import { judge, type EvidencePack, type Outcome, type PackDoc } from '../src/ai/check';
import { discussionPack, type DiscussionNumbers } from '../src/ai/discussion';
import { repeatedRisks, riskRepeatTickers, type NewRiskItem, type RiskRun } from '../src/ai/freshEyes';
import { PAYLOAD_HOOKS } from '../src/ai/hooks';
import { OWN_CONDITION, OWN_REVIEW, ownReviewPack } from '../src/ai/ownReview';
import type { ApplyCtx } from '../src/app/aiCtx';
import type { AiRun } from '../src/app/aiRuns';
import type { Env } from '../src/app/env';
import { runFlow } from '../src/app/flow';
import { loadAccount, saveAccount } from '../src/app/ledgerStore';
import { applyOwnCondition, applyOwnReview, ownXbrlConditions } from '../src/app/ownAi';
import { monitorView } from '../src/app/ownCheckAi';
import { CondError, conditionOp, ownedCount } from '../src/app/ownConds';
import { MAX_AI_WATCH, MAX_OWNED, OWN_ATTN, condFacts, holdingAttention, isAiWatch, isOwned, loadConditions, ownAttention, thesisFile, type ThesisFile } from '../src/app/thesis';
import type { QuarterRow } from '../src/data/edgar';
import { buildMarketView } from '../src/data/marketView';
import { loadSeries } from '../src/data/store';
import { createAccount, type Account, type MarketView, type OwnMeta } from '../src/engine';
import { handle } from '../src/index';
import { freshDb } from './helpers/d1';
import { cronTime, fakeFetcher, newWorld } from './helpers/fakeSources';

// ---------------------------------------------------------------- 世界：NVDA 是自選、有兩條你寫的前提

interface Ctx {
  db: D1Database;
  env: Env;
  acct: Account;
  view: MarketView;
  axis: string[];
}

async function withWorld(fn: (c: Ctx) => Promise<void>) {
  const d = await freshDb();
  try {
    const db = d.db;
    const w = newWorld('2026-11-19');
    // 沒有 EDGAR 的 User-Agent、沒有雲端排程：每日流程只抓價格，不看申報、不開 AI
    const env: Env = { DB: db, ADMIN_TOKEN: 't', AI_TASK_SECRET: 's', SITE_URL: 'https://bot.example', DEV_NO_AUTH: '1' };
    await runFlow(env, fakeFetcher(w), { now: cronTime('2026-11-19'), attempt: 'FIRST' });
    const { view, axis } = buildMarketView(await loadSeries(db, ['VOO', 'SGOV', 'NVDA']), '2026-11-19', 'VOO');
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
    await fn({ db, env, acct: (await loadAccount(db))!.acct, view, axis });
  } finally {
    await d.dispose();
  }
}

const FILE = 'NVDA@2026-11-19';
const GM = (level: number, quarters = 1) => ({ type: 'xbrl_metric_below', metric: 'GrossMarginPct', level, quarters });
const EV = (by: string[]) => ({ type: 'event', confirm_by: by });
type Seed = { condId?: string; kind?: 'XBRL' | 'EVENT' | 'PRICE'; status: string; text?: string; check?: Record<string, unknown>; tier?: string | null; origin?: 'AI' | 'USER'; accepted?: boolean; action?: string | null; auto?: boolean; supersedes?: number | null; metAt?: string | null };

/** 直接寫一條條件到現在這份論點檔；回傳列編號。 */
async function seed(db: D1Database, o: Seed): Promise<number> {
  const r = await db
    .prepare('INSERT INTO own_conditions (ticker, run_id, cond_id, direction, kind, text, check_json, tier_if_met, status, created_at, origin, file_id, accepted_at, action, auto, supersedes, met_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind('NVDA', 'r0', o.condId ?? 'C1', 'DOWN', o.kind ?? 'XBRL', o.text ?? '毛利率低於 55%', JSON.stringify(o.check ?? GM(0.55)), o.tier === undefined ? 'HALF' : o.tier, o.status, '2026-11-19T12:00:00.000Z', o.origin ?? 'AI', FILE, o.accepted ? '2026-11-20T01:00:00.000Z' : null, o.action ?? null, o.auto === false ? 0 : 1, o.supersedes ?? null, o.metAt ?? null)
    .run();
  return r.meta.last_row_id;
}
const conds = (db: D1Database) => loadConditions(db, 'NVDA');
const byId = async (db: D1Database, id: number) => (await conds(db)).find((c) => c.id === id)!;
const statusOf = async (db: D1Database) => Object.fromEntries((await conds(db)).map((c) => [c.id, c.status]));

// ---------------------------------------------------------------- 審查的票（直接組證據包、檢查、套用）

const TENQ_DOC: PackDoc = { id: 'D1', source_id: 'edgar:x', kind: 'filing', date: '2026-10-30', title: '10-Q', text: 'Revenue for the third quarter was $160 million, up 33% from a year ago. Gross margin was 60.0%, down from 70.0% a year ago.' };
const Q_FILING = 'Gross margin was 60.0%, down from 70.0% a year ago';

interface VoteOpt {
  verdict?: string;
  checks?: [string, string][];
  proposed?: unknown[];
}
function vote(pack: EvidencePack, o: VoteOpt = {}) {
  const verdict = o.verdict ?? 'HOLD';
  return {
    run_id: pack.run_id,
    verdict,
    premise_checks: [{ premise_id: 'P2', status: verdict === 'HOLD' ? 'HOLDS' : 'BROKEN', evidence_ids: ['E1'], confirm_ids: ['E1'] }],
    evidence: [{ id: 'E1', source_id: 'edgar:x', date: '2026-10-30', quote: Q_FILING, claim: '毛利率 60%' }],
    payload: { tier: verdict, condition_checks: (o.checks ?? []).map(([id, status]) => ({ id, status, evidence_ids: ['E1'] })), proposed_conditions: o.proposed ?? [] },
    report: '測試',
  };
}
const xbrlProp = (id: string, level = 0.5, tier = 'HALF') => ({ id, direction: 'DOWN', kind: 'XBRL', text: `毛利率低於 ${Math.round(level * 100)}%（${id}）`, check: GM(level), basis: ['E1'], tier_if_met: tier });
const eventProp = (id: string, by: string[], tier = 'EXIT') => ({ id, direction: 'DOWN', kind: 'EVENT', text: `事件 ${id}`, check: EV(by), basis: ['E1'], tier_if_met: tier });
const priceProp = (id: string) => ({ id, direction: 'DOWN', kind: 'PRICE', text: `收盤跌破 90（${id}）`, check: { type: 'price_close_below', level: 90 }, basis: ['E1'], tier_if_met: 'HALF' });

let seq = 0;
async function reviewPack(c: Ctx) {
  const tf = (await thesisFile(c.db, c.acct, 'NVDA', c.view.date))!;
  return ownReviewPack({ acct: c.acct, view: c.view, axis: c.axis, ticker: 'NVDA', runId: `rev-${++seq}`, trigger: 'EARNINGS', xbrl: null, filings: [TENQ_DOC], news: null, conds: condFacts(tf, null), dataQuality: { filings: 'ok' }, now: new Date('2026-11-20T01:00:00Z') }).pack;
}
/** 套用一次審查（三票）。帳戶的改動（condReviewDue）留在 c.acct。 */
async function apply(c: Ctx, pack: EvidencePack, votes: unknown[]): Promise<ApplyCtx> {
  const outcome = judge(pack, votes, PAYLOAD_HOOKS[OWN_REVIEW]);
  const ctx: ApplyCtx = { db: c.db, acct: c.acct, view: c.view, axis: c.axis, session: c.view.date, now: new Date('2026-11-20T01:30:00Z'), stmts: [], log: [] };
  await applyOwnReview(ctx, { runId: pack.run_id, fn: OWN_REVIEW, ticker: 'NVDA', asOf: c.view.date, outcome, pack } as unknown as AiRun);
  if (ctx.stmts.length) await c.db.batch(ctx.stmts);
  return ctx;
}
/** 三票一致（同一張票三份）的審查。 */
async function review3(c: Ctx, o: VoteOpt = {}) {
  const pack = await reviewPack(c);
  return { pack, ctx: await apply(c, pack, [vote(pack, o), vote(pack, o), vote(pack, o)]) };
}
const op = (c: Ctx, id: number, o: 'accept' | 'retire' | 'action', action?: string) => conditionOp(c.db, c.acct, 'NVDA', id, o, action, '2026-11-20', new Date('2026-11-21T01:00:00Z'));
const urgent = (a: Account) => a.notifs.filter((n) => n.kind === 'URGENT');

function qrow(end: string, gm: number | null): QuarterRow {
  return { end, filed: end.replace(/-\d\d$/, '-28'), form: '10-Q', accn: 'a', revenue: 100, grossProfit: gm === null ? null : gm * 100, operatingIncome: null, netIncome: null, epsDiluted: null, cfo: null, grossMarginPct: gm, operatingMarginPct: null, netMarginPct: null, revenueYoY: null, cfoToNetIncome: null };
}
async function xbrl(c: Ctx, rows: QuarterRow[]): Promise<ApplyCtx> {
  const ctx: ApplyCtx = { db: c.db, acct: c.acct, view: c.view, axis: c.axis, session: '2026-11-23', now: new Date('2026-11-24T00:00:00Z'), stmts: [], log: [] };
  await ownXbrlConditions(ctx, new Map([['NVDA', rows]]));
  await c.db.batch(ctx.stmts);
  return ctx;
}

// ---------------------------------------------------------------- §3：寫入就監測

describe('T71：AI 建議的條件寫入就監測（§3）', () => {
  it('三票一致的建議寫入就是監測中（照確認方式）、動作重新審查、accepted_at 空、tier_if_met 照存；不再寫 PROPOSED；不發通知', async () => {
    await withWorld(async (c) => {
      const { pack, ctx } = await review3(c, { proposed: [xbrlProp('N1', 0.5, 'HALF'), eventProp('N2', ['earnings_call'], 'EXIT'), priceProp('N3')] });
      const after = await conds(c.db);
      expect(after.map((x) => [x.condId, x.status, x.origin, x.action, x.acceptedAt, x.tierIfMet])).toEqual([
        ['N1', 'ACTIVE', 'AI', 'REVIEW', null, 'HALF'],
        ['N2', 'REVIEW_ONLY', 'AI', 'REVIEW', null, 'EXIT'],
        ['N3', 'MANUAL', 'AI', 'REVIEW', null, 'HALF'],
      ]);
      expect(after.every((x) => !isOwned(x) && isAiWatch(x) && x.runId === pack.run_id)).toBe(true);
      expect(after.some((x) => x.status === 'PROPOSED')).toBe(false);
      expect(urgent(ctx.acct)).toEqual([]);
      expect(ctx.log.join('\n')).toContain('寫入 3 條建議的條件（AI 監測中，成立時重新審查）');
      // 持股頁：AI 監測中那一組，寫明 AI 建議的檔位與目前的設定
      const m = await monitorView(c.env, 'NVDA');
      expect(m.map((x) => [x.text, x.owned, x.ai, x.action, x.aiTier])).toEqual([
        ['毛利率低於 50%（N1）', false, true, 'REVIEW', 'AI 建議成立時減半；目前設定是重新審查'],
        ['事件 N2', false, true, 'REVIEW', 'AI 建議成立時出清；目前設定是重新審查'],
        ['收盤跌破 90（N3）', false, true, 'REVIEW', 'AI 建議成立時減半；目前設定是重新審查'],
      ]);
      expect(m[0]).toMatchObject({ code: 'ACTIVE', status: '監測中', origin: 'AI 建議，11/20 的審查寫的', confirm: '新財報出來時比對', recordOnly: false });
      expect(m[2]).toMatchObject({ code: 'MANUAL', recordOnly: true });
      // 下一次審查的證據包：W 是 AI 監測中的條件（照舊要判成不成立）
      const next = await reviewPack(c);
      const w = next.facts.filter((f) => /^W\d$/.test(f.id));
      expect(w.map((f) => f.label.split('（')[0])).toEqual(['AI 監測中的條件 W1', 'AI 監測中的條件 W2', 'AI 監測中的條件 W3']);
      expect(w[0].note).toContain('成立時：重新審查（不會直接通知使用者賣）');
      expect(w[0].note).toContain('AI 建議成立時：減半');
      expect(next.question).toContain('AI 監測中的條件（facts 的 W 開頭）');
      expect(next.question).not.toContain('勾選');
    });
  });

  it('票數不一致不寫入（照舊）：沒有新條件，舊的 AI 條件也不過期', async () => {
    await withWorld(async (c) => {
      const old = await seed(c.db, { condId: 'A1', status: 'ACTIVE', action: 'REVIEW', text: '舊的 AI 條件' });
      const pack = await reviewPack(c);
      const o: VoteOpt = { proposed: [xbrlProp('N1')] };
      const ctx = await apply(c, pack, [vote(pack, o), vote(pack, o), vote(pack, { ...o, verdict: 'EXIT' })]);
      expect(ctx.log.join('\n')).toContain('沒有三票一致的結論，條件不動');
      expect((await conds(c.db)).map((x) => [x.id, x.status])).toEqual([[old, 'ACTIVE']]);
    });
  });

  it('新建議寫入時：還沒成立、使用者沒動過的舊 AI 條件（含舊資料的建議中）EXPIRED；改過動作的、已成立的不動；一條都沒提時留著', async () => {
    await withWorld(async (c) => {
      await review3(c, { proposed: [xbrlProp('A1'), eventProp('A2', ['8-K'])] });
      const [a1, a2] = (await conds(c.db)).map((x) => x.id);
      // 使用者把 A2 改成減半 → 你定的
      expect(await op(c, a2, 'action', 'HALF')).toMatchObject({ status: 'ACTIVE', action: 'HALF' });
      const met = await seed(c.db, { condId: 'A3', status: 'MET', action: 'REVIEW', text: '已經成立的 AI 條件', metAt: '2026-11-20T00:00:00.000Z' });
      const legacy = await seed(c.db, { condId: 'A4', status: 'PROPOSED', text: '改版前的建議' });
      const mine = await seed(c.db, { condId: 'U1', status: 'ACTIVE', origin: 'USER', accepted: true, action: 'EXIT', text: '你寫的' });
      // 一條都沒提：全部留著
      await review3(c);
      expect(await statusOf(c.db)).toEqual({ [a1]: 'ACTIVE', [a2]: 'ACTIVE', [met]: 'MET', [legacy]: 'PROPOSED', [mine]: 'ACTIVE' });
      // 提了一條新的
      await review3(c, { proposed: [xbrlProp('N1', 0.45)] });
      const s = await statusOf(c.db);
      expect([s[a1], s[a2], s[met], s[legacy], s[mine]]).toEqual(['EXPIRED', 'ACTIVE', 'MET', 'EXPIRED', 'ACTIVE']);
      expect(await byId(c.db, a2)).toMatchObject({ action: 'HALF', acceptedAt: '2026-11-21T01:00:00.000Z' });
      expect((await conds(c.db)).filter((x) => isAiWatch(x)).map((x) => x.condId)).toEqual(['N1']);
    });
  });
});

// ---------------------------------------------------------------- 成立時重新審查

describe('T71：AI 監測中的條件成立 → 開審查（condReviewDue），不發甲類通知', () => {
  it('財報比對（程式）、新申報三票（F25）成立 → MET、記 condReviewDue、不通知；沒有動作的舊 AI 列也不照 tier_if_met 通知', async () => {
    await withWorld(async (c) => {
      const x = await seed(c.db, { condId: 'A1', status: 'ACTIVE', action: 'REVIEW', tier: 'EXIT', text: '毛利率低於 55%', check: GM(0.55) });
      const old = await seed(c.db, { condId: 'A2', status: 'ACTIVE', action: null, tier: 'HALF', text: '毛利率低於 58%（舊列，沒有動作）', check: GM(0.58) });
      const r = await xbrl(c, [qrow('2026-09-30', 0.5), qrow('2026-06-30', 0.6)]);
      expect(await byId(c.db, x)).toMatchObject({ status: 'MET', metBasis: 'XBRL' });
      expect(await byId(c.db, old)).toMatchObject({ status: 'MET', metBasis: 'XBRL' });
      expect(urgent(r.acct)).toEqual([]);
      expect(r.acct.own.NVDA.condReviewDue).toBe('2026-11-23');
      expect(r.log.join('\n')).toContain('AI 監測中的財報條件 A1 成立（程式比對 XBRL）（AI 監測中，成立時重新審查）→ 不通知，開一次審查（觸發原因：條件成立）');

      // 新申報（F25）三票確認一條 AI 監測中的事件條件
      const ev = await seed(c.db, { condId: 'A9', kind: 'EVENT', status: 'ACTIVE', action: 'REVIEW', tier: 'EXIT', text: '公司在 8-K 宣布裁員', check: EV(['8-K']) });
      const s = { valid: true, verdict: 'MET', payload: { condition_id: 'A9' }, evidence: [] };
      const outcome = { status: 'AGREED', verdict: 'MET', votes: { MET: 3 }, actionable: true, followRule: false, reason: '', samples: [s, s, s] } as unknown as Outcome;
      const ctx: ApplyCtx = { db: c.db, acct: c.acct, view: c.view, axis: c.axis, session: '2026-11-24', now: new Date('2026-11-25T01:30:00Z'), stmts: [], log: [] };
      await applyOwnCondition(ctx, { runId: 'f25-1', fn: OWN_CONDITION, ticker: 'NVDA', asOf: '2026-11-24', outcome, pack: { documents: [] } } as unknown as AiRun);
      await c.db.batch(ctx.stmts);
      expect(await byId(c.db, ev)).toMatchObject({ status: 'MET', metBasis: 'FILING_VOTE' });
      expect(urgent(ctx.acct)).toEqual([]);
      expect(ctx.acct.own.NVDA.condReviewDue).toBe('2026-11-24');
    });
  });

  it('審查三票確認 AI 監測中的條件（W）成立 → MET（REVIEW_VOTE）；這次審查就是重新審查，不另外開、不通知；舊資料的建議中照舊只是輸入', async () => {
    await withWorld(async (c) => {
      const ro = await seed(c.db, { condId: 'A1', kind: 'EVENT', status: 'REVIEW_ONLY', action: 'REVIEW', tier: 'EXIT', text: '法說會上宣布砍擴產', check: EV(['earnings_call']) });
      const legacy = await seed(c.db, { condId: 'A2', kind: 'EVENT', status: 'PROPOSED', text: '改版前的建議', check: EV(['earnings_call']) });
      const pack = await reviewPack(c);
      expect((pack.rule.detail as { conds: Record<string, number> }).conds).toEqual({ W1: ro, W2: legacy });
      const ctx = await apply(c, pack, [1, 2, 3].map(() => vote(pack, { checks: [['W1', 'MET'], ['W2', 'MET']] })));
      expect(await byId(c.db, ro)).toMatchObject({ status: 'MET', metBasis: 'REVIEW_VOTE' });
      expect((await byId(c.db, legacy)).status).toBe('PROPOSED');
      expect(urgent(ctx.acct)).toEqual([]);
      expect(ctx.acct.own.NVDA.condReviewDue ?? null).toBeNull();
      expect(ctx.log.join('\n')).toContain('AI 監測中的條件 A1 由審查 3 票確認成立（成立時重新審查）→ 這次審查就是重新審查');
      // 下一次審查的證據包：上次審查之後成立的 AI 條件也列（寫已成立）
      const next = await reviewPack(c);
      expect(next.facts.find((f) => f.value === '法說會上宣布砍擴產')?.note).toContain('已成立');
    });
  });
});

// ---------------------------------------------------------------- 改動作 → 你定的

describe('T71：使用者改動作（§3）', () => {
  it('改成減半 → 寫 accepted_at、變你定的（log ACCEPTED）、之後的審查換不掉、成立時發甲類通知；改成重新審查不變；可以撤下；supersedes 的那一條撤下', async () => {
    await withWorld(async (c) => {
      const mine = await seed(c.db, { condId: 'U1', status: 'ACTIVE', origin: 'USER', accepted: true, action: 'EXIT', text: '毛利率低於 58%（你寫的）', check: GM(0.58) });
      await review3(c, { proposed: [xbrlProp('N1', 0.55), xbrlProp('N2', 0.4), { ...xbrlProp('N3', 0.56), supersedes: 'C1' }] });
      const [n1, n2, n3] = (await conds(c.db)).filter((x) => x.origin === 'AI').map((x) => x.id);
      expect((await byId(c.db, n3)).supersedes).toBe(mine);
      expect((await monitorView(c.env, 'NVDA')).find((x) => x.id === n3)!.replaces).toBe('毛利率低於 58%（你寫的）');
      // 改成重新審查：本來就是，不變（不會變成你定的）
      expect(await op(c, n2, 'action', 'REVIEW')).toEqual({ id: n2, status: 'ACTIVE', action: 'REVIEW' });
      expect((await byId(c.db, n2)).acceptedAt).toBeNull();
      // 改成減半 → 你定的
      expect(await op(c, n1, 'action', 'HALF')).toEqual({ id: n1, status: 'ACTIVE', action: 'HALF' });
      const got = await byId(c.db, n1);
      expect(got).toMatchObject({ action: 'HALF', acceptedAt: '2026-11-21T01:00:00.000Z', origin: 'AI' });
      expect(isOwned(got) && !isAiWatch(got)).toBe(true);
      expect((await monitorView(c.env, 'NVDA')).find((x) => x.id === n1)).toMatchObject({ owned: true, ai: false, action: 'HALF', origin: 'AI 建議，你在 11/21 定下' });
      // 帶 supersedes 的改成出清 → 你原本的那條撤下
      expect(await op(c, n3, 'action', 'EXIT')).toEqual({ id: n3, status: 'ACTIVE', action: 'EXIT', retired: mine });
      expect((await byId(c.db, mine)).status).toBe('RETIRED');
      // 撤下 AI 監測中的
      expect(await op(c, n2, 'retire')).toMatchObject({ status: 'RETIRED' });
      const log = (await c.db.prepare("SELECT body FROM own_thesis_log WHERE kind = 'CONDITION' ORDER BY id").all<{ body: string }>()).results.map((r) => JSON.parse(r.body));
      expect(log).toEqual([
        { id: n1, change: 'ACCEPTED', action: 'HALF', by: 'USER', from: 'AI_WATCH' },
        { id: n3, change: 'ACCEPTED', action: 'EXIT', by: 'USER', from: 'AI_WATCH' },
        { id: mine, change: 'RETIRED', action: 'EXIT', by: 'USER' },
        { id: n2, change: 'RETIRED', action: 'REVIEW', by: 'USER', aiWatch: true },
      ]);
      // 之後的審查寫新建議：你定的那條不過期
      await review3(c, { proposed: [xbrlProp('N4', 0.3)] });
      expect([(await byId(c.db, n1)).status, (await byId(c.db, n3)).status]).toEqual(['ACTIVE', 'ACTIVE']);
      // 成立 → 甲類通知（減半）
      const r = await xbrl(c, [qrow('2026-09-30', 0.5), qrow('2026-06-30', 0.6)]);
      const n = urgent(r.acct).find((x) => x.items.some((i) => i.title.includes('毛利率低於 55%（N1）')))!;
      expect(n.items[0]).toMatchObject({ f: 'F25', kind: 'OWN_COND', title: 'NVDA：你在 2026-11-21 定的條件「毛利率低於 55%（N1）」成立' });
      expect(n.items[0].choices[0].tier).toBe('HALF');
      expect(n.items[0].why).toContain('這條是AI 建議，你在 11/21 定下');
    });
  });

  it('網站 API：/api/ops/own-condition 改 AI 監測中的動作與撤下；勾選 AI 監測中的回 422', async () => {
    await withWorld(async (c) => {
      const a = await seed(c.db, { condId: 'A1', status: 'ACTIVE', action: 'REVIEW', text: '毛利率低於 55%' });
      const b = await seed(c.db, { condId: 'A2', status: 'ACTIVE', action: 'REVIEW', text: '毛利率低於 50%', check: GM(0.5) });
      const now = new Date('2026-11-21T02:00:00Z');
      const post = (body: unknown) => handle(new Request('https://bot.example/api/ops/own-condition', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), c.env, fakeFetcher(newWorld('2026-11-19')), now);
      let r = await post({ ticker: 'NVDA', id: a, op: 'action', action: 'EXIT' });
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ ok: true, id: a, status: 'ACTIVE', action: 'EXIT' });
      r = await post({ ticker: 'NVDA', id: b, op: 'retire' });
      expect(await r.json()).toMatchObject({ ok: true, status: 'RETIRED' });
      const s = await seed(c.db, { condId: 'A3', status: 'ACTIVE', action: 'REVIEW' });
      r = await post({ ticker: 'NVDA', id: s, op: 'accept' });
      expect(r.status).toBe(422);
      expect(((await r.json()) as { error: string }).error).toContain('不是建議中的條件');
    });
  });
});

// ---------------------------------------------------------------- 上限

describe('T71：AI 監測中最多 3 條、不佔你定的 8 條', () => {
  it('你定的已經 8 條也照樣寫 AI 監測中（最多 3 條）；8 條算你定的；滿了不能把 AI 的改成你定的，撤下一條之後可以；之後的審查寫入後仍是 3 條', async () => {
    await withWorld(async (c) => {
      expect([MAX_OWNED, MAX_AI_WATCH]).toEqual([8, 3]);
      const mine: number[] = [];
      for (let k = 1; k <= 8; k++) mine.push(await seed(c.db, { condId: `U${k}`, status: k % 2 ? 'ACTIVE' : 'REVIEW_ONLY', origin: 'USER', accepted: true, action: 'HALF', text: `你定的第 ${k} 條` }));
      await review3(c, { proposed: [xbrlProp('N1', 0.5), xbrlProp('N2', 0.45), xbrlProp('N3', 0.4), xbrlProp('N4', 0.35)] });
      let all = await conds(c.db);
      expect(all.filter((x) => isAiWatch(x)).map((x) => x.condId)).toEqual(['N1', 'N2', 'N3']);
      expect(ownedCount(all)).toBe(8);
      const m = await monitorView(c.env, 'NVDA');
      expect([m.filter((x) => x.owned).length, m.filter((x) => x.ai).length]).toEqual([8, 3]);
      // 滿 8 條：AI 的改成減半要先撤下一條
      const n1 = all.find((x) => x.condId === 'N1')!.id;
      await expect(op(c, n1, 'action', 'HALF')).rejects.toThrow(CondError);
      await expect(op(c, n1, 'action', 'HALF')).rejects.toThrow('你定的條件已經有 8 條（上限 8 條），先撤下一條才能再加。');
      expect((await byId(c.db, n1)).acceptedAt).toBeNull();
      await op(c, mine[0], 'retire');
      expect(await op(c, n1, 'action', 'HALF')).toMatchObject({ action: 'HALF' });
      all = await conds(c.db);
      expect([ownedCount(all), all.filter((x) => isAiWatch(x)).length]).toEqual([8, 2]);
      // 下一次審查寫 3 條：剩下的 2 條 AI 的過期，AI 監測中仍是 3 條；你定的 8 條不變
      await review3(c, { proposed: [xbrlProp('N5', 0.3), xbrlProp('N6', 0.25), xbrlProp('N7', 0.2)] });
      all = await conds(c.db);
      expect(all.filter((x) => isAiWatch(x)).map((x) => x.condId)).toEqual(['N5', 'N6', 'N7']);
      expect(ownedCount(all)).toBe(8);
    });
  });
});

// ---------------------------------------------------------------- 舊資料

describe('T71：舊的 PROPOSED 列讀得出來不壞', () => {
  it('持股頁（AI 那一組、標建議中、不給動作）、證據包（舊的觀察項）、討論包、勾選端點照舊', async () => {
    await withWorld(async (c) => {
      const p = await seed(c.db, { condId: 'N1', status: 'PROPOSED', text: '改版前的建議', tier: 'EXIT' });
      const m = (await monitorView(c.env, 'NVDA'))[0];
      expect(m).toMatchObject({ id: p, code: 'PROPOSED', status: '建議中', owned: false, ai: true, aiTier: null, action: 'EXIT', replaces: null });
      const tf = (await thesisFile(c.db, c.acct, 'NVDA', c.view.date))!;
      const f = condFacts(tf, null).facts.find((x) => x.id === 'W1')!;
      expect(f.label).toBe('觀察項 W1（AI 建議、使用者還沒勾選；財報；11/19 的審查寫的）');
      const nums: DiscussionNumbers = { date: '2026-11-19', close: 100, fromHigh: -0.1, ma200: 90, vsMa: 0.1, slow: 'STD', ret1y: 0.2, weight: 0.05, stdWeight: 0.05, ownTotal: 0.1, ownBudget: 0.2, xbrl: null, openedHalf: null };
      expect(discussionPack(tf, nums, 'ROUTINE')).toContain('AI 建議、還沒勾選的（改版前的舊資料，不監測）：');
      // 勾選（舊的端點）照舊可以：變成你定的
      expect(await op(c, p, 'accept', 'HALF')).toMatchObject({ status: 'ACTIVE', action: 'HALF' });
      expect(isOwned(await byId(c.db, p))).toBe(true);
    });
  });

  it('討論包：AI 監測中的另列一段，不混進你定的', async () => {
    await withWorld(async (c) => {
      await seed(c.db, { condId: 'U1', status: 'ACTIVE', origin: 'USER', accepted: true, action: 'EXIT', text: '你寫的條件' });
      await seed(c.db, { condId: 'A1', status: 'ACTIVE', action: 'REVIEW', text: 'AI 監測中的條件' });
      const tf = (await thesisFile(c.db, c.acct, 'NVDA', c.view.date))!;
      const nums: DiscussionNumbers = { date: '2026-11-19', close: 100, fromHigh: -0.1, ma200: 90, vsMa: 0.1, slow: 'STD', ret1y: 0.2, weight: 0.05, stdWeight: 0.05, ownTotal: 0.1, ownBudget: 0.2, xbrl: null, openedHalf: null };
      const t = discussionPack(tf, nums, 'ROUTINE');
      const mineAt = t.indexOf('你定的（目前監測中');
      const aiAt = t.indexOf('AI 監測中（審查建議的，我沒有定');
      expect(mineAt).toBeGreaterThan(0);
      expect(aiAt).toBeGreaterThan(mineAt);
      expect(t.slice(mineAt, aiAt)).toContain('你寫的條件');
      expect(t.slice(mineAt, aiAt)).not.toContain('AI 監測中的條件');
      expect(t.slice(aiAt)).toContain('- AI 監測中的條件（11/19 的審查寫的；監測中）');
    });
  });
});

// ---------------------------------------------------------------- 要看的事

describe('T71：「要看的事」沒有 PROPOSED_CONDS、沒有 NEW_RISK', () => {
  it('種類裡拿掉了；有舊資料的建議中、AI 監測中的條件、審查提到的新風險時都不列', async () => {
    expect(OWN_ATTN.map((k) => k.kind)).not.toContain('PROPOSED_CONDS');
    expect(OWN_ATTN.map((k) => k.kind)).not.toContain('NEW_RISK');
    await withWorld(async (c) => {
      await seed(c.db, { condId: 'N1', status: 'PROPOSED', text: '改版前的建議' });
      await seed(c.db, { condId: 'A1', status: 'ACTIVE', action: 'REVIEW', text: 'AI 監測中' });
      const kinds = (await holdingAttention(c.db, c.acct, c.view, 'NVDA')).map((x) => x.kind);
      expect(kinds).not.toContain('PROPOSED_CONDS');
      expect(kinds).not.toContain('NEW_RISK');
      // 純函式：論點檔有一次審查列了新風險（還沒處理）也不列
      const tf = (await thesisFile(c.db, c.acct, 'NVDA', c.view.date))!;
      const item: NewRiskItem = { k: 0, text: 'NAND 現貨價兩週跌 20%', source_id: 'edgar:x', date: '2026-10-30', quote: Q_FILING, ok: true, doc: { title: '10-Q', date: '2026-10-30', url: null, headline: false } };
      const file: ThesisFile = { ...tf, reviews: [{ runId: 'r1', date: '2026-11-19', fn: 'OWN_REVIEW', label: '定期審查', trigger: 'MONTHLY', status: 'AGREED', verdict: 'HOLD', votes: { HOLD: 3 }, brokenPremises: [], notif: null, response: null, premiseVotes: {}, summary: null, newRisks: [item] }] };
      const all = ownAttention([file], { own: { NVDA: {} as OwnMeta }, rule: c.acct.rule, notifs: [] }, { date: '2026-11-20' });
      expect(all.map((x) => x.kind)).not.toContain('NEW_RISK');
      expect(all.map((x) => x.kind)).not.toContain('PROPOSED_CONDS');
    });
  });
});

// ---------------------------------------------------------------- §4：同一件反覆出現

describe('T71：新風險同一件反覆出現的偵測（§4；T72 才接自動草稿）', () => {
  const it0 = (source_id: string, quote: string, ok = true) => ({ ok, source_id, quote });
  const runOf = (ticker: string, runId: string, items: RiskRun['items']): RiskRun => ({ ticker, runId, items });

  it('兩次不同的審查引用同一份文件的同一段原文 → 那一檔；空白差異算同一段', () => {
    const runs = [runOf('MU', 'r1', [it0('edgar:a', 'NAND spot prices fell 20%'), it0('edgar:b', 'other')]), runOf('MU', 'r2', [it0('edgar:a', '  NAND spot   prices fell 20% ')])];
    expect(repeatedRisks(runs)).toEqual([{ ticker: 'MU', sourceId: 'edgar:a', quote: 'NAND spot prices fell 20%', runIds: ['r1', 'r2'] }]);
    expect(riskRepeatTickers(runs)).toEqual(['MU']);
  });

  it('不同文件的同一段字不算；同一次審查裡兩件引用同一段不算；沒通過檢查的不算；不同檔不混', () => {
    expect(repeatedRisks([runOf('MU', 'r1', [it0('edgar:a', 'same words')]), runOf('MU', 'r2', [it0('web:x.com/1', 'same words')])])).toEqual([]);
    expect(repeatedRisks([runOf('MU', 'r1', [it0('edgar:a', 'same words'), it0('edgar:a', 'same words')])])).toEqual([]);
    expect(repeatedRisks([runOf('MU', 'r1', [it0('edgar:a', 'q')]), runOf('MU', 'r2', [it0('edgar:a', 'q', false)])])).toEqual([]);
    expect(repeatedRisks([runOf('MU', 'r1', [it0('edgar:a', 'q')]), runOf('NVDA', 'r2', [it0('edgar:a', 'q')])])).toEqual([]);
    // 同一次執行重複傳進來也只算一次
    expect(riskRepeatTickers([runOf('MU', 'r1', [it0('edgar:a', 'q')]), runOf('MU', 'r1', [it0('edgar:a', 'q')])])).toEqual([]);
    // 三次裡兩次有：算；兩檔都有：照第一次出現的順序
    const many = [runOf('NVDA', 'n1', [it0('edgar:n', 'x')]), runOf('MU', 'm1', [it0('edgar:m', 'y')]), runOf('MU', 'm2', [it0('edgar:m', 'y')]), runOf('NVDA', 'n2', [it0('edgar:n', 'x')]), runOf('NVDA', 'n3', [])];
    expect(riskRepeatTickers(many)).toEqual(['NVDA', 'MU']);
  });
});
