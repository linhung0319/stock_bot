// T1：分桶、核心當清算中心、上限、搭便車、入金出金、合併下單、通知分級。
// 數字取自設計 §2.1、§2.1.1、§2.2、§2.5、§4.4。總資產一律用 100，金額就是百分比。
import { describe, expect, it } from 'vitest';
import {
  CASH,
  DEFAULT_CONFIG,
  cellKey,
  composeWithCore,
  crashCoreLines,
  dueOwnActions,
  emptyRuleState,
  mergeByTicker,
  ownSignalTier,
  planDay,
  planToLines,
  reasonTier,
  summarizeOrders,
  valuesFromShares,
  type CellMap,
  type EngineConfig,
  type MonthlyInput,
  type RuleState,
} from '../src/engine';

const cfg: EngineConfig = { ...DEFAULT_CONFIG };
const VOO = cellKey('core', 'VOO');
const CCASH = cellKey('core', CASH);
const own = (t: string) => cellKey('own', t);
const mom = (t: string) => cellKey('mom', t);
const order30 = Array.from({ length: 30 }, (_, i) => 'R' + (i + 1));
const monthly = (over: Partial<MonthlyInput> = {}): MonthlyInput => ({
  order: order30,
  excessVol: () => 0.2,
  coreBelow200: false,
  ...over,
});
const sum = (m: CellMap) => Object.values(m).reduce((a, b) => a + b, 0);

/** 已經跑了一段時間的帳戶：自選 MU、NVDA 各 10，動能 R1–R5 各 6，核心 VOO 50。 */
function steady(): { values: CellMap; state: RuleState } {
  const values: CellMap = { [own('MU')]: 10, [own('NVDA')]: 10, [VOO]: 50 };
  for (const t of ['R1', 'R2', 'R3', 'R4', 'R5']) values[mom(t)] = 6;
  const state: RuleState = {
    own: { MU: { applied: 'STD', stdWeight: 0.1 }, NVDA: { applied: 'STD', stdWeight: 0.1 } },
    heldMom: ['R1', 'R2', 'R3', 'R4', 'R5'],
    effPrev: 1,
    crash: false,
    volHist: [],
    volW: null,
  };
  return { values, state };
}

describe('三桶 20 / 30 / 50（設計 §2.1）', () => {
  it('起步：自選到標準比重、動能 5 檔各 6%、其餘是核心', () => {
    const state = emptyRuleState();
    state.own = { MU: { applied: 'STD', stdWeight: 0.1 }, NVDA: { applied: 'STD', stdWeight: 0.1 } };
    const p = planDay({ cfg, values: { [CCASH]: 100 }, state, first: true, monthly: monthly() });
    expect(p.targets[own('MU')]).toBeCloseTo(10, 9);
    expect(p.targets[own('NVDA')]).toBeCloseTo(10, 9);
    for (const t of ['R1', 'R2', 'R3', 'R4', 'R5']) expect(p.targets[mom(t)]).toBeCloseTo(6, 9);
    expect(p.targets[VOO]).toBeCloseTo(50, 9);
    expect(p.targets[CCASH]).toBeCloseTo(0, 9);
    expect(p.state.heldMom).toEqual(['R1', 'R2', 'R3', 'R4', 'R5']);
    expect(sum(p.targets)).toBeCloseTo(100, 9);
  });
  it('比例是風險預算不是目標：沒有觸發的月份完全不動', () => {
    const { values, state } = steady();
    // 核心漲到 60、動能各跌到 5：都在 ±50% 以內
    values[VOO] = 60;
    for (const t of state.heldMom) values[mom(t)] = 5;
    const p = planDay({ cfg, values, state, monthly: monthly() });
    expect(p.targets).toEqual(values);
    expect(summarizeOrders(cfg, values, p).orders).toEqual([]);
  });
});

