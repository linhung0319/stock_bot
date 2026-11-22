// 把帳戶與通知組成畫面要的資料。這裡只讀不寫。
// 用字原則：不出現功能代號（F1…F25）與權限等級；狀態用一句話寫出「現在怎樣、到哪裡會觸發」。
import { ENTRY_CODE_TEXT } from '../../ai/momEntry';
import {
  AUTO_DEFAULT_DAYS,
  DEFAULT_ONLY_WHY,
  DROP_LADDER,
  SLOW,
  TIER_NAME,
  dropReviewOpen,
  holdsByDefault,
  isHoldNotice,
  bookShares,
  bucketValue,
  composeNotif,
  coreCfg,
  crashReviewOf,
  ownDepositFill,
  ownDepositScale,
  drawdownFromHigh,
  liveShadow,
  momSlotTarget,
  rollingMax,
  sma,
  totalValue,
  trailingReturn,
  type Account,
  type Composed,
  type Item,
  type LedgerEvent,
  type MarketView,
  type Notif,
  type OrderLine,
  type OwnWebSources,
  type ShadowRecord,
  type Snapshot,
  cashflowKind,
  notifName,
  breaksOf,
  buildStale,
  isBelief,
  type PremiseVerify,
  MAX_WATCH,
  notifDay,
  watchRecWeight,
  type WatchMeta,
} from '../../engine';
import { CRASH_REVIEW } from '../../ai/crash';
import { HORIZONS, indexOn, type PriceBook } from '../../ai/shadow';
import type { AiRun } from '../aiRuns';
import type { RunRow } from './aiViews';
import { buildStaleLine, fileKind, prevFileOf, type PrevFile } from '../thesis';
import { MAX_ENTRY_PRICE, entryStateText, splitFactor, type EntryCond, type PriceInput, type SplitLike } from '../watchEntry';
import { draftStateOf, type DraftState } from '../ownDraft';
import type { SiteData } from './backend';
import type { HomeBrief } from '../marketBrief';
import type { NoCrashNote } from '../noCrashNote';
import { accountBubble, todoBubble, type Bubble } from './bubble';
import { coreLineWhy, crashReasonText, explainItem, reasonPicksOf, findNote, liveCashflow, liveCrash, liveOwnRule, fmtMoney, fmtPct, fmtPx, fmtSigned, sharesText, type ExplainContext, type ItemX } from './explain';
import { labelOf, meter, place, scaleOf, type Meter } from './meter';
import { BUCKET_NAME, type AiNote, type Explain, type Gauge, type RankRow } from './types';

type Ready = SiteData & { acct: Account; view: MarketView };

export const ctxOf = (d: Ready): ExplainContext => ({ acct: d.acct, view: d.view, axis: d.axis, rankOrder: d.rankOrder, aiNotes: d.aiNotes, strategy: d.strategy ?? null });

const priceAt = (view: MarketView, t: string): number | null => {
  const c = view.close[t];
  const p = c ? c[view.i] : NaN;
  return Number.isFinite(p) ? p : null;
};

// ---------------------------------------------------------------- 通知

const ITEM_LABEL: Record<string, string> = {
  F1: '動能進場',
  F2: '動能出場',
  F3: '動能比例調回',
  F4: '動能部位調整',
  F5: '崩盤規則啟動（已停用）',
  F6: '崩盤規則解除（已停用）',
  F7: '慢規則減半',
  F8: '慢規則加回',
  F10: '超過上限',
  F11: '入金',
  F12: '出金',
  F13: '改比例',
  F14: '新增自選',
  F15: '移除自選',
  F17: '補做',
  F19: '硬事件',
  F23: 'AI 建議提高比重',
  F24: 'AI 審查的建議',
  F25: '你定的條件成立',
  F26: '核心比例調回',
  F27: '補滿（先買一半）',
  F28: '你定的加碼條件成立',
  F29: '候補進場',
  CORE: '閒置現金',
};

const KIND_LABEL: Record<Notif['kind'], string> = {
  MONTHLY: '月報',
  MONTHLY_EMPTY: '月報',
  URGENT: '當天通知',
  CASHFLOW: '你的操作',
  FIX: '補做',
  INFO: '提醒',
  CLASSIFY: '要你回答',
  CASH_DIFF: '要你回答',
};

const STATUS_LABEL: Record<Notif['status'], string> = {
  PENDING: '等你決定',
  RESPONDED: '等你下單、填快照',
  DONE: '已完成',
  SKIPPED: '這次不做',
  CANCELLED: '已取消',
  READ: '已讀',
  SUPERSEDED: '已被新的清單取代',
  AUTO_DEFAULT: '沒有回覆，自動照預設不動',
};

/**
 * 回覆後整則都沒下單，但每一項本來就是「不動」（規則的選項就是不做，例如乙類預設不動、你選「不同意，不動」）：
 * 這不是「這次不做／沒照規則」（T39a）。回傳要顯示的狀態；不是這種情況回傳 null。
 */
export function keptAsRule(n: Notif): string | null {
  if (n.status !== 'SKIPPED') return null;
  const live = n.items.filter((i) => !i.cancelled);
  // 跌幅審查、沒有前提被判不成立（allocation_redesign §3.2）：預設就是不動，選「不動」不是沒照規則
  if (!live.length || !live.every((i) => i.choice === 'SKIP' && (i.ruleChoice === 'SKIP' || holdsByDefault(i)))) return null;
  if (live.every((i) => holdsByDefault(i))) return '不動';
  return live.some((i) => i.brk?.type === 'B') ? '不同意 AI，不動' : '照規則，不動';
}

/** 一則通知的狀態（通知頁與紀錄共用）：提醒與沒有清單的通知沒有「等你決定」（T39a）。 */
function statusLabelOf(n: Notif): string {
  if (n.followUpOpen) return '快照和清單不同';
  const listLike = n.items.length > 0 && n.kind !== 'INFO';
  if (n.status === 'PENDING' && !listLike) return n.kind === 'INFO' || n.kind === 'MONTHLY_EMPTY' ? '未讀' : '等你回答';
  // 預設不動、不用回覆的跌幅審查（T86 P2）：不是「等你決定」
  if (n.status === 'PENDING' && isHoldNotice(n)) return '不用回覆';
  return keptAsRule(n) ?? STATUS_LABEL[n.status];
}

/**
 * 晚回覆（提醒過才回）時會用回覆當天的收盤價重算的項目（設計 §2.3.1；ops.ts 的 lateReprice）：自選慢規則的單。
 * 回傳那幾檔的代號；沒有這種項目回傳空陣列（不顯示晚回覆的警告，T39a）。
 */
export function lateRepriceTickers(n: Notif): string[] {
  if (!n.reminded || n.status !== 'PENDING') return [];
  return [...new Set(n.items.filter((i) => !i.cancelled && i.kind === 'OWN_RULE' && i.ticker).map((i) => i.ticker!))];
}

export interface LineView {
  ticker: string;
  bucket: string;
  bucketName: string;
  shares: number;
  /** 用訊號日收盤估的金額（正 = 買）。 */
  amount: number | null;
  reason: string;
  /** 核心那一行是算出來補差額的（清單做完多出的現金交給核心、不夠的錢從核心拿），不是哪一項建議本身的單（T39a）。 */
  balance?: boolean;
}

export interface ChoiceView {
  id: string;
  label: string;
  /** 這個選項要下的單，例如「賣 25 股」「不動」。 */
  text: string;
  lines: LineView[];
  note: string;
  isDefault: boolean;
}

export interface ItemView {
  key: string;
  label: string;
  /** own / mom / core / mixed：這一項動的是哪一桶。 */
  bucket: string;
  bucketName: string;
  ticker: string | null;
  /** 一行標題：單一檔時是「賣 ORCL 28 股」，多檔時是說明。 */
  headline: string;
  /** 引擎寫的原標題（多檔的項目、取消的原因會用到）。 */
  title: string;
  kind: Item['kind'];
  cancelled: boolean;
  note: string | null;
  choices: ChoiceView[];
  choice: string;
  /** 規則的選項（沒選就照這個）。 */
  ruleChoice: string;
  /** prefill：理由欄先填的字（晚到的進場否決按「排除」時是「AI 否決：…」，momentum_ai §3.3）。 */
  actions: { id: string; label: string; hint: string; reasonLabel: string; prefill?: string }[];
  explain: Explain;
  /** 門檻條（沒有門檻的建議是 null）。 */
  meter: Meter | null;
  /** 選「這次不做」要寫一句理由（甲類、當天的乙類；own_thesis §1.10）。 */
  reasonRequired: boolean;
  /** 回覆時寫的理由。 */
  reason: string | null;
  /** 理由欄的提示文字與先填的字（崩盤項目，core_ai §3.6）；沒有 = 用網頁預設的文字。 */
  reasonText: { placeholder: string; hint: string; prefill: string } | null;
  /** 理由欄的一鍵選項（confirm_audit_design §6，T72；網站最後加「其他」）；不用寫理由的是 null。 */
  reasonPicks: string[] | null;
  /** 乙類、慢規則減半項目上帶「AI 建議出清」的：可以「拿去討論」（複製 BREAK 討論包）。 */
  discuss: boolean;
  /** 慢規則項目上 AI 的那一行（減半：論點檢查的結果；加回：審查認為前提不成立時的建議；own_thesis §3.4）。沒有是 null。 */
  aiLine: string | null;
  /** 慢規則減半項目上 AI 那一行的狀態（PENDING 檢查進行中、HOLD 建議不動、EXIT 建議出清、AGREE 同意減半、NONE 沒有一致結論）；沒有是 null。 */
  drop: string | null;
  /** 有論點的股票的跌幅審查（allocation_redesign §3.2）。 */
  thesisDrop: boolean;
  /** 乙類用「修正論點」結案的訊號日（這一項同時是取消的，own_thesis §1.10）。 */
  revised: string | null;
  /**
   * 候補進場（F29，allocation_redesign §4.5）：論點草稿「今天沒持股的話會不會買」那一題的那一行（只是資訊，不影響這一項）。
   * 草稿的答案由 T85 丙段寫進項目的 watchEntry.wouldBuy；沒有草稿時寫「還沒有論點草稿」。不是候補進場是 null。
   */
  entryInfo: string | null;
}

export interface OrderView {
  ticker: string;
  shares: number;
  /** 兩桶對沖、不用下單（劃撥）。 */
  transfer: boolean;
  price: number | null;
  amount: number | null;
  parts: LineView[];
}

export interface ComposedView {
  orders: OrderView[];
  cashBefore: number;
  cashAfter: number;
  /** 清單做完還要從券商轉出的金額（出金）。 */
  withdraw: number;
  shortOfCash: boolean;
  /** 核心不夠付、買單被往回減時的說明（C14）；沒有減是 null。 */
  capNote?: string | null;
}

export interface NotifView {
  id: number;
  /** 自己發起的入金／出金／改比例，填快照之前可以取消（設計 §10 第 40 點）。 */
  cancel: { label: string } | null;
  kind: Notif['kind'];
  kindLabel: string;
  date: string;
  title: string;
  text: string | null;
  status: Notif['status'];
  statusLabel: string;
  /** 1 = 看建議、做決定；2 = 下單；0 = 不是清單型的通知或已結束。 */
  step: 0 | 1 | 2;
  reminded: boolean;
  note: string | null;
  ref: number | null;
  items: ItemView[];
  composed: ComposedView | null;
  /** 快照和清單不同，等你選補做或就這樣。 */
  followUp: { ticker: string; listed: number; done: number }[] | null;
  /** 清單外的變動（分類）或現金差額。 */
  ask: { type: 'CLASSIFY'; ticker: string; quantity: number; canMom: boolean; canOwn: boolean; canRemoveOwn: boolean; note: string | null } | { type: 'CASH_DIFF'; amount: number } | null;
  respondedAt: string | null;
  /** 這則通知實際成交了什麼（帳本事件）。 */
  filled: { ticker: string; bucketName: string; shares: number; date: string }[];
  deposit: number | null;
  withdraw: number | null;
  /** 月報：這個月該列的「要看的事」（own_thesis §3.6.6；src 分自選股與動能持股兩段）。 */
  attention: { ticker: string; kind: string; text: string; since: string; src: 'own' | 'mom' | 'watch' }[];
  /** 沒有清單的通知（策略檢討提醒）用到的 AI 執行：通知頁連到報告（momentum_ai §3.8）。沒有是 null。 */
  aiRun: string | null;
  /** 提醒指到的那一則通知的名字（日期與種類，不用內部編號；T39a）。沒有是 null。 */
  refName: string | null;
  /** 晚回覆會用當天收盤價重算的自選慢規則項目（那幾檔的代號）；空的 = 不顯示晚回覆的警告（T39a）。 */
  lateReprice: string[];
  /** 回覆後整則沒下單、但每一項本來就是不動（例如乙類你選「不同意，不動」）：那一句狀態；不是是 null（T39a）。 */
  kept: string | null;
  /** 預設不動的跌幅審查通知（還沒結案）：「不用回覆」的那一句；不是是 null。 */
  holdNotice: string | null;
}

const isBalance = (l: OrderLine): boolean => l.bucket === 'core' && /^(錢交給核心|從核心拿錢|帳上的現金買)/.test(String(l.reason));

function lineView(view: MarketView, l: OrderLine, acct: Account): LineView {
  const px = priceAt(view, l.ticker);
  return { ticker: l.ticker, bucket: l.bucket, bucketName: BUCKET_NAME[l.bucket], shares: l.shares, amount: px === null ? null : l.shares * px, reason: l.bucket === 'core' ? coreLineWhy(String(l.reason), acct) : String(l.reason), balance: isBalance(l) };
}

/** 清單本身不用下單、只有帳上原本的現金交給核心時，核心那一行的說明（T39a：乙類預設不動，右邊卻列「買 VOO」看起來像這則要你下單）。 */
const cashOnlyWhy = (bond: string): string => `帳上原本就有的現金順便買成 ${bond}（現金本來就算核心裡 ${bond} 那一邊，比例沒有變，只是沒有利息）。這則通知本身不用下單；不下也可以，下次有單時會再列。`;

function linesText(lines: OrderLine[], single: boolean): string {
  if (!lines.length) return '不動';
  if (single) return sharesText(lines.reduce((a, l) => a + l.shares, 0));
  return lines.map((l) => `${l.ticker} ${sharesText(l.shares)}`).join('、');
}

