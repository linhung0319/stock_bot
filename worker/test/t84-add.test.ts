// T84（階段十二）：自選的買（二）——你定的加碼條件、論點還在時的下跌加碼。設計：docs/design/allocation_redesign_2026-11-22.md §4.0、§4.2、§4.4、§4.6、
// 第 5 章、第 9 章 D5、D10。
// 完成條件：
//   加碼條件：own_conditions 的 action 多 FILL、RAISE；成立時只進月報（F28 OWN_ADD，預設照做、不做不用理由），不走甲類；減半中的只標成立；
//     RAISE 和 125% 共用 12 個月；先買一半時 FILL 當成確認（F27）；8 條上限出場＋加碼合計；不收價格條件（改寫、草稿都擋）；AI 監測中的不能變加碼
//   下跌加碼：跌幅審查「都沒有被判不成立」而且每一條可驗證的前提 3 票都判成立、有申報或財報引用、跌幅拆解過核對 → 通知多一個選項（預設不動）；
//     一次下跌一次（OwnMeta.dipAdd）；和 125% 共用 12 個月（BUILD 的補滿不算）；只有預設前提、HALF 沒有；BUILD 時選項是補滿
//   影子紀錄：補滿、加碼、下跌加碼都記三條線；持股頁寫沒提加碼的原因
//   own_check_v7、own_draft_v4 是新檔，舊版留著；run.md 不用改
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { judge, type CheckedSample, type EvidencePack, type PackDoc } from '../src/ai/check';
import { planExits } from '../src/ai/discussion';
import { OWN_DROP, OWN_DROP_PROMPT, dipCheck, dropDecision } from '../src/ai/drops';
import { PAYLOAD_HOOKS } from '../src/ai/hooks';
import { ADD_PRICE_ISSUE, OWN_CHECK_PROMPT, ownCheckPack, ownCheckResult } from '../src/ai/ownCheck';
import { DRAFT_LIMITS, OWN_DRAFT_PROMPT, checkDraft } from '../src/ai/ownDraft';
import { raiseAllowed } from '../src/ai/ownReview';
import type { ApplyCtx } from '../src/app/aiCtx';
import { holdNoticeLine } from '../src/app/line';
import { notifyOwnCondition } from '../src/app/ownAi';
import { confirmPlan } from '../src/app/ownCheckAi';
import { CondError, conditionOp, ownedCount } from '../src/app/ownConds';
import { adoptOwnedCount, draftAdoptPlan } from '../src/app/ownDraft';
import { dropFollowUpText } from '../src/app/pushHold';
import { exitsOf } from '../src/app/site/api';
import type { SiteData } from '../src/app/site/backend';
import { buyBlockedText, holdingDetail, notifView, watchNote } from '../src/app/site/views';
import { ACTION_TEXT, COND_ACTIONS, isAddAction, notifyTier, ruleResponseLogs, sameActionKind, type FileCondition } from '../src/app/thesis';
import {
  DIP_ADD_NOTE,
  RAISE_GAP_DAYS,
  applyDropResult,
  dipOffer,
  missingReasons,
  priceOf,
  respond,
  totalValue,
  type Account,
  type AddNotice,
  type Item,
  type Notif,
} from '../src/engine';
import { freshDb } from './helpers/d1';
import { makeMarket } from './helpers/market';
import { scenarios } from './helpers/scenarios';
import { Sim, type SimDrop } from './helpers/sim';

type Ready = SiteData & { acct: Account; view: NonNullable<SiteData['view']> };
const ready = (sim: Sim): Ready => ({ mode: 'demo', acct: sim.acct, view: sim.pre, axis: sim.market.days.slice(0, sim.d), rankOrder: [], rankSession: null, aiNotes: [], events: [], shadow: [], today: sim.date, warnings: [] });
const item = (n: Notif, f: string, ticker?: string): Item => {
  const it = n.items.find((i) => i.f === f && (!ticker || i.ticker === ticker) && !i.cancelled);
  if (!it) throw new Error(`通知 #${n.id} 沒有 ${f} ${ticker ?? ''}`);
  return it;
};
const sharesOf = (it: Item, id: string) => (it.choices.find((c) => c.id === id)?.lines ?? []).reduce((a, l) => a + l.shares, 0);
const live = (sim: Sim, id: number) => sim.acct.notifs.find((n) => n.id === id)!;

// ================================================================ 動作的種類

describe('T84：成立時的動作多兩個加碼的值（allocation_redesign §4.2）', () => {
  it('COND_ACTIONS 五個值；加碼不走甲類（notifyTier 是 null）；出場與加碼是不同的兩組', () => {
    expect(COND_ACTIONS).toEqual(['EXIT', 'HALF', 'REVIEW', 'FILL', 'RAISE']);
    expect([isAddAction('FILL'), isAddAction('RAISE'), isAddAction('EXIT'), isAddAction(null)]).toEqual([true, true, false, false]);
    expect(notifyTier({ action: 'RAISE', direction: 'UP', tierIfMet: null })).toBeNull();
    expect(notifyTier({ action: 'FILL', direction: 'UP', tierIfMet: 'RAISE' })).toBeNull();
    expect(notifyTier({ action: 'HALF', direction: 'DOWN', tierIfMet: null })).toBe('HALF');
    expect([sameActionKind('EXIT', 'REVIEW'), sameActionKind('FILL', 'RAISE'), sameActionKind('HALF', 'RAISE')]).toEqual([true, true, false]);
    expect(ACTION_TEXT.RAISE).toBe('買進（提高到標準的 125%）');
    expect(ACTION_TEXT.FILL).toBe('買進（補到標準比重）');
  });

  it('編輯論點頁送來的：加碼條件接在出場條件後面；出場最多 6 條、合計最多 8 條（你定的條件的上限）', () => {
    const x = (n: number, action: string) => Array.from({ length: n }, (_, k) => ({ text: `${action} 第 ${k + 1} 條`, action }));
    expect(exitsOf([...x(6, 'HALF'), ...x(2, 'RAISE')]).map((e) => e.action)).toEqual([...Array(6).fill('HALF'), 'RAISE', 'RAISE']);
    expect(() => exitsOf(x(7, 'HALF'))).toThrow('出場條件最多 6 條');
    expect(() => exitsOf([...x(6, 'HALF'), ...x(3, 'FILL')])).toThrow('出場條件加加碼條件最多 8 條');
    expect(() => exitsOf([...x(4, 'EXIT'), ...x(4, 'FILL')])).not.toThrow();
    expect(exitsOf([{ text: '不認得的動作', action: 'BUY' }])[0].action).toBe('REVIEW');
  });

  it('整組取代的對照：字一樣但一個成立時賣、一個成立時買，不算同一條（要送改寫，對照才寫得出「成立時：買進」）', () => {
    const liveConds = [{ id: 1, text: '營業利益率連兩季高於 35%', action: 'HALF' as const, status: 'ACTIVE', code: 'ACTIVE' }];
    expect(planExits([{ text: '營業利益率連兩季高於 35%', action: 'RAISE' }], liveConds)).toMatchObject({ changed: true, sameByText: {} });
    expect(planExits([{ text: '營業利益率連兩季高於 35%', action: 'EXIT' }], liveConds)).toMatchObject({ changed: false, actionChanged: [{ id: 1, action: 'EXIT', was: 'HALF' }] });
    const addLive = [{ id: 2, text: '營業利益率連兩季高於 35%', action: 'RAISE' as const, status: 'ACTIVE', code: 'ACTIVE' }];
    expect(planExits([{ text: '營業利益率連兩季高於 35%', action: 'FILL' }], addLive)).toMatchObject({ changed: false, actionChanged: [{ id: 2, action: 'FILL', was: 'RAISE' }] });
  });
});

