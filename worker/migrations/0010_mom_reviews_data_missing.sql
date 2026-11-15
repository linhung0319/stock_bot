-- T32a（momentum_ai §3.3 表第 6 列）：申報抓不到、這次沒有檢查申報類失效模式的審查。
-- 舊列沒有這個欄位時當成 0。T32b 會再加 §3.10 的其他欄位。
ALTER TABLE mom_reviews ADD COLUMN data_missing INTEGER DEFAULT 0;
