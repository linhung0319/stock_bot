// AI 層的共用骨架（ai_layer_design §2）：證據包的格式、輸出外殼的程式檢查、票數。
// 純函式：不讀網路、不碰儲存。雲端排程送回來的東西一律當成不可信的輸入。
//
//   證據包（EvidencePack）：程式先準備好、LLM 只能讀。所有數字由程式算好；原文放在 documents，引用必須是原文的子字串。
//   每一票（sample）是一份輸出外殼（§2.2）。檢查（§2.3）：
//     格式、verdict 在列舉值內                  → 不通過就當成「證據不足」那一票
//     evidence 的 source_id 在證據包內、date ≤ as_of、quote 是原文的子字串 → 不通過就刪掉這條證據
//     前提的判斷引用的證據都被刪掉              → 改成「證據不足」
//     A3／A4 的動作需要的證據條數不足          → 這一票降級為「證據不足」
//     條件只能用固定的類型，數字門檻要對應一條通過檢查的證據 → 否則改標「人工」，不進自動追蹤
//     資料缺漏（data_quality 有 missing）       → 禁止 A3、A4
//   表決（§2.4）：獨立跑 N 次（有權限的判斷 N = 3），全部一致才算數；不一致、不合格、逾時一律照規則並記錄。

export type Level = 'A1' | 'A2' | 'A3' | 'A4';
export type DataQuality = 'ok' | 'live' | 'partial' | 'missing';

export interface PackDoc {
  /** 證據包內的編號，例如 D3。LLM 引用時用 source_id。 */
  id: string;
  /** 來源編號，例如 edgar:0001341439-26-000123、xbrl:MU:GrossProfit:2026Q3、price:MU。 */
  source_id: string;
  kind: 'filing' | 'xbrl' | 'news' | 'price' | 'rule' | 'note' | 'table';
  /** 這份資料的日期（申報日、新聞日、資料截止日），≤ as_of。 */
  date: string;
  title: string;
  url?: string;
  /** 原文（引用要是它的子字串）。 */
  text: string;
  fetched_at?: string;
}

export interface PackPremise {
  id: string;
  text: string;
  origin?: string;
  breaksIf?: string;
}

export interface PackPolicy {
  level: Level;
  /** verdict 可以用的值。 */
  verdicts: string[];
  /** 代表「證據不足／維持規則」的那個值（不合格的一票也算成它）。 */
  abstain: string;
  /** A3／A4 的動作至少要有幾條通過檢查的證據。 */
  min_evidence: number;
  /** 要獨立跑幾次。 */
  samples: number;
}

export interface EvidencePack {
  pack_version: 1;
  run_id: string;
  /** 功能代號，例如 OWN_REVIEW（F24）、OWN_CONDITION（F25）、MOM_ENTRY（F1）、CRASH_REVIEW（F5／F6）。 */
  function: string;
  prompt_version: string;
  /** 決策日：只放這天收盤以前的資料。 */
  as_of: string;
  created_at: string;
  subject: { ticker?: string; name?: string };
  /** 中立的問題（§2.6：同時問成立與不成立的證據）。 */
  question: string;
  policy: PackPolicy;
  /** 規則這次的動作（給 LLM 看，也記進影子）。 */
  rule: { action: string; detail?: unknown };
  facts: { id: string; label: string; value: string; note?: string }[];
  premises: PackPremise[];
  documents: PackDoc[];
  data_quality: Record<string, DataQuality>;
  /** 條件可以用的類型（§2.3）。 */
  condition_types: string[];
}

/** 條件可以用的類型（§2.3：價格、均線、日期、申報事件、XBRL 指標門檻、事件描述＋確認來源；F5／F6 的總經門檻）。 */
export const CONDITION_TYPES = [
  'price_close_above',
  'price_close_below',
  'ma_cross_above',
  'ma_cross_below',
  'date_after',
  'filing_event',
  'xbrl_metric_above',
  'xbrl_metric_below',
  'event',
  'fred_above',
  'fred_below',
] as const;

/** 一份輸出外殼可以有的欄位。 */
const ENVELOPE_KEYS = ['run_id', 'function', 'as_of', 'model', 'prompt_version', 'pack_hash', 'samples', 'vote', 'verdict', 'premise_checks', 'evidence', 'lift_or_flip', 'abstain_reason', 'data_quality', 'payload', 'report'];
export const PREMISE_STATUS = ['HOLDS', 'BROKEN', 'INSUFFICIENT'] as const;
/** 引用至少要多長（太短的字串幾乎一定是原文的子字串，檢查沒有意義）。 */
export const MIN_QUOTE = 12;
export const MAX_REPORT = 20_000;

