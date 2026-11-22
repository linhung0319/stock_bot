// T55：論點草稿（OWN_DRAFT，web_evidence_design §2.2、§2.4 第 6 點）。純函式：證據包、送回的草稿逐欄檢查、檢查過的草稿。
// 資料抓取、時機與上限、own_drafts 表在 src/app/ownDraft.ts。
//
//   權限 A2（只說明；使用者按「採用這份草稿」才整份生效，T70），一份（samples = 1），不是三票。
//   流程（own_draft_v2）：研究員讀證據包、可以找資料（和審查同一套取文件，§1.5）→ 反方先寫 → 正方回應 → 主筆寫草稿。
//   程式檢查（§2.2）不過的整份退回（這一票改成 INSUFFICIENT、原因寫進 issues），不給使用者半份草稿：
//     外殼與 evidence 照 check.ts（引用逐字出自證據包）；前提 3～5 條、出場條件 2～6 條、字數上限同 parseThesisBlock；
//     至少一條出清或減半的出場條件是財報數字門檻（數字有通過檢查的引用）；
//     反方 3 點、每點至少一條通過檢查的引用；來源的網域要是公開的 https 主機（safeWebUrl；T69 起網域拿掉、不檢查）；
//     這檔有還沒回覆的乙類通知時（§2.4 第 6 點）keep_id 不能是被判不成立的那一條，文字很像的標出來。
//   T60（composite_layer_design §2.2、§2.3；prompt 升成 own_draft_v2）：前提的欄位改成
//     confirms_if（怎樣算證實）、breaks_if（1～3 句）、verify { by, source, every }（by = NONE 是信念）。檢查多四條、拿掉一條：
//     1. breaks_if 的子句不能在證據包的財報表裡已經成立（src/ai/xbrlClause.ts 認得的寫法；verify.by 是 XBRL 或 FILING 的才比）
//     2. 前提的本文不放會過時的字樣（「最新一季」「財測約」…）
//     3. verify.by 不是 NONE 時 confirms_if 必填
//     4. 至少 2 條不是信念的前提；拿掉「NONE 最多 1 條」（信念不限條數）
//   T69（confirm_audit_design §2.2、§2.3；prompt 升成 own_draft_v3）：
//     EVENT 出場條件的 check 要寫確認來源 { type: 'event', confirm_by: [...] }，用改寫（own_check）送回時的同一個格式檢查函式
//     （src/ai/ownReview.ts 的 conditionFormatIssue）；不合格的整份退回。XBRL 照舊（財報門檻的檢查）、PRICE 照舊只記錄。
//     sources 只剩 peers：送回的 sources.domains 不看、不存；T69 以前存的舊草稿有 domains 的照樣讀得出來（型別裡是可選的）。
import type { CheckedEvidence, CheckedSample, EvidencePack, Outcome, PackDoc, PackPremise } from './check';
import { buildPack } from './pack';
import { PREMISE_FIELD_LIMITS, VERIFY_BY, premiseKey, type VerifyBy } from '../engine';
import type { CondAction } from '../app/thesis';
import type { QuarterRow } from '../data/edgar';
import { conditionFormatIssue, webRefDomain } from './ownReview';
import { clauseMetNow, type ClauseQuarter } from './xbrlClause';

export const OWN_DRAFT = 'OWN_DRAFT';
/** T84：v4 可以附 0～2 條加碼條件（payload.adds；allocation_redesign §4.2），不收價格條件。 */
export const OWN_DRAFT_PROMPT = 'own_draft_v4';

/**
 * 程式檢查的數字（§2.2）。條數上限與字數上限同 parseThesisBlock 的 THESIS_LIMITS（src/ai/discussion.ts；這裡不 import 它，
 * 免得每個 AI 執行的檢查都拉進討論包的模組；測試確認兩邊一樣）。
 */
export const DRAFT_LIMITS = {
  premisesMin: 3,
  premisesMax: 5,
  exitsMin: 2,
  exitsMax: 6,
  /** 加碼條件（T84，§4.2）：0～2 條。 */
  addsMax: 2,
  thesis: 600,
  premise: 200,
  exit: 300,
  /** 「怎樣算不成立」每一句的上限（T60 起最多 3 句，breaksClauses）。 */
  breaksIf: PREMISE_FIELD_LIMITS.clause,
  breaksClauses: PREMISE_FIELD_LIMITS.breaksClauses,
  confirmsIf: PREMISE_FIELD_LIMITS.confirmsIf,
  /** verify.source 的上限。 */
  hint: PREMISE_FIELD_LIMITS.source,
  everyMin: PREMISE_FIELD_LIMITS.everyMin,
  everyMax: PREMISE_FIELD_LIMITS.everyMax,
  /** 至少幾條不是信念的前提（composite §2.3；取代 T55 的「NONE 最多 1 條」）。 */
  checkableMin: PREMISE_FIELD_LIMITS.minCheckable,
  against: 3,
  line: 300,
  notCheckable: 5,
  peers: 4,
} as const;

