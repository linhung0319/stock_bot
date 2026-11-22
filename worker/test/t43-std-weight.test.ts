// T43：標準比重留空用現在的比重，並讓使用者看得到它（design_v2 §10 第 50 點，2026-11-16 使用者同意改）。
// 完成條件：
//   1. 建立帳戶留空 → 標準比重 = 現在的比重（超過上限的取上限）；轉入、認養、清單外買進歸自選同樣
//   2. 減半之後加回會補回原本的部位
//   3. 上線第一個月不會因為預設值列「部位是標準比重的 N 倍」，月報也不會叫你賣
//   4. 自己減碼後快照結果頁有提示、入金清單的理由寫標準比重
//   5. 看得到：建立帳戶與快照新加自選的提示（現在占 X%、建議 Y%）、持股頁寫現在占多少
// 對外請求全部是假的：價格、成分股（固定檔）、LINE。
import { describe, expect, it } from 'vitest';
import { sizeOf, updateSizeFlags } from '../src/app/concentration';
import type { Env, Fetcher } from '../src/app/env';
import { runFlow, type Attempt } from '../src/app/flow';
import { LINE_PUSH_URL } from '../src/app/line';
import { loadAccount } from '../src/app/ledgerStore';
import type { HoldingDetail, NotifView } from '../src/app/site/views';
import { buildMarketView } from '../src/data/marketView';
import { loadSeries } from '../src/data/store';
import {
  CASH,
  DEFAULT_CONFIG,
  applySnapshot,
  cellKey,
  cellValues,
  classify,
  defaultStdWeight,
  itemAction,
  ownDepositFill,
  ownDepositScale,
  planDay,
  priceOf,
  recommendStdWeights,
  totalValue,
  type Account,
  type MarketView,
  type Snapshot,
} from '../src/engine';
import { handle } from '../src/index';
import { freshDb } from './helpers/d1';
import { cronTime, fakeFetcher, newWorld, type World } from './helpers/fakeSources';
import { scenarios } from './helpers/scenarios';
import { Sim } from './helpers/sim';

// ---------------------------------------------------------------- 假的世界（真實模式、本機 D1）

interface Ctx {
  db: D1Database;
  w: World;
  run: (date: string, attempt?: Attempt) => ReturnType<typeof runFlow>;
  view: (date: string, tickers: string[]) => Promise<MarketView>;
  api: <T = Record<string, unknown>>(method: 'GET' | 'POST', path: string, body?: unknown) => Promise<{ status: number; body: T }>;
}

