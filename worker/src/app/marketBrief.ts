// T64：市場摘要（MARKET_BRIEF）的排程端（設計 docs/design/composite_layer_design_2026-11-21.md §1.2～§1.5；純函式在 src/ai/marketBrief.ts）。
//
//   每日第一次流程開執行的那一段（aiStep，放在減半檢視與提前審查之後）與 01:30 的 finalStarts 各呼叫一次 startMarketBrief：
//     1. 觸發（規則判斷）：大盤單日、持股的產業 ETF 單日、21 日累積、當天有減半檢視或提前審查 → 記進 market_triggers、歸到事件。
//        流程漏跑的日子下一次會往回補看（最多 10 個交易日），所以連續大跌的那幾天會併進同一個事件。
//     2. 開不開（planOpen）：10 個交易日內最多 1 份暫定稿；事件最後一次觸發之後第 10 個交易日寫定稿；一個訊號日最多開一次。
//        暫定稿、定稿各最多試 2 次（01:30 或隔天再試）。平靜的日子不跑，不設每月固定的一次。
//   證據包（§1.3、§1.4）：程式算的數字（K）、持股屬於哪個族群（G，只有代號）、價格表（核心 ETF、各產業 ETF、漲跌最大的幾檔持股）、
//     總經儀表板（當場重算一份，不存：macro_snapshots 是崩盤規則檢視照月份讀的，這裡不動它）、大盤與各族群的新聞標題、
//     目錄（標題裡連結在清單內的文章）與清單內的網頁來源。研究員可以照現有的步驟向 Worker 取文件（src/app/webEvidence.ts）。
//   結果：送回時當場結算（settleBriefs），逾時的在每日流程套用時結算（applyMarketBrief）→ market_briefs 的 READY 或 FAILED。
//     只說明：不動帳戶、不發通知。
//   分給個股、顯示（T65，§1.6～§1.8）：briefNote（個股證據包的 brief:<訊號日>）、briefLinesFor（LINE 那一行）、homeBrief（首頁那一行）；
//     AI 紀錄頁的內容在 src/app/site/aiViews.ts 的 briefRunView。手動開的那一份三者都不用。
import type { DocCtx, MenuEntry } from '../ai/added';
import type { EvidencePack, PackDoc } from '../ai/check';
import { macroQuality, macroUsable } from '../ai/crash';
import { BRIEF, BRIEF_HOME_DAYS, BRIEF_PACK_DAYS, MARKET_BRIEF, TRIGGER_TEXT, aiRunTrigger, briefFirstCause, briefLine, briefNoteDoc, assignTriggers, briefFacts, briefPeriod, briefResult, marketBriefPack, planOpen, priceTriggers, type BriefEvent, type BriefGroup, type BriefOpen, type BriefRowLite, type BriefStage, type BriefTrigger, type BriefTriggerKind, type MarketBrief, type TradingGap } from '../ai/marketBrief';
import { newRunId, priceDoc } from '../ai/pack';
import { addDays, tradingDaysBetween } from '../data/calendar';
import { fetchHeadlineFeed, type Headline } from '../data/edgar';
import { BENCHMARK } from '../data/ingest';
import { buildMarketView } from '../data/marketView';
import { loadRanking, loadSeries } from '../data/store';
import { errText } from '../data/util';
import { ownHeld, type Account, type MarketView } from '../engine';
import type { ApplyCtx, StartCtx } from './aiCtx';
import { getRun, startRun, type AiRun } from './aiRuns';
import { buildSnapshot, loadSnapshot, snapshotDoc, type MacroSnapshot } from './crashAi';
import type { Env, Fetcher } from './env';
import { sectorEtfs, setStateStmt } from './filings';
import { loadAccount, requiredTickers } from './ledgerStore';
import { momHoldings } from './momNotes';
import { newsDocOf, routineReady } from './ownAi';
import { MENU_MAX, listedHeadlines, sourceFacts } from './webEvidence';

type Fact = EvidencePack['facts'][number];

/** flow_state：觸發看到哪一個訊號日（下一次從隔天補看）。 */
export const BRIEF_SCANNED_KEY = 'brief:scanned';
/** 存下來的總經儀表板最多可以舊幾個日曆天（當場重算不出來時才用存的）。 */
export const BRIEF_MACRO_MAX_AGE = 45;
/** 價格表最少、最多列幾個交易日；漲跌最大的持股列幾個交易日。 */
const PRICE_DAYS = { min: 30, max: 120, mover: 30 } as const;

