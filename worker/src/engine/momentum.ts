// 動能（設計 §3）：股票池、排名、進出場。
//   股票池：S&P 500 成分股 → 股價 > 5 → 前一日成交金額前 100 → 市值前 50
//   排名  ：252 個交易日報酬，由高到低
//   進出場：買排名前 5；持股掉出前 15 名或掉出股票池才賣

export interface UniverseRow {
  ticker: string;
  /** 市值排序用的權重（SPY 持股檔的權重 = 浮動市值）。 */
  weight: number;
  /** 前一交易日收盤（未調整）。 */
  close: number;
  /** 前一交易日成交金額（未調整收盤 × 成交量）。 */
  dollarVolume: number;
  /** 252 日還原權值報酬；資料不足時 NaN。 */
  momentum: number;
}

export interface UniverseOptions {
  minPrice?: number;
  liquid?: number;
  universe?: number;
}

export interface RankedStock {
  ticker: string;
  momentum: number;
  /** 1 起算。 */
  rank: number;
}

/** 穩定排序（相同鍵值維持原順序）。 */
function stableSort<T>(xs: T[], cmp: (a: T, b: T) => number): T[] {
  return xs
    .map((x, i) => ({ x, i }))
    .sort((a, b) => cmp(a.x, b.x) || a.i - b.i)
    .map((o) => o.x);
}

/** 由成分股資料建立 50 檔股票池並照動能排名。rows 的順序會影響同分時的取捨（照成分股檔的順序）。 */
export function rankUniverse(rows: UniverseRow[], opt: UniverseOptions = {}): RankedStock[] {
  const minPrice = opt.minPrice ?? 5;
  const nLiquid = opt.liquid ?? 100;
  const nUniverse = opt.universe ?? 50;
  const ok = rows.filter((r) => r.close > minPrice && r.dollarVolume > 0);
  // 成交金額前 100（由小到大穩定排序後取最後 100，和 Python 回測相同）
  const liquid = stableSort(ok, (a, b) => a.dollarVolume - b.dollarVolume).slice(-nLiquid);
  // 其中市值前 50
  const large = stableSort(liquid, (a, b) => b.weight - a.weight).slice(0, nUniverse);
  const ranked = stableSort(
    large.filter((r) => Number.isFinite(r.momentum)),
    (a, b) => b.momentum - a.momentum,
  );
  return ranked.map((r, k) => ({ ticker: r.ticker, momentum: r.momentum, rank: k + 1 }));
}

export interface SelectOptions {
  slots?: number;
  exitRank?: number;
  /** 不能新進場的代號：本月被任務 A 否決、使用者排除、已認養到自選（設計 §2.3、§6.2）。 */
  blocked?: Iterable<string>;
  /**
   * 同一家公司的不同類股（例如 GOOGL / GOOG）。同公司已經有一類在名單裡時，另一類不進場
   * （設計 §2.4：兩類股同時進前 5 名時只取排名較前的一類）。
   */
  companyOf?: (ticker: string) => string;
}

export interface Selection {
  /** 留任（照原本持有的順序）。 */
  keep: string[];
  /** 新進場（照排名）。 */
  added: string[];
  /** 出場，以及原因。 */
  exits: { ticker: string; why: 'RANK_OUT' | 'UNIVERSE_OUT'; rank: number | null }[];
  /** 新的名單 = keep + added。 */
  names: string[];
}

/**
 * order：股票池照排名由高到低的代號。held：目前的動能名單。
 * 留任：仍在股票池而且排名在 exitRank 以內。新進場：照排名往下補到 slots 檔。
 */
export function selectMomentum(order: string[], held: string[], opt: SelectOptions = {}): Selection {
  const slots = opt.slots ?? 5;
  const exitRank = opt.exitRank ?? 15;
  const blocked = new Set(opt.blocked ?? []);
  const companyOf = opt.companyOf ?? ((t: string) => t);
  const pos = new Map(order.map((t, k) => [t, k]));
  const keep: string[] = [];
  const exits: Selection['exits'] = [];
  for (const t of held) {
    const p = pos.get(t);
    if (p !== undefined && p < exitRank) keep.push(t);
    else exits.push({ ticker: t, why: p === undefined ? 'UNIVERSE_OUT' : 'RANK_OUT', rank: p === undefined ? null : p + 1 });
  }
  const companies = new Set(keep.map(companyOf));
  const added: string[] = [];
  for (const t of order) {
    if (keep.length + added.length >= slots) break;
    if (keep.includes(t) || blocked.has(t)) continue;
    const c = companyOf(t);
    if (companies.has(c)) continue;
    companies.add(c);
    added.push(t);
  }
  return { keep, added, exits, names: [...keep, ...added] };
}
