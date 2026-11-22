// T11：F5／F6 崩盤規則檢視的排程端（T33a 起照 core_ai_design §3.1：先列出需要檢視的切換 crashNeeds，再決定開不開；T33b 補 §3.1～§3.5 其餘的部分）。
//   月報前一天：抓 FRED、算儀表板（存一份，網站顯示）；預估訊號日會切換、總經資料夠 → 開完整檢視（PREVIEW，3 票，A2）；
//              不會切換 → 不開任何 AI（每月評語在 T33d 拿掉，§3.9），儀表板照樣算、存。
//   月報出了、有沒取消的 F5／F6、還沒回覆 → 不看日期都算需要（MAKEUP）：月報晚一天才出、使用者隔天還沒回覆都會補開。
//   同一個月份＋方向：有一筆跑完了（有意見或沒有意見）、還在等、或沒有結論的已經 3 筆 → 不開；總經資料不足（§3.5）→ 不開，01:30 重抓。
//   01:30（finalStarts）：先重抓不足的總經資料，再跑同一段 crashNeeds（沒有結論的重開一次）。03:30 不開新的執行。
//   結果回來：applyCrashReview 更新月報那一項（§3.2）；連續 2 次、3 次沒有結論 → CRASH_REVIEW_FAILED。
import { CRASH_REVIEW, breadth, crashPack, dashboardText, isStale, macroDashboard, macroQuality, macroUsable, type CrashDirection, type DashRow } from '../ai/crash';
import type { Outcome, PackDoc } from '../ai/check';
import { newRunId } from '../ai/pack';
import { clone, crashDecision, crashReviewOf, setCrashReview, sma, type Account, type CrashReviewInfo, type Item, type MarketView, type Notif, type ShadowRecord } from '../engine';
import { isLastTradingDayOfMonth, nextTradingDay, type CalendarOverrides } from '../data/calendar';
import { MACRO_SERIES, fetchFred, type FredSeries } from '../data/fred';
import { loadRanking } from '../data/store';
import { errText } from '../data/util';
import type { ApplyCtx, StartCtx } from './aiCtx';
import { startRun, type AiRun } from './aiRuns';
import type { Fetcher } from './env';
import { patchAccount } from './ledgerStore';
import { monthOfSignal } from './momAi';
import { newsDoc, routineReady } from './ownAi';

export interface MacroSnapshot {
  month: string;
  asOf: string;
  rows: DashRow[];
  breadth: { above: number; n: number } | null;
  core: { ticker: string; close: number; ma: number } | null;
  missing: string[];
  /** 過期的序列（core_ai §3.5）；舊的儀表板沒有這個欄位，載入時照 asOf 補算。 */
  stale?: string[];
}

/** 這個訊號日崩盤規則會不會切換（和月報用同一個判斷）。 */
export function crashDirection(acct: Account, view: MarketView): CrashDirection {
  const c = view.close[acct.cfg.coreTicker];
  if (!c) return 'NONE';
  // 均線算不出來時維持原狀態（core_ai §3.10），所以不會切換
  const { below } = crashDecision(c, view.i, !!acct.rule.crash);
  return below && !acct.rule.crash ? 'ON' : !below && acct.rule.crash ? 'OFF' : 'NONE';
}

/** 一筆需要檢視的切換（core_ai §3.1）。basis：檢視依哪一天的收盤。 */
export interface CrashNeed {
  month: string;
  direction: 'ON' | 'OFF';
  kind: 'PREVIEW' | 'MAKEUP';
  basis: string;
}

/**
 * 需要檢視的切換（0～2 筆）：
 *   PREVIEW：下一個交易日是當月最後一個交易日，而且照今天的收盤崩盤規則會切換。
 *   MAKEUP：帳戶裡最新一份月報（kind MONTHLY）還沒回覆、有沒被取消的 F5／F6（不是重列的）。不看今天是不是月底。
 */
