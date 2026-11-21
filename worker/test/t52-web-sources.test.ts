// T52：每檔的來源、目錄、取文件的端點（web_evidence_design §1.2、§1.3、§1.5）。
// 完成條件：
//   目錄只有標題、證據包的大小不因同業與網頁變大
//   端點：別的功能 403、送回之後 410、第 9 份回 LIMIT、超過字數截掉並標記、清單外與認不出日期各回對應的原因
//   引用取回的文件通過逐字檢查、引用沒取過的網址不通過
//   只有預設前提的檔沒有目錄
//   （另外）編輯論點頁存每檔的來源、存檔前試抓；寫了 used_by 之後每日流程清沒被用過的快照全文
// 對外請求全部是假的（網頁、EDGAR、RSS、雲端排程）；repo 是公開的。
import { describe, expect, it } from 'vitest';
import { DOCS_MAX_CHARS, emptyAdded, parseAdded, withAdded, type AddedDoc } from '../src/ai/added';
import type { EvidencePack } from '../src/ai/check';
import { buildPack } from '../src/ai/pack';
import { getRun, startRun, type AiRun } from '../src/app/aiRuns';
import type { Env, Fetcher } from '../src/app/env';
import { EXPORT_TABLES } from '../src/app/export';
import { runFlow, type Attempt } from '../src/app/flow';
import { LINE_PUSH_URL } from '../src/app/line';
import { loadAccount, saveAccount } from '../src/app/ledgerStore';
import { startOwnReview } from '../src/app/ownAi';
import { thesisFile, type ThesisFile } from '../src/app/thesis';
import { MENU_MAX, buildDocMenu, listedHeadlines, normalizeDomain, parseWebSources, pickPeerFilings } from '../src/app/webEvidence';
import { handle } from '../src/index';
import type { CompanyFacts, XbrlFact } from '../src/data/edgar';
import { buildMarketView } from '../src/data/marketView';
import { loadSeries } from '../src/data/store';
import { createAccount, type Account, type MarketView } from '../src/engine';
import { freshDb } from './helpers/d1';
import { cronTime, fakeFetcher, newWorld, type World } from './helpers/fakeSources';

// ---------------------------------------------------------------- 假的網頁

const PARA = (s: string) => `<p>${s.repeat(Math.ceil(260 / s.length))}</p>`;
const body = (tag: string, n = 8) => Array.from({ length: n }, (_, i) => PARA(`Paragraph ${i} of ${tag}: contract prices for DRAM rose in the fourth quarter according to the survey. `)).join('\n');
const page = (o: { title: string; head?: string; dateLine?: string; n?: number; tag?: string }) =>
  `<!doctype html><html><head><title>Site | ${o.title}</title>${o.head ?? ''}</head><body><ul><li>Home</li><li>News</li></ul><h1>${o.title}</h1>${o.dateLine ? `<div>${o.dateLine}</div>` : ''}${body(o.tag ?? o.title, o.n)}</body></html>`;
const META = (d: string) => `<meta property="article:published_time" content="${d}">`;
const TIME = (d: string) => `<time datetime="${d}">${d}</time>`;

const TF = (n: number) => `https://www.trendforce.com/presscenter/news/2026111${n}-memory.html`;
const TPU = (n: number) => `https://www.techpowerup.com/34${n}/memory-news`;
const BIG = (n: number) => `https://www.techpowerup.com/big${n}/long-story`;
const SKH = 'https://news.skhynix.com/hbm-q3-results/';
const NODATE = 'https://www.semiconductors.org/no-date-story/';
const OLD = 'https://www.semiconductors.org/old-story/';
const FOOL = 'https://www.fool.com/investing/2026/11/17/buy-nvda/';
const OTHER = 'https://example.org/story';

const PAGES: Record<string, () => string> = {
  ...Object.fromEntries([1, 2, 3, 4].map((n) => [TF(n), () => page({ title: `TrendForce story ${n}`, head: META(`2026-11-1${n}T08:00:00Z`), tag: `TF${n}` })])),
  ...Object.fromEntries([1, 2, 3, 4].map((n) => [TPU(n), () => page({ title: `TechPowerUp story ${n}`, head: TIME(`2026-11-0${n}T08:00:00Z`), tag: `TPU${n}` })])),
  ...Object.fromEntries([1, 2, 3, 4].map((n) => [BIG(n), () => page({ title: `Long story ${n}`, head: TIME(`2026-11-0${n}T08:00:00Z`), tag: `BIG${n}`, n: 60 })])),
  [SKH]: () => page({ title: 'SK hynix Q3 results', dateLine: 'November 16, 2026', tag: 'SKH' }),
  [NODATE]: () => page({ title: 'A story without a date', tag: 'NODATE' }),
  [OLD]: () => page({ title: 'An old story', head: META('2025-06-01T08:00:00Z'), tag: 'OLD' }),
};

