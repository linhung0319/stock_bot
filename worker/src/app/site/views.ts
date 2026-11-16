// 把帳戶與通知組成畫面要的資料。這裡只讀不寫。
// 用字原則：不出現功能代號（F1…F25）與權限等級；狀態用一句話寫出「現在怎樣、到哪裡會觸發」。
import { ENTRY_CODE_TEXT } from '../../ai/momEntry';
import {
  DEFAULT_ONLY_WHY,
  SLOW,
  TIER_NAME,
  CORE_OWE_SNAPSHOT_REASON,
  bookShares,
  bucketValue,
  composeNotif,
  coreContext,
  crashReviewOf,
  coreOweMonth,
  owedCoreLines,
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
  type MarketView,
  type Notif,
  type OrderLine,
  type ShadowRecord,
  type Snapshot,
  cashflowKind,
  notifName,
} from '../../engine';
import { CRASH_REVIEW } from '../../ai/crash';
import { HORIZONS, indexOn, type PriceBook } from '../../ai/shadow';
import type { AiRun } from '../aiRuns';
import type { RunRow } from './aiViews';
import type { SiteData } from './backend';
import { accountBubble, todoBubble, type Bubble } from './bubble';
import { coreLineWhy, crashReasonText, explainItem, findNote, liveCashflow, liveCrash, liveOwnRule, fmtMoney, fmtPct, fmtPx, fmtSigned, sharesText, type ExplainContext, type ItemX } from './explain';
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
  F5: '崩盤規則啟動',
  F6: '崩盤規則解除',
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
};

/**
 * 回覆後整則都沒下單，但每一項本來就是「不動」（規則的選項就是不做，例如乙類預設不動、你選「不同意，不動」）：
 * 這不是「這次不做／沒照規則」（T39a）。回傳要顯示的狀態；不是這種情況回傳 null。
 */
export function keptAsRule(n: Notif): string | null {
  if (n.status !== 'SKIPPED') return null;
  const live = n.items.filter((i) => !i.cancelled);
  if (!live.length || !live.every((i) => i.choice === 'SKIP' && i.ruleChoice === 'SKIP')) return null;
  return live.some((i) => i.brk?.type === 'B') ? '不同意 AI，不動' : '照規則，不動';
}

/** 一則通知的狀態（通知頁與紀錄共用）：提醒與沒有清單的通知沒有「等你決定」（T39a）。 */
function statusLabelOf(n: Notif): string {
  if (n.followUpOpen) return '快照和清單不同';
  const listLike = n.items.length > 0 && n.kind !== 'INFO';
  if (n.status === 'PENDING' && !listLike) return n.kind === 'INFO' || n.kind === 'MONTHLY_EMPTY' ? '未讀' : '等你回答';
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
  /** 乙類、慢規則減半項目上帶「AI 建議出清」的：可以「拿去討論」（複製 BREAK 討論包）。 */
  discuss: boolean;
  /** 慢規則項目上 AI 的那一行（減半：論點檢查的結果；加回：審查認為前提不成立時的建議；own_thesis §3.4）。沒有是 null。 */
  aiLine: string | null;
  /** 慢規則減半項目上 AI 那一行的狀態（PENDING 檢查進行中、HOLD 建議不動、EXIT 建議出清、AGREE 同意減半、NONE 沒有一致結論）；沒有是 null。 */
  drop: string | null;
  /** 乙類用「修正論點」結案的訊號日（這一項同時是取消的，own_thesis §1.10）。 */
  revised: string | null;
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
  attention: { ticker: string; kind: string; text: string; since: string; src: 'own' | 'mom' }[];
  /** 沒有清單的通知（策略檢討提醒）用到的 AI 執行：通知頁連到報告（momentum_ai §3.8）。沒有是 null。 */
  aiRun: string | null;
  /** 提醒指到的那一則通知的名字（日期與種類，不用內部編號；T39a）。沒有是 null。 */
  refName: string | null;
  /** 晚回覆會用當天收盤價重算的自選慢規則項目（那幾檔的代號）；空的 = 不顯示晚回覆的警告（T39a）。 */
  lateReprice: string[];
  /** 回覆後整則沒下單、但每一項本來就是不動（例如乙類你選「不同意，不動」）：那一句狀態；不是是 null（T39a）。 */
  kept: string | null;
}

