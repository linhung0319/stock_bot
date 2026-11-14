// T10：自選股的財報與申報（F24 定期審查、F25 條件監測的證據）。
//   XBRL companyfacts：point-in-time，只用 filed ≤ 決策日的值（data_sources §3.3；frames 不是 point-in-time，不用）
//   申報原文：10-Q／10-K 只取 MD&A 那一節；8-K 取本文與 EX-99.1（財報新聞稿）（ai_layer §8.3：只給相關的那一節）
//   新聞：Nasdaq 個股 RSS，只有標題（data_sources §5、§10 第 6 點：不用 Google News）
// 解析是純函式（用固定的 JSON／HTML 測），抓取的部分帶 fetcher。
import type { Fetcher } from './sources';

// ---------------------------------------------------------------- XBRL

export interface XbrlFact {
  start?: string;
  end: string;
  val: number;
  accn: string;
  fy?: number;
  fp?: string;
  form: string;
  filed: string;
}
type Units = Record<string, XbrlFact[]>;
export interface CompanyFacts {
  cik: number | string;
  entityName?: string;
  facts: Record<string, Record<string, { units: Units }>>;
}

export const companyFactsUrl = (cik: string | number) => `https://data.sec.gov/api/xbrl/companyfacts/CIK${String(cik).replace(/\D/g, '').padStart(10, '0')}.json`;

/** 每個項目依序找的 XBRL 概念（公司換過標籤時，較新的在前）。 */
export const CONCEPTS = {
  revenue: ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'SalesRevenueNet', 'RevenueFromContractWithCustomerIncludingAssessedTax'],
  costOfRevenue: ['CostOfGoodsAndServicesSold', 'CostOfRevenue', 'CostOfGoodsSold'],
  grossProfit: ['GrossProfit'],
  operatingIncome: ['OperatingIncomeLoss'],
  netIncome: ['NetIncomeLoss'],
  epsDiluted: ['EarningsPerShareDiluted'],
  cfo: ['NetCashProvidedByUsedInOperatingActivities'],
} as const;
type Item = keyof typeof CONCEPTS;

const DAY = 86400_000;
const days = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / DAY) + 1;
const isQuarter = (f: XbrlFact) => !!f.start && days(f.start, f.end) >= 80 && days(f.start, f.end) <= 100;

function factsOf(cf: CompanyFacts, names: readonly string[], unit: string): XbrlFact[] {
  const out: XbrlFact[] = [];
  for (const n of names) out.push(...(cf.facts['us-gaap']?.[n]?.units[unit] ?? []));
  return out;
}

/** 每個 (start, end) 留下 as_of 當時看得到的最新一筆（之後的重編看不到）。 */
function asOfLatest(facts: XbrlFact[], asOf: string): Map<string, XbrlFact> {
  const m = new Map<string, XbrlFact>();
  for (const f of facts) {
    if (f.filed > asOf || !Number.isFinite(f.val)) continue;
    const k = `${f.start ?? ''}|${f.end}`;
    const prev = m.get(k);
    if (!prev || f.filed > prev.filed) m.set(k, f);
  }
  return m;
}

/**
 * 期間型的項目（營收、現金流）→ 每一季的值。10-Q 的現金流多半只報年初至今的累計，第四季只在 10-K 的全年數字裡，
 * 所以同一個起始日的累計值依序相減（3 個月、6 個月、9 個月、12 個月 → 各季）；有直接的單季數字就用單季。
 */
export function quarterlyFlow(facts: XbrlFact[], asOf: string): Map<string, { val: number; filed: string; form: string; accn: string }> {
  const latest = [...asOfLatest(facts, asOf).values()].filter((f) => f.start);
  const out = new Map<string, { val: number; filed: string; form: string; accn: string }>();
  const byStart = new Map<string, XbrlFact[]>();
  for (const f of latest) byStart.set(f.start!, [...(byStart.get(f.start!) ?? []), f]);
  for (const list of byStart.values()) {
    const sorted = list.filter((f) => days(f.start!, f.end) <= 380).sort((a, b) => (a.end < b.end ? -1 : 1));
    for (let k = 0; k < sorted.length; k++) {
      const f = sorted[k];
      if (isQuarter(f)) continue; // 直接的單季在下面處理
      const prev = sorted[k - 1];
      if (!prev) continue;
      const gap = days(prev.end, f.end) - 1;
      if (gap < 80 || gap > 100) continue;
      const end = f.end;
      if (!out.has(end)) out.set(end, { val: f.val - prev.val, filed: f.filed > prev.filed ? f.filed : prev.filed, form: f.form, accn: f.accn });
    }
  }
  for (const f of latest) if (isQuarter(f)) out.set(f.end, { val: f.val, filed: f.filed, form: f.form, accn: f.accn });
  return out;
}

