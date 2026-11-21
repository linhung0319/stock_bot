// F14：出場條件改寫（own_thesis §1.8 確認的第 2 點；T27 起只留改寫模式，「請 AI 草擬前提」拿掉，§1.12）。
// 權限 A1：只提供資訊，不給「買／不買」的結論。
//   使用者在「編輯論點」頁寫的出場條件（每條帶使用者選的成立時動作）→ AI 改寫成可追蹤的格式（財報門檻、申報事件；價格只記錄），
//   使用者在持股頁勾選後才監測。題目對已持有的股票與新加入的都成立；證據包帶現行的論點、前提與既有的條件（P7）。
//   規則數字（距高點、200 日均線、波動度、建議標準比重）、硬事件掃描（F1 的規則偵測段）、和既有持股的相關性：程式算好。
import { TIER_NAME, type Tier } from '../engine';
import type { CheckedSample, EvidencePack, Outcome, PackDoc, PackPremise } from './check';
import type { EntryHit } from './momEntry';
import { checkOwnReviewPayload, confirmMode, namedWebDomains, webConfirmText, type ConditionDraft } from './ownReview';
import { buildPack } from './pack';
import type { WebRatingRow } from '../data/webSources';
import type { CondAction } from '../app/thesis';

export const OWN_CHECK = 'OWN_CHECK';
export const OWN_CHECK_PROMPT = 'own_check_v5';

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
  /** 證據包的條件編號（C1、W1…）→ own_conditions 的列編號（T40：改寫寫了 supersedes 時換成列編號；記在 rule.detail）。 */
  condMap?: Record<string, number>;
  /**
   * 出場條件整組取代（T42，記在 rule.detail）：exitsVersion = 這組出場條件是第幾版論點存的；
   * live = 存檔時監測中的條件（確認後撤下的範圍）；sameByText = 文字和監測中的一條相同的 U（U1 → 列編號，AI 沒標 same 時的後備）。
   */
  exitsVersion?: number | null;
  live?: number[];
  sameByText?: Record<string, number>;
  /**
   * 可以指名的網頁來源（T53，web_evidence_design §1.6）：facts 的 S 開頭那幾行與網域清單（webEvidence.ts 的 sourceFacts）；
   * 事件條件的確認來源可以寫 `web:<網域>`，只能指名這些。只有系統預設前提的股票不給（它的審查不用網頁證據）。記在 rule.detail.webDomains。
   */
  sources?: { facts: EvidencePack['facts']; domains: string[] };
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
      'U 是使用者這次要的全部出場條件（整組取代 facts 的 C 開頭：目前監測中的條件）。每一條 U 都要標出和既有條件的關係：' +
      '和某條 C 是同一件事、門檻也一樣 → 寫 same（那條 C 的編號），不會新增、舊的保留；是在更新某條 C 或 W（例如門檻改了）→ 寫 supersedes（被更新的編號），使用者確認後舊的撤下；都不是就兩個都不寫（新的）。' +
      '沒有被任何 U 標成 same 或 supersedes 的 C，使用者確認後會撤下。現行的論點、前提（premises）是背景：不用逐條檢查前提。不要評論該不該買。' +
      (inp.sources?.domains.length ? '使用者的條件寫明要看某個產業來源或公司新聞室、而那個來源在 facts 的 S 開頭裡時，確認來源寫 web:<網域>（只能指名 S 列出的網域）。' : ''),
    policy: { level: 'A1', verdicts: ['DONE', 'INSUFFICIENT'], abstain: 'INSUFFICIENT', min_evidence: 0, samples: 1 },
    rule: {
      action: '只提供資訊（不給買或不買的結論）',
      detail: {
        mode: 'REWRITE',
        lines: exits.map((e) => e.text),
        exits,
        thesisVersion: inp.thesisVersion,
        ...(inp.condMap && Object.keys(inp.condMap).length ? { condMap: inp.condMap } : {}),
        ...(inp.exitsVersion !== undefined && inp.exitsVersion !== null ? { exitsVersion: inp.exitsVersion, live: inp.live ?? [], sameByText: inp.sameByText ?? {} } : {}),
        ...(inp.sources?.domains.length ? { webDomains: inp.sources.domains } : {}),
      },
    },
    facts: [
      ...inp.facts,
      ...exits.map((e, k) => ({ id: `U${k + 1}`, label: `使用者要的出場條件（整組取代目前監測中的；成立時：${ACTION_TEXT[e.action]}）`, value: e.text })),
      ...inp.condFacts,
      ...(inp.sources?.facts ?? []),
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
  /**
   * 改寫好的條件；action 是勾選時預設的動作（對到使用者寫的那一條就用使用者選的，否則帶 AI 寫的檔位）。
   * supersedes：AI 認為這條是在更新哪一條既有條件（own_conditions 的列編號，T40）；沒有或對不到是 null。
   * same（T42）：和哪一條監測中的條件是同一件事（列編號）：不新增、舊的保留。AI 寫的 same，或文字和那一條相同（程式的後備）。
   * line：對到使用者寫的第幾條（0 起；對不到是 null）。
   */
  /** web（T53）：這條指名的網頁來源（網域）。T68 起勾選時不能改來源（選單拿掉）。 */
  conditions: (ConditionDraft & { then: string; action: CondAction; from: string | null; supersedes: number | null; same: number | null; line: number | null; web: string[] })[];
  summary: string | null;
}

