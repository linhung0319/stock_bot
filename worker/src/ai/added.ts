// T52：分析師向 Worker 取回的文件（web_evidence_design §1.2、§1.5）。純函式：不讀網路、不碰儲存。
//   取文件的端點（src/app/webEvidence.ts）把每一份取回的文件記在 ai_runs.added_docs（給 AI 的那一份原文，截過的就是截過的）；
//   表決時 check.ts 比對的原文＝證據包的文件＋這裡的文件（withAdded）。check.ts 本身不改：引用照樣要逐字出自原文。
//   原本的 pack_hash 不變（程式準備的那一份）；取回的文件另算 added_hash。
import { packHash, type EvidencePack, type PackDoc } from './check';

/** 每次執行最多取回幾份、合計幾個字、最多呼叫幾次端點（§1.5；設計第 6 章第 3 項）。 */
export const DOCS_MAX = 8;
export const DOCS_MAX_CHARS = 60_000;
export const DOCS_MAX_CALLS = 6;
/** 一次呼叫最多要幾份（多的回 LIMIT）。 */
export const DOCS_PER_CALL = 8;
/** 每份給 AI 的長度：網頁取開頭 12,000 字、同業申報取開頭 15,000 字（§1.5）。 */
export const WEB_GIVE = 12_000;
export const FILING_GIVE = 15_000;
/** 被拒絕的紀錄最多留幾筆（之後的只算次數）。 */
export const REFUSED_KEEP = 60;

/** 可以取文件的功能（§1.5）：定期審查、減半檢視、論點草稿（T55）、市場摘要（T64，composite_layer_design §1.4）。其他功能呼叫 → 403。 */
export const DOC_FNS = ['OWN_REVIEW', 'OWN_DROP', 'OWN_DRAFT', 'MARKET_BRIEF'] as const;

/** 目錄的一項（§1.2）：S1 同業在 EDGAR 的申報（kind filing）、S2 RSS 標題裡清單內的連結（kind web）。text 是放進 facts 的那一行。 */
export interface MenuEntry {
  id: string;
  kind: 'filing' | 'web';
  text: string;
  /** S1：同業的名稱、CIK、那一份申報。 */
  peer?: string;
  cik?: string;
  filing?: { accession: string; form: string; items: string[]; filingDate: string; acceptedAt: string; primaryDocument: string };
  /** S2：網址、RSS 的標題與發布時間。 */
  url?: string;
  title?: string;
  published?: string;
}

/** 組證據包時記下的「可以取什麼」（ai_runs.doc_ctx）。off：不能取的原因（只有系統預設前提）。 */
export interface DocCtx {
  menu: MenuEntry[];
  /** 網頁發布日早於這天 → TOO_OLD（上次有結論的審查前 120 天；沒有上一次時決策日前 365 天）。 */
  notBefore: string;
  /** 這檔的一手網域（OwnMeta.webSources.domains）。 */
  domains: string[];
  fileId: string | null;
  off?: string | null;
  /**
   * 這次執行有新眼光（T63，composite_layer_design §3）：分析師替它留的額度（份數、字數、呼叫次數；freshEyes.ts 的 FRESH_RESERVE）。
   * 沒有這個欄位 = 沒有新眼光：分析師可以用完全部的額度，角色寫「新眼光」的請求不給。
   */
  fresh?: { docs: number; chars: number; calls: number };
}

export type RefuseReason = 'NOT_LISTED' | 'BLOCKED' | 'THIN' | 'UNSUPPORTED' | 'NO_DATE' | 'TOO_OLD' | 'LIMIT' | 'ERROR';

export interface AddedDoc {
  /** 證據包裡的編號（A1、A2…；和原本的文件不重複）。 */
  id: string;
  source_id: string;
  kind: 'web' | 'filing';
  /** 網頁的級別；同業申報是 null。 */
  tier: 'PRIMARY' | 'NAMED' | 'MEDIA' | null;
  date: string;
  title: string;
  url: string | null;
  /** 給 AI 的原文（開頭 12,000／15,000 字，合計上限用完時再截）。 */
  text: string;
  truncated: boolean;
  fetched_at: string;
  via: 'MENU' | 'SEARCH';
  menu: string | null;
  /** 分析師說它和哪一條前提或條件有關（P5、C12；只是線索）。 */
  for: string | null;
  why: string | null;
  /** 要的角色（端點的 role；沒寫是 null）。 */
  role: string | null;
  at: string;
  /** web_docs 的列編號（同業申報沒有）。 */
  row_id: number | null;
  /** 網頁對到清單上的哪個來源（T53）：清單上的網域寫法（`trendforce.com`、這檔自己的 `news.skhynix.com`）與名稱。T52 存的舊紀錄沒有。 */
  domain?: string | null;
  label?: string | null;
}

