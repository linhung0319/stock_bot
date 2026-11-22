// T86 修正（其餘，階段十二）：走一遍找到的其餘小問題 P2～P10、P12～P15（P1、P11 在 t86-relist.test.ts）。
// 走一遍的紀錄：docs/test-records/t86_walkthrough_2026-11-23.md；設計 docs/design/allocation_redesign_2026-11-22.md（各項寫了「T86 修正」）。
//   P2（首頁不用回覆）、P3（標準比重上限）、P10（採用草稿不動加碼條件）、P7（chart 線名）、P12（文字）分別在 t82、t34、t85、t84 與這裡。
//   這個檔案放：P4 出金與改比例的說明、P5／P12e 月報文字、P6 帳戶頁現金列、P7 圖例、P8 日期、P9 快照不問補做、P12 零碎、P13 F23 說明、P14 LINE 價格警告、P15 對照。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { corePriceWarn } from '../src/app/line';
import { explainItem, type ExplainContext } from '../src/app/site/explain';
import { accountView, buyBlockedText, chartOf } from '../src/app/site/views';
import { applySnapshot, changeRatio, monthlyReport, priceOf, respond, totalValue, withdraw, type Account, type BucketShares, type MarketView, type Notif } from '../src/engine';
import type { OrderLine } from '../src/engine/orders';
import { ranksAt } from './helpers/market';
import { scenarios } from './helpers/scenarios';
import { Sim } from './helpers/sim';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(HERE, '..', rel), 'utf8');

const calm = (core: Record<string, number> = {}): Sim => {
  const sc = scenarios.s5();
  const sim = new Sim(sc.market, { ...sc.init, ...(Object.keys(core).length ? { core } : {}) });
  sim.runUntil('2026-12-10');
  return sim;
};
const ctxOf = (acct: Account, view: MarketView): ExplainContext => ({ acct, view, axis: [], rankOrder: [], aiNotes: [] });
type Ready = Parameters<typeof accountView>[0];
const ready = (sim: Sim): Ready => ({ mode: 'demo', acct: sim.acct, view: sim.pre, axis: sim.market.days.slice(0, sim.d), rankOrder: [], rankSession: null, aiNotes: [], events: [], shadow: [], today: sim.date, warnings: [] }) as Ready;
const linesOf = (n: Notif): OrderLine[] => (n.composed ?? n.preview)!.lines;

describe('T86 P4：出金與改比例清單每一檔的說明', () => {
  it('出金：「目前」用出金後的總資產當分母（和「目標」同一個分母）；不會看起來低於目標還在賣', () => {
    const sim = calm();
    const view = sim.pre;
    const total = totalValue(sim.acct, view);
    const amt = Math.round(total * 0.1);
    const w = withdraw(sim.acct, view, amt);
    const facts = explainItem(ctxOf(w.acct, view), w.notif, w.notif.items[0]).facts!;
    const NAME = { own: '自選', mom: '動能', core: '核心' } as const;
    const sells = linesOf(w.notif).filter((l) => l.bucket !== 'core' && l.shares < 0 && l.reason !== '單檔上限');
    expect(sells.length).toBeGreaterThan(0);
    for (const l of sells) {
      const f = facts.find((x) => x.label === `${NAME[l.bucket]} ${l.ticker}`)!;
      const m = /^目前 ([\d.]+)%，目標 ([\d.]+)%$/.exec(f.note ?? '');
      expect(m, f.note).not.toBeNull();
      const expectCur = (((w.acct.lots[l.bucket][l.ticker] ?? 0) * priceOf(view, l.ticker)) / (total - amt)) * 100;
      expect(Number(m![1])).toBeCloseTo(expectCur, 1);
    }
  });

  it('改比例：自選的股數照比例放大，寫「股數照比例 30 → 45」，不寫「目前 7.5%，目標 7.5%」', () => {
    const sim = calm();
    const view = sim.pre;
    const r = sim.acct.cfg.ratio;
    const c = changeRatio(sim.acct, view, { own: r.own + 0.1, strat: r.strat - 0.1, core: r.core });
    const facts = explainItem(ctxOf(c.acct, view), c.notif, c.notif.items[0]).facts!;
    const own = linesOf(c.notif).filter((l) => l.bucket === 'own' && l.shares > 0);
    expect(own.length).toBeGreaterThan(0);
    for (const l of own) {
      const have = c.acct.lots.own[l.ticker] ?? 0;
      expect(facts.find((x) => x.label === `自選 ${l.ticker}`)!.note).toBe(`股數照比例 ${have} → ${have + l.shares}`);
    }
  });
});

