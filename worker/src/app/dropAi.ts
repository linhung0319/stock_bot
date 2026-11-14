// T11：F7 自選減半的 AI 檢視、F20 持股單月跌 > 20% 的說明（每日流程的 AI 段，src/app/aiStep.ts 呼叫）。
import { verdictText } from '../ai/functions';
import type { PackDoc } from '../ai/check';
import { attribution, highIndex } from '../ai/detect';
import { DROP_EXPLAIN, MONTH_DROP, OWN_DROP, dropDecision, dropExplainPack, explainLine, ownDropPack } from '../ai/drops';
import { newRunId } from '../ai/pack';
import { recordAiTier, refreshOwnAiChoice, type MarketView } from '../engine';
import { fetchFilingDoc } from '../data/edgar';
import type { FilingHit } from '../data/secEvents';
import { errText } from '../data/util';
import type { ApplyCtx, StartCtx } from './aiCtx';
import { startRun, type AiRun } from './aiRuns';
import { insertHitStmts, sectorEtfs } from './filings';
import { docOf, lastReview, newsDoc } from './ownAi';

const ret = (view: MarketView, t: string, n: number) => {
  const c = view.close[t];
  return c && Number.isFinite(c[view.i]) && Number.isFinite(c[view.i - n]) ? c[view.i] / c[view.i - n] - 1 : NaN;
};

/** 最近一次 F24 的摘要（F7 的底）。 */
function baseDoc(run: AiRun | null, ticker: string): PackDoc | null {
  const o = run?.outcome;
  if (!run || !o) return null;
  const s = o.samples.find((x) => x.valid && x.verdict === o.verdict) ?? o.samples.find((x) => x.valid);
  const prem = run.pack.premises.map((p) => `${p.id} ${p.text}: ${s?.premises.find((x) => x.premise_id === p.id)?.status ?? 'INSUFFICIENT'}`);
  const text = [`F24 ${run.runId} as of ${run.asOf}: ${o.status} ${o.verdict ?? '-'} (${verdictText(run.fn, o.verdict)})`, ...prem, '', (s?.report ?? '').slice(0, 3000)].join('\n');
  return { id: `B-${ticker}`, source_id: `review:${run.runId}`, kind: 'note', date: run.asOf, title: `最近一次定期審查（${run.asOf}）的結論`, text };
}

async function recentRun(db: D1Database, fn: string, ticker: string, since: string): Promise<boolean> {
  return !!(await db.prepare('SELECT 1 AS x FROM ai_runs WHERE fn = ? AND ticker = ? AND as_of >= ? LIMIT 1').bind(fn, ticker, since).first());
}

export async function startDropRuns(sc: StartCtx): Promise<void> {
  const { env, fetcher, acct, view, axis, session, now, res } = sc;
  const core = acct.cfg.coreTicker;
  const holdings = [...new Set([...Object.keys(acct.own), ...Object.keys(acct.lots.mom).filter((t) => (acct.lots.mom[t] ?? 0) > 0)])];
  const sectors = await sectorEtfs(env.DB, holdings);
  const filingDocs = async (t: string, since: string, n: number): Promise<PackDoc[]> => {
    const c = sc.checks.find((x) => x.ticker === t);
    if (!c || !env.EDGAR_USER_AGENT) return [];
    const out: PackDoc[] = [];
    for (const f of c.all.filter((x) => x.filingDate > since && (x.form.startsWith('8-K') || /^10-[QK]/.test(x.form))).slice(0, n)) {
      try {
        out.push(docOf(await fetchFilingDoc(fetcher, c.cik, f, env.EDGAR_USER_AGENT)));
      } catch (e) {
        res.log.push(`${t} ${f.form} 抓不到：${errText(e)}`);
      }
    }
    return out;
  };
  // F7：這次新觸發減半的自選股
  for (const r of sc.extras.reduced ?? []) {
    const t = r.ticker;
    if (!acct.own[t] || (await recentRun(env.DB, OWN_DROP, t, r.session))) continue;
    try {
      const c = view.close[t];
      const attr = c ? attribution(axis, view.close, t, core, sectors[t] ?? null, highIndex(c, view.i), view.i) : null;
      const base = await lastReview(env.DB, t);
      const since = base?.asOf ?? new Date(Date.parse(session) - 45 * 86400_000).toISOString().slice(0, 10);
      const docs = await filingDocs(t, since, 3);
      const news = await newsDoc(fetcher, t, session, since).catch(() => null);
      if (news) docs.push(news);
      const urgent = acct.own[t].pending?.action !== 'REDUCE';
      const { pack, notes } = ownDropPack({ acct, view, axis, ticker: t, runId: newRunId(session, OWN_DROP, t), attr, base: baseDoc(base, t), baseRunId: base?.runId ?? null, docs, urgent, dataQuality: { filings: 'ok', news: 'partial', ...(base ? {} : { review: 'partial' }) }, now });
      res.started.push((await startRun(env, fetcher, pack, now, notes)).runId);
    } catch (e) {
      res.log.push(`${t} 的減半檢視沒有開成：${errText(e)}`);
    }
  }
  // F20：最近 21 個交易日跌超過 20% 的持股（同一檔 30 天內只說明一次）
  const since30 = new Date(Date.parse(session) - 30 * 86400_000).toISOString().slice(0, 10);
  for (const t of holdings) {
    const r21 = ret(view, t, 21);
    if (!(r21 <= MONTH_DROP) || (await recentRun(env.DB, DROP_EXPLAIN, t, since30))) continue;
    try {
      const attr = attribution(axis, view.close, t, core, sectors[t] ?? null, view.i - 21, view.i);
      const docs = await filingDocs(t, since30, 2);
      const news = await newsDoc(fetcher, t, session).catch(() => null);
      if (news) docs.push(news);
      const { pack, notes } = dropExplainPack({ view, axis, ticker: t, role: acct.own[t] ? 'OWN' : 'MOM', runId: newRunId(session, DROP_EXPLAIN, t), ret21: r21, attr, docs, dataQuality: { news: 'partial' }, now });
      res.started.push((await startRun(env, fetcher, pack, now, notes)).runId);
    } catch (e) {
      res.log.push(`${t} 的跌幅說明沒有開成：${errText(e)}`);
    }
  }
}

