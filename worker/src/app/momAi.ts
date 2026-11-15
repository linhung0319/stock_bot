// T11：F1 動能新股進場（否決法庭）的排程端（設計 §6.2、§2.4；ai_layer F1 卡片）。
// T32b：進場審查的改寫（momentum_ai_design_2026-11-15 §3.2～§3.4、§3.9）。
//
//   月報前一天（UTC 23:30，momPreview）：用當天的排名找出這個月會進場的股票（加上「被否決時的遞補者」），
//     逐檔跑 momEvidence 的規則偵測 → 照 §3.3 的表下結論；要法庭的先看能不能沿用上一次有結論的法庭（§3.4，有新證據才重開），
//     不能沿用就開 MOM_ENTRY（3 票）。同一批對象開一份進場前回看（src/app/momLookback.ts）。擬事件打分照舊（T32d 拿掉）。
//   01:30（momRecheck，掛在 schedule.ts 的 finalStarts）：重開沒有結論的法庭（最多 2 次）、回看帶來新命中的開法庭、
//     重跑抓不到申報的；回看沒有合格結論就重開一次。01:30 開的法庭在 03:30 套用。
//   月報當天（prepareEntries，在出月報之前）：先套用已經完成的法庭結論；還在等的照規則准許（2 次都沒有結論 → F1_COURT_FAILED）；
//     還沒審過的（月報當天才進榜的）只跑規則偵測，要法庭的先照規則准許（late = 1）。月報之後同一次流程（momLateStart）開法庭與回看。
//     結果 → 月報的 vetoed、emptySlots、每一項的說明（entryNotes）、沿用的否決（vetoCarried）。
//   月報之後才回來的否決（§3.3）：不改清單，降成建議——月報那一項加 AI 那一行、LINE 補推一則（只一次）、影子紀錄。
// 結果存在 mom_reviews（一個月一檔一列），網站與往前驗證用。
import type { PackDoc } from '../ai/check';
import {
  ENTRY_CODE_TEXT,
  MOM_ENTRY,
  MOM_SCORE,
  NEW_EVIDENCE_TEXT,
  courtConcluded,
  courtFailWhy,
  courtFailed,
  courtVerdict,
  entryNewEvidence,
  entryNote,
  entryRuleVerdict,
  evidenceKey,
  hitsText,
  momEntryPack,
  momScorePack,
  previewOrder,
  resolveEntries,
  type EntryDecision,
  type EntryHit,
  type PrevCourt,
  type ScoreRow,
} from '../ai/momEntry';
import { newRunId } from '../ai/pack';
import { monthlyCandidates, type Account, type Item, type MarketView, type MonthlyContext, type Notif } from '../engine';
import { isLastTradingDayOfMonth, nextTradingDay, type CalendarOverrides } from '../data/calendar';
import { buildMarketView } from '../data/marketView';
import { loadRanking, loadSeries, type Alert, type Ranking } from '../data/store';
import { errText } from '../data/util';
import type { ApplyCtx, StartCtx } from './aiCtx';
import { closeStaleRuns, getRun, startRun, type AiRun } from './aiRuns';
import type { Env, Fetcher } from './env';
import { loadEvents } from './filings';
import { requiredTickers } from './ledgerStore';
import { momEvidence, scanEventHits, type MomEvidence } from './momEvidence';
import { retryLookback, startLookback } from './momLookback';
import { routineReady } from './ownAi';

/** 月報訊號日 → 月報的月份。 */
export const monthOfSignal = (signal: string, ov: CalendarOverrides) => nextTradingDay(signal, ov).slice(0, 7);

// ---------------------------------------------------------------- mom_reviews

export interface MomReview {
  month: string;
  ticker: string;
  rank: number | null;
  decision: EntryDecision;
  reasonCode: string | null;
  source: 'RULE' | 'AI' | 'DEFAULT';
  hits: EntryHit[];
  runId: string | null;
  watchReason: string | null;
  liftCondition: string | null;
  replacedBy: string | null;
  note: string | null;
  /** 申報抓不到，這次沒有檢查申報類的失效模式（momentum_ai §3.3 表第 6 列）。 */
  dataMissing?: boolean;
  /** 證據指紋（§3.4）。 */
  evidenceKey?: string | null;
  /** 沿用哪一個月份的法庭結論（§3.4）。 */
  carriedFrom?: string | null;
  /** 這個月開了幾次法庭（§3.2：沒有結論時重開一次）。 */
  courtTries?: number;
  /** 月報當天才審的（§3.2）。 */
  late?: boolean;
  /** 月報之後才回來的否決（§3.3；decision 不改）。 */
  lateVerdict?: string | null;
  /** 晚到的否決已經安排補推（只一次）。 */
  lateTold?: boolean;
}

interface Row {
  month: string;
  ticker: string;
  rank: number | null;
  decision: string;
  reason_code: string | null;
  source: string;
  hits: string;
  run_id: string | null;
  watch_reason: string | null;
  lift_condition: string | null;
  replaced_by: string | null;
  note: string | null;
  data_missing?: number | null;
  evidence_key?: string | null;
  carried_from?: string | null;
  court_tries?: number | null;
  late?: number | null;
  late_verdict?: string | null;
  late_told?: number | null;
}
const toReview = (r: Row): MomReview => ({
  month: r.month,
  ticker: r.ticker,
  rank: r.rank,
  decision: r.decision as EntryDecision,
  reasonCode: r.reason_code,
  source: r.source as MomReview['source'],
  hits: JSON.parse(r.hits),
  runId: r.run_id,
  watchReason: r.watch_reason,
  liftCondition: r.lift_condition,
  replacedBy: r.replaced_by,
  note: r.note,
  dataMissing: !!r.data_missing,
  evidenceKey: r.evidence_key ?? null,
  carriedFrom: r.carried_from ?? null,
  courtTries: r.court_tries ?? 0,
  late: !!r.late,
  lateVerdict: r.late_verdict ?? null,
  lateTold: !!r.late_told,
});