// ---------------------------------------------------------------- 假的 EDGAR（NVDA 自己、同業 MU）

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
interface FakeFiling {
  accession: string;
  form: string;
  items: string;
  acceptanceDateTime: string;
  filingDate: string;
  primaryDocument: string;
  html: string;
}
const TENQ: FakeFiling = { accession: '0001045810-26-000300', form: '10-Q', items: '', acceptanceDateTime: '2026-10-30T20:10:00.000Z', filingDate: '2026-10-30', primaryDocument: 'q.htm', html: `<html><body><p>Item 2. Management’s Discussion and Analysis of Financial Condition and Results of Operations</p><p>Revenue for the third quarter was $160 million, up 33% from a year ago.</p><p>Item 3. Quantitative and Qualitative Disclosures About Market Risk</p></body></html>` };
const muK = (n: number, date: string, items: string, text: string): FakeFiling => ({ accession: `0000723125-26-00000${n}`, form: '8-K', items, acceptanceDateTime: `${date}T21:00:00.000Z`, filingDate: date, primaryDocument: `mu${n}.htm`, html: `<html><body><p>Item ${items.split(',')[0]} ${text}</p></body></html>` });
const MU_PR = 'Results of Operations. Micron reported record HBM revenue and raised its outlook for data center memory. ';
const MU_FILINGS = [muK(0, '2026-06-01', '2.02', 'Results of Operations. Old quarter.'), muK(1, '2026-09-25', '2.02,9.01', MU_PR.repeat(200)), muK(2, '2026-10-10', '8.01', 'Other Events.'), muK(3, '2026-10-20', '5.02', 'Departure of Directors or Certain Officers.'), muK(4, '2026-11-05', '7.01', 'Regulation FD Disclosure.')];
const subs = (cik: string, name: string, fs: FakeFiling[]) => {
  const s = [...fs].sort((a, b) => b.acceptanceDateTime.localeCompare(a.acceptanceDateTime));
  return Response.json({ cik, name, tickers: [], filings: { recent: { accessionNumber: s.map((f) => f.accession), form: s.map((f) => f.form), items: s.map((f) => f.items), acceptanceDateTime: s.map((f) => f.acceptanceDateTime), filingDate: s.map((f) => f.filingDate), primaryDocument: s.map((f) => f.primaryDocument) } } });
};
const rss = (items: { title: string; link: string; date: string }[]) => `<rss><channel>${items.map((i) => `<item><title>${i.title}</title><link>${i.link}</link><pubDate>${new Date(`${i.date}T12:00:00Z`).toUTCString()}</pubDate></item>`).join('')}</channel></rss>`;
const NVDA_RSS = rss([
  { title: 'DRAM contract prices rise again', link: TF(1), date: '2026-11-18' },
  { title: 'Is NVDA a buy?', link: FOOL, date: '2026-11-17' },
  { title: 'TrendForce paid report', link: 'https://www.trendforce.com/research/download/RP1', date: '2026-11-17' },
  { title: 'Nasdaq article', link: 'https://www.nasdaq.com/articles/nvda-1', date: '2026-11-16' },
]);
const HYNIX_RSS = rss([
  { title: 'SK hynix posts Q3 results', link: SKH, date: '2026-11-16' },
  { title: 'HBM supply tight', link: TF(2), date: '2026-11-15' },
]);

interface W {
  calls: string[];
}
function fetcherOf(w: World, log: W): Fetcher {
  const base = fakeFetcher(w);
  return async (url, init) => {
    log.calls.push(url);
    if (url === LINE_PUSH_URL) return Response.json({});
    if (url === 'https://api.example/fire') return Response.json({ claude_code_session_url: 'https://claude.ai/code/x' });
    if (url.includes('submissions/CIK0001045810.json')) return subs('1045810', 'NVIDIA CORP', [TENQ]);
    if (url.includes('submissions/CIK0000723125.json')) return subs('723125', 'MICRON TECHNOLOGY INC', MU_FILINGS);
    if (/companyfacts\/CIK\d+\.json/.test(url)) return Response.json(BASE);
    const doc = /Archives\/edgar\/data\/(\d+)\/(\d+)\/(.+)$/.exec(url);
    if (doc) {
      const f = [TENQ, ...MU_FILINGS].find((x) => x.accession.replace(/-/g, '') === doc[2]);
      if (!f) return new Response('nf', { status: 404 });
      if (doc[3] === 'index.json') return Response.json({ directory: { item: [{ name: f.primaryDocument }] } });
      return new Response(f.html);
    }
    if (url.startsWith('https://www.nasdaq.com/feed/rssoutbound')) return new Response(url.includes('NVDA') ? NVDA_RSS : '<rss><channel></channel></rss>');
    if (url.startsWith('https://feeds.finance.yahoo.com/rss/2.0/headline')) return new Response(url.includes('000660.KS') ? HYNIX_RSS : '<rss><channel></channel></rss>');
    if (url === 'https://news.skhynix.com/') return new Response('<html>home</html>', { headers: { 'content-type': 'text/html' } });
    if (url === 'https://ir.example-memory.com/') return new Response('denied', { status: 403 });
    const p = PAGES[url];
    if (p) return new Response(p(), { headers: { 'content-type': 'text/html; charset=utf-8' } });
    return base(url, init);
  };
}

const WS = { peers: [{ name: 'Micron', edgar: 'MU' }, { name: 'SK hynix', yahoo: '000660.KS' }], domains: ['news.skhynix.com'] };

