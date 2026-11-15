// T14 使用者角度走一遍時發現、修掉的問題（設計 §10 第 37 點）。
import { describe, expect, it } from 'vitest';
import { addPremises, annualizedVol, applySnapshot, bookShares, cancelCashflow, changeRatio, classify, deposit, liveShadow, monthlyWait, navPerUnit, priceOf, recentVol, recommendStdWeights, removeOwn, respond, resumeMonthly, setStdWeight, withdraw, type Account, type BucketShares, type MarketView } from '../src/engine';
import { scenarios } from './helpers/scenarios';
import { Sim } from './helpers/sim';

// ---------------------------------------------------------------- 標準比重：上市不久的股票

/** 確定的假價格：每天漲跌照一個固定的鋸齒，幅度 amp。 */
function path(n: number, amp: number, start = 100): number[] {
  const out = [start];
  for (let k = 1; k < n; k++) out.push(out[k - 1] * (1 + amp * (k % 3 === 0 ? -1.5 : k % 2 === 0 ? 1 : 0.6)));
  return out;
}
const padded = (len: number, real: number[]) => [...Array(len - real.length).fill(NaN), ...real];

describe('推薦標準比重（T14：SPCX 只有 108 天價格，整組變成 NaN）', () => {
  const N = 300;
  const i = N - 1;
  const A = path(N, 0.01);
  const B = path(N, 0.02);
  const S = padded(N, path(108, 0.03)); // 108 天前才上市
  const T = padded(N, path(10, 0.03)); // 10 天前才上市

  it('歷史夠長的照舊：126 天波動度反比，結果和原本的算法相同', () => {
    const view = { date: 'x', i, close: { A, B } } as MarketView;
    const w = recommendStdWeights(view, ['A', 'B'], 0.2);
    const ia = 1 / annualizedVol(A, i, 126);
    const ib = 1 / annualizedVol(B, i, 126);
    expect(w.A).toBeCloseTo((0.2 * ia) / (ia + ib), 12);
    expect(w.B).toBeCloseTo((0.2 * ib) / (ia + ib), 12);
  });

  it('上市 108 天：用現有的 107 個報酬算，每一檔都有數字，合計等於自選預算', () => {
    const view = { date: 'x', i, close: { A, B, S } } as MarketView;
    expect(Number.isNaN(annualizedVol(S, i, 126))).toBe(true); // 原本的算法：NaN
    expect(recentVol(S, i)).toBeCloseTo(annualizedVol(S, i, 107), 12);
    const w = recommendStdWeights(view, ['A', 'B', 'S'], 0.2);
    for (const t of ['A', 'B', 'S']) expect(Number.isFinite(w[t])).toBe(true);
    expect(w.A + w.B + w.S).toBeCloseTo(0.2, 12);
    expect(w.S).toBeLessThan(w.A); // 波動大的比重小
  });

  it('不到 20 天：用其他檔的平均波動度', () => {
    const view = { date: 'x', i, close: { A, B, T } } as MarketView;
    expect(Number.isNaN(recentVol(T, i))).toBe(true);
    const w = recommendStdWeights(view, ['A', 'B', 'T'], 0.2);
    const va = annualizedVol(A, i, 126);
    const vb = annualizedVol(B, i, 126);
    const inv = [1 / va, 1 / vb, 2 / (va + vb)];
    expect(w.T).toBeCloseTo((0.2 * inv[2]) / (inv[0] + inv[1] + inv[2]), 12);
    expect(w.A + w.B + w.T).toBeCloseTo(0.2, 12);
  });

  it('全部都算不出來：平分；沒有價格的代號也不會變成 NaN', () => {
    const view = { date: 'x', i, close: { T } } as MarketView;
    expect(recommendStdWeights(view, ['T', 'ZZZ'], 0.2)).toEqual({ T: 0.1, ZZZ: 0.1 });
  });
});

// ---------------------------------------------------------------- 緊急賣：理由、賣光時移出自選

