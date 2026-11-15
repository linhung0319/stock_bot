// T25：論點檔（own_thesis §1.2、§1.3）。每檔自選一份，不是一張新表，是從五個地方組出來的檢視：
//   帳戶狀態 acct.own[代號]   現行的論點、前提、靜默期（論點與前提跟著帳戶走，復原快照時一起回來）
//   own_conditions           條件（只讀 file_id 等於這檔現在的 fileId 的列）
//   sec_events               事件
//   ai_runs                  歷次 L2 的執行與結論
//   own_thesis_log           開檔、結案（之後的任務加論點的每一版、失效通知、回應、條件的勾選）
// L2 各功能的證據包（F24、F7、F25、自選股的 F19）都從這裡取資料；這裡也放組證據包要的純函式（事件 V、預設前提的 D1～D3、
// 8-K 的挑選順序、論點那一份 note）。讀 D1，所以不在引擎裡。
import type { EvidencePack, Outcome, PackDoc, PackPremise } from '../ai/check';
import { confirmMode, type OwnCondition } from '../ai/ownReview';
import type { Account, OwnMeta, Thesis, Tier } from '../engine';
import { XBRL_METRICS, type QuarterRow } from '../data/edgar';
import type { Filing } from '../data/sources';
import { accOf, loadEvents, type SecEventRow } from './filings';

type Fact = EvidencePack['facts'][number];

// ---------------------------------------------------------------- 條件的儲存

interface CondRow {
  id: number;
  ticker: string;
  run_id: string;
  cond_id: string;
  direction: string;
  kind: string;
  text: string;
  check_json: string;
  tier_if_met: string | null;
  status: string;
  created_at: string;
  met_at: string | null;
  note: string | null;
  origin: string;
  file_id?: string | null;
  accepted_at?: string | null;
  action?: string | null;
  premise_id?: string | null;
  supersedes?: number | null;
  met_basis?: string | null;
  verified_at?: string | null;
  progress_json?: string | null;
  auto?: number | null;
}
/** 成立時做什麼（own_thesis §1.5）：出清／減半／重新審查。 */
export type CondAction = 'EXIT' | 'HALF' | 'REVIEW';
export const COND_ACTIONS: readonly CondAction[] = ['EXIT', 'HALF', 'REVIEW'];
/** 財報類條件的進度（own_thesis §3.6.2）。values 新到舊；streak 是從最新一季起連續符合幾季。 */
export interface CondProgress {
  at: string;
  basis: 'XBRL' | 'PRESS';
  period: string;
  values: (number | null)[];
  level: number;
  streak: number;
  need: number;
}
export type FileCondition = OwnCondition & {
  id: number;
  origin: 'AI' | 'USER';
  fileId: string | null;
  /** 你勾選的時間：有值就是「你定的條件」（舊列沒有）。 */
  acceptedAt: string | null;
  action: CondAction | null;
  premiseId: string | null;
  /** 想取代的那一條的列編號。 */
  supersedes: number | null;
  metBasis: string | null;
  verifiedAt: string | null;
  progress: CondProgress | null;
  /** 寫入時有沒有通過格式檢查（舊列沒有：null）。 */
  auto: boolean | null;
};
const parseJson = <T>(s: string | null | undefined): T | null => {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
};
const toCond = (r: CondRow): FileCondition => ({
  id: r.id,
  ticker: r.ticker,
  runId: r.run_id,
  condId: r.cond_id,
  direction: r.direction as OwnCondition['direction'],
  kind: r.kind as OwnCondition['kind'],
  text: r.text,
  check: JSON.parse(r.check_json),
  tierIfMet: r.tier_if_met as Tier | null,
  status: r.status as OwnCondition['status'],
  createdAt: r.created_at,
  metAt: r.met_at,
  note: r.note,
  origin: r.origin === 'USER' ? 'USER' : 'AI',
  fileId: r.file_id ?? null,
  acceptedAt: r.accepted_at ?? null,
  action: COND_ACTIONS.includes(r.action as CondAction) ? (r.action as CondAction) : null,
  premiseId: r.premise_id ?? null,
  supersedes: r.supersedes ?? null,
  metBasis: r.met_basis ?? null,
  verifiedAt: r.verified_at ?? null,
  progress: parseJson<CondProgress>(r.progress_json),
  auto: r.auto === null || r.auto === undefined ? null : r.auto === 1,
});

/**
 * 條件（被替換的不算）。file：string = 那一份論點檔的；null = 沒有論點檔編號的舊列；
 * 不給 = 這一檔所有論點檔的（只給歷史與測試看；監測、證據包一律用 fileConditions）。
 */
