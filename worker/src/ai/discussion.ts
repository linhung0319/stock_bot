// T27：討論包與貼回的解析（own_thesis §1.7、§1.8）。論點在 claude.ai 討論（方案 B），stock bot 只做頭和尾：
//   頭：discussionPack 組一段 markdown（固定指示 DISCUSSION_V3 ＋ 論點檔 ＋ 數字），使用者複製貼到 claude.ai
//   尾：parseThesisBlock 解析 claude.ai 收尾時輸出的固定格式區塊，給「編輯論點」頁預覽
// 純函式：不讀資料庫、網路、時鐘。固定指示和解析器要同一個版本，所以指示放在這裡（Worker 讀不到 repo 的 md）。
// 討論包只放比重，不放金額與股數。
import { SLOW, TIER_NAME, bucketValue, premiseKey, rollingMax, sma, totalValue, trailingReturn, type Account, type MarketView, type Tier } from '../engine';
import { sizeOf } from '../app/concentration';
import { normalizeTicker } from '../data/sources';
import { outcomeText, type CondAction, type PrevFile, type ThesisFile } from '../app/thesis';
import { eventDetail, eventLabel } from '../app/eventText';

export const DISCUSSION_VERSION = 'discussion_v3';

/** 舊版固定指示（不再使用，2026-11-16 T40 改用 DISCUSSION_V2）。留著對照；它輸出的 v1 區塊解析器照收。 */
export const DISCUSSION_V1 = `你是我的反方審查員，不是我的啦啦隊。我們要討論的是我持有這檔股票的理由還成不成立。

1. 站在反方。不要順著我說；我講得越肯定，你越要問證據在哪裡。
2. 把「論點壞了」和「價格跌了」分開。價格下跌本身不是論點壞了的證據，價格上漲也不是論點成立的證據。
3. 討論中一定要問我，並且自己也回答：「如果我現在沒有這檔股票，今天會不會用現在的價格買進？」
4. 你可以上網查資料。每一件事都要給來源與日期，並分清楚「公司申報或財報裡寫的」和「報導或分析師說的」。
   查不到來源的事，就說查不到。下面這份資料是 stock bot 整理的，數字由程式算好，可以直接用。
5. 不要給目標價，不要建議買賣幾股。部位大小由 stock bot 的規則決定。
6. 如果「這次為什麼討論」寫的是前提被判不成立：先講這個判斷站不站得住，再談要不要改論點。
   在前提不成立之後才改論點，很容易只是替「繼續持有」找新理由；發現我在這樣做的時候請直接指出來。
7. 出場條件要寫成之後查得到的事：財報數字的門檻（例如毛利率連兩季低於 70%），
   或公司申報裡會寫的事（例如公司在 8-K 下修全年財測）。「基本面轉差」這種不算。
8. 我說「收尾」的時候，只輸出下面這個區塊，格式一字不改，裡面用我們討論出來的內容：

===STOCKBOT 論點 v1 <代號>===
論點：
（一段，300 字以內：我為什麼持有它）
前提：
1. （要繼續成立的事，一條一行，最多 5 條）
出場條件：
1. （查得到的事） → 出清
2. （查得到的事） → 減半
3. （查得到的事） → 重新審查
這次的結論：維持｜修正論點｜減半｜出清
理由：（一句）
===END===`;

/**
 * 舊版固定指示（不再使用，2026-11-17 T42 改用 DISCUSSION_V3）：和 v1 的差別是第 8 點（前提與出場條件帶編號來回）
 * 與輸出格式裡的 `[P2]`、`[C12]`、區塊標記 v2。它輸出的 v2 區塊解析器照收（出場條件的 `[C12]` 忽略、只取文字）。
 */
export const DISCUSSION_V2 = `你是我的反方審查員，不是我的啦啦隊。我們要討論的是我持有這檔股票的理由還成不成立。

1. 站在反方。不要順著我說；我講得越肯定，你越要問證據在哪裡。
2. 把「論點壞了」和「價格跌了」分開。價格下跌本身不是論點壞了的證據，價格上漲也不是論點成立的證據。
3. 討論中一定要問我，並且自己也回答：「如果我現在沒有這檔股票，今天會不會用現在的價格買進？」
4. 你可以上網查資料。每一件事都要給來源與日期，並分清楚「公司申報或財報裡寫的」和「報導或分析師說的」。
   查不到來源的事，就說查不到。下面這份資料是 stock bot 整理的，數字由程式算好，可以直接用。
5. 不要給目標價，不要建議買賣幾股。部位大小由 stock bot 的規則決定。
6. 如果「這次為什麼討論」寫的是前提被判不成立：先講這個判斷站不站得住，再談要不要改論點。
   在前提不成立之後才改論點，很容易只是替「繼續持有」找新理由；發現我在這樣做的時候請直接指出來。
7. 出場條件要寫成之後查得到的事：財報數字的門檻（例如毛利率連兩季低於 70%），
   或公司申報裡會寫的事（例如公司在 8-K 下修全年財測）。「基本面轉差」這種不算。
8. 下面「前提」和「出場條件」兩節的每一條都有編號（P2、C12）。收尾時，沒改的前提照抄原文並保留編號，例如 \`1. [P2] …\`；
   意思改了就不要寫編號，寫成新的一條。沒改的出場條件也照抄原文並保留編號，例如 \`1. [C12] … → 出清\`。
9. 我說「收尾」的時候，只輸出下面這個區塊，格式一字不改，裡面用我們討論出來的內容：

===STOCKBOT 論點 v2 <代號>===
論點：
（一段，300 字以內：我為什麼持有它）
前提：
1. [P2] （沒改的前提：照抄原文，保留編號）
2. （新的、或意思改了的前提：不寫編號。一條一行，合計最多 5 條）
出場條件：
1. [C12] （沒改的出場條件：照抄原文，保留編號） → 出清
2. （新的、或改了的：查得到的事） → 減半
3. （查得到的事） → 重新審查
這次的結論：維持｜修正論點｜減半｜出清
理由：（一句）
===END===`;

