// 候補的進場（allocation_redesign §4.5 第 11～17 點，T85 乙段）：
//   價格型進場條件  你自己填的數字（收盤低於 $X／比 52 週高點低 Y% 以上），存在 own_conditions（action = ENTRY、kind = PRICE），程式比收盤。
//                  「每天比」只用來顯示；真正決定列不列的是月報訊號日的收盤（prepareWatchEntries）。
//   月報的輸入      prepareWatchEntries：訊號日仍成立的價格條件、成立後等月報的非價格條件（watch[t].entry）、硬傷、財報類出場條件 → MonthlyContext.watchEntries
//   條件的狀態      列進月報（F29）那一刻才標成立（listedPriceStmts）；進場之後的下一次每日流程補寫其餘的（syncWatchConds）
// 非價格的進場條件（丙段，§4.5 第 18～23 點）：草稿或你在編輯論點頁寫（改寫、確認），財報門檻由程式比（ownXbrlConditions）、
//   申報事件在新申報時 F25（startWatchRuns）、只有法說會／新聞／網頁的月底有新證據時用 own_condition_v2 判；成立之後記進 watch[t].entry（ownAi.ts 的 queueWatchEntry）。
import { xbrlConditionMet, fetchCompanyFacts, quarterTable } from '../data/edgar';
import { buildMarketView } from '../data/marketView';
import { activeHits, classifyFilings, needsCover, quickHits, type FilingHit } from '../data/secEvents';
import { fetchEdgarSubmissions } from '../data/sources';
import { loadSeries, loadSplits } from '../data/store';
import { errText } from '../data/util';
import { ENTRY_PRICE_TYPES } from '../ai/ownReview';
import { SLOW, WATCH_LIST_GAP_DAYS, clone, drawdownFromHigh, type Account, type MarketView, type Notif, type WatchEntryInput } from '../engine';
import type { ApplyCtx } from './aiCtx';
import type { Env, Fetcher } from './env';
import { cikFor } from './filings';
import { requiredTickers, thesisLogStmt } from './ledgerStore';
import { wouldBuyOf } from './ownDraft';
import { EXIT_ACTIONS, LIVE_CODES, fileConditions, isOwned, loadConditions, type FileCondition } from './thesis';

/** 進場條件另算、不占你定的 8 條（§4.5 第 11 點）：你填的價格條件最多 2 條；非價格的（草稿或你寫的，丙段）最多 3 條。 */
export const MAX_ENTRY_PRICE = 2;
export const MAX_ENTRY_OTHER = 3;

export class WatchCondError extends Error {}

/**
 * 一條進場條件（網站、月報的輸入、示範模式共用的形狀；真實模式從 own_conditions 轉）。
 * price：你填的價格條件（check 是 { type: 'price_close_below', level, asOf } 或 { type: 'price_drawdown_below', pct, asOf }；
 * asOf 是填的那天的訊號日，之後的拆股用它換算 level）。status：ACTIVE 監測中、MET 已成立（列進月報了）、RETIRED 撤下…
 */
export interface EntryCond {
  id: number;
  ticker: string;
  fileId: string | null;
  text: string;
  price: boolean;
  /** 條件的種類（XBRL 財報門檻、EVENT 事件、PRICE 價格；丙段的顯示用）。舊的呼叫端沒給。 */
  kind?: string;
  check: Record<string, unknown>;
  status: string;
  setAt: string;
  metAt: string | null;
  note: string | null;
}

/** 拆股的一列（splits 表；示範模式沒有）。 */
export interface SplitLike {
  ticker: string;
  date: string;
  numerator: number;
  denominator: number;
}

export const isEntryPrice = (c: Pick<FileCondition, 'kind' | 'check' | 'action'>): boolean => c.action === 'ENTRY' && c.kind === 'PRICE' && ENTRY_PRICE_TYPES.includes(String(c.check.type));

export const toEntryCond = (c: FileCondition): EntryCond => ({ id: c.id, ticker: c.ticker, fileId: c.fileId, text: c.text, price: isEntryPrice(c), kind: c.kind, check: c.check, status: c.status, setAt: (c.acceptedAt ?? c.createdAt).slice(0, 10), metAt: c.metAt, note: c.note });

/** 使用者在候補那一塊填的一條價格條件：種類＋數字（close：收盤低於多少美元；drawdown：比 52 週高點低百分之幾以上）。 */
export interface PriceInput {
  type: 'close' | 'drawdown';
  value: number;
}

