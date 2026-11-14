// T10：F24 自選定期審查、F25 自選條件監測，接進每日流程。
//
// 每日流程（src/app/flow.ts）每次都會呼叫 aiStep：
//   1. 套用已經有結論、還沒套用的 AI 執行：F24 → 引擎記下檔位（月報並列建議）＋替換監測條件；F25 → 條件成立的當天通知
//   2. 這次有處理新的交易日時（startNew）：
//      a. 每檔自選看 EDGAR 有沒有新申報（第一次只記下最新的一筆，不追溯）
//         新的 10-Q／10-K → 財報條件由程式直接比對 XBRL（不用 LLM）；降級條件成立 → 當天通知
//         新申報是事件條件指定的確認來源 → 開一次 F25 執行（AI 讀申報原文判斷）
//         新的財報（10-Q、10-K、8-K 2.02）→ 開一次 F24（財報後的審查）
//      b. 月報前一天（當月倒數第二個交易日）→ 每檔自選開一次 F24（月報那天用它的結論）
// 雲端排程（ROUTINE_FIRE_URL／ROUTINE_TOKEN）還沒設定時不開新的執行；EDGAR 的 User-Agent 沒設定時不看申報。
import type { PackDoc } from '../ai/check';
import { OWN_CONDITION, OWN_REVIEW, conditionDecision, conditionPack, ownReviewPack, reviewDecision, type ConditionDraft, type OwnCondition } from '../ai/ownReview';
import { newRunId } from '../ai/pack';
import { TIER_NAME, conditionMet, recordAiTier, type Account, type MarketView, type Tier } from '../engine';
import { isLastTradingDayOfMonth, nextTradingDay, type CalendarOverrides } from '../data/calendar';
import { fetchCompanyFacts, fetchFilingDoc, fetchHeadlines, isEarningsFiling, quarterTable, quarterTableText, xbrlConditionMet, XBRL_METRICS, type QuarterRow } from '../data/edgar';
import { buildMarketView, rebaseNotifSeq } from '../data/marketView';
import { fetchEdgarSubmissions, type Filing } from '../data/sources';
import { loadConstituents, loadSeries, type Alert } from '../data/store';
import { errText } from '../data/util';
import { getRun, listRuns, startRun, type AiRun } from './aiRuns';
import type { Env, Fetcher } from './env';
import { ConflictError, loadAccount, requiredTickers, saveAccount } from './ledgerStore';
import { noteOfRun } from './site/aiViews';
import { annotate } from './site/explain';
import type { AiNote } from './site/types';

export const routineReady = (env: Env) => !!(env.ROUTINE_FIRE_URL && env.ROUTINE_TOKEN);

// ---------------------------------------------------------------- 條件的儲存

interface CondRow {
  id: number;
  ticker: string;
  run_id: string;
  cond_id: string;
  direction: string;
  kind: string;
  text: string;
  check_json: string;
  tier_if_met: string | null;
  status: string;
  created_at: string;
  met_at: string | null;
  note: string | null;
}
const toCond = (r: CondRow): OwnCondition & { id: number } => ({
  id: r.id,
  ticker: r.ticker,
  runId: r.run_id,
  condId: r.cond_id,
  direction: r.direction as OwnCondition['direction'],
  kind: r.kind as OwnCondition['kind'],
  text: r.text,
  check: JSON.parse(r.check_json),
  tierIfMet: r.tier_if_met as Tier | null,
  status: r.status as OwnCondition['status'],
  createdAt: r.created_at,
  metAt: r.met_at,
  note: r.note,
});

/** 某一檔目前的條件（監測中、已成立、只記錄的；被替換的不算）。 */
export async function loadConditions(db: D1Database, ticker?: string): Promise<(OwnCondition & { id: number })[]> {
  const q = ticker ? db.prepare("SELECT * FROM own_conditions WHERE ticker = ? AND status != 'REPLACED' ORDER BY id").bind(ticker) : db.prepare("SELECT * FROM own_conditions WHERE status != 'REPLACED' ORDER BY id");
  return (await q.all<CondRow>()).results.map(toCond);
}

