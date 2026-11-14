// 資料來源（設計 §2.4，2026-11-11 決定）：
//   價格與成交金額：Yahoo 日線（未調整收盤 × 成交量）
//   成分股與市值排序：SSGA 的 SPY 每日持股檔（權重 = 浮動市值），和 Wikipedia 目前名單比對
//   申報：EDGAR submissions（User-Agent 要帶聯絡方式，由使用者設定）
// 每個來源分成「抓」和「解析」；解析是純函式，可以用固定檔測試。
import { readFirstSheet } from './xlsx';

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
/** Wikipedia 要求自動程式用能辨識的 User-Agent；這裡只放程式名稱，不放個人資料。 */
const GENERIC_UA = 'stock-bot/0.1 (personal portfolio rule checker)';

// ---------------------------------------------------------------- Yahoo 日線

export interface DailyBar {
  /** 交易日（美東日期，YYYY-MM-DD）。 */
  date: string;
  open: number;
  high: number;
  low: number;
  /** 未調整收盤（只還原分割）。 */
  close: number;
  /** 還原權值收盤（含股利）。 */
  adjClose: number;
  volume: number;
}

export interface YahooSeries {
  symbol: string;
  currency: string | null;
  bars: DailyBar[];
}

/** Yahoo 的代號把「.」寫成「-」（BRK.B → BRK-B）。 */
export function yahooSymbol(ticker: string): string {
  return ticker.replace(/\./g, '-');
}

export function yahooChartUrl(ticker: string, range = '2y'): string {
  return `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol(ticker))}?range=${range}&interval=1d&events=div%2Csplit`;
}

export function parseYahooChart(json: unknown): YahooSeries {
  const res = (json as { chart?: { result?: unknown[]; error?: { description?: string } | null } }).chart;
  const r = res?.result?.[0] as
    | {
        meta: { symbol: string; currency?: string; gmtoffset?: number };
        timestamp?: number[];
        indicators: { quote: { open: (number | null)[]; high: (number | null)[]; low: (number | null)[]; close: (number | null)[]; volume: (number | null)[] }[]; adjclose?: { adjclose: (number | null)[] }[] };
      }
    | undefined;
  if (!r) throw new Error(`Yahoo 回應沒有資料：${res?.error?.description ?? '未知錯誤'}`);
  const ts = r.timestamp ?? [];
  const q = r.indicators.quote[0];
  const adj = r.indicators.adjclose?.[0]?.adjclose;
  const offset = r.meta.gmtoffset ?? -18000;
  const bars: DailyBar[] = [];
  for (let i = 0; i < ts.length; i++) {
    const close = q.close[i];
    if (close === null || close === undefined) continue; // 還沒收盤或沒有交易
    bars.push({
      date: new Date((ts[i] + offset) * 1000).toISOString().slice(0, 10),
      open: q.open[i] ?? close,
      high: q.high[i] ?? close,
      low: q.low[i] ?? close,
      close,
      adjClose: adj?.[i] ?? close,
      volume: q.volume[i] ?? 0,
    });
  }
  return { symbol: r.meta.symbol, currency: r.meta.currency ?? null, bars };
}

