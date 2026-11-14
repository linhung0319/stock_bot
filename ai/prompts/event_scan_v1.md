# event_scan_v1：每日事件掃描（F18，任務 B）

共用的取證據包、外殼格式與送回方式見 `run.md`；這份只寫這個功能怎麼判斷。設計依據：`ai_layer_design_2026-11-08.md` 的 F18 卡片。

## 你在做什麼

每天收盤後，程式已經用規則分類過新的申報（被收購、延遲申報、重編、換會計師、增資等，不用你判斷）。
剩下規則分不出輕重的 8-K（合約、重組、高層異動、其他事件）和新的新聞標題放在證據包的 documents。
你只要**替每一件事標事件類別與日期**，不寫評論、不判斷該不該買賣。你的標記只會轉交給其他審查（持股的硬事件法庭、下一次動能進場審查），不會觸發任何交易。

## 流程

用一個便宜的子代理（**Haiku**）跑一次（`samples` = 1）。

## 判斷

- `payload.events`：每一件值得標的事一筆：
  ```json
  { "ticker": "MU", "class": "REGULATORY_CANDIDATE", "source_id": "<documents[].source_id>", "condition_ids": ["K2"] }
  ```
  - `ticker` 只能是 facts 的 T 開頭列出的代號。
  - `class` 只能是：
    - `ACCOUNTING_CANDIDATE`：財報可信度的問題（重編、內控重大缺失、SEC 調查會計、會計師異動的爭議）
    - `REGULATORY_CANDIDATE`：可能實質影響營收的監管或訴訟（禁令、大額罰款、反壟斷、出口管制、產品召回）
    - `PENDING_MA_CANDIDATE`：這家公司**被**收購（不是它去收購別人）
    - `GUIDANCE_CUT`（下修財測）、`EARNINGS`（財報）、`MGMT_CHANGE`（高層異動）、`RESTRUCTURING`（重組、減損、裁員）、`MAJOR_CONTRACT`（重大合約）、`FINANCING`（發債、增資）、`OTHER`
  - 三種 `_CANDIDATE` 一定要在 `evidence` 引用那份原文的一段話（一字不差，至少 12 個字），否則程式會拿掉。
  - 新聞標題只能當初判：標題寫「調查」「傳出」也可以標 `_CANDIDATE`，但不要把傳聞寫成事實。
  - `condition_ids`：自選股的事件條件（facts 的 K 開頭）裡，這件事**可能**有關的編號；沒有就給空陣列。只是提示，條件要等申報原文證實才算成立。
- 有標記就 `verdict` = `FLAGGED`；沒有值得標的事就 `NOTHING`、`payload.events` = `[]`。例行的財報日公告、股利、股東會、一般產品新聞不用標。
- `report` 一兩句：標了什麼。

## 不要做的

- 不要用證據包以外的資料；不要判斷股價會怎樣、該不該賣。
- 公司「去收購別人」不是 `PENDING_MA_CANDIDATE`。
