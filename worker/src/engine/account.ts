// 帳戶狀態（可序列化）與共用的小工具。帳本是快照式的（設計 §2.1.1）：
// 使用者填每檔股數與現金，系統把兩份快照的差異拆成事件、分到各桶。
// 這裡的函式都是純函式：輸入狀態與市場資料，回傳新的狀態。
import { annualizedVol, drawdownFromHigh } from './indicators';
import type { OrderLine, Composed } from './orders';
import { initialSlowState, initialStateForNewPick, type SlowRuleState } from './slowRule';
import { CASH, DEFAULT_CONFIG, cellKey, emptyRuleState, type CellMap, type EngineConfig, type OwnAction, type OwnState, type RuleState } from './types';

/** AI 的固定檔位（設計 §0）。HALF 原稱「標準的一半」，2026-11-11 起和規則的「減半」是同一個動作。 */
export type Tier = 'EXIT' | 'HALF' | 'HOLD' | 'STANDARD' | 'RAISE';
export const TIER_NAME: Record<Tier, string> = { EXIT: '出清', HALF: '減半', HOLD: '不動', STANDARD: '回到標準', RAISE: '提高到標準的 125%' };

export interface Premise {
  id: string;
  text: string;
  origin: 'USER' | 'AI_DRAFT_ACCEPTED' | 'SYSTEM_DEFAULT';
  /**
   * 怎樣算不成立：最多 3 個分開的子句（composite_layer_design §2.2，T60；審查逐句回答）。
   * T60 之前存的是一段字（string），新增自選的舊入口也還寫一段字；讀的時候一律經過 breaksOf()。
   */
  breaksIf?: string[] | string;
  /** 怎樣算證實：什麼樣的原文算這條前提成立（和 breaksIf 對稱；composite §2.2）。手寫的前提可以不填。 */
  confirmsIf?: string;
  /**
   * 怎麼驗證（composite §2.2）：by 用什麼查、source 哪個來源、every 多久會有新的一份（天；沒填用 VERIFY_EVERY_DEFAULT）。
   * by = NONE 是「信念」（§2.3）：留在論點裡、持股頁標明查不到，不進審查的逐條判定、不計入成績、不觸發 WEB_DUE。
   * 沒有這個欄位（手寫沒填、T60 之前的前提）= 照舊進審查。
   */
  verify?: PremiseVerify;
  /** 加入的訊號日（own_thesis §1.2；T25 之前的前提沒有這個欄位）。 */
  addedAt?: string;
}

/** 前提用什麼查（composite §2.2；和草稿的 verify.by 同一組）：財報數字／這家公司的申報／同業的申報／網站（算不算數看網域級別）／查不到（信念）。 */
export const VERIFY_BY = ['XBRL', 'FILING', 'PEER_FILING', 'WEB', 'NONE'] as const;
export type VerifyBy = (typeof VERIFY_BY)[number];
export interface PremiseVerify {
  by: VerifyBy;
  /** 來源（例如 trendforce.com、SK 海力士的財報新聞稿）；沒寫是 undefined。 */
  source?: string;
  /** 多久會有新的一份（天）；沒寫用 VERIFY_EVERY_DEFAULT。 */
  every?: number;
}

/**
 * 前提新欄位的上限（composite §2.2、§2.3；網站存檔與草稿的程式檢查共用）。
 * everyDefault 和月底檢查點的 STALE_DAYS（src/app/thesis.ts）是同一個數字（設計寫明；測試確認兩邊一樣）。
 */
export const PREMISE_FIELD_LIMITS = { breaksClauses: 3, clause: 300, confirmsIf: 300, source: 200, everyMin: 7, everyMax: 400, everyDefault: 100, minCheckable: 2 } as const;
export const VERIFY_EVERY_DEFAULT = PREMISE_FIELD_LIMITS.everyDefault;

/** 怎樣算不成立的子句（舊資料的一段字當成一句；空的拿掉）。 */
export function breaksOf(p: Pick<Premise, 'breaksIf'>): string[] {
  const b = p.breaksIf;
  if (typeof b === 'string') return b.trim() ? [b.trim()] : [];
  return Array.isArray(b) ? b.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim()) : [];
}
/** 信念（composite §2.3）：verify.by = NONE。 */
export const isBelief = (p: Pick<Premise, 'verify'>): boolean => p.verify?.by === 'NONE';
/** 多久會有新的一份（天）：沒填用 100。 */
export const verifyEvery = (p: Pick<Premise, 'verify'>): number => p.verify?.every ?? VERIFY_EVERY_DEFAULT;

/**
 * 送來的 verify（網站或草稿）整理成存檔的形狀；不認得的 by → null（當成沒有指定）。
 * source 去頭尾空白、截到上限；every 要是 7～400 的整數，不是的話不存（用預設的 100）。信念（NONE）不存 source、every。
 */
export function normVerify(v: unknown): PremiseVerify | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const by = String(o.by ?? '').trim().toUpperCase();
  if (!(VERIFY_BY as readonly string[]).includes(by)) return null;
  if (by === 'NONE') return { by: 'NONE' };
  const L = PREMISE_FIELD_LIMITS;
  const source = typeof o.source === 'string' ? o.source.trim().slice(0, L.source) : '';
  const n = typeof o.every === 'number' ? o.every : typeof o.every === 'string' && o.every.trim() ? Number(o.every) : NaN;
  const every = Number.isInteger(n) && n >= L.everyMin && n <= L.everyMax ? n : null;
  return { by: by as VerifyBy, ...(source ? { source } : {}), ...(every !== null ? { every } : {}) };
}

/** 系統預設前提（own_thesis §1.12；2026-11-15 起三條，拿掉原本的第四條「慢規則本身」）。證據包另附程式算好的 D1～D3。 */
export const SYSTEM_DEFAULT_PREMISES: Premise[] = [
  { id: 'P1', text: '財報可信、沒有硬事件（重編、會計師辭任、延遲申報、被收購、重大監管處分）', origin: 'SYSTEM_DEFAULT' },
  { id: 'P2', text: '營收年增率沒有連兩季是負的', origin: 'SYSTEM_DEFAULT' },
  { id: 'P3', text: '稀釋每股盈餘沒有連兩季低於去年同季', origin: 'SYSTEM_DEFAULT' },
];

/** 論點本文（own_thesis §1.2；持股頁的「編輯論點」，T27）。 */
export interface Thesis {
  text: string;
  setAt: string;
  /** TYPED 在網站手寫／DISCUSSION 討論後貼回／DRAFT 用了 stock bot 草稿的論點本文、一字沒改（T56，web_evidence_design §2.3）。 */
  source: 'TYPED' | 'DISCUSSION' | 'DRAFT';
  version: number;
  afterBreak: number;
  lastAfterBreakAt: string | null;
}

/** 論點檔結案的原因（own_thesis §1.2 的 own_thesis_log `CLOSE`）。WATCH_REMOVED：候補移除（allocation_redesign §4.5，T85）。 */
export type CloseReason = 'REMOVED' | 'SOLD_OUT' | 'EXIT_AI' | 'EXIT_CONDITION' | 'HARD_EVENT' | 'WATCH_REMOVED';

/**
 * 一檔最近一次結案的論點檔（Account.ownClosed）。
 * last：結案那一刻的論點本文與自己的前提（T44）。
 * brokenAt：結案時這檔最近一次有前提被 3 票判不成立的訊號日（allocation_redesign §4.5 第 7 點，T85）：出清之後加進候補，
 * 候補的自動草擬與進場的程式檢查看它（30 個日曆天），防線才跨得過論點檔。沒有 = 沒有記錄。
 * held：這一筆是候補移除（WATCH_REMOVED）時，原本那一筆若是持有的結案就搬進這裡——「上一次持有時的論點」看它，
 * 免得候補的論點被顯示成上一次持有（§4.5 第 6 點）。
 */
export interface ClosedFile {
  fileId: string;
  reason: CloseReason;
  date: string;
  last?: ClosedThesis;
  brokenAt?: string | null;
  held?: { fileId: string; reason: CloseReason; date: string; last?: ClosedThesis } | null;
}

/**
 * 結案那一刻的論點（T44，own_thesis §1.2，2026-11-16 使用者同意改）：賣光再買回時，新的論點檔看得到上一份。
 * thesis：論點本文（沒有本文是 null）；premises：自己的前提（不是系統預設的）。只顯示、給討論包，不進 L2 的證據包。
 */
export interface ClosedThesis {
  thesis: { text: string; setAt: string; version: number } | null;
  premises: { id: string; text: string }[];
}

/** 結案時記下的論點：本文或自己的前提至少一樣有東西才算「有論點」。 */
export function closedThesisOf(meta: Pick<OwnMeta, 'thesis' | 'premises'>): ClosedThesis {
  const t = meta.thesis;
  return {
    thesis: t?.text ? { text: t.text, setAt: t.setAt, version: t.version } : null,
    premises: meta.premises.filter((p) => p.origin !== 'SYSTEM_DEFAULT').map((p) => ({ id: p.id, text: p.text })),
  };
}

