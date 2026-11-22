// T85 乙段：價格型進場條件、F29 候補進場、候補 → 持股的轉換（allocation_redesign §4.5 第 11～17 點）。
// 完成條件：
//   1. 只靠價格條件把整條路走完：加候補 → 設價格條件 → 月報 F29 → 照做 → 填快照 → 持股（先買一半）；
//      有論點、進場時已經比高點低 20% 以上的：隔天照常觸發跌幅審查，結果是前提都沒有被判不成立時通知上有「補滿」的下跌加碼
//   2. 自己先買（清單外買進）→ 直接轉持股（標準＋持股頁預選先買一半）；不重複開論點檔
//   3. F29 的行是 bucket own、rule.own 還沒有這檔：合成清單（錢從核心 80：20）、其他清單當成做完、晚回覆重算都要對
//   4. 效果只在快照的自選桶真的有股數才套；沒買的還是候補（補做差額或就這樣）；復原快照時帳戶和條件一致
//   5. 沒提的原因（90 天、硬傷、申報抓不到、財報類出場條件、30 天內前提被判不成立、上限、自選 0%）都寫在候補那一塊、留到下個月
//   6. 非價格的進場條件成立之後記進 watch[t].entry（丙段寫）；月報這一端讀得到、超過 100 天丟掉
// 對外請求全部是假的。
import { describe, expect, it } from 'vitest';
import type { ApplyCtx } from '../src/app/aiCtx';
import type { Env, Fetcher } from '../src/app/env';
import { runFlow } from '../src/app/flow';
import { LINE_PUSH_URL } from '../src/app/line';
import { fileChanges, loadAccount, ownFilesOf, saveAccount, watchFilesOf } from '../src/app/ledgerStore';
import { notifyOwnCondition } from '../src/app/ownAi';
import { conditionOp } from '../src/app/ownConds';
import { acceptStatus, confirmText, entryConditions, fileConditions, loadConditions, notifyTier, sameActionKind, type FileCondition } from '../src/app/thesis';
import { entryStateText, listedPriceStmts, priceCheckOf, priceEntriesAt, priceState, splitFactor, watchHardHits, WatchCondError, type EntryCond } from '../src/app/watchEntry';
import { holdingDetail, notifView, wouldBuyLine, type HoldingDetail, type NotifView, type StateView } from '../src/app/site/views';

type Ready = Parameters<typeof holdingDetail>[0];
import { confirmMode } from '../src/ai/ownReview';
import { scenarios } from '../src/demo/scenarios';
import {
  WatchError,
  addWatch,
  afterOpenLists,
  applySnapshot,
  composeNotif,
  deposit,
  drawdownFromHigh,
  monthlyReport,
  priceOf,
  removeWatch,
  resolveFollowUp,
  respond,
  resumeMonthly,
  setStdWeight,
  setThesis,
  totalValue,
  watchRecWeight,
  type Account,
  type Item,
  type Notif,
  type Snapshot,
  type WatchEntryInput,
} from '../src/engine';
import { handle } from '../src/index';
import { freshDb } from './helpers/d1';
import { cronTime, fakeFetcher, newWorld, type World } from './helpers/fakeSources';
import { makeMarket, ranksAt } from './helpers/market';
import { Sim, type SimDrop } from './helpers/sim';

// ---------------------------------------------------------------- 引擎用的小工具

const T = 'GOOGL';
const DIP_OK = { ok: true, why: '3 票都判 1 條前提成立（有申報或財報的引用）；個股自身的跌幅不超過整段的一半' };
const CLEAR: SimDrop = { status: 'CLEAR', runId: 'drop-1', extra: { dip: DIP_OK } };

/**
 * 情境 ① 的帳戶，另外把 GOOGL（不在任何一桶）加進候補、打算放 4%。GOOGL 前 4 天跌 27% 之後橫盤（12-01 的月報那天比高點低 25% 以上）。
 * thesis：有你的論點（一條前提）；flat：GOOGL 不跌。
 */
function world(o: { thesis?: boolean; flat?: boolean; std?: number | null } = {}) {
  const path = o.flat ? [{ n: 45, ret: 0.03, vol: 0.05 }] : [{ n: 4, ret: -0.27, vol: 0.05 }, { n: 41, ret: 0.0, vol: 0.06 }];
  const market = makeMarket('2026-11-23', 45, { over: { [T]: { path } } });
  const sim = new Sim(market, scenarios.s1().init, { drops: { [T]: CLEAR } });
  sim.acct = addWatch(sim.acct, sim.pre, T, { note: '搜尋的現金流撐得住 AI 的投資', stdWeight: o.std === undefined ? 0.04 : o.std });
  if (o.thesis) sim.acct = setThesis(sim.acct, T, { text: '等它跌深了再買', source: 'TYPED', premises: [{ id: null, text: '搜尋廣告營收年增維持正的' }], date: sim.pre.date }).acct;
  return sim;
}
/** 你填的一條價格條件（真實模式存在 own_conditions；引擎測試直接給）。 */
function cond(sim: Sim, type: 'close' | 'drawdown', value: number, id = 501): EntryCond {
  const x = priceCheckOf({ type, value }, sim.pre.date);
  return { id, ticker: T, fileId: sim.acct.watch![T].fileId, text: x.text, price: true, check: x.check, status: 'ACTIVE', setAt: sim.pre.date, metAt: null, note: null };
}
const toMonth = (sim: Sim) => {
  while (!sim.isFirstOfMonth()) sim.day();
};
/** 出月報（輸入照正式流程：訊號日收盤仍成立的價格條件；extra 是硬傷之類的檢查結果）。 */
function monthly(sim: Sim, conds: EntryCond[], extra: Partial<WatchEntryInput> = {}): Notif {
  const watchEntries = priceEntriesAt(sim.acct, sim.pre, { [T]: conds }).map((e) => ({ ...e, ...extra }));
  const r = monthlyReport(sim.acct, sim.pre, { order: ranksAt(sim.market, sim.d - 1), vetoed: ['APP'], month: sim.month, ...(watchEntries.length ? { watchEntries } : {}) });
  sim.acct = r.acct;
  return r.notif;
}
/** 分桶快照：帳本＋已回覆的清單照做（開盤價成交）；own：自選桶另外的變動（代號 → 股數）；skip：這幾檔沒有照清單下單。 */
function bucketSnap(sim: Sim, o: { own?: Record<string, number>; skip?: string[] } = {}): Snapshot {
  const lots = { own: { ...sim.acct.lots.own }, mom: { ...sim.acct.lots.mom }, core: { ...sim.acct.lots.core } };
  let cash = sim.acct.cash;
  const px = (t: string) => sim.market.open[t][sim.d];
  const add = (b: 'own' | 'mom' | 'core', t: string, q: number) => {
    lots[b][t] = (lots[b][t] ?? 0) + q;
    cash -= q * px(t);
  };
  for (const n of sim.acct.notifs) if (n.status === 'RESPONDED' && n.composed) for (const l of n.composed.lines) if (!o.skip?.includes(l.ticker)) add(l.bucket as 'own' | 'mom' | 'core', l.ticker, l.shares);
  for (const [t, q] of Object.entries(o.own ?? {})) add('own', t, q);
  const shares: Record<string, number> = {};
  for (const b of ['own', 'mom', 'core'] as const) for (const [t, q] of Object.entries(lots[b])) shares[t] = (shares[t] ?? 0) + q;
  return { shares, lots, cash };
}
const fill = (sim: Sim, o: Parameters<typeof bucketSnap>[1] = {}) => {
  const r = applySnapshot(sim.acct, sim.pre, bucketSnap(sim, o), (t) => sim.market.open[t][sim.d]);
  expect(r.error).toBeUndefined();
  sim.acct = r.acct;
  return r;
};
const f29 = (n: Notif): Item | undefined => n.items.find((i) => i.f === 'F29' && !i.cancelled);
const live = (sim: Sim, id: number) => sim.acct.notifs.find((n) => n.id === id)!;
const ready = (sim: Sim, extra: Partial<Ready> = {}): Ready => ({ mode: 'demo', acct: sim.acct, view: sim.pre, axis: sim.market.days.slice(0, sim.d), rankOrder: [], rankSession: null, aiNotes: [], events: [], shadow: [], today: sim.date, warnings: [], ...extra });

// ---------------------------------------------------------------- 1. 價格條件（純函式）

/** 前面墊 300 天的 100（52 週高點要有夠長的歷史），後面接這幾天的收盤。 */
const hist = (tail: number[]) => Float64Array.from([...Array(299).fill(100), ...tail]);

