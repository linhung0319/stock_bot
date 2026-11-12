// 每一項建議的「為什麼」：用訊號日的價格、排名與帳戶狀態，寫成帶數字的理由。
// 通知產生的當下算好，存在通知裡（item.x），之後價格變了理由也不會跟著變。
// 引擎不知道這個欄位（它只會原樣帶著走）；讀通知時發現沒有，就用當下的資料補算。
import {
  SLOW,
  TIER_NAME,
  annualizedVol,
  drawdownFromHigh,
  momSlotTarget,
  rollingMax,
  sma,
  totalValue,
  trailingReturn,
  type Account,
  type Item,
  type MarketView,
  type Notif,
  type OrderLine,
} from '../../engine';
import { BUCKET_NAME, type AiNote, type Explain, type Fact, type Gauge, type RankRow } from './types';

export interface ExplainContext {
  acct: Account;
  view: MarketView;
  /** 交易日（由舊到新，最後一個是訊號日）；用來找「幾月幾日觸發」那一天的價格。 */
  axis: string[];
  /** 最近一次的排名（月報以月報自己的排名為準）。 */
  rankOrder: string[];
  aiNotes: AiNote[];
}

export type ItemX = Item & { x?: Explain };

// ---------------------------------------------------------------- 格式

export const fmtPct = (x: number, d = 0): string => (Number.isFinite(x) ? `${(x * 100).toFixed(d)}%` : '—');
export const fmtSigned = (x: number, d = 0): string => (Number.isFinite(x) ? `${x > 0 ? '+' : ''}${(x * 100).toFixed(d)}%` : '—');
export const fmtMoney = (x: number): string => (Number.isFinite(x) ? `$${Math.round(x).toLocaleString('en-US')}` : '—');
export const fmtPx = (x: number): string => (Number.isFinite(x) ? `$${x.toFixed(2)}` : '—');
const md = (date: string): string => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
const thirds = (w: number | null): string => (w === null || w >= 0.999 ? '全額' : Math.abs(w - 2 / 3) < 0.01 ? '2/3' : Math.abs(w - 1 / 3) < 0.01 ? '1/3' : '0');

const sharesOf = (lines: OrderLine[], ticker?: string): number => lines.filter((l) => !ticker || l.ticker === ticker).reduce((a, l) => a + l.shares, 0);
export const sharesText = (n: number): string => (n < 0 ? `賣 ${-n} 股` : n > 0 ? `買 ${n} 股` : '不動');

function closeOf(view: MarketView, ticker: string): ArrayLike<number> | null {
  const c = view.close[ticker];
  return c && Number.isFinite(c[view.i]) ? c : null;
}

/** 訊號日以前最新的一份 AI 說明。 */
export function findNote(notes: AiNote[], kind: AiNote['kind'], ticker: string | undefined, date: string): AiNote | undefined {
  let best: AiNote | undefined;
  for (const n of notes) {
    if (n.kind !== kind || (ticker && n.ticker !== ticker) || n.date > date) continue;
    if (!best || n.date > best.date) best = n;
  }
  return best;
}

// ---------------------------------------------------------------- 規則的白話文

const RULE = {
  momentum: '每月第一個交易日看排名：S&P 500 裡市值前 50 大的股票，照過去 252 個交易日（約一年）的報酬由高到低排。買前 5 名；已經持有的要掉出前 15 名才賣。',
  lazy: '動能 5 檔各占一格。留任的股票只有在偏離目標超過 ±50% 時才調回，而且只在那個月本來就有其他單的時候順便做，不會只為了比例叫你下單。',
  vol: '每月比較動能持股最近半年相對大盤的波動（σ）和它的歷史中位數（σ̃）：部位 = σ̃ ÷ σ，最多全額，無條件捨去到 1/3 的倍數。要多跨過 0.10 才換一格，避免來回。減下來的錢交給核心。',
  crash: '每月第一個交易日看核心 ETF 前一日的收盤：低於 200 日均線 → 核心一半換成短債、動能部位減半；回到均線之上 → 換回來。全系統只有這條規則會讓錢變成現金。',
  slow: '自選股的慢規則是保險，不是看壞：收盤比 52 週高點低 20% 以上 → 賣掉當時持有股數的一半；之後收盤站上 200 日均線連續 10 天、距上次切換滿 15 個交易日 → 買回到標準比重。',
  cap: '任何一檔自選股超過總資產 15% → 減回 10%。同一檔在自選和動能都有時，合計超過 15% 也減回 10%，先減動能那部分。',
  deposit: '入金只買不賣：用入金後的總資產算每一格的目標，依序補「低於目標最多」的格子；缺口小於總資產 0.25% 的不補；剩下的交給核心。',
  withdraw: '出金只賣不買。先檢查單檔上限（出金後會超過 15% 的自選股先減回 10%，賣得的錢抵出金），不夠的再依序從：核心的現金 → 動能高於目標的部分 → 核心 ETF → 動能 → 最後才是自選。',
  ratio: '三桶的比例是風險預算，不是要維持的目標。平常不會為了拉回比例下單；只有你改比例的時候，當天給一份清單。',
  addOwn: '自選股由你決定買不買。系統只建議比重（自選預算內，波動越大的比重越小），錢從核心出。如果這檔現在已經比 52 週高點低 20% 以上，一開始只買一半。',
  ai: 'AI 只能從固定的檔位選一個（出清／減半／不動／回到標準／提高到 125%），股數由程式換算。AI 的建議永遠和規則並列，你沒選就照規則。',
};

const SKIP = {
  strategy: '這是策略本身的單。這次不做，下個月月報會把差額再列一次。',
  own: '規則照樣記成已切換，之後不再提醒，直到下一次狀態改變。差異記在紀錄裡。',
  ai: 'AI 的建議是一次性的。不做就不再提醒，差異記在紀錄裡。',
};

