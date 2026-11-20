// T10：F24 自選定期審查、F25 自選條件監測（ai_layer_design 的 F24、F25、F23 卡片）。
// 純函式：證據包、payload 的逐欄檢查、結論怎麼變成引擎的輸入。資料抓取與排程在 src/app/ownAi.ts。
import { TIER_NAME, type Account, type MarketView, type ReviewTrigger, type Tier } from '../engine';
import { hostMatches, sameWebDomain, webLabel } from '../data/webSources';
import { webMetaOf, type WebMeta } from './added';
import { keptByChoice, type CheckedSample, type EvidencePack, type Outcome, type PackDoc } from './check';
import { buildPack, ownPremises, ownRuleFacts, priceDoc, priceFacts } from './pack';

export const OWN_REVIEW = 'OWN_REVIEW';
export const OWN_CONDITION = 'OWN_CONDITION';
export const OWN_REVIEW_PROMPT = 'own_review_v3';
/** F24 獨立跑幾次。 */
export const OWN_REVIEW_SAMPLES = 3;
export const OWN_CONDITION_PROMPT = 'own_condition_v1';

/** F23：AI 可以選「提高到標準的 125%」的規則條件。 */
export const RAISE_RULE = { aboveDays: 126, gapDays: 365 } as const;

/** F23 的規則條件：收盤連續站上 200 日均線 ≥ 6 個月、不在減半、沒有硬事件標記、距上次提高 ≥ 12 個月。 */
export function raiseAllowed(acct: Account, ticker: string, asOf: string): { ok: boolean; why: string } {
  const meta = acct.own[ticker];
  const st = acct.rule.own[ticker];
  if (!meta || !st) return { ok: false, why: '不是自選股' };
  if (st.applied !== 'STD') return { ok: false, why: '減半中' };
  if (meta.flags.length) return { ok: false, why: `有硬事件標記（${meta.flags.join('、')}）` };
  if (meta.slow.aboveRun < RAISE_RULE.aboveDays) return { ok: false, why: `連續站上 200 日均線 ${meta.slow.aboveRun} 個交易日（要 ${RAISE_RULE.aboveDays}）` };
  if (meta.raisedAt && (Date.parse(asOf) - Date.parse(meta.raisedAt)) / 86400_000 < RAISE_RULE.gapDays) return { ok: false, why: `上次提高是 ${meta.raisedAt}，未滿 12 個月` };
  return { ok: true, why: '規則條件成立' };
}

/** 自選股的條件（own_conditions；T26 起審查不再整組替換，AI 只能建議，使用者勾選才監測）。 */
export interface OwnCondition {
  ticker: string;
  runId: string;
  condId: string;
  direction: 'UP' | 'DOWN';
  kind: 'XBRL' | 'EVENT' | 'PRICE';
  text: string;
  check: Record<string, unknown>;
  tierIfMet: Tier | null;
  /**
   * own_thesis §1.5 的狀態：PROPOSED 建議中（觀察項，不會自己發通知）、ACTIVE 監測中、REVIEW_ONLY 只在定期審查時檢查（確認來源只有法說會或新聞）、
   * MANUAL 只記錄（價格條件、沒通過檢查的）、MET 已成立、RETIRED 你撤下或被取代、EXPIRED 建議中的過期了、REPLACED 舊資料（改版前被整組替換的）。
   */
  status: 'PROPOSED' | 'ACTIVE' | 'MET' | 'REPLACED' | 'MANUAL' | 'REVIEW_ONLY' | 'RETIRED' | 'EXPIRED';
  createdAt: string;
  metAt: string | null;
  note: string | null;
}

