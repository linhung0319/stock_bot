// T51：Worker 抓網頁全文、存快照（設計 docs/design/web_evidence_design_2026-11-20.md §1.4）。
// 從量測用的 webProbe.ts 改：只抓清單內的 https 網址、轉址也要留在清單內、只收 HTML、內文太短不收、認不出發布日不收。
// 快照只存在 D1 的 web_docs（repo 是公開的）。取文件的端點與證據包的接法在 T52。
import { htmlToText } from './edgar';
import type { Fetcher } from './sources';
import { matchWebSource, type WebExtract, type WebSourceMatch, type WebTier } from './webSources';

export const WEB_DOC_TIMEOUT_MS = 15_000;
export const WEB_DOC_MAX_BYTES = 2_000_000;
/** 內文（超過 200 字的段落）合計少於這個字數 → THIN。 */
export const WEB_DOC_MIN_BODY = 1_500;
export const WEB_DOC_PARA_MIN = 200;
/** 快照存的文字上限（開頭起算）。 */
export const WEB_DOC_MAX_TEXT = 30_000;
/** 同一個網站一次執行最多抓幾篇。 */
export const WEB_DOC_PER_SITE = 4;
/** 網頁和 RSS 的發布日差超過幾天算不一致。 */
export const WEB_DOC_DATE_CONFLICT_DAYS = 3;
/** 沒被用過的快照幾天後清掉全文。 */
export const WEB_DOC_KEEP_UNUSED_DAYS = 180;
const MAX_REDIRECTS = 5;

const HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' };

export type WebDocStatus = 'OK' | 'THIN' | 'BLOCKED' | 'UNSUPPORTED' | 'NOT_LISTED' | 'NO_DATE' | 'TOO_OLD' | 'ERROR';
export type WebDocVia = 'MENU' | 'SEARCH' | 'MANUAL';

export interface WebDocFetched {
  /** 整理過的網址（去掉 # 與 utm_ 參數）；不是合格網址時是原字串。 */
  url: string;
  id: string;
  /** `LIMIT`：這個網站這次執行已經抓滿，沒有去抓（不寫進 web_docs，由呼叫的人記在執行紀錄）。 */
  status: WebDocStatus | 'LIMIT';
  finalUrl: string | null;
  domain: string | null;
  tier: WebTier | null;
  label: string | null;
  httpStatus: number | null;
  title: string | null;
  published: string | null;
  publishedFrom: string | null;
  dateConflict: boolean;
  chars: number | null;
  truncated: boolean;
  /** 只有 OK 有。 */
  text: string | null;
  textSha256: string | null;
  error: string | null;
}

export interface WebDocOptions {
  /** 這檔自己的一手網域（OwnMeta.webSources.domains）。 */
  extraDomains?: readonly string[];
  /** RSS 或搜尋結果給的標題（網頁沒有標題、或沒去抓時用）。 */
  title?: string | null;
  /** RSS 的發布時間（YYYY-MM-DD 或 ISO）。 */
  rssPublished?: string | null;
  /** 這次執行每個網站已經抓了幾篇（會被更新）。 */
  siteCount?: Map<string, number>;
  /** 發布日不能晚於這天（決策日）；沒給就用 now 的 UTC 日期。 */
  decisionDate?: string;
  /** 發布日早於這天 → TOO_OLD（§1.5：上次有結論的審查前 120 天）。 */
  notBefore?: string | null;
}

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
export async function sha256Hex(s: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
}

/** 整理網址：去掉 #、utm_ 參數。 */
export function normalizeWebUrl(u: URL): string {
  const v = new URL(u.toString());
  v.hash = '';
  for (const k of [...v.searchParams.keys()]) if (/^utm_/i.test(k)) v.searchParams.delete(k);
  return v.toString();
}

export async function webDocId(url: string): Promise<string> {
  return `web:${(await sha256Hex(url)).slice(0, 16)}`;
}

// ---------------------------------------------------------------- 發布日

/** 只收 https、公開的主機名稱（不收 IP、localhost、內部網域）。 */
export function safeWebUrl(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return null;
  const h = u.hostname.toLowerCase();
  if (!h.includes('.') || /^[\d.]+$/.test(h) || h.includes(':') || /(^|\.)(localhost|local|internal|workers\.dev)$/.test(h)) return null;
  return u;
}

