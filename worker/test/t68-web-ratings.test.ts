// T68：網頁來源的 AI 評級（docs/design/confirm_audit_design_2026-11-21.md 第 1 章）。
// 完成條件（每條一個測試）：
//   級別查詢的四層順序；種子不會被 AI 覆寫、排除的評不上去；清單外網域抓得到並標 UNRATED；onlyPaths／skipPaths；
//   兩個端點的每條檢查（含任務關閉後 410、市場摘要可用）；同一次執行裡先評級再送結果，判定用新級別；
//   LEAD 不能判前提不成立、MEDIA 一個網域不夠；web: 條件用未評級網域時那一票算證據不足、評成 NAMED 後可以；
//   domains 不再影響抓取；added_docs 有 rating。
// 對外請求全部是假的（網頁、EDGAR、RSS、雲端排程）；repo 是公開的。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseAdded, rateAdded, withAdded, type AddedDoc } from '../src/ai/added';
import { judge, type EvidencePack, type PackDoc } from '../src/ai/check';
import { PAYLOAD_HOOKS } from '../src/ai/hooks';
import { OWN_REVIEW, ownReviewPack, reviewDecision } from '../src/ai/ownReview';
import { buildPack } from '../src/ai/pack';
import { getRun, startRun, type AiRun } from '../src/app/aiRuns';
import { TASK_TIMEOUT_MS } from '../src/app/aiTasks';
import type { Env, Fetcher } from '../src/app/env';
import { EXPORT_TABLES } from '../src/app/export';
import { runFlow } from '../src/app/flow';
import { LINE_PUSH_URL } from '../src/app/line';
import { loadAccount, saveAccount } from '../src/app/ledgerStore';
import { webRatingsSection } from '../src/app/opsReport';
import { startOwnReview } from '../src/app/ownAi';
import { foundView } from '../src/app/site/aiViews';
import { loadRatings } from '../src/app/webRatings';
import type { CompanyFacts, XbrlFact } from '../src/data/edgar';
import { buildMarketView } from '../src/data/marketView';
import { loadSeries } from '../src/data/store';
import { fetchWebDoc, siteNameOf } from '../src/data/webDoc';
import { WEB_SOURCES, rateDomain, webFetchRule, type WebRatingRow } from '../src/data/webSources';
import { createAccount, type Account, type MarketView } from '../src/engine';
import { handle } from '../src/index';
import { freshDb } from './helpers/d1';
import { cronTime, fakeFetcher, newWorld, type World } from './helpers/fakeSources';

// ---------------------------------------------------------------- 假的網頁

const PARA = (s: string) => `<p>${s.repeat(Math.ceil(260 / s.length))}</p>`;
const body = (tag: string) => Array.from({ length: 8 }, (_, i) => PARA(`Paragraph ${i} of ${tag}: HBM contract quotes were cut for the first quarter according to three buyers. `)).join('\n');
const page = (o: { title: string; date: string; tag: string; site?: string }) =>
  `<!doctype html><html><head><title>${o.title} | ${o.site ?? 'Site'}</title><meta property="article:published_time" content="${o.date}T08:00:00Z">${o.site ? `<meta property="og:site_name" content="${o.site}">` : ''}</head><body><h1>${o.title}</h1>${body(o.tag)}</body></html>`;
const MW = 'https://www.memorywire.example/hbm-cuts';
const BLOG = 'https://blog.chipfarm.example/hbm';
const TF = 'https://www.trendforce.com/presscenter/news/20261118-memory.html';
const FOOL = 'https://www.fool.com/investing/2026/11/17/buy-nvda/';
const QUOTE_MW = 'Paragraph 0 of MW: HBM contract quotes were cut for the first quarter according to three buyers';
const PAGES: Record<string, () => string> = {
  [MW]: () => page({ title: 'HBM quotes cut', date: '2026-11-12', tag: 'MW', site: 'MemoryWire' }),
  [BLOG]: () => page({ title: 'HBM is doomed', date: '2026-11-13', tag: 'BLOG' }),
  [TF]: () => page({ title: 'DRAM contract prices fall', date: '2026-11-18', tag: 'TF', site: 'TrendForce' }),
};

// ---------------------------------------------------------------- 假的 EDGAR（NVDA 自己）

function quarterFacts(qs: { end: string; rev: number; filed: string }[]): CompanyFacts {
  const rev: XbrlFact[] = qs.map((q) => {
    const [y, m] = q.end.split('-').map(Number);
    return { start: `${y}-${String(m - 2).padStart(2, '0')}-01`, end: q.end, val: q.rev, accn: `acc-${q.filed}`, form: '10-Q', filed: q.filed };
  });
  return { cik: 1045810, facts: { 'us-gaap': { Revenues: { units: { USD: rev } } } } };
}
const BASE = quarterFacts([
  { end: '2025-09-30', rev: 120, filed: '2025-11-01' },
  { end: '2026-09-30', rev: 160, filed: '2026-10-30' },
]);
const Q_REV = 'Revenue for the third quarter was $160 million, up 33% from a year ago';
const TENQ = { accession: '0001045810-26-000300', form: '10-Q', items: '', acceptanceDateTime: '2026-10-30T20:10:00.000Z', filingDate: '2026-10-30', primaryDocument: 'q.htm', html: `<html><body><p>Item 2. Management’s Discussion and Analysis of Financial Condition and Results of Operations</p><p>${Q_REV}.</p><p>Item 3. Quantitative and Qualitative Disclosures About Market Risk</p></body></html>` };
const subs = () => Response.json({ cik: '1045810', name: 'NVIDIA CORP', tickers: [], filings: { recent: { accessionNumber: [TENQ.accession], form: [TENQ.form], items: [TENQ.items], acceptanceDateTime: [TENQ.acceptanceDateTime], filingDate: [TENQ.filingDate], primaryDocument: [TENQ.primaryDocument] } } });

