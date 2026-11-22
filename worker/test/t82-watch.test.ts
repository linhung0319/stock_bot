// T82（階段十二）：自選的賣——跌幅審查與審查後持有（WATCH）。設計：docs/design/allocation_redesign_2026-11-22.md 第 3 章、第 5 章、第 9 章 D2、D3。
// 完成條件：
//   只有預設前提的股票走不到 WATCH（慢規則照舊）；stepSlowRule 不認得 WATCH、行為不變（重放的數字由 test/replay.test.ts 鎖住）
//   有論點的股票：-20% 只觸發審查、進 WATCH；-30%、-40%、-50% 各再審一次；站回均線回到標準（不下單、不通知）
//   效力表（D2）：只有 3 票判同一條前提不成立才減半；前提都沒有被判不成立、票數不一致、沒跑完都是不動
//   沒跑完：09:30 重派一次、隔天再派，最多 3 個交易日，之後 REVIEW_FAILED 與「要看的事」
//   通知：預設不動的那一種 2 個交易日自動結案（AUTO_DEFAULT）、不提醒、結案前可改選減半並當場給清單；LINE 一行；影子紀錄三條線
//   「這次不做」之後留在 WATCH；快照顯示自己賣了一半 → HALF 加說明
//   own_drop_v6 是新檔、v5 留著；run.md 不用改
// 結論的四種條件（純函式）與原本的整條流程（推播時間、先回覆才回來的結果）在 test/t31b-drop.test.ts。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { OWN_DROP_PROMPT } from '../src/ai/drops';
import { getRun } from '../src/app/aiRuns';
import { dropFailText, dropRetry } from '../src/app/dropAi';
import { DROP_LINE, holdNoticeLine, notifText } from '../src/app/line';
import { dropFollowUpText, dropWaiter, pushWaiting } from '../src/app/pushHold';
import type { SiteData } from '../src/app/site/backend';
import { accountView, historyView, holdingDetail, keptAsRule, notifView, stateView, watchNote } from '../src/app/site/views';
import { metaFile, ownAttention, ruleResponseLogs } from '../src/app/thesis';
import {
  AUTO_DEFAULT_NOTE,
  DROP_LADDER,
  SLOW,
  THESIS_DROP_WHY,
  applyDropResult,
  applySnapshot,
  dailyCheck,
  dropLadder,
  dropReviewOpen,
  halveShares,
  initialSlowState,
  isHoldNotice,
  liveShadow,
  missingReasons,
  monthlyReport,
  priceOf,
  recordAiTier,
  reopen,
  stepSlowRule,
  stepWatch,
  totalValue,
  type Account,
  type DropReview,
  type Item,
  type Notif,
} from '../src/engine';
import { EIGHTK, EXIT_QUOTE, P1, crash, dropRuns, f7, holdVotes, logRows, notices, postResult, pushRows, reduceNotif, withWorld } from './helpers/dropWorld';
import { makeMarket } from './helpers/market';
import { scenarios } from './helpers/scenarios';
import { Sim, type SimDrop } from './helpers/sim';

const item = (n: Notif, f: string, ticker?: string): Item => {
  const it = n.items.find((i) => i.f === f && (!ticker || i.ticker === ticker));
  if (!it) throw new Error(`通知 #${n.id} 沒有 ${f} ${ticker ?? ''}`);
  return it;
};
type Ready = SiteData & { acct: Account; view: NonNullable<SiteData['view']> };
const ready = (sim: Sim): Ready => ({ mode: 'demo', acct: sim.acct, view: sim.pre, axis: sim.market.days.slice(0, sim.d), rankOrder: [], rankSession: null, aiNotes: [], events: [], shadow: [], today: sim.date, warnings: [] });

// ================================================================ 純函式

describe('T82：DROP_LADDER、dropLadder、stepWatch（allocation_redesign §3.3）；stepSlowRule 不認得 WATCH', () => {
  it('幾級：-20% 第一次審，之後每多跌 10 個百分點一級；還沒到、算不出來是 -1', () => {
    expect([...DROP_LADDER]).toEqual([-0.2, -0.3, -0.4, -0.5]);
    expect(DROP_LADDER[0]).toBe(SLOW.drawdown);
    expect([-0.05, -0.199, -0.2, -0.25, -0.3, -0.399, -0.4, -0.5, -0.8].map(dropLadder)).toEqual([-1, -1, 0, 0, 1, 1, 2, 3, 3]);
    expect(dropLadder(NaN)).toBe(-1);
  });

  it('stepSlowRule 遇到 WATCH：不產生訊號、狀態不變，只更新連續站上均線天數與距上次切換的天數（行為沒有改，重放不受影響）', () => {
    const w = { state: 'WATCH' as const, aboveRun: 3, sinceSwitch: 7 };
    // 跌得再深、站回再久都不會自己切換
    expect(stepSlowRule(w, { drawdown: -0.45, above200: false })).toEqual({ next: { state: 'WATCH', aboveRun: 0, sinceSwitch: 8 }, signal: null });
    expect(stepSlowRule({ ...w, aboveRun: 30, sinceSwitch: 40 }, { drawdown: -0.01, above200: true })).toEqual({ next: { state: 'WATCH', aboveRun: 31, sinceSwitch: 41 }, signal: null });
    // 原本的兩個切換照舊
    expect(stepSlowRule(initialSlowState('STD'), { drawdown: -0.2, above200: false })).toMatchObject({ next: { state: 'HALF', sinceSwitch: 0 }, signal: 'REDUCE' });
    expect(stepSlowRule({ state: 'HALF', aboveRun: 9, sinceSwitch: 20 }, { drawdown: -0.1, above200: true })).toMatchObject({ next: { state: 'STD', sinceSwitch: 0 }, signal: 'READD' });
  });

  it('stepWatch：回到標準和減半的加回同一組條件（站上均線連續 10 天、距上次切換 ≥ 15 個交易日、跌幅已不到 20%）；再跌到更深的一級才再審，一天跌過兩級只審一次', () => {
    const st = (aboveRun: number, sinceSwitch: number) => ({ state: 'WATCH' as const, aboveRun, sinceSwitch });
    // 三個條件缺一個都不回
    expect(stepWatch(st(10, 15), 0, { drawdown: -0.1, above200: true })).toEqual({ next: { state: 'STD', aboveRun: 10, sinceSwitch: 0 }, level: 0, event: 'BACK' });
    expect(stepWatch(st(9, 15), 0, { drawdown: -0.1, above200: true }).event).toBeNull();
    expect(stepWatch(st(10, 14), 0, { drawdown: -0.1, above200: true }).event).toBeNull();
    expect(stepWatch(st(10, 15), 0, { drawdown: -0.2, above200: true }).event).toBeNull();
    // 同一級裡上下波動不再審；更深一級才審
    expect(stepWatch(st(0, 3), 0, { drawdown: -0.29, above200: false })).toMatchObject({ level: 0, event: null });
    expect(stepWatch(st(0, 3), 0, { drawdown: -0.3, above200: false })).toMatchObject({ level: 1, event: 'DEEPER', next: { state: 'WATCH' } });
    expect(stepWatch(st(0, 3), 1, { drawdown: -0.35, above200: false })).toMatchObject({ level: 1, event: null });
    // 一天從 -25% 跌到 -45%：只審一次，記最深的那一級
    expect(stepWatch(st(0, 3), 0, { drawdown: -0.45, above200: false })).toMatchObject({ level: 2, event: 'DEEPER' });
    // 最後一級之後不再因為跌幅審查
    expect(stepWatch(st(0, 3), 3, { drawdown: -0.7, above200: false })).toMatchObject({ level: 3, event: null });
  });

  it('dropRetry：同一個交易日最多 2 次（07:30、09:30），最多 3 個交易日；之後不再派', () => {
    const dr = (o: Partial<DropReview>): DropReview => ({ session: '2026-11-23', runId: 'r', status: 'NONE', cause: null, premiseId: null, told: false, thesis: true, ...o });
    expect(dropRetry(dr({ days: 1, lastTry: '2026-11-23', sameDay: 1 }), '2026-11-23')).toBe('RETRY'); // 09:30 重派一次
    expect(dropRetry(dr({ days: 1, lastTry: '2026-11-23', sameDay: 2 }), '2026-11-23')).toBe('WAIT'); // 今天的用完了
    expect(dropRetry(dr({ days: 1, lastTry: '2026-11-23', sameDay: 2 }), '2026-11-24')).toBe('RETRY'); // 隔天再派
    expect(dropRetry(dr({ days: 3, lastTry: '2026-11-25', sameDay: 1 }), '2026-11-25')).toBe('RETRY');
    expect(dropRetry(dr({ days: 3, lastTry: '2026-11-25', sameDay: 2 }), '2026-11-25')).toBe('DONE');
    expect(dropRetry(dr({ days: 3, lastTry: '2026-11-25', sameDay: 1 }), '2026-11-27')).toBe('DONE');
    expect(dropFailText('MU', { session: '2026-11-23', days: 3 })).toBe('MU 的跌幅審查（11-23 觸發）連續 3 個交易日沒有跑完，不再重派。這檔不動；之後財報後的審查與再跌一級時仍會檢查。');
    // 通知在這期間不自動結案
    expect(dropReviewOpen(dr({ status: 'PENDING' }))).toBe(true);
    expect(dropReviewOpen(dr({ status: 'NONE' }))).toBe(true);
    expect(dropReviewOpen(dr({ status: 'NONE', failed: true }))).toBe(false);
    expect(dropReviewOpen(dr({ status: 'CLEAR' }))).toBe(false);
    expect(dropReviewOpen(dr({ status: 'NONE', thesis: false }))).toBe(false); // 只有預設前提的：沒有結論就是照規則，不等
    expect(dropReviewOpen(null)).toBe(false);
  });
});

