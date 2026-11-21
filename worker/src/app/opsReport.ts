// T16：運作統計（GET /admin/ops-report；格式與用法見 docs/analysis/records_guide.md）。
//   指定期間（?from=YYYY-MM-DD&to=YYYY-MM-DD，含頭尾；預設從上線日算起、到今天）內：
//   通知次數、資料與排程失敗、告警、推播失敗、AI 執行與通過檢查的比例、照做／沒照做的次數。
// 報表分段：每一段是一個函式（Period → { id, title, rows }），登記在 OPS_SECTIONS。之後的任務要加一段，就寫一個函式並放進這個陣列。
// 只讀 D1，不改任何東西。數字都用 SQL 算（json_extract／json_each 讀 JSON 欄位），不把整張表載進記憶體（影子紀錄例外，見 shadowSection）。
// 比例是 0～1 的小數（四捨五入到小數三位）；分母是 0 時是 null。
// T57（web_evidence_design §2.4 第 7 點、§1.3、第 3 章）加了七段：前提的審查結果（依前提的來源）、每次執行取了多少網頁、被拒絕的原因、被略過與抓不到的網域、草稿的成功率與失敗原因。
// T61（composite_layer_design §2.1）：前提的審查結果多一欄 stale（逾期）；加一段「前提的判定，依功能與 prompt 版本」（HOLDS 收緊前後對照）。
import { liveShadow, type ShadowRecord } from '../engine';
import { DOC_FNS } from '../ai/added';
import { WEB_DOC_PER_SITE } from '../data/webDoc';
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
const REASONS = ['NEVER', 'FILING', 'EVENT', 'THESIS', 'STALE', 'UNKNOWN', 'PEER', 'WEB_DUE'];
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

// ---------------------------------------------------------------- T57：網頁證據與草稿

/** 草稿的前提判成立的比例這麼高（而且至少這麼多次檢查）、你寫的前提卻低於它，note 才提示「出題可能偏鬆」。門檻是主持者照建議定的（設計只寫「幾乎都判成立」）。 */
export const LOOSE_HOLDS_RATIO = 0.9;
export const LOOSE_MIN_CHECKS = 5;
/** 被略過、抓不到的網域看最近幾天（到期間的迄日為止；設計 §1.3 寫 90 天，不跟著 from 走）。 */
export const WEB_DOMAIN_DAYS = 90;
/** 網域表最多列幾個（合計列算全部）。 */
export const WEB_DOMAIN_ROWS = 20;