describe('T85 乙 ①：價格型進場條件（你自己填的數字，程式比）', () => {
  it('結構化欄位 → 文字與 check；數字不合理的擋下', () => {
    expect(priceCheckOf({ type: 'drawdown', value: 25 }, '2026-11-20')).toEqual({ text: '比 52 週高點低 25% 以上', check: { type: 'price_drawdown_below', pct: 25, asOf: '2026-11-20' } });
    expect(priceCheckOf({ type: 'close', value: 150 }, '2026-11-20')).toEqual({ text: '收盤低於 $150', check: { type: 'price_close_below', level: 150, asOf: '2026-11-20' } });
    expect(() => priceCheckOf({ type: 'drawdown', value: 0 }, '2026-11-20')).toThrow(WatchCondError);
    expect(() => priceCheckOf({ type: 'drawdown', value: 95 }, '2026-11-20')).toThrow('1～90');
    expect(() => priceCheckOf({ type: 'close', value: -3 }, '2026-11-20')).toThrow('大於 0');
  });

  it('比對：收盤低於、比 52 週高點低；沒有收盤價是 null（不算成立也不算不成立）', () => {
    const c = hist([100, 120, 110, 88]);
    expect(priceState({ type: 'price_drawdown_below', pct: 25 }, c, c.length - 1)).toMatchObject({ met: true, now: '現在 -26.7%' });
    expect(priceState({ type: 'price_drawdown_below', pct: 30 }, c, c.length - 1)).toMatchObject({ met: false });
    expect(priceState({ type: 'price_drawdown_below', pct: 5 }, c, c.length - 3)).toMatchObject({ met: false, now: '現在 在 52 週高點' });
    expect(priceState({ type: 'price_close_below', level: 90 }, c, c.length - 1)).toMatchObject({ met: true, now: '現在收盤 $88' });
    expect(priceState({ type: 'price_close_below', level: 88 }, c, c.length - 1).met).toBe(false);
    expect(priceState({ type: 'price_close_below', level: 90 }, undefined, 3)).toEqual({ met: null, now: null });
    expect(priceState({ type: 'price_close_below', level: 90 }, Float64Array.from([100, NaN]), 1).met).toBeNull();
  });

  it('拆股：條件填了之後才生效的拆股要把「收盤低於 $X」的 X 一起換算（1 拆 2 不會誤觸發）；填之前的不算', () => {
    const splits = [{ ticker: 'AMD', date: '2026-12-10', numerator: 2, denominator: 1 }, { ticker: 'AMD', date: '2026-10-01', numerator: 4, denominator: 1 }, { ticker: 'MU', date: '2026-12-10', numerator: 3, denominator: 1 }];
    expect(splitFactor(splits, 'AMD', '2026-11-20')).toBe(0.5);
    expect(splitFactor(splits, 'AMD', '2026-12-10')).toBe(1);
    // 填的是 $150；1 拆 2 之後價格序列變成 $100（拆股前是 $200，沒有跌）→ 換算成 $75，不成立
    const c = Float64Array.from([100, 100]);
    expect(priceState({ type: 'price_close_below', level: 150 }, c, 1, 1).met).toBe(true);
    expect(priceState({ type: 'price_close_below', level: 150 }, c, 1, 0.5)).toMatchObject({ met: false, level: 75 });
    const x: EntryCond = { id: 1, ticker: 'AMD', fileId: 'AMD@2026-11-20', text: '收盤低於 $150', price: true, check: { type: 'price_close_below', level: 150, asOf: '2026-11-20' }, status: 'ACTIVE', setAt: '2026-11-20', metAt: null, note: null };
    expect(entryStateText(x, c, 1, 0.5)).toBe('現在收盤 $100，還沒到（拆股後換算成 $75）');
    expect(entryStateText({ ...x, check: { type: 'price_drawdown_below', pct: 25 } }, hist([100, 120, 88]), 301)).toBe('現在 -26.7%，條件成立中（月報那天仍然成立才會列進月報）');
    expect(entryStateText({ ...x, status: 'MET', metAt: '2027-02-01T23:40:00Z' }, c, 1)).toBe('已成立（2/1）：一次性的，要再等就重新定條件');
    expect(entryStateText(x, undefined, 1)).toBe('價格抓不到，沒辦法比');
  });

  it('怎麼存：動作是 ENTRY、另成一組（不能和出場、加碼互換）；只有「ENTRY＋兩種價格 check」才監測，其他價格條件照舊只記錄', () => {
    expect(sameActionKind('ENTRY', 'ENTRY')).toBe(true);
    expect(sameActionKind('ENTRY', 'FILL')).toBe(false);
    expect(sameActionKind('ENTRY', 'EXIT')).toBe(false);
    expect(sameActionKind('FILL', 'RAISE')).toBe(true);
    expect(notifyTier({ action: 'ENTRY', direction: 'UP', tierIfMet: null })).toBeNull();
    const check = { type: 'price_drawdown_below', pct: 25 };
    expect(confirmMode({ kind: 'PRICE', check, action: 'ENTRY' })).toBe('PRICE');
    expect(confirmMode({ kind: 'PRICE', check, action: 'EXIT' })).toBe('NONE');
    expect(confirmMode({ kind: 'PRICE', check })).toBe('NONE');
    expect(confirmMode({ kind: 'PRICE', check: { type: 'price_above', level: 3 }, action: 'ENTRY' })).toBe('NONE');
    expect(acceptStatus({ kind: 'PRICE', check, auto: true, status: 'ACTIVE', action: 'ENTRY' })).toBe('ACTIVE');
    expect(acceptStatus({ kind: 'PRICE', check, auto: true, status: 'ACTIVE', action: 'EXIT' })).toBe('MANUAL');
    expect(confirmText({ kind: 'PRICE', check, auto: true, status: 'ACTIVE', action: 'ENTRY' })).toBe('程式每天比收盤；月報訊號日仍然成立才列進月報');
  });

  it('硬傷（規則偵測，申報來的）：被收購方、延遲申報、財報重編、會計師辭任擋；增資、只記錄的收購不擋', () => {
    const h = (code: string, sub: string, form: string, displayOnly = false) => ({ code, sub, form, date: '2027-01-12', displayOnly });
    expect(watchHardHits([])).toBeNull();
    expect(watchHardHits([h('DILUTION', '8K_3.02', '8-K', true), h('PENDING_MA', 'SC_TO-T_OTHER', 'SC TO-T', true), h('ACCOUNTING', '8K_4.01_DISMISS', '8-K')])).toBeNull();
    expect(watchHardHits([h('ACCOUNTING', 'NT_10-Q', 'NT 10-Q')])).toBe('延遲申報季報，NT 10-Q 2027-01-12');
    expect(watchHardHits([h('ACCOUNTING', '8K_4.02', '8-K'), h('ACCOUNTING', '8K_4.01_RESIGN', '8-K'), h('PENDING_MA', 'SC_14D9', 'SC 14D9')])).toBe('財報重編（8-K 4.02），8-K 2027-01-12；會計師辭任，8-K 2027-01-12；被收購，SC 14D9 2027-01-12');
  });
});

// ---------------------------------------------------------------- 2. 整條路：有論點、比高點低 25%