export async function loadReviews(db: D1Database, month?: string): Promise<MomReview[]> {
  const q = month ? db.prepare('SELECT * FROM mom_reviews WHERE month = ? ORDER BY rank').bind(month) : db.prepare('SELECT * FROM mom_reviews ORDER BY month DESC, rank LIMIT 200');
  return (await q.all<Row>()).results.map(toReview);
}

type ReviewRow = Omit<MomReview, 'replacedBy'>;

function upsertStmt(db: D1Database, r: ReviewRow, at: string): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO mom_reviews (month, ticker, rank, decision, reason_code, source, hits, run_id, watch_reason, lift_condition, note, data_missing, evidence_key, carried_from, court_tries, late, late_verdict, late_told, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(month, ticker) DO UPDATE SET rank = excluded.rank, decision = excluded.decision, reason_code = excluded.reason_code, source = excluded.source, hits = excluded.hits, run_id = excluded.run_id, watch_reason = excluded.watch_reason, lift_condition = excluded.lift_condition, note = excluded.note, data_missing = excluded.data_missing, evidence_key = excluded.evidence_key, carried_from = excluded.carried_from, court_tries = excluded.court_tries, late = excluded.late, late_verdict = excluded.late_verdict, late_told = excluded.late_told, updated_at = excluded.updated_at`,
    )
    .bind(r.month, r.ticker, r.rank, r.decision, r.reasonCode, r.source, JSON.stringify(r.hits), r.runId, r.watchReason, null, r.note, r.dataMissing ? 1 : 0, r.evidenceKey ?? null, r.carriedFrom ?? null, r.courtTries ?? 0, r.late ? 1 : 0, r.lateVerdict ?? null, r.lateTold ? 1 : 0, at, at);
}

// ---------------------------------------------------------------- 規則偵測（舊的入口，網站與健檢用）

export interface EntryEvidence {
  hits: EntryHit[];
  /** 法庭要讀的原文。 */
  docs: PackDoc[];
  dataQuality: Record<string, 'ok' | 'partial' | 'missing'>;
  notes: string[];
  r12: number;
  /** 申報清單抓不到時的原因（呼叫端不能把它當成「沒有命中」，momentum_ai §3.1）。 */
  filingsMissing?: string;
}

/** 一檔候選的規則偵測（F1 ①～⑥）。T32b 起由 momEvidence 組（§3.1）；這裡留給健檢（F14）與 /admin/ai/entry。 */
export async function entryEvidence(env: Env, fetcher: Fetcher, view: MarketView, axis: string[], ticker: string, benchmark: string, withDocs: boolean): Promise<EntryEvidence> {
  const ev = await momEvidence(env, fetcher, view, axis, ticker, benchmark, { docs: withDocs, xbrlTable: false });
  return { hits: ev.hits, docs: ev.docs, dataQuality: ev.dataQuality, notes: ev.notes, r12: ev.r12, ...(ev.filingsMissing !== undefined ? { filingsMissing: ev.filingsMissing } : {}) };
}

// ---------------------------------------------------------------- 上一次有結論的法庭（§3.4）

interface PrevRow extends PrevCourt {
  decision: EntryDecision;
  reasonCode: string | null;
  watchReason: string | null;
  runId: string;
}

/**
 * 這一檔最近一列「source = AI、有 run_id、不是沿用的」mom_reviews（比這個月早的月份）。
 * 決策日取那次執行的決策日（run_id 的開頭）；月報之後才回來的否決算成否決。
 */
export async function prevCourt(db: D1Database, ticker: string, month: string): Promise<PrevRow | null> {
  const r = await db
    .prepare("SELECT * FROM mom_reviews WHERE ticker = ? AND month < ? AND source = 'AI' AND run_id IS NOT NULL AND carried_from IS NULL ORDER BY month DESC LIMIT 1")
    .bind(ticker, month)
    .first<Row>();
  if (!r || !r.run_id) return null;
  const day = /^\d{4}-\d{2}-\d{2}/.exec(r.run_id)?.[0] ?? (r as unknown as { updated_at: string }).updated_at.slice(0, 10);
  return { month: r.month, evidenceKey: r.evidence_key ?? null, decidedOn: day, decision: (r.late_verdict === 'VETO' ? 'VETO' : r.decision) as EntryDecision, reasonCode: r.reason_code, watchReason: r.watch_reason, runId: r.run_id };
}

/** 沿用上一次的結論（§3.4）：抄 decision、reason_code、watch_reason、run_id，source = AI，carried_from = 那個月份。 */
function carry(base: ReviewRow, prev: PrevRow, why: string): ReviewRow {
  return { ...base, decision: prev.decision, reasonCode: prev.reasonCode, watchReason: prev.watchReason, runId: prev.runId, source: 'AI', carriedFrom: prev.month, courtTries: 0, note: `沿用 ${prev.month} 的進場審查（${prev.runId}）：${why}` };
}

// ---------------------------------------------------------------- 審查

interface ReviewCtx {
  env: Env;
  fetcher: Fetcher;
  acct: Account;
  view: MarketView;
  axis: string[];
  ranking: Ranking;
  month: string;
  now: Date;
  /** 可以開法庭（雲端排程設定好了，而且不是在出月報之前）；false = 要法庭的照規則准許。 */
  court: boolean;
  /** 月報當天才審的（late = 1）。lateCourt：月報之後同一次流程會開法庭（雲端排程設定好了）。 */
  late?: boolean;
  lateCourt?: boolean;
  /** 月報已經出了：decision 不改（月報實際用的），只開法庭、記證據（§3.3「月報之後才回來的否決」）。 */
  afterReport?: boolean;
  log: string[];
  started: string[];
}

/** 月報當天才進榜、要法庭的：月報之後開（§3.2）。說明裡的這個記號讓 momLateStart、momRecheck 認得它。 */
export const LATE_COURT_MARK = '月報之後開法庭';
/** 月報之後要開法庭、還沒開的那一列。 */
export const awaitingLateCourt = (r: MomReview) => !!r.late && !r.runId && !r.carriedFrom && r.source === 'DEFAULT' && !r.dataMissing && !!r.evidenceKey && (r.note ?? '').includes(LATE_COURT_MARK);

const omitText = (ev: MomEvidence) => (ev.omitted.length ? `；略過 ${ev.omitted.length} 份：${ev.omitted.join('、')}` : '');

/** F1 用過的事件要收掉（§3.2，修 Q4）：這一檔用到的每日掃描或回看標的事件（NEW 的）標成 HANDLED。 */
function handledScanStmt(db: D1Database, ticker: string, hits: EntryHit[], note: string): D1PreparedStatement | null {
  const accs = [...new Set(hits.filter((h) => h.sub.startsWith('SCAN_') && h.accession).map((h) => h.accession!))];
  if (!accs.length) return null;
  return db
    .prepare(`UPDATE sec_events SET status = 'HANDLED', handled_note = ? WHERE ticker = ? AND status = 'NEW' AND source = 'SCAN' AND code IN ('ACCOUNTING', 'REGULATORY', 'PENDING_MA', 'GUIDANCE_CUT') AND accession IN (${accs.map(() => '?').join(',')})`)
    .bind(note, ticker, ...accs);
}

async function openCourt(rc: ReviewCtx, t: string, rank: number | null, ev: MomEvidence, detail: Record<string, unknown>): Promise<AiRun> {
  const { pack, notes } = momEntryPack({ view: rc.view, axis: rc.axis, ticker: t, rank: rank ?? 0, runId: newRunId(rc.view.date, MOM_ENTRY, t), hits: ev.hits, docs: ev.docs, dataQuality: ev.dataQuality, now: rc.now });
  pack.rule.detail = { ...(pack.rule.detail as object), month: rc.month, ...detail, ...(ev.omitted.length ? { omitted: ev.omitted } : {}) };
  const run = await startRun(rc.env, rc.fetcher, pack, rc.now, [...ev.notes, ...notes]);
  rc.started.push(run.runId);
  return run;
}

/**
 * 逐檔審查（§3.3 的表、§3.4 的沿用）。opt.force：已經有一列的也重審（momRecheck）；opt.retry：上一次法庭沒有結論、重開一次。
 * 已經開過法庭、指紋沒有變的（只多了新聞標題）不重開，只記下新的命中。
 */
async function review(rc: ReviewCtx, tickers: string[], existing: Map<string, MomReview>, opt: { force?: boolean; retry?: boolean } = {}): Promise<void> {
  const at = rc.now.toISOString();
  const db = rc.env.DB;
  for (const t of tickers) {
    const cur = existing.get(t);
    if (cur && !opt.force) continue;
    const rank = rc.ranking.order.indexOf(t) + 1 || cur?.rank || null;
    const ev = await momEvidence(rc.env, rc.fetcher, rc.view, rc.axis, t, rc.acct.cfg.coreTicker, { docs: rc.court, xbrlTable: false });
    const v = entryRuleVerdict(ev.hits, { filingsMissing: ev.filingsMissing });
    const key = evidenceKey(ev.hits);
    const omit = omitText(ev);
    // 同一次法庭、同一批證據（只多了新聞標題）：不重開
    if (cur?.runId && !opt.retry && (cur.evidenceKey ?? '') === key && v.decision === 'COURT') {
      const same: ReviewRow = { ...cur, hits: ev.hits };
      await upsertStmt(db, same, at).run();
      existing.set(t, { ...same, replacedBy: cur.replacedBy });
      continue;
    }
    const base: ReviewRow = {
      month: rc.month,
      ticker: t,
      rank,
      decision: 'ALLOW',
      reasonCode: null,
      source: 'RULE',
      hits: ev.hits,
      runId: null,
      watchReason: v.watchReason,
      liftCondition: null,
      note: `${v.note}${omit}`,
      dataMissing: false,
      evidenceKey: key || null,
      carriedFrom: null,
      courtTries: 0,
      late: rc.late ?? cur?.late ?? false,
      lateVerdict: cur?.lateVerdict ?? null,
      lateTold: cur?.lateTold ?? false,
    };
    const allow = (row: ReviewRow, note: string): ReviewRow => ({ ...row, decision: row.watchReason ? 'ALLOW_WATCH' : 'ALLOW', source: 'DEFAULT', note });
    let row: ReviewRow;
    let used = 'RULE';
    if (v.decision === 'VETO' || v.decision === 'BLOCK') row = { ...base, decision: v.decision, reasonCode: v.reasonCode };
    else {
      const prev = v.decision === 'COURT' || ev.filingsMissing !== undefined ? await prevCourt(db, t, rc.month) : null;
      const reasons = v.decision === 'COURT' ? entryNewEvidence(prev, { key, filings: ev.filings, asOf: rc.view.date }) : [];
      if (ev.filingsMissing !== undefined && prev) {
        // 申報抓不到的月份：有上一次的結論就沿用（狀態不動，G15）
        row = carry(base, prev, `申報抓不到（${ev.filingsMissing}），狀態不動`);
        used = `沿用 ${prev.runId}`;
      } else if (v.decision === 'COURT' && prev && !reasons.length && !opt.retry) {
        row = carry(base, prev, '之後沒有新的財報，命中沒有變');
        used = `沿用 ${prev.runId}`;
      } else if (v.decision === 'COURT' && rc.court) {
        const tries = opt.retry ? (cur?.courtTries || 1) + 1 : 1;
        try {
          const run = await openCourt(rc, t, rank, ev, { reasons: opt.retry ? ['RETRY'] : reasons, evidenceKey: key });
          row = { ...base, decision: 'PENDING', runId: run.runId, courtTries: tries, note: `${v.note}${opt.retry ? `；重開法庭（第 ${tries} 次）` : reasons.length ? `；重開的原因：${reasons.map((x) => NEW_EVIDENCE_TEXT[x] ?? x).join('、')}` : ''}${omit}` };
          used = run.runId;
        } catch (e) {
          row = prev ? carry(base, prev, `法庭沒有開成（${errText(e)}），不蓋掉上一次的結論`) : allow(base, `${v.note}；法庭沒有開成（${errText(e)}），照規則准許${omit}`);
        }
      } else if (v.decision === 'COURT' && rc.lateCourt) row = { ...allow(base, `${v.note}；${LATE_COURT_MARK}${omit}`), late: true };
      else if (v.decision === 'COURT') row = allow(base, `${v.note}；來不及開法庭（或雲端排程沒設定），照規則准許${omit}`);
      else row = { ...base, decision: v.decision as EntryDecision, reasonCode: v.reasonCode, ...(v.dataMissing ? { source: 'DEFAULT' as const, dataMissing: true } : {}) };
    }
    // 月報已經出了：decision 不改，只在開了法庭時記下法庭與證據
    if (rc.afterReport && cur) {
      if (row.decision !== 'PENDING') continue;
      row = { ...cur, hits: row.hits, evidenceKey: row.evidenceKey, runId: row.runId, courtTries: row.courtTries, note: row.note };
    }
    const stmts = [upsertStmt(db, row, at)];
    const h = handledScanStmt(db, t, ev.hits, `F1 ${rc.month}：${used}`);
    if (h) stmts.push(h);
    await db.batch(stmts);
    existing.set(t, { ...row, replacedBy: cur?.replacedBy ?? null });
    rc.log.push(`F1 ${t}（第 ${rank} 名）：${row.decision}${row.reasonCode ? ` ${row.reasonCode}` : ''}（${row.source}${row.carriedFrom ? `，沿用 ${row.carriedFrom}` : ''}）${ev.notes.length ? `；${ev.notes.join('；')}` : ''}`);
  }
}

const selectorOf = (acct: Account, view: MarketView, ranking: Ranking, month: string) => (vetoed: string[], emptySlots: number) => monthlyCandidates(acct, view, { order: ranking.order, month, company: ranking.detail.company, vetoed, emptySlots } satisfies MonthlyContext);

/** 月報前一天：先審這個月會進場的（加遞補者），開法庭（先看能不能沿用）；開進場前回看；開擬事件打分。 */
export async function momPreview(sc: StartCtx): Promise<void> {
  const { env, fetcher, acct, view, axis, session, ov, now, res } = sc;
  const signal = nextTradingDay(session, ov);
  if (!isLastTradingDayOfMonth(signal, ov)) return;
  const ranking = await loadRanking(env.DB, session);
  if (!ranking) return void res.log.push('F1：月報前一天沒有排名，不先審（月報當天會用規則偵測補審）');
  const month = monthOfSignal(signal, ov);
  const select = selectorOf(acct, view, ranking, month);
  const existing = new Map((await loadReviews(env.DB, month)).map((r) => [r.ticker, r]));
  const rc: ReviewCtx = { env, fetcher, acct, view, axis, ranking, month, now, court: routineReady(env), log: res.log, started: res.started };
  const first = select([], 0);
  await review(rc, first, existing);
  const risky = (t: string) => ['VETO', 'BLOCK', 'PENDING'].includes(existing.get(t)?.decision ?? '');
  const order = previewOrder(select, risky);
  await review(rc, order.filter((t) => !first.includes(t)), existing);
  if (!routineReady(env)) return;
  // 進場前回看（§3.2）：同一批對象
  try {
    await startLookback(sc, month, order);
  } catch (e) {
    res.log.push(`進場前回看沒有開成：${errText(e)}`);
  }
  // 擬事件打分：前 15 名（只記錄；T32d 拿掉）
  try {
    const rows: ScoreRow[] = [];
    for (const t of ranking.order.slice(0, 15)) {
      const r = existing.get(t);
      const hits = r?.hits ?? (await momEvidence(env, fetcher, view, axis, t, acct.cfg.coreTicker, { docs: false, xbrlTable: false })).hits;
      const c = view.close[t];
      rows.push({ ticker: t, rank: ranking.order.indexOf(t) + 1, r12: c && Number.isFinite(c[view.i - 252]) ? c[view.i] / c[view.i - 252] - 1 : NaN, hits });
    }
    const { pack, notes } = momScorePack({ runId: newRunId(session, MOM_SCORE), asOf: session, rows, docs: [], now });
    res.started.push((await startRun(env, fetcher, pack, now, notes)).runId);
  } catch (e) {
    res.log.push(`擬事件打分沒有開成：${errText(e)}`);
  }
}

// ---------------------------------------------------------------- 套用法庭的結論

/** 這個月這一檔的法庭，每次沒有結論的原因（告警與說明用）。 */
async function failReasons(db: D1Database, month: string, ticker: string): Promise<string[]> {
  const rows = (await db.prepare("SELECT outcome FROM ai_runs WHERE fn = ? AND ticker = ? AND status = 'DONE' AND json_extract(pack, '$.rule.detail.month') = ? ORDER BY created_at").bind(MOM_ENTRY, ticker, month).all<{ outcome: string | null }>()).results;
  return rows.map((r) => (r.outcome ? JSON.parse(r.outcome) : null)).filter((o) => courtFailed(o)).map((o) => courtFailWhy(o));
}

/** F1_COURT_FAILED 的文字（§3.3）。 */
export function courtFailedText(ticker: string, whys: string[], hits: EntryHit[]): string {
  return `${ticker} 的進場審查${whys.length > 1 ? `連續 ${whys.length} 次` : ''}沒有結論（${whys.join('、')}）。規則偵測命中：${hitsText(hits) || '（無）'}。月報照規則讓它進場；不想買可以在月報對 ${ticker} 按「排除」。`;
}

/** 法庭兩次都沒有結論（或月報時還沒有結論）：有上一次的結論就沿用（不能讓逾時蓋掉否決），沒有就照規則准許並告警。 */
async function resolveFailed(db: D1Database, cur: MomReview, alerts: Alert[] | undefined): Promise<ReviewRow> {
  const whys = await failReasons(db, cur.month, cur.ticker);
  const prev = await prevCourt(db, cur.ticker, cur.month);
  const what = `進場審查 ${whys.length || 1} 次沒有結論（${whys.join('、') || '還沒有結論'}）`;
  if (prev) return carry({ ...cur }, prev, `${what}，不蓋掉上一次的結論`);
  if (whys.length) alerts?.push({ kind: 'F1_COURT_FAILED', message: courtFailedText(cur.ticker, whys, cur.hits), detail: { ticker: cur.ticker, month: cur.month, whys } });
  return { ...cur, decision: cur.watchReason ? 'ALLOW_WATCH' : 'ALLOW', source: 'DEFAULT', note: `規則偵測命中：${hitsText(cur.hits)}；${what}，照規則進場` };
}

const firstSentence = (o: AiRun['outcome']): string => {
  const rep = o?.samples.find((s) => s.valid && s.verdict === 'VETO')?.report ?? '';
  const m = /^[^\n。]+。?/.exec(rep.trim());
  return m ? (m[0].endsWith('。') ? m[0] : m[0] + '。') : '';
};

/** 這個月份的月報（最新一份、沒有被取代的）與這一檔的 F1 項目。 */
function monthlyItem(acct: Account, month: string, ticker: string): { n: Notif; it: Item } | null {
  for (const n of [...acct.notifs].reverse()) {
    if (n.monthly?.input.month !== month || n.status === 'SUPERSEDED' || n.status === 'CANCELLED') continue;
    const it = n.items.find((i) => i.f === 'F1' && i.ticker === ticker && !i.cancelled);
    if (it) return { n, it };
  }
  return null;
}

const sumShares = (it: Item, choice: string, ticker: string) => (it.choices.find((c) => c.id === choice)?.lines ?? []).filter((l) => l.ticker === ticker).reduce((a, l) => a + l.shares, 0);

/**
 * 月報之後才回來的否決（§3.3）：decision 不改；mom_reviews 記 late_verdict、reason_code。月報那一項加 AI 那一行：
 *   還沒回覆 → LINE 補推一則（預設仍是照規則買進）；已回覆、還沒填快照 → 推一則提醒；已經填快照 → 只更新項目（「要看的事」的 LATE_VETO 在 T32d）
 * 補推只做一次（late_told）。影子紀錄寫一筆 LATE_VETO。
 */
function lateVeto(ctx: ApplyCtx, cur: MomReview, run: AiRun, code: string): void {
  const t = cur.ticker;
  const zh = ENTRY_CODE_TEXT[code] ?? code;
  const hit = monthlyItem(ctx.acct, cur.month, t);
  const note = `進場審查（3 票）在月報之後回來：否決（${zh}）。月報不改，預設仍是照規則買進`;
  ctx.stmts.push(upsertStmt(ctx.db, { ...cur, lateVerdict: 'VETO', reasonCode: code, source: 'AI', lateTold: !!hit, note }, ctx.now.toISOString()));
  if (!hit) return void ctx.log.push(`${run.runId}：${t} 的否決在月報之後回來（${zh}），月報裡沒有這一檔的進場項目，只記錄`);
  if (cur.lateTold) return void ctx.log.push(`${run.runId}：${t} 的晚到否決已經處理過`);
  const { n, it } = hit;
  const mm = `${Number(cur.month.slice(5))} 月月報 #${n.id}`;
  it.aiLine = `進場審查（3 票）在月報之後回來：否決（${zh}）。${firstSentence(run.outcome)}`.trim();
  it.runIds = [...new Set([...(it.runIds ?? []), run.runId])];
  n.runIds = [...new Set([...(n.runIds ?? []), run.runId])];
  const push =
    n.status === 'PENDING'
      ? `${t} 的進場審查回來了：3 票否決（${zh}）。${mm} 已更新，預設仍是照規則買進；要照否決，到網站對 ${t} 按「排除」。`
      : n.status === 'RESPONDED'
        ? `${t} 的進場審查回來了：3 票否決（${zh}）。你已經決定了；還沒下單的話可以回通知 #${n.id} 對 ${t} 按「排除」。`
        : undefined;
  it.lateVeto = { code, runId: run.runId, date: ctx.session, ...(push ? { push } : {}) };
  // 「進場審查進行中」的說明換掉；存著的說明拿掉，網站照現在的狀態重算（收合時那一行先講否決）
  it.note = `規則偵測命中：${hitsText(cur.hits) || '（無）'}；進場審查已經回來（見 AI 那一行）`;
  delete (it as Item & { x?: unknown }).x;
  const rule = sumShares(it, it.ruleChoice, t);
  const actual = n.status === 'PENDING' ? rule : sumShares(it, it.choice, t);
  const px = ctx.view.close[t]?.[ctx.view.i];
  ctx.acct.shadow.push({ date: ctx.session, f: 'F1', ticker: t, title: `${t} 進場審查在月報之後回來：否決`, rule, ai: 0, actual, price: Number.isFinite(px) ? px : 0, choice: 'LATE_VETO', note: n.status === 'PENDING' ? `${zh}；月報還沒回覆，回覆時另記一筆` : zh, notif: n.id, runIds: [run.runId] });
  ctx.log.push(`${run.runId}：${t} 的否決在月報之後回來（${zh}）→ 更新 ${mm}${push ? '，補推一則' : '（已經填快照，只更新項目）'}`);
}

