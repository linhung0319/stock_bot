// 資料層的 D1 存取：價格、成分股快照、排名、每日抓取紀錄、告警、交易日曆例外。
import type { CalendarOverrides } from './calendar';
import type { DailyBar } from './sources';

/** 一檔的整段日線（欄位分開存，比較省空間）。 */
export interface Series {
  ticker: string;
  fetchedAt: string;
  session: string;
  /** 日期（美東，由舊到新）。 */
  d: string[];
  /** 未調整收盤（只還原分割）。 */
  c: number[];
  /** 還原權值收盤。 */
  a: number[];
  v: number[];
}

const r4 = (x: number) => Math.round(x * 1e4) / 1e4;

export function seriesFromBars(ticker: string, bars: DailyBar[], fetchedAt: string, session: string): Series {
  return { ticker, fetchedAt, session, d: bars.map((b) => b.date), c: bars.map((b) => r4(b.close)), a: bars.map((b) => r4(b.adjClose)), v: bars.map((b) => b.volume) };
}
export const lastDate = (s: Series): string | null => (s.d.length ? s.d[s.d.length - 1] : null);

export async function saveSeries(db: D1Database, list: Series[]): Promise<void> {
  const stmt = db.prepare(
    'INSERT INTO price_series (ticker, fetched_at, session, last_date, n, bars) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(ticker) DO UPDATE SET fetched_at = excluded.fetched_at, session = excluded.session, last_date = excluded.last_date, n = excluded.n, bars = excluded.bars',
  );
  const rows = list.filter((s) => s.d.length);
  for (let i = 0; i < rows.length; i += 8) {
    await db.batch(rows.slice(i, i + 8).map((s) => stmt.bind(s.ticker, s.fetchedAt, s.session, s.d[s.d.length - 1], s.d.length, JSON.stringify({ d: s.d, c: s.c, a: s.a, v: s.v }))));
  }
}

interface SeriesRow {
  ticker: string;
  fetched_at: string;
  session: string;
  bars: string;
}
function toSeries(r: SeriesRow): Series {
  const b = JSON.parse(r.bars) as Pick<Series, 'd' | 'c' | 'a' | 'v'>;
  return { ticker: r.ticker, fetchedAt: r.fetched_at, session: r.session, ...b };
}

/** 讀指定代號的日線；沒存過的代號不會出現在結果裡。 */
export async function loadSeries(db: D1Database, tickers: string[]): Promise<Map<string, Series>> {
  const out = new Map<string, Series>();
  const uniq = [...new Set(tickers)];
  for (let i = 0; i < uniq.length; i += 20) {
    const part = uniq.slice(i, i + 20);
    const res = await db
      .prepare(`SELECT ticker, fetched_at, session, bars FROM price_series WHERE ticker IN (${part.map(() => '?').join(',')})`)
      .bind(...part)
      .all<SeriesRow>();
    for (const r of res.results) out.set(r.ticker, toSeries(r));
  }
  return out;
}

export async function seriesFreshness(db: D1Database): Promise<{ ticker: string; last_date: string; session: string; n: number }[]> {
  return (await db.prepare('SELECT ticker, last_date, session, n FROM price_series ORDER BY ticker').all<{ ticker: string; last_date: string; session: string; n: number }>()).results;
}

// ---------------------------------------------------------------- 成分股快照

export interface ConstituentSnapshot {
  session: string;
  fetchedAt: string;
  spyAsOf: string | null;
  nWiki: number;
  consistent: boolean;
  onlySpy: string[];
  onlyWiki: string[];
  /** [代號, 權重, CIK]；照持股檔的順序。 */
  holdings: [string, number, string | null][];
}