// ================================================================ 引擎：一檔一路往下跌再反彈

/**
 * NVDA 一路跌過 -20%、-30%、-40%，之後大漲站回均線。flat：跌到 -2x% 之後橫盤一個多月再漲回去（要等好幾天的測試用，不會中途又跌一級）。
 * big：占約 13%，而且「當天通知」的門檻調成 3%（一路跌下去市值會縮水，用預設的 5% 會在 -30% 那一級剛好掉到門檻下）；否則約 5%（變動不到門檻）。
 * 其他三檔自選平穩。drops：審查的結果（沒寫 = 沒有結果）。
 */
function ladder(o: { big?: boolean; flat?: boolean; drops?: Record<string, SimDrop>; defaultOnly?: boolean } = {}) {
  const path = o.flat
    ? [{ n: 8, ret: 0.02 }, { n: 4, ret: -0.235 }, { n: 28, ret: 0.0, vol: 0.15 }, { n: 70, ret: 0.9 }]
    : [{ n: 8, ret: 0.02 }, { n: 4, ret: -0.235 }, { n: 8, ret: -0.13 }, { n: 8, ret: -0.16 }, { n: 20, ret: 0.02 }, { n: 62, ret: 1.1 }];
  const market = makeMarket('2026-11-23', 110, { over: { NVDA: { r252: 0.55, path } } });
  const init = o.big ? scenarios.s7().init : scenarios.s1().init;
  const sim = new Sim(market, init, { drops: o.drops });
  if (o.big) sim.acct.cfg = { ...sim.acct.cfg, urgentFrac: 0.03 };
  if (o.defaultOnly) sim.acct.own.NVDA.premises = sim.acct.own.NVDA.premises.map((p) => ({ ...p, origin: 'SYSTEM_DEFAULT' as const }));
  return sim;
}
/** 分桶快照（網站用的那一種）：自選的 t 清單外多了 q 股（負的是自己賣），其他照帳本。 */
function selfTrade(sim: Sim, t: string, q: number) {
  const lots = { own: { ...sim.acct.lots.own }, mom: { ...sim.acct.lots.mom }, core: { ...sim.acct.lots.core } };
  lots.own[t] = (lots.own[t] ?? 0) + q;
  const shares: Record<string, number> = {};
  for (const b of [lots.own, lots.mom, lots.core]) for (const [k, v] of Object.entries(b)) shares[k] = (shares[k] ?? 0) + v;
  const px = (x: string) => sim.market.open[x][sim.d];
  const r = applySnapshot(sim.acct, sim.pre, { shares, lots, cash: sim.acct.cash - q * px(t) }, px);
  expect(r.error).toBeUndefined();
  sim.acct = r.acct;
  return r;
}
const nvdaNotifs = (sim: Sim) => sim.acct.notifs.filter((n) => n.items.some((i) => i.f === 'F7' && i.ticker === 'NVDA'));
/** 走到 NVDA 第 k 則 F7 通知出現（收盤後；sim.pre 是那一天）。 */
function untilReview(sim: Sim, k = 1): Notif {
  while (nvdaNotifs(sim).length < k && !sim.atEnd()) sim.day({ afterMonthly: (m) => sim.respond(m.id) });
  const n = nvdaNotifs(sim)[k - 1];
  if (!n) throw new Error(`NVDA 沒有第 ${k} 則 F7 通知`);
  return n;
}
const live = (sim: Sim, id: number) => sim.acct.notifs.find((n) => n.id === id)!;

describe('T82：只有預設前提的股票走不到 WATCH（allocation_redesign §3.1、§3.3）', () => {
  it('慢規則照舊：-20% 當天規則減半（預設照規則）、之後繼續跌沒有動作、站回均線加回；整段沒有一天是 WATCH，也沒有跌幅審查的項目', () => {
    const sim = ladder({ big: true, defaultOnly: true });
    const states = new Set<string>();
    const n = untilReview(sim);
    expect(n.title).toBe('NVDA 慢規則減半');
    const it7 = item(n, 'F7', 'NVDA');
    expect(it7.thesisDrop).toBeUndefined();
    expect(it7.choices.map((c) => [c.id, c.label])).toEqual([['RULE', '照規則'], ['SKIP', '這次不做']]);
    expect(it7).toMatchObject({ choice: 'RULE', reasonRequired: true });
    expect([sim.acct.own.NVDA.slow.state, sim.acct.rule.own.NVDA.applied, sim.acct.own.NVDA.watchLevel]).toEqual(['HALF', 'HALF', undefined]);
    sim.respond(n.id);
    while (!sim.atEnd()) {
      sim.day({ afterMonthly: (m) => sim.respond(m.id) });
      states.add(sim.acct.own.NVDA.slow.state);
      expect(sim.acct.own.NVDA.watchLevel).toBeUndefined();
    }
    expect([...states].sort()).toEqual(['HALF', 'STD']);
    // 跌到 -30%、-40% 都沒有新的減半或審查（K7：已經減半的繼續跌，沒有價格上的動作）；反彈後有加回
    const all = sim.acct.notifs.filter((x) => x.items.some((i) => i.ticker === 'NVDA' && i.kind === 'OWN_RULE'));
    expect(all.flatMap((x) => x.items.filter((i) => i.ticker === 'NVDA').map((i) => i.f))).toEqual(['F7', 'F8']);
    expect(sim.acct.notifs.some((x) => x.items.some((i) => !!i.thesisDrop))).toBe(false);
  });
});

describe('T82：有論點的股票——-20% 只觸發審查，進審查後持有；每多跌一級再審；站回均線回到標準（§3.2、§3.3）', () => {
  it('沒有結論時一路不動：-20%、-30%、-40% 各一則跌幅審查的通知（不分金額大小）；舊的那一則以新的為準；反彈後回到標準，不下單、不通知', () => {
    const sim = ladder(); // 約 5%：以前變動不到 5% 會等月報，現在審查的通知當天給
    const shares = sim.acct.lots.own.NVDA;
    const n1 = untilReview(sim);
    expect(n1).toMatchObject({ kind: 'URGENT', title: 'NVDA 跌幅審查', status: 'PENDING' });
    const it1 = item(n1, 'F7', 'NVDA');
    expect(it1.title).toMatch(/^NVDA：比 52 週高點低 2\d\.\d% → 跌幅審查$/);
    expect(it1.why).toBe(THESIS_DROP_WHY);
    expect(it1.thesisDrop).toEqual({ level: 0 });
    // 預設不動；另一個選項是減半（你自己想賣時用，不用理由）；規則的那條線記照舊的慢規則會賣幾股
    expect(it1.choices.map((c) => [c.id, c.label, c.lines.reduce((a, l) => a + l.shares, 0)])).toEqual([['SKIP', '不動', 0], ['RULE', '減半', -halveShares(shares)]]);
    expect(it1).toMatchObject({ choice: 'SKIP', ruleChoice: 'RULE' });
    expect([it1.reasonRequired, it1.aiLine, it1.drop, it1.note]).toEqual([undefined, undefined, undefined, undefined]);
    expect(n1.preview!.lines.filter((l) => l.ticker === 'NVDA')).toEqual([]);
    expect(isHoldNotice(n1)).toBe(true);
    expect(missingReasons(n1, { mode: 'DO' })).toEqual([]);
    expect(missingReasons(n1, { mode: 'SKIP' })).toEqual([]);
    // 狀態：審查後持有；目標還是標準比重；不等月報
    expect(sim.acct.own.NVDA).toMatchObject({ slow: { state: 'WATCH', sinceSwitch: 0 }, watchLevel: 0, pending: null });
    expect(sim.acct.rule.own.NVDA.applied).toBe('STD');
    expect(sim.acct.own.NVDA.reduceDd).toBeLessThanOrEqual(-0.2);

    // -30%：重新審查（第 2 級）
    const n2 = untilReview(sim, 2);
    expect(sim.acct.own.NVDA.watchLevel).toBe(1);
    expect(sim.acct.own.NVDA.reduceDd).toBeLessThanOrEqual(-0.3);
    const it2 = item(n2, 'F7', 'NVDA');
    expect(it2.thesisDrop).toEqual({ level: 1 });
    expect(it2.note).toBe('上一次審的是比高點低 20% 那一級；又跌到 30% 以上，重新審查');
    expect(it2.title).toMatch(/^NVDA：比 52 週高點低 3\d\.\d% → 跌幅審查$/);
    // 第一則早就自動結案了（下一個測試）；這裡看 -40% 出來時 -30% 那一則還沒結案的話會被新的取代
    const n3 = untilReview(sim, 3);
    expect(item(n3, 'F7', 'NVDA').thesisDrop).toEqual({ level: 2 });
    expect(sim.acct.own.NVDA.watchLevel).toBe(2);
    expect(nvdaNotifs(sim).map((n) => n.date)).toEqual([n1.date, n2.date, n3.date]);

    // 反彈：站回 200 日均線連續 10 天、距上次切換 ≥ 15 個交易日、跌幅不到 20% → 回到標準
    const before = sim.acct.notifs.length;
    const seen: Notif[] = [];
    while (!sim.atEnd()) sim.day({ afterMonthly: (m) => sim.respond(m.id), afterClose: (c) => seen.push(...c) });
    expect(sim.acct.own.NVDA.slow.state).toBe('STD');
    expect([sim.acct.own.NVDA.watchLevel, sim.acct.own.NVDA.dropReview, sim.acct.own.NVDA.pending]).toEqual([undefined, undefined, null]);
    expect(sim.log.some((l) => l.includes('NVDA：審查後持有 → 站回 200 日均線，回到標準（不下單、不通知）'))).toBe(true);
    expect(seen.some((n) => n.items.some((i) => i.ticker === 'NVDA') || n.title.includes('NVDA'))).toBe(false);
    expect(sim.acct.notifs.slice(before).some((n) => n.items.some((i) => i.ticker === 'NVDA' && i.kind === 'OWN_RULE'))).toBe(false);
    expect(sim.acct.lots.own.NVDA).toBe(shares); // 從頭到尾沒有賣
    // 第二次觸發和第一次無關：回到標準之後再跌 20% 會重新從第 1 級審（狀態機回到 STD，watchLevel 清掉）
    const again = dailyCheck({ ...sim.acct, own: { ...sim.acct.own, NVDA: { ...sim.acct.own.NVDA, slow: { ...sim.acct.own.NVDA.slow } } } }, sim.pre);
    expect(again.acct.own.NVDA.slow.state).toBe('STD');
  });

  it('又跌一級時上一則還沒回覆 → 那一項取消、整則標成被取代，以新的為準；已經在等月報的減半（前提不成立）不另外再審', () => {
    const sim = ladder({ big: true, drops: { NVDA: { status: 'BROKEN', premiseId: 'P1' } } });
    const n1 = untilReview(sim);
    expect(item(n1, 'F7', 'NVDA')).toMatchObject({ drop: 'BROKEN', choice: 'RULE' });
    // 一直不回，跌到 -30%
    const n2 = untilReview(sim, 2);
    const old = live(sim, n1.id);
    expect(old.status).toBe('SUPERSEDED');
    expect(old.items[0]).toMatchObject({ cancelled: true, note: '又跌到比高點低 30% 以上，重新審查；這一項以新的跌幅審查通知為準' });
    expect(item(n2, 'F7', 'NVDA')).toMatchObject({ thesisDrop: { level: 1 }, drop: 'BROKEN', choice: 'RULE' });
    expect(sim.acct.own.NVDA.dropReview).toMatchObject({ level: 1, status: 'BROKEN' });
    // 變動不到 5% 的：前提不成立 → 等月報；這期間又跌一級不另外審查
    const small = ladder({ drops: { NVDA: { status: 'BROKEN', premiseId: 'P1' } } });
    untilReview(small);
    expect(small.acct.own.NVDA.pending).toMatchObject({ action: 'REDUCE' });
    let deeper = false;
    while (small.acct.own.NVDA.pending && !small.atEnd() && !small.isFirstOfMonth()) {
      small.day();
      if ((small.acct.own.NVDA.watchLevel ?? 0) > 0) deeper = true;
    }
    if (deeper) {
      expect(nvdaNotifs(small)).toHaveLength(1);
      expect(small.log.some((l) => l.includes('上一次審查已經判前提不成立、減半在等月報，不另外審查'))).toBe(true);
    }
  });
});

