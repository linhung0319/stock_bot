// T11：F7 自選慢規則減半的 AI 檢視（ai_layer_design 的 F7 卡片）。F20（持股單月跌 > 20% 的 AI 說明）T32d 拿掉（momentum_ai §3.6）。
// 純函式：證據包、payload 檢查、結論。資料抓取與排程在 src/app/dropAi.ts。
//
// F7：以最近一次 F24 為底，補上之後的新證據；程式先算好跌幅拆解（大盤、產業、個股）。
//     AI 把跌幅歸類、逐條對照前提、選一個檔位（EXIT／HALF／HOLD；HALF 就是照規則）。只有預設前提的股票只能選 EXIT 或 HALF。
//     結論是五種之一（own_thesis §3.3）：建議出清、建議不動、同意減半、沒有可用的結論、還沒有結果；寫進帳戶狀態的 dropReview。
import { DROP_CAUSE_TEXT, type Account, type DropStatus, type MarketView } from '../engine';
import { keptByChoice, type CheckedSample, type EvidencePack, type Outcome, type PackDoc } from './check';
import { attributionText, type Attribution } from './detect';
import { brokenPremises } from './ownReview';
import { buildPack, ownPremises, ownRuleFacts, priceDoc, priceFacts } from './pack';

export const OWN_DROP = 'OWN_DROP';
export const OWN_DROP_PROMPT = 'own_drop_v2';
/** F7 獨立跑幾次。 */
export const OWN_DROP_SAMPLES = 3;

export const CAUSE_CLASSES = ['MARKET', 'SECTOR', 'FUNDAMENTAL', 'ONE_OFF', 'UNKNOWN'] as const;
export const CAUSE_TEXT: Record<string, string> = DROP_CAUSE_TEXT;

/** 跌幅拆解的數字 A1～A5（F7、價格類的提前審查共用）。 */
export const attrFacts = (a: Attribution | null): EvidencePack['facts'] =>
  a
    ? [
        { id: 'A1', label: `跌幅拆解（${a.from}～${a.to}）`, value: attributionText(a), note: '簡單相減：大盤 = 核心 ETF；產業 = 產業 ETF − 大盤；個股自身 = 個股 − 產業（沒有產業 ETF 時減大盤）' },
        { id: 'A2', label: '個股', value: `${(a.stock * 100).toFixed(1)}%` },
        { id: 'A3', label: '大盤', value: `${(a.market * 100).toFixed(1)}%` },
        ...(a.sector === null ? [] : [{ id: 'A4', label: `產業（${a.sectorTicker}）比大盤`, value: `${(a.sector * 100).toFixed(1)}%` }]),
        { id: 'A5', label: '個股自身', value: `${(a.idio * 100).toFixed(1)}%` },
      ]
    : [];

export interface OwnDropInput {
  acct: Account;
  view: MarketView;
  axis: string[];
  ticker: string;
  runId: string;
  attr: Attribution | null;
  /** 最近一次 F24 的摘要（前提逐條、檔位）。 */
  base: PackDoc | null;
  baseRunId: string | null;
  /** 上次 F24 之後的新申報與新聞標題。 */
  docs: PackDoc[];
  /** 這次減半的通知是當天（≥ 5%）還是併入月報。 */
  urgent: boolean;
  dataQuality: EvidencePack['data_quality'];
  /** 由論點檔組的數字（T0、事件 V、預設前提的 D1～D3；own_thesis §3.3），接在原本的數字後面。 */
  extraFacts?: EvidencePack['facts'];
  /** 由論點檔組的原文（論點那一份 note），放在最後。 */
  extraDocs?: PackDoc[];
  now: Date;
}

/** 只有系統預設前提（使用者還沒有自己的論點）。 */
const onlyDefault = (acct: Account, ticker: string) => (acct.own[ticker]?.premises ?? []).every((p) => p.origin === 'SYSTEM_DEFAULT');

