# 紀錄匯出與離線分析說明（2026-11-15）

> 用途：把 Worker（Cloudflare D1）裡的紀錄拉到本機，之後在這個 repo 開 Claude Code 直接分析：AI 的判斷事後準不準、照做與沒照做的差別、系統運作是否穩定，再據此優化規則、參數或 prompt。
> 對應：實作計畫 T13（匯出）、T16（運作統計）、T17（正式上線前的完整匯出）。
> **這個 repo 是公開的。`records/` 已列入 `.gitignore`，裡面的東西一律不 commit、不貼到 issue 或其他公開的地方。** 這份說明只寫格式，不放任何實際數字。

## 1. 怎麼拉

```
uv run python scripts/export_records.py            # 增量：只增加的表從上次的位置接著拉，其他表整張重拉
uv run python scripts/export_records.py --full     # 全部重拉
uv run python scripts/export_records.py --out records/pre-launch --full   # T17 清空前的完整保存
```

- 需要 `ADMIN_TOKEN`：先找環境變數 `STOCKBOT_ADMIN_TOKEN`，沒有就讀 `worker/.secrets.json`（不會印出來）。
- Worker 網址取 `worker/wrangler.jsonc` 的 `SITE_URL`，可用 `--url` 覆寫（本機 `wrangler dev` 用 `--url http://127.0.0.1:<port>`）。
- 輸出資料夾在 repo 裡面時，必須被 `.gitignore` 擋掉，否則腳本不寫（`records/` 已經列進去）。
- 每次拉完會重新產生 `ai_runs/`、`prices/` 兩個展開的資料夾（由 `raw/` 算出來，刪掉也能重建）。
- 增量的細節：「只增加」的表從 `manifest.json` 記的最後 rowid 往回 5 列接著拉、用 rowid 去重（`rankings`、`constituents` 是 `INSERT OR REPLACE`，用 `session` 去重，留新的那列）。Worker 的最後 rowid 比上次小（表被清過，例如 T17），或拉完的列數和 Worker 對不上，那張表自動整張重拉。

Worker 端是 `GET /admin/export`（`ADMIN_TOKEN` 的 Bearer；`worker/src/app/export.ts`）：
- 不帶參數：Worker 版本、上線日、每張表的拉法、列數、最後 rowid、合併用的鍵、不匯出的欄位。
- `?table=<表>&after=<rowid>`：rowid 大於 `after` 的列，照 rowid 排；一頁最多該表的列數上限（`price_series` 40 列）或約 4 MB，回 `next_after` 與 `done`。JSON 欄位已經解析。
- 不匯出的表（`probe_runs`、`demo_state`、`snapshot_undo`）與不認得的表回 400。

運作統計是 `GET /admin/ops-report`（同一個 `ADMIN_TOKEN`；`worker/src/app/opsReport.ts`）：`?from=YYYY-MM-DD&to=YYYY-MM-DD`（含頭尾，時間戳欄位照 UTC 日期切、訊號日與決策日照原日期）；沒給 `from` 就從上線日算起（還沒有上線日就從頭），沒給 `to` 就是今天。回傳 `{ generated_at, period, launch_date, sections: [{ id, title, rows }] }`，每一段一個函式，之後的任務加段只要在 `OPS_SECTIONS` 加一個。匯出腳本拉完紀錄後會順便存一份 `records/reports/ops_<今天>.json`（`--report-from`、`--report-to` 可指定期間；同一天再跑會覆蓋；Worker 沒有這個路徑時只警告）。各段：

