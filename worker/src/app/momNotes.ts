// T32d：動能持股的事件與「要看的事」（momentum_ai_design_2026-11-15 §3.6）、否決紀錄（§3.7）。
//
//   動能持股的事件不觸發任何 AI（三個硬事件代碼除外，F19），只記錄與顯示：
//     持股頁：最近 90 天的 sec_events（含只記錄的），以及進場時的附註（「准許，附註」）。
//     「要看的事」（momAttention，純函式；回傳和自選股的 ownAttention 相同的形狀，放在同一個 MonthlyContext.attention，src = 'mom'）：
//       DROP_21D    最近 21 個交易日跌 20% 以上（momDropLine，取代動能的 F20，不呼叫 AI）      月報每檔每 1 個月一次
//       LATE_VETO   進場審查在你買進（填快照）之後才回來的否決（§3.3 的第三種月報狀態）         發生後的第一份月報
//       ENTRY_NOTE  進場時是「准許，附註」、而且還在名單上                                     不列進月報（進場那份月報的項目已經有）
//     月報多久列一次用 acct.mom.attnShown 記（和自選股的 OwnMeta.attnShown 同一套 dueAttention；頻率用「月」算，T37 的決定）。
//   否決紀錄（vetoEpisodes，純函式）：每一次 AI 否決一列，連續沿用的月份算同一次；網站再補上之後 3、6 個月的相對報酬。
import { momDropLine, type DropEvent } from '../ai/detect';
import { ENTRY_CODE_TEXT } from '../ai/momEntry';
import { clone, type Account, type Attention, type MarketView } from '../engine';
import { buildMarketView } from '../data/marketView';
import { loadSeries } from '../data/store';
import { eventLabel, eventSource } from './eventText';
import { loadEvents, sectorEtfs, type SecEventRow } from './filings';
import { loadReviewsFor, type MomReview } from './momAi';
import { dueAttention, toAttention, type AttnHit } from './thesis';

// ---------------------------------------------------------------- 事件的白話（T34 起和自選股的持股頁、討論包共用 eventText.ts）

export { eventLabel, eventSource } from './eventText';

const toDropEvent = (e: SecEventRow): DropEvent => ({ date: e.event_date, label: eventLabel(e), source: eventSource(e) });

// ---------------------------------------------------------------- 「要看的事」

/** 判斷一種動能的「要看的事」需要的東西（一檔）。events：這一檔的事件；reviews：這一檔的進場審查（新到舊）。 */
export interface MomAttnCtx {
  ticker: string;
  acct: Pick<Account, 'lots' | 'rule' | 'notifs' | 'cfg'>;
  view: Pick<MarketView, 'date' | 'close' | 'i'>;
  axis: string[];
  events: SecEventRow[];
  reviews: MomReview[];
  sector: string | null;
  /** 目前的排名（第幾名）；不在股票池是 null。 */
  rank: number | null;
}

export interface MomAttnKind {
  kind: string;
  /** false = 只在持股頁顯示，不列進月報。 */
  monthly: boolean;
  detect(ctx: MomAttnCtx): Omit<AttnHit, 'ticker' | 'kind' | 'src'>[];
}

const heldMom = (acct: MomAttnCtx['acct'], t: string) => (acct.lots.mom[t] ?? 0) > 0;

/** 這個月份的月報（最新一份、沒有被取代的）裡這一檔的 F1 項目。 */
function entryItem(acct: MomAttnCtx['acct'], month: string, ticker: string) {
  for (const n of [...acct.notifs].reverse()) {
    if (n.monthly?.input.month !== month || n.status === 'SUPERSEDED' || n.status === 'CANCELLED') continue;
    const it = n.items.find((i) => i.f === 'F1' && i.ticker === ticker && !i.cancelled);
    if (it) return { n, it };
  }
  return null;
}

/**
 * 動能的「要看的事」，一種一個物件（加一種 = 在這裡加一個物件）。
 * 月報的頻率用「月」算（設計寫的「每檔每 30 天」= 每 1 個月，和 T37 的自選股一致）。
 */
