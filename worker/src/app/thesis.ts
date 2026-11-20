// T25：論點檔（own_thesis §1.2、§1.3）。每檔自選一份，不是一張新表，是從五個地方組出來的檢視：
//   帳戶狀態 acct.own[代號]   現行的論點、前提、靜默期（論點與前提跟著帳戶走，復原快照時一起回來）
//   own_conditions           條件（只讀 file_id 等於這檔現在的 fileId 的列）
//   sec_events               事件
//   ai_runs                  歷次 L2 的執行與結論
//   own_thesis_log           開檔、結案（之後的任務加論點的每一版、失效通知、回應、條件的勾選）
// L2 各功能的證據包（F24、F7、F25、自選股的 F19）都從這裡取資料；這裡也放組證據包要的純函式（事件 V、預設前提的 D1～D3、
// 8-K 的挑選順序、論點那一份 note）。讀 D1，所以不在引擎裡。
import type { EvidencePack, Outcome, PackDoc, PackPremise } from '../ai/check';
import { ownCheckResult, type ExitLine } from '../ai/ownCheck';
import { packOrigin } from '../ai/pack';
import { confirmMode, namedWebDomains, webConfirmText, type OwnCondition } from '../ai/ownReview';
import { DEFAULT_CONFIG, clone, type Account, type Attention, type ClosedThesis, type CloseReason, type MarketView, type Notif, type OwnMeta, type Thesis, type Tier } from '../engine';
import { concentrationHits, sizeText } from './concentration';
import type { ThesisLogInput } from './ledgerStore';
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
  /** 細項（own_thesis §2.2；舊列沒有：null）。 */
  detailCode?: string | null;
  status: string;
  /** 處理的原因（HANDLED 的；提前審查開不開的原因見 EARLY_NOTE）。 */
  handledNote?: string | null;
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
  /** 使用者對那則通知的回應（論點檔的 RESPONSE，最後一筆為準）；type：A 甲類、B 乙類。 */
  response: { outcome: string; reason: string | null; type?: string } | null;
  /** 這次每一票對每條前提的判斷（算「最近一次檢查」用）。 */
  premiseVotes: Record<string, string[]>;
  /** 和結論同檔位的第一張合格票的報告第一段（討論包用；沒有是 null）。 */
  summary: string | null;
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
  /** 買進時的一句話（T40，own_thesis §1.8）：只給討論包與持股頁，L2 的證據包不放。舊的呼叫端沒給 = undefined。 */
  buyNote?: { text: string; at: string } | null;
  premises: ThesisPremise[];
  conditions: FileCondition[];
  events: ThesisEvent[];
  reviews: ThesisReview[];
  disputes: NonNullable<OwnMeta['disputes']>;
  flags: string[];
  /**
   * 上一次有結論的定期審查（3 票一致，含一致維持現狀；票數不一致、資料缺漏、逾時的不算）。
   * thesisVersion：那次證據包記下的論點版本（T31a 起；之前的執行沒有）。
   */
  lastReview: { runId: string; asOf: string; createdAt: string; thesisVersion?: number | null } | null;
  /** 沒有上一次審查時，「新的」從這一天起算（決策日往前 120 天）。 */
  newSince: string;
  log: ThesisLogRow[];
  /** 連續票數不一致的審查（flow_state 的 review:splits:<代號>，own_thesis §3.6.4；沒有是 null）。 */
  splits?: ReviewSplits | null;
  /**
   * 最近 30 天出場條件改寫回來、還有沒勾的（T34 走一遍的缺口：沒勾的 30 天後就不在持股頁列出，使用者以為在監測）。
   * pending：那一次改寫還沒勾的條數。沒有是空陣列（舊的呼叫端沒給：undefined）。
   */
  unchecked?: { runId: string; at: string; pending: number }[];
  /**
   * 這份論點檔等你看的 stock bot 草稿（own_drafts 的 READY，T56，web_evidence_design §2.3、§2.5）：「要看的事」的 DRAFT_READY 用。
   * at：回來的時間；until：哪天之後不再列（回來後 30 天就過期）。沒有是 null（舊的呼叫端、示範模式：undefined）。
   */
  draft?: { runId: string; at: string; until: string; trigger: 'AUTO' | 'MANUAL' } | null;
}

/** READY 的草稿幾天沒處理 → EXPIRED（web_evidence_design §2.3；src/app/ownDraft.ts 也用這個數字）。 */
export const DRAFT_EXPIRE_DAYS = 30;

/** 一個時間在台北是哪一天（YYYY-MM-DD；草稿的日期是給人看的，照使用者的日曆）。 */
export const taipeiDay = (at: string): string => new Date(Date.parse(at) + 8 * 3600_000).toISOString().slice(0, 10);
/** 草稿回來的時間 → 哪一天之後不再列（台北的日期加 30 天）。 */
export const draftUntil = (at: string): string => new Date(Date.parse(taipeiDay(at)) + DRAFT_EXPIRE_DAYS * 86400_000).toISOString().slice(0, 10);

/** 這份論點檔最新的 READY 草稿（DRAFT_READY 用）。沒有論點檔編號的舊自選沒有草稿。 */
async function readyDraftOf(db: D1Database, fileId: string | null): Promise<ThesisFile['draft']> {
  if (!fileId) return null;
  const r = await db.prepare("SELECT run_id, trigger, created_at, settled_at FROM own_drafts WHERE file_id = ? AND status = 'READY' ORDER BY created_at DESC, id DESC LIMIT 1").bind(fileId).first<{ run_id: string; trigger: string; created_at: string; settled_at: string | null }>();
  if (!r) return null;
  const at = r.settled_at ?? r.created_at;
  return { runId: r.run_id, at, until: draftUntil(at), trigger: r.trigger === 'AUTO' ? 'AUTO' : 'MANUAL' };
}

/** 持股頁列出多少天內的出場條件改寫結果（own_thesis §1.8 確認的第 4 點）。 */
export const REWRITE_DAYS = 30;

/**
 * 最近一次出場條件有改動的那一版論點（T42，own_thesis §1.8）：THESIS log 帶 exitsChanged 的最後一筆。
 *   version  那一版論點的版本；exits 那一版要的全部出場條件（空的 = 全部拿掉）；at 存檔時間
 *   live     存檔時監測中的條件（確認後撤下的範圍）；sameByText 文字和監測中的一條相同的（U1 → 列編號）
 *   confirmed 這一版已經在持股頁確認過（之後有 EXITS_CONFIRMED 帶同一個版本）
 * 只有這一版的改寫結果與「還沒送去改寫」會列、能勾選或重送；論點只改文字、出場條件沒改的版本不算。沒有是 null（舊資料沒有這個欄位也是 null）。
 */
export interface ExitSet {
  version: number;
  at: string;
  exits: ExitLine[];
  live: number[];
  sameByText: Record<string, number>;
  confirmed: boolean;
}

export function latestExitSet(log: Pick<ThesisLogRow, 'id' | 'kind' | 'at' | 'body'>[]): ExitSet | null {
  const t = [...log].reverse().find((l) => l.kind === 'THESIS' && l.body.exitsChanged === true);
  if (!t) return null;
  const version = Number(t.body.version);
  const lines = Array.isArray(t.body.exitLines) ? (t.body.exitLines as unknown[]).map(String) : [];
  const acts = Array.isArray(t.body.exitActions) ? (t.body.exitActions as unknown[]) : [];
  const live = Array.isArray(t.body.exitsLive) ? (t.body.exitsLive as unknown[]).filter((x): x is number => typeof x === 'number') : [];
  const sbt = t.body.exitSame && typeof t.body.exitSame === 'object' ? (t.body.exitSame as Record<string, unknown>) : {};
  const sameByText = Object.fromEntries(Object.entries(sbt).filter((e): e is [string, number] => typeof e[1] === 'number'));
  const confirmed = log.some((l) => l.kind === 'EXITS_CONFIRMED' && l.id > t.id && Number(l.body.version) === version);
  return {
    version,
    at: t.at,
    exits: lines.map((text, k) => ({ text, action: COND_ACTIONS.includes(acts[k] as CondAction) ? (acts[k] as CondAction) : 'REVIEW' })),
    live,
    sameByText,
    confirmed,
  };
}