const money = (x: number) => `$${x.toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(x) ? 0 : 2, maximumFractionDigits: 2 })}`;
const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;

/** 結構化欄位 → 條件的文字與 check（程式組字，不經 AI 改寫；§4.5 第 12 點）。數字不合理丟 WatchCondError。 */
export function priceCheckOf(inp: PriceInput, asOf: string): { text: string; check: Record<string, unknown> } {
  const v = Number(inp.value);
  if (inp.type === 'close') {
    if (!(v > 0) || v > 1e6) throw new WatchCondError('收盤價要填大於 0 的數字（美元）');
    const level = Math.round(v * 100) / 100;
    return { text: `收盤低於 ${money(level)}`, check: { type: 'price_close_below', level, asOf } };
  }
  if (inp.type === 'drawdown') {
    if (!(v >= 1 && v <= 90)) throw new WatchCondError('比高點低的幅度填 1～90（百分比）；例如 25 代表比 52 週高點低 25% 以上');
    const pct = Math.round(v * 10) / 10;
    return { text: `比 52 週高點低 ${pct}% 以上`, check: { type: 'price_drawdown_below', pct, asOf } };
  }
  throw new WatchCondError('價格條件只有兩種：收盤低於多少、比 52 週高點低百分之幾以上');
}

/**
 * 「收盤低於 $X」的 X 要乘上的倍數：價格序列是拆股後的，條件填了之後（asOf 之後）才生效的拆股要把 X 一起換算，
 * 不然 1 拆 2 會誤觸發（§4.5 第 12 點）。比高點低幾 % 的條件是比例，不用換算。
 */
export function splitFactor(splits: readonly SplitLike[], ticker: string, asOf: string): number {
  let f = 1;
  for (const s of splits) if (s.ticker === ticker && s.date > asOf && s.numerator > 0 && s.denominator > 0) f *= s.denominator / s.numerator;
  return f;
}

/**
 * 一條價格條件在這一天收盤的樣子（純函式）。met：成立；null = 沒有收盤價、或高點算不出來。
 * now：`現在 -27.0%`／`現在收盤 $148.20`（顯示用）；level：拆股換算後的價位（收盤低於那一種；沒有拆股就是你填的）。
 */
export function priceState(check: Record<string, unknown>, close: ArrayLike<number> | undefined, i: number, factor = 1): { met: boolean | null; now: string | null; level?: number } {
  const px = close ? close[i] : NaN;
  if (!close || !Number.isFinite(px)) return { met: null, now: null };
  if (check.type === 'price_close_below') {
    const level = Number(check.level) * factor;
    return { met: Number.isFinite(level) ? px < level : null, now: `現在收盤 ${money(Math.round(px * 100) / 100)}`, level };
  }
  if (check.type === 'price_drawdown_below') {
    const dd = drawdownFromHigh(close, i, SLOW.highDays);
    if (!Number.isFinite(dd)) return { met: null, now: null };
    return { met: dd <= -Number(check.pct) / 100 + 1e-12, now: `現在 ${dd > -0.0005 ? '在 52 週高點' : `-${(-dd * 100).toFixed(1)}%`}` };
  }
  return { met: null, now: null };
}

/** 候補那一塊每條進場條件後面的那一句（§4.5 第 13 點：每天比只用來顯示）。 */
export function entryStateText(c: EntryCond, close: ArrayLike<number> | undefined, i: number, factor = 1): string {
  if (c.status === 'MET') return `已成立${c.metAt ? `（${md(c.metAt.slice(0, 10))}）` : ''}：一次性的，要再等就重新定條件`;
  // 非價格的（丙段）：怎麼確認
  if (!c.price) return c.status === 'MANUAL' ? '只記錄（格式沒有通過檢查，不會成立）' : c.status === 'REVIEW_ONLY' ? '監測中：月底有新的申報或網頁消息時由 AI 確認' : c.status === 'ACTIVE' ? (c.kind === 'XBRL' ? '監測中：新財報出來時程式比對' : '監測中：新申報出來時由 AI 確認') : c.status;
  const s = priceState(c.check, close, i, factor);
  const adj = s.level !== undefined && Math.abs(factor - 1) > 1e-9 ? `（拆股後換算成 ${money(Math.round(s.level * 100) / 100)}）` : '';
  if (s.met === null) return `價格抓不到，沒辦法比${adj}`;
  return `${s.now}，${s.met ? '條件成立中（月報那天仍然成立才會列進月報）' : '還沒到'}${adj}`;
}