/** 前提用什麼查（T55 叫 checkable_by；T60 起是 verify.by）：同 engine 的 VERIFY_BY。 */
export const CHECKABLE_BY = VERIFY_BY;
export type CheckableBy = VerifyBy;

/**
 * 前提本文裡會過時的字樣（composite §2.2 草稿檢查第 2 條：「前提的本文不放會過時的數字」由 prompt 規定，程式只擋這類字樣）。
 * 只看前提的本文；confirms_if、breaks_if、出場條件可以寫現在的數字（例如「毛利率連兩季低於 55%（最新一季 61.2%）」）。
 */
export const DATED_WORDS = /最新一季|最近一季|本季|這一季|財測約|財測為|目前股價|現在股價|目前的股價|現價/;
const ACTIONS: readonly CondAction[] = ['EXIT', 'HALF', 'REVIEW'];
/** 加碼條件的動作（T84）：補到標準比重、提高到標準的 125%。 */
const ADD_ACTIONS: readonly CondAction[] = ['FILL', 'RAISE'];
/** 加碼條件不收價格條件（同 ownCheck.ts 的 ADD_PRICE_ISSUE；這裡不 import 改寫的模組）。 */
const ADD_PRICE = '加碼條件不收價格條件（跌到多少就加碼是「下跌加碼」的範圍，有它自己的限制）';
const XBRL_TYPES = ['xbrl_metric_below', 'xbrl_metric_above'];
const ANSWERS = ['YES', 'NO', 'UNSURE'] as const;

/** 開執行時這檔有還沒回覆的乙類通知（§2.4 第 6 點）：被判不成立的前提、它的文字、通知編號、草稿最上面固定的那句話。 */
export interface DraftBroken {
  premiseId: string;
  text: string;
  notif: number;
  notice: string;
}
/** 草稿最上面固定的那句話（§2.4 第 6 點；T56 顯示）。 */
export const brokenNotice = (premiseId: string): string => `前提 ${premiseId} 剛被判不成立。在這之後改論點，很容易只是替繼續持有找新理由`;

/**
 * 檢查過的一條前提（T60 的形狀，composite §2.2）。T55（own_draft_v1）存的舊草稿是 breaks_if（一段字）、checkable_by、source_hint，
 * 讀的地方（src/app/ownDraft.ts 的 draftPremiseFields、public/js/thesis-draft.js）兩種都收。
 */
export interface DraftPremise {
  text: string;
  /** 沿用現行的哪一條（沒改字才能寫）；新的是 null。 */
  keep_id: string | null;
  /** 怎樣算證實（信念可以沒有：null）。 */
  confirms_if: string | null;
  /** 怎樣算不成立：1～3 句。 */
  breaks_if: string[];
  /** 怎麼驗證：by = NONE 是信念；source、every 沒寫是 null（every 用 100 天）。 */
  verify: { by: CheckableBy; source: string | null; every: number | null };
  /** 通過檢查的引用編號。 */
  evidence_ids: string[];
  /** 文字和剛被判不成立的那一條很像（§2.4 第 6 點：標出來，不擋）。 */
  like_broken?: boolean;
}
export interface DraftExit {
  text: string;
  action: CondAction;
  /** 對應第幾條前提（0 起）；沒有是 null。 */
  premise_index: number | null;
  evidence_ids: string[];
  kind: 'XBRL' | 'EVENT' | 'PRICE' | null;
  /**
   * 監測的格式：kind = XBRL 是財報門檻 { type, metric, level, quarters? }；kind = EVENT 是確認來源 { type: 'event', confirm_by }
   * （T69 起，和改寫送回的條件同一個格式，web:<網域> 寫成小寫）；PRICE 與 T69 以前的舊草稿的事件條件是 null。
   */
  check: Record<string, unknown> | null;
  /** 這一條是程式比對得到的財報數字門檻（檢查過：指標程式算得出來、門檻有通過檢查的引用）。 */
  threshold: boolean;
}
/**
 * 草稿提的網域（own_draft_v1、v2 才有；T69 的 v3 拿掉，confirm_audit_design §2.3）：LISTED 已經在共用清單或這檔的來源裡／
 * NEW 新的來源／EXCLUDED 不列入的網站。只留給讀舊草稿用。
 */
