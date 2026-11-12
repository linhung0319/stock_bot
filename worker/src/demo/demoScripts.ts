// 示範模式的腳本：每個情境要餵給引擎的 AI 輸入（和 test/scenarios.test.ts 餵的一樣），
// 以及給網站顯示的 AI 說明。AI 層還沒做（T9 之後），這裡的 AI 內容全部是虛構的。
import type { Tier } from '../engine';
import type { AiNote } from '../app/site/types';

export type DemoId = 's1' | 's2' | 's5';

export interface DemoScript {
  id: DemoId;
  title: string;
  summary: string;
  /** 可以試的事（示範列上顯示）。 */
  tips: string[];
  /** 情境從這一天的早上開始讓使用者操作。 */
  startAt: string;
  /** 月份 → 本月被否決的代號。 */
  vetoes?: Record<string, string[]>;
  /** on 那一天早上（月報之前）記下的 F24 檔位。 */
  aiTiers?: { on: string; ticker: string; tier: Tier; date: string; suggest: boolean }[];
  /** on 那一天收盤後成立的條件（F25）。 */
  conditions?: { on: string; ticker: string; tier: Tier; text: string }[];
  /** 新增自選時 AI 草擬的前提（代號 → 草稿）。 */
  drafts?: Record<string, { text: string; breaksIf: string }[]>;
  notes: AiNote[];
}

const MU_CONDITIONS: AiNote['conditions'] = [
  { kind: '財報', text: '毛利率低於 80%（最新一季 84.6%）', then: '減半' },
  { kind: '事件', text: 'DRAM/HBM 合約價走平或下跌', then: '出清' },
  { kind: '價格', text: '收盤跌回 196 以下（11/14 整理區間最低收盤）', then: '只記錄，不通知' },
];

