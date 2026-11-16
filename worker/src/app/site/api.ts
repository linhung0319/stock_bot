// 網站的 API（T8）。/api/* 是真實帳本，/demo/api/* 是示範資料；兩邊是同一組端點。
// 每個會改帳戶的端點都是：讀帳戶與市場 → 呼叫引擎的純函式 → 替新通知寫下理由 → 存檔。
import {
  SLOW,
  SYSTEM_DEFAULT_PREMISES,
  addOwn,
  applySnapshot,
  setThesis,
  cancelCashflow,
  monthlyWait,
  setStdWeight,
  type BucketShares,
  changeRatio,
  classify,
  clone,
  composeNotif,
  createAccount,
  deposit,
  drawdownFromHigh,
  explainCash,
  itemAction,
  liveShadow,
  recommendStdWeights,
  removeOwn,
  reopen,
  resolveFollowUp,
  REASON_MAX,
  KEPT_REASON,
  missingReasons,
  respond,
  revisableBreak,
  reviseBreak,
  resumeMonthly,
  totalValue,
  unexclude,
  withdraw,
  type Account,
  type InitialAccount,
  type MarketView,
  type Notif,
  type Premise,
  type Snapshot,
  notifName,
} from '../../engine';
import { VOL_HIST_SEED } from '../../engine/volSeed';
import { DISCUSSION_MODES, THESIS_LIMITS, parseThesisBlock } from '../../ai/discussion';
import type { ExitLine } from '../../ai/ownCheck';
import { demoDiscussion } from '../discussion';
import type { ThesisLogInput } from '../ledgerStore';
import { ruleResponseLogs, type CondAction } from '../thesis';
import { errText } from '../../data/util';
import { normalizeTicker } from '../../data/sources';
import { DEMO_IDS, DEMO_SCRIPTS, type DemoId } from '../../demo/demoScripts';
import { json, type Env, type Fetcher } from '../env';
import { LOGIN_PATH, lineLoginConfigured, siteAuth } from './auth';
import { ConflictError, demoBackend, realBackend, type DemoBackend, type SiteBackend, type SiteData } from './backend';
import { bookFromView, followUp, shadowSummary } from '../../ai/shadow';
import { BENCHMARK } from '../../data/ingest';
import { exportMd, rowOfNote, runDetail, runRow, vetoView } from './aiViews';
import { choiceEffect } from './bubble';
import { annotate } from './explain';
import { accountView, composedView, crashLogView, ctxOf, historyView, withPreviewNote, holdingDetail, notifView, pendingBreakOf, snapshotForm, stateView } from './views';
import { demoHolding } from './thesisView';
import { eventDetail, eventSource } from '../eventText';

type Ready = SiteData & { acct: Account; view: MarketView };

/** 可以直接顯示給使用者看的錯誤。 */
export class SiteError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const TICKER = /^[A-Z][A-Z0-9.-]{0,9}$/;
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const MAX_BODY = 64 * 1024;

function ready(d: SiteData): Ready {
  if (!d.acct) throw new SiteError(409, '還沒有帳戶。先建立帳戶（填第一份快照）。');
  if (!d.view) throw new SiteError(409, '還沒有價格資料，暫時算不出清單。');
  return d as Ready;
}

async function body(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (text.length > MAX_BODY) throw new SiteError(413, '送出的內容太大');
  if (!text) return {};
  try {
    const v = JSON.parse(text) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
    return v as Record<string, unknown>;
  } catch {
    throw new SiteError(400, '送出的內容不是 JSON');
  }
}

function num(v: unknown, name: string, min: number, max: number): number {
  const x = typeof v === 'string' && v.trim() !== '' ? Number(v.replace(/[,\s$]/g, '')) : v;
  if (typeof x !== 'number' || !Number.isFinite(x)) throw new SiteError(422, `${name}要填數字`);
  if (x < min || x > max) throw new SiteError(422, `${name}要在 ${min.toLocaleString('en-US')} 到 ${max.toLocaleString('en-US')} 之間`);
  return x;
}

/** 標準比重（小數）。畫面上填的是百分比，超出範圍時用百分比講（T34 走一遍的缺口：原本寫「要在 0.001 到 0.5 之間」，和畫面上的 % 對不起來）。 */
function stdWeightOf(v: unknown): number {
  const x = typeof v === 'string' && v.trim() !== '' ? Number(v.replace(/[,\s%]/g, '')) : v;
  if (typeof x !== 'number' || !Number.isFinite(x) || x < 0.001 || x > 0.5) throw new SiteError(422, '標準比重要在 0.1% 到 50% 之間（畫面上填百分比，例如 5 代表 5%）');
  return x;
}

function ticker(v: unknown): string {
  // 券商畫面的寫法不一樣（BRK.B／BRK-B／BRK B／BRK/B）：統一成系統用的「.」，免得同一檔變成兩個代號（T34 走一遍的缺口）
  const t = normalizeTicker(String(v ?? ''));
  if (!TICKER.test(t)) throw new SiteError(422, `「${String(v ?? '').slice(0, 20)}」不是有效的股票代號`);
  return t;
}

function text(v: unknown, name: string, max = 300, required = true): string {
  const s = String(v ?? '').trim();
  if (required && !s) throw new SiteError(422, `請寫${name}`);
  if (s.length > max) throw new SiteError(422, `${name}最多 ${max} 個字`);
  return s;
}

function findNotif(acct: Account, id: number): Notif {
  const n = acct.notifs.find((x) => x.id === id);
  if (!n) throw new SiteError(404, '找不到這則通知（網址可能打錯了）');
  return n;
}

/** 需要價格的操作：引擎找不到價格會丟錯誤，轉成看得懂的訊息。 */
function engine<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof SiteError) throw e;
    const m = errText(e);
    if (/沒有.*價格|沒有價格/.test(m)) throw new SiteError(409, `${m}。價格資料不完整，這份清單暫時算不出來。`);
    throw e;
  }
}

interface Mutation {
  acct: Account;
  result?: Record<string, unknown>;
  /** 只試算、不存檔。 */
  dry?: boolean;
  /** 存檔後要留下的快照原文。 */
  snapshot?: Snapshot;
  /** 和這一版帳戶一起寫的論點檔紀錄（own_thesis_log）。 */
  log?: ThesisLogInput[];
}

