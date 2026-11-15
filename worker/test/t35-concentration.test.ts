// T35：集中度與部位大小（own_thesis §3.6.3；問題 P9）。
// 完成條件：
//   有、沒有高度相關組合兩種情況（合計不到 15%、相關係數不到 0.7、只有動能之間、核心 ETF 不算）
//   越過 2 倍列一次、跌回 1.5 倍以下後再越過會再列
//   到單檔上限的不列
//   sizeFlag 成立時討論包有 §1.7 的那一句
// 另外：每月算一次（月報的頻率、組合變了才算新的一件）、持股頁、每日流程更新旗標、不改下單。
// 價格是自己造的假資料（共同走勢加各自的雜訊）；所有代號最後一天都是 100、總資產 100 萬，占比一目了然。
import { describe, expect, it } from 'vitest';
import { discussionNumbers, discussionPack } from '../src/ai/discussion';
import { CONC, SIZE, concentrationGroups, concentrationHits, sizeOf, updateSizeFlags } from '../src/app/concentration';
import type { Env, Fetcher } from '../src/app/env';
import { runFlow } from '../src/app/flow';
import { loadAccount, saveAccount } from '../src/app/ledgerStore';
import { dueAttention, holdingAttention, monthOwnAttention, ownAttention, type ThesisFile } from '../src/app/thesis';
import { buildMarketView } from '../src/data/marketView';
import { loadSeries } from '../src/data/store';
import { createAccount, totalValue, type Account, type MarketView } from '../src/engine';
import { freshDb } from './helpers/d1';
import { cronTime, fakeFetcher, newWorld } from './helpers/fakeSources';

// ---------------------------------------------------------------- 假市場與假帳戶

const N = 400;
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32 - 0.5;
  };
}
/** 日報酬 = 共同走勢 + 自己的雜訊；最後一天的價格正規化成 100。 */
function series(common: number[], noise: number, seed: number): number[] {
  const r = rng(seed);
  const out = [100];
  for (let k = 1; k < N; k++) out.push(out[k - 1] * (1 + 0.04 * common[k] + 0.04 * noise * r()));
  const f = 100 / out[N - 1];
  return out.map((x) => x * f);
}
const mkCommon = (seed: number) => {
  const r = rng(seed);
  return Array.from({ length: N }, () => r());
};
const FA = mkCommon(11);
const FB = mkCommon(22);

/** 同一個題材（A 組）、另一個題材（B 組）、各自獨立。 */
function market(date = '2026-11-30'): MarketView {
  return {
    date,
    i: N - 1,
    close: {
      VOO: series(mkCommon(1), 0.5, 1),
      SGOV: Array.from({ length: N }, () => 100),
      NVDA: series(FA, 0.2, 101),
      MU: series(FA, 0.2, 102),
      AVGO: series(FA, 0.2, 103),
      MSFT: series(FB, 0.2, 104),
      META: series(FB, 0.2, 105),
      KO: series(mkCommon(31), 0, 106),
      JPM: series(mkCommon(32), 0, 107),
    },
  };
}

interface Hold {
  own?: Record<string, { w: number; std?: number }>;
  mom?: Record<string, number>;
}
const TOTAL = 1_000_000;
/** 照占比（小數）造帳戶：所有代號收盤都是 100，現金補到總資產 100 萬。 */
function acctOf(h: Hold, view = market()): Account {
  const own = Object.fromEntries(Object.entries(h.own ?? {}).map(([t, o]) => [t, { shares: Math.round((o.w * TOTAL) / 100), stdWeight: o.std ?? 0.05 }]));
  const mom = Object.fromEntries(Object.entries(h.mom ?? {}).map(([t, w]) => [t, Math.round((w * TOTAL) / 100)]));
  const spent = [...Object.values(own).map((o) => o.shares), ...Object.values(mom)].reduce((a, b) => a + b, 0) * 100;
  const core = 4000;
  const a = createAccount({ paper: true, cash: TOTAL - spent - core * 100, core: { VOO: core }, own, mom }, view);
  expect(totalValue(a, view)).toBeCloseTo(TOTAL, 0);
  return a;
}
const setShares = (a: Account, t: string, sh: number): Account => {
  const n = structuredClone(a);
  n.cash += ((n.lots.own[t] ?? 0) - sh) * 100;
  n.lots.own[t] = sh;
  return n;
};

