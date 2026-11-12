// T6：資料層與儲存。對外請求全部用假的 fetcher（成分股是真實固定檔，價格是假的），D1 用本機模擬器。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../src/app/env';
import { ConflictError, loadAccount, loadEvents, loadShadow, requiredTickers, saveAccount, saveSnapshot } from '../src/app/ledgerStore';
import { isTradingDay, lastCompletedSession, addDays } from '../src/data/calendar';
import { BENCHMARK, companyOf, runIngest } from '../src/data/ingest';
import { StaleDataError, buildMarketView, rebaseNotifSeq } from '../src/data/marketView';
import { parseSpyHoldings, yahooSymbol } from '../src/data/sources';
import { loadConstituents, loadRanking, loadRun, loadSeries, recentAlerts, type Series } from '../src/data/store';
import { applySnapshot, createAccount, dailyCheck, deposit, selectMomentum } from '../src/engine';
import { handle, INGEST_CRON } from '../src/index';
import { freshDb } from './helpers/d1';
import { SPY_XLSX, cronTime, fakeClose, fakeFetcher, fakeParams, newWorld } from './helpers/fakeSources';

const REQUIRED = ['VOO', 'SGOV', 'MU', 'NVDA'];

async function withDb<T>(fn: (db: D1Database) => Promise<T>): Promise<T> {
  const d = await freshDb();
  try {
    return await fn(d.db);
  } finally {
    await d.dispose();
  }
}

/** 用假資料的參數另外算一次排名（不經過 ingest 的程式）。 */
async function expectedOrder(date: string, exclude: string[] = []): Promise<string[]> {
  const spy = await parseSpyHoldings(SPY_XLSX);
  const rows = spy.holdings
    .filter((h) => !exclude.includes(h.ticker))
    .map((h) => ({ t: h.ticker, w: h.weight, dv: fakeClose(h.ticker, date) * fakeParams(h.ticker).volume, g: fakeParams(h.ticker).g }));
  const liquid = [...rows].sort((a, b) => b.dv - a.dv).slice(0, 100);
  const large = [...liquid].sort((a, b) => b.w - a.w).slice(0, 50);
  return [...large].sort((a, b) => b.g - a.g).map((r) => r.t);
}

describe('每日抓取：正常的一天', () => {
  it('存成分股快照與價格；不是月底不排名；沒有告警', async () => {
    await withDb(async (db) => {
      const w = newWorld('2026-11-12');
      const r = await runIngest(db, fakeFetcher(w), { now: cronTime('2026-11-12'), required: REQUIRED });
      expect(r).toMatchObject({ session: '2026-11-12', status: 'OK', signalsOk: true, rebalanceOk: true, ranked: false });
      expect(r.alerts).toEqual([]);

      const members = (await loadConstituents(db))!;
      expect(members.session).toBe('2026-11-12');
      expect(members.consistent).toBe(true);
      expect(members.holdings.length).toBeGreaterThan(495);
      expect(members.holdings.find((h) => h[0] === 'AAPL')![2]).toBe('0000320193');

      // 必要的代號＋基準＋市值前 80 名
      const top = [...members.holdings].sort((a, b) => b[1] - a[1]).slice(0, 80).map((h) => h[0]);
      const series = await loadSeries(db, [...REQUIRED, BENCHMARK, ...top]);
      expect(series.size).toBe(new Set([...REQUIRED, BENCHMARK, ...top]).size);
      for (const s of series.values()) {
        expect(s.d).toHaveLength(501);
        expect(s.d.at(-1)).toBe('2026-11-12');
      }
      expect(series.get('BRK.B')!.c.at(-1)).toBeCloseTo(fakeClose('BRK.B', '2026-11-12'), 3);
      // 對外請求：2 份名單＋每檔 1 次，沒有抓全部成分股
      expect(w.calls.length).toBe(2 + series.size);
      expect((await loadRun(db, '2026-11-12'))!.status).toBe('OK');
    });
  });

  it('盤中手動跑：訊號日是前一個交易日，Yahoo 多帶的那一根（還沒收盤）丟掉', async () => {
    await withDb(async (db) => {
      const w = newWorld('2026-11-12'); // Yahoo 已經有 11/12 的（盤中的）K 線
      const r = await runIngest(db, fakeFetcher(w), { now: new Date('2026-11-12T15:00:00Z'), required: REQUIRED });
      expect(r).toMatchObject({ session: '2026-11-11', status: 'OK', signalsOk: true });
      const s = (await loadSeries(db, ['VOO'])).get('VOO')!;
      expect(s.d.at(-1)).toBe('2026-11-11');
      expect(s.d).toHaveLength(500);
    });
  });
});

