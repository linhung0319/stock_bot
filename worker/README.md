# stock bot worker

Cloudflare Worker：規則引擎（TypeScript，純函式）、排程、網站、LINE 推播。
設計依據：`../docs/design/design_v2_momentum_2026-11-07.md`（系統架構 §2.7）；任務順序：`../docs/plan/implementation_plan_2026-11-11.md`（進度紀錄在 `../docs/plan/progress_log.md`）。

## 需求

- Node 22 以上、npm
- （只有重放驗收需要）uv，以及 `../../Stock/lean_strategies/data-sp500-long` 這份 LEAN 資料

## 常用指令

在 `worker/` 底下執行：

| 指令 | 做什麼 |
|---|---|
| `npm install` | 安裝套件 |
| `npm test` | 跑全部測試（Vitest） |
| `npm run typecheck` | TypeScript 型別檢查 |
| `npm run lint` | ESLint |
| `npm run dev` | 本機開發（`wrangler dev`，不需要 Cloudflare 帳號） |
| `npm run deploy` | 部署（需要先 `npx wrangler login`） |

## 重放驗收（T2）

引擎用回測的輸入逐日重放，結果要和 `../backtest/results/B8_*` 完全相同。

1. 在 repo 根目錄匯出固定檔（約 40 秒，輸出到 `worker/fixtures/replay/`，不進 git）：
   `uv run python worker/scripts/export_replay_data.py`
2. `npm run replay` 印出比對表；`npm test` 也會跑同一組驗收（沒有固定檔時標成 skipped）。

日後要改規則：先用 Python 回測確認，再改 `src/engine/` 並重跑這個驗收。

## 部署與實測

需要 Cloudflare 與 claude.ai 帳號的步驟寫在 [`SETUP.md`](SETUP.md)。
從本機實抓一次公開資料來源（不經過 Cloudflare）：`npx tsx scripts/probe-local.ts`。

## 每日資料抓取（T6）

- 排程：每個交易日 UTC 23:30（美股收盤後）。手動跑一次：`POST /admin/ingest`（加 `?rank=1` 會連排名一起產生）。
- 看狀態：`GET /admin/data/status`（最近幾次抓取、告警、價格最新到哪一天、最新的排名與成分股比對）。
- 用真實資料在本機跑一次（含排名，約 510 個對外請求，存在暫時的本機 D1）：`npx tsx scripts/ingest-local.ts`。
- 資料表在 `migrations/0002_data_and_ledger.sql`；改了 migration 要 `npx wrangler d1 migrations apply stock-bot --remote` 再部署。
- 當天其實休市（臨時休市）而被告警「價格不是最新的」：在 D1 的 `calendar_overrides` 補一筆（`open = 0`）。

## 每日流程與 LINE（T7）

- 程式：`src/app/flow.ts`（抓資料 → 每日檢查 → 月底出月報 → 寫理由 → 存檔 → 推播；漏掉的交易日照順序補做）、`src/app/line.ts`（LINE 的文字與送出）。
- 排程：一天三次，各做什麼集中寫在 `src/app/schedule.ts` 的 `SCHEDULE`（`wrangler.jsonc` 的 `triggers.crons` 要和 `CRONS` 相同；星期用英文縮寫，Cloudflare 的數字 1 = 星期日）。同一個交易日只會處理一次。

  | 排程（UTC） | 台灣 | 做什麼 |
  |---|---|---|
  | `30 23 * * MON-FRI` | 07:30 | 抓資料 → 每日檢查 → 月底出月報 → 套用 AI 結論 → 看新申報、開這一天所有新的 AI 執行 → 推播（第一次失敗的告警先不推） |
  | `30 1 * * TUE-SAT` | 09:30 | 今天沒跑完就重跑，還是不行就推缺席告警；套用 AI 結論之後接著開 `finalStarts`（硬事件法庭：掃描標到的硬事件候選不等到隔天；當天的每日掃描沒有合格結論就重掃一次；你定的「重新審查」條件成立後的審查；提前審查：掃描標到的自選股可提前事件不等到隔天；月報前一天與訊號日的動能進場審查重開 `momRecheck`；崩盤規則檢視：重抓不足的總經資料、沒有結論的重開一次）；推之前留住的通知（例如補開了崩盤檢視的月報）；標記逾時的 AI 任務 |
  | `30 3 * * TUE-SAT` | 11:30 | 只套用回來的 AI 結論、推新通知與告警（含通知推出去之後才回來的結果補推一行）、標記逾時。不抓資料、不跑每日檢查、不開新的執行；今天的每日流程沒做完就不套用 |

  01:30 要多開的執行加在 `finalStarts`（掃描重開 T28、條件成立後的審查 T29a、提前審查 T29b、動能 `momRecheck` T32b、崩盤檢視 T33b 已接）。
