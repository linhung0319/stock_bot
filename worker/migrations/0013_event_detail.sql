-- T28（own_thesis §2.2）：事件的細項（固定列舉；規則與每日掃描寫同一組值）。
-- code 放類別、sub 照舊放「誰標的＋哪一項」（規則：8K_2.06、8K_5.02_CEO_DEPART；掃描：SCAN_<類別>）、detail 是給人讀的說明。
-- 細項：MGMT_CHANGE 的 CEO_DEPART／CFO_DEPART／EXEC_APPOINT／OTHER_EXEC／DIRECTOR、GUIDANCE_CUT 的 CUT／WITHDRAWN、
--       RESTRUCTURING 的 IMPAIRMENT／EXIT_PLAN、MAJOR_CONTRACT 的 TERMINATION／NEW、DISTRESS 的 BANKRUPTCY／ACCELERATION／DELISTING_NOTICE、
--       CYBER 的 INCIDENT、ACTIVIST 的 SC_13D；CONDITION_HINT 放條件的列編號（own_conditions.id）。
-- sec_events 是市場資料，上線後會留著：舊列沒有細項（NULL），讀的地方當成「沒有細項」（不可提前審查）。
ALTER TABLE sec_events ADD COLUMN detail_code TEXT;
