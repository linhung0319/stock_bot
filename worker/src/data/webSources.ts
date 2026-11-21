// 網頁證據的來源級別（T51 起；T68 改成「種子＋AI 評級」，設計 docs/design/confirm_audit_design_2026-11-21.md 第 1 章）。
//
//   抓取：不在排除列表（WEB_EXCLUDED，以及 AI 評成 EXCLUDE 的）的公開 https 主機都抓；種子寫了 onlyPaths／skipPaths 的照它（§1.3）。
//   級別（§1.1、§1.2、§1.5）：先看排除列表、再看種子（這個檔案的 WEB_SOURCES，人寫的，AI 改不了）、再看 AI 評的（D1 的 web_source_ratings），
//     都沒有是 UNRATED。能拿來判前提、確認條件的看「當下」的級別：PRIMARY、NAMED 可以；MEDIA 要兩個不同網域；LEAD、UNRATED 只當線索。
//   改種子＝改這個檔案、commit、部署（使用者說某個網域不對，主持者改種子）。repo 是公開的，這裡沒有私人資料。
//   起始名單照 2026-11-20 的實測（web_evidence_design §0.5 的 M1、M2）與 T64 的官方來源。

/** 種子的級別。 */
export type WebTier = 'PRIMARY' | 'NAMED' | 'MEDIA';
/** 網域現在的級別（§1.2）：種子或 AI 給的三級、AI 評過但不夠格的 LEAD、還沒評的 UNRATED。 */
export type WebRating = WebTier | 'LEAD' | 'UNRATED';
/** 來源評級（AI）可以給的（§1.4）：三級、LEAD、EXCLUDE（之後不抓、評不上去）。 */
export type AiTier = WebTier | 'LEAD' | 'EXCLUDE';
export const AI_TIERS: readonly AiTier[] = ['PRIMARY', 'NAMED', 'MEDIA', 'LEAD', 'EXCLUDE'];