/** 這一次改寫屬不屬於這一組出場條件（T42）：證據包記的版本相同、而且是那一版存檔之後送的。 */
export const runOfSet = (set: Pick<ExitSet, 'version' | 'at'>, detail: { exitsVersion?: unknown } | null | undefined, createdAt: string): boolean => Number(detail?.exitsVersion) === set.version && createdAt >= set.at;

/**
 * 連續票數不一致的定期審查（own_thesis §3.6.4）：次數、這一串的第一次（執行編號）、到第 3 次的那一天（還沒到是 null）。
 * fileId：寫入時這檔的論點檔編號（換了檔就不算）。
 */
export interface ReviewSplits {
  count: number;
  fileId: string | null;
  first: string;
  reachedAt: string | null;
}
/** 連續幾次票數不一致列進「要看的事」（NO_CONSENSUS）。 */
export const NO_CONSENSUS_AFTER = 3;
/** flow_state 的鍵（own_thesis §3.6.4）。 */
export const reviewFailsKey = (ticker: string) => `review:fails:${ticker}`;
export const reviewSplitsKey = (ticker: string) => `review:splits:${ticker}`;

/** 讀 review:splits:<代號>；格式壞了、或是別的論點檔寫的 → null。 */
export async function loadSplits(db: D1Database, ticker: string, fileId: string | null): Promise<ReviewSplits | null> {
  const v = (await db.prepare('SELECT value FROM flow_state WHERE key = ?').bind(reviewSplitsKey(ticker)).first<{ value: string }>())?.value;
  const j = parseJson<Partial<ReviewSplits>>(v);
  if (!j || (j.fileId ?? null) !== fileId) return null;
  return { count: Number(j.count) || 0, fileId, first: String(j.first ?? ''), reachedAt: typeof j.reachedAt === 'string' ? j.reachedAt : null };
}

/** 論點檔讀進來的 L2 功能。 */
export const FILE_FNS: Record<string, string> = { OWN_REVIEW: '定期審查', OWN_DROP: '減半檢視', HARD_EVENT: '硬事件', OWN_CONDITION: '條件確認', OWN_EARNINGS: '財報數字擷取' };
/** 「有結論」的定期審查：3 票一致（含一致維持現狀）而且資料齊全。 */
const CONCLUSIVE = new Set(['AGREED', 'INSUFFICIENT']);
/** 沒有上一次審查時，事件與 8-K 往前看幾天（own_thesis §1.6）。 */
export const NO_REVIEW_DAYS = 120;
const minusDays = (d: string, n: number) => new Date(Date.parse(d) - n * 86400_000).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400_000);
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
  const trigger = r.fn === 'OWN_REVIEW' ? String(detail.trigger ?? '') || null : r.fn === 'HARD_EVENT' ? ((detail.codes as string[] | undefined) ?? []).join('、') || null : r.fn === 'OWN_DROP' ? '慢規則減半' : r.fn === 'OWN_CONDITION' ? '新申報' : r.fn === 'OWN_EARNINGS' ? '財報新聞稿' : null;
  const rep = valid.find((s) => s.verdict === o?.verdict) ?? valid[0];
  const summary = rep?.report?.split(/\n\s*\n/)[0]?.trim().slice(0, 400) || null;
  return { runId: r.run_id, date: r.as_of, fn: r.fn, label: FILE_FNS[r.fn] ?? r.fn, trigger, status: r.status === 'PENDING' || !o ? 'PENDING' : o.status, verdict: o?.verdict ?? null, votes: o?.votes ?? {}, brokenPremises, notif: null, response: null, premiseVotes, summary };
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
    // 慢規則通知的回應（type R）帶著那次減半檢視的執行編號：沒有 BREAK_NOTICE（AI 沒有建議出清）時也對得上
    if (l.body.type === 'R' && typeof l.body.notif === 'number') for (const rv of reviews) if (rv.notif === null && ((l.body.runIds as string[] | undefined) ?? []).includes(rv.runId)) rv.notif = l.body.notif;
    for (const rv of reviews) if (rv.notif !== null && rv.notif === l.body.notif) rv.response = { outcome: String(l.body.outcome ?? ''), reason: (l.body.reason as string | null) ?? null, ...(typeof l.body.type === 'string' ? { type: l.body.type } : {}) };
  }
  const lastRun = runs.find((r) => r.fn === 'OWN_REVIEW' && r.status === 'DONE' && r.outcome && CONCLUSIVE.has((JSON.parse(r.outcome) as Outcome).status));
  const lastDetail = lastRun ? parseJson<{ thesisVersion?: unknown }>(lastRun.detail) : null;
  const lastReview = lastRun ? { runId: lastRun.run_id, asOf: lastRun.as_of, createdAt: lastRun.created_at, thesisVersion: typeof lastDetail?.thesisVersion === 'number' ? lastDetail.thesisVersion : null } : null;
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

  // 出場條件改寫回來、還沒確認的（最近 30 天）
  const rewriteRows = (
    await db
      .prepare("SELECT run_id, created_at, outcome, json_extract(pack, '$.rule.detail') AS detail FROM ai_runs WHERE fn = 'OWN_CHECK' AND ticker = ? AND as_of >= ? AND created_at >= ? AND status = 'DONE' ORDER BY created_at DESC LIMIT 10")
      .bind(ticker, openedAt ?? '0000-00-00', minusDays(asOf ?? openedAt ?? '0000-00-00', REWRITE_DAYS))
      .all<{ run_id: string; created_at: string; outcome: string | null; detail: string | null }>()
  ).results;
  // T42：只算最近一次出場條件有改動的那一版、還沒確認的（之前版本的改寫結果不再列）；和現有條件相同的不算
  const set = latestExitSet(log);
  const unchecked = rewriteRows.flatMap((r) => {
    const detail = parseJson<{ mode?: string; exits?: ExitLine[]; exitsVersion?: number; condMap?: Record<string, number>; sameByText?: Record<string, number>; live?: number[] }>(r.detail);
    if (detail?.mode === 'DRAFT' || !set || set.confirmed || !runOfSet(set, detail, r.created_at)) return [];
    const res = ownCheckResult(parseJson<Outcome>(r.outcome), ticker, detail?.exits ?? [], detail?.condMap ?? {}, detail?.sameByText ?? {}, detail?.live ?? null);
    const pending = res.conditions.filter((c) => c.same === null).length;
    return pending ? [{ runId: r.run_id, at: r.created_at, pending }] : [];
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
    buyNote: meta.buyNote ?? null,
    premises,
    conditions,
    events,
    reviews,
    disputes: meta.disputes ?? [],
    flags: meta.flags,
    lastReview,
    newSince,
    log,
    splits: await loadSplits(db, ticker, fileId),
    unchecked,
    draft: await readyDraftOf(db, fileId),
  };
}

/**
 * 只用帳戶狀態組的論點檔（不讀資料庫：沒有條件、事件、審查與 log）。示範模式的討論包用：示範的帳戶不在 D1 的那幾張表裡。
 */