export function crashNeeds(acct: Account, view: MarketView, session: string, ov: CalendarOverrides): CrashNeed[] {
  const out: CrashNeed[] = [];
  const signal = nextTradingDay(session, ov);
  if (isLastTradingDayOfMonth(signal, ov)) {
    const d = crashDirection(acct, view);
    if (d !== 'NONE') out.push({ month: monthOfSignal(signal, ov), direction: d, kind: 'PREVIEW', basis: session });
  }
  const m = [...acct.notifs].reverse().find((n) => n.kind === 'MONTHLY' && !!n.monthly);
  const it = m?.status === 'PENDING' ? m.items.find((i) => (i.f === 'F5' || i.f === 'F6') && !i.cancelled && !i.relist) : undefined;
  if (m?.monthly && it) {
    const need: CrashNeed = { month: m.monthly.input.month, direction: it.f === 'F5' ? 'ON' : 'OFF', kind: 'MAKEUP', basis: m.date };
    if (!out.some((x) => x.month === need.month && x.direction === need.direction)) out.push(need);
  }
  return out;
}

// ---------------------------------------------------------------- 某個月份＋方向的檢視（§3.1、§3.2）

/** 檢視跑完了（有意見：三票一致；沒有意見：票數不一致、三票證據不足）。其餘（逾時、沒有結果、格式都不合格）是沒有結論。 */
const FINISHED = new Set(['AGREED', 'SPLIT', 'INSUFFICIENT', 'DATA_MISSING']);

interface CrashRunRow {
  runId: string;
  cls: 'finished' | 'pending' | 'failed';
  outcome: Outcome | null;
  kind?: CrashNeed['kind'];
  basis?: string;
}

/** 這個月份＋方向的所有檢視（不分 kind、不分 as_of），由舊到新。 */
async function crashRunList(db: D1Database, month: string, direction: CrashDirection): Promise<CrashRunRow[]> {
  const rows = (await db.prepare('SELECT run_id, status, pack, outcome FROM ai_runs WHERE fn = ? ORDER BY created_at, run_id').bind(CRASH_REVIEW).all<{ run_id: string; status: string; pack: string; outcome: string | null }>()).results;
  const out: CrashRunRow[] = [];
  for (const r of rows) {
    const d = (JSON.parse(r.pack).rule?.detail ?? {}) as { month?: string; direction?: string; kind?: CrashNeed['kind']; basis?: string };
    if (d.month !== month || d.direction !== direction) continue;
    const outcome = r.outcome ? (JSON.parse(r.outcome) as Outcome) : null;
    const cls = r.status === 'PENDING' ? 'pending' : FINISHED.has(outcome?.status ?? '') ? 'finished' : 'failed';
    out.push({ runId: r.run_id, cls, outcome, ...(d.kind ? { kind: d.kind } : {}), ...(d.basis ? { basis: d.basis } : {}) });
  }
  return out;
}

/** 這個月份＋方向的所有檢視：跑完了幾筆、在等幾筆、沒有結論幾筆。 */
export async function crashRunsFor(db: D1Database, month: string, direction: CrashDirection): Promise<{ finished: number; pending: number; failed: number }> {
  const list = await crashRunList(db, month, direction);
  return { finished: list.filter((r) => r.cls === 'finished').length, pending: list.filter((r) => r.cls === 'pending').length, failed: list.filter((r) => r.cls === 'failed').length };
}

/** 同一個月份＋方向，沒有結論的最多開幾次（core_ai §3.1）。 */
export const CRASH_MAX_TRIES = 3;

/** 一次沒有結論的原因（網站與告警用的白話）。 */
export function crashFailWhy(o: Outcome | null): string {
  if (!o) return '沒有結果';
  if (o.status === 'TIMEOUT') return '逾時';
  if (o.status === 'INVALID') return '格式不合格';
  if (o.status === 'NO_RESULT') return /觸發/.test(o.reason) ? '沒觸發成功' : /退回/.test(o.reason) ? '被退回' : '沒有結果';
  return o.status;
}

const VOTE_ORDER = ['FOLLOW', 'DELAY', 'INSUFFICIENT'];
const VOTE_TEXT: Record<string, string> = { FOLLOW: '照做', DELAY: '延後', INSUFFICIENT: '證據不足' };

