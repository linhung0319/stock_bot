// T10：F24 自選定期審查、F25 自選條件監測（每日流程的 AI 段在 src/app/aiStep.ts）。
//
//   套用（applyOwnReview／applyOwnCondition）：F24 → 引擎記下檔位，照 own_thesis §1.9 決定當天通知（乙類）、進月報或只放網站
//                                              ＋建議的條件（PROPOSED，勾選才監測）＋審查確認你定的條件成立（甲類）；
//                                              F25 → 你定的條件成立（甲類，當天通知）
//   財報條件（ownXbrlConditions）：新的 10-Q／10-K → 程式直接比對 XBRL（不用 LLM），寫進度；你定的條件成立 → 甲類當天通知；
//                                   財報新聞稿成立的（met_basis = PRESS，T29c）→ 用 XBRL 核對
//   財報新聞稿當天（OWN_EARNINGS，T29c）在 src/app/earningsAi.ts
//   甲類（§1.10）：動作是重新審查 → 不通知、記 condReviewDue 開一次審查（觸發原因 CONDITION）；換算出來不用賣 → 不通知（列進「要看的事」）
//   開新的執行（startOwnRuns）：新申報是事件條件指定的確認來源 → F25；新的財報（10-Q、10-K、8-K 2.02）→ F24（財報後的審查）；
//                               月報前一天（當月倒數第二個交易日）= 月底檢查點：上次有結論的審查之後有新證據才開 F24（own_thesis §3.7），
//                               沒有就不審、記 reviewSkip（月報那天用上一次的結論）；
//                               前提有增減（thesisReviewDue）→ 論點變動後的審查（每檔 30 天 1 次，own_thesis §3.6.5）
// 雲端排程（ROUTINE_FIRE_URL／ROUTINE_TOKEN）還沒設定時不開新的執行；EDGAR 的 User-Agent 沒設定時不看申報。
import type { CheckedSample, PackDoc } from '../ai/check';
import { OWN_CONDITION, OWN_REVIEW, confirmMode, conditionDecision, conditionPack, ownReviewPack, reviewDecision, type ConditionDraft, type ProposedDraft } from '../ai/ownReview';
import { newRunId } from '../ai/pack';
import { TIER_NAME, clone, condMetNotice, routeReview, type Account, type CondNotice, type MarketView, type OwnMeta, type ReviewTrigger } from '../engine';
import { ConflictError, loadAccount, saveAccount, thesisLogStmt } from './ledgerStore';
import { isLastTradingDayOfMonth, nextTradingDay, type CalendarOverrides } from '../data/calendar';
import { attribution } from '../ai/detect';
import { attrFacts } from '../ai/drops';
import { isAdvanceable } from '../data/secEvents';
import { fetchCompanyFacts, fetchFilingDoc, fetchHeadlines, isEarningsFiling, quarterTable, quarterTableText, xbrlConditionMet, XBRL_METRICS, type QuarterRow } from '../data/edgar';
import { fetchEdgarSubmissions, type Filing } from '../data/sources';
import { errText } from '../data/util';
import type { ApplyCtx, StartCtx } from './aiCtx';
import { getRun, startRun, type AiRun } from './aiRuns';
import type { Env, Fetcher } from './env';
import { accOf, cikFor, fetchFilingChecks, handledStmt, loadEvents, sectorEtfs, setStateStmt, type FilingCheck, type SecEventRow } from './filings';
import { reviewHealthStmts, reviewStartFailed } from './reviewHealth';
import { EARLY_NOTE, EVIDENCE_TEXT, MAX_PROPOSED, MAX_REVIEW_8K, afterLastReview, condFacts, defaultAction, defaultFacts, fileConditions, flaggedAccessions, fmtMetric, isOwned, newEvidence, notifyTier, ownerText, pickFilings, thesisFacts, thesisFile, thesisNote, xbrlProgress, type CondAction, type EvidenceReason, type FileCondition, type ThesisFile } from './thesis';

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

/** 條件成立（met_basis：XBRL 程式比對、PRESS 財報新聞稿擷取、FILING_VOTE 申報原文三票、REVIEW_VOTE 審查三票）。 */
export const metStmt = (db: D1Database, id: number, at: string, note: string, basis: 'XBRL' | 'PRESS' | 'FILING_VOTE' | 'REVIEW_VOTE') => db.prepare("UPDATE own_conditions SET status = 'MET', met_at = ?, note = ?, met_basis = ? WHERE id = ?").bind(at, note, basis, id);

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

/** 提前審查（own_thesis §2.4）多帶的：題目的原因、觸發的事件編號、價格類的跌幅拆解（A1～A5）。 */
export interface EarlyInput {
  reason: string;
  events: number[];
  facts?: PackFact[];
}
type PackFact = ReturnType<typeof thesisFacts>[number];

