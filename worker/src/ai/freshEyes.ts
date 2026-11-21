// T63：「新眼光」（composite_layer_design §3）。純函式：不讀網路、不碰儲存。
//
//   審查與減半檢視的流程裡多一個角色，排在分析師之後、多空（減半檢視是三票）之前。它讀同一份證據包，
//   但拿不到前提、論點本文與歷次審查：給它的那一份由程式組（freshView），雲端排程向 Worker 取（GET /ai/task/<編號>/fresh）。
//   題目固定（FRESH_QUESTION）；輸出 new_risks（最多 3 條，每條一句加一個引用）。
//   程式檢查（checkNewRisks）：引用照 check.ts 的逐字檢查（同一個函式，沒有放寬）；引用要出自給它的那幾份文件；
//   和現有前提的字重疊高的拿掉（已經有人看了）；彼此重複的拿掉。
//   用途只有建議：列進「要看的事」（NEW_RISK，src/app/thesis.ts）、編輯論點頁可以帶進右欄。不影響三票、不影響檔位、不發通知。
//   頻率（freshPlan）：減半檢視每次都跑；定期審查每檔每 90 個日曆天最多一次。使用者看過不採用的，同一件事 180 天內不再列。
import { checkQuote, type EvidencePack, type PackDoc } from './check';
import { likeText } from './ownDraft';

/** 取文件的端點認的角色名稱（prompt 寫同樣的字）。 */
export const FRESH_ROLE = '新眼光';
/** 有新眼光的功能。 */
export const FRESH_FNS = ['OWN_REVIEW', 'OWN_DROP'] as const;
/** 最多列幾條（設計 §3）。 */
export const NEW_RISKS_MAX = 3;
/** 一條是一句話：最多幾個字（超過的不收，不截斷）。 */
export const NEW_RISK_TEXT_MAX = 120;
/** 定期審查：每檔每幾個日曆天最多跑一次新眼光。 */
export const FRESH_REVIEW_GAP_DAYS = 90;
/** 使用者看過不採用（或已經帶進論點）的，同一件事幾天內不再列（比照靜默期，G18）；列出來沒處理的也只列這麼久。 */
export const RISK_SEEN_DAYS = 180;
/**
 * 分析師替新眼光留的額度（設計 §3：8 份裡的 1 份）。份數之外另外留一次呼叫與一些字數，
 * 不然 8 份還沒用完、60,000 字或 6 次呼叫先用完時，留的那一份等於沒有。
 */
export const FRESH_RESERVE = { docs: 1, chars: 6_000, calls: 1 } as const;
/** 題目（設計 §3 原文）。 */
export const FRESH_QUESTION = '不看任何人的論點。這家公司現在最可能讓持有者後悔的三件事是什麼？各附原文引用。';

const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

/**
 * 這次要不要跑新眼光（程式決定，寫進證據包的 fresh_eyes 告訴 prompt）。
 *   只有系統預設前提的股票不跑：沒有使用者的前提，就沒有「前提以外」可言（草稿的反方三點已經在做這件事）。
 *   減半檢視每次都跑；定期審查看 lastFresh（這檔上一次有跑新眼光、而且結果有回來的定期審查的決策日），未滿 90 天不跑。
 * canFetch：這次能不能取文件（有目錄；不能時新眼光照樣跑，只是不能另外指定文件）。
 */
export function freshPlan(fn: string, asOf: string, opt: { defaultOnly: boolean; lastFresh?: string | null; canFetch: boolean }): NonNullable<EvidencePack['fresh_eyes']> {
  const base = { max_risks: NEW_RISKS_MAX, docs: opt.canFetch ? FRESH_RESERVE.docs : 0 };
  const off = (why: string) => ({ run: false, why, max_risks: NEW_RISKS_MAX, docs: 0 });
  if (!(FRESH_FNS as readonly string[]).includes(fn)) return off('這個功能沒有新眼光');
  if (opt.defaultOnly) return off('這檔還沒有使用者的論點（只有系統預設前提），不跑新眼光');
  if (fn === 'OWN_DROP') return { run: true, why: '減半檢視每次都跑新眼光', ...base };
  const last = opt.lastFresh ?? null;
  if (last && daysBetween(last, asOf) < FRESH_REVIEW_GAP_DAYS) return off(`這檔 ${last} 的定期審查跑過新眼光，未滿 ${FRESH_REVIEW_GAP_DAYS} 天（定期審查每檔每 ${FRESH_REVIEW_GAP_DAYS} 個日曆天最多一次）`);
  return { run: true, why: last ? `這檔上次跑新眼光的定期審查是 ${last}，已滿 ${FRESH_REVIEW_GAP_DAYS} 天` : '這檔的定期審查還沒跑過新眼光', ...base };
}