export async function loadConditions(db: D1Database, ticker?: string, file?: string | null): Promise<FileCondition[]> {
  const where = ["status != 'REPLACED'"];
  const args: unknown[] = [];
  if (ticker) {
    where.push('ticker = ?');
    args.push(ticker);
  }
  if (file === null) where.push('file_id IS NULL');
  else if (file !== undefined) {
    where.push('file_id = ?');
    args.push(file);
  }
  return (await db.prepare(`SELECT * FROM own_conditions WHERE ${where.join(' AND ')} ORDER BY id`).bind(...args).all<CondRow>()).results.map(toCond);
}

/** 這檔現在這份論點檔的條件（不是自選就沒有；T25 之前建立、沒有 fileId 的自選讀沒有編號的舊列）。 */
export async function fileConditions(db: D1Database, acct: Pick<Account, 'own'>, ticker: string): Promise<FileCondition[]> {
  const meta = acct.own[ticker];
  return meta ? loadConditions(db, ticker, meta.fileId ?? null) : [];
}

// ---------------------------------------------------------------- 論點檔

export type FileKind = 'THESIS' | 'DEFAULT_ONLY';
/** 論點檔的種類（程式判斷，不存）：前提裡至少一條不是系統預設 → 有論點。 */
export const fileKind = (meta: Pick<OwnMeta, 'premises'>): FileKind => (meta.premises.some((p) => p.origin !== 'SYSTEM_DEFAULT') ? 'THESIS' : 'DEFAULT_ONLY');

export interface ThesisPremise {
  id: string;
  text: string;
  origin: string;
  addedAt: string | null;
  breaksIf?: string;
  /** 最近一次三票一致的檢查（定期審查）；不一致的不算（own_thesis §1.4）。 */
  lastCheck: { date: string; runId: string; status: string } | null;
  /** 比 lastCheck 新的審查裡，這一條沒有一致結論（顯示「這次沒有一致結論」）。 */
  splitAfter: boolean;
}

export interface ThesisEvent {
  id: number;
  date: string;
  /** EDGAR 規則分類／SCAN 每日掃描／AI 轉交／PRICE 價格規則。 */
  source: string;
  code: string;
  sub: string;
  form: string;
  /** 原文的來源編號（edgar:<申報編號>、nasdaq-rss:…）；沒有原文的是 sec_events 原本的值。 */
  sourceId: string;
  /** 申報編號（原文是申報時）。 */
  accession: string | null;
  detail: string | null;
  status: string;
  displayOnly: boolean;
  createdAt: string;
  /** 上一次有結論的審查之後的（沒有審查時：最近 120 天）。 */
  isNew: boolean;
}

export interface ThesisReview {
  runId: string;
  date: string;
  fn: string;
  /** 哪一種：定期審查／減半檢視／硬事件／條件確認／財報數字擷取。 */
  label: string;
  trigger: string | null;
  /** ai_runs.status 是 PENDING 時是 PENDING；其餘是結論的狀態（AGREED、SPLIT、TIMEOUT…）。 */
  status: string;
  verdict: string | null;
  votes: Record<string, number>;
  /** 每一票都判「不成立」的前提。 */
  brokenPremises: string[];
  notif: number | null;
  response: { outcome: string; reason: string | null } | null;
  /** 這次每一票對每條前提的判斷（算「最近一次檢查」用）。 */
  premiseVotes: Record<string, string[]>;
}

export interface ThesisLogRow {
  id: number;
  kind: string;
  session: string;
  at: string;
  ref: string | null;
  body: Record<string, unknown>;
  accountVersion: number | null;
}

export interface ThesisFile {
  ticker: string;
  /** 論點檔編號；T25 之前建立的自選沒有（null）。 */
  fileId: string | null;
  /** 開檔的訊號日（從編號或 OPEN 紀錄來；都沒有是 null）。 */
  openedAt: string | null;
  origin: OwnMeta['origin'];
  kind: FileKind;
  status: 'OPEN';
  thesis: Thesis | null;
  premises: ThesisPremise[];
  conditions: FileCondition[];
  events: ThesisEvent[];
  reviews: ThesisReview[];
  disputes: NonNullable<OwnMeta['disputes']>;
  flags: string[];
  /** 上一次有結論的定期審查（3 票一致，含一致維持現狀；票數不一致、資料缺漏、逾時的不算）。 */
  lastReview: { runId: string; asOf: string; createdAt: string } | null;
  /** 沒有上一次審查時，「新的」從這一天起算（決策日往前 120 天）。 */
  newSince: string;
  log: ThesisLogRow[];
}

/** 論點檔讀進來的 L2 功能。 */
export const FILE_FNS: Record<string, string> = { OWN_REVIEW: '定期審查', OWN_DROP: '減半檢視', HARD_EVENT: '硬事件', OWN_CONDITION: '條件確認', OWN_EARNINGS: '財報數字擷取' };
/** 「有結論」的定期審查：3 票一致（含一致維持現狀）而且資料齊全。 */
const CONCLUSIVE = new Set(['AGREED', 'INSUFFICIENT']);
/** 沒有上一次審查時，事件與 8-K 往前看幾天（own_thesis §1.6）。 */
export const NO_REVIEW_DAYS = 120;
const minusDays = (d: string, n: number) => new Date(Date.parse(d) - n * 86400_000).toISOString().slice(0, 10);
const fileDate = (fileId: string | null, ticker: string) => (fileId && fileId.startsWith(ticker + '@') ? fileId.slice(ticker.length + 1, ticker.length + 11) : null);

