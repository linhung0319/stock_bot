// prototype/README.md 的 7 個情境：市場、起始帳戶（和 prototype/js/scenarios.js 相同的設定）。
import type { InitialAccount, Premise } from '../../src/engine';
import { makeMarket, type Market } from './market';

const P = (text: string, origin: Premise['origin'] = 'USER', id = 'P1'): Premise => ({ id, text, origin });

function own4(shares: Record<string, number>, std: Record<string, number> = {}): InitialAccount['own'] {
  return {
    MU: { shares: shares.MU, stdWeight: std.MU ?? 0.05, premises: [P('HBM 長約有價格保護，記憶體循環這次不會像以前一樣崩'), P('AI 資料中心需求至少延續到 2027', 'USER', 'P2')] },
    NVDA: { shares: shares.NVDA, stdWeight: std.NVDA ?? 0.05, premises: [P('資料中心 GPU 的領先地位兩年內不會被追上')] },
    MSFT: { shares: shares.MSFT, stdWeight: std.MSFT ?? 0.05, premises: [P('Azure 成長維持 30% 以上', 'AI_DRAFT_ACCEPTED'), P('營業利益率維持在 40% 以上', 'AI_DRAFT_ACCEPTED', 'P2')] },
    META: { shares: shares.META, stdWeight: std.META ?? 0.05 },
  };
}
const MOM5 = { PLTR: 33, AVGO: 18, NFLX: 52, AMD: 25, ORCL: 28 };
const MOM5_PLTR53 = { ...MOM5, PLTR: 53 };

export interface Scenario {
  market: Market;
  init: InitialAccount;
}