interface Ctx {
  db: D1Database;
  env: Env;
  fetcher: Fetcher;
  log: W;
  run: (date: string, attempt?: Attempt) => ReturnType<typeof runFlow>;
  viewAt: (date: string) => Promise<{ view: MarketView; axis: string[] }>;
  call: <T = Record<string, unknown>>(method: 'GET' | 'POST', path: string, body?: unknown, now?: Date, auth?: string) => Promise<{ status: number; body: T }>;
}

async function withWorld(fn: (c: Ctx) => Promise<void>, opt: { defaults?: boolean; acct?: (a: Account) => Account } = {}) {
  const d = await freshDb();
  try {
    const db = d.db;
    const w = newWorld('2026-11-19');
    const log: W = { calls: [] };
    const env: Env = { DB: db, ADMIN_TOKEN: 't', AI_TASK_SECRET: 's', EDGAR_USER_AGENT: 'test bot test@example.com', SITE_URL: 'https://bot.example', LINE_CHANNEL_TOKEN: 'lt', LINE_USER_ID: 'U1', DEV_NO_AUTH: '1', ROUTINE_FIRE_URL: 'https://api.example/fire', ROUTINE_TOKEN: 'rt' };
    const fetcher = fetcherOf(w, log);
    const run = (date: string, attempt: Attempt = 'FIRST') => {
      w.dataDate = date;
      return runFlow(env, fetcher, { now: cronTime(date), attempt });
    };
    const viewAt = async (date: string) => buildMarketView(await loadSeries(db, ['VOO', 'SGOV', 'NVDA']), date, 'VOO');
    const call: Ctx['call'] = async (method, path, b, now = new Date('2026-11-20T01:10:00Z'), auth) => {
      const r = await handle(new Request(`https://bot.example${path}`, { method, headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) }, ...(b === undefined ? {} : { body: typeof b === 'string' ? b : JSON.stringify(b) }) }), env, fetcher, now);
      return { status: r.status, body: (await r.json()) as never };
    };
    await run('2026-11-19');
    const { view } = await viewAt('2026-11-19');
    let acct = createAccount(
      {
        paper: true,
        cash: 5000,
        core: { VOO: Math.floor(140_000 / view.close.VOO[view.i]) },
        own: { NVDA: { shares: Math.floor(40_000 / view.close.NVDA[view.i]), stdWeight: 0.15, ...(opt.defaults ? {} : { premises: [{ id: 'P1', text: '資料中心需求延續到 2027', origin: 'USER' as const }, { id: 'P2', text: 'HBM 供給持續吃緊', origin: 'USER' as const }] }) } },
      },
      view,
    );
    if (opt.acct) acct = opt.acct(acct);
    await saveAccount(db, acct, null, '建立帳戶', new Date('2026-11-19T12:00:00Z'));
    await fn({ db, env, fetcher, log, run, viewAt, call });
  } finally {
    await d.dispose();
  }
}

const withSources = (a: Account) => {
  a.own.NVDA.webSources = structuredClone(WS);
  return a;
};
const T0 = new Date('2026-11-20T01:00:00Z');

async function review(c: Ctx, acct?: Account): Promise<AiRun> {
  const a = acct ?? (await loadAccount(c.db))!.acct;
  const { view, axis } = await c.viewAt('2026-11-19');
  return startOwnReview(c.env, c.fetcher, a, view, axis, 'NVDA', 'MANUAL', T0);
}
const docsCall = (c: Ctx, run: AiRun, want: unknown[], extra: Record<string, unknown> = {}) => c.call<DocsBody>('POST', `/ai/task/${run.taskId}/docs`, { want, ...extra }, undefined, 's');
const fetchEvidence = (c: Ctx, run: AiRun) => c.call('GET', `/ai/task/${run.taskId}/evidence`, undefined, undefined, 's');

interface DocsBody {
  docs: { id: string; source_id: string; kind: string; tier: string | null; date: string; title: string; url: string | null; text: string; truncated: boolean }[];
  refused: { url?: string; menu?: string; reason: string; detail: string | null }[];
  left: { docs: number; chars: number; calls: number };
  error?: string;
}

const menuOf = (pack: EvidencePack) => pack.facts.filter((f) => /^M(\d+|\+)$/.test(f.id));

// ---------------------------------------------------------------- 目錄