const ISO = /\d{4}-\d{2}-\d{2}(?:T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?/;

/** 從 HTML 找發布日期：meta（article:published_time 等）、JSON-LD 的 datePublished、<time datetime>。 */
export function findPublished(html: string): { date: string; from: string } | null {
  const tries: [string, RegExp][] = [
    ['meta', /<meta[^>]+(?:property|name|itemprop)=["'](?:article:published_time|og:published_time|datePublished|publish[-_]?date|pubdate|date|dc\.date(?:\.issued)?|parsely-pub-date|sailthru\.date)["'][^>]*content=["']([^"']+)["']/i],
    ['meta', /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name|itemprop)=["'](?:article:published_time|og:published_time|datePublished|publish[-_]?date|pubdate|parsely-pub-date)["']/i],
    ['json-ld', /"datePublished"\s*:\s*"([^"]+)"/i],
    ['time', /<time[^>]+datetime=["']([^"']+)["']/i],
  ];
  for (const [from, re] of tries) {
    const m = re.exec(html);
    const iso = m && ISO.exec(m[1]);
    if (iso) return { date: iso[0].slice(0, 10), from };
    if (m) {
      const d = new Date(m[1]);
      if (!Number.isNaN(d.getTime())) return { date: d.toISOString().slice(0, 10), from };
    }
  }
  return null;
}


const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MON = String.raw`(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?`;
const DATE_RES: [RegExp, (m: RegExpExecArray) => [number, number, number]][] = [
  [new RegExp(String.raw`^${MON}\s*(\d{1,2}),?\s+(\d{4})\b`, 'i'), (m) => [Number(m[3]), MONTHS.indexOf(m[1].toLowerCase()) + 1, Number(m[2])]],
  [new RegExp(String.raw`^(\d{1,2})\s+${MON}\s+(\d{4})\b`, 'i'), (m) => [Number(m[3]), MONTHS.indexOf(m[2].toLowerCase()) + 1, Number(m[1])]],
  [/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})\b/, (m) => [Number(m[1]), Number(m[2]), Number(m[3])]],
];
const LABEL = /^(?:published|posted|date)\s*:?\s*/i;
const NOT_PUBLISHED_LABEL = /^(?:updated|last updated|modified|revised)\b/i;

/** 一行是不是「只有日期」（可以帶 Published／Posted／Date 與後面的時間），是的話回 YYYY-MM-DD。 */
export function dateLine(line: string): string | null {
  const s = line.trim();
  if (s.length > 60) return null;
  const rest = s.replace(LABEL, '');
  for (const [re, pick] of DATE_RES) {
    const m = re.exec(rest);
    if (!m) continue;
    const tail = rest.slice(m[0].length);
    if (tail.length > 32 || /[a-z]{4,}/i.test(tail.replace(/\b(?:AM|PM|GMT|UTC|KST|EST|EDT|PST|PDT|CST|CET)\b/gi, ''))) return null;
    const [y, mo, d] = pick(m);
    const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const t = new Date(`${iso}T00:00:00Z`);
    return y >= 1990 && mo >= 1 && mo <= 12 && !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === iso ? iso : null;
  }
  return null;
}

/**
 * 網頁沒有 meta／JSON-LD／<time> 時的備案：第一段內文（> 200 字）之前 15 行內、單獨一行的日期
 * （新聞稿標題下面那一行；「Published」那一行）。前一行是 Updated／Modified 的不算。
 * 只看內文之前，避免抓到頁面旁邊「其他文章」的日期。
 */
export function findPublishedInText(text: string): string | null {
  const lines = text.split('\n').map((l) => l.trim());
  const fb = lines.findIndex((l) => l.length > WEB_DOC_PARA_MIN);
  if (fb <= 0) return null;
  for (let i = Math.max(0, fb - 15); i < fb; i++) {
    const d = dateLine(lines[i]);
    if (!d) continue;
    let p = i - 1;
    while (p >= 0 && !lines[p]) p--;
    if (p >= 0 && NOT_PUBLISHED_LABEL.test(lines[p])) continue;
    if (NOT_PUBLISHED_LABEL.test(lines[i])) continue;
    return d;
  }
  return null;
}

const dayDiff = (a: string, b: string) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;

/** 網頁的發布日與 RSS 的發布日合起來：都有而且差超過 3 天 → 用比較晚的，標不一致。 */
export function resolvePublished(page: { date: string; from: string } | null, rss: string | null | undefined): { published: string | null; from: string | null; conflict: boolean } {
  const r = rss && /^\d{4}-\d{2}-\d{2}/.test(rss) ? rss.slice(0, 10) : null;
  if (page && r) {
    if (dayDiff(page.date, r) > WEB_DOC_DATE_CONFLICT_DAYS) return page.date >= r ? { published: page.date, from: page.from, conflict: true } : { published: r, from: 'rss', conflict: true };
    return { published: page.date, from: page.from, conflict: false };
  }
  if (page) return { published: page.date, from: page.from, conflict: false };
  if (r) return { published: r, from: 'rss', conflict: false };
  return { published: null, from: null, conflict: false };
}

// ---------------------------------------------------------------- 官方來源的擷取（T64，composite_layer_design §5.1）

const WEEKDAY = /\b(?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day,?\s+(.+)$/i;
/** 發布時間那一行往回找幾行（不算空行）。 */
const RELEASE_LINES_BACK = 25;

/**
 * 內文之前「…星期幾, 月 日, 年」結尾的那一行（勞工統計局新聞稿開頭的 `8:30 a.m. (ET) Friday, September 5, 2025`）→ YYYY-MM-DD。
 * 只在來源寫了 extract.releaseLine 時用；只看第一段內文之前、不算空行的 25 行內，一行最多 120 字。
 */
export function findReleaseDate(text: string): string | null {
  const lines = text.split('\n').map((l) => l.trim());
  const fb = lines.findIndex((l) => l.length > WEB_DOC_PARA_MIN);
  if (fb <= 0) return null;
  let seen = 0;
  for (let i = fb - 1; i >= 0 && seen < RELEASE_LINES_BACK; i--) {
    if (!lines[i]) continue;
    seen++;
    if (lines[i].length > 120) continue;
    const m = WEEKDAY.exec(lines[i]);
    const d = m && dateLine(m[1]);
    if (d) return d;
  }
  return null;
}

/** 網址檔名裡的 8 位數日期（`…/monetary20250917a.htm`、`…/powell20250822a.htm`）→ YYYY-MM-DD；只在來源寫了 extract.urlDate 時用。 */
export function urlDate(url: URL): string | null {
  const m = /(\d{4})(\d{2})(\d{2})[a-z]?\.html?$/i.exec(url.pathname);
  return m ? dateLine(`${m[1]}-${m[2]}-${m[3]}`) : null;
}

/**
 * `<pre>` 裡固定寬度斷行的內文 → 段落（勞工統計局的新聞稿整篇放在 `<pre>`，每行不到 100 字，照一般的規則一段內文都沒有）。
 * 空行分段；一段裡每一行都像句子（去掉開頭縮排之後，中間沒有連續 3 個以上的空白、沒有直線）才接成一行，表格與對齊的清單照原樣一行一行留著。
 */
export function reflowPre(html: string): string {
  return html.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, inner: string) => {
    const blocks: string[][] = [[]];
    for (const raw of inner.replace(/\r/g, '').split('\n')) {
      const line = raw.replace(/\t/g, '    ').trimEnd();
      if (!line.trim()) blocks.push([]);
      else blocks.at(-1)!.push(line);
    }
    return blocks
      .filter((b) => b.length)
      .map((b) => {
        const prose = b.every((l) => !/\S {3,}\S/.test(l.trimStart()) && !l.includes('|'));
        return `<p>${prose ? b.map((l) => l.trim()).join(' ') : b.map((l) => l.trim()).join('<br>')}</p>`;
      })
      .join('\n');
  });
}

export interface PageExtract {
  /** 轉成純文字的整頁。 */
  text: string;
  /** 內文：超過 200 字的段落。 */
  body: string;
  /** 這個來源的內文門檻。 */
  minBody: number;
  published: { date: string; from: string } | null;
}

/**
 * 一頁的內文與發布日（fetchWebDoc 與量測用的 /admin/web/test 共用）。一般的規則：meta、JSON-LD、<time>，再來是內文之前單獨一行的日期。
 * 來源寫了 extract 的（官方來源）多三個備案：`<pre>` 接回段落、發布時間那一行（from = release-line）、網址裡的日期（from = url）。
 */
export function extractPage(html: string, url: URL, ex?: WebExtract): PageExtract {
  const text = htmlToText(ex?.pre ? reflowPre(html) : html);
  const body = text
    .split('\n')
    .filter((p) => p.trim().length > WEB_DOC_PARA_MIN)
    .join('\n');
  const pick = (date: string | null, from: string) => (date ? { date, from } : null);
  const published = findPublished(html) ?? pick(findPublishedInText(text), 'text') ?? (ex?.releaseLine ? pick(findReleaseDate(text), 'release-line') : null) ?? (ex?.urlDate ? pick(urlDate(url), 'url') : null);
  return { text, body, minBody: ex?.minBody ?? WEB_DOC_MIN_BODY, published };
}

// ---------------------------------------------------------------- 內文

const clean = (s: string) => htmlToText(s).replace(/\s+/g, ' ').trim();

/** 網頁可能的標題：og:title、每個 <h1>、<title>，以及它們用「 | 」「 - 」切開的每一段（網站名稱常接在後面或前面）。 */
export function titleCandidates(html: string): { og: string; h1: string; title: string; all: string[] } {
  const og = clean(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i.exec(html)?.[1] ?? '');
  const h1s = [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)].map((m) => clean(m[1])).filter(Boolean);
  const title = clean(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '');
  const all = new Set<string>();
  for (const t of [og, ...h1s, title]) {
    if (!t) continue;
    all.add(t);
    for (const part of t.split(/\s+[|\-–—]\s+/)) if (part.trim()) all.add(part.trim());
  }
  return { og, h1: h1s[0] ?? '', title, all: [...all].filter((t) => t.length >= 8) };
}

