// T33a：核心的修補（core_ai_design_2026-11-15 §5 的 T33a 那一列與「還沒決定的」C14）。
// 整條流程的部分（檢視什麼時候開、均線不足的告警）在 t11-ai.test.ts 的「T33a：崩盤規則檢視什麼時候開」。
import { describe, expect, it } from 'vitest';
import { crashNeeds } from '../src/app/crashAi';
import { explainItem } from '../src/app/site/explain';
import type { AiNote } from '../src/app/site/types';
import { capNoteOf } from '../src/app/site/views';
import {
  clone,
  composeNotif,
  composeWithCore,
  crashDecision,
  crashRuleOn,
  DEFAULT_CONFIG,
  deposit,
  makeItem,
  monthlyReport,
  newNotif,
  resumeMonthly,
  type Account,
  type MarketView,
  type Notif,
  type OrderLine,
} from '../src/engine';
import { ranksAt, viewAt } from './helpers/market';
import { scenarios } from './helpers/scenarios';
import { Sim } from './helpers/sim';

const cfg = DEFAULT_CONFIG;

describe('C14：核心不夠付時，買單會不會超過現金', () => {
  const price = (t: string) => ({ NVDA: 100, AAPL: 100, VOO: 500, SGOV: 100 })[t] ?? 100;
  const ctx = { cfg, price, bondTicker: 'SGOV', crash: false, cash: 1000, coreShares: 10, bondShares: 0, total: 20000 };
  const lines: OrderLine[] = [
    { ticker: 'AAPL', bucket: 'mom', shares: 30, reason: '動能換股' },
    { ticker: 'NVDA', bucket: 'own', shares: 50, reason: '新增自選' },
  ];

  // 修之前這一個測試的結果：cashAfter = -2000（買 8000，現金 1000＋核心賣光 5000）→ C14 成立
  it('買 8000、現金 1000、核心只有 5000 → 核心賣光後買單從最後一行往回減，做完現金不是負的', () => {
    const c = composeWithCore(lines, ctx);
    expect(c.merged.find((m) => m.ticker === 'VOO')!.shares).toBe(-10);
    expect(c.cashAfter).toBeGreaterThanOrEqual(0);
    // 可用 = 現金 1000 + 核心 5000；買單上限 98% = 5880 → AAPL 不動（3000），NVDA 從 50 減到 28（2800）
    expect(c.merged.find((m) => m.ticker === 'AAPL')!.shares).toBe(30);
    expect(c.merged.find((m) => m.ticker === 'NVDA')!.shares).toBe(28);
    expect(c.capped).toEqual([{ ticker: 'NVDA', cut: 22 }]);
    expect(capNoteOf(c)).toBe('核心的錢不夠付這份清單的買單，已經從最後一張買單往回減：NVDA 少買 22 股。');
  });

  it('崩盤規則啟動中先用短債、再用核心 ETF，都不夠才減買單；核心夠付時不減、沒有說明', () => {
    const c = composeWithCore(lines, { ...ctx, crash: true, coreShares: 4, bondShares: 20 });
    expect(c.merged.find((m) => m.ticker === 'SGOV')!.shares).toBe(-20);
    expect(c.merged.find((m) => m.ticker === 'VOO')!.shares).toBe(-4);
    expect(c.cashAfter).toBeGreaterThanOrEqual(0);
    expect(c.capped?.length).toBe(1);
    const ok = composeWithCore(lines, { ...ctx, coreShares: 100 });
    expect(ok.capped).toBeUndefined();
    expect(capNoteOf(ok)).toBeNull();
    expect(ok.merged.find((m) => m.ticker === 'NVDA')!.shares).toBe(50);
  });
});