function calm(): Sim {
  const sc = scenarios.s5();
  const sim = new Sim(sc.market, sc.init);
  sim.runUntil('2026-12-10');
  return sim;
}
const snapOf = (acct: Account, delta: Record<string, number>, cash: number, note?: string) => {
  const shares = bookShares(acct);
  for (const [t, q] of Object.entries(delta)) shares[t] = (shares[t] ?? 0) + q;
  return { shares, cash, ...(note ? { note } : {}) };
};

describe('緊急賣（T14：清單外的賣出）', () => {
  it('核心賣出：直接歸核心，快照上寫的原因記在成交事件上', () => {
    const sim = calm();
    const a = sim.acct;
    const px = priceOf(sim.pre, 'VOO');
    const s = applySnapshot(a, sim.pre, snapOf(a, { VOO: -3 }, a.cash + 3 * px, '要用錢，先賣一點'));
    expect(s.created).toEqual([]);
    expect(s.acct.lots.core.VOO).toBe(a.lots.core.VOO - 3);
    expect(s.acct.events.at(-1)).toMatchObject({ kind: 'TRADE', ticker: 'VOO', bucket: 'core', shares: -3, reason: '核心的手動交易：要用錢，先賣一點' });
    // 沒寫原因：照舊
    const s2 = applySnapshot(a, sim.pre, snapOf(a, { VOO: -3 }, a.cash + 3 * px));
    expect(s2.acct.events.at(-1)!.reason).toBe('核心的手動交易');
  });

  it('自選賣出：原因記在「還沒分類」的事件，並帶進分類通知；分類時的理由記在事件與影子上', () => {
    const sim = calm();
    const a = sim.acct;
    const half = Math.floor(a.lots.own.MU / 2);
    const px = priceOf(sim.pre, 'MU');
    const s = applySnapshot(a, sim.pre, snapOf(a, { MU: -half }, a.cash + half * px, '財報不如預期'));
    const n = s.created[0];
    expect(n).toMatchObject({ kind: 'CLASSIFY', ticker: 'MU', quantity: -half, userNote: '財報不如預期' });
    expect(s.acct.events.at(-1)).toMatchObject({ kind: 'UNCLASSIFIED', ticker: 'MU', reason: '財報不如預期' });
    const c = classify(s.acct, sim.pre, n.id, { bucket: 'own', reason: '財報不如預期，先賣一半' });
    expect(c.error).toBeUndefined();
    expect(c.acct.lots.own.MU).toBe(a.lots.own.MU - half);
    expect(c.acct.own.MU).toBeDefined(); // 沒賣光：還在自選
    expect(c.acct.events.at(-1)).toMatchObject({ kind: 'CLASSIFIED', bucket: 'own', shares: -half, reason: '財報不如預期，先賣一半' });
    expect(c.acct.shadow.at(-1)).toMatchObject({ f: 'F17', ticker: 'MU', rule: 0, actual: -half, note: '財報不如預期，先賣一半' });
    // 只賣一半不能「同時移出自選」
    expect(classify(s.acct, sim.pre, n.id, { bucket: 'own', removeOwn: true }).error).toContain('全部賣掉時');
  });

  it('自選全部賣掉：可以同時移出自選，之後不再有規則或 AI 追蹤；不勾就照舊留在自選', () => {
    const sim = calm();
    const a = sim.acct;
    const all = a.lots.own.MU;
    expect(a.lots.mom.MU ?? 0).toBe(0);
    const s = applySnapshot(a, sim.pre, snapOf(a, { MU: -all }, a.cash + all * priceOf(sim.pre, 'MU')));
    const id = s.created[0].id;
    const out = classify(s.acct, sim.pre, id, { bucket: 'own', reason: '不再看好', removeOwn: true });
    expect(out.error).toBeUndefined();
    expect(out.acct.lots.own.MU ?? 0).toBe(0);
    expect(out.acct.own.MU).toBeUndefined();
    expect(out.acct.rule.own.MU).toBeUndefined();
    expect(out.acct.events.at(-1)!.reason).toBe('不再看好（賣光並移出自選）');
    expect(out.acct.shadow.at(-1)).toMatchObject({ title: '手動交易：賣光並移出自選（如果繼續持有）', actual: -all });
    // 不勾：留在自選、0 股
    const keep = classify(s.acct, sim.pre, id, { bucket: 'own' });
    expect(keep.acct.own.MU).toBeDefined();
    expect(keep.acct.rule.own.MU).toBeDefined();
    // 動能那一桶不能用這個選項
    expect(classify(s.acct, sim.pre, id, { bucket: 'mom', removeOwn: true }).error).toBeDefined();
  });
});

