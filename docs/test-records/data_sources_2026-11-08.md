# 上線前資料源驗證（2026-11-08）

> 範圍：設計 §2.4「上線資料源」（`plan_review` A-12）、`ai_layer_design` §8.2 的 point-in-time 資料源表與 §11 第 3 點。只做驗證，不寫產品程式碼，不改設計文件。
> 測試日期：2026-11-08（台灣時間 18:20～），所有抓下來的資料快取在 `research/data_sources/raw/`（不 commit）。數字都可以用 `research/data_sources/` 的腳本重跑得到（腳本名稱寫在每一節）。

## 0. 結論

| # | 資料源 | 判定 | 一句話 |
|---|---|---|---|
| 1 | 歷史 S&P 500 成分股（fja05680） | **可行**（回測）／**有條件可行**（上線） | 14 個抽查事件誤差都是 0 天；但上游最後更新 2026-08-18，已漏 7 檔異動。上線改用 SSGA SPY 每日持股檔（和 Wikipedia 完全一致）|
| 1' | 已下市公司價格 | **有條件可行** | Yahoo 只有離開指數的 706 個代號中的 35%；免費來源（yfinance、Stooq、Nasdaq）都補不到。Alpha Vantage 免費版可拿到下市前最後 100 天，足夠取「最後成交價」|
| 2 | point-in-time 市值（XBRL 股數 × 價格） | **有條件可行**（2009-07 起） | 單一類股的 9 個里程碑誤差 -1.1%～+2.9%；多類股要換概念（GOOGL、META 可以，BRK 不行）；2009 年以前沒有 XBRL |
| 2' | 前一日成交金額 | **可行** | yfinance `Close × Volume`（`auto_adjust=False`）就是當天實際成交金額，分割前後一致 |
| 3 | EDGAR submissions（form、items、acceptanceDateTime） | **可行** | 10 家公司 1994–2026 的 8-K 全部都有 items；新式編號（4.01、4.02）從 2004-08 起；`acceptanceDateTime` 是真正的 UTC |
| 3' | XBRL companyfacts point-in-time | **可行**；frames **不可行**（不是 point-in-time） | companyfacts 同時保留重編前後的值（TAP、KHC 實測）；frames 只回最新申報的值 |
| 4 | FRED／ALFRED vintage | **可行**，但 **BAMLH0A0HYM2 不可行**（只剩 2023-11-07 起） | ICE 系列的舊 vintage 也被截掉，FRED 上沒有任何辦法拿到 2023-11 以前的高收益債利差 |
| 5 | 新聞 | **有條件可行** | Alpha Vantage NEWS_SENTIMENT 是付費功能；免費來源（Google News、Nasdaq RSS）只有標題；只有 EDGAR 8-K 附件（EX-99.1）和 SEC 公告有原文。F25 事件條件中「產業新聞類」拿不到原文 |
| 6 | 價格（yfinance） | **可行**（上線）；備援只有 **有條件可行** | 8 檔 1996 起無缺值、和 10/14 的快取完全一致；Stooq 已需 JavaScript、Alpha Vantage 免費版只有 100 天、Nasdaq 只有 10 年 |

**最重要的五件事**

1. **上線的成分股不要用 fja05680**：它是志工維護，2026-08-18 之後沒更新（Wikipedia 已記到 2026-10-30）。上線用 SSGA 每天公布的 SPY 持股檔（免費、免登入、權重就是浮動市值占比，可以直接拿來排「市值前 50」）。回測繼續用 fja05680。
2. **現有回測的「市值」在 2015 年以前其實是「價格 × 2015 年的股數」**（LEAN 資料夾的股數來自 Yahoo `get_shares_full`，最早 2015-10-28，之前用 bfill 往前補）。2009 年以後可以改用 XBRL 股數重建；這不改設計，但 B-x 回測的 2009–2015 段落要知道這個近似。
3. **BAMLH0A0HYM2（高收益債利差）不能當崩盤規則儀表板的歷史輸入**：FRED 只給最近 3 年（滾動），連 ALFRED 的舊 vintage 也一起截掉。歷史參考類別（`ai_layer` §3.3）改用 `BAA10Y`（1986 起、不修正）。
4. **F25 的「事件條件」只有在事件會出現在 EDGAR 或 SEC 公告時才有原文**。像「DRAM 合約價下跌」「客戶削減資本支出」這類產業新聞，免費來源只有標題，依規則記為「有條件可行」：上線先只監測能從 8-K／10-Q 原文確認的條件，產業新聞類的條件只記錄、不通知，或付費（Alpha Vantage 方案見 §5）。
5. **B-9 的 EDGAR 資料可以免費、完整取得**（2009 起）：已建好 2009 年以來 S&P 500 成分股的 ticker→CIK 對照表（866 個代號對到 855 個；控股改組前的前身 CIK 已逐一人工核對補齊）與事件清單，見 §8。

---

## 1. 歷史 S&P 500 成分股（point-in-time）

腳本：`s01_sp500_membership.py`（主測試）、`s01_sp500_membership.py others`（其他 GitHub 資料集）、`s01b_live_membership.py`（上線用的目前名單）。

### 1.1 來源比較

| 來源 | 期間 | 形式 | 更新 | 備註 |
|---|---|---|---|---|
| **fja05680/sp500**（現有 `sp500-github.csv` 的出處，`(Updated).csv`） | 1996-01-02 → **2026-08-18** | 每次異動一列、列出完整名單（2,720 列） | 志工手動，最後一列 2026-08-18 | 今天抓的版本和 LEAN 快取逐列比對 **0 列不同**。名單大小 487～507 |
| Wikipedia「Historical components of the S&P 500」（2026 年起異動表從 List 頁搬到這頁） | 1976 → 2026-10-30 | 異動表 415 列 | 即時 | **2007 年以前很稀疏**：1997–2006 每年只有 0～7 列（實際每年 20～50 次異動）；2007 起 11～30 列／年 |
| Wikipedia「List of S&P 500 companies」 | 目前 | 503 檔，含「Date added」與 CIK | 即時 | 只有目前成分股 |
| hanshof/sp500_constituents | 1996-01-02 → 2025-08-23 | 與 fja 同格式 | 停在 2025-08 | 爬 Wikipedia，2023 年以後的日期常差 1～2 天（見下表） |
| lawcal/sp500-components-history | 2007-03-05 起 | 代號 × **CIK** × 加入／剔除日（1,006 列） | 每天爬 Wikipedia | 有 CIK，B-9 拿來對照（§8）。389 個日期自己標 `*`（不確定）|
| shardul0701/SP500-Survivorship-bias-data-2004-2026 | 2004 → 2026-06 | YAML | 2026-11-06 有更新 | 基礎是 fja05680，2019 年以後對照 S&P 公告；未逐筆測 |
| SSGA SPY 每日持股（xlsx） | 只有當天 | 504 列（503 檔＋1 列 contra） | 每個交易日，約 T+1 | **上線用**。2026-11-05 的檔和 Wikipedia 目前表**完全一致**；權重＝浮動市值占比 |
| iShares IVV 持股 CSV（含 `asOfDate`） | — | — | — | 程式下載只拿到 HTML 頁（需要瀏覽器同意頁），**不可行** |
| S&P DJI 官方成分股資料 | 全部 | — | — | 付費（S&P 指數資料授權，沒有公開的個人價格；未查證） |

### 1.2 抽查（日期口徑：第一個以新名單開盤的交易日）

| 事件 | 真值 | fja05680 | Wikipedia 異動表 | hanshof | lawcal |
|---|---|---|---|---|---|
| Enron 剔除 | 2001-11-30 | 0 | 無此列 | 0 | 無 |
| NVDA 加入（取代 Enron） | 2001-11-30 | 0 | 無此列 | 0 | 0 |
| Lehman 剔除（HRS 加入） | 2008-09-17 | 0 | -1（記 9/16） | 0 | -1 |
| NFLX 加入 | 2010-12-20 | 0 | -3（記 12/17，週五收盤後生效） | 0 | 0 |
| BRK.B 加入 | 2010-02-16 | 0 | 無此列 | 0 | 0 |
| FB（META）加入 | 2013-12-23 | 0 | 0 | 0 | 0 |
| GOOG（C 股）加入 | 2014-04-03 | 0 | 無此列 | 0 | 0 |
| TSLA 加入 | 2020-12-21 | 0 | 0 | 0 | 0 |
| UBER 加入 | 2023-12-18 | 0 | 0 | -1 | 0 |
| SMCI 加入 | 2024-03-18 | 0 | 0 | 0 | 0 |
| PLTR、DELL 加入／AAL 剔除 | 2024-09-23 | 0 | 0 | -1 | 0 |
| COIN 加入 | 2025-05-19 | 0 | 0 | -2 | 0 |

