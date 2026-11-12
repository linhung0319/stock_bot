// 每日資料抓取（T6）：成分股快照與比對、價格、資料新鮮度、月報訊號日的股票池排名。
// 結果存 D1；這裡只判斷「資料能不能用」，要不要通知由每日流程（T7）決定。
//   signalsOk   必要的價格（核心、短債、持股、動能名單）都是最近一個已收盤交易日的 → 可以產生每日訊號
//   rebalanceOk SPY 持股檔和 Wikipedia 名單一致 → 可以換股（設計 §2.4）
import { rankUniverse, universeOf, type UniverseRow } from '../engine/momentum';
import { isLastTradingDayOfMonth, lastCompletedSession } from './calendar';
import { compareMembership, fetchSpyHoldings, fetchWikiSp500, fetchYahooDaily, normalizeTicker, type DailyBar, type Fetcher } from './sources';
import {
  lastDate,
  loadCalendarOverrides,
  loadConstituents,
  saveConstituents,
  saveRanking,
  saveRun,
  saveSeries,
  seriesFromBars,
  type Alert,
  type ConstituentSnapshot,
  type DataRun,
  type Ranking,
  type Series,
} from './store';
import { errText, pool, retry } from './util';

export interface IngestOptions {
  now: Date;
  /** 一定要有最新價格的代號：核心 ETF、短債 ETF、三桶的持股、動能名單。 */
  required: string[];
  /** 不是月底也產生排名（手動測試、上線當天用）。 */
  forceRank?: boolean;
  /** 每天追蹤市值前幾名的完整日線（月底才會抓全部成分股的成交金額）。 */
  topN?: number;
}

export interface IngestResult extends DataRun {
  alerts: Alert[];
  ranking: Ranking | null;
}

/** 策略檢討的比較基準（設計 §2.6）。 */
export const BENCHMARK = 'SPY';
/** 排名時，抓不到最新日線的成分股超過這個比例就不排名。 */
export const MAX_MISSING_FRAC = 0.05;
/** 市值前幾名之內只要有一檔抓不到就不排名（它很可能在 50 檔股票池裡）。 */
export const MUST_HAVE_TOP = 60;

type Got = { ticker: string; bars: DailyBar[]; error?: string };

async function fetchBars(fetcher: Fetcher, tickers: string[], range: string, session: string): Promise<Got[]> {
  return pool(tickers, 6, async (ticker): Promise<Got> => {
    try {
      const s = await retry(() => fetchYahooDaily(fetcher, ticker, range));
      // 盤中手動跑的時候 Yahoo 會帶一根還沒收盤的 K 線：訊號日之後的都丟掉
      return { ticker, bars: s.bars.filter((b) => b.date <= session) };
    } catch (e) {
      return { ticker, bars: [], error: errText(e) };
    }
  });
}

const isFresh = (g: Got, session: string) => g.bars.length > 0 && g.bars[g.bars.length - 1].date === session;