describe('T82：預設不動的通知——不用回覆、不提醒、2 個交易日自動結案（AUTO_DEFAULT）；結案前可改選減半（§3.2）', () => {
  const clear: SimDrop = { status: 'CLEAR', runId: 'run-drop', extra: { attr: { stock: -0.22, market: -0.08, sector: -0.09, idio: -0.05 } } };

  it('前提都沒有被判不成立：那一行寫跌幅拆解（只是資訊）；2 個交易日後自動以不動結案，沒有提醒；影子紀錄三條線；審查的結果留著給持股頁', () => {
    const sim = ladder({ big: true, flat: true, drops: { NVDA: clear } });
    const n = untilReview(sim);
    const it7 = item(n, 'F7', 'NVDA');
    expect(it7.aiLine).toBe('論點檢查（3 票）：你的 1 條前提都沒有被判不成立。這次下跌：大盤 -8%、產業比大盤 -9%、個股自身 -5%');
    expect(it7).toMatchObject({ drop: 'CLEAR', choice: 'SKIP', runIds: ['run-drop'] });
    expect(isHoldNotice(n)).toBe(true);
    // T86 P2：不用回覆的通知不標「等你決定」、不算首頁的件數；另列在 fyi（不用回覆）
    const st0 = stateView(ready(sim));
    expect(st0.todo.some((t) => t.id === n.id)).toBe(false);
    expect(st0.fyi.find((t) => t.id === n.id)).toMatchObject({ type: 'FYI' });
    expect(notifView(ready(sim), live(sim, n.id)).statusLabel).toBe('不用回覆');
    expect(st0.recent.some((r) => r.id === n.id)).toBe(false);
    const day0 = sim.d;
    const seen: Notif[] = [];
    sim.day({ afterClose: (c) => seen.push(...c) });
    expect(live(sim, n.id).status).toBe('PENDING'); // 第 1 個交易日還在
    sim.day({ afterClose: (c) => seen.push(...c) });
    const closed = live(sim, n.id);
    expect(sim.d - day0).toBe(2);
    expect(closed).toMatchObject({ status: 'AUTO_DEFAULT', reminded: false });
    expect(closed.respondedAt).toBe(sim.market.days[sim.d - 1]);
    expect(seen.filter((x) => x.kind === 'INFO')).toEqual([]);
    expect(stateView(ready(sim)).fyi.some((t) => t.id === n.id)).toBe(false); // 結案之後不在「不用回覆」裡
    for (let k = 0; k < 4; k++) sim.day({ afterClose: (c) => seen.push(...c) });
    expect(seen.some((x) => x.kind === 'INFO' && x.ref === n.id)).toBe(false);
    // 影子紀錄：照舊的慢規則會賣 35 股、照 AI 0 股、實際 0 股
    expect(liveShadow(sim.acct.shadow).filter((s) => s.f === 'F7' && s.ticker === 'NVDA')).toEqual([expect.objectContaining({ rule: -35, ai: 0, actual: 0, choice: 'SKIP', notif: n.id, note: AUTO_DEFAULT_NOTE, runIds: ['run-drop'] })]);
    // 還在審查後持有；審查的結果留著
    expect(sim.acct.own.NVDA).toMatchObject({ slow: { state: 'WATCH' }, watchLevel: 0, dropReview: { status: 'CLEAR', thesis: true, level: 0 } });
    expect(sim.acct.lots.own.NVDA).toBe(70);
    // 網站：紀錄與通知頁的狀態
    expect(notifView(ready(sim), closed)).toMatchObject({ status: 'AUTO_DEFAULT', statusLabel: '沒有回覆，自動照預設不動', holdNotice: null });
    expect(historyView(ready(sim)).notifs.find((r) => r.id === n.id)!.summary).toBe('預設不動；2 個交易日沒有回覆，自動結案');
  });

  it('審查還沒有結果（還在跑、沒跑完但還會重派）時不結案；有了結果或不會再派了才結案', () => {
    const sim = ladder({ big: true, flat: true });
    const n = untilReview(sim);
    const set = (o: Partial<DropReview>) => (sim.acct.own.NVDA.dropReview = { session: n.date, runId: 'r', status: 'PENDING', cause: null, premiseId: null, told: false, thesis: true, level: 0, days: 1, lastTry: n.date, sameDay: 1, ...o });
    set({ status: 'PENDING' });
    for (let k = 0; k < 3; k++) sim.day();
    expect(live(sim, n.id).status).toBe('PENDING');
    set({ status: 'NONE', days: 3 });
    sim.day();
    expect(live(sim, n.id).status).toBe('PENDING');
    // 3 個交易日都沒跑完、不再重派 → 下一次每日檢查就結案（仍然不動）
    set({ status: 'NONE', days: 3, failed: true });
    sim.day();
    expect(live(sim, n.id).status).toBe('AUTO_DEFAULT');
    expect(liveShadow(sim.acct.shadow).find((s) => s.f === 'F7' && s.ticker === 'NVDA')).toMatchObject({ rule: -35, ai: null, actual: 0 }); // 沒有結論：照 AI 那條線是空的
    expect(sim.acct.own.NVDA.slow.state).toBe('WATCH');
  });

  it('結案前改選減半：不用理由、當場給清單（錢照比例進核心）；填快照之後才變成減半，之後站回均線會有加回', () => {
    const sim = ladder({ big: true, flat: true, drops: { NVDA: clear } });
    const n = untilReview(sim);
    const key = item(n, 'F7', 'NVDA').key;
    expect(missingReasons(n, { mode: 'DO', choices: { [key]: 'RULE' } })).toEqual([]);
    sim.respond(n.id, { mode: 'DO', choices: { [key]: 'RULE' } });
    const r = live(sim, n.id);
    expect(r.status).toBe('RESPONDED');
    expect(r.composed!.merged.find((m) => m.ticker === 'NVDA')!.shares).toBe(-35);
    expect(r.composed!.lines.filter((l) => l.bucket === 'core').map((l) => l.ticker).sort()).toEqual(['SGOV', 'VOO']);
    expect(sim.acct.own.NVDA.slow.state).toBe('WATCH'); // 還沒成交
    // 影子紀錄：實際 -35（你自己選的），照 AI 0
    expect(liveShadow(sim.acct.shadow).find((s) => s.f === 'F7' && s.ticker === 'NVDA')).toMatchObject({ rule: -35, ai: 0, actual: -35, choice: 'RULE' });
    // 改決定：回到等你決定，選項回到預設
    const back = reopen(sim.acct, sim.pre, n.id);
    expect(back.ok).toBe(true);
    expect(item(back.acct.notifs.find((x) => x.id === n.id)!, 'F7', 'NVDA').choice).toBe('SKIP');
    sim.open();
    expect(live(sim, n.id).status).toBe('DONE');
    expect(sim.acct.lots.own.NVDA).toBe(35);
    expect(sim.acct.own.NVDA).toMatchObject({ slow: { state: 'HALF', sinceSwitch: 0 }, pending: null });
    expect([sim.acct.rule.own.NVDA.applied, sim.acct.own.NVDA.watchLevel, sim.acct.own.NVDA.dropReview]).toEqual(['HALF', undefined, undefined]);
    // 之後照減半處理：再跌沒有動作；站回均線 → 加回
    const later: Notif[] = [];
    while (!sim.atEnd()) sim.day({ afterMonthly: (m) => (later.push(m), sim.respond(m.id)), afterClose: (c) => later.push(...c) });
    expect(later.some((x) => x.items.some((i) => i.thesisDrop))).toBe(false);
    expect(later.some((x) => x.items.some((i) => i.f === 'F8' && i.ticker === 'NVDA'))).toBe(true);
  });

  it('你自己選「不動」結案：不算沒照規則（狀態寫「不動」）；回應記成 KEPT；票數不一致時那一行寫出分歧、影子的照 AI 是空的', () => {
    const sim = ladder({ big: true, drops: { NVDA: { status: 'SPLIT', extra: { splitPremise: 'P1', splitVotes: 1 } } } });
    const n = untilReview(sim);
    expect(item(n, 'F7', 'NVDA')).toMatchObject({ aiLine: '論點檢查：3 票裡有 1 票認為前提「資料中心 GPU 的領先地位兩年內不會被追上」不成立，沒有一致結論', drop: 'SPLIT', choice: 'SKIP' });
    const before = sim.acct;
    sim.respond(n.id, { mode: 'DO' });
    const done = live(sim, n.id);
    expect(done.status).toBe('SKIPPED');
    expect(keptAsRule(done)).toBe('不動');
    expect(historyView(ready(sim)).notifs.find((r) => r.id === n.id)!.summary).toBe('跌幅審查：你選了不動（沒有前提被判不成立，預設就是不動）');
    expect(liveShadow(sim.acct.shadow).find((s) => s.f === 'F7' && s.ticker === 'NVDA')).toMatchObject({ rule: -35, ai: null, actual: 0, choice: 'SKIP' });
    expect(ruleResponseLogs(before, done, n.date)[0].body).toMatchObject({ type: 'R', outcome: 'KEPT', reason: null, aiOffered: null, premiseId: null });
    expect(sim.acct.own.NVDA.disputes ?? []).toEqual([]);
    expect(sim.acct.own.NVDA).toMatchObject({ slow: { state: 'WATCH' }, dropReview: { status: 'SPLIT' } });
    // 三票都判了同一條、但引用不合格：另外寫清楚
    sim.acct.own.NVDA.dropReview = { ...sim.acct.own.NVDA.dropReview!, splitVotes: 3 };
    expect(watchNote(sim.acct, 'NVDA', -0.22)).toContain('3 票沒有一致結論，沒有減半');
  });
});

