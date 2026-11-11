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

## 目錄

- `src/engine/`：規則引擎。純函式：不讀網路、不讀時鐘、不碰儲存。
- `src/data/`：資料抓取。
- `src/app/`：排程、網站、LINE、AI 任務端點。
- `test/`：測試。
- `scripts/`：本機工具（重放驗收等）。

## 金鑰

只用 `wrangler secret put <NAME>` 或雲端環境設定，不寫進 repo。本機開發用 `.dev.vars`（已列入 `.gitignore`）。
