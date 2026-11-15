// T10：F24 自選定期審查、F25 自選條件監測（每日流程的 AI 段在 src/app/aiStep.ts）。
//
//   套用（applyOwnReview／applyOwnCondition）：F24 → 引擎記下檔位（月報並列建議）＋建議的條件（PROPOSED，勾選才監測）＋審查確認你定的條件成立；
//                                              F25 → 條件成立的當天通知
//   財報條件（ownXbrlConditions）：新的 10-Q／10-K → 程式直接比對 XBRL（不用 LLM），寫進度；你定的條件成立 → 當天通知
//   開新的執行（startOwnRuns）：新申報是事件條件指定的確認來源 → F25；新的財報（10-Q、10-K、8-K 2.02）→ F24（財報後的審查）；
//                               月報前一天（當月倒數第二個交易日）→ 每檔自選開一次 F24（月報那天用它的結論）；
//                               前提有增減（thesisReviewDue）→ 論點變動後的審查（每檔 30 天 1 次，own_thesis §3.6.5）
// 雲端排程（ROUTINE_FIRE_URL／ROUTINE_TOKEN）還沒設定時不開新的執行；EDGAR 的 User-Agent 沒設定時不看申報。
import type { PackDoc } from '../ai/check';
import { OWN_CONDITION, OWN_REVIEW, confirmMode, conditionDecision, conditionPack, ownReviewPack, reviewDecision, type ConditionDraft, type ProposedDraft } from '../ai/ownReview';
import { newRunId } from '../ai/pack';
import { TIER_NAME, clone, conditionMet, recordAiTier, type Account, type MarketView, type OwnMeta, type Tier } from '../engine';
import { ConflictError, loadAccount, saveAccount } from './ledgerStore';
import { isLastTradingDayOfMonth, nextTradingDay } from '../data/calendar';
import { fetchCompanyFacts, fetchFilingDoc, fetchHeadlines, isEarningsFiling, quarterTable, quarterTableText, xbrlConditionMet, XBRL_METRICS, type QuarterRow } from '../data/edgar';
import { fetchEdgarSubmissions, type Filing } from '../data/sources';
import { errText } from '../data/util';
import type { ApplyCtx, StartCtx } from './aiCtx';
import { getRun, startRun, type AiRun } from './aiRuns';
import type { Env, Fetcher } from './env';
import { cikFor, type FilingCheck } from './filings';
import { MAX_PROPOSED, MAX_REVIEW_8K, afterLastReview, condFacts, defaultAction, defaultFacts, fileConditions, flaggedAccessions, isOwned, notifyTier, pickFilings, thesisFacts, thesisFile, thesisNote, xbrlProgress, type CondAction, type ThesisFile } from './thesis';

export { cikFor } from './filings';
export { loadConditions } from './thesis';

export const routineReady = (env: Env) => !!(env.ROUTINE_FIRE_URL && env.ROUTINE_TOKEN);

// ---------------------------------------------------------------- 條件的儲存

const isAuto = (c: ConditionDraft) => !c.manual && c.kind !== 'PRICE' && (c.kind !== 'XBRL' || String(c.check.metric) in XBRL_METRICS);

/** 現在這份論點檔的條件；沒有 fileId 的舊自選是編號空的列（own_thesis §1.2）。 */
const fileClause = (fileId: string | null) => (fileId ? ['file_id = ?', [fileId]] : ['file_id IS NULL', []]) as [string, unknown[]];

const autoNote = (c: ConditionDraft, auto: boolean, reviewOnly: boolean) => (auto ? (reviewOnly ? '確認來源沒有申報可以讀，只在定期審查時由 AI 判斷' : null) : c.kind === 'PRICE' ? '價格條件只記錄' : '沒有通過檢查，只記錄');