function fetcherOf(w: World, calls: string[]): Fetcher {
  const base = fakeFetcher(w);
  return async (url, init) => {
    calls.push(url);
    if (url === LINE_PUSH_URL) return Response.json({});
    if (url === 'https://api.example/fire') return Response.json({ claude_code_session_url: 'https://claude.ai/code/x' });
    if (/data\.sec\.gov\/submissions\/CIK\d+\.json/.test(url)) return subs();
    if (/companyfacts\/CIK\d+\.json/.test(url)) return Response.json(BASE);
    const doc = /Archives\/edgar\/data\/\d+\/(\d+)\/(.+)$/.exec(url);
    if (doc) return doc[2] === 'index.json' ? Response.json({ directory: { item: [{ name: TENQ.primaryDocument }] } }) : new Response(TENQ.html);
    if (url.startsWith('https://www.nasdaq.com/feed/rssoutbound') || url.startsWith('https://feeds.finance.yahoo.com/rss/2.0/headline')) return new Response('<rss><channel></channel></rss>');
    const p = PAGES[url];
    if (p) return new Response(p(), { headers: { 'content-type': 'text/html; charset=utf-8' } });
    return base(url, init);
  };
}

interface Ctx {
  db: D1Database;
  env: Env;
  fetcher: Fetcher;
  calls: string[];
  acct: Account;
  view: MarketView;
  axis: string[];
  call: <T = Record<string, unknown>>(method: 'GET' | 'POST', path: string, body?: unknown, now?: Date, auth?: string | null) => Promise<{ status: number; body: T }>;
}

const T0 = new Date('2026-11-20T01:00:00Z');
const T1 = new Date('2026-11-20T01:10:00Z');
const PREMISES = [
  { id: 'P1', text: '資料中心需求延續到 2027', origin: 'USER' as const },
  { id: 'P2', text: 'HBM 供給持續吃緊', origin: 'USER' as const },
];

async function withWorld(fn: (c: Ctx) => Promise<void>, opt: { acct?: (a: Account) => Account } = {}) {
  const d = await freshDb();
  try {
    const db = d.db;
    const w = newWorld('2026-11-19');
    const calls: string[] = [];
    const env: Env = { DB: db, ADMIN_TOKEN: 't', AI_TASK_SECRET: 's', EDGAR_USER_AGENT: 'test bot test@example.com', SITE_URL: 'https://bot.example', LINE_CHANNEL_TOKEN: 'lt', LINE_USER_ID: 'U1', DEV_NO_AUTH: '1', ROUTINE_FIRE_URL: 'https://api.example/fire', ROUTINE_TOKEN: 'rt' };
    const fetcher = fetcherOf(w, calls);
    await runFlow(env, fetcher, { now: cronTime('2026-11-19'), attempt: 'FIRST' });
    const view = buildMarketView(await loadSeries(db, ['VOO', 'SGOV', 'NVDA']), '2026-11-19', 'VOO');
    let acct = createAccount({ paper: true, cash: 5000, core: { VOO: Math.floor(140_000 / view.view.close.VOO[view.view.i]) }, own: { NVDA: { shares: Math.floor(40_000 / view.view.close.NVDA[view.view.i]), stdWeight: 0.15, premises: PREMISES } } }, view.view);
    if (opt.acct) acct = opt.acct(acct);
    await saveAccount(db, acct, null, '建立帳戶', new Date('2026-11-19T12:00:00Z'));
    const call: Ctx['call'] = async (method, path, b, now = T1, auth = 's') => {
      const r = await handle(new Request(`https://bot.example${path}`, { method, headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) }, ...(b === undefined ? {} : { body: typeof b === 'string' ? b : JSON.stringify(b) }) }), env, fetcher, now);
      return { status: r.status, body: (await r.json()) as never };
    };
    await fn({ db, env, fetcher, calls, acct: (await loadAccount(db))!.acct, view: view.view, axis: view.axis, call });
  } finally {
    await d.dispose();
  }
}

const review = (c: Ctx) => startOwnReview(c.env, c.fetcher, c.acct, c.view, c.axis, 'NVDA', 'MANUAL', T0);
const evidence = (c: Ctx, r: AiRun) => c.call('GET', `/ai/task/${r.taskId}/evidence`);
interface DocsBody {
  docs: { id: string; source_id: string; kind: string; tier: string | null; domain: string | null; rating: string | null; date: string; title: string }[];
  refused: { url?: string; reason: string; detail: string | null }[];
}
const docs = (c: Ctx, r: AiRun, want: unknown[], now?: Date) => c.call<DocsBody>('POST', `/ai/task/${r.taskId}/docs`, { role: '分析師', want }, now);
const unrated = (c: Ctx, r: AiRun, now?: Date) => c.call<{ unrated: { domain: string; site_name: string | null }[] }>('GET', `/ai/task/${r.taskId}/unrated`, undefined, now);
interface RatingsBody {
  saved: { domain: string; tier: string }[];
  refused: { domain: string | null; reason: string; detail: string }[];
}
const rate = (c: Ctx, r: AiRun, ratings: unknown[], now?: Date) => c.call<RatingsBody>('POST', `/ai/task/${r.taskId}/ratings`, { role: '來源評級', ratings }, now);