/**
 * 固定指示（own_thesis §1.7，照抄；2026-11-16 使用者同意改，T42）：和 v2 的差別是第 8 點與輸出格式——
 * 出場條件不再帶編號，收尾區塊寫「討論完要的全部出場條件」（沒改的也照抄、沒寫的確認後撤下）；前提照舊帶 `[P2]`；區塊標記 v3。
 * `<代號>` 在組討論包時換成這一檔的代號。
 */
export const DISCUSSION_V3 = `你是我的反方審查員，不是我的啦啦隊。我們要討論的是我持有這檔股票的理由還成不成立。

1. 站在反方。不要順著我說；我講得越肯定，你越要問證據在哪裡。
2. 把「論點壞了」和「價格跌了」分開。價格下跌本身不是論點壞了的證據，價格上漲也不是論點成立的證據。
3. 討論中一定要問我，並且自己也回答：「如果我現在沒有這檔股票，今天會不會用現在的價格買進？」
4. 你可以上網查資料。每一件事都要給來源與日期，並分清楚「公司申報或財報裡寫的」和「報導或分析師說的」。
   查不到來源的事，就說查不到。下面這份資料是 stock bot 整理的，數字由程式算好，可以直接用。
5. 不要給目標價，不要建議買賣幾股。部位大小由 stock bot 的規則決定。
6. 如果「這次為什麼討論」寫的是前提被判不成立：先講這個判斷站不站得住，再談要不要改論點。
   在前提不成立之後才改論點，很容易只是替「繼續持有」找新理由；發現我在這樣做的時候請直接指出來。
7. 出場條件要寫成之後查得到的事：財報數字的門檻（例如毛利率連兩季低於 70%），
   或公司申報裡會寫的事（例如公司在 8-K 下修全年財測）。「基本面轉差」這種不算。
8. 下面「前提」一節的每一條都有編號（P2）。收尾時，沒改的前提照抄原文並保留編號，例如 \`1. [P2] …\`；
   意思改了就不要寫編號，寫成新的一條。
   出場條件不用編號：收尾區塊的「出場條件」要寫討論完我要的全部出場條件，沒改的也照抄原文；沒寫進去的，會在我確認之後撤下。
9. 我說「收尾」的時候，只輸出下面這個區塊，格式一字不改，裡面用我們討論出來的內容：

===STOCKBOT 論點 v3 <代號>===
論點：
（一段，300 字以內：我為什麼持有它）
前提：
1. [P2] （沒改的前提：照抄原文，保留編號）
2. （新的、或意思改了的前提：不寫編號。一條一行，合計最多 5 條）
出場條件：
1. （討論完我要的全部出場條件，沒改的也照抄：查得到的事） → 出清
2. （查得到的事） → 減半
3. （查得到的事） → 重新審查
這次的結論：維持｜修正論點｜減半｜出清
理由：（一句）
===END===`;

/** 討論的情境（§1.7）：從乙類通知按的 BREAK；只有預設前提而且沒有論點本文 NEW；其餘 ROUTINE。 */
export type DiscussionMode = 'NEW' | 'ROUTINE' | 'BREAK';
export const DISCUSSION_MODES: readonly DiscussionMode[] = ['NEW', 'ROUTINE', 'BREAK'];

/** 沒指定情境時程式選（§1.7）。notif：從通知按的（通知編號）。 */
export function pickMode(file: Pick<ThesisFile, 'kind' | 'thesis'>, notif?: number | null): DiscussionMode {
  if (notif) return 'BREAK';
  return file.kind === 'DEFAULT_ONLY' && !file.thesis?.text ? 'NEW' : 'ROUTINE';
}

/** 討論包的數字（由程式算好；只放比重，不放金額與股數）。比例都是小數。 */
export interface DiscussionNumbers {
  /** 收盤那一天（訊號日）。 */
  date: string;
  close: number | null;
  /** 距 52 週高點（負數）。 */
  fromHigh: number | null;
  ma200: number | null;
  /** 收盤相對 200 日均線。 */
  vsMa: number | null;
  slow: 'STD' | 'HALF';
  ret1y: number | null;
  /** 這檔占總資產。 */
  weight: number | null;
  stdWeight: number | null;
  /** 自選桶合計占總資產、自選的預算。 */
  ownTotal: number | null;
  ownBudget: number | null;
  /** 最近 8 季財報表（XBRL 原文）；沒有是 null。 */
  xbrl: string | null;
  /** 開檔時就是減半（§3.8）：加入時距 52 週高點的跌幅（負數）；不是或不知道是 null。 */
  openedHalf: number | null;
  /** 部位達標準比重 2 倍以上（§3.6.3；sizeFlag 成立時才有）：占總資產（自選桶）、是標準比重的幾倍。 */
  size?: { weight: number; ratio: number } | null;
}

