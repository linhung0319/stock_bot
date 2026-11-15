// T11：F7 自選減半的 AI 檢視、F20 動能持股單月跌 > 20% 的說明（每日流程的 AI 段，src/app/aiStep.ts 呼叫）。
// T29b：自選股不再跑 F20，改成個股自身大跌（PRICE_DROP 事件，own_thesis §3.6.1），由提前審查決定開不開。
// T31b：減半檢視的結果寫進帳戶狀態的 dropReview（own_thesis §3.3）：開的時候 PENDING（沒開成、AI 層沒設定是 NONE），套用時改成
//       建議不動／建議出清／同意減半／沒有可用的結論，慢規則通知上 AI 的那一行跟著重算（§3.4）。使用者先回覆、結果才回來的照 §3.5。
import { verdictText } from '../ai/functions';
import type { PackDoc } from '../ai/check';
import { attribution, highIndex, idioDrop, idioDropText } from '../ai/detect';
import { DROP_EXPLAIN, MONTH_DROP, OWN_DROP, dropDecision, dropExplainPack, explainLine, ownDropPack } from '../ai/drops';
import { newRunId } from '../ai/pack';
import { clone, newNotif, recordAiTier, refreshOwnAiChoice, routeReview, type Account, type DropReview, type MarketView, type Notif } from '../engine';
import { fetchCompanyFacts, fetchFilingDoc, quarterTable, type QuarterRow } from '../data/edgar';
import type { FilingHit } from '../data/secEvents';
import { errText } from '../data/util';
import type { ApplyCtx, StartCtx } from './aiCtx';
import { startRun, type AiRun } from './aiRuns';
import { insertHitStmts, sectorEtfs } from './filings';
import { patchAccount } from './ledgerStore';
import { citedDoc, docOf, lastReview, newsDoc } from './ownAi';
import { condFacts, defaultFacts, flaggedAccessions, pickFilings, thesisFacts, thesisFile, thesisNote } from './thesis';

const ret = (view: MarketView, t: string, n: number) => {
  const c = view.close[t];
  return c && Number.isFinite(c[view.i]) && Number.isFinite(c[view.i - n]) ? c[view.i] / c[view.i - n] - 1 : NaN;
};

/** 最近一次 F24 的摘要（F7 的底）。 */
function baseDoc(run: AiRun | null, ticker: string): PackDoc | null {
  const o = run?.outcome;
  if (!run || !o) return null;
  const s = o.samples.find((x) => x.valid && x.verdict === o.verdict) ?? o.samples.find((x) => x.valid);
  const prem = run.pack.premises.map((p) => `${p.id} ${p.text}: ${s?.premises.find((x) => x.premise_id === p.id)?.status ?? 'INSUFFICIENT'}`);
  const text = [`F24 ${run.runId} as of ${run.asOf}: ${o.status} ${o.verdict ?? '-'} (${verdictText(run.fn, o.verdict)})`, ...prem, '', (s?.report ?? '').slice(0, 3000)].join('\n');
  return { id: `B-${ticker}`, source_id: `review:${run.runId}`, kind: 'note', date: run.asOf, title: `最近一次定期審查（${run.asOf}）的結論`, text };
}

async function recentRun(db: D1Database, fn: string, ticker: string, since: string): Promise<boolean> {
  return !!(await db.prepare('SELECT 1 AS x FROM ai_runs WHERE fn = ? AND ticker = ? AND as_of >= ? LIMIT 1').bind(fn, ticker, since).first());
}