/** 跑完的那一筆 → 有意見（三票一致照做或延後）或沒有意見（票數不一致、三票證據不足、資料缺漏）。 */
function finishedInfo(o: Outcome): Pick<CrashReviewInfo, 'state' | 'opinion' | 'votes'> {
  const n = o.samples?.length || Object.values(o.votes ?? {}).reduce((a, b) => a + b, 0) || 3;
  if (o.status === 'AGREED' && (o.verdict === 'FOLLOW' || o.verdict === 'DELAY')) return { state: 'OPINION', opinion: o.verdict === 'FOLLOW' ? '照做' : '延後', votes: `${n} 票一致` };
  if (o.status === 'INSUFFICIENT' || (o.status === 'AGREED' && o.verdict === 'INSUFFICIENT')) return { state: 'NO_OPINION', votes: `${n} 票都是證據不足` };
  if (o.status === 'DATA_MISSING') return { state: 'NO_OPINION', votes: '資料有缺漏' };
  const votes = Object.entries(o.votes ?? {})
    .filter(([, k]) => k > 0)
    .sort((a, b) => VOTE_ORDER.indexOf(a[0]) - VOTE_ORDER.indexOf(b[0]))
    .map(([v, k]) => `${VOTE_TEXT[v] ?? v} ${k}`)
    .join('、');
  return { state: 'NO_OPINION', ...(votes ? { votes } : {}) };
}

const runFields = (r: CrashRunRow): Pick<CrashReviewInfo, 'runId' | 'kind' | 'basis'> => ({ runId: r.runId, ...(r.kind ? { kind: r.kind } : {}), ...(r.basis ? { basis: r.basis } : {}) });

/**
 * 這個月份＋方向的檢視狀態（core_ai §3.2 的 CrashReviewInfo）：
 *   有一筆跑完 → OPINION／NO_OPINION（取最新跑完的那一筆）；有一筆在等 → PENDING；只有沒有結論的 → FAILED（每次的原因）；
 *   都沒有：AI 層沒設定 → OFF；這個月份的儀表板總經資料不足 → NO_DATA；其他 → OFF。
 */
export async function crashReviewFor(db: D1Database, month: string, direction: CrashDirection, opt: { ready: boolean }): Promise<CrashReviewInfo> {
  if (direction === 'NONE') return { state: 'OFF' };
  const list = await crashRunList(db, month, direction);
  const done = list.filter((r) => r.cls === 'finished').at(-1);
  if (done) return { ...finishedInfo(done.outcome!), ...runFields(done) };
  const pend = list.filter((r) => r.cls === 'pending').at(-1);
  if (pend) return { state: 'PENDING', ...runFields(pend) };
  const failed = list.filter((r) => r.cls === 'failed');
  if (failed.length) return { state: 'FAILED', ...runFields(failed.at(-1)!), fails: failed.map((r) => crashFailWhy(r.outcome)) };
  if (!opt.ready) return { state: 'OFF' };
  const snap = await loadSnapshot(db, month);
  if (snap && macroQuality(snap.rows) === 'missing') return { state: 'NO_DATA' };
  return { state: 'OFF' };
}

/** CRASH_REVIEW_FAILED 的文字（core_ai §3.1）：連續 2 次 → 下一次流程會再開；第 3 次 → 已經停止重試。 */
export function crashFailText(direction: 'ON' | 'OFF', whys: string[]): string {
  const n = whys.length;
  return `崩盤規則${direction === 'ON' ? '啟動' : '解除'}的 AI 檢視連續 ${n} 次沒有結論（${whys.join('、')}）。規則照常，月報照規則出；${n >= CRASH_MAX_TRIES ? '已經停止重試。' : '下一次流程會再開一次。'}`;
}

// ---------------------------------------------------------------- 總經儀表板（§3.5）

export async function buildSnapshot(db: D1Database, fetcher: Fetcher, acct: Account, view: MarketView, month: string): Promise<MacroSnapshot> {
  const series = new Map<string, FredSeries>();
  const missing: string[] = [];
  for (const m of MACRO_SERIES) {
    try {
      series.set(m.id, await fetchFred(fetcher, m.id));
    } catch {
      missing.push(m.id);
    }
  }
  const r = await loadRanking(db);
  const br = r ? breadth(view, r.detail.universe.map((u) => u.ticker)) : null;
  const c = view.close[acct.cfg.coreTicker];
  const ma = c ? sma(c, view.i, 200) : NaN;
  const rows = macroDashboard(series, view.date);
  return { month, asOf: view.date, rows, breadth: br && br.n ? br : null, core: c && Number.isFinite(ma) ? { ticker: acct.cfg.coreTicker, close: c[view.i], ma } : null, missing, stale: rows.filter((x) => x.stale).map((x) => x.id) };
}

