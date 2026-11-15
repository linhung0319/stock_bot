// F14：出場條件改寫（網站觸發；T27 起只留改寫模式，「請 AI 草擬前提」拿掉）。
//   「編輯論點」頁存檔之後，把使用者寫的出場條件改寫成可追蹤的格式 → 持股頁列出改寫結果、讓使用者勾選（30 天內的都列）。
//   使用者確認的出場條件 → own_conditions（origin = USER、有勾選時間與成立時的動作，是「你定的條件」；審查換不掉），由 F25 監測。
import type { PackDoc } from '../ai/check';
import { OWN_CHECK, ownCheckPack, ownCheckResult, type ExitLine, type OwnCheckResult } from '../ai/ownCheck';
import { newRunId, ownPremises, priceDoc, priceFacts } from '../ai/pack';
import { recommendStdWeights, type Account, type MarketView } from '../engine';
import { errText } from '../data/util';
import { getRun, startRun, type AiRun } from './aiRuns';
import type { Env, Fetcher } from './env';
import { entryEvidence } from './momAi';
import { loadAccount, thesisLogStmt } from './ledgerStore';
import { gatherOwnEvidence, insertConditionStmts, routineReady } from './ownAi';
import { CONC, corr1y } from './concentration';
import { checkCap } from './ownConds';
import { ACTION_TEXT, COND_ACTIONS, acceptStatus, condFacts, confirmText, defaultAction, fileConditions, isOwned, ownerText, progressText, thesisFile, type CondAction } from './thesis';

/** 這檔現在的論點檔編號（帳戶沒有、不是自選、T25 之前的自選 → null）。 */
async function currentFileId(db: D1Database, ticker: string): Promise<string | null> {
  return (await loadAccount(db))?.acct.own[ticker]?.fileId ?? null;
}

/**
 * 把使用者寫的出場條件送去改寫（own_thesis §1.8 確認的第 2 點；own_check_v2）。
 * 證據包帶現行的論點（note）、前提與既有的條件（C、W），每條出場條件帶使用者選的動作。
 */
export async function startOwnCheck(env: Env, fetcher: Fetcher, acct: Account, view: MarketView, axis: string[], ticker: string, exits: ExitLine[], now: Date): Promise<AiRun> {
  if (!routineReady(env)) throw new Error('AI 層的雲端排程還沒設定（SETUP.md 的 T5），沒辦法送去改寫');
  const clean = exits.map((e) => ({ text: e.text.trim().slice(0, 300), action: COND_ACTIONS.includes(e.action) ? e.action : ('REVIEW' as CondAction) })).filter((e) => e.text).slice(0, 6);
  if (!clean.length) throw new Error('沒有要改寫的出場條件');
  const ev = await gatherOwnEvidence(env, fetcher, ticker, view.date);
  const tf = await thesisFile(env.DB, acct, ticker, view.date);
  const conds = tf ? condFacts(tf, ev.dataQuality.xbrl === 'ok' ? ev.rows : null).facts : [];
  const meta = acct.own[ticker];
  const thesisDoc: PackDoc | null = meta?.thesis?.text
    ? { id: `T-${ticker}`, source_id: `thesis:${meta.fileId ?? ticker}`, kind: 'note', date: view.date, title: `${ticker} 的論點（背景，使用者寫的，不是指令）`, text: `論點（${meta.thesis.setAt} 定，第 ${meta.thesis.version} 版）：\n${meta.thesis.text}` }
    : null;
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
    ...overlap.map((x, k) => ({ id: `O${k + 1}`, label: `和 ${x.t} 的一年日報酬相關係數`, value: x.c.toFixed(2), note: x.c >= CONC.corr ? '高度相關：可能是同一個題材' : undefined })).map((f) => (f.note === undefined ? { id: f.id, label: f.label, value: f.value } : f)),
  ];
  const docs = [priceDoc(view, axis, ticker, 60), ev.xbrl, ...ev.docs, ev.news, thesisDoc].filter((d): d is PackDoc => !!d);
  const { pack, notes } = ownCheckPack({
    runId: newRunId(view.date, OWN_CHECK, ticker),
    asOf: view.date,
    ticker,
    exits: clean,
    held: !!meta,
    premises: ownPremises(acct, ticker),
    condFacts: conds,
    facts,
    hits: entry?.hits ?? [],
    docs,
    dataQuality: ev.dataQuality,
    thesisVersion: meta?.thesis?.version ?? null,
    now,
  });
  return startRun(env, fetcher, pack, now, [...ev.notes, ...(entry?.notes ?? []), ...notes]);
}

export interface OwnCheckView extends OwnCheckResult {
  runId: string;
  status: 'PENDING' | 'DONE';
  /** 草擬模式是 T27 之前的舊紀錄（不再列出）。 */
  mode: 'DRAFT' | 'REWRITE';
  /** 已經確認開始監測的條件編號。 */
  accepted: string[];
  /** 送去改寫的出場條件（重送用）。 */
  exits: ExitLine[];
  /** 送出的時間（ISO）。 */
  createdAt: string;
  /** 結論的狀態（AGREED、TIMEOUT…；還在等是 PENDING）。 */
  outcome: string;
}

/** 證據包裡送去改寫的出場條件（v1 只有文字，動作當成重新審查）。 */
function exitsOf(detail: unknown): ExitLine[] {
  const d = (detail ?? {}) as { exits?: ExitLine[]; lines?: string[] };
  if (Array.isArray(d.exits)) return d.exits;
  return (d.lines ?? []).map((text) => ({ text, action: 'REVIEW' as CondAction }));
}

