// T83（階段十二）：自選的買（一）——先買一半、補滿、125% 新門檻。設計：docs/design/allocation_redesign_2026-11-22.md §4.0、§4.1、§4.3、§4.6、第 5 章、第 9 章 D4、D6、D10。
// 完成條件：
//   buyAllowed 是純函式（減半、跌幅審查或乙類還沒結案、硬事件標記、30 天內有前提被判不成立、跨桶上限砍掉）
//   BUILD 的目標是標準比重的一半（OwnApplied 的 BUILD）；重放只有 STD／HALF，stepSlowRule 不改（數字由 test/replay.test.ts 鎖住）
//   第一次設定標準比重時問「先買一半」；有論點、加入時已跌 20% 的走 BUILD（只有預設的照舊 HALF）
//   開檔後第一份財報過關 → 月報 F27 補滿（預設照做）；照做或不做之後離開 BUILD；兩份財報或 200 天沒過 → 要看的事與兩個按鈕
//   BUILD 期間 -20%、減半、入金的目標都是一半；選了先買一半但其實買足了 → 一鍵改
//   raiseAllowed：連兩次財報後的審查都證實＋最近兩季營收年增為正，拿掉 126 天；own_review_v6
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { CheckedSample, Outcome, PackDoc } from '../src/ai/check';
import { OWN_REVIEW_PROMPT, earningsConfirmed, raiseAllowed } from '../src/ai/ownReview';
import { buildPassOf } from '../src/app/ownAi';
import type { SiteData } from '../src/app/site/backend';
import { BUILD_FULL_AT, accountView, buildViewOf, holdingDetail, notifView } from '../src/app/site/views';
import { OWN_ATTN, buildStaleLine, defaultCheck, metaFile, ownAttention, revenueCheck } from '../src/app/thesis';
import type { QuarterRow } from '../src/data/edgar';
import {
  BUILD_MAX_DAYS,
  BUY_BROKEN_DAYS,
  DEFAULT_CONFIG,
  SLOW,
  appliedOf,
  afterOpenLists,
  breakNotice,
  buildEarnings,
  condMetNotice,
  pickFrac,
  setApplied,
  buildStale,
  buyAllowed,
  buyCheck,
  dailyCheck,
  deposit,
  endBuild,
  halveShares,
  initialStateForNewPick,
  monthlyReport,
  newOwnMeta,
  ownDepositFill,
  ownSignalChange,
  ownStateTarget,
  planDay,
  priceOf,
  recordAiTier,
  recordEarnCheck,
  respond,
  setStdWeight,
  stepSlowRule,
  targetFrac,
  totalValue,
  type Account,
  type BuyFacts,
  type Item,
  type Notif,
  type RuleState,
} from '../src/engine';
import { makeMarket } from './helpers/market';
import { scenarios } from './helpers/scenarios';
import { Sim, type SimDrop } from './helpers/sim';

type Ready = SiteData & { acct: Account; view: NonNullable<SiteData['view']> };
const ready = (sim: Sim): Ready => ({ mode: 'demo', acct: sim.acct, view: sim.pre, axis: sim.market.days.slice(0, sim.d), rankOrder: [], rankSession: null, aiNotes: [], events: [], shadow: [], today: sim.date, warnings: [] });
const item = (n: Notif, f: string, ticker?: string): Item => {
  const it = n.items.find((i) => i.f === f && (!ticker || i.ticker === ticker));
  if (!it) throw new Error(`通知 #${n.id} 沒有 ${f} ${ticker ?? ''}`);
  return it;
};
const sharesOf = (it: Item, id: string) => (it.choices.find((c) => c.id === id)?.lines ?? []).reduce((a, l) => a + l.shares, 0);

// ================================================================ 純函式

describe('T83：buyAllowed（allocation_redesign §4.0）——買進前的同一組程式檢查', () => {
  const base: BuyFacts = { state: 'STD', applied: 'STD', flags: [], openDrop: false, openBreak: false, brokenAt: null, asOf: '2026-12-01', want: 10, price: 100, total: 100_000, held: 3_000, cap: 0.1 };

  it('都過：照想買的股數；只看狀態（沒給股數）時 0 股、不算上限', () => {
    expect(buyAllowed(base)).toEqual({ ok: true, shares: 10, cut: false, why: null, code: null });
    const { want: _w, ...stateOnly } = base;
    expect(buyAllowed(stateOnly)).toEqual({ ok: true, shares: 0, cut: false, why: null, code: null });
    // 先買一半、審查後持有不擋（補滿、下跌加碼都在這兩個狀態）
    expect(buyAllowed({ ...base, state: 'BUILD', applied: 'BUILD' }).ok).toBe(true);
    expect(buyAllowed({ ...base, state: 'WATCH' }).ok).toBe(true);
  });

  it('不過的原因與順序：減半中 → 跌幅審查還沒結案 → 乙類還沒結案 → 硬事件標記 → 30 天內有前提被判不成立', () => {
    const code = (x: Partial<BuyFacts>) => buyAllowed({ ...base, ...x }).code;
    expect(code({ state: 'HALF', applied: 'HALF', openDrop: true, flags: ['ACCOUNTING'] })).toBe('HALF');
    expect(code({ applied: 'HALF' })).toBe('HALF');
    expect(code({ openDrop: true, openBreak: true })).toBe('DROP');
    expect(code({ openBreak: true, flags: ['ACCOUNTING'] })).toBe('BREAK');
    expect(code({ flags: ['ACCOUNTING'], brokenAt: '2026-11-30' })).toBe('FLAG');
    expect(buyAllowed({ ...base, flags: ['ACCOUNTING'] }).why).toBe('這檔有未解除的硬事件標記（ACCOUNTING）');
    // 30 個日曆天：第 29 天還擋、第 30 天就不擋
    expect(BUY_BROKEN_DAYS).toBe(30);
    expect(buyAllowed({ ...base, brokenAt: '2026-11-02' })).toMatchObject({ ok: false, code: 'BROKEN', why: '11/2 有前提被判不成立' });
    expect(buyAllowed({ ...base, brokenAt: '2026-11-01' }).ok).toBe(true);
    // 未來的日期（資料錯）不擋
    expect(buyAllowed({ ...base, brokenAt: '2026-12-05' }).ok).toBe(true);
  });

  it('跨桶上限（自選＋動能合計 10%）：超過的部分砍掉；砍到 0 就不提；沒有要買的也不提', () => {
    // 已經 9,500：還能買 500 → 5 股
    expect(buyAllowed({ ...base, held: 9_500 })).toEqual({ ok: true, shares: 5, cut: true, why: '買進後會超過總資產 10% 的上限（自選加動能），只買 5 股（原本 10 股）', code: null });
    expect(buyAllowed({ ...base, held: 9_950 })).toMatchObject({ ok: false, shares: 0, code: 'CAP', why: '這檔自選加動能已經占總資產 10%，再買會超過 10% 的上限' });
    expect(buyAllowed({ ...base, cap: null, held: 50_000 })).toMatchObject({ ok: true, shares: 10 });
    expect(buyAllowed({ ...base, want: 0 })).toMatchObject({ ok: false, code: 'NONE' });
  });
});

