import { describe, expect, it } from 'vitest';
import { findPublished, probeWebPage, safeWebUrl } from '../src/data/webProbe';

const page = (body: string, head = '') => `<html><head><title>T</title>${head}</head><body>${body}</body></html>`;
const long = `<p>${'Samsung said HBM4 mass production will begin next quarter. '.repeat(40)}</p>`;
const fetcherOf = (html: string, status = 200, type = 'text/html') => async () => new Response(html, { status, headers: { 'content-type': type } });

describe('T50 網頁探測', () => {
  it('只收 https 的公開主機', () => {
    expect(safeWebUrl('https://www.trendforce.com/presscenter/news/x')).not.toBeNull();
    for (const bad of ['http://a.com/', 'https://localhost/', 'https://10.0.0.1/', 'https://x.workers.dev/', 'https://u:p@a.com/', 'https://a.com:8443/', 'nope']) expect(safeWebUrl(bad)).toBeNull();
  });

  it('發布日期：meta、JSON-LD、time', () => {
    expect(findPublished('<meta property="article:published_time" content="2026-11-18T09:00:00Z">')).toEqual({ date: '2026-11-18', from: 'meta' });
    expect(findPublished('<script type="application/ld+json">{"datePublished":"2026-11-17T01:02:03+09:00"}</script>')).toEqual({ date: '2026-11-17', from: 'json-ld' });
    expect(findPublished('<time datetime="2026-11-16">Nov 16</time>')).toEqual({ date: '2026-11-16', from: 'time' });
    expect(findPublished('<p>no date</p>')).toBeNull();
  });

  it('有全文的頁面 ok；只有殼、被擋、非 200 的不 ok', async () => {
    const good = await probeWebPage(fetcherOf(page(long, '<meta name="pubdate" content="2026-11-18">')), 'https://example.com/a');
    expect(good.ok).toBe(true);
    expect(good.published).toBe('2026-11-18');
    expect(good.bodyChars).toBeGreaterThan(1500);
    const shell = await probeWebPage(fetcherOf(page('<p>Please enable JavaScript to continue.</p>')), 'https://example.com/a');
    expect(shell.ok).toBe(false);
    expect(shell.blockedHint).toMatch(/enable javascript/i);
    expect((await probeWebPage(fetcherOf('x', 403), 'https://example.com/a')).error).toBe('HTTP 403');
    expect((await probeWebPage(fetcherOf('%PDF', 200, 'application/pdf'), 'https://example.com/a.pdf')).ok).toBe(false);
    expect((await probeWebPage(fetcherOf(''), 'http://example.com/')).error).toMatch(/https/);
  });
});
