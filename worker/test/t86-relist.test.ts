// T86 修正 P1、P11（階段十二）：持股頁第一次設定標準比重時選了「先買一半」，還沒回覆的新增自選清單（F14）照一半重算。
// 設計：docs/design/allocation_redesign_2026-11-22.md §4.1（實作細節 3、7，與 T86 修正 9）、§4.6 第 1、2 列。
// 走一遍的紀錄：docs/test-records/t86_walkthrough_2026-11-23.md 問題清單 P1、P11。
//   P1 的重現：新增自選 AAPL 6% → 清單「買到標準比重」還沒回覆 → 持股頁選「先買一半」→ 原本清單仍是買足
//   修正：還沒回覆、把這檔買到目標的單（新增自選、補做差額、入金只減不加）當場照新的目標重算；已經照做、等填快照的不動；
//         改回（一鍵改「已經買到這個比例」）照標準比重重算；錢從核心照比例拿的行跟著變（composeNotif）
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env, Fetcher } from '../src/app/env';
import type { HoldingDetail, NotifView } from '../src/app/site/views';
import {
  addOwn,
  composeNotif,
  deposit,
  endBuild,
  priceOf,
  relistedSince,
  resolveFollowUp,
  respond,
  setStdWeight,
  totalValue,
  type Account,
  type Item,
  type MarketView,
  type Notif,
} from '../src/engine';
import { handle } from '../src/index';
import { freshDb } from './helpers/d1';
import { scenarios } from './helpers/scenarios';
import { Sim } from './helpers/sim';

const DATE = '2026-12-10';
function start(): Sim {
  const sc = scenarios.s5();
  const sim = new Sim(sc.market, sc.init);
  sim.runUntil(DATE);
  return sim;
}
const notifOf = (a: Account, id: number): Notif => a.notifs.find((n) => n.id === id)!;
const f14 = (a: Account, id: number): Item => notifOf(a, id).items.find((i) => i.f === 'F14')!;
const buyOf = (it: Item, t = 'AAPL') => (it.choices.find((c) => c.id === 'DO')?.lines ?? []).filter((l) => l.bucket === 'own' && l.ticker === t).reduce((a, l) => a + l.shares, 0);
/** 預覽裡核心那幾行合計的金額（負的是從核心賣出）。 */
const coreValue = (n: Notif, v: MarketView) => (n.preview?.lines ?? []).filter((l) => l.bucket === 'core').reduce((a, l) => a + l.shares * priceOf(v, l.ticker), 0);
const coreLines = (n: Notif) => (n.preview?.lines ?? []).filter((l) => l.bucket === 'core').map((l) => `${l.ticker} ${l.shares}`);
/** 新增自選 AAPL 6%（標準狀態、第一次設定標準比重時要問）。 */
function addAapl(sim: Sim) {
  const r = addOwn(sim.acct, sim.pre, 'AAPL', undefined, 0.06);
  expect(r.acct.own.AAPL.buildAsk).toBe(true);
  expect(r.acct.rule.own.AAPL).toEqual({ applied: 'STD', stdWeight: 0.06 });
  const px = priceOf(sim.pre, 'AAPL');
  const total = totalValue(r.acct, sim.pre);
  return { r, id: r.notif.id, full: Math.floor((0.06 * total) / px), half: Math.floor((0.06 * total * 0.5) / px) };
}

