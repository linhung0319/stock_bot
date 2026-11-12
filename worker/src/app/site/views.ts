// 把帳戶與通知組成畫面要的資料。這裡只讀不寫。
// 用字原則：不出現功能代號（F1…F25）與權限等級；狀態用一句話寫出「現在怎樣、到哪裡會觸發」。
import {
  SLOW,
  TIER_NAME,
  bookShares,
  bucketValue,
  composeNotif,
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
  type Snapshot,
} from '../../engine';
import type { SiteData } from './backend';
import { coreLineWhy, explainItem, findNote, fmtMoney, fmtPct, fmtPx, fmtSigned, sharesText, type ExplainContext, type ItemX } from './explain';
import { BUCKET_NAME, type AiNote, type Explain, type Gauge, type RankRow } from './types';

type Ready = SiteData & { acct: Account; view: MarketView };

export const ctxOf = (d: Ready): ExplainContext => ({ acct: d.acct, view: d.view, axis: d.axis, rankOrder: d.rankOrder, aiNotes: d.aiNotes });

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
  F25: 'AI 的條件成立',
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
  READ: '已讀',
  SUPERSEDED: '已被新的清單取代',
};

export interface LineView {
  ticker: string;
  bucket: string;
  bucketName: string;
  shares: number;
  /** 用訊號日收盤估的金額（正 = 買）。 */
  amount: number | null;
  reason: string;
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
  actions: { id: string; label: string; hint: string; reasonLabel: string }[];
  explain: Explain;
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
}

export interface NotifView {
  id: number;
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
  ask: { type: 'CLASSIFY'; ticker: string; quantity: number; canMom: boolean } | { type: 'CASH_DIFF'; amount: number } | null;
  respondedAt: string | null;
  /** 這則通知實際成交了什麼（帳本事件）。 */
  filled: { ticker: string; bucketName: string; shares: number; date: string }[];
  deposit: number | null;
  withdraw: number | null;
}

function lineView(view: MarketView, l: OrderLine, acct: Account): LineView {
  const px = priceAt(view, l.ticker);
  return { ticker: l.ticker, bucket: l.bucket, bucketName: BUCKET_NAME[l.bucket], shares: l.shares, amount: px === null ? null : l.shares * px, reason: l.bucket === 'core' ? coreLineWhy(String(l.reason), acct) : String(l.reason) };
}

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

function itemView(d: Ready, n: Notif, it0: Item): ItemView {
  const it = it0 as ItemX;
  const x = it.x ?? explainItem(ctxOf(d), n, it);
  const primary = it.choices.find((c) => c.id !== 'SKIP') ?? it.choices[0];
  const tickers = [...new Set(primary.lines.map((l) => l.ticker))];
  const buckets = [...new Set(primary.lines.map((l) => l.bucket))];
  const bucket = buckets.length === 1 ? buckets[0] : it.kind === 'OWN_RULE' || it.kind === 'AI_ONLY' ? 'own' : buckets.length ? 'mixed' : it.f === 'CORE' ? 'core' : 'own';
  const single = tickers.length <= 1 && !!it.ticker;
  const total = primary.lines.reduce((a, l) => a + l.shares, 0);
  let headline: string;
  if (single && it.ticker) {
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
    label: ITEM_LABEL[it.f] ?? it.f,
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
    actions: (it.actions ?? []).map((a) => ({ id: a, ...ACTIONS[a] })),
    explain: x,
  };
}