| `id` | 內容 |
|---|---|
| `notifications` | 通知依種類的次數與處理狀態（待回覆、已回覆、略過、已讀、被取代、取消） |
| `choices` | 照做／沒照做：已回覆的通知裡每一項選的選項 vs 規則的選項（依觸發功能；`same_as_rule`、`took_ai`、`skipped`、`other`） |
| `shadow` | 沒照做的紀錄（`shadow_records`，濾掉被「改決定」作廢的）：手動交易、做錯就這樣、有 AI 建議的、照 AI 的次數。只有「和規則不同或有 AI 建議」的項目才有紀錄，全部項目的比例看 `choices` |
| `data_runs`、`flow_runs`、`alerts` | 資料抓取的結果（不能出訊號、不能換股的次數）、每日流程（FIRST／FINAL／MANUAL × 結果）、告警依種類（推出去、已解除、太舊略過、還沒推） |
| `pushes` | LINE 推播依種類的次數與失敗；`never_delivered` = 通知重試之後一直沒推成功的則數 |
| `ai_runs` | AI 執行依功能的結論狀態；`usable_ratio` = 有結論的執行裡，送回的輸出通過檢查（AGREED／SPLIT／INSUFFICIENT／DATA_MISSING）的比例，INVALID、TIMEOUT、NO_RESULT 算沒通過 |
| `ai_votes` | AI 的每一票，格式合格的比例 |
| `ai_tasks` | 雲端任務依種類的結局；`pass_ratio` = done ÷（done ＋ rejected ＋ late）；逾時分「沒有來取證據包」與「取了沒送回」 |
| `ai_rejections` | 被退回（REJECTED）或逾時才送到（LATE）的輸出 |

每段最後一列的第一欄是「合計」；比例是 0～1 的小數、分母是 0 時是 null。

## 2. 資料夾結構

```
records/                         ← .gitignore，不進 repo
  manifest.json                  每次匯出：時間、Worker 版本、上線日、每張表的列數與最後 rowid、這次怎麼拉的（full／incremental）
  raw/<表名>.jsonl               D1 原樣，一列一行；JSON 欄位已經解析成物件（欄位名稱和 D1 相同）
  ai_runs/<run_id>/              每次 AI 分析一個資料夾（由 raw/ai_runs.jsonl 展開）
    meta.json                      功能、代號、決策日、prompt 版本、repo commit（T13 之前是 null）、狀態、時間、雲端任務的狀態與錯誤
    pack.json                      證據包（AI 當時看得到的全部資料）
    outcome.json                   檢查與表決的結論（每一票、降級、最後的檔位或判斷）
    process.json                   每個角色的完整輸出（分析師、多方、空方、檢方、辯方、法官…）
    rejected.json                  整份被退回或逾時才送到的原始輸出與原因（由 ai_rejections 展開；只有發生過才有）
  prices/<代號>.csv               date, close, adj_close, volume（美東交易日；由 raw/price_series.jsonl 展開）
  reports/ops_<日期>.json         T16 的運作統計（每次匯出存一份）
  pre-launch/                    T17 清空測試紀錄前的完整匯出（同上結構，保留不刪）
```

## 3. 要傳哪些（盤點）

「只增加」的表用 rowid 增量拉；「會改」的表每次整張重拉（資料量小，或必須拿最新狀態）。

### AI 的判斷

| 表 | 內容 | 拉法 | 分析用途 |
|---|---|---|---|
| `ai_runs` | 每次 AI 分析：`fn`（功能代號）、`ticker`、`as_of`（決策日）、`prompt_version`、`repo_commit`（雲端排程跑的 commit，T13 起）、證據包 `pack`、結論 `outcome`、過程 `process`、`applied_at` | 會改（PENDING → DONE） | 主角。判斷 vs 之後的價格；不同 prompt 版本比較；哪些證據讓結論翻轉 |
| `ai_tasks` | 雲端任務的交換紀錄：狀態（DONE／REJECTED／TIMEOUT／FIRE_FAILED）、錯誤（前 500 字）、雲端 session 網址、各階段時間、通過外層檢查的原始輸出 `result`（每一票原文） | 會改 | AI 失敗率、耗時。`evidence` 欄和 `ai_runs.pack` 重複，不匯出 |
| `ai_rejections` | 整份被退回（`REJECTED`）或逾時才送到（`LATE`）的原始輸出 `raw`（最多 256 KiB，超過的 `truncated = 1`、`raw_bytes` 記原本大小）、完整原因、回給雲端排程的 HTTP 狀態（T13 起） | 只增加 | 哪一種輸出常被檢查擋下、是 prompt 寫得不清楚還是格式出錯 |
| `mom_reviews` | F1 否決法庭：每月每檔的 ALLOW／VETO／BLOCK、理由碼、由誰遞補 | 會改 | 被否決的股票事後表現 vs 遞補的股票 |
| `own_conditions` | F24 寫下、F25 監測的條件：方向、種類、成立時的檔位、狀態與成立日 | 會改 | 條件成立後股價怎麼走；哪種條件有用 |
| `sec_events` | 申報與新聞事件的分類（規則或 AI）、處理狀態 | 會改 | 事件分類準不準；硬事件後的報酬 |
| `macro_snapshots` | F5／F6 月報前抓的總經數字 | 會改（每月一列） | 崩盤規則檢視當時的背景 |