const ACTIONS: Record<string, { label: string; hint: string; reasonLabel: string }> = {
  TRANSFER: { label: '我想留著，轉入自選', hint: '不用下單。這些股數改歸自選桶，之後照自選的慢規則管；動能桶下個月用核心的錢補。「如果照賣」會記在紀錄裡。', reasonLabel: '為什麼想留著（存成買進時的一句話，討論時當參考）' },
  EXCLUDE: { label: '排除這一檔', hint: '不買這一檔，改由排名下一名遞補，清單會重算。排除一直有效，可以在「帳戶」取消。「如果沒排除」會記在紀錄裡。', reasonLabel: '為什麼排除' },
  ADOPT: { label: '我也看好，認養到自選', hint: '照常買進，但記在自選桶。之後動能就算把它排除也不會叫你賣；動能那一格下個月再遞補。', reasonLabel: '為什麼看好（存成買進時的一句話，討論時當參考）' },
};

// ---------------------------------------------------------------- 建議單上的門檻條

const pctTxt = (x: number, dp = 1) => `${(Math.abs(x) * 100).toFixed(dp).replace(/\.0$/, '')}%`;

/**
 * 一項建議的門檻條：刻度和門檻用通知裡存著的數字（Gauge），下面那句白話結果用標題的股數。
 * 沒有門檻的建議（入金、出金、硬事件…）回傳 null。
 */
export function itemMeter(d: Ready, n: Notif, it: Item, x: Explain, headline: string): Meter | null {
  const g = x.gauge;
  if (!g || it.cancelled) return null;
  const primary = it.choices.find((c) => c.id !== 'SKIP') ?? it.choices[0];
  const total = primary.lines.reduce((a, l) => a + l.shares, 0);
  const n0 = Math.abs(total);
  const all = /（全部）/.test(headline);
  const when = n.kind === 'MONTHLY' ? '這次月報' : '這次';
  const act = total < 0 ? `${when}賣出${all ? '全部 ' : ' '}${n0} 股` : total > 0 ? `${when}買進 ${n0} 股` : '這次不用下單';
  const cfg = d.acct.cfg;
  let sc = scaleOf(g);
  if (!sc) return null;
  let zone = '觸發';
  let kind: Meter['kind'] = 'stop';
  let say: string | undefined;
  let capText = g.caption;
  switch (it.f) {
    case 'F2': {
      const th = sc.th;
      sc = { ...sc, hit: g.value > th };
      zone = '賣出';
      capText = `一年報酬排名（50 檔大型股裡的名次；條的左端是第 1 名，越右邊名次越後面、越接近賣出）`;
      say = g.value > th ? `已經掉出前 ${th} 名 → ${act}` : `已不在動能名單上（上次沒賣）→ ${act}`;
      break;
    }
    case 'F1': {
      // 前面的股票不能買（已經持有、被否決、你排除）時，實際的門檻往後移到這一名
      const rank = g.value;
      const th = Math.max(cfg.momSlots, rank);
      sc = { start: g.to, th, end: 1, value: rank, hit: true };
      zone = '進場';
      kind = 'go';
      capText = `一年報酬排名（50 檔大型股裡的名次；條的左端是第 ${Math.round(g.to)} 名，越右邊名次越前面、越接近進場）`;
      say = rank <= cfg.momSlots ? `排第 ${rank} 名，在前 ${cfg.momSlots} 名內 → ${act}` : `排在前面的不能買，輪到第 ${rank} 名 → ${act}`;
      break;
    }
    case 'F3': {
      zone = '調回';
      capText = '離每檔目標多遠（越右邊離目標越遠、越接近調回）';
      say = `${g.value > 1 ? '高出' : '低於'}目標 ${pctTxt(g.value - 1, 0)}，超過 ±${pctTxt(sc.th, 0)} → ${total < 0 ? `這次順便賣 ${n0} 股` : `這次順便買 ${n0} 股`}調回`;
      break;
    }
    case 'F4': {
      // 依波動度減碼：要多跨過遲滯（0.10）才換一格
      const before = n.monthly?.before.rule.volW ?? 1;
      const after = d.acct.rule.volW ?? before;
      const m = /σ̃\/σ = ([\d.]+)/.exec(it.why ?? '');
      const ratio = m ? Number(m[1]) : g.value;
      const hyst = cfg.volHyst ?? 0.1;
      const down = after < before;
      const th = down ? before - hyst : before + 1 / 3 + hyst;
      sc = down ? { start: th + 0.6, th, end: Math.max(0, th - 0.6), value: ratio, hit: true } : { start: th - 0.6, th, end: th + 0.6, value: ratio, hit: true };
      zone = down ? '減碼' : '加回';
      kind = down ? 'stop' : 'go';
      capText = `平常的震盪 ÷ 最近的震盪（越右邊代表最近越${down ? '震盪' : '平靜'}）`;
      say = `最近的震盪是平常的 ${(1 / ratio).toFixed(2)} 倍 → 動能部位從${thirdName(before)}${down ? '減' : '加'}到${thirdName(after)}`;
      break;
    }
    case 'F5':
    case 'F6': {
      const on = it.f === 'F5';
      zone = on ? '啟動' : '解除';
      kind = on ? 'stop' : 'go';
      sc = { ...sc, hit: on ? g.value < 0 : g.value > 0 };
      capText = `${cfg.coreTicker} 收盤相對 200 日均線`;
      say = it.relist
        ? on
          ? `${cfg.coreTicker} 仍在 200 日均線之下（${g.valueLabel}）→ 上次沒換的核心，這次再列一次`
          : `${cfg.coreTicker} 仍在 200 日均線之上（${g.valueLabel}）→ 上次沒換回的短債，這次再列一次`
        : on
          ? `${cfg.coreTicker} 跌破 200 日均線（${g.valueLabel}）→ 崩盤規則啟動：核心一半換短債、動能減半`
          : `${cfg.coreTicker} 回到 200 日均線之上（${g.valueLabel}）→ 崩盤規則解除：換回來`;
      break;
    }
    case 'F7': {
      zone = '減半';
      capText = '收盤距 52 週高點（越右邊跌越多、越接近減半）';
      say = it.thesisDrop
        ? it.drop === 'BROKEN'
          ? `比高點低 ${pctTxt(g.value)}，觸發跌幅審查；3 票判前提不成立 → 預設賣一半，${n0} 股`
          : `比高點低 ${pctTxt(g.value)}，超過 20% → 觸發跌幅審查；沒有前提被判不成立，預設不動`
        : `比高點低 ${pctTxt(g.value)}，超過 20% → 這次賣一半，${n0} 股`;
      if (it.thesisDrop) {
        zone = '審查';
        capText = '收盤距 52 週高點（越右邊跌越多；低 20% 觸發跌幅審查）';
      }
      break;
    }
    case 'F8': {
      zone = '買回';
      kind = 'go';
      sc = { ...sc, hit: g.value > 0 };
      capText = `${it.ticker} 收盤相對 200 日均線`;
      say = `站回 200 日均線之上連續 10 天 → 這次買回 ${n0} 股，回到標準比重`;
      break;
    }
    case 'F10': {
      zone = '減碼';
      capText = '占總資產';
      say = `占總資產 ${g.valueLabel}，超過 ${pctTxt(sc.th, 0)} 上限 → ${act}，減回 ${pctTxt(cfg.ownCapTo, 0)}`;
      break;
    }
    case 'F14': {
      zone = '減半';
      capText = '收盤距 52 週高點（越右邊跌越多、越接近減半）';
      const hit = g.value <= sc.th;
      // 你在持股頁選了先買一半（清單照選擇重算過，T86 修正 P1）
      const chose = d.acct.rule.own[it.ticker ?? '']?.applied === 'BUILD' && d.acct.own[it.ticker ?? '']?.opened?.startState !== 'BUILD';
      say = hit ? `已經比高點低 ${pctTxt(g.value)}（超過 20%）→ 先買標準比重的一半，${n0} 股` : chose ? `比高點低 ${pctTxt(g.value)}，還沒到減半的範圍；你選了先買一半 → 先買標準比重的一半，${n0} 股` : `比高點低 ${pctTxt(g.value)}，還沒到減半的範圍 → 買到標準比重，${n0} 股`;
      break;
    }
    case 'F24':
    case 'F25': {
      zone = '減半';
      capText = '規則這邊：收盤距 52 週高點';
      const hit = g.value <= sc.th;
      const own = it.kind === 'OWN_COND';
      say = hit ? `規則也到了減半的範圍（比高點低 ${pctTxt(g.value)}）` : `規則沒有動作（比高點低 ${pctTxt(g.value)}，門檻 20%）→ ${own ? '這是你事先定的條件，預設照當時的決定' : '這是 AI 的建議，預設不做'}`;
      break;
    }
    default:
      if (g.marks[0]?.label.includes('減半')) zone = '減半';
  }
  const p = place(sc);
  return meter(sc, { zone, kind, label: labelOf(g, zone, p.hit), cap: capText, say });
}

const thirdName = (w: number) => (w >= 0.999 ? '全額' : Math.abs(w - 2 / 3) < 0.01 ? '2/3' : Math.abs(w - 1 / 3) < 0.01 ? '1/3' : '0');

/** 候補進場項目上「今天沒持股的話會不會買」那一行（§4.5：只是資訊；反方的答案與草稿日期）。 */
export function wouldBuyLine(w: { answer: string; date: string } | null): string {
  if (!w) return '「今天沒持股的話會不會買」：這檔還沒有論點草稿，沒有這一題的答案。（只是資訊，不影響這一項；有草稿之後會寫在這裡。）';
  return `「今天沒持股的話會不會買」：${w.answer}（${notifDay(w.date)} 的論點草稿裡反方的答案；只是資訊，不影響這一項）`;
}

function itemView(d: Ready, n: Notif, it0: Item): ItemView {
  const it = it0 as ItemX;
  // 慢規則項目上 AI 的那一部分會在通知產生之後才更新（減半檢視晚一點回來），每次讀的時候重算
  // 崩盤項目的「AI 檢視」那一列也一樣：月報之後才回來的檢視（core_ai §3.2）
  // 入金、出金、改比例的「做完之後」：還沒填快照前每次重算（回覆後用合成的清單，core_ai §3.11）
  const x = it.kind === 'OWN_RULE' ? liveOwnRule(ctxOf(d), n, it) : it.f === 'F5' || it.f === 'F6' ? liveCrash(ctxOf(d), n, it) : it.f === 'F11' || it.f === 'F12' || it.f === 'F13' ? liveCashflow(ctxOf(d), n, it) : (it.x ?? explainItem(ctxOf(d), n, it));
  const primary = it.choices.find((c) => c.id !== 'SKIP') ?? it.choices[0];
  const tickers = [...new Set(primary.lines.map((l) => l.ticker))];
  const buckets = [...new Set(primary.lines.map((l) => l.bucket))];
  const bucket = buckets.length === 1 ? buckets[0] : it.kind === 'OWN_RULE' || it.kind === 'AI_ONLY' ? 'own' : buckets.length ? 'mixed' : it.f === 'CORE' ? 'core' : 'own';
  const single = tickers.length <= 1 && !!it.ticker;
  const total = primary.lines.reduce((a, l) => a + l.shares, 0);
  let headline: string;
  // 乙類（AI 判斷前提不成立，own_thesis §1.10）預設不動：標題不寫成「賣 NVDA 13 股」，寫「NVDA 不動」、括號裡是 AI 的建議與股數；修正論點結案後只寫「不動」（T34）
  const brkB = it.brk?.type === 'B' && !it.brk.withRule && it.ruleChoice === 'SKIP';
  if (single && it.ticker && brkB) {
    const exit = total < 0 && -total === (d.acct.lots.own[it.ticker] ?? -1);
    headline = it.cancelled || total === 0 ? `${it.ticker} 不動` : `${it.ticker} 不動（AI 建議${primary.tier ? TIER_NAME[primary.tier] : '調整'}，${total < 0 ? '賣' : '買'} ${Math.abs(total)} 股${exit ? '，全部' : ''}）`;
  } else if (single && it.ticker && holdsByDefault(it)) {
    // 跌幅審查、預設不動（allocation_redesign §3.2）：標題不寫成「賣 MSFT 4 股」（那是另一個選項），寫「MSFT 不動」
    headline = `${it.ticker} 不動`;
  } else if (single && it.ticker) {
    const exit = total < 0 && buckets.length === 1 && -total === (d.acct.lots[buckets[0] as 'own' | 'mom'][it.ticker] ?? -1);
    headline = total === 0 ? `${it.ticker} 不動` : `${total < 0 ? '賣' : '買'} ${it.ticker} ${Math.abs(total)} 股${exit ? '（全部）' : ''}`;
  } else if (it.f === 'F11' || it.f === 'F12') {
    headline = `${it.f === 'F11' ? '入金' : '出金'} ${fmtMoney((it.f === 'F11' ? n.deposit : n.withdraw) ?? 0)}`;
  } else {
    headline = it.title.replace(/：.*$/, '').replace(/（.*）$/, '');
  }
  const choices: ChoiceView[] = it.choices.map((c) => {
    let label = c.label;
    // 下跌加碼（T84）的選項標題本身就寫了要做什麼，不換成「照 AI：…」
    if (c.id === 'AI' && c.tier && !/（/.test(label) && !it.dipAdd) label = `照 AI：${it.aiLine?.includes('維持減半') ? '維持減半' : TIER_NAME[c.tier]}`;
    return {
      id: c.id,
      label,
      text: c.id === 'SKIP' ? '不下單' : linesText(c.lines, single),
      lines: c.lines.map((l) => lineView(d.view, l, d.acct)),
      note: x.choiceNotes?.[c.id] ?? '',
      // 跌幅審查（有論點，T82）：規則的那條線一律是減半（影子紀錄用），但沒有前提不成立時預設是不動（T84 加下跌加碼時一併改正「沒選就是這個」的位置）
      isDefault: c.id === (it.thesisDrop ? (holdsByDefault(it) ? 'SKIP' : 'RULE') : it.ruleChoice),
    };
  });
  return {
    key: it.key,
    label: it.relist ? '上次沒做，再列一次' : it.f === 'F25' && it.kind !== 'OWN_COND' ? 'AI 的條件成立' : it.brk?.type === 'B' && !it.brk.withRule ? 'AI 判斷前提不成立' : it.thesisDrop ? '跌幅審查' : (ITEM_LABEL[it.f] ?? it.f),
    bucket,
    bucketName: bucket === 'mixed' ? '多桶' : BUCKET_NAME[bucket],
    ticker: it.ticker ?? null,
    headline,
    title: it.title,
    kind: it.kind,
    cancelled: !!it.cancelled,
    note: it.note ?? null,
    choices,
    choice: it.choice,
    ruleChoice: it.ruleChoice,
    actions: (it.actions ?? []).map((a) => ({ id: a, ...ACTIONS[a], ...(a === 'EXCLUDE' && it.lateVeto ? { prefill: `AI 否決：${ENTRY_CODE_TEXT[it.lateVeto.code] ?? it.lateVeto.code}` } : {}) })),
    explain: x,
    meter: itemMeter(d, n, it, x, headline),
    reasonRequired: !!it.reasonRequired,
    reason: it.reason ?? null,
    reasonText: crashReasonText(it),
    reasonPicks: reasonPicksOf(it),
    discuss: it.brk?.type === 'B' && !!it.ticker && !!d.acct.own[it.ticker],
    // 只有預設前提的股票：那一行後面接「這檔還沒有你的論點，AI 只檢查系統預設前提。」（引擎寫在這一項的理由裡）
    aiLine: (it.kind === 'OWN_RULE' || it.lateVeto) && it.aiLine ? `${it.aiLine}${it.why?.includes(DEFAULT_ONLY_WHY) ? `。${DEFAULT_ONLY_WHY}` : ''}` : null,
    drop: it.drop ?? null,
    // 有論點的股票的跌幅審查（allocation_redesign §3.2）：選項與理由欄的說明不同
    thesisDrop: !!it.thesisDrop,
    revised: it.revised ?? null,
    entryInfo: it.watchEntry ? wouldBuyLine(it.watchEntry.wouldBuy) : null,
  };
}