export interface WebSource {
  /** 比對主機名稱的結尾：`trendforce.com` 涵蓋 `www.trendforce.com`。 */
  domain: string;
  tier: WebTier;
  /** 給人與 AI 看的來源名稱。 */
  label: string;
  /** 為什麼列、限制、實測結果（白話）。 */
  note: string;
  /**
   * 只收這些路徑開頭（§1.3：只留有明確理由的）；沒有就是整個網域。
   * 聯準會、勞工統計局：會議紀錄的網址日期是開會日、不是發布日，其他頁面的日期認法也不同。
   */
  onlyPaths?: readonly string[];
  /** 這些路徑開頭的不收（TrendForce 的付費報告頁只有摘要）。 */
  skipPaths?: readonly string[];
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

/** 種子（§1.1 第 5 點）：人寫的級別，AI 改不了。 */
export const WEB_SOURCES: readonly WebSource[] = [
  // 一手：發布者就是當事人或統計機關（其他公司與同業的新聞室由來源評級給級別）
  { domain: 'nvidianews.nvidia.com', tier: 'PRIMARY', label: 'NVIDIA 新聞室', note: '新聞稿全文抓得到；發布日只寫在標題下面那一行（2026-11-20 實測 2 篇）。T68 拿掉路徑限制：列表頁認不出發布日，會被 NO_DATE 擋下' },
  { domain: 'semiconductors.org', tier: 'PRIMARY', label: 'SIA 美國半導體產業協會', note: '每月全球半導體銷售額的新聞稿；meta 有發布日（2026-11-20 實測 2 篇）' },
  // 產業研究機構：公開新聞稿與報價摘要
  { domain: 'trendforce.com', tier: 'NAMED', label: 'TrendForce', note: '付費報告頁（/research/）只有摘要，不收；其他頁照一般規則。JSON-LD 有發布日（2026-11-20 實測文章頁 4 篇，一次 4 篇沒有被擋）', skipPaths: ['/research/'] },
  { domain: 'dramexchange.com', tier: 'NAMED', label: 'DRAMeXchange（TrendForce）', note: '週報文章的發布日寫在「Published」那一行（2026-11-20 實測 5 篇，一次 4 篇沒有被擋）。T68 拿掉路徑限制：報價頁認不出發布日或內文太短，會被 NO_DATE／THIN 擋下' },
  // 媒體：有編輯、會寫明消息來源的產業媒體
  { domain: 'techpowerup.com', tier: 'MEDIA', label: 'TechPowerUp', note: '短新聞的內文剛好過 1,500 字；<time> 有發布日（2026-11-20 實測 5 篇，一次 4 篇沒有被擋）。標題有（PR）的是轉載新聞稿' },
  // T64（composite_layer_design §0.4 的 Y2、§5.1 的 M5）：市場摘要要讀的財經媒體。四個都是媒體級：單一媒體的一篇報導不夠，要兩個不同網域
  { domain: 'cnbc.com', tier: 'MEDIA', label: 'CNBC', note: '文章頁抓得到，meta 有發布日（2026-11-21 實測 2 篇，含當天的即時更新頁）' },
  { domain: 'finance.yahoo.com', tier: 'MEDIA', label: 'Yahoo Finance', note: 'JSON-LD 有發布日；開頭夾一句廣告字樣；轉載通訊社的文章常只有開頭一小段（THIN）（2026-11-21 實測 2 篇）。T68 拿掉路徑限制：/markets/…/articles/ 的文章也收（M7 被擋的那種），報價頁、列表頁會被 NO_DATE／THIN 擋下' },
  { domain: 'npr.org', tier: 'MEDIA', label: 'NPR', note: '文章頁抓得到，認得出發布日；有些是美聯社的稿（2026-11-21 實測 2 篇）' },
  { domain: 'fortune.com', tier: 'MEDIA', label: 'Fortune', note: '文章頁抓得到，認得出發布日（2026-11-21 實測 2 篇）' },
  // T64（§5.1）：官方來源。頁面結構和文章頁不同，各自寫擷取方式（extract）；只收新聞稿、演講、證詞這幾種有明確發布日的頁面
  {
    domain: 'federalreserve.gov',
    tier: 'PRIMARY',
    label: '聯準會（Federal Reserve Board）',
    note: '只收新聞稿（含利率決議聲明）、演講、國會證詞。發布日寫在標題上面那一行，離內文遠的時候用網址裡的日期；利率決議聲明很短，內文門檻降到 400 字。會議紀錄不收（網址的日期是開會日，不是發布日）',
    onlyPaths: ['/newsevents/pressreleases/', '/newsevents/speech/', '/newsevents/testimony/'],
    extract: { minBody: 400, urlDate: true },
  },
  {
    domain: 'bls.gov',
    tier: 'PRIMARY',
    label: '美國勞工統計局（BLS）',
    note: '只收新聞稿（/news.release/：就業報告、CPI…）。內文放在 <pre>、固定寬度斷行，先接回成段落；發布日是開頭「8:30 a.m. (ET) Friday, …」那一行（其他頁面的日期認法不同）。瀏覽器的 User-Agent 從 Cloudflare 與本機都是 403，改用寫明是程式的（selfIdentify）就抓得到；發布時間那一行後面可能接著新聞稿編號（USDL-…）（2026-11-21 實測就業報告與 CPI）',
    onlyPaths: ['/news.release/'],
    extract: { minBody: 800, pre: true, releaseLine: true, selfIdentify: true },
  },
];

/**
 * 排除列表：抓得到也不抓（評論、預測、社群），AI 也評不上去（§1.1 第 6 點）。
 * 它們的標題照舊只當初判。被擋的大型媒體（Reuters、Bloomberg、WSJ…）不在這裡：列了也抓不到，見 web_evidence_design §0.5。
 */
export const WEB_EXCLUDED: readonly string[] = ['fool.com', 'stocktwits.com', '247wallst.com', 'tikr.com', 'seekingalpha.com', 'zacks.com', 'benzinga.com', 'investorplace.com', 'reddit.com', 'x.com', 'twitter.com'];

/** 主機名稱是不是這個網域或它的子網域。 */
export function hostMatches(host: string, domain: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  const d = domain.toLowerCase();
  return h === d || h.endsWith(`.${d}`);
}

/** 兩個網域是不是同一個來源：一個是另一個的子網域也算（`www.trendforce.com` 與 `trendforce.com`）。 */
export const sameWebDomain = (a: string, b: string): boolean => hostMatches(a, b) || hostMatches(b, a);

/** 主機名稱 → 評級表用的網域（§1.5：小寫、去掉 `www.`、去掉結尾的點）。 */
export const webDomainOf = (host: string): string => host.trim().toLowerCase().replace(/\.$/, '').replace(/^www\./, '');

/** 在排除列表裡（WEB_EXCLUDED；網域本身或它的子網域）。 */
export const isExcluded = (host: string): boolean => WEB_EXCLUDED.some((d) => hostMatches(host, d));

/** 主機對到的種子（網域本身或它的子網域）；沒有是 undefined。 */
export const seedOf = (host: string, list: readonly WebSource[] = WEB_SOURCES): WebSource | undefined => list.find((s) => hostMatches(host, s.domain));

/** 抓取時用的網域與擷取方式（種子的寫法優先：`www.trendforce.com` → `trendforce.com`）。 */
export interface WebFetchRule {
  domain: string;
  /** 種子的名稱；不是種子的是網域。 */
  label: string;
  seed: boolean;
  extract?: WebExtract;
}
export type WebSourceMiss = 'EXCLUDED' | 'PATH';

/**
 * 這個網址抓不抓（§1.3）：排除列表（含 AI 評成 EXCLUDE 的，aiExcluded）→ EXCLUDED；種子寫了 onlyPaths／skipPaths 而路徑不收 → PATH；
 * 其他都抓（不再要求在清單內）。轉址的每一站也照這個規則（webDoc.ts）。
 */
export function webFetchRule(url: URL, aiExcluded: ReadonlySet<string> = new Set(), list: readonly WebSource[] = WEB_SOURCES): WebFetchRule | { miss: WebSourceMiss } {
  const host = url.hostname;
  if (isExcluded(host)) return { miss: 'EXCLUDED' };
  const s = seedOf(host, list);
  if (s) {
    const path = url.pathname.toLowerCase();
    if (s.onlyPaths && !s.onlyPaths.some((p) => path.startsWith(p.toLowerCase()))) return { miss: 'PATH' };
    if (s.skipPaths?.some((p) => path.startsWith(p.toLowerCase()))) return { miss: 'PATH' };
    return { domain: s.domain, label: s.label, seed: true, ...(s.extract ? { extract: s.extract } : {}) };
  }
  const domain = webDomainOf(host);
  if (aiExcluded.has(domain)) return { miss: 'EXCLUDED' };
  return { domain, label: domain, seed: false };
}

/** 評級表的一列（web_source_ratings，§1.5）。 */
export interface WebRatingRow {
  domain: string;
  tier: AiTier;
  site_name: string | null;
  reason: string | null;
  run_id: string | null;
  rated_at: string;
}

/** 一個網域現在的級別與它從哪裡來。rating = EXCLUDED：排除列表或 AI 評成 EXCLUDE（不抓、不能當證據）。 */
export interface DomainRating {
  domain: string;
  rating: WebRating | 'EXCLUDED';
  by: 'EXCLUDED' | 'SEED' | 'AI' | 'NONE';
  /** 給人看的名稱：種子的名稱、AI 評級時 Worker 取的網站名稱，都沒有是網域。 */
  label: string;
  /** AI 評級的理由與哪一次執行評的（種子、排除、還沒評的是 null）。 */
  reason: string | null;
  runId: string | null;
}

/**
 * 級別查詢（§1.1、§1.5）：排除列表 → 種子 → 評級表 → UNRATED。種子與排除比對網域與子網域；評級表只認同一個網域
 * （子網域可能是不同的人：`a.substack.com` 與 `b.substack.com`）。table：web_source_ratings 的列（網域 → 列）。
 */
export function rateDomain(host: string, table: ReadonlyMap<string, WebRatingRow> = new Map(), list: readonly WebSource[] = WEB_SOURCES): DomainRating {
  const domain = webDomainOf(host);
  if (isExcluded(domain)) return { domain, rating: 'EXCLUDED', by: 'EXCLUDED', label: domain, reason: null, runId: null };
  const s = seedOf(domain, list);
  if (s) return { domain: s.domain, rating: s.tier, by: 'SEED', label: s.label, reason: null, runId: null };
  const r = table.get(domain);
  if (r) return { domain, rating: r.tier === 'EXCLUDE' ? 'EXCLUDED' : r.tier, by: 'AI', label: r.site_name?.trim() || domain, reason: r.reason, runId: r.run_id };
  return { domain, rating: 'UNRATED', by: 'NONE', label: domain, reason: null, runId: null };
}

/** 評級表裡 AI 評成 EXCLUDE 的網域（抓取時當成排除）。 */
export const aiExcludedOf = (table: ReadonlyMap<string, WebRatingRow>): Set<string> => new Set([...table.values()].filter((r) => r.tier === 'EXCLUDE').map((r) => r.domain));

/** 可以判前提不成立、確認條件成立的級別（§1.2：一手、產業研究機構；媒體另有兩個網域的規定）。 */
export const STRONG_RATINGS: readonly string[] = ['PRIMARY', 'NAMED'];
/** 算得上「有級別」的（LEAD、UNRATED、排除的只當線索）。 */
export const GRADED_RATINGS: readonly string[] = ['PRIMARY', 'NAMED', 'MEDIA'];

/** 級別的白話（目錄、取回的文件標題、網站用）。 */
export const TIER_TEXT: Record<WebRating | 'EXCLUDED', string> = { PRIMARY: '一手', NAMED: '產業研究機構', MEDIA: '媒體', LEAD: '只當線索', UNRATED: '還沒評級', EXCLUDED: '排除' };

/**
 * 種子（facts 的 S 開頭，§1.5 的分析師步驟「優先挑」；T68 起不再限制取得到什麼）：網域、名稱、級別、只收或不收哪些路徑。
 */
export function seedSources(list: readonly WebSource[] = WEB_SOURCES): { domain: string; tier: WebTier; label: string; onlyPaths?: readonly string[]; skipPaths?: readonly string[] }[] {
  return list.map((s) => ({ domain: s.domain, tier: s.tier, label: s.label, ...(s.onlyPaths ? { onlyPaths: s.onlyPaths } : {}), ...(s.skipPaths ? { skipPaths: s.skipPaths } : {}) }));
}

/** 來源的名稱（網站與通知用）：種子有就用它的名稱，其次是評級表的網站名稱，都沒有就寫網域。 */
export const webLabel = (domain: string, table: ReadonlyMap<string, WebRatingRow> = new Map(), list: readonly WebSource[] = WEB_SOURCES): string =>
  list.find((s) => sameWebDomain(domain, s.domain))?.label ?? (table.get(webDomainOf(domain))?.site_name?.trim() || domain);