單位：誤差天數（來源日期 − 真值）。真值依據 S&P DJI 公告的生效日；Enron、Lehman 兩筆是依記憶推定「收盤後生效 → 下一個交易日」，**沒有取到 S&P 原文**（S&P 舊新聞稿不在公開網站）。

**大量比對**：目前 503 檔中 Wikipedia「Date added」≥ 1997 的 367 檔，和 fja 最後一次加入日比：差 0 天 286 檔、1～3 天 22、4～31 天 11、> 31 天 43、fja 找不到 5。> 31 天的幾乎都是**代號改名或代號重用**，不是日期錯：COR（原 ABC）、ELV（原 ANTM）、CPAY（原 FLT）、EG（原 RE）在 fja 裡是改名當天才「加入」；CB、CMCSA、D、FE 是 Wikipedia 的加入日指另一個實體（例如 CB 1996 年是舊 Chubb，2016 年起是 ACE 改名的 Chubb）。分期：1997–2008 差 0 天 66%、≤ 3 天 74%；2009–2015 73%、87%；2016–2026 91%、92%。

**結論**：fja05680 的日期在抽查中是最準的（Wikipedia 有時記「收盤後生效的那一天」，早一個交易日）。它的代號是「當時的代號」，但已下市公司用最後的 OTC 代號（例如 1996 年就寫 ENRNQ、AAMRQ），而且**同一代號可能是不同公司**（CB、T、DOW、DD），價格與 CIK 對照都要按日期區段處理（§8.3）。

### 1.3 已下市公司的價格與每年的覆蓋率

LEAN 資料夾（Yahoo，2026-10-14 抓）裡，每年第一筆名單中有價格的比例（`raw/s01_price_coverage.csv`）：

| 年 | 成分股 | 有價格 | 比例 | 有權重（價格＋股數，回測股票池實際用的） |
|---|---|---|---|---|
| 1997 | 488 | 272 | 55.7% | 39.8%（＝設計 §11 的「41%」）|
| 2000 | 491 | 289 | 58.9% | 47.9% |
| 2005 | 495 | 309 | 62.4% | 54.3% |
| 2009 | 498 | 338 | 67.9% | 63.7% |
| 2013 | 497 | 368 | 74.0% | 72.0% |
| 2016 | 504 | 396 | 78.6% | 77.2% |
| 2020 | 505 | 437 | 86.5% | 90.1% |
| 2023 | 503 | 470 | 93.4% | 95.0% |
| 2026 | 503 | 493 | 98.0% | 98.4% |

（2020 年以後「有權重」大於「有價格」是因為 LEAN 的 map file 把改名前後的代號接起來，按檔名比對會少算。）

1996 年以來出現過 1,209 個代號，現在仍在名單的 503 個，離開的 706 個中 Yahoo 有價格的只有 250 個（35%）。缺的大多是被收購（ATVI、CELG、XLNX、TWTR、ABMD、WFM、MON）、破產（LEH、SIVB、FRC）與改名（ABC、ANTM）。

**免費來源能補多少**（`s07_prices.py`，2026-11-08 實測）：

| 來源 | 已下市代號 | 結果 |
|---|---|---|
| yfinance | ATVI、LEH、TWTR、CELG、XLNX、SIVB、FRC、ABMD、WFM、MON | **10 檔全部 0 筆** |
| Stooq CSV（`stooq.com/q/d/l/`） | AAPL、LEH、WB、MER… | 全部回傳「This site requires JavaScript」，**程式化下載已不可行**（連現存股票也一樣）|
| Nasdaq 非官方 API | ATVI | 「Symbol not exists」；現存股票也只給 10 年 |
| Alpha Vantage 免費 `TIME_SERIES_DAILY` | ATVI | **可以**，但免費版只有 `compact`（最後 100 個交易日：2023-05-23 → 2023-10-13）；`outputsize=full` 是付費 |
| Alpha Vantage `LISTING_STATUS&state=delisted` | — | 9,629 個已下市代號（1997-04 → 2026-11-06）、含下市日；抽查 6 檔找到 4 檔（LEH、SIVB 沒有）|

所以免費來源**補不回下市公司的完整價格歷史**；最多補到「下市前 100 天」→ 足夠取最後成交價。完整的倖存者偏差修正只有付費資料：Norgate Data（含下市股，約 US$ 270～630／年，視方案）、CRSP（學術授權）、Tiingo 付費版、EODHD（含下市股，約 US$ 20～100／月）。價格皆為 2026-11 前的公開報價、未在本次重新查證。

**依預設的處理**：被收購的用收購價（從 DEFM14A／SC TO-T 或 8-K 2.01 讀，或 Alpha Vantage 最後 100 天的最後收盤），其他用最後成交價。偏差方向：(1) 缺價格的股票被排除在股票池外，而它們多半是後來被收購（正報酬）或破產（大虧），對動能策略來說「破產股被排除」高估報酬、「被收購股被排除」影響較小；(2) 用最後成交價結算破產股，會低估下市後到 OTC 的進一步損失（偏差：高估報酬）。

### 1.4 建議做法

- **回測**：繼續用 fja05680（LEAN 快取已固定版本），2009 年以後當主要結果（覆蓋率 ≥ 64%，2016 年以後 ≥ 77%），2009 年以前只看方向（設計 §11 已寫）。
- **上線**：每個交易日下載 SSGA SPY 持股 xlsx，自己每天把 SPY 持股檔存一份成分股快照（這和設計 §2.1.1 的使用者持股快照帳本是兩回事，不要共用）；Wikipedia 目前表當交叉檢查，兩者不一致時不換股、發警告。上線後自己累積的快照就是之後的 point-in-time 名單，不依賴 fja05680。

---

## 2. 選股漏斗：前一日成交金額與當時市值

腳本：`s02_market_cap_xbrl.py`（輸出 `raw/s02_cap_checks.csv`）。

### 2.1 XBRL 股數 × 價格

做法：日期 t 用 filed ≤ t 的最新一筆股數；股數的 `end`（股數基準日）之後若有分割，乘上分割倍數換成 yfinance 的口徑（yfinance `Close` 一律已分割調整）；再乘 t 的 `Close`。

| 公司 | 日期 | 報導市值 | dei:EntityCommonStockSharesOutstanding | us-gaap:CommonStockSharesOutstanding | 分割處理 |
|---|---|---|---|---|---|
| AAPL | 2018-08-02 | 1.00 兆 | +0.2% | +0.4% | 股數是 2020 分割前 → ×4 |
| AAPL | 2022-01-03 | 2.99 兆 | -0.1% | 0.0% | |
| AAPL | 2023-06-30 | 3.04 兆 | +0.4% | +0.3% | |
| NVDA | 2023-05-30 | 1.00 兆（盤中） | -0.9% | -1.1% | ×10（2024 分割） |
| NVDA | 2024-06-18 | 3.34 兆 | -0.1% | 0.0% | 分割（6/10）後 8 天，最新申報仍是分割前股數 2.46B → ×10 |
| NVDA | 2025-07-10 | 4.0 兆 | +0.1% | +0.4% | |
| TSLA | 2021-10-25 | 1.0 兆 | +2.9% | +2.9% | ×3（2022 分割）；里程碑是盤中 |
| MSFT | 2019-04-25 | 1.0 兆（盤中） | -1.0% | -1.0% | |
| AMZN | 2020-02-04 | 1.0 兆 | +2.0% | +2.1% | ×20 |
| GOOGL | 2020-01-16 | 1.0 兆（合計） | **無**（按類別申報） | +0.2%（三類合計股數 × GOOGL 價）| ×20 |
| META | 2021-06-28 | 1.0 兆 | **無** | **無** | 加權平均股數（基本）× 價格：+1.3% |
| BRK | 2024-08-28 | 1.0 兆 | **最後一筆 2011-05**，算出 4.4 億（錯） | 無 | 加權平均股數（A 股約當）最後一筆 2015-11 → +14.5% |

