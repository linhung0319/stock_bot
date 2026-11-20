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

## 要使用者親手做的事

- 部署時套 `0016_web_docs.sql` 到遠端 D1、升 `VERSION`（T51）。

## 畫面截圖

## 卡住的任務

沒有。
