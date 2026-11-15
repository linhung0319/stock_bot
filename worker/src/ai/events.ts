// T11：F18 每日事件掃描（任務 B）、F19 持股硬事件（ai_layer_design 的 F18、F19 卡片；2026-11-11 更新）。
// 純函式：證據包、payload 檢查、結論。資料抓取與排程在 src/app/events.ts。
//
// F18：規則先從 EDGAR 申報分類（src/data/secEvents.ts）；規則分不出輕重的 8-K（1.01、2.05、5.02、8.01…）與新聞標題，
//      交給便宜的模型（Haiku）只輸出事件類別與日期，不寫評論。只能標記、轉交 F19 或下一次 F1，不能觸發交易。
// F19：只限三個代碼（PENDING_MA、ACCOUNTING、REGULATORY）。動能持股的被收購方判定與 NT 10-K／10-Q 由規則直接提出（不跑法庭）；
//      法庭只處理 4.02 的重大性、會計師辭任、REGULATORY、自選股的 PENDING_MA。3 票一致建議出場才發當天通知，使用者確認才做。
import type { Account, MarketView } from '../engine';
import type { CheckedSample, EvidencePack, Outcome, PackDoc, PackPremise } from './check';
import { buildPack, ownPremises, priceDoc, priceFacts } from './pack';

export const EVENT_SCAN = 'EVENT_SCAN';
/** v2（T28）：每筆多一個細項 sub；條件清單改成觀察項與「只在審查時檢查」的條件。 */
export const EVENT_SCAN_PROMPT = 'event_scan_v2';
export const HARD_EVENT = 'HARD_EVENT';
export const HARD_EVENT_PROMPT = 'hard_event_v1';

export type HardCode = 'PENDING_MA' | 'ACCOUNTING' | 'REGULATORY';
export const HARD_CODES: HardCode[] = ['PENDING_MA', 'ACCOUNTING', 'REGULATORY'];

/** F18 的事件類別（固定列舉）。_CANDIDATE 結尾的會轉交 F19（持股）或下一次 F1（候選股）。 */
export const SCAN_CLASSES = ['ACCOUNTING_CANDIDATE', 'REGULATORY_CANDIDATE', 'PENDING_MA_CANDIDATE', 'GUIDANCE_CUT', 'EARNINGS', 'MGMT_CHANGE', 'RESTRUCTURING', 'MAJOR_CONTRACT', 'FINANCING', 'OTHER'] as const;
export type ScanClass = (typeof SCAN_CLASSES)[number];
export const CANDIDATE_CODE: Partial<Record<ScanClass, HardCode>> = { ACCOUNTING_CANDIDATE: 'ACCOUNTING', REGULATORY_CANDIDATE: 'REGULATORY', PENDING_MA_CANDIDATE: 'PENDING_MA' };
/**
 * Haiku 可以給的細項（own_thesis §2.2 由 Haiku 判的那幾種）。不在這裡的 sub 程式拿掉，類別留著（當成不可提前的）。
 * RESTRUCTURING、MAJOR_CONTRACT 的終止、DISTRESS、CYBER 由規則看 Item 編號，不由 Haiku 給細項。
 */
export const SCAN_SUBS: Partial<Record<ScanClass, readonly string[]>> = {
  MGMT_CHANGE: ['CEO_DEPART', 'CFO_DEPART', 'EXEC_APPOINT', 'OTHER_EXEC', 'DIRECTOR'],
  GUIDANCE_CUT: ['CUT', 'WITHDRAWN'],
  MAJOR_CONTRACT: ['NEW'],
};

export interface ScanTarget {
  ticker: string;
  /** ENTRY：進場前回看的對象（這個月會進場的動能股；momentum_ai §3.2，T32b）。 */
  role: 'OWN' | 'MOM' | 'CAND' | 'ENTRY';
}

/**
 * 自選股的條件，讓掃描順便標出「可能有關的條件」（own_thesis §2.5）：事件類的觀察項（PROPOSED）與你定的、只在審查時檢查的（REVIEW_ONLY）。
 * 可以由申報確認的（ACTIVE）不放：它們由新申報直接開條件確認（F25）。
 */
export interface ScanCondition {
  ticker: string;
  condId: string;
  text: string;
  /** own_conditions 的列編號（標到時寫進 CONDITION_HINT 的細項）。 */
  rowId: number;
  status: 'PROPOSED' | 'REVIEW_ONLY';
}

/** 這次掃描的一份文件（申報或一檔的新聞標題），沒有結論時寫進 SCAN_FAILED 告警。 */
export interface ScanBatchItem {
  ticker: string;
  kind: '8-K' | 'NEWS';
  /** 給人讀的一句（MU 的 8-K 2027-01-06（Item 5.02）、NVDA 的 12 則新聞標題）。 */
  label: string;
}