const fin = (x: number) => (Number.isFinite(x) ? x : null);

/** 從帳戶與市場算討論包的數字（只有比例，沒有金額與股數）。xbrl：財報表原文（呼叫的地方取得）。 */
export function discussionNumbers(acct: Account, view: MarketView, ticker: string, xbrl: string | null): DiscussionNumbers {
  const c = view.close[ticker];
  const close = c ? fin(c[view.i]) : null;
  const hi = c ? fin(rollingMax(c, view.i, SLOW.highDays)) : null;
  const ma = c ? fin(sma(c, view.i, SLOW.maDays)) : null;
  const total = totalValue(acct, view);
  const sh = (acct.lots.own[ticker] ?? 0) + (acct.lots.mom[ticker] ?? 0) + (acct.lots.core[ticker] ?? 0);
  const meta = acct.own[ticker];
  const rule = acct.rule.own[ticker];
  const opened = meta?.opened;
  return {
    date: view.date,
    close,
    fromHigh: close !== null && hi ? close / hi - 1 : null,
    ma200: ma,
    vsMa: close !== null && ma ? close / ma - 1 : null,
    slow: rule?.applied === 'HALF' ? 'HALF' : 'STD',
    ret1y: c ? fin(trailingReturn(c, view.i)) : null,
    weight: total > 0 && close !== null ? (sh * close) / total : null,
    stdWeight: rule?.stdWeight ?? null,
    ownTotal: total > 0 ? bucketValue(acct, view, 'own') / total : null,
    ownBudget: acct.cfg.ratio.own,
    xbrl,
    openedHalf: opened?.startState === 'HALF' && opened.drawdownAtOpen !== null ? opened.drawdownAtOpen : null,
    size: (() => {
      const s = meta?.sizeFlag ? sizeOf(acct, view, ticker) : null;
      return s ? { weight: s.weight, ratio: s.ratio } : null;
    })(),
  };
}

/** BREAK 情境要的：審查判哪一條前提不成立、建議什麼、依據的原文。 */
export interface BreakInfo {
  notif: number | null;
  premiseId: string | null;
  premiseText: string | null;
  tier: Tier | null;
  quote: string | null;
  /** 原文的出處（例如「8-K 2027-01-06」）。 */
  source: string | null;
}

/** 討論包長度目標（字）。 */
export const MAX_PACK_CHARS = 12_000;
const MAX_EVENTS = 10;
const MAX_REVIEWS = 3;

const pc = (x: number | null, d = 1) => (x === null || !Number.isFinite(x) ? '—' : `${(x * 100).toFixed(d)}%`);
const spc = (x: number | null, d = 1) => (x === null || !Number.isFinite(x) ? '—' : `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(d)}%`);
const px = (x: number | null) => (x === null || !Number.isFinite(x) ? '—' : x.toFixed(2));

const SOURCE_TEXT: Record<string, string> = { EDGAR: '申報分類', SCAN: '每日掃描標記', AI: 'AI 轉交', PRICE: '價格規則' };
const TRIGGER_TEXT: Record<string, string> = { MONTHLY: '月審', EARNINGS: '財報後審查', THESIS: '論點變動後審查', MANUAL: '審查', EARLY: '提前審查', CONDITION: '條件觸發的審查', 慢規則減半: '減半檢視' };
const STATUS_TEXT: Record<string, string> = { SPLIT: '沒有一致結論', INVALID: '格式不合格，沒有結論', DATA_MISSING: '資料缺漏', TIMEOUT: '逾時，沒有結論', NO_RESULT: '沒有結果' };
const PREM_TEXT: Record<string, string> = { HOLDS: '成立', BROKEN: '不成立', INSUFFICIENT: '證據不足' };
const COND_STATE: Record<string, string> = { ACTIVE: '監測中', REVIEW_ONLY: '只在定期審查時檢查', MANUAL: '只記錄', MET: '已成立' };
const ACTION_TEXT: Record<CondAction, string> = { EXIT: '出清', HALF: '減半', REVIEW: '重新審查' };
/** 全形空白（討論包裡日期與內容之間的分隔，照 §1.7 的範例）。 */
const SP = '　';
const md = (iso: string | null) => (iso ? `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}` : '—');

