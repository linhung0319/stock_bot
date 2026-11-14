// T13：把 D1 的紀錄匯出到本機（scripts/export_records.py；格式見 docs/analysis/records_guide.md）。
//   GET /admin/export                         每張表的拉法、列數、最後 rowid；Worker 版本、上線日
//   GET /admin/export?table=<表>&after=<rowid> 照 rowid 分頁：rowid > after 的列，最多 limit 列、約 PAGE_BYTES 位元組
// 只增加（append）的表本機用 rowid 接著拉；會改（replace）的表每次整張重拉。JSON 欄位在這裡解析成物件，欄位名稱和 D1 相同。
// 不匯出：probe_runs、demo_state（和真實帳戶無關）、ai_tasks.evidence（和 ai_runs.pack 重複）。

export type ExportMode = 'append' | 'replace';

export interface ExportTable {
  mode: ExportMode;
  /** 存 JSON 字串的欄位（以 { 或 [ 開頭的才解析，其他照原樣）。 */
  json: string[];
  /** 不匯出的欄位。 */
  omit?: string[];
  /** 本機合併時的鍵（同一個鍵留 rowid 最大的；INSERT OR REPLACE 會換 rowid）。沒有就用 rowid。 */
  key?: string;
  /** 一頁最多幾列（大欄位的表要小，避免一次讀太多進記憶體）。 */
  pageRows: number;
}

export const EXPORT_TABLES: Record<string, ExportTable> = {
  // AI 的判斷
  ai_runs: { mode: 'replace', json: ['pack', 'pack_notes', 'outcome', 'process'], pageRows: 20 },
  ai_tasks: { mode: 'replace', json: ['result'], omit: ['evidence'], pageRows: 50 },
  ai_rejections: { mode: 'append', json: [], pageRows: 20 },
  mom_reviews: { mode: 'replace', json: ['hits'], pageRows: 500 },
  own_conditions: { mode: 'replace', json: ['check_json'], pageRows: 500 },
  sec_events: { mode: 'replace', json: [], pageRows: 500 },
  macro_snapshots: { mode: 'replace', json: ['data'], pageRows: 50 },
  // 使用者的選擇與帳戶
  notifications: { mode: 'replace', json: ['body'], pageRows: 200 },
  shadow_records: { mode: 'append', json: ['body'], pageRows: 500 },
  ledger_events: { mode: 'append', json: [], pageRows: 1000 },
  snapshots: { mode: 'append', json: ['positions'], pageRows: 500 },
  account_state: { mode: 'replace', json: ['state'], pageRows: 10 },
  account_history: { mode: 'append', json: ['state'], pageRows: 50 },
  // 市場資料
  price_series: { mode: 'replace', json: ['bars'], key: 'ticker', pageRows: 40 },
  rankings: { mode: 'append', json: ['ord', 'detail'], key: 'session', pageRows: 50 },
  constituents: { mode: 'append', json: ['only_spy', 'only_wiki', 'holdings'], key: 'session', pageRows: 50 },
  calendar_overrides: { mode: 'replace', json: [], pageRows: 1000 },
  // 系統運作
  data_runs: { mode: 'append', json: ['detail'], pageRows: 500 },
  flow_runs: { mode: 'append', json: ['detail'], pageRows: 500 },
  pushes: { mode: 'append', json: [], pageRows: 1000 },
  alerts: { mode: 'replace', json: ['detail'], pageRows: 1000 },
  flow_state: { mode: 'replace', json: ['value'], pageRows: 500 },
};

export const NOT_EXPORTED = ['probe_runs', 'demo_state'];
/** 一頁大約多大（JSON 位元組）。至少回一列，所以單列比這大時那一頁會超過。 */
export const PAGE_BYTES = 4 * 1024 * 1024;
export const LAUNCH_DATE_KEY = 'launch_date';

/** 表的欄位（每次都讀：migration 會加欄位）。表名只會是 EXPORT_TABLES 的鍵，不是使用者的輸入。 */
async function columnsOf(db: D1Database, table: string): Promise<string[]> {
  return (await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>()).results.map((r) => r.name);
}