describe('T85 乙 ②：加候補 → 價格條件 → 月報 F29 → 照做、填快照 → 先買一半 → 隔天跌幅審查 → 補滿的下跌加碼', () => {
  it('整條路走一次（有論點、進場時已經比高點低 20% 以上）', () => {
    const sim = world({ thesis: true });
    const c = cond(sim, 'drawdown', 25);
    const fileId = sim.acct.watch![T].fileId;
    const addedAt = sim.acct.watch![T].addedAt;
    toMonth(sim);
    expect(sim.date).toBe('2026-12-01');
    const dd = drawdownFromHigh(sim.pre.close[T], sim.pre.i, 252);
    expect(dd).toBeLessThan(-0.25);
    // 月中成立過不算：決定列不列的是月報訊號日的收盤
    const entries = priceEntriesAt(sim.acct, sim.pre, { [T]: [c] });
    expect(entries).toHaveLength(1);
    expect(entries[0].conds[0]).toMatchObject({ id: 501, text: '比 52 週高點低 25% 以上', price: true });
    expect(entries[0].conds[0].why).toContain('2026-11-30 收盤比 52 週高點低');

    // ---- 月報列 F29
    const total = totalValue(sim.acct, sim.pre);
    const want = Math.floor((0.04 * 0.5 * total) / priceOf(sim.pre, T));
    expect(want).toBeGreaterThan(0);
    const m = monthly(sim, [c]);
    const it = f29(m)!;
    expect(it.kind).toBe('WATCH_ENTRY');
    expect(it.title).toBe(`候補 ${T}：你在 2026-11-20 定的進場條件「比 52 週高點低 25% 以上」成立（現在比 52 週高點低 ${(-dd * 100).toFixed(1)}%） → 先買一半：買 ${want} 股（標準比重 4.0%，錢從核心拿）`);
    expect(it.choices.map((x) => [x.id, x.label])).toEqual([['DO', `照做：先買一半，買 ${want} 股`], ['SKIP', '這次不做']]);
    expect([it.choice, it.ruleChoice, it.reasonRequired ?? false]).toEqual(['DO', 'DO', false]);
    expect(it.choices[0].lines).toEqual([{ ticker: T, bucket: 'own', shares: want, reason: '候補進場' }]);
    expect(it.choices[0].effects).toEqual([{ type: 'WATCH_ENTER', ticker: T, std: 0.04, conds: [501] }]);
    expect(it.watchEntry).toEqual({ std: 0.04, recUsed: false, conds: [{ id: 501, price: true }], fromHigh: dd, half: false, wouldBuy: null });
    // 這一行是自選桶，但 rule.own 還沒有這檔；候補還在，記下列的那一天
    expect(sim.acct.rule.own[T]).toBeUndefined();
    expect(sim.acct.own[T]).toBeUndefined();
    expect(sim.acct.watch![T]).toMatchObject({ lastListed: '2026-11-30' });
    // 錢從核心照 80：20 拿（合成的清單裡核心兩檔都賣）
    const solo: Notif = { ...m, id: 9999, items: [it] };
    const comp = composeNotif(sim.acct, sim.pre, solo);
    const coreLines = comp.lines.filter((l) => l.bucket === 'core' && l.shares < 0);
    const cost = want * priceOf(sim.pre, T);
    const sold = (t: string) => -coreLines.filter((l) => l.ticker === t).reduce((a, l) => a + l.shares * priceOf(sim.pre, t), 0);
    // 錢從核心拿（composeWithCore：帳上的現金先用，其餘照 80：20 賣核心兩檔；T80 的規則，這裡只確認這一行有被核心接住）
    expect(comp.lines.filter((l) => l.shares < 0).every((l) => l.bucket === 'core')).toBe(true);
    expect(sold('VOO')).toBeGreaterThan(0);
    const funded = sim.acct.cash - comp.cashAfter + sold('VOO') + sold('SGOV');
    expect(Math.abs(funded - cost)).toBeLessThan(1);
    expect(comp.cashAfter).toBeGreaterThanOrEqual(0);
    // 網站：項目、理由、「今天會不會買」的位置（草稿是丙段：沒有時寫明）
    const v = notifView(ready(sim), live(sim, m.id));
    const iv = v.items.find((x) => x.key === it.key)!;
    expect(iv.label).toBe('候補進場');
    expect(iv.headline).toBe(`買 ${T} ${want} 股`);
    expect(iv.bucket).toBe('own');
    expect(iv.choices.map((x) => [x.id, x.isDefault])).toEqual([['DO', true], ['SKIP', false]]);
    expect(iv.entryInfo).toBe(wouldBuyLine(null));
    expect(iv.entryInfo).toContain('還沒有論點草稿');
    expect(wouldBuyLine({ answer: '會，但只買一半', date: '2026-11-25' })).toBe('「今天沒持股的話會不會買」：會，但只買一半（11/25 的論點草稿裡反方的答案；只是資訊，不影響這一項）');
    expect(iv.explain.why).toContain('在候補名單，還沒持有');
    expect(iv.explain.math?.[0]).toContain('× 一半 ×');
    expect(iv.reasonRequired).toBe(false);

    // ---- 照做：其他清單把它當成做完時，目標是先買一半（入金不會把它再買一次、也不會因為沒有 rule 而壞掉）
    sim.respond(m.id);
    expect(live(sim, m.id).status).toBe('RESPONDED');
    expect(sim.acct.shadow.filter((s) => s.f === 'F29')).toMatchObject([{ ticker: T, rule: want, ai: null, actual: want, choice: 'DO' }]);
    const after = afterOpenLists(sim.acct, sim.pre, {});
    expect(after.lots.own[T]).toBe(want);
    expect(after.rule.own[T]).toEqual({ applied: 'BUILD', stdWeight: 0.04 });
    expect(sim.acct.rule.own[T]).toBeUndefined();
    const dep = deposit(sim.acct, sim.pre, 3000);
    expect(dep.notif.items[0].choices[0].lines.filter((l) => l.ticker === T)).toEqual([]);

    // ---- 填快照：自選桶有了股數才轉成持股；論點檔沿用、先買一半、不問
    const before = sim.acct;
    const r = fill(sim);
    expect(r.completed).toContain(m.id);
    expect(r.entered).toEqual([{ ticker: T, via: 'F29', state: 'BUILD' }]);
    expect(sim.acct.watch?.[T]).toBeUndefined();
    const meta = sim.acct.own[T];
    expect(meta).toMatchObject({ origin: 'WATCH', fileId, heldSince: '2026-11-30', build: { since: '2026-11-30', confirmBy: 'EARNINGS', misses: 0 }, buyNote: { text: '搜尋的現金流撐得住 AI 的投資' }, thesis: { text: '等它跌深了再買' } });
    expect(meta.slow.state).toBe('BUILD');
    expect(meta.buildAsk).toBeUndefined();
    expect(meta.premises.map((p) => p.text)).toEqual(['搜尋廣告營收年增維持正的']);
    expect(meta.entered).toEqual({ via: 'F29', date: '2026-11-30', shares: want, state: 'BUILD', addedAt, conds: [501] });
    expect(sim.acct.rule.own[T]).toEqual({ applied: 'BUILD', stdWeight: 0.04 });
    expect(sim.acct.lots.own[T]).toBe(want);
    // 論點檔的紀錄：同一個編號從候補搬到自選，不寫 OPEN／CLOSE，寫一筆 ENTERED
    const logs = fileChanges(ownFilesOf(before), sim.acct, new Date('2026-12-01T02:00:00Z'), watchFilesOf(before));
    expect(logs.filter((l) => l.ticker === T)).toEqual([{ ticker: T, fileId, session: '2026-11-30', kind: 'ENTERED', body: { via: 'F29', shares: want, state: 'BUILD', addedAt } }]);
    // 持股頁：`11/20 加入候補 → 11/30 進場`；先買一半、不問
    const hd = holdingDetail(ready(sim), T);
    expect(hd.own).toMatchObject({ state: '先買一半', askBuild: false, entered: '11/20 加入候補 → 11/30 進場（照月報的進場項目買的，先買一半）。論點沿用候補時寫的那一份。' });
    expect(hd.watch).toBeNull();
    expect(hd.own!.build!.text).toMatch(/^從候補名單進場，先買一半：現在的目標是標準比重 4\.0% 的一半（2\.0%），還沒買的部分留在核心。開始持有之後的第一份財報過關/);

    // ---- 隔天（12-01 收盤）：照常觸發跌幅審查（D2、D3 不因為剛買而例外）；審查說前提都沒有被判不成立 → 通知上有「補滿」
    const created = sim.close();
    sim.d++;
    const dn = created.find((n) => n.items.some((i) => i.f === 'F7' && i.ticker === T && !!i.thesisDrop));
    expect(dn).toBeDefined();
    const di = dn!.items.find((i) => i.ticker === T)!;
    expect(sim.acct.own[T].slow.state).toBe('WATCH');
    expect(sim.acct.own[T].build).toBeTruthy();
    expect(sim.acct.rule.own[T].applied).toBe('BUILD');
    expect(di.drop).toBe('CLEAR');
    const fillWant = Math.floor((0.04 * totalValue(sim.acct, sim.pre)) / priceOf(sim.pre, T) + 1e-9) - want;
    expect(fillWant).toBeGreaterThan(0);
    expect(di.choices.map((x) => [x.id, x.label])).toEqual([['SKIP', '不動'], ['RULE', '減半'], ['AI', `補滿到標準比重，買 ${fillWant} 股`]]);
    expect(di.choice).toBe('SKIP');
    expect(di.dipAdd).toMatchObject({ mode: 'FILL', shares: fillWant });
    expect(sim.acct.own[T].dropReview!.dipOffer).toMatchObject({ ok: true, mode: 'FILL', shares: fillWant });
  });

  it('只有預設前提、進場時已經比高點低 20% 以上：照 §4.1 既有規則從減半開始（F29 的標題寫明）；目標一樣是標準的一半', () => {
    const sim = world();
    const c = cond(sim, 'drawdown', 25);
    toMonth(sim);
    const m = monthly(sim, [c]);
    const it = f29(m)!;
    expect(it.title).toContain('→ 先買一半：買');
    expect(it.title.endsWith('；只有預設前提、已經比高點低 20% 以上，進場後從減半開始')).toBe(true);
    expect(it.watchEntry!.half).toBe(true);
    expect(it.choices[0].effects).toEqual([{ type: 'WATCH_ENTER', ticker: T, std: 0.04, half: true, conds: [501] }]);
    sim.respond(m.id);
    expect(afterOpenLists(sim.acct, sim.pre, {}).rule.own[T]).toEqual({ applied: 'HALF', stdWeight: 0.04 });
    const r = fill(sim);
    expect(r.entered).toEqual([{ ticker: T, via: 'F29', state: 'HALF' }]);
    expect(sim.acct.own[T].slow.state).toBe('HALF');
    expect(sim.acct.own[T].build).toBeUndefined();
    expect(sim.acct.own[T].opened).toMatchObject({ startState: 'HALF' });
    expect(sim.acct.rule.own[T]).toEqual({ applied: 'HALF', stdWeight: 0.04 });
    // 隔天不會再觸發減半（已經是減半），也沒有跌幅審查（只有預設前提）
    const created = sim.close();
    expect(created.filter((n) => n.items.some((i) => i.ticker === T))).toEqual([]);
    expect(holdingDetail(ready(sim), T).own).toMatchObject({ state: '減半中', entered: expect.stringContaining('從減半開始') });
  });

  it('沒跌深的（收盤低於 $X）：先買一半、不從減半開始；比重留空用列的當下的推薦值並寫在項目上', () => {
    const sim = world({ flat: true, std: null });
    toMonth(sim);
    const c = cond(sim, 'close', Math.ceil(priceOf(sim.pre, T)) + 5);
    const rec = watchRecWeight(sim.acct, sim.pre, T)!;
    const m = monthly(sim, [c]);
    const it = f29(m)!;
    expect(it.title).not.toContain('從減半開始');
    expect(it.watchEntry).toMatchObject({ std: rec, recUsed: true, half: false });
    expect(it.note).toContain(`比重你留空，用今天的推薦值 ${(rec * 100).toFixed(1)}%`);
    sim.respond(m.id);
    fill(sim);
    expect(sim.acct.own[T].slow.state).toBe('BUILD');
    expect(sim.acct.rule.own[T]).toEqual({ applied: 'BUILD', stdWeight: rec });
  });
});

// ---------------------------------------------------------------- 3. 自己先買