describe('T83：BUILD 怎麼表示——目標一半、可以被減半；重放走不到（allocation_redesign §4.1 實作細節 1）', () => {
  it('appliedOf、targetFrac；新開的自選的初始狀態：有論點且已跌 20% → BUILD，只有預設前提 → HALF，沒跌到 → STD', () => {
    expect([appliedOf('STD'), appliedOf('HALF'), appliedOf('WATCH'), appliedOf('BUILD'), appliedOf('WATCH', true), appliedOf('HALF', true)]).toEqual(['STD', 'HALF', 'STD', 'BUILD', 'BUILD', 'HALF']);
    expect([targetFrac('STD'), targetFrac('HALF'), targetFrac('BUILD')]).toEqual([1, 0.5, 0.5]);
    expect([initialStateForNewPick(-0.1), initialStateForNewPick(-0.25), initialStateForNewPick(-0.25, true), initialStateForNewPick(-0.1, true), initialStateForNewPick(NaN, true)]).toEqual(['STD', 'HALF', 'BUILD', 'STD', 'STD']);
  });

  it('配置算法：目標、入金補到的比重都是一半；減半訊號對 BUILD 有效（賣當時的一半、之後是 HALF），加回對 BUILD 沒有作用', () => {
    const st: RuleState = { own: { A: { applied: 'BUILD', stdWeight: 0.06 }, B: { applied: 'STD', stdWeight: 0.06 } }, heldMom: [], effPrev: null, volHist: [], volW: null };
    expect(ownStateTarget(st, 'A', 100_000)).toBeCloseTo(3_000, 9);
    expect(ownDepositFill(st, { ratio: { own: 0.2, strat: 0.3, core: 0.5 }, ownCapTo: 0.1 }, 'A')).toBeCloseTo(0.03, 12);
    const values = { 'own:A': 3_000, 'own:B': 6_000, 'core:VOO': 91_000 };
    expect(ownSignalChange(st, values, 'A', 'REDUCE', 100_000)).toBe(1_500);
    expect(ownSignalChange(st, values, 'A', 'READD', 100_000)).toBe(0);
    const plan = planDay({ cfg: DEFAULT_CONFIG, values, state: structuredClone(st), ownActions: { A: 'REDUCE' } });
    expect(plan.state.own.A.applied).toBe('HALF');
    expect(plan.targets['own:A']).toBeCloseTo(1_500, 9);
    // stepSlowRule 本身不認得 BUILD（只更新兩個計數）：BUILD 的切換在 dailyCheck 外層照標準狀態判
    expect(stepSlowRule({ state: 'BUILD', aboveRun: 3, sinceSwitch: 7 }, { drawdown: -0.3, above200: false })).toEqual({ next: { state: 'BUILD', aboveRun: 0, sinceSwitch: 8 }, signal: null });
  });
});


describe('T83：營收與系統預設前提的程式核對、財報後審查有沒有證實、先買一半過關沒有（純函式）', () => {
  const q = (end: string, yoy: number | null, eps: number | null = 1): QuarterRow => ({ end, filed: end, form: '10-Q', accn: end, revenue: 100, grossProfit: null, operatingIncome: null, netIncome: null, epsDiluted: eps, cfo: null, grossMarginPct: null, operatingMarginPct: null, netMarginPct: null, revenueYoY: yoy, cfoToNetIncome: null });

  it('revenueCheck：最近兩季相連、都有年增率、都是正的才過；資料不夠不算過', () => {
    expect(revenueCheck([q('2026-09-30', 0.3), q('2026-06-30', 0.12)])).toEqual({ ok: true, why: '2026-09-30 +30.0%、2026-06-30 +12.0%' });
    expect(revenueCheck([q('2026-09-30', 0.3), q('2026-06-30', -0.01)])).toEqual({ ok: false, why: '2026-09-30 +30.0%、2026-06-30 -1.0%，不是兩季都為正' });
    expect(revenueCheck([q('2026-09-30', 0.3), q('2026-03-31', 0.2)]).why).toContain('不相連');
    expect(revenueCheck([q('2026-09-30', 0.3), q('2026-06-30', null)]).ok).toBe(false);
    expect(revenueCheck([q('2026-09-30', 0.3)]).why).toBe('資料不足（季度數字不到兩季）');
    expect(revenueCheck(null).why).toBe('資料不足（XBRL 抓不到）');
  });

  it('defaultCheck（只有預設前提的先買一半確認）：D1～D3 都成立才過；有一條不成立是 false；資料不足是 null；有論點的不適用', () => {
    const sim = new Sim(makeMarket('2026-11-23', 5), scenarios.s1().init);
    const tf = metaFile(sim.acct, 'META', '2026-11-20')!;
    expect(tf.kind).toBe('DEFAULT_ONLY');
    const rows = [q('2026-09-30', 0.1, 1.2), q('2026-06-30', 0.05, 1.1), q('2026-03-31', 0.02, 1.0), q('2025-12-31', 0.01, 0.9), q('2025-09-30', 0.0, 1.0), q('2025-06-30', 0.0, 1.0)];
    expect(defaultCheck(tf, rows, '2026-11-20')).toEqual({ ok: true, why: '系統預設前提 D1～D3 都成立' });
    expect(defaultCheck(tf, [q('2026-09-30', -0.1), q('2026-06-30', -0.05), ...rows.slice(2)], '2026-11-20')!.why).toContain('D2 不成立');
    expect(defaultCheck(tf, [q('2026-09-30', 0.1, 0.5), q('2026-06-30', 0.1, 0.5), ...rows.slice(2)], '2026-11-20')!.why).toContain('D3 不成立');
    expect(defaultCheck(tf, rows.slice(0, 2), '2026-11-20')).toEqual({ ok: null, why: 'D3 資料不足' });
    expect(defaultCheck(tf, null, '2026-11-20')!.ok).toBeNull();
    expect(defaultCheck({ ...tf, flags: ['ACCOUNTING'] }, rows, '2026-11-20')!.ok).toBe(false);
    expect(defaultCheck(metaFile(sim.acct, 'MU', '2026-11-20')!, rows, '2026-11-20')).toBeNull();
  });

  it('earningsConfirmed：3 票一致、每一票都判了每一條前提成立、引用有申報或財報才算證實（§4.3 實作細節 1）', () => {
    const docs: PackDoc[] = [{ id: 'D1', source_id: 'filing:q', kind: 'filing', date: '2026-10-30', title: '10-Q', text: '' }, { id: 'D2', source_id: 'web:x', kind: 'web', date: '2026-10-30', title: 'x', text: '' }];
    const sample = (st: Record<string, string>, src = 'filing:q'): CheckedSample => ({ index: 0, valid: true, verdict: 'HOLD', rawVerdict: 'HOLD', issues: [], evidence: [{ id: 'E1', source_id: src, date: '2026-10-30', quote: 'q', claim: 'c', ok: true }], premises: Object.entries(st).map(([premise_id, status]) => ({ premise_id, status, evidence_ids: ['E1'] })) as CheckedSample['premises'], conditions: [], abstainReason: null, dataMissing: [], model: null, payload: null, report: null });
    const out = (s: CheckedSample[], status: Outcome['status'] = 'AGREED'): Outcome => ({ status, verdict: 'HOLD', votes: { HOLD: 3 }, actionable: true, followRule: false, reason: '', samples: s });
    const pack = { documents: docs, premises: [{ id: 'P1' }, { id: 'P2' }] };
    const all = { P1: 'HOLDS', P2: 'HOLDS' };
    expect(earningsConfirmed(out([sample(all), sample(all), sample(all)]), pack)).toEqual({ confirmed: true, why: '3 票都判 2 條前提成立（有申報或財報的引用）' });
    expect(earningsConfirmed(out([sample(all), sample(all), sample({ P1: 'HOLDS', P2: 'INSUFFICIENT' })]), pack).confirmed).toBe(false);
    expect(earningsConfirmed(out([sample(all), sample(all), sample({ P1: 'HOLDS' })]), pack).why).toBe('不是每一條前提都三票判成立');
    expect(earningsConfirmed(out([sample(all), sample(all), sample(all)], 'SPLIT'), pack).why).toBe('沒有三票一致的結論');
    expect(earningsConfirmed(out([sample(all), sample(all)]), pack).why).toBe('有效的票不到三張');
    expect(earningsConfirmed(out([sample(all), sample(all), sample(all, 'web:x')]), pack).why).toContain('只靠網頁');
  });

  it('buildPassOf（先買一半的確認，D4）：有論點看三票——一致、沒有前提被判不成立、檔位不是減半或出清；只有預設前提看程式比對，不看票', () => {
    const d = (x: Partial<{ consensus: boolean; brokenPremises: string[]; tier: 'HOLD' | 'HALF' | 'EXIT' | 'STANDARD' | null }>) => ({ consensus: true, brokenPremises: [], tier: 'HOLD' as const, ...x });
    expect(buildPassOf(false, '2026-11-20', d({}), null)).toEqual({ pass: true, text: '11-20 的財報後審查，3 票，前提都沒有被判不成立' });
    expect(buildPassOf(false, '2026-11-20', d({ consensus: false, tier: null }), null)).toEqual({ pass: false, text: '11-20 的財報後審查沒有一致結論' });
    expect(buildPassOf(false, '2026-11-20', d({ brokenPremises: ['P2'], tier: 'HALF' }), null)).toEqual({ pass: false, text: '11-20 的財報後審查判前提 P2 不成立' });
    expect(buildPassOf(false, '2026-11-20', d({ tier: 'HALF' }), null).pass).toBe(false);
    expect(buildPassOf(false, '2026-11-20', null, null)).toEqual({ pass: false, text: '11-20 的財報後審查沒有結論' });
    expect(buildPassOf(true, '2026-11-20', d({ consensus: false }), { ok: true, why: '' })).toEqual({ pass: true, text: '11-20 的財報，系統預設前提 D1～D3 都成立' });
    expect(buildPassOf(true, '2026-11-20', d({}), { ok: null, why: 'D3 資料不足' })).toEqual({ pass: false, text: '11-20 的財報：D3 資料不足' });
  });
});