describe('核心當清算中心（設計 §2.1 資金流規則 1、2）', () => {
  it('自選減半：賣掉當時市值的一半，錢進 VOO', () => {
    const { values, state } = steady();
    values[own('MU')] = 12; // 漲過，減半是減「當時持有」的一半
    const p = planDay({ cfg, values, state, ownActions: { MU: 'REDUCE' } });
    expect(p.targets[own('MU')]).toBeCloseTo(6, 9);
    expect(p.targets[VOO]).toBeCloseTo(56, 9);
    expect(p.state.own.MU.applied).toBe('HALF');
    expect(p.why[own('MU')]).toBe('自選訊號');
  });
  it('自選加回：回到標準比重，錢從 VOO 出', () => {
    const { values, state } = steady();
    values[own('MU')] = 4;
    values[VOO] = 56;
    state.own.MU.applied = 'HALF';
    const p = planDay({ cfg, values, state, ownActions: { MU: 'READD' } });
    expect(p.targets[own('MU')]).toBeCloseTo(10, 9);
    expect(p.targets[VOO]).toBeCloseTo(50, 9);
    expect(p.state.own.MU.applied).toBe('STD');
  });
  it('已經不適用的訊號不動（減半狀態再收到減半；標準狀態收到加回）', () => {
    const { values, state } = steady();
    state.own.MU.applied = 'HALF';
    const p = planDay({ cfg, values, state, ownActions: { MU: 'REDUCE', NVDA: 'READD' } });
    expect(p.targets).toEqual(values);
  });
  it('崩盤規則啟動中：減下來的錢進現金，加回先用現金', () => {
    const { values, state } = steady();
    state.crash = true;
    values[VOO] = 25;
    values[CCASH] = 25;
    const p = planDay({ cfg, values, state, ownActions: { MU: 'REDUCE' } });
    expect(p.targets[CCASH]).toBeCloseTo(30, 9);
    expect(p.targets[VOO]).toBeCloseTo(25, 9);
    // 加回 30：現金只有 25，不夠的 5 賣 VOO
    const s2: RuleState = { ...state, own: { MU: { applied: 'HALF', stdWeight: 0.4 }, NVDA: state.own.NVDA } };
    const p2 = planDay({ cfg, values, state: s2, ownActions: { MU: 'READD' } });
    expect(p2.targets[own('MU')]).toBeCloseTo(40, 9);
    expect(p2.targets[CCASH]).toBeCloseTo(0, 9);
    expect(p2.targets[VOO]).toBeCloseTo(20, 9);
  });
});

describe('動能換股與搭便車（設計 §2.1 第 5 點、§3）', () => {
  it('掉出前 15 名 → 賣出，由排名最前、未持有的補上；留任股不動', () => {
    const { values, state } = steady();
    values[mom('R5')] = 7;
    const o = order30.filter((t) => t !== 'R4');
    o.splice(20, 0, 'R4'); // R4 掉到第 21 名
    const p = planDay({ cfg, values, state, monthly: monthly({ order: o }) });
    expect(p.targets[mom('R4')]).toBe(0);
    expect(p.targets[mom('R6')]).toBeCloseTo(sum(values) * 0.06, 9);
    expect(p.targets[mom('R5')]).toBe(7); // 留任，偏離不到 50%
    expect(p.why[mom('R4')]).toBe('動能換股');
    expect(p.state.heldMom).toEqual(['R1', 'R2', 'R3', 'R5', 'R6']);
  });
  it('留任股偏離超過 ±50%，但本月沒有其他單 → 不動', () => {
    const { values, state } = steady();
    values[mom('R1')] = 12; // 目標 6.36（總資產 106），偏離 +89%
    const p = planDay({ cfg, values, state, monthly: monthly() });
    expect(p.targets[mom('R1')]).toBe(12);
    expect(p.events.map((e) => e.kind)).toContain('LAZY_SKIPPED');
    expect(summarizeOrders(cfg, values, p).orders).toEqual([]);
  });
  it('留任股偏離超過 ±50%，本月有換股 → 一起拉回（搭便車）', () => {
    const { values, state } = steady();
    values[mom('R1')] = 12;
    const o = order30.filter((t) => t !== 'R4'); // R4 掉出股票池
    const p = planDay({ cfg, values, state, monthly: monthly({ order: o }) });
    expect(p.targets[mom('R1')]).toBeCloseTo(106 * 0.06, 9);
    expect(p.why[mom('R1')]).toBe('動能比例回調');
    const s = summarizeOrders(cfg, values, p);
    expect(s.reasons).toEqual(['動能換股', '動能比例回調']);
    expect(s.ratioOnly).toBe(false);
  });
  it('不搭便車的設定（B-5 的做法）：偏離就拉回，算「只因比例」的下單日', () => {
    const { values, state } = steady();
    values[mom('R1')] = 12;
    const p = planDay({ cfg: { ...cfg, piggyback: false }, values, state, monthly: monthly() });
    expect(p.targets[mom('R1')]).toBeCloseTo(106 * 0.06, 9);
    expect(summarizeOrders(cfg, values, p).ratioOnly).toBe(true);
  });
  it('上次的策略單沒照做 → 這個月把差額再列一次（設計 §2.3.1）', () => {
    const { values, state } = steady();
    delete values[mom('R5')]; // 上個月的進場沒買
    values[VOO] = 56;
    const p = planDay({ cfg, values, state, monthly: monthly({ owed: ['R5'] }) });
    expect(p.targets[mom('R5')]).toBeCloseTo(6, 9);
    expect(p.why[mom('R5')]).toBe('策略單補做');
  });
});