export interface OwnReviewInput {
  acct: Account;
  view: MarketView;
  axis: string[];
  ticker: string;
  runId: string;
  trigger: ReviewTrigger;
  /** XBRL 季度表（quarterTableText 的輸出）。 */
  xbrl: PackDoc | null;
  filings: PackDoc[];
  news: PackDoc | null;
  /**
   * 論點檔的條件：你定的 C、觀察項 W（thesis.ts 的 condFacts）；map 是證據包編號 → 條件的列編號，記在 rule.detail.conds。
   * web（T53）：指名了網頁來源的條件（confirm_by 有 `web:<網域>`）→ 那幾個網域，記在 rule.detail.condWeb。
   */
  conds?: { facts: EvidencePack['facts']; map: Record<string, number>; web?: Record<string, string[]> };
  /** 可以當證據的網頁來源（共用清單＋這檔的一手網域；webEvidence.ts 的 sourceFacts）：建議的條件指名來源時只能指名這些。記在 rule.detail.webDomains。 */
  webDomains?: string[];
  dataQuality: EvidencePack['data_quality'];
  /** 由論點檔組的數字（T0、事件 V、預設前提的 D1～D3；own_thesis §1.6），接在原本的數字後面。 */
  extraFacts?: EvidencePack['facts'];
  /** 由論點檔組的原文（論點那一份 note），放在最後。 */
  extraDocs?: PackDoc[];
  /** 月底檢查點開的審查：新證據的原因清單（own_thesis §3.7），記在 rule.detail.reasons。 */
  reasons?: string[];
  /** 提前審查（own_thesis §2.4）：題目加一句原因；觸發的事件編號（sec_events.id）記在 rule.detail.events。 */
  early?: { reason: string; events: number[] };
  now: Date;
}

const STATE_TIER: Record<string, Tier> = { STD: 'STANDARD', HALF: 'HALF' };

/** F24 的證據包。 */
export function ownReviewPack(inp: OwnReviewInput) {
  const { acct, view, ticker } = inp;
  const raise = raiseAllowed(acct, ticker, view.date);
  const state = acct.rule.own[ticker]?.applied ?? 'STD';
  const verdicts: Tier[] = ['EXIT', 'HALF', 'HOLD', 'STANDARD', ...(raise.ok ? (['RAISE'] as Tier[]) : [])];
  const docs = [priceDoc(view, inp.axis, ticker, 60), inp.xbrl, ...inp.filings, inp.news, ...(inp.extraDocs ?? [])].filter((d): d is PackDoc => !!d);
  const conds = inp.conds ?? { facts: [], map: {} };
  const condWeb = conds.web && Object.keys(conds.web).length ? { condWeb: conds.web } : {};
  const webDomains = inp.webDomains?.length ? { webDomains: inp.webDomains } : {};
  const hasC = conds.facts.some((f) => f.id.startsWith('C'));
  const hasW = conds.facts.some((f) => f.id.startsWith('W'));
  return buildPack({
    runId: inp.runId,
    fn: OWN_REVIEW,
    promptVersion: OWN_REVIEW_PROMPT,
    asOf: view.date,
    subject: { ticker },
    question:
      (inp.early ? `這次是提前審查，原因：${inp.early.reason}。` : '') +
      `${ticker} 是自選股，目前慢規則狀態「${state === 'HALF' ? '減半中' : '標準'}」（等於檔位 ${STATE_TIER[state]}）。` +
      '請逐條檢查使用者的前提：哪些證據顯示它成立？哪些證據顯示它不成立？把「論點壞了」和「價格跌了」分開。' +
      '假設三個月後回頭看，這次維持現狀是錯的，最可能的原因是什麼、今天有什麼證據？' +
      `最後選一個檔位：${verdicts.map((v) => `${v}（${TIER_NAME[v]}）`).join('、')}；證據不足以改變就選 HOLD。` +
      (raise.ok ? '只有前提全部成立時才可以選 RAISE。' : `這個月不能選 RAISE（${raise.why}）。`) +
      (hasC || hasW ? `並逐條檢查${hasC ? '使用者定的條件（facts 的 C 開頭）' : ''}${hasC && hasW ? '與' : ''}${hasW ? '觀察項（facts 的 W 開頭）' : ''}是否已經成立（payload.condition_checks）。` : '') +
      '最後可以建議最多 3 條新增的條件（payload.proposed_conditions）：現有的條件已經涵蓋的事不要再提，還適用的觀察項原樣再提（算在 3 條內）；使用者勾選才會監測。',
    policy: { level: 'A3', verdicts, abstain: 'HOLD', min_evidence: 1, samples: OWN_REVIEW_SAMPLES },
    rule: { action: `規則這次沒有動作；慢規則狀態：${state === 'HALF' ? '減半中' : '標準'}`, detail: { trigger: inp.trigger, state, raise: raise.why, conds: conds.map, ...condWeb, ...webDomains, thesisVersion: acct.own[ticker]?.thesis?.version ?? 0, ...(inp.reasons ? { reasons: inp.reasons } : {}), ...(inp.early ? { events: inp.early.events } : {}) } },
    facts: [...priceFacts(view, ticker), ...ownRuleFacts(acct, view, ticker), ...conds.facts, ...(inp.extraFacts ?? [])],
    premises: ownPremises(acct, ticker),
    documents: docs,
    dataQuality: inp.dataQuality,
    now: inp.now,
  });
}