- 崩盤規則的 AI 檢視（T33b，`core_ai_design_2026-11-15.md` §3.1～§3.5）：`src/app/crashAi.ts`。同一個月份＋方向沒有結論的最多開 3 次（連續 2 次、3 次推 `CRASH_REVIEW_FAILED`）；FRED 可用的序列不到 6 個（抓不到或過期）不開，01:30 重抓、還是不足推 `MACRO_MISSING`（每個月份一次）；月報之後才補開的，月報的 LINE 等到 01:30 再推（`src/app/pushHold.ts` 的 `crashWaiter`），03:30 才回來的意見補推一行。
- AI 任務逾時（45 分鐘）分兩種原因寫進「照規則」的結論與 `AI_TIMEOUT` 告警：雲端排程沒有來取證據包（`fetched_at` 是空的），或取了沒有送回。逾時標記之後才送到的結果回 410、存進 `ai_rejections`（`LATE`），不套用。
- 手動：`POST /admin/flow`；狀態：`GET /admin/flow/status`；測試推播：`POST /admin/line/test`、`POST /admin/alert/test`。
- 用真實資料在本機預覽 LINE 會收到的文字（含一份假裝今天是月底的月報，不會真的送）：`npx tsx scripts/flow-local.ts`。
- 新帳戶的依波動度減碼起始歷史：`src/engine/volSeed.ts`，由 `npx tsx scripts/vol-seed.ts` 從重放固定檔產生。
- 設定 LINE：見 [`SETUP.md`](SETUP.md) 的 T7。

## AI 共用骨架（T9）

- `src/ai/check.ts`：證據包與輸出外殼的格式、每一票的程式檢查、3 票表決（純函式）。`src/ai/pack.ts`：證據包產生器的共用部分。`src/ai/shadow.ts`：影子組合三條線與 Beta 後驗。
- `src/app/aiRuns.ts`：一次 AI 執行的儲存、觸發、收結果後表決、逾時照規則（`migrations/0005_ai_runs.sql`）。
- 網站：紀錄區的「AI 紀錄」、`#/ai/<執行編號>`（`public/js/pages-ai.js`）、匯出 md（`/api/ai/run/<編號>/md`）。

## LINE 關鍵字回覆（T15）

- `POST /line/webhook`（`src/app/lineWebhook.ts`）：驗 `X-Line-Signature`（`LINE_CHANNEL_SECRET`），只回 `LINE_USER_ID` 本人；用 reply API，不占推播額度。
- 關鍵字：狀態、待辦、月報、告警、網址、說明（`KEYWORDS`）；不認得的回關鍵字列表。只讀 D1，不呼叫 AI、不改帳戶。回覆記在 `pushes`（`kind = 'REPLY'`）。
- LINE 後台的設定：見 [`SETUP.md`](SETUP.md) 的 T15。

## 紀錄匯出到本機（T13）

