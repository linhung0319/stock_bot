# 業界用價格喚起注意、用證據決定賣出

長線機構在這四件事上的共同做法是：價格只負責決定「該看哪裡、由哪一層看」，賣不賣由論點的新證據決定。有文件可查的長線基金，在個股跌約 20% 時強制做一次檢視，檢視的結論是「加碼或賣出」，沒有一家是自動賣出；這與機器人「距 52 週高點跌 20% 就減半」的規則數字相同、後果相反。實證最強的三件事是：機構經理人買得好、賣得比隨機還差，而且差在「因為價格極端才去賣」；有消息的大跌傾向續跌、沒消息的大跌傾向反彈、大盤恐慌後跌最深的股票反彈最猛；趨勢與停損規則能降低回撤，但沒有證據顯示它能提高單一基本面選股的報酬。把跌幅拆成大盤、族群、個股三層，在風險模型與事件研究裡有成熟的算法，但「殘差多大才該重查基本面」查不到任何公開門檻，只能用機器人自己的資料校準。由上而下的層在大型機構是「做一次、廣播給所有人」的輸入，不是每位個股分析師各自重做，這直接支持擁有者想加的綜合層；但把綜合層「依持股標籤分送」這個具體設計，在機構文件與 AI 多代理文獻裡都查不到前例，是自有設計。機器人四個已知弱點中，「沒反證就算成立」與「只看寫下的前提」有對應的業界做法可借，但業界自己也承認買進後的監測沒有成熟標準。

本報告沿用筆記的來源可靠度標記：〔原文〕表示研究者當次讀過原始文件；〔頁面〕表示筆記記為從抓到的頁面看到、未另標為摘要；〔摘要〕表示只看到搜尋摘要或論文摘要，數字引用前要再核對；〔傳聞〕表示無原始出處的業界部落格；〔未標〕表示筆記沒有寫明驗證程度。凡寫「筆記推論」者，是研究者自己的推理，不是有文件的做法；寫「查不到」者，是研究者找過而沒有找到來源。

## 三層歸因算得出來，但「殘差多大才要查」沒有公開門檻

### 風險模型的形狀一致，個人版只能做到三層