describe('T52 目錄（§1.2）', () => {
  it('目錄只有標題：同業的申報在前（最新的 2.02 先、每家最多 3 份）、清單內的 RSS 連結新的在前；證據包的文件和沒有指定來源時完全一樣', async () => {
    await withWorld(async (c) => {
      const plain = await review(c);
      const acct = withSources((await loadAccount(c.db))!.acct);
      const r = await review(c, acct);
      // 文件一份都沒變（只多 facts 的目錄，不帶全文）
      expect(JSON.stringify(r.pack.documents.map((d) => [d.source_id, d.title, d.text]))).toBe(JSON.stringify(plain.pack.documents.map((d) => [d.source_id, d.title, d.text])));
      expect(r.pack.documents.some((d) => d.kind === 'web')).toBe(false);
      const m = menuOf(r.pack);
      expect(m.map((f) => f.value)).toEqual([
        'Micron｜8-K 2.02（財報新聞稿）｜2026-09-25',
        'Micron｜8-K 7.01（公開說明）｜2026-11-05',
        'Micron｜8-K 5.02（高層異動）｜2026-10-20',
        'TrendForce｜指名的產業來源｜2026-11-18｜DRAM contract prices rise again',
        'news.skhynix.com｜一手｜2026-11-16｜SK hynix posts Q3 results',
        'TrendForce｜指名的產業來源｜2026-11-15｜HBM supply tight',
      ]);
      expect(m.map((f) => f.id)).toEqual(['M1', 'M2', 'M3', 'M4', 'M5', 'M6']);
      // 只有標題：每一項都很短；不在清單的（fool.com、付費報告頁、nasdaq.com）沒有列
      for (const f of m) expect(f.value.length).toBeLessThan(250);
      expect(JSON.stringify(m)).not.toMatch(/fool\.com|Is NVDA a buy|paid report|Nasdaq article/);
      // 沒有指定來源時：只有這檔自己 RSS 裡清單內的連結
      expect(menuOf(plain.pack).map((f) => f.value)).toEqual(['TrendForce｜指名的產業來源｜2026-11-18｜DRAM contract prices rise again']);
      // 證據包整份只多了目錄那幾行
      const grow = JSON.stringify(r.pack).length - JSON.stringify(plain.pack).length;
      expect(grow).toBeLessThan(m.reduce((s, f) => s + f.value.length + 120, 0));
      // 執行紀錄記下可以取什麼
      expect(r.docCtx).toMatchObject({ notBefore: '2025-11-19', domains: ['news.skhynix.com'], fileId: 'NVDA@2026-11-19' });
      expect(r.docCtx!.menu[0]).toMatchObject({ id: 'M1', kind: 'filing', peer: 'Micron', cik: '0000723125', filing: { accession: '0000723125-26-000001' } });
      expect(r.docCtx!.menu[4]).toMatchObject({ id: 'M5', kind: 'web', url: SKH, published: '2026-11-16' });
    });
  });

  it('目錄最多 20 項，超過的寫「另有 N 項沒有列出」；同業的申報挑法', async () => {
    const tf = { lastReview: null, newSince: '2026-07-22', fileId: 'X@2026-01-01' } as unknown as ThesisFile;
    const heads = Array.from({ length: 25 }, (_, i) => ({ date: '2026-11-10', at: `2026-11-10T${String(i).padStart(2, '0')}:00:00.000Z`, title: `Story ${i}`, link: `https://www.trendforce.com/news/2026/11/10/story-${i}/` }));
    const env = { DB: null, EDGAR_USER_AGENT: 'x' } as unknown as Env;
    const out = await buildDocMenu(env, (async () => new Response('', { status: 500 })) as Fetcher, { ticker: 'X', tf, meta: { premises: [{ id: 'P4', text: 'x', origin: 'USER' }], webSources: null }, asOf: '2026-11-19', headlines: heads });
    expect(out.facts.filter((f) => /^M\d+$/.test(f.id))).toHaveLength(MENU_MAX);
    expect(out.facts.at(-1)).toMatchObject({ id: 'M+', value: '另有 5 項沒有列出' });
    expect(out.facts[0].value).toContain('Story 24'); // 新的在前
    expect(out.ctx.menu).toHaveLength(MENU_MAX);
    // RSS：決策日之後、早於下限的不列；同一個網址只列一次
    const l = listedHeadlines([...heads.slice(0, 2), { ...heads[0] }, { date: '2026-11-25', at: '2026-11-25T00:00:00Z', title: 'future', link: TF(1) }, { date: '2025-01-01', at: '2025-01-01T00:00:00Z', title: 'old', link: TF(2) }], [], '2026-11-19', '2025-11-19');
    expect(l.map((e) => e.title)).toEqual(['Story 1', 'Story 0']);
    // 同業：上次有結論的審查之後的 8-K，2.02 先
    const F = (acc: string, date: string, items: string[], form = '8-K') => ({ accession: acc, form, items, filingDate: date, acceptedAt: `${date}T21:00:00.000Z`, primaryDocument: 'x.htm' });
    const tf2 = { lastReview: { runId: 'r', asOf: '2026-10-01', createdAt: '2026-10-02T01:00:00Z' }, newSince: '2026-06-01' } as unknown as ThesisFile;
    expect(pickPeerFilings([F('a', '2026-09-30', ['2.02']), F('b', '2026-10-05', ['8.01']), F('c', '2026-10-20', ['2.02']), F('d', '2026-11-01', ['5.02']), F('e', '2026-11-02', [], '10-Q'), F('f', '2026-11-10', ['7.01'])], tf2, '2026-11-19').map((f) => f.accession)).toEqual(['c', 'f', 'd']);
  });

  it('只有預設前提的檔沒有目錄，也不能取文件', async () => {
    await withWorld(
      async (c) => {
        const r = await review(c);
        expect(menuOf(r.pack)).toEqual([]);
        expect(r.docCtx).toMatchObject({ menu: [], off: '只有系統預設前提：不用網頁證據' });
        await fetchEvidence(c, r);
        const res = await docsCall(c, r, [{ url: TF(1) }]);
        expect(res.status).toBe(403);
        expect(res.body).toMatchObject({ error: 'not_allowed' });
      },
      { defaults: true, acct: withSources },
    );
  });
});

