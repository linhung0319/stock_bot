// T44：賣光再買回，接上一次持有時的論點（own_thesis §1.2，2026-11-16 使用者同意改）。
// 完成條件：
//   1. 賣光再買回 → 持股頁有上一份的論點（本文、自己的前提、當時監測中的出場條件、結案原因）；「還沒有論點的自選」那一行寫上次有論點
//   2. 討論包多一節「## 上一次持有時的論點」、NEW 情境從上次為什麼賣問起；沒有結案過的不出現
//   3. 「帶入上次的論點」：前提當成新的（存檔後是這一份的新編號）、出場條件不帶
//   4. L2 的證據包不帶上一份；舊條件沒有因為買回而恢復監測
// 對外請求全部是假的：價格（固定檔）、EDGAR、Nasdaq RSS、雲端排程、LINE。
import { describe, expect, it } from 'vitest';
import { discussionPack, type DiscussionNumbers } from '../src/ai/discussion';
import type { Env, Fetcher } from '../src/app/env';
import { runFlow } from '../src/app/flow';
import { LINE_PUSH_URL } from '../src/app/line';
import { loadAccount, saveAccount } from '../src/app/ledgerStore';
import { startOwnReview } from '../src/app/ownAi';
import { fileConditions, loadConditions, metaFile, prevFileOf, type PrevFile } from '../src/app/thesis';
import type { HoldingDetail, SnapshotForm, StateView, ThesisTodoRow } from '../src/app/site/views';
import { buildMarketView } from '../src/data/marketView';
import { loadSeries } from '../src/data/store';
import { SYSTEM_DEFAULT_PREMISES, closedThesisOf, createAccount, type Account, type MarketView } from '../src/engine';
import { handle } from '../src/index';
import { freshDb } from './helpers/d1';
import { cronTime, fakeFetcher, newWorld, type World } from './helpers/fakeSources';

function fetcherOf(w: World): Fetcher {
  const base = fakeFetcher(w);
  return async (url, init) => {
    if (url === LINE_PUSH_URL) return Response.json({});
    if (url === 'https://api.example/fire') return Response.json({ claude_code_session_url: 'https://claude.ai/code/x' });
    if (/data\.sec\.gov\/submissions\/CIK\d+\.json/.test(url)) return Response.json({ cik: '1045810', name: 'NVIDIA CORP', tickers: ['NVDA'], filings: { recent: { accessionNumber: [], form: [], items: [], acceptanceDateTime: [], filingDate: [], primaryDocument: [] } } });
    if (/companyfacts\/CIK\d+\.json/.test(url)) return Response.json({ cik: 1045810, facts: {} });
    if (url.startsWith('https://www.nasdaq.com/feed/rssoutbound')) return new Response('<rss><channel></channel></rss>');
    return base(url, init);
  };
}

interface Ctx {
  db: D1Database;
  env: Env;
  fetcher: Fetcher;
  viewAt: (date: string) => Promise<{ view: MarketView; axis: string[] }>;
  api: <T = Record<string, unknown>>(method: 'GET' | 'POST', path: string, body?: unknown) => Promise<{ status: number; body: T }>;
}

const FILE = 'NVDA@2026-11-19';
const THESIS_TEXT = '上一次的論點：資料中心的 GPU 需求會延續到 2027 年';
const USER_PREMISES = [
  { id: 'P4', text: '上一次的前提：資料中心需求延續到 2027', origin: 'USER' as const },
  { id: 'P5', text: '上一次的前提：毛利率維持在 65% 以上', origin: 'USER' as const },
];
const GM = { type: 'xbrl_metric_below', metric: 'GrossMarginPct', level: 0.6, quarters: 2 };