function replaceStmts(db: D1Database, ticker: string, runId: string, drafts: ConditionDraft[], at: string, metPrev: string[]): D1PreparedStatement[] {
  const stmts: D1PreparedStatement[] = [];
  if (metPrev.length) stmts.push(db.prepare(`UPDATE own_conditions SET status = 'MET', met_at = ?, note = ? WHERE ticker = ? AND status = 'ACTIVE' AND cond_id IN (${metPrev.map(() => '?').join(',')})`).bind(at, `F24 ${runId} 認為已成立`, ticker, ...metPrev));
  stmts.push(db.prepare("UPDATE own_conditions SET status = 'REPLACED' WHERE ticker = ? AND status IN ('ACTIVE', 'MANUAL', 'MET')").bind(ticker));
  const ins = db.prepare('INSERT INTO own_conditions (ticker, run_id, cond_id, direction, kind, text, check_json, tier_if_met, status, created_at, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (const c of drafts) {
    const auto = !c.manual && c.kind !== 'PRICE' && (c.kind !== 'XBRL' || String(c.check.metric) in XBRL_METRICS);
    stmts.push(ins.bind(ticker, runId, c.condId, c.direction, c.kind, c.text, JSON.stringify(c.check), c.tierIfMet, auto ? 'ACTIVE' : 'MANUAL', at, auto ? null : c.kind === 'PRICE' ? '價格條件只記錄' : '沒有通過檢查，只記錄'));
  }
  return stmts;
}

const metStmt = (db: D1Database, id: number, at: string, note: string) => db.prepare("UPDATE own_conditions SET status = 'MET', met_at = ?, note = ? WHERE id = ?").bind(at, note, id);

// ---------------------------------------------------------------- 證據