// ---------------------------------------------------------------- 門檻尺

function rankGauge(rank: number | null, threshold: number, caption: string): Gauge | undefined {
  if (rank === null) return undefined;
  const to = Math.max(20, Math.min(50, rank + 3));
  return {
    from: 1,
    to,
    fromLabel: '第 1 名',
    toLabel: `第 ${to} 名`,
    value: rank,
    valueLabel: `第 ${rank} 名`,
    marks: [{ at: threshold, label: `前 ${threshold} 名` }],
    zones: threshold === 5 ? [{ from: 1, to: 5 }] : [{ from: threshold, to }],
    caption,
  };
}

function drawdownGauge(dd: number): Gauge {
  const from = Math.min(-0.4, Math.floor(dd * 10) / 10 - 0.05);
  return {
    from,
    to: 0,
    fromLabel: fmtPct(from),
    toLabel: '52 週高點',
    value: dd,
    valueLabel: fmtPct(dd, 1),
    marks: [{ at: SLOW.drawdown, label: '−20% 減半' }],
    zones: [{ from, to: SLOW.drawdown }],
    caption: '收盤距 52 週高點',
  };
}

function maGauge(rel: number, label: string, zoneBelow: boolean): Gauge {
  const span = Math.max(0.15, Math.ceil(Math.abs(rel) * 20) / 20 + 0.05);
  return {
    from: -span,
    to: span,
    fromLabel: fmtSigned(-span),
    toLabel: fmtSigned(span),
    value: rel,
    valueLabel: fmtSigned(rel, 1),
    marks: [{ at: 0, label: '200 日均線' }],
    zones: [zoneBelow ? { from: -span, to: 0 } : { from: 0, to: span }],
    caption: label,
  };
}

function weightGauge(w: number, hi: number, to10: number): Gauge {
  const top = Math.max(0.25, Math.ceil(w * 20) / 20 + 0.05);
  return {
    from: 0,
    to: top,
    fromLabel: '0%',
    toLabel: fmtPct(top),
    value: w,
    valueLabel: fmtPct(w, 1),
    marks: [
      { at: to10, label: `減回 ${fmtPct(to10)}` },
      { at: hi, label: `上限 ${fmtPct(hi)}` },
    ],
    zones: [{ from: hi, to: top }],
    caption: '占總資產',
  };
}

// ---------------------------------------------------------------- 排名表

function rankingTable(ctx: ExplainContext, order: string[], n: Notif, focus: string[]): RankRow[] {
  const { acct, view } = ctx;
  const before = n.monthly?.before.rule.heldMom ?? acct.rule.heldMom;
  const after = new Set(acct.rule.heldMom);
  const vetoed = new Set(n.monthly?.input.vetoed ?? []);
  const rows: RankRow[] = [];
  const show = Math.max(15, ...focus.map((t) => order.indexOf(t) + 1));
  order.slice(0, Math.min(order.length, show)).forEach((ticker, k) => {
    const c = closeOf(view, ticker);
    const held = before.includes(ticker);
    let mark: RankRow['mark'] = null;
    if (vetoed.has(ticker)) mark = 'VETO';
    else if (acct.mom.excluded[ticker]) mark = 'EXCLUDED';
    else if (held && after.has(ticker)) mark = 'HELD';
    else if (held) mark = 'OUT';
    else if (after.has(ticker)) mark = 'IN';
    rows.push({ rank: k + 1, ticker, ret: c ? trailingReturn(c, view.i) : null, mark });
  });
  return rows;
}

// ---------------------------------------------------------------- 各種項目

function slotMath(ctx: ExplainContext, ticker: string, shares: number): { math: string[]; slot: number } {
  const { acct, view } = ctx;
  const total = totalValue(acct, view);
  const eff = acct.rule.effPrev ?? 1;
  const slot = momSlotTarget(acct.cfg, total, eff);
  const c = closeOf(view, ticker);
  const px = c ? c[view.i] : NaN;
  const math = [
    `每檔目標 = 總資產 ${fmtMoney(total)} × 動能預算 ${fmtPct(acct.cfg.ratio.strat)}${eff < 0.999 ? ` × 目前比例 ${fmtPct(eff)}` : ''} ÷ ${acct.cfg.momSlots} 檔 = ${fmtMoney(slot)}`,
    `${fmtMoney(slot)} ÷ 前一日收盤 ${fmtPx(px)} = ${Math.abs(shares)} 股（買進無條件捨去到整股）`,
  ];
  return { math, slot };
}

