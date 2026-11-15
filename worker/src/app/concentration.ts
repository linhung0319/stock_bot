// T35：集中度與部位大小（own_thesis §3.6.3；計畫問題 P9）。兩件事都只說明、不改下單，結果放進「要看的事」。
//   集中度：自選股之間、自選與動能持股之間，近一年日報酬相關係數 ≥ CONC.corr 的股票連成一組，
//           合計占總資產 ≥ CONC.weight 就列一件（月報每月算一次，頻率見 thesis.ts 的 CONCENTRATION）。
//   部位大小：自選的市值占總資產 ≥ 標準比重的 SIZE.up 倍，而且還沒到單檔上限（到了由 F10 處理）→ OwnMeta.sizeFlag；
//             跌回 SIZE.down 倍以下才收回，所以越過一次只列一次。每個交易日更新（updateSizeFlags），列出在 thesis.ts 的 SIZE_2X。
// 純函式：不讀資料庫、網路、時鐘；引擎的規則不看這裡的任何結果。
import { DEFAULT_CONFIG, clone, totalValue, type Account, type MarketView } from '../engine';
import type { AttnHit } from './thesis';

/** 門檻（寫進 design_v2 §10 第 45 點）。corr 是一年日報酬相關係數；weight 是一組股票合計占總資產。 */
export const CONC = { corr: 0.7, weight: 0.15 } as const;
/** 部位大小：up = 往上越過幾倍標準比重時設旗，down = 跌回幾倍以下才收回。 */
export const SIZE = { up: 2, down: 1.5 } as const;

/** 一年日報酬的相關係數（和既有持股的題材重疊；F14 的證據包與集中度檢查共用）。資料不足 120 天回傳 null。 */
export function corr1y(view: MarketView, a: string, b: string): number | null {
  const ca = view.close[a];
  const cb = view.close[b];
  if (!ca || !cb) return null;
  const xs: number[] = [];
  const ys: number[] = [];
  for (let k = Math.max(1, view.i - 251); k <= view.i; k++) {
    const x = ca[k] / ca[k - 1] - 1;
    const y = cb[k] / cb[k - 1] - 1;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    xs.push(x);
    ys.push(y);
  }
  if (xs.length < 120) return null;
  const mx = xs.reduce((s, v) => s + v, 0) / xs.length;
  const my = ys.reduce((s, v) => s + v, 0) / ys.length;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let k = 0; k < xs.length; k++) {
    sxy += (xs[k] - mx) * (ys[k] - my);
    sxx += (xs[k] - mx) ** 2;
    syy += (ys[k] - my) ** 2;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}

const px = (view: MarketView, t: string): number | null => {
  const v = view.close[t]?.[view.i];
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
};
const total = (acct: Account, view: MarketView): number | null => {
  try {
    const v = totalValue(acct, view);
    return v > 0 ? v : null;
  } catch {
    return null;
  }
};
const pc = (x: number, d = 1) => `${(x * 100).toFixed(d)}%`;
const r4 = (x: number) => Math.round(x * 1e4) / 1e4;

// ---------------------------------------------------------------- 部位大小

export interface SizeNow {
  /** 這檔自選的市值占總資產。 */
  weight: number;
  /** 標準比重（慢規則的 stdWeight，不隨減半打折）。 */
  std: number;
  /** weight / std。 */
  ratio: number;
}

/** 這檔自選現在的部位大小；不是自選、沒有標準比重、算不出價格或總資產時回傳 null。只算自選桶的股數。 */
export function sizeOf(acct: Account, view: MarketView, ticker: string): SizeNow | null {
  const std = acct.rule.own[ticker]?.stdWeight;
  const p = px(view, ticker);
  const tv = total(acct, view);
  if (!acct.own[ticker] || !std || !(std > 0) || p === null || tv === null) return null;
  const weight = ((acct.lots.own[ticker] ?? 0) * p) / tv;
  return { weight, std, ratio: weight / std };
}

/**
 * 每個交易日更新每檔自選的 sizeFlag／sizeInfo（own_thesis §3.6.3）：
 *   還沒設旗：ratio ≥ 2 而且 weight 還沒到單檔上限 → 設旗，記越過的訊號日
 *   已經設旗：ratio ≤ 1.5 → 收回；否則只更新最新的比重與倍數（到了單檔上限也留著旗，只是不列）
 * 沒有變動時回傳同一個 acct（不複製）。
 */
export function updateSizeFlags(acct: Account, view: MarketView): Account {
  let next: Account | null = null;
  const capHi = acct.cfg.ownCapHi;
  for (const t of Object.keys(acct.own)) {
    const m = acct.own[t];
    const s = sizeOf(acct, view, t);
    if (!s) continue;
    if (!m.sizeFlag) {
      if (s.ratio >= SIZE.up && s.weight < capHi) {
        next ??= clone(acct);
        next.own[t].sizeFlag = true;
        next.own[t].sizeInfo = { at: view.date, weight: r4(s.weight), ratio: r4(s.ratio) };
      }
    } else if (s.ratio <= SIZE.down) {
      next ??= clone(acct);
      next.own[t].sizeFlag = false;
      next.own[t].sizeInfo = null;
    } else if (!m.sizeInfo || m.sizeInfo.weight !== r4(s.weight) || m.sizeInfo.ratio !== r4(s.ratio)) {
      next ??= clone(acct);
      next.own[t].sizeInfo = { at: m.sizeInfo?.at ?? view.date, weight: r4(s.weight), ratio: r4(s.ratio) };
    }
  }
  return next ?? acct;
}