function whySection(file: ThesisFile, n: DiscussionNumbers, mode: DiscussionMode, brk: BreakInfo | null, prev: PrevFile | null): string[] {
  if (mode === 'NEW') {
    // 賣光之後又買回（T44）：從「上次為什麼賣、這次為什麼買回」問起
    // 有買進時的一句話（T40）：從那句話問起，不再要 claude.ai 先問為什麼買
    const L = prev
      ? [
          '我持有這檔，這一次還沒有寫下論點。我之前持有過它，下面「上一次持有時的論點」記著那一次的論點與賣出的原因。',
          ...(file.buyNote?.text ? ['「我買進時的想法」是這次買的時候隨手寫的一句話。'] : []),
          '請先問我：上次為什麼賣、這次為什麼買回；再問哪幾件事要繼續成立、什麼情況下我會承認看錯。',
          '我回答之後再和我討論，不要直接替我寫。',
        ]
      : file.buyNote?.text
        ? ['我持有這檔，但還沒有寫下論點。下面「我買進時的想法」是我買的時候隨手寫的一句話。', '請從那句話問起：它背後的理由是什麼、哪幾件事要繼續成立、什麼情況下我會承認看錯。', '我回答之後再和我討論，不要直接替我寫。']
        : ['我持有這檔，但還沒有寫下論點。請先問我 3 個問題（為什麼買、哪幾件事要繼續成立、什麼情況下我會承認看錯），', '我回答之後再和我討論，不要直接替我寫。'];
    if (n.openedHalf !== null) L.push(`這檔是在大跌之後買的（加入時比 52 週高點低 ${pc(-n.openedHalf, 0)}）。`, '請先問我：它為什麼跌、為什麼我認為市場錯了。');
    return L;
  }
  if (mode === 'ROUTINE') {
    const L = ['例行檢視。請先挑出論點裡最弱的一條前提，從那裡開始。'];
    if (n.size) L.push(`這檔現在占總資產 ${pc(n.size.weight)}，是標準比重的 ${n.size.ratio.toFixed(1)} 倍。`, '請問我：今天從零開始，會不會買到這個比重。');
    return L;
  }
  const p = brk?.premiseId ? `前提 ${brk.premiseId}「${brk.premiseText ?? '…'}」` : '我的一條前提';
  const tier = brk?.tier ? `建議${TIER_NAME[brk.tier]}` : '建議調整部位';
  const L = [`stock bot 的審查（3 票一致）認為${p}不成立，${tier}。它的依據：`];
  L.push(brk?.quote ? `「${brk.quote.slice(0, 500)}」— ${brk.source ?? '申報原文'}` : '（引用的原文在 stock bot 網站的審查紀錄）');
  L.push(`我還沒決定。這是我第 ${(file.thesis?.afterBreak ?? 0) + 1} 次在前提被判不成立之後討論這檔的論點。`);
  return L;
}

/** 買進時的一句話（T40，own_thesis §1.7）：不一定對、不是論點，只當開場。沒有就不放這一節。 */
function buyNoteSection(file: ThesisFile): string[] {
  const b = file.buyNote;
  if (!b?.text) return [];
  return ['## 我買進時的想法', '這是我買的時候隨手寫的一句話，不一定對，也不是論點；請拿來當開場，不要當成已經成立的前提。', `「${b.text}」（${b.at} 寫的）`, ''];
}

/**
 * 上一次持有時的論點（T44，own_thesis §1.2）：賣光之後又買回、有上一份論點檔時才有這一節。
 * 前提不帶編號：收尾區塊的 `[P2]` 只指這一份的前提，上一份的編號放進來會混在一起。
 */
function prevSection(prev: PrevFile | null): string[] {
  if (!prev) return [];
  const L = ['## 上一次持有時的論點', '這是上一次持有時的論點與賣出的原因，不一定還成立；請拿來比較這次買回的理由。'];
  L.push(`持有期間：${prev.openedAt ? `${prev.openedAt} 開檔` : '開檔日不明'} → ${prev.closedAt} ${prev.closedVerb}（原因：${prev.reasonText}）`);
  if (prev.thesis) L.push(`論點（第 ${prev.thesis.version} 版，${prev.thesis.setAt} 定）：`, prev.thesis.text);
  if (prev.premises.length) {
    L.push('前提：');
    prev.premises.forEach((p) => L.push(`- ${p.text}`));
  }
  if (!prev.hasThesis) L.push('那一次沒有寫下論點（只用系統預設前提做一般健康檢查）。');
  if (prev.conditions) {
    const live = prev.conditions.filter((c) => c.state === 'LIVE');
    const met = prev.conditions.filter((c) => c.state === 'MET');
    if (live.length) {
      L.push('當時監測中的出場條件（買回後不會再監測）：');
      live.forEach((c) => L.push(`- ${c.text} → ${c.action ? ACTION_TEXT[c.action] : '重新審查'}（${c.note}）`));
    }
    if (met.length) {
      L.push('那一次已經成立的出場條件：');
      met.forEach((c) => L.push(`- ${c.text} → ${c.action ? ACTION_TEXT[c.action] : '重新審查'}（${c.note}）`));
    }
    if (!live.length && !met.length) L.push('那一次沒有定出場條件。');
  }
  L.push('');
  return L;
}

function thesisSection(file: ThesisFile): string[] {
  const t = file.thesis;
  if (!t?.text) return ['還沒有'];
  const meta = `（${t.setAt} 定，${t.source === 'DISCUSSION' ? '討論後貼回' : t.source === 'DRAFT' ? '用了 stock bot 的草稿' : '在網站手寫'}，第 ${t.version} 版${t.afterBreak ? `，失效後修改第 ${t.afterBreak} 次` : ''}）`;
  return [t.text, meta];
}

