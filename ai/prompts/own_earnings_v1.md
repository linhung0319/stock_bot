# own_earnings_v1：財報數字擷取（OWN_EARNINGS，財報新聞稿當天）

共用的取證據包、外殼格式與送回方式見 `run.md`；這份只寫這個功能怎麼判斷。設計依據：`docs/design/own_thesis_design_2026-11-15.md` §1.11。

## 你在做什麼

使用者替這檔自選股定了財報門檻的出場條件（例如「毛利率低於 70%」）。這些條件平常等 10-Q／10-K 的 XBRL 出來才由程式比對；
今天公司發了財報新聞稿（8-K Item 2.02 的 EX-99.1），程式想先用新聞稿的數字比一次。
你**只抄數字**：從新聞稿的 GAAP 損益表抄出最近一季與去年同季的幾個項目。**不換算、不計算、不判斷條件成不成立**——比率、年增率、和門檻比都由程式做，
程式還會拿你抄的去年同季數字和 XBRL 已經申報的值核對，對不上的項目不用。

## 流程

每一票用一個新的子代理，**獨立跑 `samples` 次**（Sonnet），每次都從頭讀證據包，不看其他票的結果。不需要辯論。

## 判斷

- 找新聞稿裡的 **GAAP 損益表**（標題通常是 Consolidated Statements of Operations／Income／Earnings，前面常有 Condensed），用「三個月」那一欄（單季），不要用「年初至今」「全年」或「十二個月」的累計欄。
- 抄得到就 `verdict` = `EXTRACTED`，`payload`：
  ```json
  {
    "period_end": "2026-09-30",
    "figures": [
      { "item": "revenue", "current_text": "201,944", "year_ago_text": "180,169", "scale": 1000000, "evidence_ids": ["E1"] },
      { "item": "eps_diluted", "current_text": "1.89", "year_ago_text": "1.95", "scale": 1, "evidence_ids": ["E2"] }
    ]
  }
  ```
  - `period_end`：這一季的季末日（損益表欄位標題的日期，例如 September 30, 2026 → `2026-09-30`）。
  - `item` 只能是：`revenue`（營收合計）、`gross_profit`（毛利）、`cost_of_revenue`（營業成本合計）、`operating_income`（營業利益）、`net_income`（淨利，歸屬於公司的）、`eps_diluted`（稀釋每股盈餘）。新聞稿沒有的項目不要寫，也不要自己相減算出來。
  - `current_text`、`year_ago_text`：照原文的寫法抄（千分位、小數點、負數的括號都照抄），不要換算單位、不要四捨五入。
  - `scale`：原文的單位倍數。表頭寫 in millions → `1000000`；in thousands → `1000`；in billions → `1000000000`；沒有換算 → `1`。每股盈餘一律 `1`。
  - `evidence_ids`：引用 `evidence` 裡的編號。那一段引用（`quote`，一字不差，至少 12 個字）要**同時包含** `current_text` 與 `year_ago_text`，例如引用損益表的那一整行。引用的 `source_id` 要是申報原文（8-K 本文或 EX-99.1），XBRL 表只是對照，不能當引用。
- 抄不到就 `verdict` = `INSUFFICIENT`、`payload` = `{}`，`abstain_reason` 寫原因。以下都算抄不到：
  - 新聞稿沒有 GAAP 的損益表（只有調整後、非 GAAP 的數字）。
  - 只有累計數字、看不出單季。
  - 原文被截斷，看不到需要的那幾行。
- `report` 寫一兩句：抄的是哪一張表、哪一欄，有沒有覺得可疑的地方（例如重編、停業部門）。

## 不要做的

- 不要用非 GAAP、調整後（adjusted）、繼續營業部門以外另算的數字；不要用證據包以外的資料。
- 不要算比率、年增率，不要判斷條件成不成立，不要寫股數或建議操作。
