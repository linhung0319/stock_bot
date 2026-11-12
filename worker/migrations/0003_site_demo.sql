-- T8：網站的示範模式。假市場＋腳本跑出來的整個帳戶狀態存在這一列，和真實帳本（account_state 等）完全分開。
CREATE TABLE IF NOT EXISTS demo_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  rev INTEGER NOT NULL,        -- 每次存檔加 1；兩個操作同時存檔時，後到的會被拒絕
  scenario TEXT NOT NULL,      -- 情境代號（s1、s2、s5）
  d INTEGER NOT NULL,          -- 模擬的今天：假市場的第幾個交易日
  updated_at TEXT NOT NULL,
  body TEXT NOT NULL           -- JSON：引擎的 Account（含通知、事件、沒照做的紀錄）
);