/**
 * 這一天收盤仍然成立的價格條件（純函式；每檔候補一筆、沒有成立的不回）。月報的輸入與示範模式共用。
 * conds：各檔現在這份論點檔的進場條件；只看 ACTIVE 的價格條件。why：項目的理由那一句。
 */
export function priceEntriesAt(acct: Pick<Account, 'watch'>, view: MarketView, conds: Record<string, EntryCond[]>, splits: readonly SplitLike[] = []): WatchEntryInput[] {
  const out: WatchEntryInput[] = [];
  for (const [t, w] of Object.entries(acct.watch ?? {})) {
    const c = view.close[t];
    const met = (conds[t] ?? [])
      .filter((x) => x.price && x.status === 'ACTIVE' && x.fileId === w.fileId)
      .flatMap((x) => {
        const s = priceState(x.check, c, view.i, splitFactor(splits, t, String(x.check.asOf ?? x.setAt)));
        if (!s.met || !c) return [];
        const seen = x.check.type === 'price_drawdown_below' ? `收盤比 52 週高點低 ${(-drawdownFromHigh(c, view.i, SLOW.highDays) * 100).toFixed(1)}%` : `收盤 ${money(Math.round(c[view.i] * 100) / 100)}`;
        return [{ id: x.id, text: x.text, setAt: x.setAt, why: `${view.date} ${seen}，你填的價格條件在月報訊號日仍然成立（程式比的）`, price: true }];
      });
    if (met.length) out.push({ ticker: t, conds: met });
  }
  return out;
}

const HARD_SUBS = ['NT_10-K', 'NT_10-Q', '8K_4.02', '8K_4.01_RESIGN'];
const HARD_LABEL: Record<string, string> = { 'NT_10-K': '延遲申報年報', 'NT_10-Q': '延遲申報季報', '8K_4.02': '財報重編（8-K 4.02）', '8K_4.01_RESIGN': '會計師辭任' };

/**
 * 候補進場的硬傷（§4.5 第 14 點；純函式）：動能進場前那一套規則偵測裡的四種——被收購方、延遲申報、財報重編（8-K 4.02）、會計師辭任——
 * 只要是來自申報、還在有效期間內（呼叫前用 activeHits 濾過）就不提。重編與辭任在動能是「開法庭」，候補沒有法庭，所以直接擋。
 * 單日跳漲、EPS 背離、增資不擋。回傳寫給使用者看的原因；沒有是 null。
 */
export function watchHardHits(hits: readonly Pick<FilingHit, 'code' | 'sub' | 'form' | 'date' | 'displayOnly'>[]): string | null {
  const hard = hits.filter((h) => (h.code === 'PENDING_MA' && !h.displayOnly) || (h.code === 'ACCOUNTING' && HARD_SUBS.includes(h.sub)));
  if (!hard.length) return null;
  return [...new Set(hard.map((h) => `${h.code === 'PENDING_MA' ? '被收購' : (HARD_LABEL[h.sub] ?? '會計問題')}，${h.form} ${h.date}`))].slice(0, 3).join('；');
}

/** 各檔候補現在這份論點檔的進場條件（網站、月報）。 */
export async function loadEntryConds(db: D1Database, acct: Pick<Account, 'watch'>): Promise<Record<string, EntryCond[]>> {
  const out: Record<string, EntryCond[]> = {};
  for (const [t, w] of Object.entries(acct.watch ?? {})) out[t] = (await loadConditions(db, t, w.fileId, 'only')).map(toEntryCond);
  return out;
}

const calDays = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400_000);

/**
 * 月報訊號日、出月報之前（每日流程，網路可用；§4.5 第 13～15 點）：每檔候補這個月可以列的進場。
 *   價格條件看訊號日的收盤（月中成立過、訊號日不成立的不算，也不算用掉）；非價格的看 watch[t].entry（成立後等月報的）。
 *   有成立的才連網：EDGAR 申報清單 → watchHardHits；抓不到 → noFilings（這個月不提，下個月再看）。
 *   這檔你定的財報類出場條件（XBRL、監測中）現在已經成立 → exitMet（不提）；XBRL 抓不到時一樣不提（往保守的方向）。
 *   距上次列進月報不到 90 天的不連網（月報那一端會擋）。
 * 出錯的那一檔記在 log、當成申報清單抓不到；整個函式不丟錯（月報照出）。
 */