export async function saveSnapshot(db: D1Database, s: MacroSnapshot, now: Date): Promise<void> {
  await db.prepare('INSERT OR REPLACE INTO macro_snapshots (month, as_of, data, created_at) VALUES (?, ?, ?, ?)').bind(s.month, s.asOf, JSON.stringify(s), now.toISOString()).run();
}

/** 舊的儀表板（T33b 之前）沒有 stale：照 asOf 補算（市場資料會留著，要相容）。 */
function withStale(s: MacroSnapshot): MacroSnapshot {
  const rows = s.rows.map((r) => (r.stale === undefined ? { ...r, stale: isStale(r.id, r.date, s.asOf) } : r));
  return { ...s, rows, stale: s.stale ?? rows.filter((r) => r.stale).map((r) => r.id) };
}

export async function loadSnapshot(db: D1Database, month?: string): Promise<MacroSnapshot | null> {
  const r = month ? await db.prepare('SELECT data FROM macro_snapshots WHERE month = ?').bind(month).first<{ data: string }>() : await db.prepare('SELECT data FROM macro_snapshots ORDER BY month DESC LIMIT 1').first<{ data: string }>();
  return r ? withStale(JSON.parse(r.data) as MacroSnapshot) : null;
}

/** /admin/macro 與排程用同一個月份標籤（§3.5）：月報前一天與訊號日用 monthOfSignal，其他日子用當月。 */
export function macroMonthOf(session: string, ov: CalendarOverrides): string {
  if (isLastTradingDayOfMonth(session, ov)) return monthOfSignal(session, ov);
  const signal = nextTradingDay(session, ov);
  return isLastTradingDayOfMonth(signal, ov) ? monthOfSignal(signal, ov) : session.slice(0, 7);
}

/** flow_state 的鍵：總經資料不足、01:30 要重抓的月份；這個月份已經推過 MACRO_MISSING。 */
export const MACRO_RETRY_PREFIX = 'macro:retry:';
export const MACRO_ALERTED_PREFIX = 'macro:alerted:';

const setFlag = (db: D1Database, key: string, value: string, now: Date) =>
  db.prepare('INSERT INTO flow_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').bind(key, value, now.toISOString()).run();

/** MACRO_MISSING 的文字（§3.5）。 */
export function macroMissingText(s: Pick<MacroSnapshot, 'rows'>): string {
  const missing = s.rows.filter((r) => r.value === null).map((r) => r.id);
  const stale = s.rows.filter((r) => r.value !== null && r.stale).map((r) => r.id);
  const what = [missing.length ? `缺 ${missing.join('、')}` : '', stale.length ? `過期 ${stale.join('、')}` : ''].filter(Boolean).join('；');
  return `總經資料抓不到：FRED 的 ${MACRO_SERIES.length} 個序列只有 ${macroUsable(s.rows)} 個可用${what ? `（${what}）` : ''}。崩盤規則照常；這個月如果切換，不會有 AI 檢視。可以用 POST /admin/macro 重抓。`;
}

/**
 * 01:30 重抓（§3.5）：flow_state 有 macro:retry:<月份> → 只重抓缺的與過期的序列，併進這個月份的儀表板重存，清掉標記；
 * 還是不足 → 推 MACRO_MISSING（每個月份一次，記在 macro:alerted:<月份>）。
 */