/** 三票：減半、P1 成立（引用 10-Q）、P2 不成立（引用 cite 那一份網頁）。 */
function brokenVotes(run: AiRun, cite: { source_id: string; date: string }, quote: string) {
  const filing = run.pack.documents.find((d) => d.kind === 'filing')!;
  const v = {
    run_id: run.runId,
    verdict: 'HALF',
    model: 'claude-opus-5-5',
    premise_checks: [
      { premise_id: 'P1', status: 'HOLDS', evidence_ids: ['E1'], confirm_ids: ['E1'] },
      { premise_id: 'P2', status: 'BROKEN', evidence_ids: ['E2'] },
    ],
    evidence: [
      { id: 'E1', source_id: filing.source_id, date: filing.date, quote: Q_REV, claim: '營收年增' },
      { id: 'E2', source_id: cite.source_id, date: cite.date, quote, claim: '合約價下修' },
    ],
    payload: { tier: 'HALF', condition_checks: [], proposed_conditions: [] },
    report: '減半。',
  };
  return [v, v, v];
}
const submit = (c: Ctx, r: AiRun, samples: unknown[], now?: Date) => c.call('POST', `/ai/task/${r.taskId}/result`, { task_id: r.taskId, kind: 'RUN', run_id: r.runId, samples }, now);

const row = (domain: string, tier: WebRatingRow['tier'], o: Partial<WebRatingRow> = {}): WebRatingRow => ({ domain, tier, site_name: null, reason: '測試', run_id: 'run-x', rated_at: '2026-11-20T00:00:00.000Z', ...o });

// ---------------------------------------------------------------- 級別查詢

describe('T68 級別查詢（§1.1、§1.2、§1.5）', () => {
  it('四層順序：排除列表 → 種子 → 評級表 → UNRATED；種子與排除比對子網域，評級表只認同一個網域', async () => {
    // 評級表裡就算有排除列表與種子的網域（不該發生），也照排除、種子
    const t = new Map([row('fool.com', 'NAMED'), row('trendforce.com', 'LEAD'), row('memorywire.example', 'MEDIA', { site_name: 'MemoryWire', reason: '有編輯的產業媒體', run_id: 'run-1' }), row('farm.example', 'EXCLUDE')].map((r) => [r.domain, r]));
    expect(rateDomain('www.fool.com', t)).toMatchObject({ rating: 'EXCLUDED', by: 'EXCLUDED' });
    expect(rateDomain('www.trendforce.com', t)).toEqual({ domain: 'trendforce.com', rating: 'NAMED', by: 'SEED', label: 'TrendForce', reason: null, runId: null });
    expect(rateDomain('press.trendforce.com', t)).toMatchObject({ rating: 'NAMED', by: 'SEED' });
    expect(rateDomain('www.memorywire.example', t)).toEqual({ domain: 'memorywire.example', rating: 'MEDIA', by: 'AI', label: 'MemoryWire', reason: '有編輯的產業媒體', runId: 'run-1' });
    expect(rateDomain('news.memorywire.example', t)).toMatchObject({ domain: 'news.memorywire.example', rating: 'UNRATED', by: 'NONE' });
    expect(rateDomain('farm.example', t)).toMatchObject({ rating: 'EXCLUDED', by: 'AI' });
    expect(rateDomain('nobody.example', t)).toEqual({ domain: 'nobody.example', rating: 'UNRATED', by: 'NONE', label: 'nobody.example', reason: null, runId: null });
    // 評級表從 D1 讀（web_source_ratings）
    const d = await freshDb();
    try {
      await d.db.prepare("INSERT INTO web_source_ratings (domain, tier, site_name, reason, run_id, rated_at) VALUES ('memorywire.example', 'MEDIA', 'MemoryWire', '有編輯的產業媒體', 'run-1', '2026-11-20T00:00:00.000Z')").run();
      const db = await loadRatings(d.db);
      expect(rateDomain('memorywire.example', db)).toMatchObject({ rating: 'MEDIA', by: 'AI', label: 'MemoryWire' });
      // tier 只收五種（資料表的 CHECK）
      await expect(d.db.prepare("INSERT INTO web_source_ratings (domain, tier, rated_at) VALUES ('x.example', 'GREAT', 'now')").run()).rejects.toThrow();
    } finally {
      await d.dispose();
    }
  });
});

// ---------------------------------------------------------------- 抓取

