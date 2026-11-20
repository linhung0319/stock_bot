// T52：每檔的網頁證據來源、證據包的目錄、取文件的端點（web_evidence_design §1.2、§1.3、§1.5）。
//
//   每檔的來源（OwnMeta.webSources）：同業 { name, edgar?, yahoo? } 最多 4 家、這檔專用的一手網域最多 6 個。
//     使用者在編輯論點頁填（POST /api/ops/own-thesis 的 webSources），存檔前程式先試抓一次（抓不到的仍存，寫「目前抓不到」，G24）。
//   目錄（facts 的 M 開頭，§1.2）：只有標題，不帶全文，證據包不因同業與網頁變大。
//     S1 同業在 EDGAR 的 8-K（上次有結論的審查之後，最新的 2.02 排最前面，每家最多 3 份）；
//     S2 這檔與同業 Yahoo 代號的 RSS 裡，連結在清單內（共用清單或這檔的網域）的標題。最多 20 項，S1 在前、新的在前。
//     只有系統預設前提的股票沒有目錄，也不能取文件。
//   取文件（POST /ai/task/<編號>/docs，§1.5）：分析師（審查、減半檢視）或研究員（草稿）讀完證據包後，送目錄編號或網址；
//     Worker 檢查清單、當場抓（src/data/webDoc.ts）、存快照、記進這次執行的 added_docs、把原文回給它。
//     表決時 check.ts 比對的原文＝證據包的文件＋取回的文件（src/ai/added.ts 的 withAdded；check.ts 本身不改）。
import { DOCS_MAX, DOCS_MAX_CALLS, DOCS_MAX_CHARS, DOCS_PER_CALL, DOC_FNS, FILING_GIVE, REFUSED_KEEP, WEB_GIVE, addedHash, parseAdded, type AddedDoc, type AddedRecord, type DocCtx, type MenuEntry, type RefuseReason } from '../ai/added';
import type { EvidencePack } from '../ai/check';
import { NEWS_SOURCES, fetchFilingDoc, tryHeadlineSource, type Headline } from '../data/edgar';
import { fetchEdgarSubmissions, type Filing } from '../data/sources';
import { errText } from '../data/util';
import { markWebDocUsed, normalizeWebUrl, obtainWebDoc, safeWebUrl, webDocId } from '../data/webDoc';
import { TIER_TEXT, WEB_EXCLUDED, WEB_SOURCES, hostMatches, listedWebSources, matchWebSource, type WebTier } from '../data/webSources';
import type { OwnMeta, OwnWebSources, WebPeer, WebSourceCheck } from '../engine';
import { TASK_TIMEOUT_MS, getTask } from './aiTasks';
import { json, type Env, type Fetcher } from './env';
import { cikFor } from './filings';
import { loadAccount } from './ledgerStore';
import { afterLastReview, fileKind, type ThesisFile } from './thesis';

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

/** 試抓的每一項（順序：同業的 EDGAR、Yahoo，再來是網域）。 */
export function webSourceKeys(ws: OwnWebSources): string[] {
  return [...ws.peers.flatMap((p) => [...(p.edgar ? [`edgar:${p.edgar}`] : []), ...(p.yahoo ? [`yahoo:${p.yahoo}`] : [])]), ...ws.domains.map((d) => `domain:${d}`)];
}

const PROBE_HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' };
const YAHOO = NEWS_SOURCES.find((s) => s.key === 'yahoo-rss')!;

async function probeOne(env: Env, fetcher: Fetcher, key: string): Promise<WebSourceCheck> {
  const [kind, v] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
  try {
    if (kind === 'edgar') {
      if (!env.EDGAR_USER_AGENT) return { key, ok: null, why: '沒有設定 EDGAR 的 User-Agent，沒有試' };
      const cik = await cikFor(env, fetcher, v);
      return cik ? { key, ok: true, why: `EDGAR 找得到（CIK ${cik}）` } : { key, ok: false, why: 'EDGAR 找不到這個代號（不在美國申報的公司多半沒有，可以只填 Yahoo 代號）' };
    }
    if (kind === 'yahoo') {
      const r = await tryHeadlineSource(fetcher, YAHOO, v);
      if (!r.ok) return { key, ok: false, why: `目前抓不到（${r.error}）` };
      return r.items.length ? { key, ok: true, why: `Yahoo RSS 抓得到（${r.items.length} 則標題）` } : { key, ok: false, why: 'Yahoo RSS 沒有任何標題（代號可能打錯）' };
    }
    const res = await fetcher(`https://${v}/`, { headers: PROBE_HEADERS, signal: AbortSignal.timeout(10_000) });
    await res.body?.cancel().catch(() => undefined);
    return res.status < 400 ? { key, ok: true, why: `首頁抓得到（HTTP ${res.status}）；文章頁要實際取的時候才知道` } : { key, ok: false, why: `目前抓不到（HTTP ${res.status}）` };
  } catch (e) {
    return { key, ok: false, why: `目前抓不到（${errText(e).slice(0, 120)}）` };
  }
}

