// T11：F5／F6 崩盤規則檢視的排程端。
//   月報前一天：抓 FRED、算儀表板（存一份，網站顯示）；如果「今天就是訊號日」崩盤規則會切換 → 開完整檢視（3 票，A2），
//              不會切換 → 開每月評語（一票，只記錄「空頭機率」，擬事件）。
//   月報當天：崩盤規則真的切換、而且有同方向、3 票一致的檢視 → 月報那一項附「AI 檢視：照做／延後」。
//            切換了但沒有事先檢視（前一天預估不會切換）→ 月報出了之後補開一次，結果只在網站。
import { CRASH_REVIEW, breadth, crashOpinionOf, crashPack, dashboardText, macroDashboard, type CrashDirection, type DashRow } from '../ai/crash';
import type { PackDoc } from '../ai/check';
import { newRunId } from '../ai/pack';
import { crashRuleOn, sma, type Account, type MarketView } from '../engine';
import { isLastTradingDayOfMonth, nextTradingDay } from '../data/calendar';
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
  const below = crashRuleOn(c, view.i);
  return below && !acct.rule.crash ? 'ON' : !below && acct.rule.crash ? 'OFF' : 'NONE';
}

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

async function start(sc: StartCtx, snap: MacroSnapshot, direction: CrashDirection, month: string): Promise<void> {
  const { env, fetcher, session, now, res } = sc;
  const news = await newsDoc(fetcher, 'SPY', session).catch(() => null);
  const facts = snap.rows.filter((r) => r.value !== null).map((r, k) => ({ id: `M${k + 1}`, label: r.label, value: `${r.value!.toFixed(2)}（${r.date}）`, note: [r.change6m === null ? null : `6 個月變化 ${r.change6m >= 0 ? '+' : ''}${r.change6m.toFixed(2)}`, r.derived].filter(Boolean).join('；') || undefined })).map((f) => (f.note === undefined ? { id: f.id, label: f.label, value: f.value } : f));
  const { pack, notes } = crashPack({ runId: newRunId(session, CRASH_REVIEW), asOf: session, direction, dashboard: snapshotDoc(snap), news: news ? { ...news, title: '大盤相關的新聞標題（SPY，Nasdaq RSS，只有標題）' } : null, facts, dataQuality: { macro: snap.missing.length > 4 ? 'missing' : snap.missing.length ? 'partial' : 'ok', news: 'partial' }, now });
  pack.rule.detail = { ...(pack.rule.detail as object), month };
  res.started.push((await startRun(env, fetcher, pack, now, [...notes, ...(snap.missing.length ? [`FRED 抓不到：${snap.missing.join('、')}`] : [])])).runId);
}

/** 月報前一天開檢視（或每月評語）；月報當天切換了卻沒有事先檢視 → 補開。 */
export async function startCrashRuns(sc: StartCtx): Promise<void> {
  const { env, fetcher, acct, view, session, ov, now, res } = sc;
  try {
    const signal = nextTradingDay(session, ov);
    if (isLastTradingDayOfMonth(signal, ov)) {
      const month = monthOfSignal(signal, ov);
      const snap = await buildSnapshot(env.DB, fetcher, acct, view, month);
      await saveSnapshot(env.DB, snap, now);
      await start(sc, snap, crashDirection(acct, view), month);
      return;
    }
    if (isLastTradingDayOfMonth(session, ov)) {
      const month = monthOfSignal(session, ov);
      const m = acct.notifs.find((n) => n.monthly?.input.month === month);
      const it = m?.items.find((i) => i.f === 'F5' || i.f === 'F6');
      if (!it || it.aiLine) return;
      const dir: CrashDirection = it.f === 'F5' ? 'ON' : 'OFF';
      const done = await env.DB.prepare('SELECT 1 AS x FROM ai_runs WHERE fn = ? AND as_of = ? LIMIT 1').bind(CRASH_REVIEW, session).first();
      if (done) return;
      const snap = (await loadSnapshot(env.DB, month)) ?? (await buildSnapshot(env.DB, fetcher, acct, view, month));
      await start(sc, snap, dir, month);
      res.log.push(`崩盤規則${dir === 'ON' ? '啟動' : '解除'}但前一天沒有預估到：補開檢視（結果只在網站）`);
    }
  } catch (e) {
    res.log.push(`崩盤規則檢視沒有開成：${errText(e)}`);
  }
}

/** 月報那一行：這個月同方向、3 票一致的檢視。 */
export async function crashOpinionFor(db: D1Database, month: string, direction: CrashDirection): Promise<'照做' | '延後' | null> {
  if (direction === 'NONE') return null;
  const rows = (await db.prepare("SELECT run_id, pack FROM ai_runs WHERE fn = ? AND status = 'DONE' ORDER BY as_of DESC, created_at DESC LIMIT 6").bind(CRASH_REVIEW).all<{ run_id: string; pack: string }>()).results;
  for (const r of rows) {
    const d = (JSON.parse(r.pack).rule.detail ?? {}) as { month?: string; direction?: string };
    if (d.month !== month || d.direction !== direction) continue;
    return crashOpinionOf((await getRun(db, r.run_id))?.outcome ?? null);
  }
  return null;
}