const isBalance = (l: OrderLine): boolean => l.bucket === 'core' && /^(錢交給核心|從核心拿錢)/.test(String(l.reason));

function lineView(view: MarketView, l: OrderLine, acct: Account): LineView {
  const px = priceAt(view, l.ticker);
  return { ticker: l.ticker, bucket: l.bucket, bucketName: BUCKET_NAME[l.bucket], shares: l.shares, amount: px === null ? null : l.shares * px, reason: l.bucket === 'core' ? coreLineWhy(String(l.reason), acct) : String(l.reason), balance: isBalance(l) };
}

/** 清單本身不用下單、只有帳上原本的現金交給核心時，核心那一行的說明（T39a：乙類預設不動，右邊卻列「買 VOO」看起來像這則要你下單）。 */
const cashOnlyWhy = (core: string): string => `帳上原本就有的現金交給核心買 ${core}。這則通知本身不用下單；這張只是順便把閒著的現金投入核心，不下也可以，下次月報會再列。`;

function linesText(lines: OrderLine[], single: boolean): string {
  if (!lines.length) return '不動';
  if (single) return sharesText(lines.reduce((a, l) => a + l.shares, 0));
  return lines.map((l) => `${l.ticker} ${sharesText(l.shares)}`).join('、');
}

const ACTIONS: Record<string, { label: string; hint: string; reasonLabel: string }> = {
  TRANSFER: { label: '我想留著，轉入自選', hint: '不用下單。這些股數改歸自選桶，之後照自選的慢規則管；動能桶下個月用核心的錢補。「如果照賣」會記在紀錄裡。', reasonLabel: '為什麼想留著（會成為這檔的前提）' },
  EXCLUDE: { label: '排除這一檔', hint: '不買這一檔，改由排名下一名遞補，清單會重算。排除一直有效，可以在「帳戶」取消。「如果沒排除」會記在紀錄裡。', reasonLabel: '為什麼排除' },
  ADOPT: { label: '我也看好，認養到自選', hint: '照常買進，但記在自選桶。之後動能就算把它排除也不會叫你賣；動能那一格下個月再遞補。', reasonLabel: '為什麼看好（會成為這檔的前提）' },
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
      say = `比高點低 ${pctTxt(g.value)}，超過 20% → 這次賣一半，${n0} 股`;
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
      say = hit ? `已經比高點低 ${pctTxt(g.value)}（超過 20%）→ 先買標準比重的一半，${n0} 股` : `比高點低 ${pctTxt(g.value)}，還沒到減半的範圍 → 買到標準比重，${n0} 股`;
      break;
    }
    case 'F23': {
      zone = '可提高';
      kind = 'go';
      const months = Math.floor(g.value / 21);
      capText = '連續站在 200 日均線之上的天數（滿 6 個月才可以提高）';
      say = g.value >= sc.th ? `已連續站上 200 日均線約 ${months} 個月，滿 6 個月了 → AI 建議${total > 0 ? `買 ${n0} 股` : ''}（預設不做）` : `連續站上 200 日均線約 ${months} 個月，還不到 6 個月 → 這次不適合提高`;
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
    if (c.id === 'AI' && c.tier && !/（/.test(label)) label = `照 AI：${it.aiLine?.includes('維持減半') ? '維持減半' : TIER_NAME[c.tier]}`;
    return {
      id: c.id,
      label,
      text: c.id === 'SKIP' ? '不下單' : linesText(c.lines, single),
      lines: c.lines.map((l) => lineView(d.view, l, d.acct)),
      note: x.choiceNotes?.[c.id] ?? '',
      isDefault: c.id === it.ruleChoice,
    };
  });
  return {
    key: it.key,
    label: it.relist ? '上次沒做，再列一次' : it.f === 'F25' && it.kind !== 'OWN_COND' ? 'AI 的條件成立' : it.brk?.type === 'B' && !it.brk.withRule ? 'AI 判斷前提不成立' : (ITEM_LABEL[it.f] ?? it.f),
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
    discuss: it.brk?.type === 'B' && !!it.ticker && !!d.acct.own[it.ticker],
    // 只有預設前提的股票：那一行後面接「這檔還沒有你的論點，AI 只檢查系統預設前提。」（引擎寫在這一項的理由裡）
    aiLine: (it.kind === 'OWN_RULE' || it.lateVeto) && it.aiLine ? `${it.aiLine}${it.why?.includes(DEFAULT_ONLY_WHY) ? `。${DEFAULT_ONLY_WHY}` : ''}` : null,
    drop: it.drop ?? null,
    revised: it.revised ?? null,
  };
}