export const MOM_ATTN: MomAttnKind[] = [
  {
    // 單月大跌（§3.6，取代動能的 F20）：動能持股最近 21 個交易日跌 20% 以上
    kind: 'DROP_21D',
    monthly: true,
    detect({ ticker, acct, view, axis, events, sector, rank }) {
      if (!heldMom(acct, ticker)) return [];
      const d = momDropLine({ axis, close: view.close, ticker, market: acct.cfg.coreTicker, sector, i: view.i, events: events.filter((e) => e.code !== 'CONDITION_HINT').map(toDropEvent), rank, exitRank: acct.cfg.exitRank });
      return d ? [{ key: 'DROP_21D', every: 1, since: view.date, text: d.text }] : [];
    },
  },
  {
    // 買進之後才回來的否決（§3.3 的第三種月報狀態：已經填快照，只更新項目、列進這裡）
    kind: 'LATE_VETO',
    monthly: true,
    detect({ ticker, acct, reviews }) {
      if (!heldMom(acct, ticker)) return [];
      const r = reviews.find((x) => x.lateVerdict === 'VETO');
      if (!r) return [];
      const hit = entryItem(acct, r.month, ticker);
      // 月報還沒回覆或還沒填快照時已經補推過（那兩種不列）；找不到那一項的不列。
      // 帳戶頁沒有排除持有中動能股的功能（排除只在月報項目上），文字照實寫怎麼做（T34 走一遍的缺口）
      if (!hit?.it.lateVeto || hit.it.lateVeto.push) return [];
      const zh = ENTRY_CODE_TEXT[r.reasonCode ?? hit.it.lateVeto.code] ?? '進場審查的理由';
      return [{ key: `LATE_VETO@${r.month}`, every: null, since: hit.it.lateVeto.date, text: `${ticker}：進場審查在你買進之後回來，3 票否決（${zh}）。出場照排名；不想留的話，自己賣掉、填快照時記在動能，下次月報再列 ${ticker} 時按「排除」` }];
    },
  },
  {
    // 進場時是「准許，附註」而且還在名單上（§3.6）：只在持股頁
    kind: 'ENTRY_NOTE',
    monthly: false,
    detect({ ticker, acct, reviews }) {
      if (!acct.rule.heldMom.includes(ticker)) return [];
      const r = reviews[0];
      if (!r || r.decision !== 'ALLOW_WATCH' || !r.watchReason) return [];
      const n = [...acct.notifs].reverse().find((x) => x.monthly?.input.month === r.month && x.status !== 'SUPERSEDED' && x.status !== 'CANCELLED');
      return [{ key: `ENTRY_NOTE@${r.month}`, every: null, since: n?.date ?? `${r.month}-01`, text: `${ticker} 進場時的附註：${r.watchReason}` }];
    },
  },
];

const NOT_MONTHLY = new Set(MOM_ATTN.filter((k) => !k.monthly).map((k) => k.kind));
/** 月報要考慮的（拿掉只在持股頁顯示的種類，例如 ENTRY_NOTE）。 */
export const forMonthly = (hits: AttnHit[]): AttnHit[] => hits.filter((x) => !NOT_MONTHLY.has(x.kind));

export interface MomAttnInput {
  acct: MomAttnCtx['acct'];
  view: MomAttnCtx['view'];
  axis: string[];
  /** 動能持股的事件（不限這幾檔也可以，會照代號分）。 */
  events: SecEventRow[];
  /** 動能持股的進場審查（新到舊）。 */
  reviews: MomReview[];
  sectors: Record<string, string>;
  /** 目前的排名（代號由高到低）。 */
  rankOrder: string[];
}

/** 動能持股（名單上或有動能部位的）。 */
export const momHoldings = (acct: Pick<Account, 'lots' | 'rule'>): string[] => [...new Set([...acct.rule.heldMom, ...Object.keys(acct.lots.mom).filter((t) => (acct.lots.mom[t] ?? 0) > 0)])].sort();

/**
 * 動能持股的「要看的事」（momentum_ai §3.6）：逐檔逐種判斷，回傳現在成立的全部（不看頻率；持股頁就是這一份）。
 * 本身不讀資料庫；tickers 不給就是全部的動能持股。
 */
export function momAttention(inp: MomAttnInput, tickers: string[] = momHoldings(inp.acct), kinds: MomAttnKind[] = MOM_ATTN): AttnHit[] {
  const out: AttnHit[] = [];
  for (const ticker of tickers) {
    const k = inp.rankOrder.indexOf(ticker);
    const ctx: MomAttnCtx = { ticker, acct: inp.acct, view: inp.view, axis: inp.axis, events: inp.events.filter((e) => e.ticker === ticker), reviews: inp.reviews.filter((r) => r.ticker === ticker), sector: inp.sectors[ticker] ?? null, rank: k >= 0 ? k + 1 : null };
    for (const kind of kinds) for (const x of kind.detect(ctx)) out.push({ ticker, kind: kind.kind, src: 'mom', ...x });
  }
  return out;
}

/** 事件往回看幾個日曆天（持股頁的事件列表；21 個交易日的大跌也在這裡面）。 */
export const MOM_EVENT_DAYS = 90;
const minusDays = (d: string, n: number) => new Date(Date.parse(d) - n * 86400_000).toISOString().slice(0, 10);

