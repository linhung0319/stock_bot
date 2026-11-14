// 每日流程的 AI 段（T10、T11）。每次每日流程（src/app/flow.ts）都會呼叫：
//   1. 這次有處理新的交易日（startNew）：持股、候選股的新申報 → 規則分類（F18 規則段）；自選股的新財報 → XBRL
//   2. 套用（和帳戶同一筆存檔，和網站同時存檔時重來）：
//        已經有結論、還沒套用的 AI 執行（各功能的 applier）
//        財報條件（程式比對 XBRL）、規則直接提出的硬事件（動能持股被收購、持股的 NT 10-K／10-Q）
//   3. startNew 而且雲端排程設定好了：開新的執行
//        F25／F24（自選）、F19 法庭與 F18 掃描、F1 否決法庭與擬事件打分（月報前一天）、
//        F5／F6 崩盤規則檢視（月報前一天；切換了卻沒預估到時補開）、F7 減半檢視、F20 大跌說明、F21 策略檢討說明
// 每一段出錯只記在紀錄裡，不擋其他段；規則的部分在這之前已經照常做完。
import { buildMarketView, rebaseNotifSeq } from '../data/marketView';
import type { CalendarOverrides } from '../data/calendar';
import { loadRanking, loadSeries } from '../data/store';
import { errText } from '../data/util';
import { DROP_EXPLAIN, OWN_DROP } from '../ai/drops';
import { EVENT_SCAN, HARD_EVENT } from '../ai/events';
import { MOM_ENTRY } from '../ai/momEntry';
import { OWN_CONDITION, OWN_REVIEW } from '../ai/ownReview';
import type { Applier, ApplyCtx, FlowExtras, StartCtx, StepResult } from './aiCtx';
import { getRun, listRuns } from './aiRuns';
import { startCrashRuns } from './crashAi';
import { applyDropExplain, applyOwnDrop, startDropRuns } from './dropAi';
import type { Env, Fetcher } from './env';
import { applyEventScan, applyHardEvent, applyRuleEvents, classifyFresh, scanTargets, startEventRuns, type Classified } from './events';
import { fetchFilingChecks, markSeen, sectorEtfs, type FilingCheck } from './filings';
import { ConflictError, loadAccount, requiredTickers, saveAccount } from './ledgerStore';
import { applyMomEntry, momPreview } from './momAi';
import { applyOwnCondition, applyOwnReview, ownFacts, ownXbrlConditions, routineReady, startOwnRuns } from './ownAi';
import { noteOfRun } from './site/aiViews';
import { annotate } from './site/explain';
import type { AiNote } from './site/types';
import { startStrategyRun } from './strategyAi';

export type { StepResult as AiStepResult } from './aiCtx';

/** 各功能的結論怎麼套用（沒有登記的功能只標成已套用：擬事件打分、崩盤檢視、策略檢討、健檢只記錄或由別處讀）。 */
export const APPLIERS: Record<string, Applier> = {
  [OWN_REVIEW]: applyOwnReview,
  [OWN_CONDITION]: applyOwnCondition,
  [HARD_EVENT]: applyHardEvent,
  [EVENT_SCAN]: applyEventScan,
  [MOM_ENTRY]: applyMomEntry,
  [OWN_DROP]: applyOwnDrop,
  [DROP_EXPLAIN]: applyDropExplain,
};

async function guard(res: StepResult, label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    console.error(label, e);
    res.log.push(`${label}出錯：${errText(e)}`);
  }
}

export async function aiStep(env: Env, fetcher: Fetcher, now: Date, session: string, ov: CalendarOverrides, startNew: boolean, extras: FlowExtras = {}): Promise<StepResult> {
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
  for (let tryNo = 0; ; tryNo++) {
    const loaded = tryNo === 0 ? first : await loadAccount(db);
    if (!loaded) return res;
    rebaseNotifSeq(loaded.acct, axis);
    const before = new Set(loaded.acct.notifs.map((n) => n.id));
    const ctx: ApplyCtx = { db, acct: loaded.acct, view, axis, session, now, stmts: [], log: [] };
    const done = (await db.prepare("SELECT run_id FROM ai_runs WHERE status = 'DONE' AND applied_at IS NULL ORDER BY completed_at").all<{ run_id: string }>()).results;
    for (const { run_id } of done) {
      const run = await getRun(db, run_id);
      if (!run) continue;
      ctx.stmts.push(db.prepare('UPDATE ai_runs SET applied_at = ? WHERE run_id = ?').bind(now.toISOString(), run_id));
      const apply = APPLIERS[run.fn];
      if (apply) await apply(ctx, run);
    }
    await ownXbrlConditions(ctx, facts);
    await applyRuleEvents(ctx, classified);
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
    break;
  }

  if (!startNew) return res;
  await markSeen(db, checks, now);
  if (!routineReady(env)) {
    res.log.push('雲端排程還沒設定，不開新的 AI 執行');
    return res;
  }

  // 3. 開新的執行
  const acct = (await loadAccount(db))!.acct;
  const sc: StartCtx = { env, fetcher, acct, view, axis, session, ov, now, checks, res, extras };
  await guard(res, '自選審查與條件監測', () => startOwnRuns(sc));
  await guard(res, '硬事件與每日掃描', () => startEventRuns(sc, targets));
  await guard(res, '動能新股進場審查', () => momPreview(sc));
  await guard(res, '崩盤規則檢視', () => startCrashRuns(sc));
  await guard(res, '減半檢視與大跌說明', () => startDropRuns(sc));
  await guard(res, '策略檢討說明', () => startStrategyRun(sc));
  return res;
}