async function mutate(backend: SiteBackend, cause: string, extra: string[], fn: (d: Ready) => Mutation): Promise<{ after: Ready; result: Record<string, unknown> }> {
  const d = ready(await backend.load(extra));
  const r = engine(() => fn(d));
  if (!r.dry && r.acct.monthlyBlocked && !monthlyWait(r.acct)) {
    const month = d.today.slice(0, 7);
    r.acct = engine(() => resumeMonthly(r.acct, d.view, { order: d.rankOrder, vetoed: d.demo ? DEMO_SCRIPTS[d.demo.scenario].vetoes?.[month] : undefined, month })).acct;
  }
  const after: Ready = { ...d, acct: r.acct };
  annotate(ctxOf(after));
  if (!r.dry) {
    await backend.save(r.acct, cause, r.log);
    if (r.snapshot) await backend.recordSnapshot(d.view.date, r.snapshot);
  }
  return { after, result: r.result ?? {} };
}

function premisesOf(v: unknown): Premise[] {
  if (!Array.isArray(v)) return [];
  const out: Premise[] = [];
  for (const p of v.slice(0, 5)) {
    const o = (p ?? {}) as Record<string, unknown>;
    const t = text(o.text, '前提', 300, false);
    if (!t) continue;
    const origin = o.origin === 'AI_DRAFT_ACCEPTED' ? 'AI_DRAFT_ACCEPTED' : 'USER';
    const breaksIf = text(o.breaksIf, '不成立的訊號', 300, false);
    out.push({ id: `P${out.length + 1}`, text: t, origin, ...(breaksIf ? { breaksIf } : {}) });
  }
  return out;
}

/** 自己發起的入金／出金／改比例：試算後按確定就等於決定了（第 1 步沒有東西可選），直接回覆成「等你下單」。月報合併的入金照常要決定。 */
function decided(acct: Account, view: MarketView, n: Notif): Account {
  if (n.kind !== 'CASHFLOW' || n.status !== 'PENDING') return acct;
  return respond(acct, view, n.id, { mode: 'DO' });
}

// ---------------------------------------------------------------- 建立帳戶（上線那天的第一份快照）

async function createFromSnapshot(backend: SiteBackend, b: Record<string, unknown>): Promise<Response> {
  if (backend.mode !== 'real') throw new SiteError(400, '示範模式不用建立帳戶');
  const rows = (v: unknown) => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []).filter((r) => String(r?.ticker ?? '').trim() !== '').slice(0, 40);
  const own = rows(b.own).map((r) => ({ ticker: ticker(r.ticker), shares: num(r.shares, '股數', 0, 1e7), stdWeight: r.stdWeight === undefined || r.stdWeight === '' || r.stdWeight === null ? null : stdWeightOf(r.stdWeight), premises: premisesOf(r.premises) }));
  const mom = rows(b.mom).map((r) => ({ ticker: ticker(r.ticker), shares: num(r.shares, '股數', 0, 1e7) }));
  const cash = num(b.cash ?? 0, '現金', 0, 1e10);
  const coreShares = num(b.coreShares ?? 0, '核心 ETF 股數', 0, 1e7);
  const bondShares = num(b.bondShares ?? 0, '短債 ETF 股數', 0, 1e7);
  const dup = (xs: { ticker: string }[]) => xs.find((x, i) => xs.findIndex((y) => y.ticker === x.ticker) !== i);
  const d1 = dup(own) ?? dup(mom);
  if (d1) throw new SiteError(422, `${d1.ticker} 在同一桶裡填了兩次`);
  const core = 'VOO';
  const bond = 'SGOV';
  if ([...own, ...mom].some((x) => x.ticker === core || x.ticker === bond)) throw new SiteError(422, `${core} 和 ${bond} 屬於核心，請填在核心那一欄`);
  const tickers = [core, bond, ...own.map((x) => x.ticker), ...mom.map((x) => x.ticker)];
  const d = await backend.load(tickers);
  if (d.acct) throw new SiteError(409, '帳戶已經建立過了');
  if (!d.view) throw new SiteError(409, '還沒有價格資料：每日抓取要先跑過一次。');
  const view = d.view;
  const missing = tickers.filter((t) => !view.close[t] || !Number.isFinite(view.close[t][view.i]));
  if (missing.length) throw new SiteError(422, `抓不到這些代號在 ${view.date} 的收盤價：${missing.join('、')}。請確認代號，或稍後再試。`);
  const rec = own.length ? recommendStdWeights(view, own.map((x) => x.ticker), 0.2) : {};
  const init: InitialAccount = {
    paper: b.paper !== false,
    // 券商現在顯示的股數已經包含生效日在今天（美東）以前的拆股（design_v2 §10 第 48 點）
    ...(d.asOf ? { asOf: d.asOf } : {}),
    // 依波動度減碼的起始歷史：接上回測重放到 2026-09 的每月 σ（design_v2 §10 第 31 點）；不補的話要等 24 個月才會開始減碼
    volHist: [...VOL_HIST_SEED.values],
    cash,
    core: { ...(coreShares ? { [core]: coreShares } : {}), ...(bondShares ? { [bond]: bondShares } : {}) },
    mom: Object.fromEntries(mom.filter((x) => x.shares > 0).map((x) => [x.ticker, x.shares])),
    own: Object.fromEntries(
      own.map((x) => [
        x.ticker,
        {
          shares: x.shares,
          stdWeight: x.stdWeight ?? rec[x.ticker],
          // 和新增自選相同：現在已經比 52 週高點低 20% 以上，一開始就記成減半，不會第一天就收到減半通知
          state: drawdownFromHigh(view.close[x.ticker], view.i, SLOW.highDays) <= SLOW.drawdown ? ('HALF' as const) : ('STD' as const),
          premises: x.premises.length ? x.premises : clone(SYSTEM_DEFAULT_PREMISES),
        },
      ]),
    ),
  };
  const acct = engine(() => createAccount(init, view));
  if (totalValue(acct, view) <= 0) throw new SiteError(422, '帳戶是空的：至少要有現金或一檔持股');
  await backend.save(acct, '建立帳戶');
  const shares: Record<string, number> = {};
  for (const lots of [acct.lots.own, acct.lots.mom, acct.lots.core]) for (const [t, q] of Object.entries(lots)) shares[t] = (shares[t] ?? 0) + q;
  await backend.recordSnapshot(view.date, { shares, cash });
  return json({ ok: true });
}

// ---------------------------------------------------------------- 編輯論點（T27，own_thesis §1.8）

const COND_ACTION_SET: readonly CondAction[] = ['EXIT', 'HALF', 'REVIEW'];

