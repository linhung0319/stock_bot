// T38 第 3 項：跨功能的使用者角度走一遍（動能、核心、入金出金、改比例，以及它們和自選交錯的情境）找到的缺口。
// 紀錄在 docs/test-records/t38_walkthrough_2026-11-16.md；每個缺口一組測試，名稱和紀錄裡寫的相同。
// 市場是可重現的假資料（test/helpers/market.ts）；只用引擎（純函式）與網站會呼叫的同一組函式。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { explainItem, type ExplainContext } from '../src/app/site/explain';
import {
  afterOpenLists,
  applySnapshot,
  cancelCashflow,
  changeRatio,
  composeNotif,
  deposit,
  momSlotTarget,
  priceOf,
  recordAiTier,
  removeOwn,
  respond,
  totalValue,
  withdraw,
  type Account,
  type BucketShares,
  type MarketView,
  type Notif,
  notifDay,
  notifName,
} from '../src/engine';
import type { OrderLine } from '../src/engine/orders';
import { scenarios } from './helpers/scenarios';
import { Sim } from './helpers/sim';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 情境 ①：12/01 的月報（ORCL 出場、GE 進場、PLTR 回調）。respond = true 時按了回覆、還沒填快照。 */
function december(respondIt: boolean, aiRaise = false): { sim: Sim; m: Notif } {
  const sc = scenarios.s1();
  const sim = new Sim(sc.market, sc.init, { vetoes: { '2026-12': ['APP'] } });
  sim.runUntil('2026-12-01');
  if (aiRaise) sim.acct = recordAiTier(sim.acct, 'MSFT', 'RAISE', '2026-11-30', true);
  const m = sim.preOpen()!;
  if (respondIt) sim.respond(m.id);
  return { sim, m: sim.acct.notifs.find((x) => x.id === m.id)! };
}

const notif = (a: Account, id: number) => a.notifs.find((n) => n.id === id)!;
const linesOf = (n: Notif): OrderLine[] => (n.composed ?? n.preview)!.lines;
const key = (l: OrderLine) => `${l.bucket}:${l.ticker}:${l.shares}`;

/** 分桶快照：帳本照幾份清單（合成後的每一行）做完、以 view 的收盤成交，再加上 extra（桶 → 代號 → 多做的股數）。 */
function filled(acct: Account, view: MarketView, lists: Notif[], extra: Partial<BucketShares> = {}) {
  const lots: BucketShares = { own: { ...acct.lots.own }, mom: { ...acct.lots.mom }, core: { ...acct.lots.core } };
  let cash = acct.cash;
  const add = (b: 'own' | 'mom' | 'core', t: string, q: number) => {
    lots[b][t] = (lots[b][t] ?? 0) + q;
    cash -= q * priceOf(view, t);
  };
  for (const n of lists) {
    for (const l of linesOf(n)) if (l.shares) add(l.bucket, l.ticker, l.shares);
    cash -= n.withdraw ?? 0;
  }
  for (const b of ['own', 'mom', 'core'] as const) for (const [t, q] of Object.entries(extra[b] ?? {})) add(b, t, q);
  const shares: Record<string, number> = {};
  for (const b of ['own', 'mom', 'core'] as const) for (const [t, q] of Object.entries(lots[b])) if (q) shares[t] = (shares[t] ?? 0) + q;
  return { shares, lots, cash };
}

/** 同一份清單真的成交、填過快照之後的帳戶（對照組：入金、出金、改比例在這上面算出來的，就是「不會重複」的答案）。 */
function afterFill(acct: Account, view: MarketView, n: Notif): Account {
  const s = applySnapshot(acct, view, filled(acct, view, [n]));
  expect(s.completed).toContain(n.id);
  expect(s.followUps).toEqual([]);
  return s.acct;
}