/**
 * 審查建議新增的條件（own_thesis §1.5 第 1、2 點）：寫成 PROPOSED（觀察項，不會自己發通知）。
 * 這次有寫入至少一條時，這份論點檔原本還在 PROPOSED 的標成 EXPIRED；一條都沒提時舊的留著（呼叫的地方判斷）。
 * map：證據包的編號（C…、W…）→ 列編號，把 supersedes 換成列編號。
 */
export function proposeStmts(db: D1Database, ticker: string, fileId: string | null, runId: string, drafts: ProposedDraft[], at: string, map: Record<string, number>): D1PreparedStatement[] {
  if (!drafts.length) return [];
  const [fw, fa] = fileClause(fileId);
  const ins = db.prepare("INSERT INTO own_conditions (ticker, run_id, cond_id, direction, kind, text, check_json, tier_if_met, status, created_at, note, origin, file_id, premise_id, supersedes, auto) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PROPOSED', ?, ?, 'AI', ?, ?, ?, ?)");
  return [
    db.prepare(`UPDATE own_conditions SET status = 'EXPIRED' WHERE ticker = ? AND ${fw} AND status = 'PROPOSED'`).bind(ticker, ...fa),
    ...drafts.slice(0, MAX_PROPOSED).map((c) => {
      const auto = isAuto(c);
      const reviewOnly = auto && confirmMode(c) === 'REVIEW_ONLY';
      return ins.bind(ticker, runId, c.condId, c.direction, c.kind, c.text, JSON.stringify(c.check), c.tierIfMet, at, autoNote(c, auto, reviewOnly), fileId, c.premiseId, c.supersedes && map[c.supersedes] ? map[c.supersedes] : null, auto ? 1 : 0);
    }),
  ];
}

/**
 * 寫入使用者勾選的條件（F14 改寫後勾選的出場條件，origin = USER）：直接是「你定的條件」，帶勾選時間與成立時的動作，
 * 狀態依確認方式（監測中／只在審查時檢查／只記錄）。帶這檔現在的論點檔編號。
 */
export function insertConditionStmts(db: D1Database, ticker: string, runId: string, drafts: (ConditionDraft & { action?: CondAction })[], at: string, origin: 'AI' | 'USER', fileId: string | null): D1PreparedStatement[] {
  const ins = db.prepare('INSERT INTO own_conditions (ticker, run_id, cond_id, direction, kind, text, check_json, tier_if_met, status, created_at, note, origin, file_id, accepted_at, action, auto) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  return drafts.map((c) => {
    const auto = isAuto(c);
    // 確認來源只有法說會、新聞的事件條件沒有申報可以讀：不開 F25，只在定期審查時檢查（T24）
    const reviewOnly = auto && confirmMode(c) === 'REVIEW_ONLY';
    const status = reviewOnly ? 'REVIEW_ONLY' : auto ? 'ACTIVE' : 'MANUAL';
    return ins.bind(ticker, runId, c.condId, c.direction, c.kind, c.text, JSON.stringify(c.check), c.tierIfMet, status, at, autoNote(c, auto, reviewOnly), origin, fileId, at, c.action ?? defaultAction(c), auto ? 1 : 0);
  });
}

/** 條件成立（met_basis：XBRL 程式比對、FILING_VOTE 申報原文三票、REVIEW_VOTE 審查三票）。 */
const metStmt = (db: D1Database, id: number, at: string, note: string, basis: 'XBRL' | 'FILING_VOTE' | 'REVIEW_VOTE') => db.prepare("UPDATE own_conditions SET status = 'MET', met_at = ?, note = ?, met_basis = ? WHERE id = ?").bind(at, note, basis, id);

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

/**
 * F24 的證據包裡由論點檔組的部分（own_thesis §1.6）：T0、事件 V、只有預設前提的 D1～D3、論點那一份 note，
 * 以及上次有結論的審查之後的 8-K 原文（最多 5 份，順序：最新的 2.02、有標記的、其餘；沒有上一次審查時取最近 120 天）。
 * 已經在證據裡的（財報新聞稿）不重抓，也算在 5 份裡。
 */
