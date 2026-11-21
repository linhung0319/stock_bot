// F14：出場條件改寫（網站觸發；T27 起只留改寫模式，「請 AI 草擬前提」拿掉）。
//   「編輯論點」頁存檔、出場條件有改動時，把使用者要的完整出場條件連同監測中的條件送去改寫與對照（T42：整組取代）
//   → 持股頁列出最新一版的改寫結果（30 天內）、使用者確認：勾選的新條件開始監測，被取代的與這次沒提到的撤下。
//   使用者確認的出場條件 → own_conditions（origin = USER、有勾選時間與成立時的動作，是「你定的條件」；審查換不掉），由 F25 監測。
// T70（confirm_audit_design §2.2）：採用 stock bot 的草稿時，草稿的出場條件直接寫進條件（adoptDraftExits，origin = AI_DRAFT_ACCEPTED），
//   不走改寫與確認；之後你親手改出場條件的字，照舊走改寫與持股頁確認。
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
import { SUPERSEDABLE, checkCap, supersedeStmts } from './ownConds';
import { namedWebDomains, type ConditionDraft } from '../ai/ownReview';
import { sourceFacts } from './webEvidence';
import { loadRatings } from './webRatings';
import { ACTION_TEXT, COND_ACTIONS, LIVE_CODES, REWRITE_DAYS, acceptStatus, aiTierText, condFacts, confirmText, defaultAction, fileConditions, fileKind, fmtMetric, isAiCond, isOwned, latestExitSet, ownerText, progressText, runOfSet, thesisFile, type CondAction, type ExitSet, type FileCondition } from './thesis';

/** 改寫結果或「還沒送去改寫」不是最新一版的出場條件（T42）：不能再勾選或重送。網站回 409。 */
export class StaleExitsError extends Error {}

/** 這檔現在的論點檔編號（帳戶沒有、不是自選、T25 之前的自選 → null）。 */
async function currentFileId(db: D1Database, ticker: string): Promise<string | null> {
  return (await loadAccount(db))?.acct.own[ticker]?.fileId ?? null;
}

/** 這份論點檔最近一次出場條件有改動的那一版（T42；thesis.ts 的 latestExitSet）。沒有論點檔編號 → null。 */
export async function exitSetOf(db: D1Database, fileId: string | null | undefined): Promise<ExitSet | null> {
  if (!fileId) return null;
  const rows = (await db.prepare("SELECT id, kind, at, body FROM own_thesis_log WHERE file_id = ? AND kind IN ('THESIS', 'EXITS_CONFIRMED') ORDER BY id").bind(fileId).all<{ id: number; kind: string; at: string; body: string }>()).results;
  return latestExitSet(
    rows.map((r) => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(r.body) as Record<string, unknown>;
      } catch {
        // 壞掉的列當成空的
      }
      return { id: r.id, kind: r.kind, at: r.at, body };
    }),
  );
}

/** 整組取代的對照資料（T42）：哪一版論點、存檔時監測中的條件、文字相同的 U（U1 → 列編號）。 */
export interface ExitSetRef {
  version: number;
  live: number[];
  sameByText: Record<string, number>;
}

/**
 * 把使用者要的出場條件送去改寫（own_thesis §1.8 確認的第 2 點；own_check_v4，T42 整組取代、標 same／supersedes）。
 * 證據包帶現行的論點（note）、前提與目前監測中的條件（C）、觀察項（W），每條出場條件帶使用者選的動作。
 * set：這組出場條件是第幾版論點存的、存檔時監測中的條件（確認後撤下的範圍）；記在 rule.detail。
 */