const CONFIRM_BY = ['8-K', '10-Q', '10-K', 'SEC', 'earnings_call', 'major_news'];
const FILING_SOURCES = ['8-K', '10-Q', '10-K', 'SEC'];

/** 事件條件指名網頁來源的寫法（web_evidence_design §1.6）：`web:<網域>`，例如 `web:trendforce.com`。 */
const WEB_REF = /^web:((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,})$/i;
/** `web:trendforce.com` → `trendforce.com`；不是這種寫法 → null。 */
export const webRefDomain = (x: unknown): string | null => {
  const m = typeof x === 'string' ? WEB_REF.exec(x.trim()) : null;
  return m ? m[1].toLowerCase() : null;
};
/** 條件指名的網頁來源（confirm_by 裡的 `web:<網域>`；沒有就是空的）。 */
export function namedWebDomains(check: Record<string, unknown>): string[] {
  const by = Array.isArray(check.confirm_by) ? check.confirm_by : [];
  return [...new Set(by.map(webRefDomain).filter((d): d is string => !!d))];
}

/**
 * 指名了網頁來源的事件條件怎麼檢查（web_evidence_design §1.6；G24：寫的就是實際在做的事）：`審查時用 TrendForce 的網頁檢查`。
 * 沒有指名 → null。
 */
export function webConfirmText(check: Record<string, unknown>): string | null {
  const named = namedWebDomains(check);
  return named.length ? `審查時用 ${named.map((d) => webLabel(d)).join('、')} 的網頁檢查` : null;
}

/**
 * 條件怎麼確認（own_thesis §1.5「怎麼確認」，由條件本身推出來，不另存）：
 *   XBRL        財報條件，新 10-Q／10-K 出來時程式比對
 *   FILING      事件條件，確認來源裡有申報類型 → 新申報出現時 F25 三票讀原文（另外指名了網頁來源的，審查時也用那個來源檢查）
 *   REVIEW_ONLY 事件條件，確認來源只有 earnings_call、major_news、`web:<網域>` → 沒有申報可讀，只在定期審查時由三票判斷（P4）；
 *               指名了網頁來源的（T53，web_evidence_design §1.6）審查時用那個來源的網頁檢查，不每天監測
 *   NONE        價格條件、或沒通過格式檢查的（含事件條件沒寫確認來源）→ 只記錄
 */
export type ConfirmMode = 'XBRL' | 'FILING' | 'REVIEW_ONLY' | 'NONE';
export function confirmMode(c: { kind: string; check: Record<string, unknown>; manual?: boolean }): ConfirmMode {
  if (c.manual) return 'NONE';
  if (c.kind === 'XBRL') return 'XBRL';
  if (c.kind !== 'EVENT') return 'NONE';
  const by = Array.isArray(c.check.confirm_by) ? c.check.confirm_by.map(String) : [];
  if (!by.length) return 'NONE';
  if (by.some((x) => FILING_SOURCES.includes(x))) return 'FILING';
  return by.every((x) => x === 'earnings_call' || x === 'major_news' || webRefDomain(x) !== null) ? 'REVIEW_ONLY' : 'NONE';
}

/** 證據包記下的「可以指名的網頁來源」（rule.detail.webDomains）；沒有（舊的證據包、只有預設前提的股票）就是空的。 */
const packWebDomains = (pack: Pick<EvidencePack, 'rule'>): string[] => {
  const d = (pack.rule?.detail as { webDomains?: unknown } | undefined)?.webDomains;
  return Array.isArray(d) ? d.filter((x): x is string => typeof x === 'string') : [];
};