/** 月報之後才回來的其他結論（准許、附註、沒有結論）：只更新 mom_reviews.note 與項目的說明，不推。 */
function lateUpdate(ctx: ApplyCtx, row: ReviewRow): void {
  ctx.stmts.push(upsertStmt(ctx.db, row, ctx.now.toISOString()));
  const hit = monthlyItem(ctx.acct, row.month, row.ticker);
  const note = entryNote(row);
  if (hit && note) {
    hit.it.note = note;
    delete (hit.it as Item & { x?: unknown }).x;
  }
}

/**
 * 法庭的結論 → mom_reviews（closeStaleRuns 關掉的執行也會進來）。
 *   月報之前（PENDING）：三票一致 → 照結論；票數不一致 → 有上一次的結論就沿用，沒有就照規則准許（不重開，重抽三票是雜訊）；
 *     沒有結論 → 還沒重開過就留著 PENDING（01:30 的 momRecheck 重開）；第 2 次也沒有 → 沿用上一次的結論，或照規則准許並推 F1_COURT_FAILED
 *   月報之後：三票否決 → 晚到的否決（lateVeto）；其他只更新說明
 */
export async function applyMomEntry(ctx: ApplyCtx, run: AiRun): Promise<void> {
  if (!run.outcome) return;
  const month = (run.pack.rule.detail as { month?: string })?.month;
  const t = run.ticker ?? '';
  if (!month) return;
  const o = run.outcome;
  const cur = (await loadReviews(ctx.db, month)).find((r) => r.ticker === t);
  if (!cur || cur.runId !== run.runId) return void ctx.log.push(`${run.runId}：${t} 的審查已經被取代，不套用`);
  const at = ctx.now.toISOString();
  const v = courtVerdict(o);
  const omit = /；略過 \d+ 份：[^；]*/.exec(cur.note ?? '')?.[0] ?? '';
  if (cur.decision === 'PENDING') {
    let row: ReviewRow;
    if (courtConcluded(o) && v.source === 'AI') row = { ...cur, decision: v.decision, source: 'AI', reasonCode: v.reasonCode, watchReason: v.watchReason ?? cur.watchReason, note: `${v.note}${omit}` };
    else if (!courtFailed(o)) {
      const prev = await prevCourt(ctx.db, t, month);
      row = prev ? carry({ ...cur }, prev, `這次法庭沒有一致的結論（${v.note}），不蓋掉上一次的結論`) : { ...cur, decision: cur.watchReason ? 'ALLOW_WATCH' : 'ALLOW', source: 'DEFAULT', note: `${v.note}${omit}` };
    } else if ((cur.courtTries || 1) < 2) {
      ctx.stmts.push(upsertStmt(ctx.db, { ...cur, note: `${cur.note ?? ''}；第 ${cur.courtTries || 1} 次法庭沒有結論（${courtFailWhy(o)}），下一次流程重開` }, at));
      return void ctx.log.push(`${run.runId}：${t} 的進場審查沒有結論（${courtFailWhy(o)}），留著等重開`);
    } else row = await resolveFailed(ctx.db, cur, (ctx.alerts ??= []));
    ctx.stmts.push(upsertStmt(ctx.db, row, at));
    return void ctx.log.push(`${run.runId}：${t} → ${row.decision}${row.reasonCode ? ` ${row.reasonCode}` : ''}（${row.source}${row.carriedFrom ? `，沿用 ${row.carriedFrom}` : ''}）`);
  }
  // 月報已經出了（月報當天才進榜的、第一次流程失敗由第二次補做的月份）：否決降成建議
  if (courtConcluded(o) && v.decision === 'VETO' && v.source === 'AI' && v.reasonCode) return lateVeto(ctx, cur, run, v.reasonCode);
  if (courtConcluded(o) && v.source === 'AI') {
    lateUpdate(ctx, { ...cur, source: 'AI', watchReason: v.watchReason ?? cur.watchReason, note: `進場審查在月報之後回來：${v.decision === 'ALLOW_WATCH' ? '准許，附註' : '准許'}。${v.note}${omit}` });
    return void ctx.log.push(`${run.runId}：${t} 的進場審查在月報之後回來（${v.decision}），只更新說明`);
  }
  const whys = courtFailed(o) ? await failReasons(ctx.db, month, t) : [];
  const again = courtFailed(o) && (cur.courtTries || 1) < 2;
  const what = courtFailed(o) ? `進場審查 ${whys.length || 1} 次沒有結論（${whys.join('、') || courtFailWhy(o)}）${again ? '，下一次流程重開' : ''}` : `進場審查沒有一致的結論（${v.note}）`;
  lateUpdate(ctx, { ...cur, note: `規則偵測命中：${hitsText(cur.hits)}；${what}，照規則進場${omit}` });
  ctx.log.push(`${run.runId}：${t} 的進場審查在月報之後回來，沒有結論（${what}）`);
}

