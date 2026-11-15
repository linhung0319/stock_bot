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
3. 在 claude.ai/code/routines 建立排程任務（官方現在叫 scheduled task，網址還是 routines）：
   - Instructions：貼 `ai/prompts/run.md` 裡「排程的 prompt」那一段（PING 任務它會轉給 `ping.md`，所以一個排程就夠），
     網址已經填好，直接複製。
   - 同一個輸入框裡選：模型 **Opus**（法官、經理要用 Opus；Sonnet、Haiku 由子代理指定）、Repository 選這個 repo、
     Environment 選上一步的環境。Connectors 全部移除（用不到）。
   - Trigger 選 **API**，按 Create 之後跳出的 **API token** 只顯示一次，先複製。
     **Fire URL** 在任務的 Edit 視窗 → Trigger 那一列的 API 面板裡（那裡也可以 Generate／Regenerate token）。
4. 把觸發用的網址與 token 放進 Worker。在 Claude Code 用 `!` 跑 `secret put` 會上傳空值，所以先把兩個值加進
   `worker/.secrets.json`（`ROUTINE_FIRE_URL`、`ROUTINE_TOKEN`），再用管線送：
   ```
   node -e "process.stdout.write(require('./.secrets.json').ROUTINE_FIRE_URL.trim())" | npx wrangler secret put ROUTINE_FIRE_URL
   node -e "process.stdout.write(require('./.secrets.json').ROUTINE_TOKEN.trim())" | npx wrangler secret put ROUTINE_TOKEN
   ```
   `ROUTINE_FIRE_URL` 長得像 `https://api.anthropic.com/v1/claude_code/routines/trig_…/fire`，`ROUTINE_TOKEN` 是 `sk-ant-oat01-…`。
   自己的終端機直接跑 `npx wrangler secret put ROUTINE_TOKEN` 貼上也可以。
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

## T8：網站與登入（LINE 登入）

網站的靜態檔在 `public/`，API 在 `/api/*`（真實帳本）與 `/demo/api/*`（示範資料）。
登入由 Worker 自己做 LINE Login（2026-11-14 取代原本規劃的 Cloudflare Access，程式在 `src/app/site/lineLogin.ts`、`auth.ts`），
**只有 `LINE_USER_ID` 那一個 LINE 帳號能登入**；登入一次 30 天有效。
**還沒設定之前，API 預設是關的**（回 401），可以在登入畫面貼 `ADMIN_TOKEN` 進去；設好之後這個方式仍保留當備用。
`/ai/*`、`/admin/*`、`/health` 不經過 LINE 登入，各用各的金鑰。

1. 建 LINE Login channel（LINE Developers，`developers.line.biz/console/`）：
   - 進**放 Messaging API 的那個 Provider**（同一個 Provider 的 user ID 才會等於 `LINE_USER_ID`）→ Create a new channel → **LINE Login**，
     App type 選 **Web app**。
   - **LINE Login** 分頁的 Callback URL 填 `https://<網址>/auth/line/callback`。
   - **Basic settings** 的 Channel ID、Channel secret 加進 `worker/.secrets.json`（`LINE_LOGIN_CHANNEL_ID`、`LINE_LOGIN_CHANNEL_SECRET`）。
     channel 停在 Developing 就好（你是管理員，本來就能登入）。
2. 簽登入 cookie 用的亂碼 `SESSION_SECRET` 也放進 `.secrets.json`（例如 `openssl rand -hex 32`）。換掉它會讓所有登入失效。
3. 把三個值交給 Worker 並部署（用管線，理由見 T7）：
   ```
   for k in LINE_LOGIN_CHANNEL_ID LINE_LOGIN_CHANNEL_SECRET SESSION_SECRET; do
     node -e "process.stdout.write(require('./.secrets.json').$k.trim())" | npx wrangler secret put $k
   done
   npx wrangler deploy
   ```
