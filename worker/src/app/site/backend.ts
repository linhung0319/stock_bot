// 網站讀寫資料的來源。兩種：
//   真實：帳本與價格都在 D1（T6 的資料層）。
//   示範：假市場＋腳本（src/demo），整個狀態存在 D1 的 demo_state 一列；和真實帳本完全分開。
// 網站的程式只認這個介面，所以兩種模式走同一套畫面與操作。
import { dismissDraft, draftForSave, draftStates, markDraftUsed, readyDraft, requestOwnDraft, type DraftRow, type DraftState, type DraftUse, type DraftView } from '../ownDraft';
import { routineReady } from '../ownAi';
import { homeBrief, type HomeBrief } from '../marketBrief';
import { DEMO_NOTE_PREFIX, ackNoCrashNote, noCrashNote, type NoCrashNote, type NoCrashNoteId } from '../noCrashNote';
import type { DraftBroken } from '../../ai/ownDraft';
import { bookShares, migrateAccount, pendingSplits, type Account, type Attention, type LedgerEvent, type MarketView, type OwnWebSources, type ShadowRecord, type Snapshot, type StrategyReviewState, type WebSourceCheck } from '../../engine';
import { probeWebSources } from '../webEvidence';
import { easternTime, lastCompletedSession } from '../../data/calendar';
import { BENCHMARK } from '../../data/ingest';
import { buildMarketView, rebaseNotifSeq } from '../../data/marketView';
import { fetchYahooDaily, type Fetcher } from '../../data/sources';
import { loadCalendarOverrides, loadRanking, loadSeries, saveSeries, saveSplits, seriesFromBars } from '../../data/store';
import { errText, retry } from '../../data/util';
import { DEMO_IDS, DEMO_SCRIPTS, type DemoId } from '../../demo/demoScripts';
import { advanceDemo, demoAtEnd, demoFill, demoFilledSnapshot, demoMarket, demoView, resetDemo, type AdvanceMode, type DemoState, type OnNotifs } from '../../demo/driver';
import { ranksAt } from '../../demo/market';
import type { Env } from '../env';
import { getRun, listRuns, type AiRun } from '../aiRuns';
import { ConflictError, loadAccount, loadEvents, loadShadow, requiredTickers, saveAccount, saveSnapshot, saveSnapshotUndo, shadowTickers, snapshotUndoInfo, thesisLogStmt, undoSnapshot, type LoadedAccount, type SnapshotUndoInfo, type SnapshotWarn, type ThesisLogInput, warnOf } from '../ledgerStore';
import { noteOfRun } from './aiViews';
import { loadSnapshot, type MacroSnapshot } from '../crashAi';
import { loadEvents as loadSecEvents, type SecEventRow } from '../filings';
import { loadReviews, loadVetoReviews, type MomReview } from '../momAi';
import { loadStrategyState } from '../strategyAi';
import { acceptOwnConditions, adoptDraftExits, confirmDropAll, exitSetOf, monitorView, ownCheckView, resendOwnCheck, rewriteView, startOwnCheck, type ConfirmResult, type ExitSetRef, type OwnCheckView, type RewriteView } from '../ownCheckAi';
import type { ExitLine } from '../../ai/ownCheck';
import type { DiscussionMode } from '../../ai/discussion';
import { realDiscussion } from '../discussion';
import { conditionOp, type CondOp } from '../ownConds';
import { holdingAttention, loadPrevFile, thesisFile, type ExitSet, type PrevFile } from '../thesis';
import { thesisView, type ThesisView } from './thesisView';
import { holdingMom, vetoEpisodes, type HoldingMom, type VetoEpisode } from '../momNotes';
import { annotate } from './explain';
import type { AiNote } from './types';

export interface DemoInfo {
  scenario: DemoId;
  title: string;
  summary: string;
  tips: string[];
  atEnd: boolean;
  scenarios: { id: DemoId; title: string }[];
}

