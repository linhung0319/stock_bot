// T31a：自選定期審查（F24，任何觸發原因）的兩個計數（own_thesis §3.6.4）。
//   review:fails:<代號>   連續沒有結論的次數與每次的日期、原因；連續 2 次起每次推告警 REVIEW_FAILED；跑完一次（含票數不一致）歸零
//   review:splits:<代號>  連續票數不一致的次數；連續 3 次列進「要看的事」（NO_CONSENSUS，app/thesis.ts）；有一次三票一致歸零
// 算失敗的：逾時、觸發失敗、整份退回、三票格式都不合格、資料缺漏，以及沒開成（startOwnRuns 丟錯，另外照舊推 FLOW_ERROR）。
// 兩個計數都記下寫入時的論點檔編號：移出再加回（新的論點檔）就從 0 算。
import type { Outcome } from '../ai/check';
import { isLastTradingDayOfMonth, nextTradingDay, type CalendarOverrides } from '../data/calendar';
import type { Alert } from '../data/store';
import type { ApplyCtx } from './aiCtx';
import type { AiRun } from './aiRuns';
import { setStateStmt } from './filings';
import { NO_CONSENSUS_AFTER, loadSplits, reviewFailsKey, reviewSplitsKey, type ReviewSplits } from './thesis';

/** 連續幾次沒有結論開始推告警。 */
export const REVIEW_ALERT_AFTER = 2;
/** 告警裡最多列幾次失敗（最近的）。 */
const KEEP = 5;

export interface ReviewFails {
  count: number;
  fileId: string | null;
  /** 最近幾次失敗（舊到新，最多 5 次）。 */
  fails: { date: string; reason: string }[];
}

/** 一次審查的結果算哪一種：沒有結論（附原因）／票數不一致／三票一致（含一致選不動、一致說證據不足）。 */
export function reviewHealth(o: Outcome | null | undefined): { kind: 'FAILED' | 'SPLIT' | 'CONSENSUS'; reason: string } {
  switch (o?.status) {
    case 'AGREED':
    case 'INSUFFICIENT':
      return { kind: 'CONSENSUS', reason: '' };
    case 'SPLIT':
      return { kind: 'SPLIT', reason: '票數不一致' };
    case 'TIMEOUT':
      return { kind: 'FAILED', reason: '逾時' };
    case 'INVALID':
      return { kind: 'FAILED', reason: '三票格式都不合格' };
    case 'DATA_MISSING':
      return { kind: 'FAILED', reason: '資料缺漏' };
    case 'NO_RESULT':
      return { kind: 'FAILED', reason: o.reason.includes('觸發') ? '觸發失敗' : o.reason.includes('退回') ? '整份退回' : '沒有結果' };
    default:
      return { kind: 'FAILED', reason: '沒有結果' };
  }
}

/** session 之後的下一個月底檢查點（月報前一天 = 當月倒數第二個交易日）。 */
export function nextCheckpoint(session: string, ov: CalendarOverrides = {}): string {
  let d = nextTradingDay(session, ov);
  for (let k = 0; k < 60 && !isLastTradingDayOfMonth(nextTradingDay(d, ov), ov); k++) d = nextTradingDay(d, ov);
  return d;
}

/** REVIEW_FAILED 的文字：`MU 的 AI 審查連續 2 次沒有結論（11-28 逾時、12-05 資料缺漏）。規則照常；下一次審查在 …。` */
export function reviewFailText(ticker: string, f: ReviewFails, session: string, ov: CalendarOverrides = {}): string {
  const list = f.fails.map((x) => `${x.date.slice(5)} ${x.reason}`).join('、');
  const head = f.count > f.fails.length ? `最近 ${f.fails.length} 次：` : '';
  return `${ticker} 的 AI 審查連續 ${f.count} 次沒有結論（${head}${list}）。規則照常；下一次審查在 ${nextCheckpoint(session, ov).slice(5)} 的月底檢查點，有新財報時會提早。`;
}

const readState = async (db: D1Database, key: string) => (await db.prepare('SELECT value FROM flow_state WHERE key = ?').bind(key).first<{ value: string }>())?.value ?? null;
const parse = <T>(v: string | null): Partial<T> | null => {
  if (!v) return null;
  try {
    return JSON.parse(v) as Partial<T>;
  } catch {
    return null;
  }
};

/** 讀 review:fails:<代號>；格式壞了、或是別的論點檔寫的 → null。 */
export async function loadFails(db: D1Database, ticker: string, fileId: string | null): Promise<ReviewFails | null> {
  const j = parse<ReviewFails>(await readState(db, reviewFailsKey(ticker)));
  if (!j || (j.fileId ?? null) !== fileId) return null;
  return { count: Number(j.count) || 0, fileId, fails: Array.isArray(j.fails) ? j.fails : [] };
}