export async function startDropRuns(sc: StartCtx): Promise<void> {
  const { env, fetcher, acct, view, axis, session, now, res } = sc;
  const core = acct.cfg.coreTicker;
  const holdings = [...new Set([...Object.keys(acct.own), ...Object.keys(acct.lots.mom).filter((t) => (acct.lots.mom[t] ?? 0) > 0)])];
  const sectors = await sectorEtfs(env.DB, holdings);
  /** since 之後的 8-K、10-Q、10-K 最多 n 份。flagged：給了就照論點檔的順序挑（最新的 2.02、有標記的、其餘；own_thesis §3.3），否則新到舊。 */
  const filingDocs = async (t: string, since: string, n: number, flagged?: Set<string>): Promise<PackDoc[]> => {
    const c = sc.checks.find((x) => x.ticker === t);
    if (!c || !env.EDGAR_USER_AGENT) return [];
    const out: PackDoc[] = [];
    const cands = c.all.filter((x) => x.filingDate > since && (x.form.startsWith('8-K') || /^10-[QK]/.test(x.form)));
    for (const f of flagged ? pickFilings(cands, flagged, n) : cands.slice(0, n)) {
      try {
        out.push(docOf(await fetchFilingDoc(fetcher, c.cik, f, env.EDGAR_USER_AGENT)));
      } catch (e) {
        res.log.push(`${t} ${f.form} 抓不到：${errText(e)}`);
      }
    }
    return out;
  };
  // F7：這次新觸發減半的自選股（證據包由論點檔組，own_thesis §3.3）。開成 → dropReview 記 PENDING；沒開成 → NONE
  const marks: Record<string, DropReview> = {};
  const mark = (t: string, s: string, runId: string | null, pending: boolean) => (marks[t] = { session: s, runId, status: pending ? 'PENDING' : 'NONE', cause: null, premiseId: null, told: false });
  for (const r of sc.extras.reduced ?? []) {
    const t = r.ticker;
    if (!acct.own[t] || (await recentRun(env.DB, OWN_DROP, t, r.session))) continue;
    try {
      const c = view.close[t];
      const attr = c ? attribution(axis, view.close, t, core, sectors[t] ?? null, highIndex(c, view.i), view.i) : null;
      const base = await lastReview(env.DB, t);
      const since = base?.asOf ?? new Date(Date.parse(session) - 45 * 86400_000).toISOString().slice(0, 10);
      const tf = await thesisFile(env.DB, acct, t, session);
      const docs = await filingDocs(t, since, 3, tf ? flaggedAccessions(tf) : undefined);
      const news = await newsDoc(fetcher, t, session, since).catch(() => null);
      if (news) docs.push(news);
      const urgent = acct.own[t].pending?.action !== 'REDUCE';
      // 只有預設前提的股票：D1～D3 要季度數字；有財報類觀察項時也要（W 附程式比對的結果）。F7 原本不抓 XBRL
      let rows: QuarterRow[] | null = null;
      const chk = sc.checks.find((x) => x.ticker === t);
      const needRows = tf?.kind === 'DEFAULT_ONLY' || !!tf?.conditions.some((c) => c.status === 'PROPOSED' && c.kind === 'XBRL');
      if (needRows && chk && env.EDGAR_USER_AGENT) {
        try {
          rows = quarterTable(await fetchCompanyFacts(fetcher, chk.cik, env.EDGAR_USER_AGENT), session);
        } catch (e) {
          res.log.push(`${t} 的 XBRL 抓不到：${errText(e)}`);
        }
      }
      const note = tf ? thesisNote(tf, session) : null;
      // 你定的條件 C 與觀察項 W 只當背景：F7 不確認條件成不成立（own_thesis §3.3）
      const extraFacts = tf ? [...thesisFacts(tf), ...defaultFacts(tf, rows, session), ...condFacts(tf, rows).facts] : [];
      const { pack, notes } = ownDropPack({ acct, view, axis, ticker: t, runId: newRunId(session, OWN_DROP, t), attr, base: baseDoc(base, t), baseRunId: base?.runId ?? null, docs, urgent, dataQuality: { filings: 'ok', news: 'partial', ...(base ? {} : { review: 'partial' }) }, extraFacts, extraDocs: note ? [note] : [], now });
      const run = await startRun(env, fetcher, pack, now, notes);
      res.started.push(run.runId);
      // 雲端排程沒有觸發成功時，這次執行已經用「沒有結果」結束
      mark(t, r.session, run.runId, run.status === 'PENDING');
    } catch (e) {
      res.log.push(`${t} 的減半檢視沒有開成：${errText(e)}`);
      mark(t, r.session, null, false);
    }
  }
  await markDropReviews(env.DB, now, view, marks, res.log);
  // 個股自身大跌（own_thesis §3.6.1，取代自選股的 F20）：寫一筆 PRICE_DROP，由提前審查（startEarlyReviews）決定開不開
  await priceDrops(sc, sectors).catch((e) => void res.log.push(`個股自身大跌沒有算成：${errText(e)}`));
  // F20：最近 21 個交易日跌超過 20% 的動能持股（同一檔 30 天內只說明一次）。自選股不再跑（own_thesis §2.8；動能的在 T32d 拿掉）
  const since30 = new Date(Date.parse(session) - 30 * 86400_000).toISOString().slice(0, 10);
  for (const t of holdings.filter((x) => !acct.own[x])) {
    const r21 = ret(view, t, 21);
    if (!(r21 <= MONTH_DROP) || (await recentRun(env.DB, DROP_EXPLAIN, t, since30))) continue;
    try {
      const attr = attribution(axis, view.close, t, core, sectors[t] ?? null, view.i - 21, view.i);
      const docs = await filingDocs(t, since30, 2);
      const news = await newsDoc(fetcher, t, session).catch(() => null);
      if (news) docs.push(news);
      const { pack, notes } = dropExplainPack({ view, axis, ticker: t, role: 'MOM', runId: newRunId(session, DROP_EXPLAIN, t), ret21: r21, attr, docs, dataQuality: { news: 'partial' }, now });
      res.started.push((await startRun(env, fetcher, pack, now, notes)).runId);
    } catch (e) {
      res.log.push(`${t} 的跌幅說明沒有開成：${errText(e)}`);
    }
  }
}