export interface SiteData {
  mode: 'real' | 'demo';
  acct: Account | null;
  /** 最近一個收盤日的市場；沒有價格資料時是 null。 */
  view: MarketView | null;
  /** 交易日（由舊到新，最後一個是 view.date）。 */
  axis: string[];
  rankOrder: string[];
  rankSession: string | null;
  aiNotes: AiNote[];
  /** 之前存下來的帳本事件與「沒照做」紀錄（這次請求新增的在 acct 裡）。 */
  events: LedgerEvent[];
  shadow: ShadowRecord[];
  /** 估成交金額用的價格；沒有就用收盤。 */
  fill?: (ticker: string) => number;
  /** 使用者操作的這一天。 */
  today: string;
  /** 現在的美東日期（真實模式；快照與建立帳戶記下來，拆股用，design_v2 §10 第 48 點）。示範模式沒有（用訊號日）。 */
  asOf?: string;
  warnings: string[];
  demo?: DemoInfo;
  /** 示範：照清單以開盤價成交後的數字（幫使用者填快照用）。 */
  autofill?: (extra?: Record<string, number>, exact?: boolean) => Snapshot;
  /** 可以復原的快照（最後一份、之後帳戶還沒有變動）。 */
  undoable?: SnapshotUndoInfo | null;
  /** 策略檢討的狀態（改比例那一列「動能相對大盤」，core_ai §3.11）；示範模式沒有。 */
  strategy?: StrategyReviewState | null;
  /** 每檔自選的論點草稿狀態（T56，web_evidence_design §2.5、§2.6；各入口的「請 stock bot 草擬」按鈕用）。示範模式沒有。 */
  drafts?: Record<string, DraftState>;
  /** 雲端排程設定好了（新的自選「明天早上會自動草擬一次」的提示用）。示範模式沒有。 */
  aiReady?: boolean;
  /** 首頁那一行市場摘要（T65，composite_layer_design §1.8：最近 10 個交易日內有寫好的摘要）。示範模式沒有。 */
  brief?: HomeBrief | null;
  /** 首頁一次性的說明（崩盤規則退場，allocation_redesign §2.4）：還沒按「知道了」時才有。 */
  notice?: NoCrashNote | null;
}

export interface SiteBackend {
  mode: 'real' | 'demo';
  /** AI 執行紀錄（新的在前）。示範模式沒有完整紀錄，回傳空的。 */
  runs(): Promise<AiRun[]>;
  run(id: string): Promise<AiRun | null>;
  /** extra：這次操作另外需要價格的代號（真實模式沒有存的會當場去抓）。 */
  load(extra?: string[]): Promise<SiteData>;
  /** log：和這一版帳戶一起寫的論點檔紀錄（own_thesis_log；示範模式不寫）。 */
  save(acct: Account, cause: string, log?: ThesisLogInput[]): Promise<void>;
  recordSnapshot(date: string, snap: Snapshot): Promise<void>;
  /** 快照存檔後：留下送出前的帳戶，好讓使用者復原（設計 §10 第 39 點）。 */
  saveUndo(before: Account, after: Account, date: string, warn: SnapshotWarn): Promise<void>;
  undoSnapshot(): Promise<{ ok: true; date: string } | { ok: false; reason: string }>;
  /**
   * 填快照前先查拆股（design_v2 §10 第 48 點；只有真實模式有）：股數和帳本差很多倍的代號向 Yahoo 重抓一次，
   * 有拆股就記進 splits、存好換算後的價格（之後載入帳戶就會套用）。回傳這次新記到拆股的代號。查不到不丟錯。
   */
  checkSplits?(shares: Record<string, number>): Promise<string[]>;
  /** 試抓每檔的網頁證據來源（T52，web_evidence_design §1.3；只有真實模式會真的對外連線，示範模式沒有這個方法）。 */
  probeSources?(ws: OwnWebSources): Promise<WebSourceCheck[]>;
  /** 首頁一次性說明按「知道了」（allocation_redesign §2.4）。 */
  ackNotice(id: NoCrashNoteId): Promise<void>;
  /** AI 層的網站操作（只有真實模式有）。 */
  ai?: SiteAi;
}

