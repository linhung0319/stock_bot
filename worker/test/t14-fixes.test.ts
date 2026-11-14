// T14 使用者角度走一遍時發現、修掉的問題（設計 §10 第 37 點）。
import { describe, expect, it } from 'vitest';
import { addPremises, annualizedVol, applySnapshot, bookShares, classify, priceOf, recentVol, recommendStdWeights, removeOwn, respond, setStdWeight, type Account, type BucketShares, type MarketView } from '../src/engine';
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
    expect(s.acct.own.AAPL.premises).toEqual([{ id: 'P1', text: '服務收入穩定成長', origin: 'USER' }]);
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
  it('改標準比重只改目標；加前提時原本只有系統預設就取代，否則接在後面', () => {
    const sim = calm();
    const a = setStdWeight(sim.acct, 'MU', 0.07);
    expect(a.rule.own.MU.stdWeight).toBe(0.07);
    expect(a.lots).toEqual(sim.acct.lots);
    expect(setStdWeight(sim.acct, 'ZZZ', 0.07)).toBe(sim.acct);
    const base = structuredClone(sim.acct);
    base.own.MU.premises = [{ id: 'P1', text: '預設', origin: 'SYSTEM_DEFAULT' }];
    const p1 = addPremises(base, 'MU', [{ text: '我的理由', origin: 'USER' }]);
    expect(p1.own.MU.premises).toEqual([{ id: 'P1', text: '我的理由', origin: 'USER' }]);
    const p2 = addPremises(p1, 'MU', [{ text: 'AI 草稿', origin: 'AI_DRAFT_ACCEPTED', breaksIf: '毛利率跌破 50%' }]);
    expect(p2.own.MU.premises.map((p) => [p.id, p.origin])).toEqual([
      ['P1', 'USER'],
      ['P2', 'AI_DRAFT_ACCEPTED'],
    ]);
  });
});