export async function runIngest(db: D1Database, fetcher: Fetcher, opt: IngestOptions): Promise<IngestResult> {
  const t0 = Date.now();
  const at = opt.now.toISOString();
  const ov = await loadCalendarOverrides(db);
  const session = lastCompletedSession(opt.now, ov);
  const alerts: Alert[] = [];

  // 1. 成分股：SPY 每日持股檔和 Wikipedia 目前名單
  let snapshot: ConstituentSnapshot | null = null;
  try {
    const [spy, wiki] = await Promise.all([retry(() => fetchSpyHoldings(fetcher)), retry(() => fetchWikiSp500(fetcher))]);
    const diff = compareMembership(
      spy.holdings.map((h) => h.ticker),
      wiki.map((w) => w.ticker),
    );
    const cik = new Map(wiki.map((w) => [normalizeTicker(w.ticker), w.cik]));
    snapshot = {
      session,
      fetchedAt: at,
      spyAsOf: spy.asOf,
      nWiki: wiki.length,
      consistent: diff.consistent,
      onlySpy: diff.onlySpy,
      onlyWiki: diff.onlyWiki,
      holdings: spy.holdings.map((h) => [h.ticker, h.weight, cik.get(normalizeTicker(h.ticker)) ?? null]),
    };
    await saveConstituents(db, snapshot);
    if (!diff.consistent) {
      alerts.push({
        kind: 'MEMBERSHIP_MISMATCH',
        message: `成分股名單不一致，暫停換股。只在 SPY 持股檔：${diff.onlySpy.join(' ') || '無'}；只在 Wikipedia：${diff.onlyWiki.join(' ') || '無'}`,
        detail: diff,
      });
    }
  } catch (e) {
    alerts.push({ kind: 'MEMBERSHIP_UNAVAILABLE', message: `抓不到成分股名單，暫停換股：${errText(e)}` });
  }
  const rebalanceOk = snapshot !== null && snapshot.consistent;
  // 今天抓不到就用最近一份決定要追蹤哪些代號（只影響抓哪些價格，不會拿來換股）
  const members = snapshot ?? (await loadConstituents(db));

  // 2. 價格：必要的代號＋基準＋市值前 N 名，各抓整段兩年日線
  const required = [...new Set(opt.required)];
  const top = members ? [...members.holdings].sort((a, b) => b[1] - a[1]).slice(0, opt.topN ?? 80).map((h) => h[0]) : [];
  const tracked = [...new Set([...required, BENCHMARK, ...top])];
  const got = await fetchBars(fetcher, tracked, '2y', session);
  const series = new Map<string, Series>();
  for (const g of got) if (g.bars.length) series.set(g.ticker, seriesFromBars(g.ticker, g.bars, at, session));
  await saveSeries(db, [...series.values()]);

  const byTicker = new Map(got.map((g) => [g.ticker, g]));
  const missing = required.filter((t) => !byTicker.get(t)?.bars.length);
  const stale = required.filter((t) => byTicker.get(t)?.bars.length && !isFresh(byTicker.get(t)!, session));
  if (missing.length) {
    alerts.push({ kind: 'PRICE_MISSING', message: `抓不到價格，今天不產生訊號：${missing.join(' ')}`, detail: Object.fromEntries(missing.map((t) => [t, byTicker.get(t)?.error ?? '沒有資料'])) });
  }
  if (stale.length) {
    alerts.push({
      kind: 'PRICE_STALE',
      message: `價格不是最新的（應該到 ${session}），今天不產生訊號：${stale.map((t) => `${t} 到 ${byTicker.get(t)!.bars.at(-1)!.date}`).join('、')}。如果 ${session} 其實休市，要在 calendar_overrides 補一筆。`,
    });
  }
  const signalsOk = !missing.length && !stale.length;
  const otherFailed = got.filter((g) => !required.includes(g.ticker) && !isFresh(g, session)).map((g) => g.ticker);

  // 3. 月報訊號日（當月最後一個交易日）：股票池與排名
  let ranking: Ranking | null = null;
  const wantRank = opt.forceRank || isLastTradingDayOfMonth(session, ov);
  if (wantRank && rebalanceOk && snapshot) {
    const r = await buildRanking(db, fetcher, snapshot, series, session, at);
    if (r.ok) ranking = r.ranking;
    else alerts.push({ kind: 'RANKING_FAILED', message: `排名沒有產生，暫停換股：${r.why}`, detail: r.detail });
  }

  const run: DataRun = {
    session,
    at,
    status: !signalsOk ? 'FAILED' : alerts.length ? 'DEGRADED' : 'OK',
    signalsOk,
    rebalanceOk: rebalanceOk && (!wantRank || ranking !== null),
    ranked: ranking !== null,
    ms: Date.now() - t0,
    detail: {
      tracked: tracked.length,
      fresh: got.filter((g) => isFresh(g, session)).length,
      requiredMissing: missing,
      requiredStale: stale,
      otherFailed,
      constituents: snapshot ? { n: snapshot.holdings.length, nWiki: snapshot.nWiki, spyAsOf: snapshot.spyAsOf, consistent: snapshot.consistent } : null,
      wantRank,
    },
  };
  await saveRun(db, run, alerts);
  return { ...run, alerts, ranking };
}

type RankOutcome = { ok: true; ranking: Ranking } | { ok: false; why: string; detail?: unknown };

/**
 * 股票池（設計 §3）：成分股 → 股價 > 5 → 前一日成交金額前 100 → 市值前 50 → 252 日還原報酬排名。
 * 成交金額要全部成分股都有：已經有整段日線的直接用，其餘抓最近 5 天。
 */
