// 網站的 AI 紀錄（T9；design_v2 §6.6）：每一次 AI 執行一頁（輸入、每一票、檢查、結論、過程），「匯出 md 拿去問 AI」，
// 以及把 AI 紀錄轉成建議單上的 AI 說明（AiNote）。
import { DOC_FNS, LOOKUP_QUERIES, questionsCap, type AddedDoc, type RefuseReason } from '../../ai/added';
import { FRESH_ROLE } from '../../ai/freshEyes';
import { keptByChoice, type CheckedPremise, type CheckedSample, type Outcome } from '../../ai/check';
import { TIER_TEXT } from '../../data/webSources';
import { CRASH_REVIEW } from '../../ai/crash';
import { EVENT_SCAN, scanQualified } from '../../ai/events';
import { fnInfo, verdictText } from '../../ai/functions';
import { CAUSE_KIND_TEXT, CONFIDENCE_TEXT, MARKET_BRIEF, TRIGGER_TEXT, briefLine, briefResult, type BriefDetail } from '../../ai/marketBrief';
import { ENTRY_CODE_TEXT } from '../../ai/momEntry';
import { followUp, type PriceBook } from '../../ai/shadow';
import type { AiRun } from '../aiRuns';
import type { VetoEpisode } from '../momNotes';
import type { AiNote } from './types';

export const OUTCOME_LABEL: Record<Outcome['status'] | 'PENDING', string> = {
  PENDING: '等結果中',
  AGREED: '票數一致',
  INSUFFICIENT: '證據不足',
  SPLIT: '票數不一致',
  INVALID: '格式不合格',
  DATA_MISSING: '資料有缺漏',
  TIMEOUT: '逾時',
  NO_RESULT: '沒有結果',
};

const PREMISE_LABEL: Record<string, string> = { HOLDS: '成立', BROKEN: '不成立', INSUFFICIENT: '證據不足' };

// ---------------------------------------------------------------- 否決紀錄（momentum_ai §3.7）

/** 網站的否決紀錄一列：被否決者與遞補者之後 3、6 個月相對基準的超額報酬（還沒到或沒有價格是 null）。 */
export interface VetoRowView extends VetoEpisode {
  codeText: string;
  vetoed: { m3: number | null; m6: number | null };
  replacement: { m3: number | null; m6: number | null } | null;
}

/** book：已經存的價格（沒有就全部 null）；決策日起算（ai/shadow 的 followUp）。 */
export function vetoView(book: PriceBook | null, e: VetoEpisode, benchmark: string): VetoRowView {
  const after = (t: string) => {
    if (!book) return { m3: null, m6: null };
    const f = followUp(book, t, e.date, benchmark);
    return { m3: f['3m']?.excess ?? null, m6: f['6m']?.excess ?? null };
  };
  return { ...e, codeText: (e.code && ENTRY_CODE_TEXT[e.code]) || '進場審查的理由', vetoed: after(e.ticker), replacement: e.replacedBy ? after(e.replacedBy) : null };
}

export interface RunRow {
  id: string;
  date: string;
  label: string;
  ticker: string | null;
  verdict: string;
  status: keyof typeof OUTCOME_LABEL;
  statusLabel: string;
  /** 照規則（AI 的意見只記錄）。 */
  followRule: boolean;
  summary: string;
  fake: boolean;
}

export interface RunDetail extends RunRow {
  fn: string;
  question: string;
  rule: string;
  reason: string;
  actionable: boolean;
  votes: { verdict: string; text: string; n: number }[];
  samplesWanted: number;
  facts: { id: string; label: string; value: string; note?: string }[];
  premises: { id: string; text: string; origin: string | null; votes: { index: number; status: string; label: string; downgraded: boolean; /** 被程式改成證據不足的原因（白話；沒有被改是 null）。 */ note: string | null; evidence: string[] }[] }[];
  samples: {
    index: number;
    valid: boolean;
    verdict: string;
    rawVerdict: string | null;
    downgraded: boolean;
    model: string | null;
    issues: string[];
    abstainReason: string | null;
    report: string | null;
    evidence: { id: string; source: string; date: string; quote: string; claim: string; ok: boolean; why: string | null }[];
    conditions: { text: string; type: string | null; auto: boolean; why: string | null }[];
  }[];
  /** hidden（T53）：不顯示原文的原因（分析師取回的網頁：只列引用的片段與連結，web_evidence_design §1.4）；有值時 preview 是空的。 */
  documents: { source: string; kind: string; title: string; date: string; url: string | null; chars: number; preview: string; hidden?: string }[];
  process: { role: string; model: string | null; text: string }[];
  meta: { label: string; value: string }[];
  followUp: { label: string; text: string }[];
  /** 「AI 這次另外找了什麼」（T53，web_evidence_design §1.4、§1.5）；不能取文件的功能是 null。 */
  found: FoundView | null;
  /** 新眼光：前提以外的風險（T63，composite_layer_design §3）；沒有新眼光的功能、T63 之前的執行是 null。 */
  risks: RisksView | null;
  /** 市場摘要的內容（T65，composite_layer_design §1.8：AI 紀錄多一種）；不是市場摘要是 null。 */
  brief: BriefRunView | null;
}