export async function prepareWatchEntries(env: Env, fetcher: Fetcher, acct: Account, signal: string, log: string[]): Promise<WatchEntryInput[]> {
  const tickers = Object.keys(acct.watch ?? {});
  if (!tickers.length) return [];
  const conds = await loadEntryConds(env.DB, acct);
  if (!tickers.some((t) => conds[t]?.some((c) => c.price && c.status === 'ACTIVE') || acct.watch![t].entry?.length)) return [];
  const series = await loadSeries(env.DB, [...new Set([...requiredTickers(acct), ...tickers])]);
  const { view } = buildMarketView(series, signal, acct.cfg.coreTicker);
  const splits = await loadSplits(env.DB, '1900-01-01').catch(() => []);
  const priced = new Map(priceEntriesAt(acct, view, conds, splits).map((e) => [e.ticker, e]));
  const out: WatchEntryInput[] = [];
  const ua = env.EDGAR_USER_AGENT ?? '';
  for (const t of tickers) {
    const w = acct.watch![t];
    const e: WatchEntryInput = priced.get(t) ?? { ticker: t, conds: [] };
    if (!e.conds.length && !w.entry?.length) continue;
    out.push(e);
    // 「今天沒持股的話會不會買」（§4.5 第 19 點）：這份論點檔最新一份草稿的反方答案與日期；只是資訊
    e.wouldBuy = await wouldBuyOf(env.DB, t, w.fileId).catch(() => null);
    if (w.lastListed && w.lastListed < signal && calDays(w.lastListed, signal) < WATCH_LIST_GAP_DAYS) continue;
    try {
      const cik = await cikFor(env, fetcher, t);
      if (!cik || !ua) throw new Error(cik ? '沒有設定 EDGAR 的 User-Agent' : '找不到這檔在 EDGAR 的編號');
      const sub = await fetchEdgarSubmissions(fetcher, cik, ua);
      const since = new Date(Date.parse(signal) - 365 * 86400_000).toISOString().slice(0, 10);
      const filings = sub.filings.filter((f) => f.filingDate <= signal && f.filingDate >= since);
      const notes: string[] = [];
      const hits = activeHits(await classifyFilings(fetcher, cik, [sub.name, ...sub.formerNames], filings.filter((f) => quickHits(f).length || needsCover(f)), ua, notes), signal);
      e.hard = watchHardHits(hits);
      // 你定的財報類出場條件（候補期間休眠、不會自己成立）：現在比一次，已經成立就不提進場（§4.5 第 15 點，往保守的方向）
      const exits = (await fileConditions(env.DB, acct, t)).filter((c) => isOwned(c) && c.kind === 'XBRL' && LIVE_CODES.includes(c.status) && EXIT_ACTIONS.includes(c.action ?? 'REVIEW'));
      if (exits.length && !e.hard) {
        const rows = quarterTable(await fetchCompanyFacts(fetcher, cik, ua), signal);
        const hit = exits.find((c) => xbrlConditionMet(rows, c.check as { type: string; metric: string; level: number; quarters?: number })?.met);
        if (hit) e.exitMet = hit.text;
      }
    } catch (err) {
      e.noFilings = errText(err).slice(0, 80);
      log.push(`候補 ${t} 的進場前檢查沒有跑成，這個月不提進場：${errText(err)}`);
    }
  }
  return out;
}

/**
 * 月報列了候補進場（F29）：列在項目上的價格條件標成立（一次性；§4.5 第 13 點「列進 F29 那一刻才標成立」）。
 * notifs：這次新產生的通知。已經成立的不重寫（重算月報時同一條會再經過這裡）。非價格的條件在確認成立時就標了。
 */
export function listedPriceStmts(db: D1Database, notifs: readonly Notif[], at: string): D1PreparedStatement[] {
  const out: D1PreparedStatement[] = [];
  for (const n of notifs) {
    for (const it of n.items) {
      if (it.kind !== 'WATCH_ENTRY' || it.cancelled || !it.watchEntry) continue;
      for (const c of it.watchEntry.conds) {
        if (!c.price) continue;
        out.push(db.prepare("UPDATE own_conditions SET status = 'MET', met_at = ?, note = ?, met_basis = 'PRICE' WHERE id = ? AND action = 'ENTRY' AND status = 'ACTIVE'").bind(at, `${n.date} 收盤仍然成立，列進${n.title}`, c.id));
      }
    }
  }
  return out;
}

/**
 * 進場之後的下一次每日流程（§4.5 第 17 點最後一項）：條件在資料庫、不跟帳戶版本走，快照當下不改（復原快照時帳戶和條件才不會不一致）；
 * 這裡補寫——列在進場項目上的那幾條標成立（還沒標的），其他還在監測的進場條件撤下（原因「已進場」或「你自己先買了」），帳戶記 entered.synced。
 */