4. 確認：
   - 用瀏覽器開網站 → 自動導到 LINE → 登入後回到 stock bot。在 LINE 裡點訊息的連結通常會直接登入。
   - `curl https://<網址>/health` 仍然回 `{"ok":true,…}`；`/admin/*` 仍然用 `ADMIN_TOKEN`。
   - 沒登入時 `curl https://<網址>/api/state` 回 401（`reason` 是 `NO_SESSION`）。
   - 登出：開 `https://<網址>/auth/logout`。

登入的檢查：state（擋偽造的登入請求）、PKCE、nonce（擋重送）、ID token 的簽章（HS256 用 Channel secret，或 ES256 用 LINE 的公鑰）、
iss、aud、期限，最後 `sub` 必須等於 `LINE_USER_ID`。登入 cookie 是 `__Host-sb_session`（HttpOnly、Secure、SameSite=Lax），
內容簽過名、每次請求都再比對一次 `LINE_USER_ID`。會改帳戶的請求另外只收 JSON、來源必須是網站自己。

設好之後，網站右上角的「示範資料」可以隨時切換：示範模式用假價格與假的 AI 內容，存在另一張表，不會動到真正的帳本。

## T7：每日流程、LINE 推播、缺席告警

每天三個排程（`wrangler.jsonc`；各做什麼見 `README.md` 的 T7）：UTC 23:30（台灣早上 7:30，美股收盤後）抓資料 → 每日檢查 → 月底那天出下個月的月報 → LINE；
UTC 01:30 再檢查一次，沒跑完就重跑，還是不行就推一則告警；UTC 03:30 只套用回來的 AI 結論、補推。T4 的實測排程這次拿掉了（`/admin/probe` 仍可手動跑）。
**月報要有帳戶才會出**：12 月的月報在 11/30 收盤後產生（台灣 12/1 早上 7:30 收到），在那之前要先照上面 T8 的步驟部署、在網站建立帳戶（預設紙上交易）。

1. 建一個 LINE 官方帳號並開啟 Messaging API（2026-11 的官方流程；畫面名稱以後台為準）：
   - 到 LINE Official Account Manager（`manager.line.biz`）建立一個官方帳號（名稱隨意，例如 stock bot）。
   - 進那個帳號的「設定 → Messaging API」→ 啟用 Messaging API，選一個 provider（沒有就新建一個）。
   - 「設定 → 回應設定」把自動回應訊息、加入好友的歡迎訊息關掉（不關也沒關係，只是會多收到罐頭訊息）。
2. 到 LINE Developers（`developers.line.biz/console/`）→ 剛才的 provider → 那個 channel：
   - **Messaging API** 分頁最下面 Channel access token（long-lived）→ Issue，複製。
   - 同一頁有 QR code：**用你的 LINE 掃描加它為好友**（沒加好友收不到推播）。
   - **Basic settings** 分頁最下面的 **Your user ID**（`U` 開頭），複製。
3. 把兩個值交給 Worker，套用新的資料表（`0004`）並部署：
   ```
   npx wrangler secret put LINE_CHANNEL_TOKEN   # 貼 channel access token
   npx wrangler secret put LINE_USER_ID         # 貼 Your user ID
   npx wrangler d1 migrations apply stock-bot --remote
   npx wrangler deploy
   ```
   網站網址（訊息裡的連結）寫在 `wrangler.jsonc` 的 `vars.SITE_URL`；網址不同的話改那裡。
   `secret put` 要在自己的終端機跑（會提示貼上值）。在 Claude Code 用 `!` 跑沒有提示，會直接上傳**空值**；
   這時改用管線，例如 `node -e "process.stdout.write(require('./.secrets.json').LINE_USER_ID.trim())" | npx wrangler secret put LINE_USER_ID`。
   找不到 **Your user ID**：表示登入 LINE Developers 用的是 email 註冊的商用帳號。到 Provider 的 Roles 用 email 邀請自己，
   開邀請連結時改用 **LINE 帳號**登入接受，再用 LINE 帳號登入就看得到（user ID 每個 Provider 不同，要在同一個 Provider 底下看）。
