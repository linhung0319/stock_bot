// T32b：進場前回看（momentum_ai_design_2026-11-15 §3.2；取代候選股的每日掃描，候選股掃描在 T32d 拿掉）。
//
//   開（月報前一天 momPreview、月報當天才進榜的 momLateStart）：一份 EVENT_SCAN（run_id 帶 LOOKBACK，rule.detail.kind = 'LOOKBACK'），
//     和每日掃描分開，不動每日掃描的標記與失敗次數。
//     每檔的 8-K：acceptedAt 比 lookback:<代號> 新，而且（最近 30 個日曆天、有 SCAN_ITEMS 的項目）或（最近 100 天內最新一份 2.02）；
//     每檔最多 3 份（2.02 優先，其餘新到舊），整份最多 12 份；放不下的寫進 rule.detail.omitted 與那一檔的 mom_reviews.note。
//     每檔目前 RSS 上的新聞標題一份。facts 的角色是 ENTRY。沒有任何文件就不開。
//   套用（applyEventScan 遇到 LOOKBACK 交給 applyLookback）：
//     有合格結論 → 事件寫進 sec_events（source = SCAN）：三種候選與財測下修、來源是申報 → NEW，其餘 INFO；lookback:<代號> 往前推
//     沒有合格結論 → 標記不動；01:30 重開一次（retryLookback，momRecheck 呼叫）；同一天第 2 次也沒有 → 那幾檔的說明加一句、推 F1_LOOKBACK_FAILED
import type { PackDoc } from '../ai/check';
import { CANDIDATE_CODE, EVENT_SCAN, eventScanPack, scanEvents, scanQualified, type ScanBatchItem } from '../ai/events';
import { newRunId } from '../ai/pack';
import { fetchFilingDoc, fetchHeadlineFeed } from '../data/edgar';
import { SCAN_ITEMS, type FilingHit } from '../data/secEvents';
import { fetchEdgarSubmissions, type Filing } from '../data/sources';
import { errText } from '../data/util';
import type { ApplyCtx, StartCtx } from './aiCtx';
import { startRun, type AiRun } from './aiRuns';
import { accOf, cikFor, insertHitStmts, setStateStmt } from './filings';
import { docOf } from './ownAi';

/** 回看每檔最多幾份 8-K、整份最多幾份。 */
export const LOOKBACK_PER_TICKER = 3;
export const LOOKBACK_MAX = 12;
/** 一般 8-K 往回看幾個日曆天；財報新聞稿（2.02）往回看幾天。 */
export const LOOKBACK_DAYS = 30;
export const LOOKBACK_PR_DAYS = 100;
/** 同一天連續幾次沒有結論開始推告警。 */
export const LOOKBACK_ALERT_AFTER = 2;
/** run_id 裡的記號（和每日掃描分開算：每日掃描的等待、重掃、失敗次數都不看它）。 */
export const LOOKBACK_TAG = 'LOOKBACK';
/** SQL：不是回看的掃描（run_id 沒有 _LOOKBACK_）。 */
export const NOT_LOOKBACK_SQL = "run_id NOT LIKE '%\\_LOOKBACK\\_%' ESCAPE '\\'";
export const IS_LOOKBACK_SQL = "run_id LIKE '%\\_LOOKBACK\\_%' ESCAPE '\\'";

export const lookbackKey = (ticker: string) => `lookback:${ticker}`;
export const lookbackFailsKey = (session: string) => `lookback:fails:${session}`;

const DAY = 86400_000;
const stateOf = async (db: D1Database, key: string) => (await db.prepare('SELECT value FROM flow_state WHERE key = ?').bind(key).first<{ value: string }>())?.value ?? null;
const msOf = (iso: string | null | undefined) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? -Infinity : t;
};
const items = (f: Filing) => (f.items.length ? `（Item ${f.items.join('、')}）` : '');