export interface DraftDomain {
  domain: string;
  state: 'LISTED' | 'NEW' | 'EXCLUDED';
  note: string;
}
export interface DraftPeer {
  name: string;
  edgar?: string;
  yahoo?: string;
}
/** 檢查過的草稿（own_drafts.payload）。 */
export interface OwnDraft {
  thesis: string;
  premises: DraftPremise[];
  exits: DraftExit[];
  /** 加碼條件（T84，own_draft_v4；0～2 條，action 是 FILL 或 RAISE，kind 只有 XBRL、EVENT）。v3 以前的草稿沒有這個欄位。 */
  adds?: DraftExit[];
  /** domains：T69 以前的舊草稿才有（讀的地方當成可能沒有）；新的草稿只有 peers。 */
  sources: { peers: DraftPeer[]; domains?: DraftDomain[] };
  against: { text: string; evidence_ids: string[] }[];
  would_buy_today: { answer: (typeof ANSWERS)[number]; why: string };
  not_checkable: string[];
  /** 通過檢查的引用（T56 的「引用（可展開）」用），帶來源的標題。 */
  evidence: (Pick<CheckedEvidence, 'id' | 'source_id' | 'date' | 'quote' | 'claim'> & { title: string | null; url: string | null })[];
  /** 主筆的報告（第一段是摘要）。 */
  report: string | null;
}

// ---------------------------------------------------------------- 證據包

export interface OwnDraftInput {
  runId: string;
  asOf: string;
  ticker: string;
  trigger: 'AUTO' | 'MANUAL';
  /** 已經持有（題目的寫法）。 */
  held: boolean;
  premises: PackPremise[];
  facts: EvidencePack['facts'];
  docs: PackDoc[];
  dataQuality: EvidencePack['data_quality'];
  thesisVersion: number;
  fileId: string | null;
  broken: DraftBroken | null;
  /** 種子的網域（webEvidence.ts 的 sourceFacts；T68 起只是紀錄，不限制取得到什麼）。記在 rule.detail.webDomains。 */
  webDomains: string[];
  /**
   * XBRL 的季度數字（新的在前；T60）：記在 rule.detail.quarters，給程式檢查第 1 條比對「怎樣算不成立」是不是已經成立。
   * 和證據包的 XBRL 表是同一份數字；XBRL 抓不到是 null（那一條就不比）。
   */
  quarters?: QuarterRow[] | null;
  now: Date;
}

/** 季度數字只留程式檢查要的欄位。 */
const clauseRows = (rows: QuarterRow[]): ClauseQuarter[] => rows.map((r) => ({ end: r.end, revenue: r.revenue, grossMarginPct: r.grossMarginPct, operatingMarginPct: r.operatingMarginPct, netMarginPct: r.netMarginPct, revenueYoY: r.revenueYoY, epsDiluted: r.epsDiluted, cfoToNetIncome: r.cfoToNetIncome }));

export function ownDraftPack(inp: OwnDraftInput) {
  const who = inp.held ? `使用者持有自選股 ${inp.ticker}` : `使用者把 ${inp.ticker} 加進自選`;
  const brk = inp.broken;
  return buildPack({
    runId: inp.runId,
    fn: OWN_DRAFT,
    promptVersion: OWN_DRAFT_PROMPT,
    asOf: inp.asOf,
    subject: { ticker: inp.ticker },
    question:
      (brk ? `${brk.notice}。草稿不能沿用前提 ${brk.premiseId}（keep_id 不能寫 ${brk.premiseId}），也不要換個說法把它寫回來。` : '') +
      `${who}。請替使用者草擬這檔的論點（payload.thesis）、${DRAFT_LIMITS.premisesMin}～${DRAFT_LIMITS.premisesMax} 條前提` +
      `（每條寫怎樣算證實、怎樣算不成立〔最多 ${DRAFT_LIMITS.breaksClauses} 句〕、用什麼來源驗證與多久有新的一份；查不到的配一個查得到的替代指標，配不出來的標成信念，至少 ${DRAFT_LIMITS.checkableMin} 條不是信念）、` +
      `${DRAFT_LIMITS.exitsMin}～${DRAFT_LIMITS.exitsMax} 條出場條件（至少一條是出清或減半的財報數字門檻），` +
      `以及 0～${DRAFT_LIMITS.addsMax} 條加碼條件（payload.adds：論點被證實、值得多買的事，成立時補到標準比重 FILL 或提高到標準的 125% RAISE；格式和出場條件相同，只收財報門檻與申報或網頁事件，不收價格條件；沒有把握就不寫）。` +
      '反方先寫：這家公司最可能讓持有者後悔的三件事（各附證據），以及「如果現在沒有持股，今天用這個價格會不會買」的反方答案；正方要回應反方的三件事。' +
      '每一條前提都要查得到哪些證據顯示它成立、哪些顯示它不成立。這是草稿：使用者看過反方、按「採用」才會整份生效（論點、前提、出場條件、同業一起存），出場條件採用後直接開始監測，所以要寫成程式或申報查得到的格式。不要評論該不該買或賣、不要寫股數或價位。',
    policy: { level: 'A2', verdicts: ['DONE', 'INSUFFICIENT'], abstain: 'INSUFFICIENT', min_evidence: 0, samples: 1 },
    rule: {
      action: '只說明（草稿：使用者按「採用」才整份生效）',
      detail: {
        trigger: inp.trigger,
        thesisVersion: inp.thesisVersion,
        fileId: inp.fileId,
        broken: brk,
        ...(inp.webDomains.length ? { webDomains: inp.webDomains } : {}),
        ...(inp.quarters?.length ? { quarters: clauseRows(inp.quarters) } : {}),
      },
    },
    facts: inp.facts,
    premises: inp.premises,
    documents: inp.docs,
    dataQuality: inp.dataQuality,
    now: inp.now,
  });
}