/**
 * 快照的文字：從第一段內文之前、最靠近它的標題那一行開始（去掉前面的選單）；找不到就從頭。
 * 回傳文字與對到的標題（網頁上看得到的那一行，比 <title> 少了網站名稱）。
 */
export function articleText(text: string, candidates: readonly string[]): { text: string; title: string | null } {
  const lines = text.split('\n');
  const fb = lines.findIndex((l) => l.trim().length > WEB_DOC_PARA_MIN);
  const set = new Set(candidates);
  if (fb > 0 && set.size) {
    for (let i = fb - 1; i >= Math.max(0, fb - 40); i--) if (set.has(lines[i].trim())) return { text: lines.slice(i).join('\n'), title: lines[i].trim() };
  }
  return { text, title: null };
}

async function readCapped(res: Response, max: number): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    const take = value.subarray(0, Math.max(0, max - n));
    parts.push(take);
    n += take.length;
    if (n >= max) {
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// ---------------------------------------------------------------- 抓取

/**
 * 抓一個網址（設計 §1.4 的抓取規則）。不寫資料庫；寫的是 obtainWebDoc。
 * 不在清單（或不列入、路徑不收）的不去抓，回 NOT_LISTED；轉址到清單外的當成失敗（ERROR）。
 */
export async function fetchWebDoc(fetcher: Fetcher, raw: string, now: Date, opt: WebDocOptions = {}): Promise<WebDocFetched> {
  const u0 = safeWebUrl(raw);
  const url = u0 ? normalizeWebUrl(u0) : raw;
  const base: WebDocFetched = { url, id: await webDocId(url), status: 'ERROR', finalUrl: null, domain: null, tier: null, label: null, httpStatus: null, title: opt.title?.trim().slice(0, 300) || null, published: null, publishedFrom: null, dateConflict: false, chars: null, truncated: false, text: null, textSha256: null, error: null };
  if (!u0) return { ...base, error: '只收 https 的公開網址' };
  const hit = matchWebSource(new URL(url), opt.extraDomains);
  if ('miss' in hit) return { ...base, status: 'NOT_LISTED', error: hit.miss };
  let src: WebSourceMatch = hit;
  const listed = { ...base, domain: src.domain, tier: src.tier, label: src.label };
  if (opt.siteCount) {
    const n = opt.siteCount.get(src.domain) ?? 0;
    if (n >= WEB_DOC_PER_SITE) return { ...listed, status: 'LIMIT', error: `同一個網站一次執行最多抓 ${WEB_DOC_PER_SITE} 篇` };
    opt.siteCount.set(src.domain, n + 1);
  }
  try {
    let cur = new URL(url);
    let res: Response | null = null;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      res = await fetcher(cur.toString(), { headers: HEADERS, redirect: 'manual', signal: AbortSignal.timeout(WEB_DOC_TIMEOUT_MS) });
      if (res.status < 300 || res.status >= 400) break;
      const loc = res.headers.get('location');
      if (!loc) break;
      const next = safeWebUrl(new URL(loc, cur).toString());
      const m = next && matchWebSource(next, opt.extraDomains);
      if (!next || !m || 'miss' in m) return { ...listed, finalUrl: next?.toString() ?? loc, httpStatus: res.status, error: `轉址到清單外的網址（${next?.hostname ?? loc}）` };
      src = m;
      cur = next;
      res = null;
    }
    if (!res) return { ...listed, error: `轉址超過 ${MAX_REDIRECTS} 次` };
    const got = { ...listed, domain: src.domain, tier: src.tier, label: src.label, finalUrl: cur.toString(), httpStatus: res.status };
    if (res.status >= 400) return { ...got, status: 'BLOCKED', error: `HTTP ${res.status}` };
    if (res.status >= 300 || res.status < 200) return { ...got, error: `HTTP ${res.status}` };
    const buf = await readCapped(res, WEB_DOC_MAX_BYTES);
    const ctype = res.headers.get('content-type') ?? '';
    const head = new TextDecoder().decode(buf.subarray(0, 512));
    const isHtml = /text\/html|application\/xhtml\+xml/i.test(ctype) || (!ctype && /<html|<!doctype html/i.test(head));
    if (!isHtml || head.startsWith('%PDF')) return { ...got, status: 'UNSUPPORTED', error: `不是網頁（${ctype || '沒有 content-type'}）` };
    const html = new TextDecoder().decode(buf);
    // 內文與發布日：一般的規則；官方來源照清單上寫的擷取方式（T64：<pre> 接回段落、較低的內文門檻、發布時間那一行、網址裡的日期）
    const page = extractPage(html, cur, src.extract);
    const text = page.text;
    const tc = titleCandidates(html);
    const art = articleText(text, tc.all);
    const title = (art.title || tc.og || tc.h1 || tc.title).slice(0, 300) || got.title;
    const body = page.body;
    if (body.length < page.minBody) return { ...got, title, chars: text.length, status: 'THIN', error: `內文 ${body.length} 字（不到 ${page.minBody} 字）` };
    const pub = resolvePublished(page.published, opt.rssPublished);
    const dated = { ...got, title, chars: text.length, published: pub.published, publishedFrom: pub.from, dateConflict: pub.conflict };
    if (!pub.published) return { ...dated, status: 'NO_DATE', error: '認不出發布日' };
    const limit = opt.decisionDate ?? now.toISOString().slice(0, 10);
    if (pub.published > limit) return { ...dated, status: 'ERROR', error: `發布日 ${pub.published} 晚於決策日 ${limit}` };
    if (opt.notBefore && pub.published < opt.notBefore) return { ...dated, status: 'TOO_OLD', error: `發布日 ${pub.published} 早於 ${opt.notBefore}` };
    const article = art.text;
    const kept = article.slice(0, WEB_DOC_MAX_TEXT);
    return { ...dated, chars: article.length, status: 'OK', text: kept, truncated: article.length > WEB_DOC_MAX_TEXT, textSha256: await sha256Hex(kept) };
  } catch (e) {
    return { ...listed, error: e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300) };
  }
}