export interface LookbackDetail {
  kind: 'LOOKBACK';
  month: string;
  tickers: string[];
  /** 這次看到的最新 acceptedAt（有合格結論才推到這裡）。 */
  lookback: Record<string, string>;
  /** 因為上限沒放進去的 8-K。 */
  omitted: { ticker: string; label: string }[];
  /** 這次的 8-K（告警用）。 */
  filings: { ticker: string; label: string }[];
}

/**
 * 一檔要回看的 8-K（純函式）：acceptedAt 比標記新，而且（30 天內、有 SCAN_ITEMS 的項目）或（100 天內最新一份 2.02）；
 * 2.02 那一份排第一，其餘新到舊。
 */
export function lookbackFilings(all: Filing[], asOf: string, marker: string | null): Filing[] {
  const t = Date.parse(asOf);
  const cand = all.filter((f) => f.form.startsWith('8-K') && f.filingDate <= asOf && msOf(f.acceptedAt) > msOf(marker));
  const newest = (a: Filing, b: Filing) => msOf(b.acceptedAt) - msOf(a.acceptedAt);
  const pr = cand.filter((f) => f.items.includes('2.02') && (t - Date.parse(f.filingDate)) / DAY <= LOOKBACK_PR_DAYS).sort(newest)[0];
  const recent = cand.filter((f) => f !== pr && (t - Date.parse(f.filingDate)) / DAY <= LOOKBACK_DAYS && f.items.some((i) => SCAN_ITEMS.includes(i))).sort(newest);
  return [...(pr ? [pr] : []), ...recent];
}

