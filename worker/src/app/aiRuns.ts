// AI 執行（T9）：存證據包 → 建任務、觸發雲端排程 → 收到結果後檢查每一票、表決 → 存結論。
// 沒有結果（觸發失敗、逾時、結果被退回）也存一份「照規則」的結論，所以每一次執行最後都有結論可以看。
import { judge, noResult, packHash, type EvidencePack, type Outcome } from '../ai/check';
import { TASK_TIMEOUT_MS, createTask, fireRoutine, type AiTaskRow } from './aiTasks';
import type { Env, Fetcher } from './env';

export interface ProcessStep {
  role: string;
  model?: string;
  text: string;
}

export interface AiRun {
  runId: string;
  fn: string;
  ticker: string | null;
  asOf: string;
  createdAt: string;
  status: 'PENDING' | 'DONE';
  taskId: string | null;
  promptVersion: string;
  packHash: string;
  pack: EvidencePack;
  packNotes: string[];
  outcome: Outcome | null;
  process: ProcessStep[];
  completedAt: string | null;
}

interface Row {
  run_id: string;
  fn: string;
  ticker: string | null;
  as_of: string;
  created_at: string;
  status: AiRun['status'];
  task_id: string | null;
  prompt_version: string;
  pack_hash: string;
  pack: string;
  pack_notes: string | null;
  outcome: string | null;
  process: string | null;
  completed_at: string | null;
}

const toRun = (r: Row): AiRun => ({
  runId: r.run_id,
  fn: r.fn,
  ticker: r.ticker,
  asOf: r.as_of,
  createdAt: r.created_at,
  status: r.status,
  taskId: r.task_id,
  promptVersion: r.prompt_version,
  packHash: r.pack_hash,
  pack: JSON.parse(r.pack),
  packNotes: r.pack_notes ? JSON.parse(r.pack_notes) : [],
  outcome: r.outcome ? JSON.parse(r.outcome) : null,
  process: r.process ? JSON.parse(r.process) : [],
  completedAt: r.completed_at,
});

async function close(db: D1Database, runId: string, outcome: Outcome, now: Date, process: ProcessStep[] = []): Promise<void> {
  await db.prepare("UPDATE ai_runs SET status = 'DONE', outcome = ?, process = ?, completed_at = ? WHERE run_id = ? AND status = 'PENDING'").bind(JSON.stringify(outcome), JSON.stringify(process), now.toISOString(), runId).run();
}

/**
 * 開始一次 AI 執行：存證據包、建任務（雲端排程只拿得到任務編號，用它來取證據包）、觸發。
 * 觸發失敗就直接存「照規則」的結論。
 */
export async function startRun(env: Env, fetcher: Fetcher, pack: EvidencePack, now: Date, packNotes: string[] = []): Promise<AiRun> {
  const db = env.DB;
  const hash = await packHash(pack);
  await db
    .prepare("INSERT INTO ai_runs (run_id, fn, ticker, as_of, created_at, status, prompt_version, pack_hash, pack, pack_notes) VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?)")
    .bind(pack.run_id, pack.function, pack.subject.ticker ?? null, pack.as_of, now.toISOString(), pack.prompt_version, hash, JSON.stringify(pack), JSON.stringify(packNotes))
    .run();
  const taskId = await createTask(db, 'RUN', { run_id: pack.run_id, function: pack.function, prompt_version: pack.prompt_version, pack_hash: hash, samples: pack.policy.samples, pack }, now);
  await db.prepare('UPDATE ai_runs SET task_id = ? WHERE run_id = ?').bind(taskId, pack.run_id).run();
  const fired = await fireRoutine(env, taskId, fetcher, now);
  if (!fired.ok) await close(db, pack.run_id, noResult(pack, 'NO_RESULT', `雲端排程沒有觸發成功（${fired.error}）`), now);
  return (await getRun(db, pack.run_id, now))!;
}

/** 雲端排程送回的結果通過格式檢查之後（aiTasks.acceptResult）：逐票檢查、表決、存結論。 */
export async function finalizeRun(db: D1Database, task: AiTaskRow, result: Record<string, unknown>, now: Date): Promise<Outcome | null> {
  const row = await db.prepare('SELECT * FROM ai_runs WHERE task_id = ?').bind(task.id).first<Row>();
  if (!row || row.status !== 'PENDING') return null;
  const run = toRun(row);
  const outcome = judge(run.pack, result.samples as unknown[]);
  await close(db, run.runId, outcome, now, (result.process as ProcessStep[] | undefined) ?? []);
  return outcome;
}

/**
 * 還在等結果、但任務已經結束（逾時、被退回、觸發失敗）或超過時限的執行：存「照規則」的結論。
 * 每次讀紀錄前都先跑一次，所以不用另外的排程。回傳這次結束了幾筆。
 */
export async function closeStaleRuns(db: D1Database, now: Date): Promise<number> {
  const rows = (
    await db
      .prepare("SELECT r.run_id, r.pack, r.created_at, t.status AS task_status, t.error AS task_error FROM ai_runs r LEFT JOIN ai_tasks t ON t.id = r.task_id WHERE r.status = 'PENDING'")
      .all<{ run_id: string; pack: string; created_at: string; task_status: string | null; task_error: string | null }>()
  ).results;
  let n = 0;
  for (const r of rows) {
    const pack = JSON.parse(r.pack) as EvidencePack;
    const expired = now.getTime() - Date.parse(r.created_at) > TASK_TIMEOUT_MS;
    let out: Outcome | null = null;
    if (r.task_status === 'TIMEOUT' || ((r.task_status === 'PENDING' || r.task_status === 'FETCHED') && expired)) out = noResult(pack, 'TIMEOUT', `超過 ${TASK_TIMEOUT_MS / 60000} 分鐘沒有收到結果`);
    else if (r.task_status === 'REJECTED') out = noResult(pack, 'NO_RESULT', `送回的結果被退回（${r.task_error ?? '格式不合格'}）`);
    else if (r.task_status === 'FIRE_FAILED') out = noResult(pack, 'NO_RESULT', `雲端排程沒有觸發成功（${r.task_error ?? ''}）`);
    else if (!r.task_status && expired) out = noResult(pack, 'NO_RESULT', '沒有建立任務');
    if (out) {
      await close(db, r.run_id, out, now);
      n++;
    }
  }
  return n;
}

export async function getRun(db: D1Database, runId: string, now?: Date): Promise<AiRun | null> {
  if (now) await closeStaleRuns(db, now);
  const r = await db.prepare('SELECT * FROM ai_runs WHERE run_id = ?').bind(runId).first<Row>();
  return r ? toRun(r) : null;
}

export async function listRuns(db: D1Database, now: Date, opt: { limit?: number; ticker?: string } = {}): Promise<AiRun[]> {
  await closeStaleRuns(db, now);
  const limit = Math.min(opt.limit ?? 100, 500);
  const q = opt.ticker
    ? db.prepare('SELECT * FROM ai_runs WHERE ticker = ? ORDER BY as_of DESC, created_at DESC LIMIT ?').bind(opt.ticker, limit)
    : db.prepare('SELECT * FROM ai_runs ORDER BY as_of DESC, created_at DESC LIMIT ?').bind(limit);
  return (await q.all<Row>()).results.map(toRun);
}
