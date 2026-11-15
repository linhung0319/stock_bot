// T11：F1 動能新股進場（任務 A：否決法庭）（ai_layer_design F1 卡片；design_v2 §6.2、§2.4；B-9 §7.4）。擬事件打分 T32d 拿掉（momentum_ai §3.7）。
// 純函式：候選順序與遞補、規則偵測的結論、法庭的證據包與檢查。資料抓取與排程在 src/app/momAi.ts。
//
// 規則偵測（不用 LLM）：
//   被收購方（PREM14A／DEFM14A／SC TO-T／SC 14D9 的被收購方）、NT 10-K／10-Q → 規則直接否決
//   價格日變動 > 25% 而前後一天沒有申報 → 資料可疑，這個月不進場（不是否決，是資料檢查）
//   8-K 4.02、會計師辭任、單日漲幅占比、盈餘背離、每日掃描標記的監管或會計候選 → 開法庭（3 票一致才否決）
//   增資（424B 普通股／可轉債、股數 6 個月增加 > 5%）→ 只顯示，准許，附註（2026-11-11 決定，不能單獨否決）
//   什麼都沒命中 → 准許（寫一句模板說明，不呼叫 LLM；設計 §10 第 34 點）
// 預設是准許：法庭沒有結論、票數不一致、來不及審，一律照規則准許。
// T32b（momentum_ai_design_2026-11-15 §3.3、§3.4）：規則結論的新表（只有新聞標題 → 准許，附註、不開法庭）、
//   否決要有申報、XBRL 或價格表的引用、證據指紋與「有新證據才重開」、月報那一項的說明。
import type { CheckedSample, EvidencePack, Outcome, PackDoc, PackPremise } from './check';
import { buildPack, priceDoc, priceFacts } from './pack';
import type { MarketView } from '../engine';

export const MOM_ENTRY = 'MOM_ENTRY';
/** v2（T32b）：否決要有申報、XBRL 或價格表的引用；財測下修來自掃描時要讀那份 8-K；拿掉 lift_condition；「准許，附註」。 */
export const MOM_ENTRY_PROMPT = 'mom_entry_v2';

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
  /**
   * 命中從哪裡來（momentum_ai §3.1）：申報 FILING、新聞標題 NEWS、程式算的 CALC（單日跳漲、EPS 背離、股數、資料可疑）。
   * 沒有這個欄位的舊命中當成 FILING。
   */
  basis?: 'FILING' | 'NEWS' | 'CALC';
}

/** 代碼的中文（月報、告警、LINE 用；momentum_ai §3.3）。 */
export const ENTRY_CODE_TEXT: Record<string, string> = {
  EARNINGS_DIVERGENCE: '盈餘或財測和股價背離',
  ONE_OFF_JUMP: '漲幅來自一次性事件',
  PENDING_MA: '被收購',
  ACCOUNTING: '財報可信度',
  REGULATORY: '重大監管或訴訟',
};

/** 要法庭判斷的命中（不是規則就能下結論、也不是只顯示的）。 */
export const courtHits = (hits: EntryHit[]) => hits.filter((h) => !h.byRule && !h.displayOnly);
const basisOf = (h: EntryHit) => h.basis ?? 'FILING';

/** 一筆命中給人讀的樣子（「8-K 4.02（2026-11-12）」「單日跳漲（2026-08-05）」）；不出現代碼。 */
export function hitLabel(h: EntryHit): string {
  const item = /^8K_(\d\.\d\d)/.exec(h.sub)?.[1];
  const cand = /^SCAN_(\w+?)_CANDIDATE$/.exec(h.sub)?.[1];
  const what = item
    ? `8-K ${item}`
    : h.sub === 'JUMP_SHARE'
      ? '單日跳漲'
      : h.sub === 'EPS_DOWN_PRICE_UP'
        ? 'EPS 下降而股價上漲'
        : h.sub === 'SCAN_GUIDANCE_CUT'
          ? `財測下修（${basisOf(h) === 'NEWS' ? '新聞標題' : '8-K'}）`
          : cand
            ? `${ENTRY_CODE_TEXT[cand] ?? cand}（${basisOf(h) === 'NEWS' ? '新聞標題' : '申報'}）`
            : (ENTRY_CODE_TEXT[h.code] ?? h.sub);
  return h.date ? `${what}（${h.date}）` : what;
}

