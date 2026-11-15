// T16：運作統計（GET /admin/ops-report；格式與用法見 docs/analysis/records_guide.md）。
//   指定期間（?from=YYYY-MM-DD&to=YYYY-MM-DD，含頭尾；預設從上線日算起、到今天）內：
//   通知次數、資料與排程失敗、告警、推播失敗、AI 執行與通過檢查的比例、照做／沒照做的次數。
// 報表分段：每一段是一個函式（Period → { id, title, rows }），登記在 OPS_SECTIONS。之後的任務要加一段，就寫一個函式並放進這個陣列。
// 只讀 D1，不改任何東西。數字都用 SQL 算（json_extract／json_each 讀 JSON 欄位），不把整張表載進記憶體（影子紀錄例外，見 shadowSection）。
// 比例是 0～1 的小數（四捨五入到小數三位）；分母是 0 時是 null。
import { liveShadow, type ShadowRecord } from '../engine';
import { launchDate } from './export';

export type Cell = string | number | null;
export type Row = Record<string, Cell>;

export interface Period {
  /** 起日（含，YYYY-MM-DD）；null = 從頭。 */
  from: string | null;
  /** 迄日（含）。 */
  to: string;
  /** 起日哪來的：參數、上線日（flow_state）、都沒有（從頭算）。 */
  fromSource: 'param' | 'launch_date' | 'none';
}

export interface Section {
  id: string;
  title: string;
  rows: Row[];
  /** 這一段算失敗時的原因（其他段照常）。 */
  error?: string;
}

export type SectionFn = (db: D1Database, p: Period) => Promise<Section>;

