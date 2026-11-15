// T33c：崩盤項目按「這次不做」之後（core_ai_design_2026-11-15 §3.6；§5 的 T33c 那一列）。
// 理由欄（和 T31b 減半項目共用的 reasonRequired／reason）、coreOwe、下一份月報重列、帳戶頁與月報的狀態文字。
import { describe, expect, it } from 'vitest';
import { crashNeeds } from '../src/app/crashAi';
import { accountBubble } from '../src/app/site/bubble';
import { explainItem } from '../src/app/site/explain';
import { accountView, notifView } from '../src/app/site/views';
import {
  CORE_OWE_SNAPSHOT_REASON,
  RELIST_OFF_NOTE,
  clone,
  deposit,
  missingReasons,
  reopen,
  restoreSaved,
  type Account,
  type Item,
  type MarketView,
  type Notif,
  type SavedState,
} from '../src/engine';
import { makeMarket } from './helpers/market';
import { scenarios } from './helpers/scenarios';
import { Sim } from './helpers/sim';

const crashItem = (n: Notif, opts: { relist?: boolean } = {}): Item | undefined => n.items.find((i) => (i.f === 'F5' || i.f === 'F6') && !i.cancelled && !!i.relist === !!opts.relist);
const f5 = (n: Notif): Item => n.items.find((i) => i.f === 'F5' && !i.relist)!;
const core = (it: Item) => it.choices[0].lines.filter((l) => l.bucket === 'core');
const ready = (acct: Account, view: MarketView) => ({ mode: 'real', acct, view, axis: [], rankOrder: [], rankSession: null, aiNotes: [], events: [], shadow: [], today: view.date, warnings: [] }) as never;
const crashStatus = (acct: Account, view: MarketView) => accountView(ready(acct, view)).status.find((s) => s.label === '崩盤規則')!;
const REASON = '覺得這次只是短暫回檔，先不換';

/** 一路往下：12 月跌破均線、之後一直在均線之下（1～4 月的月報都還在啟動中）。 */
function stayDown(): Sim {
  const sc = scenarios.s3();
  return new Sim(makeMarket('2026-12-07', 95, { market: [{ n: 18, ret: -0.11, vol: 0.3 }, { n: 77, ret: -0.04 }] }), sc.init);
}

/** 只選 F5 這次不做（寫理由），其他照預設。 */
function skipF5(sim: Sim, n: Notif, reason = REASON, item = f5(n)): void {
  sim.respond(n.id, { mode: 'DO', choices: { [item.key]: 'SKIP' }, reasons: { [item.key]: reason } });
}

/** 走完回覆之後的那一天（開盤填快照、收盤每日檢查）。 */
function finishDay(sim: Sim): void {
  sim.open();
  sim.close();
  sim.d++;
}

describe('T33c：理由欄', () => {
  it('F5 選這次不做沒寫理由不能送出（單項與整則都是）；寫了就可以；AI 檢視說延後時理由欄先填「照 AI 檢視：延後」', () => {
    const sc = scenarios.s3();
    const sim = new Sim(sc.market, sc.init, { crashOpinion: { '2027-01': '延後' } });
    sim.runUntil('2027-01-04');
    const jan = sim.preOpen()!;
    const it = f5(jan);
    expect(it.reasonRequired).toBe(true);
    expect(missingReasons(jan, { mode: 'DO', choices: { [it.key]: 'SKIP' } }).map((x) => x.f)).toEqual(['F5']);
    expect(missingReasons(jan, { mode: 'DO', choices: { [it.key]: 'SKIP' }, reasons: { [it.key]: '   ' } }).map((x) => x.f)).toEqual(['F5']);
    // 整則這次不做：F5 與 MSFT 的慢規則減半都要寫
    expect(missingReasons(jan, { mode: 'SKIP' }).map((x) => x.f).sort()).toEqual(['F5', 'F7']);
    expect(missingReasons(jan, { mode: 'DO', choices: { [it.key]: 'SKIP' }, reasons: { [it.key]: REASON } })).toEqual([]);
    expect(missingReasons(jan, { mode: 'DO' })).toEqual([]);
    // 網站：要寫理由、提示文字是崩盤規則的、AI 說延後時先填
    const v = notifView(ready(sim.acct, sim.pre), jan).items.find((x) => x.key === it.key)!;
    expect(v.reasonRequired).toBe(true);
    expect(v.reasonText).toMatchObject({ placeholder: '為什麼這次不照崩盤規則做（1～200 字）', prefill: '照 AI 檢視：延後' });
    expect(v.explain.choiceNotes?.SKIP).toContain('等於延後一個月');
    // 沒有 AI 意見時不先填
    const plain = new Sim(sc.market, sc.init);
    plain.runUntil('2027-01-04');
    const j2 = plain.preOpen()!;
    expect(notifView(ready(plain.acct, plain.pre), j2).items.find((x) => x.key === f5(j2).key)!.reasonText?.prefill).toBe('');
  });
});