export function composedView(d: Ready, n: Notif, c: Composed): ComposedView {
  const cashOnly = c.merged.every((m) => m.parts.every((l) => isBalance(l) && l.shares > 0));
  const orders: OrderView[] = c.merged.map((m) => {
    const px = priceAt(d.view, m.ticker);
    const parts = m.parts.map((l) => lineView(d.view, l, d.acct));
    return { ticker: m.ticker, shares: m.shares, transfer: m.shares === 0, price: px, amount: px === null ? null : m.shares * px, parts: cashOnly ? parts.map((p) => ({ ...p, reason: cashOnlyWhy(d.acct.bondTicker) })) : parts };
  });
  // 賣的排前面（先賣才有錢買），各自照金額大小
  orders.sort((a, b) => Number(a.shares > 0) - Number(b.shares > 0) || Math.abs(b.amount ?? 0) - Math.abs(a.amount ?? 0));
  return { orders, cashBefore: d.acct.cash, cashAfter: c.cashAfter, withdraw: n.withdraw ?? 0, shortOfCash: c.cashAfter < -1, capNote: capNoteOf(c) };
}

/** 核心不夠付時的那一句（C14）：買單從最後一行往回減了哪些。 */
export function capNoteOf(c: Composed): string | null {
  if (!c.capped?.length) return null;
  return `核心的錢不夠付這份清單的買單，已經從最後一張買單往回減：${c.capped.map((x) => `${x.ticker} 少買 ${x.cut} 股`).join('、')}。`;
}

// 建議單的順序照因果排：先是整個帳戶的規則，再來動能（先出場才有位置進場），然後自選、AI 的建議、現金流
// 核心比例調回（F26）是其他單合成之後才算的，排最後
const ITEM_ORDER = ['F5', 'F6', 'F19', 'F2', 'F1', 'F17', 'F3', 'F4', 'F10', 'F7', 'F8', 'F25', 'F24', 'F23', 'F27', 'F28', 'F29', 'F11', 'F12', 'F13', 'F14', 'F15', 'F26', 'CORE'];
const orderOf = (f: string) => {
  const k = ITEM_ORDER.indexOf(f);
  return k < 0 ? ITEM_ORDER.length : k;
};

/** 月報上那一行狀態，換成白話。 */
function plainText(t: string | undefined): string | null {
  if (!t) return null;
  // 2026-11-23 起狀態行直接寫「動能部位全額」（LINE 與網站同一個字）；下面兩行只處理舊通知存的「動能比例 …」
  return t.replace(/動能比例 1$/, '動能部位全額').replace(/動能比例 (\S+)$/, '動能部位 $1').replace('；', '。');
}

export function notifView(d: Ready, n: Notif): NotifView {
  const listLike = n.items.length > 0 && n.kind !== 'INFO';
  let composed: ComposedView | null = null;
  if (listLike) {
    const c = n.status === 'PENDING' ? composeNotif(d.acct, d.view, n) : (n.composed ?? n.preview ?? null);
    if (c) composed = composedView(d, n, c);
  }
  let ask: NotifView['ask'] = null;
  if (n.kind === 'CLASSIFY' && n.ticker) {
    const q = n.quantity ?? 0;
    const ownSh = d.acct.lots.own[n.ticker] ?? 0;
    ask = {
      type: 'CLASSIFY',
      ticker: n.ticker,
      quantity: q,
      canMom: q < 0 ? (d.acct.lots.mom[n.ticker] ?? 0) >= -q : d.acct.rule.heldMom.includes(n.ticker),
      canOwn: q > 0 || ownSh >= -q,
      // 自選賣到 0 股：可以同時移出自選
      canRemoveOwn: q < 0 && !!d.acct.own[n.ticker] && ownSh + q === 0,
      note: n.userNote ?? null,
    };
  } else if (n.kind === 'CASH_DIFF') ask = { type: 'CASH_DIFF', amount: n.amount ?? 0 };
  const filled = [...d.events, ...d.acct.events].filter((e) => e.notif === n.id && e.ticker && e.shares).map((e) => ({ ticker: e.ticker!, bucketName: BUCKET_NAME[e.bucket ?? ''] ?? '', shares: e.shares!, date: e.date }));
  return {
    id: n.id,
    kind: n.kind,
    kindLabel: KIND_LABEL[n.kind],
    date: n.date,
    title: n.title,
    // 失效通知（甲類、乙類，own_thesis §1.10）的說明是 LINE 那幾行，和項目的標題、理由重複：網站不另外顯示（T34）
    text: listLike && n.items.every((i) => i.brk && !(i.brk.type === 'B' && i.brk.withRule)) ? null : plainText(n.text),
    status: n.status,
    statusLabel: statusLabelOf(n),
    step: !listLike ? 0 : n.status === 'PENDING' ? 1 : n.status === 'RESPONDED' ? 2 : 0,
    cancel: cashflowKind(n) && (n.status === 'PENDING' || n.status === 'RESPONDED') && !n.followUpOpen ? { label: `取消這筆${cashflowKind(n)}` } : null,
    reminded: n.reminded,
    note: n.note ?? null,
    ref: n.ref ?? null,
    items: n.items
      .map((it, k) => ({ it, k }))
      .sort((a, b) => orderOf(a.it.f) - orderOf(b.it.f) || a.k - b.k)
      .map((x) => itemView(d, n, x.it)),
    composed,
    followUp: n.followUpOpen && n.followUp ? n.followUp : null,
    ask,
    respondedAt: n.respondedAt ?? null,
    filled,
    deposit: n.deposit ?? null,
    withdraw: n.withdraw ?? null,
    attention: (n.attention ?? []).map((x) => ({ ticker: x.ticker, kind: x.kind, text: x.text, since: x.since, src: x.src ?? 'own', ...(x.link ? { link: x.link } : {}) })),
    aiRun: !n.items.length ? (n.runIds?.[0] ?? null) : null,
    refName: refNameOf(d.acct, n.ref),
    lateReprice: lateRepriceTickers(n),
    kept: keptAsRule(n),
    // 預設不動的跌幅審查通知（allocation_redesign §3.2）：不用回覆，2 個交易日後自動結案；審查還沒有結果時先不結案
    holdNotice: n.status === 'PENDING' && isHoldNotice(n) ? holdNoticeText(d.acct, n) : null,
  };
}

/** 預設不動的跌幅審查通知上「不用回覆」的那一句。 */
function holdNoticeText(acct: Account, n: Notif): string {
  const waiting = n.items.some((it) => !it.cancelled && !!it.ticker && dropReviewOpen(acct.own[it.ticker]?.dropReview));
  return waiting
    ? '這一則不用回覆、不用下單：AI 論點檢查還沒有結論，先不動。有了結論這裡會更新；判前提不成立時預設才會改成減半。想自己先賣可以選「減半」，系統當場給清單。'
    : `這一則不用回覆、不用下單：${AUTO_DEFAULT_DAYS} 個交易日沒有回覆就自動以「不動」結案，不會提醒。結案前想賣可以改選「減半」${n.items.some((it) => !it.cancelled && !!it.dipAdd) ? '，想加碼可以選「加碼」（下跌加碼，這一次下跌只提這一次）' : ''}，系統當場給清單。`;
}

const refNameOf = (acct: Account, id: number | null | undefined): string | null => {
  const r = id ? acct.notifs.find((x) => x.id === id) : undefined;
  return r ? notifName(r) : null;
};

// ---------------------------------------------------------------- 待辦

export interface TodoView {
  id: number;
  /** ANSWER 要你回答；TRADE 已決定、等下單與快照；DECIDE 等你決定；INFO 提醒；FYI 預設不動、不用回覆（不算件數，stateView 另放在 fyi）。 */
  type: 'ANSWER' | 'TRADE' | 'DECIDE' | 'INFO' | 'FYI';
  kindLabel: string;
  title: string;
  date: string;
  /** 每一行：做什麼、因為什麼。 */
  lines: { text: string; why: string; bucket: string }[];
  note: string | null;
}

function todoOf(d: Ready, n: Notif): TodoView | null {
  const base = { id: n.id, kindLabel: KIND_LABEL[n.kind], title: n.title, date: n.date, note: n.text ?? null };
  if (n.followUpOpen && n.followUp) {
    return { ...base, type: 'ANSWER', title: `${n.title}：快照和清單不同`, lines: n.followUp.map((x) => ({ text: `${x.ticker}：清單${sharesText(x.listed)}，實際${sharesText(x.done)}`, why: '要補做差額，還是就這樣？', bucket: '' })) };
  }
  if (n.status === 'RESPONDED') {
    const c = n.composed;
    return { ...base, type: 'TRADE', lines: (c?.merged ?? []).filter((m) => m.shares !== 0).map((m) => ({ text: `${m.shares < 0 ? '賣' : '買'} ${m.ticker} ${Math.abs(m.shares)} 股`, why: '', bucket: '' })) };
  }
  if (n.status !== 'PENDING') return null;
  if (n.kind === 'CLASSIFY' || n.kind === 'CASH_DIFF') return { ...base, type: 'ANSWER', lines: [] };
  if (n.kind === 'INFO' || n.kind === 'MONTHLY_EMPTY' || !n.items.length) return { ...base, type: 'INFO', lines: [] };
  const v = notifView(d, n);
  return {
    ...base,
    // 預設不動、不用回覆的跌幅審查通知（T86 P2，§3.2）：不算「等你決定」、不算首頁件數；另列在「不用回覆」那一類
    type: isHoldNotice(n) ? 'FYI' : 'DECIDE',
    lines: v.items.filter((i) => !i.cancelled).map((i) => ({ text: i.kind === 'AI_ONLY' || i.kind === 'HARD' ? `${i.headline}（${i.label}，預設不做）` : i.headline, why: i.explain.short, bucket: i.bucket })),
  };
}

// ---------------------------------------------------------------- 帳戶

export interface HoldingView {
  bucket: string;
  ticker: string;
  shares: number;
  price: number | null;
  value: number;
  pct: number;
  /** 一句話的狀態。 */
  state: string;
  /** 到哪裡會觸發規則。 */
  detail: string;
  tone: 'ok' | 'warn' | 'alert' | 'muted';
  gauge: Gauge | null;
  /** 帳戶頁每一檔下面的門檻條。 */
  meter: Meter | null;
  /** 目標或標準比重的文字。 */
  target: string | null;
}

export interface AccountView {
  paper: boolean;
  total: number;
  cash: number;
  snapshotDate: string | null;
  ratio: { own: number; strat: number; core: number };
  buckets: { id: string; name: string; value: number; pct: number; budget: number; who: string }[];
  status: { label: string; value: string; tone: 'ok' | 'warn'; detail: string; meter?: Meter | null; cells?: number; coreBar?: CoreBar | null }[];
  holdings: HoldingView[];
  unclassified: { ticker: string; shares: number }[];
  excluded: { ticker: string; reason: string; date: string }[];
  adopted: { ticker: string; reason: string; date: string }[];
  ranking: RankRow[];
  ownTickers: string[];
  monthlyBlocked: boolean;
  /** 候補名單（allocation_redesign §4.5，T85）：帳戶頁自選下面那一塊；watchMax 最多幾檔。 */
  watch: WatchRow[];
  watchMax: number;
}

/**
 * 帳戶頁候補那一塊的一列（allocation_redesign §4.5 第 10 點）。
 * stdWeight：你填的標準比重（null = 留空）；recWeight：推薦值（留空時列進場項目用它；自選預算內依波動度反比）。
 * fromHigh：比 52 週高點低多少（負數）；priceMissing：這次沒有它的收盤價（抓不到的候補不擋整個帳戶，頁面寫「價格抓不到」）。
 * entries：進場條件與現在的狀態（`現在 -27.0%，條件成立中…`；每天比只用來顯示，月報那天仍成立才列）；
 * priceConds：監測中的價格條件（結構化欄位，表單預先填上）；priceMax：價格條件最多幾條；
 * blocked：條件成立但這個月沒提的原因；lastListed：上次列進月報的訊號日（每 90 天最多一次）。
 */
export interface WatchRow {
  ticker: string;
  addedAt: string;
  note: string | null;
  stdWeight: number | null;
  recWeight: number | null;
  price: number | null;
  fromHigh: number | null;
  priceMissing: boolean;
  kind: 'THESIS' | 'DEFAULT_ONLY';
  hasThesisText: boolean;
  draft: string | null;
  /** id：條件的列編號；retire：可以在這裡撤下（非價格、還在監測的；T85 丙段）；price：你填的價格條件。 */
  entries: { id: number; text: string; state: string; price: boolean; retire: boolean }[];
  priceConds: PriceInput[];
  priceMax: number;
  blocked: string | null;
  lastListed: string | null;
}

