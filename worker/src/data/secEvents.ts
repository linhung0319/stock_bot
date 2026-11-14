// T11：EDGAR 申報的規則分類（ai_layer_design F1 ①④⑤、F18、F19；分類邏輯移植自 backtest/b9_events.py，B-9 已回測）。
//
// 只看申報類型就能判斷的（NT 10-K／10-Q、8-K 的 Item 編號、SC 14D9）直接分類；要讀封面才能判斷的：
//   8-K 4.01        會計師辭任／公司解任／退休計畫／合併後統一（只有辭任才升級，2026-11-11 決定）
//   PREM14A 等委託書 本公司是被收購方還是收購方（只看申報類型會把收購方算進來：B-9 的 14 次否決全是收購方）
//   SC TO-T         封面的 Name of Subject Company 是不是本公司
//   424B1／B4／B5   普通股、可轉債還是一般債券（增資只顯示、不否決）
// 分類函式是純函式（輸入原文），抓原文的函式在最後。
import { filingDir, htmlToText } from './edgar';
import type { Fetcher, Filing } from './sources';

/** 規則偵測的代碼（F1 的失效模式、F19 的硬事件）。 */
export type HitCode = 'PENDING_MA' | 'ACCOUNTING' | 'REGULATORY' | 'DILUTION' | 'ONE_OFF_JUMP' | 'EARNINGS_DIVERGENCE' | 'DATA_SUSPECT';

export interface FilingHit {
  /** HitCode；每日掃描、F7／F20 轉交的事件也存在同一張表（代碼可能是掃描的類別）。 */
  code: HitCode | (string & {});
  /** 細項：NT_10-K、8K_4.02、8K_4.01_RESIGN、SC_14D9、DEFM14A_TARGET、424B5_EQUITY… */
  sub: string;
  accession: string;
  form: string;
  date: string;
  acceptedAt: string;
  /** 規則就能下結論（NT、被收購方）→ 不用 LLM；false → 要 LLM 判斷重大性。 */
  byRule: boolean;
  /** 只顯示（增資）。 */
  displayOnly?: boolean;
  detail?: string;
}

export const MA_PROXY_FORMS = ['PREM14A', 'DEFM14A', 'PREM14C', 'DEFM14C'];
export const B424_FORMS = ['424B1', '424B4', '424B5'];
/** 有效期間（天）：被收購 365、會計 180、增資 180（B-9 的 WINDOW）。 */
export const HIT_WINDOW: Record<string, number> = { PENDING_MA: 365, ACCOUNTING: 180, DILUTION: 180 };
/** F18 會轉給 LLM 分類的 8-K 項目（規則分不出輕重的）。 */
export const SCAN_ITEMS = ['1.01', '1.02', '1.03', '2.05', '2.06', '3.02', '5.02', '7.01', '8.01'];

const has = (f: Pick<Filing, 'items'>, item: string) => f.items.includes(item);
const is8k = (f: Pick<Filing, 'form'>) => f.form === '8-K' || f.form === '8-K/A';

/** 這份申報要不要讀原文才能分類。 */
export function needsCover(f: Pick<Filing, 'form' | 'items'>): boolean {
  return (is8k(f) && has(f, '4.01')) || MA_PROXY_FORMS.includes(f.form) || f.form === 'SC TO-T' || B424_FORMS.includes(f.form);
}

/** 只看類型與 Item 就能分類的部分（不用原文）。 */
export function quickHits(f: Filing): FilingHit[] {
  const base = { accession: f.accession, form: f.form, date: f.filingDate, acceptedAt: f.acceptedAt };
  const out: FilingHit[] = [];
  if (f.form === 'NT 10-K' || f.form === 'NT 10-Q') out.push({ ...base, code: 'ACCOUNTING', sub: f.form.replace(' ', '_'), byRule: true, detail: '延遲申報（B-9：之後 12 個月相對 SPY −8.9%）' });
  if (is8k(f) && has(f, '4.02')) out.push({ ...base, code: 'ACCOUNTING', sub: '8K_4.02', byRule: false, detail: '財報不可信賴（重編）：要判斷是否重大' });
  if (f.form === 'SC 14D9') out.push({ ...base, code: 'PENDING_MA', sub: 'SC_14D9', byRule: true, detail: '公開收購的被收購方回應（只有被收購方會申報）' });
  if (is8k(f) && has(f, '3.02')) out.push({ ...base, code: 'DILUTION', sub: '8K_3.02', byRule: true, displayOnly: true, detail: '未登記的股票發行（規模不明）' });
  return out;
}