describe('T38：已回覆、還沒填快照時，入金、出金、改比例又把同一張單列一次（T33d 留下的）', () => {
  it('入金、出金、改比例：股數和「那份清單已經成交、填過快照」之後算的一樣；入金不再補月報要買的 GE，改比例不再賣月報要賣的 ORCL', () => {
    const { sim, m } = december(true);
    const view = sim.pre;
    expect(linesOf(m).map(key)).toEqual(expect.arrayContaining(['mom:GE:20', 'mom:ORCL:-28']));
    const done = afterFill(sim.acct, view, m);
    // 入金
    const dep = deposit(sim.acct, view, 10000);
    expect(linesOf(dep.notif).filter((l) => l.bucket !== 'core').map(key)).toEqual(linesOf(deposit(done, view, 10000).notif).filter((l) => l.bucket !== 'core').map(key));
    const ge = linesOf(dep.notif).find((l) => l.ticker === 'GE')?.shares ?? 0;
    const slot = momSlotTarget(sim.acct.cfg, totalValue(sim.acct, view) + 10000, sim.acct.rule.effPrev ?? 1);
    expect((20 + ge) * priceOf(view, 'GE')).toBeLessThanOrEqual(slot + priceOf(view, 'GE'));
    // 出金
    const wd = withdraw(sim.acct, view, 10000);
    expect(linesOf(wd.notif).filter((l) => l.bucket !== 'core').map(key)).toEqual(linesOf(withdraw(done, view, 10000).notif).filter((l) => l.bucket !== 'core').map(key));
    // 改比例（動能 30% → 10%；自選 20% → 10%）
    for (const ratio of [
      { own: 0.2, strat: 0.1, core: 0.7 },
      { own: 0.1, strat: 0.3, core: 0.6 },
    ]) {
      const ch = changeRatio(sim.acct, view, ratio);
      expect(linesOf(ch.notif).filter((l) => l.bucket !== 'core').map(key)).toEqual(linesOf(changeRatio(done, view, ratio).notif).filter((l) => l.bucket !== 'core').map(key));
      expect(linesOf(ch.notif).some((l) => l.ticker === 'ORCL')).toBe(false);
    }
  });

  it('那一份還沒回覆（忘了回、隔幾天才入金）也一樣：入金不會再補 GE 一次；說明寫出先算進了哪一份', () => {
    const { sim, m } = december(false);
    sim.open();
    sim.close();
    sim.d++;
    const dep = deposit(sim.acct, sim.pre, 10000);
    expect(dep.mergedIntoMonthly).toBe(false);
    const ge = linesOf(dep.notif).find((l) => l.ticker === 'GE')?.shares ?? 0;
    const slot = momSlotTarget(sim.acct.cfg, totalValue(sim.acct, sim.pre) + 10000, sim.acct.rule.effPrev ?? 1);
    expect((20 + ge) * priceOf(sim.pre, 'GE')).toBeLessThanOrEqual(slot + priceOf(sim.pre, 'GE'));
    const ctx: ExplainContext = { acct: dep.acct, view: sim.pre, axis: [], rankOrder: [], aiNotes: [] };
    const facts = explainItem(ctx, dep.notif, dep.notif.items[0]).facts!;
    expect(facts.find((f) => f.label === '先算進')!.value).toBe(`${notifName(m)}（等你決定）`);
    // GE 那一行的「目前」從月報做完之後算（月報買 20 股），不是 0%
    expect(facts.find((f) => f.label === '動能 GE')?.note ?? '目前 有').not.toMatch(/^目前 0\.0%/);
  });

  it('已回覆的移出自選還沒成交：入金不會照那一檔的標準比重把它買回來（選項的效果也先算進去）', () => {
    const { sim } = december(false);
    sim.open();
    const view = sim.pre;
    const rm = removeOwn(sim.acct, view, 'NVDA');
    const a1 = respond(rm.acct, view, rm.notif.id, { mode: 'DO' });
    const n = notif(a1, rm.notif.id);
    expect(n.status).toBe('RESPONDED');
    // 月報還在「等你決定」：對照組也照預設先回覆、一起成交
    const m = a1.notifs.find((x) => x.kind === 'MONTHLY' && x.status === 'PENDING')!;
    const a2 = respond(a1, view, m.id, { mode: 'DO' });
    const s = applySnapshot(a2, view, filled(a2, view, [notif(a2, rm.notif.id), notif(a2, m.id)]));
    expect(s.followUps).toEqual([]);
    expect(s.acct.own.NVDA).toBeUndefined();
    const dep = deposit(a1, view, 10000);
    expect(linesOf(dep.notif).some((l) => l.ticker === 'NVDA')).toBe(false);
    expect(linesOf(dep.notif).filter((l) => l.bucket !== 'core').map(key)).toEqual(linesOf(deposit(s.acct, view, 10000).notif).filter((l) => l.bucket !== 'core').map(key));
  });
});

