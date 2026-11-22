// T55：論點草稿任務（OWN_DRAFT，web_evidence_design §2.2、§2.4 第 6 點、§2.5）。證據包的組法、時機與上限、own_drafts 表。
// T56：草稿的畫面與同意流程用到的部分也在這裡——每檔的草稿狀態（網站的按鈕）、讀草稿、用過（USED）／不用（DISMISSED）、
//   使用者按的草稿回來或失敗時推 LINE 一行（pushDraftLines）。
// T70（confirm_audit_design §2）：逐條勾選改成一鍵採用——整份照草稿存（draftAdoptPlan：前提、出場條件；adoptPeers：同業），
//   存檔照現有的論點存檔（src/app/site/api.ts 的 saveThesis，帶採用的資料）；出場條件直接寫進條件（ownCheckAi.ts 的 adoptDraftExits）。
//
//   時機（§2.5）：
//     新的自選（新的 fileId）→ 每日第一次流程自動開一次（每份論點檔只自動一次；失敗時下一次流程自動重試一次，G22）。
//       在那之前使用者已經自己存了論點（或寫了自己的前提）→ 不開；有還沒回覆的乙類通知 → 不開；開檔超過 7 天的不再補開。
//     使用者按「請 stock bot 草擬」→ 立刻開；每檔 7 個日曆天最多 1 次（失敗的不算）；有還在跑的不重開。
//       有還沒回覆的乙類通知時照樣可以按：草稿最上面固定寫那句話、不能沿用被判不成立的那一條（程式檢查，src/ai/ownDraft.ts）。
//     定期：不做（§2.4 第 5 點）。
//     T72（confirm_audit_design §5）：「要看的事」的七種觸發（減半中沒有出場條件、同一件新風險出現兩次、前提一直沒驗到、前提證據不足、
//       審查沒有一致結論、只有系統預設前提、論點滿一年）→ 每日第一次流程自動開（startTriggerDrafts）。同一個鍵只開一次（own_drafts.attn_keys；
//       失敗的重試一次）、每檔 7 天一次（和手動共用）、同一天最多 2 檔（照優先順序，其餘之後還成立再開）；有還沒回覆的乙類、
//       30 天內有前提被判不成立時不開。自動開的不推 LINE。
//   結果：結果送回時（index.ts 收下結果之後）與每日流程套用時都會結算：PENDING → READY（檢查過的草稿）或 FAILED（原因）。
//     新的 READY 回來時同一檔舊的 READY 標 EXPIRED；READY 30 天沒處理 → EXPIRED。
//     自動開的連續 2 次失敗 → 告警 DRAFT_FAILED（G22）；使用者按的：回來（READY）或失敗推 LINE 一行，網站的按鈕旁邊寫原因與「再試一次」（T56）。
//   還在跑的不重開要原子（T56）：開執行之前先佔一列 PENDING，同一檔同時只能有一列（migration 0020 的部分唯一索引），兩個分頁同時按第二個會 409。
//   T85 丙段（allocation_redesign §4.5 第 18～20 點）：候補也可以草擬（startOwnDraft、requestOwnDraft 走 fileMeta）。
//     自動：加入候補 7 天內、還沒有論點、這份論點檔沒有成功或還在跑的草稿、自動的失敗不到 2 次、上一份論點檔的前提 30 天內沒有被判不成立
//     （ownClosed.brokenAt）→ 每日第一次流程開一次，受 DRAFT_AUTO_DAILY 限制（一次加 5 檔會分幾天開）。T72 的七種觸發對候補不開。
//     證據包：R1「還沒持有（候補）」、R2 打算放的比重、R4 自選合計與預算（沒有 R3）；輸出多 entries（進場條件）。
//     一鍵採用：entries 接在出場、加碼條件後面一起整組取代（只換非價格的進場條件；你填的價格條件不在範圍內）。
import { OWN_DRAFT, draftEventCheck, draftResult, ownDraftPack, type DraftBroken, type DraftPeer, type DraftPremise, type OwnDraft, brokenNotice } from '../ai/ownDraft';
import { normalizeText, type EvidencePack, type PackDoc } from '../ai/check';
import { discussionNumbers, planExits, type LiveCondition } from '../ai/discussion';
import type { ExitLine } from '../ai/ownCheck';
import { FRESH_FNS, parseNewRisks } from '../ai/freshEyes';
import { newRunId, ownPremises, priceDoc, priceFacts } from '../ai/pack';
import { XBRL_METRICS } from '../data/edgar';
import { errText } from '../data/util';
import { breaksOf, fileMeta, normVerify, ownHeld, watchRecWeight, type Account, type MarketView, type OwnMeta, type PremiseInput, type PremiseVerify, type ThesisMeta, type WebPeer, type WebSourceCheck } from '../engine';
import { loadAccount } from './ledgerStore';
import { lineConfigured, lineUrl, pushLine } from './line';
import type { ApplyCtx, StartCtx } from './aiCtx';
import { getRun, startRun, type AiRun } from './aiRuns';
import type { Env, Fetcher } from './env';
import { gatherOwnEvidence, reviewThesisEvidence, routineReady } from './ownAi';
import { AUTO_KEY_TRIES, BROKEN_QUIET_DAYS, DRAFT_EXPIRE_DAYS, OWNED_LIVE, isEntryAction, acceptStatus, autoKeyUsed, condFacts, draftKeyOf, draftTriggers, draftUntil, fileKind, loadPrevFile, recentBroken, thesisFile, triggerRank, type CondAction, type PrevFile, type ThesisFile } from './thesis';
import { buildDocMenu, sourceFacts } from './webEvidence';
import type { DocCtx } from '../ai/added';

type Fact = EvidencePack['facts'][number];
const METRICS = new Set(Object.keys(XBRL_METRICS));

/** 使用者按的草稿：每檔幾個日曆天最多 1 次（§2.5、第 6 章第 11 項）。 */
export const DRAFT_GAP_DAYS = 7;
/** 新的自選：開檔後幾個日曆天內還會補開自動的那一次（當天的流程沒開成時；之後不再補）。 */
export const DRAFT_AUTO_WINDOW_DAYS = 7;
/** 自動的那一次最多試幾次（第一次＋失敗時重試一次，G22）；到這個次數都失敗 → 告警。 */
export const DRAFT_AUTO_TRIES = 2;
/** READY 幾天沒處理 → EXPIRED（§2.3）。數字定義在 thesis.ts（「要看的事」的 DRAFT_READY 也用；這裡 import 會循環）。 */
export { DRAFT_EXPIRE_DAYS };
/** 使用者按的草稿回來或失敗之後幾天內還會推 LINE（推失敗時下一次流程重推；超過就不推了，網站照樣看得到）。 */
export const DRAFT_PUSH_DAYS = 3;

export type DraftStatus = 'PENDING' | 'READY' | 'USED' | 'DISMISSED' | 'EXPIRED' | 'FAILED';
export type DraftTrigger = 'AUTO' | 'MANUAL';

export interface DraftRow {
  id: number;
  ticker: string;
  file_id: string | null;
  run_id: string;
  trigger: DraftTrigger;
  session: string;
  created_at: string;
  status: DraftStatus;
  payload: string | null;
  based_on_version: number;
  broken: string | null;
  error: string | null;
  settled_at: string | null;
  updated_at: string | null;
  /** T56：推 LINE 的時間（SYNC = 按下去當場就失敗、網站已經寫了，不推；SKIP = 之後又按了一次，舊的失敗不推）。舊列沒有這一欄。 */
  pushed_at?: string | null;
  /** T56：存檔時用了這份草稿的哪些（USED 才有）。 */
  used_json?: string | null;
  /** T72：「要看的事」觸發的自動草稿是哪幾件（JSON 字串陣列）；新自選的那一次與使用者按的是 null。舊列沒有這一欄。 */
  attn_keys?: string | null;
}

/** 使用者按的草稿開不成（網站回 status）：還在跑 409、7 天內已經草擬過 409、不是自選 422、雲端排程沒設定 400。 */
export class DraftError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const DAY = 86400_000;
const NOT_FILE = (t: string) => `${t} 不在自選裡，也不在候補名單裡`;
const md = (iso: string) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;
const daysApart = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);

/**
 * 這檔還沒回覆的乙類通知（§2.4 第 6 點）：最新的那一則、被判不成立的前提與它現在的文字。
 * 和網站的 pendingBreakOf 同一個定義：附在慢規則減半項目上的「AI 建議出清」（withRule）不算獨立的乙類通知。
 */
export function pendingBreak(acct: Pick<Account, 'notifs' | 'own'>, ticker: string): DraftBroken | null {
  for (const n of [...acct.notifs].reverse()) {
    if (n.status !== 'PENDING') continue;
    const it = n.items.find((i) => i.ticker === ticker && i.brk?.type === 'B' && !i.brk.withRule && !i.cancelled);
    if (it?.brk?.type !== 'B') continue;
    const pid = it.brk.premiseId;
    return { premiseId: pid, text: acct.own[ticker]?.premises.find((p) => p.id === pid)?.text ?? '', notif: n.id, notice: brokenNotice(pid) };
  }
  return null;
}

/** 已經有論點：使用者存過論點（任何一版），或前提裡有自己的（§2.5「在那之前使用者已經自己存了論點 → 不開」）。 */
export const hasThesis = (meta: ThesisMeta): boolean => !!meta.thesis || fileKind(meta) === 'THESIS';

/**
 * 開始持有的訊號日：從候補進場的看 heldSince（allocation_redesign §4.5 第 4 點），其他看論點檔編號 `<代號>@<日期>`；沒有編號是 null。
 * 候補（沒有 heldSince 欄位）就是加入候補那天。
 */