describe('T82：前提不成立才減半（D2）——金額分級、這次不做之後留在審查後持有、靜默期（§3.2、§3.3、§3.6）', () => {
  const broken: SimDrop = { status: 'BROKEN', premiseId: 'P1', runId: 'run-drop' };

  it('變動 ≥ 5%：留在當天那一則，預設改成減半、這次不做要寫理由；3 票都選出清時多「照 AI：出清」；規則的狀態照做了才變', () => {
    const sim = ladder({ big: true, drops: { NVDA: { ...broken, exit: true } } });
    const n = untilReview(sim);
    const it7 = item(n, 'F7', 'NVDA');
    expect(it7.aiLine).toBe('論點檢查（3 票）：前提「資料中心 GPU 的領先地位兩年內不會被追上」不成立。AI 建議出清，賣 70 股');
    expect(it7.choices.map((c) => [c.id, c.label, c.tier ?? null])).toEqual([['RULE', '減半', 'HALF'], ['AI', '照 AI：出清，賣 70 股', 'EXIT'], ['SKIP', '這次不做', null]]);
    expect(it7).toMatchObject({ choice: 'RULE', ruleChoice: 'RULE', drop: 'BROKEN', reasonRequired: true, brk: { type: 'B', premiseId: 'P1', withRule: true } });
    expect(isHoldNotice(n)).toBe(false);
    expect(n.preview!.merged.find((m) => m.ticker === 'NVDA')!.shares).toBe(-35);
    expect(missingReasons(n, { mode: 'DO', choices: { [it7.key]: 'SKIP' } }).map((i) => i.ticker)).toEqual(['NVDA']);
    expect(missingReasons(n, { mode: 'SKIP' })).toHaveLength(1);
    expect(sim.acct.own.NVDA.aiTier).toMatchObject({ tier: 'EXIT', premiseId: 'P1', trigger: 'DROP', agreed: true });
    expect([sim.acct.own.NVDA.slow.state, sim.acct.rule.own.NVDA.applied]).toEqual(['WATCH', 'STD']);
    // 要下單的通知照常提醒，不自動結案
    for (let k = 0; k < 3; k++) sim.day();
    expect(live(sim, n.id)).toMatchObject({ status: 'PENDING', reminded: true });
    // 照 AI 出清：移出自選
    const exit = ladder({ big: true, drops: { NVDA: { ...broken, exit: true } } });
    const ne = untilReview(exit);
    exit.respond(ne.id, { mode: 'DO', choices: { [item(ne, 'F7', 'NVDA').key]: 'AI' } });
    expect(liveShadow(exit.acct.shadow).find((s) => s.f === 'F7')).toMatchObject({ rule: -35, ai: -70, actual: -70, choice: 'AI' });
    exit.open();
    expect(exit.acct.own.NVDA).toBeUndefined();
    expect(exit.acct.ownClosed!.NVDA).toMatchObject({ reason: 'EXIT_AI' });
  });

  it('「這次不做」（要寫理由）→ 不減半、留在審查後持有（不是以前的「記成已減半」）；那條前提進靜默期；再跌一級會重新審查；改決定時靜默期收回', () => {
    const sim = ladder({ big: true, drops: { NVDA: broken } });
    const n = untilReview(sim);
    const key = item(n, 'F7', 'NVDA').key;
    const before = sim.acct;
    sim.respond(n.id, { mode: 'DO', choices: { [key]: 'SKIP' }, reasons: { [key]: '競爭對手的產品還沒量產' } });
    const done = live(sim, n.id);
    expect(done.status).toBe('SKIPPED');
    expect(keptAsRule(done)).toBeNull(); // 這是沒照預設（預設是減半）
    expect([sim.acct.own.NVDA.slow.state, sim.acct.rule.own.NVDA.applied, sim.acct.own.NVDA.watchLevel]).toEqual(['WATCH', 'STD', 0]);
    expect(sim.acct.own.NVDA.dropReview).toMatchObject({ status: 'BROKEN', premiseId: 'P1' }); // 留著給持股頁
    expect(sim.acct.own.NVDA.disputes).toMatchObject([{ premiseId: 'P1', reason: '競爭對手的產品還沒量產', notif: n.id }]);
    expect(liveShadow(sim.acct.shadow).find((s) => s.f === 'F7')).toMatchObject({ rule: -35, ai: -35, actual: 0, choice: 'SKIP', note: '競爭對手的產品還沒量產' });
    expect(ruleResponseLogs(before, done, n.date)[0].body).toMatchObject({ type: 'R', outcome: 'SKIPPED', reason: '競爭對手的產品還沒量產', aiOffered: 'HALF', premiseId: 'P1' });
    expect(watchNote(sim.acct, 'NVDA', -0.23)).toContain('判前提「資料中心 GPU 的領先地位兩年內不會被追上」不成立；你選了這次不做，沒有減半。再跌到 -30% 會重新審查');
    // 選減半（照預設）不進靜默期；3 票建議出清時選減半才進
    const half = ladder({ big: true, drops: { NVDA: broken } });
    const nh = untilReview(half);
    half.respond(nh.id, { mode: 'DO' });
    expect(half.acct.own.NVDA.disputes ?? []).toEqual([]);
    expect(ruleResponseLogs(half.acct, live(half, nh.id), nh.date)[0].body).toMatchObject({ outcome: 'HALVED', aiOffered: 'HALF' });
    const overExit = ladder({ big: true, drops: { NVDA: { ...broken, exit: true } } });
    const no = untilReview(overExit);
    overExit.respond(no.id, { mode: 'DO' });
    expect(overExit.acct.own.NVDA.disputes).toMatchObject([{ premiseId: 'P1' }]);
    const back = reopen(overExit.acct, overExit.pre, no.id);
    expect(back.acct.own.NVDA.disputes).toEqual([]);
    // 再跌一級（-30%）：重新審查，和上一次的回答無關
    const n2 = untilReview(sim, 2);
    expect(item(n2, 'F7', 'NVDA').thesisDrop).toEqual({ level: 1 });
    expect(n2.date > n.date).toBe(true);
  });

  it('變動 < 5%：當天那一則的項目取消（寫明併入月報）、整則結束，不用回覆；下一份月報列成跌幅審查的項目，預設減半；照做之後才是減半', () => {
    const sim = ladder({ drops: { NVDA: broken } });
    const shares = sim.acct.lots.own.NVDA;
    const n = untilReview(sim);
    expect(n.status).toBe('SUPERSEDED');
    expect(n.items[0]).toMatchObject({ cancelled: true, note: '論點檢查（3 票）：前提「資料中心 GPU 的領先地位兩年內不會被追上」不成立 → 減半。這一筆不到總資產的 5%，併入下一份月報' });
    expect((halveShares(shares) * priceOf(sim.pre, 'NVDA')) / totalValue(sim.acct, sim.pre)).toBeLessThan(0.05);
    expect(sim.acct.own.NVDA).toMatchObject({ slow: { state: 'WATCH' }, pending: { action: 'REDUCE', date: n.date }, dropReview: { status: 'BROKEN' } });
    expect(sim.acct.rule.own.NVDA.applied).toBe('STD');
    // 等月報的這一筆不會被每日檢查當成慢規則的當天通知
    const seen: Notif[] = [];
    while (!sim.isFirstOfMonth()) sim.day({ afterClose: (c) => seen.push(...c) });
    expect(seen.filter((x) => x.items.some((i) => i.ticker === 'NVDA' && i.f === 'F7' && !i.thesisDrop))).toEqual([]);
    const m = sim.preOpen()!;
    const it7 = item(m, 'F7', 'NVDA');
    expect(it7.title).toMatch(new RegExp(`^NVDA：比 52 週高點低 \\d+\\.\\d% → 跌幅審查（${n.date} 觸發；這一筆不到總資產的 5%，所以併入月報）$`));
    expect(it7).toMatchObject({ thesisDrop: { level: sim.acct.own.NVDA.watchLevel }, drop: 'BROKEN', choice: 'RULE', reasonRequired: true, brk: { type: 'B', premiseId: 'P1', withRule: true } });
    expect(sim.acct.own.NVDA.pending).toBeNull();
    expect([sim.acct.own.NVDA.slow.state, sim.acct.rule.own.NVDA.applied]).toEqual(['WATCH', 'STD']);
    // 月報重算（入金合併、排除）會還原月報前的狀態再算一次：等月報的那一筆還在，這一項照樣列
    const again = monthlyReport({ ...sim.acct, own: m.monthly!.before.own, rule: m.monthly!.before.rule, notifs: sim.acct.notifs.filter((x) => x.id !== m.id) }, sim.pre, m.monthly!.input);
    expect(item(again.notif, 'F7', 'NVDA')).toMatchObject({ drop: 'BROKEN', choice: 'RULE' });
    sim.respond(m.id);
    sim.open();
    expect(sim.acct.lots.own.NVDA).toBe(shares - halveShares(shares));
    expect([sim.acct.own.NVDA.slow.state, sim.acct.rule.own.NVDA.applied]).toEqual(['HALF', 'HALF']);
  });

  it('applyDropResult 的幾條路：今天的月報已經出了 → 留在當天那一則；通知已經結案（或你先選了不動）才判前提不成立 → ≥ 5% 另發一則、否則等月報；你已經選了減半就不另外發', () => {
    const setBroken = (sim: Sim) => {
      const meta = sim.acct.own.NVDA;
      meta.dropReview = { session: meta.dropReview?.session ?? sim.pre.date, runId: 'run-late', status: 'BROKEN', cause: null, premiseId: 'P1', told: false, thesis: true, level: meta.watchLevel ?? 0 };
      sim.acct = recordAiTier(sim.acct, 'NVDA', 'HALF', sim.pre.date, false, 'run-late', { premiseId: 'P1', trigger: 'DROP', agreed: true });
      return applyDropResult(sim.acct, sim.pre, 'NVDA');
    };
    // ① 小部位、今天的月報已經出了：留在當天那一則（免得多等一個月）
    const a = ladder();
    const na = untilReview(a);
    a.acct.notifs.push({ ...a.acct.notifs[0], id: 9000, kind: 'MONTHLY_EMPTY', date: a.pre.date, items: [], status: 'READ', monthly: { input: { order: [], month: '2099-01' }, before: { rule: a.acct.rule, own: {}, owe: {}, cash: 0 } } });
    const ra = setBroken(a);
    expect(ra).toMatchObject({ route: 'UPDATED', changed: [na.id] });
    expect(item(ra.acct.notifs.find((x) => x.id === na.id)!, 'F7', 'NVDA')).toMatchObject({ drop: 'BROKEN', choice: 'RULE' });
    expect(ra.acct.own.NVDA.pending).toBeNull();
    // ② 通知已經自動結案之後才回來（大部位）→ 另發一則當天通知
    const b = ladder({ big: true, flat: true });
    const nb = untilReview(b);
    for (let k = 0; k < 2; k++) b.day();
    expect(live(b, nb.id).status).toBe('AUTO_DEFAULT');
    const rb = setBroken(b);
    expect(rb.route).toBe('SAME_DAY');
    expect(rb.notif).toMatchObject({ kind: 'URGENT', title: 'NVDA 跌幅審查：前提不成立', status: 'PENDING' });
    expect(item(rb.notif!, 'F7', 'NVDA')).toMatchObject({ drop: 'BROKEN', choice: 'RULE', reasonRequired: true });
    // ③ 小部位：等月報
    const c = ladder();
    const nc = untilReview(c);
    c.respond(nc.id, { mode: 'DO' }); // 你先選了不動
    const rc = setBroken(c);
    expect(rc).toMatchObject({ route: 'MONTHLY', notif: null });
    expect(rc.acct.own.NVDA.pending).toMatchObject({ action: 'REDUCE' });
    // ④ 你已經選了減半、還在等下單：不另外發
    const d = ladder({ big: true });
    const nd = untilReview(d);
    d.respond(nd.id, { mode: 'DO', choices: { [item(nd, 'F7', 'NVDA').key]: 'RULE' } });
    const rd = setBroken(d);
    expect(rd).toMatchObject({ route: 'NONE', notif: null });
    expect(rd.why).toContain('已經選了要賣');
    // ⑤ 不是前提不成立、沒有還沒回覆的通知：只放網站
    b.acct.own.NVDA.dropReview = { ...b.acct.own.NVDA.dropReview!, status: 'CLEAR' };
    expect(applyDropResult(b.acct, b.pre, 'NVDA').route).toBe('NONE');
  });
});