/** 候補那一塊的進場條件（§4.5 第 13 點）：監測中的、最近 120 天成立過的；成立後等月報的非價格條件（watch.entry）。 */
function watchEntriesOf(d: { view: MarketView; watchConds?: Record<string, EntryCond[]>; splits?: SplitLike[] }, ticker: string, meta: WatchMeta): Pick<WatchRow, 'entries' | 'priceConds'> {
  const { view } = d;
  const c = view.close[ticker];
  const all = (d.watchConds?.[ticker] ?? []).filter((x) => x.fileId === meta.fileId);
  const recent = (x: EntryCond) => !!x.metAt && Date.parse(view.date) - Date.parse(x.metAt.slice(0, 10)) <= 120 * 86400_000;
  const waiting = new Set((meta.entry ?? []).map((x) => x.id));
  const shown = all.filter((x) => !waiting.has(x.id) && (['ACTIVE', 'REVIEW_ONLY', 'MANUAL'].includes(x.status) || (x.status === 'MET' && recent(x))));
  const live = all.filter((x) => x.price && x.status === 'ACTIVE');
  return {
    entries: [
      ...shown.map((x) => ({ id: x.id, text: x.text, state: entryStateText(x, c, view.i, splitFactor(d.splits ?? [], ticker, String(x.check.asOf ?? x.setAt))), price: x.price, retire: !x.price && ['ACTIVE', 'REVIEW_ONLY', 'MANUAL'].includes(x.status) })),
      ...(meta.entry ?? []).map((x) => ({ id: x.id, text: x.text, state: `已成立（${notifDay(x.metOn)}），等下一份月報`, price: false, retire: false })),
    ],
    priceConds: live.flatMap((x): PriceInput[] => (x.check.type === 'price_close_below' ? [{ type: 'close' as const, value: Number(x.check.level) }] : x.check.type === 'price_drawdown_below' ? [{ type: 'drawdown' as const, value: Number(x.check.pct) }] : [])),
  };
}

/** 候補的草稿狀態一句（帳戶頁；沒有草稿是 null）。 */
function watchDraftLine(st: DraftState | null | undefined): string | null {
  if (!st) return null;
  if (st.ready) return '草稿好了，等你看';
  if (st.pending) return '草稿準備中';
  return null;
}

/** 一檔候補 → 帳戶頁那一列。 */
export function watchRowOf(d: Ready, ticker: string, meta: WatchMeta): WatchRow {
  const { acct, view } = d;
  const px = priceAt(view, ticker);
  const c = view.close[ticker];
  const hi = px !== null && c ? rollingMax(c, view.i, SLOW.highDays) : NaN;
  return {
    ticker,
    addedAt: meta.addedAt,
    note: meta.buyNote?.text ?? null,
    stdWeight: meta.stdWeight,
    recWeight: px !== null ? watchRecWeight(acct, view, ticker) : null,
    price: px,
    fromHigh: px !== null && Number.isFinite(hi) && hi > 0 ? px / hi - 1 : null,
    priceMissing: px === null,
    kind: fileKind(meta),
    hasThesisText: !!meta.thesis?.text,
    draft: watchDraftLine(d.drafts?.[ticker]),
    ...watchEntriesOf(d, ticker, meta),
    priceMax: MAX_ENTRY_PRICE,
    blocked: meta.blocked?.text ?? null,
    lastListed: meta.lastListed,
  };
}

function ownHolding(d: Ready, t: string, total: number): HoldingView {
  const { acct, view } = d;
  const sh = acct.lots.own[t] ?? 0;
  const px = priceAt(view, t);
  const c = view.close[t];
  const meta = acct.own[t];
  const rule = acct.rule.own[t];
  const value = px === null ? 0 : sh * px;
  let state = '由你自己管';
  let detail = '';
  let tone: HoldingView['tone'] = 'muted';
  let gauge: Gauge | null = null;
  let met: Meter | null = null;
  if (meta && rule && px !== null && c) {
    const dd = drawdownFromHigh(c, view.i, SLOW.highDays);
    const ma = sma(c, view.i, SLOW.maDays);
    if (meta.pending) {
      state = meta.pending.action === 'REDUCE' ? '已觸發減半，下次月報會列' : '已符合加回，下次月報會列';
      detail = `${meta.pending.date} 觸發；變動不到總資產 5%，所以等月報`;
      tone = 'alert';
    } else if (meta.slow.state === 'WATCH') {
      // 審查後持有（allocation_redesign §3.3）：跌幅審查之後沒有減半，目標還是標準比重
      state = '審查後持有';
      detail = watchNote(acct, t, dd);
      tone = 'warn';
    } else if (rule.applied === 'HALF') {
      state = '減半中';
      const run = meta.slow.aboveRun;
      detail = px > ma ? `站上 200 日均線 ${Math.min(run, SLOW.aboveRun)}/${SLOW.aboveRun} 天，滿了就買回標準比重` : `收盤低於 200 日均線 ${fmtPct(1 - px / ma, 1)}；站回去連續 ${SLOW.aboveRun} 天才買回`;
      // 先買一半時被減半（allocation_redesign §4.1，一半的一半）：目標是標準比重的四分之一
      if (rule.fromBuild) detail = `目標是標準比重 ${fmtPct(rule.stdWeight, 1)} 的四分之一（${fmtPct(rule.stdWeight / 4, 2)}）；${detail}`;
      tone = 'warn';
    } else if (meta.build) {
      // 先買一半（allocation_redesign §4.1）：目標是標準比重的一半，開檔後第一份財報過關再補滿
      state = '先買一半';
      detail = meta.build.ok ? `先買的一半已確認，下一份月報補滿到 ${fmtPct(rule.stdWeight, 1)}` : buildStale(meta, view.date) ? `兩份財報（或滿 200 天）都沒過關，等你決定要不要補滿` : `目標是標準比重 ${fmtPct(rule.stdWeight, 1)} 的一半；開檔後第一份財報過關再補滿`;
      tone = buildStale(meta, view.date) ? 'warn' : 'ok';
    } else {
      state = '正常';
      // 有論點的股票：低 20% 只觸發跌幅審查，不是賣出的理由（allocation_redesign §3.1）
      detail = meta.premises.some((p) => p.origin !== 'SYSTEM_DEFAULT') ? `比 52 週高點低 ${fmtPct(-dd, 1)}；低 20% 會觸發跌幅審查（有論點，不直接減半）` : `比 52 週高點低 ${fmtPct(-dd, 1)}；低 20% 會減半`;
      tone = dd <= -0.15 ? 'warn' : 'ok';
    }
    if (meta.flags.length) {
      state += '・有硬事件標記';
      tone = 'alert';
    }
    if (Number.isFinite(dd)) {
      const from = Math.min(-0.4, Math.floor(dd * 10) / 10 - 0.05);
      gauge = { from, to: 0, fromLabel: fmtPct(from), toLabel: '高點', value: dd, valueLabel: fmtPct(dd, 1), marks: [{ at: SLOW.drawdown, label: '−20%' }], zones: [{ from, to: SLOW.drawdown }], caption: '距 52 週高點' };
    }
    if (rule.applied === 'HALF' && !meta.pending) {
      // 減半中：條改成「站上 200 日均線幾天了」，滿 10 天買回
      const run = px > ma ? Math.min(meta.slow.aboveRun, SLOW.aboveRun) : 0;
      met = meter({ start: 0, th: SLOW.aboveRun, end: SLOW.aboveRun * 1.5, value: run }, { zone: '買回', kind: 'go', label: `站上 200 日均線 ${run} 天；連續 ${SLOW.aboveRun} 天會買回標準比重` });
    } else if (gauge && meta.slow.state === 'WATCH' && !meta.pending) {
      // 審查後持有：條的門檻改成下一級（再跌到那裡會重新審查）；已經審到最後一級就不畫門檻
      const next = nextLadder(meta.watchLevel ?? 0);
      if (next !== null) {
        const from = Math.min(gauge.from, next - 0.1);
        met = meter({ start: 0, th: next, end: from, value: dd, hit: false }, { zone: '再審', label: `比 52 週高點低 ${fmtPct(-dd, 1)}；再跌到 ${fmtPct(next)} 會重新審查` });
      }
    } else if (gauge) {
      const hit = meta.pending ? meta.pending.action === 'REDUCE' : dd <= SLOW.drawdown;
      const thesis = meta.premises.some((p) => p.origin !== 'SYSTEM_DEFAULT');
      met = meter({ ...scaleOf(gauge)!, hit }, thesis && !meta.pending ? { zone: '審查', label: `比 52 週高點低 ${fmtPct(-dd, 1)}；低 20% 會觸發跌幅審查` } : { zone: '減半', label: `比 52 週高點低 ${fmtPct(-dd, 1)}；低 20% 會減半` });
    }
  }
  return { bucket: 'own', ticker: t, shares: sh, price: px, value, pct: value / total, state, detail, tone, gauge, meter: met, target: rule ? `標準比重 ${fmtPct(rule.stdWeight, 1)}` : null };
}

/**
 * 持股頁「先買一半」那一塊（allocation_redesign §4.1、§4.6）。
 * text：現在的說明；stale：兩份財報（或 200 天）沒過關 → 兩個按鈕（維持現在的大小、請 stock bot 草擬）；
 * full：選了先買一半、但現在已經到打算的比例（占總資產 ≥ 標準比重的九成）→ 一鍵改成「已經買到這個比例」。
 */
export interface BuildView {
  text: string;
  /** 補滿過關了，但買進前的程式檢查沒過的那一行（§4.0）；沒有是 null。 */
  blocked: string | null;
  stale: string | null;
  full: string | null;
}

/** 現在已經是打算的比例：占總資產 ≥ 標準比重的這個比例（整股配不到剛好；選了先買一半但其實買足了，§4.6）。 */
export const BUILD_FULL_AT = 0.9;

export function buildViewOf(acct: Account, view: MarketView, ticker: string, weight: number): BuildView | null {
  const meta = acct.own[ticker];
  const rule = acct.rule.own[ticker];
  const b = meta?.build;
  if (!meta || !rule || !b) return null;
  const std = fmtPct(rule.stdWeight, 1);
  const thesis = meta.premises.some((p) => p.origin !== 'SYSTEM_DEFAULT');
  const how = thesis ? '那份財報觸發的審查 3 票一致、沒有任何前提被判不成立' : '程式比對系統預設前提 D1～D3 都沒有不成立';
  const text = b.ok
    ? `先買的一半已確認（${b.ok.text}）：下一份月報會列「補滿到標準比重 ${std}」，預設照做。`
    : `${meta.entered?.via === 'F29' ? '從候補名單進場，先買一半' : '你選了先買一半'}：現在的目標是標準比重 ${std} 的一半（${fmtPct(rule.stdWeight / 2, 1)}），還沒買的部分留在核心。${meta.entered ? '開始持有' : '開檔'}之後的第一份財報過關（${how}）就在下一份月報補滿。${b.last ? `${b.last.text}，等下一份財報。` : ''}`;
  const blocked = b.ok ? buyBlockedText(meta, '補滿', view.date) : null;
  const stale = buildStale(meta, view.date) ? (buildStaleLine(ticker, meta, view.date)[0]?.text.replace('到持股頁決定', '在這一頁決定') ?? null) : null;
  const full = weight >= rule.stdWeight * BUILD_FULL_AT ? '你選了先買一半，但現在已經是打算的比例；要改成「已經買到這個比例」嗎？' : null;
  return { text, blocked, stale, full };
}

/** 「但」後面接英數字開頭的原因（例如日期 12/10）時補一個空白（T86 P12b）。 */
const gap = (t: string): string => (/^[0-9A-Za-z]/.test(t) ? ' ' : '');

/**
 * 買進前的程式檢查沒過、這次不提的那一行（allocation_redesign §4.0）：`補滿的條件過關了，但 11/06 有前提被判不成立，這次不提補滿；下個月月報再看一次。`
 * what：只看這一種買進（沒給 = 哪一種都看）；超過 35 天（下一份月報已經重新看過）不寫。
 */
export function buyBlockedText(meta: Pick<Account['own'][string], 'buyBlocked'>, what: string | null, date: string): string | null {
  const x = meta.buyBlocked;
  if (!x || (what && x.what !== what) || Math.round((Date.parse(date) - Date.parse(x.date)) / 86400_000) >= 35) return null;
  // 你定的加碼條件（T84，§4.2）：條件是一次性的，不會下個月再看；line 是寫好的整句（減半中、不用買、同一份月報已經列了另一條）
  if (x.what === '加碼') return `${x.line ?? `加碼條件成立，但${gap(x.text)}${x.text}，這次不提加碼`}。加碼條件只成立一次，要再用就到編輯論點頁重新定一條。`;
  return `${x.what}的條件${x.what === '補滿' ? '過關了' : '成立了'}，但${gap(x.text)}${x.text}，這次不提${x.what}；下個月月報再看一次。`;
}

/**
 * 下跌加碼那一段（allocation_redesign §4.4，T84）：跌幅審查前提都沒有被判不成立時，持股頁寫有沒有提加碼、沒提的原因。
 * 照做了：「；這次下跌選了加碼（M/D）」；提過：「；通知上有加碼的選項（預設不動）」；沒提：「；沒有提下跌加碼：<原因>」。
 */
/** 月/日（和同頁的「1/13 的當天通知」同一個格式；T86 P8）。 */
const mdOf = (date: string): string => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;

function dipText(meta: Account['own'][string]): string {
  const dr = meta.dropReview;
  const ep = meta.watchSince ?? dr?.session;
  if (meta.dipAdd?.at && meta.dipAdd.episode === ep) return `；這次下跌選了加碼（${mdOf(meta.dipAdd.at)}）`;
  const o = dr?.dipOffer;
  if (!o) return '';
  return o.ok ? `；通知上有下跌加碼的選項（${o.mode === 'FILL' ? '補滿到標準比重' : '提高到標準的 125%'}，預設不動）` : `；沒有提下跌加碼：${o.why}`;
}

/** DROP_LADDER 的下一級（還沒審過的最淺一級）；已經審到最後一級是 null。 */
const nextLadder = (level: number): number | null => DROP_LADDER[level + 1] ?? null;

/**
 * 審查後持有的說明（allocation_redesign §3.3）：
 * `比高點低 23%：11-20 的論點檢查沒有前提被判不成立，沒有減半。再跌到 -30% 會重新審查；站回 200 日線連續 10 天後回到一般狀態。`
 * dd：現在距 52 週高點的跌幅。寫的是最近一次跌幅審查留下的結果（dropReview，留到離開審查後持有為止）。
 */