export function ownDropPack(inp: OwnDropInput) {
  const { acct, view, ticker } = inp;
  // 只有預設前提的股票只能選減半或出清（own_thesis §3.3，使用者 2026-11-15 決定：AI 能對底線提異議，是因為它檢查了使用者的論點）
  const noThesis = onlyDefault(acct, ticker);
  return buildPack({
    runId: inp.runId,
    fn: OWN_DROP,
    promptVersion: OWN_DROP_PROMPT,
    asOf: view.date,
    subject: { ticker },
    question:
      `${ticker} 收盤距 52 週高點跌超過 20%，慢規則要減半（${inp.urgent ? '變動 ≥ 總資產 5%，當天通知' : '變動 < 5%，併入月報'}）。` +
      '請以最近一次定期審查為底，只看之後的新證據：把這次的跌幅歸類（大盤、產業、公司基本面、一次性事件、看不出來），逐條對照使用者的前提，' +
      '區分「論點壞了」和「價格跌了」。' +
      (noThesis
        ? '這檔沒有使用者的論點，只能選照規則減半或出清：EXIT（出清）、HALF（減半，等於照規則）。拿不定主意就選 HALF（照規則）。'
        : '最後選一個檔位：EXIT（出清）、HALF（減半，等於照規則）、HOLD（不動）。拿不定主意就選 HALF（照規則）。'),
    policy: { level: 'A3', verdicts: noThesis ? ['EXIT', 'HALF'] : ['EXIT', 'HALF', 'HOLD'], abstain: 'HALF', min_evidence: 1, samples: OWN_DROP_SAMPLES },
    // attr：程式算的跌幅拆解（從 52 週高點那天到今天），結論是「不動」時拿來核對（dropDecision）
    rule: { action: '減半（賣掉一半）', detail: { urgent: inp.urgent, baseReview: inp.baseRunId, attr: inp.attr ? { stock: inp.attr.stock, market: inp.attr.market, sector: inp.attr.sector, idio: inp.attr.idio } : null } },
    facts: [...priceFacts(view, ticker), ...ownRuleFacts(acct, view, ticker), ...attrFacts(inp.attr), ...(inp.extraFacts ?? [])],
    premises: ownPremises(acct, ticker),
    documents: [inp.base, ...inp.docs, priceDoc(view, inp.axis, ticker, 120), ...(inp.extraDocs ?? [])].filter((d): d is PackDoc => !!d),
    dataQuality: inp.dataQuality,
    now: inp.now,
  });
}

/** F7：cause_class 在列舉內；tier 和 verdict 一致。 */
export function checkDropPayload(s: CheckedSample, pack: EvidencePack): void {
  const p = s.payload ?? {};
  if (!CAUSE_CLASSES.includes(p.cause_class as never)) {
    s.issues.push(`cause_class（${String(p.cause_class)}）不在列舉內，當成 UNKNOWN`);
    s.payload = { ...p, cause_class: 'UNKNOWN' };
  }
  if (pack.function === OWN_DROP && p.tier !== undefined && p.tier !== s.rawVerdict) s.issues.push(`payload.tier（${String(p.tier)}）和 verdict 不同`);
  if (p.escalate_to_F19 === true && !['PENDING_MA', 'ACCOUNTING', 'REGULATORY'].includes(String(p.escalate_code))) {
    s.issues.push('轉交 F19 要寫 escalate_code（PENDING_MA、ACCOUNTING、REGULATORY），不轉交');
    s.payload = { ...(s.payload ?? {}), escalate_to_F19: false };
  }
}

export interface DropDecision {
  /** 建議不動／建議出清／同意減半／沒有可用的結論（PENDING 是還沒有結果，不會從這裡出來）。 */
  status: Exclude<DropStatus, 'PENDING'>;
  /** 和結論同檔位的第一張合格票的 cause_class。 */
  cause: string | null;
  /** 建議出清時：不成立的那條前提（有多條取編號最小的）。 */
  premiseId: string | null;
  /** 轉交硬事件法庭的代碼（和上面的結果無關）。 */
  escalate: string | null;
  why: string;
}