describe('依波動度減碼與崩盤規則的資金流（設計 §4.1、§4.4）', () => {
  const hist = Array.from({ length: 24 }, () => 0.2);
  it('比例 1 → 2/3：5 檔都降到 4%，減下來的 10% 進 VOO', () => {
    const { values, state } = steady();
    state.volHist = hist;
    state.volW = 1;
    const p = planDay({ cfg, values, state, monthly: monthly({ excessVol: () => 0.2 / 0.8 }) });
    for (const t of state.heldMom) {
      expect(p.targets[mom(t)]).toBeCloseTo(4, 9);
      expect(p.why[mom(t)]).toBe('波動度減碼');
    }
    expect(p.targets[VOO]).toBeCloseTo(60, 9);
    expect(p.state.volW).toBeCloseTo(2 / 3, 12);
    expect(p.state.volHist).toHaveLength(25);
  });
  it('崩盤規則啟動：核心一半換現金、動能部位減半', () => {
    const { values, state } = steady();
    const p = planDay({ cfg, values, state, monthly: monthly({ coreBelow200: true }) });
    for (const t of state.heldMom) expect(p.targets[mom(t)]).toBeCloseTo(3, 9);
    // 核心 = 100 − 20 − 15 = 65，一半現金
    expect(p.targets[CCASH]).toBeCloseTo(32.5, 9);
    expect(p.targets[VOO]).toBeCloseTo(32.5, 9);
    expect(p.targets[own('MU')]).toBe(10); // 自選桶不受影響
    expect(p.crashChanged).toBe(true);
    expect(p.state.crash).toBe(true);
    expect(summarizeOrders(cfg, values, p).reasons).toEqual(['崩盤規則']);
  });
  it('崩盤規則解除：現金全部換回 VOO、動能恢復', () => {
    const { values, state } = steady();
    state.crash = true;
    state.effPrev = 0.5;
    for (const t of state.heldMom) values[mom(t)] = 3;
    values[VOO] = 32.5;
    values[CCASH] = 32.5;
    const p = planDay({ cfg, values, state, monthly: monthly({ coreBelow200: false }) });
    for (const t of state.heldMom) expect(p.targets[mom(t)]).toBeCloseTo(6, 9);
    expect(p.targets[CCASH]).toBe(0);
    expect(p.targets[VOO]).toBeCloseTo(50, 9);
  });
  it('全系統只有崩盤規則能讓錢變成現金：平時任何減碼都進 VOO', () => {
    const { values, state } = steady();
    state.volHist = hist;
    state.volW = 1;
    const p = planDay({ cfg, values, state, ownActions: { MU: 'REDUCE' }, monthly: monthly({ excessVol: () => 0.5 }) });
    expect(p.targets[CCASH] ?? 0).toBe(0);
  });
});