/** 開一份回看掃描（§3.2 第 2 步）。同一天已經有一份回看在等結果就不開。 */
export async function startLookback(sc: Pick<StartCtx, 'env' | 'fetcher' | 'session' | 'now' | 'res'>, month: string, tickers: string[]): Promise<boolean> {
  const { env, fetcher, session, now, res } = sc;
  const ua = env.EDGAR_USER_AGENT ?? '';
  const waiting = await env.DB.prepare(`SELECT run_id FROM ai_runs WHERE fn = ? AND status = 'PENDING' AND ${IS_LOOKBACK_SQL} LIMIT 1`).bind(EVENT_SCAN).first<{ run_id: string }>();
  if (waiting) {
    res.log.push(`進場前回看：${waiting.run_id} 還在等結果，不開新的`);
    return false;
  }
  const docs: (PackDoc & { ticker: string })[] = [];
  const batch: ScanBatchItem[] = [];
  const dq: Record<string, 'ok' | 'partial' | 'missing'> = {};
  const lookback: Record<string, string> = {};
  const omitted: LookbackDetail['omitted'] = [];
  const filings: LookbackDetail['filings'] = [];
  const notes: string[] = [];
  let total = 0;
  for (const t of [...new Set(tickers)]) {
    if (ua) {
      try {
        const cik = await cikFor(env, fetcher, t);
        if (!cik) throw new Error('找不到 CIK');
        const sub = await fetchEdgarSubmissions(fetcher, cik, ua);
        const marker = await stateOf(env.DB, lookbackKey(t));
        const pick = lookbackFilings(sub.filings, session, marker);
        const room = Math.max(0, Math.min(LOOKBACK_PER_TICKER, LOOKBACK_MAX - total));
        const keep = pick.slice(0, room);
        const over = pick.slice(room);
        for (const f of keep) {
          try {
            docs.push({ ...docOf(await fetchFilingDoc(fetcher, cik, f, ua)), ticker: t });
            const label = `${f.form} ${f.filingDate}${items(f)}`;
            batch.push({ ticker: t, kind: '8-K', label: `${t} 的 ${label}` });
            filings.push({ ticker: t, label });
            total++;
            dq.filings = 'ok';
          } catch (e) {
            over.push(f);
            res.log.push(`${t} ${f.form} ${f.accession} 抓不到：${errText(e)}`);
          }
        }
        for (const f of over) omitted.push({ ticker: t, label: `${f.form} ${f.filingDate}${items(f)}` });
        // 標記推到「第一份沒讀到的之前」：讀到的照 acceptedAt 由舊到新，碰到沒讀到的就停
        const read = new Set(docs.filter((d) => d.ticker === t).map((d) => d.source_id));
        let cur = marker ?? '';
        for (const f of [...pick].sort((a, b) => msOf(a.acceptedAt) - msOf(b.acceptedAt))) {
          if (!read.has(`edgar:${f.accession}`)) break;
          cur = f.acceptedAt;
        }
        if (cur && cur !== marker) lookback[t] = cur;
      } catch (e) {
        dq.filings = dq.filings ?? 'missing';
        notes.push(`${t} 的申報抓不到：${errText(e)}`);
      }
    }
    try {
      const feed = await fetchHeadlineFeed(fetcher, t);
      const hl = feed.items.filter((h) => h.date <= session).slice(0, 30);
      dq.news = 'partial';
      if (hl.length) {
        docs.push({ id: `N-${t}-${session}-LB`, source_id: `${feed.source}:${t}:${session}:lookback`, kind: 'news', date: hl[0].date, title: `${t} 目前的新聞標題（${feed.label}，只有標題）`, text: hl.map((h) => `${h.date} | ${h.title}`).join('\n'), ticker: t });
        batch.push({ ticker: t, kind: 'NEWS', label: `${t} 的 ${hl.length} 則新聞標題` });
      }
    } catch (e) {
      dq.news = 'partial';
      notes.push(errText(e));
    }
  }
  if (omitted.length) notes.push(`回看略過 ${omitted.length} 份（每檔最多 ${LOOKBACK_PER_TICKER} 份、整份最多 ${LOOKBACK_MAX} 份）：${omitted.map((o) => `${o.ticker} 的 ${o.label}`).join('、')}`);
  if (!docs.length) {
    res.log.push('進場前回看：沒有要看的 8-K 或新聞標題，不開');
    return false;
  }
  const targets = [...new Set(tickers)].map((t) => ({ ticker: t, role: 'ENTRY' as const }));
  const runId = newRunId(session, EVENT_SCAN, LOOKBACK_TAG);
  const { pack, notes: packNotes } = eventScanPack({ runId, asOf: session, targets, docs, conditions: [], batch, notes, dataQuality: dq, now });
  pack.subject = { name: `進場前回看（${targets.map((x) => x.ticker).join('、')}）` };
  const detail: LookbackDetail = { kind: 'LOOKBACK', month, tickers: targets.map((x) => x.ticker), lookback, omitted, filings };
  pack.rule.detail = { ...(pack.rule.detail as object), ...detail };
  const run = await startRun(env, fetcher, pack, now, [...notes, ...packNotes]);
  res.started.push(run.runId);
  // 那一檔的說明：回看略過 N 份
  const per = new Map<string, number>();
  for (const o of omitted) per.set(o.ticker, (per.get(o.ticker) ?? 0) + 1);
  for (const [t, n] of per) await env.DB.prepare("UPDATE mom_reviews SET note = COALESCE(note, '') || ? WHERE month = ? AND ticker = ?").bind(`；回看略過 ${n} 份`, month, t).run();
  return true;
}

/** F1_LOOKBACK_FAILED 的文字（§3.2）。 */
export function lookbackFailText(n: number, filings: LookbackDetail['filings']): string {
  const by = new Map<string, string[]>();
  for (const f of filings) by.set(f.ticker, [...(by.get(f.ticker) ?? []), f.label]);
  const what = [...by].map(([t, ls]) => `${t} 的 ${ls.join('、')}`).join('；');
  return `進場前回看連續 ${n} 次沒有結論${what ? `：${what}還沒有被 AI 看過` : ''}。規則偵測照常；月報照規則出。`;
}

const advanceStmt = (db: D1Database, key: string, value: string, at: string) =>
  db.prepare('INSERT INTO flow_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at WHERE excluded.value > flow_state.value').bind(key, value, at);

