-- T11：其餘 AI 功能（F18 每日事件掃描、F19 硬事件、F1 否決法庭、F5／F6 崩盤規則檢視、F14 健檢的出場條件）。

-- 規則從 EDGAR 申報偵測到的事件（F18 規則段），以及每日掃描（LLM）、F7／F20 轉交的候選事件。
CREATE TABLE IF NOT EXISTS sec_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT NOT NULL,
  accession TEXT NOT NULL,       -- 申報編號；新聞或 AI 轉交的是來源編號
  form TEXT NOT NULL,
  event_date TEXT NOT NULL,      -- 申報日（新聞日）
  accepted_at TEXT,
  code TEXT NOT NULL,            -- PENDING_MA／ACCOUNTING／REGULATORY／DILUTION／EARNINGS…
  sub TEXT NOT NULL,             -- NT_10-K、8K_4.02、DEFM14A_TARGET、SCAN_REGULATORY…
  by_rule INTEGER NOT NULL,      -- 1 = 規則就能下結論（不用 LLM）
  display_only INTEGER NOT NULL, -- 1 = 只記錄、只顯示
  source TEXT NOT NULL,          -- EDGAR（規則）／SCAN（每日掃描的 LLM）／AI（F7、F20 轉交）
  detail TEXT,
  status TEXT NOT NULL,          -- NEW（還沒處理）／HANDLED（已通知或已開法庭）／INFO（只記錄）
  handled_note TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (ticker, accession, sub)
);
CREATE INDEX IF NOT EXISTS sec_events_ticker ON sec_events (ticker, event_date);
CREATE INDEX IF NOT EXISTS sec_events_status ON sec_events (status);

-- F1：每個月對新進場候選的審查結果（規則偵測、法庭、預設准許）。
CREATE TABLE IF NOT EXISTS mom_reviews (
  month TEXT NOT NULL,           -- 月報的月份（例如 2026-12）
  ticker TEXT NOT NULL,
  rank INTEGER,                  -- 審查時的排名
  decision TEXT NOT NULL,        -- ALLOW／ALLOW_WATCH／VETO／BLOCK（資料可疑）／PENDING（等法庭）
  reason_code TEXT,
  source TEXT NOT NULL,          -- RULE／AI／DEFAULT（法庭沒有結論，照規則准許）
  hits TEXT NOT NULL,            -- JSON：規則偵測的命中
  run_id TEXT,
  watch_reason TEXT,
  lift_condition TEXT,
  replaced_by TEXT,              -- 被否決後由誰遞補（月報出了之後補上）
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (month, ticker)
);

-- 每月的總經儀表板（F5／F6；每月都算、月報顯示）。
CREATE TABLE IF NOT EXISTS macro_snapshots (
  month TEXT PRIMARY KEY,
  as_of TEXT NOT NULL,
  data TEXT NOT NULL,            -- JSON
  created_at TEXT NOT NULL
);

-- 監測條件的來源：AI（F24 寫的，每次 F24 整組替換）／USER（F14 使用者寫的出場條件，不會被 F24 替換）。
ALTER TABLE own_conditions ADD COLUMN origin TEXT NOT NULL DEFAULT 'AI';