/** 事件條件的確認來源哪裡不合格（null = 合格）：固定的幾種，或指名清單內的網頁來源（清單外的擋下）。 */
function confirmByIssue(by: unknown, allowed: readonly string[]): string | null {
  if (!Array.isArray(by) || !by.length) return '事件條件要寫確認來源（confirm_by）';
  for (const x of by) {
    if (CONFIRM_BY.includes(String(x))) continue;
    const d = webRefDomain(x);
    if (!d) return '事件條件要寫確認來源（confirm_by）';
    if (!allowed.some((a) => hostMatches(d, a))) return `指名的網頁來源 ${d} 不在清單或這檔的來源裡（清單外的網站不能當確認來源）`;
  }
  return null;
}

/**
 * F24 的 payload 逐欄檢查（ai_layer F24 卡片；own_review_v2）：tier 要和 verdict 一致；建議新增的條件（proposed_conditions）最多 3 條，
 * kind 只能是 XBRL（指標要是程式算得出來的）／EVENT（要寫確認來源）／PRICE（只記錄，不通知），tier_if_met 要是合法檔位。
 * 事件條件的確認來源可以指名清單內的網頁來源（`web:<網域>`，T53；清單是證據包的 rule.detail.webDomains），清單外的改標人工。
 * 不合格的條件改標人工，不整票作廢。F14 健檢（payload.conditions，最多 5 條）共用同一套條件檢查。
 */
export function checkOwnReviewPayload(s: CheckedSample, pack: EvidencePack, metrics: ReadonlySet<string>): void {
  const p = s.payload ?? {};
  if (p.tier !== undefined && p.tier !== s.rawVerdict) s.issues.push(`payload.tier（${String(p.tier)}）和 verdict 不同`);
  if (Array.isArray(p.conditions) && p.conditions.length > 5) s.issues.push('條件超過 5 條，只看前 5 條');
  if (Array.isArray(p.proposed_conditions) && p.proposed_conditions.length > 3) s.issues.push('建議的條件超過 3 條，只看前 3 條');
  const allowed = packWebDomains(pack);
  for (const c of s.conditions) {
    if ((c.from !== 'payload.conditions' && c.from !== 'payload.proposed_conditions') || !c.auto) continue;
    const raw = c.raw;
    const check = (raw.check ?? {}) as Record<string, unknown>;
    const why =
      raw.direction !== 'UP' && raw.direction !== 'DOWN'
        ? 'direction 要是 UP 或 DOWN'
        : raw.kind === 'XBRL'
          ? !String(c.type).startsWith('xbrl_') || !metrics.has(String(check.metric))
            ? `財報條件的指標 ${String(check.metric)} 程式算不出來`
            : null
          : raw.kind === 'EVENT'
            ? c.type !== 'event'
              ? '事件條件要寫確認來源（confirm_by）'
              : confirmByIssue(check.confirm_by, allowed)
            : raw.kind === 'PRICE'
              ? '價格條件只記錄、不通知（B-1：價格面交給慢規則）'
              : 'kind 要是 XBRL、EVENT 或 PRICE';
    const tierOk = raw.tier_if_met === undefined || pack.policy.verdicts.includes(String(raw.tier_if_met)) || raw.tier_if_met === 'RAISE';
    if (why || !tierOk) {
      c.auto = false;
      c.why = why ?? `tier_if_met（${String(raw.tier_if_met)}）不是合法的檔位`;
    }
  }
  const cc = p.condition_checks;
  if (cc !== undefined && !Array.isArray(cc)) s.issues.push('payload.condition_checks 要是陣列');
}

export type ConditionDraft = Omit<OwnCondition, 'status' | 'createdAt' | 'metAt' | 'note'> & { manual: boolean };
/** 審查建議新增的條件（own_thesis §1.6 的 proposed_conditions）：premiseId、supersedes（證據包的編號，例如 C2、W1）可以是空的。 */
export type ProposedDraft = ConditionDraft & { premiseId: string | null; supersedes: string | null };