/** 「不動」的程式核對：拆解算得出來、個股是跌的、個股自身的跌幅不超過整段跌幅的一半。 */
export function idioWithinHalf(attr: { stock?: unknown; idio?: unknown } | null | undefined): boolean {
  if (!attr || typeof attr.stock !== 'number' || typeof attr.idio !== 'number' || !Number.isFinite(attr.stock) || !Number.isFinite(attr.idio)) return false;
  return attr.stock < 0 && attr.idio >= 0.5 * attr.stock;
}

/**
 * F7 的結論（own_thesis §3.3，修 K4）：
 *   EXIT  三票都選出清、資料沒有缺漏，而且有一條「不成立的前提」（三票都判同一條 BROKEN、每一票都有合格的引用；定義同 §1.6 第 1 點，
 *         合格的來源照 web_evidence_design §1.6：申報原文、財報表，或分析師取回的清單內網頁——T53 起和定期審查同一個函式 brokenPremises）
 *   HOLD  三票都選不動、資料沒有缺漏；三票的歸類都是大盤或產業；沒有任何一票把任何前提判成不成立（被引用檢查降級的也算判過）；
 *         而且程式核對跌幅拆解：個股是跌的、個股自身的跌幅不超過整段跌幅的一半
 *   AGREE 三票都選減半（每一票都是自己選的，不是被檢查降級或補上的）
 *   NONE  其餘：票數不一致、三票出清或不動但沒過上面的條件、資料缺漏、不合格、逾時、被退回
 */
export function dropDecision(outcome: Outcome, pack: Pick<EvidencePack, 'documents' | 'rule' | 'policy'>): DropDecision {
  const valid = outcome.samples.filter((x) => x.valid);
  const s = valid.find((x) => x.verdict === outcome.verdict);
  const cause = (s?.payload?.cause_class as string) ?? null;
  const escalate = outcome.samples.length && outcome.samples.every((x) => x.valid && x.payload?.escalate_to_F19 === true) ? String(s?.payload?.escalate_code) : null;
  const out = (status: DropDecision['status'], why: string, premiseId: string | null = null): DropDecision => ({ status, cause, premiseId, escalate, why });
  const wanted = pack.policy.samples;
  if (outcome.samples.length === wanted && keptByChoice('HALF', outcome.samples, wanted)) return out('AGREE', `${wanted} 票都選減半：同意照規則。`);
  if (outcome.status !== 'AGREED' || valid.length < wanted) return out('NONE', outcome.reason);
  if (outcome.verdict === 'EXIT') {
    const broken = brokenPremises(valid, pack, wanted);
    return broken.length ? out('EXIT', `${wanted} 票都選出清，而且都判前提 ${broken[0]} 不成立（每一票都有合格的引用）。`, broken[0]) : out('NONE', `${wanted} 票都選出清，但沒有一條前提三票都判「不成立」而且有合格的引用（申報、財報表，或清單內的網頁），照規則。`);
  }
  if (outcome.verdict === 'HOLD' && pack.policy.verdicts.includes('HOLD')) {
    if (!valid.every((x) => x.payload?.cause_class === 'MARKET' || x.payload?.cause_class === 'SECTOR')) return out('NONE', `${wanted} 票都選不動，但跌幅的歸類不是每一票都是大盤或產業，照規則。`);
    if (valid.some((x) => x.premises.some((p) => p.status === 'BROKEN' || p.downgradedFrom === 'BROKEN'))) return out('NONE', `${wanted} 票都選不動，但有一票把前提判成不成立，照規則。`);
    const attr = (pack.rule.detail as { attr?: { stock?: unknown; idio?: unknown } | null } | undefined)?.attr;
    if (!idioWithinHalf(attr)) return out('NONE', `${wanted} 票都選不動，但程式算的跌幅拆解不支持（個股自身的跌幅超過整段的一半，或拆解算不出來），照規則。`);
    return out('HOLD', `${wanted} 票都選不動：跌幅主要是${cause === 'MARKET' ? '大盤' : '產業'}一起跌，沒有前提被判不成立。`);
  }
  return out('NONE', outcome.reason);
}
