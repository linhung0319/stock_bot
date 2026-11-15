# 階段八的執行紀錄

> 對應：`thesis_plan_2026-11-15.md` 的階段八。主持的工作階段每驗收完一個任務就更新這份；全部做完後（T38）整理成給使用者的三張清單。
> 這份會進 git，repo 是公開的：不寫帳戶金額、持股股數、金鑰。截圖放 `records/stage8/screens/`（不進 git），這裡只記路徑。

## 進度

| 任務 | 狀態 | commit | 備註 |
|---|---|---|---|
| T16 | 完成 | （見 git log） | 353 通過、1 略過 |
| T36 | 完成 | （見 git log） | 361 通過、1 略過 |
| T24 | 完成 | （見 git log） | 365 通過、1 略過 |
| T32a | 完成 | （見 git log） | 375 通過、1 略過 |
| T33a | 完成 | （見 git log） | 387 通過、1 略過 |
| T25 | 完成 | （見 git log） | 399 通過、1 略過 |
| T26 | 完成 | （見 git log） | 410 通過、1 略過 |
| T37 | 完成 | （見 git log） | 420 通過、1 略過 |
| T28 | 完成 | （見 git log） | 433 通過、1 略過 |
| T27 | 完成 | （見 git log） | 453 通過、1 略過 |

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
- T32a｜`accOf` 放 `app/filings.ts`（`momEvidence.ts` 是 T32b 才建）；申報用編號格式 （10 位-2 位-6 位數字） 辨認。別的選項：看 `form`。
- T32a｜`NEW` 事件 10 天過期套用到所有硬事件，不限目前持股（免得之後重新持有時把舊事件撈出來再審）。別的選項：只看目前持股。
- T32a｜migration 0010 只加 `data_missing`；§3.10 其他欄位留給 T32b。§3.3 表第 6 列只在第 1～5 列都不成立時用（有程式算的命中照舊開法庭）。
- T32a｜「先套用再出月報」只處理 `MOM_ENTRY`；其他功能照舊由 AI 段套用。
- T32a｜`MOM_DROP` 和其他效果一樣在填快照時才生效，回覆時名單不動。
- T32a｜「不做」的說明沒寫「180 天內不再通知」那半句，等 T32c 的 180 天上限做完再補。
- T32a｜§3.11 月報暫停時，用訊號日的資料試算一次選股（不改帳戶）取得名單、算超額波動存起來；之後即使排除改了名單也用存下來的數字。依波動度減碼沒開的帳戶不記。
- T33a｜每月評語（direction `NONE`）照舊開，拿掉在 T33d（§3.9）。
- T33a｜`DATA_MISSING` 算「跑完了」，和一致、分歧、證據不足一樣不重開（設計沒寫到；崩盤檢視實際上不太會出現）。
- T33a｜沒有結論的 MAKEUP 在之後每天的第一次排程都重開，直到月報被回覆或合計 3 次（§3.12「其他日子」）；01:30 的專門重開與 `CRASH_REVIEW_FAILED` 留給 T33b。
- T33a｜`input.crash` 用 `ma: null` 表示均線算不出來、另記 `bars`；`crashDecision` 比設計多回傳 `ma`。
- T33a｜`CORE_MA_MISSING` 告警在 `flow.processSessions` 產生（引擎維持純函式）；之後在網站上重算不會再告警。
- T33a｜`halfUpTo` 設成選填、預設 0（設計寫必填），免得改既有直接建 `CoreContext` 的測試；實際呼叫點一定給值。
- T33a｜C14 只減合成後的清單，項目本身的選項股數不動；F5 的核心行在最前面，最後才被減到。上限 98%、減到整股。
- T33a｜說明的日期用網站現有的 `12/31 收盤` 寫法，不是設計範例的 `11-30`。
- T25｜`fileId` 型別是選填（設計寫 `string`）：沒有的自選讀 `file_id IS NULL` 的舊列，不丟錯。
- T25｜同一天結案又重開會撞號：加 `#2`、`#3`；為此 `Account` 加 `ownClosed`（每檔最近一次結案的 fileId、原因、日期），`saveAccount` 也靠它知道 CLOSE 的原因。別的選項：不處理撞號（會在邊角重現 N8）。
- T25｜`OwnMeta.opened` 在 `newOwnMeta` 時先算好開檔的狀態與跌幅（`saveAccount` 沒有價格）。
- T25｜CLOSE 原因：移除自選 `REMOVED`、F19 出清 `HARD_EVENT`、F25 出清 `EXIT_CONDITION`、其他照 AI 出清 `EXIT_AI`、快照或分類賣光 `SOLD_OUT`，找不到原因時 `REMOVED`。
- T25｜「有結論的審查」= `OWN_REVIEW` 結論是 `AGREED` 或 `INSUFFICIENT`；「之後」看日期，同一天看事件建立時間或申報接受時間是否晚於那次審查開始。
- T25｜論點那一份 note 在沒有論點本文、沒做過 F24、沒有靜默中的前提時不放（第一次審查的證據包和以前相同）。
- T25｜F24 保留原本的「120 天內最新的 2.02 新聞稿」，和新的 8-K 清單去重、算在 5 份裡；新增的數字一律接在原本的後面。
- T25｜F7 的申報時間範圍不變（上次審查之後，沒有就 45 天），只改挑選順序；只有預設前提的股票 F7 另外抓 XBRL 算 D2、D3。
- T25｜`addPremises` 只有預設前提時照舊取代，但新編號接著 `premiseSeq`（第一條自己的前提是 P4）。
- T25｜D2、D3：最近兩季要相連（差 120 天內），否則資料不足；去年同季是期末差 365 天 ±20 天。
- T25｜`thesisFile` 遇到已結案的檔回 null；看舊論點檔的畫面留給 T34。
- T25｜主持者：`own_thesis` §3.11 歸給 T25 的「只有預設前提的股票 F7 拿掉 HOLD」改到 T31b（T31b 本來就要做「只能選減半或出清」，而且它會改 policy 與題目，和 T25 的完成條件「F7 證據包除了新增的部分不變」衝突）；T31b 的派工單已補一句。
- T26｜`own_conditions` 多加一欄 `auto`（設計沒寫）：建議中的條件要記住寫入時有沒有通過格式檢查，勾選時才知道變 `ACTIVE`、`REVIEW_ONLY` 還是 `MANUAL`。別的選項：從 `note` 文字判斷（脆弱）、沒通過檢查的建議不寫。
- T26｜「三票一致」= `AGREED`，或 `INSUFFICIENT` 而且每一票自己選 HOLD（沿用 `keptByChoice`）；被逐字檢查降級或少送票的算證據不足、不動條件。
- T26｜C、W 對到列編號的對照表放 `pack.rule.detail.conds`；v1 的執行沒有這張表，回來後不動條件（部署當下還在跑的 v1 審查只記檔位，開發階段可以接受）。
- T26｜「你定的條件」= 有 `accepted_at` 或 `origin = USER`（舊的 F14 出場條件也算）。
- T26｜審查確認成立、動作是「重新審查」時只標 MET、寫 log，不開審查（§1.10 甲類當天開審查是 T29a）；通知沿用現有的條件成立通知，文字與上限在 T29a 改。
- T26｜`aiTier.trigger` 沒加（給 §1.9 用，T29a）；`suggest` 只看「有不成立的前提」，拿掉舊規則的「上次的條件成立也算」。
- T26｜勾選不存帳戶，所以 CONDITION 那筆 log 的 `account_version` 是空的，復原快照不會刪它。
- T26｜建議的 `supersedes` 指到另一條建議時，同一次寫入先把舊建議標 EXPIRED；勾選時只取代還在 ACTIVE／REVIEW_ONLY／MANUAL／PROPOSED 的列。
- T26｜建議最多 3 條：`checkOwnReviewPayload` 超過時記一條問題、不作廢那一票，`reviewDecision` 只取前 3 條。
- T37｜頻率用「月」算：設計的 90 天／6 個月／每年寫成每 3／6／12 個月（月報一個月一份，照天數會因月底日期差幾天跳一個月，例如 11/30 到 2/26 只有 88 天）。動能的「每 30 天」T32d 也建議寫成每 1 個月。別的選項：照字面算天數。
- T37｜「同一件事」用 `attnShown` 的鍵代表：一次性的把會變的部分放進鍵（`PROPOSED_CONDS@<最新建議的 run_id>`、`COND_NEAR:<列編號>@<季末日>`），列過一次不再列；定期的用固定鍵加月數。舊的鍵不清。
- T37｜各種的 `since`：建議的寫入日、`progress.at`、開檔日、論點寫的日子加 365 天、最近一則有這檔 F7 的通知日（找不到用開檔日）。
- T37｜論點檔讀不到時月報照出、這個月不列也不記頻率，只寫 `console.error`、不推告警。月報暫停時照樣記 `attnShown`，清單存在暫停那一則的 input。
- T37｜`HALF_NO_EXIT` 的「你定的條件」只算 ACTIVE 與 REVIEW_ONLY；`COND_NEAR` 只看監測中、你定的財報條件，動作照 `action`，沒有就看 `notifyTier`，再沒有寫「重新審查」。
- T37｜示範模式沒有論點檔，月報與持股頁不會出現「要看的事」；要不要讓示範也有留給 T34。
- T28｜Item 編號對照、13D、5.02 讀原文只放在每日掃描的規則段（新函式 `eventHits`、`hits502`），不加進 `quickHits`／`needsCover`（設計這樣寫，但那兩個 F1 也在用，會改到 F1 的證據包）。T32b 要不要也用由那個任務決定。
- T28｜`classify502` 用真實資料調過：拿掉固定標題、節內的「this Item 5.02」與「Item 404(a)」不算下一項、離任字前 100 字有 if／upon／unless 等假設語不算、職稱前有 former／prior 不算、職稱後接「of 別的實體」或事業部不算（副作用：寫成「CEO of 公司全名」的會被略過）、離任字加 `no longer serve`。已知漏判：寫在 8,000 字之後的（Intel 2025-03），交給 Haiku。
- T28｜細項可提前的事件：規則段遇到自選股 → `NEW`，動能與候選 → `INFO`；掃描結果自選股、申報來源、細項是 CEO／CFO 離任、下修、撤回 → `NEW`，新聞 → `INFO`。這些 `NEW` 不開法庭，等 T29b 處理（目前也不會過期）。
- T28｜`CONDITION_HINT` 一條條件寫一筆（`sub` = `SCAN_CONDITION_HINT_<列編號>`），因為 `UNIQUE(ticker, accession, sub)`。
- T28｜`aiStep` 套用前先 `closeStaleRuns`：超過 45 分鐘的執行在同一次流程照規則結束並套用，01:30 才知道 23:30 的掃描沒有結論。影響所有功能（逾時的結論早一次套用）。別的選項：只在重掃那一步判斷，但失敗次數與告警會晚一天。
- T28｜重掃條件：`scan:fails` 最近一次失敗是今天這個交易日、而且今天的掃描執行不到 2 次；重掃另外抓所有對象的申報清單（不推 `edgar:` 標記）。
- T28｜`scan8k` 第一次沒有值時，起點是當時的 `edgar:` 標記，開掃描當下就存起來（存起點不算往前推）。8-K 標記每檔推到第一份沒讀到的之前；新聞推到這次看到的最新一則。
- T28｜失敗次數存在 `flow_state` 的 `scan:fails`；有執行紀錄的在照規則結束、套用時才算一次，免得算兩次。
- T28｜F25 取最新的 8 份，告警寫出沒放進去的那幾份。掃描事件的說明文字仍帶英文代碼（網站事件表補了新代碼的中文），換成白話留給 T34。
- T28｜13D 的表單名稱 `SCHEDULE 13D` 與 `SC 13D` 都收（實際看到新舊兩種寫法），`/A` 與 13G 不記。
- T27｜另加解析端點 `POST ops/own-thesis/parse`，`ops/own-thesis` 也可以只試算（`dry`）：解析與前提對應只有後端一套。別的選項：前端複製一份解析器。
- T27｜THESIS 紀錄多存 `exitActions`（和 `exitLines` 平行），重送時要用使用者選的動作。
- T27｜前提對應：帶 `id` 而且是現行的一條 → 同一條（預覽裡改了字仍沿用編號）；文字不同又沒帶 `id` → 新編號、舊的撤下；系統預設原樣送回時，全部是預設就照舊，混了自己的前提就整組拿掉；原本有自己的前提、送來一條都沒有 → 擋下。
- T27｜論點變動後的審查要改帳戶：加小函式 `patchOwn`（重讀、改、存，撞到重來最多 3 次）；沒開成時 `thesisReviewDue` 留著隔天再試；同一天已有定期審查就不另開。
- T27｜乙類通知在 T29a 才有：目前「還沒回覆的乙類通知」用「還沒回覆、有這檔自選審查建議項目的通知」代替；BREAK 的依據取那一項的審查判不成立的前提與第一票引用的申報原文。
- T27｜§3.8「還沒加回過」= 現在仍是減半，而且開檔之後沒有這檔的加回單。§3.6.3 部位 2 倍那一句預留欄位不計算（T35）。
- T27｜解析：多個區塊取最後一個；沒有編號的行不算但在預覽標出；動作後的句號去掉。
- T27｜示範模式的討論包只用帳戶狀態組、不讀 D1；改寫一律回失敗（示範沒有真的 AI）。
- T27｜舊的 `GET ai/own-check/<執行編號>` 留著（沒有呼叫端，不影響功能）。

