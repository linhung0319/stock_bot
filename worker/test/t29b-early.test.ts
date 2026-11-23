// T29b：提前審查、個股自身大跌（own_thesis_design_2026-11-15 §2.4、§2.5 的表、§2.8、§3.6.1）。
// 完成條件：
//   整條流程：下修財測的 8-K → 掃描標記 → 第二次排程提前開審查 → 三票減半 → 第三次排程當天通知
//   §2.4 表的六種情況各一個測試；L1 與 L0 合併計算 30 天上限、擋掉第二次；新聞標題標到的不開
//   PRICE_DROP 的門檻邊界、30 天內不重寫、和慢規則減半同一天不寫；自選股不再開 DROP_EXPLAIN；月審的行為不變
// 另外：提前審查的題目與 rule.detail、價格類的跌幅拆解、「要看的事」的 PRICE_NO_FILING、過期與已經不是自選股的事件。
// 對外請求全部是假的：價格、成分股（固定檔）、EDGAR、Nasdaq RSS、雲端排程、LINE。
import { describe, expect, it } from 'vitest';
import { attribution, IDIO_DROP, idioDrop, idioDropText } from '../src/ai/detect';
import { ownReviewPack } from '../src/ai/ownReview';
import type { StartCtx } from '../src/app/aiCtx';
import { listRuns, type AiRun } from '../src/app/aiRuns';
import { priceDrops, startDropRuns } from '../src/app/dropAi';
import type { Env, Fetcher } from '../src/app/env';
import { loadEvents, type FilingCheck } from '../src/app/filings';
import { runFlow } from '../src/app/flow';
import { LINE_PUSH_URL } from '../src/app/line';
import { loadAccount, saveAccount } from '../src/app/ledgerStore';
import { EARLY_GAP, EARLY_NO_FILING_ASK, monthlyWithin, startEarlyReviews } from '../src/app/ownAi';
import type { Attempt } from '../src/app/schedule';
import { EARLY_NOTE, dueAttention, ownAttention, thesisFile } from '../src/app/thesis';
import type { CompanyFacts, XbrlFact } from '../src/data/edgar';
import { buildMarketView } from '../src/data/marketView';
import { loadSeries } from '../src/data/store';
import { SYSTEM_DEFAULT_PREMISES, createAccount, type Account, type MarketView, type Notif } from '../src/engine';
import { handle } from '../src/index';
import { freshDb } from './helpers/d1';
import { fakeFetcher, newWorld, type World } from './helpers/fakeSources';

// ---------------------------------------------------------------- 假的 EDGAR、新聞、雲端排程、LINE（和 t28 相同的做法）

interface FakeFiling {
  accession: string;
  form: string;
  items: string;
  acceptanceDateTime: string;
  filingDate: string;
  primaryDocument: string;
  html: string;
}
interface Net {
  filings: FakeFiling[];
  news: { at: string; title: string }[];
  line: string[];
}

/** 季度營收（XBRL 抓得到，審查不會因為資料缺漏而不能採用）。 */
function quarterFacts(qs: { end: string; rev: number; filed: string }[]): CompanyFacts {
  const rev: XbrlFact[] = qs.map((q) => {
    const [y, m] = q.end.split('-').map(Number);
    return { start: `${y}-${String(m - 2).padStart(2, '0')}-01`, end: q.end, val: q.rev, accn: `acc-${q.filed}`, form: '10-Q', filed: q.filed };
  });
  return { cik: 1045810, facts: { 'us-gaap': { Revenues: { units: { USD: rev } } } } };
}
const FACTS = quarterFacts([
  { end: '2025-06-30', rev: 110, filed: '2025-08-01' },
  { end: '2025-09-30', rev: 120, filed: '2025-11-01' },
  { end: '2026-06-30', rev: 150, filed: '2026-08-01' },
  { end: '2026-09-30', rev: 160, filed: '2026-10-30' },
]);

