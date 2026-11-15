// T11：F18 每日事件掃描、F19 持股硬事件（每日流程的 AI 段，src/app/aiStep.ts 呼叫）。
//
// 規則段（每個新的交易日，不用 LLM）：持股與排名 6～10 的候選股的新申報 → 分類（src/data/secEvents.ts）→ sec_events
//   動能持股是被收購方、持股的 NT 10-K／10-Q → 規則直接提出提早出場（當天通知，使用者確認；不跑法庭）
//   4.02、會計師辭任、自選股是被收購方 → 等著開法庭（F19）
//   候選股的命中 → 只記錄（下一次 F1 審查會自己重新分類）
//   事件的類別與細項（T28，own_thesis §2.2、§2.3）：8-K 的 Item 編號、13D、5.02 的執行長與財務長離任；
//     自選股、細項可提前審查 → NEW（等提前審查，T29b）；其餘 → INFO
// LLM 段（雲端排程設定好才開）：
//   F18 掃描（Haiku，一票）：規則分不出輕重的 8-K 與新聞標題 → 事件類別與細項；持股的 _CANDIDATE → 開法庭；候選股的 → 下一次 F1 看得到
//     標記分開（scan8k、news 記時間）、有合格結論才往前推、沒有結論時 01:30 重掃、連續 2 次失敗告警（own_thesis §2.6）
//   F19 法庭（3 票）：一致建議出場 → 當天通知（只限 PENDING_MA、ACCOUNTING、REGULATORY）
//     什麼時候開、IN_COURT、沒有結論時重開與告警（HARD_COURT_FAILED）、轉交事件的原文、動能持股 180 天只通知一次（momentum_ai §3.5，T32c）
import { CANDIDATE_CODE, EVENT_SCAN, HARD_EVENT, eventScanPack, hardDecision, hardEventPack, scanEvents, scanQualified, type HardCode, type HardEventRef, type ScanBatchItem, type ScanCondition, type ScanCursors, type ScanTarget } from '../ai/events';
import type { EvidencePack, PackDoc } from '../ai/check';
import { newRunId } from '../ai/pack';
import { hardEvent, hardToldDays } from '../engine';
import { fetchCompanyFacts, fetchFilingDoc, fetchHeadlines, quarterTable } from '../data/edgar';
import { SCAN_ITEMS, classifyFilings, fetchPrimaryText, isAdvanceable, type FilingHit } from '../data/secEvents';
import type { Filing } from '../data/sources';
import { loadRanking, type Alert } from '../data/store';
import { errText } from '../data/util';
import type { ApplyCtx, StartCtx } from './aiCtx';
import { closeStaleRuns, getRun, startRun, type AiRun } from './aiRuns';
import type { Env, Fetcher } from './env';
import { accOf, fetchFilingChecks, handledStmt, insertHitStmts, loadEvents, setStateStmt, type FilingCheck, type SecEventRow } from './filings';
import { docOf, newsDoc, xbrlDoc } from './ownAi';
import { fileConditions, filePremises, thesisFile } from './thesis';

/** 每日掃描的對象：自選、動能持股、排名 6～10 的候選（還沒持有的）。 */
export async function scanTargets(db: D1Database, acct: { own: Record<string, unknown>; rule: { heldMom: string[] }; lots: { mom: Record<string, number> } }): Promise<ScanTarget[]> {
  const out = new Map<string, ScanTarget>();
  for (const t of Object.keys(acct.own)) out.set(t, { ticker: t, role: 'OWN' });
  for (const t of new Set([...acct.rule.heldMom, ...Object.keys(acct.lots.mom).filter((t) => acct.lots.mom[t] > 0)])) if (!out.has(t)) out.set(t, { ticker: t, role: 'MOM' });
  const r = await loadRanking(db);
  for (const t of r?.order.slice(5, 10) ?? []) if (!out.has(t)) out.set(t, { ticker: t, role: 'CAND' });
  return [...out.values()];
}

// ---------------------------------------------------------------- 規則段

export interface Classified {
  ticker: string;
  role: ScanTarget['role'];
  hits: FilingHit[];
}

/** 新申報 → 命中（要讀封面的才抓原文）。 */
export async function classifyFresh(env: Env, fetcher: Fetcher, checks: FilingCheck[], targets: ScanTarget[], log: string[]): Promise<Classified[]> {
  const role = new Map(targets.map((t) => [t.ticker, t.role]));
  const out: Classified[] = [];
  for (const c of checks) {
    if (!c.fresh.length || !role.has(c.ticker)) continue;
    const hits = await classifyFilings(fetcher, c.cik, c.names, c.fresh, env.EDGAR_USER_AGENT!, log, { events: true });
    if (hits.length) out.push({ ticker: c.ticker, role: role.get(c.ticker)!, hits });
  }
  return out;
}

const WINDOW_DAYS: Record<string, number> = { PENDING_MA: 365, ACCOUNTING: 180 };

/**
 * 規則段的結果寫進 sec_events；持股的「規則直接提出」→ 當天通知（同一檔同一類 180 天內只提一次，被收購 365 天）。
 * 在套用的那一筆存檔裡做（和帳戶一起存）。
 */