/**
 * 開一次 F24（證據包由論點檔組，T25）。reasons：月底檢查點的新證據原因（記在 rule.detail，T31a）；
 * early：提前審查的原因與事件編號（T29b）。
 */
export async function startOwnReview(env: Env, fetcher: Fetcher, acct: Account, view: MarketView, axis: string[], ticker: string, trigger: ReviewTrigger, now: Date, evidence?: OwnEvidence, reasons?: EvidenceReason[], early?: EarlyInput): Promise<AiRun> {
  const ev = evidence ?? (await gatherOwnEvidence(env, fetcher, ticker, view.date));
  const tf = await thesisFile(env.DB, acct, ticker, view.date);
  // 你定的條件 C、觀察項 W（T26；財報類觀察項用這次的 XBRL 比對）
  const conds = tf ? condFacts(tf, ev.dataQuality.xbrl === 'ok' ? ev.rows : null) : undefined;
  const extra = tf ? await reviewThesisEvidence(env, fetcher, tf, ev, view.date) : { facts: [], filings: [], docs: [], notes: [] };
  const { pack, notes } = ownReviewPack({ acct, view, axis, ticker, runId: newRunId(view.date, OWN_REVIEW, ticker), trigger, xbrl: ev.xbrl, filings: [...ev.docs, ...extra.filings], news: ev.news, conds, dataQuality: ev.dataQuality, extraFacts: [...extra.facts, ...(early?.facts ?? [])], extraDocs: extra.docs, reasons, ...(early ? { early: { reason: early.reason, events: early.events } } : {}), now });
  return startRun(env, fetcher, pack, now, [...ev.notes, ...extra.notes, ...notes]);
}

// ---------------------------------------------------------------- 套用結論

/** 申報或財報表的簡稱（失效通知的理由用）：`8-K 2027-01-06`、`財報數字表（XBRL，2027-01-08）`。 */
export function docLabel(doc: Pick<PackDoc, 'kind' | 'title' | 'date'> | undefined): string | null {
  if (!doc) return null;
  if (doc.kind === 'xbrl') return `財報數字表（XBRL，${doc.date}）`;
  const form = /^([^\s（：]+)/.exec(doc.title)?.[1] ?? '申報';
  return `${form} ${doc.date}`;
}

/**
 * 三票裡第一份通過逐字檢查、來源是申報原文或財報表的引用（理由寫「依據：8-K 2027-01-06」用）。
 * pick：從一票裡取出那件事的引用編號（例如某條前提的 evidence_ids）；回傳 null = 這一票的任何引用都可以。
 */
export function citedDoc(run: Pick<AiRun, 'outcome' | 'pack'>, pick: (s: CheckedSample) => unknown = () => null): string | null {
  const hard = new Map(run.pack.documents.filter((d) => d.kind === 'filing' || d.kind === 'xbrl').map((d) => [d.source_id, d]));
  for (const s of run.outcome?.samples.filter((x) => x.valid) ?? []) {
    const ids = pick(s);
    const list = Array.isArray(ids) ? ids.map(String) : null;
    const ev = s.evidence.find((e) => e.ok && hard.has(e.source_id) && (!list || list.includes(e.id)));
    if (ev) return docLabel(hard.get(ev.source_id));
  }
  return null;
}

/** 財報類條件成立的理由（met_basis = XBRL）：`最新一季毛利率 68.4%（10-Q 2027-01-08）`。 */
export function xbrlWhy(check: Record<string, unknown>, values: (number | null)[], latest: Pick<QuarterRow, 'form' | 'filed'>): string {
  const metric = String(check.metric);
  const label = XBRL_METRICS[metric]?.label ?? metric;
  const vs = values.map((v) => fmtMetric(metric, v));
  return `${vs.length > 1 ? `最近 ${vs.length} 季${label} ${vs.join('、')}（新到舊）` : `最新一季${label} ${vs[0]}`}（${latest.form} ${latest.filed}）`;
}

/**
 * 你定的條件成立（甲類，own_thesis §1.10）：
 *   動作是重新審查 → 不發通知，記 condReviewDue（下一次開執行時開一次審查，觸發原因 CONDITION）
 *   動作是出清或減半 → 當天通知（不設上限）；monthly = 月審確認成立的 → 進隔天的月報（項目相同）
 *   換算出來不用賣 → 不發通知，條件照樣是成立（「要看的事」的 COND_MET_NO_SELL 由論點檔判斷）
 * why：理由（依 met_basis）；AI 建議、你勾選的條件另外寫一句是誰哪天勾的。
 */