export type BriefStatus = 'PENDING' | 'READY' | 'FAILED';

export interface BriefRow {
  id: number;
  event_id: string;
  stage: BriefStage;
  run_id: string;
  session: string;
  period_from: string;
  period_to: string;
  why: string | null;
  manual: number;
  status: BriefStatus;
  payload: string | null;
  error: string | null;
  created_at: string;
  settled_at: string | null;
}

export class BriefError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------- 持股與族群（§1.3）

export interface BriefHolding {
  ticker: string;
  role: 'OWN' | 'MOM';
}

/** 持股：現在有股數的自選，加上動能持股（名單上的與還有股數的）。 */
export function briefHoldings(acct: Pick<Account, 'own' | 'lots' | 'rule'>): BriefHolding[] {
  const own = Object.keys(acct.own)
    .filter((t) => ownHeld(acct, t))
    .sort();
  return [...own.map((ticker) => ({ ticker, role: 'OWN' as const })), ...momHoldings(acct).filter((t) => !own.includes(t)).map((ticker) => ({ ticker, role: 'MOM' as const }))];
}

/**
 * 持股所屬的族群：用現有的產業 ETF 對照（flow_state 的 sector:<代號>，第一次看申報時從 SIC 對出來的），不另外建標籤表。
 * 產業 ETF 在這一天沒有價格的不算一個族群（寫進 notes）。
 */
export async function briefGroups(db: D1Database, acct: Pick<Account, 'own' | 'lots' | 'rule'>, view: MarketView): Promise<{ groups: BriefGroup[]; ungrouped: BriefHolding[]; notes: string[] }> {
  const holdings = briefHoldings(acct);
  const sectors = await sectorEtfs(db, holdings.map((h) => h.ticker));
  const by = new Map<string, BriefHolding[]>();
  const ungrouped: BriefHolding[] = [];
  const notes: string[] = [];
  for (const h of holdings) {
    const etf = sectors[h.ticker];
    const c = etf ? view.close[etf] : undefined;
    if (!etf) ungrouped.push(h);
    else if (!c || !Number.isFinite(c[view.i])) {
      ungrouped.push(h);
      notes.push(`${h.ticker} 的產業 ETF ${etf} 沒有 ${view.date} 的價格，這次不當成一個族群`);
    } else by.set(etf, [...(by.get(etf) ?? []), h]);
  }
  return { groups: [...by.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([etf, members]) => ({ etf, members })), ungrouped, notes };
}

// ---------------------------------------------------------------- 紀錄（market_triggers、market_briefs）

const lite = (r: BriefRow): BriefRowLite => ({ eventId: r.event_id, stage: r.stage, session: r.session, status: r.status });

/** 排程判斷用：不含手動開的（它們不佔頻率上限、不屬於任何事件）。 */
async function scheduledRows(db: D1Database, since: string): Promise<BriefRowLite[]> {
  return (await db.prepare('SELECT * FROM market_briefs WHERE manual = 0 AND session >= ? ORDER BY session, id').bind(since).all<BriefRow>()).results.map(lite);
}

/** 最後一次觸發在 since 之後的事件。 */
async function loadEvents(db: D1Database, since: string): Promise<BriefEvent[]> {
  return (await db.prepare('SELECT event_id AS id, MIN(session) AS first, MAX(session) AS last FROM market_triggers GROUP BY event_id HAVING MAX(session) >= ? ORDER BY MAX(session)').bind(since).all<BriefEvent>()).results;
}

/** 一個事件的每一次觸發（舊到新）。 */
export async function eventTriggers(db: D1Database, eventId: string): Promise<BriefTrigger[]> {
  const rows = (await db.prepare('SELECT session, kind, grp, value, detail FROM market_triggers WHERE event_id = ? ORDER BY session, kind, grp').bind(eventId).all<{ session: string; kind: BriefTriggerKind; grp: string; value: number | null; detail: string | null }>()).results;
  return rows.map((r) => ({ session: r.session, kind: r.kind, group: r.grp || null, value: r.value, text: r.detail ?? `${r.session} ${TRIGGER_TEXT[r.kind] ?? r.kind}` }));
}