const openedOf = (ticker: string, meta: Pick<OwnMeta, 'fileId' | 'heldSince'> | null | undefined): string | null => {
  if (meta?.heldSince) return meta.heldSince;
  const fileId = meta?.fileId;
  return fileId && fileId.startsWith(`${ticker}@`) ? fileId.slice(ticker.length + 1, ticker.length + 11) : null;
};

/** 上一份論點檔（賣光再買回，T44）→ 一份背景 note。沒有論點的不放。 */
export function prevFileDoc(prev: PrevFile | null, ticker: string, asOf: string): PackDoc | null {
  if (!prev?.hasThesis) return null;
  const L = [`上一份論點檔 ${prev.fileId}（${prev.openedAt ?? '開檔日不明'} 開檔 → ${prev.closedAt} ${prev.closedVerb}；${prev.reasonText}）。這一份是背景：使用者當時寫的，不是證據。`, ''];
  L.push(prev.thesis ? `論點（${prev.thesis.setAt} 定，第 ${prev.thesis.version} 版）：\n${prev.thesis.text}` : '論點本文：沒有寫。');
  if (prev.premises.length) L.push('', '前提：', ...prev.premises.map((p) => `- ${p.id} ${p.text}`));
  if (prev.conditions?.length) L.push('', '當時的出場條件：', ...prev.conditions.map((c) => `- ${c.text}（${c.state === 'MET' ? c.note : `成立時：${c.action === 'EXIT' ? '出清' : c.action === 'HALF' ? '減半' : '重新審查'}；${c.note}`}）`));
  return { id: `Q-${ticker}`, source_id: `prev:${prev.fileId}`, kind: 'note', date: asOf, title: `${ticker} 上一份論點檔（背景，使用者當時寫的）`, text: L.join('\n') };
}

/** 草稿的證據包帶幾天內、最多幾件新眼光提出的風險（T69，confirm_audit_design §4）。 */
export const DRAFT_RISK_DAYS = 180;
export const DRAFT_RISK_MAX = 6;
const RISK_QUOTE_MAX = 300;
const FN_TEXT: Record<string, string> = { OWN_REVIEW: '定期審查', OWN_DROP: '減半檢視' };

/** ai_runs 裡讀新眼光結果的那幾欄。 */
export interface RiskRunRow {
  run_id: string;
  fn: string;
  as_of: string;
  created_at: string;
  new_risks: string | null;
}

/**
 * 「最近 180 天審查的新眼光提出的風險」那一份 note（T69，confirm_audit_design §4）。只放草稿的證據包：
 * 審查與減半檢視的證據包不放（新眼光是刻意不看前提的角色，審查也不需要；判的人看不到出題的過程）。
 *   資料：這檔的 ai_runs.new_risks（新眼光有跑的定期審查與減半檢視），只取通過程式檢查的那幾條。
 *   決策日往前 180 天內（含決策日）、新的在前（決策日、開執行的時間）；同一次執行裡照新眼光寫的順序。
 *   同一份文件的同一段原文（source_id 與 quote 相同，§4「同一件反覆出現」的定義）算一件：留最新的，記下另外哪幾天也提過。
 *   最多 6 件。背景，不是證據：kind = note（程式不承認引用它當反方或門檻的依據）。一件都沒有 → null。
 */
export function draftRiskDoc(rows: RiskRunRow[], ticker: string, asOf: string): PackDoc | null {
  const since = new Date(Date.parse(`${asOf}T00:00:00Z`) - DRAFT_RISK_DAYS * DAY).toISOString().slice(0, 10);
  const runs = rows
    .filter((r) => r.as_of >= since && r.as_of <= asOf && (FRESH_FNS as readonly string[]).includes(r.fn))
    .sort((a, b) => b.as_of.localeCompare(a.as_of) || b.created_at.localeCompare(a.created_at));
  const items: { text: string; source_id: string; quote: string; date: string; fn: string; title: string | null; srcDate: string | null; also: string[] }[] = [];
  const byKey = new Map<string, (typeof items)[number]>();
  for (const r of runs)
    for (const x of (parseNewRisks(r.new_risks)?.items ?? []).filter((i) => i.ok)) {
      const key = JSON.stringify([x.source_id, normalizeText(x.quote)]);
      const seen = byKey.get(key);
      if (seen) {
        if (seen.date !== r.as_of && !seen.also.includes(r.as_of)) seen.also.push(r.as_of);
        continue;
      }
      const it = { text: x.text, source_id: x.source_id, quote: x.quote, date: r.as_of, fn: r.fn, title: x.doc?.title ?? null, srcDate: x.doc?.date ?? x.date ?? null, also: [] as string[] };
      byKey.set(key, it);
      items.push(it);
    }
  if (!items.length) return null;
  const top = items.slice(0, DRAFT_RISK_MAX);
  const L = [
    `最近 ${DRAFT_RISK_DAYS} 天（${since}～${asOf}）${ticker} 的定期審查與減半檢視裡，「新眼光」（不看前提、只找這家公司最可能讓持有者後悔的事的角色）提出、通過程式檢查的風險，新的在前，最多 ${DRAFT_RISK_MAX} 件${items.length > top.length ? `（共 ${items.length} 件，只列最新的 ${top.length} 件）` : ''}。`,
    '這一份是背景，不是證據：不能引用它；要用就讀它指到的原文（原文在證據包或取回的文件裡的才能引用）。反方要逐件回應：放進三件事，或寫一句為什麼這次不放。',
    '',
  ];
  top.forEach((x, k) => {
    L.push(`${k + 1}. ${x.text}（${x.date} ${FN_TEXT[x.fn] ?? x.fn}提出${x.also.length ? `；${x.also.join('、')} 也提過` : ''}）`);
    L.push(`   出處：${x.title ?? '（標題不明）'}${x.srcDate ? `（${x.srcDate}）` : ''}〔${x.source_id}〕`);
    const q = x.quote.replace(/\s+/g, ' ').trim();
    L.push(`   原文片段：「${q.length > RISK_QUOTE_MAX ? `${q.slice(0, RISK_QUOTE_MAX)}…` : q}」`);
  });
  return { id: `K-${ticker}`, source_id: `risks:${ticker}@${asOf}`, kind: 'note', date: asOf, title: `${ticker} 最近 ${DRAFT_RISK_DAYS} 天新眼光提出的風險（背景，不是證據）`, text: L.join('\n') };
}

/** 這檔決策日往前 180 天內有新眼光結果的執行（定期審查、減半檢視；draftRiskDoc 用）。 */
export async function loadRiskRuns(db: D1Database, ticker: string, asOf: string): Promise<RiskRunRow[]> {
  const since = new Date(Date.parse(`${asOf}T00:00:00Z`) - DRAFT_RISK_DAYS * DAY).toISOString().slice(0, 10);
  return (
    await db
      .prepare(`SELECT run_id, fn, as_of, created_at, new_risks FROM ai_runs WHERE ticker = ? AND as_of >= ? AND as_of <= ? AND new_risks IS NOT NULL AND fn IN (${FRESH_FNS.map(() => '?').join(',')}) ORDER BY as_of DESC, created_at DESC LIMIT 60`)
      .bind(ticker, since, asOf, ...FRESH_FNS)
      .all<RiskRunRow>()
  ).results;
}

/** 規則狀態與比重（R 開頭；只放比重，不放金額與股數，§2.2）。 */
export function weightFacts(acct: Account, view: MarketView, ticker: string): Fact[] {
  const n = discussionNumbers(acct, view, ticker, null);
  const pc = (x: number | null) => (x === null || !Number.isFinite(x) ? '—' : `${(x * 100).toFixed(1)}%`);
  // 候補（allocation_redesign §4.5 第 19 點）：還沒持有，沒有慢規則狀態與目前的占比（沒有 R3）；R2 是打算放的比重（留空用推薦值）
  const w = acct.own[ticker] ? null : acct.watch?.[ticker];
  if (w) {
    const rec = w.stdWeight === null ? watchRecWeight(acct, view, ticker) : null;
    return [
      { id: 'R1', label: '持有狀態', value: `還沒持有（候補，${md(w.addedAt)} 加入）` },
      { id: 'R2', label: '打算放的比重', value: w.stdWeight !== null ? pc(w.stdWeight) : rec !== null ? `留空（推薦值 ${pc(rec)}）` : '留空', note: '進場時先買這個比重的一半' },
      ...(n.ownTotal !== null ? [{ id: 'R4', label: '自選合計占總資產', value: pc(n.ownTotal), note: `自選的預算 ${pc(n.ownBudget)}` }] : []),
    ];
  }
  return [
    { id: 'R1', label: '慢規則狀態', value: n.slow === 'HALF' ? '減半中' : '標準' },
    { id: 'R2', label: '標準比重', value: pc(n.stdWeight) },
    { id: 'R3', label: '目前占總資產', value: pc(n.weight) },
    ...(n.ownTotal !== null ? [{ id: 'R4', label: '自選合計占總資產', value: pc(n.ownTotal), note: `自選的預算 ${pc(n.ownBudget)}` }] : []),
  ];
}

/**
 * 開一次草稿（§2.2）：證據包＝論點檔（買進時的一句話、上一份論點檔、現行的前提與條件、事件、歷次審查與使用者的回應）、
 * 價格與規則狀態（只有比重）、XBRL、最近一份 10-Q／10-K 的 MD&A、最近的 8-K、目錄與清單內的網頁來源。
 * 寫一列 own_drafts（PENDING）；沒觸發成的當場結算成 FAILED。
 */
