// T65：漲太多的提示（RUNUP；composite_layer_design §1.7，Y7）。只在「要看的事」列一行：不開審查、不下單、不發通知。
//   這檔（自選股）的產業 ETF 過去兩年比大盤（核心 ETF）多漲 ≥ 100 個百分點 → 一件。每檔每 6 個月列一次（月報）；持股頁成立就顯示。
//   門檻來自產業層級的研究（漲太多會提高之後兩年內大跌的機率，但不降低平均報酬），所以只看產業 ETF，不套到個股。
//   兩年的漲幅是簡單相減（產業 ETF 的報酬 − 核心 ETF 的報酬），和跌幅拆解同一種算法（設計第 6 章：不用 beta）。
// runupHits 是純函式；loadRunupHits 讀產業 ETF 的對照與價格（網站與月報的 view 不一定有產業 ETF）。
import { buildMarketView } from '../data/marketView';
import { loadSeries } from '../data/store';
import type { Account, MarketView } from '../engine';
import { sectorEtfs } from './filings';
import type { AttnHit } from './thesis';

export const RUNUP = {
  /** 兩年大約幾個交易日（Yahoo 的 2y 日線約 501 根，所以用 500）。 */
  days: 500,
  /** 至少要有幾個交易日才算（資料不夠兩年時不列，不用較短的期間代替）。 */
  minDays: 480,
  /** 產業 ETF 比核心 ETF 多漲幾（1 = 100 個百分點）。 */
  excess: 1,
  /** 月報同一檔隔幾個月再列。 */
  every: 6,
} as const;

const fin = (x: number | undefined): x is number => typeof x === 'number' && Number.isFinite(x) && x > 0;
const pct = (x: number) => `${x >= 0 ? '+' : '−'}${Math.round(Math.abs(x) * 100)}%`;

/** 兩年的漲幅（產業 ETF、核心 ETF、相減）；資料不夠兩年回傳 null。 */
export function runupOf(view: Pick<MarketView, 'i' | 'close'>, etf: string, core: string): { etf: number; core: number; excess: number } | null {
  const e = view.close[etf];
  const c = view.close[core];
  if (!e || !c || !fin(e[view.i]) || !fin(c[view.i])) return null;
  let a = Math.max(0, view.i - RUNUP.days);
  while (a < view.i && !(fin(e[a]) && fin(c[a]))) a++;
  if (view.i - a < RUNUP.minDays) return null;
  const re = e[view.i] / e[a] - 1;
  const rc = c[view.i] / c[a] - 1;
  return { etf: re, core: rc, excess: re - rc };
}

/** 那一行的字（設計 §1.7 的原文，加上產業 ETF 的代號與兩邊的漲幅）。 */
export function runupText(ticker: string, etf: string, core: string, r: { etf: number; core: number; excess: number }): string {
  return `${ticker} 所屬的產業（${etf}）兩年來比大盤多漲 ${Math.round(r.excess * 100)}%（${etf} ${pct(r.etf)}，${core} ${pct(r.core)}）。研究顯示這種漲幅之後兩年內大跌的機率明顯升高，但平均報酬沒有變差；不用下單，留意部位大小`;
}

/**
 * 每檔自選（現在有沒有股數都算：論點檔還在）一件或沒有。sectors：代號 → 產業 ETF（沒有對到的不看）。
 * 鍵固定是 RUNUP（同一檔每 6 個月列一次）；since 留空（漲幅每天在變，畫面不顯示「起」）。
 */
export function runupHits(acct: Pick<Account, 'own' | 'cfg'>, view: Pick<MarketView, 'i' | 'close'>, sectors: Record<string, string>, tickers: string[] = Object.keys(acct.own)): AttnHit[] {
  const core = acct.cfg.coreTicker;
  const out: AttnHit[] = [];
  for (const t of [...tickers].sort()) {
    const etf = sectors[t];
    if (!acct.own[t] || !etf || etf === core) continue;
    const r = runupOf(view, etf, core);
    if (!r || r.excess < RUNUP.excess) continue;
    out.push({ ticker: t, kind: 'RUNUP', src: 'own', key: 'RUNUP', every: RUNUP.every, since: '', text: runupText(t, etf, core, r) });
  }
  return out;
}

/** 讀產業 ETF 的對照與兩年的價格，算 runupHits。date：訊號日。價格不齊（核心 ETF 沒有這天的日線）時丟錯，呼叫的地方決定怎麼辦。 */
export async function loadRunupHits(db: D1Database, acct: Account, date: string, tickers: string[] = Object.keys(acct.own)): Promise<AttnHit[]> {
  if (!tickers.length) return [];
  const sectors = await sectorEtfs(db, tickers);
  const etfs = [...new Set(Object.values(sectors))];
  if (!etfs.length) return [];
  const core = acct.cfg.coreTicker;
  const { view } = buildMarketView(await loadSeries(db, [core, ...etfs]), date, core);
  return runupHits(acct, view, sectors, tickers);
}