/**
 * 前提那一節最後的說明（T47，own_thesis §1.7）：stock bot 的審查讀得到什麼。放在討論包的內容裡，不是固定指示，
 * 所以不升版本。目的：收尾時前提盡量寫成審查查得到的事；寫不成的先講明要靠使用者自己留意。
 * T54（web_evidence_design §2.6 最後一列）：審查現在也讀同業的申報與清單內網站的網頁全文（分析師讀完證據包另外取），
 * 「證據不足」的前提月底會再審、讓它去找（§1.7 的 WEB_DUE），文字跟著改。
 */
export const PREMISE_DATA_NOTE = [
  '',
  '（stock bot 的審查讀這家公司自己的資料：最近 8 季的財報數字、最近一份 10-Q／10-K、之後的 8-K。有我自己的論點時，審查的 AI 讀完這些還可以另外去取：我填的同業在 EDGAR 的申報，以及清單內網站的網頁全文（公司與同業的新聞室、TrendForce 這類產業研究機構公開的新聞稿、少數產業媒體）。',
  '清單外的網站（大型通訊社、付費報告、評論與社群網站）它讀不到，搜尋結果的標題不能當證據。標「證據不足」的前提就是這些都沒查到的；距上次審查滿 25 天，月底會再審一次、讓它再去找。',
  '收尾時請盡量把前提寫成公司申報、同業申報或清單內網站查得到的事（例如「TrendForce 公布的 DRAM 合約價」）；寫不成的，先告訴我這一條 stock bot 監測不了、要靠我自己留意。）',
];

function premiseSection(file: ThesisFile): string[] {
  if (!file.premises.length) return ['還沒有', ...PREMISE_DATA_NOTE];
  const L = file.premises.map((p) => {
    // 信念（T60，composite_layer_design §2.3）不進審查：寫明是我選擇相信的，不寫「還沒有檢查過」
    const chk = p.verify?.by === 'NONE' ? '信念：查不到，是我選擇相信的（審查不檢查這一條）' : p.lastCheck ? `${PREM_TEXT[p.lastCheck.status] ?? p.lastCheck.status}（${p.lastCheck.date} 審查）` : '還沒有檢查過';
    const def = p.origin === 'SYSTEM_DEFAULT' ? '（系統預設）' : '';
    // 編號後面加「.」（T40）：收尾時沒改的前提照抄、保留這個編號（[P2]）
    return `${p.id}. ${p.text}${def}${SP}— ${chk}${p.splitAfter ? '；之後的審查沒有一致結論' : ''}`;
  });
  if (file.kind === 'DEFAULT_ONLY') L.push('（這些是系統預設的一般健康檢查，不是我的論點。）');
  return [...L, ...PREMISE_DATA_NOTE];
}

function conditionSection(file: ThesisFile): string[] {
  const isMine = (c: ThesisFile['conditions'][number]) => !!c.acceptedAt || c.origin === 'USER';
  const owned = file.conditions.filter((c) => isMine(c) && c.status in COND_STATE && c.status !== 'MET');
  const met = file.conditions.filter((c) => isMine(c) && c.status === 'MET');
  const proposed = file.conditions.filter((c) => c.status === 'PROPOSED');
  if (!owned.length && !met.length && !proposed.length) return ['還沒有'];
  const L: string[] = [];
  if (owned.length) {
    // 不帶編號（T42）：收尾區塊寫要的全部出場條件；哪一條和舊的相同、取代哪一條，由 stock bot 改寫的 AI 對照
    L.push('你定的（目前監測中；收尾時要留的照抄進區塊，沒寫進去的會在我確認後撤下）：');
    owned.forEach((c) => {
      const act = c.action ? ACTION_TEXT[c.action] : '重新審查';
      L.push(`- ${c.text} → ${act}（${md(c.acceptedAt ?? c.createdAt)} 定；${COND_STATE[c.status]}）`);
    });
  }
  if (met.length) {
    L.push('已成立（一次性，不再監測；要再監測就寫成新的一條）：');
    met.forEach((c) => L.push(`${c.text}（${c.metAt?.slice(0, 10) ?? ''} 成立）`));
  }
  if (proposed.length) {
    L.push('AI 建議、還沒勾選的：');
    proposed.forEach((c, k) => L.push(`W${k + 1} ${c.text}`));
  }
  return L;
}

function eventSection(file: ThesisFile): string[] {
  const evs = file.events.filter((e) => e.isNew).slice(0, MAX_EVENTS);
  if (!evs.length) return ['沒有'];
  return evs.map((e) => {
    // 類別與說明用持股頁同一套白話（T34；掃描事件的說明原本帶英文代碼）
    const what = eventLabel({ code: e.code, detail_code: e.detailCode ?? null });
    const form = e.form === 'NEWS' ? '新聞標題' : e.form;
    const src = SOURCE_TEXT[e.source] ?? e.source;
    const plain = eventDetail(e.detail);
    const detail = plain ? `：${plain.slice(0, 160)}` : '';
    return `${e.date}${SP}${form}${SP}${src}：${what}${detail}`;
  });
}