interface RunRow {
  run_id: string;
  fn: string;
  as_of: string;
  created_at: string;
  status: string;
  outcome: string | null;
  detail: string | null;
}

function toReview(r: RunRow): ThesisReview {
  const o = r.outcome ? (JSON.parse(r.outcome) as Outcome) : null;
  const detail = r.detail ? (JSON.parse(r.detail) as Record<string, unknown>) : {};
  const valid = (o?.samples ?? []).filter((s) => s.valid);
  const premiseVotes: Record<string, string[]> = {};
  for (const s of valid) for (const p of s.premises) (premiseVotes[p.premise_id] ??= []).push(p.status);
  const brokenPremises = Object.entries(premiseVotes)
    .filter(([, v]) => v.length === valid.length && valid.length > 0 && v.every((x) => x === 'BROKEN'))
    .map(([id]) => id);
  const trigger = r.fn === 'OWN_REVIEW' ? String(detail.trigger ?? '') || null : r.fn === 'HARD_EVENT' ? ((detail.codes as string[] | undefined) ?? []).join('、') || null : r.fn === 'OWN_DROP' ? '慢規則減半' : r.fn === 'OWN_CONDITION' ? '新申報' : null;
  return { runId: r.run_id, date: r.as_of, fn: r.fn, label: FILE_FNS[r.fn] ?? r.fn, trigger, status: r.status === 'PENDING' || !o ? 'PENDING' : o.status, verdict: o?.verdict ?? null, votes: o?.votes ?? {}, brokenPremises, notif: null, response: null, premiseVotes };
}

/**
 * 組出一檔自選的論點檔（own_thesis §1.3）。不是自選（已結案）就是 null。
 * asOf：決策日，沒有上一次審查時「新的」事件從往前 120 天起算（不給就用開檔日）。
 */
export async function thesisFile(db: D1Database, acct: Pick<Account, 'own'>, ticker: string, asOf?: string): Promise<ThesisFile | null> {
  const meta = acct.own[ticker];
  if (!meta) return null;
  const fileId = meta.fileId ?? null;
  const log: ThesisLogRow[] = fileId
    ? (await db.prepare('SELECT * FROM own_thesis_log WHERE file_id = ? ORDER BY id').bind(fileId).all<{ id: number; kind: string; session: string; at: string; ref: string | null; body: string; account_version: number | null }>()).results.map((r) => ({
        id: r.id,
        kind: r.kind,
        session: r.session,
        at: r.at,
        ref: r.ref,
        body: JSON.parse(r.body) as Record<string, unknown>,
        accountVersion: r.account_version,
      }))
    : [];
  const openedAt = fileDate(fileId, ticker) ?? log.find((l) => l.kind === 'OPEN')?.session ?? null;
  const conditions = await loadConditions(db, ticker, fileId);

  // 歷次 L2：這份論點檔開檔之後的（同一天結案又重開的，前一份那天的執行也會算進來）
  const runs = (
    await db
      .prepare(`SELECT run_id, fn, as_of, created_at, status, outcome, json_extract(pack, '$.rule.detail') AS detail FROM ai_runs WHERE ticker = ? AND as_of >= ? AND fn IN (${Object.keys(FILE_FNS).map(() => '?').join(',')}) ORDER BY as_of DESC, created_at DESC LIMIT 30`)
      .bind(ticker, openedAt ?? '0000-00-00', ...Object.keys(FILE_FNS))
      .all<RunRow>()
  ).results;
  const reviews = runs.map(toReview);
  // 通知與使用者的回應（失效通知 BREAK_NOTICE 帶 runIds，回應 RESPONSE 帶通知編號；由之後的任務寫入）
  for (const l of log.filter((x) => x.kind === 'BREAK_NOTICE')) {
    const ids = (l.body.runIds as string[] | undefined) ?? [];
    const notif = typeof l.body.notif === 'number' ? l.body.notif : null;
    for (const rv of reviews) if (ids.includes(rv.runId) && rv.notif === null) rv.notif = notif;
  }
  for (const l of log.filter((x) => x.kind === 'RESPONSE')) {
    for (const rv of reviews) if (rv.notif !== null && rv.notif === l.body.notif) rv.response = { outcome: String(l.body.outcome ?? ''), reason: (l.body.reason as string | null) ?? null };
  }
  const lastRun = runs.find((r) => r.fn === 'OWN_REVIEW' && r.status === 'DONE' && r.outcome && CONCLUSIVE.has((JSON.parse(r.outcome) as Outcome).status));
  const lastReview = lastRun ? { runId: lastRun.run_id, asOf: lastRun.as_of, createdAt: lastRun.created_at } : null;
  const ref = asOf ?? openedAt ?? '0000-00-00';
  const newSince = minusDays(ref, NO_REVIEW_DAYS);

  // 前提的最近一次檢查：新到舊找第一次 3 票一致的定期審查
  const ownReviews = reviews.filter((r) => r.fn === 'OWN_REVIEW' && r.status !== 'PENDING');
  const premises: ThesisPremise[] = meta.premises.map((p) => {
    let splitAfter = false;
    let lastCheck: ThesisPremise['lastCheck'] = null;
    for (const r of ownReviews) {
      const v = r.premiseVotes[p.id];
      if (!v?.length) continue;
      if (v.length >= 3 && v.every((x) => x === v[0])) {
        lastCheck = { date: r.date, runId: r.runId, status: v[0] };
        break;
      }
      splitAfter = true;
    }
    return { id: p.id, text: p.text, origin: p.origin, addedAt: p.addedAt ?? null, ...(p.breaksIf ? { breaksIf: p.breaksIf } : {}), lastCheck, splitAfter };
  });

  // 事件：開檔前一年起（預設前提的 D1 要看有效期間內的硬事件，最長 365 天）
  const evSince = minusDays(openedAt && openedAt < ref ? openedAt : ref, 365);
  const events = (await loadEvents(db, { ticker, since: evSince })).map((e) => toEvent(e, lastReview, newSince));
  return {
    ticker,
    fileId,
    openedAt,
    origin: meta.origin,
    kind: fileKind(meta),
    status: 'OPEN',
    thesis: meta.thesis ?? null,
    premises,
    conditions,
    events,
    reviews,
    disputes: meta.disputes ?? [],
    flags: meta.flags,
    lastReview,
    newSince,
    log,
  };
}