4. 確認（`<ADMIN_TOKEN>` 在 `worker/.secrets.json`）：
   ```
   curl -X POST -H "Authorization: Bearer <ADMIN_TOKEN>" https://<網址>/admin/line/test    # 收到一則測試訊息
   curl -X POST -H "Authorization: Bearer <ADMIN_TOKEN>" https://<網址>/admin/alert/test   # 收到一則【告警】
   curl -H "Authorization: Bearer <ADMIN_TOKEN>" https://<網址>/admin/flow/status          # 最近幾次流程、推播紀錄、處理到哪一天
   ```
   手動跑一次每日流程：`curl -X POST -H "Authorization: Bearer <ADMIN_TOKEN>" https://<網址>/admin/flow`（同一個交易日已經做過就只補推失敗的訊息，不會重做）。

LINE 免費方案每月推播有則數上限（以 Official Account Manager 顯示的為準）。這個系統平常一個月約 1 則月報，加上偶爾的當天通知、提醒和告警，
不會碰到上限；碰到時推播會失敗、記在 `/admin/flow/status`，網站的警示列仍看得到告警。

## T9：AI 共用骨架

程式不需要新的帳號。部署時套用新的資料表（`0005`，AI 執行紀錄）：
```
npx wrangler d1 migrations apply stock-bot --remote
npx wrangler deploy
```
T5 的雲端排程建好之後，排程的 Instructions 用 `ai/prompts/run.md` 的「排程的 prompt」（它也會把 PING 任務交給 `ping.md` 處理，所以同一個排程就夠）。

## T10：自選定期審查（F24）、自選條件監測（F25）

部署時套用新的資料表（`0006`，監測條件）並部署：
```
npx wrangler d1 migrations apply stock-bot --remote
npx wrangler deploy
```
會用到已經設好的 `EDGAR_USER_AGENT`。雲端排程（T5）建好之後：
1. 對一檔自選手動開一次審查，看雲端排程跑完、結果送回：
   `curl -X POST -H "Authorization: Bearer <ADMIN_TOKEN>" "https://<網址>/admin/ai/review?ticker=MU"`
2. 幾分鐘後看結果：`curl -H "Authorization: Bearer <ADMIN_TOKEN>" https://<網址>/admin/ai/runs`，網站的「紀錄 → AI 紀錄」也看得到。
3. 到 claude.ai 的用量頁記下這一次吃了多少 Max 用量（T10 要記錄）。

## T11：其餘 AI 功能（每日事件掃描、硬事件、否決法庭、崩盤規則檢視等）

部署時套用新的資料表（`0007`：申報事件、動能進場審查、總經儀表板）並部署：
```
npx wrangler d1 migrations apply stock-bot --remote
npx wrangler deploy
```
不需要新的金鑰（FRED 用公開的 CSV、French 資料庫公開下載）。部署後可以先驗證規則段（不會觸發 AI）：
1. F1 的規則偵測：`curl -H "Authorization: Bearer <ADMIN_TOKEN>" "https://<網址>/admin/ai/entry?ticker=MU"`（看 EDGAR、XBRL、價格都抓得到）。
2. 總經儀表板：`curl -X POST -H "Authorization: Bearer <ADMIN_TOKEN>" https://<網址>/admin/macro`（看 FRED 的 10 個序列從 Cloudflare 抓不抓得到）。
3. 隔天看 `GET /admin/flow/status` 的 `ai.log`：每日掃描有沒有抓到 Nasdaq 新聞標題（本機連不上，要看 Cloudflare 能不能連）。

雲端排程（T5）建好之後，月報前一天（當月倒數第二個交易日）會自動開：自選定期審查、動能新股進場審查（有命中才開法庭）、崩盤規則檢視（預估會切換時才開；不會切換的月份不開，每月評語 2026-11-15 拿掉）；
平常每天有新的 8-K 或新聞標題時開每日掃描（Haiku）。第一個月跑完後到 claude.ai 的用量頁看一下整體用量。

## T15：LINE 關鍵字回覆

在 LINE 傳固定的字給官方帳號（狀態、待辦、月報、告警、網址、說明），Worker 用 reply API 回現況（不占推播額度、不呼叫 AI、不改帳戶）。