describe('連跑數日（含感恩節、週末、月底）', () => {
  it('每天的訊號日正確；只有月底那天排名；每天都能組出引擎要的市場資料', async () => {
    await withDb(async (db) => {
      const seen: { day: string; session: string; ranked: boolean; viewDate: string }[] = [];
      for (let day = '2026-11-23'; day <= '2026-12-01'; day = addDays(day, 1)) {
        const now = cronTime(day);
        const w = newWorld(lastCompletedSession(now));
        const r = await runIngest(db, fakeFetcher(w), { now, required: REQUIRED });
        expect(r.status).toBe('OK');
        const { view, axis, stale } = buildMarketView(await loadSeries(db, REQUIRED), r.session, 'VOO');
        expect(stale).toEqual([]);
        expect(axis.every((d) => isTradingDay(d))).toBe(true);
        expect(view.close.MU[view.i]).toBeCloseTo(fakeClose('MU', r.session), 3);
        seen.push({ day, session: r.session, ranked: r.ranked, viewDate: view.date });
      }
      expect(seen.map((s) => [s.day.slice(5), s.session.slice(5), s.ranked])).toEqual([
        ['11-23', '11-23', false],
        ['11-24', '11-24', false],
        ['11-25', '11-25', false],
        ['11-26', '11-25', false], // 感恩節
        ['11-27', '11-27', false],
        ['11-28', '11-27', false], // 週六
        ['11-29', '11-27', false], // 週日
        ['11-30', '11-30', true], // 十一月最後一個交易日 → 月報的訊號日
        ['12-01', '12-01', false],
      ]);
      expect(seen.every((s) => s.viewDate === s.session)).toBe(true);
      expect((await loadRanking(db))!.session).toBe('2026-11-30');
      // 每個交易日一份成分股快照
      const n = await db.prepare('SELECT COUNT(*) AS n FROM constituents').first<{ n: number }>();
      expect(n!.n).toBe(6);
    });
  });
});

describe('缺資料', () => {
  it('必要的代號抓不到 → 不產生訊號、告警；失敗會再試一次', async () => {
    await withDb(async (db) => {
      const w = newWorld('2026-11-12');
      w.fail.add('VOO');
      const r = await runIngest(db, fakeFetcher(w), { now: cronTime('2026-11-12'), required: REQUIRED });
      expect(r).toMatchObject({ status: 'FAILED', signalsOk: false, rebalanceOk: true });
      expect(r.alerts.map((a) => a.kind)).toEqual(['PRICE_MISSING']);
      expect(r.alerts[0].message).toContain('VOO');
      expect(w.calls.filter((u) => u.includes('/chart/VOO?')).length).toBe(2);
      // 沒有核心 ETF 的日線 → 組不出市場資料
      expect(() => buildMarketView(new Map(), '2026-11-12', 'VOO')).toThrow(StaleDataError);
      const alerts = (await recentAlerts(db)) as { kind: string; sent_at: string | null }[];
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({ kind: 'PRICE_MISSING', sent_at: null });
    });
  });

  it('不是必要的代號抓不到 → 照常產生訊號，只記錄', async () => {
    await withDb(async (db) => {
      const w = newWorld('2026-11-12');
      w.fail.add('JPM');
      const r = await runIngest(db, fakeFetcher(w), { now: cronTime('2026-11-12'), required: REQUIRED });
      expect(r).toMatchObject({ status: 'OK', signalsOk: true });
      expect((r.detail as { otherFailed: string[] }).otherFailed).toEqual(['JPM']);
    });
  });

  it('所有對外請求都失敗 → 不產生訊號、暫停換股，各有一則告警', async () => {
    await withDb(async (db) => {
      const env: Env = { DB: db, ADMIN_TOKEN: 't' };
      const boom = async () => {
        throw new Error('network down');
      };
      const res = await handle(new Request('https://bot.example/admin/ingest', { method: 'POST', headers: { Authorization: 'Bearer t' } }), env, boom, cronTime('2026-11-12'));
      const body = (await res.json()) as { status: string; signalsOk: boolean; rebalanceOk: boolean; alerts: { kind: string }[] };
      expect(body).toMatchObject({ status: 'FAILED', signalsOk: false, rebalanceOk: false });
      expect(body.alerts.map((a) => a.kind).sort()).toEqual(['MEMBERSHIP_UNAVAILABLE', 'PRICE_MISSING']);
    });
  });
});