async function retryMacro(sc: StartCtx): Promise<void> {
  const db = sc.env.DB;
  const keys = (await db.prepare('SELECT key FROM flow_state WHERE key LIKE ?').bind(`${MACRO_RETRY_PREFIX}%`).all<{ key: string }>()).results.map((r) => r.key);
  for (const key of keys) {
    const month = key.slice(MACRO_RETRY_PREFIX.length);
    await db.prepare('DELETE FROM flow_state WHERE key = ?').bind(key).run();
    const old = await loadSnapshot(db, month);
    if (!old) continue;
    const redo = old.rows.filter((r) => r.value === null || r.stale).map((r) => r.id);
    const series = new Map<string, FredSeries>();
    for (const id of redo) {
      try {
        series.set(id, await fetchFred(sc.fetcher, id));
      } catch {
        // 還是抓不到：留著原本的那一列
      }
    }
    const fresh = macroDashboard(series, old.asOf);
    const rows = old.rows.map((r) => (series.has(r.id) ? (fresh.find((x) => x.id === r.id) ?? r) : r));
    const snap: MacroSnapshot = { ...old, rows, missing: rows.filter((r) => r.value === null).map((r) => r.id), stale: rows.filter((r) => r.stale).map((r) => r.id) };
    await saveSnapshot(db, snap, sc.now);
    sc.res.log.push(`總經資料重抓（${month}）：${MACRO_SERIES.length} 個序列有 ${macroUsable(rows)} 個可用`);
    if (macroQuality(rows) !== 'missing') continue;
    if (await db.prepare('SELECT 1 AS x FROM flow_state WHERE key = ?').bind(`${MACRO_ALERTED_PREFIX}${month}`).first()) continue;
    sc.res.alerts.push({ kind: 'MACRO_MISSING', message: macroMissingText(snap) });
    await setFlag(db, `${MACRO_ALERTED_PREFIX}${month}`, sc.now.toISOString(), sc.now);
  }
}

// ---------------------------------------------------------------- 開檢視（§3.1）

/** 總經儀表板 → 證據包的一份原文（崩盤規則檢視與市場摘要 T64 共用）。 */
export const snapshotDoc = (s: MacroSnapshot): PackDoc => ({ id: 'DASH', source_id: `macro:${s.asOf}`, kind: 'table', date: s.asOf, title: `總經儀表板（${s.asOf}，FRED）`, text: dashboardText(s.rows, s.breadth, s.core) });

async function start(sc: StartCtx, snap: MacroSnapshot, direction: CrashDirection, month: string, detail: { kind: CrashNeed['kind']; basis: string; try: number } | null = null, preface?: string): Promise<void> {
  const { env, fetcher, session, now, res } = sc;
  const news = await newsDoc(fetcher, 'SPY', session).catch(() => null);
  const facts = snap.rows.filter((r) => r.value !== null).map((r, k) => ({ id: `M${k + 1}`, label: r.label, value: `${r.value!.toFixed(2)}（${r.date}）`, note: [r.change6m === null ? null : `6 個月變化 ${r.change6m >= 0 ? '+' : ''}${r.change6m.toFixed(2)}`, r.derived].filter(Boolean).join('；') || undefined })).map((f) => (f.note === undefined ? { id: f.id, label: f.label, value: f.value } : f));
  const { pack, notes } = crashPack({ runId: newRunId(session, CRASH_REVIEW), asOf: session, direction, dashboard: snapshotDoc(snap), news: news ? { ...news, title: news.title.replace(/^SPY 最近的新聞標題（/, '大盤相關的新聞標題（SPY，') } : null, facts, dataQuality: { macro: macroQuality(snap.rows), news: 'partial' }, now, ...(preface ? { preface } : {}) });
  pack.rule.detail = { ...(pack.rule.detail as object), month, ...(detail ?? {}) };
  const stale = snap.rows.filter((r) => r.value !== null && r.stale).map((r) => r.id);
  const notesAll = [...notes, ...(snap.missing.length ? [`FRED 抓不到：${snap.missing.join('、')}`] : []), ...(stale.length ? [`FRED 過期：${stale.join('、')}`] : [])];
  res.started.push((await startRun(env, fetcher, pack, now, notesAll)).runId);
}

/** 這個月份的月報裡、這個方向、會開檢視的那一項（沒被取消、不是重列的 F5／F6）。 */
function crashItemOf(acct: Account, month: string, direction: 'ON' | 'OFF'): { n: Notif; it: Item } | null {
  const n = [...acct.notifs].reverse().find((x) => x.kind === 'MONTHLY' && x.monthly?.input.month === month);
  const it = n?.items.find((i) => i.f === (direction === 'ON' ? 'F5' : 'F6') && !i.cancelled && !i.relist);
  return n && it ? { n, it } : null;
}

/** 那一項已經有跑完的結果（有意見或沒有意見）：之後的執行不覆蓋（G15）。 */
const settled = (it: Item): boolean => {
  const s = crashReviewOf(it)?.state;
  return s === 'OPINION' || s === 'NO_OPINION';
};