export async function startOwnCheck(env: Env, fetcher: Fetcher, acct: Account, view: MarketView, axis: string[], ticker: string, exits: ExitLine[], now: Date, set?: ExitSetRef): Promise<AiRun> {
  if (!routineReady(env)) throw new Error('AI 層的雲端排程還沒設定（SETUP.md 的 T5），沒辦法送去改寫');
  const clean = exits.map((e) => ({ text: e.text.trim().slice(0, 300), action: COND_ACTIONS.includes(e.action) ? e.action : ('REVIEW' as CondAction) })).filter((e) => e.text).slice(0, 6);
  if (!clean.length) throw new Error('沒有要改寫的出場條件');
  const ev = await gatherOwnEvidence(env, fetcher, ticker, view.date);
  const tf = await thesisFile(env.DB, acct, ticker, view.date);
  const cf = tf ? condFacts(tf, ev.dataQuality.xbrl === 'ok' ? ev.rows : null, { live: true }) : null;
  const conds = cf?.facts ?? [];
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
    premises: ownPremises(acct, ticker, { beliefs: true }),
    condFacts: conds,
    facts,
    hits: entry?.hits ?? [],
    docs,
    dataQuality: ev.dataQuality,
    thesisVersion: meta?.thesis?.version ?? null,
    condMap: cf?.map ?? {},
    ...(set ? { exitsVersion: set.version, live: set.live, sameByText: set.sameByText } : {}),
    // 已有級別的網頁來源（T53 的清單，T68 起是種子）：只有系統預設前提的股票不給（它的審查不用網頁證據）
    ...(meta && fileKind(meta) !== 'DEFAULT_ONLY' ? { sources: sourceFacts() } : {}),
    now,
  });
  return startRun(env, fetcher, pack, now, [...ev.notes, ...(entry?.notes ?? []), ...notes]);
}

/**
 * 重送出場條件去改寫（編輯論點頁送出失敗、或改寫沒有結果時；T42）：只能重送最近一次出場條件有改動的那一版、還沒確認的；
 * 送的是那一版存下來的出場條件（不是網頁送來的）。version：網頁看到的版本（沒給 = 最新的）；不是最新的 → StaleExitsError。
 */
export async function resendOwnCheck(env: Env, fetcher: Fetcher, acct: Account, view: MarketView, axis: string[], ticker: string, version: number | null, now: Date): Promise<AiRun> {
  const set = await exitSetOf(env.DB, acct.own[ticker]?.fileId);
  if (!set || set.confirmed || !set.exits.length) throw new StaleExitsError('沒有要重送的出場條件（之後的版本改過出場條件，或已經在持股頁確認過）。請重新整理。');
  if (version !== null && version !== set.version) throw new StaleExitsError(`這是第 ${version} 版論點的出場條件；之後的第 ${set.version} 版改過出場條件，舊的不能再重送。請重新整理。`);
  return startOwnCheck(env, fetcher, acct, view, axis, ticker, set.exits, now, { version: set.version, live: set.live, sameByText: set.sameByText });
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
  /** 這組出場條件是第幾版論點存的（T42；之前的執行沒有 = null）。 */
  exitsVersion: number | null;
  /** 存檔時監測中的條件（T42：確認後撤下的範圍）。 */
  live: number[];
}

interface RewriteDetail {
  mode?: 'DRAFT' | 'REWRITE';
  exits?: ExitLine[];
  lines?: string[];
  condMap?: Record<string, number>;
  exitsVersion?: number;
  live?: number[];
  sameByText?: Record<string, number>;
}

/** 證據包裡送去改寫的出場條件（v1 只有文字，動作當成重新審查）。 */
function exitsOf(d: RewriteDetail): ExitLine[] {
  if (Array.isArray(d.exits)) return d.exits;
  return (d.lines ?? []).map((text) => ({ text, action: 'REVIEW' as CondAction }));
}
const objOf = (x: unknown): Record<string, number> => (x && typeof x === 'object' ? (x as Record<string, number>) : {});

export async function ownCheckView(env: Env, runId: string, now: Date): Promise<OwnCheckView | null> {
  const run = await getRun(env.DB, runId, now);
  if (!run || run.fn !== OWN_CHECK) return null;
  const d = (run.pack.rule.detail ?? {}) as RewriteDetail;
  const exits = exitsOf(d);
  const live = Array.isArray(d.live) ? d.live : null;
  const r = ownCheckResult(run.outcome, run.ticker ?? '', exits, objOf(d.condMap), objOf(d.sameByText), live, await loadRatings(env.DB));
  // 只算現在這份論點檔勾過的（移出再加回之後，同一次改寫的條件可以重新勾）
  const fileId = await currentFileId(env.DB, run.ticker ?? '');
  const accepted = (await env.DB.prepare(`SELECT cond_id FROM own_conditions WHERE run_id = ? AND origin = 'USER' AND ${fileId ? 'file_id = ?' : 'file_id IS NULL'}`).bind(runId, ...(fileId ? [fileId] : [])).all<{ cond_id: string }>()).results.map((x) => x.cond_id);
  const mode = d.mode === 'DRAFT' ? 'DRAFT' : 'REWRITE';
  return { ...r, runId, status: run.status, mode, accepted, exits, createdAt: run.createdAt, outcome: run.status === 'PENDING' || !run.outcome ? 'PENDING' : run.outcome.status, exitsVersion: typeof d.exitsVersion === 'number' ? d.exitsVersion : null, live: live ?? [] };
}

