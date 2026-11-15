// F14：出場條件改寫（own_thesis §1.8 確認的第 2 點；T27 起只留改寫模式，「請 AI 草擬前提」拿掉，§1.12）。
// 權限 A1：只提供資訊，不給「買／不買」的結論。
//   使用者在「編輯論點」頁寫的出場條件（每條帶使用者選的成立時動作）→ AI 改寫成可追蹤的格式（財報門檻、申報事件；價格只記錄），
//   使用者在持股頁勾選後才監測。題目對已持有的股票與新加入的都成立；證據包帶現行的論點、前提與既有的條件（P7）。
//   規則數字（距高點、200 日均線、波動度、建議標準比重）、硬事件掃描（F1 的規則偵測段）、和既有持股的相關性：程式算好。
import { TIER_NAME, type Tier } from '../engine';
import type { CheckedSample, EvidencePack, Outcome, PackDoc, PackPremise } from './check';
import type { EntryHit } from './momEntry';
import { checkOwnReviewPayload, type ConditionDraft } from './ownReview';
import { buildPack } from './pack';
import type { CondAction } from '../app/thesis';

export const OWN_CHECK = 'OWN_CHECK';
export const OWN_CHECK_PROMPT = 'own_check_v2';

/** 使用者寫的一條出場條件與選的成立時動作。 */
export interface ExitLine {
  text: string;
  action: CondAction;
}
const ACTION_TEXT: Record<CondAction, string> = { EXIT: '出清', HALF: '減半', REVIEW: '重新審查' };
const COND_ACTIONS: readonly CondAction[] = ['EXIT', 'HALF', 'REVIEW'];

export interface OwnCheckInput {
  runId: string;
  asOf: string;
  ticker: string;
  /** 使用者寫的出場條件（最多 6 條）。 */
  exits: ExitLine[];
  /** 這檔是不是已經持有（題目的寫法）。 */
  held: boolean;
  /** 現行的前提（背景，不用逐條檢查）。 */
  premises: PackPremise[];
  /** 既有的條件（你定的 C、觀察項 W；thesis.ts 的 condFacts）。 */
  condFacts: EvidencePack['facts'];
  facts: EvidencePack['facts'];
  hits: EntryHit[];
  docs: PackDoc[];
  dataQuality: EvidencePack['data_quality'];
  /** 論點的版本（記在 rule.detail）。 */
  thesisVersion: number | null;
  now: Date;
}

export function ownCheckPack(inp: OwnCheckInput) {
  if (!inp.exits.length) throw new Error('沒有要改寫的出場條件');
  const exits = inp.exits.slice(0, 6).map((e) => ({ text: e.text.trim().slice(0, 300), action: COND_ACTIONS.includes(e.action) ? e.action : 'REVIEW' }));
  const who = inp.held ? `使用者持有自選股 ${inp.ticker}` : `使用者把 ${inp.ticker} 加進自選`;
  return buildPack({
    runId: inp.runId,
    fn: OWN_CHECK,
    promptVersion: OWN_CHECK_PROMPT,
    asOf: inp.asOf,
    subject: { ticker: inp.ticker },
    question:
      `${who}，寫了 ${exits.length} 條出場條件（facts 的 U 開頭，每條附使用者選的成立時動作）。` +
      '請把每一條改寫成可追蹤的格式（payload.conditions，格式和定期審查相同），每一條寫 line（對應的 U 編號）；數字門檻要對應證據包裡的數字；改寫不了的在 report 說明。' +
      '現行的論點、前提（premises）與既有的條件（facts 的 C、W 開頭）是背景：不用逐條檢查前提，已經有的條件不要重複改寫。不要評論該不該買。',
    policy: { level: 'A1', verdicts: ['DONE', 'INSUFFICIENT'], abstain: 'INSUFFICIENT', min_evidence: 0, samples: 1 },
    rule: { action: '只提供資訊（不給買或不買的結論）', detail: { mode: 'REWRITE', lines: exits.map((e) => e.text), exits, thesisVersion: inp.thesisVersion } },
    facts: [
      ...inp.facts,
      ...exits.map((e, k) => ({ id: `U${k + 1}`, label: `使用者寫的出場條件（成立時：${ACTION_TEXT[e.action]}）`, value: e.text })),
      ...inp.condFacts,
      ...inp.hits.map((h, k) => ({ id: `H${k + 1}`, label: `硬事件掃描：${h.code}（${h.sub}）`, value: h.date ?? inp.asOf, note: h.detail })),
    ],
    premises: inp.premises,
    documents: inp.docs,
    dataQuality: inp.dataQuality,
    now: inp.now,
  });
}

const TIERS: Tier[] = ['EXIT', 'HALF', 'HOLD', 'STANDARD'];

/** 條件照 F24 的規則逐條檢查（不合格的改標人工）。 */
export function checkOwnCheckPayload(s: CheckedSample, pack: EvidencePack, metrics: ReadonlySet<string>): void {
  checkOwnReviewPayload(s, { ...pack, policy: { ...pack.policy, verdicts: TIERS } }, metrics);
}

export interface OwnCheckResult {
  /** 改寫好的條件；action 是勾選時預設的動作（對到使用者寫的那一條就用使用者選的，否則帶 AI 寫的檔位）。 */
  conditions: (ConditionDraft & { then: string; action: CondAction; from: string | null })[];
  summary: string | null;
}

const confirmOf = (kind: string, check: Record<string, unknown>): string => {
  if (kind === 'XBRL') return '新財報出來時比對';
  const by = Array.isArray(check.confirm_by) ? check.confirm_by.map(String) : [];
  return by.length && by.every((x) => x === 'earnings_call' || x === 'major_news') ? '只在定期審查時檢查' : '新申報出來時由 AI 確認';
};

/** 改寫的結果（網站顯示，讓使用者勾選）。exits：送去改寫的那幾條（證據包的 rule.detail.exits）。 */
export function ownCheckResult(outcome: Outcome | null, ticker: string, exits: ExitLine[] = []): OwnCheckResult {
  const s = outcome?.samples.find((x) => x.valid && x.verdict === 'DONE');
  if (!s) return { conditions: [], summary: outcome?.reason ?? null };
  const conditions = s.conditions
    .filter((c) => c.from === 'payload.conditions')
    .slice(0, 6)
    .map((c, k) => {
      const tier = typeof c.raw.tier_if_met === 'string' && c.raw.tier_if_met in TIER_NAME ? (c.raw.tier_if_met as Tier) : null;
      const direction = (c.raw.direction === 'UP' ? 'UP' : 'DOWN') as 'UP' | 'DOWN';
      const kind = (['XBRL', 'EVENT', 'PRICE'].includes(String(c.raw.kind)) ? c.raw.kind : 'EVENT') as ConditionDraft['kind'];
      const check = (c.raw.check ?? {}) as Record<string, unknown>;
      const line = /^U(\d+)$/.exec(String(c.raw.line ?? ''));
      const src = line ? exits[Number(line[1]) - 1] : undefined;
      const action: CondAction = src?.action ?? (direction === 'DOWN' && (tier === 'EXIT' || tier === 'HALF') ? tier : 'REVIEW');
      return {
        ticker,
        runId: '',
        condId: `U${k + 1}`,
        direction,
        kind,
        text: String(c.raw.text ?? '').slice(0, 300),
        check,
        tierIfMet: tier,
        manual: !c.auto,
        action,
        from: src?.text ?? null,
        then: c.auto ? confirmOf(kind, check) : `只記錄：${c.why ?? ''}`,
      };
    });
  return { conditions, summary: s.report?.split(/\n\s*\n/)[0]?.slice(0, 400) ?? null };
}
