// T50 的實測用：Worker 從 Cloudflare 抓不抓得到某個網頁的全文、認不認得出發布日期。
// 只量、不存資料、不進任何流程（設計 docs/design/web_evidence_design_2026-11-20.md；/admin/web/test）。
import { htmlToText, parseRss } from './edgar';
import type { Fetcher } from './sources';
import { findPublished, findPublishedInText, safeWebUrl } from './webDoc';

// safeWebUrl、findPublished 搬到 webDoc.ts（T51），這裡照舊匯出給既有的呼叫者。
export { findPublished, safeWebUrl };

export const WEB_PROBE_MAX_BYTES = 2_000_000;
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' };

export interface WebProbe {
  url: string;
  ok: boolean;
  status?: number;
  finalUrl?: string;
  contentType?: string;
  bytes?: number;
  title?: string;
  /** 轉成純文字之後的字數。 */
  textChars?: number;
  /** 最長的一段連續內文（> 200 字的段落合計），用來分辨「有全文」和「只有殼」。 */
  bodyChars?: number;
  published?: string | null;
  publishedFrom?: string | null;
  /** 看起來是擋機器人、同意頁、要登入或要 JavaScript 的頁面。 */
  blockedHint?: string | null;
  sample?: string;
  ms?: number;
  error?: string;
}

const BLOCK = /(enable javascript|javascript is (?:required|disabled)|are you a robot|captcha|access denied|unusual (?:traffic|activity)|verify you are (?:a )?human|just a moment|subscribe to (?:continue|read)|sign in to (?:continue|read)|before you continue|consent)/i;

export async function probeWebPage(fetcher: Fetcher, raw: string): Promise<WebProbe> {
  const u = safeWebUrl(raw);
  if (!u) return { url: raw, ok: false, error: '只收 https 的公開網址' };
  const t0 = Date.now();
  try {
    const res = await fetcher(u.toString(), { headers: HEADERS, redirect: 'follow', signal: AbortSignal.timeout(15_000) });
    const contentType = res.headers.get('content-type') ?? '';
    const buf = new Uint8Array(await res.arrayBuffer());
    const base = { url: raw, status: res.status, finalUrl: res.url || u.toString(), contentType, bytes: buf.length, ms: Date.now() - t0 };
    if (!res.ok) return { ...base, ok: false, error: `HTTP ${res.status}` };
    if (!/html|xml|text/i.test(contentType)) return { ...base, ok: false, error: `不是網頁（${contentType || '沒有 content-type'}）` };
    const html = new TextDecoder().decode(buf.slice(0, WEB_PROBE_MAX_BYTES));
    const text = htmlToText(html);
    const body = text.split('\n').filter((p) => p.trim().length > 200).join('\n');
    const inText = findPublishedInText(text);
    const pub = findPublished(html) ?? (inText ? { date: inText, from: 'text' } : null);
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
    const hint = body.length < 1500 ? (BLOCK.exec(text)?.[0] ?? '內文太短') : null;
    return { ...base, ok: !hint, title: title ? htmlToText(title).slice(0, 160) : undefined, textChars: text.length, bodyChars: body.length, published: pub?.date ?? null, publishedFrom: pub?.from ?? null, blockedHint: hint, sample: body.slice(0, 240) };
  } catch (e) {
    return { url: raw, ok: false, ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 抓一個 RSS，回前 n 則的標題與連結，並各探一次連結的全文。 */
export async function probeRss(fetcher: Fetcher, rssUrl: string, n = 3): Promise<{ rss: string; ok: boolean; items?: number; error?: string; probes?: (WebProbe & { headline: string; at: string })[] }> {
  try {
    const res = await fetcher(rssUrl, { headers: { ...HEADERS, Accept: 'application/rss+xml, application/xml' }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return { rss: rssUrl, ok: false, error: `HTTP ${res.status}` };
    const items = parseRss(await res.text());
    const probes = [];
    for (const it of items.slice(0, n)) probes.push({ headline: it.title, at: it.at, ...(await probeWebPage(fetcher, it.link)) });
    return { rss: rssUrl, ok: true, items: items.length, probes };
  } catch (e) {
    return { rss: rssUrl, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