function momEntry(ctx: ExplainContext, n: Notif, it: Item): Explain {
  const { acct, view } = ctx;
  const t = it.ticker!;
  const order = n.monthly?.input.order ?? ctx.rankOrder;
  const idx = order.indexOf(t);
  const rank = idx >= 0 ? idx + 1 : null;
  const c = closeOf(view, t);
  const ret = c ? trailingReturn(c, view.i) : NaN;
  const sh = sharesOf(it.choices[0].lines, t);
  const vetoed = (n.monthly?.input.vetoed ?? []).filter((v) => order.indexOf(v) >= 0 && (idx < 0 || order.indexOf(v) < idx));
  const excluded = Object.keys(acct.mom.excluded).filter((v) => order.indexOf(v) >= 0 && (idx < 0 || order.indexOf(v) < idx));
  let why = rank ? `${t} 過去一年漲 ${fmtSigned(ret)}，在 50 檔大型股裡排第 ${rank}。動能規則買前 5 名，這個月有空位，所以進場。` : `${t} 在這個月的動能名單上，目前還沒持有。`;
  if (rank && rank > acct.cfg.momSlots) why = `${t} 過去一年漲 ${fmtSigned(ret)}，排第 ${rank}。排在前面的不是已經持有，就是不能買，所以輪到它遞補。`;
  if (vetoed.length) why += `排在它前面的 ${vetoed.join('、')} 這個月被 AI 否決，由下一名遞補。`;
  if (excluded.length) why += `你排除了排在前面的 ${excluded.join('、')}。`;
  const { math } = slotMath(ctx, t, sh);
  const veto = vetoed.length ? findNote(ctx.aiNotes, 'VETO', vetoed[0], n.date) : undefined;
  const facts: Fact[] = [];
  const ownVal = (acct.lots.own[t] ?? 0) * (c ? c[view.i] : 0);
  if (ownVal > 0) facts.push({ label: '自選已經持有', value: fmtMoney(ownVal), note: `同一檔合計最多買到總資產 ${fmtPct(acct.cfg.crossCapBuy ?? 0.1)}，被擋下的部分留在核心` });
  return {
    short: rank ? `一年報酬排第 ${rank}${vetoed.length ? `，${vetoed.join('、')} 被否決後遞補` : ''}` : '在動能名單上',
    why,
    gauge: rankGauge(rank, acct.cfg.momSlots, '一年報酬排名（越左邊越強）'),
    rule: RULE.momentum,
    facts: facts.length ? facts : undefined,
    math,
    ranking: rankingTable(ctx, order, n, [t]),
    chart: t,
    ai: veto,
    aiMissing: vetoed.length > 0 && !veto,
    choiceNotes: { DO: '照動能清單買進，記在動能桶；之後由動能規則決定什麼時候賣。', SKIP: `${SKIP.strategy}真的不想買這一檔，選「排除」，系統會改買下一名。` },
  };
}

function momExit(ctx: ExplainContext, n: Notif, it: Item): Explain {
  const { acct, view } = ctx;
  const t = it.ticker!;
  const order = n.monthly?.input.order ?? ctx.rankOrder;
  const idx = order.indexOf(t);
  const rank = idx >= 0 ? idx + 1 : null;
  const c = closeOf(view, t);
  const ret = c ? trailingReturn(c, view.i) : NaN;
  const sh = -sharesOf(it.choices[0].lines, t);
  const redo = /沒照做/.test(it.title);
  let why: string;
  let short: string;
  if (redo) {
    why = `${t} 已經不在動能名單上，上次的出場單沒有做，所以這個月再列一次${rank ? `（目前排第 ${rank}）` : ''}。`;
    short = '已不在動能名單，上次沒賣';
  } else if (rank === null) {
    why = `${t} 掉出 50 檔股票池（市值或成交金額不夠大了），動能規則不再持有它。`;
    short = '掉出 50 檔股票池';
  } else {
    why = `${t} 過去一年的報酬（${fmtSigned(ret)}）排名掉到第 ${rank}。動能規則：持股掉出前 ${acct.cfg.exitRank} 名就全部賣出，換成排名更前面的股票。`;
    short = `一年報酬排名掉到第 ${rank}，門檻是前 ${acct.cfg.exitRank}`;
  }
  return {
    short,
    why,
    gauge: rankGauge(rank, acct.cfg.exitRank, '一年報酬排名（越左邊越強）'),
    rule: RULE.momentum,
    math: [`動能桶持有 ${sh} 股 → 全部賣出`],
    ranking: rankingTable(ctx, order, n, [t]),
    chart: t,
    choiceNotes: { DO: '賣出的錢先回核心，再由這個月新進場的股票買走。', SKIP: `${SKIP.strategy}想留著的話，選「我想留著」把它轉入自選：不用下單，之後照自選的規則管。` },
  };
}

function momRebalance(ctx: ExplainContext, _n: Notif, it: Item): Explain {
  const { acct, view } = ctx;
  const t = it.ticker!;
  const c = closeOf(view, t);
  const px = c ? c[view.i] : NaN;
  const sh = sharesOf(it.choices[0].lines, t);
  const cur = (acct.lots.mom[t] ?? 0) * px;
  const slot = momSlotTarget(acct.cfg, totalValue(acct, view), acct.rule.effPrev ?? 1);
  const rel = cur / slot;
  const band = acct.cfg.lazyBand ?? 0.5;
  const top = Math.max(2.2, Math.ceil(rel * 5) / 5 + 0.2);
  return {
    short: `占每檔目標的 ${fmtPct(rel)}，超過 ±${fmtPct(band)}`,
    why: `${t} 現在的市值是動能每檔目標的 ${fmtPct(rel)}（${fmtMoney(cur)} 對 ${fmtMoney(slot)}），偏離超過 ±${fmtPct(band)}。這個月本來就有其他單，順便${sh < 0 ? '賣掉多出來的' : '補足不夠的'}部分。`,
    gauge: {
      from: 0,
      to: top,
      fromLabel: '0%',
      toLabel: fmtPct(top),
      value: rel,
      valueLabel: fmtPct(rel),
      marks: [
        { at: 1 - band, label: fmtPct(1 - band) },
        { at: 1, label: '目標' },
        { at: 1 + band, label: fmtPct(1 + band) },
      ],
      zones: [
        { from: 0, to: 1 - band },
        { from: 1 + band, to: top },
      ],
      caption: '市值 ÷ 每檔目標',
    },
    rule: RULE.lazy,
    math: [`每檔目標 ${fmtMoney(slot)}，目前 ${fmtMoney(cur)}，差 ${fmtMoney(Math.abs(cur - slot))}`, `${fmtMoney(Math.abs(cur - slot))} ÷ 前一日收盤 ${fmtPx(px)} ≈ ${Math.abs(sh)} 股`],
    chart: t,
    choiceNotes: { DO: `${sh < 0 ? '賣出的錢回核心。' : '錢從核心出。'}`, SKIP: SKIP.strategy },
  };
}

