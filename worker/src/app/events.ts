// T11：F18 每日事件掃描、F19 持股硬事件（每日流程的 AI 段，src/app/aiStep.ts 呼叫）。
//
// 規則段（每個新的交易日，不用 LLM）：持股與排名 6～10 的候選股的新申報 → 分類（src/data/secEvents.ts）→ sec_events
//   動能持股是被收購方、持股的 NT 10-K／10-Q → 規則直接提出提早出場（當天通知，使用者確認；不跑法庭）
//   4.02、會計師辭任、自選股是被收購方 → 等著開法庭（F19）
//   候選股的命中 → 只記錄（下一次 F1 審查會自己重新分類）
// LLM 段（雲端排程設定好才開）：
//   F18 掃描（Haiku，一票）：規則分不出輕重的 8-K 與新聞標題 → 事件類別；持股的 _CANDIDATE → 開法庭；候選股的 → 下一次 F1 看得到
//   F19 法庭（3 票）：一致建議出場 → 當天通知（只限 PENDING_MA、ACCOUNTING、REGULATORY）
import { CANDIDATE_CODE, EVENT_SCAN, HARD_EVENT, eventScanPack, hardDecision, hardEventPack, scanEvents, type HardCode, type HardEventRef, type ScanTarget } from '../ai/events';
import type { PackDoc } from '../ai/check';
import { newRunId } from '../ai/pack';
import { hardEvent } from '../engine';
import { fetchCompanyFacts, fetchFilingDoc, quarterTable } from '../data/edgar';
import { SCAN_ITEMS, classifyFilings, fetchPrimaryText, type FilingHit } from '../data/secEvents';
import { loadRanking } from '../data/store';
import { errText } from '../data/util';
import type { ApplyCtx, StartCtx } from './aiCtx';
import { startRun, type AiRun } from './aiRuns';
import type { Env, Fetcher } from './env';
import { handledStmt, insertHitStmts, loadEvents, setStateStmt, type FilingCheck, type SecEventRow } from './filings';
import { docOf, loadConditions, newsDoc, xbrlDoc } from './ownAi';

/** 每日掃描的對象：自選、動能持股、排名 6～10 的候選（還沒持有的）。 */
export async function scanTargets(db: D1Database, acct: { own: Record<string, unknown>; rule: { heldMom: string[] }; lots: { mom: Record<string, number> } }): Promise<ScanTarget[]> {
  const out = new Map<string, ScanTarget>();
  for (const t of Object.keys(acct.own)) out.set(t, { ticker: t, role: 'OWN' });
  for (const t of new Set([...acct.rule.heldMom, ...Object.keys(acct.lots.mom).filter((t) => acct.lots.mom[t] > 0)])) if (!out.has(t)) out.set(t, { ticker: t, role: 'MOM' });
  const r = await loadRanking(db);
  for (const t of r?.order.slice(5, 10) ?? []) if (!out.has(t)) out.set(t, { ticker: t, role: 'CAND' });
  return [...out.values()];
}

// ---------------------------------------------------------------- 規則段

export interface Classified {
  ticker: string;
  role: ScanTarget['role'];
  hits: FilingHit[];
}

/** 新申報 → 命中（要讀封面的才抓原文）。 */
export async function classifyFresh(env: Env, fetcher: Fetcher, checks: FilingCheck[], targets: ScanTarget[], log: string[]): Promise<Classified[]> {
  const role = new Map(targets.map((t) => [t.ticker, t.role]));
  const out: Classified[] = [];
  for (const c of checks) {
    if (!c.fresh.length || !role.has(c.ticker)) continue;
    const hits = await classifyFilings(fetcher, c.cik, c.names, c.fresh, env.EDGAR_USER_AGENT!, log);
    if (hits.length) out.push({ ticker: c.ticker, role: role.get(c.ticker)!, hits });
  }
  return out;
}

const WINDOW_DAYS: Record<string, number> = { PENDING_MA: 365, ACCOUNTING: 180 };

/**
 * 規則段的結果寫進 sec_events；持股的「規則直接提出」→ 當天通知（同一檔同一類 180 天內只提一次，被收購 365 天）。
 * 在套用的那一筆存檔裡做（和帳戶一起存）。
 */