async function withWorld(fn: (c: Ctx) => Promise<void>): Promise<void> {
  const d = await freshDb();
  try {
    const db = d.db;
    const w = newWorld('2026-11-19');
    const base = fakeFetcher(w);
    const fetcher: Fetcher = async (url, init) => (url === LINE_PUSH_URL ? Response.json({}) : base(url, init));
    const env: Env = { DB: db, ADMIN_TOKEN: 't', SITE_URL: 'https://bot.example', LINE_CHANNEL_TOKEN: 'lt', LINE_USER_ID: 'U1', DEV_NO_AUTH: '1' };
    const run = (date: string, attempt: Attempt = 'FIRST') => {
      w.dataDate = date;
      return runFlow(env, fetcher, { now: cronTime(date), attempt });
    };
    const view = async (date: string, tickers: string[]) => buildMarketView(await loadSeries(db, ['VOO', 'SGOV', ...tickers]), date, 'VOO').view;
    const api: Ctx['api'] = async (method, path, body) => {
      const r = await handle(new Request(`https://bot.example/api/${path}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env, fetcher, new Date(`${w.dataDate}T23:50:00Z`));
      return { status: r.status, body: (await r.json()) as never };
    };
    expect((await run('2026-11-19')).status).toBe('NO_ACCOUNT');
    await fn({ db, w, run, view, api });
  } finally {
    await d.dispose();
  }
}

const OWN6 = ['NVDA', 'MSFT', 'AAPL', 'AMZN', 'META', 'JPM'];

/**
 * 上線那天的帳戶：NVDA 照「推薦值的 2.5 倍」持有（T41 第 1 條的例子：持有 7%、推薦 2.6%），其他五檔各約 3%，
 * AVGO 占 20%（超過單檔上限），LLY 填了標準比重，COST 0 股。標準比重除了 LLY 都留空。
 */
async function createOnLaunch(c: Ctx): Promise<{ view: MarketView; rec: Record<string, number>; body: Record<string, unknown> }> {
  const view = await c.view('2026-11-19', [...OWN6, 'AVGO', 'LLY', 'COST']);
  const px = (t: string) => view.close[t][view.i];
  const rec = recommendStdWeights(view, [...OWN6, 'AVGO', 'LLY', 'COST'], DEFAULT_CONFIG.ratio.own);
  // 其他部位合計 rest；NVDA 的市值 v 要是總資產 T 的 2.5 × rec：T = rest + v、v = 2.5·rec·T → T = rest ÷ (1 − 2.5·rec)
  const others = { MSFT: 6000, AAPL: 6000, AMZN: 6000, META: 6000, JPM: 6000, AVGO: 40000, LLY: 4000 };
  const coreShares = Math.floor(100_000 / px('VOO'));
  const cash = 5000;
  const rest = Object.entries(others).reduce((a, [t, v]) => a + Math.floor(v / px(t)) * px(t), 0) + coreShares * px('VOO') + cash;
  const T = rest / (1 - 2.5 * rec.NVDA);
  const own = [
    { ticker: 'NVDA', shares: Math.round((2.5 * rec.NVDA * T) / px('NVDA')) },
    ...Object.entries(others).map(([t, v]) => ({ ticker: t, shares: Math.floor(v / px(t)), ...(t === 'LLY' ? { stdWeight: 0.04 } : {}) })),
    { ticker: 'COST', shares: 0 },
  ];
  const body = { paper: true, cash, coreShares, own };
  const r = await c.api('POST', 'account', body);
  expect(r.status).toBe(200);
  return { view, rec, body };
}

const weightOf = (a: Account, view: MarketView, t: string) => ((a.lots.own[t] ?? 0) * priceOf(view, t)) / totalValue(a, view);

describe('留空的預設：現在占總資產的比重', () => {
  it('建立帳戶留空 → 標準比重 = 現在的比重；超過單檔上限的取 15%；有填的照填；0 股的用推薦值', async () => {
    await withWorld(async (c) => {
      const { view, rec } = await createOnLaunch(c);
      const a = (await loadAccount(c.db))!.acct;
      for (const t of OWN6) expect(a.rule.own[t].stdWeight).toBeCloseTo(weightOf(a, view, t), 12);
      // NVDA 照推薦值算會是 rec（持有的 2.5 分之一），現在是持有的比重
      expect(a.rule.own.NVDA.stdWeight / rec.NVDA).toBeCloseTo(2.5, 1);
      expect(weightOf(a, view, 'AVGO')).toBeGreaterThan(0.15);
      expect(a.rule.own.AVGO.stdWeight).toBe(DEFAULT_CONFIG.ownCapHi);
      expect(a.rule.own.LLY.stdWeight).toBe(0.04);
      expect(a.rule.own.COST.stdWeight).toBeCloseTo(rec.COST, 12);
      // 引擎的同一個規則
      expect(defaultStdWeight(700, 10_000, 0.15, 0.026)).toBeCloseTo(0.07, 12);
      expect(defaultStdWeight(2_000, 10_000, 0.15, 0.026)).toBe(0.15);
      expect(defaultStdWeight(0, 10_000, 0.15, 0.026)).toBe(0.026);
    });
  });

  it('轉入自選 → 標準比重 = 轉進來之後占總資產的比重（原本用推薦值）', () => {
    const sc = scenarios.s1();
    const sim = new Sim(sc.market, sc.init, { vetoes: { '2026-12': ['APP'] } });
    sim.runUntil('2026-12-01');
    const n = sim.preOpen()!;
    const it = n.items.find((i) => i.f === 'F2' && i.ticker === 'ORCL')!;
    const r = itemAction(sim.acct, sim.pre, n.id, it.key, { action: 'TRANSFER', reason: '雲端訂單還在成長' });
    expect(r.acct.lots.own.ORCL).toBe(28);
    const w = weightOf(r.acct, sim.pre, 'ORCL');
    expect(r.acct.rule.own.ORCL.stdWeight).toBeCloseTo(w, 12);
    const rec = recommendStdWeights(sim.pre, [...Object.keys(sim.acct.rule.own), 'ORCL'], sim.acct.cfg.ratio.own).ORCL;
    expect(Math.abs(r.acct.rule.own.ORCL.stdWeight - rec)).toBeGreaterThan(0.001); // 不是推薦值
  });

  it('認養 → 標準比重 = 照清單買進之後占總資產的比重', () => {
    const sc = scenarios.s1();
    const sim = new Sim(sc.market, sc.init, { vetoes: { '2026-12': ['APP'] } });
    sim.runUntil('2026-12-01');
    const n = sim.preOpen()!;
    const ge = n.items.find((i) => i.f === 'F1' && i.ticker === 'GE')!;
    const listed = ge.choices[0].lines[0].shares;
    expect(listed).toBeGreaterThan(0);
    const r = itemAction(sim.acct, sim.pre, n.id, ge.key, { action: 'ADOPT', reason: '看好航太引擎的售後服務' });
    expect(r.acct.own.GE.origin).toBe('ADOPT');
    expect(r.acct.rule.own.GE.stdWeight).toBeCloseTo((listed * priceOf(sim.pre, 'GE')) / totalValue(sim.acct, sim.pre), 12);
    // 買進之後：部位就是標準比重，入金不會再補、也不會被當成「部位太大」
    sim.acct = r.acct;
    sim.respond(n.id);
    sim.open();
    const s = sizeOf(sim.acct, sim.pre, 'GE')!;
    expect(s.ratio).toBeLessThan(1.5);
  });

  it('清單外買進歸自選（分桶快照、分類）→ 歸進來之後的比重；快照可以自己填標準比重', () => {
    const sc = scenarios.s1();
    const sim = new Sim(sc.market, sc.init);
    sim.runUntil('2026-11-20');
    const view = sim.pre;
    const a0 = sim.acct;
    const px = priceOf(view, 'GE');
    // 分桶快照：自選加 GE 20 股、AVGO 10 股（AVGO 填了標準比重 3%），現金扣掉
    const lots = { own: { ...a0.lots.own, GE: 20, AVGO: 10 }, mom: { ...a0.lots.mom }, core: { ...a0.lots.core } };
    const shares: Record<string, number> = {};
    for (const b of [lots.own, lots.mom, lots.core]) for (const [t, q] of Object.entries(b)) shares[t] = (shares[t] ?? 0) + q;
    const snap: Snapshot = { shares, lots, cash: a0.cash - 20 * px - 10 * priceOf(view, 'AVGO'), std: { AVGO: 0.03 } };
    const s = applySnapshot(a0, view, snap);
    expect(s.error).toBeUndefined();
    expect(s.acct.rule.own.GE.stdWeight).toBeCloseTo(weightOf(s.acct, view, 'GE'), 12);
    expect(s.acct.rule.own.AVGO.stdWeight).toBe(0.03);
    // 舊的總股數快照 → 分類通知 → 歸自選
    const old = applySnapshot(a0, view, { shares: { ...shares, AVGO: 0 }, cash: a0.cash - 20 * px });
    const cls = old.created.find((x) => x.ticker === 'GE')!;
    const k = classify(old.acct, view, cls.id, { bucket: 'own', reason: '航太售後' });
    expect(k.error).toBeUndefined();
    expect(k.acct.rule.own.GE.stdWeight).toBeCloseTo(weightOf(k.acct, view, 'GE'), 12);
  });
});

describe('減半之後加回、第一個月', () => {
  it('減半之後加回會補回原本的部位（原本加回只補到推薦值，等於永久少一半）', async () => {
    await withWorld(async (c) => {
      const { view, rec } = await createOnLaunch(c);
      const a = (await loadAccount(c.db))!.acct;
      const k = cellKey('own', 'NVDA');
      const v0 = cellValues(a, view);
      const half = planDay({ cfg: a.cfg, values: v0, state: a.rule, ownActions: { NVDA: 'REDUCE' } });
      expect(half.targets[k]).toBeCloseTo(v0[k] / 2, 6);
      expect(half.state.own.NVDA.applied).toBe('HALF');
      const back = planDay({ cfg: a.cfg, values: half.targets, state: half.state, ownActions: { NVDA: 'READD' } });
      expect(back.state.own.NVDA.applied).toBe('STD');
      expect(back.targets[k]).toBeCloseTo(v0[k], 6); // 回到上線那天的部位
      // 對照：照推薦值當標準比重，加回時目標是 max(一半, 推薦值) = 一半，一股都不買
      const recState = { ...half.state, own: { ...half.state.own, NVDA: { ...half.state.own.NVDA, stdWeight: rec.NVDA } } };
      const old = planDay({ cfg: a.cfg, values: half.targets, state: recState, ownActions: { NVDA: 'READD' } });
      expect(old.targets[k]).toBeCloseTo(v0[k] / 2, 6);
    });
  });

  it('上線第一個月：不列「部位是標準比重的 N 倍」，月報也不叫你賣上線那天的部位（超過單檔上限的照舊減回）', async () => {
    await withWorld(async (c) => {
      const { view, rec } = await createOnLaunch(c);
      const a0 = (await loadAccount(c.db))!.acct;
      // 對照：照推薦值，NVDA 第一天就是 2.5 倍 → 會設旗、第一份月報列 SIZE_2X
      const withRec = structuredClone(a0);
      withRec.rule.own.NVDA.stdWeight = rec.NVDA;
      expect(updateSizeFlags(withRec, view).own.NVDA.sizeFlag).toBe(true);
      expect(updateSizeFlags(a0, view)).toBe(a0); // 沒有任何一檔設旗
      for (const day of ['2026-11-20', '2026-11-23', '2026-11-24', '2026-11-25', '2026-11-27', '2026-11-30']) await c.run(day);
      const a = (await loadAccount(c.db))!.acct;
      for (const t of Object.keys(a.own)) expect(a.own[t].sizeFlag ?? false).toBe(false);
      const m = a.notifs.find((n) => n.kind === 'MONTHLY' || n.kind === 'MONTHLY_EMPTY');
      expect(m).toBeDefined();
      // 月報上的自選賣單只有單檔上限（AVGO 上線那天就超過 15%，和標準比重無關）與慢規則的減半
      const sells = m!.items.flatMap((it) => it.choices.find((x) => x.id === it.ruleChoice)?.lines ?? []).filter((l) => l.bucket === 'own' && l.shares < 0);
      for (const l of sells) expect(['單檔上限', '自選訊號', '跨桶上限']).toContain(l.reason);
      expect(sells.filter((l) => l.ticker !== 'AVGO')).toEqual([]);
      expect(sells.some((l) => l.ticker === 'AVGO' && l.reason === '單檔上限')).toBe(true);
      const v = (await c.api<NotifView>('GET', `notif/${m!.id}`)).body;
      expect(JSON.stringify(v)).not.toContain('是標準比重的');
    });
  });
});

describe('自己減碼之後、看得到', () => {
  it('自己減碼後快照結果頁有提示（連到持股頁）；入金清單補自選那一行寫「補到標準比重」；改成現在的比重就不補', async () => {
    await withWorld(async (c) => {
      const { view } = await createOnLaunch(c);
      const a = (await loadAccount(c.db))!.acct;
      const std = a.rule.own.NVDA.stdWeight;
      const keep = Math.floor(a.lots.own.NVDA / 4);
      const sold = a.lots.own.NVDA - keep;
      const lots = { own: { ...a.lots.own, NVDA: keep }, mom: { ...a.lots.mom }, core: { ...a.lots.core } };
      const r = await c.api<{ ok: boolean; belowStd: { ticker: string; weight: number; std: number; half: boolean; fill: number; scaled: boolean }[] }>('POST', 'snapshot', { lots, cash: a.cash + sold * priceOf(view, 'NVDA'), note: 'NVDA 漲太多，自己先賣掉大部分' });
      expect(r.status).toBe(200);
      expect(r.body.belowStd).toHaveLength(1);
      // 這個帳戶的自選標準比重合計超過 20%（AVGO 15%、NVDA 約 9%…）：入金照比例少補，fill 是縮過的
      const a1 = (await loadAccount(c.db))!.acct;
      expect(ownDepositScale(a1.rule, a1.cfg.ratio.own)).toBeLessThan(1);
      expect(r.body.belowStd[0]).toMatchObject({ ticker: 'NVDA', std, half: false, scaled: true, fill: ownDepositFill(a1.rule, a1.cfg, 'NVDA') });
      expect(r.body.belowStd[0].fill).toBeLessThan(std);
      const after = (await loadAccount(c.db))!.acct;
      expect(r.body.belowStd[0].weight).toBeCloseTo(weightOf(after, view, 'NVDA'), 12);
      expect(after.rule.own.NVDA.stdWeight).toBe(std); // 自己減碼不改標準比重
      // 入金：NVDA 補回標準比重，那一行的說明寫出來
      const dep = await c.api<{ notifId: number; preview: NotifView }>('POST', 'ops/deposit', { amount: 20_000, dry: true });
      expect(dep.status).toBe(200);
      const it = dep.body.preview.items[0];
      const line = it.choices[0].lines.find((l) => l.ticker === 'NVDA' && l.bucket === 'own');
      expect(line && line.shares > 0).toBe(true);
      const fact = it.explain.facts!.find((f) => f.label === '自選 NVDA')!;
      // 「目前」照入金之後的總資產算（和目標同一個分母）
      const tot = totalValue(after, view);
      const fill = ownDepositFill(after.rule, after.cfg, 'NVDA')!;
      expect(fact.note).toBe(`目前 ${((weightOf(after, view, 'NVDA') * tot * 100) / (tot + 20_000)).toFixed(1)}%，入金補到 ${(fill * 100).toFixed(1)}%（自選合計超過預算，入金照比例少補）；加回補到標準比重 ${(std * 100).toFixed(1)}%`);
      // 入金清單的說明多一句：合計超過、多的錢去動能與核心
      expect(it.explain.why).toContain('多的錢去動能與核心');
      // 持股頁：寫出現在占多少
      const hd = (await c.api<HoldingDetail>('GET', 'holding/NVDA')).body;
      expect(hd.own!.weight).toBeCloseTo(weightOf(after, view, 'NVDA'), 12);
      expect(hd.own!.stdWeight).toBe(std);
      // 不想補回：標準比重改成現在的比重 → 入金不再買 NVDA
      expect((await c.api('POST', 'ops/std-weight', { ticker: 'NVDA', stdWeight: Number(hd.own!.weight.toFixed(4)) })).status).toBe(200);
      const dep2 = await c.api<{ preview: NotifView }>('POST', 'ops/deposit', { amount: 20_000, dry: true });
      expect(dep2.body.preview.items[0].choices[0].lines.some((l) => l.ticker === 'NVDA' && l.bucket === 'own')).toBe(false);
    });
  });

  it('照清單賣的、賣光的、減完仍不低於標準比重的，都不列提示；減半中的照一半算', () => {
    const sc = scenarios.s1();
    const sim = new Sim(sc.market, sc.init);
    sim.runUntil('2026-11-20');
    const view = sim.pre;
    const a0 = structuredClone(sim.acct);
    // MU 標準比重設成現在的一半：賣掉 1 股還是高於標準比重 → 不列
    a0.rule.own.MU.stdWeight = weightOf(a0, view, 'MU') / 2;
    // META 減半中：標準比重設成現在的 2.4 倍 → 一半是 1.2 倍；賣掉一半後 0.5 倍 → 列，half = true
    a0.rule.own.META.applied = 'HALF';
    a0.rule.own.META.stdWeight = weightOf(a0, view, 'META') * 2.4;
    const metaKeep = Math.floor(a0.lots.own.META / 2);
    const lots = { own: { ...a0.lots.own, MU: a0.lots.own.MU - 1, META: metaKeep, MSFT: 0 }, mom: { ...a0.lots.mom }, core: { ...a0.lots.core } };
    const shares: Record<string, number> = {};
    for (const b of [lots.own, lots.mom, lots.core]) for (const [t, q] of Object.entries(b)) if (q) shares[t] = (shares[t] ?? 0) + q;
    const s = applySnapshot(a0, view, { shares, lots, cash: a0.cash });
    expect(s.error).toBeUndefined();
    expect(s.removedOwn).toEqual(['MSFT']);
    expect(s.belowStd.map((x) => x.ticker)).toEqual(['META']);
    expect(s.belowStd[0].half).toBe(true);
  });

  it('提示的端點：建立帳戶前照填的股數算「現在占 X%（建議 Y%）」與留空時的值；快照時算新加的那一檔、合計含帳上其他自選', async () => {
    await withWorld(async (c) => {
      const view = await c.view('2026-11-19', ['NVDA', 'MSFT']);
      const px = (t: string) => view.close[t][view.i];
      const holdings = { own: { NVDA: 40, MSFT: 20 }, mom: {}, core: { VOO: 100, SGOV: 0 } };
      const total = 40 * px('NVDA') + 20 * px('MSFT') + 100 * px('VOO') + 3000;
      const r = await c.api<{ rows: Record<string, { now: number; rec: number; std: number }>; sumStd: number; budget: number; missing: string[] }>('POST', 'std-hint', { holdings, cash: 3000, tickers: ['NVDA', 'MSFT'], std: { MSFT: 0.05 } });
      expect(r.status).toBe(200);
      const rec = recommendStdWeights(view, ['NVDA', 'MSFT'], 0.2);
      expect(r.body.rows.NVDA.now).toBeCloseTo((40 * px('NVDA')) / total, 12);
      expect(r.body.rows.NVDA.rec).toBeCloseTo(rec.NVDA, 12);
      expect(r.body.rows.NVDA.std).toBeCloseTo(Math.min(0.15, (40 * px('NVDA')) / total), 12);
      expect(r.body.rows.MSFT.std).toBe(0.05);
      expect(r.body.sumStd).toBeCloseTo(r.body.rows.NVDA.std + 0.05, 12);
      expect(r.body.budget).toBe(0.2);
      // 建立帳戶之後，快照新加 AMZN：合計含帳上的 NVDA、MSFT
      await c.api('POST', 'account', { paper: true, cash: 3000, coreShares: 100, own: [{ ticker: 'NVDA', shares: 40 }, { ticker: 'MSFT', shares: 20 }] });
      const a = (await loadAccount(c.db))!.acct;
      c.w.fail.add('ZZZZ');
      const r2 = await c.api<{ rows: Record<string, { now: number; rec: number; std: number }>; sumStd: number; missing: string[] }>('POST', 'std-hint', { holdings: { ...holdings, own: { ...holdings.own, AMZN: 10 } }, cash: 2000, tickers: ['AMZN', 'ZZZZ'] });
      expect(r2.status).toBe(200);
      expect(r2.body.missing).toContain('ZZZZ');
      expect(r2.body.rows.AMZN.now).toBeGreaterThan(0);
      expect(r2.body.sumStd).toBeCloseTo(a.rule.own.NVDA.stdWeight + a.rule.own.MSFT.stdWeight + r2.body.rows.AMZN.std, 12);
      // 快照真的送出、AMZN 沒填標準比重 → 和提示的「留空就用」相同
      const lots = { own: { NVDA: 40, MSFT: 20, AMZN: 10 }, mom: {}, core: { VOO: 100 } };
      const s = await c.api('POST', 'snapshot', { lots, cash: 2000 });
      expect(s.status).toBe(200);
      expect((await loadAccount(c.db))!.acct.rule.own.AMZN.stdWeight).toBeCloseTo(r2.body.rows.AMZN.std, 12);
      // 快照填了標準比重（百分比換成小數送來）
      const s2 = await c.api<{ error?: string }>('POST', 'snapshot', { lots: { ...lots, own: { ...lots.own, JPM: 5 } }, cash: 1500, std: { JPM: 0.02 } });
      expect(s2.status).toBe(200);
      expect((await loadAccount(c.db))!.acct.rule.own.JPM.stdWeight).toBe(0.02);
      const bad = await c.api<{ error: string }>('POST', 'snapshot', { lots: { ...lots, own: { ...lots.own, JPM: 5, COST: 1 } }, cash: 1000, std: { COST: 70 } });
      expect(bad.status).toBe(422);
      expect(bad.body.error).toContain('標準比重');
    });
  });
});

describe('入金的分配：自選標準比重合計超過自選比例時照比例少補（保留 §2.2「自選桶合計靠入金慢慢拉回預算」）', () => {
  /** 一個總資產 100、三格自選的狀態：values 是每一格的市值。 */
  const state = (std: Record<string, number>, half: string[] = []) => ({
    own: Object.fromEntries(Object.entries(std).map(([t, w]) => [t, { applied: half.includes(t) ? ('HALF' as const) : ('STD' as const), stdWeight: w }])),
    heldMom: ['M1'],
    effPrev: 1,
    volHist: [],
    volW: null,
  });
  const cfg = DEFAULT_CONFIG;
  const own = (t: string) => cellKey('own', t);

  it('合計超過 → 入金時自選只補到縮小後的目標，多的錢去動能與核心，自選桶占比下降；加回仍補到沒縮的標準比重', () => {
    // 自選三檔各 10%、合計 30%（超過 20%）；A、B 自己減碼到 6%，C 10%；動能一格 6%、核心其餘
    const st = state({ A: 0.1, B: 0.1, C: 0.1 });
    const values = { [own('A')]: 6, [own('B')]: 6, [own('C')]: 10, [cellKey('mom', 'M1')]: 6, [cellKey('core', cfg.coreTicker)]: 72 };
    expect(ownDepositScale(st, cfg.ratio.own)).toBeCloseTo(0.2 / 0.3, 12);
    const p = planDay({ cfg, values, state: st, flow: { kind: '入金', amount: 50 } });
    // 入金後總資產 150：沒縮時 A、B 要補到 15（10%）；縮了只補到 150 × 10% × 2/3 = 10
    expect(p.targets[own('A')]).toBeCloseTo(10, 9);
    expect(p.targets[own('B')]).toBeCloseTo(10, 9);
    expect(p.targets[own('C')]).toBe(10); // 已經高於縮過的目標：不買
    // 自選桶占比：入金前 22%，入金後 30 ÷ 150 = 20%（下降）；多的錢去動能（補到 150 × 30% ÷ 5 = 9）與核心
    const ownAfter = p.targets[own('A')] + p.targets[own('B')] + p.targets[own('C')];
    expect(ownAfter / 150).toBeLessThan(22 / 100);
    expect(p.targets[cellKey('mom', 'M1')]).toBeCloseTo(9, 9);
    // T80（allocation_redesign §1.4）：進核心的錢照 80：20 分到 VOO 與現金格（原本全部進 VOO）
    const coreAfter = p.targets[cellKey('core', cfg.coreTicker)] + p.targets[cellKey('core', CASH)];
    expect(coreAfter).toBeCloseTo(150 - ownAfter - 9, 9);
    expect(p.targets[cellKey('core', CASH)]).toBeCloseTo(0.2 * (coreAfter - 72), 9);
    // 減半之後的加回：照沒縮的標準比重補（A 減半中，加回補到 10%）
    const half = state({ A: 0.1, B: 0.1, C: 0.1 }, ['A']);
    const back = planDay({ cfg, values: { ...values, [own('A')]: 3 }, state: half, ownActions: { A: 'READD' } });
    expect(back.targets[own('A')]).toBeCloseTo(0.1 * 97, 9); // 總資產 97（A 減到 3）的 10%
  });

  it('合計沒超過 → 和原本一樣：自選照標準比重補（減半的補一半）', () => {
    const st = state({ A: 0.08, B: 0.08, C: 0.04 }, ['C']); // 8% + 8% + 2% = 18%
    expect(ownDepositScale(st, cfg.ratio.own)).toBe(1);
    const values = { [own('A')]: 4, [own('B')]: 8, [own('C')]: 1, [cellKey('mom', 'M1')]: 6, [cellKey('core', cfg.coreTicker)]: 81 };
    const p = planDay({ cfg, values, state: st, flow: { kind: '入金', amount: 50 } });
    expect(p.targets[own('A')]).toBeCloseTo(0.08 * 150, 9);
    expect(p.targets[own('B')]).toBeCloseTo(0.08 * 150, 9);
    expect(p.targets[own('C')]).toBeCloseTo(0.04 * 0.5 * 150, 9);
    // 剛好等於自選比例也不縮（重放的帳戶：自選比例 ÷ 檔數，浮點誤差不算超過）
    const exact = state({ A: 0.2 / 3, B: 0.2 / 3, C: 0.2 / 3 });
    expect(ownDepositScale(exact, cfg.ratio.own)).toBe(1);
    // 出金不受影響
    const w = planDay({ cfg, values: { ...values, [own('A')]: 12 }, state: state({ A: 0.2, B: 0.1, C: 0.1 }), flow: { kind: '出金', amount: 5 } });
    expect(w.targets[own('A')]).toBe(12);
  });
});
