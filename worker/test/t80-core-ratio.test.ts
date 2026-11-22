// T80（階段十二）：核心固定比例（docs/design/allocation_redesign_2026-11-22.md §1.1～§1.5、§2.1、§2.2）。
//   coreSplit：整股的零頭、SGOV 是 0、現金大於需求、一邊不夠另一邊補
//   coreBandCheck／coreBandLines：界線內不動、超出才調回
//   composeWithCore：進出核心照 80：20、月報才把帳上原本的現金買成短債、入金的錢算新進核心的
//   planDay：動能只依波動度減碼、入金剩下的照比例、出金的新順序；舊路徑（legacyCrash）留給重放
//   月報的 F26：合成其他單之後算、可以單獨成單、不用理由、沒做靠下個月重算；晚回覆重算；有 F26 時回調不受搭便車限制
//   舊帳戶資料（0.17.0 的樣本）讀進來不壞；動能空格（月中提早出場 → 錢進核心 80：20 → 下一份月報遞補）
// 市場是可重現的假資料；帳戶是示範帳戶。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { afterFact, coreLineWhy, explainItem, type ExplainContext } from '../src/app/site/explain';
import { notifView } from '../src/app/site/views';
import {
  CASH,
  CORE_BAND_BACK_NOTE,
  CORE_SWITCH_NOTE,
  DEFAULT_CONFIG,
  bucketValue,
  cellKey,
  composeWithCore,
  coreBandCheck,
  coreBandLines,
  coreCfg,
  coreSplit,
  createAccount,
  deposit,
  emptyRuleState,
  hardEvent,
  migrateAccount,
  missingReasons,
  momSlotTarget,
  monthlyReport,
  normRule,
  planDay,
  priceOf,
  respond,
  totalValue,
  withdraw,
  type Account,
  type CellMap,
  type CoreContext,
  type EngineConfig,
  type Item,
  type MarketView,
  type Notif,
  type OrderLine,
  type RuleState,
} from '../src/engine';
import { ranksAt, viewAt } from './helpers/market';
import { scenarios } from './helpers/scenarios';
import { Sim } from './helpers/sim';

const HERE = dirname(fileURLToPath(import.meta.url));
const cfg: EngineConfig = { ...DEFAULT_CONFIG };
const item = (n: Notif, f: string, ticker?: string): Item => n.items.find((i) => i.f === f && (!ticker || i.ticker === ticker))!;
const lineOf = (lines: OrderLine[], ticker: string, bucket = 'core') => lines.filter((l) => l.ticker === ticker && l.bucket === bucket).reduce((a, l) => a + l.shares, 0);

/** 短債那一邊（SGOV＋帳上現金）占核心的比例。 */
function bondShare(acct: Account, view: MarketView): number {
  const core = bucketValue(acct, view, 'core');
  return ((acct.lots.core[acct.bondTicker] ?? 0) * priceOf(view, acct.bondTicker) + acct.cash) / core;
}

// ---------------------------------------------------------------- 純函式

describe('T80 coreSplit：錢進出核心怎麼分（§1.2）', () => {
  const px = { priceCore: 550, priceBond: 100, bond: 0.2 };

  it('進核心：八成買核心 ETF、兩成買短債，各自無條件捨去；配不到整股的零頭留在帳上', () => {
    // 設計的例子：$500 進核心 → SGOV 1 股＋現金 $400
    expect(coreSplit({ amount: 500, ...px })).toEqual({ core: 0, bond: 1, cashUsed: 0, short: 0 });
    // $1,200 → VOO 1 股（$960 ÷ 550）、SGOV 2 股（$240 ÷ 100），零頭 $450 留現金
    expect(coreSplit({ amount: 1200, ...px })).toEqual({ core: 1, bond: 2, cashUsed: 0, short: 0 });
    // 短債一股比兩成還貴 → 一股都買不到
    expect(coreSplit({ amount: 500, ...px, priceBond: 100.4 })).toMatchObject({ core: 0, bond: 0 });
    expect(coreSplit({ amount: 0, ...px })).toEqual({ core: 0, bond: 0, cashUsed: 0, short: 0 });
  });

  it('從核心拿：短債出兩成（四捨五入到整股）、其餘賣核心 ETF（進位到夠用）', () => {
    const r = coreSplit({ amount: -5000, ...px, coreShares: 100, bondShares: 100, cash: 0 });
    expect(r).toEqual({ core: -8, bond: -10, cashUsed: 0, short: 0 });
    // 賣得的錢一定夠，多出來的不到一股核心 ETF
    const got = 8 * 550 + 10 * 100;
    expect(got).toBeGreaterThanOrEqual(5000);
    expect(got - 5000).toBeLessThan(550);
    // 兩成不到半股短債 → 短債不賣，全部由核心 ETF 出（不會多一行很小的單）
    expect(coreSplit({ amount: -200, ...px, coreShares: 100, bondShares: 100, cash: 0 })).toEqual({ core: -1, bond: 0, cashUsed: 0, short: 0 });
  });

  it('從核心拿：帳上現金先用，而且算在短債那一邊該出的份裡', () => {
    // 現金 $600 < 兩成（$1,000）→ 短債只補 $400；其餘 $4,000 賣核心 ETF
    expect(coreSplit({ amount: -5000, ...px, coreShares: 100, bondShares: 100, cash: 600 })).toEqual({ core: -8, bond: -4, cashUsed: 600, short: 0 });
    // 現金 $2,000 已經超過兩成 → 短債不賣；剩下 $3,000 賣核心 ETF
    expect(coreSplit({ amount: -5000, ...px, coreShares: 100, bondShares: 100, cash: 2000 })).toEqual({ core: -6, bond: 0, cashUsed: 2000, short: 0 });
  });

  it('現金大於需求：兩檔都不用賣', () => {
    expect(coreSplit({ amount: -5000, ...px, coreShares: 100, bondShares: 100, cash: 6000 })).toEqual({ core: 0, bond: 0, cashUsed: 5000, short: 0 });
    expect(coreSplit({ amount: -5000, ...px, coreShares: 100, bondShares: 100, cash: 5000 })).toEqual({ core: 0, bond: 0, cashUsed: 5000, short: 0 });
  });

  it('SGOV 是 0：不夠的那一份由核心 ETF 補，不因此多開一張單', () => {
    expect(coreSplit({ amount: -5000, ...px, coreShares: 100, bondShares: 0, cash: 0 })).toEqual({ core: -10, bond: 0, cashUsed: 0, short: 0 });
  });

  it('核心 ETF 不夠賣：不夠的由短債補；兩邊都賣光還不夠 → short 是還缺的金額', () => {
    // VOO 只有 2 股（$1,100）：短債先出 10 股，再補 29 股（$2,900）
    expect(coreSplit({ amount: -5000, ...px, coreShares: 2, bondShares: 100, cash: 0 })).toEqual({ core: -2, bond: -39, cashUsed: 0, short: 0 });
    const r = coreSplit({ amount: -5000, ...px, coreShares: 2, bondShares: 20, cash: 0 });
    expect(r).toMatchObject({ core: -2, bond: -20 });
    expect(r.short).toBeCloseTo(5000 - 1100 - 2000, 9);
  });
});