describe('§3.8 崩盤規則啟動期間多的錢放短債（只動上線的清單）', () => {
  const price = (t: string) => ({ VOO: 500, SGOV: 100, MU: 100 })[t] ?? 100;
  const ctx = { cfg, price, bondTicker: 'SGOV', crash: true, cash: 0, coreShares: 50, bondShares: 250, total: 60000 };
  const sell: OrderLine[] = [{ ticker: 'MU', bucket: 'own', shares: -100, reason: '自選訊號' }];

  it('其他清單（halfUpTo 0）全部放短債；切換那一份（Infinity）照舊一半一半；入金金額以內一半一半、超過的放短債', () => {
    // 賣得 10000，98% = 9800 可以交給核心
    const other = composeWithCore(sell, { ...ctx, halfUpTo: 0 });
    expect(other.lines.filter((l) => l.bucket === 'core')).toEqual([{ ticker: 'SGOV', bucket: 'core', shares: 98, reason: '錢交給核心（崩盤規則啟動中：放短債）' }]);
    const sw = composeWithCore(sell, { ...ctx, halfUpTo: Infinity });
    expect(sw.lines.filter((l) => l.bucket === 'core').map((l) => [l.ticker, l.shares])).toEqual([
      ['VOO', 9],
      ['SGOV', 49],
    ]);
    // 入金 4000：2000 買 VOO（4 股）、2000＋超過的 5800 放短債（78 股）
    const dep = composeWithCore(sell, { ...ctx, halfUpTo: 4000 });
    expect(dep.lines.filter((l) => l.bucket === 'core').map((l) => [l.ticker, l.shares])).toEqual([
      ['VOO', 4],
      ['SGOV', 78],
    ]);
  });

  it('啟動中、不是切換月的慢規則減半 → 清單買短債不買 VOO；入金仍一半一半', () => {
    const sim = crashOnSim();
    expect(sim.acct.rule.crash).toBe(true);
    const acct = clone(sim.acct);
    const have = acct.lots.own.MSFT;
    expect(have).toBeGreaterThan(1);
    const it = makeItem({ f: 'F7', kind: 'OWN_RULE', ticker: 'MSFT', title: 'MSFT 慢規則減半', choices: [{ id: 'RULE', label: '照規則', lines: [{ ticker: 'MSFT', bucket: 'own', shares: -Math.floor(have / 2), reason: '自選訊號' }] }] });
    const n = newNotif(acct, sim.pre, { kind: 'URGENT', title: 'MSFT 慢規則減半', items: [it] });
    const c = composeNotif(acct, sim.pre, n);
    expect(c.merged.find((m) => m.ticker === 'VOO')).toBeUndefined();
    const bond = c.lines.find((l) => l.ticker === 'SGOV')!;
    expect(bond.shares).toBeGreaterThan(0);
    expect(bond.reason).toBe('錢交給核心（崩盤規則啟動中：放短債）');

    const d = deposit(sim.acct, sim.pre, 20000);
    const core = d.notif.preview!.lines.filter((l) => l.bucket === 'core');
    expect(core.find((l) => l.ticker === 'VOO')).toMatchObject({ reason: '錢交給核心（崩盤規則啟動中：一半買核心 ETF）' });
    expect(core.find((l) => l.ticker === 'VOO')!.shares).toBeGreaterThan(0);
    expect(core.find((l) => l.ticker === 'SGOV')).toMatchObject({ reason: '錢交給核心（崩盤規則啟動中：一半放短債）' });
  });
});

/** 情境 ③：1 月崩盤規則啟動、照做並成交之後（啟動期間、不是切換月）。 */
function crashOnSim(): Sim {
  const sc = scenarios.s3();
  const sim = new Sim(sc.market, sc.init);
  sim.runUntil('2027-01-04');
  const jan = sim.preOpen()!;
  sim.respond(jan.id);
  sim.open();
  sim.close();
  sim.d++;
  return sim;
}

describe('§3.1 crashNeeds（純函式部分）', () => {
  it('月報還沒回覆、有 F5 → MAKEUP，不看今天是不是月底；取消的、重列的、已經回覆的不算', () => {
    const sc = scenarios.s3();
    const sim = new Sim(sc.market, sc.init);
    sim.runUntil('2027-01-04');
    const jan = sim.preOpen()!;
    const signal = sim.pre.date;
    // 幾天之後（不是月底前一天）
    const later = viewAt(sim.market, sim.d + 3);
    const needs = (a: Account) => crashNeeds(a, later, later.date, {});
    expect(needs(sim.acct)).toEqual([{ month: '2027-01', direction: 'ON', kind: 'MAKEUP', basis: signal }]);
    const edit = (f: (n: Notif) => void) => {
      const a = clone(sim.acct);
      f(a.notifs.find((n) => n.id === jan.id)!);
      return a;
    };
    expect(needs(edit((n) => (n.items.find((i) => i.f === 'F5')!.cancelled = true)))).toEqual([]);
    expect(needs(edit((n) => (n.items.find((i) => i.f === 'F5')!.relist = true)))).toEqual([]);
    expect(needs(edit((n) => (n.status = 'RESPONDED')))).toEqual([]);
  });
});