/** 出場條件：[{ text, action }]，最多 6 條，每條 300 字；動作不認得的當成重新審查。 */
function exitsOf(v: unknown): ExitLine[] {
  if (!Array.isArray(v)) return [];
  if (v.length > THESIS_LIMITS.exits) throw new SiteError(422, `出場條件最多 ${THESIS_LIMITS.exits} 條`);
  const out: ExitLine[] = [];
  for (const x of v) {
    const o = (x ?? {}) as Record<string, unknown>;
    const t = text(o.text, '出場條件', THESIS_LIMITS.exit, false);
    if (!t) continue;
    out.push({ text: t, action: COND_ACTION_SET.includes(o.action as CondAction) ? (o.action as CondAction) : 'REVIEW' });
  }
  return out;
}

/**
 * POST /api/ops/own-thesis：{ ticker, thesis, premises: [{ id?, text }], exitConditions: [{ text, action }], source, replyTo?, dry? }
 *   1. 論點與前提立刻存進帳戶狀態（version 加 1），log 寫 THESIS（含出場條件的原文，免得改寫失敗時不見）
 *   2. 出場條件送去改寫（一票）；送出失敗或 AI 層沒設定 → 回 rewrite.status = FAILED，頁面顯示「還沒送去改寫」與「重送」
 *   3. 出場條件不存成前提
 * dry：只算前提的對應（沿用、新的、會撤下），不存。
 * replyTo：這是對乙類通知 #N 的回應（修正論點，own_thesis §1.10）：那一項結案、afterBreak 加 1、log 寫 RESPONSE（REVISE）；
 *   新的前提還留著被判不成立的那一條 → 當成不同意（DISAGREE，進靜默期）。通知已經回覆過、或不是這檔的乙類 → 409。
 */
async function saveThesis(backend: SiteBackend, b: Record<string, unknown>): Promise<Response> {
  const tk = ticker(b.ticker);
  const thesisText = text(b.thesis, '論點', THESIS_LIMITS.thesis, false);
  const rawPs = Array.isArray(b.premises) ? b.premises : [];
  if (rawPs.length > THESIS_LIMITS.premises) throw new SiteError(422, `前提最多 ${THESIS_LIMITS.premises} 條`);
  const premises = rawPs
    .map((p) => {
      const o = (p ?? {}) as Record<string, unknown>;
      return { id: typeof o.id === 'string' && /^P\d{1,4}$/.test(o.id) ? o.id : null, text: text(o.text, '前提', THESIS_LIMITS.premise, false) };
    })
    .filter((p) => p.text);
  const exits = exitsOf(b.exitConditions);
  const source = b.source === 'DISCUSSION' ? 'DISCUSSION' : 'TYPED';
  const replyTo = b.replyTo === undefined || b.replyTo === null || b.replyTo === '' ? null : Number(b.replyTo);
  const dry = b.dry === true;
  const r = await mutate(backend, `${tk} 編輯論點`, [], (d) => {
    if (!d.acct.own[tk]) throw new SiteError(422, `${tk} 不在自選裡`);
    // 對乙類通知的回應（修正論點，own_thesis §1.10）：那則通知要還沒回覆、而且有這檔的乙類項目
    if (replyTo !== null) {
      const n = findNotif(d.acct, Number.isInteger(replyTo) ? replyTo : -1);
      if (!dry && !revisableBreak(d.acct, n.id, tk)) throw new SiteError(409, n.status !== 'PENDING' ? `${notifName(n)}已經回覆過了，不能再用「修正論點」回應。取消勾選「這是對…的回應」再存。` : `${notifName(n)}不是 ${tk} 的「AI 判斷前提不成立」通知，不能用「修正論點」回應。取消勾選再存。`);
    }
    // 這檔有還沒回覆、帶「AI 建議出清」那一行的慢規則通知時存論點：一樣算「失效後修改」（§3.4；通知本身仍要回去選一項）
    const ruleExit = !dry && d.acct.notifs.some((n) => n.status === 'PENDING' && n.items.some((i) => i.ticker === tk && !i.cancelled && i.brk?.type === 'B' && !!i.brk.withRule));
    let out: ReturnType<typeof setThesis>;
    try {
      out = setThesis(d.acct, tk, { text: thesisText, source, premises, date: d.view.date, afterBreak: replyTo !== null || ruleExit });
    } catch (e) {
      throw new SiteError(422, errText(e));
    }
    // 通知結案；新的前提還留著那一條 → 當成不同意（靜默期）
    const rv = replyTo !== null && !dry ? reviseBreak(out.acct, d.view, replyTo, tk) : null;
    if (rv?.ok) out = { ...out, acct: rv.acct };
    const meta = out.acct.own[tk];
    const brief = (ps: Premise[]) => ps.map((p) => ({ id: p.id, text: p.text, origin: p.origin }));
    const result = {
      preview: {
        kept: out.mapping.premises.filter((p) => out.mapping.kept.includes(p.id)).map((p) => ({ id: p.id, text: p.text })),
        added: out.mapping.premises.filter((p) => out.mapping.added.includes(p.id)).map((p) => ({ id: p.id, text: p.text })),
        retired: out.mapping.retired.map((p) => ({ id: p.id, text: p.text, origin: p.origin })),
        changed: out.changed,
        version: meta.thesis!.version,
      },
    };
    const log: ThesisLogInput[] = meta.fileId
      ? [
          {
            ticker: tk,
            fileId: meta.fileId,
            session: d.view.date,
            kind: 'THESIS',
            body: {
              version: meta.thesis!.version,
              source,
              before: { text: out.before.text, premises: brief(out.before.premises) },
              after: { text: meta.thesis!.text, premises: brief(meta.premises) },
              retired: out.mapping.retired.map((p) => p.id),
              afterBreak: !!rv?.ok || ruleExit,
              replyTo,
              exitLines: exits.map((e) => e.text),
              exitActions: exits.map((e) => e.action),
            },
          },
          // 乙類的回應：修正論點（REVISE）；保留了那條前提 → 當成不同意（DISAGREE，理由固定）
          ...(rv?.ok ? [{ ticker: tk, fileId: meta.fileId, session: d.view.date, kind: 'RESPONSE' as const, ref: String(replyTo), body: { notif: replyTo, type: 'B', outcome: rv.kept ? 'DISAGREE' : 'REVISE', reason: rv.kept ? KEPT_REASON : null, premiseId: rv.premiseId } }] : []),
        ]
      : [];
    const rn = replyTo === null ? undefined : d.acct.notifs.find((x) => x.id === replyTo);
    return { acct: out.acct, dry, result: { ...result, revised: rv?.ok ? { notif: replyTo, kept: rv.kept, premiseId: rv.premiseId } : null, revisedName: rv?.ok && rn ? notifName(rn) : null }, log };
  });
  if (dry) return json({ ok: true, ...r.result });
  // 出場條件送去改寫：失敗要明白告訴使用者（N9），之後持股頁也會一直提示到重送為止
  let rewrite: { status: 'SENT' | 'FAILED' | 'NONE'; runId?: string; error?: string } = { status: 'NONE' };
  if (exits.length) {
    if (!backend.ai) rewrite = { status: 'FAILED', error: '示範模式沒有真的 AI，出場條件沒有送去改寫。' };
    else
      try {
        rewrite = { status: 'SENT', runId: (await backend.ai.ownCheck(tk, exits)).runId };
      } catch (e) {
        rewrite = { status: 'FAILED', error: errText(e) };
      }
  }
  return json({ ok: true, ...r.result, rewrite, exits });
}

