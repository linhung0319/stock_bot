-- T32b（momentum_ai_design_2026-11-15 §3.2～§3.4、§3.10）：動能進場審查的新欄位。舊列沒有這些欄位時當成空的（0、NULL）。
--   evidence_key  這次要法庭判斷的命中的證據指紋（§3.4；新聞標題不算）
--   carried_from  沿用哪一個月份的法庭結論（§3.4）
--   court_tries   這個月開了幾次法庭（§3.2 momRecheck：沒有結論時重開一次）
--   late          月報當天才審的（§3.2「月報當天才進榜的」）
--   late_verdict  月報之後才回來的否決（§3.3；decision 不改，它是月報實際用的）
--   late_told     晚到的否決已經補推過（只推一次）
-- lift_condition 留著不再寫（§3.7）。
ALTER TABLE mom_reviews ADD COLUMN evidence_key TEXT;
ALTER TABLE mom_reviews ADD COLUMN carried_from TEXT;
ALTER TABLE mom_reviews ADD COLUMN court_tries INTEGER DEFAULT 0;
ALTER TABLE mom_reviews ADD COLUMN late INTEGER DEFAULT 0;
ALTER TABLE mom_reviews ADD COLUMN late_verdict TEXT;
ALTER TABLE mom_reviews ADD COLUMN late_told INTEGER DEFAULT 0;