/** 在上一次有結論的審查之後嗎（同一天的看時間：事件的建立時間、申報的接受時間晚於那次審查開始）。沒有審查時看最近 120 天。 */
export function afterLastReview(tf: Pick<ThesisFile, 'lastReview' | 'newSince'>, date: string, at: string | null): boolean {
  const r = tf.lastReview;
  if (!r) return date >= tf.newSince;
  return date > r.asOf || (date === r.asOf && !!at && at > r.createdAt);
}

function toEvent(e: SecEventRow, last: ThesisFile['lastReview'], newSince: string): ThesisEvent {
  const ref = accOf(e.accession);
  return {
    id: e.id,
    date: e.event_date,
    source: e.source,
    code: e.code,
    sub: e.sub,
    form: e.form,
    sourceId: ref.kind === 'FILING' ? `edgar:${ref.acc}` : e.accession,
    accession: ref.kind === 'FILING' ? ref.acc : null,
    detail: e.detail,
    status: e.status,
    displayOnly: e.display_only === 1,
    createdAt: e.created_at,
    isNew: afterLastReview({ lastReview: last, newSince }, e.event_date, e.created_at),
  };
}

/** 證據包的前提（F19 用）：論點檔的現行前提，格式同 ownPremises。 */
export function filePremises(tf: Pick<ThesisFile, 'premises'>): PackPremise[] {
  return tf.premises.map((p) => ({ id: p.id, text: p.text, origin: p.origin, ...(p.breaksIf ? { breaksIf: p.breaksIf } : {}) }));
}

// ---------------------------------------------------------------- 證據包要的部分（純函式）

const SOURCE_TEXT: Record<string, string> = { EDGAR: '申報分類', SCAN: '每日掃描', AI: 'AI 轉交', PRICE: '價格規則' };
const STATUS_TEXT: Record<string, string> = { NEW: '待處理', HANDLED: '已處理', INFO: '只記錄' };
/** 證據包最多放幾筆事件（own_thesis §1.6）。 */
export const MAX_V = 15;
/** F24 最多放幾份 8-K 原文（own_thesis §1.6）。 */
export const MAX_REVIEW_8K = 5;

/** 論點檔種類 T0 ＋ 上次有結論的審查之後的事件 V1…（最多 15 筆，新到舊；含每日掃描只記錄的）。 */
export function thesisFacts(tf: ThesisFile): Fact[] {
  const out: Fact[] = [{ id: 'T0', label: '論點檔種類', value: tf.kind === 'THESIS' ? '有論點' : '只有預設（一般健康檢查，不是使用者的論點）' }];
  tf.events
    .filter((e) => e.isNew)
    .slice(0, MAX_V)
    .forEach((e, k) =>
      out.push({
        id: `V${k + 1}`,
        label: `事件 ${e.date}（${SOURCE_TEXT[e.source] ?? e.source}）：${e.form} ${e.code}／${e.sub}`,
        value: e.detail ?? e.code,
        note: `來源 ${e.sourceId}；${STATUS_TEXT[e.status] ?? e.status}`,
      }),
    );
  return out;
}