- `GET /admin/export`（`src/app/export.ts`）：每張表的拉法與列數；`?table=<表>&after=<rowid>` 照 rowid 分頁。不匯出 `probe_runs`、`demo_state`、`ai_tasks.evidence`。
- 本機：在 repo 根目錄 `uv run python scripts/export_records.py`（`--full`、`--out`、`--url`），拉到 `records/`（`.gitignore`，repo 是公開的）。格式與表之間怎麼接：[`docs/analysis/records_guide.md`](../docs/analysis/records_guide.md)。
- 運作統計：`GET /admin/ops-report?from=&to=`（`src/app/opsReport.ts`）：通知次數、資料與排程失敗、告警、推播失敗、AI 執行與通過檢查的比例、照做／沒照做。預設從上線日算起。每一段一個函式，登記在 `OPS_SECTIONS`；匯出腳本會順便存一份到 `records/reports/`（`--report-from`、`--report-to`）。各段的意思見 records_guide。
- 被退回的 AI 輸出在 `ai_rejections`；雲端排程跑的 commit 在 `ai_runs.repo_commit`；通知項目、通知、影子紀錄的 `runIds` 接到 `ai_runs.run_id`（`migrations/0008_records.sql`）。
- 雲端排程的共用 prompt：`../ai/prompts/run.md`；各功能的 prompt 在 T10、T11 加上。

## 自選審查與條件監測（T10）

- `src/data/edgar.ts`：XBRL companyfacts（point-in-time 季度表、財報條件比對）、申報原文（MD&A、8-K 與 EX-99.1）、Nasdaq 新聞標題。
- `src/ai/ownReview.ts`：F24／F25 的證據包、payload 檢查、結論怎麼變成引擎的輸入；`src/app/ownAi.ts`：接進每日流程（`aiStep`）。
- 用真實資料看 F24 的證據長什麼樣（不觸發 AI）：`npx tsx scripts/own-evidence-local.ts MU 2026-11-13`。
- prompt：`../ai/prompts/own_review_v2.md`（T26 起；`own_review_v1` 不再使用）、`own_condition_v1.md`。

## 其餘 AI 功能（T11）

- 每日流程的 AI 段：`src/app/aiStep.ts`（看新申報 → 套用 AI 結論、財報條件、規則直接提出的硬事件 → 開新的執行），各功能的套用登記在 `APPLIERS`。
- 動能進場審查（T32b，`momentum_ai_design_2026-11-15.md` §3.1～§3.4）：證據由 `src/app/momEvidence.ts` 組（F1 與動能持股的 F19 共用，一份最多 6 份申報原文）；進場前回看在 `src/app/momLookback.ts`（月報前一天的 23:30 開、01:30 沒有結論重開一次）；有新證據才重開法庭（沿用上一次的結論）、01:30 的 `momRecheck`、月報之後才回來的否決在 `src/app/momAi.ts`。
- 動能持股的事件與「要看的事」（T32d，`momentum_ai_design_2026-11-15.md` §3.6～§3.8）：`src/app/momNotes.ts`（單月大跌那一行 `momDropLine` 在 `src/ai/detect.ts`，不呼叫 AI；晚到的否決、進場時的附註；否決紀錄）。擬事件打分、動能的 F20 大跌說明、候選股的每日掃描已拿掉。運作統計多一段 `mom_entry`（F1 法庭的次數、否決、沿用、累積滿 5 次提示看否決紀錄）。策略檢討的提醒直接附 French 動能因子的歷史對照（`src/app/strategyAi.ts`）。
- 集中度與部位大小（T35，`own_thesis_design_2026-11-15.md` §3.6.3）：`src/app/concentration.ts`。部位大小旗標（`OwnMeta.sizeFlag`／`sizeInfo`）每個交易日在 `processSessions` 裡更新（`updateSizeFlags`），只用來列「要看的事」`SIZE_2X` 與討論包的那一句，規則不看；集中度（`concentrationHits`）只在月報產生前與持股頁算，組合與門檻見 `design_v2` §10 第 45 點。兩件都只說明、不改下單。
- 規則偵測（不用 LLM）：`src/data/secEvents.ts`（申報分類，移植自 B-9）、`src/ai/detect.ts`（單日漲幅占比、盈餘背離、股數、資料可疑、跌幅拆解、SIC → 產業 ETF）、`src/data/fred.ts`（總經儀表板，fredgraph CSV 不需要金鑰）。
- 各功能：F18／F19 `src/ai/events.ts`＋`src/app/events.ts`；F1 `src/ai/momEntry.ts`＋`src/app/momAi.ts`；F7 `src/ai/drops.ts`＋`src/app/dropAi.ts`；F5／F6 `src/ai/crash.ts`＋`src/app/crashAi.ts`；F21 `src/ai/strategy.ts`＋`src/app/strategyAi.ts`；F14 `src/ai/ownCheck.ts`＋`src/app/ownCheckAi.ts`。資料表 `migrations/0007_events_entry.sql`。
- 用真實資料看規則段（不觸發 AI）：`npx tsx scripts/t11-local.ts MU NVDA`（F1 規則偵測、FRED 儀表板、French 動能因子回撤）。
- 網站：「紀錄 → AI 紀錄」上方有本月動能進場審查、總經儀表板、最近的申報事件；持股頁見下面「自選股的論點與三層配合」；新增自選不再請 AI 草擬前提（T27 拿掉，論點改在 claude.ai 討論）。
- prompt：`../ai/prompts/` 的 `event_scan_v2`（T28 起；`event_scan_v1` 不再使用）、`hard_event_v1`、`own_earnings_v1`（T29c）、`mom_entry_v2`（T32b 起；`mom_entry_v1` 不再使用）、`own_drop_v2`（T31b 起；`own_drop_v1` 不再使用）、`crash_review_v2`（T33d 起；`crash_review_v1` 不再使用）、`strategy_review_v1`、`own_check_v2`（T27 起；`own_check_v1` 不再使用）。`mom_score_v1`、`drop_explain_v1` T32d 起不再使用。

