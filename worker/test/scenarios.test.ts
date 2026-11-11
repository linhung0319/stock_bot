// T3：prototype/README.md 的 7 個情境，各寫成一個固定測試。
// 照 2026-11-11 定案後的規則（設計 §10 第 25 點），不是照原型程式的舊行為。
// 市場是可重現的假資料（test/helpers/market.ts）；AI 的輸出在這裡當成輸入餵給引擎。
import { describe, expect, it } from 'vitest';
import {
  addOwn,
  bucketValue,
  changeRatio,
  classify,
  conditionMet,
  deposit,
  halveShares,
  hardEvent,
  initialReviewState,
  itemAction,
  monthlyReport,
  navPerUnit,
  priceOf,
  recordAiTier,
  resolveFollowUp,
  stepStrategyReview,
  totalValue,
  withdraw,
  type Item,
  type Notif,
  type StrategyReviewState,
} from '../src/engine';
import { ranksAt } from './helpers/market';
import { scenarios } from './helpers/scenarios';
import { Sim, listOf } from './helpers/sim';

const item = (n: Notif, f: string, ticker?: string): Item => {
  const it = n.items.find((i) => i.f === f && (!ticker || i.ticker === ticker));
  if (!it) throw new Error(`通知 #${n.id} 沒有 ${f} ${ticker ?? ''}：${n.items.map((i) => i.f + ':' + i.ticker).join(' ')}`);
  return it;
};
const has = (n: Notif, f: string, ticker?: string) => n.items.some((i) => i.f === f && (!ticker || i.ticker === ticker));
const sharesOf = (it: Item, choice = it.choices[0].id) => it.choices.find((c) => c.id === choice)!.lines.reduce((a, l) => a + l.shares, 0);

