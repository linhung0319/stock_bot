// T11：F14 新增自選股的健檢（網站觸發）。
//   請 AI 草擬前提（使用者沒寫理由）／把使用者寫的出場條件改寫成可追蹤的格式 → 網站等結果、讓使用者勾選。
//   使用者確認的出場條件 → own_conditions（origin = USER、有勾選時間與成立時的動作，是「你定的條件」；審查換不掉），由 F25 監測。
import type { PackDoc } from '../ai/check';
import { OWN_CHECK, ownCheckPack, ownCheckResult, type OwnCheckResult } from '../ai/ownCheck';
import { newRunId, priceDoc, priceFacts } from '../ai/pack';
import { recommendStdWeights, type Account, type MarketView } from '../engine';
import { errText } from '../data/util';
import { getRun, startRun, type AiRun } from './aiRuns';
import type { Env, Fetcher } from './env';
import { entryEvidence } from './momAi';
import { loadAccount, thesisLogStmt } from './ledgerStore';
import { gatherOwnEvidence, insertConditionStmts, routineReady } from './ownAi';
import { checkCap } from './ownConds';
import { ACTION_TEXT, COND_ACTIONS, acceptStatus, confirmText, defaultAction, fileConditions, isOwned, ownerText, progressText, type CondAction } from './thesis';

/** 這檔現在的論點檔編號（帳戶沒有、不是自選、T25 之前的自選 → null）。 */
async function currentFileId(db: D1Database, ticker: string): Promise<string | null> {
  return (await loadAccount(db))?.acct.own[ticker]?.fileId ?? null;
}

/** 一年日報酬的相關係數（和既有持股的題材重疊，F14 卡片的 theme_overlap）。 */
export function corr1y(view: MarketView, a: string, b: string): number | null {
  const ca = view.close[a];
  const cb = view.close[b];
  if (!ca || !cb) return null;
  const xs: number[] = [];
  const ys: number[] = [];
  for (let k = Math.max(1, view.i - 251); k <= view.i; k++) {
    const x = ca[k] / ca[k - 1] - 1;
    const y = cb[k] / cb[k - 1] - 1;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    xs.push(x);
    ys.push(y);
  }
  if (xs.length < 120) return null;
  const mx = xs.reduce((s, v) => s + v, 0) / xs.length;
  const my = ys.reduce((s, v) => s + v, 0) / ys.length;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let k = 0; k < xs.length; k++) {
    sxy += (xs[k] - mx) * (ys[k] - my);
    sxx += (xs[k] - mx) ** 2;
    syy += (ys[k] - my) ** 2;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}

export async function startOwnCheck(env: Env, fetcher: Fetcher, acct: Account, view: MarketView, axis: string[], ticker: string, lines: string[], now: Date): Promise<AiRun> {
  if (!routineReady(env)) throw new Error('AI 層的雲端排程還沒設定（SETUP.md 的 T5），沒辦法請 AI 健檢');
  const ev = await gatherOwnEvidence(env, fetcher, ticker, view.date);
  const entry = await entryEvidence(env, fetcher, view, axis, ticker, acct.cfg.coreTicker, false).catch(() => null);
  const holdings = [...new Set([...Object.keys(acct.own), ...Object.keys(acct.lots.mom)])].filter((t) => t !== ticker);
  const overlap = holdings
    .map((t) => ({ t, c: corr1y(view, ticker, t) }))
    .filter((x): x is { t: string; c: number } => x.c !== null)
    .sort((a, b) => b.c - a.c)
    .slice(0, 3);
  const rec = (() => {
    try {
      return recommendStdWeights(view, [...Object.keys(acct.own), ticker], acct.cfg.ratio.own)[ticker];
    } catch {
      return undefined;
    }
  })();
  const facts = [
    ...priceFacts(view, ticker),
    ...(rec ? [{ id: 'W1', label: '建議的標準比重', value: `${(rec * 100).toFixed(1)}%` }] : []),
    ...overlap.map((x, k) => ({ id: `O${k + 1}`, label: `和 ${x.t} 的一年日報酬相關係數`, value: x.c.toFixed(2), note: x.c > 0.7 ? '高度相關：可能是同一個題材' : undefined })).map((f) => (f.note === undefined ? { id: f.id, label: f.label, value: f.value } : f)),
  ];
  const docs = [priceDoc(view, axis, ticker, 60), ev.xbrl, ...ev.docs, ev.news].filter((d): d is PackDoc => !!d);
  const { pack, notes } = ownCheckPack({ runId: newRunId(view.date, OWN_CHECK, ticker), asOf: view.date, ticker, lines: lines.map((l) => l.trim()).filter(Boolean).slice(0, 6), facts, hits: entry?.hits ?? [], docs, dataQuality: ev.dataQuality, now });
  return startRun(env, fetcher, pack, now, [...ev.notes, ...(entry?.notes ?? []), ...notes]);
}