/** 這個訊號日開的減半檢視與提前審查（§1.2 第四種觸發）。 */
async function aiRunsOn(db: D1Database, session: string): Promise<string[]> {
  return (await db.prepare("SELECT run_id FROM ai_runs WHERE as_of = ? AND (fn = 'OWN_DROP' OR (fn = 'OWN_REVIEW' AND json_extract(pack, '$.rule.detail.trigger') = 'EARLY')) ORDER BY created_at").bind(session).all<{ run_id: string }>()).results.map((r) => r.run_id);
}

const parseBrief = (raw: string | null): MarketBrief | null => {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as MarketBrief;
  } catch {
    return null;
  }
};

export interface BriefView {
  row: BriefRow;
  /** READY 的才有。 */
  brief: MarketBrief | null;
}

/** 最近的市場摘要（新到舊；含還在跑的與失敗的，T65 的「AI 紀錄」與運作統計用）。 */
export async function loadBriefs(db: D1Database, opt: { limit?: number; status?: BriefStatus } = {}): Promise<BriefView[]> {
  const limit = Math.min(opt.limit ?? 20, 200);
  const rows = opt.status
    ? (await db.prepare('SELECT * FROM market_briefs WHERE status = ? ORDER BY session DESC, id DESC LIMIT ?').bind(opt.status, limit).all<BriefRow>()).results
    : (await db.prepare('SELECT * FROM market_briefs ORDER BY session DESC, id DESC LIMIT ?').bind(limit).all<BriefRow>()).results;
  return rows.map((row) => ({ row, brief: row.status === 'READY' ? parseBrief(row.payload) : null }));
}

/**
 * 最近一份寫好的市場摘要（§1.6：取最近一份、30 個日曆天內；同一個訊號日有定稿用定稿）。asOf 之後寫的不算（不偷看未來）。沒有 → null。
 * T65 分給個股時讀這個：brief.facts、brief.causes（scope = MARKET 的，與 group 等於這檔產業 ETF 的）。
 */
export async function latestBrief(db: D1Database, asOf: string, days = 30, opt: { scheduledOnly?: boolean } = {}): Promise<{ row: BriefRow; brief: MarketBrief } | null> {
  const manual = opt.scheduledOnly ? ' AND manual = 0' : '';
  const rows = (await db.prepare(`SELECT * FROM market_briefs WHERE status = 'READY'${manual} AND session <= ? AND session >= ? ORDER BY session DESC, (stage = 'FINAL') DESC, id DESC LIMIT 5`).bind(asOf, addDays(asOf, -days)).all<BriefRow>()).results;
  for (const row of rows) {
    const brief = parseBrief(row.payload);
    if (brief) return { row, brief };
  }
  return null;
}

// ---------------------------------------------------------------- 分給個股、顯示（T65，§1.6～§1.8）
//   手動開的那一份（POST /admin/ai/brief，M7 量時間用）不分給個股、不上首頁、不進 LINE：它不是事件觸發的，
//   平靜的日子手動開一份也會寫「原因不明」，放在首頁或通知裡會讓人以為市場剛大幅波動。AI 紀錄照樣列（標「手動開的」）。

/**
 * 個股證據包（定期審查、提前審查、減半檢視、草稿）的市場摘要那一份（§1.6）：最近 30 個日曆天內的一份、有定稿用定稿，
 * 只放大盤與這檔產業 ETF 的部分。沒有 → doc 是 null。讀不到不擋那次執行（呼叫的地方照樣開，note 寫進組證據包的紀錄）。
 * 同一次流程開的摘要趕不上同一次流程開的個股執行（證據包開執行時就定了）：那一次讀到的是之前的一份或沒有。
 */
export async function briefNote(db: D1Database, ticker: string, asOf: string): Promise<{ doc: PackDoc | null; note: string | null }> {
  try {
    const got = await latestBrief(db, asOf, BRIEF_PACK_DAYS, { scheduledOnly: true });
    if (!got) return { doc: null, note: null };
    const group = (await sectorEtfs(db, [ticker]))[ticker] ?? null;
    return { doc: briefNoteDoc(got.brief, got.row.session, group), note: `附上 ${got.row.session} 的市場摘要（${got.row.stage === 'FINAL' ? '定稿' : '暫定稿'}${group ? `；大盤與 ${group} 的部分` : '；只有大盤的部分，這檔沒有對到產業 ETF'}）` };
  } catch (e) {
    return { doc: null, note: `市場摘要讀不到，這次沒有附：${errText(e)}` };
  }
}