const confirmOf = (kind: string, check: Record<string, unknown>, ratings?: ReadonlyMap<string, WebRatingRow> | null): string => {
  if (kind === 'XBRL') return '新財報出來時比對';
  const web = webConfirmText(check, ratings);
  if (confirmMode({ kind, check }) === 'REVIEW_ONLY') return web ?? '只在定期審查時檢查';
  return web ? `新申報出來時由 AI 確認；${web.replace('審查時用', '審查時也用')}` : '新申報出來時由 AI 確認';
};

/**
 * 改寫的結果（網站顯示，讓使用者勾選）。exits：送去改寫的那幾條（證據包的 rule.detail.exits）；
 * condMap：證據包的條件編號 → 列編號（rule.detail.condMap，T40），把 supersedes、same 換成列編號；
 * sameByText：文字和監測中的一條相同的 U（rule.detail.sameByText，T42）：AI 沒標 same、也沒標 supersedes 時當成 same。
 * live：same 只認這幾條（存檔時監測中的；沒給 = 不限）。ratings（T68）：評級表，「成立時怎麼確認」的來源後面加級別。
 */
export function ownCheckResult(outcome: Outcome | null, ticker: string, exits: ExitLine[] = [], condMap: Record<string, number> = {}, sameByText: Record<string, number> = {}, live: number[] | null = null, ratings?: ReadonlyMap<string, WebRatingRow> | null): OwnCheckResult {
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
      const sup = typeof c.raw.supersedes === 'string' ? c.raw.supersedes.trim().toUpperCase() : '';
      const supId = sup && condMap[sup] ? condMap[sup] : null;
      // same（T42）：只認證據包的 C（監測中的你定的條件）；AI 沒標時，文字和監測中的一條相同的 U 當成 same
      const sm = typeof c.raw.same === 'string' ? c.raw.same.trim().toUpperCase() : '';
      const okLive = (id: number | undefined) => (id && (!live || live.includes(id)) ? id : null);
      const aiSame = sm.startsWith('C') ? okLive(condMap[sm]) : null;
      const same = aiSame ?? (supId === null && line ? okLive(sameByText[`U${line[1]}`]) : null);
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
        supersedes: same === null ? supId : null,
        same,
        line: src ? Number(line![1]) - 1 : null,
        then: c.auto ? confirmOf(kind, check, ratings) : `只記錄：${c.why ?? ''}`,
        web: c.auto && kind === 'EVENT' ? namedWebDomains(check) : [],
      };
    });
  return { conditions, summary: s.report?.split(/\n\s*\n/)[0]?.slice(0, 400) ?? null };
}
