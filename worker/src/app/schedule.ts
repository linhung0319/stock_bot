// 三次排程各做什麼，集中在這裡（own_thesis_design_2026-11-15 §2.7；動能多做的在 momentum_ai_design §3.9、核心在 core_ai_design §3.12）。
//
//   FIRST   UTC 23:30（台灣 07:30）週一到週五：抓資料 → 每日檢查 → 月底出月報 → 套用 AI 結論 → 看新申報、開這一天所有新的 AI 執行 → 推播
//           （這一次失敗的告警先不推，兩小時後會再試）
//   FINAL   UTC 01:30（台灣 09:30）週二到週六：今天沒做完就再試一次（做了就和 FIRST 一樣開這一天的執行）；套用結論；
//           接著開 finalStarts 的那幾種（硬事件法庭、當天沒有結論的每日掃描重掃…）；標記逾時；推播；還是沒做完就推缺席告警
//   APPLY   UTC 03:30（台灣 11:30）週二到週六：只套用回來的結論、推新通知與告警、標記逾時。
//           不抓資料、不跑每日檢查、不開新的執行。今天的每日流程還沒做完就不套用（帳戶還停在前一天）
//   MANUAL  POST /admin/flow：和 FIRST 相同，但失敗也推告警、也標記逾時
//
// 星期用英文縮寫：Cloudflare 的數字是 1 = 星期日（不是一般 cron 的 1 = 星期一），2026-11-13 因此漏跑過一次週五（progress_log 2026-11-14）。
// wrangler.jsonc 的 triggers.crons 要和這裡相同（test/flow.test.ts 鎖住）。
import type { ScanTarget } from '../ai/events';
import { guard, type StartCtx } from './aiCtx';
import { rescanEvents, startCourts } from './events';

export type Attempt = 'FIRST' | 'FINAL' | 'APPLY' | 'MANUAL';

export interface SlotPlan {
  /** 排程的 cron（UTC）；手動的是 null。 */
  cron: string | null;
  /** 抓資料、每日檢查、月報（同一個交易日只處理一次，做過就跳過）。 */
  daily: boolean;
  /** 這次處理了新的交易日時：看新申報、開這一天的 AI 執行（aiStep 第 1、3 段）。 */
  startNewDay: boolean;
  /** 套用之後另外開 finalStarts 的那幾種（這次沒有處理新的交易日時；處理了的話第 3 段已經全部開過）。 */
  finalStarts: boolean;
  /** 標記逾時的 AI 任務、照規則結束那幾次執行、推 AI_TIMEOUT 告警。 */
  sweep: boolean;
  /** 今天的流程還是沒跑完 → 缺席告警（FLOW_MISSED）。 */
  missedAlert: boolean;
  /** 流程沒跑完也推告警（FIRST 失敗先不推，等 FINAL）。 */
  alertOnFailure: boolean;
}

export const SCHEDULE: Record<Attempt, SlotPlan> = {
  FIRST: { cron: '30 23 * * MON-FRI', daily: true, startNewDay: true, finalStarts: false, sweep: false, missedAlert: false, alertOnFailure: false },
  FINAL: { cron: '30 1 * * TUE-SAT', daily: true, startNewDay: true, finalStarts: true, sweep: true, missedAlert: true, alertOnFailure: true },
  APPLY: { cron: '30 3 * * TUE-SAT', daily: false, startNewDay: false, finalStarts: false, sweep: true, missedAlert: false, alertOnFailure: true },
  MANUAL: { cron: null, daily: true, startNewDay: true, finalStarts: false, sweep: true, missedAlert: true, alertOnFailure: true },
};

/** 每日流程（美股收盤後；UTC 23:30 = 美東 18:30 或 19:30 = 台灣早上 7:30）。 */
export const INGEST_CRON = SCHEDULE.FIRST.cron!;
/** 兩小時後再試一次（UTC 01:30）。 */
export const FINAL_CRON = SCHEDULE.FINAL.cron!;
/** 再兩小時後只套用與推播（UTC 03:30）。 */
export const APPLY_CRON = SCHEDULE.APPLY.cron!;
/** wrangler.jsonc 的 triggers.crons（順序相同）。 */
export const CRONS = [INGEST_CRON, FINAL_CRON, APPLY_CRON];

/** Cloudflare 排程送來的 cron → 哪一次。認不得的當成 FIRST（和以前相同）。 */
export function attemptOfCron(cron: string): Attempt {
  if (cron === FINAL_CRON) return 'FINAL';
  if (cron === APPLY_CRON) return 'APPLY';
  return 'FIRST';
}

/**
 * 01:30 套用結論之後接著開的執行（own_thesis §2.7 的掛點）。aiStep 在 FINAL、這次沒有處理新的交易日、雲端排程設定好了時呼叫。
 * 每一段各自 guard，出錯只記在紀錄裡。後面的任務在這裡加：
 *   T28  當天的每日掃描沒有合格結論就重開一次（own_thesis §2.6）：rescanEvents（已接）
 *   T29b 提前審查 startEarlyReviews（own_thesis §2.4）
 *   T32b 動能的 momRecheck（月報前一天與訊號日，momentum_ai §3.9）
 *   T33b 崩盤檢視的 crashNeeds（有需要時，core_ai §3.12）
 */
export async function finalStarts(sc: StartCtx, targets: ScanTarget[]): Promise<void> {
  // 每日掃描（或 23:30 之後的規則段）標到的硬事件候選 → 同一次就開法庭，不等到隔天
  await guard(sc.res, '硬事件法庭（01:30）', () => startCourts(sc, targets, { fetchChecks: true }));
  // 當天的每日掃描沒有合格結論（含逾時、沒開成）→ 重開一次
  await guard(sc.res, '每日掃描重掃（01:30）', () => rescanEvents(sc, targets));
}