function volScale(ctx: ExplainContext, n: Notif, it: Item): Explain {
  const { acct } = ctx;
  const before = n.monthly?.before.rule.volW ?? null;
  const after = acct.rule.volW;
  const m = /σ̃\/σ = ([\d.]+)/.exec(it.why ?? '');
  const ratio = m ? Number(m[1]) : NaN;
  const down = (after ?? 1) < (before ?? 1);
  const lines = it.choices[0].lines;
  return {
    short: `動能部位調到${thirds(after)}（原本${thirds(before)}）`,
    why: Number.isFinite(ratio)
      ? `動能持股最近半年的波動是歷史中位數的 ${(1 / ratio).toFixed(2)} 倍（σ̃ ÷ σ = ${ratio.toFixed(2)}）。規則把動能部位從${thirds(before)}調到${thirds(after)}，${down ? '減下來的錢交給核心' : '從核心拿錢補回來'}。`
      : `動能部位的比例從${thirds(before)}調到${thirds(after)}。`,
    gauge: Number.isFinite(ratio)
      ? {
          from: 0,
          to: 1.4,
          fromLabel: '0',
          toLabel: '1.4',
          value: Math.min(1.4, ratio),
          valueLabel: ratio.toFixed(2),
          marks: [
            { at: 1 / 3, label: '1/3' },
            { at: 2 / 3, label: '2/3' },
            { at: 1, label: '全額' },
          ],
          zones: [{ from: 0, to: 1 }],
          caption: 'σ̃ ÷ σ（越小代表最近越震盪）',
        }
      : undefined,
    rule: RULE.vol,
    math: lines.map((l) => `${l.ticker}：${sharesText(l.shares)}`),
    choiceNotes: { DO: '五檔一起照比例調整。', SKIP: SKIP.strategy },
  };
}

function crash(ctx: ExplainContext, n: Notif, it: Item): Explain {
  const { acct, view } = ctx;
  const on = it.f === 'F5';
  const core = acct.cfg.coreTicker;
  const c = closeOf(view, core);
  const px = c ? c[view.i] : NaN;
  const ma = c ? sma(c, view.i, 200) : NaN;
  const rel = px / ma - 1;
  const note = findNote(ctx.aiNotes, 'CRASH', undefined, n.date);
  return {
    short: on ? `${core} 跌破 200 日均線（${fmtSigned(rel, 1)}）` : `${core} 回到 200 日均線之上（${fmtSigned(rel, 1)}）`,
    why: on
      ? `${core} 前一日收盤 ${fmtPx(px)}，低於 200 日均線 ${fmtPx(ma)}（${fmtSigned(rel, 1)}）。崩盤規則啟動：核心一半換成短債（${acct.bondTicker}），動能部位減半。`
      : `${core} 前一日收盤 ${fmtPx(px)}，回到 200 日均線 ${fmtPx(ma)} 之上（${fmtSigned(rel, 1)}）。崩盤規則解除：短債換回 ${core}，動能部位恢復。`,
    gauge: maGauge(rel, `${core} 收盤相對 200 日均線`, on),
    rule: RULE.crash,
    facts: [
      { label: '2000–2026 啟動過', value: '17 次', note: '3 次是真的空頭（買回時便宜 13～34%）；13 次買回時更貴（+2～+14%）。多付的那幾次就是保險費。' },
      ...(it.aiLine ? [{ label: 'AI 檢視', value: it.aiLine.replace(/^AI 檢視：/, ''), note: 'AI 的意見只供參考並記錄，不能否決或延後這條規則。' }] : []),
    ],
    math: it.choices[0].lines.map((l) => `${BUCKET_NAME[l.bucket]} ${l.ticker}：${sharesText(l.shares)}`),
    chart: core,
    ai: note,
    aiMissing: !!it.aiLine && !note,
    choiceNotes: { DO: on ? '核心與動能一起減半；全系統只有這條規則會把錢放到短債。' : '短債全部換回核心 ETF，動能買回原本的比例。', SKIP: SKIP.strategy },
  };
}

/** 找「幾月幾日觸發」那一天在時間軸上的位置；找不到就用訊號日。 */
function triggerIndex(ctx: ExplainContext, it: Item): { i: number; date: string } {
  const m = /（(\d{4}-\d{2}-\d{2}) 觸發/.exec(it.title);
  if (m) {
    const k = ctx.axis.lastIndexOf(m[1]);
    // axis 的最後一個是訊號日（view.i）
    if (k >= 0) return { i: ctx.view.i - (ctx.axis.length - 1 - k), date: m[1] };
  }
  return { i: ctx.view.i, date: ctx.view.date };
}

function ownAiParts(ctx: ExplainContext, n: Notif, it: Item, action: 'REDUCE' | 'READD'): Pick<Explain, 'ai' | 'aiMissing' | 'facts'> & { aiNote?: string } {
  const t = it.ticker!;
  const meta = ctx.acct.own[t];
  const ai = it.choices.find((c) => c.id === 'AI');
  const note = findNote(ctx.aiNotes, 'REVIEW', t, n.date);
  if (ai) {
    const label = it.aiLine?.match(/檔位：([^）]+)）/)?.[1] ?? (ai.tier ? TIER_NAME[ai.tier] : '');
    return { ai: note, aiMissing: !note, aiNote: note ? `AI ${md(note.date)} 審查的結論是「${label}」：${note.summary}` : `AI 最近一次審查的結論是「${label}」。` };
  }
  if (meta?.aiTier) {
    const same = action === 'REDUCE' ? meta.aiTier.tier === 'HALF' : meta.aiTier.tier !== 'HALF' && meta.aiTier.tier !== 'EXIT';
    if (same) {
      return {
        ai: note,
        facts: [{ label: 'AI 的看法', value: `${md(meta.aiTier.date)} 審查：${TIER_NAME[meta.aiTier.tier]}`, note: action === 'REDUCE' ? '和規則是同一個動作，所以只列一行。' : 'AI 沒有不同意見，所以只列一行。' }],
      };
    }
  }
  return {};
}