/** 同一次套用裡已經算過的計數（同一次套用兩份同一檔的審查時不重讀資料庫）。 */
const seen = new WeakMap<object, Map<string, { fails: ReviewFails | null; splits: ReviewSplits | null }>>();

const delStmt = (db: D1Database, key: string) => db.prepare('DELETE FROM flow_state WHERE key = ?').bind(key);

/** 失敗一次：次數加 1；連續 2 次起回傳告警。 */
function addFail(prev: ReviewFails | null, fileId: string | null, date: string, reason: string): ReviewFails {
  const fails = [...(prev?.fails ?? []), { date, reason }].slice(-KEEP);
  return { count: (prev?.count ?? 0) + 1, fileId, fails };
}
const failAlert = (ticker: string, f: ReviewFails, session: string, runId: string | null, ov?: CalendarOverrides): Alert | null =>
  f.count >= REVIEW_ALERT_AFTER ? { kind: 'REVIEW_FAILED', message: reviewFailText(ticker, f, session, ov), detail: { ticker, count: f.count, runId, fails: f.fails } } : null;

/**
 * 套用一次 F24 的結論時（和帳戶同一筆存檔）：更新這檔的兩個計數；連續 2 次以上沒有結論 → ctx.alerts 放 REVIEW_FAILED。
 * 已經不是自選股的不算。
 */
export async function reviewHealthStmts(ctx: ApplyCtx, run: AiRun): Promise<void> {
  return noteReviewHealth(ctx, run);
}

/**
 * 同上，但結果算哪一種可以由呼叫的地方給（T82：有論點的股票的跌幅審查照自己的四種結果——票數不一致算 SPLIT、
 * 前提不成立與都沒有被判不成立算 CONSENSUS；沒跑完的不呼叫，由重派處理。allocation_redesign §3.2）。沒給就照 reviewHealth 判。
 */
export async function noteReviewHealth(ctx: ApplyCtx, run: AiRun, kind?: 'FAILED' | 'SPLIT' | 'CONSENSUS'): Promise<void> {
  const t = run.ticker ?? '';
  const meta = ctx.acct.own[t];
  if (!meta) return;
  const fileId = meta.fileId ?? null;
  const cache = seen.get(ctx) ?? new Map();
  seen.set(ctx, cache);
  const cur = cache.get(t) ?? { fails: await loadFails(ctx.db, t, fileId), splits: await loadSplits(ctx.db, t, fileId) };
  const at = ctx.now.toISOString();
  const h = kind ? { kind, reason: kind === 'SPLIT' ? '票數不一致' : kind === 'FAILED' ? '沒有結果' : '' } : reviewHealth(run.outcome);
  if (h.kind === 'FAILED') {
    cur.fails = addFail(cur.fails, fileId, run.asOf, h.reason);
    ctx.stmts.push(setStateStmt(ctx.db, reviewFailsKey(t), JSON.stringify(cur.fails), at));
    const alert = failAlert(t, cur.fails, ctx.session, run.runId);
    if (alert) (ctx.alerts ??= []).push(alert);
    ctx.log.push(`${run.runId}：${t} 的審查沒有結論（${h.reason}），連續第 ${cur.fails.count} 次${alert ? '，推告警' : ''}`);
  } else {
    // 跑完了（三票一致或票數不一致）：失敗次數歸零
    if (cur.fails) ctx.stmts.push(delStmt(ctx.db, reviewFailsKey(t)));
    cur.fails = null;
    if (h.kind === 'SPLIT') {
      const n = (cur.splits?.count ?? 0) + 1;
      cur.splits = { count: n, fileId, first: cur.splits?.first || run.runId, reachedAt: cur.splits?.reachedAt ?? (n >= NO_CONSENSUS_AFTER ? run.asOf : null) };
      ctx.stmts.push(setStateStmt(ctx.db, reviewSplitsKey(t), JSON.stringify(cur.splits), at));
      ctx.log.push(`${run.runId}：${t} 的審查票數不一致，連續第 ${n} 次${n >= NO_CONSENSUS_AFTER ? '（列進要看的事）' : ''}`);
    } else {
      if (cur.splits) ctx.stmts.push(delStmt(ctx.db, reviewSplitsKey(t)));
      cur.splits = null;
    }
  }
  cache.set(t, cur);
}

/** 審查沒開成（startOwnReview 丟錯）：直接寫失敗次數；連續 2 次以上時回傳告警（FLOW_ERROR 由呼叫的地方照舊推）。 */
export async function reviewStartFailed(db: D1Database, ticker: string, fileId: string | null, session: string, now: Date, ov?: CalendarOverrides): Promise<Alert | null> {
  const f = addFail(await loadFails(db, ticker, fileId), fileId, session, '沒開成');
  await setStateStmt(db, reviewFailsKey(ticker), JSON.stringify(f), now.toISOString()).run();
  return failAlert(ticker, f, session, null, ov);
}