**口徑重點**

- **申報值是當時的股數，不會回溯調整分割**（NVDA 2024-05-29 申報 24.6 億，2024-08-28 申報 245.3 億）。所以一定要用 `end` 之後的分割倍數換算；不換算時分割後到下一次申報之間（最長約 3 個月）市值會差 10 倍。
- **多類股**：dei 封面股數按類別申報（帶維度），companyfacts 不收帶維度的事實 → GOOGL、META 沒有 dei；BRK 只有早期幾筆。備案順序：dei → `CommonStockSharesOutstanding`（GOOGL 是三類合計）→ `WeightedAverageNumberOfSharesOutstandingBasic`（季度期間；跨類別合計，EPS 用）。BRK 這兩個都停在 2015 以前，要另外處理（讀 10-Q 封面文字的 A、B 股股數；或用 SPY 權重）。
- **S&P 指數的權重是浮動市值**，XBRL 算的是全部股數；排序「市值前 50」時兩者差別只在大股東持股多的公司（例如 META、GOOGL、BRK 的創辦人持股），對前 50 名的組成影響很小（未逐月量化）。
- **XBRL 從哪年開始**：大型加速申報公司 2009-06-15 以後的期間開始申報。實測最早 filed：AAPL 2009-07-22、AMZN 2009-07-24、XOM 2009-08-05、JPM 2009-08-10、NVDA 2009-08-20、MSFT 2009-10-23、BRK 2009-11-06、MU 2010-01-12（TSLA 2011-08，2010 年才上市）。其他公司 2011-06 前全部要申報。所以 **2009-H2 起可用，2011-H2 起所有成分股都有**。
- **2009 年以前沒有 XBRL**：免費選項只有讀 10-K／10-Q 封面文字（「As of … there were N shares outstanding」，可用正則抽，但格式不一）或 Yahoo 的 2015 起股數往前補（現在的做法）。依預設「早期缺資料就從資料完整的年份開始，不硬補」：用 XBRL 的回測從 2010 年開始，2009 年以前維持現狀並標註。
- **現有回測的近似**：LEAN 資料夾的市值權重 = 價格 × Yahoo 股數；Yahoo 股數最早 2015-10（AAPL 2015-10-28），更早的用 `bfill()` 補成 2015 年的股數（`leandata/weights.py` 第 101–103 行）。2015 以前股數變化大的公司（大量買回的 AAPL、IBM；大量增發的銀行 2008–09）排序有誤差。

### 2.2 成交金額

- yfinance `auto_adjust=False` 的 `Close` 和 `Volume` 都已分割調整（價 ÷ k、量 × k），乘積就是當天實際成交金額，分割前後一致。NVDA 2024-06-07（分割前一個交易日）498.5 億、06-10（分割日）381.7 億，連續。
- `auto_adjust=True` 會把股利也調進價格，乘積被壓低（NVDA 只差 0.3%；高股息股、越早的年份差越多），**不要用**。
- LEAN 回測用的是 LEAN daily 的原始價 × 原始量，和上面的口徑相同。
- 上線：前一日收盤後抓 yfinance `Close × Volume`。

### 2.3 建議做法

- **上線**：市值排序直接用 SSGA SPY 持股檔的權重（就是 S&P 的浮動市值占比，跟指數本身一致，不用自己算股數）。前一日成交金額用 yfinance。
- **回測（2010 起）**：XBRL 股數 × yfinance Close，備案順序如上；BRK 用 SPY 權重不可得（沒有歷史），改為固定納入（BRK 2010 年以來一直在市值前 10）或讀 10-Q 封面。2009 年以前維持現有近似。

---

## 3. SEC EDGAR

### 3.1 submissions JSON

腳本：`s03_edgar_submissions.py`（10 家：AAPL、MSFT、JPM、XOM、GE、NVDA、MU、KO、C、WMT）。

- **items 欄位**：10 家合計 1996–2026 每年的 8-K **100% 都有 items**（`raw/s03_8k_items_by_year.csv`）。最早有 items 的 8-K 是 1994 年（MU 1994-03-07、C 1994-01-13）。
- **編號**：2004-08-23 以前是舊制 Item 1～12（例如 `5,7`＝其他事件＋附件），之後是新制 `x.xx`。10 家最後一筆舊式在 2004-06-23～08-20，第一筆新式在 2004-08-31～10-27。**Item 4.01、4.02 從 2004-08-23 起才存在**；舊制 Item 4 是「更換會計師」，非依賴（non-reliance）在舊制沒有專屬 item（多半放 Item 5）。所以「items 可信的起始年」：**2005 年起可直接用 4.01／4.02；2009 起（B-9 的範圍）完全沒問題**。
- **items 的值**：前幾名 9.01（3,374）、8.01、2.02、5.02、7.01；舊制 `5`（329）、`7`（307）。這 10 家合計 4.02 有 6 筆、4.01 有 3 筆。
- **acceptanceDateTime 的時區**：JSON 的 `Z` **是真的 UTC**。和申報索引頁（美東時間）比 9 筆：11 月差 5 小時（EST）、7～9 月差 4 小時（EDT），全部吻合。例：AAPL 10-K JSON `2026-11-03T13:05:15Z` = 索引頁 `08:05:15`。
- **盤後申報**（2015 起，換成美東時間）：

| 表格 | 9:30 前 | 盤中 | 16:00–17:30 | 17:30 以後 |
|---|---|---|---|---|
| 8-K | 491 | 224 | 1,146 | 55 |
| 10-Q | 35 | 96 | 196 | 30 |
| 10-K | 12 | 21 | 75 | 12 |

  17:30（美東）以後接收的申報，`filingDate` 是下一個營業日（2,393 筆中 89 筆 filingDate ≠ 接收日），但申報在接收當下就公開。**對應規則**：以 `acceptanceDateTime` 換成美東時間；< 09:30 → 當天開盤可交易；09:30～16:00 → 當天盤中已反應，本系統（日線、收盤後算訊號）視為當天收盤後可得，下一個開盤執行；≥ 16:00 → 下一個交易日開盤。不要用 `filingDate`。
- **分頁**：`filings.recent` 至少 1,000 筆（JPM 26,470 筆、C 13,191 筆，其餘 1,000～1,006），更早的在 `filings.files`（每頁有 `filingFrom`／`filingTo`）。JPM 71 頁、C 41 頁（結構型債券的 424B2 灌爆），一般公司 1～2 頁。
- **其他欄位**：`tickers`（只有現在的代號）、`formerNames`（含日期），已下市公司的 `tickers` 是空的。

### 3.2 更舊的申報、全文搜尋、bulk 檔

- **full-index 季度 index**（`/Archives/edgar/full-index/YYYY/QTRn/form.idx`）：欄位只有 Form Type、Company Name、CIK、Date Filed、File Name。**沒有 items、沒有接收時間**。2003Q1 8-K 12,478 筆、2005Q1 28,127 筆、2026Q3 15,273 筆。
- **EDGAR 全文搜尋**（`efts.sec.gov/LATEST/search-index`，非正式 API）：回傳欄位有 `items`、`file_date`、`form`、`ciks`、`adsh`、`period_ending`、`sics`；每頁 100 筆。「non-reliance」2001 年 8-K 115 筆；2000 年查「restatement」0 筆 → **2001 年起**。「Item 4.02」2010 年 8-K 568 筆。另有實體搜尋 `?keysTyped=名稱`（回傳 CIK 與名稱，§8 用來找下市公司的 CIK）。
- **bulk**：`submissions.zip` 1.57 GB、`companyfacts.zip` 1.42 GB（`/Archives/edgar/daily-index/…`，每天約 04:30 UTC 更新）。一個請求就拿到全部公司。
- 限速：SEC 公告每秒 10 次；本次一律 ≤ 4 次／秒、User-Agent 從 `.env` 讀，沒有被擋。

### 3.3 XBRL companyfacts／frames 的 point-in-time

