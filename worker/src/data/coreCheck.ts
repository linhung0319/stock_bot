// 核心 ETF 的資料檢查（core_ai §3.10，修 C12）：規則層新增的檢查，崩盤規則本身不動。
// 純函式：拿同一個 MarketView 裡的核心 ETF、基準（SPY）、短債 ETF 比一比，只抓資料錯誤。
// view.close 是還原權值（配息不會造成差距）。SPY 和 VOO 來自同一個來源（Yahoo）：抓得到單一代號的錯，抓不到整個來源的錯。
import { validBars } from '../engine/risk';
import { sma } from '../engine/indicators';
import type { MarketView } from '../engine/account';

/** 門檻取寬，只抓資料錯誤：VOO 和 SPY 追蹤同一個指數，平常日報酬差在 0.1 個百分點以內。 */
export const CORE_CHECK = { dayGap: 0.01, maGap: 0.015, bondJump: 0.01 };

export type CoreIssueCode = 'MA_SHORT' | 'DAY_GAP' | 'MA_GAP' | 'BOND_JUMP' | 'NO_BENCH';

/** 一個問題：代碼與算出來的數字（文字用）。 */
export interface CoreIssue {
  code: CoreIssueCode;
  /** DAY_GAP：最近一天的報酬；MA_GAP：收盤 ÷ 200 日均線 − 1；BOND_JUMP：短債最近一天的報酬。 */
  core?: number;
  bench?: number;
  bond?: number;
  /** MA_SHORT：到今天為止有幾根有效的收盤。 */
  bars?: number;
}

const at = (c: ArrayLike<number> | undefined, i: number): number => (c && i >= 0 ? c[i] : NaN);
const dayRet = (c: ArrayLike<number> | undefined, i: number): number => at(c, i) / at(c, i - 1) - 1;

/**
 * 回傳問題的清單（沒有問題是空陣列）：
 *   MA_SHORT  核心 ETF 不滿 200 根有效收盤（均線算不出來）
 *   DAY_GAP   核心 ETF 與基準最近一天的報酬差超過 1 個百分點（最新一根可能有錯）
 *   MA_GAP    兩者「收盤 ÷ 200 日均線 − 1」差超過 1.5 個百分點（歷史資料可能有錯）
 *   BOND_JUMP 短債 ETF 最近一天的報酬絕對值超過 1%（只影響換算股數）
 *   NO_BENCH  基準沒有今天的價格（這次沒辦法比；只記在流程紀錄，不告警）
 */
export function coreDataCheck(view: MarketView, core: string, bench: string, bond: string): CoreIssue[] {
  const out: CoreIssue[] = [];
  const i = view.i;
  const c = view.close[core];
  const b = view.close[bench];
  const coreMa = c ? sma(c, i, 200) : NaN;
  if (c && !Number.isFinite(coreMa)) out.push({ code: 'MA_SHORT', bars: validBars(c, i) });
  if (!b || !Number.isFinite(at(b, i))) out.push({ code: 'NO_BENCH' });
  else if (c) {
    const rc = dayRet(c, i);
    const rb = dayRet(b, i);
    if (Number.isFinite(rc) && Number.isFinite(rb) && Math.abs(rc - rb) > CORE_CHECK.dayGap) out.push({ code: 'DAY_GAP', core: rc, bench: rb });
    const benchMa = sma(b, i, 200);
    if (Number.isFinite(coreMa) && Number.isFinite(benchMa)) {
      const gc = at(c, i) / coreMa - 1;
      const gb = at(b, i) / benchMa - 1;
      if (Math.abs(gc - gb) > CORE_CHECK.maGap) out.push({ code: 'MA_GAP', core: gc, bench: gb });
    }
  }
  const rbond = dayRet(view.close[bond], i);
  if (Number.isFinite(rbond) && Math.abs(rbond) > CORE_CHECK.bondJump) out.push({ code: 'BOND_JUMP', bond: rbond });
  return out;
}

/** 會告警的代碼（NO_BENCH 只記在流程紀錄）。 */
export const ALERT_CODES: ReadonlySet<CoreIssueCode> = new Set(['DAY_GAP', 'MA_GAP', 'BOND_JUMP', 'MA_SHORT']);
/** 月報切換時要在項目與 LINE 提醒核對價格的代碼。 */
export const PRICE_CODES: ReadonlySet<string> = new Set(['DAY_GAP', 'MA_GAP']);

const pct = (x: number | undefined, d = 2): string => (x === undefined || !Number.isFinite(x) ? '—' : `${x >= 0 ? '+' : '-'}${Math.abs(x * 100).toFixed(d)}%`);
const md = (date: string): string => date.slice(5);

/** 一個問題的白話（DAY_GAP、MA_GAP 的括號內那一段；項目的 note 也用）。 */
function gapText(x: CoreIssue, core: string, bench: string, date?: string): string {
  if (x.code === 'DAY_GAP') return `${date ? `${md(date)} ` : ''}日報酬 ${core} ${pct(x.core)}、${bench} ${pct(x.bench)}`;
  return `相對 200 日均線 ${core} ${pct(x.core, 1)}、${bench} ${pct(x.bench, 1)}`;
}

/** CORE_PRICE_SUSPECT 告警的文字（core_ai §3.10）；NO_BENCH 沒有告警，回傳 null。 */
export function coreAlertText(x: CoreIssue, t: { core: string; bench: string; bond: string }, date: string): string | null {
  switch (x.code) {
    case 'DAY_GAP':
    case 'MA_GAP':
      return `${t.core} 的價格和 ${t.bench} 對不上：${gapText(x, t.core, t.bench, date)}（平常差不到 0.1 個百分點），可能是資料錯誤。崩盤規則照這個價格判斷；月報日之前請到券商核對 ${t.core} 的收盤價。`;
    case 'BOND_JUMP':
      return `${t.bond} 一天變動 ${pct(x.bond, 1).replace(/^\+/, '')}，可能是資料錯誤；清單裡短債的股數請核對。`;
    case 'MA_SHORT':
      return `${t.core} 只有 ${x.bars ?? 0} 根日線，200 日均線算不出來，可能是資料缺漏；崩盤規則維持原狀態。`;
    default:
      return null;
  }
}

/** 月報訊號日切換時 F5／F6 項目的 note（core_ai §3.10）；沒有 DAY_GAP、MA_GAP 是 null。 */
export function corePriceNote(issues: CoreIssue[], t: { core: string; bench: string }): string | null {
  const x = issues.find((i) => PRICE_CODES.has(i.code));
  if (!x) return null;
  return `${t.core} 的價格和 ${t.bench} 對不上（${gapText(x, t.core, t.bench)}），下單前請核對券商顯示的 ${t.core} 收盤價；對不上就選「這次不做」並寫理由。`;
}

/** LINE 月報在下單清單後面加的那一行（core_ai §3.10）。 */
export const corePriceLine = (core: string): string => `注意：${core} 的價格資料可能有誤，下單前先看網站。`;
