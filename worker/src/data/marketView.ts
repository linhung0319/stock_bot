// 把存下來的日線組成引擎要的 MarketView：所有代號對齊同一組交易日，i 是訊號日的位置。
// 引擎只收到「到訊號日為止、而且是最新的」資料；過期的代號不放進去，引擎用到時會丟出錯誤。
import type { Account, MarketView } from '../engine/account';
import type { Series } from './store';

export class StaleDataError extends Error {}

export interface BuiltView {
  view: MarketView;
  /** 交易日（由舊到新，最後一個是訊號日）。 */
  axis: string[];
  /** 最後一根不是訊號日、沒有放進 view 的代號。 */
  stale: string[];
  /** 中間缺 K 線、用前一天補的天數。 */
  filled: Record<string, number>;
}

/**
 * axisTicker：用它的交易日當時間軸（核心 ETF）。它本身必須有訊號日那一根，否則丟 StaleDataError。
 * 價格用還原權值收盤，再整段乘上一個倍數讓訊號日那天等於實際收盤：
 * 指標（均線、距高點、252 日報酬）含股利，換算股數用的訊號日價格是實際成交價。
 */
export function buildMarketView(series: Map<string, Series>, session: string, axisTicker: string): BuiltView {
  const ax = series.get(axisTicker);
  const axis = ax ? ax.d.filter((d) => d <= session) : [];
  if (!axis.length || axis[axis.length - 1] !== session) {
    throw new StaleDataError(`${axisTicker} 沒有 ${session} 的日線（最新到 ${axis[axis.length - 1] ?? '無'}）`);
  }
  const pos = new Map(axis.map((d, k) => [d, k]));
  const close: Record<string, Float64Array> = {};
  const stale: string[] = [];
  const filled: Record<string, number> = {};
  for (const [ticker, s] of series) {
    let last = s.d.length - 1;
    while (last >= 0 && s.d[last] > session) last--;
    if (last < 0 || s.d[last] !== session) {
      stale.push(ticker);
      continue;
    }
    const scale = s.a[last] > 0 ? s.c[last] / s.a[last] : 1;
    const arr = new Float64Array(axis.length).fill(NaN);
    for (let j = 0; j <= last; j++) {
      const k = pos.get(s.d[j]);
      if (k !== undefined) arr[k] = s.a[j] * scale;
    }
    // 上市之後中間缺的日子（停牌）用前一天的價格補；上市之前維持 NaN
    let seen = false;
    let n = 0;
    for (let k = 0; k < arr.length; k++) {
      if (Number.isFinite(arr[k])) seen = true;
      else if (seen) {
        arr[k] = arr[k - 1];
        n++;
      }
    }
    if (n) filled[ticker] = n;
    close[ticker] = arr;
  }
  return { view: { date: session, i: axis.length - 1, close }, axis, stale: stale.sort(), filled };
}

/**
 * 通知的 seq 是「訊號日在時間軸上的位置」。時間軸每天往前滑，存起來的位置會失效，
 * 所以每次載入帳戶後用通知的日期重算一次；超出時間軸的舊通知給 -1。
 */
export function rebaseNotifSeq(acct: Account, axis: string[]): void {
  const pos = new Map(axis.map((d, k) => [d, k]));
  for (const n of acct.notifs) {
    let k = pos.get(n.date);
    if (k === undefined) {
      // 通知日不是交易日（使用者在假日操作）：用它之前最近的交易日
      k = -1;
      for (let j = axis.length - 1; j >= 0; j--) {
        if (axis[j] <= n.date) {
          k = j;
          break;
        }
      }
    }
    n.seq = k;
  }
}