/** 每股盈餘這類不能相加的項目：只用直接的單季數字。 */
function quarterlyDirect(facts: XbrlFact[], asOf: string): Map<string, { val: number; filed: string }> {
  const out = new Map<string, { val: number; filed: string }>();
  for (const f of asOfLatest(facts, asOf).values()) if (isQuarter(f)) out.set(f.end, { val: f.val, filed: f.filed });
  return out;
}

export interface QuarterRow {
  end: string;
  filed: string;
  form: string;
  accn: string;
  revenue: number | null;
  grossProfit: number | null;
  operatingIncome: number | null;
  netIncome: number | null;
  epsDiluted: number | null;
  cfo: number | null;
  grossMarginPct: number | null;
  operatingMarginPct: number | null;
  netMarginPct: number | null;
  revenueYoY: number | null;
  cfoToNetIncome: number | null;
}

/** 最近 n 季（新的在前），只用 as_of 當時看得到的數字。 */
export function quarterTable(cf: CompanyFacts, asOf: string, n = 8): QuarterRow[] {
  const q = (item: Item) => quarterlyFlow(factsOf(cf, CONCEPTS[item], 'USD'), asOf);
  const rev = q('revenue');
  const cost = q('costOfRevenue');
  const gp = q('grossProfit');
  const op = q('operatingIncome');
  const ni = q('netIncome');
  const cfo = q('cfo');
  const eps = quarterlyDirect(factsOf(cf, CONCEPTS.epsDiluted, 'USD/shares'), asOf);
  const ends = [...rev.keys()].sort().reverse();
  const val = (m: Map<string, { val: number }>, e: string) => m.get(e)?.val ?? null;
  const ratio = (a: number | null, b: number | null) => (a !== null && b !== null && b !== 0 ? a / b : null);
  const rows: QuarterRow[] = ends.map((end) => {
    const r = rev.get(end)!;
    const revenue = r.val;
    const g = val(gp, end) ?? (val(cost, end) !== null ? revenue - val(cost, end)! : null);
    const o = val(op, end);
    const net = val(ni, end);
    const c = val(cfo, end);
    const yearAgo = ends.find((e) => Math.abs(days(e, end) - 366) <= 20);
    return {
      end,
      filed: r.filed,
      form: r.form,
      accn: r.accn,
      revenue,
      grossProfit: g,
      operatingIncome: o,
      netIncome: net,
      epsDiluted: eps.get(end)?.val ?? null,
      cfo: c,
      grossMarginPct: ratio(g, revenue),
      operatingMarginPct: ratio(o, revenue),
      netMarginPct: ratio(net, revenue),
      revenueYoY: yearAgo ? ratio(revenue - rev.get(yearAgo)!.val, rev.get(yearAgo)!.val) : null,
      cfoToNetIncome: ratio(c, net),
    };
  });
  return rows.slice(0, n);
}

/** F25 財報條件可以用的指標（XBRL 程式直接判斷）。 */
export const XBRL_METRICS: Record<string, { label: string; get: (r: QuarterRow) => number | null; pct: boolean }> = {
  GrossMarginPct: { label: '毛利率', get: (r) => r.grossMarginPct, pct: true },
  OperatingMarginPct: { label: '營業利益率', get: (r) => r.operatingMarginPct, pct: true },
  NetMarginPct: { label: '淨利率', get: (r) => r.netMarginPct, pct: true },
  RevenueYoY: { label: '營收年增率', get: (r) => r.revenueYoY, pct: true },
  EPSDiluted: { label: '稀釋每股盈餘', get: (r) => r.epsDiluted, pct: false },
  CfoToNetIncome: { label: '營業現金流對淨利', get: (r) => r.cfoToNetIncome, pct: false },
  Revenue: { label: '營收', get: (r) => r.revenue, pct: false },
};

const big = (x: number | null) => (x === null ? '—' : Math.abs(x) >= 1e6 ? `${(x / 1e6).toFixed(0)}M` : x.toFixed(2));
const pct = (x: number | null) => (x === null ? '—' : `${(x * 100).toFixed(1)}%`);

