-- T26（own_thesis §1.5、§3.6.2）：條件的所有權。審查不再整組替換條件；AI 只能建議（PROPOSED），使用者勾選才監測。
-- status：PROPOSED 建議中（觀察項，不會自己發通知）／ACTIVE 監測中（你定的）／REVIEW_ONLY 只在審查時檢查（你定的）／
--         MANUAL 只記錄／MET 已成立／RETIRED 你撤下或被取代／EXPIRED 建議中的過期了／REPLACED 舊資料（改版前被整組替換的）
-- 舊列沒有這些欄位時是 NULL，讀的地方當成空的（上線前會清掉帳戶與 AI 的資料，不補資料）。

-- 你勾選的時間：有值就是「你定的條件」，不論文字是誰寫的（origin）。
ALTER TABLE own_conditions ADD COLUMN accepted_at TEXT;
-- 成立時做什麼：EXIT 出清／HALF 減半／REVIEW 重新審查。勾選時定，之後可改。
ALTER TABLE own_conditions ADD COLUMN action TEXT;
-- 對應哪一條前提（可以是空的）。
ALTER TABLE own_conditions ADD COLUMN premise_id TEXT;
-- AI 建議「用這條取代那一條」時，被取代的列編號（own_conditions.id）。
ALTER TABLE own_conditions ADD COLUMN supersedes INTEGER;
-- 成立是怎麼確認的：XBRL／PRESS（財報新聞稿）／FILING_VOTE（申報原文三票）／REVIEW_VOTE（審查三票）。
ALTER TABLE own_conditions ADD COLUMN met_basis TEXT;
-- PRESS 成立的條件，10-Q／10-K 出來後核對的時間（T29c）。
ALTER TABLE own_conditions ADD COLUMN verified_at TEXT;
-- 財報類條件的進度（§3.6.2）：{ at, basis, period, values, level, streak, need }；ACTIVE 與 PROPOSED 每次比對都寫。
ALTER TABLE own_conditions ADD COLUMN progress_json TEXT;
-- 寫入時有沒有通過格式檢查（1 = 勾選後可以自動確認；0 = 勾選後只記錄）。建議中的條件勾選時用它決定狀態。
ALTER TABLE own_conditions ADD COLUMN auto INTEGER;
