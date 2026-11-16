// T39b：使用者同意的四個行為修正（docs/plan/thesis_plan_2026-11-15.md 階段八 T39 → T39b；設計 own_thesis §1.8、design_v2 §10 第 47 點）。
// 完成條件：四項各至少一個測試。
//   1. 編輯論點頁「這是對通知的回應」：只有從通知進來（#/h/<代號>/thesis/<通知>）才預設勾著；從持股頁進來顯示但不勾
//   2. 改比例把自選改成 0% 再改回來：記下標準比重、改回時用記下的（沒有記錄用推薦比重）；0 股時不送定期審查、提前審查與條件監測
//   3. 晚回覆的策略項目（動能、回調、上限、閒置現金、併進月報的入金）用回覆當天的價格重算股數
//   4. 舊月報有崩盤切換又一整個月沒回覆：新月報照實際持股重列切換（核心的單、動能的補做），舊的切換項目以新月報為準取消
// 市場是可重現的假資料；對外請求全部是假的（價格、成分股固定檔、EDGAR、雲端排程）。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { StartCtx } from '../src/app/aiCtx';
import { listRuns } from '../src/app/aiRuns';
import type { Env, Fetcher } from '../src/app/env';
import { loadEvents } from '../src/app/filings';
import { runFlow } from '../src/app/flow';
import { loadAccount, saveAccount } from '../src/app/ledgerStore';
import { startCondReviews, startEarlyReviews, startOwnRuns } from '../src/app/ownAi';
import { EARLY_NOTE } from '../src/app/thesis';
import { notifView } from '../src/app/site/views';
import { explainItem, type ExplainContext } from '../src/app/site/explain';
import type { CompanyFacts, XbrlFact } from '../src/data/edgar';
import { buildMarketView } from '../src/data/marketView';
import { loadSeries } from '../src/data/store';
import {
  RELIST_OFF_NOTE,
  cancelCashflow,
  cellKey,
  changeRatio,
  coreContext,
  crashCoreLines,
  createAccount,
  deposit,
  ownHeld,
  priceOf,
  recommendStdWeights,
  respond,
  totalValue,
  type Account,
  type Item,
  type MarketView,
  type Notif,
  type OrderLine,
} from '../src/engine';
import { freshDb } from './helpers/d1';
import { cronTime, fakeFetcher, newWorld, type World } from './helpers/fakeSources';
import { makeMarket } from './helpers/market';
import { scenarios } from './helpers/scenarios';
import { Sim } from './helpers/sim';

const HERE = dirname(fileURLToPath(import.meta.url));
const js = (f: string) => readFileSync(join(HERE, '..', 'public', 'js', f), 'utf8');
const notif = (a: Account, id: number) => a.notifs.find((n) => n.id === id)!;
// 網頁的 JS 模組（不碰 DOM 的那一個）直接 import；沒有型別宣告，照它的 JSDoc 寫
type ReplyOption = (notifParam: number | null | undefined, pendingNotif: number | null) => { notif: number; checked: boolean } | null;
const replyOption: ReplyOption = ((await import('../public/js/thesis-reply.js' as string)) as { replyOption: ReplyOption }).replyOption;

// ---------------------------------------------------------------- 第 1 項：勾選的預設

describe('T39b ①：編輯論點頁「這是對通知的回應」的預設', () => {
  it('從通知進來（網址帶那則通知的編號）預設勾著；從持股頁直接進來仍顯示、預設不勾；網址帶別的通知或沒有還沒回覆的乙類 → 不顯示', () => {
    expect(replyOption(12, 12)).toEqual({ notif: 12, checked: true });
    expect(replyOption(null, 12)).toEqual({ notif: 12, checked: false });
    expect(replyOption(undefined, 12)).toEqual({ notif: 12, checked: false });
    expect(replyOption(13, 12)).toBeNull();
    expect(replyOption(null, null)).toBeNull();
    expect(replyOption(12, null)).toBeNull();
  });

  it('頁面用 replyOption 決定勾不勾；乙類通知上有「編輯論點」按鈕帶通知編號進去（從通知進來的入口）', () => {
    const page = js('pages-thesis.js');
    expect(page).toContain("import { replyOption } from './thesis-reply.js'");
    expect(page).toContain('checked: replyOpt.checked');
    expect(page).not.toContain("h('input', { type: 'checkbox', checked: true, onchange: () => changed() })");
    expect(js('pages-notif.js')).toContain("h('a', { class: 'btn', href: `#/h/${encodeURIComponent(it.ticker)}/thesis/${v.id}` }, '編輯論點')");
    // 路由照舊收 #/h/<代號>/thesis/<通知>
    expect(js('app.js')).toContain('thesisEditPage(ctx, decodeURIComponent(m[1]), m[2] ? Number(m[2]) : null)');
  });
});

