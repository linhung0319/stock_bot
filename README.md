# stock bot

規則選股（動能）＋ 核心 VOO ＋ 自選股的通知系統；AI 只在規則觸發時檢查前提。跑在 Cloudflare Worker，透過 LINE 與網站通知，系統不下單。

## 目錄

| 路徑 | 內容 |
|---|---|
| `worker/` | 正式系統：規則引擎、資料抓取、排程、網站、LINE、AI 任務端點（TypeScript）。指令見 `worker/README.md`，部署步驟見 `worker/SETUP.md` |
| `ai/prompts/` | 雲端排程讀的 AI prompt（`run.md` 是共用外殼，其餘一個功能一份） |
| `docs/` | 設計、計畫、測試紀錄、早期討論（見下表） |
| `backtest/` | 回測腳本與輸出（`results/`）。**凍結，不修改**；說明與結論在 `docs/test-records/backtest_B*.md` |
| `research/data_sources/` | 上線前資料源驗證的腳本；結論在 `docs/test-records/data_sources_2026-11-08.md` |
| `prototype/` | 早期的網頁原型（假資料），正式網站已改在 `worker/public/` |

Python 一律用 `uv run`（`pyproject.toml`）。

## 文件（`docs/`）

### `docs/design/` 現行設計（以這裡為準）

| 文件 | 內容 |
|---|---|
| `design_v2_momentum_2026-11-07.md` | **架構與規則的唯一依據**：分桶、動能、崩盤規則、自選規則、通知、系統架構（§2.7）、待決事項（§10） |
| `ai_layer_design_2026-11-08.md` | AI 層功能卡片 F1–F25（規則層與 AI 層的分工）；最上面的「2026-11-11 更新」優先於卡片內文 |
| `stockbot-redesign-v7.html` | 網站設計稿第 7 版（已落實到 `worker/public/`） |

兩份設計文件衝突時以 `design_v2` 為準。

### `docs/plan/` 實作計畫

| 文件 | 內容 |
|---|---|
| `implementation_plan_2026-11-11.md` | 任務 T0–T12 與工作規則；新的工作階段從第一個未完成的任務接著做 |
| `progress_log.md` | 每個任務的進度紀錄：做了什麼、測試結果、和計畫不同的地方 |

### `docs/test-records/` 測試與驗證紀錄

| 文件 | 內容 |
|---|---|
| `backtest_B1_2026-11-07.md` | B-1 純規則長期回測（L0 規則太常通知，放慢後的版本） |
| `backtest_B2_2026-11-07.md` | B-2 動能設計正式回測（緩衝區、風險層、VOO 核心） |
| `backtest_B5_2026-11-07.md` | B-5 整個帳戶的模擬（分桶、核心當清算中心） |
| `backtest_B6_2026-11-07.md` | B-6 搭便車、入金與出金 |
| `backtest_B7_2026-11-07.md` | B-7 依緊急程度分級通知 |
| `backtest_B8_2026-11-08.md` | B-8 依波動度減碼加遲滯（緩衝 0.10） |
| `backtest_B9_2026-11-08.md` | B-9 AI 層規則偵測段（SEC 硬事件）回測 |
| `data_sources_2026-11-08.md` | 上線前資料源驗證 |
| `usage_walkthrough_2026-11-07.md` | 使用情境演練（散戶用 Firstrade 跟著操作） |

### `docs/history/` 早期構想與討論（已被現行設計取代，留作紀錄）

| 文件 | 內容 |
|---|---|
| `stock_bot_idea.md` | 最初構想（TradingAgents 定期分析、選股漏斗） |
| `tradingagents_evaluation_2026-11-07.md` | TradingAgents 評估與回測、L0/L1/L2 三層架構 |
| `plan_review_2026-11-07.md` | 對最初構想與評估的多角色審查 |

文件之間用檔名互相引用（例如「見 `backtest_B8_2026-11-08.md`」），檔名在 `docs/` 裡都是唯一的，照上表找即可。