describe('上限（設計 §2.2）', () => {
  it('單檔上限：自選單檔超過 15% → 月報減回 10%，可以只有這張單', () => {
    const { values, state } = steady();
    values[own('NVDA')] = 20; // 總資產 110，占 18.2%
    const p = planDay({ cfg, values, state, monthly: monthly() });
    expect(p.targets[own('NVDA')]).toBeCloseTo(11, 9);
    expect(p.why[own('NVDA')]).toBe('單檔上限');
    const s = summarizeOrders(cfg, values, p);
    expect(s.reasons).toEqual(['單檔上限']);
    expect(s.ratioOnly).toBe(true);
  });
  it('單檔 15% 以內不動；不是月報日也不檢查', () => {
    const { values, state } = steady();
    values[own('NVDA')] = 15; // 14.3%
    expect(planDay({ cfg, values, state, monthly: monthly() }).targets[own('NVDA')]).toBe(15);
    values[own('NVDA')] = 30;
    expect(planDay({ cfg, values, state }).targets[own('NVDA')]).toBe(30);
  });
  it('跨桶上限（買進）：自選已有 7%，動能最多買到合計 10%，被擋下的留在核心', () => {
    const { values, state } = steady();
    values[own('MU')] = 7;
    values[VOO] = 53;
    const o = ['MU', ...order30.filter((t) => t !== 'R5')]; // MU 排名第 1，R5 掉出股票池
    const p = planDay({ cfg, values, state, monthly: monthly({ order: o }) });
    expect(p.targets[mom('MU')]).toBeCloseTo(3, 9);
    expect(p.events).toContainEqual({ kind: 'CROSS_LIMIT_BUY', ticker: 'MU' });
    // R5 賣 6、MU 只買 3 → 多的 3 留在核心
    expect(p.targets[VOO]).toBeCloseTo(56, 9);
  });
  it('跨桶上限（減碼）：自選＋動能合計超過 15% → 減回 10%，先減動能', () => {
    const { values, state } = steady();
    state.heldMom = ['MU', 'R2', 'R3', 'R4', 'R5'];
    delete values[mom('R1')];
    values[mom('MU')] = 8;
    values[own('MU')] = 9; // 合計 17 / 102 = 16.7%
    const o = ['MU', ...order30];
    const p = planDay({ cfg, values, state, monthly: monthly({ order: o }) });
    const T = sum(values);
    expect(p.targets[mom('MU')]).toBeCloseTo(0.1 * T - 9, 9);
    expect(p.targets[own('MU')]).toBe(9);
    expect(p.why[mom('MU')]).toBe('跨桶上限');
    expect(sum(p.targets)).toBeCloseTo(T, 9);
  });
  it('跨桶上限：動能那部分減完還不夠 → 再減自選；錢不會不見', () => {
    const { values, state } = steady();
    state.heldMom = ['MU', 'R2', 'R3', 'R4', 'R5'];
    delete values[mom('R1')];
    values[mom('MU')] = 2;
    values[own('MU')] = 14.5; // 單檔 14.5 / 100.5 = 14.4%（沒超過單檔上限），合計 16.4%
    const o = ['MU', ...order30];
    const p = planDay({ cfg, values, state, monthly: monthly({ order: o }) });
    const T = sum(values);
    expect(p.targets[mom('MU')]).toBeCloseTo(0, 9);
    expect(p.targets[own('MU')]).toBeCloseTo(0.1 * T, 9);
    expect(sum(p.targets)).toBeCloseTo(T, 9);
  });
  it('Python 回測的行為（crossTrimAlways = false）：回調被搭便車撤回時，跨桶上限沒有檢查', () => {
    const { values, state } = steady();
    state.heldMom = ['MU', 'R2', 'R3', 'R4', 'R5'];
    delete values[mom('R1')];
    values[mom('MU')] = 8;
    values[own('MU')] = 9;
    const p = planDay({ cfg: { ...cfg, crossTrimAlways: false }, values, state, monthly: monthly({ order: ['MU', ...order30] }) });
    expect(p.targets[mom('MU')]).toBe(8);
  });
  it('自選桶合計不設上限：自選占 30% 也不會被賣', () => {
    const { values, state } = steady();
    values[own('MU')] = 14;
    values[own('NVDA')] = 14;
    state.own.META = { applied: 'STD', stdWeight: 0.05 };
    values[own('META')] = 14;
    const p = planDay({ cfg, values, state, monthly: monthly() });
    for (const t of ['MU', 'NVDA', 'META']) expect(p.targets[own(t)]).toBe(14);
  });
});

