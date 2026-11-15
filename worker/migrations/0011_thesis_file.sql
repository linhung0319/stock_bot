-- T25（own_thesis §1.2）：論點檔。每檔自選一份，編號 file_id = <代號>@<開檔的訊號日>（帳戶狀態的 own[代號].fileId）。

-- 條件屬於哪一份論點檔：讀條件的地方只讀 file_id 等於這檔現在的 fileId 的列（移出再加回時舊條件不會復活，修 N8）。
-- 舊列沒有這個欄位時是 NULL（上線前會清掉帳戶與 AI 的資料，不補號）。
ALTER TABLE own_conditions ADD COLUMN file_id TEXT;
CREATE INDEX IF NOT EXISTS own_conditions_file ON own_conditions (file_id, status);

-- 論點檔的歷史（只增加）：開檔、結案；之後的任務加論點的每一版、失效通知、使用者的回應、條件的勾選。
CREATE TABLE IF NOT EXISTS own_thesis_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT NOT NULL,
  file_id TEXT NOT NULL,
  at TEXT NOT NULL,              -- 寫入時間（ISO）
  session TEXT NOT NULL,         -- 訊號日
  kind TEXT NOT NULL,            -- OPEN／THESIS／BREAK_NOTICE／RESPONSE／CONDITION／CLOSE
  ref TEXT,                      -- 相關的 run_id、通知編號或條件的列編號
  body TEXT NOT NULL,            -- JSON（own_thesis §1.2 的表）
  account_version INTEGER        -- 和哪一版帳戶（account_state.rev）一起存；復原快照時那一版寫的列一起刪
);
CREATE INDEX IF NOT EXISTS own_thesis_log_file ON own_thesis_log (file_id, id);
CREATE INDEX IF NOT EXISTS own_thesis_log_rev ON own_thesis_log (account_version);
