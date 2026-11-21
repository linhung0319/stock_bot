// T51：網頁證據的網域清單（設計 docs/design/web_evidence_design_2026-11-20.md §1.3）。
// 改清單＝改這個檔案、commit、部署（使用者維護，走 git 有紀錄）。加網域前先用 /admin/web/test 探一次「文章頁」：
// 抓不到全文（內文 < 1,500 字）或認不出發布日就不加。repo 是公開的，這裡沒有私人資料。
// 起始名單照 2026-11-20 的實測（設計 §0.5 的 M1、M2）。

export type WebTier = 'PRIMARY' | 'NAMED' | 'MEDIA';

export interface WebSource {
  /** 比對主機名稱的結尾：`trendforce.com` 涵蓋 `www.trendforce.com`。 */
  domain: string;
  tier: WebTier;
  /** 給人與 AI 看的來源名稱。 */
  label: string;
  /** 為什麼列、限制、實測結果（白話）。 */
  note: string;
  /** 只收這些路徑開頭（`NAMED` 的付費報告頁等要排除時用）；沒有就是整個網域。 */
  paths?: readonly string[];
  /**
   * 這個來源的頁面結構和一般文章頁不同時的擷取方式（T64，composite_layer_design §5.1：官方來源要先改擷取與日期的認法才用得上）。
   * 只寫在確定沒有付費牆、同意頁的官方網站上；沒有這個欄位 = 照一般的規則（webDoc.ts）。
   */
  extract?: WebExtract;
}

export interface WebExtract {
  /** 內文門檻（> 200 字的段落合計）；沒寫用 WEB_DOC_MIN_BODY（1,500）。官方的短聲明（利率決議）用較低的。 */
  minBody?: number;
  /** 內文放在 `<pre>`、每行固定寬度斷行（勞工統計局的新聞稿）：先把斷行接回成段落再算內文。 */
  pre?: boolean;
  /** 認不出發布日時的備案：網址檔名裡的 8 位數日期（聯準會的 `monetary20250917a.htm`、`powell20250822a.htm`）。 */
  urlDate?: boolean;
  /** 認不出發布日時的備案：內文之前「…星期幾, 月 日, 年」結尾的發布時間那一行（勞工統計局的 `8:30 a.m. (ET) Friday, September 5, 2025`）。 */
  releaseLine?: boolean;
  /**
   * 這個網站擋看起來像瀏覽器的請求：改用老實寫明是程式的 User-Agent（`WEB_BOT_UA`，不含聯絡資料）。
   * 勞工統計局：瀏覽器的 User-Agent 和 curl 的都回 403，寫明是程式的回 200（2026-11-21 從 Cloudflare 與本機實測）。
   */
  selfIdentify?: boolean;
}