function ownReduce(ctx: ExplainContext, n: Notif, it: Item): Explain {
  const { view, acct } = ctx;
  const t = it.ticker!;
  const c = closeOf(view, t);
  const trig = triggerIndex(ctx, it);
  const px = c ? c[trig.i] : NaN;
  const high = c ? rollingMax(c, trig.i, SLOW.highDays) : NaN;
  const dd = c ? drawdownFromHigh(c, trig.i, SLOW.highDays) : NaN;
  const rule = it.choices.find((x) => x.id === 'RULE');
  const sh = -sharesOf(rule?.lines ?? [], t);
  const cur = acct.lots.own[t] ?? 0;
  const late = trig.date !== view.date;
  const ai = ownAiParts(ctx, n, it, 'REDUCE');
  const aiChoice = it.choices.find((x) => x.id === 'AI');
  const total = totalValue(acct, view);
  return {
    short: `比 52 週高點低 ${fmtPct(-dd)}，門檻是 20%`,
    why: `${t} ${late ? `在 ${md(trig.date)} ` : ''}收盤 ${fmtPx(px)}，比 52 週高點 ${fmtPx(high)} 低 ${fmtPct(-dd, 1)}。慢規則：跌超過 20% 就賣掉一半。這是保險，不是判斷它會繼續跌。${late ? '當時變動不到總資產 5%，所以沒有當天通知，併到這份月報。' : ''}`,
    gauge: Number.isFinite(dd) ? drawdownGauge(dd) : undefined,
    rule: RULE.slow,
    facts: [...(ai.facts ?? []), { label: '這一筆占總資產', value: fmtPct((sh * (c ? c[view.i] : 0)) / total, 1), note: '5% 以上當天通知，不到 5% 併入月報。' }],
    math: [`目前自選持有 ${cur} 股 → 賣掉一半 = ${sh} 股（四捨五入到整股）`],
    chart: t,
    ai: ai.ai,
    aiMissing: ai.aiMissing,
    choiceNotes: {
      RULE: '賣一半，錢交給核心。之後站回 200 日均線連續 10 天，再買回到標準比重。',
      ...(aiChoice ? { AI: ai.aiNote ?? '' } : {}),
      SKIP: SKIP.own,
    },
  };
}

function ownReadd(ctx: ExplainContext, n: Notif, it: Item): Explain {
  const { view, acct } = ctx;
  const t = it.ticker!;
  const c = closeOf(view, t);
  const px = c ? c[view.i] : NaN;
  const ma = c ? sma(c, view.i, SLOW.maDays) : NaN;
  const rel = px / ma - 1;
  const run = acct.own[t]?.slow.aboveRun ?? 0;
  const rule = it.choices.find((x) => x.id === 'RULE');
  const sh = sharesOf(rule?.lines ?? [], t);
  const cur = acct.lots.own[t] ?? 0;
  const std = acct.rule.own[t]?.stdWeight ?? 0;
  const total = totalValue(acct, view);
  const trig = triggerIndex(ctx, it);
  const ai = ownAiParts(ctx, n, it, 'READD');
  const aiChoice = it.choices.find((x) => x.id === 'AI');
  return {
    short: `站回 200 日均線連續 10 天以上（${fmtSigned(rel, 1)}）`,
    why: `${t} 收盤 ${fmtPx(px)}，在 200 日均線 ${fmtPx(ma)} 之上（${fmtSigned(rel, 1)}）${trig.date !== view.date ? `，${md(trig.date)} 就已經連續站上 10 天` : `，已連續 ${run} 天`}。慢規則：之前減半的部分買回來，回到標準比重 ${fmtPct(std, 1)}。`,
    gauge: Number.isFinite(rel) ? maGauge(rel, `${t} 收盤相對 200 日均線`, false) : undefined,
    rule: RULE.slow,
    facts: ai.facts,
    math: [`標準比重 ${fmtPct(std, 1)} × 總資產 ${fmtMoney(total)} ÷ 前一日收盤 ${fmtPx(px)} = ${Math.floor((std * total) / px)} 股`, `已有 ${cur} 股 → 買 ${sh} 股`],
    chart: t,
    ai: ai.ai,
    aiMissing: ai.aiMissing,
    choiceNotes: {
      RULE: '買回到標準比重，錢從核心出。',
      ...(aiChoice ? { AI: `${ai.aiNote ?? ''}照 AI 的話維持減半，之後規則符合條件時會再提一次。` } : {}),
      SKIP: SKIP.own,
    },
  };
}