/** 同一檔最近幾個日曆天內已經有一筆 PRICE_DROP 就不再寫。 */
export const PRICE_DROP_GAP = 30;

/**
 * 個股自身大跌（own_thesis §3.6.1）：自選股最近 21 個交易日自己跌 10% 以上、而且比產業 ETF（沒有時比核心 ETF）多跌 10 個百分點以上
 * → sec_events 寫一筆 PRICE_DROP（source PRICE、NEW），等提前審查處理。不寫的情況：30 天內已經有一筆；同一天慢規則觸發減半（那天跑 F7）。
 */
export async function priceDrops(sc: StartCtx, sectors: Record<string, string>): Promise<void> {
  const { env, acct, view, axis, session, now, res } = sc;
  const cutoff = new Date(Date.parse(session) - PRICE_DROP_GAP * 86400_000).toISOString().slice(0, 10);
  const halved = new Set((sc.extras.reduced ?? []).filter((r) => r.session === session).map((r) => r.ticker));
  for (const t of Object.keys(acct.own)) {
    const d = idioDrop(axis, view.close, t, acct.cfg.coreTicker, sectors[t] ?? null, view.i);
    if (!d?.hit) continue;
    const detail = idioDropText(d.attr, acct.cfg.coreTicker);
    if (halved.has(t)) {
      res.log.push(`${t} 個股自身大跌（${detail}），同一天慢規則觸發減半，只跑減半檢視`);
      continue;
    }
    if (await env.DB.prepare("SELECT 1 AS x FROM sec_events WHERE ticker = ? AND code = 'PRICE_DROP' AND event_date > ? LIMIT 1").bind(t, cutoff).first()) continue;
    const hit: FilingHit = { accession: `price:${t}:${session}`, form: 'RULE', date: session, acceptedAt: '', code: 'PRICE_DROP', detailCode: 'IDIO_21D', sub: 'RULE_IDIO_21D', byRule: true, displayOnly: false, detail };
    await env.DB.batch(insertHitStmts(env.DB, t, [hit], 'PRICE', now.toISOString(), () => 'NEW'));
    res.log.push(`${t} 個股自身大跌（${detail}）→ 記下，等提前審查`);
  }
}

const escalateHit = (run: AiRun, code: string): FilingHit => ({ code, sub: `AI_${run.fn}`, accession: run.runId, form: 'AI', date: run.asOf, acceptedAt: '', byRule: false, detail: `${run.fn === OWN_DROP ? '減半檢視' : '跌幅說明'}的 AI 認為有硬事件，轉交法庭` });

/**
 * 這幾檔這一次減半的論點檢查狀態寫進帳戶（PENDING 或 NONE），還沒回覆的減半通知上 AI 的那一行跟著重算（own_thesis §3.3、§3.4）。
 * 帳戶在這之前已經存好，所以重新讀、改、存。已經不是減半中的（期間規則又切換了）不寫。
 */
