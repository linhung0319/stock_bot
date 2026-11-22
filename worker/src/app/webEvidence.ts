// T52：每檔的網頁證據來源、證據包的目錄、取文件的端點（web_evidence_design §1.2、§1.3、§1.5）。
//
//   每檔的來源（OwnMeta.webSources）：同業 { name, edgar?, yahoo? } 最多 4 家。T68 起 domains 不再讀（confirm_audit_design §1.7：
//     抓取、取文件、條件來源都不看；已經存的留在資料裡）。存檔前程式核對同業的 EDGAR 代號（抓不到的仍存，寫「目前抓不到」，G24）。
//   目錄（facts 的 M 開頭，§1.2）：只有標題，不帶全文，證據包不因同業與網頁變大。
//     S1 同業在 EDGAR 的 8-K（上次有結論的審查之後，最新的 2.02 排最前面，每家最多 3 份）；
//     S2 這檔與同業 Yahoo 代號的 RSS 裡，連結不在排除列表的標題（T68 起不限清單內），標上網域現在的級別。最多 20 項，S1 在前。
//     只有系統預設前提的股票沒有目錄，也不能取文件。
//   取文件（POST /ai/task/<編號>/docs，§1.5）：分析師（審查、減半檢視）或研究員（草稿）讀完證據包後，送目錄編號或網址；
//     Worker 檢查排除列表、當場抓（src/data/webDoc.ts）、存快照、記進這次執行的 added_docs、把原文連同網域與級別回給它。
//     表決時 check.ts 比對的原文＝證據包的文件＋取回的文件（src/ai/added.ts 的 withAdded；check.ts 本身不改）。
//   來源評級（T68，confirm_audit_design §1.4）：GET /ai/task/<編號>/unrated 回這次取回的文件裡還沒評級的網域與網站名稱；
//     POST /ai/task/<編號>/ratings 收另一個子代理「來源評級」的結果，寫進 web_source_ratings（src/app/webRatings.ts）。
import { DOCS_MAX, DOCS_MAX_CALLS, DOCS_MAX_CHARS, DOCS_PER_CALL, DOC_FNS, FILING_GIVE, REFUSED_KEEP, WEB_GIVE, addedHash, parseAdded, withAdded, type AddedDoc, type AddedRecord, type DocCtx, type MenuEntry, type RefuseReason } from '../ai/added';
import type { EvidencePack } from '../ai/check';
import { FRESH_ROLE, freshView } from '../ai/freshEyes';
import { MARKET_BRIEF, MARKET_DOC_TICKER } from '../ai/marketBrief';
import { NEWS_SOURCES, fetchFilingDoc, tryHeadlineSource, type Headline } from '../data/edgar';
import { fetchEdgarSubmissions, type Filing } from '../data/sources';
import { errText } from '../data/util';
import { markWebDocUsed, normalizeWebUrl, obtainWebDoc, safeWebUrl, webDocId } from '../data/webDoc';
import { AI_TIERS, TIER_TEXT, WEB_EXCLUDED, WEB_SOURCES, aiExcludedOf, hostMatches, isExcluded, rateDomain, seedOf, seedSources, webDomainOf, webFetchRule, type AiTier, type WebRating, type WebRatingRow } from '../data/webSources';
import { fileMeta, type OwnMeta, type OwnWebSources, type WebPeer, type WebSourceCheck } from '../engine';
import { TASK_TIMEOUT_MS, getTask } from './aiTasks';
import { json, type Env, type Fetcher } from './env';
import { cikFor } from './filings';
import { loadAccount } from './ledgerStore';
import { afterLastReview, fileKind, type ThesisFile } from './thesis';
import { insertRating, loadRatings } from './webRatings';

type Fact = EvidencePack['facts'][number];

/** 每檔的上限（§1.3）。 */
export const PEERS_MAX = 4;
export const DOMAINS_MAX = 6;
/** 目錄最多幾項；同業每家最多列幾份申報（§1.2）。 */
export const MENU_MAX = 20;
export const PEER_FILINGS_MAX = 3;
/** 網頁發布日早於「上次有結論的審查」超過幾天 → TOO_OLD；沒有上一次審查時算最近幾天（§1.5）。 */
export const TOO_OLD_DAYS = 120;
export const NO_REVIEW_WEB_DAYS = 365;

const minusDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) - n * 86400_000).toISOString().slice(0, 10);

/** 級別的白話（目錄與取回的文件標題用；定義在 webSources.ts）。 */
export { TIER_TEXT };

// ---------------------------------------------------------------- 每檔的來源：檢查與試抓

/** 使用者填的網域 → 主機名稱（貼網址也收，只取主機）；不像網域的回 null。 */
export function normalizeDomain(raw: string): string | null {
  let s = raw.trim().toLowerCase();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(s)) s = `https://${s}`;
  let host: string;
  try {
    host = new URL(s).hostname.replace(/\.$/, '');
  } catch {
    return null;
  }
  return safeWebUrl(`https://${host}/`) ? host : null;
}

const EDGAR_CODE = /^[A-Z][A-Z0-9.-]{0,9}$/;
const YAHOO_CODE = /^[A-Z0-9^][A-Z0-9.=^-]{0,19}$/;
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/**
 * 編輯論點頁送來的來源 → 檢查過的 OwnWebSources（同業與網域都空的回 null = 不指定）。
 * 不合格的丟 Error（訊息直接給使用者看）：不列入的網站（fool.com 等）加不進來；共用清單已經有的網域不用另外加。
 */
