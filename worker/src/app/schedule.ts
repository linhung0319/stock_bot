// 三次排程各做什麼，集中在這裡（own_thesis_design_2026-11-15 §2.7；動能多做的在 momentum_ai_design §3.9、核心在 core_ai_design §3.12）。
//
//   FIRST   UTC 23:30（台灣 07:30）週一到週五：抓資料 → 每日檢查 → 月底出月報 → 套用 AI 結論 → 看新申報、開這一天所有新的 AI 執行 → 推播
//           （這一次失敗的告警先不推，兩小時後會再試；新通知上有還在等的 AI 結果——例如慢規則減半的論點檢查——也先不推，等 FINAL）
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
import { startCrashRuns } from './crashAi';
import { startMarketBrief } from './marketBrief';
import { rescanEvents, startCourts } from './events';
import { momRecheck } from './momAi';
import { startCondReviews, startEarlyReviews } from './ownAi';

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
  /**
   * 規則的通知等到下一次流程再推（own_thesis §3.5、core_ai §3.2；判斷在 src/app/pushHold.ts）：這次新產生的通知上有還在等的 AI 結果就先不推 LINE。
   * 23:30 與手動的流程會等；01:30 不管結果回來了沒都推（之前留住的與這次新產生的），03:30 補推之後才回來的結果。
   */
  holdWaiting: boolean;
}

export const SCHEDULE: Record<Attempt, SlotPlan> = {
  FIRST: { cron: '30 23 * * MON-FRI', daily: true, startNewDay: true, finalStarts: false, sweep: false, missedAlert: false, alertOnFailure: false, holdWaiting: true },
  FINAL: { cron: '30 1 * * TUE-SAT', daily: true, startNewDay: true, finalStarts: true, sweep: true, missedAlert: true, alertOnFailure: true, holdWaiting: false },
  APPLY: { cron: '30 3 * * TUE-SAT', daily: false, startNewDay: false, finalStarts: false, sweep: true, missedAlert: false, alertOnFailure: true, holdWaiting: false },
  MANUAL: { cron: null, daily: true, startNewDay: true, finalStarts: false, sweep: true, missedAlert: true, alertOnFailure: true, holdWaiting: true },
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
 *   T29a 你定的「重新審查」條件在 01:30 才確認成立 → 當天開審查（own_thesis §1.10）：startCondReviews（已接）
 *   T29b 提前審查（掃描在 01:30 才標到的可提前事件，同一次就開）：startEarlyReviews（已接；每日第一次流程也呼叫）
 *   T32b 動能的 momRecheck（月報前一天與訊號日，momentum_ai §3.9）：重開沒有結論的進場法庭與回看、回看帶來新命中的開法庭（已接）
 *   T64  市場摘要：補看 01:30 才開的提前審查、重試當天沒有成功的那一份（composite_layer_design §1.2）：startMarketBrief（已接）
 *   T33b 崩盤檢視：先重抓不足的總經資料，再跑 crashNeeds（沒有結論的重開一次、資料重抓後夠了就開；core_ai §3.1、§3.5、§3.12）（已接）
 */
export async function finalStarts(sc: StartCtx, targets: ScanTarget[]): Promise<void> {
  // 每日掃描（或 23:30 之後的規則段）標到的硬事件候選 → 同一次就開法庭，不等到隔天
  await guard(sc.res, '硬事件法庭（01:30）', () => startCourts(sc, targets, { fetchChecks: true }));
  // 當天的每日掃描沒有合格結論（含逾時、沒開成）→ 重開一次
  await guard(sc.res, '每日掃描重掃（01:30）', () => rescanEvents(sc, targets));
  // 動能進場審查（月報前一天與訊號日）：回看沒有結論重開一次；法庭沒有結論重開一次；回看帶來新命中的開法庭；重跑抓不到申報的
  // （放在提前審查之前：回看寫的財測下修事件先由進場審查收掉，不被當成「已經不是自選股」的提前審查候選）
  await guard(sc.res, '動能進場審查重開（01:30）', () => momRecheck(sc));
  // 套用時成立的你定的「重新審查」條件 → 今天還沒有審查的開一次
  await guard(sc.res, '你定的條件成立後的審查（01:30）', () => startCondReviews(sc));
  // 掃描標到的可提前事件（執行長或財務長離任、下修財測…）→ 同一次就開提前審查（own_thesis §2.4、§2.7）
  await guard(sc.res, '提前審查（01:30）', () => startEarlyReviews(sc, { fetchChecks: true }));
  // 市場摘要（composite_layer_design §1.2，T64）：01:30 才開的提前審查也算「當天有個股執行」；23:30 開的那一份沒有成功 → 再試一次（一個事件各最多 2 次）
  await guard(sc.res, '市場摘要（01:30）', () => startMarketBrief(sc, { final: true }));
  // 崩盤規則檢視：總經資料重抓（§3.5）；預估或補開的檢視沒有結論 → 重開一次（同一個月份＋方向合計最多 3 次，§3.1）
  await guard(sc.res, '崩盤規則檢視（01:30）', () => startCrashRuns(sc, { final: true }));
}