// ---------------------------------------------------------------- 期間

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function validDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function nextDay(s: string): string {
  return new Date(Date.parse(`${s}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10);
}

/** 解析期間。參數錯誤時回 { error }。 */
export async function resolvePeriod(db: D1Database, fromParam: string | null, toParam: string | null, now: Date): Promise<Period | { error: string }> {
  const to = toParam ?? now.toISOString().slice(0, 10);
  if (!validDate(to)) return { error: `to 不是日期（YYYY-MM-DD）：${toParam}` };
  let from: string | null;
  let fromSource: Period['fromSource'];
  if (fromParam !== null) {
    if (!validDate(fromParam)) return { error: `from 不是日期（YYYY-MM-DD）：${fromParam}` };
    from = fromParam;
    fromSource = 'param';
  } else {
    from = await launchDate(db);
    fromSource = from ? 'launch_date' : 'none';
  }
  if (from !== null && from > to) return { error: `from（${from}）比 to（${to}）晚` };
  return { from, to, fromSource };
}

/** 時間戳欄位（UTC ISO）落在期間內：從起日 00:00Z 到迄日的隔天 00:00Z（不含）。 */
function atCond(p: Period, col: string): { sql: string; args: string[] } {
  const lo = p.from ? [`${col} >= ?`] : [];
  return { sql: [...lo, `${col} < ?`].join(' AND '), args: [...(p.from ? [`${p.from}T00:00:00.000Z`] : []), `${nextDay(p.to)}T00:00:00.000Z`] };
}

/** 日期欄位（YYYY-MM-DD；訊號日、決策日）落在期間內（含頭尾）。 */
function dateCond(p: Period, col: string): { sql: string; args: string[] } {
  const lo = p.from ? [`${col} >= ?`] : [];
  return { sql: [...lo, `${col} <= ?`].join(' AND '), args: [...(p.from ? [p.from] : []), p.to] };
}

// ---------------------------------------------------------------- 小工具

const ratio = (num: number, den: number): number | null => (den > 0 ? Math.round((num / den) * 1000) / 1000 : null);

async function query(db: D1Database, sql: string, args: unknown[]): Promise<Row[]> {
  return (await db.prepare(sql).bind(...args).all<Row>()).results;
}

/** 加一列合計：sumKeys 逐欄相加，其他欄位由 finish 補（例如比例要用合計的分子分母重算）。 */
function withTotal(rows: Row[], label: Row, sumKeys: string[], finish?: (t: Row) => void): Row[] {
  if (!rows.length) return rows;
  const t: Row = { ...label };
  for (const k of sumKeys) t[k] = rows.reduce((s, r) => s + (Number(r[k]) || 0), 0);
  finish?.(t);
  return [...rows, t];
}

const n = (v: Cell): number => Number(v) || 0;

// ---------------------------------------------------------------- 各段

/** 通知：依種類的次數與處理狀態（訊號日在期間內）。 */
export const notificationsSection: SectionFn = async (db, p) => {
  const c = dateCond(p, 'date');
  const rows = await query(
    db,
    `SELECT kind, COUNT(*) AS total,
       COALESCE(SUM(status = 'PENDING'), 0) AS pending,
       COALESCE(SUM(status IN ('RESPONDED', 'DONE')), 0) AS responded,
       COALESCE(SUM(status = 'SKIPPED'), 0) AS skipped,
       COALESCE(SUM(status = 'READ'), 0) AS read,
       COALESCE(SUM(status = 'SUPERSEDED'), 0) AS superseded,
       COALESCE(SUM(status = 'CANCELLED'), 0) AS cancelled
     FROM notifications WHERE ${c.sql} GROUP BY kind ORDER BY kind`,
    c.args,
  );
  return { id: 'notifications', title: '通知次數（依種類；訊號日在期間內）', rows: withTotal(rows, { kind: '合計' }, ['total', 'pending', 'responded', 'skipped', 'read', 'superseded', 'cancelled']) };
};

/** 資料抓取：每次抓取的結果（OK／DEGRADED／FAILED）、不能出訊號、不能換股的次數。 */
export const dataRunsSection: SectionFn = async (db, p) => {
  const c = atCond(p, 'at');
  const rows = await query(
    db,
    `SELECT status, COUNT(*) AS runs,
       COALESCE(SUM(signals_ok = 0), 0) AS no_signal,
       COALESCE(SUM(rebalance_ok = 0), 0) AS no_rebalance,
       ROUND(AVG(ms)) AS avg_ms
     FROM data_runs WHERE ${c.sql} GROUP BY status ORDER BY status`,
    c.args,
  );
  return { id: 'data_runs', title: '資料抓取（依結果）', rows: withTotal(rows, { status: '合計', avg_ms: null }, ['runs', 'no_signal', 'no_rebalance']) };
};

/** 每日流程：依 FIRST／FINAL／APPLY／MANUAL 與結果的次數。 */
export const flowRunsSection: SectionFn = async (db, p) => {
  const c = atCond(p, 'at');
  const rows = await query(db, `SELECT attempt, status, COUNT(*) AS runs FROM flow_runs WHERE ${c.sql} GROUP BY attempt, status ORDER BY attempt, status`, c.args);
  return { id: 'flow_runs', title: '每日流程（依排程與結果）', rows: withTotal(rows, { attempt: '合計', status: null }, ['runs']) };
};

/** 告警：依種類的次數，以及推出去、已解除、太舊略過、還沒推的數目。 */
export const alertsSection: SectionFn = async (db, p) => {
  const c = atCond(p, 'at');
  const rows = await query(
    db,
    `SELECT kind, COUNT(*) AS total,
       COALESCE(SUM(sent_at IS NOT NULL AND sent_at NOT IN ('RESOLVED', 'SKIPPED_OLD')), 0) AS pushed,
       COALESCE(SUM(sent_at = 'RESOLVED'), 0) AS resolved,
       COALESCE(SUM(sent_at = 'SKIPPED_OLD'), 0) AS skipped_old,
       COALESCE(SUM(sent_at IS NULL), 0) AS unsent
     FROM alerts WHERE ${c.sql} GROUP BY kind ORDER BY kind`,
    c.args,
  );
  return { id: 'alerts', title: '告警（依種類）', rows: withTotal(rows, { kind: '合計' }, ['total', 'pushed', 'resolved', 'skipped_old', 'unsent']) };
};

/**
 * LINE 推播：依種類（NOTIF 通知、ALERT 告警、TEST 測試、REPLY 關鍵字回覆）的次數與失敗。
 * failed = 失敗的那幾次；never_delivered = 有編號（通知）而且之後一直沒推成功的那幾則（失敗的下一次流程會重試，所以 failed 大於它是正常的）。
 */
export const pushesSection: SectionFn = async (db, p) => {
  const c = atCond(p, 'p.at');
  const rows = await query(
    db,
    `SELECT p.kind AS kind, COUNT(*) AS total,
       COALESCE(SUM(p.ok = 1), 0) AS ok,
       COALESCE(SUM(p.ok = 0), 0) AS failed,
       COUNT(DISTINCT CASE WHEN p.ok = 0 AND p.ref IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pushes q WHERE q.kind = p.kind AND q.ref = p.ref AND q.ok = 1) THEN p.ref END) AS never_delivered
     FROM pushes p WHERE ${c.sql} GROUP BY p.kind ORDER BY p.kind`,
    c.args,
  );
  return { id: 'pushes', title: 'LINE 推播（依種類）', rows: withTotal(rows, { kind: '合計' }, ['total', 'ok', 'failed', 'never_delivered']) };
};

/** 通過檢查、能拿來用的結論（沒有一票合格、逾時、結果被退回的不算）。 */
const USABLE = ['AGREED', 'SPLIT', 'INSUFFICIENT', 'DATA_MISSING'];

/**
 * AI 執行（依功能）：結論的狀態分布。
 * usable_ratio = 有結論的執行裡，結論是 AGREED／SPLIT／INSUFFICIENT／DATA_MISSING（送回的輸出通過檢查）的比例；
 * INVALID（沒有一票合格）、TIMEOUT、NO_RESULT（觸發失敗或結果被退回）算沒通過。
 */
export const aiRunsSection: SectionFn = async (db, p) => {
  const c = atCond(p, 'created_at');
  const st = (s: string) => `COALESCE(SUM(json_extract(outcome, '$.status') = '${s}'), 0) AS ${s.toLowerCase()}`;
  const rows = await query(
    db,
    `SELECT fn, COUNT(*) AS runs,
       COALESCE(SUM(status = 'PENDING'), 0) AS pending,
       COALESCE(SUM(status = 'DONE'), 0) AS done,
       ${['AGREED', 'SPLIT', 'INSUFFICIENT', 'DATA_MISSING', 'INVALID', 'TIMEOUT', 'NO_RESULT'].map(st).join(',\n       ')},
       COALESCE(SUM(json_extract(outcome, '$.actionable') = 1), 0) AS actionable
     FROM ai_runs WHERE ${c.sql} GROUP BY fn ORDER BY fn`,
    c.args,
  );
  const withRatio = (r: Row): Row => {
    const usable = USABLE.reduce((s, k) => s + n(r[k.toLowerCase()]), 0);
    return { ...r, usable, usable_ratio: ratio(usable, n(r.done)) };
  };
  const keys = ['runs', 'pending', 'done', ...['AGREED', 'SPLIT', 'INSUFFICIENT', 'DATA_MISSING', 'INVALID', 'TIMEOUT', 'NO_RESULT'].map((s) => s.toLowerCase()), 'actionable'];
  const out = withTotal(rows.map(withRatio), { fn: '合計' }, keys, (t) => {
    const usable = USABLE.reduce((s, k) => s + n(t[k.toLowerCase()]), 0);
    t.usable = usable;
    t.usable_ratio = ratio(usable, n(t.done));
  });
  return { id: 'ai_runs', title: 'AI 執行（依功能）：結論的狀態與通過檢查的比例', rows: out };
};

/** AI 的每一票（依功能）：格式合格的票佔多少（outcome.samples[].valid）。 */
export const aiVotesSection: SectionFn = async (db, p) => {
  const c = atCond(p, 'r.created_at');
  const rows = await query(
    db,
    `SELECT r.fn AS fn, COUNT(*) AS votes, COALESCE(SUM(json_extract(s.value, '$.valid') = 1), 0) AS valid
     FROM ai_runs r, json_each(r.outcome, '$.samples') s WHERE ${c.sql} GROUP BY r.fn ORDER BY r.fn`,
    c.args,
  );
  const fin = (r: Row): Row => ({ ...r, valid_ratio: ratio(n(r.valid), n(r.votes)) });
  return { id: 'ai_votes', title: 'AI 的每一票：格式合格的比例', rows: withTotal(rows.map(fin), { fn: '合計' }, ['votes', 'valid'], (t) => (t.valid_ratio = ratio(n(t.valid), n(t.votes)))) };
};

/**
 * 雲端任務（依種類）：結局的次數。
 * pass_ratio = 送回來的結果裡，通過外層檢查的比例 = done ÷（done ＋ rejected ＋ late）；late = 逾時之後才送到（ai_rejections 的 LATE）。
 * timeout_not_fetched = 逾時而且從來沒有來取證據包；timeout_after_fetch = 取了證據包但沒送回。
 * avg_minutes = 完成（DONE）的任務從建立到送回平均幾分鐘。
 */
export const aiTasksSection: SectionFn = async (db, p) => {
  const c = atCond(p, 't.created_at');
  const rows = await query(
    db,
    `SELECT t.kind AS kind, COUNT(*) AS tasks,
       COALESCE(SUM(t.status IN ('PENDING', 'FETCHED')), 0) AS open,
       COALESCE(SUM(t.status = 'DONE'), 0) AS done,
       COALESCE(SUM(t.status = 'REJECTED'), 0) AS rejected,
       COALESCE(SUM(t.status = 'TIMEOUT'), 0) AS timeout,
       COALESCE(SUM(t.status = 'TIMEOUT' AND t.fetched_at IS NULL), 0) AS timeout_not_fetched,
       COALESCE(SUM(t.status = 'TIMEOUT' AND t.fetched_at IS NOT NULL), 0) AS timeout_after_fetch,
       COALESCE(SUM(t.status = 'FIRE_FAILED'), 0) AS fire_failed,
       COALESCE(SUM(EXISTS (SELECT 1 FROM ai_rejections r WHERE r.task_id = t.id AND r.status = 'LATE')), 0) AS late,
       ROUND(AVG(CASE WHEN t.status = 'DONE' AND t.completed_at IS NOT NULL THEN (julianday(t.completed_at) - julianday(t.created_at)) * 1440 END), 1) AS avg_minutes
     FROM ai_tasks t WHERE ${c.sql} GROUP BY t.kind ORDER BY t.kind`,
    c.args,
  );
  const fin = (r: Row): Row => ({ ...r, pass_ratio: ratio(n(r.done), n(r.done) + n(r.rejected) + n(r.late)) });
  const keys = ['tasks', 'open', 'done', 'rejected', 'timeout', 'timeout_not_fetched', 'timeout_after_fetch', 'fire_failed', 'late'];
  return { id: 'ai_tasks', title: '雲端任務（依種類）：結局與通過外層檢查的比例', rows: withTotal(rows.map(fin), { kind: '合計', avg_minutes: null }, keys, (t) => (t.pass_ratio = ratio(n(t.done), n(t.done) + n(t.rejected) + n(t.late)))) };
};

/** 被退回或逾時才送到的 AI 輸出（依種類與狀態）。 */
export const aiRejectionsSection: SectionFn = async (db, p) => {
  const c = atCond(p, 'at');
  const rows = await query(
    db,
    `SELECT kind, status, COUNT(*) AS n, COALESCE(SUM(truncated = 1), 0) AS truncated, ROUND(AVG(raw_bytes)) AS avg_raw_bytes
     FROM ai_rejections WHERE ${c.sql} GROUP BY kind, status ORDER BY kind, status`,
    c.args,
  );
  return { id: 'ai_rejections', title: '被退回（REJECTED）或逾時才送到（LATE）的 AI 輸出', rows: withTotal(rows, { kind: '合計', status: null, avg_raw_bytes: null }, ['n', 'truncated']) };
};

/**
 * 照做／沒照做（通知上的選擇）：已回覆的通知（RESPONDED、DONE）裡，每一項（沒被取消的）選的選項和規則的選項比（依觸發功能）。
 * same_as_rule = 選的就是規則的選項；took_ai = 選了 AI 的檔位（規則的選項不是 AI）；skipped = 選了不做（規則的選項不是不做）；
 * other = 其他和規則不同的選擇（例如自己做）。pending_items = 還沒回覆的通知裡的項目。
 */
export const choicesSection: SectionFn = async (db, p) => {
  const c = dateCond(p, 'n.date');
  const choice = "json_extract(i.value, '$.choice')";
  const rule = "COALESCE(json_extract(i.value, '$.ruleChoice'), '')";
  const live = "COALESCE(json_extract(i.value, '$.cancelled'), 0) = 0";
  const decided = "n.status IN ('RESPONDED', 'DONE')";
  const rows = await query(
    db,
    `SELECT json_extract(i.value, '$.f') AS f,
       COALESCE(SUM(${decided} AND ${live}), 0) AS items,
       COALESCE(SUM(${decided} AND ${live} AND ${choice} = ${rule}), 0) AS same_as_rule,
       COALESCE(SUM(${decided} AND ${live} AND ${choice} = 'AI' AND ${rule} != 'AI'), 0) AS took_ai,
       COALESCE(SUM(${decided} AND ${live} AND ${choice} = 'SKIP' AND ${rule} != 'SKIP'), 0) AS skipped,
       COALESCE(SUM(${decided} AND ${live} AND ${choice} != ${rule} AND ${choice} NOT IN ('AI', 'SKIP')), 0) AS other,
       COALESCE(SUM(n.status = 'PENDING' AND ${live}), 0) AS pending_items
     FROM notifications n, json_each(n.body, '$.items') i WHERE ${c.sql} GROUP BY f ORDER BY f`,
    c.args,
  );
  const fin = (r: Row): Row => ({ ...r, same_ratio: ratio(n(r.same_as_rule), n(r.items)) });
  const keys = ['items', 'same_as_rule', 'took_ai', 'skipped', 'other', 'pending_items'];
  return { id: 'choices', title: '照做／沒照做（通知上選的選項 vs 規則的選項，依觸發功能）', rows: withTotal(rows.map(fin), { f: '合計' }, keys, (t) => (t.same_ratio = ratio(n(t.same_as_rule), n(t.items)))) };
};

/**
 * 沒照做的紀錄（shadow_records，依觸發功能）：只有「實際和規則不同、或有 AI 建議」的項目才會留紀錄，
 * 所以 followed_rule 只是這些紀錄裡剛好照規則的，全部項目的照做比例看 choices 那一段。
 * 被「改決定」作廢的紀錄用 liveShadow 濾掉；manual = 清單外的手動交易（F17）、as_is = 做錯之後選「就這樣」。
 * 這一段把整張表讀進記憶體再濾（作廢要看順序），單人使用的量沒有問題。
 */
export const shadowSection: SectionFn = async (db, p) => {
  const all = (await db.prepare('SELECT body FROM shadow_records ORDER BY id').all<{ body: string }>()).results.map((r) => JSON.parse(r.body) as ShadowRecord);
  const live = liveShadow(all).filter((s) => (p.from === null || s.date >= p.from) && s.date <= p.to);
  const by = new Map<string, Row>();
  for (const s of live) {
    const r = by.get(s.f) ?? { f: s.f, records: 0, manual: 0, as_is: 0, with_ai: 0, followed_rule: 0, not_followed_rule: 0, followed_ai: 0 };
    r.records = n(r.records) + 1;
    if (s.choice === 'MANUAL') r.manual = n(r.manual) + 1;
    else if (s.choice === 'AS_IS') r.as_is = n(r.as_is) + 1;
    else {
      if (s.actual === s.rule) r.followed_rule = n(r.followed_rule) + 1;
      else r.not_followed_rule = n(r.not_followed_rule) + 1;
    }
    if (s.ai !== null && s.ai !== undefined) {
      r.with_ai = n(r.with_ai) + 1;
      if (s.actual === s.ai) r.followed_ai = n(r.followed_ai) + 1;
    }
    by.set(s.f, r);
  }
  const rows = [...by.values()].sort((a, b) => String(a.f).localeCompare(String(b.f)));
  return { id: 'shadow', title: '沒照做的紀錄（依觸發功能）', rows: withTotal(rows, { f: '合計' }, ['records', 'manual', 'as_is', 'with_ai', 'followed_rule', 'not_followed_rule', 'followed_ai']) };
};

/** 月底檢查點的新證據原因（own_thesis §3.7；和 app/thesis.ts 的 EvidenceReason 相同）。 */
const REASONS = ['NEVER', 'FILING', 'EVENT', 'THESIS', 'STALE', 'UNKNOWN'];
const CHECKPOINT_KEY_LEN = 'review:checkpoint:'.length;

/**
 * 月底檢查點（T31a，own_thesis §3.7；flow_state 的 review:checkpoint:<年月>，檢查點那天在期間內）：每個月審了幾檔、跳過幾檔。
 * reviewed = 有新證據、開了審查；skipped = 沒有新證據、這個月不審；not_started = 有新證據但沒開成；skip_ratio = skipped ÷（reviewed ＋ skipped ＋ not_started）。
 * 原因欄（never、filing…）= 開了審查的那幾檔各有幾檔帶這個原因（一檔可以有好幾個）。當天已經因為財報開審查的不算在裡面。
 */
export const checkpointSection: SectionFn = async (db, p) => {
  const c = dateCond(p, "json_extract(f.value, '$.session')");
  const reason = (r: string) => `(SELECT COUNT(*) FROM json_each(f.value, '$.reviewed') x WHERE EXISTS (SELECT 1 FROM json_each(json_extract(x.value, '$.reasons')) y WHERE y.value = '${r}')) AS ${r.toLowerCase()}`;
  const rows = await query(
    db,
    `SELECT substr(f.key, ${CHECKPOINT_KEY_LEN + 1}) AS month, json_extract(f.value, '$.session') AS session,
       json_array_length(f.value, '$.reviewed') AS reviewed,
       json_array_length(f.value, '$.skipped') AS skipped,
       COALESCE(json_array_length(f.value, '$.notStarted'), 0) AS not_started,
       ${REASONS.map(reason).join(', ')}
     FROM flow_state f WHERE f.key LIKE 'review:checkpoint:%' AND ${c.sql} ORDER BY month`,
    c.args,
  );
  const fin = (r: Row): Row => ({ ...r, skip_ratio: ratio(n(r.skipped), n(r.reviewed) + n(r.skipped) + n(r.not_started)) });
  const keys = ['reviewed', 'skipped', 'not_started', ...REASONS.map((r) => r.toLowerCase())];
  return { id: 'checkpoints', title: '月底檢查點（自選定期審查）：審了幾檔、跳過幾檔', rows: withTotal(rows.map(fin), { month: '合計', session: null }, keys, (t) => (t.skip_ratio = ratio(n(t.skipped), n(t.reviewed) + n(t.skipped) + n(t.not_started)))) };
};

/**
 * 崩盤規則的切換與檢視（T33b，core_ai §3.4）：期間內（月報訊號日）每一次切換一列——月份、方向、通知、
 * 檢視的狀態（月報那一項現在的 crashReview.state；舊通知沒有是 null）、預估或補開（kind）、這個月份＋方向開了幾次、沒有結論幾次、補推幾次（pushes 的 FOLLOWUP）。
 * 重列的那一項（上次這次不做）不是切換，不列。合計列的 switches 是切換次數。
 */
export const crashSection: SectionFn = async (db, p) => {
  const c = dateCond(p, 'n.date');
  const items = await query(
    db,
    `SELECT n.id AS notif, n.date AS date, json_extract(n.body, '$.monthly.input.month') AS month,
       json_extract(i.value, '$.f') AS f, json_extract(i.value, '$.crashReview.state') AS state, json_extract(i.value, '$.crashReview.kind') AS kind
     FROM notifications n, json_each(n.body, '$.items') i
     WHERE n.kind = 'MONTHLY' AND json_extract(i.value, '$.f') IN ('F5', 'F6')
       AND COALESCE(json_extract(i.value, '$.relist'), 0) = 0 AND COALESCE(json_extract(i.value, '$.cancelled'), 0) = 0 AND ${c.sql}
     ORDER BY n.date, n.id`,
    c.args,
  );
  const fin = ['AGREED', 'SPLIT', 'INSUFFICIENT', 'DATA_MISSING'].map((x) => `'${x}'`).join(', ');
  const rows: Row[] = [];
  for (const it of items) {
    const direction = it.f === 'F5' ? 'ON' : 'OFF';
    const [runs] = await query(
      db,
      `SELECT COUNT(*) AS runs,
         COALESCE(SUM(status = 'DONE' AND COALESCE(json_extract(outcome, '$.status'), '') NOT IN (${fin})), 0) AS no_conclusion
       FROM ai_runs WHERE fn = 'CRASH_REVIEW' AND json_extract(pack, '$.rule.detail.month') = ? AND json_extract(pack, '$.rule.detail.direction') = ?`,
      [it.month, direction],
    );
    const [fu] = await query(db, `SELECT COUNT(*) AS followups FROM pushes WHERE kind = 'FOLLOWUP' AND ok = 1 AND ref = ? AND text LIKE '%崩盤規則的 AI 檢視回來了%'`, [it.notif]);
    rows.push({ month: it.month, direction, notif: it.notif, date: it.date, state: it.state ?? null, kind: it.kind ?? null, runs: n(runs?.runs), no_conclusion: n(runs?.no_conclusion), followups: n(fu?.followups) });
  }
  const total = withTotal(rows, { month: '合計', direction: null, notif: null, date: null, state: null, kind: null }, ['runs', 'no_conclusion', 'followups'], (t) => (t.switches = rows.length));
  return { id: 'crash_reviews', title: '崩盤規則的切換與 AI 檢視（每次切換一列；state：OPINION 有意見、NO_OPINION 沒有意見、PENDING、FAILED、NO_DATA、OFF）', rows: total };
};

/** 累積幾次否決提示一次「看一次否決的紀錄」（momentum_ai §3.7：滿 5 次，之後每滿 5 次）。 */
export const VETO_HINT_EVERY = 5;
/** 新的 AI 否決（不是沿用的）：法庭三票否決、或月報之後才回來的否決。 */
const NEW_VETO = "source = 'AI' AND carried_from IS NULL AND (decision = 'VETO' OR late_verdict = 'VETO')";

/**
 * 動能新股進場審查（F1）的法庭（T32d，momentum_ai §3.7）。每一列 { item, code, n, note }：
 *   courts          期間內開了幾次法庭（ai_runs 的 MOM_ENTRY，建立時間在期間內）
 *   courts_by_code  依規則偵測命中的代碼分（一次法庭有兩個代碼就各算一次；新聞標題來的命中不算）
 *   vetoes          新的 AI 否決（法庭三票否決，不含沿用；mom_reviews 建立時間在期間內）
 *   carried         沿用上一次法庭的結論（不開法庭）；code = 沿用的結論
 *   no_conclusion   法庭跑完了但沒有結論（逾時、沒觸發成功、被退回、格式都不合格、資料缺漏；票數不一致算有跑完）
 *   late            月報之後才回來的否決
 *   veto_total      到期間結束為止累積的否決次數（連續沿用算同一次）；跨過 5 的倍數時 note 提示看一次否決的紀錄
 * 期間內沒有法庭、沒有否決與沿用、累積也是 0 時是空的。
 */
export const momEntrySection: SectionFn = async (db, p) => {
  const runAt = atCond(p, 'created_at');
  const runs = await query(db, `SELECT json_extract(pack, '$.rule.detail.hits') AS hits, status, json_extract(outcome, '$.status') AS st FROM ai_runs WHERE fn = 'MOM_ENTRY' AND ${runAt.sql}`, runAt.args);
  const byCode = new Map<string, number>();
  let noConclusion = 0;
  for (const r of runs) {
    const hits = (r.hits ? JSON.parse(String(r.hits)) : []) as { code: string; byRule?: boolean; displayOnly?: boolean; basis?: string }[];
    for (const c of new Set(hits.filter((h) => !h.byRule && !h.displayOnly && h.basis !== 'NEWS').map((h) => h.code))) byCode.set(c, (byCode.get(c) ?? 0) + 1);
    if (r.status === 'DONE' && !['AGREED', 'INSUFFICIENT', 'SPLIT'].includes(String(r.st ?? ''))) noConclusion++;
  }
  const revAt = atCond(p, 'created_at');
  const [cnt] = await query(
    db,
    `SELECT COALESCE(SUM(source = 'AI' AND carried_from IS NULL AND decision = 'VETO'), 0) AS vetoes,
       COALESCE(SUM(carried_from IS NOT NULL), 0) AS carried,
       COALESCE(SUM(late_verdict = 'VETO'), 0) AS late
     FROM mom_reviews WHERE ${revAt.sql}`,
    revAt.args,
  );
  const carried = await query(db, `SELECT decision AS code, COUNT(*) AS n FROM mom_reviews WHERE carried_from IS NOT NULL AND ${revAt.sql} GROUP BY decision ORDER BY decision`, revAt.args);
  const upTo = `${nextDay(p.to)}T00:00:00.000Z`;
  const [tot] = await query(db, `SELECT COUNT(*) AS n FROM mom_reviews WHERE ${NEW_VETO} AND created_at < ?`, [upTo]);
  const [before] = p.from ? await query(db, `SELECT COUNT(*) AS n FROM mom_reviews WHERE ${NEW_VETO} AND created_at < ?`, [`${p.from}T00:00:00.000Z`]) : [{ n: 0 }];
  const total = n(tot?.n);
  // 還沒有任何進場審查（法庭、否決都沒有）：空的
  if (!runs.length && !n(cnt?.vetoes) && !n(cnt?.carried) && !n(cnt?.late) && !total) return { id: 'mom_entry', title: MOM_ENTRY_TITLE, rows: [] };
  const crossed = Math.floor(total / VETO_HINT_EVERY) > Math.floor(n(before?.n) / VETO_HINT_EVERY);
  const rows: Row[] = [
    { item: 'courts', code: null, n: runs.length, note: null },
    ...[...byCode.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([code, k]) => ({ item: 'courts_by_code', code, n: k, note: null })),
    { item: 'vetoes', code: null, n: n(cnt?.vetoes), note: null },
    { item: 'carried', code: null, n: n(cnt?.carried), note: null },
    ...carried.map((r) => ({ item: 'carried', code: r.code, n: n(r.n), note: null })),
    { item: 'no_conclusion', code: null, n: noConclusion, note: null },
    { item: 'late', code: null, n: n(cnt?.late), note: null },
    { item: 'veto_total', code: null, n: total, note: crossed ? `累積 ${total} 次否決：看一次否決的紀錄（網站「AI 紀錄」上方的「AI 否決的紀錄」），決定要不要留著 AI 的否決權` : null },
  ];
  return { id: 'mom_entry', title: MOM_ENTRY_TITLE, rows };
};
const MOM_ENTRY_TITLE = '動能新股進場審查（F1 法庭）：開了幾次、依代碼、否決、沿用、沒有結論、晚到；累積否決';

/** 報表的各段，照這個順序輸出。要加段就在這裡加一個函式（T31a 加了月底檢查點、T33b 加了崩盤規則、T32d 加了動能進場審查）。 */
export const OPS_SECTIONS: SectionFn[] = [notificationsSection, choicesSection, shadowSection, dataRunsSection, flowRunsSection, alertsSection, pushesSection, aiRunsSection, aiVotesSection, aiTasksSection, aiRejectionsSection, checkpointSection, crashSection, momEntrySection];

export interface OpsReport {
  generated_at: string;
  /** 期間（含頭尾）；from = null 表示從頭算（還沒有上線日、也沒有指定）。 */
  period: { from: string | null; to: string; from_source: Period['fromSource'] };
  launch_date: string | null;
  sections: Section[];
}

export async function buildOpsReport(db: D1Database, p: Period, now: Date, sections: SectionFn[] = OPS_SECTIONS): Promise<OpsReport> {
  const out: Section[] = [];
  for (const fn of sections) {
    try {
      out.push(await fn(db, p));
    } catch (e) {
      // 一段算不出來不影響其他段；id／title 取函式名（沒有別的資訊）
      out.push({ id: fn.name || 'unknown', title: fn.name || 'unknown', rows: [], error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { generated_at: now.toISOString(), period: { from: p.from, to: p.to, from_source: p.fromSource }, launch_date: await launchDate(db), sections: out };
}

/** /admin/ops-report 的處理（驗證在呼叫的地方：ADMIN_TOKEN 的 Bearer）。 */
export async function handleOpsReport(db: D1Database, url: URL, now: Date): Promise<Response> {
  const p = await resolvePeriod(db, url.searchParams.get('from'), url.searchParams.get('to'), now);
  if ('error' in p) return Response.json({ error: 'bad_period', message: p.error }, { status: 400 });
  return Response.json(await buildOpsReport(db, p, now));
}
