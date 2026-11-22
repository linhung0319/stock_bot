// 自選慢規則（設計 §2.2）：狀態機，每天收盤後前進一步。
//   減半：收盤距 52 週高點跌 ≥ 20%
//   加回：收盤站上 200 日均線連續 10 天、距上次切換 ≥ 15 個交易日、且不在暴跌狀態
import { drawdownFromHigh, sma } from './indicators';
import type { OwnAction, OwnApplied, OwnState } from './types';

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
 * thesis（allocation_redesign §4.1，T83）：有你的論點的股票改成先買一半（BUILD），看開檔後第一份財報的審查補滿，不等 200 日線；
 * 只有預設前提的照舊（HALF、等均線）。
 */
export function initialStateForNewPick(drawdown: number, thesis = false): OwnApplied {
  if (!(drawdown <= SLOW.drawdown)) return 'STD';
  return thesis ? 'BUILD' : 'HALF';
}

// ---------------------------------------------------------------- 審查後持有（WATCH，allocation_redesign §3.3）

/** 跌幅審查的幾級（距 52 週高點）：-20% 第一次審，之後每多跌 10 個百分點再審一次。 */
export const DROP_LADDER = [-0.2, -0.3, -0.4, -0.5] as const;

/** 這個跌幅到了 DROP_LADDER 的第幾級（0 = -20%、1 = -30%…）；還沒到第一級、或算不出來（NaN）是 -1。純函式。 */
export function dropLadder(drawdown: number): number {
  let k = -1;
  for (let i = 0; i < DROP_LADDER.length; i++) if (drawdown <= DROP_LADDER[i]) k = i;
  return k;
}

export interface WatchStep {
  next: SlowRuleState;
  /** 已經審過哪一級。 */
  level: number;
  /** BACK：加回條件成立，回到標準（不下單、不通知）；DEEPER：又跌了一級，重新審查。 */
  event: 'BACK' | 'DEEPER' | null;
}

/**
 * 審查後持有的股票前進一個交易日（§3.3）。stepped 是 stepSlowRule 對這一天算完的狀態（它不認得 WATCH，只更新連續站上均線天數與距上次切換的天數）。
 *   回到標準：和減半的加回同一組條件——站上 200 日線連續 10 天、距上次切換 ≥ 15 個交易日、跌幅已不到 20%
 *   再審：跌幅到了比已經審過的更深的一級（一天跌過兩級只審一次，記最深的那一級）
 */
export function stepWatch(stepped: SlowRuleState, level: number, day: SlowDayInput): WatchStep {
  const severe = day.drawdown <= SLOW.drawdown;
  if (stepped.aboveRun >= SLOW.aboveRun && stepped.sinceSwitch >= SLOW.minGap && !severe) return { next: { state: 'STD', aboveRun: stepped.aboveRun, sinceSwitch: 0 }, level, event: 'BACK' };
  const k = dropLadder(day.drawdown);
  if (k > level) return { next: stepped, level: k, event: 'DEEPER' };
  return { next: stepped, level, event: null };
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