// ---------------------------------------------------------------- 路由

async function route(req: Request, rest: string, url: URL, backend: SiteBackend): Promise<Response> {
  const get = req.method === 'GET';
  const post = req.method === 'POST';

  if (rest === 'state' && get) return json(stateView(await backend.load()));

  if (rest === 'history' && get) {
    const d = ready(await backend.load());
    // AI 紀錄（示範模式只有腳本裡的假說明）與影子組合的三條線
    const runs = d.demo ? d.aiNotes.map(rowOfNote) : (await backend.runs()).map((r) => withPreviewNote(runRow(r), r, d.acct));
    const live = liveShadow([...d.shadow, ...d.acct.shadow]);
    const book = bookFromView(d.axis, d.view.close);
    // 崩盤規則的檢視紀錄（core_ai §3.4）：每次切換一列，照規則、照 AI、你實際、照規則比延後
    return json({ ...historyView(d), runs, shadowSum: shadowSummary(live, book), crashLog: crashLogView(d.acct, live, book) });
  }

  const aiRun = /^ai\/run\/([A-Za-z0-9_.-]{1,100})(\/md)?$/.exec(rest);
  if (aiRun && get) {
    const id = aiRun[1];
    if (id.startsWith('demo-')) {
      const d = await backend.load();
      const note = d.demo ? d.aiNotes[Number(id.slice(5))] : undefined;
      if (!note) throw new SiteError(404, '找不到這次 AI 執行');
      if (aiRun[2]) throw new SiteError(400, '示範資料沒有完整的紀錄可以匯出');
      return json({ ...rowOfNote(note, Number(id.slice(5))), note });
    }
    const run = await backend.run(id);
    if (!run) throw new SiteError(404, '找不到這次 AI 執行');
    const d = await backend.load(run.ticker ? [run.ticker] : []);
    if (aiRun[2]) {
      const background: string[] = [];
      if (d.acct && d.view) {
        const a = d.acct;
        const total = totalValue(a, d.view);
        background.push(`帳戶分三桶：自選 ${pct(a.cfg.ratio.own)}、動能 ${pct(a.cfg.ratio.strat)}、核心 ${pct(a.cfg.ratio.core)}（比例是風險預算，不是目標）${a.paper ? '；目前是紙上交易' : ''}。`);
        if (run.ticker) {
          const px = d.view.close[run.ticker]?.[d.view.i];
          const held = (['own', 'mom', 'core'] as const).map((b) => [b, a.lots[b][run.ticker!] ?? 0] as const).filter(([, n]) => n);
          if (held.length && px) background.push(`${run.ticker} 目前持有：${held.map(([b, n]) => `${{ own: '自選', mom: '動能', core: '核心' }[b]} ${n} 股`).join('、')}，占總資產 ${pct((held.reduce((x, [, n]) => x + n, 0) * px) / total)}。`);
          const st = a.rule.own[run.ticker];
          if (st) background.push(`自選慢規則：${st.applied === 'HALF' ? '減半中' : '標準'}；標準比重 ${pct(st.stdWeight)}。`);
        }
      }
      return new Response(exportMd(run, { background }), { headers: { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="${run.runId}.md"` } });
    }
    const fu = run.ticker && d.view ? followUp(bookFromView(d.axis, d.view.close), run.ticker, run.asOf, BENCHMARK) : null;
    return json(runDetail(run, fu));
  }

  if (rest === 'account' && post) return createFromSnapshot(backend, await body(req));

  const hold = /^holding\/([A-Za-z0-9.-]{1,10})$/.exec(rest);
  if (hold && get) {
    const tk = ticker(hold[1]);
    const d = ready(await backend.load());
    const hd = holdingDetail(d, tk);
    // 真實模式：這檔監測中的條件（AI 寫的、你寫的）、最近 30 天還沒勾的改寫結果、要看的事
    // 動能持股：最近 90 天的事件與動能的「要看的事」（含進場時的附註；momentum_ai §3.6）
    // 論點那一塊（T34）：前提最近一次的檢查、事件時間軸、歷次審查與回應、靜默中的前提、減半檢視
    if (backend.ai) return json({ ...hd, monitor: await backend.ai.monitor(tk), rewrites: await backend.ai.rewrites(tk), attention: await backend.ai.attention(tk, d.acct, d.view).catch(() => []), mom: await backend.ai.mom(tk, d.acct, d.view, d.rankOrder).catch(() => null), thesis: await backend.ai.thesis(tk, d.acct, d.view).catch(() => null) });
    // 示範模式（T34 的決定）：論點檔只有帳戶狀態（沒有條件、事件、審查紀錄），論點那一塊與「要看的事」從它算
    return json({ ...hd, ...demoHolding(d.acct, d.view, tk) });
  }

  // ---- 論點（T27，own_thesis §1.7、§1.8）：討論包、貼回的解析、編輯論點
  const disc = /^own\/([A-Za-z0-9.-]{1,10})\/discussion$/.exec(rest);
  if (disc && get) {
    const tk = ticker(disc[1]);
    const d = ready(await backend.load());
    if (!d.acct.own[tk]) throw new SiteError(422, `${tk} 不在自選裡`);
    const q = url.searchParams.get('mode');
    const mode = q ? (DISCUSSION_MODES.find((m) => m === q) ?? null) : null;
    if (q && !mode) throw new SiteError(422, 'mode 只能是 NEW、ROUTINE 或 BREAK');
    const nq = url.searchParams.get('notif');
    let notif = nq ? Number(nq) : null;
    if (notif !== null) findNotif(d.acct, Number.isInteger(notif) ? notif : -1);
    // 沒指定情境、這檔有還沒回覆的乙類通知（從持股頁按「複製討論包」）→ 照那一則組 BREAK 情境（T34 走一遍的缺口：原本給例行檢視，討論不到被判不成立的那條前提）
    if (notif === null && !mode) notif = pendingBreakOf(d.acct, tk)?.notif ?? null;
    const out = backend.ai ? await backend.ai.discussion(tk, d.acct, d.view, mode, notif) : await demoDiscussion(d.acct, d.view, tk, mode, notif);
    return json(out);
  }
  if (rest === 'ops/own-thesis/parse' && post) {
    const b = await body(req);
    const tk = ticker(b.ticker);
    return json(parseThesisBlock(text(b.text, '貼上的內容', 30_000, false), tk));
  }
  if (rest === 'ops/own-thesis' && post) return saveThesis(backend, await body(req));

  // ---- AI 層（F14 改寫、F1／F5／F18 的總覽）：只有真實模式
  if (rest === 'ai/overview' && get) {
    if (!backend.ai) return json({ macro: null, reviews: [], vetoes: [], events: [] });
    const o = await backend.ai.overview();
    // 歷次否決：被否決者與遞補者之後 3、6 個月相對基準的報酬（momentum_ai §3.7；只用已經存的價格，不當場抓）
    let book: ReturnType<typeof bookFromView> | null = null;
    if (o.vetoes.length) {
      const d = await backend.load().catch(() => null);
      if (d?.view) book = bookFromView(d.axis, d.view.close);
    }
    // 申報事件的來源與說明換成白話（和持股頁一樣；掃描寫的類別代號、條件編號不給使用者看）
    const events = o.events.map((e) => ({ ...e, form: eventSource(e), detail: eventDetail(e.detail) }));
    return json({ ...o, events, vetoes: o.vetoes.map((v) => vetoView(book, v, BENCHMARK)) });
  }
  if (rest === 'ops/own-check' && post) {
    // 重送出場條件去改寫（編輯論點頁送出失敗、或改寫沒有結果時）
    if (!backend.ai) throw new SiteError(400, '示範模式沒有真的 AI，出場條件沒有辦法送去改寫。');
    const b = await body(req);
    const tk = ticker(b.ticker);
    const exits = exitsOf(b.exits);
    if (!exits.length) throw new SiteError(422, '沒有要改寫的出場條件');
    try {
      return json({ ok: true, ...(await backend.ai.ownCheck(tk, exits)) });
    } catch (e) {
      throw new SiteError(422, errText(e));
    }
  }
  const chk = /^ai\/own-check\/([A-Za-z0-9_.-]{1,100})$/.exec(rest);
  if (chk && get) {
    if (!backend.ai) throw new SiteError(400, '示範模式沒有真的 AI。');
    const v = await backend.ai.checkView(chk[1]);
    if (!v) throw new SiteError(404, '找不到這次健檢');
    return json(v);
  }
  if (rest === 'ops/own-conditions' && post) {
    if (!backend.ai) throw new SiteError(400, '示範模式沒有真的 AI。');
    const b = await body(req);
    const tk = ticker(b.ticker);
    const runId = typeof b.runId === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(b.runId) ? b.runId : null;
    if (!runId) throw new SiteError(422, '缺少健檢的編號');
    const ids = Array.isArray(b.ids) ? b.ids.filter((x): x is string => typeof x === 'string').slice(0, 10) : [];
    if (!ids.length) throw new SiteError(422, '至少勾一條');
    const actions = b.actions && typeof b.actions === 'object' && !Array.isArray(b.actions) ? (b.actions as Record<string, unknown>) : {};
    try {
      return json({ ok: true, added: await backend.ai.acceptConditions(tk, runId, ids, actions) });
    } catch (e) {
      throw new SiteError(422, errText(e));
    }
  }
  // 條件的所有權（T26，own_thesis §1.5）：勾選 AI 建議的條件（accept）、撤下你定的條件（retire）、改成立時的動作（action）
  if (rest === 'ops/own-condition' && post) {
    if (!backend.ai) throw new SiteError(400, '示範模式沒有真的 AI。');
    const b = await body(req);
    const tk = ticker(b.ticker);
    const id = typeof b.id === 'number' && Number.isInteger(b.id) && b.id > 0 ? b.id : null;
    if (!id) throw new SiteError(422, '缺少條件的編號');
    const op = b.op === 'accept' || b.op === 'retire' || b.op === 'action' ? b.op : null;
    if (!op) throw new SiteError(422, '操作只能是 accept、retire 或 action');
    try {
      return json({ ok: true, ...(await backend.ai.condition(tk, id, op, b.action)) });
    } catch (e) {
      throw new SiteError(422, errText(e));
    }
  }

  // ---- 通知
  const nm = /^notif\/(\d{1,9})(?:\/([a-z]+))?$/.exec(rest);
  if (nm) {
    const id = Number(nm[1]);
    const act = nm[2];
    if (!act && get) {
      const d = ready(await backend.load());
      return json(notifView(d, findNotif(d.acct, id)));
    }
    if (!post) throw new SiteError(405, '這個網址只接受 POST');
    const b = await body(req);
    if (act === 'preview') {
      // 改選項時，核心那一行會跟著變：照畫面上目前的選擇重算一次（不存檔）
      const d = ready(await backend.load());
      const n = clone(findNotif(d.acct, id));
      const choices = (b.choices ?? {}) as Record<string, string>;
      const pick = (nn: Notif, cs: Record<string, string>) => {
        for (const it of nn.items) if (cs[it.key] && it.choices.some((c) => c.id === cs[it.key])) it.choice = cs[it.key] as typeof it.choice;
      };
      pick(n, choices);
      const after = composedView(d, n, engine(() => composeNotif(d.acct, d.view, n)));
      // 史萊姆那句話：只講剛剛改的那一個選項造成的結果（改之前也照樣算一次清單來比）
      const ch = (b.changed ?? null) as { key?: unknown; from?: unknown } | null;
      const it = ch ? n.items.find((x) => x.key === ch.key) : undefined;
      if (!ch || !it || typeof ch.from !== 'string' || !it.choices.some((c) => c.id === ch.from)) return json(after);
      const n0 = clone(findNotif(d.acct, id));
      pick(n0, { ...choices, [it.key]: ch.from });
      const before = composedView(d, n0, engine(() => composeNotif(d.acct, d.view, n0)));
      const item = notifView(d, n).items.find((x) => x.key === it.key)!;
      return json({ ...after, effect: choiceEffect({ item, from: ch.from, to: it.choice, before, after, account: accountView(d) }) });
    }
    if (act === 'respond') {
      const mode = b.mode === 'SKIP' ? 'SKIP' : 'DO';
      const choices = (b.choices ?? {}) as Record<string, 'RULE' | 'AI' | 'DO' | 'SKIP'>;
      const raw = b.reasons && typeof b.reasons === 'object' && !Array.isArray(b.reasons) ? (b.reasons as Record<string, unknown>) : {};
      const reasons = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, String(v ?? '').trim()]));
      const r = await mutate(backend, `回覆通知 #${id}`, [], (d) => {
        const n = findNotif(d.acct, id);
        if (n.status !== 'PENDING') throw new SiteError(409, '這則通知已經回覆過了');
        // 甲類的「這次不做」、當天乙類的「不同意，不動」、慢規則減半項目與崩盤項目的「這次不做」要寫一句理由（own_thesis §1.10、§3.4；core_ai §3.6）
        const miss = missingReasons(n, { mode, choices, reasons });
        if (miss.length) throw new SiteError(422, `${miss.map((it) => `「${it.f === 'F5' || it.f === 'F6' ? '崩盤規則' : (it.ticker ?? it.title)}」`).join('、')}選了不做，要寫一句理由（1～${REASON_MAX} 字）`);
        const long = n.items.find((it) => (reasons[it.key] ?? '').length > REASON_MAX);
        if (long) throw new SiteError(422, `理由最多 ${REASON_MAX} 個字`);
        const acct = respond(d.acct, d.view, id, { mode, choices, reasons });
        // 失效通知的回應寫進論點檔（own_thesis §1.10），下一次審查的證據包看得到：
        //   甲類：照當時的決定 FOLLOW／這次不做 SKIPPED＋理由
        //   乙類：照 AI FOLLOW／不同意並寫理由 DISAGREE／月報裡沒動它 SKIPPED（後兩種的前提進靜默期，respond 寫好了）
        const after = acct.notifs.find((x) => x.id === id)!;
        const log: ThesisLogInput[] = after.items.flatMap((it) => {
          const fileId = it.brk && it.ticker ? d.acct.own[it.ticker]?.fileId : undefined;
          // 慢規則減半項目上帶「AI 建議出清」的不是乙類：回應在下面寫成 type R
          if (!fileId || !it.brk || it.cancelled || (it.brk.type === 'B' && it.brk.withRule)) return [];
          const skip = it.choice === 'SKIP';
          const body =
            it.brk.type === 'A'
              ? { notif: id, type: 'A', outcome: skip ? 'SKIPPED' : 'FOLLOW', reason: it.reason ?? null }
              : { notif: id, type: 'B', outcome: !skip ? 'FOLLOW' : it.reason ? 'DISAGREE' : 'SKIPPED', reason: skip ? (it.reason ?? null) : null, premiseId: it.brk.premiseId };
          return [{ ticker: it.ticker!, fileId, session: d.view.date, kind: 'RESPONSE' as const, ref: String(id), body }];
        });
        // 慢規則減半項目的回應（type R，own_thesis §3.4）：照規則／照 AI／這次不做＋理由，連同當時 AI 給的選項
        log.push(...ruleResponseLogs(d.acct, after, d.view.date));
        return { acct, log };
      });
      return json({ ok: true, status: findNotif(r.after.acct, id).status });
    }
    if (act === 'cancel') {
      // 取消自己發起的入金／出金／改比例（填快照之前）
      await mutate(backend, `通知 #${id}：取消`, [], (d) => {
        const out = cancelCashflow(d.acct, d.view, id);
        if (!out.ok) throw new SiteError(409, out.error ?? '這份清單不能取消');
        return { acct: out.acct };
      });
      return json({ ok: true });
    }
    if (act === 'reopen') {
      // 上一步：已經回覆、還沒填快照的清單退回「等你決定」
      await mutate(backend, `通知 #${id}：改決定`, [], (d) => {
        const n = findNotif(d.acct, id);
        if (n.status === 'PENDING') throw new SiteError(409, '這則通知本來就還沒決定');
        const out = reopen(d.acct, d.view, id);
        if (!out.ok) throw new SiteError(409, '這份清單已經結束（填過快照，或這次不做），不能再改決定');
        return { acct: out.acct };
      });
      return json({ ok: true });
    }
    if (act === 'action') {
      const action = b.action === 'TRANSFER' || b.action === 'EXCLUDE' || b.action === 'ADOPT' ? b.action : null;
      if (!action) throw new SiteError(422, '不認得這個動作');
      const reason = text(b.reason, '一句理由');
      const key = String(b.key ?? '');
      const r = await mutate(backend, `通知 #${id}：${action}`, [], (d) => {
        const out = itemAction(d.acct, d.view, id, key, { action, reason });
        if (!out.notif) throw new SiteError(409, '這個動作現在不能做（通知已經回覆，或這一項不支援）');
        return { acct: out.acct, result: { notifId: out.notif.id } };
      });
      return json({ ok: true, ...r.result });
    }
    if (act === 'followup') {
      const fix = b.fix === true;
      const r = await mutate(backend, `通知 #${id}：${fix ? '補做差額' : '就這樣'}`, [], (d) => {
        if (!findNotif(d.acct, id).followUpOpen) throw new SiteError(409, '這則通知沒有等你回答的差額');
        const out = resolveFollowUp(d.acct, d.view, id, fix);
        return { acct: out.acct, result: { notifId: out.notif?.id ?? null } };
      });
      return json({ ok: true, ...r.result });
    }
    if (act === 'classify') {
      const bucket = b.bucket === 'mom' ? 'mom' : 'own';
      const reason = text(b.reason, '理由', 300, false);
      const r = await mutate(backend, `通知 #${id}：分類到${bucket === 'own' ? '自選' : '動能'}`, [], (d) => {
        const out = classify(d.acct, d.view, id, { bucket, reason: reason || undefined, removeOwn: b.removeOwn === true });
        if (out.error) throw new SiteError(422, out.error);
        let acct = out.acct;
        let monthlyId: number | null = null;
        if (out.monthlyUnblocked) {
          // 分類完，暫停的月報用暫停時留下的輸入（訊號日的排名）重算；舊的通知沒有留輸入時用目前的排名
          const month = d.today.slice(0, 7);
          const m = resumeMonthly(acct, d.view, { order: d.rankOrder, vetoed: d.demo ? DEMO_SCRIPTS[d.demo.scenario].vetoes?.[month] : undefined, month });
          acct = m.acct;
          monthlyId = m.notif?.id ?? null;
        }
        return { acct, result: { monthlyUnblocked: out.monthlyUnblocked, notifId: monthlyId } };
      });
      return json({ ok: true, ...r.result });
    }
    if (act === 'cash') {
      const kind = (['入金', '出金', '股利', '其他'] as const).find((k) => k === b.kind);
      if (!kind) throw new SiteError(422, '請選這筆現金是什麼');
      await mutate(backend, `通知 #${id}：現金差額是${kind}`, [], (d) => {
        const n = findNotif(d.acct, id);
        if (n.kind !== 'CASH_DIFF' || n.status !== 'PENDING') throw new SiteError(409, '這則通知不用回答');
        if ((kind === '入金' && (n.amount ?? 0) < 0) || (kind === '出金' && (n.amount ?? 0) > 0)) throw new SiteError(422, (n.amount ?? 0) > 0 ? '現金變多了，不會是出金' : '現金變少了，不會是入金');
        return { acct: explainCash(d.acct, d.view, id, kind) };
      });
      return json({ ok: true });
    }
    throw new SiteError(404, '沒有這個網址');
  }

  // ---- 快照
  if (rest === 'snapshot/form' && get) return json(snapshotForm(ready(await backend.load())));
  if (rest === 'snapshot' && post) {
    const b = await body(req);
    const shares: Record<string, number> = {};
    // 分桶快照（網站從 2026-11-15 起用這個）：每一桶每一檔的股數；沒給就是舊的總股數快照
    let lots: BucketShares | undefined;
    if (b.lots && typeof b.lots === 'object') {
      const raw = b.lots as Record<string, unknown>;
      lots = { own: {}, mom: {}, core: {} };
      let n = 0;
      for (const bk of ['own', 'mom', 'core'] as const) {
        const rows = (raw[bk] ?? {}) as Record<string, unknown>;
        for (const [k, v] of Object.entries(rows)) {
          if (++n > 120) throw new SiteError(422, '代號太多了');
          const q = num(v, `${k} 的股數`, 0, 1e7);
          if (q <= 0) continue;
          const t = ticker(k);
          lots[bk][t] = (lots[bk][t] ?? 0) + q;
          shares[t] = (shares[t] ?? 0) + q;
        }
      }
    } else {
      const raw = (b.shares ?? {}) as Record<string, unknown>;
      for (const [k, v] of Object.entries(raw).slice(0, 80)) {
        const q = num(v, `${k} 的股數`, 0, 1e7);
        if (q > 0) shares[ticker(k)] = q;
      }
    }
    const why: Record<string, string> = {};
    for (const [k, v] of Object.entries((b.why ?? {}) as Record<string, unknown>).slice(0, 20)) {
      const w = text(v, `${k} 為什麼買`, 300, false);
      if (w) why[ticker(k)] = w;
    }
    // 現金可以是負的（融資帳戶，或示範裡買超過現金）；畫面上會提醒
    const note = text(b.note, '這次自己交易的原因', 300, false);
    const snap: Snapshot = { shares, cash: num(b.cash, '現金', -1e10, 1e10), ...(lots ? { lots } : {}), ...(note ? { note } : {}), ...(Object.keys(why).length ? { why } : {}), ...(b.withdrawPending === true ? { withdrawPending: true } : {}) };
    // 拆股生效、每日流程還沒跑就照券商填了 N 倍的股數：先向 Yahoo 查那幾檔，記到的拆股在載入帳戶時套用（design_v2 §10 第 48 點）
    if (backend.checkSplits) await backend.checkSplits(shares);
    let before: Account | null = null;
    const r = await mutate(backend, '填快照', Object.keys(shares), (d) => {
      before = d.acct;
      if (d.asOf) snap.asOf = d.asOf;
      const noPrice = Object.keys(shares).filter((t) => !d.view.close[t] || !Number.isFinite(d.view.close[t][d.view.i]));
      if (noPrice.length) throw new SiteError(422, `抓不到 ${noPrice.join('、')} 在 ${d.view.date} 的收盤價。請確認代號有沒有打錯。`);
      const wasBlocked = d.acct.monthlyBlocked;
      const out = applySnapshot(d.acct, d.view, snap, d.fill);
      if (out.error) throw new SiteError(422, out.error);
      let acct = out.acct;
      let monthlyId: number | null = null;
      if (wasBlocked && !acct.monthlyBlocked) {
        // 舊的未分類持股這次放進桶裡了：暫停的月報照分類後的做法重算
        const m = resumeMonthly(acct, d.view, { order: d.rankOrder, vetoed: d.demo ? DEMO_SCRIPTS[d.demo.scenario].vetoes?.[d.today.slice(0, 7)] : undefined, month: d.today.slice(0, 7) });
        acct = m.acct;
        monthlyId = m.notif?.id ?? null;
      }
      return {
        acct,
        snapshot: snap,
        result: { completed: out.completed, followUps: out.followUps, created: out.created.map((n) => ({ id: n.id, kind: n.kind, title: n.title })), cashOther: out.cashOther, cashWarn: out.cashWarn, removedOwn: out.removedOwn, monthlyId },
      };
    });
    // 送出前的帳戶留下來，填錯了可以復原（只留最後一份；之後帳戶有變動就不能復原）
    if (before) await backend.saveUndo(before, r.after.acct, r.after.view.date, { cashOther: Number(r.result.cashOther) || 0, cashWarn: r.result.cashWarn === true });
    return json({ ok: true, ...r.result, undoable: true });
  }
  if (rest === 'snapshot/undo' && post) {
    const out = await backend.undoSnapshot();
    if (!out.ok) throw new SiteError(409, out.reason);
    return json({ ok: true, date: out.date });
  }

  // ---- 持股頁：改標準比重（2026-11-15 起取代新增自選頁的這一項；前提改在「編輯論點」頁，T27）
  if (rest === 'ops/std-weight' && post) {
    const b = await body(req);
    const tk = ticker(b.ticker);
    const w = stdWeightOf(b.stdWeight);
    await mutate(backend, `改標準比重 ${tk} → ${pct(w)}`, [], (d) => {
      if (!d.acct.rule.own[tk]) throw new SiteError(422, `${tk} 不在自選裡`);
      return { acct: setStdWeight(d.acct, tk, w) };
    });
    return json({ ok: true });
  }

  // ---- 你自己的操作：先試算（dry），確定了才存
  if (rest === 'ops/deposit' && post) {
    const b = await body(req);
    const amount = num(b.amount, '入金金額', 1, 1e9);
    const dry = b.dry === true;
    const r = await mutate(backend, `入金 ${amount}`, [], (d) => {
      const out = deposit(d.acct, d.view, amount);
      return { acct: dry ? out.acct : decided(out.acct, d.view, out.notif), dry, result: { notifId: out.notif.id, mergedIntoMonthly: out.mergedIntoMonthly } };
    });
    return json({ ok: true, ...r.result, ...(dry ? { preview: notifView(r.after, findNotif(r.after.acct, r.result.notifId as number)) } : {}) });
  }
  if (rest === 'ops/withdraw' && post) {
    const b = await body(req);
    const amount = num(b.amount, '出金金額', 1, 1e9);
    const dry = b.dry === true;
    const r = await mutate(backend, `出金 ${amount}`, [], (d) => {
      const total = totalValue(d.acct, d.view);
      if (amount > total) throw new SiteError(422, `出金金額超過總資產（${Math.floor(total).toLocaleString('en-US')}）`);
      const out = withdraw(d.acct, d.view, amount);
      return { acct: dry ? out.acct : decided(out.acct, d.view, out.notif), dry, result: { notifId: out.notif.id } };
    });
    return json({ ok: true, ...r.result, ...(dry ? { preview: notifView(r.after, findNotif(r.after.acct, r.result.notifId as number)) } : {}) });
  }
  if (rest === 'ops/ratio' && post) {
    const b = await body(req);
    const ratio = { own: num(b.own, '自選比例', 0, 1), strat: num(b.strat, '動能比例', 0, 1), core: num(b.core, '核心比例', 0, 1) };
    if (Math.abs(ratio.own + ratio.strat + ratio.core - 1) > 1e-6) throw new SiteError(422, '三個比例加起來要是 100%');
    const dry = b.dry === true;
    const r = await mutate(backend, '改比例', [], (d) => {
      const old = d.acct.cfg.ratio;
      if (Math.abs(old.own - ratio.own) < 1e-9 && Math.abs(old.strat - ratio.strat) < 1e-9) throw new SiteError(422, '比例沒有變');
      const out = changeRatio(d.acct, d.view, ratio);
      return { acct: dry ? out.acct : decided(out.acct, d.view, out.notif), dry, result: { notifId: out.notif.id } };
    });
    return json({ ok: true, ...r.result, ...(dry ? { preview: notifView(r.after, findNotif(r.after.acct, r.result.notifId as number)) } : {}) });
  }
  if (rest === 'ops/add-own' && post) {
    const b = await body(req);
    const tk = ticker(b.ticker);
    const dry = b.dry === true;
    const premises = premisesOf(b.premises);
    const std = b.stdWeight === undefined || b.stdWeight === null || b.stdWeight === '' ? undefined : num(b.stdWeight, '標準比重', 0.001, 0.5);
    const r = await mutate(backend, `新增自選 ${tk}`, [tk], (d) => {
      if (d.acct.own[tk]) throw new SiteError(422, `${tk} 已經在自選裡了`);
      if (tk === d.acct.cfg.coreTicker || tk === d.acct.bondTicker) throw new SiteError(422, `${tk} 是核心的標的，不能加進自選`);
      if (!d.view.close[tk] || !Number.isFinite(d.view.close[tk][d.view.i])) throw new SiteError(422, `抓不到 ${tk} 在 ${d.view.date} 的收盤價。請確認代號有沒有打錯。`);
      if (d.view.i < 200 || !Number.isFinite(d.view.close[tk][d.view.i - 200])) throw new SiteError(422, `${tk} 的歷史價格不到 200 個交易日，慢規則還算不出來。`);
      const out = addOwn(d.acct, d.view, tk, premises, std);
      return { acct: out.acct, dry, result: { notifId: out.notif.id, startsHalved: out.startsHalved, recommended: out.recommended[tk] } };
    });
    return json({ ok: true, ...r.result, ...(dry ? { preview: notifView(r.after, findNotif(r.after.acct, r.result.notifId as number)) } : {}) });
  }
  if (rest === 'ops/remove-own' && post) {
    const b = await body(req);
    const tk = ticker(b.ticker);
    const dry = b.dry === true;
    const r = await mutate(backend, `移除自選 ${tk}`, [], (d) => {
      if (!d.acct.own[tk]) throw new SiteError(422, `${tk} 不在自選裡`);
      const out = removeOwn(d.acct, d.view, tk);
      return { acct: out.acct, dry, result: { notifId: out.notif.id } };
    });
    return json({ ok: true, ...r.result, ...(dry ? { preview: notifView(r.after, findNotif(r.after.acct, r.result.notifId as number)) } : {}) });
  }
  if (rest === 'ops/unexclude' && post) {
    const b = await body(req);
    const tk = ticker(b.ticker);
    await mutate(backend, `取消排除 ${tk}`, [], (d) => {
      if (!d.acct.mom.excluded[tk]) throw new SiteError(422, `${tk} 不在排除清單上`);
      return { acct: unexclude(d.acct, tk) };
    });
    return json({ ok: true });
  }

  // ---- 示範模式專用：換情境、讓時間前進
  if (backend.mode === 'demo') {
    const demo = backend as DemoBackend;
    if (rest === 'reset' && post) {
      const b = await body(req);
      const id = DEMO_IDS.find((x) => x === b.scenario) as DemoId | undefined;
      if (!id) throw new SiteError(422, '沒有這個情境');
      await demo.reset(id);
      return json({ ok: true });
    }
    if (rest === 'advance' && post) {
      const b = await body(req);
      const mode = b.mode === 'notif' || b.mode === 'month' ? b.mode : 'day';
      return json({ ok: true, ...(await demo.advance(mode)) });
    }
  }
  throw new SiteError(404, '沒有這個網址');
}

/** 不是網站 API 的路徑回傳 null。 */
export async function handleSite(req: Request, env: Env, fetcher: Fetcher, now: Date): Promise<Response | null> {
  const url = new URL(req.url);
  const m = /^\/(demo\/)?api\/(.*)$/.exec(url.pathname);
  if (!m) return null;
  const auth = await siteAuth(req, env, now);
  if (!auth.ok) return json({ error: 'unauthorized', reason: auth.reason, ...(lineLoginConfigured(env) ? { login: LOGIN_PATH } : {}) }, 401);
  if (req.method !== 'GET') {
    // 登入是靠瀏覽器自動帶的 cookie，所以要擋別的網站偷偷送出的請求：
    // 只收 JSON（別的網站要送 JSON 會先被瀏覽器的跨來源檢查擋下），而且來源必須是這個網站自己
    const origin = req.headers.get('Origin');
    if (origin && origin !== url.origin) return json({ error: '這個請求不是從 stock bot 的網站送出的。' }, 403);
    if (!(req.headers.get('Content-Type') ?? '').toLowerCase().startsWith('application/json')) return json({ error: '送出的內容要是 JSON。' }, 415);
  }
  const backend = m[1] ? demoBackend(env, now) : realBackend(env, fetcher, now);
  try {
    const res = await route(req, m[2], url, backend);
    res.headers.set('Cache-Control', 'no-store');
    return res;
  } catch (e) {
    if (e instanceof SiteError) return json({ error: e.message }, e.status);
    if (e instanceof ConflictError) return json({ error: e.message, conflict: true }, 409);
    console.error('網站 API 出錯', url.pathname, e);
    return json({ error: '系統出錯了，這次操作沒有存檔。' }, 500);
  }
}

export { accountView };
