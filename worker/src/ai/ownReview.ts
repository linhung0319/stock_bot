// T10：F24 自選定期審查、F25 自選條件監測（ai_layer_design 的 F24、F25、F23 卡片）。
// 純函式：證據包、payload 的逐欄檢查、結論怎麼變成引擎的輸入。資料抓取與排程在 src/app/ownAi.ts。
import { TIER_NAME, type Account, type MarketView, type Tier } from '../engine';
import type { CheckedSample, EvidencePack, Outcome, PackDoc } from './check';
import { buildPack, ownPremises, ownRuleFacts, priceDoc, priceFacts } from './pack';

export const OWN_REVIEW = 'OWN_REVIEW';
export const OWN_CONDITION = 'OWN_CONDITION';
export const OWN_REVIEW_PROMPT = 'own_review_v1';
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

/** F25 監測中的條件（每次 F24 整組替換）。 */
export interface OwnCondition {
  ticker: string;
  runId: string;
  condId: string;
  direction: 'UP' | 'DOWN';
  kind: 'XBRL' | 'EVENT' | 'PRICE';
  text: string;
  check: Record<string, unknown>;
  tierIfMet: Tier | null;
  /** ACTIVE 監測中、MET 已成立、REPLACED 被下一次 F24 換掉、MANUAL 只記錄（價格條件、沒通過檢查的）。 */
  status: 'ACTIVE' | 'MET' | 'REPLACED' | 'MANUAL';
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
  trigger: 'MONTHLY' | 'EARNINGS' | 'MANUAL';
  /** XBRL 季度表（quarterTableText 的輸出）。 */
  xbrl: PackDoc | null;
  filings: PackDoc[];
  news: PackDoc | null;
  /** 上一次 F24 寫下、還在監測的條件。 */
  previous: OwnCondition[];
  dataQuality: EvidencePack['data_quality'];
  now: Date;
}

const STATE_TIER: Record<string, Tier> = { STD: 'STANDARD', HALF: 'HALF' };

/** F24 的證據包。 */
export function ownReviewPack(inp: OwnReviewInput) {
  const { acct, view, ticker } = inp;
  const raise = raiseAllowed(acct, ticker, view.date);
  const state = acct.rule.own[ticker]?.applied ?? 'STD';
  const verdicts: Tier[] = ['EXIT', 'HALF', 'HOLD', 'STANDARD', ...(raise.ok ? (['RAISE'] as Tier[]) : [])];
  const docs = [priceDoc(view, inp.axis, ticker, 60), inp.xbrl, ...inp.filings, inp.news].filter((d): d is PackDoc => !!d);
  const prev = inp.previous.filter((c) => c.status === 'ACTIVE' || c.status === 'MET');
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
      (prev.length ? '並逐條檢查上一次寫下的條件是否已經成立（payload.previous_conditions）。' : '') +
      '最後寫 2～5 條之後要監測的條件（payload.conditions）。',
    policy: { level: 'A3', verdicts, abstain: 'HOLD', min_evidence: 1, samples: 3 },
    rule: { action: `規則這次沒有動作；慢規則狀態：${state === 'HALF' ? '減半中' : '標準'}`, detail: { trigger: inp.trigger, state, raise: raise.why } },
    facts: [
      ...priceFacts(view, ticker),
      ...ownRuleFacts(acct, view, ticker),
      ...prev.map((c, k) => ({ id: `C${k + 1}`, label: `上一次的條件 ${c.condId}（${c.kind === 'XBRL' ? '財報' : c.kind === 'EVENT' ? '事件' : '價格'}，${c.direction === 'DOWN' ? '降級' : '升級'}）`, value: c.text, note: c.status === 'MET' ? `已成立（${c.metAt}）` : '監測中' })),
    ],
    premises: ownPremises(acct, ticker),
    documents: docs,
    dataQuality: inp.dataQuality,
    now: inp.now,
  });
}

const CONFIRM_BY = ['8-K', '10-Q', '10-K', 'SEC', 'earnings_call', 'major_news'];

/**
 * F24 的 payload 逐欄檢查（ai_layer F24 卡片）：tier 要和 verdict 一致；條件最多 5 條，
 * kind 只能是 XBRL（指標要是程式算得出來的）／EVENT（要寫確認來源）／PRICE（只記錄，不通知），tier_if_met 要是合法檔位。
 * 不合格的條件改標人工，不整票作廢。
 */
