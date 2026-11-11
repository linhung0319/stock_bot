// T1：指標、自選慢規則、動能選股、依波動度減碼、崩盤規則。案例取自設計文件的數字。
import { describe, expect, it } from 'vitest';
import {
  annualizedVol,
  crashRuleOn,
  drawdownFromHigh,
  excessVol,
  floorThird,
  halveShares,
  initialSlowState,
  initialStateForNewPick,
  macdHist,
  median,
  r1,
  rankUniverse,
  rollingMax,
  selectMomentum,
  slowSignals,
  sma,
  stdev,
  stepSlowRule,
  trailingReturn,
  volScale,
  type UniverseRow,
} from '../src/engine';

const flat = (n: number, v: number) => Array.from({ length: n }, () => v);

describe('指標', () => {
  it('均線：不足天數回傳 NaN，足夠時是平均', () => {
    const xs = [1, 2, 3, 4, 5];
    expect(sma(xs, 4, 5)).toBe(3);
    expect(sma(xs, 4, 2)).toBe(4.5);
    expect(sma(xs, 3, 5)).toBeNaN();
  });
  it('52 週高點跌幅：含當日、看 252 個交易日', () => {
    const xs = [...flat(251, 100), 80];
    expect(rollingMax(xs, 251, 252)).toBe(100);
    expect(drawdownFromHigh(xs, 251)).toBeCloseTo(-0.2, 12);
    expect(drawdownFromHigh(xs, 250)).toBeNaN(); // 不足 252 天
  });
  it('252 日報酬', () => {
    const xs = [...flat(252, 50), 75];
    expect(trailingReturn(xs, 252)).toBeCloseTo(0.5, 12);
    expect(trailingReturn(xs, 251)).toBeNaN();
  });
  it('標準差用 ddof = 1；中位數', () => {
    expect(stdev([1, 2, 3, 4])).toBeCloseTo(1.2909944487, 9);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });
  it('年化波動度：日報酬 ±1% 交替 ≈ 16%', () => {
    const xs = [100];
    for (let i = 0; i < 126; i++) xs.push(xs[i] * (i % 2 ? 1.01 : 0.99));
    expect(annualizedVol(xs, 126)).toBeCloseTo(0.01 * Math.sqrt(252) * Math.sqrt(126 / 125), 2);
  });
  it('超額波動：等權組合 − 基準；缺資料的那檔不算進平均', () => {
    const ret: Record<string, number[]> = {
      A: [0.02, -0.02, 0.02, -0.02],
      B: [0.0, 0.0, NaN, 0.0],
      SPY: [0.0, 0.0, 0.0, 0.0],
    };
    const v = excessVol((t) => ret[t], ['A', 'B'], 'SPY', 0, 4);
    expect(v).toBeCloseTo(stdev([0.01, -0.01, 0.02, -0.01]) * Math.sqrt(252), 12);
    // 和基準完全相同 → 0
    expect(excessVol((t) => ret[t], ['SPY'], 'SPY', 0, 4)).toBe(0);
  });
  it('R1：收盤 < 50 日均線且 MACD 柱 < 0', () => {
    const up = Array.from({ length: 120 }, (_, i) => 100 + i);
    expect(r1(up, 119)).toBe(false);
    const down = [...up, ...Array.from({ length: 30 }, (_, i) => 219 - 3 * (i + 1))];
    expect(macdHist(down, down.length - 1)).toBeLessThan(0);
    expect(r1(down, down.length - 1)).toBe(true);
  });
});