export function metaFile(acct: Pick<Account, 'own'>, ticker: string, asOf: string): ThesisFile | null {
  const meta = acct.own[ticker];
  if (!meta) return null;
  const fileId = meta.fileId ?? null;
  const openedAt = fileDate(fileId, ticker);
  return {
    ticker,
    fileId,
    openedAt,
    origin: meta.origin,
    kind: fileKind(meta),
    status: 'OPEN',
    thesis: meta.thesis ?? null,
    buyNote: meta.buyNote ?? null,
    premises: meta.premises.map((p) => ({ id: p.id, text: p.text, origin: p.origin, addedAt: p.addedAt ?? null, ...(p.breaksIf ? { breaksIf: p.breaksIf } : {}), lastCheck: null, splitAfter: false })),
    conditions: [],
    events: [],
    reviews: [],
    disputes: meta.disputes ?? [],
    flags: meta.flags,
    lastReview: null,
    newSince: minusDays(asOf, NO_REVIEW_DAYS),
    log: [],
  };
}

// ---------------------------------------------------------------- 上一份論點檔（T44，own_thesis §1.2）

/** 上一份論點檔裡的出場條件（你定的）：結案時監測中的（LIVE），或已經成立的（MET）。 */
export interface PrevCondition {
  text: string;
  action: CondAction | null;
  state: 'LIVE' | 'MET';
  /** LIVE：監測中、只在定期審查時檢查、只記錄；MET：成立日。 */
  note: string;
}

/**
 * 這檔賣光（或出清、移出）之後又買回時，上一份論點檔（T44，2026-11-16 使用者同意改）：
 * 持股頁、「還沒有論點的自選」、討論包、編輯論點頁的「帶入上次的論點」用；**L2 的證據包不放**（thesisFile 只組現在這一份）。
 * 舊的條件只顯示、不監測（所有監測讀現在這份的 fileId）。
 */
export interface PrevFile {
  fileId: string;
  /** 開檔的訊號日（從編號來；舊資料沒有是 null）。 */
  openedAt: string | null;
  /** 結案的訊號日。 */
  closedAt: string;
  reason: CloseReason;
  /** 「自己賣光」「AI 建議出清後照做」…。 */
  reasonText: string;
  /** 「賣光」「出清」「移出自選」（「M/D 開檔 → M/D 賣光」用）。 */
  closedVerb: string;
  thesis: ClosedThesis['thesis'];
  premises: ClosedThesis['premises'];
  /** 有論點：論點本文或自己的前提至少一樣。 */
  hasThesis: boolean;
  /** 當時監測中的、已成立的出場條件；null = 沒有讀（示範模式只有帳戶狀態）。 */
  conditions: PrevCondition[] | null;
}

export const CLOSE_TEXT: Record<CloseReason, string> = { SOLD_OUT: '自己賣光', REMOVED: '移出自選', EXIT_AI: 'AI 審查建議出清，你照做', EXIT_CONDITION: '你定的出場條件成立，出清', HARD_EVENT: '硬事件審查建議出清，你照做' };
const CLOSE_VERB: Record<CloseReason, string> = { SOLD_OUT: '賣光', REMOVED: '移出自選', EXIT_AI: '出清', EXIT_CONDITION: '出清', HARD_EVENT: '出清' };
const LIVE_TEXT: Record<string, string> = { ACTIVE: '監測中', REVIEW_ONLY: '只在定期審查時檢查', MANUAL: '只記錄' };

/**
 * 上一份論點檔（純函式）：這檔現在是自選、而且 ownClosed 記著一份編號和現在不同的論點檔。沒有是 null。
 * conds：上一份的條件（loadConditions 讀 file_id = 上一份編號的）；不給 = 沒有讀（conditions 是 null）。
 * T44 之前結案的沒有 last：當成沒有記到論點。
 */
export function prevFileOf(acct: Pick<Account, 'own' | 'ownClosed'>, ticker: string, conds: FileCondition[] | null = null): PrevFile | null {
  const meta = acct.own[ticker];
  const c = acct.ownClosed?.[ticker];
  if (!meta || !c?.fileId || c.fileId === meta.fileId) return null;
  const last = c.last ?? { thesis: null, premises: [] };
  return {
    fileId: c.fileId,
    openedAt: fileDate(c.fileId, ticker),
    closedAt: c.date,
    reason: c.reason,
    reasonText: CLOSE_TEXT[c.reason] ?? '移出自選',
    closedVerb: CLOSE_VERB[c.reason] ?? '移出自選',
    thesis: last.thesis,
    premises: last.premises,
    hasThesis: !!last.thesis?.text || last.premises.length > 0,
    conditions: conds
      ? conds
          .filter((x) => isOwned(x) && (LIVE_CODES.includes(x.status) || x.status === 'MET'))
          .map((x) => ({ text: x.text, action: x.action, state: x.status === 'MET' ? ('MET' as const) : ('LIVE' as const), note: x.status === 'MET' ? `${x.metAt?.slice(0, 10) ?? ''} 成立` : (LIVE_TEXT[x.status] ?? '監測中') }))
      : null,
  };
}

/** 上一份論點檔，連同它的條件（讀資料庫）。 */
export async function loadPrevFile(db: D1Database, acct: Pick<Account, 'own' | 'ownClosed'>, ticker: string): Promise<PrevFile | null> {
  const p = prevFileOf(acct, ticker);
  return p ? prevFileOf(acct, ticker, await loadConditions(db, ticker, p.fileId)) : null;
}

/** 在上一次有結論的審查之後嗎（同一天的看時間：事件的建立時間、申報的接受時間晚於那次審查開始）。沒有審查時看最近 120 天。 */
export function afterLastReview(tf: Pick<ThesisFile, 'lastReview' | 'newSince'>, date: string, at: string | null): boolean {
  const r = tf.lastReview;
  if (!r) return date >= tf.newSince;
  return date > r.asOf || (date === r.asOf && !!at && at > r.createdAt);
}

// ---------------------------------------------------------------- 月底檢查點的「新證據」（T31a，own_thesis §3.7；純函式）

/** 新證據的原因（own_thesis §3.7 的表；PEER、WEB_DUE 是 T54 加的，web_evidence_design §1.7）。 */
export type EvidenceReason = 'NEVER' | 'FILING' | 'EVENT' | 'THESIS' | 'STALE' | 'UNKNOWN' | 'PEER' | 'WEB_DUE';
/** 距上一次有結論的審查滿幾個日曆天就照審（STALE）。 */
export const STALE_DAYS = 100;
/** 有「需要外部資料」的前提或條件時，距上一次有結論的審查滿幾個日曆天就照審（WEB_DUE；web_evidence_design §1.7、第 6 章第 7 項）。 */
export const WEB_DUE_DAYS = 25;

/**
 * 「需要外部資料」的前提與條件（web_evidence_design §1.5 最後那張表；§1.7 的 WEB_DUE、月底審查的題目用）：
 *   你的前提（不含系統預設）最近一次檢查是三票一致的「證據不足」，或還沒被檢查過；
 *   你定的、監測中的條件（ACTIVE、REVIEW_ONLY）指名了網頁來源（confirm_by 有 `web:<網域>`）。
 * 只有系統預設前提的論點檔不用網頁證據（不能取文件）→ 一律是空的。分析師自己不受這張表限制。
 */
export function externalNeeds(file: Pick<ThesisFile, 'kind' | 'premises' | 'conditions'>): { premises: string[]; conds: number[] } {
  if (file.kind !== 'THESIS') return { premises: [], conds: [] };
  return {
    premises: file.premises.filter((p) => p.origin !== 'SYSTEM_DEFAULT' && (!p.lastCheck || p.lastCheck.status === 'INSUFFICIENT')).map((p) => p.id),
    conds: file.conditions.filter((c) => isOwned(c) && OWNED_LIVE.includes(c.status) && namedWebDomains(c.check).length > 0).map((c) => c.id),
  };
}