export function composedView(d: Ready, n: Notif, c: Composed): ComposedView {
  const orders: OrderView[] = c.merged.map((m) => {
    const px = priceAt(d.view, m.ticker);
    return { ticker: m.ticker, shares: m.shares, transfer: m.shares === 0, price: px, amount: px === null ? null : m.shares * px, parts: m.parts.map((l) => lineView(d.view, l, d.acct)) };
  });
  // 賣的排前面（先賣才有錢買），各自照金額大小
  orders.sort((a, b) => Number(a.shares > 0) - Number(b.shares > 0) || Math.abs(b.amount ?? 0) - Math.abs(a.amount ?? 0));
  return { orders, cashBefore: d.acct.cash, cashAfter: c.cashAfter, withdraw: n.withdraw ?? 0, shortOfCash: c.cashAfter < -1 };
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
    ask = { type: 'CLASSIFY', ticker: n.ticker, quantity: q, canMom: q < 0 ? (d.acct.lots.mom[n.ticker] ?? 0) >= -q : d.acct.rule.heldMom.includes(n.ticker) };
  } else if (n.kind === 'CASH_DIFF') ask = { type: 'CASH_DIFF', amount: n.amount ?? 0 };
  const filled = [...d.events, ...d.acct.events].filter((e) => e.notif === n.id && e.ticker && e.shares).map((e) => ({ ticker: e.ticker!, bucketName: BUCKET_NAME[e.bucket ?? ''] ?? '', shares: e.shares!, date: e.date }));
  return {
    id: n.id,
    kind: n.kind,
    kindLabel: KIND_LABEL[n.kind],
    date: n.date,
    title: n.title,
    text: plainText(n.text),
    status: n.status,
    statusLabel: n.followUpOpen ? '快照和清單不同' : n.status === 'PENDING' && !listLike ? (n.kind === 'INFO' || n.kind === 'MONTHLY_EMPTY' ? '未讀' : '等你回答') : STATUS_LABEL[n.status],
    step: !listLike ? 0 : n.status === 'PENDING' ? 1 : n.status === 'RESPONDED' ? 2 : 0,
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
  };
}

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
  status: { label: string; value: string; tone: 'ok' | 'warn'; detail: string }[];
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
  }
  return { bucket: 'own', ticker: t, shares: sh, price: px, value, pct: value / total, state, detail, tone, gauge, target: rule ? `標準比重 ${fmtPct(rule.stdWeight, 1)}` : null };
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
  if (!inModel) {
    state = '不在動能名單';
    detail = acct.mom.owe[t] ? '上次的出場單沒做，下次月報會再列' : '下次月報會列出場';
    tone = 'alert';
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
  }
  return { bucket: 'mom', ticker: t, shares: sh, price: px, value, pct: value / total, state, detail, tone, gauge, target: inModel ? `每檔目標 ${fmtPct(slot / total, 1)}` : null };
}

function coreHoldings(d: Ready, total: number): HoldingView[] {
  const { acct, view } = d;
  const out: HoldingView[] = [];
  for (const [t, sh] of Object.entries(acct.lots.core)) {
    if (!sh) continue;
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
        target: null,
      });
    } else {
      out.push({ bucket: 'core', ticker: t, shares: sh, price: px, value, pct: value / total, state: '短債', detail: '崩盤規則啟動時，核心的一半放在這裡', tone: 'muted', gauge: null, target: null });
    }
  }
  if (Math.abs(acct.cash) >= 0.005) out.push({ bucket: 'core', ticker: '現金', shares: 0, price: null, value: acct.cash, pct: acct.cash / total, state: '帳上現金', detail: '股利與交易剩下的零頭；月報時交給核心', tone: 'muted', gauge: null, target: null });
  return out;
}

export function rankingView(d: Ready, n = 15): RankRow[] {
  const held = new Set(d.acct.rule.heldMom);
  return d.rankOrder.slice(0, n).map((ticker, k) => {
    const c = d.view.close[ticker];
    const ok = c && Number.isFinite(c[d.view.i]);
    return { rank: k + 1, ticker, ret: ok ? trailingReturn(c, d.view.i) : null, mark: held.has(ticker) ? 'HELD' : d.acct.mom.excluded[ticker] ? 'EXCLUDED' : null };
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
        value: acct.rule.crash ? '啟動中' : '未啟動',
        tone: acct.rule.crash ? 'warn' : 'ok',
        detail: Number.isFinite(rel) ? `${acct.cfg.coreTicker} 收盤${rel >= 0 ? '高於' : '低於'} 200 日均線 ${fmtPct(Math.abs(rel), 1)}。每月第一個交易日判斷一次。` : '每月第一個交易日判斷一次。',
      },
      {
        label: '動能部位',
        value: w === null ? '全額（還沒開始減碼）' : w >= 0.999 ? '全額' : Math.abs(w - 2 / 3) < 0.01 ? '2/3' : Math.abs(w - 1 / 3) < 0.01 ? '1/3' : '0',
        tone: w !== null && w < 0.999 ? 'warn' : 'ok',
        detail: w === null ? '依波動度減碼需要 24 個月的紀錄，累積夠之前維持全額。' : '動能持股比平常震盪時，部位會以 1/3 為單位減少，錢交給核心。',
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
  if (n.status === 'SUPERSEDED') summary = '清單重算過，以新的為準';
  else if (n.status === 'SKIPPED') summary = '整則沒做';
  else if (live.length && n.status !== 'PENDING') summary = `${live.length} 項裡做了 ${did.length} 項${ai ? `（其中 ${ai} 項照 AI）` : ''}`;
  else if (n.note) summary = n.note;
  return { id: n.id, date: n.date, title: n.title, kindLabel: KIND_LABEL[n.kind], status: n.status, statusLabel: n.followUpOpen ? '快照和清單不同' : STATUS_LABEL[n.status], summary };
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
}

export function stateView(d: SiteData): StateView {
  const base = { mode: d.mode, demo: d.demo ?? null, today: d.today, priceDate: d.view?.date ?? null, rankDate: d.rankSession, warnings: d.warnings };
  if (!d.acct || !d.view) return { ...base, hasAccount: !!d.acct, account: null, todo: [], recent: [] };
  const r = d as Ready;
  const order = { ANSWER: 0, TRADE: 1, DECIDE: 2, INFO: 3 };
  const todo = r.acct.notifs
    .map((n) => todoOf(r, n))
    .filter((x): x is TodoView => !!x)
    .sort((a, b) => order[a.type] - order[b.type] || b.id - a.id);
  const open = new Set(todo.map((t) => t.id));
  const recent = r.acct.notifs
    .filter((n) => !open.has(n.id))
    .slice(-5)
    .reverse()
    .map(historyRow);
  return { ...base, hasAccount: true, account: accountView(r), todo, recent };
}

// ---------------------------------------------------------------- 紀錄

export interface HistoryView {
  notifs: HistoryRow[];
  events: { date: string; text: string; notif: number | null }[];
  shadow: { date: string; ticker: string | null; title: string; rule: string; ai: string | null; actual: string; note: string | null }[];
}

const EVENT_TEXT: Record<string, string> = { DEPOSIT: '入金', WITHDRAW: '出金', DIVIDEND: '股利', CASH_OTHER: '其他現金變動', UNCLASSIFIED: '清單外的變動（還沒分類）', CLASSIFIED: '分類', TRANSFER: '桶之間搬動（不用下單）', TRADE: '成交' };

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
        return { date: e.date, text: `${EVENT_TEXT[e.kind] ?? e.kind}：${what}${e.reason ? `（${e.reason}）` : ''}`, notif: e.notif ?? null };
      }),
    shadow: shadow
      .slice(-150)
      .reverse()
      .map((s) => ({ date: s.date, ticker: s.ticker, title: s.title, rule: s.ticker ? sharesText(s.rule) : '', ai: s.ai === null ? null : sharesText(s.ai), actual: s.ticker ? sharesText(s.actual) : '', note: s.note ?? null })),
  };
}