export interface CheckedEvidence {
  id: string;
  source_id: string;
  date: string;
  quote: string;
  claim: string;
  ok: boolean;
  /** 不通過的原因。 */
  why?: string;
}
export interface CheckedPremise {
  premise_id: string;
  status: (typeof PREMISE_STATUS)[number];
  evidence_ids: string[];
  /** 原本的判斷（引用的證據被刪掉而改成證據不足時）。 */
  downgradedFrom?: string;
}
export interface CheckedCondition {
  /** 在哪裡：lift_or_flip 或 payload.conditions。 */
  from: 'lift_or_flip' | 'payload.conditions';
  raw: Record<string, unknown>;
  type: string | null;
  /** true = 可以自動追蹤；false = 改標「人工」。 */
  auto: boolean;
  why?: string;
}
export interface CheckedSample {
  index: number;
  /** 格式合格（不合格的一票算成 abstain）。 */
  valid: boolean;
  /** 檢查之後的判斷（不合格或證據不足時是 abstain）。 */
  verdict: string;
  /** LLM 原本寫的判斷。 */
  rawVerdict: string | null;
  issues: string[];
  evidence: CheckedEvidence[];
  premises: CheckedPremise[];
  conditions: CheckedCondition[];
  abstainReason: string | null;
  dataMissing: string[];
  model: string | null;
  payload: Record<string, unknown> | null;
  report: string | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max = 2000): string | null => (typeof v === 'string' && v.length <= max ? v : null);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** 比對引用用：Unicode 正規化、各種引號與破折號統一、連續空白壓成一個。 */
export function normalizeText(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function checkEvidence(raw: unknown, pack: EvidencePack, docs: Map<string, string>): CheckedEvidence {
  const o = isObj(raw) ? raw : {};
  const ev: CheckedEvidence = { id: str(o.id, 40) ?? '', source_id: str(o.source_id, 200) ?? '', date: str(o.date, 10) ?? '', quote: str(o.quote, 4000) ?? '', claim: str(o.claim, 1000) ?? '', ok: false };
  if (!isObj(raw)) return { ...ev, why: '格式不對' };
  if (!ev.id) return { ...ev, why: '沒有編號' };
  const text = docs.get(ev.source_id);
  if (text === undefined) return { ...ev, why: `來源 ${ev.source_id || '（空的）'} 不在證據包裡` };
  if (!DATE.test(ev.date)) return { ...ev, why: '日期格式不對' };
  if (ev.date > pack.as_of) return { ...ev, why: `日期 ${ev.date} 在決策日 ${pack.as_of} 之後` };
  const q = normalizeText(ev.quote);
  if (q.length < MIN_QUOTE) return { ...ev, why: `引用太短（至少 ${MIN_QUOTE} 個字）` };
  if (!text.includes(q)) return { ...ev, why: '引用不是原文的子字串' };
  return { ...ev, ok: true };
}

function checkConditions(list: unknown, from: CheckedCondition['from'], okIds: Set<string>, types: Set<string>, issues: string[]): CheckedCondition[] {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) {
    issues.push(`${from} 要是陣列`);
    return [];
  }
  return list.slice(0, 10).map((raw): CheckedCondition => {
    if (!isObj(raw)) return { from, raw: {}, type: null, auto: false, why: '格式不對' };
    const check = isObj(raw.check) ? raw.check : raw;
    const type = typeof check.type === 'string' ? check.type : null;
    if (!type || !types.has(type)) return { from, raw, type, auto: false, why: `條件類型 ${type ?? '（沒有）'} 不在允許的清單內` };
    const numeric = Object.entries(check).some(([k, v]) => k !== 'days' && k !== 'quarters' && typeof v === 'number');
    if (numeric) {
      const basis = [...(Array.isArray(raw.basis) ? raw.basis : []), ...(Array.isArray(raw.evidence_ids) ? raw.evidence_ids : [])].filter((x): x is string => typeof x === 'string');
      if (!basis.some((id) => okIds.has(id))) return { from, raw, type, auto: false, why: '數字門檻沒有對應到一條通過檢查的證據' };
    }
    return { from, raw, type, auto: true };
  });
}