/**
 * 紀錄頁的「市場摘要」（T65）：照程式檢查過的那一份（briefResult，和存進 market_briefs 的是同一個函式算的）。
 * 原因一律標「報導的說法」（§1.5：引用逐字對得上只證明報導這樣寫，不證明因果）；原因不明是合格的答案。
 */
export interface BriefRunView {
  state: 'PENDING' | 'READY' | 'FAILED';
  /** 一行結論（白話）。 */
  line: string;
  stage: string;
  manual: boolean;
  period: { from: string; to: string } | null;
  /** 這次為什麼開（每一次觸發一句）。 */
  triggers: string[];
  facts: string[];
  causes: { where: string; kind: string; text: string; confidence: string; headline: boolean; lowered: string | null; quotes: { quote: string; title: string; date: string; url: string | null }[] }[];
  unknown: boolean;
  clarity: string | null;
  changed: string | null;
  dropped: { what: string; text: string; why: string }[];
  notes: string[];
}

export function briefRunView(run: AiRun): BriefRunView | null {
  if (run.fn !== MARKET_BRIEF) return null;
  const d = (run.pack.rule.detail ?? {}) as Partial<BriefDetail>;
  const stage = d.stage === 'FINAL' ? '定稿' : '暫定稿';
  const base = { stage, manual: !!d.manual, period: d.period ?? null, triggers: (d.triggers ?? []).map((t) => (t.kind === 'MANUAL' ? '手動開的（量時間用，不分給個股、不上首頁與 LINE）' : `${TRIGGER_TEXT[t.kind] ?? t.kind}：${t.text}`)), facts: [], causes: [], unknown: false, clarity: null, changed: null, dropped: [], notes: [] };
  if (run.status === 'PENDING' || !run.outcome) return { ...base, state: 'PENDING', line: '研究員與主筆還在寫，結果回來之前沒有摘要。' };
  const r = briefResult(run.outcome, run.pack);
  if (!r || !r.ok) return { ...base, state: 'FAILED', line: `這次沒有寫成摘要：${r ? r.why : run.outcome.reason}。個股的審查照常，只是沒有這一份背景。` };
  const b = r.brief;
  const ev = new Map(b.evidence.map((e) => [e.id, e]));
  return {
    ...base,
    state: 'READY',
    line: `${briefLine(b)}。只說明：不下單、不改任何狀態；分給個股的審查當背景，不能當前提不成立的依據。`,
    period: b.period,
    facts: b.facts,
    causes: b.causes.map((c) => ({
      where: c.scope === 'MARKET' ? '大盤' : `族群 ${c.group ?? ''}`,
      kind: CAUSE_KIND_TEXT[c.kind] ?? c.kind,
      text: c.text,
      confidence: CONFIDENCE_TEXT[c.confidence] ?? c.confidence,
      headline: c.headline_only,
      lowered: c.lowered,
      quotes: c.evidence_ids.map((id) => ev.get(id)).filter((e): e is NonNullable<typeof e> => !!e).map((e) => ({ quote: e.quote, title: e.title.replace(/^〔[^〕]*〕/, ''), date: e.date, url: e.url })),
    })),
    unknown: b.unknown,
    clarity: b.clarity === 'HIGH' ? '各來源的說法一致' : '各來源的說法不一致，或來源不足',
    changed: b.changed_since_provisional,
    dropped: b.dropped.map((x) => ({ what: x.what === 'FACT' ? '數字' : '原因', text: x.text, why: x.why })),
    notes: b.notes,
  };
}

/**
 * 紀錄頁的「新眼光：前提以外的風險」（T63）：這次有沒有跑、列了幾件、哪幾件被程式拿掉與原因。
 * 只當建議：和三票的結論無關。state：OFF 這次沒有跑／PENDING 還沒有結果／NONE 沒有結果或沒有交清單／LISTED 有列（含全部被拿掉）。
 */
export interface RisksView {
  state: 'OFF' | 'PENDING' | 'NONE' | 'LISTED';
  line: string;
  items: { text: string; kept: boolean; note: string | null; quote: string; source: string | null; date: string | null; url: string | null }[];
}