export function watchNote(acct: Pick<Account, 'own' | 'notifs'>, ticker: string, dd: number): string {
  const meta = acct.own[ticker];
  if (!meta) return '';
  const dr = meta.dropReview;
  const when = dr ? `${mdOf(dr.session)} 的論點檢查` : '跌幅審查';
  const open = acct.notifs.some((n) => n.status === 'PENDING' && n.items.some((i) => i.ticker === ticker && i.f === 'F7' && !!i.thesisDrop && !i.cancelled));
  let what: string;
  if (!dr) what = '跌幅審查之後沒有減半';
  else if (dr.status === 'PENDING') what = `${when}還在跑，先不動`;
  else if (dr.status === 'CLEAR') what = `${when}沒有前提被判不成立，沒有減半${dipText(meta)}`;
  else if (dr.status === 'SPLIT') what = `${when} 3 票沒有一致結論，沒有減半`;
  else if (dr.status === 'BROKEN') {
    const p = meta.premises.find((x) => x.id === dr.premiseId)?.text ?? dr.premiseId ?? '';
    what = `${when}判前提「${p}」不成立；${meta.pending?.action === 'REDUCE' ? '這一筆不到總資產 5%，減半併入下一份月報' : open ? '預設減半，等你決定' : '你選了這次不做，沒有減半'}`;
  } else what = dr.failed ? `${when}沒有跑完，沒有減半` : `${when}還沒有結論，先不動（會再檢查）`;
  const next = nextLadder(meta.watchLevel ?? dr?.level ?? 0);
  const head = Number.isFinite(dd) ? `比高點低 ${fmtPct(-dd, 0)}：` : '';
  return `${head}${what}。${next === null ? '已經審到最後一級，之後不再因為跌幅重新審查' : `再跌到 ${fmtPct(next)} 會重新審查`}；站回 200 日線連續 ${SLOW.aboveRun} 天後回到一般狀態。`;
}

function momHolding(d: Ready, t: string, total: number): HoldingView {
  const { acct, view } = d;
  const sh = acct.lots.mom[t] ?? 0;
  const px = priceAt(view, t);
  const value = px === null ? 0 : sh * px;
  const idx = d.rankOrder.indexOf(t);
  const inModel = acct.rule.heldMom.includes(t);
  const slot = momSlotTarget(acct.cfg, total, acct.rule.effPrev ?? 1);
  let state: string;
  let detail: string;
  let tone: HoldingView['tone'];
  let gauge: Gauge | null = null;
  let met: Meter | null = null;
  if (!inModel) {
    state = '不在動能名單';
    detail = acct.mom.owe[t] ? '上次的出場單沒做，下次月報會再列' : '下次月報會列出場';
    tone = 'alert';
    met = { t: 0.75, v: 1, s: 'hit', zone: '賣出', kind: 'stop', label: `${t} 不在動能名單，${detail}` };
  } else if (idx < 0) {
    state = d.rankOrder.length ? '掉出股票池' : '在動能名單上';
    detail = d.rankOrder.length ? '下次月報會列出場' : '還沒有排名資料';
    tone = d.rankOrder.length ? 'alert' : 'muted';
  } else {
    const rank = idx + 1;
    state = `排名第 ${rank}`;
    detail = rank > acct.cfg.exitRank ? `已掉出前 ${acct.cfg.exitRank} 名，下次月報會列出場` : `掉出前 ${acct.cfg.exitRank} 名才賣`;
    tone = rank > acct.cfg.exitRank ? 'alert' : rank > acct.cfg.exitRank - 3 ? 'warn' : 'ok';
    const to = Math.max(20, Math.min(50, rank + 3));
    gauge = { from: 1, to, fromLabel: '1', toLabel: String(to), value: rank, valueLabel: `第 ${rank}`, marks: [{ at: acct.cfg.exitRank, label: `前 ${acct.cfg.exitRank}` }], zones: [{ from: acct.cfg.exitRank, to }], caption: '一年報酬排名' };
    met = meter({ start: 1, th: acct.cfg.exitRank, end: to, value: rank, hit: rank > acct.cfg.exitRank }, { zone: '賣出', label: `一年報酬排名第 ${rank}；${detail}` });
  }
  return { bucket: 'mom', ticker: t, shares: sh, price: px, value, pct: value / total, state, detail, tone, gauge, meter: met, target: inModel ? `每檔目標 ${fmtPct(slot / total, 1)}` : null };
}

/** 核心比例橫條（allocation_redesign §1.6）：0～40%，15%／20%／25% 三個刻度，三段各自有字，白點 = 現在。 */
export interface CoreBar {
  /** 現在的比例（SGOV 那一邊 ÷ 核心）。 */
  s: number;
  /** 條的右端（0.4）。 */
  max: number;
  /** 三段：偏少、界線內、偏多。 */
  segs: { from: number; to: number; label: string; kind: 'low' | 'in' | 'high' }[];
  /** 刻度：15%、20%（目標）、25%。 */
  ticks: { at: number; label: string }[];
  /** 現在在哪一段。 */
  at: 'low' | 'in' | 'high';
  /** 給螢幕閱讀器的一句話。 */
  label: string;
}

export const CORE_BAR_MAX = 0.4;

/** 核心現在的比例（SGOV 那一邊 ÷ 核心）；算不出來（缺價格、核心是 0）回 null。 */
export function coreRatioOf(acct: Account, view: MarketView): { s: number; bond: number; core: number } | null {
  const pb = priceAt(view, acct.bondTicker);
  const core = bucketValue(acct, view, 'core');
  if (!(core > 0)) return null;
  const sh = acct.lots.core[acct.bondTicker] ?? 0;
  if (sh && pb === null) return null;
  const bond = (pb === null ? 0 : sh * pb) + acct.cash;
  return { s: bond / core, bond, core };
}

const pctW = (x: number): string => `${Math.round(x * 1000) / 10}%`;

export function coreBarOf(acct: Account, view: MarketView): CoreBar | null {
  const r = coreRatioOf(acct, view);
  if (!r) return null;
  const { bond, band } = coreCfg(acct.cfg);
  const lo = Math.round((bond - band) * 1000) / 1000;
  const hi = Math.round((bond + band) * 1000) / 1000;
  const at: CoreBar['at'] = r.s < lo ? 'low' : r.s > hi ? 'high' : 'in';
  const say = at === 'in' ? `在 ${pctW(lo)}～${pctW(hi)} 之內，不調` : `${at === 'low' ? '低於' : '高於'} ${pctW(at === 'low' ? lo : hi)}，下一份月報調回 ${pctW(bond)}`;
  return {
    s: r.s,
    max: CORE_BAR_MAX,
    segs: [
      { from: 0, to: lo, label: '偏少，調回', kind: 'low' },
      { from: lo, to: hi, label: '界線內，不調', kind: 'in' },
      { from: hi, to: CORE_BAR_MAX, label: '偏多，調回', kind: 'high' },
    ],
    ticks: [
      { at: lo, label: pctW(lo) },
      { at: bond, label: `${pctW(bond)} 目標` },
      { at: hi, label: pctW(hi) },
    ],
    at,
    label: `核心裡 ${acct.bondTicker} 與現金占 ${pctW(r.s)}：${say}`,
  };
}

/** 帳戶頁「核心比例」那一格（取代崩盤規則）：大字 = 現在的比例，下面一條橫條，再下面一句話。 */
function coreStatus(d: Ready): AccountView['status'][number] {
  const { acct, view } = d;
  const bar = coreBarOf(acct, view);
  const { bond, band } = coreCfg(acct.cfg);
  const b = acct.bondTicker;
  if (!bar) return { label: '核心比例', value: '算不出來', tone: 'ok', detail: `缺價格，暫時算不出 ${b} 與現金占核心的比例。`, coreBar: null };
  const out = bar.at !== 'in';
  // 這份月報已經列了 F26、還沒回覆：不寫「下一份月報會列」（T86 P12d）
  const listed = acct.notifs.some((n) => n.status === 'PENDING' && n.items.some((i) => i.f === 'F26' && !i.cancelled));
  return {
    label: '核心比例',
    value: `${b} 與現金 ${(bar.s * 100).toFixed(1)}%`,
    tone: out ? 'warn' : 'ok',
    detail: out
      ? `目標 ${pctW(bond)}，界線 ${pctW(bond - band)}～${pctW(bond + band)}；現在${bar.at === 'low' ? '偏少' : '偏多'}，${listed ? '這份月報已經列了一項調回，回覆後照做' : '下一份月報會列一項調回'}。`
      : `目標 ${pctW(bond)}（核心固定放 ${acct.cfg.coreTicker} 八成、${b} 與現金兩成）。每月月報日檢查，超出 ${pctW(bond - band)}～${pctW(bond + band)} 才調回。`,
    coreBar: bar,
  };
}

function coreHoldings(d: Ready, total: number): HoldingView[] {
  const { acct, view } = d;
  const out: HoldingView[] = [];
  // 核心 ETF、短債、現金三列一直都在（2026-11-15 使用者：帳戶也要看得到短債）
  for (const t of new Set([acct.cfg.coreTicker, acct.bondTicker, ...Object.keys(acct.lots.core)])) {
    const sh = acct.lots.core[t] ?? 0;
    if (!sh && t !== acct.cfg.coreTicker && t !== acct.bondTicker) continue;
    const px = priceAt(view, t);
    const value = px === null ? 0 : sh * px;
    if (t === acct.cfg.coreTicker) {
      out.push({ bucket: 'core', ticker: t, shares: sh, price: px, value, pct: value / total, state: '核心 ETF', detail: '核心的八成（目標）', tone: 'ok', gauge: null, meter: null, target: null });
    } else {
      out.push({ bucket: 'core', ticker: t, shares: sh, price: px, value, pct: value / total, state: '短債', detail: '核心的兩成（連同帳上現金）放在這裡', tone: 'muted', gauge: null, meter: null, target: null });
    }
  }
  out.push({ bucket: 'core', ticker: '現金', shares: 0, price: null, value: acct.cash, pct: acct.cash / total, state: '帳上現金', detail: acct.pendingWithdraw ? `出金 ${fmtMoney(acct.pendingWithdraw)} 還沒從券商轉出：券商現在會多顯示這筆` : `算在 ${acct.bondTicker} 那一邊（核心的兩成連同帳上現金）；月報有其他單時順便買成 ${acct.bondTicker}`, tone: 'muted', gauge: null, meter: null, target: null });
  return out;
}

/**
 * 帳戶頁的動能排名（T39a）：「持有」看帳上實際的動能持股，不看規則的目標名單（月報要買、還沒成交的不算持有）。
 * 還沒成交的清單上的動能進場、出場照月報頁的標法（這次買、這次賣）；最近一份月報被 AI 否決的標「AI 否決」。
 */
export function rankingView(d: Ready, n = 15): RankRow[] {
  const { acct } = d;
  const held = (t: string) => (acct.lots.mom[t] ?? 0) > 0;
  const open = acct.notifs.filter((x) => x.status === 'PENDING' || x.status === 'RESPONDED');
  // 還沒成交的清單上，這一檔動能的單（照目前選的選項）
  const listed = (t: string, fs: string[]) =>
    open.some((x) => x.items.some((i) => !i.cancelled && i.ticker === t && fs.includes(i.f) && (i.choices.find((c) => c.id === i.choice)?.lines ?? []).some((l) => l.ticker === t && l.bucket === 'mom' && l.shares !== 0)));
  const lastMonthly = [...acct.notifs].reverse().find((x) => (x.kind === 'MONTHLY' || x.kind === 'MONTHLY_EMPTY') && x.monthly);
  const vetoed = new Set(lastMonthly?.monthly?.input.vetoed ?? []);
  return d.rankOrder.slice(0, n).map((ticker, k) => {
    const c = d.view.close[ticker];
    const ok = c && Number.isFinite(c[d.view.i]);
    const mark: RankRow['mark'] = held(ticker) ? (listed(ticker, ['F2']) ? 'OUT' : 'HELD') : listed(ticker, ['F1', 'F17']) ? 'IN' : vetoed.has(ticker) ? 'VETO' : acct.mom.excluded[ticker] ? 'EXCLUDED' : null;
    return { rank: k + 1, ticker, ret: ok ? trailingReturn(c, d.view.i) : null, mark };
  });
}

export function accountView(d: Ready): AccountView {
  const { acct, view } = d;
  const total = totalValue(acct, view);
  const r = acct.cfg.ratio;
  const bv = { own: bucketValue(acct, view, 'own'), mom: bucketValue(acct, view, 'mom'), core: bucketValue(acct, view, 'core') };
  const byValue = (a: HoldingView, b: HoldingView) => b.value - a.value;
  const own = [...new Set([...Object.keys(acct.lots.own), ...Object.keys(acct.own)])].map((t) => ownHolding(d, t, total)).sort(byValue);
  const mom = Object.keys(acct.lots.mom)
    .filter((t) => acct.lots.mom[t])
    .map((t) => momHolding(d, t, total))
    .sort(byValue);
  const w = acct.rule.volW;
  return {
    paper: acct.paper,
    total,
    cash: acct.cash,
    snapshotDate: acct.snapshotDate,
    ratio: r,
    buckets: [
      { id: 'own', name: '自選', value: bv.own, pct: bv.own / total, budget: r.own, who: '你選股票，慢規則當保險' },
      { id: 'mom', name: '動能', value: bv.mom, pct: bv.mom / total, budget: r.strat, who: '規則照排名選股' },
      { id: 'core', name: '核心', value: bv.core, pct: bv.core / total, budget: r.core, who: `${acct.cfg.coreTicker} 八成、${acct.bondTicker} 與現金兩成；其他兩桶減下來的錢都照這個比例回到這裡` },
    ],
    status: [
      coreStatus(d),
      {
        label: '動能部位',
        value: w === null ? '全額（還沒開始減碼）' : w >= 0.999 ? '全額' : Math.abs(w - 2 / 3) < 0.01 ? '2/3' : Math.abs(w - 1 / 3) < 0.01 ? '1/3' : '0',
        tone: w !== null && w < 0.999 ? 'warn' : 'ok',
        detail: w === null ? '依波動度減碼需要 24 個月的紀錄，累積夠之前維持全額。' : '動能持股比平常震盪時，部位會以 1/3 為單位減少，錢交給核心。',
        cells: w === null ? 3 : Math.round(w * 3),
      },
    ],
    holdings: [...own, ...mom, ...coreHoldings(d, total)],
    unclassified: Object.entries(acct.lots.unc)
      .filter(([, q]) => q)
      .map(([ticker, shares]) => ({ ticker, shares })),
    excluded: Object.entries(acct.mom.excluded).map(([ticker, x]) => ({ ticker, ...x })),
    adopted: Object.entries(acct.mom.adopted).map(([ticker, x]) => ({ ticker, ...x })),
    ranking: rankingView(d),
    ownTickers: Object.keys(acct.own),
    monthlyBlocked: acct.monthlyBlocked,
    watch: Object.entries(acct.watch ?? {})
      .map(([t, m]) => watchRowOf(d, t, m))
      .sort((a, b) => a.addedAt.localeCompare(b.addedAt) || a.ticker.localeCompare(b.ticker)),
    watchMax: MAX_WATCH,
  };
}

// ---------------------------------------------------------------- 首頁

export interface HistoryRow {
  id: number;
  date: string;
  title: string;
  kindLabel: string;
  status: Notif['status'];
  statusLabel: string;
  /** 你選了什麼。 */
  summary: string;
}