describe('舊資料', () => {
  it('最新 K 線不是上一個交易日 → 不產生訊號、告警', async () => {
    await withDb(async (db) => {
      const w = newWorld('2026-11-11'); // Yahoo 還停在前一天
      const r = await runIngest(db, fakeFetcher(w), { now: cronTime('2026-11-12'), required: REQUIRED });
      expect(r).toMatchObject({ session: '2026-11-12', status: 'FAILED', signalsOk: false });
      expect(r.alerts.map((a) => a.kind)).toEqual(['PRICE_STALE']);
      expect(r.alerts[0].message).toContain('MU 到 2026-11-11');
      expect(() => buildMarketView(new Map([['VOO', { ticker: 'VOO', fetchedAt: '', session: '', d: ['2026-11-11'], c: [1], a: [1], v: [1] }]]), '2026-11-12', 'VOO')).toThrow(StaleDataError);
    });
  });

  it('只有一檔持股是舊的 → 一樣不產生訊號；這一檔不會放進市場資料', async () => {
    await withDb(async (db) => {
      const w = newWorld('2026-11-12');
      w.lastBar.MU = '2026-11-10';
      const r = await runIngest(db, fakeFetcher(w), { now: cronTime('2026-11-12'), required: REQUIRED });
      expect(r.signalsOk).toBe(false);
      expect((r.detail as { requiredStale: string[] }).requiredStale).toEqual(['MU']);
      const built = buildMarketView(await loadSeries(db, REQUIRED), '2026-11-12', 'VOO');
      expect(built.stale).toEqual(['MU']);
      expect(built.view.close.MU).toBeUndefined();
      expect(built.view.close.NVDA).toBeDefined();
    });
  });

  it('當天其實休市（臨時休市）：在 calendar_overrides 補一筆之後，訊號日往前一天，資料就不算舊', async () => {
    await withDb(async (db) => {
      const w = newWorld('2026-11-11');
      await db.prepare("INSERT INTO calendar_overrides (date, open, note) VALUES ('2026-11-12', 0, '測試：臨時休市')").run();
      const r = await runIngest(db, fakeFetcher(w), { now: cronTime('2026-11-12'), required: REQUIRED });
      expect(r).toMatchObject({ session: '2026-11-11', status: 'OK', signalsOk: true });
    });
  });
});