describe('T85 乙 ③：沒等條件、自己先買 → 直接轉成持股', () => {
  it('快照的自選桶出現候補的代號：論點檔沿用（不重複開檔）、標準＋持股頁預選先買一半；還沒回覆的 F29 取消', () => {
    const sim = world({ flat: true });
    const fileId = sim.acct.watch![T].fileId;
    toMonth(sim);
    const c = cond(sim, 'close', Math.ceil(priceOf(sim.pre, T)) + 5);
    const m = monthly(sim, [c]);
    expect(f29(m)).toBeDefined();
    // 月報整則先不回；自己在券商買了 3 股、填在自選桶。F29 還沒回覆、你自己買了：對帳當成照清單做了（走 F29 那條路）
    const viaList = structuredClone(sim.acct);
    const r1 = applySnapshot(viaList, sim.pre, bucketSnap(sim, { own: { [T]: 3 } }), (t) => sim.market.open[t][sim.d]);
    expect(r1.entered).toEqual([{ ticker: T, via: 'F29', state: 'BUILD' }]);
    // 月報選了這次不做之後才自己買：清單外的買進 → 自己先買
    sim.respond(m.id, { mode: 'SKIP' });
    expect(sim.acct.watch![T]).toBeDefined();
    const before = sim.acct;
    const r = fill(sim, { own: { [T]: 3 } });
    expect(r.entered).toEqual([{ ticker: T, via: 'SELF', state: 'STD' }]);
    const meta = sim.acct.own[T];
    expect(meta).toMatchObject({ origin: 'WATCH', fileId, heldSince: '2026-11-30', buildAsk: true, entered: { via: 'SELF', shares: 3, state: 'STD' } });
    expect(meta.slow.state).toBe('STD');
    expect(meta.build).toBeUndefined();
    // 標準比重用候補那一欄（不是改成現在的比重）
    expect(sim.acct.rule.own[T]).toEqual({ applied: 'STD', stdWeight: 0.04 });
    expect(sim.acct.watch?.[T]).toBeUndefined();
    expect(Object.keys(sim.acct.own).filter((t) => t === T)).toHaveLength(1);
    const logs = fileChanges(ownFilesOf(before), sim.acct, new Date('2026-12-01T02:00:00Z'), watchFilesOf(before));
    expect(logs.filter((l) => l.ticker === T).map((l) => l.kind)).toEqual(['ENTERED']);
    // 持股頁：問一次，預選「先買一半」；選了 → 先買一半，200 天從進場算（不是從加入候補算）
    const hd = holdingDetail(ready(sim), T);
    expect(hd.own).toMatchObject({ askBuild: true, askBuildHalf: true, state: '正常' });
    expect(hd.own!.entered).toBe('11/20 加入候補 → 11/30 進場（你沒等進場條件、自己先買的，標準；下面第一次存標準比重時可以選先買一半）。論點沿用候補時寫的那一份。');
    const b = setStdWeight(sim.acct, T, 0.04, { build: true, date: sim.pre.date });
    expect(b.own[T].build).toEqual({ since: '2026-11-30', confirmBy: 'EARNINGS', misses: 0 });
    expect(b.rule.own[T].applied).toBe('BUILD');
    // 不是從候補進場的照舊不預選
    expect(holdingDetail(ready(sim), 'NVDA').own).toMatchObject({ askBuildHalf: false, entered: null });
  });

  it('還沒回覆的 F29 在自己先買（別的路：認養）時取消；晚回覆時候補已經不在 → 取消', () => {
    const sim = world({ flat: true });
    toMonth(sim);
    const m = monthly(sim, [cond(sim, 'close', Math.ceil(priceOf(sim.pre, T)) + 5)]);
    const key = f29(m)!.key;
    // 舊式的總股數快照：F29 還沒回覆、你自己買了 → 對帳當成照清單做了，一樣轉成持股
    const snap = bucketSnap(sim, { own: { [T]: 2 } });
    const legacy = applySnapshot(sim.acct, sim.pre, { shares: snap.shares, cash: snap.cash }, (t) => sim.market.open[t][sim.d]);
    expect(legacy.acct.watch?.[T]).toBeUndefined();
    expect(legacy.acct.own[T]).toMatchObject({ origin: 'WATCH', entered: { via: 'F29' } });
    // 分桶快照（網站用的）：自己先買、月報還沒回覆且清單上買的股數不同也算照清單（同方向）；這裡先把 F29 取消看 SELF
    const a = structuredClone(sim.acct);
    a.notifs.find((n) => n.id === m.id)!.items.find((i) => i.key === key)!.choice = 'SKIP';
    const r = applySnapshot(a, sim.pre, bucketSnap(sim, { own: { [T]: 2 } }), (t) => sim.market.open[t][sim.d]);
    expect(r.entered).toEqual([{ ticker: T, via: 'SELF', state: 'STD' }]);
    const it = r.acct.notifs.find((n) => n.id === m.id)!.items.find((i) => i.key === key)!;
    expect(it.cancelled).toBe(true);
    expect(it.note).toBe(`11/30 你自己先買了，${T} 已經從候補轉成持股，這一項取消`);
  });
});

// ---------------------------------------------------------------- 4. 帳本的邊角

describe('T85 乙 ④：效果只在自選桶真的有股數才套；沒買、補做、晚回覆、移除、重算', () => {
  const listed = (o: Parameters<typeof world>[0] = { flat: true }) => {
    const sim = world(o);
    toMonth(sim);
    const c = cond(sim, 'close', Math.ceil(priceOf(sim.pre, T)) + 5);
    const m = monthly(sim, [c]);
    return { sim, m, c, want: f29(m)!.choices[0].lines[0].shares };
  };

  it('照做了但沒買（快照的自選桶沒有這檔）：還是候補；問補做差額或就這樣；補做買進來之後一樣轉成持股', () => {
    const { sim, m, want } = listed();
    expect(want).toBeGreaterThan(1);
    sim.respond(m.id);
    const r = fill(sim, { skip: [T] });
    expect(r.entered).toBeUndefined();
    expect(sim.acct.watch![T]).toBeDefined();
    expect(sim.acct.own[T]).toBeUndefined();
    expect(sim.acct.lots.own[T]).toBeUndefined();
    expect(r.followUps).toEqual([m.id]);
    expect(live(sim, m.id).followUp).toContainEqual({ ticker: T, listed: want, done: 0 });
    // 就這樣 → 候補留著，條件已經用掉（lastListed 記著，90 天內不再列）
    const asIs = resolveFollowUp(sim.acct, sim.pre, m.id, false).acct;
    expect(asIs.watch![T]).toMatchObject({ lastListed: '2026-11-30' });
    // 補做 → 補做的清單帶著同一個效果
    const fx = resolveFollowUp(sim.acct, sim.pre, m.id, true);
    sim.acct = fx.acct;
    const fi = fx.notif!.items.find((i) => i.ticker === T)!;
    expect(fi.choices[0].lines).toEqual([{ ticker: T, bucket: 'own', shares: want, reason: '策略單補做' }]);
    expect(fi.choices[0].effects).toEqual([{ type: 'WATCH_ENTER', ticker: T, std: 0.04, conds: [501] }]);
    sim.respond(fx.notif!.id);
    const r2 = fill(sim);
    expect(r2.entered).toEqual([{ ticker: T, via: 'F29', state: 'BUILD' }]);
    expect(sim.acct.lots.own[T]).toBe(want);
  });

  it('只買了一部分：自選桶有股數就轉成持股（先買一半），差額照舊問補做', () => {
    const { sim, m, want } = listed();
    sim.respond(m.id);
    const snap = bucketSnap(sim, { skip: [T], own: { [T]: 1 } });
    const r = applySnapshot(sim.acct, sim.pre, snap, (t) => sim.market.open[t][sim.d]);
    expect(r.entered).toEqual([{ ticker: T, via: 'F29', state: 'BUILD' }]);
    expect(r.acct.own[T].entered).toMatchObject({ shares: 1 });
    expect(r.followUps).toEqual(want - 1 > 1 ? [m.id] : []);
  });

  it('這次不做：候補留著、不轉；條件算用掉（lastListed），影子紀錄照記', () => {
    const { sim, m, want } = listed();
    const key = f29(m)!.key;
    sim.respond(m.id, { mode: 'DO', choices: { [key]: 'SKIP' } });
    expect(sim.acct.shadow.filter((s) => s.f === 'F29')).toMatchObject([{ rule: want, actual: 0, choice: 'SKIP' }]);
    fill(sim);
    expect(sim.acct.watch![T]).toMatchObject({ lastListed: '2026-11-30' });
    expect(sim.acct.own[T]).toBeUndefined();
  });

  it('晚回覆（提醒過才回）：照回覆當天的總資產與價格重算先買一半的股數；候補已經移除 → 取消', () => {
    const { sim, m } = listed();
    const key = f29(m)!.key;
    sim.day();
    sim.day();
    sim.day();
    expect(live(sim, m.id).reminded).toBe(true);
    const late = respond(sim.acct, sim.pre, m.id, { mode: 'DO' });
    const it = late.notifs.find((n) => n.id === m.id)!.items.find((i) => i.key === key)!;
    const want2 = Math.floor((0.04 * 0.5 * totalValue(sim.acct, sim.pre)) / priceOf(sim.pre, T) + 1e-9);
    expect(it.choices[0].lines).toEqual([{ ticker: T, bucket: 'own', shares: want2, reason: '候補進場' }]);
    expect(it.note).toBe(`晚回覆：用 ${sim.pre.date} 收盤價重算，買 ${want2} 股`);
    // 30 天內有前提被判不成立（上一次持有結案時記的）→ 重算後不用買
    const broken = structuredClone(sim.acct);
    broken.ownClosed = { [T]: { fileId: `${T}@2026-10-01`, reason: 'EXIT_AI', date: '2026-11-20', brokenAt: '2026-11-18' } };
    const lb = respond(broken, sim.pre, m.id, { mode: 'DO' }).notifs.find((n) => n.id === m.id)!.items.find((i) => i.key === key)!;
    expect(lb.choices[0].lines).toEqual([]);
    expect(lb.note).toContain('11/18 有前提被判不成立，不用買');
  });

  it('移除候補：還沒回覆的 F29 取消；已經決定照做、還沒填快照的不能移除（先改決定）', () => {
    const { sim, m } = listed();
    const key = f29(m)!.key;
    const removed = removeWatch(sim.acct, sim.pre, T);
    const it = removed.notifs.find((n) => n.id === m.id)!.items.find((i) => i.key === key)!;
    expect(it.cancelled).toBe(true);
    expect(it.note).toBe(`11/30 ${T} 已經移出候補，這一項取消`);
    expect(removed.notifs.find((n) => n.id === m.id)!.preview!.lines.some((l) => l.ticker === T)).toBe(false);
    sim.respond(m.id);
    expect(() => removeWatch(sim.acct, sim.pre, T)).toThrow(WatchError);
    expect(() => removeWatch(sim.acct, sim.pre, T)).toThrow('已經決定照做、還沒填快照');
  });

  it('重算月報（入金併進還沒回覆的月報）：F29 照同一份輸入再列一次（lastListed 先還原，不會被 90 天擋掉）；期間改的比重不被還原', () => {
    const { sim, m } = listed();
    sim.acct.watch![T].stdWeight = 0.03;
    const r = deposit(sim.acct, sim.pre, 2000);
    expect(r.mergedIntoMonthly).toBe(true);
    expect(r.notif.id).not.toBe(m.id);
    expect(r.acct.notifs.find((n) => n.id === m.id)!.status).toBe('SUPERSEDED');
    const again = f29(r.notif)!;
    expect(again).toBeDefined();
    expect(again.watchEntry!.std).toBe(0.03);
    expect(r.acct.watch![T]).toMatchObject({ lastListed: '2026-11-30', stdWeight: 0.03 });
    // 入金補的格子不含這檔（還不是持股），F29 自己那一行還在
    expect(r.notif.preview!.lines.filter((l) => l.ticker === T)).toEqual([{ ticker: T, bucket: 'own', shares: again.choices[0].lines[0].shares, reason: '候補進場' }]);
  });

  it('月報暫停（有清單決定了還沒填快照）：輸入留著，填完快照重算時 F29 照列', () => {
    const sim = world({ flat: true });
    toMonth(sim);
    const c = cond(sim, 'close', Math.ceil(priceOf(sim.pre, T)) + 5);
    const dep = deposit(sim.acct, sim.pre, 2000);
    sim.acct = respond(dep.acct, sim.pre, dep.notif.id, { mode: 'DO' });
    const paused = monthly(sim, [c]);
    expect(paused.title).toContain('月報暫停');
    expect(paused.monthly!.input.watchEntries).toHaveLength(1);
    expect(sim.acct.watch![T].lastListed).toBeNull();
    fill(sim);
    const r = resumeMonthly(sim.acct, sim.pre);
    expect(f29(r.notif!)).toBeDefined();
  });
});