### 你的選擇與帳戶

| 表 | 內容 | 拉法 | 分析用途 |
|---|---|---|---|
| `notifications` | 每則通知（`body` 是完整 JSON：項目、選項、清單、你的回覆、狀態） | 會改 | 系統建議了什麼、你選了哪個選項 |
| `shadow_records` | 沒照做的紀錄：照規則、照 AI、實際的股數變動、當時價格、你的選擇與理由 | 只增加 | **照做與沒照做的後果**：把三種股數乘上之後的價格 |
| `ledger_events` | 帳本事件：交易、轉桶、入金出金、股利、手動交易的分類與理由 | 只增加 | 實際做了什麼、錢怎麼流 |
| `snapshots` | 你填的每份快照（每檔股數＋現金） | 只增加 | 真實持股的時間序列 |
| `account_state` | 目前帳戶（不含通知、帳本、影子紀錄） | 會改（一列） | 目前狀態、設定 |
| `account_history` | 每次存檔的帳戶全貌與原因 | 只增加 | 重建任何一天的規則狀態（慢規則、崩盤、波動度比例） |

### 市場資料（判斷事後準不準要用）

| 表 | 內容 | 拉法 | 分析用途 |
|---|---|---|---|
| `price_series` | 每檔約兩年的日 K（未調整收盤、還原收盤、成交量；`bars` = `{d, c, a, v}`） | 會改（每天覆蓋） | 算任何判斷之後 5／20／60 日的報酬 |
| `rankings` | 每個交易日的動能排名與股票池明細 | 只增加 | 動能選股、遞補的事後比較 |
| `constituents` | 每天的成分股名單與兩份來源是否一致 | 只增加 | 資料品質、成分股變動 |
| `calendar_overrides` | 手動修正的休市日 | 會改 | 交易日對齊 |

### 系統運作（T16 統計也用）

| 表 | 內容 | 拉法 |
|---|---|---|
| `data_runs` | 每次抓資料：OK／DEGRADED／FAILED、能不能出訊號與換股、耗時 | 只增加 |
| `flow_runs` | 每次每日流程：FIRST／FINAL／MANUAL、DONE／ERROR…、處理了哪幾天 | 只增加 |
| `pushes` | 每次 LINE 推播與結果（`kind`：NOTIF 通知、ALERT 告警、TEST 測試、REPLY 關鍵字回覆；REPLY 不算推播額度） | 只增加 |
| `alerts` | 告警與推播時間 | 會改 |
| `flow_state` | 流程進度（最後處理到的交易日、上線日…） | 會改 |

### 不傳

- `probe_runs`（T4 的實測）、`demo_state`（示範模式）：和真實帳戶無關。
- `snapshot_undo`：最後一份快照送出前的帳戶，只用來復原（2026-11-15），復原過的快照不會留在任何表裡。
- 金鑰、LINE token：不在 D1，也不會匯出。

## 4. 表之間怎麼接