describe('來源不一致', () => {
  it('SPY 持股檔和 Wikipedia 不一致 → 暫停換股並告警；每日訊號照常', async () => {
    await withDb(async (db) => {
      const w = newWorld('2026-11-30');
      w.wikiText = w.wikiText.replace('|MMM}}', '|ZZZZ}}');
      const r = await runIngest(db, fakeFetcher(w), { now: cronTime('2026-11-30'), required: REQUIRED });
      expect(r).toMatchObject({ status: 'DEGRADED', signalsOk: true, rebalanceOk: false, ranked: false });
      expect(r.alerts.map((a) => a.kind)).toEqual(['MEMBERSHIP_MISMATCH']);
      expect(r.alerts[0].message).toContain('只在 SPY 持股檔：MMM');
      expect(r.alerts[0].message).toContain('只在 Wikipedia：ZZZZ');
      // 月底也不排名（不會抓全部成分股）
      expect(await loadRanking(db)).toBeNull();
      expect(w.calls.length).toBeLessThan(120);
      const snap = (await loadConstituents(db))!;
      expect(snap).toMatchObject({ consistent: false, onlySpy: ['MMM'], onlyWiki: ['ZZZZ'] });
    });
  });

  it('持股檔抓不到 → 暫停換股並告警；用最近一份名單決定要抓哪些價格', async () => {
    await withDb(async (db) => {
      await runIngest(db, fakeFetcher(newWorld('2026-11-27')), { now: cronTime('2026-11-27'), required: REQUIRED });
      const w = newWorld('2026-11-30');
      w.ssgaDown = true;
      const r = await runIngest(db, fakeFetcher(w), { now: cronTime('2026-11-30'), required: REQUIRED });
      expect(r).toMatchObject({ status: 'DEGRADED', signalsOk: true, rebalanceOk: false, ranked: false });
      expect(r.alerts.map((a) => a.kind)).toEqual(['MEMBERSHIP_UNAVAILABLE']);
      expect((r.detail as { tracked: number }).tracked).toBeGreaterThan(80);
      // 沒有存成今天的快照
      expect((await loadConstituents(db))!.session).toBe('2026-11-27');
    });
  });
});