export interface OwnMeta {
  /** 慢規則狀態機（每天收盤後前進）。 */
  slow: SlowRuleState;
  /** 已觸發、還沒列進清單的訊號（變動 < 5%，等月報）。 */
  pending: { action: OwnAction; date: string } | null;
  premises: Premise[];
  /** WATCH：從候補名單進場（allocation_redesign §4.5，promoteWatch 寫）。 */
  origin: 'INITIAL' | 'NEW' | 'TRANSFER' | 'ADOPT' | 'MANUAL' | 'WATCH';
  /**
   * 開始持有的訊號日（allocation_redesign §4.5 第 4 點，T85）：候補進場時寫進場那份快照的訊號日（論點檔編號的日期是加入候補那天）。
   * 「開檔滿幾天」「先買一半的 200 天」這類算「持有多久」的地方看它；沒有（舊資料、不是從候補進場的）= 用論點檔編號的日期。
   */
  heldSince?: string;
  /**
   * 從候補名單進場的那一次（allocation_redesign §4.5 第 17 點，promoteWatch 寫）：via 是照月報的進場項目買的（F29）還是你自己先買的（SELF）；
   * date 進場那份快照的訊號日（= heldSince）；shares 那時自選桶的股數；state 進場後的狀態；addedAt 加入候補的訊號日（持股頁寫「11/20 加入候補 → 2/3 進場」）；
   * conds：列在那一項進場項目上的進場條件（own_conditions 的列編號）；synced：進場條件的狀態已經補寫（下一次每日流程的 syncWatchConds）。
   * xbrlAt：進場之後補比過一次財報類條件的訊號日（T85 丙段，§4.5 第 21 點：候補期間休眠的出場、加碼條件，進場後的下一次每日流程比一次）。
   */
  entered?: { via: 'F29' | 'SELF'; date: string; shares: number; state: OwnState; addedAt: string; conds?: number[]; synced?: boolean; xbrlAt?: string };
  /**
   * 最近一次 F24 的檔位（AI 層給的輸入）。suggest = 3 票一致、和目前不同、有一條不成立的前提 → 月報並列。
   * premiseId：三票都判不成立（有申報或財報引用）的那條前提，有多條時取編號最小的（own_thesis §1.6 第 1 點）。
   * trigger：那次審查的觸發原因（§1.9 決定當天通知還是等月報）；basis：判不成立的依據（例如「8-K 2027-01-06」，乙類通知的理由用）。
   * basisNote：依據後面括號裡的字；依據有網頁時是「網頁；引用與連結在網站」（web_evidence_design §1.6），沒有這一欄 = 「引用在網站」。
   * agreed：三票同一個檔位、資料沒有缺漏（不看和目前狀態同不同、也不看靜默期）。慢規則通知上的「照 AI」只認這種（§3.4）；舊資料沒有 = 不算。
   */
  aiTier: { tier: Tier; date: string; runId?: string; suggest: boolean; premiseId?: string; trigger?: ReviewTrigger; basis?: string; basisNote?: string; agreed?: boolean } | null;
  raisedAt: string | null;
  /** 未解除的硬事件標記。 */
  flags: string[];
  /** 最近一次「AI 發起的當天通知」（乙類，own_thesis §1.10）的訊號日：每檔 30 個日曆天最多 1 則，超過的進月報。沒有 = 還沒發過。 */
  aiNotifiedAt?: string | null;
  /** 月審確認成立的你定的條件（甲類）：不當天通知，進隔天的月報（own_thesis §1.10）。月報產生時清掉。 */
  condMonthly?: CondNotice[];
  /** 你定的條件成立、動作是「重新審查」的訊號日：當天（或下一次開執行時）開一次審查，觸發原因 CONDITION（own_thesis §1.10）。開了或略過就清掉。 */
  condReviewDue?: string | null;
  /** 上一次 F24 之後已成立、還沒被新的審查處理的降級條件（F8 加回時註明）。 */
  metConds?: string[];
  /**
   * 論點檔的編號 `<代號>@<開檔的訊號日>`（own_thesis §1.2）；同一天結案又重開的加 `#2`、`#3`。
   * 條件與 own_thesis_log 都帶這個編號，讀條件時只讀現在這份的。T25 之前建立的自選沒有這個欄位。
   */
  fileId?: string;
  /** 論點本文；還沒寫是 null（T27 編輯）。 */
  thesis?: Thesis | null;
  /** 下一條前提的編號：前提的 id 發出去就不重用、不重排（修 N7）。 */
  premiseSeq?: number;
  /** 開檔時的慢規則狀態與距 52 週高點的跌幅（寫 log 的 OPEN 用；own_thesis §3.8）。BUILD：有論點、加入時已跌 20% → 先買一半（allocation_redesign §4.1）。 */
  opened?: { startState: 'STD' | 'HALF' | 'BUILD'; drawdownAtOpen: number | null };
  /**
   * 先買一半，確認後補滿（allocation_redesign §4.1，T83）：慢規則狀態是 BUILD（或 BUILD 期間跌 20% 進了審查後持有 WATCH）時才有。
   * 目標是標準比重的一半（rule.own[*].applied 記 BUILD）。補滿（F27）照做或不做、減半、「維持現在的大小」、「改成已經買到這個比例」之後拿掉。
   */
  build?: BuildInfo | null;
  /**
   * 開檔之後還沒設定過標準比重（allocation_redesign §4.1）：持股頁的標準比重那一欄多「先買一半，確認後再補滿」的選項，只在這第一次出現。
   * 新的自選開檔時（新增、轉入、認養、自己買進）寫 true，第一次在持股頁存標準比重之後拿掉。上線那天就有的、舊資料沒有這個欄位 = 不問。
   */
  buildAsk?: boolean;
  /**
   * 最近一次有前提被 3 票判不成立的訊號日（定期審查、跌幅審查；recordAiTier 帶前提時寫）。
   * 買進前的程式檢查（buyAllowed，allocation_redesign §4.0）看它：30 個日曆天內有就不提買進。舊資料沒有這個欄位 = 看 aiTier 與 dropReview。
   */
  brokenAt?: string | null;
  /**
   * 最近兩次財報後的審查（觸發原因 EARNINGS）有沒有證實前提（allocation_redesign §4.3，T83）：3 票一致、每一條可驗證的前提都判成立、
   * 判成立的引用有申報或財報。舊的在前，只留兩筆。提高到 125%（raiseAllowed）要兩筆都證實。
   */
  earnChecks?: EarnCheck[];
  /**
   * 月報時有一筆買進（補滿 F27、提高到 125% F23…）的條件成立，但買進前的程式檢查（buyAllowed，allocation_redesign §4.0）沒過、這次不提：
   * 哪一天、哪一種買進、原因。持股頁寫一行（`補滿的條件過關了，但 11/06 有前提被判不成立，這次不提補滿`），不發通知；之後的月報再看一次。
   */
  buyBlocked?: { date: string; what: string; text: string; line?: string } | null;
  /**
   * 你定的加碼條件成立（F28，allocation_redesign §4.2，T84）：等下一份月報列成一項（預設照做）。月報產生時清掉（列了、或買進前的程式檢查沒過）。
   * 一條條件只成立一次，沒過檢查的不留到下個月。
   */
  addMonthly?: AddNotice[];
  /**
   * 這一段審查後持有從哪一天開始（第一次比高點低 20% 的觸發日；allocation_redesign §4.4，T84）：下跌加碼的「一次下跌」以它為準。
   * 進審查後持有時寫，回到標準（leaveWatch）時拿掉。舊資料沒有 = 用那一筆跌幅審查的觸發日。
   */
  watchSince?: string | null;
  /**
   * 下跌加碼（§4.4，T84）：這一次下跌（episode = watchSince）已經在第幾級的跌幅審查通知上提過（offered），選了的話 at 是照做的那天。
   * 同一次下跌更深的幾級不再提，不論上次有沒有選。之後的下跌 episode 不同，可以再提（仍受 125% 的 12 個月間隔限制）。
   */
  dipAdd?: { episode: string; level: number; offered: string; at?: string | null } | null;
  /**
   * 「不同意」之後的靜默期（own_thesis §1.10）：乙類選「不同意，不動」、月報裡沒動它（SKIPPED）、修正論點但保留那條前提時寫入。
   * until 先寫 since 加 100 天；滿 45 天之後出現第一份財報類申報時改成那份申報的前一天。過期的留著給網站顯示。
   * ended（T42）：提早結束的那一天與原因（沿用編號但字改了的前提：「前提的字改了」）；until 同時改成那天的前一天。舊資料沒有這個欄位。
   */
  disputes?: { premiseId: string; since: string; until: string; reason: string; notif: number | null; ended?: { date: string; reason: string } }[];
  /**
   * 「要看的事」上次列進月報的訊號日（own_thesis §3.6.6）：鍵是那一件事的鍵（`NO_THESIS`、`COND_NEAR:<列編號>@<季末日>`…），
   * 由 `app/thesis.ts` 的 dueAttention 決定多久再列。沒有這個欄位（舊資料）= 都還沒列過。
   */
  attnShown?: Record<string, string>;
  /** 前提有增減的訊號日（編輯論點時記；own_thesis §3.6.5）：下一次每日第一次流程開一次論點變動後的審查，開了或略過就清掉。 */
  thesisReviewDue?: string | null;
  /** 最近一次論點變動後的審查（觸發原因 THESIS）的訊號日；每檔 30 個日曆天最多 1 次。 */
  thesisReviewAt?: string | null;
  /**
   * 月底檢查點（own_thesis §3.7）沒有新證據、這個月沒審：month = 那次檢查點的年月，since = 沿用的那次審查的決策日。
   * 這一檔再開審查時清掉。沒有這個欄位（舊資料）= 沒有跳過。
   */
  reviewSkip?: { month: string; since: string } | null;
  /**
   * 最近一次提前審查（觸發原因 EARLY，own_thesis §2.4）的訊號日：每檔 30 個日曆天最多 1 次，L1 的事件與 L0 的個股自身大跌合併計算。
   * 沒有這個欄位（舊資料）= 還沒提前審查過。
   */
  earlyReviewAt?: string | null;
  /**
   * 這一次慢規則減半的 AI 論點檢查（減半檢視 F7，own_thesis §3.3）：每檔最多一筆。
   * 開減半檢視時寫 PENDING（沒開成或 AI 層沒設定寫 NONE），套用時改成結果；逾時、被退回改成 NONE。
   * 這檔的減半項目被回覆之後、慢規則下一次切換或和尚未下單的那次互相抵銷時清掉。沒有這個欄位（舊資料）= 通知上不顯示 AI 那一行。
   */
  dropReview?: DropReview | null;
  /** 最近一次觸發減半（或跌幅審查）那天距 52 週高點的跌幅（例如 -0.224）：項目的標題用（併入月報的項目要寫觸發那天的數字）。舊資料沒有。 */
  reduceDd?: number | null;
  /**
   * 審查後持有（slow.state 是 WATCH，allocation_redesign §3.3）：已經審過 DROP_LADDER 的第幾級（0 = -20%、1 = -30%…）。
   * 再跌到更深的一級才重新審查；回到標準或減半時清掉。只有預設前提的股票不會有。
   */
  watchLevel?: number;
  /**
   * 部位大小旗標（own_thesis §3.6.3，T35）：自選市值占總資產 ≥ 標準比重 2 倍（而且還沒到單檔上限）時設成 true，跌回 1.5 倍以下設回 false。
   * 每個交易日由 `app/concentration.ts` 的 updateSizeFlags 更新；只用來列「要看的事」與討論包的那一句，規則不看它。沒有這個欄位 = false。
   */
  sizeFlag?: boolean;
  /** 設旗時的訊號日，與最近一次更新的占比、倍數（比例是小數）；旗收回時是 null。 */
  sizeInfo?: { at: string; weight: number; ratio: number } | null;
  /**
   * 買進時的一句話（T40，own_thesis §1.8）：快照新增自選、建立帳戶、轉入自選、認養、分類通知寫的那一句。
   * 不是前提：這檔維持「只有預設」直到第一次存論點；討論包當開場，L2 的證據包不放。at：訊號日。沒有這個欄位 = 沒寫。
   */
  buyNote?: { text: string; at: string } | null;
  /**
   * 這檔的網頁證據來源（T52，web_evidence_design §1.3）：同業（有 EDGAR 代號的列進目錄的同業申報、有 Yahoo 代號的看它的 RSS 連結）
   * 與這檔專用的一手網域（一律 PRIMARY）。使用者在編輯論點頁填、存檔才生效；checked 是存檔前試抓的結果（抓不到的仍存，網站寫「目前抓不到」）。
   * 沒有這個欄位或 null = 沒有指定（目錄只有這檔自己的 RSS 連結）。只有系統預設前提的股票不用網頁證據（存了也不用）。
   */
  webSources?: OwnWebSources | null;
  /**
   * 「新眼光」提到的前提以外的風險裡，你已經處理過的（T63，composite_layer_design §3；比照靜默期 G18）：
   * DISMISSED 看過、不採用；ADOPTED 帶進論點存了檔。at 是訊號日：之後 180 個日曆天內，同一件事（字很像的）不再列進「要看的事」。
   * 寫入時把超過 180 天的拿掉。沒有這個欄位（舊資料）= 都還沒處理過。
   */
  riskSeen?: RiskSeen[];
}