function capTrim(ctx: ExplainContext, _n: Notif, it: Item): Explain {
  const { view, acct } = ctx;
  const t = it.ticker!;
  const c = closeOf(view, t);
  const px = c ? c[view.i] : NaN;
  const total = totalValue(acct, view);
  const own = ((acct.lots.own[t] ?? 0) * px) / total;
  const mom = ((acct.lots.mom[t] ?? 0) * px) / total;
  const cross = it.choices[0].lines.some((l) => l.reason === '跨桶上限');
  const w = cross ? own + mom : own;
  return {
    short: `占總資產 ${fmtPct(w, 1)}，超過 ${fmtPct(acct.cfg.ownCapHi)} 上限`,
    why: cross
      ? `${t} 在自選（${fmtPct(own, 1)}）和動能（${fmtPct(mom, 1)}）合計占總資產 ${fmtPct(w, 1)}，超過 ${fmtPct(acct.cfg.crossCapHi)}。規則：減回 ${fmtPct(acct.cfg.crossCapBuy ?? 0.1)}，先減動能那部分。`
      : `${t} 的自選部位占總資產 ${fmtPct(w, 1)}，超過單檔上限 ${fmtPct(acct.cfg.ownCapHi)}。規則：減回 ${fmtPct(acct.cfg.ownCapTo)}。這是風險控制，漲多的股票不會讓整個帳戶押在一檔上。`,
    gauge: weightGauge(w, acct.cfg.ownCapHi, acct.cfg.ownCapTo),
    rule: RULE.cap,
    math: it.choices[0].lines.map((l) => `${BUCKET_NAME[l.bucket]} ${l.ticker}：${sharesText(l.shares)}（前一日收盤 ${fmtPx(px)}）`),
    chart: t,
    choiceNotes: { DO: '賣出的錢交給核心。', SKIP: SKIP.strategy },
  };
}

/** 每一行現在占多少、目標是多少（入金、出金、改比例的清單用）。 */
function lineFacts(ctx: ExplainContext, lines: OrderLine[]): Fact[] {
  const { acct, view } = ctx;
  const total = totalValue(acct, view);
  const slot = momSlotTarget(acct.cfg, total, acct.rule.effPrev ?? 1);
  return lines.map((l) => {
    const c = closeOf(view, l.ticker);
    const px = c ? c[view.i] : NaN;
    const cur = ((acct.lots[l.bucket][l.ticker] ?? 0) * px) / total;
    let tgt: number | null = null;
    if (l.bucket === 'own' && acct.rule.own[l.ticker]) tgt = acct.rule.own[l.ticker].stdWeight * (acct.rule.own[l.ticker].applied === 'HALF' ? 0.5 : 1);
    if (l.bucket === 'mom' && acct.rule.heldMom.includes(l.ticker)) tgt = slot / total;
    const why = l.reason === '單檔上限' ? '出金後會超過單檔上限 15%，先減回 10%' : l.reason === '跨桶上限' ? '自選＋動能合計超過上限' : tgt !== null ? `目前 ${fmtPct(cur, 1)}，目標 ${fmtPct(tgt, 1)}` : `目前 ${fmtPct(cur, 1)}`;
    return { label: `${BUCKET_NAME[l.bucket]} ${l.ticker}`, value: sharesText(l.shares), note: why };
  });
}

function cashflow(ctx: ExplainContext, n: Notif, it: Item): Explain {
  const { acct } = ctx;
  const lines = it.choices[0].lines;
  const core = acct.cfg.coreTicker;
  if (it.f === 'F11') {
    const amt = n.deposit ?? 0;
    return {
      short: `入金 ${fmtMoney(amt)}：補低於目標最多的格子，其餘進核心`,
      why: `你入金 ${fmtMoney(amt)}。入金只買不賣：先補「離目標最遠」的格子${lines.length ? `（${lines.map((l) => l.ticker).join('、')}）` : ''}，剩下的交給核心買 ${core}。已經高於目標的股票不會再買。`,
      rule: RULE.deposit,
      facts: lineFacts(ctx, lines),
    };
  }
  if (it.f === 'F12') {
    const amt = n.withdraw ?? 0;
    const cap = lines.filter((l) => l.reason === '單檔上限').map((l) => l.ticker);
    return {
      short: `出金 ${fmtMoney(amt)}：只賣不買${cap.length ? `，${cap.join('、')} 先減回 10%` : ''}`,
      why: `你要出金 ${fmtMoney(amt)}。出金只賣不買${cap.length ? `：${cap.join('、')} 在出金後會超過總資產 15%，所以先在這份清單減回 10%，賣得的錢抵出金` : ''}；其餘照順序從核心、動能、最後才是自選拿。清單做完後，從券商轉出 ${fmtMoney(amt)}，再回來填快照。`,
      rule: RULE.withdraw,
      facts: lineFacts(ctx, lines),
    };
  }
  if (it.f === 'F13') {
    const m = /(\d+% \/ \d+% \/ \d+%) → (\d+% \/ \d+% \/ \d+%)/.exec(it.title);
    return {
      short: m ? `比例 ${m[1]} → ${m[2]}` : '改比例',
      why: `你把自選／動能／核心的比例${m ? `從 ${m[1]} 改成 ${m[2]}` : '改了'}。自選每一檔的股數和標準比重照新舊比例縮放，動能每檔的目標照新的比例重算，差額由核心吸收。原本的比例會繼續記在紀錄裡，之後可以回頭看這次調整是加分還是扣分。`,
      rule: RULE.ratio,
      facts: [...lineFacts(ctx, lines), { label: '提醒', value: '', note: '在動能落後大盤的時候把它調成 0，等於在相對低點放棄它。系統不會擋，由你決定。' }],
    };
  }
  if (it.f === 'F14') return addOwnExplain(ctx, it);
  if (it.f === 'F15') {
    const t = it.ticker!;
    return {
      short: '全部賣出，錢交給核心',
      why: `你要把 ${t} 移出自選：${acct.lots.own[t] ?? 0} 股全部賣出，錢交給核心。之後這一檔不再有規則或 AI 追蹤；「如果繼續持有」會記在紀錄裡，之後可以回頭比較。`,
      chart: t,
    };
  }
  return { short: it.why ?? it.title, why: it.why ?? it.title };
}

