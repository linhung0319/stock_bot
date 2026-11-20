# 網頁證據與 stock bot 草擬論點（2026-11-20，計畫 T50）

> 狀態：**討論中**。第 0 章（起因與查證過的事實）寫好了；第 1 章起每一章使用者同意後才寫進來。還沒實作，這份文件不改程式、不改 prompt、不部署。
> 依據：`docs/plan/thesis_plan_2026-11-15.md`（T47、T48、T49、T50）、`own_thesis_design_2026-11-15.md`（§1.6～§1.10、§1.14、第 2 章、第 4 章 G1～G25）、`ai_layer_design_2026-11-08.md` §2.1～§2.3、`docs/test-records/data_sources_2026-11-08.md` 第 5 節。
> 和舊文件的關係：這份定案之後，和上面幾份不同的地方以這份為準；會推翻的既有決定列在 §0.4，每一項都要使用者決定。
> 稱呼：L0 = 規則層；L1 = 輕 AI（一票，只標記、說明、轉交）；L2 = 重 AI（三票一致）。「審查」指自選定期審查（F24）。

---

## 0. 起因與查證過的事實

### 0.1 起因

1. 審查（F24）只讀公司自己的申報、XBRL、股價。前提寫的是同業、市占、產業報價時，三票只能判「證據不足」，永遠不會通知，只剩慢規則當底線。T47 把這種前提列進「要看的事」（`PREMISE_NO_DATA`）；T49 原本打算每月搜尋一次、只提醒使用者去討論。
2. 使用者 2026-11-20 的方向：(a) 網頁內容要能當審查的證據，不只是提醒；(b) 論點、前提、出場條件由排程裡的 stock bot 產生，不再靠匯出討論包到 claude.ai 討論再貼回。

### 0.2 實測（2026-11-20 以前）

| 事實 | 出處 |
|---|---|
| 現有雲端環境（Limited，只允許 Worker 主機）裡，WebSearch 可以用，回 10 筆標題與網址；WebFetch 讀 `www.sec.gov` 是 `getaddrinfo ENOTFOUND`；curl 其他主機 403 | `thesis_plan` T49 的 2026-11-20 實測（任務 `0c0c3f82…`，24 秒） |
| 排程建立時 connector 已經全部移除 | `progress_log.md` 2026-11-14 的 T5 |
| 一次完整的審查（MU，4 份文件，分析師＋多空＋3 票）：觸發到收到結果 6 分 40 秒 | `progress_log.md` 2026-11-14 的 T10 |
| **一次審查用掉多少訂閱額度：沒量過**（同時段帳號有其他使用，分不出來；使用者決定不單獨量） | 同上，T10 打勾那一條 |
| 連線測試一次 24～47 秒 | T5、T49 |
| Nasdaq RSS 從 Cloudflare 回 520；Yahoo Finance RSS 可以，每檔約 17～20 則，有標題、連結、發布時間，沒有內文 | commit `54253db`；`worker/src/data/edgar.ts` `NEWS_SOURCES`、`parseRss` |
| Worker 能不能抓各家網站的文章全文：**沒量過** | — |

### 0.3 官方文件（2026-11-20 重新讀過）

| 事實 | 出處 |
|---|---|
| 網路存取只有三級：None、Limited、Full。Limited 可以在 Allowed domains 一行一個加網域，`*.` 開頭涵蓋子網域；「Allow package managers」不勾就只連得到列出的網域 | code.claude.com/docs/en/cloud-environments.md |
| 排程每次執行都繼承環境的網路設定 | routines.md |
| **WebSearch 走 Anthropic 的搜尋後端，只回標題與網址，不讀結果頁** | tools-reference.md |
| **WebFetch 把網頁轉成 Markdown 之後，多數情況會另外呼叫一次模型、照 prompt 處理，Claude 拿到的是那次呼叫的結果，不是原始頁面**；這一步不能關。每次最多讀 100,000 字；轉址到別的主機不會跟過去 | tools-reference.md |
| WebFetch 的連線是從沙盒裡發還是從 Anthropic 發：文件沒寫（實測的 ENOTFOUND 看起來是沙盒裡） | — |
| connector 預設全部帶進排程、可以寫入、可以逐個移除；流量走 Anthropic 的伺服器，不受 Allowed domains 限制 | routines.md、cloud-environments.md |
| 每個排程每小時最多 30 次觸發，整個帳號每小時 100 次。每天的次數上限、單次執行的時間上限：文件沒寫 | routines.md、platform.claude.com 的 routines-fire |
| 用量算在訂閱裡；額度用完時新的執行被拒絕，不排隊 | routines.md |
| 關掉工具：WebFetch 可以用環境變數 `CLAUDE_CODE_DISABLE_WEB_FETCH=1` 或權限 deny；WebSearch 只能用 repo `.claude/settings.json` 的 deny（對排程有沒有效，文件沒明寫）。沒有「每個排程各自開關工具」的設定 | tools-reference.md、settings.md |
| 觸發時的 `text` 最多 65,536 字，會包在 `routine-fire-payload` 裡當成不可信的資料 | routines-fire |

**對設計最重要的一條**：WebFetch 給模型的不是原文。前一個工作階段建議的「排程讀全文、引用原文，Worker 再抓同一個網址逐字驗證」，引用那一步會常常對不上（模型看到的是另一個模型整理過的字）。要逐字引用，原文只能由程式抓。

### 0.4 會推翻的既有決定（每一項都要使用者決定；定了之後在這裡記結果）

| # | 既有決定 | 位置 | 這次要不要改 | 結果 |
|---|---|---|---|---|
| X1 | 不做 L2 上網搜尋（會讓逐字引用檢查失效）；LLM 不給上網工具，只能讀證據包 | `thesis_plan`「已經決定的方向」第 9 點；`ai_layer_design` §2.1；`run.md` 第一句 | 待決定 | — |
| X2 | 會改變下單的結論，引用要來自申報原文或財報表；新聞只能當初判。只有 `filing`／`xbrl` 的引用才算「前提不成立」 | `own_thesis_design` §1.6 第 1 點、§4.3 G12；`own_review_v2.md` | 待決定 | — |
| X3 | 確認來源只有新聞的事件條件「只在定期審查時檢查」，而且要申報或財報引用才算成立 | `own_thesis_design` §1.5、§1.6 第 2 點 | 待決定 | — |
| X4 | 論點在 claude.ai 討論（方案 B），stock bot 不產生論點；「請 AI 草擬前提」拿掉；AI 不能寫論點與前提 | 「已經決定的方向」第 4、7 點；`own_thesis_design` §1.4、§1.7、§1.8、§1.12、§1.14；memory `own-thesis-workflow` | 待決定 | — |
| X5 | 產業新聞類的條件只記錄、不通知；不付費買新聞 | `data_sources` 第 0 節第 4 點；`design_v2` §10 第 23 點 | 待決定（不付費那一半不改） | — |
