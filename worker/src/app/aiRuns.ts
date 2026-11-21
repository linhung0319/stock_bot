// AI 執行（T9）：存證據包 → 建任務、觸發雲端排程 → 收到結果後檢查每一票、表決 → 存結論。
// 沒有結果（觸發失敗、逾時、結果被退回）也存一份「照規則」的結論，所以每一次執行最後都有結論可以看。
import { cleanLookups, parseAdded, parseLookups, withAdded, type AddedRecord, type DocCtx, type Lookups } from '../ai/added';
import { judge, noResult, packHash, type EvidencePack, type Outcome } from '../ai/check';
import { checkNewRisks, parseNewRisks, type NewRisksRecord } from '../ai/freshEyes';
import { PAYLOAD_HOOKS } from '../ai/hooks';
import { LATE_FETCH_ERROR, TASK_TIMEOUT_MS, createTask, fireRoutine, timeoutReason, type AiTaskRow } from './aiTasks';
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
  /** 雲端排程執行時 repo 的 commit（T13 起；舊紀錄、沒有回報、沒有結果的是 null）。 */
  repoCommit: string | null;
  /** T52：組證據包時記下的「可以取什麼」（目錄、發布日下限、這檔的網域）；沒有是 null（不能取文件的功能、舊紀錄）。測試直接組的紀錄可以沒有。 */
  docCtx?: DocCtx | null;
  /**
   * T52：分析師向取文件的端點要了什麼（取回的文件、被拒絕的、呼叫次數）。舊紀錄是空的。
   * pack.documents 已經含取回的文件（withAdded：表決、套用、網站都看同一份）；packHash 仍是程式準備的那一份的雜湊。
   */
  added?: AddedRecord;
  addedHash?: string | null;
  /** T53：分析師自己回報的找資料紀錄（要查的問題、搜尋的字、想取的每一份）；沒有回報、舊紀錄是 null。只用來顯示。 */
  lookups?: Lookups | null;
  /**
   * T63：新眼光找到的前提以外的風險，程式檢查之後的紀錄（composite_layer_design §3）。這次沒有請新眼光跑、沒有結果、舊紀錄是 null。
   * 只當建議：不影響 outcome。
   */
  newRisks?: NewRisksRecord | null;
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
  repo_commit?: string | null;
  doc_ctx?: string | null;
  added_docs?: string | null;
  added_hash?: string | null;
  lookups?: string | null;
  new_risks?: string | null;
}

const toRun = (r: Row): AiRun => {
  const added = parseAdded(r.added_docs);
  return {
    runId: r.run_id,
    fn: r.fn,
    ticker: r.ticker,
    asOf: r.as_of,
    createdAt: r.created_at,
    status: r.status,
    taskId: r.task_id,
    promptVersion: r.prompt_version,
    packHash: r.pack_hash,
    pack: withAdded(JSON.parse(r.pack) as EvidencePack, added.docs),
    packNotes: r.pack_notes ? JSON.parse(r.pack_notes) : [],
    outcome: r.outcome ? JSON.parse(r.outcome) : null,
    process: r.process ? JSON.parse(r.process) : [],
    completedAt: r.completed_at,
    repoCommit: r.repo_commit ?? null,
    docCtx: r.doc_ctx ? (JSON.parse(r.doc_ctx) as DocCtx) : null,
    added,
    addedHash: r.added_hash ?? null,
    lookups: parseLookups(r.lookups),
    newRisks: parseNewRisks(r.new_risks),
  };
};

/** 送回的 repo_commit：像 git commit（7～64 個十六進位字元）才存，其他一律當成沒有。 */
export function commitOf(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const c = v.trim().toLowerCase();
  return /^[0-9a-f]{7,64}$/.test(c) ? c : null;
}

async function close(db: D1Database, runId: string, outcome: Outcome, now: Date, process: ProcessStep[] = [], repoCommit: string | null = null, lookups: Lookups | null = null, newRisks: NewRisksRecord | null = null): Promise<void> {
  await db
    .prepare("UPDATE ai_runs SET status = 'DONE', outcome = ?, process = ?, completed_at = ?, repo_commit = ?, lookups = ?, new_risks = ? WHERE run_id = ? AND status = 'PENDING'")
    .bind(JSON.stringify(outcome), JSON.stringify(process), now.toISOString(), repoCommit, lookups ? JSON.stringify(lookups) : null, newRisks ? JSON.stringify(newRisks) : null, runId)
    .run();
}

/**
 * 開始一次 AI 執行：存證據包、建任務（雲端排程只拿得到任務編號，用它來取證據包）、觸發。
 * 觸發失敗就直接存「照規則」的結論。
 */