export interface RefusedItem {
  url: string | null;
  menu: string | null;
  reason: RefuseReason;
  detail: string | null;
  for: string | null;
  why: string | null;
  at: string;
}

export interface AddedRecord {
  calls: number;
  chars: number;
  docs: AddedDoc[];
  refused: RefusedItem[];
  /** 被拒絕的總數（refused 只留前 REFUSED_KEEP 筆）。 */
  refusedTotal: number;
  /** 這次執行每個網站已經抓了幾篇（同一個網站最多 4 篇，§1.4）。 */
  sites: Record<string, number>;
  /** 其中新眼光呼叫了幾次（T63；沒有這個欄位 = 0）。 */
  freshCalls?: number;
}

export const emptyAdded = (): AddedRecord => ({ calls: 0, chars: 0, docs: [], refused: [], refusedTotal: 0, sites: {} });

/** 讀 ai_runs.added_docs：沒有或壞掉的都當成空的（舊列沒有這一欄）。 */
export function parseAdded(raw: string | null | undefined): AddedRecord {
  if (!raw) return emptyAdded();
  try {
    const o = JSON.parse(raw) as Partial<AddedRecord>;
    return { calls: Number(o.calls) || 0, chars: Number(o.chars) || 0, docs: Array.isArray(o.docs) ? o.docs : [], refused: Array.isArray(o.refused) ? o.refused : [], refusedTotal: Number(o.refusedTotal) || 0, sites: o.sites && typeof o.sites === 'object' ? o.sites : {}, ...(Number(o.freshCalls) ? { freshCalls: Number(o.freshCalls) } : {}) };
  } catch {
    return emptyAdded();
  }
}

/**
 * 網頁文件多帶的三樣（T53，web_evidence_design §1.6：級別決定它能觸發什麼）：級別、清單上的網域、來源名稱。
 * 由程式在取文件時記下（不是 AI 寫的）；放在證據包的文件上，判斷「合格的引用」時讀（src/ai/ownReview.ts）。
 * check.ts 的 PackDoc 不改：逐字引用檢查不看這三樣。
 */
export interface WebMeta {
  tier: 'PRIMARY' | 'NAMED' | 'MEDIA';
  domain: string;
  label: string;
}
export type WebPackDoc = PackDoc & Partial<WebMeta>;

const hostOf = (url: string | null | undefined): string => {
  try {
    return url ? new URL(url).hostname.toLowerCase().replace(/^www\./, '') : '';
  } catch {
    return '';
  }
};

/** 證據包裡一份網頁文件的級別與網域；不是網頁、或沒有級別（不該發生）→ null（當成不合格的來源）。 */
export function webMetaOf(d: PackDoc): WebMeta | null {
  if (d.kind !== 'web') return null;
  const w = d as WebPackDoc;
  if (w.tier !== 'PRIMARY' && w.tier !== 'NAMED' && w.tier !== 'MEDIA') return null;
  const domain = (w.domain || hostOf(d.url)).toLowerCase();
  return domain ? { tier: w.tier, domain, label: w.label || domain } : null;
}

/** 取回的文件 → 證據包的文件（網頁多帶級別、網域、來源名稱）。 */
export const packDocOf = (d: AddedDoc): WebPackDoc => ({
  id: d.id,
  source_id: d.source_id,
  kind: d.kind,
  date: d.date,
  title: d.title,
  ...(d.url ? { url: d.url } : {}),
  text: d.text,
  fetched_at: d.fetched_at,
  ...(d.kind === 'web' && d.tier ? { tier: d.tier, domain: (d.domain || hostOf(d.url)).toLowerCase(), label: d.label || d.domain || hostOf(d.url) } : {}),
});

/**
 * 表決用的證據包：原本的文件＋取回的文件（同一個 source_id 原本就有的不再加）。
 * 沒有取回任何文件時回原本那一份（同一個物件）。
 */
export function withAdded(pack: EvidencePack, docs: readonly AddedDoc[]): EvidencePack {
  if (!docs.length) return pack;
  const have = new Set(pack.documents.map((d) => d.source_id));
  const extra = docs.filter((d) => !have.has(d.source_id)).map(packDocOf);
  return extra.length ? { ...pack, documents: [...pack.documents, ...extra] } : pack;
}