/** 持股頁列出多少天內的改寫結果（own_thesis §1.8 確認的第 4 點；定義在 thesis.ts，「要看的事」也用）。 */
export { REWRITE_DAYS };

/**
 * 確認一份改寫結果會做什麼（純函式，T42，own_thesis §1.8 確認的第 4 點）：
 *   same（和監測中的一條相同）→ 不新增、舊的保留；動作和現在的不同時改動作
 *   supersedes → 勾選了這一條，被取代的撤下（沒勾就照舊監測）
 *   存檔時監測中、現在也還在監測的條件裡，沒有被 same 或 supersedes 指到的 → 撤下（不管勾不勾）
 * picked：使用者勾選的條件編號（condId）；不給 = 全部新的都勾（持股頁顯示用）。
 */
export function confirmPlan(conditions: OwnCheckResult['conditions'], scope: number[], conds: FileCondition[], picked?: string[]): {
  pick: OwnCheckResult['conditions'];
  sups: Map<string, FileCondition>;
  retire: FileCondition[];
  actionChanges: { cond: FileCondition; action: CondAction }[];
} {
  const live = conds.filter((c) => isOwned(c) && LIVE_CODES.includes(c.status));
  const fresh = conditions.filter((c) => c.same === null);
  const pick = picked ? fresh.filter((c) => picked.includes(c.condId)) : fresh;
  const sups = new Map<string, FileCondition>();
  for (const c of pick) {
    const old = c.supersedes ? conds.find((x) => x.id === c.supersedes && SUPERSEDABLE.includes(x.status)) : undefined;
    if (old) sups.set(c.condId, old);
  }
  const pointed = new Set(conditions.flatMap((c) => [c.same, c.supersedes]).filter((x): x is number => x !== null));
  const retire = live.filter((c) => scope.includes(c.id) && !pointed.has(c.id));
  const actionChanges = conditions.flatMap((c) => {
    const cond = c.same === null ? undefined : live.find((x) => x.id === c.same);
    return cond && cond.action && cond.action !== c.action ? [{ cond, action: c.action }] : [];
  });
  return { pick, sups, retire, actionChanges };
}

export interface RewriteResultView extends OwnCheckView {
  failed: boolean;
  /** 條件編號（condId）→ 勾選後會取代的那一條的文字（supersedes 指到的條件還在監測、只記錄或建議中時才有）。 */
  replaces: Record<string, string>;
  /** 條件編號 → 和它相同的那一條監測中的條件（T42：不新增，舊的保留；actionTo 是確認後改成的動作）。 */
  sames: Record<string, { text: string; actionTo: CondAction | null }>;
  /** 確認後會撤下的（存檔時監測中、這次的出場條件沒有提到；T42）。 */
  retire: { id: number; text: string }[];
  /** 送去改寫、但 AI 沒有改寫出來的出場條件（不會監測）。 */
  unmatched: ExitLine[];
}

export interface RewriteView {
  /**
   * 最近一次出場條件有改動的那一版（T42）、30 天內的改寫：還在改寫中的、要你確認的、沒有結果而且之後沒有重送過的。新的在前。
   * 之前版本的改寫結果不列；那一版確認過之後也不列。全部都和現有條件相同、也沒有要撤下或改動作的，不列（不用確認）。
   */
  results: RewriteResultView[];
  /** 存了論點、出場條件卻還沒送去改寫（送出失敗或 AI 層沒設定；N9）：那一版的出場條件與版本。 */
  unsent: { at: string; exits: ExitLine[]; version: number } | null;
  /** 那一版把出場條件全部拿掉（T42）：確認後撤下這些（不用 AI）。 */
  dropAll: { at: string; version: number; retire: { id: number; text: string }[] } | null;
}

/**
 * 持股頁的改寫結果（own_thesis §1.8 確認的第 3、4 點；修 N9；T42 跟著論點版本走）：只看最近一次出場條件有改動的那一版、還沒確認的；
 * 改寫沒有結果、出場條件還沒送出去，都要有提示與「重送」。
 */