describe('T68 抓取放寬（§1.3）', () => {
  const pageFetcher = (log: string[] = []): Fetcher => async (url) => {
    log.push(url);
    const p = PAGES[url];
    if (p) return new Response(p(), { headers: { 'content-type': 'text/html; charset=utf-8' } });
    if (url === 'https://hop.example/go') return new Response(null, { status: 302, headers: { location: MW } });
    if (url === 'https://hop.example/bad') return new Response(null, { status: 302, headers: { location: FOOL } });
    return new Response('nf', { status: 404 });
  };
  const NOW = new Date('2026-11-20T01:00:00Z');

  it('不在種子的網域抓得到並標 UNRATED；網站名稱取 og:site_name，沒有就用 <title>（最多 60 字）；AI 評成排除的不抓', async () => {
    const r = await fetchWebDoc(pageFetcher(), MW, NOW);
    expect(r).toMatchObject({ status: 'OK', domain: 'memorywire.example', tier: 'UNRATED', label: 'memorywire.example', siteName: 'MemoryWire', published: '2026-11-12' });
    // 評級表有它 → 抓的那一刻的級別
    expect((await fetchWebDoc(pageFetcher(), MW, NOW, { ratings: new Map([['memorywire.example', row('memorywire.example', 'MEDIA')]]) })).tier).toBe('MEDIA');
    const log: string[] = [];
    expect(await fetchWebDoc(pageFetcher(log), MW, NOW, { ratings: new Map([['memorywire.example', row('memorywire.example', 'EXCLUDE')]]) })).toMatchObject({ status: 'NOT_LISTED', error: 'EXCLUDED' });
    expect(log).toEqual([]);
    expect(siteNameOf('<html><head><title>HBM is doomed | Chip Farm</title></head></html>')).toBe('HBM is doomed | Chip Farm');
    expect(siteNameOf(`<meta content="${'N'.repeat(80)}" property="og:site_name">`)).toBe('N'.repeat(60));
    expect(siteNameOf('<html></html>')).toBeNull();
    // 轉址：不在種子的網站之間照跟；每一站不能在排除列表
    expect(await fetchWebDoc(pageFetcher(), 'https://hop.example/go', NOW)).toMatchObject({ status: 'OK', domain: 'memorywire.example', finalUrl: MW });
    const bad = await fetchWebDoc(pageFetcher(), 'https://hop.example/bad', NOW);
    expect(bad).toMatchObject({ status: 'ERROR' });
    expect(bad.error).toContain('排除列表');
  });

  it('onlyPaths／skipPaths：聯準會、勞工統計局只收有理由的路徑；TrendForce 不收 /research/；三個拿掉限制的整個網域都收；NOT_LISTED 只剩 EXCLUDED、PATH', async () => {
    const miss = (u: string) => {
      const r = webFetchRule(new URL(u));
      return 'miss' in r ? r.miss : r.domain;
    };
    expect(miss('https://www.federalreserve.gov/newsevents/pressreleases/monetary20261029a.htm')).toBe('federalreserve.gov');
    expect(miss('https://www.federalreserve.gov/monetarypolicy/fomcminutes20261029.htm')).toBe('PATH');
    expect(miss('https://www.bls.gov/news.release/empsit.nr0.htm')).toBe('bls.gov');
    expect(miss('https://www.bls.gov/cpi/')).toBe('PATH');
    expect(miss('https://www.trendforce.com/research/download/RP1')).toBe('PATH');
    expect(miss('https://www.trendforce.com/price/dram/dram_spot')).toBe('trendforce.com');
    expect(miss('https://www.dramexchange.com/Price/Dram_Spot')).toBe('dramexchange.com');
    expect(miss('https://nvidianews.nvidia.com/online-press-kit/x')).toBe('nvidianews.nvidia.com');
    expect(miss('https://finance.yahoo.com/markets/stocks/articles/x.html')).toBe('finance.yahoo.com');
    expect(miss('https://www.fool.com/x')).toBe('EXCLUDED');
    // 種子上：路徑限制只留在有理由的三個，舊的 paths 欄位拿掉了
    expect(WEB_SOURCES.filter((s) => s.onlyPaths).map((s) => s.domain)).toEqual(['federalreserve.gov', 'bls.gov']);
    expect(WEB_SOURCES.filter((s) => s.skipPaths).map((s) => [s.domain, s.skipPaths])).toEqual([['trendforce.com', ['/research/']]]);
    expect(WEB_SOURCES.some((s) => 'paths' in s)).toBe(false);
    // NOT_LISTED 的原因只有兩種
    const errs = new Set<string | null>();
    for (const u of ['https://www.fool.com/x', 'https://www.bls.gov/cpi/', 'https://www.trendforce.com/research/x', MW, 'https://unknown.example/x']) {
      const r = await fetchWebDoc(pageFetcher(), u, NOW);
      if (r.status === 'NOT_LISTED') errs.add(r.error);
    }
    expect([...errs].sort()).toEqual(['EXCLUDED', 'PATH']);
  });
});

// ---------------------------------------------------------------- 兩個端點

