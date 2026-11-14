// 每日流程 AI 段的共用型別（避免模組互相 import）。
import type { CalendarOverrides } from '../data/calendar';
import type { Alert } from '../data/store';
import type { Account, MarketView } from '../engine';
import type { AiRun } from './aiRuns';
import type { Env, Fetcher } from './env';
import type { FilingCheck } from './filings';

/** 套用 AI 結論時的狀態：帳戶（純粹算）＋要和帳戶一起存的 D1 語句。 */
export interface ApplyCtx {
  db: D1Database;
  acct: Account;
  view: MarketView;
  axis: string[];
  session: string;
  now: Date;
  stmts: D1PreparedStatement[];
  log: string[];
}

/** 一個功能的結論怎麼套用（沒有登記的功能只標成已套用）。 */
export type Applier = (ctx: ApplyCtx, run: AiRun) => Promise<void>;

export interface StepResult {
  created: number[];
  started: string[];
  log: string[];
  alerts: Alert[];
}

/** 開新的 AI 執行時的狀態（帳戶已經存好）。 */
export interface StartCtx {
  env: Env;
  fetcher: Fetcher;
  acct: Account;
  view: MarketView;
  axis: string[];
  session: string;
  ov: CalendarOverrides;
  now: Date;
  checks: FilingCheck[];
  res: StepResult;
  /** 這次每日流程裡發生、要開 AI 的事（F7 新的減半、F21 策略檢討提醒）。 */
  extras: FlowExtras;
}

export interface FlowExtras {
  /** 這次處理的交易日裡，慢規則新觸發減半的自選股。 */
  reduced?: { ticker: string; session: string }[];
  /** 這次處理的交易日裡，策略檢討的提醒。 */
  strategyAlerts?: { session: string; text: string }[];
}