export async function rewriteView(env: Env, ticker: string, now: Date): Promise<RewriteView> {
  const none: RewriteView = { results: [], unsent: null, dropAll: null };
  const acct = (await loadAccount(env.DB))?.acct;
  const meta = acct?.own[ticker];
  if (!acct || !meta) return none;
  const set = await exitSetOf(env.DB, meta.fileId);
  if (!set || set.confirmed) return none;
  const conds = await fileConditions(env.DB, acct, ticker);
  const text = (id: number) => conds.find((c) => c.id === id)?.text ?? '';
  if (!set.exits.length) {
    const retire = confirmPlan([], set.live, conds).retire.map((c) => ({ id: c.id, text: c.text }));
    return { ...none, dropAll: retire.length ? { at: set.at, version: set.version, retire } : null };
  }
  const since = new Date(now.getTime() - REWRITE_DAYS * 86400_000).toISOString();
  const opened = meta.fileId?.slice(ticker.length + 1, ticker.length + 11) ?? '0000-00-00';
  const rows = (await env.DB.prepare('SELECT run_id, created_at FROM ai_runs WHERE fn = ? AND ticker = ? AND created_at >= ? AND as_of >= ? ORDER BY created_at DESC').bind(OWN_CHECK, ticker, set.at, opened).all<{ run_id: string; created_at: string }>()).results;
  const results: RewriteView['results'] = [];
  let sent = false;
  let k = 0;
  for (const r of rows) {
    const v = await ownCheckView(env, r.run_id, now);
    if (!v || v.mode !== 'REWRITE' || !runOfSet(set, { exitsVersion: v.exitsVersion }, v.createdAt)) continue;
    sent = true;
    const first = k++ === 0;
    if (r.created_at < since) continue;
    const failed = v.status === 'DONE' && !v.conditions.length;
    // 沒有結果的：之後重送過就不再列
    if (failed && !first) continue;
    const plan = confirmPlan(v.conditions, set.live, conds);
    const replaces: Record<string, string> = {};
    for (const [id, old] of plan.sups) replaces[id] = old.text;
    const sames: RewriteResultView['sames'] = {};
    for (const c of v.conditions) if (c.same !== null) sames[c.condId] = { text: text(c.same), actionTo: plan.actionChanges.find((a) => a.cond.id === c.same)?.action ?? null };
    // 全部都和現有條件相同、也沒有要撤下或改動作的：不用確認
    if (v.status === 'DONE' && !failed && !plan.pick.length && !plan.retire.length && !plan.actionChanges.length) continue;
    const lines = new Set(v.conditions.map((c) => c.line));
    results.push({ ...v, failed, replaces, sames, retire: plan.retire.map((c) => ({ id: c.id, text: c.text })), unmatched: v.status === 'DONE' && !failed ? v.exits.filter((_, i) => !lines.has(i)) : [] });
  }
  return { results, unsent: sent ? null : { at: set.at, exits: set.exits, version: set.version }, dropAll: null };
}

export interface ConfirmResult {
  /** 開始監測幾條。 */
  added: number;
  /** 撤下的條件（被取代的與這次沒提到的）。 */
  retired: number[];
  /** 改了成立時動作的條件（和現有條件相同、動作不同的）。 */
  actionChanged: number[];
}

const retireNote = (date: string, version: number) => `你在 ${date} 確認第 ${version} 版論點的出場條件時撤下（這次的出場條件沒有提到）`;

/**
 * 確認改寫結果（own_thesis §1.8 確認的第 4 點；T42 整組取代）：勾選的新條件 → 你定的條件（origin = USER，帶勾選時間與成立時的動作）；
 * 被取代的（勾選了取代它的那一條）與這次沒提到的撤下（RETIRED，log 寫原因）；和現有條件相同、動作不同的改動作。log 寫 EXITS_CONFIRMED。
 * 只能確認最近一次出場條件有改動的那一版、還沒確認過的（不是 → StaleExitsError）。會自己發通知的你定的條件一檔最多 8 條。
 */
