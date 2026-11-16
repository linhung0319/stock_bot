// T45：自選論點的畫面與文字小修（T41 第 2、8、9、10、11、12 條，2026-11-16 使用者同意）。
// 有邏輯的各一個以上的測試（純文字的用截圖驗）：
//   1. 只寫論點本文、沒有自己的前提：預覽與存檔結果帶 defaultOnly（原本只有預設、這次也沒有自己的前提）
//   2. 轉入、認養、清單外買進歸自選也進「還沒有論點的自選」，回應帶同一張清單的列
//   3. 30 天內開過論點變動後的審查：預覽帶 reviewHeld（上次開的日子），和每日流程用同一個判斷
//   4. 快照新加自選、一開始就記成減半的列在結果（startsHalved）
//   5. 晚到否決的 LINE 補「排除會一直有效」（推播文字的完整斷言在 t32b-mom-entry.test.ts 的三個晚到否決測試）
// 對外請求全部是假的：價格（固定檔）、LINE。
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env, Fetcher } from '../src/app/env';
import { runFlow } from '../src/app/flow';
import { LINE_PUSH_URL } from '../src/app/line';
import { loadAccount, saveAccount } from '../src/app/ledgerStore';
import { EXCLUDE_LASTS } from '../src/app/momAi';
import { THESIS_REVIEW_GAP, thesisReviewHeld } from '../src/app/ownAi';
import { newOwnStartsHalved } from '../src/app/site/api';
import type { StateView, ThesisTodoRow } from '../src/app/site/views';
import { buildMarketView } from '../src/data/marketView';
import { loadSeries } from '../src/data/store';
import { SYSTEM_DEFAULT_PREMISES, createAccount, type Account } from '../src/engine';
import { handle } from '../src/index';
import { freshDb } from './helpers/d1';
import { cronTime, fakeFetcher, newWorld } from './helpers/fakeSources';
import { scenarios } from './helpers/scenarios';
import { Sim } from './helpers/sim';

// ---------------------------------------------------------------- 真實模式：NVDA 是自選、只有系統預設前提

interface Ctx {
  db: D1Database;
  api: <T = Record<string, unknown>>(method: 'GET' | 'POST', path: string, body?: unknown) => Promise<{ status: number; body: T }>;
  patchNvda: (fn: (a: Account) => void) => Promise<void>;
}