describe('T86 修正 P1：選了先買一半，還沒回覆的新增自選清單照一半重算', () => {
  it('重現步驟：新增自選 AAPL 6% → 還沒回覆 → 持股頁選先買一半 → 清單的股數是一半、標題與說明跟著換、錢從核心拿的行跟著變', () => {
    const sim = start();
    const { r, id, full, half } = addAapl(sim);
    expect(buyOf(f14(r.acct, id))).toBe(full);
    expect(f14(r.acct, id).title).toBe('新增自選 AAPL：買到標準比重 6.0%');
    expect(full).toBeGreaterThan(10);
    const before = notifOf(r.acct, id);
    const a = setStdWeight(r.acct, 'AAPL', 0.06, { build: true, date: sim.pre.date, view: sim.pre });
    expect(a.rule.own.AAPL).toEqual({ applied: 'BUILD', stdWeight: 0.06 });
    const it = f14(a, id);
    expect(buyOf(it)).toBe(half);
    expect(Math.abs(2 * half - full)).toBeLessThanOrEqual(1);
    // P16：標題跟著新的買法，後面註明是 12/9 才改的（持股頁「這檔的紀錄」看起來才不像新增那天就選了）
    expect(it.title).toBe('新增自選 AAPL：你選了先買一半 → 先買標準比重 6.0% 的一半，開檔後第一份財報的審查過關再補滿（12/9 你在持股頁選了先買一半）');
    expect(it.note).toBe(`12/9 你在持股頁選了先買一半：照標準比重 6.0% 的一半重算，買 ${half} 股（原本 ${full} 股）`);
    // 錢從核心照比例拿：預覽照現有的合成重算，核心少賣了約 (full − half) 股 AAPL 的錢
    const n = notifOf(a, id);
    expect(n.preview).toEqual(composeNotif(a, sim.pre, n));
    expect(coreLines(n)).not.toEqual(coreLines(before));
    const saved = coreValue(n, sim.pre) - coreValue(before, sim.pre);
    expect(saved).toBeGreaterThan(0);
    expect(Math.abs(saved - (full - half) * priceOf(sim.pre, 'AAPL'))).toBeLessThan(priceOf(sim.pre, 'VOO') + priceOf(sim.pre, 'SGOV'));
    // 持股頁存了之後那一句用的比對
    expect(relistedSince(r.acct, a, 'AAPL')).toEqual([{ notif: id, name: '12/9 的「新增自選 AAPL」', from: full, to: half }]);
    // 照重算後的清單回覆、照做：買的是一半
    const done = respond(a, sim.pre, id, { mode: 'DO' });
    expect(notifOf(done, id).composed!.merged.find((m) => m.ticker === 'AAPL')!.shares).toBe(half);
  });

  it('已經照做、等填快照的不動（那時已經下單了）；填了買足的快照 → 照舊出現「改成已經買到這個比例」', () => {
    const sim = start();
    const { r, id, full } = addAapl(sim);
    sim.acct = respond(r.acct, sim.pre, id, { mode: 'DO' });
    const composed = notifOf(sim.acct, id).composed;
    const a = setStdWeight(sim.acct, 'AAPL', 0.06, { build: true, date: sim.pre.date, view: sim.pre });
    expect(a.rule.own.AAPL.applied).toBe('BUILD');
    expect(buyOf(f14(a, id))).toBe(full);
    expect(f14(a, id).note).toBeUndefined();
    expect(notifOf(a, id).composed).toEqual(composed);
    expect(relistedSince(sim.acct, a, 'AAPL')).toEqual([]);
  });

  it('改回：一鍵改「已經買到這個比例」→ 還沒回覆的清單回到標準比重；「維持現在的大小」但一股都沒有 → 不動', () => {
    const sim = start();
    const { r, id, full, half } = addAapl(sim);
    const a = setStdWeight(r.acct, 'AAPL', 0.06, { build: true, date: sim.pre.date, view: sim.pre });
    const back = endBuild(a, sim.pre, 'AAPL', false);
    expect(back.rule.own.AAPL).toEqual({ applied: 'STD', stdWeight: 0.06 });
    const it = f14(back, id);
    expect(buyOf(it)).toBe(full);
    expect(it.title).toBe('新增自選 AAPL：買到標準比重 6.0%（12/9 你改成已經買到這個比例）');
    expect(it.note).toBe(`12/9 你改成已經買到這個比例：照標準比重 6.0% 重算，買 ${full} 股（原本 ${half} 股）`);
    const n = notifOf(back, id);
    expect(n.preview).toEqual(composeNotif(back, sim.pre, n));
    expect(coreLines(n)).toEqual(coreLines(notifOf(r.acct, id)));
    expect(relistedSince(a, back, 'AAPL')).toEqual([{ notif: id, name: '12/9 的「新增自選 AAPL」', from: half, to: full }]);
    // 維持現在的大小：0 股時標準比重沒改，不把清單改回買足
    const keep = endBuild(a, sim.pre, 'AAPL', true);
    expect(buyOf(f14(keep, id))).toBe(half);
  });

  it('之後再改標準比重（不是第一次）也照新的目標重算；沒給市場（view）或目標沒變就不動', () => {
    const sim = start();
    const { r, id, full } = addAapl(sim);
    const a = setStdWeight(r.acct, 'AAPL', 0.06, { build: true, date: sim.pre.date, view: sim.pre });
    const b = setStdWeight(a, 'AAPL', 0.04, { view: sim.pre });
    const want = Math.floor((0.04 * totalValue(b, sim.pre) * 0.5) / priceOf(sim.pre, 'AAPL'));
    expect(buyOf(f14(b, id))).toBe(want);
    expect(f14(b, id).note).toContain('你在持股頁把標準比重改成 4.0%：照標準比重 4.0% 的一半重算');
    expect(f14(b, id).title).toContain('先買標準比重 4.0% 的一半');
    // 沒給 view：只改帳上的目標（舊的呼叫方式）
    expect(buyOf(f14(setStdWeight(r.acct, 'AAPL', 0.04), id))).toBe(full);
    // 第一次選「已經買到這個比例」、比重沒變：不重算
    const same = setStdWeight(r.acct, 'AAPL', 0.06, { build: false, view: sim.pre });
    expect(f14(same, id)).toEqual(f14(r.acct, id));
  });

  it('補做差額（F17）：新增自選照做了但沒買 → 補做的清單還沒回覆時選先買一半，補做的股數照一半重算', () => {
    const sim = start();
    const { r, id, full, half } = addAapl(sim);
    sim.acct = respond(r.acct, sim.pre, id, { mode: 'DO' });
    const snap = sim.open({ AAPL: 0 })!;
    expect(snap.acct.own.AAPL).toBeDefined();
    const fu = sim.acct.notifs.find((n) => n.followUp?.some((x) => x.ticker === 'AAPL'));
    expect(fu).toBeDefined();
    const fix = resolveFollowUp(sim.acct, sim.pre, fu!.id, true);
    const n0 = fix.notif!;
    const f17 = (a: Account) => notifOf(a, n0.id).items.find((i) => i.f === 'F17' && i.ticker === 'AAPL')!;
    expect(buyOf(f17(fix.acct))).toBe(full);
    const a = setStdWeight(fix.acct, 'AAPL', 0.06, { build: true, date: sim.pre.date, view: sim.pre });
    const want = Math.floor((0.06 * totalValue(a, sim.pre) * 0.5) / priceOf(sim.pre, 'AAPL'));
    expect(Math.abs(want - half)).toBeLessThanOrEqual(1);
    expect(buyOf(f17(a))).toBe(want);
    expect(f17(a).note).toContain('你在持股頁選了先買一半');
    expect(notifOf(a, n0.id).preview).toEqual(composeNotif(a, sim.pre, notifOf(a, n0.id)));
  });

  it('入金（F11）上這檔的買進只減不加：先買一半之後已經超過一半 → 不用買了；改回標準比重也不加回去（多的錢照比例進核心）', () => {
    const sim = start();
    const { r, id } = addAapl(sim);
    sim.acct = respond(r.acct, sim.pre, id, { mode: 'DO' });
    sim.open();
    expect(sim.acct.own.AAPL.buildAsk).toBe(true); // 還沒在持股頁存過標準比重
    const dep = deposit(sim.acct, sim.pre, 10_000);
    // 入金產生時 AAPL 在目標上、沒有列；假裝它跌了、入金列了補 AAPL 的 5 股（產生時的目標是標準比重）
    const acct = structuredClone(dep.acct);
    const n = notifOf(acct, dep.notif.id);
    n.items[0].choices[0].lines.push({ ticker: 'AAPL', bucket: 'own', shares: 5, reason: '入金' });
    n.preview = composeNotif(acct, sim.pre, n);
    const a = setStdWeight(acct, 'AAPL', 0.06, { build: true, date: sim.pre.date, view: sim.pre });
    const it = notifOf(a, dep.notif.id).items[0];
    expect(buyOf(it)).toBe(0);
    expect(it.note).toContain('不用買了（原本 5 股）');
    expect(coreValue(notifOf(a, dep.notif.id), sim.pre)).toBeGreaterThan(coreValue(n, sim.pre));
    // 改回標準比重：入金的現金在產生時已經分配好，不加回去
    expect(buyOf(notifOf(endBuild(a, sim.pre, 'AAPL', false), dep.notif.id).items[0])).toBe(0);
  });
});