// ---------------------------------------------------------------- 分桶快照（2026-11-15 使用者決定，設計 §10 第 38 點）

/** 帳本三桶的股數，加上 delta（{ own: { MU: -5 } } 這種寫法）。 */
function lotsOf(acct: Account, delta: Partial<BucketShares> = {}): BucketShares {
  const out: BucketShares = { own: { ...acct.lots.own }, mom: { ...acct.lots.mom }, core: { ...acct.lots.core } };
  for (const b of ['own', 'mom', 'core'] as const) for (const [t, q] of Object.entries(delta[b] ?? {})) out[b][t] = (out[b][t] ?? 0) + q;
  return out;
}
function bucketSnap(acct: Account, view: MarketView, delta: Partial<BucketShares>, extra: { cashAdj?: number; note?: string; why?: Record<string, string> } = {}) {
  const lots = lotsOf(acct, delta);
  let cash = acct.cash + (extra.cashAdj ?? 0);
  const shares: Record<string, number> = {};
  for (const b of ['own', 'mom', 'core'] as const) {
    for (const [t, q] of Object.entries(delta[b] ?? {})) cash -= q * priceOf(view, t);
    for (const [t, q] of Object.entries(lots[b])) if (q) shares[t] = (shares[t] ?? 0) + q;
  }
  return { shares, lots, cash, ...(extra.note ? { note: extra.note } : {}), ...(extra.why ? { why: extra.why } : {}) };
}

