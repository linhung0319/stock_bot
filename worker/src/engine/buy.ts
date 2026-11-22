// 買進前的程式檢查（allocation_redesign §4.0，T83）：自選的每一種買進——先買一半的補滿（F27）、提高到 125%（F23）、
// 之後的你定的加碼條件（F28）、下跌加碼、候補進場——都先過同一組檢查，任何一項不過就不提。
// buyAllowed 是純函式（只看傳進來的事實）；buyFacts 從帳戶狀態把事實整理出來。
import { dropReviewOpen, priceOf, totalValue, type Account, type MarketView } from './account';
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

/** 從帳戶整理這一檔的事實。want：想買幾股（沒給 = 只看狀態）。不是自選回傳 null。 */
export function buyFacts(acct: Account, view: MarketView | null, ticker: string, asOf: string, want?: number): BuyFacts | null {
  const meta = acct.own[ticker];
  const rule = acct.rule.own[ticker];
  if (!meta || !rule) return null;
  const pending = acct.notifs.filter((n) => n.status === 'PENDING');
  const live = (f: (it: (typeof pending)[number]['items'][number]) => boolean) => pending.some((n) => n.items.some((it) => !it.cancelled && it.ticker === ticker && f(it)));
  const openDrop = dropReviewOpen(meta.dropReview) || meta.pending?.action === 'REDUCE' || live((it) => !!it.thesisDrop || it.f === 'F7');
  const ai = meta.aiTier;
  const openBreak = live((it) => it.brk?.type === 'B') || (!!ai?.suggest && !!ai.premiseId && (ai.tier === 'HALF' || ai.tier === 'EXIT'));
  const dates = [meta.brokenAt ?? null, ai?.premiseId ? ai.date : null, meta.dropReview?.status === 'BROKEN' ? meta.dropReview.session : null].filter((d): d is string => !!d && d <= asOf);
  const brokenAt = dates.length ? dates.sort().at(-1)! : null;
  const facts: BuyFacts = { state: meta.slow.state, applied: rule.applied, flags: meta.flags, openDrop, openBreak, brokenAt, asOf };
  if (want === undefined || !view) return facts;
  const price = priceOf(view, ticker);
  return { ...facts, want, price, total: totalValue(acct, view), held: ((acct.lots.own[ticker] ?? 0) + (acct.lots.mom[ticker] ?? 0)) * price, cap: acct.cfg.crossCapBuy };
}

/** buyFacts → buyAllowed。不是自選：不過。 */
export function buyCheck(acct: Account, view: MarketView | null, ticker: string, asOf: string, want?: number): BuyVerdict {
  const f = buyFacts(acct, view, ticker, asOf, want);
  return f ? buyAllowed(f) : { ok: false, shares: 0, cut: false, why: '不是自選股', code: null };
}