export async function syncWatchConds(ctx: ApplyCtx): Promise<void> {
  const todo = Object.entries(ctx.acct.own).filter(([, m]) => m.entered && !m.entered.synced && !!m.fileId);
  if (!todo.length) return;
  ctx.acct = clone(ctx.acct);
  const at = ctx.now.toISOString();
  for (const [t] of todo) {
    const m = ctx.acct.own[t];
    const ent = m.entered!;
    const live = (await loadConditions(ctx.db, t, m.fileId!, 'only')).filter((c) => LIVE_CODES.includes(c.status));
    const why = ent.via === 'F29' ? `${ent.date} 已進場` : `${ent.date} 你自己先買了`;
    for (const c of live) {
      const listed = ent.conds?.includes(c.id);
      ctx.stmts.push(
        listed
          ? ctx.db.prepare("UPDATE own_conditions SET status = 'MET', met_at = ?, note = ?, met_basis = ? WHERE id = ?").bind(at, `${why}（列在進場項目上）`, c.kind === 'PRICE' ? 'PRICE' : (c.metBasis ?? 'REVIEW_VOTE'), c.id)
          : ctx.db.prepare("UPDATE own_conditions SET status = 'RETIRED', note = ? WHERE id = ?").bind(`${why}，這條進場條件撤下`, c.id),
      );
      ctx.stmts.push(thesisLogStmt(ctx.db, { ticker: t, fileId: m.fileId!, session: ctx.session, kind: 'CONDITION', ref: String(c.id), body: { id: c.id, change: listed ? 'MET' : 'RETIRED', action: 'ENTRY', by: 'SYSTEM', reason: why } }, null, at));
    }
    ent.synced = true;
    ctx.log.push(`${t} 從候補進場（${ent.via === 'F29' ? '照月報的進場項目' : '自己先買'}）：進場條件補寫狀態（${live.length} 條）`);
  }
}

/**
 * 候補那一塊存價格條件（`ops/watch-price`，§4.5 第 12 點）：整組取代價格那一組（非價格的進場條件不動）。
 * 原本監測中的價格條件撤下、寫入新的（寫入就是監測中，不經 AI 改寫）；已經成立過的留著當紀錄。最多 MAX_ENTRY_PRICE 條；空的 = 全部撤下。
 */
export async function setWatchPrice(db: D1Database, acct: Pick<Account, 'own' | 'watch'>, ticker: string, inputs: PriceInput[], session: string, now: Date): Promise<void> {
  const w = acct.watch?.[ticker];
  if (!w) throw new WatchCondError(acct.own[ticker] ? `${ticker} 已經是持股，進場條件用不到了` : `${ticker} 不在候補名單裡`);
  if (inputs.length > MAX_ENTRY_PRICE) throw new WatchCondError(`價格條件最多 ${MAX_ENTRY_PRICE} 條`);
  const next = inputs.map((x) => priceCheckOf(x, session));
  if (new Set(next.map((x) => x.text)).size !== next.length) throw new WatchCondError('兩條價格條件一樣，留一條就好');
  const at = now.toISOString();
  const old = (await loadConditions(db, ticker, w.fileId, 'only')).filter((c) => isEntryPrice(c) && LIVE_CODES.includes(c.status));
  const ins = db.prepare("INSERT INTO own_conditions (ticker, run_id, cond_id, direction, kind, text, check_json, tier_if_met, status, created_at, note, origin, file_id, accepted_at, action, auto, supersedes, premise_id) VALUES (?, 'watch-price', ?, 'UP', 'PRICE', ?, ?, NULL, 'ACTIVE', ?, NULL, 'USER', ?, ?, 'ENTRY', 1, NULL, NULL)");
  await db.batch([
    ...old.map((c) => db.prepare("UPDATE own_conditions SET status = 'RETIRED', note = ? WHERE id = ?").bind(`你在 ${at.slice(0, 10)} 改了價格條件`, c.id)),
    ...next.map((x, k) => ins.bind(ticker, `EP${k + 1}`, x.text, JSON.stringify(x.check), at, w.fileId, at)),
    thesisLogStmt(db, { ticker, fileId: w.fileId, session, kind: 'CONDITION', ref: 'ENTRY_PRICE', body: { change: 'ENTRY_PRICE_SET', action: 'ENTRY', by: 'USER', conds: next.map((x) => x.text), retired: old.map((c) => c.id) } }, null, at),
  ]);
}
