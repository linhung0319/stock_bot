// 網站的 API（T8）。/api/* 是真實帳本，/demo/api/* 是示範資料；兩邊是同一組端點。
// 每個會改帳戶的端點都是：讀帳戶與市場 → 呼叫引擎的純函式 → 替新通知寫下理由 → 存檔。
import {
  SLOW,
  SYSTEM_DEFAULT_PREMISES,
  addOwn,
  applySnapshot,
  changeRatio,
  classify,
  clone,
  composeNotif,
  createAccount,
  deposit,
  drawdownFromHigh,
  explainCash,
  itemAction,
  monthlyReport,
  recommendStdWeights,
  removeOwn,
  reopen,
  resolveFollowUp,
  respond,
  totalValue,
  unexclude,
  withdraw,
  type Account,
  type InitialAccount,
  type MarketView,
  type Notif,
  type Premise,
  type Snapshot,
} from '../../engine';
import { errText } from '../../data/util';
import { DEMO_IDS, DEMO_SCRIPTS, type DemoId } from '../../demo/demoScripts';
import { json, type Env, type Fetcher } from '../env';
import { siteAuth } from './access';
import { ConflictError, demoBackend, realBackend, type DemoBackend, type SiteBackend, type SiteData } from './backend';
import { choiceEffect } from './bubble';
import { annotate } from './explain';
import { accountView, composedView, ctxOf, historyView, holdingDetail, notifView, snapshotForm, stateView } from './views';

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

function ticker(v: unknown): string {
  const t = String(v ?? '').trim().toUpperCase();
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
  if (!n) throw new SiteError(404, `找不到通知 #${id}`);
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
}

async function mutate(backend: SiteBackend, cause: string, extra: string[], fn: (d: Ready) => Mutation): Promise<{ after: Ready; result: Record<string, unknown> }> {
  const d = ready(await backend.load(extra));
  const r = engine(() => fn(d));
  const after: Ready = { ...d, acct: r.acct };
  annotate(ctxOf(after));
  if (!r.dry) {
    await backend.save(r.acct, cause);
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

// ---------------------------------------------------------------- 建立帳戶（上線那天的第一份快照）

async function createFromSnapshot(backend: SiteBackend, b: Record<string, unknown>): Promise<Response> {
  if (backend.mode !== 'real') throw new SiteError(400, '示範模式不用建立帳戶');
  const rows = (v: unknown) => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []).filter((r) => String(r?.ticker ?? '').trim() !== '').slice(0, 40);
  const own = rows(b.own).map((r) => ({ ticker: ticker(r.ticker), shares: num(r.shares, '股數', 0, 1e7), stdWeight: r.stdWeight === undefined || r.stdWeight === '' || r.stdWeight === null ? null : num(r.stdWeight, '標準比重', 0.001, 0.5), premises: premisesOf(r.premises) }));
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

// ---------------------------------------------------------------- 路由

async function route(req: Request, rest: string, url: URL, backend: SiteBackend): Promise<Response> {
  const get = req.method === 'GET';
  const post = req.method === 'POST';

  if (rest === 'state' && get) return json(stateView(await backend.load()));

  if (rest === 'history' && get) return json(historyView(ready(await backend.load())));

  if (rest === 'account' && post) return createFromSnapshot(backend, await body(req));

  const hold = /^holding\/([A-Za-z0-9.-]{1,10})$/.exec(rest);
  if (hold && get) return json(holdingDetail(ready(await backend.load()), ticker(hold[1])));

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
      const r = await mutate(backend, `回覆通知 #${id}`, [], (d) => {
        if (findNotif(d.acct, id).status !== 'PENDING') throw new SiteError(409, '這則通知已經回覆過了');
        return { acct: respond(d.acct, d.view, id, { mode, choices }) };
      });
      return json({ ok: true, status: findNotif(r.after.acct, id).status });
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
        const out = classify(d.acct, d.view, id, { bucket, reason: reason || undefined });
        if (out.error) throw new SiteError(422, out.error);
        let acct = out.acct;
        let monthlyId: number | null = null;
        if (out.monthlyUnblocked && d.demo) {
          // 分類完，暫停的月報要重算。真正的系統由月報流程做（T7）；示範模式在這裡補上
          const month = d.today.slice(0, 7);
          const m = monthlyReport(acct, d.view, { order: d.rankOrder, vetoed: DEMO_SCRIPTS[d.demo.scenario].vetoes?.[month], month });
          acct = m.acct;
          monthlyId = m.notif.id;
          for (const x of acct.notifs) if (x.kind === 'INFO' && x.status === 'PENDING' && x.title.startsWith('月報暫停')) x.status = 'READ';
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
    const raw = (b.shares ?? {}) as Record<string, unknown>;
    const shares: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw).slice(0, 80)) {
      const q = num(v, `${k} 的股數`, 0, 1e7);
      if (q > 0) shares[ticker(k)] = q;
    }
    // 現金可以是負的（融資帳戶，或示範裡買超過現金）；畫面上會提醒
    const snap: Snapshot = { shares, cash: num(b.cash, '現金', -1e10, 1e10) };
    const r = await mutate(backend, '填快照', Object.keys(shares), (d) => {
      const noPrice = Object.keys(shares).filter((t) => !d.view.close[t] || !Number.isFinite(d.view.close[t][d.view.i]));
      if (noPrice.length) throw new SiteError(422, `抓不到 ${noPrice.join('、')} 在 ${d.view.date} 的收盤價。請確認代號有沒有打錯。`);
      const out = applySnapshot(d.acct, d.view, snap, d.fill);
      return { acct: out.acct, snapshot: snap, result: { completed: out.completed, followUps: out.followUps, created: out.created.map((n) => ({ id: n.id, kind: n.kind, title: n.title })) } };
    });
    return json({ ok: true, ...r.result });
  }

  // ---- 你自己的操作：先試算（dry），確定了才存
  if (rest === 'ops/deposit' && post) {
    const b = await body(req);
    const amount = num(b.amount, '入金金額', 1, 1e9);
    const dry = b.dry === true;
    const r = await mutate(backend, `入金 ${amount}`, [], (d) => {
      const out = deposit(d.acct, d.view, amount);
      return { acct: out.acct, dry, result: { notifId: out.notif.id, mergedIntoMonthly: out.mergedIntoMonthly } };
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
      return { acct: out.acct, dry, result: { notifId: out.notif.id } };
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
      return { acct: out.acct, dry, result: { notifId: out.notif.id } };
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
    const drafts = r.after.demo ? (DEMO_SCRIPTS[r.after.demo.scenario].drafts?.[tk] ?? null) : null;
    return json({ ok: true, ...r.result, ...(dry ? { preview: notifView(r.after, findNotif(r.after.acct, r.result.notifId as number)), drafts } : {}) });
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
  const auth = await siteAuth(req, env, fetcher, now);
  if (!auth.ok) return json({ error: 'unauthorized', reason: auth.reason }, 401);
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