/**
 * 先買一半的進度（OwnMeta.build，allocation_redesign §4.1）。
 * since：開檔日（「滿 200 個日曆天」從這天算）；confirmBy：確認的方式（目前只有開檔後第一份財報的審查）。
 * misses：開檔之後已經有幾份財報的審查沒過關（沒有一致結論、資料缺漏、有前提被判不成立）；兩份沒過或滿 200 天 → 「要看的事」。
 * ok：過關的那一次（下一份月報列補滿 F27）；last：最近一次沒過關的原因（持股頁）。過關了、但月報時買進前的程式檢查沒過的原因記在 OwnMeta.buyBlocked（下個月再試）。
 * listed：補滿已經列在哪一則月報（還沒回覆時不重列）。
 */
export interface BuildInfo {
  since: string;
  confirmBy: 'EARNINGS';
  misses: number;
  /** cond（T84）：過關的是你定的加碼條件（FILL，§4.1「兩者先到的算」），不是財報後的審查。 */
  ok?: { date: string; runId?: string; text: string; cond?: boolean } | null;
  last?: { date: string; text: string } | null;

  listed?: number | null;
}

/** 一次財報後審查證實了前提沒有（OwnMeta.earnChecks）。 */
export interface EarnCheck {
  date: string;
  runId?: string;
  confirmed: boolean;
  why: string;
}

/** 處理過的一件「前提以外的風險」（OwnMeta.riskSeen）：那一句、哪一次執行的第幾條、哪天處理、怎麼處理。 */
export interface RiskSeen {
  text: string;
  at: string;
  runId: string;
  k: number;
  outcome: 'DISMISSED' | 'ADOPTED';
}

/** 同業（web_evidence_design §1.3）：edgar 是 EDGAR 的代號（列同業的申報），yahoo 是 Yahoo 的代號（含 `000660.KS` 這類，看 RSS 連結）。 */
export interface WebPeer {
  name: string;
  edgar?: string;
  yahoo?: string;
}

/** 試抓一個來源的結果：key 是 `domain:<網域>`、`edgar:<代號>`、`yahoo:<代號>`；ok = null 是沒有試（示範模式、沒有設定 EDGAR）。 */
export interface WebSourceCheck {
  key: string;
  ok: boolean | null;
  why: string;
}

export interface OwnWebSources {
  peers: WebPeer[];
  domains: string[];
  checked?: { at: string; items: WebSourceCheck[] } | null;
}

/**
 * 減半檢視／跌幅審查的結果。
 *   只有預設前提的股票（own_thesis §3.3，照舊）：PENDING 還沒有結果／EXIT 建議出清／AGREE 同意減半／NONE 沒有可用的結論。
 *   有論點的股票（跌幅審查，allocation_redesign §3.2 的四種）：BROKEN 前提不成立（3 票判同一條、都有合格引用）／
 *     CLEAR 前提都沒有被判不成立／SPLIT 票數不一致／NONE 沒跑完；PENDING 還沒有結果。
 *   HOLD（建議不動）是 2026-11-22 之前有論點的股票的結果，現在不再產生；舊通知上的照樣看得到。
 */
export type DropStatus = 'PENDING' | 'HOLD' | 'EXIT' | 'AGREE' | 'NONE' | 'BROKEN' | 'CLEAR' | 'SPLIT';

/** 跌幅審查連續幾個交易日沒跑完就不再重派（allocation_redesign §3.2）。 */
export const DROP_RETRY_DAYS = 3;
/** 同一個交易日最多派幾次（07:30 一次、09:30 重派一次）。 */
export const DROP_TRIES_PER_DAY = 2;

export interface DropReview {
  /** 觸發減半的訊號日。 */
  session: string;
  runId: string | null;
  status: DropStatus;
  /** 和結論同檔位的第一張合格票的 cause_class（MARKET、SECTOR、FUNDAMENTAL…）。 */
  cause: string | null;
  /** EXIT 時：不成立的那條前提。 */
  premiseId: string | null;
  /** 這個結果有沒有跟著通知推過 LINE（§3.5）。 */
  told: boolean;
  /**
   * 有論點的股票的跌幅審查（allocation_redesign §3.2；種類以觸發當天的為準）。有這個欄位的結果照新的效力表：
   * 只有 BROKEN 會讓它賣，其餘都是不動。這一筆留到這檔離開審查後持有（回到標準、減半、移出）或再跌一級重新審查為止，持股頁的說明用。
   */
  thesis?: boolean;
  /** 這次審的是 DROP_LADDER 的第幾級。 */
  level?: number;
  /** BROKEN：3 票都選出清（通知多一個「照 AI：出清」）。 */
  exit?: boolean;
  /** SPLIT：最多票判不成立的那條前提與票數（沒有任何一票判不成立、只是檔位不一致時沒有）。 */
  splitPremise?: string | null;
  splitVotes?: number;
  /** 程式算的跌幅拆解（從 52 週高點那天到今天；只顯示，不影響結論）。 */
  attr?: { stock: number; market: number; sector: number | null; idio: number } | null;
  /** 沒跑完的重派（§3.2）：已經派過幾個交易日、最近一次是哪個交易日、那一天派了幾次。 */
  days?: number;
  lastTry?: string;
  sameDay?: number;
  /** 沒跑完、而且不會再重派了（3 個交易日都沒跑完，或 AI 層沒有設定）。 */
  failed?: boolean;
  /**
   * 下跌加碼的審查面（allocation_redesign §4.4，T84；只有 CLEAR 才有）：3 票對每一條可驗證的前提都判成立、引用有申報或財報，
   * 而且程式核對跌幅拆解（個股自身不超過整段一半）。ok = false 時 why 是哪一項沒過（持股頁寫）。
   */
  dip?: { ok: boolean; why: string } | null;
  /**
   * 通知上下跌加碼的選項最後一次算出來的樣子（setThesisDrop 寫；持股頁寫「這次下跌沒有提加碼」的原因用）。
   * ok：有給這個選項（mode RAISE 提高到 125%／FILL 先買一半時補滿，shares 股）；不給時 why 是原因。
   */
  dipOffer?: { ok: boolean; why: string; mode?: 'RAISE' | 'FILL'; shares?: number } | null;
}

/** 這一筆跌幅審查還會有結果嗎：還在跑，或沒跑完但還會重派。預設不下單的通知在這期間不自動結案。 */
export const dropReviewOpen = (dr: DropReview | null | undefined): boolean => !!dr && (dr.status === 'PENDING' || (dr.status === 'NONE' && !!dr.thesis && !dr.failed));

/**
 * 「要看的事」的一件（own_thesis §3.6.6；動能的見 momentum_ai §3.6）：不用下單、但值得知道的事。
 * 不是通知：不提醒、不用回覆。src：哪一段（自選股／動能持股），沒有 = 自選股。
 */
export interface Attention {
  ticker: string;
  kind: string;
  text: string;
  /** 從哪一天起成立（訊號日）。 */
  since: string;
  /** own 自選、mom 動能、watch 候補（allocation_redesign §4.5 第 24 點：一年沒進場、草稿好了）。 */
  src?: 'own' | 'mom' | 'watch';
  /** 點這一件要去哪一檔的持股頁（沒有 = ticker）。集中度那一件掛在字母排第一的自選股上（頻率用），但文字以占比最大的開頭，連到占比最大的那檔（T34）。 */
  link?: string;
  /** 已經自動請 stock bot 草擬（T72，confirm_audit_design §5）：開的時間。有的話網站不放「請 stock bot 草擬」的連結。 */
  drafted?: string;
}

export interface Lots {
  own: Record<string, number>;
  mom: Record<string, number>;
  core: Record<string, number>;
  /** 快照出現、還沒分類的變動（設計 §2.1.1：標記之前月報不下單）。 */
  unc: Record<string, number>;
}

