-- T53（web_evidence_design §1.5 第 5 點）：分析師自己回報的找資料紀錄。帳戶與 AI 的表，舊列沒有這一欄（讀成沒有回報）。
--   lookups  送回的結果外層的 lookups，經過格式整理：
--            questions 要查的問題（哪一條前提或條件、為什麼現有的文件不夠、要找什麼）、
--            queries   用 WebSearch 搜尋的字、
--            wanted    想取的每一份（目錄編號或網址、和哪一條有關、為什麼、結果：取到的 source_id 或被拒絕的原因）
--            這一欄是 AI 自己寫的，只用來顯示「AI 這次另外找了什麼、為什麼」；
--            實際取到幾份、被拒絕幾份以程式記的 added_docs 為準（0017）。
ALTER TABLE ai_runs ADD COLUMN lookups TEXT;