describe('T38：兩份已回覆的清單都把同一筆閒置現金交給核心', () => {
  it('月報已經把現金交給核心（VOO 與 SGOV）；之後的入金清單只交入金和自己剩下的錢，兩份都做完現金不會是負的', () => {
    const { sim, m } = december(true);
    expect(linesOf(m).some((l) => l.ticker === 'VOO' && l.shares > 0)).toBe(true);
    const dep = deposit(sim.acct, sim.pre, 10000);
    const a = respond(dep.acct, sim.pre, dep.notif.id, { mode: 'DO' });
    const after = afterOpenLists(a, sim.pre);
    expect(after.cash).toBeGreaterThanOrEqual(0);
    // 原本帳上那筆閒置現金只交一次：剩下的比它少（只剩買單保留的緩衝）
    expect(after.cash).toBeLessThan(sim.acct.cash);
  });
});

describe('T38：同時有兩份還沒填快照的清單列了同一桶同一檔', () => {
  it('照快照頁預先填的數字（帳本＋兩份清單）送出：兩份都完成，不跳「和清單不同」；只做了月報 → 只有入金那一份跳', () => {
    const { sim, m } = december(true);
    const view = sim.pre;
    const dep = deposit(sim.acct, view, 10000);
    const a = respond(dep.acct, view, dep.notif.id, { mode: 'DO' });
    const lists = [notif(a, m.id), notif(a, dep.notif.id)];
    // 前提：兩份清單真的有共用的桶＋代號（VOO 都買；PLTR 月報賣、入金買）
    const keys = lists.map((n) => new Set(linesOf(n).map((l) => `${l.bucket}:${l.ticker}`)));
    const shared = [...keys[0]].filter((k) => keys[1].has(k));
    expect(shared).toEqual(expect.arrayContaining(['core:VOO', 'mom:PLTR']));
    const both = applySnapshot(a, view, filled(a, view, lists));
    expect(both.completed.sort()).toEqual([m.id, dep.notif.id].sort());
    expect(both.followUps).toEqual([]);
    expect(both.cashOther).toBe(0);
    // 每一份清單的成交照它自己列的股數記。
    // T80（allocation_redesign §1.2）：月報裡 SGOV 可以有兩行（照比例進核心的、帳上原本的現金順便買的），同一桶同一檔的行先加起來再比
    for (const n of lists) {
      for (const l of linesOf(n)) {
        const listed = linesOf(n).filter((x) => x.ticker === l.ticker && x.bucket === l.bucket).reduce((s, x) => s + x.shares, 0);
        const got = both.acct.events.filter((e) => e.kind === 'TRADE' && e.notif === n.id && e.ticker === l.ticker && e.bucket === l.bucket).reduce((s, e) => s + (e.shares ?? 0), 0);
        expect(got, `#${n.id} ${l.ticker}`).toBe(listed);
      }
    }
    // 只做了月報：月報完成、沒有差額；入金那一份列出沒做的那幾檔
    const one = applySnapshot(a, view, filled(a, view, [lists[0]]));
    expect(one.followUps).toEqual([dep.notif.id]);
    expect(notif(one.acct, m.id).followUp).toBeUndefined();
    expect(notif(one.acct, dep.notif.id).followUp!.map((x) => x.ticker).sort()).toEqual(lists[1].composed!.merged.filter((x) => Math.abs(x.shares) > 1 && !(x.ticker === a.bondTicker && x.shares > 0)).map((x) => x.ticker).sort());
  });

  it('入金清單已回覆、月報還沒回覆，兩份都照做了：月報當成照預設回覆，兩份都完成、都沒有差額', () => {
    const { sim, m } = december(false);
    sim.open();
    sim.close();
    sim.d++;
    const view = sim.pre;
    const dep = deposit(sim.acct, view, 10000);
    const a = respond(dep.acct, view, dep.notif.id, { mode: 'DO' });
    // 月報在網站上看到的清單（還沒回覆的每次重算，已回覆的入金先算進去）
    const shown = { ...notif(a, m.id), preview: composeNotif(a, view, notif(a, m.id)) };
    const s = applySnapshot(a, view, filled(a, view, [notif(a, dep.notif.id), shown]));
    expect(s.completed.sort()).toEqual([m.id, dep.notif.id].sort());
    expect(s.followUps).toEqual([]);
    expect(notif(s.acct, m.id).status).toBe('DONE');
  });
});

