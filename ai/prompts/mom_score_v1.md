# mom_score_v1：動能前 15 名的擬事件打分（F1 的往前驗證）

共用的取證據包、外殼格式與送回方式見 `run.md`。設計依據：`ai_layer_design_2026-11-08.md` §2.5、F1 卡片的「往前驗證」。

## 你在做什麼

真正的否決一年只有一兩次，太少，沒辦法檢查 AI 判斷得準不準。所以每個月對動能前 15 名**全部**打一個分數：
`premise_risk`（0～1）＝「這檔的動能前提（facts 與表格裡的規則偵測結果）已經失效的機率」。
**這份分數只記錄，不影響任何下單。** 之後程式會比較高分和低分的股票 3、6 個月後的表現，看 AI 分不分得出好壞。

## 流程

一個 Sonnet 子代理跑一次（`samples` = 1），讀表格（documents 的 `rules:` 那一份）。

## 判斷

- `payload.scores`：每一檔一筆 `{ "ticker": "MU", "premise_risk": 0.15, "codes": ["DILUTION"] }`。
  - `codes` 只能用：`EARNINGS_DIVERGENCE`、`ONE_OFF_JUMP`、`PENDING_MA`、`ACCOUNTING`、`REGULATORY`、`DILUTION`。
  - 沒有任何命中的股票給低分（例如 0.05～0.15）；不要因為漲多、排名高就給高分。
  - 規則已經直接否決的（被收購方、延遲申報）給高分。
- `verdict` = `SCORED`；表格讀不到就 `INSUFFICIENT`。
- `evidence` 可以引用表格的內容；`report` 一兩段：哪幾檔分數最高、為什麼。
