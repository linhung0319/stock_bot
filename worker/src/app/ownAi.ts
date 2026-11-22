// T10：F24 自選定期審查、F25 自選條件監測（每日流程的 AI 段在 src/app/aiStep.ts）。
//
//   套用（applyOwnReview／applyOwnCondition）：F24 → 引擎記下檔位，照 own_thesis §1.9 決定當天通知（乙類）、進月報或只放網站
//                                              ＋建議的條件（T71：寫入就是 AI 監測中，成立時重新審查）＋審查確認你定的條件成立（甲類）；
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
import { webMetaOf } from '../ai/added';
import type { CheckedSample, EvidencePack, PackDoc } from '../ai/check';
import { MEDIA_MIN_DOMAINS, OWN_CONDITION, OWN_REVIEW, citedSources, condCite, confirmMode, conditionDecision, conditionPack, earningsConfirmed, namedWebDomains, ownReviewPack, packSources, reviewDecision, type ConditionDraft, type ProposedDraft, type RevenueCheck } from '../ai/ownReview';
import { STRONG_RATINGS, sameWebDomain } from '../data/webSources';
import { newRunId } from '../ai/pack';
import { TIER_NAME, buildEarnings, clone, condMetNotice, ownHeld, recordEarnCheck, routeReview, type Account, type AddNotice, type CondNotice, type MarketView, type OwnMeta, type ReviewTrigger, type Tier } from '../engine';
import { ConflictError, loadAccount, saveAccount, thesisLogStmt } from './ledgerStore';
import { isLastTradingDayOfMonth, nextTradingDay, type CalendarOverrides } from '../data/calendar';
import { attribution } from '../ai/detect';
import { FRESH_RESERVE, freshPlan } from '../ai/freshEyes';
import { attrFacts } from '../ai/drops';
import { isAdvanceable } from '../data/secEvents';
import { fetchCompanyFacts, fetchFilingDoc, fetchHeadlineFeed, isEarningsFiling, quarterTable, quarterTableText, xbrlConditionMet, XBRL_METRICS, type Headline, type HeadlineFeed, type QuarterRow } from '../data/edgar';
import { buildDocMenu, fetchPeerFilings } from './webEvidence';
import { fetchEdgarSubmissions, type Filing } from '../data/sources';
import { errText } from '../data/util';
import type { ApplyCtx, StartCtx } from './aiCtx';
import { getRun, lastFreshReview, startRun, type AiRun } from './aiRuns';
import type { Env, Fetcher } from './env';
import { accOf, cikFor, fetchFilingChecks, handledStmt, loadEvents, sectorEtfs, setStateStmt, type FilingCheck, type SecEventRow } from './filings';
import { briefNote } from './marketBrief';
import { reviewHealthStmts, reviewStartFailed } from './reviewHealth';
import { EARLY_NOTE, EVIDENCE_TEXT, MAX_AI_WATCH, MAX_REVIEW_8K, WEB_DUE_DAYS, afterLastReview, condFacts, defaultAction, defaultCheck, defaultFacts, externalNeeds, revenueCheck, fileConditions, flaggedAccessions, fmtMetric, isAddAction, isAiWatch, isOwned, newEvidence, noneResponses, notifyTier, ownerText, pickFilings, thesisFacts, thesisFile, thesisNote, xbrlProgress, type CondAction, type EvidenceReason, type FileCondition, type ThesisFile } from './thesis';

export { cikFor } from './filings';
export { loadConditions } from './thesis';

export const routineReady = (env: Env) => !!(env.ROUTINE_FIRE_URL && env.ROUTINE_TOKEN);

// ---------------------------------------------------------------- 條件的儲存

const isAuto = (c: ConditionDraft) => !c.manual && c.kind !== 'PRICE' && (c.kind !== 'XBRL' || String(c.check.metric) in XBRL_METRICS);

/** 現在這份論點檔的條件；沒有 fileId 的舊自選是編號空的列（own_thesis §1.2）。 */
const fileClause = (fileId: string | null) => (fileId ? ['file_id = ?', [fileId]] : ['file_id IS NULL', []]) as [string, unknown[]];

const autoNote = (c: ConditionDraft, auto: boolean, reviewOnly: boolean) => (auto ? (reviewOnly ? '確認來源沒有申報可以讀，只在定期審查時由 AI 判斷' : null) : c.kind === 'PRICE' ? '價格條件只記錄' : '沒有通過檢查，只記錄');

/**
 * 審查建議新增的條件（own_thesis §1.5 第 1 點；T71 改照 confirm_audit_design §3）：寫入就監測——狀態照確認方式
 * （ACTIVE／REVIEW_ONLY／MANUAL，和 acceptStatus 同一個算法），origin = 'AI'、action = 'REVIEW'（成立時重新審查，不發甲類通知）、
 * accepted_at 留空（不是你定的）。tier_if_met 照存（AI 建議成立時的檔位，只顯示）。
 * 這次有寫入至少一條時，這份論點檔原本 AI 定、使用者沒動過、還沒成立的條件（監測中、只在審查時檢查、只記錄，和舊資料的 PROPOSED）
 * 標成 EXPIRED；使用者改過動作的（accepted_at 有值）與已經成立的（MET）不動。一條都沒提時舊的留著（呼叫的地方判斷）。
 * 不再寫 PROPOSED。map：證據包的編號（C…、W…）→ 列編號，把 supersedes 換成列編號（只記著；使用者把它改成你定的時才取代）。
 */