## 自選股的論點與三層配合（階段八，2026-11-16）

設計：`../docs/design/own_thesis_design_2026-11-15.md`（自選）、`momentum_ai_design_2026-11-15.md`（動能）、`core_ai_design_2026-11-15.md`（核心）；
每個任務做了什麼、執行中做的決定：`../docs/plan/thesis_plan_2026-11-15.md` 的階段八與 `../docs/plan/stage8_run_log.md`。

- 論點檔（T25）：`src/app/thesis.ts`（`thesisFile` 從帳戶狀態、`own_conditions`、`own_thesis_log`、`sec_events`、`ai_runs` 組出一檔的論點檔；`ownAttention` 是自選股的「要看的事」，種類見 `own_thesis` §3.6.6）。
- 條件的所有權（T26）：`src/app/ownConds.ts`。AI 審查只寫建議（`PROPOSED`），你在持股頁勾選才監測，成立時做什麼由你選。
- 討論包、貼回、編輯論點（T27）：`src/ai/discussion.ts`（純函式：組包、解析貼回的區塊）、`src/app/discussion.ts`（讀 D1 與 EDGAR）、`public/js/pages-thesis.js`。在 claude.ai 怎麼用見 [`SETUP.md`](SETUP.md) 的 T27。
- 審查與通知：定期審查與條件成立後的審查 `src/app/ownAi.ts`（甲類、乙類兩種失效通知，T29a；提前審查 T29b）；財報新聞稿當天確認 `src/app/earningsAi.ts`（T29c）；減半之後的 AI 論點檢查 `src/app/dropAi.ts`（T31b）；審查連續沒有結論的計數 `src/app/reviewHealth.ts`（T31a）；規則的通知等到 01:30 再推 `src/app/pushHold.ts`（T31b）。
- 持股頁（T34）：`public/js/pages-holding.js`；論點那一塊的白話由 `src/app/site/thesisView.ts` 組；事件的白話 `src/app/eventText.ts`（持股頁與討論包共用）。
- 幾份清單同時還沒填快照（T38）：入金、出金、改比例先把還沒填快照的清單當成做完再算（`src/engine/report.ts` 的 `afterOpenLists`）；填快照時同一桶同一檔照各清單列的股數分；上一份月報一整個月沒回覆，新月報出來時舊的策略項目取消。
- 使用者角度走一遍的紀錄：`../docs/test-records/t34_walkthrough_2026-11-16.md`（自選）、`t38_walkthrough_2026-11-16.md`（動能、核心、入金出金、改比例與交錯）。三次排程與月報整個跑一遍的測試：`test/t38-flow-smoke.test.ts`。

## 網站（T8）