export interface OwnCheckView extends OwnCheckResult {
  runId: string;
  status: 'PENDING' | 'DONE';
  mode: 'DRAFT' | 'REWRITE';
  /** 已經確認開始監測的條件編號。 */
  accepted: string[];
}

export async function ownCheckView(env: Env, runId: string, now: Date): Promise<OwnCheckView | null> {
  const run = await getRun(env.DB, runId, now);
  if (!run || run.fn !== OWN_CHECK) return null;
  const r = ownCheckResult(run.outcome, run.ticker ?? '');
  // 只算現在這份論點檔勾過的（移出再加回之後，同一次健檢的條件可以重新勾）
  const fileId = await currentFileId(env.DB, run.ticker ?? '');
  const accepted = (await env.DB.prepare(`SELECT cond_id FROM own_conditions WHERE run_id = ? AND origin = 'USER' AND ${fileId ? 'file_id = ?' : 'file_id IS NULL'}`).bind(runId, ...(fileId ? [fileId] : [])).all<{ cond_id: string }>()).results.map((x) => x.cond_id);
  return { ...r, runId, status: run.status, mode: (run.pack.rule.detail as { mode: 'DRAFT' | 'REWRITE' }).mode, accepted };
}

/** 這一檔最近一次健檢。 */
export async function latestOwnCheck(env: Env, ticker: string, now: Date): Promise<OwnCheckView | null> {
  const r = await env.DB.prepare('SELECT run_id FROM ai_runs WHERE fn = ? AND ticker = ? ORDER BY created_at DESC LIMIT 1').bind(OWN_CHECK, ticker).first<{ run_id: string }>();
  return r ? ownCheckView(env, r.run_id, now) : null;
}

/**
 * 使用者勾選的出場條件 → 你定的條件（origin = USER，帶勾選時間與成立時的動作；T26）。回傳寫入幾條。
 * actions：每一條成立時做什麼（沒給就帶 AI 改寫時的檔位）。會自己發通知的你定的條件一檔最多 8 條。
 */
export async function acceptOwnConditions(env: Env, ticker: string, runId: string, ids: string[], now: Date, actions: Record<string, unknown> = {}, session?: string): Promise<number> {
  const v = await ownCheckView(env, runId, now);
  if (!v || v.status !== 'DONE') throw new Error('這次健檢還沒有結果');
  const pick = v.conditions
    .filter((c) => ids.includes(c.condId) && !v.accepted.includes(c.condId))
    .map((c) => ({ ...c, action: COND_ACTIONS.includes(actions[c.condId] as CondAction) ? (actions[c.condId] as CondAction) : defaultAction(c) }));
  if (!pick.length) return 0;
  const acct = (await loadAccount(env.DB))?.acct;
  if (!acct?.own[ticker]) throw new Error(`${ticker} 不是自選股`);
  const fileId = acct.own[ticker].fileId ?? null;
  checkCap(await fileConditions(env.DB, acct, ticker), pick.filter((c) => acceptStatus({ kind: c.kind, check: c.check, auto: !c.manual, status: 'PROPOSED' }) !== 'MANUAL').length);
  const at = now.toISOString();
  const res = await env.DB.batch(insertConditionStmts(env.DB, ticker, runId, pick, at, 'USER', fileId));
  // log 寫 CONDITION（列編號要等寫入之後才知道）
  if (fileId) await env.DB.batch(res.map((r, k) => thesisLogStmt(env.DB, { ticker, fileId, session: session ?? at.slice(0, 10), kind: 'CONDITION', ref: String(r.meta.last_row_id), body: { id: r.meta.last_row_id, change: 'ACCEPTED', action: pick[k].action, by: 'USER' } }, null, at)));
  return pick.length;
}

