// T60：草稿的程式檢查第 1 條（composite_layer_design §2.2）——「怎樣算不成立」的子句不能在證據包的財報表裡已經成立
// （擋 MU 實測的 P5「任一季營收低於前一季」：字面上一開始就成立）。純函式。
//
//   只認程式拿 XBRL 八季比對得出來的幾種寫法（一句裡只講一個指標、指標前面沒有別的主詞）：
//     指標：營收、營收年增率、毛利率、營業利益率、淨利率、稀釋每股盈餘（EPS）、營業現金流對淨利
//     關係：低於／高於一個數字（「跌破 55%」「55% 以下」）、季減（低於前一季）、年減（低於去年同季、負成長）、轉負
//     範圍：沒寫 = 最新一季；「連兩季」= 最近兩季都是；「任一季」= 財報表裡有任何一季是
//   寫了往後看的字（下一季、之後、未來、再跌破…）的不算「已經成立」；一句裡有兩個指標、兩種關係、
//   主詞是別的（「資料中心營收」「SK 海力士營收」）或營收寫成金額門檻的，都認不得——認不得的不擋，交給 prompt。
import type { QuarterRow } from '../data/edgar';

/** 證據包帶的季度數字（新的在前；草稿證據包的 rule.detail.quarters）。 */
export type ClauseQuarter = Pick<QuarterRow, 'end' | 'revenue' | 'grossMarginPct' | 'operatingMarginPct' | 'netMarginPct' | 'revenueYoY' | 'epsDiluted' | 'cfoToNetIncome'>;

type Metric = 'Revenue' | 'RevenueYoY' | 'GrossMarginPct' | 'OperatingMarginPct' | 'NetMarginPct' | 'EPSDiluted' | 'CfoToNetIncome';
type Relation = { kind: 'BELOW' | 'ABOVE'; level: number } | { kind: 'NEG' | 'QOQ_DOWN' | 'YOY_DOWN' };

/** 指標的寫法（長的先比，免得「營收年增率」被當成「營收」）。 */
const METRIC_WORDS: { re: RegExp; metric: Metric; label: string }[] = [
  { re: /營收年增率|營收年成長率|營收年增幅|營收成長率|營收年增/g, metric: 'RevenueYoY', label: '營收年增率' },
  { re: /營業現金流量?對淨利|現金流量?對淨利/g, metric: 'CfoToNetIncome', label: '營業現金流對淨利' },
  { re: /毛利率/g, metric: 'GrossMarginPct', label: '毛利率' },
  { re: /營業利益率|營益率|營業利潤率/g, metric: 'OperatingMarginPct', label: '營業利益率' },
  { re: /淨利率/g, metric: 'NetMarginPct', label: '淨利率' },
  { re: /稀釋每股盈餘|每股盈餘|eps/g, metric: 'EPSDiluted', label: '稀釋每股盈餘' },
  { re: /營收|營業收入/g, metric: 'Revenue', label: '營收' },
];
const PCT: ReadonlySet<Metric> = new Set(['RevenueYoY', 'GrossMarginPct', 'OperatingMarginPct', 'NetMarginPct']);

/** 指標前面可以有的字（量詞、「公司的」）；拿掉之後還有別的字 = 主詞是別的（事業單位、同業），認不得。 */
const PREFIX_OK = /公司|整體|合併|全公司|單季|季度|的|任一季|任何一季|其中一季|有一季|連續?[兩二三四2-4]個?季|在|，|、/g;
/** 往後看的字：寫的是之後才會發生的事，不算「已經成立」。 */
const FORWARD = /下一季|下季|下一份|之後|往後|未來|今後|接下來|從現在起|自今|新一季|新的一季|再次|再度|再(跌|低|降|轉|減|下滑|掉)|起算/;
const ANY = /任一季|任何一季|其中一季|有一季/;
const CONSEC = /連續?([兩二三四2-4])個?季/;
const QOQ = /(低於|少於|小於|不如)(前一季|上一季|上季|前季)|比(前一季|上一季|上季|前季)(低|少|差)|較(前一季|上一季|上季|前季)(下滑|下降|減少|衰退|下跌|走低)|季減|季衰退|季比(下降|下滑|減少)|季跌|環比(下降|下滑|減少)|逐季(下滑|下降|減少)/;
const YOY = /年減|年衰退|(低於|少於|小於|不如)去年同(季|期)|比去年同(季|期)(低|少|差)|較去年同(季|期)(下滑|下降|減少|衰退|下跌)|年比(下降|下滑|減少)|負成長/;
const NEG = /轉負|為負|變成負|轉為負|小於零|低於零|跌破零/;
const BELOW = /(?:低於|少於|小於|跌破|不到|未達|降到|降至|跌到|跌至|掉到|掉至|<)(-?\d+(?:\.\d+)?)(%|個百分點)?|(-?\d+(?:\.\d+)?)(%)?以下/;
const ABOVE = /(?:高於|超過|大於|多於|>)(-?\d+(?:\.\d+)?)(%|個百分點)?|(-?\d+(?:\.\d+)?)(%)?以上/;
const CN: Record<string, number> = { 兩: 2, 二: 2, 三: 3, 四: 4 };

export interface ParsedClause {
  metric: Metric;
  label: string;
  rel: Relation;
  /** 連續幾季（沒寫是 1；「逐季下滑」是 2）。 */
  quarters: number;
  /** 「任一季」：財報表裡任何一段連續 quarters 季成立就算。 */
  any: boolean;
}

const norm = (s: string) => s.normalize('NFKC').toLowerCase().replace(/\s+/g, '');