describe('T38：已回覆的清單要買的自選，你在同一份快照把它賣光', () => {
  it('入金清單要補 META，你卻決定把 META 賣光：META 移出自選，入金那一份不再問 META 要不要補做（補做會把它買回來）', () => {
    const { sim, m } = december(true);
    const view = sim.pre;
    const dep = deposit(sim.acct, view, 10000);
    const a = respond(dep.acct, view, dep.notif.id, { mode: 'DO' });
    const d = notif(a, dep.notif.id);
    const buy = linesOf(d).find((l) => l.bucket === 'own' && l.ticker === 'META' && l.shares > 1);
    expect(buy).toBeDefined();
    // 兩份清單照做，但 META 沒買、反而全部賣掉
    const snap = filled(a, view, [notif(a, m.id), d], { own: { META: -buy!.shares - a.lots.own.META } });
    expect(snap.lots.own.META).toBe(0);
    const s = applySnapshot(a, view, snap);
    expect(s.removedOwn).toEqual(['META']);
    expect(s.acct.own.META).toBeUndefined();
    expect(s.completed.sort()).toEqual([m.id, dep.notif.id].sort());
    expect(s.followUps).toEqual([]);
    expect(notif(s.acct, dep.notif.id).followUpOpen).toBeFalsy();
  });
});

describe('T38：上一份月報一直沒回覆，下一份月報又把同樣的單列一次', () => {
  it('12 月的月報沒回覆到 1 月：1 月月報照樣列（策略類下個月再列），12 月那幾項以 1 月為準、取消，整份改成已被取代', () => {
    const { sim, m } = december(false);
    sim.d++;
    sim.runUntil('2027-01-04');
    const jan = sim.preOpen()!;
    expect(jan.kind).toBe('MONTHLY');
    expect(jan.items.some((i) => i.ticker === 'GE' && i.choices[0].lines.some((l) => l.shares > 0))).toBe(true);
    const old = notif(sim.acct, m.id);
    expect(old.status).toBe('SUPERSEDED');
    expect(old.items.every((i) => i.cancelled && i.note === '上一份月報沒有回覆，這一項以 2027-01 月報為準')).toBe(true);
    expect(sim.acct.notifs.filter((n) => n.status === 'PENDING' && n.kind === 'MONTHLY').map((n) => n.id)).toEqual([jan.id]);
  });

  it('舊月報裡自選的項目（AI 提高到 125% 的建議）是一次性的、1 月不會再列：留著等你決定，只有策略項目取消', () => {
    const { sim, m } = december(false, true);
    const ai = m.items.find((i) => i.kind === 'AI_ONLY' && i.ticker === 'MSFT');
    expect(ai).toBeDefined();
    sim.d++;
    sim.runUntil('2027-01-04');
    const jan = sim.preOpen()!;
    expect(jan.items.some((i) => i.kind === 'AI_ONLY' && i.ticker === 'MSFT')).toBe(false);
    const old = notif(sim.acct, m.id);
    expect(old.status).toBe('PENDING');
    expect(old.items.filter((i) => !i.cancelled).map((i) => i.key)).toEqual([ai!.key]);
    expect(old.items.filter((i) => i.kind === 'STRATEGY').every((i) => i.cancelled)).toBe(true);
  });
});