/** 同業在 EDGAR 的申報（PEER 用；月底檢查點那天由 startOwnRuns 抓）。 */
export type PeerFiling = Pick<Filing, 'form' | 'filingDate' | 'acceptedAt' | 'items'>;
/** 算新證據的申報種類：8-K、10-Q、10-K（含修正）。 */
const EVIDENCE_FORM = /^(8-K|10-Q|10-K)/;
/** 新聞來源的事件（每日掃描從新聞標題標的）：新聞標題不能當引用，不算新證據。 */
const isNewsEvent = (e: Pick<ThesisEvent, 'form' | 'sourceId'>) => e.form === 'NEWS' || accOf(e.sourceId).kind === 'NEWS';

/**
 * 相對於這檔最近一次有結論的審查，有沒有新證據（own_thesis §3.7）。回傳原因的清單；空的 = 沒有新證據，這個月不審。
 *   NEVER    這份論點檔還沒有過有結論的審查（只回這一項）
 *   FILING   有那次審查之後申報的 8-K、10-Q、10-K（同一天的看接受時間是否晚於那次審查開始）
 *   EVENT    sec_events 有建立時間比那次審查晚的列（任何狀態；價格規則 PRICE 與新聞標題來源的不算；
 *            例外：有論點的股票、價格規則的大跌被提前審查標成「留給月審」的算，T54）
 *   THESIS   論點或前提改過（版本和那次證據包記的不同，或那次之後有 THESIS 紀錄），或那次之後有條件的變動（CONDITION）
 *   STALE    距那次審查的決策日滿 100 個日曆天
 *   UNKNOWN  申報清單抓不到（filings = null）：當成有新證據
 *   PEER     同業（論點檔的 webSources.peers）有那次審查之後申報的 8-K Item 2.02（財報新聞稿；T54，web_evidence_design §1.7）。
 *            peers 沒給（undefined）或同業的申報抓不到（null）→ 不算（不是這檔自己的資料，抓不到不當成新證據）
 *   WEB_DUE  有「需要外部資料」的前提或條件（externalNeeds），而且距那次審查的決策日滿 25 個日曆天（T54）。
 *            只有在論點檔帶了 premises 與 conditions 時才判斷（舊的呼叫端只給前幾項 → 不算）
 * 新聞標題、慢規則還沒列進清單的減半或加回都不算。
 */
export function newEvidence(
  file: Pick<ThesisFile, 'lastReview' | 'newSince' | 'events' | 'thesis' | 'log'> & Partial<Pick<ThesisFile, 'kind' | 'premises' | 'conditions'>>,
  filings: Pick<Filing, 'form' | 'filingDate' | 'acceptedAt'>[] | null,
  asOf: string,
  peers?: PeerFiling[] | null,
): EvidenceReason[] {
  const r = file.lastReview;
  if (!r) return ['NEVER'];
  const out: EvidenceReason[] = [];
  if (filings?.some((f) => EVIDENCE_FORM.test(f.form) && f.filingDate <= asOf && afterLastReview(file, f.filingDate, f.acceptedAt || null))) out.push('FILING');
  // 價格規則的事件照舊不算；例外（T54）：有論點的股票大跌、沒有新申報、因為月審在 3 個交易日內而「留給月審」的——
  // 它沒有開提前審查，是等這次月審（web_evidence_design §1.7：有論點的大跌無申報照 §2.4 開審查，留給月審就是月審接手）
  const priceLeft = (e: ThesisEvent) => e.source === 'PRICE' && e.handledNote === EARLY_NOTE.monthly && file.kind === 'THESIS';
  if (file.events.some((e) => (e.source !== 'PRICE' || priceLeft(e)) && !isNewsEvent(e) && e.createdAt > r.createdAt)) out.push('EVENT');
  const changed = typeof r.thesisVersion === 'number' && r.thesisVersion !== (file.thesis?.version ?? 0);
  if (changed || file.log.some((l) => (l.kind === 'THESIS' || l.kind === 'CONDITION') && l.at > r.createdAt)) out.push('THESIS');
  if (daysBetween(r.asOf, asOf) >= STALE_DAYS) out.push('STALE');
  if (filings === null) out.push('UNKNOWN');
  if (peers?.some((f) => f.form.startsWith('8-K') && f.items.includes('2.02') && f.filingDate <= asOf && afterLastReview(file, f.filingDate, f.acceptedAt || null))) out.push('PEER');
  if (file.kind && file.premises && file.conditions && daysBetween(r.asOf, asOf) >= WEB_DUE_DAYS) {
    const need = externalNeeds({ kind: file.kind, premises: file.premises, conditions: file.conditions });
    if (need.premises.length || need.conds.length) out.push('WEB_DUE');
  }
  return out;
}

/**
 * 提前審查（own_thesis §2.4）開不開的原因：事件標 HANDLED，handled_note 寫這幾句（「要看的事」的 PRICE_NO_FILING 認 NO_FILING 這一句）。
 */
export const EARLY_NOTE = {
  inPack: (runId: string) => `已經在 ${runId} 的證據包裡`,
  dropReview: '30 天內已經做過減半檢視',
  noFiling: '沒有新的申報可以檢查',
  monthly: '留給月審',
  recent: '30 天內已經提前審查過，留給下一次審查',
  started: (runId: string) => `提前審查 ${runId}`,
  expired: '過期：事件日超過 10 天沒有處理',
  notOwn: '已經不是自選股，不提前審查',
  notHeld: '這檔自選現在 0 股，不提前審查（持有後恢復）',
  news: '新聞標題標到的，只記進論點檔',
} as const;

/** 證據包與紀錄用的原因說明。 */
export const EVIDENCE_TEXT: Record<EvidenceReason, string> = {
  NEVER: '還沒有過有結論的審查',
  FILING: '有新的申報',
  EVENT: '有新的事件',
  THESIS: '論點、前提或條件改過',
  STALE: '距上次審查滿 100 天',
  UNKNOWN: '申報清單抓不到',
  PEER: '同業有新的財報新聞稿',
  WEB_DUE: `有要上網查的前提或條件，距上次審查滿 ${WEB_DUE_DAYS} 天`,
};

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
    detailCode: e.detail_code ?? null,
    status: e.status,
    handledNote: e.handled_note ?? null,
    displayOnly: e.display_only === 1,
    createdAt: e.created_at,
    isNew: afterLastReview({ lastReview: last, newSince }, e.event_date, e.created_at),
  };
}

/** 證據包的前提（F19 用）：論點檔的現行前提，格式同 ownPremises。 */
export function filePremises(tf: Pick<ThesisFile, 'premises'>): PackPremise[] {
  return tf.premises.map((p) => ({ id: p.id, text: p.text, origin: packOrigin(p.origin), ...(p.breaksIf ? { breaksIf: p.breaksIf } : {}) }));
}

// ---------------------------------------------------------------- 證據包要的部分（純函式）

const SOURCE_TEXT: Record<string, string> = { EDGAR: '申報分類', SCAN: '每日掃描', AI: 'AI 轉交', PRICE: '價格規則' };
const STATUS_TEXT: Record<string, string> = { NEW: '待處理', HANDLED: '已處理', INFO: '只記錄', IN_COURT: '法庭審查中' };
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

/**
 * 論點那一份 note 寫論點是怎麼來的（給 L2 看）。用了 stock bot 草稿的論點本文（DRAFT，T56）不寫來源：
 * 判的人看不到出題的過程（web_evidence_design §2.4 第 4 點）。
 */
