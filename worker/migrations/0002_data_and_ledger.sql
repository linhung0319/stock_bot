-- T6：資料層（價格、成分股、排名、每日抓取紀錄、告警）與帳本（帳戶狀態、通知、事件、影子紀錄、快照）。
-- AI 紀錄沿用 0001 的 ai_tasks（T9 再擴充）。

-- 每檔一列：最近一次抓到的整段日線（約兩年）。每天整段覆寫，還原權值才會和 Yahoo 當天的一致。
CREATE TABLE IF NOT EXISTS price_series (
  ticker TEXT PRIMARY KEY,
  fetched_at TEXT NOT NULL,    -- UTC ISO
  session TEXT NOT NULL,       -- 抓的時候「最近一個已收盤的交易日」
  last_date TEXT NOT NULL,     -- 最後一根 K 線的日期（美東）
  n INTEGER NOT NULL,
  bars TEXT NOT NULL           -- JSON：{ d: 日期[], c: 未調整收盤[], a: 還原收盤[], v: 成交量[] }
);

-- 每個交易日一份成分股快照（SPY 持股檔＋Wikipedia 比對結果）。
CREATE TABLE IF NOT EXISTS constituents (
  session TEXT PRIMARY KEY,
  fetched_at TEXT NOT NULL,
  spy_as_of TEXT,              -- 持股檔上寫的日期
  n_spy INTEGER NOT NULL,
  n_wiki INTEGER NOT NULL,
  consistent INTEGER NOT NULL, -- 1 = 兩份名單一致
  only_spy TEXT NOT NULL,      -- JSON 代號陣列
  only_wiki TEXT NOT NULL,
  holdings TEXT NOT NULL       -- JSON：[代號, 權重, CIK 或 null][]
);

-- 每個月報訊號日（當月最後一個交易日）的股票池排名。
CREATE TABLE IF NOT EXISTS rankings (
  session TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  ord TEXT NOT NULL,           -- JSON：代號由排名高到低
  detail TEXT NOT NULL         -- JSON：股票池每檔的權重、收盤、成交金額、252 日報酬；同公司的類股；缺資料的代號
);

CREATE TABLE IF NOT EXISTS data_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session TEXT NOT NULL,
  at TEXT NOT NULL,
  status TEXT NOT NULL,        -- OK / DEGRADED / FAILED
  signals_ok INTEGER NOT NULL, -- 1 = 可以產生每日訊號（必要的價格都是最新的）
  rebalance_ok INTEGER NOT NULL, -- 1 = 可以換股（成分股一致）
  ranked INTEGER NOT NULL,     -- 1 = 這次有產生排名
  ms INTEGER NOT NULL,
  detail TEXT NOT NULL         -- JSON
);
CREATE INDEX IF NOT EXISTS data_runs_session ON data_runs (session);

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  session TEXT,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  detail TEXT,
  sent_at TEXT                 -- T7：推播後填
);
CREATE INDEX IF NOT EXISTS alerts_unsent ON alerts (sent_at, id);

-- 交易日曆的例外（臨時休市或規則算錯的日子）。
CREATE TABLE IF NOT EXISTS calendar_overrides (
  date TEXT PRIMARY KEY,
  open INTEGER NOT NULL,       -- 0 = 休市、1 = 有開市
  note TEXT
);

-- 帳戶狀態：目前的一份（rev 每次存檔加 1），以及每一版的歷史。
CREATE TABLE IF NOT EXISTS account_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  rev INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  state TEXT NOT NULL          -- JSON：Account 去掉 notifs／events／shadow
);
CREATE TABLE IF NOT EXISTS account_history (
  rev INTEGER PRIMARY KEY,     -- 兩邊同時存檔時，後到的會撞主鍵而整批取消
  at TEXT NOT NULL,
  cause TEXT NOT NULL,
  state TEXT NOT NULL
);

-- 通知與回覆（每則通知一列，內容是引擎的 Notif）。
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  date TEXT NOT NULL,
  status TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS notifications_status ON notifications (status);

-- 帳本事件（只增加）。
CREATE TABLE IF NOT EXISTS ledger_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rev INTEGER NOT NULL,
  date TEXT NOT NULL,
  kind TEXT NOT NULL,
  ticker TEXT,
  bucket TEXT,
  shares REAL,
  amount REAL,
  reason TEXT,
  notif INTEGER
);
CREATE INDEX IF NOT EXISTS ledger_events_date ON ledger_events (date);

-- 影子組合紀錄（只增加）。
CREATE TABLE IF NOT EXISTS shadow_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rev INTEGER NOT NULL,
  date TEXT NOT NULL,
  f TEXT NOT NULL,
  ticker TEXT,
  body TEXT NOT NULL
);

-- 使用者填的快照原文。
CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,          -- 快照對應的交易日
  submitted_at TEXT NOT NULL,
  cash REAL NOT NULL,
  positions TEXT NOT NULL,     -- JSON：{ 代號: 股數 }
  rev INTEGER                  -- 套用後的帳戶版本
);