export const scenarios = {
  /** ① 平常的月報：ORCL 掉出前 15、APP 被否決由下一名遞補、PLTR 偏離搭便車、MSFT 提高到 125%。 */
  s1: (): Scenario => ({
    market: makeMarket('2026-11-23', 50, {
      over: {
        ORCL: { path: [{ n: 6, ret: -0.11 }, { n: 44, ret: 0.02 }] },
        APP: { hist: [{ n: 78, ret: 0.05 }, { n: 150, ret: 0.4 }, { n: 1, ret: 0.45, vol: 0 }, { n: 101, ret: 0.05 }] },
      },
    }),
    init: { cash: 1500, own: own4({ MU: 30, NVDA: 30, MSFT: 9, META: 6 }), mom: MOM5_PLTR53, core: { VOO: 72 } },
  }),
  /** ② 自選股大跌：MU 財報後減半（≥ 5% 當天）、F25 條件成立、之後加回；META < 5% 併入月報。 */
  s2: (): Scenario => ({
    market: makeMarket('2026-12-07', 66, {
      over: {
        MU: { r252: 0.8, path: [{ n: 8, ret: 0.03 }, { n: 1, ret: -0.11, vol: 0 }, { n: 3, ret: -0.06 }, { n: 1, ret: -0.05, vol: 0 }, { n: 8, ret: -0.04 }, { n: 10, ret: -0.03 }, { n: 25, ret: 0.24 }, { n: 10, ret: 0.03 }] },
        META: { path: [{ n: 8, ret: 0.0 }, { n: 1, ret: -0.08, vol: 0 }, { n: 5, ret: -0.15 }, { n: 52, ret: 0.04 }] },
      },
    }),
    init: { cash: 900, own: own4({ MU: 58, NVDA: 25, MSFT: 8, META: 6 }, { MU: 0.1 }), mom: MOM5, core: { VOO: 70 } },
  }),
  /** ③ 崩盤規則：啟動、V 型反彈、解除時買回更貴；MSFT 走自己的慢規則。 */
  s3: (): Scenario => ({
    market: makeMarket('2026-12-07', 66, {
      market: [{ n: 18, ret: -0.11, vol: 0.3 }, { n: 20, ret: 0.14, vol: 0.25 }, { n: 28, ret: 0.03 }],
      over: { MSFT: { path: [{ n: 18, ret: -0.2 }, { n: 20, ret: 0.1 }, { n: 28, ret: 0.03 }] } },
    }),
    init: { cash: 1500, own: own4({ MU: 30, NVDA: 30, MSFT: 9, META: 6 }), mom: MOM5, core: { VOO: 78 } },
  }),
  /** ④ 硬事件：動能持股 ORCL 被收購、自選 META 財報重編。 */
  s4: (): Scenario => ({
    market: makeMarket('2026-12-07', 45, {
      over: {
        ORCL: { path: [{ n: 3, ret: 0.0 }, { n: 1, ret: 0.22, vol: 0 }, { n: 41, ret: 0.01, vol: 0.03 }] },
        META: { path: [{ n: 6, ret: 0.01 }, { n: 1, ret: -0.09, vol: 0 }, { n: 38, ret: -0.03 }] },
        GS: { r252: 0.75 },
        APP: { r252: 0.3 },
      },
    }),
    init: { cash: 1500, own: own4({ MU: 30, NVDA: 30, MSFT: 9, META: 6 }), mom: MOM5, core: { VOO: 78 } },
  }),
  /** ⑤ 你自己的操作：入金、出金、改比例、新增自選、手動交易。MU 占約 13.5%。 */
  s5: (): Scenario => ({
    market: makeMarket('2026-12-07', 50, { over: { TSLA: { hist: [{ n: 78, ret: 0.05 }, { n: 200, ret: 0.65 }, { n: 52, ret: -0.25 }] } } }),
    init: { cash: 2000, own: own4({ MU: 56, NVDA: 25, MSFT: 8, META: 5 }, { MU: 0.08 }), mom: MOM5, core: { VOO: 64 } },
  }),
  /** ⑥ 動能落後＋波動度減碼（含遲滯）＋策略檢討。 */
  s6: (): Scenario => ({
    market: makeMarket('2026-12-07', 60, {
      over: {
        PLTR: { path: [{ n: 18, ret: -0.22, vol: 1.3 }, { n: 20, ret: 0.02, vol: 0.5 }, { n: 22, ret: 0.03, vol: 0.4 }] },
        AVGO: { path: [{ n: 18, ret: -0.14, vol: 1.0 }, { n: 20, ret: 0.01, vol: 0.4 }, { n: 22, ret: 0.02, vol: 0.35 }] },
        NFLX: { path: [{ n: 18, ret: -0.1, vol: 0.9 }, { n: 20, ret: 0.0, vol: 0.35 }, { n: 22, ret: 0.02, vol: 0.3 }] },
        AMD: { path: [{ n: 18, ret: -0.18, vol: 1.2 }, { n: 20, ret: 0.02, vol: 0.5 }, { n: 22, ret: 0.02, vol: 0.45 }] },
        ORCL: { path: [{ n: 18, ret: -0.12, vol: 1.0 }, { n: 20, ret: 0.0, vol: 0.4 }, { n: 22, ret: 0.02, vol: 0.35 }] },
      },
    }),
    init: { cash: 1500, own: own4({ MU: 30, NVDA: 30, MSFT: 9, META: 6 }), mom: MOM5, core: { VOO: 78 } },
  }),
  /** ⑦ 沒照做、忘了、做錯：NVDA 占約 13%，12/10 減半當天通知，之後很快反彈。 */
  s7: (): Scenario => ({
    market: makeMarket('2026-11-23', 50, {
      over: {
        ORCL: { path: [{ n: 6, ret: -0.11 }, { n: 44, ret: 0.02 }] },
        APP: { hist: [{ n: 78, ret: 0.05 }, { n: 150, ret: 0.4 }, { n: 1, ret: 0.45, vol: 0 }, { n: 101, ret: 0.05 }] },
        NVDA: { r252: 0.55, path: [{ n: 8, ret: 0.02 }, { n: 4, ret: -0.235 }, { n: 10, ret: 0.14 }, { n: 28, ret: 0.04 }] },
      },
    }),
    init: { cash: 1500, own: own4({ MU: 30, NVDA: 70, MSFT: 9, META: 6 }, { NVDA: 0.1 }), mom: MOM5_PLTR53, core: { VOO: 60 } },
  }),
};