## 要使用者親手做的事

照做的順序排。每一筆寫清楚指令或步驟、是哪個任務帶出來的。

- T16｜部署後 `/admin/ops-report` 才有效；之後 `uv run python scripts/export_records.py` 會多存 `records/reports/ops_<日期>.json`。
- T36｜把 `ai/prompts/run.md`、`ai/prompts/ping.md` 的「排程的 prompt」重新貼到 claude.ai 的雲端排程。
- T36｜`wrangler deploy` 之後新的 03:30 cron 才生效。
- T32a｜部署前套用遠端 migration（或照 T17 重建資料庫）：`npx wrangler d1 migrations apply stock-bot --remote`（這次新增 `0010_mom_reviews_data_missing.sql`）。
- T25｜部署前套用遠端 migration（或照 T17 重建資料庫）：新增 `0011_thesis_file.sql`。
- T26｜部署前套用遠端 migration（或照 T17 重建資料庫）：新增 `0012_condition_ownership.sql`。`own_review_v2.md` 由雲端排程從 repo 讀，push 之後生效。
- T28｜部署前套用遠端 migration（或照 T17 重建資料庫）：新增 `0013_event_detail.sql`。`event_scan_v2.md` 由雲端排程從 repo 讀，push 之後生效。
- T27｜`own_check_v2.md` 由雲端排程從 repo 讀，push 之後生效。想在 claude.ai 開專案整理討論的話，步驟在 `worker/SETUP.md` 的 T27 一節（可以不做）。

