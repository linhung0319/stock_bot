// T11：F7 自選慢規則減半的 AI 檢視（ai_layer_design 的 F7 卡片）。F20（持股單月跌 > 20% 的 AI 說明）T32d 拿掉（momentum_ai §3.6）。
// 純函式：證據包、payload 檢查、結論。資料抓取與排程在 src/app/dropAi.ts。
//
// F7：以最近一次 F24 為底，補上之後的新證據；程式先算好跌幅拆解（大盤、產業、個股）。
//     AI 把跌幅歸類、逐條對照前提、選一個檔位（EXIT／HALF／HOLD）。只有預設前提的股票只能選 EXIT 或 HALF（HALF 就是照規則）。
//     只有預設前提的股票（own_thesis §3.3，照舊）：結論是建議出清、同意減半、沒有可用的結論之一。
//     有論點的股票（2026-11-22 起叫「跌幅審查」，allocation_redesign §3.2）：比高點低 20% 以上只觸發審查，結論是四種之一——
//     前提不成立／前提都沒有被判不成立／票數不一致／沒跑完；只有前提不成立會讓它賣。結論寫進帳戶狀態的 dropReview。
import { DROP_CAUSE_TEXT, VERIFY_EVERY_DEFAULT, type Account, type DropStatus, type MarketView } from '../engine';
import { keptByChoice, type CheckedSample, type EvidencePack, type Outcome, type PackDoc } from './check';
import { attributionText, type Attribution } from './detect';
import { brokenPremises } from './ownReview';
import { buildPack, ownPremises, ownRuleFacts, priceDoc, priceFacts } from './pack';

export const OWN_DROP = 'OWN_DROP';
/**
 * T54：v3 多分析師找資料的步驟（web_evidence_design §1.7、§1.8）；判前提不成立的來源規則和定期審查相同（T53）。
 * T61：v4 判前提成立要有正面的引用，標準和定期審查相同（composite_layer_design §2.1）。
 * T69：v5 取完文件之後照 ai/prompts/source_rating.md 開來源評級；網頁看網域現在的級別（confirm_audit_design §1.2、§1.4）。
 * T82：v6 有論點的股票題目改寫（跌幅審查，allocation_redesign §3.2）：減半、出清要對應一條判不成立的前提，否則選不動。
 */
export const OWN_DROP_PROMPT = 'own_drop_v6';
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
  /** 新眼光這次跑不跑（T63，composite_layer_design §3：減半檢視每次都跑；只有預設前提的不跑）。沒給 = 證據包沒有這個欄位（不跑）。 */
  freshEyes?: EvidencePack['fresh_eyes'];
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
    question: noThesis
      ? `${ticker} 收盤距 52 週高點跌超過 20%，慢規則要減半（${inp.urgent ? '變動 ≥ 總資產 5%，當天通知' : '變動 < 5%，併入月報'}）。` +
        '請以最近一次定期審查為底，只看之後的新證據：把這次的跌幅歸類（大盤、產業、公司基本面、一次性事件、看不出來），逐條對照前提，' +
        '區分「論點壞了」和「價格跌了」。' +
        '這檔沒有使用者的論點，只能選照規則減半或出清：EXIT（出清）、HALF（減半，等於照規則）。拿不定主意就選 HALF（照規則）。'
      : // 有論點的股票（allocation_redesign §3.2）：跌幅只觸發審查，不是賣出的理由；減半、出清要對應一條判不成立的前提
        `${ticker} 收盤比 52 週高點低 20% 以上。這檔有使用者的論點：跌幅只觸發這次審查，本身不是賣出的理由。` +
        '請以最近一次定期審查為底，只看之後的新證據：逐條檢查使用者的前提，並判斷這次跌幅的來源（大盤、產業、公司基本面、一次性事件、看不出來）。' +
        '最後選一個檔位：HOLD（不動）、HALF（減半）、EXIT（出清）。HALF 與 EXIT 一定要對應一條你判成不成立（BROKEN）、而且有合格引用的前提；' +
        '沒有前提不成立就選 HOLD，不能因為跌得多、或跌幅來自公司自身而選 HALF。拿不定主意就選 HOLD。',
    // holds_fresh_days（T61）：判成立要指出正面的引用，而且那幾份原文不能比驗證頻率舊
    // abstain：只有預設前提的照規則（HALF）；有論點的股票規則的答案是不動（HOLD）
    policy: { level: 'A3', verdicts: noThesis ? ['EXIT', 'HALF'] : ['EXIT', 'HALF', 'HOLD'], abstain: noThesis ? 'HALF' : 'HOLD', min_evidence: 1, samples: OWN_DROP_SAMPLES, holds_fresh_days: VERIFY_EVERY_DEFAULT },
    // attr：程式算的跌幅拆解（從 52 週高點那天到今天）。有論點的股票只顯示、不核對（allocation_redesign §3.2）；
    // 個股自身不超過整段一半的核對（idioWithinHalf）留給下跌加碼用（§4.4）
    rule: { action: noThesis ? '減半（賣掉一半）' : '不動（跌幅只觸發審查；3 票判同一條前提不成立才減半）', detail: { urgent: inp.urgent, baseReview: inp.baseRunId, attr: inp.attr ? { stock: inp.attr.stock, market: inp.attr.market, sector: inp.attr.sector, idio: inp.attr.idio } : null } },
    facts: [...priceFacts(view, ticker), ...ownRuleFacts(acct, view, ticker), ...attrFacts(inp.attr), ...(inp.extraFacts ?? [])],
    premises: ownPremises(acct, ticker),
    documents: [inp.base, ...inp.docs, priceDoc(view, inp.axis, ticker, 120), ...(inp.extraDocs ?? [])].filter((d): d is PackDoc => !!d),
    dataQuality: inp.dataQuality,
    freshEyes: inp.freshEyes,
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
  // 有論點的股票（verdicts 有 HOLD；own_drop_v6）：減半、出清要對應一條判不成立的前提。只記下來，不改這一票——程式的結論看的是前提（dropDecision）
  if (pack.function === OWN_DROP && pack.policy.verdicts.includes('HOLD') && (s.rawVerdict === 'HALF' || s.rawVerdict === 'EXIT') && !s.premises.some((x) => x.status === 'BROKEN')) {
    s.issues.push(`選了 ${s.rawVerdict}，但沒有一條前提判成不成立（或引用沒有通過檢查）`);
  }
  if (p.escalate_to_F19 === true && !['PENDING_MA', 'ACCOUNTING', 'REGULATORY'].includes(String(p.escalate_code))) {
    s.issues.push('轉交 F19 要寫 escalate_code（PENDING_MA、ACCOUNTING、REGULATORY），不轉交');
    s.payload = { ...(s.payload ?? {}), escalate_to_F19: false };
  }
}

