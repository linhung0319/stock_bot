// T10：F24 自選定期審查、F25 自選條件監測（ai_layer_design 的 F24、F25、F23 卡片）。
// 純函式：證據包、payload 的逐欄檢查、結論怎麼變成引擎的輸入。資料抓取與排程在 src/app/ownAi.ts。
import { TIER_NAME, type Account, type MarketView, type ReviewTrigger, type Tier } from '../engine';
import { keptByChoice, type CheckedSample, type EvidencePack, type Outcome, type PackDoc } from './check';
import { buildPack, ownPremises, ownRuleFacts, priceDoc, priceFacts } from './pack';

export const OWN_REVIEW = 'OWN_REVIEW';
export const OWN_CONDITION = 'OWN_CONDITION';
export const OWN_REVIEW_PROMPT = 'own_review_v2';
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
  /** 論點檔的條件：你定的 C、觀察項 W（thesis.ts 的 condFacts）；map 是證據包編號 → 條件的列編號，記在 rule.detail.conds。 */
  conds?: { facts: EvidencePack['facts']; map: Record<string, number> };
  dataQuality: EvidencePack['data_quality'];
  /** 由論點檔組的數字（T0、事件 V、預設前提的 D1～D3；own_thesis §1.6），接在原本的數字後面。 */
  extraFacts?: EvidencePack['facts'];
  /** 由論點檔組的原文（論點那一份 note），放在最後。 */
  extraDocs?: PackDoc[];
  /** 月底檢查點開的審查：新證據的原因清單（own_thesis §3.7），記在 rule.detail.reasons。 */
  reasons?: string[];
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
  const hasC = conds.facts.some((f) => f.id.startsWith('C'));
  const hasW = conds.facts.some((f) => f.id.startsWith('W'));
  return buildPack({
    runId: inp.runId,
    fn: OWN_REVIEW,
    promptVersion: OWN_REVIEW_PROMPT,
    asOf: view.date,
    subject: { ticker },
    question:
      `${ticker} 是自選股，目前慢規則狀態「${state === 'HALF' ? '減半中' : '標準'}」（等於檔位 ${STATE_TIER[state]}）。` +
      '請逐條檢查使用者的前提：哪些證據顯示它成立？哪些證據顯示它不成立？把「論點壞了」和「價格跌了」分開。' +
      '假設三個月後回頭看，這次維持現狀是錯的，最可能的原因是什麼、今天有什麼證據？' +
      `最後選一個檔位：${verdicts.map((v) => `${v}（${TIER_NAME[v]}）`).join('、')}；證據不足以改變就選 HOLD。` +
      (raise.ok ? '只有前提全部成立時才可以選 RAISE。' : `這個月不能選 RAISE（${raise.why}）。`) +
      (hasC || hasW ? `並逐條檢查${hasC ? '使用者定的條件（facts 的 C 開頭）' : ''}${hasC && hasW ? '與' : ''}${hasW ? '觀察項（facts 的 W 開頭）' : ''}是否已經成立（payload.condition_checks）。` : '') +
      '最後可以建議最多 3 條新增的條件（payload.proposed_conditions）：現有的條件已經涵蓋的事不要再提，還適用的觀察項原樣再提（算在 3 條內）；使用者勾選才會監測。',
    policy: { level: 'A3', verdicts, abstain: 'HOLD', min_evidence: 1, samples: OWN_REVIEW_SAMPLES },
    rule: { action: `規則這次沒有動作；慢規則狀態：${state === 'HALF' ? '減半中' : '標準'}`, detail: { trigger: inp.trigger, state, raise: raise.why, conds: conds.map, thesisVersion: acct.own[ticker]?.thesis?.version ?? 0, ...(inp.reasons ? { reasons: inp.reasons } : {}) } },
    facts: [...priceFacts(view, ticker), ...ownRuleFacts(acct, view, ticker), ...conds.facts, ...(inp.extraFacts ?? [])],
    premises: ownPremises(acct, ticker),
    documents: docs,
    dataQuality: inp.dataQuality,
    now: inp.now,
  });
}

const CONFIRM_BY = ['8-K', '10-Q', '10-K', 'SEC', 'earnings_call', 'major_news'];
const FILING_SOURCES = ['8-K', '10-Q', '10-K', 'SEC'];

/**
 * 條件怎麼確認（own_thesis §1.5「怎麼確認」，由條件本身推出來，不另存）：
 *   XBRL        財報條件，新 10-Q／10-K 出來時程式比對
 *   FILING      事件條件，確認來源裡有申報類型 → 新申報出現時 F25 三票讀原文
 *   REVIEW_ONLY 事件條件，確認來源只有 earnings_call、major_news → 沒有申報可讀，只在定期審查時由三票判斷（P4）
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
  return by.every((x) => x === 'earnings_call' || x === 'major_news') ? 'REVIEW_ONLY' : 'NONE';
}

/**
 * F24 的 payload 逐欄檢查（ai_layer F24 卡片；own_review_v2）：tier 要和 verdict 一致；建議新增的條件（proposed_conditions）最多 3 條，
 * kind 只能是 XBRL（指標要是程式算得出來的）／EVENT（要寫確認來源）／PRICE（只記錄，不通知），tier_if_met 要是合法檔位。
 * 不合格的條件改標人工，不整票作廢。F14 健檢（payload.conditions，最多 5 條）共用同一套條件檢查。
 */
