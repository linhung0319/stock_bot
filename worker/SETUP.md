# 部署與實測步驟（T4、T5）

這些步驟需要你本人的帳號，程式沒辦法代做。指令都在 `worker/` 底下執行。
金鑰一律用 `wrangler secret put`（會提示你輸入，不會進 repo，也不會印出來）。

## 先知道的事：Cloudflare 免費方案的限制

查 2026-11-12 的官方文件（`developers.cloudflare.com/workers/platform/limits`）：

| | 免費 | 付費（每月 US$ 5 起） |
|---|---|---|
| 每次執行的對外請求數 | 50 | 10,000 |
| 每次執行的 CPU 時間 | **10 毫秒** | 30 秒（排程間隔 ≥ 1 小時可到 15 分鐘） |
| 排程（cron）數量 | 5 | 250 |

- 對外請求數：實測程式已經分成兩半跑，各 ≤ 50，免費方案可以跑。
- CPU 10 毫秒：解析 60 檔 Yahoo 的 JSON、解 xlsx、跑規則引擎很可能超過。T4 的實測會告訴我們實際有沒有被砍
  （被砍的那次不會有紀錄，彙總裡那一天會少一半）。**如果免費方案不夠，要不要付費由你決定。**

## T4：從 Cloudflare 抓資料

1. 登入並建立資料庫：
   ```
   npx wrangler login
   npx wrangler d1 create stock-bot
   ```
   把印出來的 `database_id` 填進 `wrangler.jsonc`（取代全是 0 的那一串）。
2. 建資料表並部署：
   ```
   npx wrangler d1 migrations apply stock-bot --remote
   npx wrangler deploy
   ```
   記下部署後的網址（`https://stock-bot.<子網域>.workers.dev`）。
3. 設定金鑰：
   ```
   npx wrangler secret put ADMIN_TOKEN        # 自己產生一串亂碼，例如 openssl rand -hex 32
   npx wrangler secret put EDGAR_USER_AGENT   # SEC 要求帶聯絡方式，例如「你的名字 你的email」
   ```
   `EDGAR_USER_AGENT` 會把你填的聯絡方式送給 SEC。不設的話實測會略過 EDGAR。
4. 手動跑一次（兩半）：
   ```
   curl -X POST -H "Authorization: Bearer <ADMIN_TOKEN>" "https://<網址>/admin/probe?part=A"
   curl -X POST -H "Authorization: Bearer <ADMIN_TOKEN>" "https://<網址>/admin/probe?part=B"
   ```
5. 之後排程會在每個交易日 UTC 23:05、23:10 各跑一半。跑幾天後看彙總：
   ```
   curl -H "Authorization: Bearer <ADMIN_TOKEN>" "https://<網址>/admin/probe/summary"
   ```
   把結果貼給 Claude，就可以把 T4 的結論寫下來。

## T5：Worker 與雲端排程來回一次

1. 設定 Worker 這邊的金鑰：
   ```
   npx wrangler secret put AI_TASK_SECRET     # 自己產生一串亂碼
   ```
2. 在 claude.ai/code 建立雲端環境（或編輯既有的）：
   - Network access 選 **Limited**，Allowed domains 加上 Worker 的主機名稱（`stock-bot.<子網域>.workers.dev`）。
   - **Network secrets** → Add secret：Allowed websites 填同一個主機名稱；Header name `Authorization`、Prefix `Bearer`、
     Value 填和 `AI_TASK_SECRET` 相同的值。
3. 在 claude.ai/code/routines 建立排程任務：
   - Instructions：貼 `ai/prompts/ping.md` 裡「排程的 prompt」那一段，把 `WORKER_URL` 換成實際網址。
   - Repository 選這個 repo；Environment 選上一步的環境；Trigger 選 **API**。
   - 建立後會顯示一次 API token，還有這個任務的 `/fire` 網址，兩個都複製下來。
4. 把觸發用的網址與 token 放進 Worker：
   ```
   npx wrangler secret put ROUTINE_FIRE_URL   # https://api.anthropic.com/v1/claude_code/routines/trig_…/fire
   npx wrangler secret put ROUTINE_TOKEN      # sk-ant-oat01-…
   ```
5. 觸發一次：
   ```
   curl -X POST -H "Authorization: Bearer <ADMIN_TOKEN>" "https://<網址>/admin/ai/ping"
   ```
   回應裡有任務編號 `id`。幾分鐘後查結果：
   ```
   curl -H "Authorization: Bearer <ADMIN_TOKEN>" "https://<網址>/admin/ai/task/<id>"
   ```
   `status` 是 `DONE` 就是來回成功；`fire_to_result_ms` 是從觸發到收到結果的時間；`result.observations` 裡有
   「對外請求有沒有被擋」「子代理能不能指定 Haiku」。如果一直停在 `PENDING`／`FETCHED`，到 claude.ai 看那次執行的紀錄。
   把結果貼給 Claude，就可以把 T5 的結論寫下來；送回結果被擋的話會改用 git push 傳結果。

每個排程任務每小時最多觸發 30 次（官方文件，研究預覽階段可能會變）。