// ---------------------------------------------------------------- 01:30 與月報之後

/** 01:30（finalStarts）、月報前一天與訊號日：重開沒有結論的法庭、回看帶來新命中的開法庭、重跑抓不到申報的（§3.2 的表）。 */
export async function momRecheck(sc: StartCtx): Promise<void> {
  const { env, fetcher, acct, view, axis, session, ov, now, res } = sc;
  const signalDay = isLastTradingDayOfMonth(session, ov);
  const dayBefore = isLastTradingDayOfMonth(nextTradingDay(session, ov), ov);
  if (!signalDay && !dayBefore) return;
  const month = monthOfSignal(signalDay ? session : nextTradingDay(session, ov), ov);
  // 回看沒有合格結論 → 重開一次
  await retryLookback(sc, month);
  const ranking = (await loadRanking(env.DB, session)) ?? (await loadRanking(env.DB));
  if (!ranking) return;
  const rows = (await loadReviews(env.DB, month)).filter((r) => (signalDay ? r.late : true));
  const existing = new Map(rows.map((r) => [r.ticker, r]));
  const rc: ReviewCtx = { env, fetcher, acct, view, axis, ranking, month, now, court: true, afterReport: signalDay, log: res.log, started: res.started };
  for (const r of rows) {
    const run = r.runId && !r.carriedFrom ? await getRun(env.DB, r.runId) : null;
    const awaiting = r.decision === 'PENDING' || (r.late && r.source === 'DEFAULT');
    if (run && run.status === 'DONE' && courtFailed(run.outcome) && awaiting && (r.courtTries || 1) < 2) {
      res.log.push(`F1 ${r.ticker}：法庭沒有結論（${courtFailWhy(run.outcome)}）→ 重開一次`);
      await review(rc, [r.ticker], existing, { force: true, retry: true });
      continue;
    }
    if (awaitingLateCourt(r) || r.dataMissing) {
      await review(rc, [r.ticker], existing, { force: true });
      continue;
    }
    if (r.source === 'RULE' && (r.decision === 'VETO' || r.decision === 'BLOCK')) continue;
    // 回看（或每日掃描）帶來新的命中 → 重審（指紋變了才重開法庭）
    const since = new Date(Date.parse(view.date) - 365 * 86400_000).toISOString().slice(0, 10);
    const fresh = scanEventHits(await loadEvents(env.DB, { ticker: r.ticker, since }), view.date).filter((h) => !r.hits.some((x) => x.code === h.code && x.sub === h.sub && x.accession === h.accession));
    if (fresh.length) {
      res.log.push(`F1 ${r.ticker}：回看帶來新的命中（${fresh.map((h) => h.sub).join('、')}）→ 重審`);
      await review(rc, [r.ticker], existing, { force: true });
    }
  }
}