export interface ReviewDecision {
  /** 寫進引擎的檔位；null = 這次不更新（不一致、不合格、逾時）。 */
  tier: Tier | null;
  /** 月報並列 AI 建議（3 票一致、和目前不同、有一條「不成立的前提」）。 */
  suggest: boolean;
  why: string;
  /** 三票一致（含一致選「不動」）：只有這時才動條件（寫建議、審查確認成立）。證據不足、資料缺漏、票數不一致都不動（修 N4、P5）。 */
  consensus: boolean;
  /** 建議新增的條件（最多 3 條，取自和結論同檔位的第一張合格票）；consensus 是 false 時是空的。 */
  proposed: ProposedDraft[];
  /** 三票的 condition_checks 都寫 MET、各有合格引用的條件（證據包的編號 C…、W…；合格的來源見 condCite）；consensus 是 false 時是空的。 */
  metChecks: string[];
  /**
   * metChecks 裡每一條是靠什麼確認的（T53）：REVIEW_VOTE = 三票都有申報或財報表的引用（照舊）；
   * WEB_VOTE = 至少一票靠的是條件指名的那個網頁來源（web_evidence_design §1.6）。
   */
  metBasis: Record<string, 'REVIEW_VOTE' | 'WEB_VOTE'>;
  /** 不成立的前提（§1.6 第 1 點：三票都判 BROKEN、每一票都有合格的引用；取交集），編號由小到大。合格的來源見 premiseCite。 */
  brokenPremises: string[];
  /** 主要的不成立前提（編號最小的那條）；沒有是 null。寫進 aiTier.premiseId。 */
  premiseId: string | null;
}

const pnum = (id: string) => Number(/\d+/.exec(id)?.[0] ?? Infinity);

/** `MEDIA` 級的網頁要判前提不成立，每一票至少要引用幾個不同網域的文件（web_evidence_design §1.6、第 6 章第 5 項）。 */
export const MEDIA_MIN_DOMAINS = 2;

/** 證據包的文件照來源分：hard = 申報原文或財報表（自己的與同業的）；web = 程式抓、存了快照的清單內網頁（帶級別與網域）。其他（新聞標題、價格、論點 note）都不算。 */
export interface PackSources {
  hard: Set<string>;
  web: Map<string, WebMeta>;
}
export function packSources(pack: Pick<EvidencePack, 'documents'>): PackSources {
  const hard = new Set<string>();
  const web = new Map<string, WebMeta>();
  for (const d of pack.documents) {
    if (d.kind === 'filing' || d.kind === 'xbrl') hard.add(d.source_id);
    const w = webMetaOf(d);
    if (w) web.set(d.source_id, w);
  }
  return { hard, web };
}

/** 這一票的某幾條證據裡，通過逐字檢查的引用各來自哪一份文件（source_id，照引用的順序）。 */
export function citedSources(s: CheckedSample, ids: unknown): string[] {
  if (!Array.isArray(ids)) return [];
  const ok = new Map(s.evidence.filter((e) => e.ok).map((e) => [e.id, e.source_id]));
  return ids.map((id) => ok.get(String(id))).filter((x): x is string => !!x);
}

/** HARD = 靠申報或財報表；WEB = 靠網頁；null = 不合格。 */
export type CiteBasis = 'HARD' | 'WEB' | null;

/**
 * 這一票判某條前提「不成立」的引用夠不夠（web_evidence_design §1.6 表的第二欄）：
 *   申報、財報表（自己或同業的）        → 可以（照舊）
 *   網頁，一手或指名的產業來源          → 可以
 *   網頁，媒體                          → 要引用 2 個不同網域的文件（單一媒體的一篇報導不夠）
 *   新聞標題、價格、論點 note、其他      → 不行
 * hardOnly：只認申報與財報表（往上加碼的判斷不放寬）。
 */
export function premiseCite(s: CheckedSample, ids: unknown, src: PackSources, hardOnly = false): CiteBasis {
  const from = citedSources(s, ids);
  if (from.some((id) => src.hard.has(id))) return 'HARD';
  if (hardOnly) return null;
  const webs = from.map((id) => src.web.get(id)).filter((w): w is WebMeta => !!w);
  if (webs.some((w) => w.tier === 'PRIMARY' || w.tier === 'NAMED')) return 'WEB';
  return new Set(webs.map((w) => w.domain)).size >= MEDIA_MIN_DOMAINS ? 'WEB' : null;
}

/**
 * 這一票確認某條條件「成立」的引用夠不夠（§1.6 表的第三欄）：
 *   申報、財報表                        → 可以（照舊）
 *   網頁                                → 只有條件指名了這個網域時可以（不論級別；沒指名的一手、指名的產業來源、媒體都不行）
 *   新聞標題與其他                      → 不行
 * named：條件指名的網域（namedWebDomains）。
 */