const HARD_CODES = ['PENDING_MA', 'ACCOUNTING', 'REGULATORY'];
const HARD_TEXT: Record<string, string> = { PENDING_MA: '被收購', ACCOUNTING: '會計問題', REGULATORY: '重大監管或訴訟' };
const HARD_WINDOW: Record<string, number> = { PENDING_MA: 365, ACCOUNTING: 180, REGULATORY: 180 };
const pc = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;

/** 同一季的去年（期末差 365 天 ± 20 天）。 */
function yearAgo(rows: QuarterRow[], end: string): QuarterRow | undefined {
  const t = Date.parse(end) - 365 * 86400_000;
  return rows.find((r) => Math.abs(Date.parse(r.end) - t) <= 20 * 86400_000);
}
/** 最近兩季是不是相連的兩季（期末差 120 天以內）。 */
const consecutive = (a: QuarterRow, b: QuarterRow) => Date.parse(a.end) - Date.parse(b.end) <= 120 * 86400_000;

/**
 * 系統預設前提的程式結果（own_thesis §1.12；只有預設前提的股票才放）：
 *   D1 有效期間內的硬事件紀錄與未解除的標記
 *   D2 最近兩季的營收年增率與「成立／不成立／資料不足」
 *   D3 最近兩季與去年同季的稀釋每股盈餘與結論（第四季常常沒有單季值 → 資料不足）
 * rows：XBRL 季度表（新的在前）；null = 抓不到。
 */
export function defaultFacts(tf: ThesisFile, rows: QuarterRow[] | null, asOf: string): Fact[] {
  if (tf.kind !== 'DEFAULT_ONLY') return [];
  const hard = tf.events.filter((e) => HARD_CODES.includes(e.code) && !e.displayOnly && e.date <= asOf && e.date >= minusDays(asOf, HARD_WINDOW[e.code] ?? 180));
  const d1 = [...hard.map((e) => `${e.date} ${e.form} ${HARD_TEXT[e.code]}（${e.sub}，${STATUS_TEXT[e.status] ?? e.status}，來源 ${e.sourceId}）`), ...tf.flags.map((f) => `未解除的硬事件標記：${HARD_TEXT[f] ?? f}`)];
  const r = rows ?? [];
  let d2: string;
  if (r.length < 2) d2 = `資料不足（${rows ? '季度數字不到兩季' : 'XBRL 抓不到'}）`;
  else if (!consecutive(r[0], r[1])) d2 = `資料不足（最近兩季 ${r[0].end}、${r[1].end} 不相連）`;
  else if (r[0].revenueYoY === null || r[1].revenueYoY === null) d2 = `資料不足（${r[0].end} ${r[0].revenueYoY === null ? '—' : pc(r[0].revenueYoY)}、${r[1].end} ${r[1].revenueYoY === null ? '—' : pc(r[1].revenueYoY)}）`;
  else d2 = `${r[0].end} ${pc(r[0].revenueYoY)}、${r[1].end} ${pc(r[1].revenueYoY)} → ${r[0].revenueYoY < 0 && r[1].revenueYoY < 0 ? '不成立（連兩季是負的）' : '成立'}`;
  let d3: string;
  if (r.length < 2) d3 = `資料不足（${rows ? '季度數字不到兩季' : 'XBRL 抓不到'}）`;
  else if (!consecutive(r[0], r[1])) d3 = `資料不足（最近兩季 ${r[0].end}、${r[1].end} 不相連）`;
  else {
    const pair = [r[0], r[1]].map((q) => ({ q, y: yearAgo(r, q.end) }));
    const txt = pair.map(({ q, y }) => `${q.end} ${q.epsDiluted === null ? '—' : q.epsDiluted.toFixed(2)}（去年同季 ${y?.epsDiluted == null ? '—' : y.epsDiluted.toFixed(2)}）`).join('、');
    const ok = pair.every(({ q, y }) => q.epsDiluted !== null && y?.epsDiluted != null);
    d3 = ok ? `${txt} → ${pair.every(({ q, y }) => q.epsDiluted! < y!.epsDiluted!) ? '不成立（連兩季低於去年同季）' : '成立'}` : `資料不足（${txt}）`;
  }
  return [
    { id: 'D1', label: 'P1 財報可信、沒有硬事件：有效期間內的硬事件紀錄與未解除的標記', value: d1.length ? d1.join('；') : '沒有' },
    { id: 'D2', label: 'P2 營收年增率（最近兩季）', value: d2 },
    { id: 'D3', label: 'P3 稀釋每股盈餘對去年同季（最近兩季）', value: d3 },
  ];
}