export interface SiteAi {
  /** F14：把使用者要的出場條件送去改寫（T27 起只有改寫模式；T42 帶整組取代的對照資料）。 */
  ownCheck(ticker: string, exits: ExitLine[], set?: ExitSetRef): Promise<{ runId: string }>;
  /** 使用者按「請 stock bot 草擬」（T55，web_evidence_design §2.5）：立刻開；還在跑、7 天內草擬過 → DraftError（409）。畫面在 T56。 */
  draft(ticker: string): Promise<{ runId: string; broken: DraftBroken | null; failed: string | null }>;
  /** 編輯論點頁讀的草稿（T56）：這份論點檔等你看的那一份；沒有是 null。 */
  readyDraft(ticker: string, acct: Account): Promise<DraftView | null>;
  /** 存檔時用到的那一份草稿（T56；這檔的，是不是這份論點檔的由存檔那邊對）。 */
  draftForSave(ticker: string, id: number): Promise<DraftRow | null>;
  /** 採用了草稿 → USED（T56；T70 起是整份採用）。 */
  markDraftUsed(ticker: string, use: DraftUse): Promise<boolean>;
  /** 採用草稿時，草稿的出場條件直接寫進條件、撤下草稿沒有的、改沿用那幾條的動作（T70，confirm_audit_design §2.2）。 */
  adoptExits(ticker: string, inp: Parameters<typeof adoptDraftExits>[2]): Promise<ConfirmResult>;
  /** 「不用這份草稿」→ DISMISSED（T56）。 */
  dismissDraft(ticker: string, id: number): Promise<boolean>;
  /** 重送最近一次出場條件有改動的那一版（T42；version 不是最新的 → StaleExitsError）。 */
  resendExits(ticker: string, version: number | null): Promise<{ runId: string }>;
  /** 那一版把出場條件全部拿掉：確認後撤下（T42）。 */
  dropAllExits(ticker: string, version: number): Promise<ConfirmResult>;
  /** 最近一次出場條件有改動的那一版（T42；編輯論點的預覽用）。 */
  exitSet(ticker: string): Promise<ExitSet | null>;
  checkView(runId: string): Promise<OwnCheckView | null>;
  /** 持股頁：最近 30 天還沒勾的改寫結果、還沒送出去的出場條件（own_thesis §1.8）。 */
  rewrites(ticker: string): Promise<RewriteView>;
  /** 討論包（own_thesis §1.7）。 */
  discussion(ticker: string, acct: Account, view: MarketView, mode: DiscussionMode | null, notif: number | null): Promise<{ text: string; mode: DiscussionMode }>;
  /** 確認改寫結果（T42）：勾選的開始監測、被取代的與這次沒提到的撤下。 */
  acceptConditions(ticker: string, runId: string, ids: string[], actions?: Record<string, unknown>): Promise<ConfirmResult>;
  /** 持股頁的條件操作（T26）：勾選 AI 建議的條件、撤下你定的條件、改成立時的動作。 */
  condition(ticker: string, id: number, op: CondOp, action?: unknown): Promise<{ id: number; status: string; action: string | null; retired?: number }>;
  monitor(ticker: string): Promise<Awaited<ReturnType<typeof monitorView>>>;
  /** 持股頁：這檔現在成立的「要看的事」（全部，不看頻率；own_thesis §3.6.6）。 */
  attention(ticker: string, acct: Account, view: MarketView): Promise<Attention[]>;
  /** 賣光之後又買回時的上一份論點檔，連同當時的出場條件（T44，own_thesis §1.2）。沒有是 null。 */
  prevFile(ticker: string, acct: Account): Promise<PrevFile | null>;
  /** 持股頁的論點那一塊（T34）：前提最近一次的檢查、事件、歷次審查與回應、靜默中的前提、減半檢視。不是自選是 null。 */
  thesis(ticker: string, acct: Account, view: MarketView): Promise<ThesisView | null>;
  /** 持股頁的動能那一塊（momentum_ai §3.6）：最近 90 天的事件、現在成立的「要看的事」（含進場時的附註）。不是動能持股是 null。 */
  mom(ticker: string, acct: Account, view: MarketView, rankOrder: string[]): Promise<HoldingMom | null>;
  /** AI 紀錄頁上方：最新的總經儀表板、最近一個月的動能進場審查、歷次 AI 否決（§3.7）、最近的申報事件。 */
  overview(): Promise<{ macro: MacroSnapshot | null; reviews: MomReview[]; vetoes: VetoEpisode[]; events: SecEventRow[] }>;
}

/** 填快照前要查拆股的代號：快照的股數是帳本（也是照清單做完）的 1.5 倍以上或 2/3 以下；一次最多查 8 檔（design_v2 §10 第 48 點）。 */
export const SPLIT_SUSPECT = { hi: 1.5, lo: 2 / 3, max: 8 } as const;

const taipeiDate = (now: Date): string => new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10);

// ---------------------------------------------------------------- 真實