describe('T68 /unrated 與 /ratings（§1.4）', () => {
  it('取文件回每份的網域與級別；/unrated 只給這次取回、現在還沒評級的網域與網站名稱（種子不列、不給內文）；給過的記下來', async () => {
    await withWorld(async (c) => {
      const r = await review(c);
      await evidence(c, r);
      const got = await docs(c, r, [{ url: MW, for: 'P2', why: '合約價' }, { url: TF, for: 'P2', why: '合約價' }, { url: BLOG, for: 'P2', why: '部落格' }]);
      expect(got.body.docs.map((d) => [d.domain, d.rating, d.tier])).toEqual([
        ['memorywire.example', 'UNRATED', 'UNRATED'],
        ['trendforce.com', 'NAMED', 'NAMED'],
        ['blog.chipfarm.example', 'UNRATED', 'UNRATED'],
      ]);
      expect(got.body.docs[0].title).toBe('〔網頁｜還沒評級｜memorywire.example〕HBM quotes cut（發布 2026-11-12，2026-11-20 抓）');
      const u = await unrated(c, r);
      expect(u.status).toBe(200);
      expect(u.body).toEqual({ unrated: [{ domain: 'memorywire.example', site_name: 'MemoryWire' }, { domain: 'blog.chipfarm.example', site_name: 'HBM is doomed | Site' }] });
      expect(JSON.stringify(u.body)).not.toMatch(/Paragraph|合約價|部落格/);
      expect(parseAdded((await c.db.prepare('SELECT added_docs FROM ai_runs WHERE run_id = ?').bind(r.runId).first<{ added_docs: string }>())!.added_docs).unrated).toEqual(['memorywire.example', 'blog.chipfarm.example']);
      // web_docs 存了網站名稱與抓的那一刻的級別
      expect(await c.db.prepare('SELECT domain, tier, site_name FROM web_docs WHERE url = ?').bind(MW).first()).toEqual({ domain: 'memorywire.example', tier: 'UNRATED', site_name: 'MemoryWire' });
    });
  });

  it('/ratings 的每條檢查：只收 /unrated 給過的、種子與排除的不收、tier 列舉、reason 一句 100 字以內、一次最多 12 個、評過的不覆寫；種子不會被覆寫、排除的評不上去', async () => {
    await withWorld(async (c) => {
      const r = await review(c);
      await evidence(c, r);
      await docs(c, r, [{ url: MW }, { url: BLOG }]);
      await unrated(c, r);
      const res = await rate(c, r, [
        { domain: 'trendforce.com', tier: 'LEAD', reason: '想改種子' },
        { domain: 'www.fool.com', tier: 'NAMED', reason: '想把排除的評上去' },
        { domain: 'other.example', tier: 'MEDIA', reason: '沒給過' },
        { domain: 'memorywire.example', tier: 'GREAT', reason: '不在列舉' },
        { domain: 'memorywire.example', tier: 'MEDIA', reason: '長'.repeat(101) },
        { domain: 'memorywire.example', tier: 'MEDIA', reason: '  ' },
        { domain: 'https://www.MemoryWire.example/x', tier: 'media', reason: '有編輯、會寫消息來源的記憶體產業媒體' },
        { domain: 'memorywire.example', tier: 'NAMED', reason: '再評一次' },
        { domain: 'blog.chipfarm.example', tier: 'LEAD', reason: '看不出作者的部落格' },
      ]);
      expect(res.status).toBe(200);
      expect(res.body.saved).toEqual([
        { domain: 'memorywire.example', tier: 'MEDIA' },
        { domain: 'blog.chipfarm.example', tier: 'LEAD' },
      ]);
      expect(res.body.refused.map((x) => [x.domain, x.reason])).toEqual([
        ['trendforce.com', 'SEED'],
        ['fool.com', 'EXCLUDED'],
        ['other.example', 'NOT_GIVEN'],
        ['memorywire.example', 'BAD_TIER'],
        ['memorywire.example', 'BAD_REASON'],
        ['memorywire.example', 'BAD_REASON'],
        ['memorywire.example', 'ALREADY_RATED'],
      ]);
      // 寫進評級表：網站名稱是 Worker 取的、理由、哪一次執行
      expect(await c.db.prepare("SELECT domain, tier, site_name, reason, run_id FROM web_source_ratings WHERE domain = 'memorywire.example'").first()).toEqual({ domain: 'memorywire.example', tier: 'MEDIA', site_name: 'MemoryWire', reason: '有編輯、會寫消息來源的記憶體產業媒體', run_id: r.runId });
      const t = await loadRatings(c.db);
      expect(t.size).toBe(2);
      expect(rateDomain('trendforce.com', t)).toMatchObject({ rating: 'NAMED', by: 'SEED' });
      expect(rateDomain('fool.com', t)).toMatchObject({ rating: 'EXCLUDED', by: 'EXCLUDED' });
      // 評過的之後不再出現在 /unrated
      expect((await unrated(c, r)).body.unrated).toEqual([]);
      // 一次最多 12 個：第 13 個起 LIMIT
      const many = await rate(c, r, Array.from({ length: 13 }, (_, k) => ({ domain: `n${k}.example`, tier: 'LEAD', reason: 'x' })));
      expect(many.body.refused.filter((x) => x.reason === 'LIMIT').map((x) => x.domain)).toEqual(['n12.example']);
      expect(many.body.refused.filter((x) => x.reason === 'NOT_GIVEN')).toHaveLength(12);
      // 格式不對
      expect((await c.call('POST', `/ai/task/${r.taskId}/ratings`, { ratings: 'x' })).status).toBe(400);
      expect((await c.call('POST', `/ai/task/${r.taskId}/ratings`, '不是 JSON')).status).toBe(400);
    });
  });

  it('只在任務開著、取過證據包、還沒送回時可用；金鑰與哪些任務可以用和取文件相同（任務關閉後 410）；市場摘要也可以用', async () => {
    await withWorld(async (c) => {
      // 沒帶金鑰 401、沒有這個任務 404
      const r = await review(c);
      expect((await c.call('GET', `/ai/task/${r.taskId}/unrated`, undefined, T1, null)).status).toBe(401);
      expect((await c.call('POST', `/ai/task/${r.taskId}/ratings`, { ratings: [] }, T1, null)).status).toBe(401);
      expect((await c.call('GET', `/ai/task/${'0'.repeat(32)}/unrated`)).status).toBe(404);
      expect((await c.call('POST', `/ai/task/${'0'.repeat(32)}/ratings`, { ratings: [] })).status).toBe(404);
      // 還沒取證據包 409
      expect((await unrated(c, r)).status).toBe(409);
      expect((await rate(c, r, [])).status).toBe(409);
      await evidence(c, r);
      await docs(c, r, [{ url: MW }]);
      expect((await unrated(c, r)).status).toBe(200);
      // 逾時 → 410
      const late = new Date(Date.parse(r.createdAt) + TASK_TIMEOUT_MS + 60_000);
      expect((await unrated(c, r, late)).status).toBe(410);
      expect((await rate(c, r, [{ domain: 'memorywire.example', tier: 'MEDIA', reason: 'x' }], late)).status).toBe(410);
      // 送回結果之後 → 410
      const run = (await getRun(c.db, r.runId))!;
      expect((await submit(c, r, brokenVotes(run, run.pack.documents.find((d) => d.kind === 'web')!, QUOTE_MW))).status).toBe(200);
      expect((await unrated(c, r)).status).toBe(410);
      expect((await rate(c, r, [{ domain: 'memorywire.example', tier: 'MEDIA', reason: 'x' }])).status).toBe(410);
      expect((await loadRatings(c.db)).size).toBe(0);

      // 別的功能的任務 → 403
      const { pack: chk } = buildPack({ runId: 'R-check', fn: 'OWN_CHECK', promptVersion: 'own_check_v5', asOf: '2026-11-19', subject: { ticker: 'NVDA' }, question: 'q', policy: { level: 'A2', verdicts: ['DONE', 'INSUFFICIENT'], abstain: 'INSUFFICIENT', min_evidence: 0, samples: 1 }, rule: { action: 'x' }, now: T0 });
      const other = await startRun(c.env, c.fetcher, chk, T0);
      await evidence(c, other);
      expect((await unrated(c, other)).status).toBe(403);
      expect((await rate(c, other, [])).status).toBe(403);

      // 市場摘要（不屬於任何一檔）也可以用
      const { pack: mb } = buildPack({ runId: 'R-brief', fn: 'MARKET_BRIEF', promptVersion: 'market_brief_v1', asOf: '2026-11-19', subject: {}, question: 'q', policy: { level: 'A1', verdicts: ['DONE', 'INSUFFICIENT'], abstain: 'INSUFFICIENT', min_evidence: 0, samples: 1 }, rule: { action: '只說明' }, now: T0 });
      const brief = await startRun(c.env, c.fetcher, mb, T0, [], { menu: [], notBefore: '2026-10-01', domains: [], fileId: null });
      await evidence(c, brief);
      const bd = await c.call<DocsBody>('POST', `/ai/task/${brief.taskId}/docs`, { role: '研究員', want: [{ url: BLOG }] });
      expect(bd.body.docs.map((d) => [d.domain, d.rating])).toEqual([['blog.chipfarm.example', 'UNRATED']]);
      expect((await unrated(c, brief)).body).toEqual({ unrated: [{ domain: 'blog.chipfarm.example', site_name: 'HBM is doomed | Site' }] });
      expect((await rate(c, brief, [{ domain: 'blog.chipfarm.example', tier: 'LEAD', reason: '看不出作者的部落格' }])).body.saved).toEqual([{ domain: 'blog.chipfarm.example', tier: 'LEAD' }]);
    });
  });
});