describe('T82：快照顯示自己賣了一半 → 照減半處理（§3.6）', () => {
  it('審查後持有中，清單外賣掉原本股數的四分之一以上（還沒賣光）→ 狀態改成減半、回報 watchHalved、還沒回覆的那一項取消；賣得少的不算；賣光照舊移出自選', () => {
    const start = () => {
      const sim = ladder({ big: true, flat: true, drops: { NVDA: { status: 'CLEAR' } } });
      const n = untilReview(sim);
      return { sim, n };
    };
    // 賣一半（通知還沒回覆）
    const { sim, n } = start();
    const r = selfTrade(sim, 'NVDA', -35);
    expect(r.watchHalved).toEqual(['NVDA']);
    expect(sim.acct.lots.own.NVDA).toBe(35);
    expect(sim.acct.own.NVDA).toMatchObject({ slow: { state: 'HALF', sinceSwitch: 0 }, pending: null });
    expect([sim.acct.rule.own.NVDA.applied, sim.acct.own.NVDA.watchLevel, sim.acct.own.NVDA.dropReview]).toEqual(['HALF', undefined, undefined]);
    const old = live(sim, n.id);
    expect(old.status).toBe('CANCELLED');
    expect(old.items[0].note).toContain('快照顯示你自己賣了 35 股，這檔之後照減半處理');
    // 之後站回均線會有加回的通知
    const later: Notif[] = [];
    while (!sim.atEnd()) sim.day({ afterMonthly: (m) => (later.push(m), sim.respond(m.id)), afterClose: (c) => later.push(...c) });
    expect(later.some((x) => x.items.some((i) => i.f === 'F8' && i.ticker === 'NVDA'))).toBe(true);
    // 賣得少（不到四分之一）：還是審查後持有
    const few = start();
    expect(selfTrade(few.sim, 'NVDA', -10).watchHalved).toBeUndefined();
    expect(few.sim.acct.own.NVDA.slow.state).toBe('WATCH');
    expect(live(few.sim, few.n.id).status).toBe('PENDING');
    // 剛好四分之一算
    const quarter = start();
    expect(selfTrade(quarter.sim, 'NVDA', -18).watchHalved).toEqual(['NVDA']);
    // 賣光：移出自選（照舊）
    const all = start();
    const ra = selfTrade(all.sim, 'NVDA', -70);
    expect(ra.removedOwn).toEqual(['NVDA']);
    expect(ra.watchHalved).toBeUndefined();
    // 不在審查後持有的（標準）自己賣：照舊只提醒低於標準比重
    const std = ladder({ big: true });
    expect(selfTrade(std, 'NVDA', -35).watchHalved).toBeUndefined();
    expect(std.acct.own.NVDA.slow.state).toBe('STD');
  });
});

