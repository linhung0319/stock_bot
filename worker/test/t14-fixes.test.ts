// T14 使用者角度走一遍時發現、修掉的問題（設計 §10 第 37 點）。
import { describe, expect, it } from 'vitest';
import { annualizedVol, applySnapshot, bookShares, classify, priceOf, recentVol, recommendStdWeights, type Account, type MarketView } from '../src/engine';
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