describe('T80 coreBandCheck：界線檢查（§1.3）', () => {
  it('15%～25% 之內不動；超出才調回 20%，move 是短債那一邊要增減的金額', () => {
    expect(coreBandCheck(10000, 50000, cfg)).toMatchObject({ s: 0.2, out: false, move: 0, bond: 0.2, band: 0.05 });
    expect(coreBandCheck(8000, 50000, cfg).out).toBe(false); // 16%
    expect(coreBandCheck(12000, 50000, cfg).out).toBe(false); // 24%
    const low = coreBandCheck(7000, 50000, cfg); // 14%
    expect(low.out).toBe(true);
    expect(low.move).toBeCloseTo(3000, 9);
    const high = coreBandCheck(13000, 50000, cfg); // 26%
    expect(high.out).toBe(true);
    expect(high.move).toBeCloseTo(-3000, 9);
  });

  it('設計的例子：股票跌 30% → VOO $28,000、SGOV $10,000，s = 26.3% → 短債那一邊減 $2,400', () => {
    const c = coreBandCheck(10000, 38000, cfg);
    expect(c.s).toBeCloseTo(0.263, 3);
    expect(c.out).toBe(true);
    expect(c.move).toBeCloseTo(-2400, 9);
  });

  it('核心是 0 不算超出；舊帳戶的設定沒有 coreBond、coreBand 時用預設', () => {
    expect(coreBandCheck(0, 0, cfg)).toMatchObject({ s: 0, out: false, move: 0 });
    expect(coreCfg({})).toEqual({ bond: 0.2, band: 0.05 });
    expect(coreBandCheck(0, 50000, {}).move).toBeCloseTo(10000, 9);
  });
});

describe('T80 coreBandLines：F26 的行（§1.3）', () => {
  const price = (t: string) => (t === 'VOO' ? 400 : 100);
  const base = { cfg, price, bondTicker: 'SGOV' };

  it('短債那一邊太多（股票跌多了）：賣 SGOV、買 VOO；買單留 98% 的緩衝', () => {
    // VOO 70 股 $28,000、SGOV 100 股 $10,000 → 要買 VOO $2,400 = 6 股；賣 SGOV ceil(2400 ÷ 0.98 ÷ 100) = 25 股
    const { check, lines } = coreBandLines({ ...base, cash: 0, coreShares: 70, bondShares: 100 });
    expect(check.out).toBe(true);
    expect(lines).toEqual([
      { ticker: 'SGOV', bucket: 'core', shares: -25, reason: '核心比例' },
      { ticker: 'VOO', bucket: 'core', shares: 6, reason: '核心比例' },
    ]);
    // 做完之後回到界線內
    expect(coreBandCheck(75 * 100 + (2500 - 2400), 76 * 400 + 75 * 100 + 100, cfg).out).toBe(false);
  });

  it('短債那一邊太多但大多是現金：先用現金，SGOV 少賣', () => {
    const { lines } = coreBandLines({ ...base, cash: 2000, coreShares: 70, bondShares: 80 });
    // s = (8000 + 2000) ÷ 38000 = 26.3%；買 VOO 6 股要 $2,400 ÷ 0.98 = $2,449，現金 $2,000 → SGOV 賣 5 股
    expect(lines).toEqual([
      { ticker: 'SGOV', bucket: 'core', shares: -5, reason: '核心比例' },
      { ticker: 'VOO', bucket: 'core', shares: 6, reason: '核心比例' },
    ]);
  });

  it('短債那一邊太少（核心幾乎全是 VOO）：賣 VOO、買 SGOV，帳上現金一起買', () => {
    // VOO 125 股 $50,000、現金 $1,500 → s = 2.9%；目標 $10,300 → 賣 VOO round(8800 ÷ 400) = 22 股，買 SGOV floor(0.98 × (8800 + 1500) ÷ 100) = 100 股
    const { check, lines } = coreBandLines({ ...base, cash: 1500, coreShares: 125, bondShares: 0 });
    expect(check.s).toBeCloseTo(1500 / 51500, 9);
    expect(lines).toEqual([
      { ticker: 'VOO', bucket: 'core', shares: -22, reason: '核心比例' },
      { ticker: 'SGOV', bucket: 'core', shares: 100, reason: '核心比例' },
    ]);
  });

  it('界線內：沒有行', () => {
    expect(coreBandLines({ ...base, cash: 500, coreShares: 100, bondShares: 95 }).lines).toEqual([]);
  });
});

// ---------------------------------------------------------------- composeWithCore