describe('情境 ① 平常的月報', () => {
  const start = () => {
    const sc = scenarios.s1();
    const sim = new Sim(sc.market, sc.init, { vetoes: { '2026-12': ['APP'] } });
    sim.runUntil('2026-12-01');
    // 11 月底的 F24：MSFT 前提全部成立、F23 規則條件成立 → 3 票 RAISE
    sim.acct = recordAiTier(sim.acct, 'MSFT', 'RAISE', '2026-11-30', true);
    return sim;
  };

  it('12/01 月報：ORCL 出場、APP 被否決由 GE 遞補、PLTR 搭便車回調、MSFT 提高到 125% 只列 AI 一行', () => {
    const sim = start();
    expect(ranksAt(sim.market, sim.d - 1).slice(0, 5)).toEqual(['PLTR', 'APP', 'AVGO', 'GE', 'NFLX']);
    const n = sim.preOpen()!;
    expect(n.kind).toBe('MONTHLY');
    // F2：ORCL 掉出前 15 名 → 全部賣出
    expect(sharesOf(item(n, 'F2', 'ORCL'))).toBe(-28);
    // F1：APP 排名第 2 但本月被任務 A 否決 → 不進場，由 GE 遞補
    expect(has(n, 'F1', 'APP')).toBe(false);
    const ge = item(n, 'F1', 'GE');
    const T = sim.total();
    expect(sharesOf(ge)).toBe(Math.floor((T * 0.06) / priceOf(sim.pre, 'GE')));
    // F3：PLTR 偏離目標超過 +50%，本月有其他單 → 一起拉回
    const pltr = item(n, 'F3', 'PLTR');
    expect(sharesOf(pltr)).toBeLessThan(0);
    expect((53 + sharesOf(pltr)) * priceOf(sim.pre, 'PLTR')).toBeCloseTo(T * 0.06, -3);
    // F23：規則沒有動作，只有 AI 一行，預設不做
    const msft = item(n, 'F23', 'MSFT');
    expect(msft.kind).toBe('AI_ONLY');
    expect(msft.choice).toBe('SKIP');
    expect(sharesOf(msft, 'AI')).toBe(Math.floor((0.05 * 1.25 * T) / priceOf(sim.pre, 'MSFT')) - 9);
    // 合併後的清單：預設不含 MSFT；核心吸收差額
    expect(listOf(n).some((x) => x.includes('MSFT'))).toBe(false);
    expect(listOf(n)).toContain('賣 ORCL 28');
    expect(listOf(n).find((x) => x.includes('VOO'))).toMatch(/^買 VOO/);
  });

  it('把 MSFT 改成「照 AI」：核心那一行跟著變；做完後標準比重變成 125%', () => {
    const sim = start();
    const n = sim.preOpen()!;
    const vooBefore = n.preview!.merged.find((m) => m.ticker === 'VOO')!.shares;
    sim.respond(n.id, { mode: 'DO', choices: { [item(n, 'F23', 'MSFT').key]: 'AI' } });
    const done = sim.acct.notifs.find((x) => x.id === n.id)!;
    expect(done.composed!.merged.find((m) => m.ticker === 'VOO')!.shares).toBeLessThan(vooBefore);
    sim.open();
    expect(sim.acct.rule.own.MSFT.stdWeight).toBeCloseTo(0.0625, 12);
    expect(sim.acct.own.MSFT.raisedAt).toBe('2026-11-30');
    expect(sim.acct.lots.own.MSFT).toBeGreaterThan(9);
    // 影子組合：照規則 0 股、照 AI 買、實際 = 照 AI
    const sh = sim.acct.shadow.find((s) => s.f === 'F23')!;
    expect(sh.rule).toBe(0);
    expect(sh.ai).toBe(sh.actual);
  });

  it('GE 按「排除」：寫理由後由下一名遞補，舊清單作廢；影子記「如果沒排除」', () => {
    const sim = start();
    const n = sim.preOpen()!;
    const r = itemAction(sim.acct, sim.pre, n.id, item(n, 'F1', 'GE').key, { action: 'EXCLUDE', reason: '不想碰航太' });
    sim.acct = r.acct;
    expect(sim.acct.notifs.find((x) => x.id === n.id)!.status).toBe('SUPERSEDED');
    const n2 = r.notif!;
    expect(has(n2, 'F1', 'GE')).toBe(false);
    expect(has(n2, 'F1', 'NFLX')).toBe(false); // NFLX 本來就持有
    expect(has(n2, 'F1', 'GS')).toBe(true); // 排名：PLTR APP AVGO GE NFLX AMD GS…，下一個沒持有的是 GS
    expect(sim.acct.mom.excluded.GE.reason).toBe('不想碰航太');
    expect(sim.acct.shadow.some((s) => s.choice === 'EXCLUDE' && s.ticker === 'GE')).toBe(true);
    // 排除一直有效，直到使用者取消
    sim.respond(n2.id);
    sim.open();
    expect(sim.acct.lots.mom.GS).toBeGreaterThan(0);
    expect(sim.acct.lots.mom.GE).toBeUndefined();
  });

  it('ORCL 按「轉入自選」：不用下單，改歸自選桶，理由成為前提；影子記「如果照賣」', () => {
    const sim = start();
    const n = sim.preOpen()!;
    const r = itemAction(sim.acct, sim.pre, n.id, item(n, 'F2', 'ORCL').key, { action: 'TRANSFER', reason: '雲端訂單還在成長' });
    sim.acct = r.acct;
    expect(sim.acct.lots.mom.ORCL).toBeUndefined();
    expect(sim.acct.lots.own.ORCL).toBe(28);
    expect(sim.acct.own.ORCL.premises[0]).toMatchObject({ text: '雲端訂單還在成長', origin: 'USER' });
    expect(listOf(r.notif!).some((x) => x.includes('ORCL'))).toBe(false);
    expect(sim.acct.shadow.find((s) => s.choice === 'TRANSFER')).toMatchObject({ ticker: 'ORCL', rule: -28, actual: 0 });
    // 之後由自選規則管：月報不再叫你賣
    sim.respond(n.id);
    sim.open();
    sim.runUntil('2027-01-04');
    const jan = sim.preOpen()!;
    expect(has(jan, 'F2', 'ORCL')).toBe(false);
  });

  it('策略類「這次不做」：下一份月報把差額再列一次（設計 §2.3.1）', () => {
    const sim = start();
    const n = sim.preOpen()!;
    sim.respond(n.id, { mode: 'DO', choices: { [item(n, 'F2', 'ORCL').key]: 'SKIP', [item(n, 'F1', 'GE').key]: 'SKIP' } });
    sim.open();
    expect(sim.acct.lots.mom.ORCL).toBe(28);
    expect(sim.acct.lots.mom.GE).toBeUndefined();
    sim.close();
    sim.d++;
    sim.runUntil('2027-01-04');
    const jan = sim.preOpen()!;
    expect(sharesOf(item(jan, 'F2', 'ORCL'))).toBe(-28);
    expect(item(jan, 'F17', 'GE').title).toContain('沒照做');
    expect(sharesOf(item(jan, 'F17', 'GE'))).toBeGreaterThan(0);
  });

  it('照清單做完：帳本照清單分到各桶，1 月沒有規則單（只把零頭現金交給核心）', () => {
    const sim = start();
    const n = sim.preOpen()!;
    sim.respond(n.id);
    const r = sim.open()!;
    expect(r.completed).toEqual([n.id]);
    expect(r.followUps).toEqual([]);
    expect(r.created).toEqual([]);
    expect(sim.acct.lots.mom).toMatchObject({ AVGO: 18, NFLX: 52, AMD: 25 });
    expect(sim.acct.lots.mom.ORCL).toBeUndefined();
    expect(sim.acct.lots.mom.GE).toBeGreaterThan(0);
    expect(sim.acct.cash).toBeGreaterThanOrEqual(0);
    sim.close();
    sim.d++;
    sim.runUntil('2027-01-04');
    const jan = sim.preOpen()!;
    expect(jan.items.filter((i) => i.f !== 'CORE')).toEqual([]);
  });
});