// ---------------------------------------------------------------- 快照（web_docs）

export interface WebDocRow {
  row_id: number;
  id: string;
  url: string;
  final_url: string | null;
  domain: string | null;
  tier: WebTier | null;
  ticker: string;
  file_id: string | null;
  via: WebDocVia;
  ref: string | null;
  premise_id: string | null;
  cond_id: string | null;
  title: string | null;
  published: string | null;
  published_from: string | null;
  date_conflict: number;
  fetched_at: string;
  session: string | null;
  status: WebDocStatus;
  error: string | null;
  http_status: number | null;
  chars: number | null;
  truncated: number;
  text_sha256: string | null;
  text: string | null;
  used_by: string | null;
}

export interface WebDocRequest {
  url: string;
  ticker: string;
  fileId?: string | null;
  via: WebDocVia;
  ref?: string | null;
  premiseId?: string | null;
  condId?: string | null;
  session?: string | null;
}

/** 這檔這個網址有全文的快照（不重抓用）。 */
export async function getWebDoc(db: D1Database, ticker: string, id: string): Promise<WebDocRow | null> {
  return db.prepare("SELECT * FROM web_docs WHERE ticker = ? AND id = ? AND status = 'OK' AND text IS NOT NULL").bind(ticker, id).first<WebDocRow>();
}

