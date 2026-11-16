// T39c：拆股與合股（docs/plan/thesis_plan_2026-11-15.md 階段八 T39 → T39c；設計 design_v2 §10 第 48 點）。
// 完成條件：拆股與合股各一個情境測試（拆股前有還沒填快照的清單、拆股後才填快照）；價格基準跟著調的測試；重放驗收數字不變（test/replay.test.ts）。
// 市場是可重現的假資料（test/helpers/fakeSources.ts 的 splits 做拆股：生效日起成交價 ÷ 比例，Yahoo 可以已經換算或還沒換算之前的價格）。
import { describe, expect, it } from 'vitest';
import type { Env, Fetcher } from '../src/app/env';
import { runFlow } from '../src/app/flow';
import { loadAccount, saveAccount } from '../src/app/ledgerStore';
import { buildMarketView } from '../src/data/marketView';
import { adjustUnadjustedSplits, parseYahooChart } from '../src/data/sources';
import { loadSeries, loadSplits } from '../src/data/store';
import {
  applySnapshot,
  applySplits,
  createAccount,
  dailyCheck,
  deposit,
  drawdownFromHigh,
  pendingSplits,
  respond,
  splitLabel,
  type Account,
  type MarketView,
  type Split,
} from '../src/engine';
import { handle } from '../src/index';
import { freshDb } from './helpers/d1';
import { cronTime, fakeClose, fakeFetcher, newWorld, type World } from './helpers/fakeSources';

// ---------------------------------------------------------------- 資料層：Yahoo 的拆股事件、還沒換算的價格

const yahooJson = (days: string[], close: number[], splits?: Record<string, { date: number; numerator: number; denominator: number }>) => ({
  chart: {
    result: [
      {
        meta: { symbol: 'XYZ', currency: 'USD', gmtoffset: -18000 },
        timestamp: days.map((d) => Date.parse(d + 'T14:30:00Z') / 1000),
        ...(splits ? { events: { splits } } : {}),
        indicators: { quote: [{ open: close, high: close, low: close, close, volume: close.map(() => 1000) }], adjclose: [{ adjclose: close }] },
      },
    ],
    error: null,
  },
});
const ts = (d: string) => Date.parse(d + 'T14:30:00Z') / 1000;