// ================================================================ 引擎：開檔、第一次設定標準比重、確認、補滿

describe('T83：第一次設定標準比重時問「先買一半」（§4.1 實作細節 3）', () => {
  it('新開的自選（新增、轉入、認養、自己買進）才問；上線那天就有的、一開始就是減半或先買一半的不問', () => {
    const sim = new Sim(makeMarket('2026-11-23', 5), scenarios.s1().init);
    const v = sim.pre;
    for (const o of ['NEW', 'TRANSFER', 'ADOPT', 'MANUAL'] as const) expect(newOwnMeta(v, 'MSFT', o, []).buildAsk, o).toBe(true);
    expect(newOwnMeta(v, 'MSFT', 'INITIAL', []).buildAsk).toBeUndefined();
    expect(Object.values(sim.acct.own).every((m) => m.buildAsk === undefined && m.build === undefined)).toBe(true);
  });

  it('選「先買一半」→ BUILD（目標一半、since 是開檔日）；存一次就不再問；選「已經買到」或沒選照舊；減半中的不會變成先買一半', () => {
    const sim = new Sim(makeMarket('2026-11-23', 5), scenarios.s1().init);
    const a = structuredClone(sim.acct);
    a.own.MSFT.buildAsk = true;
    a.own.MSFT.fileId = 'MSFT@2026-11-10';
    const half = setStdWeight(a, 'MSFT', 0.06, { build: true, date: '2026-11-20' });
    expect(half.own.MSFT).toMatchObject({ slow: { state: 'BUILD' }, build: { since: '2026-11-10', confirmBy: 'EARNINGS', misses: 0 } });
    expect(half.own.MSFT.buildAsk).toBeUndefined();
    expect(half.rule.own.MSFT).toEqual({ applied: 'BUILD', stdWeight: 0.06 });
    // 第二次改標準比重：不再問，build 也不會再被設
    const again = setStdWeight(half, 'MSFT', 0.07, { build: true });
    expect(again.rule.own.MSFT).toEqual({ applied: 'BUILD', stdWeight: 0.07 });
    const full = setStdWeight(a, 'MSFT', 0.06, { build: false });
    expect([full.own.MSFT.slow.state, full.rule.own.MSFT.applied, full.own.MSFT.buildAsk, full.own.MSFT.build]).toEqual(['STD', 'STD', undefined, undefined]);
    expect(setStdWeight(full, 'MSFT', 0.05, { build: true }).own.MSFT.slow.state).toBe('STD');
    const halved = structuredClone(a);
    halved.own.MSFT.slow.state = 'HALF';
    halved.rule.own.MSFT.applied = 'HALF';
    expect(setStdWeight(halved, 'MSFT', 0.06, { build: true }).rule.own.MSFT.applied).toBe('HALF');
  });
});

/**
 * NVDA（有論點，占約 13%、標準比重 10%）一路跌過 -20%、-30%、-40% 再大漲（同 t82 的 ladder）。build：開始前把 NVDA 設成先買一半。
 */
function ladder(o: { flat?: boolean; drops?: Record<string, SimDrop>; defaultOnly?: boolean; build?: boolean; days?: number } = {}) {
  const path = o.flat
    ? [{ n: 8, ret: 0.02 }, { n: 4, ret: -0.235 }, { n: 28, ret: 0.0, vol: 0.15 }, { n: 70, ret: 0.9 }]
    : [{ n: 8, ret: 0.02 }, { n: 4, ret: -0.235 }, { n: 8, ret: -0.13 }, { n: 8, ret: -0.16 }, { n: 20, ret: 0.02 }, { n: 62, ret: 1.1 }];
  const market = makeMarket('2026-11-23', o.days ?? 110, { over: { NVDA: { r252: 0.55, path } } });
  const sim = new Sim(market, scenarios.s7().init, { drops: o.drops });
  sim.acct.cfg = { ...sim.acct.cfg, urgentFrac: 0.03 };
  if (o.defaultOnly) sim.acct.own.NVDA.premises = sim.acct.own.NVDA.premises.map((p) => ({ ...p, origin: 'SYSTEM_DEFAULT' as const }));
  if (o.build) toBuild(sim.acct, 'NVDA', 0.2);
  return sim;
}
/** 直接把一檔設成先買一半（標準比重 std；開檔日 2026-11-01）。 */
function toBuild(a: Account, t: string, std: number): void {
  a.own[t].slow = { ...a.own[t].slow, state: 'BUILD' };
  a.own[t].build = { since: '2026-11-01', confirmBy: 'EARNINGS', misses: 0 };
  a.rule.own[t] = { applied: 'BUILD', stdWeight: std };
}
const nvdaNotifs = (sim: Sim) => sim.acct.notifs.filter((n) => n.items.some((i) => i.f === 'F7' && i.ticker === 'NVDA'));
function untilF7(sim: Sim): Notif {
  while (!nvdaNotifs(sim).length && !sim.atEnd()) sim.day({ afterMonthly: (m) => sim.respond(m.id) });
  const n = nvdaNotifs(sim)[0];
  if (!n) throw new Error('NVDA 沒有 F7 通知');
  return n;
}