/** 定期審查的觸發原因（own_thesis §1.9、§3.6.5；EARLY 是 T29b 的提前審查、DROP 是減半檢視）。 */
export type ReviewTrigger = 'MONTHLY' | 'EARNINGS' | 'EARLY' | 'CONDITION' | 'DROP' | 'THESIS' | 'MANUAL';

/**
 * 甲類通知（own_thesis §1.10）：你定的條件成立。項目由引擎照當時的持股換算股數。
 * setAt：誰哪天定的（勾選日；舊資料用建立日）；aiProposed：AI 建議、你勾選的；why：理由（依 met_basis）。
 */
export interface CondNotice {
  /** own_conditions 的列編號。 */
  id: number;
  text: string;
  action: 'EXIT' | 'HALF';
  setAt: string;
  aiProposed: boolean;
  why: string;
  premiseId?: string | null;
  runIds?: string[];
}

/**
 * 你定的加碼條件成立（F28，allocation_redesign §4.2，T84）：項目由引擎在月報時照當時的持股換算股數。
 * action：FILL 補到標準比重／RAISE 提高到標準的 125%；setAt：你定的那一天；why：怎麼確認成立的。
 */
export interface AddNotice {
  /** own_conditions 的列編號。 */
  id: number;
  text: string;
  action: 'FILL' | 'RAISE';
  setAt: string;
  why: string;
  /** 成立的訊號日。 */
  metOn: string;
  premiseId?: string | null;
  runIds?: string[];
}

/**
 * OWN_COND：甲類（你定的條件成立）的項目（own_thesis §1.10）。
 * CORE_BAND：核心比例調回（F26，allocation_redesign §1.3）：預設照做、「這次不做」不用理由也不記欠單，下個月月報重算。
 * OWN_FILL：先買一半的補滿（F27，allocation_redesign §4.1）：只進月報、預設照做、不做不用理由；照做或不做都離開先買一半。
 * OWN_ADD：你定的加碼條件成立（F28，§4.2）：只進月報、預設照做、不做不用理由（不買沒有風險要記）。
 * WATCH_ENTRY：候補進場（F29，§4.5）：你定的進場條件成立 → 先買一半，只進月報、預設照做、不做不用理由；這一行是 bucket own，但 rule.own 還沒有這檔（快照的自選桶有股數才轉成持股）。
 */
export type ItemKind = 'STRATEGY' | 'OWN_RULE' | 'AI_ONLY' | 'HARD' | 'CASHFLOW' | 'FIX' | 'OWN_COND' | 'CORE_BAND' | 'OWN_FILL' | 'OWN_ADD' | 'WATCH_ENTRY';
export type ChoiceId = 'RULE' | 'AI' | 'DO' | 'SKIP';

/** 清單上的選項做完之後，帳戶狀態要跟著改的事（存成資料，不存函式）。 */
export type Effect =
  | { type: 'APPLY_TIER'; ticker: string; tier: Tier }
  | { type: 'REMOVE_OWN'; ticker: string }
  | { type: 'CLEAR_FLAG'; ticker: string }
  /** 動能持股照 AI 的硬事件建議出場：這一檔拿出動能名單，下個月照排名遞補（momentum_ai §3.5）。 */
  | { type: 'MOM_DROP'; ticker: string }
  /**
   * 離開先買一半（allocation_redesign §4.1）：補滿照做（keep = false，目標回到標準比重）或不做（keep = true，標準比重改成那時的實際比重，之後不再提）。
   * 只掛在補滿（F27）的選項上；「這次不做」的選項也有這個效果（整則不做時在回覆當下套用）。
   */
  | { type: 'BUILD_END'; ticker: string; keep: boolean }
  /** 下跌加碼照做了（allocation_redesign §4.4，T84）：OwnMeta.dipAdd.at 記那一天（提高到 125% 的 raisedAt 由同一個選項上的 APPLY_TIER RAISE 記）。 */
  | { type: 'DIP_ADD'; ticker: string; episode: string }
  /**
   * 候補進場（F29，allocation_redesign §4.5 第 17 點）：**快照的自選桶這一檔有股數才套用**——候補轉成持股（promoteWatch）。沒買的還是候補。
   * std：列這一項時用的標準比重（你填的，或那時的推薦值）；half：只有預設前提、進場時已經比高點低 20% 以上 → 從減半開始（其餘是先買一半）；
   * conds：列在這一項上的進場條件。
   */
  | { type: 'WATCH_ENTER'; ticker: string; std: number; half?: boolean; conds?: number[] };

export interface Choice {
  id: ChoiceId;
  label: string;
  lines: OrderLine[];
  tier?: Tier;
  effects?: Effect[];
}

export interface Item {
  key: string;
  /** 觸發功能編號（設計 §2.0），例如 F7。 */
  f: string;
  kind: ItemKind;
  ticker?: string;
  title: string;
  choices: Choice[];
  /** 目前選的選項。 */
  choice: ChoiceId;
  /** 規則的選項（影子組合的「照規則」那條線）。規則沒有動作時是 SKIP。 */
  ruleChoice: ChoiceId;
  /** 給 LINE 顯示的一行 AI 說明。 */
  aiLine?: string;
  /** 這一項可以做的額外動作。 */
  actions?: ('TRANSFER' | 'EXCLUDE' | 'ADOPT')[];
  cancelled?: boolean;
  note?: string;
  why?: string;
  /** 這一項的 AI 建議或說明來自哪幾次 AI 執行（ai_runs.run_id，T13 起；之前的通知沒有這個欄位）。 */
  runIds?: string[];
  /** F5／F6：上次選了「這次不做」、這份月報重列的那一項（core_ai §3.6，由 T33c 產生；重列的不開檢視）。2026-11-22 起不再產生，舊通知的顯示用。 */
  relist?: boolean;
  /**
   * F5／F6：崩盤規則檢視的狀態（core_ai §3.2、§3.3；T33b 起）。網站那一列、LINE 那一行（aiLine 只在 OPINION 時寫）、影子紀錄的 ai 都看它。
   * 沒有 = 舊通知或重列的那一項（重列的不開檢視）。2026-11-22 起不再產生、也不再更新（allocation_redesign §1.6）；舊通知的顯示與影子紀錄用。
   */
  crashReview?: CrashReviewInfo;
  /**
   * 失效通知（own_thesis §1.10）：A = 你定的條件成立（conditionId 是 own_conditions 的列編號）；B = AI 判斷前提不成立、沒有對應的條件。
   * 寫 own_thesis_log 的 BREAK_NOTICE、網站的「拿去討論」用。
   * withRule：附在慢規則減半項目上的「AI 建議出清」（§3.4）。不是獨立的乙類通知：不能用「修正論點」結案；沒有照 AI 出清 → 那條前提進靜默期。
   */
  brk?: { type: 'A'; conditionId: number; premiseId: string | null } | { type: 'B'; premiseId: string; withRule?: boolean };
  /**
   * 慢規則減半項目（F7）上 AI 那一行現在的狀態（own_thesis §3.4）：PENDING 檢查進行中、HOLD 建議不動（有「照 AI：不動」）、
   * EXIT 建議出清（有「照 AI：出清」，同時帶 withRule 的 brk）、AGREE 同意減半、NONE 沒有一致結論。
   * 沒有 = 不顯示（舊通知、沒有跑減半檢視）。LINE 多的那一行、回應的 aiOffered、補推都看它。
   * 有論點的股票（thesisDrop）：BROKEN 前提不成立（預設減半）、CLEAR／SPLIT／NONE／PENDING 都是預設不動（allocation_redesign §3.2）。
   */
  drop?: DropStatus;
  /**
   * 有論點的股票的跌幅審查項目（allocation_redesign §3.2；種類以觸發當天的為準）：比高點低 20% 以上只觸發審查。
   * 選項是「不動」與「減半」，預設不動；審查判前提不成立（drop 是 BROKEN）時預設才是減半、「這次不做」要寫理由。
   * 規則的狀態在你照做減半之後才變成減半（選項的效果），其餘留在審查後持有。level：這次審的是 DROP_LADDER 的第幾級。
   */
  thesisDrop?: { level: number };
  /**
   * 下跌加碼（allocation_redesign §4.4，T84）：跌幅審查的結果是前提都沒有被判不成立、而且過了下跌加碼的限制 → 通知多一個選項（id AI，預設仍是不動）。
   * mode：RAISE 提高到標準的 125%（標準、審查後持有）／FILL 補滿到標準比重（先買一半）；note 是選項說明固定的那一句。
   */
  dipAdd?: { mode: 'RAISE' | 'FILL'; shares: number; note: string };
  /**
   * 候補進場（F29，allocation_redesign §4.5）：這一項用的數字——std 標準比重（recUsed：你留空、用的是列的當下的推薦值）、
   * conds 列在這一項上的進場條件（列編號；price = 你填的價格條件，月報存檔時標成立）、fromHigh 訊號日比 52 週高點低多少（負數）、
   * half 進場後從減半開始（只有預設前提、已經比高點低 20% 以上）、
   * wouldBuy：論點草稿「今天沒持股的話會不會買」那一題的答案與草稿日期（只是資訊；T85 丙段接上，沒有草稿是 null）。
   */
  watchEntry?: { std: number; recUsed: boolean; conds: { id: number; price: boolean }[]; fromHigh: number | null; half: boolean; wouldBuy: { answer: string; date: string } | null };
  /**
   * 併進這個減半項目的乙類通知（own_thesis §3.4：慢規則通知產生時同一檔有還沒回覆的乙類 → 那一則標 SUPERSEDED，內容併進來）。
   * 之後重算「照 AI」時（refreshOwnAiChoice）沿用。
   */
  absorbed?: { notif: number; tier: 'EXIT' | 'HALF'; premiseId: string; date: string; runIds?: string[] };
  /** 選「這次不做」（SKIP）時要寫一句理由（1～200 字），沒寫不能送出。 */
  reasonRequired?: boolean;
  /** 回覆時寫的理由（選了不做的那一句）。 */
  reason?: string;
  /**
   * 乙類用「修正論點」結案的訊號日（own_thesis §1.10 的 REVISE：在編輯論點頁勾「這是對通知 #N 的回應」）。
   * 這一項同時標 cancelled（部位不動、不用下單、回覆時不再算它）。
   */
  revised?: string;
  /**
   * F1 進場項目：進場審查在月報之後才回來、三票否決（momentum_ai §3.3「月報之後才回來的否決」）。
   * 預設仍是照規則買進；按「排除」時理由欄先填「AI 否決：<代碼的中文>」。
   * push：還沒補推的那一則 LINE（補推之後拿掉）；沒有 = 不用推（已經填快照，或推過了）。
   */
  lateVeto?: { code: string; runId: string; date: string; push?: string };
  /**
   * 策略項目（動能、回調、上限、併進月報的入金）每一行的目標占總資產的比例（訊號日；cellKey → 比例，T39b 起）。
   * 晚回覆（提醒過才回）時照 §2.3.1「忘了」用回覆當天的總資產與價格重算股數，和自選慢規則項目同一套（ops.ts 的 recomputeLate）。
   * 沒有 = 舊通知或沒有目標的行（核心吸收的現金、崩盤項目核心那兩檔另外重算）。
   */
  targetW?: Record<string, number>;
}