export function composedView(d: Ready, n: Notif, c: Composed): ComposedView {
  const cashOnly = c.merged.every((m) => m.parts.every((l) => isBalance(l) && l.shares > 0));
  const orders: OrderView[] = c.merged.map((m) => {
    const px = priceAt(d.view, m.ticker);
    const parts = m.parts.map((l) => lineView(d.view, l, d.acct));
    return { ticker: m.ticker, shares: m.shares, transfer: m.shares === 0, price: px, amount: px === null ? null : m.shares * px, parts: cashOnly ? parts.map((p) => ({ ...p, reason: cashOnlyWhy(d.acct.cfg.coreTicker) })) : parts };
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
const ITEM_ORDER = ['F5', 'F6', 'F19', 'F2', 'F1', 'F17', 'F3', 'F4', 'F10', 'F7', 'F8', 'F25', 'F24', 'F23', 'F11', 'F12', 'F13', 'F14', 'F15', 'CORE'];
const orderOf = (f: string) => {
  const k = ITEM_ORDER.indexOf(f);
  return k < 0 ? ITEM_ORDER.length : k;
};

/** 月報上那一行狀態，換成白話。 */
function plainText(t: string | undefined): string | null {
  if (!t) return null;
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
  };
}

const refNameOf = (acct: Account, id: number | null | undefined): string | null => {
  const r = id ? acct.notifs.find((x) => x.id === id) : undefined;
  return r ? notifName(r) : null;
};

// ---------------------------------------------------------------- 待辦

export interface TodoView {
  id: number;
  /** ANSWER 要你回答；TRADE 已決定、等下單與快照；DECIDE 等你決定；INFO 提醒。 */
  type: 'ANSWER' | 'TRADE' | 'DECIDE' | 'INFO';
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
    type: 'DECIDE',
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
  status: { label: string; value: string; tone: 'ok' | 'warn'; detail: string; meter?: Meter | null; cells?: number }[];
  holdings: HoldingView[];
  unclassified: { ticker: string; shares: number }[];
  excluded: { ticker: string; reason: string; date: string }[];
  adopted: { ticker: string; reason: string; date: string }[];
  ranking: RankRow[];
  ownTickers: string[];
  monthlyBlocked: boolean;
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
    } else if (rule.applied === 'HALF') {
      state = '減半中';
      const run = meta.slow.aboveRun;
      detail = px > ma ? `站上 200 日均線 ${Math.min(run, SLOW.aboveRun)}/${SLOW.aboveRun} 天，滿了就買回標準比重` : `收盤低於 200 日均線 ${fmtPct(1 - px / ma, 1)}；站回去連續 ${SLOW.aboveRun} 天才買回`;
      tone = 'warn';
    } else {
      state = '正常';
      detail = `比 52 週高點低 ${fmtPct(-dd, 1)}；低 20% 會減半`;
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
    } else if (gauge) {
      const hit = meta.pending ? meta.pending.action === 'REDUCE' : dd <= SLOW.drawdown;
      met = meter({ ...scaleOf(gauge)!, hit }, { zone: '減半', label: `比 52 週高點低 ${fmtPct(-dd, 1)}；低 20% 會減半` });
    }
  }
  return { bucket: 'own', ticker: t, shares: sh, price: px, value, pct: value / total, state, detail, tone, gauge, meter: met, target: rule ? `標準比重 ${fmtPct(rule.stdWeight, 1)}` : null };
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

/** 崩盤規則的門檻條：沒啟動時看「跌破 200 日均線就啟動」，啟動中看「站回均線之上就解除」。 */
function crashMeter(acct: Account, rel: number): Meter | null {
  if (!Number.isFinite(rel)) return null;
  const span = Math.max(0.1, Math.ceil(Math.abs(rel) * 20) / 20 + 0.05);
  const core = acct.cfg.coreTicker;
  if (acct.rule.crash) return meter({ start: -span, th: 0, end: span / 3, value: rel, hit: rel > 0 }, { zone: '解除', kind: 'go', label: `${core} 收盤${rel >= 0 ? '高於' : '低於'} 200 日均線 ${fmtPct(Math.abs(rel), 1)}；月報日站回均線之上會解除崩盤規則` });
  return meter({ start: span, th: 0, end: -span / 3, value: rel, hit: rel < 0 }, { zone: '啟動', label: `${core} 收盤${rel >= 0 ? '高於' : '低於'} 200 日均線 ${fmtPct(Math.abs(rel), 1)}；月報日跌破均線會啟動崩盤規則` });
}

/**
 * 崩盤項目選了「這次不做」、核心還沒換時，狀態後面加的那一句（core_ai §3.6，狀態要是真的）：
 * `（核心還沒換：你 2027-01 選了這次不做）`／`（短債還沒換回：…）`。用現在的持股重算一次，已經沒有要動的（例如自己補做了）就不寫。
 */
export function coreOweText(d: Ready): string {
  const owe = d.acct.coreOwe;
  if (!owe || d.acct.rule.crash !== (owe.direction === 'ON')) return '';
  try {
    if (!owedCoreLines(coreContext(d.acct, d.view), owe.direction).length) return '';
  } catch {
    // 缺價格：照記下的寫
  }
  const what = owe.direction === 'ON' ? '核心還沒換' : '短債還沒換回';
  const month = coreOweMonth(d.acct, owe);
  return owe.reason === CORE_OWE_SNAPSHOT_REASON ? `（${what}：${month} 月報的單快照顯示沒有做）` : `（${what}：你 ${month} 選了這次不做）`;
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
      const c = view.close[t];
      const ma = c ? sma(c, view.i, 200) : NaN;
      const rel = px === null ? NaN : px / ma - 1;
      const span = Math.max(0.15, Math.ceil(Math.abs(rel) * 20) / 20 + 0.05);
      out.push({
        bucket: 'core',
        ticker: t,
        shares: sh,
        price: px,
        value,
        pct: value / total,
        state: acct.rule.crash ? '崩盤規則啟動中' : '正常',
        detail: Number.isFinite(rel) ? `收盤${rel >= 0 ? '高於' : '低於'} 200 日均線 ${fmtPct(Math.abs(rel), 1)}；月報日低於均線會啟動崩盤規則` : '',
        tone: acct.rule.crash ? 'alert' : rel < 0.03 ? 'warn' : 'ok',
        gauge: Number.isFinite(rel) ? { from: -span, to: span, fromLabel: fmtSigned(-span), toLabel: fmtSigned(span), value: rel, valueLabel: fmtSigned(rel, 1), marks: [{ at: 0, label: '200 日均線' }], zones: [{ from: -span, to: 0 }], caption: '收盤相對 200 日均線' } : null,
        meter: crashMeter(acct, rel),
        target: null,
      });
    } else {
      out.push({ bucket: 'core', ticker: t, shares: sh, price: px, value, pct: value / total, state: '短債', detail: '崩盤規則啟動時，核心的一半放在這裡', tone: 'muted', gauge: null, meter: null, target: null });
    }
  }
  out.push({ bucket: 'core', ticker: '現金', shares: 0, price: null, value: acct.cash, pct: acct.cash / total, state: '帳上現金', detail: acct.pendingWithdraw ? `出金 ${fmtMoney(acct.pendingWithdraw)} 還沒從券商轉出：券商現在會多顯示這筆` : '股利與交易剩下的零頭；月報時交給核心', tone: 'muted', gauge: null, meter: null, target: null });
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
  const corePx = priceAt(view, acct.cfg.coreTicker);
  const coreC = view.close[acct.cfg.coreTicker];
  const rel = corePx !== null && coreC ? corePx / sma(coreC, view.i, 200) - 1 : NaN;
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
      { id: 'core', name: '核心', value: bv.core, pct: bv.core / total, budget: r.core, who: `${acct.cfg.coreTicker}；其他兩桶減下來的錢都回到這裡` },
    ],
    status: [
      {
        label: '崩盤規則',
        value: (acct.rule.crash ? '啟動中' : '未啟動') + coreOweText(d),
        tone: acct.rule.crash || coreOweText(d) ? 'warn' : 'ok',
        detail: Number.isFinite(rel) ? `${acct.cfg.coreTicker} 收盤${rel >= 0 ? '高於' : '低於'} 200 日均線 ${fmtPct(Math.abs(rel), 1)}。每月第一個交易日判斷一次。` : '每月第一個交易日判斷一次。',
        meter: crashMeter(acct, rel),
      },
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
  if (n.status === 'SUPERSEDED') summary = '清單重算過，以新的為準';
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
  recent: HistoryRow[];
  /** 史萊姆在待辦頁、帳戶頁說的話。 */
  bubble: { todo: Bubble; account: Bubble | null };
  /** 可以復原的快照（設計 §10 第 39 點）。 */
  undo: { date: string; at: string; cashOther: number; cashWarn: boolean } | null;
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
  if (!d.acct || !d.view) return { ...base, hasAccount: !!d.acct, account: null, todo: [], recent: [], bubble: { todo: { k: '開始', say: [d.acct ? '帳戶在，但還沒有可用的價格資料。' : '還沒有帳戶。填一次券商裡現在的持股，我就從那裡開始記帳。'], mood: 'idle' }, account: null } };
  const r = d as Ready;
  const order = { ANSWER: 0, TRADE: 1, DECIDE: 2, INFO: 3 };
  const byId = new Map(r.acct.notifs.map((n) => [n.id, n]));
  const todo = r.acct.notifs
    .map((n) => todoOf(r, n))
    .filter((x): x is TodoView => !!x)
    .sort((a, b) => order[a.type] - order[b.type] || (a.type === 'DECIDE' && b.type === 'DECIDE' ? decideRank(byId.get(a.id)!) - decideRank(byId.get(b.id)!) || a.id - b.id : b.id - a.id));
  const open = new Set(todo.map((t) => t.id));
  const recent = r.acct.notifs
    .filter((n) => !open.has(n.id))
    .slice(-5)
    .reverse()
    .map(historyRow);
  const account = accountView(r);
  const first = todo[0];
  const firstN = first?.type === 'DECIDE' ? r.acct.notifs.find((n) => n.id === first.id) : undefined;
  const plan = firstN ? notifView(r, firstN) : null;
  return { ...base, hasAccount: true, account, todo, recent, bubble: { todo: todoBubble(todo, plan), account: accountBubble(account) } };
}

