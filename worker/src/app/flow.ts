// 每日與每月流程（T7）。排程每天跑兩次：
//   FIRST  美股收盤後（UTC 23:30 = 台灣早上 7:30）：抓資料 → 每日檢查 → 月底那天出月報 → 寫理由 → 存檔 → LINE
//   FINAL  兩小時後（UTC 01:30）：今天已經做完就只補推失敗的訊息；沒做完就再試一次，還是不行就告警（缺席告警）
// 同一個交易日只會處理一次（flow_state.lastSession 和帳戶在同一筆交易裡更新）。
// 漏掉的交易日（兩次都失敗、排程沒跑）下一次會照順序補做，最多 MAX_CATCHUP 天。
//
// 時間模型和示範模式相同（src/demo/driver.ts）：訊號日收盤後先跑每日檢查；訊號日是當月最後一個交易日時，
// 接著用同一天的收盤與排名出下個月的月報（台灣早上收到，當晚美股開盤下單）。
import { annotate } from './site/explain';
import { blockedMonthly, dailyCheck, monthlyReport, type Account, type MonthlyContext, type Notif } from '../engine';
import { isLastTradingDayOfMonth, lastCompletedSession, nextTradingDay, tradingDaysBetween, type CalendarOverrides } from '../data/calendar';
import { runIngest, type IngestResult } from '../data/ingest';
import { buildMarketView, rebaseNotifSeq } from '../data/marketView';
import { NO_SIGNAL_ALERTS, loadCalendarOverrides, loadRanking, loadRun, loadSeries, saveAlerts, saveRun, type Alert, type DataRun, type Ranking } from '../data/store';
import { errText } from '../data/util';
import { closeStaleRuns } from './aiRuns';
import { sweepTimeouts } from './aiTasks';
import type { Env, Fetcher } from './env';
import { ConflictError, loadAccount, requiredTickers, saveAccount, shadowTickers } from './ledgerStore';
import { alertText, lineConfigured, notifLink, notifText, pushLine, type AlertRow } from './line';

export type Attempt = 'FIRST' | 'FINAL' | 'MANUAL';
export type FlowStatus = 'DONE' | 'SKIPPED' | 'NO_ACCOUNT' | 'NO_SIGNAL' | 'ERROR';

/** 一次最多補做幾個漏掉的交易日；超過就只做今天並告警。 */
export const MAX_CATCHUP = 10;
/** 推播失敗的通知，幾天內的下一次流程會再試。 */
export const PUSH_RETRY_DAYS = 3;

export interface FlowOptions {
  now: Date;
  attempt: Attempt;
  /** 手動：不是月底也重新排名（只影響資料，不會因此出月報）。 */
  forceRank?: boolean;
}

export interface FlowResult {
  session: string;
  attempt: Attempt;
  status: FlowStatus;
  /** 這次處理了哪幾個交易日。 */
  processed: string[];
  /** 這次新產生的通知編號。 */
  created: number[];
  /** 這次出的月報（或「月報暫停」那則）的通知編號。 */
  monthly: number | null;
  alerts: string[];
  push: { configured: boolean; sent: number; failed: number; errors: string[] };
  error?: string;
  ms: number;
}

// ---------------------------------------------------------------- 資料抓取

/** 每日資料抓取：必要的代號從帳戶讀（還沒建立帳戶時只有核心 ETF 與短債）。出錯也會留一筆紀錄與告警。 */
export async function ingest(env: Env, fetcher: Fetcher, now: Date, forceRank = false): Promise<IngestResult | { error: string }> {
  try {
    const loaded = await loadAccount(env.DB);
    // 影子組合要用最近 7 個月內影子紀錄裡的代號（觀察期最長 6 個月）
    const since = new Date(now.getTime() - 213 * 86400_000).toISOString().slice(0, 10);
    const track = loaded ? await shadowTickers(env.DB, since) : [];
    return await runIngest(env.DB, fetcher, { now, required: requiredTickers(loaded?.acct ?? null), forceRank, track });
  } catch (e) {
    const error = errText(e);
    console.error('每日資料抓取失敗', e);
    await saveRun(env.DB, { session: '', at: now.toISOString(), status: 'FAILED', signalsOk: false, rebalanceOk: false, ranked: false, ms: 0, detail: { error } }, [{ kind: 'INGEST_ERROR', message: '每日資料抓取出錯，今天不產生訊號：' + error }]);
    return { error };
  }
}

// ---------------------------------------------------------------- 進度

export async function getFlowState(db: D1Database, key: string): Promise<string | null> {
  const r = await db.prepare('SELECT value FROM flow_state WHERE key = ?').bind(key).first<{ value: string }>();
  return r?.value ?? null;
}
const setFlowStateStmt = (db: D1Database, key: string, value: string, at: string) =>
  db.prepare('INSERT INTO flow_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').bind(key, value, at);