export function notifyOwnCondition(ctx: ApplyCtx, c: FileCondition, why: string, runIds: string[], label: string, monthly = false): void {
  const t = c.ticker;
  if (!ctx.acct.own[t]) return;
  const tier = notifyTier(c);
  if (!tier) {
    ctx.acct = clone(ctx.acct);
    ctx.acct.own[t].condReviewDue = ctx.session;
    return void ctx.log.push(`${label}（成立時重新審查）→ 不通知，開一次審查（觸發原因：你定的條件）`);
  }
  if (tier !== 'EXIT' && tier !== 'HALF') return void ctx.log.push(`${label}（舊資料的檔位 ${TIER_NAME[tier]}，不是出清或減半）→ 不通知`);
  const spec: CondNotice = {
    id: c.id,
    text: c.text,
    action: tier,
    setAt: (c.acceptedAt ?? c.createdAt).slice(0, 10),
    aiProposed: c.origin !== 'USER',
    why: c.origin !== 'USER' && c.acceptedAt ? `${why}。這條是${ownerText(c)}。` : why,
    premiseId: c.premiseId,
    runIds,
  };
  if (monthly) {
    ctx.acct = clone(ctx.acct);
    const m = ctx.acct.own[t];
    m.condMonthly = [...(m.condMonthly ?? []), spec];
    return void ctx.log.push(`${label} → 月審確認的，進隔天的月報`);
  }
  const r = condMetNotice(ctx.acct, ctx.view, t, spec);
  ctx.acct = r.acct;
  ctx.log.push(`${label} → ${r.notif ? `當天通知 #${r.notif.id}` : `不通知（${r.why}），列進要看的事`}`);
}

/**
 * F24 → 引擎記下檔位與不成立的前提，照 own_thesis §1.9 決定怎麼給（routeReview：當天通知乙類、進月報、更新還沒回覆的通知、只放網站）；
 * 條件只在三票一致（含一致選「不動」）時動（own_thesis §1.5、§1.6）：
 *   你定的條件（REVIEW_ONLY、申報確認的 ACTIVE）三票確認成立 → MET（met_basis = REVIEW_VOTE），甲類通知（月審確認的進隔天的月報）
 *   財報類的你定的條件以程式比對為準，審查的看法只記錄；觀察項（W）成立與否只是給下一次審查的輸入
 *   建議新增的條件 → PROPOSED（有寫入時舊的建議 EXPIRED，沒提時留著）。你定的條件不會被換掉。
 */
export async function applyOwnReview(ctx: ApplyCtx, run: AiRun): Promise<void> {
  const t = run.ticker ?? '';
  // 連續沒有結論的次數與告警、連續票數不一致的次數（own_thesis §3.6.4）
  await reviewHealthStmts(ctx, run);
  if (!run.outcome || !ctx.acct.own[t]) return void ctx.log.push(`${run.runId}：${ctx.acct.own[t] ? '沒有結論' : '已經不是自選股'}，不套用`);
  const d = reviewDecision(run.outcome, ctx.acct, t, run.asOf, run.pack);
  const detail = (run.pack.rule.detail ?? {}) as { conds?: Record<string, number>; trigger?: string };
  const trigger = (detail.trigger || 'MANUAL') as ReviewTrigger;
  if (d.tier) {
    const basis = d.premiseId ? citedDoc(run, (s) => s.premises.find((p) => p.premise_id === d.premiseId && p.status === 'BROKEN')?.evidence_ids ?? []) : null;
    const r = routeReview(ctx.acct, ctx.view, t, { tier: d.tier, suggest: d.suggest, consensus: d.consensus, premiseId: d.premiseId, trigger, date: run.asOf, runId: run.runId, basis });
    ctx.acct = r.acct;
    // 上一次成立的降級條件已經被這次審查處理過（F8 不再註明）
    if (r.route !== 'KEPT') ctx.acct.own[t].metConds = [];
    ctx.log.push(`${run.runId}：${TIER_NAME[d.tier]}。${d.why} → ${r.why}`);
  } else ctx.log.push(`${run.runId}：不更新。${d.why}`);
  if (!d.consensus) return void ctx.log.push(`${run.runId}：沒有三票一致的結論，條件不動`);
  const map = detail.conds ?? {};
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
    const label = `${run.runId}：你定的條件 ${c.condId} 由審查 3 票確認成立`;
    // 動作是重新審查：確認它成立的就是這次審查，結論照 §1.9 處理，不再另外開
    if (!notifyTier(c)) ctx.log.push(`${label}（成立時重新審查）→ 這次審查就是重新審查，結論照建議的規則處理`);
    else notifyOwnCondition(ctx, c, `${run.asOf} 的審查 3 票確認（引用在網站）`, [run.runId, c.runId], label, trigger === 'MONTHLY');
  }
  if (d.proposed.length) {
    ctx.stmts.push(...proposeStmts(ctx.db, t, ctx.acct.own[t].fileId ?? null, run.runId, d.proposed, at, map));
    ctx.log.push(`${run.runId}：寫入 ${Math.min(d.proposed.length, MAX_PROPOSED)} 條建議的條件（勾選才監測）`);
  }
}

