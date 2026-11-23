// 總經儀表板的排程端（core_ai §3.5）。原本是 T11 崩盤規則檢視（F5／F6）的 app/crashAi.ts；崩盤規則檢視 2026-11-22 退場
// （allocation_redesign §1.6，T81 拿掉入口），T88 刪掉檢視的本體、留下儀表板這一半並改名。
//   月報前一天（refreshMacro）：抓 FRED、算儀表板、存一份（網站「AI 紀錄」上方的儀表板與市場摘要讀它）；資料不足記 macro:retry。
//   01:30（refreshMacro final）：只重抓缺的與過期的序列；還是不足推 MACRO_MISSING（每個月份一次）。不開任何 AI。
import { breadth, dashboardText, isStale, macroDashboard, macroQuality, macroUsable, type DashRow } from '../ai/macro';
import type { PackDoc } from '../ai/check';
import { sma, type Account, type MarketView } from '../engine';
import { isLastTradingDayOfMonth, nextTradingDay, type CalendarOverrides } from '../data/calendar';
import { MACRO_SERIES, fetchFred, type FredSeries } from '../data/fred';
import { loadRanking } from '../data/store';
import { errText } from '../data/util';
import type { StartCtx } from './aiCtx';
import type { Fetcher } from './env';
import { monthOfSignal } from './momAi';

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
  return `總經資料抓不到：FRED 的 ${MACRO_SERIES.length} 個序列只有 ${macroUsable(s.rows)} 個可用${what ? `（${what}）` : ''}。市場摘要缺的序列會備註；可以用 POST /admin/macro 重抓。`;
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

/** 總經儀表板 → 證據包的一份原文（市場摘要 T64 用；原本也給崩盤規則檢視）。 */
export const snapshotDoc = (s: MacroSnapshot): PackDoc => ({ id: 'DASH', source_id: `macro:${s.asOf}`, kind: 'table', date: s.asOf, title: `總經儀表板（${s.asOf}，FRED）`, text: dashboardText(s.rows, s.breadth, s.core) });

/**
 * 總經儀表板（2026-11-22 起，崩盤規則檢視退場後留下的部分；allocation_redesign §1.6）：月報前一天抓 FRED、算儀表板、存一份
 * （網站「AI 紀錄」上方的儀表板與市場摘要的備援都讀它）；資料不足記 macro:retry，01:30（final）只重抓缺的與過期的。不開任何 AI。
 */
export async function refreshMacro(sc: StartCtx, opt: { final?: boolean } = {}): Promise<void> {
  const { env, fetcher, acct, view, session, ov, res } = sc;
  const db = env.DB;
  try {
    if (opt.final) await retryMacro(sc);
    const signal = nextTradingDay(session, ov);
    if (!isLastTradingDayOfMonth(signal, ov)) return;
    const month = monthOfSignal(signal, ov);
    if (opt.final && (await loadSnapshot(db, month))) return;
    const snap = await buildSnapshot(db, fetcher, acct, view, month);
    await saveSnapshot(db, snap, sc.now);
    // 每月驗一次 FRED 抓不抓得到（§3.5）
    if (macroQuality(snap.rows) === 'missing') await setFlag(db, `${MACRO_RETRY_PREFIX}${month}`, sc.now.toISOString(), sc.now);
  } catch (e) {
    res.log.push(`總經儀表板沒有更新成功：${errText(e)}`);
  }
}