/** 這個交易日的流程已經做完（有帳戶時處理過；沒有帳戶時資料抓好了）。 */
async function flowDone(db: D1Database, session: string): Promise<boolean> {
  const r = await db.prepare("SELECT 1 AS x FROM flow_runs WHERE session = ? AND status IN ('DONE', 'NO_ACCOUNT') LIMIT 1").bind(session).first();
  return !!r;
}

export async function recentFlowRuns(db: D1Database, limit = 10): Promise<unknown[]> {
  const rows = (await db.prepare('SELECT session, at, attempt, status, detail FROM flow_runs ORDER BY id DESC LIMIT ?').bind(limit).all<{ detail: string }>()).results;
  return rows.map((r) => ({ ...r, detail: JSON.parse(r.detail) }));
}

// ---------------------------------------------------------------- 引擎

export interface Processed {
  acct: Account;
  processed: string[];
  created: number[];
  monthly: number | null;
  alerts: Alert[];
}

/** 這個月份的月報出過了沒（含因為未分類而暫停的那一則）。 */
export const monthlyMade = (acct: Account, month: string): boolean => acct.notifs.some((n) => n.monthly?.input.month === month);

/**
 * 依序處理 sessions 這幾個交易日：每日檢查；當月最後一個交易日再出下個月的月報；新通知寫下理由。
 * 純粹讀 D1（價格、排名、抓取紀錄），不寫。
 */
export async function processSessions(db: D1Database, acct0: Account, sessions: string[], ov: CalendarOverrides): Promise<Processed> {
  let acct = acct0;
  const alerts: Alert[] = [];
  const done: string[] = [];
  let monthly: number | null = null;
  const start = new Set(acct.notifs.map((n) => n.id));
  const core = acct.cfg.coreTicker;
  // 月報要用到新進場股票的價格：把那一天的排名名單也載入
  const rankings = new Map<string, Ranking | null>();
  for (const s of sessions) if (isLastTradingDayOfMonth(s, ov)) rankings.set(s, await loadRanking(db, s));
  const extra = [...rankings.values()].flatMap((r) => r?.order ?? []);
  const series = await loadSeries(db, [...new Set([...requiredTickers(acct), ...extra])]);
  const latest = await loadRanking(db);
  for (const s of sessions) {
    const built = buildMarketView(series, s, core);
    const view = built.view;
    rebaseNotifSeq(acct, built.axis);
    const before = new Set(acct.notifs.map((n) => n.id));
    acct = dailyCheck(acct, view).acct;
    let rankOrder = latest?.order ?? [];
    if (isLastTradingDayOfMonth(s, ov)) {
      const month = nextTradingDay(s, ov).slice(0, 7);
      if (!monthlyMade(acct, month)) {
        const ranking = rankings.get(s) ?? null;
        const run = await loadRun(db, s);
        let input: MonthlyContext;
        if (ranking && run?.rebalanceOk) {
          input = { order: ranking.order, month, company: ranking.detail.company };
        } else {
          const why = pauseReason(run, !!ranking);
          input = { order: [...acct.rule.heldMom], month, paused: why };
          alerts.push({ kind: 'MONTHLY_PAUSED', message: `${month} 月報照出，但本月暫停換股（${why}），動能名單不變。` });
        }
        const m = monthlyReport(acct, view, input);
        acct = m.acct;
        monthly = m.notif.id;
        rankOrder = input.order;
      }
    }
    annotate({ acct, view, axis: built.axis, rankOrder, aiNotes: [] }, (n) => !before.has(n.id));
    done.push(s);
  }
  const created = acct.notifs.filter((n) => !start.has(n.id)).map((n) => n.id);
  return { acct, processed: done, created, monthly, alerts };
}

function pauseReason(run: DataRun | null, ranked: boolean): string {
  if (!run) return '那一天沒有資料抓取的紀錄';
  if (!run.signalsOk) return '那一天的價格不完整';
  const d = run.detail as { constituents?: { consistent?: boolean } | null };
  if (!d.constituents) return '抓不到成分股名單';
  if (d.constituents.consistent === false) return 'SPY 持股檔和 Wikipedia 的成分股名單不一致';
  if (!ranked) return '排名沒有產生';
  return '資料不完整';
}

/** 這次要處理哪幾個交易日：上次處理到的下一天到今天。第一次用帳戶最後一份快照的日期當起點。 */
export function sessionsToProcess(last: string | null, session: string, ov: CalendarOverrides): { sessions: string[]; gap: number } {
  if (last && last >= session) return { sessions: [], gap: 0 };
  if (!last) return { sessions: [session], gap: 0 };
  const all = tradingDaysBetween(nextTradingDay(last, ov), session, ov);
  if (all.length > MAX_CATCHUP) return { sessions: [session], gap: all.length - 1 };
  return { sessions: all, gap: 0 };
}