/** LINE 那一行（§1.8）：每個訊號日寫好的那一份（有定稿用定稿；不含手動開的）→ 那一行的字。通知的日期對到哪一天就加哪一天的。 */
export async function briefLinesFor(db: D1Database, sessions: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const days = [...new Set(sessions)].filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
  if (!days.length) return out;
  const rows = (await db.prepare(`SELECT * FROM market_briefs WHERE status = 'READY' AND manual = 0 AND session IN (${days.map(() => '?').join(',')}) ORDER BY session, (stage = 'FINAL') DESC, id DESC`).bind(...days).all<BriefRow>()).results;
  for (const row of rows) {
    if (out.has(row.session)) continue;
    const b = parseBrief(row.payload);
    if (b) out.set(row.session, briefLine(b));
  }
  return out;
}

/** 首頁那一行（§1.8）。 */
export interface HomeBrief {
  runId: string;
  session: string;
  stage: BriefStage;
  period: { from: string; to: string };
  /** 「報導的說法，信心高」；原因不明是 null。 */
  tag: string | null;
  text: string;
}

/**
 * 首頁：最近 10 個交易日內有寫好的摘要（不含手動開的）時顯示一行與連結（§1.8）。axis：交易日（最後一個是現在的訊號日）。沒有 → null。
 */
export async function homeBrief(db: D1Database, axis: readonly string[]): Promise<HomeBrief | null> {
  const today = axis.at(-1);
  if (!today) return null;
  const from = axis[Math.max(0, axis.length - BRIEF_HOME_DAYS)];
  const got = await latestBrief(db, today, Math.max(0, Math.round((Date.parse(today) - Date.parse(from)) / 86_400_000)), { scheduledOnly: true });
  if (!got || got.row.session < from) return null;
  const f = briefFirstCause(got.brief);
  return { runId: got.row.run_id, session: got.row.session, stage: got.row.stage, period: got.brief.period, tag: f.tag, text: f.text };
}

// ---------------------------------------------------------------- 證據包（§1.3、§1.4）

/** 總經儀表板：當場重算一份（不存）；可用的序列不到 6 個時改用最近存的那一份（45 個日曆天內），都沒有就不放。 */
async function macroFor(env: Env, fetcher: Fetcher, acct: Account, view: MarketView, notes: string[]): Promise<{ snap: MacroSnapshot | null; quality: 'ok' | 'partial' | 'missing' }> {
  let snap: MacroSnapshot | null = null;
  try {
    snap = await buildSnapshot(env.DB, fetcher, acct, view, view.date.slice(0, 7));
  } catch (e) {
    notes.push(`總經儀表板算不出來：${errText(e)}`);
  }
  if (snap && macroQuality(snap.rows) !== 'missing') {
    if (snap.missing.length) notes.push(`FRED 抓不到：${snap.missing.join('、')}`);
    return { snap, quality: macroQuality(snap.rows) };
  }
  const old = await loadSnapshot(env.DB).catch(() => null);
  if (old && old.asOf <= view.date && old.asOf >= addDays(view.date, -BRIEF_MACRO_MAX_AGE) && macroQuality(old.rows) !== 'missing') {
    notes.push(`總經資料這次只抓到 ${snap ? macroUsable(snap.rows) : 0} 個序列，改用 ${old.asOf} 存的儀表板`);
    return { snap: old, quality: 'partial' };
  }
  notes.push('總經資料抓不到，這次的證據包沒有總經儀表板');
  return { snap: null, quality: 'missing' };
}

export interface BriefOpenInput extends BriefOpen {
  manual?: boolean;
}

/**
 * 開一次市場摘要：組證據包、寫一列 market_briefs（PENDING）、開執行。沒觸發成的當場結算成 FAILED。
 * view 要有核心 ETF、持股、持股的產業 ETF 與股票池的價格（每日流程的 AI 段本來就載入了）。
 */