export function realBackend(env: Env, fetcher: Fetcher, now: Date): SiteBackend {
  let loaded: LoadedAccount | null = null;
  let rev: number | null = null;
  const self: SiteBackend = {
    mode: 'real',
    async load(extra = []) {
      loaded = await loadAccount(env.DB);
      let acct = loaded?.acct ?? null;
      const warnings: string[] = [];
      const ranking = await loadRanking(env.DB);
      const core = acct?.cfg.coreTicker ?? 'VOO';
      const required = requiredTickers(acct);
      const shadowSince = new Date(now.getTime() - 213 * 86400_000).toISOString().slice(0, 10);
      const shadowed = acct ? await shadowTickers(env.DB, shadowSince) : [];
      const want = [...new Set([...required, BENCHMARK, ...(ranking?.order ?? []), ...shadowed, ...extra])];
      let series = await loadSeries(env.DB, want);
      const session = series.get(core)?.d.at(-1) ?? null;
      // 這次操作要用、但沒有存或不是最新的代號：當場抓一次（新增自選、快照出現新代號、建立帳戶）
      const missing = session ? extra.filter((t) => series.get(t)?.d.at(-1) !== session) : [];
      let newSplits = false;
      if (missing.length && session) {
        const got = await Promise.all(
          missing.map(async (t) => {
            try {
              const s = await retry(() => fetchYahooDaily(fetcher, t, '2y'));
              if (s.splits.length) {
                await saveSplits(env.DB, t, s.splits, now.toISOString());
                newSplits = true;
              }
              return seriesFromBars(t, s.bars.filter((b) => b.date <= session), now.toISOString(), session);
            } catch (e) {
              warnings.push(`抓不到 ${t} 的價格（${errText(e)}）`);
              return null;
            }
          }),
        );
        const ok = got.filter((s): s is NonNullable<typeof s> => !!s && s.d.length > 0);
        if (ok.length) {
          await saveSeries(env.DB, ok);
          series = await loadSeries(env.DB, want);
        }
        // 剛抓到的價格已經是拆股後的：帳戶重新載入，才會套用剛記到的拆股（design_v2 §10 第 48 點）
        if (newSplits && loaded) {
          loaded = await loadAccount(env.DB);
          acct = loaded?.acct ?? null;
        }
      }
      let view: MarketView | null = null;
      let axis: string[] = [];
      if (session) {
        const built = buildMarketView(series, session, core);
        view = built.view;
        axis = built.axis;
        const stale = built.stale.filter((t) => required.includes(t) || extra.includes(t));
        if (stale.length) warnings.push(`這些代號沒有 ${session} 的收盤價：${stale.join('、')}。用到它們的清單暫時算不出來。`);
        const expect = lastCompletedSession(now, await loadCalendarOverrides(env.DB));
        if (session < expect) warnings.push(`價格只更新到 ${session}（應該要有 ${expect}）。每日抓取可能失敗了；清單是用 ${session} 的收盤算的。`);
        if (acct) rebaseNotifSeq(acct, axis);
      } else {
        warnings.push('還沒有價格資料：每日抓取還沒有跑過。');
      }
      // 最近 36 小時的告警（每日流程、資料抓取）也放在網站的警示列；已經解決的、測試推播用的（/admin/alert/test）不放
      const since = new Date(now.getTime() - 36 * 3600_000).toISOString();
      const alerts = (await env.DB.prepare("SELECT message, MAX(id) AS id FROM alerts WHERE at >= ? AND kind != 'TEST' AND (sent_at IS NULL OR sent_at NOT IN ('RESOLVED', 'SKIPPED_OLD')) GROUP BY message ORDER BY id DESC LIMIT 5").bind(since).all<{ message: string }>()).results;
      for (const a of alerts) warnings.push(a.message);
      const [events, shadow] = acct ? await Promise.all([loadEvents(env.DB, 300), loadShadow(env.DB, 300)]) : [[], []];
      // AI 紀錄 → 建議單上的 AI 說明
      const aiNotes = (await listRuns(env.DB, now, { limit: 200 })).map(noteOfRun).filter((n): n is AiNote => n !== null);
      const undoable = acct ? await snapshotUndoInfo(env.DB, loaded?.rev ?? null) : null;
      const strategy = acct ? await loadStrategyState(env.DB) : null;
      // 論點草稿的狀態（T56）：放在 listRuns 之後（逾時的執行先照規則結束，草稿才結算得到）；讀不到不擋網站
      const drafts: Record<string, DraftState> = acct && view ? await draftStates(env, acct, now, view.date).catch((e) => (console.error('論點草稿的狀態', e), {})) : {};
      // 首頁那一行市場摘要（T65）：也放在 listRuns 之後（逾時的那一次先結束）；讀不到不擋網站
      const brief = acct && view ? await homeBrief(env.DB, axis).catch((e) => (console.error('市場摘要', e), null)) : null;
      const notice = acct && view ? await noCrashNote(env.DB, acct, axis).catch((e) => (console.error('首頁的一次性說明', e), null)) : null;
      return { mode: 'real', acct, view, axis, rankOrder: ranking?.order ?? [], rankSession: ranking?.session ?? null, aiNotes, events, shadow, today: taipeiDate(now), asOf: easternTime(now).date, warnings, undoable, strategy, drafts, aiReady: routineReady(env), brief, notice };
    },
    async save(acct, cause, log = []) {
      // 論點檔紀錄和這一版帳戶同一筆交易寫（account_version = 這次存檔的 rev，復原快照時一起刪）
      const next = (loaded?.rev ?? 0) + 1;
      const at = now.toISOString();
      rev = await saveAccount(env.DB, acct, loaded, cause, now, log.map((l) => thesisLogStmt(env.DB, l, next, at)));
    },
    ackNotice: (id) => ackNoCrashNote(env.DB, id, now),
    runs: () => listRuns(env.DB, now, { limit: 200 }),
    run: (id) => getRun(env.DB, id, now),
    async recordSnapshot(date, snap) {
      await saveSnapshot(env.DB, date, snap, now, rev);
    },
    async saveUndo(before, after, date, warn) {
      if (rev !== null) await saveSnapshotUndo(env.DB, rev, before, after, date, now, warn);
    },
    undoSnapshot: () => undoSnapshot(env.DB, now),
    probeSources: (ws) => probeWebSources(env, fetcher, ws),
    async checkSplits(shares) {
      const acct = (await loadAccount(env.DB))?.acct;
      if (!acct) return [];
      const book = bookShares(acct);
      // 照等你下單的清單做完的股數：快照和帳本、和做完的都差很多倍才查（只差在有沒有下單的不算）
      const done: Record<string, number> = { ...book };
      for (const n of acct.notifs) if (n.status === 'RESPONDED' && n.composed) for (const m of n.composed.merged) done[m.ticker] = (done[m.ticker] ?? 0) + m.shares;
      const off = (x: number, base: number) => !(base > 0) || x / base >= SPLIT_SUSPECT.hi || x / base <= SPLIT_SUSPECT.lo;
      const suspects = Object.keys(shares)
        .filter((t) => (book[t] ?? 0) > 0 && shares[t] > 0 && off(shares[t], book[t]) && off(shares[t], done[t] ?? 0))
        .slice(0, SPLIT_SUSPECT.max);
      if (!suspects.length) return [];
      const session = lastCompletedSession(now, await loadCalendarOverrides(env.DB));
      const at = now.toISOString();
      const found: string[] = [];
      for (const t of suspects) {
        try {
          const s = await retry(() => fetchYahooDaily(fetcher, t, '2y'));
          // 先記拆股、再存價格（價格已經是拆股後的數字）
          if (!pendingSplits(acct, s.splits.map((x) => ({ ticker: t, ...x }))).length) continue;
          await saveSplits(env.DB, t, s.splits, at);
          const bars = s.bars.filter((b) => b.date <= session);
          if (bars.length) await saveSeries(env.DB, [seriesFromBars(t, bars, at, session)]);
          found.push(t);
        } catch (e) {
          console.error(`填快照前查 ${t} 的拆股失敗`, e);
        }
      }
      return found;
    },
    ai: {
      async ownCheck(ticker, exits, set) {
        const d = await self.load([ticker]);
        if (!d.acct || !d.view) throw new Error('還沒有帳戶或價格資料');
        const run = await startOwnCheck(env, fetcher, d.acct, d.view, d.axis, ticker, exits, now, set);
        return { runId: run.runId };
      },
      async draft(ticker) {
        const d = await self.load([ticker]);
        if (!d.acct || !d.view) throw new Error('還沒有帳戶或價格資料');
        return requestOwnDraft(env, fetcher, d.acct, d.view, d.axis, ticker, now);
      },
      readyDraft: (ticker, acct) => readyDraft(env.DB, acct, ticker),
      draftForSave: (ticker, id) => draftForSave(env.DB, ticker, id),
      markDraftUsed: (ticker, use) => markDraftUsed(env.DB, ticker, use, now),
      adoptExits: async (ticker, inp) => adoptDraftExits(env, ticker, inp, now, lastCompletedSession(now, await loadCalendarOverrides(env.DB))),
      dismissDraft: (ticker, id) => dismissDraft(env.DB, ticker, id, now),
      async resendExits(ticker, version) {
        const d = await self.load([ticker]);
        if (!d.acct || !d.view) throw new Error('還沒有帳戶或價格資料');
        const run = await resendOwnCheck(env, fetcher, d.acct, d.view, d.axis, ticker, version, now);
        return { runId: run.runId };
      },
      exitSet: async (ticker) => exitSetOf(env.DB, (await loadAccount(env.DB))?.acct.own[ticker]?.fileId),
      dropAllExits: async (ticker, version) => confirmDropAll(env, ticker, version, now, lastCompletedSession(now, await loadCalendarOverrides(env.DB))),
      checkView: (runId) => ownCheckView(env, runId, now),
      rewrites: (ticker) => rewriteView(env, ticker, now),
      discussion: (ticker, acct, view, mode, notif) => realDiscussion(env, fetcher, acct, view, ticker, mode, notif),
      acceptConditions: async (ticker, runId, ids, actions) => acceptOwnConditions(env, ticker, runId, ids, now, actions, lastCompletedSession(now, await loadCalendarOverrides(env.DB))),
      async condition(ticker, id, op, action) {
        const acct = (await loadAccount(env.DB))?.acct;
        if (!acct) throw new Error('還沒有帳戶');
        return conditionOp(env.DB, acct, ticker, id, op, action, lastCompletedSession(now, await loadCalendarOverrides(env.DB)), now);
      },
      monitor: (ticker) => monitorView(env, ticker),
      attention: (ticker, acct, view) => holdingAttention(env.DB, acct, view, ticker),
      prevFile: (ticker, acct) => loadPrevFile(env.DB, acct, ticker),
      async thesis(ticker, acct, view) {
        const file = await thesisFile(env.DB, acct, ticker, view.date);
        const meta = acct.own[ticker];
        return file && meta ? thesisView(file, meta, acct, view.date) : null;
      },
      mom: (ticker, acct, view, rankOrder) => holdingMom(env.DB, acct, view, ticker, rankOrder),
      async overview() {
        const macro = await loadSnapshot(env.DB);
        const all = await loadReviews(env.DB);
        const month = all[0]?.month;
        return { macro, reviews: month ? all.filter((r) => r.month === month) : [], vetoes: vetoEpisodes(await loadVetoReviews(env.DB)), events: (await loadSecEvents(env.DB)).filter((e) => e.status !== 'INFO' || e.display_only === 0).slice(0, 30) };
      },
    },
  };
  return self;
}

