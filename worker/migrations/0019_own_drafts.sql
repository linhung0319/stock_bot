-- T55（web_evidence_design §2.2、§2.3、§2.5）：stock bot 的論點草稿（OWN_DRAFT）。帳戶與 AI 的表，不進帳戶狀態。
-- 每次草擬一列（開執行時寫 PENDING，結果回來或逾時後改成 READY 或 FAILED）。草稿不是論點：每一條都要使用者勾選才生效（T56）。
--   file_id           開執行時這檔的論點檔編號
--   run_id            那一次 ai_runs（fn = OWN_DRAFT）
--   trigger           AUTO 新的自選自動開的（每份論點檔一次，失敗時自動重試一次）／MANUAL 使用者按的
--   session           開執行時的訊號日（決策日）
--   status            PENDING 還在跑／READY 等使用者看／USED 存檔用過／DISMISSED 不用這份／EXPIRED 30 天沒處理或有新的草稿／FAILED 退回、逾時、沒觸發成
--   payload           READY 的草稿（程式檢查過、整理成固定形狀的 JSON：論點、前提、出場條件、來源、反方三點、今天會不會買、監測不了的觀察、通過檢查的引用）
--   based_on_version  照第幾版論點寫的（沒有論點是 0）
--   broken            開執行時這檔有還沒回覆的乙類通知：{ premiseId, text, notif, notice }（草稿不能沿用那一條；notice 是草稿最上面固定的那句話）；沒有是 NULL
--   error             FAILED 的原因（白話）
--   settled_at        變成 READY 或 FAILED 的時間；updated_at 最近一次改狀態的時間
CREATE TABLE IF NOT EXISTS own_drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT NOT NULL,
  file_id TEXT,
  run_id TEXT NOT NULL UNIQUE,
  trigger TEXT NOT NULL,
  session TEXT NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL,
  payload TEXT,
  based_on_version INTEGER NOT NULL DEFAULT 0,
  broken TEXT,
  error TEXT,
  settled_at TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS own_drafts_ticker ON own_drafts (ticker, created_at);
CREATE INDEX IF NOT EXISTS own_drafts_status ON own_drafts (status);