## 畫面截圖

| 任務 | 畫面 | 路徑 |
|---|---|---|
| T24 | 持股頁的條件那一塊（桌機） | `records/stage8/screens/T24/desktop.png` |
| T24 | 持股頁的條件那一塊（手機） | `records/stage8/screens/T24/phone.png` |
| T26 | 持股頁的條件那一塊：你定的、建議中的、勾選與撤下（桌機） | `records/stage8/screens/T26/desktop.png` |
| T26 | 同上（手機） | `records/stage8/screens/T26/phone.png` |
| T37 | 月報頁的「要看的事」兩段（桌機） | `records/stage8/screens/T37/monthly-desktop.png` |
| T37 | 同上（手機） | `records/stage8/screens/T37/monthly-phone.png` |
| T37 | 持股頁的「要看的事」（桌機） | `records/stage8/screens/T37/holding-desktop.png` |
| T37 | 同上（手機） | `records/stage8/screens/T37/holding-phone.png` |
| T27 | 編輯論點頁：空的（桌機／手機） | `records/stage8/screens/T27/edit-empty-desktop.png、edit-empty-phone.png` |
| T27 | 編輯論點頁：貼回後的預覽（桌機／手機） | `records/stage8/screens/T27/edit-preview-desktop.png、edit-preview-phone.png` |
| T27 | 編輯論點頁：改寫失敗（桌機／手機） | `records/stage8/screens/T27/edit-rewrite-failed-desktop.png、edit-rewrite-failed-phone.png` |
| T27 | 持股頁：論點、編輯論點、複製討論包（桌機／手機） | `records/stage8/screens/T27/holding-desktop.png、holding-phone.png` |

## 卡住的任務

每一筆：任務、沒通過的原因、`git stash` 的名字、哪些任務因為依賴它而沒做。

（沒有）