// ---------------------------------------------------------------- 給新眼光的那一份

/**
 * 給新眼光看的數字：價格（F）、跌幅拆解（A）、清單內的網頁來源（S）、可以取的文件的目錄（M）。
 * 其他一律不給：論點檔種類（T0）、預設前提的程式結果（D）、條件與觀察項（C、W）、事件清單（V：以上次審查為界，
 * 每日掃描的說明可能帶著條件的文字）、規則狀態（R：R5 是上一次審查的檔位）。
 */
const FRESH_FACT = /^(?:[FASM]\d+|M\+)$/;
/** 給新眼光看的文件種類：原文與標題。note（論點那一份、最近一次審查的摘要）與 rule 不給。 */
const FRESH_DOC_KINDS: ReadonlySet<PackDoc['kind']> = new Set(['filing', 'xbrl', 'news', 'price', 'table', 'web']);
const freshDoc = (d: PackDoc): boolean => FRESH_DOC_KINDS.has(d.kind) && !/^(?:thesis|review):/.test(d.source_id);

export interface FreshView {
  run_id: string;
  function: string;
  as_of: string;
  subject: EvidencePack['subject'];
  role: typeof FRESH_ROLE;
  question: string;
  /** 最多列幾條；可以指定幾份目錄裡的文件（0 = 這次不能取文件）。 */
  max_risks: number;
  docs: number;
  facts: EvidencePack['facts'];
  documents: PackDoc[];
  data_quality: EvidencePack['data_quality'];
  /** 這一份沒有什麼（給協調的主代理與看紀錄的人）。 */
  omitted: string[];
}

/**
 * 給新眼光的那一份（設計 §3：「拿不到前提、論點本文與歷次審查」）。pack：這次執行的證據包（已經含分析師取回的文件）。
 * 只留白名單裡的數字與原文；前提、題目（寫著要逐條檢查前提與提前審查的原因）、規則的動作與細節一律不帶。
 */
export function freshView(pack: EvidencePack): FreshView {
  const plan = pack.fresh_eyes;
  return {
    run_id: pack.run_id,
    function: pack.function,
    as_of: pack.as_of,
    subject: pack.subject,
    role: FRESH_ROLE,
    question: FRESH_QUESTION,
    max_risks: plan?.max_risks ?? NEW_RISKS_MAX,
    docs: plan?.docs ?? 0,
    facts: pack.facts.filter((f) => FRESH_FACT.test(f.id)),
    documents: pack.documents.filter(freshDoc),
    data_quality: pack.data_quality,
    omitted: ['使用者的前提', '論點本文', '歷次審查的結論與使用者的回應', '條件與觀察項', '事件清單', '規則狀態與上一次審查的檔位'],
  };
}

// ---------------------------------------------------------------- 送回的 new_risks

export type NewRiskDrop = 'FORMAT' | 'EXTRA' | 'QUOTE' | 'NOT_GIVEN' | 'OVERLAP' | 'DUP';

export interface NewRiskItem {
  /** 送回的第幾條（0 起；「要看的事」的鍵用）。 */
  k: number;
  text: string;
  source_id: string;
  date: string;
  quote: string;
  /** 通過檢查、可以列出來。 */
  ok: boolean;
  drop?: NewRiskDrop;
  /** 沒通過的原因（白話）。 */
  why?: string;
  /** OVERLAP：和哪一條前提重疊。 */
  premiseId?: string;
  /** 通過的：引用出自哪一份（顯示用；headline = 只有新聞標題，沒有全文）。 */
  doc?: { title: string; date: string; url: string | null; headline: boolean };
}

export interface NewRisksRecord {
  asked: true;
  /** 送回的結果有 new_risks 這個欄位（沒有 = 新眼光沒有交東西，或主代理漏了）。 */
  returned: boolean;
  items: NewRiskItem[];
}

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** 前提裡拿來比的字：本文、怎樣算不成立的每一句、怎樣算證實。 */
export interface PremiseWords {
  id: string;
  text: string;
  breaksIf?: string[] | string;
  confirmsIf?: string;
}
const wordsOf = (p: PremiseWords): string[] => [p.text, ...(Array.isArray(p.breaksIf) ? p.breaksIf : p.breaksIf ? [p.breaksIf] : []), p.confirmsIf ?? ''].filter((x) => typeof x === 'string' && x.trim());