/** 月報訊號日、月報之後同一次流程（aiStep 第 3 段）：月報當天才進榜、要法庭的開法庭，月報當天審的開回看（§3.2 第 2 步）。 */
export async function momLateStart(sc: StartCtx): Promise<void> {
  const { env, fetcher, acct, view, axis, session, ov, now, res } = sc;
  if (!isLastTradingDayOfMonth(session, ov)) return;
  const month = monthOfSignal(session, ov);
  const rows = (await loadReviews(env.DB, month)).filter((r) => r.late);
  if (!rows.length) return;
  const ranking = (await loadRanking(env.DB, session)) ?? (await loadRanking(env.DB));
  if (!ranking) return;
  const existing = new Map(rows.map((r) => [r.ticker, r]));
  const rc: ReviewCtx = { env, fetcher, acct, view, axis, ranking, month, now, court: true, afterReport: true, log: res.log, started: res.started };
  const want = rows.filter(awaitingLateCourt).map((r) => r.ticker);
  if (want.length) await review(rc, want, existing, { force: true });
  try {
    await startLookback(sc, month, rows.map((r) => r.ticker));
  } catch (e) {
    res.log.push(`進場前回看（月報當天才進榜的）沒有開成：${errText(e)}`);
  }
}

// ---------------------------------------------------------------- 月報當天

