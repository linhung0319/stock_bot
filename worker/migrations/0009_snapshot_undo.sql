-- T14（2026-11-15，設計 §10 第 39 點）：復原上一份快照。
-- 每種模式只留最後一份快照送出前的帳戶；帳戶版本（rev）之後又變了（每日流程、其他操作）就不能復原。
CREATE TABLE IF NOT EXISTS snapshot_undo (
  mode TEXT PRIMARY KEY,       -- 'real' 或 'demo'
  rev INTEGER NOT NULL,        -- 快照存檔後的版本（real：account_state.rev；demo：demo_state.rev）
  date TEXT NOT NULL,          -- 快照對應的交易日
  at TEXT NOT NULL,            -- 送出時間
  state TEXT NOT NULL,         -- real：送出前的 Account 去掉 notifs／events／shadow；demo：送出前的整個 Account
  notifs TEXT NOT NULL         -- real：{"changed": [送出前的 Notif…], "created": [這次新產生的通知編號…]}；demo：{}
);