/** 規則或每日掃描有標記過的申報編號（挑 8-K 的順序用）。 */
export const flaggedAccessions = (tf: Pick<ThesisFile, 'events'>): Set<string> => new Set(tf.events.map((e) => e.accession).filter((x): x is string => !!x));

/**
 * 申報原文的挑選順序（own_thesis §1.6；F7 照同一個順序，§3.3）：① 最新的 Item 2.02 ② 規則或每日掃描有標記的（新到舊）③ 其餘（新到舊）。取前 n 份。
 */
export function pickFilings<F extends Pick<Filing, 'accession' | 'form' | 'items' | 'filingDate' | 'acceptedAt'>>(filings: F[], flagged: Set<string>, n: number): F[] {
  const sorted = [...filings].sort((a, b) => (b.acceptedAt || b.filingDate).localeCompare(a.acceptedAt || a.filingDate));
  const pr = sorted.find((f) => f.form.startsWith('8-K') && f.items.includes('2.02'));
  const marked = sorted.filter((f) => f !== pr && flagged.has(f.accession));
  const rest = sorted.filter((f) => f !== pr && !flagged.has(f.accession));
  return [...(pr ? [pr] : []), ...marked, ...rest].slice(0, n);
}

const ORIGIN_TEXT: Record<string, string> = { INITIAL: '上線時就持有', NEW: '新增自選', TRANSFER: '從動能轉入', ADOPT: '認養', MANUAL: '自己買進' };
const PREM_TEXT: Record<string, string> = { HOLDS: '成立', BROKEN: '不成立', INSUFFICIENT: '證據不足' };
const OUTCOME_TEXT: Record<string, string> = { FOLLOW: '照做', REVISE: '修正論點', DISAGREE: '不同意', SKIPPED: '沒有回應', NONE: '沒有回應', RULE: '照規則' };

/**
 * 論點那一份 note（own_thesis §1.6）：論點本文、最近 3 次定期審查的結論與使用者的回應、靜默中的前提與當時的理由。
 * source_id = thesis:<fileId>。是背景，不是前提成立的證據。三樣都沒有時不放（只有空殼沒有用）。
 */
export function thesisNote(tf: ThesisFile, asOf: string): PackDoc | null {
  const reviews = tf.reviews.filter((r) => r.fn === 'OWN_REVIEW' && r.status !== 'PENDING').slice(0, 3);
  const disputes = tf.disputes.filter((d) => d.until >= asOf);
  if (!tf.thesis?.text && !reviews.length && !disputes.length) return null;
  const L: string[] = [];
  L.push(`論點檔 ${tf.fileId ?? tf.ticker}（${tf.openedAt ?? '開檔日不明'} 開檔，${ORIGIN_TEXT[tf.origin] ?? tf.origin}；${tf.kind === 'THESIS' ? '有論點' : '只有系統預設前提'}）。`);
  L.push('這一份是背景，不是前提成立或不成立的證據。');
  L.push('');
  if (tf.thesis?.text) L.push(`論點（${tf.thesis.setAt} 定，${tf.thesis.source === 'DISCUSSION' ? '討論後貼回' : '在網站手寫'}，第 ${tf.thesis.version} 版${tf.thesis.afterBreak ? `，失效後修改 ${tf.thesis.afterBreak} 次` : ''}）：`, tf.thesis.text);
  else L.push('論點本文：還沒寫。');
  if (reviews.length) {
    L.push('', '最近的定期審查：');
    for (const r of reviews) {
      const votes = Object.entries(r.votes)
        .map(([k, v]) => `${k} ${v}`)
        .join('、');
      const prem = Object.entries(r.premiseVotes)
        .map(([id, v]) => `${id} ${v.map((x) => PREM_TEXT[x] ?? x).join('／')}`)
        .join('；');
      const resp = r.response ? `；你的回應：${OUTCOME_TEXT[r.response.outcome] ?? r.response.outcome}${r.response.reason ? `（${r.response.reason}）` : ''}` : '';
      L.push(`- ${r.date}（${r.trigger ?? '—'}，${r.runId}）：${r.status} ${r.verdict ?? '—'}${votes ? `（${votes}）` : ''}${prem ? `；前提逐票：${prem}` : ''}${r.brokenPremises.length ? `；三票都判不成立：${r.brokenPremises.join('、')}` : ''}${resp}`);
    }
  }
  if (disputes.length) {
    L.push('', '靜默中的前提（使用者不同意之前的判斷）：');
    for (const d of disputes) L.push(`- ${d.premiseId} 到 ${d.until}（${d.since} 起）：${d.reason}`);
  }
  return { id: `T-${tf.ticker}`, source_id: `thesis:${tf.fileId ?? tf.ticker}`, kind: 'note', date: asOf, title: `${tf.ticker} 的論點檔（背景，不是前提成立的證據）`, text: L.join('\n') };
}

// ---------------------------------------------------------------- 條件的所有權（T26，own_thesis §1.5、§1.6、§3.6.2；純函式）

