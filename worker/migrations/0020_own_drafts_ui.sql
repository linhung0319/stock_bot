-- T56（web_evidence_design §2.3、§2.5）：草稿的畫面與同意流程。帳戶與 AI 的表，不用寫舊資料的轉換（讀到空的當成沒有）。
--   pushed_at  使用者按的草稿（trigger = MANUAL）回來或失敗時推 LINE 一行：推出去（或開始推）的時間；SYNC = 按下去當場就失敗、
--              網站已經寫了原因，不另外推。自動開的不推（月報的「要看的事」會算到），一直是 NULL
--   used_json  存檔用了這份草稿的哪些（status 改成 USED 時寫）：{ version, thesis, premises: { same, edited }, exits, peers, domains, unused }
-- 「還在跑的不重開」要原子：同一檔同時最多一列 PENDING（兩個分頁同時按、或按的時候自動的那一次剛好在開，第二個 INSERT 會失敗）
ALTER TABLE own_drafts ADD COLUMN pushed_at TEXT;
ALTER TABLE own_drafts ADD COLUMN used_json TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS own_drafts_one_pending ON own_drafts (ticker) WHERE status = 'PENDING';