/** 給證據包的原文：一季一行（LLM 引用財報數字時引用這一份）。 */
export function quarterTableText(ticker: string, rows: QuarterRow[]): string {
  const head = `${ticker} quarterly figures from SEC XBRL (point-in-time: values as filed on or before the decision date; USD; M = millions)`;
  const lines = rows.map(
    (r) =>
      `${r.end} (${r.form} filed ${r.filed}): revenue ${big(r.revenue)}, gross margin ${pct(r.grossMarginPct)}, operating margin ${pct(r.operatingMarginPct)}, net income ${big(r.netIncome)}, diluted EPS ${r.epsDiluted === null ? '—' : r.epsDiluted.toFixed(2)}, revenue YoY ${pct(r.revenueYoY)}, operating cash flow ${big(r.cfo)}`,
  );
  return [head, ...lines].join('\n');
}

/** 財報條件：最近 quarters 季都低於（或高於）門檻才算成立。資料不夠回傳 null。 */
export function xbrlConditionMet(rows: QuarterRow[], check: { type: string; metric: string; level: number; quarters?: number }): { met: boolean; values: (number | null)[] } | null {
  const m = XBRL_METRICS[check.metric];
  if (!m) return null;
  const n = Math.max(1, Math.min(4, check.quarters ?? 1));
  const values = rows.slice(0, n).map(m.get);
  if (values.length < n || values.some((v) => v === null)) return null;
  const below = check.type === 'xbrl_metric_below';
  return { met: values.every((v) => (below ? v! < check.level : v! > check.level)), values };
}

export async function fetchCompanyFacts(fetcher: Fetcher, cik: string | number, userAgent: string): Promise<CompanyFacts> {
  const res = await fetcher(companyFactsUrl(cik), { headers: { 'User-Agent': userAgent, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`EDGAR companyfacts ${cik} HTTP ${res.status}`);
  return (await res.json()) as CompanyFacts;
}

// ---------------------------------------------------------------- 申報原文

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', mdash: '—', ndash: '–', hellip: '…', reg: '®', trade: '™', copy: '©' };

/** HTML（申報的 .htm）→ 純文字：去掉 script／style、XBRL 隱藏區塊，區塊元素換行，解碼實體，空白壓縮。 */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<ix:header[\s\S]*?<\/ix:header>/gi, ' ')
    .replace(/<div[^>]*display:\s*none[\s\S]*?<\/div>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table|section)>/gi, '\n')
    .replace(/<\/t[dh]>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m)
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 取出一節：所有「開頭」出現的位置裡，選到下一個「結尾」之間最長的那一段（目錄裡的同名項目很短，會被跳過）。
 * 找不到就回傳 null。
 */
export function extractSection(text: string, start: RegExp, end: RegExp, max = 40_000): string | null {
  const s = new RegExp(start.source, start.flags.includes('g') ? start.flags : start.flags + 'g');
  let best: string | null = null;
  for (let m = s.exec(text); m; m = s.exec(text)) {
    const rest = text.slice(m.index);
    const e = new RegExp(end.source, end.flags.replace('g', '')).exec(rest.slice(m[0].length));
    const sec = e ? rest.slice(0, m[0].length + e.index) : rest;
    if (!best || sec.length > best.length) best = sec;
  }
  if (!best) return null;
  return best.length > max ? best.slice(0, max) + '\n…（以下省略）' : best;
}