describe('T83：BUILD 期間跌 20%（§4.1 實作細節 2）', () => {
  it('有論點：開跌幅審查、進審查後持有，先買一半留著（目標仍是一半）；選了減半 → 賣一半的一半、變成減半、離開先買一半', () => {
    const sim = ladder({ build: true, flat: true, drops: { NVDA: { status: 'BROKEN', premiseId: 'P1' } } });
    const had = sim.acct.lots.own.NVDA;
    const n = untilF7(sim);
    const it = item(n, 'F7', 'NVDA');
    expect(it.thesisDrop).toEqual({ level: 0 });
    expect(sim.acct.own.NVDA.slow.state).toBe('WATCH');
    expect(sim.acct.own.NVDA.build).toMatchObject({ since: '2026-11-01' });
    expect(sim.acct.rule.own.NVDA.applied).toBe('BUILD');
    // 前提不成立 → 預設減半：股數是當時持有的一半（一半的一半）
    expect(it.choice).toBe('RULE');
    expect(sharesOf(it, 'RULE')).toBe(-halveShares(had));
    // 買進前的程式檢查：跌幅審查還沒結案（也有前提被判不成立）→ 不提買進
    expect(buyCheck(sim.acct, sim.post, 'NVDA', sim.date, 5).ok).toBe(false);
    sim.respondAfterClose(n.id);
    sim.d++;
    sim.open();
    expect([sim.acct.own.NVDA.slow.state, sim.acct.rule.own.NVDA.applied, sim.acct.own.NVDA.build]).toEqual(['HALF', 'HALF', undefined]);
    expect(sim.acct.lots.own.NVDA).toBe(had - halveShares(had));
  });

  it('有論點、審查之後沒有減半：站回 200 日均線時回到先買一半（不是標準），補滿仍看財報', () => {
    const sim = ladder({ build: true, flat: true, drops: { NVDA: { status: 'CLEAR' } } });
    untilF7(sim);
    expect(sim.acct.own.NVDA.slow.state).toBe('WATCH');
    while (!sim.atEnd() && sim.acct.own.NVDA.slow.state === 'WATCH') sim.day({ afterMonthly: (m) => sim.respond(m.id) });
    expect(sim.acct.own.NVDA.slow.state).toBe('BUILD');
    expect(sim.acct.rule.own.NVDA.applied).toBe('BUILD');
    expect(sim.acct.own.NVDA.build).toBeTruthy();
    expect(sim.log.some((l) => l.includes('NVDA：審查後持有 → 站回 200 日均線'))).toBe(true);
  });

  it('只有預設前提（你自己選了先買一半）：規則照舊減半——賣當時持有的一半、變成減半，清單產生時離開先買一半；之後加回補到標準比重', () => {
    const sim = ladder({ build: true, defaultOnly: true });
    const had = sim.acct.lots.own.NVDA;
    const n = untilF7(sim);
    expect(n.title).toBe('NVDA 慢規則減半');
    const it = item(n, 'F7', 'NVDA');
    expect(it.thesisDrop).toBeUndefined();
    expect(sharesOf(it, 'RULE')).toBe(-halveShares(had));
    expect([sim.acct.own.NVDA.slow.state, sim.acct.rule.own.NVDA.applied, sim.acct.own.NVDA.build]).toEqual(['HALF', 'HALF', undefined]);
    sim.respond(n.id);
    const later: Notif[] = [];
    while (!sim.atEnd()) sim.day({ afterMonthly: (m) => (later.push(m), sim.respond(m.id)), afterClose: (c) => later.push(...c) });
    const f8 = later.flatMap((x) => x.items).find((i) => i.f === 'F8' && i.ticker === 'NVDA');
    expect(f8).toBeTruthy();
    expect(sim.acct.rule.own.NVDA).toMatchObject({ applied: 'STD', stdWeight: 0.2 });
  });

  it('只有預設前提：還沒下單的減半被之後的加回抵銷 → 回到先買一半（目標還沒改）', () => {
    const sim = ladder({ build: true, defaultOnly: true });
    sim.acct.cfg = { ...sim.acct.cfg, urgentFrac: 0.5 }; // 減半等月報
    while (!sim.acct.own.NVDA.pending && !sim.atEnd()) sim.day();
    expect(sim.acct.own.NVDA).toMatchObject({ slow: { state: 'HALF' }, pending: { action: 'REDUCE' } });
    expect(sim.acct.rule.own.NVDA.applied).toBe('BUILD');
    // 加回的訊號：直接給一天站上均線 10 天、距切換 ≥ 15 天、跌幅不到 20% 的狀態
    const a = structuredClone(sim.acct);
    a.own.NVDA.slow = { state: 'HALF', aboveRun: 30, sinceSwitch: 30 };
    const step = stepSlowRule(a.own.NVDA.slow, { drawdown: -0.05, above200: true });
    expect(step.signal).toBe('READD');
    // dailyCheck 用真的價格判；這裡只確認抵銷那一支的寫法：pending 抵銷時 build 還在 → 回到 BUILD
    const r = dailyCheck(a, { ...sim.post, close: { ...sim.post.close, NVDA: rising(sim.post.close.NVDA, sim.post.i) } });
    expect(r.acct.own.NVDA.pending).toBeNull();
    expect(r.acct.own.NVDA.slow.state).toBe('BUILD');
    expect(r.log.some((l) => l.what.includes('互相抵銷'))).toBe(true);
  });
});

/** 把 i 之前 260 天改成穩定上漲（跌幅 0、站上均線）：測加回訊號用。 */
function rising(c: ArrayLike<number>, i: number): number[] {
  const out = Array.from(c);
  for (let k = Math.max(0, i - 260); k <= i; k++) out[k] = 100 * Math.pow(1.002, k - (i - 260));
  return out;
}

