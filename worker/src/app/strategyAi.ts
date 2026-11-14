// T11：F21 策略檢討（設計 §7）。規則段（每天前進、提醒）在每日流程的 processSessions 裡；這裡是提醒之後開的 AI 說明。
import type { PackDoc } from '../ai/check';
import { newRunId } from '../ai/pack';
import { STRATEGY_REVIEW, drawdownEpisodes, fetchFrenchMomentum, historyTable, strategyPack } from '../ai/strategy';
import { initialReviewState, type StrategyReviewState } from '../engine';
import type { StartCtx } from './aiCtx';
import { startRun } from './aiRuns';

export const STRATEGY_STATE_KEY = 'strategyReview';

export async function loadStrategyState(db: D1Database): Promise<StrategyReviewState> {
  const r = await db.prepare('SELECT value FROM flow_state WHERE key = ?').bind(STRATEGY_STATE_KEY).first<{ value: string }>();
  return r ? (JSON.parse(r.value) as StrategyReviewState) : initialReviewState();
}

/** 這次每日流程有策略檢討的提醒 → 開一次 AI 說明（一票，Opus；不給停用或繼續的建議）。 */
export async function startStrategyRun(sc: StartCtx): Promise<void> {
  const alerts = sc.extras.strategyAlerts ?? [];
  if (!alerts.length) return;
  const { env, fetcher, session, now, res } = sc;
  const st = await loadStrategyState(env.DB);
  const depth = st.rel / st.peak - 1;
  let history: PackDoc | null = null;
  const dq: Record<string, 'ok' | 'partial' | 'missing'> = {};
  try {
    const rets = await fetchFrenchMomentum(fetcher);
    const h = historyTable(drawdownEpisodes(rets), depth);
    history = { id: 'HIST', source_id: 'french:umd', kind: 'table', date: rets.at(-1)?.month ? `${rets.at(-1)!.month}-28` : session, title: 'French 動能因子的歷史回撤（同等深度以上）', text: h.text };
    if (history.date > session) history.date = session;
    dq.history = 'ok';
  } catch (e) {
    dq.history = 'missing';
    res.log.push(`French 資料庫抓不到：${e instanceof Error ? e.message : String(e)}`);
  }
  const relDoc: PackDoc = { id: 'REL', source_id: `rel:${session}`, kind: 'table', date: session, title: '動能部位相對基準', text: `relative wealth ${st.rel.toFixed(4)}, peak ${st.peak.toFixed(4)}, drawdown ${(depth * 100).toFixed(1)}%, event since ${st.eventStart ?? '-'}; thresholds notified ${st.notified.map((x) => `${x * 100}%`).join(', ')}` };
  const { pack, notes } = strategyPack({ runId: newRunId(session, STRATEGY_REVIEW), asOf: session, alert: alerts.map((a) => a.text).join('；'), relDrawdown: depth, eventStart: st.eventStart, history, relDoc, dataQuality: dq, now });
  res.started.push((await startRun(env, fetcher, pack, now, notes)).runId);
}