// ================================================================ LINE、推播、網站

describe('T82：LINE 文字、補推、網站的說明', () => {
  const sim0 = () => {
    const sim = ladder({ big: true });
    const n = untilReview(sim);
    const set = (o: Partial<DropReview>) => {
      sim.acct.own.NVDA.dropReview = { session: n.date, runId: 'run-drop', status: 'PENDING', cause: null, premiseId: null, told: false, thesis: true, level: 0, days: 1, lastTry: n.date, sameDay: 1, ...o };
      sim.acct = applyDropResult(sim.acct, sim.pre, 'NVDA').acct;
      return item(live(sim, n.id), 'F7', 'NVDA');
    };
    return { sim, n, set };
  };

  it('預設不動的那一則：LINE 一行說完（不用下單；細節在網站），沒有下單清單；前提不成立的照一般格式（賣單＋一行）', () => {
    const { sim, n, set } = sim0();
    const text = () => notifText(sim.acct, live(sim, n.id), 'https://bot.example/#/n/1');
    const dd = /低 (\d+\.\d%)/.exec(item(n, 'F7', 'NVDA').title)![1];
    for (const [o, say] of [
      [{ status: 'PENDING' }, 'AI 論點檢查還沒有結論，先不動；會再檢查'],
      [{ status: 'CLEAR' }, '論點檢查（3 票）前提都沒有被判不成立，不減半'],
      [{ status: 'SPLIT', splitPremise: 'P1', splitVotes: 2 }, '論點檢查 3 票沒有一致結論，不減半'],
      [{ status: 'NONE' }, 'AI 論點檢查還沒有結論，先不動；會再檢查'],
      [{ status: 'NONE', failed: true }, 'AI 論點檢查沒有跑完，不動'],
    ] as const) {
      const it7 = set(o);
      expect(holdNoticeLine(it7)).toBe(`NVDA 比高點低 ${dd}：${say}。不用下單；細節在網站。`);
      expect(text().split('\n')).toEqual([`【當天】NVDA 比高點低 ${dd}：${say}。不用下單；細節在網站。`, 'https://bot.example/#/n/1']);
    }
    // 設計的例句
    expect(holdNoticeLine({ ticker: 'MU', title: 'MU：比 52 週高點低 21.4% → 跌幅審查', drop: 'CLEAR' })).toBe('MU 比高點低 21.4%：論點檢查（3 票）前提都沒有被判不成立，不減半。不用下單；細節在網站。');
    // 前提不成立：一般格式
    set({ status: 'BROKEN', premiseId: 'P1' });
    const lines = text().split('\n');
    expect(lines[0]).toBe('【當天】NVDA 跌幅審查');
    expect(lines).toContain('賣 NVDA 35 股 · 自選訊號');
    expect(lines).toContain(DROP_LINE.BROKEN);
    expect(lines.indexOf(DROP_LINE.BROKEN)).toBeGreaterThan(lines.indexOf('賣 NVDA 35 股 · 自選訊號'));
  });

  it('等到 09:30 再推、講過了、補推：和減半檢視同一段；補推的是前提不成立、都沒有被判不成立、票數不一致（沒跑完的不補推，會重派）', () => {
    const { sim, n, set } = sim0();
    expect(pushWaiting(sim.acct, live(sim, n.id))).toBe(false); // 沒有 dropReview
    set({ status: 'PENDING' });
    expect(pushWaiting(sim.acct, live(sim, n.id))).toBe(true);
    dropWaiter.told!(sim.acct, live(sim, n.id));
    expect(sim.acct.own.NVDA.dropReview!.told).toBe(false); // 還在等的不標
    set({ status: 'NONE' });
    expect(pushWaiting(sim.acct, live(sim, n.id))).toBe(false);
    expect(dropWaiter.followUps!(sim.acct)).toEqual([]);
    set({ status: 'CLEAR' });
    const f = dropWaiter.followUps!(sim.acct);
    expect(f.map((x) => x.text)).toEqual([`NVDA 的 AI 論點檢查回來了：前提都沒有被判不成立，不減半。不用下單；細節在通知 #${n.id}。`]);
    f[0].told(sim.acct);
    expect(dropWaiter.followUps!(sim.acct)).toEqual([]);
    expect(dropFollowUpText('MU', 'SPLIT', 12)).toBe('MU 的 AI 論點檢查回來了：3 票沒有一致結論，不減半。不用下單；細節在通知 #12。');
    expect(dropFollowUpText('MU', 'BROKEN', 12)).toBe('MU 的 AI 論點檢查回來了：前提不成立，預設改成減半。通知 #12 已更新，到網站決定。');
    set({ status: 'BROKEN', premiseId: 'P1' });
    expect(dropWaiter.followUps!(sim.acct)[0].text).toBe(dropFollowUpText('NVDA', 'BROKEN', n.id));
  });

  it('持股頁與帳戶頁：審查後持有的說明（哪一天的審查、沒有減半、再跌到哪裡會重新審查、怎樣回到一般狀態）；有論點與只有預設前提的那一塊說明不同', () => {
    const { sim, n, set } = sim0();
    set({ status: 'CLEAR' });
    const md = `${Number(n.date.slice(5, 7))}/${Number(n.date.slice(8, 10))}`; // T86 P8：和同頁一樣的 1/13 格式
    expect(watchNote(sim.acct, 'NVDA', -0.23)).toBe(`比高點低 23%：${md} 的論點檢查沒有前提被判不成立，沒有減半。再跌到 -30% 會重新審查；站回 200 日線連續 10 天後回到一般狀態。`);
    const h = accountView(ready(sim)).holdings.find((x) => x.ticker === 'NVDA')!;
    expect(h).toMatchObject({ state: '審查後持有', tone: 'warn' });
    expect(h.detail).toContain('沒有前提被判不成立，沒有減半。再跌到 -30% 會重新審查');
    expect(h.meter!.label).toMatch(/比 52 週高點低 2\d\.\d%；再跌到 -30% 會重新審查/);
    const d = holdingDetail(ready(sim), 'NVDA')!;
    expect(d.own).toMatchObject({ state: '審查後持有', thesisKind: true, half: false });
    expect(d.own!.watch).toBe(h.detail);
    // 其他幾種結果
    set({ status: 'PENDING' });
    expect(watchNote(sim.acct, 'NVDA', -0.23)).toContain(`${md} 的論點檢查還在跑，先不動`);
    set({ status: 'NONE' });
    expect(watchNote(sim.acct, 'NVDA', -0.23)).toContain('還沒有結論，先不動（會再檢查）');
    set({ status: 'NONE', failed: true });
    expect(watchNote(sim.acct, 'NVDA', -0.23)).toContain('沒有跑完，沒有減半');
    set({ status: 'BROKEN', premiseId: 'P1' });
    expect(watchNote(sim.acct, 'NVDA', -0.23)).toContain('不成立；預設減半，等你決定');
    // 審到最後一級
    sim.acct.own.NVDA.watchLevel = 3;
    expect(watchNote(sim.acct, 'NVDA', -0.55)).toContain('已經審到最後一級，之後不再因為跌幅重新審查');
    // 只有預設前提的股票（META）：那一塊照舊是慢規則（底線）
    const meta = holdingDetail(ready(sim), 'META')!;
    expect(meta.own).toMatchObject({ state: '正常', thesisKind: false, watch: null });
    expect(accountView(ready(sim)).holdings.find((x) => x.ticker === 'META')!.detail).toMatch(/低 20% 會減半$/);
    expect(accountView(ready(sim)).holdings.find((x) => x.ticker === 'MU')!.detail).toMatch(/低 20% 會觸發跌幅審查（有論點，不直接減半）$/);
    const js = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'js', 'pages-holding.js'), 'utf8');
    expect(js).toContain("o.thesisKind ? '跌幅審查與價格' : '慢規則（底線）'");
    expect(js).toContain('o.watch ? h(');
  });

  it('通知頁：預設不動的那一種有「不用回覆」的一句（審查還沒有結果時寫先不動）；選項的說明寫清楚不動之後會怎樣、減半是自己想賣時用', () => {
    const { sim, n, set } = sim0();
    set({ status: 'PENDING' });
    let v = notifView(ready(sim), live(sim, n.id));
    expect(v.holdNotice).toContain('AI 論點檢查還沒有結論，先不動');
    set({ status: 'CLEAR' });
    v = notifView(ready(sim), live(sim, n.id));
    expect(v.holdNotice).toBe('這一則不用回覆、不用下單：2 個交易日沒有回覆就自動以「不動」結案，不會提醒。結案前想賣可以改選「減半」，系統當場給清單。');
    const iv = v.items[0];
    expect(iv).toMatchObject({ label: '跌幅審查', headline: 'NVDA 不動', thesisDrop: true, drop: 'CLEAR', reasonRequired: false, choice: 'SKIP' });
    expect(iv.choices.map((c) => [c.id, c.label])).toEqual([['SKIP', '不動'], ['RULE', '減半']]);
    expect(iv.explain.short).toMatch(/觸發跌幅審查；沒有前提被判不成立，不減半$/);
    expect(iv.explain.why).toContain('跌幅只觸發論點檢查，不是賣出的理由：3 票判同一條前提不成立才減半');
    expect(iv.explain.choiceNotes!.SKIP).toBe('不賣、不用下單，也不用寫理由。這檔留在「審查後持有」：再跌到比高點低 30% 會重新審查；站回 200 日均線連續 10 天後回到一般狀態。');
    expect(iv.explain.choiceNotes!.RULE).toContain('你自己想賣時用');
    expect(iv.meter!.say).toContain('觸發跌幅審查；沒有前提被判不成立，預設不動');
    // 前提不成立：不是「不用回覆」的那一種；這次不做的說明寫留在審查後持有與靜默期
    set({ status: 'BROKEN', premiseId: 'P1' });
    v = notifView(ready(sim), live(sim, n.id));
    expect(v.holdNotice).toBeNull();
    expect(v.items[0]).toMatchObject({ headline: '賣 NVDA 35 股', drop: 'BROKEN', reasonRequired: true, choice: 'RULE', discuss: true });
    expect(v.items[0].explain.choiceNotes!.SKIP).toContain('要寫一句為什麼這次不做。不賣，這檔留在「審查後持有」');
    expect(v.items[0].explain.choiceNotes!.SKIP).toContain('那條前提會進靜默期');
    expect(v.items[0].meter!.say).toContain('3 票判前提不成立 → 預設賣一半，35 股');
    const js = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'js', 'pages-notif.js'), 'utf8');
    for (const t of ['v.holdNotice', "'不動，結案'", "v.status === 'AUTO_DEFAULT'", 'r.watchHalved', '在審查後持有中；你賣了一半，之後照減半處理（站回 200 日線會提醒加回）']) expect(js).toContain(t);
  });

  it('「要看的事」：跌幅審查 3 個交易日都沒跑完 → 列一次（到這檔離開審查後持有或再跌一級為止）', () => {
    const { sim, set } = sim0();
    const file = () => metaFile(sim.acct, 'NVDA', sim.pre.date)!;
    set({ status: 'NONE', days: 2 });
    expect(ownAttention([file()], sim.acct, sim.pre).filter((x) => x.kind === 'DROP_REVIEW_FAILED')).toEqual([]);
    set({ status: 'NONE', days: 3, failed: true });
    const hit = ownAttention([file()], sim.acct, sim.pre).filter((x) => x.kind === 'DROP_REVIEW_FAILED');
    expect(hit).toHaveLength(1);
    expect(hit[0].text).toMatch(/^NVDA 的跌幅審查（\d\d-\d\d 觸發）沒有跑完，這檔沒有減半/);
  });
});