export async function reviewThesisEvidence(env: Env, fetcher: Fetcher, tf: ThesisFile, ev: OwnEvidence, asOf: string): Promise<{ facts: ReturnType<typeof thesisFacts>; filings: PackDoc[]; docs: PackDoc[]; notes: string[] }> {
  const notes: string[] = [];
  const filings: PackDoc[] = [];
  const have = new Set(ev.docs.map((d) => d.source_id));
  const eightK = ev.filings.filter((f) => f.form.startsWith('8-K') && f.filingDate <= asOf && afterLastReview(tf, f.filingDate, f.acceptedAt));
  for (const f of pickFilings(eightK, flaggedAccessions(tf), MAX_REVIEW_8K)) {
    if (have.has(`edgar:${f.accession}`)) continue;
    try {
      filings.push(docOf(await fetchFilingDoc(fetcher, ev.cik!, f, env.EDGAR_USER_AGENT ?? '')));
    } catch (e) {
      notes.push(`${f.form} ${f.accession} 抓不到：${errText(e)}`);
    }
  }
  const note = thesisNote(tf, asOf);
  return { facts: [...thesisFacts(tf), ...defaultFacts(tf, ev.dataQuality.xbrl === 'ok' ? ev.rows : null, asOf)], filings, docs: note ? [note] : [], notes };
}

/** 開一次 F24（證據包由論點檔組，T25）。 */
export async function startOwnReview(env: Env, fetcher: Fetcher, acct: Account, view: MarketView, axis: string[], ticker: string, trigger: 'MONTHLY' | 'EARNINGS' | 'MANUAL' | 'THESIS', now: Date, evidence?: OwnEvidence): Promise<AiRun> {
  const ev = evidence ?? (await gatherOwnEvidence(env, fetcher, ticker, view.date));
  const tf = await thesisFile(env.DB, acct, ticker, view.date);
  // 你定的條件 C、觀察項 W（T26；財報類觀察項用這次的 XBRL 比對）
  const conds = tf ? condFacts(tf, ev.dataQuality.xbrl === 'ok' ? ev.rows : null) : undefined;
  const extra = tf ? await reviewThesisEvidence(env, fetcher, tf, ev, view.date) : { facts: [], filings: [], docs: [], notes: [] };
  const { pack, notes } = ownReviewPack({ acct, view, axis, ticker, runId: newRunId(view.date, OWN_REVIEW, ticker), trigger, xbrl: ev.xbrl, filings: [...ev.docs, ...extra.filings], news: ev.news, conds, dataQuality: ev.dataQuality, extraFacts: extra.facts, extraDocs: extra.docs, now });
  return startRun(env, fetcher, pack, now, [...ev.notes, ...extra.notes, ...notes]);
}

// ---------------------------------------------------------------- 套用結論