腳本：`s04_companyfacts_pit.py`（輸出 `raw/s04_restated_periods.csv`）。

| 公司 | 期間 | 原始值（filed） | 中間 | 重編後（filed） | frames 回傳 |
|---|---|---|---|---|---|
| Molson Coors（8-K 4.02，2019-02） | FY2016 NetIncomeLoss | 1,975.9M（2017-02-14） | 1,993.0M（2018-02-14） | **1,593.9M**（2019-02-12） | CY2016 = 1,593.9M（2019 申報） |
| Molson Coors | FY2016 IncomeTaxExpenseBenefit | 1,050.7M（2017-02-14） | 1,055.2M | 1,454.3M（2019-02-12） | CY2016 = 1,454.3M |
| Molson Coors | FY2017 NetIncomeLoss | 1,414.2M（2018-02-14） | — | 1,565.6M（2019-02-12） | CY2017 取 2020 申報 |
| Kraft Heinz（2019 重編） | FY2016 NetIncomeLoss | 3,632M（2017-02-23、2018-02-16） | — | 3,596M（2019-06-07） | CY2016 = 3,596M |
| Kraft Heinz | 2017Q3 累計 COGS | 12,406M（2018-11-02） | — | 12,489M（2019-06-07） | |

- **companyfacts 保留每一份申報的值**（包括後來申報裡的比較期數字），每筆有 `accn`、`filed`、`form`、`fy`、`fp`、`frame`、`start`、`end`。所以「某天看得到的數字」＝ `filed ≤ as_of` 中最新的那筆（要「首次公布值」就取最早的）。
- **同一期間有 ≥ 2 個不同值**的比例：TAP 4.2%、KHC 6.9%（包含重編與一般重分類），不算罕見。
- **frames 不是 point-in-time**：每個期間只回最新申報的值（含重編後）；`frame` 欄位在 companyfacts 裡也只標在「最新那筆」上。
- **陷阱**：`fy`、`fp` 是**申報文件**的會計期間，不是這個數字的期間（例如 2019 年的 10-K 裡 FY2016 的數字 `fy=2018`）。期間一律用 `start`／`end`。
- 只收不帶維度的事實（多類股的股數、分部營收不在裡面）。

### 3.4 建議做法

- **上線**：每天收盤後抓持股＋候選股的 submissions JSON（約 15～20 個請求），用 `acceptanceDateTime` 判斷新申報；即時性可再加 `browse-edgar?action=getcurrent&output=atom`（實測可用）。財報數字用 companyfacts，取 `filed ≤ as_of`。
- **回測**：2009 起，用 submissions（或 bulk zip）＋ companyfacts 的 `filed`。不要用 frames。

---

## 4. FRED／ALFRED

腳本：`s05_fred_alfred.py`（輸出 `raw/s05_fred_summary.csv`）。

| 系列 | 觀測起點 | 第一個 vintage | vintage 數 | 會不會修正（實測） | point-in-time 做法 |
|---|---|---|---|---|---|
| BAA10Y | 1986-01-02 | 2014-01-27 | 2,997 | 不會（2020-04-14、2023-12-28 當時值＝現值） | 直接用現值 |
| T10Y2Y | 1976-06-01 | 2014-01-27 | 3,158 | 不會 | 直接用現值 |
| T10Y3M | 1982-01-04 | 2014-01-27 | 3,157 | 不會 | 直接用現值 |
| VIXCLS | 1990-01-02 | 2010-11-22 | 3,968 | 不會 | 直接用現值（或 yfinance `^VIX`）|
| NFCI | 1971-01-08 | 2011-05-25 | 803 | **會**：2020-04-10 當時 -0.02，現在 0.292 | 2011-05 起用 vintage；更早只能用現值（有前視偏差）|
| ICSA | 1967-01-07 | 2009-05-28 | 905 | **會**：2020-03-28 那週初值 6,648K → 現值 5,946K | 2009-05 起用 vintage |
| UNRATE | 1948 | 1960-03-15 | 801 | 小（季節因子） | vintage |
| PAYEMS | 1939 | 1955-05-06 | 861 | **會**：2008-09 當時 137,318K → 136,760K | vintage |
| INDPRO | 1919 | 1927-01-26 | 1,224 | **會**（含基期改變）：2008-08 當時 110.30 → 現在 98.11 | vintage；用變化率不用水準 |
| SAHMREALTIME | 1959-12 | 2019-09-06 | 86 | 系列本身就是用首次公布值算的 | 直接用 |
| **BAMLH0A0HYM2** | **2023-11-07** | **2023-11-07** | 786 | — | **歷史不可得** |
| BAMLH0A2HYB、BAMLC0A0CM（同為 ICE） | 2023-11-07 | 2023-11-07 | 786、784 | — | 同上 |

- **ICE BofA 系列**：今天只有 794 筆、從 2023-11-07 起（＝今天往前 3 年，滾動）。用舊的 realtime 去查：as of 2025-06-02、2026-03-02、2026-05-01 第一筆都是 2023-11-07；as of 2023-01-03、2020、2015 都回 HTTP 400。**ALFRED 的舊 vintage 也被重寫成只剩 3 年**，FRED 上已經沒有 2023-11 以前的高收益債利差。替代：`BAA10Y`（Moody's Baa − 10 年公債，1986 起、不修正）；ICE 原始資料要向 ICE Data Services 購買（機構授權）。
- realtime 早於第一個 vintage 時，API 回 **HTTP 400**（不是空資料），程式要處理。
- `output_type=2`（每個 vintage 一欄，例如 `UNRATE_20081003`）、`output_type=4`（只要首次公布值）都可用。
- `ai_layer` §7 說 `TA` 的 `fred.py` 用 `realtime_start = realtime_end = as_of`：對 BAA10Y／T10Y2Y／VIXCLS 等，as_of 早於 2014-01-27（或 2010-11-22）會拿到 400，**要改成「沒有 vintage 的不修正系列直接取現值」**。
- 免費額度：FRED API 每分鐘 120 次；本次以 0.6 秒間隔，沒有被擋。
- 發布延遲（`plan_review` 附錄 A 缺口 2）：VIXCLS、BAMLH0A0HYM2 的 `last_updated` 是隔天 08:38／09:08 CST，台灣 06:00 跑時拿不到前一天的值（和審查結論一致）。

**建議**：上線與回測都用 FRED API；儀表板的信用利差改 `BAA10Y`（`BAMLH0A0HYM2` 只在上線時顯示當前值，不進歷史參考類別）；會修正的系列（NFCI、ICSA、PAYEMS、INDPRO、UNRATE）回測一律用 vintage，NFCI 2011-05 以前標「非 point-in-time」。

---

## 5. 新聞

腳本：`s06_news.py`（輸出 `raw/s06_news_coverage.csv`）。抽查 MU、NVDA、MSFT、META＋中型股 LSTR（Landstar）、EXP（Eagle Materials）、CELH（Celsius）。