/** F25 → 你定的條件成立（甲類，當天通知）。 */
export async function applyOwnCondition(ctx: ApplyCtx, run: AiRun): Promise<void> {
  const t = run.ticker ?? '';
  if (!run.outcome || !ctx.acct.own[t]) return void ctx.log.push(`${run.runId}：${ctx.acct.own[t] ? '沒有結論' : '已經不是自選股'}，不套用`);
  const d = conditionDecision(run.outcome);
  if (!d.condId) return void ctx.log.push(`${run.runId}：${d.why}`);
  const cond = (await fileConditions(ctx.db, ctx.acct, t)).find((c) => c.condId === d.condId && c.status === 'ACTIVE');
  if (!cond) return void ctx.log.push(`${run.runId}：條件 ${d.condId} 已經不在監測中（已撤下或已成立），不通知`);
  ctx.stmts.push(metStmt(ctx.db, cond.id, ctx.now.toISOString(), `F25 ${run.runId} 3 票確認`, 'FILING_VOTE'));
  // run_id：確認條件成立的 F25，和寫下條件的那次執行
  notifyOwnCondition(ctx, cond, `${citedDoc(run) ?? '新申報'} 的原文，3 票確認（引用在網站）`, [run.runId, cond.runId], `${run.runId}：條件 ${d.condId} 成立`);
}

/**
 * 新的 10-Q／10-K：財報條件由程式直接比對 XBRL（不用 LLM）。
 * 你定的（ACTIVE）與觀察項（PROPOSED）每次比對都寫進度 progress_json（§3.6.2）；只有你定的成立時會標 MET、通知。
 * 財報新聞稿成立的條件（met_basis = PRESS，還沒核對）：用 XBRL 再比一次（pressVerify，§1.11）。
 * 同一次套用裡剛由財報新聞稿標成立的（ctx.met）不再比對，免得通知兩次。
 */
export async function ownXbrlConditions(ctx: ApplyCtx, facts: Map<string, QuarterRow[]>): Promise<void> {
  for (const [t, rows] of facts) {
    const all = (await fileConditions(ctx.db, ctx.acct, t)).filter((x) => x.kind === 'XBRL' && !ctx.met?.has(x.id));
    for (const c of all.filter((x) => x.status === 'MET' && x.metBasis === 'PRESS' && !x.verifiedAt)) pressVerify(ctx, c, rows);
    for (const c of all.filter((x) => x.status === 'ACTIVE' || x.status === 'PROPOSED')) {
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
      notifyOwnCondition(ctx, c, xbrlWhy(c.check, m.values, rows[0]), [c.runId], `${t} 財報條件 ${c.condId} 成立（程式比對 XBRL）`);
    }
  }
}

/**
 * 財報新聞稿成立的條件，10-Q／10-K 出來後核對（own_thesis §1.11）：XBRL 表有新聞稿那一季（progress_json.period）才比，
 * 寫 verified_at。一致 → 說明加「10-Q 核對一致」；不一致（XBRL 算出來沒有過門檻）→ 說明寫明兩個數字、論點檔記一筆 PRESS_CHECK
 * （「要看的事」的 PRESS_MISMATCH 讀它）。不會撤回已經做的事。XBRL 還沒有那一季、或數字不齊 → 這次不核對。
 */
