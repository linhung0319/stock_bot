// T3：快照式帳本（設計 §2.1.1）——兩份快照相減拆成事件、分到各桶；每桶單位淨值；現金差額。
import { describe, expect, it } from 'vitest';
import {
  applySnapshot,
  bookShares,
  explainCash,
  itemAction,
  navPerUnit,
  priceOf,
  removeOwn,
  respond,
  totalValue,
  type Account,
  type MarketView,
} from '../src/engine';
import { scenarios } from './helpers/scenarios';
import { Sim, listOf } from './helpers/sim';

function calm(): Sim {
  const sc = scenarios.s5();
  const sim = new Sim(sc.market, sc.init);
  sim.runUntil('2026-12-10');
  return sim;
}
const snapOf = (acct: Account, delta: Record<string, number>, cash: number) => {
  const shares = bookShares(acct);
  for (const [t, q] of Object.entries(delta)) shares[t] = (shares[t] ?? 0) + q;
  return { shares, cash };
};

describe('快照 → 事件', () => {
  it('同一代號兩桶都有單：按清單上各桶的股數比例分；少做的部分照比例', () => {
    const sim = calm();
    const view: MarketView = sim.pre;
    // 手工放一則清單：MU 自選賣 20 股、動能買 30 股 → 淨買 10 股
    const acct = structuredClone(sim.acct);
    acct.notifs.push({
      id: acct.nextId++,
      kind: 'MONTHLY',
      date: view.date,
      seq: view.i,
      title: 't',
      status: 'PENDING',
      coreAbsorb: false,
      reminded: false,
      items: [
        { key: 'a', f: 'F7', kind: 'OWN_RULE', ticker: 'MU', title: '', choices: [{ id: 'RULE', label: '', lines: [{ ticker: 'MU', bucket: 'own', shares: -20, reason: '自選訊號' }] }], choice: 'RULE', ruleChoice: 'RULE' },
        { key: 'b', f: 'F1', kind: 'STRATEGY', ticker: 'MU', title: '', choices: [{ id: 'DO', label: '', lines: [{ ticker: 'MU', bucket: 'mom', shares: 30, reason: '動能換股' }] }], choice: 'DO', ruleChoice: 'DO' },
      ],
    });
    const id = acct.nextId - 1;
    const a1 = respond(acct, view, id, { mode: 'DO' });
    expect(a1.notifs.at(-1)!.composed!.merged).toEqual([expect.objectContaining({ ticker: 'MU', shares: 10 })]);
    const px = priceOf(view, 'MU');
    const full = applySnapshot(a1, view, snapOf(a1, { MU: 10 }, a1.cash - 10 * px));
    expect(full.acct.lots.own.MU).toBe(56 - 20);
    expect(full.acct.lots.mom.MU).toBe(30);
    expect(full.followUps).toEqual([]);
    // 只買了 5 股（差超過 1 股）→ 照比例分：自選 −10、動能 +15，並問補做或就這樣
    const part = applySnapshot(a1, view, snapOf(a1, { MU: 5 }, a1.cash - 5 * px));
    expect(part.acct.lots.own.MU).toBe(56 - 10);
    expect(part.acct.lots.mom.MU).toBe(15);
    expect(part.followUps).toEqual([id]);
    // 帳本總股數永遠等於快照
    expect(bookShares(part.acct).MU).toBe(56 + 5);
  });

  it('沒有按回覆就直接照清單做了：快照對得上清單 → 自動當成已回覆', () => {
    const sim = calm();
    const r = removeOwn(sim.acct, sim.pre, 'META');
    const px = priceOf(sim.pre, 'META');
    const s = applySnapshot(r.acct, sim.pre, snapOf(r.acct, { META: -5 }, r.acct.cash + 5 * px));
    expect(s.completed).toEqual([r.notif.id]);
    expect(s.acct.lots.own.META).toBeUndefined();
    expect(s.acct.own.META).toBeUndefined(); // 移除後不再有規則或 AI 追蹤
    expect(s.acct.shadow.some((x) => x.choice === 'REMOVE' && x.ticker === 'META')).toBe(true);
  });

  it('還沒回覆的清單只有核心那一行對得上 → 不會被誤認成已經照做', () => {
    const sim = calm();
    const r = removeOwn(sim.acct, sim.pre, 'META');
    // 使用者只是自己多買了 1 股 VOO（清單上的核心行也是買 VOO）
    const s = applySnapshot(r.acct, sim.pre, snapOf(r.acct, { VOO: 1 }, r.acct.cash - priceOf(sim.pre, 'VOO')));
    expect(s.completed).toEqual([]);
    expect(s.acct.notifs.find((n) => n.id === r.notif.id)!.status).toBe('PENDING');
    expect(s.acct.lots.core.VOO).toBe(65);
  });

  it('核心 ETF 的清單外變動直接歸核心；其他代號要問', () => {
    const sim = calm();
    const s = applySnapshot(sim.acct, sim.pre, snapOf(sim.acct, { VOO: 2, KO: 10 }, sim.acct.cash - 2 * priceOf(sim.pre, 'VOO') - 10 * priceOf(sim.pre, 'KO')));
    expect(s.acct.lots.core.VOO).toBe(66);
    expect(s.acct.lots.unc).toEqual({ KO: 10 });
    expect(s.created.map((n) => n.kind)).toEqual(['CLASSIFY']);
  });

  it('現金：價差在容許範圍內不問；差太多 → 問是入金、出金、股利還是其他', () => {
    const sim = calm();
    const quiet = applySnapshot(sim.acct, sim.pre, snapOf(sim.acct, {}, sim.acct.cash + 3));
    expect(quiet.created).toEqual([]);
    expect(quiet.acct.cash).toBe(sim.acct.cash + 3);
    const s = applySnapshot(sim.acct, sim.pre, snapOf(sim.acct, {}, sim.acct.cash + 5000));
    expect(s.created.map((n) => n.kind)).toEqual(['CASH_DIFF']);
    expect(s.created[0].amount).toBeCloseTo(5000, 6);
    const nav0 = navPerUnit(sim.acct, sim.pre).total;
    // 回答「入金」：買單位，單位淨值不變
    const dep = explainCash(s.acct, sim.pre, s.created[0].id, '入金');
    expect(navPerUnit(dep, sim.pre).total).toBeCloseTo(nav0, 9);
    expect(dep.events.at(-1)).toMatchObject({ kind: 'DEPOSIT', amount: 5000 });
    // 回答「股利」：算報酬，單位淨值上升
    const div = explainCash(s.acct, sim.pre, s.created[0].id, '股利');
    expect(navPerUnit(div, sim.pre).total).toBeGreaterThan(nav0);
    expect(div.events.at(-1)).toMatchObject({ kind: 'DIVIDEND' });
  });
});

