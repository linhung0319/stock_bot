// T11：F14 新增自選股的健檢（ai_layer_design F14 卡片、§9.1；design_v2 §2.2）。
// 權限 A1：只提供資訊，不給「買／不買」的結論。
//   規則數字（距高點、200 日均線、波動度、建議標準比重）、硬事件掃描（F1 的規則偵測段）、和既有持股的相關性：程式算好。
//   使用者寫了理由與出場條件 → AI 把出場條件改寫成可追蹤的格式（財報門檻、申報事件；價格只記錄），使用者確認後交給 F25 監測。
//   使用者沒寫 → AI 草擬「價格隱含的前提」讓使用者勾選。
import { TIER_NAME, type Tier } from '../engine';
import type { CheckedSample, EvidencePack, Outcome, PackDoc } from './check';
import type { EntryHit } from './momEntry';
import { checkOwnReviewPayload, type ConditionDraft } from './ownReview';
import { buildPack } from './pack';

export const OWN_CHECK = 'OWN_CHECK';
export const OWN_CHECK_PROMPT = 'own_check_v1';

export interface OwnCheckInput {
  runId: string;
  asOf: string;
  ticker: string;
  /** 使用者寫的理由與出場條件（一行一條）；空的 = 請 AI 草擬前提。 */
  lines: string[];
  facts: EvidencePack['facts'];
  hits: EntryHit[];
  docs: PackDoc[];
  dataQuality: EvidencePack['data_quality'];
  now: Date;
}

export function ownCheckPack(inp: OwnCheckInput) {
  const draft = !inp.lines.length;
  return buildPack({
    runId: inp.runId,
    fn: OWN_CHECK,
    promptVersion: OWN_CHECK_PROMPT,
    asOf: inp.asOf,
    subject: { ticker: inp.ticker },
    question: draft
      ? `使用者想把 ${inp.ticker} 加進自選，但沒寫買進理由。請草擬 2～4 條「現在的股價隱含了哪些前提」（payload.premises_draft），每條附「不成立的訊號」（breaks_if），讓使用者勾選。只寫證據包看得到的事；不要評論該不該買。`
      : `使用者想把 ${inp.ticker} 加進自選，寫了下面幾行理由與出場條件（facts 的 U 開頭）。請把其中的出場條件改寫成可追蹤的格式（payload.conditions，格式和定期審查相同），數字門檻要對應證據包裡的數字；理由本身不用改寫。不要評論該不該買。`,
    policy: { level: 'A1', verdicts: ['DONE', 'INSUFFICIENT'], abstain: 'INSUFFICIENT', min_evidence: 0, samples: 1 },
    rule: { action: '只提供資訊（不給買或不買的結論）', detail: { mode: draft ? 'DRAFT' : 'REWRITE', lines: inp.lines } },
    facts: [...inp.facts, ...inp.lines.map((l, k) => ({ id: `U${k + 1}`, label: '使用者寫的', value: l.slice(0, 300) })), ...inp.hits.map((h, k) => ({ id: `H${k + 1}`, label: `硬事件掃描：${h.code}（${h.sub}）`, value: h.date ?? inp.asOf, note: h.detail }))],
    documents: inp.docs,
    dataQuality: inp.dataQuality,
    now: inp.now,
  });
}

const TIERS: Tier[] = ['EXIT', 'HALF', 'HOLD', 'STANDARD'];

/** 草擬的前提最多 4 條；條件照 F24 的規則逐條檢查（不合格的改標人工）。 */
export function checkOwnCheckPayload(s: CheckedSample, pack: EvidencePack, metrics: ReadonlySet<string>): void {
  const p = s.payload ?? {};
  const raw = Array.isArray(p.premises_draft) ? (p.premises_draft as unknown[]) : [];
  const drafts = raw
    .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && typeof (x as Record<string, unknown>).text === 'string')
    .slice(0, 4)
    .map((x) => ({ text: String(x.text).slice(0, 200), breaks_if: typeof x.breaks_if === 'string' ? x.breaks_if.slice(0, 200) : '' }));
  if (raw.length > drafts.length) s.issues.push('草擬的前提有格式不對或超過 4 條的，拿掉');
  s.payload = { ...p, premises_draft: drafts };
  checkOwnReviewPayload(s, { ...pack, policy: { ...pack.policy, verdicts: TIERS } }, metrics);
}

export interface OwnCheckResult {
  drafts: { text: string; breaksIf: string }[];
  conditions: (ConditionDraft & { then: string })[];
  summary: string | null;
}

/** 健檢的結果（網站顯示，讓使用者勾選）。 */
export function ownCheckResult(outcome: Outcome | null, ticker: string): OwnCheckResult {
  const s = outcome?.samples.find((x) => x.valid && x.verdict === 'DONE');
  if (!s) return { drafts: [], conditions: [], summary: outcome?.reason ?? null };
  const drafts = ((s.payload?.premises_draft as { text: string; breaks_if: string }[]) ?? []).map((d) => ({ text: d.text, breaksIf: d.breaks_if }));
  const conditions = s.conditions
    .filter((c) => c.from === 'payload.conditions')
    .slice(0, 5)
    .map((c, k) => {
      const tier = typeof c.raw.tier_if_met === 'string' && c.raw.tier_if_met in TIER_NAME ? (c.raw.tier_if_met as Tier) : null;
      return {
        ticker,
        runId: '',
        condId: `U${k + 1}`,
        direction: (c.raw.direction === 'UP' ? 'UP' : 'DOWN') as 'UP' | 'DOWN',
        kind: (['XBRL', 'EVENT', 'PRICE'].includes(String(c.raw.kind)) ? c.raw.kind : 'EVENT') as ConditionDraft['kind'],
        text: String(c.raw.text ?? '').slice(0, 300),
        check: (c.raw.check ?? {}) as Record<string, unknown>,
        tierIfMet: tier,
        manual: !c.auto,
        then: c.auto ? (tier ? `成立時建議${TIER_NAME[tier]}（當天通知）` : '成立時重新審查') : `只記錄：${c.why ?? ''}`,
      };
    });
  return { drafts, conditions, summary: s.report?.split(/\n\s*\n/)[0]?.slice(0, 400) ?? null };
}
