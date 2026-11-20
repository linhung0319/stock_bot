# 階段九的執行紀錄

> 對應：`thesis_plan_2026-11-15.md` 的階段九（設計：`docs/design/web_evidence_design_2026-11-20.md` 第 5 章）。主持的工作階段每驗收完一個任務就更新這份；做完後整理成給使用者的三張清單。
> 這份會進 git，repo 是公開的：不寫帳戶金額、持股股數、金鑰。截圖放 `records/stage9/screens/`（不進 git），這裡只記路徑。

開始：2026-11-20，commit `6410830`。基準：`npm test` 799 通過、1 略過；typecheck、lint 通過；`worker/fixtures/replay/` 存在。

## 執行中做的決定

### T51（網域清單、抓取、快照）

- 起始清單照 M1、M2 調整：拿掉 `datacenterdynamics.com`（文章頁 2 篇都 403）、`businesskorea.co.kr`（內文不到 1,500 字）；留 TrendForce、DRAMeXchange、techpowerup、NVIDIA 新聞室、SIA。實測抓得到的公司新聞室（`news.skhynix.com`、`news.samsung.com`、`www.micron.com/about/press/`）寫在 §1.3，給 T52 每檔的 `domains` 用；`investors.micron.com` 403。
- 發布日多一個備案（設計只寫 meta、JSON-LD、`<time>`）：NVIDIA、SK 海力士、美光新聞室與 DRAMeXchange 都沒有結構化日期，所以第一段內文之前 15 行內單獨一行的日期也算（`published_from = 'text'`；內文之後、Updated 後面的不算）。
- 清單項目多 `paths`（DRAMeXchange 只收週報、NVIDIA 只收 `/news/`、TrendForce 不收付費報告頁）；不列入名單（fool.com 等）用程式擋，加進某檔的 `domains` 也不收。
- `web_docs` 主鍵改 `row_id`（設計的 `id = web:<雜湊>` 同一網址兩檔、或沒抓成的每次都各一列，會重複）；部分唯一索引保證同一檔同一 `id` 最多一列有全文；多 `error`、`used_by` 兩欄。
- 轉址自己逐站跟（最多 5 次），每一站都要在清單內；網址去掉 `#` 與 `utm_` 再算雜湊；快照從文章標題那一行開始。
- 同網站每次執行抓滿 4 篇之後回 `LIMIT`（不抓、不寫表，留給 T52 記在執行紀錄）；`fetchWebDoc` 可帶決策日與 `notBefore`（怎麼算留給 T52）。
- `/admin/web/test` 也用新的日期備案；`VERSION` 沒升（這次不部署）。
- 沒做完：`purgeUnusedWebText`（180 天清全文）還沒接進每日流程，要等 T52 寫 `used_by`。不放心：1,500 字門檻對韓文、中文偏嚴（韓文完整報導 891 字），等 T57 看 `THIN` 多不多；美光新聞頁的快照夾雜 HTML 片段，吃字數但不影響引用比對；實測樣本小（每網域 1～6 篇、一次）。

### T52（每檔的來源、目錄、取文件的端點）

- 取回的文件怎麼算進原文：`toRun` 讀執行紀錄時把 `added_docs` 併進 `pack.documents`（表決、套用、網站、匯出看同一份）；資料庫的 `pack`／`pack_hash` 仍是程式準備的那份；`added_docs` 存給 AI 的那份原文（截過就是截過）。同業申報 `kind = filing`，照 §1.2 和自己的申報同級（§1.6 第一列：同業申報可以判前提不成立）；網頁 `kind = web` 在 T53 之前不觸發任何通知。
- `notBefore` = 上次有結論的審查決策日前 120 天，沒有上一次時 365 天；重用舊快照時清單與日期照這次規則再查一次。
- `LIMIT` 等被拒絕的記在 `added_docs.refused`（最多 60 筆＋`refusedTotal`）；同網站計數在 `added_docs.sites`。
- 沒有 `doc_ctx` 的執行（減半檢視 F7）照現在的帳戶取網域與論點檔，`notBefore` 365 天；減半檢視的目錄留給 T54。
- 端點細節：還沒取證據包回 409；一次最多要 8 份、請求 16 KB；同一份再要一次原樣給、不算份數；`for` 是 P 開頭寫 `premise_id`，其他寫 `cond_id`；寫回 `added_docs` 比對舊值，同時寫後到的回 409。
- 8-K 本文在 `edgar.ts` 就只留 15,000 字，所以剛好 15,000 字的也標截斷。
- 來源和論點同一個存檔按鈕（`POST /api/ops/own-thesis` 多 `webSources`；沒送不改、`null` 拿掉）；只改來源也會讓論點版本加 1。
- 試抓：網域抓首頁（HTTP < 400 算）、EDGAR 查得到 CIK、Yahoo RSS 有標題；示範模式一律「沒有試」。共用清單已有的網域與不列入的網站回 422；只有系統預設前提的股票也能存來源（寫了自己的前提後才用）。
- 不放心：首頁抓得到不代表文章頁抓得到；一次審查多約 12 個同業請求；範圍外：`fetchFilingDoc` 截斷 8-K 本文時不標記（原本的證據包也一樣）。

