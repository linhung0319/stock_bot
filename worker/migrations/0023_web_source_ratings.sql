-- T68（confirm_audit_design_2026-11-21 §1.5）：網頁來源的 AI 評級。只增加；之後所有股票、所有執行共用，不會自動重評。
-- 查級別的順序：排除列表（程式裡的 WEB_EXCLUDED）→ 種子（程式裡的 WEB_SOURCES，不寫進這張表）→ 這張表 → 都沒有是 UNRATED。
--   domain     主鍵，小寫、去掉 www.（子網域各自一列）
--   tier       PRIMARY 一手／NAMED 產業研究機構／MEDIA 媒體／LEAD 只當線索／EXCLUDE 之後不抓
--   site_name  Worker 取的網站名稱（og:site_name 或 <title>，最多 60 字）；來源評級只看網域與它，不看內文
--   reason     來源評級的一句理由（100 字以內）
--   run_id     哪一次執行評的（ai_runs.run_id）
--   rated_at   寫入時間（ISO）
CREATE TABLE IF NOT EXISTS web_source_ratings (
  domain TEXT PRIMARY KEY,
  tier TEXT NOT NULL CHECK (tier IN ('PRIMARY', 'NAMED', 'MEDIA', 'LEAD', 'EXCLUDE')),
  site_name TEXT,
  reason TEXT,
  run_id TEXT,
  rated_at TEXT NOT NULL
);

-- web_docs.site_name：抓的時候取的網站名稱（給 GET /ai/task/<id>/unrated）；之前的列是 NULL。
-- web_docs.tier 從這一版起是抓的那一刻的級別（PRIMARY／NAMED／MEDIA／LEAD／UNRATED），不在種子的也有值。
ALTER TABLE web_docs ADD COLUMN site_name TEXT;