/** 這一句和哪一條現有前提的字重疊高（已經有人看了）；沒有 → null。比法和草稿「文字很像」同一個函式（雙字組重疊 ≥ 0.6）。 */
export function overlapsPremise(text: string, premises: readonly PremiseWords[]): string | null {
  for (const p of premises) if (wordsOf(p).some((w) => likeText(text, w))) return p.id;
  return null;
}

/**
 * 檢查送回的 new_risks（不可信的輸入）。pack：這次執行的證據包（含分析師與新眼光取回的文件）。
 *   這次沒有請新眼光跑（pack.fresh_eyes.run 不是 true）→ null：送回了也不看（跑不跑由程式決定）。
 *   每一條的格式：{ text, source_id, date, quote }；一句話（NEW_RISK_TEXT_MAX 字以內）、一個引用。
 *   只看前 3 條；引用照 check.ts 逐字檢查，沒通過的那一條拿掉；引用的要是給新眼光的那幾份文件；
 *   和現有前提（證據包裡的）重疊高的拿掉；和前面通過的一條重複的拿掉。
 * 這裡不看「使用者看過不採用的」與信念：那兩樣在帳戶狀態裡，列「要看的事」時再濾一次（src/app/thesis.ts 的 openRisks）。
 */
export function checkNewRisks(pack: EvidencePack, raw: unknown): NewRisksRecord | null {
  if (pack.fresh_eyes?.run !== true) return null;
  if (!Array.isArray(raw)) return { asked: true, returned: raw !== undefined && raw !== null, items: [] };
  const docs = new Map(pack.documents.map((d) => [d.source_id, d]));
  const kept: NewRiskItem[] = [];
  const items = raw.slice(0, 10).map((r, k): NewRiskItem => {
    const o = typeof r === 'object' && r !== null && !Array.isArray(r) ? (r as Record<string, unknown>) : {};
    const full = typeof o.text === 'string' ? o.text.trim() : '';
    const it: NewRiskItem = { k, text: full.slice(0, NEW_RISK_TEXT_MAX * 2), source_id: str(o.source_id, 200), date: str(o.date, 10), quote: str(o.quote, 4000), ok: false };
    const drop = (d: NewRiskDrop, why: string, extra: Partial<NewRiskItem> = {}): NewRiskItem => ({ ...it, drop: d, why, ...extra });
    if (!full) return drop('FORMAT', '沒有寫是什麼事');
    if (full.length > NEW_RISK_TEXT_MAX) return drop('FORMAT', `太長（一句話，${NEW_RISK_TEXT_MAX} 字以內）`);
    if (k >= NEW_RISKS_MAX) return drop('EXTRA', `超過 ${NEW_RISKS_MAX} 條，只看前 ${NEW_RISKS_MAX} 條`);
    const ev = checkQuote(pack, { id: `N${k + 1}`, source_id: o.source_id, date: o.date, quote: o.quote, claim: full });
    if (!ev.ok) return drop('QUOTE', ev.why ?? '引用沒有通過檢查');
    const doc = docs.get(ev.source_id)!;
    if (!freshDoc(doc)) return drop('NOT_GIVEN', '引用的不是給新眼光的文件（論點那一份、審查的摘要不能引用）');
    const hit = overlapsPremise(full, pack.premises);
    if (hit) return drop('OVERLAP', `和現有的前提 ${hit} 的字重疊高（已經有人看了）`, { premiseId: hit });
    if (kept.some((x) => likeText(x.text, full))) return drop('DUP', '和前面一條是同一件事');
    const ok: NewRiskItem = { ...it, text: full, ok: true, doc: { title: doc.title, date: doc.date, url: doc.url ?? null, headline: doc.kind === 'news' } };
    kept.push(ok);
    return ok;
  });
  return { asked: true, returned: true, items };
}

/** 讀 ai_runs.new_risks：沒有或壞掉的都當成沒有。 */
export function parseNewRisks(raw: string | null | undefined): NewRisksRecord | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Partial<NewRisksRecord>;
    return o && o.asked === true ? { asked: true, returned: !!o.returned, items: Array.isArray(o.items) ? o.items : [] } : null;
  } catch {
    return null;
  }
}