function historyRow(n: Notif): HistoryRow {
  const live = n.items.filter((i) => !i.cancelled);
  const did = live.filter((i) => i.choice !== 'SKIP');
  const ai = did.filter((i) => i.choice === 'AI').length;
  let summary = '';
  const kept = keptAsRule(n);
  if (n.status === 'SUPERSEDED') summary = live.length ? '清單重算過，以新的為準' : '併到別的通知或月報，以那一則為準';
  else if (n.status === 'AUTO_DEFAULT') summary = '預設不動；2 個交易日沒有回覆，自動結案';
  else if (kept === '不動') summary = '跌幅審查：你選了不動（沒有前提被判不成立，預設就是不動）';
  else if (kept) summary = live.some((i) => i.brk?.type === 'B') ? '你不同意 AI 的建議，部位不動（規則本來就沒有動作）' : '規則本來就沒有動作，不用下單';
  else if (n.status === 'SKIPPED') summary = '整則沒做';
  else if (live.length && n.status !== 'PENDING') summary = `${live.length} 項裡做了 ${did.length} 項${ai ? `（其中 ${ai} 項照 AI）` : ''}`;
  else if (n.note) summary = n.note;
  return { id: n.id, date: n.date, title: n.title, kindLabel: KIND_LABEL[n.kind], status: n.status, statusLabel: statusLabelOf(n), summary };
}

export interface StateView {
  mode: 'real' | 'demo';
  demo: SiteData['demo'] | null;
  today: string;
  priceDate: string | null;
  rankDate: string | null;
  warnings: string[];
  hasAccount: boolean;
  account: AccountView | null;
  todo: TodoView[];
  /** 不用回覆的通知（預設不動的跌幅審查，T86 P2）：首頁另列一類，不算件數與紅點。 */
  fyi: TodoView[];
  recent: HistoryRow[];
  /** 史萊姆在待辦頁、帳戶頁說的話。 */
  bubble: { todo: Bubble; account: Bubble | null };
  /** 可以復原的快照（設計 §10 第 39 點）。 */
  undo: { date: string; at: string; cashOther: number; cashWarn: boolean } | null;
  /** 還沒有論點的新自選（T40，own_thesis §1.8「存完之後的引導」）：帳戶頁的入口與那張清單。沒有帳戶時是空的。 */
  thesisTodo: ThesisTodoRow[];
  /** 每檔自選的論點草稿狀態（T56；那張清單每一行的「請 stock bot 草擬」）。示範模式、沒有帳戶時是空的。 */
  drafts?: Record<string, DraftState>;
  /** 首頁那一行市場摘要（T65，composite_layer_design §1.8）：最近 10 個交易日內有寫好的摘要時才有。示範模式、沒有帳戶時沒有。 */
  brief?: HomeBrief | null;
  /** 首頁一次性的說明（崩盤規則退場，allocation_redesign §2.4）：按「知道了」之前一直有；沒有是 null。 */
  notice?: NoCrashNote | null;
}

export interface ThesisTodoRow {
  ticker: string;
  /** 買進時的一句話（沒寫是 null）。 */
  buyNote: { text: string; at: string } | null;
  /** 賣光之後又買回、上一次持有時有論點（T44）：那一行寫「上次持有時有論點」。沒有就不帶這個欄位。 */
  prev?: { closedAt: string; closedVerb: string };
}

/**
 * 「還沒有論點的自選」那張清單（T40）：帳戶狀態 thesisTodo 記的代號裡，還在自選、還是「只有預設」的。
 * 每一檔都有論點（或已經不在自選）時是空的，入口也就不見；使用者關掉時 thesisTodo 是空陣列。
 */
export function thesisTodoOf(acct: Pick<Account, 'own' | 'thesisTodo' | 'ownClosed'>, tickers: string[] = acct.thesisTodo ?? []): ThesisTodoRow[] {
  return tickers
    .filter((t) => acct.own[t] && acct.own[t].premises.every((p) => p.origin === 'SYSTEM_DEFAULT'))
    .map((t) => {
      const prev = prevFileOf(acct, t);
      return { ticker: t, buyNote: acct.own[t].buyNote ?? null, ...(prev?.hasThesis ? { prev: { closedAt: prev.closedAt, closedVerb: prev.closedVerb } } : {}) };
    });
}

/**
 * 剛加進自選的那幾檔（快照結果頁、轉入／認養的回應頁的清單）的草稿狀態（T56，web_evidence_design §2.6）：存檔之前載入的狀態裡
 * 還沒有它們，照「還沒有草稿」算（下一次每日流程會不會自動草擬）。示範模式（d.drafts 沒有）是空的。
 */
export function newOwnDrafts(d: Pick<SiteData, 'drafts' | 'aiReady'> & { view: Pick<MarketView, 'date'> }, acct: Account, tickers: string[]): Record<string, DraftState> {
  if (!d.drafts) return {};
  const now = new Date();
  return Object.fromEntries(tickers.map((t) => [t, d.drafts?.[t] ?? draftStateOf([], acct, t, now, d.view.date, !!d.aiReady)]));
}

/**
 * 等你決定的通知排在待辦裡的順序（T39a：首頁史萊姆講排第一的那一則，原本挑到最新、往往是預設不動的 AI 建議）：
 * 0 當天通知、預設要下單（你定的條件成立、慢規則）→ 1 月報 → 2 其他預設要下單的 → 3 預設不動的（AI 的建議、乙類）。同一級先舊後新（晚了的先處理）。
 */
export function decideRank(n: Notif): number {
  const trades = n.items.some((i) => !i.cancelled && i.f !== 'CORE' && (i.choices.find((c) => c.id === i.ruleChoice)?.lines.length ?? 0) > 0);
  if (!trades) return 3;
  if (n.kind === 'URGENT') return 0;
  if (n.kind === 'MONTHLY') return 1;
  return 2;
}

export function stateView(d: SiteData): StateView {
  const base = { mode: d.mode, demo: d.demo ?? null, today: d.today, priceDate: d.view?.date ?? null, rankDate: d.rankSession, warnings: d.warnings, undo: d.undoable ? { date: d.undoable.date, at: d.undoable.at, cashOther: d.undoable.cashOther, cashWarn: d.undoable.cashWarn } : null };
  if (!d.acct || !d.view) return { ...base, hasAccount: !!d.acct, account: null, todo: [], fyi: [], recent: [], thesisTodo: [], bubble: { todo: { k: '開始', say: [d.acct ? '帳戶在，但還沒有可用的價格資料。' : '還沒有帳戶。填一次券商裡現在的持股，我就從那裡開始記帳。'], mood: 'idle' }, account: null } };
  const r = d as Ready;
  const order = { ANSWER: 0, TRADE: 1, DECIDE: 2, INFO: 3, FYI: 4 };
  const byId = new Map(r.acct.notifs.map((n) => [n.id, n]));
  const all = r.acct.notifs.map((n) => todoOf(r, n)).filter((x): x is TodoView => !!x);
  const fyi = all.filter((x) => x.type === 'FYI').sort((a, b) => b.id - a.id);
  const todo = all
    .filter((x) => x.type !== 'FYI')
    .sort((a, b) => order[a.type] - order[b.type] || (a.type === 'DECIDE' && b.type === 'DECIDE' ? decideRank(byId.get(a.id)!) - decideRank(byId.get(b.id)!) || a.id - b.id : b.id - a.id));
  const open = new Set([...todo, ...fyi].map((t) => t.id));
  const recent = r.acct.notifs
    .filter((n) => !open.has(n.id))
    .slice(-5)
    .reverse()
    .map(historyRow);
  const account = accountView(r);
  const first = todo[0];
  const firstN = first?.type === 'DECIDE' ? r.acct.notifs.find((n) => n.id === first.id) : undefined;
  const plan = firstN ? notifView(r, firstN) : null;
  return { ...base, hasAccount: true, account, todo, fyi, recent, thesisTodo: thesisTodoOf(r.acct), drafts: d.drafts ?? {}, brief: d.brief ?? null, notice: d.notice ?? null, bubble: { todo: todoBubble(todo, plan), account: accountBubble(account) } };
}

// ---------------------------------------------------------------- 紀錄

export interface HistoryView {
  notifs: HistoryRow[];
  events: { date: string; text: string; notif: number | null }[];
  shadow: { date: string; ticker: string | null; title: string; rule: string; ai: string | null; actual: string; note: string | null }[];
}

const EVENT_TEXT: Record<string, string> = { DEPOSIT: '入金', WITHDRAW: '出金', DIVIDEND: '股利', CASH_OTHER: '其他現金變動', UNCLASSIFIED: '清單外的變動（還沒分類）', CLASSIFIED: '分類', TRANSFER: '桶之間搬動（不用下單）', TRADE: '成交' };

/** 帳本那一行的種類：拆股（SPLIT）依股數多出或少掉寫「拆股」或「合股」（T39c，design_v2 §10 第 48 點）。 */
function eventKindName(e: Pick<LedgerEvent, 'kind' | 'shares'>): string {
  if (e.kind === 'SPLIT') return (e.shares ?? 0) < 0 ? '合股' : '拆股';
  return EVENT_TEXT[e.kind] ?? e.kind;
}

/**
 * 帳本那一行括號裡的原因（T39a）：核心那一行寫成白話（不寫「核心 ETF」），原因本身的括號換成冒號，不會括號套括號。
 * 「錢交給核心（買核心 ETF）」→「剩下的現金交給核心：買 VOO」。
 */
export function eventReason(reason: string, acct: Account): string {
  const core = acct.cfg.coreTicker;
  const r = reason
    .replace(/^錢交給核心（崩盤規則啟動中：一半買核心 ETF）$/, `剩下的現金交給核心：崩盤規則啟動中，一半買 ${core}`)
    .replace(/^錢交給核心（崩盤規則啟動中：(一半)?放短債）$/, (_, h: string | undefined) => `剩下的現金交給核心：崩盤規則啟動中，${h ?? ''}放短債`)
    .replace(/^錢交給核心（買核心 ETF）$/, `剩下的現金交給核心：買 ${core}`)
    // 2026-11-22 起照比例進出核心（allocation_redesign §1.2）
    .replace(/^錢交給核心（([^（）]*成[^（）]*)）$/, '剩下的現金交給核心：$1')
    .replace(/^從核心拿錢（([^（）]*成[^（）]*)）$/, '不夠的錢從核心拿：$1')
    .replace(/^核心比例$/, '核心比例調回')
    .replace(/^從核心拿錢（賣核心 ETF）$/, `不夠的錢從核心拿：賣 ${core}`)
    .replace(/^從核心拿錢（先用短債）$/, '不夠的錢從核心拿：先用短債')
    .replace(/核心 ETF/g, core);
  return r.replace(/（/g, '：').replace(/）/g, '');
}

export function historyView(d: Ready): HistoryView {
  const events = [...d.events, ...d.acct.events];
  const shadow = liveShadow([...d.shadow, ...d.acct.shadow]);
  return {
    notifs: [...d.acct.notifs].reverse().map(historyRow),
    events: events
      .slice(-150)
      .reverse()
      .map((e) => {
        const who = e.bucket ? `${BUCKET_NAME[e.bucket] ?? e.bucket} ` : '';
        const what = e.ticker ? `${who}${e.ticker} ${e.shares !== undefined ? (e.shares > 0 ? `+${e.shares}` : String(e.shares)) + ' 股' : ''}` : e.amount !== undefined ? fmtMoney(e.amount) : '';
        const why = e.reason ? (e.kind === 'SPLIT' ? e.reason : eventReason(e.reason, d.acct)) : '';
        return { date: e.date, text: `${eventKindName(e)}：${what}${why ? `（${why}）` : ''}`, notif: e.notif ?? null };
      }),
    shadow: shadow
      .slice(-150)
      .reverse()
      .map((s) => ({ date: s.date, ticker: s.ticker, title: s.title, rule: s.ticker ? sharesText(s.rule) : '', ai: s.ai === null ? null : sharesText(s.ai), actual: s.ticker ? sharesText(s.actual) : '', note: s.note ?? null })),
  };
}

// ---------------------------------------------------------------- 崩盤規則的檢視紀錄（core_ai §3.4）

export interface CrashLogRow {
  /** 月份與方向：2027-01 啟動。重列的那一項另外標。 */
  label: string;
  relist: boolean;
  notif: number | null;
  /** 延後（3 票一致）／沒有意見／沒有。 */
  ai: string;
  runId: string | null;
  /** 照做／這次不做：<理由>。 */
  choice: string;
  /** 1、3、6 個月後的三個金額：照規則比你實際、照 AI 比你實際（沒有 AI 意見是 null）、照規則比延後（把你實際換成 0 股）。還沒到是 null。 */
  at: Record<string, { rule: number; ai: number | null; delay: number } | null>;
}

export interface CrashLogView {
  head: string;
  rows: CrashLogRow[];
}

const CRASH_LATE_SUFFIX = '（AI 檢視在回覆之後才回來）';

/**
 * 「AI 紀錄」頁的崩盤規則檢視紀錄（core_ai §3.4）：每次切換一列（同一則通知的 F5／F6 影子紀錄合成一列），
 * 1、3、6 個月後照規則比你實際、照 AI 比你實際、照規則比延後（延後 = 你實際換成 0 股；1 個月那一格就是「延後一個月」的對照）。
 * 算法和 ai/shadow.ts 的 shadowSummary 相同（那一筆的股數差，從當天收盤拿到觀察期結束）。records 要先用 liveShadow 濾掉作廢的。
 */
