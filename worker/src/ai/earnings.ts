// T29c：財報新聞稿當天確認財報類條件（own_thesis §1.11，功能 OWN_EARNINGS，白話「財報數字擷取」）。
// 財報新聞稿（8-K Item 2.02 的 EX-99.1）沒有 XBRL，數字要用讀的：三票只抄數字，計算與比對都由程式做。
// 純函式：證據包、payload 的格式檢查、§1.11 的六項程式檢查、指標的計算。抓資料、開執行、套用在 src/app/earningsAi.ts。
//
//   程式檢查（任何一項不過就當成沒有擷取，條件照舊等 10-Q／10-K，只記錄；第 4 項是逐項不採用）：
//     1. 每個數字的 current_text、year_ago_text 都要出現在它引用的那段原文裡（引用本身照常做逐字檢查；引用要是申報原文）
//     2. 三票都合格、period_end 相同，每個項目換算後的數值三票相差不超過 0.1%（三票都有的項目才算）
//     3. period_end 比 XBRL 表最新一季晚 80～100 天（確實是下一季）
//     4. 去年同季的數字要和 XBRL 已有的值相符（金額 0.5%、每股盈餘 0.01）；對不上、或 XBRL 沒有的項目不採用
//     5. 通過的項目由程式算指標（pressRow）：毛利 = gross_profit，沒有就 revenue − cost_of_revenue；比率用本季相除；營收年增率用 XBRL 的去年同季
//     6. 和條件的門檻比（呼叫的地方用 xbrlConditionMet([pressRow, ...XBRL])）：要連續幾季的，本季用擷取的、更早的季用 XBRL；算不出來就不判斷
import { XBRL_METRICS, type QuarterRow } from '../data/edgar';
import { normalizeText, type CheckedSample, type EvidencePack, type Outcome, type PackDoc } from './check';
import { buildPack } from './pack';

export const OWN_EARNINGS = 'OWN_EARNINGS';
export const OWN_EARNINGS_PROMPT = 'own_earnings_v1';
export const OWN_EARNINGS_SAMPLES = 3;

/** AI 可以抄的項目（只取 GAAP、單季）。 */
export const EARNINGS_ITEMS = ['revenue', 'gross_profit', 'cost_of_revenue', 'operating_income', 'net_income', 'eps_diluted'] as const;
export type EarningsItem = (typeof EARNINGS_ITEMS)[number];
/** scale 可以用的倍數（每股盈餘只能是 1）。 */
export const EARNINGS_SCALES = [1, 1_000, 1_000_000, 1_000_000_000];

/** 新聞稿算得出來的指標（own_thesis §1.11）。CfoToNetIncome 不支援：新聞稿的現金流多半是累計，等 10-Q／10-K。 */
export const PRESS_METRICS: ReadonlySet<string> = new Set(['GrossMarginPct', 'OperatingMarginPct', 'NetMarginPct', 'RevenueYoY', 'EPSDiluted', 'Revenue']);

/** 檢查 2：三票換算後的數值相差的上限（相對）。 */
export const VOTE_TOLERANCE = 0.001;
/** 檢查 3：新聞稿的季末比 XBRL 最新一季晚幾天。 */
export const NEXT_QUARTER_DAYS = [80, 100] as const;
/** 檢查 4：去年同季和 XBRL 相差的上限（金額相對 0.5%、每股盈餘絕對 0.01）。 */
export const YEAR_AGO_TOLERANCE = { amount: 0.005, eps: 0.01 } as const;

const DAY = 86400_000;
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** 證據包的 rule.detail（套用時要用；XBRL 表放完整的數字，程式檢查不用重抓）。 */
export interface EarningsDetail {
  accession: string;
  filingDate: string;
  /** 開的時候這檔你定的、指標算得出來的財報條件（列編號）；套用時以當時的條件為準，這裡只是紀錄。 */
  conds: number[];
  /** 決策日以前的 XBRL 季度表（新的在前）。 */
  xbrl: QuarterRow[];
}

export interface EarningsPackInput {
  ticker: string;
  runId: string;
  asOf: string;
  /** 8-K 的本文與 EX-99.1（兩份原文）。 */
  body: PackDoc;
  exhibit: PackDoc;
  /** XBRL 八季表（對照用，不能當數字的引用）。 */
  xbrlDoc: PackDoc;
  detail: EarningsDetail;
  now: Date;
}