1. LINE Developers → Messaging API 那個 channel → **Basic settings** 的 Channel secret 加進 `worker/.secrets.json`（`LINE_CHANNEL_SECRET`；不是 LINE Login channel 的那個）。
2. 用管線設進 Worker（值不會印出來）：
   `uv run python -c "import json,sys;sys.stdout.write(json.load(open('.secrets.json',encoding='utf-8'))['LINE_CHANNEL_SECRET'].strip())" | npx wrangler secret put LINE_CHANNEL_SECRET`
3. **Messaging API** 分頁 → Webhook settings：Webhook URL 填 `https://stock-bot.linhung0319.workers.dev/line/webhook`、打開 **Use webhook**、按 **Verify**（要回 Success；部署之前按會是 404）。Webhook redelivery 不用開。
4. LINE Official Account Manager → 設定 → 回應設定：聊天關閉、自動回應訊息關閉、Webhook 開啟（加入好友的歡迎訊息可關可不關）。
5. 在 LINE 傳「狀態」：應該馬上收到帳戶與每日流程的狀況。別人傳的、群組裡的訊息不會回。

## T14：復原上一份快照

部署時套用新的資料表（`0009`，快照送出前的帳戶暫存）並部署：

```
npx wrangler d1 migrations apply stock-bot --remote
npx wrangler deploy
```

## T27：在 claude.ai 討論論點（討論包、貼回）

論點在 claude.ai 討論，stock bot 只做頭和尾（own_thesis §1.7、§1.8）。不需要新的金鑰或資料表。

- **討論包自帶固定指示**（反方審查員、收尾時的輸出格式），貼到任何一個新對話就能用，不依賴專案設定。
- 想把每檔的討論整理在一起，可以在 claude.ai 開一個專案（只是方便整理，可以不做）：
  1. claude.ai → 左側 **Projects** → **Create project**，名字例如「stock bot 論點」。
  2. 專案的 Instructions 可以留空（固定指示已經在討論包裡；寫了也不要和討論包衝突，例如不要要求它換輸出格式）。
  3. 每檔每次討論開一個新對話，對話名稱用代號加日期（例如「MU 2026-11-20」），之後好找。
- 流程：持股頁按「複製討論包」→ 貼到 claude.ai 的新對話 → 討論 → 說「收尾」→ 複製它輸出的整個區塊（`===STOCKBOT 論點 v1 <代號>===` 到 `===END===`）→ 持股頁「編輯論點」→ 貼上、按「解析」→ 看左右預覽、需要的話手改 → 確認。
- 確認後論點與前提馬上存好；出場條件送去 AI 改寫（要雲端排程設定好），回來後在持股頁勾選才開始監測。送不出去時頁面會寫「出場條件還沒送去改寫」並有「重送」。
- 前提有增減時，隔天的每日流程會開一次審查（每檔 30 天最多 1 次）。

## 階段八（2026-11-16）：部署

階段八（`docs/plan/thesis_plan_2026-11-15.md`）改了資料表、排程與 prompt。照順序：

1. `git push`：雲端排程從 repo 讀 prompt（`own_review_v2`、`event_scan_v2`、`own_check_v2`、`own_earnings_v1`、`own_drop_v2`、`mom_entry_v2`、`crash_review_v2`），push 之後才用新版。
2. 資料表：套用新的 migration `0010`～`0014`（`npx wrangler d1 migrations apply stock-bot --remote`），或照 T17 清掉帳戶與 AI 的資料、重建資料庫（上線前本來就要做）。
3. `npx wrangler deploy`：新的 03:30 排程（`30 3 * * TUE-SAT`）部署之後才生效。
4. 把 `ai/prompts/run.md`、`ai/prompts/ping.md` 的「排程的 prompt」重新貼到 claude.ai 的雲端排程（T36 改過）。
5. 部署後第一個交易日看 `GET /admin/flow/status`：三次排程都有紀錄、沒有 `ERROR`。
