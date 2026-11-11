// T4 實測：從 Cloudflare 抓四個資料來源，記錄成功率與耗時（存 D1 的 probe_runs）。
// 分兩半跑（A、B），每一半的對外請求都在 50 個以內（免費方案的上限）。
import { compareMembership, fetchEdgarSubmissions, fetchSpyHoldings, fetchWikiSp500, fetchYahooDaily } from '../data/sources';
import type { Env, Fetcher } from './env';

/** 約 60 檔：核心 ETF、短債、基準，加上市值與成交金額大的股票（含 BRK.B 這種特殊代號）。 */
export const PROBE_TICKERS = [
  'VOO', 'SPY', 'SGOV', 'QQQ', 'AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'GOOG', 'META', 'TSLA', 'AVGO', 'BRK.B', 'JPM', 'LLY', 'V', 'XOM', 'UNH', 'MA',
  'COST', 'WMT', 'HD', 'PG', 'JNJ', 'NFLX', 'ORCL', 'BAC', 'ABBV', 'CRM', 'KO', 'CVX', 'AMD', 'MRK', 'PEP', 'ADBE', 'TMO', 'CSCO', 'ACN', 'LIN',
  'MCD', 'ABT', 'WFC', 'GE', 'IBM', 'DIS', 'QCOM', 'INTU', 'CAT', 'TXN', 'PLTR', 'MU', 'GS', 'APP', 'AMAT', 'NOW', 'ISRG', 'BKNG', 'UBER', 'PM',
];
/** EDGAR：20 家的 CIK（公開資料）。 */
export const PROBE_CIKS = [
  '320193', '789019', '1045810', '1018724', '1652044', '1326801', '1318605', '1730168', '1067983', '19617',
  '59478', '1403161', '34088', '731766', '1141391', '909832', '104169', '354950', '80424', '200406',
];

export interface ProbeRow {
  part: string;
  source: string;
  target: string;
  ok: boolean;
  status: number | null;
  ms: number;
  detail: string;
}

async function timed(part: string, source: string, target: string, fn: () => Promise<string>): Promise<ProbeRow> {
  const t0 = Date.now();
  try {
    const detail = await fn();
    return { part, source, target, ok: true, status: 200, ms: Date.now() - t0, detail };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const st = /HTTP (\d{3})/.exec(msg);
    return { part, source, target, ok: false, status: st ? Number(st[1]) : null, ms: Date.now() - t0, detail: msg.slice(0, 300) };
  }
}

/** 一次最多同時 n 個請求。 */
async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

export async function runProbe(env: Pick<Env, 'EDGAR_USER_AGENT'>, part: 'A' | 'B', fetcher: Fetcher): Promise<ProbeRow[]> {
  const rows: ProbeRow[] = [];
  const yahoo = (tickers: string[]) =>
    pool(tickers, 6, (t) =>
      timed(part, 'yahoo', t, async () => {
        const s = await fetchYahooDaily(fetcher, t, '2y');
        if (s.bars.length < 250) throw new Error(`只有 ${s.bars.length} 根 K 線`);
        return `${s.bars.length} 根，最新 ${s.bars[s.bars.length - 1].date}`;
      }),
    );
  if (part === 'A') {
    let spy: string[] = [];
    let wiki: string[] = [];
    rows.push(
      await timed(part, 'ssga', 'SPY 持股檔', async () => {
        const h = await fetchSpyHoldings(fetcher);
        spy = h.holdings.map((x) => x.ticker);
        return `${h.holdings.length} 檔，${h.asOfText}`;
      }),
      await timed(part, 'wikipedia', 'S&P 500 名單', async () => {
        const m = await fetchWikiSp500(fetcher);
        wiki = m.map((x) => x.ticker);
        return `${m.length} 檔`;
      }),
    );
    if (spy.length && wiki.length) {
      const d = compareMembership(spy, wiki);
      rows.push({ part, source: 'membership', target: 'SPY vs Wikipedia', ok: d.consistent, status: null, ms: 0, detail: d.consistent ? '一致' : `只在 SPY：${d.onlySpy.join(' ')}；只在 Wikipedia：${d.onlyWiki.join(' ')}` });
    }
    rows.push(...(await yahoo(PROBE_TICKERS.slice(0, 40))));
  } else {
    rows.push(...(await yahoo(PROBE_TICKERS.slice(40))));
    const ua = env.EDGAR_USER_AGENT;
    if (ua) {
      // SEC 限速每秒 10 次：一次 2 個
      rows.push(
        ...(await pool(PROBE_CIKS, 2, (cik) =>
          timed(part, 'edgar', cik, async () => {
            const r = await fetchEdgarSubmissions(fetcher, cik, ua);
            return `${r.name}：${r.filings.length} 筆，最新 ${r.filings[0]?.acceptedAt ?? '—'}`;
          }),
        )),
      );
    } else {
      rows.push({ part, source: 'edgar', target: '—', ok: false, status: null, ms: 0, detail: '沒有設定 EDGAR_USER_AGENT，略過' });
    }
  }
  return rows;
}

export async function saveProbe(db: D1Database, at: string, rows: ProbeRow[]): Promise<void> {
  const stmt = db.prepare('INSERT INTO probe_runs (at, part, source, target, ok, status, ms, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  // D1 一次 batch 的語句數有限，分批寫
  for (let i = 0; i < rows.length; i += 40) {
    await db.batch(rows.slice(i, i + 40).map((r) => stmt.bind(at, r.part, r.source, r.target, r.ok ? 1 : 0, r.status, r.ms, r.detail)));
  }
}

export interface ProbeSummaryRow {
  day: string;
  source: string;
  n: number;
  ok: number;
  avg_ms: number;
  max_ms: number;
}

/** 每天、每個來源的成功率與耗時。 */
export async function probeSummary(db: D1Database): Promise<{ summary: ProbeSummaryRow[]; failures: unknown[] }> {
  const summary = await db
    .prepare("SELECT substr(at, 1, 10) AS day, source, COUNT(*) AS n, SUM(ok) AS ok, CAST(AVG(ms) AS INTEGER) AS avg_ms, MAX(ms) AS max_ms FROM probe_runs GROUP BY day, source ORDER BY day, source")
    .all<ProbeSummaryRow>();
  const failures = await db.prepare('SELECT at, source, target, status, detail FROM probe_runs WHERE ok = 0 ORDER BY id DESC LIMIT 50').all();
  return { summary: summary.results, failures: failures.results };
}