function addOwnExplain(ctx: ExplainContext, it: Item): Explain {
  const { acct, view } = ctx;
  const t = it.ticker!;
  const c = closeOf(view, t);
  const px = c ? c[view.i] : NaN;
  const dd = c ? drawdownFromHigh(c, view.i, SLOW.highDays) : NaN;
  const ma = c ? sma(c, view.i, SLOW.maDays) : NaN;
  const vol = c ? annualizedVol(c, view.i, 126) : NaN;
  const std = acct.rule.own[t]?.stdWeight ?? 0;
  const half = acct.rule.own[t]?.applied === 'HALF';
  const total = totalValue(acct, view);
  const sh = sharesOf(it.choices[0].lines, t);
  const rank = ctx.rankOrder.indexOf(t);
  const momVal = (acct.lots.mom[t] ?? 0) * px;
  const facts: Fact[] = [
    { label: '年化波動度（近半年）', value: fmtPct(vol), note: '波動越大，建議的比重越小' },
    { label: '距 52 週高點', value: fmtPct(dd, 1), note: dd <= SLOW.drawdown ? '已經超過 −20%，一開始就是減半狀態' : '−20% 會觸發減半' },
    { label: '相對 200 日均線', value: fmtSigned(px / ma - 1, 1) },
  ];
  if (rank >= 0) facts.push({ label: '動能排名', value: `第 ${rank + 1} 名` });
  if (momVal > 0) facts.push({ label: '動能桶已經持有', value: fmtMoney(momVal), note: `同一檔自選＋動能合計超過總資產 ${fmtPct(acct.cfg.crossCapHi)} 會被減回 ${fmtPct(acct.cfg.crossCapBuy ?? 0.1)}` });
  const adopted = /認養/.test(it.title);
  return {
    short: half ? '已比高點低 20% 以上，先買標準比重的一半' : `買到標準比重 ${fmtPct(std, 1)}`,
    why: adopted
      ? `你認養了動能選出的 ${t}：照常買進，但記在自選桶。之後動能就算把它排除，也不會叫你賣；改由自選的慢規則管。`
      : `你把 ${t} 加進自選。建議的標準比重是 ${fmtPct(std, 1)}（自選預算 ${fmtPct(acct.cfg.ratio.own)} 內，波動越大的比重越小）。${half ? `${t} 現在比 52 週高點低 ${fmtPct(-dd, 1)}，已經在慢規則「減半」的範圍內，所以一開始只買標準比重的一半，等它站回 200 日均線連續 10 天再補足。這樣不會一買進就收到減半通知。` : ''}錢從核心出。`,
    gauge: Number.isFinite(dd) && !adopted ? drawdownGauge(dd) : undefined,
    rule: RULE.addOwn,
    facts,
    math: adopted ? undefined : [`標準比重 ${fmtPct(std, 1)}${half ? ' × 一半' : ''} × 總資產 ${fmtMoney(total)} ÷ 前一日收盤 ${fmtPx(px)} = ${sh} 股`],
    chart: t,
    choiceNotes: { DO: '系統不替你決定要不要買；這只是照比重算出來的股數。', SKIP: '不買的話，這檔仍然在自選名單上（0 股），可以之後再移除。' },
  };
}

function aiOnly(ctx: ExplainContext, n: Notif, it: Item): Explain {
  const { acct, view } = ctx;
  const t = it.ticker!;
  const ai = it.choices.find((c) => c.id === 'AI');
  const tier = ai?.tier;
  const sh = sharesOf(ai?.lines ?? [], t);
  const c = closeOf(view, t);
  const px = c ? c[view.i] : NaN;
  const total = totalValue(acct, view);
  const std = acct.rule.own[t]?.stdWeight ?? 0;
  const cur = acct.lots.own[t] ?? 0;
  if (it.f === 'F25') {
    const cond = /條件「(.+)」成立/.exec(it.title)?.[1] ?? '';
    const note = findNote(ctx.aiNotes, 'CONDITION', t, n.date);
    return {
      short: `AI 之前寫下的條件成立：${cond}`,
      why: `規則沒有動作。這是 AI 的建議：之前審查 ${t} 時寫下的條件「${cond}」成立了，AI 建議${tier ? TIER_NAME[tier] : ''}（${sharesText(sh)}）。${note ? note.summary : ''}`,
      rule: RULE.ai,
      math: [tier === 'EXIT' ? `自選持有 ${cur} 股 → 全部賣出` : `目前 ${cur} 股 → ${sharesText(sh)}`],
      chart: t,
      ai: note,
      aiMissing: !note,
      choiceNotes: { AI: tier === 'EXIT' ? '全部賣出、錢回核心，這檔移出自選，之後不再追蹤。想再買要重新新增。' : '照 AI 的檔位調整，慢規則的狀態跟著改。', SKIP: `${SKIP.ai}每檔每個月最多收到一則這種通知。` },
    };
  }
  const note = findNote(ctx.aiNotes, 'REVIEW', t, n.date);
  const raise = tier === 'RAISE';
  return {
    short: raise ? 'AI 審查：前提都成立，可以提高比重' : `AI 審查的建議：${tier ? TIER_NAME[tier] : ''}`,
    why: `規則沒有動作。這是 AI 每月審查 ${t} 之後的建議：${tier ? TIER_NAME[tier] : ''}（${sharesText(sh)}）。${note ? note.summary : ''}`,
    rule: raise ? `${RULE.ai}「提高到 125%」只有在股價站在 200 日均線之上連續 6 個月以上、不在減半狀態時才能選，同一檔一年最多一次。` : RULE.ai,
    math: raise
      ? [`標準比重 ${fmtPct(std, 2)} × 1.25 = ${fmtPct(std * 1.25, 2)}`, `${fmtPct(std * 1.25, 2)} × 總資產 ${fmtMoney(total)} ÷ 前一日收盤 ${fmtPx(px)} = ${Math.floor((std * 1.25 * total) / px)} 股，已有 ${cur} 股 → 買 ${sh} 股`]
      : [`目前 ${cur} 股 → ${sharesText(sh)}`],
    chart: t,
    ai: note,
    aiMissing: !note,
    choiceNotes: { AI: raise ? '買進後，這檔的標準比重就變成原本的 125%。等於提高自選的預算，由你決定。' : '照 AI 的檔位調整，慢規則的狀態跟著改。', SKIP: SKIP.ai },
  };
}