/** 試抓每一項（存檔前、編輯論點頁的「試抓」）：抓不到的只標出來，不擋存檔。 */
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

/** RSS 標題裡連結在清單內的（S2）：決策日以前、不早於 notBefore；同一個網址只留一則，新的在前。 */
export function listedHeadlines(items: Headline[], domains: readonly string[], asOf: string, notBefore: string): MenuEntry[] {
  const seen = new Set<string>();
  const out: (MenuEntry & { at: string })[] = [];
  for (const h of items) {
    const u = safeWebUrl(h.link);
    if (!u || h.date > asOf || h.date < notBefore) continue;
    const m = matchWebSource(u, domains);
    if ('miss' in m) continue;
    const url = normalizeWebUrl(u);
    if (seen.has(url)) continue;
    seen.add(url);
    const title = h.title.replace(/\s+/g, ' ').trim().slice(0, 160);
    out.push({ id: '', kind: 'web', text: `${m.label}｜${TIER_TEXT[m.tier]}｜${h.date}｜${title}`, url, title, published: h.date, at: h.at });
  }
  return out.sort((a, b) => b.at.localeCompare(a.at)).map(({ at: _at, ...e }) => e);
}

export interface MenuInput {
  ticker: string;
  tf: ThesisFile;
  meta: Pick<OwnMeta, 'webSources' | 'premises'>;
  asOf: string;
  /** 這檔自己的 RSS（審查的證據已經抓過，不重抓）；沒有就不列這檔的 RSS 連結。 */
  headlines?: Headline[] | null;
}

/**
 * 審查的目錄與「可以取什麼」（ai_runs.doc_ctx）。只有系統預設前提 → 沒有目錄、off（不能取文件）。
 * 抓不到的同業只記在 notes（組證據包時的紀錄），不影響審查。
 */
export async function buildDocMenu(env: Env, fetcher: Fetcher, inp: MenuInput): Promise<{ facts: Fact[]; ctx: DocCtx; notes: string[]; sources: { facts: Fact[]; domains: string[] } }> {
  const { tf, asOf } = inp;
  const notBefore = tf.lastReview ? minusDays(tf.lastReview.asOf, TOO_OLD_DAYS) : minusDays(asOf, NO_REVIEW_WEB_DAYS);
  const ws = inp.meta.webSources ?? null;
  const domains = ws?.domains ?? [];
  if (fileKind(inp.meta) === 'DEFAULT_ONLY') return { facts: [], ctx: { menu: [], notBefore, domains: [], fileId: tf.fileId, off: '只有系統預設前提：不用網頁證據' }, notes: [], sources: { facts: [], domains: [] } };
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
  // S2：這檔與同業的 RSS 裡清單內的連結
  const items: Headline[] = [...(inp.headlines ?? [])];
  for (const p of (ws?.peers ?? []).slice(0, PEERS_MAX)) {
    if (!p.yahoo) continue;
    const r = await tryHeadlineSource(fetcher, YAHOO, p.yahoo);
    if (r.ok) items.push(...r.items);
    else notes.push(`目錄：同業 ${p.name}（${p.yahoo}）的 RSS 抓不到：${r.error}`);
  }
  const s2 = listedHeadlines(items, domains, asOf, notBefore);
  const all = [...s1, ...s2];
  const menu = all.slice(0, MENU_MAX).map((e, k) => ({ ...e, id: `M${k + 1}` }));
  const facts: Fact[] = menu.map((e, k) => ({ id: e.id, label: '可以取的文件', value: e.text, ...(k === 0 ? { note: '目錄只有標題；要讀全文，向 Worker 的取文件端點送這個編號' } : {}) }));
  if (all.length > MENU_MAX) facts.push({ id: 'M+', label: '可以取的文件', value: `另有 ${all.length - MENU_MAX} 項沒有列出` });
  // sources（T53）：清單內的網頁來源（facts 的 S 開頭）和目錄分開回傳，呼叫的地方接在目錄後面
  return { facts, ctx: { menu, notBefore, domains, fileId: tf.fileId }, notes, sources: sourceFacts(domains) };
}

/**
 * 可以當證據的網頁來源（facts 的 S 開頭，T53；§1.5 的分析師步驟「優先挑證據包裡列出的清單內網域」、§1.6 條件指名來源時只能指名這些）：
 * 共用清單＋這檔自己的一手網域，一行一個（網域、名稱、級別、只收哪些路徑）。domains 是同一份的網域清單（記在 rule.detail.webDomains）。
 * 只有系統預設前提的股票不用網頁證據：呼叫的地方不要放。
 */
