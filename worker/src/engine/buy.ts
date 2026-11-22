// 買進前的程式檢查（allocation_redesign §4.0，T83）：自選的每一種買進——先買一半的補滿（F27）、提高到 125%（F23）、
// 你定的加碼條件（F28，T84）、下跌加碼（T84）、之後的候補進場——都先過同一組檢查，任何一項不過就不提。
// buyAllowed 是純函式（只看傳進來的事實）；buyFacts 從帳戶狀態把事實整理出來。
import { dropReviewOpen, priceOf, recommendStdWeights, totalValue, type Account, type MarketView, type OwnMeta } from './account';
import type { OwnApplied, OwnState } from './types';

/** 最近幾個日曆天內有前提被 3 票判不成立就不提買進。 */
export const BUY_BROKEN_DAYS = 30;

/** 檢查要的事實（buyFacts 從帳戶整理；測試直接給）。 */
export interface BuyFacts {
  /** 慢規則狀態與已反映到帳上的目標。 */
  state: OwnState;
  applied: OwnApplied;
  /** 未解除的硬事件標記。 */
  flags: string[];
  /** 有還沒結案的跌幅審查（還在跑、會重派、通知還沒回覆、等月報的減半）。 */
  openDrop: boolean;
  /** 有還沒結案的乙類（AI 判前提不成立的通知，含等月報的）。 */
  openBreak: boolean;
  /** 最近一次有前提被 3 票判不成立的訊號日；沒有是 null。 */
  brokenAt: string | null;
  /** 今天的訊號日。 */
  asOf: string;
  /** 想買幾股；沒給 = 只看狀態，不算上限（例如決定要不要讓 AI 選「提高到 125%」）。 */
  want?: number;
  price?: number;
  /** 總資產。 */
  total?: number;
  /** 這檔現在自選＋動能合計的市值。 */
  held?: number;
  /** 買進後自選＋動能合計最多占總資產多少（crossCapBuy，10%）；null = 不設。 */
  cap?: number | null;
}

/** HALF 減半中／DROP 跌幅審查還沒結案／BREAK 乙類還沒結案／FLAG 硬事件標記／BROKEN 30 天內有前提被判不成立／CAP 上限砍到 0／NONE 沒有要買的股數。 */
export type BuyBlock = 'HALF' | 'DROP' | 'BREAK' | 'FLAG' | 'BROKEN' | 'CAP' | 'NONE';

export interface BuyVerdict {
  ok: boolean;
  /** 過了之後買幾股（超過上限的部分已經砍掉）；只看狀態時是 0。 */
  shares: number;
  /** 有被上限砍掉一部分。 */
  cut: boolean;
  /** 沒過的原因、或砍掉的說明（持股頁那一行用）；過了而且沒砍是 null。 */
  why: string | null;
  code: BuyBlock | null;
}

const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
const calDays = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400_000);
const pct0 = (x: number) => `${Math.round(x * 1000) / 10}%`;

/**
 * 買進前的程式檢查（§4.0）。順序：減半中 → 跌幅審查或乙類還沒結案 → 硬事件標記 → 30 天內有前提被判不成立 → 跨桶上限（超過的砍掉，砍到 0 就不提）。
 * 純函式。
 */
export function buyAllowed(x: BuyFacts): BuyVerdict {
  const no = (code: BuyBlock, why: string): BuyVerdict => ({ ok: false, shares: 0, cut: false, why, code });
  if (x.state === 'HALF' || x.applied === 'HALF') return no('HALF', '這檔在減半中（加回看 200 日線）');
  if (x.openDrop) return no('DROP', '這檔的跌幅審查還沒結案');
  if (x.openBreak) return no('BREAK', '這檔有還沒結案的「AI 判前提不成立」');
  if (x.flags.length) return no('FLAG', `這檔有未解除的硬事件標記（${x.flags.join('、')}）`);
  if (x.brokenAt && x.brokenAt <= x.asOf && calDays(x.brokenAt, x.asOf) < BUY_BROKEN_DAYS) return no('BROKEN', `${md(x.brokenAt)} 有前提被判不成立`);
  if (x.want === undefined) return { ok: true, shares: 0, cut: false, why: null, code: null };
  const want = Math.max(0, Math.floor(x.want + 1e-9));
  if (!want) return no('NONE', '沒有要買的股數');
  let shares = want;
  const { cap, price, total, held } = x;
  if (cap !== null && cap !== undefined && price && price > 0 && total && total > 0) {
    const room = Math.floor((cap * total - (held ?? 0)) / price + 1e-9);
    shares = Math.max(0, Math.min(want, room));
    if (!shares) return no('CAP', `這檔自選加動能已經占總資產 ${pct0((held ?? 0) / total)}，再買會超過 ${pct0(cap)} 的上限`);
  }
  return { ok: true, shares, cut: shares < want, why: shares < want ? `買進後會超過總資產 ${pct0(cap ?? 0)} 的上限（自選加動能），只買 ${shares} 股（原本 ${want} 股）` : null, code: null };
}

/**
 * 最近一次有前提被 3 票判不成立的訊號日（不晚於 asOf；沒給 asOf = 不限）：OwnMeta.brokenAt，加上舊資料的 aiTier、dropReview 裡的日期。沒有是 null。
 * 移出自選時抄進 ownClosed（allocation_redesign §4.5 第 7 點）也用它。
 */