- 本機看網站：`npm run dev`，開 `http://127.0.0.1:8787/?demo=1`（示範資料）。第一次要先建本機的資料表：
  `npx wrangler d1 migrations apply stock-bot --local`，並在 `.dev.vars` 寫一行 `DEV_NO_AUTH = "1"`（本機不驗證登入；這個檔不進 git）。
- 示範模式（網址帶 `?demo=1`，或按右上角「示範資料」）：假價格、假的 AI 內容，三個情境（平常的月報、自選股大跌、你自己的操作），
  上方的示範列可以讓時間前進。狀態存在 D1 的 `demo_state`，和真實帳本分開。
- 畫面的原則：每張建議單同時寫「做什麼」和「為什麼」（理由、門檻條、股數怎麼算、規則原文）；通知頁是三步驟：看建議做決定 → 到券商下單 → 回來填快照。
  建議單預設收合（收合時仍有做什麼、一句話的為什麼、目前的決定）；填快照送出之前都可以回上一步（`POST /api/notif/<編號>/reopen`）。
- 前端沒有打包步驟：`public/index.html`、`public/app.css`、`public/js/*.js`（瀏覽器直接載入的 ES modules）。
- 只有深色主題（2026-11-14 改版拿掉淺色）。版面：每頁最上面一條橫幅（標題、史萊姆、一句話）；左邊讀與選，右邊是儀表磚（待辦、帳戶）或主控台（月報、我要…）。
  史萊姆說的話由伺服器用真實數字產生（`src/app/site/bubble.ts`）；門檻條的刻度在 `src/app/site/meter.ts`。
- 字型自架（SIL OFL）：數字和英文 `public/fonts/geist.woff2`（Geist）；中文是思源黑體，`tc-ui.woff2` 收程式裡出現過的字（進頁面就載入），
  其他字照 Google Fonts 的切法分成 `tc-00`～`tc-94`，畫面上出現那一片的字才下載（`public/fonts/fonts.css` 的 unicode-range）。
  畫面的固定文字用了新的字之後重做一次：`uv run scripts/build-font.py`（第一次會下載原始字型到 `.font-cache/`，不進 git）。沒重做也不會壞，只是多下載一片。
- API：`/api/*`（真實帳本）與 `/demo/api/*`（示範）是同一組端點，程式在 `src/app/site/`：
  `api.ts`（路由）、`backend.ts`（資料來源）、`views.ts`（組成畫面要的資料）、`explain.ts`（每一項建議的理由）、`auth.ts`（登入 cookie 的驗證）、`lineLogin.ts`（LINE 登入）。
- 驗收：`test/site.test.ts` 用網站 API 走情境 ① 與 ⑤，每一步和直接呼叫引擎的結果比對。
- 填快照照三桶分開填（2026-11-15，設計 §10 第 38 點）：`POST /api/snapshot` 送 `lots: { own, mom, core }`，變動放哪一桶由使用者決定，不再問分類與現金差額（差額記成其他現金變動）。自選加新代號＝新增自選、股數改 0＝移出自選；標準比重在持股頁改（`/api/ops/std-weight`），論點與前提在「編輯論點」頁改（`/api/ops/own-thesis`，T27 起取代 `own-premises`）。只送總股數 `shares` 的舊格式仍收（示範與驗收測試用）。
- 部署與 LINE 登入設定：見 [`SETUP.md`](SETUP.md) 的 T8。

## 目錄

- `src/engine/`：規則引擎。純函式：不讀網路、不讀時鐘、不碰儲存。
- `src/data/`：資料抓取、交易日曆、D1 存取、組成引擎要的市場資料。
- `src/app/`：排程、網站（`site/`）、LINE、AI 任務端點。
- `src/demo/`：示範模式與情境測試共用的假市場、情境、時間驅動。
- `src/worker.ts`：Cloudflare 的進入點（只匯出處理函式；路由在 `src/index.ts`）。
- `public/`：網站的靜態檔。
- `test/`：測試。
- `scripts/`：本機工具（重放驗收等）。

## 金鑰

只用 `wrangler secret put <NAME>` 或雲端環境設定，不寫進 repo。本機開發用 `.dev.vars`（已列入 `.gitignore`）。