export interface RuleVerdict {
  decision: EntryDecision | 'COURT';
  reasonCode: string | null;
  watchReason: string | null;
  note: string;
  /** 申報抓不到、而且沒有別的命中：照規則准許，但不能說成「沒有命中」（momentum_ai §3.3 表第 6 列；source 記 DEFAULT）。 */
  dataMissing?: boolean;
}

/**
 * 規則偵測的命中 → 規則能下的結論；要法庭的回 COURT（momentum_ai §3.3 的表，照順序看）：
 *   1 規則直接否決（被收購方、NT）→ VETO；2 資料可疑 → BLOCK；
 *   3 要法庭判斷的命中，至少一筆來自申報或程式算的 → COURT（能不能沿用由呼叫端看 §3.4）；
 *   4 要法庭判斷的命中全部來自新聞標題 → 准許，附註（不開法庭：否決要申報引用，開了也只能准許）；
 *   5 只有增資 → 准許，附註；6 申報抓不到 → 准許（data_missing）；7 都沒有 → 准許。
 * opt.filingsMissing：申報清單抓不到的原因（有的話，沒有命中時不寫成「沒有命中」）。
 */
export function entryRuleVerdict(hits: EntryHit[], opt: { filingsMissing?: string } = {}): RuleVerdict {
  const veto = hits.find((h) => h.byRule && !h.displayOnly && (h.code === 'PENDING_MA' || h.code === 'ACCOUNTING'));
  if (veto) return { decision: 'VETO', reasonCode: veto.code, watchReason: null, note: `規則直接否決：${veto.detail}` };
  const sus = hits.find((h) => h.code === 'DATA_SUSPECT');
  if (sus) return { decision: 'BLOCK', reasonCode: null, watchReason: null, note: `價格資料可疑，這個月不進場：${sus.detail}` };
  const court = courtHits(hits);
  const dil = hits.filter((h) => h.code === 'DILUTION' && h.displayOnly);
  const dilText = dil.length ? `增資（只顯示、不否決）：${dil.map((h) => h.detail).join('；')}` : null;
  const real = court.filter((h) => basisOf(h) !== 'NEWS');
  if (real.length) return { decision: 'COURT', reasonCode: null, watchReason: dil.length ? dil.map((h) => h.detail).join('；') : null, note: `規則偵測命中，開法庭：${real.map(hitLabel).join('、')}` };
  if (court.length) {
    const news = court.map((h) => `新聞標題標到「${ENTRY_CODE_TEXT[h.code] ?? h.code}」${h.date ? `（${h.date.slice(5)}）` : ''}`).join('、');
    const why = `${news}，只有標題、沒有申報，不能否決`;
    return { decision: 'ALLOW_WATCH', reasonCode: null, watchReason: dilText ? `${why}；${dilText}` : why, note: `只有新聞標題的命中：准許，附註，不開法庭` };
  }
  if (dil.length) return { decision: 'ALLOW_WATCH', reasonCode: null, watchReason: dilText, note: '只有增資命中：准許，附註' };
  if (opt.filingsMissing !== undefined) return { decision: 'ALLOW', reasonCode: null, watchReason: null, dataMissing: true, note: `申報抓不到（${opt.filingsMissing}），這次沒有檢查申報類的失效模式，照規則進場` };
  return { decision: 'ALLOW', reasonCode: null, watchReason: null, note: '規則偵測沒有命中任何失效模式（被收購、延遲申報、重編、會計師辭任、單日跳漲、盈餘背離、增資、資料可疑），照規則進場。' };
}

// ---------------------------------------------------------------- 有新證據才重開進場法庭（momentum_ai §3.4）

/**
 * 證據指紋：這次要法庭判斷的命中，各取一個字串、排序後用 ; 接起來（新聞標題來的不算）。
 *   申報來的 <code>|<sub>|<申報編號>；單日跳漲 ONE_OFF_JUMP|JUMP|<最大單日的日期>；EPS 背離 EARNINGS_DIVERGENCE|EPS|<最新一季的季末日>
 * 申報編號：每日掃描與回看存的是 edgar:<申報編號>，去掉前綴。
 */
