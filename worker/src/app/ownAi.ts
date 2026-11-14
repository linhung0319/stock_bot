// T10：F24 自選定期審查、F25 自選條件監測（每日流程的 AI 段在 src/app/aiStep.ts）。
//
//   套用（applyOwnReview／applyOwnCondition）：F24 → 引擎記下檔位（月報並列建議）＋替換監測條件；F25 → 條件成立的當天通知
//   財報條件（ownXbrlConditions）：新的 10-Q／10-K → 程式直接比對 XBRL（不用 LLM）；降級條件成立 → 當天通知
//   開新的執行（startOwnRuns）：新申報是事件條件指定的確認來源 → F25；新的財報（10-Q、10-K、8-K 2.02）→ F24（財報後的審查）；
//                               月報前一天（當月倒數第二個交易日）→ 每檔自選開一次 F24（月報那天用它的結論）
// 雲端排程（ROUTINE_FIRE_URL／ROUTINE_TOKEN）還沒設定時不開新的執行；EDGAR 的 User-Agent 沒設定時不看申報。
import type { PackDoc } from '../ai/check';
import { OWN_CONDITION, OWN_REVIEW, conditionDecision, conditionPack, ownReviewPack, reviewDecision, type ConditionDraft, type OwnCondition } from '../ai/ownReview';
import { newRunId } from '../ai/pack';
import { TIER_NAME, conditionMet, recordAiTier, type Account, type MarketView, type Tier } from '../engine';
import { isLastTradingDayOfMonth, nextTradingDay } from '../data/calendar';
import { fetchCompanyFacts, fetchFilingDoc, fetchHeadlines, isEarningsFiling, quarterTable, quarterTableText, xbrlConditionMet, XBRL_METRICS, type QuarterRow } from '../data/edgar';
import { fetchEdgarSubmissions, type Filing } from '../data/sources';
import { errText } from '../data/util';
import type { ApplyCtx, StartCtx } from './aiCtx';
import { getRun, startRun, type AiRun } from './aiRuns';
import type { Env, Fetcher } from './env';
import { cikFor, type FilingCheck } from './filings';

export { cikFor } from './filings';

export const routineReady = (env: Env) => !!(env.ROUTINE_FIRE_URL && env.ROUTINE_TOKEN);

// ---------------------------------------------------------------- 條件的儲存

interface CondRow {
  id: number;
  ticker: string;
  run_id: string;
  cond_id: string;
  direction: string;
  kind: string;
  text: string;
  check_json: string;
  tier_if_met: string | null;
  status: string;
  created_at: string;
  met_at: string | null;
  note: string | null;
  origin: string;
}
const toCond = (r: CondRow): OwnCondition & { id: number; origin: 'AI' | 'USER' } => ({
  id: r.id,
  ticker: r.ticker,
  runId: r.run_id,
  condId: r.cond_id,
  direction: r.direction as OwnCondition['direction'],
  kind: r.kind as OwnCondition['kind'],
  text: r.text,
  check: JSON.parse(r.check_json),
  tierIfMet: r.tier_if_met as Tier | null,
  status: r.status as OwnCondition['status'],
  createdAt: r.created_at,
  metAt: r.met_at,
  note: r.note,
  origin: r.origin === 'USER' ? 'USER' : 'AI',
});

/** 某一檔目前的條件（監測中、已成立、只記錄的；被替換的不算）。 */
export async function loadConditions(db: D1Database, ticker?: string): Promise<(OwnCondition & { id: number; origin: 'AI' | 'USER' })[]> {
  const q = ticker ? db.prepare("SELECT * FROM own_conditions WHERE ticker = ? AND status != 'REPLACED' ORDER BY id").bind(ticker) : db.prepare("SELECT * FROM own_conditions WHERE status != 'REPLACED' ORDER BY id");
  return (await q.all<CondRow>()).results.map(toCond);
}