function pressVerify(ctx: ApplyCtx, c: FileCondition, rows: QuarterRow[]): void {
  const p = c.progress;
  const t = c.ticker;
  const k = p?.basis === 'PRESS' ? rows.findIndex((r) => r.end === p.period) : -1;
  if (!p || k < 0) return void ctx.log.push(`${t} 財報條件 ${c.condId} 依財報新聞稿成立；新財報還沒有那一季（${p?.period ?? '—'}），這次不核對`);
  const check = c.check as { type: string; metric: string; level: number; quarters?: number };
  const m = xbrlConditionMet(rows.slice(k), check);
  if (!m) return void ctx.log.push(`${t} 財報條件 ${c.condId} 依財報新聞稿成立；${rows[k].form} 的數字不齊，這次不核對`);
  const metric = String(check.metric);
  const form = rows[k].form;
  const at = ctx.now.toISOString();
  const press = fmtMetric(metric, p.values[0] ?? null);
  const xbrl = fmtMetric(metric, m.values[0] ?? null);
  const note = m.met ? `${c.note ? `${c.note}；` : ''}${form} 核對一致` : `${c.note ? `${c.note}；` : ''}${form} 核對不一致：依財報新聞稿 ${press}，${form} 算出來是 ${xbrl}，沒有過門檻 ${fmtMetric(metric, check.level)}`;
  ctx.stmts.push(ctx.db.prepare('UPDATE own_conditions SET verified_at = ?, note = ? WHERE id = ?').bind(at, note, c.id));
  if (m.met) return void ctx.log.push(`${t} 財報條件 ${c.condId} 依財報新聞稿成立，${form} 核對一致`);
  if (c.fileId) ctx.stmts.push(thesisLogStmt(ctx.db, { ticker: t, fileId: c.fileId, session: ctx.session, kind: 'PRESS_CHECK', ref: String(c.id), body: { id: c.id, ok: false, metric, level: check.level, period: p.period, press: p.values.slice(0, m.values.length), xbrl: m.values, form, filed: rows[k].filed } }, null, at));
  ctx.log.push(`${t} 財報條件 ${c.condId} 依財報新聞稿成立（${press}），${form} 算出來是 ${xbrl}，沒有過門檻：已經做的不撤回，列進要看的事`);
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
  // 月底檢查點（§3.7）：今天還沒有因為別的原因開審查的，上次有結論的審查之後有新證據才審
  const patch: Record<string, Partial<Pick<OwnMeta, 'thesisReviewDue' | 'thesisReviewAt' | 'reviewSkip'>>> = {};
  const reasonsOf = new Map<string, EvidenceReason[]>();
  const checkpoint = isLastTradingDayOfMonth(nextTradingDay(session, ov), ov);
  const record: Checkpoint = { session, reviewed: [], skipped: [], notStarted: [] };
  if (checkpoint) {
    for (const t of tickers) {
      if (review.has(t)) continue;
      const tf = await thesisFile(env.DB, acct, t, session);
      const all = sc.checks.find((c) => c.ticker === t)?.all ?? null;
      const reasons: EvidenceReason[] = tf ? newEvidence(tf, all, session) : ['NEVER'];
      if (reasons.length) {
        review.set(t, 'MONTHLY');
        reasonsOf.set(t, reasons);
        continue;
      }
      const since = tf!.lastReview!.asOf;
      patch[t] = { reviewSkip: { month: session.slice(0, 7), since } };
      record.skipped.push({ ticker: t, since });
      res.log.push(`${t}：${since.slice(5)} 的審查之後沒有新的申報、事件或論點變動，這個月不審查`);
    }
  }
  // 論點變動後的審查（§3.6.5）：今天已經因為別的原因開了審查、或 30 天內開過 → 只清掉；否則開一次（觸發原因 THESIS）
  for (const t of tickers) {
    const m = acct.own[t];
    if (!m.thesisReviewDue) continue;
    const sameDay = review.has(t) || !!(await env.DB.prepare("SELECT 1 AS x FROM ai_runs WHERE fn = 'OWN_REVIEW' AND ticker = ? AND as_of = ? LIMIT 1").bind(t, session).first());
    const recent = !!m.thesisReviewAt && daysApart(m.thesisReviewAt, session) < THESIS_REVIEW_GAP;
    if (sameDay || recent) {
      patch[t] = { ...patch[t], thesisReviewDue: null };
      res.log.push(`${t} 的論點改過：${sameDay ? '今天已經有審查' : `${m.thesisReviewAt} 開過論點變動後的審查（30 天內）`}，不另外開`);
    } else review.set(t, 'THESIS');
  }
  for (const [t, trigger] of review) {
    const reasons = reasonsOf.get(t);
    try {
      res.started.push((await startOwnReview(env, fetcher, acct, view, axis, t, trigger, now, undefined, reasons)).runId);
      if (trigger === 'THESIS') patch[t] = { ...patch[t], thesisReviewDue: null, thesisReviewAt: session };
      if (acct.own[t].reviewSkip) patch[t] = { ...patch[t], reviewSkip: null };
      if (reasons) {
        record.reviewed.push({ ticker: t, reasons });
        res.log.push(`${t}：月底檢查點有新證據（${reasons.map((r) => EVIDENCE_TEXT[r]).join('、')}），開審查`);
      }
    } catch (e) {
      // 沒開成的論點變動審查：thesisReviewDue 留著，下一次每日流程再試。沒開成也算一次沒有結論（§3.6.4）
      res.log.push(`${t} 的定期審查沒有開成：${errText(e)}`);
      res.alerts.push({ kind: 'FLOW_ERROR', message: `${t} 的 AI 定期審查沒有開成：${errText(e)}` });
      if (reasons) record.notStarted.push({ ticker: t, reasons });
      try {
        const alert = await reviewStartFailed(env.DB, t, acct.own[t].fileId ?? null, session, now, ov);
        if (alert) res.alerts.push(alert);
      } catch (e2) {
        res.log.push(`${t} 的審查失敗次數沒有記成：${errText(e2)}`);
      }
    }
  }
  if (checkpoint) await setStateStmt(env.DB, checkpointKey(session), JSON.stringify(record), now.toISOString()).run();
  if (Object.keys(patch).length) await patchOwn(env.DB, now, patch, res.log);
  // 你定的「重新審查」條件成立（§1.10）：今天還沒有審查的開一次
  await startCondReviews(sc);
}

