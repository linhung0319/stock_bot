// 風險層：依波動度減碼（設計 §4.1）與崩盤規則（設計 §4.4）。
import { median, sma } from './indicators';

/** 無條件捨去到 1/3 的倍數（0、1/3、2/3、1）。 */
export function floorThird(x: number): number {
  return Math.floor(Math.min(1, Math.max(0, x)) * 3 + 1e-9) / 3;
}

export interface VolScaleInput {
  /** 這次的 σ（動能部位相對 SPY 的年化超額波動）。 */
  sigma: number;
  /** 以前每個月報日的 σ（不含這次）。 */
  history: number[];
  /** 目前的比例；null = 還沒開始減碼。 */
  prevW: number | null;
  /** 遲滯緩衝（B-8 採用 0.10）。 */
  hyst: number;
  /** 至少要有幾個月的歷史才開始減碼。 */
  minHistory: number;
  /** 見 EngineConfig.volHystCapFirst。 */
  capFirst: boolean;
}

export interface VolScaleResult {
  /** 這次的比例；歷史不足時是 1。 */
  w: number;
  /** 寫回狀態的比例；歷史不足時維持 null。 */
  nextW: number | null;
  /** σ̃/σ（歷史不足時 null）。 */
  ratio: number | null;
  /** 沒有遲滯時會落在哪一格。 */
  rawCell: number | null;
  /** 遲滯擋下了這次改變。 */
  blockedByHysteresis: boolean;
}

/**
 * w = min(1, σ̃ / σ)，無條件捨去到 1/3 的倍數。
 * 遲滯：要往上一格，σ̃/σ − hyst 也要落在新格子裡；往下一格，σ̃/σ + hyst 也要落在新格子裡；否則維持原比例。
 */
export function volScale(inp: VolScaleInput): VolScaleResult {
  if (inp.history.length < inp.minHistory) {
    return { w: 1, nextW: inp.prevW, ratio: null, rawCell: null, blockedByHysteresis: false };
  }
  const ratio = median(inp.history) / inp.sigma;
  const base = inp.capFirst ? Math.min(1, ratio) : ratio;
  const rawCell = floorThird(base);
  let cand = rawCell;
  if (inp.prevW !== null && inp.hyst > 0) {
    if (cand > inp.prevW) cand = Math.max(inp.prevW, floorThird(base - inp.hyst));
    else if (cand < inp.prevW) cand = Math.min(inp.prevW, floorThird(base + inp.hyst));
  }
  return {
    w: cand,
    nextW: cand,
    ratio,
    rawCell,
    blockedByHysteresis: inp.prevW !== null && rawCell !== inp.prevW && cand === inp.prevW,
  };
}

/**
 * 崩盤規則（設計 §4.4）：每月換股日，核心 ETF 前一日收盤 < 200 日均線 → 啟動。
 * close 是到前一交易日為止的收盤，i 是前一交易日的位置。
 */
export function crashRuleOn(close: ArrayLike<number>, i: number, maDays = 200): boolean {
  const ma = sma(close, i, maDays);
  return close[i] < ma;
}