// ---------------------------------------------------------------- 集中度

describe('集中度：自選之間、自選與動能之間的高度相關組合', () => {
  it('沒有高度相關的組合：互相獨立的股票，占比再大也不列', () => {
    const a = acctOf({ own: { KO: { w: 0.12 }, JPM: { w: 0.12 } } });
    expect(concentrationGroups(a, market())).toEqual([]);
    expect(concentrationHits(a, market())).toEqual([]);
  });

  it('有高度相關的組合、合計 ≥ 15%：列一組，文字有代號、相關係數、合計與各檔占比', () => {
    const v = market();
    const a = acctOf({ own: { NVDA: { w: 0.09 }, MU: { w: 0.07 } } }, v);
    const gs = concentrationGroups(a, v);
    expect(gs).toHaveLength(1);
    expect(gs[0].members.map((m) => m.ticker)).toEqual(['NVDA', 'MU']);
    expect(gs[0].weight).toBeCloseTo(0.16, 6);
    expect(gs[0].corrMin).toBeGreaterThanOrEqual(CONC.corr);
    const hits = concentrationHits(a, v);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ ticker: 'MU', kind: 'CONCENTRATION', src: 'own', key: 'CONCENTRATION:MU+NVDA', every: 3, since: '', members: ['MU', 'NVDA'] });
    expect(hits[0].text).toMatch(/^NVDA、MU 走勢很像（近一年日報酬的相關係數 0\.9\d），合計占總資產 16\.0%（NVDA 9\.0%、MU 7\.0%）。同一個題材出問題時會一起跌，要不要調整由你決定$/);
  });

  it('有高度相關的組合、但合計不到 15%：不列（剛好 15% 要列）', () => {
    const v = market();
    expect(concentrationGroups(acctOf({ own: { NVDA: { w: 0.07 }, MU: { w: 0.07 } } }, v), v)).toEqual([]);
    expect(concentrationGroups(acctOf({ own: { NVDA: { w: 0.08 }, MU: { w: 0.07 } } }, v), v)).toHaveLength(1);
  });

  it('相關係數不到 0.7 的兩檔不算同一組（不同題材的兩組各自 8%，不會併起來）', () => {
    const v = market();
    const a = acctOf({ own: { NVDA: { w: 0.08 }, MSFT: { w: 0.08 } } }, v);
    expect(concentrationGroups(a, v)).toEqual([]);
  });

  it('自選與動能持股之間也算：組內有一檔自選就列，動能那一檔標「動能」', () => {
    const v = market();
    const a = acctOf({ own: { NVDA: { w: 0.08 } }, mom: { MU: 0.08 } }, v);
    const hits = concentrationHits(a, v);
    expect(hits).toHaveLength(1);
    expect(hits[0].ticker).toBe('NVDA'); // 掛在自選那一檔
    expect(hits[0].text).toContain('MU（動能） 8.0%');
    // 只有動能之間：不在這份「自選股要看的事」裡
    expect(concentrationHits(acctOf({ mom: { NVDA: 0.09, MU: 0.09 } }, v), v)).toEqual([]);
  });

  it('同一檔自選與動能都有，占比算在一起；三檔連成一組；核心 ETF 不算', () => {
    const v = market();
    const a = acctOf({ own: { NVDA: { w: 0.05 }, MU: { w: 0.04 } }, mom: { NVDA: 0.03, AVGO: 0.04 } }, v);
    const g = concentrationGroups(a, v)[0];
    expect(g.members.map((m) => [m.ticker, Math.round(m.weight * 100)])).toEqual([['NVDA', 8], ['AVGO', 4], ['MU', 4]]);
    expect(g.weight).toBeCloseTo(0.16, 6);
    // VOO（核心）和這些股票走勢再像，也不會被併進去
    expect(g.members.some((m) => m.ticker === 'VOO')).toBe(false);
  });

  it('價格不齊（資料不足 120 天）的那一對當作不相關；算不出總資產時回傳空的', () => {
    const v = market();
    const short = { ...v, close: { ...v.close, MU: Array.from(v.close.MU).map((x, k) => (k < N - 100 ? NaN : x)) } };
    const a = acctOf({ own: { NVDA: { w: 0.09 }, MU: { w: 0.07 } } }, v);
    expect(concentrationGroups(a, short)).toEqual([]);
    expect(concentrationGroups(a, { ...v, close: { VOO: v.close.VOO } })).toEqual([]);
  });

  it('月報：沒列過的列、隔不滿 3 個月不再列、組合換了才算新的一件、滿 3 個月再列', async () => {
    const d = await freshDb();
    try {
      const v = market('2026-11-30');
      const a = acctOf({ own: { NVDA: { w: 0.09 }, MU: { w: 0.07 } } }, v);
      const m1 = await monthOwnAttention(d.db, a, v);
      const c1 = m1.items.filter((x) => x.kind === 'CONCENTRATION');
      expect(c1).toHaveLength(1);
      expect(c1[0].ticker).toBe('MU');
      expect(m1.acct.own.MU.attnShown).toMatchObject({ 'CONCENTRATION:MU+NVDA': '2026-11-30' });
      // 下個月、再下個月：不再列
      for (const date of ['2026-12-31', '2027-01-29']) {
        const m = await monthOwnAttention(d.db, m1.acct, { ...v, date });
        expect(m.items.filter((x) => x.kind === 'CONCENTRATION')).toEqual([]);
      }
      // 滿 3 個月（2027-02）再列
      const m4 = await monthOwnAttention(d.db, m1.acct, { ...v, date: '2027-02-26' });
      expect(m4.items.filter((x) => x.kind === 'CONCENTRATION')).toHaveLength(1);
      // 組合換了（多一檔 AVGO）：算新的一件，下個月就列
      const a2 = acctOf({ own: { NVDA: { w: 0.09 }, MU: { w: 0.07 }, AVGO: { w: 0.03 } } }, v);
      const a2s = { ...a2, own: { ...a2.own, MU: { ...a2.own.MU, attnShown: m1.acct.own.MU.attnShown } } };
      const m2 = await monthOwnAttention(d.db, a2s, { ...v, date: '2026-12-31' });
      expect(m2.items.find((x) => x.kind === 'CONCENTRATION')?.text).toContain('NVDA、MU、AVGO');
      // 帳戶沒有高度相關組合：沒有這一件，帳戶不變
      const none = await monthOwnAttention(d.db, acctOf({ own: { KO: { w: 0.12 } } }, v), v);
      expect(none.items.filter((x) => x.kind === 'CONCENTRATION')).toEqual([]);
    } finally {
      await d.dispose();
    }
  });

  it('持股頁：組內每一檔自選都顯示這一件，組外的不顯示；不是自選回傳空的', async () => {
    const d = await freshDb();
    try {
      const v = market();
      const a = acctOf({ own: { NVDA: { w: 0.09 }, MU: { w: 0.07 }, KO: { w: 0.03 } } }, v);
      for (const t of ['NVDA', 'MU']) expect((await holdingAttention(d.db, a, v, t)).filter((x) => x.kind === 'CONCENTRATION')).toHaveLength(1);
      expect((await holdingAttention(d.db, a, v, 'KO')).filter((x) => x.kind === 'CONCENTRATION')).toEqual([]);
      expect(await holdingAttention(d.db, a, v, 'AVGO')).toEqual([]);
    } finally {
      await d.dispose();
    }
  });
});