/** 補開、決定不開之後：月報那一項的檢視狀態跟著更新（PENDING、NO_DATA、FAILED…；已經跑完的不動）。帳戶已經存好，所以重新讀、改、存。 */
async function refreshCrashItem(sc: StartCtx, need: CrashNeed): Promise<void> {
  if (need.kind !== 'MAKEUP') return;
  const db = sc.env.DB;
  const info = await crashReviewFor(db, need.month, need.direction, { ready: routineReady(sc.env) });
  await patchAccount(
    db,
    sc.now,
    '崩盤規則檢視的狀態',
    (a0) => {
      const a = clone(a0);
      const x = crashItemOf(a, need.month, need.direction);
      if (!x || settled(x.it)) return null;
      return setCrashReview(x.n, x.it, info) ? { acct: a } : null;
    },
    sc.res.log,
  );
}

/**
 * 崩盤規則檢視（core_ai §3.1）：月報前一天先算儀表板並存（資料不足記 macro:retry）；
 * 列出需要檢視的切換（crashNeeds），每一筆照「跑完了不開、在等不開、沒有結論滿 3 筆不開、總經資料不足不開」決定開不開。
 * 不會切換的月份不開任何 AI（每月評語在 T33d 拿掉，§3.9），儀表板照樣算、存。
 * final：01:30（finalStarts）——先重抓不足的總經資料；儀表板 23:30 已經算過就不重算。
 */
export async function startCrashRuns(sc: StartCtx, opt: { final?: boolean } = {}): Promise<void> {
  const { env, fetcher, acct, view, session, ov, res } = sc;
  const db = env.DB;
  try {
    if (opt.final) await retryMacro(sc);
    const signal = nextTradingDay(session, ov);
    let snap: MacroSnapshot | null = null;
    if (isLastTradingDayOfMonth(signal, ov)) {
      const month = monthOfSignal(signal, ov);
      if (opt.final) snap = await loadSnapshot(db, month);
      if (!snap) {
        snap = await buildSnapshot(db, fetcher, acct, view, month);
        await saveSnapshot(db, snap, sc.now);
        // 不會切換的月份也一樣：每月驗一次 FRED 抓不抓得到（§3.5）
        if (macroQuality(snap.rows) === 'missing') await setFlag(db, `${MACRO_RETRY_PREFIX}${month}`, sc.now.toISOString(), sc.now);
      }
      // 不會切換的月份不開任何 AI（每月評語拿掉，core_ai §3.9）；儀表板上面已經算好、存了
    }
    for (const need of crashNeeds(acct, view, session, ov)) {
      const runs = await crashRunsFor(db, need.month, need.direction);
      const label = `${need.month} ${need.direction === 'ON' ? '啟動' : '解除'}`;
      if (runs.finished || runs.pending) {
        await refreshCrashItem(sc, need);
        continue;
      }
      if (runs.failed >= CRASH_MAX_TRIES) {
        res.log.push(`崩盤規則${label}的檢視已經 ${runs.failed} 次沒有結論，不再開`);
        await refreshCrashItem(sc, need);
        continue;
      }
      let s = need.kind === 'PREVIEW' && snap?.month === need.month ? snap : await loadSnapshot(db, need.month);
      if (!s) {
        s = await buildSnapshot(db, fetcher, acct, view, need.month);
        await saveSnapshot(db, s, sc.now);
      }
      if (macroQuality(s.rows) === 'missing') {
        // 總經資料不足（§3.5）：不開；01:30 只重抓缺的與過期的，夠了而且還需要就那一次開
        await setFlag(db, `${MACRO_RETRY_PREFIX}${need.month}`, sc.now.toISOString(), sc.now);
        res.log.push(`崩盤規則${label}：總經資料只有 ${macroUsable(s.rows)} 個序列可用，不開檢視`);
        await refreshCrashItem(sc, need);
        continue;
      }
      const preface = need.kind === 'PREVIEW' ? `這是依 ${need.basis} 的收盤預估的：訊號日（${signal}）收盤如果仍在均線的同一側，規則會切換。` : undefined;
      await start(sc, s, need.direction, need.month, { kind: need.kind, basis: need.basis, try: runs.failed + 1 }, preface);
      res.log.push(`崩盤規則${label}：${need.kind === 'MAKEUP' ? '月報之後補開' : '預估會切換，開'}檢視（第 ${runs.failed + 1} 次${opt.final ? '，01:30' : ''}）`);
      await refreshCrashItem(sc, need);
    }
  } catch (e) {
    res.log.push(`崩盤規則檢視沒有開成：${errText(e)}`);
  }
}