describe('情境 ② 自選股大跌（MU）', () => {
  const start = () => {
    const sc = scenarios.s2();
    return new Sim(sc.market, sc.init);
  };

  it('MU 占約 14%：減半變動 ≥ 5% → 當天通知；AI 檔位也是「減半」→ 只顯示一行', () => {
    const sim = start();
    let urgent: Notif | undefined;
    // 12/18 財報後的 F24：前提 P1 不成立，3 票「減半」
    sim.runUntil('2026-12-18');
    sim.acct = recordAiTier(sim.acct, 'MU', 'HALF', '2026-12-18', true);
    while (!urgent && sim.date < '2027-01-04') sim.day({ afterClose: (c) => (urgent = c.find((n) => n.kind === 'URGENT')) });
    expect(urgent!.date).toBe('2026-12-24');
    const it7 = item(urgent!, 'F7', 'MU');
    expect(it7.choices.map((c) => c.id)).toEqual(['RULE', 'SKIP']); // AI 和規則是同一個動作，不多一行
    expect(sharesOf(it7)).toBe(-halveShares(58));
    const T = totalValue(sim.acct, sim.pre);
    expect((29 * priceOf(sim.pre, 'MU')) / T).toBeGreaterThanOrEqual(0.05);
    expect(sim.acct.rule.own.MU.applied).toBe('HALF');
    // 隔天開盤執行，錢進 VOO
    sim.respond(urgent!.id);
    sim.open();
    expect(sim.acct.lots.own.MU).toBe(29);
    expect(listOf(sim.acct.notifs.find((n) => n.id === urgent!.id)!).find((x) => x.includes('VOO'))).toMatch(/^買 VOO/);
  });

  it('META 同一天也跌破 -20%，但變動 < 5% → 不通知，併入 1 月月報；AI 說「不動」→ 兩行並列', () => {
    const sim = start();
    sim.runUntil('2026-12-31');
    expect(sim.acct.own.META.pending).toEqual({ action: 'REDUCE', date: '2026-12-24' });
    expect(sim.acct.notifs.some((n) => n.kind === 'URGENT' && n.items.some((i) => i.ticker === 'META'))).toBe(false);
    sim.acct = recordAiTier(sim.acct, 'META', 'HOLD', '2026-12-31', false);
    sim.runUntil('2027-01-04');
    const jan = sim.preOpen()!;
    const it7 = item(jan, 'F7', 'META');
    expect(it7.title).toContain('併入月報');
    expect(sharesOf(it7, 'RULE')).toBe(-3);
    expect(sharesOf(it7, 'AI')).toBe(0);
    expect(it7.aiLine).toContain('不動');
    // 使用者沒選就是照規則
    expect(it7.choice).toBe('RULE');
    // 選「照 AI（不動）」：META 不賣；規則狀態照樣前進（記成已減半），不再提醒
    sim.respond(jan.id, { mode: 'DO', choices: { [it7.key]: 'AI' } });
    sim.open();
    expect(sim.acct.lots.own.META).toBe(6);
    expect(sim.acct.rule.own.META.applied).toBe('HALF');
    expect(sim.acct.shadow.find((s) => s.f === 'F7' && s.ticker === 'META')).toMatchObject({ rule: -3, ai: 0, actual: 0 });
  });

  it('F25：條件成立 → 當天通知只有 AI 一行＋不做；每檔每月最多 1 則；照 AI 出清 = 移出自選', () => {
    const sim = start();
    sim.runUntil('2027-01-06');
    sim.day();
    // 1/6 收盤後：事件條件 C2 成立（3 票確認）→ AI 建議出清
    const r = conditionMet(sim.acct, sim.pre, 'MU', 'EXIT', 'DRAM/HBM 合約價走平或下跌', '2027-01');
    sim.acct = r.acct;
    const n = r.notif!;
    expect(n.kind).toBe('URGENT');
    const it25 = item(n, 'F25', 'MU');
    expect(it25.choices.map((c) => c.id)).toEqual(['AI', 'SKIP']);
    expect(it25.choice).toBe('SKIP'); // 使用者不選時照規則 = 不動
    expect(sharesOf(it25, 'AI')).toBe(-sim.acct.lots.own.MU);
    // 1/8 財報條件也成立，但本月已經發過
    const again = conditionMet(sim.acct, sim.pre, 'MU', 'HALF', '毛利率低於 80%', '2027-01');
    expect(again.notif).toBeNull();
    expect(again.why).toContain('本月已發過');
    // 照 AI 出清：全部賣出、錢回核心，這檔不再有規則或 AI 追蹤
    sim.respond(n.id, { mode: 'DO', choices: { [it25.key]: 'AI' } });
    sim.open();
    expect(sim.acct.lots.own.MU).toBeUndefined();
    expect(sim.acct.own.MU).toBeUndefined();
    expect(sim.acct.rule.own.MU).toBeUndefined();
    // 之後不會再出現加回
    sim.close();
    sim.d++;
    while (!sim.atEnd()) sim.day();
    expect(sim.acct.notifs.some((x) => x.id > n.id && x.items.some((i) => i.ticker === 'MU'))).toBe(false);
  });

  it('F8：2 月反彈後加回（< 5%，併入 3 月月報），AI 檔位「減半」→ 並列「維持減半」；照 AI 後狀態回到減半、切換日重算', () => {
    const sim = new Sim(scenarios.s2().market, scenarios.s2().init, { autoRespond: true });
    sim.runUntil('2027-02-26');
    expect(sim.acct.own.MU.pending).toEqual({ action: 'READD', date: '2027-02-18' });
    sim.acct = recordAiTier(sim.acct, 'MU', 'HALF', '2027-02-26', false);
    sim.opt.autoRespond = false;
    sim.runUntil('2027-03-01');
    const mar = sim.preOpen()!;
    const it8 = item(mar, 'F8', 'MU');
    const T = sim.total();
    expect(sharesOf(it8, 'RULE')).toBe(Math.floor((0.1 * T) / priceOf(sim.pre, 'MU')) - 29);
    expect(sharesOf(it8, 'AI')).toBe(0);
    expect(it8.aiLine).toContain('維持減半');
    expect(sim.acct.rule.own.MU.applied).toBe('STD'); // 規則狀態已經前進
    sim.respond(mar.id, { mode: 'DO', choices: { [it8.key]: 'AI' } });
    expect(sim.acct.lots.own.MU).toBe(29);
    expect(sim.acct.rule.own.MU.applied).toBe('HALF');
    expect(sim.acct.own.MU.slow).toMatchObject({ state: 'HALF', sinceSwitch: 0 });
  });
});