const PACK_SOURCE_TEXT: Record<string, string> = { DISCUSSION: '討論後貼回，', TYPED: '在網站手寫，' };
const ORIGIN_TEXT: Record<string, string> = { INITIAL: '上線時就持有', NEW: '新增自選', TRANSFER: '從動能轉入', ADOPT: '認養', MANUAL: '自己買進' };
const PREM_TEXT: Record<string, string> = { HOLDS: '成立', BROKEN: '不成立', INSUFFICIENT: '證據不足' };
const OUTCOME_TEXT: Record<string, string> = { FOLLOW: '照做', REVISE: '修正論點', DISAGREE: '不同意', SKIPPED: '月報裡沒有動它（當成不同意）', NONE: '上次的失效通知沒有回應', RULE: '照規則' };
/** 回應的白話（甲類、慢規則通知的 SKIPPED 是「這次不做」；慢規則通知的 FOLLOW 是「照 AI」）。 */
export const outcomeText = (r: { outcome: string; type?: string }): string =>
  r.outcome === 'SKIPPED' && (r.type === 'A' || r.type === 'R') ? '這次不做' : r.outcome === 'FOLLOW' && r.type === 'R' ? '照 AI' : r.outcome === 'RULE' ? '照規則減半' : (OUTCOME_TEXT[r.outcome] ?? r.outcome);

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
  if (tf.thesis?.text) L.push(`論點（${tf.thesis.setAt} 定，${PACK_SOURCE_TEXT[tf.thesis.source] ?? ''}第 ${tf.thesis.version} 版${tf.thesis.afterBreak ? `，失效後修改 ${tf.thesis.afterBreak} 次` : ''}）：`, tf.thesis.text);
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
      const resp = r.response ? `；你的回應：${outcomeText(r.response)}${r.response.reason ? `（${r.response.reason}）` : ''}` : '';
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
/** 監測中的你定的條件（T40 的對照、T42 整組取代的範圍）：會發通知的兩種，加上只記錄的。 */
export const LIVE_CODES = ['ACTIVE', 'REVIEW_ONLY', 'MANUAL'];

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