export async function startRun(env: Env, fetcher: Fetcher, pack: EvidencePack, now: Date, packNotes: string[] = [], docCtx: DocCtx | null = null): Promise<AiRun> {
  const db = env.DB;
  const hash = await packHash(pack);
  await db
    .prepare("INSERT INTO ai_runs (run_id, fn, ticker, as_of, created_at, status, prompt_version, pack_hash, pack, pack_notes, doc_ctx) VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?, ?)")
    .bind(pack.run_id, pack.function, pack.subject.ticker ?? null, pack.as_of, now.toISOString(), pack.prompt_version, hash, JSON.stringify(pack), JSON.stringify(packNotes), docCtx ? JSON.stringify(docCtx) : null)
    .run();
  const taskId = await createTask(db, 'RUN', { run_id: pack.run_id, function: pack.function, prompt_version: pack.prompt_version, pack_hash: hash, samples: pack.policy.samples, pack }, now);
  await db.prepare('UPDATE ai_runs SET task_id = ? WHERE run_id = ?').bind(taskId, pack.run_id).run();
  const fired = await fireRoutine(env, taskId, fetcher, now);
  if (!fired.ok) await close(db, pack.run_id, noResult(pack, 'NO_RESULT', `雲端排程沒有觸發成功（${fired.error}）`), now);
  return (await getRun(db, pack.run_id, now))!;
}

/**
 * 雲端排程送回的結果通過格式檢查之後（aiTasks.acceptResult）：逐票檢查、表決、存結論。
 * 比對的原文＝證據包的文件＋分析師取回的文件（toRun 已經用 withAdded 合起來，T52）。
 */
export async function finalizeRun(db: D1Database, task: AiTaskRow, result: Record<string, unknown>, now: Date): Promise<Outcome | null> {
  const row = await db.prepare('SELECT * FROM ai_runs WHERE task_id = ?').bind(task.id).first<Row>();
  if (!row || row.status !== 'PENDING') return null;
  const run = toRun(row);
  const outcome = judge(run.pack, result.samples as unknown[], PAYLOAD_HOOKS[run.fn]);
  // 新眼光的 new_risks（T63）：和三票分開檢查、分開存；不影響上面的結論。這次沒有請它跑的（pack.fresh_eyes）送回了也不看
  await close(db, run.runId, outcome, now, (result.process as ProcessStep[] | undefined) ?? [], commitOf(result.repo_commit), cleanLookups(result.lookups), checkNewRisks(run.pack, result.new_risks));
  return outcome;
}

/**
 * 這檔上一次「有跑新眼光」的定期審查的決策日（T63，composite_layer_design §3：定期審查每檔每 90 個日曆天最多一次）。
 * 算數的：還在等結果的，以及結果有回來的（new_risks 有紀錄，就算一條都沒列）；逾時、被退回、沒觸發成功的不算，下一次審查再跑。
 * 減半檢視的新眼光不在這裡算（每次都跑）。沒有 → null。
 */
export async function lastFreshReview(db: D1Database, ticker: string, asOf: string): Promise<string | null> {
  const r = await db
    .prepare("SELECT as_of FROM ai_runs WHERE fn = 'OWN_REVIEW' AND ticker = ? AND as_of <= ? AND json_extract(pack, '$.fresh_eyes.run') = 1 AND (status = 'PENDING' OR new_risks IS NOT NULL) ORDER BY as_of DESC LIMIT 1")
    .bind(ticker, asOf)
    .first<{ as_of: string }>();
  return r?.as_of ?? null;
}

/**
 * 還在等結果、但任務已經結束（逾時、被退回、觸發失敗）或超過時限的執行：存「照規則」的結論。
 * 每次讀紀錄前都先跑一次，所以不用另外的排程。回傳這次結束了幾筆。
 */
export async function closeStaleRuns(db: D1Database, now: Date): Promise<number> {
  const rows = (
    await db
      .prepare("SELECT r.run_id, r.pack, r.created_at, t.status AS task_status, t.error AS task_error, t.fetched_at AS task_fetched FROM ai_runs r LEFT JOIN ai_tasks t ON t.id = r.task_id WHERE r.status = 'PENDING'")
      .all<{ run_id: string; pack: string; created_at: string; task_status: string | null; task_error: string | null; task_fetched: string | null }>()
  ).results;
  let n = 0;
  for (const r of rows) {
    const pack = JSON.parse(r.pack) as EvidencePack;
    const expired = now.getTime() - Date.parse(r.created_at) > TASK_TIMEOUT_MS;
    let out: Outcome | null = null;
    if (r.task_status === 'TIMEOUT' || ((r.task_status === 'PENDING' || r.task_status === 'FETCHED') && expired)) out = noResult(pack, 'TIMEOUT', `超過 ${TASK_TIMEOUT_MS / 60000} 分鐘沒有收到結果：${timeoutReason(!!r.task_fetched, r.task_error === LATE_FETCH_ERROR)}`);
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