export type NotifKind = 'MONTHLY' | 'MONTHLY_EMPTY' | 'URGENT' | 'CASHFLOW' | 'FIX' | 'INFO' | 'CLASSIFY' | 'CASH_DIFF';
/** AUTO_DEFAULT：預設不下單的通知（跌幅審查的結果是不動）2 個交易日沒有回覆，自動照預設結案（allocation_redesign §3.2；不提醒）。 */
export type NotifStatus = 'PENDING' | 'RESPONDED' | 'DONE' | 'SKIPPED' | 'READ' | 'SUPERSEDED' | 'CANCELLED' | 'AUTO_DEFAULT';

export interface FollowUp {
  ticker: string;
  listed: number;
  done: number;
}

export interface Notif {
  id: number;
  kind: NotifKind;
  /** 訊號日（清單用這一天的收盤換算股數）。 */
  date: string;
  /** 訊號日的交易日序號。 */
  seq: number;
  title: string;
  text?: string;
  items: Item[];
  status: NotifStatus;
  /** 是否由核心吸收差額。 */
  coreAbsorb: boolean;
  /** 出金：做完清單後要轉出的金額。 */
  withdraw?: number;
  deposit?: number;
  reminded: boolean;
  /** 產生時照預設選項合成的清單。 */
  preview?: Composed;
  /** 回覆時合成的清單（之後和快照比對）。 */
  composed?: Composed;
  respondedAt?: string;
  /** 回覆那天的交易日序號（決定了還沒填快照的提醒用）。 */
  respondedSeq?: number;
  /** 決定了還沒填快照，已經提醒過。 */
  fillReminded?: boolean;
  /** 改比例：改之前的比例與每檔自選的標準比重（取消時改回去）。 */
  ratioBefore?: { ratio: { own: number; strat: number; core: number }; std: Record<string, number>; ownZero?: OwnZero | null };
  followUp?: FollowUp[];
  followUpOpen?: boolean;
  /** CLASSIFY：哪一檔、變動幾股。CASH_DIFF：金額。 */
  ticker?: string;
  quantity?: number;
  amount?: number;
  /** 月報：重算用的輸入與月報前的狀態（排除、入金合併時重算）。 */
  monthly?: { input: MonthlyContext; before: SavedState };
  ref?: number;
  note?: string;
  /** CLASSIFY：填快照時寫的「這次自己交易的原因」，分類時預先帶進理由欄。 */
  userNote?: string;
  /** 這則通知用到的所有 AI 執行（各項目的 runIds，加上不屬於任何項目的：F1 否決；T13 起）。 */
  runIds?: string[];
  /** 月報：這個月該列的「要看的事」（own_thesis §3.6.6）；沒有就不留這個欄位。 */
  attention?: Attention[];
}

/** 月報需要、引擎自己算不出來的輸入。 */
export interface MonthlyContext {
  /** 股票池照動能排名由高到低的代號。 */
  order: string[];
  /** 本月被任務 A 否決的代號。 */
  vetoed?: string[];
  /** 遞補者也被否決、留在核心到下個月的格數（設計 §2.4）。 */
  emptySlots?: number;
  /** 月份標籤，例如 2026-12。 */
  month: string;
  /** 同一家公司的不同類股：代號 → 公司（CIK）。同公司已經有一類在名單裡時，另一類不進場（設計 §2.4）。 */
  company?: Record<string, string>;
  /** 本月暫停換股的原因（成分股名單不一致、排名沒有產生）；order 這時是目前的動能名單，名單不變。 */
  paused?: string;
  /** 每個 F1 進場項目的說明（momentum_ai §3.3 的 entryNote）：代號 → 說明，月報寫進那一項的 note。T32b 起取代 watch。 */
  entryNotes?: Record<string, string>;
  /** 舊月報（T32b 之前）：准許但觀察的代號 → 觀察理由。沒有 entryNotes 時才讀。 */
  watch?: Record<string, string>;
  /** 本月的否決是沿用之前的審查（momentum_ai §3.4）：代號 → 沿用的月份。 */
  vetoCarried?: Record<string, string>;
  /** 這份月報用到的 AI 執行（ai_runs.run_id，T13）：F1 每檔的審查。（F20 說明附在月報的 notes T32d 拿掉，momentum_ai §3.6；舊月報的崩盤規則檢視 crash 2026-11-22 起不再寫，T88 拿掉型別；這幾個欄位不再讀。） */
  runIds?: { entry?: Record<string, string> };
  /**
   * 訊號日的超額波動（依波動度減碼用；momentum_ai §3.11）。第一次產生月報時算好寫進來；之後的重算（暫停後、入金合併、排除）用它。
   * null = 算不出來；沒有這個欄位（舊月報）= 當場算。
   */
  excessVol?: number | null;
  /**
   * 訊號日崩盤規則的判斷（core_ai §3.7）：第一次產生月報時用當時的 view 算好寫進來；之後的重算用 below，不重算。
   * ma 是 null = 均線算不出來（不滿 200 根有效收盤，§3.10），below 維持原狀態；bars 是那時有幾根有效收盤。
   * 沒有這個欄位（舊月報）= 當場算。
   * 2026-11-22 起不再寫（allocation_redesign §1.3）；舊月報的留著給網站顯示。
   */
  crash?: { below: boolean; date: string; close: number | null; ma: number | null; bars?: number };
  /**
   * 核心比例（allocation_redesign §1.3；顯示用）：這份月報其他單照預設做完之後、調回之前，短債那一邊占核心的比例 s、
   * 目標 bond、核心的市值 core。每次產生或重算月報時照當時的持股重算，不凍結。舊月報沒有這個欄位。
   */
  coreBand?: { s: number; bond: number; core: number };
  /**
   * 這個月該列的「要看的事」（own_thesis §3.6.6、momentum_ai §3.6）：每日流程在產生月報前算好（頻率已經過濾）。
   * 月報照抄到通知的 attention；重算（暫停後、入金合併、排除）沿用這一份。
   */
  attention?: Attention[];
  /**
   * 訊號日核心 ETF 資料檢查的結果（core_ai §3.10）：代碼（DAY_GAP、BOND_JUMP、NO_BENCH；0.17.0 以前的月報還可能有 MA_SHORT、MA_GAP）。每日流程在產生月報前算好；重算沿用。
   * 有 DAY_GAP、而且這份月報有核心比例調回 F26（舊的是崩盤規則切換 F5/F6）→ 項目的 note 寫 coreNote，LINE 加一行「注意：…」（T86 P14）。
   */
  coreCheck?: string[];
  /** 那一句 note（帶數字，每日流程寫好；引擎只照抄）。沒有 DAY_GAP、MA_GAP 時沒有。 */
  coreNote?: string;
  /**
   * 這份月報可以列的候補進場（F29，allocation_redesign §4.5 第 13 點）：每日流程在產生月報前算好（prepareWatchEntries：訊號日收盤仍成立的價格條件、
   * 成立後等月報的非價格條件、硬傷、財報類出場條件）。月報暫停後重算、入金合併、排除重算沿用同一份。沒有這個欄位 = 這個月沒有候補進場可列。
   */
  watchEntries?: WatchEntryInput[];
}

/**
 * 一檔候補這個月的進場輸入（MonthlyContext.watchEntries）。conds：成立的進場條件，第一條是列在標題上的（價格條件在前）；
 * hard：規則偵測到的硬傷（申報來的被收購方、延遲申報、財報重編、會計師辭任）→ 不提；noFilings：申報清單抓不到 → 這個月不提；
 * exitMet：這檔你定的財報類出場條件現在已經成立 → 不提；wouldBuy：草稿「今天會不會買」（T85 丙段寫）。
 */
export interface WatchEntryInput {
  ticker: string;
  conds: { id: number; text: string; setAt: string; why: string; price: boolean }[];
  hard?: string | null;
  noFilings?: string | null;
  exitMet?: string | null;
  wouldBuy?: { answer: string; date: string } | null;
}

export interface SavedState {
  rule: RuleState;
  own: Record<string, OwnMeta>;
  owe: Account['mom']['owe'];
  cash: number;
  /**
   * 候補裡月報會改的三個欄位（allocation_redesign §4.5；T85 乙段）：重算月報時還原，F29 才會照同一份輸入再列一次。
   * 只還原還在候補名單裡的；期間加的、移除的、改的比重與論點不動。舊月報沒有這個欄位。
   */
  watch?: Record<string, Pick<WatchMeta, 'lastListed' | 'entry' | 'blocked'>>;
}

/**
 * 崩盤規則檢視在某個月份＋方向的狀態（core_ai §3.2）：
 *   OPINION 有一筆跑完、三票一致（照做或延後）；NO_OPINION 跑完、沒有意見（票數不一致、三票證據不足）；
 *   PENDING 有一筆還在等；FAILED 只有沒有結論的執行（1～3 筆）；NO_DATA 總經資料不足沒開（§3.5）；OFF AI 層沒設定或沒有任何執行。
 * told：LINE 已經帶過這個意見（月報推出去時有那一行，或補推過）；late：使用者回覆之後才回來。
 */
