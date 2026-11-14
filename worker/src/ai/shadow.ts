// 影子組合（design_v2 §2.3.1、§6.5；ai_layer_design §2.5）：照規則、照 AI、你實際三條線。
// 純函式：價格由呼叫端給（PriceBook）。
//
// 算法：每一筆「沒照規則做」或「規則和 AI 不同」的紀錄，都有三個股數變動（照規則、照 AI、你實際）。
// 「照規則 − 你實際」的股數差，從那天的收盤拿到觀察期結束（1、3、6 個月，事前定好、之後不改），
// 價差（含股利，用還原權值算報酬）就是「如果照規則做，會多（少）多少錢」。照 AI 同理。
// 限制：只算那一筆差異本身，不算之後的規則動作會怎麼改變它（例如之後規則又賣掉了）；觀察期就是為了限制這個誤差。
import type { ShadowRecord } from '../engine';

/** 觀察期（交易日）：1、3、6 個月。 */
export const HORIZONS = [
  { key: '1m', label: '1 個月', days: 21 },
  { key: '3m', label: '3 個月', days: 63 },
  { key: '6m', label: '6 個月', days: 126 },
] as const;

export interface PriceBook {
  /** 交易日（由舊到新）。 */
  axis: string[];
  /** 某一檔在第 k 個交易日的還原權值收盤；沒有就 NaN。 */
  adj(ticker: string, k: number): number;
}

/** 由存下來的日線組 PriceBook。axisTicker 的交易日當時間軸。 */
export function priceBook(series: Map<string, { d: string[]; a: number[] }>, axisTicker: string): PriceBook {
  const axis = series.get(axisTicker)?.d ?? [];
  const pos = new Map(axis.map((d, k) => [d, k]));
  const cache = new Map<string, Float64Array>();
  const arr = (t: string) => {
    let x = cache.get(t);
    if (!x) {
      x = new Float64Array(axis.length).fill(NaN);
      const s = series.get(t);
      if (s) s.d.forEach((d, j) => pos.has(d) && (x![pos.get(d)!] = s.a[j]));
      // 中間缺的用前一天補
      for (let k = 1; k < x.length; k++) if (!Number.isFinite(x[k]) && Number.isFinite(x[k - 1])) x[k] = x[k - 1];
      cache.set(t, x);
    }
    return x;
  };
  return { axis, adj: (t, k) => (k >= 0 && k < axis.length ? arr(t)[k] : NaN) };
}

/** 由引擎的市場資料組 PriceBook（價格已經是還原權值乘上固定倍數，報酬一樣）。 */
export function bookFromView(axis: string[], close: Record<string, ArrayLike<number>>): PriceBook {
  return { axis, adj: (t, k) => (k >= 0 && k < axis.length ? (close[t]?.[k] ?? NaN) : NaN) };
}