/** NVDA 是自選、有論點本文與兩條自己的前提；opt.plain：只有系統預設前提、沒有本文。 */
async function withWorld(fn: (c: Ctx) => Promise<void>, opt: { plain?: boolean } = {}) {
  const d = await freshDb();
  try {
    const db = d.db;
    const w = newWorld('2026-11-19');
    const env: Env = { DB: db, ADMIN_TOKEN: 't', AI_TASK_SECRET: 's', EDGAR_USER_AGENT: 'test bot test@example.com', SITE_URL: 'https://bot.example', LINE_CHANNEL_TOKEN: 'lt', LINE_USER_ID: 'U1', DEV_NO_AUTH: '1', ROUTINE_FIRE_URL: 'https://api.example/fire', ROUTINE_TOKEN: 'rt' };
    const fetcher = fetcherOf(w);
    const viewAt = async (date: string) => buildMarketView(await loadSeries(db, ['VOO', 'SGOV', 'NVDA']), date, 'VOO');
    const api: Ctx['api'] = async (method, path, body) => {
      const r = await handle(new Request(`https://bot.example/api/${path}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env, fetcher, new Date('2026-11-20T02:00:00Z'));
      return { status: r.status, body: (await r.json()) as never };
    };
    w.dataDate = '2026-11-19';
    await runFlow(env, fetcher, { now: cronTime('2026-11-19'), attempt: 'FIRST' });
    const { view } = await viewAt('2026-11-19');
    const acct = createAccount(
      {
        paper: true,
        cash: 5000,
        core: { VOO: Math.floor(140_000 / view.close.VOO[view.i]) },
        own: { NVDA: { shares: Math.floor(40_000 / view.close.NVDA[view.i]), stdWeight: 0.15, premises: opt.plain ? structuredClone(SYSTEM_DEFAULT_PREMISES) : structuredClone(USER_PREMISES) } },
      },
      view,
    );
    if (!opt.plain) acct.own.NVDA.thesis = { text: THESIS_TEXT, setAt: '2026-11-19', source: 'DISCUSSION', version: 3, afterBreak: 0, lastAfterBreakAt: null };
    await saveAccount(db, acct, null, '建立帳戶', new Date('2026-11-19T12:00:00Z'));
    await fn({ db, env, fetcher, viewAt, api });
  } finally {
    await d.dispose();
  }
}

/** 你定的條件（上一份論點檔的）：監測中、已成立、已撤下各一條。 */
async function seedConds(db: D1Database) {
  const ins = (text: string, status: string, action: string, metAt: string | null) =>
    db
      .prepare('INSERT INTO own_conditions (ticker, run_id, cond_id, direction, kind, text, check_json, tier_if_met, status, created_at, met_at, origin, file_id, accepted_at, action, auto) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind('NVDA', 'r0', 'U1', 'DOWN', 'XBRL', text, JSON.stringify(GM), action, status, '2026-11-19T12:00:00.000Z', metAt, 'USER', FILE, '2026-11-19T12:00:00.000Z', action, 1)
      .run();
  await ins('上一次的條件：毛利率連兩季低於 60%', 'ACTIVE', 'EXIT', null);
  await ins('上一次的條件：營收年減', 'MET', 'HALF', '2026-11-19T13:00:00.000Z');
  await ins('上一次撤下的條件', 'RETIRED', 'REVIEW', null);
}

/** 用網站的快照把自選的 NVDA 改成 n 股（現金照收盤價調整，不留差額）。 */
async function snapshotNvda(c: Ctx, n: number, why?: string) {
  const form = (await c.api<SnapshotForm>('GET', 'snapshot/form')).body;
  const lots: Record<'own' | 'mom' | 'core', Record<string, number>> = { own: {}, mom: {}, core: {} };
  for (const b of ['own', 'mom', 'core'] as const) for (const r of form.buckets[b]) lots[b][r.ticker] = r.expected;
  const { view } = await c.viewAt('2026-11-19');
  const px = view.close.NVDA[view.i];
  const had = lots.own.NVDA ?? 0;
  lots.own.NVDA = n;
  return c.api<{ removedOwn: string[]; newOwn: string[]; newOwnRows: ThesisTodoRow[] }>('POST', 'snapshot', { lots, cash: form.cashBook + (had - n) * px, ...(why ? { why: { NVDA: why } } : {}) });
}

/** 賣光再買回（同一天；新的論點檔編號是 #2）。 */
async function sellAndRebuy(c: Ctx, why?: string) {
  const sold = await snapshotNvda(c, 0);
  expect(sold.status).toBe(200);
  expect(sold.body.removedOwn).toEqual(['NVDA']);
  const back = await snapshotNvda(c, 20, why);
  expect(back.status).toBe(200);
  expect(back.body.newOwn).toEqual(['NVDA']);
  return back.body;
}

// 網頁用的純函式（不碰 DOM）：和 t39b 的 replyOption 一樣直接 import
type PrevFill = (prev: Partial<PrevFile> | null | undefined) => { thesis: string; premises: { id: null; text: string }[] } | null;
const prevFill: PrevFill = ((await import('../public/js/thesis-prev.js' as string)) as { prevFill: PrevFill }).prevFill;

const NUMS: DiscussionNumbers = { date: '2026-11-19', close: 181.23, fromHigh: -0.12, ma200: 160.5, vsMa: 0.129, slow: 'STD', ret1y: 0.42, weight: 0.062, stdWeight: 0.05, ownTotal: 0.23, ownBudget: 0.2, xbrl: null, openedHalf: null };

// ---------------------------------------------------------------- 1. 持股頁與「還沒有論點的自選」

describe('T44 ①：賣光再買回，持股頁看得到上一次持有時的論點', () => {
  it('結案時記下那一刻的論點本文與自己的前提（ownClosed.last）；系統預設前提不算', () => {
    const last = closedThesisOf({ thesis: { text: 'x', setAt: '2026-11-01', source: 'TYPED', version: 2, afterBreak: 0, lastAfterBreakAt: null }, premises: [...structuredClone(SYSTEM_DEFAULT_PREMISES), USER_PREMISES[0]] });
    expect(last).toEqual({ thesis: { text: 'x', setAt: '2026-11-01', version: 2 }, premises: [{ id: 'P4', text: USER_PREMISES[0].text }] });
    expect(closedThesisOf({ thesis: null, premises: structuredClone(SYSTEM_DEFAULT_PREMISES) })).toEqual({ thesis: null, premises: [] });
  });

  it('持股頁：上一份的論點本文、自己的前提、當時監測中與已成立的出場條件、結案原因；這一份仍是「只有預設」', async () => {
    await withWorld(async (c) => {
      await seedConds(c.db);
      const r = await sellAndRebuy(c, '這次是因為新的推論晶片');
      const acct = (await loadAccount(c.db))!.acct;
      expect(acct.own.NVDA.fileId).toBe(`${FILE}#2`);
      expect(acct.ownClosed!.NVDA).toMatchObject({ fileId: FILE, reason: 'SOLD_OUT', date: '2026-11-19', last: { thesis: { text: THESIS_TEXT, version: 3 }, premises: USER_PREMISES.map((p) => ({ id: p.id, text: p.text })) } });

      const hd = (await c.api<HoldingDetail>('GET', 'holding/NVDA')).body;
      expect(hd.own!.kind).toBe('DEFAULT_ONLY');
      const prev = hd.own!.prev!;
      expect(prev).toMatchObject({ fileId: FILE, openedAt: '2026-11-19', closedAt: '2026-11-19', reason: 'SOLD_OUT', reasonText: '自己賣光', closedVerb: '賣光', hasThesis: true, thesis: { text: THESIS_TEXT, version: 3 } });
      expect(prev.premises.map((p) => p.text)).toEqual(USER_PREMISES.map((p) => p.text));
      // 當時監測中的（ACTIVE）與已成立的（MET）列出來；撤下的不列
      expect(prev.conditions).toEqual([
        { text: '上一次的條件：毛利率連兩季低於 60%', action: 'EXIT', state: 'LIVE', note: '監測中' },
        { text: '上一次的條件：營收年減', action: 'HALF', state: 'MET', note: '2026-11-19 成立' },
      ]);
      // 「還沒有論點的自選」：快照結果頁那一行與帳戶頁的清單都寫上次有論點
      expect(r.newOwnRows).toEqual([{ ticker: 'NVDA', buyNote: { text: '這次是因為新的推論晶片', at: '2026-11-19' }, prev: { closedAt: '2026-11-19', closedVerb: '賣光' } }]);
      const st = (await c.api<StateView>('GET', 'state')).body;
      expect(st.thesisTodo).toEqual([{ ticker: 'NVDA', buyNote: { text: '這次是因為新的推論晶片', at: '2026-11-19' }, prev: { closedAt: '2026-11-19', closedVerb: '賣光' } }]);
    });
  });

  it('沒有結案過的不出現：持股頁 prev 是 null、清單那一行沒有 prev；上一次沒有寫論點的，清單不寫「有論點」但持股頁仍列結案原因', async () => {
    // 從來沒有結案過
    await withWorld(async (c) => {
      const hd = (await c.api<HoldingDetail>('GET', 'holding/NVDA')).body;
      expect(hd.own!.prev).toBeNull();
      const acct = (await loadAccount(c.db))!.acct;
      expect(prevFileOf(acct, 'NVDA')).toBeNull();
    });
    // 上一次只有系統預設前提、沒有本文
    await withWorld(
      async (c) => {
        const r = await sellAndRebuy(c);
        expect(r.newOwnRows).toEqual([{ ticker: 'NVDA', buyNote: null }]);
        const hd = (await c.api<HoldingDetail>('GET', 'holding/NVDA')).body;
        expect(hd.own!.prev).toMatchObject({ hasThesis: false, thesis: null, premises: [], reasonText: '自己賣光', conditions: [] });
      },
      { plain: true },
    );
  });
});