/** 降級條件成立 → 當天通知（引擎每檔每月最多 1 則）。 */
function notifyCondition(ctx: ApplyCtx, ticker: string, tier: Tier, text: string, label: string, runIds: string[]): void {
  const r = conditionMet(ctx.acct, ctx.view, ticker, tier, text, ctx.view.date.slice(0, 7), 1, runIds);
  ctx.acct = r.acct;
  ctx.log.push(`${label} → ${r.notif ? `當天通知 #${r.notif.id}` : `不通知（${r.why}）`}`);
}

/**
 * F24 → 引擎記下檔位（月報並列建議）與不成立的前提；條件只在三票一致（含一致選「不動」）時動（own_thesis §1.5、§1.6）：
 *   你定的條件（REVIEW_ONLY、申報確認的 ACTIVE）三票確認成立 → MET（met_basis = REVIEW_VOTE），沿用條件成立的通知（文字在 T29a 改）
 *   財報類的你定的條件以程式比對為準，審查的看法只記錄；觀察項（W）成立與否只是給下一次審查的輸入
 *   建議新增的條件 → PROPOSED（有寫入時舊的建議 EXPIRED，沒提時留著）。你定的條件不會被換掉。
 */
export async function applyOwnReview(ctx: ApplyCtx, run: AiRun): Promise<void> {
  const t = run.ticker ?? '';
  if (!run.outcome || !ctx.acct.own[t]) return void ctx.log.push(`${run.runId}：${ctx.acct.own[t] ? '沒有結論' : '已經不是自選股'}，不套用`);
  const d = reviewDecision(run.outcome, ctx.acct, t, run.asOf, run.pack);
  if (d.tier) {
    ctx.acct = recordAiTier(ctx.acct, t, d.tier, run.asOf, d.suggest, run.runId, d.premiseId ? { premiseId: d.premiseId } : undefined);
    // 上一次成立的降級條件已經被這次審查處理過（F8 不再註明）
    ctx.acct.own[t].metConds = [];
  }
  ctx.log.push(`${run.runId}：${d.tier ? TIER_NAME[d.tier] : '不更新'}${d.suggest ? '（月報並列）' : ''}。${d.why}`);
  if (!d.consensus) return void ctx.log.push(`${run.runId}：沒有三票一致的結論，條件不動`);
  const map = ((run.pack.rule.detail ?? {}) as { conds?: Record<string, number> }).conds ?? {};
  const conds = await fileConditions(ctx.db, ctx.acct, t);
  const at = ctx.now.toISOString();
  for (const pid of d.metChecks) {
    const c = conds.find((x) => x.id === map[pid]);
    if (!c || !pid.startsWith('C') || !isOwned(c)) continue;
    if (c.kind === 'XBRL') {
      ctx.log.push(`${run.runId}：財報條件 ${pid}（${c.text}）3 票認為成立；以程式比對財報數字為準，只記錄`);
      continue;
    }
    if (!(c.status === 'REVIEW_ONLY' || (c.status === 'ACTIVE' && confirmMode(c) === 'FILING'))) continue;
    ctx.stmts.push(metStmt(ctx.db, c.id, at, `定期審查 ${run.runId} 3 票確認`, 'REVIEW_VOTE'));
    const tier = notifyTier(c);
    if (tier) notifyCondition(ctx, t, tier, c.text, `${run.runId}：你定的條件 ${c.condId} 由審查 3 票確認成立`, [run.runId, c.runId]);
    else ctx.log.push(`${run.runId}：你定的條件 ${c.condId} 由審查 3 票確認成立（成立時重新審查）→ 下一次審查會看到`);
  }
  if (d.proposed.length) {
    ctx.stmts.push(...proposeStmts(ctx.db, t, ctx.acct.own[t].fileId ?? null, run.runId, d.proposed, at, map));
    ctx.log.push(`${run.runId}：寫入 ${Math.min(d.proposed.length, MAX_PROPOSED)} 條建議的條件（勾選才監測）`);
  }
}

/** F25 → 條件成立的當天通知。 */
export async function applyOwnCondition(ctx: ApplyCtx, run: AiRun): Promise<void> {
  const t = run.ticker ?? '';
  if (!run.outcome || !ctx.acct.own[t]) return void ctx.log.push(`${run.runId}：${ctx.acct.own[t] ? '沒有結論' : '已經不是自選股'}，不套用`);
  const d = conditionDecision(run.outcome);
  if (!d.condId) return void ctx.log.push(`${run.runId}：${d.why}`);
  const cond = (await fileConditions(ctx.db, ctx.acct, t)).find((c) => c.condId === d.condId && c.status === 'ACTIVE');
  if (!cond) return void ctx.log.push(`${run.runId}：條件 ${d.condId} 已經不在監測中（已撤下或已成立），不通知`);
  ctx.stmts.push(metStmt(ctx.db, cond.id, ctx.now.toISOString(), `F25 ${run.runId} 3 票確認`, 'FILING_VOTE'));
  // run_id：確認條件成立的 F25，和寫下條件的那次執行
  const tier = notifyTier(cond);
  if (tier) notifyCondition(ctx, t, tier, cond.text, `${run.runId}：條件 ${d.condId} 成立`, [run.runId, cond.runId]);
  else ctx.log.push(`${run.runId}：條件 ${d.condId} 成立（成立時重新審查）→ 下一次審查會看到`);
}

/**
 * 新的 10-Q／10-K：財報條件由程式直接比對 XBRL（不用 LLM）。
 * 你定的（ACTIVE）與觀察項（PROPOSED）每次比對都寫進度 progress_json（§3.6.2）；只有你定的成立時會標 MET、通知。
 */
export async function ownXbrlConditions(ctx: ApplyCtx, facts: Map<string, QuarterRow[]>): Promise<void> {
  for (const [t, rows] of facts) {
    for (const c of (await fileConditions(ctx.db, ctx.acct, t)).filter((x) => x.kind === 'XBRL' && (x.status === 'ACTIVE' || x.status === 'PROPOSED'))) {
      const check = c.check as { type: string; metric: string; level: number; quarters?: number };
      const p = xbrlProgress(rows, check, ctx.session);
      if (p) ctx.stmts.push(ctx.db.prepare('UPDATE own_conditions SET progress_json = ? WHERE id = ?').bind(JSON.stringify(p), c.id));
      const m = xbrlConditionMet(rows, check);
      if (!m?.met) continue;
      if (c.status === 'PROPOSED') {
        ctx.log.push(`${t} 建議中的財報條件 ${c.condId} 依新財報成立；你還沒勾選，不通知（下一次審查會看到）`);
        continue;
      }
      ctx.stmts.push(metStmt(ctx.db, c.id, ctx.now.toISOString(), `新財報（${rows[0].form} ${rows[0].filed}）：${m.values.map((v) => (v === null ? '—' : v.toFixed(4))).join('、')}`, 'XBRL'));
      const tier = notifyTier(c);
      if (tier) notifyCondition(ctx, t, tier, c.text, `${t} 財報條件 ${c.condId} 成立（程式比對 XBRL）`, [c.runId]);
      else ctx.log.push(`${t} 財報條件 ${c.condId} 成立（成立時重新審查）→ 下一次審查會看到`);
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

/** 一次條件確認（F25）最多放幾份新申報（own_thesis §2.6；原本 3 份）。超過的記 F25_OVERFLOW 告警。 */
export const F25_MAX_FILINGS = 8;

/** F25（新申報對上事件條件）、F24（新財報、月報前一天、論點變動之後）。 */
export async function startOwnRuns(sc: StartCtx): Promise<void> {
  const { env, fetcher, acct, view, axis, session, ov, now, res } = sc;
  const tickers = Object.keys(acct.own);
  const review = new Map<string, 'EARNINGS' | 'MONTHLY' | 'THESIS'>();
  for (const c of sc.checks) {
    if (!acct.own[c.ticker]) continue;
    // F25 的條件由論點檔取（只有現在這份論點檔的）
    const events = ((await thesisFile(env.DB, acct, c.ticker, session))?.conditions ?? []).filter((x) => x.kind === 'EVENT' && x.status === 'ACTIVE');
    const confirm = new Set(events.flatMap((x) => ((x.check.confirm_by as string[] | undefined) ?? []).map((s) => (s === 'SEC' ? '8-K' : s))));
    // 相關的新申報全部取，最多 8 份（新的在前，和 EDGAR 的順序相同）；超過的寫進告警
    const all = c.fresh.filter((f) => [...confirm].some((k) => f.form.startsWith(k)));
    const relevant = all.slice(0, F25_MAX_FILINGS);
    if (events.length && all.length > F25_MAX_FILINGS) {
      const left = all.slice(F25_MAX_FILINGS).map((f) => `${f.form} ${f.filingDate}（${f.accession}）`);
      res.alerts.push({ kind: 'F25_OVERFLOW', message: `${c.ticker} 有 ${all.length} 份新申報可能確認條件，條件確認一次最多讀 ${F25_MAX_FILINGS} 份（取最新的），這幾份沒有放進去：${left.join('、')}。` });
      res.log.push(`${c.ticker} 的條件確認：新申報 ${all.length} 份，只取最新的 ${F25_MAX_FILINGS} 份`);
    }
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
  // 論點變動後的審查（§3.6.5）：今天已經因為別的原因開了審查、或 30 天內開過 → 只清掉；否則開一次（觸發原因 THESIS）
  const patch: Record<string, Pick<OwnMeta, 'thesisReviewDue' | 'thesisReviewAt'>> = {};
  for (const t of tickers) {
    const m = acct.own[t];
    if (!m.thesisReviewDue) continue;
    const sameDay = review.has(t) || !!(await env.DB.prepare("SELECT 1 AS x FROM ai_runs WHERE fn = 'OWN_REVIEW' AND ticker = ? AND as_of = ? LIMIT 1").bind(t, session).first());
    const recent = !!m.thesisReviewAt && daysApart(m.thesisReviewAt, session) < THESIS_REVIEW_GAP;
    if (sameDay || recent) {
      patch[t] = { thesisReviewDue: null };
      res.log.push(`${t} 的論點改過：${sameDay ? '今天已經有審查' : `${m.thesisReviewAt} 開過論點變動後的審查（30 天內）`}，不另外開`);
    } else review.set(t, 'THESIS');
  }
  for (const [t, trigger] of review) {
    try {
      res.started.push((await startOwnReview(env, fetcher, acct, view, axis, t, trigger, now)).runId);
      if (trigger === 'THESIS') patch[t] = { thesisReviewDue: null, thesisReviewAt: session };
    } catch (e) {
      // 沒開成的論點變動審查：thesisReviewDue 留著，下一次每日流程再試
      res.log.push(`${t} 的定期審查沒有開成：${errText(e)}`);
      res.alerts.push({ kind: 'FLOW_ERROR', message: `${t} 的 AI 定期審查沒有開成：${errText(e)}` });
    }
  }
  if (Object.keys(patch).length) await patchOwn(env.DB, now, patch, res.log);
}

/** 論點變動後的審查，每檔幾個日曆天最多 1 次（§3.6.5）。 */
export const THESIS_REVIEW_GAP = 30;
const daysApart = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400_000);

/** 開執行的段落（帳戶已經存好）要改的自選欄位：重新讀帳戶、改、存（和網站同時存檔時重來，最多 3 次）。 */
async function patchOwn(db: D1Database, now: Date, patch: Record<string, Partial<OwnMeta>>, log: string[]): Promise<void> {
  for (let k = 0; k < 3; k++) {
    const loaded = await loadAccount(db);
    if (!loaded) return;
    const next = clone(loaded.acct);
    for (const [t, p] of Object.entries(patch)) if (next.own[t]) Object.assign(next.own[t], p);
    try {
      await saveAccount(db, next, loaded, '論點變動後的審查', now);
      return;
    } catch (e) {
      if (!(e instanceof ConflictError) || k === 2) {
        log.push(`論點變動後的審查：帳戶沒有存成（${errText(e)}）`);
        return;
      }
    }
  }
}

/** 最近一次 F24 的結論（F7 的「以最近一次 F24 為底」）。 */
export async function lastReview(db: D1Database, ticker: string): Promise<AiRun | null> {
  const r = await db.prepare("SELECT run_id FROM ai_runs WHERE fn = ? AND ticker = ? AND status = 'DONE' ORDER BY as_of DESC, created_at DESC LIMIT 1").bind(OWN_REVIEW, ticker).first<{ run_id: string }>();
  return r ? getRun(db, r.run_id) : null;
}