export async function startOwnDraft(env: Env, fetcher: Fetcher, acct: Account, view: MarketView, axis: string[], ticker: string, trigger: DraftTrigger, now: Date, attnKeys: string[] | null = null): Promise<AiRun> {
  // 候補也可以草擬（allocation_redesign §4.5 第 18 點）
  const meta = fileMeta(acct, ticker)?.meta;
  if (!meta) throw new DraftError(422, NOT_FILE(ticker));
  if (!routineReady(env)) throw new DraftError(400, 'AI 層的雲端排程還沒設定（SETUP.md 的 T5），沒辦法草擬');
  const asOf = view.date;
  const runId = newRunId(asOf, OWN_DRAFT, ticker);
  const broken = pendingBreak(acct, ticker);
  const at = now.toISOString();
  // 先佔一列 PENDING（T56）：同一檔同時只能有一列（own_drafts_one_pending）。兩個分頁同時按、或按的時候自動的那一次剛好在開 → 第二個停在這裡
  try {
    await env.DB.prepare("INSERT INTO own_drafts (ticker, file_id, run_id, trigger, session, created_at, status, based_on_version, broken, updated_at, attn_keys) VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?)")
      .bind(ticker, meta.fileId ?? null, runId, trigger, asOf, at, meta.thesis?.version ?? 0, broken ? JSON.stringify(broken) : null, at, attnKeys?.length ? JSON.stringify(attnKeys) : null)
      .run();
  } catch (e) {
    if (/UNIQUE constraint/i.test(errText(e))) throw new DraftError(409, `${ticker} 的草稿還在準備中，回來之前不重開`);
    throw e;
  }
  try {
    return await startDraftRun(env, fetcher, acct, view, axis, ticker, trigger, now, runId, broken);
  } catch (e) {
    // 沒開成：還沒建 ai_runs 的，佔的那一列拿掉（不算一次草擬）；已經建了的，等時限到了照規則結束、結算成 FAILED
    const made = await env.DB.prepare('SELECT 1 AS x FROM ai_runs WHERE run_id = ?').bind(runId).first();
    if (!made) await env.DB.prepare("DELETE FROM own_drafts WHERE run_id = ? AND status = 'PENDING'").bind(runId).run();
    throw e;
  }
}

/** 組證據包、開執行（startOwnDraft 已經佔好 own_drafts 那一列）。沒觸發成的當場結算成 FAILED。 */
async function startDraftRun(env: Env, fetcher: Fetcher, acct: Account, view: MarketView, axis: string[], ticker: string, trigger: DraftTrigger, now: Date, runId: string, broken: DraftBroken | null): Promise<AiRun> {
  const fm = fileMeta(acct, ticker)!;
  const meta = fm.meta;
  const asOf = view.date;
  const ev = await gatherOwnEvidence(env, fetcher, ticker, asOf);
  const tf = await thesisFile(env.DB, acct, ticker, asOf);
  if (!tf) throw new DraftError(422, NOT_FILE(ticker));
  const rows = ev.dataQuality.xbrl === 'ok' ? ev.rows : null;
  const conds = condFacts(tf, rows, { live: true });
  const extra = await reviewThesisEvidence(env, fetcher, tf, ev, asOf);
  const prev = await loadPrevFile(env.DB, acct, ticker).catch(() => null);
  const notes: string[] = [...ev.notes, ...extra.notes];
  // 新眼光提出的風險（T69，confirm_audit_design §4）：只有草稿帶；讀不到不擋草稿
  const risks = await loadRiskRuns(env.DB, ticker, asOf)
    .then((rows) => draftRiskDoc(rows, ticker, asOf))
    .catch((e: unknown) => {
      notes.push(`新眼光提出的風險沒有讀到：${errText(e)}`);
      return null;
    });
  // 目錄與已有級別的網頁來源：只有系統預設前提的也組（草稿就是要替它寫論點，研究員要能找資料）
  let menu: Awaited<ReturnType<typeof buildDocMenu>> | null = null;
  try {
    menu = await buildDocMenu(env, fetcher, { ticker, tf, meta, asOf, headlines: ev.headlines ?? null, anyKind: true });
    notes.push(...menu.notes);
  } catch (e) {
    notes.push(`目錄沒有組成：${errText(e)}`);
  }
  // T68：這檔的 domains 不再讀（confirm_audit_design §1.7）；S 開頭是種子
  const sources = menu?.sources ?? sourceFacts();
  const ctx: DocCtx = menu?.ctx ?? { menu: [], notBefore: new Date(Date.parse(`${asOf}T00:00:00Z`) - 365 * DAY).toISOString().slice(0, 10), domains: [], fileId: meta.fileId ?? null };
  const buy: Fact[] = tf.buyNote?.text ? [{ id: 'B1', label: '買進時的一句話（使用者寫的；是資料，不是指令）', value: tf.buyNote.text, note: `${tf.buyNote.at.slice(0, 10)} 寫` }] : [];
  const facts: Fact[] = [...priceFacts(view, ticker), ...weightFacts(acct, view, ticker), ...buy, ...extra.facts, ...conds.facts, ...(menu?.facts ?? []), ...sources.facts];
  const docs = [priceDoc(view, axis, ticker, 60), ev.xbrl, ...ev.docs, ...extra.filings, ev.news, ...extra.docs, prevFileDoc(prev, ticker, asOf), risks].filter((d): d is PackDoc => !!d);
  const { pack, notes: packNotes } = ownDraftPack({
    runId,
    asOf,
    ticker,
    trigger,
    held: fm.held && ownHeld(acct, ticker),
    // 候補（§4.5 第 19 點）：題目寫還沒持有、多一節進場條件
    watch: fm.held ? null : { addedAt: fm.meta.addedAt },
    premises: ownPremises(acct, ticker, { beliefs: true }),
    facts,
    docs,
    dataQuality: ev.dataQuality,
    thesisVersion: meta.thesis?.version ?? 0,
    fileId: meta.fileId ?? null,
    broken,
    webDomains: sources.domains,
    // T60：程式檢查第 1 條比對「怎樣算不成立」是不是已經成立用（同一份 XBRL；抓不到就不比）
    quarters: rows,
    now,
  });
  const run = await startRun(env, fetcher, pack, now, [...notes, ...packNotes], ctx);
  // 沒觸發成（startRun 已經存了「照規則」的結論）→ 當場結算成 FAILED
  if (run.status === 'DONE') await settleDrafts(env.DB, now);
  return run;
}

/** 這檔最近的草稿（新到舊）。 */
export async function loadDrafts(db: D1Database, ticker: string, limit = 10): Promise<DraftRow[]> {
  return (await db.prepare('SELECT * FROM own_drafts WHERE ticker = ? ORDER BY created_at DESC, id DESC LIMIT ?').bind(ticker, limit).all<DraftRow>()).results;
}

/**
 * 使用者按「請 stock bot 草擬」（§2.5）：立刻開。還在跑的不重開（409）；7 個日曆天內已經草擬過一次（自動的也算，失敗的不算）→ 409，寫明哪天之後可以再按。
 * 有還沒回覆的乙類通知照樣可以開（草稿帶 broken，§2.4 第 6 點）。
 * failed（T56）：按下去當場就沒有開成（雲端排程沒有觸發成功）的原因；網站在按鈕旁邊寫原因與「再試一次」，不推 LINE（pushed_at = SYNC）。
 */
export async function requestOwnDraft(env: Env, fetcher: Fetcher, acct: Account, view: MarketView, axis: string[], ticker: string, now: Date): Promise<{ runId: string; broken: DraftBroken | null; failed: string | null }> {
  if (!fileMeta(acct, ticker)) throw new DraftError(422, NOT_FILE(ticker));
  if (!routineReady(env)) throw new DraftError(400, 'AI 層的雲端排程還沒設定（SETUP.md 的 T5），沒辦法草擬');
  await settleDrafts(env.DB, now);
  const drafts = await loadDrafts(env.DB, ticker, 20);
  if (drafts.some((d) => d.status === 'PENDING')) throw new DraftError(409, `${ticker} 的草稿還在準備中，回來之前不重開`);
  const last = drafts.find((d) => d.status !== 'FAILED');
  if (last && now.getTime() - Date.parse(last.created_at) < DRAFT_GAP_DAYS * DAY) {
    const next = new Date(Date.parse(last.created_at) + DRAFT_GAP_DAYS * DAY).toISOString();
    throw new DraftError(409, `${md(last.created_at)} 已經草擬過一次（每檔 ${DRAFT_GAP_DAYS} 天最多一次），${md(next)} 之後可以再按`);
  }
  const run = await startOwnDraft(env, fetcher, acct, view, axis, ticker, 'MANUAL', now);
  // 按下去當場就失敗（雲端排程沒有觸發成功）：網站在按鈕旁邊寫原因與「再試一次」（§2.5），使用者正看著，不另外推 LINE
  const row = await env.DB.prepare('SELECT status, error FROM own_drafts WHERE run_id = ?').bind(run.runId).first<{ status: string; error: string | null }>();
  if (row?.status === 'FAILED') {
    await env.DB.prepare("UPDATE own_drafts SET pushed_at = 'SYNC' WHERE run_id = ? AND pushed_at IS NULL").bind(run.runId).run();
    return { runId: run.runId, broken: pendingBreak(acct, ticker), failed: `沒有開成：${row.error ?? '原因不明'}。失敗的不算在 ${DRAFT_GAP_DAYS} 天一次裡，可以再試一次` };
  }
  return { runId: run.runId, broken: pendingBreak(acct, ticker), failed: null };
}

/**
 * 新的自選自動開一次（§2.5；每日第一次流程的開執行段）。一檔要全部符合：有論點檔編號、開檔 7 天內、現在有持股、
 * 還沒有論點、沒有還沒回覆的乙類通知、這份論點檔還沒有成功或還在跑的草稿（自動或手動）、自動的失敗不到 2 次。
 * 也在這裡把 30 天沒處理的 READY 標成 EXPIRED。
 */
