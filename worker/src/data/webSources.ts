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
    return { domain: s.domain, tier: s.tier, label: s.label };
  }
  const extra = extraDomains.map((d) => d.trim().toLowerCase()).find((d) => d && hostMatches(host, d));
  if (extra) return { domain: extra, tier: 'PRIMARY', label: extra };
  return { miss: 'NOT_LISTED' };
}