export async function acceptOwnConditions(env: Env, ticker: string, runId: string, ids: string[], now: Date, actions: Record<string, unknown> = {}, session?: string): Promise<ConfirmResult> {
  const v = await ownCheckView(env, runId, now);
  if (!v || v.status !== 'DONE') throw new Error('這次改寫還沒有結果');
  const acct = (await loadAccount(env.DB))?.acct;
  if (!acct?.own[ticker]) throw new Error(`${ticker} 不是自選股`);
  const fileId = acct.own[ticker].fileId ?? null;
  const set = await exitSetOf(env.DB, fileId);
  if (!set || !runOfSet(set, { exitsVersion: v.exitsVersion }, v.createdAt)) throw new StaleExitsError('這份改寫結果是之前版本的論點送的；之後的版本改過出場條件，不能再勾選。請看持股頁最新的那一份。');
  if (set.confirmed) throw new StaleExitsError('這一版的出場條件已經確認過了。');
  const conds = await fileConditions(env.DB, acct, ticker);
  const plan = confirmPlan(v.conditions, set.live, conds, ids);
  // T68（confirm_audit_design §1.6）：勾選時不再選網頁來源；條件寫的 web:<網域> 原樣存，能不能確認看審查時那個網域的級別
  const pick = plan.pick.map((c) => ({ ...c, action: COND_ACTIONS.includes(actions[c.condId] as CondAction) ? (actions[c.condId] as CondAction) : (c.action ?? defaultAction(c)) }));
  if (!pick.length && !plan.retire.length && !plan.actionChanges.length) throw new Error('至少勾一條');
  checkCap(
    conds,
    pick.filter((c) => acceptStatus({ kind: c.kind, check: c.check, auto: !c.manual, status: 'PROPOSED' }) !== 'MANUAL').length,
    [...plan.sups.values(), ...plan.retire].map((x) => x.id),
  );
  const at = now.toISOString();
  const ses = session ?? at.slice(0, 10);
  const log = (kind: 'CONDITION' | 'EXITS_CONFIRMED', ref: string, body: Record<string, unknown>) => (fileId ? [thesisLogStmt(env.DB, { ticker, fileId, session: ses, kind, ref, body }, null, at)] : []);
  const res = pick.length ? await env.DB.batch(insertConditionStmts(env.DB, ticker, runId, pick.map((c) => ({ ...c, supersedes: plan.sups.get(c.condId)?.id ?? null })), at, 'USER', fileId)) : [];
  const after: D1PreparedStatement[] = [];
  const retired: number[] = [];
  res.forEach((r, k) => {
    after.push(...log('CONDITION', String(r.meta.last_row_id), { id: r.meta.last_row_id, change: 'ACCEPTED', action: pick[k].action, by: 'USER' }));
    // 帶 supersedes 的（T40）：被取代的那一條撤下，和勾選 AI 建議時的取代同一套（ownConds.ts）
    const old = plan.sups.get(pick[k].condId);
    if (old) {
      after.push(...supersedeStmts(env.DB, ticker, fileId ?? undefined, ses, at, old, pick[k].text));
      retired.push(old.id);
    }
  });
  // 這次的出場條件沒有提到的（T42）：確認時撤下，log 寫原因
  for (const c of plan.retire) {
    after.push(env.DB.prepare("UPDATE own_conditions SET status = 'RETIRED', note = ? WHERE id = ? AND status IN ('ACTIVE', 'REVIEW_ONLY', 'MANUAL')").bind(retireNote(ses, set.version), c.id));
    after.push(...log('CONDITION', String(c.id), { id: c.id, change: 'RETIRED', action: c.action, by: 'USER', reason: 'NOT_IN_EXITS', version: set.version }));
    retired.push(c.id);
  }
  // 和現有條件相同、成立時的動作不同的：改動作（沿用 ACTION_CHANGED）
  for (const a of plan.actionChanges) {
    after.push(env.DB.prepare('UPDATE own_conditions SET action = ? WHERE id = ?').bind(a.action, a.cond.id));
    after.push(...log('CONDITION', String(a.cond.id), { id: a.cond.id, change: 'ACTION_CHANGED', action: a.action, by: 'USER' }));
  }
  const accepted = res.map((r) => r.meta.last_row_id);
  after.push(...log('EXITS_CONFIRMED', runId, { runId, version: set.version, accepted, retired, actionChanged: plan.actionChanges.map((a) => a.cond.id) }));
  if (after.length) await env.DB.batch(after);
  return { added: pick.length, retired, actionChanged: plan.actionChanges.map((a) => a.cond.id) };
}

/**
 * 那一版把出場條件全部拿掉（T42）：使用者在持股頁確認後，存檔時監測中、現在也還在監測的條件撤下（不用 AI）。log 寫 EXITS_CONFIRMED。
 * version 要是最近一次出場條件有改動的那一版、還沒確認、而且那一版的出場條件是空的（不是 → StaleExitsError）。
 */