export async function applyRuleEvents(ctx: ApplyCtx, classified: Classified[]): Promise<void> {
  const at = ctx.now.toISOString();
  for (const c of classified) {
    const held = c.role !== 'CAND';
    const own = c.role === 'OWN' && (ctx.acct.lots.own[c.ticker] ?? 0) > 0;
    const mom = (ctx.acct.lots.mom[c.ticker] ?? 0) > 0 || ctx.acct.rule.heldMom.includes(c.ticker);
    const direct = (h: FilingHit) => held && h.byRule && !h.displayOnly && ((h.code === 'ACCOUNTING' && h.sub.startsWith('NT_')) || (h.code === 'PENDING_MA' && mom && !own));
    const court = (h: FilingHit) => held && !h.displayOnly && !direct(h) && (!h.byRule || h.code === 'PENDING_MA');
    ctx.stmts.push(...insertHitStmts(ctx.db, c.ticker, c.hits, 'EDGAR', at, (h) => (direct(h) ? 'HANDLED' : court(h) ? 'NEW' : 'INFO')));
    for (const h of c.hits.filter(direct)) {
      const since = new Date(Date.parse(ctx.session) - (WINDOW_DAYS[h.code] ?? 180) * 86400_000).toISOString().slice(0, 10);
      const before = (await loadEvents(ctx.db, { ticker: c.ticker, since, status: 'HANDLED' })).filter((e) => e.code === h.code && e.accession !== h.accession);
      if (before.length) {
        ctx.log.push(`${c.ticker} ${h.sub}：${since} 以後已經提過同一類，不再通知`);
        continue;
      }
      const r = hardEvent(ctx.acct, ctx.view, c.ticker, h.code as HardCode, true);
      ctx.acct = r.acct;
      ctx.log.push(`${c.ticker} ${h.sub}（${h.detail}）→ 規則直接提出${r.notif ? `，當天通知 #${r.notif.id}` : '（沒有持股，不通知）'}`);
    }
  }
}

// ---------------------------------------------------------------- 套用 LLM 的結論

/** F19 法庭：3 票一致建議出場 → 當天通知（自選加上硬事件標記，動能從名單拿掉）。 */
export async function applyHardEvent(ctx: ApplyCtx, run: AiRun): Promise<void> {
  const t = run.ticker ?? '';
  if (!run.outcome) return;
  const d = hardDecision(run.outcome);
  if (!d.exit || !d.code) return void ctx.log.push(`${run.runId}：${t} 不建議出場（${d.why}）`);
  const held = (ctx.acct.lots.own[t] ?? 0) > 0 || (ctx.acct.lots.mom[t] ?? 0) > 0;
  if (!held) return void ctx.log.push(`${run.runId}：${t} 已經沒有持股，不通知`);
  const r = hardEvent(ctx.acct, ctx.view, t, d.code, false);
  ctx.acct = r.acct;
  ctx.log.push(`${run.runId}：${t} ${d.code} → AI 建議提早出場${r.notif ? `，當天通知 #${r.notif.id}` : ''}`);
}

/** F18 掃描：事件寫進 sec_events；持股或候選的 _CANDIDATE 標成待處理（持股會開法庭，候選股留給下一次 F1）。 */
export async function applyEventScan(ctx: ApplyCtx, run: AiRun): Promise<void> {
  if (!run.outcome) return;
  const events = scanEvents(run.outcome, run.pack);
  const at = ctx.now.toISOString();
  for (const e of events) {
    const code = CANDIDATE_CODE[e.cls];
    const hit: FilingHit = { code: code ?? e.cls, sub: `SCAN_${e.cls}`, accession: e.sourceId, form: e.sourceId.startsWith('edgar:') ? '8-K' : 'NEWS', date: e.date, acceptedAt: '', byRule: false, displayOnly: !code, detail: `每日掃描標記：${e.cls}${e.conditionIds.length ? `；可能和條件 ${e.conditionIds.join('、')} 有關（等申報原文證實）` : ''}` };
    ctx.stmts.push(...insertHitStmts(ctx.db, e.ticker, [hit], 'SCAN', at, () => (code ? 'NEW' : 'INFO')));
  }
  ctx.log.push(`${run.runId}：每日掃描標記 ${events.length} 件${events.length ? `（${events.map((e) => `${e.ticker} ${e.cls}`).join('、')}）` : ''}`);
}

// ---------------------------------------------------------------- 開新的執行

/** 持股的待處理事件 → 開 F19 法庭（同一檔一次一個）。 */
async function startCourts(sc: StartCtx, targets: ScanTarget[]): Promise<void> {
  const { env, fetcher, acct, view, axis, session, now, res } = sc;
  const role = new Map(targets.map((t) => [t.ticker, t.role]));
  const pending = (await loadEvents(env.DB, { status: 'NEW' })).filter((e) => role.get(e.ticker) && role.get(e.ticker) !== 'CAND' && ['PENDING_MA', 'ACCOUNTING', 'REGULATORY'].includes(e.code));
  const byTicker = new Map<string, SecEventRow[]>();
  for (const e of pending) byTicker.set(e.ticker, [...(byTicker.get(e.ticker) ?? []), e]);
  for (const [t, evs] of byTicker) {
    const check = sc.checks.find((c) => c.ticker === t);
    const docs: PackDoc[] = [];
    const dq: Record<string, 'ok' | 'partial' | 'missing'> = {};
    try {
      for (const e of evs) {
        if (e.accession.startsWith('nasdaq-rss:') || e.form === 'NEWS') {
          const n = await newsDoc(fetcher, t, session).catch(() => null);
          if (n && !docs.some((d) => d.source_id === n.source_id)) docs.push(n);
          dq.news = 'partial';
          continue;
        }
        const acc = e.accession.replace(/^edgar:/, '');
        const f = check?.all.find((x) => x.accession === acc);
        if (!f || !check) continue;
        if (docs.some((d) => d.source_id === `edgar:${acc}`)) continue;
        if (f.form.startsWith('8-K')) docs.push(docOf(await fetchFilingDoc(fetcher, check.cik, f, env.EDGAR_USER_AGENT!)));
        else {
          const p = await fetchPrimaryText(fetcher, check.cik, f, env.EDGAR_USER_AGENT!, 40_000);
          docs.push({ id: `F-${acc}`, source_id: `edgar:${acc}`, kind: 'filing', date: f.filingDate, title: `${f.form} ${f.filingDate}（開頭）`, url: p.url, text: p.text });
        }
      }
      dq.filings = docs.some((d) => d.kind === 'filing') ? 'ok' : 'missing';
      let xbrl: PackDoc | null = null;
      if (check) {
        try {
          xbrl = xbrlDoc(t, quarterTable(await fetchCompanyFacts(fetcher, check.cik, env.EDGAR_USER_AGENT!), session));
          dq.xbrl = xbrl ? 'ok' : 'missing';
        } catch (e) {
          dq.xbrl = 'missing';
          res.log.push(`${t} 的 XBRL 抓不到：${errText(e)}`);
        }
      }
      const refs: HardEventRef[] = evs.map((e) => ({ code: e.code, sub: e.sub, form: e.form, date: e.event_date, detail: e.detail, source: e.source }));
      const own = (acct.lots.own[t] ?? 0) > 0 && !!acct.own[t];
      const { pack, notes } = hardEventPack({ acct, view, axis, ticker: t, runId: newRunId(session, HARD_EVENT, t), role: own ? 'OWN' : 'MOM', events: refs, docs, xbrl, dataQuality: dq, now });
      const run = await startRun(env, fetcher, pack, now, notes);
      res.started.push(run.runId);
      await handledStmt(env.DB, evs.map((e) => e.id), `開法庭 ${run.runId}`).run();
    } catch (e) {
      res.log.push(`${t} 的硬事件法庭沒有開成：${errText(e)}`);
    }
  }
}

/** F18 掃描：規則分不出輕重的新 8-K、新的新聞標題 → 一份證據包（有東西才開）。 */
async function startScan(sc: StartCtx, targets: ScanTarget[]): Promise<void> {
  const { env, fetcher, session, now, res } = sc;
  const docs: (PackDoc & { ticker: string })[] = [];
  const dq: Record<string, 'ok' | 'partial' | 'missing'> = {};
  for (const c of sc.checks) {
    if (!targets.some((t) => t.ticker === c.ticker)) continue;
    for (const f of c.fresh.filter((x) => x.form.startsWith('8-K') && x.items.some((i) => SCAN_ITEMS.includes(i))).slice(0, 3)) {
      try {
        docs.push({ ...docOf(await fetchFilingDoc(fetcher, c.cik, f, env.EDGAR_USER_AGENT!)), ticker: c.ticker });
        dq.filings = 'ok';
      } catch (e) {
        res.log.push(`${c.ticker} ${f.form} 抓不到：${errText(e)}`);
      }
    }
  }
  const seen: D1PreparedStatement[] = [];
  for (const t of targets) {
    try {
      const key = `news:${t.ticker}`;
      const last = (await env.DB.prepare('SELECT value FROM flow_state WHERE key = ?').bind(key).first<{ value: string }>())?.value;
      const n = await newsDoc(fetcher, t.ticker, session, last ?? undefined);
      if (n) {
        docs.push({ ...n, id: `N-${t.ticker}-${session}`, source_id: `nasdaq-rss:${t.ticker}:${session}`, ticker: t.ticker });
        seen.push(setStateStmt(env.DB, key, n.date, now.toISOString()));
      }
      dq.news = 'partial';
    } catch {
      dq.news = 'partial';
    }
  }
  if (!docs.length) return void res.log.push('每日掃描：沒有新的 8-K 或新聞標題，不開');
  const conditions = [];
  for (const t of targets.filter((x) => x.role === 'OWN')) for (const c of (await loadConditions(env.DB, t.ticker)).filter((x) => x.kind === 'EVENT' && x.status === 'ACTIVE')) conditions.push({ ticker: t.ticker, condId: c.condId, text: c.text });
  const { pack, notes } = eventScanPack({ runId: newRunId(session, EVENT_SCAN), asOf: session, targets, docs, conditions, dataQuality: dq, now });
  res.started.push((await startRun(env, fetcher, pack, now, notes)).runId);
  if (seen.length) await env.DB.batch(seen);
}

/** 每日流程的 F18／F19 開執行那一段。 */
export async function startEventRuns(sc: StartCtx, targets: ScanTarget[]): Promise<void> {
  try {
    await startCourts(sc, targets);
  } catch (e) {
    sc.res.log.push(`硬事件法庭出錯：${errText(e)}`);
  }
  try {
    await startScan(sc, targets);
  } catch (e) {
    sc.res.log.push(`每日掃描沒有開成：${errText(e)}`);
  }
}
