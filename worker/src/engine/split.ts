// 拆股與合股（design_v2 §10 第 48 點，T39c）。純函式：拆股的資料由呼叫端傳進來（app 層從 splits 表讀），引擎不抓、不讀時鐘。
// 存下來的價格每天整段重抓、已經是拆股後的數字，所以帳本要跟著：持股股數、還沒成交的清單股數乘上比例，帳本記一行。
// 單位數、現金、標準比重、影子紀錄不動（影子紀錄存當時的股數與價格，算報酬用還原後的價格比）。
import { clone, type Account, type Notif } from './account';
import type { Composed, OrderLine } from './orders';

export interface Split {
  ticker: string;
  /** 生效日（美東）。 */
  date: string;
  /** 1 拆 10：numerator 10、denominator 1；10 合 1：numerator 1、denominator 10。 */
  numerator: number;
  denominator: number;
}

export const splitKey = (s: Pick<Split, 'ticker' | 'date'>): string => `${s.ticker}@${s.date}`;
export const splitRatio = (s: Pick<Split, 'numerator' | 'denominator'>): number => s.numerator / s.denominator;

const n2 = (x: number) => String(Math.round(x * 100) / 100);
/** 「1 拆 10」「2 拆 3」；合股「10 合 1」。 */
export function splitLabel(s: Pick<Split, 'numerator' | 'denominator'>): string {
  return s.numerator >= s.denominator ? `${n2(s.denominator)} 拆 ${n2(s.numerator)}` : `${n2(s.denominator)} 合 ${n2(s.numerator)}`;
}
/** 帳本那一行的種類名稱：拆股或合股。 */
export const splitKindName = (s: Pick<Split, 'numerator' | 'denominator'>): string => (s.numerator >= s.denominator ? '拆股' : '合股');

/**
 * 帳戶最後一次對照券商的美東日期（快照或建立帳戶送出的那一刻）：那時券商顯示的股數已經包含生效日在這一天以前的拆股。
 * 舊帳戶沒有 splitAsOf 時用最後一份快照的日期。
 */
export function splitBase(acct: Pick<Account, 'splitAsOf' | 'snapshotDate'>): string {
  return acct.splitAsOf ?? acct.snapshotDate ?? '';
}

/** 這個帳戶還要套用的拆股：生效日在 splitBase 之後、還沒套用過、比例合理（舊到新）。 */
export function pendingSplits(acct: Pick<Account, 'splitAsOf' | 'snapshotDate' | 'splits'>, splits: Split[]): Split[] {
  const base = splitBase(acct);
  const done = acct.splits ?? {};
  return splits
    .filter((s) => s.date > base && !done[splitKey(s)] && s.numerator > 0 && s.denominator > 0 && s.numerator !== s.denominator && Number.isFinite(splitRatio(s)))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.ticker < b.ticker ? -1 : 1));
}

/** 清單的一行：股數乘上比例；不是整數時四捨五入，原本不是 0 的至少 1 股（0 股在合成的清單裡是「劃撥」的意思）。 */
function lineShares(x: number, r: number): number {
  if (!x) return 0;
  const v = x * r;
  if (Number.isInteger(x) && !Number.isInteger(Math.round(v * 1e9) / 1e9)) return Math.sign(v) * Math.max(1, Math.round(Math.abs(v)));
  return Math.round(v * 1e9) / 1e9;
}

/** 同一個行物件可能同時在選項、合成的清單與合併的那一格裡（記憶體裡是同一個物件）：每次拆股只乘一次。 */
type Seen = Set<object>;

function scaleLines(lines: OrderLine[], ticker: string, r: number, seen: Seen): boolean {
  let hit = false;
  for (const l of lines) {
    if (l.ticker !== ticker || !l.shares) continue;
    if (seen.has(l)) {
      hit = true;
      continue;
    }
    seen.add(l);
    l.shares = lineShares(l.shares, r);
    hit = true;
  }
  return hit;
}

function scaleComposed(c: Composed | undefined, ticker: string, r: number, seen: Seen): boolean {
  if (!c || seen.has(c)) return false;
  seen.add(c);
  let hit = scaleLines(c.lines, ticker, r, seen);
  for (const m of c.merged) {
    if (m.ticker !== ticker) continue;
    if (scaleLines(m.parts, ticker, r, seen)) hit = true;
    // 合併的淨股數 = 各行相加（兩桶對沖的劃撥仍是 0）
    m.shares = m.parts.length ? Math.round(m.parts.reduce((a, l) => a + l.shares, 0) * 1e9) / 1e9 : lineShares(m.shares, r);
  }
  for (const x of c.capped ?? []) {
    if (x.ticker !== ticker || !x.cut || seen.has(x)) continue;
    seen.add(x);
    x.cut = Math.abs(lineShares(x.cut, r));
    hit = true;
  }
  return hit;
}

