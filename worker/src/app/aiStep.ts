// 每日流程的 AI 段（T10、T11）。每次每日流程（src/app/flow.ts）都會呼叫：
//   1. 這次有處理新的交易日（startNew）：持股、候選股的新申報 → 規則分類（F18 規則段）；自選股的新財報 → XBRL
//   2. 套用（和帳戶同一筆存檔，和網站同時存檔時重來）：
//        新的財報類申報結束靜默期（own_thesis §1.10，T30）
//        已經有結論、還沒套用的 AI 執行（各功能的 applier）
//        財報條件（程式比對 XBRL）、規則直接提出的硬事件（動能持股被收購、持股的 NT 10-K／10-Q）
//   3. startNew 而且雲端排程設定好了：開新的執行
//        F25／F24（自選）、財報新聞稿的數字擷取（OWN_EARNINGS，T29c）、F19 法庭與 F18 掃描、F1 否決法庭、進場前回看與擬事件打分（月報前一天；
//        月報當天才進榜的在月報之後開，T32b）、
//        F5／F6 崩盤規則檢視（月報前一天；切換了卻沒預估到時補開）、F7 減半檢視、自選的個股自身大跌（PRICE_DROP）與動能的 F20 大跌說明、
//        F21 策略檢討說明、提前審查（T29b）
//      沒有 startNew 時只開 afterApply 的那幾種（01:30 的 finalStarts，src/app/schedule.ts）；03:30 兩者都沒有，只套用
// 每一段出錯只記在紀錄裡，不擋其他段；規則的部分在這之前已經照常做完。
import { buildMarketView, rebaseNotifSeq } from '../data/marketView';
import type { CalendarOverrides } from '../data/calendar';
import { loadRanking, loadSeries } from '../data/store';
import { DROP_EXPLAIN, OWN_DROP } from '../ai/drops';
import { EVENT_SCAN, HARD_EVENT, type ScanTarget } from '../ai/events';
import { MOM_ENTRY } from '../ai/momEntry';
import { OWN_EARNINGS } from '../ai/earnings';
import { CRASH_REVIEW } from '../ai/crash';
import { OWN_CONDITION, OWN_REVIEW } from '../ai/ownReview';
import { guard, type Applier, type ApplyCtx, type FlowExtras, type StartCtx, type StepResult } from './aiCtx';
import { closeStaleRuns, getRun, listRuns } from './aiRuns';
import { applyCrashReview, startCrashRuns } from './crashAi';
import { applyDropExplain, applyOwnDrop, markDropNone, startDropRuns } from './dropAi';
import { applyOwnEarnings, startOwnEarnings } from './earningsAi';
import type { Env, Fetcher } from './env';
import { applyEventScan, applyHardEvent, applyRuleEvents, classifyFresh, scanTargets, startEventRuns, type Classified } from './events';
import { fetchFilingChecks, markSeen, sectorEtfs, type FilingCheck } from './filings';
import { ConflictError, loadAccount, requiredTickers, saveAccount, thesisLogStmt } from './ledgerStore';
import { applyMomEntry, momLateStart, momPreview } from './momAi';
import { applyOwnCondition, applyOwnReview, ownFacts, ownXbrlConditions, routineReady, startEarlyReviews, startOwnRuns } from './ownAi';
import { noteOfRun } from './site/aiViews';
import { annotate } from './site/explain';
import type { AiNote } from './site/types';
import { startStrategyRun } from './strategyAi';
import { breakLogs, ruleBreakLogs, withRuleKeys } from './thesis';
import { endDisputes } from '../engine';

export type { StepResult as AiStepResult } from './aiCtx';