// ---------------------------------------------------------------- 程式檢查

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const txt = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** 字元雙字組（比文字像不像用）。 */
function bigrams(s: string): Set<string> {
  const k = premiseKey(s);
  const out = new Set<string>();
  for (let i = 0; i + 1 < k.length; i++) out.add(k.slice(i, i + 2));
  return out;
}
/** 文字像的門檻：雙字組的重疊（交集 ÷ 比較短的那一邊）。 */
export const LIKE_THRESHOLD = 0.6;
/** 兩段文字很像嗎（§2.4 第 6 點「文字很像的標出來」）：去掉空白與標點後一樣，或雙字組重疊 ≥ 0.6。 */
export function likeText(a: string, b: string): boolean {
  if (premiseKey(a) === premiseKey(b)) return true;
  const x = bigrams(a);
  const y = bigrams(b);
  const small = Math.min(x.size, y.size);
  if (small < 3) return false;
  let common = 0;
  for (const g of x) if (y.has(g)) common++;
  return common / small >= LIKE_THRESHOLD;
}

const EDGAR_CODE = /^[A-Z][A-Z0-9.-]{0,9}$/;
const YAHOO_CODE = /^[A-Z0-9^][A-Z0-9.=^-]{0,19}$/;

/**
 * 事件出場條件的監測格式（T69，confirm_audit_design §2.2）：check 要有確認來源（confirm_by），用改寫送回時的同一個檢查（conditionFormatIssue）。
 * check.type 沒寫當成 event（prompt 照改寫的格式寫 { type: 'event', confirm_by }，少寫 type 不算錯）；寫了別的類型照樣不過。
 * 合格 → { check：整理好的格式（web:<網域> 寫成小寫） }；不合格 → { issue：原因 }。
 */
export function draftEventCheck(raw: unknown, metrics: ReadonlySet<string>): { check: Record<string, unknown>; issue: null } | { check: null; issue: string } {
  const c = isObj(raw) ? raw : {};
  const type = c.type === undefined || c.type === null ? 'event' : c.type;
  const issue = conditionFormatIssue('EVENT', { ...c, type }, metrics, type);
  if (issue) return { check: null, issue };
  const by = (c.confirm_by as unknown[]).map((x) => {
    const d = webRefDomain(x);
    return d ? `web:${d}` : String(x);
  });
  return { check: { type: 'event', confirm_by: [...new Set(by)] }, issue: null };
}

interface PackDetail {
  broken?: DraftBroken | null;
  webDomains?: string[];
  quarters?: ClauseQuarter[];
}

/**
 * 一票草稿的程式檢查（§2.2）。errors 有東西 = 不過（整份退回）；過了的回傳整理好的草稿。
 * 只認通過逐字檢查的引用；來源是 note（論點檔、上一份論點檔、買進時的一句話：使用者自己的話）的不算反方或門檻的依據。
 */