describe('分桶快照：變動放哪一桶由使用者決定，不再問分類', () => {
  it('核心賣出：照填的桶記帳，原因記在事件上；現金剛好對上 → 沒有其他現金變動', () => {
    const sim = calm();
    const s = applySnapshot(sim.acct, sim.pre, bucketSnap(sim.acct, sim.pre, { core: { VOO: -3 } }, { note: '要用錢' }));
    expect(s.error).toBeUndefined();
    expect(s).toMatchObject({ created: [], followUps: [], cashOther: 0, cashWarn: false });
    expect(s.acct.lots.core.VOO).toBe(sim.acct.lots.core.VOO - 3);
    expect(s.acct.events.at(-1)).toMatchObject({ kind: 'TRADE', bucket: 'core', ticker: 'VOO', shares: -3, reason: '核心的手動交易：要用錢' });
  });

  it('自選賣到 0 股：自動移出自選；賣一部分照舊留著；成交價和估計不同 → 差額記成其他現金變動', () => {
    const sim = calm();
    const all = sim.acct.lots.own.MU;
    const s = applySnapshot(sim.acct, sim.pre, bucketSnap(sim.acct, sim.pre, { own: { MU: -all } }, { cashAdj: -12.5, note: '不再看好' }));
    expect(s.removedOwn).toEqual(['MU']);
    expect(s.acct.own.MU).toBeUndefined();
    expect(s.acct.rule.own.MU).toBeUndefined();
    expect(s.acct.lots.own.MU ?? 0).toBe(0);
    expect(s.acct.events.find((e) => e.kind === 'TRADE' && e.ticker === 'MU')!.reason).toBe('自選的手動交易：不再看好；賣光，移出自選');
    expect(s.acct.shadow.at(-1)).toMatchObject({ title: '手動交易：賣光並移出自選（如果繼續持有）', actual: -all });
    expect(s.cashOther).toBe(-12.5);
    expect(s.acct.events.at(-1)).toMatchObject({ kind: 'CASH_OTHER', amount: -12.5 });
    const part = applySnapshot(sim.acct, sim.pre, bucketSnap(sim.acct, sim.pre, { own: { MU: -1 } }));
    expect(part.removedOwn).toEqual([]);
    expect(part.acct.own.MU).toBeDefined();
  });

  it('自選加新代號：建立這檔（推薦標準比重、為什麼買成為前提），不用新增自選頁', () => {
    const sim = calm();
    expect(sim.acct.own.AAPL).toBeUndefined();
    const s = applySnapshot(sim.acct, sim.pre, bucketSnap(sim.acct, sim.pre, { own: { AAPL: 10 } }, { why: { AAPL: '服務收入穩定成長' } }));
    expect(s.error).toBeUndefined();
    expect(s.created).toEqual([]);
    expect(s.acct.lots.own.AAPL).toBe(10);
    expect(s.acct.own.AAPL).toMatchObject({ origin: 'MANUAL' });
    // T25：前提多記加入的訊號日（own_thesis §1.2）
    expect(s.acct.own.AAPL.premises).toEqual([{ id: 'P1', text: '服務收入穩定成長', origin: 'USER', addedAt: sim.pre.date }]);
    expect(Number.isFinite(s.acct.rule.own.AAPL.stdWeight) && s.acct.rule.own.AAPL.stdWeight > 0).toBe(true);
    // 沒寫為什麼買 → 系統預設前提
    const s2 = applySnapshot(sim.acct, sim.pre, bucketSnap(sim.acct, sim.pre, { own: { AAPL: 10 } }));
    expect(s2.acct.own.AAPL.premises.every((p) => p.origin === 'SYSTEM_DEFAULT')).toBe(true);
  });

  it('動能的清單外買進照舊限制：不在名單上或那一格已買足 → 整份快照擋下，帳戶不變', () => {
    const sim = calm();
    const held = sim.acct.rule.heldMom[0];
    expect(held).toBeDefined();
    const bad = applySnapshot(sim.acct, sim.pre, bucketSnap(sim.acct, sim.pre, { mom: { AAPL: 1 } }));
    expect(bad.error).toContain('不在這個月的動能名單上');
    expect(bad.acct).toBe(sim.acct);
    expect(applySnapshot(sim.acct, sim.pre, bucketSnap(sim.acct, sim.pre, { mom: { [held]: 100000 } })).error).toContain('已經買足');
    // 核心只放核心 ETF／短債；核心 ETF 不能放自選
    expect(applySnapshot(sim.acct, sim.pre, bucketSnap(sim.acct, sim.pre, { core: { AAPL: 1 } })).error).toContain('不是核心的標的');
    expect(applySnapshot(sim.acct, sim.pre, bucketSnap(sim.acct, sim.pre, { own: { VOO: 1 } })).error).toContain('請填在核心');
  });

  it('同一檔兩桶都有：使用者決定賣哪一桶（動能賣掉、自選不動）', () => {
    const sim = calm();
    const held = sim.acct.rule.heldMom.find((t) => (sim.acct.lots.mom[t] ?? 0) > 0)!;
    const n = sim.acct.lots.mom[held];
    const a = structuredClone(sim.acct);
    a.lots.own[held] = (a.lots.own[held] ?? 0) + 5; // 自選也有 5 股
    const s = applySnapshot(a, sim.pre, bucketSnap(a, sim.pre, { mom: { [held]: -n } }));
    expect(s.error).toBeUndefined();
    expect(s.acct.lots.mom[held] ?? 0).toBe(0);
    expect(s.acct.lots.own[held]).toBe(a.lots.own[held]);
    expect(s.acct.shadow.at(-1)).toMatchObject({ title: '手動交易（動能）', actual: -n });
  });

  it('清單照桶對：照清單做完不問；少做超過 1 股 → 問補做或就這樣；還沒按回覆但已照做 → 當成照做', () => {
    const sim = calm();
    const view = sim.pre;
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
    const full = applySnapshot(a1, view, bucketSnap(a1, view, { own: { MU: -20 }, mom: { MU: 30 } }));
    expect(full).toMatchObject({ completed: [id], followUps: [], cashOther: 0 });
    expect(full.acct.events.filter((e) => e.notif === id).map((e) => [e.bucket, e.shares])).toEqual([
      ['own', -20],
      ['mom', 30],
    ]);
    const part = applySnapshot(a1, view, bucketSnap(a1, view, { own: { MU: -20 }, mom: { MU: 25 } }));
    expect(part.followUps).toEqual([id]);
    expect(part.acct.notifs.find((n) => n.id === id)!.followUp).toEqual([{ ticker: 'MU', listed: 10, done: 5 }]);
    expect(part.acct.mom.owe.MU).toBeDefined(); // 策略單少做的，下個月月報再列
    // 沒按回覆，快照已經照清單做了
    const auto = applySnapshot(acct, view, bucketSnap(acct, view, { own: { MU: -20 }, mom: { MU: 30 } }));
    expect(auto.completed).toEqual([id]);
    // 移除自選的清單：照做（股數 0）是完成清單，不是「自己賣光」
    const r = removeOwn(sim.acct, view, 'META');
    const done = applySnapshot(r.acct, view, bucketSnap(r.acct, view, { own: { META: -r.acct.lots.own.META } }));
    expect(done.completed).toEqual([r.notif.id]);
    expect(done.removedOwn).toEqual([]);
    expect(done.acct.own.META).toBeUndefined();
  });

  it('改版前留下的未分類持股：這次照填的桶放好，分類通知一起結束，月報不再暫停', () => {
    const sim = calm();
    const old = applySnapshot(sim.acct, sim.pre, { shares: { ...bookShares(sim.acct), AAPL: 10 }, cash: sim.acct.cash - 10 * priceOf(sim.pre, 'AAPL') });
    expect(old.created.map((n) => n.kind)).toEqual(['CLASSIFY']);
    const a = { ...old.acct, monthlyBlocked: true };
    const lots = lotsOf(a, { own: { AAPL: 10 } });
    const s = applySnapshot(a, sim.pre, { shares: {}, lots, cash: a.cash });
    expect(s.error).toBeUndefined();
    expect(s.acct.lots.unc).toEqual({});
    expect(s.acct.lots.own.AAPL).toBe(10);
    expect(s.acct.notifs.find((n) => n.kind === 'CLASSIFY')!.status).toBe('DONE');
    expect(s.acct.monthlyBlocked).toBe(false);
    expect(s.cashOther).toBe(0); // 已經付過錢，不算第二次
  });
});