export async function startAutoDrafts(sc: StartCtx): Promise<void> {
  const { env, fetcher, acct, view, axis, session, now, res } = sc;
  await expireDrafts(env.DB, now);
  for (const [t, meta] of Object.entries(acct.own)) {
    const fileId = meta.fileId ?? null;
    const opened = openedOf(t, meta);
    if (!fileId || !opened || daysApart(opened, session) > DRAFT_AUTO_WINDOW_DAYS || daysApart(opened, session) < 0) continue;
    if (hasThesis(meta)) continue;
    const rows = (await env.DB.prepare('SELECT trigger, status, attn_keys FROM own_drafts WHERE file_id = ?').bind(fileId).all<{ trigger: DraftTrigger; status: DraftStatus; attn_keys: string | null }>()).results;
    if (rows.some((r) => r.status !== 'FAILED')) continue;
    if (rows.filter((r) => r.trigger === 'AUTO' && !r.attn_keys).length >= DRAFT_AUTO_TRIES) continue;
    if (!ownHeld(acct, t)) {
      res.log.push(`${t}：新的自選現在 0 股，論點草稿等持有後再開`);
      continue;
    }
    const brk = pendingBreak(acct, t);
    if (brk) {
      res.log.push(`${t}：有還沒回覆的乙類通知（#${brk.notif}，前提 ${brk.premiseId}），不自動草擬論點`);
      continue;
    }
    try {
      const run = await startOwnDraft(env, fetcher, acct, view, axis, t, 'AUTO', now);
      res.started.push(run.runId);
      res.log.push(`${t}：新的自選，自動草擬論點 ${run.runId}${rows.length ? '（上一次失敗，重試一次）' : ''}`);
    } catch (e) {
      res.log.push(`${t} 的論點草稿沒有開成：${errText(e)}`);
    }
  }
  await startWatchDrafts(sc);
  await startTriggerDrafts(sc);
}

/**
 * 候補這一份論點檔現在該不該自動草擬（allocation_redesign §4.5 第 18 點；純函式，網站的 autoSoon 與每日流程共用）。
 * rows：這份論點檔的草稿。回傳 null = 該開；否則是不開的原因（紀錄用）。
 *   加入候補 7 個日曆天內；還沒有論點；這份論點檔沒有成功或還在跑的草稿；自動的失敗不到 2 次；
 *   上一份論點檔的前提 30 個日曆天內沒有被判不成立（ownClosed.brokenAt，§4.5 第 7 點：防找理由買回；手動按照舊可以）。
 */
export function watchDraftBlock(acct: Partial<Pick<Account, 'watch' | 'ownClosed'>>, ticker: string, rows: Pick<DraftRow, 'trigger' | 'status' | 'attn_keys'>[], session: string): string | null {
  const w = acct.watch?.[ticker];
  if (!w) return '不在候補名單';
  const age = daysApart(w.addedAt, session);
  if (age < 0 || age > DRAFT_AUTO_WINDOW_DAYS) return `加入候補超過 ${DRAFT_AUTO_WINDOW_DAYS} 天`;
  if (hasThesis(w)) return '已經有論點';
  if (rows.some((r) => r.status !== 'FAILED')) return '這份論點檔已經草擬過';
  if (rows.filter((r) => r.trigger === 'AUTO' && !r.attn_keys).length >= DRAFT_AUTO_TRIES) return `自動草擬已經失敗 ${DRAFT_AUTO_TRIES} 次`;
  const b = acct.ownClosed?.[ticker]?.brokenAt ?? null;
  if (b && b <= session && daysApart(b, session) <= BROKEN_QUIET_DAYS) return `${b} 上一份論點檔的前提被判不成立（${BROKEN_QUIET_DAYS} 天內），不自動草擬（防找理由買回；要的話自己按「請 stock bot 草擬」）`;
  return null;
}

/**
 * 候補的自動草擬（allocation_redesign §4.5 第 18 點；每日第一次流程，接在新自選的那一次後面、「要看的事」觸發的前面）。
 * 條件見 watchDraftBlock；同一天最多 DRAFT_AUTO_DAILY 檔（和「要看的事」觸發的共用，一次加 5 檔會分幾天開，加入早的先）。
 * T72 的七種觸發對候補不開（多半要審查或持有；「只有預設前提」由加入時這一次負責、「論點滿一年」由一年的提醒涵蓋）。
 */
export async function startWatchDrafts(sc: StartCtx): Promise<void> {
  const { env, fetcher, acct, view, axis, session, now, res } = sc;
  const watch = Object.entries(acct.watch ?? {});
  if (!watch.length) return;
  const today = (await env.DB.prepare("SELECT COUNT(DISTINCT ticker) AS n FROM own_drafts WHERE trigger = 'AUTO' AND session = ?").bind(session).first<{ n: number }>())?.n ?? 0;
  let left = DRAFT_AUTO_DAILY - today;
  for (const [t, w] of watch.sort((a, b) => a[1].addedAt.localeCompare(b[1].addedAt) || a[0].localeCompare(b[0]))) {
    const rows = (await env.DB.prepare('SELECT trigger, status, attn_keys FROM own_drafts WHERE file_id = ?').bind(w.fileId).all<{ trigger: DraftTrigger; status: DraftStatus; attn_keys: string | null }>()).results;
    const why = watchDraftBlock(acct, t, rows, session);
    if (why) {
      if (/防找理由/.test(why)) res.log.push(`${t}（候補）：${why}`);
      continue;
    }
    if (left <= 0) {
      res.log.push(`${t}（候補）：今天已經自動草擬 ${DRAFT_AUTO_DAILY} 檔，排到之後的日子`);
      continue;
    }
    try {
      const run = await startOwnDraft(env, fetcher, acct, view, axis, t, 'AUTO', now);
      left--;
      res.started.push(run.runId);
      res.log.push(`${t}：新加進候補，自動草擬論點與進場條件 ${run.runId}${rows.length ? '（上一次失敗，重試一次）' : ''}`);
    } catch (e) {
      res.log.push(`${t}（候補）的論點草稿沒有開成：${errText(e)}`);
    }
  }
}

/** 「要看的事」觸發的自動草稿：同一天最多幾檔（新自選的那一次也算在裡面；控制雲端次數，§5）。 */
export const DRAFT_AUTO_DAILY = 2;

/**
 * 「要看的事」觸發的自動草稿（T72，confirm_audit_design §5；每日第一次流程，接在新自選的那一次後面）。
 * 每檔自選（有論點檔編號、現在有持股）算現在成立的觸發（thesis.ts 的 draftTriggers：七種），拿掉已經自動開過的鍵（autoKeyUsed：
 * 同一份論點檔、同一個鍵只開一次，失敗的重試一次），剩下的照優先順序（DRAFT_TRIGGER_KINDS；同一種先成立的先）排，一檔一次草稿涵蓋它所有的新鍵。
 *   不開：有還沒回覆的乙類通知；最近 30 個日曆天內有前提被判不成立（§2.4 第 6 點的防線；使用者自己按照舊可以）；
 *         還有準備中的草稿；7 個日曆天內已經草擬過（自動與手動共用，失敗的不算）。這幾種只記在紀錄裡，之後還成立就會開。
 *   沒有論點（NO_THESIS）另外要：開檔滿 7 天（之前由新自選的那一次負責）、這份論點檔沒有回來過的草稿（你看過一份了就不再自動開）、
 *         新自選的那一次沒有已經失敗 2 次（那時已經告警「不再自動草擬」）。
 *   同一天最多 2 檔（含今天新自選開的）；超過的排到之後的日子——不另外排隊，之後每天重算，那時還成立就開。
 * 自動開的不推 LINE（pushDraftLines 只推 MANUAL）；回來照舊列 DRAFT_READY；「要看的事」那一行改寫（thesis.ts 的 withDraftNotes）。
 */