describe('T38：月報日入金，而月報之後另一份清單已經回覆、還沒填快照', () => {
  it('入金不會不見：不併進月報（併進去的月報會暫停、入金金額沒有記），另給一份入金清單；月報照舊等你決定', () => {
    const { sim, m } = december(false);
    const view = sim.pre;
    // 月報出來之後，你先回覆了另一份（移出 NVDA）、還沒下單
    const rm = removeOwn(sim.acct, view, 'NVDA');
    const a1 = respond(rm.acct, view, rm.notif.id, { mode: 'DO' });
    expect(notif(a1, m.id)).toMatchObject({ status: 'PENDING', date: view.date });
    const dep = deposit(a1, view, 10000);
    expect(dep.mergedIntoMonthly).toBe(false);
    expect(dep.notif.kind).toBe('CASHFLOW');
    expect(dep.acct.cash).toBeCloseTo(a1.cash + 10000, 6);
    expect(dep.acct.events.at(-1)).toMatchObject({ kind: 'DEPOSIT', amount: 10000 });
    expect(notif(dep.acct, m.id).status).toBe('PENDING');
    expect(dep.acct.monthlyBlocked).toBeFalsy();
    // 沒有別的清單在等成交時照舊併進月報（設計 §2.1.1）
    expect(deposit(sim.acct, view, 10000).mergedIntoMonthly).toBe(true);
  });
});

describe('T38：先取消前面那一筆入金、出金、改比例，後面那一份還照它做完之後算', () => {
  it('改了兩次比例（20/30/50 → 20/10/70 → 20/0/80）再取消第一次：擋下，請先取消第二次；照順序取消之後比例回到原本的', () => {
    const { sim } = december(false);
    sim.open();
    const view = sim.pre;
    const r0 = sim.acct.cfg.ratio;
    const c1 = changeRatio(sim.acct, view, { own: 0.2, strat: 0.1, core: 0.7 });
    const a1 = respond(c1.acct, view, c1.notif.id, { mode: 'DO' });
    const c2 = changeRatio(a1, view, { own: 0.2, strat: 0, core: 0.8 });
    const a2 = respond(c2.acct, view, c2.notif.id, { mode: 'DO' });
    const bad = cancelCashflow(a2, view, c1.notif.id);
    expect(bad.ok).toBe(false);
    expect(bad.error).toBe(`之後的「改比例的清單」（${notifDay(c2.notif.date)}）是照這一筆做完之後算的，還沒填快照：先取消那一份，再取消這一筆`);
    expect(bad.acct.cfg.ratio).toEqual({ own: 0.2, strat: 0, core: 0.8 });
    const x2 = cancelCashflow(a2, view, c2.notif.id);
    expect(x2.ok).toBe(true);
    const x1 = cancelCashflow(x2.acct, view, c1.notif.id);
    expect(x1.ok).toBe(true);
    expect(x1.acct.cfg.ratio).toEqual(r0);
  });
});

describe('T38：入金頁說「或正要匯」就可以登記', () => {
  it('入金頁改成錢到券商、看得到之後再登記，並寫明錢還沒到就填快照會被記成虧損', () => {
    const js = readFileSync(join(HERE, '..', 'public', 'js', 'pages-more.js'), 'utf8');
    expect(js).not.toContain('或正要匯');
    expect(js).toContain('錢已經到券商、券商畫面看得到之後再登記');
    expect(js).toContain('錢到券商之前先別填快照');
  });
});