export function checkDraft(s: CheckedSample, pack: Pick<EvidencePack, 'documents' | 'premises' | 'rule'>, metrics: ReadonlySet<string>): { draft: OwnDraft | null; errors: string[] } {
  const errors: string[] = [];
  const p = s.payload ?? {};
  const detail = (pack.rule?.detail ?? {}) as PackDetail;
  const docs = new Map(pack.documents.map((d) => [d.source_id, d]));
  const okEv = s.evidence.filter((e) => e.ok);
  const okIds = new Set(okEv.map((e) => e.id));
  const goodIds = new Set(okEv.filter((e) => docs.get(e.source_id)?.kind !== 'note').map((e) => e.id));
  const L = DRAFT_LIMITS;

  // 論點
  const thesis = txt(p.thesis);
  if (!thesis) errors.push('沒有論點本文（thesis）');
  else if (thesis.length > L.thesis) errors.push(`論點超過 ${L.thesis} 字`);

  // 前提
  const brk = detail.broken ?? null;
  const current = new Map(pack.premises.filter((x) => x.origin !== 'SYSTEM_DEFAULT').map((x) => [x.id, x]));
  const rawPremises = Array.isArray(p.premises) ? p.premises : null;
  const premises: DraftPremise[] = [];
  if (!rawPremises) errors.push('premises 要是陣列');
  else if (rawPremises.length < L.premisesMin || rawPremises.length > L.premisesMax) errors.push(`前提要 ${L.premisesMin}～${L.premisesMax} 條（送回 ${rawPremises.length} 條）`);
  (rawPremises ?? []).slice(0, L.premisesMax + 1).forEach((raw, k) => {
    const n = `前提第 ${k + 1} 條`;
    if (!isObj(raw)) return void errors.push(`${n}格式不對`);
    const text = txt(raw.text);
    const keep = raw.keep_id === null || raw.keep_id === undefined || raw.keep_id === '' ? null : txt(raw.keep_id).toUpperCase();
    if (!text) errors.push(`${n}沒有文字`);
    else if (text.length > L.premise) errors.push(`${n}超過 ${L.premise} 字`);
    // 本文不放會過時的數字（§2.2 第 2 條；程式只擋這類字樣）
    const dated = DATED_WORDS.exec(text);
    if (dated) errors.push(`${n}的本文有會過時的字「${dated[0]}」：前提寫會一直成立的事，現在的數字寫進 confirms_if 或 breaks_if`);
    // 怎麼驗證（T60）：by 五選一；source、every 可以不寫（every 用 100 天）
    const v = isObj(raw.verify) ? raw.verify : null;
    const by = txt(v?.by).toUpperCase();
    const byOk = (CHECKABLE_BY as readonly string[]).includes(by);
    if (!byOk) errors.push(`${n}的 verify.by 要是 ${CHECKABLE_BY.join('、')} 其中之一`);
    const source = txt(v?.source);
    if (source.length > L.hint) errors.push(`${n}的 verify.source 超過 ${L.hint} 字`);
    const ev0 = v?.every;
    const every = ev0 === undefined || ev0 === null || ev0 === '' ? null : Number(ev0);
    if (every !== null && !(Number.isInteger(every) && every >= L.everyMin && every <= L.everyMax)) errors.push(`${n}的 verify.every 要是 ${L.everyMin}～${L.everyMax} 的整數（天）`);
    const belief = by === 'NONE';
    // 怎樣算證實（§2.2 第 3 條）：查得到的前提必填，信念可以不寫
    const confirms = txt(raw.confirms_if);
    if (!confirms && byOk && !belief) errors.push(`${n}查得到（verify.by 不是 NONE），要寫怎樣算證實（confirms_if）`);
    else if (confirms.length > L.confirmsIf) errors.push(`${n}的 confirms_if 超過 ${L.confirmsIf} 字`);
    // 怎樣算不成立：1～3 句（舊的一段字當成一句）
    const rb = raw.breaks_if;
    const breaks = typeof rb === 'string' ? (rb.trim() ? [rb.trim()] : []) : Array.isArray(rb) ? rb.map((x) => (typeof x === 'string' ? x.trim() : '')) : [];
    if (!breaks.length) errors.push(`${n}沒有寫怎樣算不成立（breaks_if）`);
    else if (breaks.length > L.breaksClauses) errors.push(`${n}的 breaks_if 最多 ${L.breaksClauses} 句（送回 ${breaks.length} 句）：一句寫一件事，挑最關鍵的`);
    else if (breaks.some((b) => !b)) errors.push(`${n}的 breaks_if 有空的一句`);
    breaks.forEach((b, j) => {
      if (b.length > L.breaksIf) return void errors.push(`${n}的 breaks_if 第 ${j + 1} 句超過 ${L.breaksIf} 字`);
      // 已經成立的子句（§2.2 第 1 條）：只比公司自己的財報數字查得到的（XBRL、FILING）；同業、網頁、信念不比
      if (by !== 'XBRL' && by !== 'FILING') return;
      const met = clauseMetNow(b, detail.quarters);
      if (met?.met) errors.push(`${n}的 breaks_if 第 ${j + 1} 句「${b}」用證據包的財報表看已經成立（${met.end} 那一季），前提一開始就不成立：寫成從現在起看得出來的事（例如「下一季…」「之後任一季…」），或換一個還沒碰到的門檻`);
    });
    if (keep !== null) {
      if (brk && keep === brk.premiseId) errors.push(`${n}沿用了剛被判不成立的前提 ${brk.premiseId}（keep_id 不能是它）`);
      else {
        const cur = current.get(keep);
        if (!cur) errors.push(`${n}的 keep_id ${keep} 不是現行的前提`);
        else if (premiseKey(cur.text) !== premiseKey(text)) errors.push(`${n}沿用了 ${keep}，但字改了（沒改字才能寫 keep_id）`);
      }
    }
    premises.push({
      text,
      keep_id: keep,
      confirms_if: confirms || null,
      breaks_if: breaks.filter(Boolean),
      verify: { by: by as CheckableBy, source: belief ? null : source || null, every: belief || every === null || !Number.isInteger(every) ? null : every },
      evidence_ids: ids(raw.evidence_ids).filter((id) => okIds.has(id)),
      ...(brk && text && likeText(text, brk.text) ? { like_broken: true } : {}),
    });
  });
  // 信念不限條數，但至少要有 2 條不是信念的前提（composite §2.3；取代「NONE 最多 1 條」）
  const checkable = premises.filter((x) => x.verify.by !== 'NONE').length;
  if (rawPremises && rawPremises.length >= L.premisesMin && checkable < L.checkableMin) errors.push(`至少要 ${L.checkableMin} 條不是信念的前提（verify.by 不是 NONE；送回 ${checkable} 條）：查不到的先配一個之後會出現在申報裡的替代指標，配不出來的才標成信念`);

  // 出場條件
  const rawExits = Array.isArray(p.exits) ? p.exits : null;
  const exits: DraftExit[] = [];
  if (!rawExits) errors.push('exits 要是陣列');
  else if (rawExits.length < L.exitsMin || rawExits.length > L.exitsMax) errors.push(`出場條件要 ${L.exitsMin}～${L.exitsMax} 條（送回 ${rawExits.length} 條）`);
  (rawExits ?? []).slice(0, L.exitsMax + 1).forEach((raw, k) => {
    const n = `出場條件第 ${k + 1} 條`;
    if (!isObj(raw)) return void errors.push(`${n}格式不對`);
    const text = txt(raw.text);
    const action = txt(raw.action).toUpperCase() as CondAction;
    if (!text) errors.push(`${n}沒有文字`);
    else if (text.length > L.exit) errors.push(`${n}超過 ${L.exit} 字`);
    if (!ACTIONS.includes(action)) errors.push(`${n}的 action 要是 EXIT、HALF 或 REVIEW`);
    const pi = raw.premise_index;
    const premiseIndex = typeof pi === 'number' && Number.isInteger(pi) && pi >= 0 && pi < premises.length ? pi : null;
    if (pi !== undefined && pi !== null && premiseIndex === null) errors.push(`${n}的 premise_index 對不到任何一條前提`);
    const kind = ['XBRL', 'EVENT', 'PRICE'].includes(txt(raw.kind).toUpperCase()) ? (txt(raw.kind).toUpperCase() as DraftExit['kind']) : null;
    const check = isObj(raw.check) ? raw.check : null;
    const ev = ids(raw.evidence_ids).filter((id) => okIds.has(id));
    // 事件條件（T69）：確認來源的格式和改寫送回的條件一樣（同一個檢查函式）；不合格整份退回
    const event = kind === 'EVENT' ? draftEventCheck(raw.check, metrics) : null;
    if (event?.issue) errors.push(`${n}（事件條件）：${event.issue}；check 要寫 { "type": "event", "confirm_by": [...] }，確認來源用 8-K、10-Q、10-K、SEC、earnings_call、major_news 或 web:<網域>（不能是排除列表的網站）`);
    // 財報數字門檻：指標程式算得出來、門檻是數字、季數合理、門檻有通過檢查的引用（check.ts 對數字門檻的同一條規則）
    const threshold =
      kind === 'XBRL' &&
      !!check &&
      XBRL_TYPES.includes(String(check.type)) &&
      metrics.has(String(check.metric)) &&
      typeof check.level === 'number' &&
      Number.isFinite(check.level) &&
      (check.quarters === undefined || (Number.isInteger(check.quarters) && Number(check.quarters) >= 1 && Number(check.quarters) <= 8)) &&
      ev.some((id) => goodIds.has(id));
    exits.push({ text, action, premise_index: premiseIndex, evidence_ids: ev, kind, check: kind === 'XBRL' && check ? check : (event?.check ?? null), threshold });
  });
  if (!exits.some((x) => (x.action === 'EXIT' || x.action === 'HALF') && x.threshold)) errors.push('至少要一條動作是出清或減半、而且是財報數字門檻的出場條件（kind XBRL、指標程式算得出來、門檻有通過檢查的引用）');

  // 加碼條件（T84，allocation_redesign §4.2）：0～2 條、動作是 FILL 或 RAISE、格式和出場條件相同；不收價格條件（整份退回，和其他檢查一樣）
  const rawAdds = p.adds === undefined || p.adds === null ? [] : p.adds;
  const adds: DraftExit[] = [];
  if (!Array.isArray(rawAdds)) errors.push('adds 要是陣列');
  else if (rawAdds.length > L.addsMax) errors.push(`加碼條件最多 ${L.addsMax} 條（送回 ${rawAdds.length} 條）`);
  (Array.isArray(rawAdds) ? rawAdds : []).slice(0, L.addsMax + 1).forEach((raw, k) => {
    const n = `加碼條件第 ${k + 1} 條`;
    if (!isObj(raw)) return void errors.push(`${n}格式不對`);
    const text = txt(raw.text);
    const action = txt(raw.action).toUpperCase() as CondAction;
    if (!text) errors.push(`${n}沒有文字`);
    else if (text.length > L.exit) errors.push(`${n}超過 ${L.exit} 字`);
    if (!ADD_ACTIONS.includes(action)) errors.push(`${n}的 action 要是 FILL（補到標準比重）或 RAISE（提高到標準的 125%）`);
    const pi = raw.premise_index;
    const premiseIndex = typeof pi === 'number' && Number.isInteger(pi) && pi >= 0 && pi < premises.length ? pi : null;
    if (pi !== undefined && pi !== null && premiseIndex === null) errors.push(`${n}的 premise_index 對不到任何一條前提`);
    const kindRaw = txt(raw.kind).toUpperCase();
    const ev = ids(raw.evidence_ids).filter((id) => okIds.has(id));
    if (kindRaw === 'PRICE') return void errors.push(`${n}：${ADD_PRICE}`);
    if (kindRaw !== 'XBRL' && kindRaw !== 'EVENT') return void errors.push(`${n}的 kind 要是 XBRL 或 EVENT`);
    const check = isObj(raw.check) ? raw.check : null;
    if (kindRaw === 'EVENT') {
      const event = draftEventCheck(raw.check, metrics);
      if (event.issue) return void errors.push(`${n}（事件條件）：${event.issue}`);
      return void adds.push({ text, action, premise_index: premiseIndex, evidence_ids: ev, kind: 'EVENT', check: event.check, threshold: false });
    }
    const threshold = !!check && XBRL_TYPES.includes(String(check.type)) && metrics.has(String(check.metric)) && typeof check.level === 'number' && Number.isFinite(check.level) && (check.quarters === undefined || (Number.isInteger(check.quarters) && Number(check.quarters) >= 1 && Number(check.quarters) <= 8));
    if (!threshold) return void errors.push(`${n}（財報條件）：check 要寫 { "type": "xbrl_metric_above" 或 "xbrl_metric_below", "metric", "level", "quarters" }，指標要是程式算得出來的`);
    adds.push({ text, action, premise_index: premiseIndex, evidence_ids: ev, kind: 'XBRL', check, threshold: ev.some((id) => goodIds.has(id)) });
  });

  // 反方
  const rawAgainst = Array.isArray(p.against) ? p.against : null;
  const against: OwnDraft['against'] = [];
  if (!rawAgainst || rawAgainst.length !== L.against) errors.push(`反方要 ${L.against} 點（送回 ${rawAgainst?.length ?? 0} 點）`);
  (rawAgainst ?? []).slice(0, L.against).forEach((raw, k) => {
    const n = `反方第 ${k + 1} 點`;
    const text = isObj(raw) ? txt(raw.text) : '';
    const ev = isObj(raw) ? ids(raw.evidence_ids) : [];
    if (!text) return void errors.push(`${n}沒有文字`);
    if (text.length > L.line) errors.push(`${n}超過 ${L.line} 字`);
    const good = ev.filter((id) => goodIds.has(id));
    if (!good.length) errors.push(`${n}沒有通過檢查的引用（論點檔與使用者自己寫的不算）`);
    against.push({ text, evidence_ids: good });
  });

  // 今天會不會買
  const wb = isObj(p.would_buy_today) ? p.would_buy_today : null;
  const answer = txt(wb?.answer).toUpperCase();
  const why = txt(wb?.why);
  if (!wb || !(ANSWERS as readonly string[]).includes(answer) || !why) errors.push('would_buy_today 要有 answer（YES、NO、UNSURE）與 why');
  else if (why.length > L.line) errors.push(`would_buy_today.why 超過 ${L.line} 字`);

  // 監測不了的觀察（只顯示）
  const nc = p.not_checkable === undefined || p.not_checkable === null ? [] : p.not_checkable;
  const notCheckable: string[] = [];
  if (!Array.isArray(nc) || nc.some((x) => typeof x !== 'string')) errors.push('not_checkable 要是字串陣列');
  else if (nc.length > L.notCheckable) errors.push(`not_checkable 最多 ${L.notCheckable} 項`);
  else
    for (const x of nc as string[]) {
      if (x.trim().length > L.line) errors.push(`not_checkable 有一項超過 ${L.line} 字`);
      else if (x.trim()) notCheckable.push(x.trim());
    }

  // 來源：只看同業（T69：sources.domains 拿掉，送回了也不看、不存）
  const src = isObj(p.sources) ? p.sources : {};
  const rawPeers = src.peers === undefined ? [] : src.peers;
  const peers: DraftPeer[] = [];
  if (!Array.isArray(rawPeers) || rawPeers.length > L.peers) errors.push(`sources.peers 要是陣列、最多 ${L.peers} 家`);
  else
    for (const raw of rawPeers) {
      const name = isObj(raw) ? txt(raw.name).slice(0, 60) : '';
      const edgar = isObj(raw) ? txt(raw.edgar).toUpperCase() : '';
      const yahoo = isObj(raw) ? txt(raw.yahoo).toUpperCase() : '';
      if (!name || (!edgar && !yahoo) || (edgar && !EDGAR_CODE.test(edgar)) || (yahoo && !YAHOO_CODE.test(yahoo))) {
        errors.push(`同業「${name || edgar || yahoo || '（空的）'}」要有名稱，與格式正確的 EDGAR 或 Yahoo 代號`);
        continue;
      }
      peers.push({ name, ...(edgar ? { edgar } : {}), ...(yahoo ? { yahoo } : {}) });
    }

  if (errors.length) return { draft: null, errors };
  return {
    errors,
    draft: {
      thesis,
      premises,
      exits,
      ...(adds.length ? { adds } : {}),
      sources: { peers },
      against,
      would_buy_today: { answer: answer as OwnDraft['would_buy_today']['answer'], why },
      not_checkable: notCheckable,
      evidence: okEv.map((e) => ({ id: e.id, source_id: e.source_id, date: e.date, quote: e.quote, claim: e.claim, title: docs.get(e.source_id)?.title ?? null, url: docs.get(e.source_id)?.url ?? null })),
      report: s.report,
    },
  };
}