export async function openBrief(env: Env, fetcher: Fetcher, acct: Account, view: MarketView, axis: string[], now: Date, o: BriefOpenInput): Promise<AiRun> {
  const db = env.DB;
  const asOf = view.date;
  const core = acct.cfg.coreTicker;
  const triggers: BriefTrigger[] = o.manual ? [{ session: asOf, kind: 'MANUAL', group: null, value: null, text: `${asOf} 手動開的` }] : await eventTriggers(db, o.eventId);
  const period = briefPeriod(axis, triggers, asOf);
  const { groups, ungrouped, notes } = await briefGroups(db, acct, view);
  const ranking = await loadRanking(db);
  const universe = (ranking?.detail.universe.map((u) => u.ticker) ?? []).filter((t) => !!view.close[t]);
  const { facts: numbers, movers } = briefFacts({ axis, close: view.close, i: view.i, core, groups, ungrouped, universe, period, triggers });

  // 價格表：核心 ETF、各產業 ETF（涵蓋整段期間，至少 30 個交易日）、漲跌最大的幾檔持股
  const span = Math.min(PRICE_DAYS.max, Math.max(PRICE_DAYS.min, view.i - Math.max(0, axis.indexOf(period.from)) + 6));
  const docs: PackDoc[] = [priceDoc(view, axis, core, span), ...groups.map((g) => priceDoc(view, axis, g.etf, span)), ...movers.map((t) => priceDoc(view, axis, t, PRICE_DAYS.mover))].filter((d): d is PackDoc => !!d);

  // 總經儀表板
  const macro = await macroFor(env, fetcher, acct, view, notes);
  if (macro.snap) docs.push(snapshotDoc(macro.snap));

  // 新聞標題：大盤（SPY）與各族群（產業 ETF 自己的代號）；只有標題，只能當線索
  const since = addDays(period.from, -3);
  const items: Headline[] = [];
  let newsDocs = 0;
  for (const t of [BENCHMARK, ...groups.map((g) => g.etf)]) {
    try {
      const feed = await fetchHeadlineFeed(fetcher, t);
      items.push(...feed.items);
      const doc = newsDocOf(feed, t, asOf, since);
      if (doc) {
        const rest = doc.title.slice(doc.title.indexOf('（') + 1);
        docs.push({ ...doc, title: t === BENCHMARK ? `大盤相關的新聞標題（${t}，${rest}` : `${t} 族群相關的新聞標題（${rest}` });
        newsDocs++;
      }
    } catch (e) {
      notes.push(`${t} 的新聞標題抓不到：${errText(e)}`);
    }
  }

  // 目錄（標題裡連結在清單內的文章）與清單內的網頁來源（共用清單；市場摘要沒有「這檔自己的網域」）
  const notBefore = addDays(period.from, -BRIEF.webBeforeDays);
  const listed = listedHeadlines(items, [], asOf, notBefore);
  const menu: MenuEntry[] = listed.slice(0, MENU_MAX).map((e, k) => ({ ...e, id: `M${k + 1}` }));
  const menuFacts: Fact[] = menu.map((e, k) => ({ id: e.id, label: '可以取的文件', value: e.text, ...(k === 0 ? { note: '目錄只有標題；要讀全文，向 Worker 的取文件端點送這個編號' } : {}) }));
  if (listed.length > MENU_MAX) menuFacts.push({ id: 'M+', label: '可以取的文件', value: `另有 ${listed.length - MENU_MAX} 項沒有列出` });
  const sources = sourceFacts([]);
  const ctx: DocCtx = { menu, notBefore, domains: [], fileId: null };

  // 定稿：附這個事件最近一份寫好的暫定稿（背景）
  let provisional: MarketBrief | null = null;
  if (o.stage === 'FINAL') {
    const row = await db.prepare("SELECT * FROM market_briefs WHERE event_id = ? AND stage = 'PROVISIONAL' AND status = 'READY' ORDER BY session DESC, id DESC LIMIT 1").bind(o.eventId).first<BriefRow>();
    provisional = parseBrief(row?.payload ?? null);
  }

  const runId = newRunId(asOf, MARKET_BRIEF);
  const { pack, notes: packNotes } = marketBriefPack({
    runId,
    asOf,
    stage: o.stage,
    eventId: o.eventId,
    period,
    core,
    groups,
    triggers,
    facts: [...numbers, ...menuFacts, ...sources.facts],
    docs,
    dataQuality: { prices: 'ok', macro: macro.quality, news: newsDocs ? 'partial' : 'missing' },
    provisional,
    webDomains: sources.domains,
    ...(o.manual ? { manual: true } : {}),
    now,
  });
  const at = now.toISOString();
  await db.prepare("INSERT INTO market_briefs (event_id, stage, run_id, session, period_from, period_to, why, manual, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)").bind(o.eventId, o.stage, runId, asOf, period.from, period.to, o.why, o.manual ? 1 : 0, at).run();
  let run: AiRun;
  try {
    run = await startRun(env, fetcher, pack, now, [...notes, ...packNotes], ctx);
  } catch (e) {
    // 沒開成：還沒建 ai_runs 的，佔的那一列拿掉（不算一次）；已經建了的，等時限到了照規則結束、結算成 FAILED
    const made = await db.prepare('SELECT 1 AS x FROM ai_runs WHERE run_id = ?').bind(runId).first();
    if (!made) await db.prepare("DELETE FROM market_briefs WHERE run_id = ? AND status = 'PENDING'").bind(runId).run();
    throw e;
  }
  // 沒觸發成（startRun 已經存了「照規則」的結論）→ 當場結算成 FAILED
  if (run.status === 'DONE') await settleBrief(db, run, now);
  return run;
}