/** 一檔「你定的條件」（ACTIVE＋REVIEW_ONLY）最多幾條（§1.5 第 5 點）。 */
export const MAX_OWNED = 8;
/** 一次審查最多寫幾條建議（§1.5 第 1 點）。 */
export const MAX_PROPOSED = 3;
/** 會自己發通知的「你定的條件」狀態。 */
export const OWNED_LIVE = ['ACTIVE', 'REVIEW_ONLY'];

/** 你定的條件：有勾選時間；舊資料裡使用者確認過的出場條件（origin = USER）也算。 */
export const isOwned = (c: Pick<FileCondition, 'acceptedAt' | 'origin'>): boolean => !!c.acceptedAt || c.origin === 'USER';

/** 勾選時預設的動作：帶 AI 建議的檔位（出清、減半），其他（升級、沒寫）是重新審查。 */
export function defaultAction(c: Pick<FileCondition, 'direction' | 'tierIfMet'>): CondAction {
  if (c.direction === 'DOWN' && c.tierIfMet === 'EXIT') return 'EXIT';
  if (c.direction === 'DOWN' && c.tierIfMet === 'HALF') return 'HALF';
  return 'REVIEW';
}

/** 勾選之後的狀態（§1.5「怎麼確認」）：程式比對或新申報確認 → 監測中；只有法說會、新聞 → 只在審查時檢查；其他 → 只記錄。 */
export function acceptStatus(c: Pick<FileCondition, 'kind' | 'check' | 'auto' | 'status'>): 'ACTIVE' | 'REVIEW_ONLY' | 'MANUAL' {
  const manual = c.auto === false || (c.auto === null && c.status === 'MANUAL');
  const m = confirmMode({ kind: c.kind, check: c.check, manual });
  return m === 'XBRL' || m === 'FILING' ? 'ACTIVE' : m === 'REVIEW_ONLY' ? 'REVIEW_ONLY' : 'MANUAL';
}

/** 成立時要通知的檔位：動作是出清或減半；重新審查不發通知。沒有動作的舊列照舊（降級條件的 tier_if_met）。 */
export function notifyTier(c: Pick<FileCondition, 'action' | 'direction' | 'tierIfMet'>): Tier | null {
  if (c.action === 'EXIT' || c.action === 'HALF') return c.action;
  if (c.action === 'REVIEW') return null;
  return c.direction === 'DOWN' && c.tierIfMet ? c.tierIfMet : null;
}

/**
 * 財報類條件的進度（§3.6.2）：最近幾季的數值（新到舊，最多 4 季）、門檻、從最新一季起連續符合幾季、要連續幾季。
 * 指標不認得或沒有季度數字 → null。
 */
export function xbrlProgress(rows: QuarterRow[], check: Record<string, unknown>, at: string): CondProgress | null {
  const m = XBRL_METRICS[String(check.metric)];
  const level = Number(check.level);
  if (!m || !rows.length || !Number.isFinite(level)) return null;
  const need = Math.max(1, Math.min(4, Number(check.quarters) || 1));
  const below = check.type === 'xbrl_metric_below';
  const values = rows.slice(0, Math.max(need, 4)).map(m.get);
  let streak = 0;
  for (const v of values) {
    if (v === null || !(below ? v < level : v > level)) break;
    streak++;
  }
  return { at, basis: 'XBRL', period: rows[0].end, values, level, streak: Math.min(streak, need), need };
}

const fmtMetric = (metric: string, v: number | null) => {
  if (v === null) return '—';
  const m = XBRL_METRICS[metric];
  if (m?.pct) return `${(v * 100).toFixed(1)}%`;
  return Math.abs(v) >= 1e6 ? `${(v / 1e6).toFixed(0)}M` : v.toFixed(2);
};
const KIND_TEXT: Record<string, string> = { XBRL: '財報', EVENT: '事件', PRICE: '價格' };
export const ACTION_TEXT: Record<CondAction, string> = { EXIT: '出清', HALF: '減半', REVIEW: '重新審查' };
const md = (iso: string | null) => (iso ? `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}` : '—');

/** 持股頁的一行進度：`最新一季 71.2%（門檻 70%）；已連續 1／2 季`。 */
export function progressText(c: Pick<FileCondition, 'progress' | 'check'>): string | null {
  const p = c.progress;
  if (!p) return null;
  const metric = String(c.check.metric);
  return `最新一季 ${fmtMetric(metric, p.values[0] ?? null)}（${p.period}，門檻 ${fmtMetric(metric, p.level)}）；已連續 ${p.streak}／${p.need} 季`;
}