export function condCite(s: CheckedSample, ids: unknown, src: PackSources, named: readonly string[]): CiteBasis {
  const from = citedSources(s, ids);
  if (from.some((id) => src.hard.has(id))) return 'HARD';
  if (!named.length) return null;
  return from.some((id) => {
    const w = src.web.get(id);
    return !!w && named.some((n) => sameWebDomain(w.domain, n));
  })
    ? 'WEB'
    : null;
}

/**
 * 不成立的前提（own_thesis §1.6 第 1 點；減半檢視的「出清」也用同一個定義，§3.3）：每一票都判 BROKEN、而且每一票都有合格的引用
 * （premiseCite：申報或財報表；清單內的網頁照級別，T53）——取交集，編號由小到大。samples 是合格的票；不到 wanted 票就是空的。
 * opt.hardOnly：只認申報與財報表的引用。
 */
export function brokenPremises(samples: CheckedSample[], pack: Pick<EvidencePack, 'documents'>, wanted = OWN_REVIEW_SAMPLES, opt: { hardOnly?: boolean } = {}): string[] {
  if (samples.length < wanted) return [];
  const src = packSources(pack);
  const sets = samples.map((s) => new Set(s.premises.filter((p) => p.status === 'BROKEN' && premiseCite(s, p.evidence_ids, src, opt.hardOnly)).map((p) => p.premise_id)));
  return [...sets[0]].filter((id) => sets.every((x) => x.has(id))).sort((a, b) => pnum(a) - pnum(b));
}

/** 往上的檔位（回到標準、提高到 125%）不能只靠網頁（§1.6）：每一票判成立的每一條前提，引用裡至少要有一條來自申報或財報表。 */
function holdsHard(samples: CheckedSample[], src: PackSources): boolean {
  return samples.every((s) => s.premises.filter((p) => p.status === 'HOLDS').every((p) => premiseCite(s, p.evidence_ids, src, true) === 'HARD'));
}

/**
 * F24 的結論 → 引擎的輸入與條件的變動（own_thesis §1.5、§1.6「程式怎麼用結論」第 1、2、4 點；合格的引用來源照 web_evidence_design §1.6）。
 * suggest：3 票一致、和目前狀態不同、而且有一條「不成立的前提」（只有新聞標題或價格當引用的不算；修 N5）。
 * 往上的檔位不放寬：回到標準只認申報或財報引用的「不成立」；RAISE 另外要求前提全部成立（F23），而且每條成立的前提都有申報或財報的引用。
 * 其他情況只放網站。什麼時候當天通知（§1.9）由 routeReview 決定。
 * pack.rule.detail.condWeb：指名了網頁來源的條件（證據包編號 → 網域）。
 */
