# event_scan_v2：每日事件掃描（F18，任務 B）

共用的取證據包、外殼格式與送回方式見 `run.md`；這份只寫這個功能怎麼判斷。設計依據：`docs/design/ai_layer_design_2026-11-08.md` 的 F18 卡片、`docs/design/own_thesis_design_2026-11-15.md` §2.2、§2.5。
和 v1 的差別：每筆事件多一個細項 `sub`；facts 的 K 開頭換成「觀察項」與「只在審查時檢查的條件」；明寫不要判斷重大性。

## 你在做什麼

每天收盤後，程式已經用規則分類過新的申報（被收購、延遲申報、重編、換會計師、增資、8-K 的 Item 編號能直接看出的事件、執行長或財務長離任等，不用你判斷）。
剩下規則分不出輕重的 8-K（合約、重組、高層異動、其他事件）和新的新聞標題放在證據包的 documents。
你只要**替每一件事標事件類別與細項**，不寫評論、**不判斷重大性**、不判斷該不該買賣。你的標記只會轉交給其他審查（持股的硬事件法庭、自選股的提前審查、下一次動能進場審查），不會觸發任何交易。

## 流程

用一個便宜的子代理（**Haiku**）跑一次（`samples` = 1）。

## 判斷

- `payload.events`：每一件值得標的事一筆：
  ```json
  { "ticker": "MU", "class": "MGMT_CHANGE", "sub": "CFO_DEPART", "source_id": "<documents[].source_id>", "condition_ids": ["K2"] }
  ```
  - `ticker` 只能是 facts 的 T 開頭列出的代號。
  - `class` 只能是：
    - `ACCOUNTING_CANDIDATE`：財報可信度的問題（重編、內控重大缺失、SEC 調查會計、會計師異動的爭議）
    - `REGULATORY_CANDIDATE`：可能實質影響營收的監管或訴訟（禁令、大額罰款、反壟斷、出口管制、產品召回）
    - `PENDING_MA_CANDIDATE`：這家公司**被**收購（不是它去收購別人）
    - `GUIDANCE_CUT`（財測）、`EARNINGS`（財報）、`MGMT_CHANGE`（高層異動）、`RESTRUCTURING`（重組、減損、裁員）、`MAJOR_CONTRACT`（重大合約）、`FINANCING`（發債、增資）、`OTHER`
  - `sub`（細項）只對下面三種類別有意義，照原文寫的事實選一個；其他類別不要給 `sub`。不在列舉內的細項程式會拿掉：
    | `class` | `sub` |
    |---|---|
    | `MGMT_CHANGE` | `CEO_DEPART` 執行長離任、`CFO_DEPART` 財務長離任、`EXEC_APPOINT` 新任命（沒有人離任）、`OTHER_EXEC` 其他主管異動、`DIRECTOR` 董事異動 |
    | `GUIDANCE_CUT` | `CUT` 下修財測、`WITHDRAWN` 撤回財測 |
    | `MAJOR_CONTRACT` | `NEW` 新簽的合約 |
    - 同一份申報裡有人離任也有人接任：離任的那一位決定細項（例如執行長卸任、新執行長上任 → `CEO_DEPART`）。
    - 事業部或子公司的「執行長」不是公司的執行長 → `OTHER_EXEC`。
    - 只要原文寫了就選，不要因為「看起來不重要」就不給；重大不重大由後面的審查判斷。
  - 三種 `_CANDIDATE` 一定要在 `evidence` 引用那份原文的一段話（一字不差，至少 12 個字），否則程式會拿掉。
  - 新聞標題只能當初判：標題寫「調查」「傳出」也可以標 `_CANDIDATE`，但不要把傳聞寫成事實。
  - `condition_ids`：facts 的 K 開頭是自選股的「觀察項」或「只在審查時檢查的條件」；這件事**可能**有關的編號放這裡，沒有就給空陣列。只是提示：申報原文標到的會讓那一檔提早審查，由三票判斷條件成不成立；新聞標題標到的只記錄。
- 有標記就 `verdict` = `FLAGGED`；沒有值得標的事就 `NOTHING`、`payload.events` = `[]`。例行的財報日公告、股利、股東會、一般產品新聞不用標。
- `report` 一兩句：標了什麼。

## 不要做的

- 不要用證據包以外的資料；不要判斷股價會怎樣、該不該賣；不要評估事件有多重大。
- 公司「去收購別人」不是 `PENDING_MA_CANDIDATE`。
