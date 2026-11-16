-- T39c（design_v2 §10 第 48 點）：拆股與合股。市場資料，只增加，上線後留著。
-- 來源是 Yahoo 日線回應裡的拆股事件（每日抓取、填快照前的重抓都會記）。同一檔同一個生效日只記一次。
--   numerator / denominator  1 拆 10 是 10 / 1；10 合 1 是 1 / 10
--   seen_at                  第一次看到的時間（UTC ISO）
-- 帳戶載入時把生效日在「最後一次對照券商的日子」之後、還沒套用過的拆股套用到持股與還沒成交的清單（ledgerStore.loadAccount）。
CREATE TABLE IF NOT EXISTS splits (
  ticker TEXT NOT NULL,
  date TEXT NOT NULL,          -- 生效日（美東）
  numerator REAL NOT NULL,
  denominator REAL NOT NULL,
  seen_at TEXT NOT NULL,
  PRIMARY KEY (ticker, date)
);