export const WEB_SOURCES: readonly WebSource[] = [
  // 一手：發布者就是當事人或統計機關（公司與同業自己的新聞室另外跟著每檔的論點檔，OwnMeta.webSources.domains）
  { domain: 'nvidianews.nvidia.com', tier: 'PRIMARY', label: 'NVIDIA 新聞室', note: '新聞稿全文抓得到；發布日只寫在標題下面那一行（2026-11-20 實測 2 篇）', paths: ['/news/'] },
  { domain: 'semiconductors.org', tier: 'PRIMARY', label: 'SIA 美國半導體產業協會', note: '每月全球半導體銷售額的新聞稿；meta 有發布日（2026-11-20 實測 2 篇）' },
  // 指名的產業來源：產業研究機構公開的新聞稿與報價摘要
  { domain: 'trendforce.com', tier: 'NAMED', label: 'TrendForce', note: '只收新聞稿與新聞；付費報告頁（/research/）只有摘要，不收。JSON-LD 有發布日（2026-11-20 實測文章頁 4 篇，一次 4 篇沒有被擋）', paths: ['/presscenter/', '/news/'] },
  { domain: 'dramexchange.com', tier: 'NAMED', label: 'DRAMeXchange（TrendForce）', note: '只收週報文章（/WeeklyResearch/Post/）；發布日寫在「Published」那一行（2026-11-20 實測 5 篇，一次 4 篇沒有被擋）', paths: ['/WeeklyResearch/Post/'] },
  // 媒體：有編輯、會寫明消息來源的產業媒體
  { domain: 'techpowerup.com', tier: 'MEDIA', label: 'TechPowerUp', note: '短新聞的內文剛好過 1,500 字；<time> 有發布日（2026-11-20 實測 5 篇，一次 4 篇沒有被擋）。標題有（PR）的是轉載新聞稿' },
  // T64（composite_layer_design §0.4 的 Y2、§5.1 的 M5）：市場摘要要讀的財經媒體。四個都是媒體級：單一媒體的一篇報導不夠（web_evidence_design §1.6），要兩個不同網域
  { domain: 'cnbc.com', tier: 'MEDIA', label: 'CNBC', note: '文章頁抓得到，meta 有發布日（2026-11-21 實測 2 篇，含當天的即時更新頁）' },
  { domain: 'finance.yahoo.com', tier: 'MEDIA', label: 'Yahoo Finance', note: '只收文章路徑（/news/）；報價頁、列表頁不收。JSON-LD 有發布日；開頭夾一句廣告字樣；轉載通訊社的文章常只有開頭一小段（THIN）（2026-11-21 實測 2 篇）', paths: ['/news/'] },
  { domain: 'npr.org', tier: 'MEDIA', label: 'NPR', note: '文章頁抓得到，認得出發布日；有些是美聯社的稿（2026-11-21 實測 2 篇）' },
  { domain: 'fortune.com', tier: 'MEDIA', label: 'Fortune', note: '文章頁抓得到，認得出發布日（2026-11-21 實測 2 篇）' },
  // T64（§5.1）：官方來源。頁面結構和文章頁不同，各自寫擷取方式（extract）；只收新聞稿、演講、證詞這幾種有明確發布日的頁面
  {
    domain: 'federalreserve.gov',
    tier: 'PRIMARY',
    label: '聯準會（Federal Reserve Board）',
    note: '只收新聞稿（含利率決議聲明）、演講、國會證詞。發布日寫在標題上面那一行，離內文遠的時候用網址裡的日期；利率決議聲明很短，內文門檻降到 400 字。會議紀錄不收（網址的日期是開會日，不是發布日）',
    paths: ['/newsevents/pressreleases/', '/newsevents/speech/', '/newsevents/testimony/'],
    extract: { minBody: 400, urlDate: true },
  },
  {
    domain: 'bls.gov',
    tier: 'PRIMARY',
    label: '美國勞工統計局（BLS）',
    note: '只收新聞稿（/news.release/：就業報告、CPI…）。內文放在 <pre>、固定寬度斷行，先接回成段落；發布日是開頭「8:30 a.m. (ET) Friday, …」那一行。瀏覽器的 User-Agent 從 Cloudflare 與本機都是 403，改用寫明是程式的（selfIdentify）就抓得到；發布時間那一行後面可能接著新聞稿編號（USDL-…）（2026-11-21 實測就業報告與 CPI）',
    paths: ['/news.release/'],
    extract: { minBody: 800, pre: true, releaseLine: true, selfIdentify: true },
  },
];

/**
 * 不列入：抓得到也不抓（評論、預測、社群），每檔的 domains 也不能加（設計 §1.3、第 6 章第 4 項）。
 * 它們的標題照舊只當初判。被擋的大型媒體（Reuters、Bloomberg、WSJ…）不在這裡：列了也抓不到，見設計 §0.5。
 */
export const WEB_EXCLUDED: readonly string[] = ['fool.com', 'stocktwits.com', '247wallst.com', 'tikr.com', 'seekingalpha.com', 'zacks.com', 'benzinga.com', 'investorplace.com', 'reddit.com', 'x.com', 'twitter.com'];

/** 主機名稱是不是這個網域或它的子網域。 */
export function hostMatches(host: string, domain: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  const d = domain.toLowerCase();
  return h === d || h.endsWith(`.${d}`);
}