- **時間**：`as_of`、`date`、`session` 都是**美東的交易日**（`YYYY-MM-DD`）；`*_at` 是 UTC 時間。價格用 `prices/<代號>.csv` 的 `date` 對齊。
- **AI 判斷 → 之後的價格**：`ai_runs.ticker` ＋ `ai_runs.as_of` → `prices/<ticker>.csv` 從 `as_of` 的收盤算起。報酬用 `adj_close`（含股利與分割）。
- **AI 判斷 → 你的選擇**（T13 起；之前的紀錄沒有這些欄位，用 `ticker` ＋ 日期 ＋ 功能代號對）：
  - `notifications.body.items[].runIds`：這一項的 AI 建議或說明來自哪幾次執行。F7／F8（並列的 AI 檔位，來自最近一次 F24 或 F7 減半檢視）、F24／F23 月報建議、F25（確認條件的 F25 ＋ 寫下條件的 F24；財報條件由程式比對時只有 F24）、F19（AI 法庭；規則直接提出的沒有）、F1 進場（那檔的審查）、F5／F6（崩盤規則檢視）。
  - `notifications.body.runIds`：整則通知用到的全部執行，另外包含不屬於任何項目的：被 F1 否決的代號、附在月報的 F20 說明。
  - `notifications.body.monthly.input.runIds`：月報的 AI 輸入 `{ crash, entry: { 代號: run_id }, notes: [...] }`。
  - `shadow_records.body.runIds`：回覆時從那一項抄過來，和 `ai`（照 AI 的股數）是同一次建議。
  - F21 策略檢討的提醒是規則發的，AI 只寫說明、不給建議，所以不帶。F18、F14、擬事件打分不產生通知。
- **被退回的輸出 → 哪次分析**：`ai_rejections.task_id` → `ai_tasks.id` → `ai_runs.task_id`。整份被退回時 `ai_runs.repo_commit` 是 null，原文裡有雲端排程回報的 `repo_commit`。
- **F1**：`mom_reviews.run_id` → `ai_runs.run_id`；`mom_reviews.month` 是月報的月份。
- **F24／F25**：`own_conditions.run_id` → 寫下條件的那次 `ai_runs`（`fn = OWN_REVIEW`）；條件成立時的判斷是另一筆 `fn = OWN_CONDITION`。
- **通知 → 帳本**：`ledger_events.notif`、`shadow_records.body.notif` → `notifications.id`。
- **被作廢的回覆**：影子紀錄裡 `f = 'REOPEN'` 是「改決定」的作廢記號，它之前同一則通知的紀錄不算（網站用 `liveShadow()` 濾掉，分析時照同樣的規則）。
- **上線日**：`manifest.json` 的 `launch_date`（T17 寫進 `flow_state`）。之前的資料只在 `pre-launch/`。

功能代號對照（`ai_runs.fn`）：`OWN_REVIEW`（F24）、`OWN_CONDITION`（F25）、`OWN_CHECK`（F14 健檢）、`OWN_DROP`（F7）、`DROP_EXPLAIN`（F20）、`MOM_ENTRY`／`MOM_SCORE`（F1）、`HARD_EVENT`（F19）、`EVENT_SCAN`（F18）、`CRASH_REVIEW`（F5／F6）、`STRATEGY_REVIEW`（F21）。prompt 檔在 `ai/prompts/<prompt_version>.md`；同一個版本號的內容如果改過，用 `meta.json` 的 `repo_commit` 回 git 找當時的檔案（`git show <commit>:ai/prompts/<prompt_version>.md`）。`repo_commit` 是雲端排程在 clone 下來的 repo 跑 `git rev-parse HEAD` 回報的（`ai/prompts/run.md` 第 1 步）；沒回報或格式不像 commit 的存 null。

## 5. 範例分析問題

- F24 給 HOLD／HALF／EXIT 的股票，之後 20、60 天的報酬各是多少？和同期 VOO 比？
- F1 否決的股票 vs 遞補上來的股票，持有一個月的報酬差多少？
- 我沒照做的那些單（`shadow_records`），如果照做，到今天差多少錢？依功能分開看。
- 三票不一致的判斷，事後準確率是不是比一致的低？
- 哪一種輸出最常被檢查擋下（`ai_rejections` 的 `reason` 與原文）？是 prompt 寫得不清楚還是資料不夠？
- 每日流程漏跑或失敗是否集中在某個時段、某個資料來源？

分析的結論如果要改規則或 prompt：照實作計畫的工作規則，改已決定的設計要先和使用者確認；改 prompt 要升版號（`*_v2.md`），舊版保留，才能比較前後。