export interface DropDecision {
  /**
   * 只有預設前提的股票：建議出清 EXIT／同意減半 AGREE／沒有可用的結論 NONE。
   * 有論點的股票（跌幅審查的四種）：前提不成立 BROKEN／都沒有被判不成立 CLEAR／票數不一致 SPLIT／沒跑完 NONE。
   * （PENDING 是還沒有結果，不會從這裡出來。）
   */
  status: Exclude<DropStatus, 'PENDING' | 'HOLD'>;
  /** 有論點的股票的跌幅審查（verdicts 有 HOLD）。 */
  thesis: boolean;
  /** 和結論同檔位的第一張合格票的 cause_class。 */
  cause: string | null;
  /** 不成立的那條前提（有多條取編號最小的）：EXIT、BROKEN 才有。 */
  premiseId: string | null;
  /** BROKEN：3 票都選出清。 */
  exit: boolean;
  /** SPLIT：最多票判不成立的那條前提與票數（沒有任何一票判不成立時是 null、0）。 */
  splitPremise: string | null;
  splitVotes: number;
  /** 轉交硬事件法庭的代碼（和上面的結果無關）。 */
  escalate: string | null;
  why: string;
}

/**
 * 跌幅拆解的程式核對：拆解算得出來、個股是跌的、個股自身的跌幅不超過整段跌幅的一半。
 * 2026-11-22 起跌幅審查的結論不再用它（allocation_redesign §3.2：它擋的正是使用者決定接受的情況）；留給下跌加碼（§4.4）。
 */
export function idioWithinHalf(attr: { stock?: unknown; idio?: unknown } | null | undefined): boolean {
  if (!attr || typeof attr.stock !== 'number' || typeof attr.idio !== 'number' || !Number.isFinite(attr.stock) || !Number.isFinite(attr.idio)) return false;
  return attr.stock < 0 && attr.idio >= 0.5 * attr.stock;
}