/** OWN_EARNINGS 的證據包：這份 8-K 的本文與 EX-99.1、XBRL 八季表（對照用）。 */
export function earningsPack(inp: EarningsPackInput) {
  const latest = inp.detail.xbrl[0];
  return buildPack({
    runId: inp.runId,
    fn: OWN_EARNINGS,
    promptVersion: OWN_EARNINGS_PROMPT,
    asOf: inp.asOf,
    subject: { ticker: inp.ticker },
    question:
      `${inp.ticker} 今天有新的財報新聞稿（8-K Item 2.02 的 EX-99.1）。請只從新聞稿的 GAAP 損益表，抄出最近一季（單季，不是年初至今的累計）與去年同季的數字：` +
      `${EARNINGS_ITEMS.join('、')}（新聞稿沒有的項目不要寫）。數字照原文的寫法抄（current_text、year_ago_text），不換算、不計算，scale 寫原文的單位倍數（百萬寫 1000000，每股盈餘寫 1）；` +
      '每個數字附引用（evidence_ids），引用的那段原文要同時包含 current_text 與 year_ago_text。不要用非 GAAP、調整後的數字。XBRL 表只是對照，不能當引用。' +
      '抄得到就 verdict = EXTRACTED，payload 寫 period_end（這一季的季末日）與 figures；找不到 GAAP 的單季損益表就 INSUFFICIENT。',
    policy: { level: 'A3', verdicts: ['EXTRACTED', 'INSUFFICIENT'], abstain: 'INSUFFICIENT', min_evidence: 1, samples: OWN_EARNINGS_SAMPLES },
    rule: { action: '規則沒有動作（只抄數字；計算與比對由程式做）', detail: inp.detail },
    facts: latest ? [{ id: 'K1', label: 'XBRL 表最新一季的季末', value: latest.end, note: `${latest.form} ${latest.filed}；這份新聞稿應該是下一季` }] : [],
    premises: [],
    documents: [inp.body, inp.exhibit, inp.xbrlDoc],
    dataQuality: { filings: 'ok', xbrl: 'ok' },
    now: inp.now,
  });
}

/** payload 的格式檢查：EXTRACTED 卻沒有季末日、沒有數字、項目或倍數不認得 → 這一票改成 INSUFFICIENT。 */
export function checkEarningsPayload(s: CheckedSample): void {
  if (s.rawVerdict !== 'EXTRACTED') return;
  const p = s.payload ?? {};
  const bad = (why: string) => {
    s.issues.push(`${why}，這一票改成 INSUFFICIENT`);
    s.verdict = 'INSUFFICIENT';
  };
  if (typeof p.period_end !== 'string' || !DATE.test(p.period_end)) return bad('payload.period_end 不是日期');
  if (!Array.isArray(p.figures) || !p.figures.length) return bad('payload.figures 是空的');
  for (const f of p.figures as Record<string, unknown>[]) {
    if (!f || typeof f !== 'object') return bad('payload.figures 的格式不對');
    if (!EARNINGS_ITEMS.includes(f.item as EarningsItem)) return bad(`項目 ${String(f.item)} 不在列舉內`);
    if (typeof f.current_text !== 'string' || typeof f.year_ago_text !== 'string') return bad(`${String(f.item)} 的 current_text、year_ago_text 要是字串`);
    if (!EARNINGS_SCALES.includes(Number(f.scale)) || (f.item === 'eps_diluted' && Number(f.scale) !== 1)) return bad(`${String(f.item)} 的 scale（${String(f.scale)}）不對`);
    if (!Array.isArray(f.evidence_ids) || !f.evidence_ids.length) return bad(`${String(f.item)} 沒有引用`);
  }
}

/** 原文寫法的數字 → 數值：去掉 $、空白、千分位；括號或負號是負數；不是純數字回傳 null。 */
export function parseFigure(s: string): number | null {
  let t = normalizeText(s).replace(/[$\s]/g, '').replace(/,/g, '');
  let neg = false;
  if (/^\(.*\)$/.test(t)) {
    neg = true;
    t = t.slice(1, -1);
  }
  if (t.startsWith('-')) {
    neg = !neg;
    t = t.slice(1);
  }
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  return (neg ? -1 : 1) * Number(t);
}