describe('T86 P5、P12e：核心比例調回的理由不猜原因；月報狀態行寫明是其他單做完之後', () => {
  it('F26 的理由只寫事實與方向；狀態行寫「這份月報其他單做完之後」、動能寫「動能部位全額」', () => {
    const sim = calm({ VOO: 64 });
    sim.runUntil('2027-01-04');
    const jan = sim.preOpen()!;
    const f26 = jan.items.find((i) => i.f === 'F26')!;
    expect(f26.why).toMatch(/SGOV 那一邊占核心 [\d.]+%，低於 15%，調回 20%：賣 VOO、買 SGOV。$/);
    expect(f26.why).not.toMatch(/漲多了|跌多了/);
    expect(jan.text).toMatch(/^核心：SGOV 與現金 [\d.]+%（這份月報其他單做完之後，/);
    expect(jan.text).toMatch(/；動能部位(全額| \d\/3)$/);
    expect(jan.text).not.toContain('動能比例');
  });
});

describe('T86 P6：帳戶頁現金那一列', () => {
  it('寫「算在 SGOV 那一邊；月報有其他單時順便買成 SGOV」，不再說「交給核心」', () => {
    const sim = calm();
    const a = accountView(ready(sim));
    const cash = a.holdings.find((h) => h.ticker === '現金')!;
    expect(cash.detail).toBe('算在 SGOV 那一邊（核心的兩成連同帳上現金）；月報有其他單時順便買成 SGOV');
  });
});

describe('T86 P7：有論點的股票走勢圖那條線叫「審查線」，只有預設前提的叫「減半線」', () => {
  it('chartOf.lineName；圖例與滑過的提示用它', () => {
    const sim = calm();
    const d = ready(sim);
    const kinds = Object.keys(sim.acct.own).map((t) => [t, sim.acct.own[t].premises.some((p) => p.origin !== 'SYSTEM_DEFAULT')] as const);
    for (const [t, thesis] of kinds) {
      const c = chartOf(d, t, 100);
      if (c) expect(c.lineName, t).toBe(thesis ? '審查線' : '減半線');
    }
    const js = read('public/js/parts.js');
    expect(js).toContain("c.lineName ?? '減半線'");
    expect(js).not.toContain("'減半線（52 週高點 −20%）'");
  });

  it('使用者看得到的名稱：AI 紀錄的功能名稱、持股頁的歷次審查寫「跌幅審查」', () => {
    expect(read('src/ai/functions.ts')).toContain("label: '自選跌幅審查'");
    expect(read('src/app/thesis.ts')).toContain("OWN_DROP: '跌幅審查'");
    expect(read('src/app/ownDraft.ts')).toContain("OWN_DROP: '跌幅審查'");
    expect(read('src/ai/discussion.ts')).toContain("慢規則減半: '跌幅審查'");
  });
});

describe('T86 P12b：「但」後面接日期時補空白', () => {
  it('buyBlockedText', () => {
    const meta = { buyBlocked: { date: '2026-12-10', what: '補滿', text: '11/25 有前提被判不成立' } };
    expect(buyBlockedText(meta, '補滿', '2026-12-10')).toContain('但 11/25 有前提');
    const add = { buyBlocked: { date: '2026-12-10', what: '加碼', text: '12/10 有前提被判不成立' } };
    expect(buyBlockedText(add, '加碼', '2026-12-10')).toContain('但 12/10 有前提');
    const cn = { buyBlocked: { date: '2026-12-10', what: '補滿', text: '這檔在減半中' } };
    expect(buyBlockedText(cn, '補滿', '2026-12-10')).toContain('但這檔在減半中');
  });
});