describe('T80 composeWithCore：核心吸收差額照 80：20（§1.2）', () => {
  const price = (t: string) => ({ VOO: 550, SGOV: 100, AAA: 50 })[t] ?? 1;
  const ctx = (o: Partial<CoreContext> = {}): CoreContext => ({ cfg, price, cash: 0, coreShares: 80, bondShares: 100, bondTicker: 'SGOV', total: 100000, ...o });
  const sell = (n: number): OrderLine => ({ ticker: 'AAA', bucket: 'mom', shares: -n, reason: '動能換股' });
  const buy = (n: number): OrderLine => ({ ticker: 'AAA', bucket: 'mom', shares: n, reason: '動能換股' });

  it('清單做完多出的錢：VOO 八成、SGOV 兩成；金額不到總資產 0.25% 的那一行不列，錢留在帳上', () => {
    // 賣得 $5,000，留 2% 緩衝 → $4,900：VOO floor(3920 ÷ 550) = 7、SGOV floor(980 ÷ 100) = 9
    const c = composeWithCore([sell(100)], ctx());
    expect(lineOf(c.lines, 'VOO')).toBe(7);
    expect(lineOf(c.lines, 'SGOV')).toBe(9);
    expect(c.lines.filter((l) => l.bucket === 'core').every((l) => l.reason === '錢交給核心（VOO 八成、SGOV 兩成）')).toBe(true);
    expect(c.cashAfter).toBeCloseTo(5000 - 7 * 550 - 9 * 100, 9);
    // 設計 §1.7 的例子：多出 $1,200 左右 → VOO 1 股、SGOV 2 股；SGOV 那一行 $200 不到 $250（總資產 0.25%）→ 不列
    const small = composeWithCore([sell(25)], ctx());
    expect(listLines(small.lines)).toEqual(['mom AAA -25', 'core VOO 1']);
    // 更小：一行都沒有
    expect(composeWithCore([sell(10)], ctx()).lines.filter((l) => l.bucket === 'core')).toEqual([]);
  });

  it('帳上原本的現金不照比例分；月報（sweepCash）才順便買成 SGOV，其他清單不動它', () => {
    // 現金 $3,000、賣得 $5,000：緩衝 2% × 8000 = $160；新進核心的 $5,000 照比例，原本的現金（扣掉緩衝）$2,840 月報才買 SGOV
    const monthly = composeWithCore([sell(100)], ctx({ cash: 3000, sweepCash: true }));
    expect(lineOf(monthly.lines, 'VOO')).toBe(7); // floor(4000 ÷ 550)
    expect(lineOf(monthly.lines, 'SGOV')).toBe(38); // floor((1000 + 2840) ÷ 100)
    expect(monthly.lines.filter((l) => l.ticker === 'SGOV').map((l) => [l.shares, l.reason])).toEqual([
      [10, '錢交給核心（VOO 八成、SGOV 兩成）'],
      [28, '帳上的現金買 SGOV'],
    ]);
    const other = composeWithCore([sell(100)], ctx({ cash: 3000 }));
    expect(lineOf(other.lines, 'VOO')).toBe(7);
    expect(lineOf(other.lines, 'SGOV')).toBe(10);
    expect(other.cashAfter).toBeCloseTo(3000 + 5000 - 7 * 550 - 10 * 100, 9);
    // 沒有其他單：月報也不為現金發單
    expect(composeWithCore([], ctx({ cash: 3000, sweepCash: true })).lines).toEqual([]);
  });

  it('入金（fresh）：補完各格剩下的錢照比例進核心', () => {
    // 入金 $10,000、補一格 $2,500；剩 $7,500，扣緩衝 2% × 10000 = $200 → $7,300：VOO floor(5840 ÷ 550) = 10、SGOV floor(1460 ÷ 100) = 14
    const c = composeWithCore([buy(50)], ctx({ cash: 10000, fresh: 10000 }));
    expect(lineOf(c.lines, 'VOO')).toBe(10);
    expect(lineOf(c.lines, 'SGOV')).toBe(14);
    // 沒有要補的格子：全部照比例進核心
    const all = composeWithCore([], ctx({ cash: 10000, fresh: 10000 }));
    expect(lineOf(all.lines, 'VOO')).toBe(14); // floor(9800 × 0.8 ÷ 550)
    expect(lineOf(all.lines, 'SGOV')).toBe(19); // floor(9800 × 0.2 ÷ 100)
    // 買單合計不超過現金的 98%
    expect(14 * 550 + 19 * 100).toBeLessThanOrEqual(0.98 * 10000);
  });

  it('錢不夠：從核心照比例拿，帳上現金先用；賣得的錢夠付買單', () => {
    // 買 $5,000，帳上沒有現金：還缺的 ÷ 0.98 = $5,102 → SGOV round(1020 ÷ 100) = 10、VOO ceil(4102 ÷ 550) = 8
    const c = composeWithCore([buy(100)], ctx());
    expect(lineOf(c.lines, 'SGOV')).toBe(-10);
    expect(lineOf(c.lines, 'VOO')).toBe(-8);
    expect(c.lines.filter((l) => l.bucket === 'core').every((l) => l.reason === '從核心拿錢（VOO 八成、SGOV 兩成）')).toBe(true);
    expect(c.cashAfter).toBeGreaterThanOrEqual(0);
    // 帳上有 $1,500：先用掉，而且算在 SGOV 該出的份裡 → SGOV 不賣，VOO 賣 ceil((3500 ÷ 0.98) ÷ 550) = 7
    const withCash = composeWithCore([buy(100)], ctx({ cash: 1500 }));
    expect(lineOf(withCash.lines, 'SGOV')).toBe(0);
    expect(lineOf(withCash.lines, 'VOO')).toBe(-7);
    // 現金大於需求：核心不用動（非月報也不把剩下的現金買成 SGOV）
    expect(composeWithCore([buy(100)], ctx({ cash: 8000 })).lines.filter((l) => l.bucket === 'core')).toEqual([]);
  });

  it('SGOV 是 0：全部由 VOO 出；出金（reserveCash）沒有其他單也照比例賣', () => {
    const c = composeWithCore([buy(100)], ctx({ bondShares: 0 }));
    expect(lineOf(c.lines, 'SGOV')).toBe(0);
    expect(lineOf(c.lines, 'VOO')).toBe(-10); // ceil(5102 ÷ 550)
    const w = composeWithCore([], ctx({ cash: 200, reserveCash: 10000 }));
    // 要從核心拿 $10,000（現金 $200 先用）；還缺 $9,800 ÷ 0.98 = $10,000 → 總額 $10,200：SGOV round((2040 − 200) ÷ 100) = 18、VOO ceil(8200 ÷ 550) = 15
    expect(lineOf(w.lines, 'SGOV')).toBe(-18);
    expect(lineOf(w.lines, 'VOO')).toBe(-15);
    expect(w.cashAfter).toBeGreaterThanOrEqual(0);
  });

  it('核心兩邊賣光還不夠：買單從最後一行往回減（C14 照舊）', () => {
    const c = composeWithCore([buy(2000)], ctx({ coreShares: 10, bondShares: 10 }));
    expect(c.capped?.[0].ticker).toBe('AAA');
    expect(lineOf(c.lines, 'VOO')).toBe(-10);
    expect(lineOf(c.lines, 'SGOV')).toBe(-10);
    expect(c.cashAfter).toBeGreaterThanOrEqual(0);
  });
});

function listLines(lines: OrderLine[]): string[] {
  return lines.map((l) => `${l.bucket} ${l.ticker} ${l.shares}`);
}

// ---------------------------------------------------------------- planDay（金額模式）