/**
 * 減半檢視／跌幅審查的結論。
 *
 * 只有預設前提的股票（verdicts 沒有 HOLD；own_thesis §3.3，照舊）：
 *   EXIT  三票都選出清、資料沒有缺漏，而且有一條「不成立的前提」（三票都判同一條 BROKEN、每一票都有合格的引用；定義同 §1.6 第 1 點，
 *         合格的來源照 web_evidence_design §1.6——T53 起和定期審查同一個函式 brokenPremises）
 *   AGREE 三票都選減半（每一票都是自己選的，不是被檢查降級或補上的）
 *   NONE  其餘：票數不一致、三票出清但沒過上面的條件、資料缺漏、不合格、逾時、被退回
 *
 * 有論點的股票（allocation_redesign §3.2 的四種；D2：只有前提不成立會讓它賣）：
 *   NONE   沒跑完：票沒到齊、有不合格的票、逾時、被退回、資料缺漏 → 不動並重派
 *   BROKEN 前提不成立：三票都判同一條 BROKEN、每一票都有合格的引用（不看三票選的檔位）；三票都選出清時 exit = true
 *   CLEAR  前提都沒有被判不成立：沒有任何一票把任何前提判成不成立（被引用檢查降級的也算判過），而且三票都選不動。不看跌幅的歸類，也不核對跌幅拆解
 *   SPLIT  票數不一致：跑完了，但對「哪一條前提不成立」沒有共識（只有 1、2 票判、各判不同的前提、引用沒過檢查），或沒有人判不成立但檔位不一致
 */
export function dropDecision(outcome: Outcome, pack: Pick<EvidencePack, 'documents' | 'rule' | 'policy'>): DropDecision {
  const valid = outcome.samples.filter((x) => x.valid);
  const s = valid.find((x) => x.verdict === outcome.verdict);
  const cause = (s?.payload?.cause_class as string) ?? null;
  const escalate = outcome.samples.length && outcome.samples.every((x) => x.valid && x.payload?.escalate_to_F19 === true) ? String(s?.payload?.escalate_code) : null;
  const wanted = pack.policy.samples;
  const thesis = pack.policy.verdicts.includes('HOLD');
  const out = (status: DropDecision['status'], why: string, extra: Partial<Pick<DropDecision, 'premiseId' | 'exit' | 'splitPremise' | 'splitVotes'>> = {}): DropDecision => ({ status, thesis, cause, premiseId: null, exit: false, splitPremise: null, splitVotes: 0, escalate, why, ...extra });
  if (thesis) {
    if (outcome.samples.length < wanted || valid.length < outcome.samples.length) return out('NONE', outcome.samples.length ? `沒跑完：${wanted} 票裡只有 ${valid.length} 票合格。` : outcome.reason);
    const missing = [...new Set(valid.flatMap((x) => x.dataMissing))];
    if (missing.length) return out('NONE', `沒跑完：資料有缺漏（${missing.join('、')}）。`);
    const broken = brokenPremises(valid, pack, wanted);
    if (broken.length) {
      const exit = valid.every((x) => x.verdict === 'EXIT');
      return out('BROKEN', `${wanted} 票都判前提 ${broken[0]} 不成立（每一票都有合格的引用）${exit ? '，而且都選出清' : ''}。`, { premiseId: broken[0], exit });
    }
    // 每條前提有幾票判不成立（被引用檢查降級的也算判過）
    const flagged = new Map<string, number>();
    for (const x of valid) for (const id of new Set(x.premises.filter((p) => p.status === 'BROKEN' || p.downgradedFrom === 'BROKEN').map((p) => p.premise_id))) flagged.set(id, (flagged.get(id) ?? 0) + 1);
    if (!flagged.size && valid.every((x) => x.verdict === 'HOLD')) return out('CLEAR', `${wanted} 票一致：沒有任何前提被判不成立。`);
    const top = [...flagged.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'en', { numeric: true }))[0];
    return out('SPLIT', top ? `${wanted} 票裡有 ${top[1]} 票認為前提 ${top[0]} 不成立，沒有一致結論（要 ${wanted} 票都判同一條、每一票都有合格的引用）。` : `沒有任何一票判前提不成立，但 ${wanted} 票的檔位不一致。`, top ? { splitPremise: top[0], splitVotes: top[1] } : {});
  }
  if (outcome.samples.length === wanted && keptByChoice('HALF', outcome.samples, wanted)) return out('AGREE', `${wanted} 票都選減半：同意照規則。`);
  if (outcome.status !== 'AGREED' || valid.length < wanted) return out('NONE', outcome.reason);
  if (outcome.verdict === 'EXIT') {
    const broken = brokenPremises(valid, pack, wanted);
    return broken.length ? out('EXIT', `${wanted} 票都選出清，而且都判前提 ${broken[0]} 不成立（每一票都有合格的引用）。`, { premiseId: broken[0] }) : out('NONE', `${wanted} 票都選出清，但沒有一條前提三票都判「不成立」而且有合格的引用（申報、財報表，或清單內的網頁），照規則。`);
  }
  return out('NONE', outcome.reason);
}