/**
 * 你定的條件成立、動作是「重新審查」（own_thesis §1.10 甲類）：condReviewDue 有值的開一次審查，觸發原因 CONDITION，
 * 不受提前審查的頻率上限限制。今天已經有這檔的審查（例如財報後的）→ 只清掉。沒開成 → 留著，下一次開執行時再試。
 * 每日第一次流程（startOwnRuns 最後）與 01:30 的 finalStarts 都呼叫：01:30 才套用的條件確認當天就開。
 */
export async function startCondReviews(sc: StartCtx): Promise<void> {
  const { env, fetcher, acct, view, axis, session, ov, now, res } = sc;
  const patch: Record<string, Partial<OwnMeta>> = {};
  for (const [t, m] of Object.entries(acct.own)) {
    if (!m.condReviewDue) continue;
    const same = await env.DB.prepare("SELECT 1 AS x FROM ai_runs WHERE fn = 'OWN_REVIEW' AND ticker = ? AND as_of = ? LIMIT 1").bind(t, session).first();
    if (same) {
      patch[t] = { condReviewDue: null };
      res.log.push(`${t} 你定的條件成立（重新審查）：今天已經有審查，不另外開`);
      continue;
    }
    try {
      res.started.push((await startOwnReview(env, fetcher, acct, view, axis, t, 'CONDITION', now)).runId);
      patch[t] = { condReviewDue: null, ...(m.reviewSkip ? { reviewSkip: null } : {}) };
      res.log.push(`${t} 你定的條件成立（重新審查）→ 開審查`);
    } catch (e) {
      res.log.push(`${t} 的審查（你定的條件成立）沒有開成：${errText(e)}`);
      res.alerts.push({ kind: 'FLOW_ERROR', message: `${t} 的 AI 審查（你定的條件成立、動作是重新審查）沒有開成：${errText(e)}` });
      try {
        const alert = await reviewStartFailed(env.DB, t, m.fileId ?? null, session, now, ov);
        if (alert) res.alerts.push(alert);
      } catch (e2) {
        res.log.push(`${t} 的審查失敗次數沒有記成：${errText(e2)}`);
      }
    }
  }
  if (Object.keys(patch).length) await patchOwn(env.DB, now, patch, res.log);
}

// ---------------------------------------------------------------- 提前審查（T29b，own_thesis §2.4）

/** 事件日在最近幾個日曆天內才是提前審查的候選；更舊的還沒處理就標成過期。 */
export const EARLY_WINDOW_DAYS = 10;
/** 每檔幾個日曆天最多 1 次提前審查（L1 的事件與 L0 的個股自身大跌合併計算）；價格類「最近跑過減半檢視」也看這麼多天。 */
export const EARLY_GAP = 30;
/** 月審在接下來幾個交易日內 → 留給月審。 */
export const EARLY_MONTHLY_DAYS = 3;

/** 提前審查的候選事件：§2.2 標「是」的細項、條件提示（申報原文標到的才是 NEW）、個股自身大跌（價格規則）。 */
export const isEarlyCandidate = (e: Pick<SecEventRow, 'code' | 'detail_code'>): boolean => e.code === 'CONDITION_HINT' || e.code === 'PRICE_DROP' || isAdvanceable(e.code, e.detail_code);
const isPriceEvent = (e: Pick<SecEventRow, 'source' | 'code'>) => e.source === 'PRICE' && e.code === 'PRICE_DROP';

/** 月審（月報前一天的月底檢查點）在接下來 n 個交易日內嗎。不含今天：今天的檢查點在每日第一次流程已經做過。 */
export function monthlyWithin(session: string, ov: CalendarOverrides, n = EARLY_MONTHLY_DAYS): boolean {
  let d = session;
  for (let k = 0; k < n; k++) {
    d = nextTradingDay(d, ov);
    if (isLastTradingDayOfMonth(nextTradingDay(d, ov), ov)) return true;
  }
  return false;
}

/** 題目裡的事件說明（白話，給 AI 讀）。 */
const EARLY_TEXT: Record<string, string> = {
  CEO_DEPART: '執行長離任',
  CFO_DEPART: '財務長離任',
  CUT: '下修財測',
  WITHDRAWN: '撤回財測',
  IMPAIRMENT: '重大減損',
  EXIT_PLAN: '重組或退出計畫',
  TERMINATION: '重大合約終止',
  BANKRUPTCY: '破產或接管',
  ACCELERATION: '債務加速到期',
  DELISTING_NOTICE: '下市通知或不符上市規定',
  INCIDENT: '重大資安事件',
};
export function earlyEventText(e: Pick<SecEventRow, 'code' | 'detail_code' | 'detail' | 'event_date' | 'form'>): string {
  if (e.code === 'CONDITION_HINT') return `${e.event_date} 的 ${e.form}：${e.detail ?? '每日掃描認為可能和條件有關'}`;
  return `${e.event_date} 的 ${e.form}：${EARLY_TEXT[e.detail_code ?? ''] ?? e.detail ?? e.code}`;
}