/** SIZE_2X 的文字（T35；own_thesis §3.6.6 的表）。cfg 沒給用預設的單檔上限。 */
export function sizeText(ticker: string, weight: number, ratio: number, cfg: { ownCapHi: number; ownCapTo: number } = DEFAULT_CONFIG): string {
  return `${ticker} 占總資產 ${pc(weight)}，是標準比重的 ${ratio.toFixed(1)} 倍（超過 ${pc(cfg.ownCapHi, 0)} 會減回 ${pc(cfg.ownCapTo, 0)}）`;
}

// ---------------------------------------------------------------- 集中度

export interface ConcMember {
  ticker: string;
  /** 自選＋動能的市值占總資產（同一檔兩桶都有算在一起）。 */
  weight: number;
  own: boolean;
  mom: boolean;
}

export interface ConcGroup {
  /** 市值大的在前。 */
  members: ConcMember[];
  /** 合計占總資產。 */
  weight: number;
  /** 組內所有兩兩相關係數（含沒到門檻、靠別人連起來的那幾對）的範圍。 */
  corrMin: number;
  corrMax: number;
}

/**
 * 高度相關而且合計夠大的組合：自選與動能持股之間，相關係數 ≥ CONC.corr 的股票連成一組（A 和 B、B 和 C 各自夠高就算同一組），
 * 組內至少一檔是自選、合計占總資產 ≥ CONC.weight 才算。核心 ETF 不算（它本來就包含這些股票）。
 * 算不出相關係數（資料不足）的那一對當作不相關；算不出總資產時回傳空的。
 */
export function concentrationGroups(acct: Account, view: MarketView): ConcGroup[] {
  const tv = total(acct, view);
  if (tv === null) return [];
  const own = new Set(Object.keys(acct.own));
  const mom = new Set(Object.keys(acct.lots.mom).filter((t) => (acct.lots.mom[t] ?? 0) > 0));
  const ms: ConcMember[] = [];
  for (const t of [...new Set([...own, ...mom])].sort()) {
    const p = px(view, t);
    const sh = (acct.lots.own[t] ?? 0) + (acct.lots.mom[t] ?? 0);
    if (p === null || !(sh > 0)) continue;
    ms.push({ ticker: t, weight: (sh * p) / tv, own: own.has(t), mom: mom.has(t) });
  }
  // 兩兩相關係數，連成組（union-find）
  const idx = ms.map((_, k) => k);
  const find = (k: number): number => (idx[k] === k ? k : (idx[k] = find(idx[k])));
  const cor = new Map<string, number>();
  for (let a = 0; a < ms.length; a++) {
    for (let b = a + 1; b < ms.length; b++) {
      const c = corr1y(view, ms[a].ticker, ms[b].ticker);
      if (c === null) continue;
      cor.set(`${a}|${b}`, c);
      if (c >= CONC.corr) idx[find(a)] = find(b);
    }
  }
  const byRoot = new Map<number, number[]>();
  ms.forEach((_, k) => byRoot.set(find(k), [...(byRoot.get(find(k)) ?? []), k]));
  const out: ConcGroup[] = [];
  for (const ks of byRoot.values()) {
    if (ks.length < 2) continue;
    const members = ks.map((k) => ms[k]);
    const weight = members.reduce((s, m) => s + m.weight, 0);
    if (weight < CONC.weight || !members.some((m) => m.own)) continue;
    const cs = ks.flatMap((a, i) => ks.slice(i + 1).map((b) => cor.get(`${Math.min(a, b)}|${Math.max(a, b)}`))).filter((c): c is number => c !== undefined);
    out.push({ members: members.sort((x, y) => y.weight - x.weight || (x.ticker < y.ticker ? -1 : 1)), weight, corrMin: Math.min(...cs), corrMax: Math.max(...cs) });
  }
  return out.sort((a, b) => b.weight - a.weight);
}

/** 集中度那一件的文字。 */
export function concentrationText(g: ConcGroup): string {
  const names = g.members.map((m) => m.ticker).join('、');
  const range = g.corrMin.toFixed(2) === g.corrMax.toFixed(2) ? g.corrMax.toFixed(2) : `${g.corrMin.toFixed(2)}～${g.corrMax.toFixed(2)}`;
  const parts = g.members.map((m) => `${m.ticker}${m.mom && !m.own ? '（動能）' : m.mom ? '（含動能）' : ''} ${pc(m.weight)}`).join('、');
  return `${names} 走勢很像（近一年日報酬的相關係數 ${range}），合計占總資產 ${pc(g.weight)}（${parts}）。同一個題材出問題時會一起跌，要不要調整由你決定`;
}

export type ConcHit = AttnHit & { members: string[] };

/**
 * 集中度的「要看的事」：一組一件，掛在組內按字母排第一的自選股上（月報的頻率記在那一檔的 attnShown；
 * 掛哪一檔不隨市值變動，才不會每個月換一檔就當成新的事）。members 給持股頁用：組內的每一檔自選都顯示。
 * 沒有「從哪天起」：相關係數與占比每天都在變，since 留空（畫面不顯示「起」）。
 */
export function concentrationHits(acct: Account, view: MarketView): ConcHit[] {
  return concentrationGroups(acct, view).map((g) => {
    const names = g.members.map((m) => m.ticker).sort();
    const anchor = g.members.filter((m) => m.own).map((m) => m.ticker).sort()[0];
    // 文字以占比最大的開頭：點這一行去占比最大的那一檔自選（members 是市值大的在前）
    const link = g.members.find((m) => m.own)!.ticker;
    return { ticker: anchor, kind: 'CONCENTRATION', src: 'own' as const, key: `CONCENTRATION:${names.join('+')}`, every: 3, since: '', text: concentrationText(g), members: names, ...(link !== anchor ? { link } : {}) };
  });
}
