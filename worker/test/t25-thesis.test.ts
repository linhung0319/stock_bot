// T25：論點檔與證據包（own_thesis §1.2～§1.4、§1.6 證據包、§1.12、§3.3 證據包、§3.8）。
// 完成條件：
//   兩次審查之間的 5.02 8-K → 下一次 F24 的證據包有那份原文（source_id）與 V 標記
//   8-K 多於 5 份時的順序（最新的 2.02、有標記的、其餘）
//   F7 的證據包除了新增的部分和改之前相同
//   移出再加回同一檔 → 新的 fileId，舊條件不被讀到
//   復原快照 → fileId 與條件接回來、那一版寫的 log 不見
//   加前提不重排編號
//   只有預設前提的股票有 D1～D3、沒有原本的第四條
// 對外請求全部是假的：價格、成分股（固定檔）、EDGAR、Nasdaq RSS、雲端排程、LINE。
import { describe, expect, it } from 'vitest';
import type { EvidencePack, PackDoc } from '../src/ai/check';
import { attribution, highIndex } from '../src/ai/detect';
import { ownDropPack } from '../src/ai/drops';
import { finalizeRun, getRun, listRuns } from '../src/app/aiRuns';
import type { Env, Fetcher } from '../src/app/env';
import { runFlow, type Attempt } from '../src/app/flow';
import { LINE_PUSH_URL } from '../src/app/line';
import { loadAccount, saveAccount, saveSnapshotUndo, undoSnapshot } from '../src/app/ledgerStore';
import { startOwnReview } from '../src/app/ownAi';
import { defaultFacts, fileConditions, loadConditions, pickFilings, thesisFile, type ThesisFile } from '../src/app/thesis';
import type { CompanyFacts, QuarterRow, XbrlFact } from '../src/data/edgar';
import { buildMarketView } from '../src/data/marketView';
import { loadSeries } from '../src/data/store';
import { SYSTEM_DEFAULT_PREMISES, addOwn, addPremises, applySnapshot, createAccount, newOwnMeta, priceOf, type Account, type MarketView } from '../src/engine';
import { freshDb } from './helpers/d1';
import { cronTime, fakeFetcher, newWorld, type World } from './helpers/fakeSources';

// ---------------------------------------------------------------- 假的 EDGAR（一家公司）

function quarterFacts(qs: { end: string; rev: number; eps?: number; filed: string }[]): CompanyFacts {
  const rev: XbrlFact[] = [];
  const eps: XbrlFact[] = [];
  for (const q of qs) {
    const [y, m] = q.end.split('-').map(Number);
    const start = `${y}-${String(m - 2).padStart(2, '0')}-01`;
    const f = { accn: `acc-${q.filed}`, form: '10-Q', filed: q.filed };
    rev.push({ start, end: q.end, val: q.rev, ...f });
    if (q.eps !== undefined) eps.push({ start, end: q.end, val: q.eps, ...f });
  }
  return { cik: 1045810, facts: { 'us-gaap': { Revenues: { units: { USD: rev } }, EarningsPerShareDiluted: { units: { 'USD/shares': eps } } } } };
}

