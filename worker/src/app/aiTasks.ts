// AI 層的資料交換（設計 §2.7）：
//   Worker 存好證據包並給任務編號 → 觸發雲端排程（觸發文字只帶編號）
//   → Claude Code 向 Worker 取證據包 → 把固定格式的 JSON 送回 Worker → Worker 檢查
// Worker 把送回的內容當成不可信輸入：只接受固定欄位與列舉值，不合格或逾時就照規則並記錄。
import type { Env, Fetcher } from './env';

export const ROUTINE_BETA_HEADER = 'experimental-cc-routine-2026-04-01';
export const MAX_RESULT_BYTES = 256 * 1024;
/** 觸發後多久沒收到結果算逾時（雲端排程失敗不會主動通知）。 */
export const TASK_TIMEOUT_MS = 45 * 60 * 1000;

export type TaskStatus = 'PENDING' | 'FETCHED' | 'DONE' | 'REJECTED' | 'TIMEOUT' | 'FIRE_FAILED';

export interface AiTaskRow {
  id: string;
  kind: string;
  status: TaskStatus;
  evidence: string;
  result: string | null;
  error: string | null;
  session_url: string | null;
  created_at: string;
  fired_at: string | null;
  fetched_at: string | null;
  completed_at: string | null;
}

/** 檢查送回的結果。回傳錯誤訊息；null = 合格。 */
export type ResultValidator = (result: Record<string, unknown>, evidence: Record<string, unknown>) => string | null;

function onlyKeys(o: Record<string, unknown>, allowed: string[]): string | null {
  const extra = Object.keys(o).filter((k) => !allowed.includes(k));
  return extra.length ? `多了不認得的欄位：${extra.join(', ')}` : null;
}

/** T5 的測試任務：把證據包裡的 nonce 原樣送回，並回報幾項觀察。 */
const validatePing: ResultValidator = (r, ev) => {
  const extra = onlyKeys(r, ['task_id', 'kind', 'echo', 'model', 'observations']);
  if (extra) return extra;
  if (r.echo !== ev.nonce) return 'echo 和證據包的 nonce 不同';
  if (r.model !== undefined && typeof r.model !== 'string') return 'model 要是字串';
  if (r.observations !== undefined) {
    const o = r.observations;
    if (typeof o !== 'object' || o === null || Array.isArray(o)) return 'observations 要是物件';
    for (const [k, v] of Object.entries(o)) {
      if (!/^[a-z_]{1,40}$/.test(k)) return `observations 的欄位名稱不合格：${k}`;
      if (!(typeof v === 'boolean' || typeof v === 'number' || (typeof v === 'string' && v.length <= 500))) return `observations.${k} 只能是布林、數字或 500 字以內的字串`;
    }
  }
  return null;
};

/**
 * T9 的 AI 執行：只檢查外層的形狀（每一票的內容由 src/ai/check.ts 逐條檢查，不合格的那一票算成「證據不足」，
 * 不會整份退回；整份退回只在外層就不對的時候）。
 */
const validateRun: ResultValidator = (r, ev) => {
  const extra = onlyKeys(r, ['task_id', 'kind', 'run_id', 'samples', 'process']);
  if (extra) return extra;
  if (r.run_id !== ev.run_id) return 'run_id 和證據包不同';
  if (!Array.isArray(r.samples) || r.samples.length < 1 || r.samples.length > 5) return 'samples 要是 1～5 份輸出外殼';
  if (r.process !== undefined) {
    if (!Array.isArray(r.process) || r.process.length > 30) return 'process 要是 30 筆以內的陣列';
    for (const p of r.process) {
      if (typeof p !== 'object' || p === null || Array.isArray(p)) return 'process 的每一筆要是物件';
      const o = p as Record<string, unknown>;
      const bad = onlyKeys(o, ['role', 'model', 'text']);
      if (bad) return `process：${bad}`;
      if (typeof o.role !== 'string' || o.role.length > 60) return 'process.role 要是 60 字以內的字串';
      if (o.model !== undefined && (typeof o.model !== 'string' || o.model.length > 80)) return 'process.model 要是 80 字以內的字串';
      if (typeof o.text !== 'string' || o.text.length > 30_000) return 'process.text 要是 30000 字以內的字串';
    }
  }
  return null;
};