describe('自選慢規則（設計 §2.2）', () => {
  it('距 52 週高點跌 ≥ 20% → 減半；-19.9% 不動', () => {
    const s0 = initialSlowState();
    expect(stepSlowRule(s0, { drawdown: -0.199, above200: true }).signal).toBeNull();
    const r = stepSlowRule(s0, { drawdown: -0.2, above200: false });
    expect(r.signal).toBe('REDUCE');
    expect(r.next.state).toBe('HALF');
  });
  it('加回：站上 200 日均線連續 10 天、距上次切換 ≥ 15 個交易日、不在暴跌狀態', () => {
    let st = stepSlowRule(initialSlowState(), { drawdown: -0.25, above200: false }).next; // 第 0 天減半
    const signals: (string | null)[] = [];
    for (let d = 1; d <= 20; d++) {
      const r = stepSlowRule(st, { drawdown: -0.1, above200: true });
      signals.push(r.signal);
      st = r.next;
    }
    // 第 10 天已連續 10 天站上，但距切換不到 15 天；第 15 天才加回
    expect(signals.indexOf('READD')).toBe(14);
    expect(st.state).toBe('STD');
  });
  it('加回：仍在暴跌狀態（距高點 ≤ -20%）就不加回；中間跌破均線重新計算天數', () => {
    let st = stepSlowRule(initialSlowState(), { drawdown: -0.3, above200: false }).next;
    for (let d = 0; d < 30; d++) {
      const r = stepSlowRule(st, { drawdown: -0.22, above200: true });
      expect(r.signal).toBeNull();
      st = r.next;
    }
    st = stepSlowRule(st, { drawdown: -0.1, above200: false }).next; // 跌破，天數歸零
    expect(st.aboveRun).toBe(0);
    for (let d = 0; d < 9; d++) {
      const r = stepSlowRule(st, { drawdown: -0.1, above200: true });
      expect(r.signal).toBeNull();
      st = r.next;
    }
    expect(stepSlowRule(st, { drawdown: -0.1, above200: true }).signal).toBe('READD');
  });
  it('切換間隔 ≥ 15 個交易日：減半後不會馬上再減一次（狀態機）', () => {
    let st = stepSlowRule(initialSlowState(), { drawdown: -0.21, above200: false }).next;
    for (let d = 0; d < 50; d++) {
      const r = stepSlowRule(st, { drawdown: -0.4, above200: false });
      expect(r.signal).toBeNull();
      st = r.next;
    }
  });
  it('整段收盤數列的訊號：追蹤開始前只暖機', () => {
    // 300 天持平，再跌 25%
    const close = [...flat(300, 100), ...flat(5, 75)];
    const sig = slowSignals(close, 280);
    expect(sig[300]).toBe('REDUCE');
    expect(sig.filter(Boolean)).toHaveLength(1);
    // 追蹤開始得比暴跌晚 → 第一天就減半
    expect(slowSignals(close, 302)[302]).toBe('REDUCE');
  });
  it('新增自選：距高點已跌 ≥ 20% → 一開始就是減半狀態', () => {
    expect(initialStateForNewPick(-0.22)).toBe('HALF');
    expect(initialStateForNewPick(-0.05)).toBe('STD');
  });
  it('減半 = 賣掉當時股數的一半，四捨五入到整股（設計例：MU 50 股賣 25 股）', () => {
    expect(halveShares(50)).toBe(25);
    expect(halveShares(25)).toBe(13);
    expect(halveShares(1)).toBe(1);
  });
});

describe('動能（設計 §3）', () => {
  const row = (ticker: string, weight: number, close: number, dv: number, momentum: number): UniverseRow => ({
    ticker,
    weight,
    close,
    dollarVolume: dv,
    momentum,
  });
  it('股票池：股價 > 5、成交金額前 100、市值前 50，再照 252 日報酬排名', () => {
    const rows: UniverseRow[] = [];
    // 120 檔：成交金額 1..120、權重 = 成交金額、動能 = -編號（編號越小動能越高）
    for (let i = 1; i <= 120; i++) rows.push(row('T' + i, i, 50, i, -i));
    rows.push(row('PENNY', 999, 4.9, 999, 9)); // 股價 ≤ 5 → 排除
    rows.push(row('NOVOL', 998, 50, 0, 9)); // 沒有成交 → 排除
    const ranked = rankUniverse(rows);
    expect(ranked).toHaveLength(50);
    // 成交金額前 100 = T21..T120；市值前 50 = T71..T120；動能最高 = 編號最小 = T71
    expect(ranked[0]).toEqual({ ticker: 'T71', momentum: -71, rank: 1 });
    expect(ranked[49].ticker).toBe('T120');
  });
  it('動能資料不足（NaN）的不排名', () => {
    const ranked = rankUniverse([row('A', 3, 10, 5, NaN), row('B', 2, 10, 5, 0.1), row('C', 1, 10, 5, 0.3)]);
    expect(ranked.map((r) => r.ticker)).toEqual(['C', 'B']);
  });
  const order = Array.from({ length: 30 }, (_, i) => 'R' + (i + 1)); // R1 排名第 1

  it('空手時買排名前 5', () => {
    const s = selectMomentum(order, []);
    expect(s.names).toEqual(['R1', 'R2', 'R3', 'R4', 'R5']);
  });
  it('緩衝區：持股掉到第 15 名還留著，第 16 名才賣；掉出股票池也賣', () => {
    const s = selectMomentum(order, ['R15', 'R16', 'GONE', 'R1', 'R9']);
    expect(s.keep).toEqual(['R15', 'R1', 'R9']);
    expect(s.exits).toEqual([
      { ticker: 'R16', why: 'RANK_OUT', rank: 16 },
      { ticker: 'GONE', why: 'UNIVERSE_OUT', rank: null },
    ]);
    // 空出 2 格，照排名補：R2、R3
    expect(s.added).toEqual(['R2', 'R3']);
  });
  it('滿 5 檔而且都在前 15 名 → 不換股', () => {
    const s = selectMomentum(order, ['R11', 'R12', 'R13', 'R14', 'R15']);
    expect(s.added).toEqual([]);
    expect(s.exits).toEqual([]);
  });
  it('被否決或排除的不進場，由下一名遞補', () => {
    const s = selectMomentum(order, ['R1', 'R2', 'R3'], { blocked: ['R4'] });
    expect(s.added).toEqual(['R5', 'R6']);
  });
  it('同一家公司兩類股：只取排名較前的一類', () => {
    const o = ['GOOGL', 'GOOG', 'A', 'B', 'C', 'D'];
    const co = (t: string) => (t === 'GOOG' || t === 'GOOGL' ? 'Alphabet' : t);
    expect(selectMomentum(o, [], { companyOf: co }).names).toEqual(['GOOGL', 'A', 'B', 'C', 'D']);
    // 已經持有 GOOG → GOOGL 不再進場
    expect(selectMomentum(o, ['GOOG'], { companyOf: co }).names).toEqual(['GOOG', 'A', 'B', 'C', 'D']);
  });
});