// ---------------------------------------------------------------- 結果回到月報（§3.2）

/** 回覆之後才回來的檢視補在影子紀錄的備註。 */
export const CRASH_LATE_NOTE = '（AI 檢視在回覆之後才回來）';

/** 03:30 之後才回來的結果只放網站（§3.2）：月報訊號日的隔天中午（UTC）以後才套用的，標成講過了、不補推。 */
const pastFollowUp = (n: Notif, now: Date): boolean => now.getTime() > Date.parse(`${n.date}T12:00:00Z`) + 86400_000;

/**
 * 崩盤規則檢視的結論（APPLIERS[CRASH_REVIEW]，core_ai §3.2「月報產生後」）：
 *   沒有結論的、連續第 2、3 次 → CRASH_REVIEW_FAILED（每一筆執行只套用一次，所以只在它是最新的那一次失敗時推）；
 *   找這個月份的月報裡同方向的 F5／F6（找不到 → 只標成已套用）；已經是有意見或沒有意見 → 不動（G15）；
 *   否則用 crashReviewFor 重算那一項；通知已經回覆 → late，影子紀錄的 ai 從 null 補上。不推 LINE（03:30 的補推由 pushHold 判斷）。
 */
export async function applyCrashReview(ctx: ApplyCtx, run: AiRun): Promise<void> {
  const d = (run.pack.rule.detail ?? {}) as { month?: string; direction?: string };
  if (!d.month || (d.direction !== 'ON' && d.direction !== 'OFF')) return;
  const direction = d.direction;
  const list = await crashRunList(ctx.db, d.month, direction);
  const failed = list.filter((r) => r.cls === 'failed');
  if (!list.some((r) => r.cls === 'finished') && failed.length >= 2 && failed.length <= CRASH_MAX_TRIES && failed.at(-1)!.runId === run.runId) {
    ctx.alerts?.push({ kind: 'CRASH_REVIEW_FAILED', message: crashFailText(direction, failed.map((r) => crashFailWhy(r.outcome))) });
  }
  const x = crashItemOf(ctx.acct, d.month, direction);
  if (!x) return;
  if (settled(x.it)) return void ctx.log.push(`${run.runId}：崩盤規則檢視回來了，月報 #${x.n.id} 那一項已經有結果，不動`);
  const info = await crashReviewFor(ctx.db, d.month, direction, { ready: true });
  const done = info.state === 'OPINION' || info.state === 'NO_OPINION';
  const answered = x.n.status !== 'PENDING';
  if (done && answered) info.late = true;
  if (done && (answered || pastFollowUp(x.n, ctx.now))) info.told = true;
  const acct = clone(ctx.acct);
  const y = crashItemOf(acct, d.month, direction)!;
  if (!setCrashReview(y.n, y.it, info)) return;
  ctx.acct = acct;
  ctx.log.push(`${run.runId}：崩盤規則檢視 → 月報 #${y.n.id} 那一項：${info.state}${info.opinion ? `（${info.opinion}）` : ''}${info.late ? '，在回覆之後才回來' : ''}`);
  if (!answered || info.state !== 'OPINION' || !info.opinion) return;
  // 回覆之後才回來（§3.4）：那則通知的 F5／F6 影子紀錄補上 ai（只補 null 的）。影子紀錄平常只增加，這是設計明寫的例外
  const rows = (await ctx.db.prepare("SELECT id, body FROM shadow_records WHERE f IN ('F5', 'F6')").all<{ id: number; body: string }>()).results;
  for (const r of rows) {
    const rec = JSON.parse(r.body) as ShadowRecord;
    if (rec.notif !== y.n.id || rec.f !== y.it.f || rec.ai !== null) continue;
    const next: ShadowRecord = { ...rec, ai: info.opinion === '照做' ? rec.rule : 0, note: `${rec.note ?? ''}${CRASH_LATE_NOTE}` };
    ctx.stmts.push(ctx.db.prepare('UPDATE shadow_records SET body = ? WHERE id = ?').bind(JSON.stringify(next), r.id));
  }
}