export function parseWebSources(raw: unknown, ticker: string): OwnWebSources | null {
  if (raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('來源的格式不對');
  const o = raw as Record<string, unknown>;
  const rawPeers = Array.isArray(o.peers) ? o.peers : [];
  const rawDomains = Array.isArray(o.domains) ? o.domains : [];
  const peers: WebPeer[] = [];
  for (const p of rawPeers) {
    const r = (p ?? {}) as Record<string, unknown>;
    const name = str(r.name, 60);
    const edgar = str(r.edgar, 12).toUpperCase().replace(/[\s/]/g, '');
    const yahoo = str(r.yahoo, 20).toUpperCase().replace(/\s/g, '');
    if (!name && !edgar && !yahoo) continue;
    if (!name) throw new Error(`同業（${edgar || yahoo}）要有名稱`);
    if (!edgar && !yahoo) throw new Error(`同業「${name}」要填 EDGAR 代號或 Yahoo 代號（至少一個）`);
    if (edgar && !EDGAR_CODE.test(edgar)) throw new Error(`同業「${name}」的 EDGAR 代號「${edgar}」看起來不對（美股代號，例如 MU）`);
    if (yahoo && !YAHOO_CODE.test(yahoo)) throw new Error(`同業「${name}」的 Yahoo 代號「${yahoo}」看起來不對（例如 000660.KS）`);
    if (edgar === ticker.toUpperCase() || yahoo === ticker.toUpperCase()) throw new Error(`同業不能是 ${ticker} 自己`);
    if (peers.some((x) => (edgar && x.edgar === edgar) || (yahoo && x.yahoo === yahoo))) continue;
    peers.push({ name, ...(edgar ? { edgar } : {}), ...(yahoo ? { yahoo } : {}) });
  }
  if (peers.length > PEERS_MAX) throw new Error(`同業最多 ${PEERS_MAX} 家`);
  const domains: string[] = [];
  for (const d of rawDomains) {
    const t = str(d, 200);
    if (!t) continue;
    const host = normalizeDomain(t);
    if (!host) throw new Error(`「${t}」不是可以用的網域（要是公開網站的主機名稱，例如 news.skhynix.com）`);
    if (WEB_EXCLUDED.some((x) => hostMatches(host, x))) throw new Error(`${host} 是不列入的網站（評論、預測、社群）：抓得到也不當證據，加不進來`);
    const shared = WEB_SOURCES.find((s) => hostMatches(host, s.domain));
    if (shared) throw new Error(`${host} 已經在共用清單裡（${shared.label}），不用另外加`);
    if (!domains.includes(host)) domains.push(host);
  }
  if (domains.length > DOMAINS_MAX) throw new Error(`這檔的一手網域最多 ${DOMAINS_MAX} 個`);
  return peers.length || domains.length ? { peers, domains } : null;
}

/** 兩份來源是不是一樣（不看試抓結果）。 */
export function sameWebSources(a: OwnWebSources | null | undefined, b: OwnWebSources | null | undefined): boolean {
  const key = (w: OwnWebSources | null | undefined) => JSON.stringify(w ? { p: w.peers.map((p) => [p.name, p.edgar ?? '', p.yahoo ?? '']), d: w.domains } : null);
  return key(a) === key(b);
}

/**
 * 存檔前核對的每一項（T68，confirm_audit_design §1.7：只剩同業的 EDGAR 代號存在不存在）。
 * Yahoo 代號與網域不再試抓：網域不再讀；Yahoo 代號照舊用來列同業新聞裡的連結，抓不到時組目錄會記在 notes。
 */
export function webSourceKeys(ws: OwnWebSources): string[] {
  return ws.peers.flatMap((p) => (p.edgar ? [`edgar:${p.edgar}`] : []));
}

const YAHOO = NEWS_SOURCES.find((s) => s.key === 'yahoo-rss')!;

async function probeOne(env: Env, fetcher: Fetcher, key: string): Promise<WebSourceCheck> {
  const v = key.slice(key.indexOf(':') + 1);
  try {
    if (!env.EDGAR_USER_AGENT) return { key, ok: null, why: '沒有設定 EDGAR 的 User-Agent，沒有試' };
    const cik = await cikFor(env, fetcher, v);
    return cik ? { key, ok: true, why: `EDGAR 找得到（CIK ${cik}）` } : { key, ok: false, why: 'EDGAR 找不到這個代號（不在美國申報的公司多半沒有，可以只填 Yahoo 代號）' };
  } catch (e) {
    return { key, ok: false, why: `目前抓不到（${errText(e).slice(0, 120)}）` };
  }
}

/** 核對每一項（存檔前、編輯論點頁的「試抓」）：抓不到的只標出來，不擋存檔。 */
export async function probeWebSources(env: Env, fetcher: Fetcher, ws: OwnWebSources): Promise<WebSourceCheck[]> {
  return Promise.all(webSourceKeys(ws).map((k) => probeOne(env, fetcher, k)));
}

/** 示範模式不對外連線：每一項都是「沒有試」。 */
export const demoProbe = (ws: OwnWebSources): WebSourceCheck[] => webSourceKeys(ws).map((key) => ({ key, ok: null, why: '示範模式不會真的去抓' }));

// ---------------------------------------------------------------- 目錄（§1.2）

const ITEM_TEXT: Record<string, string> = { '2.02': '財報新聞稿', '5.02': '高層異動', '1.01': '重大合約', '1.05': '資安事件', '2.01': '收購或處分資產', '2.05': '重組', '2.06': '資產減損', '4.02': '財報不可信賴', '7.01': '公開說明', '8.01': '其他事件' };
function filingText(f: Pick<Filing, 'items'>): string {
  if (f.items.includes('2.02')) return '8-K 2.02（財報新聞稿）';
  const main = f.items.find((i) => i !== '9.01') ?? f.items[0];
  return main ? `8-K ${main}${ITEM_TEXT[main] ? `（${ITEM_TEXT[main]}）` : ''}` : '8-K';
}

/** 同業的申報挑法：上次有結論的審查之後的 8-K，最新的 2.02 排最前面，其餘新到舊，最多 n 份。 */
export function pickPeerFilings(filings: Filing[], tf: Pick<ThesisFile, 'lastReview' | 'newSince'>, asOf: string, n = PEER_FILINGS_MAX): Filing[] {
  const list = filings.filter((f) => f.form.startsWith('8-K') && f.filingDate <= asOf && afterLastReview(tf, f.filingDate, f.acceptedAt)).sort((a, b) => b.acceptedAt.localeCompare(a.acceptedAt) || b.filingDate.localeCompare(a.filingDate));
  const pr = list.find((f) => f.items.includes('2.02'));
  return (pr ? [pr, ...list.filter((f) => f !== pr)] : list).slice(0, n);
}

/**
 * 同業在 EDGAR 的申報清單（月底檢查點的 PEER，T54，web_evidence_design §1.7）：有 EDGAR 代號的同業各抓一次，合在一起。
 * 沒有同業（或都沒有 EDGAR 代號）→ 空的；全部抓不到 → null（不當成新證據）；抓不到的寫進 log。
 */
export async function fetchPeerFilings(env: Env, fetcher: Fetcher, ws: OwnWebSources | null, log: string[], ticker: string): Promise<Filing[] | null> {
  const peers = (ws?.peers ?? []).slice(0, PEERS_MAX).filter((p) => !!p.edgar);
  if (!peers.length) return [];
  const ua = env.EDGAR_USER_AGENT ?? '';
  const out: Filing[] = [];
  let ok = 0;
  for (const p of peers) {
    try {
      if (!ua) throw new Error('沒有設定 EDGAR 的 User-Agent');
      const cik = await cikFor(env, fetcher, p.edgar!);
      if (!cik) throw new Error('EDGAR 找不到這個代號');
      out.push(...(await fetchEdgarSubmissions(fetcher, cik, ua)).filings);
      ok += 1;
    } catch (e) {
      log.push(`${ticker} 的同業 ${p.name}（${p.edgar}）的申報抓不到（月底檢查點不算同業的新申報）：${errText(e)}`);
    }
  }
  return ok ? out : null;
}

/** 目錄的排序（T68）：一手與產業研究機構在前、媒體其次、只當線索與還沒評級的最後。 */
const RANK: Record<string, number> = { PRIMARY: 0, NAMED: 0, MEDIA: 1, LEAD: 2, UNRATED: 2 };

/**
 * RSS 標題裡的連結（S2）：決策日以前、不早於 notBefore；排除列表與種子的路徑不收的不列；同一個網址只留一則。
 * 每一項標上網域現在的級別（ratings：評級表）。一手與產業研究機構排在媒體前面、還沒評級的最後，同一級裡新的在前
 * （T64：RSS 的連結大多是媒體級的，目錄只列 20 項，不讓它們把一手與產業研究機構擠出去）。
 */
export function listedHeadlines(items: Headline[], ratings: ReadonlyMap<string, WebRatingRow>, asOf: string, notBefore: string): MenuEntry[] {
  const seen = new Set<string>();
  const aiEx = aiExcludedOf(ratings);
  const out: (MenuEntry & { at: string; rank: number })[] = [];
  for (const h of items) {
    const u = safeWebUrl(h.link);
    if (!u || h.date > asOf || h.date < notBefore) continue;
    const m = webFetchRule(u, aiEx);
    if ('miss' in m) continue;
    const r = rateDomain(m.domain, ratings);
    if (r.rating === 'EXCLUDED') continue;
    const url = normalizeWebUrl(u);
    if (seen.has(url)) continue;
    seen.add(url);
    const title = h.title.replace(/\s+/g, ' ').trim().slice(0, 160);
    out.push({ id: '', kind: 'web', text: `${r.label}｜${TIER_TEXT[r.rating]}｜${h.date}｜${title}`, url, title, published: h.date, at: h.at, rank: RANK[r.rating] ?? 2 });
  }
  return out.sort((a, b) => a.rank - b.rank || b.at.localeCompare(a.at)).map(({ at: _at, rank: _rank, ...e }) => e);
}

export interface MenuInput {
  ticker: string;
  tf: ThesisFile;
  meta: Pick<OwnMeta, 'webSources' | 'premises'>;
  asOf: string;
  /** 這檔自己的 RSS（審查的證據已經抓過，不重抓）；沒有就不列這檔的 RSS 連結。 */
  headlines?: Headline[] | null;
  /**
   * 論點草稿（T55，web_evidence_design §2.2）：只有系統預設前提的也組目錄、可以取文件——草稿正是要替還沒有論點的股票寫論點，
   * 研究員要能找資料（還沒有同業時目錄只有這檔的 RSS）。審查與減半檢視不給（只有預設前提的照舊不用網頁證據）。
   */
  anyKind?: boolean;
}

/**
 * 審查的目錄與「可以取什麼」（ai_runs.doc_ctx）。只有系統預設前提 → 沒有目錄、off（不能取文件）。
 * 抓不到的同業只記在 notes（組證據包時的紀錄），不影響審查。
 */
export async function buildDocMenu(env: Env, fetcher: Fetcher, inp: MenuInput): Promise<{ facts: Fact[]; ctx: DocCtx; notes: string[]; sources: { facts: Fact[]; domains: string[] } }> {
  const { tf, asOf } = inp;
  const notBefore = tf.lastReview ? minusDays(tf.lastReview.asOf, TOO_OLD_DAYS) : minusDays(asOf, NO_REVIEW_WEB_DAYS);
  const ws = inp.meta.webSources ?? null;
  if (!inp.anyKind && fileKind(inp.meta) === 'DEFAULT_ONLY') return { facts: [], ctx: { menu: [], notBefore, domains: [], fileId: tf.fileId, off: '只有系統預設前提：不用網頁證據' }, notes: [], sources: { facts: [], domains: [] } };
  const notes: string[] = [];
  const ua = env.EDGAR_USER_AGENT ?? '';
  // S1：同業在 EDGAR 的申報
  const s1: MenuEntry[] = [];
  for (const p of (ws?.peers ?? []).slice(0, PEERS_MAX)) {
    if (!p.edgar) continue;
    try {
      if (!ua) throw new Error('沒有設定 EDGAR 的 User-Agent');
      const cik = await cikFor(env, fetcher, p.edgar);
      if (!cik) throw new Error('EDGAR 找不到這個代號');
      const sub = await fetchEdgarSubmissions(fetcher, cik, ua);
      for (const f of pickPeerFilings(sub.filings, tf, asOf)) s1.push({ id: '', kind: 'filing', text: `${p.name}｜${filingText(f)}｜${f.filingDate}`, peer: p.name, cik, filing: { accession: f.accession, form: f.form, items: f.items, filingDate: f.filingDate, acceptedAt: f.acceptedAt, primaryDocument: f.primaryDocument } });
    } catch (e) {
      notes.push(`目錄：同業 ${p.name}（${p.edgar}）的申報抓不到：${errText(e)}`);
    }
  }
  // S2：這檔與同業的 RSS 裡的連結（排除列表的不列；標上現在的級別）
  const items: Headline[] = [...(inp.headlines ?? [])];
  for (const p of (ws?.peers ?? []).slice(0, PEERS_MAX)) {
    if (!p.yahoo) continue;
    const r = await tryHeadlineSource(fetcher, YAHOO, p.yahoo);
    if (r.ok) items.push(...r.items);
    else notes.push(`目錄：同業 ${p.name}（${p.yahoo}）的 RSS 抓不到：${r.error}`);
  }
  const s2 = listedHeadlines(items, env.DB ? await loadRatings(env.DB) : new Map(), asOf, notBefore);
  const all = [...s1, ...s2];
  const menu = all.slice(0, MENU_MAX).map((e, k) => ({ ...e, id: `M${k + 1}` }));
  const facts: Fact[] = menu.map((e, k) => ({ id: e.id, label: '可以取的文件', value: e.text, ...(k === 0 ? { note: '目錄只有標題；要讀全文，向 Worker 的取文件端點送這個編號' } : {}) }));
  if (all.length > MENU_MAX) facts.push({ id: 'M+', label: '可以取的文件', value: `另有 ${all.length - MENU_MAX} 項沒有列出` });
  // sources（T53）：種子（facts 的 S 開頭）和目錄分開回傳，呼叫的地方接在目錄後面。T68 起 domains 不再讀，ctx.domains 寫空的
  return { facts, ctx: { menu, notBefore, domains: [], fileId: tf.fileId }, notes, sources: sourceFacts() };
}

/**
 * 已經有級別的網頁來源（facts 的 S 開頭，T53；T68 起是「種子」，confirm_audit_design §1.1 第 5 點）：分析師搜尋時可以優先挑，
 * 一行一個（網域、名稱、級別、只收或不收哪些路徑）。T68 起不在這裡的網站也取得到全文，級別由來源評級決定（還沒評的只當線索）；
 * 條件的 web:<網域> 也不再限這幾個（只擋排除列表）。domains 是同一份的網域清單（記在 rule.detail.webDomains，只是紀錄）。
 * 只有系統預設前提的股票不用網頁證據：呼叫的地方不要放。
 */
export function sourceFacts(): { facts: Fact[]; domains: string[] } {
  const list = seedSources();
  const facts: Fact[] = list.map((s, k) => ({
    id: `S${k + 1}`,
    label: '已有級別的網頁來源',
    value: `${s.domain}｜${s.label}｜${TIER_TEXT[s.tier]}${s.onlyPaths ? `｜只收 ${s.onlyPaths.join('、')}` : ''}${s.skipPaths ? `｜不收 ${s.skipPaths.join('、')}` : ''}`,
    ...(k === 0 ? { note: '這些是人定好級別的種子；其他網站（排除列表以外）也取得到全文，級別由來源評級決定，還沒評級的只當線索' } : {}),
  }));
  return { facts, domains: list.map((s) => s.domain) };
}

// ---------------------------------------------------------------- 取文件的端點（§1.5）

interface RunRow {
  run_id: string;
  fn: string;
  ticker: string | null;
  as_of: string;
  status: string;
  doc_ctx: string | null;
  added_docs: string | null;
}

/** 沒有記下 doc_ctx 的執行（減半檢視等，T54、T55 之前）：照現在的帳戶算論點檔，發布日下限用決策日前 365 天（T68 起不讀這檔的網域）。 */
async function fallbackCtx(db: D1Database, ticker: string | null, asOf: string): Promise<DocCtx> {
  const acct = ticker ? (await loadAccount(db))?.acct : undefined;
  const meta = acct && ticker ? fileMeta(acct, ticker)?.meta : undefined;
  const notBefore = minusDays(asOf, NO_REVIEW_WEB_DAYS);
  if (!meta) return { menu: [], notBefore, domains: [], fileId: null, off: '已經不是自選股' };
  if (fileKind(meta) === 'DEFAULT_ONLY') return { menu: [], notBefore, domains: [], fileId: meta.fileId ?? null, off: '只有系統預設前提：不用網頁證據' };
  return { menu: [], notBefore, domains: [], fileId: meta.fileId ?? null };
}

const forOf = (v: unknown) => (typeof v === 'string' && /^[A-Z]{1,2}\d{1,4}$/.test(v.trim()) ? v.trim() : null);
const nf = (n: number) => n.toLocaleString('en-US');

/**
 * 取文件、來源評級的端點共用的檢查（§1.5「哪些任務可以用」「什麼時候可以用」；T68 的兩個端點照同樣的規則）：
 *   沒有這個任務 → 404；別的功能、只有系統預設前提 → 403；送回結果之後、逾時 → 410；還沒取證據包 → 409。
 */
async function openDocTask(env: Env, id: string, now: Date): Promise<{ t: NonNullable<Awaited<ReturnType<typeof getTask>>>; run: RunRow; ctx: DocCtx } | Response> {
  const db = env.DB;
  const t = await getTask(db, id);
  if (!t) return json({ error: 'not_found' }, 404);
  const run = t.kind === 'RUN' ? await db.prepare('SELECT run_id, fn, ticker, as_of, status, doc_ctx, added_docs FROM ai_runs WHERE task_id = ?').bind(id).first<RunRow>() : null;
  if (!run || !(DOC_FNS as readonly string[]).includes(run.fn)) return json({ error: 'not_allowed', why: '這個任務不能取文件（只有定期審查、減半檢視、論點草稿、市場摘要可以）' }, 403);
  if (!['PENDING', 'FETCHED'].includes(t.status) || run.status !== 'PENDING' || now.getTime() - Date.parse(t.created_at) > TASK_TIMEOUT_MS) return json({ error: 'task_closed', status: t.status }, 410);
  if (t.status === 'PENDING') return json({ error: 'evidence_not_fetched', why: '先取證據包，讀完再取文件' }, 409);
  const ctx = run.doc_ctx ? (JSON.parse(run.doc_ctx) as DocCtx) : await fallbackCtx(db, run.ticker, run.as_of);
  if (ctx.off) return json({ error: 'not_allowed', why: ctx.off }, 403);
  return { t, run, ctx };
}

/** 讀 JSON 物件的請求本文（太大 → 413、不是物件 → 400）。 */
function bodyObject(bodyText: string, hint: string): Record<string, unknown> | Response {
  if (new TextEncoder().encode(bodyText).length > 16_384) return json({ error: 'too_large' }, 413);
  try {
    const p = JSON.parse(bodyText) as unknown;
    if (typeof p !== 'object' || p === null || Array.isArray(p)) throw new Error();
    return p as Record<string, unknown>;
  } catch {
    return json({ error: 'bad_request', why: `要是 JSON 物件：${hint}` }, 400);
  }
}

export interface DocsReply {
  /** domain、rating（T68）：網頁的網域與取回這一刻的級別（PRIMARY／NAMED／MEDIA／LEAD／UNRATED）；同業申報是 null。tier 是同一個值（舊欄位）。 */
  docs: { id: string; source_id: string; kind: 'web' | 'filing'; tier: WebRating | null; domain: string | null; rating: WebRating | null; date: string; title: string; url: string | null; text: string; truncated: boolean }[];
  refused: { url?: string; menu?: string; reason: RefuseReason; detail: string | null }[];
  left: { docs: number; chars: number; calls: number };
}

/**
 * POST /ai/task/<編號>/docs：{ want: [{ menu: "M1" } | { url, title? }, for?, why?], role? }。
 *   別的功能 → 403；還沒取證據包 → 409；送回結果之後、逾時 → 410。
 *   每次執行最多取回 8 份、合計 60,000 字、呼叫 6 次，超過的回 LIMIT（記在執行紀錄）；網頁每份開頭 12,000 字、同業申報 15,000 字。
 *   每一筆網頁（含被拒絕的）寫進 web_docs；取回的記進 ai_runs.added_docs、web_docs.used_by。
 *   有新眼光的執行（T63，composite_layer_design §3；doc_ctx.fresh）：分析師的上限少掉留給它的額度（1 份、6,000 字、1 次呼叫，
 *   新眼光用掉之後就不再留）；role 寫「新眼光」的請求只能指定目錄（M）裡的文件、這次執行最多 1 份。沒有新眼光的執行不收它的請求。
 */
export async function handleTaskDocs(env: Env, fetcher: Fetcher, id: string, bodyText: string, now: Date): Promise<Response> {
  const db = env.DB;
  const open = await openDocTask(env, id, now);
  if (open instanceof Response) return open;
  const { run, ctx } = open;
  const body = bodyObject(bodyText, '{ "want": [...] }');
  if (body instanceof Response) return body;
  if (!Array.isArray(body.want)) return json({ error: 'bad_request', why: 'want 要是陣列' }, 400);
  const role = typeof body.role === 'string' ? body.role.slice(0, 40) : null;
  const rec: AddedRecord = parseAdded(run.added_docs);
  const prevRaw = run.added_docs ?? null;
  // 新眼光的額度（T63）：這次執行有新眼光時，分析師的上限扣掉還沒被新眼光用掉的那一份
  const isFresh = role?.trim() === FRESH_ROLE;
  if (isFresh && !ctx.fresh) return json({ error: 'not_allowed', why: '這次執行沒有新眼光，不能用這個角色取文件' }, 403);
  const freshUsed = () => rec.docs.filter((d) => d.role?.trim() === FRESH_ROLE).length;
  const held = !ctx.fresh || isFresh ? { docs: 0, chars: 0, calls: 0 } : { docs: Math.max(0, ctx.fresh.docs - freshUsed()), chars: freshUsed() >= ctx.fresh.docs ? 0 : ctx.fresh.chars, calls: Math.max(0, ctx.fresh.calls - (rec.freshCalls ?? 0)) };
  const cap = { docs: DOCS_MAX - held.docs, chars: DOCS_MAX_CHARS - held.chars, calls: DOCS_MAX_CALLS - held.calls };
  const heldNote = (n: number, unit: string) => (n ? `（其中 ${nf(n)} ${unit}留給新眼光）` : '');
  rec.calls += 1;
  if (isFresh) rec.freshCalls = (rec.freshCalls ?? 0) + 1;
  const at = now.toISOString();
  const reply: DocsReply = { docs: [], refused: [], left: { docs: 0, chars: 0, calls: 0 } };
  const refuse = (w: { url: string | null; menu: string | null; for: string | null; why: string | null }, reason: RefuseReason, detail: string | null) => {
    reply.refused.push({ ...(w.url ? { url: w.url } : {}), ...(w.menu ? { menu: w.menu } : {}), reason, detail });
    rec.refusedTotal += 1;
    if (rec.refused.length < REFUSED_KEEP) rec.refused.push({ url: w.url, menu: w.menu, reason, detail, for: w.for, why: w.why, at });
  };
  const give = (d: Omit<AddedDoc, 'id' | 'truncated' | 'text'> & { text: string; truncated: boolean; cap: number }) => {
    const left = cap.chars - rec.chars;
    let text = d.text.slice(0, d.cap);
    let truncated = d.truncated || d.text.length > d.cap;
    if (text.length > left) {
      text = text.slice(0, left);
      truncated = true;
    }
    const { cap: _cap, ...rest } = d;
    const doc: AddedDoc = { ...rest, id: `A${rec.docs.length + 1}`, title: truncated ? `${d.title}（只取開頭 ${nf(text.length)} 字）` : d.title, text, truncated };
    rec.docs.push(doc);
    rec.chars += text.length;
    return doc;
  };
  const siteCount = new Map(Object.entries(rec.sites));
  // 評級表（T68）：抓取時查級別、AI 評成 EXCLUDE 的不抓；取回的每一份回網域與這一刻的級別
  const ratings = await loadRatings(db);
  const aiEx = aiExcludedOf(ratings);

  for (const [k, raw] of body.want.entries()) {
    const o = (raw ?? {}) as Record<string, unknown>;
    const w = { url: typeof o.url === 'string' ? o.url.trim().slice(0, 2000) : null, menu: typeof o.menu === 'string' ? o.menu.trim().slice(0, 10) : null, for: forOf(o.for), why: typeof o.why === 'string' ? o.why.trim().slice(0, 300) || null : null };
    if (!w.url && !w.menu) {
      refuse(w, 'ERROR', '每一項要有 menu（目錄編號）或 url');
      continue;
    }
    if (rec.calls > cap.calls) {
      refuse(w, 'LIMIT', `每次執行最多呼叫 ${DOCS_MAX_CALLS} 次${heldNote(held.calls, '次')}`);
      continue;
    }
    if (isFresh && !w.menu) {
      refuse(w, 'ERROR', '新眼光只能指定目錄（M 開頭）裡的文件，不能給網址');
      continue;
    }
    if (k >= DOCS_PER_CALL) {
      refuse(w, 'LIMIT', `一次最多要 ${DOCS_PER_CALL} 份`);
      continue;
    }
    const entry = w.menu ? ctx.menu.find((e) => e.id === w.menu) : null;
    if (w.menu && !entry) {
      refuse(w, 'ERROR', `目錄沒有 ${w.menu}`);
      continue;
    }
    const url = entry?.kind === 'web' ? entry.url! : w.url;
    // 這次已經取過的：原樣再給一次，不算份數
    const sourceId = entry?.kind === 'filing' ? `edgar:${entry.filing!.accession}` : await webDocId(url && safeWebUrl(url) ? normalizeWebUrl(safeWebUrl(url)!) : (url ?? ''));
    const again = rec.docs.find((d) => d.source_id === sourceId);
    if (again) {
      reply.docs.push(docReply(again));
      continue;
    }
    if (isFresh && freshUsed() >= ctx.fresh!.docs) {
      refuse(w, 'LIMIT', `新眼光這次執行最多指定 ${ctx.fresh!.docs} 份`);
      continue;
    }
    if (rec.docs.length >= cap.docs) {
      refuse(w, 'LIMIT', `每次執行最多取回 ${DOCS_MAX} 份${heldNote(held.docs, '份')}`);
      continue;
    }
    if (rec.chars >= cap.chars) {
      refuse(w, 'LIMIT', `每次執行合計最多 ${nf(DOCS_MAX_CHARS)} 字${heldNote(held.chars, '字')}，已經用完`);
      continue;
    }
    // S1：同業的申報（和自己的申報同級，不寫 web_docs）。8-K 本文抓的時候就只留 15,000 字（edgar.ts），剛好 15,000 字的也標截掉
    if (entry?.kind === 'filing') {
      try {
        if (!env.EDGAR_USER_AGENT) throw new Error('沒有設定 EDGAR 的 User-Agent');
        const f = await fetchFilingDoc(fetcher, entry.cik!, entry.filing!, env.EDGAR_USER_AGENT);
        const doc = give({ source_id: sourceId, kind: 'filing', tier: null, date: f.filingDate, title: `〔同業申報｜${entry.peer}〕${f.title}`, url: f.url, text: f.text, truncated: f.text.length >= FILING_GIVE, cap: FILING_GIVE, fetched_at: at, via: 'MENU', menu: w.menu, for: w.for, why: w.why, role, at, row_id: null });
        reply.docs.push(docReply(doc));
      } catch (e) {
        refuse(w, 'ERROR', `申報抓不到：${errText(e).slice(0, 200)}`);
      }
      continue;
    }
    // 網頁（S2 的目錄或分析師找到的網址）
    const via = entry ? 'MENU' : 'SEARCH';
    const got = await obtainWebDoc(
      db,
      fetcher,
      // 市場摘要（T64）不屬於任何一檔：快照記在固定的代號下
      { url: url!, ticker: run.ticker ?? (run.fn === MARKET_BRIEF ? MARKET_DOC_TICKER : ''), fileId: ctx.fileId, via, ref: run.run_id, premiseId: w.for?.startsWith('P') ? w.for : null, condId: w.for && !w.for.startsWith('P') ? w.for : null, session: run.as_of },
      now,
      { ratings, title: entry?.title ?? (typeof o.title === 'string' ? o.title.slice(0, 300) : null), rssPublished: entry?.published ?? null, siteCount, decisionDate: run.as_of, notBefore: ctx.notBefore },
    );
    if (got.fetched?.status === 'LIMIT') {
      refuse(w, 'LIMIT', got.fetched.error);
      continue;
    }
    const row = got.row;
    if (!row || row.status !== 'OK' || !row.text) {
      refuse(w, (row?.status ?? 'ERROR') as RefuseReason, row?.error ?? null);
      continue;
    }
    // 之前抓過的快照：排除列表、路徑與日期照這次的規則再看一次（網址與轉址後的網址都看）
    const hit0 = webFetchRule(new URL(row.url), aiEx);
    const fin = row.final_url ? safeWebUrl(row.final_url) : null;
    const hit = 'miss' in hit0 || !fin ? hit0 : webFetchRule(fin, aiEx);
    if ('miss' in hit) {
      refuse(w, 'NOT_LISTED', hit.miss);
      continue;
    }
    const rated = rateDomain(hit.domain, ratings);
    if (rated.rating === 'EXCLUDED') {
      refuse(w, 'NOT_LISTED', 'EXCLUDED');
      continue;
    }
    const rating = rated.rating;
    if (!row.published) {
      refuse(w, 'NO_DATE', '認不出發布日');
      continue;
    }
    if (row.published > run.as_of) {
      refuse(w, 'ERROR', `發布日 ${row.published} 晚於決策日 ${run.as_of}`);
      continue;
    }
    if (row.published < ctx.notBefore) {
      refuse(w, 'TOO_OLD', `發布日 ${row.published} 早於 ${ctx.notBefore}`);
      continue;
    }
    const doc = give({ source_id: row.id, kind: 'web', tier: rating, date: row.published, title: `〔網頁｜${TIER_TEXT[rating]}｜${rated.label}〕${row.title ?? row.url}（發布 ${row.published}，${row.fetched_at.slice(0, 10)} 抓）`, url: row.final_url ?? row.url, text: row.text, truncated: !!row.truncated, cap: WEB_GIVE, fetched_at: row.fetched_at, via, menu: w.menu, for: w.for, why: w.why, role, at, row_id: row.row_id, domain: rated.domain, label: rated.label, site: row.site_name ?? null });
    await markWebDocUsed(db, row.row_id, run.run_id);
    reply.docs.push(docReply(doc));
  }
  rec.sites = Object.fromEntries(siteCount);
  const saved = await db
    .prepare("UPDATE ai_runs SET added_docs = ?, added_hash = ? WHERE run_id = ? AND status = 'PENDING' AND added_docs IS ?")
    .bind(JSON.stringify(rec), await addedHash(rec.docs), run.run_id, prevRaw)
    .run();
  if (!saved.meta.changes) return json({ error: 'conflict', why: '同時有另一個取文件的請求，或結果已經送回；請重試一次' }, 409);
  // left：這個角色還可以取多少（有新眼光時，分析師看到的已經扣掉留給它的；新眼光看到的是它自己那一份）
  reply.left = { docs: Math.max(0, isFresh ? Math.min(ctx.fresh!.docs - freshUsed(), DOCS_MAX - rec.docs.length) : cap.docs - rec.docs.length), chars: Math.max(0, cap.chars - rec.chars), calls: Math.max(0, cap.calls - rec.calls) };
  return json(reply);
}

/**
 * GET /ai/task/<編號>/fresh：給新眼光的那一份（T63，composite_layer_design §3；組法在 src/ai/freshEyes.ts 的 freshView）。
 *   沒有前提、論點本文、歷次審查、條件與事件清單；有價格與跌幅拆解的數字、清單內的來源與目錄、申報與財報表的原文、新聞標題，
 *   以及到這一刻為止分析師取回的文件。協調的主代理在分析師做完之後取，原樣交給新眼光那個子代理。
 *   這次沒有請新眼光跑（證據包的 fresh_eyes.run 不是 true）、別的功能 → 403；還沒取證據包 → 409；送回結果之後、逾時 → 410。
 */
export async function handleTaskFresh(env: Env, id: string, now: Date): Promise<Response> {
  const db = env.DB;
  const t = await getTask(db, id);
  if (!t) return json({ error: 'not_found' }, 404);
  const run = t.kind === 'RUN' ? await db.prepare('SELECT run_id, fn, status, pack, added_docs FROM ai_runs WHERE task_id = ?').bind(id).first<{ run_id: string; fn: string; status: string; pack: string; added_docs: string | null }>() : null;
  const pack = run ? (JSON.parse(run.pack) as EvidencePack) : null;
  if (!run || !pack || pack.fresh_eyes?.run !== true) return json({ error: 'not_allowed', why: '這次執行沒有新眼光' }, 403);
  if (!['PENDING', 'FETCHED'].includes(t.status) || run.status !== 'PENDING' || now.getTime() - Date.parse(t.created_at) > TASK_TIMEOUT_MS) return json({ error: 'task_closed', status: t.status }, 410);
  if (t.status === 'PENDING') return json({ error: 'evidence_not_fetched', why: '先取證據包' }, 409);
  return json({ task_id: t.id, kind: t.kind, fresh: freshView(withAdded(pack, parseAdded(run.added_docs).docs)) });
}

const docReply = (d: AddedDoc): DocsReply['docs'][number] => ({ id: d.id, source_id: d.source_id, kind: d.kind, tier: d.tier, domain: d.kind === 'web' ? (d.domain ?? null) : null, rating: d.kind === 'web' ? d.tier : null, date: d.date, title: d.title, url: d.url, text: d.text, truncated: d.truncated });

// ---------------------------------------------------------------- 來源評級的端點（T68，confirm_audit_design §1.4）

/** 一次最多送回幾個評級；理由最多幾個字（§1.4）。 */
export const RATINGS_PER_CALL = 12;
export const RATING_REASON_MAX = 100;

/** 這次執行取回的網頁裡，現在還沒評級的網域（照取回的順序，不重複）與 Worker 取的網站名稱。 */
function unratedOf(rec: AddedRecord, ratings: ReadonlyMap<string, WebRatingRow>): { domain: string; site_name: string | null }[] {
  const out = new Map<string, string | null>();
  for (const d of rec.docs) {
    if (d.kind !== 'web' || !d.domain) continue;
    const r = rateDomain(d.domain, ratings);
    if (r.rating !== 'UNRATED') continue;
    if (!out.has(r.domain) || (!out.get(r.domain) && d.site)) out.set(r.domain, d.site ?? null);
  }
  return [...out].map(([domain, site_name]) => ({ domain, site_name }));
}

/** 寫回 added_docs（只在沒有被別的請求改過、結果還沒送回時）；寫不進去回 false。 */
async function saveAdded(db: D1Database, runId: string, rec: AddedRecord, prevRaw: string | null): Promise<boolean> {
  const saved = await db.prepare("UPDATE ai_runs SET added_docs = ? WHERE run_id = ? AND status = 'PENDING' AND added_docs IS ?").bind(JSON.stringify(rec), runId, prevRaw).run();
  return (saved.meta.changes ?? 0) > 0;
}

/**
 * GET /ai/task/<編號>/unrated：這次取回的文件裡還沒評級的網域 → { unrated: [{ domain, site_name }] }。
 *   只給網域與 Worker 取的網站名稱（§1.1 第 3 點：不給網頁內文、標題、分析師的理由）。給過的記在 added_docs.unrated，POST /ratings 只收這些。
 *   哪些任務可以用、什麼時候可以用和取文件的端點相同（openDocTask）。
 */
export async function handleTaskUnrated(env: Env, id: string, now: Date): Promise<Response> {
  const open = await openDocTask(env, id, now);
  if (open instanceof Response) return open;
  const { run } = open;
  const rec = parseAdded(run.added_docs);
  const list = unratedOf(rec, await loadRatings(env.DB));
  const given = [...new Set([...(rec.unrated ?? []), ...list.map((x) => x.domain)])];
  if (given.length !== (rec.unrated ?? []).length && !(await saveAdded(env.DB, run.run_id, { ...rec, unrated: given }, run.added_docs ?? null))) return json({ error: 'conflict', why: '同時有另一個請求，或結果已經送回；請重試一次' }, 409);
  return json({ unrated: list });
}

/** 來源評級的角色名稱（prompt 的 ai/prompts/source_rating.md 寫同樣的字；程式不檢查它，只用在格式提示）。 */
export const RATING_ROLE = '來源評級';
/** /ratings 拒絕的原因（source_rating.md 列同樣的值，T69 的測試比對）。 */
export const RATING_REFUSES = ['NOT_GIVEN', 'SEED', 'EXCLUDED', 'BAD_TIER', 'BAD_REASON', 'ALREADY_RATED', 'LIMIT', 'ERROR'] as const;
export type RatingRefuse = (typeof RATING_REFUSES)[number];

/**
 * POST /ai/task/<編號>/ratings：{ role: "來源評級", ratings: [{ domain, tier, reason }] } → { saved: [{ domain, tier }], refused: [{ domain, reason, detail }] }。
 *   檢查（§1.4）：網域要是這次 /unrated 給過的（NOT_GIVEN）；種子（SEED）與排除列表（EXCLUDED）的不收；一次最多 12 個（之後的 LIMIT）；
 *   tier 只能是 PRIMARY／NAMED／MEDIA／LEAD／EXCLUDE（BAD_TIER）；reason 一句、100 字以內（BAD_REASON）；已經評過的不覆寫（ALREADY_RATED）。
 *   收下的寫進 web_source_ratings（之後所有股票、所有執行共用）。哪些任務可以用、什麼時候可以用和取文件的端點相同。
 */
export async function handleTaskRatings(env: Env, id: string, bodyText: string, now: Date): Promise<Response> {
  const open = await openDocTask(env, id, now);
  if (open instanceof Response) return open;
  const { run } = open;
  const body = bodyObject(bodyText, `{ "role": "${RATING_ROLE}", "ratings": [...] }`);
  if (body instanceof Response) return body;
  if (!Array.isArray(body.ratings)) return json({ error: 'bad_request', why: 'ratings 要是陣列' }, 400);
  const rec = parseAdded(run.added_docs);
  const given = new Set(rec.unrated ?? []);
  const sites = new Map(unratedOf(rec, new Map()).map((x) => [x.domain, x.site_name]));
  const saved: { domain: string; tier: AiTier }[] = [];
  const refused: { domain: string | null; reason: RatingRefuse; detail: string }[] = [];
  for (const [k, raw] of body.ratings.entries()) {
    const o = (raw ?? {}) as Record<string, unknown>;
    const rawDomain = typeof o.domain === 'string' ? o.domain.trim().slice(0, 200) : '';
    const domain = rawDomain ? webDomainOf(rawDomain.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/[/?#].*$/, '')) : null;
    const no = (reason: RatingRefuse, detail: string) => void refused.push({ domain: domain || rawDomain || null, reason, detail });
    if (k >= RATINGS_PER_CALL) {
      no('LIMIT', `一次最多 ${RATINGS_PER_CALL} 個`);
      continue;
    }
    if (!domain) {
      no('ERROR', '每一項要有 domain');
      continue;
    }
    if (isExcluded(domain)) {
      no('EXCLUDED', '排除列表裡的網站評不上去');
      continue;
    }
    const seed = seedOf(domain);
    if (seed) {
      no('SEED', `種子（${seed.label}）的級別由人定，AI 不能改`);
      continue;
    }
    if (!given.has(domain)) {
      no('NOT_GIVEN', '不是這次 /unrated 給過的網域');
      continue;
    }
    const tier = typeof o.tier === 'string' ? (o.tier.trim().toUpperCase() as AiTier) : null;
    if (!tier || !AI_TIERS.includes(tier)) {
      no('BAD_TIER', `tier 要是 ${AI_TIERS.join('、')} 其中之一`);
      continue;
    }
    const reason = typeof o.reason === 'string' ? o.reason.replace(/\s+/g, ' ').trim() : '';
    if (!reason || [...reason].length > RATING_REASON_MAX) {
      no('BAD_REASON', `reason 要寫一句，${RATING_REASON_MAX} 字以內`);
      continue;
    }
    if (!(await insertRating(env.DB, { domain, tier, siteName: sites.get(domain) ?? null, reason, runId: run.run_id }, now))) {
      no('ALREADY_RATED', '這個網域已經評過（不會重評；覺得不對請主持者改種子）');
      continue;
    }
    saved.push({ domain, tier });
  }
  return json({ saved, refused });
}
