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

/** 可以取文件的功能（§1.5）：定期審查、減半檢視、論點草稿（T55）。其他功能呼叫 → 403。 */
export const DOC_FNS = ['OWN_REVIEW', 'OWN_DROP', 'OWN_DRAFT'] as const;

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
}

export const emptyAdded = (): AddedRecord => ({ calls: 0, chars: 0, docs: [], refused: [], refusedTotal: 0, sites: {} });

/** 讀 ai_runs.added_docs：沒有或壞掉的都當成空的（舊列沒有這一欄）。 */
export function parseAdded(raw: string | null | undefined): AddedRecord {
  if (!raw) return emptyAdded();
  try {
    const o = JSON.parse(raw) as Partial<AddedRecord>;
    return { calls: Number(o.calls) || 0, chars: Number(o.chars) || 0, docs: Array.isArray(o.docs) ? o.docs : [], refused: Array.isArray(o.refused) ? o.refused : [], refusedTotal: Number(o.refusedTotal) || 0, sites: o.sites && typeof o.sites === 'object' ? o.sites : {} };
  } catch {
    return emptyAdded();
  }
}

/** 取回的文件 → 證據包的文件。 */
export const packDocOf = (d: AddedDoc): PackDoc => ({ id: d.id, source_id: d.source_id, kind: d.kind, date: d.date, title: d.title, ...(d.url ? { url: d.url } : {}), text: d.text, fetched_at: d.fetched_at });

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