/** 代號 → SEC 的 CIK：先看成分股名單，沒有就查 SEC 的 company_tickers.json，查到的存起來。 */
export async function cikFor(env: Env, fetcher: Fetcher, ticker: string): Promise<string | null> {
  const key = `cik:${ticker}`;
  const cached = await env.DB.prepare('SELECT value FROM flow_state WHERE key = ?').bind(key).first<{ value: string }>();
  if (cached) return cached.value;
  const members = await loadConstituents(env.DB);
  let cik = members?.holdings.find((h) => h[0] === ticker)?.[2] ?? null;
  if (!cik && env.EDGAR_USER_AGENT) {
    const r = await fetcher('https://www.sec.gov/files/company_tickers.json', { headers: { 'User-Agent': env.EDGAR_USER_AGENT } });
    if (r.ok) {
      const j = (await r.json()) as Record<string, { cik_str: number; ticker: string }>;
      const hit = Object.values(j).find((x) => x.ticker.toUpperCase() === ticker.replace('.', '-').toUpperCase());
      cik = hit ? String(hit.cik_str).padStart(10, '0') : null;
    }
  }
  if (cik) await env.DB.prepare('INSERT INTO flow_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, cik, new Date().toISOString()).run();
  return cik;
}

export interface OwnEvidence {
  cik: string | null;
  filings: Filing[];
  rows: QuarterRow[];
  xbrl: PackDoc | null;
  docs: PackDoc[];
  news: PackDoc | null;
  dataQuality: Record<string, 'ok' | 'partial' | 'missing'>;
  notes: string[];
}

const docOf = (f: { accession: string; form: string; filingDate: string; url: string; title: string; text: string }): PackDoc => ({ id: `F-${f.accession}`, source_id: `edgar:${f.accession}`, kind: 'filing', date: f.filingDate, title: f.title, url: f.url, text: f.text, fetched_at: new Date().toISOString() });

/**
 * F24 的證據：XBRL 最近 8 季、最近一份 10-Q 或 10-K 的 MD&A、最近 120 天內的 8-K 2.02 新聞稿、Nasdaq 新聞標題。
 * 申報與 XBRL 抓不到 → data_quality 標 missing（AI 只能說明，不能改變下單）；新聞只有標題，抓不到標 partial。
 */
export async function gatherOwnEvidence(env: Env, fetcher: Fetcher, ticker: string, asOf: string): Promise<OwnEvidence> {
  const ua = env.EDGAR_USER_AGENT ?? '';
  const out: OwnEvidence = { cik: null, filings: [], rows: [], xbrl: null, docs: [], news: null, dataQuality: {}, notes: [] };
  try {
    out.cik = await cikFor(env, fetcher, ticker);
    if (!out.cik) throw new Error('找不到 CIK');
    if (!ua) throw new Error('沒有設定 EDGAR 的 User-Agent');
    const sub = await fetchEdgarSubmissions(fetcher, out.cik, ua);
    out.filings = sub.filings.filter((f) => f.filingDate <= asOf);
    const periodic = out.filings.find((f) => /^10-[QK]/.test(f.form));
    const cutoff = new Date(Date.parse(asOf) - 120 * 86400_000).toISOString().slice(0, 10);
    const pr = out.filings.find((f) => f.form.startsWith('8-K') && f.items.includes('2.02') && f.filingDate >= cutoff);
    for (const f of [periodic, pr].filter((x): x is Filing => !!x)) {
      try {
        out.docs.push(docOf(await fetchFilingDoc(fetcher, out.cik, f, ua)));
      } catch (e) {
        out.notes.push(`${f.form} ${f.accession} 抓不到：${errText(e)}`);
      }
    }
    out.dataQuality.filings = out.docs.length ? 'ok' : 'missing';
  } catch (e) {
    out.notes.push(`申報：${errText(e)}`);
    out.dataQuality.filings = 'missing';
  }
  try {
    if (!out.cik || !ua) throw new Error('沒有 CIK 或 User-Agent');
    out.rows = quarterTable(await fetchCompanyFacts(fetcher, out.cik, ua), asOf);
    if (!out.rows.length) throw new Error('沒有季度數字');
    out.xbrl = { id: `X-${ticker}`, source_id: `xbrl:${ticker}`, kind: 'xbrl', date: out.rows[0].filed, title: `${ticker} 最近 ${out.rows.length} 季財報數字（XBRL）`, text: quarterTableText(ticker, out.rows) };
    out.dataQuality.xbrl = 'ok';
  } catch (e) {
    out.notes.push(`XBRL：${errText(e)}`);
    out.dataQuality.xbrl = 'missing';
  }
  try {
    const hl = (await fetchHeadlines(fetcher, ticker)).filter((h) => h.date <= asOf).slice(0, 15);
    if (hl.length) out.news = { id: `N-${ticker}`, source_id: `nasdaq-rss:${ticker}`, kind: 'news', date: hl[0].date, title: `${ticker} 最近的新聞標題（Nasdaq RSS，只有標題）`, text: hl.map((h) => `${h.date} | ${h.title}`).join('\n') };
    out.dataQuality.news = 'partial';
  } catch (e) {
    out.notes.push(`新聞標題：${errText(e)}`);
    out.dataQuality.news = 'partial';
  }
  return out;
}

/** 開一次 F24。 */
export async function startOwnReview(env: Env, fetcher: Fetcher, acct: Account, view: MarketView, axis: string[], ticker: string, trigger: 'MONTHLY' | 'EARNINGS' | 'MANUAL', now: Date, evidence?: OwnEvidence): Promise<AiRun> {
  const ev = evidence ?? (await gatherOwnEvidence(env, fetcher, ticker, view.date));
  const previous = await loadConditions(env.DB, ticker);
  const { pack, notes } = ownReviewPack({ acct, view, axis, ticker, runId: newRunId(view.date, OWN_REVIEW, ticker), trigger, xbrl: ev.xbrl, filings: ev.docs, news: ev.news, previous, dataQuality: ev.dataQuality, now });
  return startRun(env, fetcher, pack, now, [...ev.notes, ...notes]);
}

// ---------------------------------------------------------------- 套用結論

interface Applied {
  acct: Account;
  stmts: D1PreparedStatement[];
  /** 套用了哪些執行、各自的結果（記在流程紀錄裡）。 */
  log: string[];
}

/** 已經有結論、還沒套用的 F24／F25 執行 → 帳戶（純粹算，不寫 D1；要寫的語句放在 stmts，和帳戶一起存）。 */
export async function applyFinishedRuns(db: D1Database, acct0: Account, view: MarketView, now: Date): Promise<Applied> {
  let acct = acct0;
  const at = now.toISOString();
  const stmts: D1PreparedStatement[] = [];
  const log: string[] = [];
  const rows = (await db.prepare("SELECT run_id FROM ai_runs WHERE status = 'DONE' AND applied_at IS NULL AND fn IN (?, ?) ORDER BY completed_at").bind(OWN_REVIEW, OWN_CONDITION).all<{ run_id: string }>()).results;
  for (const { run_id } of rows) {
    const run = (await getRun(db, run_id))!;
    const t = run.ticker ?? '';
    stmts.push(db.prepare('UPDATE ai_runs SET applied_at = ? WHERE run_id = ?').bind(at, run_id));
    if (!run.outcome || !acct.own[t]) {
      log.push(`${run_id}：${acct.own[t] ? '沒有結論' : '已經不是自選股'}，不套用`);
      continue;
    }
    if (run.fn === OWN_REVIEW) {
      const d = reviewDecision(run.outcome, acct, t, run.asOf);
      if (d.tier) {
        acct = recordAiTier(acct, t, d.tier, run.asOf, d.suggest, run_id);
        stmts.push(...replaceStmts(db, t, run_id, d.conditions, at, d.metPrevious));
      }
      log.push(`${run_id}：${d.tier ? TIER_NAME[d.tier] : '不更新'}${d.suggest ? '（月報並列）' : ''}。${d.why}`);
    } else {
      const d = conditionDecision(run.outcome);
      if (!d.condId) {
        log.push(`${run_id}：${d.why}`);
        continue;
      }
      const cond = (await loadConditions(db, t)).find((c) => c.condId === d.condId && c.status === 'ACTIVE');
      if (!cond) {
        log.push(`${run_id}：條件 ${d.condId} 已經不在監測中（被新的審查替換），不通知`);
        continue;
      }
      stmts.push(metStmt(db, cond.id, at, `F25 ${run_id} 3 票確認`));
      if (cond.direction === 'DOWN' && cond.tierIfMet) {
        const r = conditionMet(acct, view, t, cond.tierIfMet, cond.text, view.date.slice(0, 7));
        acct = r.acct;
        if (r.notif) acct.notifs.push(r.notif);
        log.push(`${run_id}：條件 ${d.condId} 成立 → ${r.notif ? `當天通知 #${r.notif.id}` : `不通知（${r.why}）`}`);
      } else log.push(`${run_id}：升級條件 ${d.condId} 成立 → 下一次審查會看到`);
    }
  }
  return { acct, stmts, log };
}

// ---------------------------------------------------------------- 新申報與財報條件

interface FilingCheck {
  ticker: string;
  cik: string;
  fresh: Filing[];
  latest: string;
}

/** 每檔自選的新申報（acceptedAt 在上次看過的之後）。第一次只記下最新的一筆。 */
async function newFilings(env: Env, fetcher: Fetcher, tickers: string[], session: string, notes: string[]): Promise<FilingCheck[]> {
  const out: FilingCheck[] = [];
  for (const t of tickers) {
    try {
      const cik = await cikFor(env, fetcher, t);
      if (!cik) throw new Error('找不到 CIK');
      const sub = await fetchEdgarSubmissions(fetcher, cik, env.EDGAR_USER_AGENT!);
      const known = sub.filings.filter((f) => f.filingDate <= session || f.acceptedAt.slice(0, 10) <= session);
      const latest = known.reduce((m, f) => (f.acceptedAt > m ? f.acceptedAt : m), '');
      const last = (await env.DB.prepare('SELECT value FROM flow_state WHERE key = ?').bind(`edgar:${t}`).first<{ value: string }>())?.value ?? null;
      out.push({ ticker: t, cik, fresh: last ? known.filter((f) => f.acceptedAt > last) : [], latest: latest || last || '' });
    } catch (e) {
      notes.push(`${t} 的申報抓不到：${errText(e)}`);
    }
  }
  return out;
}

export interface AiStepResult {
  created: number[];
  started: string[];
  log: string[];
  alerts: Alert[];
}

/** 每日流程的 AI 那一段。startNew：這次有處理新的交易日（可以看新申報、開新的執行）。 */
export async function aiStep(env: Env, fetcher: Fetcher, now: Date, session: string, ov: CalendarOverrides, startNew: boolean): Promise<AiStepResult> {
  const db = env.DB;
  const res: AiStepResult = { created: [], started: [], log: [], alerts: [] };
  const first = await loadAccount(db);
  if (!first || !Object.keys(first.acct.own).length) return res;
  const tickers = Object.keys(first.acct.own);
  const series = await loadSeries(db, requiredTickers(first.acct));
  let built;
  try {
    built = buildMarketView(series, session, first.acct.cfg.coreTicker);
  } catch {
    return res;
  }
  const { view, axis } = built;

  // 新申報與財報條件（只在處理了新交易日的那一次）
  const checks = startNew && env.EDGAR_USER_AGENT ? await newFilings(env, fetcher, tickers, session, res.log) : [];
  const facts = new Map<string, QuarterRow[]>();
  for (const c of checks) {
    if (!c.fresh.some((f) => /^10-[QK]/.test(f.form))) continue;
    try {
      facts.set(c.ticker, quarterTable(await fetchCompanyFacts(fetcher, c.cik, env.EDGAR_USER_AGENT!), session));
    } catch (e) {
      res.log.push(`${c.ticker} 的 XBRL 抓不到：${errText(e)}`);
    }
  }

  // 套用：AI 執行的結論＋財報條件（和網站的操作同時存檔時重來，最多 3 次；抓到的資料沿用）
  for (let tryNo = 0; ; tryNo++) {
    const loaded = tryNo === 0 ? first : await loadAccount(db);
    if (!loaded) return res;
    rebaseNotifSeq(loaded.acct, axis);
    const before = new Set(loaded.acct.notifs.map((n) => n.id));
    const ap = await applyFinishedRuns(db, loaded.acct, view, now);
    let acct = ap.acct;
    const stmts = [...ap.stmts];
    const log = [...ap.log];
    for (const [t, rows] of facts) {
      for (const c of (await loadConditions(db, t)).filter((x) => x.kind === 'XBRL' && x.status === 'ACTIVE')) {
        const m = xbrlConditionMet(rows, c.check as { type: string; metric: string; level: number; quarters?: number });
        if (!m?.met) continue;
        stmts.push(metStmt(db, c.id, now.toISOString(), `新財報（${rows[0].form} ${rows[0].filed}）：${m.values.map((v) => (v === null ? '—' : v.toFixed(4))).join('、')}`));
        if (c.direction === 'DOWN' && c.tierIfMet) {
          const r = conditionMet(acct, view, t, c.tierIfMet, c.text, session.slice(0, 7));
          acct = r.acct;
          if (r.notif) acct.notifs.push(r.notif);
          log.push(`${t} 財報條件 ${c.condId} 成立（程式比對 XBRL）→ ${r.notif ? `當天通知 #${r.notif.id}` : `不通知（${r.why}）`}`);
        } else log.push(`${t} 升級的財報條件 ${c.condId} 成立 → 下一次審查會看到`);
      }
    }
    if (!stmts.length && acct === loaded.acct) break;
    const notes = (await listRuns(db, now, { limit: 200 })).map(noteOfRun).filter((n): n is AiNote => n !== null);
    annotate({ acct, view, axis, rankOrder: [], aiNotes: notes }, (n) => !before.has(n.id));
    try {
      await saveAccount(db, acct, loaded, 'AI 結論與財報條件', now, stmts);
    } catch (e) {
      if (e instanceof ConflictError && tryNo < 2) continue;
      throw e;
    }
    res.created.push(...acct.notifs.filter((n) => !before.has(n.id)).map((n) => n.id));
    res.log.push(...log);
    break;
  }

  if (!startNew) return res;
  // 記下看過的最新申報
  for (const c of checks) if (c.latest) await db.prepare('INSERT INTO flow_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').bind(`edgar:${c.ticker}`, c.latest, now.toISOString()).run();
  if (!routineReady(env)) {
    res.log.push('雲端排程還沒設定，不開新的 AI 執行');
    return res;
  }

  // 開新的執行：F25（新申報對上事件條件）、F24（新財報、月報前一天）
  const acct = (await loadAccount(db))!.acct;
  const review = new Map<string, 'EARNINGS' | 'MONTHLY'>();
  for (const c of checks) {
    if (!acct.own[c.ticker]) continue;
    const events = (await loadConditions(db, c.ticker)).filter((x) => x.kind === 'EVENT' && x.status === 'ACTIVE');
    const confirm = new Set(events.flatMap((x) => ((x.check.confirm_by as string[] | undefined) ?? []).map((s) => (s === 'SEC' ? '8-K' : s))));
    const relevant = c.fresh.filter((f) => [...confirm].some((k) => f.form.startsWith(k))).slice(0, 3);
    if (events.length && relevant.length) {
      try {
        const docs = await Promise.all(relevant.map(async (f) => docOf(await fetchFilingDoc(fetcher, c.cik, f, env.EDGAR_USER_AGENT!))));
        const { pack, notes } = conditionPack({ acct, view, ticker: c.ticker, runId: newRunId(session, OWN_CONDITION, c.ticker), conditions: events, filings: docs, now });
        res.started.push((await startRun(env, fetcher, pack, now, notes)).runId);
      } catch (e) {
        res.log.push(`${c.ticker} 的條件監測沒有開成：${errText(e)}`);
      }
    }
    if (c.fresh.some(isEarningsFiling)) review.set(c.ticker, 'EARNINGS');
  }
  if (isLastTradingDayOfMonth(nextTradingDay(session, ov), ov)) for (const t of tickers) if (!review.has(t)) review.set(t, 'MONTHLY');
  for (const [t, trigger] of review) {
    try {
      res.started.push((await startOwnReview(env, fetcher, acct, view, axis, t, trigger, now)).runId);
    } catch (e) {
      res.log.push(`${t} 的定期審查沒有開成：${errText(e)}`);
      res.alerts.push({ kind: 'FLOW_ERROR', message: `${t} 的 AI 定期審查沒有開成：${errText(e)}` });
    }
  }
  return res;
}
