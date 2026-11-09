// 共用小工具：亂數、日期、格式化、指標計算
// 所有檔案都用一般 <script> 載入（不是 ES module），直接雙擊 index.html 用 file:// 開就能跑。
(function (G) {
  'use strict';

  // 可重現的亂數（mulberry32）
  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function gauss(r) {
    let u = 0, v = 0;
    while (u === 0) u = r();
    while (v === 0) v = r();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  function hashStr(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  // 交易日（只跳過週末，不處理假日）
  function isoDate(dt) {
    const y = dt.getUTCFullYear(), m = dt.getUTCMonth() + 1, d = dt.getUTCDate();
    return y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
  }
  // 美股休市日（只放原型會用到的幾天）
  const HOLIDAYS = { '2026-11-26': 1, '2026-12-25': 1, '2027-01-01': 1, '2027-01-18': 1, '2027-02-15': 1, '2027-04-02': 1, '2026-09-07': 1, '2026-07-03': 1, '2026-05-25': 1, '2026-06-19': 1 };
  function tradingDays(startIso, nBefore, nAfter) {
    const out = [];
    const start = new Date(startIso + 'T00:00:00Z');
    // 往前
    const before = [];
    let dt = new Date(start);
    while (before.length < nBefore) {
      dt.setUTCDate(dt.getUTCDate() - 1);
      const wd = dt.getUTCDay();
      if (wd !== 0 && wd !== 6 && !HOLIDAYS[isoDate(dt)]) before.push(isoDate(dt));
    }
    before.reverse();
    out.push(...before);
    dt = new Date(start);
    while (out.length < nBefore + nAfter) {
      const wd = dt.getUTCDay();
      if (wd !== 0 && wd !== 6 && !HOLIDAYS[isoDate(dt)]) out.push(isoDate(dt));
      dt.setUTCDate(dt.getUTCDate() + 1);
    }
    return out;
  }
  const WD = ['日', '一', '二', '三', '四', '五', '六'];
  function weekday(iso) { return WD[new Date(iso + 'T00:00:00Z').getUTCDay()]; }

  // 格式化
  function money(x, digits) {
    if (x === null || x === undefined || isNaN(x)) return '—';
    const d = digits === undefined ? 0 : digits;
    const s = Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
    return (x < 0 ? '-$' : '$') + s;
  }
  function pct(x, digits) {
    if (x === null || x === undefined || isNaN(x)) return '—';
    const d = digits === undefined ? 1 : digits;
    return (x * 100).toFixed(d) + '%';
  }
  function spct(x, digits) {
    if (x === null || x === undefined || isNaN(x)) return '—';
    return (x >= 0 ? '+' : '') + pct(x, digits);
  }
  function px(x) { return x === undefined || x === null ? '—' : x.toFixed(2); }
  function esc(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // 指標
  function sma(arr, i, n) {
    if (i - n + 1 < 0) return null;
    let s = 0;
    for (let k = i - n + 1; k <= i; k++) s += arr[k];
    return s / n;
  }
  function maxBack(arr, i, n) {
    let m = -Infinity;
    for (let k = Math.max(0, i - n + 1); k <= i; k++) if (arr[k] > m) m = arr[k];
    return m;
  }
  function ema(arr, i, n) {
    const k = 2 / (n + 1);
    let e = arr[Math.max(0, i - 4 * n)];
    for (let j = Math.max(0, i - 4 * n) + 1; j <= i; j++) e = arr[j] * k + e * (1 - k);
    return e;
  }
  function macdHist(arr, i) {
    // MACD(12,26,9) 柱：只用簡化算法（足夠示範用）
    const macdAt = (j) => ema(arr, j, 12) - ema(arr, j, 26);
    const k = 2 / 10;
    let sig = macdAt(Math.max(0, i - 40));
    for (let j = Math.max(0, i - 40) + 1; j <= i; j++) sig = macdAt(j) * k + sig * (1 - k);
    return macdAt(i) - sig;
  }
  function stdev(xs) {
    if (xs.length < 2) return 0;
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    return Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1));
  }
  function corr(a, b) {
    const n = Math.min(a.length, b.length);
    const ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n;
    let sab = 0, saa = 0, sbb = 0;
    for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
    return sab / Math.sqrt(saa * sbb);
  }
  function floorThird(x) { return Math.max(0, Math.min(1, Math.floor(x * 3 + 1e-9) / 3)); }
  function thirdLabel(w) {
    if (w >= 0.999) return '1';
    if (Math.abs(w - 2 / 3) < 0.01) return '2/3';
    if (Math.abs(w - 1 / 3) < 0.01) return '1/3';
    return '0';
  }

  G.U = { rng, gauss, hashStr, tradingDays, weekday, money, pct, spct, px, esc, sma, maxBack, ema, macdHist, stdev, corr, floorThird, thirdLabel };
})(typeof window !== 'undefined' ? window : globalThis);