describe('月底的股票池與排名', () => {
  it('成交金額前 100 → 市值前 50 → 252 日報酬排名，和另外獨立算的一致', async () => {
    await withDb(async (db) => {
      const w = newWorld('2026-11-30');
      const r = await runIngest(db, fakeFetcher(w), { now: cronTime('2026-11-30'), required: REQUIRED });
      expect(r).toMatchObject({ status: 'OK', rebalanceOk: true, ranked: true });
      const rk = (await loadRanking(db, '2026-11-30'))!;
      expect(rk.order).toEqual(await expectedOrder('2026-11-30'));
      expect(rk.order).toHaveLength(50);
      expect(rk.detail.universe).toHaveLength(50);
      expect(rk.detail.missing).toEqual([]);
      const top = rk.detail.universe.find((u) => u.ticker === rk.order[0])!;
      expect(top.momentum).toBeCloseTo(Math.exp(fakeParams(rk.order[0]).g * 252) - 1, 4);
      // 全部成分股都有成交金額：沒有整段日線的抓 5 天
      expect(w.calls.filter((u) => u.includes('range=5d')).length).toBeGreaterThan(400);
      // 同一家公司的兩類股
      const co = companyOf(rk);
      expect(co('GOOGL')).toBe(co('GOOG'));
      expect(co('AAPL')).toBe('AAPL');
      // 兩類股都排在前面時只進一類
      const sel = selectMomentum(['GOOGL', 'GOOG', 'AAPL', 'MSFT', 'NVDA', 'META'], [], { companyOf: co });
      expect(sel.names).toEqual(['GOOGL', 'AAPL', 'MSFT', 'NVDA', 'META']);
    });
  });

  it('不是月底可以強制排名（上線當天、手動測試）', async () => {
    await withDb(async (db) => {
      const r = await runIngest(db, fakeFetcher(newWorld('2026-11-12')), { now: cronTime('2026-11-12'), required: REQUIRED, forceRank: true });
      expect(r.ranked).toBe(true);
      expect(r.ranking!.order).toEqual(await expectedOrder('2026-11-12'));
    });
  });

  it('少數小型成分股抓不到 → 照常排名並列出來；上市不滿 252 天的不進排名', async () => {
    await withDb(async (db) => {
      const spy = await parseSpyHoldings(SPY_XLSX);
      const small = [...spy.holdings].sort((a, b) => a.weight - b.weight).slice(0, 10).map((h) => h.ticker);
      const w = newWorld('2026-11-30');
      for (const t of small) w.fail.add(yahooSymbol(t));
      const exp = await expectedOrder('2026-11-30', small);
      w.bars[yahooSymbol(exp[0])] = 200; // 排第一的那檔當成剛上市
      const r = await runIngest(db, fakeFetcher(w), { now: cronTime('2026-11-30'), required: REQUIRED });
      expect(r).toMatchObject({ status: 'OK', ranked: true });
      expect(r.ranking!.detail.missing.sort()).toEqual([...small].sort());
      expect(r.ranking!.order).toEqual(exp.slice(1));
      expect(r.ranking!.detail.universe.find((u) => u.ticker === exp[0])!.momentum).toBeNull();
    });
  });

  it('市值前 60 名有一檔抓不到 → 不排名、暫停換股、告警', async () => {
    await withDb(async (db) => {
      const w = newWorld('2026-11-30');
      w.fail.add('JPM');
      const r = await runIngest(db, fakeFetcher(w), { now: cronTime('2026-11-30'), required: REQUIRED });
      expect(r).toMatchObject({ status: 'DEGRADED', signalsOk: true, rebalanceOk: false, ranked: false });
      expect(r.alerts.map((a) => a.kind)).toEqual(['RANKING_FAILED']);
      expect(r.alerts[0].message).toContain('JPM');
      expect(await loadRanking(db)).toBeNull();
    });
  });

  it('超過 5% 的成分股抓不到 → 不排名', async () => {
    await withDb(async (db) => {
      const spy = await parseSpyHoldings(SPY_XLSX);
      const w = newWorld('2026-11-30');
      for (const h of [...spy.holdings].sort((a, b) => a.weight - b.weight).slice(0, 30)) w.fail.add(yahooSymbol(h.ticker));
      const r = await runIngest(db, fakeFetcher(w), { now: cronTime('2026-11-30'), required: REQUIRED });
      expect(r).toMatchObject({ rebalanceOk: false, ranked: false });
      expect(r.alerts[0]).toMatchObject({ kind: 'RANKING_FAILED' });
      expect(r.alerts[0].message).toContain('30 檔');
    });
  });
});

describe('組市場資料', () => {
  const s = (ticker: string, d: string[], c: number[], a: number[]): Series => ({ ticker, fetchedAt: '', session: '', d, c, a, v: d.map(() => 1) });
  const days = ['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12'];

  it('還原收盤整段調成「訊號日 = 實際收盤」；訊號日之後的不看', () => {
    const m = new Map([
      ['VOO', s('VOO', [...days, '2026-11-13'], [600, 601, 602, 603, 604], [600, 601, 602, 603, 604])],
      // 11/13 除息：Yahoo 把之前的還原收盤都乘了 0.99
      ['MU', s('MU', [...days, '2026-11-13'], [100, 110, 120, 130, 128], [99, 108.9, 118.8, 128.7, 128])],
    ]);
    const { view, axis } = buildMarketView(m, '2026-11-12', 'VOO');
    expect(axis).toEqual(days);
    expect(view).toMatchObject({ date: '2026-11-12', i: 3 });
    expect(Array.from(view.close.MU)).toEqual([100, 110, 120, 130].map((x) => expect.closeTo(x, 9)));
  });

  it('上市之前是 NaN；中間缺的日子用前一天補，並記下補了幾天', () => {
    const m = new Map([
      ['VOO', s('VOO', days, [600, 601, 602, 603], [600, 601, 602, 603])],
      ['NEW', s('NEW', ['2026-11-10', '2026-11-12'], [50, 52], [50, 52])],
    ]);
    const { view, filled } = buildMarketView(m, '2026-11-12', 'VOO');
    expect(Array.from(view.close.NEW)).toEqual([NaN, 50, 50, 52]);
    expect(filled).toEqual({ NEW: 1 });
  });

  it('通知的 seq 用日期重算（時間軸每天往前滑）', () => {
    const acct = { notifs: [{ date: '2026-11-11', seq: 999 }, { date: '2026-11-08', seq: 999 }, { date: '2025-01-02', seq: 999 }] } as unknown as Parameters<typeof rebaseNotifSeq>[0];
    rebaseNotifSeq(acct, days);
    // 11/8 是週日 → 沒有比它早的交易日在時間軸上；更舊的通知也是 -1
    expect(acct.notifs.map((n) => n.seq)).toEqual([2, -1, -1]);
  });
});

