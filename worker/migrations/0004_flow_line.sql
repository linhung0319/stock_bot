-- T7：每日與每月流程、LINE 推播、缺席告警。

-- 流程的進度（鍵值）。lastSession = 每日檢查已經處理到哪一個交易日（下一次從它的下一個交易日接著做）。
CREATE TABLE IF NOT EXISTS flow_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 每次流程執行一列（排程兩次：收盤後一次、兩小時後再試一次；手動也算）。
CREATE TABLE IF NOT EXISTS flow_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session TEXT NOT NULL,       -- 這次的訊號日
  at TEXT NOT NULL,
  attempt TEXT NOT NULL,       -- FIRST（收盤後）、FINAL（再試一次，失敗就告警）、MANUAL
  status TEXT NOT NULL,        -- DONE、SKIPPED（已經做過）、NO_ACCOUNT、NO_SIGNAL、ERROR
  detail TEXT NOT NULL         -- JSON：處理了哪幾天、新通知、月報、推播結果
);
CREATE INDEX IF NOT EXISTS flow_runs_session ON flow_runs (session, status);

-- LINE 推播紀錄。通知推過一次就不再推（ok = 1）；失敗的下一次流程再試。
CREATE TABLE IF NOT EXISTS pushes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,          -- NOTIF、ALERT、TEST
  ref INTEGER,                 -- NOTIF：通知編號
  ok INTEGER NOT NULL,
  status INTEGER,              -- LINE API 的 HTTP 狀態
  error TEXT,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS pushes_ref ON pushes (kind, ref, ok);
