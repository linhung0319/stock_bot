// T11：F1 動能新股進場（任務 A：否決法庭）與擬事件打分（ai_layer_design F1 卡片、§2.5；design_v2 §6.2、§2.4；B-9 §7.4）。
// 純函式：候選順序與遞補、規則偵測的結論、法庭的證據包與檢查、擬事件打分。資料抓取與排程在 src/app/momAi.ts。
//
// 規則偵測（不用 LLM）：
//   被收購方（PREM14A／DEFM14A／SC TO-T／SC 14D9 的被收購方）、NT 10-K／10-Q → 規則直接否決
//   價格日變動 > 25% 而前後一天沒有申報 → 資料可疑，這個月不進場（不是否決，是資料檢查）
//   8-K 4.02、會計師辭任、單日漲幅占比、盈餘背離、每日掃描標記的監管或會計候選 → 開法庭（3 票一致才否決）
//   增資（424B 普通股／可轉債、股數 6 個月增加 > 5%）→ 只顯示，准許但觀察（2026-11-11 決定，不能單獨否決）
//   什麼都沒命中 → 准許（寫一句模板說明，不呼叫 LLM；設計 §10 第 34 點）
// 預設是准許：法庭沒有結論、票數不一致、來不及審，一律照規則准許。
import type { CheckedSample, EvidencePack, Outcome, PackDoc, PackPremise } from './check';
import { buildPack, priceDoc, priceFacts } from './pack';
import type { MarketView } from '../engine';

export const MOM_ENTRY = 'MOM_ENTRY';
export const MOM_ENTRY_PROMPT = 'mom_entry_v1';
export const MOM_SCORE = 'MOM_SCORE';
export const MOM_SCORE_PROMPT = 'mom_score_v1';

/** 可以否決的代碼（DILUTION 2026-11-11 起只顯示）。估值、情緒、漲太多都不算。 */
export const VETO_CODES = ['EARNINGS_DIVERGENCE', 'ONE_OFF_JUMP', 'PENDING_MA', 'ACCOUNTING', 'REGULATORY'] as const;
export const ALL_CODES = [...VETO_CODES, 'DILUTION'] as const;

export type EntryDecision = 'ALLOW' | 'ALLOW_WATCH' | 'VETO' | 'BLOCK' | 'PENDING';

export interface EntryHit {
  code: string;
  sub: string;
  detail: string;
  date?: string;
  /** 規則就能下結論。 */
  byRule: boolean;
  displayOnly?: boolean;
  /** 原文的來源（申報編號），法庭要讀的。 */
  accession?: string;
}

export interface RuleVerdict {
  decision: EntryDecision | 'COURT';
  reasonCode: string | null;
  watchReason: string | null;
  note: string;
}

/** 規則偵測的命中 → 規則能下的結論；要法庭的回 COURT。 */
export function entryRuleVerdict(hits: EntryHit[]): RuleVerdict {
  const veto = hits.find((h) => h.byRule && !h.displayOnly && (h.code === 'PENDING_MA' || h.code === 'ACCOUNTING'));
  if (veto) return { decision: 'VETO', reasonCode: veto.code, watchReason: null, note: `規則直接否決：${veto.detail}` };
  const sus = hits.find((h) => h.code === 'DATA_SUSPECT');
  if (sus) return { decision: 'BLOCK', reasonCode: null, watchReason: null, note: `價格資料可疑，這個月不進場：${sus.detail}` };
  const court = hits.filter((h) => !h.byRule && !h.displayOnly);
  const dil = hits.filter((h) => h.code === 'DILUTION' && h.displayOnly);
  if (court.length) return { decision: 'COURT', reasonCode: null, watchReason: dil.length ? dil.map((h) => h.detail).join('；') : null, note: `規則偵測命中，開法庭：${court.map((h) => h.sub).join('、')}` };
  if (dil.length) return { decision: 'ALLOW_WATCH', reasonCode: null, watchReason: `增資（只顯示、不否決）：${dil.map((h) => h.detail).join('；')}`, note: '只有增資命中：准許但觀察' };
  return { decision: 'ALLOW', reasonCode: null, watchReason: null, note: '規則偵測沒有命中任何失效模式（被收購、延遲申報、重編、會計師辭任、單日跳漲、盈餘背離、增資、資料可疑），照規則進場。' };
}