export interface WebSourceMatch {
  domain: string;
  tier: WebTier;
  label: string;
  /** 這個來源自己的擷取方式（T64；只有共用清單上寫了的才有）。 */
  extract?: WebExtract;
}

export type WebSourceMiss = 'EXCLUDED' | 'NOT_LISTED' | 'PATH';

/**
 * 網址在不在清單內：先看不列入的，再看共用清單（路徑限制照 `paths`），最後看這檔自己的一手網域（一律 `PRIMARY`）。
 * 共用清單的網域路徑不符時，不會因為也在這檔的 domains 裡就放行（路徑限制是為了擋付費頁）。
 */
export function matchWebSource(url: URL, extraDomains: readonly string[] = [], list: readonly WebSource[] = WEB_SOURCES): WebSourceMatch | { miss: WebSourceMiss } {
  const host = url.hostname;
  if (WEB_EXCLUDED.some((d) => hostMatches(host, d))) return { miss: 'EXCLUDED' };
  const s = list.find((x) => hostMatches(host, x.domain));
  if (s) {
    if (s.paths && !s.paths.some((p) => url.pathname.toLowerCase().startsWith(p.toLowerCase()))) return { miss: 'PATH' };
    return { domain: s.domain, tier: s.tier, label: s.label, ...(s.extract ? { extract: s.extract } : {}) };
  }
  const extra = extraDomains.map((d) => d.trim().toLowerCase()).find((d) => d && hostMatches(host, d));
  if (extra) return { domain: extra, tier: 'PRIMARY', label: extra };
  return { miss: 'NOT_LISTED' };
}

/** 級別的白話（目錄、取回的文件標題、網站用）。 */
export const TIER_TEXT: Record<WebTier, string> = { PRIMARY: '一手', NAMED: '指名的產業來源', MEDIA: '媒體' };

/** 兩個網域是不是同一個來源：一個是另一個的子網域也算（`www.trendforce.com` 與 `trendforce.com`）。 */
export const sameWebDomain = (a: string, b: string): boolean => hostMatches(a, b) || hostMatches(b, a);

/**
 * 可以當證據的網頁來源（T53，設計 §1.3、§1.6）：共用清單＋這檔自己的一手網域。
 * 審查的證據包列出來（分析師搜尋時優先挑）、事件條件指名來源（`confirm_by` 的 `web:<網域>`）時也只能指名這些。
 */
export function listedWebSources(extraDomains: readonly string[] = [], list: readonly WebSource[] = WEB_SOURCES): (WebSourceMatch & { paths?: readonly string[] })[] {
  const out: (WebSourceMatch & { paths?: readonly string[] })[] = list.map((s) => ({ domain: s.domain, tier: s.tier, label: s.label, ...(s.paths ? { paths: s.paths } : {}) }));
  for (const raw of extraDomains) {
    const d = raw.trim().toLowerCase();
    if (!d || WEB_EXCLUDED.some((x) => hostMatches(d, x)) || out.some((s) => sameWebDomain(d, s.domain))) continue;
    out.push({ domain: d, tier: 'PRIMARY', label: d });
  }
  return out;
}

/** 指名的網域對到哪一個可以用的來源（對不到是 null）：網域本身或它的子網域都算，回傳清單上的寫法。 */
export function findWebSource(domain: string, extraDomains: readonly string[] = [], list: readonly WebSource[] = WEB_SOURCES): WebSourceMatch | null {
  const d = domain.trim().toLowerCase().replace(/\.$/, '');
  if (!d) return null;
  const s = listedWebSources(extraDomains, list).find((x) => hostMatches(d, x.domain));
  return s ? { domain: s.domain, tier: s.tier, label: s.label } : null;
}

/** 來源的名稱（網站與通知用）：清單上有就用它的名稱，沒有就寫網域。 */
export const webLabel = (domain: string, list: readonly WebSource[] = WEB_SOURCES): string => list.find((s) => sameWebDomain(domain, s.domain))?.label ?? domain;