describe('T80 planDay：正式流程的規則（§1.2～§1.4、§2.1）', () => {
  const VOO = cellKey('core', 'VOO');
  const CCASH = cellKey('core', CASH);
  const mom = (t: string) => cellKey('mom', t);
  const own = (t: string) => cellKey('own', t);
  const order30 = Array.from({ length: 30 }, (_, i) => 'R' + (i + 1));
  /** 自選 MU、NVDA 各 10，動能 R1–R5 各 6，核心 VOO 40＋現金格 10（總資產 100）。 */
  function steady(): { values: CellMap; state: RuleState } {
    const values: CellMap = { [own('MU')]: 10, [own('NVDA')]: 10, [VOO]: 40, [CCASH]: 10 };
    for (const t of ['R1', 'R2', 'R3', 'R4', 'R5']) values[mom(t)] = 6;
    const state: RuleState = { ...emptyRuleState(), own: { MU: { applied: 'STD', stdWeight: 0.1 }, NVDA: { applied: 'STD', stdWeight: 0.1 } }, heldMom: ['R1', 'R2', 'R3', 'R4', 'R5'], effPrev: 1 };
    return { values, state };
  }

  it('起步：核心照 80：20；規則狀態沒有 crash', () => {
    const state = emptyRuleState();
    state.own = { MU: { applied: 'STD', stdWeight: 0.1 }, NVDA: { applied: 'STD', stdWeight: 0.1 } };
    const p = planDay({ cfg, values: { [CCASH]: 100 }, state, first: true, monthly: { order: order30, excessVol: () => 0.2 } });
    expect(p.targets[VOO]).toBeCloseTo(40, 9);
    expect(p.targets[CCASH]).toBeCloseTo(10, 9);
    expect('crash' in p.state).toBe(false);
    expect(p.crashChanged).toBe(false);
  });

  it('動能只依波動度減碼：給了 coreBelow200 也不看（eff = w），沒有崩盤的事件', () => {
    const { values, state } = steady();
    const p = planDay({ cfg, values, state, monthly: { order: order30, excessVol: () => 0.2, coreBelow200: true } });
    expect(p.state.effPrev).toBe(1);
    expect(p.events.filter((e) => e.kind === 'CRASH_ON' || e.kind === 'CRASH_OFF')).toEqual([]);
    for (const t of ['R1', 'R2', 'R3', 'R4', 'R5']) expect(p.targets[mom(t)]).toBeCloseTo(6, 9);
    expect(p.targets[VOO]).toBeCloseTo(40, 9);
    expect(p.targets[CCASH]).toBeCloseTo(10, 9);
  });

  it('依波動度減碼減下來的錢進核心照 80：20；加回時照 80：20 拿', () => {
    const { values, state } = steady();
    // 歷史中位數 0.2、這個月 0.3 → 比值 0.67 → 2/3
    const st = { ...state, volHist: Array.from({ length: 24 }, () => 0.2), volW: 1 };
    const p = planDay({ cfg, values, state: st, monthly: { order: order30, excessVol: () => 0.3 } });
    expect(p.state.volW).toBeCloseTo(2 / 3, 9);
    for (const t of ['R1', 'R2', 'R3', 'R4', 'R5']) expect(p.targets[mom(t)]).toBeCloseTo(4, 9);
    // 動能少 10 → 核心多 10：VOO +8、現金格 +2
    expect(p.targets[VOO]).toBeCloseTo(48, 9);
    expect(p.targets[CCASH]).toBeCloseTo(12, 9);
    expect(p.coreRebal).toBe(false);
  });

  it('月報日的界線檢查：超出 15%～25% 才把現金格調回 20%（事件 CORE_BAND）；不是月報日不檢查', () => {
    const { values, state } = steady();
    const off: CellMap = { ...values, [VOO]: 45, [CCASH]: 5 }; // 現金格占核心 10%
    const m = planDay({ cfg, values: off, state, monthly: { order: order30, excessVol: () => 0.2 } });
    expect(m.coreRebal).toBe(true);
    expect(m.coreBand?.s).toBeCloseTo(0.1, 9);
    expect(m.targets[CCASH]).toBeCloseTo(10, 9);
    expect(m.targets[VOO]).toBeCloseTo(40, 9);
    expect(m.events.some((e) => e.kind === 'CORE_BAND')).toBe(true);
    // 界線內（16%）：不動
    const inBand = planDay({ cfg, values: { ...values, [VOO]: 42, [CCASH]: 8 }, state, monthly: { order: order30, excessVol: () => 0.2 } });
    expect(inBand.coreRebal).toBe(false);
    expect(inBand.targets[CCASH]).toBeCloseTo(8, 9);
    // 平日（自選訊號）：不檢查
    const day = planDay({ cfg, values: off, state, ownActions: { MU: 'REDUCE' } });
    expect(day.coreBand).toBeNull();
    expect(day.targets[CCASH]).toBeCloseTo(5 + 0.2 * 5, 9); // MU 減半的 5 進核心：現金格 +1
    expect(day.targets[VOO]).toBeCloseTo(45 + 0.8 * 5, 9);
  });

  it('入金：補完各格剩下的照 80：20 進核心（不是全部買 VOO）', () => {
    const { values, state } = steady();
    const p = planDay({ cfg, values, state, flow: { kind: '入金', amount: 20 } });
    // 入金後總資產 120：自選各缺 2、動能各缺 1.2 → 共 10；剩 10 進核心：VOO +8、現金格 +2
    expect(p.targets[own('MU')]).toBeCloseTo(12, 9);
    expect(p.targets[mom('R1')]).toBeCloseTo(7.2, 9);
    expect(p.targets[VOO]).toBeCloseTo(48, 9);
    expect(p.targets[CCASH]).toBeCloseTo(12, 9);
  });

  it('出金的新順序：動能高於目標的部分 → 核心（照比例）→ 動能 → 自選', () => {
    const { values, state } = steady();
    const v: CellMap = { ...values, [mom('R1')]: 9 }; // R1 比別檔高
    // 出金 13：出金後總資產 90，動能每檔目標 5.4 → R1 高出 3.6、其餘四檔各高出 0.6，先拿（共 6）；剩下 7 從核心照比例
    const p = planDay({ cfg, values: v, state, flow: { kind: '出金', amount: 13 } });
    expect(p.total).toBeCloseTo(90, 9);
    for (const t of ['R1', 'R2', 'R3', 'R4', 'R5']) {
      expect(p.targets[mom(t)]).toBeCloseTo(5.4, 9);
      expect(p.why[mom(t)]).toBe('出金');
    }
    expect(p.targets[VOO]).toBeCloseTo(40 - 0.8 * 7, 9);
    expect(p.targets[CCASH]).toBeCloseTo(10 - 0.2 * 7, 9);
    expect(p.targets[own('MU')]).toBeCloseTo(10, 9);
    // 核心拿光了才輪到動能其餘的部分，最後才是自選（關掉上限，只看順序）
    const loose = { ...cfg, ownCapHi: 10, crossCapBuy: null };
    const st2: RuleState = { ...emptyRuleState(), own: { MU: { applied: 'STD', stdWeight: 0.1 } }, heldMom: ['R1'], effPrev: 1 };
    const big = planDay({ cfg: loose, values: { [own('MU')]: 10, [mom('R1')]: 2, [VOO]: 4, [CCASH]: 1 }, state: st2, flow: { kind: '出金', amount: 9 } });
    // 出金後總資產 8：R1 高於目標（0.48）的 1.52 → 核心 5 全部 → R1 剩下的 0.48 → 自選 2
    expect((big.targets[VOO] ?? 0) + (big.targets[CCASH] ?? 0)).toBeCloseTo(0, 9);
    expect(big.targets[mom('R1')]).toBeCloseTo(0, 9);
    expect(big.targets[own('MU')]).toBeCloseTo(8, 9);
  });

  it('現金格不夠出時由 VOO 補（一邊不夠由另一邊補）', () => {
    const { values, state } = steady();
    const v: CellMap = { ...values, [VOO]: 49.5, [CCASH]: 0.5 };
    // 新增一檔自選要 10：現金格該出 2，只有 0.5 → 不夠的由 VOO 出
    const st = { ...state, own: { ...state.own, MSFT: { applied: 'HALF' as const, stdWeight: 0.1 } } };
    const p = planDay({ cfg, values: v, state: st, ownActions: { MSFT: 'READD' } });
    expect(p.targets[own('MSFT')]).toBeCloseTo(10, 9);
    expect(p.targets[CCASH]).toBeCloseTo(0, 9);
    expect(p.targets[VOO]).toBeCloseTo(40, 9);
  });

  it('舊路徑（legacyCrash，重放 B-8 用）：崩盤規則照舊——核心一半現金、動能減半、錢平時只進出 VOO', () => {
    const values: CellMap = { [own('MU')]: 10, [own('NVDA')]: 10, [VOO]: 50 };
    for (const t of ['R1', 'R2', 'R3', 'R4', 'R5']) values[mom(t)] = 6;
    const state: RuleState = { ...emptyRuleState(), crash: false, own: { MU: { applied: 'STD', stdWeight: 0.1 }, NVDA: { applied: 'STD', stdWeight: 0.1 } }, heldMom: ['R1', 'R2', 'R3', 'R4', 'R5'], effPrev: 1 };
    const on = planDay({ cfg, values, state, legacyCrash: true, monthly: { order: order30, excessVol: () => 0.2, coreBelow200: true } });
    expect(on.crashChanged).toBe(true);
    expect(on.state.crash).toBe(true);
    expect(on.state.effPrev).toBe(0.5);
    expect(on.targets[mom('R1')]).toBeCloseTo(3, 9);
    expect(on.targets[VOO]).toBeCloseTo(32.5, 9);
    expect(on.targets[CCASH]).toBeCloseTo(32.5, 9);
    expect(on.coreBand).toBeNull();
    // 平時：自選減半的錢全部進 VOO
    const day = planDay({ cfg, values, state, legacyCrash: true, ownActions: { MU: 'REDUCE' } });
    expect(day.targets[VOO]).toBeCloseTo(55, 9);
    expect(day.targets[CCASH] ?? 0).toBeCloseTo(0, 9);
  });
});

// ---------------------------------------------------------------- 月報的 F26（§1.3）