/** 套用回看掃描（applyEventScan 遇到 rule.detail.kind = LOOKBACK 時交給這裡）。 */
export async function applyLookback(ctx: ApplyCtx, run: AiRun): Promise<void> {
  const d = (run.pack.rule.detail ?? {}) as Partial<LookbackDetail>;
  const at = ctx.now.toISOString();
  if (!run.outcome || !scanQualified(run.outcome)) {
    const key = lookbackFailsKey(run.asOf);
    const prev = Number(JSON.parse((await stateOf(ctx.db, key)) ?? '{"count":0}').count) || 0;
    const n = prev + 1;
    ctx.stmts.push(setStateStmt(ctx.db, key, JSON.stringify({ count: n, runId: run.runId }), at));
    if (n >= LOOKBACK_ALERT_AFTER) {
      (ctx.alerts ??= []).push({ kind: 'F1_LOOKBACK_FAILED', message: lookbackFailText(n, d.filings ?? []), detail: { runId: run.runId, month: d.month, count: n } });
      for (const t of d.tickers ?? []) ctx.stmts.push(ctx.db.prepare("UPDATE mom_reviews SET note = COALESCE(note, '') || '；進場前回看沒有結論' WHERE month = ? AND ticker = ? AND COALESCE(note, '') NOT LIKE '%進場前回看沒有結論%'").bind(d.month ?? '', t));
    }
    return void ctx.log.push(`${run.runId}：進場前回看沒有結論（${run.outcome?.reason ?? '沒有結果'}）；標記不動（同一天第 ${n} 次）`);
  }
  const events = scanEvents(run.outcome, run.pack);
  for (const e of events) {
    const code = CANDIDATE_CODE[e.cls];
    const filing = accOf(e.sourceId).kind === 'FILING';
    const cut = e.cls === 'GUIDANCE_CUT' && (e.sub === 'CUT' || e.sub === 'WITHDRAWN');
    const hit: FilingHit = { accession: e.sourceId, form: filing ? '8-K' : 'NEWS', date: e.date, acceptedAt: '', byRule: false, code: code ?? e.cls, ...(e.sub ? { detailCode: e.sub } : {}), sub: `SCAN_${e.cls}`, displayOnly: !code, detail: `進場前回看標記：${e.cls}${e.sub ? `（${e.sub}）` : ''}` };
    ctx.stmts.push(...insertHitStmts(ctx.db, e.ticker, [hit], 'SCAN', at, () => ((code || cut) && filing ? 'NEW' : 'INFO')));
  }
  for (const [t, v] of Object.entries(d.lookback ?? {})) ctx.stmts.push(advanceStmt(ctx.db, lookbackKey(t), v, at));
  ctx.stmts.push(ctx.db.prepare('DELETE FROM flow_state WHERE key = ?').bind(lookbackFailsKey(run.asOf)));
  ctx.log.push(`${run.runId}：進場前回看標記 ${events.length} 件${events.length ? `（${events.map((e) => `${e.ticker} ${e.cls}${e.sub ? `/${e.sub}` : ''}`).join('、')}）` : ''}`);
}

/** 01:30（momRecheck）：今天最近一份回看沒有合格結論、今天還不到 2 份 → 用同一批對象重開一次。 */
export async function retryLookback(sc: Pick<StartCtx, 'env' | 'fetcher' | 'session' | 'now' | 'res'>, month: string): Promise<void> {
  const { env, session, res } = sc;
  const rows = (await env.DB.prepare(`SELECT run_id, status, outcome, pack FROM ai_runs WHERE fn = ? AND as_of = ? AND ${IS_LOOKBACK_SQL} ORDER BY created_at DESC`).bind(EVENT_SCAN, session).all<{ run_id: string; status: string; outcome: string | null; pack: string }>()).results;
  const last = rows[0];
  if (!last || last.status !== 'DONE') return;
  if (scanQualified(last.outcome ? JSON.parse(last.outcome) : null)) return;
  if (rows.length >= 2) return void res.log.push('進場前回看今天已經重開過，不再開');
  const d = (JSON.parse(last.pack) as { rule: { detail: Partial<LookbackDetail> } }).rule.detail;
  if (d.month !== month || !d.tickers?.length) return;
  res.log.push(`進場前回看沒有結論 → 重開一次（${d.tickers.join('、')}）`);
  await startLookback(sc, month, d.tickers);
}