describe('依波動度減碼（設計 §4.1）', () => {
  const hist = flat(24, 0.2); // σ̃ = 20%
  const base = { history: hist, hyst: 0.1, minHistory: 24, capFirst: false };

  it('無條件捨去到 1/3 的倍數', () => {
    expect(floorThird(1.4)).toBe(1);
    expect(floorThird(0.99)).toBeCloseTo(2 / 3, 12);
    expect(floorThird(2 / 3)).toBeCloseTo(2 / 3, 12);
    expect(floorThird(0.5)).toBeCloseTo(1 / 3, 12);
    expect(floorThird(0.2)).toBe(0);
  });
  it('歷史不足 24 個月 → 不減碼', () => {
    const r = volScale({ ...base, history: flat(23, 0.2), sigma: 0.8, prevW: null });
    expect(r.w).toBe(1);
    expect(r.nextW).toBeNull();
  });
  it('w = min(1, σ̃/σ) 捨去到 1/3：σ 是中位數的 2 倍 → 1/3', () => {
    expect(volScale({ ...base, sigma: 0.4, prevW: null }).w).toBeCloseTo(1 / 3, 12);
    expect(volScale({ ...base, sigma: 0.25, prevW: null }).w).toBeCloseTo(2 / 3, 12); // 0.8
    expect(volScale({ ...base, sigma: 0.1, prevW: null }).w).toBe(1);
  });
  it('遲滯往下：σ̃/σ + 0.1 也要落在新格子，否則維持', () => {
    // 比值 0.95：原始格子 2/3，但 1.05 還在 1 那一格 → 維持 1
    const a = volScale({ ...base, sigma: 0.2 / 0.95, prevW: 1 });
    expect(a.w).toBe(1);
    expect(a.blockedByHysteresis).toBe(true);
    // 比值 0.85：0.95 也在 2/3 → 降到 2/3
    expect(volScale({ ...base, sigma: 0.2 / 0.85, prevW: 1 }).w).toBeCloseTo(2 / 3, 12);
  });
  it('遲滯往上：σ̃/σ − 0.1 也要落在新格子，否則維持', () => {
    // 比值 0.70：原始格子 2/3，但 0.60 還在 1/3 → 維持 1/3
    const a = volScale({ ...base, sigma: 0.2 / 0.7, prevW: 1 / 3 });
    expect(a.w).toBeCloseTo(1 / 3, 12);
    expect(a.blockedByHysteresis).toBe(true);
    expect(volScale({ ...base, sigma: 0.2 / 0.8, prevW: 1 / 3 }).w).toBeCloseTo(2 / 3, 12);
    // 一次跳兩格時，緩衝後落在中間那格就停在中間
    expect(volScale({ ...base, sigma: 0.2 / 1.05, prevW: 1 / 3 }).w).toBeCloseTo(2 / 3, 12);
  });
  it('回到 1：設計文字用原始比值（1.15 − 0.1 ≥ 1 → 回到 1）；Python 回測先壓到 1 所以回不去', () => {
    const sigma = 0.2 / 1.15;
    expect(volScale({ ...base, sigma, prevW: 2 / 3 }).w).toBe(1);
    expect(volScale({ ...base, sigma, prevW: 2 / 3, capFirst: true }).w).toBeCloseTo(2 / 3, 12);
    // 比值 1.05：兩種寫法都維持 2/3
    expect(volScale({ ...base, sigma: 0.2 / 1.05, prevW: 2 / 3 }).w).toBeCloseTo(2 / 3, 12);
  });
});

describe('崩盤規則（設計 §4.4）', () => {
  it('前一日收盤 < 200 日均線 → 啟動；之上 → 不啟動', () => {
    const below = [...flat(199, 100), 95];
    const above = [...flat(199, 100), 105];
    expect(crashRuleOn(below, 199)).toBe(true);
    expect(crashRuleOn(above, 199)).toBe(false);
  });
  it('均線資料不足 → 不啟動', () => {
    expect(crashRuleOn([100, 90], 1)).toBe(false);
  });
});