function hard(ctx: ExplainContext, n: Notif, it: Item): Explain {
  const t = it.ticker!;
  const code = /(PENDING_MA|ACCOUNTING|REGULATORY)/.exec(it.title)?.[1] ?? '';
  const name = { PENDING_MA: '被收購（股價已經貼近收購價，動能的前提不再適用）', ACCOUNTING: '會計問題（財報重編、更換會計師或延遲申報）', REGULATORY: '重大監管事件' }[code] ?? code;
  const note = findNote(ctx.aiNotes, 'HARD', t, n.date);
  const byRule = it.choices.some((c) => c.id === 'DO');
  return {
    short: `硬事件：${name.split('（')[0]}`,
    why: `${t} 出現硬事件：${name}。${byRule ? '這一類由規則直接提出' : 'AI 讀過申報原文後建議提早出場'}，要你確認才會做。${note ? note.summary : ''}`,
    chart: t,
    ai: note,
    aiMissing: !byRule && !note,
    choiceNotes: { DO: '確認出場，空出來的位置下個月照排名遞補。', AI: '照 AI 出場。', SKIP: byRule ? '不確認的話，下個月月報會再列一次。' : SKIP.ai },
  };
}

function owed(ctx: ExplainContext, _n: Notif, it: Item): Explain {
  const t = it.ticker!;
  const sh = sharesOf(it.choices[0].lines, t);
  if (it.kind === 'FIX') {
    return { short: '快照和清單不同，你選了補做', why: `上一次填的快照顯示 ${t} 和清單差了 ${Math.abs(sh)} 股，你選了補做，所以這裡把差額列出來。`, chart: t };
  }
  const { slot } = slotMath(ctx, t, sh);
  return {
    short: '上次的動能單沒做完，差額再列一次',
    why: `${t} 在動能名單上，但上次的單沒有做完，動能桶和名單對不上。動能桶的績效要能代表策略本身，所以這個月把差額再列一次（拉回每檔目標 ${fmtMoney(slot)}）。`,
    rule: '動能、核心、比例回調、上限的單屬於策略本身：沒照做的差額會一直列在月報上，直到你選「排除」或「轉入自選」並寫下理由。',
    chart: t,
    choiceNotes: { DO: '補上次沒做的部分。', SKIP: SKIP.strategy },
  };
}

/** 一項建議的理由。 */
export function explainItem(ctx: ExplainContext, n: Notif, it: Item): Explain {
  try {
    if (it.kind === 'AI_ONLY') return aiOnly(ctx, n, it);
    if (it.kind === 'HARD') return hard(ctx, n, it);
    switch (it.f) {
      case 'F1':
        return it.kind === 'CASHFLOW' ? addOwnExplain(ctx, it) : momEntry(ctx, n, it);
      case 'F2':
        return momExit(ctx, n, it);
      case 'F3':
        return momRebalance(ctx, n, it);
      case 'F4':
        return volScale(ctx, n, it);
      case 'F5':
      case 'F6':
        return crash(ctx, n, it);
      case 'F7':
        return ownReduce(ctx, n, it);
      case 'F8':
        return ownReadd(ctx, n, it);
      case 'F10':
        return capTrim(ctx, n, it);
      case 'F17':
        return owed(ctx, n, it);
      case 'CORE':
        return { short: '帳上的閒置現金交給核心', why: `帳上有閒置的現金（股利或上次交易剩下的零頭）。這個月沒有其他單，就把它交給核心買 ${ctx.acct.cfg.coreTicker}。`, choiceNotes: { DO: '買核心 ETF。', SKIP: '現金留在帳上，下個月月報會再列一次。' } };
      default:
        return cashflow(ctx, n, it);
    }
  } catch {
    // 缺價格等情況：至少給引擎寫的那一句
    return { short: it.why ?? it.title, why: it.why ?? it.title };
  }
}

/** 替還沒有理由的項目寫下理由。回傳有沒有新增。 */
export function annotate(ctx: ExplainContext, only?: (n: Notif) => boolean): boolean {
  let changed = false;
  for (const n of ctx.acct.notifs) {
    if (only && !only(n)) continue;
    for (const it of n.items as ItemX[]) {
      if (it.x) continue;
      it.x = explainItem(ctx, n, it);
      changed = true;
    }
  }
  return changed;
}

/** 核心那一行是算出來的：把引擎寫的原因翻成一句話。 */
export function coreLineWhy(reason: string, acct: Account): string {
  if (reason.startsWith('錢交給核心')) return reason.includes('崩盤') ? `清單做完會多出現金，交給核心（崩盤規則啟動中：一半買 ${acct.cfg.coreTicker}、一半放短債）` : `清單做完會多出現金，交給核心買 ${acct.cfg.coreTicker}`;
  if (reason.startsWith('從核心拿錢')) return reason.includes('短債') ? '不夠的錢先從核心的短債拿' : `不夠的錢從核心拿（賣 ${acct.cfg.coreTicker}）`;
  return reason;
}