describe('T33c：啟動之後一直在均線之下', () => {
  it('F5 這次不做 → coreOwe 與動能的欠單（核心代號不進 mom.owe）、帳戶頁寫「核心還沒換」；下個月仍啟動 → 重列核心的單與動能的補做；重列時再選不做 → 再下個月再列；照做之後不再列', () => {
    const sim = stayDown();
    sim.runUntil('2027-01-04');
    const jan = sim.preOpen()!;
    expect(sim.acct.rule.crash).toBe(true);
    const it = f5(jan);
    const momTickers = it.choices[0].lines.filter((l) => l.bucket === 'mom' && l.shares).map((l) => l.ticker);
    expect(momTickers.length).toBeGreaterThan(0);
    skipF5(sim, jan);
    expect(sim.acct.coreOwe).toEqual({ direction: 'ON', since: jan.date, notif: jan.id, reason: REASON });
    expect(Object.keys(sim.acct.mom.owe).sort()).toEqual([...momTickers].sort());
    expect(sim.acct.mom.owe.VOO).toBeUndefined();
    expect(sim.acct.mom.owe.SGOV).toBeUndefined();
    expect(sim.acct.notifs.find((n) => n.id === jan.id)!.items.find((i) => i.key === it.key)!.reason).toBe(REASON);
    // 狀態要是真的：帳戶頁「崩盤規則」那一格
    expect(crashStatus(sim.acct, sim.pre).value).toBe('啟動中（核心還沒換：你 2027-01 選了這次不做）');
    finishDay(sim);

    // ---- 2 月：仍在啟動中 → 重列 F5（核心的一半換短債），動能那幾檔以「策略單補做」列
    sim.runUntil('2027-02-01');
    const feb = sim.preOpen()!;
    expect(sim.acct.rule.crash).toBe(true);
    expect(sim.acct.coreOwe).toBeUndefined();
    const re = crashItem(feb, { relist: true })!;
    expect(re).toMatchObject({ f: 'F5', relist: true, reasonRequired: true, choice: 'DO', ruleChoice: 'DO', why: `上次的理由：${REASON}` });
    expect(re.title).toBe('崩盤規則啟動中：上次（2027-01）沒做，核心的一半換短債再列一次');
    expect(re.aiLine).toBeUndefined();
    expect(re.choices[0].lines.filter((l) => l.bucket !== 'core')).toEqual([]);
    const vooSell = core(re).find((l) => l.ticker === 'VOO')!.shares;
    const bondBuy = core(re).find((l) => l.ticker === 'SGOV')!.shares;
    expect(vooSell).toBeLessThan(0);
    expect(bondBuy).toBeGreaterThan(0);
    // 用現在的市值重算：大約是核心的一半
    const pv = sim.pre.close.VOO[sim.pre.i];
    expect(Math.abs((-vooSell * pv) / (sim.acct.lots.core.VOO * pv) - 0.5)).toBeLessThan(0.05);
    expect(crashItem(feb)).toBeUndefined(); // 沒有切換，沒有一般的 F5
    for (const t of momTickers) {
      const owed = feb.items.find((i) => i.ticker === t && i.kind === 'STRATEGY' && i.choices[0].lines.some((l) => l.bucket === 'mom' && l.shares < 0));
      expect(owed?.f).toBe('F17');
    }
    expect(feb.text!.startsWith('崩盤規則：啟動中（上次沒做，這份再列）；')).toBe(true);
    // 重列的不開檢視（crashNeeds 的 MAKEUP 排除 relist）
    expect(crashNeeds(sim.acct, sim.pre, sim.pre.date, {})).toEqual([]);
    // 網站：標籤與理由
    const rv = notifView(ready(sim.acct, sim.pre), feb).items.find((x) => x.key === re.key)!;
    expect(rv.label).toBe('上次沒做，再列一次');
    expect(rv.reasonRequired).toBe(true);
    expect(rv.explain.why).toContain('2027-01 月報');
    expect(rv.explain.why).toContain(`上次的理由：${REASON}`);
    expect(crashStatus(sim.acct, sim.pre).value).toBe('啟動中');

    // 重列時再選不做（另一個理由）→ 3 月再列
    skipF5(sim, feb, '再等一個月', re);
    expect(sim.acct.coreOwe).toEqual({ direction: 'ON', since: feb.date, notif: feb.id, reason: '再等一個月' });
    expect(crashStatus(sim.acct, sim.pre).value).toBe('啟動中（核心還沒換：你 2027-02 選了這次不做）');
    finishDay(sim);
    sim.runUntil('2027-03-01');
    const mar = sim.preOpen()!;
    expect(sim.acct.rule.crash).toBe(true);
    const re3 = crashItem(mar, { relist: true })!;
    expect(re3.title).toBe('崩盤規則啟動中：上次（2027-02）沒做，核心的一半換短債再列一次');
    expect(re3.why).toBe('上次的理由：再等一個月');
    expect(mar.text!.startsWith('崩盤規則：啟動中（上次沒做，這份再列）')).toBe(true);

    // 這次照做 → 換成短債；4 月不再列
    sim.respond(mar.id);
    expect(sim.acct.coreOwe).toBeUndefined();
    finishDay(sim);
    expect(sim.acct.lots.core.SGOV).toBeGreaterThan(0);
    sim.runUntil('2027-04-01');
    const apr = sim.preOpen()!;
    expect(sim.acct.rule.crash).toBe(true);
    expect(crashItem(apr, { relist: true })).toBeUndefined();
    expect(apr.text!.startsWith('崩盤規則：啟動中；')).toBe(true);
  });

  it('月報日入金合併重算：重列的那一項還在（coreOwe 存在月報前的狀態裡還原）；舊的狀態沒有 coreOwe → 當成沒有欠的', () => {
    const sim = stayDown();
    sim.runUntil('2027-01-04');
    const jan = sim.preOpen()!;
    skipF5(sim, jan);
    finishDay(sim);
    sim.runUntil('2027-02-01');
    const feb = sim.preOpen()!;
    expect(feb.monthly!.before.coreOwe).toMatchObject({ direction: 'ON', notif: jan.id });
    const d = deposit(sim.acct, sim.pre, 5000);
    expect(d.mergedIntoMonthly).toBe(true);
    expect(crashItem(d.notif, { relist: true })?.title).toBe('崩盤規則啟動中：上次（2027-01）沒做，核心的一半換短債再列一次');
    expect(d.acct.coreOwe).toBeUndefined();
    // 舊的 SavedState（沒有 coreOwe）
    const a = clone(sim.acct);
    a.coreOwe = { direction: 'ON', since: '2027-01-29', notif: 1, reason: 'x' };
    const old = { rule: a.rule, own: a.own, owe: a.mom.owe, cash: a.cash } as SavedState;
    restoreSaved(a, old);
    expect(a.coreOwe).toBeUndefined();
  });
});