// 主持者 2026-11-23 定（allocation_redesign §4.1 細節 2）：從先買一半被減半 → 減半期間的目標是「一半的一半」＝標準比重的四分之一；加回時回到標準比重
describe('T83：先買一半被減半之後的目標是標準比重的四分之一（四條路都一樣）', () => {
  /** 入金時這一檔會補到多少股（沒有那一行是 0）。 */
  const depositBuy = (a: Account, view: Sim['pre'], t: string) => deposit(a, view, 20_000).notif.items.flatMap((i) => i.choices[0].lines).find((l) => l.ticker === t && l.bucket === 'own')?.shares ?? 0;
  /** 減半之後：目標、入金補到的比重是四分之一；入金最多只補到四分之一（不會把減半退掉一部分）。 */
  function quarter(a: Account, view: Sim['pre'], t: string) {
    const o = a.rule.own[t];
    expect(o).toMatchObject({ applied: 'HALF', fromBuild: true });
    expect(pickFrac(o)).toBe(0.25);
    const total = totalValue(a, view);
    expect(ownStateTarget(a.rule, t, total)).toBeCloseTo(o.stdWeight * total * 0.25, 6);
    expect(ownDepositFill(a.rule, a.cfg, t)!).toBeLessThanOrEqual(o.stdWeight * 0.25 + 1e-12);
    const px = priceOf(view, t);
    const sh = depositBuy(a, view, t);
    // 入金和現有的清單合起來算（還沒填快照的清單當成做完了，afterOpenLists）
    const held = afterOpenLists(a, view, { pending: true }).lots.own[t] ?? 0;
    expect(sh * px).toBeLessThanOrEqual(Math.max(0, o.stdWeight * 0.25 * (total + 20_000) - held * px) + px);
    return sh;
  }

  it('pickFrac、setApplied：先買一半 → 減半記 fromBuild；減半 → 減半保留；回到標準、標準 → 減半都拿掉', () => {
    const o = { applied: 'BUILD' as const, stdWeight: 0.06 } as { applied: 'STD' | 'HALF' | 'BUILD'; stdWeight: number; fromBuild?: boolean };
    setApplied(o, 'HALF');
    expect(o).toEqual({ applied: 'HALF', stdWeight: 0.06, fromBuild: true });
    expect(pickFrac(o)).toBe(0.25);
    setApplied(o, 'HALF');
    expect(o.fromBuild).toBe(true);
    setApplied(o, 'STD');
    expect(o).toEqual({ applied: 'STD', stdWeight: 0.06 });
    setApplied(o, 'HALF');
    expect(o).toEqual({ applied: 'HALF', stdWeight: 0.06 });
    expect(pickFrac(o)).toBe(0.5);
    expect([pickFrac({ applied: 'STD' }), pickFrac({ applied: 'BUILD' }), pickFrac({ applied: 'STD', fromBuild: true })]).toEqual([1, 0.5, 1]);
  });

  it('① 只有預設前提、規則減半：目標四分之一、入金只補到四分之一；加回條件成立時買回到標準比重（不是回到先買一半），記號拿掉', () => {
    const sim = ladder({ build: true, defaultOnly: true });
    const n = untilF7(sim);
    quarter(sim.acct, sim.post, 'NVDA');
    // 成交之後（賣掉一半的一半）再入金：補到四分之一為止；同一檔若是一般的減半（目標一半）會補得比較多
    const after = structuredClone(sim.acct);
    after.lots.own.NVDA -= halveShares(after.lots.own.NVDA);
    const shQ = quarter(after, sim.post, 'NVDA');
    const plain = structuredClone(after);
    delete plain.rule.own.NVDA.fromBuild;
    expect(depositBuy(plain, sim.post, 'NVDA')).toBeGreaterThan(shQ);
    // 通知與持股頁的字：四分之一
    const v = notifView(ready(sim), n).items.find((x) => x.label === '慢規則減半')!;
    expect(v.explain.why).toContain('減半之後的目標是標準比重 20.0% 的四分之一（5.00%）');
    sim.respond(n.id);
    sim.d++;
    sim.open();
    expect(accountView(ready(sim)).holdings.find((x) => x.ticker === 'NVDA')!.detail).toMatch(/^目標是標準比重 20\.0% 的四分之一（5\.00%）；/);
    const later: Notif[] = [];
    while (!sim.atEnd()) sim.day({ afterMonthly: (m) => (later.push(m), sim.respond(m.id)), afterClose: (c) => later.push(...c) });
    const f8 = later.flatMap((x) => x.items).find((i) => i.f === 'F8' && i.ticker === 'NVDA')!;
    expect(f8).toBeTruthy();
    expect(sim.acct.rule.own.NVDA).toEqual({ applied: 'STD', stdWeight: 0.2 });
    expect(sim.acct.own.NVDA.slow.state).toBe('STD');
  });

  it('② 有論點、審查後持有時審查判前提不成立、照做減半：一樣是四分之一', () => {
    const sim = ladder({ build: true, flat: true, drops: { NVDA: { status: 'BROKEN', premiseId: 'P1' } } });
    const n = untilF7(sim);
    sim.respondAfterClose(n.id);
    sim.d++;
    sim.open();
    quarter(sim.acct, sim.pre, 'NVDA');
  });

  it('③ 乙類（AI 判前提不成立）照做減半、④ 你定的出場條件減半：一樣是四分之一；標準狀態的照舊是一半', () => {
    const run = (mk: (a: Account, v: Sim['pre']) => { acct: Account; notif: Notif | null }, choice: 'AI' | 'DO', build = true) => {
      const sim = new Sim(makeMarket('2026-11-23', 5), scenarios.s1().init);
      if (build) toBuild(sim.acct, 'MSFT', 0.12);
      const r = mk(sim.acct, sim.pre);
      sim.acct = r.acct;
      const it = item(r.notif!, r.notif!.items[0].f, 'MSFT');
      expect(sharesOf(it, choice)).toBe(-halveShares(sim.acct.lots.own.MSFT));
      sim.respond(r.notif!.id, { mode: 'DO', choices: { [it.key]: choice } });
      sim.open();
      return sim;
    };
    const brk = (a: Account, v: Sim['pre']) => breakNotice(a, v, 'MSFT', { tier: 'HALF', premiseId: 'P1', basis: '10-Q 2026-10-30' });
    const cond = (a: Account, v: Sim['pre']) => condMetNotice(a, v, 'MSFT', { id: 1, text: '營業利益率低於 40%', action: 'HALF', setAt: '2026-11-01', aiProposed: false, why: '10-Q' });
    const b = run(brk, 'AI');
    quarter(b.acct, b.pre, 'MSFT');
    expect(b.acct.own.MSFT.build).toBeUndefined();
    const c = run(cond, 'DO');
    quarter(c.acct, c.pre, 'MSFT');
    // 標準狀態被減半：照舊是一半、沒有記號
    const std = run(cond, 'DO', false);
    expect(std.acct.rule.own.MSFT.fromBuild).toBeUndefined();
    expect(pickFrac(std.acct.rule.own.MSFT)).toBe(0.5);
  });
});

describe('T83：入金時先買一半的目標是一半（§4.1）', () => {
  it('入金只把先買一半的股票補到標準比重的一半；標準狀態的照舊補到標準比重', () => {
    const sim = new Sim(makeMarket('2026-11-23', 5), scenarios.s1().init);
    const a = structuredClone(sim.acct);
    const total = totalValue(a, sim.pre);
    const px = priceOf(sim.pre, 'MSFT');
    const w0 = (a.lots.own.MSFT * px) / total;
    // MSFT：先買一半、標準比重是現在的 4 倍 → 目標（一半）是現在的 2 倍；入金只補到一半
    toBuild(a, 'MSFT', 4 * w0);
    const fill = ownDepositFill(a.rule, a.cfg, 'MSFT')!;
    expect(fill).toBeLessThanOrEqual(2 * w0 + 1e-12);
    const msft = (x: Account) => deposit(x, sim.pre, 20_000).notif.items.flatMap((i) => i.choices[0].lines).find((l) => l.ticker === 'MSFT' && l.bucket === 'own')?.shares ?? 0;
    const sh = msft(a);
    expect(sh).toBeGreaterThan(0);
    expect((a.lots.own.MSFT + sh) * px).toBeLessThanOrEqual(fill * (total + 20_000) + px);
    // 同一個標準比重、標準狀態：入金補得比較多（補到標準比重）
    const std = structuredClone(a);
    delete std.own.MSFT.build;
    std.own.MSFT.slow.state = 'STD';
    std.rule.own.MSFT.applied = 'STD';
    expect(msft(std)).toBeGreaterThan(sh);
  });
});