// ---------------------------------------------------------------- 8-K 4.01

const AUD_RESIGN = /(resign|declin\w* to stand for re-?(?:election|appointment|engagement)|not (?:to )?stand for re-?(?:election|appointment)|will not seek re-?(?:election|appointment)|informed .{0,80}? (?:that it|of its decision) .{0,60}?(?:not|decline))/i;
const AUD_PLAN = /((?:401\(k\)|retirement|savings|thrift|stock purchase|investment|profit sharing|incentive savings)\s+plan[s]?\b.{0,200}?(?:auditor|accountant|financial statements|form 11-k)|form 11-k|financial statements of the plan|the plan's)/i;
const AUD_MERGER = /(merger|acquisition|business combination|consummation of the|spin-off|separation).{0,300}?(dismiss|engage|auditor|accounting firm)/i;
const DISAGREE = /there (?:were|have been) (?:no|not been any) ["“]?disagreements/i;

export type Kind401 = 'RESIGN' | 'MIXED' | 'DISMISS' | 'MERGER' | 'PLAN' | 'NEW_ONLY' | 'UNKNOWN';

/** 8-K 4.01：看 Item 4.01 那一節。只有會計師辭任（RESIGN、MIXED）才升級。 */
export function classify401(text: string): { kind: Kind401; noDisagree: boolean } {
  const k = /item\s*4\.?01/i.exec(text);
  const sec = k ? text.slice(k.index, k.index + 6000) : text.slice(0, 6000);
  const plan = AUD_PLAN.test(sec.slice(0, 2500));
  const resign = AUD_RESIGN.test(sec);
  const dismiss = /dismiss/i.test(sec);
  const merger = AUD_MERGER.test(sec.slice(0, 3000));
  let kind: Kind401;
  if (plan) kind = 'PLAN';
  else if (resign && !dismiss) kind = 'RESIGN';
  else if (dismiss && !resign) kind = merger ? 'MERGER' : 'DISMISS';
  else if (resign && dismiss) kind = 'MIXED';
  else if (/engage|appoint|select/i.test(sec)) kind = 'NEW_ONLY';
  else kind = 'UNKNOWN';
  return { kind, noDisagree: DISAGREE.test(sec) };
}

// ---------------------------------------------------------------- 合併委託書、公開收購

const STOP = new Set(['INC', 'CORP', 'CORPORATION', 'CO', 'PLC', 'LTD', 'LLC', 'THE', 'COMPANY', 'HOLDINGS', 'GROUP', 'NV', 'SA', 'AG', 'LP', 'DEL', 'NEW']);
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 公司名稱的簡稱（'AON PLC' → ['AON']；'Newmont Corp /DE/' → ['Newmont']），已跳脫成正規表示式。 */
export function shortNames(name: string): string[] {
  const n = (name ?? '').replace(/\/[A-Z]{2}\/?/g, '').replace(/[,.]/g, ' ');
  const words = n.split(/\s+/).filter((w) => w && !STOP.has(w.toUpperCase()));
  const out: string[] = [];
  if (words.length) {
    out.push(esc(words[0]));
    if (words.length > 1) out.push(esc(words.slice(0, 2).join(' ')));
  }
  return out;
}

const PER_SHARE = /\$\s?(\d{1,4}(?:\.\d{1,4})?)\s*(?:per share)?,?\s*in cash/gi;

export type ProxyRole = 'TARGET' | 'ACQUIRER' | 'ASSET_SALE' | 'REORG' | 'UNCLEAR';

/**
 * PREM14A／DEFM14A：本公司是被收購方還是收購方（只看封面信，前 30000 字）。
 * 被收購方：「每一股普通股將轉換成收取…的權利」「Merger Sub 將併入本公司」「本公司將成為 X 的完全子公司」。
 * 收購方：「發行本公司股票給對方股東」，而且沒有上面任何一句。
 */
export function classifyProxy(text: string, ownNames: string[]): { role: ProxyRole; offerPx: number | null } {
  const t = text.slice(0, 30000);
  let names = [...new Set(ownNames.flatMap(shortNames))];
  for (const n of [...names]) {
    const re = new RegExp(n + '[^()“”"]{0,60}\\((?:which (?:we|is) (?:refer|referred) to (?:herein )?as |referred to as |the |hereinafter )?[“"]([A-Z][\\w&.\\- ]{1,30})[”"]', 'gi');
    for (const m of t.matchAll(re)) names.push(esc(m[1]));
  }
  names = [...new Set(names)];
  const alt = names.join('|');
  const self = names.length ? `(?:the company|our company|us|${alt})` : '(?:the company|us)';
  const selfPoss = names.length ? `(?:the company[’']s|our|${names.map((n) => `${n}(?:[’']s)?`).join('|')})` : "(?:the company[’']s|our)";
  const conv = new RegExp(`each (?:issued and )?(?:outstanding )?share of (?:${selfPoss}\\s+)?(?:class [a-z] )?(?:common|ordinary) (?:stock|shares?)[^.]{0,250}?(?:converted into|right to receive|exchanged for|cancell?ed)`, 'i').test(t);
  const intoUs = new RegExp(`merged? (?:with and )?into ${self}\\b`, 'i').test(t);
  const subOf = new RegExp(`${self}\\b[^.]{0,80}?(?:(?:will|would) (?:become|continue as)|surviv\\w*[^.]{0,40}?as) (?:a |an )?(?:direct |indirect )?(?:wholly[- ]owned )?subsidiary of`, 'i').test(t);
  const acquired = new RegExp(`${self}\\b[^.]{0,40}?(?:will|would) be acquired by|(?:acquisition|purchase) of ${self}\\b by`, 'i').test(t);
  const issuance = new RegExp(`(issuance of (?:shares of )?${selfPoss}\\s+(?:class a )?common stock|share issuance proposal|stock issuance proposal|issue shares of ${selfPoss})`, 'i').test(t);
  const sale = /(sale of (?:all or )?substantially all|asset sale)/i.test(t);
  const px = [...t.matchAll(PER_SHARE)].map((m) => Number(m[1])).filter((x) => x >= 1);
  const reorg = /(redomesticat|redomicil|holding company (?:reorganization|structure)|reorganization (?:transaction|merger)|change (?:the|our|its) (?:place|jurisdiction) of (?:incorporation|organization)|convert\w* to a REIT|REIT conversion|qualify (?:as|to be taxed as) a real estate investment trust)/i.test(t.slice(0, 12000));
  let role: ProxyRole;
  if (conv || ((intoUs || subOf || acquired) && (!issuance || px.length))) role = 'TARGET';
  else if (issuance) role = 'ACQUIRER';
  else if (sale) role = 'ASSET_SALE';
  else role = 'UNCLEAR';
  if (reorg && !px.length && role === 'TARGET') role = 'REORG';
  return { role, offerPx: px[0] ?? null };
}

/** SC TO-T：封面「X (Name of Subject Company (Issuer))」是不是本公司。 */
export function tenderSubject(text: string, ownNames: string[]): { target: boolean; subject: string } {
  const m = /([^()]{3,160}?)\s*\(\s*Name of Subject Company/i.exec(text.slice(0, 15000));
  const subject = m ? m[1].trim().slice(-120) : '';
  const own = ownNames.flatMap((x) => shortNames(x).slice(-1));
  const target = !!subject && own.some((n) => n && new RegExp(`\\b${n}\\b`, 'i').test(subject));
  return { target, subject };
}

// ---------------------------------------------------------------- 424B（增資，只顯示）

const COVER_EQ = /\b(?:shares of (?:our |its )?(?:class [ab] )?common stock|common shares|ordinary shares|common stock)\b/i;
const COVER_DEBT = /\b(notes due|% notes|senior notes|debentures|floating rate notes|subordinated notes|medium-term notes|principal amount|bonds due|% senior|trust preferred|depositary shares|preferred stock|warrants? (?:linked|due))/i;
const CONVERT = /(?:(?<!not )(?<!not be )\bconvertible (?:senior |subordinated |unsecured |exchangeable )*(?:notes|debentures|bonds)\b|\bmandatory convertible\b|\bconvertible (?:perpetual )?preferred\b(?! stock[^.]{0,40}not convertible))/i;

export type Kind424 = 'EQUITY' | 'CONVERTIBLE' | 'DEBT' | 'EQUITY_SECONDARY' | 'EQUITY_PLAN' | 'OTHER';

/** 424B1／B4／B5 封面：普通股／可轉債／債券；股數（算規模用）。 */
export function classify424(text: string): { kind: Kind424; shares: number | null; atm: boolean } {
  const k = /\(\s*to (?:the )?prospectus dated/i.exec(text);
  const start = k ? Math.max(0, k.index - 600) : 0;
  const cover = text.slice(start, start + 2600);
  const eqM = COVER_EQ.exec(cover);
  const debtM = COVER_DEBT.exec(cover);
  let kind: Kind424;
  if (CONVERT.test(cover)) kind = 'CONVERTIBLE';
  else if (eqM && !debtM) kind = 'EQUITY';
  else if (eqM && debtM) kind = eqM.index < debtM.index ? 'EQUITY' : 'DEBT';
  else kind = debtM ? 'DEBT' : 'OTHER';
  const selling = /(selling (?:stock|share)holders?|selling shareholder|we will not receive any (?:of the )?proceeds|the selling stockholder|being sold by|offered by the selling)/i.test(cover);
  const drip = /(dividend reinvestment|direct stock purchase|employee stock|stock purchase plan|savings plan)/i.test(cover);
  if (kind === 'EQUITY' && selling) kind = 'EQUITY_SECONDARY';
  if (kind === 'EQUITY' && drip) kind = 'EQUITY_PLAN';
  const sh = /([\d,]{5,})\s+(?:shares|common shares)/i.exec(cover);
  const atm = /(at[- ]the[- ]market|sales agent|equity distribution|distribution agreement|equity sales agreement)/i.test(cover);
  return { kind, shares: sh ? Number(sh[1].replace(/,/g, '')) : null, atm };
}

/** 讀過原文之後的分類。names：這家公司的名稱（EDGAR 的 name）。 */
export function coverHits(f: Filing, text: string, names: string[]): FilingHit[] {
  const base = { accession: f.accession, form: f.form, date: f.filingDate, acceptedAt: f.acceptedAt };
  const out: FilingHit[] = [];
  if (is8k(f) && has(f, '4.01')) {
    const c = classify401(text);
    if (c.kind === 'RESIGN' || c.kind === 'MIXED') out.push({ ...base, code: 'ACCOUNTING', sub: '8K_4.01_RESIGN', byRule: false, detail: `會計師辭任${c.noDisagree ? '（申報寫沒有意見不合）' : ''}` });
    else out.push({ ...base, code: 'ACCOUNTING', sub: `8K_4.01_${c.kind}`, byRule: true, displayOnly: true, detail: '換會計師（不是會計師辭任，只記錄）' });
  }
  if (MA_PROXY_FORMS.includes(f.form)) {
    const c = classifyProxy(text, names);
    if (c.role === 'TARGET') out.push({ ...base, code: 'PENDING_MA', sub: `${f.form}_TARGET`, byRule: true, detail: `合併委託書：本公司是被收購方${c.offerPx ? `（每股現金 $${c.offerPx}）` : ''}` });
    else out.push({ ...base, code: 'PENDING_MA', sub: `${f.form}_${c.role}`, byRule: true, displayOnly: true, detail: '合併委託書，但本公司不是被收購方（只記錄）' });
  }
  if (f.form === 'SC TO-T') {
    const c = tenderSubject(text, names);
    if (c.target) out.push({ ...base, code: 'PENDING_MA', sub: 'SC_TO-T_TARGET', byRule: true, detail: `公開收購的對象是本公司（${c.subject.slice(-60)}）` });
    else out.push({ ...base, code: 'PENDING_MA', sub: 'SC_TO-T_OTHER', byRule: true, displayOnly: true, detail: '公開收購，但對象不是本公司（只記錄）' });
  }
  if (B424_FORMS.includes(f.form)) {
    const c = classify424(text);
    if (c.kind === 'EQUITY' || c.kind === 'CONVERTIBLE') out.push({ ...base, code: 'DILUTION', sub: `${f.form}_${c.kind}`, byRule: true, displayOnly: true, detail: `${c.kind === 'EQUITY' ? '發行普通股' : '發行可轉換證券'}${c.shares ? `（${c.shares.toLocaleString('en-US')} 股）` : ''}${c.atm ? '，市價發行' : ''}` });
  }
  return out;
}

/** 有效期間內的命中（決策日往回算）。 */
export function activeHits(hits: FilingHit[], asOf: string): FilingHit[] {
  const t = Date.parse(asOf);
  return hits.filter((h) => h.date <= asOf && (t - Date.parse(h.date)) / 86400_000 <= (HIT_WINDOW[h.code] ?? 180));
}

// ---------------------------------------------------------------- 抓原文

/** 申報主文件的純文字（前 maxChars 字；封面判斷只需要開頭）。 */
export async function fetchPrimaryText(fetcher: Fetcher, cik: string | number, f: Pick<Filing, 'accession' | 'primaryDocument'>, userAgent: string, maxChars = 120_000): Promise<{ url: string; text: string }> {
  const url = `${filingDir(cik, f.accession)}/${f.primaryDocument}`;
  const r = await fetcher(url, { headers: { 'User-Agent': userAgent } });
  if (!r.ok) throw new Error(`EDGAR ${url} HTTP ${r.status}`);
  const raw = await r.text();
  return { url, text: htmlToText(raw.slice(0, maxChars * 4)).slice(0, maxChars) };
}

/** 一組申報 → 命中（要讀封面的才抓原文；抓不到的記在 notes）。 */
export async function classifyFilings(fetcher: Fetcher, cik: string, names: string[], filings: Filing[], userAgent: string, notes: string[]): Promise<FilingHit[]> {
  const out: FilingHit[] = [];
  for (const f of filings) {
    out.push(...quickHits(f));
    if (!needsCover(f)) continue;
    try {
      const { text } = await fetchPrimaryText(fetcher, cik, f, userAgent, B424_FORMS.includes(f.form) ? 60_000 : 120_000);
      out.push(...coverHits(f, text, names));
    } catch (e) {
      notes.push(`${f.form} ${f.accession} 的原文抓不到：${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------- XBRL 的小檔（companyconcept）

export interface ConceptFact {
  start?: string;
  end: string;
  val: number;
  filed: string;
  form: string;
  fp?: string;
}

export const companyConceptUrl = (cik: string | number, taxonomy: string, tag: string) => `https://data.sec.gov/api/xbrl/companyconcept/CIK${String(cik).replace(/\D/g, '').padStart(10, '0')}/${taxonomy}/${tag}.json`;

/** 一個 XBRL 概念的所有值（companyconcept，比 companyfacts 小很多）。404（公司沒報這個概念）回傳空陣列。 */
export async function fetchConcept(fetcher: Fetcher, cik: string | number, taxonomy: string, tag: string, userAgent: string): Promise<ConceptFact[]> {
  const r = await fetcher(companyConceptUrl(cik, taxonomy, tag), { headers: { 'User-Agent': userAgent, Accept: 'application/json' } });
  if (r.status === 404) return [];
  if (!r.ok) throw new Error(`EDGAR companyconcept ${tag} HTTP ${r.status}`);
  const j = (await r.json()) as { units?: Record<string, ConceptFact[]> };
  return Object.values(j.units ?? {}).flat();
}