const isAuto = (c: ConditionDraft) => !c.manual && c.kind !== 'PRICE' && (c.kind !== 'XBRL' || String(c.check.metric) in XBRL_METRICS);

/** F24 的新條件整組替換舊的（只換 AI 寫的；使用者在 F14 寫的出場條件不換）。 */
function replaceStmts(db: D1Database, ticker: string, runId: string, drafts: ConditionDraft[], at: string, metPrev: string[]): D1PreparedStatement[] {
  const stmts: D1PreparedStatement[] = [];
  if (metPrev.length) stmts.push(db.prepare(`UPDATE own_conditions SET status = 'MET', met_at = ?, note = ? WHERE ticker = ? AND status = 'ACTIVE' AND origin = 'AI' AND cond_id IN (${metPrev.map(() => '?').join(',')})`).bind(at, `F24 ${runId} 認為已成立`, ticker, ...metPrev));
  stmts.push(db.prepare("UPDATE own_conditions SET status = 'REPLACED' WHERE ticker = ? AND origin = 'AI' AND status IN ('ACTIVE', 'MANUAL', 'MET')").bind(ticker));
  stmts.push(...insertConditionStmts(db, ticker, runId, drafts, at, 'AI'));
  return stmts;
}

/** 寫入條件（F24 的 AI 條件、F14 使用者確認過的出場條件）。 */
export function insertConditionStmts(db: D1Database, ticker: string, runId: string, drafts: ConditionDraft[], at: string, origin: 'AI' | 'USER'): D1PreparedStatement[] {
  const ins = db.prepare('INSERT INTO own_conditions (ticker, run_id, cond_id, direction, kind, text, check_json, tier_if_met, status, created_at, note, origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  return drafts.map((c) => {
    const auto = isAuto(c);
    return ins.bind(ticker, runId, c.condId, c.direction, c.kind, c.text, JSON.stringify(c.check), c.tierIfMet, auto ? 'ACTIVE' : 'MANUAL', at, auto ? null : c.kind === 'PRICE' ? '價格條件只記錄' : '沒有通過檢查，只記錄', origin);
  });
}

const metStmt = (db: D1Database, id: number, at: string, note: string) => db.prepare("UPDATE own_conditions SET status = 'MET', met_at = ?, note = ? WHERE id = ?").bind(at, note, id);

// ---------------------------------------------------------------- 證據

export interface OwnEvidence {
  cik: string | null;
  filings: Filing[];
  rows: QuarterRow[];
  xbrl: PackDoc | null;
  docs: PackDoc[];
  news: PackDoc | null;
  dataQuality: Record<string, 'ok' | 'partial' | 'missing'>;
  notes: string[];
}

export const docOf = (f: { accession: string; form: string; filingDate: string; url: string; title: string; text: string }): PackDoc => ({ id: `F-${f.accession}`, source_id: `edgar:${f.accession}`, kind: 'filing', date: f.filingDate, title: f.title, url: f.url, text: f.text, fetched_at: new Date().toISOString() });

/** XBRL 季度表的原文（證據包用）。 */
export const xbrlDoc = (ticker: string, rows: QuarterRow[]): PackDoc | null => (rows.length ? { id: `X-${ticker}`, source_id: `xbrl:${ticker}`, kind: 'xbrl', date: rows[0].filed, title: `${ticker} 最近 ${rows.length} 季財報數字（XBRL）`, text: quarterTableText(ticker, rows) } : null);

/** 新聞標題的原文（只有標題，只能當初判）。 */
export async function newsDoc(fetcher: Fetcher, ticker: string, asOf: string, since?: string): Promise<PackDoc | null> {
  const hl = (await fetchHeadlines(fetcher, ticker)).filter((h) => h.date <= asOf && (!since || h.date > since)).slice(0, 15);
  return hl.length ? { id: `N-${ticker}`, source_id: `nasdaq-rss:${ticker}`, kind: 'news', date: hl[0].date, title: `${ticker} 最近的新聞標題（Nasdaq RSS，只有標題）`, text: hl.map((h) => `${h.date} | ${h.title}`).join('\n') } : null;
}