// ---------------------------------------------------------------- 紀錄

export interface HistoryView {
  notifs: HistoryRow[];
  events: { date: string; text: string; notif: number | null }[];
  shadow: { date: string; ticker: string | null; title: string; rule: string; ai: string | null; actual: string; note: string | null }[];
}

const EVENT_TEXT: Record<string, string> = { DEPOSIT: '入金', WITHDRAW: '出金', DIVIDEND: '股利', CASH_OTHER: '其他現金變動', UNCLASSIFIED: '清單外的變動（還沒分類）', CLASSIFIED: '分類', TRANSFER: '桶之間搬動（不用下單）', TRADE: '成交' };

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
        const why = e.reason ? eventReason(e.reason, d.acct) : '';
        return { date: e.date, text: `${EVENT_TEXT[e.kind] ?? e.kind}：${what}${why ? `（${why}）` : ''}`, notif: e.notif ?? null };
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

/** 2000–2026 的固定文字（和崩盤項目上的那一列相同的數字）。 */
export const CRASH_BASE_TEXT = '2000–2026 崩盤規則啟動 17 次，3 次是真的空頭（買回時便宜 13～34%）；13 次買回時更貴（+2～+14%），多付的那幾次就是保險費。';

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
  return { head: sw.length ? `崩盤規則切換過 ${sw.length} 次；AI 說延後 ${delays.length} 次，其中 ${better.length} 次延後一個月比較好。` : '還沒有紀錄', rows };
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
  chart: { dates: string[]; close: number[]; ma200: (number | null)[]; halfLine: (number | null)[]; marks: { date: string; label: string }[] } | null;
  facts: { label: string; value: string; note?: string }[];
  own: {
    state: string;
    stdWeight: number;
    /** id：前提的編號；system：系統預設前提。 */
    /** silenced：這條前提在靜默期內的那一句（own_thesis §1.10；不在是 null）。 */
    premises: { id: string; text: string; origin: string; system: boolean; silenced: string | null }[];
    lastReview: string | null;
    /** 月底檢查點沒有新證據、沒審的那一句（own_thesis §3.7）；之後有新的審查就不顯示。 */
    reviewSkip: string | null;
    /** 論點本文（還沒寫是 null）；afterBreak：失效後修改幾次。 */
    thesis: { text: string; setAt: string; source: string; version: number; afterBreak: number } | null;
    /** 有論點／只有預設（系統預設前提）。 */
    kind: 'THESIS' | 'DEFAULT_ONLY';
    /** 開檔時就是減半、還沒加回過（own_thesis §3.8）的那一句。 */
    openNote: string | null;
    /** 還沒回覆、建議這檔照 AI 調整的通知（編輯論點頁的「這是對通知 #N 的回應」）。 */
    pendingBreak: { notif: number; tier: string | null; premiseId: string | null } | null;
    /** 那則通知的名字（日期與種類，不用內部編號；T39a）。 */
    pendingBreakName: string | null;
  } | null;
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