// ---------------------------------------------------------------- 部位大小

const std = (t: string, a: Account) => a.rule.own[t].stdWeight;

describe('部位大小：sizeFlag 與 SIZE_2X', () => {
  it('sizeOf：自選桶的市值占總資產、標準比重、倍數（動能的股數不算）', () => {
    const v = market();
    const a = acctOf({ own: { NVDA: { w: 0.11, std: 0.05 } }, mom: { NVDA: 0.02 } }, v);
    const s = sizeOf(a, v, 'NVDA')!;
    expect(s.weight).toBeCloseTo(0.11, 6);
    expect(s.std).toBe(0.05);
    expect(s.ratio).toBeCloseTo(2.2, 6);
    expect(sizeOf(a, v, 'MU')).toBeNull();
  });

  it('越過 2 倍設旗並記下越過那一天；沒到 2 倍、到了單檔上限的不設旗', () => {
    const v = market('2026-11-24');
    const base = acctOf({ own: { NVDA: { w: 0.09, std: 0.05 } } }, v); // 1.8 倍
    expect(updateSizeFlags(base, v)).toBe(base); // 沒變動：同一個物件
    const up = updateSizeFlags(setShares(base, 'NVDA', 1100), v); // 11% = 2.2 倍
    expect(up.own.NVDA.sizeFlag).toBe(true);
    expect(up.own.NVDA.sizeInfo).toEqual({ at: '2026-11-24', weight: 0.11, ratio: 2.2 });
    // 不改原本的帳戶
    expect(base.own.NVDA.sizeFlag).toBeUndefined();
    // 剛好 2 倍（標準比重 5%、10%）也算
    expect(updateSizeFlags(setShares(base, 'NVDA', 1000), v).own.NVDA.sizeFlag).toBe(true);
    // 到單檔上限（15%）：F10 處理，不設旗；標準比重大的、倍數不到 2 的也不設
    expect(updateSizeFlags(setShares(base, 'NVDA', 1600), v).own.NVDA.sizeFlag).toBeUndefined();
    const big = acctOf({ own: { NVDA: { w: 0.12, std: 0.1 } } }, v);
    expect(updateSizeFlags(big, v)).toBe(big);
  });

  it('旗設了之後：1.5～2 倍之間維持、只更新最新占比；跌到 1.5 倍以下收回；再越過記新的一天', () => {
    const v = market('2026-11-24');
    let a = updateSizeFlags(setShares(acctOf({ own: { NVDA: { w: 0.09, std: 0.05 } } }, v), 'NVDA', 1100), v);
    expect(a.own.NVDA.sizeInfo?.at).toBe('2026-11-24');
    // 回到 1.8 倍：旗還在、越過的日子不變、占比更新
    a = updateSizeFlags(setShares(a, 'NVDA', 900), { ...v, date: '2026-12-01' });
    expect(a.own.NVDA.sizeFlag).toBe(true);
    expect(a.own.NVDA.sizeInfo).toEqual({ at: '2026-11-24', weight: 0.09, ratio: 1.8 });
    // 1.5 倍（剛好）收回
    a = updateSizeFlags(setShares(a, 'NVDA', 750), { ...v, date: '2026-12-02' });
    expect(a.own.NVDA.sizeFlag).toBe(false);
    expect(a.own.NVDA.sizeInfo).toBeNull();
    // 再往上：1.9 倍不設旗；2.1 倍設旗，日子是這一天
    a = updateSizeFlags(setShares(a, 'NVDA', 950), { ...v, date: '2026-12-03' });
    expect(a.own.NVDA.sizeFlag).toBe(false);
    a = updateSizeFlags(setShares(a, 'NVDA', 1050), { ...v, date: '2026-12-04' });
    expect(a.own.NVDA.sizeFlag).toBe(true);
    expect(a.own.NVDA.sizeInfo?.at).toBe('2026-12-04');
  });

  const hitsOf = (a: Account, date: string) => ownAttention([fileFor(a, 'NVDA')], a, { date }).filter((x) => x.kind === 'SIZE_2X');

  it('SIZE_2X：旗成立才列，文字照設計；到單檔上限、旗收回的不列；同一次越過只列一次，跌回 1.5 倍以下再越過會再列', () => {
    const v = market('2026-11-24');
    let a = updateSizeFlags(setShares(acctOf({ own: { NVDA: { w: 0.09, std: 0.05 } } }, v), 'NVDA', 1120), v);
    const h = hitsOf(a, '2026-11-30');
    expect(h).toEqual([{ ticker: 'NVDA', kind: 'SIZE_2X', src: 'own', key: 'SIZE_2X@2026-11-24', every: null, since: '2026-11-24', text: 'NVDA 占總資產 11.2%，是標準比重的 2.2 倍（超過 15% 會減回 10%）' }]);
    // 到單檔上限：不列（旗還在，F10 會處理）
    const capped = updateSizeFlags(setShares(a, 'NVDA', 1600), { ...v, date: '2026-11-25' });
    expect(capped.own.NVDA.sizeFlag).toBe(true);
    expect(hitsOf(capped, '2026-11-30')).toEqual([]);
    // F10 減回 10% 之後（2 倍）又是「還沒到上限」：同一次越過，鍵一樣
    const back = updateSizeFlags(setShares(capped, 'NVDA', 1000), { ...v, date: '2026-11-26' });
    expect(hitsOf(back, '2026-11-30')[0].key).toBe('SIZE_2X@2026-11-24');
    // 月報頻率：第一份月報列、下個月（旗還在）不再列
    const m1 = dueAttention(h, {}, '2026-11-30');
    expect(m1.due).toHaveLength(1);
    expect(dueAttention(hitsOf(a, '2026-12-31'), m1.shown, '2026-12-31').due).toEqual([]);
    expect(dueAttention(hitsOf(a, '2027-06-30'), m1.shown, '2027-06-30').due).toEqual([]);
    // 旗收回：不列
    const down = updateSizeFlags(setShares(a, 'NVDA', 700), { ...v, date: '2026-12-10' });
    expect(hitsOf(down, '2026-12-31')).toEqual([]);
    // 跌回 1.5 倍以下之後再越過：新的鍵，再列一次
    a = updateSizeFlags(setShares(down, 'NVDA', 1150), { ...v, date: '2027-01-12' });
    const again = hitsOf(a, '2027-01-29');
    expect(again[0].key).toBe('SIZE_2X@2027-01-12');
    expect(dueAttention(again, m1.shown, '2027-01-29').due).toHaveLength(1);
    // 沒有旗（舊資料沒有這個欄位）：不列
    expect(hitsOf(acctOf({ own: { NVDA: { w: 0.12, std: 0.05 } } }, v), '2026-11-30')).toEqual([]);
  });

  it('討論包：sizeFlag 成立時例行情境多 §1.7 的那一句；沒有旗、別的情境沒有', () => {
    const v = market();
    const flagged = updateSizeFlags(setShares(acctOf({ own: { NVDA: { w: 0.09, std: 0.05 } } }, v), 'NVDA', 1120), v);
    const f = fileFor(flagged, 'NVDA');
    const text = discussionPack(f, discussionNumbers(flagged, v, 'NVDA', null), 'ROUTINE');
    expect(text).toContain('這檔現在占總資產 11.2%，是標準比重的 2.2 倍。\n請問我：今天從零開始，會不會買到這個比重。');
    // 沒有旗（9% = 1.8 倍）：沒有那一句
    const plain = acctOf({ own: { NVDA: { w: 0.09, std: 0.05 } } }, v);
    expect(discussionPack(f, discussionNumbers(plain, v, 'NVDA', null), 'ROUTINE')).not.toContain('是標準比重的');
    // 有旗但這次是別的情境（NEW、BREAK）：照設計只有例行檢視多這一句
    expect(discussionPack(f, discussionNumbers(flagged, v, 'NVDA', null), 'BREAK')).not.toContain('是標準比重的');
    // 數字區塊仍然沒有金額與股數
    expect(text).not.toMatch(/\$\s?\d|1120 股|1,120/);
    // 旗成立、但倍數掉到 2 以下（1.8）：句子寫現在的倍數
    const mid = setShares(flagged, 'NVDA', 900);
    expect(discussionPack(f, discussionNumbers(mid, v, 'NVDA', null), 'ROUTINE')).toContain('是標準比重的 1.8 倍');
    expect(std('NVDA', flagged)).toBe(0.05);
  });
});

