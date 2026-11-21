-- T63（composite_layer_design §3）：「新眼光」找到的前提以外的風險。帳戶與 AI 的表，舊列沒有這一欄（讀成沒有）。
--   new_risks  送回的結果外層的 new_risks，經過程式檢查之後的紀錄：
--              asked     這次的證據包有請新眼光跑（pack.fresh_eyes.run）
--              returned  送回的結果有這個欄位
--              items     每一條：一句、引用（source_id、date、quote）、ok（通過了沒有）、
--                        沒通過的原因 drop（FORMAT 格式不對、EXTRA 超過 3 條、QUOTE 引用沒過逐字檢查、
--                        NOT_GIVEN 引用的不是給新眼光的文件、OVERLAP 和現有前提的字重疊高、DUP 和前面一條重複）
--              只當建議：不影響三票、不影響檔位、不發通知；通過的列進「要看的事」。
--              沒有請新眼光跑的執行、逾時與被退回的執行是 NULL（定期審查每檔 90 天一次的計算只看有回來的）。
ALTER TABLE ai_runs ADD COLUMN new_risks TEXT;