// ---------------------------------------------------------------- 示範

interface DemoRow {
  rev: number;
  scenario: string;
  d: number;
  body: string;
}

export interface DemoBackend extends SiteBackend {
  reset(id: DemoId): Promise<void>;
  advance(mode: AdvanceMode): Promise<{ days: number; created: number[] }>;
}

export function demoBackend(env: Env, now: Date): DemoBackend {
  let st: DemoState | null = null;
  let rev = 0;
  const onNotifs: OnNotifs = (acct, view, rankOrder) => {
    const m = demoMarket(st?.scenario ?? 's1');
    annotate({ acct, view, axis: m.days.slice(0, view.i + 1), rankOrder, aiNotes: DEMO_SCRIPTS[st?.scenario ?? 's1'].notes });
  };
  const read = async () => {
    const row = await env.DB.prepare('SELECT rev, scenario, d, body FROM demo_state WHERE id = 1').first<DemoRow>();
    if (!row) {
      st = null;
      rev = 0;
      return;
    }
    st = { scenario: row.scenario as DemoId, d: row.d, acct: migrateAccount(JSON.parse(row.body) as Account) };
    rev = row.rev;
  };
  const write = async (next: DemoState) => {
    const body = JSON.stringify(next.acct);
    const at = now.toISOString();
    if (rev === 0) {
      await env.DB.prepare('INSERT INTO demo_state (id, rev, scenario, d, updated_at, body) VALUES (1, 1, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET rev = demo_state.rev + 1, scenario = excluded.scenario, d = excluded.d, updated_at = excluded.updated_at, body = excluded.body')
        .bind(next.scenario, next.d, at, body)
        .run();
    } else {
      const r = await env.DB.prepare('UPDATE demo_state SET rev = rev + 1, scenario = ?, d = ?, updated_at = ?, body = ? WHERE id = 1 AND rev = ?').bind(next.scenario, next.d, at, body, rev).run();
      if (!r.meta.changes) throw new ConflictError('示範資料已經被另一個操作更新，請重新整理再做一次');
    }
    st = next;
    rev += 1;
  };
  const demoUndoable = async (): Promise<SnapshotUndoInfo | null> => {
    const row = await env.DB.prepare("SELECT rev, date, at, notifs FROM snapshot_undo WHERE mode = 'demo'").first<{ rev: number; date: string; at: string; notifs: string }>();
    return row && row.rev === rev ? { rev: row.rev, date: row.date, at: row.at, ...warnOf(row.notifs) } : null;
  };
  const info = (s: DemoState): DemoInfo => {
    const sc = DEMO_SCRIPTS[s.scenario];
    return { scenario: s.scenario, title: sc.title, summary: sc.summary, tips: sc.tips, atEnd: demoAtEnd(s), scenarios: DEMO_IDS.map((id) => ({ id, title: DEMO_SCRIPTS[id].title })) };
  };
  return {
    mode: 'demo',
    async load() {
      await read();
      if (!st) {
        // 第一次進示範模式：從情境 ① 開始
        st = { scenario: 's1', d: 0, acct: null as unknown as Account };
        await write(resetDemo('s1', onNotifs));
      }
      const s = st!;
      const m = demoMarket(s.scenario);
      const view = demoView(s);
      return {
        mode: 'demo',
        acct: s.acct,
        view,
        axis: m.days.slice(0, s.d),
        rankOrder: ranksAt(m, s.d - 1),
        rankSession: view.date,
        aiNotes: DEMO_SCRIPTS[s.scenario].notes,
        events: [],
        shadow: [],
        fill: demoFill(s),
        today: m.days[s.d],
        warnings: [],
        demo: info(s),
        undoable: await demoUndoable(),
        autofill: (extra, exact) => demoFilledSnapshot({ ...s, acct: st!.acct }, extra, exact),
        notice: await noCrashNote(env.DB, s.acct, [], true).catch(() => null),
      };
    },
    async save(acct) {
      if (!st) throw new Error('示範資料還沒有載入');
      await write({ ...st, acct });
    },
    async recordSnapshot() {
      // 示範模式不另外留快照原文
    },
    async saveUndo(before, _after, date, warn) {
      await env.DB.prepare("INSERT INTO snapshot_undo (mode, rev, date, at, state, notifs) VALUES ('demo', ?, ?, ?, ?, ?) ON CONFLICT(mode) DO UPDATE SET rev = excluded.rev, date = excluded.date, at = excluded.at, state = excluded.state, notifs = excluded.notifs").bind(rev, date, now.toISOString(), JSON.stringify(before), JSON.stringify({ warn })).run();
    },
    async undoSnapshot() {
      await read();
      const row = await env.DB.prepare("SELECT rev, date, state FROM snapshot_undo WHERE mode = 'demo'").first<{ rev: number; date: string; state: string }>();
      if (!row || !st) return { ok: false as const, reason: '沒有可以復原的快照。' };
      if (row.rev !== rev) return { ok: false as const, reason: '這份快照之後示範資料已經有其他變動，不能復原了。' };
      await write({ ...st, acct: JSON.parse(row.state) as Account });
      await env.DB.prepare("DELETE FROM snapshot_undo WHERE mode = 'demo'").run();
      return { ok: true as const, date: row.date };
    },
    runs: async () => [],
    run: async () => null,
    ackNotice: (id) => ackNoCrashNote(env.DB, id, now, true),
    async reset(id) {
      await env.DB.prepare('DELETE FROM flow_state WHERE key LIKE ?').bind(`${DEMO_NOTE_PREFIX}%`).run();
      await read();
      st = st ?? { scenario: id, d: 0, acct: null as unknown as Account };
      st = { ...st, scenario: id };
      await write(resetDemo(id, onNotifs));
    },
    async advance(mode) {
      await read();
      if (!st) throw new Error('示範資料還沒有開始');
      const r = advanceDemo(st, mode, onNotifs);
      await write(r.state);
      return { days: r.days, created: r.created };
    },
  };
}

export { ConflictError };