describe('入金（設計 §2.1.1）：只買不賣', () => {
  it('依序補「低於目標最多」的格子；缺口 < 0.25% 不補；剩下的進 VOO', () => {
    const { values, state } = steady();
    values[own('MU')] = 6; // 入金後目標 11 → 缺 5
    values[mom('R1')] = 4; // 目標 6.6 → 缺 2.6
    values[VOO] = 56;
    const p = planDay({ cfg, values, state, flow: { kind: '入金', amount: 10 } });
    expect(p.total).toBeCloseTo(110, 9);
    expect(p.targets[own('MU')]).toBeCloseTo(11, 9);
    expect(p.targets[mom('R1')]).toBeCloseTo(6.6, 9);
    // NVDA 缺 1、R2–R5 各缺 0.6：都大於 0.25% × 110 = 0.275，依序補；補到錢用完
    // 10 − 5 − 2.6 = 2.4 → NVDA 1 → 剩 1.4 → 兩檔動能各 0.6 → 剩 0.2 給下一檔
    expect(p.targets[own('NVDA')]).toBeCloseTo(11, 9);
    expect(sum(p.targets)).toBeCloseTo(110, 9);
    expect(p.targets[VOO]).toBeCloseTo(56, 9);
    // 沒有任何一格被賣
    for (const k of Object.keys(values)) expect(p.targets[k]).toBeGreaterThanOrEqual(values[k] - 1e-9);
  });
  it('都在目標附近 → 全部進 VOO；崩盤規則啟動時一半放現金', () => {
    const { values, state } = steady();
    for (const t of ['MU', 'NVDA']) values[own(t)] = 10.2;
    for (const t of state.heldMom) values[mom(t)] = 6.1;
    const p = planDay({ cfg, values, state, flow: { kind: '入金', amount: 1 } });
    expect(p.targets[VOO]).toBeCloseTo(51, 9);
    const s2 = { ...state, crash: true, effPrev: 0.5 };
    const p2 = planDay({ cfg, values, state: s2, flow: { kind: '入金', amount: 1 } });
    expect(p2.targets[VOO]).toBeCloseTo(50.5, 9);
    expect(p2.targets[CCASH]).toBeCloseTo(0.5, 9);
  });
  it('減半狀態的自選，目標是標準比重的一半', () => {
    const { values, state } = steady();
    state.own.MU.applied = 'HALF';
    values[own('MU')] = 3;
    const p = planDay({ cfg, values, state, flow: { kind: '入金', amount: 7 } });
    expect(p.targets[own('MU')]).toBeCloseTo(0.05 * 100, 9); // 總資產 93 + 7 = 100，目標 5
  });
  it('入金日當天一定有清單（就算金額小於門檻）', () => {
    const { values, state } = steady();
    const p = planDay({ cfg, values, state, flow: { kind: '入金', amount: 0.1 } });
    const s = summarizeOrders(cfg, values, p, '入金');
    expect(s.orders.length).toBeGreaterThan(0);
    expect(s.reasons).toContain('入金');
  });
  it('入金遇到月報日：合成一份（先入金，再跑月報規則）', () => {
    const { values, state } = steady();
    const o = order30.filter((t) => t !== 'R4');
    const p = planDay({ cfg, values, state, flow: { kind: '入金', amount: 10 }, monthly: monthly({ order: o }) });
    expect(p.targets[mom('R4')]).toBe(0);
    expect(p.targets[mom('R6')]).toBeCloseTo(110 * 0.06, 9);
    expect(sum(p.targets)).toBeCloseTo(110, 9);
    expect(summarizeOrders(cfg, values, p, '入金').reasons).toEqual(['入金', '動能換股']);
  });
});

