-- T72（confirm_audit_design_2026-11-21 §5）：「要看的事」觸發的自動草稿。帳戶與 AI 的表，不用寫舊資料的轉換（讀到空的當成沒有）。
--   attn_keys  這一次自動草擬是哪幾件「要看的事」觸發的（JSON 字串陣列，例如 ["PREMISE_NO_DATA:P4","NO_CONSENSUS@2026-11-20_OWN_REVIEW_MU_ab12cd"]；
--              論點滿一年、減半中沒有出場條件帶 @<從哪天起>）。同一份論點檔、同一個鍵只自動開一次（失敗的重試一次）。
--              NULL = 新的自選自動開的那一次（trigger = AUTO）或使用者按的（MANUAL）
ALTER TABLE own_drafts ADD COLUMN attn_keys TEXT;
