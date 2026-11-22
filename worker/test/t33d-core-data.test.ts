// T33d：核心的拿掉的、資料檢查、清單說明（core_ai_design_2026-11-15 §5 的 T33d 那一列；§3.9～§3.11）。
// 整條流程用假的價格（helpers/fakeSources；假市場裡 SPY 和 VOO 同一組價格）、假的雲端排程、假的 LINE、假的 FRED。
import { describe, expect, it } from 'vitest';
import { CRASH_REVIEW_PROMPT, crashPack, checkCrashPayload } from '../src/ai/crash';
import type { EvidencePack } from '../src/ai/check';
import type { AiRun } from '../src/app/aiRuns';
import { loadSnapshot } from '../src/app/crashAi';
import type { Env, Fetcher } from '../src/app/env';
import { runFlow, type Attempt } from '../src/app/flow';
import { loadAccount, saveAccount } from '../src/app/ledgerStore';
import { LINE_PUSH_URL, corePriceWarn, notifText } from '../src/app/line';
import { CRASH_MONTHLY_LABEL, runRow } from '../src/app/site/aiViews';
import { afterFact, bucketSharesAfter, coreBondAfter, explainItem, liveCashflow, momRelFact, type ExplainContext } from '../src/app/site/explain';
import { CORE_CHECK, coreAlertText, coreDataCheck, corePriceNote } from '../src/data/coreCheck';
import { buildMarketView } from '../src/data/marketView';
import { loadSeries } from '../src/data/store';
import { RATIO_SHADOW_TITLE, cancelCashflow, changeRatio, clone, createAccount, deposit, liveShadow, respond, totalValue, withdraw, type Account, type MarketView, type Notif, type StrategyReviewState } from '../src/engine';
import { freshDb } from './helpers/d1';
import { cronTime, fakeFetcher, newWorld, type World } from './helpers/fakeSources';
import { scenarios } from './helpers/scenarios';
import { Sim } from './helpers/sim';

// ---------------------------------------------------------------- 假的世界（和 t33b 相同的寫法）

interface Sec {
  line: string[];
}