// ---------------------------------------------------------------- 取文件的端點

describe('T52 取文件的端點（§1.5）', () => {
  it('目錄與網址取回文件；清單外、不列入、認不出日期、太舊各回原因；第 9 份 LIMIT；表決時取回的文件算進原文，沒取過的網址不算', async () => {
    await withWorld(
      async (c) => {
        // T63（composite_layer_design §3）：這檔第一次定期審查會跑新眼光，分析師的額度要替它留 1 份（在 t63-fresh-eyes.test.ts 測）。
        // 這裡測的是端點本身的上限，所以用同一天的第二次審查（未滿 90 天，沒有新眼光）
        await review(c);
        const r = await review(c);
        expect(r.pack.fresh_eyes?.run).toBe(false);
        // 還沒取證據包 → 409
        expect((await docsCall(c, r, [{ menu: 'M1' }])).status).toBe(409);
        await fetchEvidence(c, r);
        const a = await docsCall(c, r, [
          { menu: 'M1', for: 'P2', why: '同業的財報新聞稿寫 HBM 供給' },
          { menu: 'M4', for: 'P2', why: 'TrendForce 的報價' },
          { url: FOOL, title: 'Is NVDA a buy?' },
          { url: OTHER },
          { url: NODATE },
          { url: OLD },
          { menu: 'M99' },
        ]);
        expect(a.status).toBe(200);
        expect(a.body.docs.map((d) => [d.id, d.source_id.split(':')[0], d.kind, d.tier])).toEqual([
          ['A1', 'edgar', 'filing', null],
          ['A2', 'web', 'web', 'NAMED'],
        ]);
        // 同業申報取開頭 15,000 字，截掉的標記
        expect(a.body.docs[0]).toMatchObject({ source_id: 'edgar:0000723125-26-000001', date: '2026-09-25', truncated: true });
        expect(a.body.docs[0].text).toHaveLength(15_000);
        expect(a.body.docs[0].title).toMatch(/^〔同業申報｜Micron〕8-K.*（只取開頭 15,000 字）$/);
        expect(a.body.docs[1].title).toBe('〔網頁｜指名的產業來源｜TrendForce〕TrendForce story 1（發布 2026-11-18，2026-11-20 抓）');
        // 網頁寫 11-11、RSS 寫 11-18：差超過 3 天用比較晚的（T51 的規則）
        expect(a.body.refused).toEqual([
          { url: FOOL, reason: 'NOT_LISTED', detail: 'EXCLUDED' },
          { url: OTHER, reason: 'NOT_LISTED', detail: 'NOT_LISTED' },
          { url: NODATE, reason: 'NO_DATE', detail: '認不出發布日' },
          { url: OLD, reason: 'TOO_OLD', detail: '發布日 2025-06-01 早於 2025-11-19' },
          { menu: 'M99', reason: 'ERROR', detail: '目錄沒有 M99' },
        ]);
        // 再要一次同一份：原樣再給、不算份數
        const again = await docsCall(c, r, [{ menu: 'M4' }, { url: TF(2) }, { url: TF(3) }, { url: TF(4) }, { url: TPU(1) }, { url: TPU(2) }, { url: TPU(3) }]);
        expect(again.body.docs.map((d) => d.id)).toEqual(['A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8']);
        expect(again.body.left.docs).toBe(0);
        // 第 9 份 → LIMIT（不去抓）
        const n = c.log.calls.length;
        const ninth = await docsCall(c, r, [{ url: TPU(4) }]);
        expect(ninth.body.docs).toEqual([]);
        expect(ninth.body.refused).toEqual([{ url: TPU(4), reason: 'LIMIT', detail: '每次執行最多取回 8 份' }]);
        expect(c.log.calls.slice(n)).not.toContain(TPU(4));

        // 每一筆網頁（含被拒絕的）都寫進 web_docs；取回的記 used_by
        const rows = (await c.db.prepare('SELECT url, status, via, ref, premise_id, used_by FROM web_docs ORDER BY row_id').all<Record<string, string | null>>()).results;
        expect(rows.map((x) => [x.url, x.status])).toEqual([[TF(1), 'OK'], [FOOL, 'NOT_LISTED'], [OTHER, 'NOT_LISTED'], [NODATE, 'NO_DATE'], [OLD, 'TOO_OLD'], [TF(2), 'OK'], [TF(3), 'OK'], [TF(4), 'OK'], [TPU(1), 'OK'], [TPU(2), 'OK'], [TPU(3), 'OK']]);
        expect(rows[0]).toMatchObject({ via: 'MENU', ref: r.runId, premise_id: 'P2', used_by: r.runId });
        expect(rows[5]).toMatchObject({ via: 'SEARCH', used_by: r.runId });
        expect(rows[1].used_by).toBeNull();

        // 執行紀錄：取回的文件、被拒絕的、呼叫次數；pack_hash 不變，另算 added_hash；存的 pack 不含取回的文件
        const raw = await c.db.prepare('SELECT pack, pack_hash, added_hash, added_docs FROM ai_runs WHERE run_id = ?').bind(r.runId).first<{ pack: string; pack_hash: string; added_hash: string; added_docs: string }>();
        expect(raw!.pack_hash).toBe(r.packHash);
        expect(raw!.added_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect(JSON.parse(raw!.pack).documents.some((d: { id: string }) => d.id.startsWith('A'))).toBe(false);
        const rec = parseAdded(raw!.added_docs);
        expect(rec).toMatchObject({ calls: 3, refusedTotal: 6 });
        expect(rec.docs[0]).toMatchObject({ via: 'MENU', menu: 'M1', for: 'P2', why: '同業的財報新聞稿寫 HBM 供給' });

        // 表決：引用取回的網頁 → 通過；引用沒取過的網址 → 不在證據包裡
        const run = (await getRun(c.db, r.runId))!;
        expect(run.pack.documents.filter((d) => d.id.startsWith('A')).map((d) => d.kind)).toEqual(['filing', 'web', 'web', 'web', 'web', 'web', 'web', 'web']);
        const tf1 = run.pack.documents.find((d) => d.id === 'A2')!;
        const vote = {
          run_id: r.runId,
          verdict: 'HOLD',
          model: 'claude-opus-5-5',
          premise_checks: [
            { premise_id: 'P1', status: 'HOLDS', evidence_ids: ['E1'] },
            { premise_id: 'P2', status: 'HOLDS', evidence_ids: ['E2', 'E3'] },
          ],
          evidence: [
            { id: 'E1', source_id: tf1.source_id, date: tf1.date, quote: 'Paragraph 0 of TF1: contract prices for DRAM rose in the fourth quarter', claim: 'TrendForce 說合約價上漲' },
            { id: 'E2', source_id: 'edgar:0000723125-26-000001', date: '2026-09-25', quote: 'Micron reported record HBM revenue and raised its outlook', claim: '同業的 HBM 營收創新高' },
            { id: 'E3', source_id: 'web:00000000deadbeef', date: '2026-11-10', quote: 'HBM supply will stay tight through 2027 according to', claim: '沒取過的網址' },
          ],
          payload: { tier: 'HOLD', condition_checks: [], proposed_conditions: [] },
          report: '維持。',
        };
        const res = await c.call('POST', `/ai/task/${r.taskId}/result`, { task_id: r.taskId, kind: 'RUN', run_id: r.runId, samples: [vote, vote, vote] }, undefined, 's');
        expect(res.status).toBe(200);
        const done = (await getRun(c.db, r.runId))!;
        const ev = done.outcome!.samples[0].evidence;
        expect(ev.find((e) => e.id === 'E1')).toMatchObject({ ok: true });
        expect(ev.find((e) => e.id === 'E2')).toMatchObject({ ok: true });
        expect(ev.find((e) => e.id === 'E3')).toMatchObject({ ok: false, why: '來源 web:00000000deadbeef 不在證據包裡' });
        // 送回結果之後 → 410
        expect((await docsCall(c, r, [{ url: TPU(4) }])).status).toBe(410);
      },
      { acct: withSources },
    );
  });

  it('合計 60,000 字：網頁每份開頭 12,000 字、用完前的那一份截到剩下的字數並標記，之後的 LIMIT；最多呼叫 6 次', async () => {
    await withWorld(
      async (c) => {
        // T63：同上，用沒有新眼光的第二次審查測端點本身的上限（有新眼光時分析師少 6,000 字與 1 次呼叫，在 t63 測）
        await review(c);
        const r = await review(c);
        expect(r.pack.fresh_eyes?.run).toBe(false);
        await fetchEvidence(c, r);
        const a = await docsCall(c, r, [{ url: BIG(1) }, { url: BIG(2) }, { url: BIG(3) }, { url: BIG(4) }, { menu: 'M1' }, { menu: 'M4' }]);
        expect(a.body.docs.map((d) => [d.text.length, d.truncated])).toEqual([
          [12_000, true],
          [12_000, true],
          [12_000, true],
          [12_000, true],
          [12_000, true],
        ]);
        expect(a.body.docs[0].title).toMatch(/（只取開頭 12,000 字）$/);
        expect(a.body.docs[4].title).toMatch(/^〔同業申報｜Micron〕.*（只取開頭 12,000 字）$/);
        expect(a.body.refused).toEqual([{ menu: 'M4', reason: 'LIMIT', detail: `每次執行合計最多 60,000 字，已經用完` }]);
        expect(a.body.left).toEqual({ docs: 3, chars: 0, calls: 5 });
        for (let i = 0; i < 5; i++) await docsCall(c, r, []);
        const seventh = await docsCall(c, r, [{ menu: 'M5' }]);
        expect(seventh.body.refused).toEqual([{ menu: 'M5', reason: 'LIMIT', detail: '每次執行最多呼叫 6 次' }]);
        const rec = parseAdded((await c.db.prepare('SELECT added_docs FROM ai_runs WHERE run_id = ?').bind(r.runId).first<{ added_docs: string }>())!.added_docs);
        expect(rec.chars).toBe(DOCS_MAX_CHARS);
        expect(rec.calls).toBe(7);
      },
      { acct: withSources },
    );
  });

  it('別的功能的任務 → 403；沒有這個任務 → 404；沒帶金鑰 → 401', async () => {
    await withWorld(async (c) => {
      const { pack } = buildPack({ runId: 'R-check', fn: 'OWN_CHECK', promptVersion: 'own_check_v4', asOf: '2026-11-19', subject: { ticker: 'NVDA' }, question: 'q', policy: { level: 'A2', verdicts: ['DONE', 'INSUFFICIENT'], abstain: 'INSUFFICIENT', min_evidence: 0, samples: 1 }, rule: { action: 'x' }, now: T0 });
      const run = await startRun(c.env, c.fetcher, pack, T0);
      await fetchEvidence(c, run);
      const res = await docsCall(c, run, [{ url: TF(1) }]);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: 'not_allowed' });
      expect((await c.call('POST', `/ai/task/${'0'.repeat(32)}/docs`, { want: [] }, undefined, 's')).status).toBe(404);
      expect((await c.call('POST', `/ai/task/${run.taskId}/docs`, { want: [] })).status).toBe(401);
    });
  });

  it('withAdded：同一個 source_id 原本就有的不再加；沒有取回時是同一份證據包', () => {
    const pack = { documents: [{ id: 'F-1', source_id: 'edgar:1', kind: 'filing', date: '2026-11-01', title: 't', text: 'x' }] } as unknown as EvidencePack;
    expect(withAdded(pack, [])).toBe(pack);
    const d = (source_id: string): AddedDoc => ({ id: 'A1', source_id, kind: 'web', tier: 'NAMED', date: '2026-11-02', title: 't', url: 'https://x', text: 'y', truncated: false, fetched_at: 'z', via: 'SEARCH', menu: null, for: null, why: null, role: null, at: 'z', row_id: 1 });
    expect(withAdded(pack, [d('edgar:1')]).documents).toHaveLength(1);
    expect(withAdded(pack, [d('web:1')]).documents.map((x) => x.id)).toEqual(['F-1', 'A1']);
    expect(parseAdded(null)).toEqual(emptyAdded());
    expect(parseAdded('壞掉')).toEqual(emptyAdded());
    expect(EXPORT_TABLES.ai_runs.json).toEqual(expect.arrayContaining(['doc_ctx', 'added_docs']));
  });
});