// ---------------------------------------------------------------- 排程（§1.2）

/**
 * 每日流程的市場摘要：記下觸發、決定開不開。opt.final：01:30 的那一次（只多看當天才開的提前審查、重試當天沒有成功的那一份）。
 * 出錯只寫進流程紀錄，不擋其他段（呼叫的地方包在 guard 裡）。
 */
export async function startMarketBrief(sc: StartCtx, opt: { final?: boolean } = {}): Promise<void> {
  const { env, fetcher, acct, view, axis, session, ov, now, res } = sc;
  const db = env.DB;
  const core = acct.cfg.coreTicker;
  const at = now.toISOString();
  const gap: TradingGap = (a, b) => (a >= b ? 0 : tradingDaysBetween(a, b, ov).length - 1);
  const since = addDays(session, -120);
  const { groups } = await briefGroups(db, acct, view);
  const etfs = groups.map((g) => g.etf);

  // 1. 觸發：上次看到的隔天起到今天（流程漏跑的補看，最多 10 個交易日）；同一天再跑一次只會補上新的（INSERT OR IGNORE）
  const scanned = (await db.prepare('SELECT value FROM flow_state WHERE key = ?').bind(BRIEF_SCANNED_KEY).first<{ value: string }>())?.value ?? null;
  const next = scanned && scanned < session ? axis.findIndex((d) => d > scanned) : view.i;
  const first = Math.max(next < 0 ? view.i : next, view.i - BRIEF.scanBackDays + 1, 1);
  for (let k = first; k <= view.i; k++) {
    const day = axis[k];
    const found = priceTriggers(axis, view.close, k, core, etfs);
    if (k === view.i) {
      const runs = await aiRunsOn(db, session);
      if (runs.length) found.push(aiRunTrigger(session, runs));
    }
    if (!found.length) continue;
    const latest = (await loadEvents(db, since)).filter((e) => e.last <= day).at(-1) ?? null;
    const got = assignTriggers(day, found, latest, await scheduledRows(db, since), gap);
    if (!got) continue;
    for (const t of got.triggers) {
      const ins = await db.prepare('INSERT OR IGNORE INTO market_triggers (session, kind, grp, event_id, value, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(t.session, t.kind, t.group ?? '', got.eventId, t.value, t.text, at).run();
      if (ins.meta.changes) res.log.push(`市場摘要的觸發（${TRIGGER_TEXT[t.kind]}）：${t.text}；事件 ${got.eventId}`);
    }
  }
  await setStateStmt(db, BRIEF_SCANNED_KEY, session, at).run();

  // 2. 開不開
  const plan = planOpen(session, await loadEvents(db, since), await scheduledRows(db, since), gap);
  res.log.push(...plan.log);
  if (!plan.open) return;
  try {
    const run = await openBrief(env, fetcher, acct, view, axis, now, plan.open);
    res.started.push(run.runId);
    res.log.push(`市場摘要：開${plan.open.stage === 'FINAL' ? '定稿' : '暫定稿'} ${run.runId}（${plan.open.why}${opt.final ? '；01:30' : ''}）`);
  } catch (e) {
    res.log.push(`市場摘要沒有開成：${errText(e)}`);
  }
}

/**
 * 手動開一次暫定稿（POST /admin/ai/brief；設計 §5 的 M7：量一次要多久、用多少額度）。期間是最近 21 個交易日。
 * 不記觸發、不屬於任何事件、不佔頻率上限（manual = 1）；讀的時候和排程開的一樣是一份摘要。
 */
export async function manualBrief(env: Env, fetcher: Fetcher, now: Date): Promise<AiRun> {
  if (!routineReady(env)) throw new BriefError(400, 'AI 層的雲端排程還沒設定（SETUP.md 的 T5），沒辦法開市場摘要');
  const loaded = await loadAccount(env.DB);
  if (!loaded) throw new BriefError(400, '還沒有帳戶');
  const acct = loaded.acct;
  const holdings = briefHoldings(acct).map((h) => h.ticker);
  const ranking = await loadRanking(env.DB);
  const series = await loadSeries(env.DB, [...new Set([...requiredTickers(acct), ...holdings, ...Object.values(await sectorEtfs(env.DB, holdings)), ...(ranking?.detail.universe.map((u) => u.ticker) ?? [])])]);
  const session = series.get(acct.cfg.coreTicker)?.d.at(-1);
  if (!session) throw new BriefError(409, '還沒有價格資料');
  const { view, axis } = buildMarketView(series, session, acct.cfg.coreTicker);
  return openBrief(env, fetcher, acct, view, axis, now, { eventId: `manual-${session}`, stage: 'PROVISIONAL', why: '手動開的', manual: true });
}

// ---------------------------------------------------------------- 結算

/**
 * 結算一次市場摘要（ai_runs 已經是 DONE）：檢查過的摘要 → READY（存固定形狀的 payload）；其他 → FAILED 與原因。
 * 只動 PENDING 的列（同一次結果結算兩次不會改變什麼）。回傳結算後的狀態；還沒有結論或已經結算過是 null。
 */
export async function settleBrief(db: D1Database, run: AiRun, now: Date): Promise<{ status: 'READY' | 'FAILED'; why: string | null } | null> {
  if (run.fn !== MARKET_BRIEF || run.status !== 'DONE') return null;
  const r = briefResult(run.outcome, run.pack);
  if (!r) return null;
  const at = now.toISOString();
  if (r.ok) {
    const done = await db.prepare("UPDATE market_briefs SET status = 'READY', payload = ?, error = NULL, settled_at = ? WHERE run_id = ? AND status = 'PENDING'").bind(JSON.stringify(r.brief), at, run.runId).run();
    return done.meta.changes ? { status: 'READY', why: null } : null;
  }
  const done = await db.prepare("UPDATE market_briefs SET status = 'FAILED', error = ?, settled_at = ? WHERE run_id = ? AND status = 'PENDING'").bind(r.why.slice(0, 2000), at, run.runId).run();
  return done.meta.changes ? { status: 'FAILED', why: r.why } : null;
}

/** 結算所有還在 PENDING、執行已經結束的市場摘要（結果送回之後當場呼叫）。 */
export async function settleBriefs(db: D1Database, now: Date): Promise<number> {
  const rows = (await db.prepare("SELECT b.run_id FROM market_briefs b JOIN ai_runs r ON r.run_id = b.run_id WHERE b.status = 'PENDING' AND r.status = 'DONE'").all<{ run_id: string }>()).results;
  let n = 0;
  for (const { run_id } of rows) {
    const run = await getRun(db, run_id);
    if (run && (await settleBrief(db, run, now))) n++;
  }
  return n;
}

/**
 * 每日流程套用 MARKET_BRIEF 的結論（逾時的也在這裡結算）。只說明：不動帳戶、不發通知、不告警（失敗寫在 market_briefs.error 與流程紀錄；
 * 逾時另有共用的 AI_TIMEOUT 告警）。下一次流程 startMarketBrief 會照次數決定要不要再試。
 */
export async function applyMarketBrief(ctx: ApplyCtx, run: AiRun): Promise<void> {
  await settleBrief(ctx.db, run, ctx.now);
  const row = await ctx.db.prepare('SELECT * FROM market_briefs WHERE run_id = ?').bind(run.runId).first<BriefRow>();
  if (!row) return void ctx.log.push(`${run.runId}：找不到這次市場摘要的紀錄`);
  const what = row.stage === 'FINAL' ? '定稿' : '暫定稿';
  if (row.status === 'READY') {
    const b = parseBrief(row.payload);
    return void ctx.log.push(`${run.runId}：市場摘要（${what}）寫好了：${b?.causes.length ? `${b.causes.length} 個報導的說法` : '原因不明'}`);
  }
  ctx.log.push(`${run.runId}：市場摘要（${what}）沒有成功（${row.error ?? '—'}）`);
}