function parseJsonCol(v: unknown): unknown {
  if (typeof v !== 'string' || !/^\s*[[{]/.test(v)) return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

/** flow_state 的上線日（T17 寫入；還沒有就是 null）。值可以是 2026-12-01 或 JSON 字串 "2026-12-01"。 */
export async function launchDate(db: D1Database): Promise<string | null> {
  const r = await db.prepare('SELECT value FROM flow_state WHERE key = ?').bind(LAUNCH_DATE_KEY).first<{ value: string }>();
  if (!r) return null;
  const v = parseJsonCol(r.value.startsWith('"') ? `[${r.value}]` : r.value);
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

export async function exportMeta(db: D1Database, version: string, now: Date) {
  const tables: Record<string, { mode: ExportMode; rows: number; last_rowid: number; key: string; omit: string[] }> = {};
  for (const [name, t] of Object.entries(EXPORT_TABLES)) {
    const r = await db.prepare(`SELECT COUNT(*) AS n, COALESCE(MAX(rowid), 0) AS last FROM ${name}`).first<{ n: number; last: number }>();
    tables[name] = { mode: t.mode, rows: r?.n ?? 0, last_rowid: r?.last ?? 0, key: t.key ?? '_rowid', omit: t.omit ?? [] };
  }
  return { version, generated_at: now.toISOString(), launch_date: await launchDate(db), page_bytes: PAGE_BYTES, not_exported: NOT_EXPORTED, tables };
}

export interface ExportPage {
  table: string;
  after: number;
  rows: Record<string, unknown>[];
  /** 下一頁從這個 rowid 之後接著拉。 */
  next_after: number;
  /** true = rowid > after 的列都已經回完了。 */
  done: boolean;
}

/** 一頁：rowid > after 的列，照 rowid 排；到 limit 列或 PAGE_BYTES 為止（至少一列）。 */
export async function exportPage(db: D1Database, table: string, after: number, limit?: number, pageBytes = PAGE_BYTES): Promise<ExportPage> {
  const t = EXPORT_TABLES[table];
  const cols = (await columnsOf(db, table)).filter((c) => !(t.omit ?? []).includes(c));
  const n = Math.max(1, Math.min(limit ?? t.pageRows, t.pageRows));
  const fetched = (await db.prepare(`SELECT rowid AS _rowid, ${cols.map((c) => `"${c}"`).join(', ')} FROM ${table} WHERE rowid > ? ORDER BY rowid LIMIT ?`).bind(after, n).all<Record<string, unknown>>()).results;
  const rows: Record<string, unknown>[] = [];
  let bytes = 0;
  for (const raw of fetched) {
    const row: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) row[k] = t.json.includes(k) ? parseJsonCol(v) : v;
    const size = JSON.stringify(row).length;
    if (rows.length && bytes + size > pageBytes) break;
    rows.push(row);
    bytes += size;
  }
  const last = rows.length ? (rows[rows.length - 1]._rowid as number) : after;
  return { table, after, rows, next_after: last, done: rows.length === fetched.length && fetched.length < n };
}

/** /admin/export 的處理（驗證在呼叫的地方：ADMIN_TOKEN 的 Bearer）。 */
export async function handleExport(db: D1Database, url: URL, version: string, now: Date): Promise<Response> {
  const table = url.searchParams.get('table');
  if (!table) return Response.json(await exportMeta(db, version, now));
  if (NOT_EXPORTED.includes(table)) return Response.json({ error: 'not_exported', table }, { status: 400 });
  if (!Object.hasOwn(EXPORT_TABLES, table)) return Response.json({ error: 'unknown_table', table }, { status: 400 });
  const after = Number(url.searchParams.get('after') ?? '0');
  const limitRaw = url.searchParams.get('limit');
  const limit = limitRaw === null ? undefined : Number(limitRaw);
  if (!Number.isSafeInteger(after) || after < 0 || (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1))) return Response.json({ error: 'bad_paging' }, { status: 400 });
  return Response.json(await exportPage(db, table, after, limit));
}