export interface MonitorRow {
  id: number;
  text: string;
  kind: string;
  /** 誰定的、哪一天（「你寫的，11/20 定」「AI 建議，你在 11/20 勾選」「AI 建議，11/20 的審查寫的」）。 */
  origin: string;
  /** 狀態的白話（監測中、只在定期審查時檢查、只記錄、已成立、建議中）。 */
  status: string;
  /** 狀態代號（畫面判斷能做什麼用，不顯示）。 */
  code: string;
  /** 你定的條件（勾選過、或你自己寫的）。 */
  owned: boolean;
  /** 你定的：成立時做什麼；建議中的：勾選時預設的動作（AI 建議的檔位）。 */
  action: CondAction | null;
  actionText: string | null;
  /** 怎麼確認。 */
  confirm: string;
  /** 財報類條件的進度（§3.6.2）。 */
  progress: string | null;
  /** 只記錄、不會通知（價格條件、沒通過格式檢查的）：畫面不給選成立時的動作。 */
  recordOnly: boolean;
  /** 說明（已成立的寫怎麼確認成立的；其他是寫入時的原因）。 */
  note: string | null;
}

const md = (iso: string | null) => (iso ? `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}` : '');
/** 已成立的條件怎麼確認的（白話，不放執行編號）。 */
function metNote(c: { metAt: string | null; metBasis: string | null }): string {
  const d = md(c.metAt);
  if (c.metBasis === 'XBRL') return `${d} 新財報出來，程式比對成立`;
  if (c.metBasis === 'FILING_VOTE') return `${d} 新申報的原文，AI 3 票確認成立`;
  if (c.metBasis === 'REVIEW_VOTE') return `${d} 的定期審查，AI 3 票確認成立`;
  if (c.metBasis === 'PRESS') return `${d} 依財報新聞稿成立（10-Q 出來後再核對）`;
  return `${d} 成立`;
}

const STATUS_TEXT: Record<string, string> = { ACTIVE: '監測中', MET: '已成立', MANUAL: '只記錄', REVIEW_ONLY: '只在定期審查時檢查', PROPOSED: '建議中', RETIRED: '已撤下', EXPIRED: '已過期', REPLACED: '已替換' };

/** 持股頁要顯示的條件：你定的（監測中、只在審查時檢查、只記錄、已成立）與 AI 建議、你還沒勾選的；撤下與過期的不列。 */
export async function monitorView(env: Env, ticker: string): Promise<MonitorRow[]> {
  try {
    const acct = (await loadAccount(env.DB))?.acct;
    return (acct ? await fileConditions(env.DB, acct, ticker) : [])
      .filter((c) => c.status !== 'RETIRED' && c.status !== 'EXPIRED')
      .map((c) => {
        const owned = isOwned(c) && c.status !== 'PROPOSED';
        const action = owned ? c.action : defaultAction(c);
        return {
          id: c.id,
          text: c.text,
          kind: { XBRL: '財報', EVENT: '事件', PRICE: '價格' }[c.kind] ?? c.kind,
          origin: ownerText(c),
          status: STATUS_TEXT[c.status] ?? c.status,
          code: c.status,
          owned,
          action,
          actionText: action ? ACTION_TEXT[action] : null,
          confirm: confirmText(c),
          progress: progressText(c),
          recordOnly: acceptStatus(c) === 'MANUAL',
          note: c.status === 'MET' ? metNote(c) : c.note,
        };
      });
  } catch (e) {
    return [{ id: 0, text: `讀不到：${errText(e)}`, kind: '', origin: '', status: '', code: '', owned: false, action: null, actionText: null, confirm: '', progress: null, recordOnly: false, note: null }];
  }
}