/** T71（confirm_audit_design §4）：新風險不再列「要看的事」；通過的放持股頁的審查那一塊、帶進下一份草稿。 */
export function risksView(run: AiRun): RisksView | null {
  const plan = run.pack.fresh_eyes;
  if (!plan) return null;
  if (!plan.run) return { state: 'OFF', line: `這次沒有跑新眼光：${plan.why}。`, items: [] };
  if (run.status === 'PENDING') return { state: 'PENDING', line: '這次有跑新眼光（不看你的前提，找前提以外的風險），還沒有結果。', items: [] };
  const rec = run.newRisks ?? null;
  if (!rec) return { state: 'NONE', line: '這次有請新眼光跑，但這次執行沒有結果（逾時或被退回）。', items: [] };
  if (!rec.returned) return { state: 'NONE', line: '這次有請新眼光跑，但送回的結果裡沒有它的清單。', items: [] };
  const docs = new Map(run.pack.documents.map((d) => [d.source_id, d]));
  const items = rec.items.map((x) => {
    const d = docs.get(x.source_id);
    return { text: x.text, kept: x.ok, note: x.ok ? null : (x.why ?? '沒有通過檢查'), quote: x.quote, source: d?.title ?? null, date: d?.date ?? null, url: d?.url ?? null };
  });
  const kept = items.filter((x) => x.kept).length;
  const dropped = items.length - kept;
  const tail = '只當建議：不影響三票的結論、不影響檔位、不發通知。';
  const line = !items.length
    ? `新眼光沒有列出前提以外的風險。${tail}`
    : kept
      ? `新眼光列了 ${items.length} 件前提以外的風險，${kept} 件通過程式檢查${dropped ? `，${dropped} 件被拿掉` : ''}。通過的列在持股頁的審查那一塊，下一次 stock bot 草擬論點時會一起看。${tail}`
      : `新眼光列了 ${items.length} 件，都被程式拿掉（原因在下面）。${tail}`;
  return { state: 'LISTED', line, items };
}

/**
 * 審查紀錄頁的「AI 這次另外找了什麼、為什麼」（web_evidence_design §1.5 第 5 點、G22）。
 * state：NONE 沒有要找的／GOT 有取回文件／ZERO 想找但取到 0 份／OFF 這次不能找（只有系統預設前提）／PENDING 還沒有結果。
 * 取回與沒取到的以程式記的為準（ai_runs.added_docs）；問題與搜尋的字是分析師自己回報的（ai_runs.lookups）。
 */
export interface FoundView {
  state: 'NONE' | 'GOT' | 'ZERO' | 'OFF' | 'PENDING';
  line: string;
  questions: { about: string | null; ask: string }[];
  queries: string[];
  /** votes：幾票引用了它（還沒有結果時是 null）；quotes：被引用的片段。 */
  docs: { title: string; source: string; level: string; published: string; fetched: string; url: string | null; about: string | null; why: string | null; via: string; cut: string | null; votes: number | null; quotes: string[] }[];
  missed: { what: string; url: string | null; reason: string; about: string | null; why: string | null }[];
  /** 沒有列出的被拒絕筆數（紀錄只留前 60 筆）。 */
  missedMore: number;
  notes: string[];
}

const REFUSE_TEXT: Record<RefuseReason, string> = {
  NOT_LISTED: '排除或路徑不收',
  BLOCKED: '網站擋下',
  THIN: '內文太短（多半是付費牆或要登入）',
  UNSUPPORTED: '不是網頁（例如 PDF）',
  NO_DATE: '認不出發布日',
  TOO_OLD: '太舊',
  LIMIT: '超過這次執行的上限',
  ERROR: '沒有抓成',
};
/** 被拒絕的原因（白話；程式記的代號不給使用者看）。 */
function refuseText(reason: string, detail: string | null): string {
  if (reason === 'NOT_LISTED') return detail === 'EXCLUDED' ? '排除列表裡的網站（評論、預測或社群）：抓得到也不當證據' : detail === 'PATH' ? '這個網站只收特定的頁面（例如新聞稿），這一頁不收' : REFUSE_TEXT.NOT_LISTED;
  const base = REFUSE_TEXT[reason as RefuseReason] ?? '沒有抓成';
  if (reason === 'NO_DATE' || !detail) return base;
  return `${base}（${detail}）`;
}

/**
 * 網頁的級別（T68，confirm_audit_design §1.8）：判的時候用的（rating；還沒送回結果的是取回那一刻的 tier）；
 * 這次執行的來源評級剛評的另外寫理由。
 */
function webLevel(d: AddedDoc): string {
  const r = d.rating ?? d.tier;
  if (!r) return '網頁（級別不明）';
  const base = `網頁（${TIER_TEXT[r]}${r === 'PRIMARY' ? '來源' : ''}）`;
  return d.rated_here ? `${base}（這次評的：${d.rated_here}）` : base;
}