// ---------------------------------------------------------------- 候選順序與遞補（設計 §2.4）

/** select(vetoed, emptySlots)：照規則選出這個月新進場的代號（引擎的 monthlyCandidates）。 */
export type Selector = (vetoed: string[], emptySlots: number) => string[];

export interface EntryResolution {
  vetoed: string[];
  emptySlots: number;
  /** 還沒有結論、要先審的代號。 */
  need: string[];
}

/**
 * 被否決的由下一名遞補，遞補者也要過審查；遞補者再被否決，那一格留在核心到下個月（emptySlots）。
 * decisions：已經有結論的（VETO、BLOCK 不能進場；PENDING 當成准許）。
 */
export function resolveEntries(select: Selector, decisions: Map<string, EntryDecision>): EntryResolution {
  const initial = new Set(select([], 0));
  const vetoed: string[] = [];
  let empty = 0;
  for (let k = 0; k < 30; k++) {
    const added = select(vetoed, empty);
    const need = added.filter((t) => !decisions.has(t));
    if (need.length) return { vetoed, emptySlots: empty, need };
    const no = added.filter((t) => decisions.get(t) === 'VETO' || decisions.get(t) === 'BLOCK');
    if (!no.length) return { vetoed, emptySlots: empty, need: [] };
    for (const t of no) {
      vetoed.push(t);
      if (!initial.has(t)) empty++;
    }
  }
  return { vetoed, emptySlots: empty, need: [] };
}

/** 月報前一天先審的：這個月會進場的，加上「如果它被否決、會由誰遞補」（只替需要法庭或被規則否決的找遞補）。 */
export function previewOrder(select: Selector, risky: (t: string) => boolean): string[] {
  const first = select([], 0);
  const out = [...first];
  const bad = first.filter(risky);
  if (bad.length) for (const t of select(bad, 0)) if (!out.includes(t)) out.push(t);
  return out;
}

// ---------------------------------------------------------------- 法庭

/** F1 卡片的前提。 */
export const ENTRY_PREMISES: PackPremise[] = [
  { id: 'P1', text: '漲勢是資訊慢慢反映的結果（投資人反應不足），會延續 3～12 個月', origin: 'SYSTEM_DEFAULT' },
  { id: 'P2', text: '漲勢有基本面支撐（價格動能大多來自盈餘動能）', origin: 'SYSTEM_DEFAULT' },
  { id: 'P3', text: '漲勢是連續累積的，不是一次跳空', origin: 'SYSTEM_DEFAULT' },
  { id: 'P4', text: '股價可以自由反映未來資訊（不是被收購價鎖住）', origin: 'SYSTEM_DEFAULT' },
  { id: 'P5', text: '價格資料本身正確', origin: 'SYSTEM_DEFAULT' },
];

export interface MomEntryInput {
  view: MarketView;
  axis: string[];
  ticker: string;
  rank: number;
  runId: string;
  hits: EntryHit[];
  docs: PackDoc[];
  dataQuality: EvidencePack['data_quality'];
  now: Date;
}