// ---------------------------------------------------------------- 5. 沒提的原因

describe('T85 乙 ⑤：進場條件成立但這個月不提——原因寫在候補那一塊，留到下個月再看', () => {
  const base = () => {
    const sim = world({ flat: true });
    toMonth(sim);
    return { sim, c: cond(sim, 'close', Math.ceil(priceOf(sim.pre, T)) + 5) };
  };
  const blockedText = (sim: Sim) => sim.acct.watch![T].blocked?.text ?? null;

  it('硬傷、申報清單抓不到、財報類出場條件已經成立：不列；候補那一塊寫原因；lastListed 不動（不算列過）', () => {
    for (const [extra, why] of [
      [{ hard: '延遲申報季報，NT 10-Q 2026-11-12' }, '規則偵測到硬傷（延遲申報季報，NT 10-Q 2026-11-12）'],
      [{ noFilings: 'EDGAR 503' }, '申報清單抓不到（EDGAR 503），沒辦法檢查有沒有硬傷'],
      [{ exitMet: '毛利率連兩季低於 50%' }, '你定的財報類出場條件已經成立（毛利率連兩季低於 50%）'],
    ] as const) {
      const { sim, c } = base();
      const m = monthly(sim, [c], extra);
      expect(f29(m)).toBeUndefined();
      expect(blockedText(sim)).toBe(`進場條件「${c.text}」成立，但${why}，這個月不提進場；下個月月報再看一次。`);
      expect(sim.acct.watch![T]).toMatchObject({ lastListed: null, blocked: { date: '2026-11-30' } });
      // 網站那一列寫出來
      expect(holdingDetail(ready(sim, { watchConds: { [T]: [c] } }), T).watch).toMatchObject({ blocked: blockedText(sim), lastListed: null });
    }
  });

  it('每 90 天最多列一次：選了不做、照做沒買都算列過；滿 90 天再列', () => {
    const { sim, c } = base();
    sim.acct.watch![T].lastListed = '2026-10-01';
    expect(f29(monthly(sim, [c]))).toBeUndefined();
    expect(blockedText(sim)).toBe(`進場條件「${c.text}」成立，但 10/1 的月報已經列過這檔的進場（每 90 天最多列一次，12/30 之後才會再列），這個月不提進場；下個月月報再看一次。`);
    const { sim: s2, c: c2 } = base();
    s2.acct.watch![T].lastListed = '2026-08-31';
    expect(f29(monthly(s2, [c2]))).toBeDefined();
    expect(s2.acct.watch![T].blocked).toBeUndefined();
  });

  it('買進前的程式檢查：30 天內前提被判不成立（上一次持有結案時記的）、跨桶上限砍到 0；上限砍掉一部分時照買、寫明', () => {
    const { sim, c } = base();
    sim.acct.ownClosed = { [T]: { fileId: `${T}@2026-09-01`, reason: 'EXIT_AI', date: '2026-11-12', brokenAt: '2026-11-10' } };
    expect(f29(monthly(sim, [c]))).toBeUndefined();
    expect(blockedText(sim)).toContain('但 11/10 有前提被判不成立，這個月不提進場');
    // 滿 30 天之後照列
    const { sim: s2, c: c2 } = base();
    s2.acct.ownClosed = { [T]: { fileId: `${T}@2026-09-01`, reason: 'EXIT_AI', date: '2026-10-30', brokenAt: '2026-10-28' } };
    expect(f29(monthly(s2, [c2]))).toBeDefined();
    // 動能已經持有這檔、占總資產超過 10% → 砍到 0，不提
    const { sim: s3, c: c3 } = base();
    const px = priceOf(s3.pre, T);
    s3.acct.lots.mom[T] = Math.ceil((0.11 * totalValue(s3.acct, s3.pre)) / px);
    expect(f29(monthly(s3, [c3]))).toBeUndefined();
    expect(blockedText(s3)).toContain('再買會超過 10% 的上限');
    // 動能持有 9% 多：只能再買到 10%，砍掉一部分
    const { sim: s4, c: c4 } = base();
    s4.acct.lots.mom[T] = Math.floor((0.095 * totalValue(s4.acct, s4.pre)) / px);
    const it = f29(monthly(s4, [c4]))!;
    const full = Math.floor((0.04 * 0.5 * totalValue(s4.acct, s4.pre)) / px);
    expect(it.choices[0].lines[0].shares).toBeLessThan(full);
    expect(it.note).toContain(`只買 ${it.choices[0].lines[0].shares} 股（原本 ${full} 股）`);
  });

  it('自選的比例是 0%、訊號日沒有收盤價、月中成立過但月報那天不成立：都不列；價格條件不算用掉', () => {
    const { sim, c } = base();
    sim.acct.cfg = { ...sim.acct.cfg, ratio: { own: 0, strat: 0.3, core: 0.7 } };
    expect(f29(monthly(sim, [c]))).toBeUndefined();
    expect(blockedText(sim)).toContain('自選的比例是 0%');
    // 月報那天收盤沒有低於條件 → 根本不進輸入，也沒有「沒提的原因」
    const { sim: s2 } = base();
    const far = cond(s2, 'close', 1);
    expect(priceEntriesAt(s2.acct, s2.pre, { [T]: [far] })).toEqual([]);
    expect(f29(monthly(s2, [far]))).toBeUndefined();
    expect(s2.acct.watch![T].blocked).toBeUndefined();
    // 已經成立過、撤下的、別份論點檔的不看
    expect(priceEntriesAt(s2.acct, s2.pre, { [T]: [{ ...cond(s2, 'close', 1e5), status: 'MET' }, { ...cond(s2, 'close', 1e5), status: 'RETIRED' }, { ...cond(s2, 'close', 1e5), fileId: `${T}@2020-01-01` }] })).toEqual([]);
  });

  it('自選桶合計已經超過預算：照列，項目多一句（不擋）', () => {
    const { sim, c } = base();
    sim.acct.cfg = { ...sim.acct.cfg, ratio: { own: 0.05, strat: 0.3, core: 0.65 } };
    const it = f29(monthly(sim, [c]))!;
    expect(it.note).toMatch(/自選目前占 [\d.]+%（預算 5%）/);
  });
});

// ---------------------------------------------------------------- 6. 非價格的進場條件（月報這一端；寫入是丙段）