async function withWorld(fn: (c: Ctx) => Promise<void>) {
  const d = await freshDb();
  try {
    const db = d.db;
    const w = newWorld('2026-11-19');
    const base = fakeFetcher(w);
    const fetcher: Fetcher = async (url, init) => (url === LINE_PUSH_URL ? Response.json({}) : base(url, init));
    const env: Env = { DB: db, ADMIN_TOKEN: 't', SITE_URL: 'https://bot.example', LINE_CHANNEL_TOKEN: 'lt', LINE_USER_ID: 'U1', DEV_NO_AUTH: '1' };
    // 2026-11-20 02:00Z：訊號日是 11-19，下一次每日流程是 11-20
    const api: Ctx['api'] = async (method, path, body) => {
      const r = await handle(new Request(`https://bot.example/api/${path}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env, fetcher, new Date('2026-11-20T02:00:00Z'));
      return { status: r.status, body: (await r.json()) as never };
    };
    w.dataDate = '2026-11-19';
    await runFlow(env, fetcher, { now: cronTime('2026-11-19'), attempt: 'FIRST' });
    const { view } = buildMarketView(await loadSeries(db, ['VOO', 'SGOV', 'NVDA']), '2026-11-19', 'VOO');
    const acct = createAccount({ paper: true, cash: 5000, core: { VOO: Math.floor(140_000 / view.close.VOO[view.i]) }, own: { NVDA: { shares: Math.floor(40_000 / view.close.NVDA[view.i]), stdWeight: 0.15, premises: structuredClone(SYSTEM_DEFAULT_PREMISES) } } }, view);
    await saveAccount(db, acct, null, '建立帳戶', new Date('2026-11-19T12:00:00Z'));
    const patchNvda = async (f: (a: Account) => void) => {
      const loaded = (await loadAccount(db))!;
      f(loaded.acct);
      await saveAccount(db, loaded.acct, loaded, '測試改帳戶', new Date('2026-11-20T01:00:00Z'));
    };
    await fn({ db, api, patchNvda });
  } finally {
    await d.dispose();
  }
}

interface Preview {
  preview: { changed: boolean; defaultOnly: boolean; reviewHeld: string | null; added: { id: string }[] };
}

describe('第 1 項：只寫論點本文、沒有自己的前提', () => {
  it('原本只有預設、這次也沒有自己的前提 → defaultOnly（預覽與存檔結果）；寫了自己的前提、或原本就有自己的前提 → 不是', async () => {
    await withWorld(async (c) => {
      // 預覽：只寫本文
      let r = await c.api<Preview>('POST', 'ops/own-thesis', { ticker: 'NVDA', thesis: '資料中心的需求會延續', premises: [], exitConditions: [], dry: true });
      expect(r.status).toBe(200);
      expect(r.body.preview).toMatchObject({ changed: false, defaultOnly: true, reviewHeld: null });
      // 預覽：原樣送回系統預設前提（編輯頁沒有預填預設前提，但伺服器照收）也一樣
      r = await c.api<Preview>('POST', 'ops/own-thesis', { ticker: 'NVDA', thesis: '資料中心的需求會延續', premises: SYSTEM_DEFAULT_PREMISES.map((p) => ({ id: p.id, text: p.text })), exitConditions: [], dry: true });
      expect(r.body.preview.defaultOnly).toBe(true);
      // 預覽：寫了一條自己的前提 → 不是
      r = await c.api<Preview>('POST', 'ops/own-thesis', { ticker: 'NVDA', thesis: '資料中心的需求會延續', premises: [{ text: '資料中心需求延續到 2027' }], exitConditions: [], dry: true });
      expect(r.body.preview).toMatchObject({ changed: true, defaultOnly: false });
      // 存檔：只寫本文 → 結果同樣帶 defaultOnly，這檔仍是只有預設
      r = await c.api<Preview>('POST', 'ops/own-thesis', { ticker: 'NVDA', thesis: '資料中心的需求會延續', premises: [], exitConditions: [] });
      expect(r.status).toBe(200);
      expect(r.body.preview.defaultOnly).toBe(true);
      expect((await loadAccount(c.db))!.acct.own.NVDA.premises.every((p) => p.origin === 'SYSTEM_DEFAULT')).toBe(true);
      // 存一條自己的前提之後，再只改本文 → 不是（原本就有自己的前提）
      await c.api('POST', 'ops/own-thesis', { ticker: 'NVDA', thesis: '資料中心的需求會延續', premises: [{ text: '資料中心需求延續到 2027' }], exitConditions: [] });
      r = await c.api<Preview>('POST', 'ops/own-thesis', { ticker: 'NVDA', thesis: '改一下本文', premises: [{ id: 'P4', text: '資料中心需求延續到 2027' }], exitConditions: [], dry: true });
      expect(r.body.preview).toMatchObject({ changed: false, defaultOnly: false });
    });
  });
});

describe('第 3 項：30 天內再改前提', () => {
  it('30 天內開過論點變動後的審查 → 預覽帶上次開的日子；超過 30 天、從沒開過、前提沒變動的都是 null', async () => {
    await withWorld(async (c) => {
      const addOne = { ticker: 'NVDA', thesis: '本文', premises: [{ text: '資料中心需求延續到 2027' }], exitConditions: [], dry: true };
      // 從沒開過論點變動後的審查：隔天會審
      let r = await c.api<Preview>('POST', 'ops/own-thesis', addOne);
      expect(r.body.preview).toMatchObject({ changed: true, reviewHeld: null });
      // 11-10 開過（下一次每日流程 11-20，相隔 10 天）→ 擋下，預覽寫 11/10 已經審過一次
      await c.patchNvda((a) => (a.own.NVDA.thesisReviewAt = '2026-11-10'));
      r = await c.api<Preview>('POST', 'ops/own-thesis', addOne);
      expect(r.body.preview).toMatchObject({ changed: true, reviewHeld: '2026-11-10' });
      // 前提沒變動（只寫本文）：不會開審查，也就不寫
      r = await c.api<Preview>('POST', 'ops/own-thesis', { ...addOne, premises: [] });
      expect(r.body.preview).toMatchObject({ changed: false, reviewHeld: null });
      // 存檔的結果（送不出去時的結果框用它）同樣帶
      const saved = await c.api<Preview>('POST', 'ops/own-thesis', { ...addOne, dry: false });
      expect(saved.body.preview.reviewHeld).toBe('2026-11-10');
      // 10-20 開過（相隔 31 天）→ 不擋
      await c.patchNvda((a) => (a.own.NVDA.thesisReviewAt = '2026-10-20'));
      r = await c.api<Preview>('POST', 'ops/own-thesis', { ...addOne, premises: [{ id: 'P4', text: '資料中心需求延續到 2027' }, { text: '再加一條' }] });
      expect(r.body.preview).toMatchObject({ changed: true, reviewHeld: null });
    });
  });

  it('判斷和每日流程同一個：相隔不到 30 個日曆天擋下，剛好 30 天不擋', () => {
    expect(THESIS_REVIEW_GAP).toBe(30);
    expect(thesisReviewHeld({ thesisReviewAt: '2026-11-20' }, '2026-12-19')).toBe('2026-11-20');
    expect(thesisReviewHeld({ thesisReviewAt: '2026-11-20' }, '2026-12-20')).toBeNull();
    expect(thesisReviewHeld({ thesisReviewAt: null }, '2026-11-21')).toBeNull();
    expect(thesisReviewHeld({}, '2026-11-21')).toBeNull();
  });
});

// ---------------------------------------------------------------- 示範模式：轉入、認養、分類、快照

describe('第 2 項：轉入、認養、清單外買進歸自選也進「還沒有論點的自選」', () => {
  let db: D1Database;
  let dispose: () => Promise<void>;
  let env: Env;
  beforeAll(async () => {
    const d = await freshDb();
    db = d.db;
    dispose = d.dispose;
    env = { DB: db, DEV_NO_AUTH: '1' };
  });
  afterAll(() => dispose());
  const noNet: Fetcher = async (url) => {
    throw new Error('測試不應該連網：' + url);
  };
  const call = async <T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> => {
    const r = await handle(new Request('https://bot.example/demo/api' + path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }), env, noNet, new Date('2026-12-09T23:30:00Z'));
    if (r.status !== 200) throw new Error(`${method} ${path} → ${r.status} ${await r.text()}`);
    return (await r.json()) as T;
  };
  const demoAcct = async () => JSON.parse((await db.prepare('SELECT body FROM demo_state WHERE id = 1').first<{ body: string }>())!.body) as Account;
  type ActionRes = { notifId: number; newOwn: string[]; newOwnRows: ThesisTodoRow[] };

  describe('情境 ①（12 月月報）', () => {
    beforeEach(async () => {
      await call('POST', '/reset', { scenario: 's1' });
    });
    it('ORCL 轉入自選、GE 認養 → 兩檔都進清單，回應帶同一張清單的列（含買進時的一句話）；排除不加', async () => {
      const sc = scenarios.s1();
      const sim = new Sim(sc.market, sc.init, { vetoes: { '2026-12': ['APP'] } });
      sim.runUntil('2026-12-01');
      const n = sim.preOpen()!;
      const keyOf = async (f: string, t: string) => (await call<{ items: { key: string; f?: string; ticker: string | null; label: string }[] }>('GET', `/notif/${n.id}`)).items.find((i) => i.ticker === t && i.label === f)!.key;
      const tr = await call<ActionRes>('POST', `/notif/${n.id}/action`, { key: await keyOf('動能出場', 'ORCL'), action: 'TRANSFER', reason: '雲端訂單還在成長' });
      expect(tr.newOwn).toEqual(['ORCL']);
      expect(tr.newOwnRows).toEqual([{ ticker: 'ORCL', buyNote: { text: '雲端訂單還在成長', at: expect.any(String) } }]);
      const ad = await call<ActionRes>('POST', `/notif/${n.id}/action`, { key: await keyOf('動能進場', 'GE'), action: 'ADOPT', reason: '看好航太引擎的售後服務' });
      expect(ad.newOwn).toEqual(['GE']);
      expect(ad.newOwnRows.map((x) => x.ticker)).toEqual(['GE']);
      expect((await demoAcct()).thesisTodo).toEqual(['ORCL', 'GE']);
      const st = await call<StateView>('GET', '/state');
      expect(st.thesisTodo.map((x) => x.ticker)).toEqual(['ORCL', 'GE']);
    });
    it('排除：沒有新開自選，清單不變', async () => {
      const sc = scenarios.s1();
      const sim = new Sim(sc.market, sc.init, { vetoes: { '2026-12': ['APP'] } });
      sim.runUntil('2026-12-01');
      const n = sim.preOpen()!;
      const v = await call<{ items: { key: string; ticker: string | null; label: string }[] }>('GET', `/notif/${n.id}`);
      const ex = await call<ActionRes>('POST', `/notif/${n.id}/action`, { key: v.items.find((i) => i.ticker === 'GE' && i.label === '動能進場')!.key, action: 'EXCLUDE', reason: '不想碰航太' });
      expect(ex.newOwn).toEqual([]);
      expect((await demoAcct()).thesisTodo ?? []).toEqual([]);
    });
  });

  describe('情境 ⑤（自己的操作）', () => {
    beforeEach(async () => {
      await call('POST', '/reset', { scenario: 's5' });
    });
    it('清單外買進 AAPL、分類歸自選 → 進清單，回應帶同一張清單的列', async () => {
      const { demoFilledSnapshot } = await import('../src/demo/driver');
      const row = (await db.prepare('SELECT scenario, d, body FROM demo_state WHERE id = 1').first<{ scenario: string; d: number; body: string }>())!;
      const snap = demoFilledSnapshot({ scenario: row.scenario as 's5', d: row.d, acct: JSON.parse(row.body) as Account }, { AAPL: 10 }, true);
      const s = await call<{ created: { id: number; kind: string }[] }>('POST', '/snapshot', snap);
      const cid = s.created.find((x) => x.kind === 'CLASSIFY')!.id;
      const r = await call<ActionRes & { monthlyUnblocked: boolean }>('POST', `/notif/${cid}/classify`, { bucket: 'own', reason: '想長期持有' });
      expect(r.newOwn).toEqual(['AAPL']);
      expect(r.newOwnRows).toEqual([{ ticker: 'AAPL', buyNote: { text: '想長期持有', at: expect.any(String) } }]);
      expect((await demoAcct()).thesisTodo).toEqual(['AAPL']);
    });

    it('第 4 項：快照新加自選、現在已經比 52 週高點低 20% 以上的 → startsHalved（TSLA）；沒跌那麼多的不列', async () => {
      const a = await demoAcct();
      const lots = { own: { ...a.lots.own, TSLA: 5, AAPL: 5 }, mom: { ...a.lots.mom }, core: { ...a.lots.core } };
      const r = await call<{ newOwn: string[]; startsHalved: string[] }>('POST', '/snapshot', { lots, cash: a.cash - 2000 });
      expect(r.newOwn.sort()).toEqual(['AAPL', 'TSLA']);
      const after = await demoAcct();
      expect(after.own.TSLA.opened?.startState).toBe('HALF');
      expect(after.own.AAPL.opened?.startState).toBe('STD');
      expect(r.startsHalved).toEqual(['TSLA']);
    });
  });
});

describe('第 4 項：一開始就記成減半的，只列這次新開的', () => {
  it('帳上原本就有、減半中的不列；賣光又買回（新的論點檔）、一開始是減半的列', () => {
    const meta = (fileId: string, startState: 'STD' | 'HALF') => ({ fileId, opened: { startState, drawdownAtOpen: null } }) as unknown as Account['own'][string];
    const before = { own: { NVDA: meta('NVDA@2026-11-01', 'HALF'), MSFT: meta('MSFT@2026-11-01', 'HALF') } } as unknown as Account;
    const after = { own: { NVDA: meta('NVDA@2026-11-01', 'HALF'), MSFT: meta('MSFT@2026-12-01', 'HALF'), TSLA: meta('TSLA@2026-12-01', 'HALF'), AAPL: meta('AAPL@2026-12-01', 'STD') } } as unknown as Account;
    expect(newOwnStartsHalved(before, after)).toEqual(['MSFT', 'TSLA']);
  });
});

describe('第 5 項：晚到否決的 LINE', () => {
  it('補上「排除會一直有效，之後要在帳戶頁取消」', () => {
    expect(EXCLUDE_LASTS).toBe('（排除會一直有效，之後要在帳戶頁取消）');
  });
});
