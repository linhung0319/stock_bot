// T85 甲段：候補名單——候補這個物件、論點檔共用入口、網站那一塊（allocation_redesign §4.5 與末尾「實作前補的細節」1～10 點）。
// 完成條件：
//   1. 候補不是「0 股的自選」：不進價格必要清單（requiredTickers）、每日掃描與硬事件法庭（scanTargets）；每日流程不替候補開任何 AI
//   2. 候補有論點檔：加入寫 OPEN（origin WATCH）、移除寫 CLOSE（WATCH_REMOVED）；移除不蓋掉上一次持有的紀錄（held）；
//      移出自選時 brokenAt 抄進 ownClosed（30 天的防線跨得過論點檔）
//   3. fileMeta：論點檔的讀寫先找自選再找候補（論點、前提、條件、草稿狀態、討論包、詳細頁）
//   4. 帳戶頁加、改比重、移除；上限 5 檔；已在自選、核心標的、打錯的代號、歷史不夠的都擋（422）；候補中的代號不能「新增自選」
//   5. 價格放「追蹤」不放「必要」：候補壞代號不擋整天的訊號
// 對外請求全部是假的：價格（固定檔）、EDGAR、Nasdaq RSS、雲端排程、LINE。
import { describe, expect, it } from 'vitest';
import type { Env, Fetcher } from '../src/app/env';
import { scanTargets } from '../src/app/events';
import { runFlow } from '../src/app/flow';
import { LINE_PUSH_URL } from '../src/app/line';
import { fileChanges, loadAccount, requiredTickers, saveAccount } from '../src/app/ledgerStore';
import { draftStateOf, startAutoDrafts } from '../src/app/ownDraft';
import { fileConditions, metaFile, prevFileOf, thesisFile } from '../src/app/thesis';
import type { HoldingDetail, StateView } from '../src/app/site/views';
import { buildMarketView } from '../src/data/marketView';
import { loadSeries } from '../src/data/store';
import { MAX_WATCH, SYSTEM_DEFAULT_PREMISES, WatchError, addWatch, createAccount, fileMeta, removeWatch, setThesis, updateWatch, watchTickers, type Account, type MarketView } from '../src/engine';
import { handle } from '../src/index';
import { freshDb } from './helpers/d1';
import { cronTime, fakeFetcher, newWorld, type World } from './helpers/fakeSources';

function fetcherOf(w: World, fire: { n: number }): Fetcher {
  const base = fakeFetcher(w);
  return async (url, init) => {
    if (url === LINE_PUSH_URL) return Response.json({});
    if (url === 'https://api.example/fire') {
      fire.n++;
      return Response.json({ claude_code_session_url: 'https://claude.ai/code/x' });
    }
    if (/data\.sec\.gov\/submissions\/CIK\d+\.json/.test(url)) return Response.json({ cik: '1045810', name: 'NVIDIA CORP', tickers: ['NVDA'], filings: { recent: { accessionNumber: [], form: [], items: [], acceptanceDateTime: [], filingDate: [], primaryDocument: [] } } });
    if (/companyfacts\/CIK\d+\.json/.test(url)) return Response.json({ cik: 1045810, facts: {} });
    if (url.startsWith('https://www.nasdaq.com/feed/rssoutbound') || url.startsWith('https://feeds.finance.yahoo.com/rss/2.0/headline')) return new Response('<rss><channel></channel></rss>');
    return base(url, init);
  };
}

interface Ctx {
  db: D1Database;
  env: Env;
  w: World;
  fire: { n: number };
  fetcher: Fetcher;
  view: MarketView;
  api: <T = Record<string, unknown>>(method: 'GET' | 'POST', path: string, body?: unknown) => Promise<{ status: number; body: T }>;
}

const NVDA_FILE = 'NVDA@2026-11-19';
const USER_PREMISES = [{ id: 'P4', text: '資料中心需求延續到 2027', origin: 'USER' as const }];

