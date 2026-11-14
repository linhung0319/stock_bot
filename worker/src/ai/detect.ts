// T11：規則偵測段的純函式（不用 LLM、不讀網路）：單日漲幅占比、資訊離散度、盈餘背離、股數增加、資料可疑、跌幅拆解。
// 依據：ai_layer_design F1 ②③④⑥、F7、F20；B-9（backtest/b9_common.py 的 jump_metrics）。
import type { ConceptFact } from '../data/secEvents';

// ---------------------------------------------------------------- 單日漲幅占比（ONE_OFF_JUMP）

export interface JumpMetrics {
  r12: number;
  /** 資訊離散度 ID = sign(12 個月報酬) × (下跌天數占比 − 上漲天數占比)。只顯示，不當否決（B-9）。 */
  id: number;
  j1Share: number | null;
  j3Share: number | null;
  /** 最大單日（3 日）之後 63 個交易日相對基準；決策日前還沒走完 63 天是 null。 */
  j1Post: number | null;
  j3Post: number | null;
  /** 最大單日（3 日）在幾個交易日前。 */
  j1Ago: number;
  j3Ago: number;
}

/**
 * 決策日（位置 i，含）為止可知的單日漲幅占比。占比 = 最大單日（或 3 日）對數報酬 ÷ 12 個月對數報酬（12 個月報酬 > 0 才有意義）。
 * 和 B-9 的 jump_metrics 相同。
 */
export function jumpMetrics(close: ArrayLike<number>, bench: ArrayLike<number>, i: number, lookback = 252, post = 63): JumpMetrics | null {
  if (i - lookback < 0) return null;
  const w: number[] = [];
  const s: number[] = [];
  for (let k = i - lookback; k <= i; k++) {
    w.push(close[k]);
    s.push(bench[k]);
  }
  if (w.some((x) => !Number.isFinite(x)) || w[0] <= 0) return null;
  const lr = w.slice(1).map((x, k) => Math.log(x / w[k]));
  const tot = lr.reduce((a, b) => a + b, 0);
  const n = lr.length;
  const up = lr.filter((x) => x > 0).length / n;
  const dn = lr.filter((x) => x < 0).length / n;
  const out: JumpMetrics = { r12: Math.exp(tot) - 1, id: Math.sign(tot) * (dn - up), j1Share: null, j3Share: null, j1Post: null, j3Post: null, j1Ago: 0, j3Ago: 0 };
  for (const k of [1, 3] as const) {
    const roll = k === 1 ? lr : lr.slice(0, n - k + 1).map((_, j) => lr[j] + lr[j + 1] + lr[j + 2]);
    let j = 0;
    for (let q = 1; q < roll.length; q++) if (roll[q] > roll[j]) j = q;
    const end = j + k;
    const share = tot > 0 ? roll[j] / tot : null;
    let rel: number | null = null;
    if (end + post <= n && Number.isFinite(s[end]) && Number.isFinite(s[end + post])) rel = w[end + post] / w[end] / (s[end + post] / s[end]) - 1;
    if (k === 1) Object.assign(out, { j1Share: share, j1Post: rel, j1Ago: n - end });
    else Object.assign(out, { j3Share: share, j3Post: rel, j3Ago: n - end });
  }
  return out;
}

/** F1 ②：最大單日或 3 日占 12 個月漲幅 > 50%，而且之後 63 個交易日相對基準 ≤ 0（決策日前已經走完）。B-9：不要放寬門檻。 */
export const JUMP_SHARE = 0.5;
export function oneOffJump(m: JumpMetrics | null): { hit: boolean; detail: string } | null {
  if (!m) return null;
  const pc = (x: number | null) => (x === null ? '—' : (x * 100).toFixed(0) + '%');
  const hit1 = m.j1Share !== null && m.j1Share > JUMP_SHARE && m.j1Post !== null && m.j1Post <= 0;
  const hit3 = m.j3Share !== null && m.j3Share > JUMP_SHARE && m.j3Post !== null && m.j3Post <= 0;
  return { hit: hit1 || hit3, detail: `最大單日占 12 個月漲幅 ${pc(m.j1Share)}（之後 63 天相對大盤 ${pc(m.j1Post)}，${m.j1Ago} 個交易日前）；最大 3 日占 ${pc(m.j3Share)}（之後 ${pc(m.j3Post)}）；資訊離散度 ${m.id.toFixed(2)}（只顯示）` };
}

// ---------------------------------------------------------------- 盈餘背離（EARNINGS_DIVERGENCE）