/**
 * F24 的證據：XBRL 最近 8 季、最近一份 10-Q 或 10-K 的 MD&A、最近 120 天內的 8-K 2.02 新聞稿、Nasdaq 新聞標題。
 * 申報與 XBRL 抓不到 → data_quality 標 missing（AI 只能說明，不能改變下單）；新聞只有標題，抓不到標 partial。
 */
export async function gatherOwnEvidence(env: Env, fetcher: Fetcher, ticker: string, asOf: string): Promise<OwnEvidence> {
  const ua = env.EDGAR_USER_AGENT ?? '';
  const out: OwnEvidence = { cik: null, filings: [], rows: [], xbrl: null, docs: [], news: null, dataQuality: {}, notes: [] };
  try {
    out.cik = await cikFor(env, fetcher, ticker);
    if (!out.cik) throw new Error('找不到 CIK');
    if (!ua) throw new Error('沒有設定 EDGAR 的 User-Agent');
    const sub = await fetchEdgarSubmissions(fetcher, out.cik, ua);
    out.filings = sub.filings.filter((f) => f.filingDate <= asOf);
    const periodic = out.filings.find((f) => /^10-[QK]/.test(f.form));
    const cutoff = new Date(Date.parse(asOf) - 120 * 86400_000).toISOString().slice(0, 10);
    const pr = out.filings.find((f) => f.form.startsWith('8-K') && f.items.includes('2.02') && f.filingDate >= cutoff);
    for (const f of [periodic, pr].filter((x): x is Filing => !!x)) {
      try {
        out.docs.push(docOf(await fetchFilingDoc(fetcher, out.cik, f, ua)));
      } catch (e) {
        out.notes.push(`${f.form} ${f.accession} 抓不到：${errText(e)}`);
      }
    }
    out.dataQuality.filings = out.docs.length ? 'ok' : 'missing';
  } catch (e) {
    out.notes.push(`申報：${errText(e)}`);
    out.dataQuality.filings = 'missing';
  }
  try {
    if (!out.cik || !ua) throw new Error('沒有 CIK 或 User-Agent');
    out.rows = quarterTable(await fetchCompanyFacts(fetcher, out.cik, ua), asOf);
    if (!out.rows.length) throw new Error('沒有季度數字');
    out.xbrl = xbrlDoc(ticker, out.rows);
    out.dataQuality.xbrl = 'ok';
  } catch (e) {
    out.notes.push(`XBRL：${errText(e)}`);
    out.dataQuality.xbrl = 'missing';
  }
  try {
    out.news = await newsDoc(fetcher, ticker, asOf);
    out.dataQuality.news = 'partial';
  } catch (e) {
    out.notes.push(`新聞標題：${errText(e)}`);
    out.dataQuality.news = 'partial';
  }
  return out;
}

/** 開一次 F24。 */
export async function startOwnReview(env: Env, fetcher: Fetcher, acct: Account, view: MarketView, axis: string[], ticker: string, trigger: 'MONTHLY' | 'EARNINGS' | 'MANUAL', now: Date, evidence?: OwnEvidence): Promise<AiRun> {
  const ev = evidence ?? (await gatherOwnEvidence(env, fetcher, ticker, view.date));
  const previous = (await loadConditions(env.DB, ticker)).filter((c) => c.origin === 'AI');
  const { pack, notes } = ownReviewPack({ acct, view, axis, ticker, runId: newRunId(view.date, OWN_REVIEW, ticker), trigger, xbrl: ev.xbrl, filings: ev.docs, news: ev.news, previous, dataQuality: ev.dataQuality, now });
  return startRun(env, fetcher, pack, now, [...ev.notes, ...notes]);
}

