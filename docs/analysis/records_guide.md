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
| `data_runs`、`flow_runs`、`alerts` | 資料抓取的結果（不能出訊號、不能換股的次數）、每日流程（FIRST／FINAL／APPLY／MANUAL × 結果）、告警依種類（推出去、已解除、太舊略過、還沒推） |
| `pushes` | LINE 推播依種類的次數與失敗；`never_delivered` = 通知重試之後一直沒推成功的則數 |
| `ai_runs` | AI 執行依功能的結論狀態；`usable_ratio` = 有結論的執行裡，送回的輸出通過檢查（AGREED／SPLIT／INSUFFICIENT／DATA_MISSING）的比例，INVALID、TIMEOUT、NO_RESULT 算沒通過 |
| `ai_votes` | AI 的每一票，格式合格的比例 |
| `ai_tasks` | 雲端任務依種類的結局；`pass_ratio` = done ÷（done ＋ rejected ＋ late）；逾時分「沒有來取證據包」與「取了沒送回」 |
| `ai_rejections` | 被退回（REJECTED）或逾時才送到（LATE）的輸出 |
| `checkpoints` | 月底檢查點（自選定期審查，T31a）：每個月審了幾檔（`reviewed`，有新證據）、跳過幾檔（`skipped`，沒有新證據）、有新證據但沒開成（`not_started`）、`skip_ratio`；`never`／`filing`／`event`／`thesis`／`stale`／`unknown`／`peer`（同業有新的財報新聞稿，T54）／`web_due`（有要上網查的前提或條件、距上次審查滿 25 天，T54）= 開了審查的那幾檔各有幾檔帶這個原因。資料在 `flow_state` 的 `review:checkpoint:<年月>` |
| `crash_reviews` | 崩盤規則的切換與 AI 檢視（T33b）：期間內每一次切換一列（月報訊號日在期間內；重列的那一項不算）——`month`、`direction`（ON 啟動／OFF 解除）、`notif`、`state`（月報那一項現在的檢視狀態：OPINION 有意見、NO_OPINION 沒有意見、PENDING、FAILED、NO_DATA 總經資料不足、OFF）、`kind`（PREVIEW 月報前一天預估、MAKEUP 月報之後補開）、`runs`（這個月份＋方向開了幾次）、`no_conclusion`（沒有結論幾次）、`followups`（03:30 補推幾次）。合計列多一欄 `switches`（切換次數） |
| `mom_entry` | 動能新股進場審查的 F1 法庭（T32d）：每列 `{ item, code, n, note }`——`courts`（期間內開了幾次法庭）、`courts_by_code`（依規則偵測命中的代碼，一次法庭兩個代碼各算一次，新聞標題來的不算）、`vetoes`（新的 AI 否決，不含沿用）、`carried`（沿用上一次的結論；`code` 是沿用的結論）、`no_conclusion`（跑完了但沒有結論）、`late`（月報之後才回來的否決）、`veto_total`（到期間結束累積的否決次數，連續沿用算同一次；跨過 5 的倍數時 `note` 提示看一次否決的紀錄）。資料在 `ai_runs`（`MOM_ENTRY`）與 `mom_reviews`（建立時間在期間內） |
| `premise_origin` | 定期審查（`OWN_REVIEW`，有結論的）的前提結果，依前提的來源分開（T57，設計 `web_evidence_design` §2.4 第 7 點）：`origin` = `USER`（你寫的，含勾了草稿又改字的）／`AI_DRAFT_ACCEPTED`（原樣勾選的草稿）／`SYSTEM_DEFAULT`（系統預設）／`UNKNOWN`（當時的帳戶裡找不到編號與字都相同的前提）；`premise_checks` 是檢查次數（一次審查裡的一條前提算一次，同一條前提每月都會再被檢查）、`holds`／`broken`／`insufficient`（格式合格的票至少 3 張、判斷都一樣）／`split`（票數不到 3 張或判斷不一樣）和各自的比例。來源讀帳戶歷史（`account_history` 審查當時那一版），因為 L2 的證據包把 `AI_DRAFT_ACCEPTED` 遮成 `USER`。草稿的前提 ≥ 90% 判成立（至少 5 次）而你寫的比它低時，`note` 提示出題可能偏鬆。合計列的 `reviews` 是不重複的審查次數。T61 起多一欄 `stale`：這幾次檢查裡，至少有一票「判成立但正面的引用比驗證頻率還舊（逾期）」被程式改成證據不足的次數（那一票已經算在 `insufficient` 或 `split` 裡；信念不進審查，不在這張表） |
| `premise_prompt` | 前提的判定，依功能（`OWN_REVIEW` 定期審查、`OWN_DROP` 減半檢視）與 prompt 版本分開（T61，設計 `composite_layer_design` §2.1：判「成立」要有正面的引用，`own_review_v4`／`own_drop_v4` 起）。用來對照收緊前後：`runs` 有結論的執行、`premise_checks`（一次執行裡的一條前提算一次）、`holds`／`broken`／`insufficient`／`split`（算法同 `premise_origin`）、`holds_ratio`、`insufficient_ratio`；`stale` = 至少一票因為逾期被改成證據不足的檢查次數，`no_confirm` = 至少一票因為沒指出通過檢查的正面引用（`confirm_ids`）被改成證據不足的檢查次數（這個數字高表示 AI 沒照新格式寫）。每一票被改的原因存在 `ai_runs.outcome.samples[].premises[].holdsIssue`（`why` = `STALE` 帶 `latest`、`days`，或 `NO_CONFIRM`） |
| `web_runs` | 每次執行取回多少（T57；依功能 `OWN_REVIEW`／`OWN_DROP`／`OWN_DRAFT`／`MARKET_BRIEF`（T64 起），資料在 `ai_runs.added_docs`、`doc_ctx`、`lookups`）：`off` 不能取文件、`not_looking` 可以取但分析師沒有要找、`looked` 呼叫過端點、`got_none` 想取但一份都沒取到、`got_some`；`calls`、`docs`（`web_docs`／`filing_docs`）、`chars`、`truncated_docs`、`avg_docs`／`avg_chars`（每次呼叫過端點的執行）、`max_docs`／`max_chars`（上限 8 份、60,000 字）、`sites_at_cap`（同一個網站抓滿 4 篇）、`refused`；`lookups_reported`、`questions`、`queries`、`wanted` 是分析師自己回報的找資料紀錄（AI 寫的，只當參考，取到幾份以 `docs` 為準） |
| `web_refused` | 取文件被拒絕的原因（T57；依功能與原因 `NOT_LISTED`／`BLOCKED`／`THIN`／`UNSUPPORTED`／`NO_DATE`／`TOO_OLD`／`LIMIT`／`ERROR`）。`ai_runs.added_docs.refused` 每次執行只留前 60 筆，超過的合成 `OVER_CAP` 一列，所以每個功能的列加起來等於 `web_runs.refused` |
| `web_skipped` | 被略過最多的網域（T57；`web_docs` 的 `NOT_LISTED`：分析師要了、但不在共用清單也不在這檔的 `domains`）：最近 90 天（到期間迄日為止，不跟 `--report-from`）、前 20 個、合計列算全部；`excluded` 評論與社群網站（不列入）、`path` 網域在清單內但路徑不收、`not_listed` 完全不在清單、`tickers`、`last_title`。要不要加進清單的依據（設計 §1.3） |
| `web_failed` | 抓取失敗的網域（T57；`web_docs`，清單內，同樣最近 90 天、前 20 個、有失敗的才列，合計列算全部）：`attempts` 實際抓過幾次、`ok`、`failed` = `thin` 內文太短 ＋ `blocked` ＋ `unsupported` ＋ `no_date` ＋ `error`；`too_old` 發布日太舊（程式規則擋的，不算失敗）；`fail_ratio`、`thin_avg_chars`（內文太短的平均字數，看 1,500 字的門檻對韓文、中文是否太嚴）、`last_error` |
| `drafts` | 論點草稿（T57；`own_drafts`，依 `AUTO` 新自選自動開的／`MANUAL` 使用者按的）：各狀態次數、`finished`（不含還在跑）、`ok`（通過程式檢查 = ready ＋ used ＋ dismissed ＋ expired）、`success_ratio` = ok ÷ finished、`used_ratio` = used ÷ ok、`avg_minutes`；存檔用了的草稿（`used_json`）：`premises_same` 原樣勾選、`premises_edited` 勾了又改字、`premises_kept`、`premises_unused`、`premises_taken_ratio`、`exits_used`／`exits_unused` |
| `draft_failures` | 草稿失敗的原因（T57；依觸發與 `own_drafts.error` 第一個冒號或括號之前的字） |
| `db_size` | 資料庫大小（T65，設計 `composite_layer_design` §4.1）：**現在的大小，不看期間**，一行——`bytes`（D1 查詢的 `meta.size_after`）、`mb`（÷ 1,000,000，和 `wrangler d1 info` 一樣）、`alert_mb`（300，超過時每日流程推 `DB_SIZE` 告警，每 30 天一次；上次推的時間記在 `flow_state` 的 `db:sizeAlerted`）、`free_limit_mb`（D1 免費方案上限 500）、`used_ratio`、`over_alert`。這一段沒有合計列 |