/** 2026-11-19 建立帳戶：NVDA 是自選（有論點）。網站的請求都是 11-20 早上（訊號日 11-19）。 */
async function withWorld(fn: (c: Ctx) => Promise<void>) {
  const d = await freshDb();
  try {
    const db = d.db;
    const w = newWorld('2026-11-19');
    const fire = { n: 0 };
    const env: Env = { DB: db, ADMIN_TOKEN: 't', AI_TASK_SECRET: 's', EDGAR_USER_AGENT: 'test bot test@example.com', SITE_URL: 'https://bot.example', LINE_CHANNEL_TOKEN: 'lt', LINE_USER_ID: 'U1', DEV_NO_AUTH: '1', ROUTINE_FIRE_URL: 'https://api.example/fire', ROUTINE_TOKEN: 'rt' };
    const fetcher = fetcherOf(w, fire);
    const api: Ctx['api'] = async (method, path, body) => {
      const r = await handle(new Request(`https://bot.example/api/${path}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env, fetcher, new Date('2026-11-20T02:00:00Z'));
      return { status: r.status, body: (await r.json()) as never };
    };
    await runFlow(env, fetcher, { now: cronTime('2026-11-19'), attempt: 'FIRST' });
    const { view } = buildMarketView(await loadSeries(db, ['VOO', 'SGOV', 'NVDA']), '2026-11-19', 'VOO');
    const acct = createAccount({ paper: true, cash: 5000, core: { VOO: Math.floor(140_000 / view.close.VOO[view.i]) }, own: { NVDA: { shares: Math.floor(10_000 / view.close.NVDA[view.i]), stdWeight: 0.1, premises: structuredClone(USER_PREMISES) } } }, view);
    acct.own.NVDA.thesis = { text: 'NVDA 的論點', setAt: '2026-11-19', source: 'TYPED', version: 1, afterBreak: 0, lastAfterBreakAt: null };
    await saveAccount(db, acct, null, '建立帳戶', new Date('2026-11-19T12:00:00Z'));
    await fn({ db, env, w, fire, fetcher, view, api });
  } finally {
    await d.dispose();
  }
}

const acctOf = async (db: D1Database): Promise<Account> => (await loadAccount(db))!.acct;
const logOf = async (db: D1Database, ticker: string) => (await db.prepare('SELECT file_id, kind, session, body FROM own_thesis_log WHERE ticker = ? ORDER BY id').bind(ticker).all<{ file_id: string; kind: string; session: string; body: string }>()).results.map((r) => ({ ...r, body: JSON.parse(r.body) as Record<string, unknown> }));

/** 純函式用的小帳戶（不碰資料庫）。 */
function bare(): { acct: Account; view: MarketView } {
  const n = 260;
  const mk = (p0: number) => Float64Array.from({ length: n }, (_, i) => p0 * (1 + i / 1000));
  const view: MarketView = { date: '2026-11-19', i: n - 1, close: { VOO: mk(500), SGOV: mk(100), NVDA: mk(150), AMD: mk(120), MSFT: mk(400), AAPL: mk(200), META: mk(500), GOOGL: mk(170), AMZN: mk(180) } };
  const acct = createAccount({ paper: true, cash: 5000, core: { VOO: 200 }, own: { NVDA: { shares: 60, stdWeight: 0.1, premises: structuredClone(USER_PREMISES) } } }, view);
  return { acct, view };
}

// ---------------------------------------------------------------- 1. 引擎：加、改、移除

describe('T85 甲 ①：候補這個物件（引擎）', () => {
  it('加候補：開一份論點檔（編號照舊、前提是系統預設）；不下單、不發通知、不進自選', () => {
    const { acct, view } = bare();
    const a = addWatch(acct, view, 'AMD', { note: '  AI 晶片的第二供應商  ', stdWeight: 0.04 });
    expect(a.watch!.AMD).toEqual({
      fileId: 'AMD@2026-11-19',
      premises: SYSTEM_DEFAULT_PREMISES.map((p) => ({ ...p, addedAt: '2026-11-19' })),
      thesis: null,
      premiseSeq: 4,
      buyNote: { text: 'AI 晶片的第二供應商', at: '2026-11-19' },
      addedAt: '2026-11-19',
      stdWeight: 0.04,
      lastListed: null,
    });
    expect(a.own.AMD).toBeUndefined();
    expect(a.rule.own.AMD).toBeUndefined();
    expect(a.notifs.length).toBe(acct.notifs.length);
    expect(a.lots).toEqual(acct.lots);
    // 留空的比重是 null（列進場項目時才用推薦值）
    expect(addWatch(acct, view, 'MSFT').watch!.MSFT).toMatchObject({ stdWeight: null, lastListed: null });
    expect(addWatch(acct, view, 'MSFT').watch!.MSFT.buyNote).toBeUndefined();
  });

  it('上限 5 檔；已在自選、已在候補、核心的標的都不能加（WatchError）', () => {
    const { acct, view } = bare();
    let a = acct;
    for (const t of ['AMD', 'MSFT', 'AAPL', 'META', 'GOOGL']) a = addWatch(a, view, t);
    expect(Object.keys(a.watch!)).toHaveLength(MAX_WATCH);
    expect(() => addWatch(a, view, 'AMZN')).toThrow(WatchError);
    expect(() => addWatch(a, view, 'AMZN')).toThrow('候補最多 5 檔');
    expect(() => addWatch(acct, view, 'NVDA')).toThrow('已經在自選裡了');
    expect(() => addWatch(addWatch(acct, view, 'AMD'), view, 'AMD')).toThrow('已經在候補名單裡了');
    expect(() => addWatch(acct, view, 'VOO')).toThrow('核心的標的');
    expect(() => addWatch(acct, view, 'SGOV')).toThrow('核心的標的');
  });

  it('改比重、改那一句話（null／空字串 = 拿掉）；不在候補的不能改', () => {
    const { acct, view } = bare();
    const a = addWatch(acct, view, 'AMD', { note: 'x', stdWeight: 0.04 });
    expect(updateWatch(a, view, 'AMD', { stdWeight: 0.06 }).watch!.AMD).toMatchObject({ stdWeight: 0.06, buyNote: { text: 'x' } });
    expect(updateWatch(a, view, 'AMD', { stdWeight: null }).watch!.AMD.stdWeight).toBeNull();
    expect(updateWatch(a, view, 'AMD', { note: '' }).watch!.AMD.buyNote).toBeNull();
    expect(() => updateWatch(a, view, 'MSFT', { stdWeight: 0.05 })).toThrow('不在候補名單裡');
  });

  it('fileMeta：先找自選再找候補；都不是是 null', () => {
    const { acct, view } = bare();
    const a = addWatch(acct, view, 'AMD');
    expect(fileMeta(a, 'NVDA')).toMatchObject({ held: true, meta: { fileId: NVDA_FILE } });
    expect(fileMeta(a, 'AMD')).toMatchObject({ held: false, meta: { fileId: 'AMD@2026-11-19' } });
    expect(fileMeta(a, 'MSFT')).toBeNull();
    expect(watchTickers(a)).toEqual(['AMD']);
    expect(watchTickers(acct)).toEqual([]);
  });

  it('候補不是「0 股的自選」：不進價格必要清單、每日掃描與硬事件法庭', async () => {
    const { acct, view } = bare();
    const a = addWatch(addWatch(acct, view, 'AMD'), view, 'MSFT');
    expect(requiredTickers(a)).toEqual(requiredTickers(acct));
    expect(requiredTickers(a)).not.toContain('AMD');
    const targets = await scanTargets({} as D1Database, a);
    expect(targets.map((t) => t.ticker)).toEqual(['NVDA']);
  });

  it('論點、前提存在候補自己身上（setThesis 走 fileMeta）；候補沒有審查，不排論點變動後的審查', () => {
    const { acct, view } = bare();
    const a = addWatch(acct, view, 'AMD');
    const out = setThesis(a, 'AMD', { text: '想等它的資料中心營收證實再買', source: 'TYPED', premises: [{ id: null, text: 'MI300 的訂單持續成長' }], date: '2026-11-19' });
    const w = out.acct.watch!.AMD;
    expect(w.thesis).toMatchObject({ text: '想等它的資料中心營收證實再買', version: 1 });
    expect(w.premises.map((p) => [p.id, p.text, p.origin])).toEqual([['P4', 'MI300 的訂單持續成長', 'USER']]);
    expect(out.changed).toBe(true);
    expect((w as unknown as Record<string, unknown>).thesisReviewDue).toBeUndefined();
    expect(out.acct.own.AMD).toBeUndefined();
    expect(() => setThesis(a, 'MSFT', { text: 'x', source: 'TYPED', premises: [], date: '2026-11-19' })).toThrow('不在候補名單裡');
  });
});

// ---------------------------------------------------------------- 2. 論點檔的開檔與結案

describe('T85 甲 ②：論點檔的開檔與結案', () => {
  it('加候補寫 OPEN（origin WATCH）；移除寫 CLOSE（WATCH_REMOVED）；同一個編號從候補搬到自選不寫 OPEN／CLOSE', () => {
    const { acct, view } = bare();
    const before = { NVDA: NVDA_FILE };
    const now = new Date('2026-11-20T02:00:00Z');
    const a = addWatch(acct, view, 'AMD', { note: '想買', stdWeight: 0.04 });
    expect(fileChanges(before, a, now)).toEqual([{ ticker: 'AMD', fileId: 'AMD@2026-11-19', session: '2026-11-19', kind: 'OPEN', body: { origin: 'WATCH', premises: a.watch!.AMD.premises, stdWeight: 0.04, buyNote: { text: '想買', at: '2026-11-19' } } }]);
    const r = removeWatch(a, view, 'AMD');
    expect(r.watch).toEqual({});
    expect(fileChanges({ ...before, AMD: 'AMD@2026-11-19' }, r, now)).toEqual([{ ticker: 'AMD', fileId: 'AMD@2026-11-19', session: '2026-11-19', kind: 'CLOSE', body: { reason: 'WATCH_REMOVED' } }]);
    // 進場（T85 乙段做）：同一個編號從候補搬到自選
    const moved = structuredClone(a);
    moved.own.AMD = { ...structuredClone(acct.own.NVDA), fileId: 'AMD@2026-11-19', origin: 'WATCH' };
    delete moved.watch!.AMD;
    expect(fileChanges({ ...before, AMD: 'AMD@2026-11-19' }, moved, now)).toEqual([]);
  });

  it('移除候補：結案紀錄記這一份的論點；原本那一筆是持有的結案 → 搬進 held，「上一次持有時」照舊看得到；brokenAt 照帶', () => {
    const { acct, view } = bare();
    const sold = structuredClone(acct);
    sold.ownClosed = { NVDA: { fileId: 'NVDA@2026-10-01', reason: 'SOLD_OUT', date: '2026-11-10', last: { thesis: { text: '上次持有的論點', setAt: '2026-10-01', version: 2 }, premises: [{ id: 'P4', text: '上次的前提' }] }, brokenAt: '2026-11-05' } };
    delete sold.own.NVDA;
    delete sold.rule.own.NVDA;
    let a = addWatch(sold, view, 'NVDA');
    expect(a.watch!.NVDA.fileId).toBe('NVDA@2026-11-19');
    // 候補的詳細頁也看得到上一次持有時的論點
    expect(prevFileOf(a, 'NVDA')).toMatchObject({ fileId: 'NVDA@2026-10-01', reason: 'SOLD_OUT', thesis: { text: '上次持有的論點' } });
    a = setThesis(a, 'NVDA', { text: '候補時寫的論點', source: 'TYPED', premises: [{ id: null, text: '候補的前提' }], date: '2026-11-19' }).acct;
    a = removeWatch(a, view, 'NVDA');
    expect(a.ownClosed!.NVDA).toEqual({
      fileId: 'NVDA@2026-11-19',
      reason: 'WATCH_REMOVED',
      date: '2026-11-19',
      last: { thesis: { text: '候補時寫的論點', setAt: '2026-11-19', version: 1 }, premises: [{ id: 'P4', text: '候補的前提' }] },
      brokenAt: '2026-11-05',
      held: { fileId: 'NVDA@2026-10-01', reason: 'SOLD_OUT', date: '2026-11-10', last: sold.ownClosed!.NVDA.last },
    });
    // 再加回候補（同一天 → #2）：「上一次持有時」仍是那一次持有，不是候補那一份
    a = addWatch(a, view, 'NVDA');
    expect(a.watch!.NVDA.fileId).toBe('NVDA@2026-11-19#2');
    expect(prevFileOf(a, 'NVDA')).toMatchObject({ fileId: 'NVDA@2026-10-01', reason: 'SOLD_OUT', thesis: { text: '上次持有的論點' } });
    // 再移除一次：held 沿用（不會被上一筆候補蓋掉）
    a = removeWatch(a, view, 'NVDA');
    expect(a.ownClosed!.NVDA).toMatchObject({ fileId: 'NVDA@2026-11-19#2', reason: 'WATCH_REMOVED', brokenAt: '2026-11-05', held: { fileId: 'NVDA@2026-10-01', reason: 'SOLD_OUT' } });
    // 從沒持有過的候補移除：沒有 held，也沒有「上一次持有時」
    const b = removeWatch(addWatch(acct, view, 'AMD'), view, 'AMD');
    expect(b.ownClosed!.AMD.held).toBeUndefined();
    expect(prevFileOf(addWatch(b, view, 'AMD'), 'AMD')).toBeNull();
  });

  it('移出自選時，最近一次前提被判不成立的日子抄進 ownClosed（§4.5 第 7 點：30 天的防線跨得過論點檔）', async () => {
    await withWorld(async (c) => {
      const loaded = (await loadAccount(c.db))!;
      const a = structuredClone(loaded.acct);
      a.own.NVDA.brokenAt = '2026-11-12';
      await saveAccount(c.db, a, loaded, '測試', new Date('2026-11-19T13:00:00Z'));
      const form = (await c.api<{ buckets: Record<'own' | 'mom' | 'core', { ticker: string; expected: number }[]>; cashBook: number }>('GET', 'snapshot/form')).body;
      const lots: Record<'own' | 'mom' | 'core', Record<string, number>> = { own: {}, mom: {}, core: {} };
      for (const b of ['own', 'mom', 'core'] as const) for (const r of form.buckets[b]) lots[b][r.ticker] = r.expected;
      const had = lots.own.NVDA;
      lots.own.NVDA = 0;
      const r = await c.api('POST', 'snapshot', { lots, cash: form.cashBook + had * c.view.close.NVDA[c.view.i] });
      expect(r.status).toBe(200);
      expect((await acctOf(c.db)).ownClosed!.NVDA).toMatchObject({ fileId: NVDA_FILE, reason: 'SOLD_OUT', brokenAt: '2026-11-12' });
    });
  });
});

// ---------------------------------------------------------------- 3. 網站：加、改、移除；詳細頁；編輯論點

describe('T85 甲 ③：網站的候補那一塊', () => {
  it('加候補：當場抓價格；帳戶頁回候補那幾列；論點檔 OPEN 寫進 log；不下單、不發通知、不開 AI', async () => {
    await withWorld(async (c) => {
      const notifs = (await acctOf(c.db)).notifs.length;
      const r = await c.api<{ ok: boolean; ticker: string; recommended: number }>('POST', 'ops/watch-add', { ticker: 'zzzw', note: '一句話', stdWeight: '' });
      expect(r.status).toBe(200);
      expect(r.body.ticker).toBe('ZZZW');
      expect(r.body.recommended).toBeGreaterThan(0);
      const a = await acctOf(c.db);
      expect(a.watch!.ZZZW).toMatchObject({ fileId: 'ZZZW@2026-11-19', stdWeight: null, buyNote: { text: '一句話' } });
      expect(a.notifs.length).toBe(notifs);
      expect(c.fire.n).toBe(0);
      expect(c.w.calls.some((u) => u.includes('/chart/ZZZW'))).toBe(true);
      expect(await logOf(c.db, 'ZZZW')).toEqual([{ file_id: 'ZZZW@2026-11-19', kind: 'OPEN', session: '2026-11-19', body: { origin: 'WATCH', premises: a.watch!.ZZZW.premises, stdWeight: null, buyNote: { text: '一句話', at: '2026-11-19' } } }]);
      const st = (await c.api<StateView>('GET', 'state')).body;
      expect(st.account!.watchMax).toBe(5);
      expect(st.account!.watch).toEqual([
        expect.objectContaining({ ticker: 'ZZZW', addedAt: '2026-11-19', note: '一句話', stdWeight: null, priceMissing: false, kind: 'DEFAULT_ONLY', entries: [], blocked: null, lastListed: null }),
      ]);
      expect(st.account!.watch[0].recWeight).toBeCloseTo(r.body.recommended, 10);
      expect(st.account!.watch[0].price).toBeGreaterThan(0);
      // 候補不在自選那一區、不算進自選桶
      expect(st.account!.holdings.some((x) => x.ticker === 'ZZZW')).toBe(false);
      expect(st.account!.ownTickers).toEqual(['NVDA']);
      // dry：只試、不存
      expect((await c.api('POST', 'ops/watch-add', { ticker: 'AMD', dry: true })).status).toBe(200);
      expect((await acctOf(c.db)).watch!.AMD).toBeUndefined();
    });
  });

  it('擋下的情況都回 422、訊息指到對的地方：打錯的代號、歷史不夠、核心的標的、已在自選、重複、滿 5 檔；候補中的代號不能「新增自選」', async () => {
    await withWorld(async (c) => {
      c.w.fail.add('BADX');
      c.w.bars.NEWCO = 50;
      const add = (ticker: string, o: Record<string, unknown> = {}) => c.api<{ error: string }>('POST', 'ops/watch-add', { ticker, ...o });
      const e = async (p: Promise<{ status: number; body: { error: string } }>) => {
        const r = await p;
        expect(r.status).toBe(422);
        return r.body.error;
      };
      expect(await e(add('BADX'))).toContain('抓不到 BADX');
      expect(await e(add('NEWCO'))).toContain('不到 200 個交易日');
      expect(await e(add('VOO'))).toContain('核心的標的');
      expect(await e(add('NVDA'))).toContain('已經在自選裡了');
      expect(await e(add('AMD', { stdWeight: 0.9 }))).toContain('標準比重最多 15%（單檔上限）');
      expect(await e(add('AMD', { stdWeight: 0.4 }))).toContain('標準比重最多 15%（單檔上限）');
      for (const t of ['AMD', 'MSFT', 'AAPL', 'META', 'GOOGL']) expect((await add(t)).status).toBe(200);
      expect(await e(add('AMD'))).toContain('已經在候補名單裡了');
      expect(await e(add('AMZN'))).toContain('候補最多 5 檔');
      const own = await c.api<{ error: string }>('POST', 'ops/add-own', { ticker: 'AMD', dry: true });
      expect(own.status).toBe(422);
      expect(own.body.error).toContain('AMD 在候補名單裡');
      expect(own.body.error).toContain('填快照');
      expect(Object.keys((await acctOf(c.db)).watch!)).toEqual(['AMD', 'MSFT', 'AAPL', 'META', 'GOOGL']);
    });
  });

  it('改比重（空的 = 改回留空）、改那一句話；移除：論點檔結案寫 CLOSE；不在候補的 422', async () => {
    await withWorld(async (c) => {
      expect((await c.api('POST', 'ops/watch-add', { ticker: 'AMD' })).status).toBe(200);
      expect((await c.api('POST', 'ops/watch-update', { ticker: 'AMD', stdWeight: 0.4 })).status).toBe(422);
      expect((await c.api('POST', 'ops/watch-update', { ticker: 'AMD', stdWeight: 0.05 })).status).toBe(200);
      expect((await acctOf(c.db)).watch!.AMD.stdWeight).toBe(0.05);
      expect((await c.api('POST', 'ops/watch-update', { ticker: 'AMD', stdWeight: '' })).status).toBe(200);
      expect((await acctOf(c.db)).watch!.AMD.stdWeight).toBeNull();
      expect((await c.api('POST', 'ops/watch-update', { ticker: 'AMD', note: '新的一句話' })).status).toBe(200);
      expect((await acctOf(c.db)).watch!.AMD.buyNote).toEqual({ text: '新的一句話', at: '2026-11-19' });
      expect((await c.api('POST', 'ops/watch-update', { ticker: 'AMD' })).status).toBe(422);
      expect((await c.api('POST', 'ops/watch-update', { ticker: 'MSFT', stdWeight: 0.05 })).status).toBe(422);
      expect((await c.api('POST', 'ops/watch-remove', { ticker: 'AMD' })).status).toBe(200);
      const a = await acctOf(c.db);
      expect(a.watch).toEqual({});
      expect(a.ownClosed!.AMD).toMatchObject({ fileId: 'AMD@2026-11-19', reason: 'WATCH_REMOVED' });
      expect((await logOf(c.db, 'AMD')).map((l) => [l.kind, l.body.reason ?? l.body.origin])).toEqual([
        ['OPEN', 'WATCH'],
        ['CLOSE', 'WATCH_REMOVED'],
      ]);
      expect((await c.api('POST', 'ops/watch-remove', { ticker: 'AMD' })).status).toBe(422);
    });
  });

  it('詳細頁沿用持股頁：多 watch、own 是論點那一份（慢規則的欄位中性）；可以手動編輯論點，存在候補身上；討論包、草稿都讀得到', async () => {
    await withWorld(async (c) => {
      expect((await c.api('POST', 'ops/watch-add', { ticker: 'AMD', note: '第二供應商', stdWeight: 0.04 })).status).toBe(200);
      const hd = (await c.api<HoldingDetail & { thesis: unknown; attention: unknown[] }>('GET', 'holding/AMD')).body;
      expect(hd.watch).toMatchObject({ ticker: 'AMD', addedAt: '2026-11-19', note: '第二供應商', stdWeight: 0.04, max: 5, count: 1 });
      expect(hd.own).toMatchObject({ state: '候補', kind: 'DEFAULT_ONLY', build: null, askBuild: false, stdWeight: 0.04, weight: 0, half: false, pendingBreak: null, prev: null, buyNote: { text: '第二供應商' } });
      expect(hd.own!.premises.map((p) => p.system)).toEqual([true, true, true]);
      expect(hd.positions).toEqual([]);
      expect(hd.canRemove).toBe(false);
      expect(hd.attention).toEqual([]);
      expect(hd.thesis).not.toBeNull();
      // 自選的詳細頁沒有 watch
      expect((await c.api<HoldingDetail>('GET', 'holding/NVDA')).body.watch).toBeNull();
      // 手動編輯論點（不送出場條件 → 不開 AI）
      const r = await c.api<{ ok: boolean; rewrite: { status: string } }>('POST', 'ops/own-thesis', { ticker: 'AMD', thesis: '想等資料中心營收證實再買', premises: [{ text: 'MI300 的訂單持續成長' }], exitConditions: [], source: 'TYPED' });
      expect(r.status).toBe(200);
      expect(r.body.rewrite.status).toBe('NONE');
      const a = await acctOf(c.db);
      expect(a.watch!.AMD.thesis).toMatchObject({ text: '想等資料中心營收證實再買', version: 1, source: 'TYPED' });
      expect(a.watch!.AMD.premises.map((p) => p.text)).toEqual(['MI300 的訂單持續成長']);
      expect(a.own.AMD).toBeUndefined();
      expect((await logOf(c.db, 'AMD')).map((l) => l.kind)).toEqual(['OPEN', 'THESIS']);
      expect(c.fire.n).toBe(0);
      // 讀論點檔的地方都走 fileMeta
      const tf = await thesisFile(c.db, a, 'AMD', '2026-11-19');
      expect(tf).toMatchObject({ ticker: 'AMD', fileId: 'AMD@2026-11-19', origin: 'WATCH', kind: 'THESIS', disputes: [], flags: [] });
      expect(metaFile(a, 'AMD', '2026-11-19')).toMatchObject({ origin: 'WATCH', kind: 'THESIS' });
      expect(await fileConditions(c.db, a, 'AMD')).toEqual([]);
      const disc = await c.api<{ text: string }>('GET', 'own/AMD/discussion');
      expect(disc.status).toBe(200);
      expect(disc.body.text).toContain('MI300 的訂單持續成長');
      const dr = await c.api<{ draft: unknown; state: unknown }>('GET', 'own/AMD/draft');
      expect(dr.status).toBe(200);
      expect(dr.body.draft).toBeNull();
      // 草稿狀態含候補；候補現在 0 股，不會是「下一次流程會自動草擬」
      const st = draftStateOf([], a, 'AMD', new Date('2026-11-20T02:00:00Z'), '2026-11-19', true);
      expect(st).toMatchObject({ ready: null, pending: null, autoSoon: false });
      const hd2 = (await c.api<HoldingDetail>('GET', 'holding/AMD')).body;
      expect(hd2.own).toMatchObject({ kind: 'THESIS', thesis: { text: '想等資料中心營收證實再買', version: 1 } });
    });
  });
});

// ---------------------------------------------------------------- 4. 每日流程

// T85 丙段改了兩件（allocation_redesign §4.5 第 18、22 點）：加入 7 天內的那一次自動草擬會開（受 DRAFT_AUTO_DAILY 限制）；
// EDGAR 申報清單的代號 = 掃描目標 ∪ 候補。其他 AI（審查、掃描、硬事件、新眼光、條件確認）照樣不替候補開。
describe('T85 甲 ④：每日流程多抓候補的價格，但不多跑任何 AI', () => {
  it('候補的價格放「追蹤」：壞代號不擋整天的訊號；不進掃描、除了加入時那一次自動草擬不開任何任務', async () => {
    await withWorld(async (c) => {
      expect((await c.api('POST', 'ops/watch-add', { ticker: 'ZZZW' })).status).toBe(200);
      // 加進候補之後才下市（Yahoo 回 500）
      const loaded = (await loadAccount(c.db))!;
      const a = addWatch(loaded.acct, c.view, 'BADX');
      await saveAccount(c.db, a, loaded, '測試', new Date('2026-11-20T03:00:00Z'));
      c.w.fail.add('BADX');
      c.w.dataDate = '2026-11-20';
      c.w.calls.length = 0;
      const r = await runFlow(c.env, c.fetcher, { now: cronTime('2026-11-20'), attempt: 'FIRST' });
      expect(r.status).toBe('DONE');
      expect(r.processed).toEqual(['2026-11-20']);
      expect(r.alerts.join('\n')).not.toMatch(/BADX/);
      // 兩檔都有去抓；抓到的那一檔有最新的收盤
      expect(c.w.calls.some((u) => u.includes('/chart/ZZZW'))).toBe(true);
      expect(c.w.calls.some((u) => u.includes('/chart/BADX'))).toBe(true);
      expect((await loadSeries(c.db, ['ZZZW'])).get('ZZZW')?.d.at(-1)).toBe('2026-11-20');
      const runs = (await c.db.prepare("SELECT COUNT(*) AS n FROM ai_runs WHERE ticker IN ('ZZZW', 'BADX')").first<{ n: number }>())!.n;
      const drafts = (await c.db.prepare("SELECT COUNT(*) AS n FROM own_drafts WHERE ticker IN ('ZZZW', 'BADX')").first<{ n: number }>())!.n;
      // 丙段：只有加入時那一次自動草擬（兩檔，DRAFT_AUTO_DAILY = 2）；沒有審查、掃描、硬事件、條件確認
      expect(drafts).toBe(2);
      expect(runs).toBe(2);
      expect((await c.db.prepare("SELECT COUNT(*) AS n FROM ai_runs WHERE ticker IN ('ZZZW', 'BADX') AND fn != 'OWN_DRAFT'").first<{ n: number }>())!.n).toBe(0);
      expect((await c.db.prepare("SELECT COUNT(*) AS n FROM sec_events WHERE ticker IN ('ZZZW', 'BADX')").first<{ n: number }>())!.n).toBe(0);
      const after = await acctOf(c.db);
      expect(Object.keys(after.watch!).sort()).toEqual(['BADX', 'ZZZW']);
      // 帳戶頁：抓不到價格的那一檔寫出來，其他照常
      const st = (await c.api<StateView>('GET', 'state')).body;
      expect(st.account!.watch.find((x) => x.ticker === 'BADX')).toMatchObject({ priceMissing: true, price: null, recWeight: null });
      expect(st.account!.watch.find((x) => x.ticker === 'ZZZW')).toMatchObject({ priceMissing: false });
    });
  });

  it('剛加的候補（沒有論點、7 天內）：丙段起由 startWatchDrafts 自動草擬一次（新自選那一段不碰它）', async () => {
    await withWorld(async (c) => {
      expect((await c.api('POST', 'ops/watch-add', { ticker: 'AMD' })).status).toBe(200);
      const acct = await acctOf(c.db);
      const res = { created: [], started: [] as string[], log: [] as string[], alerts: [] };
      await startAutoDrafts({ env: c.env, fetcher: c.fetcher, acct, view: c.view, axis: [], session: '2026-11-19', ov: {}, now: new Date('2026-11-20T01:00:00Z'), checks: [], res, extras: {} });
      expect(res.started).toHaveLength(1);
      expect(res.started[0]).toContain('OWN_DRAFT_AMD');
      expect(res.log.join('\n')).toContain('AMD：新加進候補，自動草擬論點與進場條件');
      expect(res.log.join('\n')).not.toContain('新的自選，自動草擬');
      expect(c.fire.n).toBe(1);
    });
  });
});