export async function confirmDropAll(env: Env, ticker: string, version: number, now: Date, session?: string): Promise<ConfirmResult> {
  const acct = (await loadAccount(env.DB))?.acct;
  if (!acct?.own[ticker]) throw new Error(`${ticker} 不是自選股`);
  const fileId = acct.own[ticker].fileId ?? null;
  const set = await exitSetOf(env.DB, fileId);
  if (!set || set.version !== version || set.exits.length) throw new StaleExitsError('之後的版本改過出場條件，這個確認不適用了。請重新整理。');
  if (set.confirmed) throw new StaleExitsError('這一版的出場條件已經確認過了。');
  const conds = await fileConditions(env.DB, acct, ticker);
  const retire = confirmPlan([], set.live, conds).retire;
  const at = now.toISOString();
  const ses = session ?? at.slice(0, 10);
  const stmts: D1PreparedStatement[] = [];
  for (const c of retire) {
    stmts.push(env.DB.prepare("UPDATE own_conditions SET status = 'RETIRED', note = ? WHERE id = ? AND status IN ('ACTIVE', 'REVIEW_ONLY', 'MANUAL')").bind(retireNote(ses, version), c.id));
    if (fileId) stmts.push(thesisLogStmt(env.DB, { ticker, fileId, session: ses, kind: 'CONDITION', ref: String(c.id), body: { id: c.id, change: 'RETIRED', action: c.action, by: 'USER', reason: 'NOT_IN_EXITS', version } }, null, at));
  }
  if (fileId) stmts.push(thesisLogStmt(env.DB, { ticker, fileId, session: ses, kind: 'EXITS_CONFIRMED', ref: `v${version}`, body: { runId: null, version, accepted: [], retired: retire.map((c) => c.id), actionChanged: [] } }, null, at));
  if (stmts.length) await env.DB.batch(stmts);
  return { added: 0, retired: retire.map((c) => c.id), actionChanged: [] };
}

/** 採用草稿時撤下的那一條的說明（T70）。 */
const adoptRetireNote = (date: string, version: number) => `你在 ${date} 採用 stock bot 的草稿（第 ${version} 版論點）時撤下（草稿的出場條件沒有這一條）`;

/** 採用草稿時寫進條件的一條（ownDraft.ts 的 AdoptExit 換成條件的形狀；premiseId 是存檔後對應的前提編號）。 */
export type AdoptCondition = ConditionDraft & { action: CondAction; premiseId: string | null };

/**
 * 採用 stock bot 的草稿時，草稿的出場條件直接寫進條件（T70，confirm_audit_design §2.2）：不送改寫、不到持股頁確認。
 *   add → own_conditions（origin = AI_DRAFT_ACCEPTED、accepted_at = 採用的時間、成立時的動作照草稿；狀態照確認方式：
 *         財報門檻與申報確認的事件條件監測中、只有法說會／新聞／網頁的只在審查時檢查、價格只記錄）。log 寫 CONDITION（by DRAFT）。
 *   actionChanges → 和監測中的一條字一樣、沿用那一條，動作改成草稿的。
 *   retire → 監測中、草稿裡沒有的（T42 整組取代：草稿就是存檔後要的全部出場條件）撤下，log 寫原因。
 *   confirm → 這一版不用再確認（沒有要送改寫的）：log 寫 EXITS_CONFIRMED，持股頁不會列「還沒送去改寫」。
 * runId：草稿那一次執行（寫進條件的 run_id）；version：存成第幾版論點。
 */