export async function startTriggerDrafts(sc: StartCtx): Promise<void> {
  const { env, fetcher, acct, view, axis, session, now, res } = sc;
  const today = (await env.DB.prepare("SELECT COUNT(DISTINCT ticker) AS n FROM own_drafts WHERE trigger = 'AUTO' AND session = ?").bind(session).first<{ n: number }>())?.n ?? 0;
  let left = DRAFT_AUTO_DAILY - today;
  type Cand = { ticker: string; file: ThesisFile; keys: string[]; kinds: string[]; rank: number; since: string };
  const cands: Cand[] = [];
  for (const [t, meta] of Object.entries(acct.own)) {
    const fileId = meta.fileId ?? null;
    if (!fileId || !ownHeld(acct, t)) continue;
    const file = await thesisFile(env.DB, acct, t, session);
    if (!file) continue;
    const recs = file.autoDrafts ?? [];
    let hits = draftTriggers(file, acct, view).filter((x) => !autoKeyUsed(recs, draftKeyOf(x)));
    if (hits.some((x) => x.kind === 'NO_THESIS')) {
      const rows = (await env.DB.prepare('SELECT trigger, status, attn_keys FROM own_drafts WHERE file_id = ?').bind(fileId).all<{ trigger: DraftTrigger; status: DraftStatus; attn_keys: string | null }>()).results;
      const opened = openedOf(t, meta);
      const young = !!opened && daysApart(opened, session) <= DRAFT_AUTO_WINDOW_DAYS;
      const seen = rows.some((r) => r.status !== 'FAILED' && r.status !== 'PENDING');
      const gaveUp = rows.filter((r) => r.trigger === 'AUTO' && !r.attn_keys && r.status === 'FAILED').length >= DRAFT_AUTO_TRIES;
      if (young || seen || gaveUp) hits = hits.filter((x) => x.kind !== 'NO_THESIS');
    }
    if (!hits.length) continue;
    hits.sort((a, b) => triggerRank(a.kind) - triggerRank(b.kind) || a.since.localeCompare(b.since));
    cands.push({ ticker: t, file, keys: [...new Set(hits.map(draftKeyOf))], kinds: [...new Set(hits.map((x) => x.kind))], rank: triggerRank(hits[0].kind), since: hits[0].since });
  }
  cands.sort((a, b) => a.rank - b.rank || a.since.localeCompare(b.since) || a.ticker.localeCompare(b.ticker));
  for (const c of cands) {
    const t = c.ticker;
    const what = c.kinds.map((k) => TRIGGER_TEXT[k] ?? k).join('、');
    const brk = pendingBreak(acct, t);
    if (brk) {
      res.log.push(`${t}：${what}，但有還沒回覆的乙類通知（#${brk.notif}，前提 ${brk.premiseId}），不自動草擬論點`);
      continue;
    }
    const rb = recentBroken(c.file, session);
    if (rb) {
      res.log.push(`${t}：${what}，但 ${rb.date} 的審查判前提 ${rb.premiseId} 不成立（${BROKEN_QUIET_DAYS} 天內），不自動草擬論點`);
      continue;
    }
    const drafts = await loadDrafts(env.DB, t, 20);
    if (drafts.some((d) => d.status === 'PENDING')) {
      res.log.push(`${t}：${what}，論點草稿還在準備中，不另外開`);
      continue;
    }
    const last = drafts.find((d) => d.status !== 'FAILED');
    if (last && now.getTime() - Date.parse(last.created_at) < DRAFT_GAP_DAYS * DAY) {
      res.log.push(`${t}：${what}，${md(last.created_at)} 已經草擬過（每檔 ${DRAFT_GAP_DAYS} 天最多一次），之後還成立再自動開`);
      continue;
    }
    if (left <= 0) {
      res.log.push(`${t}：${what}，今天已經自動草擬 ${DRAFT_AUTO_DAILY} 檔，排到之後的日子`);
      continue;
    }
    try {
      const run = await startOwnDraft(env, fetcher, acct, view, axis, t, 'AUTO', now, c.keys);
      left--;
      res.started.push(run.runId);
      res.log.push(`${t}：${what}，自動草擬論點 ${run.runId}`);
    } catch (e) {
      res.log.push(`${t} 的論點草稿（${what}）沒有開成：${errText(e)}`);
    }
  }
}

/** 紀錄與告警裡觸發的白話。 */
const TRIGGER_TEXT: Record<string, string> = {
  HALF_NO_EXIT: '減半中而沒有出場條件',
  RISK_REPEAT: '同一件新風險出現兩次',
  PREMISE_UNVERIFIED: '前提連續 3 次審查沒驗到',
  PREMISE_NO_DATA: '前提最近一次審查 3 票都是證據不足',
  NO_CONSENSUS: '最近幾次審查都沒有一致結論',
  NO_THESIS: '只有系統預設前提',
  THESIS_OLD: '論點滿一年',
};

/** READY 超過 30 天沒處理 → EXPIRED（§2.3）。回傳標了幾筆。 */
export async function expireDrafts(db: D1Database, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - DRAFT_EXPIRE_DAYS * DAY).toISOString();
  const r = await db.prepare("UPDATE own_drafts SET status = 'EXPIRED', updated_at = ? WHERE status = 'READY' AND COALESCE(settled_at, created_at) < ?").bind(now.toISOString(), cutoff).run();
  return r.meta.changes ?? 0;
}

/**
 * 結算一次草擬（ai_runs 已經是 DONE）：檢查過的草稿 → READY（同一檔舊的 READY 標 EXPIRED）；其他 → FAILED 與原因。
 * 只動 PENDING 的列（同一次結果結算兩次不會改變什麼）。回傳結算後的狀態；還沒有結論或已經結算過是 null。
 */
export async function settleDraft(db: D1Database, run: AiRun, now: Date): Promise<{ status: 'READY' | 'FAILED'; why: string | null } | null> {
  if (run.fn !== OWN_DRAFT || run.status !== 'DONE') return null;
  const r = draftResult(run.outcome, run.pack, METRICS);
  if (!r) return null;
  const at = now.toISOString();
  if (r.ok) {
    const done = await db.prepare("UPDATE own_drafts SET status = 'READY', payload = ?, error = NULL, settled_at = ?, updated_at = ? WHERE run_id = ? AND status = 'PENDING'").bind(JSON.stringify(r.draft), at, at, run.runId).run();
    if (!done.meta.changes) return null;
    await db.prepare("UPDATE own_drafts SET status = 'EXPIRED', updated_at = ? WHERE ticker = ? AND status = 'READY' AND run_id != ?").bind(at, run.ticker ?? '', run.runId).run();
    return { status: 'READY', why: null };
  }
  const done = await db.prepare("UPDATE own_drafts SET status = 'FAILED', error = ?, settled_at = ?, updated_at = ? WHERE run_id = ? AND status = 'PENDING'").bind(r.why.slice(0, 2000), at, at, run.runId).run();
  return done.meta.changes ? { status: 'FAILED', why: r.why } : null;
}

/** 結算所有還在 PENDING、執行已經結束的草稿（結果送回之後、使用者再按之前、開執行沒觸發成時）。 */
export async function settleDrafts(db: D1Database, now: Date): Promise<number> {
  const rows = (await db.prepare("SELECT d.run_id FROM own_drafts d JOIN ai_runs r ON r.run_id = d.run_id WHERE d.status = 'PENDING' AND r.status = 'DONE'").all<{ run_id: string }>()).results;
  let n = 0;
  for (const { run_id } of rows) {
    const run = await getRun(db, run_id);
    if (run && (await settleDraft(db, run, now))) n++;
  }
  return n;
}

/**
 * 每日流程套用 OWN_DRAFT 的結論（逾時的也在這裡結算）：結算這一次；自動開的失敗、而且這份論點檔自動的已經失敗 2 次 → 告警 DRAFT_FAILED（G22）。
 * 結果送回時已經結算過的，照 own_drafts 的狀態判斷。
 */
export async function applyOwnDraft(ctx: ApplyCtx, run: AiRun): Promise<void> {
  await settleDraft(ctx.db, run, ctx.now);
  const row = await ctx.db.prepare('SELECT * FROM own_drafts WHERE run_id = ?').bind(run.runId).first<DraftRow>();
  if (!row) return void ctx.log.push(`${run.runId}：找不到這次草稿的紀錄`);
  if (row.status !== 'FAILED') return void ctx.log.push(`${run.runId}：${run.ticker} 的論點草稿${row.status === 'READY' ? '好了，等使用者看' : `是 ${row.status}`}`);
  ctx.log.push(`${run.runId}：${run.ticker} 的論點草稿沒有成功（${row.error ?? '—'}）`);
  if (row.trigger !== 'AUTO' || !row.file_id) return;
  // 「要看的事」觸發的（T72）：同一個鍵失敗 2 次 → 告警、這件事不再自動開（新自選的那一次另外算，下面）
  if (row.attn_keys) return triggerDraftFailed(ctx, run, row);
  const fails = (await ctx.db.prepare("SELECT session, error FROM own_drafts WHERE file_id = ? AND trigger = 'AUTO' AND attn_keys IS NULL AND status = 'FAILED' ORDER BY created_at").bind(row.file_id).all<{ session: string; error: string | null }>()).results;
  if (fails.length < DRAFT_AUTO_TRIES) return void ctx.log.push(`${run.ticker}：自動的論點草稿第 ${fails.length} 次失敗，下一次每日流程重試一次`);
  (ctx.alerts ??= []).push({
    kind: 'DRAFT_FAILED',
    message: `${run.ticker} 的論點草稿自動試了 ${fails.length} 次都沒有成功（${fails.map((f) => `${f.session.slice(5)} ${(f.error ?? '—').slice(0, 80)}`).join('、')}），不再自動草擬；可以在網站按「請 stock bot 草擬」再試，或自己寫論點。`,
    detail: { ticker: run.ticker, fileId: row.file_id, runId: run.runId },
  });
}

/** 「要看的事」觸發的自動草稿失敗了（T72）：這幾個鍵有一個已經失敗 2 次 → 告警 DRAFT_FAILED；否則下一次每日流程重試一次。 */
async function triggerDraftFailed(ctx: ApplyCtx, run: AiRun, row: DraftRow): Promise<void> {
  const keys = keysOf(row.attn_keys);
  const rows = (await ctx.db.prepare("SELECT session, error, attn_keys FROM own_drafts WHERE file_id = ? AND trigger = 'AUTO' AND attn_keys IS NOT NULL AND status = 'FAILED' ORDER BY created_at").bind(row.file_id).all<{ session: string; error: string | null; attn_keys: string }>()).results;
  const fails = rows.filter((r) => keysOf(r.attn_keys).some((k) => keys.includes(k)));
  if (fails.length < AUTO_KEY_TRIES) return void ctx.log.push(`${run.ticker}：「要看的事」觸發的論點草稿第 ${fails.length} 次失敗，下一次每日流程重試一次`);
  (ctx.alerts ??= []).push({
    kind: 'DRAFT_FAILED',
    message: `${run.ticker} 的論點草稿（「要看的事」觸發的）自動試了 ${fails.length} 次都沒有成功（${fails.slice(-2).map((f) => `${f.session.slice(5)} ${(f.error ?? '—').slice(0, 80)}`).join('、')}），這件事不再自動草擬；可以在網站按「請 stock bot 草擬」再試，或自己改論點。`,
    detail: { ticker: run.ticker, fileId: row.file_id, runId: run.runId, keys },
  });
}