describe('出金（設計 §2.1.1）：只賣不買', () => {
  it('順序 ①：崩盤規則啟動中，先用核心的現金', () => {
    const { values, state } = steady();
    state.crash = true;
    state.effPrev = 0.5;
    for (const t of state.heldMom) values[mom(t)] = 3;
    values[VOO] = 32.5;
    values[CCASH] = 32.5;
    const p = planDay({ cfg, values, state, flow: { kind: '出金', amount: 25 } });
    expect(p.targets[CCASH]).toBeCloseTo(7.5, 9);
    expect(p.targets[VOO]).toBe(32.5);
    expect(sum(p.targets)).toBeCloseTo(75, 9);
  });
  it('順序 ② → ③：先賣動能高於目標的部分，再賣 VOO', () => {
    const { values, state } = steady();
    values[mom('R1')] = 9; // 出金後總資產 93，目標 5.58 → 高出 3.42
    const p = planDay({ cfg, values, state, flow: { kind: '出金', amount: 10 } });
    const T = 93;
    expect(p.targets[mom('R1')]).toBeCloseTo(T * 0.06, 9);
    // 其餘 4 檔各高出 0.42 → 也賣到目標；剩下的賣 VOO
    for (const t of ['R2', 'R3', 'R4', 'R5']) expect(p.targets[mom(t)]).toBeCloseTo(T * 0.06, 9);
    expect(p.targets[VOO]).toBeCloseTo(50 - (10 - 3.42 - 4 * 0.42), 9);
    expect(p.targets[own('MU')]).toBe(10); // 自選最後才動
    for (const k of Object.keys(values)) expect(p.targets[k]).toBeLessThanOrEqual(values[k] + 1e-9);
  });
  it('大額出金：自選先被單檔上限減回 10%，再照順序賣', () => {
    const { values, state } = steady();
    const p = planDay({ cfg, values, state, flow: { kind: '出金', amount: 85 } });
    // 出金後總資產 15：自選各 10 > 15% → 減回 1.5（抵 17）；動能高於目標 0.9 的部分 25.5；其餘 42.5 賣 VOO
    expect(p.targets[own('MU')]).toBeCloseTo(1.5, 9);
    expect(p.targets[own('NVDA')]).toBeCloseTo(1.5, 9);
    for (const t of state.heldMom) expect(p.targets[mom(t)]).toBeCloseTo(0.9, 9);
    expect(p.targets[VOO]).toBeCloseTo(7.5, 9);
  });
  it('順序 ④：VOO 賣完才按比例賣動能', () => {
    const { values, state } = steady();
    state.effPrev = null; // 動能還沒有目標（沒有「高於目標」可賣）
    values[own('MU')] = 1;
    values[own('NVDA')] = 1;
    values[VOO] = 10;
    const p = planDay({ cfg, values, state, flow: { kind: '出金', amount: 41 } });
    // 出金後總資產 1：自選各減回 0.1（抵 1.8）→ VOO 10 → 動能 30 按比例賣到剩 0.8
    expect(p.targets[VOO]).toBeCloseTo(0, 9);
    for (const t of state.heldMom) expect(p.targets[mom(t)]).toBeCloseTo(0.16, 9);
    expect(p.targets[own('MU')]).toBeCloseTo(0.1, 9);
    expect(sum(p.targets)).toBeCloseTo(1, 9);
  });
  it('順序 ⑤：其他都沒有了，最後才按比例賣自選', () => {
    const state = emptyRuleState();
    const values: CellMap = {};
    for (let i = 0; i < 12; i++) {
      state.own['S' + i] = { applied: 'STD', stdWeight: 0.01 };
      values[own('S' + i)] = 1;
    }
    const p = planDay({ cfg, values, state, flow: { kind: '出金', amount: 6 } });
    for (let i = 0; i < 12; i++) expect(p.targets[own('S' + i)]).toBeCloseTo(0.5, 9);
  });
  it('單檔上限預先檢查：出金後會超過 15% 的自選股，同一份清單減回 10%，錢抵出金', () => {
    const { values, state } = steady();
    values[own('NVDA')] = 14; // 現在 13.5%；出金 25 後 17.7%
    const p = planDay({ cfg, values, state, flow: { kind: '出金', amount: 25 } });
    const T = 104 - 25;
    expect(p.targets[own('NVDA')]).toBeCloseTo(0.1 * T, 9);
    expect(p.why[own('NVDA')]).toBe('單檔上限');
    expect(sum(p.targets)).toBeCloseTo(T, 9);
    // 之後的月報不會再為單檔上限賣一次
    const next = planDay({ cfg, values: p.targets, state: p.state, monthly: monthly() });
    expect(next.targets[own('NVDA')]).toBeCloseTo(0.1 * T, 9);
  });
});