export function momEntryPack(inp: MomEntryInput) {
  const { view, ticker } = inp;
  const court = inp.hits.filter((h) => !h.byRule && !h.displayOnly);
  return buildPack({
    runId: inp.runId,
    fn: MOM_ENTRY,
    promptVersion: MOM_ENTRY_PROMPT,
    asOf: view.date,
    subject: { ticker },
    question:
      `${ticker} 動能排名第 ${inp.rank}，規則要讓它這個月進場。規則偵測命中：${court.map((h) => `${h.code}（${h.detail}）`).join('；')}。` +
      '預設是准許，舉證責任在檢方。請判斷這些命中是否讓動能的前提失效：哪些證據顯示失效、哪些顯示沒有？' +
      '否決只能用五個代碼（EARNINGS_DIVERGENCE、ONE_OFF_JUMP、PENDING_MA、ACCOUNTING、REGULATORY），估值、情緒、漲太多都不算。' +
      '增資只能當觀察理由（ALLOW_WATCH），不能否決。證據不足就回 INSUFFICIENT（照規則准許）。',
    policy: { level: 'A4', verdicts: ['ALLOW', 'ALLOW_WATCH', 'VETO', 'INSUFFICIENT'], abstain: 'INSUFFICIENT', min_evidence: 1, samples: 3 },
    rule: { action: `准許進場（排名第 ${inp.rank}）`, detail: { rank: inp.rank, hits: inp.hits } },
    facts: [...priceFacts(view, ticker), ...inp.hits.map((h, k) => ({ id: `H${k + 1}`, label: `規則偵測：${h.code}（${h.sub}）`, value: h.date ?? view.date, note: h.detail + (h.displayOnly ? '（只顯示）' : '') }))],
    premises: ENTRY_PREMISES,
    documents: [...inp.docs, priceDoc(view, inp.axis, ticker, 260)].filter((d): d is PackDoc => !!d),
    dataQuality: inp.dataQuality,
    conditionTypes: ['price_close_above', 'price_close_below', 'date_after', 'filing_event', 'xbrl_metric_above', 'xbrl_metric_below', 'event'],
    now: inp.now,
  });
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** F1 payload：decision 和 verdict 一致；VETO 要有合法代碼；ALLOW_WATCH 要寫觀察理由。 */
export function checkMomEntryPayload(s: CheckedSample): void {
  const p = s.payload ?? {};
  if (p.decision !== undefined && p.decision !== s.verdict && !(s.verdict === 'INSUFFICIENT')) s.issues.push(`payload.decision（${String(p.decision)}）和 verdict 不同`);
  if (s.verdict === 'VETO' && !VETO_CODES.includes(p.reason_code as never)) {
    s.issues.push(`否決的理由代碼（${String(p.reason_code)}）不是五個可以否決的代碼之一，改成 INSUFFICIENT`);
    s.verdict = 'INSUFFICIENT';
  }
  if (s.verdict === 'ALLOW_WATCH' && (typeof p.watch_reason !== 'string' || !p.watch_reason.trim() || p.watch_reason.length > 300)) {
    s.issues.push('准許但觀察要寫觀察理由（300 字以內），改成 ALLOW');
    s.verdict = 'ALLOW';
  }
  if (p.lift_condition !== undefined && p.lift_condition !== null && !isObj(p.lift_condition)) {
    s.issues.push('lift_condition 要是物件，不採用');
    s.payload = { ...p, lift_condition: null };
  }
}

export interface CourtVerdict {
  decision: 'ALLOW' | 'ALLOW_WATCH' | 'VETO';
  source: 'AI' | 'DEFAULT';
  reasonCode: string | null;
  watchReason: string | null;
  liftCondition: string | null;
  note: string;
}

/** 法庭的結論 → 這個月的決定。只有 3 票一致的否決才算數；其他一律照規則准許。 */
export function courtVerdict(outcome: Outcome): CourtVerdict {
  const s = outcome.samples.filter((x) => x.valid && x.verdict === outcome.verdict);
  if (outcome.actionable && outcome.verdict === 'VETO') {
    const codes = [...new Set(s.map((x) => x.payload?.reason_code as string))];
    if (codes.length !== 1) return { decision: 'ALLOW', source: 'DEFAULT', reasonCode: null, watchReason: null, liftCondition: null, note: '3 票都否決，但理由代碼不一致，照規則准許並記錄' };
    const lift = s.map((x) => x.payload?.lift_condition).find((x) => isObj(x));
    return { decision: 'VETO', source: 'AI', reasonCode: codes[0], watchReason: null, liftCondition: lift ? JSON.stringify(lift) : null, note: outcome.reason };
  }
  if (outcome.actionable && outcome.verdict === 'ALLOW_WATCH') {
    const why = s.map((x) => x.payload?.watch_reason as string).find(Boolean) ?? '';
    return { decision: 'ALLOW_WATCH', source: 'AI', reasonCode: null, watchReason: why, liftCondition: null, note: outcome.reason };
  }
  return { decision: 'ALLOW', source: outcome.status === 'AGREED' ? 'AI' : 'DEFAULT', reasonCode: null, watchReason: null, liftCondition: null, note: outcome.reason };
}

// ---------------------------------------------------------------- 擬事件打分（每月對前 15 名，§2.5）

export interface ScoreRow {
  ticker: string;
  rank: number;
  r12: number;
  hits: EntryHit[];
}

/** 每月一份：前 15 名每一檔的規則偵測結果 → AI 打「前提失效機率」（只記錄，往前驗證 AI 的鑑別力）。 */
export function momScorePack(inp: { runId: string; asOf: string; rows: ScoreRow[]; docs: PackDoc[]; now: Date }) {
  const table = inp.rows
    .map((r) => `#${r.rank} ${r.ticker} 12m ${(r.r12 * 100).toFixed(1)}% | ${r.hits.length ? r.hits.map((h) => `${h.code}: ${h.detail}`).join(' / ') : 'no rule hits'}`)
    .join('\n');
  return buildPack({
    runId: inp.runId,
    fn: MOM_SCORE,
    promptVersion: MOM_SCORE_PROMPT,
    asOf: inp.asOf,
    subject: { name: `動能前 ${inp.rows.length} 名的擬事件打分` },
    question: '對每一檔打「前提失效機率」（premise_risk，0～1），並列出可能的失效代碼。這份分數只記錄、不影響下單，用來事後檢查 AI 分不分得出好壞。沒有證據的就給低分，不要因為漲多就給高分。',
    policy: { level: 'A2', verdicts: ['SCORED', 'INSUFFICIENT'], abstain: 'INSUFFICIENT', min_evidence: 0, samples: 1 },
    rule: { action: '規則照排名，不受這份分數影響', detail: { tickers: inp.rows.map((r) => r.ticker) } },
    facts: inp.rows.map((r, k) => ({ id: `S${k + 1}`, label: `#${r.rank} ${r.ticker}`, value: `12 個月 ${(r.r12 * 100).toFixed(1)}%`, note: r.hits.length ? r.hits.map((h) => h.code).join('、') : '沒有命中' })),
    documents: [{ id: 'T-RULES', source_id: `rules:${inp.asOf}`, kind: 'table', date: inp.asOf, title: `前 ${inp.rows.length} 名的規則偵測結果`, text: table }, ...inp.docs],
    now: inp.now,
  });
}

/** 擬事件 payload：每一檔一筆，代號要在名單內、分數在 0～1、代碼在列舉內。 */
export function checkMomScorePayload(s: CheckedSample, pack: EvidencePack): void {
  const names = new Set((pack.rule.detail as { tickers?: string[] })?.tickers ?? []);
  const raw = Array.isArray(s.payload?.scores) ? (s.payload!.scores as unknown[]) : [];
  const kept: unknown[] = [];
  for (const r of raw.slice(0, 30)) {
    if (!isObj(r) || typeof r.ticker !== 'string' || !names.has(r.ticker) || typeof r.premise_risk !== 'number' || r.premise_risk < 0 || r.premise_risk > 1) {
      s.issues.push(`分數格式不對，拿掉：${JSON.stringify(r).slice(0, 100)}`);
      continue;
    }
    const codes = (Array.isArray(r.codes) ? r.codes : []).filter((c): c is string => ALL_CODES.includes(c as never));
    kept.push({ ticker: r.ticker, premise_risk: r.premise_risk, codes });
  }
  s.payload = { ...(s.payload ?? {}), scores: kept };
  if (s.verdict === 'SCORED' && !kept.length) s.verdict = 'INSUFFICIENT';
}
