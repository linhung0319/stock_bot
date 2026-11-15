// T11：F21 策略檢討（設計 §7）。規則段（每天前進、提醒）在每日流程的 processSessions 裡；這裡是提醒之後開的 AI 說明。
// T32d（momentum_ai §3.8）：歷史回撤對照由程式直接放在提醒上（AI 沒設定、沒回來也看得到）；AI 說明沒有結論時通知頁寫「AI 說明沒有回來」，不重開。
import type { PackDoc } from '../ai/check';
import { newRunId } from '../ai/pack';
import { STRATEGY_REVIEW, drawdownEpisodes, fetchFrenchMomentum, historyTable, strategyPack } from '../ai/strategy';
import { clone, initialReviewState, type Account, type StrategyReviewState } from '../engine';
import { errText } from '../data/util';
import type { ApplyCtx, StartCtx, StrategyHistory } from './aiCtx';
import { startRun, type AiRun } from './aiRuns';
import type { Fetcher } from './env';
import { patchAccount } from './ledgerStore';

export const STRATEGY_STATE_KEY = 'strategyReview';

export async function loadStrategyState(db: D1Database): Promise<StrategyReviewState> {
  const r = await db.prepare('SELECT value FROM flow_state WHERE key = ?').bind(STRATEGY_STATE_KEY).first<{ value: string }>();
  return r ? (JSON.parse(r.value) as StrategyReviewState) : initialReviewState();
}

/** 提醒上的歷史對照那一句（momentum_ai §3.8）。sameDepth：同等深度以上的回撤次數；median：從高點到創新高的月數中位數（都還沒回到高點是 null）。 */
export function historyLine(depth: number, sameDepth: number, median: number | null): string {
  const d = `${(depth * 100).toFixed(0)}%`;
  if (!sameDepth) return `歷史對照（French 動能因子，多空，只是近似）：同等深度（${d}）以上的回撤沒有出現過。`;
  return `歷史對照（French 動能因子，多空，只是近似）：同等深度（${d}）以上的回撤有 ${sameDepth} 次${median === null ? '，都還沒有回到高點' : `，從高點到創新高的月數中位數是 ${median}`}。`;
}

/** 抓 French 動能因子、算同等深度的回撤（不管雲端排程有沒有設定都做）。抓不到：doc 是 null，line 寫原因。 */
export async function strategyHistory(fetcher: Fetcher, depth: number, session: string): Promise<StrategyHistory> {
  try {
    const rets = await fetchFrenchMomentum(fetcher);
    const h = historyTable(drawdownEpisodes(rets), depth);
    const doc: PackDoc = { id: 'HIST', source_id: 'french:umd', kind: 'table', date: rets.at(-1)?.month ? `${rets.at(-1)!.month}-28` : session, title: 'French 動能因子的歷史回撤（同等深度以上）', text: h.text };
    if (doc.date > session) doc.date = session;
    return { doc, line: historyLine(depth, h.sameDepth.length, h.medianRecovery) };
  } catch (e) {
    const error = errText(e);
    return { doc: null, line: `歷史對照抓不到（${error}）。`, error };
  }
}

/** 提醒通知接上歷史對照那一句（已經接過的不再接）。回傳新的帳戶（有改的話），沒改回傳 null。 */
export function withHistory(acct: Account, notifIds: number[], line: string): Account | null {
  const want = notifIds.filter((id) => {
    const n = acct.notifs.find((x) => x.id === id);
    return n && !(n.text ?? '').includes('歷史對照');
  });
  if (!want.length) return null;
  const next = clone(acct);
  for (const id of want) {
    const n = next.notifs.find((x) => x.id === id)!;
    n.text = `${n.text ?? ''}\n${line}`;
  }
  return next;
}

/** 這次每日流程有策略檢討的提醒 → 開一次 AI 說明（一票，Opus；不給停用或繼續的建議）。歷史對照沿用 AI 段套用時抓的那一份。 */
export async function startStrategyRun(sc: StartCtx): Promise<void> {
  const alerts = sc.extras.strategyAlerts ?? [];
  if (!alerts.length) return;
  const { env, fetcher, session, now, res } = sc;
  const st = await loadStrategyState(env.DB);
  const depth = st.rel / st.peak - 1;
  const hist = sc.extras.strategyHistory ?? (await strategyHistory(fetcher, depth, session));
  const history = hist.doc;
  const dq: Record<string, 'ok' | 'partial' | 'missing'> = { history: history ? 'ok' : 'missing' };
  if (hist.error) res.log.push(`French 資料庫抓不到：${hist.error}`);
  const relDoc: PackDoc = { id: 'REL', source_id: `rel:${session}`, kind: 'table', date: session, title: '動能部位相對基準', text: `relative wealth ${st.rel.toFixed(4)}, peak ${st.peak.toFixed(4)}, drawdown ${(depth * 100).toFixed(1)}%, event since ${st.eventStart ?? '-'}; thresholds notified ${st.notified.map((x) => `${x * 100}%`).join(', ')}` };
  const { pack, notes } = strategyPack({ runId: newRunId(session, STRATEGY_REVIEW), asOf: session, alert: alerts.map((a) => a.text).join('；'), relDrawdown: depth, eventStart: st.eventStart, history, relDoc, dataQuality: dq, now });
  const run = await startRun(env, fetcher, pack, now, notes);
  res.started.push(run.runId);
  // 提醒通知記下這次執行（通知頁連到報告；沒有結論時 applyStrategyReview 寫「AI 說明沒有回來」）
  const ids = alerts.map((a) => a.notif).filter((x): x is number => x !== undefined);
  if (ids.length)
    await patchAccount(
      env.DB,
      now,
      '策略檢討提醒記下 AI 執行',
      (a0) => {
        const a = clone(a0);
        let changed = false;
        for (const n of a.notifs)
          if (ids.includes(n.id) && !(n.runIds ?? []).includes(run.runId)) {
            n.runIds = [...(n.runIds ?? []), run.runId];
            changed = true;
          }
        return changed ? { acct: a } : null;
      },
      res.log,
    );
}

/** 策略檢討的 AI 說明沒有結論的原因（白話）。 */
const NO_RESULT_WHY: Record<string, string> = { TIMEOUT: '逾時', NO_RESULT: '沒有結果', INVALID: '格式不合格' };

/**
 * F21 的結論（momentum_ai §3.8）：有結論（AGREED、INSUFFICIENT）不動，通知頁照舊連到報告；
 * 沒有結論（逾時、被退回、整票作廢）→ 提醒通知的文字加「AI 說明沒有回來」，不重開（提醒本身與歷史對照已經在）。
 */
export async function applyStrategyReview(ctx: ApplyCtx, run: AiRun): Promise<void> {
  const st = run.outcome?.status ?? 'NO_RESULT';
  if (st === 'AGREED' || st === 'INSUFFICIENT' || st === 'SPLIT') return;
  const hit = ctx.acct.notifs.filter((n) => (n.runIds ?? []).includes(run.runId) && !(n.text ?? '').includes('AI 說明沒有回來'));
  if (!hit.length) return;
  const acct = clone(ctx.acct);
  for (const n of acct.notifs) if (hit.some((x) => x.id === n.id)) n.text = `${n.text ?? ''}\nAI 說明沒有回來（${NO_RESULT_WHY[st] ?? st}），不重開。`;
  ctx.acct = acct;
  ctx.log.push(`${run.runId}：策略檢討的 AI 說明沒有結論（${st}），提醒 #${hit.map((n) => n.id).join('、#')} 註明`);
}