describe('情境 ③ 崩盤規則', () => {
  it('1 月啟動：核心一半換短債、動能減半併在同一項，AI 意見只附一行；2 月解除，買回比賣出貴', () => {
    const sc = scenarios.s3();
    const sim = new Sim(sc.market, sc.init, { crashOpinion: { '2027-01': '延後', '2027-02': '照做' } });
    sim.runUntil('2027-01-04');
    const jan = sim.preOpen()!;
    const f5 = item(jan, 'F5');
    expect(f5.aiLine).toBe('AI 檢視：延後'); // 只說明，不能否決或延後
    expect(f5.choices.map((c) => c.id)).toEqual(['DO', 'SKIP']);
    const lines = f5.choices[0].lines;
    expect(lines.find((l) => l.ticker === 'VOO')!.shares).toBeLessThan(0);
    expect(lines.find((l) => l.ticker === 'SGOV')!.shares).toBeGreaterThan(0);
    // 動能留任股各減半，和崩盤規則同一項
    for (const t of ['PLTR', 'AVGO', 'NFLX', 'AMD']) expect(lines.find((l) => l.ticker === t && l.bucket === 'mom')!.shares).toBeLessThan(0);
    expect(sim.acct.rule.crash).toBe(true);
    // 自選不受崩盤規則影響：MSFT 走自己的慢規則（< 5%，併入月報）
    expect(sharesOf(item(jan, 'F7', 'MSFT'))).toBe(-5);
    const sellPx = sim.market.open.VOO[sim.d];
    sim.respond(jan.id);
    sim.open();
    const T = totalValue(sim.acct, sim.pre);
    const voo = sim.acct.lots.core.VOO * priceOf(sim.pre, 'VOO');
    const bond = sim.acct.lots.core.SGOV * priceOf(sim.pre, 'SGOV') + sim.acct.cash;
    expect(Math.abs(voo - bond) / T).toBeLessThan(0.02); // 核心一半一半
    expect(bucketValue(sim.acct, sim.pre, 'mom') / T).toBeLessThan(0.17); // 動能約 15%

    // 啟動期間出金：順序 ① 先用短債
    const w = withdraw(sim.acct, sim.pre, 10000);
    expect(listOf(w.notif)).toEqual([`賣 SGOV ${Math.ceil((10000 - sim.acct.cash) / 0.98 / priceOf(sim.pre, 'SGOV'))}`]);

    sim.close();
    sim.d++;
    sim.runUntil('2027-02-01');
    const feb = sim.preOpen()!;
    const f6 = item(feb, 'F6');
    expect(f6.aiLine).toBe('AI 檢視：照做');
    expect(f6.choices[0].lines.find((l) => l.ticker === 'SGOV')!.shares).toBe(-sim.acct.lots.core.SGOV);
    expect(sim.acct.rule.crash).toBe(false);
    const buyPx = sim.market.open.VOO[sim.d];
    expect(buyPx).toBeGreaterThan(sellPx); // 保險費：買回通常比賣出貴
    sim.respond(feb.id);
    sim.open();
    expect(sim.acct.lots.core.SGOV).toBeUndefined();
    expect(bucketValue(sim.acct, sim.pre, 'mom') / totalValue(sim.acct, sim.pre)).toBeGreaterThan(0.25);
  });
});

describe('情境 ④ 硬事件', () => {
  it('動能持股被收購：規則直接提出、使用者確認；不確認 → 下個月月報再列，空格照排名遞補', () => {
    const sc = scenarios.s4();
    const sim = new Sim(sc.market, sc.init);
    sim.runUntil('2026-12-10');
    sim.day();
    // 12/10 收盤後：ORCL 出現 DEFM14A（被收購方）
    const r = hardEvent(sim.acct, sim.pre, 'ORCL', 'PENDING_MA', true);
    sim.acct = r.acct;
    const it19 = item(r.notif!, 'F19', 'ORCL');
    expect(it19.title).toContain('規則提出');
    expect(it19.choice).toBe('DO');
    expect(sharesOf(it19)).toBe(-28);
    expect(sim.acct.rule.heldMom).not.toContain('ORCL');
    // 這次不做 → 1 月月報把 ORCL 的出場再列一次，並由排名最前、沒持有的遞補
    sim.respond(r.notif!.id, { mode: 'SKIP' });
    expect(sim.acct.lots.mom.ORCL).toBe(28);
    sim.runUntil('2027-01-04');
    const jan = sim.preOpen()!;
    expect(sharesOf(item(jan, 'F2', 'ORCL'))).toBe(-28);
    expect(has(jan, 'F1', 'GS')).toBe(true);
  });

  it('自選股財報重編：3 票才升級給人，預設「不做」；選照 AI → 出清並移出自選', () => {
    const sc = scenarios.s4();
    const sim = new Sim(sc.market, sc.init);
    sim.runUntil('2026-12-15');
    sim.day();
    const r = hardEvent(sim.acct, sim.pre, 'META', 'ACCOUNTING', false);
    sim.acct = r.acct;
    const it19 = item(r.notif!, 'F19', 'META');
    expect(it19.choice).toBe('SKIP');
    expect(sim.acct.own.META.flags).toEqual(['ACCOUNTING']);
    sim.respond(r.notif!.id, { mode: 'DO', choices: { [it19.key]: 'AI' } });
    sim.open();
    expect(sim.acct.lots.own.META).toBeUndefined();
    expect(sim.acct.own.META).toBeUndefined();
    // 沒持有的股票出事 → 不通知
    expect(hardEvent(sim.acct, sim.pre, 'IBM', 'ACCOUNTING', false).notif).toBeNull();
  });
});