describe('T83：確認與補滿（F27，§4.1、D4、D10）', () => {
  /** 有論點的 MSFT 先買一半（標準比重 6%），開檔後第一份財報過關；走到下一份月報。 */
  function confirmed(o: { pass?: boolean } = {}) {
    const sim = new Sim(makeMarket('2026-11-23', 50), scenarios.s1().init);
    toBuild(sim.acct, 'MSFT', 0.06);
    sim.acct = buildEarnings(sim.acct, 'MSFT', { date: '2026-11-20', runId: 'rev-1', pass: o.pass ?? true, text: o.pass === false ? '11-20 的財報後審查沒有一致結論' : '11-20 的財報後審查，3 票，前提都沒有被判不成立' });
    return sim;
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

  it('buildEarnings：過關記 ok；沒過關 misses + 1 並記原因；已經過關之後不再動；不是先買一半原樣回傳', () => {
    const sim = confirmed({ pass: false });
    expect(sim.acct.own.MSFT.build).toMatchObject({ misses: 1, last: { date: '2026-11-20', text: '11-20 的財報後審查沒有一致結論' } });
    expect(sim.acct.own.MSFT.build!.ok).toBeUndefined();
    const ok = buildEarnings(sim.acct, 'MSFT', { date: '2027-02-20', pass: true, text: '過關' });
    expect(ok.own.MSFT.build).toMatchObject({ misses: 1, ok: { date: '2027-02-20', text: '過關' } });
    expect(ok.own.MSFT.build!.last).toBeUndefined();
    expect(buildEarnings(ok, 'MSFT', { date: '2027-05-20', pass: false, text: 'x' })).toBe(ok);
    expect(buildEarnings(ok, 'MU', { date: '2027-05-20', pass: false, text: 'x' })).toBe(ok);
  });

  it('下一份月報列「補滿」：預設照做、股數補到標準比重、錢從核心；照做並填快照之後離開先買一半（標準）', () => {
    const sim = confirmed();
    const m = untilMonthly(sim);
    const it = item(m, 'F27', 'MSFT');
    const total = totalValue(sim.acct, sim.pre);
    const want = Math.floor((0.06 * total) / priceOf(sim.pre, 'MSFT') + 1e-9) - sim.acct.lots.own.MSFT;
    expect(it).toMatchObject({ kind: 'OWN_FILL', choice: 'RULE', ruleChoice: 'RULE', runIds: ['rev-1'] });
    expect(it.reasonRequired).toBeUndefined();
    expect(it.title).toBe(`MSFT：先買的一半已確認（11-20 的財報後審查，3 票，前提都沒有被判不成立）→ 補滿到標準比重，買 ${want} 股`);
    expect(it.choices.map((c) => [c.id, c.label])).toEqual([['RULE', `照做：補滿，買 ${want} 股`], ['SKIP', '這次不做（維持現在的大小）']]);
    expect(sharesOf(it, 'RULE')).toBe(want);
    expect(sim.acct.own.MSFT.build!.listed).toBe(m.id);
    // 網站：名字、理由
    const v = notifView(ready(sim), m);
    const iv = v.items.find((x) => x.key === it.key)!;
    expect(iv.label).toBe('補滿（先買一半）');
    expect(iv.explain.short).toBe('先買的一半已確認：11-20 的財報後審查，3 票，前提都沒有被判不成立');
    expect(iv.explain.choiceNotes!.SKIP).toContain('標準比重改成現在的比重');
    sim.respond(m.id);
    expect(sim.acct.own.MSFT.build).toBeTruthy(); // 下單、填快照之後才生效
    sim.open();
    expect([sim.acct.own.MSFT.slow.state, sim.acct.rule.own.MSFT.applied, sim.acct.own.MSFT.build]).toEqual(['STD', 'STD', undefined]);
    expect(sim.acct.rule.own.MSFT.stdWeight).toBe(0.06);
  });

  it('不做（整則不做或只有這一項不做）：離開先買一半，標準比重改成那時的實際比重，之後不再提；影子紀錄記下規則的股數', () => {
    const sim = confirmed();
    const m = untilMonthly(sim);
    const it = item(m, 'F27', 'MSFT');
    const w = (sim.acct.lots.own.MSFT * priceOf(sim.pre, 'MSFT')) / totalValue(sim.acct, sim.pre);
    // 整則不做：回覆當下套用
    const whole = respond(sim.acct, sim.pre, m.id, { mode: 'SKIP' });
    expect(whole.notifs.find((x) => x.id === m.id)!.status).toBe('SKIPPED');
    expect([whole.own.MSFT.slow.state, whole.rule.own.MSFT.applied, whole.own.MSFT.build]).toEqual(['STD', 'STD', undefined]);
    expect(whole.rule.own.MSFT.stdWeight).toBeCloseTo(w, 12);
    expect(whole.shadow.at(-1)).toMatchObject({ f: 'F27', ticker: 'MSFT', rule: sharesOf(it, 'RULE'), actual: 0, choice: 'SKIP' });
    // 只有這一項不做（其他照做）：填快照時套用
    sim.respond(m.id, { mode: 'DO', choices: { [it.key]: 'SKIP' } });
    sim.open();
    expect([sim.acct.own.MSFT.slow.state, sim.acct.own.MSFT.build]).toEqual(['STD', undefined]);
    expect(sim.acct.rule.own.MSFT.stdWeight).toBeLessThan(0.06);
    // 下一份月報不會再列
    const next = untilMonthly(sim);
    expect(next.items.some((i) => i.f === 'F27')).toBe(false);
  });

  it('還沒回覆的月報上已經列了 → 下一份月報不重列；沒過關的不列；現在已經到標準比重 → 直接離開先買一半、不列', () => {
    const sim = confirmed();
    const m = untilMonthly(sim);
    expect(item(m, 'F27', 'MSFT')).toBeTruthy();
    const again = monthlyReport(sim.acct, sim.pre, { order: [], month: 'x' });
    expect(again.notif.items.some((i) => i.f === 'F27')).toBe(false);
    // 沒過關（只有 misses）：不列
    const miss = confirmed({ pass: false });
    expect(untilMonthly(miss).items.some((i) => i.f === 'F27')).toBe(false);
    // 已經買足：不列，直接回到標準
    const full = confirmed();
    full.acct.lots.own.MSFT = Math.ceil((0.07 * totalValue(full.acct, full.pre)) / priceOf(full.pre, 'MSFT'));
    const fm = monthlyReport(full.acct, full.pre, { order: [], month: 'x' });
    expect(fm.notif.items.some((i) => i.f === 'F27')).toBe(false);
    expect([fm.acct.own.MSFT.slow.state, fm.acct.rule.own.MSFT.applied, fm.acct.own.MSFT.build]).toEqual(['STD', 'STD', undefined]);
  });

  it('買進前的程式檢查沒過（30 天內有前提被判不成立）→ 不列、不通知，持股頁寫一行原因；之後的月報再看一次；超過上限的部分砍掉', () => {
    const sim = confirmed();
    sim.acct = recordAiTier(sim.acct, 'MSFT', 'HOLD', '2026-11-25', false, 'rev-2', { premiseId: 'P2', trigger: 'MONTHLY' });
    expect(sim.acct.own.MSFT.brokenAt).toBe('2026-11-25');
    const m = untilMonthly(sim);
    expect(m.items.some((i) => i.f === 'F27')).toBe(false);
    expect(sim.acct.own.MSFT.buyBlocked).toEqual({ date: sim.pre.date, what: '補滿', text: '11/25 有前提被判不成立' });
    const b = buildViewOf(sim.acct, sim.pre, 'MSFT', 0.01)!;
    expect(b.blocked).toBe('補滿的條件過關了，但 11/25 有前提被判不成立，這次不提補滿；下個月月報再看一次。');
    // 下下個月（30 天過了）就列
    sim.respond(m.id);
    sim.open();
    sim.close();
    sim.d++;
    const later = untilMonthly(sim);
    expect(later.items.some((i) => i.f === 'F27')).toBe(true);
    expect(sim.acct.own.MSFT.buyBlocked).toBeUndefined();
    // 上限：動能也持有很多 MSFT → 只買到 10% 為止，項目寫明
    const cap = confirmed();
    const total = totalValue(cap.acct, cap.pre);
    cap.acct.lots.mom.MSFT = Math.floor((0.09 * total) / priceOf(cap.pre, 'MSFT'));
    cap.acct.rule.own.MSFT.stdWeight = 0.06;
    const cm = monthlyReport(cap.acct, cap.pre, { order: [], month: 'x' });
    const ci = cm.notif.items.find((i) => i.f === 'F27');
    if (ci) expect(ci.note).toContain('上限（自選加動能），只買');
    else expect(cm.acct.own.MSFT.buyBlocked!.text).toContain('再買會超過 10% 的上限');
  });
});

describe('T83：拖太久、兩個按鈕、選了先買一半但其實買足了（§4.1、§4.6）', () => {
  it('兩份財報都沒過、或開檔滿 200 天 → buildStale；「要看的事」那一行；過關之後就不算', () => {
    const meta = { build: { since: '2026-05-01', confirmBy: 'EARNINGS' as const, misses: 0 } };
    expect(BUILD_MAX_DAYS).toBe(200);
    expect(buildStale(meta, '2026-11-16')).toBe(false); // 199 天
    expect(buildStale(meta, '2026-11-17')).toBe(true); // 200 天
    expect(buildStale({ build: { ...meta.build, misses: 2 } }, '2026-06-01')).toBe(true);
    expect(buildStale({ build: { ...meta.build, misses: 2, ok: { date: '2026-08-01', text: 'x' } } }, '2026-12-01')).toBe(false);
    expect(buildStaleLine('MU', { build: { ...meta.build, misses: 2, last: { date: '2026-08-20', text: '08-20 的財報後審查沒有一致結論' } } }, '2026-12-01')).toEqual([
      { key: 'BUILD_STALE@2026-05-01', every: null, since: '2026-08-20', text: 'MU 先買的一半已經 7 個月沒有補滿（兩次財報後的審查都沒有過關，最近一次：08-20 的財報後審查沒有一致結論）。要補滿、維持一半，或重新寫論點，到持股頁決定。' },
    ]);
    expect(buildStaleLine('MU', meta, '2026-11-20')[0].text).toBe('MU 先買的一半已經 6 個月沒有補滿（開檔滿 200 天還沒有財報後的審查）。要補滿、維持一半，或重新寫論點，到持股頁決定。');
    expect(OWN_ATTN.some((k) => k.kind === 'BUILD_STALE')).toBe(true);
  });

  it('持股頁：先買一半的說明；拖太久時的那一句（兩個按鈕：維持現在的大小、請 stock bot 草擬）；「要看的事」也列', () => {
    const sim = new Sim(makeMarket('2026-11-23', 5), scenarios.s1().init);
    toBuild(sim.acct, 'MSFT', 0.06);
    const d = holdingDetail(ready(sim), 'MSFT')!;
    expect(d.own).toMatchObject({ state: '先買一半', askBuild: false });
    expect(d.own!.build!.text).toBe('你選了先買一半：現在的目標是標準比重 6.0% 的一半（3.0%），還沒買的部分留在核心。開檔之後的第一份財報過關（那份財報觸發的審查 3 票一致、沒有任何前提被判不成立）就在下一份月報補滿。');
    expect(d.own!.build!.stale).toBeNull();
    const h = accountView(ready(sim)).holdings.find((x) => x.ticker === 'MSFT')!;
    expect(h).toMatchObject({ state: '先買一半', tone: 'ok' });
    // 兩份財報沒過
    sim.acct.own.MSFT.build!.misses = 2;
    sim.acct.own.MSFT.build!.last = { date: '2026-11-10', text: '11-10 的財報後審查沒有一致結論' };
    const s = holdingDetail(ready(sim), 'MSFT')!.own!.build!;
    expect(s.stale).toContain('MSFT 先買的一半已經');
    expect(s.text).toContain('11-10 的財報後審查沒有一致結論，等下一份財報。');
    const file = metaFile(sim.acct, 'MSFT', sim.pre.date)!;
    expect(ownAttention([file], sim.acct, sim.pre).filter((x) => x.kind === 'BUILD_STALE').map((x) => x.text)).toEqual([s.stale!.replace('在這一頁決定', '到持股頁決定')]); // 持股頁上寫「在這一頁決定」，「要看的事」寫「到持股頁決定」（T86 P12a）
    // 只有預設前提的寫法
    toBuild(sim.acct, 'META', 0.06);
    expect(holdingDetail(ready(sim), 'META')!.own!.build!.text).toContain('程式比對系統預設前提 D1～D3 都沒有不成立');
    // 網站：兩個按鈕與一鍵改
    const js = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'js', 'pages-holding.js'), 'utf8');
    expect(js).toContain("actionButton('維持現在的大小'");
    expect(js).toContain("'/ops/build-keep'");
    expect(js).toContain("actionButton('改成已經買到這個比例'");
    expect(js).toContain("'/ops/build-full'");
    expect(js).toContain('draftAction(d.ticker, d.own.draft, { before: [keep] })');
    // T85 乙段：從候補名單進場（自己先買）的預選「先買一半」（allocation_redesign §4.1 表單上的預設）；其他的照舊預選「已經買到這個比例」
    expect(js).toContain("radio('full', '已經買到這個比例', !d.own.askBuildHalf)");
    expect(js).toContain("d.own.askBuildHalf ? '先買一半，確認後再補滿（從候補名單進場的預設）' : '先買一半，確認後再補滿', !!d.own.askBuildHalf)");
  });

  it('「維持現在的大小」：標準比重改成實際比重、離開先買一半；「改成已經買到這個比例」：目標回到標準比重；還沒回覆的補滿跟著取消', () => {
    const sim = new Sim(makeMarket('2026-11-23', 50), scenarios.s1().init);
    toBuild(sim.acct, 'MSFT', 0.06);
    const w = (sim.acct.lots.own.MSFT * priceOf(sim.pre, 'MSFT')) / totalValue(sim.acct, sim.pre);
    const keep = endBuild(sim.acct, sim.pre, 'MSFT', true);
    expect([keep.own.MSFT.slow.state, keep.rule.own.MSFT.applied, keep.own.MSFT.build]).toEqual(['STD', 'STD', undefined]);
    expect(keep.rule.own.MSFT.stdWeight).toBeCloseTo(w, 12);
    const fullA = endBuild(sim.acct, sim.pre, 'MSFT', false);
    expect(fullA.rule.own.MSFT).toEqual({ applied: 'STD', stdWeight: 0.06 });
    expect(endBuild(fullA, sim.pre, 'MSFT', true)).toBe(fullA); // 已經不是先買一半
    // 還沒回覆的補滿
    sim.acct = buildEarnings(sim.acct, 'MSFT', { date: '2026-11-20', pass: true, text: '過關' });
    const m = monthlyReport(sim.acct, sim.pre, { order: [], month: 'x' });
    sim.acct = m.acct;
    const it = item(m.notif, 'F27', 'MSFT');
    const after = endBuild(sim.acct, sim.pre, 'MSFT', false);
    const it2 = after.notifs.find((x) => x.id === m.notif.id)!.items.find((x) => x.key === it.key)!;
    expect(it2).toMatchObject({ cancelled: true, note: '你改成已經買到這個比例，這一項取消' });
  });

  it('選了先買一半但其實買足了（占總資產 ≥ 標準比重的九成）→ 持股頁那一句與一鍵改；不到就沒有', () => {
    const sim = new Sim(makeMarket('2026-11-23', 5), scenarios.s1().init);
    toBuild(sim.acct, 'MSFT', 0.06);
    expect(BUILD_FULL_AT).toBe(0.9);
    expect(buildViewOf(sim.acct, sim.pre, 'MSFT', 0.054)!.full).toBe('你選了先買一半，但現在已經是打算的比例；要改成「已經買到這個比例」嗎？');
    expect(buildViewOf(sim.acct, sim.pre, 'MSFT', 0.05)!.full).toBeNull();
    expect(buildViewOf(sim.acct, sim.pre, 'MU', 0.5)).toBeNull();
    // 第一次設定標準比重的選項
    sim.acct.own.MU.buildAsk = true;
    expect(holdingDetail(ready(sim), 'MU')!.own!.askBuild).toBe(true);
  });
});