const DAY = 86400_000;
const span = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / DAY) + 1;

export interface EpsQuarter {
  end: string;
  eps: number;
  filed: string;
  /** 第四季由全年減前三季推算（EPS 不能直接相加，只是近似）。 */
  derived: boolean;
}

/** 稀釋 EPS 的單季值，每一期取「最早申報」的值（ai_layer F1 ③）；只用決策日以前申報的。 */
export function epsQuarters(facts: ConceptFact[], asOf: string, n = 8): EpsQuarter[] {
  const first = new Map<string, ConceptFact>();
  for (const f of facts) {
    if (!f.start || f.filed > asOf || !Number.isFinite(f.val)) continue;
    const k = `${f.start}|${f.end}`;
    const prev = first.get(k);
    if (!prev || f.filed < prev.filed) first.set(k, f);
  }
  const all = [...first.values()];
  const q = new Map<string, EpsQuarter>();
  for (const f of all) {
    const d = span(f.start!, f.end);
    if (d >= 80 && d <= 100) q.set(f.end, { end: f.end, eps: f.val, filed: f.filed, derived: false });
  }
  for (const f of all) {
    const d = span(f.start!, f.end);
    if (d < 350 || d > 380 || q.has(f.end)) continue;
    const inside = [...q.values()].filter((x) => x.end > f.start! && x.end < f.end && !x.derived);
    if (inside.length !== 3) continue;
    q.set(f.end, { end: f.end, eps: f.val - inside.reduce((a, x) => a + x.eps, 0), filed: f.filed, derived: true });
  }
  return [...q.values()].sort((a, b) => (a.end < b.end ? 1 : -1)).slice(0, n);
}

/**
 * F1 ③：最近兩季 EPS 年增由正轉負，或連兩季下降，而 12 個月股價上漲。
 * 年增 = 這一季 − 去年同季（EPS 可能是負數，所以比差額，不比百分比）。
 */
export function earningsDivergence(qs: EpsQuarter[], r12: number): { hit: boolean; detail: string } | null {
  if (qs.length < 6) return null;
  const yoy = (k: number) => {
    const back = qs.find((x) => x.end < qs[k].end && span(x.end, qs[k].end) > 350 && span(x.end, qs[k].end) < 380);
    return back ? qs[k].eps - back.eps : null;
  };
  const y0 = yoy(0);
  const y1 = yoy(1);
  const turned = y0 !== null && y1 !== null && y0 < 0 && y1 >= 0;
  const twoDown = qs[0].eps < qs[1].eps && qs[1].eps < qs[2].eps;
  const f = (x: number) => x.toFixed(2);
  const detail = `最近三季稀釋 EPS ${qs.slice(0, 3).map((x) => `${x.end} ${f(x.eps)}${x.derived ? '（推算）' : ''}`).join('、')}；年增 ${y0 === null ? '—' : f(y0)}、前一季年增 ${y1 === null ? '—' : f(y1)}；12 個月股價 ${(r12 * 100).toFixed(0)}%`;
  return { hit: r12 > 0 && (turned || twoDown), detail };
}

// ---------------------------------------------------------------- 股數增加（DILUTION，只顯示）

/** 流通股數 6 個月增加多少（dei:EntityCommonStockSharesOutstanding；只用決策日以前申報的）。 */
export function shareGrowth(facts: ConceptFact[], asOf: string): { growth: number; now: number; before: number } | null {
  const pick = (cut: string) => facts.filter((f) => f.filed <= cut && Number.isFinite(f.val)).sort((a, b) => (a.filed === b.filed ? (a.end < b.end ? -1 : 1) : a.filed < b.filed ? -1 : 1)).at(-1);
  const now = pick(asOf);
  const before = pick(new Date(Date.parse(asOf) - 182 * DAY).toISOString().slice(0, 10));
  if (!now || !before || before.val <= 0) return null;
  return { growth: now.val / before.val - 1, now: now.val, before: before.val };
}

// ---------------------------------------------------------------- 資料可疑（F1 ⑥）

/** 過去 252 個交易日裡，日變動超過 25%、而前後一天都沒有申報的日子（價格資料可能有錯，暫停這檔的進場）。 */
export function suspectMoves(close: ArrayLike<number>, axis: string[], i: number, filingDates: string[], limit = 0.25): string[] {
  const fd = new Set(filingDates);
  const out: string[] = [];
  for (let k = Math.max(1, i - 251); k <= i; k++) {
    const r = close[k] / close[k - 1] - 1;
    if (!Number.isFinite(r) || Math.abs(r) <= limit) continue;
    const near = [axis[k - 1], axis[k], axis[k + 1]].some((d) => d && fd.has(d));
    if (!near) out.push(`${axis[k]}（${(r * 100).toFixed(0)}%）`);
  }
  return out;
}