export function reviewDecision(outcome: Outcome, acct: Account, ticker: string, asOf: string, pack: Pick<EvidencePack, 'documents'> & { rule?: EvidencePack['rule'] }): ReviewDecision {
  const empty: ReviewDecision = { tier: null, suggest: false, why: outcome.reason, consensus: false, proposed: [], metChecks: [], metBasis: {}, brokenPremises: [], premiseId: null };
  if (outcome.status !== 'AGREED' && outcome.status !== 'INSUFFICIENT' && outcome.status !== 'DATA_MISSING') return empty;
  const tier = outcome.verdict as Tier;
  const samples = outcome.samples.filter((s) => s.valid);
  const full = samples.length >= OWN_REVIEW_SAMPLES;
  const consensus = full && (outcome.status === 'AGREED' || (outcome.status === 'INSUFFICIENT' && keptByChoice('HOLD', outcome.samples, OWN_REVIEW_SAMPLES)));
  const src = packSources(pack);

  // §1.6 第 1 點：不成立的前提取交集
  const broken = brokenPremises(samples, pack);
  const premiseId = broken[0] ?? null;

  // §1.6 第 2 點：三票都寫 MET、各有合格的引用（申報或財報；條件指名了網頁來源時，那個來源的網頁也算）
  const condWeb = ((pack.rule?.detail as { condWeb?: Record<string, unknown> } | undefined)?.condWeb ?? {}) as Record<string, unknown>;
  const namedOf = (id: string): string[] => (Array.isArray(condWeb[id]) ? (condWeb[id] as unknown[]).filter((x): x is string => typeof x === 'string') : []);
  const metOf = (s: CheckedSample) => {
    const list = Array.isArray(s.payload?.condition_checks) ? (s.payload!.condition_checks as Record<string, unknown>[]) : [];
    const out = new Map<string, CiteBasis>();
    for (const c of list) {
      if (!c || c.status !== 'MET') continue;
      const id = String(c.id);
      const b = condCite(s, c.evidence_ids, src, namedOf(id));
      if (b && out.get(id) !== 'HARD') out.set(id, b);
    }
    return out;
  };
  const mets = samples.map(metOf);
  const metChecks = consensus ? [...mets[0].keys()].filter((id) => mets.every((x) => x.has(id))) : [];
  const metBasis: ReviewDecision['metBasis'] = Object.fromEntries(metChecks.map((id) => [id, mets.every((x) => x.get(id) === 'HARD') ? 'REVIEW_VOTE' : 'WEB_VOTE']));

  // §1.5 第 1 點：建議新增的條件，取自和結論同檔位的第一張合格票
  const rep = samples.find((s) => s.verdict === tier) ?? samples[0];
  const proposed: ProposedDraft[] = consensus
    ? (rep?.conditions ?? [])
        .filter((c) => c.from === 'payload.proposed_conditions')
        .slice(0, 3)
        .map((c, k) => ({
          ticker,
          runId: '',
          condId: String(c.raw.id ?? `N${k + 1}`).slice(0, 20),
          direction: (c.raw.direction === 'UP' ? 'UP' : 'DOWN') as 'UP' | 'DOWN',
          kind: (['XBRL', 'EVENT', 'PRICE'].includes(String(c.raw.kind)) ? c.raw.kind : 'EVENT') as OwnCondition['kind'],
          text: String(c.raw.text ?? '').slice(0, 300),
          check: (c.raw.check ?? {}) as Record<string, unknown>,
          tierIfMet: (typeof c.raw.tier_if_met === 'string' && c.raw.tier_if_met in TIER_NAME ? c.raw.tier_if_met : null) as Tier | null,
          manual: !c.auto,
          premiseId: typeof c.raw.premise_id === 'string' ? c.raw.premise_id.slice(0, 10) : null,
          supersedes: typeof c.raw.supersedes === 'string' ? c.raw.supersedes.slice(0, 10) : null,
        }))
    : [];

  const base = { tier, consensus, proposed, metChecks, metBasis, brokenPremises: broken, premiseId };
  if (!outcome.actionable) return { ...base, suggest: false, why: outcome.reason };
  const state = acct.rule.own[ticker]?.applied ?? 'STD';
  if (tier === 'HOLD' || tier === STATE_TIER[state]) return { ...base, suggest: false, why: `和目前狀態相同（${TIER_NAME[tier]}），不列進月報。` };
  if (tier === 'RAISE') {
    const allHold = samples.every((s) => s.premises.length > 0 && s.premises.every((p) => p.status === 'HOLDS'));
    if (allHold && !holdsHard(samples, src)) return { ...base, suggest: false, why: '要提高到 125%，每一條成立的前提都要有申報或財報表的引用（不能只靠網頁、新聞標題或價格）。' };
    const r = raiseAllowed(acct, ticker, asOf);
    return allHold && r.ok ? { ...base, suggest: true, why: '前提全部成立、規則條件成立：月報列提高到 125% 的建議。' } : { ...base, suggest: false, why: allHold ? `不能提高（${r.why}）` : '要提高到 125%，前提要全部成立。' };
  }
  if (tier !== 'EXIT' && tier !== 'HALF') {
    // 回到標準：往上的檔位不放寬，只認申報或財報引用的「不成立」，而且判成立的前提不能只靠網頁
    const hardBroken = brokenPremises(samples, pack, OWN_REVIEW_SAMPLES, { hardOnly: true });
    if (hardBroken.length && holdsHard(samples, src)) return { ...base, suggest: true, why: `3 票都判前提 ${hardBroken[0]} 不成立（有申報或財報的引用）：月報並列 AI 建議。` };
    return { ...base, suggest: false, why: `往上的檔位（${TIER_NAME[tier]}）不放寬：沒有一條前提三票都判「不成立」而且有申報或財報的引用，或判成立的前提沒有申報或財報的引用，只放網站。` };
  }
  if (premiseId) {
    const web = samples.some((s) => s.premises.some((p) => p.premise_id === premiseId && p.status === 'BROKEN' && premiseCite(s, p.evidence_ids, src) === 'WEB'));
    return { ...base, suggest: true, why: `3 票都判前提 ${premiseId} 不成立（${web ? '有清單內網頁全文的引用' : '有申報或財報的引用'}）：月報並列 AI 建議。` };
  }
  return { ...base, suggest: false, why: '檔位和目前不同，但沒有一條前提三票都判「不成立」而且有合格的引用（申報、財報表，或清單內的網頁：一手與指名的產業來源一份、媒體要兩個不同網域），只放網站。' };
}