export interface MonthInputs {
  vetoed?: string[];
  emptySlots?: number;
  /** 每個 F1 項目的說明（§3.3 的 entryNote）。 */
  entryNotes?: Record<string, string>;
  /** 沿用之前審查的否決：代號 → 月份（遞補者的說明加「（沿用 … 的審查）」）。 */
  vetoCarried?: Record<string, string>;
  /** 崩盤規則檢視的狀態（core_ai §3.2，T33b 起取代 crashOpinion）。 */
  crashReview?: MonthlyContext['crashReview'];
  notes?: string[];
  /** 這些輸入來自哪幾次 AI 執行（T13：月報的項目與通知帶 run_id）。 */
  runIds?: MonthlyContext['runIds'];
}

/** 本月審查過、由 AI 執行下結論（或還在等）的代號 → run_id。 */
const entryRunIds = (rows: Iterable<{ ticker: string; runId: string | null }>) => Object.fromEntries([...rows].filter((r) => r.runId).map((r) => [r.ticker, r.runId!]));

/**
 * 出月報之前先套用已經完成、還沒套用的這個月的 F1 法庭（momentum_ai §3.3「先套用再出月報」，修 Q7）：
 * 先關掉逾時的執行，再把 MOM_ENTRY 的結論寫進 mom_reviews、標 applied_at。這裡不改帳戶，所以只處理這個月的（還在 PENDING 的）。
 */