// ---------------------------------------------------------------- 判定用當下的級別

describe('T68 判定用當下的級別（§1.2、§1.4）', () => {
  it('同一次執行裡先評級再送結果：判定用新級別；added_docs 每份記判的時候的 rating；之前的執行照它當時的級別', async () => {
    await withWorld(async (c) => {
      // ① 沒有評級就送結果：還沒評級的網頁只當線索，前提不算不成立
      const a = await review(c);
      await evidence(c, a);
      const ga = await docs(c, a, [{ url: MW, for: 'P2' }]);
      const runA = (await getRun(c.db, a.runId))!;
      await submit(c, a, brokenVotes(runA, ga.body.docs[0], QUOTE_MW));
      const doneA = (await getRun(c.db, a.runId))!;
      expect(doneA.added!.docs[0]).toMatchObject({ tier: 'UNRATED', rating: 'UNRATED', rated_here: null });
      expect(reviewDecision(doneA.outcome!, c.acct, 'NVDA', c.view.date, doneA.pack)).toMatchObject({ tier: 'HALF', brokenPremises: [], suggest: false });

      // ② 同一次執行裡：取文件 → /unrated → 來源評級評成產業研究機構 → 送結果 → 判前提不成立
      const b = await review(c);
      await evidence(c, b);
      const gb = await docs(c, b, [{ url: MW, for: 'P2' }]);
      expect(gb.body.docs[0].rating).toBe('UNRATED');
      expect((await unrated(c, b)).body.unrated.map((x) => x.domain)).toEqual(['memorywire.example']);
      expect((await rate(c, b, [{ domain: 'memorywire.example', tier: 'NAMED', reason: '公開報價摘要的記憶體研究機構' }])).body.saved).toHaveLength(1);
      const runB = (await getRun(c.db, b.runId))!;
      await submit(c, b, brokenVotes(runB, gb.body.docs[0], QUOTE_MW));
      const doneB = (await getRun(c.db, b.runId))!;
      expect(doneB.added!.docs[0]).toMatchObject({ tier: 'UNRATED', rating: 'NAMED', rated_here: '公開報價摘要的記憶體研究機構' });
      expect(doneB.pack.documents.find((d) => d.kind === 'web')).toMatchObject({ tier: 'NAMED', domain: 'memorywire.example', label: 'memorywire.example' });
      expect(reviewDecision(doneB.outcome!, c.acct, 'NVDA', c.view.date, doneB.pack)).toMatchObject({ tier: 'HALF', brokenPremises: ['P2'], premiseId: 'P2', suggest: true });
      // 審查紀錄頁：文件的級別、剛評好的寫理由
      expect(foundView(doneB)!.docs[0].level).toBe('網頁（產業研究機構）（這次評的：公開報價摘要的記憶體研究機構）');
      expect(foundView(doneA)!.docs[0].level).toBe('網頁（還沒評級）');

      // ③ 之前那一次執行的紀錄照它判的時候的級別（評級表後來有了也不變）
      const againA = (await getRun(c.db, a.runId))!;
      expect(againA.added!.docs[0].rating).toBe('UNRATED');
      expect(reviewDecision(againA.outcome!, c.acct, 'NVDA', c.view.date, againA.pack).brokenPremises).toEqual([]);
      // added_hash 不因為判的時候記的級別而變
      const h = await c.db.prepare('SELECT added_hash FROM ai_runs WHERE run_id = ?').bind(b.runId).first<{ added_hash: string }>();
      expect(h!.added_hash).toBe(runB.addedHash);
    });
  });

  // 證據包直接組（不經過抓取），級別照評級表查（rateAdded，就是送回結果時做的那一步）
  const FILING: PackDoc = { id: 'D1', source_id: 'edgar:x', kind: 'filing', date: '2026-10-30', title: '10-Q 2026-10-30：MD&A', text: `${Q_REV}.` };
  const NEWS: PackDoc = { id: 'N-NVDA', source_id: 'yahoo-rss:NVDA', kind: 'news', date: '2026-11-18', title: '新聞標題', text: '2026-11-18 | x' };
  let seq = 0;
  const web = (domain: string, quote: string): AddedDoc => ({ id: `A${++seq}`, source_id: `web:${String(seq).padStart(16, '0')}`, kind: 'web', tier: 'UNRATED', domain, label: domain, date: '2026-11-12', title: '網頁', url: `https://${domain}/a${seq}`, text: `Reporters say ${quote}.`, truncated: false, fetched_at: '2026-11-20T01:05:00.000Z', via: 'SEARCH', menu: null, for: 'P2', why: '查證', role: '分析師', at: '2026-11-20T01:05:00.000Z', row_id: seq });
  const Q1 = 'HBM contract quotes were cut for the first quarter by three buyers';
  const Q2 = 'module makers report a second month of falling HBM quotes';
  const tableOf = (rows: WebRatingRow[]) => new Map(rows.map((r) => [r.domain, r]));
  const packWith = (c: Ctx, added: AddedDoc[], table: Map<string, WebRatingRow>, conds?: { facts: EvidencePack['facts']; map: Record<string, number>; web?: Record<string, string[]> }) => {
    const { pack } = ownReviewPack({ acct: c.acct, view: c.view, axis: c.axis, ticker: 'NVDA', runId: `rev-${++seq}`, trigger: 'EARNINGS', xbrl: null, filings: [FILING], news: NEWS, conds, dataQuality: { filings: 'ok' }, now: T0 });
    return withAdded(pack, rateAdded(added, table, 'this-run'));
  };
  const votesFor = (pack: EvidencePack, verdict: string, cites: AddedDoc[][], quotes: string[][], payload: (ids: string[]) => Record<string, unknown> = () => ({})) =>
    [0, 1, 2].map((k) => {
      const ev = cites[k].map((d, i) => ({ id: `E${i + 2}`, source_id: d.source_id, date: d.date, quote: quotes[k][i], claim: '測試' }));
      const ids = ev.map((e) => e.id);
      return { run_id: pack.run_id, verdict, premise_checks: [{ premise_id: 'P1', status: 'HOLDS', evidence_ids: ['E1'], confirm_ids: ['E1'] }, ...(verdict === 'HALF' ? [{ premise_id: 'P2', status: 'BROKEN', evidence_ids: ids }] : [])], evidence: [{ id: 'E1', source_id: FILING.source_id, date: FILING.date, quote: Q_REV, claim: '營收' }, ...ev], payload: { tier: verdict, condition_checks: [], proposed_conditions: [], ...payload(ids) }, report: '測試' };
    });
  const brokenOf = (c: Ctx, added: AddedDoc[], table: Map<string, WebRatingRow>, cites: AddedDoc[], quotes: string[]) => {
    const pack = packWith(c, added, table);
    return reviewDecision(judge(pack, votesFor(pack, 'HALF', [cites, cites, cites], [quotes, quotes, quotes]), PAYLOAD_HOOKS[OWN_REVIEW]), c.acct, 'NVDA', c.view.date, pack).brokenPremises;
  };

  it('LEAD、還沒評級不能判前提不成立；MEDIA 一個網域不夠（同一個網域兩篇也不夠）、兩個不同網域可以；AI 評的一手或產業研究機構一份就可以', async () => {
    await withWorld(async (c) => {
      const lead = web('leadblog.example', Q1);
      const un = web('unrated.example', Q1);
      const a1 = web('wire-a.example', Q1);
      const a2 = web('wire-a.example', Q2);
      const b1 = web('wire-b.example', Q2);
      const named = web('research.example', Q1);
      const t = tableOf([row('leadblog.example', 'LEAD'), row('wire-a.example', 'MEDIA'), row('wire-b.example', 'MEDIA'), row('research.example', 'NAMED')]);
      expect(brokenOf(c, [lead], t, [lead], [Q1])).toEqual([]);
      expect(brokenOf(c, [un], t, [un], [Q1])).toEqual([]);
      expect(brokenOf(c, [a1], t, [a1], [Q1])).toEqual([]);
      expect(brokenOf(c, [a1, a2], t, [a1, a2], [Q1, Q2])).toEqual([]);
      // 媒體一份＋只當線索一份：不算兩個網域
      expect(brokenOf(c, [a1, lead], t, [a1, lead], [Q1, Q1])).toEqual([]);
      expect(brokenOf(c, [a1, b1], t, [a1, b1], [Q1, Q2])).toEqual(['P2']);
      expect(brokenOf(c, [named], t, [named], [Q1])).toEqual(['P2']);
      // 同一份文件，評級表改了 → 判的時候用當下的
      expect(brokenOf(c, [un], tableOf([row('unrated.example', 'PRIMARY')]), [un], [Q1])).toEqual(['P2']);
    });
  });

  it('web: 條件：指名的網域還沒評級 → 那一票這一條算證據不足（不算成立）；評成 NAMED 之後可以（WEB_VOTE）；MEDIA、LEAD 不行', async () => {
    await withWorld(async (c) => {
      const C1 = { id: 'C1', label: '你定的條件 C1（事件；你寫的，11/20 定）', value: 'MemoryWire 報 HBM 合約價下修' };
      const doc = web('memorywire.example', Q1);
      const met = (table: Map<string, WebRatingRow>) => {
        const pack = packWith(c, [doc], table, { facts: [C1], map: { C1: 1 }, web: { C1: ['memorywire.example'] } });
        const votes = votesFor(pack, 'HOLD', [[doc], [doc], [doc]], [[Q1], [Q1], [Q1]], (ids) => ({ condition_checks: [{ id: 'C1', status: 'MET', evidence_ids: ids }] }));
        return reviewDecision(judge(pack, votes, PAYLOAD_HOOKS[OWN_REVIEW]), c.acct, 'NVDA', c.view.date, pack);
      };
      expect(met(new Map())).toMatchObject({ consensus: true, metChecks: [], metBasis: {} });
      expect(met(tableOf([row('memorywire.example', 'NAMED')]))).toMatchObject({ metChecks: ['C1'], metBasis: { C1: 'WEB_VOTE' } });
      expect(met(tableOf([row('memorywire.example', 'PRIMARY')])).metChecks).toEqual(['C1']);
      expect(met(tableOf([row('memorywire.example', 'MEDIA')])).metChecks).toEqual([]);
      expect(met(tableOf([row('memorywire.example', 'LEAD')])).metChecks).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------- domains 不再讀

describe('T68 每檔的 domains 不再讀（§1.7）', () => {
  it('有沒有 domains、domains 裡寫了什麼，目錄、取文件與級別都一樣；舊資料的 domains 留著不壞', async () => {
    const run = async (domains: string[] | null) => {
      let out: unknown = null;
      await withWorld(
        async (c) => {
          const r = await review(c);
          expect(r.docCtx).toMatchObject({ domains: [] });
          await evidence(c, r);
          const got = await docs(c, r, [{ url: MW }, { url: FOOL }]);
          out = { docs: got.body.docs.map((d) => [d.domain, d.rating, d.title]), refused: got.body.refused, s: r.pack.facts.filter((f) => /^S\d+$/.test(f.id)).map((f) => f.value) };
          // 舊資料的 domains 還在帳戶裡（不讀、不丟）
          expect((await loadAccount(c.db))!.acct.own.NVDA.webSources?.domains ?? null).toEqual(domains);
        },
        {
          acct: (a) => {
            if (domains) a.own.NVDA.webSources = { peers: [], domains };
            return a;
          },
        },
      );
      return out;
    };
    const none = await run(null);
    // 以前「這檔的一手網域」會讓 memorywire.example 變成一手；fool.com 寫在舊資料裡也一樣不抓
    const withDomains = await run(['memorywire.example', 'fool.com']);
    expect(withDomains).toEqual(none);
    expect(none).toMatchObject({ docs: [['memorywire.example', 'UNRATED', expect.stringContaining('還沒評級')]], refused: [{ url: FOOL, reason: 'NOT_LISTED', detail: 'EXCLUDED' }] });
  });
});

// ---------------------------------------------------------------- 運作統計、匯出

describe('T68 運作統計與匯出（§1.8）', () => {
  it('「網頁來源的評級」：每個 AI 評過的網域、級別、理由、評的日期、被引用幾次（判的時候是這個網域、通過逐字檢查的引用）；種子不列', async () => {
    const d = await freshDb();
    try {
      const db = d.db;
      await db.prepare("INSERT INTO web_source_ratings (domain, tier, site_name, reason, run_id, rated_at) VALUES ('memorywire.example', 'NAMED', 'MemoryWire', '公開報價摘要', 'run-1', '2026-11-20T01:30:00.000Z'), ('chipfarm.example', 'LEAD', NULL, '看不出作者', 'run-1', '2026-11-19T01:30:00.000Z')").run();
      const added = { calls: 1, chars: 10, refused: [], refusedTotal: 0, sites: {}, docs: [{ id: 'A1', source_id: 'web:1', kind: 'web', tier: 'UNRATED', rating: 'NAMED', domain: 'memorywire.example', url: 'https://www.memorywire.example/a' }, { id: 'A2', source_id: 'web:2', kind: 'web', tier: 'NAMED', domain: 'trendforce.com', url: 'https://www.trendforce.com/a' }] };
      const ev = (ok: boolean) => ({ evidence: [{ id: 'E1', source_id: 'web:1', ok }, { id: 'E2', source_id: 'web:2', ok: true }] });
      await db
        .prepare("INSERT INTO ai_runs (run_id, fn, ticker, as_of, created_at, status, prompt_version, pack_hash, pack, added_docs, outcome) VALUES ('run-1', 'OWN_REVIEW', 'NVDA', '2026-11-19', '2026-11-20T01:00:00.000Z', 'DONE', 'own_review_v4', 'h', '{}', ?, ?)")
        .bind(JSON.stringify(added), JSON.stringify({ samples: [ev(true), ev(true), ev(false)] }))
        .run();
      const s = await webRatingsSection(db, { from: null, to: '2026-11-20', fromSource: 'none' });
      expect(s.id).toBe('web_ratings');
      expect(s.rows).toEqual([
        { domain: 'memorywire.example', tier: 'NAMED', reason: '公開報價摘要', site_name: 'MemoryWire', rated_at: '2026-11-20', run_id: 'run-1', cited: 2, cited_runs: 1 },
        { domain: 'chipfarm.example', tier: 'LEAD', reason: '看不出作者', site_name: null, rated_at: '2026-11-19', run_id: 'run-1', cited: 0, cited_runs: 0 },
      ]);
    } finally {
      await d.dispose();
    }
  });

  it('web_source_ratings 照 rowid 增量匯出（同一個網域留最後一列），寫在 records_guide.md', () => {
    expect(EXPORT_TABLES.web_source_ratings).toMatchObject({ mode: 'append', key: 'domain' });
    const guide = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'analysis', 'records_guide.md'), 'utf8');
    expect(guide).toContain('| `web_source_ratings` |');
    expect(guide).toContain('| `web_ratings` |');
  });
});
