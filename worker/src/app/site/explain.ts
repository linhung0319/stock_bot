// 每一項建議的「為什麼」：用訊號日的價格、排名與帳戶狀態，寫成帶數字的理由。
// 通知產生的當下算好，存在通知裡（item.x），之後價格變了理由也不會跟著變。
// 引擎不知道這個欄位（它只會原樣帶著走）；讀通知時發現沒有，就用當下的資料補算。
import { ENTRY_CODE_TEXT, replacements } from '../../ai/momEntry';
import {
  SLOW,
  TIER_NAME,
  afterOpenLists,
  annualizedVol,
  coreAfterList,
  coreBandCheck,
  coreCfg,
  drawdownFromHigh,
  hardToldDays,
  momSlotTarget,
  ownDepositFill,
  ownDepositScale,
  priceOf,
  rollingMax,
  sma,
  totalValue,
  trailingReturn,
  type Account,
  type Composed,
  type CrashReviewInfo,
  type Item,
  type MarketView,
  type Notif,
  type OrderLine,
  type StrategyReviewState,
  notifName,
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
  /** 策略檢討的狀態（flow_state 的 strategyReview；改比例那一列「動能相對大盤」用，core_ai §3.11）。示範模式沒有。 */
  strategy?: StrategyReviewState | null;
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

/**
 * 這一項的 AI 說明：項目帶了 runIds（T13 起）就找那一次執行；沒有（舊的通知）或找不到，照舊取訊號日以前最新的一份。
 */
export function findNote(notes: AiNote[], kind: AiNote['kind'], ticker: string | undefined, date: string, runIds?: string[]): AiNote | undefined {
  const exact = noteByRun(notes, kind, runIds);
  if (exact) return exact;
  let best: AiNote | undefined;
  for (const n of notes) {
    if (n.kind !== kind || (ticker && n.ticker !== ticker) || n.date > date) continue;
    if (!best || n.date > best.date) best = n;
  }
  return best;
}

/** 只用 runIds 找（沒有 runIds 或找不到就沒有）：崩盤規則項目用這個，不取「日期最近的一筆」（core_ai §3.3，修 C4）。 */
export function noteByRun(notes: AiNote[], kind: AiNote['kind'], runIds?: string[]): AiNote | undefined {
  if (!runIds?.length) return undefined;
  return notes.find((n) => n.kind === kind && n.runId !== undefined && runIds.includes(n.runId));
}

// ---------------------------------------------------------------- 規則的白話文

const RULE = {
  momentum: '每月第一個交易日看排名：S&P 500 裡市值前 50 大的股票，照過去 252 個交易日（約一年）的報酬由高到低排。買前 5 名；已經持有的要掉出前 15 名才賣。',
  lazy: '動能 5 檔各占一格。留任的股票只有在偏離目標超過 ±50% 時才調回，而且只在那個月本來就有其他單的時候順便做，不會只為了比例叫你下單。',
  vol: '每月比較動能持股最近半年相對大盤的波動（σ）和它的歷史中位數（σ̃）：部位 = σ̃ ÷ σ，最多全額，無條件捨去到 1/3 的倍數。要多跨過 0.10 才換一格，避免來回。減下來的錢交給核心。',
  core: '核心固定放股票 ETF 八成、短債與現金兩成（分母是核心，不是總資產）。錢進出核心都照這個比例分；每月第一個交易日檢查一次，短債與現金那一邊低於 15% 或高於 25% 才調回 20%。',
  crash: '（已停用：2026-11 起沒有這條規則，核心固定留兩成短債，不看 200 日線；這是舊通知上的說明。）每月第一個交易日看核心 ETF 前一日的收盤：低於 200 日均線 → 核心一半換成短債、動能部位減半；回到均線之上 → 換回來。全系統只有這條規則會讓錢變成現金。',
  slow: '自選股的慢規則是保險，不是看壞：收盤比 52 週高點低 20% 以上 → 賣掉當時持有股數的一半；之後收盤站上 200 日均線連續 10 天、距上次切換滿 15 個交易日 → 買回到標準比重。',
  cap: '任何一檔自選股超過總資產 15% → 減回 10%。同一檔在自選和動能都有時，合計超過 15% 也減回 10%，先減動能那部分。',
  deposit: '入金只買不賣：用入金後的總資產算每一格的目標，依序補「低於目標最多」的格子；缺口小於總資產 0.25% 的不補；剩下的交給核心，照核心的比例分（股票 ETF 八成、短債兩成）。',
  withdraw: '出金只賣不買。先檢查單檔上限（出金後會超過 15% 的自選股先減回 10%，賣得的錢抵出金），不夠的再依序從：動能高於目標的部分 → 核心（照比例：股票 ETF 八成、短債兩成，帳上現金先用）→ 動能 → 最後才是自選。',
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

/** 連續站在 200 日均線之上幾個交易日（到 i 為止）。 */
export function daysAboveMa(c: ArrayLike<number>, i: number, cap = 400): number {
  let run = 0;
  for (let k = i; k >= 0 && run < cap; k--) {
    const ma = sma(c, k, SLOW.maDays);
    if (!(Number.isFinite(ma) && c[k] > ma)) break;
    run++;
  }
  return run;
}

/** AI 想「提高到 125%」的前提：股價站在 200 日均線之上連續 6 個月（約 126 個交易日）以上。 */
const RAISE_DAYS = 126;
function aboveMaGauge(c: ArrayLike<number>, i: number): Gauge {
  const run = daysAboveMa(c, i);
  const to = Math.max(189, run + 21);
  return { from: 0, to, fromLabel: '0', toLabel: `${to} 天`, value: run, valueLabel: `${run} 個交易日`, marks: [{ at: RAISE_DAYS, label: '6 個月' }], zones: [{ from: RAISE_DAYS, to }], caption: '連續站在 200 日均線之上' };
}

/** AI 的建議旁邊：規則（慢規則的減半門檻）現在在哪裡。 */
function contextDrawdown(c: ArrayLike<number>, i: number): Gauge | undefined {
  const dd = drawdownFromHigh(c, i, SLOW.highDays);
  return Number.isFinite(dd) ? { ...drawdownGauge(dd), caption: '規則這邊：收盤距 52 週高點' } : undefined;
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
  const excluded = Object.keys(acct.mom.excluded).filter((v) => order.indexOf(v) >= 0 && (idx < 0 || order.indexOf(v) < idx));
  // 真的是遞補的才寫「被否決後遞補」（T34 走一遍的缺口：原本排在被否決股票後面的每一檔都這樣寫）。
  // 沒有否決時這個月會買的是排名最前的那幾檔（replacements）；不在那幾檔之內的進場才是遞補上來的，寫它遞補的是哪一檔
  const entries = n.items.filter((x) => x.f === it.f && x.kind !== 'CASHFLOW' && x.ticker && !x.cancelled).map((x) => x.ticker!);
  const repOf = [...replacements(order, entries, n.monthly?.input.vetoed ?? [], n.monthly?.input.emptySlots ?? 0)].filter(([, by]) => by === t).map(([v]) => v);
  const replaced = repOf.length > 0;
  let why = rank ? `${t} 過去一年漲 ${fmtSigned(ret)}，在 50 檔大型股裡排第 ${rank}。動能規則買前 5 名，這個月有空位，所以進場。` : `${t} 在這個月的動能名單上，目前還沒持有。`;
  if (rank && rank > acct.cfg.momSlots) why = `${t} 過去一年漲 ${fmtSigned(ret)}，排第 ${rank}。排在前面的不是已經持有，就是不能買，所以輪到它遞補。`;
  // 沿用的否決（momentum_ai §3.3、§3.4）：後面加「（沿用 2026-11 的審查）」
  const carried = n.monthly?.input.vetoCarried ?? {};
  if (replaced) why += `排在它前面的 ${repOf.map((v) => (carried[v] ? `${v}（沿用 ${carried[v]} 的審查）` : v)).join('、')} 這個月被 AI 否決，所以由它遞補。`;
  if (excluded.length) why += `你排除了排在前面的 ${excluded.join('、')}。`;
  const { math } = slotMath(ctx, t, sh);
  const vetoRun = replaced ? n.monthly?.input.runIds?.entry?.[repOf[0]] : undefined;
  const veto = replaced ? findNote(ctx.aiNotes, 'VETO', repOf[0], n.date, vetoRun ? [vetoRun] : undefined) : undefined;
  const facts: Fact[] = [];
  const ownVal = (acct.lots.own[t] ?? 0) * (c ? c[view.i] : 0);
  if (ownVal > 0) facts.push({ label: '自選已經持有', value: fmtMoney(ownVal), note: `同一檔合計最多買到總資產 ${fmtPct(acct.cfg.crossCapBuy ?? 0.1)}，被擋下的部分留在核心` });
  return {
    // 月報之後才回來的否決（momentum_ai §3.3）：收合時那一行先講它
    short: it.lateVeto
      ? `進場審查在月報之後回來：3 票否決（${ENTRY_CODE_TEXT[it.lateVeto.code] ?? it.lateVeto.code}），預設仍是買進`
      : rank
        ? `一年報酬排第 ${rank}${replaced ? `，${repOf.join('、')} 被否決後遞補` : ''}`
        : '在動能名單上',
    why,
    gauge: rankGauge(rank, acct.cfg.momSlots, '一年報酬排名（越左邊越強）'),
    rule: RULE.momentum,
    facts: facts.length ? facts : undefined,
    math,
    ranking: rankingTable(ctx, order, n, [t]),
    chart: t,
    ai: veto,
    aiMissing: replaced && !veto,
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
  // 月報記下的訊號日數字（core_ai §3.7）；舊月報沒有就用顯示當下的 view
  const sig = n.monthly?.input.crash;
  const c = closeOf(view, core);
  const px = sig ? (sig.close ?? NaN) : c ? c[view.i] : NaN;
  const ma = sig ? (sig.ma ?? NaN) : c ? sma(c, view.i, 200) : NaN;
  const when = sig ? `${md(sig.date)} 收盤` : '前一日收盤';
  const rel = px / ma - 1;
  const note = noteByRun(ctx.aiNotes, 'CRASH', it.runIds);
  if (it.relist) {
    // 上次選了「這次不做」、規則還在同一個狀態 → 核心的單再列一次（core_ai §3.6）
    const month = /上次（(\d{4}-\d{2})）/.exec(it.title)?.[1];
    const last = month ? `上次（${month} 月報）` : '上次';
    // 上一份月報一直沒回覆（T39b）：不是「你選了這次不做」
    const unanswered = /一直沒有回覆/.test(it.why ?? '');
    const did = unanswered ? '一直沒有回覆' : '你選了這次不做';
    const tail = unanswered ? '' : (it.why ?? '');
    return {
      short: on ? `上次沒做，核心的一半換短債再列一次` : `上次沒做，短債換回 ${core} 再列一次`,
      why: on
        ? `崩盤規則還在啟動中：${core} ${when} ${fmtPx(px)}，仍低於 200 日均線 ${fmtPx(ma)}（${fmtSigned(rel, 1)}）。${last}${did}，核心還沒有換成短債。這次用現在的市值重算，把核心的一半換成短債（${acct.bondTicker}）再列一次。${tail}`
        : `崩盤規則已經解除：${core} ${when} ${fmtPx(px)}，仍在 200 日均線 ${fmtPx(ma)} 之上（${fmtSigned(rel, 1)}）。${last}${did}，短債還沒有換回來。這次用現在的市值重算，把短債全部換回 ${core} 再列一次。${tail}`,
      gauge: maGauge(rel, `${core} 收盤相對 200 日均線`, on),
      rule: `${RULE.crash} 崩盤項目選「這次不做」等於延後一個月：下個月規則還在同一個狀態就再列一次，已經翻回去就不用做。`,
      facts: [{ label: '上次沒做', value: month ?? '—', note: it.why ?? '' }],
      math: it.choices[0].lines.map((l) => `${BUCKET_NAME[l.bucket]} ${l.ticker}：${sharesText(l.shares)}`),
      chart: core,
      choiceNotes: { DO: on ? '核心的一半換成短債；動能那幾檔上次沒減的，另外列在「上次的策略單沒照做」。' : '短債全部換回核心 ETF；動能那幾檔上次沒加回的，另外列在「上次的策略單沒照做」。', SKIP: CRASH_SKIP },
    };
  }
  return {
    short: on ? `${core} 跌破 200 日均線（${fmtSigned(rel, 1)}）` : `${core} 回到 200 日均線之上（${fmtSigned(rel, 1)}）`,
    why: on
      ? `${core} ${when} ${fmtPx(px)}，低於 200 日均線 ${fmtPx(ma)}（${fmtSigned(rel, 1)}）。崩盤規則啟動：核心一半換成短債（${acct.bondTicker}），動能部位減半。`
      : `${core} ${when} ${fmtPx(px)}，回到 200 日均線 ${fmtPx(ma)} 之上（${fmtSigned(rel, 1)}）。崩盤規則解除：短債換回 ${core}，動能部位恢復。`,
    gauge: maGauge(rel, `${core} 收盤相對 200 日均線`, on),
    rule: RULE.crash,
    facts: [
      ...crashFacts(it),
    ],
    math: it.choices[0].lines.map((l) => `${BUCKET_NAME[l.bucket]} ${l.ticker}：${sharesText(l.shares)}`),
    chart: core,
    ai: note,
    aiMissing: !!it.aiLine && !note,
    choiceNotes: { DO: on ? '核心與動能一起減半；全系統只有這條規則會把錢放到短債。' : '短債全部換回核心 ETF，動能買回原本的比例。', SKIP: CRASH_SKIP },
  };
}

/** OPINION 那一列的備註。 */
const CRASH_AI_NOTE = 'AI 的意見只供參考並記錄，不能否決或延後這條規則。';

/**
 * 「AI 檢視」那一列的值（core_ai §3.3）：照做（3 票一致）、沒有意見（照做 2、延後 1）、進行中、2 次都沒有結論（逾時、被退回）、
 * 沒有：總經資料抓不到、沒有開；有 basis 時接「；依 11/27 收盤預估時做的」或「；月報之後補開的」，晚到的再接「；在你決定之後才回來」。
 */
export function crashReviewText(cr: CrashReviewInfo): string {
  const fails = cr.fails ?? [];
  const base =
    cr.state === 'OPINION'
      ? `${cr.opinion ?? '—'}（${cr.votes ?? '3 票一致'}）`
      : cr.state === 'NO_OPINION'
        ? `沒有意見${cr.votes ? `（${cr.votes}）` : ''}`
        : cr.state === 'PENDING'
          ? '進行中，台灣 11:30 前更新'
          : cr.state === 'FAILED'
            ? `${fails.length > 1 ? `${fails.length} 次都` : ''}沒有結論${fails.length ? `（${fails.join('、')}）` : ''}`
            : cr.state === 'NO_DATA'
              ? '沒有：總經資料抓不到'
              : '沒有開';
  const basis = cr.basis && cr.state !== 'NO_DATA' && cr.state !== 'OFF' ? (cr.kind === 'PREVIEW' ? `；依 ${md(cr.basis)} 收盤預估時做的` : cr.kind === 'MAKEUP' ? '；月報之後補開的' : '') : '';
  return `${base}${basis}${cr.late ? '；在你決定之後才回來' : ''}`;
}

/** 崩盤項目固定有一列「AI 檢視」（core_ai §3.3）；舊通知沒有 crashReview 時照舊（有 aiLine 才顯示）；重列的那一項不開檢視，沒有這一列。 */
function crashFacts(it: Item): Fact[] {
  if (it.relist) return [];
  if (it.crashReview) return [{ label: 'AI 檢視', value: crashReviewText(it.crashReview), ...(it.crashReview.state === 'OPINION' ? { note: CRASH_AI_NOTE } : {}) }];
  return it.aiLine ? [{ label: 'AI 檢視', value: it.aiLine.replace(/^AI 檢視：/, ''), note: CRASH_AI_NOTE }] : [];
}

/**
 * 崩盤項目的理由，「AI 檢視」那一列與 AI 說明每次讀通知時重算：月報產生之後檢視才回來（補開、01:30 重開）時那一列會更新（core_ai §3.2、§3.3）。
 * 存在通知裡的數字（價格、均線、股數）不變。
 */
export function liveCrash(ctx: ExplainContext, n: Notif, it: ItemX): Explain {
  const x = it.x ?? explainItem(ctx, n, it);
  if (it.relist) return x;
  const note = noteByRun(ctx.aiNotes, 'CRASH', it.runIds);
  const facts = [...(x.facts ?? []).filter((f) => f.label !== 'AI 檢視'), ...crashFacts(it)];
  const cr = it.crashReview;
  const tail = cr?.state === 'OPINION' && cr.opinion ? `AI 檢視：${cr.opinion}` : cr?.state === 'PENDING' ? 'AI 檢視進行中' : null;
  // 價格和基準對不上（core_ai §3.10）：收合時也留一句，展開後的那一行寫數字與怎麼做
  const check = n.monthly?.input.coreCheck?.some((c) => c === 'DAY_GAP' || c === 'MA_GAP') ? `${ctx.acct.cfg.coreTicker} 價格待核對` : null;
  let short = tail && !x.short.includes(tail) ? `${x.short}；${tail}` : x.short;
  if (check && !short.includes(check)) short = `${short}；${check}`;
  return { ...x, short, facts, ai: note, aiMissing: !!it.aiLine && !note };
}

/** 「這次不做」的一鍵理由（confirm_audit_design §6，T72）：甲類、慢規則減半、崩盤項目。網站最後再加一個「其他」（選了才要自己打字）。 */
export const REASON_PICKS_SKIP = ['價格已經反映', '想再觀察一陣子', '這檔對我有其他用途（避險、配置）'] as const;
/** 乙類「不同意，不動」的一鍵理由（§6）。 */
export const REASON_PICKS_DISAGREE = ['我認為這條前提還成立', '報導不可信', '想等下一份財報'] as const;

/**
 * 這一項理由欄的一鍵選項（§6）：乙類（AI 判斷前提不成立，不是附在慢規則減半上的；當天的必填、月報裡的可以不寫）→ 不同意的三個；
 * 其他要寫理由的（甲類、慢規則減半、崩盤）→ 這次不做的三個；不用寫理由的是 null。選項的字就是理由（照舊存進論點檔、進下一次審查與靜默期）。
 */
export function reasonPicksOf(it: Item): string[] | null {
  if (it.brk?.type === 'B' && !it.brk.withRule) return [...REASON_PICKS_DISAGREE];
  return it.reasonRequired ? [...REASON_PICKS_SKIP] : null;
}

/** 崩盤項目「這次不做」的說明（core_ai §3.6）。 */
const CRASH_SKIP = '要寫一句理由。等於延後一個月：下個月規則還在同一個狀態，核心的單會再列一次；已經翻回去就不用做。動能那幾檔的差額照樣下個月再列。';

/** 崩盤項目「這次不做」的理由欄（網站用；core_ai §3.6）。prefill：AI 檢視三票一致說延後時先填的字。 */
export function crashReasonText(it: Item): { placeholder: string; hint: string; prefill: string } | null {
  if (it.f !== 'F5' && it.f !== 'F6') return null;
  return {
    placeholder: '為什麼這次不照崩盤規則做（1～200 字）',
    hint: '這句話會記在紀錄裡，下個月重列時也會帶著。規則的狀態照樣記成已經切換；下個月還在同一個狀態，核心的單會再列一次。',
    prefill: (it.crashReview ? it.crashReview.state === 'OPINION' && it.crashReview.opinion === '延後' : it.aiLine === 'AI 檢視：延後') ? '照 AI 檢視：延後' : '',
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

/**
 * 慢規則項目上 AI 的說明（own_thesis §3.4）：只認這一項帶的那幾次 AI 執行（runIds），不取「日期最近的一筆」——
 * 通知上 AI 的那一行只來自看過這次觸發的結論，舊的審查不能被當成這次的說明（修 K1）。示範模式的假說明沒有執行編號，照代號與日期找。
 */
function ownAiParts(ctx: ExplainContext, n: Notif, it: Item): Pick<Explain, 'ai' | 'aiMissing'> {
  if (!it.aiLine) return {};
  const byRun = noteByRun(ctx.aiNotes, 'REVIEW', it.runIds);
  const demo = byRun ? undefined : findNote(ctx.aiNotes, 'REVIEW', it.ticker, n.date);
  const note = byRun ?? (demo?.fake ? demo : undefined);
  return { ai: note, aiMissing: !!it.choices.find((c) => c.id === 'AI') && !note };
}

/** 收合時那一行理由後面接的 AI 狀態（減半項目）。 */
const DROP_SHORT: Record<string, string> = { PENDING: 'AI 論點檢查進行中', HOLD: 'AI 建議不動', EXIT: 'AI 認為前提不成立，建議出清', AGREE: 'AI 同意減半', NONE: 'AI 沒有一致結論' };
/** 靜默期的一句話（選項說明用）。 */
const SILENCE_NOTE = '到下一季財報出來（最長 100 天）不再為這條前提通知你';

/**
 * 慢規則項目的理由，AI 的那一部分每次讀通知時重算：通知產生之後那一行還會更新（減半檢視晚一點回來、之後另外有審查回來），
 * 存在通知裡的數字（價格、跌幅、股數）不變。
 */
export function liveOwnRule(ctx: ExplainContext, n: Notif, it: ItemX): Explain {
  const fresh = explainItem(ctx, n, it);
  const x = it.x ?? fresh;
  const ai = it.choices.find((c) => c.id === 'AI');
  const tail = it.f === 'F7' ? (it.drop ? DROP_SHORT[it.drop] : null) : ai ? `AI 建議${ai.tier === 'EXIT' ? '出清' : '維持減半'}` : null;
  return { ...x, short: tail ? `${x.short}；${tail}` : x.short, ai: fresh.ai, aiMissing: fresh.aiMissing, choiceNotes: fresh.choiceNotes ?? x.choiceNotes };
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
  const ai = ownAiParts(ctx, n, it);
  const aiChoice = it.choices.find((x) => x.id === 'AI');
  const exit = aiChoice?.tier === 'EXIT';
  const total = totalValue(acct, view);
  return {
    short: `比 52 週高點低 ${fmtPct(-dd, 1)}，門檻是 20%`,
    why: `${t} ${late ? `在 ${md(trig.date)} ` : ''}收盤 ${fmtPx(px)}，比 52 週高點 ${fmtPx(high)} 低 ${fmtPct(-dd, 1)}。慢規則：跌超過 20% 就賣掉一半。它是底線：你沒有另外決定時照它做；這是保險，不是判斷它會繼續跌。${late ? '當時變動不到總資產 5%，所以沒有當天通知，併到這份月報。' : ''}`,
    gauge: Number.isFinite(dd) ? drawdownGauge(dd) : undefined,
    rule: RULE.slow,
    facts: [{ label: '這一筆占總資產', value: fmtPct((sh * (c ? c[view.i] : 0)) / total, 1), note: '5% 以上當天通知，不到 5% 併入月報。' }],
    math: [`目前自選持有 ${cur} 股 → 賣掉一半 = ${sh} 股（四捨五入到整股）`],
    chart: t,
    ai: ai.ai,
    aiMissing: ai.aiMissing,
    choiceNotes: {
      RULE: `賣一半，錢交給核心。之後站回 200 日均線連續 10 天，再買回到標準比重。${exit ? `AI 建議的是出清：選這個（沒有照 AI）的話，${SILENCE_NOTE}。` : ''}`,
      ...(aiChoice
        ? {
            AI: exit
              ? '全部賣出、錢回核心，這檔移出自選，論點檔結案。想先改論點可以按「拿去討論」，改完再回來選一項。'
              : 'AI 判斷的是論點有沒有壞，不是會不會繼續跌。大盤或產業帶動的下跌，正是慢規則在 2000–2002、2008、2022 年有用的情況。選這個就不賣；規則照樣記成已經減半，之後不再為這次下跌提醒。',
          }
        : {}),
      SKIP: `要寫一句為什麼這次不做。${SKIP.own}${exit ? `沒有照 AI 出清，${SILENCE_NOTE}。` : ''}`,
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
  const ai = ownAiParts(ctx, n, it);
  const aiChoice = it.choices.find((x) => x.id === 'AI');
  return {
    short: `站回 200 日均線連續 10 天以上（${fmtSigned(rel, 1)}）`,
    why: `${t} 收盤 ${fmtPx(px)}，在 200 日均線 ${fmtPx(ma)} 之上（${fmtSigned(rel, 1)}）${trig.date !== view.date ? `，${md(trig.date)} 就已經連續站上 10 天` : `，已連續 ${run} 天`}。慢規則：之前減半的部分買回來，回到標準比重 ${fmtPct(std, 1)}。`,
    gauge: Number.isFinite(rel) ? maGauge(rel, `${t} 收盤相對 200 日均線`, false) : undefined,
    rule: RULE.slow,
    math: [`標準比重 ${fmtPct(std, 1)} × 總資產 ${fmtMoney(total)} ÷ 前一日收盤 ${fmtPx(px)} = ${Math.floor((std * total) / px)} 股`, `已有 ${cur} 股 → 買 ${sh} 股`],
    chart: t,
    ai: ai.ai,
    aiMissing: ai.aiMissing,
    choiceNotes: {
      RULE: '買回到標準比重，錢從核心出。',
      ...(aiChoice ? { AI: aiChoice.tier === 'EXIT' ? '全部賣出、錢回核心，這檔移出自選，論點檔結案。' : '不買回，維持減半。之後規則符合條件時會再提一次。' } : {}),
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

/**
 * 入金補這檔自選補到多少（T43，design_v2 §10 第 50 點）：
 *   沒縮放：「補到標準比重 5.0%」（減半中：「補到標準比重 5.0% 的一半 2.5%（減半中）」）
 *   自選各檔合計超過自選比例：「入金補到 3.1%（自選合計超過預算，入金照比例少補）；加回補到標準比重 5.0%」
 */
export function depositFillText(acct: Account, ticker: string): string {
  const r = acct.rule.own[ticker];
  const fill = ownDepositFill(acct.rule, acct.cfg, ticker);
  if (!r || fill === null) return '';
  const half = r.applied === 'HALF';
  const plain = r.stdWeight * (half ? 0.5 : 1);
  if (Math.abs(fill - plain) < 1e-9) return `補到標準比重 ${fmtPct(r.stdWeight, 1)}${half ? ` 的一半 ${fmtPct(plain, 1)}（減半中）` : ''}`;
  const why = ownDepositScale(acct.rule, acct.cfg.ratio.own) < 1 ? '自選合計超過預算，入金照比例少補' : `入金最多補到 ${fmtPct(acct.cfg.ownCapTo)}`;
  return `入金補到 ${fmtPct(fill, 1)}（${why}）；${half ? '減半中，' : ''}加回補到標準比重 ${fmtPct(r.stdWeight, 1)}`;
}

/** 自選各檔標準比重合計超過自選比例時，入金清單多的那一句（T43）。 */
function ownScaleNote(acct: Account): string {
  const k = ownDepositScale(acct.rule, acct.cfg.ratio.own);
  if (k >= 1) return '';
  return `自選各檔的目標合計 ${fmtPct(acct.cfg.ratio.own / k, 1)}，超過自選比例 ${fmtPct(acct.cfg.ratio.own)}：入金照比例少補自選（只補到各檔目標的 ${fmtPct(k, 0)}），多的錢去動能與核心，自選桶慢慢回到預算。減半之後的加回仍補到各檔的標準比重。`;
}

/** 每一行現在占多少、目標是多少（入金、出金、改比例的清單用）。deposit：入金清單，補自選的那一行寫「補到標準比重 X%」（T43）。 */
function lineFacts(ctx: ExplainContext, lines: OrderLine[], deposit = false): Fact[] {
  const { acct, view } = ctx;
  const total = totalValue(acct, view);
  const slot = momSlotTarget(acct.cfg, total, acct.rule.effPrev ?? 1);
  return lines.map((l) => {
    const c = closeOf(view, l.ticker);
    const px = c ? c[view.i] : NaN;
    const cur = ((acct.lots[l.bucket][l.ticker] ?? 0) * px) / total;
    let tgt: number | null = null;
    const ownRule = l.bucket === 'own' ? acct.rule.own[l.ticker] : undefined;
    if (ownRule) tgt = ownRule.stdWeight * (ownRule.applied === 'HALF' ? 0.5 : 1);
    if (l.bucket === 'mom' && acct.rule.heldMom.includes(l.ticker)) tgt = slot / total;
    // 入金補自選（T43）：補的是標準比重（減半中只補到一半）；自選各檔合計超過自選比例時入金照比例少補，寫出實際補到多少
    const ownFill = deposit && ownRule && l.shares > 0 ? `目前 ${fmtPct(cur, 1)}，${depositFillText(acct, l.ticker)}` : null;
    const why = ownFill ? ownFill : l.reason === '單檔上限' ? '出金後會超過單檔上限 15%，先減回 10%' : l.reason === '跨桶上限' ? '自選＋動能合計超過上限' : tgt !== null ? `目前 ${fmtPct(cur, 1)}，目標 ${fmtPct(tgt, 1)}` : `目前 ${fmtPct(cur, 1)}`;
    return { label: `${BUCKET_NAME[l.bucket]} ${l.ticker}`, value: sharesText(l.shares), note: why };
  });
}

/**
 * 清單做完之後三桶占總資產的比例（core_ai §3.11）：把清單（composed 的每一行，含核心吸收的部分）照 view 的價格套到目前的持股上，
 * 核心含做完之後的現金（出金已經在 cashAfter 扣掉要轉出的金額）。未分類的持股只算在總資產裡。算不出來（缺價格）回 null。
 * except：這份清單的編號。其他已回覆、還沒填快照的清單先當成做完了（和合成清單時的 cashAfter 同一個起點，T38）。
 */
export function bucketSharesAfter(acct0: Account, view: MarketView, composed: Pick<Composed, 'lines' | 'cashAfter'>, except?: number): { own: number; mom: number; core: number } | null {
  try {
    const acct = afterOpenLists(acct0, view, { except });
    const lots = { own: { ...acct.lots.own }, mom: { ...acct.lots.mom }, core: { ...acct.lots.core } };
    for (const l of composed.lines) lots[l.bucket][l.ticker] = (lots[l.bucket][l.ticker] ?? 0) + l.shares;
    const val = (m: Record<string, number>) => Object.entries(m).reduce((a, [t, n]) => a + (n ? n * priceOf(view, t) : 0), 0);
    const own = val(lots.own);
    const mom = val(lots.mom);
    const core = val(lots.core) + composed.cashAfter;
    const total = own + mom + core + val(acct.lots.unc);
    if (!(total > 0)) return null;
    return { own: own / total, mom: mom / total, core: core / total };
  } catch {
    return null;
  }
}

/** 清單做完之後核心裡短債與現金那一邊占核心的比例（allocation_redesign §1.4）；算不出來（缺價格、核心是 0）回 null。 */
export function coreBondAfter(acct: Account, view: MarketView, composed: Pick<Composed, 'lines' | 'cashAfter'>, except?: number): number | null {
  try {
    const c = coreAfterList(acct, view, composed, except);
    const pb = c.price(c.bondTicker);
    const chk = coreBandCheck(c.bondShares * pb + c.cash, c.coreShares * c.price(c.cfg.coreTicker) + c.bondShares * pb + c.cash, c.cfg);
    return chk.core > 0 ? chk.s : null;
  } catch {
    return null;
  }
}

/**
 * 「做完之後」那一列（入金、出金、改比例的清單；core_ai §3.11）：自選 23.1%（預算 20%）、動能 28.4%（30%）、核心 48.5%（50%）；
 * 後面多一項核心的比例（allocation_redesign §1.4）：核心裡 SGOV 與現金 19.2%（目標 20%）。
 */
export function afterFact(acct: Account, view: MarketView, composed: Pick<Composed, 'lines' | 'cashAfter'> | undefined, except?: number): Fact | null {
  const b = composed ? bucketSharesAfter(acct, view, composed, except) : null;
  if (!b || !composed) return null;
  const r = acct.cfg.ratio;
  const s = coreBondAfter(acct, view, composed, except);
  const { bond, band } = coreCfg(acct.cfg);
  const core = s === null ? '' : `；核心裡 ${acct.bondTicker} 與現金 ${fmtPct(s, 1)}（目標 ${fmtPct(bond)}）`;
  return {
    label: '做完之後',
    value: `自選 ${fmtPct(b.own, 1)}（預算 ${fmtPct(r.own)}）、動能 ${fmtPct(b.mom, 1)}（${fmtPct(r.strat)}）、核心 ${fmtPct(b.core, 1)}（${fmtPct(r.core)}）${core}`,
    note: `照前一日收盤估的三桶占總資產；比例是風險預算，平常不會為了拉回比例下單。核心裡的比例在 ${fmtPct(bond - band)}～${fmtPct(bond + band)} 之內不調，超出的話下一份月報調回。`,
  };
}

/** 核心比例調回（F26，allocation_redesign §1.3）。 */
function coreBandExplain(ctx: ExplainContext, n: Notif, it: Item): Explain {
  const { acct } = ctx;
  const { bond, band } = coreCfg(acct.cfg);
  const cb = n.monthly?.input.coreBand;
  const lines = it.choices[0]?.lines ?? [];
  const range = `${fmtPct(bond - band)}～${fmtPct(bond + band)}`;
  return {
    short: it.title.replace(/^核心比例調回：/, ''),
    why: `${it.why ?? ''}${it.note?.includes('一次性') ? it.note : ''}`,
    rule: RULE.core,
    facts: cb
      ? [
          { label: `${acct.bondTicker} 與現金占核心`, value: fmtPct(cb.s, 1), note: `這份月報其他單做完之後的比例。目標 ${fmtPct(bond)}，${range} 之內不調。` },
          { label: '核心的市值', value: fmtMoney(cb.core), note: `調回後 ${acct.bondTicker} 與現金約 ${fmtMoney(cb.core * bond)}。` },
        ]
      : [],
    math: lines.map((l) => `${BUCKET_NAME[l.bucket]} ${l.ticker}：${sharesText(l.shares)}`),
    choiceNotes: { DO: '核心裡兩檔互換，三桶的比例不變。', SKIP: `不用寫理由。下個月月報會重算：還在 ${range} 之外就再列一次，回到界線內就不列。` },
  };
}

/** 改比例那一列「動能相對大盤」（設計 §2.1 第 7 點，core_ai §3.11）：落後事件中寫從哪天開始，不在就寫不在。沒有策略檢討的狀態（示範）是 null。 */
export function momRelFact(st: StrategyReviewState | null | undefined): Fact | null {
  if (!st || !(st.peak > 0)) return null;
  const lag = Math.max(0, 1 - st.rel / st.peak);
  return { label: '動能相對大盤', value: st.eventStart ? `比高點落後 ${fmtPct(lag)}（這次從 ${st.eventStart} 開始）` : `比高點落後 ${fmtPct(lag)}，不在落後事件中`, note: '純動能部位相對大盤的累積表現，比它自己的高點落後多少；落後 20% 以上算一次落後事件。' };
}

/** 入金、出金、改比例的清單：「做完之後」那一列在還沒填快照前每次讀時重算（回覆後用合成的清單；core_ai §3.11）。 */
export function liveCashflow(ctx: ExplainContext, n: Notif, it: ItemX): Explain {
  const x = it.x ?? explainItem(ctx, n, it);
  if (n.status !== 'PENDING' && n.status !== 'RESPONDED') return x;
  const f = afterFact(ctx.acct, ctx.view, n.composed ?? n.preview, n.id);
  if (!f) return x;
  const facts = x.facts ?? [];
  const k = facts.findIndex((y) => y.label === '做完之後');
  return { ...x, facts: k >= 0 ? facts.map((y, j) => (j === k ? f : y)) : [f, ...facts] };
}

/**
 * 入金、出金、改比例產生時已經算進去的其他清單（還沒填快照的；T38）：「#3 月報（等你下單）」。
 * 這份清單的股數是假設那幾份照目前的選擇做完之後算的，所以每一檔的「目前」也從那之後算。
 */
function openBefore(acct: Account, n: Notif): Fact | null {
  const xs = acct.notifs.filter((o) => o.id < n.id && o.kind !== 'INFO' && ((o.status === 'RESPONDED' && !!o.composed) || (o.status === 'PENDING' && o.items.length > 0)));
  if (!xs.length) return null;
  return {
    label: '先算進',
    value: xs.map((o) => `${notifName(o)}（${o.status === 'RESPONDED' ? '等你下單' : '等你決定'}）`).join('、'),
    note: '這幾份清單還沒填快照，這份先當成它們照目前的選擇做完了才算，所以不會把同一張單再列一次；那幾份之後改了決定，這份不會跟著改。',
  };
}

function cashflow(ctx: ExplainContext, n: Notif, it: Item): Explain {
  const { acct } = ctx;
  const lines = it.choices[0].lines;
  const core = acct.cfg.coreTicker;
  const after = afterFact(acct, ctx.view, n.composed ?? n.preview, n.id);
  // 入金、出金、改比例的股數是從還沒填快照的其他清單做完之後算的（T38）：每一檔的「目前」也從那之後算
  const open = it.f === 'F11' || it.f === 'F12' || it.f === 'F13' ? openBefore(acct, n) : null;
  const head = [...(after ? [after] : []), ...(open ? [open] : [])];
  if (open) ctx = { ...ctx, acct: afterOpenLists(acct, ctx.view, { before: n.id, pending: true }) };
  if (it.f === 'F11') {
    const amt = n.deposit ?? 0;
    return {
      short: `入金 ${fmtMoney(amt)}：補低於目標最多的格子，其餘進核心`,
      why: `你入金 ${fmtMoney(amt)}。入金只買不賣：先補「離目標最遠」的格子${lines.length ? `（${lines.map((l) => l.ticker).join('、')}）` : ''}，剩下的交給核心，照比例買 ${core} 與 ${acct.bondTicker}。已經高於目標的股票不會再買。${ownScaleNote(ctx.acct)}`,
      rule: RULE.deposit,
      facts: [...head, ...lineFacts(ctx, lines, true)],
    };
  }
  if (it.f === 'F12') {
    const amt = n.withdraw ?? 0;
    const cap = lines.filter((l) => l.reason === '單檔上限').map((l) => l.ticker);
    return {
      short: `出金 ${fmtMoney(amt)}：只賣不買${cap.length ? `，${cap.join('、')} 先減回 10%` : ''}`,
      why: `你要出金 ${fmtMoney(amt)}。出金只賣不買${cap.length ? `：${cap.join('、')} 在出金後會超過總資產 15%，所以先在這份清單減回 10%，賣得的錢抵出金` : ''}；其餘依序從：動能高於每檔目標的部分（賣回目標）→ 核心（照比例賣 ${core} 與 ${acct.bondTicker}，帳上現金先用）→ 動能其餘的部分 → 最後才是自選。清單做完後，從券商轉出 ${fmtMoney(amt)}，再回來填快照。`,
      rule: RULE.withdraw,
      facts: [...head, ...lineFacts(ctx, lines)],
    };
  }
  if (it.f === 'F13') {
    const m = /(\d+% \/ (\d+)% \/ \d+%) → (\d+% \/ (\d+)% \/ \d+%)/.exec(it.title);
    // Strategy 的比例有變才放「動能相對大盤」（這次相對回撤的狀態）
    const rel = m && m[2] !== m[4] ? momRelFact(ctx.strategy) : null;
    // 自選改成 0%、或從 0% 改回（T39b，設計 §10 第 47 點）
    const ownOld = m ? parseInt(m[1], 10) : NaN;
    const ownNew = m ? parseInt(m[3], 10) : NaN;
    const ownWhy =
      ownOld > 0 && ownNew === 0
        ? '自選改成 0%：每一檔全部賣掉，原本的標準比重先記下來，之後改回來時照它（照新舊比例縮放）買回；0 股期間不跑 AI 審查與條件監測。'
        : ownOld === 0 && ownNew > 0
          ? '自選從 0% 改回：每一檔的標準比重用改成 0% 時記下的（照新舊比例縮放），沒有記錄的用推薦的標準比重，照它買回。'
          : '自選每一檔的股數和標準比重照新舊比例縮放，';
    return {
      short: m ? `比例 ${m[1]} → ${m[3]}` : '改比例',
      why: `你把自選／動能／核心的比例${m ? `從 ${m[1]} 改成 ${m[3]}` : '改了'}。${ownWhy}動能每檔的目標照新的比例重算，差額由核心吸收。原本的比例會繼續記在紀錄裡，之後可以回頭看這次調整是加分還是扣分。`,
      rule: RULE.ratio,
      facts: [...head, ...(rel ? [rel] : []), ...lineFacts(ctx, lines), { label: '提醒', value: '', note: '在動能落後大盤的時候把它調成 0，等於在相對低點放棄它。系統不會擋，由你決定。' }],
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
    const note = findNote(ctx.aiNotes, 'CONDITION', t, n.date, it.runIds);
    return {
      gauge: c ? contextDrawdown(c, view.i) : undefined,
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
  const note = findNote(ctx.aiNotes, 'REVIEW', t, n.date, it.runIds);
  if (it.brk?.type === 'B') {
    // 乙類（own_thesis §1.10）：AI 判斷前提不成立、你沒有為這件事定過出場條件
    const premise = /前提「(.+)」3 票/.exec(it.title)?.[1] ?? it.brk.premiseId;
    return {
      gauge: c ? contextDrawdown(c, view.i) : undefined,
      short: `AI 審查 3 票都判前提「${premise}」不成立`,
      why: `規則沒有動作。AI 審查 ${t} 時，3 票都判前提「${premise}」不成立，建議${tier ? TIER_NAME[tier] : ''}（${sharesText(sh)}）。${it.why ?? ''}`,
      rule: `${RULE.ai}AI 判斷的是論點有沒有壞，不是股價會不會繼續跌。`,
      math: [tier === 'EXIT' ? `自選持有 ${cur} 股 → 全部賣出` : `目前 ${cur} 股 → ${sharesText(sh)}`],
      chart: t,
      ai: note,
      aiMissing: !note,
      choiceNotes: {
        AI: tier === 'EXIT' ? '全部賣出、錢回核心，這檔移出自選，論點檔結案。' : '賣一半，錢回核心；慢規則的狀態跟著變成減半。',
        SKIP: it.reasonRequired ? '部位不動。要寫一句為什麼不同意，下一次審查會看到。想改論點可以先按「拿去討論」。' : `${SKIP.ai}想改論點可以先按「拿去討論」。`,
      },
    };
  }
  const raise = tier === 'RAISE';
  return {
    gauge: c ? (raise ? aboveMaGauge(c, view.i) : contextDrawdown(c, view.i)) : undefined,
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

/** 甲類（own_thesis §1.10）：你定的條件成立 → 照當時的決定（預設），不重新討論。 */
function ownCond(ctx: ExplainContext, n: Notif, it: Item): Explain {
  const { acct, view } = ctx;
  const t = it.ticker!;
  const doIt = it.choices.find((c) => c.id === 'DO');
  const tier = doIt?.tier;
  const sh = sharesOf(doIt?.lines ?? [], t);
  const c = closeOf(view, t);
  const cur = acct.lots.own[t] ?? 0;
  const m = /你在 (\d{4}-\d{2}-\d{2}) 定的條件「(.+)」成立/.exec(it.title);
  // 由定期審查確認成立的（審查三票、或依你指名的網頁來源，T53）：AI 說明是那一次審查的，引用與原始網址列在這裡（理由寫「引用在網站」）
  const note = noteByRun(ctx.aiNotes, 'CONDITION', it.runIds) ?? noteByRun(ctx.aiNotes, 'REVIEW', it.runIds) ?? findNote(ctx.aiNotes, 'CONDITION', t, n.date, it.runIds);
  return {
    gauge: c ? contextDrawdown(c, view.i) : undefined,
    short: `你定的條件成立：${m?.[2] ?? ''}`,
    why: `規則沒有動作。這是你${m ? `在 ${md(m[1])} ` : '之前'}定的條件「${m?.[2] ?? ''}」，當時決定成立時${tier ? TIER_NAME[tier] : ''}。確認：${it.why ?? ''}`,
    rule: '你事先定的條件成立時，照你當時的決定做，不重新討論；系統只負責確認它成立了，股數由程式換算。每條條件只會成立一次。',
    math: [tier === 'EXIT' ? `自選持有 ${cur} 股 → 全部賣出` : `目前 ${cur} 股 → ${sharesText(sh)}`],
    chart: t,
    ai: note,
    choiceNotes: {
      DO: tier === 'EXIT' ? '全部賣出、錢回核心，這檔移出自選，論點檔結案。' : '賣一半，錢回核心；慢規則的狀態跟著變成減半。',
      SKIP: '要寫一句為什麼這次不做。這條條件不會再觸發；要再監測就重新定一條。',
    },
  };
}

function hard(ctx: ExplainContext, n: Notif, it: Item): Explain {
  const t = it.ticker!;
  const code = /(PENDING_MA|ACCOUNTING|REGULATORY)/.exec(it.title)?.[1] ?? '';
  const name = { PENDING_MA: '被收購（股價已經貼近收購價，動能的前提不再適用）', ACCOUNTING: '會計問題（財報重編、更換會計師或延遲申報）', REGULATORY: '重大監管事件' }[code] ?? code;
  const note = findNote(ctx.aiNotes, 'HARD', t, n.date, it.runIds);
  const byRule = it.choices.some((c) => c.id === 'DO');
  const mom = it.choices.some((c) => c.lines.some((l) => l.bucket === 'mom'));
  // 動能持股的 AI 建議：不做 = 名單不變；同一類事件在期間內不再通知（momentum_ai §3.5）
  const aiNotes = mom ? { AI: '照 AI 出場：這一檔離開動能名單，空出來的位置下個月照排名遞補。', SKIP: `不做：這一檔留在動能名單，之後照排名進出。同一類事件 ${hardToldDays(code)} 天內不再通知。` } : { AI: '照 AI 出場。', SKIP: SKIP.ai };
  return {
    short: `硬事件：${name.split('（')[0]}`,
    why: `${t} 出現硬事件：${name}。${byRule ? '這一類由規則直接提出' : 'AI 讀過申報原文後建議提早出場'}，要你確認才會做。${note ? note.summary : ''}`,
    chart: t,
    ai: note,
    aiMissing: !byRule && !note,
    choiceNotes: { DO: '確認出場，空出來的位置下個月照排名遞補。', AI: aiNotes.AI, SKIP: byRule ? '不確認的話，下個月月報會再列一次。' : aiNotes.SKIP },
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
    if (it.kind === 'OWN_COND') return ownCond(ctx, n, it);
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
      case 'F26':
        return coreBandExplain(ctx, n, it);
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
  // 2026-11-22 起（allocation_redesign §1.2）：「錢交給核心（VOO 八成、SGOV 兩成）」「從核心拿錢（…）」「帳上的現金買 SGOV」「核心比例」
  const mix = /^(?:錢交給核心|從核心拿錢)（(.+成.*|.+%.*)）$/.exec(reason)?.[1];
  if (mix && !reason.includes('崩盤')) return reason.startsWith('錢交給核心') ? `清單做完會多出現金，交給核心，照比例買（${mix}）` : `不夠的錢從核心照比例拿（${mix}；帳上現金先用）`;
  if (reason.startsWith('帳上的現金買')) return `帳上原本的現金順便買成 ${acct.bondTicker}（現金本來就算在 ${acct.bondTicker} 那一邊，核心的比例不變）`;
  if (reason === '核心比例') return `核心比例調回 ${fmtPct(coreCfg(acct.cfg).bond)}`;
  // 舊通知的寫法（崩盤規則退場之前）
  if (reason.startsWith('錢交給核心')) return reason.includes('崩盤') ? `清單做完會多出現金，交給核心（崩盤規則啟動中：一半買 ${acct.cfg.coreTicker}、一半放短債）` : `清單做完會多出現金，交給核心買 ${acct.cfg.coreTicker}`;
  if (reason.startsWith('從核心拿錢')) return reason.includes('短債') ? '不夠的錢先從核心的短債拿' : `不夠的錢從核心拿（賣 ${acct.cfg.coreTicker}）`;
  return reason;
}