const escalateHit = (run: AiRun, code: string): FilingHit => ({ code, sub: `AI_${run.fn}`, accession: run.runId, form: 'AI', date: run.asOf, acceptedAt: '', byRule: false, detail: `${run.fn === OWN_DROP ? '減半檢視' : '跌幅說明'}的 AI 認為有硬事件，轉交法庭` });

/** F7：3 票一致、和規則不同 → 更新清單上的「AI 建議」（還沒回覆的當天通知會一起更新）。 */
export async function applyOwnDrop(ctx: ApplyCtx, run: AiRun): Promise<void> {
  const t = run.ticker ?? '';
  if (!run.outcome || !ctx.acct.own[t]) return;
  const d = dropDecision(run.outcome);
  if (d.escalate) ctx.stmts.push(...insertHitStmts(ctx.db, t, [escalateHit(run, d.escalate)], 'AI', ctx.now.toISOString(), () => 'NEW'));
  if (!d.tier) return void ctx.log.push(`${run.runId}：${t} 照規則減半（${d.why}）`);
  ctx.acct = recordAiTier(ctx.acct, t, d.tier, run.asOf, false, run.runId);
  const r = refreshOwnAiChoice(ctx.acct, ctx.view, t);
  ctx.acct = r.acct;
  ctx.log.push(`${run.runId}：${t} AI 建議${d.tier === 'EXIT' ? '出清' : '不動'}${r.changed.length ? `（更新通知 #${r.changed.join('、#')} 的 AI 建議）` : ''}`);
}

/** F20：找到硬事件 → 轉交法庭；說明本身由月報讀（monthNotes）。 */
export async function applyDropExplain(ctx: ApplyCtx, run: AiRun): Promise<void> {
  const t = run.ticker ?? '';
  const s = run.outcome?.samples.find((x) => x.valid);
  if (s?.payload?.escalate_to_F19 === true) ctx.stmts.push(...insertHitStmts(ctx.db, t, [escalateHit(run, String(s.payload.escalate_code))], 'AI', ctx.now.toISOString(), () => 'NEW'));
}

/** 這個月份的 F20 說明（附在月報）。 */
export async function monthNotes(db: D1Database, since: string, until: string): Promise<string[]> {
  const rows = (await db.prepare("SELECT run_id, ticker, pack, outcome FROM ai_runs WHERE fn = ? AND status = 'DONE' AND as_of > ? AND as_of <= ? ORDER BY as_of").bind(DROP_EXPLAIN, since, until).all<{ run_id: string; ticker: string; pack: string; outcome: string | null }>()).results;
  return rows.map((r) => explainLine(r.ticker, (JSON.parse(r.pack).rule.detail as { ret21: number }).ret21, r.outcome ? JSON.parse(r.outcome) : null));
}
