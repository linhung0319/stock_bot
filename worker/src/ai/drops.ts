// T11：F7 自選慢規則減半的 AI 檢視、F20 持股單月跌 > 20%（任務 C）（ai_layer_design 的 F7、F20 卡片；design_v2 §6.4）。
// 純函式：證據包、payload 檢查、結論。資料抓取與排程在 src/app/dropAi.ts。
//
// F7：以最近一次 F24 為底，補上之後的新證據；程式先算好跌幅拆解（大盤、產業、個股）。
//     AI 把跌幅歸類、逐條對照前提、選一個檔位（EXIT／HALF／HOLD；HALF 就是照規則）。3 票一致才更新清單上的「AI 建議」那一行。
// F20：只說明（A1、一票）：跌幅拆解＋原因；找到硬事件就轉交 F19。說明附在下一次月報。
import type { Account, MarketView } from '../engine';
import type { CheckedSample, EvidencePack, Outcome, PackDoc } from './check';
import { attributionText, type Attribution } from './detect';
import { buildPack, ownPremises, ownRuleFacts, priceDoc, priceFacts } from './pack';

export const OWN_DROP = 'OWN_DROP';
export const OWN_DROP_PROMPT = 'own_drop_v1';
export const DROP_EXPLAIN = 'DROP_EXPLAIN';
export const DROP_EXPLAIN_PROMPT = 'drop_explain_v1';

export const CAUSE_CLASSES = ['MARKET', 'SECTOR', 'FUNDAMENTAL', 'ONE_OFF', 'UNKNOWN'] as const;
export const CAUSE_TEXT: Record<string, string> = { MARKET: '大盤一起跌', SECTOR: '產業一起跌', FUNDAMENTAL: '公司基本面', ONE_OFF: '一次性事件', UNKNOWN: '看不出原因' };

const attrFacts = (a: Attribution | null): EvidencePack['facts'] =>
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
  now: Date;
}

export function ownDropPack(inp: OwnDropInput) {
  const { acct, view, ticker } = inp;
  return buildPack({
    runId: inp.runId,
    fn: OWN_DROP,
    promptVersion: OWN_DROP_PROMPT,
    asOf: view.date,
    subject: { ticker },
    question:
      `${ticker} 收盤距 52 週高點跌超過 20%，慢規則要減半（${inp.urgent ? '變動 ≥ 總資產 5%，當天通知' : '變動 < 5%，併入月報'}）。` +
      '請以最近一次定期審查為底，只看之後的新證據：把這次的跌幅歸類（大盤、產業、公司基本面、一次性事件、看不出來），逐條對照使用者的前提，' +
      '區分「論點壞了」和「價格跌了」。最後選一個檔位：EXIT（出清）、HALF（減半，等於照規則）、HOLD（不動）。拿不定主意就選 HALF（照規則）。',
    policy: { level: 'A3', verdicts: ['EXIT', 'HALF', 'HOLD'], abstain: 'HALF', min_evidence: 1, samples: 3 },
    rule: { action: '減半（賣掉一半）', detail: { urgent: inp.urgent, baseReview: inp.baseRunId } },
    facts: [...priceFacts(view, ticker), ...ownRuleFacts(acct, view, ticker), ...attrFacts(inp.attr)],
    premises: ownPremises(acct, ticker),
    documents: [inp.base, ...inp.docs, priceDoc(view, inp.axis, ticker, 120)].filter((d): d is PackDoc => !!d),
    dataQuality: inp.dataQuality,
    now: inp.now,
  });
}

/** F7、F20 共用：cause_class 在列舉內；F7 的 tier 和 verdict 一致。 */
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

/** F7 的結論：3 票一致、和規則（HALF）不同才更新「AI 建議」。 */
export function dropDecision(outcome: Outcome): { tier: 'EXIT' | 'HOLD' | null; cause: string | null; escalate: string | null; why: string } {
  const s = outcome.samples.find((x) => x.valid && x.verdict === outcome.verdict);
  const cause = (s?.payload?.cause_class as string) ?? null;
  const escalate = outcome.samples.length && outcome.samples.every((x) => x.valid && x.payload?.escalate_to_F19 === true) ? String(s?.payload?.escalate_code) : null;
  if (!outcome.actionable || (outcome.verdict !== 'EXIT' && outcome.verdict !== 'HOLD')) return { tier: null, cause, escalate, why: outcome.reason };
  return { tier: outcome.verdict, cause, escalate, why: outcome.reason };
}

// ---------------------------------------------------------------- F20

export interface DropExplainInput {
  view: MarketView;
  axis: string[];
  ticker: string;
  role: 'OWN' | 'MOM';
  runId: string;
  ret21: number;
  attr: Attribution | null;
  docs: PackDoc[];
  dataQuality: EvidencePack['data_quality'];
  now: Date;
}

export const MONTH_DROP = -0.2;

export function dropExplainPack(inp: DropExplainInput) {
  const { view, ticker } = inp;
  return buildPack({
    runId: inp.runId,
    fn: DROP_EXPLAIN,
    promptVersion: DROP_EXPLAIN_PROMPT,
    asOf: view.date,
    subject: { ticker },
    question:
      `${ticker}（${inp.role === 'OWN' ? '自選' : '動能'}持股）最近 21 個交易日跌 ${(inp.ret21 * -100).toFixed(1)}%。` +
      '請用兩三句話說明原因：先看程式算好的跌幅拆解，再看申報與新聞標題。只寫證據包裡有的事，不寫該不該賣。' +
      '如果原文顯示有被收購、會計問題或重大監管事件，payload.escalate_to_F19 = true 並寫 escalate_code。',
    policy: { level: 'A1', verdicts: ['EXPLAINED', 'INSUFFICIENT'], abstain: 'INSUFFICIENT', min_evidence: 0, samples: 1 },
    rule: { action: '規則沒有動作（只說明，附在下一次月報）', detail: { ret21: inp.ret21, role: inp.role } },
    facts: [...priceFacts(view, ticker), { id: 'D1', label: '最近 21 個交易日', value: `${(inp.ret21 * 100).toFixed(1)}%` }, ...attrFacts(inp.attr)],
    documents: [...inp.docs, priceDoc(view, inp.axis, ticker, 60)].filter((d): d is PackDoc => !!d),
    dataQuality: inp.dataQuality,
    now: inp.now,
  });
}

/** F20 的一句話說明（附在月報）。 */
export function explainLine(ticker: string, ret21: number, outcome: Outcome | null): string {
  const s = outcome?.samples.find((x) => x.valid);
  const cause = s?.payload?.cause_class ? CAUSE_TEXT[String(s.payload.cause_class)] : null;
  const summary = s?.payload?.summary && typeof s.payload.summary === 'string' ? s.payload.summary.slice(0, 160) : null;
  return `${ticker} 最近一個月跌 ${(ret21 * -100).toFixed(0)}%${cause ? `：${cause}` : ''}${summary ? `。${summary}` : ''}（AI 說明，詳見網站）`;
}