export function checkOwnReviewPayload(s: CheckedSample, pack: EvidencePack, metrics: ReadonlySet<string>): void {
  const p = s.payload ?? {};
  if (p.tier !== undefined && p.tier !== s.rawVerdict) s.issues.push(`payload.tier（${String(p.tier)}）和 verdict 不同`);
  if (Array.isArray(p.conditions) && p.conditions.length > 5) s.issues.push('條件超過 5 條，只看前 5 條');
  if (Array.isArray(p.proposed_conditions) && p.proposed_conditions.length > 3) s.issues.push('建議的條件超過 3 條，只看前 3 條');
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
            ? c.type !== 'event' || !Array.isArray(check.confirm_by) || !check.confirm_by.length || check.confirm_by.some((x) => !CONFIRM_BY.includes(String(x)))
              ? '事件條件要寫確認來源（confirm_by）'
              : null
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
  /** 三票的 condition_checks 都寫 MET、各有通過檢查的申報或財報引用的條件（證據包的編號 C…、W…）；consensus 是 false 時是空的。 */
  metChecks: string[];
  /** 不成立的前提（§1.6 第 1 點：三票都判 BROKEN、每一票都至少有一條申報或財報的引用；取交集），編號由小到大。 */
  brokenPremises: string[];
  /** 主要的不成立前提（編號最小的那條）；沒有是 null。寫進 aiTier.premiseId。 */
  premiseId: string | null;
}

const pnum = (id: string) => Number(/\d+/.exec(id)?.[0] ?? Infinity);

/** 這一票的某幾條證據裡，有沒有一條通過檢查、而且來源是申報原文或財報表（documents 的 kind 是 filing 或 xbrl）。 */
function hardCited(s: CheckedSample, ids: unknown, hard: Set<string>): boolean {
  if (!Array.isArray(ids)) return false;
  const ok = new Map(s.evidence.filter((e) => e.ok).map((e) => [e.id, e.source_id]));
  return ids.some((id) => hard.has(ok.get(String(id)) ?? ''));
}

/**
 * F24 的結論 → 引擎的輸入與條件的變動（own_thesis §1.5、§1.6「程式怎麼用結論」第 1、2、4 點）。
 * suggest：3 票一致、和目前狀態不同、而且有一條「不成立的前提」（只有新聞標題或價格當引用的不算；修 N5）；RAISE 另外要求前提全部成立（F23）。
 * 其他情況只放網站。什麼時候當天通知（§1.9）由之後的任務做。
 */
export function reviewDecision(outcome: Outcome, acct: Account, ticker: string, asOf: string, pack: Pick<EvidencePack, 'documents'>): ReviewDecision {
  const empty: ReviewDecision = { tier: null, suggest: false, why: outcome.reason, consensus: false, proposed: [], metChecks: [], brokenPremises: [], premiseId: null };
  if (outcome.status !== 'AGREED' && outcome.status !== 'INSUFFICIENT' && outcome.status !== 'DATA_MISSING') return empty;
  const tier = outcome.verdict as Tier;
  const samples = outcome.samples.filter((s) => s.valid);
  const full = samples.length >= OWN_REVIEW_SAMPLES;
  const consensus = full && (outcome.status === 'AGREED' || (outcome.status === 'INSUFFICIENT' && keptByChoice('HOLD', outcome.samples, OWN_REVIEW_SAMPLES)));
  const hard = new Set(pack.documents.filter((d) => d.kind === 'filing' || d.kind === 'xbrl').map((d) => d.source_id));

  // §1.6 第 1 點：不成立的前提取交集
  const brokenOf = (s: CheckedSample) => new Set(s.premises.filter((p) => p.status === 'BROKEN' && hardCited(s, p.evidence_ids, hard)).map((p) => p.premise_id));
  const sets = samples.map(brokenOf);
  const brokenPremises = full ? [...sets[0]].filter((id) => sets.every((x) => x.has(id))).sort((a, b) => pnum(a) - pnum(b)) : [];
  const premiseId = brokenPremises[0] ?? null;

  // §1.6 第 2 點：三票都寫 MET、各有申報或財報的引用
  const metOf = (s: CheckedSample) => {
    const list = Array.isArray(s.payload?.condition_checks) ? (s.payload!.condition_checks as Record<string, unknown>[]) : [];
    return new Set(list.filter((c) => c && c.status === 'MET' && hardCited(s, c.evidence_ids, hard)).map((c) => String(c.id)));
  };
  const mets = samples.map(metOf);
  const metChecks = consensus ? [...mets[0]].filter((id) => mets.every((x) => x.has(id))) : [];

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

  const base = { tier, consensus, proposed, metChecks, brokenPremises, premiseId };
  if (!outcome.actionable) return { ...base, suggest: false, why: outcome.reason };
  const state = acct.rule.own[ticker]?.applied ?? 'STD';
  if (tier === 'HOLD' || tier === STATE_TIER[state]) return { ...base, suggest: false, why: `和目前狀態相同（${TIER_NAME[tier]}），不列進月報。` };
  if (tier === 'RAISE') {
    const allHold = samples.every((s) => s.premises.length > 0 && s.premises.every((p) => p.status === 'HOLDS'));
    const r = raiseAllowed(acct, ticker, asOf);
    return allHold && r.ok ? { ...base, suggest: true, why: '前提全部成立、規則條件成立：月報列提高到 125% 的建議。' } : { ...base, suggest: false, why: allHold ? `不能提高（${r.why}）` : '要提高到 125%，前提要全部成立。' };
  }
  if (premiseId) return { ...base, suggest: true, why: `3 票都判前提 ${premiseId} 不成立（有申報或財報的引用）：月報並列 AI 建議。` };
  return { ...base, suggest: false, why: '檔位和目前不同，但沒有一條前提三票都判「不成立」而且有申報或財報的引用，只放網站。' };
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