export function proposeStmts(db: D1Database, ticker: string, fileId: string | null, runId: string, drafts: ProposedDraft[], at: string, map: Record<string, number>): D1PreparedStatement[] {
  if (!drafts.length) return [];
  const [fw, fa] = fileClause(fileId);
  const ins = db.prepare("INSERT INTO own_conditions (ticker, run_id, cond_id, direction, kind, text, check_json, tier_if_met, status, created_at, note, origin, file_id, premise_id, supersedes, auto, action, accepted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'AI', ?, ?, ?, ?, 'REVIEW', NULL)");
  return [
    db.prepare(`UPDATE own_conditions SET status = 'EXPIRED' WHERE ticker = ? AND ${fw} AND accepted_at IS NULL AND origin = 'AI' AND status IN ('PROPOSED', 'ACTIVE', 'REVIEW_ONLY', 'MANUAL')`).bind(ticker, ...fa),
    ...drafts.slice(0, MAX_AI_WATCH).map((c) => {
      const auto = isAuto(c);
      const reviewOnly = auto && confirmMode(c) === 'REVIEW_ONLY';
      const status = reviewOnly ? 'REVIEW_ONLY' : auto ? 'ACTIVE' : 'MANUAL';
      return ins.bind(ticker, runId, c.condId, c.direction, c.kind, c.text, JSON.stringify(c.check), c.tierIfMet, status, at, autoNote(c, auto, reviewOnly), fileId, c.premiseId, c.supersedes && map[c.supersedes] ? map[c.supersedes] : null, auto ? 1 : 0);
    }),
  ];
}

/**
 * 寫入使用者勾選的條件（F14 改寫後勾選的出場條件，origin = USER）：直接是「你定的條件」，帶勾選時間與成立時的動作，
 * 狀態依確認方式（監測中／只在審查時檢查／只記錄）。帶這檔現在的論點檔編號。
 * T70（confirm_audit_design §2.2）：採用 stock bot 的草稿時，草稿的出場條件也走這裡（origin = AI_DRAFT_ACCEPTED，accepted_at 是採用的時間；
 * premiseId 是對應的前提編號）。
 */
export function insertConditionStmts(db: D1Database, ticker: string, runId: string, drafts: (ConditionDraft & { action?: CondAction; supersedes?: number | null; premiseId?: string | null })[], at: string, origin: 'AI' | 'USER' | 'AI_DRAFT_ACCEPTED', fileId: string | null): D1PreparedStatement[] {
  const ins = db.prepare('INSERT INTO own_conditions (ticker, run_id, cond_id, direction, kind, text, check_json, tier_if_met, status, created_at, note, origin, file_id, accepted_at, action, auto, supersedes, premise_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  return drafts.map((c) => {
    const auto = isAuto(c);
    // 確認來源只有法說會、新聞的事件條件沒有申報可以讀：不開 F25，只在定期審查時檢查（T24）
    const reviewOnly = auto && confirmMode(c) === 'REVIEW_ONLY';
    const status = reviewOnly ? 'REVIEW_ONLY' : auto ? 'ACTIVE' : 'MANUAL';
    return ins.bind(ticker, runId, c.condId, c.direction, c.kind, c.text, JSON.stringify(c.check), c.tierIfMet, status, at, autoNote(c, auto, reviewOnly), origin, fileId, at, c.action ?? defaultAction(c), auto ? 1 : 0, c.supersedes ?? null, c.premiseId ?? null);
  });
}

/** 條件成立（met_basis：XBRL 程式比對、PRESS 財報新聞稿擷取、FILING_VOTE 申報原文三票、REVIEW_VOTE 審查三票、WEB_VOTE 審查三票依條件指名的網頁來源，T53）。 */
export const metStmt = (db: D1Database, id: number, at: string, note: string, basis: 'XBRL' | 'PRESS' | 'FILING_VOTE' | 'REVIEW_VOTE' | 'WEB_VOTE') => db.prepare("UPDATE own_conditions SET status = 'MET', met_at = ?, note = ?, met_basis = ? WHERE id = ?").bind(at, note, basis, id);

// ---------------------------------------------------------------- 證據

export interface OwnEvidence {
  cik: string | null;
  filings: Filing[];
  rows: QuarterRow[];
  xbrl: PackDoc | null;
  docs: PackDoc[];
  news: PackDoc | null;
  /** 這檔的 RSS 標題（含連結；T52 的目錄挑清單內的連結用）。舊的呼叫端沒給 = undefined。 */
  headlines?: Headline[];
  dataQuality: Record<string, 'ok' | 'partial' | 'missing'>;
  notes: string[];
}

export const docOf = (f: { accession: string; form: string; filingDate: string; url: string; title: string; text: string }): PackDoc => ({ id: `F-${f.accession}`, source_id: `edgar:${f.accession}`, kind: 'filing', date: f.filingDate, title: f.title, url: f.url, text: f.text, fetched_at: new Date().toISOString() });

/** XBRL 季度表的原文（證據包用）。 */
export const xbrlDoc = (ticker: string, rows: QuarterRow[]): PackDoc | null => (rows.length ? { id: `X-${ticker}`, source_id: `xbrl:${ticker}`, kind: 'xbrl', date: rows[0].filed, title: `${ticker} 最近 ${rows.length} 季財報數字（XBRL）`, text: quarterTableText(ticker, rows) } : null);

/** 新聞標題的原文（只有標題，只能當初判）。 */
export async function newsDoc(fetcher: Fetcher, ticker: string, asOf: string, since?: string): Promise<PackDoc | null> {
  return newsDocOf(await fetchHeadlineFeed(fetcher, ticker), ticker, asOf, since);
}

