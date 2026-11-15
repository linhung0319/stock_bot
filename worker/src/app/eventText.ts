// 事件（sec_events）的白話：類別、來源、說明。持股頁（自選、動能）、討論包共用（T34；原本各寫一份，掃描事件的說明還帶英文代碼）。
// 純函式：不讀資料庫。
import { ITEM_EVENTS } from '../data/secEvents';
import { accOf, type SecEventRow } from './filings';

export const CODE_TEXT: Record<string, string> = {
  EARNINGS: '財報',
  MGMT_CHANGE: '高層異動',
  GUIDANCE_CUT: '財測',
  RESTRUCTURING: '重組',
  MAJOR_CONTRACT: '重大合約',
  FINANCING: '籌資',
  DILUTION: '增資',
  PENDING_MA: '被收購',
  ACCOUNTING: '會計問題',
  REGULATORY: '監管或訴訟',
  DISTRESS: '財務危機',
  CYBER: '資安事件',
  ACTIVIST: '大股東申報（13D）',
  EARNINGS_DIVERGENCE: '盈餘背離',
  ONE_OFF_JUMP: '一次性跳漲',
  DATA_SUSPECT: '資料可疑',
  PRICE_DROP: '個股自身大跌',
  CONDITION_HINT: '可能和條件有關',
  OTHER: '其他',
};

export const DETAIL_TEXT: Record<string, string> = {
  CUT: '財測下修',
  WITHDRAWN: '撤回財測',
  CEO_DEPART: '執行長離任',
  CFO_DEPART: '財務長離任',
  EXEC_APPOINT: '新任高層',
  OTHER_EXEC: '其他高層異動',
  DIRECTOR: '董事異動',
  NEW: '新的重大合約',
  ...Object.fromEntries(Object.values(ITEM_EVENTS).map((e) => [e.detailCode, e.text])),
};

/** 每日掃描的類別（ai/events.ts 的 SCAN_CLASSES）。三種「候選」是硬事件的候選，還要法庭判斷。 */
const SCAN_CLASS_TEXT: Record<string, string> = {
  ACCOUNTING_CANDIDATE: '可能是會計問題',
  REGULATORY_CANDIDATE: '可能是重大監管或訴訟',
  PENDING_MA_CANDIDATE: '可能被收購',
  ...CODE_TEXT,
};

const VIA_TEXT: Record<string, string> = { EDGAR: '申報分類', SCAN: '每日掃描', AI: 'AI 轉交', PRICE: '價格規則' };
const STATUS_TEXT: Record<string, string> = { NEW: '待處理', HANDLED: '已處理', INFO: '只記錄', IN_COURT: '審查中', EXPIRED: '過期' };

/** 事件類別的中文（有細項的用細項，例如「財測下修」「執行長離任」）。 */
export const eventLabel = (e: Pick<SecEventRow, 'code' | 'detail_code'>): string => (e.detail_code && DETAIL_TEXT[e.detail_code]) || CODE_TEXT[e.code] || '其他';

/** 事件的來源：申報的表單名稱（8-K、10-Q…）或「新聞標題」。 */
export function eventSource(e: Pick<SecEventRow, 'form' | 'accession'>): string {
  if (e.form === 'NEWS' || accOf(e.accession).kind === 'NEWS') return '新聞標題';
  if (e.form === 'AI') return 'AI 轉交';
  if (e.form === 'RULE') return '價格規則';
  return e.form;
}

/** 誰記下的（規則分類、每日掃描、AI 轉交、價格規則）。 */
export const eventVia = (source: string): string => VIA_TEXT[source] ?? source;

/** 處理狀態的白話。 */
export const eventStatus = (status: string): string => STATUS_TEXT[status] ?? status;

/**
 * 事件說明的白話：每日掃描寫的「每日掃描標記：GUIDANCE_CUT（CUT）；可能和 W1 有關（等申報原文證實）」
 * → 「每日掃描標記：財測（財測下修）；可能和你的條件有關（等申報原文證實）」。規則分類寫的本來就是中文，只把回測的代號換掉。
 */
export function eventDetail(detail: string | null | undefined): string | null {
  if (!detail) return null;
  let t = detail.replace(/\s+/g, ' ').trim();
  t = t.replace(/^每日掃描標記：([A-Z_]+)(?:（([A-Z_]+)）)?/, (_m, cls: string, sub?: string) => `每日掃描標記：${SCAN_CLASS_TEXT[cls] ?? '其他'}${sub ? `（${DETAIL_TEXT[sub] ?? '細項不明'}）` : ''}`);
  t = t.replace(/可能和 [A-Z]\d+(?:、[A-Z]\d+)* 有關/, '可能和你的條件有關');
  t = t.replace(/（B-\d+：/, '（回測：');
  return t;
}