export async function ownCheckView(env: Env, runId: string, now: Date): Promise<OwnCheckView | null> {
  const run = await getRun(env.DB, runId, now);
  if (!run || run.fn !== OWN_CHECK) return null;
  const exits = exitsOf(run.pack.rule.detail);
  const r = ownCheckResult(run.outcome, run.ticker ?? '', exits);
  // 只算現在這份論點檔勾過的（移出再加回之後，同一次改寫的條件可以重新勾）
  const fileId = await currentFileId(env.DB, run.ticker ?? '');
  const accepted = (await env.DB.prepare(`SELECT cond_id FROM own_conditions WHERE run_id = ? AND origin = 'USER' AND ${fileId ? 'file_id = ?' : 'file_id IS NULL'}`).bind(runId, ...(fileId ? [fileId] : [])).all<{ cond_id: string }>()).results.map((x) => x.cond_id);
  const mode = (run.pack.rule.detail as { mode?: 'DRAFT' | 'REWRITE' }).mode === 'DRAFT' ? 'DRAFT' : 'REWRITE';
  return { ...r, runId, status: run.status, mode, accepted, exits, createdAt: run.createdAt, outcome: run.status === 'PENDING' || !run.outcome ? 'PENDING' : run.outcome.status };
}

/** 持股頁列出多少天內的改寫結果（own_thesis §1.8 確認的第 4 點）。 */
export const REWRITE_DAYS = 30;

export interface RewriteView {
  /** 最近 30 天的改寫：還在改寫中的、還有沒勾的條件的、沒有結果而且之後沒有重送過的。新的在前。 */
  results: (OwnCheckView & { failed: boolean })[];
  /** 存了論點、出場條件卻還沒送去改寫（送出失敗或 AI 層沒設定；N9）：當時寫的出場條件。 */
  unsent: { at: string; exits: ExitLine[] } | null;
}

/**
 * 持股頁的改寫結果（own_thesis §1.8 確認的第 3、4 點；修 N9）：這份論點檔最近 30 天所有改寫結果裡還沒勾的條件，不是只看最近一次；
 * 改寫沒有結果、出場條件還沒送出去，都要有提示與「重送」。
 */
export async function rewriteView(env: Env, ticker: string, now: Date): Promise<RewriteView> {
  const acct = (await loadAccount(env.DB))?.acct;
  const meta = acct?.own[ticker];
  if (!meta) return { results: [], unsent: null };
  const since = new Date(now.getTime() - REWRITE_DAYS * 86400_000).toISOString();
  const opened = meta.fileId?.slice(ticker.length + 1, ticker.length + 11) ?? '0000-00-00';
  const rows = (await env.DB.prepare('SELECT run_id, created_at FROM ai_runs WHERE fn = ? AND ticker = ? AND created_at >= ? AND as_of >= ? ORDER BY created_at DESC').bind(OWN_CHECK, ticker, since, opened).all<{ run_id: string; created_at: string }>()).results;
  const results: RewriteView['results'] = [];
  for (const [k, r] of rows.entries()) {
    const v = await ownCheckView(env, r.run_id, now);
    if (!v || v.mode !== 'REWRITE') continue;
    const failed = v.status === 'DONE' && !v.conditions.length;
    // 沒有結果的：之後重送過就不再列；有結果的：全部勾過就不再列
    if (failed && k > 0) continue;
    if (v.status === 'DONE' && !failed && v.conditions.every((c) => v.accepted.includes(c.condId))) continue;
    results.push({ ...v, failed });
  }
  let unsent: RewriteView['unsent'] = null;
  if (meta.fileId) {
    const log = await env.DB.prepare("SELECT at, body FROM own_thesis_log WHERE file_id = ? AND kind = 'THESIS' AND body LIKE '%\"exitLines\":[\"%' ORDER BY id DESC LIMIT 1").bind(meta.fileId).first<{ at: string; body: string }>();
    if (log) {
      const b = JSON.parse(log.body) as { exitLines?: string[]; exitActions?: CondAction[] };
      const sent = await env.DB.prepare('SELECT 1 AS x FROM ai_runs WHERE fn = ? AND ticker = ? AND created_at >= ? LIMIT 1').bind(OWN_CHECK, ticker, log.at).first();
      if (!sent && b.exitLines?.length) unsent = { at: log.at, exits: b.exitLines.map((text, k) => ({ text, action: b.exitActions?.[k] ?? 'REVIEW' })) };
    }
  }
  return { results, unsent };
}

/**
 * 使用者勾選的出場條件 → 你定的條件（origin = USER，帶勾選時間與成立時的動作；T26）。回傳寫入幾條。
 * actions：每一條成立時做什麼（沒給就帶 AI 改寫時的檔位）。會自己發通知的你定的條件一檔最多 8 條。
 */
export async function acceptOwnConditions(env: Env, ticker: string, runId: string, ids: string[], now: Date, actions: Record<string, unknown> = {}, session?: string): Promise<number> {
  const v = await ownCheckView(env, runId, now);
  if (!v || v.status !== 'DONE') throw new Error('這次改寫還沒有結果');
  const pick = v.conditions
    .filter((c) => ids.includes(c.condId) && !v.accepted.includes(c.condId))
    .map((c) => ({ ...c, action: COND_ACTIONS.includes(actions[c.condId] as CondAction) ? (actions[c.condId] as CondAction) : (c.action ?? defaultAction(c)) }));
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