/** 同上，從已經抓好的 RSS 組（F24 另外要用標題的連結組目錄，T52）。 */
export function newsDocOf(feed: HeadlineFeed, ticker: string, asOf: string, since?: string): PackDoc | null {
  const hl = feed.items.filter((h) => h.date <= asOf && (!since || h.date > since)).slice(0, 15);
  return hl.length ? { id: `N-${ticker}`, source_id: `${feed.source}:${ticker}`, kind: 'news', date: hl[0].date, title: `${ticker} 最近的新聞標題（${feed.label}，只有標題）`, text: hl.map((h) => `${h.date} | ${h.title}`).join('\n') } : null;
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
    const feed = await fetchHeadlineFeed(fetcher, ticker);
    out.headlines = feed.items;
    out.news = newsDocOf(feed, ticker, asOf);
    out.dataQuality.news = 'partial';
  } catch (e) {
    out.notes.push(`新聞標題：${errText(e)}`);
    out.dataQuality.news = 'partial';
  }
  return out;
}

/**
 * F24 的證據包裡由論點檔組的部分（own_thesis §1.6）：T0、事件 V、只有預設前提的 D1～D3、論點那一份 note，
 * 市場摘要那一份（T65，composite_layer_design §1.6；定期審查、提前審查、草稿都經過這裡），
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
  // 市場摘要（T65，composite_layer_design §1.6）：最近 30 天內的一份，只放大盤與這檔產業 ETF 的部分；背景，不能當引用
  const brief = await briefNote(env.DB, tf.ticker, asOf);
  if (brief.note) notes.push(brief.note);
  return { facts: [...thesisFacts(tf), ...defaultFacts(tf, ev.dataQuality.xbrl === 'ok' ? ev.rows : null, asOf)], filings, docs: [note, brief.doc].filter((d): d is PackDoc => !!d), notes };
}

/**
 * 月底檢查點的題目多一句（T54，web_evidence_design §1.7）：原因有 PEER → 同業有新的財報新聞稿（在目錄裡）；
 * 有 WEB_DUE → 哪幾條前提、條件需要外部資料（證據包的編號），請分析師找清單內來源的新消息。兩個都沒有 → null。
 * condMap：證據包的條件編號（C…、W…）→ 列編號（condFacts 的 map）。
 */
export function lookForText(reasons: readonly string[], tf: Pick<ThesisFile, 'kind' | 'premises' | 'conditions'>, condMap: Record<string, number>): string | null {
  const parts: string[] = [];
  if (reasons.includes('PEER')) parts.push('同業在上次有結論的審查之後有新的財報新聞稿（在 facts 的 M 開頭的目錄裡），請分析師看要不要取來讀');
  if (reasons.includes('WEB_DUE')) {
    const need = externalNeeds(tf);
    const byRow = new Map(Object.entries(condMap).map(([id, row]) => [row, id]));
    const conds = need.conds.map((row) => byRow.get(row)).filter((x): x is string => !!x);
    const what = [need.premises.length ? `前提 ${need.premises.join('、')}` : '', conds.length ? `指名網頁來源的條件 ${conds.join('、')}` : ''].filter(Boolean).join('，以及');
    if (what) parts.push(`${what} 在公司的申報與財報裡可能查不到（上次證據不足、還沒檢查過，或要用指名的網頁來源確認），距上次有結論的審查已經滿 ${WEB_DUE_DAYS} 天，請分析師找有沒有清單內來源的新消息`);
  }
  return parts.length ? `這次是月底檢查點：${parts.join('；')}。` : null;
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
  let tf = await thesisFile(env.DB, acct, ticker, view.date);
  // 一直沒回的乙類通知 → 論點檔記 NONE，這次的證據包寫「上次的失效通知沒有回應」（own_thesis §1.10）
  const none = tf ? noneResponses(acct, tf, view.date) : [];
  if (none.length) {
    await env.DB.batch(none.map((l) => thesisLogStmt(env.DB, l, null, now.toISOString())));
    tf = await thesisFile(env.DB, acct, ticker, view.date);
  }
  // 你定的條件 C、觀察項 W（T26；財報類觀察項用這次的 XBRL 比對）
  const conds = tf ? condFacts(tf, ev.dataQuality.xbrl === 'ok' ? ev.rows : null) : undefined;
  const extra = tf ? await reviewThesisEvidence(env, fetcher, tf, ev, view.date) : { facts: [], filings: [], docs: [], notes: [] };
  // 目錄（T52，web_evidence_design §1.2）：同業的申報、清單內的 RSS 連結，只有標題；只有預設前提的沒有目錄、不能取文件
  // 清單內的網頁來源（T53，facts 的 S 開頭）跟目錄一起：分析師搜尋時優先挑、建議的條件指名來源時只能指名這些
  const menu = tf && acct.own[ticker] ? await buildDocMenu(env, fetcher, { ticker, tf, meta: acct.own[ticker], asOf: view.date, headlines: ev.headlines ?? null }) : null;
  // 月底檢查點因為同業的新申報或「要上網查」開的審查（T54，web_evidence_design §1.7）：題目寫明要分析師找什麼
  const lookFor = tf && reasons && menu && !menu.ctx.off ? lookForText(reasons, tf, conds?.map ?? {}) : null;
  // 新眼光（T63，composite_layer_design §3）：定期審查每檔每 90 個日曆天最多一次，由程式決定這次跑不跑、寫進證據包告訴 prompt；
  // 跑的那一次，取文件的額度替它留 1 份（doc_ctx.fresh）。只有預設前提的不跑
  const canFetch = !!menu && !menu.ctx.off;
  const fresh = tf ? freshPlan(OWN_REVIEW, view.date, { defaultOnly: tf.kind === 'DEFAULT_ONLY', lastFresh: await lastFreshReview(env.DB, ticker, view.date), canFetch }) : undefined;
  // 提高到 125% 的營收核對（allocation_redesign §4.3）、只有預設前提的先買一半的確認（§4.1）：程式由 XBRL 季度表算，記在證據包
  const rows = ev.dataQuality.xbrl === 'ok' ? ev.rows : null;
  const revenue: RevenueCheck = revenueCheck(rows);
  const dflt = tf ? defaultCheck(tf, rows, view.date) : null;
  const { pack, notes } = ownReviewPack({ acct, view, axis, ticker, runId: newRunId(view.date, OWN_REVIEW, ticker), trigger, revenue, ...(dflt ? { defaultCheck: dflt } : {}), xbrl: ev.xbrl, filings: [...ev.docs, ...extra.filings], news: ev.news, conds, webDomains: menu?.sources.domains ?? [], dataQuality: ev.dataQuality, extraFacts: [...extra.facts, ...(early?.facts ?? []), ...(menu?.facts ?? []), ...(menu?.sources.facts ?? [])], extraDocs: extra.docs, reasons, ...(early ? { early: { reason: early.reason, events: early.events } } : {}), ...(lookFor ? { lookFor } : {}), ...(fresh ? { freshEyes: fresh } : {}), now });
  const docCtx = menu ? (fresh?.run && canFetch ? { ...menu.ctx, fresh: { ...FRESH_RESERVE } } : menu.ctx) : null;
  return startRun(env, fetcher, pack, now, [...ev.notes, ...extra.notes, ...(menu?.notes ?? []), ...notes], docCtx);
}