/** 各功能的結論怎麼套用（沒有登記的功能只標成已套用：擬事件打分、策略檢討、健檢只記錄或由別處讀）。 */
export const APPLIERS: Record<string, Applier> = {
  [OWN_REVIEW]: applyOwnReview,
  [OWN_CONDITION]: applyOwnCondition,
  [OWN_EARNINGS]: applyOwnEarnings,
  [HARD_EVENT]: applyHardEvent,
  [EVENT_SCAN]: applyEventScan,
  [MOM_ENTRY]: applyMomEntry,
  [OWN_DROP]: applyOwnDrop,
  [DROP_EXPLAIN]: applyDropExplain,
  // 崩盤規則檢視：月報之後才回來的結果更新那一項、連續沒有結論的告警（core_ai §3.2、§3.1）
  [CRASH_REVIEW]: applyCrashReview,
};

/** 套用之後、沒有 startNew 時另外開的執行（01:30 的 finalStarts）。 */
export type AfterApply = (sc: StartCtx, targets: ScanTarget[]) => Promise<void>;

export async function aiStep(env: Env, fetcher: Fetcher, now: Date, session: string, ov: CalendarOverrides, startNew: boolean, extras: FlowExtras = {}, afterApply?: AfterApply): Promise<StepResult> {
  const db = env.DB;
  const res: StepResult = { created: [], started: [], log: [], alerts: [] };
  const first = await loadAccount(db);
  if (!first) return res;
  const targets = await scanTargets(db, first.acct);
  const ranking = await loadRanking(db);
  const sectors = Object.values(await sectorEtfs(db, targets.map((t) => t.ticker)));
  const series = await loadSeries(db, [...new Set([...requiredTickers(first.acct), ...targets.map((t) => t.ticker), ...sectors, ...(ranking?.order ?? [])])]);
  let built;
  try {
    built = buildMarketView(series, session, first.acct.cfg.coreTicker);
  } catch {
    return res;
  }
  const { view, axis } = built;

  // 1. 新申報（只在處理了新交易日的那一次）
  let checks: FilingCheck[] = [];
  let classified: Classified[] = [];
  let facts = new Map();
  if (startNew && env.EDGAR_USER_AGENT && targets.length) {
    await guard(res, '看新申報', async () => {
      checks = await fetchFilingChecks(env, fetcher, targets.map((t) => t.ticker), session, res.log);
      classified = await classifyFresh(env, fetcher, checks, targets, res.log);
      facts = await ownFacts(env, fetcher, checks, new Set(Object.keys(first.acct.own)), session, res.log);
    });
  }

  // 2. 套用（和網站的操作同時存檔時重來，最多 3 次；抓到的資料沿用）
  // 已經超過時限、還在等結果的執行先照規則結束，這一次就套用（01:30 才知道 23:30 的掃描沒有結論、要不要重掃）
  await closeStaleRuns(db, now);
  for (let tryNo = 0; ; tryNo++) {
    const loaded = tryNo === 0 ? first : await loadAccount(db);
    if (!loaded) return res;
    rebaseNotifSeq(loaded.acct, axis);
    const before = new Set(loaded.acct.notifs.map((n) => n.id));
    const hadExit = withRuleKeys(loaded.acct);
    const ctx: ApplyCtx = { db, acct: loaded.acct, view, axis, session, now, stmts: [], log: [], alerts: [] };
    // 靜默期：這檔出現新的財報類申報、距不同意滿 45 天 → 到那份申報的前一天結束（own_thesis §1.10）；在套用審查之前
    for (const c of checks) {
      if (!ctx.acct.own[c.ticker]?.disputes?.length) continue;
      const r = endDisputes(ctx.acct, c.ticker, c.fresh);
      if (!r.ended.length) continue;
      ctx.acct = r.acct;
      ctx.log.push(...r.ended.map((x) => `${c.ticker} 前提 ${x.premiseId} 的靜默期到 ${x.until} 結束（有新的財報類申報）`));
    }
    const done =(await db.prepare("SELECT run_id FROM ai_runs WHERE status = 'DONE' AND applied_at IS NULL ORDER BY completed_at").all<{ run_id: string }>()).results;
    for (const { run_id } of done) {
      const run = await getRun(db, run_id);
      if (!run) continue;
      ctx.stmts.push(db.prepare('UPDATE ai_runs SET applied_at = ? WHERE run_id = ?').bind(now.toISOString(), run_id));
      const apply = APPLIERS[run.fn];
      if (apply) await apply(ctx, run);
    }
    await ownXbrlConditions(ctx, facts);
    await applyRuleEvents(ctx, classified);
    // 新的失效通知（甲類、乙類）→ 論點檔的 BREAK_NOTICE（own_thesis §1.10），和帳戶同一筆存
    ctx.stmts.push(...breakLogs(ctx.acct, ctx.acct.notifs.filter((n) => !before.has(n.id))).map((l) => thesisLogStmt(db, l, null, now.toISOString())));
    // 既有的慢規則通知這次更新成「AI 建議出清」（own_thesis §3.4）→ 一樣寫 BREAK_NOTICE（withRule）
    ctx.stmts.push(...ruleBreakLogs(hadExit, before, ctx.acct).map((l) => thesisLogStmt(db, l, null, now.toISOString())));
    if (!ctx.stmts.length && ctx.acct === loaded.acct) break;
    const notes = (await listRuns(db, now, { limit: 200 })).map(noteOfRun).filter((n): n is AiNote => n !== null);
    annotate({ acct: ctx.acct, view, axis, rankOrder: ranking?.order ?? [], aiNotes: notes }, (n) => !before.has(n.id));
    try {
      await saveAccount(db, ctx.acct, loaded, 'AI 結論與事件', now, ctx.stmts);
    } catch (e) {
      if (e instanceof ConflictError && tryNo < 2) continue;
      throw e;
    }
    res.created.push(...ctx.acct.notifs.filter((n) => !before.has(n.id)).map((n) => n.id));
    res.log.push(...ctx.log);
    res.alerts.push(...(ctx.alerts ?? []));
    break;
  }

  if (!startNew) {
    if (!afterApply) return res;
    if (!routineReady(env)) {
      res.log.push('雲端排程還沒設定，不開新的 AI 執行');
      return res;
    }
    const acct = (await loadAccount(db))!.acct;
    await afterApply({ env, fetcher, acct, view, axis, session, ov, now, checks: [], res, extras }, targets);
    return res;
  }
  await markSeen(db, checks, now);
  if (!routineReady(env)) {
    res.log.push('雲端排程還沒設定，不開新的 AI 執行');
    // 這次新觸發減半的自選股沒有論點檢查：記成沒有結論（own_thesis §3.3），通知照舊當場推
    await guard(res, '減半檢視的狀態', async () => markDropNone(db, now, view, (await loadAccount(db))!.acct, extras.reduced ?? [], res.log));
    return res;
  }

  // 3. 開新的執行
  const acct = (await loadAccount(db))!.acct;
  const sc: StartCtx = { env, fetcher, acct, view, axis, session, ov, now, checks, res, extras };
  await guard(res, '自選審查與條件監測', () => startOwnRuns(sc));
  // 財報新聞稿當天確認你定的財報條件（own_thesis §1.11）
  await guard(res, '財報數字擷取', () => startOwnEarnings(sc));
  await guard(res, '硬事件與每日掃描', () => startEventRuns(sc, targets));
  await guard(res, '動能新股進場審查', () => momPreview(sc));
  // 月報當天才進榜、要法庭的：月報之後開法庭與進場前回看（momentum_ai §3.2）
  await guard(res, '動能新股進場審查（月報當天才進榜的）', () => momLateStart(sc));
  await guard(res, '崩盤規則檢視', () => startCrashRuns(sc));
  await guard(res, '減半檢視、個股自身大跌與大跌說明', () => startDropRuns(sc));
  // 提前審查（own_thesis §2.4）：規則段與之前的掃描標到的可提前事件、上面剛寫的個股自身大跌；放在其他自選審查之後（今天已經開了的不另開）
  await guard(res, '提前審查', () => startEarlyReviews(sc));
  await guard(res, '策略檢討說明', () => startStrategyRun(sc));
  return res;
}