export async function adoptDraftExits(env: Env, ticker: string, inp: { runId: string; version: number; add: AdoptCondition[]; actionChanges: { id: number; action: CondAction }[]; retire: number[]; confirm: boolean }, now: Date, session?: string): Promise<ConfirmResult> {
  const acct = (await loadAccount(env.DB))?.acct;
  if (!acct?.own[ticker]) throw new Error(`${ticker} 不是自選股`);
  const fileId = acct.own[ticker].fileId ?? null;
  const at = now.toISOString();
  const ses = session ?? at.slice(0, 10);
  const log = (kind: 'CONDITION' | 'EXITS_CONFIRMED', ref: string, body: Record<string, unknown>) => (fileId ? [thesisLogStmt(env.DB, { ticker, fileId, session: ses, kind, ref, body }, null, at)] : []);
  const res = inp.add.length ? await env.DB.batch(insertConditionStmts(env.DB, ticker, inp.runId, inp.add, at, 'AI_DRAFT_ACCEPTED', fileId)) : [];
  const accepted = res.map((r) => r.meta.last_row_id);
  const after: D1PreparedStatement[] = [];
  accepted.forEach((id, k) => after.push(...log('CONDITION', String(id), { id, change: 'ACCEPTED', action: inp.add[k].action, by: 'DRAFT', runId: inp.runId })));
  const retired: number[] = [];
  for (const id of inp.retire) {
    after.push(env.DB.prepare("UPDATE own_conditions SET status = 'RETIRED', note = ? WHERE id = ? AND status IN ('ACTIVE', 'REVIEW_ONLY', 'MANUAL')").bind(adoptRetireNote(ses, inp.version), id));
    after.push(...log('CONDITION', String(id), { id, change: 'RETIRED', by: 'USER', reason: 'DRAFT_ADOPTED', version: inp.version }));
    retired.push(id);
  }
  for (const a of inp.actionChanges) {
    after.push(env.DB.prepare('UPDATE own_conditions SET action = ? WHERE id = ?').bind(a.action, a.id));
    after.push(...log('CONDITION', String(a.id), { id: a.id, change: 'ACTION_CHANGED', action: a.action, by: 'DRAFT' }));
  }
  if (inp.confirm) after.push(...log('EXITS_CONFIRMED', inp.runId, { runId: null, draftRunId: inp.runId, by: 'DRAFT', version: inp.version, accepted, retired, actionChanged: inp.actionChanges.map((a) => a.id) }));
  if (after.length) await env.DB.batch(after);
  return { added: accepted.length, retired, actionChanged: inp.actionChanges.map((a) => a.id) };
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
  /** 你定的條件（勾選過、改過動作、採用草稿、或你自己寫的）。 */
  owned: boolean;
  /**
   * AI 監測中的（T71，confirm_audit_design §3）：審查三票一致建議、寫入就監測、你沒動過的（含已成立的、舊資料的建議中）。
   * 持股頁分兩組：你定的、AI 監測中（成立時重新審查）。
   */
  ai: boolean;
  /** AI 監測中的：「AI 建議成立時減半；目前設定是重新審查」（tier_if_met 照存，只顯示）。其他是 null。 */
  aiTier: string | null;
  /** AI 監測中、有 supersedes 指到你一條還在監測的條件的：那一條的字（改成出清或減半、變成你定的時會取代它）。 */
  replaces: string | null;
  /** 你定的：成立時做什麼；AI 監測中的：重新審查；舊資料的建議中：勾選時預設的動作（AI 建議的檔位）。 */
  action: CondAction | null;
  actionText: string | null;
  /** 怎麼確認。 */
  confirm: string;
  /** 財報類條件的進度（§3.6.2）。 */
  progress: string | null;
  /**
   * 進度條（T34，§3.6.2「畫成條由 T34 決定」）：要連續 N 季（N ≥ 2）的財報條件才有。一季一段，最新的在右邊；
   * labels：每一段的字（那一季的數值，還沒到的季寫「下一季」）；done：已連續符合幾季（從最新一季往回數）。
   */
  steps: { need: number; done: number; labels: string[] } | null;
  /** 只記錄、不會通知（價格條件、沒通過格式檢查的）：畫面不給選成立時的動作。 */
  recordOnly: boolean;
  /** 說明（已成立的寫怎麼確認成立的；其他是寫入時的原因）。 */
  note: string | null;
  /** 指名的網頁來源（網域；T53）。T68 起勾選時不能改來源（選單拿掉），級別寫在 confirm 裡。 */
  web: string[];
}

const md = (iso: string | null) => (iso ? `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}` : '');
/** 已成立的條件怎麼確認的（白話，不放執行編號）。 */
function metNote(c: { metAt: string | null; metBasis: string | null }): string {
  const d = md(c.metAt);
  if (c.metBasis === 'XBRL') return `${d} 新財報出來，程式比對成立`;
  if (c.metBasis === 'FILING_VOTE') return `${d} 新申報的原文，AI 3 票確認成立`;
  if (c.metBasis === 'REVIEW_VOTE') return `${d} 的定期審查，AI 3 票確認成立`;
  if (c.metBasis === 'WEB_VOTE') return `${d} 的定期審查，AI 3 票依你指名的網頁來源確認成立`;
  if (c.metBasis === 'PRESS') return `${d} 依財報新聞稿成立（10-Q 出來後再核對）`;
  return `${d} 成立`;
}

