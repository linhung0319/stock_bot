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
- 排程：UTC 23:30 第一次、UTC 01:30 再試一次（沒跑完就重跑，還是不行就推告警）。同一個交易日只會處理一次。
- 手動：`POST /admin/flow`；狀態：`GET /admin/flow/status`；測試推播：`POST /admin/line/test`、`POST /admin/alert/test`。
- 用真實資料在本機預覽 LINE 會收到的文字（含一份假裝今天是月底的月報，不會真的送）：`npx tsx scripts/flow-local.ts`。
- 新帳戶的依波動度減碼起始歷史：`src/engine/volSeed.ts`，由 `npx tsx scripts/vol-seed.ts` 從重放固定檔產生。
- 設定 LINE：見 [`SETUP.md`](SETUP.md) 的 T7。

## AI 共用骨架（T9）

- `src/ai/check.ts`：證據包與輸出外殼的格式、每一票的程式檢查、3 票表決（純函式）。`src/ai/pack.ts`：證據包產生器的共用部分。`src/ai/shadow.ts`：影子組合三條線與 Beta 後驗。
- `src/app/aiRuns.ts`：一次 AI 執行的儲存、觸發、收結果後表決、逾時照規則（`migrations/0005_ai_runs.sql`）。
- 網站：紀錄區的「AI 紀錄」、`#/ai/<執行編號>`（`public/js/pages-ai.js`）、匯出 md（`/api/ai/run/<編號>/md`）。
- 雲端排程的共用 prompt：`../ai/prompts/run.md`；各功能的 prompt 在 T10、T11 加上。

## 自選審查與條件監測（T10）

- `src/data/edgar.ts`：XBRL companyfacts（point-in-time 季度表、財報條件比對）、申報原文（MD&A、8-K 與 EX-99.1）、Nasdaq 新聞標題。
- `src/ai/ownReview.ts`：F24／F25 的證據包、payload 檢查、結論怎麼變成引擎的輸入；`src/app/ownAi.ts`：接進每日流程（`aiStep`）。
- 用真實資料看 F24 的證據長什麼樣（不觸發 AI）：`npx tsx scripts/own-evidence-local.ts MU 2026-11-13`。
- prompt：`../ai/prompts/own_review_v1.md`、`own_condition_v1.md`。

## 其餘 AI 功能（T11）

- 每日流程的 AI 段：`src/app/aiStep.ts`（看新申報 → 套用 AI 結論、財報條件、規則直接提出的硬事件 → 開新的執行），各功能的套用登記在 `APPLIERS`。
- 規則偵測（不用 LLM）：`src/data/secEvents.ts`（申報分類，移植自 B-9）、`src/ai/detect.ts`（單日漲幅占比、盈餘背離、股數、資料可疑、跌幅拆解、SIC → 產業 ETF）、`src/data/fred.ts`（總經儀表板，fredgraph CSV 不需要金鑰）。
- 各功能：F18／F19 `src/ai/events.ts`＋`src/app/events.ts`；F1 `src/ai/momEntry.ts`＋`src/app/momAi.ts`；F7／F20 `src/ai/drops.ts`＋`src/app/dropAi.ts`；F5／F6 `src/ai/crash.ts`＋`src/app/crashAi.ts`；F21 `src/ai/strategy.ts`＋`src/app/strategyAi.ts`；F14 `src/ai/ownCheck.ts`＋`src/app/ownCheckAi.ts`。資料表 `migrations/0007_events_entry.sql`。
- 用真實資料看規則段（不觸發 AI）：`npx tsx scripts/t11-local.ts MU NVDA`（F1 規則偵測、FRED 儀表板、French 動能因子回撤）。
- 網站：「紀錄 → AI 紀錄」上方有本月動能進場審查、總經儀表板、最近的申報事件；持股頁有監測中的條件與 AI 改寫的出場條件；新增自選可以請 AI 草擬前提。
- prompt：`../ai/prompts/` 的 `event_scan_v1`、`hard_event_v1`、`mom_entry_v1`、`mom_score_v1`、`own_drop_v1`、`drop_explain_v1`、`crash_review_v1`、`strategy_review_v1`、`own_check_v1`。

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
  `api.ts`（路由）、`backend.ts`（資料來源）、`views.ts`（組成畫面要的資料）、`explain.ts`（每一項建議的理由）、`access.ts`（Cloudflare Access 的權杖驗證）。
- 驗收：`test/site.test.ts` 用網站 API 走情境 ① 與 ⑤，每一步和直接呼叫引擎的結果比對。
- 部署與 Access 設定：見 [`SETUP.md`](SETUP.md) 的 T8。

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