describe('T85 乙 ⑥：成立、等月報的非價格進場條件（watch[t].entry）', () => {
  const entry = { id: 77, text: 'Cloud 營業利益率連兩季高於 10%', setAt: '2026-11-21', why: '最近 2 季 11.2%、10.4%（10-Q 2026-11-24）', metOn: '2026-11-24', runIds: ['cond-1'] };

  it('月報讀 entry：列 F29（不是價格條件，不用再比收盤）；列了就清掉；同一份月報同一檔只列一項，其他成立的在說明裡帶過', () => {
    const sim = world({ flat: true });
    toMonth(sim);
    sim.acct.watch![T].entry = [entry];
    const c = cond(sim, 'close', Math.ceil(priceOf(sim.pre, T)) + 5);
    // 這個月的進場前檢查有跑（輸入裡有這一檔），價格條件也成立 → 價格條件在標題，另一條在說明
    const watchEntries: WatchEntryInput[] = [{ ticker: T, conds: priceEntriesAt(sim.acct, sim.pre, { [T]: [c] })[0].conds }];
    const r = monthlyReport(sim.acct, sim.pre, { order: ranksAt(sim.market, sim.d - 1), vetoed: ['APP'], month: sim.month, watchEntries });
    const its = r.notif.items.filter((i) => i.f === 'F29');
    expect(its).toHaveLength(1);
    expect(its[0].title).toContain(`進場條件「${c.text}」成立`);
    expect(its[0].note).toContain('另外成立的進場條件：「Cloud 營業利益率連兩季高於 10%」（一起算用掉）');
    expect(its[0].watchEntry!.conds).toEqual([{ id: 501, price: true }, { id: 77, price: false }]);
    expect(r.acct.watch![T].entry).toBeUndefined();
    // 只有 entry：標題寫它、理由是怎麼確認的
    const only = monthlyReport(sim.acct, sim.pre, { order: ranksAt(sim.market, sim.d - 1), vetoed: ['APP'], month: sim.month, watchEntries: [{ ticker: T, conds: [] }] });
    const it = only.notif.items.find((i) => i.f === 'F29')!;
    expect(it.title).toContain('你在 2026-11-21 定的進場條件「Cloud 營業利益率連兩季高於 10%」成立');
    expect(it.why).toContain('最近 2 季 11.2%、10.4%（10-Q 2026-11-24）');
    expect(it.choices[0].effects).toMatchObject([{ type: 'WATCH_ENTER', conds: [77] }]);
  });

  it('被擋下時留到下個月（進場條件是唯一的入口）；這個月的進場前檢查沒有跑成也不列；成立超過 100 天還沒列 → 丟掉、寫明', () => {
    const sim = world({ flat: true });
    toMonth(sim);
    sim.acct.watch![T].entry = [entry];
    const none = monthlyReport(sim.acct, sim.pre, { order: ranksAt(sim.market, sim.d - 1), vetoed: ['APP'], month: sim.month });
    expect(none.notif.items.some((i) => i.f === 'F29')).toBe(false);
    expect(none.acct.watch![T].entry).toEqual([entry]);
    expect(none.acct.watch![T].blocked!.text).toContain('這個月的進場前檢查（申報、財報類出場條件）沒有跑成');
    const hard = monthlyReport(sim.acct, sim.pre, { order: ranksAt(sim.market, sim.d - 1), vetoed: ['APP'], month: sim.month, watchEntries: [{ ticker: T, conds: [], hard: '會計師辭任，8-K 2026-11-20' }] });
    expect(hard.acct.watch![T].entry).toEqual([entry]);
    expect(hard.acct.watch![T].blocked!.text).toContain('規則偵測到硬傷（會計師辭任，8-K 2026-11-20）');
    // 網站：等月報的那一條與沒提的原因
    const row = holdingDetail({ ...ready(sim), acct: hard.acct }, T).watch!;
    // T85 丙段：每一條多帶列編號、是不是價格條件、能不能在這裡撤下（等月報的不能）
    expect(row.entries).toEqual([{ id: entry.id, text: entry.text, state: '已成立（11/24），等下一份月報', price: false, retire: false }]);
    expect(row.blocked).toContain('規則偵測到硬傷');
    // 超過 100 天
    const old = structuredClone(sim.acct);
    old.watch![T].entry = [{ ...entry, metOn: '2026-08-01' }];
    const exp = monthlyReport(old, sim.pre, { order: ranksAt(sim.market, sim.d - 1), vetoed: ['APP'], month: sim.month, watchEntries: [{ ticker: T, conds: [] }] });
    expect(exp.notif.items.some((i) => i.f === 'F29')).toBe(false);
    expect(exp.acct.watch![T].entry).toBeUndefined();
    expect(exp.acct.watch![T].blocked!.text).toBe('進場條件「Cloud 營業利益率連兩季高於 10%」8/1 成立，超過 100 天都沒能列進月報，已經丟掉；要再用就重新定一條。');
  });

  it('寫入的接口（丙段呼叫）：notifyOwnCondition 對 ENTRY 分流成記進 watch[t].entry，不發通知；已經不是候補的略過；同一條不重複記', () => {
    const sim = world({ flat: true });
    const c = { id: 77, ticker: T, text: entry.text, action: 'ENTRY', acceptedAt: '2026-11-21T03:00:00Z', createdAt: '2026-11-21T03:00:00Z', origin: 'AI_DRAFT_ACCEPTED', direction: 'UP', tierIfMet: null, premiseId: null } as unknown as FileCondition;
    const ctx = { acct: sim.acct, view: sim.pre, session: '2026-11-24', log: [] as string[], stmts: [] } as unknown as ApplyCtx;
    const n0 = sim.acct.notifs.length;
    notifyOwnCondition(ctx, c, entry.why, ['cond-1'], `${T} 進場條件成立`);
    notifyOwnCondition(ctx, c, entry.why, ['cond-1'], `${T} 進場條件成立`);
    expect(ctx.acct.watch![T].entry).toEqual([entry]);
    expect(ctx.acct.notifs.length).toBe(n0);
    expect(ctx.log.join('\n')).toContain('等下一份月報（F29），不發當天通知');
    const gone = { ...ctx, acct: removeWatch(sim.acct, sim.pre, T), log: [] as string[] } as unknown as ApplyCtx;
    notifyOwnCondition(gone, c, entry.why, [], `${T} 進場條件成立`);
    expect(gone.log.join('\n')).toContain('已經不在候補名單，不記');
  });
});

// ---------------------------------------------------------------- 7. 接上資料庫與每日流程（真實模式）

function fetcherOf(w: World, sec: { forms: string[] }): Fetcher {
  const base = fakeFetcher(w);
  return async (url, init) => {
    if (url === LINE_PUSH_URL) return Response.json({});
    if (url.includes('company_tickers.json')) return Response.json({ 0: { cik_str: 2488, ticker: 'AMD' } });
    if (/data\.sec\.gov\/submissions\/CIK\d+\.json/.test(url)) {
      const n = sec.forms.length;
      return Response.json({ cik: '2488', name: 'ADVANCED MICRO DEVICES INC', tickers: ['AMD'], filings: { recent: { accessionNumber: sec.forms.map((_, k) => `0000002488-26-00000${k}`), form: sec.forms, items: Array(n).fill(''), acceptanceDateTime: Array(n).fill('2026-11-12T21:00:00.000Z'), filingDate: Array(n).fill('2026-11-12'), primaryDocument: Array(n).fill('a.htm') } } });
    }
    if (/companyfacts\/CIK\d+\.json/.test(url)) return Response.json({ cik: 2488, facts: {} });
    if (url.startsWith('https://www.nasdaq.com/feed/rssoutbound') || url.startsWith('https://feeds.finance.yahoo.com/rss/2.0/headline')) return new Response('<rss><channel></channel></rss>');
    return base(url, init);
  };
}

interface Ctx {
  db: D1Database;
  env: Env;
  w: World;
  sec: { forms: string[] };
  fetcher: Fetcher;
  api: <X = Record<string, unknown>>(method: 'GET' | 'POST', path: string, body?: unknown, at?: string) => Promise<{ status: number; body: X }>;
}
const acctOf = async (db: D1Database): Promise<Account> => (await loadAccount(db))!.acct;
const condRows = async (db: D1Database) => (await db.prepare("SELECT id, text, status, action, kind, note, met_basis FROM own_conditions WHERE ticker = 'AMD' ORDER BY id").all<{ id: number; text: string; status: string; action: string; kind: string; note: string | null; met_basis: string | null }>()).results;
const logKinds = async (db: D1Database) => (await db.prepare("SELECT kind FROM own_thesis_log WHERE ticker = 'AMD' ORDER BY id").all<{ kind: string }>()).results.map((r) => r.kind);

