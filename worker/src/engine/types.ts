// 規則引擎的共用型別與設定。引擎是純函式：不讀網路、不讀時鐘、不碰儲存。
// 依據：docs/design/design_v2_momentum_2026-11-07.md（以下稱「設計」）。

export type Bucket = 'own' | 'mom' | 'core';

/** 核心桶的現金格（短期美債 ETF 或帳上現金），價格視為 1。 */
export const CASH = 'CASH';

/** 格子 = 某一桶裡的某一檔。key 是 `${bucket}:${ticker}`。 */
export type CellKey = string;
export type CellMap = Record<CellKey, number>;

export function cellKey(bucket: Bucket, ticker: string): CellKey {
  return `${bucket}:${ticker}`;
}
export function parseCell(key: CellKey): { bucket: Bucket; ticker: string } {
  const i = key.indexOf(':');
  return { bucket: key.slice(0, i) as Bucket, ticker: key.slice(i + 1) };
}

/** 自選慢規則狀態：STD = 標準、HALF = 減半（設計 §2.2）。 */
export type OwnState = 'STD' | 'HALF';
export type OwnAction = 'REDUCE' | 'READD';

/** 每張單的原因（設計 §2.1 第 6 點）。 */
export type Reason =
  | '動能換股'
  | '自選訊號'
  | '波動度減碼'
  | '崩盤規則'
  | '動能比例回調'
  | '單檔上限'
  | '跨桶上限'
  | '入金'
  | '出金'
  | '改比例'
  | '新增自選'
  | '移除自選'
  | '策略單補做'
  | 'AI 建議'
  | '起步';

/** 只因為比例漂移的原因；其餘是訊號（設計 §2.1 第 5 點）。 */
export const RATIO_REASONS: ReadonlySet<string> = new Set(['動能比例回調', '單檔上限', '跨桶上限']);

export interface EngineConfig {
  /** 三桶風險預算（設計 §2.1，預設 20 / 30 / 50）。 */
  ratio: { own: number; strat: number; core: number };
  /** 自選單檔超過 ownCapHi → 減回 ownCapTo（15% → 10%）。 */
  ownCapHi: number;
  ownCapTo: number;
  /** 跨桶：動能買進或調整時合計最多到 crossCapBuy；合計超過 crossCapHi → 減回 crossCapBuy。null = 不設。 */
  crossCapBuy: number | null;
  crossCapHi: number;
  /** 動能：持有檔數、出場名次、留任股偏離多少才回調、回調是否只搭便車。 */
  momSlots: number;
  exitRank: number;
  lazyBand: number | null;
  piggyback: boolean;
  /**
   * 動能每檔目標的基準。
   * 'total'：總資產 × Strategy 比例（設計 §2.1.1 的文字，上線用）。
   * 'system'：（總資產 − 自選桶實際市值）× strat ÷ (1 − own)（Python 回測的算法，重放驗收用）。
   */
  momBase: 'total' | 'system';
  /** 崩盤規則啟動時，核心與動能各留下的比例（0.5 = 減一半）。 */
  crashCut: number;
  /** 自選訊號單筆變動 ≥ 總資產這個比例 → 當天通知（設計 §2.5，B-7）。null = 全部等月報。 */
  urgentFrac: number | null;
  /** 小於總資產這個比例的缺口不補、不算一張單（0.25%）。 */
  orderMin: number;
  /** 依波動度減碼（設計 §4.1）。 */
  volScale: boolean;
  volHyst: number;
  volMinHistory: number;
  /**
   * true：先把 σ̃/σ 上限壓到 1 再加減緩衝（Python 回測的寫法，比例降下來後回不到 1）。
   * false：用原始比值加減緩衝（設計 §4.1 的文字）。見設計 §10 第 26 點。
   */
  volHystCapFirst: boolean;
  /**
   * true：合計超過 crossCapHi 一定減回（設計 §2.2：不需要搭便車）。
   * false：Python 回測的行為——留任股的回調被「搭便車」撤回時，跨桶上限的檢查也跟著沒做。
   * 見設計 §10 第 26 點。
   */
  crossTrimAlways: boolean;
  /** 核心桶持有的代號（上線 VOO；回測用 SPY 代理）。 */
  coreTicker: string;
}

export const DEFAULT_CONFIG: EngineConfig = {
  ratio: { own: 0.2, strat: 0.3, core: 0.5 },
  ownCapHi: 0.15,
  ownCapTo: 0.1,
  crossCapBuy: 0.1,
  crossCapHi: 0.15,
  momSlots: 5,
  exitRank: 15,
  lazyBand: 0.5,
  piggyback: true,
  momBase: 'total',
  crashCut: 0.5,
  urgentFrac: 0.05,
  orderMin: 0.0025,
  volScale: true,
  volHyst: 0.1,
  volMinHistory: 24,
  volHystCapFirst: false,
  crossTrimAlways: true,
  coreTicker: 'VOO',
};

export interface OwnPick {
  /** 已反映到帳上的慢規則狀態。 */
  applied: OwnState;
  /** 標準比重（占總資產）。 */
  stdWeight: number;
}

/** 跨日保存的規則狀態（由呼叫端存取；引擎只接收與回傳）。 */
export interface RuleState {
  own: Record<string, OwnPick>;
  /** 動能模型名單（照動能清單應該持有的代號）。 */
  heldMom: string[];
  /** 上一次月報的動能有效比例（波動度比例 × 崩盤規則）；null = 還沒跑過。 */
  effPrev: number | null;
  crash: boolean;
  /** 每個月報日的 σ（只用當時以前的資料算中位數）。 */
  volHist: number[];
  /** 目前的波動度比例；null = 歷史不足 24 個月，還沒開始減碼。 */
  volW: number | null;
}

export function emptyRuleState(): RuleState {
  return { own: {}, heldMom: [], effPrev: null, crash: false, volHist: [], volW: null };
}
