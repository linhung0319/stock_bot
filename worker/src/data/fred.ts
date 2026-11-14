// T11：F5／F6 的總經儀表板資料（ai_layer_design F5／F6 卡片的「規則偵測段」）。
// 用 FRED 的 fredgraph.csv（公開、不需要金鑰），只在月報前一天抓一次。
// 上線時決策日就是今天，FRED 現在的值就是當時看得到的值；「過去真空頭開始時的值」用的是現在修正後的數字（標明，不是當時的 vintage）。
import type { Fetcher } from './sources';

export interface FredSeries {
  id: string;
  dates: string[];
  values: number[];
}

export const fredCsvUrl = (id: string, since = '1999-01-01') => `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(id)}&cosd=${since}`;

/** fredgraph.csv：第一行是表頭（DATE 或 observation_date），缺值是「.」或空的（假日）。 */
export function parseFredCsv(id: string, csv: string): FredSeries {
  const dates: string[] = [];
  const values: number[] = [];
  for (const line of csv.split(/\r?\n/).slice(1)) {
    const [d, v] = line.split(',');
    if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d.trim())) continue;
    const x = Number(v);
    if (v === undefined || v.trim() === '' || v.trim() === '.' || !Number.isFinite(x)) continue;
    dates.push(d.trim());
    values.push(x);
  }
  return { id, dates, values };
}

export async function fetchFred(fetcher: Fetcher, id: string): Promise<FredSeries> {
  const r = await fetcher(fredCsvUrl(id), { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; stock-bot/1.0)', Accept: 'text/csv' } });
  if (!r.ok) throw new Error(`FRED ${id} HTTP ${r.status}`);
  const s = parseFredCsv(id, await r.text());
  if (!s.dates.length) throw new Error(`FRED ${id} 沒有資料`);
  return s;
}

/** 儀表板的序列（ai_layer F5／F6 卡片；VIX 也用 FRED 的 VIXCLS）。 */
export const MACRO_SERIES: { id: string; label: string; unit: '%' | 'idx' | 'k'; note: string }[] = [
  { id: 'T10Y3M', label: '10 年－3 個月利差', unit: '%', note: '負值 = 倒掛' },
  { id: 'SAHMREALTIME', label: 'Sahm 規則（即時版）', unit: '%', note: '≥ 0.50 通常代表衰退已開始' },
  { id: 'UNRATE', label: '失業率', unit: '%', note: '和 12 個月平均比' },
  { id: 'ICSA', label: '初領失業金', unit: 'k', note: '4 週平均和 52 週低點比' },
  { id: 'RRSFS', label: '實質零售銷售', unit: 'idx', note: '看年增率' },
  { id: 'INDPRO', label: '工業生產', unit: 'idx', note: '看年增率' },
  { id: 'BAA10Y', label: 'BAA 公司債對 10 年公債利差', unit: '%', note: '長期歷史用這個（高收益債利差只有最近 3 年）' },
  { id: 'BAMLH0A0HYM2', label: '高收益債利差', unit: '%', note: 'FRED 只提供最近 3 年' },
  { id: 'NFCI', label: '芝加哥 Fed 金融情勢（NFCI）', unit: 'idx', note: '> 0 代表比平均緊' },
  { id: 'VIXCLS', label: 'VIX', unit: 'idx', note: '' },
];

/** 2000–2026 三次真空頭開始的月份（ai_layer §3.3）。 */
export const TRUE_BEARS = ['2000-10', '2002-05', '2008-01'];