// ================================================================ 125% 的新門檻（§4.3、D6）

describe('T83：raiseAllowed——連兩次財報後的審查都證實、最近兩季營收年增為正、標準狀態；拿掉 126 天', () => {
  const REV = { ok: true, why: '兩季都正' };
  const base = () => {
    const sim = new Sim(makeMarket('2026-11-23', 5), scenarios.s1().init);
    sim.acct = recordEarnCheck(sim.acct, 'MSFT', { date: '2026-05-20', confirmed: true, why: '' });
    sim.acct = recordEarnCheck(sim.acct, 'MSFT', { date: '2026-08-20', confirmed: true, why: '' });
    sim.acct.own.MSFT.slow.aboveRun = 0;
    return sim.acct;
  };

  it('都成立就可以（站不站在均線上無關）；營收沒過、資料不夠不行；12 個月內提高過不行', () => {
    const a = base();
    expect(raiseAllowed(a, 'MSFT', '2026-11-20', { revenue: REV })).toEqual({ ok: true, why: '規則條件成立' });
    expect(raiseAllowed(a, 'MSFT', '2026-11-20', { revenue: { ok: false, why: '2026-09-30 +3.0%、2026-06-30 -1.0%，不是兩季都為正' } }).why).toBe('最近兩季營收年增不是都為正（2026-09-30 +3.0%、2026-06-30 -1.0%，不是兩季都為正）');
    expect(raiseAllowed(a, 'MSFT', '2026-11-20').ok).toBe(false);
    a.own.MSFT.raisedAt = '2026-03-01';
    expect(raiseAllowed(a, 'MSFT', '2026-11-20', { revenue: REV }).why).toBe('上次提高是 2026-03-01，未滿 12 個月');
  });

  it('財報後的審查本身是第二次：只要上一次證實過；其他觸發原因要最近兩次都證實；earnChecks 只留最近兩筆', () => {
    const a = base();
    a.own.MSFT.earnChecks![0].confirmed = false;
    expect(raiseAllowed(a, 'MSFT', '2026-11-20', { revenue: REV }).why).toBe('最近兩次財報後的審查沒有都證實前提（2026-05-20 沒有證實、2026-08-20 證實）');
    expect(raiseAllowed(a, 'MSFT', '2026-11-20', { revenue: REV, trigger: 'EARNINGS' }).ok).toBe(true);
    const b = recordEarnCheck(a, 'MSFT', { date: '2026-11-20', confirmed: false, why: '沒有結論' });
    expect(b.own.MSFT.earnChecks!.map((c) => [c.date, c.confirmed])).toEqual([['2026-08-20', true], ['2026-11-20', false]]);
    expect(raiseAllowed(b, 'MSFT', '2026-11-21', { revenue: REV, trigger: 'EARNINGS' }).ok).toBe(false);
    const none = structuredClone(a);
    delete none.own.MSFT.earnChecks;
    expect(raiseAllowed(none, 'MSFT', '2026-11-20', { revenue: REV }).why).toBe('最近兩次財報後的審查沒有都證實前提（還沒有財報後的審查）');
  });

  it('只在標準狀態：先買一半、審查後持有、減半各有原因；買進前的程式檢查（30 天內前提被判不成立、硬事件標記）也擋', () => {
    const a = base();
    toBuild(a, 'MSFT', 0.05);
    expect(raiseAllowed(a, 'MSFT', '2026-11-20', { revenue: REV }).why).toBe('先買一半、還沒補滿');
    const w = base();
    w.own.MSFT.slow.state = 'WATCH';
    expect(raiseAllowed(w, 'MSFT', '2026-11-20', { revenue: REV }).why).toContain('審查後持有中');
    const h = base();
    h.rule.own.MSFT.applied = 'HALF';
    expect(raiseAllowed(h, 'MSFT', '2026-11-20', { revenue: REV }).why).toBe('減半中');
    const br = recordAiTier(base(), 'MSFT', 'HOLD', '2026-11-10', false, 'r', { premiseId: 'P2' });
    expect(raiseAllowed(br, 'MSFT', '2026-11-20', { revenue: REV }).why).toBe('11/10 有前提被判不成立');
    const fl = base();
    fl.own.MSFT.flags = ['ACCOUNTING'];
    expect(raiseAllowed(fl, 'MSFT', '2026-11-20', { revenue: REV }).why).toContain('硬事件標記');
  });

  it('月報的 125%（F23）：買進前的程式檢查沒過就不列、持股頁寫原因；說明不再畫「連續站上 200 日均線」的條', () => {
    const sim = new Sim(makeMarket('2026-11-23', 5), scenarios.s1().init);
    sim.acct = recordAiTier(sim.acct, 'MSFT', 'RAISE', '2026-11-20', true, 'rev-9');
    sim.acct.own.MSFT.flags = ['ACCOUNTING'];
    const m = monthlyReport(sim.acct, sim.pre, { order: [], month: 'x' });
    expect(m.notif.items.some((i) => i.f === 'F23')).toBe(false);
    expect(m.acct.own.MSFT.buyBlocked).toMatchObject({ what: '提高到 125%', text: '這檔有未解除的硬事件標記（ACCOUNTING）' });
    sim.acct = m.acct;
    expect(holdingDetail(ready(sim), 'MSFT')!.own!.buyBlocked).toBe('提高到 125%的條件成立了，但這檔有未解除的硬事件標記（ACCOUNTING），這次不提提高到 125%；下個月月報再看一次。');
    const ok = new Sim(makeMarket('2026-11-23', 5), scenarios.s1().init);
    ok.acct = recordAiTier(ok.acct, 'MSFT', 'RAISE', '2026-11-20', true, 'rev-9');
    const om = monthlyReport(ok.acct, ok.pre, { order: [], month: 'x' });
    ok.acct = om.acct;
    const f23 = item(om.notif, 'F23', 'MSFT');
    const x = notifView(ready(ok), om.notif).items.find((i) => i.key === f23.key)!;
    expect(x.meter).toBeNull();
    expect(x.explain.rule).toContain('連續兩次財報後的審查都證實每一條前提');
    expect(x.explain.rule).not.toContain('6 個月');
  });
});