/** 取回的文件的標題：去掉程式加的「〔網頁｜…〕」與「（發布…抓）」「（只取開頭 N 字）」，那幾樣另外列。 */
const plainTitle = (t: string) =>
  t
    .replace(/^〔[^〕]*〕/, '')
    .replace(/（只取開頭 [\d,]+ 字）$/, '')
    .replace(/（發布 [^）]*抓）$/, '')
    .trim();

export function foundView(run: AiRun): FoundView | null {
  if (!(DOC_FNS as readonly string[]).includes(run.fn)) return null;
  // 條件確認（T85）只有候補進場條件的月底檢查那一種會取文件；新申報那一種（與舊的紀錄）不顯示這一塊
  if (run.fn === 'OWN_CONDITION' && (run.pack?.rule?.detail as { mode?: string } | undefined)?.mode !== 'MONTH_END') return null;
  const added = run.added ?? { calls: 0, chars: 0, docs: [], refused: [], refusedTotal: 0, sites: {} };
  const lk = run.lookups ?? null;
  const ctx = run.docCtx ?? null;
  // 舊紀錄（T52 之前）：沒有記下可以取什麼、沒有取過、也沒有回報 → 不顯示這一塊
  if (!ctx && !added.calls && !lk) return null;
  const votes = (run.outcome?.samples ?? []).filter((s) => s.valid);
  const menuText = (id: string | null) => (id ? (ctx?.menu.find((m) => m.id === id)?.text.replace(/｜/g, '，') ?? `目錄的第 ${id.replace(/^M/, '')} 項`) : null);
  const docs: FoundView['docs'] = added.docs.map((d) => {
    const cites = votes.map((s) => s.evidence.filter((e) => e.ok && e.source_id === d.source_id));
    const peer = /^〔同業申報｜(.+?)〕/.exec(d.title)?.[1];
    return {
      title: plainTitle(d.title),
      source: d.kind === 'filing' ? (peer ?? '同業') : (d.label ?? d.domain ?? '網頁'),
      level: d.kind === 'filing' ? '同業的申報' : webLevel(d),
      published: d.date,
      fetched: d.fetched_at.slice(0, 10),
      url: d.url,
      about: d.for,
      why: d.why,
      // 新眼光指定的那一份（T63）另外標出來：不是分析師為了某一條前提取的
      via: d.role?.trim() === FRESH_ROLE ? '新眼光從目錄指定的' : d.via === 'MENU' ? '從目錄挑的' : '分析師搜尋到的',
      cut: d.truncated ? `只給 AI 開頭 ${d.text.length.toLocaleString('en-US')} 字` : null,
      votes: run.outcome ? cites.filter((c) => c.length).length : null,
      quotes: [...new Set(cites.flat().map((e) => e.quote))].slice(0, 2),
    };
  });
  const missed: FoundView['missed'] = added.refused.map((r) => ({ what: menuText(r.menu) ?? r.url ?? '（沒有寫網址）', url: r.menu ? null : r.url, reason: refuseText(r.reason, r.detail), about: r.for, why: r.why }));
  const got = docs.length;
  const asked = added.calls ? got + added.refusedTotal : (lk?.wanted.length ?? 0);
  const notes: string[] = [];
  const cap = questionsCap(run.fn, run.pack?.premises);
  if (lk && lk.questions.length > cap) notes.push(`分析師列了 ${lk.questions.length} 個問題，超過規定的 ${cap} 個。`);
  if (lk && lk.queries.length > LOOKUP_QUERIES) notes.push(`分析師搜尋了 ${lk.queries.length} 次，超過規定的 ${LOOKUP_QUERIES} 次。`);
  if (added.calls && !lk) notes.push('分析師沒有回報要查的問題與搜尋的字；下面取回與沒取到的是程式記的。');
  let state: FoundView['state'];
  let line: string;
  if (got) {
    state = 'GOT';
    line = `分析師另外取回 ${got} 份文件，三票和原本的證據包一起讀。${added.refusedTotal ? `另外 ${added.refusedTotal} 份沒有取到。` : ''}`;
  } else if (asked) {
    state = 'ZERO';
    const by = new Map<string, number>();
    for (const m of added.refused) {
      const k = REFUSE_TEXT[m.reason] ?? REFUSE_TEXT.ERROR;
      by.set(k, (by.get(k) ?? 0) + 1);
    }
    const why = added.calls ? [...by].map(([k, n]) => `${k} ${n} 份`).join('、') || '都被拒絕' : '取文件的請求沒有送到（程式這邊沒有收到任何一次請求）';
    line = `想找 ${asked} 份，取到 0 份：${why}。審查照原本的證據包進行。`;
  } else if (ctx?.off) {
    state = 'OFF';
    line = `這次不能另外找資料：${ctx.off}。`;
  } else if (run.status === 'PENDING' || !run.outcome) {
    state = 'PENDING';
    line = '還沒有結果。';
  } else {
    state = 'NONE';
    line = lk?.questions.length || lk?.queries.length ? '分析師列了要查的問題，但沒有要取的文件。審查照原本的證據包進行。' : '沒有要找的：分析師讀完證據包，沒有列出要另外查的問題，也沒有取任何文件。';
  }
  return { state, line, questions: (lk?.questions ?? []).map((q) => ({ about: q.for, ask: q.ask })), queries: lk?.queries ?? [], docs, missed, missedMore: Math.max(0, added.refusedTotal - added.refused.length), notes };
}