// ---------------------------------------------------------------- F25 事件條件（新申報出現時）

export interface ConditionRunInput {
  acct: Account;
  view: MarketView;
  ticker: string;
  runId: string;
  conditions: OwnCondition[];
  /** 新出現、而且是條件指定的確認來源的申報原文。 */
  filings: PackDoc[];
  now: Date;
}

/** F25：新申報能不能證實某一條事件條件（3 票、引用必須是申報原文）。 */
export function conditionPack(inp: ConditionRunInput) {
  const events = inp.conditions.filter((c) => c.kind === 'EVENT' && c.status === 'ACTIVE');
  return buildPack({
    runId: inp.runId,
    fn: OWN_CONDITION,
    promptVersion: OWN_CONDITION_PROMPT,
    asOf: inp.view.date,
    subject: { ticker: inp.ticker },
    question:
      `${inp.ticker} 有新的申報。之前的審查寫下了下面幾條事件條件（facts 的 E 開頭）。` +
      '只根據這幾份申報的原文判斷：有沒有一條條件已經「成立」？成立要有申報原文的直接證據，沾到邊、只是可能、或市場評論都不算。' +
      '成立就 verdict = MET，payload.condition_id 寫是哪一條；都沒有成立就 NOT_MET。',
    policy: { level: 'A3', verdicts: ['MET', 'NOT_MET'], abstain: 'NOT_MET', min_evidence: 1, samples: 3 },
    rule: { action: '規則沒有動作（慢規則不受影響）', detail: { conditions: events.map((c) => c.condId) } },
    facts: [
      ...events.map((c, k) => ({ id: `E${k + 1}`, label: `條件 ${c.condId}（${c.direction === 'DOWN' ? '降級' : '升級'}，成立時建議${c.tierIfMet ? TIER_NAME[c.tierIfMet] : '重新審查'}）`, value: c.text, note: `確認來源：${((c.check.confirm_by as string[] | undefined) ?? []).join('、')}；寫於 ${c.createdAt.slice(0, 10)}` })),
      ...priceFacts(inp.view, inp.ticker).slice(0, 3),
    ],
    premises: ownPremises(inp.acct, inp.ticker),
    documents: inp.filings,
    dataQuality: { filings: inp.filings.length ? 'ok' : 'missing' },
    now: inp.now,
  });
}

/** F25 的 payload：condition_id 要是這次問的其中一條，而且每一票指的是同一條（在 conditionDecision 裡檢查）。 */
export function checkConditionPayload(s: CheckedSample, pack: EvidencePack): void {
  if (s.rawVerdict !== 'MET') return;
  const ids = new Set(((pack.rule.detail as { conditions?: string[] } | undefined)?.conditions ?? []).map(String));
  const id = s.payload?.condition_id;
  if (typeof id !== 'string' || !ids.has(id)) {
    s.issues.push(`MET 但 payload.condition_id（${String(id)}）不是這次問的條件，這一票改成 NOT_MET`);
    s.verdict = 'NOT_MET';
  }
}

/** F25 的結論：3 票一致 MET、指同一條、引用通過 → 那一條成立。 */
export function conditionDecision(outcome: Outcome): { condId: string | null; why: string } {
  if (!outcome.actionable || outcome.verdict !== 'MET') return { condId: null, why: outcome.reason };
  const ids = new Set(outcome.samples.map((s) => String(s.payload?.condition_id)));
  if (ids.size !== 1) return { condId: null, why: `3 票都說成立，但指的不是同一條（${[...ids].join('、')}），照規則。` };
  return { condId: [...ids][0], why: `3 票一致：條件 ${[...ids][0]} 成立。` };
}