export function crashLogView(acct: Pick<Account, 'notifs'>, records: ShadowRecord[], book: PriceBook): CrashLogView {
  const groups = new Map<string, ShadowRecord[]>();
  for (const r of records) {
    if ((r.f !== 'F5' && r.f !== 'F6') || !r.ticker) continue;
    const k = r.notif !== undefined ? `n${r.notif}:${r.f}` : `d${r.date}:${r.f}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const last = book.axis.length - 1;
  const rows: CrashLogRow[] = [];
  for (const recs of groups.values()) {
    const r0 = recs[0];
    const n = r0.notif !== undefined ? acct.notifs.find((x) => x.id === r0.notif) : undefined;
    const it = n?.items.find((i) => i.f === r0.f && !i.cancelled);
    const relist = !!it?.relist || /再列一次/.test(r0.title);
    const cr = it ? crashReviewOf(it) : undefined;
    const aiOp = cr?.state === 'OPINION' ? cr.opinion : r0.ai === null ? undefined : r0.ai === r0.rule ? '照做' : '延後';
    const ai = aiOp ? `${aiOp}（${cr?.votes ?? '3 票一致'}）` : cr?.state === 'NO_OPINION' ? '沒有意見' : '沒有';
    const reason = (r0.note ?? '').replace(CRASH_LATE_SUFFIX, '').trim();
    const at: CrashLogRow['at'] = {};
    for (const hz of HORIZONS) {
      let ok = true;
      const v = { rule: 0, ai: aiOp ? 0 : (null as number | null), delay: 0 };
      for (const r of recs) {
        const k0 = indexOn(book.axis, r.date);
        const k1 = k0 + hz.days;
        const a0 = book.adj(r.ticker!, k0);
        const a1 = book.adj(r.ticker!, k1);
        if (k0 < 0 || k1 > last || !(a0 > 0) || !Number.isFinite(a1)) {
          ok = false;
          break;
        }
        const per = r.price * (a1 / a0 - 1);
        v.rule += (r.rule - r.actual) * per;
        if (v.ai !== null && r.ai !== null) v.ai += (r.ai - r.actual) * per;
        v.delay += r.rule * per;
      }
      at[hz.key] = ok ? v : null;
    }
    rows.push({
      label: `${n?.monthly?.input.month ?? r0.date.slice(0, 7)} ${r0.f === 'F5' ? '啟動' : '解除'}`,
      relist,
      notif: n?.id ?? null,
      ai,
      runId: cr?.runId ?? it?.runIds?.[0] ?? r0.runIds?.[0] ?? null,
      choice: r0.choice === 'SKIP' ? `這次不做${reason ? `：${reason}` : ''}` : '照做',
      at,
    });
  }
  rows.reverse();
  const sw = rows.filter((r) => !r.relist);
  const delays = sw.filter((r) => r.ai.startsWith('延後'));
  const better = delays.filter((r) => (r.at['1m']?.delay ?? 0) < 0);
  return { head: sw.length ? `崩盤規則（已停用）切換過 ${sw.length} 次；AI 說延後 ${delays.length} 次，其中 ${better.length} 次延後一個月比較好。` : '還沒有紀錄', rows };
}

/**
 * AI 紀錄的列表：預估的檢視（PREVIEW）在訊號日沒有切換時標「沒有用到」（core_ai §3.1 效果表；顯示時判斷，不存欄位）：
 * 這個月份已經有月報、月報裡沒有同方向的 F5／F6。
 */
export function crashPreviewUnused(run: Pick<AiRun, 'fn' | 'pack'>, acct: Pick<Account, 'notifs'>): string | null {
  if (run.fn !== CRASH_REVIEW) return null;
  const d = (run.pack.rule.detail ?? {}) as { kind?: string; month?: string; direction?: string };
  if (d.kind !== 'PREVIEW' || !d.month || (d.direction !== 'ON' && d.direction !== 'OFF')) return null;
  const m = acct.notifs.filter((n) => n.monthly?.input.month === d.month && (n.kind === 'MONTHLY' || n.kind === 'MONTHLY_EMPTY'));
  if (!m.length || m.some((n) => n.items.some((i) => i.f === (d.direction === 'ON' ? 'F5' : 'F6') && !i.relist))) return null;
  return `預估會${d.direction === 'ON' ? '啟動' : '解除'}，訊號日沒有切換，沒有用到`;
}

/** 列表上的那一列套上「沒有用到」。 */
export const withPreviewNote = (row: RunRow, run: Pick<AiRun, 'fn' | 'pack'>, acct: Pick<Account, 'notifs'>): RunRow => {
  const u = crashPreviewUnused(run, acct);
  return u ? { ...row, verdict: u } : row;
};

// ---------------------------------------------------------------- 單一持股

export interface HoldingDetail {
  ticker: string;
  date: string;
  price: number | null;
  positions: { bucket: string; bucketName: string; shares: number; value: number; pct: number }[];
  chart: { dates: string[]; close: number[]; ma200: (number | null)[]; halfLine: (number | null)[]; /** 那條線的名字：有論點的是「審查線」（碰到才跌幅審查），只有預設前提的是「減半線」（T86 P7） */ lineName?: string; marks: { date: string; label: string }[] } | null;
  facts: { label: string; value: string; note?: string }[];
  own: {
    state: string;
    thesisKind: boolean;
    watch: string | null;
    /** 先買一半（allocation_redesign §4.1）；不是是 null。 */
    build: BuildView | null;
    /** 開檔後第一次設定標準比重：標準比重那一欄多「先買一半，確認後再補滿」的選項。 */
    askBuild: boolean;
    /** 從候補名單進場的（你自己先買的）：那個選項預選「先買一半」（allocation_redesign §4.1 表單上的「從候補名單進場的預設」）。 */
    askBuildHalf: boolean;
    /** 從候補名單進場的那一行：`11/20 加入候補 → 2/3 進場（照月報的進場項目買的，先買一半）`；不是從候補進場的是 null。 */
    entered: string | null;
    /** 買進的條件成立、但買進前的程式檢查沒過的那一行（allocation_redesign §4.0；補滿的不在這裡）。 */
    buyBlocked: string | null;
    stdWeight: number;
    /** 自選桶這一檔現在占總資產（T43：標準比重那一行寫「現在占 X%」）。 */
    weight: number;
    /** 減半中：入金只補到標準比重的一半（T43）。 */
    half: boolean;
    /** 入金會補到占總資產多少（減半的算一半；自選各檔合計超過自選比例時照比例縮小，T43）。 */
    fill: number;
    /** 自選各檔目標合計超過自選比例：入金照比例少補。 */
    scaled: boolean;
    /** id：前提的編號；system：系統預設前提。 */
    /** silenced：這條前提在靜默期內的那一句（own_thesis §1.10；不在是 null）。 */
    /**
     * breaksIf：怎樣算不成立的子句（T60 起最多 3 句；舊資料的一段字當成一句；沒有是空陣列）；confirmsIf：怎樣算證實；
     * verify：怎麼驗證（沒有是 null）；belief：信念（verify.by = NONE，composite §2.3：查不到，是你選擇相信的，不進審查）。
     */
    premises: { id: string; text: string; origin: string; system: boolean; silenced: string | null; breaksIf: string[]; confirmsIf: string | null; verify: PremiseVerify | null; belief: boolean }[];
    lastReview: string | null;
    /** 月底檢查點沒有新證據、沒審的那一句（own_thesis §3.7）；之後有新的審查就不顯示。 */
    reviewSkip: string | null;
    /** 論點本文（還沒寫是 null）；afterBreak：失效後修改幾次。 */
    thesis: { text: string; setAt: string; source: string; version: number; afterBreak: number } | null;
    /** 有論點／只有預設（系統預設前提）。 */
    kind: 'THESIS' | 'DEFAULT_ONLY';
    /** 買進時的一句話（T40，own_thesis §1.8）：不是前提，「還沒有你的論點」下面顯示。沒寫是 null。 */
    buyNote: { text: string; at: string } | null;
    /** 開檔時就是減半、還沒加回過（own_thesis §3.8）的那一句。 */
    openNote: string | null;
    /**
     * 賣光之後又買回時的上一份論點檔（T44，own_thesis §1.2）：持股頁「上一次持有時」那一塊、編輯論點頁的「帶入上次的論點」。
     * 這裡只有帳戶狀態記的（conditions 是 null）；真實模式的路由再補上當時的出場條件。沒有是 null。
     */
    prev: PrevFile | null;
    /** 還沒回覆、建議這檔照 AI 調整的通知（編輯論點頁的「這是對通知 #N 的回應」）。 */
    pendingBreak: { notif: number; tier: string | null; premiseId: string | null } | null;
    /** 那則通知的名字（日期與種類，不用內部編號；T39a）。 */
    pendingBreakName: string | null;
    /** 網頁證據的來源（T52，web_evidence_design §1.3）：同業、這檔的一手網域、存檔時試抓的結果。沒有指定是 null。 */
    webSources: OwnWebSources | null;
    /** stock bot 的論點草稿（T56，web_evidence_design §2.5、§2.6）：「請 stock bot 草擬」按鈕的狀態。示範模式是 null。 */
    draft: DraftState | null;
  } | null;
  /**
   * 候補（allocation_redesign §4.5 第 10 點）：詳細頁沿用持股頁，多這一塊；不是候補是 null。
   * 候補時 own 也有（論點那一塊、編輯論點頁照用；慢規則的欄位是中性的值：沒有狀態、沒有先買一半、0 股）。
   */
  watch: (WatchRow & { max: number; count: number }) | null;
  ai: AiNote | null;
  history: { date: string; text: string; notif: number | null }[];
  canRemove: boolean;
  /** 還沒成交的清單上這一檔的單（照目前選的選項）：持股頁也要看得到，例如動能這個月超過目標 ±50% 要賣（T39a）。 */
  open: { notif: number; name: string; text: string; decided: boolean }[];
}

/** 還沒成交的清單上這一檔的單：「賣 PLTR 19 股（動能比例調回）」。 */
function openOrdersOf(acct: Account, ticker: string): HoldingDetail['open'] {
  const out: HoldingDetail['open'] = [];
  for (const n of acct.notifs) {
    if (n.status !== 'PENDING' && n.status !== 'RESPONDED') continue;
    for (const it of n.items) {
      if (it.cancelled) continue;
      const lines = (it.choices.find((c) => c.id === it.choice)?.lines ?? []).filter((l) => l.ticker === ticker && l.bucket !== 'core');
      const sh = lines.reduce((a, l) => a + l.shares, 0);
      if (!sh) continue;
      out.push({ notif: n.id, name: notifName(n), text: `${sh < 0 ? '賣' : '買'} ${ticker} ${Math.abs(sh)} 股（${ITEM_LABEL[it.f] ?? '清單'}）`, decided: n.status === 'RESPONDED' });
    }
  }
  return out;
}

const ORIGIN: Record<string, string> = { USER: '你寫的', AI_DRAFT_ACCEPTED: 'AI 草擬、你採用的', SYSTEM_DEFAULT: '系統預設' };
/** 論點本文是怎麼來的（持股頁那一行；DRAFT 是 T56 的：用了 stock bot 草稿的論點、一字沒改）。 */
export const THESIS_SOURCE: Record<string, string> = { TYPED: '在網站手寫', DISCUSSION: '討論後貼回', DRAFT: '用了 stock bot 的草稿' };

export function chartOf(d: Ready, ticker: string, days = 250): HoldingDetail['chart'] {
  const c = d.view.close[ticker];
  if (!c || !Number.isFinite(c[d.view.i])) return null;
  const end = d.view.i;
  let start = Math.max(0, end - days + 1);
  while (start < end && !Number.isFinite(c[start])) start++;
  const dates: string[] = [];
  const close: number[] = [];
  const ma200: (number | null)[] = [];
  const halfLine: (number | null)[] = [];
  const off = d.axis.length - 1 - end;
  // 減半線（52 週高點 −20%）只是自選慢規則的門檻：動能、核心沒有這條規則，不畫（T39a）
  const half = !!d.acct.own[ticker];
  for (let i = start; i <= end; i++) {
    dates.push(d.axis[i + off] ?? '');
    close.push(Math.round(c[i] * 100) / 100);
    const ma = sma(c, i, 200);
    ma200.push(Number.isFinite(ma) ? Math.round(ma * 100) / 100 : null);
    const hi = half ? rollingMax(c, i, SLOW.highDays) : NaN;
    halfLine.push(Number.isFinite(hi) ? Math.round(hi * (1 + SLOW.drawdown) * 100) / 100 : null);
  }
  const marks = d.acct.notifs.filter((n) => n.items.some((i) => i.ticker === ticker) && n.date >= dates[0]).map((n) => ({ date: n.date, label: n.title }));
  return { dates, close, ma200, halfLine, lineName: half && fileKind(d.acct.own[ticker]) === 'THESIS' ? '審查線' : '減半線', marks };
}

/**
 * 開檔時就是減半、還沒加回過的股票（own_thesis §3.8）：大跌之後買進，價格的底線已經用掉了。
 * 「還沒加回過」= 現在還是減半，而且開檔之後沒有這檔的加回單（F8）。
 */
function openNoteOf(acct: Account, ticker: string): string | null {
  const meta = acct.own[ticker];
  const o = meta?.opened;
  if (!meta || o?.startState !== 'HALF' || acct.rule.own[ticker]?.applied !== 'HALF') return null;
  // 開始持有那天起（從候補進場的看 heldSince，allocation_redesign §4.5 第 4 點）
  const since = meta.heldSince ?? meta.fileId?.slice(ticker.length + 1, ticker.length + 11) ?? '';
  if (acct.notifs.some((n) => n.date >= since && n.items.some((i) => i.f === 'F8' && i.ticker === ticker))) return null;
  const dd = o.drawdownAtOpen === null ? '' : `加入時比 52 週高點低 ${Math.round(-o.drawdownAtOpen * 100)}%，`;
  return `${dd}慢規則從減半開始：站回 200 日均線連續 ${SLOW.aboveRun} 天之前，規則不會再有動作。`;
}

/**
 * 月底檢查點沒有新證據、這個月沒審（own_thesis §3.7）：「這個月沒有新證據，沿用 2026-11-06 的審查」。
 * 跨月之後寫哪個月；之後有比沿用的那次新的審查結論（aiTier）就不顯示。
 */
function reviewSkipOf(meta: Account['own'][string], date: string): string | null {
  const s = meta.reviewSkip;
  if (!s) return null;
  if (meta.aiTier && meta.aiTier.date > s.since) return null;
  const when = s.month === date.slice(0, 7) ? '這個月' : `${Number(s.month.slice(5, 7))} 月底檢查時`;
  return `${when}沒有新證據，沿用 ${s.since} 的審查。`;
}

/**
 * 這條前提在靜默期內（own_thesis §1.10）的那一句：「靜默中，到 2027-02-26：你在 11/19 不同意（理由）…」。不在靜默期是 null。
 */
function silencedText(meta: Account['own'][string], premiseId: string, date: string): string | null {
  const d = [...(meta.disputes ?? [])].reverse().find((x) => x.premiseId === premiseId && x.until >= date);
  if (!d) return null;
  return `靜默中，到 ${d.until}（${Number(d.since.slice(5, 7))}/${Number(d.since.slice(8, 10))} 起，${d.reason}）：AI 只因為這條前提不成立的建議，這段期間不會通知你`;
}

/** 還沒回覆的乙類（AI 判斷前提不成立；當天通知或月報裡的，own_thesis §1.10）：編輯論點頁可以用「修正論點」回應的那一則。 */
export function pendingBreakOf(acct: Account, ticker: string): { notif: number; tier: string | null; premiseId: string | null } | null {
  for (const n of [...acct.notifs].reverse()) {
    if (n.status !== 'PENDING') continue;
    // 慢規則減半項目上的「AI 建議出清」不能用修正論點結案（§3.4），不算
    const it = n.items.find((i) => i.ticker === ticker && i.brk?.type === 'B' && !i.brk.withRule && !i.cancelled);
    if (it) return { notif: n.id, tier: it.choices.find((c) => c.id === 'AI')?.tier ?? null, premiseId: it.brk?.premiseId ?? null };
  }
  return null;
}

/**
 * 候補的詳細頁那一份 own（allocation_redesign §4.5 第 10 點）：論點那一塊與編輯論點頁要的欄位照填；
 * 慢規則、先買一半、審查、靜默期這些只對持股有意義的給中性的值（候補沒有）。標準比重：你填的，留空用推薦值。
 */
function watchOwnOf(d: Ready, ticker: string, w: WatchMeta): NonNullable<HoldingDetail['own']> {
  const { acct, view } = d;
  const kind = fileKind(w);
  return {
    state: '候補',
    thesisKind: kind === 'THESIS',
    watch: null,
    build: null,
    askBuild: false,
    askBuildHalf: false,
    entered: null,
    buyBlocked: null,
    stdWeight: w.stdWeight ?? watchRecWeight(acct, view, ticker) ?? 0,
    weight: 0,
    half: false,
    fill: 0,
    scaled: false,
    premises: w.premises.map((p) => {
      const breaks = breaksOf(p);
      return {
        id: p.id,
        text: p.text + (breaks.length ? `（不成立的訊號：${breaks.join('；')}）` : ''),
        origin: ORIGIN[p.origin] ?? p.origin,
        system: p.origin === 'SYSTEM_DEFAULT',
        silenced: null,
        breaksIf: breaks,
        confirmsIf: p.confirmsIf ?? null,
        verify: p.verify ?? null,
        belief: isBelief(p),
      };
    }),
    lastReview: null,
    reviewSkip: null,
    thesis: w.thesis?.text ? { text: w.thesis.text, setAt: w.thesis.setAt, source: THESIS_SOURCE[w.thesis.source] ?? '在網站手寫', version: w.thesis.version, afterBreak: w.thesis.afterBreak } : null,
    kind,
    buyNote: w.buyNote ?? null,
    openNote: null,
    prev: prevFileOf(acct, ticker),
    pendingBreak: null,
    pendingBreakName: null,
    webSources: w.webSources ?? null,
    draft: d.drafts?.[ticker] ?? null,
  };
}

const ENTERED_STATE: Record<string, string> = { BUILD: '先買一半', HALF: '從減半開始', STD: '標準', WATCH: '審查後持有' };

/** 從候補名單進場的那一行（allocation_redesign §4.5 第 4 點）。 */
export function enteredLine(meta: Pick<Account['own'][string], 'entered'>): string | null {
  const e = meta.entered;
  if (!e) return null;
  return `${notifDay(e.addedAt)} 加入候補 → ${notifDay(e.date)} 進場（${e.via === 'F29' ? '照月報的進場項目買的' : '你沒等進場條件、自己先買的'}，${ENTERED_STATE[e.state] ?? e.state}${e.via === 'SELF' && e.state === 'STD' ? '；下面第一次存標準比重時可以選先買一半' : ''}）。論點沿用候補時寫的那一份。`;
}

export function holdingDetail(d: Ready, ticker: string): HoldingDetail {
  const { acct, view } = d;
  const total = totalValue(acct, view);
  const px = priceAt(view, ticker);
  const c = view.close[ticker];
  const positions = (['own', 'mom', 'core', 'unc'] as const)
    .filter((b) => acct.lots[b][ticker])
    .map((b) => {
      const sh = acct.lots[b][ticker];
      const value = px === null ? 0 : sh * px;
      return { bucket: b, bucketName: BUCKET_NAME[b], shares: sh, value, pct: value / total };
    });
  const facts: HoldingDetail['facts'] = [];
  if (px !== null && c) {
    const hi = rollingMax(c, view.i, SLOW.highDays);
    const ma = sma(c, view.i, 200);
    facts.push({ label: '收盤', value: fmtPx(px), note: view.date });
    if (Number.isFinite(hi)) facts.push({ label: '52 週高點', value: fmtPx(hi), note: `現在低 ${fmtPct(1 - px / hi, 1)}` });
    if (Number.isFinite(ma)) facts.push({ label: '200 日均線', value: fmtPx(ma), note: `收盤${px >= ma ? '高' : '低'} ${fmtPct(Math.abs(px / ma - 1), 1)}` });
    const ret = trailingReturn(c, view.i);
    if (Number.isFinite(ret)) facts.push({ label: '過去一年報酬', value: fmtSigned(ret) });
  }
  const idx = d.rankOrder.indexOf(ticker);
  if (idx >= 0) facts.push({ label: '動能排名', value: `第 ${idx + 1} 名`, note: '50 檔大型股裡照一年報酬排' });
  const meta = acct.own[ticker];
  const rule = acct.rule.own[ticker];
  const wmeta = meta ? undefined : acct.watch?.[ticker];
  const note = findNote(d.aiNotes, 'REVIEW', ticker, view.date) ?? null;
  const events = [...d.events, ...acct.events].filter((e) => e.ticker === ticker);
  const history = [
    ...acct.notifs.filter((n) => n.items.some((i) => i.ticker === ticker) || n.ticker === ticker).map((n) => ({ date: n.date, text: `${KIND_LABEL[n.kind]}：${n.items.find((i) => i.ticker === ticker)?.title ?? n.title}`, notif: n.id as number | null })),
    ...events.map((e) => ({ date: e.date, text: `${eventKindName(e)}：${BUCKET_NAME[e.bucket ?? ''] ?? ''} ${e.shares !== undefined ? (e.shares > 0 ? '+' : '') + e.shares + ' 股' : ''}${e.kind === 'SPLIT' && e.reason ? `（${e.reason}）` : ''}`, notif: null as number | null })),
  ].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return {
    ticker,
    date: view.date,
    price: px,
    positions,
    chart: chartOf(d, ticker),
    facts,
    own:
      meta && rule
        ? {
            state: meta.slow.state === 'WATCH' ? '審查後持有' : rule.applied === 'HALF' ? '減半中' : meta.build ? '先買一半' : '正常',
            // 先買一半（allocation_redesign §4.1）：說明、拖太久時的兩個按鈕、選了先買一半但其實買足了的一鍵改；不是先買一半是 null
            build: buildViewOf(acct, view, ticker, positions.find((p) => p.bucket === 'own')?.pct ?? 0),
            // 開檔後第一次設定標準比重：多「先買一半，確認後再補滿」的選項（只問這一次；減半中、審查後持有的不問）
            askBuild: !!meta.buildAsk && meta.slow.state === 'STD' && rule.applied === 'STD',
            askBuildHalf: meta.origin === 'WATCH',
            entered: enteredLine(meta),
            // 提高到 125% 的條件成立、但買進前的程式檢查沒過的那一行（補滿的那一行寫在先買一半那一塊）
            buyBlocked: meta.buyBlocked?.what === '補滿' ? null : buyBlockedText(meta, null, view.date),
            // 有論點的股票：比高點低 20% 只觸發跌幅審查（allocation_redesign §3.1）；持股頁那一塊的標題與說明跟著變
            thesisKind: meta.premises.some((p) => p.origin !== 'SYSTEM_DEFAULT'),
            // 審查後持有的說明（§3.3）；不是就是 null
            watch: meta.slow.state === 'WATCH' ? watchNote(acct, ticker, view.close[ticker] ? drawdownFromHigh(view.close[ticker], view.i, SLOW.highDays) : NaN) : null,
            stdWeight: rule.stdWeight,
            weight: positions.find((p) => p.bucket === 'own')?.pct ?? 0,
            half: rule.applied === 'HALF',
            fill: ownDepositFill(acct.rule, acct.cfg, ticker) ?? 0,
            scaled: ownDepositScale(acct.rule, acct.cfg.ratio.own) < 1,
            // breaksIf 另外給一份（T56：編輯論點頁要能看、能改「怎樣算不成立」；text 照舊接在後面給持股頁顯示，T60 起多句用「；」接）
            // T60：怎樣算證實、怎麼驗證、是不是信念另外給（編輯論點頁要能改；持股頁標明信念）
            premises: meta.premises.map((p) => {
              const breaks = breaksOf(p);
              return {
                id: p.id,
                text: p.text + (breaks.length ? `（不成立的訊號：${breaks.join('；')}）` : ''),
                origin: ORIGIN[p.origin] ?? p.origin,
                system: p.origin === 'SYSTEM_DEFAULT',
                silenced: silencedText(meta, p.id, view.date),
                breaksIf: breaks,
                confirmsIf: p.confirmsIf ?? null,
                verify: p.verify ?? null,
                belief: isBelief(p),
              };
            }),
            lastReview: meta.aiTier ? `${meta.aiTier.date}：${TIER_NAME[meta.aiTier.tier]}` : null,
            reviewSkip: reviewSkipOf(meta, view.date),
            thesis: meta.thesis?.text ? { text: meta.thesis.text, setAt: meta.thesis.setAt, source: THESIS_SOURCE[meta.thesis.source] ?? '在網站手寫', version: meta.thesis.version, afterBreak: meta.thesis.afterBreak } : null,
            kind: meta.premises.some((p) => p.origin !== 'SYSTEM_DEFAULT') ? 'THESIS' : 'DEFAULT_ONLY',
            buyNote: meta.buyNote ?? null,
            openNote: openNoteOf(acct, ticker),
            prev: prevFileOf(acct, ticker),
            pendingBreak: pendingBreakOf(acct, ticker),
            pendingBreakName: refNameOf(acct, pendingBreakOf(acct, ticker)?.notif),
            webSources: meta.webSources ?? null,
            draft: d.drafts?.[ticker] ?? null,
          }
        : wmeta
          ? watchOwnOf(d, ticker, wmeta)
          : null,
    watch: wmeta ? { ...watchRowOf(d, ticker, wmeta), max: MAX_WATCH, count: Object.keys(acct.watch ?? {}).length } : null,
    ai: note,
    history: history.slice(0, 30),
    canRemove: !!meta,
    open: openOrdersOf(acct, ticker),
  };
}

// ---------------------------------------------------------------- 快照表單

export interface SnapshotForm {
  priceDate: string;
  rows: { ticker: string; book: number; expected: number; listed: number; where: string }[];
  cashBook: number;
  cashExpected: number;
  /** 已經決定、等成交的清單。date：股數用哪天的收盤價算的；cancel：自己發起的入金／出金／改比例（只能取消，不回去改決定）。 */
  lists: { id: number; title: string; date: string; cancel: boolean }[];
  withdraw: number;
  autofill: Snapshot | null;
  /** 分桶快照（2026-11-15）：每一桶每一檔的帳本股數、清單、照清單做完的股數。 */
  buckets: Record<'own' | 'mom' | 'core', SnapshotRow[]>;
  /** 改版前留下的未分類持股：要填進某一桶。 */
  unc: { ticker: string; shares: number }[];
  coreTickers: string[];
  /** 之前已經記成出金、但券商的現金可能還沒扣掉的金額。 */
  pendingWithdraw: number;
}
export interface SnapshotRow {
  ticker: string;
  book: number;
  listed: number;
  expected: number;
}

export function snapshotForm(d: Ready): SnapshotForm {
  const { acct, view } = d;
  const book = bookShares(acct);
  const delta: Record<string, number> = {};
  let cash = acct.cash;
  let withdraw = 0;
  const lists: SnapshotForm['lists'] = [];
  const fill = d.fill ?? ((t: string) => priceAt(view, t) ?? 0);
  for (const n of acct.notifs) {
    if (n.status !== 'RESPONDED' || !n.composed) continue;
    lists.push({ id: n.id, title: n.title, date: n.date, cancel: !!cashflowKind(n) });
    for (const m of n.composed.merged) {
      delta[m.ticker] = (delta[m.ticker] ?? 0) + m.shares;
      cash -= m.shares * fill(m.ticker);
    }
    if (n.withdraw) {
      withdraw += n.withdraw;
      cash -= n.withdraw;
    }
  }
  const where = (t: string) =>
    (['own', 'mom', 'core', 'unc'] as const)
      .filter((b) => acct.lots[b][t])
      .map((b) => `${BUCKET_NAME[b]} ${acct.lots[b][t]}`)
      .join('、');
  // 分桶：清單的每一行照它的桶加上去
  const per: Record<'own' | 'mom' | 'core', Record<string, number>> = { own: {}, mom: {}, core: {} };
  for (const n of acct.notifs) {
    if (n.status !== 'RESPONDED' || !n.composed) continue;
    for (const m of n.composed.merged) for (const l of m.parts) if (l.shares) per[l.bucket][l.ticker] = (per[l.bucket][l.ticker] ?? 0) + l.shares;
  }
  const coreTickers = [acct.cfg.coreTicker, acct.bondTicker];
  const rowsOf = (b: 'own' | 'mom' | 'core'): SnapshotRow[] => {
    const ts = new Set([...Object.keys(acct.lots[b]).filter((t) => acct.lots[b][t]), ...Object.keys(per[b]), ...(b === 'core' ? [acct.cfg.coreTicker] : [])]);
    return [...ts]
      .map((t) => ({ ticker: t, book: acct.lots[b][t] ?? 0, listed: per[b][t] ?? 0, expected: (acct.lots[b][t] ?? 0) + (per[b][t] ?? 0) }))
      .sort((x, y) => Number(!!y.listed) - Number(!!x.listed) || coreTickers.indexOf(x.ticker) - coreTickers.indexOf(y.ticker) || x.ticker.localeCompare(y.ticker));
  };
  const tickers = [...new Set([...Object.keys(book), ...Object.keys(delta)])].sort((a, b) => Number(!!delta[b]) - Number(!!delta[a]) || a.localeCompare(b));
  return {
    priceDate: view.date,
    rows: tickers.map((t) => ({ ticker: t, book: book[t] ?? 0, expected: (book[t] ?? 0) + (delta[t] ?? 0), listed: delta[t] ?? 0, where: where(t) })),
    cashBook: acct.cash,
    cashExpected: Math.round(cash * 100) / 100,
    lists,
    withdraw,
    autofill: d.autofill ? d.autofill() : null,
    pendingWithdraw: acct.pendingWithdraw ?? 0,
    buckets: { own: rowsOf('own'), mom: rowsOf('mom'), core: rowsOf('core') },
    unc: Object.entries(acct.lots.unc).filter(([, q]) => q).map(([ticker, shares]) => ({ ticker, shares })),
    coreTickers,
  };
}