function fetcherOf(w: World, net: Net): Fetcher {
  const base = fakeFetcher(w);
  return async (url, init) => {
    if (url === LINE_PUSH_URL) {
      net.line.push((JSON.parse(String(init?.body)) as { messages: { text: string }[] }).messages[0].text);
      return Response.json({});
    }
    if (url === 'https://api.example/fire') return Response.json({ claude_code_session_url: 'https://claude.ai/code/x' });
    const sub = /data\.sec\.gov\/submissions\/CIK(\d+)\.json/.exec(url);
    if (sub) {
      const fs = Number(sub[1]) === 1045810 ? [...net.filings].sort((a, b) => b.acceptanceDateTime.localeCompare(a.acceptanceDateTime)) : [];
      return Response.json({ cik: sub[1], name: 'NVIDIA CORP', tickers: [], sic: '3674', formerNames: [], filings: { recent: { accessionNumber: fs.map((f) => f.accession), form: fs.map((f) => f.form), items: fs.map((f) => f.items), acceptanceDateTime: fs.map((f) => f.acceptanceDateTime), filingDate: fs.map((f) => f.filingDate), primaryDocument: fs.map((f) => f.primaryDocument) } } });
    }
    if (/companyfacts\/CIK\d+\.json/.test(url)) return Response.json(FACTS);
    if (/companyconcept\//.test(url)) return new Response('nf', { status: 404 });
    const doc = /Archives\/edgar\/data\/\d+\/(\d+)\/(.+)$/.exec(url);
    if (doc) {
      const f = net.filings.find((x) => x.accession.replace(/-/g, '') === doc[1]);
      if (!f) return new Response('nf', { status: 404 });
      if (doc[2] === 'index.json') return Response.json({ directory: { item: [{ name: f.primaryDocument }] } });
      return new Response(f.html);
    }
    if (/nasdaq\.com\/feed\/rssoutbound\?symbol=NVDA/.test(url)) {
      const items = net.news.map((h) => `<item><title>${h.title}</title><link>https://n/${encodeURIComponent(h.title)}</link><pubDate>${new Date(h.at).toUTCString()}</pubDate></item>`);
      return new Response(`<rss><channel>${items.join('')}</channel></rss>`);
    }
    if (url.startsWith('https://www.nasdaq.com/feed/rssoutbound')) return new Response('<rss><channel></channel></rss>');
    return base(url, init);
  };
}

/** 各排程的時間：23:30 收盤後、兩小時後 01:30、再兩小時後 03:30（UTC）。 */
const slotTime = (date: string, attempt: Attempt) => new Date(Date.parse(date + 'T23:30:00Z') + { FIRST: 0, MANUAL: 0, FINAL: 2, APPLY: 4 }[attempt] * 3600_000);

interface Ctx {
  db: D1Database;
  env: Env;
  net: Net;
  fetcher: Fetcher;
  run: (date: string, attempt?: Attempt) => ReturnType<typeof runFlow>;
  viewAt: (date: string) => Promise<{ view: MarketView; axis: string[] }>;
}

const TENQ: FakeFiling = { accession: '0001045810-26-000300', form: '10-Q', items: '', acceptanceDateTime: '2026-10-30T20:10:00.000Z', filingDate: '2026-10-30', primaryDocument: 'q.htm', html: '<p>10-Q</p>' };

async function withWorld(fn: (c: Ctx) => Promise<void>) {
  const d = await freshDb();
  try {
    const db = d.db;
    const w = newWorld('2026-11-19');
    const net: Net = { filings: [TENQ], news: [], line: [] };
    const env: Env = { DB: db, ADMIN_TOKEN: 't', AI_TASK_SECRET: 's', EDGAR_USER_AGENT: 'test bot test@example.com', SITE_URL: 'https://bot.example', LINE_CHANNEL_TOKEN: 'lt', LINE_USER_ID: 'U1', ROUTINE_FIRE_URL: 'https://api.example/fire', ROUTINE_TOKEN: 'rt' };
    const fetcher = fetcherOf(w, net);
    const run = (date: string, attempt: Attempt = 'FIRST') => {
      if (attempt !== 'APPLY') w.dataDate = date;
      return runFlow(env, fetcher, { now: slotTime(date, attempt), attempt });
    };
    const viewAt = async (date: string) => buildMarketView(await loadSeries(db, ['VOO', 'SGOV', 'NVDA']), date, 'VOO');
    await run('2026-11-19');
    const { view } = await viewAt('2026-11-19');
    const acct = createAccount(
      {
        paper: true,
        cash: 5000,
        core: { VOO: Math.floor(140_000 / view.close.VOO[view.i]) },
        own: {
          NVDA: {
            shares: Math.floor(40_000 / view.close.NVDA[view.i]),
            stdWeight: 0.15,
            premises: [
              { id: 'P1', text: '資料中心需求延續到 2027', origin: 'USER' },
              { id: 'P2', text: '毛利率維持在 65% 以上', origin: 'USER' },
            ],
          },
        },
      },
      view,
    );
    await saveAccount(db, acct, null, '建立帳戶', new Date('2026-11-19T12:00:00Z'));
    await fn({ db, env, net, fetcher, run, viewAt });
  } finally {
    await d.dispose();
  }
}

// ---------------------------------------------------------------- 小工具

const acctOf = async (db: D1Database): Promise<Account> => (await loadAccount(db))!.acct;
/** NVDA 改成只有系統預設前提（T54：個股自身大跌、沒有新申報時只有這種照舊不開）。 */
async function defaultOnly(db: D1Database): Promise<void> {
  const loaded = (await loadAccount(db))!;
  const a = structuredClone(loaded.acct);
  a.own.NVDA.premises = structuredClone(SYSTEM_DEFAULT_PREMISES);
  await saveAccount(db, a, loaded, 'test', new Date('2026-11-19T12:30:00Z'));
}

/** 直接呼叫開執行的函式用的 StartCtx（session 可以和 view 的日子不同：只看日期判斷的情況用）。 */
async function startCtx(c: Ctx, session: string, o: { view?: { view: MarketView; axis: string[] }; checks?: FilingCheck[]; reduced?: { ticker: string; session: string }[] } = {}): Promise<StartCtx> {
  const { view, axis } = o.view ?? (await c.viewAt('2026-11-19'));
  return { env: c.env, fetcher: c.fetcher, acct: await acctOf(c.db), view, axis, session, ov: {}, now: new Date(`${session}T23:45:00Z`), checks: o.checks ?? [], res: { created: [], started: [], log: [], alerts: [] }, extras: { reduced: o.reduced ?? [] } };
}

interface EventSeed {
  ticker?: string;
  accession: string;
  form?: string;
  date: string;
  code: string;
  detailCode?: string | null;
  sub?: string;
  source?: string;
  status?: string;
  detail?: string | null;
  createdAt?: string;
}
async function addEvent(db: D1Database, o: EventSeed): Promise<number> {
  const r = await db
    .prepare('INSERT INTO sec_events (ticker, accession, form, event_date, accepted_at, code, sub, by_rule, display_only, source, detail, status, created_at, detail_code) VALUES (?, ?, ?, ?, NULL, ?, ?, 1, 0, ?, ?, ?, ?, ?) RETURNING id')
    .bind(o.ticker ?? 'NVDA', o.accession, o.form ?? '8-K', o.date, o.code, o.sub ?? `X_${o.code}`, o.source ?? 'EDGAR', o.detail ?? null, o.status ?? 'NEW', o.createdAt ?? `${o.date}T23:35:00.000Z`, o.detailCode ?? null)
    .first<{ id: number }>();
  return r!.id;
}
const CEO = (date: string, n = 401): EventSeed => ({ accession: `0001045810-26-000${n}`, date, code: 'MGMT_CHANGE', detailCode: 'CEO_DEPART', sub: '8K_5.02_CEO_DEPART', detail: '8-K Item 5.02：執行長離任（規則從原文判斷）' });
const PRICE = (date: string, detail = '最近 21 個交易日：個股 -18.2%，大盤（VOO）-5.1%，個股自身 -13.1%'): EventSeed => ({ accession: `price:NVDA:${date}`, form: 'RULE', date, code: 'PRICE_DROP', detailCode: 'IDIO_21D', sub: 'RULE_IDIO_21D', source: 'PRICE', detail });

/** 一次之前的執行（證據包用真的組法、沒有原文；applied_at 先填好，每日流程不會再套用它）。 */
async function addRun(c: Ctx, runId: string, fn: string, asOf: string, status: 'AGREED' | 'SPLIT' | null = 'AGREED') {
  const { view, axis } = await c.viewAt('2026-11-19');
  const pack = ownReviewPack({ acct: await acctOf(c.db), view: { ...view, date: asOf }, axis, ticker: 'NVDA', runId, trigger: 'MANUAL', xbrl: null, filings: [], news: null, dataQuality: {}, now: new Date(`${asOf}T23:40:00Z`) }).pack;
  const outcome = status ? JSON.stringify({ status, verdict: 'HOLD', votes: { HOLD: 3 }, samples: [] }) : null;
  await c.db
    .prepare("INSERT INTO ai_runs (run_id, fn, ticker, as_of, created_at, status, prompt_version, pack_hash, pack, outcome, applied_at) VALUES (?, ?, 'NVDA', ?, ?, ?, 'v1', 'h', ?, ?, ?)")
    .bind(runId, fn, asOf, `${asOf}T23:40:00.000Z`, status ? 'DONE' : 'PENDING', JSON.stringify({ ...pack, fn }), outcome, `${asOf}T23:41:00.000Z`)
    .run();
}
const eventById = async (db: D1Database, id: number) => (await loadEvents(db, { ticker: 'NVDA' })).concat(await loadEvents(db, { ticker: 'AAPL' })).find((e) => e.id === id)!;
const reviews = async (db: D1Database): Promise<AiRun[]> => (await listRuns(db, new Date('2026-11-01T00:00:00Z'), { limit: 500 })).filter((r) => r.fn === 'OWN_REVIEW');
const check = (all: { accession: string; form: string; filingDate: string; acceptedAt: string; items?: string[] }[]): FilingCheck[] => [{ ticker: 'NVDA', cik: '0001045810', names: [], sic: null, all: all.map((f) => ({ items: [], primaryDocument: 'x.htm', ...f })), fresh: [], latest: '' }];

/** 價格改過的 view：從 i - 21 到 i，個股漲跌 stock、核心 ETF 漲跌 market（產業 ETF 不在 view 裡 → 比核心 ETF）。 */
function shocked(v: { view: MarketView; axis: string[] }, stock: number, market: number): { view: MarketView; axis: string[] } {
  const { view } = v;
  const i = view.i;
  const nv = Array.from(view.close.NVDA);
  const vo = Array.from(view.close.VOO);
  nv[i] = nv[i - 21] * (1 + stock);
  vo[i] = vo[i - 21] * (1 + market);
  return { view: { ...view, close: { ...view.close, NVDA: nv, VOO: vo } }, axis: v.axis };
}

// ---------------------------------------------------------------- 整條流程

const CUT_TEXT = 'The Company lowered its full-year revenue outlook to $10 billion from $12 billion due to weaker data center demand';
const CUT_8K: FakeFiling = { accession: '0001045810-26-000521', form: '8-K', items: '8.01', acceptanceDateTime: '2026-11-20T21:10:00.000Z', filingDate: '2026-11-20', primaryDocument: 'cut.htm', html: `<html><body><p>Item 8.01 Other Events.</p><p>${CUT_TEXT}.</p></body></html>` };
const postResult = (env: Env, run: AiRun, samples: unknown[], at: Date) =>
  handle(new Request(`https://bot.example/ai/task/${run.taskId}/result`, { method: 'POST', headers: { Authorization: 'Bearer s' }, body: JSON.stringify({ task_id: run.taskId, kind: 'RUN', run_id: run.runId, samples }) }), env, async () => new Response('no net', { status: 599 }), at);

describe('整條流程', () => {
  it('下修財測的 8-K → 掃描標記 → 第二次排程提前開審查 → 三票減半 → 第三次排程當天通知；新聞標題標到的同一件事不開', async () => {
    await withWorld(async (c) => {
      // 之前看過的申報到 10-Q 為止（11-20 是週五：接下來 3 個交易日沒有月審）
      await c.db.prepare("INSERT INTO flow_state (key, value, updated_at) VALUES ('edgar:NVDA', ?, 'x')").bind(TENQ.acceptanceDateTime).run();
      c.net.filings.push(CUT_8K);
      c.net.news = [{ at: '2026-11-20T20:00:00Z', title: 'NVIDIA cuts outlook as data center demand slows' }];
      await c.run('2026-11-20');
      expect(await reviews(c.db)).toEqual([]);
      const scan = (await listRuns(c.db, new Date('2026-11-21T00:00:00Z'), { limit: 50 })).find((r) => r.fn === 'EVENT_SCAN')!;
      const news = scan.pack.documents.find((d) => d.kind === 'news')!.source_id;
      const flag = {
        run_id: scan.pack.run_id,
        verdict: 'FLAGGED',
        evidence: [],
        payload: {
          events: [
            { ticker: 'NVDA', class: 'GUIDANCE_CUT', sub: 'CUT', source_id: `edgar:${CUT_8K.accession}` },
            { ticker: 'NVDA', class: 'GUIDANCE_CUT', sub: 'CUT', source_id: news },
          ],
        },
      };
      expect((await postResult(c.env, scan, [flag], new Date('2026-11-20T23:50:00Z'))).status).toBe(200);

      // 01:30：套用掃描 → 申報標到的 NEW、新聞標到的 INFO → 同一次就開提前審查
      await c.run('2026-11-20', 'FINAL');
      const rs = await reviews(c.db);
      expect(rs).toHaveLength(1);
      const r = rs[0];
      expect(r.asOf).toBe('2026-11-20');
      expect(r.createdAt).toBe('2026-11-21T01:30:00.000Z');
      const evs = (await loadEvents(c.db, { ticker: 'NVDA' })).filter((e) => e.code === 'GUIDANCE_CUT');
      const filed = evs.find((e) => e.accession === `edgar:${CUT_8K.accession}`)!;
      const fromNews = evs.find((e) => e.accession === news)!;
      expect(filed).toMatchObject({ status: 'HANDLED', handled_note: `提前審查 ${r.runId}` });
      expect(fromNews).toMatchObject({ status: 'INFO', handled_note: null });
      expect(r.pack.rule.detail).toMatchObject({ trigger: 'EARLY', events: [filed.id] });
      expect(r.pack.question.startsWith('這次是提前審查，原因：2026-11-20 的 8-K：下修財測。')).toBe(true);
      const doc = r.pack.documents.find((d) => d.source_id === `edgar:${CUT_8K.accession}`)!;
      expect(doc.text).toContain(CUT_TEXT);
      expect((await acctOf(c.db)).own.NVDA.earlyReviewAt).toBe('2026-11-20');

      // 三票減半、P1 不成立、引用那份 8-K
      const v = {
        run_id: r.pack.run_id,
        verdict: 'HALF',
        model: 'claude-opus-5-5',
        premise_checks: [
          { premise_id: 'P1', status: 'BROKEN', evidence_ids: ['E1'] },
          { premise_id: 'P2', status: 'INSUFFICIENT', evidence_ids: [] },
        ],
        evidence: [{ id: 'E1', source_id: doc.source_id, date: doc.date, quote: CUT_TEXT, claim: '下修全年營收財測，資料中心需求轉弱' }],
        payload: { tier: 'HALF', condition_checks: [], proposed_conditions: [] },
        report: '公司下修財測，理由是資料中心需求轉弱。',
      };
      expect((await postResult(c.env, r, [v, v, v], new Date('2026-11-21T01:45:00Z'))).status).toBe(200);

      // 03:30：只套用 → 乙類當天通知
      const lineBefore = c.net.line.length;
      const apply = await c.run('2026-11-20', 'APPLY');
      const acct = await acctOf(c.db);
      const n = acct.notifs.find((x) => x.kind === 'URGENT' && x.title === 'NVDA：AI 審查認為你的前提不成立')!;
      expect(apply.created).toContain(n.id);
      expect(n.items[0]).toMatchObject({ f: 'F24', brk: { type: 'B', premiseId: 'P1' } });
      expect(n.items[0].why).toContain('依據：8-K 2026-11-20');
      expect(acct.own.NVDA.aiTier).toMatchObject({ tier: 'HALF', trigger: 'EARLY', premiseId: 'P1' });
      expect(acct.own.NVDA.aiNotifiedAt).toBe('2026-11-20');
      expect(c.net.line.slice(lineBefore).some((t) => t.includes('NVDA：AI 審查認為你的前提不成立'))).toBe(true);
    });
  });
});

// ---------------------------------------------------------------- §2.4 的表：六種情況

describe('§2.4 的表（照順序，第一個符合的決定）', () => {
  it('① 已經有一次審查的決策日 ≥ 事件日（含今天已經開的財報後審查）→ 不開，「已經在 <run_id> 的證據包裡」', async () => {
    await withWorld(async (c) => {
      // 今天（11-19）已經開了財報後的審查；事件日 11-18
      await addRun(c, 'rev-today', 'OWN_REVIEW', '2026-11-19', null);
      const a = await addEvent(c.db, CEO('2026-11-18'));
      const sc = await startCtx(c, '2026-11-19');
      await startEarlyReviews(sc);
      expect(await eventById(c.db, a)).toMatchObject({ status: 'HANDLED', handled_note: '已經在 rev-today 的證據包裡' });
      expect(sc.res.started).toEqual([]);
      // 決策日 11-19 ≥ 事件日 11-19（隔天才處理到的事件）也一樣
      const b = await addEvent(c.db, CEO('2026-11-19', 402));
      const sc2 = await startCtx(c, '2026-11-20');
      await startEarlyReviews(sc2);
      expect(await eventById(c.db, b)).toMatchObject({ status: 'HANDLED', handled_note: EARLY_NOTE.inPack('rev-today') });
      expect((await acctOf(c.db)).own.NVDA.earlyReviewAt ?? null).toBeNull();
    });
  });

  it('② 只限價格類：30 天內跑過減半檢視 → 不開，「30 天內已經做過減半檢視」；申報類的事件不受這一條影響', async () => {
    await withWorld(async (c) => {
      await addRun(c, 'drop-1', 'OWN_DROP', '2026-10-21', null);
      const p = await addEvent(c.db, PRICE('2026-11-19'));
      const sc = await startCtx(c, '2026-11-19');
      await startEarlyReviews(sc);
      expect(await eventById(c.db, p)).toMatchObject({ status: 'HANDLED', handled_note: '30 天內已經做過減半檢視' });
      expect(sc.res.started).toEqual([]);
      // 申報類照樣開
      const f = await addEvent(c.db, CEO('2026-11-19'));
      const sc2 = await startCtx(c, '2026-11-19');
      await startEarlyReviews(sc2);
      expect(sc2.res.started).toHaveLength(1);
      expect((await eventById(c.db, f)).handled_note).toBe(`提前審查 ${sc2.res.started[0]}`);
    });
  });

  it('③ 只限價格類：上次有結論的審查之後沒有新的申報或事件、只有系統預設前提 → 不開，「沒有新的申報可以檢查」，列進要看的事（發生後的第一份月報）；有新申報或還沒審過 → 開（T54：有論點的另見下一個測試）', async () => {
    await withWorld(async (c) => {
      await c.run('2026-11-20');
      const v20 = await c.viewAt('2026-11-20');
      // T54：只有系統預設前提的才照舊不開（有論點的改成開提前審查、請分析師上網找）
      await defaultOnly(c.db);
      await addRun(c, 'rev-1119', 'OWN_REVIEW', '2026-11-19');
      const p = await addEvent(c.db, PRICE('2026-11-20'));
      const old = check([{ accession: TENQ.accession, form: '10-Q', filingDate: '2026-10-30', acceptedAt: '2026-10-30T20:10:00.000Z' }]);
      const sc = await startCtx(c, '2026-11-20', { view: v20, checks: old });
      await startEarlyReviews(sc);
      expect(await eventById(c.db, p)).toMatchObject({ status: 'HANDLED', handled_note: '沒有新的申報可以檢查' });
      expect(sc.res.started).toEqual([]);
      // 要看的事：持股頁列出來；月報第一次列、之後不再列；那一份月報之後持股頁也不再列
      const acct = await acctOf(c.db);
      const file = (await thesisFile(c.db, acct, 'NVDA', '2026-11-20'))!;
      const hits = ownAttention([file], acct, v20.view).filter((h) => h.kind === 'PRICE_NO_FILING');
      expect(hits.map((h) => [h.text, h.since])).toEqual([['NVDA 最近 21 個交易日比大盤多跌 13.1%，沒有新的申報可以檢查。可以複製討論包到 claude.ai 討論', '2026-11-20']]);
      const first = dueAttention(hits, {}, '2026-11-30');
      expect(first.due).toHaveLength(1);
      expect(dueAttention(hits, first.shown, '2026-12-31').due).toEqual([]);
      const later = { ...acct, notifs: [...acct.notifs, { id: 999, kind: 'MONTHLY', date: '2026-11-30', items: [] } as unknown as Notif] };
      expect(ownAttention([file], later, v20.view).some((h) => h.kind === 'PRICE_NO_FILING')).toBe(false);

      // 有那次審查之後的 8-K → 開
      const p2 = await addEvent(c.db, { ...PRICE('2026-11-20'), accession: 'price:NVDA:2026-11-20b' });
      const fresh = check([{ accession: '0001045810-26-000530', form: '8-K', filingDate: '2026-11-20', acceptedAt: '2026-11-20T21:00:00.000Z' }, ...old[0].all]);
      const sc2 = await startCtx(c, '2026-11-20', { view: v20, checks: fresh });
      await startEarlyReviews(sc2);
      expect(sc2.res.started).toHaveLength(1);
      expect((await eventById(c.db, p2)).handled_note).toBe(`提前審查 ${sc2.res.started[0]}`);
    });
  });

  it('③ T54（web_evidence_design §1.7）：有論點的股票，大跌而且沒有新的申報或事件 → 照樣開提前審查，題目請分析師找清單內來源的消息、可以取文件；仍受 30 天上限與減半檢視那一條擋', async () => {
    await withWorld(async (c) => {
      await c.run('2026-11-20');
      const v20 = shocked(await c.viewAt('2026-11-20'), -0.2, -0.05);
      await addRun(c, 'rev-1119', 'OWN_REVIEW', '2026-11-19');
      const p = await addEvent(c.db, PRICE('2026-11-20'));
      const old = check([{ accession: TENQ.accession, form: '10-Q', filingDate: '2026-10-30', acceptedAt: '2026-10-30T20:10:00.000Z' }]);
      const sc = await startCtx(c, '2026-11-20', { view: v20, checks: old });
      await startEarlyReviews(sc);
      expect(sc.res.started).toHaveLength(1);
      const r = (await reviews(c.db)).find((x) => x.runId === sc.res.started[0])!;
      expect(await eventById(c.db, p)).toMatchObject({ status: 'HANDLED', handled_note: `提前審查 ${r.runId}` });
      expect(r.pack.question.startsWith(`這次是提前審查，原因：最近 21 個交易日個股自身跌 15.0%；${EARLY_NO_FILING_ASK}。`)).toBe(true);
      expect(EARLY_NO_FILING_ASK).toBe('沒有新的申報，請分析師找有沒有一手或產業研究機構網站的消息'); // T88：不再寫「清單內」
      expect(r.pack.rule.detail).toMatchObject({ trigger: 'EARLY', events: [p] });
      // 分析師可以取文件：證據包有清單內的網頁來源（S），doc_ctx 沒有被關掉
      expect(r.pack.facts.some((f) => /^S\d+$/.test(f.id))).toBe(true);
      const ctx = await c.db.prepare('SELECT doc_ctx FROM ai_runs WHERE run_id = ?').bind(r.runId).first<{ doc_ctx: string | null }>();
      expect(JSON.parse(ctx!.doc_ctx!).off ?? null).toBeNull();
      expect((await acctOf(c.db)).own.NVDA.earlyReviewAt).toBe('2026-11-20');
      // 不列進要看的事（PRICE_NO_FILING 只給只有預設前提的）
      const acct = await acctOf(c.db);
      expect(ownAttention([(await thesisFile(c.db, acct, 'NVDA', '2026-11-20'))!], acct, v20.view).some((h) => h.kind === 'PRICE_NO_FILING')).toBe(false);
      // 同一個 30 天上限：12-10 再大跌（一樣沒有新申報）→ 擋下
      const p2 = await addEvent(c.db, { ...PRICE('2026-12-10'), accession: 'price:NVDA:2026-12-10' });
      const sc2 = await startCtx(c, '2026-12-10', { view: v20, checks: old });
      await startEarlyReviews(sc2);
      expect(sc2.res.started).toEqual([]);
      expect(await eventById(c.db, p2)).toMatchObject({ status: 'HANDLED', handled_note: EARLY_NOTE.recent });
      // 30 天內跑過減半檢視 → 照舊不開
      await addRun(c, 'drop-1', 'OWN_DROP', '2026-12-28', null);
      const p3 = await addEvent(c.db, { ...PRICE('2026-12-30'), accession: 'price:NVDA:2026-12-30' });
      const sc3 = await startCtx(c, '2026-12-30', { view: v20, checks: old });
      await startEarlyReviews(sc3);
      expect(sc3.res.started).toEqual([]);
      expect(await eventById(c.db, p3)).toMatchObject({ status: 'HANDLED', handled_note: EARLY_NOTE.dropReview });
    });
  });

  it('③ 還沒有過有結論的審查（NEVER）的價格類照開；題目寫個股自身跌多少、證據包有 A1～A5 跌幅拆解、rule.detail 記事件編號', async () => {
    await withWorld(async (c) => {
      const v = shocked(await c.viewAt('2026-11-19'), -0.2, -0.05);
      const p = await addEvent(c.db, PRICE('2026-11-19'));
      const sc = await startCtx(c, '2026-11-19', { view: v });
      await startEarlyReviews(sc);
      const [r] = await reviews(c.db);
      expect(sc.res.started).toEqual([r.runId]);
      expect(r.pack.question.startsWith('這次是提前審查，原因：最近 21 個交易日個股自身跌 15.0%。')).toBe(true);
      expect(r.pack.facts.filter((f) => /^A\d$/.test(f.id)).map((f) => f.id)).toEqual(['A1', 'A2', 'A3', 'A5']);
      expect(r.pack.facts.find((f) => f.id === 'A5')!.value).toBe('-15.0%');
      expect(r.pack.rule.detail).toMatchObject({ trigger: 'EARLY', events: [p] });
    });
  });

  it('④ 月審在接下來 3 個交易日內 → 不開，「留給月審」', async () => {
    await withWorld(async (c) => {
      // 11 月的月報是 11-30，月底檢查點是 11-27（11-26 感恩節休市）
      expect(monthlyWithin('2026-11-24', {})).toBe(true); // 11-25、11-27
      expect(monthlyWithin('2026-11-20', {})).toBe(false); // 11-23、11-24、11-25
      expect(monthlyWithin('2026-11-27', {})).toBe(false); // 今天就是檢查點（每日第一次流程已經做過）
      const a = await addEvent(c.db, CEO('2026-11-24'));
      const sc = await startCtx(c, '2026-11-24');
      await startEarlyReviews(sc);
      expect(await eventById(c.db, a)).toMatchObject({ status: 'HANDLED', handled_note: '留給月審' });
      expect(sc.res.started).toEqual([]);
    });
  });

  it('⑤ 30 天內提前開過 → 不開，「30 天內已經提前審查過，留給下一次審查」；滿 30 天就可以再開', async () => {
    await withWorld(async (c) => {
      const acct = await acctOf(c.db);
      acct.own.NVDA.earlyReviewAt = '2026-10-21';
      await saveAccount(c.db, acct, (await loadAccount(c.db))!, 'test', new Date('2026-11-19T13:00:00Z'));
      const a = await addEvent(c.db, CEO('2026-11-19'));
      const sc = await startCtx(c, '2026-11-19');
      await startEarlyReviews(sc);
      expect(await eventById(c.db, a)).toMatchObject({ status: 'HANDLED', handled_note: '30 天內已經提前審查過，留給下一次審查' });
      expect(sc.res.started).toEqual([]);
      // 10-20 → 11-19 滿 30 天
      const acct2 = await acctOf(c.db);
      acct2.own.NVDA.earlyReviewAt = '2026-10-20';
      await saveAccount(c.db, acct2, (await loadAccount(c.db))!, 'test', new Date('2026-11-19T13:01:00Z'));
      const b = await addEvent(c.db, CEO('2026-11-19', 402));
      const sc2 = await startCtx(c, '2026-11-19');
      await startEarlyReviews(sc2);
      expect(sc2.res.started).toHaveLength(1);
      expect((await eventById(c.db, b)).handled_note).toBe(`提前審查 ${sc2.res.started[0]}`);
      expect(EARLY_GAP).toBe(30);
    });
  });

  it('⑥ 其餘 → 開一次審查（觸發原因 EARLY），同一檔的事件併成一次（規則與掃描標到同一份申報只算一次），earlyReviewAt 記今天', async () => {
    await withWorld(async (c) => {
      const rule = await addEvent(c.db, CEO('2026-11-18'));
      const scan = await addEvent(c.db, { ...CEO('2026-11-18'), accession: 'edgar:0001045810-26-000401', sub: 'SCAN_MGMT_CHANGE', source: 'SCAN', detail: '每日掃描標記：MGMT_CHANGE（CEO_DEPART）' });
      const hint = await addEvent(c.db, { accession: 'edgar:0001045810-26-000402', date: '2026-11-19', code: 'CONDITION_HINT', detailCode: '7', sub: 'SCAN_CONDITION_HINT_7', source: 'SCAN', detail: '每日掃描：可能和觀察項 W1 最大客戶取消訂單有關（申報原文，下一次審查由三票判斷成不成立）' });
      const sc = await startCtx(c, '2026-11-19');
      await startEarlyReviews(sc);
      const rs = await reviews(c.db);
      expect(rs).toHaveLength(1);
      const r = rs[0];
      expect(r.pack.rule.detail).toMatchObject({ trigger: 'EARLY', events: expect.arrayContaining([rule, scan, hint]) });
      expect(r.pack.question).toContain('這次是提前審查，原因：2026-11-18 的 8-K：執行長離任；2026-11-19 的 8-K：每日掃描：可能和觀察項 W1 最大客戶取消訂單有關（申報原文，下一次審查由三票判斷成不成立）。');
      for (const id of [rule, scan, hint]) expect(await eventById(c.db, id)).toMatchObject({ status: 'HANDLED', handled_note: `提前審查 ${r.runId}` });
      expect((await acctOf(c.db)).own.NVDA.earlyReviewAt).toBe('2026-11-19');
      expect(sc.res.log.join('\n')).toContain(`NVDA 提前審查 ${r.runId}`);
    });
  });
});

// ---------------------------------------------------------------- 頻率上限、新聞、過期

describe('頻率上限與不開的事件', () => {
  it('L1 與 L0 合併計算 30 天上限：申報事件開過提前審查之後，個股自身大跌擋掉第二次', async () => {
    await withWorld(async (c) => {
      await addEvent(c.db, CEO('2026-11-19'));
      const sc = await startCtx(c, '2026-11-19');
      await startEarlyReviews(sc);
      expect(sc.res.started).toHaveLength(1);
      expect((await acctOf(c.db)).own.NVDA.earlyReviewAt).toBe('2026-11-19');
      // 12-01 個股自身大跌（沒有減半檢視、還沒有有結論的審查、月審不在 3 個交易日內）→ 只剩頻率上限擋下
      const p = await addEvent(c.db, PRICE('2026-12-01'));
      const sc2 = await startCtx(c, '2026-12-01');
      await startEarlyReviews(sc2);
      expect(await eventById(c.db, p)).toMatchObject({ status: 'HANDLED', handled_note: EARLY_NOTE.recent });
      expect(sc2.res.started).toEqual([]);
      expect(await reviews(c.db)).toHaveLength(1);
    });
  });

  it('新聞標題標到的不開（寫入時就是 INFO；萬一是 NEW 也只標已處理）；事件日超過 10 天的標過期；已經不是自選股的不開', async () => {
    await withWorld(async (c) => {
      const info = await addEvent(c.db, { accession: 'nasdaq-rss:NVDA:2026-11-19', form: 'NEWS', date: '2026-11-19', code: 'GUIDANCE_CUT', detailCode: 'CUT', sub: 'SCAN_GUIDANCE_CUT', source: 'SCAN', status: 'INFO' });
      const news = await addEvent(c.db, { accession: 'nasdaq-rss:NVDA:2026-11-18', form: 'NEWS', date: '2026-11-18', code: 'GUIDANCE_CUT', detailCode: 'CUT', sub: 'SCAN_GUIDANCE_CUT', source: 'SCAN' });
      const stale = await addEvent(c.db, CEO('2026-11-08'));
      const other = await addEvent(c.db, { ...CEO('2026-11-19'), ticker: 'AAPL', accession: '0000320193-26-000401' });
      // 不可提前的細項（董事異動）不是候選
      const dir = await addEvent(c.db, { ...CEO('2026-11-19', 403), detailCode: 'DIRECTOR' });
      const sc = await startCtx(c, '2026-11-19');
      await startEarlyReviews(sc);
      expect(sc.res.started).toEqual([]);
      expect(await eventById(c.db, info)).toMatchObject({ status: 'INFO' });
      expect(await eventById(c.db, news)).toMatchObject({ status: 'HANDLED', handled_note: '新聞標題標到的，只記進論點檔' });
      expect(await eventById(c.db, stale)).toMatchObject({ status: 'HANDLED', handled_note: '過期：事件日超過 10 天沒有處理' });
      expect(await eventById(c.db, other)).toMatchObject({ status: 'HANDLED', handled_note: '已經不是自選股，不提前審查' });
      expect(await eventById(c.db, dir)).toMatchObject({ status: 'NEW' });
    });
  });
});

// ---------------------------------------------------------------- 個股自身大跌（PRICE_DROP）

describe('個股自身大跌（own_thesis §3.6.1）', () => {
  it('門檻邊界：個股 ≤ -10% 而且比產業（沒有時比核心 ETF）多跌 ≥ 10 個百分點；資料不足不成立', () => {
    const axis = Array.from({ length: 30 }, (_, k) => `d${k}`);
    const flat = (end: number) => Array.from({ length: 30 }, (_, k) => (k === 29 ? end : 100));
    const at = (stock: number, market: number, sector?: number) => idioDrop(axis, { S: flat(stock), M: flat(market), ...(sector === undefined ? {} : { E: flat(sector) }) }, 'S', 'M', sector === undefined ? null : 'E', 29);
    expect(IDIO_DROP).toEqual({ days: 21, stock: -0.1, idio: -0.1 });
    expect(at(90, 100)!.hit).toBe(true); // 剛好 -10%、自身 -10%
    expect(at(90.1, 100)!.hit).toBe(false); // -9.9%
    expect(at(88, 103)!.hit).toBe(true); // 自身 -15%
    expect(at(88, 97)!.hit).toBe(false); // 自身 -9%
    expect(at(80, 105, 92)!.hit).toBe(true); // 個股 -20%、產業 -8% → 自身 -12%
    expect(at(80, 105, 92)!.attr.idio).toBeCloseTo(-0.12);
    expect(at(80, 105, 92)!.attr.sectorTicker).toBe('E');
    expect(at(85, 80, 95)!.hit).toBe(true); // 比產業多跌 10 個百分點（大盤怎麼走不管）
    expect(at(85, 80, 94)!.hit).toBe(false); // 比產業只多跌 9
    expect(idioDrop(axis, { S: flat(80), M: flat(100) }, 'S', 'M', null, 20)).toBeNull(); // 不到 21 天
    expect(idioDrop(axis, { S: flat(80) }, 'S', 'M', null, 29)).toBeNull(); // 核心 ETF 沒有價格
    const a = attribution(axis, { S: flat(81.8), M: flat(100), E: flat(94.9) }, 'S', 'M', 'E', 8, 29)!;
    expect(idioDropText(a, 'M')).toBe('最近 21 個交易日：個股 -18.2%，產業（E）-5.1%，個股自身 -13.1%');
  });

  it('寫一筆 PRICE_DROP（source PRICE、NEW）；30 天內不重寫；和慢規則減半同一天不寫；自選股不再開 DROP_EXPLAIN', async () => {
    await withWorld(async (c) => {
      const v = shocked(await c.viewAt('2026-11-19'), -0.25, 0);
      // 和慢規則減半同一天：不寫
      const sc0 = await startCtx(c, '2026-11-19', { view: v, reduced: [{ ticker: 'NVDA', session: '2026-11-19' }] });
      await priceDrops(sc0, {});
      expect((await loadEvents(c.db, { ticker: 'NVDA' })).filter((e) => e.code === 'PRICE_DROP')).toEqual([]);
      expect(sc0.res.log.join('\n')).toContain('同一天慢規則觸發減半');
      // 一般的一天：startDropRuns 寫一筆，不開 F20（跌 25% 也不開）
      const sc = await startCtx(c, '2026-11-19', { view: v });
      await startDropRuns(sc);
      const rows = (await loadEvents(c.db, { ticker: 'NVDA' })).filter((e) => e.code === 'PRICE_DROP');
      expect(rows.map((e) => ({ accession: e.accession, form: e.form, source: e.source, code: e.code, detail_code: e.detail_code, sub: e.sub, by_rule: e.by_rule, display_only: e.display_only, status: e.status, event_date: e.event_date }))).toEqual([
        { accession: 'price:NVDA:2026-11-19', form: 'RULE', source: 'PRICE', code: 'PRICE_DROP', detail_code: 'IDIO_21D', sub: 'RULE_IDIO_21D', by_rule: 1, display_only: 0, status: 'NEW', event_date: '2026-11-19' },
      ]);
      expect(rows[0].detail).toBe('最近 21 個交易日：個股 -25.0%，大盤（VOO）0.0%，個股自身 -25.0%');
      expect((await listRuns(c.db, new Date('2026-11-01T00:00:00Z'), { limit: 100 })).filter((r) => r.fn === 'DROP_EXPLAIN')).toEqual([]);
      // 29 天後不重寫；滿 30 天才寫
      await priceDrops(await startCtx(c, '2026-12-18', { view: v }), {});
      expect((await loadEvents(c.db, { ticker: 'NVDA' })).filter((e) => e.code === 'PRICE_DROP')).toHaveLength(1);
      await priceDrops(await startCtx(c, '2026-12-19', { view: v }), {});
      expect((await loadEvents(c.db, { ticker: 'NVDA' })).filter((e) => e.code === 'PRICE_DROP').map((e) => e.accession)).toEqual(['price:NVDA:2026-12-19', 'price:NVDA:2026-11-19']);
      // 沒有大跌：不寫
      const quiet = await startCtx(c, '2027-02-01', { view: shocked(await c.viewAt('2026-11-19'), -0.09, 0) });
      await priceDrops(quiet, {});
      expect((await loadEvents(c.db, { ticker: 'NVDA' })).filter((e) => e.code === 'PRICE_DROP')).toHaveLength(2);
    });
  });
});

// ---------------------------------------------------------------- 月審的行為不變

describe('月審的行為不變', () => {
  it('留給月審的事件：月底檢查點把它當成新證據（EVENT）照常開月審，觸發原因 MONTHLY，不占提前審查的額度', async () => {
    await withWorld(async (c) => {
      for (const d of ['2026-11-20', '2026-11-23']) await c.run(d);
      // 11-19 有一次有結論的審查；11-24 規則記下執行長離任 → 月審在 3 個交易日內 → 留給月審
      await addRun(c, 'rev-1119', 'OWN_REVIEW', '2026-11-19');
      await c.run('2026-11-24');
      const id = await addEvent(c.db, { ...CEO('2026-11-24'), createdAt: '2026-11-24T23:31:00.000Z' });
      const sc = await startCtx(c, '2026-11-24', { view: await c.viewAt('2026-11-24') });
      await startEarlyReviews(sc);
      expect(await eventById(c.db, id)).toMatchObject({ status: 'HANDLED', handled_note: '留給月審' });
      await c.run('2026-11-25');
      expect((await reviews(c.db)).filter((r) => r.runId !== 'rev-1119')).toEqual([]);
      // 11-27 = 月報前一天：有新證據（事件）→ 月審
      await c.run('2026-11-27');
      const monthly = (await reviews(c.db)).filter((r) => r.runId !== 'rev-1119');
      expect(monthly).toHaveLength(1);
      expect(monthly[0].asOf).toBe('2026-11-27');
      expect(monthly[0].pack.rule.detail).toMatchObject({ trigger: 'MONTHLY', reasons: ['EVENT'] });
      expect((monthly[0].pack.rule.detail as { events?: unknown }).events).toBeUndefined();
      expect(monthly[0].pack.question.startsWith('這次是提前審查')).toBe(false);
      expect((await acctOf(c.db)).own.NVDA.earlyReviewAt ?? null).toBeNull();
    });
  });
});