export function sourceFacts(extraDomains: readonly string[]): { facts: Fact[]; domains: string[] } {
  const list = listedWebSources(extraDomains);
  const facts: Fact[] = list.map((s, k) => ({
    id: `S${k + 1}`,
    label: '清單內的網頁來源',
    value: `${s.domain}｜${s.label}｜${TIER_TEXT[s.tier]}${s.paths ? `｜只收 ${s.paths.join('、')}` : ''}`,
    ...(k === 0 ? { note: '只有這些網域的網頁取得到全文；其他網站的標題只能當線索' } : {}),
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

/** 沒有記下 doc_ctx 的執行（減半檢視等，T54、T55 之前）：照現在的帳戶算這檔的網域與論點檔，發布日下限用決策日前 365 天。 */
async function fallbackCtx(db: D1Database, ticker: string | null, asOf: string): Promise<DocCtx> {
  const meta = ticker ? (await loadAccount(db))?.acct.own[ticker] : undefined;
  const notBefore = minusDays(asOf, NO_REVIEW_WEB_DAYS);
  if (!meta) return { menu: [], notBefore, domains: [], fileId: null, off: '已經不是自選股' };
  if (fileKind(meta) === 'DEFAULT_ONLY') return { menu: [], notBefore, domains: [], fileId: meta.fileId ?? null, off: '只有系統預設前提：不用網頁證據' };
  return { menu: [], notBefore, domains: meta.webSources?.domains ?? [], fileId: meta.fileId ?? null };
}

const forOf = (v: unknown) => (typeof v === 'string' && /^[A-Z]{1,2}\d{1,4}$/.test(v.trim()) ? v.trim() : null);
const nf = (n: number) => n.toLocaleString('en-US');

export interface DocsReply {
  docs: { id: string; source_id: string; kind: 'web' | 'filing'; tier: WebTier | null; date: string; title: string; url: string | null; text: string; truncated: boolean }[];
  refused: { url?: string; menu?: string; reason: RefuseReason; detail: string | null }[];
  left: { docs: number; chars: number; calls: number };
}

/**
 * POST /ai/task/<編號>/docs：{ want: [{ menu: "M1" } | { url, title? }, for?, why?], role? }。
 *   別的功能 → 403；還沒取證據包 → 409；送回結果之後、逾時 → 410。
 *   每次執行最多取回 8 份、合計 60,000 字、呼叫 6 次，超過的回 LIMIT（記在執行紀錄）；網頁每份開頭 12,000 字、同業申報 15,000 字。
 *   每一筆網頁（含被拒絕的）寫進 web_docs；取回的記進 ai_runs.added_docs、web_docs.used_by。
 */
export async function handleTaskDocs(env: Env, fetcher: Fetcher, id: string, bodyText: string, now: Date): Promise<Response> {
  const db = env.DB;
  const t = await getTask(db, id);
  if (!t) return json({ error: 'not_found' }, 404);
  const run = t.kind === 'RUN' ? await db.prepare('SELECT run_id, fn, ticker, as_of, status, doc_ctx, added_docs FROM ai_runs WHERE task_id = ?').bind(id).first<RunRow>() : null;
  if (!run || !(DOC_FNS as readonly string[]).includes(run.fn)) return json({ error: 'not_allowed', why: '這個任務不能取文件（只有定期審查、減半檢視、論點草稿可以）' }, 403);
  if (!['PENDING', 'FETCHED'].includes(t.status) || run.status !== 'PENDING' || now.getTime() - Date.parse(t.created_at) > TASK_TIMEOUT_MS) return json({ error: 'task_closed', status: t.status }, 410);
  if (t.status === 'PENDING') return json({ error: 'evidence_not_fetched', why: '先取證據包，讀完再取文件' }, 409);
  const ctx = run.doc_ctx ? (JSON.parse(run.doc_ctx) as DocCtx) : await fallbackCtx(db, run.ticker, run.as_of);
  if (ctx.off) return json({ error: 'not_allowed', why: ctx.off }, 403);
  if (new TextEncoder().encode(bodyText).length > 16_384) return json({ error: 'too_large' }, 413);
  let body: Record<string, unknown>;
  try {
    const p = JSON.parse(bodyText) as unknown;
    if (typeof p !== 'object' || p === null || Array.isArray(p)) throw new Error();
    body = p as Record<string, unknown>;
  } catch {
    return json({ error: 'bad_request', why: '要是 JSON 物件：{ "want": [...] }' }, 400);
  }
  if (!Array.isArray(body.want)) return json({ error: 'bad_request', why: 'want 要是陣列' }, 400);
  const role = typeof body.role === 'string' ? body.role.slice(0, 40) : null;
  const rec: AddedRecord = parseAdded(run.added_docs);
  const prevRaw = run.added_docs ?? null;
  rec.calls += 1;
  const at = now.toISOString();
  const reply: DocsReply = { docs: [], refused: [], left: { docs: 0, chars: 0, calls: 0 } };
  const refuse = (w: { url: string | null; menu: string | null; for: string | null; why: string | null }, reason: RefuseReason, detail: string | null) => {
    reply.refused.push({ ...(w.url ? { url: w.url } : {}), ...(w.menu ? { menu: w.menu } : {}), reason, detail });
    rec.refusedTotal += 1;
    if (rec.refused.length < REFUSED_KEEP) rec.refused.push({ url: w.url, menu: w.menu, reason, detail, for: w.for, why: w.why, at });
  };
  const give = (d: Omit<AddedDoc, 'id' | 'truncated' | 'text'> & { text: string; truncated: boolean; cap: number }) => {
    const left = DOCS_MAX_CHARS - rec.chars;
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

  for (const [k, raw] of body.want.entries()) {
    const o = (raw ?? {}) as Record<string, unknown>;
    const w = { url: typeof o.url === 'string' ? o.url.trim().slice(0, 2000) : null, menu: typeof o.menu === 'string' ? o.menu.trim().slice(0, 10) : null, for: forOf(o.for), why: typeof o.why === 'string' ? o.why.trim().slice(0, 300) || null : null };
    if (!w.url && !w.menu) {
      refuse(w, 'ERROR', '每一項要有 menu（目錄編號）或 url');
      continue;
    }
    if (rec.calls > DOCS_MAX_CALLS) {
      refuse(w, 'LIMIT', `每次執行最多呼叫 ${DOCS_MAX_CALLS} 次`);
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
    if (rec.docs.length >= DOCS_MAX) {
      refuse(w, 'LIMIT', `每次執行最多取回 ${DOCS_MAX} 份`);
      continue;
    }
    if (rec.chars >= DOCS_MAX_CHARS) {
      refuse(w, 'LIMIT', `每次執行合計最多 ${nf(DOCS_MAX_CHARS)} 字，已經用完`);
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
      { url: url!, ticker: run.ticker ?? '', fileId: ctx.fileId, via, ref: run.run_id, premiseId: w.for?.startsWith('P') ? w.for : null, condId: w.for && !w.for.startsWith('P') ? w.for : null, session: run.as_of },
      now,
      { extraDomains: ctx.domains, title: entry?.title ?? (typeof o.title === 'string' ? o.title.slice(0, 300) : null), rssPublished: entry?.published ?? null, siteCount, decisionDate: run.as_of, notBefore: ctx.notBefore },
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
    // 之前抓過的快照：清單與日期照這次的規則再看一次
    const hit = matchWebSource(new URL(row.url), ctx.domains);
    if ('miss' in hit) {
      refuse(w, 'NOT_LISTED', hit.miss);
      continue;
    }
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
    const doc = give({ source_id: row.id, kind: 'web', tier: hit.tier, date: row.published, title: `〔網頁｜${TIER_TEXT[hit.tier]}｜${hit.label}〕${row.title ?? row.url}（發布 ${row.published}，${row.fetched_at.slice(0, 10)} 抓）`, url: row.final_url ?? row.url, text: row.text, truncated: !!row.truncated, cap: WEB_GIVE, fetched_at: row.fetched_at, via, menu: w.menu, for: w.for, why: w.why, role, at, row_id: row.row_id, domain: hit.domain, label: hit.label });
    await markWebDocUsed(db, row.row_id, run.run_id);
    reply.docs.push(docReply(doc));
  }
  rec.sites = Object.fromEntries(siteCount);
  const saved = await db
    .prepare("UPDATE ai_runs SET added_docs = ?, added_hash = ? WHERE run_id = ? AND status = 'PENDING' AND added_docs IS ?")
    .bind(JSON.stringify(rec), await addedHash(rec.docs), run.run_id, prevRaw)
    .run();
  if (!saved.meta.changes) return json({ error: 'conflict', why: '同時有另一個取文件的請求，或結果已經送回；請重試一次' }, 409);
  reply.left = { docs: Math.max(0, DOCS_MAX - rec.docs.length), chars: Math.max(0, DOCS_MAX_CHARS - rec.chars), calls: Math.max(0, DOCS_MAX_CALLS - rec.calls) };
  return json(reply);
}

const docReply = (d: AddedDoc): DocsReply['docs'][number] => ({ id: d.id, source_id: d.source_id, kind: d.kind, tier: d.tier, date: d.date, title: d.title, url: d.url, text: d.text, truncated: d.truncated });