// ---------------------------------------------------------------- 跌幅拆解（F7、F20）

export interface Attribution {
  from: string;
  to: string;
  stock: number;
  market: number;
  /** 產業 ETF 減大盤；沒有產業 ETF 時是 null。 */
  sector: number | null;
  /** 個股減產業（沒有產業時減大盤）。 */
  idio: number;
  sectorTicker: string | null;
}

/** 從位置 a 到 b：個股、大盤、產業各漲跌多少（簡單相減，不是迴歸）。 */
export function attribution(axis: string[], close: Record<string, ArrayLike<number>>, ticker: string, market: string, sector: string | null, a: number, b: number): Attribution | null {
  const r = (t: string | null) => {
    const c = t ? close[t] : undefined;
    return c && Number.isFinite(c[a]) && Number.isFinite(c[b]) && c[a] > 0 ? c[b] / c[a] - 1 : null;
  };
  const st = r(ticker);
  const mk = r(market);
  if (st === null || mk === null) return null;
  const se = r(sector);
  return { from: axis[a], to: axis[b], stock: st, market: mk, sector: se === null ? null : se - mk, idio: se === null ? st - mk : st - se, sectorTicker: se === null ? null : sector };
}

/** 52 週高點在哪一天（F7 的跌幅從那天算）。 */
export function highIndex(close: ArrayLike<number>, i: number, days = 252): number {
  let best = i;
  for (let k = Math.max(0, i - days + 1); k <= i; k++) if (close[k] >= close[best]) best = k;
  return best;
}

export function attributionText(x: Attribution): string {
  const p = (v: number) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;
  return `${x.from}～${x.to}：個股 ${p(x.stock)}；大盤 ${p(x.market)}${x.sector === null ? '' : `、產業（${x.sectorTicker}）比大盤 ${p(x.sector)}`}、個股自身 ${p(x.idio)}`;
}

// ---------------------------------------------------------------- SIC → 產業 ETF（B-9 的 sic_to_etf，2018 以後的版本）

export function sicToEtf(sic: string | number | null | undefined): string | null {
  if (sic === null || sic === undefined || sic === '') return null;
  const s = Number(sic);
  if (!Number.isFinite(s)) return null;
  const inR = (a: number, b: number) => s >= a && s <= b;
  if (s === 6798 || inR(6500, 6553)) return 'XLRE';
  if ((inR(6000, 6411) && s !== 6324) || inR(6700, 6799)) return 'XLF';
  if (s === 6324 || inR(2833, 2836) || inR(3841, 3851) || inR(8000, 8099) || [5122, 5047, 8731, 3826].includes(s)) return 'XLV';
  if ([1311, 1381, 1382, 1389, 2911, 2990, 1221, 1222, 4922, 4923, 5171, 5172, 4610, 4612, 4613, 3533].includes(s)) return 'XLE';
  if (inR(4900, 4949) || s === 4991) return 'XLU';
  if ([4812, 4813, 4899, 7370, 7374].includes(s)) return 'XLC';
  if ([2711, 2721, 4832, 4833, 4841, 7812, 7822, 7990, 7997].includes(s)) return 'XLC';
  if (inR(3570, 3579) || (inR(3600, 3699) && ![3630, 3634, 3651].includes(s)) || inR(7371, 7379) || [3577, 3825, 3827, 5045, 7389].includes(s)) return 'XLK';
  if (inR(2000, 2199) || inR(2840, 2844) || [5411, 5912, 5331, 5141, 5180, 5190, 2676].includes(s)) return 'XLP';
  if (inR(1000, 1499) || inR(2600, 2699) || inR(2800, 2829) || inR(2850, 2899) || inR(3200, 3399) || [2400, 2421, 2430, 2451].includes(s)) return 'XLB';
  if (inR(5000, 5999) || inR(7000, 7099) || inR(3710, 3716) || inR(2300, 2399) || inR(3630, 3659) || [3140, 3942, 3944, 3949, 7200, 7900, 1531, 1520, 8200, 8211, 8600, 7500, 7510, 2510, 2520, 3021].includes(s)) return 'XLY';
  return 'XLI';
}