// ---------------------------------------------------------------- 第 2 項：自選改成 0% 再改回來（引擎）

/** 情境 ①：12 月的月報照做、填完快照，沒有還沒成交的清單。 */
function settled(): Sim {
  const sc = scenarios.s1();
  const sim = new Sim(sc.market, sc.init, { vetoes: { '2026-12': ['APP'] }, autoRespond: true });
  sim.runUntil('2026-12-04');
  expect(sim.acct.notifs.filter((n) => n.status === 'RESPONDED' || (n.status === 'PENDING' && n.items.length && n.kind !== 'INFO'))).toEqual([]);
  return sim;
}
const ownLines = (n: Notif) => n.items[0].choices[0].lines.filter((l) => l.bucket === 'own');

describe('T39b ②：改比例把自選改成 0% 再改回來', () => {
  it('改成 0%：每檔全部賣掉、標準比重乘 0，原本的標準比重與比例記下來；成交後自選股還在（0 股）。改回 20%：標準比重回到記下的、照它買回；改回 10%：照新舊比例縮放', () => {
    const sim = settled();
    const view = sim.pre;
    const tickers = Object.keys(sim.acct.rule.own);
    expect(tickers.length).toBeGreaterThan(1);
    const std0 = Object.fromEntries(tickers.map((t) => [t, sim.acct.rule.own[t].stdWeight]));
    const r0 = sim.acct.cfg.ratio;
    const toZero = changeRatio(sim.acct, view, { own: 0, strat: r0.strat, core: r0.core + r0.own });
    expect(toZero.acct.ownZero).toEqual({ from: r0.own, std: std0, date: view.date });
    for (const t of tickers) expect(toZero.acct.rule.own[t].stdWeight).toBe(0);
    expect(ownLines(toZero.notif).map((l) => [l.ticker, l.shares]).sort()).toEqual(tickers.map((t) => [t, -sim.acct.lots.own[t]]).sort());
    sim.acct = toZero.acct;
    sim.respond(toZero.notif.id);
    sim.open();
    expect(notif(sim.acct, toZero.notif.id).status).toBe('DONE');
    for (const t of tickers) {
      expect(sim.acct.own[t]).toBeDefined(); // 照清單賣到 0：自選股留著
      expect(ownHeld(sim.acct, t)).toBe(false);
    }

    const v2 = sim.pre;
    const back = changeRatio(sim.acct, v2, { ...r0 });
    const total = totalValue(sim.acct, v2);
    for (const t of tickers) {
      expect(back.acct.rule.own[t].stdWeight).toBeCloseTo(std0[t], 12);
      const half = back.acct.rule.own[t].applied === 'HALF' ? 0.5 : 1;
      const want = Math.floor((std0[t] * total * half) / priceOf(v2, t));
      expect(ownLines(back.notif).find((l) => l.ticker === t)?.shares ?? 0).toBe(want);
    }
    expect(back.acct.ownZero).toBeUndefined();
    const ctx: ExplainContext = { acct: back.acct, view: v2, axis: [], rankOrder: [], aiNotes: [] };
    expect(explainItem(ctx, back.notif, back.notif.items[0]).why).toContain('自選從 0% 改回');
    expect(explainItem({ ...ctx, acct: toZero.acct, view }, toZero.notif, toZero.notif.items[0]).why).toContain('自選改成 0%');
    // 改回 10%（原本 20%）：記下的 × 10% ÷ 20%
    const halfBack = changeRatio(sim.acct, v2, { own: r0.own / 2, strat: r0.strat, core: r0.core + r0.own / 2 });
    for (const t of tickers) expect(halfBack.acct.rule.own[t].stdWeight).toBeCloseTo(std0[t] / 2, 12);
  });

  it('沒有記錄的那一檔（0% 期間才加進來、或舊帳戶沒有記錄）用新增自選時的推薦比重；取消清單時記錄跟著回到改之前', () => {
    const sim = settled();
    const view = sim.pre;
    const r0 = sim.acct.cfg.ratio;
    const tickers = Object.keys(sim.acct.rule.own);
    const toZero = changeRatio(sim.acct, view, { own: 0, strat: r0.strat, core: r0.core + r0.own });
    // 取消「改成 0%」：比例、標準比重回來，記錄拿掉
    const undo = cancelCashflow(toZero.acct, view, toZero.notif.id);
    expect(undo.ok).toBe(true);
    expect(undo.acct.cfg.ratio).toEqual(r0);
    expect(undo.acct.ownZero).toBeUndefined();
    // 記錄裡少一檔 → 那一檔用推薦比重
    const a = structuredClone(toZero.acct);
    const [missing, ...kept] = tickers;
    delete a.ownZero!.std[missing];
    const back = changeRatio(a, view, { ...r0 });
    const rec = recommendStdWeights(view, tickers, r0.own);
    expect(back.acct.rule.own[missing].stdWeight).toBeCloseTo(rec[missing], 12);
    for (const t of kept) expect(back.acct.rule.own[t].stdWeight).toBeCloseTo(toZero.acct.ownZero!.std[t], 12);
    // 完全沒有記錄（舊帳戶）→ 全部用推薦比重
    const none = structuredClone(toZero.acct);
    delete none.ownZero;
    const b2 = changeRatio(none, view, { ...r0 });
    for (const t of tickers) expect(b2.acct.rule.own[t].stdWeight).toBeCloseTo(rec[t], 12);
    // 取消「從 0% 改回」：記錄回來、標準比重回到 0
    const u2 = cancelCashflow(back.acct, view, back.notif.id);
    expect(u2.ok).toBe(true);
    expect(u2.acct.ownZero).toEqual(a.ownZero);
    for (const t of tickers) expect(u2.acct.rule.own[t].stdWeight).toBe(0);
    expect(u2.acct.cfg.ratio.own).toBe(0);
  });
});