export interface CrashReviewInfo {
  state: 'OPINION' | 'NO_OPINION' | 'PENDING' | 'FAILED' | 'NO_DATA' | 'OFF';
  opinion?: '照做' | '延後';
  /** 「3 票一致」「照做 2、延後 1」「3 票都是證據不足」。 */
  votes?: string;
  /** 最近一筆執行（任何狀態；OPINION／NO_OPINION 是跑完的那一筆）。 */
  runId?: string;
  kind?: 'PREVIEW' | 'MAKEUP';
  /** 檢視依哪一天的收盤。 */
  basis?: string;
  /** FAILED：每次沒有結論的原因（逾時、被退回…）。 */
  fails?: string[];
  late?: boolean;
  told?: boolean;
}

export interface ShadowRecord {
  date: string;
  f: string;
  ticker: string | null;
  title: string;
  /** 照規則、照 AI、使用者實際的股數變動。 */
  rule: number;
  ai: number | null;
  actual: number;
  price: number;
  choice: string;
  note?: string;
  /** 哪一則通知的回覆產生的（改決定時用來作廢）。 */
  notif?: number;
  /** 這一項的 AI 建議來自哪幾次 AI 執行（ai_runs.run_id，T13 起；之前的紀錄沒有這個欄位）。 */
  runIds?: string[];
}

/** SPLIT：拆股或合股（T39c，design_v2 §10 第 48 點）：shares 是這一桶多出來（合股是少掉）的股數，reason 寫比例與前後股數。 */
export type LedgerEventKind = 'TRADE' | 'TRANSFER' | 'DEPOSIT' | 'WITHDRAW' | 'DIVIDEND' | 'CASH_OTHER' | 'UNCLASSIFIED' | 'CLASSIFIED' | 'SPLIT';
export interface LedgerEvent {
  date: string;
  kind: LedgerEventKind;
  ticker?: string;
  bucket?: string;
  shares?: number;
  amount?: number;
  reason?: string;
  notif?: number;
}

export interface Account {
  cfg: EngineConfig;
  /** 短期美債 ETF（核心裡不放股票的那一邊，allocation_redesign §1.1）。 */
  bondTicker: string;
  /** 紙上交易（流程全跑，帳本標記為紙上）。 */
  paper: boolean;
  /** 已經記成出金、但券商的現金還沒扣掉（錢還沒轉出）的金額；填快照時從券商現金扣掉再對帳（設計 §10 第 40 點）。 */
  pendingWithdraw?: number;
  cash: number;
  lots: Lots;
  rule: RuleState;
  own: Record<string, OwnMeta>;
  mom: {
    excluded: Record<string, { reason: string; date: string }>;
    adopted: Record<string, { reason: string; date: string }>;
    /** 策略單沒照做，下個月要再列（設計 §2.3.1）。 */
    owe: Record<string, { since: string; notif: number }>;
    /**
     * 硬事件法庭（F19）對動能持股建議出場、已經通知過的：代號 → 代碼 → 訊號日（momentum_ai §3.5）。
     * 同一檔同一類 180 天（被收購 365 天）內不再通知；那一檔動能部位賣光時清掉（addLot）。沒有這個欄位的舊帳戶當成空的。
     */
    hardTold?: Record<string, Record<string, string>>;
    /**
     * 動能的「要看的事」上次列進月報的訊號日（momentum_ai §3.6）：代號 → 那一件事的鍵（`DROP_21D`、`LATE_VETO@<月份>`）→ 訊號日。
     * 由 `app/momNotes.ts` 用和自選股相同的 dueAttention 決定多久再列。沒有這個欄位的舊帳戶當成空的。
     */
    attnShown?: Record<string, Record<string, string>>;
  };
  /**
   * 這個帳戶是從崩盤規則換到固定比例的（migrateAccount 讀到舊的規則狀態時設成 true）：
   * 之後第一次照做之前的核心比例調回（F26）多一句「一次性調整」的備註（allocation_redesign §1.5）。
   */
  fromCrashRule?: boolean;
  notifs: Notif[];
  nextId: number;
  shadow: ShadowRecord[];
  events: LedgerEvent[];
  /** 單位數：每一桶像一檔基金，入金買單位、出金贖單位（設計 §2.1.1）。 */
  units: { total: number; own: number; mom: number; core: number };
  /** 有未分類的變動，月報暫停中。 */
  monthlyBlocked: boolean;
  /** 上一份快照的日期。 */
  snapshotDate: string | null;
  /**
   * 每檔最近一次結案的論點檔（own_thesis §1.2）：存檔時寫 log 的 `CLOSE` 用它的原因；
   * 同一天結案又重新加入時，用它避免論點檔編號重複。
   * last：結案那一刻的論點本文與自己的前提（T44：再買回時持股頁、討論包、編輯論點頁看得到上一份）；T44 之前結案的沒有這個欄位。
   */
  ownClosed?: Record<string, ClosedFile>;
  /**
   * 候補名單（allocation_redesign §4.5，T85）：還沒持有、想在條件到的時候買的股票，最多 MAX_WATCH 檔。
   * 不是「0 股的自選」：不進價格必要清單、每日掃描、硬事件法庭、慢規則與推薦比重的分母（§4.5 第 1 點）。沒有這個欄位 = 沒有候補。
   */
  watch?: Record<string, WatchMeta>;
  /** 自選的比例改成 0% 時記下的每檔標準比重（T39b，design_v2 §10 第 47 點）；從 0% 改回時用它。沒有這個欄位 = 沒有記錄。 */
  ownZero?: OwnZero;
  /**
   * 最後一次對照券商（快照、建立帳戶）送出那一刻的美東日期（T39c，design_v2 §10 第 48 點）：券商那時顯示的股數已經包含
   * 生效日在這一天以前的拆股，之後才記到的這種拆股不再套用。沒有這個欄位（舊帳戶）= 用 snapshotDate。
   */
  splitAsOf?: string;
  /** 套用過的拆股：`<代號>@<生效日>` → 生效日（engine/split.ts 的 applySplits）。沒有這個欄位 = 都還沒套用過。 */
  splits?: Record<string, string>;
  /**
   * 還沒有論點的新自選（T40，own_thesis §1.8「存完之後的引導」）：快照新加進自選、建立帳戶時寫入代號；
   * 帳戶頁的入口列出其中還在自選、還是「只有預設」的，直到每一檔都有論點或使用者關掉（設成空陣列）。沒有這個欄位 = 沒有。
   */
  thesisTodo?: string[];
}

/**
 * 自選比例改成 0% 之前的樣子：from 是那時的自選比例、std 是每檔的標準比重、date 是改的那一天。
 * 從 0% 改回 r 時，每檔的標準比重 = std × r ÷ from（照新舊比例縮放，原型假設 7）；沒有記錄的那一檔用新增自選時的推薦比重。
 */
export interface OwnZero {
  from: number;
  std: Record<string, number>;
  date: string;
}

// ---------------------------------------------------------------- 候補名單（allocation_redesign §4.5，T85）

/** 候補最多幾檔【D7】。 */
export const MAX_WATCH = 5;

/**
 * 一檔候補（Account.watch）。論點檔的欄位和 OwnMeta 同名（一鍵採用、編輯論點、討論包照用；§4.5 第 2 點）：
 *   fileId、premises、thesis、premiseSeq、webSources、buyNote（加入時寫的「為什麼想買」，不是前提）、attnShown。
 * 候補自己的：
 *   addedAt：加入候補的訊號日；stdWeight：打算放的標準比重（null = 留空，列進場項目時用推薦值）；
 *   lastListed：進場項目（F29）上次列在哪一份月報的訊號日（每 90 天最多一次，T85 乙段）；
 *   entry：成立、等月報的非價格進場條件（乙段）；blocked：進場條件成立但這次不提的原因（乙段，頁面寫）。
 * 沒有慢規則狀態、審查、硬事件標記：候補不跑那些。
 */
export interface WatchMeta {
  fileId: string;
  premises: Premise[];
  thesis?: Thesis | null;
  premiseSeq?: number;
  webSources?: OwnWebSources | null;
  buyNote?: { text: string; at: string } | null;
  attnShown?: Record<string, string>;
  addedAt: string;
  stdWeight: number | null;
  lastListed: string | null;
  entry?: WatchEntry[];
  blocked?: { date: string; text: string } | null;
}

/** 成立、等下一份月報的進場條件（WatchMeta.entry，§4.5 第 16 點；T85 乙段寫）。id：own_conditions 的列編號；metOn：成立的訊號日。 */
export interface WatchEntry {
  id: number;
  text: string;
  setAt: string;
  why: string;
  metOn: string;
  runIds?: string[];
}

/** 論點檔的欄位（自選與候補共用的那一部分）。 */
export type ThesisMeta = OwnMeta | WatchMeta;

/**
 * 這檔現在的論點檔在哪裡（§4.5 第 3 點）：先找自選、再找候補。held：是自選（不論現在幾股）；false = 候補。
 * 論點檔的讀寫（論點、前提、條件、草稿、討論包、網頁證據、開檔結案的比對）走這裡；慢規則、審查、配置這些只對持股有意義的照舊讀 acct.own。
 */
export type FileMeta = { meta: OwnMeta; held: true } | { meta: WatchMeta; held: false };
export function fileMeta(acct: Pick<Account, 'own'> & Partial<Pick<Account, 'watch'>>, ticker: string): FileMeta | null {
  const own = acct.own?.[ticker];
  if (own) return { meta: own, held: true };
  const w = acct.watch?.[ticker];
  return w ? { meta: w, held: false } : null;
}

/** 候補的代號（沒有是空陣列）。 */
export const watchTickers = (acct: Partial<Pick<Account, 'watch'>> | null | undefined): string[] => Object.keys(acct?.watch ?? {});

