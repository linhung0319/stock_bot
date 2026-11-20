-- T52（web_evidence_design §1.2、§1.5）：分析師取文件。帳戶與 AI 的表，舊列沒有這三欄（讀成空的）。
--   doc_ctx     組證據包時記下的「可以取什麼」：目錄（M 開頭，每一項是同業的哪一份申報或 RSS 的哪個網址）、
--               網頁發布日的下限 notBefore（上次有結論的審查前 120 天；沒有上一次時決策日前 365 天）、這檔的一手網域、論點檔編號；
--               off = 不能取的原因（只有系統預設前提的股票）
--   added_docs  這次執行向取文件的端點要了什麼：calls 呼叫幾次、chars 合計字數、docs 取回的文件（給 AI 的那一份原文，
--               表決時 check.ts 比對的原文＝證據包的文件＋這裡的文件）、refused 被拒絕的（含 LIMIT）、sites 每個網站抓了幾篇
--   added_hash  取回的文件的雜湊（原本的 pack_hash 不變，它是程式準備的那一份）
ALTER TABLE ai_runs ADD COLUMN doc_ctx TEXT;
ALTER TABLE ai_runs ADD COLUMN added_docs TEXT;
ALTER TABLE ai_runs ADD COLUMN added_hash TEXT;
