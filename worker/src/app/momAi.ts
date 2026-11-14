// T11：F1 動能新股進場（否決法庭）的排程端（設計 §6.2、§2.4；ai_layer F1 卡片）。
//
//   月報前一天（當月倒數第二個交易日）：用當天的排名找出這個月會進場的股票（加上「被否決時的遞補者」），
//     逐檔跑規則偵測（EDGAR、價格、XBRL 的小檔）→ 規則能下結論的直接記下；要法庭的開 MOM_ENTRY（3 票）。
//     同一天開一次擬事件打分（前 15 名，MOM_SCORE，只記錄）。
//   月報當天（prepareMonthEnd，在出月報之前）：用當天的排名重算；還沒審過的跑規則偵測（來不及開法庭的照規則准許），
//     法庭還沒回來的照規則准許。結果 → 月報的 vetoed、emptySlots、觀察理由。
// 結果存在 mom_reviews（一個月一檔一列），網站與往前驗證用。
import { earningsDivergence, epsQuarters, jumpMetrics, oneOffJump, shareGrowth, suspectMoves } from '../ai/detect';
import type { PackDoc } from '../ai/check';
import { MOM_ENTRY, MOM_SCORE, courtVerdict, entryRuleVerdict, momEntryPack, momScorePack, previewOrder, resolveEntries, type EntryDecision, type EntryHit, type ScoreRow } from '../ai/momEntry';
import { newRunId } from '../ai/pack';
import { monthlyCandidates, type Account, type MarketView, type MonthlyContext } from '../engine';
import { isLastTradingDayOfMonth, nextTradingDay, type CalendarOverrides } from '../data/calendar';
import { fetchFilingDoc } from '../data/edgar';
import { activeHits, classifyFilings, fetchConcept, needsCover, quickHits, type FilingHit } from '../data/secEvents';
import { buildMarketView } from '../data/marketView';
import { fetchEdgarSubmissions, type Filing } from '../data/sources';
import { loadRanking, loadSeries, type Ranking } from '../data/store';
import { errText } from '../data/util';
import type { ApplyCtx, StartCtx } from './aiCtx';
import { startRun, type AiRun } from './aiRuns';
import type { Env, Fetcher } from './env';
import { cikFor, loadEvents } from './filings';
import { requiredTickers } from './ledgerStore';
import { docOf, newsDoc, routineReady } from './ownAi';


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
}
const toReview = (r: Row): MomReview => ({ month: r.month, ticker: r.ticker, rank: r.rank, decision: r.decision as EntryDecision, reasonCode: r.reason_code, source: r.source as MomReview['source'], hits: JSON.parse(r.hits), runId: r.run_id, watchReason: r.watch_reason, liftCondition: r.lift_condition, replacedBy: r.replaced_by, note: r.note });

export async function loadReviews(db: D1Database, month?: string): Promise<MomReview[]> {
  const q = month ? db.prepare('SELECT * FROM mom_reviews WHERE month = ? ORDER BY rank').bind(month) : db.prepare('SELECT * FROM mom_reviews ORDER BY month DESC, rank LIMIT 200');
  return (await q.all<Row>()).results.map(toReview);
}