// ---------------------------------------------------------------- 推播

async function recordPush(db: D1Database, at: string, kind: 'NOTIF' | 'ALERT' | 'TEST', ref: number | null, ok: boolean, status: number | null, error: string | undefined, text: string) {
  await db.prepare('INSERT INTO pushes (at, kind, ref, ok, status, error, text) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(at, kind, ref, ok ? 1 : 0, status, error ?? null, text).run();
}

export async function sendTestPush(env: Env, fetcher: Fetcher, now: Date, text: string) {
  const r = await pushLine(env, fetcher, text);
  await recordPush(env.DB, now.toISOString(), 'TEST', null, r.ok, r.status, r.error, text);
  return r;
}

/**
 * 推播：① 這次新產生的通知，和最近幾天推失敗、還沒回覆的通知；② 還沒推的告警合成一則（withAlerts 時）。
 * 同一個交易日後來成功了的「今天沒有訊號」告警不推，標成已處理。
 */
export async function pushPending(env: Env, fetcher: Fetcher, now: Date, acct: Account | null, fresh: number[], withAlerts: boolean): Promise<FlowResult['push']> {
  const db = env.DB;
  const at = now.toISOString();
  const out: FlowResult['push'] = { configured: lineConfigured(env), sent: 0, failed: 0, errors: [] };
  if (!out.configured) return out;

  if (acct) {
    const since = new Date(now.getTime() - PUSH_RETRY_DAYS * 86400_000).toISOString();
    const failed = (await db.prepare('SELECT DISTINCT ref FROM pushes WHERE kind = ? AND ok = 0 AND at >= ? AND ref NOT IN (SELECT ref FROM pushes WHERE kind = ? AND ok = 1 AND ref IS NOT NULL)').bind('NOTIF', since, 'NOTIF').all<{ ref: number }>()).results.map((r) => r.ref);
    const ids = [...new Set([...fresh, ...failed])].sort((a, b) => a - b);
    for (const id of ids) {
      const n: Notif | undefined = acct.notifs.find((x) => x.id === id);
      if (!n || (n.status !== 'PENDING' && !fresh.includes(id))) continue;
      const text = notifText(acct, n, notifLink(env, n.id));
      const r = await pushLine(env, fetcher, text);
      await recordPush(db, at, 'NOTIF', id, r.ok, r.status, r.error, text);
      if (r.ok) out.sent++;
      else {
        out.failed++;
        out.errors.push(`通知 #${id}：${r.error}`);
      }
    }
  }

  if (withAlerts) {
    const cutoff = new Date(now.getTime() - PUSH_RETRY_DAYS * 86400_000).toISOString();
    await db.prepare("UPDATE alerts SET sent_at = 'SKIPPED_OLD' WHERE sent_at IS NULL AND at < ?").bind(cutoff).run();
    const rows = (await db.prepare('SELECT id, session, kind, message FROM alerts WHERE sent_at IS NULL ORDER BY id').all<AlertRow>()).results;
    const resolved: number[] = [];
    const keep: AlertRow[] = [];
    const seen = new Set<string>();
    for (const a of rows) {
      if (a.session && NO_SIGNAL_ALERTS.has(a.kind) && (await flowDone(db, a.session))) resolved.push(a.id);
      else {
        const k = `${a.session}|${a.kind}|${a.message}`;
        if (!seen.has(k)) keep.push(a);
        seen.add(k);
      }
    }
    if (resolved.length) await db.prepare(`UPDATE alerts SET sent_at = 'RESOLVED' WHERE id IN (${resolved.map(() => '?').join(',')})`).bind(...resolved).run();
    if (keep.length) {
      const text = alertText(keep, acct?.paper ?? true, env.SITE_URL);
      const r = await pushLine(env, fetcher, text);
      await recordPush(db, at, 'ALERT', null, r.ok, r.status, r.error, text);
      if (r.ok) {
        out.sent++;
        const ids = rows.filter((a) => !resolved.includes(a.id)).map((a) => a.id);
        await db.prepare(`UPDATE alerts SET sent_at = ? WHERE id IN (${ids.map(() => '?').join(',')})`).bind(at, ...ids).run();
      } else {
        out.failed++;
        out.errors.push(`告警：${r.error}`);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- 一次流程

export async function runFlow(env: Env, fetcher: Fetcher, opt: FlowOptions): Promise<FlowResult> {
  const t0 = Date.now();
  const db = env.DB;
  const at = opt.now.toISOString();
  const ov = await loadCalendarOverrides(db);
  const session = lastCompletedSession(opt.now, ov);
  const res: FlowResult = { session, attempt: opt.attempt, status: 'SKIPPED', processed: [], created: [], monthly: null, alerts: [], push: { configured: lineConfigured(env), sent: 0, failed: 0, errors: [] }, ms: 0 };
  const alerts: Alert[] = [];
  let acct: Account | null = null;

  try {
    if (await flowDone(db, session)) {
      acct = (await loadAccount(db))?.acct ?? null;
    } else {
      // 資料：同一天已經抓過而且完全正常就沿用，否則重抓
      const prevRun = await loadRun(db, session);
      let signalsOk = prevRun?.status === 'OK';
      if (!signalsOk || opt.forceRank) {
        const r = await ingest(env, fetcher, opt.now, opt.forceRank);
        signalsOk = !('error' in r) && r.signalsOk;
      }
      if (!signalsOk) {
        res.status = 'NO_SIGNAL';
        acct = (await loadAccount(db))?.acct ?? null;
      } else {
        // 和網站的操作同時存檔時，後到的會被擋下：重新載入再做一次
        for (let tryNo = 0; ; tryNo++) {
          const loaded = await loadAccount(db);
          if (!loaded) {
            res.status = 'NO_ACCOUNT';
            break;
          }
          const last = (await getFlowState(db, 'lastSession')) ?? loaded.acct.snapshotDate;
          const plan = sessionsToProcess(last, session, ov);
          if (plan.gap) alerts.push({ kind: 'FLOW_GAP', message: `每日流程漏了 ${plan.gap} 個交易日（上次處理到 ${last}），超過 ${MAX_CATCHUP} 天不補做，只處理今天。漏掉的那幾天慢規則沒有前進，請檢查自選股的狀態。` });
          if (!plan.sessions.length) {
            acct = loaded.acct;
            res.status = 'DONE';
            break;
          }
          const p = await processSessions(db, loaded.acct, plan.sessions, ov);
          alerts.push(...p.alerts);
          try {
            await saveAccount(db, p.acct, loaded, `每日流程 ${session}${p.monthly !== null ? '（含月報）' : ''}`, opt.now, [setFlowStateStmt(db, 'lastSession', session, at)]);
          } catch (e) {
            if (e instanceof ConflictError && tryNo < 2) continue;
            throw e;
          }
          acct = p.acct;
          Object.assign(res, { status: 'DONE', processed: p.processed, created: p.created, monthly: p.monthly });
          break;
        }
      }
    }
  } catch (e) {
    console.error('每日流程出錯', e);
    res.status = 'ERROR';
    res.error = errText(e);
    alerts.push({ kind: 'FLOW_ERROR', message: `每日流程出錯，今天的清單沒有產生：${res.error}` });
    acct = acct ?? (await loadAccount(db).catch(() => null))?.acct ?? null;
  }

  const ok = res.status === 'DONE' || res.status === 'NO_ACCOUNT' || res.status === 'SKIPPED';
  if (opt.attempt !== 'FIRST') {
    // 缺席告警：再試之後今天還是沒有跑完；AI 任務逾時
    if (!ok) alerts.push({ kind: 'FLOW_MISSED', message: `今天（訊號日 ${session}）的流程沒有跑完，沒有產生清單${res.status === 'NO_SIGNAL' ? '：資料不完整（原因見上面或網站）' : ''}。明天會補做；要手動重跑用 POST /admin/flow。` });
    const timedOut = await sweepTimeouts(db, opt.now);
    await closeStaleRuns(db, opt.now);
    if (timedOut.length) alerts.push({ kind: 'AI_TIMEOUT', message: `${timedOut.length} 個 AI 任務逾時，已照規則處理（${timedOut.join('、')}）。` });
  }
  await saveAlerts(db, at, session, alerts);
  res.alerts = alerts.map((a) => a.kind);

  // 先記下這次的結果（推播時要知道今天做完了沒），推播完再補上推播結果
  const detail = () => JSON.stringify({ processed: res.processed, created: res.created, monthly: res.monthly, alerts: res.alerts, push: res.push, error: res.error, blocked: acct ? blockedMonthly(acct)?.id ?? null : null });
  const row = await db.prepare('INSERT INTO flow_runs (session, at, attempt, status, detail) VALUES (?, ?, ?, ?, ?) RETURNING id').bind(session, at, opt.attempt, res.status, detail()).first<{ id: number }>();
  // 第一次失敗先不推告警（兩小時後會再試）；成功了就把通知與告警都推出去
  res.push = await pushPending(env, fetcher, opt.now, acct, res.created, ok || opt.attempt !== 'FIRST');
  res.ms = Date.now() - t0;
  await db.prepare('UPDATE flow_runs SET detail = ? WHERE id = ?').bind(detail(), row!.id).run();
  return res;
}