/**
 * 進度條的每一段（T34）：要連續 need 季，從最新一季往回已連續 done 季符合。左到右是時間順序，最右邊一段是最新一季；
 * 還沒符合的段落在右邊、寫「下一季」（要再符合幾季才成立）。
 */
export function progressSteps(c: Pick<FileCondition, 'progress' | 'check'>): MonitorRow['steps'] {
  const p = c.progress;
  if (!p || p.need < 2) return null;
  const metric = String(c.check.metric);
  const done = Math.min(p.streak, p.need);
  const labels = [...Array.from({ length: done }, (_, k) => fmtMetric(metric, p.values[done - 1 - k] ?? null)), ...Array.from({ length: p.need - done }, (_, k) => (k === 0 ? '下一季' : k === 1 ? '再下一季' : `之後第 ${k + 1} 季`))];
  return { need: p.need, done, labels };
}

const STATUS_TEXT: Record<string, string> = { ACTIVE: '監測中', MET: '已成立', MANUAL: '只記錄', REVIEW_ONLY: '只在定期審查時檢查', PROPOSED: '建議中', RETIRED: '已撤下', EXPIRED: '已過期', REPLACED: '已替換' };

/** 持股頁要顯示的條件：你定的（監測中、只在審查時檢查、只記錄、已成立）與 AI 監測中的（T71；含舊資料的建議中）；撤下與過期的不列。 */
export async function monitorView(env: Env, ticker: string): Promise<MonitorRow[]> {
  try {
    const acct = (await loadAccount(env.DB))?.acct;
    // 「怎麼確認」寫指名的來源的級別（T68，confirm_audit_design §1.6）；只有系統預設前提的股票審查不取網頁（G24：寫明）
    const ratings = await loadRatings(env.DB);
    const defaultOnly = !acct?.own[ticker] || fileKind(acct.own[ticker]) === 'DEFAULT_ONLY';
    const goneNote = (c: FileCondition): string => {
      if (c.kind !== 'EVENT' || !['ACTIVE', 'REVIEW_ONLY', 'PROPOSED'].includes(c.status) || acceptStatus(c) === 'MANUAL') return '';
      return defaultOnly && namedWebDomains(c.check).length ? '（這檔只有系統預設前提，審查不取網頁；寫下你自己的前提之後才會用這個來源）' : '';
    };
    const all = acct ? await fileConditions(env.DB, acct, ticker) : [];
    return all
      .filter((c) => c.status !== 'RETIRED' && c.status !== 'EXPIRED')
      .map((c) => {
        const owned = isOwned(c) && c.status !== 'PROPOSED';
        const ai = !owned && isAiCond(c);
        // AI 監測中的（T71）：成立時的動作固定是重新審查；舊資料的建議中照舊帶 AI 建議的檔位（勾選時的預設）
        const action = owned ? c.action : c.status === 'PROPOSED' ? defaultAction(c) : (c.action ?? 'REVIEW');
        const sup = ai && c.status !== 'PROPOSED' && c.supersedes ? all.find((x) => x.id === c.supersedes && isOwned(x) && LIVE_CODES.includes(x.status)) : undefined;
        return {
          id: c.id,
          text: c.text,
          kind: { XBRL: '財報', EVENT: '事件', PRICE: '價格' }[c.kind] ?? c.kind,
          origin: ownerText(c),
          status: STATUS_TEXT[c.status] ?? c.status,
          code: c.status,
          owned,
          ai,
          aiTier: ai && c.status !== 'PROPOSED' ? aiTierText(c) : null,
          replaces: sup ? sup.text : null,
          action,
          actionText: action ? ACTION_TEXT[action] : null,
          confirm: confirmText(c, ratings) + goneNote(c),
          progress: progressText(c),
          steps: progressSteps(c),
          recordOnly: acceptStatus(c) === 'MANUAL',
          note: c.status === 'MET' ? metNote(c) : c.note,
          web: c.kind === 'EVENT' ? namedWebDomains(c.check) : [],
        };
      });
  } catch (e) {
    return [{ id: 0, text: `讀不到：${errText(e)}`, kind: '', origin: '', status: '', code: '', owned: false, ai: false, aiTier: null, replaces: null, action: null, actionText: null, confirm: '', progress: null, steps: null, recordOnly: false, note: null, web: [] }];
  }
}