describe('情境 ⑤ 你自己的操作', () => {
  const start = () => {
    const sc = scenarios.s5();
    const sim = new Sim(sc.market, sc.init);
    sim.runUntil('2026-12-10');
    return sim;
  };

  it('入金 10,000：只買不賣，補低於目標最多的格子，剩下的進核心；買單不超過現金的 98%', () => {
    const sim = start();
    const cash0 = sim.acct.cash;
    const nav0 = navPerUnit(sim.acct, sim.pre).total;
    const r = deposit(sim.acct, sim.pre, 10000);
    sim.acct = r.acct;
    expect(r.mergedIntoMonthly).toBe(false);
    const merged = r.notif.preview!.merged;
    expect(merged.every((m) => m.shares > 0)).toBe(true);
    const spent = merged.reduce((a, m) => a + m.shares * priceOf(sim.pre, m.ticker), 0);
    expect(spent).toBeLessThanOrEqual(0.98 * (cash0 + 10000) + 1e-6);
    expect(spent).toBeGreaterThan(0.9 * (cash0 + 10000));
    // MU 已經超過目標（占 13% vs 標準 8%）→ 不補
    expect(merged.some((m) => m.ticker === 'MU')).toBe(false);
    // 單位淨值不受入金影響
    expect(navPerUnit(sim.acct, sim.pre).total).toBeCloseTo(nav0, 9);
    sim.respond(r.notif.id);
    const s = sim.open()!;
    expect(s.created).toEqual([]);
    expect(sim.acct.cash).toBeGreaterThanOrEqual(0);
  });

  it('出金 30,000：先做單檔上限檢查（MU 出金後會超過 15% → 減回 10%），其餘賣 VOO；做完現金剛好夠轉出', () => {
    const sim = start();
    const T = sim.total();
    const muVal = 56 * priceOf(sim.pre, 'MU');
    expect(muVal / T).toBeLessThan(0.15);
    expect(muVal / (T - 30000)).toBeGreaterThan(0.15);
    const r = withdraw(sim.acct, sim.pre, 30000);
    sim.acct = r.acct;
    const lines = r.notif.items[0].choices[0].lines;
    const mu = lines.find((l) => l.ticker === 'MU')!;
    expect(mu.reason).toBe('單檔上限');
    expect((56 + mu.shares) * priceOf(sim.pre, 'MU')).toBeCloseTo(0.1 * (T - 30000), -3);
    const merged = r.notif.preview!.merged;
    expect(merged.every((m) => m.shares < 0)).toBe(true);
    expect(merged.find((m) => m.ticker === 'VOO')!.shares).toBeLessThan(0);
    expect(merged.some((m) => ['NVDA', 'MSFT', 'META'].includes(m.ticker))).toBe(false); // 其他自選最後才動
    const nav0 = navPerUnit(sim.acct, sim.pre).total;
    sim.respond(r.notif.id);
    sim.open();
    expect(sim.acct.cash).toBeGreaterThanOrEqual(0);
    expect(sim.acct.cash).toBeLessThan(2500);
    expect(totalValue(sim.acct, sim.pre)).toBeLessThan(T - 29000);
    expect(navPerUnit(sim.acct, sim.pre).total / nav0).toBeCloseTo(1, 2); // 出金不算報酬
    // 之後的月報不會再為單檔上限賣一次
    sim.close();
    sim.d++;
    sim.runUntil('2027-01-04');
    expect(has(sim.preOpen()!, 'F10', 'MU')).toBe(false);
  });

  it('改比例 Strategy 30% → 0%：清單是賣掉動能持股、全部買 VOO；影子繼續追蹤「如果沒改」', () => {
    const sim = start();
    const r = changeRatio(sim.acct, sim.pre, { own: 0.2, strat: 0, core: 0.8 });
    sim.acct = r.acct;
    const lines = r.notif.items[0].choices[0].lines;
    expect(lines.map((l) => `${l.ticker}:${l.shares}`).sort()).toEqual(['AMD:-25', 'AVGO:-18', 'NFLX:-52', 'ORCL:-28', 'PLTR:-33']);
    expect(listOf(r.notif).find((x) => x.includes('VOO'))).toMatch(/^買 VOO/);
    expect(sim.acct.shadow.at(-1)).toMatchObject({ f: 'F13', choice: 'RATIO' });
    sim.respond(r.notif.id);
    sim.open();
    expect(sim.acct.lots.mom).toEqual({});
  });

  it('新增自選 TSLA：距高點已跌 > 20% → 一開始就是減半狀態，只買標準比重的一半；錢從核心出', () => {
    const sim = start();
    const r = addOwn(sim.acct, sim.pre, 'TSLA', [{ id: 'P1', text: '自駕計程車在 2027 年擴大到 10 個城市', origin: 'AI_DRAFT_ACCEPTED', breaksIf: '主要城市的營運許可被撤回' }]);
    sim.acct = r.acct;
    expect(r.startsHalved).toBe(true);
    expect(sim.acct.rule.own.TSLA.applied).toBe('HALF');
    expect(Object.keys(r.recommended).sort()).toEqual(['META', 'MSFT', 'MU', 'NVDA', 'TSLA']);
    expect(Object.values(r.recommended).reduce((a, b) => a + b, 0)).toBeCloseTo(0.2, 12); // 自選預算內依波動度反比
    const std = sim.acct.rule.own.TSLA.stdWeight;
    const sh = sharesOf(r.notif.items[0]);
    expect(sh).toBe(Math.floor((std * 0.5 * sim.total()) / priceOf(sim.pre, 'TSLA')));
    // 錢從核心出：帳上現金夠就用現金，不夠才賣 VOO；做完現金不會是負的
    expect(r.notif.preview!.cashAfter).toBeGreaterThanOrEqual(0);
    expect(r.notif.preview!.merged.every((m) => m.ticker === 'TSLA' || m.ticker === 'VOO')).toBe(true);
    // 其他自選股的標準比重不會因此改變，也不會被賣
    expect(sim.acct.rule.own.MU.stdWeight).toBe(0.08);
    expect(sim.acct.own.TSLA.premises[0].origin).toBe('AI_DRAFT_ACCEPTED');
    // 沒寫前提 → 系統預設前提
    expect(addOwn(sim.acct, sim.pre, 'IBM').acct.own.IBM.premises.every((p) => p.origin === 'SYSTEM_DEFAULT')).toBe(true);
  });

  it('手動買 10 股 AAPL：快照出現清單外的變動 → 問哪一桶；分類前月報暫停；只能歸自選（定案後的規則）', () => {
    const sim = start();
    const s = sim.open({ AAPL: 10 })!;
    expect(s.created.map((n) => n.kind)).toEqual(['CLASSIFY']);
    expect(sim.acct.lots.unc).toEqual({ AAPL: 10 });
    sim.runUntil('2027-01-04');
    const blocked = sim.preOpen()!;
    expect(blocked.title).toContain('月報暫停');
    expect(sim.acct.monthlyBlocked).toBe(true);
    const c = s.created[0];
    // AAPL 不在動能名單上 → 不能歸動能
    const bad = classify(sim.acct, sim.pre, c.id, { bucket: 'mom' });
    expect(bad.error).toContain('只能歸自選');
    const ok = classify(sim.acct, sim.pre, c.id, { bucket: 'own', reason: '想長期持有' });
    sim.acct = ok.acct;
    expect(ok.monthlyUnblocked).toBe(true);
    expect(sim.acct.lots.own.AAPL).toBe(10);
    expect(sim.acct.own.AAPL).toMatchObject({ origin: 'MANUAL' });
    expect(sim.acct.own.AAPL.premises[0].text).toBe('想長期持有');
    // 分類後重算月報
    const again = sim.preOpen()!;
    expect(again.title).not.toContain('暫停');
  });

  it('清單外買進的股票在當月動能名單上、那一格還沒買足 → 可以歸動能', () => {
    const sc = scenarios.s1();
    const sim = new Sim(sc.market, sc.init, { vetoes: { '2026-12': ['APP'] } });
    sim.runUntil('2026-12-01');
    const n = sim.preOpen()!;
    const ge = item(n, 'F1', 'GE');
    sim.respond(n.id, { mode: 'DO', choices: { [ge.key]: 'SKIP' } }); // GE 這次沒買
    sim.open();
    sim.close();
    sim.d++;
    const s = sim.open({ GE: 15 })!; // 後來自己買了 15 股
    const r = classify(sim.acct, sim.pre, s.created[0].id, { bucket: 'mom' });
    expect(r.error).toBeUndefined();
    expect(r.acct.lots.mom.GE).toBe(15);
    expect(r.acct.mom.owe.GE).toBeUndefined();
  });

  it('入金遇到月報日：月報還沒回覆 → 重算並取代月報清單；已經回覆 → 另給一份入金清單（定案後的規則）', () => {
    const sc = scenarios.s1();
    const a = new Sim(sc.market, sc.init, { vetoes: { '2026-12': ['APP'] } });
    a.runUntil('2026-12-01');
    const n = a.preOpen()!;
    const r = deposit(a.acct, a.pre, 10000);
    expect(r.mergedIntoMonthly).toBe(true);
    expect(r.acct.notifs.find((x) => x.id === n.id)!.status).toBe('SUPERSEDED');
    expect(r.notif.kind).toBe('MONTHLY');
    // 一份清單同時有月報的單和入金
    expect(has(r.notif, 'F2', 'ORCL')).toBe(true);
    expect(has(r.notif, 'F11')).toBe(true);
    expect(r.acct.notifs.filter((x) => x.status === 'PENDING')).toHaveLength(1);
    // 入金後的總資產變大 → GE 買得比原本多
    expect(sharesOf(item(r.notif, 'F1', 'GE'))).toBeGreaterThan(sharesOf(item(n, 'F1', 'GE')));

    const b = new Sim(sc.market, sc.init, { vetoes: { '2026-12': ['APP'] } });
    b.runUntil('2026-12-01');
    const m = b.preOpen()!;
    b.respond(m.id);
    const r2 = deposit(b.acct, b.pre, 10000);
    expect(r2.mergedIntoMonthly).toBe(false);
    expect(r2.notif.kind).toBe('CASHFLOW');
    expect(r2.acct.notifs.find((x) => x.id === m.id)!.status).toBe('RESPONDED');
  });
});