describe('合併下單（設計 §2.3）', () => {
  it('同一代號兩桶的單合成一個淨額', () => {
    const { values, state } = steady();
    // MU 自選減半（賣 5），同月 MU 進動能名單（買）
    values[own('MU')] = 4;
    values[VOO] = 56;
    const o = ['MU', ...order30.filter((t) => t !== 'R5')];
    const p = planDay({ cfg, values, state, ownActions: { MU: 'REDUCE' }, monthly: monthly({ order: o }) });
    expect(p.targets[own('MU')]).toBeCloseTo(2, 9);
    expect(p.targets[mom('MU')]).toBeCloseTo(6, 9);
    const s = summarizeOrders(cfg, values, p);
    expect(s.net.MU).toBeCloseTo(4, 9); // −2 ＋ 6
    expect(s.orders.find((x) => x.ticker === 'MU')!.amount).toBeCloseTo(4, 9);
    expect(s.reasons).toEqual(['動能換股', '自選訊號']);
  });
  it('小於總資產 0.25% 的淨額不算一張單', () => {
    const { values, state } = steady();
    values[own('MU')] = 0.4;
    const p = planDay({ cfg, values, state, ownActions: { MU: 'REDUCE' } });
    expect(summarizeOrders(cfg, values, p).orders).toEqual([]);
  });
});

describe('通知分級（設計 §2.5，B-7）', () => {
  it('標準比重 5% 的股票減半只變動 2.5% → 等月報；占 12.4% 的減半變動 6.2% → 當天', () => {
    expect(ownSignalTier(2.5, 100, cfg)).toBe('MONTHLY');
    expect(ownSignalTier(6.2, 100, cfg)).toBe('SAME_DAY');
    expect(ownSignalTier(5, 100, cfg)).toBe('SAME_DAY');
  });
  it('平日只執行夠大的自選訊號；月報日全部執行', () => {
    const { values, state } = steady();
    values[own('NVDA')] = 12.4;
    const pending = { MU: 'REDUCE', NVDA: 'REDUCE' } as const;
    const a = dueOwnActions({ cfg, pending, state, values, isMonthly: false });
    expect(a.todo).toEqual({ NVDA: 'REDUCE' });
    expect(a.urgent).toBe(true);
    const b = dueOwnActions({ cfg, pending, state, values, isMonthly: true });
    expect(b.todo).toEqual(pending);
  });
  it('加回的變動 = 標準比重 − 目前市值', () => {
    const { values, state } = steady();
    state.own.MU = { applied: 'HALF', stdWeight: 0.12 };
    values[own('MU')] = 5; // 加回 12% × 105 − 5 = 7.6 → 7.2% ≥ 5%
    expect(dueOwnActions({ cfg, pending: { MU: 'READD' }, state, values, isMonthly: false }).todo).toEqual({ MU: 'READD' });
    state.own.MU.stdWeight = 0.08; // 3.4 → 3.2%
    expect(dueOwnActions({ cfg, pending: { MU: 'READD' }, state, values, isMonthly: false }).todo).toEqual({});
  });
  it('使用者觸發的事件當天給清單；規則類等月報', () => {
    expect(reasonTier('入金')).toBe('SAME_DAY');
    expect(reasonTier('出金')).toBe('SAME_DAY');
    expect(reasonTier('改比例')).toBe('SAME_DAY');
    expect(reasonTier('動能換股')).toBe('MONTHLY');
    expect(reasonTier('崩盤規則')).toBe('MONTHLY');
    expect(reasonTier('單檔上限')).toBe('MONTHLY');
  });
});

