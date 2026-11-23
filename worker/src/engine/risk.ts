// 風險層：依波動度減碼（設計 §4.1）。崩盤規則（設計 §4.4）2026-11-22 退場：重放 B-8 的舊路徑在 replay.ts 自己算 200 日線，
// T88 刪掉沒有呼叫端的 crashRuleOn、crashDecision、validBars。
import { median } from './indicators';

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

