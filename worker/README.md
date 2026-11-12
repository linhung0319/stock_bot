# stock bot worker

Cloudflare Worker：規則引擎（TypeScript，純函式）、排程、網站、LINE 推播。
設計依據：`../design_v2_momentum_2026-11-07.md`（系統架構 §2.7）；任務順序：`../implementation_plan_2026-11-11.md`。

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

## 網站（T8）

- 本機看網站：`npm run dev`，開 `http://127.0.0.1:8787/?demo=1`（示範資料）。第一次要先建本機的資料表：
  `npx wrangler d1 migrations apply stock-bot --local`，並在 `.dev.vars` 寫一行 `DEV_NO_AUTH = "1"`（本機不驗證登入；這個檔不進 git）。
- 示範模式（網址帶 `?demo=1`，或按右上角「示範資料」）：假價格、假的 AI 內容，三個情境（平常的月報、自選股大跌、你自己的操作），
  上方的示範列可以讓時間前進。狀態存在 D1 的 `demo_state`，和真實帳本分開。
- 畫面的原則：每張建議單同時寫「做什麼」和「為什麼」（理由、門檻尺、股數怎麼算、規則原文）；通知頁是三步驟：看建議做決定 → 到券商下單 → 回來填快照。
  建議單預設收合（收合時仍有做什麼、一句話的為什麼、目前的決定）；填快照送出之前都可以回上一步（`POST /api/notif/<編號>/reopen`）。
- 前端沒有打包步驟：`public/index.html`、`public/app.css`、`public/js/*.js`（瀏覽器直接載入的 ES modules）。
- 標題的明體字型 `public/fonts/display.woff2` 是從思源宋體（SIL OFL 授權）只取出網站用到的字做的。標題用了新的字之後重做一次：
  `uv run scripts/build-font.py`（第一次會下載約 17 MB 的原始字型到 `.font-cache/`，不進 git）。沒重做也不會壞，缺的字會用系統黑體顯示。
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