| 來源 | 結果（2026-11-08） | 全文 | 回溯 | 延遲 | 限制與條款 |
|---|---|---|---|---|---|
| **Alpha Vantage NEWS_SENTIMENT** | 免費 key 回「This is a premium endpoint」 | — | 未能測（付費才能查 `time_from`） | — | **付費**。另外 `TIME_SERIES_DAILY_ADJUSTED`、`outputsize=full` 也是付費；免費每天 25 次、每秒 1 次（實測連打兩次就被擋）|
| Google News RSS（搜尋） | 7 天內：大型股各 100 筆（上限），LSTR 18、EXP 51、CELH 84；最新一筆 1.5～22 小時前 | **沒有**：description 只有標題＋來源；連結是 `news.google.com/rss/articles/…` 轉址，要跑 JavaScript 才到原站 | `after:`／`before:` 查 2020-03-16 只回 1 筆、2015-06-25 只回 1 筆，而且時間只到「日」 → **不能回溯** | 新聞發布後數十分鐘～數小時（只抽到 MU 財報當天的標題，時間戳是當天 07:00 UTC，無法量到分鐘） | 沒有官方 API；Google 服務條款禁止以自動化方式大量存取，個人低頻使用是灰色地帶 |
| Nasdaq 個股 RSS（`nasdaq.com/feed/rssoutbound?symbol=`） | 7 檔都有、各 15 筆 | 沒有（description ≤ 308 字元），連結是 nasdaq.com 文章頁 | 只有最近 15 筆 | — | 非官方 |
| yfinance `Ticker.news` | MU 10 筆 | 只有 summary | 只有最近 | — | 非官方 |
| 公司 IR RSS | NVDA `nvidianews.nvidia.com/releases.xml` 20 筆；META `about.fb.com/feed/` 10 筆；MSFT `news.microsoft.com/feed/` 最新一筆 **2025-05-07**（已停更）；MU、LSTR、EXP、CELH 試的 Q4 標準路徑 403／404 | 部分有（META 5,352 字元） | 只有最近 | 和新聞稿同時 | 每家網址不同，要人工找；中小型公司常常沒有 |
| SEC 新聞稿 RSS（`/news/pressreleases.rss`） | 25 筆（2026-09-14 → 11-04） | 連結到 sec.gov 原文 | 只有最近 25 筆；舊的在 sec.gov 網頁 | 即時 | 官方、免費 |
| SEC 訴訟公告 RSS（`/enforcement-litigation/litigation-releases/rss`） | 25 筆（09-30 → 11-03）；舊網址 `/rss/litigation/litreleases.xml` 回 503 | 原文 | 同上 | 即時 | 官方 |
| **EDGAR 8-K 附件 EX-99.1**（新聞稿本身） | MU、NVDA、MSFT、META、LSTR 最近一次 8-K 2.02 都有 | **有**：純文字 22,020～33,444 字元 | 2001 年起（全文搜尋）／1994 起（檔案） | 接收時間 16:02～16:22 ET，和通訊社發布（約 16:00）相差 0～20 分鐘 | 官方、免費。附件檔名沒有規則（NVDA 是 `q2fy27pr.htm`），要讀索引頁的 Type 欄 |
| EDGAR 即時 Atom（`getcurrent`） | 可用，40 筆 | 連到申報 | — | 即時 | 官方 |
| GDELT DOC 2.0 | 從本機 IP 連續 4 次都回 HTTP 429（每 12 秒一次也一樣）| — | **未能實測** | — | 免費 |
| Finnhub、NewsAPI、Tiingo | 需要註冊帳號，依規則不註冊 | — | 依 `ai_layer` §8.2：Finnhub 免費 1 年、NewsAPI 免費 1 個月 | — | — |

**Alpha Vantage 付費方案**（官網 premium 頁，2026-11 前的價格，未在本次重新查證）：約 US$ 50／月（75 次／分）起，最高約 US$ 250／月；新聞起始日官方未寫，常見說法約 2022 年，付費後才能實測。

**判定：有條件可行。**

- **F18 每日掃描**：規則偵測段只用 EDGAR（可行、可回測）；LLM 判讀段的新聞只有標題可用 → 標題只能當「初判」，任何會產生通知的判斷都要回到 EDGAR 原文或 SEC 公告。
- **F25 事件條件**：要讀原文才算成立（`ai_layer` §2.3 的引用檢查要求引文是原文子字串）。免費來源能確認的只有「會出現在申報或 SEC 公告的事件」（公司自己的 8-K、10-Q 內容、SEC 執法）。產業新聞類（DRAM 合約價、客戶削減資本支出、立法）免費來源只有標題 → **不成立**，只能記錄。
- **F19**：SEC 新聞稿與訴訟公告免費可用（`REGULATORY` 的官方事件）；放空報告與一般監管新聞仍要靠新聞原文。

---

## 6. 價格

腳本：`s07_prices.py`（輸出 `raw/s07_yf_quality.csv`）。

| 檢查 | 結果 |
|---|---|
| yfinance 8 檔（AAPL、MSFT、NVDA、XOM、KO、MU、BRK-B、SPY）1996 起 | 以 SPY 的交易日為準，缺值 0 天、Close 為 NaN 0 天、量為 0 的 0 天 |
| 分割、股利 | 都有（AAPL 分割 4 次、股利 57 次；NVDA 分割 6 次）|
| `auto_adjust=True` 的 Close vs `auto_adjust=False` 的 `Adj Close` | 最大差 1.6e-6，一致 |
| 和 LEAN 快取（Yahoo，2026-10-14 抓）比未調整收盤 | 7 檔 × 6,954～7,726 天，差 > 0.1% 的 **0 天**（最大 0.0005%）|
| 252 日還原報酬（MOMP）今天 vs 10/14 | AAPL、XOM、KO、MU 各 6,715 天，最大差 0.0043%（KO 2002-07-01）|
| 已下市代號 | 10 檔全部 0 筆（§1.3）|
| Nasdaq API vs yfinance（AAPL 2016-11 → 2026-11） | 2,514 天、差 > 0.1% 的 0 天，最大 0.073%；Nasdaq 價格也已分割調整（2020-08-28 124.81）|

**yfinance 已知問題**（實測＋套件行為）：

- 近期版本的 `yf.download` 預設 `auto_adjust=True`（`Adj Close` 欄消失）；`Ticker.history` 也預設 True。程式要明確寫 `auto_adjust=False`。
- `Close` 永遠是分割調整後；沒有真正的原始價（要自己乘回分割倍數，LEAN 的作法）。
- 股利調整是事後回溯的：每次新的除息都會改寫所有更早的 `Adj Close`，所以「當時算的 MOMP」和「今天算的」會差一點（上面實測最大 0.004%，對排名沒有影響）。
- 盤中呼叫會拿到當天未完成的 K 線（`plan_review` 附錄 A）；要在收盤後、而且確認最後一根的日期。
- 限流：本次大約 30 個請求沒有遇到；Yahoo 偶爾回 429／空資料，要重試並檢查筆數。
- 已下市代號拿不到。

**備援**：

| 來源 | 實測 | 限制 |
|---|---|---|
| Nasdaq 非官方 API | 可用，和 yfinance 一致 | 只有 10 年；沒有股利還原；非官方、無條款保證 |
| Alpha Vantage `TIME_SERIES_DAILY` | 免費只有最後 100 天（`compact`） | `full` 與還原權值都付費；每天 25 次 |
| Stooq | 需要 JavaScript，不可行 | — |
| Tiingo 免費版 | 需要註冊（依規則未測） | 據官網說明（未重新查證）免費版每日約 1,000 次、含長期日線 |

**建議**：上線用 yfinance（收盤後跑、`auto_adjust=False`、存每日快照，`Adj Close` 自己用分割＋股利算）；備援 Nasdaq API 只拿最近幾天的收盤做交叉檢查（兩者差 > 0.5% 時不發訊號、發警告）。真正可靠的第二來源需要註冊 Tiingo（免費），列為使用者決定事項。

---

## 7. 總表

| 功能需要的資料 | 來源 | 判定 | 回測可用期間 | 上線做法 | 費用 |
|---|---|---|---|---|---|
| 當月 S&P 500 成分股 | fja05680（回測）、SSGA SPY 持股（上線） | 回測可行／上線有條件可行 | 1996 起（覆蓋率見 §1.3） | 每日下載 SPY xlsx 存快照 | 免費 |
| 已下市股價 | Yahoo（部分）、Alpha Vantage 最後 100 天 | 有條件可行 | 2016 起 ≥ 77% 覆蓋 | 不需要 | 免費；完整需付費 |
| 前一日成交金額 | yfinance Close × Volume | 可行 | 全期 | 同 | 免費 |
| 當時市值 | SPY 權重（上線）、XBRL 股數 × 價格（回測） | 有條件可行 | 2009-07 起（2011-H2 全部） | SPY 權重 | 免費 |
| 8-K items、NT、M&A、增資申報 | EDGAR submissions | 可行 | 4.01／4.02 自 2004-08；其他 1994 起 | 每日抓 | 免費 |
| 財報數字（point-in-time） | companyfacts（`filed`） | 可行 | 2009-07 起 | 同 | 免費 |
| 財報數字（frames） | frames | 不可行（非 PIT） | — | 不用 | — |
| 總經儀表板 | FRED／ALFRED | 可行（BAMLH0A0HYM2 除外） | 見 §4 | 同 | 免費 |
| 高收益債利差歷史 | FRED | 不可行 | 2023-11-07 起 | 只顯示當前值 | ICE 機構授權 |
| 新聞全文 | EDGAR EX-99.1、SEC 公告 | 可行（限申報事件） | 2001 起 | 同 | 免費 |
| 新聞（一般、產業） | Google News／Nasdaq RSS（只有標題）；Alpha Vantage（付費） | 有條件可行 | 不能回溯 | 標題當初判 | 付費約 US$ 50／月起 |
| 每日價格 | yfinance＋Nasdaq 交叉檢查 | 可行 | 1996 起（現存股） | 同 | 免費 |