export function checkOwnReviewPayload(s: CheckedSample, pack: EvidencePack, metrics: ReadonlySet<string>): void {
  const p = s.payload ?? {};
  if (p.tier !== undefined && p.tier !== s.rawVerdict) s.issues.push(`payload.tier（${String(p.tier)}）和 verdict 不同`);
  if (Array.isArray(p.conditions) && p.conditions.length > 5) s.issues.push('條件超過 5 條，只看前 5 條');
  for (const c of s.conditions) {
    if (c.from !== 'payload.conditions' || !c.auto) continue;
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
  const prev = p.previous_conditions;
  if (prev !== undefined && !Array.isArray(prev)) s.issues.push('payload.previous_conditions 要是陣列');
}

/** 上一次的條件裡，這一票認為已經成立、而且有通過檢查的證據的。 */
function metPrevious(s: CheckedSample): string[] {
  const ok = new Set(s.evidence.filter((e) => e.ok).map((e) => e.id));
  const list = Array.isArray(s.payload?.previous_conditions) ? (s.payload!.previous_conditions as Record<string, unknown>[]) : [];
  return list.filter((c) => c && c.status === 'MET' && Array.isArray(c.evidence_ids) && (c.evidence_ids as unknown[]).some((id) => ok.has(String(id)))).map((c) => String(c.id ?? c.condition_id));
}

export type ConditionDraft = Omit<OwnCondition, 'status' | 'createdAt' | 'metAt' | 'note'> & { manual: boolean };

export interface ReviewDecision {
  /** 寫進引擎的檔位；null = 這次不更新（不一致、不合格、逾時）。 */
  tier: Tier | null;
  /** 月報並列 AI 建議（3 票一致、和目前不同、有不成立的前提或成立的條件做證據）。 */
  suggest: boolean;
  why: string;
  /** 新的監測條件（取代舊的）。 */
  conditions: ConditionDraft[];
  /** 上一次的條件裡，這次三票都認為已成立的。 */
  metPrevious: string[];
}

/**
 * F24 的結論 → 引擎的輸入（ai_layer F24「AI 權限」）。
 * suggest：3 票一致、和目前狀態不同、而且至少一條前提「不成立」或一條條件「成立」有通過檢查的證據；
 * RAISE 另外要求前提全部成立（F23）。其他情況只放網站。
 */
export function reviewDecision(outcome: Outcome, acct: Account, ticker: string, asOf: string): ReviewDecision {
  const empty: ReviewDecision = { tier: null, suggest: false, why: outcome.reason, conditions: [], metPrevious: [] };
  if (outcome.status !== 'AGREED' && outcome.status !== 'INSUFFICIENT' && outcome.status !== 'DATA_MISSING') return empty;
  const tier = outcome.verdict as Tier;
  const samples = outcome.samples.filter((s) => s.valid);
  const rep = samples.find((s) => s.verdict === tier) ?? samples[0];
  const conds: ConditionDraft[] = (rep?.conditions ?? [])
    .filter((c) => c.from === 'payload.conditions')
    .slice(0, 5)
    .map((c, k) => ({
      ticker,
      runId: '',
      condId: String(c.raw.id ?? `C${k + 1}`).slice(0, 20),
      direction: (c.raw.direction === 'UP' ? 'UP' : 'DOWN') as 'UP' | 'DOWN',
      kind: (['XBRL', 'EVENT', 'PRICE'].includes(String(c.raw.kind)) ? c.raw.kind : 'EVENT') as OwnCondition['kind'],
      text: String(c.raw.text ?? '').slice(0, 300),
      check: (c.raw.check ?? {}) as Record<string, unknown>,
      tierIfMet: (typeof c.raw.tier_if_met === 'string' && c.raw.tier_if_met in TIER_NAME ? c.raw.tier_if_met : null) as Tier | null,
      manual: !c.auto,
    }));
  const met = samples.length ? samples.map(metPrevious).reduce((a, b) => a.filter((x) => b.includes(x))) : [];
  const base = { tier, conditions: conds, metPrevious: met };
  if (!outcome.actionable) return { ...base, suggest: false, why: outcome.reason };
  const state = acct.rule.own[ticker]?.applied ?? 'STD';
  if (tier === 'HOLD' || tier === STATE_TIER[state]) return { ...base, suggest: false, why: `和目前狀態相同（${TIER_NAME[tier]}），不列進月報。` };
  if (tier === 'RAISE') {
    const allHold = samples.every((s) => s.premises.length > 0 && s.premises.every((p) => p.status === 'HOLDS'));
    const r = raiseAllowed(acct, ticker, asOf);
    return allHold && r.ok ? { ...base, suggest: true, why: '前提全部成立、規則條件成立：月報列提高到 125% 的建議。' } : { ...base, suggest: false, why: allHold ? `不能提高（${r.why}）` : '要提高到 125%，前提要全部成立。' };
  }
  const broken = samples.every((s) => s.premises.some((p) => p.status === 'BROKEN' && p.evidence_ids.length));
  if (broken || met.length) return { ...base, suggest: true, why: broken ? '3 票都指出有前提不成立（有通過檢查的證據）：月報並列 AI 建議。' : `上一次的條件 ${met.join('、')} 已成立：月報並列 AI 建議。` };
  return { ...base, suggest: false, why: '檔位和目前不同，但沒有一條前提「不成立」或條件「成立」有證據，只放網站。' };
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
