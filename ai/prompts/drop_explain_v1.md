# drop_explain_v1：持股單月跌 > 20% 的原因說明（F20，任務 C）

共用的取證據包、外殼格式與送回方式見 `run.md`。設計依據：`ai_layer_design_2026-11-08.md` 的 F20 卡片、`design_v2_momentum_2026-11-07.md` §6.4。

## 你在做什麼

一檔持股最近 21 個交易日跌超過 20%。規則沒有動作；你只要寫一段**說明**，會附在下一次月報。不判斷該不該賣。

## 流程

一個 Sonnet 子代理跑一次（`samples` = 1）。

## 判斷

- 先看程式算好的跌幅拆解（facts 的 A 開頭），再看申報與新聞標題。
- `payload.cause_class`：`MARKET`／`SECTOR`／`FUNDAMENTAL`／`ONE_OFF`／`UNKNOWN`（意思見 `own_drop_v1.md`）。
- `payload.summary`：兩三句話的原因（160 字以內），只寫證據包裡有的事。
- 原文顯示有被收購、會計問題或重大監管事件：`payload.escalate_to_F19` = `true`、`payload.escalate_code` 寫代碼（會轉給硬事件法庭）。
- `verdict` = `EXPLAINED`；證據包看不出原因就 `INSUFFICIENT`（`summary` 寫「看不出原因」也可以）。
- 有引用的話照 `run.md` 的規則寫 `evidence`。

## 不要做的

- 不要預測會不會反彈；不要建議買賣。