// ================================================================ 改寫（own_check_v7）

describe('T84：改寫加碼條件（own_check_v7）：方向 UP、價格條件擋下、對照寫「成立時：買進」', () => {
  const pack = () =>
    ownCheckPack({ runId: 'c1', asOf: '2026-11-23', ticker: 'MU', exits: [{ text: '毛利率連兩季低於 40%', action: 'HALF' }, { text: '營業利益率連兩季高於 35%', action: 'RAISE' }, { text: '跌到 80 就加碼', action: 'FILL' }], held: true, premises: [], condFacts: [], facts: [], hits: [], docs: [], dataQuality: {}, thesisVersion: 2, now: new Date('2026-11-23T12:00:00Z') }).pack;
  const raw = (line: string, kind: string, check: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ id: line.replace('U', 'C'), line, direction: 'DOWN', kind, text: `改寫 ${line}`, check, ...extra });

  it('證據包：題目與 U 的 label 寫出加碼條件與「成立時：買進」；一次最多 8 條', () => {
    const p = pack();
    expect(p.prompt_version).toBe('own_check_v7');
    expect(OWN_CHECK_PROMPT).toBe('own_check_v7');
    expect(p.question).toContain('寫了 1 條出場條件與 2 條加碼條件');
    expect(p.question).toContain('direction 寫 UP');
    expect(p.question).toContain('不收價格條件');
    expect(p.facts.find((f) => f.id === 'U1')!.label).toContain('使用者要的出場條件（整組取代目前監測中的；成立時：減半）');
    expect(p.facts.find((f) => f.id === 'U2')!.label).toBe('使用者要的加碼條件（整組取代目前監測中的；成立時：買進（提高到標準的 125%））');
  });

  it('結果：加碼條件的方向一律 UP、動作照使用者寫的；寫成價格條件的擋下（不能勾、確認時也不收）；出場條件照舊', () => {
    // 改寫回來的結論（格式檢查之後的樣子；價格條件照舊被檢查改標成只記錄）
    const out = { status: 'AGREED', verdict: 'DONE', votes: { DONE: 1 }, reason: null, samples: [{ valid: true, verdict: 'DONE', conditions: [
      { from: 'payload.conditions', auto: true, raw: raw('U1', 'XBRL', { type: 'xbrl_metric_below', metric: 'GrossMarginPct', level: 0.4, quarters: 2 }, { tier_if_met: 'HALF' }) },
      { from: 'payload.conditions', auto: true, raw: raw('U2', 'XBRL', { type: 'xbrl_metric_above', metric: 'OperatingMarginPct', level: 0.35, quarters: 2 }) },
      { from: 'payload.conditions', auto: false, why: '價格條件只記錄、不通知（B-1：價格面交給慢規則）', raw: raw('U3', 'PRICE', { type: 'price_close_below', level: 80 }) },
    ], report: '改寫了三條。' }] } as never;
    const r = ownCheckResult(out, 'MU', [{ text: '毛利率連兩季低於 40%', action: 'HALF' }, { text: '營業利益率連兩季高於 35%', action: 'RAISE' }, { text: '跌到 80 就加碼', action: 'FILL' }]);
    expect(r.conditions.map((c) => [c.condId, c.action, c.direction, c.blocked])).toEqual([
      ['U1', 'HALF', 'DOWN', null],
      ['U2', 'RAISE', 'UP', null],
      ['U3', 'FILL', 'UP', ADD_PRICE_ISSUE],
    ]);
    expect(r.conditions[2]).toMatchObject({ manual: true, then: `不會監測：${ADD_PRICE_ISSUE}` });
    // 確認：擋下的那一條不會被寫進去（就算網頁送了它的編號）
    const plan = confirmPlan(r.conditions, [], [], ['U1', 'U2', 'U3']);
    expect(plan.pick.map((c) => c.condId)).toEqual(['U1', 'U2']);
  });
});

// ================================================================ 持股頁的條件操作