/** 誰定的、哪一天（§1.5）：「你寫的，11/20 定」「AI 建議，你在 11/20 勾選」「AI 建議，11/20 的審查寫的」。 */
export function ownerText(c: Pick<FileCondition, 'origin' | 'acceptedAt' | 'createdAt'>): string {
  if (c.origin === 'USER') return `你寫的，${md(c.acceptedAt ?? c.createdAt)} 定`;
  return c.acceptedAt ? `AI 建議，你在 ${md(c.acceptedAt)} 勾選` : `AI 建議，${md(c.createdAt)} 的審查寫的`;
}

/** 怎麼確認（§1.5 的顯示）。 */
export function confirmText(c: Pick<FileCondition, 'kind' | 'check' | 'auto' | 'status'>): string {
  const s = acceptStatus(c);
  if (s === 'MANUAL') return '只記錄';
  if (s === 'REVIEW_ONLY') return '只在定期審查時檢查';
  return c.kind === 'XBRL' ? '新財報出來時比對' : '新申報出來時由 AI 確認';
}

const STATE_TEXT: Record<string, string> = { ACTIVE: '監測中', REVIEW_ONLY: '只在定期審查時檢查', MANUAL: '只記錄', MET: '已成立', PROPOSED: '建議中', RETIRED: '已撤下', EXPIRED: '已過期' };

/**
 * F24、F7 的證據包裡的條件（§1.6）：
 *   C1…  你定的條件（ACTIVE、REVIEW_ONLY，以及上次有結論的審查之後成立的 MET）：誰哪天定的、成立時做什麼、怎麼確認、目前狀態
 *   W1…  觀察項（PROPOSED）：財報類附程式用當時的財報數字比對的結果
 * map：證據包的編號 → own_conditions 的列編號（審查回來時對回條件用，放在 rule.detail.conds）。
 * rows：XBRL 季度表（新的在前）；null = 抓不到。
 */
export function condFacts(tf: Pick<ThesisFile, 'conditions' | 'lastReview' | 'newSince'>, rows: QuarterRow[] | null): { facts: Fact[]; map: Record<string, number> } {
  const facts: Fact[] = [];
  const map: Record<string, number> = {};
  const owned = tf.conditions.filter((c) => isOwned(c) && (OWNED_LIVE.includes(c.status) || (c.status === 'MET' && !!c.metAt && afterLastReview(tf, c.metAt.slice(0, 10), c.metAt))));
  owned.forEach((c, k) => {
    const id = `C${k + 1}`;
    map[id] = c.id;
    const act = c.action ?? (notifyTier(c) ?? 'REVIEW');
    facts.push({
      id,
      label: `你定的條件 ${id}（${KIND_TEXT[c.kind] ?? c.kind}；${ownerText(c)}${c.premiseId ? `；對應前提 ${c.premiseId}` : ''}）`,
      value: c.text,
      note: `成立時：${ACTION_TEXT[act as CondAction] ?? act}；怎麼確認：${confirmText(c)}；目前：${c.status === 'MET' ? `已成立（${c.metAt?.slice(0, 10)}）` : (STATE_TEXT[c.status] ?? c.status)}${progressText(c) ? `；${progressText(c)}` : ''}`,
    });
  });
  tf.conditions
    .filter((c) => c.status === 'PROPOSED')
    .forEach((c, k) => {
      const id = `W${k + 1}`;
      map[id] = c.id;
      let check = `怎麼確認：${confirmText(c)}`;
      if (c.kind === 'XBRL') {
        const chk = c.check as { type: string; metric: string; level: number; quarters?: number };
        const p = rows?.length ? xbrlProgress(rows, chk, '') : null;
        if (!rows?.length) check = `程式比對：資料還沒更新（${rows ? '沒有季度數字' : 'XBRL 抓不到'}）`;
        else if (!p || p.values.slice(0, p.need).some((v) => v === null) || p.values.length < p.need) check = `程式比對：資料還沒更新（最近 ${p?.need ?? 1} 季的數字不齊）`;
        else {
          const latest = rows[0];
          const fresh = latest.filed > c.createdAt.slice(0, 10) ? '' : '；建議寫下之後還沒有新財報';
          check = `程式比對：${p.streak >= p.need ? '成立' : '不成立'}（最新一季 ${latest.end}（${latest.form} ${latest.filed}）：${p.values
            .slice(0, p.need)
            .map((v) => fmtMetric(chk.metric, v))
            .join('、')}，門檻 ${fmtMetric(chk.metric, p.level)}${p.need > 1 ? `，要連續 ${p.need} 季` : ''}${fresh}）`;
        }
      }
      facts.push({
        id,
        label: `觀察項 ${id}（AI 建議、使用者還沒勾選；${KIND_TEXT[c.kind] ?? c.kind}；${md(c.createdAt)} 的審查寫的${c.premiseId ? `；對應前提 ${c.premiseId}` : ''}）`,
        value: c.text,
        note: `${check}；AI 建議成立時：${ACTION_TEXT[defaultAction(c)]}${c.auto === false ? '；沒有通過格式檢查，勾選後只記錄' : ''}`,
      });
    });
  return { facts, map };
}