describe('持股頁：改標準比重、加前提', () => {
  it('改標準比重只改目標；加前提時原本只有系統預設就取代，否則接在後面（T25：編號接著 premiseSeq，拿掉的編號不再用、不重排）', () => {
    const sim = calm();
    const a = setStdWeight(sim.acct, 'MU', 0.07);
    expect(a.rule.own.MU.stdWeight).toBe(0.07);
    expect(a.lots).toEqual(sim.acct.lots);
    expect(setStdWeight(sim.acct, 'ZZZ', 0.07)).toBe(sim.acct);
    const base = structuredClone(sim.acct);
    base.own.MU.premises = [{ id: 'P1', text: '預設', origin: 'SYSTEM_DEFAULT' }];
    base.own.MU.premiseSeq = 2;
    const p1 = addPremises(base, 'MU', [{ text: '我的理由', origin: 'USER' }], '2026-12-10');
    // 被取代的預設前提用過 P1，新的從 P2 起（編號不重用）
    expect(p1.own.MU.premises).toEqual([{ id: 'P2', text: '我的理由', origin: 'USER', addedAt: '2026-12-10' }]);
    const p2 = addPremises(p1, 'MU', [{ text: 'AI 草稿', origin: 'AI_DRAFT_ACCEPTED', breaksIf: '毛利率跌破 50%' }], '2026-12-11');
    expect(p2.own.MU.premises.map((p) => [p.id, p.origin, p.addedAt])).toEqual([
      ['P2', 'USER', '2026-12-10'],
      ['P3', 'AI_DRAFT_ACCEPTED', '2026-12-11'],
    ]);
    expect(p2.own.MU.premiseSeq).toBe(4);
  });
});

// ---------------------------------------------------------------- 決定了沒填快照、取消、出金還沒轉出（設計 §10 第 40 點）