// ---------------------------------------------------------------- 單一持股

export interface HoldingDetail {
  ticker: string;
  date: string;
  price: number | null;
  positions: { bucket: string; bucketName: string; shares: number; value: number; pct: number }[];
  chart: { dates: string[]; close: number[]; ma200: (number | null)[]; halfLine: (number | null)[]; marks: { date: string; label: string }[] } | null;
  facts: { label: string; value: string; note?: string }[];
  own: { state: string; stdWeight: number; premises: { text: string; origin: string }[]; lastReview: string | null } | null;
  ai: AiNote | null;
  history: { date: string; text: string; notif: number | null }[];
  canRemove: boolean;
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
  for (let i = start; i <= end; i++) {
    dates.push(d.axis[i + off] ?? '');
    close.push(Math.round(c[i] * 100) / 100);
    const ma = sma(c, i, 200);
    ma200.push(Number.isFinite(ma) ? Math.round(ma * 100) / 100 : null);
    const hi = rollingMax(c, i, SLOW.highDays);
    halfLine.push(Number.isFinite(hi) ? Math.round(hi * (1 + SLOW.drawdown) * 100) / 100 : null);
  }
  const marks = d.acct.notifs.filter((n) => n.items.some((i) => i.ticker === ticker) && n.date >= dates[0]).map((n) => ({ date: n.date, label: n.title }));
  return { dates, close, ma200, halfLine, marks };
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
            premises: meta.premises.map((p) => ({ text: p.text + (p.breaksIf ? `（不成立的訊號：${p.breaksIf}）` : ''), origin: ORIGIN[p.origin] ?? p.origin })),
            lastReview: meta.aiTier ? `${meta.aiTier.date}：${TIER_NAME[meta.aiTier.tier]}` : null,
          }
        : null,
    ai: note,
    history: history.slice(0, 30),
    canRemove: !!meta,
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
  const tickers = [...new Set([...Object.keys(book), ...Object.keys(delta)])].sort((a, b) => Number(!!delta[b]) - Number(!!delta[a]) || a.localeCompare(b));
  return {
    priceDate: view.date,
    rows: tickers.map((t) => ({ ticker: t, book: book[t] ?? 0, expected: (book[t] ?? 0) + (delta[t] ?? 0), listed: delta[t] ?? 0, where: where(t) })),
    cashBook: acct.cash,
    cashExpected: Math.round(cash * 100) / 100,
    lists,
    withdraw,
    autofill: d.autofill ? d.autofill() : null,
  };
}