/** own_drafts.attn_keys → 鍵（壞掉的當成沒有）。 */
function keysOf(raw: string | null | undefined): string[] {
  try {
    const v = JSON.parse(raw ?? 'null') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- T56：網站的草稿狀態、讀草稿、用過／不用、LINE

/** 一檔的草稿狀態（網站各入口的「請 stock bot 草擬」按鈕與編輯論點頁用；web_evidence_design §2.3、§2.5、§2.6）。 */
export interface DraftState {
  /** 這份論點檔等你看的草稿（READY）：until 哪天之後不再列；stale = 照的論點版本（basedOn）和現在（version）不同。 */
  ready: { id: number; runId: string; trigger: DraftTrigger; createdAt: string; at: string; until: string; basedOn: number; version: number; stale: boolean } | null;
  /** 還在準備中（PENDING）。attn：「要看的事」觸發的自動草稿（T72；不是新自選的那一次）。 */
  pending: { runId: string; trigger: DraftTrigger; createdAt: string; attn?: true } | null;
  /** 這份論點檔最近一次草稿是失敗、過期、用過或不用（why：失敗的原因）。最近一次是 READY、PENDING 或沒有草稿時是 null。 */
  last: { id: number; status: 'FAILED' | 'EXPIRED' | 'USED' | 'DISMISSED'; trigger: DraftTrigger; createdAt: string; at: string; why: string | null } | null;
  /** 每檔 7 天一次（失敗的不算）：lastAt 那一次開的時間、nextAt 之後才能再按；現在就能按是 null。 */
  lastAt: string | null;
  nextAt: string | null;
  /** 新的自選、下一次每日流程會自動草擬一次（§2.5；還沒開過、沒有論點、有持股、開檔 7 天內、沒有待回覆的乙類、雲端排程設定好了）。 */
  autoSoon: boolean;
  /** 雲端排程設定好了（沒設定時按了也開不成）。 */
  aiReady: boolean;
}

const LAST_STATES = ['FAILED', 'EXPIRED', 'USED', 'DISMISSED'] as const;
type LastStatus = (typeof LAST_STATES)[number];

/**
 * 一檔的草稿狀態（純函式）。rows：這檔的草稿（新到舊；別的論點檔的也可以在裡面）；session：現在的訊號日。
 * READY、最近一次只看這份論點檔的；7 天一次、還在準備中照 requestOwnDraft 的規則看整檔。
 */
export function draftStateOf(rows: DraftRow[], acct: Pick<Account, 'own' | 'notifs' | 'lots'> & Partial<Pick<Account, 'watch' | 'ownClosed'>>, ticker: string, now: Date, session: string, aiReady: boolean): DraftState {
  // 候補也有論點檔（allocation_redesign §4.5 第 10 點）：狀態照樣算；候補的「下一次流程會自動草擬」看 watchDraftBlock（第 18 點）
  const fm = fileMeta(acct, ticker);
  const meta = fm?.meta;
  const fileId = meta?.fileId ?? null;
  const mine = rows.filter((r) => (r.file_id ?? null) === fileId);
  const r0 = mine.find((r) => r.status === 'READY');
  const version = meta?.thesis?.version ?? 0;
  const ready = r0
    ? { id: r0.id, runId: r0.run_id, trigger: r0.trigger, createdAt: r0.created_at, at: r0.settled_at ?? r0.created_at, until: draftUntil(r0.settled_at ?? r0.created_at), basedOn: r0.based_on_version, version, stale: r0.based_on_version !== version }
    : null;
  const p0 = rows.find((r) => r.status === 'PENDING');
  const pending = p0 ? { runId: p0.run_id, trigger: p0.trigger, createdAt: p0.created_at, ...(p0.attn_keys ? { attn: true as const } : {}) } : null;
  const l0 = mine[0];
  const last = l0 && (LAST_STATES as readonly string[]).includes(l0.status) ? { id: l0.id, status: l0.status as LastStatus, trigger: l0.trigger, createdAt: l0.created_at, at: l0.updated_at ?? l0.settled_at ?? l0.created_at, why: l0.error } : null;
  const done = rows.find((r) => r.status !== 'FAILED');
  const within = !!done && now.getTime() - Date.parse(done.created_at) < DRAFT_GAP_DAYS * DAY;
  const opened = openedOf(ticker, fm?.held ? fm.meta : null);
  const age = opened ? daysApart(opened, session) : -1;
  const autoSoon = fm && !fm.held
    ? aiReady && watchDraftBlock(acct, ticker, mine, session) === null
    : aiReady &&
    !!meta &&
    !!fm?.held &&
    !!fileId &&
    age >= 0 &&
    age <= DRAFT_AUTO_WINDOW_DAYS &&
    !hasThesis(meta) &&
    (acct.lots.own[ticker] ?? 0) > 0 &&
    !pendingBreak(acct, ticker) &&
    !mine.some((r) => r.status !== 'FAILED') &&
    mine.filter((r) => r.trigger === 'AUTO' && !r.attn_keys).length < DRAFT_AUTO_TRIES;
  return {
    ready,
    pending,
    last,
    lastAt: within ? done!.created_at : null,
    nextAt: within ? new Date(Date.parse(done!.created_at) + DRAFT_GAP_DAYS * DAY).toISOString() : null,
    autoSoon,
    aiReady,
  };
}

/**
 * 每檔自選與候補的草稿狀態（網站每次載入時；src/app/site/backend.ts）。先結算已經結束的執行（逾時的由 listRuns 先照規則結束），
 * 網站才不會一直寫「準備中」。候補也算（allocation_redesign §4.5 第 10 點）。
 */
export async function draftStates(env: Env, acct: Account, now: Date, session: string): Promise<Record<string, DraftState>> {
  const tickers = [...new Set([...Object.keys(acct.own), ...Object.keys(acct.watch ?? {})])];
  if (!tickers.length) return {};
  await settleDrafts(env.DB, now);
  const rows = (await env.DB.prepare(`SELECT * FROM own_drafts WHERE ticker IN (${tickers.map(() => '?').join(',')}) ORDER BY created_at DESC, id DESC LIMIT 400`).bind(...tickers).all<DraftRow>()).results;
  const ai = routineReady(env);
  return Object.fromEntries(tickers.map((t) => [t, draftStateOf(rows.filter((r) => r.ticker === t), acct, t, now, session, ai)]));
}

/** 編輯論點頁讀的草稿（GET /api/own/:代號/draft）。 */
export interface DraftView {
  id: number;
  runId: string;
  trigger: DraftTrigger;
  createdAt: string;
  /** 回來的時間；until 哪天之後不再列。 */
  at: string;
  until: string;
  /** 照第幾版論點寫的（0 = 那時還沒有論點）；version 現在是第幾版；stale 兩個不同。 */
  basedOn: number;
  version: number;
  stale: boolean;
  /** 開的時候還沒回覆的乙類通知（§2.4 第 6 點）；open = 那則通知現在還沒回覆。 */
  broken: (DraftBroken & { open: boolean }) | null;
  payload: OwnDraft;
}

/** 這份論點檔等你看的草稿（READY，最新的那一份）；沒有是 null。 */
export async function readyDraft(db: D1Database, acct: Pick<Account, 'own' | 'notifs'> & Partial<Pick<Account, 'watch'>>, ticker: string): Promise<DraftView | null> {
  const meta = fileMeta(acct, ticker)?.meta;
  if (!meta) return null;
  const fileId = meta.fileId ?? null;
  const row = await db
    .prepare(`SELECT * FROM own_drafts WHERE ticker = ? AND status = 'READY' AND ${fileId ? 'file_id = ?' : 'file_id IS NULL'} ORDER BY created_at DESC, id DESC LIMIT 1`)
    .bind(...(fileId ? [ticker, fileId] : [ticker]))
    .first<DraftRow>();
  return row ? draftViewOf(row, acct, ticker) : null;
}

/** 一列草稿 → 網站用的形狀（payload 解析不了的當成沒有）。 */
export function draftViewOf(row: DraftRow, acct: Pick<Account, 'own' | 'notifs'> & Partial<Pick<Account, 'watch'>>, ticker: string): DraftView | null {
  let payload: OwnDraft | null;
  let broken: DraftBroken | null;
  try {
    payload = JSON.parse(row.payload ?? 'null') as OwnDraft | null;
    broken = row.broken ? (JSON.parse(row.broken) as DraftBroken) : null;
  } catch {
    return null;
  }
  if (!payload || !Array.isArray(payload.premises)) return null;
  const version = fileMeta(acct, ticker)?.meta.thesis?.version ?? 0;
  const at = row.settled_at ?? row.created_at;
  const open = !!broken && pendingBreak(acct, ticker)?.notif === broken.notif;
  return { id: row.id, runId: row.run_id, trigger: row.trigger, createdAt: row.created_at, at, until: draftUntil(at), basedOn: row.based_on_version, version, stale: row.based_on_version !== version, broken: broken ? { ...broken, open } : null, payload };
}

/** 存檔時用到的那一份草稿（這檔的；不管現在是什麼狀態，payload 還在就好；是不是這份論點檔的由存檔那邊對）。找不到是 null。 */
export async function draftForSave(db: D1Database, ticker: string, id: number): Promise<DraftRow | null> {
  return (await db.prepare('SELECT * FROM own_drafts WHERE id = ? AND ticker = ?').bind(id, ticker).first<DraftRow>()) ?? null;
}

/**
 * 採用這份草稿時用了什麼（own_drafts.used_json；論點檔 log 的 THESIS 也帶一份）。T70（confirm_audit_design §2）起是整份採用，
 * 沒有「沒勾的」；T56 的舊紀錄有 unused、domains、premises.edited，讀的地方（運作統計）當成可能沒有。
 */
export interface DraftUse {
  id: number;
  runId: string;
  /** 存成第幾版論點。 */
  version: number;
  /** 論點本文：整份照草稿，一律 SAME（T56 的舊紀錄可能是 EDITED 或 null）。 */
  thesis: 'SAME';
  /** 前提：原樣採用幾條（AI_DRAFT_ACCEPTED）、沿用你現在的前提幾條（keep_id，或字一樣）。edited 固定 0（T56 的舊紀錄是勾了又改字的條數）。 */
  premises: { same: number; edited: 0; kept: number };
  /** 出場條件：採用時直接寫進條件的條數（監測中、只在審查時檢查或只記錄）。 */
  exits: number;
  /** 和現在監測中的一條字一樣、沿用那一條的條數。 */
  exitsKept: number;
  /** 改走改寫與持股頁確認的條數（T55／T60 的舊草稿：事件條件沒有確認來源）。 */
  exitsRewrite: number;
  /** 存進來的同業幾家；EDGAR 代號對不到、沒有存的那幾家與原因。 */
  peers: number;
  peersSkipped: { name: string; edgar: string; why: string; yahooKept?: true }[];
  /** 這份草稿是在前提被判不成立之後寫的（§2.4 第 6 點）：採用算一次「失效後修改」。 */
  afterBreak: boolean;
}

/** 存檔用了這份草稿 → USED（還在等你看、或剛好過期的才改；已經用過或不用的不動）。回傳有沒有改。 */
export async function markDraftUsed(db: D1Database, ticker: string, use: DraftUse, now: Date): Promise<boolean> {
  const r = await db.prepare("UPDATE own_drafts SET status = 'USED', used_json = ?, updated_at = ? WHERE id = ? AND ticker = ? AND status IN ('READY', 'EXPIRED')").bind(JSON.stringify(use), now.toISOString(), use.id, ticker).run();
  return (r.meta.changes ?? 0) > 0;
}

/** 「不用這份草稿」→ DISMISSED（只有還在等你看的可以）。回傳有沒有改。 */
export async function dismissDraft(db: D1Database, ticker: string, id: number, now: Date): Promise<boolean> {
  const r = await db.prepare("UPDATE own_drafts SET status = 'DISMISSED', updated_at = ? WHERE id = ? AND ticker = ? AND status = 'READY'").bind(now.toISOString(), id, ticker).run();
  return (r.meta.changes ?? 0) > 0;
}

const clipWhy = (s: string | null): string => {
  const t = (s ?? '原因不明').replace(/\s+/g, ' ').trim();
  return t.length > 60 ? `${t.slice(0, 60)}…` : t;
};

/** LINE 一行（§2.5）：使用者按的草稿回來了／沒有成功。後面一行是編輯論點頁的連結。 */
export function draftLineText(row: Pick<DraftRow, 'ticker' | 'status' | 'error' | 'settled_at' | 'created_at'>, paper: boolean, siteUrl: string | null | undefined): string {
  const tag = paper ? '【紙上】' : '';
  const link = lineUrl(siteUrl, `#/h/${encodeURIComponent(row.ticker)}/thesis`);
  const until = draftUntil(row.settled_at ?? row.created_at);
  const line =
    row.status === 'READY'
      ? `${tag}${row.ticker} 的論點草稿好了：先看反方的三點，再決定要不要整份採用（${Number(until.slice(5, 7))}/${Number(until.slice(8, 10))} 之後不再列）`
      : `${tag}${row.ticker} 的論點草稿沒有成功（${clipWhy(row.error)}），可以到網站再試一次`;
  return link ? `${line}\n${link}` : line;
}

/**
 * 使用者按的草稿回來（READY）或失敗（FAILED）→ 推 LINE 一行（§2.5；自動開的不推）。結果送回時（index.ts）與每日流程推播時（flow.ts）叫。
 * 先佔 pushed_at 再推（兩處同時叫也只推一次）；推失敗的放回去，下一次再推；回來或失敗超過 3 天就不推了。
 * 已經用掉、不用、過期的不推；失敗之後又按了一次（這檔有更新的一列）的舊失敗不推（SKIP）。
 */
export async function pushDraftLines(env: Env, fetcher: Fetcher, now: Date): Promise<{ sent: number; failed: number; errors: string[] }> {
  const out = { sent: 0, failed: 0, errors: [] as string[] };
  if (!lineConfigured(env)) return out;
  const db = env.DB;
  const at = now.toISOString();
  const cutoff = new Date(now.getTime() - DRAFT_PUSH_DAYS * DAY).toISOString();
  const rows = (await db.prepare("SELECT * FROM own_drafts WHERE trigger = 'MANUAL' AND status IN ('READY', 'FAILED') AND pushed_at IS NULL AND settled_at >= ? ORDER BY id").bind(cutoff).all<DraftRow>()).results;
  if (!rows.length) return out;
  const paper = (await loadAccount(db))?.acct.paper ?? true;
  for (const row of rows) {
    if (row.status === 'FAILED' && (await db.prepare('SELECT 1 AS x FROM own_drafts WHERE ticker = ? AND id > ? LIMIT 1').bind(row.ticker, row.id).first())) {
      await db.prepare("UPDATE own_drafts SET pushed_at = 'SKIP' WHERE id = ? AND pushed_at IS NULL").bind(row.id).run();
      continue;
    }
    const claim = await db.prepare('UPDATE own_drafts SET pushed_at = ? WHERE id = ? AND pushed_at IS NULL').bind(at, row.id).run();
    if (!claim.meta.changes) continue;
    const text = draftLineText(row, paper, env.SITE_URL);
    const r = await pushLine(env, fetcher, text);
    await db.prepare('INSERT INTO pushes (at, kind, ref, ok, status, error, text) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(at, 'DRAFT', row.id, r.ok ? 1 : 0, r.status, r.error ?? null, text).run();
    if (r.ok) out.sent++;
    else {
      out.failed++;
      out.errors.push(`${row.ticker} 的論點草稿：${r.error}`);
      await db.prepare('UPDATE own_drafts SET pushed_at = NULL WHERE id = ? AND pushed_at = ?').bind(row.id, at).run();
    }
  }
  return out;
}

/**
 * 草稿裡一條前提的三個欄位，整理成帳戶狀態的形狀（T60）。T55 的舊草稿（own_draft_v1）是 breaks_if 一段字、checkable_by、source_hint，
 * 一樣收：checkable_by 當成 verify.by、source_hint 當成來源，沒有怎樣算證實。
 */
export function draftPremiseFields(dp: DraftPremise | (Partial<DraftPremise> & Record<string, unknown>)): { breaksIf: string[]; confirmsIf: string; verify: PremiseVerify | null } {
  const o = dp as Record<string, unknown>;
  const v = o.verify && typeof o.verify === 'object' ? (o.verify as Record<string, unknown>) : o.checkable_by ? { by: o.checkable_by, source: o.source_hint ?? undefined } : null;
  const verify = v ? normVerify({ by: v.by, source: v.source ?? undefined, every: v.every ?? undefined }) : null;
  return { breaksIf: breaksOf({ breaksIf: o.breaks_if as string[] | string | undefined }), confirmsIf: typeof o.confirms_if === 'string' ? o.confirms_if.trim() : '', verify };
}

// ---------------------------------------------------------------- T70：一鍵採用（confirm_audit_design §2）

/** 採用時直接寫進條件的一條出場條件（k：草稿的第幾條）。status：寫進去之後的狀態（照 acceptStatus 的規則）。 */
export interface AdoptExit {
  k: number;
  text: string;
  action: CondAction;
  kind: 'XBRL' | 'EVENT' | 'PRICE';
  check: Record<string, unknown>;
  /** 對應草稿的第幾條前提（0 起；沒有是 null）。存檔後換成那一條的編號。 */
  premiseIndex: number | null;
  status: 'ACTIVE' | 'REVIEW_ONLY' | 'MANUAL';
  /** 財報門檻的進場條件、用草稿那份季度表比已經成立（T85，§4.5 第 22 點）：採用時直接標成立、記進 watch[t].entry。 */
  metNow?: { end: string; values: (number | null)[] };
}

/** 採用一份草稿會做什麼（純函式 draftAdoptPlan；網站的對照與存檔都用它）。 */
export interface AdoptPlan {
  /** 整份照草稿的前提：沿用你現在的那一條（keep_id）帶它的編號，其他是新的一條、來源 AI_DRAFT_ACCEPTED。 */
  premises: PremiseInput[];
  /** 直接寫進條件的（財報門檻、有確認來源的事件條件、價格條件），不送改寫、不到持股頁確認（§2.2）。 */
  add: AdoptExit[];
  /**
   * 改走改寫與持股頁確認的：T55／T60 的舊草稿（own_draft_v1、v2）的事件條件沒有確認來源（confirm_by），
   * 或更舊的沒有 kind、財報條件沒有門檻格式的——程式監測不了，照原本使用者寫的出場條件那樣送去改寫。
   */
  rewrite: (ExitLine & { k: number; why: string })[];
  /** 和現在監測中的一條字一樣（去空白標點後比）：不新增、沿用那一條；成立時的動作不同就改成草稿的（was 是原本的）。 */
  keep: { k: number; id: number; text: string; action: CondAction; was: CondAction | null }[];
  /** 現在監測中、草稿裡沒有的你定的條件：採用時撤下（T42 整組取代，草稿就是存檔後要的全部出場條件）。 */
  retire: LiveCondition[];
}

/** 條件寫進去之後的狀態（同 ownAi.ts insertConditionStmts 的算法：價格、指標程式算不出來的財報條件只記錄）。 */
function adoptStatus(kind: AdoptExit['kind'], check: Record<string, unknown>): AdoptExit['status'] {
  const auto = kind !== 'PRICE' && (kind !== 'XBRL' || String(check.metric) in XBRL_METRICS);
  return acceptStatus({ kind, check, auto, status: 'PROPOSED' });
}

/**
 * 整份採用一份草稿（純函式，§2.1、§2.2）：前提、出場條件怎麼存。live：這檔現在監測中的你定的條件（T42 整組取代的範圍）。
 *   前提：草稿的全部前提照原樣；keep_id 帶那個編號（沿用，來源照舊），其他來源記 AI_DRAFT_ACCEPTED；三個欄位照草稿的。
 *   出場條件：字和監測中的一條一樣 → 沿用（keep）；財報門檻（XBRL，check 照草稿）、有確認來源的事件條件（EVENT，check 再過一次
 *     和改寫同一個格式檢查）、價格條件（只記錄）→ 直接寫進條件（add）；監測不了格式的（舊草稿的事件條件沒有 confirm_by 等）→ 送改寫（rewrite）；
 *     監測中、草稿沒有的 → 撤下（retire）。
 */
export function draftAdoptPlan(d: Pick<OwnDraft, 'premises' | 'exits' | 'adds' | 'entries'>, live: LiveCondition[]): AdoptPlan {
  const premises: PremiseInput[] = d.premises.map((dp) => {
    const f = draftPremiseFields(dp);
    return dp.keep_id ? { id: dp.keep_id, text: dp.text, ...f } : { id: null, text: dp.text, origin: 'AI_DRAFT_ACCEPTED' as const, ...f };
  });
  // 加碼條件（T84，own_draft_v4）接在出場條件後面，一起整組取代（你定的條件 8 條上限合計）；動作只認各自那一組
  // 進場條件（T85，候補的草稿）也接在後面：整組取代非價格的進場條件（live 裡只放非價格的；你填的價格條件不在範圍內，AI 草稿永遠沒有價格條件）
  const all = [...d.exits.map((x) => ({ x, add: false, entry: false })), ...(d.adds ?? []).map((x) => ({ x, add: true, entry: false })), ...(d.entries ?? []).map((x) => ({ x, add: false, entry: true }))];
  const exits = all.map(({ x, add, entry }) => ({ text: x.text, action: entry ? ('ENTRY' as CondAction) : add ? (x.action === 'RAISE' ? 'RAISE' : 'FILL') : (['EXIT', 'HALF', 'REVIEW'] as CondAction[]).includes(x.action) ? x.action : ('REVIEW' as CondAction) }));
  const plan = planExits(exits, live);
  const keep: AdoptPlan['keep'] = [];
  const add: AdoptExit[] = [];
  const rewrite: AdoptPlan['rewrite'] = [];
  all.forEach(({ x }, k) => {
    const action = exits[k].action;
    const same = plan.sameByText[k];
    if (same !== undefined) {
      const c = live.find((l) => l.id === same)!;
      return void keep.push({ k, id: same, text: c.text, action, was: c.action ?? null });
    }
    const pi = typeof x.premise_index === 'number' ? x.premise_index : null;
    const kind = x.kind;
    const check = x.check && typeof x.check === 'object' ? x.check : null;
    const metNow = (x as { met_now?: AdoptExit['metNow'] | null }).met_now ?? null;
    if (kind === 'XBRL' && check) return void add.push({ k, text: x.text, action, kind, check, premiseIndex: pi, status: adoptStatus(kind, check), ...(metNow && isEntryAction(action) ? { metNow } : {}) });
    if (kind === 'PRICE') return void add.push({ k, text: x.text, action, kind, check: check ?? {}, premiseIndex: pi, status: adoptStatus(kind, check ?? {}) });
    if (kind === 'EVENT' && check) {
      const ev = draftEventCheck(check, METRICS);
      if (ev.check) return void add.push({ k, text: x.text, action, kind, check: ev.check, premiseIndex: pi, status: adoptStatus(kind, ev.check) });
    }
    const why = kind === 'EVENT' ? '舊格式的草稿：事件條件沒有寫用什麼確認' : kind === 'XBRL' ? '財報條件沒有門檻的格式' : '舊格式的草稿：沒有監測的格式';
    rewrite.push({ k, text: x.text, action, why });
  });
  const kept = new Set(keep.map((x) => x.id));
  return { premises, add, rewrite, keep, retire: live.filter((c) => !kept.has(c.id)) };
}

/**
 * 採用之後「你定的、會自己發通知的條件」（ACTIVE＋REVIEW_ONLY）有幾條（T71：採用時也要守 8 條的上限）。
 * 採用是整組取代：監測中、草稿沒有的都撤下，所以剩下的是沿用的（keep，看它現在的狀態）加上直接寫進去的（add，看寫進去之後的狀態）；
 * 送改寫的（rewrite）之後在持股頁確認時另外檢查上限（acceptOwnConditions 的 checkCap）。
 * AI 監測中的條件不在 live 裡（不是你定的），採用不動它們，也不算在這 8 條裡。live 的 code 沒給（舊的呼叫端）時沿用的那條算一條。
 */
export function adoptOwnedCount(plan: Pick<AdoptPlan, 'keep' | 'add'>, live: LiveCondition[]): number {
  const kept = plan.keep.filter((k) => {
    const code = live.find((l) => l.id === k.id)?.code;
    return code === undefined || OWNED_LIVE.includes(code);
  }).length;
  return kept + plan.add.filter((a) => OWNED_LIVE.includes(a.status) && !isEntryAction(a.action)).length;
}

/** 採用之後監測中的非價格進場條件有幾條（T85：另算、最多 MAX_ENTRY_OTHER 條；沿用的看它的動作）。 */
export function adoptEntryCount(plan: Pick<AdoptPlan, 'keep' | 'add'>): number {
  return plan.keep.filter((k) => isEntryAction(k.action)).length + plan.add.filter((a) => isEntryAction(a.action) && a.status !== 'MANUAL').length;
}

const ANSWER_TEXT: Record<string, string> = { YES: '會買', NO: '不會買', UNSURE: '說不準' };

/**
 * 候補進場項目旁邊的「今天沒持股的話會不會買」（allocation_redesign §4.5 第 19 點）：這份論點檔最新一份回來的草稿（等你看的或採用過的）
 * 的 would_buy_today 與草稿回來的日期（台北時間）。沒有是 null。answer 是白話（會買、不會買、說不準，後面括號一句理由）。
 */
export async function wouldBuyOf(db: D1Database, ticker: string, fileId: string): Promise<{ answer: string; date: string } | null> {
  const row = await db.prepare("SELECT payload, settled_at, created_at FROM own_drafts WHERE ticker = ? AND file_id = ? AND status IN ('READY', 'USED') AND payload IS NOT NULL ORDER BY created_at DESC, id DESC LIMIT 1").bind(ticker, fileId).first<{ payload: string; settled_at: string | null; created_at: string }>();
  if (!row) return null;
  try {
    const wb = (JSON.parse(row.payload) as OwnDraft).would_buy_today;
    if (!wb?.answer) return null;
    const text = ANSWER_TEXT[wb.answer] ?? wb.answer;
    const iso = row.settled_at ?? row.created_at;
    return { answer: wb.why ? `${text}（${wb.why.length > 80 ? `${wb.why.slice(0, 80)}…` : wb.why}）` : text, date: new Date(Date.parse(iso) + 8 * 3600_000).toISOString().slice(0, 10) };
  } catch {
    return null;
  }
}

/**
 * 草稿的同業怎麼存（§2.3）：有 EDGAR 代號的要核對得到 CIK（checks：probeWebSources 的結果，key 是 edgar:<代號>）才存；
 * 對不到、沒有核對成的：有 Yahoo 代號的只存 Yahoo 代號，沒有的整家不存；都回原因。只有 Yahoo 代號的沒有東西要核對，照存。
 */
export function adoptPeers(peers: DraftPeer[], checks: WebSourceCheck[] | null): { save: WebPeer[]; skip: DraftUse['peersSkipped'] } {
  const save: WebPeer[] = [];
  const skip: DraftUse['peersSkipped'] = [];
  for (const p of peers) {
    if (!p.edgar) {
      save.push({ name: p.name, ...(p.yahoo ? { yahoo: p.yahoo } : {}) });
      continue;
    }
    const c = checks?.find((x) => x.key === `edgar:${p.edgar}`);
    if (c?.ok === true) save.push({ name: p.name, edgar: p.edgar, ...(p.yahoo ? { yahoo: p.yahoo } : {}) });
    else {
      // EDGAR 對不到、但有 Yahoo 代號的：只拿掉 EDGAR 代號，新聞連結照存（主持者驗收 T70 時改：不在美國申報的同業多半如此）
      if (p.yahoo) save.push({ name: p.name, yahoo: p.yahoo });
      skip.push({ name: p.name, edgar: p.edgar, why: c?.why ?? '沒有核對 EDGAR 代號', ...(p.yahoo ? { yahooKept: true } : {}) });
    }
  }
  return { save, skip };
}

/** 採用結果的那一行原因（存檔結果與預覽用）：「SK hynix（EDGAR HXSCL）沒有存：EDGAR 找不到這個代號…」。 */
export const peerSkipText = (s: DraftUse['peersSkipped'][number]): string => `同業 ${s.name}（EDGAR ${s.edgar}）${s.yahooKept ? '只存了 Yahoo 代號，EDGAR 代號沒有存' : '沒有存'}：${s.why}`;