### T53（分析師找資料、審查怎麼用網頁證據、兩種通知）

- 減半檢視共用 `brokenPremises`，判不成立的來源規則一起放寬（`own_drop_v2` 沒有找資料步驟，T54 之前實際不會有網頁進來）。
- `RAISE` 與回到標準照設計字面：每條判成立的前提至少一條申報或財報引用——比以前嚴（以前只靠價格或新聞標題也能過）；既有測試沒受影響。
- `confirm_by` 同時有申報類型與 `web:`：新申報照舊當天確認，審查時也認那個網頁來源。
- `WEB_VOTE`：至少一票靠指名的來源才記；三票都有申報引用仍記 `REVIEW_VOTE`；套用時用條件現在指名的來源再驗。
- 通知名詞：路徑有 `press` 寫「新聞稿」，其他寫「文章」；`MEDIA` 兩個網域都列。
- `lookups` 格式不對不退回整份結果，壞的當成沒回報；取到幾份以程式記的 `added_docs` 為準。
- 證據包多 `S` 開頭的「清單內的網頁來源」（最多 11 行），只有預設前提的股票沒有。
- 勾選條件時可以改指名的來源（清單內與這檔的網域，或不指名）；勾選之後不能再改；AI 寫清單外來源的條件標成只記錄。
- 網頁全文不放網站與匯出的 md（著作權），只列標題、連結、字數與被引用的片段。
- 範圍外但截圖時順手改的：甲類通知頁帶出那次審查的 AI 說明、網頁引用附原始網址；持股頁在指名的來源被拿掉時寫明現在取不到；`.facts` 在手機被撐寬 24px（基準就有，全站共用的 CSS，只看過持股頁與 AI 紀錄頁）。
- 主持者把上面第 3、4、5、8 點與 `RAISE`、減半檢視補進 `web_evidence` §1.6 最後一點。
- 不放心：prompt 只有檔案內容的測試，真的 AI 照不照做要等 M3；共用清單的 `MEDIA` 只有 techpowerup 一個，「媒體兩個網域」現在實際上成立不了；同一次審查可能同時發甲類與乙類（既有行為）；討論包與 `PREMISE_DATA_NOTE` 的「審查只讀公司自己的資料」留給 T54；「DRAMeXchange（TrendForce） 的網頁」括號後多一個空格。
- subagent 截圖時跑過一次 `git stash` / `stash pop`（內容完整還原、stash 清單是空的；主持者重跑過三個指令）。

## 要使用者親手做的事

- **順序不能反**（舊的 Worker 不認得 `lookups`，會把整份結果退回）：
  1. `git push`（雲端排程從 repo 讀 `own_review_v3.md`、`own_check_v5.md`）。
  2. 套 `0016_web_docs.sql`（T51）、`0017_ai_runs_docs.sql`（T52）、`0018_ai_runs_lookups.sql`（T53）到遠端 D1，升 `VERSION`，部署。
  3. 部署之後，把 `ai/prompts/run.md` 裡「## 排程的 prompt」標題以下到檔案結尾整段，貼到 claude.ai 雲端排程的 Instructions（網路設定不用動）。
  4. 跑 M3（子代理裡 WebSearch 能不能用還沒實測）。

## 畫面截圖

- T52：`records/stage9/screens/T52/thesis-sources-desktop.png`、`thesis-sources-phone.png`（示範 MU 的編輯論點頁，存了來源、按過試抓；示範模式看不到「目前抓不到」的樣子）。

## 卡住的任務

沒有。