export async function fetchYahooDaily(fetcher: Fetcher, ticker: string, range = '2y'): Promise<YahooSeries> {
  const res = await fetcher(yahooChartUrl(ticker, range), { headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Yahoo ${ticker} HTTP ${res.status}`);
  return parseYahooChart(await res.json());
}

// ---------------------------------------------------------------- SSGA：SPY 每日持股檔

export const SPY_HOLDINGS_URL = 'https://www.ssga.com/us/en/intermediary/library-content/products/fund-data/etfs/us/holdings-daily-us-en-spy.xlsx';

export interface Holding {
  ticker: string;
  name: string;
  /** 占基金的百分比（= 浮動市值占比）。 */
  weight: number;
}
export interface SpyHoldings {
  /** 檔案上寫的日期（原文，例如 "As of 10-Nov-2026"）。 */
  asOfText: string;
  /** 轉成 YYYY-MM-DD；轉不出來是 null。 */
  asOf: string | null;
  holdings: Holding[];
}

const MONTHS: Record<string, string> = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };

export function parseAsOf(text: string): string | null {
  const m = /(\d{1,2})-([A-Za-z]{3})-(\d{4})/.exec(text);
  if (!m) return null;
  const mm = MONTHS[m[2].toLowerCase()];
  return mm ? `${m[3]}-${mm}-${m[1].padStart(2, '0')}` : null;
}

export async function parseSpyHoldings(file: Uint8Array): Promise<SpyHoldings> {
  const rows = await readFirstSheet(file);
  let asOfText = '';
  let header = -1;
  for (let i = 0; i < Math.min(rows.length, 12); i++) {
    const r = rows[i];
    if (String(r[0] ?? '').startsWith('Holdings') && r[1]) asOfText = String(r[1]);
    if (r.some((c) => c === 'Ticker') && r.some((c) => c === 'Weight')) {
      header = i;
      break;
    }
  }
  if (header < 0) throw new Error('SPY 持股檔格式變了：找不到 Ticker／Weight 欄');
  const h = rows[header];
  const cT = h.indexOf('Ticker');
  const cW = h.indexOf('Weight');
  const cN = h.indexOf('Name');
  const holdings: Holding[] = [];
  for (const r of rows.slice(header + 1)) {
    const t = r[cT];
    const w = r[cW];
    if (typeof t !== 'string' || typeof w !== 'number') continue;
    const ticker = t.trim().toUpperCase();
    // 非股票列（現金、期貨）沒有正常的代號
    if (!/^[A-Z][A-Z.]*$/.test(ticker)) continue;
    holdings.push({ ticker, name: String(r[cN] ?? '').trim(), weight: w });
  }
  if (holdings.length < 400) throw new Error(`SPY 持股檔只有 ${holdings.length} 檔，格式可能變了`);
  return { asOfText, asOf: parseAsOf(asOfText), holdings };
}

export async function fetchSpyHoldings(fetcher: Fetcher): Promise<SpyHoldings> {
  const res = await fetcher(SPY_HOLDINGS_URL, { headers: { 'User-Agent': BROWSER_UA, Accept: '*/*' } });
  if (!res.ok) throw new Error(`SSGA HTTP ${res.status}`);
  return parseSpyHoldings(new Uint8Array(await res.arrayBuffer()));
}

// ---------------------------------------------------------------- Wikipedia：目前的 S&P 500 名單

export const WIKI_SP500_URL = 'https://en.wikipedia.org/w/index.php?title=List_of_S%26P_500_companies&action=raw';

export interface WikiMember {
  ticker: string;
  cik: string | null;
}

/** 解析「List of S&P 500 companies」的 wikitext 裡 id="constituents" 那張表。 */
export function parseWikiSp500(wikitext: string): WikiMember[] {
  const start = wikitext.indexOf('id="constituents"');
  if (start < 0) throw new Error('Wikipedia 頁面格式變了：找不到 constituents 表');
  const end = wikitext.indexOf('\n|}', start);
  const table = wikitext.slice(start, end < 0 ? undefined : end);
  const out: WikiMember[] = [];
  for (const row of table.split(/\n\|-/).slice(1)) {
    const sym = /\{\{[^{}|]*\|([A-Za-z.-]+)\}\}/.exec(row);
    if (!sym) continue;
    const cik = /\b(\d{10})\b/.exec(row.slice(sym.index));
    out.push({ ticker: sym[1].toUpperCase(), cik: cik ? cik[1] : null });
  }
  if (out.length < 400) throw new Error(`Wikipedia 名單只有 ${out.length} 檔，格式可能變了`);
  return out;
}

export async function fetchWikiSp500(fetcher: Fetcher): Promise<WikiMember[]> {
  const res = await fetcher(WIKI_SP500_URL, { headers: { 'User-Agent': GENERIC_UA } });
  if (!res.ok) throw new Error(`Wikipedia HTTP ${res.status}`);
  return parseWikiSp500(await res.text());
}

/** 兩邊的代號寫法統一（BRK.B／BRK-B／BRK B）。 */
export function normalizeTicker(t: string): string {
  return t.trim().toUpperCase().replace(/[-\s/]/g, '.');
}

export interface MembershipDiff {
  onlySpy: string[];
  onlyWiki: string[];
  /** 兩邊一致 → 可以換股；不一致 → 暫停換股並通知（設計 §2.4）。 */
  consistent: boolean;
}

export function compareMembership(spy: string[], wiki: string[]): MembershipDiff {
  const a = new Set(spy.map(normalizeTicker));
  const b = new Set(wiki.map(normalizeTicker));
  const onlySpy = [...a].filter((t) => !b.has(t)).sort();
  const onlyWiki = [...b].filter((t) => !a.has(t)).sort();
  return { onlySpy, onlyWiki, consistent: !onlySpy.length && !onlyWiki.length };
}

// ---------------------------------------------------------------- EDGAR submissions

export interface Filing {
  accession: string;
  form: string;
  /** 8-K 的 items，例如 ['2.02', '9.01']。 */
  items: string[];
  /** 送件被接受的時間（UTC，ISO）。 */
  acceptedAt: string;
  filingDate: string;
  primaryDocument: string;
}

export function edgarSubmissionsUrl(cik: string | number): string {
  return `https://data.sec.gov/submissions/CIK${String(cik).replace(/\D/g, '').padStart(10, '0')}.json`;
}

export function parseEdgarSubmissions(json: unknown): { cik: string; name: string; tickers: string[]; sic: string | null; formerNames: string[]; filings: Filing[] } {
  const j = json as {
    cik: string;
    name: string;
    tickers?: string[];
    sic?: string;
    formerNames?: { name: string }[];
    filings: { recent: { accessionNumber: string[]; form: string[]; items: string[]; acceptanceDateTime: string[]; filingDate: string[]; primaryDocument: string[] } };
  };
  const r = j.filings.recent;
  const filings: Filing[] = r.accessionNumber.map((accession, i) => ({
    accession,
    form: r.form[i],
    items: (r.items[i] ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    acceptedAt: r.acceptanceDateTime[i],
    filingDate: r.filingDate[i],
    primaryDocument: r.primaryDocument[i],
  }));
  return { cik: String(j.cik).padStart(10, '0'), name: j.name, tickers: j.tickers ?? [], sic: j.sic ? String(j.sic) : null, formerNames: (j.formerNames ?? []).map((x) => x.name), filings };
}

/** userAgent：SEC 要求帶聯絡方式（例如「名字 email」）。由使用者用 wrangler secret 設定，不寫在程式裡。 */
export async function fetchEdgarSubmissions(fetcher: Fetcher, cik: string | number, userAgent: string) {
  if (!userAgent) throw new Error('沒有設定 EDGAR 的 User-Agent');
  const res = await fetcher(edgarSubmissionsUrl(cik), { headers: { 'User-Agent': userAgent, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`EDGAR ${cik} HTTP ${res.status}`);
  return parseEdgarSubmissions(await res.json());
}