type Init = ReturnType<typeof scenarios.s5>['init'];
/** 平靜的市場（情境 ⑤），核心改成全部 VOO（像 2026-11-22 之前的帳戶），走到 1 月月報那天早上。over：再蓋掉起始帳戶的欄位。 */
function allVoo(over: Partial<Init> = {}): Sim {
  const sc = scenarios.s5();
  const sim = new Sim(sc.market, { ...sc.init, core: { VOO: 64 }, ...over });
  sim.runUntil('2027-01-04');
  return sim;
}
/** 不回覆、不下單，照常收盤後檢查，一路走到 date 的早上。 */
function idleUntil(sim: Sim, date: string): void {
  while (sim.date < date) {
    sim.close();
    sim.d++;
  }
}
const notifOf = (a: Account, id: number) => a.notifs.find((n) => n.id === id)!;

describe('T80 月報的核心比例調回（F26，§1.3）', () => {
  it('核心幾乎全是 VOO → 月報只有這一項也照出：賣 VOO、買 SGOV 到 20%，約動到總資產的 10%；預設照做、不用理由', () => {
    const sim = allVoo();
    const total = sim.total();
    const jan = sim.preOpen()!;
    expect(jan.kind).toBe('MONTHLY');
    expect(jan.items.map((i) => i.f)).toEqual(['F26']);
    const f26 = item(jan, 'F26');
    expect(f26.kind).toBe('CORE_BAND');
    expect(f26.ticker).toBeUndefined();
    expect(f26.title).toMatch(/^核心比例調回：SGOV 那一邊占核心 \d+\.\d%，低於 15% → 調回 20%$/);
    expect(f26.why).toBe('核心固定放 VOO 八成、SGOV 與現金兩成。平常不調，超出 15%～25% 才調回。這次是股票漲多了，調回等於漲多買 SGOV。');
    expect(f26.note).toBeUndefined();
    expect(f26.choices.map((c) => [c.id, c.label])).toEqual([
      ['DO', '照做'],
      ['SKIP', '這次不做'],
    ]);
    expect(f26.choice).toBe('DO');
    expect(f26.reasonRequired).toBeUndefined();
    expect(missingReasons(jan, { mode: 'DO', choices: { [f26.key]: 'SKIP' } })).toEqual([]);
    expect(missingReasons(jan, { mode: 'SKIP' })).toEqual([]);
    const lines = f26.choices[0].lines;
    expect(lines.map((l) => [l.ticker, l.bucket, Math.sign(l.shares), l.reason])).toEqual([
      ['VOO', 'core', -1, '核心比例'],
      ['SGOV', 'core', 1, '核心比例'],
    ]);
    const moved = -lineOf(lines, 'VOO') * priceOf(sim.pre, 'VOO');
    expect(moved / total).toBeGreaterThan(0.05);
    expect(moved / total).toBeLessThan(0.11);
    // 月報記下調回之前的比例（顯示用）
    const band = jan.monthly!.input.coreBand!;
    expect(band.s).toBeCloseTo(bondShare(sim.acct, sim.pre), 9);
    expect(band.s).toBeLessThan(0.15);
    expect(band.bond).toBe(0.2);
    expect(band.core).toBeCloseTo(bucketValue(sim.acct, sim.pre, 'core'), 6);
    // 不再寫訊號日的崩盤判斷
    expect(jan.monthly!.input.crash).toBeUndefined();
    // 照做、成交之後回到 20% 附近；下個月不再列
    sim.respond(jan.id);
    expect(notifOf(sim.acct, jan.id).status).toBe('RESPONDED');
    sim.open();
    expect(bondShare(sim.acct, sim.pre)).toBeGreaterThan(0.18);
    expect(bondShare(sim.acct, sim.pre)).toBeLessThan(0.22);
    sim.close();
    sim.d++;
    sim.runUntil('2027-02-01');
    const feb = sim.preOpen()!;
    expect(feb.items.some((i) => i.f === 'F26')).toBe(false);
    expect(feb.monthly!.input.coreBand!.s).toBeGreaterThan(0.15);
  });

  it('這次不做：不用理由、不記欠單（mom.owe、coreOwe 都沒有），影子紀錄記兩檔；下個月還在界線外就再列一次', () => {
    const sim = allVoo();
    const jan = sim.preOpen()!;
    const f26 = item(jan, 'F26');
    sim.respond(jan.id, { mode: 'DO', choices: { [f26.key]: 'SKIP' } });
    expect(notifOf(sim.acct, jan.id).status).toBe('SKIPPED');
    expect(sim.acct.mom.owe).toEqual({});
    expect(sim.acct.coreOwe).toBeUndefined();
    const sh = sim.acct.shadow.filter((s) => s.f === 'F26');
    expect(sh.map((s) => [s.ticker, s.rule, s.actual, s.choice])).toEqual(f26.choices[0].lines.map((l) => [l.ticker, l.shares, 0, 'SKIP']));
    idleUntil(sim, '2027-02-01');
    const feb = sim.preOpen()!;
    const again = item(feb, 'F26');
    expect(again).toBeDefined();
    expect(again.relist).toBeUndefined();
    expect(again.title).toContain('低於 15% → 調回 20%');
    expect(again.reasonRequired).toBeUndefined();
  });

  it('上一份月報一直沒回覆：舊的 F26 以新月報為準取消，新月報照現在的持股重算；不記欠單', () => {
    const sim = allVoo();
    const jan = sim.preOpen()!;
    const old = item(jan, 'F26');
    idleUntil(sim, '2027-02-01');
    const feb = sim.preOpen()!;
    expect(notifOf(sim.acct, jan.id).items.find((i) => i.key === old.key)).toMatchObject({ cancelled: true, note: '上一份月報沒有回覆，這一項以 2027-02 月報為準' });
    expect(notifOf(sim.acct, jan.id).status).toBe('SUPERSEDED');
    expect(item(feb, 'F26').choices[0].lines.map((l) => l.ticker)).toEqual(['VOO', 'SGOV']);
    expect(sim.acct.mom.owe).toEqual({});
  });

  it('晚回覆（提醒過才回）：F26 的行照回覆當天的持股與價格重算；已經回到界線內就不用做', () => {
    const sim = allVoo();
    const jan = sim.preOpen()!;
    const f26 = item(jan, 'F26');
    idleUntil(sim, '2027-01-11');
    expect(notifOf(sim.acct, jan.id).reminded).toBe(true);
    const view = sim.pre;
    const late = notifOf(respond(sim.acct, view, jan.id, { mode: 'DO' }), jan.id).items.find((i) => i.key === f26.key)!;
    const want = coreBandLines({ cfg: sim.acct.cfg, price: (t) => priceOf(view, t), cash: sim.acct.cash, coreShares: sim.acct.lots.core.VOO, bondShares: 0, bondTicker: 'SGOV' }).lines;
    expect(late.choices[0].lines).toEqual(want);
    expect(late.note).toBe(`晚回覆：用 ${view.date} 收盤價重算`);
    // 這段時間自己把 VOO 換成 SGOV 了（核心回到 20% 附近）→ 晚回覆時這一項沒有要下的單
    const done: Account = { ...sim.acct, lots: { ...sim.acct.lots, core: { VOO: 54, SGOV: 62 } } };
    const r = respond(done, view, jan.id, { mode: 'DO' });
    const it = notifOf(r, jan.id).items.find((i) => i.key === f26.key)!;
    expect(it.choices[0].lines).toEqual([]);
    expect(it.note).toBe(CORE_BAND_BACK_NOTE);
    expect(notifOf(r, jan.id).status).toBe('DONE');
  });

  it('有 F26 的月份，動能的比例回調不受搭便車限制（F26 本身就是單，§1.5）；沒有 F26 時照舊被撤回', () => {
    // PLTR 買太多（偏離目標超過 +50%），這個月沒有換股
    const mom = { ...scenarios.s5().init.mom, PLTR: 80 };
    const withF26 = allVoo({ mom });
    const a = withF26.preOpen()!;
    expect(a.items.map((i) => i.f)).toEqual(['F3', 'F26']);
    expect(item(a, 'F3', 'PLTR').choices[0].lines[0].shares).toBeLessThan(0);
    // 對照：核心在界線內 → 沒有 F26，回調被搭便車撤回，本月不用動
    const sc = scenarios.s5();
    const calm = new Sim(sc.market, { ...sc.init, mom });
    calm.runUntil('2027-01-04');
    const b = calm.preOpen()!;
    expect(b.kind).toBe('MONTHLY_EMPTY');
    expect(b.items).toEqual([]);
  });

  it('從崩盤規則換過來的帳戶：第一次的 F26 多一句一次性調整的備註、理由不寫「漲多了」；照做過之後就沒有', () => {
    const sim = allVoo();
    sim.acct.fromCrashRule = true;
    const jan = sim.preOpen()!;
    const f26 = item(jan, 'F26');
    expect(f26.note).toBe(CORE_SWITCH_NOTE);
    expect(f26.why).toBe('核心固定放 VOO 八成、SGOV 與現金兩成。平常不調，超出 15%～25% 才調回。');
    // 選了這次不做 → 下個月再列時還是第一次
    const skipped = respond(sim.acct, sim.pre, jan.id, { mode: 'DO', choices: { [f26.key]: 'SKIP' } });
    const again = monthlyReport(skipped, viewAt(sim.market, sim.d + 19), { order: ranksAt(sim.market, sim.d + 19), month: '2027-02' }).notif;
    expect(item(again, 'F26').note).toBe(CORE_SWITCH_NOTE);
    // 照做過之後，再有 F26（這裡把 SGOV 那一邊弄到太多）就是平常的調回
    sim.respond(jan.id);
    sim.open();
    const tilted: Account = { ...sim.acct, lots: { ...sim.acct.lots, core: { VOO: 30, SGOV: 200 } } };
    const next = monthlyReport(tilted, sim.pre, { order: ranksAt(sim.market, sim.d - 1), month: '2027-02' }).notif;
    const hi = item(next, 'F26');
    expect(hi.note).toBeUndefined();
    expect(hi.title).toMatch(/超過 25% → 調回 20%$/);
    expect(hi.why).toContain('這次是股票跌多了，調回等於跌深買 VOO。');
    expect(hi.choices[0].lines.map((l) => [l.ticker, Math.sign(l.shares)])).toEqual([
      ['SGOV', -1],
      ['VOO', 1],
    ]);
  });

  it('月報有其他單時，帳上原本的現金順便買成 SGOV；沒有其他單、核心也在界線內 → 本月不用動，不為現金發通知', () => {
    // 情境 ①：12 月月報有換股；起始帳戶帳上有 $1,500 現金
    const sc = scenarios.s1();
    const sim = new Sim(sc.market, sc.init, { vetoes: { '2026-12': ['APP'] } });
    sim.runUntil('2026-12-01');
    const dec = sim.preOpen()!;
    const core = dec.preview!.lines.filter((l) => l.bucket === 'core');
    expect(core.map((l) => [l.ticker, l.reason])).toEqual([
      ['VOO', '錢交給核心（VOO 八成、SGOV 兩成）'],
      ['SGOV', '錢交給核心（VOO 八成、SGOV 兩成）'],
      ['SGOV', '帳上的現金買 SGOV'],
    ]);
    expect(core.every((l) => l.shares > 0)).toBe(true);
    expect(dec.items.some((i) => i.f === 'CORE')).toBe(false); // 不再有「帳上的現金交給核心」這一項
    // 情境 ④ 的 1 月：沒有規則單（帳上一樣有 $1,500）→ 本月不用動
    const s4 = scenarios.s4();
    const quiet = new Sim(s4.market, s4.init);
    quiet.runUntil('2027-01-04');
    expect(quiet.acct.cash).toBe(1500);
    const jan = quiet.preOpen()!;
    expect(jan.kind).toBe('MONTHLY_EMPTY');
    expect(jan.preview!.lines).toEqual([]);
  });
});