describe('帳本儲存', () => {
  let db: D1Database;
  let dispose: () => Promise<void>;
  beforeAll(async () => {
    const d = await freshDb();
    db = d.db;
    dispose = d.dispose;
  });
  afterAll(() => dispose());

  it('還沒建立帳戶：必要的代號只有核心 ETF 與短債', async () => {
    expect(await loadAccount(db)).toBeNull();
    expect(requiredTickers(null)).toEqual(['VOO', 'SGOV']);
  });

  it('存檔、載入、再操作、再存檔：狀態、通知、事件、影子紀錄、快照都留著；同時存檔後到的被擋下', async () => {
    const tickers = ['VOO', 'SGOV', 'MU', 'NVDA', 'AAPL'];
    await runIngest(db, fakeFetcher(newWorld('2026-11-12')), { now: cronTime('2026-11-12'), required: tickers });
    const built = buildMarketView(await loadSeries(db, tickers), '2026-11-12', 'VOO');
    const px = (t: string) => built.view.close[t][built.view.i];
    const acct0 = createAccount({ cash: 1000, paper: true, own: { MU: { shares: 40, stdWeight: 0.1 } }, mom: { NVDA: 30, AAPL: 20 }, core: { VOO: 80 } }, built.view);

    // 第 1 版
    expect(await saveAccount(db, acct0, null, '建立帳戶', new Date('2026-11-12T23:40:00Z'))).toBe(1);
    const l1 = (await loadAccount(db))!;
    expect(l1.rev).toBe(1);
    expect(l1.acct).toEqual({ ...acct0, events: [], shadow: [] });
    expect(l1.acct.paper).toBe(true);
    expect(requiredTickers(l1.acct).sort()).toEqual([...tickers].sort());

    // 入金 → 產生通知；回報快照 → 產生事件
    rebaseNotifSeq(l1.acct, built.axis);
    const dep = deposit(l1.acct, built.view, 5000);
    expect(await saveAccount(db, dep.acct, l1, '入金', new Date('2026-11-12T23:41:00Z'))).toBe(2);
    const l2 = (await loadAccount(db))!;
    expect(l2.rev).toBe(2);
    expect(l2.acct.notifs).toHaveLength(1);
    expect(l2.acct.notifs[0]).toEqual(dep.acct.notifs[0]);
    expect(l2.acct.cash).toBeCloseTo(6000, 6);
    expect((await loadEvents(db)).map((e) => e.kind)).toEqual(['DEPOSIT']);

    // 同一份載入的資料存兩次：第二次要被擋下，而且什麼都沒寫進去
    const a = dailyCheck(l2.acct, built.view).acct;
    expect(await saveAccount(db, a, l2, '每日檢查', new Date('2026-11-12T23:42:00Z'))).toBe(3);
    const other = deposit(l2.acct, built.view, 999).acct;
    await expect(saveAccount(db, other, l2, '入金', new Date('2026-11-12T23:42:01Z'))).rejects.toThrow(ConflictError);
    const l3 = (await loadAccount(db))!;
    expect(l3.rev).toBe(3);
    expect(l3.acct.cash).toBeCloseTo(6000, 6);
    expect(l3.acct.notifs).toHaveLength(1);
    expect((await loadEvents(db)).map((e) => e.kind)).toEqual(['DEPOSIT']);

    // 照清單買進後填快照
    const n = l3.acct.notifs[0];
    const shares: Record<string, number> = { MU: 40, NVDA: 30, AAPL: 20, VOO: 80 };
    let spent = 0;
    for (const line of n.preview!.lines) {
      shares[line.ticker] = (shares[line.ticker] ?? 0) + line.shares;
      spent += line.shares * px(line.ticker);
    }
    const snap = { shares, cash: 6000 - spent };
    rebaseNotifSeq(l3.acct, built.axis);
    const applied = applySnapshot(l3.acct, built.view, snap);
    const rev = await saveAccount(db, applied.acct, l3, '填快照', new Date('2026-11-13T01:00:00Z'));
    await saveSnapshot(db, '2026-11-12', snap, new Date('2026-11-13T01:00:00Z'), rev);
    expect(rev).toBe(4);
    const l4 = (await loadAccount(db))!;
    expect(l4.acct.notifs[0].status).toBe('DONE');
    const events = await loadEvents(db);
    expect(events.filter((e) => e.kind === 'TRADE').length).toBe(n.preview!.lines.length);
    expect(events.every((e) => !('amount' in e) || typeof e.amount === 'number')).toBe(true);
    expect((await loadShadow(db)).length).toBe(applied.acct.shadow.length);

    // 每一版都留著；快照原文留著
    const hist = (await db.prepare('SELECT rev, cause FROM account_history ORDER BY rev').all<{ rev: number; cause: string }>()).results;
    expect(hist.map((h) => h.cause)).toEqual(['建立帳戶', '入金', '每日檢查', '填快照']);
    const snaps = (await db.prepare('SELECT date, cash, positions, rev FROM snapshots').all<{ date: string; cash: number; positions: string; rev: number }>()).results;
    expect(snaps).toHaveLength(1);
    expect(JSON.parse(snaps[0].positions)).toEqual(shares);
    expect(snaps[0].rev).toBe(4);
  });
});