const BASE = quarterFacts([
  { end: '2025-06-30', rev: 110, filed: '2025-08-01' },
  { end: '2025-09-30', rev: 120, filed: '2025-11-01' },
  { end: '2026-06-30', rev: 150, filed: '2026-08-01' },
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
interface Edgar {
  filings: FakeFiling[];
  facts: CompanyFacts;
  fired: string[];
}

function fetcherOf(w: World, e: Edgar): Fetcher {
  const base = fakeFetcher(w);
  return async (url, init) => {
    if (url === LINE_PUSH_URL) return Response.json({});
    if (url === 'https://api.example/fire') {
      e.fired.push(String(init?.body));
      return Response.json({ claude_code_session_url: 'https://claude.ai/code/x' });
    }
    if (/data\.sec\.gov\/submissions\/CIK\d+\.json/.test(url)) {
      const fs = [...e.filings].sort((a, b) => b.acceptanceDateTime.localeCompare(a.acceptanceDateTime));
      return Response.json({ cik: '1045810', name: 'NVIDIA CORP', tickers: ['NVDA'], filings: { recent: { accessionNumber: fs.map((f) => f.accession), form: fs.map((f) => f.form), items: fs.map((f) => f.items), acceptanceDateTime: fs.map((f) => f.acceptanceDateTime), filingDate: fs.map((f) => f.filingDate), primaryDocument: fs.map((f) => f.primaryDocument) } } });
    }
    if (/companyfacts\/CIK\d+\.json/.test(url)) return Response.json(e.facts);
    const doc = /Archives\/edgar\/data\/\d+\/(\d+)\/(.+)$/.exec(url);
    if (doc) {
      const f = e.filings.find((x) => x.accession.replace(/-/g, '') === doc[1]);
      if (!f) return new Response('nf', { status: 404 });
      if (doc[2] === 'index.json') return Response.json({ directory: { item: [{ name: f.primaryDocument }] } });
      return new Response(f.html);
    }
    if (url.startsWith('https://www.nasdaq.com/feed/rssoutbound')) return new Response('<rss><channel></channel></rss>');
    return base(url, init);
  };
}

const TENQ = `<html><body><p>Item 2. Management’s Discussion and Analysis of Financial Condition and Results of Operations</p><p>Revenue for the third quarter was $160 million, up 33% from a year ago. Gross margin was 60.0%, down from 70.0% a year ago.</p><p>Item 3. Quantitative and Qualitative Disclosures About Market Risk</p></body></html>`;
const TENQ_FILING: FakeFiling = { accession: '0001045810-26-000300', form: '10-Q', items: '', acceptanceDateTime: '2026-10-30T20:10:00.000Z', filingDate: '2026-10-30', primaryDocument: 'q.htm', html: TENQ };
const eightK = (n: number, date: string, items: string, body: string): FakeFiling => ({
  accession: `0001045810-26-${String(n).padStart(6, '0')}`,
  form: '8-K',
  items,
  acceptanceDateTime: `${date}T21:00:00.000Z`,
  filingDate: date,
  primaryDocument: `k${n}.htm`,
  html: `<html><body><p>Item ${items.split(',')[0]} ${body}</p></body></html>`,
});
const EIGHTK_502 = eightK(501, '2026-12-01', '5.02', 'Departure of Directors or Certain Officers. On December 1, 2026, the Chief Financial Officer informed the Company of her resignation, effective December 31, 2026.');

interface Ctx {
  db: D1Database;
  w: World;
  e: Edgar;
  env: Env;
  fetcher: Fetcher;
  run: (date: string, attempt?: Attempt) => ReturnType<typeof runFlow>;
  viewAt: (date: string, extra?: string[]) => Promise<{ view: MarketView; axis: string[] }>;
}

const USER_PREMISES = [
  { id: 'P1', text: '資料中心需求延續到 2027', origin: 'USER' as const },
  { id: 'P2', text: '毛利率維持在 65% 以上', origin: 'USER' as const },
];

async function withWorld(fn: (c: Ctx) => Promise<void>, opt: { defaults?: boolean; filings?: FakeFiling[]; acct?: (a: Account) => Account } = {}) {
  const d = await freshDb();
  try {
    const db = d.db;
    const w = newWorld('2026-11-19');
    const e: Edgar = { filings: opt.filings ?? [TENQ_FILING], facts: BASE, fired: [] };
    const env: Env = { DB: db, ADMIN_TOKEN: 't', AI_TASK_SECRET: 's', EDGAR_USER_AGENT: 'test bot test@example.com', SITE_URL: 'https://bot.example', LINE_CHANNEL_TOKEN: 'lt', LINE_USER_ID: 'U1', ROUTINE_FIRE_URL: 'https://api.example/fire', ROUTINE_TOKEN: 'rt' };
    const fetcher = fetcherOf(w, e);
    const run = (date: string, attempt: Attempt = 'FIRST') => {
      w.dataDate = date;
      return runFlow(env, fetcher, { now: attempt === 'FINAL' ? new Date(Date.parse(date + 'T23:30:00Z') + 2 * 3600_000) : cronTime(date), attempt });
    };
    const viewAt = async (date: string, extra: string[] = []) => buildMarketView(await loadSeries(db, ['VOO', 'SGOV', 'NVDA', ...extra]), date, 'VOO');
    await run('2026-11-19');
    const { view } = await viewAt('2026-11-19');
    let acct = createAccount(
      {
        paper: true,
        cash: 5000,
        core: { VOO: Math.floor(140_000 / view.close.VOO[view.i]) },
        own: { NVDA: { shares: Math.floor(40_000 / view.close.NVDA[view.i]), stdWeight: 0.15, ...(opt.defaults ? {} : { premises: structuredClone(USER_PREMISES) }) } },
      },
      view,
    );
    if (opt.acct) acct = opt.acct(acct);
    await saveAccount(db, acct, null, '建立帳戶', new Date('2026-11-19T12:00:00Z'));
    await fn({ db, w, e, env, fetcher, run, viewAt });
  } finally {
    await d.dispose();
  }
}

const runsOf = async (db: D1Database, fn: string) => (await listRuns(db, new Date('2026-11-28T00:00:00Z'), { limit: 500 })).filter((r) => r.fn === fn);
async function postResult(db: D1Database, runId: string, samples: unknown[], at: Date) {
  const run = (await getRun(db, runId))!;
  const task = await db.prepare('SELECT * FROM ai_tasks WHERE id = ?').bind(run.taskId).first();
  return finalizeRun(db, task as never, { samples }, at);
}
/** 一份合格的 F24 票（引用證據包裡的 10-Q）。 */
function reviewVote(pack: EvidencePack, verdict: string) {
  const tenq = pack.documents.find((d) => d.source_id === `edgar:${TENQ_FILING.accession}`)!;
  return {
    run_id: pack.run_id,
    verdict,
    model: 'claude-opus-5-5',
    premise_checks: [
      { premise_id: 'P1', status: 'HOLDS', evidence_ids: ['E1'] },
      { premise_id: 'P2', status: 'BROKEN', evidence_ids: ['E2'] },
    ],
    evidence: [
      { id: 'E1', source_id: tenq.source_id, date: tenq.date, quote: 'Revenue for the third quarter was $160 million, up 33% from a year ago', claim: '需求仍在' },
      { id: 'E2', source_id: tenq.source_id, date: tenq.date, quote: 'Gross margin was 60.0%, down from 70.0% a year ago', claim: '毛利率 60%' },
    ],
    payload: { tier: verdict, previous_conditions: [], conditions: [] },
    report: '毛利率跌破前提。',
  };
}
const logRows = async (db: D1Database) => (await db.prepare('SELECT ticker, file_id, kind, session, body, account_version FROM own_thesis_log ORDER BY id').all<{ ticker: string; file_id: string; kind: string; session: string; body: string; account_version: number }>()).results.map((r) => ({ ...r, body: JSON.parse(r.body) as Record<string, unknown> }));
const insertCond = (db: D1Database, fileId: string | null, condId = 'C1') =>
  db
    .prepare("INSERT INTO own_conditions (ticker, run_id, cond_id, direction, kind, text, check_json, tier_if_met, status, created_at, origin, file_id) VALUES ('NVDA', 'r0', ?, 'DOWN', 'XBRL', '毛利率低於 55%', ?, 'HALF', 'ACTIVE', '2026-11-19', 'USER', ?)")
    .bind(condId, JSON.stringify({ type: 'xbrl_metric_below', metric: 'GrossMarginPct', level: 0.55 }), fileId)
    .run();
const insertEvent = (db: D1Database, o: { accession: string; form: string; date: string; code: string; sub: string; source: string; status: string; displayOnly?: boolean; detail?: string }) =>
  db
    .prepare('INSERT INTO sec_events (ticker, accession, form, event_date, accepted_at, code, sub, by_rule, display_only, source, detail, status, created_at) VALUES (?, ?, ?, ?, NULL, ?, ?, 0, ?, ?, ?, ?, ?)')
    .bind('NVDA', o.accession, o.form, o.date, o.code, o.sub, o.displayOnly ? 1 : 0, o.source, o.detail ?? null, o.status, `${o.date}T23:40:00.000Z`)
    .run();

/** 把自選某一檔全部賣掉的分桶快照（清單外的賣出 → 自動移出自選）；可以順便買一檔新的自選。 */
function sellAllSnap(acct: Account, view: MarketView, ticker: string, buy?: { ticker: string; shares: number; why: string }) {
  const lots = { own: { ...acct.lots.own, [ticker]: 0 }, mom: { ...acct.lots.mom }, core: { ...acct.lots.core } };
  let cash = acct.cash + (acct.lots.own[ticker] ?? 0) * priceOf(view, ticker);
  if (buy) {
    lots.own[buy.ticker] = buy.shares;
    cash -= buy.shares * priceOf(view, buy.ticker);
  }
  const shares: Record<string, number> = {};
  for (const b of ['own', 'mom', 'core'] as const) for (const [t, q] of Object.entries(lots[b])) if (q) shares[t] = (shares[t] ?? 0) + q;
  return { shares, lots, cash, ...(buy ? { why: { [buy.ticker]: buy.why } } : {}) };
}

// ---------------------------------------------------------------- 論點檔的欄位與編號

describe('T25：論點檔的編號、前提的編號、預設前提', () => {
  it('開檔：fileId = 代號@訊號日、premiseSeq、前提的 addedAt、論點是空的；系統預設前提只有三條（拿掉「慢規則本身」）', async () => {
    await withWorld(async ({ db }) => {
      const meta = (await loadAccount(db))!.acct.own.NVDA;
      expect(meta).toMatchObject({ fileId: 'NVDA@2026-11-19', premiseSeq: 3, thesis: null });
      expect(meta.premises.map((p) => [p.id, p.addedAt])).toEqual([
        ['P1', '2026-11-19'],
        ['P2', '2026-11-19'],
      ]);
      expect(meta.opened).toMatchObject({ startState: 'STD' });
      // 建立帳戶那一版寫了 OPEN
      const [open] = await logRows(db);
      expect(open).toMatchObject({ ticker: 'NVDA', file_id: 'NVDA@2026-11-19', kind: 'OPEN', session: '2026-11-19', account_version: 1 });
      expect(open.body).toMatchObject({ origin: 'INITIAL', startState: 'STD' });
      expect(typeof open.body.drawdownAtOpen).toBe('number');
      expect((open.body.premises as { text: string }[]).map((p) => p.text)).toEqual(USER_PREMISES.map((p) => p.text));
    });
    expect(SYSTEM_DEFAULT_PREMISES.map((p) => [p.id, p.text])).toEqual([
      ['P1', '財報可信、沒有硬事件（重編、會計師辭任、延遲申報、被收購、重大監管處分）'],
      ['P2', '營收年增率沒有連兩季是負的'],
      ['P3', '稀釋每股盈餘沒有連兩季低於去年同季'],
    ]);
  });

  it('加前提不重排編號：接著 premiseSeq 編號、既有的不變；撤下的編號不再用；只有預設前提時取代、新的從 P4 起', async () => {
    await withWorld(async ({ db, viewAt }) => {
      const { view } = await viewAt('2026-11-19', ['AAPL']);
      const acct = (await loadAccount(db))!.acct;
      const a1 = addPremises(acct, 'NVDA', [{ text: 'HBM 的市占率維持第一', origin: 'USER' }], '2026-11-20');
      expect(a1.own.NVDA.premises.map((p) => [p.id, p.text, p.addedAt])).toEqual([
        ['P1', '資料中心需求延續到 2027', '2026-11-19'],
        ['P2', '毛利率維持在 65% 以上', '2026-11-19'],
        ['P3', 'HBM 的市占率維持第一', '2026-11-20'],
      ]);
      expect(a1.own.NVDA.premiseSeq).toBe(4);
      // 撤下 P1 之後再加：不會回頭用 P1，也不會把 P2、P3 往前補
      a1.own.NVDA.premises = a1.own.NVDA.premises.filter((p) => p.id !== 'P1');
      const a2 = addPremises(a1, 'NVDA', [{ text: '新的前提', origin: 'USER' }], '2026-11-21');
      expect(a2.own.NVDA.premises.map((p) => p.id)).toEqual(['P2', 'P3', 'P4']);
      // 只有預設前提的新自選：預設三條 P1～P3，加自己的前提時取代它們，新的從 P4 起
      const added = addOwn(acct, view, 'AAPL').acct;
      expect(added.own.AAPL.premises.map((p) => p.id)).toEqual(['P1', 'P2', 'P3']);
      expect(added.own.AAPL.premiseSeq).toBe(4);
      const a3 = addPremises(added, 'AAPL', [{ text: '我的理由', origin: 'USER' }], '2026-11-20');
      expect(a3.own.AAPL.premises.map((p) => [p.id, p.origin])).toEqual([['P4', 'USER']]);
    });
  });

  it('newOwnMeta：同一天結案又重開的論點檔加 #2、#3；不同天不加', async () => {
    await withWorld(async ({ viewAt }) => {
      const { view } = await viewAt('2026-11-19');
      expect(newOwnMeta(view, 'NVDA', 'NEW', []).fileId).toBe('NVDA@2026-11-19');
      expect(newOwnMeta(view, 'NVDA', 'NEW', [], 'NVDA@2026-11-19').fileId).toBe('NVDA@2026-11-19#2');
      expect(newOwnMeta(view, 'NVDA', 'NEW', [], 'NVDA@2026-11-19#2').fileId).toBe('NVDA@2026-11-19#3');
      expect(newOwnMeta(view, 'NVDA', 'NEW', [], 'NVDA@2026-10-01').fileId).toBe('NVDA@2026-11-19');
    });
  });
});

// ---------------------------------------------------------------- 結案、再加回、復原快照

describe('T25：結案與再加回、復原快照', () => {
  it('移出（賣光）再加回同一檔 → 新的 fileId；舊條件不被讀到（監測、論點檔），歷史裡還在；log 有 CLOSE 與新的 OPEN', async () => {
    await withWorld(async ({ db, run, viewAt }) => {
      const { view } = await viewAt('2026-11-19');
      await insertCond(db, 'NVDA@2026-11-19');
      let loaded = (await loadAccount(db))!;
      expect((await fileConditions(db, loaded.acct, 'NVDA')).map((c) => c.condId)).toEqual(['C1']);
      // 自己賣光 → 自動移出自選 = 結案
      const s = applySnapshot(loaded.acct, view, sellAllSnap(loaded.acct, view, 'NVDA'));
      expect(s.error).toBeUndefined();
      expect(s.removedOwn).toEqual(['NVDA']);
      expect(s.acct.ownClosed?.NVDA).toEqual({ fileId: 'NVDA@2026-11-19', reason: 'SOLD_OUT', date: '2026-11-19' });
      await saveAccount(db, s.acct, loaded, '快照', new Date('2026-11-19T13:00:00Z'));
      // 同一天又加回 → #2；舊條件不屬於新的論點檔
      loaded = (await loadAccount(db))!;
      const re = addOwn(loaded.acct, view, 'NVDA').acct;
      expect(re.own.NVDA.fileId).toBe('NVDA@2026-11-19#2');
      await saveAccount(db, re, loaded, '新增自選', new Date('2026-11-19T14:00:00Z'));
      const acct = (await loadAccount(db))!.acct;
      expect(await fileConditions(db, acct, 'NVDA')).toEqual([]);
      expect((await thesisFile(db, acct, 'NVDA', '2026-11-19'))!.conditions).toEqual([]);
      expect((await loadConditions(db, 'NVDA')).map((c) => [c.condId, c.fileId])).toEqual([['C1', 'NVDA@2026-11-19']]); // 舊的那一份仍在（網站看歷史用）
      const logs = await logRows(db);
      expect(logs.map((l) => [l.kind, l.file_id, l.account_version])).toEqual([
        ['OPEN', 'NVDA@2026-11-19', 1],
        ['CLOSE', 'NVDA@2026-11-19', 2],
        ['OPEN', 'NVDA@2026-11-19#2', 3],
      ]);
      expect(logs[1].body).toEqual({ reason: 'SOLD_OUT' });
      expect(logs[2].body).toMatchObject({ origin: 'NEW', startState: re.own.NVDA.slow.state });
      // 之後在新的論點檔寫條件 → 只讀得到新的
      await insertCond(db, 'NVDA@2026-11-19#2', 'C7');
      expect((await fileConditions(db, acct, 'NVDA')).map((c) => c.condId)).toEqual(['C7']);
      // 不同天再加回：沒有 #
      await run('2026-11-20');
      const { view: v2 } = await viewAt('2026-11-20');
      const gone = structuredClone(acct);
      gone.ownClosed = { NVDA: { fileId: 'NVDA@2026-11-19#2', reason: 'REMOVED', date: '2026-11-19' } };
      delete gone.own.NVDA;
      delete gone.rule.own.NVDA;
      expect(addOwn(gone, v2, 'NVDA').acct.own.NVDA.fileId).toBe('NVDA@2026-11-20');
    });
  });

  it('復原快照 → fileId 與條件接回來；那一版寫的 log（結案、新開的論點檔）不見，之前的留著', async () => {
    await withWorld(async ({ db, viewAt }) => {
      const { view } = await viewAt('2026-11-19', ['AAPL']);
      await insertCond(db, 'NVDA@2026-11-19');
      const loaded = (await loadAccount(db))!;
      // 一份快照：賣光 NVDA（結案）、買進 AAPL 放自選（開檔）
      const s = applySnapshot(loaded.acct, view, sellAllSnap(loaded.acct, view, 'NVDA', { ticker: 'AAPL', shares: 5, why: '服務收入成長' }));
      expect(s.error).toBeUndefined();
      expect(s.acct.own.NVDA).toBeUndefined();
      expect(s.acct.own.AAPL.fileId).toBe('AAPL@2026-11-19');
      const now = new Date('2026-11-19T13:00:00Z');
      const rev = await saveAccount(db, s.acct, loaded, '快照', now);
      await saveSnapshotUndo(db, rev, loaded.acct, s.acct, view.date, now, { cashOther: 0, cashWarn: false });
      expect((await logRows(db)).map((l) => [l.kind, l.file_id, l.account_version])).toEqual([
        ['OPEN', 'NVDA@2026-11-19', 1],
        ['CLOSE', 'NVDA@2026-11-19', 2],
        ['OPEN', 'AAPL@2026-11-19', 2],
      ]);
      expect(await fileConditions(db, (await loadAccount(db))!.acct, 'NVDA')).toEqual([]);

      expect(await undoSnapshot(db, new Date('2026-11-19T13:05:00Z'))).toMatchObject({ ok: true });
      const acct = (await loadAccount(db))!.acct;
      expect(acct.own.NVDA.fileId).toBe('NVDA@2026-11-19');
      expect(acct.own.AAPL).toBeUndefined();
      expect((await fileConditions(db, acct, 'NVDA')).map((c) => [c.condId, c.status])).toEqual([['C1', 'ACTIVE']]);
      expect((await logRows(db)).map((l) => [l.kind, l.file_id])).toEqual([['OPEN', 'NVDA@2026-11-19']]);
      // 復原之後再存一版（例如每日流程）：沒有變動就不寫 log
      const again = (await loadAccount(db))!;
      await saveAccount(db, again.acct, again, '沒有變動', new Date('2026-11-19T14:00:00Z'));
      expect(await logRows(db)).toHaveLength(1);
    });
  });
});

// ---------------------------------------------------------------- F24 的證據包

describe('T25：F24 的證據包由論點檔組', () => {
  it('兩次審查之間出現 5.02 的 8-K（每日掃描標記）→ 下一次 F24 的證據包有那份原文與 V 標記；T0、論點那一份 note；論點檔的前提最近一次檢查', async () => {
    await withWorld(async ({ db, e, env, fetcher, run, viewAt }) => {
      // 11-27（當月倒數第二個交易日）：第一次定期審查 → 3 票減半
      for (const d of ['2026-11-20', '2026-11-23', '2026-11-24', '2026-11-25', '2026-11-27']) await run(d);
      const [r1] = await runsOf(db, 'OWN_REVIEW');
      // 第一次：沒有上一次審查、沒有論點本文 → 沒有 note；T0 有論點；沒有事件
      expect(r1.pack.documents.map((d) => d.source_id)).toEqual(['price:NVDA', 'xbrl:NVDA', `edgar:${TENQ_FILING.accession}`]);
      expect(r1.pack.facts.filter((f) => /^(T|V|D)\d+$/.test(f.id)).map((f) => [f.id, f.value])).toEqual([['T0', '有論點']]);
      await postResult(db, r1.runId, [reviewVote(r1.pack, 'HALF'), reviewVote(r1.pack, 'HALF'), reviewVote(r1.pack, 'HALF')], new Date('2026-11-28T00:10:00Z'));
      await run('2026-11-27', 'FINAL');

      // 12-01：公司送了 5.02 的 8-K（財務長辭任）→ 每日掃描標成 MGMT_CHANGE
      e.filings.push(EIGHTK_502);
      await run('2026-12-01');
      const scan = (await listRuns(db, new Date('2026-12-02T00:00:00Z'), { limit: 50 })).find((r) => r.fn === 'EVENT_SCAN' && r.asOf === '2026-12-01')!;
      const src = `edgar:${EIGHTK_502.accession}`;
      expect(scan.pack.documents.map((d) => d.source_id)).toContain(src);
      const doc = scan.pack.documents.find((d) => d.source_id === src)!;
      await postResult(db, scan.runId, [{ run_id: scan.pack.run_id, verdict: 'FLAGGED', evidence: [{ id: 'E1', source_id: src, date: doc.date, quote: 'the Chief Financial Officer informed the Company of her resignation', claim: '財務長辭任' }], payload: { events: [{ ticker: 'NVDA', class: 'MGMT_CHANGE', source_id: src }] } }], new Date('2026-12-02T00:12:00Z'));
      await run('2026-12-01', 'FINAL');

      // 下一次 F24（12-02）
      await run('2026-12-02');
      const acct = (await loadAccount(db))!.acct;
      const { view, axis } = await viewAt('2026-12-02');
      const r2 = await startOwnReview(env, fetcher, acct, view, axis, 'NVDA', 'MANUAL', new Date('2026-12-03T01:00:00Z'));
      const filing = r2.pack.documents.find((d) => d.source_id === src)!;
      expect(filing).toMatchObject({ kind: 'filing', date: '2026-12-01' });
      expect(filing.text).toContain('Chief Financial Officer informed the Company of her resignation');
      const v = r2.pack.facts.filter((f) => /^V\d+$/.test(f.id));
      // T28：5.02 的財務長辭任，規則從原文也記一筆（MGMT_CHANGE／8K_5.02_CFO_DEPART），和每日掃描的標記各一筆
      expect(v).toHaveLength(2);
      expect(v[0]).toMatchObject({ id: 'V1', value: expect.stringContaining('MGMT_CHANGE') });
      expect(v[0].label).toContain('2026-12-01');
      expect(v[0].label).toContain('每日掃描');
      expect(v[0].note).toContain(src);
      expect(v[1].label).toContain('8K_5.02_CFO_DEPART');
      expect(v[1].note).toContain(EIGHTK_502.accession);
      expect(r2.pack.facts.find((f) => f.id === 'T0')!.value).toBe('有論點');
      expect(r2.pack.facts.some((f) => /^D\d$/.test(f.id))).toBe(false);
      // 論點那一份 note：最近的審查與結論；寫明是背景
      const note = r2.pack.documents.find((d) => d.source_id === 'thesis:NVDA@2026-11-19')!;
      expect(note.kind).toBe('note');
      expect(note.text).toContain('這一份是背景，不是前提成立或不成立的證據');
      expect(note.text).toContain(`2026-11-27（MONTHLY，${r1.runId}）：AGREED HALF`);
      expect(note.text).toContain('三票都判不成立：P2');
      // 11-27 那次審查看過的 10-Q 不重複算新的；上次審查之前的 8-K 也不算
      expect(r2.pack.documents.filter((d) => d.kind === 'filing').map((d) => d.source_id)).toEqual([`edgar:${TENQ_FILING.accession}`, src]);

      // 論點檔（§1.3）的區塊
      const tf = (await thesisFile(db, acct, 'NVDA', '2026-12-02'))!;
      expect(tf).toMatchObject({ fileId: 'NVDA@2026-11-19', openedAt: '2026-11-19', origin: 'INITIAL', kind: 'THESIS', status: 'OPEN', thesis: null });
      expect(tf.lastReview).toMatchObject({ runId: r1.runId, asOf: '2026-11-27' });
      expect(tf.premises.map((p) => [p.id, p.lastCheck?.status, p.lastCheck?.runId, p.splitAfter])).toEqual([
        ['P1', 'HOLDS', r1.runId, false],
        ['P2', 'BROKEN', r1.runId, false],
      ]);
      expect(tf.events.find((x) => x.sourceId === src)).toMatchObject({ source: 'SCAN', code: 'MGMT_CHANGE', isNew: true, accession: EIGHTK_502.accession });
      expect(tf.reviews.find((x) => x.runId === r1.runId)).toMatchObject({ fn: 'OWN_REVIEW', label: '定期審查', trigger: 'MONTHLY', status: 'AGREED', verdict: 'HALF', brokenPremises: ['P2'] });
      expect(tf.log.map((l) => l.kind)).toEqual(['OPEN']);
    });
  });

  it('8-K 多於 5 份：最新的 2.02、有標記的（新到舊）、其餘（新到舊）；沒有上一次審查時只看最近 120 天；已經在證據裡的財報新聞稿不重抓也算一份', async () => {
    const a = eightK(401, '2026-07-01', '2.02', 'Results of Operations. Old quarter results.'); // 超過 120 天
    const b = eightK(402, '2026-09-01', '2.02', 'Results of Operations. Prior quarter results.');
    const c = eightK(403, '2026-11-02', '2.02', 'Results of Operations. Latest quarter results.');
    const f1 = eightK(404, '2026-11-03', '8.01', 'Other Events. Flagged by the scan.');
    const f2 = eightK(405, '2026-11-04', '7.01', 'Regulation FD Disclosure. Investor day.');
    const f3 = eightK(406, '2026-11-05', '5.07', 'Submission of Matters to a Vote.');
    const f4 = eightK(407, '2026-11-06', '1.01', 'Entry into a Material Definitive Agreement.');
    const f5 = eightK(408, '2026-11-09', '8.01', 'Other Events. Newest.');
    await withWorld(
      async ({ db, env, fetcher, viewAt }) => {
        await insertEvent(db, { accession: `edgar:${f1.accession}`, form: '8-K', date: f1.filingDate, code: 'OTHER', sub: 'SCAN_OTHER', source: 'SCAN', status: 'INFO', displayOnly: true, detail: '每日掃描標記：OTHER' });
        const acct = (await loadAccount(db))!.acct;
        const { view, axis } = await viewAt('2026-11-19');
        const r = await startOwnReview(env, fetcher, acct, view, axis, 'NVDA', 'MANUAL', new Date('2026-11-20T01:00:00Z'));
        const ids = r.pack.documents.filter((d) => d.kind === 'filing').map((d) => d.source_id.replace('edgar:0001045810-26-', ''));
        // 10-Q 的 MD&A、財報新聞稿（原本就有的兩份）；然後是挑出來的 8-K：c（最新的 2.02，已經在證據裡）、f1（有標記）、f5、f4、f3（其餘新到舊）
        expect(ids).toEqual(['000300', '000403', '000404', '000408', '000407', '000406']);
        expect(r.pack.facts.filter((x) => /^V\d+$/.test(x.id)).map((x) => x.note)).toEqual([`來源 edgar:${f1.accession}；只記錄`]);
        void [a, b, f2];
      },
      { filings: [TENQ_FILING, a, b, c, f1, f2, f3, f4, f5] },
    );
    // 純函式：順序
    const F = (acc: string, date: string, items: string[], form = '8-K') => ({ accession: acc, form, items, filingDate: date, acceptedAt: `${date}T21:00:00.000Z` });
    const list = [F('x1', '2026-11-01', ['2.02']), F('x2', '2026-11-02', ['8.01']), F('x3', '2026-11-03', ['2.02']), F('x4', '2026-11-04', ['5.02']), F('x5', '2026-11-05', ['7.01']), F('x6', '2026-11-06', [], '10-Q'), F('x7', '2026-11-07', ['8.01'])];
    expect(pickFilings(list, new Set(['x2', 'x5']), 5).map((f) => f.accession)).toEqual(['x3', 'x5', 'x2', 'x7', 'x6']);
    expect(pickFilings(list, new Set(), 3).map((f) => f.accession)).toEqual(['x3', 'x7', 'x6']);
  });

  it('只有預設前提的股票：前提只有 P1～P3（新的文字），證據包有 D1～D3；T0 是只有預設', async () => {
    await withWorld(
      async ({ db, env, fetcher, viewAt }) => {
        await insertEvent(db, { accession: '0001045810-26-000250', form: '8-K', date: '2026-10-15', code: 'ACCOUNTING', sub: '8K_4.02', source: 'EDGAR', status: 'HANDLED', detail: '財報不可信賴（重編）' });
        const acct = (await loadAccount(db))!.acct;
        expect(acct.own.NVDA.premises.map((p) => p.id)).toEqual(['P1', 'P2', 'P3']);
        expect(acct.own.NVDA.premiseSeq).toBe(4);
        const { view, axis } = await viewAt('2026-11-19');
        const r = await startOwnReview(env, fetcher, acct, view, axis, 'NVDA', 'MANUAL', new Date('2026-11-20T01:00:00Z'));
        expect(r.pack.premises.map((p) => [p.id, p.text])).toEqual(SYSTEM_DEFAULT_PREMISES.map((p) => [p.id, p.text]));
        const facts = Object.fromEntries(r.pack.facts.map((f) => [f.id, f.value]));
        expect(facts.T0).toBe('只有預設（一般健康檢查，不是使用者的論點）');
        expect(facts.D1).toContain('2026-10-15 8-K 會計問題（8K_4.02，已處理');
        expect(facts.D2).toBe('2026-09-30 +33.3%、2026-06-30 +36.4% → 成立');
        expect(facts.D3).toContain('資料不足');
        expect(r.pack.facts.some((f) => f.id === 'D4')).toBe(false);
      },
      { defaults: true },
    );
  });

  it('D1～D3 的判斷：連兩季負成長、連兩季低於去年同季 → 不成立；第四季沒有單季 EPS → 資料不足；有標記 → D1 列出；有論點的股票不放', () => {
    const row = (end: string, revenueYoY: number | null, eps: number | null): QuarterRow => ({ end, filed: end, form: '10-Q', accn: 'a', revenue: 1, grossProfit: null, operatingIncome: null, netIncome: null, epsDiluted: eps, cfo: null, grossMarginPct: null, operatingMarginPct: null, netMarginPct: null, revenueYoY, cfoToNetIncome: null });
    const tf = { kind: 'DEFAULT_ONLY', events: [], flags: ['ACCOUNTING'] } as unknown as ThesisFile;
    const bad = [row('2026-09-30', -0.05, 0.8), row('2026-06-30', -0.02, 0.9), row('2025-09-30', 0.1, 1.0), row('2025-06-30', 0.1, 1.1)];
    const d = Object.fromEntries(defaultFacts(tf, bad, '2026-11-19').map((f) => [f.id, f.value]));
    expect(d.D1).toBe('未解除的硬事件標記：會計問題');
    expect(d.D2).toBe('2026-09-30 -5.0%、2026-06-30 -2.0% → 不成立（連兩季是負的）');
    expect(d.D3).toBe('2026-09-30 0.80（去年同季 1.00）、2026-06-30 0.90（去年同季 1.10） → 不成立（連兩季低於去年同季）');
    const q4 = [row('2026-12-31', 0.1, null), row('2026-09-30', 0.1, 1.2), row('2025-12-31', 0.1, null), row('2025-09-30', 0.1, 1.0)];
    expect(defaultFacts(tf, q4, '2027-02-20').find((f) => f.id === 'D3')!.value).toContain('資料不足');
    expect(defaultFacts({ ...tf, flags: [] }, null, '2026-11-19').map((f) => f.value)).toEqual(['沒有', '資料不足（XBRL 抓不到）', '資料不足（XBRL 抓不到）']);
    expect(defaultFacts({ ...tf, kind: 'THESIS' }, bad, '2026-11-19')).toEqual([]);
  });
});

// ---------------------------------------------------------------- F7 的證據包

describe('T25：F7 的證據包', () => {
  it('ownDropPack：加上論點檔的部分之後，其餘（題目、檔位、規則、前提、原本的數字與原文、順序）和沒加時完全相同', async () => {
    await withWorld(async ({ db, viewAt }) => {
      const acct = (await loadAccount(db))!.acct;
      const { view, axis } = await viewAt('2026-11-19');
      const attr = attribution(axis, view.close, 'NVDA', 'VOO', null, highIndex(view.close.NVDA, view.i), view.i);
      const filing: PackDoc = { id: 'F-1', source_id: 'edgar:1', kind: 'filing', date: '2026-11-10', title: '8-K', text: 'x' };
      const base = { acct, view, axis, ticker: 'NVDA', runId: 'r', attr, base: null, baseRunId: null, docs: [filing], urgent: true, dataQuality: { filings: 'ok' as const }, now: new Date('2026-11-20T00:00:00Z') };
      const before = ownDropPack(base).pack;
      const extraFacts = [{ id: 'T0', label: '論點檔種類', value: '有論點' }, { id: 'V1', label: '事件', value: 'x' }];
      const note: PackDoc = { id: 'T-NVDA', source_id: 'thesis:NVDA@2026-11-19', kind: 'note', date: '2026-11-19', title: 'n', text: 'n' };
      const after = ownDropPack({ ...base, extraFacts, extraDocs: [note] }).pack;
      const { facts: fb, documents: db0, created_at: _c1, ...restB } = before;
      const { facts: fa, documents: da, created_at: _c2, ...restA } = after;
      expect(restA).toEqual(restB);
      expect(fa).toEqual([...fb, ...extraFacts]);
      expect(da).toEqual([...db0, note]);
    });
  });

  it('整條流程：自選暴跌開 F7 → 證據包多了 T0、V、論點那一份 note，原本的數字與原文不變；有標記的 8-K 照順序排在前面', async () => {
    const k1 = eightK(601, '2026-11-20', '7.01', 'Regulation FD Disclosure. Newest but not flagged.');
    const k2 = eightK(602, '2026-11-10', '8.01', 'Other Events. Flagged by the rules.');
    await withWorld(
      async ({ db, w, run }) => {
        await insertEvent(db, { accession: `edgar:${k2.accession}`, form: '8-K', date: k2.filingDate, code: 'OTHER', sub: 'SCAN_OTHER', source: 'SCAN', status: 'INFO', displayOnly: true, detail: '每日掃描標記：OTHER' });
        await run('2026-11-20');
        w.shock.NVDA = { from: '2026-11-23', factor: 0.7 };
        await run('2026-11-23');
        const [drop] = await runsOf(db, 'OWN_DROP');
        expect(drop.ticker).toBe('NVDA');
        const ids = drop.pack.facts.map((f) => f.id);
        // 原本的：價格 F1～F7、規則 R1～R4、跌幅拆解 A*；新增的接在後面
        const old = ids.filter((x) => !/^(T0|V\d+|D\d)$/.test(x));
        expect(old.slice(0, 11)).toEqual(['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'R1', 'R2', 'R3', 'R4']);
        expect(old.slice(11).every((x) => /^A\d$/.test(x))).toBe(true);
        expect(ids.slice(old.length)).toEqual(['T0', 'V1']);
        expect(drop.pack.facts.find((f) => f.id === 'V1')!.note).toContain(`edgar:${k2.accession}`);
        // 原文：上次審查之後的申報（沒有審查：45 天）照順序（有標記的在前），然後價格表；沒有論點本文、沒有審查 → 沒有 note
        expect(drop.pack.documents.map((d) => d.source_id)).toEqual([`edgar:${k2.accession}`, `edgar:${k1.accession}`, `edgar:${TENQ_FILING.accession}`, 'price:NVDA']);
        expect(drop.pack.policy.verdicts).toEqual(['EXIT', 'HALF', 'HOLD']);
      },
      { filings: [TENQ_FILING, k2, k1] },
    );
  });

  it('F7：有論點本文時附論點那一份 note；只有預設前提的股票附 D1～D3（另外抓 XBRL）', async () => {
    await withWorld(
      async ({ db, w, run }) => {
        await run('2026-11-20');
        w.shock.NVDA = { from: '2026-11-23', factor: 0.7 };
        await run('2026-11-23');
        const [drop] = await runsOf(db, 'OWN_DROP');
        const facts = Object.fromEntries(drop.pack.facts.map((f) => [f.id, f.value]));
        expect(facts.T0).toBe('只有預設（一般健康檢查，不是使用者的論點）');
        expect(facts.D2).toBe('2026-09-30 +33.3%、2026-06-30 +36.4% → 成立');
        expect(drop.pack.premises.map((p) => p.id)).toEqual(['P1', 'P2', 'P3']);
        const note = drop.pack.documents.find((d) => d.source_id === 'thesis:NVDA@2026-11-19')!;
        expect(note.text).toContain('論點（2026-11-19 定，在網站手寫，第 1 版）：');
        expect(note.text).toContain('記憶體週期觸底');
      },
      {
        defaults: true,
        acct: (a) => {
          a.own.NVDA.thesis = { text: '記憶體週期觸底', setAt: '2026-11-19', source: 'TYPED', version: 1, afterBreak: 0, lastAfterBreakAt: null };
          return a;
        },
      },
    );
  });
});