function reviewSection(file: ThesisFile): string[] {
  const rs = file.reviews.filter((r) => r.status !== 'PENDING' && (r.fn === 'OWN_REVIEW' || r.fn === 'OWN_DROP')).slice(0, MAX_REVIEWS);
  if (!rs.length) return ['還沒有'];
  const L: string[] = [];
  for (const r of rs) {
    const kind = TRIGGER_TEXT[r.trigger ?? ''] ?? r.label;
    const votes = Math.max(0, ...Object.values(r.votes));
    const head = r.status === 'AGREED' || r.status === 'INSUFFICIENT' ? `${r.verdict ? (TIER_NAME[r.verdict as Tier] ?? r.verdict) : '—'}（${votes} 票）` : (STATUS_TEXT[r.status] ?? r.status);
    const broken = r.brokenPremises.length ? `不成立：${r.brokenPremises.join('、')}。` : '';
    // 回應的白話和論點檔的 note 同一套（T34）：SKIPPED「月報裡沒有動它（當成不同意）」、NONE「上次的失效通知沒有回應」
    const resp = r.response ? `我的回應：${outcomeText(r.response)}${r.response.reason ? `（${r.response.reason}）` : ''}。` : r.notif ? '我的回應：還沒回。' : '';
    L.push(`${r.date}${SP}${kind}：${head}。${broken}${resp}`);
    if (r.summary) L.push(`${SP}${r.summary.replace(/\s+/g, ' ')}`);
  }
  return L;
}

function numberSection(n: DiscussionNumbers, xbrl: string | null): string[] {
  const L = [
    `收盤 ${px(n.close)}（${n.date}）；距 52 週高點 ${spc(n.fromHigh)}；200 日均線 ${px(n.ma200)}（收盤相對均線 ${spc(n.vsMa)}）`,
    `慢規則狀態：${n.slow === 'HALF' ? '減半中' : '標準'}；過去一年報酬 ${spc(n.ret1y)}`,
    `比重：占總資產 ${pc(n.weight)}，標準比重 ${pc(n.stdWeight)}；自選桶合計 ${pc(n.ownTotal, 0)}（預算 ${pc(n.ownBudget, 0)}）`,
    '',
    '最近 8 季財報表（XBRL）：',
    xbrl ?? '沒有財報表',
  ];
  return L;
}

/**
 * 組討論包（own_thesis §1.7）。file：論點檔；n：程式算好的數字；mode：情境；brk：BREAK 情境的依據。
 * 長度目標 12,000 字以內：事件最多 10 件、審查最多 3 次；還是太長時先縮財報表，最後截斷。
 * prev：賣光之後又買回時的上一份論點檔（T44；多一節「## 上一次持有時的論點」，NEW 情境從上次為什麼賣問起）。
 */
export function discussionPack(file: ThesisFile, n: DiscussionNumbers, mode: DiscussionMode, brk: BreakInfo | null = null, prev: PrevFile | null = null): string {
  const cut = DISCUSSION_V3.indexOf('\n9. ');
  const ask = DISCUSSION_V3.slice(0, cut).trim();
  const out = DISCUSSION_V3.slice(cut + 1).replace('<代號>', file.ticker);
  const build = (xbrl: string | null) =>
    [
      `# ${file.ticker} 論點討論包（stock bot，${n.date}，${DISCUSSION_VERSION}）`,
      '',
      '## 請你做的事',
      ask,
      '',
      '## 這次為什麼討論',
      ...whySection(file, n, mode, brk, prev),
      '',
      ...buyNoteSection(file),
      ...prevSection(prev),
      '## 我的論點',
      ...thesisSection(file),
      '',
      '## 前提（最近一次檢查）',
      ...premiseSection(file),
      '',
      '## 出場條件',
      ...conditionSection(file),
      '',
      '## 上次審查之後的事件',
      ...eventSection(file),
      '',
      '## 最近的審查與我的回應',
      ...reviewSection(file),
      '',
      '## 數字',
      ...numberSection(n, xbrl),
      '',
      '## 收尾時的輸出格式',
      out,
      '',
    ].join('\n');
  let xbrl = n.xbrl;
  let text = build(xbrl);
  // 太長：財報表一季一季拿掉（舊的先拿），再不夠就整張拿掉
  while (text.length > MAX_PACK_CHARS && xbrl && xbrl.split('\n').length > 2) {
    xbrl = xbrl.split('\n').slice(0, -1).join('\n');
    text = build(xbrl);
  }
  if (text.length > MAX_PACK_CHARS && xbrl) text = build('（放不下，沒有放進來）');
  if (text.length > MAX_PACK_CHARS) {
    // 最後手段：保留開頭與收尾的格式，中間截斷
    const tail = `\n…（中間太長，截斷）\n\n## 收尾時的輸出格式\n${out}\n`;
    text = text.slice(0, MAX_PACK_CHARS - tail.length) + tail;
  }
  return text;
}

// ---------------------------------------------------------------- 貼回的解析（§1.8）

export interface ParsedExit {
  text: string;
  action: CondAction;
  /** 動作沒寫或不認得，當成「重新審查」（預覽要標出來）。 */
  guessed: boolean;
}

