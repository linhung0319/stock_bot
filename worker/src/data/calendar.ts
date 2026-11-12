// 美股（NYSE）交易日曆：用規則算固定假日，另外可以帶「臨時休市」的日期。
// 純函式。日期一律是美東日期字串 YYYY-MM-DD。半日市照常算交易日（日線不受影響）。

const pad = (n: number) => String(n).padStart(2, '0');
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const toDate = (s: string) => new Date(s + 'T00:00:00Z');

export function addDays(date: string, n: number): string {
  const d = toDate(date);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
/** 0 = 週日 … 6 = 週六。 */
export function weekday(date: string): number {
  return toDate(date).getUTCDay();
}

function nthWeekday(y: number, m: number, wd: number, n: number): string {
  const first = weekday(iso(y, m, 1));
  return iso(y, m, 1 + ((wd - first + 7) % 7) + (n - 1) * 7);
}
function lastWeekday(y: number, m: number, wd: number): string {
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const last = weekday(iso(y, m, lastDay));
  return iso(y, m, lastDay - ((last - wd + 7) % 7));
}
/** 復活節（西曆，Meeus 演算法）。 */
function easter(y: number): string {
  const a = y % 19;
  const b = Math.floor(y / 100);
  const c = y % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return iso(y, month, day);
}
/** 固定日期的假日：遇週六提前到週五、遇週日延到週一。 */
function observed(date: string): string {
  const wd = weekday(date);
  return wd === 6 ? addDays(date, -1) : wd === 0 ? addDays(date, 1) : date;
}

/** 已知的臨時休市（國殤日、颶風）。之後發生的由呼叫端用 extraClosed 帶進來（D1 的 calendar_overrides）。 */
export const SPECIAL_CLOSURES: ReadonlySet<string> = new Set(['2012-10-29', '2012-10-30', '2018-12-05', '2025-01-09']);

/** 某一年的 NYSE 假日（日期 → 名稱）。 */
export function holidaysOf(year: number): Record<string, string> {
  const h: Record<string, string> = {};
  // 元旦遇週六不補假（前一天是年底，照常開市）
  const ny = iso(year, 1, 1);
  if (weekday(ny) !== 6) h[observed(ny)] = '元旦';
  h[nthWeekday(year, 1, 1, 3)] = '馬丁路德金恩紀念日';
  h[nthWeekday(year, 2, 1, 3)] = '總統日';
  h[addDays(easter(year), -2)] = '耶穌受難日';
  h[lastWeekday(year, 5, 1)] = '陣亡將士紀念日';
  if (year >= 2022) h[observed(iso(year, 6, 19))] = '六月節';
  h[observed(iso(year, 7, 4))] = '獨立紀念日';
  h[nthWeekday(year, 9, 1, 1)] = '勞動節';
  h[nthWeekday(year, 11, 4, 4)] = '感恩節';
  h[observed(iso(year, 12, 25))] = '聖誕節';
  return h;
}

const cache = new Map<number, Record<string, string>>();
function holidayName(date: string): string | undefined {
  const y = Number(date.slice(0, 4));
  let h = cache.get(y);
  if (!h) cache.set(y, (h = holidaysOf(y)));
  return h[date];
}

export interface CalendarOverrides {
  /** 臨時休市的日期。 */
  closed?: ReadonlySet<string>;
  /** 規則算成假日、實際有開市的日期。 */
  open?: ReadonlySet<string>;
}

export function isTradingDay(date: string, ov: CalendarOverrides = {}): boolean {
  const wd = weekday(date);
  if (wd === 0 || wd === 6) return false;
  if (ov.open?.has(date)) return true;
  if (ov.closed?.has(date) || SPECIAL_CLOSURES.has(date)) return false;
  return holidayName(date) === undefined;
}

export function previousTradingDay(date: string, ov: CalendarOverrides = {}): string {
  let d = addDays(date, -1);
  while (!isTradingDay(d, ov)) d = addDays(d, -1);
  return d;
}
export function nextTradingDay(date: string, ov: CalendarOverrides = {}): string {
  let d = addDays(date, 1);
  while (!isTradingDay(d, ov)) d = addDays(d, 1);
  return d;
}
/** 這個交易日是不是當月最後一個交易日（月報的訊號日）。 */
export function isLastTradingDayOfMonth(date: string, ov: CalendarOverrides = {}): boolean {
  return isTradingDay(date, ov) && nextTradingDay(date, ov).slice(0, 7) !== date.slice(0, 7);
}
export function isFirstTradingDayOfMonth(date: string, ov: CalendarOverrides = {}): boolean {
  return isTradingDay(date, ov) && previousTradingDay(date, ov).slice(0, 7) !== date.slice(0, 7);
}
/** [from, to] 之間的交易日（含兩端）。 */
export function tradingDaysBetween(from: string, to: string, ov: CalendarOverrides = {}): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) if (isTradingDay(d, ov)) out.push(d);
  return out;
}

const ET = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

/** 某個時刻的美東日期與時間（自動處理夏令時間）。 */
export function easternTime(now: Date): { date: string; minutes: number } {
  const p: Record<string, string> = {};
  for (const x of ET.formatToParts(now)) p[x.type] = x.value;
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

/** 收盤後多久才把當天當成「已收盤」（分鐘）。16:00 收盤，留 15 分鐘讓日線定下來。 */
export const CLOSE_MINUTES = 16 * 60 + 15;

/**
 * 最近一個已收盤的交易日：現在應該看得到這一天的日線。
 * 交易日 16:15（美東）以後是當天，否則是前一個交易日。
 */
export function lastCompletedSession(now: Date, ov: CalendarOverrides = {}): string {
  const { date, minutes } = easternTime(now);
  if (isTradingDay(date, ov) && minutes >= CLOSE_MINUTES) return date;
  return previousTradingDay(date, ov);
}