// ---------------------------------------------------------------- 2. 討論包

describe('T44 ②：討論包多一節「上一次持有時的論點」', () => {
  it('賣光再買回 → NEW，帶上一份的論點、前提（不帶編號）、當時的出場條件與結案原因，從上次為什麼賣問起', async () => {
    await withWorld(async (c) => {
      await seedConds(c.db);
      await sellAndRebuy(c);
      const r = await c.api<{ text: string; mode: string }>('GET', 'own/NVDA/discussion');
      expect(r.status).toBe(200);
      expect(r.body.mode).toBe('NEW');
      const t = r.body.text;
      expect(t).toContain('## 上一次持有時的論點');
      expect(t).toContain('這是上一次持有時的論點與賣出的原因，不一定還成立；請拿來比較這次買回的理由。');
      expect(t).toContain('持有期間：2026-11-19 開檔 → 2026-11-19 賣光（原因：自己賣光）');
      expect(t).toContain(`論點（第 3 版，2026-11-19 定）：\n${THESIS_TEXT}`);
      expect(t).toContain(`- ${USER_PREMISES[0].text}`);
      expect(t).not.toMatch(/P4\. 上一次的前提|\[P4\]/); // 上一份的前提不帶編號
      expect(t).toContain('當時監測中的出場條件（買回後不會再監測）：\n- 上一次的條件：毛利率連兩季低於 60% → 出清（監測中）');
      expect(t).toContain('- 上一次的條件：營收年減 → 減半（2026-11-19 成立）');
      expect(t).not.toContain('上一次撤下的條件');
      expect(t).toContain('請先問我：上次為什麼賣、這次為什麼買回');
      expect(t).not.toContain('請先問我 3 個問題');
      // 位置：這次為什麼討論 → 上一次持有時的論點 → 我的論點；這一份的論點與出場條件仍是「還沒有」
      expect(t.indexOf('## 這次為什麼討論')).toBeLessThan(t.indexOf('## 上一次持有時的論點'));
      expect(t.indexOf('## 上一次持有時的論點')).toBeLessThan(t.indexOf('## 我的論點'));
      expect(t.slice(t.indexOf('## 我的論點'), t.indexOf('## 前提')).trim()).toBe('## 我的論點\n還沒有');
      expect(t.slice(t.indexOf('## 出場條件'), t.indexOf('## 上次審查之後的事件')).trim()).toBe('## 出場條件\n還沒有');
      expect(t).toContain('discussion_v3');
    });
  });

  it('沒有結案過的不出現；示範模式（只有帳戶狀態）不列出場條件；上一次沒有寫論點時寫明', async () => {
    await withWorld(async (c) => {
      const t = (await c.api<{ text: string }>('GET', 'own/NVDA/discussion')).body.text;
      expect(t).not.toContain('上一次持有時');
    });
    const own = { NVDA: { premises: structuredClone(SYSTEM_DEFAULT_PREMISES), thesis: null, fileId: `${FILE}#2`, origin: 'MANUAL', flags: [], buyNote: { text: '這次的一句話', at: '2026-11-19' } } as never };
    const acct = { own, ownClosed: { NVDA: { fileId: FILE, reason: 'EXIT_AI' as const, date: '2026-11-19' } } };
    const prev = prevFileOf(acct, 'NVDA')!; // T44 之前結案的（沒有 last）當成沒有記到論點；條件沒有讀
    expect(prev).toMatchObject({ hasThesis: false, conditions: null, reasonText: 'AI 審查建議出清，你照做', closedVerb: '出清' });
    const t = discussionPack(metaFile(acct, 'NVDA', '2026-11-19')!, NUMS, 'NEW', null, prev);
    expect(t).toContain('那一次沒有寫下論點（只用系統預設前提做一般健康檢查）。');
    expect(t).not.toContain('出場條件（買回後');
    expect(t).not.toContain('那一次沒有定出場條件');
    // 有買進時的一句話也一起提到；順序：我買進時的想法 → 上一次持有時的論點
    expect(t).toContain('「我買進時的想法」是這次買的時候隨手寫的一句話。');
    expect(t.indexOf('## 我買進時的想法')).toBeLessThan(t.indexOf('## 上一次持有時的論點'));
    // 例行檢視（這一份已經有論點）也放這一節，但開場照舊
    const r = discussionPack(metaFile(acct, 'NVDA', '2026-11-19')!, NUMS, 'ROUTINE', null, prev);
    expect(r).toContain('## 上一次持有時的論點');
    expect(r).toContain('例行檢視。');
    expect(r).not.toContain('上次為什麼賣');
  });
});

