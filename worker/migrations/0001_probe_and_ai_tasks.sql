-- T4：資料來源實測紀錄；T5：AI 任務（證據包與結果）。
CREATE TABLE IF NOT EXISTS probe_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,            -- UTC ISO
  part TEXT NOT NULL,
  source TEXT NOT NULL,        -- yahoo / ssga / wikipedia / edgar / membership
  target TEXT NOT NULL,        -- 代號或說明
  ok INTEGER NOT NULL,
  status INTEGER,              -- HTTP 狀態（有的話）
  ms INTEGER NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS probe_runs_at ON probe_runs (at);

CREATE TABLE IF NOT EXISTS ai_tasks (
  id TEXT PRIMARY KEY,         -- 隨機編號，也是取證據包與送回結果的路徑
  kind TEXT NOT NULL,
  status TEXT NOT NULL,        -- PENDING / FETCHED / DONE / REJECTED / TIMEOUT / FIRE_FAILED
  evidence TEXT NOT NULL,      -- JSON
  result TEXT,                 -- JSON（通過檢查才存）
  error TEXT,
  session_url TEXT,
  created_at TEXT NOT NULL,
  fired_at TEXT,
  fetched_at TEXT,
  completed_at TEXT
);
