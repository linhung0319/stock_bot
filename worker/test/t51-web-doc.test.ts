// T51：網域清單、抓取、快照（web_evidence_design §1.3、§1.4）。網頁全是假的（repo 是公開的）。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EXPORT_TABLES } from '../src/app/export';
import { WEB_DOC_MAX_TEXT, dateLine, fetchWebDoc, findPublishedInText, obtainWebDoc, purgeUnusedWebText, markWebDocUsed, resolvePublished, webDocId, type WebDocRow } from '../src/data/webDoc';
import { WEB_EXCLUDED, WEB_SOURCES, webFetchRule } from '../src/data/webSources';
import { freshDb } from './helpers/d1';

const NOW = new Date('2026-11-20T23:40:00Z');
const PARA = (s: string) => `<p>${s.repeat(Math.ceil(260 / s.length))}</p>`;
const BODY = Array.from({ length: 8 }, (_, i) => PARA(`Paragraph ${i}: contract prices for DRAM rose in the fourth quarter according to the survey. `)).join('\n');
const page = (opt: { head?: string; h1?: string; dateLine?: string; body?: string; nav?: string } = {}) =>
  `<!doctype html><html><head><title>Site | ${opt.h1 ?? 'Headline'}</title>${opt.head ?? ''}</head><body>${opt.nav ?? '<ul><li>Home</li><li>News</li></ul>'}<h1>${opt.h1 ?? 'Headline'}</h1>${opt.dateLine ? `<div>${opt.dateLine}</div>` : ''}${opt.body ?? BODY}</body></html>`;
const META = (d: string) => `<meta property="article:published_time" content="${d}">`;

type Route = Response | (() => Response);
function fakeFetcher(routes: Record<string, Route>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = routes[url];
    if (!r) throw new Error(`沒有預期會抓 ${url}`);
    return typeof r === 'function' ? r() : r.clone();
  };
  return { fetcher, calls };
}
const html = (s: string, status = 200, type = 'text/html; charset=utf-8') => new Response(s, { status, headers: { 'content-type': type } });
const TF = 'https://www.trendforce.com/presscenter/news/20261119-1.html';

// T68（confirm_audit_design §1.3）改了這一段：清單變成種子，不在種子的網域也抓（只擋排除列表）；路徑限制改成 onlyPaths／skipPaths。
// 種子與級別查詢的完整測試在 t68-web-ratings.test.ts。
describe('T51 網域清單（§1.3；T68 起是種子）', () => {
  it('比對主機名稱的結尾；子網域對到種子、相似的網域不是種子（T68：不是種子也照抓，網域照主機名稱）', () => {
    expect(webFetchRule(new URL('https://www.trendforce.com/news/2026/11/20/x/'))).toEqual({ domain: 'trendforce.com', label: 'TrendForce', seed: true });
    expect(webFetchRule(new URL('https://faketrendforce.com/news/x'))).toEqual({ domain: 'faketrendforce.com', label: 'faketrendforce.com', seed: false });
    expect(webFetchRule(new URL('https://trendforce.com.evil.example/news/x'))).toEqual({ domain: 'trendforce.com.evil.example', label: 'trendforce.com.evil.example', seed: false });
  });

  it('種子的路徑限制：TrendForce 的付費報告頁不收（T68：skipPaths）；DRAMeXchange 的路徑限制拿掉了', () => {
    expect(webFetchRule(new URL('https://www.trendforce.com/research/download/RP123'))).toEqual({ miss: 'PATH' });
    expect(webFetchRule(new URL('https://www.dramexchange.com/WeeklyResearch/Post/2/1.html'))).toMatchObject({ domain: 'dramexchange.com', seed: true });
    expect(webFetchRule(new URL('https://www.dramexchange.com/Price/Dram_Spot'))).toMatchObject({ domain: 'dramexchange.com', seed: true });
  });

  it('排除列表的網域不收（T68：每檔的 domains 不再讀）', () => {
    expect(webFetchRule(new URL('https://news.example-memory.com/en/q3-results/'))).toEqual({ domain: 'news.example-memory.com', label: 'news.example-memory.com', seed: false });
    expect(webFetchRule(new URL('https://www.fool.com/investing/2026/11/20/x/'))).toEqual({ miss: 'EXCLUDED' });
  });

  it('清單本身：網域小寫、級別合法、沒有和不列入的重疊、每個都有說明', () => {
    for (const s of WEB_SOURCES) {
      expect(s.domain).toBe(s.domain.toLowerCase());
      expect(['PRIMARY', 'NAMED', 'MEDIA']).toContain(s.tier);
      expect(s.note.length).toBeGreaterThan(5);
      expect(WEB_EXCLUDED.some((d) => s.domain === d || s.domain.endsWith(`.${d}`))).toBe(false);
    }
    // 2026-11-20 實測（§0.5）被擋或內文太短的不在起始清單
    for (const gone of ['datacenterdynamics.com', 'businesskorea.co.kr', 'reuters.com', 'bloomberg.com']) expect(WEB_SOURCES.some((s) => s.domain === gone)).toBe(false);
  });
});