// ---------------------------------------------------------------- 入金、出金、建立帳戶與網站的說明（§1.4）

describe('T80 入金、出金、建立帳戶（§1.4）', () => {
  const start = () => {
    const sc = scenarios.s5();
    const sim = new Sim(sc.market, sc.init);
    sim.runUntil('2026-12-10');
    return sim;
  };
  const ctxOf = (acct: Account, view: MarketView): ExplainContext => ({ acct, view, axis: [], rankOrder: [], aiNotes: [] });

  it('入金清單：剩下的錢照比例買 VOO 與 SGOV；「做完之後」多一項核心的比例', () => {
    const sim = start();
    const r = deposit(sim.acct, sim.pre, 10000);
    const core = r.notif.preview!.lines.filter((l) => l.bucket === 'core');
    expect(core.map((l) => l.ticker)).toEqual(['VOO', 'SGOV']);
    const v = (t: string) => lineOf(core, t) * priceOf(sim.pre, t);
    // 整股之後大約 80：20（SGOV 一股便宜，零頭較少）
    expect(v('SGOV') / (v('VOO') + v('SGOV'))).toBeGreaterThan(0.15);
    expect(v('SGOV') / (v('VOO') + v('SGOV'))).toBeLessThan(0.3);
    expect(r.notif.items[0].why).toBe('依序補低於目標最多的格子；缺口小於總資產 0.25% 的不補；剩下的照比例進核心');
    const f = afterFact(r.acct, sim.pre, r.notif.preview)!;
    expect(f.value).toMatch(/；核心裡 SGOV 與現金 \d+\.\d%（目標 20%）$/);
    expect(f.note).toContain('核心裡的比例在 15%～25% 之內不調');
    const x = explainItem(ctxOf(r.acct, sim.pre), r.notif, r.notif.items[0]);
    expect(x.facts![0]).toEqual(f);
    expect(x.why).toContain('剩下的交給核心，照比例買 VOO 與 SGOV');
    expect(coreLineWhy(String(core[0].reason), r.acct)).toBe('清單做完會多出現金，交給核心，照比例買（VOO 八成、SGOV 兩成）');
  });

  it('出金清單：核心那一步照比例（帳上現金先用），「做完之後」也有核心的比例', () => {
    const sim = start();
    const r = withdraw(sim.acct, sim.pre, 30000);
    expect(r.notif.items[0].why).toBe('先做單檔上限檢查；再照 動能高於目標 → 核心（照比例，帳上現金先用）→ 動能 → 自選');
    const core = r.notif.preview!.lines.filter((l) => l.bucket === 'core');
    expect(core.map((l) => [l.ticker, Math.sign(l.shares)])).toEqual([
      ['SGOV', -1],
      ['VOO', -1],
    ]);
    expect(r.notif.preview!.cashAfter).toBeGreaterThanOrEqual(0);
    const f = afterFact(r.acct, sim.pre, r.notif.preview, r.notif.id)!;
    const s = Number(/核心裡 SGOV 與現金 ([\d.]+)%/.exec(f.value)![1]) / 100;
    expect(s).toBeGreaterThan(0.15);
    expect(s).toBeLessThan(0.25);
    expect(coreLineWhy(String(core[0].reason), r.acct)).toBe('不夠的錢從核心照比例拿（VOO 八成、SGOV 兩成；帳上現金先用）');
  });

  it('建立帳戶：規則狀態沒有 crash，動能的有效比例只是波動度比例；給了 crash 也不讀', () => {
    const sc = scenarios.s5();
    const v0 = viewAt(sc.market, sc.market.idx0 - 1);
    const a = createAccount({ ...sc.init, crash: true, volW: 2 / 3 }, v0);
    expect('crash' in a.rule).toBe(false);
    expect(a.rule.effPrev).toBeCloseTo(2 / 3, 12);
    expect(a.cfg).toMatchObject({ coreBond: 0.2, coreBand: 0.05 });
    expect(createAccount({ cash: 1000, core: { VOO: 10 } }, v0).rule.effPrev).toBeNull();
  });

  it('網站：F26 的項目、說明與清單上核心那幾行的字', () => {
    const sim = allVoo();
    const jan = sim.preOpen()!;
    const d = { mode: 'real', acct: sim.acct, view: sim.pre, axis: [], rankOrder: [], rankSession: null, aiNotes: [], events: [], shadow: [], today: sim.pre.date, warnings: [] } as never;
    const nv = notifView(d, jan);
    const iv = nv.items[0];
    expect(iv).toMatchObject({ label: '核心比例調回', bucket: 'core', headline: '核心比例調回', kind: 'CORE_BAND', reasonRequired: false });
    expect(iv.explain.rule).toContain('短債與現金那一邊低於 15% 或高於 25% 才調回 20%');
    expect(iv.explain.facts!.map((f) => f.label)).toEqual(['SGOV 與現金占核心', '核心的市值']);
    expect(iv.explain.choiceNotes!.SKIP).toContain('不用寫理由');
    expect(iv.choices[0].lines.map((l) => l.reason)).toEqual(['核心比例調回 20%', '核心比例調回 20%']);
  });
});