/** 數字（照原文的寫法，去掉 $ 與空白）有沒有出現在引用裡：前後不能接著別的數字（1.9 不算出現在 1.95 裡）。 */
export function figureInQuote(text: string, quote: string): boolean {
  const t = normalizeText(text).replace(/[$\s]/g, '');
  if (!t || !/\d/.test(t)) return false;
  const esc = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\d.,])${esc}(?![\\d]|[.,]\\d)`).test(normalizeText(quote));
}

export interface Extracted {
  current: number;
  yearAgo: number;
}
export type Figures = Partial<Record<EarningsItem, Extracted>>;

export type EarningsDecision =
  | { ok: false; check: 0 | 1 | 2 | 3 | 4; why: string }
  | { ok: true; period: string; figures: Figures; dropped: string[]; why: string };

const ITEM_TEXT: Record<EarningsItem, string> = { revenue: '營收', gross_profit: '毛利', cost_of_revenue: '營業成本', operating_income: '營業利益', net_income: '淨利', eps_diluted: '稀釋每股盈餘' };
const within = (a: number, b: number, rel: number) => Math.abs(a - b) <= rel * Math.max(Math.abs(a), Math.abs(b));

/** 同一季的去年（季末差 365 天 ± 20 天）。 */
export const yearAgoRow = (rows: QuarterRow[], end: string): QuarterRow | undefined => rows.find((r) => Math.abs(daysBetween(r.end, end) - 365) <= 20);

/** XBRL 表裡某個項目的值（營業成本 = 營收 − 毛利）。 */
function xbrlValue(r: QuarterRow, item: EarningsItem): number | null {
  switch (item) {
    case 'revenue':
      return r.revenue;
    case 'gross_profit':
      return r.grossProfit;
    case 'cost_of_revenue':
      return r.revenue !== null && r.grossProfit !== null ? r.revenue - r.grossProfit : null;
    case 'operating_income':
      return r.operatingIncome;
    case 'net_income':
      return r.netIncome;
    case 'eps_diluted':
      return r.epsDiluted;
  }
}

/**
 * 三票的擷取 → 採用哪些數字（own_thesis §1.11 的第 1～4 項檢查）。
 * pack：證據包（引用要是申報原文，kind = filing）；rows：開的時候的 XBRL 季度表（新的在前，rule.detail.xbrl）。
 */
export function earningsDecision(outcome: Outcome, pack: Pick<EvidencePack, 'documents'>, rows: QuarterRow[]): EarningsDecision {
  if (outcome.status !== 'AGREED' || outcome.verdict !== 'EXTRACTED' || !outcome.actionable) return { ok: false, check: 0, why: outcome.reason };
  const samples = outcome.samples;
  // 檢查 2 的前半：三票都合格
  if (samples.length < OWN_EARNINGS_SAMPLES || samples.some((s) => !s.valid || s.verdict !== 'EXTRACTED')) return { ok: false, check: 2, why: `要 ${OWN_EARNINGS_SAMPLES} 票都合格` };
  const filings = new Set(pack.documents.filter((d) => d.kind === 'filing').map((d) => d.source_id));

  // 檢查 1：每個數字都要在它引用的申報原文裡；同時把原文的寫法換算成數值
  const perVote: { period: string; figs: Map<EarningsItem, Extracted> }[] = [];
  for (const s of samples) {
    const p = s.payload ?? {};
    const quotes = new Map(s.evidence.filter((e) => e.ok && filings.has(e.source_id)).map((e) => [e.id, e.quote]));
    const figs = new Map<EarningsItem, Extracted>();
    for (const f of (p.figures as Record<string, unknown>[] | undefined) ?? []) {
      const item = f.item as EarningsItem;
      const label = `第 ${s.index + 1} 票的${ITEM_TEXT[item] ?? String(item)}`;
      const cited = ((f.evidence_ids as unknown[] | undefined) ?? []).map((id) => quotes.get(String(id))).filter((q): q is string => !!q);
      const cur = String(f.current_text ?? '');
      const ago = String(f.year_ago_text ?? '');
      if (!cited.some((q) => figureInQuote(cur, q)) || !cited.some((q) => figureInQuote(ago, q))) return { ok: false, check: 1, why: `${label}（${cur}、${ago}）不在它引用的申報原文裡` };
      const a = parseFigure(cur);
      const b = parseFigure(ago);
      if (a === null || b === null) return { ok: false, check: 2, why: `${label}（${cur}、${ago}）換算不成數字` };
      if (!figs.has(item)) figs.set(item, { current: a * Number(f.scale), yearAgo: b * Number(f.scale) });
    }
    perVote.push({ period: String(p.period_end ?? ''), figs });
  }

  // 檢查 2：季末相同；三票都有的項目，數值相差不超過 0.1%
  const periods = new Set(perVote.map((v) => v.period));
  if (periods.size !== 1) return { ok: false, check: 2, why: `三票的季末不同（${[...periods].join('、')}）` };
  const period = perVote[0].period;
  const common = EARNINGS_ITEMS.filter((it) => perVote.every((v) => v.figs.has(it)));
  if (!common.length) return { ok: false, check: 2, why: '沒有三票都抄到的項目' };
  const figures: Figures = {};
  for (const it of common) {
    const vs = perVote.map((v) => v.figs.get(it)!);
    const agree = (k: keyof Extracted) => vs.every((x) => within(x[k], vs[0][k], VOTE_TOLERANCE));
    if (!agree('current') || !agree('yearAgo')) return { ok: false, check: 2, why: `三票的${ITEM_TEXT[it]}相差超過 0.1%（${vs.map((x) => x.current).join('、')}）` };
    figures[it] = vs[0];
  }

  // 檢查 3：確實是 XBRL 最新一季的下一季
  const latest = rows[0];
  if (!latest) return { ok: false, check: 3, why: 'XBRL 沒有季度數字' };
  const gap = daysBetween(latest.end, period);
  if (gap < NEXT_QUARTER_DAYS[0] || gap > NEXT_QUARTER_DAYS[1]) return { ok: false, check: 3, why: `季末 ${period} 比 XBRL 最新一季 ${latest.end} 晚 ${gap} 天，不是下一季` };

  // 檢查 4：去年同季要和 XBRL 相符；對不上的項目不採用
  const ya = yearAgoRow(rows, period);
  const dropped: string[] = [];
  for (const it of common) {
    const x = ya ? xbrlValue(ya, it) : null;
    const v = figures[it]!.yearAgo;
    if (x === null) dropped.push(`${ITEM_TEXT[it]}：XBRL 沒有去年同季的值`);
    else if (it === 'eps_diluted' ? Math.abs(v - x) > YEAR_AGO_TOLERANCE.eps : !within(v, x, YEAR_AGO_TOLERANCE.amount)) dropped.push(`${ITEM_TEXT[it]}：去年同季新聞稿 ${v}，XBRL ${x}，對不上`);
    else continue;
    delete figures[it];
  }
  if (!Object.keys(figures).length) return { ok: false, check: 4, why: `沒有一項的去年同季和 XBRL 相符（${dropped.join('；')}）` };
  const used = EARNINGS_ITEMS.filter((it) => figures[it]).map((it) => ITEM_TEXT[it]);
  return { ok: true, period, figures, dropped, why: `採用 ${period} 這一季的${used.join('、')}${dropped.length ? `；不採用：${dropped.join('；')}` : ''}` };
}

/**
 * 第 5 項：通過的項目由程式算出這一季的指標，排成 XBRL 季度表的一列（接在 XBRL 表前面就能用 xbrlConditionMet、xbrlProgress）。
 * 算不出來的指標是 null（第 6 項就不判斷那條條件）；現金流不支援。
 */
export function pressRow(period: string, f: Figures, rows: QuarterRow[], meta: { filingDate: string; accession: string }): QuarterRow {
  const revenue = f.revenue?.current ?? null;
  const gp = f.gross_profit?.current ?? (revenue !== null && f.cost_of_revenue ? revenue - f.cost_of_revenue.current : null);
  const op = f.operating_income?.current ?? null;
  const ni = f.net_income?.current ?? null;
  const ratio = (a: number | null) => (a !== null && revenue !== null && revenue !== 0 ? a / revenue : null);
  const ya = yearAgoRow(rows, period)?.revenue ?? null;
  return {
    end: period,
    filed: meta.filingDate,
    form: '8-K',
    accn: meta.accession,
    revenue,
    grossProfit: gp,
    operatingIncome: op,
    netIncome: ni,
    epsDiluted: f.eps_diluted?.current ?? null,
    cfo: null,
    grossMarginPct: ratio(gp),
    operatingMarginPct: ratio(op),
    netMarginPct: ratio(ni),
    revenueYoY: revenue !== null && ya !== null && ya !== 0 ? (revenue - ya) / ya : null,
    cfoToNetIncome: null,
  };
}

/** 這條條件能不能用新聞稿判斷：財報類、指標在可算的範圍內。 */
export const pressCheckable = (c: { kind: string; check: Record<string, unknown> }) => c.kind === 'XBRL' && PRESS_METRICS.has(String(c.check.metric)) && String(c.check.metric) in XBRL_METRICS;