async function applyFinishedEntries(db: D1Database, acct: Account, view: MarketView, axis: string[], session: string, month: string, now: Date, log: string[], alerts: Alert[]): Promise<void> {
  await closeStaleRuns(db, now);
  const done = (await db.prepare("SELECT run_id FROM ai_runs WHERE fn = ? AND status = 'DONE' AND applied_at IS NULL AND json_extract(pack, '$.rule.detail.month') = ? ORDER BY completed_at").bind(MOM_ENTRY, month).all<{ run_id: string }>()).results;
  if (!done.length) return;
  const ctx: ApplyCtx = { db, acct, view, axis, session, now, stmts: [], log, alerts };
  for (const { run_id } of done) {
    const run = await getRun(db, run_id);
    if (!run) continue;
    ctx.stmts.push(db.prepare('UPDATE ai_runs SET applied_at = ? WHERE run_id = ?').bind(now.toISOString(), run_id));
    await applyMomEntry(ctx, run);
    // 同一次裡後面的執行要看到前面寫的結果
    await db.batch(ctx.stmts);
    ctx.stmts = [];
  }
}

/**
 * 出月報之前（每日流程，網路可用）：用訊號日的排名決定否決與遞補。
 * 法庭還沒有結論的照規則准許（2 次都沒有結論 → 告警）；還沒審過的跑規則偵測，要法庭的先照規則准許、月報之後開（late）。
 * side.alerts：F1_COURT_FAILED 放這裡（和流程的告警一起存）。
 */