export const DEMO_SCRIPTS: Record<DemoId, DemoScript> = {
  s1: {
    id: 's1',
    title: '平常的月報',
    summary: '12/1 的月報：ORCL 掉出前 15 名要賣、APP 被 AI 否決改買 GE、PLTR 漲太多順便調回、AI 建議提高 MSFT 的比重。',
    tips: ['把 MSFT 那一項改成「照 AI」，看核心（VOO）那一行怎麼跟著變', '在 GE 按「排除」，看系統改買哪一檔', '在 ORCL 按「我想留著」，把它轉入自選', '其中一項選「這次不做」，再跳到 1 月的月報看它有沒有再列一次'],
    startAt: '2026-12-01',
    vetoes: { '2026-12': ['APP'] },
    aiTiers: [{ on: '2026-12-01', ticker: 'MSFT', tier: 'RAISE', date: '2026-11-30', suggest: true }],
    notes: [
      {
        kind: 'VETO',
        ticker: 'APP',
        date: '2026-11-30',
        verdict: '否決本月進場',
        votes: '3 票一致',
        summary: 'APP 這 12 個月的漲幅有 58% 來自 6 月的一次跳空（納入指數和財報同一天），之後 5 個月相對大盤沒有再漲。動能要的是「慢慢反映」的漲勢，這不是。下個月重新審查。',
        quotes: [
          { source: '價格資料（程式算）', date: '2026-06-18', quote: '單日 +45%，占 12 個月漲幅的 58%' },
          { source: '8-K Item 2.02', date: '2026-06-17', quote: '（虛構）第二季營收優於預期並調高全年展望' },
        ],
        sections: [
          { title: '檢方', text: '漲幅集中在 6/18 一天；之後股價和大盤同步，沒有「資訊慢慢反映」的跡象。' },
          { title: '辯方', text: '跳空來自財報上修，屬於基本面；但也承認跳空後沒有延續。' },
          { title: '法官 ×3', text: '前提「漲勢來自資訊慢慢反映」不成立 ×3。' },
        ],
        fake: true,
      },
      {
        kind: 'REVIEW',
        ticker: 'MSFT',
        date: '2026-11-30',
        verdict: '提高到標準的 125%',
        votes: '3 票一致',
        summary: '你的兩條前提都成立：最新一季 Azure 成長 34%、營業利益率 46%。股價在 200 日均線之上已連續 6 個月以上，符合可以提高比重的規則條件。',
        premises: [
          { text: 'Azure 成長維持 30% 以上', origin: 'AI_DRAFT_ACCEPTED', status: 'HOLDS', evidence: '10-Q：Azure 與其他雲端服務營收年增 34%（虛構）' },
          { text: '營業利益率維持在 40% 以上', origin: 'AI_DRAFT_ACCEPTED', status: 'HOLDS', evidence: 'XBRL：營業利益率 46%（虛構）' },
        ],
        conditions: [
          { kind: '財報', text: '營業利益率低於 40%', then: '回到標準' },
          { kind: '事件', text: '大型 AI 客戶公開轉移雲端供應商', then: '回到標準' },
        ],
        fake: true,
      },
    ],
  },
  s2: {
    id: 's2',
    title: '自選股大跌',
    summary: 'MU 占帳戶約 14%。財報後下跌，12/24 觸發慢規則減半（當天通知）；1 月 AI 的條件成立、建議出清；META 也跌破 -20% 但部位小，併入 1 月月報，AI 說不動。',
    tips: ['MU 減半：規則和 AI 這次是同一個動作，只有一行', '跳到 1/4 的月報：META 規則說減半、AI 說不動，兩個並列', '跳到 1/7：AI 的條件成立，建議出清 MU（規則沒有動作）'],
    startAt: '2026-12-28',
    aiTiers: [
      { on: '2026-12-18', ticker: 'MU', tier: 'HALF', date: '2026-12-18', suggest: true },
      { on: '2026-12-31', ticker: 'META', tier: 'HOLD', date: '2026-12-31', suggest: false },
      { on: '2027-02-26', ticker: 'MU', tier: 'HALF', date: '2027-02-26', suggest: false },
    ],
    conditions: [{ on: '2027-01-06', ticker: 'MU', tier: 'EXIT', text: 'DRAM/HBM 合約價走平或下跌' }],
    notes: [
      {
        kind: 'REVIEW',
        ticker: 'MU',
        date: '2026-12-18',
        verdict: '減半',
        votes: '3 票一致',
        summary: '你的前提「HBM 長約有價格保護」不成立：財報新聞稿寫明部分 HBM 合約重新議價。另一條前提（AI 資料中心需求延續到 2027）仍成立。',
        premises: [
          { text: 'HBM 長約有價格保護，記憶體循環這次不會像以前一樣崩', origin: 'USER', status: 'BROKEN', evidence: '8-K 2.02 附件：「certain HBM contracts were renegotiated」（虛構）' },
          { text: 'AI 資料中心需求至少延續到 2027', origin: 'USER', status: 'HOLDS', evidence: '超大型雲端業者上修資本支出指引（虛構）' },
        ],
        conditions: MU_CONDITIONS,
        sections: [
          { title: '多方', text: 'AI 需求仍在，毛利率下滑是一次性。' },
          { title: '空方', text: '合約重新議價代表價格保護不存在，第一條前提的根基沒了。' },
          { title: '經理 ×3', text: '減半 ×3。' },
        ],
        fake: true,
      },
      {
        kind: 'REVIEW',
        ticker: 'META',
        date: '2026-12-31',
        verdict: '不動',
        votes: '3 票一致',
        summary: '這次下跌拆開來看：大盤 -2%、產業 -9%、個股 -10%。個股的部分來自監管新聞，但沒有罰款金額或禁令；系統預設的前提都還成立。',
        premises: [
          { text: '沒有硬事件（重編、換會計師、被收購、重大監管）', origin: 'SYSTEM_DEFAULT', status: 'HOLDS', evidence: '只有新聞報導，沒有 8-K 或主管機關公告（虛構）' },
          { text: '營收年增率沒有連兩季轉負', origin: 'SYSTEM_DEFAULT', status: 'HOLDS' },
          { text: '稀釋 EPS 沒有連兩季年減', origin: 'SYSTEM_DEFAULT', status: 'HOLDS' },
        ],
        fake: true,
      },
      {
        kind: 'CONDITION',
        ticker: 'MU',
        date: '2027-01-06',
        verdict: '條件成立，建議出清',
        votes: '3 票確認',
        summary: '12/18 審查時寫下的條件「DRAM/HBM 合約價走平或下跌」成立：產業報告指出第一季 DRAM 合約價季減 8%，HBM3E 報價首度鬆動。',
        quotes: [{ source: '產業新聞（TrendForce，虛構）', date: '2027-01-06', quote: '第一季 DRAM 合約價季減 8%，HBM3E 報價首度鬆動' }],
        conditions: MU_CONDITIONS,
        fake: true,
      },
      {
        kind: 'REVIEW',
        ticker: 'MU',
        date: '2027-02-26',
        verdict: '減半',
        votes: '3 票一致',
        summary: '股價已回到高點附近，但前提「HBM 長約有價格保護」仍不成立，兩條條件也都已成立。反彈不是前提恢復的證據。',
        premises: [
          { text: 'HBM 長約有價格保護，記憶體循環這次不會像以前一樣崩', origin: 'USER', status: 'BROKEN' },
          { text: 'AI 資料中心需求至少延續到 2027', origin: 'USER', status: 'HOLDS' },
        ],
        fake: true,
      },
    ],
  },
  s5: {
    id: 's5',
    title: '你自己的操作',
    summary: '平靜的市場，沒有待辦。試試入金、出金、改比例、新增自選，或自己交易後填快照。MU 占約 13.5%，大額出金會先碰到單檔上限。',
    tips: ['入金 10,000：看錢怎麼分', '出金 30,000：MU 會先被減回 10%', '把動能比例改成 0%', '新增自選 TSLA：它已經跌超過 20%，一開始只買一半', '填快照時多填 10 股 AAPL（清單上沒有），看系統怎麼問'],
    startAt: '2026-12-10',
    drafts: {
      TSLA: [
        { text: '自駕計程車在 2027 年擴大到 10 個城市（目前價格隱含的成長）', breaksIf: '主要城市的營運許可被撤回' },
        { text: '汽車毛利率止跌（最近一季 17%）', breaksIf: '汽車毛利率連兩季低於 15%' },
        { text: '執行長的注意力與持股質押沒有變化（不容易想到的風險）', breaksIf: '執行長出售或質押大量持股' },
      ],
    },
    notes: [],
  },
};

export const DEMO_IDS = Object.keys(DEMO_SCRIPTS) as DemoId[];