/** 2026-11-19 建立帳戶（NVDA 是自選）；11-20 早上把 AMD 加進候補（打算放 4%）。AMD 從 11-24 起跌三成。 */
async function withWorld(fn: (c: Ctx) => Promise<void>) {
  const d = await freshDb();
  try {
    const db = d.db;
    const w = newWorld('2026-11-19');
    const sec = { forms: [] as string[] };
    const env: Env = { DB: db, ADMIN_TOKEN: 't', AI_TASK_SECRET: 's', EDGAR_USER_AGENT: 'test bot test@example.com', SITE_URL: 'https://bot.example', LINE_CHANNEL_TOKEN: 'lt', LINE_USER_ID: 'U1', DEV_NO_AUTH: '1' } as Env;
    const fetcher = fetcherOf(w, sec);
    const api: Ctx['api'] = async (method, path, body, at = '2026-11-20T02:00:00Z') => {
      const r = await handle(new Request(`https://bot.example/api/${path}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env, fetcher, new Date(at));
      return { status: r.status, body: (await r.json()) as never };
    };
    await runFlow(env, fetcher, { now: cronTime('2026-11-19'), attempt: 'FIRST' });
    const { buildMarketView } = await import('../src/data/marketView');
    const { loadSeries } = await import('../src/data/store');
    const { createAccount } = await import('../src/engine');
    const { view } = buildMarketView(await loadSeries(db, ['VOO', 'SGOV', 'NVDA']), '2026-11-19', 'VOO');
    const acct = createAccount({ paper: true, cash: 5000, core: { VOO: Math.floor(112_000 / view.close.VOO[view.i]), SGOV: Math.floor(23_000 / view.close.SGOV[view.i]) }, own: { NVDA: { shares: Math.floor(10_000 / view.close.NVDA[view.i]), stdWeight: 0.07 } } }, view);
    await saveAccount(db, acct, null, '建立帳戶', new Date('2026-11-19T12:00:00Z'));
    expect((await api('POST', 'ops/watch-add', { ticker: 'AMD', note: '等跌深', stdWeight: 0.04 })).status).toBe(200);
    await fn({ db, env, w, sec, fetcher, api });
  } finally {
    await d.dispose();
  }
}
/** 每日流程一路跑到某一天（AMD 的暴跌從 11-24 起）。 */
async function flowTo(c: Ctx, dates: string[]) {
  let last;
  for (const day of dates) {
    c.w.dataDate = day;
    last = await runFlow(c.env, c.fetcher, { now: cronTime(day), attempt: 'FIRST' });
    expect(last.status).toBe('DONE');
  }
  return last!;
}
const NOV = ['2026-11-20', '2026-11-23', '2026-11-24', '2026-11-25', '2026-11-27', '2026-11-30'];

describe('T85 乙 ⑦：網站與每日流程（真實模式）——存價格條件、月報列 F29、快照轉持股、復原、補寫條件', () => {
  it('ops/watch-price：結構化欄位、整組取代、最多 2 條；進場條件另算，持股那一套（8 條、整組取代、監測）看不到它', async () => {
    await withWorld(async (c) => {
      expect((await c.api('POST', 'ops/watch-price', { ticker: 'AMD', conds: [{ type: 'drawdown', value: 25 }, { type: 'close', value: '$150' }] })).status).toBe(200);
      let rows = await condRows(c.db);
      expect(rows.map((r) => [r.text, r.status, r.action, r.kind])).toEqual([['比 52 週高點低 25% 以上', 'ACTIVE', 'ENTRY', 'PRICE'], ['收盤低於 $150', 'ACTIVE', 'ENTRY', 'PRICE']]);
      const acct = await acctOf(c.db);
      // 進場條件不在 fileConditions（持股的監測、證據包、8 條上限、整組取代都走它）；另外用 entryConditions 讀
      expect(await fileConditions(c.db, acct, 'AMD')).toEqual([]);
      expect(await loadConditions(c.db, 'AMD')).toEqual([]);
      expect((await entryConditions(c.db, acct, 'AMD')).map((x) => [x.action, x.origin, x.check.asOf, !!x.acceptedAt])).toEqual([['ENTRY', 'USER', '2026-11-19', true], ['ENTRY', 'USER', '2026-11-19', true]]);
      // T85 丙段（§4.5 第 20 點）：conditionOp 讀得到進場條件了（撤下單條非價格的）；價格條件照樣不能在這裡改（候補那一塊整組改）
      await expect(conditionOp(c.db, acct, 'AMD', rows[0].id, 'action', 'EXIT', '2026-11-19', new Date('2026-11-20T02:00:00Z'))).rejects.toThrow('價格條件在候補那一塊改');
      // 帳戶頁那一列：條件與現在的狀態、表單預先填上
      const st = (await c.api<StateView>('GET', 'state')).body;
      const row = st.account!.watch.find((x) => x.ticker === 'AMD')!;
      expect(row.entries.map((e) => e.text)).toEqual(['比 52 週高點低 25% 以上', '收盤低於 $150']);
      expect(row.entries[0].state).toMatch(/^現在 (在 52 週高點|-[\d.]+%)，還沒到$/);
      expect(row.priceConds).toEqual([{ type: 'drawdown', value: 25 }, { type: 'close', value: 150 }]);
      expect(row.priceMax).toBe(2);
      // 整組取代：舊的撤下
      expect((await c.api('POST', 'ops/watch-price', { ticker: 'AMD', conds: [{ type: 'drawdown', value: 20 }] })).status).toBe(200);
      rows = await condRows(c.db);
      expect(rows.map((r) => [r.text, r.status])).toEqual([['比 52 週高點低 25% 以上', 'RETIRED'], ['收盤低於 $150', 'RETIRED'], ['比 52 週高點低 20% 以上', 'ACTIVE']]);
      expect(((await c.api<HoldingDetail>('GET', 'holding/AMD')).body.watch!.entries).map((e) => e.text)).toEqual(['比 52 週高點低 20% 以上']);
      // 擋下的
      for (const [body, msg] of [
        [{ ticker: 'AMD', conds: [{ type: 'drawdown', value: 5 }, { type: 'close', value: 9 }, { type: 'close', value: 8 }] }, '價格條件最多 2 條'],
        [{ ticker: 'AMD', conds: [{ type: 'above', value: 5 }] }, '價格條件只有兩種'],
        [{ ticker: 'AMD', conds: [{ type: 'drawdown', value: 120 }] }, '1～90'],
        [{ ticker: 'AMD', conds: [{ type: 'close', value: 100 }, { type: 'close', value: 100 }] }, '兩條價格條件一樣'],
        [{ ticker: 'NVDA', conds: [{ type: 'close', value: 100 }] }, 'NVDA 已經是持股'],
        [{ ticker: 'MSFT', conds: [{ type: 'close', value: 100 }] }, 'MSFT 不在候補名單裡'],
      ] as const) {
        const r = await c.api<{ error: string }>('POST', 'ops/watch-price', body);
        expect(r.status).toBe(422);
        expect(r.body.error).toContain(msg);
      }
      // 清掉
      expect((await c.api('POST', 'ops/watch-price', { ticker: 'AMD', conds: [] })).status).toBe(200);
      expect((await condRows(c.db)).every((r) => r.status === 'RETIRED')).toBe(true);
      expect(await logKinds(c.db)).toEqual(['OPEN', 'CONDITION', 'CONDITION', 'CONDITION']);
    });
  });

  it('整條路（真實模式）：月底流程列 F29、條件這一刻才標成立 → 照做 → 快照轉持股、寫 ENTERED → 復原快照：帳戶和條件一致 → 再填 → 下一次流程補寫條件', async () => {
    await withWorld(async (c) => {
      expect((await c.api('POST', 'ops/watch-price', { ticker: 'AMD', conds: [{ type: 'drawdown', value: 25 }, { type: 'close', value: 1 }] })).status).toBe(200);
      c.w.shock.AMD = { from: '2026-11-24', factor: 0.7 };
      // 月中成立：只顯示，不改狀態
      await flowTo(c, NOV.slice(0, 4));
      const mid = (await c.api<StateView>('GET', 'state', undefined, '2026-11-26T02:00:00Z')).body.account!.watch[0];
      expect(mid.entries[0].state).toMatch(/^現在 -(2[5-9]|3\d)\.\d%，條件成立中（月報那天仍然成立才會列進月報）$/);
      expect((await condRows(c.db)).map((r) => r.status)).toEqual(['ACTIVE', 'ACTIVE']);
      expect((await acctOf(c.db)).notifs.some((n) => n.items.some((i) => i.f === 'F29'))).toBe(false);
      // 月底（11-30 是 11 月最後一個交易日）：月報列 F29
      const res = await flowTo(c, NOV.slice(4));
      expect(res.monthly).not.toBeNull();
      let acct = await acctOf(c.db);
      const m = acct.notifs.find((n) => n.id === res.monthly)!;
      const it = f29(m)!;
      expect(it).toBeDefined();
      expect(it.title).toContain('你在 2026-11-20 定的進場條件「比 52 週高點低 25% 以上」成立');
      expect(m.monthly!.input.watchEntries).toMatchObject([{ ticker: 'AMD', hard: null }]);
      const want = it.choices[0].lines[0].shares;
      let rows = await condRows(c.db);
      expect(rows.map((r) => [r.status, r.met_basis])).toEqual([['MET', 'PRICE'], ['ACTIVE', null]]);
      expect(rows[0].note).toBe('2026-11-30 收盤仍然成立，列進2026-12 月報');
      // 網站：通知頁那一項、帳戶頁那一列
      const nv = (await c.api<NotifView>('GET', `notif/${m.id}`, undefined, '2026-12-01T02:00:00Z')).body;
      expect(nv.items.find((x) => x.key === it.key)).toMatchObject({ label: '候補進場', entryInfo: expect.stringContaining('還沒有論點草稿') });
      const row = (await c.api<StateView>('GET', 'state', undefined, '2026-12-01T02:00:00Z')).body.account!.watch[0];
      expect(row.lastListed).toBe('2026-11-30');
      expect(row.entries[0].state).toBe('已成立（11/30）：一次性的，要再等就重新定條件');
      // 照做、填快照（自選桶填 AMD 的股數）
      expect((await c.api('POST', `notif/${m.id}/respond`, { mode: 'DO' }, '2026-12-01T02:00:00Z')).status).toBe(200);
      acct = await acctOf(c.db);
      const comp = acct.notifs.find((n) => n.id === m.id)!.composed!;
      const lots = { own: { ...acct.lots.own }, mom: { ...acct.lots.mom }, core: { ...acct.lots.core } };
      let cash = acct.cash;
      const { buildMarketView } = await import('../src/data/marketView');
      const { loadSeries } = await import('../src/data/store');
      const tickers = [...new Set(comp.lines.map((l) => l.ticker))];
      const { view } = buildMarketView(await loadSeries(c.db, ['VOO', 'SGOV', ...tickers]), '2026-11-30', 'VOO');
      for (const l of comp.lines) {
        const b = l.bucket as 'own' | 'mom' | 'core';
        lots[b][l.ticker] = (lots[b][l.ticker] ?? 0) + l.shares;
        cash -= l.shares * view.close[l.ticker][view.i];
      }
      expect(lots.own.AMD).toBe(want);
      const snapBody = { lots, cash: Math.round(cash * 100) / 100 };
      const s1 = await c.api<{ ok: boolean; entered: { ticker: string; via: string; state: string }[]; error?: string }>('POST', 'snapshot', snapBody, '2026-12-01T03:00:00Z');
      expect(s1.body.error).toBeUndefined();
      expect(s1.status).toBe(200);
      // 有論點嗎？沒有（只有預設前提）＋已經比高點低 20% 以上 → 從減半開始
      expect(s1.body.entered).toEqual([{ ticker: 'AMD', via: 'F29', state: 'HALF' }]);
      acct = await acctOf(c.db);
      expect(acct.watch?.AMD).toBeUndefined();
      expect(acct.own.AMD).toMatchObject({ origin: 'WATCH', fileId: 'AMD@2026-11-19', heldSince: '2026-11-30', entered: { via: 'F29', shares: want, conds: [rows[0].id] } });
      expect(await logKinds(c.db)).toEqual(['OPEN', 'CONDITION', 'ENTERED']);
      // 快照當下不改條件
      expect((await condRows(c.db)).map((r) => r.status)).toEqual(['MET', 'ACTIVE']);
      const hd = (await c.api<HoldingDetail>('GET', 'holding/AMD', undefined, '2026-12-01T03:10:00Z')).body;
      expect(hd.own!.entered).toContain('11/19 加入候補 → 11/30 進場（照月報的進場項目買的，從減半開始）');
      // 復原快照：候補回來、ENTERED 那一筆刪掉、條件沒被動過 → 帳戶和條件一致
      expect((await c.api('POST', 'snapshot/undo', {}, '2026-12-01T03:20:00Z')).status).toBe(200);
      acct = await acctOf(c.db);
      expect(acct.own.AMD).toBeUndefined();
      expect(acct.watch!.AMD).toMatchObject({ fileId: 'AMD@2026-11-19', lastListed: '2026-11-30' });
      expect(acct.notifs.find((n) => n.id === m.id)!.status).toBe('RESPONDED');
      expect(await logKinds(c.db)).toEqual(['OPEN', 'CONDITION']);
      expect((await condRows(c.db)).map((r) => r.status)).toEqual(['MET', 'ACTIVE']);
      // 再填一次 → 下一次每日流程補寫：沒列的那一條撤下（已進場），帳戶記 synced
      expect((await c.api('POST', 'snapshot', snapBody, '2026-12-01T03:30:00Z')).status).toBe(200);
      await flowTo(c, ['2026-12-01']);
      rows = await condRows(c.db);
      expect(rows.map((r) => [r.status, r.note])).toEqual([['MET', '2026-11-30 收盤仍然成立，列進2026-12 月報'], ['RETIRED', '2026-11-30 已進場，這條進場條件撤下']]);
      acct = await acctOf(c.db);
      expect(acct.own.AMD.entered).toMatchObject({ synced: true });
      expect(await logKinds(c.db)).toEqual(['OPEN', 'CONDITION', 'ENTERED', 'CONDITION']);
      // 已經是持股：每日的價格、慢規則照持股的方式（必要清單）
      expect(acct.own.AMD.slow.state).toBe('HALF');
    });
  });

  it('自己先買（真實模式）：快照的自選桶填了候補的代號 → 轉持股、標準、持股頁預選先買一半；下一次流程把進場條件撤下（你自己先買了）', async () => {
    await withWorld(async (c) => {
      expect((await c.api('POST', 'ops/watch-price', { ticker: 'AMD', conds: [{ type: 'drawdown', value: 25 }] })).status).toBe(200);
      const acct0 = await acctOf(c.db);
      const { buildMarketView } = await import('../src/data/marketView');
      const { loadSeries } = await import('../src/data/store');
      const { view } = buildMarketView(await loadSeries(c.db, ['VOO', 'SGOV', 'AMD']), '2026-11-19', 'VOO');
      const lots = { own: { ...acct0.lots.own, AMD: 5 }, mom: {}, core: { ...acct0.lots.core } };
      const s = await c.api<{ entered: unknown[]; newOwn: string[] }>('POST', 'snapshot', { lots, cash: Math.round((acct0.cash - 5 * view.close.AMD[view.i]) * 100) / 100 });
      expect(s.status).toBe(200);
      expect(s.body.entered).toEqual([{ ticker: 'AMD', via: 'SELF', state: 'STD' }]);
      const acct = await acctOf(c.db);
      expect(acct.own.AMD).toMatchObject({ origin: 'WATCH', fileId: 'AMD@2026-11-19', buildAsk: true, buyNote: { text: '等跌深' } });
      expect(acct.rule.own.AMD).toEqual({ applied: 'STD', stdWeight: 0.04 });
      expect(await logKinds(c.db)).toEqual(['OPEN', 'CONDITION', 'ENTERED']);
      const hd = (await c.api<HoldingDetail>('GET', 'holding/AMD')).body;
      expect(hd.own).toMatchObject({ askBuild: true, askBuildHalf: true });
      expect(hd.watch).toBeNull();
      // 持股頁存標準比重、選先買一半
      expect((await c.api('POST', 'ops/std-weight', { ticker: 'AMD', stdWeight: 0.04, build: true })).status).toBe(200);
      expect((await acctOf(c.db)).own.AMD).toMatchObject({ build: { since: '2026-11-19' } });
      await flowTo(c, ['2026-11-20']);
      expect((await condRows(c.db)).map((r) => [r.status, r.note])).toEqual([['RETIRED', '2026-11-19 你自己先買了，這條進場條件撤下']]);
    });
  });

  it('硬傷與申報清單抓不到（真實模式）：不列、條件不標成立、候補那一塊寫原因；下個月沒有硬傷了就列', async () => {
    await withWorld(async (c) => {
      expect((await c.api('POST', 'ops/watch-price', { ticker: 'AMD', conds: [{ type: 'drawdown', value: 25 }] })).status).toBe(200);
      c.w.shock.AMD = { from: '2026-11-24', factor: 0.7 };
      c.sec.forms = ['NT 10-Q'];
      const res = await flowTo(c, NOV);
      const acct = await acctOf(c.db);
      const m = acct.notifs.find((n) => n.id === res.monthly)!;
      expect(f29(m)).toBeUndefined();
      expect(m.monthly!.input.watchEntries).toMatchObject([{ ticker: 'AMD', hard: '延遲申報季報，NT 10-Q 2026-11-12' }]);
      expect(acct.watch!.AMD.blocked!.text).toBe('進場條件「比 52 週高點低 25% 以上」成立，但規則偵測到硬傷（延遲申報季報，NT 10-Q 2026-11-12），這個月不提進場；下個月月報再看一次。');
      expect(acct.watch!.AMD.lastListed).toBeNull();
      expect((await condRows(c.db)).map((r) => r.status)).toEqual(['ACTIVE']);
      const row = (await c.api<StateView>('GET', 'state', undefined, '2026-12-01T02:00:00Z')).body.account!.watch[0];
      expect(row.blocked).toContain('規則偵測到硬傷');
      expect(row.entries[0].state).toContain('條件成立中');
    });
  });

  it('listedPriceStmts：只標價格條件、只標還在監測的（重算月報時同一條再經過不重寫）', async () => {
    const d = await freshDb();
    try {
      const n = { id: 3, date: '2026-11-30', title: '2026-12 月報', items: [{ kind: 'WATCH_ENTRY', watchEntry: { conds: [{ id: 1, price: true }, { id: 2, price: false }] } }, { kind: 'WATCH_ENTRY', cancelled: true, watchEntry: { conds: [{ id: 9, price: true }] } }, { kind: 'OWN_ADD' }] } as unknown as Notif;
      expect(listedPriceStmts(d.db, [n], '2026-11-30T23:40:00Z')).toHaveLength(1);
    } finally {
      await d.dispose();
    }
  });
});

// ---------------------------------------------------------------- 8. 示範模式

describe('T85 乙 ⑧：示範模式也走得完（價格條件存在示範自己的那一格，不碰真實的 own_conditions）', () => {
  it('加候補 → 價格條件 → 走到下一份月報：列 F29、條件標成立；重新開始情境時清掉', async () => {
    const d = await freshDb();
    try {
      const env = { DB: d.db, ADMIN_TOKEN: 't', SITE_URL: 'https://bot.example', DEV_NO_AUTH: '1' } as unknown as Env;
      const call = async <X = Record<string, unknown>>(method: 'GET' | 'POST', path: string, body?: unknown) => {
        const r = await handle(new Request(`https://bot.example/demo/api/${path}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env, (async () => new Response('nf', { status: 404 })) as never, new Date('2026-11-23T03:00:00Z'));
        return { status: r.status, body: (await r.json()) as X };
      };
      expect((await call('POST', 'reset', { scenario: 's1' })).status).toBe(200);
      expect((await call('POST', 'ops/watch-add', { ticker: 'GOOGL', stdWeight: 0.04 })).status).toBe(200);
      const px = (await call<StateView>('GET', 'state')).body.account!.watch[0].price!;
      expect((await call('POST', 'ops/watch-price', { ticker: 'GOOGL', conds: [{ type: 'close', value: Math.ceil(px * 1.5) }] })).status).toBe(200);
      const row = (await call<StateView>('GET', 'state')).body.account!.watch[0];
      expect(row.entries).toHaveLength(1);
      expect(row.entries[0].state).toContain('條件成立中');
      expect(row.priceConds).toEqual([{ type: 'close', value: Math.ceil(px * 1.5) }]);
      expect((await d.db.prepare('SELECT COUNT(*) AS n FROM own_conditions').first<{ n: number }>())!.n).toBe(0);
      const adv = await call<{ created: number[] }>('POST', 'advance', { mode: 'month' });
      expect(adv.status).toBe(200);
      const st = (await call<StateView>('GET', 'state')).body;
      const month = st.todo.find((t) => adv.body.created.includes(t.id) && /月報/.test(t.title))!;
      const nv = (await call<NotifView>('GET', `notif/${month.id}`)).body;
      const it = nv.items.find((x) => x.label === '候補進場')!;
      expect(it).toBeDefined();
      expect(it.headline).toMatch(/^買 GOOGL \d+ 股$/);
      expect(st.account!.watch[0].entries[0].state).toMatch(/^已成立/);
      expect(st.account!.watch[0].lastListed).not.toBeNull();
      expect((await call('POST', 'reset', { scenario: 's1' })).status).toBe(200);
      expect((await d.db.prepare("SELECT COUNT(*) AS n FROM flow_state WHERE key = 'demo:watch-conds'").first<{ n: number }>())!.n).toBe(0);
    } finally {
      await d.dispose();
    }
  });
});
