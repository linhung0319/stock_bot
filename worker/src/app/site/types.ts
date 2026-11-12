// 網站（T8）的共用型別：給畫面用的資料形狀。
// 原則：每一項建議都同時帶著「做什麼」和「因為什麼」，畫面不用再去別的地方找理由。
import type { Premise } from '../../engine';

/** AI 的說明（定期審查、否決、條件成立、崩盤檢視、硬事件）。AI 層上線前，只有示範模式有（假內容）。 */
export interface AiNote {
  kind: 'REVIEW' | 'VETO' | 'CONDITION' | 'CRASH' | 'HARD';
  ticker?: string;
  /** 這份說明的日期（顯示時取訊號日以前最新的一份）。 */
  date: string;
  /** 結論，例如「提高到標準的 125%」。 */
  verdict: string;
  votes?: string;
  summary: string;
  premises?: { text: string; origin: Premise['origin']; status: 'HOLDS' | 'BROKEN' | 'INSUFFICIENT'; evidence?: string }[];
  quotes?: { source: string; date: string; quote: string }[];
  conditions?: { kind: '財報' | '事件' | '價格'; text: string; then: string }[];
  sections?: { title: string; text: string }[];
  /** true = 示範用的假內容。 */
  fake: boolean;
}

export interface Fact {
  label: string;
  value: string;
  note?: string;
}

/**
 * 門檻尺：一條刻度上標出「現在在哪」和「規則的門檻在哪」。
 * 這個系統的規則幾乎都是門檻（跌 20%、前 15 名、200 日均線、15% 上限、±50%），所以用同一種圖。
 */
export interface Gauge {
  /** 刻度兩端的數值與文字。 */
  from: number;
  to: number;
  fromLabel: string;
  toLabel: string;
  /** 現在的位置。 */
  value: number;
  valueLabel: string;
  /** 門檻（可以有兩個，例如 ±50%）。 */
  marks: { at: number; label: string }[];
  /** 會觸發規則的區間（畫成底色）。 */
  zones: { from: number; to: number }[];
  caption: string;
}

export interface RankRow {
  rank: number;
  ticker: string;
  /** 252 日報酬。 */
  ret: number | null;
  mark: 'HELD' | 'IN' | 'OUT' | 'VETO' | 'EXCLUDED' | null;
}

/** 一項建議的理由。 */
export interface Explain {
  /** 一句話（列表上用），例如「排名掉到第 17，門檻是前 15」。 */
  short: string;
  /** 完整的理由（含數字），卡片上永遠顯示。 */
  why: string;
  gauge?: Gauge;
  /** 規則的白話文。 */
  rule?: string;
  facts?: Fact[];
  /** 股數怎麼算出來的。 */
  math?: string[];
  ranking?: RankRow[];
  /** 要畫走勢圖的代號。 */
  chart?: string;
  ai?: AiNote;
  /** 有 AI 的建議、但 AI 層還沒上線（沒有完整報告可以看）。 */
  aiMissing?: boolean;
  /** 每個選項的一句話說明（選項 id → 文字）。 */
  choiceNotes?: Record<string, string>;
}

export const BUCKET_NAME: Record<string, string> = { own: '自選', mom: '動能', core: '核心', unc: '未分類' };