/** 還沒成交、會用到股數的通知：等你決定、等你下單；「和清單不同」還沒處理；還沒分類的變動。 */
function scaleNotif(n: Notif, ticker: string, r: number, seen: Seen): boolean {
  let hit = false;
  if (n.status === 'PENDING' || n.status === 'RESPONDED') {
    for (const it of n.items) for (const c of it.choices) if (scaleLines(c.lines, ticker, r, seen)) hit = true;
    if (scaleComposed(n.preview, ticker, r, seen)) hit = true;
    if (scaleComposed(n.composed, ticker, r, seen)) hit = true;
    if (n.kind === 'CLASSIFY' && n.ticker === ticker && n.quantity) {
      n.quantity = Math.round(n.quantity * r * 1e9) / 1e9;
      hit = true;
    }
  }
  if (n.followUpOpen && n.followUp) {
    for (const f of n.followUp) {
      if (f.ticker !== ticker || seen.has(f)) continue;
      seen.add(f);
      f.listed = lineShares(f.listed, r);
      f.done = lineShares(f.done, r);
      hit = true;
    }
  }
  return hit;
}

const BUCKETS = ['own', 'mom', 'core', 'unc'] as const;

/**
 * 持股股數乘上比例。整股的持股照券商的做法：整檔合計無條件捨去到整股（零頭券商付現金，下一次快照記成其他現金變動），
 * 捨去的股數從小數部分最大的桶開始補回；原本就有零股的照實乘。回傳每一桶的 [原本, 之後]。
 */
function scaleLots(acct: Account, ticker: string, r: number): { bucket: (typeof BUCKETS)[number]; before: number; after: number }[] {
  const held = BUCKETS.filter((b) => acct.lots[b][ticker]).map((b) => ({ bucket: b, before: acct.lots[b][ticker], exact: acct.lots[b][ticker] * r }));
  if (!held.length) return [];
  const whole = held.every((h) => Number.isInteger(h.before));
  const out = held.map((h) => ({ bucket: h.bucket, before: h.before, after: whole ? Math.floor(h.exact + 1e-9) : Math.round(h.exact * 1e9) / 1e9, frac: h.exact - Math.floor(h.exact + 1e-9) }));
  if (whole) {
    const total = Math.floor(held.reduce((a, h) => a + h.exact, 0) + 1e-9);
    let left = total - out.reduce((a, h) => a + h.after, 0);
    for (const h of [...out].sort((a, b) => b.frac - a.frac)) {
      if (left <= 0) break;
      h.after += 1;
      left--;
    }
  }
  for (const h of out) {
    if (h.after) acct.lots[h.bucket][ticker] = h.after;
    else delete acct.lots[h.bucket][ticker];
  }
  return out.map(({ bucket, before, after }) => ({ bucket, before, after }));
}

const fmtShares = (x: number) => x.toLocaleString('en-US', { maximumFractionDigits: 4 });

/**
 * 把還沒套用的拆股套到帳戶（design_v2 §10 第 48 點）：持股股數、還沒成交的清單股數乘上比例，帳本每一桶記一行 SPLIT；
 * 不論這個帳戶有沒有這檔，都記成套用過（之後用拆股後的價格算的清單才不會又被乘一次）。
 * 套用過的紀錄只留生效日在 splitBase 之後的（之前的本來就不會再套用）。
 */
export function applySplits(acct0: Account, splits: Split[]): { acct: Account; applied: Split[] } {
  const todo = pendingSplits(acct0, splits);
  if (!todo.length) return { acct: acct0, applied: [] };
  const acct = clone(acct0);
  const done: Record<string, string> = { ...(acct.splits ?? {}) };
  const applied: Split[] = [];
  for (const s of todo) {
    const r = splitRatio(s);
    done[splitKey(s)] = s.date;
    const lots = scaleLots(acct, s.ticker, r);
    let touched = lots.length > 0;
    const seen: Seen = new Set();
    for (const n of acct.notifs) if (scaleNotif(n, s.ticker, r, seen)) touched = true;
    for (const l of lots) {
      acct.events.push({ date: s.date, kind: 'SPLIT', ticker: s.ticker, bucket: l.bucket, shares: Math.round((l.after - l.before) * 1e9) / 1e9, reason: `${splitLabel(s)}，${fmtShares(l.before)} 股 → ${fmtShares(l.after)} 股` });
    }
    if (touched) applied.push(s);
  }
  const base = splitBase(acct);
  acct.splits = Object.fromEntries(Object.entries(done).filter(([, d]) => d > base));
  return { acct, applied };
}
