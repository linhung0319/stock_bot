-- T9：AI 執行紀錄（ai_layer_design §2、design_v2 §6.6）。一次執行一列：證據包、送回的每一票、檢查與表決的結論、過程。
-- 和雲端排程交換資料的是 ai_tasks（kind = 'RUN'）；這張表留下給人看、給影子組合用的完整紀錄。
CREATE TABLE IF NOT EXISTS ai_runs (
  run_id TEXT PRIMARY KEY,       -- 例如 2026-11-30_OWN_REVIEW_MU_a1b2c3
  fn TEXT NOT NULL,              -- 功能代號（OWN_REVIEW、OWN_CONDITION、MOM_ENTRY、CRASH_REVIEW…）
  ticker TEXT,
  as_of TEXT NOT NULL,           -- 決策日
  created_at TEXT NOT NULL,
  status TEXT NOT NULL,          -- PENDING（等結果）／DONE（有結論，含照規則的結論）
  task_id TEXT,                  -- ai_tasks.id
  prompt_version TEXT NOT NULL,
  pack_hash TEXT NOT NULL,
  pack TEXT NOT NULL,            -- JSON：證據包
  pack_notes TEXT,               -- JSON：組裝時拿掉或截短的東西
  outcome TEXT,                  -- JSON：檢查與表決的結論（src/ai/check.ts 的 Outcome）
  process TEXT,                  -- JSON：每個角色的完整輸出（檢方、辯方、法官…）
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS ai_runs_ticker ON ai_runs (ticker, as_of);
CREATE INDEX IF NOT EXISTS ai_runs_status ON ai_runs (status, created_at);
