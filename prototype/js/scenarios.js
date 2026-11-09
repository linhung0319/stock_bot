// 情境：假價格、假事件、假 AI 輸出、操作指引。全部虛構。
(function (G) {
  'use strict';

  // 基本股票池：情境開始前一天的價格、過去 252 日報酬、年化波動、beta
  const BASE = {
    VOO: [610, 0.14, 0.16, 1], SGOV: [100.4, 0.045, 0.004, 0],
    PLTR: [180, 1.40, 0.55, 1.6], APP: [600, 1.13, 0.6, 1.7], AVGO: [340, 0.85, 0.4, 1.4], GE: [290, 0.70, 0.3, 1.1],
    NFLX: [115, 0.62, 0.35, 1.1], AMD: [240, 0.58, 0.5, 1.6], GS: [780, 0.50, 0.3, 1.2], MU: [240, 0.45, 0.5, 1.6],
    NVDA: [185, 0.40, 0.45, 1.6], GOOGL: [280, 0.35, 0.3, 1.1], CAT: [520, 0.30, 0.3, 1.0], JPM: [300, 0.28, 0.25, 1.0],
    META: [640, 0.25, 0.35, 1.3], TSLA: [420, 0.24, 0.6, 1.8], ORCL: [210, 0.22, 0.4, 1.3], MSFT: [505, 0.20, 0.25, 1.1],
    IBM: [290, 0.18, 0.25, 0.8], WMT: [100, 0.15, 0.2, 0.5], COST: [900, 0.12, 0.2, 0.6], AAPL: [270, 0.13, 0.28, 1.1],
    V: [340, 0.10, 0.2, 0.9], AMZN: [230, 0.08, 0.32, 1.2], LLY: [1000, 0.05, 0.3, 0.5], KO: [70, 0.04, 0.15, 0.4],
    XOM: [115, 0.02, 0.25, 0.6], UNH: [330, -0.25, 0.35, 0.6],
  };
  function makeMarket(start, nAfter, opt) {
    opt = opt || {};
    const mkt = opt.market || [{ n: nAfter, ret: 0.10 * nAfter / 252 }];
    const tickers = {};
    for (const [tk, [p0, r252, vol, beta]] of Object.entries(BASE)) {
      const o = (opt.over || {})[tk] || {};
      // 產生器的雜訊用真實波動的一半，讓情境裡「沒寫到的」股票不會亂觸發規則
      const t = { p0: o.p0 || p0, vol: o.vol || vol * (opt.noise || 0.5), r252: o.r252 === undefined ? r252 : o.r252 };
      t.hist = o.hist || [{ n: G.Market.PRE - 252, ret: 0.04, vol: t.vol }, { n: 252, ret: t.r252, vol: t.vol }];
      if (o.path) t.path = o.path;
      else if (tk === 'SGOV') t.path = [{ n: nAfter, ret: 0.045 * nAfter / 252, vol: 0.004 }];
      else t.path = mkt.map((s) => ({ n: s.n, ret: Math.pow(1 + s.ret, beta) * (1 + (o.alpha || 0) * s.n / 252) - 1, vol: s.vol === undefined ? t.vol : s.vol * (tk === 'VOO' ? 0.4 : 1) }));
      tickers[tk] = t;
    }
    return { start, nAfter, tickers, seed: opt.seed || 7 };
  }

  const OWN4 = (std) => ({
    MU: { std: std.MU || 0.05, premises: [{ id: 'P1', text: 'HBM 長約有價格保護，記憶體循環這次不會像以前一樣崩', origin: 'USER' }, { id: 'P2', text: 'AI 資料中心需求至少延續到 2027', origin: 'USER' }] },
    NVDA: { std: std.NVDA || 0.05, premises: [{ id: 'P1', text: '資料中心 GPU 的領先地位兩年內不會被追上', origin: 'USER' }] },
    MSFT: { std: std.MSFT || 0.05, premises: [{ id: 'P1', text: 'Azure 成長維持 30% 以上', origin: 'AI_DRAFT_ACCEPTED' }, { id: 'P2', text: '營業利益率維持在 40% 以上', origin: 'AI_DRAFT_ACCEPTED' }] },
    META: { std: std.META || 0.05, premises: [{ id: 'P1', text: '沒有硬事件（重編、換會計師、被收購、重大監管）', origin: 'SYSTEM_DEFAULT' }, { id: 'P2', text: '營收年增率沒有連兩季轉負', origin: 'SYSTEM_DEFAULT' }, { id: 'P3', text: '稀釋 EPS 沒有連兩季年減', origin: 'SYSTEM_DEFAULT' }] },
  });
  const MOM5 = { PLTR: 33, AVGO: 18, NFLX: 52, AMD: 25, ORCL: 28 };

  const MU_CONDS = [
    { id: 'C1', direction: 'DOWN', kind: 'XBRL', text: '毛利率低於 80%（最新一季 84.6%）', metric: 'GrossMarginPct', level: 0.80, below: true, tier_if_met: 'HALF', basis: 'E2：最新一季 XBRL 毛利率 84.6%' },
    { id: 'C2', direction: 'DOWN', kind: 'EVENT', text: 'DRAM/HBM 合約價走平或下跌', tier_if_met: 'EXIT', confirm_by: '8-K、法說會、主要產業新聞', basis: 'E7：法說會「HBM 價格已鎖定到 2027」' },
    { id: 'C3', direction: 'DOWN', kind: 'PRICE', text: '收盤跌回 196（11/14 整理區間最低收盤）以下', notify: false, basis: 'E1：價格資料' },
  ];

  const S = [];

  // ------------------------------------------------------------------ 1
  S.push({
    id: 's1', title: '① 平常的月報：換股、否決、搭便車、提高比重',
    summary: '一切正常的一個月。12/01 月報會有：動能出場（ORCL 掉出前 15）、新股進場被任務 A 否決（APP）由下一名遞補、PLTR 偏離 +59% 搭便車回調、MSFT 的「提高到 125%」建議。1 月看「本月不用動」或「上次沒照做的再列一次」。',
    market: makeMarket('2026-11-23', 50, { over: { ORCL: { path: [{ n: 6, ret: -0.11 }, { n: 44, ret: 0.02 }] }, APP: { hist: [{ n: 78, ret: 0.05 }, { n: 150, ret: 0.40 }, { n: 1, ret: 0.45, vol: 0 }, { n: 101, ret: 0.05 }] } } }),
    initial: { cash: 1500, own: { MU: 30, NVDA: 30, MSFT: 9, META: 6 }, mom: { PLTR: 53, AVGO: 18, NFLX: 52, AMD: 25, ORCL: 28 }, core: { VOO: 72 }, ownMeta: OWN4({}), stratDD: -0.32, stratEventStart: '2026-07', stratNotified: [-0.2, -0.3] },
    events: {
      '2026-11-25': [{ type: 'filing', tk: 'NVDA', form: '8-K', items: '5.02', cls: '一般事件（高層異動），不處理', text: '財務長退休，由副財務長接任' }],
      '2026-12-09': [{ type: 'news', tk: 'MSFT', text: 'Microsoft 宣布新資料中心投資計畫', cond: null }],
    },
    ai: {
      'F1:APP': {
        ruleHits: ['JUMP_SHARE_0.58（最大 3 日漲幅占 12 個月漲幅 58%，該日後 3 個月相對 SPY ≤ 0）'], verdict: 'VETO', vote: { VETO: 3, ALLOW: 0 }, reason_code: 'ONE_OFF_JUMP',
        summary: '12 個月漲幅主要來自 6 月的一次跳空（被納入指數＋財報同日），之後 5 個月相對 SPY 沒有再上漲。否決本月進場，下個月重新審查。', lift: '下個月重審；或之後 3 個月相對 SPY 上漲 > 10%',
        evidence: [{ id: 'E1', source: '價格資料（程式算）', date: '2026-06-18', quote: '單日 +45%' }, { id: 'E2', source: '8-K Item 2.02', date: '2026-06-17', quote: '（虛構）第二季營收 …' }],
        sections: [
          { title: '規則偵測段', text: 'JUMP_SHARE = 0.58 > 0.5；資訊離散度 ID = +0.21（離散型）。其他項目（EDGAR 4.02/4.01、增資、XBRL 盈餘）沒有命中。' },
          { title: '檢方（Sonnet，先獨立寫）', text: '漲幅集中在 6/18 一天；之後股價與 SPY 同步，沒有「資訊慢慢反映」的跡象（前提 P3 不成立）。' },
          { title: '辯方（Sonnet，先獨立寫）', text: '跳空來自財報上修，屬於基本面；但辯方也承認跳空後沒有延續。' },
          { title: '法官 ×3（Opus，照清單判）', text: 'P3 不成立 ×3。否決代碼 ONE_OFF_JUMP。' },
        ],
      },
      'F24:MSFT:2026-11': {
        verdict: 'RAISE', vote: { RAISE: 3 }, evidenceOk: true,
        summary: '前提 P1（Azure 成長 ≥ 30%）、P2（營業利益率 ≥ 40%）都成立，最新一季 Azure +34%、營業利益率 46%；F23 規則條件成立（200 日均線之上連續 6 個月）。選 RAISE。',
        premiseStatus: { P1: { status: 'HOLDS', evidence: 'E2：10-Q Azure +34%' }, P2: { status: 'HOLDS', evidence: 'E3：XBRL 營業利益率 46%' } },
        conditions: [{ id: 'C1', direction: 'DOWN', kind: 'XBRL', text: '營業利益率低於 40%', metric: 'OpMargin', level: 0.40, below: true, tier_if_met: 'STANDARD' }, { id: 'C2', direction: 'DOWN', kind: 'EVENT', text: '大型 AI 客戶公開轉移雲端供應商', tier_if_met: 'STANDARD' }],
      },
    },
    guide: {
      focus: ['F1 任務 A 否決 → 遞補（引擎紀錄看「規則偵測段」先跑，只有命中才開法庭）', 'F2 出場可以「轉入自選」（要寫理由，變成前提）', 'F3 搭便車：只有那個月本來就有其他單時才回調', 'F23/F24：MSFT「提高到 125%」只列一行，預設不做', '核心吸收差額：VOO 那一行是算出來的，改選項時會跟著變'],
      tasks: [
        { when: '2026-12-01 開盤前', text: '按「跳到下一則通知」到月報。先看左邊的 LINE，再看中間引擎紀錄的順序。' },
        { when: '月報', text: '試試把 MSFT 那一項改成「照 AI」，看 VOO 那一行怎麼變。' },
        { when: '月報', text: '在 GE（遞補進場）按「排除」寫理由，看系統怎麼遞補下一名。或在 ORCL 出場按「轉入自選」。' },
        { when: '月報', text: '其中一項選「這次不做」，回覆後一路走到 1 月月報，看它有沒有再列一次。' },
      ],
      questions: ['月報一次列這麼多項，你會一項一項看，還是只看合併後的清單？', 'APP 被否決的理由你接受嗎？你希望 LINE 上看到幾個字？', '「提高到 125%」的建議出現在月報裡，你會想按嗎？什麼情況會？'],
    },
  });

  // ------------------------------------------------------------------ 2
  S.push({
    id: 's2', title: '② 自選股大跌：MU 財報後減半、條件成立、之後加回',
    summary: 'MU 占帳戶約 14%（標準比重設成 10%）。12/17 財報跳空，F24 財報後審查寫下條件；12/23 跌到距高點 -20% 觸發慢規則減半（≥ 5% 當天通知）；1/6 新聞符合事件條件 C2 → F25 當天通知 AI 建議出清；1/8 10-Q 的財報條件也成立，但本月已經發過。2 月反彈，2/18 慢規則加回條件成立（< 5%，併入 3/1 月報），AI 附「維持一半」。META 同時跌 21%（< 5%，併入月報，AI 說不動）。',
    market: makeMarket('2026-12-07', 66, {
      over: {
        MU: { r252: 0.80, path: [{ n: 8, ret: 0.03 }, { n: 1, ret: -0.11, vol: 0 }, { n: 3, ret: -0.06 }, { n: 1, ret: -0.05, vol: 0 }, { n: 8, ret: -0.04 }, { n: 10, ret: -0.03 }, { n: 25, ret: 0.24 }, { n: 10, ret: 0.03 }] },
        META: { path: [{ n: 8, ret: 0.0 }, { n: 1, ret: -0.08, vol: 0 }, { n: 5, ret: -0.15 }, { n: 52, ret: 0.04 }] },
      },
    }),
    initial: { cash: 900, own: { MU: 58, NVDA: 25, MSFT: 8, META: 6 }, mom: MOM5, core: { VOO: 70 }, ownMeta: Object.assign(OWN4({ MU: 0.10 }), { MU: Object.assign(OWN4({ MU: 0.10 }).MU, { conditions: [] }) }), stratDD: -0.32, stratEventStart: '2026-07', stratNotified: [-0.2, -0.3] },
    events: {
      '2026-12-17': [{ type: 'filing', tk: 'MU', form: '8-K', items: '2.02', cls: '財報（排定明天 F24 財報後審查）', text: '（虛構）下一季毛利率指引低於預期，HBM 合約重新議價' }],
      '2027-01-06': [{ type: 'news', tk: 'MU', text: '（虛構）TrendForce：第一季 DRAM 合約價季減 8%，HBM3E 報價首度鬆動', source: '產業新聞', cond: 'C2' }],
      '2027-01-08': [{ type: 'filing', tk: 'MU', form: '10-Q', cls: '財報（XBRL 條件由程式比對）', text: '季報', xbrl: { GrossMarginPct: 0.78 } }],
    },
    ai: {
      'F24:MU:2026-12-18': {
        verdict: 'HALF', vote: { HALF: 3 },
        summary: '前提 P1「HBM 長約有價格保護」不成立：財報新聞稿寫明「部分 HBM 合約重新議價」。P2 仍成立。檔位：標準的一半。寫下 3 條條件交給 F25。',
        premiseStatus: { P1: { status: 'BROKEN', evidence: 'E4：8-K 2.02 附件「certain HBM contracts were renegotiated」（虛構）' }, P2: { status: 'HOLDS', evidence: 'E5：超大型雲端業者資本支出指引上修' } },
        conditions: MU_CONDS,
        sections: [{ title: '多方', text: 'AI 需求仍在，毛利率下滑是一次性。' }, { title: '空方', text: '合約重新議價代表價格保護不存在，前提 P1 的根基沒了。' }, { title: '經理 ×3', text: 'HALF ×3。' }],
      },
      'F24:MU:2026-12': { verdict: 'HALF', vote: { HALF: 3 }, summary: 'P1 仍不成立。維持標準的一半。', premiseStatus: { P1: { status: 'BROKEN' } }, conditions: MU_CONDS },
      'F24:MU:2027-01': { verdict: 'HALF', vote: { HALF: 2, STANDARD: 1 }, summary: 'P1 仍不成立；股價已反彈，但反彈不是前提恢復的證據。2 票 HALF、1 票 STANDARD。', premiseStatus: { P1: { status: 'BROKEN' } }, conditions: MU_CONDS },
      'F24:MU:2027-02': { verdict: 'HALF', vote: { HALF: 3 }, summary: '股價已回到高點附近，但前提 P1（HBM 長約有價格保護）仍不成立，條件 C1、C2 都已成立。檔位：標準的一半。', premiseStatus: { P1: { status: 'BROKEN' } }, conditions: MU_CONDS, newConditions: false },
      'F7:META': { tier: 'HOLD', vote: { HOLD: 3 }, summary: '跌幅拆解：大盤 -2%、產業 -9%、個股 -10%。個股部分來自監管新聞，但沒有罰款金額或禁令，系統預設前提都仍成立。AI 檔位：不動。' },
      'F25:MU:C2': { summary: '條件 C2「DRAM/HBM 合約價走平或下跌」：3 票都判斷成立。引用：TrendForce 報告原文（虛構）。' },
    },
    guide: {
      focus: ['F24 財報後審查：AI 寫下的條件分財報／事件／價格三類，價格只記錄', 'F7 ≥ 5% 當天通知 vs META < 5% 併入月報', 'F25：規則沒有動作，只有 AI 那一行', '1/8 財報條件也成立，但每檔每月最多 1 則', 'F20 單月跌 > 20% 的說明附在下一則通知', '2 月 F8 加回時，AI 附最近一次 F24 的檔位'],
      tasks: [
        { when: '12/18', text: '看引擎紀錄的 F24 財報後審查，再到「網站 → AI 報告」看前提逐條檢查與條件。' },
        { when: '12/23 收盤後', text: 'MU 減半當天通知：照規則、照 AI，或這次不做？' },
        { when: '1/6 收盤後', text: 'F25 建議出清。想看 2 月的「加回」就選「這次不做」；想看出清後會怎樣就選「照 AI」。' },
        { when: '1/4 月報', text: 'META 的減半併在月報，AI 說「不動」。你會選哪個？' },
        { when: '3/1 月報', text: 'MU 加回（規則：買回到標準比重）與 AI（標準的一半）並列。' },
      ],
      questions: ['同一檔股票兩週內收到兩則當天通知（減半、出清），會不會太多？', '「AI 建議出清」的依據是一則產業新聞，你會照做嗎？需要看到什麼才會？', 'MU 反彈後慢規則叫你加回，但 AI 說維持一半，你怎麼選？'],
    },
  });

  // ------------------------------------------------------------------ 3
  S.push({
    id: 's3', title: '③ 崩盤規則：啟動、被洗、買回更貴',
    summary: '12 月大盤跌 11%，1/4 月報時 VOO 在 200 日均線之下 → 崩盤規則啟動（核心一半換短債、動能減半），AI 檢視意見「延後」但沒有否決權。1 月 V 型反彈，2/1 解除，買回價比賣出價高。MSFT 跟著大盤跌到 -20%（自選不受崩盤規則影響，走自己的慢規則）。',
    market: makeMarket('2026-12-07', 66, { market: [{ n: 18, ret: -0.11, vol: 0.30 }, { n: 20, ret: 0.14, vol: 0.25 }, { n: 28, ret: 0.03 }], over: { MSFT: { path: [{ n: 18, ret: -0.20 }, { n: 20, ret: 0.10 }, { n: 28, ret: 0.03 }] } } }),
    initial: { cash: 1500, own: { MU: 30, NVDA: 30, MSFT: 9, META: 6 }, mom: MOM5, core: { VOO: 78 }, ownMeta: OWN4({}), stratDD: -0.32, stratEventStart: '2026-07', stratNotified: [-0.2, -0.3] },
    events: {},
    ai: {
      'F5:2027-01': {
        verdict: 'DELAY', vote: { FOLLOW: 1, DELAY: 2 },
        summary: '基準率：過去 17 次中 3 次是真空頭（約 18%）。儀表板：殖利率曲線未倒掛、Sahm 規則 0.2、高收益債利差 3.6%（6 個月 +0.4）、失業率在 12 個月均線之下、站上 200 日均線的成分股 38%。只有市場廣度轉壞，沒有「幾個獨立來源同時轉壞」。意見：延後（2:1）。',
        sections: [
          { title: '總經儀表板（程式算，假資料）', text: '10Y-3M 利差 +0.42%（未倒掛）｜Sahm 即時 0.20｜失業率 vs 12 個月均線 -0.1｜初領失業金 4 週均 vs 52 週低點 +6%｜實質零售年增 +1.8%｜BAA10Y 1.9%（6 個月 +0.2）｜NFCI -0.42｜VIX 27｜成分股站上 200 日均線 38%' },
          { title: '基準率表', text: '2000–2026 啟動 17 次：3 次真空頭（2000-10、2002-05、2008-01）買回便宜 13～34%；13 次買回更貴（+2～+14%）；觸發時距均線多遠分不出真假。' },
          { title: '正方（照規則做）', text: 'VIX 27、廣度 38%，跌勢集中在 AI 相關股，可能是 AI 投資回報疑慮的開始。' },
          { title: '反方（這次是修正）', text: '衰退指標都沒有轉壞；信用利差只小幅擴大。' },
          { title: '法官 ×3（逐條）', text: 'P1（持續一年以上的空頭）：證據不足 ×3。P2（趨勢延續）：成立 ×1、證據不足 ×2。意見：照做 1、延後 2。' },
          { title: '權限', text: 'A2：只說明＋影子記錄，不能否決或延後（§10 第 12 點）。LINE 只附一行。' },
        ],
      },
      'F6:2027-02': { verdict: 'FOLLOW', vote: { FOLLOW: 3, DELAY: 0 }, summary: '站回均線；信用利差回落、廣度回到 61%。意見：照做（解除）。' },
    },
    guide: {
      focus: ['F5：AI 意見「延後」只附一行，清單照規則', '崩盤規則啟動時，動能部位的減碼也併在同一項', '核心吸收：啟動中，其他桶減下來的錢一半進短債', '自選 MSFT 不受崩盤規則影響，走自己的慢規則（< 5% 併入月報）', '網站 → 崩盤規則：保險紀錄（這次的賣出價與買回價）'],
      tasks: [
        { when: '1/4 月報', text: '看 LINE 上那一行「AI 檢視：延後」，再看網站上的完整報告。照做或這次不做？' },
        { when: '1 月中', text: '試著在崩盤規則啟動期間「出金」一筆，看出金順序第 ① 步先用短債。' },
        { when: '2/1 月報', text: '解除：短債換回 VOO。到網站看保險紀錄。' },
      ],
      questions: ['AI 說延後、你也覺得只是修正，這時「照做」的按鈕你按得下去嗎？', '買回比賣出貴 X%，你可以接受這是保險費嗎？', '你希望 LINE 上的那一行多寫一點（例如票數），還是維持一行？'],
    },
  });

  // ------------------------------------------------------------------ 4
  S.push({
    id: 's4', title: '④ 硬事件：被收購、財報重編、誤報',
    summary: '12/10 動能持股 ORCL 出現 DEFM14A（被收購）→ 規則直接提出提早出場（不經 AI）。12/15 自選 META 出現 8-K Item 4.02（財報不可信賴）→ 任務 B 標記 → 任務 A 硬事件版完整法庭 3 票建議出場。1 月月報新股 GS 的規則偵測命中 424B（增資），讀原文後是一般公司債 → 准許。其他日子的每日掃描大多沒事。',
    market: makeMarket('2026-12-07', 45, { over: { ORCL: { path: [{ n: 3, ret: 0.0 }, { n: 1, ret: 0.22, vol: 0 }, { n: 41, ret: 0.01, vol: 0.03 }] }, META: { path: [{ n: 6, ret: 0.01 }, { n: 1, ret: -0.09, vol: 0 }, { n: 38, ret: -0.03 }] }, GS: { r252: 0.75 }, APP: { r252: 0.30 } } }),
    initial: { cash: 1500, own: { MU: 30, NVDA: 30, MSFT: 9, META: 6 }, mom: MOM5, core: { VOO: 78 }, ownMeta: OWN4({}), stratDD: -0.32, stratEventStart: '2026-07', stratNotified: [-0.2, -0.3] },
    events: {
      '2026-12-08': [{ type: 'filing', tk: 'NVDA', form: '8-K', items: '5.02', cls: '一般事件（高層異動），不處理', text: '董事異動' }],
      '2026-12-10': [{ type: 'filing', tk: 'ORCL', form: 'DEFM14A', cls: 'PENDING_MA', text: '（虛構）合併委託書：每股現金 256 美元' }],
      '2026-12-15': [{ type: 'filing', tk: 'META', form: '8-K', items: '4.02', cls: 'ACCOUNTING', text: '（虛構）2025 年度與 2026 前三季的廣告營收認列需要重編，先前財報不應再被依賴' }],
      '2026-12-21': [{ type: 'news', tk: 'MU', text: '（虛構）美光宣布新廠動土', cond: null }],
    },
    ai: {
      'F19:META': {
        verdict: 'EXIT', vote: { EXIT: 3, HOLD: 0 }, reason_code: 'ACCOUNTING',
        summary: '8-K Item 4.02：先前財報不應再被依賴。不可信的財報讓所有基本面前提失效（系統預設前提 P2、P3 都建立在財報上）。重編影響的營收約占 4%（程式從申報表格取出），但重編本身就是硬事件。3 票：出場。',
        evidence: [{ id: 'E1', source: '8-K Item 4.02', date: '2026-12-15', quote: 'should no longer be relied upon（虛構）' }],
        sections: [{ title: '規則偵測段', text: 'EDGAR 8-K Item 4.02 命中（不用 LLM）。' }, { title: 'LLM 判讀段', text: '讀 4.02 原文：範圍、是否涉及管理層、審計委員會的說法。重大性：受影響營收占 4%。' }, { title: '法官 ×3', text: 'EXIT ×3。' }],
      },
      'F1:GS': {
        ruleHits: ['424B2（S-3ASR 架構下發行）', 'SHARES_6M +0.3%'], verdict: 'ALLOW', vote: { ALLOW: 3, VETO: 0 },
        summary: '424B2 是一般公司債（優先無擔保票據），不是股票或可轉債；流通股數 6 個月只增加 0.3%。DILUTION 不成立，准許。',
        sections: [{ title: '規則偵測段', text: '申報類型 424B2 命中「增資」類。大型金融股的 424B 大多是一般公司債，只靠申報類型會誤報。' }, { title: 'LLM 判讀段', text: '讀 424B2 封面：「Senior Notes due 2031」（虛構）。' }],
      },
    },
    guide: {
      focus: ['動能持股被收購：規則直接提出（不需要 AI），使用者確認', '自選股硬事件：完整法庭 3 票才升級給人；預設是「不做」，要你主動選', '每日掃描（F18）大多數日子沒事，只標記、不通知', 'F1 規則偵測的誤報（424B）由 LLM 讀原文排除'],
      tasks: [
        { when: '12/10 收盤後', text: 'ORCL 被收購的通知。確認出場，或不做 → 1 月月報會再列一次。' },
        { when: '12/15 收盤後', text: 'META 重編的通知。看網站上的法庭紀錄。' },
        { when: '1/4 月報', text: 'ORCL 的空格由誰遞補？GS 的「增資」命中是怎麼被排除的？' },
      ],
      questions: ['被收購的股票，你會想等收購完成拿現金，還是馬上賣？', '重編這種事件，你希望系統更積極（例如預設出場）嗎？'],
    },
  });

  // ------------------------------------------------------------------ 5
  S.push({
    id: 's5', title: '⑤ 你自己的操作：入金、出金、改比例、新增自選、手動交易',
    summary: '平靜的市場，讓你自由操作。MU 占 13.5%，大額出金時會先觸發「單檔上限預先檢查」。可以試新增 TSLA（已距高點 -25%，一開始就是減半狀態）、AMD（動能已持有 → 跨桶上限）、IBM（硬事件掃描命中延遲申報）。',
    market: makeMarket('2026-12-07', 50, { over: { TSLA: { hist: [{ n: 78, ret: 0.05 }, { n: 200, ret: 0.65 }, { n: 52, ret: -0.25 }] } } }),
    initial: { cash: 2000, own: { MU: 56, NVDA: 25, MSFT: 8, META: 5 }, mom: MOM5, core: { VOO: 64 }, ownMeta: OWN4({ MU: 0.08 }), stratDD: -0.32, stratEventStart: '2026-07', stratNotified: [-0.2, -0.3] },
    hardScan: { IBM: ['NT 10-Q（延遲申報）2026-11-12 → AI 讀原文：「需要更多時間完成商譽減損測試」（虛構）'] },
    events: {},
    ai: {
      'F14:TSLA': { drafts: [{ id: 'D1', text: '自駕計程車在 2027 年擴大到 10 個城市（目前價格隱含的成長）', breaks_if: '主要城市的營運許可被撤回' }, { id: 'D2', text: '汽車毛利率止跌（最近一季 17%）', breaks_if: '汽車毛利率連兩季低於 15%' }, { id: 'D3', text: '（不容易想到的風險）執行長的注意力與持股質押沒有變化', breaks_if: '執行長出售或質押大量持股' }] },
    },
    guide: {
      focus: ['入金：只買不賣，依序補「低於目標最多」的格子，缺口 < 0.25% 不補', '出金：只賣不買；先做單檔上限檢查，再照 ① 短債 → ② 動能超出 → ③ VOO → ④ 動能 → ⑤ 自選', '改比例：附上相對回撤狀態，AI 不評論', '新增自選：健檢只給資訊，不給買／不買；前提三層備案', '手動交易：快照出現清單外變動 → 問哪一桶；分類前月報不下單'],
      tasks: [
        { when: '任何時候', text: '入金 $10,000，看清單。照做後看帳本怎麼分到各桶。' },
        { when: '任何時候', text: '出金 $30,000，看 MU 的單檔上限預先檢查。' },
        { when: '任何時候', text: '把 Strategy 改成 0%（核心 80%），看附上的狀態。' },
        { when: '任何時候', text: '新增自選 TSLA，選「AI 草擬前提」勾兩條。再試 IBM 看硬事件掃描。' },
        { when: '12 月底前', text: '用「手動交易」買 10 股 AAPL，不分類，走到 1/4 看月報暫停。' },
      ],
      questions: ['入金清單照「缺口最大的先補」，結果和你直覺想買的一樣嗎？', '新增自選時要寫前提，你會寫嗎？還是會直接按系統預設？', '手動交易後要回答「屬於哪一桶」，這一步你覺得麻煩嗎？'],
    },
  });

  // ------------------------------------------------------------------ 6
  S.push({
    id: 's6', title: '⑥ 動能落後＋波動度減碼＋策略檢討',
    summary: '動能持股 12 月劇烈震盪並落後大盤：1/4 月報依波動度減碼 1 → 2/3（附任務 C 說明）；2/1 相對 SPY 落後擴大到 -40% → 策略檢討提醒（不附清單、不給建議），同一天 F4 的遲滯緩衝擋下再減一格；3/1 才減到 1/3。',
    sigmaMedianFactor: 1.05,
    market: makeMarket('2026-12-07', 60, {
      over: {
        PLTR: { path: [{ n: 18, ret: -0.22, vol: 1.3 }, { n: 20, ret: 0.02, vol: 0.5 }, { n: 22, ret: 0.03, vol: 0.4 }] },
        AVGO: { path: [{ n: 18, ret: -0.14, vol: 1.0 }, { n: 20, ret: 0.01, vol: 0.4 }, { n: 22, ret: 0.02, vol: 0.35 }] },
        NFLX: { path: [{ n: 18, ret: -0.10, vol: 0.9 }, { n: 20, ret: 0.0, vol: 0.35 }, { n: 22, ret: 0.02, vol: 0.3 }] },
        AMD: { path: [{ n: 18, ret: -0.18, vol: 1.2 }, { n: 20, ret: 0.02, vol: 0.5 }, { n: 22, ret: 0.02, vol: 0.45 }] },
        ORCL: { path: [{ n: 18, ret: -0.12, vol: 1.0 }, { n: 20, ret: 0.0, vol: 0.4 }, { n: 22, ret: 0.02, vol: 0.35 }] },
      },
    }),
    initial: { cash: 1500, own: { MU: 30, NVDA: 30, MSFT: 9, META: 6 }, mom: MOM5, core: { VOO: 78 }, ownMeta: OWN4({}), stratDD: -0.32, stratEventStart: '2026-07', stratNotified: [-0.2, -0.3] },
    events: {},
    ai: {},
    guide: {
      focus: ['F4：σ̃/σ 捨去到 1/3 的倍數，加 0.10 遲滯', 'F21：只提醒、不附清單、AI 不給停用或繼續的建議', '改比例（Strategy → 0）時附上相對回撤狀態'],
      tasks: [
        { when: '1/4 月報', text: '看引擎紀錄 F4 的 σ、σ̃、比值，與動能部位調整那一項。' },
        { when: '2/1 之後', text: '收到策略檢討提醒後，試著把 Strategy 改成 0%，看清單上附的狀態。' },
        { when: '2/1 月報', text: '策略檢討提醒（落後 40%）。看 F4「遲滯擋下」：原始格子掉到 1/3，但加 0.10 緩衝後仍在 2/3。' },
        { when: '3/1 月報', text: '波動仍高 → 2/3 → 1/3。126 日的視窗讓減碼會持續好幾個月。' },
      ],
      questions: ['落後 40% 的提醒和減碼同一天到，你會怎麼想？', '提醒裡 AI 只列正反證據、不給建議，這樣對你有幫助嗎？'],
    },
  });

  // ------------------------------------------------------------------ 7
  S.push({
    id: 's7', title: '⑦ 沒照做、忘了、做錯',
    summary: 'NVDA 占 13%。12/10 跌到距高點 -22% → 減半當天通知。試著不回覆：2 個交易日後提醒；NVDA 很快反彈，1/4 加回條件成立 → 這之後才回覆「忘了」，補做清單會被取消。12/01 月報可以練習「部分完成」（填的股數和清單不同 → 補做差額或就這樣）。',
    market: makeMarket('2026-11-23', 50, { over: { ORCL: { path: [{ n: 6, ret: -0.11 }, { n: 44, ret: 0.02 }] }, APP: { hist: [{ n: 78, ret: 0.05 }, { n: 150, ret: 0.40 }, { n: 1, ret: 0.45, vol: 0 }, { n: 101, ret: 0.05 }] }, NVDA: { r252: 0.55, path: [{ n: 8, ret: 0.02 }, { n: 4, ret: -0.235 }, { n: 10, ret: 0.14 }, { n: 28, ret: 0.04 }] } } }),
    initial: { cash: 1500, own: { MU: 30, NVDA: 70, MSFT: 9, META: 6 }, mom: { PLTR: 53, AVGO: 18, NFLX: 52, AMD: 25, ORCL: 28 }, core: { VOO: 60 }, ownMeta: OWN4({ NVDA: 0.10 }), stratDD: -0.32, stratEventStart: '2026-07', stratNotified: [-0.2, -0.3] },
    events: {},
    ai: { 'F1:APP': { ruleHits: ['JUMP_SHARE_0.58'], verdict: 'VETO', vote: { VETO: 3, ALLOW: 0 }, reason_code: 'ONE_OFF_JUMP', summary: '12 個月漲幅主要來自一次跳空，之後沒有延續。否決。' } },
    guide: {
      focus: ['F17 忘了：2 個交易日沒回報 → 提醒一次', '晚回覆 → 用當天價格重算；規則狀態已反轉的項目取消', '做錯：快照和清單差 > 1 股 → 補做差額或就這樣', '策略類沒做的差額，下個月月報再列'],
      tasks: [
        { when: '12/01 月報', text: '選「部分完成」，把某一檔的股數改小，成交後看「做錯」的追問。' },
        { when: '12/10 收盤後', text: 'NVDA 減半通知：先不要回。一路按「下一天」到 1/5 之後再回覆，選「忘了」。' },
        { when: '對照', text: '重來一次，這次在 12/16 左右回覆「忘了」（狀態還沒反轉），看補做清單用當天價格重算。' },
      ],
      questions: ['提醒只發一次夠嗎？', '補做清單被取消時，你會覺得系統「自作主張」嗎？'],
    },
  });

  G.SCENARIOS = S;
})(typeof window !== 'undefined' ? window : globalThis);