/** 取回的文件的雜湊（ai_runs.added_hash）：給 AI 的那幾份，照取回的順序。 */
export async function addedHash(docs: readonly AddedDoc[]): Promise<string | null> {
  if (!docs.length) return null;
  return packHash({ documents: docs.map(packDocOf) } as unknown as EvidencePack);
}

// ---------------------------------------------------------------- 分析師自己回報的找資料紀錄（T53，§1.5 第 5 點）

/** 要查的問題最多幾個、搜尋最多幾次（§1.5；prompt 也寫同樣的數字）。超過的照樣存，網站寫明超過。 */
export const LOOKUP_QUESTIONS = 6;
export const LOOKUP_QUERIES = 6;
/**
 * T62（composite_layer_design §2.4 第 3 條）：審查與減半檢視的分析師對每一條前提的每一句 breaksIf 各列一個問題（沒有 breaksIf 的前提列一個），
 * 不佔上面的 6 個；所以這兩個功能的問題上限是 LOOKUP_QUESTIONS 加上證據包裡所有前提的句數（最多 5 條 × 3 句），存的時候最多留 6 + 15 + 3。
 */
export const LOOKUP_CLAUSE_FNS = ['OWN_REVIEW', 'OWN_DROP'] as const;
const LOOKUP_KEEP = { questions: 24, queries: 20, wanted: 40 } as const;

/** 證據包的前提各要列幾個「逐句」的問題：每一句 breaksIf 一個，沒有的列一個。信念不在審查的證據包裡。 */
export function clauseSlots(premises: { breaksIf?: string[] }[] | undefined | null): number {
  return (premises ?? []).reduce((s, p) => s + Math.max(1, Array.isArray(p.breaksIf) ? p.breaksIf.length : 0), 0);
}

/** 這個功能的分析師最多可以列幾個問題。 */
export function questionsCap(fn: string, premises: { breaksIf?: string[] }[] | undefined | null): number {
  return LOOKUP_QUESTIONS + ((LOOKUP_CLAUSE_FNS as readonly string[]).includes(fn) ? clauseSlots(premises) : 0);
}

/**
 * 送回的結果裡的 lookups（存進 ai_runs.lookups）：分析師列的問題、搜尋的字、想取的每一份與結果。
 * 這是 AI 自己寫的，只用來顯示「AI 這次另外找了什麼、為什麼」；取到幾份、被拒絕幾份以程式記的 added_docs 為準。
 */
export interface Lookups {
  questions: { for: string | null; ask: string }[];
  queries: string[];
  wanted: { url: string | null; menu: string | null; for: string | null; why: string | null; got: string | null }[];
}

const txt = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const refOf = (v: unknown): string | null => (typeof v === 'string' && /^[A-Z]{1,2}\d{1,4}$/.test(v.trim()) ? v.trim() : null);

/**
 * 不可信的輸入 → 固定的形狀；整份不是物件、或三樣都是空的 → null（＝沒有回報）。
 * 格式不對的項目丟掉，不因此退回整份結果（三票的結論不該因為這份附帶的紀錄寫錯而作廢）。
 */
export function cleanLookups(raw: unknown): Lookups | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const arr = (v: unknown, n: number): unknown[] => (Array.isArray(v) ? v.slice(0, n) : []);
  const questions = arr(o.questions, LOOKUP_KEEP.questions).flatMap((q) => {
    if (typeof q === 'string') return txt(q, 500) ? [{ for: null, ask: txt(q, 500)! }] : [];
    if (typeof q !== 'object' || q === null) return [];
    const r = q as Record<string, unknown>;
    const ask = txt(r.ask, 500) ?? txt(r.question, 500);
    return ask ? [{ for: refOf(r.for), ask }] : [];
  });
  const queries = arr(o.queries, LOOKUP_KEEP.queries).flatMap((q) => (txt(q, 300) ? [txt(q, 300)!] : []));
  const wanted = arr(o.wanted, LOOKUP_KEEP.wanted).flatMap((w) => {
    if (typeof w !== 'object' || w === null) return [];
    const r = w as Record<string, unknown>;
    const url = txt(r.url, 2000);
    const menu = txt(r.menu, 10);
    return url || menu ? [{ url, menu, for: refOf(r.for), why: txt(r.why, 300), got: txt(r.got, 200) }] : [];
  });
  return questions.length || queries.length || wanted.length ? { questions, queries, wanted } : null;
}

/** 讀 ai_runs.lookups：沒有或壞掉的都當成沒有回報。 */
export function parseLookups(raw: string | null | undefined): Lookups | null {
  if (!raw) return null;
  try {
    return cleanLookups(JSON.parse(raw));
  } catch {
    return null;
  }
}