// ================================================================ 整條流程（假的 EDGAR、雲端排程、LINE）

/** 三票減半、都判 P1 不成立（引用 8-K 原文）：前提不成立，但不是三票都選出清。 */
function brokenVotes(pack: { run_id: string; documents: { kind: string; text: string; source_id: string; date: string }[] }) {
  const doc = pack.documents.find((d) => d.kind === 'filing' && d.text.includes(EXIT_QUOTE))!;
  const v = { run_id: pack.run_id, verdict: 'HALF', premise_checks: [{ premise_id: 'P1', status: 'BROKEN', evidence_ids: ['E1'] }], evidence: [{ id: 'E1', source_id: doc.source_id, date: doc.date, quote: EXIT_QUOTE, claim: '大客戶取消訂單' }], payload: { tier: 'HALF', cause_class: 'FUNDAMENTAL' }, report: '需求的前提不成立。' };
  return [v, v, v];
}
const alertsOf = async (db: D1Database, kind: string) => (await db.prepare('SELECT session, message FROM alerts WHERE kind = ? ORDER BY id').bind(kind).all<{ session: string; message: string }>()).results;

describe('T82：整條流程——沒跑完的重派與告警（§3.2）', () => {
  it('連三個交易日都沒開成：每天 07:30 與 09:30 各派一次（共 6 次），期間通知不結案、一直是不動；第 4 個交易日記成失敗、推 REVIEW_FAILED，之後通知自動結案', async () => {
    await withWorld(async ({ db, w, sec, run, acct }) => {
      await run('2026-11-20');
      crash(w, '2026-11-23', true);
      sec.fireDown = true;
      await run('2026-11-23');
      const n = reduceNotif(await acct());
      expect((await acct()).own.NVDA.dropReview).toMatchObject({ status: 'NONE', days: 1, sameDay: 1, lastTry: '2026-11-23' });
      await run('2026-11-23', 'FINAL');
      expect((await acct()).own.NVDA.dropReview).toMatchObject({ status: 'NONE', days: 1, sameDay: 2 });
      await run('2026-11-23', 'APPLY'); // 03:30 不開新的執行
      expect(await dropRuns(db)).toHaveLength(2);
      await run('2026-11-24');
      expect((await acct()).own.NVDA.dropReview).toMatchObject({ session: '2026-11-23', status: 'NONE', days: 2, sameDay: 1, lastTry: '2026-11-24' });
      await run('2026-11-24', 'FINAL');
      await run('2026-11-25');
      await run('2026-11-25', 'FINAL');
      expect(await dropRuns(db)).toHaveLength(6);
      const a3 = await acct();
      expect(a3.own.NVDA.dropReview).toMatchObject({ status: 'NONE', days: 3, sameDay: 2, lastTry: '2026-11-25' });
      expect(a3.own.NVDA.dropReview!.failed).toBeUndefined();
      // 超過 2 個交易日了，但審查還會重派 → 通知不結案；狀態一直是審查後持有、沒有賣單
      expect(reduceNotif(a3).status).toBe('PENDING');
      expect(f7(a3)).toMatchObject({ choice: 'SKIP', drop: 'NONE', aiLine: 'AI 論點檢查還沒有結論，先不動；會再檢查' });
      expect(await alertsOf(db, 'REVIEW_FAILED')).toEqual([]);
      // 第 4 個交易日（11/26 休市）：不再派，記成失敗、推告警
      await run('2026-11-27');
      expect(await dropRuns(db)).toHaveLength(6);
      const a4 = await acct();
      expect(a4.own.NVDA.dropReview).toMatchObject({ status: 'NONE', days: 3, failed: true });
      expect(f7(a4).aiLine).toBe('AI 論點檢查沒有跑完，不動；之後財報後的審查與再跌一級時仍會檢查');
      expect(await alertsOf(db, 'REVIEW_FAILED')).toEqual([{ session: '2026-11-27', message: 'NVDA 的跌幅審查（11-23 觸發）連續 3 個交易日沒有跑完，不再重派。這檔不動；之後財報後的審查與再跌一級時仍會檢查。' }]);
      expect(sec.line.some((t) => t.includes('【告警】') && t.includes('NVDA 的跌幅審查（11-23 觸發）連續 3 個交易日沒有跑完'))).toBe(true);
      expect([a4.own.NVDA.slow.state, a4.rule.own.NVDA.applied]).toEqual(['WATCH', 'STD']);
      // 月底的月報列進「要看的事」；通知在下一次每日檢查自動結案
      const r = await run('2026-11-30');
      const a5 = await acct();
      expect(a5.notifs.find((x) => x.id === n.id)!.status).toBe('AUTO_DEFAULT');
      expect(a5.notifs.find((x) => x.id === r.monthly)!.attention?.some((x) => x.kind === 'DROP_REVIEW_FAILED' && x.ticker === 'NVDA')).toBe(true);
      await run('2026-11-30', 'FINAL');
      expect(await alertsOf(db, 'REVIEW_FAILED')).toHaveLength(1); // 只告警一次
      // 從頭到尾沒有因為跌幅叫你賣
      expect(a5.notifs.some((x) => x.items.some((i) => i.f === 'F7' && !i.cancelled && i.choice !== 'SKIP'))).toBe(false);
    });
  });

  it('09:30 重派的那一次跑完了（前提都沒有被判不成立）→ 11:30 套用、補推一行；不再重派', async () => {
    await withWorld(async ({ db, w, sec, run, acct }) => {
      await run('2026-11-20');
      crash(w, '2026-11-23');
      await run('2026-11-23');
      await run('2026-11-23', 'FINAL'); // 第一次逾時 → 推「還沒有結論，先不動」、重派
      const n = reduceNotif(await acct());
      const runs = (await dropRuns(db)).sort((x, y) => x.createdAt.localeCompare(y.createdAt));
      expect(runs.map((r) => r.status)).toEqual(['DONE', 'PENDING']);
      await postResult(db, runs[1].runId, holdVotes(runs[1].pack), new Date('2026-11-24T02:10:00Z'));
      await run('2026-11-23', 'APPLY');
      const a = await acct();
      expect(a.own.NVDA.dropReview).toMatchObject({ status: 'CLEAR', runId: runs[1].runId, days: 1, sameDay: 2, told: true });
      expect(f7(a)).toMatchObject({ drop: 'CLEAR', choice: 'SKIP' });
      expect(notices(sec).at(-1)).toContain(`NVDA 的 AI 論點檢查回來了：前提都沒有被判不成立，不減半。不用下單；細節在通知 #${n.id}。`);
      await run('2026-11-24');
      await run('2026-11-24', 'FINAL');
      expect(await dropRuns(db)).toHaveLength(2);
      // 第一次（逾時）的結果晚到也不會蓋掉
      expect((await getRun(db, runs[0].runId))!.outcome!.status).toBe('TIMEOUT');
    });
  });
});