/** 這次掃描看到的最新一份 8-K（acceptedAt）與最新一則標題的時間；有合格結論才把標記推到這裡。 */
export type ScanCursors = Record<string, { scan8k?: string; news?: string }>;

export interface EventScanInput {
  runId: string;
  asOf: string;
  targets: ScanTarget[];
  /** 新的 8-K 原文、新的新聞標題（每份一個來源）。 */
  docs: (PackDoc & { ticker: string })[];
  conditions: ScanCondition[];
  /** 每檔這次看到的最新 acceptedAt 與標題時間（rule.detail.cursors）。 */
  cursors?: ScanCursors;
  /** 這次的文件清單（rule.detail.batch）。 */
  batch?: ScanBatchItem[];
  /** 證據包的備註（略過的較舊標題、留到下一次的 8-K）。 */
  notes?: string[];
  dataQuality: EvidencePack['data_quality'];
  now: Date;
}

const ROLE = { OWN: '自選持股', MOM: '動能持股', CAND: '動能候選（排名 6～10）', ENTRY: '動能進場候選（本月）' };

/** F18 的證據包（一天一份，所有對象一起）。 */
export function eventScanPack(inp: EventScanInput) {
  const tickers = [...new Set(inp.docs.map((d) => d.ticker))];
  return buildPack({
    runId: inp.runId,
    fn: EVENT_SCAN,
    promptVersion: EVENT_SCAN_PROMPT,
    asOf: inp.asOf,
    subject: { name: `每日事件掃描（${tickers.join('、')}）` },
    question:
      '逐份讀這些新的申報與新聞標題，每一件事只輸出事件類別、細項與來源（payload.events），不寫評論、不判斷重大性、不判斷該不該買賣。' +
      '只有原文直接寫出的事才標；新聞標題只能當初判。自選股另外標出「可能有關的條件」編號（facts 的 K 開頭：觀察項，或只在審查時檢查的條件）。' +
      '沒有值得標的事就回 NOTHING。',
    policy: { level: 'A1', verdicts: ['FLAGGED', 'NOTHING'], abstain: 'NOTHING', min_evidence: 0, samples: 1 },
    rule: {
      action: '只標記、轉交（F19 硬事件法庭、提前審查、下一次 F1 審查），不能觸發交易',
      detail: {
        targets: inp.targets,
        classes: SCAN_CLASSES,
        subs: SCAN_SUBS,
        conds: Object.fromEntries(inp.conditions.map((c, k) => [`K${k + 1}`, c.rowId])),
        cursors: inp.cursors ?? {},
        batch: inp.batch ?? [],
        ...(inp.notes?.length ? { notes: inp.notes } : {}),
      },
    },
    facts: [
      ...inp.targets.map((t, k) => ({ id: `T${k + 1}`, label: t.ticker, value: ROLE[t.role] })),
      ...inp.conditions.map((c, k) => ({ id: `K${k + 1}`, label: `${c.ticker} 的${c.status === 'PROPOSED' ? '觀察項' : '條件（只在審查時檢查）'} ${c.condId}`, value: c.text })),
    ],
    documents: inp.docs.map(({ ticker: _t, ...d }) => d),
    dataQuality: inp.dataQuality,
    now: inp.now,
  });
}

/**
 * 掃描有沒有合格結論（own_thesis §2.6）：至少一票格式合格，而且不是逾時、觸發失敗、整份退回。
 * 合格（含「沒有值得標的事」）才把標記往前推；不合格 → 標記不動、下一次重掃同一批。
 */
export function scanQualified(outcome: Outcome | null | undefined): boolean {
  return !!outcome && outcome.status !== 'TIMEOUT' && outcome.status !== 'NO_RESULT' && outcome.samples.some((s) => s.valid);
}