export function evidenceKey(hits: EntryHit[]): string {
  const parts = courtHits(hits)
    .filter((h) => basisOf(h) !== 'NEWS')
    .map((h) => {
      if (h.code === 'ONE_OFF_JUMP' && h.sub === 'JUMP_SHARE') return `ONE_OFF_JUMP|JUMP|${h.date ?? ''}`;
      if (h.code === 'EARNINGS_DIVERGENCE' && h.sub === 'EPS_DOWN_PRICE_UP') return `EARNINGS_DIVERGENCE|EPS|${h.date ?? ''}`;
      return `${h.code}|${h.sub}|${(h.accession ?? '').replace(/^edgar:/, '')}`;
    });
  return [...new Set(parts)].sort().join(';');
}

/** 上一次有結論的法庭（三票一致、不是沿用的）：指紋、決策日（那次執行的決策日）、月份。 */
export interface PrevCourt {
  month: string;
  evidenceKey: string | null;
  decidedOn: string;
}

/** 新證據的判斷要用的申報（申報日、表單、Item）。 */
export interface FilingLite {
  form: string;
  filingDate: string;
  items: string[];
}

/** 新證據的原因（給人讀）。 */
export const NEW_EVIDENCE_TEXT: Record<string, string> = { NEVER: '之前沒有審過', HITS: '命中和上次不同', FILING: '上次之後有新的財報', STALE: '距上次審查滿 100 天', RETRY: '上一次沒有結論' };

/** 沿用的期限：距上一次有結論的法庭滿這麼多個日曆天就重審。 */
export const ENTRY_STALE_DAYS = 100;

const isEarningsFiling = (f: FilingLite) => /^10-[QK]/.test(f.form) || (/^8-K/.test(f.form) && f.items.includes('2.02'));

/**
 * 有沒有新證據（回傳原因的清單；空的 = 沿用上一次的結論）：
 *   NEVER 沒有上一次；HITS 指紋不同；FILING 上一次之後有新的 10-Q、10-K 或 8-K 2.02（含修正）；STALE 距上一次滿 100 個日曆天。
 * 其他 8-K 只有在帶來新命中時才算（那就是 HITS）。
 */
export function entryNewEvidence(prev: PrevCourt | null, cur: { key: string; filings: FilingLite[]; asOf: string }): string[] {
  if (!prev) return ['NEVER'];
  const out: string[] = [];
  if ((prev.evidenceKey ?? '') !== cur.key) out.push('HITS');
  if (cur.filings.some((f) => f.filingDate > prev.decidedOn && f.filingDate <= cur.asOf && isEarningsFiling(f))) out.push('FILING');
  if ((Date.parse(cur.asOf) - Date.parse(prev.decidedOn)) / 86400_000 >= ENTRY_STALE_DAYS) out.push('STALE');
  return out;
}

// ---------------------------------------------------------------- 月報那一項的說明（momentum_ai §3.3）

/** entryNote 要用的那一列（mom_reviews）。 */
export interface EntryNoteRow {
  decision: EntryDecision;
  source: 'RULE' | 'AI' | 'DEFAULT';
  hits: EntryHit[];
  runId: string | null;
  watchReason: string | null;
  note: string | null;
  dataMissing?: boolean;
  carriedFrom?: string | null;
  late?: boolean;
}

/** 這一列的命中細項（要法庭判斷的，給人讀）。 */
export const hitsText = (hits: EntryHit[]) => courtHits(hits).map(hitLabel).join('、');

/** 備註裡「略過 N 份」的 N（momEvidence 的上限，§3.1）。 */
const omittedOf = (note: string | null) => Number(/略過 (\d+) 份/.exec(note ?? '')?.[1] ?? 0);