function upsertStmt(db: D1Database, r: Omit<MomReview, 'replacedBy'>, at: string): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO mom_reviews (month, ticker, rank, decision, reason_code, source, hits, run_id, watch_reason, lift_condition, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(month, ticker) DO UPDATE SET rank = excluded.rank, decision = excluded.decision, reason_code = excluded.reason_code, source = excluded.source, hits = excluded.hits, run_id = excluded.run_id, watch_reason = excluded.watch_reason, lift_condition = excluded.lift_condition, note = excluded.note, updated_at = excluded.updated_at`,
    )
    .bind(r.month, r.ticker, r.rank, r.decision, r.reasonCode, r.source, JSON.stringify(r.hits), r.runId, r.watchReason, r.liftCondition, r.note, at, at);
}

// ---------------------------------------------------------------- 規則偵測

export interface EntryEvidence {
  hits: EntryHit[];
  /** 法庭要讀的原文。 */
  docs: PackDoc[];
  dataQuality: Record<string, 'ok' | 'partial' | 'missing'>;
  notes: string[];
  r12: number;
}

const toEntryHit = (h: FilingHit): EntryHit => ({ code: h.code, sub: h.sub, detail: h.detail ?? h.sub, date: h.date, byRule: h.byRule, displayOnly: h.displayOnly, accession: h.accession });

/**
 * 一檔候選的規則偵測（F1 ①～⑥）：被收購方、NT、4.02、會計師辭任、增資（申報，有效期間內）；單日漲幅占比；
 * 盈餘背離（稀釋 EPS，companyconcept）；股數 6 個月增加；資料可疑；每日掃描標記過的監管或會計候選（30 天內）。
 * withDocs：要開法庭時順便抓原文。
 */
export async function entryEvidence(env: Env, fetcher: Fetcher, view: MarketView, axis: string[], ticker: string, benchmark: string, withDocs: boolean): Promise<EntryEvidence> {
  const ua = env.EDGAR_USER_AGENT ?? '';
  const asOf = view.date;
  const out: EntryEvidence = { hits: [], docs: [], dataQuality: {}, notes: [], r12: NaN };
  const c = view.close[ticker];
  const jm = c && view.close[benchmark] ? jumpMetrics(c, view.close[benchmark], view.i) : null;
  out.r12 = jm?.r12 ?? NaN;
  const jump = oneOffJump(jm);
  if (jump?.hit) out.hits.push({ code: 'ONE_OFF_JUMP', sub: 'JUMP_SHARE', detail: jump.detail, byRule: false });
  let filings: Filing[] = [];
  let cik: string | null = null;
  try {
    cik = await cikFor(env, fetcher, ticker);
    if (!cik || !ua) throw new Error(cik ? '沒有設定 EDGAR 的 User-Agent' : '找不到 CIK');
    const sub = await fetchEdgarSubmissions(fetcher, cik, ua);
    const since = new Date(Date.parse(asOf) - 365 * 86400_000).toISOString().slice(0, 10);
    filings = sub.filings.filter((f) => f.filingDate <= asOf && f.filingDate >= since);
    const want = filings.filter((f) => quickHits(f).length || needsCover(f));
    const hits = activeHits(await classifyFilings(fetcher, cik, [sub.name, ...sub.formerNames], want, ua, out.notes), asOf);
    out.hits.push(...hits.filter((h) => !(h.displayOnly && h.code !== 'DILUTION')).map(toEntryHit));
    out.dataQuality.filings = 'ok';
  } catch (e) {
    out.notes.push(`申報：${errText(e)}`);
    out.dataQuality.filings = 'missing';
  }
  if (c) {
    const sus = suspectMoves(c, axis, view.i, filings.map((f) => f.filingDate));
    if (sus.length) out.hits.push({ code: 'DATA_SUSPECT', sub: 'PRICE_JUMP_NO_FILING', detail: `日變動超過 25%、前後一天沒有申報：${sus.join('、')}`, byRule: true });
  }
  if (cik && ua) {
    try {
      const qs = epsQuarters(await fetchConcept(fetcher, cik, 'us-gaap', 'EarningsPerShareDiluted', ua), asOf);
      const d = earningsDivergence(qs, out.r12);
      if (d?.hit) out.hits.push({ code: 'EARNINGS_DIVERGENCE', sub: 'EPS_DOWN_PRICE_UP', detail: d.detail, byRule: false });
      if (qs.length) out.docs.push({ id: `E-${ticker}`, source_id: `xbrl:${ticker}:eps`, kind: 'xbrl', date: qs[0].filed, title: `${ticker} 稀釋 EPS（XBRL，每期最早申報的值）`, text: qs.map((q) => `${q.end} EPS diluted ${q.eps.toFixed(2)} (filed ${q.filed}${q.derived ? ', Q4 derived = annual - 9M' : ''})`).join('\n') });
      out.dataQuality.xbrl = 'ok';
    } catch (e) {
      out.notes.push(`EPS：${errText(e)}`);
      out.dataQuality.xbrl = 'missing';
    }
    try {
      const g = shareGrowth(await fetchConcept(fetcher, cik, 'dei', 'EntityCommonStockSharesOutstanding', ua), asOf);
      if (g && g.growth > 0.05) out.hits.push({ code: 'DILUTION', sub: 'SHARES_6M', detail: `流通股數 6 個月增加 ${(g.growth * 100).toFixed(1)}%`, byRule: true, displayOnly: true });
    } catch (e) {
      out.notes.push(`股數：${errText(e)}`);
    }
  }
  const since30 = new Date(Date.parse(asOf) - 30 * 86400_000).toISOString().slice(0, 10);
  for (const e of (await loadEvents(env.DB, { ticker, since: since30 })).filter((x) => x.source === 'SCAN' && ['REGULATORY', 'ACCOUNTING', 'PENDING_MA'].includes(x.code))) out.hits.push({ code: e.code, sub: e.sub, detail: e.detail ?? e.sub, date: e.event_date, byRule: false, accession: e.accession });
  if (withDocs && cik && ua) {
    const accs = [...new Set(out.hits.filter((h) => h.accession && !h.accession.includes(':')).map((h) => h.accession!))];
    const pr = filings.find((f) => f.form.startsWith('8-K') && f.items.includes('2.02'));
    for (const f of [...filings.filter((x) => accs.includes(x.accession)), ...(pr && out.hits.some((h) => h.code === 'EARNINGS_DIVERGENCE') ? [pr] : [])].slice(0, 4)) {
      try {
        if (!out.docs.some((d) => d.source_id === `edgar:${f.accession}`)) out.docs.push(docOf(await fetchFilingDoc(fetcher, cik, f, ua)));
      } catch (e) {
        out.notes.push(`${f.form} ${f.accession} 抓不到：${errText(e)}`);
      }
    }
    try {
      const n = await newsDoc(fetcher, ticker, asOf);
      if (n) out.docs.push(n);
    } catch {
      // 新聞只有標題，抓不到不擋
    }
    out.dataQuality.news = 'partial';
  }
  return out;
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
  /** 可以開法庭（月報前一天、雲端排程設定好了）；false = 要法庭的照規則准許。 */
  court: boolean;
  log: string[];
  started: string[];
}

/** 逐檔審查還沒有結論的候選。 */
async function review(rc: ReviewCtx, tickers: string[], existing: Map<string, MomReview>): Promise<void> {
  const at = rc.now.toISOString();
  for (const t of tickers) {
    if (existing.has(t)) continue;
    const rank = rc.ranking.order.indexOf(t) + 1 || null;
    const ev = await entryEvidence(rc.env, rc.fetcher, rc.view, rc.axis, t, rc.acct.cfg.coreTicker, rc.court);
    const v = entryRuleVerdict(ev.hits);
    let row: Omit<MomReview, 'replacedBy'> = { month: rc.month, ticker: t, rank, decision: 'ALLOW', reasonCode: null, source: 'RULE', hits: ev.hits, runId: null, watchReason: v.watchReason, liftCondition: null, note: v.note };
    if (v.decision === 'COURT') {
      if (rc.court) {
        try {
          const { pack, notes } = momEntryPack({ view: rc.view, axis: rc.axis, ticker: t, rank: rank ?? 0, runId: newRunId(rc.view.date, MOM_ENTRY, t), hits: ev.hits, docs: ev.docs, dataQuality: ev.dataQuality, now: rc.now });
          pack.rule.detail = { ...(pack.rule.detail as object), month: rc.month };
          const run = await startRun(rc.env, rc.fetcher, pack, rc.now, [...ev.notes, ...notes]);
          rc.started.push(run.runId);
          row = { ...row, decision: 'PENDING', runId: run.runId, note: v.note };
        } catch (e) {
          row = { ...row, decision: v.watchReason ? 'ALLOW_WATCH' : 'ALLOW', source: 'DEFAULT', note: `${v.note}；法庭沒有開成（${errText(e)}），照規則准許` };
        }
      } else row = { ...row, decision: v.watchReason ? 'ALLOW_WATCH' : 'ALLOW', source: 'DEFAULT', note: `${v.note}；來不及開法庭（或雲端排程沒設定），照規則准許` };
    } else row = { ...row, decision: v.decision, reasonCode: v.reasonCode };
    await upsertStmt(rc.env.DB, row, at).run();
    existing.set(t, { ...row, replacedBy: null });
    rc.log.push(`F1 ${t}（第 ${rank} 名）：${row.decision}${row.reasonCode ? ` ${row.reasonCode}` : ''}（${row.source}）${ev.notes.length ? `；${ev.notes.join('；')}` : ''}`);
  }
}

const selectorOf = (acct: Account, view: MarketView, ranking: Ranking, month: string) => (vetoed: string[], emptySlots: number) => monthlyCandidates(acct, view, { order: ranking.order, month, company: ranking.detail.company, vetoed, emptySlots } satisfies MonthlyContext);

/** 月報前一天：先審這個月會進場的（加遞補者），開法庭；開擬事件打分。 */
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
  await review(rc, previewOrder(select, risky).filter((t) => !first.includes(t)), existing);
  // 擬事件打分：前 15 名（只記錄）
  if (!routineReady(env)) return;
  try {
    const rows: ScoreRow[] = [];
    for (const t of ranking.order.slice(0, 15)) {
      const r = existing.get(t);
      const hits = r?.hits ?? (await entryEvidence(env, fetcher, view, axis, t, acct.cfg.coreTicker, false)).hits;
      const c = view.close[t];
      rows.push({ ticker: t, rank: ranking.order.indexOf(t) + 1, r12: c && Number.isFinite(c[view.i - 252]) ? c[view.i] / c[view.i - 252] - 1 : NaN, hits });
    }
    const { pack, notes } = momScorePack({ runId: newRunId(session, MOM_SCORE), asOf: session, rows, docs: [], now });
    res.started.push((await startRun(env, fetcher, pack, now, notes)).runId);
  } catch (e) {
    res.log.push(`擬事件打分沒有開成：${errText(e)}`);
  }
}

/** 法庭的結論 → mom_reviews。 */
export async function applyMomEntry(ctx: ApplyCtx, run: AiRun): Promise<void> {
  if (!run.outcome) return;
  const month = (run.pack.rule.detail as { month?: string })?.month;
  const t = run.ticker ?? '';
  if (!month) return;
  const v = courtVerdict(run.outcome);
  const cur = (await loadReviews(ctx.db, month)).find((r) => r.ticker === t);
  if (!cur || cur.runId !== run.runId) return void ctx.log.push(`${run.runId}：${t} 的審查已經被取代，不套用`);
  if (cur.decision !== 'PENDING') return void ctx.log.push(`${run.runId}：${t} 的月報已經出了（${cur.decision}），法庭結論只記錄：${v.decision}`);
  ctx.stmts.push(upsertStmt(ctx.db, { ...cur, decision: v.decision, source: v.source, reasonCode: v.reasonCode, watchReason: v.watchReason ?? cur.watchReason, liftCondition: v.liftCondition, note: v.note }, ctx.now.toISOString()));
  ctx.log.push(`${run.runId}：${t} → ${v.decision}${v.reasonCode ? ` ${v.reasonCode}` : ''}（${v.source}）`);
}

// ---------------------------------------------------------------- 月報當天

export interface MonthInputs {
  vetoed?: string[];
  emptySlots?: number;
  watch?: Record<string, string>;
  crashOpinion?: '照做' | '延後';
  notes?: string[];
}

/**
 * 出月報之前（每日流程，網路可用）：用訊號日的排名決定否決與遞補。
 * 還沒審過的跑規則偵測（不開法庭）；法庭還沒回來的照規則准許（並記下）。
 */
export async function prepareEntries(env: Env, fetcher: Fetcher, acct: Account, signal: string, ov: CalendarOverrides, now: Date, log: string[]): Promise<MonthInputs> {
  const ranking = await loadRanking(env.DB, signal);
  if (!ranking) return {};
  const month = monthOfSignal(signal, ov);
  const series = await loadSeries(env.DB, [...new Set([...requiredTickers(acct), ...ranking.order])]);
  const { view, axis } = buildMarketView(series, signal, acct.cfg.coreTicker);
  const select = selectorOf(acct, view, ranking, month);
  const existing = new Map((await loadReviews(env.DB, month)).map((r) => [r.ticker, r]));
  const at = now.toISOString();
  // 法庭還沒回來 → 照規則准許
  for (const r of existing.values()) {
    if (r.decision !== 'PENDING') continue;
    const row = { ...r, decision: (r.watchReason ? 'ALLOW_WATCH' : 'ALLOW') as EntryDecision, source: 'DEFAULT' as const, note: `${r.note ?? ''}；月報時法庭還沒有結論，照規則准許`.replace(/^；/, '') };
    await upsertStmt(env.DB, row, at).run();
    existing.set(r.ticker, row);
  }
  const rc: ReviewCtx = { env, fetcher, acct, view, axis, ranking, month, now, court: false, log, started: [] };
  for (let k = 0; k < 6; k++) {
    const res = resolveEntries(select, new Map([...existing].map(([t, r]) => [t, r.decision])));
    if (!res.need.length) {
      const watch: Record<string, string> = {};
      for (const r of existing.values()) if (r.decision === 'ALLOW_WATCH' && r.watchReason) watch[r.ticker] = r.watchReason;
      return { vetoed: res.vetoed, emptySlots: res.emptySlots, watch };
    }
    await review(rc, res.need, existing);
  }
  log.push('F1：遞補的審查超過 6 輪，照目前的結果');
  const res = resolveEntries(select, new Map([...existing].map(([t, r]) => [t, r.decision === 'PENDING' ? 'ALLOW' : r.decision])));
  return { vetoed: res.vetoed, emptySlots: res.emptySlots };
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