export async function saveConstituents(db: D1Database, s: ConstituentSnapshot): Promise<void> {
  await db
    .prepare('INSERT OR REPLACE INTO constituents (session, fetched_at, spy_as_of, n_spy, n_wiki, consistent, only_spy, only_wiki, holdings) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(s.session, s.fetchedAt, s.spyAsOf, s.holdings.length, s.nWiki, s.consistent ? 1 : 0, JSON.stringify(s.onlySpy), JSON.stringify(s.onlyWiki), JSON.stringify(s.holdings))
    .run();
}

interface ConstituentRow {
  session: string;
  fetched_at: string;
  spy_as_of: string | null;
  n_wiki: number;
  consistent: number;
  only_spy: string;
  only_wiki: string;
  holdings: string;
}

/** 最近一份成分股快照（session 可以指定上限）。 */
export async function loadConstituents(db: D1Database, upTo?: string): Promise<ConstituentSnapshot | null> {
  const r = upTo
    ? await db.prepare('SELECT * FROM constituents WHERE session <= ? ORDER BY session DESC LIMIT 1').bind(upTo).first<ConstituentRow>()
    : await db.prepare('SELECT * FROM constituents ORDER BY session DESC LIMIT 1').first<ConstituentRow>();
  if (!r) return null;
  return {
    session: r.session,
    fetchedAt: r.fetched_at,
    spyAsOf: r.spy_as_of,
    nWiki: r.n_wiki,
    consistent: r.consistent === 1,
    onlySpy: JSON.parse(r.only_spy),
    onlyWiki: JSON.parse(r.only_wiki),
    holdings: JSON.parse(r.holdings),
  };
}

// ---------------------------------------------------------------- 排名

export interface RankingDetail {
  /** 50 檔股票池（照市值由大到小）。 */
  universe: { ticker: string; weight: number; close: number; dollarVolume: number; momentum: number | null }[];
  /** 同一家公司有兩類股的代號 → 公司代碼（CIK）。 */
  company: Record<string, string>;
  /** 抓不到最新日線、沒辦法算成交金額的成分股。 */
  missing: string[];
  nConstituents: number;
}
export interface Ranking {
  session: string;
  createdAt: string;
  order: string[];
  detail: RankingDetail;
}

export async function saveRanking(db: D1Database, r: Ranking): Promise<void> {
  await db.prepare('INSERT OR REPLACE INTO rankings (session, created_at, ord, detail) VALUES (?, ?, ?, ?)').bind(r.session, r.createdAt, JSON.stringify(r.order), JSON.stringify(r.detail)).run();
}
export async function loadRanking(db: D1Database, session?: string): Promise<Ranking | null> {
  type Row = { session: string; created_at: string; ord: string; detail: string };
  const r = session
    ? await db.prepare('SELECT * FROM rankings WHERE session = ?').bind(session).first<Row>()
    : await db.prepare('SELECT * FROM rankings ORDER BY session DESC LIMIT 1').first<Row>();
  return r ? { session: r.session, createdAt: r.created_at, order: JSON.parse(r.ord), detail: JSON.parse(r.detail) } : null;
}

// ---------------------------------------------------------------- 每日抓取紀錄與告警

export type AlertKind = 'MEMBERSHIP_MISMATCH' | 'MEMBERSHIP_UNAVAILABLE' | 'PRICE_MISSING' | 'PRICE_STALE' | 'RANKING_FAILED' | 'INGEST_ERROR';
export interface Alert {
  kind: AlertKind;
  message: string;
  detail?: unknown;
}

export interface DataRun {
  session: string;
  at: string;
  status: 'OK' | 'DEGRADED' | 'FAILED';
  signalsOk: boolean;
  rebalanceOk: boolean;
  ranked: boolean;
  ms: number;
  detail: unknown;
}

export async function saveRun(db: D1Database, run: DataRun, alerts: Alert[]): Promise<void> {
  const stmts = [
    db
      .prepare('INSERT INTO data_runs (session, at, status, signals_ok, rebalance_ok, ranked, ms, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(run.session, run.at, run.status, run.signalsOk ? 1 : 0, run.rebalanceOk ? 1 : 0, run.ranked ? 1 : 0, run.ms, JSON.stringify(run.detail)),
    ...alerts.map((a) => db.prepare('INSERT INTO alerts (at, session, kind, message, detail) VALUES (?, ?, ?, ?, ?)').bind(run.at, run.session, a.kind, a.message, a.detail === undefined ? null : JSON.stringify(a.detail))),
  ];
  await db.batch(stmts);
}

interface RunRow {
  session: string;
  at: string;
  status: DataRun['status'];
  signals_ok: number;
  rebalance_ok: number;
  ranked: number;
  ms: number;
  detail: string;
}
const toRun = (r: RunRow): DataRun => ({ session: r.session, at: r.at, status: r.status, signalsOk: r.signals_ok === 1, rebalanceOk: r.rebalance_ok === 1, ranked: r.ranked === 1, ms: r.ms, detail: JSON.parse(r.detail) });

/** 某個交易日最後一次抓取的結果（沒跑過是 null）。 */
export async function loadRun(db: D1Database, session: string): Promise<DataRun | null> {
  const r = await db.prepare('SELECT * FROM data_runs WHERE session = ? ORDER BY id DESC LIMIT 1').bind(session).first<RunRow>();
  return r ? toRun(r) : null;
}
export async function recentRuns(db: D1Database, limit = 10): Promise<DataRun[]> {
  return (await db.prepare('SELECT * FROM data_runs ORDER BY id DESC LIMIT ?').bind(limit).all<RunRow>()).results.map(toRun);
}
export async function recentAlerts(db: D1Database, limit = 30): Promise<unknown[]> {
  return (await db.prepare('SELECT id, at, session, kind, message, sent_at FROM alerts ORDER BY id DESC LIMIT ?').bind(limit).all()).results;
}

export async function loadCalendarOverrides(db: D1Database): Promise<CalendarOverrides> {
  const rows = (await db.prepare('SELECT date, open FROM calendar_overrides').all<{ date: string; open: number }>()).results;
  return { closed: new Set(rows.filter((r) => !r.open).map((r) => r.date)), open: new Set(rows.filter((r) => r.open).map((r) => r.date)) };
}