export interface ParsedThesis {
  /** 找到固定格式的區塊。 */
  found: boolean;
  /** 擋下來的原因（代號不符）；有值時其他欄位是空的。 */
  error: string | null;
  thesis: string;
  premises: string[];
  /** 每一條前提行首的 `[P2]`（T40，和 premises 一一對應）：沿用的前提編號；沒寫是 null。 */
  premiseIds: (string | null)[];
  exits: ParsedExit[];
  /** 「這次的結論」（只顯示，不會自動做任何事）。 */
  conclusion: string | null;
  reason: string | null;
  /** 預覽要標出來的事（截掉的、動作不認得的、沒找到格式）。 */
  notes: string[];
}

/** 上限（§1.8）。 */
export const THESIS_LIMITS = { thesis: 600, premises: 5, premise: 200, exits: 6, exit: 300 } as const;

const ACTIONS: Record<string, CondAction> = { 出清: 'EXIT', 減半: 'HALF', 重新審查: 'REVIEW' };
const TAG = /^\s*(論點|前提|出場條件|這次的結論|理由)\s*[：:]\s*(.*)$/;
const ITEM = /^\s*(\d+)\s*[.、)）．]\s*(.*)$/;
/** 行首的編號標記：前提的 `[P2]`（T40）；v2 區塊出場條件的 `[C12]`（T42 起忽略編號、只去掉標記）。全形括號也收。 */
const PREM_TAG = /^[[［]\s*(P\d{1,4})\s*[\]］]\s*/i;
const COND_TAG = /^[[［]\s*C(\d{1,9})\s*[\]］]\s*/i;

/**
 * 解析 claude.ai 收尾時輸出的區塊（own_thesis §1.8）：
 *   先去掉 markdown 的程式碼圍欄；找 `===STOCKBOT 論點 v3 <代號>===`（舊的 v1、v2 照收）到 `===END===`（有好幾個時取最後一個）；代號要和這一頁相同。
 *   前提行首的 `[P2]`（T40）讀成沿用的編號，文字去掉標記；出場條件行首的 `[C12]`（v2 區塊）只去掉標記、不讀編號（T42）。
 *   區塊內照行首的標籤切（全形或半形冒號）；前提、出場條件只算行首是「數字 + . 、 )」的行；
 *   出場條件用最後一個 → 或 -> 切成條件與動作，動作只收出清、減半、重新審查，其他當成重新審查並標出來；
 *   超過上限的截掉並標出來；找不到標記時整段放進論點欄。
 */