describe('T39c 資料層：拆股事件與存下來的價格', () => {
  const days = ['2027-06-04', '2027-06-07', '2027-06-08', '2027-06-09', '2027-06-10', '2027-06-11'];

  it('讀出 Yahoo 回應裡的拆股事件（生效日、比例）；沒有事件是空的', () => {
    const s = parseYahooChart(yahooJson(days, [1000, 1010, 990, 1000, 101, 102], { [ts('2027-06-10')]: { date: ts('2027-06-10'), numerator: 10, denominator: 1 } }));
    expect(s.splits).toEqual([{ date: '2027-06-10', numerator: 10, denominator: 1 }]);
    expect(parseYahooChart(yahooJson(days, [1, 1, 1, 1, 1, 1])).splits).toEqual([]);
    expect(splitLabel({ numerator: 10, denominator: 1 })).toBe('1 拆 10');
    expect(splitLabel({ numerator: 1, denominator: 10 })).toBe('10 合 1');
    expect(splitLabel({ numerator: 3, denominator: 2 })).toBe('2 拆 3');
  });

  it('Yahoo 還沒換算之前的價格（生效日那一根約是前一根的 1/10）→ 生效日之前除以比例、成交量乘回去；已經換算好的不動', () => {
    const ev = { [ts('2027-06-10')]: { date: ts('2027-06-10'), numerator: 10, denominator: 1 } };
    const raw = adjustUnadjustedSplits(parseYahooChart(yahooJson(days, [1000, 1010, 990, 1000, 101, 102], ev)));
    expect(raw.bars.map((b) => Math.round(b.close * 100) / 100)).toEqual([100, 101, 99, 100, 101, 102]);
    expect(raw.bars.map((b) => Math.round(b.adjClose * 100) / 100)).toEqual([100, 101, 99, 100, 101, 102]);
    expect(raw.bars[0].volume).toBe(10_000);
    expect(raw.bars[5].volume).toBe(1000);
    const done = parseYahooChart(yahooJson(days, [100, 101, 99, 100, 101, 102], ev));
    expect(adjustUnadjustedSplits(done)).toBe(done);
    // 合股（10 合 1）：還沒換算時生效日那一根約是前一根的 10 倍
    const rev = { [ts('2027-06-10')]: { date: ts('2027-06-10'), numerator: 1, denominator: 10 } };
    expect(adjustUnadjustedSplits(parseYahooChart(yahooJson(days, [5, 5.1, 4.9, 5, 50.5, 51], rev))).bars.map((b) => Math.round(b.close * 100) / 100)).toEqual([50, 51, 49, 50, 50.5, 51]);
  });

  it('2 拆 3 的生效日剛好真的跌 20%（已經換算好）→ 不會被當成還沒換算；回應裡還沒有生效日那一根 → 不動', () => {
    const ev = { [ts('2027-06-10')]: { date: ts('2027-06-10'), numerator: 3, denominator: 2 } };
    const s = parseYahooChart(yahooJson(days, [100, 101, 99, 100, 80, 81], ev));
    expect(adjustUnadjustedSplits(s)).toBe(s);
    const early = parseYahooChart(yahooJson(days.slice(0, 4), [1000, 1010, 990, 1000], ev));
    expect(adjustUnadjustedSplits(early)).toBe(early);
  });

  it('每日抓取記下拆股（splits 表）；Yahoo 還沒換算時存下來的收盤與還原收盤在生效日前後是連續的（慢規則、動能、門檻條都從這裡算）', async () => {
    const d = await freshDb();
    try {
      const w = newWorld('2026-11-20');
      w.splits = { NVDA: { date: '2026-11-20', numerator: 10, denominator: 1, adjusted: false } };
      const env: Env = { DB: d.db, ADMIN_TOKEN: 't', SITE_URL: 'https://bot.example', DEV_NO_AUTH: '1' };
      await runFlow(env, fakeFetcher(w), { now: cronTime('2026-11-20'), attempt: 'FIRST' });
      expect(await loadSplits(d.db, '2026-11-19')).toEqual([{ ticker: 'NVDA', date: '2026-11-20', numerator: 10, denominator: 1 }]);
      const s = (await loadSeries(d.db, ['NVDA'])).get('NVDA')!;
      const k = s.d.indexOf('2026-11-20');
      const cont = fakeClose('NVDA', '2026-11-20') / fakeClose('NVDA', '2026-11-19');
      expect(s.c[k] / s.c[k - 1]).toBeCloseTo(cont, 3);
      expect(s.a[k] / s.a[k - 1]).toBeCloseTo(cont, 3);
      expect(s.c[0]).toBeCloseTo(fakeClose('NVDA', s.d[0]) / 10, 2);
    } finally {
      await d.dispose();
    }
  });
});

// ---------------------------------------------------------------- 引擎：applySplits（純函式）

/** 每檔一條固定的價格（300 天）。 */
function flatView(px: Record<string, number>, n = 300, date = '2027-06-10'): MarketView {
  return { date, i: n - 1, close: Object.fromEntries(Object.entries(px).map(([t, p]) => [t, new Float64Array(n).fill(p)])) };
}
const NV10: Split = { ticker: 'NVDA', date: '2027-06-10', numerator: 10, denominator: 1 };

function baseAccount(): { acct: Account; view: MarketView } {
  const view = flatView({ VOO: 500, SGOV: 100, NVDA: 1000, MU: 100 }, 300, '2027-06-08');
  const acct = createAccount({ paper: true, cash: 20_000, core: { VOO: 100 }, own: { NVDA: { shares: 5, stdWeight: 0.12 }, MU: { shares: 50, stdWeight: 0.05 } } }, view);
  return { acct, view };
}