describe('端點與排程', () => {
  it('/admin/ingest 與 /admin/data/status 要 ADMIN_TOKEN；狀態列出最近的抓取、告警、排名', async () => {
    await withDb(async (db) => {
      const env: Env = { DB: db, ADMIN_TOKEN: 'admin-secret' };
      const f = fakeFetcher(newWorld('2026-11-30'));
      const post = (path: string, token?: string) => handle(new Request('https://bot.example' + path, { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {} }), env, f, cronTime('2026-11-30'));
      expect((await post('/admin/ingest')).status).toBe(401);
      expect((await post('/admin/ingest', 'wrong')).status).toBe(401);
      const res = await post('/admin/ingest', 'admin-secret');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { session: string; ranked: boolean; ranking: { order: string[] } };
      expect(body).toMatchObject({ session: '2026-11-30', status: 'OK', ranked: true });
      expect(body.ranking.order).toHaveLength(50);

      const st = await handle(new Request('https://bot.example/admin/data/status', { headers: { Authorization: 'Bearer admin-secret' } }), env, f, cronTime('2026-11-30'));
      const status = (await st.json()) as { runs: { session: string }[]; alerts: unknown[]; series: { n: number; byLastDate: Record<string, number> }; ranking: { session: string; top15: string[] }; constituents: { consistent: boolean } };
      expect(status.runs[0].session).toBe('2026-11-30');
      expect(status.alerts).toEqual([]);
      expect(Object.keys(status.series.byLastDate)).toEqual(['2026-11-30']);
      expect(status.ranking.top15).toEqual(body.ranking.order.slice(0, 15));
      expect(status.constituents.consistent).toBe(true);
    });
  });

  it('排程時間寫在 wrangler 設定裡，而且和程式用的是同一個', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const cfg = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'wrangler.jsonc'), 'utf8');
    expect(cfg).toContain(`"${INGEST_CRON}"`);
  });
});