/**
 * 提前審查（own_thesis §2.4；L1、L0 交給 L2）：自選股 sec_events 裡 NEW 的候選，照表的順序決定開不開，事件標 HANDLED、handled_note 寫原因：
 *   1. 這檔已經有一次審查的決策日 ≥ 事件日（含今天已經開的財報後、月審）→ 「已經在 <run_id> 的證據包裡」
 *   2. 只限價格類：30 天內跑過減半檢視（F7）→ 「30 天內已經做過減半檢視」
 *   3. 只限價格類：上次有結論的審查之後沒有新的申報或事件（新證據沒有 FILING、EVENT，也不是 NEVER）→ 「沒有新的申報可以檢查」（要看的事 PRICE_NO_FILING）
 *   4. 月審在接下來 3 個交易日內 → 「留給月審」
 *   5. 30 天內提前開過（earlyReviewAt）→ 「30 天內已經提前審查過，留給下一次審查」
 *   6. 其餘 → 開一次審查（觸發原因 EARLY，同一檔的事件併成一次），earlyReviewAt 記今天 → 「提前審查 <run_id>」
 * 事件日超過 10 天的候選標成過期；已經不是自選股的、新聞標題來源的（寫入時就該是 INFO）也標 HANDLED，不開。
 * 沒開成：事件留著 NEW，下一次開執行時再試（10 天內）；告警與審查失敗次數照定期審查。
 * 每日第一次流程（開執行的最後）與 01:30 的 finalStarts 都呼叫。fetchChecks：這次流程沒有看新申報（01:30）時，
 * 價格類要判斷第 3 點才另外抓那一檔的申報清單（不推「看過」的標記）。
 */
export async function startEarlyReviews(sc: StartCtx, opt: { fetchChecks?: boolean } = {}): Promise<void> {
  const { env, fetcher, acct, view, axis, session, ov, now, res } = sc;
  const cands = (await loadEvents(env.DB, { status: 'NEW' })).filter(isEarlyCandidate);
  if (!cands.length) return;
  const handled = new Map<string, number[]>();
  const mark = (note: string, e: SecEventRow) => handled.set(note, [...(handled.get(note) ?? []), e.id]);
  const byTicker = new Map<string, SecEventRow[]>();
  for (const e of cands) {
    if (daysApart(e.event_date, session) > EARLY_WINDOW_DAYS) mark(EARLY_NOTE.expired, e);
    else if (!acct.own[e.ticker]) mark(EARLY_NOTE.notOwn, e);
    else if (!isPriceEvent(e) && accOf(e.accession).kind !== 'FILING') mark(EARLY_NOTE.news, e);
    else byTicker.set(e.ticker, [...(byTicker.get(e.ticker) ?? []), e]);
  }
  const soon = monthlyWithin(session, ov);
  const cutoff = new Date(Date.parse(session) - EARLY_GAP * 86400_000).toISOString().slice(0, 10);
  const patch: Record<string, Partial<OwnMeta>> = {};
  for (const [t, evs] of byTicker) {
    const last = await env.DB.prepare('SELECT run_id, as_of FROM ai_runs WHERE fn = ? AND ticker = ? ORDER BY as_of DESC, created_at DESC LIMIT 1').bind(OWN_REVIEW, t).first<{ run_id: string; as_of: string }>();
    const f7 = evs.some(isPriceEvent) && !!(await env.DB.prepare("SELECT 1 AS x FROM ai_runs WHERE fn = 'OWN_DROP' AND ticker = ? AND as_of > ? LIMIT 1").bind(t, cutoff).first());
    let evidence: EvidenceReason[] | null = null;
    const open: SecEventRow[] = [];
    for (const e of evs) {
      if (last && last.as_of >= e.event_date) {
        mark(EARLY_NOTE.inPack(last.run_id), e);
        continue;
      }
      if (isPriceEvent(e)) {
        if (f7) {
          mark(EARLY_NOTE.dropReview, e);
          continue;
        }
        if (!evidence) {
          const tf = await thesisFile(env.DB, acct, t, session);
          let filings: Filing[] | null = sc.checks.find((c) => c.ticker === t)?.all ?? null;
          if (!filings && opt.fetchChecks && env.EDGAR_USER_AGENT) filings = (await fetchFilingChecks(env, fetcher, [t], session, res.log))[0]?.all ?? null;
          evidence = tf ? newEvidence(tf, filings, session) : ['NEVER'];
        }
        // 申報清單抓不到（UNKNOWN）當成有新證據，照審（和月底檢查點相同）
        if (!evidence.some((r) => r === 'NEVER' || r === 'FILING' || r === 'EVENT' || r === 'UNKNOWN')) {
          mark(EARLY_NOTE.noFiling, e);
          res.log.push(`${t} 個股自身大跌（${e.detail ?? ''}），上次審查之後沒有新的申報或事件：不提前審查，列進要看的事`);
          continue;
        }
      }
      if (soon) {
        mark(EARLY_NOTE.monthly, e);
        continue;
      }
      const at = acct.own[t].earlyReviewAt;
      if (at && daysApart(at, session) < EARLY_GAP) {
        mark(EARLY_NOTE.recent, e);
        continue;
      }
      open.push(e);
    }
    if (!open.length) continue;
    const price = open.find(isPriceEvent);
    // 原因照事件日由舊到新；規則與掃描標到同一份申報、同一個細項的只寫一次
    const byDate = [...open].sort((x, y) => x.event_date.localeCompare(y.event_date) || x.id - y.id);
    const reasons = [...new Set(byDate.filter((e) => !isPriceEvent(e)).map(earlyEventText))];
    let facts: PackFact[] = [];
    if (price) {
      // 價格類：這 21 天的跌幅拆解（A1～A5，和 F7 同一個函式）；題目寫個股自身跌多少
      const sector = (await sectorEtfs(env.DB, [t]))[t] ?? null;
      const k = axis.indexOf(price.event_date);
      const i = k >= 0 && k <= view.i ? k : view.i;
      const attr = i >= 21 ? attribution(axis, view.close, t, acct.cfg.coreTicker, sector, i - 21, i) : null;
      facts = attrFacts(attr);
      reasons.unshift(attr ? `最近 21 個交易日個股自身跌 ${(Math.abs(attr.idio) * 100).toFixed(1)}%` : (price.detail ?? '個股自身大跌'));
    }
    try {
      const run = await startOwnReview(env, fetcher, acct, view, axis, t, 'EARLY', now, undefined, undefined, { reason: reasons.join('；'), events: open.map((e) => e.id), facts });
      res.started.push(run.runId);
      for (const e of open) mark(EARLY_NOTE.started(run.runId), e);
      patch[t] = { earlyReviewAt: session, ...(acct.own[t].reviewSkip ? { reviewSkip: null } : {}) };
      res.log.push(`${t} 提前審查 ${run.runId}（${reasons.join('；')}）`);
    } catch (e) {
      res.log.push(`${t} 的提前審查沒有開成：${errText(e)}`);
      res.alerts.push({ kind: 'FLOW_ERROR', message: `${t} 的 AI 提前審查沒有開成：${errText(e)}` });
      try {
        const alert = await reviewStartFailed(env.DB, t, acct.own[t].fileId ?? null, session, now, ov);
        if (alert) res.alerts.push(alert);
      } catch (e2) {
        res.log.push(`${t} 的審查失敗次數沒有記成：${errText(e2)}`);
      }
    }
  }
  for (const [note, ids] of handled) await handledStmt(env.DB, ids, note).run();
  if (Object.keys(patch).length) await patchOwn(env.DB, now, patch, res.log);
}