---

## 8. 給 B-9 回測的資料說明

（下一個 subagent 用：2009 年起、S&P 500 大型股上的 8-K 4.02／4.01、NT 10-K／10-Q、PREM14A／DEFM14A／SC TO-T／SC 14D9、S-3／424B 事件研究與動能策略回測。）

### 8.1 已建好的快取（直接用，不用重抓）

| 檔案（`research/data_sources/raw/`） | 內容 |
|---|---|
| `b9_sp500_cik_map.csv` | 896 列：2009-01-01 以後在指數內出現過的 866 個 fja 代號中的 855 個 → 849 個 CIK。欄位：`ticker, cik, name, first_in, last_in, valid_from, valid_to, source, name_sim, earliest_filing, latest_filing, flag, note`。同一代號可以有多列，**每列是一段「這個代號在指數內、由這個 CIK 申報」的期間**（控股公司改組、合併、分拆、代號重用）。`source`：`lawcal`（798，Wikipedia 歷史＋CIK）、`manual_verified`（86 列／56 個代號，人工核對，`note` 寫依據）、`manual_predecessor`（6：BLK→1364742、DIS→1001039、XOM→34088、GOOGL／GOOG→1288776、DD→30554）、`map_v1`（6，company_tickers 對到且名稱一致）。`flag` 以「無前身」開頭的 4 個代號（GGP、HLT、KMI、TT）是確認過不需要前身 |
| `b9_unmapped.csv` | 對不到 CIK 的 11 個：AABA、ANRZQ、ATGE、BTUUQ、CITGQ、EKDKQ、HSH、MTLQQ、RSHCQ、SUNEQ、WYND（多數是破產後的 OTC 代號，要用公司名查）|
| `b9_edgar_events.csv`（43 MB，452,019 列） | 這 849 個 CIK 2009-01-01 以後的目標申報（**含指數期間以外的**，要用對照表的區段過濾）：8-K／8-K/A（items 含 4.01、4.02、1.01、1.03、2.03、3.02）、NT 10-K／10-Q、PREM14A／DEFM14A（含 C）、SC TO-T、SC 14D9（含 /A）、S-3、S-3ASR、S-4、424B1～B8。欄位：`cik, ticker, form, items, filingDate, acceptanceDateTime, accessionNumber, primaryDocument` |
| `b9_scan_stats.json`、`b9_event_counts.csv` | 各類筆數（`b9_event_counts.csv` 是按區段過濾後的指數期間內筆數，§8.3 的表）；`b9_401_2014.csv` 是 2014 年的 4.01 明細 |
| `s01_fja_now.csv`、`s01_lawcal_components_history.csv`、`s01_wiki_changes.csv` | 成分股名單三個來源 |
| `s07_av_delisted.csv` | Alpha Vantage 已下市代號清單（含下市日）|
| `http_cache/`（約 610 MB） | 所有 submissions JSON 與分頁的原始回應 |

**前身 CIK 與錯配的核對（2026-11-08 補做）**：用 `s09_predecessor_lookup.py` 對每個代號以公司名稱查 EDGAR 實體搜尋，再用 submissions 的名稱、前名（`formerNames`）、最早／最晚申報與 10-K／10-Q 數量核對，結果寫在 `s08_cik_map_and_scan.py` 的 `MANUAL_SEGMENTS`（每段附依據），以 `s08_cik_map_and_scan.py fix` 套用。範圍：(1) 原本「找不到前身」的 28 個代號全部處理：25 個補上前身或改正 CIK，3 個確認「無前身」（GGP：2009–2013-12 不在指數，重新加入時已是 2010 重整後的 CIK；HLT：2007 私有化、2017 才重新加入；TT：代號 2020 起才有，之前同一 CIK 用 IR 代號）。其中 10 個原本對到的是**沒有 10-K 的子公司或另一家公司**：CCE 前段、DISCA、LO、SUN（對到 Sunoco LP）、TWX、WIN、WLTW、BMS、ARNC（2020 分拆的新 Arconic）、Q（對到 IQVIA，實際是 Qwest／Qnity）。(2) 自動找到的 20 列 `predecessor` 逐筆抽查：16 個正確（AGN、BHGE、CEG、CI、COV、DTV、ESRX、FRX、ICE、IR、MDT、PRGO、RDC、SNDK、WFM、XRX；其中 AGN、ESRX、PRGO、SNDK 的轉換日或區段修正，例如 SNDK 原本把舊 SanDisk 延到 2024）；錯的 4 個已改：AVGO（錯成舊 Broadcom Corp，改為 Avago 1441634 → Broadcom Ltd 1649338 → Broadcom Inc）、CBE（改為 Cooper Industries Ltd／plc 1141982）、NLSN（子公司 → Nielsen Holdings 1492633）、KMI（2012 才加入，已是新 CIK，標「無前身」）。(3) 另外抽查剩下的 `map_v1` 15 列，9 列錯配已改：AKS、DISCK、ETFC（原本對到 Eco-Trade Corp，代號重用）、HNZ（原本對到 Frey Heinz）、JNY、LVLT、SEE、STR、TWC（多為子公司）。轉換日是控股改組／合併生效日（依記憶，並用後繼 CIK 的最早申報日佐證），可能差幾天；區段之間的申報若落在空隙會被排除。仍然對不到 CIK 的只剩 `b9_unmapped.csv` 的 11 個（多數是破產後的 OTC 代號，另有 AABA、WYND，要用公司名稱另外查）。

### 8.2 怎麼抓、要幾個請求

| 用途 | Endpoint | 每家公司請求數 | 本次實際 |
|---|---|---|---|
| 申報清單（form、items、時間） | `https://data.sec.gov/submissions/CIK##########.json` ＋ `filings.files` 中 `filingTo ≥ 2009-01-01` 的分頁 | 1 ＋ 分頁數（一般公司 0～1；JPM 67、MS 42、C 38、GS 37、BAC 20） | 849 ＋ 956 頁 = 1,805 個請求 |
| 對 CIK | `company_tickers.json`（1）＋ `efts…?keysTyped=`（名稱搜尋）＋ 候選的 submissions | — | 約 1,180 個請求（map2）＋前身查詢約 150 個 |
| 申報原文（增資金額、辭任或解任、收購價） | `https://www.sec.gov/Archives/edgar/data/{cik}/{accn無橫線}/{primaryDocument}`；附件看 `{accn}-index.htm` 的 Type 欄 | 每筆事件 1～2 | 未抓（見 8.4） |
| 一次拿全部 | `https://www.sec.gov/Archives/edgar/daily-index/bulkdata/submissions.zip`（1.57 GB） | 1 | 未下載；如果要重建，比逐家抓省時 |

以 4 次／秒計，1,805 個請求理論 8 分鐘；第一次實際約 25 分鐘（銀行的分頁 JSON 很大）。重跑時全部讀快取，幾秒鐘。

### 8.3 掃描結果（指數期間內＝filingDate 落在該 CIK 某一列的 `valid_from`～`valid_to`）

腳本：`s08_cik_map_and_scan.py stats`（輸出 `raw/b9_event_counts.csv`）。括號裡是補做前（2026-11-08 第一版）的數字。