describe('情境 ⑥ 動能落後＋波動度減碼＋策略檢討', () => {
  it('1 月依波動度減碼 1 → 2/3（減下來的進核心）；2 月遲滯擋下再減一格', () => {
    const sc = scenarios.s6();
    const sim = new Sim(sc.market, sc.init, { sigmaMedianFactor: 1.05 });
    sim.runUntil('2027-01-04');
    const r1 = monthlyReport(sim.acct, sim.pre, { order: ranksAt(sim.market, sim.d - 1), month: '2027-01' });
    // σ̃/σ = 0.63：原始格子是 1/3，但加了 0.10 緩衝（0.73）還在 2/3 那一格 → 這個月只降一格
    expect(r1.plan!.vol!.ratio).toBeGreaterThan(0.6);
    expect(r1.plan!.vol!.ratio).toBeLessThan(2 / 3);
    expect(r1.plan!.vol!.rawCell).toBeCloseTo(1 / 3, 12);
    expect(r1.acct.rule.volW).toBeCloseTo(2 / 3, 12);
    const f4 = item(r1.notif, 'F4');
    for (const t of ['PLTR', 'AVGO', 'NFLX', 'AMD']) expect(f4.choices[0].lines.find((l) => l.ticker === t)!.shares).toBeLessThan(0);
    expect(listOf(r1.notif).find((x) => x.includes('VOO'))).toMatch(/^買 VOO/); // 減下來的交給核心，不是現金
    sim.acct = r1.acct;
    sim.respond(r1.notif.id);
    sim.open();
    sim.close();
    sim.d++;
    sim.runUntil('2027-02-01');
    const r2 = monthlyReport(sim.acct, sim.pre, { order: ranksAt(sim.market, sim.d - 1), month: '2027-02' });
    // 原始格子掉到 1/3，但 σ̃/σ + 0.10 還在 2/3 那一格 → 維持 2/3，本月不用動
    expect(r2.plan!.vol!.rawCell).toBeCloseTo(1 / 3, 12);
    expect(r2.plan!.vol!.blockedByHysteresis).toBe(true);
    expect(r2.acct.rule.volW).toBeCloseTo(2 / 3, 12);
    expect(has(r2.notif, 'F4')).toBe(false);
  });

  it('策略檢討：落後到 -40% 提醒一次（不附清單、不自動停用）；每滿一年提醒；創新高時事件結束', () => {
    // 情境開始時已經在一次落後事件中：-32%，20% 與 30% 已經提醒過
    let st: StrategyReviewState = { ...initialReviewState(), rel: 0.68, peak: 1, eventStart: '2026-07-01', notified: [-0.2, -0.3] };
    const alerts: string[] = [];
    const sc = scenarios.s6();
    const m = sc.market;
    const model = ['PLTR', 'AVGO', 'NFLX', 'AMD', 'ORCL'];
    for (let i = m.idx0; i < m.days.length; i++) {
      const r = model.reduce((a, t) => a + m.close[t][i] / m.close[t][i - 1] - 1, 0) / model.length;
      const b = m.close.VOO[i] / m.close.VOO[i - 1] - 1;
      const x = stepStrategyReview(st, m.days[i], r, b);
      st = x.state;
      alerts.push(...x.alerts.map((a) => `${m.days[i]} ${a}`));
    }
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain('落後超過 40%');
    expect(st.notified).toEqual([-0.2, -0.3, -0.4]);
    // 滿一年
    const y = stepStrategyReview(st, '2027-07-02', 0, 0);
    expect(y.alerts[0]).toContain('已滿 1 年');
    expect(stepStrategyReview(y.state, '2027-07-06', 0, 0).alerts).toEqual([]);
    // 相對表現創新高 → 事件結束
    const end = stepStrategyReview(y.state, '2028-01-03', 1.0, 0);
    expect(end.state.eventStart).toBeNull();
    expect(end.state.notified).toEqual([]);
  });
});