export const MDNA = {
  '10-Q': { start: /item\s*2\.?\s*[-–—:]?\s*management['’]s\s+discussion\s+and\s+analysis/i, end: /item\s*3\.?\s*[-–—:]?\s*quantitative\s+and\s+qualitative|item\s*4\.?\s*[-–—:]?\s*controls\s+and\s+procedures/i },
  '10-K': { start: /item\s*7\.?\s*[-–—:]?\s*management['’]s\s+discussion\s+and\s+analysis/i, end: /item\s*7a\.?|item\s*8\.?\s*[-–—:]?\s*financial\s+statements/i },
};

export const filingDir = (cik: string | number, accession: string) => `https://www.sec.gov/Archives/edgar/data/${Number(String(cik).replace(/\D/g, ''))}/${accession.replace(/-/g, '')}`;

/** 8-K 附件裡的財報新聞稿（EX-99.1）的檔名：從申報目錄的 index.json 找。 */
export function pickExhibit991(index: unknown): string | null {
  const items = ((index as { directory?: { item?: { name: string }[] } })?.directory?.item ?? []).map((x) => x.name);
  return items.find((n) => /\.htm/i.test(n) && /(ex-?99(\.|_|-)?0?1\b|ex991|exhibit-?99(\.|_)?1|ex99-1|dex991)/i.test(n)) ?? items.find((n) => /\.htm/i.test(n) && /99/.test(n) && /ex/i.test(n)) ?? null;
}

export interface FilingDoc {
  accession: string;
  form: string;
  items: string[];
  filingDate: string;
  acceptedAt: string;
  url: string;
  title: string;
  text: string;
}

/** 抓一份申報的相關原文：10-Q／10-K 的 MD&A；8-K 的本文（最多 15000 字）＋ EX-99.1（最多 30000 字）。 */
export async function fetchFilingDoc(
  fetcher: Fetcher,
  cik: string | number,
  f: { accession: string; form: string; items: string[]; filingDate: string; acceptedAt: string; primaryDocument: string },
  userAgent: string,
): Promise<FilingDoc> {
  const dir = filingDir(cik, f.accession);
  const get = async (url: string) => {
    const r = await fetcher(url, { headers: { 'User-Agent': userAgent } });
    if (!r.ok) throw new Error(`EDGAR ${url} HTTP ${r.status}`);
    return r.text();
  };
  const url = `${dir}/${f.primaryDocument}`;
  const main = htmlToText(await get(url));
  let text: string;
  let title = `${f.form}${f.items.length ? `（Item ${f.items.join('、')}）` : ''} ${f.filingDate}`;
  const form = f.form.replace(/\/A$/, '') as keyof typeof MDNA;
  if (form in MDNA) {
    const sec = extractSection(main, MDNA[form].start, MDNA[form].end);
    text = sec ?? main.slice(0, 40_000);
    title += sec ? '：MD&A' : '：開頭（找不到 MD&A）';
  } else {
    // 8-K 的封面（公司地址、勾選框）跳過，從第一個「Item x.xx」開始
    const at = main.search(/item\s+\d\.\d{2}/i);
    text = main.slice(at > 0 ? at : 0, (at > 0 ? at : 0) + 15_000);
    if (f.form.startsWith('8-K')) {
      try {
        const ex = pickExhibit991(JSON.parse(await get(`${dir}/index.json`)));
        if (ex) {
          text += '\n\n--- EX-99.1 ---\n' + htmlToText(await get(`${dir}/${ex}`)).slice(0, 30_000);
          title += '＋EX-99.1';
        }
      } catch {
        // 附件抓不到就只用本文
      }
    }
  }
  return { accession: f.accession, form: f.form, items: f.items, filingDate: f.filingDate, acceptedAt: f.acceptedAt, url, title, text };
}

/** 財報類申報：10-Q、10-K、8-K Item 2.02（F24 的「新財報」觸發）。 */
export const isEarningsFiling = (f: { form: string; items: string[] }) => /^10-[QK]/.test(f.form) || (f.form.startsWith('8-K') && f.items.includes('2.02'));

// ---------------------------------------------------------------- 新聞標題（Nasdaq RSS）

export const nasdaqRssUrl = (ticker: string) => `https://www.nasdaq.com/feed/rssoutbound?symbol=${encodeURIComponent(ticker)}`;

export interface Headline {
  date: string;
  title: string;
  link: string;
}

export function parseRss(xml: string): Headline[] {
  const out: Headline[] = [];
  const tag = (s: string, t: string) => {
    const m = new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`, 'i').exec(s);
    return m ? htmlToText(m[1].replace(/^<!\[CDATA\[|\]\]>$/g, '')) : '';
  };
  for (const m of xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)) {
    const it = m[0];
    const d = new Date(tag(it, 'pubDate'));
    if (Number.isNaN(d.getTime())) continue;
    out.push({ date: d.toISOString().slice(0, 10), title: tag(it, 'title'), link: tag(it, 'link') });
  }
  return out;
}

export async function fetchHeadlines(fetcher: Fetcher, ticker: string): Promise<Headline[]> {
  // 不帶使用者的聯絡方式（那是給 SEC 的）
  const res = await fetcher(nasdaqRssUrl(ticker), { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; stock-bot/1.0)', Accept: 'application/rss+xml, application/xml' } });
  if (!res.ok) throw new Error(`Nasdaq RSS ${ticker} HTTP ${res.status}`);
  return parseRss(await res.text());
}
