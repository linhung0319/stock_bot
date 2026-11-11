// 自選慢規則（設計 §2.2）：狀態機，每天收盤後前進一步。
//   減半：收盤距 52 週高點跌 ≥ 20%
//   加回：收盤站上 200 日均線連續 10 天、距上次切換 ≥ 15 個交易日、且不在暴跌狀態
import { drawdownFromHigh, sma } from './indicators';
import type { OwnAction, OwnState } from './types';

export const SLOW = { drawdown: -0.2, maDays: 200, aboveRun: 10, minGap: 15, highDays: 252 } as const;

export interface SlowRuleState {
  state: OwnState;
  /** 收盤連續站上 200 日均線的天數。 */
  aboveRun: number;
  /** 距上次切換過了幾個交易日（還沒切換過 = 很大的數）。 */
  sinceSwitch: number;
}

export const NEVER_SWITCHED = 1_000_000_000;

export function initialSlowState(state: OwnState = 'STD', aboveRun = 0): SlowRuleState {
  return { state, aboveRun, sinceSwitch: NEVER_SWITCHED };
}

export interface SlowDayInput {
  /** 收盤距 52 週高點的跌幅（負數）；資料不足時 NaN。 */
  drawdown: number;
  /** 收盤是否高於 200 日均線。 */
  above200: boolean;
}

export interface SlowStepResult {
  next: SlowRuleState;
  signal: OwnAction | null;
}

/**
 * 前進一個交易日。active = false 時只更新「連續站上均線天數」，不產生訊號
 * （用在開始追蹤這檔之前的歷史暖機）。
 */
export function stepSlowRule(prev: SlowRuleState, day: SlowDayInput, active = true): SlowStepResult {
  const aboveRun = day.above200 ? prev.aboveRun + 1 : 0;
  const sinceSwitch = Math.min(NEVER_SWITCHED, prev.sinceSwitch + 1);
  const severe = day.drawdown <= SLOW.drawdown;
  if (active) {
    if (prev.state === 'STD' && severe) {
      return { next: { state: 'HALF', aboveRun, sinceSwitch: 0 }, signal: 'REDUCE' };
    }
    if (prev.state === 'HALF' && aboveRun >= SLOW.aboveRun && sinceSwitch >= SLOW.minGap && !severe) {
      return { next: { state: 'STD', aboveRun, sinceSwitch: 0 }, signal: 'READD' };
    }
  }
  return { next: { state: prev.state, aboveRun, sinceSwitch }, signal: null };
}

/** 由收盤數列算某一天的慢規則輸入。 */
export function slowDayInput(close: ArrayLike<number>, i: number): SlowDayInput {
  const ma = sma(close, i, SLOW.maDays);
  return { drawdown: drawdownFromHigh(close, i, SLOW.highDays), above200: close[i] > ma };
}

/**
 * 新增自選的初始狀態（設計 §2.2）：現在距 52 週高點已跌 ≥ 20% → 一開始就是減半，
 * 只買標準比重的一半，避免一買進就收到減半通知。
 */
export function initialStateForNewPick(drawdown: number): OwnState {
  return drawdown <= SLOW.drawdown ? 'HALF' : 'STD';
}

/** 整段歷史的訊號（重放與測試用）。startIndex 之前只暖機。 */
export function slowSignals(close: ArrayLike<number>, startIndex: number): (OwnAction | null)[] {
  const out: (OwnAction | null)[] = [];
  let st = initialSlowState();
  for (let i = 0; i < close.length; i++) {
    const r = stepSlowRule(st, slowDayInput(close, i), i >= startIndex);
    st = r.next;
    out.push(r.signal);
  }
  return out;
}

/** 減半 = 賣掉當時持有股數的一半，四捨五入到整股（設計 §2.2；全系統只有這一種減半）。 */
export function halveShares(shares: number): number {
  return Math.round(shares / 2);
}