商用基本面風險模型的結構都一樣：個股報酬等於市場因子、產業因子、風格因子，加上一個「模型解釋不了的」個股殘差。MSCI 的美股模型 USE4 有 **60 個產業因子與 12 個風格因子**，並把「市場效果與產業分離」列為主要特色，也就是產業報酬是扣掉大盤之後才算的〔原文〕([MSCI USE4 factsheet](https://www.msci.com/documents/10199/242721/Barra_US_Equity_Model_USE4.pdf))。Axioma 同樣把類股因子定義為「超出風格與市場因子」的報酬〔摘要〕([FactSet Insight](https://insight.factset.com/axiomas-macroeconomic-model-insights-into-equity-portfolios-from-a-new-perspective))。USE4 在市場因子之外還另設 Beta 與「殘差波動」兩個風格因子，後者用來解釋「Beta 因子抓不到的高波動股報酬」〔原文〕([MSCI USE4 factsheet](https://www.msci.com/documents/10199/242721/Barra_US_Equity_Model_USE4.pdf))；這等於廠商自己承認單一線性 beta 解釋不完高波動股在賣壓中的行為。學術上的時間序列版本是 Campbell、Lettau、Malkiel、Xu 用日資料把波動拆成市場、產業、公司三層〔摘要〕([NBER WP 7590](https://www.nber.org/papers/w7590))。

筆記推論出一個只需要日收盤價的最小版本：市場層是個股 beta 乘上 SPY 報酬，beta 只用事前資料滾動估計；族群層是同族群（把這檔自己剔除後）扣掉大盤之後的報酬；剩下的是個股殘差。這個版本分不出風格效果：高動能或高波動股跨產業一起跌的那天，它會顯示成很多檔同方向的「個股」殘差。筆記建議的便宜檢查是看 90 檔殘差的方向與廣度，因為真正的個股事件按定義不會在無關的股票之間相關。這是推論，沒有來源直接測過 90 檔規模下的做法。MSCI 對歐洲的研究顯示，共同因子造成的橫斷面波動中類股平均占 51%、風格 34%、國家 15%，而且因子「在嚴重市場壓力期更重要」〔原文〕([MSCI, Have Sectors Driven Stock Returns?](https://www.msci.com/research-and-insights/quick-take/have-sectors-driven-stock-returns))；但單一個股的日波動裡三層各占多少，查不到廠商數字。USE4 迴歸的確切設定（權重、約束、半衰期）研究者沒拿到方法文件，只讀了產品說明。

### 每天問「這是不是個股自己的事」，是事件研究裡最弱的情境

標準做法是在事件前的視窗估市場模型，把實際報酬減去 alpha 與 beta 乘大盤，得到異常報酬，再拿它和估計視窗的殘差標準差比，慣例用 5% 顯著水準〔原文〕([Kellogg 博士班講義](https://www.kellogg.northwestern.edu/faculty/sapienza/ftp/Ph.D.Teaching/ECF/EmpCF_Lecture5.pdf))。MacKinlay 1997 的典型設定是用事件前 120 個交易日估計〔摘要〕([Wikipedia: Event study](https://en.wikipedia.com/wiki/Event_study))。對單一公司單一天，這個檢定已知不可靠：它假設超額報酬常態分配（實際上常常不是）、假設每天的標準差相同、忽略跨日期的多重檢定，而且 95% 標準用在單一公司時「偽陰性的頻率非常高」〔原文〕([Fisch, Gelbach, Klick, CLS Blue Sky Blog](https://clsbluesky.law.columbia.edu/2016/09/12/toward-a-better-understanding-of-event-studies-in-securities-litigation/))。大盤波動大的時候問題反過來：標準誤被低估，太多報酬被判成顯著，Baker 提出用 VIX 調整〔摘要〕([Stanford Law Review](https://www.stanfordlawreview.org/print/article/single-firm-event-studies-securities-fraud-and-financial-crisis-problems-inference/))。事件日期集中在同一天時，即使很低的橫斷面相關也會造成嚴重過度拒絕〔摘要〕([Kolari and Pynnonen, SSRN](https://papers.ssrn.com/abstract=1830364))。有文獻支持的修正有三個：用個股自己過去殘差的經驗分位數取代常態臨界值（SQ 檢定）〔摘要〕([Gelbach, Helland, Klick 2013](https://www.rand.org/pubs/external_publications/EP68377.html))、把波動調到當前環境（USE4 的 Volatility Regime Adjustment 是同一個想法）〔原文〕([MSCI USE4 factsheet](https://www.msci.com/documents/10199/242721/Barra_US_Equity_Model_USE4.pdf))、只做單邊檢定。

筆記據此算了一筆帳（推論，假設各股獨立，大跌日不成立）：90 檔每天用 5% 雙邊常態門檻，沒有任何消息也會有約 4.5 個旗標；1% 單邊約每天 0.9 個。所以門檻要對著「每天能做幾次 AI 審查」的預算來定，不是對著教科書的顯著水準。緩跌永遠不會觸發單日門檻，標準解法是把 5、20、60 日的累積異常報酬和「標準差乘上天數的平方根」比。

### 同族群怎麼定：分類標籤為主、相關性為輔

對大型美股，已發表的證據偏向標準產業分類而不是純統計分群：GICS 與 Fama-French 分類的組內相關高於群集分析做出的群，而且越細越好，到 GICS 六位碼之後效益遞減〔摘要〕([Chan, Lakonishok, Swaminathan, FAJ 2007](https://rpc.cfainstitute.org/research/financial-analysts-journal/2007/industry-classifications-and-return-comovement))。Hoberg 與 Phillips 用 10-K 產品描述做的文字型同業，在解釋估值與股價連動上勝過傳統分類，而且「是文字同業卻不是 SIC 同業」的連結，價格反應得慢〔摘要〕([NBER WP 15991](https://www.nber.org/papers/w15991.pdf); [JFQA](https://resolve.cambridge.org/core/services/aop-cambridge-core/content/view/6E04891A7AD30C24C21CBDE37EC06BF4/S0022109018000479a.pdf/textbased_industry_momentum.pdf))。筆記的推論是：90 檔的 GICS 標籤手填一次即可；六位碼群常常只有一到三檔，太少，改用 4 到 10 檔的手工族群（GICS 混主題連結），退路是 11 大類股或類股 ETF 日線；殘差相關性滾動分群只當診斷用，用來發現「不同手工群、殘差卻長期高度相關」的主題連結。

### 拆完之後查什麼：有文件的只有「殘差歸人、因子歸帳」

多經理人避險基金的核心想法有書可查：Paleologo 寫給基本面經理人的《Advanced Portfolio Management》談的是把個股自己的報酬來源和投資環境的報酬來源分開，並建議對「個股殘差變異占比」與因子變異設風險限額〔未標；書的節錄為摘要〕([Wiley](https://www.wiley.com/en-ca/shop/general-finance-investments/advanced-portfolio-management-a-quant's-guide-for-fundamental-investors-p-9781119789802))。至於流傳的具體數字，例如回撤 5% 砍半資金、7.5% 到 10% 收攤，各家說法不一，全部出自沒有來源的部落格〔傳聞〕([Quant Enthusiasts Substack](https://youngandcalculated.substack.com/p/risk-management-inside-a-pod-how); [Risk Hub](https://riskhub.org/blogs/multi-strategy-hedge-funds))；Millennium、Citadel、Point72、Balyasny 都查不到第一手揭露，「虧損是個股殘差還是因子造成時，經理人各做什麼」也沒有任何讀得到的來源回答。

長線只做多的經理人用的是 Brinson 歸因（配置、選股、交互作用）〔未標〕([CFA Institute Research Foundation](https://www.cfainstitute.org/-/media/documents/book/rf-lit-review/2019/rflr-performance-attribution.pdf))，而 MSCI 與 FactSet 的共同發現是一個警告：Brinson 的「選股效果」有很大一部分其實是幾個風格因子〔摘要〕([MSCI, Beyond Brinson](https://www.msci.com/www/research-report/beyond-brinson-establishing-the/015322069))；FactSet 的例子裡 390 個基點超額報酬有 292 個基點歸給系統性因子〔摘要〕([FactSet Insight](https://insight.factset.com/how-a-multi-factor-attribution-framework-can-provide-a-deeper-insight-into-the-sources-of-relative-performance_))。這些都是投資組合層級、期間層級的工具；查不到任何機構把它當成「某檔某天該不該檢討」的觸發程序，也查不到「相對同族群落後 X% 達 N 天就重查」這類門檻。筆記把這個缺席本身當成一項發現：門檻是各家自訂、不公開的。

因此「拆完怎麼分派」是筆記的綜合推論，不是有文件的做法：大盤項大就做**一次**共用的市場研究、附到所有受影響的持股；族群項大就每個族群做一次；個股殘差大才做該檔的基本面重查，一檔可以同時符合多層。筆記特別提醒兩個陷阱。第一，「不是個股自己的事」不等於「不用做事」：整個 AI 半導體族群跌 6%、某檔跌 6.5%，殘差很小，但族群這一跌本身可能就關係到每個成員的論點，所以歸因的用途是把工作送到對的層級、決定做幾次，而不是把工作消掉。第二，龍頭就是族群：族群的跌是某一檔財報引起的時候，對其他成員看起來像族群事件，對龍頭自己卻是個股事件，可以從「一檔跌幅特別大又剛好有財報」的不對稱看出來。殘差大小只說明這一跌有多意外，不說明論點有沒有壞。

## 價格跌兩成觸發的是一場檢視，不是一筆賣單

### 有文件的做法集中在買進之前

寫得最清楚的流程是在買進當下把賣出條件寫好。Sanford DeLand 的 Eric Burns 對每筆新投資寫一頁公司專屬的「事前驗屍」，列出原始論點在什麼情況下算被破壞，他說這「把情緒從決定裡拿掉」；Fidelity Special Values 的 Jonathan Winton 在買進前定下獲利潛力與願付的倍數，外部環境改變這個看法時才重新評估〔原文〕([AJ Bell](https://www.ajbell.co.uk/news/why-fund-manager-calls-it-quits-stock))。Baillie Gifford 把自己的方法叫「持有紀律」，賣出理由只有兩個：出現破壞原始論點的**新資訊**，或估值已完全反映成長；它還說幾乎每一筆最成功的投資都經歷過股價大跌、短期前景極不確定的時期〔原文〕([Baillie Gifford 逐字稿](https://media.bailliegifford.com/mws/ubvks4sa/20240524135041_baillie-gifford-film-our-take-on-sell-discipline-transcript-may-2024.pdf))。Howard Marks 的立場相同：因為漲了或跌了而賣都不是正當理由，正當理由是論點變得比較不成立，或有風險調整後更好的去處〔原文〕([Oaktree, Selling Out](https://www.oaktreecapital.com/insights/memo/selling-out))。Annie Duke 的「停損條件」要同時寫狀態和日期：「到某日為止若還沒達到某狀態就退出」〔摘要〕([Wharton Nano Tool](https://executiveeducation.wharton.upenn.edu/wp-content/uploads/2023/05/NanoTool-2023-05.pdf))。

機器人「前提、怎樣算不成立、使用者勾選的出場條件」的結構，與這些有文件的做法吻合。但有兩件事要誠實看待。其一，Guy Spier 明說他和 Pabrai 都只有買進前的檢查表，**沒有持有期間的檢查表**〔摘要〕([MOI Global](https://moiglobal.com/guy-spier-mohnish-pabrai-michael-shearn-investment-checklists/))，業界對買進後監測的成文做法本來就薄。其二，事前驗屍的證據只支持「想得出更多失敗原因」，不是「原因更準」：常被引用的 30% 來自 1989 年的前瞻後見研究，量的是原因數量〔摘要〕([Wikipedia: Premortem](https://www.Wikipedia.org/wiki/Premortem))。Capital Group、T. Rowe Price、Sequoia 的論點追蹤流程沒有深查，Fundsmith 的手冊抓不下來，都應視為未知而不是不存在。

### 前提以外的新風險，業界靠「換一個人、換一批來源」

對「只看寫下的前提」這個弱點，有文件的答案是組織上的，不是分析技巧。Alpha Theory 描述的客戶最佳實務是每個部位指定一位魔鬼代言人（不是負責的分析師）、去找最看空的賣方分析師談、用「一年後股價腰斬了，發生什麼事」的提問，並把「我們漏了什麼」制度化〔原文〕([Alpha Theory](https://www.alphatheory.com/blog/alpha-theory-best-practices-part-two))。Mawer 刻意去找對公司持負面看法的來源〔摘要〕([Mawer via AdvisorAnalyst](https://advisoranalyst.com/?p=27434))；Vontobel 讓記者背景的調查分析師與基本面分析師配對，以「常常不同的意見」製造辯論〔摘要〕([Vontobel](https://am.vontobel.com/en/insights/through-the-prism-how-investigative-journalists-can-enhance-equity-research))；有一家未具名的公司要求分析師每年兩次對自己的大部位寫反方備忘錄，由三位最資深的投資人表決〔摘要〕([Alpha Theory part three](https://www.alphatheory.com/blog/alpha-theory-best-practices-three))。Pabrai 把每一次犯錯變成檢查表的新項目〔摘要〕([Jason Zweig](https://jasonzweig.com/make-a-list-check-it-twice/))。查不到的有：有明訂頻率的「歸零重新承做」、輪調負責分析師、獨立風控團隊審個股論點，這些常被談到卻找不到具名公司；也查不到任何實證量過魔鬼代言人或新眼光檢視是否改善報酬。「如果今天第一次看到，還會買嗎」只找到一般性建議，不是公司程序。

### 價格觸發在長線基金是強制「做決定」

有文件的兩個長線流程都用 20%，而且都不是自動賣出。Brown Advisory Global Leaders 的 Mick Dillon 在個股自買進後跌 20%，**或十二個月內落後基金基準 20%** 時啟動「回撤檢視」，目的是判斷這是便宜的機會還是錯誤的決定，結論只能是加碼或賣出；他說這讓決策心態「從防守變成進攻」。Liontrust Global Innovation 在個股跌超過 20% 時啟動「落水者」流程做深入評估，若對公司看法不變、下跌原因是總經，就**加碼**〔原文〕([interactive investor](https://ii.co.uk/analysis-commentary/falling-funds-should-investors-cut-their-losses-do-nothing-or-buy-more-ii526439))。Mauboussin 2015 年的檢查表用約 5,400 個「單日相對大盤跌 10% 以上」的案例，依是否發生在財報日、先前動能、估值與品質分類，讀各類別之後 30、60、90 天的超額報酬基準率〔摘要；原始 PDF 沒拿到，表格未核實〕([ValueWalk 摘要](https://www.valuewalk.com/mauboussins-checklist-reacting-sudden-price-drops/))。Dorfman 的個人規則是跌 20% 仔細看、跌 30% 推定賣出但可反駁，而且在 2008 年那種全面下跌時要放寬〔摘要，屬個人意見〕([TribLive](https://triblive.com/business/john-dorfman-what-is-your-sell-discipline-do-you-have-one))。這兩個基金流程都出自同一篇報導裡的經理人訪談，查不到公開說明書層級的文件，也查不到「回撤檢視流程改善結果」的證據。

### 停損與趨勢規則的證據：降低風險，不是報酬來源

Kaminski 與 Lo 的結論是：報酬若是隨機漫步，停損規則一定降低期望報酬；報酬有動能或狀態切換時才可能加分〔摘要〕([MIT DSpace](https://dspace.mit.edu/handle/1721.1/114876))。兩份筆記對這篇論文實證樣本的描述不一致（一份記為 1993 到 2011 年的期貨日資料，一份記為 1950 到 2004 年的美股月資料、停損期間每月加 50 到 100 個基點），兩者都只看摘要，引用數字前要回原文核對；兩種說法都是指數層級，不是個股。Han、Zhou、Zhu 把 10% 停損用在動能**多空組合**上，1926 到 2013 年等權重最差單月虧損從 −49.79% 縮到 −11.36%〔摘要，未扣交易成本〕([Alpha Architect](https://alphaarchitect.com/2016/08/taming-the-momentum-roller-coaster-fact-or-fiction/))，而 Alpha Architect 的複製發現平均報酬幾乎一樣（月 1.27% 對 1.24%），好處在風險而不在報酬〔頁面〕([Alpha Architect](https://alphaarchitect.com/2016/08/taming-the-momentum-roller-coaster-fact-or-fiction/))。Faber 的十個月均線在資產類別層級大幅降低回撤，但加入 2008 到 2012 年資料後回撤變大，獨立測試也沒看到多少報酬優勢〔摘要，二手〕([Juniata 複製](https://admissions.juniata.edu/offices/juniata-voices/media/andrew-and-castro.pdf))。**沒有任何找到的研究測試過「單一基本面選股從高點跌 20% 減半」**；也沒有研究測試個股的重新進場規則，「連續 10 天站上 200 日均線」的 10 這個數字就目前所查沒有實證依據。

### 賣出決策的研究：買有技巧，賣輸給隨機

最硬的證據來自 Akepanidtaworn、Di Mascio、Imas、Schmidt 的〈Selling Fast and Buying Slow〉：783 個機構投資組合、2000 到 2016 年、440 萬筆交易，買進每年贏隨機買進超過 100 個基點，賣出卻**每年輸給因子中性的隨機賣出 80 個基點**。機制是兩階段捷思：注意力有限，候選名單縮到過去報酬極端的部位，表現最差與最好的部位被賣出的比率比普通部位高出五成以上；再從中賣掉信心最低、權重最小的「被忽略的點子」，虧損主要出在這裡，高信心部位的賣出沒有系統性落後。最容易因報酬極端而賣的那四分之一經理人，在那些賣出上每年少賺近 180 個基點；整個組合都在虧損、或為了籌錢買別的而賣時更糟；而且經理人**很少買回**賣掉的股票。反過來，在財報公布日做的賣出每年比其他日子好超過 150 個基點，作者的結論是經理人不是沒有賣的能力，只是沒把能力用上；他們的處方是呈現「賣出的反事實績效」，並採用決策輔助或簡單的替代賣出規則〔原文，2021 年工作論文版〕([NBER WP 29076](https://www.nber.org/system/files/working_papers/w29076/w29076.pdf))。

另一股證據方向相反：Essentia 對 43 個主動股票組合的研究說 alpha 隨持有時間快速衰退，另一份研究說價值多半毀在抱著輸家太久〔摘要；廠商研究，樣本平均持有不到一年〕([Institutional Investor](https://www.institutionalinvestor.com/article/b1hxzwxndzj7rc/Active-Equity-Managers-Actually-Do-Generate-Alpha-Here-s-How-They-Squander-It))。筆記的調和是：兩者指向同一個結論，賣出的**觸發**應該是論點證據，價格變動只觸發注意力。查不到任何對照實驗證明事前驗屍、檢查表或停損條件改善了實際賣出績效，NBER 作者也只是建議。

### 證據新不新：業界沒有成文標準

「證實、未證實、過期」這種證據分級，查不到任何買方公司的成文流程；這是四份筆記裡來源最弱的一塊。相鄰的證據只有三項：財報日的賣出決策較好〔原文〕([NBER WP 29076](https://www.nber.org/system/files/working_papers/w29076/w29076.pdf))；賣方分析師的目標價有一半在 90 天內被修改〔摘要〕([Columbia 研討會論文](https://business.columbia.edu/sites/default/files-efs/imce-uploads/ADP/Spring%202025/Joshua%20Livnat%20Feb%202025.pdf))；Baillie Gifford 的賣出標準定義在「新」資訊上，前提是知道上次檢視之後什麼是新的〔原文〕([Baillie Gifford 逐字稿](https://media.bailliegifford.com/mws/ubvks4sa/20240524135041_baillie-gifford-film-our-take-on-sell-discipline-transcript-may-2024.pdf))。與論點判斷無關的保險也有文件：美國「分散型」基金要求 75% 的資產中單一發行人不超過 5%〔摘要〕([15 U.S.C. § 80a-5](https://www.law.cornell.edu/uscode/text/15/80a-5))，Evenlode 在買進時就替每檔定好部位上限，碰到上限就修剪〔原文〕([AJ Bell](https://www.ajbell.co.uk/news/why-fund-manager-calls-it-quits-stock))。

## 由上而下的層做一次、廣播出去，而且允許回答「不知道」

### 機構的兩種模型都不讓個股分析師重做市場研究

有文件的做法分兩種。Wellington 沒有公司觀點：八百多位投資專業人員每天在晨會交換見解，倫敦場的錄影與筆記在美國投資人上班時就可取用；題目由與會者事先交的意見卡挑選，條件是「有差異化的見解或需要採取行動」；會議的產出是後續工作而不是決策〔頁面〕([Wellington, Inside our Morning Meetings](https://www.wellington.com/content/dam/wellington/pdf/en/morning-meeting-v7.pdf))。Capital Group 的多經理人制度是分享見解、各自決策〔摘要，出自行銷頁面〕([Capital Group](https://www.capitalgroup.com/advisor/ca/en/about-us/capital-system.html))。BlackRock 走另一條路：一百多位經理人與策略師每年兩次開展望論壇，產出公開的公司觀點，另有每週評論，而且每週評論談的是長期結構力量而不是當天新聞〔摘要〕([BlackRock Investment Institute](https://www.blackrock.com/corporate/insights/blackrock-investment-institute/insights))。兩種模型的共同點是：共用層是做一次、送給所有人的輸入。範圍越廣節奏越慢（半年展望、每週評論、每日交流）。Fidelity、T. Rowe Price 與 Bridgewater《Daily Observations》的內部流程沒拿到第一手來源；BlackRock 的經理人能不能偏離公司觀點也沒有證實。

### 把事件對應到持股：付費資料的三層結構可以手工替代

廠商用三層資料把事件對應到持股：帶營收占比的細產業分類（FactSet RBICS）、地區營收（GeoRev）、客戶與供應商關係圖（FactSet Supply Chain、Bloomberg SPLC），全部要機構訂閱，而且 Bloomberg 自己說供應鏈資料「通常不完整」〔摘要〕([FactSet Insight](https://insight.factset.com/tariff-uncertainty-unveiling-hidden-revenue-and-supply-chain-risks?hs_amp=true); [Emory, Bloomberg SPLC guide](https://prod.libraries.emory.edu/sites/default/files/migrated-documents/db-pages/bloomberg-splc.pdf))。筆記推論的免費替代是每檔持股一列手工表：兩到四個業務標籤與粗略營收占比、地區營收、三到五個關鍵客戶供應商競爭者、三到六個帶正負號的總經敏感度標籤，每個標籤旁存下出處原句，不知道就寫不知道，每年隨年報更新。事件帶同一套詞彙的標籤，個股審查只收到與自己那一列有交集的事件。美國會計準則對分部與主要客戶的揭露規定研究者有找但沒查到，這個免費資料基礎未經核實。

### 事件分流：相關、新穎、有意思是三個分開的判斷

RavenPack 對每則新聞打「對該公司的相關度」與「新穎度（新事件、重複、延續）」〔摘要〕([WRDS, RavenPack 文件](https://wrds-www.wharton.upenn.edu/documents/1395/RavenPack.pdf))。Bridgewater 的 AI 實驗室把分流標成三類：相關且有意思、相關但無趣、不相關。它量到的難度是直接的警告：前沿模型只給簡單任務提示時，六項分流任務**平均準確率約 50%**；加上專家寫的判準後到七十幾，最好的前沿模型 78.2%，微調模型 84.7%，而投資人要到 80% 才願意在日常工作中信任它；專家自己也很難把這些判斷講清楚〔頁面〕([Bridgewater AIA Labs](https://www.bridgewater.com/aia-labs/learning-to-replicate-expert-judgment-in-financial-tasks))。公司層級有現成的免費分類：SEC 的 8-K 項目表，例如 4.02 先前財報不可信賴、1.03 破產、2.06 重大減損、5.02 董事高階主管異動、2.02 營運結果〔頁面〕([SEC 8-K C&DIs](https://www.sec.gov/rules-regulations/staff-guidance/compliance-disclosure-interpretations/exchange-act-form-8-k))；哪些項目算重大的排序是筆記推論，不是 SEC 的說法。

### 新聞對大跌的解釋：學界的處理是把「原因、信心、清晰度」分開記

事後敘事的問題有長期證據。Cutler、Poterba、Summers 檢視 1946 到 1987 年標普 500 最大的 50 個單日漲跌，許多無法對應到令人信服的消息〔摘要〕([NBER WP 2538](https://nber.org/papers/w2538))；Fair 2002 也發現許多大幅價格變動沒有對應事件〔摘要〕([Fair, Journal of Business](https://ideas.repec.org/a/ucp/jnlbus/v75y2002i4p713-732.html))。Baker、Bloom、Davis、Sammon 把美股 1900 到 2023 年的 1,179 個單日漲跌 2.5% 以上的「跳動」逐一編碼：這些日子只占交易日的 3.5%，卻占每日絕對變動總量近兩成；編碼欄位是近因（17 類，含「未知與無解釋」）、地理來源與清晰度，清晰度綜合了記者提出解釋的信心、編碼難易與不同讀者的一致程度。歸為未知的比例九十年間從約 35% 降到 10%；**低清晰度的跳動前後至少兩週波動較大**；貨幣政策引發的跳動之後波動低得多。重要的限制是這篇論文量的是「記者怎麼說」，不是經過驗證的因果〔頁面〕([NBER WP 28687](https://www.nber.org/system/files/working_papers/w28687/w28687.pdf))。Tetlock 2007 發現媒體悲觀預示價格下壓後回歸基本面，而且低報酬會帶來高悲觀，也就是當天的悲觀報導部分是股價下跌的回聲〔摘要〕([Tetlock 2007](https://www.columbia.edu/~pt2238/papers/Tetlock_Media_Sentiment_JF.pdf))。資金流與部位的解釋往往事後才能確認：2024 年 8 月 5 日的動盪，BIS 把它追到套利交易去槓桿的分析是三週後才發表的，而當時各家對平倉進度的估計幾天內就互相矛盾〔摘要〕([BIS Bulletin 90](https://www.bis.org/publ/bisbull90.htm); [Fortune](https://fortune.com/2024/08/08/75-carry-trade-blamed-recent-stock-meltdown-unwound-jpmorgan/))。

專業交易台怎麼記錄互相競爭的解釋、有沒有強制等待期，查不到成文程序；長線投資人的冷靜期與「預設不動」也只有實務文章，沒有機構研究。所以以下是筆記從學術編碼方法推出來的處理方式：大跌日的市場層筆記先寫事實（指數與類股漲跌、廣度），再列候選解釋，每個附類別、來源、信心，並保留「未知、沒有明確原因」這個合法答案與一個清晰度等級；媒體語氣不當成基本面證據往個股層送；資金流解釋當假說、附一個回頭看的日期，等資料出來再更新成定稿，也就是當天暫定稿加事後定稿的兩段式。筆記建議的兩週等待長度是從波動視窗改編的，不是有文件的規則。個股層在大跌後該問的不是「大盤為什麼跌」，而是「這檔的哪一條前提或出場條件變了」，這個問題市場敘事多半答不了。

### AI 多代理系統沒有提供共用市場層的前例

已發表的系統多把總經放在逐檔流程裡：TradingAgents 的新聞分析師在每一檔的每次執行中各自評估總經狀態，論文沒有描述獨立的市場層；它每次預測要 11 次模型呼叫與 20 次以上工具呼叫，回測只有 2024 年前三個月的三檔股票〔頁面〕([arXiv 2412.20138](https://arxiv.org/html/2412.20138v4))。這正是擁有者遇到的重複研究問題的來源結構。MarketSenseAI 有獨立的總經代理餵給逐檔的綜合代理、每月出一次論點，但摘要沒說總經產出是否算一次後重用〔頁面，僅摘要層級〕([arXiv 2604.17327](https://arxiv.org/abs/2604.17327))。一篇檢討 12 個多代理系統的論文點名五種評估缺陷（前視偏誤、存活者偏誤、回測過度配適、忽略交易成本、對環境轉換視而不見），認為足以翻轉報酬的正負號〔頁面，僅摘要層級〕([arXiv 2603.27539](https://arxiv.org/abs/2603.27539))。可借的設計規則有兩條有出處：TradingAgents 發現純自然語言的傳遞鏈有「傳話效應」，細節流失、狀態損壞，所以層與層之間傳結構化報告〔頁面〕([arXiv 2412.20138](https://arxiv.org/html/2412.20138v4))；Bridgewater 的預測系統讓幾個代理各自獨立搜尋並給機率，再由監督代理補搜尋、調和差異〔摘要〕([arXiv 2511.07678](https://arxiv.org/abs/2511.07678v1))。「逐檔代理重複做工」與「替大盤漲跌幻想出原因」被當成量測過的失敗模式的論文，查不到，這兩點仍是擁有者的假說。

## 崩盤偵測的實證支持「慢、部分、先寫好」，快訊號只適合用來解釋

### 兩個指標站得住，其餘只能當背景

大盤層級只有兩類訊號有長期、被反覆複製的證據：慢速價格趨勢與波動水準，兩者降低回撤遠比提高報酬可靠。趨勢方面，用 3、6、9、12 個月均線做擇時的毛夏普值都贏買進持有，所以趨勢這個想法比確切的窗長穩健，但專挑十個月均線有資料探勘的疑慮〔頁面〕([CXO Advisory](https://www.cxoadvisory.com/technical-trading/long-term-outperformance-from-trends-defined-by-moving-averages))；加入實際交易成本的樣本外測試認為擇時策略的績效「被高度高估」〔摘要〕([Journal of Asset Management](https://link.springer.com/article/10.1057/jam.2014.25))。來回被洗的規模，實務者的測試是標普 500 對 200 日均線在 1994 到 2019 年有 90 次完成的多頭訊號，只有 20 次賺、平均賺 13.69%，70 次賠、平均賠 1.32%，獲利來自少數幾段長趨勢〔頁面，實務者測試〕([StockCharts](https://stockcharts.com/articles/arthurhill/2019/02/just-how-effective-is-the-200-day-moving-average.html))。波動方面，Moreira 與 Muir 發現波動高時降低曝險能產生大的 alpha〔頁面〕([NBER w22208](https://www.nber.org/papers/w22208))，但 Cederburg 等人檢驗 103 個股票策略後發現即時版本通常夏普值更低〔頁面〕([Lehigh PDF](https://www.lehigh.edu/~xuy219/research/COWY.pdf))，所以波動是「現在風險高」的可靠描述，當報酬增強器則有爭議。

其他指標的支持較薄或互相矛盾。吸收比率的原作者說大回撤之前會先升高〔摘要〕([State Street Associates](https://globalmarkets.statestreet.com/research/portal/insights/article/2a8e282a-343b-443c-b362-1634c71d2d26))，獨立複查卻發現它在崩盤前傾向**下降**、崩盤中才飆高並維持高檔〔頁面，單一全期回測〕([Portfolio Optimizer](https://portfoliooptimizer.io/blog/the-absorption-ratio-measuring-financial-risk/))。VIX 期貨逆價差在最大的幾次賣壓之外並不預示下跌〔頁面〕([Cboe Insights](https://www.cboe.com/insights/posts/inside-volatility-trading-is-vix-backwardation-necessarily-a-sign-of-a-future-down-market))，學術上它更像反向指標〔摘要〕([MDPI JRFM](https://mdpi.com/1911-8074/12/3/113))。信用利差中的「超額債券溢酬」對十二個月內的衰退有顯著預測力，聯準會每月公布〔頁面〕([FEDS Notes](https://www.federalreserve.gov/econresdata/notes/feds-notes/2016/recession-risk-and-the-excess-bond-premium-20160408.html))，但查不到把它當股市擇時訊號並給門檻的研究。隱藏馬可夫模型對估計誤差敏感〔頁面，轉引〕([arXiv 2402.05272](https://arxiv.org/html/2402.05272v3))。廣度方面，查不到任何同儕審查研究把「站上 200 日均線的股票比例」當崩盤預測指標；「距高點跌 10% 或 20% 就行動有幫助」的標準門檻也查不到。

### 偵測到之後：資產擁有者寫的是再平衡，不是逃跑

行動有沒有用的證據是對稱的。AQR 用 1997 年到 2024 年 4 月的日資料算出，錯過最好的 30 天年化報酬從 9.3% 掉到 2.4%，躲過最差的 30 天則升到 17.4%；這個效果大致對稱，用模擬的常態報酬也能重現，所以「錯過最好的幾天」這張圖本身不構成反對擇時的理由，AQR 的結論是擇時只該按真實的扣成本後優勢的比例去做，絕不要全有全無〔頁面〕([AQR](https://www.aqr.com/Insights/Perspectives/So-What-If-You-Miss-the-Markets-N-Best-Days))。最好與最差的日子擠在一起：1990 年以來標普 500 最差日與最好日之間的中位距離是七天〔頁面〕([Morningstar](https://www.morningstar.com/funds/you-can-beat-stock-market-by-avoiding-its-worst-days-you-wont))。速度不匹配也有記錄：2020 年 3 月的崩盤中趨勢追蹤大致持平，2022 年較慢的下跌中表現較好〔頁面，AQR 自家觀點〕([AQR Alternative Thinking](https://www.aqr.com/Insights/Research/Alternative-Thinking/Tail-Hedging-Strategies))。

資產擁有者成文的規則與崩盤出場相反。挪威政府退休基金在股票比重偏離策略權重超過四個百分點時，於月底檢查並機械式再平衡回去，也就是大跌之後**買進**股票〔頁面〕([挪威政府白皮書](https://www.regjeringen.no/en/documents/meld.-st.-21-20142015/id2405360/?ch=10))；2018 年挪威央行建議縮到正負兩個百分點，現行區間未能確認〔頁面〕([NBIM 2018](https://nbim.no/en/publications/submissions-to-ministry/2018/the-rule-for-rebalancing-the-equity-share-in-the-government-pension-fund-global))。Vanguard 的研究認為對多數投資人年度再平衡即為最適〔頁面〕([Vanguard](https://corporate.vanguard.com/content/dam/corp/research/pdf/rational_rebalancing_analytical_approach_to_multiasset_portfolio_rebalancing.pdf))。CalPERS 的回撤應對政策沒拿到。筆記由此推論出一個保守階梯：不動、暫停新買進並擴大檢視、部分降險、只在慢而確認的趨勢破壞時才全面防禦；其中「暫停新買進」沒有直接證據，是推論。

### 個股大波動：分類比幅度重要

大跌之後會怎樣，取決於有沒有消息，而不是跌多少。Chan 2003 用新聞標題資料庫發現壞消息之後有明顯續跌，當月大幅波動卻沒有新聞的股票下個月傾向反轉，而且主要出現在較小、流動性較差的股票；Savor 2012 發現伴隨分析師報告的大幅價格變動之後是續行，沒有資訊的變動則反轉〔頁面〕([Chan, EconPapers](https://econpapers.repec.org/RePEc:eee:jfinec:v:70:y:2003:i:2:p:223-260); [Savor, EconPapers](https://econpapers.repec.org/RePEc:eee:jfinec:v:106:y:2012:i:3:p:635-659))。單日大跌後的短期反彈在扣除買賣價差與成本後不顯著，大漲之後的反轉更弱或不存在〔摘要，二手文獻回顧〕([Choi and Jayaraman](https://www.scheller.gatech.edu/directory/research/finance/jayaraman/pdf/jfm_overreaction_feb_27_2008.pdf))。大型股的財報後漂移自 2006 年以來已不存在的說法有人提出，也有 2025 年的研究反駁〔頁面〕([Critical Finance Review](https://nowpublishers.com/article/Details/CFR-0122); [UCLA Anderson Review](https://anderson-review.ucla.edu/is-post-earnings-announcement-drift-a-thing-again))。大盤恐慌是另一回事：Daniel 與 Moskowitz 發現動能策略在市場下跌、波動升高的「恐慌」狀態崩潰，時間點正好是大盤反彈，過去的輸家在反彈中表現極好、贏家落後〔摘要〕([NBER w20439](https://www.nber.org/papers/w20439))。

偵測方法上，學術文獻定義「大波動」用的是固定門檻（單日至少 10%）或相對個股自己近期歷史的異常報酬與異常成交量〔頁面〕([Bremer and Sweeney, IDEAS](https://ideas.repec.org/a/bla/jfinan/v46y1991i2p747-54.html); [Gervais, Kaniel, Mingelgrin](https://sites.duke.edu/sgervais/?p=64))；風險廠商或監理機關的個股警示門檻（z 值、成交量倍數）查不到任何公開文件。

### 漲太多：崩盤機率升高，但期望報酬沒有變差

Greenwood、Shleifer、You 的結果是這一題的核心：美國產業過去兩年扣掉大盤的漲幅從 50% 到 100% 時，兩年內出現 40% 回撤的機率從 **20% 升到 53%**，到 150% 時約 80%；但急漲**並不預示**之後的平均報酬特別低，因為價格常在崩盤前繼續漲〔頁面，工作論文數字〕([NBER w23191](https://www.nber.org/system/files/working_papers/w23191/w23191.pdf))。同時，Bessembinder 發現 1926 到 2016 年美股超過國庫券的全部淨財富由表現最好的 4% 公司創造〔頁面〕([JFE 摘要](https://econpapers.repec.org/RePEc:eee:jfinec:v:129:y:2018:i:3:p:440-457))，Frazzini 發現投資人太早賣贏家造成對消息反應不足〔頁面〕([AQR](https://www.aqr.com/Insights/Research/Journal-Article/The-Disposition-Effect-and-the-UnderReaction-to-News))。合起來的意思是：急漲值得加強審視與限制部位大小，不值得自動賣出；修剪的正當理由是集中度，不是「漲太多」。Sornette 的對數週期冪律模型在樣本外有爭議、對崩盤時點的估計受質疑〔頁面〕([arXiv 1002.1010](https://arxiv.org/abs/1002.1010v2))。「有系統地修剪贏家」在集中的只做多組合裡的長期成本，查不到直接量測的研究。

### 升級機制：黃線檢視、紅線行動、事前寫好

機構風控的共同骨架是兩道門檻：軟性（黃）要求檢視、硬性（紅）要求行動，紅線觸發很少見〔頁面，銀行資料〕([Boston Fed SRA 24-01](https://www.bostonfed.org/-/media/Documents/Workingpapers/PDF/2024/sra2401.pdf))，並要有成文的升級與通報程序〔頁面〕([HKMA SPM IC-1](https://brdr.hkma.gov.hk/chi/doc-ldg/docId/getPdf/20171006-3-EN/IC-1.pdf))。有具體時限的權威買方標準查不到；唯一寫出小時級時限的來源是一份非權威的範本，不應當成業界標準引用。

## 對機器人架構的含義：五項可直接借用，四處與現有規則相衝突

### 可以直接借用的業界做法

第一，**共用層做一次、廣播、只當輸入**。Wellington 與 BlackRock 的模式直接支持綜合層，三個細節都有出處：產出一次送給所有個股審查（Wellington 的錄影與筆記接力）；共用層提供脈絡、不覆蓋個股論點（「沒有公司觀點」「分享見解、各自決策」）；有入選門檻，一則事件要改變至少一檔持股的某件事或需要行動才進共用筆記（Wellington 的意見卡）([Wellington](https://www.wellington.com/content/dam/wellington/pdf/en/morning-meeting-v7.pdf))。層間傳結構化、標日期的筆記而不是對話紀錄，有 TradingAgents 的傳話效應發現支持([arXiv 2412.20138](https://arxiv.org/html/2412.20138v4))。

第二，**大跌日筆記採用 Baker 等人的編碼表**：事實、候選原因、信心、清晰度，並允許「未知」。現代仍有約一成的跳動被記為未知，而且那還只是記者的說法([NBER WP 28687](https://www.nber.org/system/files/working_papers/w28687/w28687.pdf))。機器人現有「引用必須逐字對得上原文」的規則適合事實欄，但對原因欄不夠：逐字引到一篇記者的解釋，只證明記者這樣說過。

第三，**20% 事件要開一場必須有書面結論的論點檢視**，並加上相對觸發（Brown Advisory 的「十二個月落後基準 20%」），把「這檔跌了」和「全部都跌了」分開([interactive investor](https://ii.co.uk/analysis-commentary/falling-funds-should-investors-cut-their-losses-do-nothing-or-buy-more-ii526439))。

第四，**審查綁財報日、涵蓋每一檔，並記賣出的反事實**。財報日賣出每年好 150 個基點以上、只看極端部位的賣出最差、作者建議呈現反事實績效，這三點都是讀過原文的實證([NBER WP 29076](https://www.nber.org/system/files/working_papers/w29076/w29076.pdf))。機器人已有快照帳本，每次減半或賣出之後記錄該股與其餘持股的後續表現，成本很低。公司事件用 8-K 項目表當免費分類([SEC](https://www.sec.gov/rules-regulations/staff-guidance/compliance-disclosure-interpretations/exchange-act-form-8-k))。

第五，**歸因的計算方法與部位上限**。扣掉大盤再算族群、估計視窗排除事件日、用個股自己的經驗分位數、波動調到當前環境、5 到 60 日累積殘差，都有文獻出處（見第一節）；買進時定好的單檔上限加上修剪到上限（Evenlode）與論點判斷無關，能限制「審查一直誤判成立」的殘餘損害([AJ Bell](https://www.ajbell.co.uk/news/why-fund-manager-calls-it-quits-stock))。這些只需要 90 檔與 SPY 的日線。

對四個已知弱點，有出處的借法如下表；表中「機器人的對應做法」一欄是筆記的推論。

| 已知弱點 | 有文件的業界做法 | 機器人的對應做法（筆記推論） | 業界做法的證據強度 |
|---|---|---|---|
| 只看寫下的前提 | 指定非原作者的魔鬼代言人、「我們漏了什麼」、每次犯錯加一條檢查表 | 先跑一次不給前提清單的歸零審查，產出候選新風險給使用者勾選；另設跨個股的常設檢查表 | 有具名做法；查不到改善報酬的實證 |
| 沒反證就算成立 | Duke 的「狀態加日期」；Baillie Gifford 以新資訊為準 | 判定至少四態：本期有新證據證實、被反駁、本期未驗證（顯示上次證實日期）、逾期；每條前提在草擬時寫明預期證據來源與頻率，讓程式量過期 | 查不到業界分級標準，最弱的一塊 |
| 草擬與檢查用同一批文件 | Mawer 找負面來源、Vontobel 用調查分析師 | 證實用的引文必須出自草擬日期之後的文件，並做明確的看空來源搜尋 | 有具名做法；無實證 |
| 只有第三方能驗證的前提 | 刻意取得並具名外部觀點 | 標記為「僅第三方」、來源具名標日期、限制單一第三方資料能維持「證實」多久，並配一個日後會出現在公司申報裡的落後代理指標 | 查不到如何驗證或老化這類輸入 |

### 與機器人現有規則相衝突的業界做法

**個股「跌 20% 減半」與長線基金的做法相反。** 同樣是 20%，Brown Advisory 與 Liontrust 的後果是檢視後加碼或賣出，Liontrust 在原因是總經且公司看法不變時加碼；Baillie Gifford 與 Marks 明確否定以下跌為賣出理由。NBER 的資料顯示因報酬極端而賣是機構賣出虧損的主要來源。這條規則的性質是趨勢停損，支持它的證據全在指數、期貨與多空動能組合，沒有一篇測過單一基本面選股；所以它只能以「不需判斷的回撤控制」為理由存在，不能說是報酬來源。它有兩點站得住：只賣一半，符合 AQR「按優勢比例、不要全有全無」的建議，也是在隨機漫步與動能兩種世界之間的避險；保留機械式加回規則是對的，因為經理人很少買回賣掉的股票，沒有規則的話減半的部位會一直是減半。

**用原始價格當觸發，在大盤一起跌時會同時砍很多檔，而且砍在最差的時點。** 距 52 週高點的跌幅分不出個股事件與大盤事件，而兩者的後續相反：有公司消息的跌傾向續跌，恐慌中跌最深的在反彈時漲最多，且最好的日子離最差的日子中位數只有七天。是否在已宣告的大盤崩盤狀態下改用相對大盤的跌幅，證據提出了這個問題但沒有給答案；這是需要擁有者決定的設計變更。

**大盤崩盤規則切換核心部位，與資產擁有者的成文規則方向相反。** 挪威的規則是大跌後買回股票。趨勢證據支持崩盤規則降低回撤，但它在 2020 年式的快速崩盤中抓不到，在盤整時付出被洗的成本。筆記的判斷是不要為了追「最佳參數」重調現有規則，因為窗長幾乎不影響結果；有文件的減少被洗的方法是加區間帶或確認次數。

**動能每月換股與崩盤規則有一個已知的交互作用。** 恐慌之後重新進場時，動能名單裝滿低 beta 的「贏家」，正是 Daniel 與 Moskowitz 說的反彈中落後的那一批。筆記提出在大盤過去報酬為負且波動高時縮小或延後動能重排，這是推論出的可能緩解，沒有在機器人的資料上測過。

另外，「連續 10 天站上 200 日均線」的參數查不到實證依據，這不算衝突，但文件上不應寫成有根據。

### 屬於筆記研究者自己的推論、不是有文件的做法

以下各項在業界找不到成文前例，採用時應視為自有設計並用機器人自己的資料驗證。把歸因結果分派成「大盤一次、族群各一次、個股殘差逐檔」的三層閘門，以及避險基金「因子虧損歸帳、殘差虧損歸人」到只做多機器人的對應，都是推論。用審查預算而不是顯著水準校準殘差門檻、每天約一個旗標的估算，是假設各股獨立的粗算；筆記提出一個可直接檢驗設計的回測：在已知的全面大跌日，個股層的旗標數**不應該**暴增。依持股標籤分送事件的手工曝險表、事件分流的五欄紀錄、8-K 項目的重大性排序，是推論。大跌日「低清晰度就當天不重新承做個股論點、兩週後定稿」的兩段式與等待長度，是從學術編碼方法改編的。四級警示（僅記錄、提示、須檢視、須行動）、「兩年扣大盤漲 100% 就觸發審查並禁止加碼」的偵測器、有無消息乘上大盤或個股的決策表，都是筆記的綜合，其中 100% 的門檻來自產業層級的研究，套到個股雜訊更大。把綜合層算一次再依曝險分送，在 AI 多代理文獻裡沒有前例，Bridgewater 量到的 50% 基線則說明「這則新聞重不重要」的裸提示接近擲銅板，所以分流判準需要用擁有者自己的判斷寫成帶例子的規則，並留一小組標記樣本來核對。

## Conclusion

這次整理改變的理解是：機器人的弱點不在規則太少，而在規則與審查之間缺一個分派步驟。現在價格同時做兩件業界分開做的事，一邊直接觸發賣出，一邊逐檔觸發同樣的市場研究。業界的分工是價格與歸因只決定哪一層該被看、看幾次，賣出由論點的新證據決定，機械式規則則明說自己是風險控制。照這個分工，綜合層不只是省掉 N 次重複研究，它還是讓個股層能問對問題（哪一條前提變了）的前提條件。

需要擁有者拍板的有兩件，因為都動到已決定的設計：20% 減半規則要不要在大盤崩盤狀態下改看相對跌幅，以及 20% 事件是否同時強制開一場有書面結論的檢視。其餘可借用的做法都能在現有資料上做，但要記得三個查不到的地方正好落在機器人最想知道的位置：殘差門檻、證據新舊的分級標準、以及買進後監測的成熟流程。這三處沒有可以照抄的業界答案，機器人的做法只能靠自己的帳本驗證，賣出反事實紀錄與大跌日旗標數回測是最先該有的兩個量測。