describe('情境 ⑦ 沒照做、忘了、做錯', () => {
  const start = () => {
    const sc = scenarios.s7();
    return new Sim(sc.market, sc.init, { vetoes: { '2026-12': ['APP'] } });
  };
  /** 走到 NVDA 減半的當天通知出現（收盤後），回傳那則通知。 */
  const untilNvda = (sim: Sim): Notif => {
    let urgent: Notif | undefined;
    while (!urgent) sim.day({ afterMonthly: (n) => sim.respond(n.id), afterClose: (c) => (urgent = c.find((n) => n.kind === 'URGENT')) });
    return urgent;
  };

  it('做錯：GE 只買了一部分 → 問「補做差額」或「就這樣」；補做給清單，策略類的差額下個月也會再列', () => {
    const sim = start();
    sim.runUntil('2026-12-01');
    const n = sim.preOpen()!;
    const listed = sharesOf(item(n, 'F1', 'GE'));
    sim.respond(n.id);
    const s = sim.open({ GE: listed - 8 })!;
    expect(s.followUps).toEqual([n.id]);
    const done = sim.acct.notifs.find((x) => x.id === n.id)!;
    expect(done.followUp).toEqual([{ ticker: 'GE', listed, done: listed - 8 }]);
    expect(sim.acct.lots.mom.GE).toBe(listed - 8);
    expect(sim.acct.mom.owe.GE).toBeDefined();
    // 補做差額
    const fix = resolveFollowUp(sim.acct, sim.pre, n.id, true);
    expect(fix.notif!.kind).toBe('FIX');
    expect(sharesOf(fix.notif!.items[0])).toBe(8);
    // 就這樣：差額記影子
    const asIs = resolveFollowUp(sim.acct, sim.pre, n.id, false);
    expect(asIs.notif).toBeNull();
    expect(asIs.acct.shadow.at(-1)).toMatchObject({ choice: 'AS_IS', ticker: 'GE', rule: listed, actual: listed - 8 });
    // 補做清單還沒做，1 月月報又把同一檔重列 → 以月報為準，舊的補做清單取消
    sim.acct = fix.acct;
    sim.close();
    sim.d++;
    sim.runUntil('2027-01-04', { afterClose: (c) => c.filter((x) => x.kind === 'URGENT').forEach((x) => sim.respondAfterClose(x.id, { mode: 'SKIP' })) });
    const jan = sim.preOpen()!;
    expect(sharesOf(item(jan, 'F17', 'GE'))).toBeGreaterThan(0);
    const oldFix = sim.acct.notifs.find((x) => x.id === fix.notif!.id)!;
    expect(oldFix.items[0].cancelled).toBe(true);
    expect(oldFix.status).toBe('READ');
  });

  it('差 1 股以內不算做錯', () => {
    const sim = start();
    sim.runUntil('2026-12-01');
    const n = sim.preOpen()!;
    const listed = sharesOf(item(n, 'F1', 'GE'));
    sim.respond(n.id);
    expect(sim.open({ GE: listed - 1 })!.followUps).toEqual([]);
  });

  it('忘了：2 個交易日沒回報 → 提醒一次；狀態反轉前回覆 → 用當天價格重算', () => {
    const sim = start();
    const urgent = untilNvda(sim);
    const it7 = item(urgent, 'F7', 'NVDA');
    expect(sharesOf(it7)).toBe(-35);
    const day0 = sim.d;
    const reminders: Notif[] = [];
    while (sim.d < day0 + 3) sim.day({ afterClose: (c) => reminders.push(...c.filter((x) => x.kind === 'INFO')) });
    expect(reminders).toHaveLength(1);
    expect(reminders[0].ref).toBe(urgent.id);
    expect(reminders[0].seq - urgent.seq).toBe(2);
    while (sim.d < day0 + 6) sim.day({ afterClose: (c) => reminders.push(...c.filter((x) => x.kind === 'INFO')) });
    expect(reminders).toHaveLength(1); // 只提醒一次
    // 晚回覆「忘了」：還是 35 股（減半看的是當時股數），但註明用今天的價格重算
    sim.respond(urgent.id);
    const n = sim.acct.notifs.find((x) => x.id === urgent.id)!;
    expect(n.status).toBe('RESPONDED');
    expect(item(n, 'F7', 'NVDA').note).toContain('重算');
    sim.open();
    expect(sim.acct.lots.own.NVDA).toBe(35);
  });

  it('忘了：期間規則狀態已經反轉（符合加回）→ 補做清單取消，不賣也不買', () => {
    const sim = start();
    const urgent = untilNvda(sim);
    while (sim.acct.own.NVDA.slow.state === 'HALF' && !sim.atEnd()) sim.day({ afterMonthly: (n) => sim.respond(n.id) });
    expect(sim.acct.own.NVDA.slow.state).toBe('STD'); // 反彈後符合加回條件
    sim.respond(urgent.id);
    const n = sim.acct.notifs.find((x) => x.id === urgent.id)!;
    expect(item(n, 'F7', 'NVDA').cancelled).toBe(true);
    expect(n.status).toBe('SKIPPED');
    expect(sim.acct.lots.own.NVDA).toBe(70);
    expect(sim.acct.rule.own.NVDA.applied).toBe('STD');
    expect(sim.acct.own.NVDA.pending).toBeNull();
    // 之後的月報不會出現 NVDA 的加回
    while (!sim.atEnd()) sim.day({ afterMonthly: (m) => expect(m.items.some((i) => i.ticker === 'NVDA')).toBe(false) });
  });

  it('自選慢規則「這次不做」：規則狀態照樣前進、不再提醒；之後加回時以實際股數為準', () => {
    const sim = start();
    const urgent = untilNvda(sim);
    sim.respond(urgent.id, { mode: 'SKIP' });
    expect(sim.acct.notifs.find((x) => x.id === urgent.id)!.status).toBe('SKIPPED');
    expect(sim.acct.rule.own.NVDA.applied).toBe('HALF');
    expect(sim.acct.shadow.at(-1)).toMatchObject({ f: 'F7', ticker: 'NVDA', rule: -35, actual: 0 });
    const later: Notif[] = [];
    while (!sim.atEnd()) sim.day({ afterMonthly: (m) => (sim.respond(m.id), later.push(m)), afterClose: (c) => later.push(...c) });
    // 沒有提醒、沒有再叫你減半；加回時目前股數已經高於標準比重 → 不用買
    expect(later.some((n) => n.kind === 'INFO' && n.ref === urgent.id)).toBe(false);
    expect(later.some((n) => n.items.some((i) => i.ticker === 'NVDA' && i.choices[0].lines.length > 0))).toBe(false);
    expect(sim.acct.lots.own.NVDA).toBe(70);
  });
});