export async function prepareEntries(env: Env, fetcher: Fetcher, acct: Account, signal: string, ov: CalendarOverrides, now: Date, log: string[], side: { alerts?: Alert[] } = {}): Promise<MonthInputs> {
  const ranking = await loadRanking(env.DB, signal);
  if (!ranking) return {};
  const month = monthOfSignal(signal, ov);
  const alerts = side.alerts ?? [];
  const series = await loadSeries(env.DB, [...new Set([...requiredTickers(acct), ...ranking.order])]);
  const { view, axis } = buildMarketView(series, signal, acct.cfg.coreTicker);
  const select = selectorOf(acct, view, ranking, month);
  await applyFinishedEntries(env.DB, acct, view, axis, signal, month, now, log, alerts);
  const existing = new Map((await loadReviews(env.DB, month)).map((r) => [r.ticker, r]));
  const at = now.toISOString();
  // 法庭還沒有結論 → 照規則准許（跑過但沒有結論的：有上一次的結論就沿用，沒有就告警）
  for (const r of existing.values()) {
    if (r.decision !== 'PENDING') continue;
    const run = r.runId ? await getRun(env.DB, r.runId) : null;
    const row: ReviewRow = run && run.status === 'DONE' && courtFailed(run.outcome) ? await resolveFailed(env.DB, r, alerts) : { ...r, decision: r.watchReason ? 'ALLOW_WATCH' : 'ALLOW', source: 'DEFAULT', note: `${r.note ?? ''}；月報時法庭還沒有結論，照規則准許`.replace(/^；/, '') };
    await upsertStmt(env.DB, row, at).run();
    existing.set(r.ticker, { ...row, replacedBy: r.replacedBy });
  }
  const rc: ReviewCtx = { env, fetcher, acct, view, axis, ranking, month, now, court: false, late: true, lateCourt: routineReady(env), log, started: [] };
  const finish = (res: { vetoed: string[]; emptySlots: number }): MonthInputs => {
    const entryNotes: Record<string, string> = {};
    const vetoCarried: Record<string, string> = {};
    for (const r of existing.values()) {
      const n = entryNote(r, { running: awaitingLateCourt(r) });
      if (n) entryNotes[r.ticker] = n;
      if (r.decision === 'VETO' && r.carriedFrom) vetoCarried[r.ticker] = r.carriedFrom;
    }
    const entry = entryRunIds(existing.values());
    return { vetoed: res.vetoed, emptySlots: res.emptySlots, entryNotes, ...(Object.keys(vetoCarried).length ? { vetoCarried } : {}), ...(Object.keys(entry).length ? { runIds: { entry } } : {}) };
  };
  for (let k = 0; k < 6; k++) {
    const res = resolveEntries(select, new Map([...existing].map(([t, r]) => [t, r.decision])));
    if (!res.need.length) return finish(res);
    await review(rc, res.need, existing);
  }
  log.push('F1：遞補的審查超過 6 輪，照目前的結果');
  return finish(resolveEntries(select, new Map([...existing].map(([t, r]) => [t, r.decision === 'PENDING' ? 'ALLOW' : r.decision]))));
}

/** 月報出了之後：被否決的記下由誰遞補（往前驗證「沒否決時的組合」用）。 */
export async function recordReplacements(db: D1Database, month: string, added: string[]): Promise<void> {
  const rows = (await loadReviews(db, month)).filter((r) => r.decision === 'VETO' || r.decision === 'BLOCK');
  const fresh = added.filter((t) => !rows.some((r) => r.ticker === t));
  for (const [k, r] of rows.entries()) {
    const by = fresh[k] ?? '（留在核心）';
    await db.prepare('UPDATE mom_reviews SET replaced_by = ? WHERE month = ? AND ticker = ?').bind(by, month, r.ticker).run();
  }
}

/** 給 flow 用：這幾個交易日裡是月報訊號日的，回傳訊號日。 */
export const signalsIn = (sessions: string[], ov: CalendarOverrides) => sessions.filter((s) => isLastTradingDayOfMonth(s, ov));