// ---------------------------------------------------------------- 套用結論

/** 降級條件成立 → 當天通知（引擎每檔每月最多 1 則）。 */
function notifyCondition(ctx: ApplyCtx, ticker: string, tier: Tier, text: string, label: string): void {
  const r = conditionMet(ctx.acct, ctx.view, ticker, tier, text, ctx.view.date.slice(0, 7));
  ctx.acct = r.acct;
  ctx.log.push(`${label} → ${r.notif ? `當天通知 #${r.notif.id}` : `不通知（${r.why}）`}`);
}

/** F24 → 引擎記下檔位（月報並列建議）＋替換監測條件。 */
export async function applyOwnReview(ctx: ApplyCtx, run: AiRun): Promise<void> {
  const t = run.ticker ?? '';
  if (!run.outcome || !ctx.acct.own[t]) return void ctx.log.push(`${run.runId}：${ctx.acct.own[t] ? '沒有結論' : '已經不是自選股'}，不套用`);
  const d = reviewDecision(run.outcome, ctx.acct, t, run.asOf);
  if (d.tier) {
    ctx.acct = recordAiTier(ctx.acct, t, d.tier, run.asOf, d.suggest, run.runId);
    // 新的條件取代舊的：上一次成立的降級條件已經被這次審查處理過（F8 不再註明）
    ctx.acct.own[t].metConds = [];
    ctx.stmts.push(...replaceStmts(ctx.db, t, run.runId, d.conditions, ctx.now.toISOString(), d.metPrevious));
  }
  ctx.log.push(`${run.runId}：${d.tier ? TIER_NAME[d.tier] : '不更新'}${d.suggest ? '（月報並列）' : ''}。${d.why}`);
}

/** F25 → 條件成立的當天通知。 */
export async function applyOwnCondition(ctx: ApplyCtx, run: AiRun): Promise<void> {
  const t = run.ticker ?? '';
  if (!run.outcome || !ctx.acct.own[t]) return void ctx.log.push(`${run.runId}：${ctx.acct.own[t] ? '沒有結論' : '已經不是自選股'}，不套用`);
  const d = conditionDecision(run.outcome);
  if (!d.condId) return void ctx.log.push(`${run.runId}：${d.why}`);
  const cond = (await loadConditions(ctx.db, t)).find((c) => c.condId === d.condId && c.status === 'ACTIVE');
  if (!cond) return void ctx.log.push(`${run.runId}：條件 ${d.condId} 已經不在監測中（被新的審查替換），不通知`);
  ctx.stmts.push(metStmt(ctx.db, cond.id, ctx.now.toISOString(), `F25 ${run.runId} 3 票確認`));
  if (cond.direction === 'DOWN' && cond.tierIfMet) notifyCondition(ctx, t, cond.tierIfMet, cond.text, `${run.runId}：條件 ${d.condId} 成立`);
  else ctx.log.push(`${run.runId}：升級條件 ${d.condId} 成立 → 下一次審查會看到`);
}

/** 新的 10-Q／10-K：財報條件由程式直接比對 XBRL（不用 LLM）。 */
export async function ownXbrlConditions(ctx: ApplyCtx, facts: Map<string, QuarterRow[]>): Promise<void> {
  for (const [t, rows] of facts) {
    for (const c of (await loadConditions(ctx.db, t)).filter((x) => x.kind === 'XBRL' && x.status === 'ACTIVE')) {
      const m = xbrlConditionMet(rows, c.check as { type: string; metric: string; level: number; quarters?: number });
      if (!m?.met) continue;
      ctx.stmts.push(metStmt(ctx.db, c.id, ctx.now.toISOString(), `新財報（${rows[0].form} ${rows[0].filed}）：${m.values.map((v) => (v === null ? '—' : v.toFixed(4))).join('、')}`));
      if (c.direction === 'DOWN' && c.tierIfMet) notifyCondition(ctx, t, c.tierIfMet, c.text, `${t} 財報條件 ${c.condId} 成立（程式比對 XBRL）`);
      else ctx.log.push(`${t} 升級的財報條件 ${c.condId} 成立 → 下一次審查會看到`);
    }
  }
}

/** 自選股有新的 10-Q／10-K → 抓 XBRL（財報條件用）。 */
export async function ownFacts(env: Env, fetcher: Fetcher, checks: FilingCheck[], own: Set<string>, session: string, log: string[]): Promise<Map<string, QuarterRow[]>> {
  const facts = new Map<string, QuarterRow[]>();
  for (const c of checks) {
    if (!own.has(c.ticker) || !c.fresh.some((f) => /^10-[QK]/.test(f.form))) continue;
    try {
      facts.set(c.ticker, quarterTable(await fetchCompanyFacts(fetcher, c.cik, env.EDGAR_USER_AGENT!), session));
    } catch (e) {
      log.push(`${c.ticker} 的 XBRL 抓不到：${errText(e)}`);
    }
  }
  return facts;
}

// ---------------------------------------------------------------- 開新的執行

/** F25（新申報對上事件條件）、F24（新財報、月報前一天）。 */
export async function startOwnRuns(sc: StartCtx): Promise<void> {
  const { env, fetcher, acct, view, axis, session, ov, now, res } = sc;
  const tickers = Object.keys(acct.own);
  const review = new Map<string, 'EARNINGS' | 'MONTHLY'>();
  for (const c of sc.checks) {
    if (!acct.own[c.ticker]) continue;
    const events = (await loadConditions(env.DB, c.ticker)).filter((x) => x.kind === 'EVENT' && x.status === 'ACTIVE');
    const confirm = new Set(events.flatMap((x) => ((x.check.confirm_by as string[] | undefined) ?? []).map((s) => (s === 'SEC' ? '8-K' : s))));
    const relevant = c.fresh.filter((f) => [...confirm].some((k) => f.form.startsWith(k))).slice(0, 3);
    if (events.length && relevant.length) {
      try {
        const docs = await Promise.all(relevant.map(async (f) => docOf(await fetchFilingDoc(fetcher, c.cik, f, env.EDGAR_USER_AGENT!))));
        const { pack, notes } = conditionPack({ acct, view, ticker: c.ticker, runId: newRunId(session, OWN_CONDITION, c.ticker), conditions: events, filings: docs, now });
        res.started.push((await startRun(env, fetcher, pack, now, notes)).runId);
      } catch (e) {
        res.log.push(`${c.ticker} 的條件監測沒有開成：${errText(e)}`);
      }
    }
    if (c.fresh.some(isEarningsFiling)) review.set(c.ticker, 'EARNINGS');
  }
  if (isLastTradingDayOfMonth(nextTradingDay(session, ov), ov)) for (const t of tickers) if (!review.has(t)) review.set(t, 'MONTHLY');
  for (const [t, trigger] of review) {
    try {
      res.started.push((await startOwnReview(env, fetcher, acct, view, axis, t, trigger, now)).runId);
    } catch (e) {
      res.log.push(`${t} 的定期審查沒有開成：${errText(e)}`);
      res.alerts.push({ kind: 'FLOW_ERROR', message: `${t} 的 AI 定期審查沒有開成：${errText(e)}` });
    }
  }
}

/** 最近一次 F24 的結論（F7 的「以最近一次 F24 為底」）。 */
export async function lastReview(db: D1Database, ticker: string): Promise<AiRun | null> {
  const r = await db.prepare("SELECT run_id FROM ai_runs WHERE fn = ? AND ticker = ? AND status = 'DONE' ORDER BY as_of DESC, created_at DESC LIMIT 1").bind(OWN_REVIEW, ticker).first<{ run_id: string }>();
  return r ? getRun(db, r.run_id) : null;
}