describe('T51 發布日（§1.4）', () => {
  it('網頁沒有 meta 時：內文前面單獨一行的日期（新聞稿標題下面、Published 那一行）', () => {
    expect(dateLine('November 17, 2026')).toBe('2026-11-17');
    expect(dateLine('Nov.19 2026,15:41 PM (GMT+8)')).toBe('2026-11-19');
    expect(dateLine('Published: 19 November 2026')).toBe('2026-11-19');
    expect(dateLine('2026.11.19')).toBe('2026-11-19');
    expect(dateLine('Nov 19, 2026 Samsung announces new memory')).toBeNull();
    expect(dateLine('February 30, 2026')).toBeNull();
    const text = ['Menu', 'News', 'Headline', '', 'Published', 'Nov.19 2026,15:41 PM (GMT+8)', '', 'x'.repeat(250), 'Related', 'October 1, 2026'].join('\n');
    expect(findPublishedInText(text)).toBe('2026-11-19');
  });

  it('內文之後的日期（旁邊的其他文章）、Updated 那一行、離內文太遠的都不算', () => {
    expect(findPublishedInText(['Headline', 'x'.repeat(250), 'October 1, 2026'].join('\n'))).toBeNull();
    expect(findPublishedInText(['Headline', 'Updated', 'November 18, 2026', 'x'.repeat(250)].join('\n'))).toBeNull();
    expect(findPublishedInText(['October 1, 2026', ...Array.from({ length: 20 }, (_, i) => `nav ${i}`), 'x'.repeat(250)].join('\n'))).toBeNull();
  });

  it('網頁與 RSS 的發布日：差超過 3 天用比較晚的並標不一致；只有 RSS 的用 RSS', () => {
    expect(resolvePublished({ date: '2026-11-18', from: 'meta' }, '2026-11-19T02:00:00Z')).toEqual({ published: '2026-11-18', from: 'meta', conflict: false });
    expect(resolvePublished({ date: '2023-02-01', from: 'time' }, '2026-11-19')).toEqual({ published: '2026-11-19', from: 'rss', conflict: true });
    expect(resolvePublished({ date: '2026-11-19', from: 'json-ld' }, '2026-11-01')).toEqual({ published: '2026-11-19', from: 'json-ld', conflict: true });
    expect(resolvePublished(null, '2026-11-19T02:00:00Z')).toEqual({ published: '2026-11-19', from: 'rss', conflict: false });
    expect(resolvePublished(null, null)).toEqual({ published: null, from: null, conflict: false });
  });
});

