-- T64（composite_layer_design §1.2～§1.5）：綜合層的市場摘要（MARKET_BRIEF）。只說明：不下單、不改任何狀態。
--
-- market_triggers：規則判斷的觸發紀錄，一個訊號日一種觸發（族群的一個產業 ETF）一列；只增加。市場資料類，上線後留著。
--   session     觸發的訊號日
--   kind        MARKET_DAY 核心 ETF 單日漲跌 ≥ 2.5%／GROUP_DAY 持股的產業 ETF 單日比大盤多漲跌 ≥ 3 個百分點／
--               CUMULATIVE 核心 ETF 21 個交易日跌 ≥ 10%、這段期間還沒有開過摘要／AI_RUN 當天有減半檢視或提前審查、最近 5 個交易日沒有摘要
--   grp         產業 ETF（GROUP_DAY）；其他是空字串
--   event_id    歸到哪個事件：一串觸發，每一次都在前一次之後 10 個交易日內（而且那個事件還沒有開過定稿）；編號是第一次觸發的訊號日
--   value       觸發的數字（單日漲跌、比大盤多漲跌、21 日漲跌；小數）；沒有數字的是 NULL
--   detail      白話的一句（給 AI 與人看）
CREATE TABLE IF NOT EXISTS market_triggers (
  session TEXT NOT NULL,
  kind TEXT NOT NULL,
  grp TEXT NOT NULL DEFAULT '',
  event_id TEXT NOT NULL,
  value REAL,
  detail TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (session, kind, grp)
);
CREATE INDEX IF NOT EXISTS market_triggers_event ON market_triggers (event_id, session);

-- market_briefs：每次開市場摘要一列（開執行時寫 PENDING，結果回來或逾時後改成 READY 或 FAILED）。帳戶與 AI 的表。
--   event_id     哪個事件（market_triggers.event_id）；手動開的是 manual-<訊號日>
--   stage        PROVISIONAL 暫定稿（10 個交易日內最多 1 份）／FINAL 定稿（事件最後一次觸發之後第 10 個交易日）
--   run_id       那一次 ai_runs（fn = MARKET_BRIEF）
--   session      開執行時的訊號日（決策日）
--   period_from / period_to  摘要涵蓋的期間（程式定的；period_to = session）
--   why          這次為什麼開（白話）
--   manual       1 = 手動開的（POST /admin/ai/brief）：不佔頻率上限、不屬於任何事件
--   status       PENDING 還在跑／READY 寫好了、通過程式檢查（原因不明也算寫好）／FAILED 退回、逾時、沒觸發成、程式檢查沒過
--   payload      READY 的摘要（程式檢查過、整理成固定形狀的 JSON：period、stage、facts、causes、unknown、clarity、
--                changed_since_provisional、groups、core、evidence、dropped、notes、report）
--   error        FAILED 的原因（白話）
--   settled_at   變成 READY 或 FAILED 的時間
CREATE TABLE IF NOT EXISTS market_briefs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  run_id TEXT NOT NULL UNIQUE,
  session TEXT NOT NULL,
  period_from TEXT NOT NULL,
  period_to TEXT NOT NULL,
  why TEXT,
  manual INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  payload TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  settled_at TEXT
);
CREATE INDEX IF NOT EXISTS market_briefs_session ON market_briefs (session, status);
CREATE INDEX IF NOT EXISTS market_briefs_event ON market_briefs (event_id, stage);
