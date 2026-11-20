-- T51（web_evidence_design §1.4）：Worker 抓的網頁快照。市場資料類，只增加，上線後留著。
-- 每一次要抓（含被拒絕的）各記一列；同一檔同一個網址最多一列有全文的 OK（之後要了直接用那一列，不重抓）。
--   id              web:<網址（去掉 # 與 utm_ 參數）的 SHA-256 前 16 碼>，也是證據包的 source_id。同一個網址為兩檔各抓一次時各存一列，所以 id 不是唯一的
--   domain / tier   對到的清單網域與級別（PRIMARY／NAMED／MEDIA）；不在清單的是 NULL
--   via             MENU 從目錄挑的／SEARCH 分析師找到的網址／MANUAL 使用者貼的（第二階段）
--   ref             哪一次執行要的（ai_runs.run_id）
--   premise_id / cond_id  分析師說它和哪一條有關（只是線索，可以是空的）
--   published       發布日（美東以外的網站照網頁寫的日期）；published_from = meta／json-ld／time／text（標題下面單獨一行的日期）／rss
--   date_conflict   網頁和 RSS 的發布日差超過 3 天（用比較晚的那個）
--   session         抓取時的訊號日（呼叫的人給）
--   status          OK／THIN／BLOCKED（HTTP 4xx、5xx）／UNSUPPORTED／NOT_LISTED／NO_DATE／TOO_OLD／ERROR
--   error           沒抓成的原因（白話；NOT_LISTED 另外寫 EXCLUDED 不列入或 PATH 路徑不收）
--   chars           轉成純文字之後的全文字數（截掉之前）；truncated = 1 是快照只存了開頭 30,000 字
--   text            純文字，只有 OK 的存；沒被任何一次執行用過、抓了超過 180 天的會清成 NULL（列留著）
--   used_by         第一次把它加進證據包的執行（取文件的端點寫入，T52）；有值的永久留著
CREATE TABLE IF NOT EXISTS web_docs (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL,
  url TEXT NOT NULL,
  final_url TEXT,
  domain TEXT,
  tier TEXT,
  ticker TEXT NOT NULL,
  file_id TEXT,
  via TEXT NOT NULL,
  ref TEXT,
  premise_id TEXT,
  cond_id TEXT,
  title TEXT,
  published TEXT,
  published_from TEXT,
  date_conflict INTEGER NOT NULL DEFAULT 0,
  fetched_at TEXT NOT NULL,
  session TEXT,
  status TEXT NOT NULL,
  error TEXT,
  http_status INTEGER,
  chars INTEGER,
  truncated INTEGER NOT NULL DEFAULT 0,
  text_sha256 TEXT,
  text TEXT,
  used_by TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS web_docs_ok ON web_docs (ticker, id) WHERE status = 'OK' AND text IS NOT NULL;
CREATE INDEX IF NOT EXISTS web_docs_ref ON web_docs (ref);
CREATE INDEX IF NOT EXISTS web_docs_domain ON web_docs (domain, status);