/** 讀資料庫組 momAttention 的輸入：事件、審查、產業 ETF，以及含產業 ETF 的價格（view 不一定有產業 ETF）。 */
async function momInput(db: D1Database, acct: Account, date: string, tickers: string[], rankOrder: string[]): Promise<MomAttnInput> {
  const sectors = await sectorEtfs(db, tickers);
  const core = acct.cfg.coreTicker;
  const { view, axis } = buildMarketView(await loadSeries(db, [...new Set([core, ...tickers, ...Object.values(sectors)])]), date, core);
  const since = minusDays(date, MOM_EVENT_DAYS);
  const events = (await Promise.all(tickers.map((t) => loadEvents(db, { ticker: t, since })))).flat().filter((e) => e.event_date <= date);
  return { acct, view, axis, events, reviews: await loadReviewsFor(db, tickers), sectors, rankOrder };
}

/**
 * 每日流程在產生月報前（momentum_ai §3.6）：算這個月該列的動能「要看的事」，更新 acct.mom.attnShown。
 * 回傳新的帳戶（acct 不改）與該列的清單（接在自選股的後面，放進同一個 attention）。讀資料庫，所以不在引擎裡。
 */
export async function monthMomAttention(db: D1Database, acct: Account, view: Pick<MarketView, 'date'>, rankOrder: string[]): Promise<{ acct: Account; items: Attention[] }> {
  const tickers = momHoldings(acct);
  if (!tickers.length) return { acct, items: [] };
  const hits = forMonthly(momAttention(await momInput(db, acct, view.date, tickers, rankOrder), tickers));
  const { due, shown } = dueAttention(hits, acct.mom.attnShown ?? {}, view.date);
  if (!due.length) return { acct, items: [] };
  const next = clone(acct);
  next.mom.attnShown = { ...(next.mom.attnShown ?? {}), ...shown };
  return { acct: next, items: due.map(toAttention) };
}

/** 持股頁的動能那一塊：最近 90 天的事件（新到舊）與現在成立的「要看的事」（全部，不看頻率）。不是動能持股回傳 null。 */
export interface HoldingMom {
  events: { date: string; label: string; source: string }[];
  attention: Attention[];
}

export async function holdingMom(db: D1Database, acct: Account, view: Pick<MarketView, 'date'>, ticker: string, rankOrder: string[]): Promise<HoldingMom | null> {
  if (!momHoldings(acct).includes(ticker)) return null;
  const inp = await momInput(db, acct, view.date, [ticker], rankOrder);
  return {
    events: inp.events.filter((e) => e.code !== 'CONDITION_HINT').map((e) => ({ date: e.event_date, label: eventLabel(e), source: eventSource(e) })),
    attention: momAttention(inp, [ticker]).map(toAttention),
  };
}

// ---------------------------------------------------------------- 否決紀錄（§3.7）

export interface VetoEpisode {
  ticker: string;
  /** 決策日（法庭的執行編號開頭的日期）。 */
  date: string;
  code: string | null;
  runId: string | null;
  /** 這次否決用在哪幾個月份的月報（第一個是開法庭的月份，之後是沿用的）。 */
  months: string[];
  /** 第一個月由誰遞補（月報之後才回來的否決沒有遞補）。 */
  replacedBy: string | null;
  /** 月報之後才回來（只是建議，那一檔照規則買進了）。 */
  late: boolean;
}

/**
 * 每一次 AI 否決一列（momentum_ai §3.7）：連續沿用的月份算同一次（沿用的列 carried_from 指到同一次法庭）。
 * rows：AI 法庭的否決列（loadVetoReviews），舊到新。回傳新到舊。
 */
export function vetoEpisodes(rows: MomReview[]): VetoEpisode[] {
  const out: VetoEpisode[] = [];
  const byRun = new Map<string, VetoEpisode>();
  for (const r of [...rows].sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0))) {
    const veto = r.decision === 'VETO' || r.lateVerdict === 'VETO';
    if (r.source !== 'AI' || !veto) continue;
    const ep = r.runId ? byRun.get(`${r.ticker}|${r.runId}`) : undefined;
    if (r.carriedFrom && ep) {
      ep.months.push(r.month);
      continue;
    }
    const e: VetoEpisode = { ticker: r.ticker, date: /^\d{4}-\d{2}-\d{2}/.exec(r.runId ?? '')?.[0] ?? `${r.month}-01`, code: r.reasonCode, runId: r.runId, months: [r.month], replacedBy: r.decision === 'VETO' ? r.replacedBy : null, late: r.decision !== 'VETO' };
    out.push(e);
    if (r.runId) byRun.set(`${r.ticker}|${r.runId}`, e);
  }
  return out.reverse();
}