/** 各功能自己的 payload 檢查（在通用檢查之後、證據條數降級之前呼叫；可以加 issues、把條件改標人工、改 verdict）。 */
export type PayloadHook = (s: CheckedSample, pack: EvidencePack) => void;

/** 檢查一票。 */
export function checkSample(pack: EvidencePack, raw: unknown, index: number, hook?: PayloadHook): CheckedSample {
  const pol = pack.policy;
  const out: CheckedSample = { index, valid: false, verdict: pol.abstain, rawVerdict: null, issues: [], evidence: [], premises: [], conditions: [], abstainReason: null, dataMissing: [], model: null, payload: null, report: null };
  if (!isObj(raw)) {
    out.issues.push('這一票不是 JSON 物件');
    return out;
  }
  const extra = Object.keys(raw).filter((k) => !ENVELOPE_KEYS.includes(k));
  if (extra.length) out.issues.push(`多了不認得的欄位：${extra.join(', ')}`);
  for (const [k, want] of [
    ['run_id', pack.run_id],
    ['function', pack.function],
    ['as_of', pack.as_of],
  ] as const) {
    if (raw[k] !== undefined && raw[k] !== want) out.issues.push(`${k} 和證據包不同（${String(raw[k])}）`);
  }
  out.rawVerdict = typeof raw.verdict === 'string' ? raw.verdict.slice(0, 40) : null;
  if (!out.rawVerdict || !pol.verdicts.includes(out.rawVerdict)) out.issues.push(`verdict 不在列舉值內：${out.rawVerdict ?? '（沒有）'}`);
  if (!Array.isArray(raw.evidence)) out.issues.push('evidence 要是陣列');
  if (raw.premise_checks !== undefined && !Array.isArray(raw.premise_checks)) out.issues.push('premise_checks 要是陣列');
  if (raw.payload !== undefined && !isObj(raw.payload)) out.issues.push('payload 要是物件');
  if (raw.data_quality !== undefined && !isObj(raw.data_quality)) out.issues.push('data_quality 要是物件');
  out.model = str(raw.model, 80);
  out.report = str(raw.report, MAX_REPORT);
  out.abstainReason = str(raw.abstain_reason, 1000);
  // 格式不合格：整票算成 abstain（照規則），不再往下看
  if (out.issues.length) return out;
  out.valid = true;

  const docs = new Map(pack.documents.map((d) => [d.source_id, normalizeText(d.text)]));
  out.evidence = (raw.evidence as unknown[]).slice(0, 40).map((e) => checkEvidence(e, pack, docs));
  const okIds = new Set(out.evidence.filter((e) => e.ok).map((e) => e.id));

  const premiseIds = new Set(pack.premises.map((p) => p.id));
  for (const p of (raw.premise_checks as unknown[] | undefined) ?? []) {
    if (!isObj(p) || typeof p.premise_id !== 'string' || !premiseIds.has(p.premise_id) || !PREMISE_STATUS.includes(p.status as never)) {
      out.issues.push(`前提的判斷格式不對：${JSON.stringify(p).slice(0, 120)}`);
      continue;
    }
    const ids = (Array.isArray(p.evidence_ids) ? p.evidence_ids : []).filter((x): x is string => typeof x === 'string');
    const kept = ids.filter((id) => okIds.has(id));
    const status = p.status as CheckedPremise['status'];
    if (status !== 'INSUFFICIENT' && !kept.length) out.premises.push({ premise_id: p.premise_id, status: 'INSUFFICIENT', evidence_ids: [], downgradedFrom: status });
    else out.premises.push({ premise_id: p.premise_id, status, evidence_ids: kept });
  }

  out.payload = (raw.payload as Record<string, unknown> | undefined) ?? {};
  const types = new Set(pack.condition_types);
  out.conditions = [...checkConditions(raw.lift_or_flip, 'lift_or_flip', okIds, types, out.issues), ...checkConditions(out.payload.conditions, 'payload.conditions', okIds, types, out.issues)];

  const dq = { ...pack.data_quality, ...((raw.data_quality as Record<string, unknown> | undefined) ?? {}) };
  out.dataMissing = Object.entries(dq)
    .filter(([, v]) => v === 'missing')
    .map(([k]) => k);

  out.verdict = out.rawVerdict!;
  hook?.(out, pack);
  if (out.verdict !== pol.abstain && (pol.level === 'A3' || pol.level === 'A4') && okIds.size < pol.min_evidence) {
    out.issues.push(`通過檢查的證據只有 ${okIds.size} 條（需要 ${pol.min_evidence} 條），這一票改成 ${pol.abstain}`);
    out.verdict = pol.abstain;
  }
  return out;
}