/** 一句「怎樣算不成立」認得出來的話，整理成可以比對財報表的形狀；認不得（或是往後看的寫法）回傳 null。 */
export function parseXbrlClause(text: string): ParsedClause | null {
  const t = norm(text);
  if (!t || FORWARD.test(t)) return null;
  // 找指標：長的寫法先找，找到的位置蓋掉，短的就不會在裡面再對到
  let work = t;
  const hits: { metric: Metric; label: string; at: number }[] = [];
  for (const w of METRIC_WORDS) {
    work = work.replace(w.re, (m, at: number) => {
      hits.push({ metric: w.metric, label: w.label, at });
      return '□'.repeat(m.length);
    });
  }
  const metrics = new Set(hits.map((h) => h.metric));
  if (metrics.size !== 1) return null;
  const first = hits.reduce((a, b) => (b.at < a.at ? b : a));
  if (t.slice(0, first.at).replace(PREFIX_OK, '')) return null;
  const metric = first.metric;
  // 關係：剛好一種才算（兩種是複合句，不猜）
  const rels: Relation[] = [];
  if (QOQ.test(t)) rels.push({ kind: 'QOQ_DOWN' });
  if (YOY.test(t)) rels.push({ kind: 'YOY_DOWN' });
  if (NEG.test(t)) rels.push({ kind: 'NEG' });
  const lv = (m: RegExpExecArray | null): number | null => {
    if (!m) return null;
    const raw = m[1] ?? m[3];
    const unit = m[2] ?? m[4];
    const v = Number(raw);
    if (!Number.isFinite(v)) return null;
    if (unit) return v / 100;
    return PCT.has(metric) && Math.abs(v) > 1.5 ? v / 100 : v;
  };
  const below = lv(BELOW.exec(t));
  const above = lv(ABOVE.exec(t));
  // 營收的數字是金額（單位五花八門）或幅度（「季減超過 10%」），都不比
  if (metric === 'Revenue' && (below !== null || above !== null)) return null;
  if (below !== null) rels.push({ kind: 'BELOW', level: below });
  if (above !== null) rels.push({ kind: 'ABOVE', level: above });
  if (rels.length !== 1) return null;
  const c = CONSEC.exec(t);
  const quarters = c ? (CN[c[1]] ?? Number(c[1])) : /逐季/.test(t) ? 2 : 1;
  return { metric, label: first.label, rel: rels[0], quarters, any: ANY.test(t) };
}

const DAY = 86400_000;
const gap = (a: string, b: string) => Math.round((Date.parse(a) - Date.parse(b)) / DAY);
function value(r: ClauseQuarter, m: Metric): number | null {
  switch (m) {
    case 'Revenue':
      return r.revenue;
    case 'RevenueYoY':
      return r.revenueYoY;
    case 'GrossMarginPct':
      return r.grossMarginPct;
    case 'OperatingMarginPct':
      return r.operatingMarginPct;
    case 'NetMarginPct':
      return r.netMarginPct;
    case 'EPSDiluted':
      return r.epsDiluted;
    case 'CfoToNetIncome':
      return r.cfoToNetIncome;
  }
}

/** 第 i 季（新的在前）成不成立；資料不夠判斷是 null。 */
function holdsAt(p: ParsedClause, rows: ClauseQuarter[], i: number): boolean | null {
  const r = rows[i];
  if (!r) return null;
  const rel = p.rel;
  if (rel.kind === 'YOY_DOWN' && (p.metric === 'Revenue' || p.metric === 'RevenueYoY')) return r.revenueYoY === null ? null : r.revenueYoY < 0;
  const v = value(r, p.metric);
  if (v === null) return null;
  if (rel.kind === 'BELOW') return v < rel.level;
  if (rel.kind === 'ABOVE') return v > rel.level;
  if (rel.kind === 'NEG') return v < 0;
  if (rel.kind === 'QOQ_DOWN') {
    const prev = rows[i + 1];
    const d = prev ? gap(r.end, prev.end) : 0;
    const pv = prev ? value(prev, p.metric) : null;
    return prev && d >= 60 && d <= 120 && pv !== null ? v < pv : null;
  }
  // 年減（營收以外）：找差一年（±20 天）的那一季
  const ago = rows.slice(i + 1).find((x) => Math.abs(gap(r.end, x.end) - 365) <= 20);
  const av = ago ? value(ago, p.metric) : null;
  return av === null ? null : v < av;
}

/**
 * 一句「怎樣算不成立」用證據包的財報表看是不是已經成立（composite §2.2 草稿檢查第 1 條）。
 * 回傳 { met, end }：met = true 時 end 是讓它成立的那一季（季末日）。認不得、往後看的寫法、資料不夠判斷 → null（不擋）。
 */
export function clauseMetNow(text: string, rows: ClauseQuarter[] | null | undefined): { met: boolean; end: string | null } | null {
  if (!rows?.length) return null;
  const p = parseXbrlClause(text);
  if (!p) return null;
  const window = (i: number): boolean | null => {
    let unknown = false;
    for (let k = 0; k < p.quarters; k++) {
      const h = holdsAt(p, rows, i + k);
      if (h === false) return false;
      if (h === null) unknown = true;
    }
    return unknown ? null : true;
  };
  if (!p.any) {
    const w = window(0);
    return w === null ? null : { met: w, end: w ? rows[0].end : null };
  }
  let anyKnown = false;
  for (let i = 0; i + p.quarters <= rows.length; i++) {
    const w = window(i);
    if (w === true) return { met: true, end: rows[i].end };
    if (w === false) anyKnown = true;
  }
  return anyKnown ? { met: false, end: null } : null;
}