/**
 * 月報對每個 F1 項目寫的說明（`it.note`）。沒有要寫的回 null（規則准許、沒有命中）。
 *   准許，附註 → 「准許，附註：<理由>」；法庭三票准許 → 「進場審查（3 票）：准許。規則偵測命中：…」；
 *   沿用 → 「沿用 2026-11 的進場審查（准許）：之後沒有新的財報或命中」；法庭沒有結論、資料缺漏 → 那一列的說明；
 *   月報當天才審、法庭還在跑 → 「規則偵測命中：…；進場審查進行中，台灣 11:30 前更新」；有略過的文件 → 後面加一句。
 */
export function entryNote(r: EntryNoteRow, opt: { running?: boolean } = {}): string | null {
  const hits = hitsText(r.hits);
  let text: string | null = null;
  if (opt.running) text = `規則偵測命中：${hits}；進場審查進行中，台灣 11:30 前更新`;
  else if (r.carriedFrom) {
    // 沿用的原因：沒有新證據（§3.4），或這次的法庭沒有結論、申報抓不到（不蓋掉上一次的結論）
    const why = /沒有結論|沒有一致的結論|沒有開成/.test(r.note ?? '') ? '這次的審查沒有結論' : /申報抓不到/.test(r.note ?? '') ? '這次申報抓不到' : '之後沒有新的財報或命中';
    text = `沿用 ${r.carriedFrom} 的進場審查（${r.decision === 'ALLOW_WATCH' ? '准許，附註' : r.decision === 'VETO' ? '否決' : '准許'}）：${why}${r.decision === 'ALLOW_WATCH' && r.watchReason ? `。附註：${r.watchReason}` : ''}`;
  }
  else if (r.dataMissing) text = r.note;
  else if (r.decision === 'ALLOW_WATCH') text = `准許，附註：${r.watchReason ?? ''}`;
  else if (r.decision === 'ALLOW' && r.source === 'AI' && r.runId) text = `進場審查（3 票）：准許。規則偵測命中：${hits}`;
  else if (r.decision === 'ALLOW' && r.source === 'DEFAULT' && hits) text = r.note;
  if (!text) return null;
  const n = omittedOf(r.note);
  return n ? `${text}（略過 ${n} 份文件，見 AI 紀錄）` : text;
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
      '否決至少要有一條通過檢查的引用來自申報原文、XBRL 或價格表（只有新聞標題不能否決）。' +
      '增資只能當附註（ALLOW_WATCH），不能否決。證據不足就回 INSUFFICIENT（照規則准許）。',
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

/** 否決的那一票至少要有一條通過檢查的引用來自這幾種文件（momentum_ai §3.3，使用者 2026-11-15 決定；修 Q10）。 */
const VETO_DOC_KINDS = ['filing', 'xbrl', 'price'];
/** 只有新聞標題的否決改成准許、附註時補的理由。 */
export const NEWS_ONLY_VETO_REASON = '只有新聞標題的引用，不能否決';

/**
 * F1 payload：decision 和 verdict 一致；VETO 要有合法代碼、至少一條通過檢查的引用來自申報、XBRL 或價格表
 * （沒有 → 那一票改成 ALLOW_WATCH，附註沒寫的補「只有新聞標題的引用，不能否決」）；ALLOW_WATCH 要寫附註。
 * lift_condition 不再收（v2 拿掉；送來就忽略）。
 */
export function checkMomEntryPayload(s: CheckedSample, pack?: EvidencePack): void {
  const p = s.payload ?? {};
  if (p.decision !== undefined && p.decision !== s.verdict && !(s.verdict === 'INSUFFICIENT')) s.issues.push(`payload.decision（${String(p.decision)}）和 verdict 不同`);
  if (s.verdict === 'VETO' && !VETO_CODES.includes(p.reason_code as never)) {
    s.issues.push(`否決的理由代碼（${String(p.reason_code)}）不是五個可以否決的代碼之一，改成 INSUFFICIENT`);
    s.verdict = 'INSUFFICIENT';
  }
  if (s.verdict === 'VETO' && pack) {
    const kindOf = new Map(pack.documents.map((d) => [d.source_id, d.kind]));
    if (!s.evidence.some((e) => e.ok && VETO_DOC_KINDS.includes(kindOf.get(e.source_id) ?? ''))) {
      s.issues.push('否決沒有一條通過檢查的引用來自申報原文、XBRL 或價格表（只有新聞標題），改成 ALLOW_WATCH');
      s.verdict = 'ALLOW_WATCH';
      if (typeof p.watch_reason !== 'string' || !p.watch_reason.trim()) s.payload = { ...(s.payload ?? {}), watch_reason: NEWS_ONLY_VETO_REASON };
    }
  }
  const q = s.payload ?? {};
  if (s.verdict === 'ALLOW_WATCH' && (typeof q.watch_reason !== 'string' || !q.watch_reason.trim() || q.watch_reason.length > 300)) {
    s.issues.push('准許，附註要寫附註（300 字以內），改成 ALLOW');
    s.verdict = 'ALLOW';
  }
  if ('lift_condition' in q) {
    const { lift_condition: _drop, ...rest } = q;
    s.payload = rest;
  }
}

export interface CourtVerdict {
  decision: 'ALLOW' | 'ALLOW_WATCH' | 'VETO';
  source: 'AI' | 'DEFAULT';
  reasonCode: string | null;
  watchReason: string | null;
  /** 不再寫（v2 拿掉；欄位留著）。 */
  liftCondition: null;
  note: string;
}

/**
 * 法庭的結論 → 這個月的決定。只有 3 票一致、同一個代碼的否決才算數；其他一律照規則准許。
 * source：三票一致（AGREED，或三票一致的證據不足 INSUFFICIENT）記 AI——之後沒有新證據就沿用（§3.4）；
 * 票數不一致、理由代碼不一致、沒有結論記 DEFAULT。
 */
export function courtVerdict(outcome: Outcome): CourtVerdict {
  const s = outcome.samples.filter((x) => x.valid && x.verdict === outcome.verdict);
  if (outcome.actionable && outcome.verdict === 'VETO') {
    const codes = [...new Set(s.map((x) => x.payload?.reason_code as string))];
    if (codes.length !== 1) return { decision: 'ALLOW', source: 'DEFAULT', reasonCode: null, watchReason: null, liftCondition: null, note: '3 票都否決，但理由代碼不一致，照規則准許並記錄' };
    return { decision: 'VETO', source: 'AI', reasonCode: codes[0], watchReason: null, liftCondition: null, note: outcome.reason };
  }
  if (outcome.actionable && outcome.verdict === 'ALLOW_WATCH') {
    const why = s.map((x) => x.payload?.watch_reason as string).find(Boolean) ?? '';
    return { decision: 'ALLOW_WATCH', source: 'AI', reasonCode: null, watchReason: why, liftCondition: null, note: outcome.reason };
  }
  return { decision: 'ALLOW', source: courtConcluded(outcome) ? 'AI' : 'DEFAULT', reasonCode: null, watchReason: null, liftCondition: null, note: outcome.reason };
}

/** 法庭有結論（三票一致：AGREED、INSUFFICIENT）。 */
export const courtConcluded = (o: Outcome | null | undefined): boolean => !!o && (o.status === 'AGREED' || o.status === 'INSUFFICIENT');
/** 法庭跑完了但沒有可用的結論（票數不一致）：不重開（重抽三票是雜訊，§3.4），也不蓋掉上一次的結論。 */
export const courtSplit = (o: Outcome | null | undefined): boolean => !!o && o.status === 'SPLIT';
/** 法庭沒有結論（逾時、沒觸發成功、整份退回、三票格式都不合格、資料缺漏）：可以重開。 */
export const courtFailed = (o: Outcome | null | undefined): boolean => !o || (!courtConcluded(o) && !courtSplit(o));

/** 沒有結論的原因（白話，告警與月報說明用）。 */
export function courtFailWhy(o: Outcome | null | undefined): string {
  if (!o) return '沒有結果';
  if (o.status === 'TIMEOUT') return '逾時';
  if (o.status === 'INVALID') return '三票格式都不合格';
  if (o.status === 'DATA_MISSING') return '資料缺漏';
  if (o.status === 'NO_RESULT') return /觸發/.test(o.reason) ? '沒觸發成功' : /退回/.test(o.reason) ? '結果被退回' : '沒有結果';
  return o.status;
}