export async function applyRuleEvents(ctx: ApplyCtx, classified: Classified[]): Promise<void> {
  const at = ctx.now.toISOString();
  for (const c of classified) {
    const held = c.role !== 'CAND';
    const own = c.role === 'OWN' && (ctx.acct.lots.own[c.ticker] ?? 0) > 0;
    const mom = (ctx.acct.lots.mom[c.ticker] ?? 0) > 0 || ctx.acct.rule.heldMom.includes(c.ticker);
    const direct = (h: FilingHit) => held && h.byRule && !h.displayOnly && ((h.code === 'ACCOUNTING' && h.sub.startsWith('NT_')) || (h.code === 'PENDING_MA' && mom && !own));
    const court = (h: FilingHit) => held && !h.displayOnly && !direct(h) && (!h.byRule || h.code === 'PENDING_MA');
    // 自選股、細項可以提前審查（own_thesis §2.3 最後一段）→ NEW，等提前審查；動能持股與候選股只記錄
    const early = (h: FilingHit) => c.role === 'OWN' && isAdvanceable(h.code, h.detailCode);
    ctx.stmts.push(...insertHitStmts(ctx.db, c.ticker, c.hits, 'EDGAR', at, (h) => (direct(h) ? 'HANDLED' : court(h) || early(h) ? 'NEW' : 'INFO')));
    for (const h of c.hits.filter(direct)) {
      const since = new Date(Date.parse(ctx.session) - (WINDOW_DAYS[h.code] ?? 180) * 86400_000).toISOString().slice(0, 10);
      const before = (await loadEvents(ctx.db, { ticker: c.ticker, since, status: 'HANDLED' })).filter((e) => e.code === h.code && e.accession !== h.accession);
      if (before.length) {
        ctx.log.push(`${c.ticker} ${h.sub}：${since} 以後已經提過同一類，不再通知`);
        continue;
      }
      const r = hardEvent(ctx.acct, ctx.view, c.ticker, h.code as HardCode, true);
      ctx.acct = r.acct;
      ctx.log.push(`${c.ticker} ${h.sub}（${h.detail}）→ 規則直接提出${r.notif ? `，當天通知 #${r.notif.id}` : '（沒有持股，不通知）'}`);
    }
  }
}

// ---------------------------------------------------------------- 套用 LLM 的結論

/**
 * F19 法庭的結論（momentum_ai §3.5「法庭沒有結論時」，自選與動能共用；closeStaleRuns 關掉的執行也會進來）：
 *   有結論（三票一致：AGREED、INSUFFICIENT）→ 那批 IN_COURT 的事件標 HANDLED（「法庭 <run_id>：EXIT／HOLD／INSUFFICIENT」），失敗次數歸零
 *   票數不一致 → 算跑完了，不重開（HANDLED：「法庭 <run_id>：票數不一致，照規則」），失敗次數歸零
 *   沒有結論（逾時、沒觸發成功、整份退回、三票格式都不合格、資料缺漏）→ 事件標回 NEW（下一次 startCourts 重開）、
 *     court:fails:<代號> 加 1，連續 2 次起每次推 HARD_COURT_FAILED
 *   3 票一致建議出場 → 當天通知（自選加上硬事件標記；動能持股同一檔同一類 180 天內只通知一次，被收購 365 天）
 */
export async function applyHardEvent(ctx: ApplyCtx, run: AiRun): Promise<void> {
  const t = run.ticker ?? '';
  const o = run.outcome;
  const status = o?.status ?? 'NO_RESULT';
  const evs = (await ctx.db.prepare("SELECT * FROM sec_events WHERE status = 'IN_COURT' AND handled_note = ? ORDER BY event_date, id").bind(run.runId).all<SecEventRow>()).results;
  const ids = evs.map((e) => e.id);
  if (status !== 'AGREED' && status !== 'INSUFFICIENT' && status !== 'SPLIT') {
    const why = courtFailWhy(o);
    if (ids.length) ctx.stmts.push(ctx.db.prepare(`UPDATE sec_events SET status = 'NEW', handled_note = ? WHERE id IN (${ids.map(() => '?').join(',')})`).bind(`法庭 ${run.runId} 沒有結論（${why}），等重開`, ...ids));
    const n = await courtFailStmts(ctx, t, evs, run.runId, why);
    ctx.log.push(`${run.runId}：${t} 的硬事件法庭沒有結論（${why}）；事件回到待處理，下一次流程重開（連續第 ${n} 次）`);
    return;
  }
  if (ids.length) ctx.stmts.push(handledStmt(ctx.db, ids, status === 'SPLIT' ? `法庭 ${run.runId}：票數不一致，照規則` : `法庭 ${run.runId}：${o!.verdict ?? status}`));
  courtFailsClear(ctx, t);
  const d = hardDecision(o!);
  if (!d.exit || !d.code) return void ctx.log.push(`${run.runId}：${t} 不建議出場（${d.why}）`);
  const held = (ctx.acct.lots.own[t] ?? 0) > 0 || (ctx.acct.lots.mom[t] ?? 0) > 0;
  if (!held) return void ctx.log.push(`${run.runId}：${t} 已經沒有持股，不通知`);
  const r = hardEvent(ctx.acct, ctx.view, t, d.code, false, [run.runId]);
  ctx.acct = r.acct;
  if (r.momToldOn) ctx.log.push(`${t} ${d.code}：${r.momToldOn.slice(5)} 已經通知過，${hardToldDays(d.code)} 天內不再通知（結論在 AI 紀錄）`);
  if (r.notif) ctx.log.push(`${run.runId}：${t} ${d.code} → AI 建議提早出場，當天通知 #${r.notif.id}${r.momToldOn ? '（只有自選那一項）' : ''}`);
}

// ---------------------------------------------------------------- 硬事件法庭的失敗次數（momentum_ai §3.5）

/** flow_state 的鍵：這一檔的硬事件法庭連續沒有結論的次數與每次的執行編號、原因。 */
export const courtFailsKey = (ticker: string) => `court:fails:${ticker}`;
/** 連續幾次沒有結論開始推告警。 */
export const COURT_ALERT_AFTER = 2;

export interface CourtFails {
  count: number;
  fails: { runId: string; why: string; at: string }[];
  /** 最近一次失敗時那批事件的說明（「8-K 2027-01-06 Item 4.02」）。 */
  events: string[];
}

export async function loadCourtFails(db: D1Database, ticker: string): Promise<CourtFails | null> {
  const v = await stateOf(db, courtFailsKey(ticker));
  if (!v) return null;
  try {
    const j = JSON.parse(v) as Partial<CourtFails>;
    return { count: Number(j.count) || 0, fails: Array.isArray(j.fails) ? j.fails : [], events: Array.isArray(j.events) ? j.events : [] };
  } catch {
    return null;
  }
}

/** 一件事件給人讀的樣子：申報「8-K 2027-01-06 Item 4.02」、新聞標題「新聞標題 2027-01-06」、轉交的「AI 轉交 2027-01-06」。 */
export function courtEventLabel(e: Pick<SecEventRow, 'form' | 'event_date' | 'sub' | 'accession'>): string {
  if (accOf(e.accession).kind === 'NEWS' || e.form === 'NEWS') return `新聞標題 ${e.event_date}`;
  if (e.form === 'AI') return `AI 轉交 ${e.event_date}`;
  const item = /8K_(\d\.\d\d)/.exec(e.sub)?.[1];
  return `${e.form} ${e.event_date}${item ? ` Item ${item}` : ''}`;
}

/** HARD_COURT_FAILED 的文字。expired：事件超過 10 天、停止重試時的那一則。 */
export function courtFailText(ticker: string, n: number, events: string[], expired = false): string {
  const what = events.length ? `（${events.join('、')}）` : '';
  if (expired) return `${ticker} 的硬事件法庭連續 ${n} 次沒有結論${what}，事件建立已經超過 ${EVENT_EXPIRE_DAYS} 天，已經停止重試。規則沒有動作，這件事沒有被 AI 看過。`;
  return `${ticker} 的硬事件法庭連續 ${n} 次沒有結論${what}。規則沒有動作，這件事還沒有被 AI 看過；下一次流程會重開。`;
}

const courtFailWhy = (o: AiRun['outcome']): string => {
  if (!o) return '沒有結果';
  const label: Record<string, string> = { TIMEOUT: '逾時', NO_RESULT: '沒有結果', INVALID: '三票格式都不合格', DATA_MISSING: '資料缺漏' };
  return o.status === 'NO_RESULT' && /觸發/.test(o.reason) ? '沒觸發成功' : o.status === 'NO_RESULT' && /退回/.test(o.reason) ? '結果被退回' : (label[o.status] ?? o.status);
};

/** 同一次套用裡已經算過的失敗次數（同一檔兩次結論在同一次套用時不重讀資料庫）。 */
const courtSeen = new WeakMap<object, Map<string, CourtFails | null>>();

async function courtFailStmts(ctx: ApplyCtx, ticker: string, evs: SecEventRow[], runId: string, why: string): Promise<number> {
  const seen = courtSeen.get(ctx) ?? new Map<string, CourtFails | null>();
  courtSeen.set(ctx, seen);
  const prev = seen.has(ticker) ? seen.get(ticker)! : await loadCourtFails(ctx.db, ticker);
  const events = evs.length ? evs.map(courtEventLabel) : (prev?.events ?? []);
  const next: CourtFails = { count: (prev?.count ?? 0) + 1, fails: [...(prev?.fails ?? []), { runId, why, at: ctx.now.toISOString() }].slice(-10), events };
  seen.set(ticker, next);
  ctx.stmts.push(setStateStmt(ctx.db, courtFailsKey(ticker), JSON.stringify(next), ctx.now.toISOString()));
  if (next.count >= COURT_ALERT_AFTER) (ctx.alerts ??= []).push({ kind: 'HARD_COURT_FAILED', message: courtFailText(ticker, next.count, events), detail: { ticker, count: next.count, runId, fails: next.fails } });
  return next.count;
}

function courtFailsClear(ctx: ApplyCtx, ticker: string): void {
  const seen = courtSeen.get(ctx) ?? new Map<string, CourtFails | null>();
  courtSeen.set(ctx, seen);
  seen.set(ticker, null);
  ctx.stmts.push(ctx.db.prepare('DELETE FROM flow_state WHERE key = ?').bind(courtFailsKey(ticker)));
}

/**
 * F18 掃描（own_thesis §2.2、§2.5、§2.6）：
 *   沒有合格結論（逾時、觸發失敗、整份退回、每一票格式都不合格）→ 標記不動、失敗次數加 1（連續 2 次起推 SCAN_FAILED）
 *   合格 → 事件寫進 sec_events、兩個標記推到 cursors、失敗次數歸零：
 *     _CANDIDATE → NEW（持股開法庭，候選股留給下一次 F1）
 *     自選股、申報原文、細項可以提前審查（執行長或財務長離任、財測下修或撤回）→ NEW（等提前審查）；其餘 INFO
 *     標到條件 → 每一條一筆 CONDITION_HINT（細項 = 條件的列編號）：申報原文 → NEW，新聞標題 → INFO
 */
export async function applyEventScan(ctx: ApplyCtx, run: AiRun): Promise<void> {
  const detail = (run.pack.rule.detail ?? {}) as { targets?: ScanTarget[]; cursors?: ScanCursors; batch?: ScanBatchItem[]; conds?: Record<string, number> };
  const at = ctx.now.toISOString();
  if (!run.outcome || !scanQualified(run.outcome)) {
    const n = await scanFailStmts(ctx, run.asOf, detail.batch ?? [], run.runId, at);
    ctx.log.push(`${run.runId}：每日掃描沒有結論（${run.outcome?.reason ?? '沒有結果'}）；標記不動，下一次重掃（連續第 ${n} 次）`);
    return;
  }
  const events = scanEvents(run.outcome, run.pack);
  const role = new Map((detail.targets ?? []).map((t) => [t.ticker, t.role]));
  // 條件的列編號 → 哪一檔、給人讀的名稱（證據包的 K 開頭）
  const condOf = new Map<number, { ticker: string; label: string }>();
  for (const f of run.pack.facts) if (detail.conds?.[f.id] !== undefined) condOf.set(detail.conds[f.id], { ticker: f.label.split(' ')[0], label: f.label });
  let hints = 0;
  for (const e of events) {
    const code = CANDIDATE_CODE[e.cls];
    const filing = accOf(e.sourceId).kind === 'FILING';
    const own = role.get(e.ticker) === 'OWN';
    const early = !code && own && filing && isAdvanceable(e.cls, e.sub);
    const base = { accession: e.sourceId, form: filing ? '8-K' : 'NEWS', date: e.date, acceptedAt: '', byRule: false };
    const hit: FilingHit = { ...base, code: code ?? e.cls, ...(e.sub ? { detailCode: e.sub } : {}), sub: `SCAN_${e.cls}`, displayOnly: !code, detail: `每日掃描標記：${e.cls}${e.sub ? `（${e.sub}）` : ''}${e.conditionIds.length ? `；可能和 ${e.conditionIds.join('、')} 有關（等申報原文證實）` : ''}` };
    ctx.stmts.push(...insertHitStmts(ctx.db, e.ticker, [hit], 'SCAN', at, () => (code || early ? 'NEW' : 'INFO')));
    for (const row of e.conditionRows) {
      const c = condOf.get(row);
      if (!c || c.ticker !== e.ticker) continue;
      const hint: FilingHit = { ...base, code: 'CONDITION_HINT', detailCode: String(row), sub: `SCAN_CONDITION_HINT_${row}`, displayOnly: false, detail: `每日掃描：可能和${c.label.slice(c.ticker.length + 1)}有關（${filing ? '申報原文，下一次審查由三票判斷成不成立' : '只有新聞標題，只記錄'}）` };
      ctx.stmts.push(...insertHitStmts(ctx.db, e.ticker, [hint], 'SCAN', at, () => (own && filing ? 'NEW' : 'INFO')));
      hints++;
    }
  }
  // 兩個標記推到這次看到的最新一份（只往前、不往回）；失敗次數歸零
  for (const [t, c] of Object.entries(detail.cursors ?? {})) {
    if (c.scan8k) ctx.stmts.push(advanceStmt(ctx.db, `scan8k:${t}`, c.scan8k, at));
    if (c.news) ctx.stmts.push(advanceStmt(ctx.db, `news:${t}`, c.news, at));
  }
  ctx.stmts.push(ctx.db.prepare('DELETE FROM flow_state WHERE key = ?').bind(SCAN_FAILS));
  failsSeen.set(ctx, null);
  ctx.log.push(`${run.runId}：每日掃描標記 ${events.length} 件${events.length ? `（${events.map((e) => `${e.ticker} ${e.cls}${e.sub ? `/${e.sub}` : ''}`).join('、')}）` : ''}${hints ? `，條件提示 ${hints} 筆` : ''}`);
}

// ---------------------------------------------------------------- 每日掃描的標記與失敗次數（own_thesis §2.6）

/** flow_state 的鍵：連續沒有合格結論的次數與最近一批文件。 */
export const SCAN_FAILS = 'scan:fails';
/** 一次掃描最多讀幾份 8-K 原文（所有對象合計；裝不下的留到下一次）。 */
export const SCAN_MAX_FILINGS = 10;
/** 每檔一次最多幾則新聞標題（取最新的；較舊的略過，不排隊）。 */
export const SCAN_MAX_NEWS = 30;
/** 連續幾次沒有結論開始推告警。 */
export const SCAN_ALERT_AFTER = 2;

export interface ScanFails {
  count: number;
  /** 最近一次失敗的那一批是哪一個交易日的掃描。 */
  session: string;
  batch: ScanBatchItem[];
  runId: string | null;
}

const stateOf = async (db: D1Database, key: string) => (await db.prepare('SELECT value FROM flow_state WHERE key = ?').bind(key).first<{ value: string }>())?.value ?? null;

export async function loadScanFails(db: D1Database): Promise<ScanFails | null> {
  const v = await stateOf(db, SCAN_FAILS);
  if (!v) return null;
  try {
    const j = JSON.parse(v) as Partial<ScanFails>;
    return { count: Number(j.count) || 0, session: String(j.session ?? ''), batch: Array.isArray(j.batch) ? j.batch : [], runId: j.runId ?? null };
  } catch {
    return null;
  }
}

/** 標記只往前推：新的值比較新才寫（acceptedAt 與標題時間都是 ISO 時間）。 */
const advanceStmt = (db: D1Database, key: string, value: string, at: string) =>
  db.prepare('INSERT INTO flow_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at WHERE excluded.value > flow_state.value').bind(key, value, at);

/** 舊的 news 標記是日期（T28 之前）：當成那一天的 23:59:59Z。 */
export function newsCursorMs(v: string | null | undefined): number | null {
  if (!v) return null;
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T23:59:59Z` : v);
  return Number.isNaN(t) ? null : t;
}

/** SCAN_FAILED 的文字。 */
export function scanFailText(n: number, batch: ScanBatchItem[]): string {
  const docs = batch.map((b) => b.label);
  return `每日掃描連續 ${n} 次沒有結論${docs.length ? `：${docs.join('、')}還沒有被 AI 看過` : ''}。規則分類照常；下一次流程會重掃。`;
}

/** 同一次套用裡已經算過的失敗次數（同一次套用兩份掃描時不重讀資料庫）。 */
const failsSeen = new WeakMap<object, ScanFails | null>();

/**
 * 一次沒有合格結論：失敗次數加 1（和這批文件一起存），連續 2 次起每次推告警。回傳這是連續第幾次。
 * 套用時（和帳戶同一筆存檔）語句放 ctx.stmts、告警放 ctx.alerts；開掃描失敗時（startRun 丟錯）直接寫、告警放 res.alerts。
 */
async function scanFailStmts(ctx: Pick<ApplyCtx, 'db' | 'stmts' | 'alerts'> | { db: D1Database; direct: Alert[] }, session: string, batch: ScanBatchItem[], runId: string | null, at: string): Promise<number> {
  const prev = failsSeen.has(ctx) ? failsSeen.get(ctx)! : await loadScanFails(ctx.db);
  const next: ScanFails = { count: (prev?.count ?? 0) + 1, session, batch, runId };
  failsSeen.set(ctx, next);
  const stmt = setStateStmt(ctx.db, SCAN_FAILS, JSON.stringify(next), at);
  const alert: Alert | null = next.count >= SCAN_ALERT_AFTER ? { kind: 'SCAN_FAILED', message: scanFailText(next.count, batch), detail: { runId, session, count: next.count } } : null;
  if ('direct' in ctx) {
    await stmt.run();
    if (alert) ctx.direct.push(alert);
  } else {
    ctx.stmts.push(stmt);
    if (alert) (ctx.alerts ??= []).push(alert);
  }
  return next.count;
}

// ---------------------------------------------------------------- 開新的執行

const isNewsEvent = (e: SecEventRow) => accOf(e.accession).kind === 'NEWS' || e.form === 'NEWS';
const HARD_CODES = ['PENDING_MA', 'ACCOUNTING', 'REGULATORY'];
/** 待處理的事件建立超過這麼多個日曆天就不開法庭，標成已處理（momentum_ai §3.5）。 */
export const EVENT_EXPIRE_DAYS = 10;

/** 這一檔有結論的硬事件法庭（三票一致：AGREED、INSUFFICIENT），新到舊：代碼與證據包裡的申報原文。 */
interface PriorCourt {
  runId: string;
  codes: string[];
  filings: Set<string>;
}
async function priorCourts(db: D1Database, ticker: string): Promise<PriorCourt[]> {
  const rows = (await db.prepare("SELECT run_id, pack, outcome FROM ai_runs WHERE fn = ? AND ticker = ? AND status = 'DONE' ORDER BY created_at DESC LIMIT 50").bind(HARD_EVENT, ticker).all<{ run_id: string; pack: string; outcome: string | null }>()).results;
  const out: PriorCourt[] = [];
  for (const r of rows) {
    try {
      const o = r.outcome ? (JSON.parse(r.outcome) as { status?: string }) : null;
      if (o?.status !== 'AGREED' && o?.status !== 'INSUFFICIENT') continue;
      const pack = JSON.parse(r.pack) as EvidencePack;
      out.push({ runId: r.run_id, codes: ((pack.rule.detail as { codes?: string[] } | undefined)?.codes ?? []).map(String), filings: new Set(pack.documents.filter((d) => d.kind === 'filing').map((d) => d.source_id)) });
    } catch {
      // 讀不懂的舊紀錄當成沒有
    }
  }
  return out;
}

/** 轉交來的事件（form = 'AI'，accession 是那次執行的編號）：原文取自那次執行的證據包裡 kind 是 filing 的文件（修 Q14）。 */
async function forwardedDocs(db: D1Database, e: SecEventRow): Promise<PackDoc[]> {
  if (e.form !== 'AI') return [];
  const run = await getRun(db, e.accession).catch(() => null);
  return (run?.pack.documents ?? []).filter((d) => d.kind === 'filing');
}

/**
 * 持股的待處理事件 → 開 F19 法庭（momentum_ai §3.5「法庭什麼時候開」，自選與動能共用）。對每一檔的 NEW 事件照順序：
 *   建立超過 10 個日曆天 → 不開，標 HANDLED（過期）；這一檔有失敗紀錄的再推一次 HARD_COURT_FAILED（已經停止重試）
 *   這一檔同一個代碼已經有一次有結論的法庭，而且事件只來自新聞標題 → 不開，標 HANDLED（「已有 <run_id> 的結論，新聞標題不重開」）
 *     申報已經在上次法庭的證據包裡 → 同樣不開
 *   有申報來的、而且那份申報不在上次法庭的證據包裡；或從來沒有過有結論的法庭 → 開。事件標 IN_COURT、handled_note 寫 <run_id>
 * 同一檔一次一個法庭：還有一次在等結果（或結果還沒套用）就先不開，事件留著 NEW。
 * 轉交來的事件（form = 'AI'）：原文取自那次執行的證據包裡的申報。
 * fetchChecks：這次流程沒有看新申報（01:30 的 finalStarts，sc.checks 是空的）時，有申報類事件的那幾檔另外抓申報清單來取原文；
 * 只抓清單、不推「看過」的標記。
 * 動能持股的證據之後改用 momEvidence（T32b 才有）；這裡照舊用 accOf 取申報原文。
 */
export async function startCourts(sc: StartCtx, targets: ScanTarget[], opt: { fetchChecks?: boolean } = {}): Promise<void> {
  const { env, fetcher, acct, view, axis, session, now, res } = sc;
  const role = new Map(targets.map((t) => [t.ticker, t.role]));
  const fresh: SecEventRow[] = [];
  const expired: SecEventRow[] = [];
  for (const e of (await loadEvents(env.DB, { status: 'NEW' })).filter((x) => HARD_CODES.includes(x.code))) (now.getTime() - Date.parse(e.created_at) > EVENT_EXPIRE_DAYS * 86400_000 ? expired : fresh).push(e);
  if (expired.length) {
    await handledStmt(env.DB, expired.map((e) => e.id), `過期：建立超過 ${EVENT_EXPIRE_DAYS} 天沒有處理`).run();
    res.log.push(`待處理的事件過期（建立超過 ${EVENT_EXPIRE_DAYS} 天）：${expired.map((e) => `${e.ticker} ${e.sub}`).join('、')}`);
    // 法庭一直沒有結論、事件過期了：再推一次告警（已經停止重試）；這一檔沒有別的待處理事件就清掉失敗次數
    for (const t of new Set(expired.map((e) => e.ticker))) {
      const f = await loadCourtFails(env.DB, t);
      if (!f || f.count < 1) continue;
      const evs = expired.filter((e) => e.ticker === t).map(courtEventLabel);
      res.alerts.push({ kind: 'HARD_COURT_FAILED', message: courtFailText(t, f.count, evs, true), detail: { ticker: t, count: f.count, expired: true, fails: f.fails } });
      if (!fresh.some((e) => e.ticker === t)) await env.DB.prepare('DELETE FROM flow_state WHERE key = ?').bind(courtFailsKey(t)).run();
    }
  }
  const pending = fresh.filter((e) => role.get(e.ticker) && role.get(e.ticker) !== 'CAND');
  const byTicker = new Map<string, SecEventRow[]>();
  for (const e of pending) byTicker.set(e.ticker, [...(byTicker.get(e.ticker) ?? []), e]);
  const busy = new Set((await env.DB.prepare("SELECT DISTINCT ticker FROM ai_runs WHERE fn = ? AND (status = 'PENDING' OR applied_at IS NULL)").bind(HARD_EVENT).all<{ ticker: string | null }>()).results.map((r) => r.ticker));
  for (const [t, all] of byTicker) {
    if (busy.has(t)) {
      res.log.push(`${t} 的硬事件法庭還在等結果，新的事件留到下一次（${all.map((e) => e.sub).join('、')}）`);
      continue;
    }
    // 開不開（有結論之後只有新的申報才重開）
    const prior = await priorCourts(env.DB, t);
    const fwd = new Map<number, PackDoc[]>();
    const skip = new Map<string, number[]>();
    const evs: SecEventRow[] = [];
    for (const e of all) {
      const fd = e.form === 'AI' ? await forwardedDocs(env.DB, e) : [];
      if (fd.length) fwd.set(e.id, fd);
      const prev = prior.find((p) => p.codes.includes(e.code));
      if (!prev) {
        evs.push(e);
        continue;
      }
      const ref = accOf(e.accession);
      const sources = ref.kind === 'FILING' ? [`edgar:${ref.acc}`] : fd.map((d) => d.source_id);
      if (sources.some((x) => !prev.filings.has(x))) {
        evs.push(e);
        continue;
      }
      const note = sources.length ? `已有 ${prev.runId} 的結論，申報已經看過，不重開` : isNewsEvent(e) ? `已有 ${prev.runId} 的結論，新聞標題不重開` : `已有 ${prev.runId} 的結論，沒有新的申報，不重開`;
      skip.set(note, [...(skip.get(note) ?? []), e.id]);
    }
    for (const [note, ids] of skip) {
      await handledStmt(env.DB, ids, note).run();
      res.log.push(`${t}：${note}`);
    }
    if (!evs.length) continue;

    let check = sc.checks.find((c) => c.ticker === t);
    if (!check && opt.fetchChecks && env.EDGAR_USER_AGENT && evs.some((e) => accOf(e.accession).kind === 'FILING')) check = (await fetchFilingChecks(env, fetcher, [t], session, res.log))[0];
    const docs: PackDoc[] = [];
    const dq: Record<string, 'ok' | 'partial' | 'missing'> = {};
    // 有要讀申報原文的事件（申報、轉交）時才記申報有沒有缺；只有新聞標題的不算缺漏（否則三票一致「不動」會變成資料缺漏、一直重開）
    let wantFiling = false;
    try {
      for (const e of evs) {
        if (isNewsEvent(e)) {
          const n = await newsDoc(fetcher, t, session).catch(() => null);
          if (n && !docs.some((d) => d.source_id === n.source_id)) docs.push(n);
          dq.news = 'partial';
          continue;
        }
        if (e.form === 'AI') {
          wantFiling = true;
          for (const d of fwd.get(e.id) ?? []) if (!docs.some((x) => x.source_id === d.source_id || x.id === d.id)) docs.push(d);
          continue;
        }
        const ref = accOf(e.accession);
        if (ref.kind !== 'FILING') continue;
        wantFiling = true;
        const acc = ref.acc;
        const f = check?.all.find((x) => x.accession === acc);
        if (!f || !check) continue;
        if (docs.some((d) => d.source_id === `edgar:${acc}`)) continue;
        if (f.form.startsWith('8-K')) docs.push(docOf(await fetchFilingDoc(fetcher, check.cik, f, env.EDGAR_USER_AGENT!)));
        else {
          const p = await fetchPrimaryText(fetcher, check.cik, f, env.EDGAR_USER_AGENT!, 40_000);
          docs.push({ id: `F-${acc}`, source_id: `edgar:${acc}`, kind: 'filing', date: f.filingDate, title: `${f.form} ${f.filingDate}（開頭）`, url: p.url, text: p.text });
        }
      }
      if (wantFiling || docs.some((d) => d.kind === 'filing')) dq.filings = docs.some((d) => d.kind === 'filing') ? 'ok' : 'missing';
      let xbrl: PackDoc | null = null;
      if (check) {
        try {
          xbrl = xbrlDoc(t, quarterTable(await fetchCompanyFacts(fetcher, check.cik, env.EDGAR_USER_AGENT!), session));
          dq.xbrl = xbrl ? 'ok' : 'missing';
        } catch (e) {
          dq.xbrl = 'missing';
          res.log.push(`${t} 的 XBRL 抓不到：${errText(e)}`);
        }
      }
      const refs: HardEventRef[] = evs.map((e) => ({ code: e.code, sub: e.sub, form: e.form, date: e.event_date, detail: e.detail, source: e.source }));
      const own = (acct.lots.own[t] ?? 0) > 0 && !!acct.own[t];
      // 自選股的前提由論點檔取（T25）
      const tf = own ? await thesisFile(env.DB, acct, t, session) : null;
      const ownPremises = tf ? filePremises(tf) : undefined;
      const { pack, notes } = hardEventPack({ acct, view, axis, ticker: t, runId: newRunId(session, HARD_EVENT, t), role: own ? 'OWN' : 'MOM', events: refs, docs, xbrl, dataQuality: dq, ...(ownPremises ? { ownPremises } : {}), now });
      const run = await startRun(env, fetcher, pack, now, notes);
      res.started.push(run.runId);
      await inCourtStmt(env.DB, evs.map((e) => e.id), run.runId).run();
    } catch (e) {
      res.log.push(`${t} 的硬事件法庭沒有開成：${errText(e)}`);
    }
  }
}

/** 交給法庭的事件：IN_COURT，handled_note 寫執行編號（applyHardEvent 用它找回這批事件）。 */
const inCourtStmt = (db: D1Database, ids: number[], runId: string) => db.prepare(`UPDATE sec_events SET status = 'IN_COURT', handled_note = ? WHERE id IN (${ids.map(() => '?').join(',')})`).bind(runId, ...ids);

const msOf = (iso: string | null | undefined) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? -Infinity : t;
};

/**
 * scan8k 標記沒有值時的起點（不追溯）：當時的 edgar 標記，也就是這次新申報（fresh）之前看過的最新一份。
 * 第一次看申報（沒有 edgar 標記、fresh 是空的）時就是最新的一份。
 */
export function scanBase(c: Pick<FilingCheck, 'all' | 'fresh'>, stored: string | null): string {
  if (stored) return stored;
  const fresh = new Set(c.fresh.map((f) => f.accession));
  return c.all.filter((f) => !fresh.has(f.accession)).reduce((m, f) => (msOf(f.acceptedAt) > msOf(m) ? f.acceptedAt : m), '');
}

/** 要掃的 8-K：acceptedAt 比標記新、有 SCAN_ITEMS 裡的項目（從全部申報裡找，不是只看當天新的），由舊到新。 */
export function pendingScanFilings(all: Filing[], base: string): Filing[] {
  return all.filter((f) => f.form.startsWith('8-K') && f.items.some((i) => SCAN_ITEMS.includes(i)) && msOf(f.acceptedAt) > msOf(base)).sort((a, b) => msOf(a.acceptedAt) - msOf(b.acceptedAt));
}

const items = (f: Filing) => (f.items.length ? `（Item ${f.items.join('、')}）` : '');

/**
 * F18 掃描（own_thesis §2.6 的收集）：規則分不出輕重的 8-K、新的新聞標題 → 一份證據包（有東西才開）。
 *   8-K：每個對象 scan8k 之後、有 SCAN_ITEMS 項目的申報，由舊到新，一次最多 10 份原文（所有對象合計），裝不下的留到下一次
 *   新聞：每檔發布時間比 news 標記新的標題，最多取最新的 30 則，較舊的略過（證據包的備註寫明）
 *   標記在這裡不動：證據包記下 cursors，有合格結論時才往前推（applyEventScan）
 *   已經有一份掃描在等結果時不開新的；沒開成（startRun 丟錯）算一次失敗
 */
export async function startScan(sc: StartCtx, targets: ScanTarget[]): Promise<boolean> {
  const { env, fetcher, session, now, res } = sc;
  const at = now.toISOString();
  await closeStaleRuns(env.DB, now);
  const waiting = await env.DB.prepare("SELECT run_id FROM ai_runs WHERE fn = ? AND status = 'PENDING' LIMIT 1").bind(EVENT_SCAN).first<{ run_id: string }>();
  if (waiting) {
    res.log.push(`每日掃描：${waiting.run_id} 還在等結果，不開新的`);
    return false;
  }

  const docs: (PackDoc & { ticker: string })[] = [];
  const dq: Record<string, 'ok' | 'partial' | 'missing'> = {};
  const cursors: ScanCursors = {};
  const batch: ScanBatchItem[] = [];
  const notes: string[] = [];
  const isTarget = new Set(targets.map((t) => t.ticker));

  // 8-K：所有對象一起由舊到新排，取前 10 份
  const pending: { c: FilingCheck; f: Filing }[] = [];
  const bases = new Map<string, string>();
  for (const c of sc.checks) {
    if (!isTarget.has(c.ticker)) continue;
    const key = `scan8k:${c.ticker}`;
    const stored = await stateOf(env.DB, key);
    const base = scanBase(c, stored);
    bases.set(c.ticker, base);
    // 第一次：從當時的 edgar 標記開始（不追溯）；起點先記下，01:30 重掃時才接得上
    if (!stored && base) await setStateStmt(env.DB, key, base, at).run();
    pending.push(...pendingScanFilings(c.all, base).map((f) => ({ c, f })));
  }
  pending.sort((a, b) => msOf(a.f.acceptedAt) - msOf(b.f.acceptedAt));
  const included = new Set<string>();
  for (const { c, f } of pending.slice(0, SCAN_MAX_FILINGS)) {
    try {
      docs.push({ ...docOf(await fetchFilingDoc(fetcher, c.cik, f, env.EDGAR_USER_AGENT!)), ticker: c.ticker });
      included.add(f.accession);
      batch.push({ ticker: c.ticker, kind: '8-K', label: `${c.ticker} 的 ${f.form} ${f.filingDate}${items(f)}` });
      dq.filings = 'ok';
    } catch (e) {
      res.log.push(`${c.ticker} ${f.form} ${f.accession} 抓不到：${errText(e)}`);
    }
  }
  const deferred = pending.length - Math.min(pending.length, SCAN_MAX_FILINGS);
  if (deferred) notes.push(`還有 ${deferred} 份 8-K 排在下一次掃描（一次最多 ${SCAN_MAX_FILINGS} 份）`);
  // 每檔的 scan8k 推到「第一份沒讀到的之前」；全部讀到了就推到這檔最新的申報
  for (const c of sc.checks) {
    if (!bases.has(c.ticker)) continue;
    let cur = bases.get(c.ticker)!;
    let gap = false;
    for (const f of pendingScanFilings(c.all, cur)) {
      if (!included.has(f.accession)) {
        gap = true;
        break;
      }
      cur = f.acceptedAt;
    }
    if (!gap && msOf(c.latest) > msOf(cur)) cur = c.latest;
    if (cur && cur !== bases.get(c.ticker)) cursors[c.ticker] = { scan8k: cur };
  }

  // 新聞標題：比 news 標記新的，每檔最多最新 30 則
  for (const t of targets) {
    try {
      const last = newsCursorMs(await stateOf(env.DB, `news:${t.ticker}`));
      const hl = (await fetchHeadlines(fetcher, t.ticker)).filter((h) => h.date <= session && (last === null || msOf(h.at) > last)).sort((a, b) => msOf(b.at) - msOf(a.at));
      dq.news = 'partial';
      if (!hl.length) continue;
      const keep = hl.slice(0, SCAN_MAX_NEWS);
      const skipped = hl.length - keep.length;
      if (skipped) notes.push(`${t.ticker}：略過 ${skipped} 則較舊的標題（一次最多 ${SCAN_MAX_NEWS} 則）`);
      docs.push({ id: `N-${t.ticker}-${session}`, source_id: `nasdaq-rss:${t.ticker}:${session}`, kind: 'news', date: keep[0].date, title: `${t.ticker} 最近的新聞標題（Nasdaq RSS，只有標題）`, text: keep.map((h) => `${h.date} | ${h.title}`).join('\n') + (skipped ? `\n（略過 ${skipped} 則較舊的標題）` : ''), ticker: t.ticker });
      batch.push({ ticker: t.ticker, kind: 'NEWS', label: `${t.ticker} 的 ${keep.length} 則新聞標題` });
      cursors[t.ticker] = { ...cursors[t.ticker], news: hl[0].at };
    } catch {
      dq.news = 'partial';
    }
  }
  if (!docs.length) {
    res.log.push('每日掃描：沒有新的 8-K 或新聞標題，不開');
    return false;
  }

  // 自選股的觀察項（事件類）與只在審查時檢查的條件（own_thesis §2.5）
  const conditions: ScanCondition[] = [];
  for (const t of targets.filter((x) => x.role === 'OWN'))
    for (const c of (await fileConditions(env.DB, sc.acct, t.ticker)).filter((x) => x.kind === 'EVENT' && (x.status === 'PROPOSED' || x.status === 'REVIEW_ONLY')))
      conditions.push({ ticker: t.ticker, condId: c.condId, text: c.text, rowId: c.id, status: c.status as ScanCondition['status'] });
  const runId = newRunId(session, EVENT_SCAN);
  const { pack, notes: packNotes } = eventScanPack({ runId, asOf: session, targets, docs, conditions, cursors, batch, notes, dataQuality: dq, now });
  try {
    res.started.push((await startRun(env, fetcher, pack, now, [...notes, ...packNotes])).runId);
    return true;
  } catch (e) {
    res.log.push(`每日掃描沒有開成：${errText(e)}`);
    // 已經存了執行紀錄的，之後會被照規則結束、套用時算失敗；沒存成的在這裡算一次
    const saved = await env.DB.prepare('SELECT 1 AS x FROM ai_runs WHERE run_id = ?').bind(runId).first();
    if (!saved) await scanFailStmts({ db: env.DB, direct: res.alerts }, session, batch, null, at);
    return false;
  }
}

/**
 * 01:30（schedule.ts 的 finalStarts）：今天的每日掃描沒有合格結論（含逾時、沒開成）→ 重開一次（own_thesis §2.6）。
 * 這次流程沒有看新申報（sc.checks 是空的），對象的申報清單另外抓（只抓清單、不推 edgar 標記）。
 */
export async function rescanEvents(sc: StartCtx, targets: ScanTarget[]): Promise<void> {
  const { env, session, res } = sc;
  const fails = await loadScanFails(env.DB);
  if (!fails || fails.count < 1 || fails.session !== session) return;
  const runs = (await env.DB.prepare('SELECT COUNT(*) AS n FROM ai_runs WHERE fn = ? AND as_of = ?').bind(EVENT_SCAN, session).first<{ n: number }>())?.n ?? 0;
  if (runs >= 2) return void res.log.push('今天的每日掃描已經重掃過，留給下一次流程');
  res.log.push(`今天的每日掃描沒有結論（連續第 ${fails.count} 次）→ 重掃一次`);
  const checks = sc.checks.length || !env.EDGAR_USER_AGENT ? sc.checks : await fetchFilingChecks(env, sc.fetcher, targets.map((t) => t.ticker), session, res.log);
  await startScan({ ...sc, checks }, targets);
}

/** 每日流程的 F18／F19 開執行那一段（掃描的 01:30 重開在 rescanEvents）。 */
export async function startEventRuns(sc: StartCtx, targets: ScanTarget[]): Promise<void> {
  try {
    await startCourts(sc, targets);
  } catch (e) {
    sc.res.log.push(`硬事件法庭出錯：${errText(e)}`);
  }
  try {
    await startScan(sc, targets);
  } catch (e) {
    sc.res.log.push(`每日掃描沒有開成：${errText(e)}`);
  }
}