describe('T39c 引擎：applySplits', () => {
  it('持股與還沒成交的清單（等你下單的入金清單）股數乘上比例；帳本記一行；套用過就不再套用；拆股前已經對照過券商的不套用', () => {
    const { acct: a0, view } = baseAccount();
    const dep = deposit(a0, view, 20_000);
    const a1 = respond(dep.acct, view, dep.notif.id, { mode: 'DO' });
    const n1 = a1.notifs.find((n) => n.id === dep.notif.id)!;
    const listed = n1.composed!.lines.filter((l) => l.ticker === 'NVDA').reduce((s, l) => s + l.shares, 0);
    expect(listed).toBeGreaterThan(0);
    const r = applySplits(a1, [NV10, { ticker: 'AAPL', date: '2027-06-10', numerator: 4, denominator: 1 }]);
    expect(r.applied.map((s) => s.ticker)).toEqual(['NVDA']);
    expect(r.acct.lots.own.NVDA).toBe(50);
    expect(r.acct.lots.own.MU).toBe(50);
    const n2 = r.acct.notifs.find((n) => n.id === dep.notif.id)!;
    expect(n2.composed!.lines.filter((l) => l.ticker === 'NVDA').reduce((s, l) => s + l.shares, 0)).toBe(listed * 10);
    expect(n2.composed!.merged.find((m) => m.ticker === 'NVDA')!.shares).toBe(listed * 10);
    expect(n2.composed!.cashAfter).toBe(n1.composed!.cashAfter);
    expect(r.acct.events.filter((e) => e.kind === 'SPLIT')).toEqual([{ date: '2027-06-10', kind: 'SPLIT', ticker: 'NVDA', bucket: 'own', shares: 45, reason: '1 拆 10，5 股 → 50 股' }]);
    // 沒持有的 AAPL 也記成套用過（之後用拆股後的價格算的清單不會又被乘一次）
    expect(Object.keys(r.acct.splits!).sort()).toEqual(['AAPL@2027-06-10', 'NVDA@2027-06-10']);
    expect(applySplits(r.acct, [NV10]).acct).toBe(r.acct);
    // 單位數、現金、標準比重不動
    expect(r.acct.units).toEqual(a1.units);
    expect(r.acct.cash).toBe(a1.cash);
    expect(r.acct.rule.own.NVDA.stdWeight).toBe(a1.rule.own.NVDA.stdWeight);
    // 券商那時已經顯示拆股後的股數（快照在生效日當天或之後送出）→ 不套用
    expect(pendingSplits({ ...a1, splitAsOf: '2027-06-10' }, [NV10])).toEqual([]);
    expect(pendingSplits({ ...a1, splitAsOf: '2027-06-09' }, [NV10])).toEqual([NV10]);
    // 舊帳戶沒有 splitAsOf：用最後一份快照的日期
    const old = { ...a1 };
    delete old.splitAsOf;
    expect(pendingSplits({ ...old, snapshotDate: '2027-06-10' }, [NV10])).toEqual([]);
  });

  it('合股（10 合 1）：整股無條件捨去，零頭留給下一次快照的現金差；清單的行四捨五入、至少 1 股；兩桶合計捨去後補回小數最大的那一桶', () => {
    const view = flatView({ VOO: 500, SGOV: 100, NVDA: 10 }, 300, '2027-06-08');
    const acct = createAccount({ paper: true, cash: 5000, core: { VOO: 100 }, own: { NVDA: { shares: 105, stdWeight: 0.1 } }, mom: { NVDA: 37 } }, view);
    const r = applySplits(acct, [{ ticker: 'NVDA', date: '2027-06-10', numerator: 1, denominator: 10 }]);
    // 合計 142 → 14.2 → 14；自選 10.5、動能 3.7 → 先各捨去成 10、3，剩 1 股給小數大的動能
    expect(r.acct.lots.own.NVDA).toBe(10);
    expect(r.acct.lots.mom.NVDA).toBe(4);
    expect(r.acct.events.filter((e) => e.kind === 'SPLIT').map((e) => [e.bucket, e.shares, e.reason])).toEqual([
      ['own', -95, '10 合 1，105 股 → 10 股'],
      ['mom', -33, '10 合 1，37 股 → 4 股'],
    ]);
  });

  it('價格基準跟著調：拆股後存下來的價格是換算後的，慢規則不會因為股價變 1/10 而減半；之後真的跌 20% 時減半的股數是拆股後的一半', () => {
    const view0 = flatView({ VOO: 500, SGOV: 100, NVDA: 1000 }, 300, '2027-06-08');
    const acct0 = createAccount({ paper: true, cash: 50_000, core: { VOO: 100 }, own: { NVDA: { shares: 50, stdWeight: 0.3 } } }, view0);
    const acct = applySplits(acct0, [NV10]).acct;
    expect(acct.lots.own.NVDA).toBe(500);
    // 拆股後的價格（整段已經換算成 100）：距 52 週高點 0%，不減半
    const adj = flatView({ VOO: 500, SGOV: 100, NVDA: 100 }, 300, '2027-06-10');
    expect(drawdownFromHigh(adj.close.NVDA, adj.i)).toBe(0);
    const day = dailyCheck(acct, adj).acct;
    expect(day.own.NVDA.slow.state).toBe('STD');
    expect(day.notifs.some((n) => n.items.some((i) => i.f === 'F7'))).toBe(false);
    // 如果價格沒換算（前面 1000、生效日 100），距高點 -90% 就會被當成減半
    const raw = flatView({ VOO: 500, SGOV: 100, NVDA: 1000 }, 300, '2027-06-10');
    (raw.close.NVDA as Float64Array)[raw.i] = 100;
    expect(drawdownFromHigh(raw.close.NVDA, raw.i)).toBeCloseTo(-0.9, 6);
    // 之後真的跌到 75（-25%）→ 減半賣 250 股（拆股後 500 股的一半）
    const drop = flatView({ VOO: 500, SGOV: 100, NVDA: 100 }, 301, '2027-06-11');
    (drop.close.NVDA as Float64Array)[drop.i] = 75;
    const half = dailyCheck(day, drop).acct;
    const f7 = half.notifs.flatMap((n) => n.items).find((i) => i.f === 'F7' && i.ticker === 'NVDA')!;
    expect(f7.choices[0].lines.filter((l) => l.ticker === 'NVDA')).toMatchObject([{ bucket: 'own', shares: -250 }]);
  });

  it('拆股套用之後才填的快照：N 倍股數照清單對帳，不算自己買進、不出現「可能填錯」；快照記下送出時的美東日期', () => {
    const { acct: a0, view } = baseAccount();
    const dep = deposit(a0, view, 20_000);
    const a1 = respond(dep.acct, view, dep.notif.id, { mode: 'DO' });
    const n1 = a1.notifs.find((n) => n.id === dep.notif.id)!;
    const after = applySplits(a1, [NV10]).acct;
    const adj = flatView({ VOO: 500, SGOV: 100, NVDA: 100, MU: 100 }, 300, '2027-06-08');
    const lots = { own: { ...after.lots.own }, mom: {}, core: { ...after.lots.core } } as Record<'own' | 'mom' | 'core', Record<string, number>>;
    for (const l of after.notifs.find((n) => n.id === dep.notif.id)!.composed!.lines) lots[l.bucket][l.ticker] = (lots[l.bucket][l.ticker] ?? 0) + l.shares;
    const shares: Record<string, number> = {};
    for (const b of ['own', 'mom', 'core'] as const) for (const [t, q] of Object.entries(lots[b])) shares[t] = (shares[t] ?? 0) + q;
    const out = applySnapshot(after, adj, { shares, lots, cash: n1.composed!.cashAfter, asOf: '2027-06-10' });
    expect(out.error).toBeUndefined();
    expect(out.completed).toEqual([dep.notif.id]);
    expect(out.followUps).toEqual([]);
    expect(out.cashWarn).toBe(false);
    expect(Math.abs(out.cashOther)).toBeLessThan(1);
    expect(out.acct.events.some((e) => e.kind === 'TRADE' && /手動交易/.test(e.reason ?? ''))).toBe(false);
    expect(out.acct.splitAsOf).toBe('2027-06-10');
  });
});