/** 這檔自選現在有沒有股數（T39b：0 股時不送定期審查、提前審查與條件監測，持有後再恢復）。 */
export function ownHeld(acct: Pick<Account, 'lots'>, ticker: string): boolean {
  return (acct.lots.own[ticker] ?? 0) > 0;
}

/** 市場資料：到訊號日為止的收盤（所有代號對齊同一組交易日）。i 是訊號日的位置。 */
export interface MarketView {
  date: string;
  i: number;
  close: Record<string, ArrayLike<number>>;
  /** 算超額波動用的基準；預設用核心 ETF。 */
  benchmark?: string;
}

export function priceOf(view: MarketView, ticker: string): number {
  if (ticker === CASH) return 1;
  const c = view.close[ticker];
  if (!c) throw new Error(`沒有 ${ticker} 的價格`);
  const p = c[view.i];
  if (!Number.isFinite(p)) throw new Error(`${ticker} 在 ${view.date} 沒有價格`);
  return p;
}

export function clone<T>(x: T): T {
  return structuredClone(x);
}

/** 每一格的股數（給 planToLines 用）。 */
export function shareCells(acct: Account): Record<string, number> {
  const out: Record<string, number> = {};
  for (const b of ['own', 'mom'] as const) for (const [t, n] of Object.entries(acct.lots[b])) if (n) out[cellKey(b, t)] = n;
  const v = acct.lots.core[acct.cfg.coreTicker];
  if (v) out[cellKey('core', acct.cfg.coreTicker)] = v;
  return out;
}

/** 每一格的市值。核心的現金格 = 短債 ETF ＋ 帳上現金。 */
export function cellValues(acct: Account, view: MarketView): CellMap {
  const out: CellMap = {};
  for (const b of ['own', 'mom'] as const) {
    for (const [t, n] of Object.entries(acct.lots[b])) if (n) out[cellKey(b, t)] = n * priceOf(view, t);
  }
  for (const [t, n] of Object.entries(acct.lots.core)) {
    if (!n) continue;
    const k = t === acct.cfg.coreTicker ? cellKey('core', t) : cellKey('core', CASH);
    out[k] = (out[k] ?? 0) + n * priceOf(view, t);
  }
  if (acct.cash) out[cellKey('core', CASH)] = (out[cellKey('core', CASH)] ?? 0) + acct.cash;
  return out;
}

export function bucketValue(acct: Account, view: MarketView, bucket: 'own' | 'mom' | 'core'): number {
  let v = bucket === 'core' ? acct.cash : 0;
  for (const [t, n] of Object.entries(acct.lots[bucket])) if (n) v += n * priceOf(view, t);
  return v;
}

/** 總資產 = 各桶市值 ＋ 現金（未分類的持股也算）。 */
export function totalValue(acct: Account, view: MarketView): number {
  let v = bucketValue(acct, view, 'own') + bucketValue(acct, view, 'mom') + bucketValue(acct, view, 'core');
  for (const [t, n] of Object.entries(acct.lots.unc)) if (n) v += n * priceOf(view, t);
  return v;
}

/** 帳本上每一檔的總股數（各桶合計）。 */
export function bookShares(acct: Account): Record<string, number> {
  const out: Record<string, number> = {};
  for (const b of ['own', 'mom', 'core', 'unc'] as const) {
    for (const [t, n] of Object.entries(acct.lots[b])) if (n) out[t] = (out[t] ?? 0) + n;
  }
  return out;
}

export function addLot(acct: Account, bucket: keyof Lots, ticker: string, n: number): void {
  const v = (acct.lots[bucket][ticker] ?? 0) + n;
  if (Math.abs(v) < 1e-9) {
    delete acct.lots[bucket][ticker];
    // 動能部位出場：硬事件的 180 天上限跟著清掉（momentum_ai §3.5）
    if (bucket === 'mom' && acct.mom?.hardTold?.[ticker]) delete acct.mom.hardTold[ticker];
  } else acct.lots[bucket][ticker] = v;
}

/** 金額的寫法：$10,000（通知標題用；T39a）。 */
export const usd = (x: number): string => `$${x.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

/** 2026-12-24 → 12/24。 */
export const notifDay = (d: string): string => (d ? `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}` : '');

const NOTIF_KIND_NAME: Partial<Record<Notif['kind'], string>> = { URGENT: '當天通知', FIX: '補做的清單', INFO: '提醒', CLASSIFY: '問題', CASH_DIFF: '問題' };

/**
 * 畫面上指到另一則通知時的名字（T39a：不用內部的通知編號）：日期與種類，再加標題。
 * 月報：「12 月月報」；你的操作：「12/10 的「入金 $10,000 的清單」」；其他：「12/24 的當天通知「MU 慢規則減半」」。
 */
export function notifName(n: Pick<Notif, 'kind' | 'date' | 'title'>): string {
  if (n.kind === 'MONTHLY' || n.kind === 'MONTHLY_EMPTY') {
    const m = /^\d{4}-(\d{2}) 月報/.exec(n.title);
    return `${Number(m ? m[1] : n.date.slice(5, 7))} 月月報`;
  }
  const kind = NOTIF_KIND_NAME[n.kind];
  return `${n.date ? `${notifDay(n.date)} 的` : ''}${kind ?? ''}「${n.title}」`;
}

export function newNotif(acct: Account, view: MarketView, o: Partial<Notif> & Pick<Notif, 'kind' | 'title'>): Notif {
  const n: Notif = { id: acct.nextId++, date: view.date, seq: view.i, items: [], status: 'PENDING', coreAbsorb: true, reminded: false, ...o };
  syncRunIds(n);
  acct.notifs.push(n);
  return n;
}

/** 通知的 runIds = 各項目的 runIds ＋ 原本就掛在通知上的（例如 F1 否決），去重；沒有就不留這個欄位。 */
export function syncRunIds(n: Notif, extra: (string | undefined)[] = []): void {
  const ids = [...new Set([...(n.runIds ?? []), ...n.items.flatMap((i) => i.runIds ?? []), ...extra].filter((x): x is string => !!x))];
  if (ids.length) n.runIds = ids;
  else delete n.runIds;
}

let itemCounter = 0;
export function makeItem(o: Omit<Item, 'key' | 'choice' | 'ruleChoice'> & { choice?: ChoiceId; ruleChoice?: ChoiceId; noSkip?: boolean }): Item {
  const { noSkip, ...rest } = o;
  const choices = [...o.choices];
  if (!noSkip && !choices.some((c) => c.id === 'SKIP')) choices.push({ id: 'SKIP', label: '這次不做', lines: [] });
  const first = choices[0].id;
  return { ...rest, key: `i${++itemCounter}`, choices, choice: o.choice ?? first, ruleChoice: o.ruleChoice ?? first };
}

/** 單位淨值：每一桶與整個帳戶。 */
export function navPerUnit(acct: Account, view: MarketView): { total: number; own: number; mom: number; core: number } {
  const per = (v: number, u: number) => (u > 0 ? v / u : 1);
  return {
    total: per(totalValue(acct, view), acct.units.total),
    own: per(bucketValue(acct, view, 'own'), acct.units.own),
    mom: per(bucketValue(acct, view, 'mom'), acct.units.mom),
    core: per(bucketValue(acct, view, 'core'), acct.units.core),
  };
}

/** 資金流入（正）或流出（負）某一桶：用流動前的市值換算成單位。 */
export function flowUnits(units: number, valueBefore: number, amount: number): number {
  if (units <= 1e-9 || valueBefore <= 1e-9) return Math.max(0, valueBefore + amount);
  const u = units + amount / (valueBefore / units);
  return u < 1e-9 ? 0 : u;
}

/** 推薦標準比重用的波動度：最多 126 天；上市不久的股票用現有的天數，至少 20 天，不夠回傳 NaN。 */
export const STD_VOL_DAYS = 126;
export const STD_VOL_MIN_DAYS = 20;
export function recentVol(close: ArrayLike<number> | undefined, i: number): number {
  if (!close) return NaN;
  let n = 0;
  while (n < STD_VOL_DAYS && i - n - 1 >= 0 && Number.isFinite(close[i - n]) && Number.isFinite(close[i - n - 1]) && close[i - n - 1] > 0) n++;
  if (n < STD_VOL_MIN_DAYS) return NaN;
  const v = annualizedVol(close, i, n);
  return Number.isFinite(v) && v > 0 ? v : NaN;
}

/**
 * 依波動度反比，在自選預算內推薦每檔的標準比重（設計 §2.2）。
 * 歷史不到 126 天的用現有的天數；不到 20 天的用其他檔的平均波動度；全部都算不出來就平分（設計 §10 第 37 點）。
 */
export function recommendStdWeights(view: MarketView, tickers: string[], ownBudget: number): Record<string, number> {
  const vols = tickers.map((t) => recentVol(view.close[t], view.i));
  const known = vols.filter((v) => Number.isFinite(v));
  const fallback = known.length ? known.reduce((a, b) => a + b, 0) / known.length : 1;
  const inv = vols.map((v) => 1 / (Number.isFinite(v) ? v : fallback));
  const s = inv.reduce((a, b) => a + b, 0);
  const out: Record<string, number> = {};
  tickers.forEach((t, k) => {
    out[t] = (ownBudget * inv[k]) / s;
  });
  return out;
}

/**
 * 標準比重沒填時的預設（T43，design_v2 §10 第 50 點，2026-11-16 使用者同意改）：
 * 現在占總資產的比重（這檔在自選桶的市值 ÷ 總資產），不超過單檔上限 cap（ownCapHi）；
 * 沒有持股（0 股、算不出來）時才用推薦值 rec（波動度反比，recommendStdWeights）。推薦值在畫面上只當提示。
 */
export function defaultStdWeight(value: number, total: number, cap: number, rec: number): number {
  const w = total > 0 && Number.isFinite(value) ? value / total : 0;
  return w > 0 ? Math.min(cap, w) : rec;
}

/** 前提 id 的數字部分（P3 → 3；不是 P 開頭的數字就是 0）。 */
const premiseNo = (id: string) => (/^P(\d+)$/.test(id) ? Number(id.slice(1)) : 0);

/** 下一條前提的編號：帳戶狀態有記就用它，否則（T25 之前的資料）用現有最大的編號加 1。 */
export function nextPremiseSeq(meta: Pick<OwnMeta, 'premises' | 'premiseSeq'>): number {
  return Math.max(meta.premiseSeq ?? 0, ...meta.premises.map((p) => premiseNo(p.id) + 1), 1);
}

/** 論點檔編號：`<代號>@<訊號日>`；這一檔上一次結案的也是同一天開的，就加 `#2`、`#3`。 */
export function newFileId(ticker: string, date: string, lastClosed?: string): string {
  const base = `${ticker}@${date}`;
  if (!lastClosed || (lastClosed !== base && !lastClosed.startsWith(base + '#'))) return base;
  const n = lastClosed === base ? 1 : Number(lastClosed.slice(base.length + 1)) || 1;
  return `${base}#${n + 1}`;
}

