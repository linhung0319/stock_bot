// T11：F14 新增自選股的健檢（網站觸發）。
//   請 AI 草擬前提（使用者沒寫理由）／把使用者寫的出場條件改寫成可追蹤的格式 → 網站等結果、讓使用者勾選。
//   使用者確認的出場條件 → own_conditions（origin = USER，不會被之後的 F24 換掉），由 F25 監測。
import type { PackDoc } from '../ai/check';
import { OWN_CHECK, ownCheckPack, ownCheckResult, type OwnCheckResult } from '../ai/ownCheck';
import { newRunId, priceDoc, priceFacts } from '../ai/pack';
import { recommendStdWeights, type Account, type MarketView } from '../engine';
import { errText } from '../data/util';
import { getRun, startRun, type AiRun } from './aiRuns';
import type { Env, Fetcher } from './env';
import { entryEvidence } from './momAi';
import { gatherOwnEvidence, insertConditionStmts, loadConditions, routineReady } from './ownAi';

/** 一年日報酬的相關係數（和既有持股的題材重疊，F14 卡片的 theme_overlap）。 */
export function corr1y(view: MarketView, a: string, b: string): number | null {
  const ca = view.close[a];
  const cb = view.close[b];
  if (!ca || !cb) return null;
  const xs: number[] = [];
  const ys: number[] = [];
  for (let k = Math.max(1, view.i - 251); k <= view.i; k++) {
    const x = ca[k] / ca[k - 1] - 1;
    const y = cb[k] / cb[k - 1] - 1;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    xs.push(x);
    ys.push(y);
  }
  if (xs.length < 120) return null;
  const mx = xs.reduce((s, v) => s + v, 0) / xs.length;
  const my = ys.reduce((s, v) => s + v, 0) / ys.length;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let k = 0; k < xs.length; k++) {
    sxy += (xs[k] - mx) * (ys[k] - my);
    sxx += (xs[k] - mx) ** 2;
    syy += (ys[k] - my) ** 2;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}

export async function startOwnCheck(env: Env, fetcher: Fetcher, acct: Account, view: MarketView, axis: string[], ticker: string, lines: string[], now: Date): Promise<AiRun> {
  if (!routineReady(env)) throw new Error('AI 層的雲端排程還沒設定（SETUP.md 的 T5），沒辦法請 AI 健檢');
  const ev = await gatherOwnEvidence(env, fetcher, ticker, view.date);
  const entry = await entryEvidence(env, fetcher, view, axis, ticker, acct.cfg.coreTicker, false).catch(() => null);
  const holdings = [...new Set([...Object.keys(acct.own), ...Object.keys(acct.lots.mom)])].filter((t) => t !== ticker);
  const overlap = holdings
    .map((t) => ({ t, c: corr1y(view, ticker, t) }))
    .filter((x): x is { t: string; c: number } => x.c !== null)
    .sort((a, b) => b.c - a.c)
    .slice(0, 3);
  const rec = (() => {
    try {
      return recommendStdWeights(view, [...Object.keys(acct.own), ticker], acct.cfg.ratio.own)[ticker];
    } catch {
      return undefined;
    }
  })();
  const facts = [
    ...priceFacts(view, ticker),
    ...(rec ? [{ id: 'W1', label: '建議的標準比重', value: `${(rec * 100).toFixed(1)}%` }] : []),
    ...overlap.map((x, k) => ({ id: `O${k + 1}`, label: `和 ${x.t} 的一年日報酬相關係數`, value: x.c.toFixed(2), note: x.c > 0.7 ? '高度相關：可能是同一個題材' : undefined })).map((f) => (f.note === undefined ? { id: f.id, label: f.label, value: f.value } : f)),
  ];
  const docs = [priceDoc(view, axis, ticker, 60), ev.xbrl, ...ev.docs, ev.news].filter((d): d is PackDoc => !!d);
  const { pack, notes } = ownCheckPack({ runId: newRunId(view.date, OWN_CHECK, ticker), asOf: view.date, ticker, lines: lines.map((l) => l.trim()).filter(Boolean).slice(0, 6), facts, hits: entry?.hits ?? [], docs, dataQuality: ev.dataQuality, now });
  return startRun(env, fetcher, pack, now, [...ev.notes, ...(entry?.notes ?? []), ...notes]);
}

export interface OwnCheckView extends OwnCheckResult {
  runId: string;
  status: 'PENDING' | 'DONE';
  mode: 'DRAFT' | 'REWRITE';
  /** 已經確認開始監測的條件編號。 */
  accepted: string[];
}

export async function ownCheckView(env: Env, runId: string, now: Date): Promise<OwnCheckView | null> {
  const run = await getRun(env.DB, runId, now);
  if (!run || run.fn !== OWN_CHECK) return null;
  const r = ownCheckResult(run.outcome, run.ticker ?? '');
  const accepted = (await env.DB.prepare("SELECT cond_id FROM own_conditions WHERE run_id = ? AND origin = 'USER'").bind(runId).all<{ cond_id: string }>()).results.map((x) => x.cond_id);
  return { ...r, runId, status: run.status, mode: (run.pack.rule.detail as { mode: 'DRAFT' | 'REWRITE' }).mode, accepted };
}

/** 這一檔最近一次健檢。 */
export async function latestOwnCheck(env: Env, ticker: string, now: Date): Promise<OwnCheckView | null> {
  const r = await env.DB.prepare('SELECT run_id FROM ai_runs WHERE fn = ? AND ticker = ? ORDER BY created_at DESC LIMIT 1').bind(OWN_CHECK, ticker).first<{ run_id: string }>();
  return r ? ownCheckView(env, r.run_id, now) : null;
}

/** 使用者勾選的出場條件 → 開始監測（origin = USER）。回傳寫入幾條。 */
export async function acceptOwnConditions(env: Env, ticker: string, runId: string, ids: string[], now: Date): Promise<number> {
  const v = await ownCheckView(env, runId, now);
  if (!v || v.status !== 'DONE') throw new Error('這次健檢還沒有結果');
  const pick = v.conditions.filter((c) => ids.includes(c.condId) && !v.accepted.includes(c.condId));
  if (!pick.length) return 0;
  const stmts = insertConditionStmts(env.DB, ticker, runId, pick, now.toISOString(), 'USER');
  await env.DB.batch(stmts);
  return pick.length;
}

/** 持股頁要顯示的監測條件。 */
export async function monitorView(env: Env, ticker: string): Promise<{ text: string; kind: string; origin: string; status: string; note: string | null }[]> {
  try {
    return (await loadConditions(env.DB, ticker)).map((c) => ({ text: c.text, kind: { XBRL: '財報', EVENT: '事件', PRICE: '價格' }[c.kind] ?? c.kind, origin: c.origin === 'USER' ? '你寫的' : 'AI 寫的', status: { ACTIVE: '監測中', MET: '已成立', MANUAL: '只記錄', REPLACED: '已替換' }[c.status] ?? c.status, note: c.note }));
  } catch (e) {
    return [{ text: `讀不到：${errText(e)}`, kind: '', origin: '', status: '', note: null }];
  }
}