// ---------------------------------------------------------------- 情境：拆股前有還沒填快照的清單、拆股後才填快照（網站 API、真實模式）

type Api = <T = Record<string, unknown>>(method: 'GET' | 'POST', path: string, body?: unknown, now?: Date) => Promise<{ status: number; body: T }>;
interface Form {
  buckets: Record<'own' | 'mom' | 'core', { ticker: string; book: number; listed: number; expected: number }[]>;
  cashExpected: number;
}
interface SnapRes {
  completed: number[];
  followUps: number[];
  created: unknown[];
  cashOther: number;
  cashWarn: boolean;
}

const D = '2026-11-20';

/**
 * 11/19 建好帳戶（自選 NVDA 照 s 股）；11/20 早上（台灣）入金 20,000，清單決定好了、還沒下單填快照。
 * split：11/20（美東）生效的拆股。
 */
async function splitWorld(split: { numerator: number; denominator: number; adjusted: boolean }, nvdaShares: (px: number) => number, fn: (c: { db: D1Database; w: World; env: Env; fetcher: Fetcher; api: Api; depositId: number; form: Form; nvda0: number }) => Promise<void>) {
  const d = await freshDb();
  try {
    const db = d.db;
    const w = newWorld('2026-11-19');
    const env: Env = { DB: db, ADMIN_TOKEN: 't', SITE_URL: 'https://bot.example', DEV_NO_AUTH: '1' };
    const fetcher = fakeFetcher(w);
    await runFlow(env, fetcher, { now: cronTime('2026-11-19'), attempt: 'FIRST' });
    const { view } = buildMarketView(await loadSeries(db, ['VOO', 'SGOV', 'NVDA']), '2026-11-19', 'VOO');
    const px = (t: string) => view.close[t][view.i];
    const nvda0 = nvdaShares(px('NVDA'));
    const acct = createAccount({ paper: true, cash: 5000, core: { VOO: Math.floor(150_000 / px('VOO')) }, own: { NVDA: { shares: nvda0, stdWeight: 0.12 } } }, view);
    await saveAccount(db, acct, null, '建立帳戶', new Date('2026-11-19T22:00:00Z'));
    const api: Api = async (method, path, body, now = new Date('2026-11-20T02:00:00Z')) => {
      const r = await handle(new Request(`https://bot.example/api/${path}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env, fetcher, now);
      return { status: r.status, body: (await r.json()) as never };
    };
    const dep = await api<{ notifId: number }>('POST', 'ops/deposit', { amount: 20_000 });
    expect(dep.status).toBe(200);
    const form = (await api<Form>('GET', 'snapshot/form')).body;
    expect(form.buckets.own.find((r) => r.ticker === 'NVDA')!.listed).toBeGreaterThan(0);
    // 11/20 生效的拆股（Yahoo 從這一天起才帶拆股事件）
    w.splits = { NVDA: { date: D, ...split } };
    await fn({ db, w, env, fetcher, api, depositId: dep.body.notifId, form, nvda0 });
  } finally {
    await d.dispose();
  }
}

/** 照券商填：拆股之前算好的「照清單做完」股數，NVDA 換算成拆股後的（券商的做法：整股捨去）。 */
function brokerLots(form: Form, ratio: number): Record<'own' | 'mom' | 'core', Record<string, number>> {
  const out = { own: {}, mom: {}, core: {} } as Record<'own' | 'mom' | 'core', Record<string, number>>;
  for (const b of ['own', 'mom', 'core'] as const) for (const r of form.buckets[b]) if (r.expected) out[b][r.ticker] = r.ticker === 'NVDA' ? Math.floor(r.book * ratio + 1e-9) + Math.max(1, Math.round(r.listed * ratio)) : r.expected;
  return out;
}

async function expectSplitApplied(c: { db: D1Database; api: Api }, o: { depositId: number; res: { status: number; body: SnapRes }; nvdaAfter: number; text: RegExp; now: Date }) {
  expect(o.res.status).toBe(200);
  expect(o.res.body.completed).toEqual([o.depositId]);
  expect(o.res.body.followUps).toEqual([]);
  expect(o.res.body.created).toEqual([]);
  expect(o.res.body.cashWarn).toBe(false);
  const acct = (await loadAccount(c.db))!.acct;
  expect(acct.lots.own.NVDA).toBe(o.nvdaAfter);
  // 沒有被當成自己買進（清單外的手動交易），帳本有拆股那一行
  const ledger = (await c.db.prepare("SELECT kind, ticker, bucket, shares, reason FROM ledger_events WHERE ticker = 'NVDA' ORDER BY id").all<{ kind: string; reason: string | null }>()).results;
  expect(ledger.filter((e) => e.kind === 'TRADE').every((e) => !/手動交易/.test(e.reason ?? ''))).toBe(true);
  expect(ledger.filter((e) => e.kind === 'SPLIT')).toHaveLength(1);
  const hist = await c.api<{ events: { date: string; text: string }[] }>('GET', 'history', undefined, o.now);
  expect(hist.body.events.find((e) => e.date === D && /^(拆股|合股)：/.test(e.text))!.text).toMatch(o.text);
  const hold = await c.api<{ history: { date: string; text: string }[]; positions: { shares: number }[] }>('GET', 'holding/NVDA', undefined, o.now);
  expect(hold.body.positions[0].shares).toBe(o.nvdaAfter);
  // 持股頁的紀錄也有這一行（不重複寫代號）
  expect(hold.body.history.some((h) => h.date === D && /^(拆股|合股)：自選 [+-]\d+ 股（\d+ (拆|合) \d+，.+ 股 → .+ 股）$/.test(h.text))).toBe(true);
}

describe('T39c 情境：拆股前有還沒填快照的清單，拆股後才填快照', () => {
  it('拆股（1 拆 10）：生效日當天、每日流程還沒跑就照券商填了 10 倍股數 → 送出前查到拆股，照清單完成，不算自己買進、沒有「可能填錯」；復原快照不會刪掉拆股那一行', async () => {
    await splitWorld({ numerator: 10, denominator: 1, adjusted: true }, (px) => Math.floor(10_000 / px), async (c) => {
      // 美東 11/20 上午：Yahoo 已經帶拆股事件與 11/20 盤中那一根；最近一個已收盤的交易日還是 11/19
      c.w.dataDate = D;
      const now = new Date('2026-11-20T16:00:00Z');
      const before = (await loadAccount(c.db))!.acct;
      expect(before.lots.own.NVDA).toBe(c.nvda0);
      const lots = brokerLots(c.form, 10);
      const calls = c.w.calls.length;
      const res = await c.api<SnapRes>('POST', 'snapshot', { lots, cash: c.form.cashExpected }, now);
      // 只重抓股數差很多倍的那一檔
      expect(c.w.calls.slice(calls).filter((u) => u.includes('/chart/'))).toEqual([expect.stringContaining('/chart/NVDA?')]);
      const listed = c.form.buckets.own.find((r) => r.ticker === 'NVDA')!.listed;
      await expectSplitApplied(c, { depositId: c.depositId, res, nvdaAfter: (c.nvda0 + listed) * 10, text: new RegExp(`^拆股：自選 NVDA \\+${c.nvda0 * 9} 股（1 拆 10，${c.nvda0.toLocaleString('en-US')} 股 → ${(c.nvda0 * 10).toLocaleString('en-US')} 股）$`), now });
      const acct = (await loadAccount(c.db))!.acct;
      expect(acct.splitAsOf).toBe(D);
      expect(acct.splits).toEqual({ 'NVDA@2026-11-20': D });
      // 存下來的 11/19 收盤已經是拆股後的
      const s = (await loadSeries(c.db, ['NVDA'])).get('NVDA')!;
      expect(s.c.at(-1)).toBeCloseTo(fakeClose('NVDA', '2026-11-19') / 10, 2);
      // 復原這份快照：帳戶回到送出前（已經套用拆股、清單還在等下單），拆股那一行留著
      const undo = await c.api('POST', 'snapshot/undo', {}, now);
      expect(undo.status).toBe(200);
      const back = (await loadAccount(c.db))!.acct;
      expect(back.lots.own.NVDA).toBe(c.nvda0 * 10);
      expect(back.notifs.find((n) => n.id === c.depositId)!.status).toBe('RESPONDED');
      expect((await c.db.prepare("SELECT COUNT(*) AS n FROM ledger_events WHERE kind = 'SPLIT'").first<{ n: number }>())!.n).toBe(1);
    });
  });

  it('拆股（1 拆 10，Yahoo 還沒換算之前的價格）：每日流程先跑 → 帳本套用、慢規則沒有減半；之後照券商填 10 倍股數照清單完成', async () => {
    await splitWorld({ numerator: 10, denominator: 1, adjusted: false }, (px) => Math.floor(10_000 / px), async (c) => {
      c.w.dataDate = D;
      await runFlow(c.env, c.fetcher, { now: cronTime(D), attempt: 'FIRST' });
      const mid = (await loadAccount(c.db))!.acct;
      expect(mid.lots.own.NVDA).toBe(c.nvda0 * 10);
      expect(mid.own.NVDA.slow.state).toBe('STD');
      expect(mid.notifs.some((n) => n.items.some((i) => i.f === 'F7'))).toBe(false);
      // 還沒成交的清單（等你下單的入金清單）也換算了
      const form2 = (await c.api<Form>('GET', 'snapshot/form', undefined, new Date('2026-11-21T02:00:00Z'))).body;
      const listed = c.form.buckets.own.find((r) => r.ticker === 'NVDA')!.listed;
      expect(form2.buckets.own.find((r) => r.ticker === 'NVDA')).toMatchObject({ book: c.nvda0 * 10, listed: listed * 10 });
      const now = new Date('2026-11-21T02:00:00Z');
      const res = await c.api<SnapRes>('POST', 'snapshot', { lots: brokerLots(c.form, 10), cash: c.form.cashExpected }, now);
      await expectSplitApplied(c, { depositId: c.depositId, res, nvdaAfter: (c.nvda0 + listed) * 10, text: new RegExp(`^拆股：自選 NVDA \\+${c.nvda0 * 9} 股（1 拆 10，`), now });
    });
  });

  it('合股（10 合 1）：每日流程先跑 → 股數除以 10（整股捨去）、清單換算；之後照券商填的股數照清單完成，零頭的現金只記成其他現金變動', async () => {
    // 股數取 10 的倍數再加 1：合股後捨去 0.1 股，券商付現金
    await splitWorld({ numerator: 1, denominator: 10, adjusted: true }, (px) => Math.floor(10_000 / px / 10) * 10 + 1, async (c) => {
      c.w.dataDate = D;
      await runFlow(c.env, c.fetcher, { now: cronTime(D), attempt: 'FIRST' });
      const after = Math.floor(c.nvda0 / 10);
      expect((await loadAccount(c.db))!.acct.lots.own.NVDA).toBe(after);
      const listed = c.form.buckets.own.find((r) => r.ticker === 'NVDA')!.listed;
      const listedAfter = Math.max(1, Math.round(listed / 10));
      const now = new Date('2026-11-21T02:00:00Z');
      const pxAfter = fakeClose('NVDA', D) * 10;
      // 現金：清單的成交金額照拆股前算的 + 0.1 股的零頭（券商付現金）
      const cash = c.form.cashExpected + 0.1 * pxAfter + (listed / 10 - listedAfter) * fakeClose('NVDA', '2026-11-19') * 10;
      const res = await c.api<SnapRes>('POST', 'snapshot', { lots: brokerLots(c.form, 0.1), cash }, now);
      await expectSplitApplied(c, { depositId: c.depositId, res, nvdaAfter: after + listedAfter, text: new RegExp(`^合股：自選 NVDA -${c.nvda0 - after} 股（10 合 1，${c.nvda0} 股 → ${after} 股）$`), now });
      expect(Math.abs(res.body.cashOther)).toBeLessThan(0.005 * 200_000);
    });
  });

  it('填快照的股數和帳本差不多（沒有拆股的跡象）→ 不向 Yahoo 重抓；建立帳戶與快照記下送出時的美東日期，之後才記到、生效日在那天以前的拆股不再套用', async () => {
    await splitWorld({ numerator: 10, denominator: 1, adjusted: true }, (px) => Math.floor(10_000 / px), async (c) => {
      const now = new Date('2026-11-20T03:00:00Z'); // 美東 11/19 晚上
      const calls = c.w.calls.length;
      const res = await c.api<SnapRes>('POST', 'snapshot', { lots: brokerLots(c.form, 1), cash: c.form.cashExpected }, now);
      expect(res.status).toBe(200);
      expect(c.w.calls.slice(calls).filter((u) => u.includes('/chart/'))).toEqual([]);
      const acct = (await loadAccount(c.db))!.acct;
      expect(acct.splitAsOf).toBe('2026-11-19');
      // 之後記到 11/19 生效的拆股（例如 Yahoo 補登）：快照那時券商已經是拆股後的股數 → 不套用
      await c.db.prepare("INSERT INTO splits (ticker, date, numerator, denominator, seen_at) VALUES ('NVDA', '2026-11-19', 2, 1, 'x')").run();
      expect((await loadAccount(c.db))!.acct.lots.own.NVDA).toBe(acct.lots.own.NVDA);
      // 11/20 生效的才套用
      await c.db.prepare("INSERT INTO splits (ticker, date, numerator, denominator, seen_at) VALUES ('NVDA', '2026-11-20', 2, 1, 'x')").run();
      expect((await loadAccount(c.db))!.acct.lots.own.NVDA).toBe(acct.lots.own.NVDA * 2);
    });
  });
});
