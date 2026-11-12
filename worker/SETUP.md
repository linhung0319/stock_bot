# 部署與實測步驟（T4、T5、T8）

這些步驟需要你本人的帳號，程式沒辦法代做。指令都在 `worker/` 底下執行。
金鑰一律用 `wrangler secret put`（會提示你輸入，不會進 repo，也不會印出來）。

## 先知道的事：Cloudflare 免費方案的限制

查 2026-11-12 的官方文件（`developers.cloudflare.com/workers/platform/limits`）：

| | 免費 | 付費（每月 US$ 5 起） |
|---|---|---|
| 每次執行的對外請求數 | 50 | 10,000 |
| 每次執行的 CPU 時間 | **10 毫秒** | 30 秒（排程間隔 ≥ 1 小時可到 15 分鐘） |
| 排程（cron）數量 | 5 | 250 |

**2026-11-12：使用者的帳號已經是付費方案（每月 US$ 5），所以用右邊那一欄，CPU 10 毫秒的限制不適用。**
實測程式仍然分成兩半跑（各 ≤ 50 個對外請求），T4 跑完再決定要不要合併。

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

## T8：網站與登入（Cloudflare Access）

網站的靜態檔在 `public/`，API 在 `/api/*`（真實帳本）與 `/demo/api/*`（示範資料）。
**還沒設定 Access 之前，API 預設是關的**（回 401）；網頁本身打得開，但只會看到「還沒設定登入」。
這時可以在那個畫面貼 `ADMIN_TOKEN` 暫時進去看；Access 設好之後這條路會自動失效。

1. 建資料表並部署（這次多一張 `demo_state`，只給示範模式用）：
   ```
   npx wrangler d1 migrations apply stock-bot --remote
   npx wrangler deploy
   ```
2. 開啟 Access：Cloudflare 後台 → Workers & Pages → `stock-bot` → Settings → Domains & Routes →
   `workers.dev` 那一列按 **Enable Cloudflare Access**。跳出來的視窗會顯示兩個值：`POLICY_AUD` 與 `TEAM_DOMAIN`，先複製下來。
   再按 **Manage Cloudflare Access**，把允許登入的 email 改成只有你自己。
3. 把那兩個值交給 Worker（Worker 會自己再驗一次 Access 簽的權杖，Access 設定被改壞時 API 也不會打開）：
   ```
   npx wrangler secret put ACCESS_AUD           # 貼 POLICY_AUD
   npx wrangler secret put ACCESS_TEAM_DOMAIN   # 貼 TEAM_DOMAIN（https://xxx.cloudflareaccess.com 或 xxx.cloudflareaccess.com 都可以）
   ```
4. 讓機器用的端點略過 Access。`/ai/*`（雲端排程）、`/admin/*`（你用 curl）、`/health` 各有自己的金鑰或不需要登入，
   但 Access 開在整個網域上會把它們也擋住。到 Zero Trust → Access → Applications，各加一個 Self-hosted 應用程式：
   網域填同一個 `stock-bot.<子網域>.workers.dev`，路徑分別填 `ai`、`admin`、`health`，政策選 **Bypass**、對象 Everyone。
   路徑比較明確的應用程式會優先於整個網域的那一個。
5. 確認：
   - 用瀏覽器開網站 → 先看到 Access 的登入畫面 → 登入後看到 stock bot。
   - `curl https://<網址>/health` 仍然回 `{"ok":true,…}`。
   - `curl -H "Authorization: Bearer <ADMIN_TOKEN>" https://<網址>/admin/data/status` 仍然可用。
   - 沒登入時 `curl https://<網址>/api/state` 回 401 或被導到登入頁。

第 2、4 步的後台操作是照 2026-11-12 查到的官方文件寫的（`developers.cloudflare.com/workers/configuration/cloudflare-access/`、
`…/cloudflare-one/access-controls/policies/app-paths/`），沒有實際在後台做過；畫面上的名稱如果不一樣，以後台為準。
Bypass 會讓那幾個路徑不經過 Access 也不留 Access 的紀錄；它們靠各自的 Bearer 金鑰保護。

設好之後，網站右上角的「示範資料」可以隨時切換：示範模式用假價格與假的 AI 內容，存在另一張表，不會動到真正的帳本。