function summaryOf(run: AiRun): string {
  const o = run.outcome;
  if (!o) return '雲端排程還在跑，結果回來之前照規則。';
  // 市場摘要（T65）：列表上寫第一個原因（報導的說法）或原因不明
  if (run.fn === MARKET_BRIEF) {
    const r = briefResult(o, run.pack);
    if (r?.ok) return briefLine(r.brief);
    if (r) return `沒有寫成：${r.why}`.slice(0, 240);
  }
  const first = pick(o)?.report?.split(/\n\s*\n/)[0]?.trim();
  return first ? first.slice(0, 240) : o.reason;
}

/** 代表這次結論的那一票：和結論一致的第一票，沒有就第一張合格的票。 */
function pick(o: Outcome): CheckedSample | undefined {
  return o.samples.find((s) => s.valid && s.verdict === o.verdict) ?? o.samples.find((s) => s.valid);
}

/** 一致選了「預設值」，而那個預設值是真的判斷（例如 F24 的 HOLD），不是字面上的證據不足。 */
const keptState = (o: Outcome): boolean => o.status === 'INSUFFICIENT' && !!o.verdict && keptByChoice(o.verdict, o.samples, Object.values(o.votes).reduce((a, b) => a + b, 0));
const outcomeLabel = (o: Outcome): string => (keptState(o) ? '一致：維持現狀' : OUTCOME_LABEL[o.status]);

/** 每日掃描沒有合格結論時的標題（own_thesis §2.6：不顯示成「沒有值得標的事」）。 */
export const SCAN_FAILED_TEXT = '掃描失敗，下一次重掃';

/** 舊的每月總經評語（崩盤規則不會切換的月份，direction NONE）：2026-11-15 拿掉，舊紀錄照樣看得到（core_ai §3.9）。 */
export const CRASH_MONTHLY_LABEL = '每月總經評語（已停用）';
const isCrashMonthly = (run: Pick<AiRun, 'fn' | 'pack'>): boolean => run.fn === CRASH_REVIEW && (run.pack.rule.detail as { direction?: string } | undefined)?.direction === 'NONE';

export function runRow(run: AiRun): RunRow {
  const o = run.outcome;
  const status = o?.status ?? 'PENDING';
  return {
    id: run.runId,
    date: run.asOf,
    label: isCrashMonthly(run) ? CRASH_MONTHLY_LABEL : fnInfo(run.fn).label,
    ticker: run.ticker,
    // 沒有一致的結論時，標題寫「照規則」，最多票的判斷只放在票數裡（避免被看成 AI 的結論）
    // 市場摘要（T65）：寫明是暫定稿還是定稿；沒寫成不寫「照規則」（它本來就不改變任何東西）
    verdict: !o ? '等結果中' : run.fn === EVENT_SCAN && !scanQualified(o) ? SCAN_FAILED_TEXT : run.fn === MARKET_BRIEF ? `${(run.pack.rule.detail as Partial<BriefDetail> | undefined)?.stage === 'FINAL' ? '定稿' : '暫定稿'}${o.status === 'AGREED' ? '寫好了' : '沒有寫成'}` : o.status === 'AGREED' || keptState(o) ? verdictText(run.fn, o.verdict) : '照規則',
    status,
    statusLabel: o ? outcomeLabel(o) : OUTCOME_LABEL.PENDING,
    followRule: o ? o.followRule : true,
    summary: summaryOf(run),
    fake: false,
  };
}

export const WEB_TEXT_HIDDEN = '網頁的全文不在這裡顯示：被引用的片段列在「AI 這次另外找了什麼」與每一票的引用，要看全文請開原始網址。';

/**
 * 一票對一條前提的判斷被程式改成證據不足的原因（沒有被改是 null）：引用沒通過逐字檢查被刪掉；
 * 或判成立但沒過 T61 的核對（composite_layer_design §2.1：沒有指出正面的引用、正面的引用逾期）。
 * 只寫短的一句（放在票的標籤裡）；日期與驗證頻率寫在那一票的「程式檢查發現」（check.ts 的 issues）。
 */
export function downgradeNote(c: Pick<CheckedPremise, 'downgradedFrom' | 'holdsIssue'>): string | null {
  if (!c.downgradedFrom) return null;
  if (c.holdsIssue?.why === 'STALE') return '原本判成立，引用逾期';
  if (c.holdsIssue?.why === 'NO_CONFIRM') return '原本判成立，沒有指出正面的引用';
  return '引用被刪';
}