export type OutcomeStatus =
  | 'AGREED' // 全部一致、不是「證據不足」
  | 'INSUFFICIENT' // 全部一致說證據不足
  | 'SPLIT' // 票數不一致
  | 'INVALID' // 沒有一票合格
  | 'DATA_MISSING' // 一致，但資料有缺漏，禁止 A3／A4
  | 'TIMEOUT' // 逾時沒有結果
  | 'NO_RESULT'; // 觸發失敗、結果被退回

export interface Outcome {
  status: OutcomeStatus;
  /** AGREED 時是一致的判斷；其他情況是最多票的（只供顯示）。 */
  verdict: string | null;
  votes: Record<string, number>;
  /** A3／A4 的建議可以拿去用（月報並列、當天通知、否決）。 */
  actionable: boolean;
  /** 照規則（AI 的意見只記錄）。 */
  followRule: boolean;
  /** 白話的說明。 */
  reason: string;
  samples: CheckedSample[];
}

const LEVEL_CAN_ACT = (l: Level) => l === 'A3' || l === 'A4';

/** 票數與結論。samples：檢查過的每一票；少送的票算成 abstain。 */
export function decide(pack: EvidencePack, samples: CheckedSample[]): Outcome {
  const pol = pack.policy;
  const n = Math.max(pol.samples, samples.length);
  const verdicts = [...samples.map((s) => s.verdict), ...Array.from({ length: Math.max(0, pol.samples - samples.length) }, () => pol.abstain)];
  const votes: Record<string, number> = {};
  for (const v of verdicts) votes[v] = (votes[v] ?? 0) + 1;
  const top = Object.entries(votes).sort((a, b) => b[1] - a[1] || (a[0] === pol.abstain ? 1 : b[0] === pol.abstain ? -1 : 0))[0];
  const plurality = top ? top[0] : null;
  const base = { votes, samples, verdict: plurality };
  const voteText = Object.entries(votes)
    .map(([k, v]) => `${k} ${v}`)
    .join('、');
  if (!samples.some((s) => s.valid)) return { ...base, status: 'INVALID', actionable: false, followRule: true, reason: `${samples.length ? '送回的' + samples.length + ' 票格式都不合格' : '沒有送回任何一票'}，照規則。` };
  const unanimous = Object.keys(votes).length === 1 && verdicts.length === n;
  if (!unanimous) return { ...base, status: 'SPLIT', actionable: false, followRule: true, reason: `${n} 票不一致（${voteText}），照規則並記錄。` };
  if (plurality === pol.abstain) return { ...base, status: 'INSUFFICIENT', actionable: false, followRule: true, reason: `${n} 票都認為證據不足，照規則。` };
  const missing = [...new Set(samples.flatMap((s) => s.dataMissing))];
  if (missing.length && LEVEL_CAN_ACT(pol.level)) return { ...base, status: 'DATA_MISSING', actionable: false, followRule: true, reason: `${n} 票一致是 ${plurality}，但資料有缺漏（${missing.join('、')}），不能改變下單，照規則並記錄。` };
  const act = LEVEL_CAN_ACT(pol.level);
  return { ...base, status: 'AGREED', actionable: act, followRule: !act, reason: act ? `${n} 票一致：${plurality}。` : `${n} 票一致：${plurality}（只說明、記影子，不改變下單）。` };
}

/** 送回的結果（多票）→ 檢查 → 結論。 */
export function judge(pack: EvidencePack, rawSamples: unknown[], hook?: PayloadHook): Outcome {
  return decide(
    pack,
    rawSamples.slice(0, 5).map((s, i) => checkSample(pack, s, i, hook)),
  );
}

/** 沒有結果時（逾時、觸發失敗、結果被退回）的結論：照規則。 */
export function noResult(pack: EvidencePack, status: 'TIMEOUT' | 'NO_RESULT', why: string): Outcome {
  return { status, verdict: null, votes: {}, actionable: false, followRule: true, reason: `${why}，照規則。`, samples: [] };
}

/** 證據包的雜湊（記在紀錄裡，之後可以確認 AI 看的是哪一份）。 */
export async function packHash(pack: EvidencePack): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(pack));
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return 'sha256:' + [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