async function buildRanking(db: D1Database, fetcher: Fetcher, snap: ConstituentSnapshot, series: Map<string, Series>, session: string, at: string): Promise<RankOutcome> {
  const fresh = (t: string) => {
    const s = series.get(t);
    return s && lastDate(s) === session ? s : null;
  };
  const tickers = snap.holdings.map((h) => h[0]);
  const short = await fetchBars(fetcher, tickers.filter((t) => !fresh(t)), '5d', session);
  const lastBar = new Map(short.filter((g) => isFresh(g, session)).map((g) => [g.ticker, g.bars[g.bars.length - 1]]));

  const rows: UniverseRow[] = [];
  const missing: string[] = [];
  for (const [ticker, weight] of snap.holdings) {
    const s = fresh(ticker);
    const b = lastBar.get(ticker);
    if (s) rows.push({ ticker, weight, close: s.c[s.c.length - 1], dollarVolume: s.c[s.c.length - 1] * s.v[s.v.length - 1], momentum: NaN });
    else if (b) rows.push({ ticker, weight, close: b.close, dollarVolume: b.close * b.volume, momentum: NaN });
    else missing.push(ticker);
  }
  const byWeight = [...snap.holdings].sort((a, b) => b[1] - a[1]).map((h) => h[0]);
  const missingTop = byWeight.slice(0, MUST_HAVE_TOP).filter((t) => missing.includes(t));
  if (missingTop.length) return { ok: false, why: `市值前 ${MUST_HAVE_TOP} 名裡有抓不到最新日線的：${missingTop.join(' ')}`, detail: { missing } };
  if (missing.length > MAX_MISSING_FRAC * tickers.length) return { ok: false, why: `${missing.length} 檔成分股抓不到最新日線（上限 ${Math.floor(MAX_MISSING_FRAC * tickers.length)} 檔）`, detail: { missing } };

  // 股票池裡還沒有整段日線的，補抓兩年（算 252 日報酬）
  const universe = universeOf(rows);
  const need = universe.map((r) => r.ticker).filter((t) => !fresh(t));
  if (need.length) {
    const more = await fetchBars(fetcher, need, '2y', session);
    const bad = more.filter((g) => !isFresh(g, session)).map((g) => g.ticker);
    if (bad.length) return { ok: false, why: `股票池裡有抓不到整段日線的：${bad.join(' ')}`, detail: { bad } };
    const add = more.map((g) => seriesFromBars(g.ticker, g.bars, at, session));
    for (const s of add) series.set(s.ticker, s);
    await saveSeries(db, add);
  }
  const momentumOf = (t: string): number => {
    const s = fresh(t);
    if (!s) return NaN;
    const i = s.a.length - 1;
    // 上市不滿 252 個交易日 → NaN，不進排名（和回測相同）
    return i >= 252 && s.a[i - 252] > 0 ? s.a[i] / s.a[i - 252] - 1 : NaN;
  };
  const inUniverse = new Set(universe.map((r) => r.ticker));
  for (const r of rows) if (inUniverse.has(r.ticker)) r.momentum = momentumOf(r.ticker);
  const ranked = rankUniverse(rows);

  // 同一家公司的不同類股（CIK 相同）
  const byCik = new Map<string, string[]>();
  for (const [t, , cik] of snap.holdings) if (cik) byCik.set(cik, [...(byCik.get(cik) ?? []), t]);
  const company: Record<string, string> = {};
  for (const [cik, ts] of byCik) if (ts.length > 1) for (const t of ts) company[t] = cik;

  const ranking: Ranking = {
    session,
    createdAt: at,
    order: ranked.map((r) => r.ticker),
    detail: {
      universe: universe.map((r) => ({ ticker: r.ticker, weight: r.weight, close: r.close, dollarVolume: Math.round(r.dollarVolume), momentum: Number.isFinite(r.momentum) ? Math.round(r.momentum * 1e6) / 1e6 : null })),
      company,
      missing,
      nConstituents: tickers.length,
    },
  };
  await saveRanking(db, ranking);
  return { ok: true, ranking };
}

/** 排名紀錄 → 引擎 selectMomentum 用的 companyOf。 */
export function companyOf(ranking: Ranking): (ticker: string) => string {
  return (t) => ranking.detail.company[t] ?? t;
}
