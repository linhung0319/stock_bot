# 階段八的執行紀錄

> 對應：`thesis_plan_2026-11-15.md` 的階段八。主持的工作階段每驗收完一個任務就更新這份；全部做完後（T38）整理成給使用者的三張清單。
> 這份會進 git，repo 是公開的：不寫帳戶金額、持股股數、金鑰。截圖放 `records/stage8/screens/`（不進 git），這裡只記路徑。

## 進度

| 任務 | 狀態 | commit | 備註 |
|---|---|---|---|
| T16 | 完成 | （見 git log） | 353 通過、1 略過 |
| T36 | 完成 | （見 git log） | 361 通過、1 略過 |
| T24 | 完成 | （見 git log） | 365 通過、1 略過 |

## 執行中做的決定

每一筆：哪個任務、哪裡、選了什麼、為什麼、還有什麼別的選項。T23 定稿時做的 10 項決定在計畫的「T23 定稿時做的決定」，不重複寫在這裡。

- T16｜運作統計的期間：`from`、`to` 含頭尾；預設上線日（`flow_state`）到今天（UTC）；有時間戳的表照 UTC 日期切，通知與影子紀錄用訊號日。別的選項：用台灣時間切。
- T16｜「通過檢查的比例」分三個口徑都列：`ai_runs.usable_ratio`（結論是一致、分歧、證據不足、資料缺漏的比例）、`ai_votes.valid_ratio`（每一票格式合格）、`ai_tasks.pass_ratio`（外層檢查：done ÷ done＋rejected＋late）。別的選項：只給一個數字。
- T16｜「照做／沒照做」分兩段：`choices`（已回覆通知的每個項目，選項和規則比）與 `shadow`（影子紀錄濾掉作廢的，只看沒照做的種類）。`shadow` 整張讀進記憶體再濾（作廢要看順序），單人的量沒問題。
- T36｜01:30 只在這次沒有處理新的交易日時呼叫 `finalStarts`；23:30 失敗、01:30 才處理當天時，當天的執行（含法庭）已在第 3 段全部開過。別的選項：每次都呼叫，但後面加進來的每一種都要自己防重複。
- T36｜01:30 開法庭需要的申報原文：只替有申報類事件的股票抓申報清單，不推 `edgar:` 標記（規則分類沒看過那些申報）。別的選項：抓全部對象，請求多很多。
- T36｜03:30 在 `flow_runs` 記 `attempt = 'APPLY'`、狀態一律 `SKIPPED`（不加新狀態）；不推缺席告警（01:30 推過），但還沒推出去的告警照推。
- T36｜逾時標記之後才送到的結果回 410 `task_expired`（和還沒掃過就逾時一致），每次送都留一列 `LATE`；其他已結束的狀態照舊 409。
- T36｜`run.md`、`ping.md` 直接改原檔、不升版（貼在 claude.ai 上的，列進手動事項）。
- T36｜已知小缺口（沒改，範圍外）：雲端排程超過 45 分鐘才來取證據包時，`readEvidence` 標 TIMEOUT 但沒記 `fetched_at`，原因會寫成「沒有來取證據包」（其實是來得太晚）。
- T24｜只有 `earnings_call`、`major_news` 才算 `REVIEW_ONLY`；事件條件沒寫 `confirm_by` 或混了不認得的來源回 `NONE`（格式檢查本來就會先標成只記錄）。別的選項：不認得的來源也算 `REVIEW_ONLY`。
- T24｜`REVIEW_ONLY` 直接寫進 `own_conditions.status`（沒有 CHECK 約束，不用 migration），T26 的狀態表沿用。
- T24｜「勾選」在 T26 才有，T24 在條件寫入的那一刻判定。
- T24｜截圖用假資料渲染持股頁的條件那一塊（示範模式沒有這一塊），不是整頁；整頁在 T34 截。

## 要使用者親手做的事

照做的順序排。每一筆寫清楚指令或步驟、是哪個任務帶出來的。

- T16｜部署後 `/admin/ops-report` 才有效；之後 `uv run python scripts/export_records.py` 會多存 `records/reports/ops_<日期>.json`。
- T36｜把 `ai/prompts/run.md`、`ai/prompts/ping.md` 的「排程的 prompt」重新貼到 claude.ai 的雲端排程。
- T36｜`wrangler deploy` 之後新的 03:30 cron 才生效。

## 畫面截圖

| 任務 | 畫面 | 路徑 |
|---|---|---|
| T24 | 持股頁的條件那一塊（桌機） | `records/stage8/screens/T24/desktop.png` |
| T24 | 持股頁的條件那一塊（手機） | `records/stage8/screens/T24/phone.png` |

## 卡住的任務

每一筆：任務、沒通過的原因、`git stash` 的名字、哪些任務因為依賴它而沒做。

（沒有）