// ---------------------------------------------------------------- 套用結論

/**
 * 申報或財報表的簡稱（失效通知的理由用）：`8-K 2027-01-06`、`財報數字表（XBRL，2027-01-08）`；
 * 分析師取回的同業申報（T52，標題是「〔同業申報｜Micron〕8-K…」）：`Micron 的 8-K 2026-09-25`。
 */
export function docLabel(doc: Pick<PackDoc, 'kind' | 'title' | 'date'> | undefined): string | null {
  if (!doc) return null;
  if (doc.kind === 'xbrl') return `財報數字表（XBRL，${doc.date}）`;
  const peer = /^〔同業申報｜(.+?)〕(.*)$/.exec(doc.title);
  const form = /^([^\s（：]+)/.exec(peer ? peer[2] : doc.title)?.[1] ?? '申報';
  return `${peer ? `${peer[1]} 的 ` : ''}${form} ${doc.date}`;
}

/** 網頁文件的簡稱（T53）：`TrendForce 2026-09-30 的新聞稿`；網址路徑看不出是新聞稿的寫「文章」。不是網頁 → null。 */
export function webDocLabel(doc: PackDoc | undefined): string | null {
  const w = doc ? webMetaOf(doc) : null;
  if (!doc || !w) return null;
  const path = (() => {
    try {
      return doc.url ? new URL(doc.url).pathname : '';
    } catch {
      return '';
    }
  })();
  return `${w.label} ${doc.date} 的${/press/i.test(path) ? '新聞稿' : '文章'}`;
}

/** 通知上「依據」那一句（web_evidence_design §1.6）：text 是依據、note 是後面括號裡的字、web 是依據裡有沒有網頁。 */
export interface CitedBasis {
  text: string;
  note: string;
  web: boolean;
}
export const BASIS_NOTE = { filing: '引用在網站', web: '網頁；引用與連結在網站', both: '後者是網頁；引用與連結在網站' } as const;

/**
 * 三票裡第一張有合格引用的票，它引用的依據（乙類的「依據：…」、甲類 WEB_VOTE 的理由）：
 *   申報或財報表寫在前面（第一份）；網頁接在後面——判前提不成立時取第一份一手或產業研究機構，沒有的話取媒體的前兩個不同網域；
 *   確認條件成立時（named = 條件指名的網域）只取那個來源、級別是一手或產業研究機構的第一份。級別都是判的時候的（T68）；只當線索、還沒評級的不取。
 * pick：從一票裡取出那件事的引用編號（某條前提或某條條件的 evidence_ids）。
 */