export async function markDropReviews(db: D1Database, now: Date, view: MarketView, marks: Record<string, DropReview>, log: string[]): Promise<void> {
  if (!Object.keys(marks).length) return;
  await patchAccount(
    db,
    now,
    '減半檢視的狀態',
    (a0) => {
      let a = clone(a0);
      for (const [t, m] of Object.entries(marks)) {
        if (!a.own[t] || a.own[t].slow.state !== 'HALF') continue;
        a.own[t].dropReview = { ...m };
        a = refreshOwnAiChoice(a, view, t).acct;
      }
      return { acct: a };
    },
    log,
  );
}

/** AI 層沒有設定（雲端排程還沒接上）：這次新觸發減半的自選股沒有論點檢查，dropReview 記 NONE（own_thesis §3.3），通知照舊當場推。 */
export async function markDropNone(db: D1Database, now: Date, view: MarketView, acct: Account, reduced: { ticker: string; session: string }[], log: string[]): Promise<void> {
  const marks: Record<string, DropReview> = {};
  for (const r of reduced) if (acct.own[r.ticker]) marks[r.ticker] = { session: r.session, runId: null, status: 'NONE', cause: null, premiseId: null, told: false };
  await markDropReviews(db, now, view, marks, log);
}

const DROP_TEXT: Record<string, string> = { HOLD: '建議不動', EXIT: '前提不成立，建議出清', AGREE: '同意減半', NONE: '沒有可用的結論，照規則' };

/** 這檔還沒回覆的減半項目（當天通知或月報裡的）。 */
const openReduce = (acct: Account, t: string): Notif | undefined => acct.notifs.find((n) => n.status === 'PENDING' && n.items.some((i) => i.f === 'F7' && i.kind === 'OWN_RULE' && i.ticker === t && !i.cancelled));

/**
 * F7 的結論（own_thesis §3.3）→ dropReview，慢規則通知上 AI 的那一行照 §3.4 重算。建議出清時另外記 aiTier（之後加回時看得到）；
 * 不動、同意減半、沒有結論都不動 aiTier（月中記著等月報的建議不會被蓋掉）。
 * 使用者在結果回來之前就回覆了（§3.5）：出清 → 當成一次審查的建議照 §1.9（觸發原因 DROP）；不動、而且選了照規則還沒填快照 → 推一則提醒；其餘只放網站。
 */