describe('T86 P9：月報照做、只差核心 SGOV（錢還在帳上）→ 快照比對不問補做差額', () => {
  function december() {
    const sc = scenarios.s1();
    const sim = new Sim(sc.market, sc.init, { vetoes: { '2026-12': ['APP'] } });
    sim.runUntil('2026-12-01');
    const m = sim.preOpen()!;
    sim.respond(m.id);
    return { sim, m: sim.acct.notifs.find((x) => x.id === m.id)! };
  }
  /** 照清單做完的快照；extra：核心桶多做（負數 = 少做）的股數。 */
  function filled(acct: Account, view: MarketView, n: Notif, extra: Record<string, number>) {
    const lots: BucketShares = { own: { ...acct.lots.own }, mom: { ...acct.lots.mom }, core: { ...acct.lots.core } };
    let cash = acct.cash;
    const add = (b: 'own' | 'mom' | 'core', t: string, q: number) => {
      lots[b][t] = (lots[b][t] ?? 0) + q;
      cash -= q * priceOf(view, t);
    };
    for (const l of linesOf(n)) if (l.shares) add(l.bucket, l.ticker, l.shares);
    for (const [t, q] of Object.entries(extra)) add('core', t, q);
    const shares: Record<string, number> = {};
    for (const b of ['own', 'mom', 'core'] as const) for (const [t, q] of Object.entries(lots[b])) if (q) shares[t] = (shares[t] ?? 0) + q;
    return { shares, lots, cash };
  }

  it('SGOV 沒買或只買一部分：不問；VOO 沒買、SGOV 買過頭：照舊問', () => {
    const { sim, m } = december();
    const view = sim.pre;
    const bond = sim.acct.bondTicker;
    const sgov = linesOf(m).filter((l) => l.bucket === 'core' && l.ticker === bond).reduce((a, l) => a + l.shares, 0);
    const voo = linesOf(m).filter((l) => l.bucket === 'core' && l.ticker === sim.acct.cfg.coreTicker).reduce((a, l) => a + l.shares, 0);
    expect(sgov).toBeGreaterThan(2);
    expect(voo).toBeGreaterThan(2);
    // 忘了買 SGOV：整份完成、沒有問題
    const none = applySnapshot(sim.acct, view, filled(sim.acct, view, m, { [bond]: -sgov }));
    expect(none.completed).toContain(m.id);
    expect(none.followUps).toEqual([]);
    expect(none.acct.notifs.find((n) => n.id === m.id)!.followUp).toBeUndefined();
    // 只買了一部分
    const part = applySnapshot(sim.acct, view, filled(sim.acct, view, m, { [bond]: -(sgov - 1) }));
    expect(part.followUps).toEqual([]);
    // SGOV 買過頭：照舊問
    const over = applySnapshot(sim.acct, view, filled(sim.acct, view, m, { [bond]: 5 }));
    expect(over.followUps).toEqual([m.id]);
    // VOO 沒買：照舊問，而且只問 VOO
    const noVoo = applySnapshot(sim.acct, view, filled(sim.acct, view, m, { [sim.acct.cfg.coreTicker]: -voo }));
    expect(noVoo.followUps).toEqual([m.id]);
    expect(noVoo.acct.notifs.find((n) => n.id === m.id)!.followUp!.map((x) => x.ticker)).toEqual([sim.acct.cfg.coreTicker]);
  });
});

describe('T86 P12c：F27 的行原因寫「自選補滿」', () => {
  it('report.ts 的補滿那一行不再是「自選訊號」', () => {
    const src = read('src/engine/report.ts');
    expect(src).toContain("reason: '自選補滿'");
    expect(read('src/engine/types.ts')).toContain("'自選補滿'");
  });
});