const ORIGIN: Record<string, string> = { USER: '你寫的', AI_DRAFT_ACCEPTED: 'AI 草擬、你勾選的', SYSTEM_DEFAULT: '系統預設' };

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
  return { dates, close, ma200, halfLine, marks };
}

/**
 * 開檔時就是減半、還沒加回過的股票（own_thesis §3.8）：大跌之後買進，價格的底線已經用掉了。
 * 「還沒加回過」= 現在還是減半，而且開檔之後沒有這檔的加回單（F8）。
 */
function openNoteOf(acct: Account, ticker: string): string | null {
  const meta = acct.own[ticker];
  const o = meta?.opened;
  if (!meta || o?.startState !== 'HALF' || acct.rule.own[ticker]?.applied !== 'HALF') return null;
  const since = meta.fileId?.slice(ticker.length + 1, ticker.length + 11) ?? '';
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
  const note = findNote(d.aiNotes, 'REVIEW', ticker, view.date) ?? null;
  const events = [...d.events, ...acct.events].filter((e) => e.ticker === ticker);
  const history = [
    ...acct.notifs.filter((n) => n.items.some((i) => i.ticker === ticker) || n.ticker === ticker).map((n) => ({ date: n.date, text: `${KIND_LABEL[n.kind]}：${n.items.find((i) => i.ticker === ticker)?.title ?? n.title}`, notif: n.id as number | null })),
    ...events.map((e) => ({ date: e.date, text: `${EVENT_TEXT[e.kind] ?? e.kind}：${BUCKET_NAME[e.bucket ?? ''] ?? ''} ${e.shares !== undefined ? (e.shares > 0 ? '+' : '') + e.shares + ' 股' : ''}`, notif: null as number | null })),
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
            state: rule.applied === 'HALF' ? '減半中' : '正常',
            stdWeight: rule.stdWeight,
            premises: meta.premises.map((p) => ({ id: p.id, text: p.text + (p.breaksIf ? `（不成立的訊號：${p.breaksIf}）` : ''), origin: ORIGIN[p.origin] ?? p.origin, system: p.origin === 'SYSTEM_DEFAULT', silenced: silencedText(meta, p.id, view.date) })),
            lastReview: meta.aiTier ? `${meta.aiTier.date}：${TIER_NAME[meta.aiTier.tier]}` : null,
            reviewSkip: reviewSkipOf(meta, view.date),
            thesis: meta.thesis?.text ? { text: meta.thesis.text, setAt: meta.thesis.setAt, source: meta.thesis.source === 'DISCUSSION' ? '討論後貼回' : '在網站手寫', version: meta.thesis.version, afterBreak: meta.thesis.afterBreak } : null,
            kind: meta.premises.some((p) => p.origin !== 'SYSTEM_DEFAULT') ? 'THESIS' : 'DEFAULT_ONLY',
            openNote: openNoteOf(acct, ticker),
            pendingBreak: pendingBreakOf(acct, ticker),
            pendingBreakName: refNameOf(acct, pendingBreakOf(acct, ticker)?.notif),
          }
        : null,
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
  /** 已經決定、等成交的清單。 */
  lists: { id: number; title: string }[];
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
    lists.push({ id: n.id, title: n.title });
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