// ---------------------------------------------------------------- 3. 帶入上次的論點

describe('T44 ③：編輯論點頁「帶入上次的論點」', () => {
  it('prevFill：本文與前提填進右邊、前提不帶編號、沒有出場條件；上一份沒有論點 → 不給按鈕', () => {
    const p = { hasThesis: true, thesis: { text: THESIS_TEXT, setAt: '2026-11-19', version: 3 }, premises: USER_PREMISES.map((x) => ({ id: x.id, text: x.text })) } as unknown as PrevFile;
    const f = prevFill(p)!;
    expect(f).toEqual({ thesis: THESIS_TEXT, premises: USER_PREMISES.map((x) => ({ id: null, text: x.text })) });
    expect(Object.keys(f)).not.toContain('exits');
    expect(prevFill({ ...p, hasThesis: false, thesis: null, premises: [] })).toBeNull();
    expect(prevFill(null)).toBeNull();
  });

  it('帶入之後存檔：前提是這一份的新編號（不是上一份的 P4、P5，也不和系統預設撞號）、沒有出場條件、不送改寫', async () => {
    await withWorld(async (c) => {
      await seedConds(c.db);
      await sellAndRebuy(c);
      const hd = (await c.api<HoldingDetail>('GET', 'holding/NVDA')).body;
      const f = prevFill(hd.own!.prev)!;
      const before = (await loadAccount(c.db))!.acct.own.NVDA;
      expect(before.premises.map((p) => p.id)).toEqual(['P1', 'P2', 'P3']); // 新的一份從系統預設開始
      const saved = await c.api<{ ok: boolean; preview: { added: { id: string; text: string }[]; kept: unknown[]; edited: unknown[] }; rewrite: { status: string } }>('POST', 'ops/own-thesis', { ticker: 'NVDA', thesis: f.thesis, premises: f.premises, exitConditions: [], source: 'TYPED' });
      expect(saved.status).toBe(200);
      expect(saved.body.preview.kept).toEqual([]);
      expect(saved.body.preview.edited).toEqual([]);
      expect(saved.body.rewrite.status).toBe('NONE');
      const after = (await loadAccount(c.db))!.acct.own.NVDA;
      expect(after.fileId).toBe(`${FILE}#2`);
      expect(after.thesis).toMatchObject({ text: THESIS_TEXT, version: 1 });
      expect(after.premises.map((p) => ({ id: p.id, text: p.text, origin: p.origin }))).toEqual([
        { id: 'P4', text: USER_PREMISES[0].text, origin: 'USER' },
        { id: 'P5', text: USER_PREMISES[1].text, origin: 'USER' },
      ]);
      expect(after.premises.every((p) => p.addedAt === '2026-11-19')).toBe(true);
      // 出場條件沒有帶：新的一份沒有任何條件、也沒有送改寫
      expect(await fileConditions(c.db, (await loadAccount(c.db))!.acct, 'NVDA')).toEqual([]);
      expect((await c.db.prepare("SELECT COUNT(*) AS n FROM ai_runs WHERE fn = 'OWN_CHECK'").first<{ n: number }>())!.n).toBe(0);
    });
  });
});