describe('T33c：s3（1 月啟動、2 月解除、3 月仍是未啟動）', () => {
  it('1 月整則這次不做 → 2 月解除時不重列、F6 沒有核心的行、備註寫上次沒做', () => {
    const sc = scenarios.s3();
    const sim = new Sim(sc.market, sc.init);
    sim.runUntil('2027-01-04');
    const jan = sim.preOpen()!;
    const reasons = Object.fromEntries(jan.items.filter((i) => i.reasonRequired).map((i) => [i.key, REASON]));
    sim.respond(jan.id, { mode: 'SKIP', reasons });
    expect(sim.acct.notifs.find((n) => n.id === jan.id)!.status).toBe('SKIPPED');
    expect(sim.acct.coreOwe).toMatchObject({ direction: 'ON', notif: jan.id, reason: REASON });
    finishDay(sim);
    sim.runUntil('2027-02-01');
    const feb = sim.preOpen()!;
    expect(sim.acct.rule.crash).toBe(false);
    expect(sim.acct.coreOwe).toBeUndefined();
    expect(crashItem(feb, { relist: true })).toBeUndefined();
    const f6 = crashItem(feb)!;
    expect(f6.f).toBe('F6');
    expect(core(f6)).toEqual([]);
    expect(f6.note).toBe(RELIST_OFF_NOTE);
    expect(feb.text!.startsWith('崩盤規則：未啟動；')).toBe(true);
  });

  it('2 月 F6 選這次不做 → 帳戶頁寫「短債還沒換回」；3 月仍是未啟動 → 重列短債換回核心 ETF', () => {
    const sc = scenarios.s3();
    const sim = new Sim(sc.market, sc.init);
    sim.runUntil('2027-01-04');
    const jan = sim.preOpen()!;
    sim.respond(jan.id);
    finishDay(sim);
    const bond = sim.acct.lots.core.SGOV;
    expect(bond).toBeGreaterThan(0);
    sim.runUntil('2027-02-01');
    const feb = sim.preOpen()!;
    const f6 = crashItem(feb)!;
    expect(f6.f).toBe('F6');
    expect(f6.reasonRequired).toBe(true);
    sim.respond(feb.id, { mode: 'DO', choices: { [f6.key]: 'SKIP' }, reasons: { [f6.key]: '還想再觀察' } });
    expect(sim.acct.coreOwe).toEqual({ direction: 'OFF', since: feb.date, notif: feb.id, reason: '還想再觀察' });
    expect(crashStatus(sim.acct, sim.pre).value).toBe('未啟動（短債還沒換回：你 2027-02 選了這次不做）');
    // 帳戶頁史萊姆那句：不說「啟動中」，說短債還沒換回
    const say = accountBubble(accountView(ready(sim.acct, sim.pre))).say.map((x) => (typeof x === 'string' ? x : x.t)).join('');
    expect(say).not.toContain('啟動中');
    expect(say).toContain('短債還沒換回（崩盤規則上次選了這次不做，下一份月報會再列）');
    finishDay(sim);
    expect(sim.acct.lots.core.SGOV).toBe(bond);
    sim.runUntil('2027-03-01');
    expect(sim.date).toBe('2027-03-01');
    const mar = sim.preOpen()!;
    expect(sim.acct.rule.crash).toBe(false);
    const re = crashItem(mar, { relist: true })!;
    expect(re).toMatchObject({ f: 'F6', relist: true, why: '上次的理由：還想再觀察' });
    expect(re.title).toBe('崩盤規則已解除：上次（2027-02）沒做，短債換回核心 ETF 再列一次');
    expect(core(re).find((l) => l.ticker === 'SGOV')!.shares).toBe(-bond);
    expect(core(re).find((l) => l.ticker === 'VOO')!.shares).toBeGreaterThan(0);
    expect(mar.text!.startsWith('崩盤規則：未啟動（上次沒做，這份再列）；')).toBe(true);
    const x = explainItem({ acct: sim.acct, view: sim.pre, axis: [], rankOrder: [], aiNotes: [] }, mar, re);
    expect(x.short).toBe('上次沒做，短債換回 VOO 再列一次');
  });

  it('改決定後 coreOwe 清掉（和動能的欠單一起）', () => {
    const sc = scenarios.s3();
    const sim = new Sim(sc.market, sc.init);
    sim.runUntil('2027-01-04');
    const jan = sim.preOpen()!;
    skipF5(sim, jan);
    expect(sim.acct.notifs.find((n) => n.id === jan.id)!.status).toBe('RESPONDED'); // MSFT 的減半照做
    expect(sim.acct.coreOwe).toMatchObject({ notif: jan.id });
    expect(Object.keys(sim.acct.mom.owe).length).toBeGreaterThan(0);
    const r = reopen(sim.acct, sim.pre, jan.id);
    expect(r.ok).toBe(true);
    expect(r.acct.coreOwe).toBeUndefined();
    expect(r.acct.mom.owe).toEqual({});
    expect(crashStatus(r.acct, sim.pre).value).toBe('啟動中');
    // 別則通知寫的 coreOwe 不動
    const a = clone(sim.acct);
    a.coreOwe = { ...a.coreOwe!, notif: 999 };
    expect(reopen(a, sim.pre, jan.id).acct.coreOwe).toMatchObject({ notif: 999 });
  });

  it('填快照時發現 F5 核心的單沒做 → coreOwe（理由「快照顯示沒有做」），帳戶頁照實寫', () => {
    const sc = scenarios.s3();
    const sim = new Sim(sc.market, sc.init);
    sim.runUntil('2027-01-04');
    const jan = sim.preOpen()!;
    sim.respond(jan.id);
    const voo = sim.acct.lots.core.VOO;
    // 動能與 MSFT 照清單做了，核心那兩檔沒動
    sim.open({ VOO: 0, SGOV: 0 });
    expect(sim.acct.lots.core.VOO).toBe(voo);
    expect(sim.acct.coreOwe).toEqual({ direction: 'ON', since: jan.date, notif: jan.id, reason: CORE_OWE_SNAPSHOT_REASON });
    expect(sim.acct.mom.owe.VOO).toBeUndefined();
    expect(crashStatus(sim.acct, sim.pre).value).toBe('啟動中（核心還沒換：2027-01 月報的單快照顯示沒有做）');
  });
});