// ---------------------------------------------------------------- 舊帳戶資料（§1.5）

interface OldSample {
  d: number;
  date: string;
  acct: Account;
}
/** 0.17.0（fd9d2d3）的引擎跑示範情境 ③ 產生的帳戶狀態（假市場、假帳戶）；市場和現在的情境 ③ 相同。 */
const OLD = JSON.parse(readFileSync(join(HERE, 'fixtures', 'account-0.17.0.json'), 'utf8')) as { a: OldSample; b: OldSample; c: OldSample };
const oldAcct = (k: 'a' | 'b' | 'c'): Account => JSON.parse(JSON.stringify(OLD[k].acct)) as Account;

describe('T80 舊帳戶資料（0.17.0 的樣本）讀進來不壞（§1.5）', () => {
  const market = scenarios.s3().market;

  it('樣本確實是舊的樣子：rule.crash、coreOwe、崩盤來的與別的動能欠單、設定沒有核心比例', () => {
    const a = OLD.a.acct;
    expect(a.rule.crash).toBe(true);
    expect(a.rule.effPrev).toBe(0.5);
    expect(a.coreOwe).toMatchObject({ direction: 'ON' });
    expect(Object.keys(a.mom.owe).sort()).toEqual(['AMD', 'APP', 'AVGO', 'NFLX', 'PLTR']);
    expect((a.cfg as Partial<EngineConfig>).coreBond).toBeUndefined();
    expect(OLD.b.acct.notifs.at(-1)!.items.map((i) => i.f)).toContain('F6');
  });

  it('migrateAccount：crash 拿掉、effPrev 重算成波動度比例、coreOwe 清掉、崩盤來的動能欠單清掉（別的留著）、設定補上；重複呼叫結果相同；持股不動', () => {
    const before = oldAcct('a');
    const a = migrateAccount(oldAcct('a'));
    expect('crash' in a.rule).toBe(false);
    expect(a.rule.effPrev).toBe(a.rule.volW ?? 1);
    expect(a.rule.effPrev).toBe(1);
    expect(a.coreOwe).toBeUndefined();
    expect(Object.keys(a.mom.owe)).toEqual(['APP']); // 1 月沒買的進場（F1 選了這次不做）留著
    expect(a.cfg).toMatchObject({ coreBond: 0.2, coreBand: 0.05, crashCut: 0.5 });
    expect(a.fromCrashRule).toBe(true);
    expect(a.lots).toEqual(before.lots);
    expect(a.cash).toBe(before.cash);
    expect(a.notifs).toEqual(before.notifs);
    const again = migrateAccount(JSON.parse(JSON.stringify(a)) as Account);
    expect(again).toEqual(a);
    // 還沒跑過月報的（effPrev 是 null）維持 null
    expect(normRule({ ...emptyRuleState(), crash: false }).effPrev).toBeNull();
    // 已經是新的：原樣
    const fresh = createAccount({ cash: 1000, core: { VOO: 10 } }, viewAt(market, market.idx0 - 1));
    expect(migrateAccount(fresh)).toBe(fresh);
    expect(fresh.fromCrashRule).toBeUndefined();
  });

  it('樣本 a（崩盤規則啟動、核心沒換）：照常跑每日檢查與下一份月報 → 第一次 F26 把核心調到 20%（一次性調整的備註）、1 月沒買的 APP 補做、沒有 F5／F6', () => {
    const sim = new Sim(market, scenarios.s3().init);
    sim.acct = migrateAccount(oldAcct('a'));
    sim.d = OLD.a.d;
    sim.runUntil('2027-02-01');
    const feb = sim.preOpen()!;
    expect(feb.items.some((i) => i.f === 'F5' || i.f === 'F6')).toBe(false);
    const f26 = item(feb, 'F26');
    expect(f26.note).toBe(CORE_SWITCH_NOTE);
    expect(f26.choices[0].lines.map((l) => [l.ticker, Math.sign(l.shares)])).toEqual([
      ['VOO', -1],
      ['SGOV', 1],
    ]);
    expect(item(feb, 'F17', 'APP').choices[0].lines[0].shares).toBeGreaterThan(0);
    // 崩盤來的欠單清掉了：那四檔不會被當成「上次的策略單沒照做」再叫你減半
    for (const t of ['AMD', 'AVGO', 'NFLX', 'PLTR']) expect(feb.items.some((i) => i.f === 'F17' && i.ticker === t)).toBe(false);
    sim.respond(feb.id);
    sim.open();
    expect(bondShare(sim.acct, sim.pre)).toBeGreaterThan(0.17);
    expect(bondShare(sim.acct, sim.pre)).toBeLessThan(0.23);
    expect('crash' in sim.acct.rule).toBe(false);
  });

  it('樣本 c（崩盤規則啟動、核心一半短債、動能減半）：第一份月報 F26 賣 SGOV 買 VOO 到 20%；動能只有偏離目標超過 ±50% 的才列回調', () => {
    const sim = new Sim(market, scenarios.s3().init);
    sim.acct = migrateAccount(oldAcct('c'));
    sim.d = OLD.c.d;
    expect(bondShare(sim.acct, sim.pre)).toBeGreaterThan(0.4);
    const momBefore = bucketValue(sim.acct, sim.pre, 'mom') / totalValue(sim.acct, sim.pre);
    expect(momBefore).toBeLessThan(0.18);
    sim.runUntil('2027-02-01');
    const feb = sim.preOpen()!;
    const f26 = item(feb, 'F26');
    expect(f26.title).toMatch(/超過 25% → 調回 20%$/);
    expect(f26.note).toBe(CORE_SWITCH_NOTE);
    expect(f26.choices[0].lines.map((l) => [l.ticker, Math.sign(l.shares)])).toEqual([
      ['SGOV', -1],
      ['VOO', 1],
    ]);
    // 動能：目標回到沒有減半的數字（effPrev 只剩波動度比例），但留任股只有偏離目標超過 ±50% 才回調（這一次不受搭便車限制）。
    // 減半的部位大約就在目標的一半上下：超過的列 F3（買回），沒超過的這份月報不動，之後換股或偏離夠大時才回到目標（設計 §1.5 的說明）
    expect(sim.acct.rule.effPrev).toBe(1);
    const slot = momSlotTarget(sim.acct.cfg, totalValue(sim.acct, sim.pre), 1);
    const f3 = feb.items.filter((i) => i.f === 'F3');
    expect(f3.every((i) => i.choices[0].lines[0].shares > 0)).toBe(true);
    for (const t of sim.acct.rule.heldMom) {
      const cur = (sim.acct.lots.mom[t] ?? 0) * priceOf(sim.pre, t);
      const listed = feb.items.some((i) => i.ticker === t && i.kind === 'STRATEGY');
      if (!listed) expect(cur, t).toBeGreaterThanOrEqual(0.5 * slot - 1e-6);
      else expect(feb.items.find((i) => i.ticker === t)!.f, t).toMatch(/^F[123]$/);
    }
    expect(feb.items.some((i) => i.f === 'F4' || i.f === 'F17')).toBe(false);
    sim.respond(feb.id);
    sim.open();
    expect(bondShare(sim.acct, sim.pre)).toBeGreaterThan(0.17);
    expect(bondShare(sim.acct, sim.pre)).toBeLessThan(0.23);
  });

  it('樣本 b（有一份還沒回覆、帶 F6 的舊月報，月報前的狀態是舊的）：照預設回覆不壞；同一天入金合併重算不壞、新的月報沒有崩盤項目', () => {
    const acct = migrateAccount(oldAcct('b'));
    const view = viewAt(market, OLD.b.d - 1);
    const feb = acct.notifs.at(-1)!;
    expect(feb.status).toBe('PENDING');
    expect(feb.monthly!.before.rule.crash).toBe(true);
    // 舊月報照預設回覆：照它列的單合成（核心吸收的差額照新規則分）
    const done = respond(acct, view, feb.id, { mode: 'DO' });
    expect(notifOf(done, feb.id).status).toBe('RESPONDED');
    expect(done.coreOwe).toBeUndefined();
    // 這次不做：不再寫核心的欠單，動能也不記
    const skip = respond(acct, view, feb.id, { mode: 'SKIP' });
    expect(skip.coreOwe).toBeUndefined();
    expect(Object.keys(skip.mom.owe)).toEqual(Object.keys(acct.mom.owe));
    // 入金併進月報：還原舊的「月報前的狀態」再重算
    const dep = deposit(acct, view, 5000);
    expect(dep.mergedIntoMonthly).toBe(true);
    expect(dep.notif.items.some((i) => i.f === 'F5' || i.f === 'F6')).toBe(false);
    expect('crash' in dep.acct.rule).toBe(false);
    expect(dep.acct.coreOwe).toBeUndefined();
    expect(dep.notif.items.some((i) => i.f === 'F11')).toBe(true);
  });
});