// ---------------------------------------------------------------- 4. 證據包與舊條件

describe('T44 ④：L2 的證據包不帶上一份；舊條件不恢復監測', () => {
  it('買回後的定期審查證據包沒有上一份的論點本文、前提與條件；前提只有這一份的系統預設', async () => {
    await withWorld(async (c) => {
      await seedConds(c.db);
      await sellAndRebuy(c);
      const { view, axis } = await c.viewAt('2026-11-19');
      const acct = (await loadAccount(c.db))!.acct;
      const run = await startOwnReview(c.env, c.fetcher, acct, view, axis, 'NVDA', 'MANUAL', new Date('2026-11-20T01:00:00Z'));
      const pack = JSON.stringify(run.pack);
      expect(pack).not.toContain('上一次的論點');
      expect(pack).not.toContain('上一次的前提');
      expect(pack).not.toContain('上一次的條件');
      expect(run.pack.premises.every((p) => SYSTEM_DEFAULT_PREMISES.some((d) => d.text === p.text))).toBe(true);
    });
  });

  it('舊條件：資料庫裡照原樣留著，但這一份讀不到、持股頁不列、編輯論點頁不預填', async () => {
    await withWorld(async (c) => {
      await seedConds(c.db);
      await sellAndRebuy(c);
      const acct = (await loadAccount(c.db))!.acct;
      // 舊的列沒有被改（仍是 ACTIVE），只是屬於上一份論點檔
      expect((await loadConditions(c.db, 'NVDA', FILE)).map((x) => x.status)).toEqual(['ACTIVE', 'MET', 'RETIRED']);
      expect(await fileConditions(c.db, acct, 'NVDA')).toEqual([]);
      const hd = (await c.api<HoldingDetail & { monitor: { text: string }[] }>('GET', 'holding/NVDA')).body;
      expect(hd.monitor).toEqual([]);
      // 編輯論點頁預填的「目前監測中」來自 monitor：空的 → 存檔時不會把舊條件當成這一份的
      const saved = await c.api<{ preview: { exits: { live: number; changed: boolean } } }>('POST', 'ops/own-thesis', { ticker: 'NVDA', thesis: '這次買回的理由', premises: [{ text: '推論晶片的訂單成長' }], exitConditions: [], source: 'TYPED', dry: true });
      expect(saved.body.preview.exits).toMatchObject({ live: 0, changed: false });
    });
  });
});

// 型別檢查用：Account 的 ownClosed 帶 last
const _typecheck: Pick<Account, 'ownClosed'> = { ownClosed: { NVDA: { fileId: FILE, reason: 'SOLD_OUT', date: '2026-11-19', last: { thesis: null, premises: [] } } } };
void _typecheck;