/** 財報指標的顯示：比率寫百分比、金額大的寫 M。 */
export const fmtMetric = (metric: string, v: number | null) => {
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

const FILING_CONFIRM_TEXT = '新申報出來時由 AI 確認';

/** 怎麼確認（§1.5 的顯示）；指名了網頁來源的事件條件寫「審查時用 <來源> 的網頁檢查」（T53，web_evidence_design §1.6）。 */
export function confirmText(c: Pick<FileCondition, 'kind' | 'check' | 'auto' | 'status'>): string {
  const s = acceptStatus(c);
  if (s === 'MANUAL') return '只記錄';
  const web = c.kind === 'EVENT' ? webConfirmText(c.check) : null;
  if (s === 'REVIEW_ONLY') return web ?? '只在定期審查時檢查';
  if (c.kind === 'XBRL') return '新財報出來時比對';
  return web ? `${FILING_CONFIRM_TEXT}；${web.replace('審查時用', '審查時也用')}` : FILING_CONFIRM_TEXT;
}

const STATE_TEXT: Record<string, string> = { ACTIVE: '監測中', REVIEW_ONLY: '只在定期審查時檢查', MANUAL: '只記錄', MET: '已成立', PROPOSED: '建議中', RETIRED: '已撤下', EXPIRED: '已過期' };

/**
 * F24、F7 的證據包裡的條件（§1.6）：
 *   C1…  你定的條件（ACTIVE、REVIEW_ONLY，以及上次有結論的審查之後成立的 MET）：誰哪天定的、成立時做什麼、怎麼確認、目前狀態
 *   W1…  觀察項（PROPOSED）：財報類附程式用當時的財報數字比對的結果
 * map：證據包的編號 → own_conditions 的列編號（審查回來時對回條件用，放在 rule.detail.conds）。
 * rows：XBRL 季度表（新的在前）；null = 抓不到。
 */
export function condFacts(tf: Pick<ThesisFile, 'conditions' | 'lastReview' | 'newSince'>, rows: QuarterRow[] | null, opt: { live?: boolean } = {}): { facts: Fact[]; map: Record<string, number>; web: Record<string, string[]> } {
  const facts: Fact[] = [];
  const map: Record<string, number> = {};
  // 指名了網頁來源的你定的條件（T53）：證據包編號 → 網域；審查回來時，那個來源的網頁引用可以確認它成立（rule.detail.condWeb）
  const web: Record<string, string[]> = {};
  // opt.live（T42，出場條件改寫用）：C 是目前監測中的你定的條件（ACTIVE、REVIEW_ONLY、MANUAL），也就是整組取代的範圍；不放已成立的
  const owned = opt.live
    ? tf.conditions.filter((c) => isOwned(c) && LIVE_CODES.includes(c.status))
    : tf.conditions.filter((c) => isOwned(c) && (OWNED_LIVE.includes(c.status) || (c.status === 'MET' && !!c.metAt && afterLastReview(tf, c.metAt.slice(0, 10), c.metAt))));
  owned.forEach((c, k) => {
    const id = `C${k + 1}`;
    map[id] = c.id;
    const named = c.kind === 'EVENT' && acceptStatus(c) !== 'MANUAL' ? namedWebDomains(c.check) : [];
    if (named.length) web[id] = named;
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
  return { facts, map, web };
}

// ---------------------------------------------------------------- 「要看的事」（T37，own_thesis §3.6.6；純函式，本身不讀資料庫）

/**
 * 一件要看的事，加上決定月報多久列一次要用的兩個欄位（存進通知時拿掉，見 toAttention）：
 *   key    記在 OwnMeta.attnShown 的鍵：同一個鍵就是「同一件事」
 *   every  同一個鍵隔幾個月可以再列；null = 列過一次就不再列（要再列就換鍵，例如換季、換一次審查）
 */
export interface AttnHit extends Attention {
  key: string;
  every: number | null;
}

/** 判斷一種「要看的事」需要的東西：這一檔的論點檔與帳戶狀態、帳戶、訊號日。 */
export interface AttnCtx {
  file: ThesisFile;
  meta: OwnMeta;
  /** cfg 只有 SIZE_2X 要用（單檔上限）；沒給用預設值。 */
  acct: Pick<Account, 'own' | 'rule' | 'notifs'> & Partial<Pick<Account, 'cfg'>>;
  view: Pick<MarketView, 'date'>;
}

/** 一種「要看的事」：detect 回傳這一檔現在成立的（可以多件，例如每個條件一件；不成立回傳空陣列）。 */
export interface AttnKind {
  kind: string;
  detect(ctx: AttnCtx): Omit<AttnHit, 'ticker' | 'kind' | 'src'>[];
}

const plusDays = (d: string, n: number) => minusDays(d, -n);
const CN_NUM = ['零', '一', '兩', '三', '四'];
const cnNum = (n: number) => CN_NUM[n] ?? String(n);

/** 你定的、會自己發通知的條件（ACTIVE＋REVIEW_ONLY）。 */
const ownedLive = (f: Pick<ThesisFile, 'conditions'>) => f.conditions.filter((c) => isOwned(c) && OWNED_LIVE.includes(c.status));

/**
 * 自選股的「要看的事」，一種一個物件。加一種 = 在這裡加一個物件（T29a 的 COND_MET_NO_SELL、T29b 的 PRICE_NO_FILING、
 * T29c 的 PRESS_MISMATCH、T31a 的 NO_CONSENSUS 已加；T35 的 SIZE_2X）；判斷需要的資料先放進論點檔或帳戶狀態。
 * 月報的頻率用「月」算（月報一個月一份；設計寫的「90 天」「6 個月」「每年」= 3、6、12 個月）。
 */
export const OWN_ATTN: AttnKind[] = [
  {
    // 有建議中的條件（§1.5 第 6 點）：審查寫入新建議的那個月列一次（鍵帶最新那次審查的執行編號）
    kind: 'PROPOSED_CONDS',
    detect({ file }) {
      const ps = file.conditions.filter((c) => c.status === 'PROPOSED');
      if (!ps.length) return [];
      const last = ps.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
      return [{ key: `PROPOSED_CONDS@${last.runId}`, every: null, since: last.createdAt.slice(0, 10), text: `${file.ticker} 有 ${ps.length} 條 AI 建議的條件等你看` }];
    },
  },
  {
    // 你定的財報條件「要連續 N 季（N ≥ 2）、已經 N−1 季」（§3.6.2）：每個條件每季一次（鍵帶季末日）
    kind: 'COND_NEAR',
    detect({ file }) {
      return ownedLive(file)
        .filter((c) => c.kind === 'XBRL' && c.progress && c.progress.need >= 2 && c.progress.streak === c.progress.need - 1)
        .map((c) => {
          const p = c.progress!;
          const dir = c.check.type === 'xbrl_metric_below' ? '低於' : '高於';
          const act = c.action ?? notifyTier(c) ?? 'REVIEW';
          const had = p.streak === 1 ? `已經有一季${dir}門檻` : `已經連續${cnNum(p.streak)}季${dir}門檻`;
          return {
            key: `COND_NEAR:${c.id}@${p.period}`,
            every: null,
            since: p.at || p.period,
            text: `${file.ticker}：你定的條件「${c.text}」${had}（${fmtMetric(String(c.check.metric), p.values[0] ?? null)}），下一季也${dir}就會成立 → ${ACTION_TEXT[act as CondAction] ?? act}`,
          };
        });
    },
  },
  {
    // 你寫的出場條件改寫回來、還沒勾選（T34 走一遍的缺口）：勾選才會監測，沒勾的 30 天後就不在持股頁列出。
    // 每一次改寫列一次（鍵帶那一次的執行編號）；持股頁列到勾完或滿 30 天為止
    kind: 'EXITS_UNCHECKED',
    detect({ file }) {
      return (file.unchecked ?? []).map((u) => ({ key: `EXITS_UNCHECKED@${u.runId}`, every: null, since: u.at.slice(0, 10), text: `${file.ticker}：你寫的 ${u.pending} 條出場條件 AI 改寫好了，還沒勾選；勾選之後才會開始監測（${plusDays(u.at.slice(0, 10), REWRITE_DAYS)} 之後就不再列在持股頁）` }));
    },
  },
  {
    // stock bot 的論點草稿回來了、等你看（web_evidence_design §2.5，T56）：每一份草稿列一次（鍵帶那一次的執行編號）；
    // 持股頁列到你用了、不用、或 30 天過期為止。使用者按的另外推 LINE 一行；自動開的不推，月報的「要看的事」那一行會算到
    kind: 'DRAFT_READY',
    detect({ file }) {
      const d = file.draft;
      if (!d) return [];
      const md = `${Number(d.until.slice(5, 7))}/${Number(d.until.slice(8, 10))}`;
      return [{ key: `DRAFT_READY@${d.runId}`, every: null, since: taipeiDay(d.at), text: `${file.ticker} 的論點草稿好了，等你看（${md} 之後不再列）` }];
    },
  },
  {
    // 論點檔是「只有預設」：每檔每 6 個月
    kind: 'NO_THESIS',
    detect({ file, view }) {
      if (file.kind !== 'DEFAULT_ONLY') return [];
      return [{ key: 'NO_THESIS', every: 6, since: file.openedAt ?? view.date, text: `${file.ticker} 還沒有你的論點，目前用系統預設前提檢查` }];
    },
  },
  {
    // 論點本文的 setAt（沒有本文時取最新一條使用者前提的 addedAt）距今滿 365 天：每檔每年
    kind: 'THESIS_OLD',
    detect({ file, view }) {
      const userDates = file.premises.filter((p) => p.origin !== 'SYSTEM_DEFAULT' && p.addedAt).map((p) => p.addedAt!);
      const at = file.thesis?.text ? file.thesis.setAt : userDates.sort().at(-1);
      if (!at) return [];
      const days = daysBetween(at, view.date);
      if (days < 365) return [];
      const years = Math.floor(days / 365);
      return [{ key: 'THESIS_OLD', every: 12, since: plusDays(at, 365), text: `${file.ticker} 的論點是 ${at} 寫的，已經${years === 1 ? '一年' : ` ${years} 年`}沒有更新` }];
    },
  },
  {
    // 慢規則減半中，而且沒有任何你定的條件：每檔每 90 天（3 個月）
    kind: 'HALF_NO_EXIT',
    detect({ file, acct, view }) {
      if (acct.rule.own[file.ticker]?.applied !== 'HALF' || ownedLive(file).length) return [];
      // 從哪天起減半：最近一則有這檔減半單的通知；找不到（一開始就是減半）用開檔日
      const n = [...acct.notifs].reverse().find((x) => x.items.some((it) => it.f === 'F7' && it.ticker === file.ticker));
      return [{ key: 'HALF_NO_EXIT', every: 3, since: n?.date ?? file.openedAt ?? view.date, text: `${file.ticker} 減半中：站回 200 日均線之前規則不會再有動作，而你沒有定任何出場條件` }];
    },
  },
  {
    // 定期審查連續 3 次票數不一致（§3.6.4）：發生時列一次（鍵帶這一串的第一次；有一次三票一致歸零之後再發生才再列）
    kind: 'NO_CONSENSUS',
    detect({ file, view }) {
      const s = file.splits;
      if (!s || s.count < NO_CONSENSUS_AFTER) return [];
      return [{ key: `NO_CONSENSUS@${s.first}`, every: null, since: s.reachedAt ?? view.date, text: `${file.ticker} 最近 ${s.count} 次審查都沒有一致結論，論點可能寫得不夠具體，可以拿去討論` }];
    },
  },
  {
    // 你的前提最近一次檢查是 3 票一致的「證據不足」（§3.6.6，T47）：公司的申報與財報、AI 另外取到的網頁裡都沒有依據（T54 改文字）。
    // 同一組前提每 6 個月列一次（鍵帶編號；哪幾條變了就是新的一件）。系統預設前提不列（程式先算好的，資料不足是暫時的）
    kind: 'PREMISE_NO_DATA',
    detect({ file }) {
      const ps = file.premises.filter((p) => p.origin !== 'SYSTEM_DEFAULT' && p.lastCheck?.status === 'INSUFFICIENT');
      if (!ps.length) return [];
      const short = (s: string) => (s.length > 30 ? `${s.slice(0, 30)}…` : s);
      const since = ps.map((p) => p.lastCheck!.date).sort().at(-1)!;
      const which = ps.length === 1 ? '這一條' : `這 ${ps.length} 條`;
      return [
        {
          key: `PREMISE_NO_DATA:${ps.map((p) => p.id).join(',')}`,
          every: 6,
          since,
          // T54：審查的 AI 現在可以另外取同業申報與清單內的網頁，月底也會因為這幾條再審（WEB_DUE），所以不再寫「監測不了」
          text: `${file.ticker} 的前提 ${ps.map((p) => `${p.id}「${short(p.text)}」`).join('、')}最近一次審查 3 票都是證據不足：公司的申報、財報與 AI 另外取到的網頁裡都沒有找到依據。距上次審查滿 ${WEB_DUE_DAYS} 天，月底會為${which}再審一次、讓 AI 再去找；也可以改寫成查得到的事，或複製討論包到 claude.ai 討論`,
        },
      ];
    },
  },
  {
    // 你定的條件成立、但換算出來不用賣（§1.10 甲類）：沒有發通知（log 沒有這條的 BREAK_NOTICE）、也不是等著進月報的。
    // 成立後的第一份月報列一次；持股頁列到那份月報產生為止（之後有成立日之後的月報就不再算）
    kind: 'COND_MET_NO_SELL',
    detect({ file, meta, acct }) {
      const told = new Set(file.log.filter((l) => l.kind === 'BREAK_NOTICE' && l.body.type === 'A').map((l) => Number(l.body.conditionId)));
      const queued = new Set((meta.condMonthly ?? []).map((q) => q.id));
      const half = acct.rule.own[file.ticker]?.applied === 'HALF';
      return file.conditions
        .filter((c) => {
          if (c.status !== 'MET' || !c.metAt || !isOwned(c) || told.has(c.id) || queued.has(c.id)) return false;
          const tier = notifyTier(c);
          if (tier !== 'EXIT' && tier !== 'HALF') return false;
          const day = c.metAt.slice(0, 10);
          return !acct.notifs.some((n) => (n.kind === 'MONTHLY' || n.kind === 'MONTHLY_EMPTY') && n.date > day);
        })
        .map((c) => ({ key: `COND_MET_NO_SELL:${c.id}`, every: null, since: c.metAt!.slice(0, 10), text: `${file.ticker}：你定的條件「${c.text}」成立；${half ? '目前已經是減半，不用再賣' : '目前沒有要賣的股數'}` }));
    },
  },
  {
    // 個股自身大跌、但上次有結論的審查之後沒有新的申報或事件，沒有開提前審查（§3.6.1、§2.4）：請使用者拿去 claude.ai 討論。
    // 發生後的第一份月報列一次；持股頁列到那份月報產生為止
    kind: 'PRICE_NO_FILING',
    detect({ file, acct }) {
      return file.events
        .filter((e) => e.code === 'PRICE_DROP' && e.status === 'HANDLED' && e.handledNote === EARLY_NOTE.noFiling)
        .filter((e) => !acct.notifs.some((n) => (n.kind === 'MONTHLY' || n.kind === 'MONTHLY_EMPTY') && n.date > e.date))
        .map((e) => {
          // 說明是 idioDropText 寫的：`最近 21 個交易日：個股 -18.2%，產業（SOXX）-5.1%，個股自身 -13.1%`
          const idio = /個股自身 (-?\d+(?:\.\d+)?)%/.exec(e.detail ?? '')?.[1];
          const ref = (e.detail ?? '').includes('大盤（') ? '大盤' : '產業';
          const how = idio ? `比${ref}多跌 ${idio.replace('-', '')}%` : '個股自身大跌';
          return { key: `PRICE_NO_FILING:${e.id}`, every: null, since: e.date, text: `${file.ticker} 最近 21 個交易日${how}，沒有新的申報可以檢查。可以複製討論包到 claude.ai 討論` };
        });
    },
  },
  {
    // 部位大小（§3.6.3）：往上越過標準比重 2 倍時一次（鍵帶越過的那一天；跌回 1.5 倍以下之後再越過才是新的一次）。
    // 到了單檔上限的不列（F10 會處理）。旗與最新的占比由每日流程更新（concentration.ts 的 updateSizeFlags）
    kind: 'SIZE_2X',
    detect({ file, meta, acct }) {
      const s = meta.sizeInfo;
      const cfg = acct.cfg ?? DEFAULT_CONFIG;
      if (!meta.sizeFlag || !s || s.weight >= cfg.ownCapHi) return [];
      return [{ key: `SIZE_2X@${s.at}`, every: null, since: s.at, text: sizeText(file.ticker, s.weight, s.ratio, cfg) }];
    },
  },
  {
    // 財報新聞稿成立的條件，10-Q／10-K 核對不一致（§1.11）：論點檔的 PRESS_CHECK（ok = false）。
    // 核對後的第一份月報列一次；持股頁列到那份月報產生為止
    kind: 'PRESS_MISMATCH',
    detect({ file, acct }) {
      return file.log
        .filter((l) => l.kind === 'PRESS_CHECK' && l.body.ok === false)
        .filter((l) => !acct.notifs.some((n) => (n.kind === 'MONTHLY' || n.kind === 'MONTHLY_EMPTY') && n.date > l.session))
        .flatMap((l) => {
          const c = file.conditions.find((x) => x.id === Number(l.body.id));
          if (!c) return [];
          const metric = String(l.body.metric ?? c.check.metric);
          const first = (v: unknown) => (Array.isArray(v) && typeof v[0] === 'number' ? v[0] : null);
          return [{ key: `PRESS_MISMATCH:${c.id}`, every: null, since: l.session, text: `${file.ticker}：條件「${c.text}」依財報新聞稿成立（${fmtMetric(metric, first(l.body.press))}），${String(l.body.form ?? '10-Q')} 算出來是 ${fmtMetric(metric, first(l.body.xbrl))}，沒有過門檻` }];
        });
    },
  },
];

/**
 * 一直沒回的乙類通知（own_thesis §1.10）：提醒過（發出 2 個交易日）、還在等你決定、論點檔還沒有那則通知的回應 → RESPONSE 的 NONE。
 * 下一次審查開始時寫，那次的證據包寫「上次的失效通知沒有回應」。之後才回覆的，回覆那一筆排在後面、以它為準。
 */
export function noneResponses(acct: Pick<Account, 'notifs'>, file: Pick<ThesisFile, 'ticker' | 'fileId' | 'log'>, session: string): ThesisLogInput[] {
  if (!file.fileId) return [];
  const answered = new Set(file.log.filter((l) => l.kind === 'RESPONSE').map((l) => Number(l.body.notif)));
  const out: ThesisLogInput[] = [];
  for (const l of file.log) {
    // 附在慢規則通知上的「AI 建議出清」不算（那則通知的底線是規則，回應寫 type R）
    if (l.kind !== 'BREAK_NOTICE' || l.body.type !== 'B' || l.body.withRule) continue;
    const id = Number(l.body.notif);
    const n = acct.notifs.find((x) => x.id === id);
    if (answered.has(id) || !n || n.status !== 'PENDING' || !n.reminded) continue;
    const it = n.items.find((i) => i.ticker === file.ticker && !i.cancelled && i.brk?.type === 'B' && !i.brk.withRule);
    if (!it || it.brk?.type !== 'B') continue;
    answered.add(id);
    out.push({ ticker: file.ticker, fileId: file.fileId, session, kind: 'RESPONSE', ref: String(id), body: { notif: id, type: 'B', outcome: 'NONE', reason: null, premiseId: it.brk.premiseId } });
  }
  return out;
}

/**
 * 新的通知裡的失效通知項目（Item.brk）→ own_thesis_log 的 BREAK_NOTICE（own_thesis §1.10）。沒有論點檔編號的舊自選不寫。
 * sameDay：當天通知（月報裡的是 false）。每日流程的套用段（當天通知）與月報產生時各寫一次。
 * 慢規則減半項目帶「AI 建議出清」那一行的（own_thesis §3.4）：type 一樣是 B，多 withRule: true，tier 是 EXIT。
 * only：只寫這幾個項目（`<通知編號>:<項目的 key>`）；不給就是 notifs 裡全部。
 */
export function breakLogs(acct: Pick<Account, 'own'>, notifs: Notif[], only?: Set<string>): ThesisLogInput[] {
  const out: ThesisLogInput[] = [];
  for (const n of notifs) {
    for (const it of n.items) {
      if (!it.brk || !it.ticker || it.cancelled || (only && !only.has(`${n.id}:${it.key}`))) continue;
      const fileId = acct.own[it.ticker]?.fileId;
      if (!fileId) continue;
      const withRule = it.brk.type === 'B' && !!it.brk.withRule;
      out.push({
        ticker: it.ticker,
        fileId,
        session: n.date,
        kind: 'BREAK_NOTICE',
        ref: String(n.id),
        body: {
          type: it.brk.type,
          notif: n.id,
          runIds: it.runIds ?? [],
          conditionId: it.brk.type === 'A' ? it.brk.conditionId : null,
          premiseId: it.brk.premiseId,
          tier: withRule ? 'EXIT' : (it.choices.find((c) => c.id !== 'SKIP')?.tier ?? null),
          sameDay: n.kind === 'URGENT',
          ...(withRule ? { withRule: true } : {}),
        },
      });
    }
  }
  return out;
}

/** 帶「AI 建議出清」那一行的慢規則減半項目：`<通知編號>:<項目的 key>` → 哪一條前提。 */
export const withRuleKeys = (acct: Pick<Account, 'notifs'>): Map<string, string> =>
  new Map(acct.notifs.flatMap((n) => n.items.filter((it) => !it.cancelled && it.brk?.type === 'B' && it.brk.withRule).map((it) => [`${n.id}:${it.key}`, it.brk!.premiseId ?? ''] as [string, string])));

/**
 * 既有的慢規則通知更新成「AI 建議出清」的那一刻（減半檢視或之後的審查回來，own_thesis §3.4）→ BREAK_NOTICE（withRule）。
 * had：套用結論之前就帶著那一行的項目（withRuleKeys）；oldIds：套用之前就有的通知（新通知由 breakLogs 寫）；after：套用之後的帳戶。
 * 只寫這次才帶上那一行的項目（或換了一條前提的），已經寫過的不重寫。
 */
export function ruleBreakLogs(had: Map<string, string>, oldIds: Set<number>, after: Pick<Account, 'own' | 'notifs'>): ThesisLogInput[] {
  const fresh = new Set([...withRuleKeys(after)].filter(([k, pid]) => had.get(k) !== pid).map(([k]) => k));
  return fresh.size ? breakLogs(after, after.notifs.filter((n) => oldIds.has(n.id)), fresh) : [];
}

/**
 * 慢規則減半項目的回應 → own_thesis_log 的 RESPONSE（type R，own_thesis §3.4）：照規則 RULE／照 AI FOLLOW／這次不做 SKIPPED，
 * 加上理由與當時 AI 給的選項（aiOffered：HOLD、EXIT 或空的）。n：回覆之後的那則通知；acct：回覆之前的帳戶（照 AI 出清時這檔已經不在回覆後的帳戶裡）。
 */
export function ruleResponseLogs(acct: Pick<Account, 'own'>, n: Notif, session: string): ThesisLogInput[] {
  const out: ThesisLogInput[] = [];
  for (const it of n.items) {
    if (it.f !== 'F7' || it.kind !== 'OWN_RULE' || it.cancelled || !it.ticker) continue;
    const fileId = acct.own[it.ticker]?.fileId;
    if (!fileId) continue;
    const ai = it.choices.find((c) => c.id === 'AI');
    out.push({
      ticker: it.ticker,
      fileId,
      session,
      kind: 'RESPONSE',
      ref: String(n.id),
      body: {
        notif: n.id,
        type: 'R',
        outcome: it.choice === 'AI' ? 'FOLLOW' : it.choice === 'SKIP' ? 'SKIPPED' : 'RULE',
        reason: it.choice === 'SKIP' ? (it.reason ?? null) : null,
        aiOffered: ai?.tier === 'EXIT' ? 'EXIT' : ai?.tier === 'HOLD' ? 'HOLD' : null,
        premiseId: it.brk?.type === 'B' ? it.brk.premiseId : null,
        runIds: it.runIds ?? [],
      },
    });
  }
  return out;
}

/**
 * 自選股的「要看的事」（own_thesis §3.6.6）：每份論點檔逐種判斷，回傳現在成立的全部（不看頻率；持股頁就是這一份）。
 * files：各檔的論點檔（thesisFile 組好的）；本身不讀資料庫。
 */
export function ownAttention(files: ThesisFile[], acct: AttnCtx['acct'], view: AttnCtx['view'], kinds: AttnKind[] = OWN_ATTN): AttnHit[] {
  const out: AttnHit[] = [];
  for (const file of files) {
    const meta = acct.own[file.ticker];
    if (!meta) continue;
    for (const k of kinds) for (const x of k.detect({ file, meta, acct, view })) out.push({ ticker: file.ticker, kind: k.kind, src: 'own', ...x });
  }
  return out;
}

/** 兩個訊號日差幾個月（只看年月）。 */
const monthsBetween = (a: string, b: string) => (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + Number(b.slice(5, 7)) - Number(a.slice(5, 7));

/**
 * 月報該列哪些（own_thesis §3.6.6 的頻率）：沒列過的列；every 是 null 的列過就不再列；其他隔 every 個月才再列。
 * shown：各檔的 attnShown。回傳該列的，與列完之後各檔的 attnShown（只有變了的檔）。
 */
export function dueAttention(hits: AttnHit[], shown: Record<string, Record<string, string> | undefined>, date: string): { due: AttnHit[]; shown: Record<string, Record<string, string>> } {
  const due: AttnHit[] = [];
  const next: Record<string, Record<string, string>> = {};
  for (const x of hits) {
    const last = (next[x.ticker] ?? shown[x.ticker])?.[x.key];
    if (last && (x.every === null || monthsBetween(last, date) < x.every)) continue;
    due.push(x);
    next[x.ticker] = { ...(next[x.ticker] ?? shown[x.ticker] ?? {}), [x.key]: date };
  }
  return { due, shown: next };
}

/** 存進月報、給畫面的形狀（拿掉頻率用的欄位）。 */
export const toAttention = (x: AttnHit): Attention => ({ ticker: x.ticker, kind: x.kind, text: x.text, since: x.since, src: x.src ?? 'own', ...(x.link ? { link: x.link } : {}) });

/**
 * 每日流程在產生月報前（own_thesis §3.6.6）：組每檔自選的論點檔、算這個月該列的，並更新 attnShown。
 * 回傳新的帳戶（acct 不改）與該列的清單。讀資料庫（論點檔），所以不在引擎裡。
 */
export async function monthOwnAttention(db: D1Database, acct: Account, view: MarketView): Promise<{ acct: Account; items: Attention[] }> {
  const files = (await Promise.all(Object.keys(acct.own).map((t) => thesisFile(db, acct, t, view.date)))).filter((f): f is ThesisFile => !!f);
  // 集中度（T35）：每個月算一次，是一件事不屬於哪一份論點檔，所以不在 OWN_ATTN 裡；算不出來（價格不齊）這個月不列
  const conc = (() => {
    try {
      return concentrationHits(acct, view);
    } catch (e) {
      console.error('集中度算不出來', e);
      return [];
    }
  })();
  const { due, shown } = dueAttention(
    [...ownAttention(files, acct, view), ...conc],
    Object.fromEntries(Object.entries(acct.own).map(([t, m]) => [t, m.attnShown])),
    view.date,
  );
  if (!due.length) return { acct, items: [] };
  const next = clone(acct);
  for (const [t, s] of Object.entries(shown)) if (next.own[t]) next.own[t].attnShown = s;
  return { acct: next, items: due.map(toAttention) };
}

/** 持股頁：這一檔現在成立的全部（不看頻率；集中度那一件組內每一檔自選都顯示）。不是自選回傳空的。 */
export async function holdingAttention(db: D1Database, acct: Account, view: MarketView, ticker: string): Promise<Attention[]> {
  const file = await thesisFile(db, acct, ticker, view.date);
  if (!file) return [];
  const conc = (() => {
    try {
      return concentrationHits(acct, view).filter((x) => x.members.includes(ticker));
    } catch {
      return [];
    }
  })();
  return [...ownAttention([file], acct, view), ...conc].map(toAttention);
}