function fileFor(a: Account, ticker: string): ThesisFile {
  return {
    ticker,
    fileId: a.own[ticker].fileId ?? null,
    openedAt: '2026-01-02',
    origin: 'NEW',
    kind: 'THESIS',
    status: 'OPEN',
    thesis: null,
    premises: [{ id: 'P1', text: '需求延續', origin: 'USER', addedAt: '2026-01-02', lastCheck: null, splitAfter: false }],
    conditions: [],
    events: [],
    reviews: [],
    disputes: [],
    flags: [],
    lastReview: null,
    newSince: '2025-09-01',
    log: [],
  } as unknown as ThesisFile;
}

// ---------------------------------------------------------------- 每日流程更新旗標、月報、不改下單

describe('每日流程：旗標更新、月報列一次、不改下單', () => {
  it('越過 2 倍的那一天設旗；月底的月報列 SIZE_2X；之後不再列；旗不影響規則的下單', async () => {
    const d = await freshDb();
    try {
      const w = newWorld('2026-11-19');
      const env: Env = { DB: d.db, ADMIN_TOKEN: 't', SITE_URL: 'https://bot.example', DEV_NO_AUTH: '1' };
      const fetcher: Fetcher = fakeFetcher(w);
      const run = (date: string) => {
        w.dataDate = date;
        return runFlow(env, fetcher, { now: cronTime(date), attempt: 'FIRST' });
      };
      await run('2026-11-19');
      const { view } = buildMarketView(await loadSeries(d.db, ['VOO', 'SGOV', 'NVDA', 'MSFT']), '2026-11-19', 'VOO');
      const px = (t: string) => view.close[t][view.i];
      // NVDA 約 10% 的標準比重只有 4%（約 2.5 倍），MSFT 約 4% 的標準比重 5%（不到 2 倍）
      const acct = createAccount(
        { paper: true, cash: 10_000, core: { VOO: Math.floor(130_000 / px('VOO')) }, own: { NVDA: { shares: Math.floor(20_000 / px('NVDA')), stdWeight: 0.04 }, MSFT: { shares: Math.floor(8_000 / px('MSFT')), stdWeight: 0.05 } } },
        view,
      );
      const before = structuredClone(acct);
      await saveAccount(d.db, acct, null, '建立帳戶', new Date('2026-11-19T12:00:00Z'));
      for (const day of ['2026-11-20', '2026-11-23', '2026-11-24', '2026-11-25', '2026-11-27']) await run(day);
      const mid = (await loadAccount(d.db))!.acct;
      expect(mid.own.NVDA.sizeFlag).toBe(true);
      expect(mid.own.NVDA.sizeInfo?.at).toBe('2026-11-20');
      expect(mid.own.NVDA.sizeInfo!.ratio).toBeGreaterThanOrEqual(SIZE.up);
      expect(mid.own.MSFT.sizeFlag).toBeUndefined();
      // 規則狀態與下單不受影響：標準比重、慢規則狀態沒變、沒有多出通知
      expect(mid.rule.own.NVDA).toEqual(before.rule.own.NVDA);
      expect(mid.notifs.length).toBe(before.notifs.length);
      // 月底的月報列一次
      const r = await run('2026-11-30');
      const acct1 = (await loadAccount(d.db))!.acct;
      const n = acct1.notifs.find((x) => x.id === r.monthly)!;
      const size = (n.attention ?? []).filter((x) => x.kind === 'SIZE_2X');
      expect(size).toHaveLength(1);
      expect(size[0]).toMatchObject({ ticker: 'NVDA', since: '2026-11-20', src: 'own' });
      expect(size[0].text).toMatch(/^NVDA 占總資產 \d+\.\d%，是標準比重的 \d\.\d 倍（超過 15% 會減回 10%）$/);
      expect(Object.keys(acct1.own.NVDA.attnShown ?? {})).toContain('SIZE_2X@2026-11-20');
      // 持股頁列出（不看頻率）：旗還在就一直列
      const again = await holdingAttention(d.db, acct1, buildMarketView(await loadSeries(d.db, ['VOO', 'SGOV', 'NVDA', 'MSFT']), '2026-11-30', 'VOO').view, 'NVDA');
      expect(again.some((x) => x.kind === 'SIZE_2X')).toBe(true);
      // 下一份月報不再列
      const m2 = await monthOwnAttention(d.db, acct1, buildMarketView(await loadSeries(d.db, ['VOO', 'SGOV', 'NVDA', 'MSFT']), '2026-11-30', 'VOO').view);
      expect(m2.items.filter((x) => x.kind === 'SIZE_2X')).toEqual([]);
    } finally {
      await d.dispose();
    }
  });
});