const dayShift = (s: string, days: number): string => new Date(Date.parse(`${s}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10);
const hostOf = (url: string | null | undefined): string => {
  try {
    return url ? new URL(url).hostname.toLowerCase().replace(/^www\./, '') : '';
  } catch {
    return '';
  }
};
const FN_LIST = DOC_FNS.map((f) => `'${f}'`).join(', ');
const SEP = '\u0000';

/**
 * 審查當時帳戶裡這檔的前提（含 origin）：account_history 裡訊號時間之前最新的一版；那一版沒有這檔就看現在的 account_state。
 * L2 的證據包把 AI_DRAFT_ACCEPTED 遮成 USER（§2.4 第 4 點），所以來源要讀帳戶狀態，不能讀 ai_runs.pack。
 */
async function accountPremises(db: D1Database, ticker: string, at: string): Promise<{ id: string; text: string; origin: string }[]> {
  if (!/^[A-Za-z0-9.^=_-]+$/.test(ticker)) return [];
  const path = `$.own."${ticker}".premises`;
  const parse = (raw: string | null | undefined) => {
    try {
      const v = raw ? (JSON.parse(raw) as unknown) : null;
      return Array.isArray(v) ? (v as { id: string; text: string; origin: string }[]) : null;
    } catch {
      return null;
    }
  };
  const h = await db.prepare('SELECT json_extract(state, ?) AS prem FROM account_history WHERE at <= ? ORDER BY rev DESC LIMIT 1').bind(path, at).first<{ prem: string | null }>();
  const hist = parse(h?.prem);
  if (hist) return hist;
  const cur = await db.prepare('SELECT json_extract(state, ?) AS prem FROM account_state WHERE id = 1').bind(path).first<{ prem: string | null }>();
  return parse(cur?.prem) ?? [];
}

const PREMISE_ORIGINS = ['USER', 'AI_DRAFT_ACCEPTED', 'SYSTEM_DEFAULT'];
const PREMISE_ORIGIN_TITLE = '定期審查的前提結果，依前提的來源（USER 你寫的、AI_DRAFT_ACCEPTED 原樣勾選的草稿、SYSTEM_DEFAULT 系統預設）：成立、不成立、證據不足、票數不一致的次數';

/**
 * 自選定期審查的前提結果，依前提的來源分開（web_evidence_design §2.4 第 7 點）。
 * 範圍：期間內（建立時間）已經有結論的定期審查（OWN_REVIEW；AGREED／SPLIT／INSUFFICIENT／DATA_MISSING）；減半檢視不算。
 * 一次審查裡的一條前提算一次檢查（同一條前提每個月都會再被檢查，所以次數不是「幾條前提」）。
 * 一條前提在這次審查的結果：格式合格的票至少 3 張而且判斷都一樣 → 那個判斷（holds 成立／broken 不成立／insufficient 證據不足；
 * 判成立或不成立但引用沒通過檢查的票，check.ts 已經改成證據不足）；票數不到 3 張或判斷不一樣 → split。沒有任何一票提到的前提不算檢查。
 * 來源（origin）：USER 你寫的（含勾了草稿又改字的）、AI_DRAFT_ACCEPTED 原樣勾選的草稿、SYSTEM_DEFAULT 系統預設；
 * UNKNOWN = 證據包寫 USER、但找不到當時帳戶裡「編號與字都相同」的前提（例如帳戶紀錄被清過）。
 * 草稿的前提判成立的比例 ≥ LOOSE_HOLDS_RATIO（至少 LOOSE_MIN_CHECKS 次）、而你寫的比它低 → AI_DRAFT_ACCEPTED 那一列的 note 提示出題可能偏鬆。
 * 合計列的 reviews 是不重複的審查次數（一次審查可以同時有好幾種來源的前提，各列的 reviews 加起來會比較大）。
 * stale（T61，composite_layer_design §2.1）：這幾次檢查裡，至少有一票「判成立但正面的引用比驗證頻率還舊」被程式改成證據不足的次數
 * （那一票已經算在 insufficient 或 split 裡；T61 之前的審查沒有這個核對，一律是 0）。信念不進審查，不在這張表裡（T60）。
 */
export const premiseOriginSection: SectionFn = async (db, p) => {
  const c = atCond(p, 'r.created_at');
  const usable = USABLE.map((x) => `'${x}'`).join(', ');
  const base = `r.fn = 'OWN_REVIEW' AND r.status = 'DONE' AND json_extract(r.outcome, '$.status') IN (${usable}) AND ${c.sql}`;
  const packRows = await query(
    db,
    `SELECT r.run_id AS run_id, r.ticker AS ticker, r.created_at AS created_at, json_extract(x.value, '$.id') AS id, json_extract(x.value, '$.text') AS text, json_extract(x.value, '$.origin') AS origin
     FROM ai_runs r, json_each(r.pack, '$.premises') x WHERE ${base} ORDER BY r.created_at, r.run_id`,
    c.args,
  );
  const voteRows = await query(
    db,
    `SELECT r.run_id AS run_id, json_extract(v.value, '$.premise_id') AS id, json_extract(v.value, '$.status') AS status, json_extract(v.value, '$.holdsIssue.why') AS issue
     FROM ai_runs r, json_each(r.outcome, '$.samples') s, json_each(s.value, '$.premises') v
     WHERE ${base} AND json_extract(s.value, '$.valid') = 1`,
    c.args,
  );
  const votes = new Map<string, string[]>();
  const staleKeys = new Set<string>();
  for (const v of voteRows) {
    votes.set(`${v.run_id}${SEP}${v.id}`, [...(votes.get(`${v.run_id}${SEP}${v.id}`) ?? []), String(v.status)]);
    if (v.issue === 'STALE') staleKeys.add(`${v.run_id}${SEP}${v.id}`);
  }

  type Acc = { reviews: Set<string>; checks: number; holds: number; broken: number; insufficient: number; split: number; stale: number };
  const by = new Map<string, Acc>();
  const allRuns = new Set<string>();
  const stateCache = new Map<string, Awaited<ReturnType<typeof accountPremises>>>();
  for (const r of packRows) {
    const v = votes.get(`${r.run_id}${SEP}${r.id}`);
    if (!v?.length) continue;
    let origin = String(r.origin ?? '');
    if (origin !== 'SYSTEM_DEFAULT') {
      const key = `${r.ticker}${SEP}${r.created_at}`;
      if (!stateCache.has(key)) stateCache.set(key, await accountPremises(db, String(r.ticker ?? ''), String(r.created_at)));
      const hit = stateCache.get(key)!.find((x) => x.id === r.id && x.text === r.text);
      origin = hit?.origin === 'AI_DRAFT_ACCEPTED' || hit?.origin === 'USER' ? hit.origin : 'UNKNOWN';
    }
    const a = by.get(origin) ?? { reviews: new Set<string>(), checks: 0, holds: 0, broken: 0, insufficient: 0, split: 0, stale: 0 };
    a.reviews.add(String(r.run_id));
    allRuns.add(String(r.run_id));
    a.checks++;
    if (staleKeys.has(`${r.run_id}${SEP}${r.id}`)) a.stale++;
    if (!(v.length >= 3 && v.every((x) => x === v[0]))) a.split++;
    else if (v[0] === 'HOLDS') a.holds++;
    else if (v[0] === 'BROKEN') a.broken++;
    else a.insufficient++;
    by.set(origin, a);
  }
  if (!by.size) return { id: 'premise_origin', title: PREMISE_ORIGIN_TITLE, rows: [] };
  const toRow = (origin: string, a: Acc | undefined): Row => ({
    origin,
    reviews: a?.reviews.size ?? 0,
    premise_checks: a?.checks ?? 0,
    holds: a?.holds ?? 0,
    broken: a?.broken ?? 0,
    insufficient: a?.insufficient ?? 0,
    split: a?.split ?? 0,
    stale: a?.stale ?? 0,
    holds_ratio: ratio(a?.holds ?? 0, a?.checks ?? 0),
    broken_ratio: ratio(a?.broken ?? 0, a?.checks ?? 0),
    insufficient_ratio: ratio(a?.insufficient ?? 0, a?.checks ?? 0),
    note: null,
  });
  const rows = [...PREMISE_ORIGINS, ...(by.has('UNKNOWN') ? ['UNKNOWN'] : [])].map((o) => toRow(o, by.get(o)));
  const user = rows.find((r) => r.origin === 'USER')!;
  const draft = rows.find((r) => r.origin === 'AI_DRAFT_ACCEPTED')!;
  if (n(draft.premise_checks) >= LOOSE_MIN_CHECKS && n(draft.holds_ratio) >= LOOSE_HOLDS_RATIO && (user.holds_ratio === null || n(user.holds_ratio) < LOOSE_HOLDS_RATIO)) {
    draft.note = `草稿的前提 ${Math.round(n(draft.holds_ratio) * 100)}% 判成立、你寫的${user.holds_ratio === null ? '還沒有檢查' : `只有 ${Math.round(n(user.holds_ratio) * 100)}%`}：草稿出題可能偏鬆，看一次草稿的前提`;
  }
  const keys = ['premise_checks', 'holds', 'broken', 'insufficient', 'split', 'stale'];
  const out = withTotal(rows, { origin: '合計', note: null }, keys, (t) => {
    t.reviews = allRuns.size;
    t.holds_ratio = ratio(n(t.holds), n(t.premise_checks));
    t.broken_ratio = ratio(n(t.broken), n(t.premise_checks));
    t.insufficient_ratio = ratio(n(t.insufficient), n(t.premise_checks));
  });
  return { id: 'premise_origin', title: PREMISE_ORIGIN_TITLE, rows: out };
};

const PREMISE_PROMPT_TITLE = '前提的判定，依功能與 prompt 版本（判「成立」收緊前後對照；OWN_REVIEW 定期審查、OWN_DROP 減半檢視）：成立、不成立、證據不足、票數不一致；逾期、沒指出正面引用的次數';

/**
 * 前提的判定，依功能與 prompt 版本分開（T61，composite_layer_design §2.1：判「成立」要有正面的引用，v4 起）。
 * 用來看收緊之後成立的比例掉了多少、證據不足多了多少，以及程式的日期核對擋了幾次（門檻是建議值，上線後看這張表再調）。
 * 範圍：期間內（建立時間）已經有結論的定期審查與減半檢視（AGREED／SPLIT／INSUFFICIENT／DATA_MISSING）。
 * 一次執行裡的一條前提算一次檢查；結果的算法同 premise_origin（格式合格的票至少 3 張而且判斷都一樣 → holds／broken／insufficient，否則 split）。
 * stale：至少一票「判成立但正面的引用比驗證頻率還舊（逾期）」被程式改成證據不足的檢查次數；
 * no_confirm：至少一票「判成立但沒有指出通過檢查的正面引用」被改成證據不足的檢查次數（這個數字高表示 AI 沒照新格式寫，要看 prompt）。
 * 兩個都只有 v4 起的執行才會有（之前沒有這個核對）。
 */
export const premisePromptSection: SectionFn = async (db, p) => {
  const c = atCond(p, 'r.created_at');
  const usable = USABLE.map((x) => `'${x}'`).join(', ');
  const rows = await query(
    db,
    `SELECT r.run_id AS run_id, r.fn AS fn, r.prompt_version AS prompt_version, json_extract(v.value, '$.premise_id') AS id, json_extract(v.value, '$.status') AS status, json_extract(v.value, '$.holdsIssue.why') AS issue
     FROM ai_runs r, json_each(r.outcome, '$.samples') s, json_each(s.value, '$.premises') v
     WHERE r.fn IN ('OWN_REVIEW', 'OWN_DROP') AND r.status = 'DONE' AND json_extract(r.outcome, '$.status') IN (${usable}) AND ${c.sql} AND json_extract(s.value, '$.valid') = 1
     ORDER BY r.fn, r.prompt_version, r.run_id`,
    c.args,
  );
  type Check = { group: string; votes: string[]; stale: boolean; noConfirm: boolean };
  const checks = new Map<string, Check>();
  const runsOf = new Map<string, Set<string>>();
  for (const r of rows) {
    const group = `${r.fn}${SEP}${r.prompt_version}`;
    const key = `${r.run_id}${SEP}${r.id}`;
    const x = checks.get(key) ?? { group, votes: [], stale: false, noConfirm: false };
    x.votes.push(String(r.status));
    if (r.issue === 'STALE') x.stale = true;
    if (r.issue === 'NO_CONFIRM') x.noConfirm = true;
    checks.set(key, x);
    runsOf.set(group, (runsOf.get(group) ?? new Set<string>()).add(String(r.run_id)));
  }
  const by = new Map<string, Row>();
  for (const x of checks.values()) {
    const [fn, prompt_version] = x.group.split(SEP);
    const a = by.get(x.group) ?? { fn, prompt_version, runs: runsOf.get(x.group)!.size, premise_checks: 0, holds: 0, broken: 0, insufficient: 0, split: 0, stale: 0, no_confirm: 0 };
    a.premise_checks = n(a.premise_checks) + 1;
    const same = x.votes.length >= 3 && x.votes.every((v) => v === x.votes[0]);
    const k = !same ? 'split' : x.votes[0] === 'HOLDS' ? 'holds' : x.votes[0] === 'BROKEN' ? 'broken' : 'insufficient';
    a[k] = n(a[k]) + 1;
    if (x.stale) a.stale = n(a.stale) + 1;
    if (x.noConfirm) a.no_confirm = n(a.no_confirm) + 1;
    by.set(x.group, a);
  }
  const fin = (r: Row): Row => ({ ...r, holds_ratio: ratio(n(r.holds), n(r.premise_checks)), insufficient_ratio: ratio(n(r.insufficient), n(r.premise_checks)) });
  const out = [...by.values()].sort((a, b) => String(a.fn).localeCompare(String(b.fn)) || String(a.prompt_version).localeCompare(String(b.prompt_version))).map(fin);
  const keys = ['runs', 'premise_checks', 'holds', 'broken', 'insufficient', 'split', 'stale', 'no_confirm'];
  return { id: 'premise_prompt', title: PREMISE_PROMPT_TITLE, rows: withTotal(out, { fn: '合計', prompt_version: null }, keys, (t) => Object.assign(t, fin(t))) };
};

/**
 * 每次執行取了多少網頁／同業申報（依功能：OWN_REVIEW 定期審查、OWN_DROP 減半檢視、OWN_DRAFT 草稿；ai_runs.added_docs 與 lookups，建立時間在期間內）：
 *   off              不能取文件的執行（doc_ctx.off，例如只有系統預設前提的審查）
 *   not_looking      可以取、但分析師沒有要（calls = 0）：「沒有要找」
 *   looked           呼叫過取文件的端點（calls > 0）
 *   got_none         想取、一份都沒取到：「沒取到」（原因在 web_refused）
 *   got_some         取到至少一份
 *   calls、docs、web_docs、filing_docs、chars、truncated_docs   呼叫次數、取回的份數（網頁、同業申報）、合計字數（給 AI 的原文）、被截掉的份數
 *   avg_docs、avg_chars   每次「呼叫過端點」的執行平均取幾份、幾個字（沒呼叫的不算；合計列照合計重算）
 *   max_docs、max_chars   單次執行最多取幾份、幾個字（上限 8 份、60,000 字）
 *   sites_at_cap     同一個網站已經抓滿 WEB_DOC_PER_SITE 篇的（執行、網站）數
 *   refused          被拒絕的總數（含 LIMIT）
 *   lookups_reported、questions、queries、wanted   分析師自己回報的找資料紀錄（AI 寫的，只當參考；取到幾份以 docs 為準）：回報的執行數、要查的問題數、搜尋次數、想取的份數
 *   clause_runs、clause_slots、clause_asked   T62：審查與減半檢視、回報了 lookups 而且可以找資料的執行數；證據包的前提共有幾句 breaksIf（沒有的前提算一句）；其中有問題（for 是那一條前提）的有幾句。
 *     clause_asked 比 clause_slots 少 = 分析師沒有照「每一句各列一個問題」做；只是紀錄，不影響那次執行
 */
export const webRunsSection: SectionFn = async (db, p) => {
  const c = atCond(p, 'r.created_at');
  const calls = "COALESCE(json_extract(r.added_docs, '$.calls'), 0)";
  const docs = "COALESCE(json_array_length(r.added_docs, '$.docs'), 0)";
  const chars = "COALESCE(json_extract(r.added_docs, '$.chars'), 0)";
  const off = "(COALESCE(json_extract(r.doc_ctx, '$.off'), '') != '')";
  const kind = (k: string) => `COALESCE(SUM((SELECT COUNT(*) FROM json_each(r.added_docs, '$.docs') d WHERE json_extract(d.value, '$.kind') = '${k}')), 0)`;
  // T62：審查與減半檢視的分析師回報了 lookups、而且這次可以找資料的，證據包每一條前提的每一句 breaksIf（沒有的算一句）有沒有各一個問題（for 是那一條前提）。只是紀錄，不影響任何一次執行。
  const clauseRun = `r.fn IN ('OWN_REVIEW', 'OWN_DROP') AND r.lookups IS NOT NULL AND NOT ${off}`;
  const need = "MAX(1, COALESCE(json_array_length(p.value, '$.breaksIf'), 0))";
  const asked = "(SELECT COUNT(*) FROM json_each(r.lookups, '$.questions') q WHERE json_extract(q.value, '$.for') = json_extract(p.value, '$.id'))";
  const rows = await query(
    db,
    `SELECT r.fn AS fn, COUNT(*) AS runs,
       COALESCE(SUM(${off}), 0) AS off,
       COALESCE(SUM(NOT ${off} AND ${calls} = 0), 0) AS not_looking,
       COALESCE(SUM(${calls} > 0), 0) AS looked,
       COALESCE(SUM(${calls} > 0 AND ${docs} = 0), 0) AS got_none,
       COALESCE(SUM(${docs} > 0), 0) AS got_some,
       COALESCE(SUM(${calls}), 0) AS calls,
       COALESCE(SUM(${docs}), 0) AS docs,
       ${kind('web')} AS web_docs,
       ${kind('filing')} AS filing_docs,
       COALESCE(SUM(${chars}), 0) AS chars,
       COALESCE(SUM((SELECT COUNT(*) FROM json_each(r.added_docs, '$.docs') d WHERE json_extract(d.value, '$.truncated') = 1)), 0) AS truncated_docs,
       COALESCE(MAX(${docs}), 0) AS max_docs,
       COALESCE(MAX(${chars}), 0) AS max_chars,
       COALESCE(SUM((SELECT COUNT(*) FROM json_each(r.added_docs, '$.sites') s WHERE s.value >= ${WEB_DOC_PER_SITE})), 0) AS sites_at_cap,
       COALESCE(SUM(COALESCE(json_extract(r.added_docs, '$.refusedTotal'), 0)), 0) AS refused,
       COALESCE(SUM(r.lookups IS NOT NULL), 0) AS lookups_reported,
       COALESCE(SUM(json_array_length(r.lookups, '$.questions')), 0) AS questions,
       COALESCE(SUM(json_array_length(r.lookups, '$.queries')), 0) AS queries,
       COALESCE(SUM(json_array_length(r.lookups, '$.wanted')), 0) AS wanted,
       COALESCE(SUM(CASE WHEN ${clauseRun} THEN 1 ELSE 0 END), 0) AS clause_runs,
       COALESCE(SUM(CASE WHEN ${clauseRun} THEN (SELECT COALESCE(SUM(${need}), 0) FROM json_each(r.pack, '$.premises') p) ELSE 0 END), 0) AS clause_slots,
       COALESCE(SUM(CASE WHEN ${clauseRun} THEN (SELECT COALESCE(SUM(MIN(${need}, ${asked})), 0) FROM json_each(r.pack, '$.premises') p) ELSE 0 END), 0) AS clause_asked
     FROM ai_runs r WHERE r.fn IN (${FN_LIST}) AND ${c.sql} GROUP BY r.fn ORDER BY r.fn`,
    c.args,
  );
  const avg = (r: Row): Row => ({ ...r, avg_docs: n(r.looked) ? Math.round((n(r.docs) / n(r.looked)) * 10) / 10 : null, avg_chars: n(r.looked) ? Math.round(n(r.chars) / n(r.looked)) : null });
  const keys = ['runs', 'off', 'not_looking', 'looked', 'got_none', 'got_some', 'calls', 'docs', 'web_docs', 'filing_docs', 'chars', 'truncated_docs', 'sites_at_cap', 'refused', 'lookups_reported', 'questions', 'queries', 'wanted', 'clause_runs', 'clause_slots', 'clause_asked'];
  const out = withTotal(rows.map(avg), { fn: '合計' }, keys, (t) => {
    t.max_docs = Math.max(...rows.map((r) => n(r.max_docs)));
    t.max_chars = Math.max(...rows.map((r) => n(r.max_chars)));
    Object.assign(t, avg(t));
  });
  return { id: 'web_runs', title: '每次執行取回的網頁與同業申報（依功能；沒有要找、沒取到、取到幾份、幾個字、被拒絕幾份）', rows: out };
};

/**
 * 取文件被拒絕的原因（依功能與原因；ai_runs.added_docs.refused，只留每次執行前 60 筆，超過的合成 OVER_CAP 一列，所以每個功能的列加起來 = 被拒絕的總數）。
 * 原因：NOT_LISTED 清單外（含不列入、路徑不收）、BLOCKED 被擋（HTTP 4xx、5xx）、THIN 內文太短、UNSUPPORTED 不是網頁、NO_DATE 認不出發布日、
 * TOO_OLD 太舊、LIMIT 超過每次執行的上限、ERROR 其他（發布日晚於決策日、申報抓不到、轉址到清單外、格式不對）。
 */
export const webRefusedSection: SectionFn = async (db, p) => {
  const c = atCond(p, 'r.created_at');
  const rows = await query(
    db,
    `SELECT r.fn AS fn, json_extract(x.value, '$.reason') AS reason, COUNT(*) AS n
     FROM ai_runs r, json_each(r.added_docs, '$.refused') x WHERE r.fn IN (${FN_LIST}) AND ${c.sql} GROUP BY r.fn, reason ORDER BY r.fn, reason`,
    c.args,
  );
  const caps = await query(
    db,
    `SELECT r.fn AS fn, COALESCE(SUM(COALESCE(json_extract(r.added_docs, '$.refusedTotal'), 0) - COALESCE(json_array_length(r.added_docs, '$.refused'), 0)), 0) AS n
     FROM ai_runs r WHERE r.fn IN (${FN_LIST}) AND ${c.sql} GROUP BY r.fn ORDER BY r.fn`,
    c.args,
  );
  const over = caps.filter((x) => n(x.n) > 0).map((x) => ({ fn: x.fn, reason: 'OVER_CAP', n: n(x.n) }));
  const all = [...rows, ...over].sort((a, b) => String(a.fn).localeCompare(String(b.fn)) || String(a.reason).localeCompare(String(b.reason)));
  return { id: 'web_refused', title: '取文件被拒絕的原因（依功能；OVER_CAP = 超過每次執行只留 60 筆的部分）', rows: withTotal(all, { fn: '合計', reason: null }, ['n']) };
};

const webWindow = (p: Period): { sql: string; args: string[] } => ({ sql: 'fetched_at >= ? AND fetched_at < ?', args: [`${dayShift(p.to, 1 - WEB_DOMAIN_DAYS)}T00:00:00.000Z`, `${nextDay(p.to)}T00:00:00.000Z`] });
const WEB_SKIPPED_TITLE = `被略過最多的網域（不在清單；最近 ${WEB_DOMAIN_DAYS} 天，到期間迄日為止；前 ${WEB_DOMAIN_ROWS} 個）`;
const WEB_FAILED_TITLE = `抓取失敗的網域（清單內；最近 ${WEB_DOMAIN_DAYS} 天，到期間迄日為止；有失敗的前 ${WEB_DOMAIN_ROWS} 個）`;

/**
 * 被略過最多的網域（web_docs 的 NOT_LISTED：分析師要了、但不在共用清單也不在這檔的 domains；設計 §1.3「加網域的流程」）。
 * 最近 WEB_DOMAIN_DAYS 天（到期間的迄日為止，不跟 from 走）；列前 WEB_DOMAIN_ROWS 個，合計列算全部。
 * excluded = 評論與社群網站（不列入）；path = 網域在清單內但路徑不收；not_listed = 完全不在清單；tickers = 幾檔股票要過；last_title = 最近一次的標題（搜尋結果的標題）。
 */
export const webSkippedSection: SectionFn = async (db, p) => {
  const w = webWindow(p);
  const docs = await query(db, `SELECT url, error, ticker, fetched_at, title FROM web_docs WHERE status = 'NOT_LISTED' AND ${w.sql} ORDER BY fetched_at, row_id`, w.args);
  if (!docs.length) return { id: 'web_skipped', title: WEB_SKIPPED_TITLE, rows: [] };
  const by = new Map<string, { n: number; excluded: number; path: number; not_listed: number; tickers: Set<string>; last_at: string; last_title: string | null }>();
  for (const d of docs) {
    const host = hostOf(String(d.url)) || '(認不出網域)';
    const a = by.get(host) ?? { n: 0, excluded: 0, path: 0, not_listed: 0, tickers: new Set<string>(), last_at: '', last_title: null };
    a.n++;
    if (d.error === 'EXCLUDED') a.excluded++;
    else if (d.error === 'PATH') a.path++;
    else a.not_listed++;
    a.tickers.add(String(d.ticker));
    a.last_at = String(d.fetched_at);
    a.last_title = d.title === null ? null : String(d.title);
    by.set(host, a);
  }
  const list = [...by.entries()].sort(([ka, a], [kb, b]) => b.n - a.n || ka.localeCompare(kb));
  const rows: Row[] = list.slice(0, WEB_DOMAIN_ROWS).map(([domain, a]) => ({ domain, n: a.n, excluded: a.excluded, path: a.path, not_listed: a.not_listed, tickers: a.tickers.size, last_at: a.last_at, last_title: a.last_title }));
  rows.push({
    domain: '合計（全部網域）',
    n: docs.length,
    excluded: list.reduce((s, [, a]) => s + a.excluded, 0),
    path: list.reduce((s, [, a]) => s + a.path, 0),
    not_listed: list.reduce((s, [, a]) => s + a.not_listed, 0),
    tickers: new Set(docs.map((d) => String(d.ticker))).size,
    last_at: null,
    last_title: null,
  });
  return { id: 'web_skipped', title: WEB_SKIPPED_TITLE, rows };
};

/**
 * 抓取失敗的網域（web_docs，清單內的網域；NOT_LISTED 不算抓取，看 web_skipped）。同樣最近 WEB_DOMAIN_DAYS 天、前 WEB_DOMAIN_ROWS 個（有失敗的才列），合計列算全部。
 * attempts = 實際抓過幾次（重用舊快照的不再抓、不算）；ok 抓到全文；失敗 failed = thin 內文太短 ＋ blocked 被擋 ＋ unsupported 不是網頁 ＋ no_date 認不出發布日 ＋ error 其他；
 * too_old 發布日太舊（程式規則擋掉，不算失敗）；fail_ratio = failed ÷ attempts；thin_avg_chars = 內文太短的那幾篇轉成文字後平均幾字
 * （門檻 1,500 字對韓文、中文偏嚴，設計 §0.5 說看這一欄再決定要不要改）；last_error = 最近一次失敗的原因。
 */
export const webFailedSection: SectionFn = async (db, p) => {
  const w = webWindow(p);
  const docs = await query(db, `SELECT url, domain, status, error, chars FROM web_docs WHERE status != 'NOT_LISTED' AND ${w.sql} ORDER BY fetched_at, row_id`, w.args);
  type Acc = { attempts: number; ok: number; thin: number; blocked: number; unsupported: number; no_date: number; error: number; too_old: number; thinChars: number; thinN: number; lastError: string | null };
  const blank = (): Acc => ({ attempts: 0, ok: 0, thin: 0, blocked: 0, unsupported: 0, no_date: 0, error: 0, too_old: 0, thinChars: 0, thinN: 0, lastError: null });
  const by = new Map<string, Acc>();
  const col = (st: string): 'thin' | 'blocked' | 'unsupported' | 'no_date' | 'error' | 'too_old' => ({ THIN: 'thin', BLOCKED: 'blocked', UNSUPPORTED: 'unsupported', NO_DATE: 'no_date', TOO_OLD: 'too_old' } as const)[st as 'THIN'] ?? 'error';
  for (const d of docs) {
    const key = String(d.domain ?? '') || hostOf(String(d.url)) || '(認不出網域)';
    const a = by.get(key) ?? blank();
    a.attempts++;
    const st = String(d.status);
    if (st === 'OK') a.ok++;
    else {
      a[col(st)]++;
      if (st !== 'TOO_OLD') a.lastError = d.error === null ? st : `${st}：${String(d.error)}`;
    }
    if (st === 'THIN' && d.chars !== null) {
      a.thinChars += n(d.chars);
      a.thinN++;
    }
    by.set(key, a);
  }
  if (!by.size) return { id: 'web_failed', title: WEB_FAILED_TITLE, rows: [] };
  const failedOf = (a: Acc) => a.thin + a.blocked + a.unsupported + a.no_date + a.error;
  const toRow = (domain: string, a: Acc): Row => ({
    domain,
    attempts: a.attempts,
    ok: a.ok,
    failed: failedOf(a),
    thin: a.thin,
    blocked: a.blocked,
    unsupported: a.unsupported,
    no_date: a.no_date,
    error: a.error,
    too_old: a.too_old,
    fail_ratio: ratio(failedOf(a), a.attempts),
    thin_avg_chars: a.thinN ? Math.round(a.thinChars / a.thinN) : null,
    last_error: a.lastError,
  });
  const total = blank();
  for (const a of by.values()) for (const k of ['attempts', 'ok', 'thin', 'blocked', 'unsupported', 'no_date', 'error', 'too_old', 'thinChars', 'thinN'] as const) total[k] += a[k];
  const rows = [...by.entries()]
    .filter(([, a]) => failedOf(a) > 0)
    .sort(([ka, a], [kb, b]) => failedOf(b) - failedOf(a) || ka.localeCompare(kb))
    .slice(0, WEB_DOMAIN_ROWS)
    .map(([domain, a]) => toRow(domain, a));
  rows.push({ ...toRow('合計（全部網域）', total), last_error: null });
  return { id: 'web_failed', title: WEB_FAILED_TITLE, rows };
};

/**
 * 草稿（own_drafts，建立時間在期間內；依 AUTO 新自選自動開的、MANUAL 使用者按的）。每一列是一次草擬（自動失敗後重試的算另一次）。
 *   pending 還在跑；ready／used／dismissed／expired／failed 各狀態的次數；
 *   finished = drafts − pending；ok = ready ＋ used ＋ dismissed ＋ expired（通過程式檢查、使用者看得到的草稿）；
 *   success_ratio = ok ÷ finished（失敗的原因在 draft_failures）；used_ratio = used ÷ ok（存檔用了至少一項）；avg_minutes = 通過檢查的草稿從建立到結算平均幾分鐘；
 *   存檔用了的草稿（used_json）：premises_same 原樣勾選的前提、premises_edited 勾了又改字、premises_kept 沿用現有的、premises_unused 沒勾的；
 *   premises_taken_ratio = (same ＋ edited) ÷ (same ＋ edited ＋ unused)；exits_used／exits_unused 出場條件勾了與沒勾的條數。
 */
export const draftsSection: SectionFn = async (db, p) => {
  const c = atCond(p, 'created_at');
  const okSt = "status IN ('READY', 'USED', 'DISMISSED', 'EXPIRED')";
  const used = (path: string) => `COALESCE(SUM(json_extract(used_json, '${path}')), 0)`;
  const rows = await query(
    db,
    `SELECT trigger, COUNT(*) AS drafts,
       COALESCE(SUM(status = 'PENDING'), 0) AS pending,
       COALESCE(SUM(status = 'READY'), 0) AS ready,
       COALESCE(SUM(status = 'USED'), 0) AS used,
       COALESCE(SUM(status = 'DISMISSED'), 0) AS dismissed,
       COALESCE(SUM(status = 'EXPIRED'), 0) AS expired,
       COALESCE(SUM(status = 'FAILED'), 0) AS failed,
       ROUND(AVG(CASE WHEN ${okSt} AND settled_at IS NOT NULL THEN (julianday(settled_at) - julianday(created_at)) * 1440 END), 1) AS avg_minutes,
       ${used('$.premises.same')} AS premises_same,
       ${used('$.premises.edited')} AS premises_edited,
       ${used('$.premises.kept')} AS premises_kept,
       ${used('$.unused.premises')} AS premises_unused,
       ${used('$.exits')} AS exits_used,
       ${used('$.unused.exits')} AS exits_unused
     FROM own_drafts WHERE ${c.sql} GROUP BY trigger ORDER BY trigger`,
    c.args,
  );
  const fin = (r: Row): Row => {
    const ok = n(r.ready) + n(r.used) + n(r.dismissed) + n(r.expired);
    const finished = n(r.drafts) - n(r.pending);
    const offered = n(r.premises_same) + n(r.premises_edited) + n(r.premises_unused);
    return { ...r, finished, ok, success_ratio: ratio(ok, finished), used_ratio: ratio(n(r.used), ok), premises_taken_ratio: ratio(n(r.premises_same) + n(r.premises_edited), offered) };
  };
  const keys = ['drafts', 'pending', 'ready', 'used', 'dismissed', 'expired', 'failed', 'premises_same', 'premises_edited', 'premises_kept', 'premises_unused', 'exits_used', 'exits_unused'];
  return { id: 'drafts', title: '論點草稿（依觸發：AUTO 新自選自動開的、MANUAL 使用者按的）：成功率、用了多少', rows: withTotal(rows.map(fin), { trigger: '合計', avg_minutes: null }, keys, (t) => Object.assign(t, fin(t))) };
};

/** 草稿失敗的原因（依觸發與原因；原因取 own_drafts.error 第一個冒號或括號之前的字，例如「程式檢查沒過」「送回的格式不合格」「研究員認為證據不夠寫草稿」）。 */
export const draftFailuresSection: SectionFn = async (db, p) => {
  const c = atCond(p, 'created_at');
  const rows = await query(db, `SELECT trigger, error FROM own_drafts WHERE status = 'FAILED' AND ${c.sql} ORDER BY id`, c.args);
  const by = new Map<string, number>();
  for (const r of rows) {
    const reason = (String(r.error ?? '').split(/[：:（(]/)[0].trim() || '(沒有寫原因)').slice(0, 60);
    const k = `${r.trigger}${SEP}${reason}`;
    by.set(k, (by.get(k) ?? 0) + 1);
  }
  const out: Row[] = [...by.entries()]
    .map(([k, count]) => {
      const [trigger, reason] = k.split(SEP);
      return { trigger, reason, n: count };
    })
    .sort((a, b) => String(a.trigger).localeCompare(String(b.trigger)) || n(b.n) - n(a.n) || String(a.reason).localeCompare(String(b.reason)));
  return { id: 'draft_failures', title: '草稿失敗的原因（依觸發）', rows: withTotal(out, { trigger: '合計', reason: null }, ['n']) };
};

/** 報表的各段，照這個順序輸出。要加段就在這裡加一個函式（T31a 加了月底檢查點、T33b 加了崩盤規則、T32d 加了動能進場審查、T57 加了前提結果、網頁與草稿七段、T61 加了前提的判定依 prompt 版本）。 */
export const OPS_SECTIONS: SectionFn[] = [notificationsSection, choicesSection, shadowSection, dataRunsSection, flowRunsSection, alertsSection, pushesSection, aiRunsSection, aiVotesSection, aiTasksSection, aiRejectionsSection, checkpointSection, crashSection, momEntrySection, premiseOriginSection, premisePromptSection, webRunsSection, webRefusedSection, webSkippedSection, webFailedSection, draftsSection, draftFailuresSection];

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
