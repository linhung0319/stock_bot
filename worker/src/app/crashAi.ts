// T11：F5／F6 崩盤規則檢視的排程端（T33a 起照 core_ai_design §3.1：先列出需要檢視的切換 crashNeeds，再決定開不開）。
//   月報前一天：抓 FRED、算儀表板（存一份，網站顯示）；預估訊號日會切換 → 開完整檢視（PREVIEW，3 票，A2）；
//              不會切換 → 開每月評語（一票，只記錄；§3.9 的拿掉在 T33d）。
//   月報出了、有沒取消的 F5／F6、還沒回覆 → 不看日期都算需要（MAKEUP）：月報晚一天才出、使用者隔天還沒回覆都會補開。
//   同一個月份＋方向：有一筆跑完了（有意見或沒有意見）、還在等、或沒有結論的已經 3 筆 → 不開。
import { CRASH_REVIEW, breadth, crashOpinionOf, crashPack, dashboardText, macroDashboard, type CrashDirection, type DashRow } from '../ai/crash';
import type { PackDoc } from '../ai/check';
import { newRunId } from '../ai/pack';
import { crashDecision, sma, type Account, type MarketView } from '../engine';
import { isLastTradingDayOfMonth, nextTradingDay, type CalendarOverrides } from '../data/calendar';
import { MACRO_SERIES, fetchFred, type FredSeries } from '../data/fred';
import { loadRanking } from '../data/store';
import { errText } from '../data/util';
import type { StartCtx } from './aiCtx';
import { getRun, startRun } from './aiRuns';
import type { Fetcher } from './env';
import { monthOfSignal } from './momAi';
import { newsDoc } from './ownAi';

export interface MacroSnapshot {
  month: string;
  asOf: string;
  rows: DashRow[];
  breadth: { above: number; n: number } | null;
  core: { ticker: string; close: number; ma: number } | null;
  missing: string[];
}

/** 這個訊號日崩盤規則會不會切換（和月報用同一個判斷）。 */
export function crashDirection(acct: Account, view: MarketView): CrashDirection {
  const c = view.close[acct.cfg.coreTicker];
  if (!c) return 'NONE';
  // 均線算不出來時維持原狀態（core_ai §3.10），所以不會切換
  const { below } = crashDecision(c, view.i, acct.rule.crash);
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

/** 檢視跑完了（有意見：三票一致；沒有意見：票數不一致、三票證據不足）。其餘（逾時、沒有結果、格式都不合格）是沒有結論。 */
const FINISHED = new Set(['AGREED', 'SPLIT', 'INSUFFICIENT', 'DATA_MISSING']);

/** 這個月份＋方向的所有檢視（不分 kind、不分 as_of）：跑完了幾筆、在等幾筆、沒有結論幾筆。 */
export async function crashRunsFor(db: D1Database, month: string, direction: CrashDirection): Promise<{ finished: number; pending: number; failed: number }> {
  const rows = (await db.prepare('SELECT status, pack, outcome FROM ai_runs WHERE fn = ?').bind(CRASH_REVIEW).all<{ status: string; pack: string; outcome: string | null }>()).results;
  const out = { finished: 0, pending: 0, failed: 0 };
  for (const r of rows) {
    const d = (JSON.parse(r.pack).rule?.detail ?? {}) as { month?: string; direction?: string };
    if (d.month !== month || d.direction !== direction) continue;
    if (r.status === 'PENDING') out.pending++;
    else if (FINISHED.has((r.outcome ? (JSON.parse(r.outcome) as { status?: string }) : {}).status ?? '')) out.finished++;
    else out.failed++;
  }
  return out;
}

/** 同一個月份＋方向，沒有結論的最多開幾次（core_ai §3.1）。 */
export const CRASH_MAX_TRIES = 3;

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
  return { month, asOf: view.date, rows: macroDashboard(series, view.date), breadth: br && br.n ? br : null, core: c && Number.isFinite(ma) ? { ticker: acct.cfg.coreTicker, close: c[view.i], ma } : null, missing };
}

export async function saveSnapshot(db: D1Database, s: MacroSnapshot, now: Date): Promise<void> {
  await db.prepare('INSERT OR REPLACE INTO macro_snapshots (month, as_of, data, created_at) VALUES (?, ?, ?, ?)').bind(s.month, s.asOf, JSON.stringify(s), now.toISOString()).run();
}

export async function loadSnapshot(db: D1Database, month?: string): Promise<MacroSnapshot | null> {
  const r = month ? await db.prepare('SELECT data FROM macro_snapshots WHERE month = ?').bind(month).first<{ data: string }>() : await db.prepare('SELECT data FROM macro_snapshots ORDER BY month DESC LIMIT 1').first<{ data: string }>();
  return r ? (JSON.parse(r.data) as MacroSnapshot) : null;
}

const snapshotDoc = (s: MacroSnapshot): PackDoc => ({ id: 'DASH', source_id: `macro:${s.asOf}`, kind: 'table', date: s.asOf, title: `總經儀表板（${s.asOf}，FRED）`, text: dashboardText(s.rows, s.breadth, s.core) });