/**
 * 取一份網頁：這檔已經有同一個網址的 OK 快照 → 直接用（reused，不抓、不新增列）；
 * 否則照 fetchWebDoc 抓，結果（含被拒絕的）寫一列進 web_docs。`LIMIT` 沒有去抓，不寫。
 */
export async function obtainWebDoc(db: D1Database, fetcher: Fetcher, req: WebDocRequest, now: Date, opt: WebDocOptions = {}): Promise<{ row: WebDocRow | null; fetched: WebDocFetched | null; reused: boolean }> {
  const u = safeWebUrl(req.url);
  const id = await webDocId(u ? normalizeWebUrl(u) : req.url);
  const old = await getWebDoc(db, req.ticker, id);
  if (old) return { row: old, fetched: null, reused: true };
  const f = await fetchWebDoc(fetcher, req.url, now, opt);
  if (f.status === 'LIMIT') return { row: null, fetched: f, reused: false };
  const ok = f.status === 'OK';
  const row = await db
    .prepare(
      `INSERT INTO web_docs (id, url, final_url, domain, tier, ticker, file_id, via, ref, premise_id, cond_id, title, published, published_from, date_conflict, fetched_at, session, status, error, http_status, chars, truncated, text_sha256, text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING RETURNING *`,
    )
    .bind(f.id, f.url, f.finalUrl, f.domain, f.tier, req.ticker, req.fileId ?? null, req.via, req.ref ?? null, req.premiseId ?? null, req.condId ?? null, f.title, f.published, f.publishedFrom, f.dateConflict ? 1 : 0, now.toISOString(), req.session ?? null, f.status, f.error, f.httpStatus, f.chars, f.truncated ? 1 : 0, ok ? f.textSha256 : null, ok ? f.text : null)
    .first<WebDocRow>();
  // 同時有另一個請求先存了同一份 OK：用先存的那一份
  if (!row && ok) return { row: await getWebDoc(db, req.ticker, id), fetched: f, reused: true };
  return { row, fetched: f, reused: false };
}

/** 加進證據包時標記（T52 的取文件端點呼叫）；第一次用的執行留著。 */
export async function markWebDocUsed(db: D1Database, rowId: number, runId: string): Promise<void> {
  await db.prepare('UPDATE web_docs SET used_by = ? WHERE row_id = ? AND used_by IS NULL').bind(runId, rowId).run();
}

/** 沒被任何一次執行用過、抓了超過 180 天的 OK 快照：清掉全文，列留著。回清掉幾列。 */
export async function purgeUnusedWebText(db: D1Database, now: Date, days = WEB_DOC_KEEP_UNUSED_DAYS): Promise<number> {
  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
  const r = await db.prepare("UPDATE web_docs SET text = NULL WHERE status = 'OK' AND used_by IS NULL AND text IS NOT NULL AND fetched_at < ?").bind(cutoff).run();
  return r.meta.changes ?? 0;
}