| 事件 | 全部 | 指數期間內 | 公司數 | 每年 |
|---|---|---|---|---|
| 8-K 4.02 | 64（66） | **38**（38） | 36 | 每年 0～4（2015 年 0）|
| 8-K 4.01 | 188（193） | 123（124） | 85 | 2014 年 19，其他 1～10 |
| NT 10-K／NT 10-Q | 177（193） | **83**（96） | 50 | 1～12 |
| PREM14A／DEFM14A／14C／SC TO-T／SC 14D9（不含 /A） | 722（711） | 537（521） | 286 | 12～55（**含收購方自己的申報**，見 8.5）|
| 其中 SC 14D9（只有被收購方會申報） | 38 | 26 | 19 | 0～5 |
| S-3／S-3ASR | 3,895（3,885） | 3,047（3,067） | 672 | 131～206 |
| 424B* | 423,770（423,790） | 399,747（400,314） | 677 | 2009 年 2,712 → 2025 年 63,873 |
| 其中 424B2 | 400,794 | 380,601 | 413 | **幾乎全是 JPM、GS、C、MS、BAC 的結構型債券** |
| 8-K 1.03（破產） | 68（70） | **14**（18） | 8 | AAL 2011、PCG 2019、CHK 2020 等 |
| 8-K 3.02（未登記股票發行） | 1,246 | 702 | 255 | 22～66 |

和第一版的差異主要來自兩件事：(1) 錯配修正：第一版 NT 的 96 筆裡有 13 筆其實是 ETFC 代號被對到的 Eco-Trade Corp（空殼公司）的申報；(2) 指數期間改成按區段計算（第一版用每個 CIK 的最早到最晚，會把不在指數的空檔算進去，例如 GGP 2009–2010 的破產申報、NE 2009–2010 的空檔）。4.02 筆數不變，但組成有小幅更換。

**2014 年的 4.01（19 筆）**：是 13 家公司，其中 6 家各有兩筆（先公告解任、再補一份公告新會計師：AAL、WMB、VTR、ISRG、GRMN、NEM）。不是同一家事務所的批量輪替（涉及 Deloitte、EY、KPMG、PwC 各家），也不是控股改組。組成：審計委員會主動換所 7 家（ABT、HBAN、HON、SEE、ISRG、NEM、TRIP）、合併後統一會計師 3 家（AAL 併 US Airways、WMB 併 Access Midstream、PRGO 併 Elan）、**員工退休計畫換會計師 2 家（GRMN、PRU，不是公司本身的會計師）**、VTR 同一份 8-K 也有 4.02。沒有一筆是會計師辭任。結論：2014 年偏多是個別事件剛好集中，對 B-9 的提醒是「4.01 要讀內文，排除退休計畫與合併後統一換所」。

已知事件抽查（全部抓到）：TAP 4.02 2019-02-12 06:51 ET；KHC 4.02 2017-11-06、2019-05-06；SMCI NT 10-K 2024-08-30、4.01 2024-10-30（EY 辭任）與 2024-11-18（新會計師）；CERN（被 Oracle 公開收購）SC TO-T 與 SC 14D9 都在 2022-01-19。

### 8.4 各欄位與資料的可信度、怎麼用

- **items 可信的起始年**：B-9 的範圍（2009 起）全部是新制 items，100% 有值（§3.1）。items 是申報人在表頭自己勾的，不需要讀內文就能篩。
- **4.01 辭任或解任**：items 分不出來，要讀 8-K 內文（關鍵字 `resigned`／`declined to stand for re-election`／`dismissed`、`The Audit Committee approved the dismissal`）。123 筆，逐筆抓原文約 123 個請求。另外要排除員工退休計畫（`... Retirement Plan`／`Savings Plan`）換會計師的 4.01，它們也勾 4.01（2014 年 19 筆中就有 GRMN、PRU 3 筆）。
- **時間**：用 `acceptanceDateTime`（UTC）換成美東；≥ 16:00 的算下一個交易日（§3.1）。例：SMCI NT 10-Q 的 `filingDate` 是 2024-11-13，接收時間是 2024-11-12 21:56 ET。
- **增資金額**：
  - 424B 封面第一段就寫種類和金額，例如 W&T Offshore 424B5（2025-08-28）「Up to $83,001,247 of Common Stock」，可以用正則從前 2,000 字元取出「$金額 + of Common Stock／Notes」。
  - 這次抽查的 ATM 424B5 沒有 `EX-FILING FEES`（申報費 XBRL 附件）；費用附件多半附在 S-3 本身，不能依賴。
  - XBRL（companyfacts）有事後的 `ProceedsFromIssuanceOfCommonStock`、`StockIssuedDuringPeriodValueNewIssues`，但是一季後才出現、而且是期間合計，只能當確認。
  - **必須先過濾債券**：大型股的 424B2／424B3／424B5 絕大多數是債券。建議 `DILUTION` 候選只取「424B5／424B4／424B1 且封面含 `Common Stock`（不含 `Notes`／`Debentures`）」＋8-K 3.02（未登記股票發行）＋可轉債（封面 `Convertible`）。
- **收購價**：DEFM14A 封面信、SC TO-T 封面（「$X.XX per share in cash」）可正則取出；8-K 2.01（完成收購）有最終對價。
- **已下市／改名公司的 CIK**：用 `b9_sp500_cik_map.csv` 的 `valid_from`～`valid_to` 區段把 ticker × 日期對到 CIK；不要用 `company_tickers.json` 直接對（只有現存代號，而且代號會被重用：例如 CA → CASH TECHNOLOGIES、BBT → Beacon Financial，已過濾掉）。
- **下市價格**：Yahoo 沒有的就沒有（§1.3）。依預設：被收購 → 收購價（DEFM14A／SC TO-T／8-K 2.01）；其他 → 最後成交價（Alpha Vantage 免費 `TIME_SERIES_DAILY` 的最後 100 天，每天 25 次）。破產用最後成交價會高估報酬（下市後 OTC 還會再跌）。事件研究的觀察期（3、6、12 個月）內下市的，報酬算到下市日，並在結果表上分開列出筆數。

### 8.5 已知陷阱

1. **SC TO-T 同時出現在收購方與被收購方的 submissions**（ORCL 自己的清單裡有 6 筆 SC TO-T、31 筆 /A；LLY 12 筆）。判斷是不是「被收購」：同一天附近有沒有 SC 14D9（只有被收購方會申報），或讀索引頁的「Subject Company」與「Filed by」。PREM14A／DEFM14A 也可能是收購方要股東投票（換股收購），要讀封面。
2. **424B2 有 38 萬筆**，幾乎全是銀行的結構型債券；不先過濾，`DILUTION` 會被五家銀行灌爆。
3. **同一 CIK 的多個代號**（例如 `BALL,BLL`、`GEN,NLOK,SYMC`）：事件只算一次。**同一代號多個 CIK**（DOW、AGN、IR、Q、AVGO 等）：用有效區段。前身 CIK 在改組後常常繼續以子公司身分申報（DOW Chemical、Baker Hughes Holdings、Medtronic Inc），區段之外的申報不要算。
4. **控股公司改組**：新 CIK 之前的事件在前身 CIK 下（DIS 2019 前在 1001039、XOM 2026-07 前在 34088）；已全部補齊並人工核對（8.1）。另外**子公司 CIK 很容易被誤當成母公司**（名稱幾乎一樣、但沒有 10-K），對照時一定要檢查 10-K／10-Q 數量。
5. **fja 代號**用最後的 OTC 代號（LEHMQ、EKDKQ）；名稱要從 Wikipedia 異動表或 lawcal 取。
6. **4.02 樣本很少**：指數期間內 38 筆（36 家），扣掉同一家多次、和動能股票池（市值前 50）重疊的更少，事件研究的信賴區間會很寬；建議同時報告「全部 S&P 500」與「動能股票池」兩組。
7. **8-K/A**：4.02 有時先以 8-K、再以 8-K/A 補充（HCA 2009-08-14 就是 8-K/A），去重時以第一筆為事件日。
8. `filings.recent` 的筆數不固定（≥ 1,000 或 1 年），一定要讀 `files` 分頁，不能只看 `recent`。
9. **XBRL 欄位**：用 `start`／`end` 判斷期間，不要用 `fy`／`fp`（§3.3）。

---

## 9. 對設計文件的影響（建議，未修改設計文件）