function fetcherOf(w: World, sec: Sec): Fetcher {
  const base = fakeFetcher(w);
  return async (url, init) => {
    if (url === LINE_PUSH_URL) {
      sec.line.push((JSON.parse(String(init?.body)) as { messages: { text: string }[] }).messages[0].text);
      return Response.json({});
    }
    if (url === 'https://api.example/fire') return Response.json({ claude_code_session_url: 'https://claude.ai/code/x' });
    const sub = /data\.sec\.gov\/submissions\/CIK(\d+)\.json/.exec(url);
    if (sub) return Response.json({ cik: sub[1], name: 'SOME CORP', tickers: [], sic: '3674', formerNames: [], filings: { recent: { accessionNumber: [], form: [], items: [], acceptanceDateTime: [], filingDate: [], primaryDocument: [] } } });
    if (/companyfacts\/CIK\d+\.json/.test(url)) return Response.json({ cik: 1, facts: {} });
    if (/companyconcept\//.test(url)) return new Response('nf', { status: 404 });
    if (url.startsWith('https://www.nasdaq.com/feed/rssoutbound')) return new Response('<rss><channel></channel></rss>');
    const fred = /fredgraph\.csv\?id=([A-Z0-9]+)/.exec(url);
    if (fred) return new Response(`observation_date,X\n2000-10-02,1.0\n2026-05-01,1.2\n${w.dataDate},1.5\n`);
    if (url.startsWith('https://mba.tuck.dartmouth.edu/')) return new Response('nf', { status: 404 });
    return base(url, init);
  };
}

interface Ctx {
  db: D1Database;
  w: World;
  sec: Sec;
  run: (date: string, attempt?: Attempt) => ReturnType<typeof runFlow>;
  acct: () => Promise<Account>;
}

const HOURS: Record<Attempt, number> = { FIRST: 0, FINAL: 2, APPLY: 4, MANUAL: 0 };
const MOM = 'AAPL';

/** routine：雲端排程設定好了沒。帳戶的核心照固定比例（VOO 八成、SGOV 與現金兩成），月報不會多一項核心比例調回。 */
async function withWorld(opt: { routine: boolean }, fn: (c: Ctx) => Promise<void>) {
  const d = await freshDb();
  try {
    const db = d.db;
    const w = newWorld('2026-11-19');
    const sec: Sec = { line: [] };
    const env: Env = { DB: db, ADMIN_TOKEN: 't', AI_TASK_SECRET: 's', EDGAR_USER_AGENT: 'test bot test@example.com', SITE_URL: 'https://bot.example', LINE_CHANNEL_TOKEN: 'lt', LINE_USER_ID: 'U1', DEV_NO_AUTH: '1', ...(opt.routine ? { ROUTINE_FIRE_URL: 'https://api.example/fire', ROUTINE_TOKEN: 'rt' } : {}) };
    const fetcher = fetcherOf(w, sec);
    const run = (date: string, attempt: Attempt = 'FIRST') => {
      w.dataDate = date;
      return runFlow(env, fetcher, { now: new Date(cronTime(date).getTime() + HOURS[attempt] * 3600_000), attempt });
    };
    await run('2026-11-19');
    const { view } = buildMarketView(await loadSeries(db, ['VOO', 'SGOV', MOM]), '2026-11-19', 'VOO');
    const acct = createAccount(
      {
        paper: true,
        cash: 5000,
        core: { VOO: Math.floor(112_000 / view.close.VOO[view.i]), SGOV: Math.floor(23_000 / view.close.SGOV[view.i]) },
        mom: { [MOM]: Math.floor(10_000 / view.close[MOM][view.i]) },
      },
      view,
    );
    await saveAccount(db, acct, null, '建立帳戶', new Date('2026-11-19T12:00:00Z'));
    await fn({ db, w, sec, run, acct: async () => (await loadAccount(db))!.acct });
  } finally {
    await d.dispose();
  }
}

const alertsOf = async (db: D1Database, kind: string) => (await db.prepare('SELECT session, message FROM alerts WHERE kind = ? ORDER BY id').bind(kind).all<{ session: string; message: string }>()).results;
const crashRunCount = async (db: D1Database) => (await db.prepare("SELECT COUNT(*) AS n FROM ai_runs WHERE fn = 'CRASH_REVIEW'").first<{ n: number }>())!.n;

// ---------------------------------------------------------------- §3.9 拿掉每月評語、prompt 升版

describe('T33d：拿掉每月評語；crash_review_v2（core_ai §3.9）', () => {
  it('不會切換的月份：月報前一天與 01:30 都不開 CRASH_REVIEW，儀表板照樣算、存', async () => {
    await withWorld({ routine: true }, async ({ db, run }) => {
      await run('2026-11-27');
      await run('2026-11-27', 'FINAL');
      const snap = await loadSnapshot(db, '2026-12');
      expect(snap).not.toBeNull();
      expect(snap!.asOf).toBe('2026-11-27');
      expect(snap!.rows).toHaveLength(10);
      const m = await run('2026-11-30');
      expect(m.monthly).not.toBeNull();
      await run('2026-11-30', 'FINAL');
      expect(await crashRunCount(db)).toBe(0);
    });
    // T80：原本這裡對照「會切換的月份照樣開（預估）」。崩盤規則的狀態不再讀寫（allocation_redesign §1.5），
    // 帳戶不會再從啟動中解除，這個對照拿掉；檢視的排程在 T81 退場。
  });

  it('證據包用 crash_review_v2、不給條件種類；bear_prob 送來就忽略', () => {
    const { pack } = crashPack({ runId: 'r1', asOf: '2026-11-27', direction: 'ON', dashboard: { id: 'DASH', source_id: 'macro:2026-11-27', kind: 'table', date: '2026-11-27', title: 'd', text: 'x' }, news: null, facts: [], dataQuality: {}, now: new Date('2026-11-28T00:00:00Z') });
    expect(CRASH_REVIEW_PROMPT).toBe('crash_review_v2');
    expect(pack.prompt_version).toBe('crash_review_v2');
    expect(pack.condition_types).toEqual([]);
    const p = { rule: { detail: { direction: 'ON' } } } as unknown as EvidencePack;
    const smp = { rawVerdict: 'DELAY', verdict: 'DELAY', issues: [] as string[], payload: { direction: 'ON', opinion: 'DELAY', bear_prob: 7 } };
    checkCrashPayload(smp as never, p);
    expect(smp.issues).toEqual([]);
  });

  it('舊的每月評語在 AI 紀錄的標籤是「每月總經評語（已停用）」，NOTED 顯示成「只記錄」', () => {
    const base = { runId: 'x', ticker: null, asOf: '2026-10-29', createdAt: '2026-10-29T23:30:00Z', status: 'DONE', taskId: null, promptVersion: 'crash_review_v1', packHash: 'h', packNotes: [], process: [], completedAt: null, repoCommit: null };
    const outcome = { status: 'AGREED', verdict: 'NOTED', votes: { NOTED: 1 }, actionable: false, followRule: true, reason: '', samples: [] };
    const monthly = { ...base, fn: 'CRASH_REVIEW', pack: { rule: { action: '崩盤規則不切換', detail: { direction: 'NONE' } } }, outcome } as unknown as AiRun;
    expect(runRow(monthly)).toMatchObject({ label: CRASH_MONTHLY_LABEL, verdict: '只記錄' });
    const review = { ...base, fn: 'CRASH_REVIEW', pack: { rule: { action: '崩盤規則啟動', detail: { direction: 'ON', month: '2026-11' } } }, outcome: { ...outcome, verdict: 'DELAY', votes: { DELAY: 3 } } } as unknown as AiRun;
    expect(runRow(review)).toMatchObject({ label: '崩盤規則檢視（已停用）', verdict: '延後' });
  });
});

// ---------------------------------------------------------------- §3.10 核心 ETF 的資料檢查

/** 一個只有 VOO、SPY、SGOV 的 MarketView：n 根日線，最後一天 VOO、SGOV 可以另外乘一個倍數。 */
function miniView(opt: { n?: number; vooLast?: number; bondLast?: number; spy?: boolean; vooBars?: number } = {}): MarketView {
  const n = opt.n ?? 260;
  const line = (p0: number, g: number) => Float64Array.from({ length: n }, (_, k) => p0 * Math.exp(g * k));
  const voo = line(400, 0.0005);
  if (opt.vooBars !== undefined) for (let k = 0; k < n - opt.vooBars; k++) voo[k] = NaN;
  voo[n - 1] *= opt.vooLast ?? 1;
  const bond = line(100, 0.0001);
  bond[n - 1] *= opt.bondLast ?? 1;
  return { date: '2026-11-30', i: n - 1, close: { VOO: voo, SGOV: bond, ...(opt.spy === false ? {} : { SPY: line(600, 0.0005) }) } };
}
const NAMES = { core: 'VOO', bench: 'SPY', bond: 'SGOV' };
const codes = (v: MarketView) => coreDataCheck(v, 'VOO', 'SPY', 'SGOV').map((x) => x.code);

describe('T33d：核心 ETF 的資料檢查 coreDataCheck（core_ai §3.10）', () => {
  it('平常沒有問題；VOO 最後一天比 SPY 多跌 3% → DAY_GAP（MA_GAP 2026-11-22 起不再檢查，T81）；門檻邊界', () => {
    expect(codes(miniView())).toEqual([]);
    const v = miniView({ vooLast: 0.97 });
    const issues = coreDataCheck(v, 'VOO', 'SPY', 'SGOV');
    expect(issues.map((x) => x.code)).toEqual(['DAY_GAP']);
    expect(coreAlertText(issues[0], NAMES, '2026-11-30')).toBe('VOO 的價格和 SPY 對不上：11-30 日報酬 VOO -2.95%、SPY +0.05%（平常差不到 0.1 個百分點），可能是資料錯誤。核心比例照這個價格算；月報日之前請到券商核對 VOO 的收盤價。');
    // 日報酬差 0.9 個百分點：不到門檻（MA_GAP 也不到）
    expect(codes(miniView({ vooLast: 0.991 }))).toEqual([]);
    expect(CORE_CHECK).toEqual({ dayGap: 0.01, bondJump: 0.01 });
  });

  it('短債一天變動 2% → BOND_JUMP；0.5% 不算', () => {
    const v = miniView({ bondLast: 1.02 });
    const [x] = coreDataCheck(v, 'VOO', 'SPY', 'SGOV');
    expect(x.code).toBe('BOND_JUMP');
    expect(coreAlertText(x, NAMES, '2026-11-30')).toBe('SGOV 一天變動 2.0%，可能是資料錯誤；清單裡短債的股數請核對。');
    expect(codes(miniView({ bondLast: 1.005 }))).toEqual([]);
  });

  it('VOO 不滿 200 根 → 沒有問題（核心沒有 200 日線規則，MA_SHORT 拿掉）；SPY 沒有今天的價格 → NO_BENCH（沒有告警文字）', () => {
    const short = coreDataCheck(miniView({ vooBars: 150 }), 'VOO', 'SPY', 'SGOV');
    expect(short).toEqual([]);
    const nb = coreDataCheck(miniView({ spy: false }), 'VOO', 'SPY', 'SGOV');
    expect(nb).toEqual([{ code: 'NO_BENCH' }]);
    expect(coreAlertText(nb[0], NAMES, '2026-11-30')).toBeNull();
    expect(corePriceNote(nb, NAMES)).toBeNull();
  });
});

describe('T33d：資料檢查在每日流程與月報（core_ai §3.10）', () => {
  it('沒有切換的月報：有對不上的告警，但項目與 LINE 沒有那一行；平常的日子不告警', async () => {
    await withWorld({ routine: false }, async ({ db, w, sec, run, acct }) => {
      await run('2026-11-27');
      expect(await alertsOf(db, 'CORE_PRICE_SUSPECT')).toEqual([]);
      w.shock.VOO = { from: '2026-11-30', factor: 0.97 };
      const m = await run('2026-11-30');
      expect((await alertsOf(db, 'CORE_PRICE_SUSPECT')).length).toBe(1);
      const n = (await acct()).notifs.find((x) => x.id === m.monthly)!;
      expect(n.monthly!.input.coreCheck).toEqual(['DAY_GAP']);
      expect(n.items.some((i) => i.f === 'F5' || i.f === 'F6')).toBe(false);
      expect(corePriceWarn(n)).toBe(false);
      expect(sec.line.filter((t) => t.includes('【月報】')).every((t) => !t.includes('價格資料可能有誤'))).toBe(true);
    });
  });

  it('短債一天變動 2% → 那一天告警（只有那一天），每日流程照常', async () => {
    await withWorld({ routine: false }, async ({ db, w, run }) => {
      w.shock.SGOV = { from: '2026-11-24', factor: 1.02 };
      const r = await run('2026-11-24');
      expect(r.status).toBe('DONE');
      await run('2026-11-25');
      const alerts = await alertsOf(db, 'CORE_PRICE_SUSPECT');
      expect(alerts).toEqual([{ session: '2026-11-24', message: 'SGOV 一天變動 2.0%，可能是資料錯誤；清單裡短債的股數請核對。' }]);
    });
  });

  it('LINE 那一行：只有月報、有 DAY_GAP 或 MA_GAP、有切換的那一項（不是重列、沒取消）才加', () => {
    const acct = { paper: false, cfg: { coreTicker: 'VOO' }, notifs: [], own: {} } as unknown as Account;
    const item = (over: object) => ({ key: 'k', f: 'F5', kind: 'STRATEGY', title: '崩盤規則啟動', choices: [{ id: 'DO', label: '照做', lines: [] }], choice: 'DO', ruleChoice: 'DO', ...over });
    const notif = (codes: string[], it: object): Notif => ({ id: 1, kind: 'MONTHLY', date: '2026-11-30', seq: 0, title: '2026-12 月報', items: [item(it)], status: 'PENDING', coreAbsorb: true, reminded: false, monthly: { input: { order: [], month: '2026-12', coreCheck: codes } } }) as unknown as Notif;
    expect(notifText(acct, notif(['DAY_GAP'], {}), null)).toContain('注意：VOO 的價格資料可能有誤，下單前先看網站。');
    expect(notifText(acct, notif(['MA_GAP'], {}), null)).not.toContain('注意：VOO'); // 舊月報存的 MA_GAP 不再算
    expect(notifText(acct, notif(['BOND_JUMP'], {}), null)).not.toContain('注意：VOO');
    expect(notifText(acct, notif(['DAY_GAP'], { relist: true }), null)).not.toContain('注意：VOO');
    expect(notifText(acct, notif(['DAY_GAP'], { cancelled: true }), null)).not.toContain('注意：VOO');
    expect(notifText(acct, notif([], {}), null)).not.toContain('注意：VOO');
  });
});

// ---------------------------------------------------------------- §3.11 入金、出金、改比例的說明

describe('T33d：入金、出金、改比例的說明與改比例的影子紀錄（core_ai §3.11）', () => {
  const start = () => {
    const sc = scenarios.s5();
    const sim = new Sim(sc.market, sc.init);
    sim.runUntil('2026-12-10');
    return sim;
  };
  const ctxOf = (acct: Account, view: MarketView, strategy?: StrategyReviewState | null): ExplainContext => ({ acct, view, axis: [], rankOrder: [], aiNotes: [], strategy });
  const pctOf = (v: string, name: string) => Number(new RegExp(`${name} ([\\d.]+)%`).exec(v)![1]) / 100;

  it('入金清單有「做完之後」各桶占比（照清單套到持股上、核心含做完的現金）', () => {
    const sim = start();
    const r = deposit(sim.acct, sim.pre, 10000);
    const b = bucketSharesAfter(r.acct, sim.pre, r.notif.preview!)!;
    expect(b.own + b.mom + b.core).toBeCloseTo(1, 9);
    // 自己算一次：每一桶的股數加上清單的那一行，乘收盤
    const lots = clone(r.acct.lots);
    for (const l of r.notif.preview!.lines) lots[l.bucket][l.ticker] = (lots[l.bucket][l.ticker] ?? 0) + l.shares;
    const val = (m: Record<string, number>) => Object.entries(m).reduce((a, [t, n]) => a + n * sim.pre.close[t][sim.pre.i], 0);
    const total = val(lots.own) + val(lots.mom) + val(lots.core) + r.notif.preview!.cashAfter + val(lots.unc);
    expect(b.own).toBeCloseTo(val(lots.own) / total, 9);
    const x = explainItem(ctxOf(r.acct, sim.pre), r.notif, r.notif.items[0]);
    const f = x.facts![0];
    expect(f.label).toBe('做完之後');
    const ratio = r.acct.cfg.ratio;
    // T80（allocation_redesign §1.4）：後面多一項核心的比例
    const s = coreBondAfter(r.acct, sim.pre, r.notif.preview!)!;
    expect(s).toBeGreaterThan(0.15);
    expect(s).toBeLessThan(0.25);
    expect(f.value).toBe(`自選 ${(b.own * 100).toFixed(1)}%（預算 ${Math.round(ratio.own * 100)}%）、動能 ${(b.mom * 100).toFixed(1)}%（${Math.round(ratio.strat * 100)}%）、核心 ${(b.core * 100).toFixed(1)}%（${Math.round(ratio.core * 100)}%）；核心裡 SGOV 與現金 ${(s * 100).toFixed(1)}%（目標 20%）`);
  });

  it('出金清單的「做完之後」先扣掉要轉出的金額：占比的分母是做之前的總資產減掉出金', () => {
    const sim = start();
    const r = withdraw(sim.acct, sim.pre, 30000);
    const b = bucketSharesAfter(r.acct, sim.pre, r.notif.preview!)!;
    // 照收盤買賣不會改變總資產，所以做完之後的總資產 = 做之前 − 出金；用自選那一桶反推分母
    const lots = clone(r.acct.lots);
    for (const l of r.notif.preview!.lines) lots[l.bucket][l.ticker] = (lots[l.bucket][l.ticker] ?? 0) + l.shares;
    const own = Object.entries(lots.own).reduce((a, [t, n]) => a + n * sim.pre.close[t][sim.pre.i], 0);
    expect(own / b.own).toBeCloseTo(totalValue(r.acct, sim.pre) - 30000, 4);
    expect(b.own + b.mom + b.core).toBeCloseTo(1, 9);
    const f = explainItem(ctxOf(r.acct, sim.pre), r.notif, r.notif.items[0]).facts![0];
    expect(f.label).toBe('做完之後');
    expect(pctOf(f.value, '核心')).toBeCloseTo(Math.round(b.core * 1000) / 1000, 9);
  });

  it('回覆後「做完之後」改用合成的清單；填過快照之後用存下來的', () => {
    const sim = start();
    const r = deposit(sim.acct, sim.pre, 10000);
    const ctx = ctxOf(r.acct, sim.pre);
    const it = { ...r.notif.items[0], x: explainItem(ctx, r.notif, r.notif.items[0]) };
    // 回覆後合成的清單不同（例如月報裡別的項目改了選項）：用 composed 重算
    const composed = { ...r.notif.preview!, lines: [], cashAfter: r.acct.cash };
    const live = liveCashflow(ctx, { ...r.notif, status: 'RESPONDED', composed }, it);
    expect(live.facts![0].value).toBe(afterFact(r.acct, sim.pre, composed)!.value);
    expect(live.facts![0].value).not.toBe(it.x.facts![0].value);
    expect(live.facts!.filter((f) => f.label === '做完之後')).toHaveLength(1);
    expect(liveCashflow(ctx, { ...r.notif, status: 'DONE', composed }, it)).toBe(it.x);
  });

  it('改比例（Strategy 有變）有「動能相對大盤」那一列：落後事件中、不在；Strategy 沒變或沒有狀態（示範）就沒有', () => {
    const sim = start();
    const r = changeRatio(sim.acct, sim.pre, { own: 0.2, strat: 0, core: 0.8 });
    const inEvent: StrategyReviewState = { rel: 0.68, peak: 1, eventStart: '2025-03-10', notified: [-0.2, -0.3], yearsNotified: 0 };
    const facts = (st: StrategyReviewState | null | undefined, n = r.notif) => explainItem(ctxOf(r.acct, sim.pre, st), n, n.items[0]).facts!;
    expect(facts(inEvent).find((f) => f.label === '動能相對大盤')!.value).toBe('比高點落後 32%（這次從 2025-03-10 開始）');
    expect(facts({ rel: 1.152, peak: 1.2, eventStart: null, notified: [], yearsNotified: 0 }).find((f) => f.label === '動能相對大盤')!.value).toBe('比高點落後 4%，不在落後事件中');
    expect(facts(undefined).some((f) => f.label === '動能相對大盤')).toBe(false);
    expect(facts(inEvent)[0].label).toBe('做完之後');
    // 固定提醒照留
    expect(facts(inEvent).some((f) => f.label === '提醒')).toBe(true);
    // 只改自選與核心：不放
    const own = changeRatio(sim.acct, sim.pre, { own: 0.25, strat: 0.3, core: 0.45 });
    expect(explainItem(ctxOf(own.acct, sim.pre, inEvent), own.notif, own.notif.items[0]).facts!.some((f) => f.label === '動能相對大盤')).toBe(false);
    expect(momRelFact(null)).toBeNull();
  });

  it('改比例：產生清單時不寫影子；回覆後照合成的清單每一檔一筆（含核心，規則 0 股）；取消後作廢', () => {
    const sim = start();
    const r = changeRatio(sim.acct, sim.pre, { own: 0.2, strat: 0, core: 0.8 });
    expect(r.acct.shadow.some((s) => s.f === 'F13')).toBe(false);
    const a = respond(r.acct, sim.pre, r.notif.id, { mode: 'DO' });
    const n = a.notifs.find((x) => x.id === r.notif.id)!;
    const recs = a.shadow.filter((s) => s.f === 'F13');
    const merged = n.composed!.merged.filter((m) => m.shares !== 0);
    expect(recs.map((s) => `${s.ticker}:${s.actual}`).sort()).toEqual(merged.map((m) => `${m.ticker}:${m.shares}`).sort());
    expect(recs.some((s) => s.ticker === 'VOO')).toBe(true);
    for (const s of recs) expect(s).toMatchObject({ f: 'F13', title: RATIO_SHADOW_TITLE, rule: 0, ai: null, choice: 'RATIO', notif: r.notif.id, note: '20% / 30% / 50% → 20% / 0% / 80%', date: sim.pre.date });
    expect(recs.every((s) => s.price === sim.pre.close[s.ticker!][sim.pre.i])).toBe(true);
    expect(liveShadow(a.shadow).filter((s) => s.f === 'F13')).toHaveLength(recs.length);
    const c = cancelCashflow(a, sim.pre, r.notif.id);
    expect(c.ok).toBe(true);
    expect(liveShadow(c.acct.shadow).some((s) => s.f === 'F13')).toBe(false);
  });
});
