-- T10：F24 自選定期審查、F25 自選條件監測。

-- F25 監測中的條件：每次 F24 有結論就整組替換（舊的標 REPLACED，留在紀錄）。
CREATE TABLE IF NOT EXISTS own_conditions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT NOT NULL,
  run_id TEXT NOT NULL,          -- 寫下這條條件的 F24 執行
  cond_id TEXT NOT NULL,         -- C1、C2…
  direction TEXT NOT NULL,       -- DOWN（降級）／UP（升級）
  kind TEXT NOT NULL,            -- XBRL（程式比對）／EVENT（新申報出現時請 AI 判斷）／PRICE（只記錄）
  text TEXT NOT NULL,
  check_json TEXT NOT NULL,
  tier_if_met TEXT,
  status TEXT NOT NULL,          -- ACTIVE／MET／REPLACED／MANUAL
  created_at TEXT NOT NULL,
  met_at TEXT,
  note TEXT
);
CREATE INDEX IF NOT EXISTS own_conditions_ticker ON own_conditions (ticker, status);

-- AI 執行的結論套用到帳戶的時間（每日流程套用一次）。
ALTER TABLE ai_runs ADD COLUMN applied_at TEXT;