/**
 * 月底檢查點的紀錄（flow_state 的 review:checkpoint:<年月>；運作統計「月底審了幾檔、跳過幾檔」用）：
 * reviewed 有新證據、開了審查（附原因）；skipped 沒有新證據、沿用哪一次的審查；notStarted 有新證據但沒開成。
 * 當天已經因為財報開審查的不在裡面。
 */
export interface Checkpoint {
  session: string;
  reviewed: { ticker: string; reasons: EvidenceReason[] }[];
  skipped: { ticker: string; since: string }[];
  notStarted: { ticker: string; reasons: EvidenceReason[] }[];
}
export const CHECKPOINT_PREFIX = 'review:checkpoint:';
export const checkpointKey = (session: string) => `${CHECKPOINT_PREFIX}${session.slice(0, 7)}`;

/** 論點變動後的審查，每檔幾個日曆天最多 1 次（§3.6.5）。 */
export const THESIS_REVIEW_GAP = 30;
const daysApart = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400_000);

/** 開執行的段落（帳戶已經存好）要改的自選欄位（論點變動後的審查、月底檢查點的 reviewSkip）：重新讀帳戶、改、存（和網站同時存檔時重來，最多 3 次）。 */
async function patchOwn(db: D1Database, now: Date, patch: Record<string, Partial<OwnMeta>>, log: string[]): Promise<void> {
  for (let k = 0; k < 3; k++) {
    const loaded = await loadAccount(db);
    if (!loaded) return;
    const next = clone(loaded.acct);
    for (const [t, p] of Object.entries(patch)) if (next.own[t]) Object.assign(next.own[t], p);
    try {
      await saveAccount(db, next, loaded, '論點變動後的審查與月底檢查點', now);
      return;
    } catch (e) {
      if (!(e instanceof ConflictError) || k === 2) {
        log.push(`論點變動後的審查與月底檢查點：帳戶沒有存成（${errText(e)}）`);
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