describe('決定了還沒填快照：提醒一次；月報日先暫停，填完重算', () => {
  it('回覆後 2 個交易日沒填快照 → 提醒一次（只一次）', () => {
    const sim = calm();
    const dep = deposit(sim.acct, sim.pre, 2000);
    sim.acct = dep.acct;
    sim.respond(dep.notif.id);
    const titles: string[] = [];
    for (let k = 0; k < 4; k++) {
      titles.push(...sim.close().map((n) => n.title));
      sim.d++;
    }
    const fill = titles.filter((t) => t.includes('決定了還沒填快照'));
    expect(fill).toEqual([`提醒：清單 #${dep.notif.id}（${dep.notif.date}）決定了還沒填快照`]);
  });

  it('月報日還有決定了沒填快照的清單 → 月報暫停；填完快照 → 用暫停時的輸入重算', () => {
    const sim = calm();
    const dep = deposit(sim.acct, sim.pre, 2000);
    sim.acct = dep.acct;
    sim.respond(dep.notif.id);
    while (sim.date < '2027-01-04') {
      sim.close();
      sim.d++;
    }
    expect(monthlyWait(sim.acct)).toMatchObject({ kind: 'FILL', notif: { id: dep.notif.id } });
    const paused = sim.preOpen()!;
    expect(paused.title).toBe(`月報暫停：清單 #${dep.notif.id} 決定了還沒填快照`);
    expect(sim.acct.monthlyBlocked).toBe(true);
    const s = sim.open()!; // 填快照：入金清單完成
    expect(s.completed).toEqual([dep.notif.id]);
    expect(sim.acct.monthlyBlocked).toBe(false);
    expect(monthlyWait(sim.acct)).toBeNull();
    const m = resumeMonthly(sim.acct, sim.pre);
    expect(m.notif!.title).not.toContain('暫停');
    expect(m.acct.notifs.find((n) => n.id === paused.id)!.status).toBe('READ');
  });
});

describe('取消自己發起的入金／出金／改比例（填快照之前）', () => {
  it('入金：帳上現金與單位退回，記一筆「取消入金」；填過快照就不能取消', () => {
    const sim = calm();
    const nav0 = navPerUnit(sim.acct, sim.pre);
    const dep = deposit(sim.acct, sim.pre, 5000);
    expect(dep.acct.cash).toBe(sim.acct.cash + 5000);
    const c = cancelCashflow(dep.acct, sim.pre, dep.notif.id);
    expect(c.ok).toBe(true);
    expect(c.acct.cash).toBe(sim.acct.cash);
    expect(c.acct.units.total).toBeCloseTo(sim.acct.units.total, 9);
    expect(navPerUnit(c.acct, sim.pre).total).toBeCloseTo(nav0.total, 9);
    expect(c.acct.events.at(-1)).toMatchObject({ kind: 'WITHDRAW', amount: 5000, reason: `取消入金（通知 #${dep.notif.id}）` });
    expect(c.acct.notifs.find((n) => n.id === dep.notif.id)!.status).toBe('CANCELLED');
    expect(cancelCashflow(c.acct, sim.pre, dep.notif.id).ok).toBe(false);
    // 回覆後也能取消；填過快照就不行
    const a1 = respond(dep.acct, sim.pre, dep.notif.id, { mode: 'DO' });
    expect(cancelCashflow(a1, sim.pre, dep.notif.id).ok).toBe(true);
    sim.acct = a1;
    sim.open();
    expect(cancelCashflow(sim.acct, sim.pre, dep.notif.id)).toMatchObject({ ok: false, error: expect.stringContaining('復原上一份快照') });
  });

  it('出金：清單作廢，之後的快照不記出金；改比例：比例與標準比重改回，影子紀錄作廢', () => {
    const sim = calm();
    const wd = withdraw(sim.acct, sim.pre, 3000);
    const a1 = respond(wd.acct, sim.pre, wd.notif.id, { mode: 'DO' });
    const c = cancelCashflow(a1, sim.pre, wd.notif.id);
    expect(c.ok).toBe(true);
    const s = applySnapshot(c.acct, sim.pre, bucketSnap(c.acct, sim.pre, {}));
    expect(s.completed).toEqual([]);
    expect(s.acct.events.some((e) => e.kind === 'WITHDRAW')).toBe(false);
    const std0 = Object.fromEntries(Object.entries(sim.acct.rule.own).map(([t, o]) => [t, o.stdWeight]));
    const ch = changeRatio(sim.acct, sim.pre, { own: 0.3, strat: 0.2, core: 0.5 });
    expect(ch.acct.cfg.ratio.own).toBe(0.3);
    const back = cancelCashflow(ch.acct, sim.pre, ch.notif.id);
    expect(back.acct.cfg.ratio).toEqual(sim.acct.cfg.ratio);
    expect(Object.fromEntries(Object.entries(back.acct.rule.own).map(([t, o]) => [t, o.stdWeight]))).toEqual(std0);
    expect(liveShadow(back.acct.shadow).some((x) => x.choice === 'RATIO')).toBe(false);
    // 不是自己發起的清單不能取消
    const m = structuredClone(sim.acct);
    m.notifs.push({ id: m.nextId++, kind: 'MONTHLY', date: sim.pre.date, seq: sim.pre.i, title: 't', items: [], status: 'PENDING', coreAbsorb: true, reminded: false });
    expect(cancelCashflow(m, sim.pre, m.nextId - 1).ok).toBe(false);
  });
});