describe('T84：持股頁改動作——出場與加碼不能互換；AI 監測中的不能變加碼；8 條合計', () => {
  const FILE = 'NVDA@2026-11-19';
  const acct = { own: { NVDA: { fileId: FILE } } } as unknown as Account;
  async function seed(db: D1Database, o: { text: string; action: string | null; origin?: string; accepted?: boolean; status?: string; direction?: string }) {
    const r = await db
      .prepare('INSERT INTO own_conditions (ticker, run_id, cond_id, direction, kind, text, check_json, tier_if_met, status, created_at, origin, file_id, accepted_at, action, auto) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind('NVDA', 'r0', 'C1', o.direction ?? 'DOWN', 'XBRL', o.text, JSON.stringify({ type: 'xbrl_metric_above', metric: 'OperatingMarginPct', level: 0.35, quarters: 2 }), null, o.status ?? 'ACTIVE', '2026-11-19T12:00:00.000Z', o.origin ?? 'USER', FILE, o.accepted === false ? null : '2026-11-20T01:00:00.000Z', o.action, 1)
      .run();
    return r.meta.last_row_id;
  }

  it('改動作：加碼只在加碼裡換、出場只在出場裡換；AI 監測中的條件不能改成加碼；8 條上限出場＋加碼一起算', async () => {
    const d = await freshDb();
    try {
      const add = await seed(d.db, { text: '營業利益率連兩季高於 35%', action: 'RAISE', direction: 'UP' });
      const exit = await seed(d.db, { text: '毛利率低於 40%', action: 'HALF' });
      const ai = await seed(d.db, { text: 'AI 建議的條件', action: 'REVIEW', origin: 'AI', accepted: false });
      const op = (id: number, action: string) => conditionOp(d.db, acct, 'NVDA', id, 'action', action, '2026-11-20', new Date('2026-11-21T01:00:00Z'));
      expect(await op(add, 'FILL')).toMatchObject({ action: 'FILL' });
      await expect(op(add, 'EXIT')).rejects.toThrow('加碼條件不能直接改成出場條件');
      await expect(op(exit, 'RAISE')).rejects.toThrow('出場條件不能直接改成加碼條件');
      await expect(op(ai, 'RAISE')).rejects.toThrow(CondError);
      await expect(op(ai, 'FILL')).rejects.toThrow('AI 不能自己提加碼條件');
      expect(await op(exit, 'EXIT')).toMatchObject({ action: 'EXIT' });
      // 8 條：出場 6 條 + 加碼 2 條（含上面那兩條）
      for (let k = 0; k < 5; k++) await seed(d.db, { text: `出場 ${k}`, action: 'HALF' });
      await seed(d.db, { text: '加碼 2', action: 'FILL', direction: 'UP' });
      const { fileConditions } = await import('../src/app/thesis');
      const conds = await fileConditions(d.db, acct, 'NVDA');
      expect(ownedCount(conds)).toBe(8);
    } finally {
      await d.dispose();
    }
  });
});

// ================================================================ 草稿（own_draft_v4）

describe('T84：草稿可以附 0～2 條加碼條件（own_draft_v4）；不收價格條件；採用時一起生效', () => {
  const DOCS: PackDoc[] = [
    { id: 'X', source_id: 'xbrl:MU', kind: 'xbrl', date: '2026-11-20', title: 'XBRL', text: 'Q3 2026 operating margin 29.8% gross margin 61.2%' },
    { id: 'F', source_id: 'edgar:0001', kind: 'filing', date: '2026-11-20', title: '10-Q', text: 'Demand for high bandwidth memory continued to exceed supply during the quarter.' },
  ];
  const pack = { documents: DOCS, premises: [], rule: { action: 'x', detail: {} } } as Pick<EvidencePack, 'documents' | 'premises' | 'rule'>;
  const METRICS = new Set(['GrossMarginPct', 'OperatingMarginPct']);
  const ev = [
    { id: 'E1', source_id: 'xbrl:MU', date: '2026-11-20', quote: 'Q3 2026 operating margin 29.8% gross margin 61.2%', claim: '現在的數字', ok: true },
    { id: 'E2', source_id: 'edgar:0001', date: '2026-11-20', quote: 'Demand for high bandwidth memory continued to exceed supply', claim: '需求', ok: true },
  ];
  const premise = (text: string) => ({ text, keep_id: null, confirms_if: '10-Q 寫需求超過供給', breaks_if: ['下一季 10-Q 寫供給過剩'], verify: { by: 'FILING' }, evidence_ids: ['E2'] });
  const exit = { text: '毛利率連兩季低於 50%', action: 'HALF', kind: 'XBRL', check: { type: 'xbrl_metric_below', metric: 'GrossMarginPct', level: 0.5, quarters: 2 }, premise_index: 0, evidence_ids: ['E1'] };
  const exit2 = { text: '公司在 8-K 宣布下修財測', action: 'REVIEW', kind: 'EVENT', check: { type: 'event', confirm_by: ['8-K'] }, premise_index: null, evidence_ids: [] };
  const sample = (adds: unknown): CheckedSample =>
    ({
      valid: true,
      verdict: 'DONE',
      evidence: ev,
      payload: {
        thesis: '需求延續',
        premises: [premise('HBM 需求超過供給'), premise('合約價逐季上漲'), premise('客戶長約照約履行')],
        exits: [exit, exit2],
        ...(adds === undefined ? {} : { adds }),
        against: [1, 2, 3].map((k) => ({ text: `反方 ${k}`, evidence_ids: ['E2'] })),
        would_buy_today: { answer: 'UNSURE', why: '一句' },
        sources: { peers: [] },
      },
      report: '草稿',
    }) as unknown as CheckedSample;
  const raise = { text: '營業利益率連兩季高於 35%（最新一季 29.8%）', action: 'RAISE', kind: 'XBRL', check: { type: 'xbrl_metric_above', metric: 'OperatingMarginPct', level: 0.35, quarters: 2 }, premise_index: 0, evidence_ids: ['E1'] };

  it('版本；沒寫 adds 照舊過；寫了 0～2 條、格式和出場條件一樣才過', () => {
    expect(OWN_DRAFT_PROMPT).toBe('own_draft_v4');
    expect(DRAFT_LIMITS.addsMax).toBe(2);
    const none = checkDraft(sample(undefined), pack, METRICS);
    expect(none.errors).toEqual([]);
    expect(none.draft!.adds).toBeUndefined();
    const ok = checkDraft(sample([raise, { ...raise, text: '公司在 10-Q 寫 HBM 產能全部被長約訂走', action: 'FILL', kind: 'EVENT', check: { type: 'event', confirm_by: ['10-Q'] } }]), pack, METRICS);
    expect(ok.errors).toEqual([]);
    expect(ok.draft!.adds!.map((a) => [a.action, a.kind])).toEqual([['RAISE', 'XBRL'], ['FILL', 'EVENT']]);
  });

  it('價格條件、超過 2 條、動作不是 FILL／RAISE、格式不合格 → 整份退回', () => {
    const errs = (adds: unknown) => checkDraft(sample(adds), pack, METRICS).errors;
    expect(errs([{ ...raise, kind: 'PRICE', check: null }]).join('；')).toContain('加碼條件不收價格條件');
    expect(errs([raise, raise, raise]).join('；')).toContain('加碼條件最多 2 條');
    expect(errs([{ ...raise, action: 'HALF' }]).join('；')).toContain('action 要是 FILL');
    expect(errs([{ ...raise, check: { type: 'xbrl_metric_above', metric: 'Nope', level: 0.35 } }]).join('；')).toContain('財報條件');
    expect(errs([{ ...raise, kind: 'EVENT', check: { type: 'event' } }]).join('；')).toContain('事件條件');
  });

  it('採用：加碼條件接在出場條件後面一起整組取代（動作照草稿的、狀態照確認方式）；草稿有加碼條件才取代原本的，沒有加碼條件的草稿不動原本的加碼條件（T86 P10）', () => {
    const d = checkDraft(sample([raise]), pack, METRICS).draft!;
    const plan = draftAdoptPlan(d, []);
    expect(plan.add.map((a) => [a.k, a.action, a.status])).toEqual([[0, 'HALF', 'ACTIVE'], [1, 'REVIEW', 'ACTIVE'], [2, 'RAISE', 'ACTIVE']]);
    const liveAdd = [{ id: 9, text: '我自己寫的加碼條件', action: 'FILL' as const, status: 'ACTIVE', code: 'ACTIVE' }];
    // T86 P10：草稿沒有加碼條件 → 不動你自己寫的加碼條件（不撤下、不比對；列在 stay，照樣算在 8 條上限裡）
    const none = draftAdoptPlan(checkDraft(sample(undefined), pack, METRICS).draft!, liveAdd);
    expect(none.retire).toEqual([]);
    expect(none.stay.map((c) => c.id)).toEqual([9]);
    expect(adoptOwnedCount(none, liveAdd)).toBe(adoptOwnedCount({ keep: none.keep, add: none.add }, []) + 1);
    // 出場條件仍然整組取代：現在監測中的出場條件草稿沒有 → 撤下；加碼條件不受影響
    const liveBoth = [...liveAdd, { id: 8, text: '我自己寫的出場條件', action: 'EXIT' as const, status: 'ACTIVE', code: 'ACTIVE' }];
    const mixed = draftAdoptPlan(checkDraft(sample(undefined), pack, METRICS).draft!, liveBoth);
    expect(mixed.retire.map((c) => c.id)).toEqual([8]);
    expect(mixed.stay.map((c) => c.id)).toEqual([9]);
    // 草稿有加碼條件 → 整組取代，你原本的加碼條件撤下（對照照列）
    const some = draftAdoptPlan(d, liveAdd);
    expect(some.stay).toEqual([]);
    expect(some.retire.map((c) => c.id)).toEqual([9]);
  });
});

// ================================================================ 你定的加碼條件成立（F28）

/** 測試用的套用環境（加碼條件成立只用到帳戶、訊號日、紀錄）。 */
function ctxOf(acct: Account, session: string): ApplyCtx {
  return { acct, session, log: [], stmts: [], view: null as never, axis: [], db: null as never, now: new Date(`${session}T12:00:00Z`) };
}
function cond(o: Partial<FileCondition> & { action: FileCondition['action'] }): FileCondition {
  return { id: 41, ticker: 'MSFT', runId: 'chk-1', condId: 'U1', direction: 'UP', kind: 'XBRL', text: '營業利益率連兩季高於 45%', check: {}, tierIfMet: null, status: 'MET', createdAt: '2026-11-20T01:00:00.000Z', metAt: null, note: null, origin: 'USER', fileId: 'MSFT@2026-11-01', acceptedAt: '2026-11-20T01:00:00.000Z', premiseId: null, supersedes: null, metBasis: 'XBRL', verifiedAt: null, progress: null, auto: true, ...o };
}
const untilMonthly = (sim: Sim): Notif => {
  let m: Notif | null = null;
  while (!m && !sim.atEnd()) {
    m = sim.preOpen();
    if (!m) {
      sim.open();
      sim.close();
      sim.d++;
    }
  }
  if (!m) throw new Error('沒有月報');
  return m;
};

describe('T84：你定的加碼條件成立 → 下一份月報的 F28（§4.2、D10）', () => {
  /** 有論點的 MSFT（標準比重 5%）：你在 11/20 定的加碼條件成立。 */
  function met(action: 'RAISE' | 'FILL', prep?: (a: Account) => void) {
    const sim = new Sim(makeMarket('2026-11-23', 50), scenarios.s1().init);
    prep?.(sim.acct);
    const ctx = ctxOf(sim.acct, '2026-11-24');
    notifyOwnCondition(ctx, cond({ action }), '最近 2 季營業利益率 46.0%、47.1%（新到舊）（10-Q 2026-11-20）', ['chk-1'], 'MSFT 財報條件 U1 成立（程式比對 XBRL）');
    sim.acct = ctx.acct;
    return { sim, ctx };
  }

  it('成立時不發當天通知：記進 addMonthly；不開審查（不是重新審查）', () => {
    const { sim, ctx } = met('RAISE');
    expect(sim.acct.notifs.length).toBe(0);
    expect(sim.acct.own.MSFT.condReviewDue).toBeUndefined();
    expect(sim.acct.own.MSFT.addMonthly).toEqual([{ id: 41, text: '營業利益率連兩季高於 45%', action: 'RAISE', setAt: '2026-11-20', why: '最近 2 季營業利益率 46.0%、47.1%（新到舊）（10-Q 2026-11-20）', metOn: '2026-11-24', premiseId: null, runIds: ['chk-1'] } satisfies AddNotice]);
    expect(ctx.log.at(-1)).toContain('進下一份月報（F28），不發當天通知');
  });

  it('F28 照做：預設照做、不用理由；股數 = 標準比重 × 1.25 − 現在；填快照之後標準比重 × 1.25、記 raisedAt；影子紀錄照做了也記', () => {
    const { sim } = met('RAISE');
    const m = untilMonthly(sim);
    const it = item(m, 'F28', 'MSFT');
    const want = Math.floor((0.05 * 1.25 * totalValue(sim.acct, sim.pre)) / priceOf(sim.pre, 'MSFT') + 1e-9) - sim.acct.lots.own.MSFT;
    expect(it).toMatchObject({ kind: 'OWN_ADD', choice: 'DO', ruleChoice: 'DO', runIds: ['chk-1'] });
    expect(it.reasonRequired).toBeUndefined();
    expect(it.title).toBe(`MSFT：你在 2026-11-20 定的加碼條件「營業利益率連兩季高於 45%」成立 → 提高到標準的 125%，買 ${want} 股`);
    expect(it.choices.map((c) => [c.id, c.label])).toEqual([['DO', `照做：提高到標準的 125%，買 ${want} 股`], ['SKIP', '這次不做']]);
    expect(sharesOf(it, 'DO')).toBe(want);
    expect(sim.acct.own.MSFT.addMonthly).toBeUndefined();
    // 網站：名字、理由
    const iv = notifView(ready(sim), m).items.find((x) => x.key === it.key)!;
    expect(iv.label).toBe('你定的加碼條件成立');
    expect(iv.explain.short).toBe('你定的加碼條件成立：營業利益率連兩季高於 45%');
    expect(iv.explain.choiceNotes!.SKIP).toContain('不用寫理由');
    expect(missingReasons(m, { mode: 'DO', choices: { [it.key]: 'SKIP' } })).toEqual([]);
    sim.respond(m.id);
    expect(sim.acct.shadow.find((s) => s.f === 'F28')).toMatchObject({ ticker: 'MSFT', rule: want, ai: null, actual: want, choice: 'DO' });
    sim.open();
    expect(sim.acct.rule.own.MSFT.stdWeight).toBeCloseTo(0.0625, 12);
    expect(sim.acct.own.MSFT.raisedAt).toBe(sim.pre.date);
  });

  it('F28 不做：不買、不用理由、標準比重不變；條件已經用掉（下一份月報不再列）；影子紀錄記下規則的股數', () => {
    const { sim } = met('RAISE');
    const m = untilMonthly(sim);
    const it = item(m, 'F28', 'MSFT');
    const after = respond(sim.acct, sim.pre, m.id, { mode: 'DO', choices: { [it.key]: 'SKIP' } });
    expect(after.shadow.find((s) => s.f === 'F28')).toMatchObject({ rule: sharesOf(it, 'DO'), actual: 0, choice: 'SKIP' });
    sim.acct = after;
    sim.open();
    expect(sim.acct.rule.own.MSFT.stdWeight).toBe(0.05);
    expect(sim.acct.own.MSFT.raisedAt).toBeNull();
    sim.close();
    sim.d++;
    expect(untilMonthly(sim).items.some((i) => i.f === 'F28')).toBe(false);
  });

  it('減半中的 FILL（與 RAISE）只標成立：不進月報、不提加碼；持股頁寫「條件成立；這檔在減半中，加回看 200 日線」', () => {
    const { sim, ctx } = met('FILL', (a) => {
      a.own.MSFT.slow = { ...a.own.MSFT.slow, state: 'HALF' };
      a.rule.own.MSFT.applied = 'HALF';
    });
    expect(sim.acct.own.MSFT.addMonthly).toBeUndefined();
    expect(ctx.log.at(-1)).toContain('這檔在減半中，只標成立、不提加碼');
    expect(sim.acct.own.MSFT.buyBlocked).toMatchObject({ what: '加碼', line: '你定的加碼條件「營業利益率連兩季高於 45%」成立；這檔在減半中，加回看 200 日線' });
    expect(buyBlockedText(sim.acct.own.MSFT, null, '2026-11-25')).toBe('你定的加碼條件「營業利益率連兩季高於 45%」成立；這檔在減半中，加回看 200 日線。加碼條件只成立一次，要再用就到編輯論點頁重新定一條。');
    expect(untilMonthly(sim).items.some((i) => i.f === 'F28')).toBe(false);
    // 持股頁那一行
    const hd = holdingDetail(ready(sim), 'MSFT')!;
    expect(JSON.stringify(hd)).toContain('這檔在減半中，加回看 200 日線');
  });

  it('RAISE 和 125% 共用 12 個月：上次提高（AI 的 125%、下跌加碼、你定的條件）未滿 12 個月 → 不列、持股頁寫原因，不留到下個月；照做之後 AI 的 125% 也要等 12 個月', () => {
    expect(RAISE_GAP_DAYS).toBe(365);
    const { sim } = met('RAISE', (a) => (a.own.MSFT.raisedAt = '2026-06-01'));
    const m = untilMonthly(sim);
    expect(m.items.some((i) => i.f === 'F28')).toBe(false);
    expect(sim.acct.own.MSFT.buyBlocked).toMatchObject({ what: '加碼', text: '上次提高到 125% 是 2026-06-01，還沒滿 12 個月（和 AI 提的 125% 共用間隔）' });
    expect(buyBlockedText(sim.acct.own.MSFT, null, sim.pre.date)).toBe('加碼條件成立，但上次提高到 125% 是 2026-06-01，還沒滿 12 個月（和 AI 提的 125% 共用間隔），這次不提加碼。加碼條件只成立一次，要再用就到編輯論點頁重新定一條。');
    // 照做了 F28 RAISE → AI 的 125% 要等 12 個月
    const ok = met('RAISE');
    const m2 = untilMonthly(ok.sim);
    ok.sim.respond(m2.id);
    ok.sim.open();
    expect(raiseAllowed(ok.sim.acct, 'MSFT', ok.sim.pre.date, { revenue: { ok: true, why: 'x' } })).toMatchObject({ ok: false, why: `上次提高是 ${ok.sim.acct.own.MSFT.raisedAt}，未滿 12 個月` });
  });

  it('買進前的程式檢查（§4.0）沒過：同一個月有前提被判不成立 → 不列，持股頁寫原因', () => {
    const { sim } = met('RAISE', (a) => (a.own.MSFT.brokenAt = '2026-11-25'));
    const m = untilMonthly(sim);
    expect(m.items.some((i) => i.f === 'F28')).toBe(false);
    expect(sim.acct.own.MSFT.buyBlocked).toMatchObject({ what: '加碼', text: '11/25 有前提被判不成立' });
  });

  it('先買一半時 FILL 成立 = 先買一半的確認（兩者先到的算）：下一份月報列的是補滿（F27），不另列 F28；RAISE 則直接提高到 125% 並離開先買一半', () => {
    const toBuild = (a: Account) => {
      a.own.MSFT.slow = { ...a.own.MSFT.slow, state: 'BUILD' };
      a.own.MSFT.build = { since: '2026-11-01', confirmBy: 'EARNINGS', misses: 0 };
      a.rule.own.MSFT = { applied: 'BUILD', stdWeight: 0.08 };
    };
    const { sim, ctx } = met('FILL', toBuild);
    expect(sim.acct.own.MSFT.build!.ok).toMatchObject({ date: '2026-11-24', text: '你在 11/20 定的加碼條件「營業利益率連兩季高於 45%」成立', cond: true });
    expect(sim.acct.own.MSFT.addMonthly).toBeUndefined();
    expect(ctx.log.at(-1)).toContain('當成先買一半的確認');
    const m = untilMonthly(sim);
    expect(m.items.some((i) => i.f === 'F28')).toBe(false);
    const f27 = item(m, 'F27', 'MSFT');
    expect(f27.title).toContain('先買的一半已確認（你在 11/20 定的加碼條件「營業利益率連兩季高於 45%」成立）');
    expect(f27.why).toContain('兩者先到的算');
    // RAISE：照做時先離開先買一半、再提高
    const r = met('RAISE', toBuild);
    const m2 = untilMonthly(r.sim);
    const f28 = item(m2, 'F28', 'MSFT');
    expect(f28.choices[0].effects).toEqual([{ type: 'BUILD_END', ticker: 'MSFT', keep: false }, { type: 'APPLY_TIER', ticker: 'MSFT', tier: 'RAISE' }]);
    expect(m2.items.some((i) => i.f === 'F27')).toBe(false);
    r.sim.respond(m2.id);
    r.sim.open();
    expect([r.sim.acct.own.MSFT.build, r.sim.acct.rule.own.MSFT.applied]).toEqual([undefined, 'STD']);
    expect(r.sim.acct.rule.own.MSFT.stdWeight).toBeCloseTo(0.1, 12);
  });

  it('同一份月報同一檔只列一項加碼（提高到 125% 優先），另一條寫持股頁；AI 的 125%（F23）不另外列', () => {
    const { sim } = met('RAISE');
    sim.acct.own.MSFT.addMonthly!.push({ id: 42, text: '另一條', action: 'FILL', setAt: '2026-11-20', why: 'x', metOn: '2026-11-24' });
    sim.acct.own.MSFT.aiTier = { tier: 'RAISE', date: '2026-11-24', suggest: true, runId: 'rev-9' };
    const m = untilMonthly(sim);
    expect(m.items.filter((i) => i.f === 'F28').map((i) => i.title)).toEqual([expect.stringContaining('提高到標準的 125%')]);
    expect(m.items.some((i) => i.f === 'F23')).toBe(false);
    expect(sim.acct.own.MSFT.buyBlocked!.line).toContain('同一份月報已經列了這檔的另一條加碼條件');
  });

  it('AI 監測中的條件就算寫了加碼的動作也不會照加碼處理（成立時只開重新審查）', () => {
    const sim = new Sim(makeMarket('2026-11-23', 50), scenarios.s1().init);
    const ctx = ctxOf(sim.acct, '2026-11-24');
    notifyOwnCondition(ctx, cond({ action: 'RAISE', origin: 'AI', acceptedAt: null }), 'x', [], 'AI 監測中的條件');
    expect(ctx.acct.own.MSFT.addMonthly).toBeUndefined();
    expect(ctx.acct.own.MSFT.condReviewDue).toBe('2026-11-24');
  });
});

// ================================================================ 下跌加碼（§4.4、D5）

const PRICE_DOC: PackDoc = { id: 'P', source_id: 'price:MU', kind: 'price', date: '2026-11-23', title: 'p', text: '2026-11-23 MU close 70.00' };
const FILING_DOC: PackDoc = { id: 'D1', source_id: 'edgar:0001-26-000001', kind: 'filing', date: '2026-11-20', title: '10-Q 2026-11-20', text: 'Demand for high bandwidth memory continued to exceed supply and contract prices rose.' };
const MARKET_ATTR = { stock: -0.25, market: -0.2, sector: null, idio: -0.05 };
function dropPack(attr: unknown = MARKET_ATTR): EvidencePack {
  return {
    pack_version: 1,
    run_id: 'r',
    function: OWN_DROP,
    prompt_version: OWN_DROP_PROMPT,
    as_of: '2026-11-23',
    created_at: '2026-11-23T23:40:00Z',
    subject: { ticker: 'MU' },
    question: 'q',
    policy: { level: 'A3', verdicts: ['EXIT', 'HALF', 'HOLD'], abstain: 'HOLD', min_evidence: 1, samples: 3 },
    rule: { action: '不動', detail: { urgent: true, attr } },
    facts: [],
    premises: [
      { id: 'P1', text: 'HBM 長約有價格保護' },
      { id: 'P2', text: 'AI 需求延續到 2027' },
    ],
    documents: [PRICE_DOC, FILING_DOC],
    data_quality: {},
    condition_types: [],
  };
}
const EV = {
  price: { id: 'E1', source_id: 'price:MU', date: '2026-11-23', quote: '2026-11-23 MU close 70.00', claim: '價格' },
  filing: { id: 'E2', source_id: 'edgar:0001-26-000001', date: '2026-11-20', quote: 'Demand for high bandwidth memory continued to exceed supply', claim: '需求' },
};
const hv = (premises: [string, string, keyof typeof EV][]) => ({ verdict: 'HOLD', premise_checks: premises.map(([id, status, ev]) => ({ premise_id: id, status, evidence_ids: [EV[ev].id] })), evidence: Object.values(EV), payload: { tier: 'HOLD', cause_class: 'MARKET' }, report: '測試' });
const decide = (pack: EvidencePack, v: unknown) => dropDecision(judge(pack, [v, v, v], PAYLOAD_HOOKS[OWN_DROP]), pack);

describe('T84：下跌加碼的審查面（dropDecision 的 dip，純函式）', () => {
  it('每一條前提 3 票都判成立、有申報或財報引用、個股自身不超過整段一半 → dip.ok；這只是「不減半」之上更嚴的一層', () => {
    const d = decide(dropPack(), hv([['P1', 'HOLDS', 'filing'], ['P2', 'HOLDS', 'filing']]));
    expect(d.status).toBe('CLEAR');
    expect(d.dip).toEqual({ ok: true, why: '3 票都判 2 條前提成立（有申報或財報的引用）；個股自身的跌幅不超過整段的一半' });
  });

  it('不給：有一條證據不足、成立只靠價格或網頁、個股自身超過一半、拆解算不出來；不是 CLEAR 的根本沒有 dip', () => {
    expect(decide(dropPack(), hv([['P1', 'HOLDS', 'filing'], ['P2', 'INSUFFICIENT', 'price']])).dip).toEqual({ ok: false, why: '不是每一條前提都三票判成立' });
    expect(decide(dropPack(), hv([['P1', 'HOLDS', 'filing'], ['P2', 'HOLDS', 'price']])).dip).toEqual({ ok: false, why: '判成立的前提有的只靠網頁（沒有申報或財報的引用）' });
    expect(decide(dropPack({ stock: -0.25, market: -0.05, sector: null, idio: -0.2 }), hv([['P1', 'HOLDS', 'filing'], ['P2', 'HOLDS', 'filing']])).dip).toEqual({ ok: false, why: '這次下跌有一半以上是這檔自己跌的（個股 -25%、個股自身 -20%）' });
    expect(decide(dropPack(null), hv([['P1', 'HOLDS', 'filing'], ['P2', 'HOLDS', 'filing']])).dip).toEqual({ ok: false, why: '這次下跌有一半以上是這檔自己跌的（跌幅拆解算不出來）' });
    const split = dropDecision(judge(dropPack(), [hv([['P1', 'HOLDS', 'filing'], ['P2', 'HOLDS', 'filing']]), hv([['P1', 'HOLDS', 'filing'], ['P2', 'HOLDS', 'filing']]), { ...hv([['P1', 'HOLDS', 'filing']]), verdict: 'HALF', payload: { tier: 'HALF', cause_class: 'MARKET' } }], PAYLOAD_HOOKS[OWN_DROP]), dropPack());
    expect(split.status).toBe('SPLIT');
    expect(split.dip).toBeUndefined();
    // dipCheck 本身
    expect(dipCheck([], dropPack()).ok).toBe(false);
  });
});

/** NVDA（有論點，標準比重 5%）跌 23.5% 之後橫盤再大漲；flat = false 時一路跌過 -30%、-40%。drops：審查的結果。 */
function ladder(o: { flat?: boolean; drops?: Record<string, SimDrop>; build?: boolean } = {}) {
  const path = o.flat
    ? [{ n: 8, ret: 0.02 }, { n: 4, ret: -0.235 }, { n: 28, ret: 0.0, vol: 0.15 }, { n: 70, ret: 0.9 }]
    : [{ n: 8, ret: 0.02 }, { n: 4, ret: -0.235 }, { n: 8, ret: -0.13 }, { n: 8, ret: -0.16 }, { n: 20, ret: 0.02 }, { n: 62, ret: 1.1 }];
  const market = makeMarket('2026-11-23', 110, { over: { NVDA: { r252: 0.55, path } } });
  const sim = new Sim(market, scenarios.s1().init, { drops: o.drops });
  if (o.build) {
    sim.acct.own.NVDA.slow = { ...sim.acct.own.NVDA.slow, state: 'BUILD' };
    sim.acct.own.NVDA.build = { since: '2026-11-01', confirmBy: 'EARNINGS', misses: 0 };
    sim.acct.rule.own.NVDA = { applied: 'BUILD', stdWeight: 0.05 };
  }
  return sim;
}
const DIP_OK = { ok: true, why: '3 票都判 1 條前提成立（有申報或財報的引用）；個股自身的跌幅不超過整段的一半' };
const clear = (dip: { ok: boolean; why: string } = DIP_OK): SimDrop => ({ status: 'CLEAR', runId: 'drop-1', extra: { dip } });
const nvdaNotifs = (sim: Sim) => sim.acct.notifs.filter((n) => n.items.some((i) => i.f === 'F7' && i.ticker === 'NVDA'));
function untilReview(sim: Sim, k = 1): Notif {
  while (nvdaNotifs(sim).length < k && !sim.atEnd()) sim.day({ afterMonthly: (m) => sim.respond(m.id) });
  const n = nvdaNotifs(sim)[k - 1];
  if (!n) throw new Error(`NVDA 沒有第 ${k} 則 F7 通知`);
  return n;
}

describe('T84：下跌加碼出現在跌幅審查的通知上（§4.4）', () => {
  it('出現：前提都沒有被判不成立、審查面過了 → 多一個「加碼：提高到標準的 125%」；預設仍是不動；說明固定那一句；LINE 那一行多半句', () => {
    const sim = ladder({ flat: true, drops: { NVDA: clear() } });
    const n = untilReview(sim);
    const it = item(live(sim, n.id), 'F7', 'NVDA');
    const meta = sim.acct.own.NVDA;
    // untilReview 走完那一天：審查那天的收盤是 sim.pre
    const want = Math.floor((0.05 * 1.25 * totalValue(sim.acct, sim.pre)) / priceOf(sim.pre, 'NVDA') + 1e-9) - sim.acct.lots.own.NVDA;
    expect(want).toBeGreaterThan(0);
    expect(it.drop).toBe('CLEAR');
    expect(it.choices.map((c) => [c.id, c.label])).toEqual([['SKIP', '不動'], ['RULE', '減半'], ['AI', `加碼：提高到標準的 125%，買 ${want} 股`]]);
    expect(it.choice).toBe('SKIP');
    expect(it.ruleChoice).toBe('RULE');
    expect(it.dipAdd).toEqual({ mode: 'RAISE', shares: want, note: DIP_ADD_NOTE });
    expect(DIP_ADD_NOTE).toBe('AI 檢查的是論點有沒有壞，不是會不會繼續跌。下跌時加碼，跌更深時虧得更多；這一次下跌只會提這一次。');
    expect(it.choices[2].effects).toEqual([{ type: 'DIP_ADD', ticker: 'NVDA', episode: meta.watchSince }, { type: 'APPLY_TIER', ticker: 'NVDA', tier: 'RAISE' }]);
    expect(meta.watchSince).toBe(n.date);
    expect(meta.dipAdd).toEqual({ episode: n.date, level: 0, offered: n.date });
    expect(meta.dropReview!.dipOffer).toEqual({ ok: true, why: DIP_OK.why, mode: 'RAISE', shares: want });
    // 仍是「預設不下單」的通知（不提醒、2 個交易日自動結案）
    expect(holdNoticeLine(it)).toBe(`NVDA 比高點低 ${/比 52 週高點低 ([\d.]+%)/.exec(it.title)![1]}：論點檢查（3 票）前提都沒有被判不成立，不減半。不用下單；這次多一個下跌加碼的選項（提高到標準的 125%，買 ${want} 股，預設不動），要的話到網站選。`);
    expect(dropFollowUpText('NVDA', 'CLEAR', n.id, it.dipAdd)).toBe(`NVDA 的 AI 論點檢查回來了：前提都沒有被判不成立，不減半。不用下單；通知 #${n.id} 多一個下跌加碼的選項（提高到標準的 125%，買 ${want} 股，預設不動），要的話到網站選。`);
    // 網站：選項標題不換成「照 AI」、說明有固定那一句、「沒選就是這個」標在不動
    const iv = notifView(ready(sim), live(sim, n.id)).items.find((x) => x.key === it.key)!;
    expect(iv.choices.map((c) => [c.id, c.label, c.isDefault])).toEqual([['SKIP', '不動', true], ['RULE', '減半', false], ['AI', `加碼：提高到標準的 125%，買 ${want} 股`, false]]);
    expect(iv.choices[2].note).toContain(DIP_ADD_NOTE);
    expect(iv.explain.facts?.find((f) => f.label === '下跌加碼')?.value).toBe(`提高到標準的 125%，買 ${want} 股`);
    // 持股頁
    expect(watchNote(sim.acct, 'NVDA', -0.23)).toContain('；通知上有下跌加碼的選項（提高到標準的 125%，預設不動）');
  });

  it('照做：買進、標準比重 × 1.25、raisedAt 與 dipAdd.at 記那天；影子紀錄三條線（規則 = 減半、AI = 0、實際 = 買進）；論點檔記 DIP_ADD；同一次下跌更深一級不再提', () => {
    const sim = ladder({ drops: { NVDA: clear() } });
    const n = untilReview(sim);
    const it = item(live(sim, n.id), 'F7', 'NVDA');
    const n0 = it.dipAdd!.shares;
    const had = sim.acct.lots.own.NVDA;
    sim.respond(n.id, { mode: 'DO', choices: { [it.key]: 'AI' } });
    expect(live(sim, n.id).status).toBe('RESPONDED');
    const sh = sim.acct.shadow.at(-1)!;
    expect(sh).toMatchObject({ f: 'F7', ticker: 'NVDA', ai: 0, actual: n0, choice: 'AI', note: '下跌加碼：提高到標準的 125%' });
    expect(sh.rule).toBeLessThan(0);
    const logs = ruleResponseLogs(sim.acct, live(sim, n.id), sim.date);
    expect(logs[0].body).toMatchObject({ outcome: 'DIP_ADD', aiOffered: 'HOLD', dipAdd: { mode: 'RAISE', shares: n0 } });
    sim.open();
    const meta = sim.acct.own.NVDA;
    expect(sim.acct.lots.own.NVDA).toBe(had + n0);
    expect(sim.acct.rule.own.NVDA.stdWeight).toBeCloseTo(0.0625, 12);
    expect(meta.raisedAt).toBe(sim.pre.date);
    expect(meta.dipAdd!.at).toBe(sim.pre.date);
    expect(meta.slow.state).toBe('WATCH');
    expect(watchNote(sim.acct, 'NVDA', -0.23)).toContain(`；這次下跌選了加碼（${Number(sim.pre.date.slice(5, 7))}/${Number(sim.pre.date.slice(8, 10))}）`);
    // 又跌一級：照樣審查，結果一樣是都沒有被判不成立，但同一次下跌不再提加碼
    const n2 = untilReview(sim, 2);
    const it2 = item(live(sim, n2.id), 'F7', 'NVDA');
    expect(it2.thesisDrop!.level).toBeGreaterThan(0);
    expect(it2.choices.map((c) => c.id)).toEqual(['SKIP', 'RULE']);
    expect(it2.dipAdd).toBeUndefined();
    expect(sim.acct.own.NVDA.dropReview!.dipOffer).toMatchObject({ ok: false });
  });

  it('一次下跌一次：第一級提過但沒選，更深一級不再提（原因寫在持股頁）', () => {
    const sim = ladder({ drops: { NVDA: clear() } });
    const n = untilReview(sim);
    expect(item(live(sim, n.id), 'F7', 'NVDA').dipAdd).toBeTruthy();
    const n2 = untilReview(sim, 2);
    const it2 = item(live(sim, n2.id), 'F7', 'NVDA');
    expect(it2.dipAdd).toBeUndefined();
    expect(sim.acct.own.NVDA.dropReview!.dipOffer).toEqual({ ok: false, why: '這一次下跌已經在比高點低 20% 那一級提過加碼（一次下跌只提一次）' });
    expect(watchNote(sim.acct, 'NVDA', -0.33)).toContain('；沒有提下跌加碼：這一次下跌已經在比高點低 20% 那一級提過加碼（一次下跌只提一次）');
  });

  it('不出現的每一個條件：審查面沒過、票數不一致／沒跑完、和 125% 的 12 個月間隔、只有預設前提、減半中、硬事件標記、30 天內前提被判不成立、已經到 125%', () => {
    // 審查面沒過
    const s1 = ladder({ flat: true, drops: { NVDA: clear({ ok: false, why: '判成立的前提有的只靠網頁（沒有申報或財報的引用）' }) } });
    const n1 = untilReview(s1);
    expect(item(live(s1, n1.id), 'F7', 'NVDA').choices.map((c) => c.id)).toEqual(['SKIP', 'RULE']);
    expect(watchNote(s1.acct, 'NVDA', -0.23)).toContain('；沒有提下跌加碼：判成立的前提有的只靠網頁（沒有申報或財報的引用）');
    // 票數不一致、沒跑完：沒有 dip、也沒有選項
    for (const status of ['SPLIT', 'NONE'] as const) {
      const s = ladder({ flat: true, drops: { NVDA: { status, extra: { dip: DIP_OK } } } });
      const n = untilReview(s);
      expect(item(live(s, n.id), 'F7', 'NVDA').dipAdd, status).toBeUndefined();
    }
    // 其他限制：直接用 dipOffer 看同一個帳戶改一個地方
    const base = ladder({ flat: true, drops: { NVDA: clear() } });
    const nb = untilReview(base);
    const key = item(live(base, nb.id), 'F7', 'NVDA').key;
    const why = (prep: (a: Account) => void) => {
      const a = structuredClone(base.acct);
      a.own.NVDA.dipAdd = null;
      prep(a);
      return dipOffer(a, base.pre, 'NVDA', 0, key);
    };
    expect(why(() => {})).toMatchObject({ ok: true, mode: 'RAISE' });
    expect(why((a) => (a.own.NVDA.raisedAt = base.pre.date))).toMatchObject({ ok: false, why: `上次提高到 125% 是 ${base.pre.date}，還沒滿 12 個月（和提高到 125% 共用間隔）` });
    expect(why((a) => (a.own.NVDA.premises = a.own.NVDA.premises.map((p) => ({ ...p, origin: 'SYSTEM_DEFAULT' as const }))))).toMatchObject({ ok: false, why: '這檔只有系統預設前提' });
    expect(why((a) => (a.rule.own.NVDA.applied = 'HALF'))).toMatchObject({ ok: false, why: '這檔在減半中' });
    expect(why((a) => (a.own.NVDA.flags = ['ACCOUNTING']))).toMatchObject({ ok: false, why: '這檔有未解除的硬事件標記（ACCOUNTING）' });
    expect(why((a) => (a.own.NVDA.brokenAt = base.pre.date))).toMatchObject({ ok: false, why: expect.stringContaining('有前提被判不成立') });
    expect(why((a) => (a.lots.own.NVDA = 10_000))).toMatchObject({ ok: false, why: '現在的持股已經到標準的 125%' });
    // 這一項本身不算「還沒結案的跌幅審查」；別的還沒回覆的跌幅審查項目才算
    expect(dipOffer(base.acct, base.pre, 'NVDA', 0).ok).toBe(false);
  });

  it('先買一半（BUILD）時選項是補滿到標準比重（不看 12 個月間隔）；照做 → 離開先買一半，raisedAt 不記', () => {
    const sim = ladder({ flat: true, build: true, drops: { NVDA: clear() } });
    sim.acct.own.NVDA.raisedAt = '2026-10-01'; // 補滿不算提高，不受間隔限制
    const n = untilReview(sim);
    const it = item(live(sim, n.id), 'F7', 'NVDA');
    const want = Math.floor((0.05 * totalValue(sim.acct, sim.pre)) / priceOf(sim.pre, 'NVDA') + 1e-9) - sim.acct.lots.own.NVDA;
    expect(sim.acct.own.NVDA.slow.state).toBe('WATCH');
    expect(sim.acct.rule.own.NVDA.applied).toBe('BUILD');
    expect(it.choices.find((c) => c.id === 'AI')).toMatchObject({ label: `補滿到標準比重，買 ${want} 股`, effects: [{ type: 'DIP_ADD', ticker: 'NVDA', episode: n.date }, { type: 'BUILD_END', ticker: 'NVDA', keep: false }] });
    expect(it.dipAdd!.mode).toBe('FILL');
    sim.respond(n.id, { mode: 'DO', choices: { [it.key]: 'AI' } });
    sim.open();
    expect([sim.acct.own.NVDA.build, sim.acct.rule.own.NVDA.applied, sim.acct.rule.own.NVDA.stdWeight, sim.acct.own.NVDA.raisedAt]).toEqual([undefined, 'STD', 0.05, '2026-10-01']);
    expect(sim.acct.own.NVDA.dipAdd!.at).toBe(sim.pre.date);
  });

  it('沒有選、2 個交易日自動結案：照預設不動，影子紀錄 AI = 0、實際 = 0', () => {
    const sim = ladder({ flat: true, drops: { NVDA: clear() } });
    const n = untilReview(sim);
    for (let k = 0; k < 3; k++) sim.day();
    expect(live(sim, n.id).status).toBe('AUTO_DEFAULT');
    expect(sim.acct.shadow.find((s) => s.notif === n.id)).toMatchObject({ ai: 0, actual: 0, choice: 'SKIP' });
    expect(sim.acct.own.NVDA.raisedAt).toBeNull();
  });

  it('選了下跌加碼不算「已經選了要賣」：之後才回來的前提不成立照樣另外給減半', () => {
    const sim = ladder({ flat: true, drops: { NVDA: clear() } });
    const n = untilReview(sim);
    const it = item(live(sim, n.id), 'F7', 'NVDA');
    sim.respond(n.id, { mode: 'DO', choices: { [it.key]: 'AI' } });
    sim.acct.own.NVDA.dropReview = { ...sim.acct.own.NVDA.dropReview!, status: 'BROKEN', premiseId: 'P1' };
    const r = applyDropResult(sim.acct, sim.pre, 'NVDA');
    expect(r.route === 'SAME_DAY' || r.route === 'MONTHLY').toBe(true);
  });
});

// ================================================================ prompt 升版

describe('T84 prompt：own_check_v7、own_draft_v4 是新檔，舊版留著；run.md 照 prompt_version 找檔', () => {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'ai', 'prompts');
  const read = (f: string) => readFileSync(join(ROOT, f), 'utf8');
  it('檔頭與內容', () => {
    expect(read('own_check_v7.md').split('\n')[0]).toBe('# own_check_v7：出場條件與加碼條件的改寫與對照（F14）');
    expect(read('own_check_v7.md')).toContain('**加碼條件寫 `UP`**');
    expect(read('own_check_v7.md')).toContain('**加碼條件不收價格條件**');
    expect(read('own_check_v6.md').split('\n')[0]).toContain('> 不再使用（2026-11-23）：T84 起改用 `own_check_v7.md`');
    expect(read('own_draft_v4.md').split('\n')[0]).toBe('# own_draft_v4：論點草稿（OWN_DRAFT）');
    expect(read('own_draft_v4.md')).toContain('`adds`，0～2 條');
    expect(read('own_draft_v4.md')).toContain('**不能是 `PRICE`**');
    expect(read('own_draft_v3.md').split('\n')[0]).toContain('> 不再使用（2026-11-23）：T84 起改用 `own_draft_v4.md`');
    const run = read('run.md');
    expect(run).toContain('ai/prompts/<prompt_version>.md');
    expect(run).not.toContain('own_check_v');
    expect(run).not.toContain('own_draft_v');
  });
});
