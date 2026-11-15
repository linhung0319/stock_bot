// 指標。全部是對數列的純計算；資料不足時回傳 NaN（和 pandas rolling 的行為一致）。

/** 以 i 為最後一筆的 n 日簡單均線；不足 n 筆或含 NaN → NaN。 */
export function sma(xs: ArrayLike<number>, i: number, n: number): number {
  if (i - n + 1 < 0) return NaN;
  let s = 0;
  for (let k = i - n + 1; k <= i; k++) {
    const v = xs[k];
    if (!Number.isFinite(v)) return NaN;
    s += v;
  }
  return s / n;
}

/** 以 i 為最後一筆的 n 日最高（含當日）；不足 n 筆 → NaN。 */
export function rollingMax(xs: ArrayLike<number>, i: number, n: number): number {
  if (i - n + 1 < 0) return NaN;
  let m = -Infinity;
  for (let k = i - n + 1; k <= i; k++) {
    const v = xs[k];
    if (!Number.isFinite(v)) return NaN;
    if (v > m) m = v;
  }
  return m;
}

/** 距 52 週（252 個交易日）高點的跌幅，例如 -0.22。 */
export function drawdownFromHigh(close: ArrayLike<number>, i: number, n = 252): number {
  return close[i] / rollingMax(close, i, n) - 1;
}

/** n 個交易日的報酬（252 日報酬 = 動能排名用的 MOMP）。 */
export function trailingReturn(close: ArrayLike<number>, i: number, n = 252): number {
  if (i - n < 0) return NaN;
  return close[i] / close[i - n] - 1;
}

export function mean(xs: number[]): number {
  if (!xs.length) return NaN;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** 樣本標準差（ddof = 1，和 pandas 的 std 相同）。 */
export function stdev(xs: number[]): number {
  const n = xs.length;
  if (n < 2) return NaN;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return Math.sqrt(s / (n - 1));
}

export function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const a = [...xs].sort((p, q) => p - q);
  const h = a.length >> 1;
  return a.length % 2 ? a[h] : (a[h - 1] + a[h]) / 2;
}

/** 年化波動度：最近 n 個日報酬的樣本標準差 × √252。 */
export function annualizedVol(close: ArrayLike<number>, i: number, n = 126): number {
  if (i - n < 0) return NaN;
  const rets: number[] = [];
  for (let k = i - n + 1; k <= i; k++) rets.push(close[k] / close[k - 1] - 1);
  return stdev(rets) * Math.sqrt(252);
}

/**
 * 動能部位相對基準的超額波動（設計 §4.1）：
 * names 等權組合的日報酬 − 基準日報酬，取 [from, to) 這段的樣本標準差 × √252。
 * 某檔當天沒有報酬（NaN）時，等權平均只算有報酬的那幾檔；全部沒有或基準沒有 → 跳過那天。
 */
export function excessVol(
  retOf: (ticker: string) => ArrayLike<number> | undefined,
  names: string[],
  benchmark: string,
  from: number,
  to: number,
): number {
  const bench = retOf(benchmark);
  if (!bench) return NaN;
  const series = names.map((t) => retOf(t));
  const xs: number[] = [];
  for (let k = Math.max(0, from); k < to; k++) {
    let s = 0;
    let n = 0;
    for (const r of series) {
      const v = r ? r[k] : NaN;
      if (Number.isFinite(v)) {
        s += v;
        n++;
      }
    }
    const b = bench[k];
    if (n && Number.isFinite(b)) xs.push(s / n - b);
  }
  return stdev(xs) * Math.sqrt(252);
}

/** 皮爾森相關係數（健檢用：和現有持股的一年相關）。 */
export function correlation(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return NaN;
  const ma = mean(a.slice(0, n));
  const mb = mean(b.slice(0, n));
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let k = 0; k < n; k++) {
    sab += (a[k] - ma) * (b[k] - mb);
    saa += (a[k] - ma) ** 2;
    sbb += (b[k] - mb) ** 2;
  }
  return sab / Math.sqrt(saa * sbb);
}
