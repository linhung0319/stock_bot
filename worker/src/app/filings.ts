// 每日流程看 EDGAR 新申報的共用部分（T10 自選、T11 每日事件掃描）：代號 → CIK、新申報、看過的最新一筆、產業 ETF、事件紀錄。
import { sicToEtf } from '../ai/detect';
import type { FilingHit } from '../data/secEvents';
import { fetchEdgarSubmissions, type Filing } from '../data/sources';
import { loadConstituents } from '../data/store';
import { errText } from '../data/util';
import type { Env, Fetcher } from './env';

const getState = async (db: D1Database, key: string) => (await db.prepare('SELECT value FROM flow_state WHERE key = ?').bind(key).first<{ value: string }>())?.value ?? null;
export const setStateStmt = (db: D1Database, key: string, value: string, at: string) =>
  db.prepare('INSERT INTO flow_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').bind(key, value, at);

/** 代號 → SEC 的 CIK：先看成分股名單，沒有就查 SEC 的 company_tickers.json，查到的存起來。 */
export async function cikFor(env: Env, fetcher: Fetcher, ticker: string): Promise<string | null> {
  const key = `cik:${ticker}`;
  const cached = await getState(env.DB, key);
  if (cached) return cached;
  const members = await loadConstituents(env.DB);
  let cik = members?.holdings.find((h) => h[0] === ticker)?.[2] ?? null;
  if (!cik && env.EDGAR_USER_AGENT) {
    const r = await fetcher('https://www.sec.gov/files/company_tickers.json', { headers: { 'User-Agent': env.EDGAR_USER_AGENT } });
    if (r.ok) {
      const j = (await r.json()) as Record<string, { cik_str: number; ticker: string }>;
      const hit = Object.values(j).find((x) => x.ticker.toUpperCase() === ticker.replace('.', '-').toUpperCase());
      cik = hit ? String(hit.cik_str).padStart(10, '0') : null;
    }
  }
  if (cik) await setStateStmt(env.DB, key, cik, new Date().toISOString()).run();
  return cik;
}

export interface FilingCheck {
  ticker: string;
  cik: string;
  /** EDGAR 上的公司名稱（含舊名），封面判斷被收購方時用。 */
  names: string[];
  sic: string | null;
  /** 決策日以前的所有申報（EDGAR 最近約 1000 筆）。 */
  all: Filing[];
  /** 上次看過之後的新申報；第一次看只記下最新的一筆，不追溯。 */
  fresh: Filing[];
  latest: string;
}

/** 每檔的新申報（acceptedAt 在上次看過的之後）。順便記下產業 ETF（F7、F20 的跌幅拆解用）。 */
export async function fetchFilingChecks(env: Env, fetcher: Fetcher, tickers: string[], session: string, notes: string[]): Promise<FilingCheck[]> {
  const out: FilingCheck[] = [];
  const at = new Date().toISOString();
  for (const t of tickers) {
    try {
      const cik = await cikFor(env, fetcher, t);
      if (!cik) throw new Error('找不到 CIK');
      const sub = await fetchEdgarSubmissions(fetcher, cik, env.EDGAR_USER_AGENT!);
      const all = sub.filings.filter((f) => f.filingDate <= session || f.acceptedAt.slice(0, 10) <= session);
      const latest = all.reduce((m, f) => (f.acceptedAt > m ? f.acceptedAt : m), '');
      const last = await getState(env.DB, `edgar:${t}`);
      const etf = sicToEtf(sub.sic);
      if (etf && (await getState(env.DB, `sector:${t}`)) !== etf) await setStateStmt(env.DB, `sector:${t}`, etf, at).run();
      out.push({ ticker: t, cik, names: [sub.name, ...sub.formerNames], sic: sub.sic, all, fresh: last ? all.filter((f) => f.acceptedAt > last) : [], latest: latest || last || '' });
    } catch (e) {
      notes.push(`${t} 的申報抓不到：${errText(e)}`);
    }
  }
  return out;
}

/** 記下看過的最新申報。 */
export async function markSeen(db: D1Database, checks: FilingCheck[], now: Date): Promise<void> {
  for (const c of checks) if (c.latest) await setStateStmt(db, `edgar:${c.ticker}`, c.latest, now.toISOString()).run();
}

/** 產業 ETF（第一次看申報時從 SIC 對照出來的）。 */
export async function sectorEtfs(db: D1Database, tickers: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const t of tickers) {
    const v = await getState(db, `sector:${t}`);
    if (v) out[t] = v;
  }
  return out;
}

// ---------------------------------------------------------------- 事件紀錄（sec_events）

export interface SecEventRow {
  id: number;
  ticker: string;
  accession: string;
  form: string;
  event_date: string;
  accepted_at: string | null;
  code: string;
  sub: string;
  by_rule: number;
  display_only: number;
  source: string;
  detail: string | null;
  status: string;
  handled_note: string | null;
  created_at: string;
}

/** 新的命中 → 寫入（同一檔、同一份申報、同一細項只記一次）。 */
export function insertHitStmts(db: D1Database, ticker: string, hits: FilingHit[], source: string, at: string, status: (h: FilingHit) => string): D1PreparedStatement[] {
  const ins = db.prepare('INSERT OR IGNORE INTO sec_events (ticker, accession, form, event_date, accepted_at, code, sub, by_rule, display_only, source, detail, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  return hits.map((h) => ins.bind(ticker, h.accession, h.form, h.date, h.acceptedAt || null, h.code, h.sub, h.byRule ? 1 : 0, h.displayOnly ? 1 : 0, source, h.detail ?? null, status(h), at));
}

export async function loadEvents(db: D1Database, opt: { ticker?: string; since?: string; status?: string } = {}): Promise<SecEventRow[]> {
  const where: string[] = [];
  const args: unknown[] = [];
  for (const [col, v] of [['ticker = ?', opt.ticker], ['event_date >= ?', opt.since], ['status = ?', opt.status]] as const) {
    if (!v) continue;
    where.push(col);
    args.push(v);
  }
  const sql = `SELECT * FROM sec_events${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY event_date DESC, id DESC LIMIT 500`;
  return (await db.prepare(sql).bind(...args).all<SecEventRow>()).results;
}

export const handledStmt = (db: D1Database, ids: number[], note: string) => db.prepare(`UPDATE sec_events SET status = 'HANDLED', handled_note = ? WHERE id IN (${ids.map(() => '?').join(',')})`).bind(note, ...ids);
