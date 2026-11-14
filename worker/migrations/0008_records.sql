-- T13：AI 紀錄補齊（docs/analysis/records_guide.md）。

-- 沒通過外層檢查、或逾時之後才送到的 AI 輸出：一次一列，只增加。
-- 不放在 ai_tasks 同一列：ai_tasks.evidence 最多約 40 萬字（證據包上限），再加原始輸出會逼近 D1 單列 2 MB 的上限。
-- raw 最多存 256 KiB（UTF-8，和收結果的上限相同）；超過的只留前面，raw_bytes 記原本的大小、truncated = 1。
CREATE TABLE IF NOT EXISTS ai_rejections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,         -- ai_tasks.id（RUN 任務再由 ai_runs.task_id 接到 run_id）
  kind TEXT NOT NULL,            -- RUN／PING
  at TEXT NOT NULL,              -- UTC ISO
  status TEXT NOT NULL,          -- REJECTED（格式不合格，任務結束）／LATE（逾時之後才送到）
  reason TEXT NOT NULL,          -- 完整的退回原因（ai_tasks.error 只留前 500 字）
  http_status INTEGER NOT NULL,  -- 回給雲端排程的 HTTP 狀態
  raw TEXT NOT NULL,             -- 送來的原文
  raw_bytes INTEGER NOT NULL,
  truncated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ai_rejections_task ON ai_rejections (task_id);

-- 雲端排程執行時 repo 的 commit（git rev-parse HEAD），對得回當時的 prompt。舊紀錄與沒回報的是 NULL。
ALTER TABLE ai_runs ADD COLUMN repo_commit TEXT;