async function start(sc: StartCtx, snap: MacroSnapshot, direction: CrashDirection, month: string, detail: { kind: CrashNeed['kind']; basis: string; try: number } | null = null, preface?: string): Promise<void> {
  const { env, fetcher, session, now, res } = sc;
  const news = await newsDoc(fetcher, 'SPY', session).catch(() => null);
  const facts = snap.rows.filter((r) => r.value !== null).map((r, k) => ({ id: `M${k + 1}`, label: r.label, value: `${r.value!.toFixed(2)}（${r.date}）`, note: [r.change6m === null ? null : `6 個月變化 ${r.change6m >= 0 ? '+' : ''}${r.change6m.toFixed(2)}`, r.derived].filter(Boolean).join('；') || undefined })).map((f) => (f.note === undefined ? { id: f.id, label: f.label, value: f.value } : f));
  const { pack, notes } = crashPack({ runId: newRunId(session, CRASH_REVIEW), asOf: session, direction, dashboard: snapshotDoc(snap), news: news ? { ...news, title: '大盤相關的新聞標題（SPY，Nasdaq RSS，只有標題）' } : null, facts, dataQuality: { macro: snap.missing.length > 4 ? 'missing' : snap.missing.length ? 'partial' : 'ok', news: 'partial' }, now, ...(preface ? { preface } : {}) });
  pack.rule.detail = { ...(pack.rule.detail as object), month, ...(detail ?? {}) };
  res.started.push((await startRun(env, fetcher, pack, now, [...notes, ...(snap.missing.length ? [`FRED 抓不到：${snap.missing.join('、')}`] : [])])).runId);
}

/**
 * 崩盤規則檢視（core_ai §3.1，不含 01:30 的重開——那是 T33b）：月報前一天先算儀表板並存；
 * 列出需要檢視的切換（crashNeeds），每一筆照「跑完了不開、在等不開、沒有結論滿 3 筆不開」決定開不開。
 * 不會切換的月份照舊開每月評語（拿掉在 T33d）。
 */
export async function startCrashRuns(sc: StartCtx): Promise<void> {
  const { env, fetcher, acct, view, session, ov, res } = sc;
  try {
    const signal = nextTradingDay(session, ov);
    let snap: MacroSnapshot | null = null;
    if (isLastTradingDayOfMonth(signal, ov)) {
      const month = monthOfSignal(signal, ov);
      snap = await buildSnapshot(env.DB, fetcher, acct, view, month);
      await saveSnapshot(env.DB, snap, sc.now);
      if (crashDirection(acct, view) === 'NONE') await start(sc, snap, 'NONE', month);
    }
    for (const need of crashNeeds(acct, view, session, ov)) {
      const runs = await crashRunsFor(env.DB, need.month, need.direction);
      const label = `${need.month} ${need.direction === 'ON' ? '啟動' : '解除'}`;
      if (runs.finished) continue;
      if (runs.pending) continue;
      if (runs.failed >= CRASH_MAX_TRIES) {
        res.log.push(`崩盤規則${label}的檢視已經 ${runs.failed} 次沒有結論，不再開`);
        continue;
      }
      const s = need.kind === 'PREVIEW' && snap?.month === need.month ? snap : ((await loadSnapshot(env.DB, need.month)) ?? (await buildSnapshot(env.DB, fetcher, acct, view, need.month)));
      const preface = need.kind === 'PREVIEW' ? `這是依 ${need.basis} 的收盤預估的：訊號日（${signal}）收盤如果仍在均線的同一側，規則會切換。` : undefined;
      await start(sc, s, need.direction, need.month, { kind: need.kind, basis: need.basis, try: runs.failed + 1 }, preface);
      if (need.kind === 'MAKEUP') res.log.push(`崩盤規則${label}：月報之後補開檢視（第 ${runs.failed + 1} 次）`);
    }
  } catch (e) {
    res.log.push(`崩盤規則檢視沒有開成：${errText(e)}`);
  }
}

/** 月報那一行：這個月同方向、3 票一致的檢視（連同是哪一次執行）。 */
export async function crashOpinionFor(db: D1Database, month: string, direction: CrashDirection): Promise<{ opinion: '照做' | '延後'; runId: string } | null> {
  if (direction === 'NONE') return null;
  const rows = (await db.prepare("SELECT run_id, pack FROM ai_runs WHERE fn = ? AND status = 'DONE' ORDER BY as_of DESC, created_at DESC LIMIT 6").bind(CRASH_REVIEW).all<{ run_id: string; pack: string }>()).results;
  for (const r of rows) {
    const d = (JSON.parse(r.pack).rule.detail ?? {}) as { month?: string; direction?: string };
    if (d.month !== month || d.direction !== direction) continue;
    const opinion = crashOpinionOf((await getRun(db, r.run_id))?.outcome ?? null);
    return opinion ? { opinion, runId: r.run_id } : null;
  }
  return null;
}