export const VALIDATORS: Record<string, ResultValidator> = { PING: validatePing, RUN: validateRun };

export function newTaskId(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export async function createTask(db: D1Database, kind: string, evidence: Record<string, unknown>, now: Date): Promise<string> {
  const id = newTaskId();
  await db.prepare("INSERT INTO ai_tasks (id, kind, status, evidence, created_at) VALUES (?, ?, 'PENDING', ?, ?)").bind(id, kind, JSON.stringify(evidence), now.toISOString()).run();
  return id;
}

export async function getTask(db: D1Database, id: string): Promise<AiTaskRow | null> {
  if (!/^[0-9a-f]{32}$/.test(id)) return null;
  return db.prepare('SELECT * FROM ai_tasks WHERE id = ?').bind(id).first<AiTaskRow>();
}

/** 觸發雲端排程。觸發文字只帶任務編號，不帶任何資料。 */
export async function fireRoutine(env: Env, id: string, fetcher: Fetcher, now: Date): Promise<{ ok: boolean; sessionUrl?: string; error?: string }> {
  if (!env.ROUTINE_FIRE_URL || !env.ROUTINE_TOKEN) {
    await env.DB.prepare("UPDATE ai_tasks SET status = 'FIRE_FAILED', error = ? WHERE id = ?").bind('沒有設定 ROUTINE_FIRE_URL／ROUTINE_TOKEN', id).run();
    return { ok: false, error: '沒有設定 ROUTINE_FIRE_URL／ROUTINE_TOKEN' };
  }
  let error: string;
  try {
    const res = await fetcher(env.ROUTINE_FIRE_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.ROUTINE_TOKEN}`, 'anthropic-beta': ROUTINE_BETA_HEADER, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `task_id=${id}` }),
    });
    if (res.ok) {
      const j = (await res.json()) as { claude_code_session_url?: string };
      await env.DB.prepare('UPDATE ai_tasks SET fired_at = ?, session_url = ? WHERE id = ?').bind(now.toISOString(), j.claude_code_session_url ?? null, id).run();
      return { ok: true, sessionUrl: j.claude_code_session_url };
    }
    error = `觸發失敗：HTTP ${res.status} ${(await res.text()).slice(0, 200)}`;
  } catch (e) {
    error = `觸發失敗：${e instanceof Error ? e.message : String(e)}`;
  }
  await env.DB.prepare("UPDATE ai_tasks SET status = 'FIRE_FAILED', error = ? WHERE id = ?").bind(error, id).run();
  return { ok: false, error };
}

/** 雲端排程來取證據包。只有還在等結果的任務拿得到。 */
export async function readEvidence(db: D1Database, id: string, now: Date): Promise<Response> {
  const t = await getTask(db, id);
  if (!t) return Response.json({ error: 'not_found' }, { status: 404 });
  if (t.status !== 'PENDING' && t.status !== 'FETCHED') return Response.json({ error: 'task_closed', status: t.status }, { status: 410 });
  if (now.getTime() - Date.parse(t.created_at) > TASK_TIMEOUT_MS) {
    await db.prepare("UPDATE ai_tasks SET status = 'TIMEOUT' WHERE id = ?").bind(id).run();
    return Response.json({ error: 'task_expired' }, { status: 410 });
  }
  await db.prepare("UPDATE ai_tasks SET status = 'FETCHED', fetched_at = COALESCE(fetched_at, ?) WHERE id = ?").bind(now.toISOString(), id).run();
  return Response.json({ task_id: t.id, kind: t.kind, evidence: JSON.parse(t.evidence) });
}

/** 雲端排程送回結果。只收一次；不合格就記錄原因，之後照規則。 */
export async function acceptResult(db: D1Database, id: string, bodyText: string, now: Date, onDone?: (task: AiTaskRow, result: Record<string, unknown>) => Promise<unknown>): Promise<Response> {
  const t = await getTask(db, id);
  if (!t) return Response.json({ error: 'not_found' }, { status: 404 });
  if (t.status !== 'PENDING' && t.status !== 'FETCHED') return Response.json({ error: 'task_closed', status: t.status }, { status: 409 });
  const reject = async (why: string, status = 422) => {
    await db.prepare("UPDATE ai_tasks SET status = 'REJECTED', error = ?, completed_at = ? WHERE id = ?").bind(why.slice(0, 500), now.toISOString(), id).run();
    return Response.json({ error: 'rejected', why }, { status });
  };
  if (now.getTime() - Date.parse(t.created_at) > TASK_TIMEOUT_MS) {
    await db.prepare("UPDATE ai_tasks SET status = 'TIMEOUT', completed_at = ? WHERE id = ?").bind(now.toISOString(), id).run();
    return Response.json({ error: 'task_expired' }, { status: 410 });
  }
  if (new TextEncoder().encode(bodyText).length > MAX_RESULT_BYTES) return reject('結果太大', 413);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return reject('不是合法的 JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return reject('結果要是 JSON 物件');
  const r = parsed as Record<string, unknown>;
  if (r.task_id !== id) return reject('task_id 和網址不同');
  if (r.kind !== t.kind) return reject('kind 和任務不同');
  const v = VALIDATORS[t.kind];
  if (!v) return reject(`沒有 ${t.kind} 的檢查規則`);
  const why = v(r, JSON.parse(t.evidence));
  if (why) return reject(why);
  await db.prepare("UPDATE ai_tasks SET status = 'DONE', result = ?, completed_at = ? WHERE id = ?").bind(JSON.stringify(r), now.toISOString(), id).run();
  // 收下之後的處理（AI 執行：逐票檢查、表決）。結果已經存了，這裡出錯不影響回給雲端排程的回應
  if (onDone) {
    try {
      await onDone(t, r);
    } catch (e) {
      console.error('結果收下之後的處理出錯', e);
    }
  }
  return Response.json({ ok: true });
}

/** 把逾時還沒有結果的任務標成 TIMEOUT，回傳這次標了哪些（給缺席告警用）。 */
export async function sweepTimeouts(db: D1Database, now: Date): Promise<string[]> {
  const cutoff = new Date(now.getTime() - TASK_TIMEOUT_MS).toISOString();
  const rows = await db.prepare("SELECT id FROM ai_tasks WHERE status IN ('PENDING', 'FETCHED') AND created_at < ?").bind(cutoff).all<{ id: string }>();
  const ids = rows.results.map((r) => r.id);
  for (const id of ids) await db.prepare("UPDATE ai_tasks SET status = 'TIMEOUT', completed_at = ? WHERE id = ?").bind(now.toISOString(), id).run();
  return ids;
}

/** 任務的時間紀錄（T5 要量從觸發到收到結果多久）。 */
export function taskTimings(t: AiTaskRow) {
  const ms = (a: string | null, b: string | null) => (a && b ? Date.parse(b) - Date.parse(a) : null);
  return {
    id: t.id,
    kind: t.kind,
    status: t.status,
    error: t.error,
    session_url: t.session_url,
    created_at: t.created_at,
    fire_to_fetch_ms: ms(t.fired_at, t.fetched_at),
    fetch_to_result_ms: ms(t.fetched_at, t.completed_at),
    fire_to_result_ms: ms(t.fired_at, t.completed_at),
    result: t.result ? JSON.parse(t.result) : null,
  };
}