describe('清單以整股為單位（設計 §2.1.1）', () => {
  const price = (t: string) => ({ MU: 100, NVDA: 200, VOO: 500, SGOV: 100, R1: 50, R6: 30 })[t] ?? 100;
  const coreCtx = { cfg, price, bondTicker: 'SGOV', crash: false };

  it('慢規則減半：MU 50 股 → 賣 25 股；賣得的錢買 VOO（買單不超過現金＋賣單的 98%）', () => {
    const shares = { [own('MU')]: 50, [VOO]: 100 };
    const values = valuesFromShares(shares, price, 0);
    const state: RuleState = { ...emptyRuleState(), own: { MU: { applied: 'STD', stdWeight: 0.1 } }, effPrev: 1 };
    const p = planDay({ cfg, values, state, ownActions: { MU: 'REDUCE' } });
    const lines = planToLines(p, values, { price, shares });
    expect(lines).toEqual([{ ticker: 'MU', bucket: 'own', shares: -25, reason: '自選訊號' }]);
    const c = composeWithCore(lines, { ...coreCtx, cash: 0, coreShares: 100, bondShares: 0, total: 55000 });
    // 賣得 2500 × 98% = 2450 → VOO 4 股（2000）
    expect(c.merged).toEqual([
      { ticker: 'MU', shares: -25, parts: [lines[0]] },
      { ticker: 'VOO', shares: 4, parts: [expect.objectContaining({ bucket: 'core', shares: 4 })] },
    ]);
    expect(c.cashAfter).toBe(500);
  });
  it('奇數股減半四捨五入；出場賣光；買進無條件捨去', () => {
    const shares = { [own('MU')]: 25, [mom('R1')]: 37, [VOO]: 100 };
    const values = valuesFromShares(shares, price, 0);
    const state: RuleState = {
      ...emptyRuleState(),
      own: { MU: { applied: 'STD', stdWeight: 0.05 } },
      heldMom: ['R1'],
      effPrev: 1,
    };
    const p = planDay({ cfg, values, state, ownActions: { MU: 'REDUCE' }, monthly: monthly({ order: ['R6', 'R2'] }) });
    const lines = planToLines(p, values, { price, shares });
    expect(lines).toContainEqual({ ticker: 'MU', bucket: 'own', shares: -13, reason: '自選訊號' });
    expect(lines).toContainEqual({ ticker: 'R1', bucket: 'mom', shares: -37, reason: '動能換股' });
    // 總資產 54350，動能每檔 6% = 3261 → R6（30 元）108 股
    expect(lines).toContainEqual({ ticker: 'R6', bucket: 'mom', shares: 108, reason: '動能換股' });
  });
  it('錢不夠時從核心拿：平時賣 VOO，崩盤規則啟動時先用短債', () => {
    const buy = [{ ticker: 'NVDA', bucket: 'own' as const, shares: 10, reason: '自選訊號' }];
    const a = composeWithCore(buy, { ...coreCtx, cash: 0, coreShares: 100, bondShares: 0, total: 52000 });
    expect(a.merged.find((m) => m.ticker === 'VOO')!.shares).toBe(-5); // 2000 ÷ 0.98 ÷ 500 → 5 股
    expect(a.cashAfter).toBeGreaterThanOrEqual(0);
    const b = composeWithCore(buy, { ...coreCtx, crash: true, cash: 0, coreShares: 50, bondShares: 250, total: 52000 });
    expect(b.merged.find((m) => m.ticker === 'SGOV')!.shares).toBe(-21);
    expect(b.merged.find((m) => m.ticker === 'VOO')).toBeUndefined();
  });
  it('帳上有多的現金（例如股利）→ 清單把它交給核心；差額太小就不動', () => {
    const a = composeWithCore([], { ...coreCtx, cash: 3000, coreShares: 100, bondShares: 0, total: 53000 });
    expect(a.merged).toEqual([{ ticker: 'VOO', shares: 5, parts: [expect.objectContaining({ shares: 5 })] }]);
    const b = composeWithCore([], { ...coreCtx, cash: 100, coreShares: 100, bondShares: 0, total: 50100 });
    expect(b.merged).toEqual([]);
  });
  it('崩盤規則切換時核心自己的單：啟動 → 一半換短債；解除 → 短債全部換回', () => {
    const on = crashCoreLines({ ...coreCtx, cash: 0, coreShares: 100, bondShares: 0, total: 50000 }, true);
    expect(on).toEqual([
      { ticker: 'VOO', bucket: 'core', shares: -50, reason: '崩盤規則' },
      { ticker: 'SGOV', bucket: 'core', shares: 250, reason: '崩盤規則' },
    ]);
    const off = crashCoreLines({ ...coreCtx, crash: true, cash: 0, coreShares: 50, bondShares: 250, total: 50000 }, false);
    expect(off).toEqual([
      { ticker: 'SGOV', bucket: 'core', shares: -250, reason: '崩盤規則' },
      { ticker: 'VOO', bucket: 'core', shares: 50, reason: '崩盤規則' },
    ]);
  });
  it('同一代號兩桶對沖 → 淨額 0，保留兩行（劃撥，不用下單）', () => {
    const m = mergeByTicker([
      { ticker: 'MU', bucket: 'own', shares: -10, reason: 'x' },
      { ticker: 'MU', bucket: 'mom', shares: 10, reason: 'y' },
    ]);
    expect(m).toHaveLength(1);
    expect(m[0].shares).toBe(0);
    expect(m[0].parts).toHaveLength(2);
  });
});