// ---------------------------------------------------------------- 動能空出來的格子（§2.2）

describe('T80 動能空格：月中提早出場 → 錢進核心 80：20 → 下一份月報遞補（§2.2）', () => {
  it('ORCL 被收購（規則直接提出）：賣出的錢照比例買 VOO 與 SGOV；月中不補；1 月月報照排名遞補 GS，錢從核心照比例拿', () => {
    const sc = scenarios.s4();
    const sim = new Sim(sc.market, sc.init);
    sim.runUntil('2026-12-10');
    sim.day();
    const r = hardEvent(sim.acct, sim.pre, 'ORCL', 'PENDING_MA', true);
    sim.acct = r.acct;
    expect(sim.acct.rule.heldMom).toEqual(['PLTR', 'AVGO', 'NFLX', 'AMD']); // 名單當場少一檔
    // 清單：賣 ORCL，錢進核心照 80：20
    const lines = r.notif!.preview!.lines;
    expect(listLines(lines.filter((l) => l.bucket === 'mom'))).toEqual(['mom ORCL -28']);
    const core = lines.filter((l) => l.bucket === 'core');
    expect(core.map((l) => [l.ticker, l.reason])).toEqual([
      ['VOO', '錢交給核心（VOO 八成、SGOV 兩成）'],
      ['SGOV', '錢交給核心（VOO 八成、SGOV 兩成）'],
    ]);
    const proceeds = 28 * priceOf(sim.pre, 'ORCL');
    const v = (t: string) => lineOf(core, t) * priceOf(sim.pre, t);
    expect(v('VOO') / proceeds).toBeGreaterThan(0.7);
    expect(v('VOO') / proceeds).toBeLessThanOrEqual(0.8 * 0.98 + 1e-9);
    expect(v('SGOV') / proceeds).toBeGreaterThan(0.17);
    expect(v('SGOV') / proceeds).toBeLessThanOrEqual(0.2 * 0.98 + 1e-9);
    sim.respond(r.notif!.id);
    sim.open();
    expect(sim.acct.lots.mom.ORCL).toBeUndefined();
    const sMid = bondShare(sim.acct, sim.pre);
    expect(sMid).toBeGreaterThan(0.15);
    expect(sMid).toBeLessThan(0.25);
    // 月中：空格不補，每日檢查不會為它出通知
    const before = sim.acct.notifs.length;
    sim.close();
    sim.d++;
    sim.runUntil('2027-01-04');
    expect(sim.acct.notifs.length).toBe(before);
    expect(Object.keys(sim.acct.lots.mom).sort()).toEqual(['AMD', 'AVGO', 'NFLX', 'PLTR']);
    // 下一份月報：照排名遞補
    const jan = sim.preOpen()!;
    expect(jan.items.map((i) => `${i.f}:${i.ticker}`)).toEqual(['F1:GS']);
    expect(sim.acct.rule.heldMom).toEqual(['PLTR', 'AVGO', 'NFLX', 'AMD', 'GS']);
    const jc = jan.preview!.lines.filter((l) => l.bucket === 'core');
    expect(jc.length).toBeGreaterThan(0);
    expect(jc.every((l) => l.shares < 0 && l.reason === '從核心拿錢（VOO 八成、SGOV 兩成）')).toBe(true);
    // 帳上的現金先用（算 SGOV 那一邊），所以 VOO 賣的不超過八成（加一股的進位）
    const cost = lineOf(jan.preview!.lines, 'GS', 'mom') * priceOf(sim.pre, 'GS');
    const vooSold = -lineOf(jc, 'VOO') * priceOf(sim.pre, 'VOO');
    expect(vooSold).toBeLessThanOrEqual((0.8 * cost) / 0.98 + priceOf(sim.pre, 'VOO'));
    sim.respond(jan.id);
    sim.open();
    expect(sim.acct.lots.mom.GS).toBeGreaterThan(0);
    expect(sim.acct.cash).toBeGreaterThanOrEqual(0);
    expect(bondShare(sim.acct, sim.pre)).toBeGreaterThan(0.15);
    expect(bondShare(sim.acct, sim.pre)).toBeLessThan(0.25);
  });
});