export function lastBrokenAt(meta: Pick<OwnMeta, 'brokenAt' | 'aiTier' | 'dropReview'>, asOf?: string): string | null {
  const ai = meta.aiTier;
  const dates = [meta.brokenAt ?? null, ai?.premiseId ? ai.date : null, meta.dropReview?.status === 'BROKEN' ? meta.dropReview.session : null].filter((d): d is string => !!d && (asOf === undefined || d <= asOf));
  return dates.length ? dates.sort().at(-1)! : null;
}

/**
 * 從帳戶整理這一檔的事實。want：想買幾股（沒給 = 只看狀態）。不是自選回傳 null。
 * skipKey（T84）：不算這一個項目（下跌加碼的選項就掛在那一則跌幅審查的項目上，那一項本身不算「還沒結案的跌幅審查」）。
 */
export function buyFacts(acct: Account, view: MarketView | null, ticker: string, asOf: string, want?: number, skipKey?: string): BuyFacts | null {
  const meta = acct.own[ticker];
  const rule = acct.rule.own[ticker];
  if (!meta || !rule) return null;
  const pending = acct.notifs.filter((n) => n.status === 'PENDING');
  const live = (f: (it: (typeof pending)[number]['items'][number]) => boolean) => pending.some((n) => n.items.some((it) => !it.cancelled && it.ticker === ticker && it.key !== skipKey && f(it)));
  const openDrop = dropReviewOpen(meta.dropReview) || meta.pending?.action === 'REDUCE' || live((it) => !!it.thesisDrop || it.f === 'F7');
  const ai = meta.aiTier;
  const openBreak = live((it) => it.brk?.type === 'B') || (!!ai?.suggest && !!ai.premiseId && (ai.tier === 'HALF' || ai.tier === 'EXIT'));
  const brokenAt = lastBrokenAt(meta, asOf);
  const facts: BuyFacts = { state: meta.slow.state, applied: rule.applied, flags: meta.flags, openDrop, openBreak, brokenAt, asOf };
  if (want === undefined || !view) return facts;
  const price = priceOf(view, ticker);
  return { ...facts, want, price, total: totalValue(acct, view), held: ((acct.lots.own[ticker] ?? 0) + (acct.lots.mom[ticker] ?? 0)) * price, cap: acct.cfg.crossCapBuy };
}

/** buyFacts → buyAllowed。不是自選：不過。 */
export function buyCheck(acct: Account, view: MarketView | null, ticker: string, asOf: string, want?: number, skipKey?: string): BuyVerdict {
  const f = buyFacts(acct, view, ticker, asOf, want, skipKey);
  return f ? buyAllowed(f) : { ok: false, shares: 0, cut: false, why: '不是自選股', code: null };
}

/** 提高到 125% 的間隔（allocation_redesign §4.3）：距上次提高滿幾個日曆天。AI 提的 125%（F23）、你定的 RAISE 條件（F28）、下跌加碼共用（§4.2、§4.4）。 */
export const RAISE_GAP_DAYS = 365;

/** 距上次提高還沒滿 12 個月 → 原因；滿了或沒提高過 → null。 */
export function raiseGapWhy(meta: { raisedAt: string | null }, asOf: string): string | null {
  if (!meta.raisedAt || calDays(meta.raisedAt, asOf) >= RAISE_GAP_DAYS) return null;
  return `上次提高到 125% 是 ${meta.raisedAt}，還沒滿 12 個月`;
}

// ---------------------------------------------------------------- 候補進場（F29，allocation_redesign §4.5 第 15 點）

/** 同一檔候補的進場項目每幾個日曆天最多列一次（§4.5）。 */
export const WATCH_LIST_GAP_DAYS = 90;
/** 非價格的進場條件成立之後超過幾個日曆天還沒列進月報就丟掉（§4.5 第 16 點）。 */
export const WATCH_ENTRY_EXPIRE_DAYS = 100;

/** 候補的推薦標準比重（§4.5：自選預算內依波動度反比，現有的算法；分母是現在的自選加上這一檔，其他候補不算）。算不出來是 null。 */
export function watchRecWeight(acct: Account, view: MarketView, ticker: string): number | null {
  try {
    const w = recommendStdWeights(view, [...Object.keys(acct.rule.own).filter((t) => t !== ticker), ticker], acct.cfg.ratio.own)[ticker];
    return Number.isFinite(w) ? w : null;
  } catch {
    return null;
  }
}

/**
 * 候補進場的事實（給 buyAllowed）：候補沒有慢規則狀態、審查、硬事件標記，有意義的只有
 * 「30 天內前提被判不成立」（上一次持有結案時抄進 ownClosed 的 brokenAt，§4.5 第 7 點）、跨桶上限（動能已經持有的算進去）、有沒有要買的股數。
 */
export function watchBuyFacts(acct: Account, view: MarketView, ticker: string, asOf: string, want: number): BuyFacts {
  const price = priceOf(view, ticker);
  const b = acct.ownClosed?.[ticker]?.brokenAt ?? null;
  return { state: 'STD', applied: 'STD', flags: [], openDrop: false, openBreak: false, brokenAt: b && b <= asOf ? b : null, asOf, want, price, total: totalValue(acct, view), held: (acct.lots.mom[ticker] ?? 0) * price, cap: acct.cfg.crossCapBuy };
}