describe('§3.3 崩盤項目的 AI 說明只用 runIds 找', () => {
  const ctxOf = (sim: Sim, acct: Account, aiNotes: AiNote[]) => ({ acct, view: sim.pre, axis: sim.market.days.slice(0, sim.d), rankOrder: [], aiNotes });
  const crashNote = (runId: string, date: string, verdict: string): AiNote => ({ kind: 'CRASH', date, verdict, summary: '', fake: false, runId });

  it('沒有 runIds 的崩盤項目不顯示別次（日期最近）的說明；有 runIds 就是那一次', () => {
    const sc = scenarios.s3();
    const sim = new Sim(sc.market, sc.init);
    sim.runUntil('2027-01-04');
    const notes = [crashNote('run-dec', '2026-12-30', '上個月的評語'), crashNote('run-jan', '2026-12-31', '這次的檢視')];
    const plain = monthlyReport(sim.acct, sim.pre, { order: ranksAt(sim.market, sim.d - 1), month: '2027-01' });
    const f5 = plain.notif.items.find((i) => i.f === 'F5')!;
    expect(f5.runIds).toBeUndefined();
    expect(explainItem(ctxOf(sim, plain.acct, notes), plain.notif, f5).ai).toBeUndefined();
    const withRun = monthlyReport(sim.acct, sim.pre, { order: ranksAt(sim.market, sim.d - 1), month: '2027-01', crashOpinion: '延後', runIds: { crash: 'run-jan' } });
    const f5b = withRun.notif.items.find((i) => i.f === 'F5')!;
    expect(explainItem(ctxOf(sim, withRun.acct, notes), withRun.notif, f5b).ai!.verdict).toBe('這次的檢視');
  });
});

describe('§3.7 月報暫停後重算用訊號日的崩盤規則判斷', () => {
  it('月報暫停期間 VOO 站回均線 → 重算後仍照訊號日啟動；說明用訊號日的收盤與均線', () => {
    const sc = scenarios.s3();
    const sim = new Sim(sc.market, sc.init);
    sim.runUntil('2027-01-04');
    const sig = sim.pre;
    expect(crashRuleOn(sig.close.VOO, sig.i)).toBe(true);
    expect(sim.acct.rule.crash).toBe(false);
    // 訊號日：有未分類的變動 → 月報暫停
    const a0 = clone(sim.acct);
    a0.lots.unc = { VOO: 1 };
    const blocked = monthlyReport(a0, sig, { order: ranksAt(sim.market, sig.i), month: '2027-01' });
    expect(blocked.notif.title).toBe('月報暫停：有未分類的持股變動');
    expect(blocked.notif.monthly!.input.crash).toMatchObject({ below: true, date: sig.date });
    // 一直到 VOO 站回均線那天才分類完、重算
    const back = sim.market.days.findIndex((d, i) => i > sig.i && !crashRuleOn(sim.market.close.VOO, i));
    expect(back).toBeGreaterThan(sig.i);
    const later = viewAt(sim.market, back);
    const a1 = clone(blocked.acct);
    a1.lots.unc = {};
    const r = resumeMonthly(a1, later);
    expect(r.notif!.items.some((i) => i.f === 'F5')).toBe(true);
    expect(r.acct.rule.crash).toBe(true);
    // 說明照訊號日的數字（股數照重算那天的價格）
    const f5 = r.notif!.items.find((i) => i.f === 'F5')!;
    const ex = explainItem({ acct: r.acct, view: later, axis: sim.market.days.slice(0, back + 1), rankOrder: [], aiNotes: [] }, r.notif!, f5);
    const md = `${Number(sig.date.slice(5, 7))}/${Number(sig.date.slice(8, 10))}`;
    expect(ex.why).toContain(`VOO ${md} 收盤`);
    expect(ex.why).toContain('低於 200 日均線');
    expect(f5.choices[0].lines.find((l) => l.ticker === 'SGOV')!.shares).toBeGreaterThan(0);
  });
});

describe('§3.10 均線算不出來：crashDecision 維持原狀態', () => {
  it('不滿 200 根有效收盤 → below = 原狀態、ok = false；夠的時候和 crashRuleOn 相同', () => {
    const up = Array.from({ length: 200 }, (_, k) => 100 + k);
    expect(crashDecision(up, 199, true)).toMatchObject({ below: false, ok: true });
    expect(crashDecision(up, 150, true)).toMatchObject({ below: true, ok: false });
    expect(crashDecision(up, 150, false)).toMatchObject({ below: false, ok: false });
    expect(crashDecision(undefined, 10, true)).toMatchObject({ below: true, ok: false });
  });

  it('月報：VOO 只有 150 根日線、帳戶啟動中 → 不解除、input.crash 記下 ma = null 與根數', () => {
    const sc = scenarios.s3();
    const sim = new Sim(sc.market, sc.init);
    sim.runUntil('2027-01-04');
    const v = sim.pre;
    const short = Float64Array.from(sim.market.close.VOO, (x, k) => (k <= v.i - 150 ? NaN : x));
    const view: MarketView = { ...v, close: { ...v.close, VOO: short as unknown as number[] } };
    const acct = clone(sim.acct);
    acct.rule.crash = true;
    const r = monthlyReport(acct, view, { order: ranksAt(sim.market, v.i), month: '2027-01' });
    expect(r.acct.rule.crash).toBe(true);
    expect(r.notif.items.some((i) => i.f === 'F5' || i.f === 'F6')).toBe(false);
    expect(r.notif.monthly!.input.crash).toEqual({ below: true, date: v.date, close: v.close.VOO[v.i], ma: null, bars: 150 });
  });
});