describe('T83 prompt：own_review_v6 是新檔，v5 留著；run.md 不用改', () => {
  const PROMPTS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'ai', 'prompts');
  const read = (f: string) => readFileSync(join(PROMPTS, f), 'utf8').replace(/\r\n/g, '\n');
  it('版本與檔頭；125% 的說明改寫（不看均線、連兩次財報證實、營收）；先買一半不要為了補滿選 STANDARD', () => {
    expect(OWN_REVIEW_PROMPT).toBe('own_review_v6');
    const v6 = read('own_review_v6.md');
    expect(v6.split('\n')[0]).toBe('# own_review_v6：自選定期審查（F24）');
    expect(v6).toContain('和 v5 的差別（2026-11-23，T83');
    expect(v6).toContain('**股價漲跌、站不站在均線上都不是理由**');
    expect(v6).toContain('最近兩季營收年增都是正的');
    expect(v6).toContain('不用、也不要為了補滿選 `STANDARD`');
    expect(v6).not.toContain('規則條件成立的月份');
    const v5 = read('own_review_v5.md');
    expect(v5.split('\n')[0]).toContain('> 不再使用（2026-11-23）：T83 起改用 `own_review_v6.md`');
    expect(v5).toContain('# own_review_v5：');
    // run.md 照 prompt_version 找檔（只拿 v3 當例子），不用改、不用重貼
    expect(read('run.md')).not.toMatch(/own_review_v[56]/);
  });
});

// SLOW 用在 ladder 的註解（-20%）；確認常數沒有被改
it('T83：慢規則的門檻沒變（-20%、200 日線、10 天、15 天）', () => {
  expect(SLOW).toMatchObject({ drawdown: -0.2, maDays: 200, aboveRun: 10, minGap: 15 });
});