每段最後一列的第一欄是「合計」（`web_skipped`、`web_failed` 的合計列是「合計（全部網域）」）；比例是 0～1 的小數、分母是 0 時是 null。

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
  thesis/<代號>/                  在 repo 用 Claude Code 討論論點時的討論包（pack.md）與收尾的區塊（block.md）；`scripts/thesis.py`、`/thesis`（計畫 T48，設計 own_thesis §1.14）。不是匯出的紀錄，匯出腳本不動它
```

## 3. 要傳哪些（盤點）

「只增加」的表用 rowid 增量拉；「會改」的表每次整張重拉（資料量小，或必須拿最新狀態）。

### AI 的判斷

| 表 | 內容 | 拉法 | 分析用途 |
|---|---|---|---|
| `ai_runs` | 每次 AI 分析：`fn`（功能代號）、`ticker`、`as_of`（決策日）、`prompt_version`、`repo_commit`（雲端排程跑的 commit，T13 起）、證據包 `pack`、結論 `outcome`、過程 `process`、`applied_at`；T52 起另有 `doc_ctx`（證據包的目錄 `menu`、網頁發布日下限 `notBefore`、這檔的一手網域；`off` 是不能取文件的原因）、`added_docs`（分析師向取文件端點要的：取回的文件 `docs`——給 AI 的原文，表決時和證據包一起比對引用——、被拒絕的 `refused` 與原因、呼叫次數 `calls`、合計字數 `chars`）、`added_hash`（取回的文件的雜湊；`pack_hash` 仍是程式準備的那一份）；T53 起 `added_docs.docs` 的網頁多 `domain`、`label`（對到清單上的哪個來源），另有 `lookups`（分析師自己回報的找資料紀錄：`questions` 要查的問題、`queries` 搜尋的字、`wanted` 想取的每一份與結果；只是 AI 寫的紀錄，取到幾份以 `added_docs` 為準）；T63 起定期審查與減半檢視的 `pack` 多 `fresh_eyes`（這次跑不跑「新眼光」與原因，設計 `composite_layer_design` §3），另有 `new_risks`（新眼光列的前提以外的風險，程式檢查後的紀錄：`asked`、`returned`、`items` 每條一句加一個引用、`ok` 通過了沒有、沒通過的原因 `drop` = `FORMAT`／`EXTRA`／`QUOTE`／`NOT_GIVEN`／`OVERLAP`／`DUP`；只當建議，和 `outcome` 無關；沒請它跑、逾時、被退回的是空的），`doc_ctx.fresh` 是分析師替它留的取文件額度，`added_docs.docs[].role` 是「新眼光」的那一份是它指定的。`pack` 存的是程式準備的那一份，不含取回的文件 | 會改（PENDING → DONE） | 主角。判斷 vs 之後的價格；不同 prompt 版本比較；哪些證據讓結論翻轉 |
| `ai_tasks` | 雲端任務的交換紀錄：狀態（DONE／REJECTED／TIMEOUT／FIRE_FAILED）、錯誤（前 500 字）、雲端 session 網址、各階段時間、通過外層檢查的原始輸出 `result`（每一票原文） | 會改 | AI 失敗率、耗時。`evidence` 欄和 `ai_runs.pack` 重複，不匯出 |
| `ai_rejections` | 整份被退回（`REJECTED`）或逾時才送到（`LATE`）的原始輸出 `raw`（最多 256 KiB，超過的 `truncated = 1`、`raw_bytes` 記原本大小）、完整原因、回給雲端排程的 HTTP 狀態（T13 起） | 只增加 | 哪一種輸出常被檢查擋下、是 prompt 寫得不清楚還是格式出錯 |
| `mom_reviews` | F1 否決法庭：每月每檔的 ALLOW／VETO／BLOCK、理由碼、由誰遞補；`data_missing = 1` 是申報抓不到、這次沒有檢查申報類失效模式（T32a） | 會改 | 被否決的股票事後表現 vs 遞補的股票 |
| `own_conditions` | 自選股的條件：方向、種類、狀態與成立日；`file_id` 是屬於哪一份論點檔（T25 起）。T26 起審查只寫建議（`status = PROPOSED`），你勾選才監測：`accepted_at` 有值就是你定的條件、`action` 是成立時做什麼（出清／減半／重新審查）、`supersedes` 是取代的那一列、`met_basis` 是怎麼確認成立的（`XBRL`／`PRESS` 財報新聞稿擷取（T29c）／`FILING_VOTE`／`REVIEW_VOTE`／`WEB_VOTE` 審查三票依條件指名的網頁來源（T53；`check_json.confirm_by` 有 `web:<網域>` 的條件））、`verified_at` 是 `PRESS` 成立的條件在 10-Q／10-K 出來後核對的時間（核對結果寫在 `note`）、`progress_json` 是財報類條件最近一次比對的進度（`basis` 是 `XBRL` 或 `PRESS`）；撤下是 `RETIRED`、沒勾的建議過期是 `EXPIRED` | 會改 | 條件成立後股價怎麼走；哪種條件有用；AI 建議的條件你勾了多少 |
| `own_thesis_log` | 自選股論點檔的歷史（T25 起）：`kind` = `OPEN`（開檔：怎麼加入、前提、開檔時的慢規則狀態與距高點跌幅；T40 起有寫的話帶 `buyNote` 買進時的一句話）／`CLOSE`（結案原因）／`PRESS_CHECK`（T29c：財報新聞稿成立的條件，10-Q／10-K 核對不一致，`body` 有兩邊的數字）；之後加論點的每一版（`THESIS`；T40 起 `exitLines` 只放送去改寫的新出場條件，沿用與撤下的條件編號在 `exitKept`、`exitRetired`；T42 起出場條件整組取代：`exitsChanged` 標有沒有改動，有改動時 `exitLines`／`exitActions` 是那一版要的全部出場條件、`exitsLive` 是存檔時監測中的條件編號、`exitSame` 是文字相同的，`silenceEnded` 是字改了而結束靜默期的前提）、失效通知、你的回應、條件的勾選（`CONDITION`；T42 起確認時沒被提到而撤下的帶 `reason: NOT_IN_EXITS`）、出場條件改寫結果的確認（`EXITS_CONFIRMED`，T42：哪一版、開始監測與撤下的條件編號）、新眼光提到的前提以外的風險你怎麼處理（`RISK_SEEN`，T63：`body` 有那一句、哪一次執行的第幾條、`outcome` = `DISMISSED` 看過不加／`ADOPTED` 帶進論點存了檔；180 天內同一件事不再列）。`file_id` = `<代號>@<開檔日>`，`body` 是 JSON；復原快照時那一版寫的列會被刪掉（本機已拉的不會跟著刪，用 `account_version` 對 `account_history.rev`） | 只增加 | 論點從開檔到結案怎麼變；失效通知後你怎麼回應 |
| `own_drafts` | stock bot 的論點草稿（T55，設計 `web_evidence_design` §2.2～§2.5）：每次草擬一列，`run_id` 對到 `ai_runs`（`fn = OWN_DRAFT`）；`trigger` = `AUTO`（新的自選自動開的，每份論點檔一次、失敗時重試一次）／`MANUAL`（使用者按的）；`status` = `PENDING` 還在跑／`READY` 等你看／`USED` 存檔用過／`DISMISSED` 不用／`EXPIRED`（30 天沒處理或有新的草稿）／`FAILED`（退回、逾時、沒觸發成；原因在 `error`）；`payload` 是程式檢查過的草稿（論點、前提與 `breaks_if`／`checkable_by`／`keep_id`（T60 起前提是 `confirms_if`、`breaks_if` 1～3 句的陣列、`verify` = `{ by, source, every }`，`by` = `NONE` 是信念；T60 之前的列是舊的形狀）、出場條件與財報門檻、來源、反方三點、今天會不會買、監測不了的觀察、通過檢查的引用）；`based_on_version` 是照第幾版論點寫的；`broken` 是開的時候還沒回覆的乙類通知（被判不成立的前提，草稿不能沿用它）；T56 加 `used_json`（存檔時用了哪些：論點、前提原樣幾條／改過字幾條、出場條件、同業與網站、沒勾的幾條；匯出時是 JSON 字串，同一份也在 `own_thesis_log` 那一版 `THESIS` 的 `body.draft`）與 `pushed_at`（使用者按的草稿回來或失敗時推 LINE 的時間；`SYNC` = 按下去當場就失敗、沒有另外推） | 會改 | 草稿的成功率與失敗原因；草稿的前提你勾了多少、之後審查判得怎樣（對 `own_thesis_log` 的論點與 `ai_runs` 的審查） |
| `market_briefs` | 市場摘要（T64，設計 `composite_layer_design` 第 1 章）：每次開一列，`run_id` 對到 `ai_runs`（`fn = MARKET_BRIEF`）；`event_id` 是哪個事件（`market_triggers.event_id`；手動開的是 `manual-<訊號日>`、`manual = 1`）；`stage` = `PROVISIONAL` 暫定稿（10 個交易日內最多 1 份）／`FINAL` 定稿（事件最後一次觸發之後第 10 個交易日）；`session` 決策日、`period_from`／`period_to` 涵蓋的期間、`why` 這次為什麼開；`status` = `PENDING` 還在跑／`READY` 寫好了（原因不明也算）／`FAILED`（退回、逾時、沒觸發成、程式檢查沒過，原因在 `error`）。`payload` 是程式檢查過的摘要：`period`、`stage`、`facts`（程式給的數字原樣）、`causes`（`scope` = `MARKET`／`GROUP`、`group` 產業 ETF、`kind`、`text` 報導的說法、`confidence`、`evidence_ids`、`headline_only` 引用只有新聞標題、`lowered` 信心被程式調低的原因）、`unknown`（原因不明）、`clarity`、`changed_since_provisional`、`groups`、`core`、`evidence`（引用的原文片段與出處）、`dropped`（被程式拿掉的與原因）、`notes`、`report`。只說明：不產生通知、不動帳戶。T65 起分給個股：自選的定期審查、提前審查、減半檢視、草稿的證據包多一份 `source_id` = `brief:<訊號日>` 的 note（最近 30 天內、有定稿用定稿、只放大盤與那一檔產業 ETF 的部分、手動開的不算；不能當引用）；首頁最近 10 個交易日內有摘要時顯示一行；當天的 LINE 通知加一行「市場摘要：…」 | 會改 | 大漲跌之後報導怎麼說、暫定稿和定稿差多少、原因不明的比例；個股審查當時有什麼背景可讀 |
| `sec_events` | 申報與新聞事件的分類（規則或 AI）、處理狀態；`detail_code` 是細項（T28 起：`CEO_DEPART`、`IMPAIRMENT`、`BANKRUPTCY`…，條件提示 `CONDITION_HINT` 放條件的列編號；之前的列是空的） | 會改 | 事件分類準不準；硬事件後的報酬；規則與每日掃描各標到什麼 |
| `macro_snapshots` | F5／F6 月報前抓的總經數字 | 會改（每月一列） | 崩盤規則檢視當時的背景 |

### 你的選擇與帳戶

| 表 | 內容 | 拉法 | 分析用途 |
|---|---|---|---|
| `notifications` | 每則通知（`body` 是完整 JSON：項目、選項、清單、你的回覆、狀態） | 會改 | 系統建議了什麼、你選了哪個選項 |
| `shadow_records` | 沒照做的紀錄：照規則、照 AI、實際的股數變動、當時價格、你的選擇與理由。崩盤項目（F5／F6）每一次切換、每一檔都記（T33b） | 只增加（例外：崩盤規則檢視在你回覆之後才回來時，那則通知的 F5／F6 紀錄 `ai` 由 null 補上、`note` 後面加「（AI 檢視在回覆之後才回來）」） | **照做與沒照做的後果**：把三種股數乘上之後的價格 |
| `ledger_events` | 帳本事件：交易、轉桶、入金出金、股利、手動交易的分類與理由；拆股與合股（`kind` = `SPLIT`，`shares` 是多出或少掉的股數，T39c）。復原快照時那一版的事件會刪掉，拆股那一行例外 | 只增加 | 實際做了什麼、錢怎麼流 |
| `snapshots` | 你填的每份快照（每檔股數＋現金） | 只增加 | 真實持股的時間序列 |
| `account_state` | 目前帳戶（不含通知、帳本、影子紀錄） | 會改（一列） | 目前狀態、設定 |
| `account_history` | 每次存檔的帳戶全貌與原因 | 只增加 | 重建任何一天的規則狀態（慢規則、崩盤、波動度比例） |

### 市場資料（判斷事後準不準要用）

| 表 | 內容 | 拉法 | 分析用途 |
|---|---|---|---|
| `price_series` | 每檔約兩年的日 K（只還原拆股的收盤、還原權值收盤、成交量；`bars` = `{d, c, a, v}`）。拆股生效後重抓時整段換成拆股後的數字（T39c） | 會改（每天覆蓋） | 算任何判斷之後 5／20／60 日的報酬 |
| `rankings` | 每個交易日的動能排名與股票池明細 | 只增加 | 動能選股、遞補的事後比較 |
| `constituents` | 每天的成分股名單與兩份來源是否一致 | 只增加 | 資料品質、成分股變動 |
| `calendar_overrides` | 手動修正的休市日 | 會改 | 交易日對齊 |
| `splits` | Yahoo 日線回應裡的拆股與合股（代號、生效日、`numerator`／`denominator`：1 拆 10 是 10／1；T39c） | 只增加 | 對照帳本的拆股那一行；比較存下來的股價與當時的通知、快照股數時換算 |
| `market_triggers` | 市場摘要的觸發紀錄（T64，設計 `composite_layer_design` §1.2；規則判斷，不靠 AI）：一個訊號日一種觸發一列——`kind` = `MARKET_DAY`（核心 ETF 單日漲跌 ≥ 2.5%）／`GROUP_DAY`（持股的產業 ETF 單日比大盤多漲跌 ≥ 3 個百分點，`grp` 是那個 ETF）／`CUMULATIVE`（核心 ETF 21 個交易日跌 ≥ 10%、這段期間還沒有開過摘要）／`AI_RUN`（當天有減半檢視或提前審查、最近 5 個交易日沒有摘要）；`event_id` 歸到哪個事件（每一次觸發都在前一次之後 10 個交易日內，編號是第一次觸發的訊號日）；`value` 觸發的數字、`detail` 白話的一句。被頻率上限擋下、沒有另外開摘要的觸發也記 | 只增加 | 門檻一年觸發幾次（對照設計 §5.2 的估計）；哪些觸發併進同一個事件 |
| `web_docs` | Worker 抓的網頁快照（T51，設計 `web_evidence_design` §1.4）：每一次要抓（含被拒絕的）一列；`id` = `web:<網址雜湊>` 是證據包的 `source_id`（同一個網址為兩檔各抓一次時各一列，`row_id` 才是唯一的）；`domain`／`tier`（`PRIMARY`／`NAMED`／`MEDIA`）、`via`（`MENU`／`SEARCH`／`MANUAL`）、`ref` 是哪一次執行要的；`published` 與 `published_from`（`meta`／`json-ld`／`time`／`text` 標題下面那一行／`rss`）、`date_conflict`；`status`（`OK`／`THIN`／`BLOCKED`／`UNSUPPORTED`／`NOT_LISTED`／`NO_DATE`／`TOO_OLD`／`ERROR`）與 `error`；`text` 只有 `OK` 存（最多 30,000 字，`truncated`）；`used_by` 是第一次放進證據包的執行。市場摘要（T64）的研究員取的網頁不屬於任何一檔，`ticker` 記成 `_MARKET`；`published_from` 另有 `release-line`（官方新聞稿開頭的發布時間那一行）與 `url`（網址裡的日期），只用在清單上寫了擷取方式的官方來源（聯準會、勞工統計局）。沒被用過的 180 天後在 D1 清掉 `text`，本機已拉的列不跟著清 | 只增加 | 分析師要了哪些來源、哪些網域常被擋或不在清單；審查引用的網頁原文 |

### 系統運作（T16 統計也用）

| 表 | 內容 | 拉法 |
|---|---|---|
| `data_runs` | 每次抓資料：OK／DEGRADED／FAILED、能不能出訊號與換股、耗時 | 只增加 |
| `flow_runs` | 每次每日流程：FIRST（23:30）／FINAL（01:30）／APPLY（03:30，只套用與推播，狀態一律 SKIPPED）／MANUAL、DONE／ERROR…、處理了哪幾天 | 只增加 |
| `pushes` | 每次 LINE 推播與結果（`kind`：NOTIF 通知、ALERT 告警、TEST 測試、REPLY 關鍵字回覆、FOLLOWUP 通知推出去之後才回來的 AI 結果補推的一行（T31b；`ref` 是那則通知的編號）；REPLY 不算推播額度） | 只增加 |
| `alerts` | 告警與推播時間 | 會改 |
| `flow_state` | 流程進度（最後處理到的交易日、上線日…）；T31a 起另有 `review:checkpoint:<年月>`（月底檢查點審了誰、跳過誰、原因）、`review:fails:<代號>`（自選審查連續沒有結論的次數與每次的原因）、`review:splits:<代號>`（連續票數不一致的次數）；T31b 起另有 `push:held`（上面有還在等的 AI 結果、留到下一次流程才推 LINE 的通知編號） | 會改 |

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
- **市場摘要**：`market_briefs.run_id` → `ai_runs.run_id`（`fn = MARKET_BRIEF`；研究員取回的文件在那一列的 `added_docs`）；`market_briefs.event_id` → `market_triggers.event_id`（這個事件的每一次觸發）。同一個事件可以有不只一份暫定稿（事件拖過 10 個交易日又觸發時）與一份定稿。
- **論點草稿**：`own_drafts.run_id` → `ai_runs.run_id`（`fn = OWN_DRAFT`；研究員取回的文件在那一列的 `added_docs`）；`own_drafts.file_id` → `own_thesis_log.file_id`。
- **F24／F25**：`own_conditions.run_id` → 寫下條件的那次 `ai_runs`（`fn = OWN_REVIEW`）；條件成立時的判斷是另一筆 `fn = OWN_CONDITION`。
- **通知 → 帳本**：`ledger_events.notif`、`shadow_records.body.notif` → `notifications.id`。
- **被作廢的回覆**：影子紀錄裡 `f = 'REOPEN'` 是「改決定」的作廢記號，它之前同一則通知的紀錄不算（網站用 `liveShadow()` 濾掉，分析時照同樣的規則）。
- **上線日**：`manifest.json` 的 `launch_date`（T17 寫進 `flow_state`）。之前的資料只在 `pre-launch/`。

功能代號對照（`ai_runs.fn`）：`OWN_REVIEW`（F24）、`OWN_CONDITION`（F25）、`OWN_CHECK`（F14 出場條件改寫；T27 之前叫新增自選健檢）、`OWN_DROP`（F7）、`OWN_EARNINGS`（財報新聞稿當天確認財報類條件，T29c 起）、`DROP_EXPLAIN`（F20；T32d 起不再開）、`MOM_ENTRY`／`MOM_SCORE`（F1；`MOM_SCORE` 擬事件打分 T32d 起不再開）、`HARD_EVENT`（F19）、`EVENT_SCAN`（F18）、`CRASH_REVIEW`（F5／F6）、`STRATEGY_REVIEW`（F21）、`OWN_DRAFT`（論點草稿，T55 起；結果另外在 `own_drafts`）、`MARKET_BRIEF`（市場摘要，T64 起；一份、只說明，沒有 `ticker`；結果另外在 `market_briefs`）。prompt 檔在 `ai/prompts/<prompt_version>.md`；同一個版本號的內容如果改過，用 `meta.json` 的 `repo_commit` 回 git 找當時的檔案（`git show <commit>:ai/prompts/<prompt_version>.md`）。`repo_commit` 是雲端排程在 clone 下來的 repo 跑 `git rev-parse HEAD` 回報的（`ai/prompts/run.md` 第 1 步）；沒回報或格式不像 commit 的存 null。

## 5. 範例分析問題

- F24 給 HOLD／HALF／EXIT 的股票，之後 20、60 天的報酬各是多少？和同期 VOO 比？
- F1 否決的股票 vs 遞補上來的股票，持有一個月的報酬差多少？
- 我沒照做的那些單（`shadow_records`），如果照做，到今天差多少錢？依功能分開看。
- 三票不一致的判斷，事後準確率是不是比一致的低？
- 哪一種輸出最常被檢查擋下（`ai_rejections` 的 `reason` 與原文）？是 prompt 寫得不清楚還是資料不夠？
- 每日流程漏跑或失敗是否集中在某個時段、某個資料來源？

分析的結論如果要改規則或 prompt：照實作計畫的工作規則，改已決定的設計要先和使用者確認；改 prompt 要升版號（`*_v2.md`），舊版保留，才能比較前後。