export interface ScanEvent {
  ticker: string;
  cls: ScanClass;
  /** 細項（只有 SCAN_SUBS 列舉內的；其他是 null）。 */
  sub: string | null;
  sourceId: string;
  date: string;
  /** 可能有關的條件（facts 的名稱，給人讀）。 */
  conditionIds: string[];
  /** 同上，own_conditions 的列編號（證據包有對照表時）。 */
  conditionRows: number[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** F18 payload：events 每一筆的代號、類別、來源都要對得上證據包；_CANDIDATE 要有一條通過檢查、引用同一份來源的證據。 */
export function checkEventScanPayload(s: CheckedSample, pack: EvidencePack): void {
  const targets = ((pack.rule.detail as { targets?: ScanTarget[] })?.targets ?? []).map((t) => t.ticker);
  const sources = new Set(pack.documents.map((d) => d.source_id));
  const conds = new Map(pack.facts.filter((f) => /^K\d+$/.test(f.id)).map((f) => [f.label, f.id]));
  const okSources = new Set(s.evidence.filter((e) => e.ok).map((e) => e.source_id));
  const raw = Array.isArray(s.payload?.events) ? (s.payload!.events as unknown[]) : [];
  const kept: unknown[] = [];
  for (const e of raw.slice(0, 40)) {
    if (!isObj(e) || typeof e.ticker !== 'string' || !targets.includes(e.ticker) || !SCAN_CLASSES.includes(e.class as ScanClass) || typeof e.source_id !== 'string' || !sources.has(e.source_id)) {
      s.issues.push(`事件格式不對，拿掉：${JSON.stringify(e).slice(0, 120)}`);
      continue;
    }
    if (String(e.class).endsWith('_CANDIDATE') && !okSources.has(e.source_id)) {
      s.issues.push(`${e.ticker} ${String(e.class)} 沒有通過檢查的引用，拿掉`);
      continue;
    }
    const ids = (Array.isArray(e.condition_ids) ? e.condition_ids : []).filter((x): x is string => typeof x === 'string' && [...conds.values()].includes(x));
    // 細項：只收 SCAN_SUBS 列舉內的；其他拿掉細項、類別留著（當成不可提前的）
    const subs = SCAN_SUBS[e.class as ScanClass] ?? [];
    const { sub: rawSub, ...rest } = e;
    let sub: string | null = null;
    if (rawSub !== undefined && rawSub !== null && rawSub !== '') {
      if (typeof rawSub === 'string' && subs.includes(rawSub)) sub = rawSub;
      else s.issues.push(`${e.ticker} ${String(e.class)} 的細項（${String(rawSub).slice(0, 40)}）不在列舉內，拿掉細項（類別留著）`);
    }
    kept.push({ ...rest, ...(sub ? { sub } : {}), condition_ids: ids });
  }
  s.payload = { ...(s.payload ?? {}), events: kept };
  if (s.verdict === 'FLAGGED' && !kept.length) s.verdict = 'NOTHING';
}

/** F18 的結論 → 事件清單（A1：只有一票，格式合格就用）。 */
export function scanEvents(outcome: Outcome, pack: EvidencePack): ScanEvent[] {
  const s = outcome.samples.find((x) => x.valid);
  if (!s || s.verdict !== 'FLAGGED') return [];
  const conds = new Map(pack.facts.filter((f) => /^K\d+$/.test(f.id)).map((f) => [f.id, f.label]));
  const rows = ((pack.rule.detail ?? {}) as { conds?: Record<string, number> }).conds ?? {};
  const dateOf = new Map(pack.documents.map((d) => [d.source_id, d.date]));
  return ((s.payload?.events as Record<string, unknown>[]) ?? []).map((e) => {
    const ids = (e.condition_ids as string[]) ?? [];
    return {
      ticker: String(e.ticker),
      cls: e.class as ScanClass,
      sub: typeof e.sub === 'string' ? e.sub : null,
      sourceId: String(e.source_id),
      date: dateOf.get(String(e.source_id)) ?? pack.as_of,
      conditionIds: ids.map((id) => conds.get(id) ?? id),
      conditionRows: ids.map((id) => rows[id]).filter((x): x is number => typeof x === 'number'),
    };
  });
}

// ---------------------------------------------------------------- F19 硬事件法庭

export interface HardEventRef {
  code: string;
  sub: string;
  form: string;
  date: string;
  detail: string | null;
  source: string;
}

export interface HardEventInput {
  acct: Account;
  view: MarketView;
  axis: string[];
  ticker: string;
  runId: string;
  role: 'OWN' | 'MOM';
  events: HardEventRef[];
  /** 事件的原文（申報、新聞標題）。 */
  docs: PackDoc[];
  /** XBRL 季度表（重大性的數字從這裡取）。 */
  xbrl: PackDoc | null;
  dataQuality: EvidencePack['data_quality'];
  /** 自選股的前提（由論點檔取，T25）；不給就讀帳戶狀態。 */
  ownPremises?: PackPremise[];
  now: Date;
}

/** 動能持股被挑戰的前提（F1 卡片的 P2、P4）。 */
export const MOM_HOLD_PREMISES: PackPremise[] = [
  { id: 'P2', text: '漲勢有基本面支撐，而且盈餘數字本身可信', origin: 'SYSTEM_DEFAULT' },
  { id: 'P4', text: '股價可以自由反映未來資訊（不是被收購價鎖住）', origin: 'SYSTEM_DEFAULT' },
];
const TRUST_PREMISE: PackPremise = { id: 'PX', text: '財報可信（沒有重編、會計師沒有辭任、按時申報）', origin: 'SYSTEM_DEFAULT' };

const CODE_TEXT: Record<string, string> = { PENDING_MA: '被收購', ACCOUNTING: '會計問題', REGULATORY: '重大監管或訴訟' };

export function hardEventPack(inp: HardEventInput) {
  const { acct, view, ticker } = inp;
  const codes = [...new Set(inp.events.map((e) => e.code).filter((c): c is HardCode => HARD_CODES.includes(c as HardCode)))];
  const shares = inp.role === 'OWN' ? (acct.lots.own[ticker] ?? 0) : (acct.lots.mom[ticker] ?? 0);
  const premises = inp.role === 'OWN' ? [...(inp.ownPremises ?? ownPremises(acct, ticker)), TRUST_PREMISE] : MOM_HOLD_PREMISES;
  return buildPack({
    runId: inp.runId,
    fn: HARD_EVENT,
    promptVersion: HARD_EVENT_PROMPT,
    asOf: view.date,
    subject: { ticker },
    question:
      `${ticker}（${inp.role === 'OWN' ? '自選股' : '動能持股'}）出現${codes.map((c) => CODE_TEXT[c]).join('、')}的事件。` +
      '這個事件是否讓持有的前提失效？哪些證據顯示失效、哪些顯示不重大？重大性要引用具體數字（受影響的部分占營收或淨利多少，數字只能來自證據包）。' +
      '假設三個月後回頭看，這次「不動」是錯的，最可能的原因是什麼？反過來，這次「出場」是錯的呢？' +
      '證據不足就回 INSUFFICIENT（照規則，繼續持有）。',
    policy: { level: 'A3', verdicts: ['EXIT', 'HOLD', 'INSUFFICIENT'], abstain: 'INSUFFICIENT', min_evidence: 1, samples: 3 },
    rule: { action: '規則沒有動作（繼續持有）', detail: { codes, role: inp.role, events: inp.events } },
    facts: [
      ...priceFacts(view, ticker),
      { id: 'H0', label: '持有', value: `${shares} 股（${inp.role === 'OWN' ? '自選' : '動能'}）` },
      ...inp.events.map((e, k) => ({ id: `H${k + 1}`, label: `事件：${e.form}（${e.sub}）`, value: e.date, ...(e.detail ? { note: e.detail } : {}) })),
    ],
    premises,
    documents: [...inp.docs, inp.xbrl, priceDoc(view, inp.axis, ticker, 60)].filter((d): d is PackDoc => !!d),
    dataQuality: inp.dataQuality,
    now: inp.now,
  });
}

/** F19 payload：reason_code 要是這次事件的代碼；recommend_exit 要和 verdict 一致；EXIT 至少要有一條引用申報原文（不是新聞標題）。 */
export function checkHardEventPayload(s: CheckedSample, pack: EvidencePack): void {
  const codes = (pack.rule.detail as { codes?: string[] })?.codes ?? [];
  const p = s.payload ?? {};
  if (s.verdict === 'EXIT') {
    if (typeof p.reason_code !== 'string' || !codes.includes(p.reason_code)) {
      s.issues.push(`reason_code（${String(p.reason_code)}）不是這次事件的代碼（${codes.join('、')}），改成 INSUFFICIENT`);
      s.verdict = 'INSUFFICIENT';
      return;
    }
    const filingSources = new Set(pack.documents.filter((d) => d.kind === 'filing').map((d) => d.source_id));
    if (!s.evidence.some((e) => e.ok && filingSources.has(e.source_id))) {
      s.issues.push('建議出場，但沒有一條引用申報原文（新聞標題只能當初判），改成 INSUFFICIENT');
      s.verdict = 'INSUFFICIENT';
      return;
    }
  }
  if (p.recommend_exit !== undefined && p.recommend_exit !== (s.verdict === 'EXIT')) s.issues.push('payload.recommend_exit 和 verdict 不一致');
  const m = p.materiality;
  if (m !== undefined && m !== null) {
    const okIds = new Set(s.evidence.filter((e) => e.ok).map((e) => e.id));
    const basis = isObj(m) && Array.isArray(m.basis) ? (m.basis as unknown[]).filter((x) => typeof x === 'string' && okIds.has(x)) : [];
    if (!isObj(m) || typeof m.metric !== 'string' || !basis.length) {
      s.issues.push('重大性的數字沒有對應通過檢查的證據，不採用');
      s.payload = { ...p, materiality: null };
    }
  }
}

/** F19 的結論：3 票一致建議出場才通知。 */
export function hardDecision(outcome: Outcome): { exit: boolean; code: HardCode | null; why: string } {
  if (!outcome.actionable || outcome.verdict !== 'EXIT') return { exit: false, code: null, why: outcome.reason };
  const codes = outcome.samples.map((s) => s.payload?.reason_code as string);
  const code = codes[0];
  if (!HARD_CODES.includes(code as HardCode) || codes.some((c) => c !== code)) return { exit: false, code: null, why: '3 票都建議出場，但理由代碼不一致，照規則並記錄' };
  return { exit: true, code: code as HardCode, why: outcome.reason };
}