describe('T86 P12d：已經列了 F26 時，帳戶頁核心比例那一格不寫「下一份月報會列」', () => {
  it('還沒回覆的月報有 F26 → 寫「這份月報已經列了一項調回，回覆後照做」', () => {
    const sim = calm({ VOO: 64 });
    sim.runUntil('2027-01-04');
    const before = accountView(ready(sim)).status.find((s) => s.label === '核心比例')!;
    expect(before.detail).toContain('下一份月報會列一項調回');
    sim.preOpen();
    const after = accountView(ready(sim)).status.find((s) => s.label === '核心比例')!;
    expect(after.detail).toContain('這份月報已經列了一項調回，回覆後照做');
    expect(after.detail).not.toContain('下一份月報會列');
  });
});

describe('T86 P13：F23「提高到 125%」不做的說明', () => {
  it('不寫「不做就不再提醒」；寫之後的審查仍可能再提、12 個月只在照做後起算', () => {
    const src = read('src/app/site/explain.ts');
    expect(src).toContain("SKIP: raise ? SKIP.aiRaise : SKIP.ai");
    expect(src).toMatch(/aiRaise: '這一則建議不做就結案，不會催你。但之後的審查如果條件還成立，AI 可能再提一次；「每 12 個月最多一次」只在你照做之後才起算/);
  });
});

describe('T86 P14：核心價格和基準對不上時，有 F26 的月報 LINE 也要有「價格資料可能有誤」那一行', () => {
  const n = (items: { f: string; cancelled?: boolean; relist?: boolean }[], codes = ['DAY_GAP']) => ({ kind: 'MONTHLY' as const, items: items as never, monthly: { input: { coreCheck: codes } } as never });
  it('corePriceWarn 認 F26（沒取消的）；沒有 DAY_GAP 或只有別的項目不算', () => {
    expect(corePriceWarn(n([{ f: 'F26' }]))).toBe(true);
    expect(corePriceWarn(n([{ f: 'F26', cancelled: true }]))).toBe(false);
    expect(corePriceWarn(n([{ f: 'F26' }], ['BOND_JUMP']))).toBe(false);
    expect(corePriceWarn(n([{ f: 'F2' }]))).toBe(false);
    expect(corePriceWarn(n([{ f: 'F5' }]))).toBe(true); // 舊通知照舊
  });

  it('月報產生時 F26 項目帶 coreNote（股數是照這個價格算的）', () => {
    const sim = calm({ VOO: 64 });
    sim.runUntil('2027-01-04');
    const note = 'VOO 的價格和 SPY 對不上（測試）';
    const r = monthlyReport(sim.acct, sim.pre, { order: ranksAt(sim.market, sim.d - 1, []), month: sim.month, coreCheck: ['DAY_GAP'], coreNote: note });
    const f26 = r.notif.items.find((i) => i.f === 'F26')!;
    expect(f26.note).toContain(note);
    expect(corePriceWarn(r.notif)).toBe(true);
    // 沒有對不上時不加
    const ok = monthlyReport(sim.acct, sim.pre, { order: ranksAt(sim.market, sim.d - 1, []), month: sim.month });
    expect(ok.notif.items.find((i) => i.f === 'F26')!.note ?? '').not.toContain('對不上');
    expect(respond).toBeTypeOf('function');
  });
});

describe('T86 P15：一鍵採用對照上，已經成立的財報門檻進場條件寫「採用後直接成立」', () => {
  it('thesis-draft.js 的對照：metNow 的新增條件不寫「採用後監測中」；api 把 metNow 帶給前端', () => {
    const js = read('public/js/thesis-draft.js');
    expect(js).toContain("x.metNow ? '現在已經成立：採用後直接成立，下一份月報會列進場'");
    expect(read('src/app/site/api.ts')).toContain("...(x.metNow ? { metNow: true } : {})");
  });
});