// ---------------------------------------------------------------- 第 2 項：0 股時不送審查與條件監測（開執行的段落）

const FACT_ROWS = [
  { end: '2025-09-30', rev: 120, filed: '2025-11-01' },
  { end: '2026-06-30', rev: 150, filed: '2026-08-01' },
  { end: '2026-09-30', rev: 160, filed: '2026-10-30' },
];
const FACTS: CompanyFacts = {
  cik: 1045810,
  facts: {
    'us-gaap': {
      Revenues: {
        units: {
          USD: FACT_ROWS.map((q): XbrlFact => {
            const [y, m] = q.end.split('-').map(Number);
            return { start: `${y}-${String(m - 2).padStart(2, '0')}-01`, end: q.end, val: q.rev, accn: `acc-${q.filed}`, form: '10-Q', filed: q.filed };
          }),
        },
      },
    },
  },
};
const TENQ = { accession: '0001045810-26-000300', form: '10-Q', items: '', acceptanceDateTime: '2026-10-30T20:10:00.000Z', filingDate: '2026-10-30', primaryDocument: 'q.htm' };

function fetcherOf(w: World): Fetcher {
  const base = fakeFetcher(w);
  return async (url, init) => {
    if (url === 'https://api.example/fire') return Response.json({ claude_code_session_url: 'https://claude.ai/code/x' });
    if (/data\.sec\.gov\/submissions\/CIK\d+\.json/.test(url)) {
      const fs = [TENQ];
      return Response.json({ cik: '1045810', name: 'NVIDIA CORP', tickers: ['NVDA'], sic: '3674', formerNames: [], filings: { recent: { accessionNumber: fs.map((f) => f.accession), form: fs.map((f) => f.form), items: fs.map((f) => f.items), acceptanceDateTime: fs.map((f) => f.acceptanceDateTime), filingDate: fs.map((f) => f.filingDate), primaryDocument: fs.map((f) => f.primaryDocument) } } });
    }
    if (/companyfacts\/CIK\d+\.json/.test(url)) return Response.json(FACTS);
    if (/companyconcept\//.test(url)) return new Response('nf', { status: 404 });
    if (/Archives\/edgar\/data\//.test(url)) return new Response('<p>10-Q</p>');
    if (url.startsWith('https://www.nasdaq.com/feed/rssoutbound')) return new Response('<rss><channel></channel></rss>');
    return base(url, init);
  };
}

interface World2 {
  db: D1Database;
  env: Env;
  fetcher: Fetcher;
  view: MarketView;
  axis: string[];
}

/** NVDA 是自選、0 股（例如自選比例改成 0% 之後）。 */
async function withZeroShares(fn: (c: World2) => Promise<void>) {
  const d = await freshDb();
  try {
    const db = d.db;
    const w = newWorld('2026-11-19');
    const env: Env = { DB: db, ADMIN_TOKEN: 't', AI_TASK_SECRET: 's', EDGAR_USER_AGENT: 'test bot test@example.com', SITE_URL: 'https://bot.example', ROUTINE_FIRE_URL: 'https://api.example/fire', ROUTINE_TOKEN: 'rt' };
    const fetcher = fetcherOf(w);
    await runFlow(env, fetcher, { now: cronTime('2026-11-19'), attempt: 'FIRST' });
    const { view, axis } = buildMarketView(await loadSeries(db, ['VOO', 'SGOV', 'NVDA']), '2026-11-19', 'VOO');
    const acct = createAccount(
      {
        paper: true,
        cash: 5000,
        core: { VOO: Math.floor(180_000 / view.close.VOO[view.i]) },
        own: { NVDA: { shares: 0, stdWeight: 0, premises: [{ id: 'P1', text: '資料中心需求延續到 2027', origin: 'USER' }] } },
      },
      view,
    );
    acct.own.NVDA.condReviewDue = '2026-11-19';
    acct.own.NVDA.thesisReviewDue = '2026-11-19';
    await saveAccount(db, acct, null, '建立帳戶', new Date('2026-11-19T12:00:00Z'));
    await fn({ db, env, fetcher, view, axis });
  } finally {
    await d.dispose();
  }
}

const startCtx = async (c: World2, now = new Date('2026-11-19T23:45:00Z')): Promise<StartCtx> => ({ env: c.env, fetcher: c.fetcher, acct: (await loadAccount(c.db))!.acct, view: c.view, axis: c.axis, session: '2026-11-19', ov: {}, now, checks: [], res: { created: [], started: [], log: [], alerts: [] }, extras: {} });
const addCeoEvent = async (db: D1Database, n: number) =>
  (await db
    .prepare("INSERT INTO sec_events (ticker, accession, form, event_date, accepted_at, code, sub, by_rule, display_only, source, detail, status, created_at, detail_code) VALUES ('NVDA', ?, '8-K', '2026-11-19', NULL, 'MGMT_CHANGE', '8K_5.02_CEO_DEPART', 1, 0, 'EDGAR', '8-K Item 5.02：執行長離任', 'NEW', '2026-11-19T23:35:00.000Z', 'CEO_DEPART') RETURNING id")
    .bind(`0001045810-26-000${n}`)
    .first<{ id: number }>())!.id;
const ownReviews = async (db: D1Database) => (await listRuns(db, new Date('2026-11-01T00:00:00Z'), { limit: 100 })).filter((r) => r.fn === 'OWN_REVIEW');

describe('T39b ②：自選股 0 股時不送定期審查、提前審查與條件監測（持有後再恢復）', () => {
  it('0 股：提前審查的事件標成處理過（這檔現在 0 股）、條件成立後與論點變動後的審查不開而且留著；持有之後同樣的段落照常開', async () => {
    await withZeroShares(async (c) => {
      const ev = await addCeoEvent(c.db, 401);
      const s1 = await startCtx(c);
      await startEarlyReviews(s1);
      await startCondReviews(s1);
      await startOwnRuns(s1);
      expect(s1.res.started).toEqual([]);
      expect(await ownReviews(c.db)).toEqual([]);
      expect((await loadEvents(c.db, { ticker: 'NVDA' })).find((e) => e.id === ev)).toMatchObject({ status: 'HANDLED', handled_note: EARLY_NOTE.notHeld });
      const a1 = (await loadAccount(c.db))!.acct;
      expect(a1.own.NVDA.condReviewDue).toBe('2026-11-19');
      expect(a1.own.NVDA.thesisReviewDue).toBe('2026-11-19');

      // 持有之後（買回來、填了快照）：留著的審查照常開，新的事件照常提前審查
      const loaded = (await loadAccount(c.db))!;
      loaded.acct.lots.own.NVDA = 100;
      await saveAccount(c.db, loaded.acct, loaded, '測試：買回', new Date('2026-11-19T23:50:00Z'));
      const ev2 = await addCeoEvent(c.db, 402);
      const s2 = await startCtx(c, new Date('2026-11-19T23:55:00Z'));
      await startCondReviews(s2);
      expect(s2.res.started).toHaveLength(1);
      expect((await loadAccount(c.db))!.acct.own.NVDA.condReviewDue).toBeNull();
      const s3 = await startCtx(c, new Date('2026-11-20T00:05:00Z'));
      await startOwnRuns(s3); // 論點變動後的審查：今天已經有審查 → 只清掉（照舊）
      expect((await loadAccount(c.db))!.acct.own.NVDA.thesisReviewDue).toBeNull();
      const evRow = (await loadEvents(c.db, { ticker: 'NVDA' })).find((e) => e.id === ev2)!;
      const s4 = await startCtx(c, new Date('2026-11-20T00:10:00Z'));
      await startEarlyReviews(s4);
      expect((await loadEvents(c.db, { ticker: 'NVDA' })).find((e) => e.id === evRow.id)!.handled_note).not.toBe(EARLY_NOTE.notHeld);
    });
  });
});

// ---------------------------------------------------------------- 第 3 項：晚回覆的策略項目

/** planToLines 的換算（測試這邊自己算一次）：目標 = 比例 × 今天的總資產，和今天的市值比。 */
function expectedShares(acct: Account, view: MarketView, l: OrderLine, w: number): number {
  const have = acct.lots[l.bucket][l.ticker] ?? 0;
  const px = priceOf(view, l.ticker);
  const cur = have * px;
  const tgt = w * totalValue(acct, view);
  const sh = tgt <= 1e-9 ? -have : tgt < cur ? -Math.min(have, Math.round((cur - tgt) / px)) : Math.floor((tgt - cur) / px + 1e-9);
  return Math.sign(sh) === Math.sign(l.shares) ? sh : 0;
}

/** 走完今天、一路到 date 的開盤前（不回覆、不下單）。 */
function idleUntil(sim: Sim, date: string): void {
  sim.open();
  sim.close();
  sim.d++;
  sim.runUntil(date);
}

describe('T39b ③：晚回覆的策略項目用回覆當天的價格重算股數', () => {
  it('12/01 月報（併進入金）提醒過才回：動能進場、出場、回調與併進的入金照目標比例 × 回覆當天的總資產重算，寫「晚回覆」；準時回覆的不重算', () => {
    const sc = scenarios.s1();
    const sim = new Sim(sc.market, sc.init, { vetoes: { '2026-12': ['APP'] } });
    sim.runUntil('2026-12-01');
    sim.preOpen();
    const dep = deposit(sim.acct, sim.pre, 10000);
    expect(dep.mergedIntoMonthly).toBe(true);
    sim.acct = dep.acct;
    const m = dep.notif;
    const strat = m.items.filter((i) => i.kind === 'STRATEGY' && i.choices[0].lines.some((l) => l.bucket !== 'core'));
    expect(strat.map((i) => i.f)).toEqual(expect.arrayContaining(['F1', 'F2']));
    for (const it of strat) expect(it.targetW).toBeDefined();
    const f11 = m.items.find((i) => i.f === 'F11')!;
    expect(f11.targetW).toBeDefined();
    // 準時回覆：股數照原本的
    const onTime = respond(sim.acct, sim.pre, m.id, { mode: 'DO' });
    expect(notif(onTime, m.id).items.map((i) => i.choices[0].lines)).toEqual(m.items.map((i) => i.choices[0].lines));

    idleUntil(sim, '2026-12-09');
    expect(notif(sim.acct, m.id)).toMatchObject({ status: 'PENDING', reminded: true });
    const view = sim.pre;
    const before = notif(sim.acct, m.id);
    const after = notif(respond(sim.acct, view, m.id, { mode: 'DO' }), m.id);
    let changed = 0;
    for (const it0 of [...strat, f11]) {
      const it = after.items.find((i) => i.key === it0.key)!;
      const old = before.items.find((i) => i.key === it0.key)!;
      expect(it.note).toContain(`晚回覆：用 ${view.date} 收盤價重算`);
      const want = old.choices[0].lines.map((l) => ({ ...l, shares: expectedShares(sim.acct, view, l, old.targetW![cellKey(l.bucket, l.ticker)]) })).filter((l) => l.shares !== 0);
      expect(it.choices[0].lines).toEqual(want);
      if (JSON.stringify(it.choices[0].lines) !== JSON.stringify(old.choices[0].lines)) changed++;
    }
    expect(changed).toBeGreaterThan(0); // 價格動了，至少有一行的股數跟著變
    // 出場：照今天的持股全部賣
    const exit = after.items.find((i) => i.f === 'F2')!;
    expect(exit.choices[0].lines[0].shares).toBe(-sim.acct.lots.mom[exit.ticker!]);
    // F1 的進場說明（附註）沒有被蓋掉
    const entry = after.items.find((i) => i.f === 'F1' && before.items.find((b) => b.key === i.key)?.note)!;
    if (entry) expect(entry.note!.startsWith(before.items.find((b) => b.key === entry.key)!.note!)).toBe(true);
  });

  it('崩盤切換提醒過才回：核心那兩檔照回覆當天的持股與價格重算（核心的一半換短債），動能減半那幾行照目標比例重算', () => {
    const sim = stayDown();
    sim.runUntil('2027-01-04');
    const jan = sim.preOpen()!;
    const f5 = jan.items.find((i) => i.f === 'F5' && !i.relist)!;
    expect(f5.targetW).toBeDefined();
    idleUntil(sim, '2027-01-11');
    const view = sim.pre;
    const after = notif(respond(sim.acct, view, jan.id, { mode: 'DO' }), jan.id).items.find((i) => i.key === f5.key)!;
    const core = crashCoreLines(coreContext(sim.acct, view), true).filter((l) => l.shares !== 0);
    expect(after.choices[0].lines.filter((l) => l.bucket === 'core')).toEqual(core);
    for (const l of after.choices[0].lines.filter((x) => x.bucket === 'mom')) {
      const old = f5.choices[0].lines.find((x) => x.bucket === 'mom' && x.ticker === l.ticker)!;
      expect(l.shares).toBe(expectedShares(sim.acct, view, old, f5.targetW![cellKey('mom', l.ticker)]));
    }
    expect(after.note).toContain('晚回覆');
  });
});

// ---------------------------------------------------------------- 第 4 項：舊月報的崩盤切換一整個月沒回覆

/** 一路往下：12 月跌破均線、之後一直在均線之下（和 t33c 相同）。 */
function stayDown(): Sim {
  const sc = scenarios.s3();
  return new Sim(makeMarket('2026-12-07', 95, { market: [{ n: 18, ret: -0.11, vol: 0.3 }, { n: 77, ret: -0.04 }] }), sc.init);
}
const ready = (acct: Account, view: MarketView) => ({ mode: 'real', acct, view, axis: [], rankOrder: [], rankSession: null, aiNotes: [], events: [], shadow: [], today: view.date, warnings: [] }) as never;

describe('T39b ④：舊月報有崩盤切換又一整個月沒回覆', () => {
  it('新月報不會自己涵蓋切換（核心換短債只在切換那個月列）→ 照「這次不做」重列：核心的一半換短債（照現在的持股）、動能那幾檔的差額；舊的切換項目以新月報為準取消', () => {
    const sim = stayDown();
    sim.runUntil('2027-01-04');
    const jan = sim.preOpen()!;
    const f5 = jan.items.find((i) => i.f === 'F5' && !i.relist)!;
    expect(sim.acct.rule.crash).toBe(true);
    const momTickers = f5.choices[0].lines.filter((l) => l.bucket === 'mom' && l.shares).map((l) => l.ticker);
    expect(momTickers.length).toBeGreaterThan(0);
    idleUntil(sim, '2027-02-01');
    const feb = sim.preOpen()!;
    expect(sim.acct.rule.crash).toBe(true);
    // 舊的切換項目取消
    const oldF5 = notif(sim.acct, jan.id).items.find((i) => i.key === f5.key)!;
    expect(oldF5).toMatchObject({ cancelled: true, note: '上一份月報沒有回覆，這一項以 2027-02 月報為準' });
    // 新月報重列核心的單：照現在的持股，核心的一半換短債
    const re = feb.items.find((i: Item) => i.f === 'F5' && i.relist)!;
    expect(re).toBeDefined();
    expect(re.why).toBe('2027-01 月報一直沒有回覆，以這份為準');
    const voo = re.choices[0].lines.find((l) => l.ticker === 'VOO')!.shares;
    expect(voo).toBeLessThan(0);
    expect(re.choices[0].lines.find((l) => l.ticker === 'SGOV')!.shares).toBeGreaterThan(0);
    expect(Math.abs(-voo / sim.acct.lots.core.VOO - 0.5)).toBeLessThan(0.05);
    expect(sim.acct.coreOwe).toBeUndefined();
    // 動能那幾檔：還在名單上的以「策略單補做」列差額（減半），掉出名單的出場
    for (const t of momTickers) expect(feb.items.some((i) => i.kind === 'STRATEGY' && !i.cancelled && i.choices[0].lines.some((l) => l.bucket === 'mom' && l.ticker === t && l.shares < 0))).toBe(true);
    expect(feb.items.some((i) => i.f === 'F17')).toBe(true);
    // 網站的說明：不是「你選了這次不做」
    const why = notifView(ready(sim.acct, sim.pre), feb).items.find((x) => x.key === re.key)!.explain.why;
    expect(why).toContain('上次（2027-01 月報）一直沒有回覆');
    expect(why).not.toContain('你選了這次不做');
    // 舊月報裡沒有其他還在等的策略項目
    expect(notif(sim.acct, jan.id).items.filter((i) => i.kind === 'STRATEGY' && !i.cancelled)).toEqual([]);
  });
});

// ---------------------------------------------------------------- 第 4 項的延伸：舊月報的其他策略項目（主持者驗收時要求的探測）

const linesText = (it: Item) => it.choices[0].lines.map((l) => `${l.bucket}:${l.ticker}:${l.shares}`);

describe('T39b ④ 延伸：舊月報的動能進場（F1）與依波動度減碼（F4）一整個月沒回覆', () => {
  /** 情境 ⑥：1 月月報有 APP 進場（F1）、ORCL 出場（F2）、依波動度減碼 1 → 2/3（F4）；整個 1 月都沒回覆。 */
  function januaryIgnored(): { sim: Sim; jan: Notif } {
    const sc = scenarios.s6();
    const sim = new Sim(sc.market, sc.init, { sigmaMedianFactor: 1.05 });
    sim.runUntil('2027-01-04');
    const jan = sim.preOpen()!;
    expect(jan.items.map((i) => i.f)).toEqual(['F1', 'F2', 'F4']);
    idleUntil(sim, '2027-02-01');
    return { sim, jan };
  }
  /** 2 月月報裡這一檔動能那一格要賣（或買）的股數；沒有列 → 0。 */
  const momShares = (n: Notif, t: string) => n.items.filter((i) => !i.cancelled).flatMap((i) => i.choices[0].lines).filter((l) => l.bucket === 'mom' && l.ticker === t).reduce((a, l) => a + l.shares, 0);

  it('依波動度減碼：2 月的比例格子沒變（遲滯擋下），只靠回調不會再列（減到 2/3 剛好偏離 50%，不到門檻）→ 記成策略單補做，2 月照現在的持股再列減碼', () => {
    const { sim, jan } = januaryIgnored();
    const f4 = jan.items.find((i) => i.f === 'F4')!;
    const feb = sim.preOpen()!;
    expect(sim.acct.rule.volW).toBeCloseTo(2 / 3, 12); // 2 月的比例格子不變：規則本身不會再減
    expect(notif(sim.acct, jan.id).items.find((i) => i.key === f4.key)).toMatchObject({ cancelled: true, note: '上一份月報沒有回覆，這一項以 2027-02 月報為準' });
    for (const l of f4.choices[0].lines) {
      const sh = momShares(feb, l.ticker);
      expect(sh, `${l.ticker}：1 月要減 ${-l.shares} 股，2 月 ${linesText(feb.items.find((i) => i.ticker === l.ticker) ?? f4).join(' ')}`).toBeLessThan(0);
      expect(feb.items.find((i) => i.ticker === l.ticker && i.choices[0].lines.some((x) => x.bucket === 'mom' && x.shares < 0))?.f).toBe('F17');
    }
  });

  it('動能進場：沒有別的單可以搭便車的那一天（ORCL 已經自己賣掉）也照樣再列 APP，不會被回調的搭便車撤回', () => {
    const { sim, jan } = januaryIgnored();
    const app = jan.items.find((i) => i.f === 'F1')!;
    // ORCL 的出場你自己做了（照價賣掉、現金進帳），2 月就沒有 ORCL 的單可以讓 APP 的回調搭便車
    const px = priceOf(sim.pre, 'ORCL');
    sim.acct.cash += (sim.acct.lots.mom.ORCL ?? 0) * px;
    delete sim.acct.lots.mom.ORCL;
    const feb = sim.preOpen()!;
    expect(notif(sim.acct, jan.id).items.find((i) => i.key === app.key)!.cancelled).toBe(true);
    expect(momShares(feb, 'APP')).toBeGreaterThan(0);
    expect(feb.items.find((i) => i.ticker === 'APP' && !i.cancelled)?.f).toBe('F17');
  });
});

describe('T39b ④ 延伸：新月報出來之前崩盤規則已經翻回去', () => {
  it('情境 ③：1 月啟動的月報整個 1 月沒回覆、2 月已經解除 → 不重列核心換短債；解除項目沒有短債要換回、寫「上次啟動你沒有做」；1 月的切換項目取消', () => {
    const sc = scenarios.s3();
    const sim = new Sim(sc.market, sc.init);
    sim.runUntil('2027-01-04');
    const jan = sim.preOpen()!;
    const f5 = jan.items.find((i) => i.f === 'F5' && !i.relist)!;
    expect(f5).toBeDefined();
    idleUntil(sim, '2027-02-01');
    const feb = sim.preOpen()!;
    expect(sim.acct.rule.crash).toBe(false);
    expect(sim.acct.coreOwe).toBeUndefined();
    expect(feb.items.some((i) => (i.f === 'F5' || i.f === 'F6') && i.relist)).toBe(false);
    const f6 = feb.items.find((i) => i.f === 'F6' && !i.relist)!;
    expect(f6.choices[0].lines.filter((l) => l.bucket === 'core')).toEqual([]);
    expect(f6.note).toBe(RELIST_OFF_NOTE);
    expect(notif(sim.acct, jan.id).items.find((i) => i.key === f5.key)).toMatchObject({ cancelled: true, note: '上一份月報沒有回覆，這一項以 2027-02 月報為準' });
    // 動能：1 月要減半的那幾檔不再減半（規則已經恢復）；解除那一項照現在的持股拉回完整的目標（只剩零頭的調整），不另外列策略單補做
    expect(feb.items.some((i) => i.f === 'F17')).toBe(false);
    for (const l of f5.choices[0].lines.filter((x) => x.bucket === 'mom' && x.shares < 0)) {
      const sh = f6.choices[0].lines.filter((x) => x.bucket === 'mom' && x.ticker === l.ticker).reduce((t, x) => t + x.shares, 0);
      expect(Math.abs(sh), l.ticker).toBeLessThan(Math.abs(l.shares) / 2);
    }
  });
});