/** 某一天在時間軸上的位置（不是交易日就用之前最近的一天）。 */
export function indexOn(axis: string[], date: string): number {
  let lo = 0;
  let hi = axis.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (axis[mid] <= date) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

export interface ShadowRow {
  date: string;
  ticker: string;
  title: string;
  /** 照規則 − 你實際（股）。 */
  ruleDiff: number;
  /** 照 AI − 你實際（股）；沒有 AI 意見時 null。 */
  aiDiff: number | null;
  price: number;
  /** 各觀察期的金額差（照規則、照 AI）；還沒到的是 null。 */
  at: Record<string, { rule: number; ai: number | null } | null>;
  /** 到最新收盤為止。 */
  now: { rule: number; ai: number | null } | null;
}

export interface ShadowLine {
  key: string;
  label: string;
  /** 照規則比你實際多賺（正）或少賺（負）多少錢；只算已經過了觀察期的紀錄。 */
  rule: number;
  ai: number;
  /** 算進來的筆數（有股數差的）。 */
  nRule: number;
  nAi: number;
  /** 還沒過觀察期、沒算進來的筆數。 */
  pending: number;
}

export interface ShadowSummary {
  rows: ShadowRow[];
  lines: ShadowLine[];
  asOf: string | null;
}

export function shadowSummary(records: ShadowRecord[], book: PriceBook): ShadowSummary {
  const last = book.axis.length - 1;
  const rows: ShadowRow[] = [];
  for (const r of records) {
    if (!r.ticker) continue;
    const ruleDiff = r.rule - r.actual;
    const aiDiff = r.ai === null ? null : r.ai - r.actual;
    if (!ruleDiff && !aiDiff) continue;
    const k0 = indexOn(book.axis, r.date);
    const a0 = book.adj(r.ticker, k0);
    const value = (k: number) => {
      const a1 = book.adj(r.ticker!, k);
      if (!(a0 > 0) || !Number.isFinite(a1)) return null;
      const per = r.price * (a1 / a0 - 1);
      return { rule: ruleDiff * per, ai: aiDiff === null ? null : aiDiff * per };
    };
    const at: ShadowRow['at'] = {};
    for (const hz of HORIZONS) at[hz.key] = k0 >= 0 && k0 + hz.days <= last ? value(k0 + hz.days) : null;
    rows.push({ date: r.date, ticker: r.ticker, title: r.title, ruleDiff, aiDiff, price: r.price, at, now: k0 >= 0 && k0 < last ? value(last) : null });
  }
  const lines: ShadowLine[] = [...HORIZONS.map((h) => ({ key: h.key, label: h.label })), { key: 'now', label: '到現在' }].map(({ key, label }) => {
    const line: ShadowLine = { key, label, rule: 0, ai: 0, nRule: 0, nAi: 0, pending: 0 };
    for (const row of rows) {
      const v = key === 'now' ? row.now : row.at[key];
      if (!v) {
        line.pending++;
        continue;
      }
      if (row.ruleDiff) {
        line.rule += v.rule;
        line.nRule++;
      }
      if (v.ai !== null && row.aiDiff) {
        line.ai += v.ai;
        line.nAi++;
      }
    }
    return line;
  });
  return { rows: rows.reverse(), lines, asOf: book.axis[last] ?? null };
}

/** AI 判斷之後，這一檔相對基準的報酬（1、3、6 個月；還沒到的是 null）。 */
export function followUp(book: PriceBook, ticker: string, asOf: string, benchmark: string): Record<string, { ret: number; bench: number; excess: number } | null> {
  const k0 = indexOn(book.axis, asOf);
  const last = book.axis.length - 1;
  const out: Record<string, { ret: number; bench: number; excess: number } | null> = {};
  for (const hz of HORIZONS) {
    const k1 = k0 + hz.days;
    if (k0 < 0 || k1 > last) {
      out[hz.key] = null;
      continue;
    }
    const ret = book.adj(ticker, k1) / book.adj(ticker, k0) - 1;
    const bench = book.adj(benchmark, k1) / book.adj(benchmark, k0) - 1;
    out[hz.key] = Number.isFinite(ret) && Number.isFinite(bench) ? { ret, bench, excess: ret - bench } : null;
  }
  return out;
}

/**
 * 成績用 Beta(1,1) 後驗呈現（ai_layer_design §2.5）：對了 k 次、共 n 次 → 平均、90% 區間、P(準確率 > 50%)。
 * 用數值積分算，n 在幾百以內都夠準。
 */
export function betaSummary(k: number, n: number): { mean: number; lo: number; hi: number; pAbove50: number } {
  const a = k + 1;
  const b = n - k + 1;
  const N = 4000;
  const dens: number[] = [];
  let sum = 0;
  for (let i = 0; i < N; i++) {
    const x = (i + 0.5) / N;
    const v = Math.exp((a - 1) * Math.log(x) + (b - 1) * Math.log(1 - x));
    dens.push(v);
    sum += v;
  }
  let acc = 0;
  let lo = 0;
  let hi = 1;
  let above = 0;
  for (let i = 0; i < N; i++) {
    const prev = acc;
    acc += dens[i] / sum;
    const x = (i + 0.5) / N;
    if (prev < 0.05 && acc >= 0.05) lo = x;
    if (prev < 0.95 && acc >= 0.95) hi = x;
    if (x > 0.5) above += dens[i] / sum;
  }
  return { mean: a / (a + b), lo, hi, pAbove50: above };
}