// ---------------------------------------------------------------- 網站：存了之後的那一句、持股頁與通知頁看到的是新的股數（示範模式）

let env: Env;
let dispose: () => Promise<void>;
beforeAll(async () => {
  const d = await freshDb();
  dispose = d.dispose;
  env = { DB: d.db, DEV_NO_AUTH: '1' };
});
afterAll(() => dispose());
const noNet: Fetcher = async (url) => {
  throw new Error('測試不應該連網：' + url);
};
async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const r = await handle(new Request(`https://bot.example/demo/api${path}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env, noNet, new Date('2026-12-09T23:30:00Z'));
  return { status: r.status, body: (await r.json()) as T };
}

describe('T86 修正 P1：網站', () => {
  beforeEach(async () => {
    expect((await call('POST', '/reset', { scenario: 's1' })).status).toBe(200);
  });

  it('持股頁選先買一半 → 回應帶那一句；持股頁「還沒成交的單」、通知頁的股數與說明都是新的', async () => {
    const add = await call<{ notifId: number }>('POST', '/ops/add-own', { ticker: 'AAPL', stdWeight: 0.06 });
    expect(add.status).toBe(200);
    const id = add.body.notifId;
    const n0 = (await call<NotifView>('GET', `/notif/${id}`)).body;
    const full = n0.items[0].headline;
    expect(full).toMatch(/^買 AAPL \d+ 股$/);
    const hd0 = (await call<HoldingDetail>('GET', '/holding/AAPL')).body;
    expect(hd0.own!.askBuild).toBe(true);
    const r = await call<{ ok: boolean; relisted: string[] }>('POST', '/ops/std-weight', { ticker: 'AAPL', stdWeight: 0.06, build: true });
    expect(r.status).toBe(200);
    const fullN = Number(/(\d+)/.exec(full)![1]);
    const hd = (await call<HoldingDetail>('GET', '/holding/AAPL')).body;
    const halfN = Number(/買 AAPL (\d+) 股/.exec(hd.open[0].text)![1]);
    expect(Math.abs(2 * halfN - fullN)).toBeLessThanOrEqual(1);
    expect(r.body.relisted).toEqual([`${hd.open[0].name}已經改成先買一半：買 AAPL ${halfN} 股（原本 ${fullN} 股）`]);
    expect(hd.open).toEqual([{ notif: id, name: hd.open[0].name, text: `買 AAPL ${halfN} 股（新增自選）`, decided: false }]);
    expect(hd.own!.askBuild).toBe(false);
    expect(hd.own!.state).toBe('先買一半');
    const n = (await call<NotifView>('GET', `/notif/${id}`)).body;
    const it = n.items[0];
    expect(it.headline).toBe(`買 AAPL ${halfN} 股`);
    expect(it.explain.short).toBe('你選了先買一半：先買標準比重 6.0% 的一半');
    expect(it.explain.math![0]).toContain('標準比重 6.0% × 一半');
    expect(JSON.stringify(it)).toContain(`你在持股頁選了先買一半：照標準比重 6.0% 的一半重算，買 ${halfN} 股（原本 ${fullN} 股）`);
    // 一鍵改回：回應同樣帶那一句
    const back = await call<{ relisted: string[] }>('POST', '/ops/build-full', { ticker: 'AAPL' });
    expect(back.body.relisted).toEqual([`${hd.open[0].name}已經改成買到標準比重：買 AAPL ${fullN} 股（原本 ${halfN} 股）`]);
  });
});

describe('T86 修正 P11：第一次設定標準比重時，兩個選項在輸入欄與按鈕之間，按鈕寫「存」', () => {
  it('pages-holding.js：輸入欄 → 選項 → 存；之後照舊一排「改標準比重」；存了之後那一句寫在這一塊', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const js = readFileSync(join(here, '../public/js/pages-holding.js'), 'utf8');
    expect(js).toContain("actionButton(ask ? '存' : '改標準比重', ask ? 'primary' : ''");
    expect(js).toContain("ask ? [h('div', { class: 'btn-row', style: 'align-items:center' }, std, h('span', null, '%')), askBox, h('div', { class: 'btn-row', style: 'margin-bottom:10px' }, saveStd)]");
    expect(js).toContain('relistFlash.set(d.ticker, r.relisted)');
    expect(js).toContain('const relisted = takeRelistFlash(d.ticker)');
  });
});
