// 示範模式的腳本：每個情境要餵給引擎的 AI 輸入（和 test/scenarios.test.ts 餵的一樣），
// 以及給網站顯示的 AI 說明。AI 層已經上線，但示範模式不連真的 AI：這裡的 AI 內容全部是虛構的。
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
  /** on 那一天早上（月報之前）記下的 F24 檔位。premiseId：三票都判不成立的那條前提（有的話算三票一致，慢規則通知上才會列「照 AI」；own_thesis §3.4）。 */
  aiTiers?: { on: string; ticker: string; tier: Tier; date: string; suggest: boolean; premiseId?: string }[];
  /**
   * on 那一天收盤後比高點低 20% 觸發時，AI 論點檢查的結果：通知上 AI 的那一行照它寫。
   *   只有預設前提的股票（減半檢視，own_thesis §3.3）：EXIT／AGREE／NONE
   *   有論點的股票（跌幅審查，allocation_redesign §3.2）：BROKEN（前提不成立；exit = 3 票都選出清）／CLEAR／SPLIT／NONE；attr 是跌幅拆解（只顯示）
   * 有論點的股票腳本沒寫的：示範模式沒有 AI 層，記成沒跑完（不動）。
   */
  drops?: { on: string; ticker: string; status: 'EXIT' | 'AGREE' | 'NONE' | 'BROKEN' | 'CLEAR' | 'SPLIT'; cause?: string; premiseId?: string; exit?: boolean; votes?: number; attr?: { stock: number; market: number; sector: number | null; idio: number } }[];
  /** on 那一天收盤後成立的你定的條件（甲類通知，own_thesis §1.10）：setAt 哪天勾選的、why 怎麼確認的。 */
  conditions?: { on: string; ticker: string; action: 'EXIT' | 'HALF'; text: string; setAt: string; why: string }[];
  /** on 那一天收盤後 AI 審查判前提不成立的當天通知（乙類，own_thesis §1.10）。 */
  breaks?: { on: string; ticker: string; tier: 'EXIT' | 'HALF'; premiseId: string; basis: string }[];
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
    tips: ['把 MSFT 那一項改成「照 AI」，看核心（VOO、SGOV）那幾行怎麼跟著變', '在 GE 按「排除」，看系統改買哪一檔', '在 ORCL 按「我想留著」，把它轉入自選', '其中一項選「這次不做」，再跳到 1 月的月報看它有沒有再列一次'],
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
        summary: '你的兩條前提都成立：最新一季 Azure 成長 34%、營業利益率 46%。上一次財報後的審查也證實了這兩條，最近兩季營收年增都是正的，符合可以提高比重的規則條件。',
        premises: [
          { text: 'Azure 成長維持 30% 以上', origin: 'AI_DRAFT_ACCEPTED', status: 'HOLDS', evidence: '10-Q：Azure 與其他雲端服務營收年增 34%（虛構）' },
          { text: '營業利益率維持在 40% 以上', origin: 'AI_DRAFT_ACCEPTED', status: 'HOLDS', evidence: '財報數字：營業利益率 46%（虛構）' },
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
    summary: 'MU 占帳戶約 14%。財報後下跌，12/24 比高點低 20%，觸發跌幅審查：3 票判一條前提不成立 → 預設減半（當天通知）；1 月你定的出場條件成立、照當時的決定出清；META 也跌破 -20%，它還沒有你的論點，照慢規則減半，部位小、併入 1 月月報；1/13 MSFT 也跌破 -20%，論點檢查沒有前提被判不成立 → 不減半（不用回覆）；1/21 AI 審查認為 NVDA 的前提不成立。',
    tips: ['MU 有你的論點：跌 20% 只觸發論點檢查。這次 3 票判前提「HBM 長約有價格保護」不成立，所以預設減半；選「這次不做」要寫一句理由，而且之後再跌到 -30% 會重新審查', '跳到 1/4 的月報：META 還沒有你的論點，AI 只檢查系統預設前提，同意減半',  '跳到 1/7：你定的出場條件成立，預設照當時的決定出清 MU', '跳到 1/14：MSFT 比高點低 21%，但論點檢查沒有前提被判不成立，所以不減半——這一則不用回覆，2 個交易日後自動結案；到 MSFT 的持股頁看「審查後持有」的說明', '跳到 1/21：AI 審查認為 NVDA 的前提不成立，可以照 AI、拿去討論或不同意'],
    startAt: '2026-12-28',
    aiTiers: [
      { on: '2026-12-18', ticker: 'MU', tier: 'HALF', date: '2026-12-18', suggest: true, premiseId: 'P1' },
      { on: '2027-02-26', ticker: 'MU', tier: 'HALF', date: '2027-02-26', suggest: false, premiseId: 'P1' },
    ],
    drops: [
      { on: '2026-12-24', ticker: 'MU', status: 'BROKEN', cause: 'FUNDAMENTAL', premiseId: 'P1' },
      { on: '2026-12-24', ticker: 'META', status: 'AGREE', cause: 'SECTOR' },
      // MSFT 有論點：前提都沒有被判不成立 → 不減半（預設不動、不用回覆），留在審查後持有
      { on: '2027-01-13', ticker: 'MSFT', status: 'CLEAR', cause: 'SECTOR', attr: { stock: -0.213, market: -0.03, sector: -0.11, idio: -0.073 } },
    ],
    conditions: [{ on: '2027-01-06', ticker: 'MU', action: 'EXIT', text: 'DRAM/HBM 合約價走平或下跌', setAt: '2026-12-20', why: '8-K 2027-01-06 的原文，3 票確認（引用在網站）。這條是 AI 建議，你在 12/20 勾選。' }],
    breaks: [{ on: '2027-01-20', ticker: 'NVDA', tier: 'HALF', premiseId: 'P1', basis: '10-Q 2027-01-20' }],
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
        date: '2026-12-24',
        verdict: '減半（照規則）',
        votes: '3 票一致',
        summary: '這次下跌拆開來看：大盤 -2%、產業 -9%、個股 -10%。個股的部分來自監管新聞，但沒有罰款金額或禁令；系統預設的前提都沒有被判不成立。這檔沒有你的論點，AI 只能選照規則減半或出清：同意減半。',
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
        verdict: '條件成立',
        votes: '3 票確認',
        summary: '你在 12/20 勾選的條件「DRAM/HBM 合約價走平或下跌」成立：公司在 8-K 寫明第一季 DRAM 合約價季減 8%，HBM3E 報價首度鬆動。',
        quotes: [{ source: '8-K Item 7.01（虛構）', date: '2027-01-06', quote: 'DRAM contract prices declined 8% sequentially; HBM3E pricing softened for the first time' }],
        conditions: MU_CONDITIONS,
        fake: true,
      },
      {
        kind: 'REVIEW',
        ticker: 'MSFT',
        date: '2027-01-13',
        verdict: '不動',
        votes: '3 票一致',
        summary: '跌幅審查：你的兩條前提都沒有被判不成立。這次下跌拆開來看：大盤 -3%、軟體類股比大盤 -11%、個股自身 -7%；最新一季 Azure 成長 33%、營業利益率 45%。跌幅只觸發這次審查，不是賣出的理由，所以不減半。',
        premises: [
          { text: 'Azure 成長維持 30% 以上', origin: 'AI_DRAFT_ACCEPTED', status: 'HOLDS', evidence: '10-Q：Azure 與其他雲端服務營收年增 33%（虛構）' },
          { text: '營業利益率維持在 40% 以上', origin: 'AI_DRAFT_ACCEPTED', status: 'HOLDS', evidence: '財報數字：營業利益率 45%（虛構）' },
        ],
        fake: true,
      },
      {
        kind: 'REVIEW',
        ticker: 'NVDA',
        date: '2027-01-20',
        verdict: '減半',
        votes: '3 票一致',
        summary: '財報後的審查：你的前提「資料中心 GPU 的領先地位兩年內不會被追上」不成立。10-Q 寫明前兩大雲端客戶開始量產自研加速器，資料中心營收季減。',
        premises: [{ text: '資料中心 GPU 的領先地位兩年內不會被追上', origin: 'USER', status: 'BROKEN', evidence: '10-Q：「two of our largest cloud customers began volume deployment of internally developed accelerators」（虛構）' }],
        quotes: [{ source: '10-Q（虛構）', date: '2027-01-20', quote: 'two of our largest cloud customers began volume deployment of internally developed accelerators' }],
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
    notes: [],
  },
};

export const DEMO_IDS = Object.keys(DEMO_SCRIPTS) as DemoId[];