describe('T82：整條流程——前提不成立的金額分級、先選了不動才回來的結果、票數不一致', () => {
  it('變動 < 5%：三票判前提不成立 → 當天那一則在推之前就併入月報（不推 LINE）；月底的月報列成跌幅審查的項目、預設減半，寫 BREAK_NOTICE', async () => {
    await withWorld(
      async ({ db, w, sec, cik, run, acct, api }) => {
        await run('2026-11-20');
        crash(w, '2026-11-23', true);
        sec.cos.set(cik, [EIGHTK]);
        const r1 = await run('2026-11-23');
        const n = reduceNotif(await acct());
        expect(r1.push.held).toEqual([n.id]); // 審查的通知不分金額大小，當天產生
        const [drop] = await dropRuns(db);
        await postResult(db, drop.runId, brokenVotes(drop.pack), new Date('2026-11-24T00:10:00Z'));
        await run('2026-11-23', 'FINAL');
        let a = await acct();
        expect(a.notifs.find((x) => x.id === n.id)).toMatchObject({ status: 'SUPERSEDED' });
        expect(a.notifs.find((x) => x.id === n.id)!.items[0].note).toContain('這一筆不到總資產的 5%，併入下一份月報');
        expect(a.own.NVDA).toMatchObject({ slow: { state: 'WATCH' }, pending: { action: 'REDUCE', date: '2026-11-23' }, dropReview: { status: 'BROKEN', premiseId: 'P1' } });
        expect(a.own.NVDA.dropReview!.exit).toBeUndefined();
        expect(a.own.NVDA.aiTier).toMatchObject({ tier: 'HALF', premiseId: 'P1', trigger: 'DROP', agreed: true });
        expect(notices(sec)).toEqual([]);
        expect(await pushRows(db)).toEqual([]);
        for (const d of ['2026-11-24', '2026-11-25', '2026-11-27']) await run(d);
        expect(await dropRuns(db)).toHaveLength(1); // 等月報的期間不重開審查
        const r = await run('2026-11-30');
        a = await acct();
        const m = a.notifs.find((x) => x.id === r.monthly)!;
        const it7 = m.items.find((i) => i.f === 'F7' && i.ticker === 'NVDA')!;
        expect(it7.title).toContain('→ 跌幅審查（2026-11-23 觸發；這一筆不到總資產的 5%，所以併入月報）');
        expect(it7).toMatchObject({ drop: 'BROKEN', choice: 'RULE', reasonRequired: true, aiLine: `論點檢查（3 票）：前提「${P1}」不成立` });
        expect(it7.choices.map((c) => c.id)).toEqual(['RULE', 'SKIP']);
        expect(a.own.NVDA.pending).toBeNull();
        expect(await dropRuns(db)).toHaveLength(1); // 月報列出來也不會再開一次審查
        expect((await logRows(db, 'BREAK_NOTICE')).map((l) => [l.ref, l.body.tier, l.body.withRule, l.body.sameDay])).toEqual([[String(m.id), 'HALF', true, false]]);
        // 照做：填快照之後才是減半
        expect((await api(`notif/${m.id}/respond`, { mode: 'DO' }, new Date('2026-12-01T03:00:00Z'))).status).toBe(200);
        expect((await logRows(db, 'RESPONSE')).at(-1)!.body).toMatchObject({ type: 'R', outcome: 'HALVED', aiOffered: 'HALF', premiseId: 'P1' });
      },
      { nvda: 12_000 },
    );
  });

  it('你先選了不動，之後才判前提不成立（≥ 5%）→ 另發一則當天通知「跌幅審查：前提不成立」，預設減半、推 LINE', async () => {
    await withWorld(async ({ db, w, sec, cik, run, acct, api }) => {
      await run('2026-11-20');
      crash(w, '2026-11-23', true);
      sec.cos.set(cik, [EIGHTK]);
      await run('2026-11-23');
      const n = reduceNotif(await acct());
      expect((await api(`notif/${n.id}/respond`, { mode: 'DO' })).status).toBe(200);
      const [drop] = await dropRuns(db);
      await postResult(db, drop.runId, brokenVotes(drop.pack), new Date('2026-11-23T23:55:00Z'));
      const r2 = await run('2026-11-23', 'FINAL');
      const a = await acct();
      const fresh = a.notifs.find((x) => x.title === 'NVDA 跌幅審查：前提不成立')!;
      expect(r2.created).toEqual([fresh.id]);
      expect(fresh.items[0]).toMatchObject({ f: 'F7', drop: 'BROKEN', choice: 'RULE', reasonRequired: true, runIds: [drop.runId] });
      expect(a.notifs.find((x) => x.id === n.id)!.status).toBe('SKIPPED');
      const lines = notices(sec).at(-1)!.split('\n');
      expect(lines[0]).toBe('【紙上】【當天】NVDA 跌幅審查：前提不成立');
      expect(lines.some((l) => l.startsWith('賣 NVDA'))).toBe(true);
      expect((await logRows(db, 'BREAK_NOTICE')).map((l) => [l.ref, l.body.tier, l.body.withRule])).toEqual([[String(fresh.id), 'HALF', true]]);
    });
  });

  it('票數不一致（一票判前提不成立）→ 預設不動、通知寫出分歧；算進「連續幾次沒有一致結論」的計數（和定期審查同一個）', async () => {
    await withWorld(async ({ db, w, sec, cik, run, acct }) => {
      await run('2026-11-20');
      crash(w, '2026-11-23', true);
      sec.cos.set(cik, [EIGHTK]);
      await run('2026-11-23');
      const [drop] = await dropRuns(db);
      const votes = [...holdVotes(drop.pack).slice(0, 2), brokenVotes(drop.pack)[0]];
      await postResult(db, drop.runId, votes, new Date('2026-11-24T00:10:00Z'));
      await run('2026-11-23', 'FINAL');
      const a = await acct();
      expect(a.own.NVDA.dropReview).toMatchObject({ status: 'SPLIT', splitPremise: 'P1', splitVotes: 1 });
      expect(f7(a)).toMatchObject({ drop: 'SPLIT', choice: 'SKIP', aiLine: `論點檢查：3 票裡有 1 票認為前提「${P1}」不成立，沒有一致結論` });
      expect(a.own.NVDA.aiTier).toBeNull();
      expect(notices(sec)[0]).toContain('論點檢查 3 票沒有一致結論，不減半。不用下單；細節在網站。');
      const splits = await db.prepare("SELECT value FROM flow_state WHERE key = 'review:splits:NVDA'").first<{ value: string }>();
      expect(JSON.parse(splits!.value)).toMatchObject({ count: 1 });
      expect(await dropRuns(db)).toHaveLength(1); // 跑完了，不重派
    });
  });
});

// ================================================================ prompt

describe('T82 prompt：own_drop_v6 是新檔，v5 留著；run.md 不用改', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'ai', 'prompts');
  const read = (f: string) => readFileSync(join(root, f), 'utf8');

  it('版本與檔頭；有論點的股票題目改寫：跌幅只觸發審查、減半與出清要對應一條不成立的前提、拿不定主意選不動；只有預設前提的照 v5', () => {
    expect(OWN_DROP_PROMPT).toBe('own_drop_v6');
    const v6 = read('own_drop_v6.md');
    expect(v6.startsWith('# own_drop_v6：')).toBe(true);
    expect(v6).toContain('和 v5 的差別（2026-11-22，T82');
    for (const t of [
      '本身不是賣出的理由',
      '**`HALF` 與 `EXIT` 一定要對應一條你判成 `BROKEN`、有合格引用的前提**',
      '**沒有任何一條前提是 `BROKEN` 就選這個**，不論跌幅的歸類是大盤、產業還是這檔自己',
      '**不能因為跌得多、跌幅主要來自公司自身、原因看不出來、或新眼光找到新的風險而選 `HALF` 或 `EXIT`。**',
      '| 前提不成立 |',
      '| 前提都沒有被判不成立 |',
      '| 票數不一致 |',
      '| 沒跑完 |',
      '程式會重派（最多 3 個交易日）',
      '**只有系統預設前提的股票**（減半檢視，和以前相同）',
    ]) expect(v6, t).toContain(t);
    // 拿掉的：不動要歸類是大盤或產業、程式核對跌幅拆解
    expect(v6).not.toContain('而且要同時成立：跌幅主要是大盤或產業');
    expect(v6).not.toContain('**程式自己核對跌幅拆解**');
    // v5 的其他內容照樣有（找資料、新眼光、來源評級、confirm_ids）
    for (const t of ['**只有分析師可以用 WebSearch、可以取文件。**', '2. **新眼光**', '照 `ai/prompts/source_rating.md` 開來源評級', '**`confirm_ids`**', '"lookups": {']) expect(v6, t).toContain(t);
    // 舊版留著，開頭標不再使用
    const v5 = read('own_drop_v5.md');
    expect(v5.split('\n')[0]).toContain('> 不再使用（2026-11-22）：T82 起改用 `own_drop_v6.md`');
    expect(v5).toContain('# own_drop_v5：');
    expect(v5).toContain('**程式自己核對跌幅拆解**');
  });

  it('run.md 照 prompt_version 找檔，沒有寫死減半檢視的檔名 → 不用改、不用重貼', () => {
    const run = read('run.md');
    expect(run).toContain('ai/prompts/<prompt_version>.md');
    expect(run).not.toMatch(/own_drop/);
  });
});