export function citedBasis(run: { outcome: AiRun['outcome']; pack: Pick<EvidencePack, 'documents'> }, pick: (s: CheckedSample) => unknown, named?: readonly string[]): CitedBasis | null {
  const src = packSources(run.pack);
  const docs = new Map(run.pack.documents.map((d) => [d.source_id, d]));
  for (const s of run.outcome?.samples.filter((x) => x.valid) ?? []) {
    const from = [...new Set(citedSources(s, pick(s)))];
    const hard = from.find((id) => src.hard.has(id));
    const webs = from.filter((id) => src.web.has(id));
    let web: string[] = [];
    if (named) web = webs.filter((id) => STRONG_RATINGS.includes(src.web.get(id)!.tier) && named.some((n) => sameWebDomain(src.web.get(id)!.domain, n))).slice(0, 1);
    else {
      const strong = webs.find((id) => STRONG_RATINGS.includes(src.web.get(id)!.tier));
      if (strong) web = [strong];
      else {
        const seen = new Set<string>();
        const media = webs.filter((id) => {
          if (src.web.get(id)!.tier !== 'MEDIA') return false;
          const dom = src.web.get(id)!.domain;
          if (seen.has(dom)) return false;
          seen.add(dom);
          return true;
        });
        if (media.length >= MEDIA_MIN_DOMAINS) web = media.slice(0, MEDIA_MIN_DOMAINS);
      }
    }
    const parts = [hard ? docLabel(docs.get(hard)) : null, ...web.map((id) => webDocLabel(docs.get(id)))].filter((x): x is string => !!x);
    if (!parts.length) continue;
    return { text: parts.join('、'), note: !web.length ? BASIS_NOTE.filing : hard ? BASIS_NOTE.both : BASIS_NOTE.web, web: web.length > 0 };
  }
  return null;
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
 *   AI 監測中的條件（不是你定的，T71，confirm_audit_design §3）→ 一律當成重新審查：不發甲類通知、不會叫你賣
 *     （tier_if_met 只是 AI 建議的檔位；舊列沒有 action 時也不照 tier_if_met 通知）
 *   動作是出清或減半 → 當天通知（不設上限）；monthly = 月審確認成立的 → 進隔天的月報（項目相同）
 *   換算出來不用賣 → 不發通知，條件照樣是成立（「要看的事」的 COND_MET_NO_SELL 由論點檔判斷）
 *   加碼條件（動作是補到標準比重、提高到 125%，T84，allocation_redesign §4.2）→ 不走甲類、不發當天通知，見 queueAddCondition
 * why：理由（依 met_basis）；AI 建議、你勾選的條件另外寫一句是誰哪天勾的。
 */
export function notifyOwnCondition(ctx: ApplyCtx, c: FileCondition, why: string, runIds: string[], label: string, monthly = false): void {
  const t = c.ticker;
  if (!ctx.acct.own[t]) return;
  const owned = isOwned(c);
  if (owned && isAddAction(c.action)) return queueAddCondition(ctx, c, c.action, why, runIds, label);
  const tier = owned ? notifyTier(c) : null;
  if (!tier) {
    ctx.acct = clone(ctx.acct);
    ctx.acct.own[t].condReviewDue = ctx.session;
    return void ctx.log.push(`${label}（${owned ? '成立時重新審查' : 'AI 監測中，成立時重新審查'}）→ 不通知，開一次審查（觸發原因：條件成立）`);
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
 * 你定的加碼條件成立（allocation_redesign §4.2，T84）：買進的建議只進月報（§4.0 第 2 點），不發當天通知。
 *   減半中 → 條件照樣標成立（呼叫前已經標了），不提加碼；持股頁寫「條件成立；這檔在減半中，加回看 200 日線」（加回只看 §3.4）
 *   先買一半還沒過關、動作是補到標準比重 → 當成先買一半的確認（§4.1「兩者先到的算」）：build.ok，下一份月報列補滿（F27）
 *   先買一半已經過關（補滿在等月報）、動作是補到標準比重 → 不另外列
 *   其他 → 記進 addMonthly，下一份月報列 F28（買進前的程式檢查在月報時做，股數照那天的持股算）
 */
export function queueAddCondition(ctx: ApplyCtx, c: FileCondition, action: 'FILL' | 'RAISE', why: string, runIds: string[], label: string): void {
  const t = c.ticker;
  ctx.acct = clone(ctx.acct);
  const m = ctx.acct.own[t];
  const rule = ctx.acct.rule.own[t];
  if (!m || !rule) return;
  const setAt = (c.acceptedAt ?? c.createdAt).slice(0, 10);
  const md = `${Number(setAt.slice(5, 7))}/${Number(setAt.slice(8, 10))}`;
  if (m.slow.state === 'HALF' || rule.applied === 'HALF') {
    m.buyBlocked = { date: ctx.session, what: '加碼', text: '這檔在減半中', line: `你定的加碼條件「${c.text}」成立；這檔在減半中，加回看 200 日線` };
    return void ctx.log.push(`${label}（加碼條件）→ 這檔在減半中，只標成立、不提加碼（加回看 200 日線）`);
  }
  if (action === 'FILL' && m.build && rule.applied === 'BUILD') {
    if (m.build.ok) return void ctx.log.push(`${label}（加碼條件：補到標準比重）→ 先買一半已經確認過，補滿在等月報，不另外列`);
    m.build.ok = { date: ctx.session, ...(runIds[0] ? { runId: runIds[0] } : {}), text: `你在 ${md} 定的加碼條件「${c.text}」成立`, cond: true };
    delete m.build.last;
    return void ctx.log.push(`${label}（加碼條件：補到標準比重）→ 當成先買一半的確認，下一份月報列補滿（F27）`);
  }
  const spec: AddNotice = { id: c.id, text: c.text, action, setAt, why: c.origin !== 'USER' && c.acceptedAt ? `${why}。這條是${ownerText(c)}` : why, metOn: ctx.session, premiseId: c.premiseId, runIds };
  m.addMonthly = [...(m.addMonthly ?? []).filter((x) => x.id !== c.id), spec];
  ctx.log.push(`${label}（加碼條件：${action === 'RAISE' ? '提高到標準的 125%' : '補到標準比重'}）→ 進下一份月報（F28），不發當天通知`);
}

/**
 * F24 → 引擎記下檔位與不成立的前提，照 own_thesis §1.9 決定怎麼給（routeReview：當天通知乙類、進月報、更新還沒回覆的通知、只放網站）；
 * 條件只在三票一致（含一致選「不動」）時動（own_thesis §1.5、§1.6）：
 *   你定的條件（REVIEW_ONLY、申報確認的 ACTIVE）三票確認成立 → MET（met_basis = REVIEW_VOTE），甲類通知（月審確認的進隔天的月報）
 *     條件指名了網頁來源、靠那個來源的引用成立的（T53，web_evidence_design §1.6）→ met_basis = WEB_VOTE，理由寫是哪個來源哪一天的文章
 *   AI 監測中的條件（W，T71）三票確認成立 → 一樣標 MET（REVIEW_VOTE／WEB_VOTE）；動作固定是重新審查，確認它的就是這次審查，不另外開
 *   財報類的條件（C、W）以程式比對為準，審查的看法只記錄；舊資料的觀察項（PROPOSED）成立與否只是給下一次審查的輸入
 *   建議新增的條件 → 寫入就是 AI 監測中（proposeStmts：有寫入時舊的 AI 條件 EXPIRED，沒提時留著）。你定的條件不會被換掉。
 */
export async function applyOwnReview(ctx: ApplyCtx, run: AiRun): Promise<void> {
  const t = run.ticker ?? '';
  // 連續沒有結論的次數與告警、連續票數不一致的次數（own_thesis §3.6.4）
  await reviewHealthStmts(ctx, run);
  // 財報後的審查：先買一半的確認（allocation_redesign §4.1）、提高到 125% 的「連兩季證實」（§4.3）。沒有結論的也算一次（沒過關、沒證實）
  if (ctx.acct.own[t] && (run.pack.rule.detail as { trigger?: string } | undefined)?.trigger === 'EARNINGS') applyEarningsChecks(ctx, run);
  if (!run.outcome || !ctx.acct.own[t]) return void ctx.log.push(`${run.runId}：${ctx.acct.own[t] ? '沒有結論' : '已經不是自選股'}，不套用`);
  const d = reviewDecision(run.outcome, ctx.acct, t, run.asOf, run.pack);
  const detail = (run.pack.rule.detail ?? {}) as { conds?: Record<string, number>; trigger?: string };
  const trigger = (detail.trigger || 'MANUAL') as ReviewTrigger;
  if (d.tier) {
    const basis = d.premiseId ? citedBasis(run, (s) => s.premises.find((p) => p.premise_id === d.premiseId && p.status === 'BROKEN')?.evidence_ids ?? []) : null;
    const r = routeReview(ctx.acct, ctx.view, t, { tier: d.tier, suggest: d.suggest, consensus: d.consensus, premiseId: d.premiseId, trigger, date: run.asOf, runId: run.runId, basis: basis?.text ?? null, basisNote: basis?.web ? basis.note : null });
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
    if (!c) continue;
    // C：你定的；W：AI 監測中的（T71）。舊資料的觀察項（PROPOSED）不監測，成立與否只是輸入
    const mine = pid.startsWith('C') && isOwned(c);
    const watch = pid.startsWith('W') && isAiWatch(c);
    if (!mine && !watch) continue;
    if (c.kind === 'XBRL') {
      ctx.log.push(`${run.runId}：財報條件 ${pid}（${c.text}）3 票認為成立；以程式比對財報數字為準，只記錄`);
      continue;
    }
    if (!(c.status === 'REVIEW_ONLY' || (c.status === 'ACTIVE' && confirmMode(c) === 'FILING'))) continue;
    // 合格的引用以條件現在指名的來源再看一次（§1.6；組證據包之後改過來源的照現在的）：每一票都要有申報、財報表或那個來源的網頁
    const src = packSources(run.pack);
    const votes = run.outcome.samples.filter((s) => s.valid);
    const condIds = (s: CheckedSample) => (Array.isArray(s.payload?.condition_checks) ? (s.payload!.condition_checks as Record<string, unknown>[]) : []).find((x) => x && String(x.id) === pid && x.status === 'MET')?.evidence_ids ?? [];
    const named = namedWebDomains(c.check);
    const bases = votes.map((s) => condCite(s, condIds(s), src, named));
    if (bases.some((b) => !b)) {
      ctx.log.push(`${run.runId}：${mine ? '你定的' : 'AI 監測中的'}條件 ${c.condId} 3 票認為成立，但引用的網頁不是這條條件現在指名的來源、或那個來源不是一手或產業研究機構，不算成立`);
      continue;
    }
    // 至少一票靠的是指名的網頁來源 → WEB_VOTE，理由寫那一份（靠網頁的那一票排前面）
    const viaWeb = bases.some((b) => b === 'WEB');
    const webBasis = viaWeb ? citedBasis({ outcome: { ...run.outcome, samples: [...votes.filter((_, k) => bases[k] === 'WEB'), ...votes.filter((_, k) => bases[k] !== 'WEB')] }, pack: run.pack }, condIds, named) : null;
    ctx.stmts.push(metStmt(ctx.db, c.id, at, viaWeb ? `定期審查 ${run.runId} 3 票確認（${webBasis!.text}）` : `定期審查 ${run.runId} 3 票確認`, viaWeb ? 'WEB_VOTE' : 'REVIEW_VOTE'));
    const label = `${run.runId}：${mine ? '你定的' : 'AI 監測中的'}條件 ${c.condId} 由審查 3 票確認成立${viaWeb ? '（指名的網頁來源）' : ''}`;
    // 動作是重新審查（AI 監測中的一律是）：確認它成立的就是這次審查，結論照 §1.9 處理，不再另外開
    if (!mine || (!notifyTier(c) && !isAddAction(c.action))) ctx.log.push(`${label}（成立時重新審查）→ 這次審查就是重新審查，結論照建議的規則處理`);
    else notifyOwnCondition(ctx, c, viaWeb ? `${webBasis!.text}，3 票確認（${webBasis!.note}）` : `${run.asOf} 的審查 3 票確認（引用在網站）`, [run.runId, c.runId], label, trigger === 'MONTHLY');
  }
  if (d.proposed.length) {
    ctx.stmts.push(...proposeStmts(ctx.db, t, ctx.acct.own[t].fileId ?? null, run.runId, d.proposed, at, map));
    ctx.log.push(`${run.runId}：寫入 ${Math.min(d.proposed.length, MAX_AI_WATCH)} 條建議的條件（AI 監測中，成立時重新審查）`);
  }
}

/**
 * 財報後的審查（觸發原因 EARNINGS）套用時：
 *   先買一半的確認（allocation_redesign §4.1，D4）：有論點的看三票（3 票一致、沒有任何前提被判不成立、檔位不是減半或出清）；
 *     只有預設前提的看程式比對 D1～D3（證據包的 rule.detail.defaultCheck），不看 AI 的票。過關 → 下一份月報列補滿；沒過關 → 等下一份財報。
 *   提高到 125% 的門檻（§4.3，D6）：這次有沒有證實前提（3 票一致、每一條前提都判成立、引用有申報或財報）記進 earnChecks。
 */
/**
 * 先買一半的確認過關沒有（allocation_redesign §4.1 的表；純函式）。defaultOnly：只有預設前提（看程式比對的 D1～D3，不看票）；
 * d：這次審查的結論（沒有結論是 null）；dflt：證據包的 rule.detail.defaultCheck。text 是持股頁與補滿項目上的那一句。
 */
export function buildPassOf(defaultOnly: boolean, asOf: string, d: { consensus: boolean; brokenPremises: string[]; tier: Tier | null } | null, dflt: { ok: boolean | null; why: string } | null | undefined): { pass: boolean; text: string } {
  const md = `${asOf.slice(5, 7)}-${asOf.slice(8, 10)}`;
  if (defaultOnly) {
    const pass = dflt?.ok === true;
    return { pass, text: pass ? `${md} 的財報，系統預設前提 D1～D3 都成立` : `${md} 的財報：${dflt ? dflt.why : '沒有程式比對的結果'}` };
  }
  if (!d) return { pass: false, text: `${md} 的財報後審查沒有結論` };
  const down = d.tier === 'HALF' || d.tier === 'EXIT';
  if (d.consensus && !d.brokenPremises.length && !down) return { pass: true, text: `${md} 的財報後審查，3 票，前提都沒有被判不成立` };
  if (d.brokenPremises.length) return { pass: false, text: `${md} 的財報後審查判前提 ${d.brokenPremises.join('、')} 不成立` };
  if (!d.consensus) return { pass: false, text: `${md} 的財報後審查沒有一致結論` };
  return { pass: false, text: `${md} 的財報後審查選了${d.tier ? TIER_NAME[d.tier] : '往下的檔位'}` };
}

function applyEarningsChecks(ctx: ApplyCtx, run: AiRun): void {
  const t = run.ticker ?? '';
  const meta = ctx.acct.own[t];
  const dflt = (run.pack.rule.detail as { defaultCheck?: { ok: boolean | null; why: string } } | undefined)?.defaultCheck;
  if (meta.build && !meta.build.ok) {
    const defaultOnly = meta.premises.every((p) => p.origin === 'SYSTEM_DEFAULT');
    const { pass, text } = buildPassOf(defaultOnly, run.asOf, !defaultOnly && run.outcome ? reviewDecision(run.outcome, ctx.acct, t, run.asOf, run.pack) : null, dflt);
    ctx.acct = buildEarnings(ctx.acct, t, { date: run.asOf, runId: run.runId, pass, text });
    ctx.log.push(`${run.runId}：先買一半的確認 → ${pass ? '過關，下一份月報列補滿' : `沒過關（${text}），等下一份財報`}`);
  }
  const c = run.outcome ? earningsConfirmed(run.outcome, run.pack) : { confirmed: false, why: '沒有結論' };
  ctx.acct = recordEarnCheck(ctx.acct, t, { date: run.asOf, runId: run.runId, confirmed: c.confirmed, why: c.why });
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
 * 監測中的（ACTIVE：你定的與 AI 監測中的）與舊資料的觀察項（PROPOSED）每次比對都寫進度 progress_json（§3.6.2）；
 * 監測中的成立時標 MET：你定的照動作通知，AI 監測中的開一次重新審查（notifyOwnCondition）。
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
      notifyOwnCondition(ctx, c, xbrlWhy(c.check, m.values, rows[0]), [c.runId], `${t} ${isOwned(c) ? '' : 'AI 監測中的'}財報條件 ${c.condId} 成立（程式比對 XBRL）`);
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
    // 0 股的自選（例如自選比例改成 0%）不送條件監測與審查，持有後恢復（T39b）
    if (!acct.own[c.ticker] || !ownHeld(acct, c.ticker)) continue;
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
      if (!ownHeld(acct, t)) {
        res.log.push(`${t}：現在 0 股，月底檢查點不審查（持有後恢復）`);
        continue;
      }
      const tf = await thesisFile(env.DB, acct, t, session);
      const all = sc.checks.find((c) => c.ticker === t)?.all ?? null;
      // 同業的申報（PEER，T54）：只有有論點的股票用網頁證據與同業（只有預設前提的沒有目錄）
      const peers = tf && tf.kind === 'THESIS' && tf.lastReview ? await fetchPeerFilings(env, fetcher, acct.own[t].webSources ?? null, res.log, t) : undefined;
      const reasons: EvidenceReason[] = tf ? newEvidence(tf, all, session, peers) : ['NEVER'];
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
    if (!ownHeld(acct, t)) continue; // 0 股：論點變動後的審查留著，持有後再開（T39b）
    const sameDay = review.has(t) || !!(await env.DB.prepare("SELECT 1 AS x FROM ai_runs WHERE fn = 'OWN_REVIEW' AND ticker = ? AND as_of = ? LIMIT 1").bind(t, session).first());
    const recent = !!thesisReviewHeld(m, session);
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
 * 你定的條件成立、動作是「重新審查」（own_thesis §1.10 甲類），或 AI 監測中的條件成立（T71）：condReviewDue 有值的開一次審查，觸發原因 CONDITION，
 * 不受提前審查的頻率上限限制。今天已經有這檔的審查（例如財報後的）→ 只清掉。沒開成 → 留著，下一次開執行時再試。
 * 每日第一次流程（startOwnRuns 最後）與 01:30 的 finalStarts 都呼叫：01:30 才套用的條件確認當天就開。
 */
export async function startCondReviews(sc: StartCtx): Promise<void> {
  const { env, fetcher, acct, view, axis, session, ov, now, res } = sc;
  const patch: Record<string, Partial<OwnMeta>> = {};
  for (const [t, m] of Object.entries(acct.own)) {
    if (!m.condReviewDue) continue;
    if (!ownHeld(acct, t)) continue; // 0 股：留著，持有後再開（T39b）
    const same = await env.DB.prepare("SELECT 1 AS x FROM ai_runs WHERE fn = 'OWN_REVIEW' AND ticker = ? AND as_of = ? LIMIT 1").bind(t, session).first();
    if (same) {
      patch[t] = { condReviewDue: null };
      res.log.push(`${t} 條件成立（重新審查）：今天已經有審查，不另外開`);
      continue;
    }
    try {
      res.started.push((await startOwnReview(env, fetcher, acct, view, axis, t, 'CONDITION', now)).runId);
      patch[t] = { condReviewDue: null, ...(m.reviewSkip ? { reviewSkip: null } : {}) };
      res.log.push(`${t} 條件成立（重新審查）→ 開審查`);
    } catch (e) {
      res.log.push(`${t} 的審查（條件成立）沒有開成：${errText(e)}`);
      res.alerts.push({ kind: 'FLOW_ERROR', message: `${t} 的 AI 審查（條件成立、動作是重新審查）沒有開成：${errText(e)}` });
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

/** 個股自身大跌、上次有結論的審查之後沒有新的申報或事件、這檔有論點時，提前審查的題目多的那一句（web_evidence_design §1.7）。 */
export const EARLY_NO_FILING_ASK = '沒有新的申報，請分析師找有沒有清單內來源的消息';

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
 *   3. 只限價格類：上次有結論的審查之後沒有新的申報或事件（新證據沒有 FILING、EVENT，也不是 NEVER）：
 *      只有系統預設前提 → 「沒有新的申報可以檢查」（要看的事 PRICE_NO_FILING）；
 *      有論點 → 不擋，照下面的順序走（T54，web_evidence_design §1.7），開成時題目多一句「沒有新的申報，請分析師找有沒有清單內來源的消息」
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
    else if (!ownHeld(acct, e.ticker)) mark(EARLY_NOTE.notHeld, e); // 0 股時不送提前審查（T39b）
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
    let kind: ThesisFile['kind'] | null = null;
    // 個股自身大跌、沒有新的申報可以檢查，但這檔有論點 → 照樣開，題目請分析師上網找（T54，web_evidence_design §1.7）
    let noFiling = false;
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
          kind = tf?.kind ?? null;
          let filings: Filing[] | null = sc.checks.find((c) => c.ticker === t)?.all ?? null;
          if (!filings && opt.fetchChecks && env.EDGAR_USER_AGENT) filings = (await fetchFilingChecks(env, fetcher, [t], session, res.log))[0]?.all ?? null;
          evidence = tf ? newEvidence(tf, filings, session) : ['NEVER'];
        }
        // 申報清單抓不到（UNKNOWN）當成有新證據，照審（和月底檢查點相同）
        if (!evidence.some((r) => r === 'NEVER' || r === 'FILING' || r === 'EVENT' || r === 'UNKNOWN')) {
          // 只有預設前提的：照舊不開、列進要看的事（它不用網頁證據，審了也只能說「價格跌了」）
          if (kind !== 'THESIS') {
            mark(EARLY_NOTE.noFiling, e);
            res.log.push(`${t} 個股自身大跌（${e.detail ?? ''}），上次審查之後沒有新的申報或事件，只有系統預設前提：不提前審查，列進要看的事`);
            continue;
          }
          noFiling = true;
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
      if (noFiling) reasons.splice(1, 0, EARLY_NO_FILING_ASK);
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

/**
 * 論點變動後的審查在 session 那一次每日流程會不會被 30 天的上限擋下（§3.6.5）：擋下時回傳上次開論點變動後審查的日子，否則 null。
 * 每日流程用它決定開不開；編輯論點頁的預覽用它寫「M/D 已經審過一次，這次的改動留到月底檢查點審」（T45）。
 */
export function thesisReviewHeld(m: Pick<OwnMeta, 'thesisReviewAt'>, session: string): string | null {
  return m.thesisReviewAt && daysApart(m.thesisReviewAt, session) < THESIS_REVIEW_GAP ? m.thesisReviewAt : null;
}

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