/**
 * 開一份新的論點檔（新增自選、轉入、認養、手動買進、上線那天）。
 * lastClosed：這一檔上一次結案的論點檔編號（Account.ownClosed），同一天又加回時編號才不會重複。
 */
export function newOwnMeta(view: MarketView, ticker: string, origin: OwnMeta['origin'], premises: Premise[], lastClosed?: string): OwnMeta {
  const dd = drawdownFromHigh(view.close[ticker], view.i);
  // 有論點、加入時已跌 20% → 先買一半（allocation_redesign §4.1）；只有預設前提的照舊從減半開始
  const startState = initialStateForNewPick(dd, premises.some((p) => p.origin !== 'SYSTEM_DEFAULT'));
  const slow = initialSlowState(startState);
  slow.sinceSwitch = 0;
  const ps = premises.map((p) => ({ ...p, addedAt: p.addedAt ?? view.date }));
  return {
    ...(startState === 'BUILD' ? { build: { since: view.date, confirmBy: 'EARNINGS' as const, misses: 0 } } : {}),
    // 開檔後第一次設定標準比重時問「先買一半」（§4.1）：上線那天就有的不問；一開始就是減半或先買一半的也不問
    ...(origin !== 'INITIAL' && startState === 'STD' ? { buildAsk: true } : {}),
    slow,
    pending: null,
    premises: ps,
    origin,
    aiTier: null,
    raisedAt: null,
    flags: [],
    fileId: newFileId(ticker, view.date, lastClosed),
    thesis: null,
    premiseSeq: nextPremiseSeq({ premises: ps }),
    opened: { startState, drawdownAtOpen: Number.isFinite(dd) ? dd : null },
  };
}

export interface InitialAccount {
  cfg?: Partial<EngineConfig>;
  bondTicker?: string;
  paper?: boolean;
  cash: number;
  /** buyNote：建立帳戶時寫的「持有的原因」（T40：存成買進時的一句話，不是前提）。 */
  own?: Record<string, { shares: number; stdWeight: number; state?: 'STD' | 'HALF'; premises?: Premise[]; buyNote?: string }>;
  mom?: Record<string, number>;
  core?: Record<string, number>;
  /** 動能模型名單；預設 = mom 持有的代號。 */
  momModel?: string[];
  volW?: number | null;
  volHist?: number[];
  /** 2026-11-22 起不用（allocation_redesign §1.6）：崩盤規則退場，給了也不讀。 */
  crash?: boolean;
  /** 送出建立帳戶那一刻的美東日期（拆股用，design_v2 §10 第 48 點）；沒給 = 訊號日。 */
  asOf?: string;
}

/** 上線那天：使用者填第一份快照並決定每一檔放哪一桶（設計 §2.3 起步）。 */
export function createAccount(init: InitialAccount, view: MarketView): Account {
  const cfg = { ...DEFAULT_CONFIG, ...init.cfg };
  const rule = emptyRuleState();
  const acct: Account = {
    cfg,
    bondTicker: init.bondTicker ?? 'SGOV',
    paper: init.paper ?? false,
    cash: init.cash,
    lots: { own: {}, mom: { ...(init.mom ?? {}) }, core: { ...(init.core ?? {}) }, unc: {} },
    rule,
    own: {},
    mom: { excluded: {}, adopted: {}, owe: {} },
    notifs: [],
    nextId: 1,
    shadow: [],
    events: [],
    units: { total: 0, own: 0, mom: 0, core: 0 },
    monthlyBlocked: false,
    snapshotDate: view.date,
    splitAsOf: init.asOf && init.asOf > view.date ? init.asOf : view.date,
  };
  for (const [t, o] of Object.entries(init.own ?? {})) {
    acct.lots.own[t] = o.shares;
    const state = o.state ?? 'STD';
    rule.own[t] = { applied: state, stdWeight: o.stdWeight };
    // 「連續站上 200 日均線幾天」從歷史暖機
    const meta = newOwnMeta(view, t, 'INITIAL', o.premises ?? clone(SYSTEM_DEFAULT_PREMISES));
    // 上線那天的狀態由呼叫端給（STD／HALF）；先買一半只用在之後新開的自選（allocation_redesign §4.1）
    delete meta.build;
    meta.slow = warmSlowState(view, t, state);
    meta.opened = { startState: state, drawdownAtOpen: meta.opened?.drawdownAtOpen ?? null };
    const note = o.buyNote?.trim();
    if (note) meta.buyNote = { text: note.slice(0, 300), at: view.date };
    acct.own[t] = meta;
  }
  rule.heldMom = init.momModel ?? Object.keys(init.mom ?? {});
  rule.volW = init.volW ?? null;
  rule.volHist = init.volHist ?? [];
  // 動能的有效比例只剩波動度比例（allocation_redesign §1.5）
  rule.effPrev = rule.heldMom.length ? (rule.volW ?? 1) : null;
  acct.units = {
    total: totalValue(acct, view),
    own: bucketValue(acct, view, 'own'),
    mom: bucketValue(acct, view, 'mom'),
    core: bucketValue(acct, view, 'core'),
  };
  return acct;
}

// ---------------------------------------------------------------- 舊帳戶資料（allocation_redesign §1.5）

/**
 * 0.17.0 以前的規則狀態（有 crash 這個欄位）→ 現在的：crash 拿掉；effPrev 重算成波動度比例（還沒跑過的維持 null）。
 * 已經是新的就原樣回傳。月報存的「月報前的狀態」（SavedState.rule）還原時也經過這裡。
 */
export function normRule(rule: RuleState): RuleState {
  if (!('crash' in rule)) return rule;
  const { crash: _crash, ...rest } = rule;
  return { ...rest, effPrev: rest.effPrev === null || rest.effPrev === undefined ? null : (rest.volW ?? 1) };
}

/** 這一筆策略欠單（mom.owe）是不是只來自崩盤項目（F5／F6）：那則通知上只有崩盤項目有這一檔動能的單。找不到通知 = 不是。 */
function crashOwe(acct: Pick<Account, 'notifs'>, ticker: string, notif: number): boolean {
  const n = acct.notifs.find((x) => x.id === notif);
  if (!n) return false;
  const has = (it: Item) => it.choices.some((c) => c.lines.some((l) => l.bucket === 'mom' && l.ticker === ticker && l.shares));
  const isCrash = (it: Item) => it.f === 'F5' || it.f === 'F6';
  return n.items.some((it) => isCrash(it) && has(it)) && !n.items.some((it) => !isCrash(it) && it.kind === 'STRATEGY' && has(it));
}

/**
 * 讀進來的帳戶狀態轉成現在的樣子（allocation_redesign §1.5「資料的處理」；載入時呼叫，重複呼叫結果相同）：
 *   設定補上 coreBond、coreBand；
 *   規則狀態有 crash（0.17.0 以前）→ 拿掉、effPrev 重算成波動度比例、記下 fromCrashRule、mom.owe 裡原因是崩盤規則的清掉（其他原因的留著）；
 *   coreOwe 清掉；自選的 r1、f25Sent（早就不用的欄位）清掉（T88）。
 * 持股不動：轉換靠第一次界線檢查（§1.5），不寫專用的轉換程式。直接改傳進來的物件並回傳它。
 */
export function migrateAccount(acct: Account): Account {
  if (!acct || !acct.cfg || !acct.rule) return acct;
  if (acct.cfg.coreBond === undefined || acct.cfg.coreBand === undefined) {
    acct.cfg = { ...acct.cfg, coreBond: acct.cfg.coreBond ?? DEFAULT_CONFIG.coreBond, coreBand: acct.cfg.coreBand ?? DEFAULT_CONFIG.coreBand };
  }
  if ('crash' in acct.rule) {
    acct.rule = normRule(acct.rule);
    acct.fromCrashRule = true;
    if (acct.mom?.owe) for (const [tk, o] of Object.entries(acct.mom.owe)) if (crashOwe(acct, tk, o.notif)) delete acct.mom.owe[tk];
  }
  // 0.17.0 以前的核心欠單（coreOwe，崩盤項目選了這次不做）與自選早就不用的欄位（r1：2026-11-15 拿掉 R1；f25Sent：F25 的每月計數）：
  // 型別在 T88 拿掉，讀進來時清掉（沒有地方讀）
  const legacy = acct as Account & { coreOwe?: unknown };
  if (legacy.coreOwe !== undefined) delete legacy.coreOwe;
  for (const m of Object.values(acct.own ?? {}) as (OwnMeta & { r1?: unknown; f25Sent?: unknown })[]) {
    if (m.r1 !== undefined) delete m.r1;
    if (m.f25Sent !== undefined) delete m.f25Sent;
  }
  return acct;
}

/** 用歷史算出「連續站上 200 日均線的天數」，狀態由呼叫端指定。 */
export function warmSlowState(view: MarketView, ticker: string, state: 'STD' | 'HALF'): SlowRuleState {
  const c = view.close[ticker];
  let run = 0;
  for (let k = Math.max(199, view.i - 60); k <= view.i; k++) {
    let s = 0;
    for (let j = k - 199; j <= k; j++) s += c[j];
    run = c[k] > s / 200 ? run + 1 : 0;
  }
  const st = initialSlowState(state, run);
  if (state === 'HALF') st.sinceSwitch = 30;
  return st;
}