describe('單位淨值（每一桶像一檔基金）', () => {
  it('自選賣掉的錢交給核心：兩桶的單位數跟著搬，各桶的單位淨值不因搬錢而跳動', () => {
    const sim = calm();
    const before = navPerUnit(sim.acct, sim.pre);
    const r = removeOwn(sim.acct, sim.pre, 'NVDA');
    sim.acct = respond(r.acct, sim.pre, r.notif.id, { mode: 'DO' });
    const comp = sim.acct.notifs.at(-1)!.composed!;
    expect(listOf(sim.acct.notifs.at(-1)!).find((x) => x.includes('VOO'))).toMatch(/^買 VOO/);
    let cash = sim.acct.cash;
    const delta: Record<string, number> = {};
    for (const m of comp.merged) {
      delta[m.ticker] = m.shares;
      cash -= m.shares * priceOf(sim.pre, m.ticker);
    }
    const s = applySnapshot(sim.acct, sim.pre, snapOf(sim.acct, delta, cash));
    const after = navPerUnit(s.acct, sim.pre);
    expect(after.own).toBeCloseTo(before.own, 9);
    expect(after.core).toBeCloseTo(before.core, 9);
    expect(after.total).toBeCloseTo(before.total, 9);
    expect(s.acct.units.own).toBeLessThan(sim.acct.units.own);
    expect(s.acct.units.core).toBeGreaterThan(sim.acct.units.core);
    expect(totalValue(s.acct, sim.pre)).toBeCloseTo(totalValue(sim.acct, sim.pre), 6);
  });
});

describe('認養（設計 §2.3）', () => {
  it('動能選出的 GE 你也看好 → 照常買進但記在自選；動能名單少一檔，下個月才遞補', () => {
    const sc = scenarios.s1();
    const sim = new Sim(sc.market, sc.init, { vetoes: { '2026-12': ['APP'] } });
    sim.runUntil('2026-12-01');
    const n = sim.preOpen()!;
    const ge = n.items.find((i) => i.f === 'F1' && i.ticker === 'GE')!;
    const listed = ge.choices[0].lines[0].shares;
    const r = itemAction(sim.acct, sim.pre, n.id, ge.key, { action: 'ADOPT', reason: '看好航太引擎的售後服務' });
    sim.acct = r.acct;
    expect(sim.acct.rule.heldMom).not.toContain('GE');
    expect(sim.acct.own.GE.origin).toBe('ADOPT');
    sim.respond(n.id);
    sim.open();
    expect(sim.acct.lots.own.GE).toBe(listed);
    expect(sim.acct.lots.mom.GE).toBeUndefined();
    sim.close();
    sim.d++;
    sim.runUntil('2027-01-04');
    const jan = sim.preOpen()!;
    // 動能補上排名最前、沒持有、也不是已認養的那一檔；之後動能不會叫你賣 GE
    const entry = jan.items.find((i) => i.f === 'F1')!;
    expect(entry.ticker).not.toBe('GE');
    expect(jan.items.some((i) => i.ticker === 'GE')).toBe(false);
    expect(sim.acct.rule.heldMom).toHaveLength(5);
  });
});