describe('T51 抓取（§1.4）', () => {
  it('排除列表、路徑不收的網址不抓，回 NOT_LISTED（T68：不在種子的網址照抓，在 t68 測）', async () => {
    const { fetcher, calls } = fakeFetcher({});
    for (const u of ['https://www.fool.com/x', 'https://www.trendforce.com/research/download/1'])
      expect(await fetchWebDoc(fetcher, u, NOW, { title: '搜尋結果的標題' })).toMatchObject({ status: 'NOT_LISTED', text: null, title: '搜尋結果的標題' });
    expect(calls).toEqual([]);
    expect((await fetchWebDoc(fetcher, 'http://www.trendforce.com/news/x', NOW)).status).toBe('ERROR');
  });

  it('清單內、有全文與發布日 → OK；快照從標題開始（去掉選單）、id 是網址雜湊', async () => {
    const { fetcher, calls } = fakeFetcher({ [TF]: html(page({ head: META('2026-11-19T08:00:00+08:00'), h1: 'DRAM Prices Rise' })) });
    const r = await fetchWebDoc(fetcher, `${TF}?utm_source=x#top`, NOW);
    expect(r).toMatchObject({ status: 'OK', url: TF, domain: 'trendforce.com', tier: 'NAMED', published: '2026-11-19', publishedFrom: 'meta', title: 'DRAM Prices Rise', truncated: false, httpStatus: 200 });
    expect(r.id).toBe(await webDocId(TF));
    expect(r.id).toMatch(/^web:[0-9a-f]{16}$/);
    expect(r.text?.startsWith('DRAM Prices Rise')).toBe(true);
    expect(r.text).not.toContain('Home');
    expect(r.textSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(calls[0].url).toBe(TF);
    expect(calls[0].init?.redirect).toBe('manual');
  });

  it('<h1> 是欄目名稱時：標題用文章那一行（og:title 去掉網站名稱），快照從那一行開始', async () => {
    const h = page({ head: `${META('2026-11-19')}<meta property="og:title" content="NAND Prices Set to Decline | TrendForce">`, h1: 'Press Center', dateLine: '<h2>NAND Prices Set to Decline</h2>' });
    const { fetcher } = fakeFetcher({ [TF]: html(h) });
    const r = await fetchWebDoc(fetcher, TF, NOW);
    expect(r.title).toBe('NAND Prices Set to Decline');
    expect(r.text?.startsWith('NAND Prices Set to Decline')).toBe(true);
    expect(r.text).not.toContain('Press Center');
  });

  it('沒有 meta 的新聞稿：標題下面那一行的日期認得出來（published_from = text）', async () => {
    const u = 'https://nvidianews.nvidia.com/news/q3-results';
    const { fetcher } = fakeFetcher({ [u]: html(page({ dateLine: 'November 17, 2026' })) });
    expect(await fetchWebDoc(fetcher, u, NOW)).toMatchObject({ status: 'OK', published: '2026-11-17', publishedFrom: 'text' });
  });

  it('轉址：照抓；轉到排除列表當失敗（不去抓那一頁）', async () => {
    const inside = 'https://www.trendforce.com/news/2026/11/19/x/';
    const ok = fakeFetcher({
      [TF]: new Response(null, { status: 301, headers: { location: '/news/2026/11/19/x/' } }),
      [inside]: html(page({ head: META('2026-11-19') })),
    });
    expect(await fetchWebDoc(ok.fetcher, TF, NOW)).toMatchObject({ status: 'OK', finalUrl: inside });
    // T68：轉址的每一站只要不在排除列表（confirm_audit_design §1.3）
    const out = fakeFetcher({ [TF]: new Response(null, { status: 302, headers: { location: 'https://www.fool.com/?next=1' } }) });
    const r = await fetchWebDoc(out.fetcher, TF, NOW);
    expect(r).toMatchObject({ status: 'ERROR', text: null, httpStatus: 302 });
    expect(r.error).toMatch(/轉址到排除列表裡的網址.*www\.fool\.com/);
    expect(out.calls.map((c) => c.url)).toEqual([TF]);
    // 轉到同一個網域的付費頁（路徑不收）也當失敗
    const paid = fakeFetcher({ [TF]: new Response(null, { status: 301, headers: { location: '/research/download/1' } }) });
    expect((await fetchWebDoc(paid.fetcher, TF, NOW)).status).toBe('ERROR');
  });

  it('內文太短（付費牆、同意頁、要 JavaScript）→ THIN，不存全文', async () => {
    const { fetcher } = fakeFetcher({ [TF]: html(page({ head: META('2026-11-19'), body: '<p>Please enable JavaScript to continue.</p>' })) });
    expect(await fetchWebDoc(fetcher, TF, NOW)).toMatchObject({ status: 'THIN', text: null, published: null });
  });

  it('不是 HTML（PDF 等）→ UNSUPPORTED', async () => {
    const pdf = 'https://www.trendforce.com/presscenter/news/report.pdf';
    const { fetcher } = fakeFetcher({ [pdf]: html('%PDF-1.7 ...', 200, 'application/pdf'), [TF]: html('%PDF-1.7', 200, '') });
    expect(await fetchWebDoc(fetcher, pdf, NOW)).toMatchObject({ status: 'UNSUPPORTED', text: null });
    expect((await fetchWebDoc(fetcher, TF, NOW)).status).toBe('UNSUPPORTED');
  });

  it('認不出發布日 → NO_DATE，不存全文（不拿抓取日充當）', async () => {
    const { fetcher } = fakeFetcher({ [TF]: html(page()) });
    expect(await fetchWebDoc(fetcher, TF, NOW)).toMatchObject({ status: 'NO_DATE', text: null, published: null });
  });

  it('HTTP 4xx、5xx → BLOCKED；連線失敗 → ERROR', async () => {
    const { fetcher } = fakeFetcher({ [TF]: html('denied', 403) });
    expect(await fetchWebDoc(fetcher, TF, NOW)).toMatchObject({ status: 'BLOCKED', httpStatus: 403 });
    const boom = async () => {
      throw new Error('network down');
    };
    expect(await fetchWebDoc(boom, TF, NOW)).toMatchObject({ status: 'ERROR', error: 'network down' });
  });

  it('發布日晚於決策日 → ERROR；早於 notBefore → TOO_OLD', async () => {
    const { fetcher } = fakeFetcher({ [TF]: html(page({ head: META('2026-11-19') })) });
    expect((await fetchWebDoc(fetcher, TF, NOW, { decisionDate: '2026-11-18' })).status).toBe('ERROR');
    expect((await fetchWebDoc(fetcher, TF, NOW, { notBefore: '2026-11-20' })).status).toBe('TOO_OLD');
    expect((await fetchWebDoc(fetcher, TF, NOW, { decisionDate: '2026-11-19', notBefore: '2026-07-01' })).status).toBe('OK');
  });

  it('同一個網站一次執行最多抓 4 篇；第 5 篇不去抓（LIMIT）', async () => {
    const urls = Array.from({ length: 5 }, (_, i) => `https://www.trendforce.com/news/2026/11/19/n${i}/`);
    const { fetcher, calls } = fakeFetcher(Object.fromEntries(urls.map((u) => [u, () => html(page({ head: META('2026-11-19') }))])));
    const siteCount = new Map<string, number>();
    const st = [];
    for (const u of urls) st.push((await fetchWebDoc(fetcher, u, NOW, { siteCount })).status);
    expect(st).toEqual(['OK', 'OK', 'OK', 'OK', 'LIMIT']);
    expect(calls).toHaveLength(4);
  });

  it('快照最多存 30,000 字，截掉的標 truncated；chars 是截掉之前的字數', async () => {
    const big = Array.from({ length: 200 }, (_, i) => PARA(`Long paragraph ${i} about NAND pricing and supply. `)).join('\n');
    const { fetcher } = fakeFetcher({ [TF]: html(page({ head: META('2026-11-19'), body: big })) });
    const r = await fetchWebDoc(fetcher, TF, NOW);
    expect(r.status).toBe('OK');
    expect(r.truncated).toBe(true);
    expect(r.text).toHaveLength(WEB_DOC_MAX_TEXT);
    expect(r.chars).toBeGreaterThan(WEB_DOC_MAX_TEXT);
  });
});

describe('T51 快照 web_docs（§1.4）', () => {
  const req = { ticker: 'ZZZ', fileId: 'ZZZ@2026-10-01', via: 'SEARCH' as const, ref: 'run-1', premiseId: 'P5', session: '2026-11-20' };

  it('同一檔同一個網址不重抓：第二次直接用那一列；另一檔各抓一次、各存一列', async () => {
    const d = await freshDb();
    try {
      const { fetcher, calls } = fakeFetcher({ [TF]: () => html(page({ head: META('2026-11-19'), h1: 'DRAM Prices Rise' })) });
      const a = await obtainWebDoc(d.db, fetcher, { ...req, url: TF }, NOW);
      expect(a).toMatchObject({ reused: false, row: { status: 'OK', ticker: 'ZZZ', via: 'SEARCH', ref: 'run-1', premise_id: 'P5', tier: 'NAMED', published: '2026-11-19', session: '2026-11-20' } });
      const b = await obtainWebDoc(d.db, fetcher, { ...req, url: `${TF}#again`, ref: 'run-2' }, new Date('2026-12-01T00:00:00Z'));
      expect(b.reused).toBe(true);
      expect(b.row?.row_id).toBe(a.row?.row_id);
      expect(b.row?.ref).toBe('run-1');
      expect(calls).toHaveLength(1);
      const c = await obtainWebDoc(d.db, fetcher, { ...req, ticker: 'YYY', url: TF }, NOW);
      expect(c.reused).toBe(false);
      expect(c.row?.id).toBe(a.row?.id);
      expect(calls).toHaveLength(2);
      expect((await d.db.prepare('SELECT COUNT(*) AS n FROM web_docs').first<{ n: number }>())?.n).toBe(2);
    } finally {
      await d.dispose();
    }
  });

  it('排除列表的網址只記一列 NOT_LISTED（網址與標題，沒有全文），而且沒有去抓', async () => {
    const d = await freshDb();
    try {
      const { fetcher, calls } = fakeFetcher({});
      const r = await obtainWebDoc(d.db, fetcher, { ...req, url: 'https://www.fool.com/story' }, NOW, { title: 'Peer expands capacity' });
      expect(calls).toEqual([]);
      expect(r.row).toMatchObject({ status: 'NOT_LISTED', url: 'https://www.fool.com/story', title: 'Peer expands capacity', text: null, domain: null, error: 'EXCLUDED' });
    } finally {
      await d.dispose();
    }
  });

  it('沒抓成的每次都記一列、下次會再試；LIMIT 不寫', async () => {
    const d = await freshDb();
    try {
      const { fetcher, calls } = fakeFetcher({ [TF]: () => html('denied', 403) });
      await obtainWebDoc(d.db, fetcher, { ...req, url: TF }, NOW);
      await obtainWebDoc(d.db, fetcher, { ...req, url: TF }, NOW);
      expect(calls).toHaveLength(2);
      const siteCount = new Map([['trendforce.com', 4]]);
      expect((await obtainWebDoc(d.db, fetcher, { ...req, url: TF }, NOW, { siteCount })).row).toBeNull();
      const rows = (await d.db.prepare('SELECT status FROM web_docs').all<{ status: string }>()).results.map((x) => x.status);
      expect(rows).toEqual(['BLOCKED', 'BLOCKED']);
    } finally {
      await d.dispose();
    }
  });

  it('保留：沒被用過、超過 180 天的清掉全文（列留著，之後可以重抓）；用過的永久留著', async () => {
    const d = await freshDb();
    try {
      const other = 'https://www.trendforce.com/news/2026/05/01/old/';
      const { fetcher, calls } = fakeFetcher({ [TF]: () => html(page({ head: META('2026-05-01') })), [other]: () => html(page({ head: META('2026-05-01') })) });
      const then = new Date('2026-05-01T12:00:00Z');
      const a = await obtainWebDoc(d.db, fetcher, { ...req, url: TF }, then);
      const b = await obtainWebDoc(d.db, fetcher, { ...req, url: other }, then);
      await markWebDocUsed(d.db, b.row!.row_id, 'run-used');
      expect(await purgeUnusedWebText(d.db, new Date('2026-10-01T00:00:00Z'))).toBe(0);
      expect(await purgeUnusedWebText(d.db, NOW)).toBe(1);
      const rows = (await d.db.prepare('SELECT row_id, text, used_by FROM web_docs ORDER BY row_id').all<Pick<WebDocRow, 'row_id' | 'text' | 'used_by'>>()).results;
      expect(rows[0]).toMatchObject({ row_id: a.row!.row_id, text: null, used_by: null });
      expect(rows[1].text).not.toBeNull();
      expect(rows[1].used_by).toBe('run-used');
      const again = await obtainWebDoc(d.db, fetcher, { ...req, url: TF }, NOW);
      expect(again.reused).toBe(false);
      expect(again.row?.text).not.toBeNull();
      expect(calls).toHaveLength(3);
    } finally {
      await d.dispose();
    }
  });
});

describe('T51 匯出與紀錄說明', () => {
  it('web_docs 照 rowid 增量匯出；每張匯出的表都寫在 records_guide.md', () => {
    expect(EXPORT_TABLES.web_docs).toMatchObject({ mode: 'append' });
    const guide = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'analysis', 'records_guide.md'), 'utf8');
    for (const t of Object.keys(EXPORT_TABLES)) expect(guide, t).toContain(`\`${t}\``);
  });
});