export function parseThesisBlock(text: string, ticker: string): ParsedThesis {
  const empty: ParsedThesis = { found: false, error: null, thesis: '', premises: [], premiseIds: [], exits: [], conclusion: null, reason: null, notes: [] };
  const lines = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((l) => !/^\s*(```|~~~)/.test(l));
  const starts = lines.map((l, i) => ({ i, m: /^\s*===\s*STOCKBOT\s+論點\s+v[123]\s+([A-Za-z0-9.-]+)\s*===\s*$/.exec(l) })).filter((x) => x.m);
  const start = starts.at(-1);
  const end = start ? lines.findIndex((l, i) => i > start.i && /^\s*===\s*END\s*===\s*$/.test(l)) : -1;
  if (!start || end < 0) {
    const whole = lines.join('\n').trim();
    return { ...empty, thesis: whole, notes: whole ? ['沒找到固定格式，請自己分到三欄'] : [] };
  }
  const got = start.m![1].toUpperCase();
  // BRK.B 和 BRK-B 是同一檔（claude.ai 可能照別的寫法回）
  if (normalizeTicker(got) !== normalizeTicker(ticker)) return { ...empty, found: true, error: `這段是 ${got} 的論點，這一頁是 ${ticker.toUpperCase()}。請貼這一檔的討論結果。` };

  const sec: Record<string, string[]> = { 論點: [], 前提: [], 出場條件: [], 這次的結論: [], 理由: [] };
  let cur: string | null = null;
  for (const l of lines.slice(start.i + 1, end)) {
    const t = TAG.exec(l);
    if (t) {
      cur = t[1];
      if (t[2].trim()) sec[cur].push(t[2]);
      continue;
    }
    if (cur) sec[cur].push(l);
  }
  const notes: string[] = [];
  const items = (rows: string[], label: string) => {
    const out: string[] = [];
    let loose = 0;
    for (const r of rows) {
      const m = ITEM.exec(r);
      if (m) {
        if (m[2].trim()) out.push(m[2].trim());
      } else if (r.trim()) loose++;
    }
    if (loose) notes.push(`${label}有 ${loose} 行沒有編號，沒有算進去`);
    return out;
  };

  let thesis = sec.論點.map((l) => l.trim()).filter(Boolean).join('\n');
  if (thesis.length > THESIS_LIMITS.thesis) {
    notes.push(`論點超過 ${THESIS_LIMITS.thesis} 字，後面截掉了`);
    thesis = thesis.slice(0, THESIS_LIMITS.thesis);
  }
  // 行首的 [P2]（T40）：讀成沿用的編號，文字去掉標記
  const premRows = items(sec.前提, '前提')
    .map((p) => {
      const m = PREM_TAG.exec(p);
      return m ? { id: m[1].toUpperCase(), text: p.slice(m[0].length).trim() } : { id: null, text: p };
    })
    .filter((p) => p.text);
  let premises = premRows.map((p) => p.text);
  let premiseIds = premRows.map((p) => p.id);
  if (premises.length > THESIS_LIMITS.premises) {
    notes.push(`前提超過 ${THESIS_LIMITS.premises} 條，只留前 ${THESIS_LIMITS.premises} 條`);
    premises = premises.slice(0, THESIS_LIMITS.premises);
    premiseIds = premiseIds.slice(0, THESIS_LIMITS.premises);
  }
  premises = premises.map((p, k) => {
    if (p.length <= THESIS_LIMITS.premise) return p;
    notes.push(`前提第 ${k + 1} 條超過 ${THESIS_LIMITS.premise} 字，後面截掉了`);
    return p.slice(0, THESIS_LIMITS.premise);
  });
  let exitRows = items(sec.出場條件, '出場條件');
  if (exitRows.length > THESIS_LIMITS.exits) {
    notes.push(`出場條件超過 ${THESIS_LIMITS.exits} 條，只留前 ${THESIS_LIMITS.exits} 條`);
    exitRows = exitRows.slice(0, THESIS_LIMITS.exits);
  }
  const exits: ParsedExit[] = exitRows.map((row0, k) => {
    // v2 區塊行首的 [C12]（T40）：T42 起出場條件是整組取代，編號忽略、只取文字
    const tag = COND_TAG.exec(row0);
    const row = tag ? row0.slice(tag[0].length) : row0;
    const a = row.lastIndexOf('→');
    const b = row.lastIndexOf('->');
    const [at, len] = a >= b ? [a, 1] : [b, 2];
    let cond = at >= 0 ? row.slice(0, at).trim() : row.trim();
    const word = at >= 0 ? row.slice(at + len).trim().replace(/[。.．,，;；!！\s]+$/, '') : '';
    const action = ACTIONS[word];
    if (!action) notes.push(`出場條件第 ${k + 1} 條的動作${word ? `「${word}」不認得` : '沒寫'}，先當成「重新審查」`);
    if (cond.length > THESIS_LIMITS.exit) {
      notes.push(`出場條件第 ${k + 1} 條超過 ${THESIS_LIMITS.exit} 字，後面截掉了`);
      cond = cond.slice(0, THESIS_LIMITS.exit);
    }
    return { text: cond, action: action ?? 'REVIEW', guessed: !action };
  });
  const one = (rows: string[]) => rows.map((l) => l.trim()).filter(Boolean).join(' ') || null;
  return { found: true, error: null, thesis, premises, premiseIds, exits, conclusion: one(sec.這次的結論), reason: one(sec.理由), notes };
}

// ---------------------------------------------------------------- 出場條件整組取代（T42，own_thesis §1.8）

/** 這檔目前監測中的你定的條件（ACTIVE、REVIEW_ONLY、MANUAL）：編輯論點頁預填、存檔時比對、改寫時的對照範圍。 */
export interface LiveCondition {
  id: number;
  text: string;
  action: CondAction | null;
  /** 狀態的白話（監測中、只在定期審查時檢查、只記錄）。 */
  status: string;
}

export interface ExitPlan {
  /** 出場條件和監測中的不同（新增、改字、少了幾條）→ 整組連同監測中的條件送改寫。 */
  changed: boolean;
  /** 文字和監測中的一條相同、成立時的動作不同的（沒改動時存檔直接改動作；有改動時等確認才改）。 */
  actionChanged: { index: number; id: number; text: string; action: CondAction; was: CondAction | null }[];
  /** 文字和監測中的一條相同（去掉空白與標點後比）的：這一條（index）→ 那一條的列編號。改寫結果當「相同」的後備。 */
  sameByText: Record<number, number>;
}

/** 狀態代號 → 算不算「監測中」（編輯論點頁預填、整組取代的範圍）。 */
export const LIVE_CONDITION_CODES = ['ACTIVE', 'REVIEW_ONLY', 'MANUAL'] as const;

/**
 * 編輯論點的出場條件（存檔後要的完整清單）和目前監測中的條件比（純函式，T42）：
 *   每一條都能對到一條監測中的（文字去掉空白與標點後相同；一條只能對一次）、而且條數相同 → 沒改動；
 *   其他（新增、改字、少了幾條）→ 有改動。動作不同不算改動（只記在 actionChanged）。
 */
export function planExits(exits: { text: string; action: CondAction }[], live: LiveCondition[]): ExitPlan {
  const used = new Set<number>();
  const actionChanged: ExitPlan['actionChanged'] = [];
  const sameByText: Record<number, number> = {};
  exits.forEach((x, index) => {
    const hit = live.find((c) => !used.has(c.id) && premiseKey(c.text) === premiseKey(x.text));
    if (!hit) return;
    used.add(hit.id);
    sameByText[index] = hit.id;
    if (hit.action && hit.action !== x.action) actionChanged.push({ index, id: hit.id, text: hit.text, action: x.action, was: hit.action });
  });
  const changed = exits.length !== live.length || Object.keys(sameByText).length !== exits.length;
  return { changed, actionChanged, sameByText };
}