// ---------------------------------------------------------------- 編輯論點頁：每檔的來源

describe('T52 每檔的來源（§1.3）', () => {
  it('檢查：不列入的網站加不進來、共用清單已經有的不用加、格式與上限；貼網址只取主機', () => {
    expect(normalizeDomain('https://news.skhynix.com/en/press/')).toBe('news.skhynix.com');
    expect(normalizeDomain('localhost')).toBeNull();
    expect(parseWebSources({ peers: [{ name: ' SK 海力士 ', yahoo: '000660.ks' }, { name: '', edgar: '' }], domains: ['HTTPS://News.SKhynix.com/x', 'news.skhynix.com'] }, 'MU')).toEqual({ peers: [{ name: 'SK 海力士', yahoo: '000660.KS' }], domains: ['news.skhynix.com'] });
    expect(parseWebSources({ peers: [], domains: [] }, 'MU')).toBeNull();
    expect(() => parseWebSources({ domains: ['www.fool.com'] }, 'MU')).toThrow('www.fool.com 是不列入的網站');
    expect(() => parseWebSources({ domains: ['trendforce.com'] }, 'MU')).toThrow('已經在共用清單裡（TrendForce）');
    expect(() => parseWebSources({ peers: [{ name: '三星' }] }, 'MU')).toThrow('要填 EDGAR 代號或 Yahoo 代號');
    expect(() => parseWebSources({ peers: [{ name: '自己', edgar: 'mu' }] }, 'MU')).toThrow('同業不能是 MU 自己');
    expect(() => parseWebSources({ peers: Array.from({ length: 5 }, (_, i) => ({ name: `p${i}`, edgar: `A${i}` })) }, 'MU')).toThrow('同業最多 4 家');
    expect(() => parseWebSources({ domains: Array.from({ length: 7 }, (_, i) => `n${i}.example.com`) }, 'MU')).toThrow('最多 6 個');
    expect(() => parseWebSources({ domains: ['not a domain'] }, 'MU')).toThrow('不是可以用的網域');
  });

  it('編輯論點頁存來源：存檔前試抓（抓不到的仍存、標出來）；預覽不試抓；沒送就不動；不合格的回 422；試抓端點不存', async () => {
    await withWorld(async (c) => {
      const base = { ticker: 'NVDA', thesis: '論點', premises: [{ id: 'P1', text: '資料中心需求延續到 2027' }, { id: 'P2', text: 'HBM 供給持續吃緊' }], exitConditions: [], source: 'TYPED' };
      const ws = { peers: [{ name: 'Micron', edgar: 'MU' }, { name: 'SK hynix', yahoo: '000660.KS' }], domains: ['news.skhynix.com', 'ir.example-memory.com'] };
      // 預覽：說有改動，但不試抓
      const n0 = c.log.calls.length;
      const dry = await c.call<{ preview: { sources: { changed: boolean; checked: unknown } } }>('POST', '/api/ops/own-thesis', { ...base, webSources: ws, dry: true });
      expect(dry.body.preview.sources).toMatchObject({ changed: true, checked: null });
      expect(c.log.calls.slice(n0)).not.toContain('https://news.skhynix.com/');
      // 試抓端點：回結果、不存
      const pr = await c.call<{ items: { key: string; ok: boolean | null; why: string }[] }>('POST', '/api/ops/own-sources/probe', { ticker: 'NVDA', webSources: ws });
      expect(pr.body.items.map((i) => [i.key, i.ok])).toEqual([
        ['edgar:MU', true],
        ['yahoo:000660.KS', true],
        ['domain:news.skhynix.com', true],
        ['domain:ir.example-memory.com', false],
      ]);
      expect(pr.body.items[3].why).toBe('目前抓不到（HTTP 403）');
      expect((await loadAccount(c.db))!.acct.own.NVDA.webSources ?? null).toBeNull();
      // 存檔：試抓一次，抓不到的仍存
      const saved = await c.call<{ preview: { sources: { changed: boolean; checked: { ok: boolean }[] } } }>('POST', '/api/ops/own-thesis', { ...base, webSources: ws }, new Date('2026-11-20T02:00:00Z'));
      expect(saved.status).toBe(200);
      expect(saved.body.preview.sources.changed).toBe(true);
      const meta = (await loadAccount(c.db))!.acct.own.NVDA;
      expect(meta.webSources).toMatchObject({ peers: ws.peers, domains: ws.domains, checked: { items: [{ key: 'edgar:MU', ok: true }, { ok: true }, { ok: true }, { key: 'domain:ir.example-memory.com', ok: false, why: '目前抓不到（HTTP 403）' }] } });
      const logRow = await c.db.prepare("SELECT body FROM own_thesis_log WHERE kind = 'THESIS' ORDER BY id DESC LIMIT 1").first<{ body: string }>();
      expect(JSON.parse(logRow!.body).webSources).toEqual({ peers: ws.peers, domains: ws.domains });
      // 持股頁資料帶著來源（編輯論點頁「現在的」那一欄）
      const hd = await c.call<{ own: { webSources: unknown } }>('GET', '/api/holding/NVDA');
      expect(hd.body.own.webSources).toMatchObject({ domains: ws.domains });
      // 沒送 webSources：來源不動
      await c.call('POST', '/api/ops/own-thesis', { ...base, thesis: '論點第二版' }, new Date('2026-11-20T02:10:00Z'));
      expect((await loadAccount(c.db))!.acct.own.NVDA.webSources?.domains).toEqual(ws.domains);
      // 不合格 → 422，什麼都不存
      const bad = await c.call<{ error: string }>('POST', '/api/ops/own-thesis', { ...base, thesis: '第三版', webSources: { peers: [], domains: ['fool.com'] } });
      expect(bad.status).toBe(422);
      expect(bad.body.error).toContain('fool.com 是不列入的網站');
      expect((await loadAccount(c.db))!.acct.own.NVDA.thesis?.text).toBe('論點第二版');
      // null = 拿掉
      const cleared = await c.call<{ preview: { sources: { cleared: boolean } } }>('POST', '/api/ops/own-thesis', { ...base, thesis: '論點第二版', webSources: null }, new Date('2026-11-20T02:20:00Z'));
      expect(cleared.body.preview.sources.cleared).toBe(true);
      expect((await loadAccount(c.db))!.acct.own.NVDA.webSources).toBeNull();
    });
  });

  it('存好的網域在審查時算這檔的一手網域（目錄與取文件都認）；取文件寫了 used_by 之後，每日流程清掉沒被用過、超過 180 天的快照全文', async () => {
    await withWorld(
      async (c) => {
        const r = await review(c);
        await fetchEvidence(c, r);
        const res = await docsCall(c, r, [{ menu: 'M5' }]);
        expect(res.body.docs[0]).toMatchObject({ kind: 'web', tier: 'PRIMARY', date: '2026-11-16' });
        expect(res.body.docs[0].title).toContain('〔網頁｜一手｜news.skhynix.com〕SK hynix Q3 results');
        // 清全文：沒被用過、抓了超過 180 天的清掉；被用過的留著
        await c.db.prepare("UPDATE web_docs SET fetched_at = '2026-01-01T00:00:00.000Z'").run();
        await c.db.prepare("INSERT INTO web_docs (id, url, ticker, via, fetched_at, status, text) VALUES ('web:old', 'https://www.trendforce.com/news/old', 'NVDA', 'SEARCH', '2026-01-01T00:00:00.000Z', 'OK', 'old text')").run();
        await c.run('2026-11-19', 'APPLY');
        const rows = (await c.db.prepare('SELECT id, used_by, text IS NOT NULL AS has FROM web_docs ORDER BY row_id').all<{ id: string; used_by: string | null; has: number }>()).results;
        expect(rows.map((x) => [x.used_by === r.runId, x.has])).toEqual([
          [true, 1],
          [false, 0],
        ]);
      },
      { acct: withSources },
    );
  });
});

void thesisFile;