export async function applyOwnDrop(ctx: ApplyCtx, run: AiRun): Promise<void> {
  const t = run.ticker ?? '';
  const meta0 = ctx.acct.own[t];
  if (!run.outcome || !meta0) return;
  const d = dropDecision(run.outcome, run.pack);
  if (d.escalate) ctx.stmts.push(...insertHitStmts(ctx.db, t, [escalateHit(run, d.escalate)], 'AI', ctx.now.toISOString(), () => 'NEW'));
  // 這次執行對應的是不是目前這一次減半（開執行時記的狀態沒有存成時 dropReview 是空的，照樣認）
  const mine = meta0.dropReview ? meta0.dropReview.runId === run.runId : true;
  if (meta0.dropReview && !mine) return void ctx.log.push(`${run.runId}：${t} 的論點檢查回來了，但已經不是目前這一次減半（${meta0.dropReview.session} 又觸發過），只放網站`);
  if (meta0.dropReview && !mine) return void ctx.log.push(`${run.runId}：${t} 的論點檢查回來了，但已經不是目前這一次減半（${meta0.dropReview.session} 又觸發過），只放網站`);
  const basis = d.status === 'EXIT' && d.premiseId ? citedDoc(run, (s) => s.premises.find((p) => p.premise_id === d.premiseId && p.status === 'BROKEN')?.evidence_ids ?? []) : null;
  const setResult = (told: boolean) => {
    const acct = clone(ctx.acct);
    const dr = acct.own[t].dropReview;
    acct.own[t].dropReview = { session: dr?.session ?? run.asOf, runId: run.runId, status: d.status, cause: d.cause, premiseId: d.premiseId, told: told || (dr?.told ?? false) };
    ctx.acct = acct;
  };
  // 還在等：這檔有還沒回覆的減半項目，或這次減半還在等月報
  if (mine && (openReduce(ctx.acct, t) || meta0.pending?.action === 'REDUCE')) {
    setResult(false);
    if (d.status === 'EXIT' && d.premiseId) ctx.acct = recordAiTier(ctx.acct, t, 'EXIT', run.asOf, false, run.runId, { premiseId: d.premiseId, trigger: 'DROP', basis, agreed: true });
    const r = refreshOwnAiChoice(ctx.acct, ctx.view, t);
    ctx.acct = r.acct;
    return void ctx.log.push(`${run.runId}：${t} 的論點檢查：${DROP_TEXT[d.status]}（${d.why}）${r.changed.length ? `→ 更新通知 #${r.changed.join('、#')}` : ''}`);
  }
  // 使用者在結果回來之前就回覆了：找這次減半的那則通知（已經回覆的不動）
  const answered = [...ctx.acct.notifs].reverse().find((n) => n.date >= run.asOf && n.status !== 'PENDING' && n.items.some((i) => i.f === 'F7' && i.kind === 'OWN_RULE' && i.ticker === t && !i.cancelled));
  if (!answered) return void ctx.log.push(`${run.runId}：${t} 的論點檢查：${DROP_TEXT[d.status]}，但這次減半已經不在（規則又切換了，或通知已經被取代），只放網站`);
  // 還可以改決定的（等你下單）：記下結果，退回「等你決定」時那一行會補上；不再補推
  if (meta0.dropReview?.runId === run.runId) setResult(true);
  const it = answered.items.find((i) => i.f === 'F7' && i.ticker === t)!;
  if (d.status === 'EXIT' && d.premiseId) {
    const r = routeReview(ctx.acct, ctx.view, t, { tier: 'EXIT', suggest: true, consensus: true, premiseId: d.premiseId, trigger: 'DROP', date: run.asOf, runId: run.runId, basis });
    ctx.acct = r.acct;
    return void ctx.log.push(`${run.runId}：${t} 的論點檢查建議出清，通知 #${answered.id} 已經回覆 → ${r.why}`);
  }
  if (d.status === 'HOLD' && answered.status === 'RESPONDED' && it.choice === 'RULE') {
    const acct = clone(ctx.acct);
    const n = newNotif(acct, ctx.view, { kind: 'INFO', title: `${t} 的 AI 論點檢查回來了`, text: `${t} 的 AI 論點檢查回來了：建議不動。你已經選了照規則；還沒下單的話可以回通知 #${answered.id} 改決定。`, ref: answered.id, coreAbsorb: false });
    ctx.acct = acct;
    return void ctx.log.push(`${run.runId}：${t} 的論點檢查建議不動，通知 #${answered.id} 已經選了照規則、還沒填快照 → 提醒 #${n.id}`);
  }
  ctx.log.push(`${run.runId}：${t} 的論點檢查：${DROP_TEXT[d.status]}；通知 #${answered.id} 已經回覆，只放網站`);
}

/** F20：找到硬事件 → 轉交法庭；說明本身由月報讀（monthNotes）。 */
export async function applyDropExplain(ctx: ApplyCtx, run: AiRun): Promise<void> {
  const t = run.ticker ?? '';
  const s = run.outcome?.samples.find((x) => x.valid);
  if (s?.payload?.escalate_to_F19 === true) ctx.stmts.push(...insertHitStmts(ctx.db, t, [escalateHit(run, String(s.payload.escalate_code))], 'AI', ctx.now.toISOString(), () => 'NEW'));
}

/** 這個月份的 F20 說明（附在月報），連同是哪一次執行。 */
export async function monthNotes(db: D1Database, since: string, until: string): Promise<{ text: string; runId: string }[]> {
  const rows = (await db.prepare("SELECT run_id, ticker, pack, outcome FROM ai_runs WHERE fn = ? AND status = 'DONE' AND as_of > ? AND as_of <= ? ORDER BY as_of").bind(DROP_EXPLAIN, since, until).all<{ run_id: string; ticker: string; pack: string; outcome: string | null }>()).results;
  return rows.map((r) => ({ text: explainLine(r.ticker, (JSON.parse(r.pack).rule.detail as { ret21: number }).ret21, r.outcome ? JSON.parse(r.outcome) : null), runId: r.run_id }));
}