describe('出金還沒從券商轉出', () => {
  it('勾了：記成出金、單位照樣贖回，對帳時先扣掉這筆；之後的快照照樣扣，轉出後就不扣', () => {
    const sim = calm();
    const wd = withdraw(sim.acct, sim.pre, 3000);
    const a1 = respond(wd.acct, sim.pre, wd.notif.id, { mode: 'DO' });
    const lines = wd.notif.preview!.lines;
    const delta: Partial<BucketShares> = { own: {}, mom: {}, core: {} };
    for (const l of lines) delta[l.bucket]![l.ticker] = (delta[l.bucket]![l.ticker] ?? 0) + l.shares;
    // 券商的現金：賣完還沒扣出金
    const snap1 = { ...bucketSnap(a1, sim.pre, delta), withdrawPending: true };
    const s1 = applySnapshot(a1, sim.pre, snap1);
    expect(s1.completed).toEqual([wd.notif.id]);
    expect(s1.cashOther).toBe(0);
    expect(s1.cashWarn).toBe(false);
    expect(s1.acct.pendingWithdraw).toBe(3000);
    expect(s1.acct.cash).toBeCloseTo(snap1.cash - 3000, 6);
    expect(s1.acct.events.some((e) => e.kind === 'WITHDRAW' && e.amount === 3000)).toBe(true);
    // 下一份快照：還沒轉出（券商一樣的數字）
    const s2 = applySnapshot(s1.acct, sim.pre, { ...bucketSnap(s1.acct, sim.pre, {}), cash: snap1.cash, withdrawPending: true });
    expect(s2.cashOther).toBe(0);
    expect(s2.acct.pendingWithdraw).toBe(3000);
    // 轉出了：券商的現金少 3000，不勾
    const s3 = applySnapshot(s2.acct, sim.pre, { ...bucketSnap(s2.acct, sim.pre, {}), cash: snap1.cash - 3000 });
    expect(s3.cashOther).toBe(0);
    expect(s3.acct.pendingWithdraw).toBeUndefined();
    // 沒勾、券商也還沒扣 → 差 +3000（會被當成其他現金變動），所以才要勾
    const wrong = applySnapshot(a1, sim.pre, { ...snap1, withdrawPending: false });
    expect(wrong.cashOther).toBeCloseTo(3000, 6);
  });

  it('出金的清單不用下單（現金就夠付）也要等快照才完成，才會記出金', () => {
    const sim = calm();
    const a = structuredClone(sim.acct);
    a.notifs.push({ id: a.nextId++, kind: 'CASHFLOW', date: sim.pre.date, seq: sim.pre.i, title: '出金', status: 'PENDING', coreAbsorb: true, reminded: false, withdraw: 100, items: [{ key: 'k', f: 'F12', kind: 'CASHFLOW', ticker: null, title: '', choices: [{ id: 'DO', label: '', lines: [] }], choice: 'DO', ruleChoice: 'DO', noSkip: true } as never] });
    const r = respond(a, sim.pre, a.nextId - 1, { mode: 'DO' });
    expect(r.notifs.at(-1)!.status).toBe('RESPONDED');
  });
});