/** 草稿檢查沒過時寫進 issues 的前綴（draftResult 用它分辨「程式檢查沒過」與「研究員說證據不足」）。 */
export const DRAFT_ISSUE = '草稿檢查：';

/** OWN_DRAFT 的 payload 檢查（PayloadHook）：寫了草稿（DONE）而檢查不過 → 這一票改成 INSUFFICIENT、原因寫進 issues（整份退回）。 */
export function checkDraftPayload(s: CheckedSample, pack: EvidencePack, metrics: ReadonlySet<string>): void {
  if (s.verdict !== 'DONE') return;
  const r = checkDraft(s, pack, metrics);
  if (!r.errors.length) return;
  s.issues.push(...r.errors.map((e) => `${DRAFT_ISSUE}${e}`));
  s.verdict = pack.policy.abstain;
}

/**
 * 一次草擬的結果：ok = 草稿（給使用者看）；不 ok = 原因（白話，own_drafts.error）。還沒有結論是 null。
 * 只有一致（一份）寫好、檢查過的才算；逾時、沒觸發成、整份退回、格式不合格、研究員說證據不夠、程式檢查沒過都是失敗。
 */
export function draftResult(outcome: Outcome | null, pack: Pick<EvidencePack, 'documents' | 'premises' | 'rule'>, metrics: ReadonlySet<string>): { ok: true; draft: OwnDraft } | { ok: false; why: string } | null {
  if (!outcome) return null;
  const s = outcome.samples.find((x) => x.valid) ?? outcome.samples[0];
  if (outcome.status === 'AGREED' && outcome.verdict === 'DONE' && s) {
    const r = checkDraft(s, pack, metrics);
    if (r.draft) return { ok: true, draft: r.draft };
    return { ok: false, why: `程式檢查沒過：${r.errors.join('；')}` };
  }
  const bad = s?.issues.filter((x) => x.startsWith(DRAFT_ISSUE)).map((x) => x.slice(DRAFT_ISSUE.length)) ?? [];
  if (bad.length) return { ok: false, why: `程式檢查沒過：${bad.join('；')}` };
  if (outcome.status === 'INVALID') return { ok: false, why: `送回的格式不合格${s?.issues.length ? `（${s.issues.slice(0, 3).join('；')}）` : ''}` };
  if (outcome.status === 'INSUFFICIENT') return { ok: false, why: `研究員認為證據不夠寫草稿${s?.abstainReason ? `：${s.abstainReason}` : ''}` };
  return { ok: false, why: outcome.reason.replace(/，照規則。$/, '') };
}