| # | 位置 | 現在寫的 | 驗證結果 | 建議 |
|---|---|---|---|---|
| 1 | 設計 §2.4「上線資料源」（`plan_review` A-12） | 未定 | 成分股＋市值排序：SSGA SPY 持股檔；成交金額：yfinance | 把暫定做法填成「SPY 每日持股檔（存快照）＋ yfinance」；fja05680 只給回測 |
| 2 | 設計 §3 股票池「市值前 50」 | 未定義市值口徑 | 上線用 SPY 權重＝浮動市值、每一類股分開；回測代理是全部股數 × 價格 | 寫明上線用浮動市值；回測與上線口徑不同的影響小（未量化），列入 §11 限制 |
| 3 | 設計 §11 限制 | 「1997 年成分股只有 41% 有價格」 | 41% 是「價格＋股數都有」（39.8%）；有價格的是 55.7%。另外 2015 以前的市值是「價格 × 2015 年股數」 | 補上這兩點；若重跑回測，2010 年以後可以改用 XBRL 股數 |
| 4 | `ai_layer` §8.2 point-in-time 表 | Alpha Vantage 起始日未查證；companyfacts 是否保留舊值要實測；XBRL「大型股 2009 年起」 | NEWS_SENTIMENT 確定是付費；companyfacts 保留舊值（TAP、KHC）；frames 不是 PIT；XBRL 最早 2009-07-22；EDGAR 全文搜尋 2001 起 | 更新該表；§11 第 3 點三項都已完成 |
| 5 | `ai_layer` §8.1 指標表、§3.3 參考類別、F5／F6 儀表板 | `BAMLH0A0HYM2` 列為信用利差 | FRED 只剩 2023-11-07 起，ALFRED 舊 vintage 也被截短 | 歷史參考類別改用 `BAA10Y`；`BAMLH0A0HYM2` 只在上線時顯示當前值 |
| 6 | `ai_layer` §7（`TA` 的 `fred.py`：`realtime_start = realtime_end = as_of`） | 「vintage 正確，直接當函式庫」 | as_of 早於第一個 vintage 時回 HTTP 400：BAA10Y／T10Y2Y／T10Y3M（2014-01-27）、VIXCLS（2010-11-22）、NFCI（2011-05-25）、ICSA（2009-05-28） | 包一層：不修正的系列直接取現值；會修正的系列在第一個 vintage 以前標「非 PIT」 |
| 7 | F25 事件條件（`ai_layer` F25 卡、設計 §2.2） | 「事件條件由任務 B 每天初判、Sonnet ×3 讀原文確認」 | 免費來源只有 EDGAR／SEC 公告有原文；產業新聞類（DRAM 合約價、客戶 capex、立法）只有標題 | 有條件可行：上線先只讓「能由 8-K／10-Q／SEC 公告證實」的事件條件發通知；其他事件條件只記錄（或付費新聞，§10 第 2 點）。F24 寫條件時 `confirm_by` 要標出來源類型，程式依此決定能不能通知。F25 頻率估計（3～8 次／年）會更低 |
| 8 | F18 LLM 判讀段 | 「對有命中的申報或新聞」 | 新聞只有標題 | 新聞標題只能當初判（轉交），不能單獨成為 F19／F25 的證據 |
| 9 | F19 `REGULATORY` 的資料源 | SEC 新聞稿與訴訟公告 | RSS 可用，各 25 筆 | 不用改；歷史回填要另抓 sec.gov 網頁 |
| 10 | F18／F19／F14 的 EDGAR 規則偵測 | `acceptanceDateTime` 盤後視為下一個交易日 | 欄位是真的 UTC；8-K 有 60% 在 16:00–17:30 ET 接收 | 寫明換成美東時間再判斷；不要用 `filingDate` |
| 11 | `ai_layer` F19「往前驗證」與 §11 第 2 點（B-x 回測） | 2009 年起、50 檔大型股 | 資料都可以免費取得（§8） | 可以直接做；4.02 樣本很少（見 §8.5），結論要用信賴區間 |
| 12 | `plan_review` 附錄 A 缺口 3（GDELT 回溯） | 需實測 | 本機 IP 連續 429，未能實測 | 仍待測；不影響上線 |

## 10. 需要使用者決定

**2026-11-11 決定：7 項都照下表的暫定做法**，唯一不同是第 6 點：不用 Google News RSS，只用 Nasdaq RSS＋EDGAR。第 4 點補充：同一家公司兩類股同時進前 5 名時只取排名較前的一類。已寫進設計 §2.4、§10 第 23 點；§9 的修改建議一併採用。

| # | 事項 | 選項 | 暫定做法（本文件已照此寫） |
|---|---|---|---|
| 1 | 新聞要不要付費 | (a) 免費：F25 只監測 EDGAR／SEC 可證實的事件條件；(b) Alpha Vantage 付費（約 US$ 50／月起）取得 NEWS_SENTIMENT，再實測是否有原文（官方回傳只有摘要，引用檢查仍可能不過）；(c) 其他付費新聞 API | (a)。付費前先確認該方案有沒有全文，否則對 F25 沒有幫助 |
| 2 | 要不要註冊 Tiingo 免費帳號當第二價格來源 | 需要使用者身分註冊；免費額度足夠 | 不註冊；用 Nasdaq 非官方 API 做最近幾天的交叉檢查 |
| 3 | 回測的倖存者偏差要不要付費修正 | Norgate、EODHD 等含下市股的資料（約 US$ 20～100／月或 US$ 270～630／年，未重新查證） | 不付費；主要結果看 2009（或 2016）以後，早期只看方向 |
| 4 | 多類股（GOOGL／GOOG、FOX／FOXA、NWS／NWSA）的「市值」 | (a) 每一類股分開排（SPY 權重的口徑）；(b) 公司合計 | (a)，和 S&P 指數一致；兩類股可能同時進前 50，排名前 5 時兩檔都選中的機率很低，但建議在規格寫清楚「同一家公司只取一類」與否 |
| 5 | 高收益債利差的替代 | `BAA10Y`（免費、1986 起）或購買 ICE 資料 | `BAA10Y` |
| 6 | Google News RSS 要不要用 | 沒有官方 API、條款禁止自動化大量存取；但它是唯一涵蓋中型股的免費標題來源 | 每天每檔 1 次、只取標題當 F18 初判，使用者決定是否接受這個灰色地帶；不接受就只用 Nasdaq RSS＋EDGAR |
| 7 | 上線成分股依賴 SSGA 檔案格式 | SSGA 改版就會壞 | 用它，另外每天和 Wikipedia 目前表比對，不一致就暫停換股並通知 |

## 附錄：腳本與輸出

| 腳本 | 用途 | 主要輸出（`research/data_sources/raw/`） |
|---|---|---|
| `common.py` | 讀 key／User-Agent（不印出）、帶快取的 HTTP GET、SEC 限速 | `http_cache/`（檔名是去掉 key 的網址雜湊）|
| `s01_sp500_membership.py` | 成分股來源比較、抽查、價格覆蓋率；`others` 參數跑 hanshof／lawcal | `s01_*.csv` |
| `s01b_live_membership.py` | SPY 持股檔、iShares、目前名單比對 | `s01b_spy_holdings.csv` |
| `s02_market_cap_xbrl.py` | XBRL 股數 × 價格 vs 市值里程碑；成交金額口徑 | `s02_cap_checks.csv` |
| `s03_edgar_submissions.py` | submissions items、時區、分頁、full-index、全文搜尋 | `s03_8k_items_by_year.csv` |
| `s04_companyfacts_pit.py` | companyfacts 重編前後的值、frames | `s04_restated_periods.csv` |
| `s05_fred_alfred.py` | FRED vintage、ICE 系列長度 | `s05_fred_summary.csv` |
| `s06_news.py` | 新聞來源 | `s06_news_coverage.csv` |
| `s07_prices.py` | yfinance 品質、已下市、備援 | `s07_*.csv`、`s07_av_delisted.csv` |
| `s08_cik_map_and_scan.py` | B-9：ticker→CIK 對照、EDGAR 事件掃描。依序 `map` → `map2` → `fix`（套用人工核對表 `MANUAL_SEGMENTS`）→ `scan` → `stats` | `b9_*.csv`、`b9_scan_stats.json`、`b9_event_counts.csv` |
| `s09_predecessor_lookup.py` | 查前身 CIK 候選（名稱搜尋＋submissions 核對），供人工判斷 | `s09_candidates.csv` |