const conditionText = (raw: Record<string, unknown>): string => {
  const t = typeof raw.text === 'string' ? raw.text : '';
  if (t) return t;
  return JSON.stringify(raw).slice(0, 200);
};

/** 說明裡的判斷代碼換成白話（例如 STANDARD → 回到標準）。 */
function plainVerdicts(fn: string, text: string): string {
  let out = text;
  for (const [code, label] of Object.entries(fnInfo(fn).verdicts).sort((a, b) => b[0].length - a[0].length)) out = out.replace(new RegExp(`\\b${code}\\b`, 'g'), label);
  return out;
}

export function runDetail(run: AiRun, followUp: Record<string, { ret: number; bench: number; excess: number } | null> | null = null): RunDetail {
  const o = run.outcome;
  const pack = run.pack;
  const pc = (x: number) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1)}%`;
  const models = [...new Set([...(o?.samples.map((s) => s.model) ?? []), ...run.process.map((p) => p.model)].filter((m): m is string => !!m))];
  return {
    ...runRow(run),
    fn: run.fn,
    question: pack.question,
    rule: pack.rule.action,
    reason: plainVerdicts(run.fn, o?.reason ?? '雲端排程還在跑；結果回來之前照規則。'),
    actionable: o?.actionable ?? false,
    votes: Object.entries(o?.votes ?? {}).map(([v, n]) => ({ verdict: v, text: verdictText(run.fn, v), n })),
    samplesWanted: pack.policy.samples,
    facts: pack.facts,
    premises: pack.premises.map((p) => ({
      id: p.id,
      text: p.text,
      origin: p.origin ?? null,
      votes: (o?.samples ?? []).flatMap((s) => {
        const c = s.premises.find((x) => x.premise_id === p.id);
        return c ? [{ index: s.index, status: c.status, label: PREMISE_LABEL[c.status], downgraded: !!c.downgradedFrom, note: downgradeNote(c), evidence: c.evidence_ids }] : [];
      }),
    })),
    samples: (o?.samples ?? []).map((s) => ({
      index: s.index,
      valid: s.valid,
      verdict: verdictText(run.fn, s.verdict),
      rawVerdict: s.rawVerdict === null ? null : verdictText(run.fn, s.rawVerdict),
      downgraded: s.valid && s.rawVerdict !== s.verdict,
      model: s.model,
      issues: s.issues,
      abstainReason: s.abstainReason,
      report: s.report,
      evidence: s.evidence.map((e) => ({ id: e.id, source: e.source_id, date: e.date, quote: e.quote, claim: e.claim, ok: e.ok, why: e.why ?? null })),
      conditions: s.conditions.map((c) => ({ text: conditionText(c.raw), type: c.type, auto: c.auto, why: c.why ?? null })),
    })),
    // 網頁的全文不放（著作權，web_evidence_design §1.4）：只列標題、連結與字數，被引用的片段在「AI 這次另外找了什麼」與每一票
    documents: pack.documents.map((d) => ({ source: d.source_id, kind: d.kind, title: d.title, date: d.date, url: d.url ?? null, chars: d.text.length, ...(d.kind === 'web' ? { preview: '', hidden: WEB_TEXT_HIDDEN } : { preview: d.text.slice(0, 1500) }) })),
    process: run.process.map((p) => ({ role: p.role, model: p.model ?? null, text: p.text })),
    meta: [
      { label: '決策日', value: run.asOf },
      { label: '建立', value: run.createdAt.replace('T', ' ').slice(0, 16) + ' UTC' },
      { label: '完成', value: run.completedAt ? run.completedAt.replace('T', ' ').slice(0, 16) + ' UTC' : '—' },
      { label: '模型', value: models.join('、') || '—' },
      { label: 'prompt 版本', value: run.promptVersion },
      { label: '證據包', value: run.packHash.slice(0, 19) + '…' },
      { label: '執行編號', value: run.runId },
      ...(run.packNotes.length ? [{ label: '組裝證據包時', value: run.packNotes.join('；') }] : []),
    ],
    followUp: followUp
      ? [
          ['1m', '1 個月後'],
          ['3m', '3 個月後'],
          ['6m', '6 個月後'],
        ].map(([k, label]) => {
          const f = followUp[k];
          return { label, text: f ? `${run.ticker} ${pc(f.ret)}，基準 ${pc(f.bench)}，相對 ${pc(f.excess)}` : '還沒到' };
        })
      : [],
    found: foundView(run),
    risks: risksView(run),
    brief: briefRunView(run),
  };
}

const CONDITION_KIND = (type: string | null): '財報' | '事件' | '價格' => (type?.startsWith('xbrl') ? '財報' : type?.startsWith('price') || type?.startsWith('ma_') ? '價格' : '事件');

/** AI 紀錄 → 建議單上的 AI 說明（只用有結論的；逾時、格式不合格的不顯示成 AI 意見）。 */
export function noteOfRun(run: AiRun): AiNote | null {
  const info = fnInfo(run.fn);
  const o = run.outcome;
  if (!info.note || !o || o.status === 'TIMEOUT' || o.status === 'NO_RESULT' || o.status === 'INVALID') return null;
  const s = pick(o);
  const voteText = o.status === 'AGREED' ? `${o.samples.length} 票一致` : Object.entries(o.votes).map(([v, n]) => `${verdictText(run.fn, v)} ${n} 票`).join('、');
  const evidence = new Map((s?.evidence ?? []).filter((e) => e.ok).map((e) => [e.id, e]));
  return {
    kind: info.note,
    ticker: run.ticker ?? undefined,
    date: run.asOf,
    verdict: verdictText(run.fn, o.verdict) + (keptState(o) ? '（票數一致，維持現狀）' : o.followRule && o.status !== 'AGREED' ? `（${OUTCOME_LABEL[o.status]}，照規則）` : ''),
    votes: voteText,
    summary: summaryOf(run),
    premises: run.pack.premises.map((p) => {
      const c = s?.premises.find((x) => x.premise_id === p.id);
      const ev = c?.evidence_ids.map((id) => evidence.get(id)?.claim).filter(Boolean).join('；');
      return { text: p.text, origin: p.origin === 'USER' || p.origin === 'AI_DRAFT_ACCEPTED' ? p.origin : 'SYSTEM_DEFAULT', status: c?.status ?? 'INSUFFICIENT', ...(ev ? { evidence: ev } : {}) };
    }),
    quotes: [...evidence.values()].map((e) => {
      const doc = run.pack.documents.find((d) => d.source_id === e.source_id);
      return { source: doc?.title ?? e.source_id, date: e.date, quote: e.quote, ...(doc?.kind === 'web' && doc.url ? { url: doc.url } : {}) };
    }),
    conditions: (s?.conditions ?? [])
      .filter((c) => c.auto && c.from === 'payload.conditions')
      .map((c) => ({ kind: CONDITION_KIND(c.type), text: conditionText(c.raw), then: typeof c.raw.tier_if_met === 'string' ? `建議${verdictText('OWN_REVIEW', c.raw.tier_if_met)}` : '重新審查' })),
    sections: run.process.map((p) => ({ title: p.role, text: p.text })),
    fake: false,
    runId: run.runId,
  };
}

/** 示範模式：腳本裡的假 AI 說明 → 紀錄列（只有列表，沒有完整的證據包）。 */
export function rowOfNote(n: AiNote, k: number): RunRow {
  const label = { REVIEW: '自選定期審查', VETO: '動能新股進場審查', CONDITION: '自選條件監測', CRASH: '崩盤規則檢視（已停用）', HARD: '持股硬事件' }[n.kind];
  return { id: `demo-${k}`, date: n.date, label, ticker: n.ticker ?? null, verdict: n.verdict, status: 'AGREED', statusLabel: n.votes ?? '', followRule: false, summary: n.summary, fake: true };
}

// ---------------------------------------------------------------- 匯出 md

export interface ExportContext {
  /** 帳戶分桶比例等背景（一兩行）。 */
  background: string[];
  ruleText?: string;
}

/** 「匯出給 AI」：背景＋這次的完整報告＋寫好的 prompt，一個 md 檔（design_v2 §6.6）。 */
export function exportMd(run: AiRun, ctx: ExportContext): string {
  const d = runDetail(run);
  const info = fnInfo(run.fn);
  const L: string[] = [];
  L.push(`# ${info.label}${run.ticker ? `：${run.ticker}` : ''}（${run.asOf}）`, '');
  L.push('## 請你做的事', '', info.askPrompt, '');
  L.push('## 背景', '', ...ctx.background.map((x) => `- ${x}`), `- 這份紀錄是 stock bot 的 AI 層產生的。AI 只能讀程式準備好的證據包（下面「證據包」一節），所有數字由程式算好；引用必須是原文的子字串，不合格的會被程式刪掉。`, '');
  if (ctx.ruleText) L.push(`規則：${ctx.ruleText}`, '');
  L.push('## 問題與規則的動作', '', `- 問 AI 的問題：${d.question}`, `- 規則這次的動作：${d.rule}`, '');
  L.push('## 結論', '', `- ${d.statusLabel}：${d.verdict}`, `- 票數：${d.votes.map((v) => `${v.text} ${v.n}`).join('、') || '—'}（要 ${d.samplesWanted} 票）`, `- ${d.reason}`, `- ${d.followRule ? '照規則（AI 的意見只記錄）' : 'AI 的建議可以採用（由你決定）'}`, '');
  if (d.facts.length) L.push('## 程式算好的數字', '', '| 編號 | 項目 | 數值 | 說明 |', '|---|---|---|---|', ...d.facts.map((f) => `| ${f.id} | ${f.label} | ${f.value} | ${f.note ?? ''} |`), '');
  if (d.premises.length) {
    L.push('## 前提逐條', '');
    for (const p of d.premises) L.push(`- **${p.id}** ${p.text}：${p.votes.map((v) => `第 ${v.index + 1} 票 ${v.label}${v.note ? `（${v.note}，改成證據不足）` : ''}`).join('；') || '沒有判斷'}`);
    L.push('');
  }
  d.samples.forEach((s) => {
    L.push(`## 第 ${s.index + 1} 票：${s.verdict}${s.downgraded ? `（原本是 ${s.rawVerdict}，證據不夠而降級）` : ''}${s.valid ? '' : '（格式不合格）'}`, '');
    if (s.model) L.push(`模型：${s.model}`, '');
    if (s.issues.length) L.push('程式檢查發現：', ...s.issues.map((x) => `- ${x}`), '');
    if (s.abstainReason) L.push(`證據不足的理由：${s.abstainReason}`, '');
    if (s.evidence.length) {
      L.push('引用：', '');
      for (const e of s.evidence) L.push(`- ${e.ok ? '✓' : '✗'} [${e.id}] ${e.source}（${e.date}）「${e.quote}」→ ${e.claim}${e.ok ? '' : `（被刪掉：${e.why}）`}`);
      L.push('');
    }
    if (s.conditions.length) L.push('條件：', ...s.conditions.map((c) => `- ${c.text}（${c.auto ? '自動追蹤' : `人工：${c.why}`}）`), '');
    if (s.report) L.push('報告：', '', s.report, '');
  });
  if (d.process.length) {
    L.push('## 過程（每個角色的完整輸出）', '');
    for (const p of d.process) L.push(`### ${p.role}${p.model ? `（${p.model}）` : ''}`, '', p.text, '');
  }
  if (d.found) {
    L.push('## AI 這次另外找了什麼', '', d.found.line, '');
    if (d.found.questions.length) L.push('要查的問題：', ...d.found.questions.map((q) => `- ${q.about ? `${q.about}：` : ''}${q.ask}`), '');
    if (d.found.queries.length) L.push('搜尋的字：', ...d.found.queries.map((q) => `- ${q}`), '');
    if (d.found.docs.length) L.push('取回的文件：', ...d.found.docs.map((x) => `- ${x.title}（${x.source}，${x.level}，發布 ${x.published}，${x.fetched} 抓${x.cut ? `，${x.cut}` : ''}）${x.url ? ` ${x.url}` : ''}${x.why ? `；為什麼要：${x.why}` : ''}；${x.votes ? `${x.votes} 票引用` : '沒有被引用'}`), '');
    if (d.found.missed.length) L.push('沒有讀到的：', ...d.found.missed.map((x) => `- ${x.what}：${x.reason}${x.why ? `；為什麼要：${x.why}` : ''}`), '');
  }
  if (d.risks) {
    L.push('## 新眼光：前提以外的風險', '', d.risks.line, '');
    if (d.risks.items.length) L.push(...d.risks.items.map((x) => `- ${x.kept ? '列入' : `拿掉（${x.note}）`}：${x.text}${x.quote ? `｜引用：「${x.quote}」${x.source ? `（${x.source}）` : ''}` : ''}`), '');
  }
  L.push('## 證據包', '');
  for (const doc of run.pack.documents) {
    if (doc.kind === 'web') {
      // 網頁不附全文（著作權）：只附被引用的片段與連結
      const quotes = [...new Set((run.outcome?.samples ?? []).flatMap((s) => s.evidence.filter((e) => e.ok && e.source_id === doc.source_id).map((e) => e.quote)))];
      L.push(`### ${doc.source_id}：${doc.title}（${doc.date}）`, doc.url ? `來源：${doc.url}` : '', '', '（網頁不附全文，只附被引用的片段；要看全文請開上面的網址）', ...(quotes.length ? quotes.map((q) => `> ${q}`) : ['（沒有被引用）']), '');
      continue;
    }
    L.push(`### ${doc.source_id}：${doc.title}（${doc.date}）`, doc.url ? `來源：${doc.url}` : '', '', '```', doc.text.length > 6000 ? doc.text.slice(0, 6000) + '\n…（以下省略，完整原文在網站）' : doc.text, '```', '');
  }
  L.push('---', ...d.meta.map((m) => `${m.label}：${m.value}`));
  return L.filter((x, i, a) => !(x === '' && a[i - 1] === '')).join('\n');
}
