// T39a：使用者看了 T38 的全站截圖之後要修的畫面與文字（thesis_plan 的 T39a；截圖對照表 records/stage8/screens/final/README.md）。
// 有邏輯的各一組測試：帳戶頁的排名標記、晚回覆警告的條件、乙類回覆的狀態、提醒的標題、出金的說明；
// 另外幾個順手改到的（帳本的括號、待辦的順序與史萊姆、減半線、逾時的原因與告警）也各有一個。純文字與版面用截圖驗。
import { describe, expect, it } from 'vitest';
import { closeStaleRuns, getRun, startRun } from '../src/app/aiRuns';
import { LATE_FETCH_ERROR, TASK_TIMEOUT_MS, taskLabels, timeoutAlert, timeoutReason } from '../src/app/aiTasks';
import type { Env, Fetcher } from '../src/app/env';
import type { SiteData } from '../src/app/site/backend';
import { plain, todoBubble } from '../src/app/site/bubble';
import { explainItem, type ExplainContext } from '../src/app/site/explain';
import { chartOf, decideRank, eventReason, historyView, holdingDetail, keptAsRule, lateRepriceTickers, notifView, rankingView, stateView, type ComposedView, type TodoView } from '../src/app/site/views';
import { buildPack } from '../src/ai/pack';
import { momSlotTarget, notifName, priceOf, totalValue, withdraw, type Account, type Notif } from '../src/engine';
import { handle } from '../src/index';
import { freshDb } from './helpers/d1';
import { scenarios } from './helpers/scenarios';
import { Sim } from './helpers/sim';

type Ready = SiteData & { acct: Account; view: NonNullable<SiteData['view']> };

/** 網站的 views 要的資料：示範模式的樣子（帳戶與開盤前看到的市場）。 */
function ready(sim: Sim, rankOrder: string[] = []): Ready {
  return { mode: 'demo', acct: sim.acct, view: sim.pre, axis: sim.market.days.slice(0, sim.d), rankOrder, rankSession: null, aiNotes: [], events: [], shadow: [], today: sim.date, warnings: [] };
}

/** 情境 ①：12/01 的月報（ORCL 出場、GE 進場、PLTR 回調；APP 被 AI 否決）。 */
function december(): { sim: Sim; m: Notif } {
  const sc = scenarios.s1();
  const sim = new Sim(sc.market, sc.init, { vetoes: { '2026-12': ['APP'] } });
  sim.runUntil('2026-12-01');
  const m = sim.preOpen()!;
  return { sim, m };
}

/**
 * 情境 ②：MU 12/24 的當天通知，沒有回覆，一直走到提醒出來。
 * T82（allocation_redesign §3.2）：MU 有論點，12/24 是跌幅審查的通知；審查判前提 P1 不成立 → 預設減半（要下單的才會提醒；預設不動的不提醒、自動結案）。
 */
function muReminded(): { sim: Sim; urgent: Notif; reminder: Notif } {
  const sc = scenarios.s2();
  const sim = new Sim(sc.market, sc.init, { drops: { MU: { status: 'BROKEN', premiseId: 'P1' } } });
  let urgent: Notif | undefined;
  let reminder: Notif | undefined;
  while (!urgent && sim.date < '2027-01-04') sim.day({ afterClose: (c) => (urgent = c.find((n) => n.kind === 'URGENT')) });
  expect(lateRepriceTickers(sim.acct.notifs.find((n) => n.id === urgent!.id)!)).toEqual([]); // 還沒提醒：不警告
  while (!reminder && sim.date < '2027-01-04') sim.day({ afterClose: (c) => (reminder = c.find((n) => n.kind === 'INFO' && n.ref === urgent!.id)) });
  return { sim, urgent: sim.acct.notifs.find((n) => n.id === urgent!.id)!, reminder: reminder! };
}

describe('T39a：帳戶頁的動能排名', () => {
  it('「持有」看帳上實際的動能持股；月報要買、還沒成交的標「這次買」，要賣的標「這次賣」，被 AI 否決的標「AI 否決」（和月報頁同一套標法）', () => {
    const { sim, m } = december();
    const order = m.monthly!.input.order;
    expect(sim.acct.rule.heldMom).toContain('GE'); // 規則的目標名單已經有 GE（原本因此標成「持有」）
    expect(sim.acct.lots.mom.GE ?? 0).toBe(0);
    const rows = rankingView(ready(sim, order), 50);
    const mark = (t: string) => rows.find((r) => r.ticker === t)?.mark;
    expect(mark('GE')).toBe('IN');
    expect(mark('ORCL')).toBe('OUT');
    expect(mark('APP')).toBe('VETO');
    expect(mark('PLTR')).toBe('HELD');
    for (const r of rows) if (r.mark === 'HELD' || r.mark === 'OUT') expect(sim.acct.lots.mom[r.ticker] ?? 0).toBeGreaterThan(0);
    // 回覆、成交、填快照之後：GE 是真的持有了，ORCL 賣掉了
    sim.respond(m.id);
    sim.open();
    const after = rankingView(ready(sim, order), 50);
    expect(after.find((r) => r.ticker === 'GE')?.mark).toBe('HELD');
    expect(after.find((r) => r.ticker === 'ORCL')?.mark ?? null).not.toBe('HELD');
  });
});

describe('T39a：晚回覆的警告與提醒', () => {
  it('晚回覆的警告只在提醒過、而且有自選慢規則項目時出現，只列那幾檔；月報裡沒有慢規則項目就不警告', () => {
    const { sim, urgent } = muReminded();
    expect(urgent.reminded).toBe(true);
    expect(lateRepriceTickers(urgent)).toEqual(['MU']);
    expect(notifView(ready(sim), urgent).lateReprice).toEqual(['MU']);
    // 12 月月報（動能進出場、回調；沒有自選慢規則）：提醒過也不警告
    const { sim: s1, m } = december();
    const late = { ...m, reminded: true };
    expect(lateRepriceTickers(late)).toEqual([]);
    expect(notifView(ready(s1), late).lateReprice).toEqual([]);
  });

  it('提醒的標題寫哪一檔、什麼事（不用內部的通知編號）；提醒在紀錄與通知頁是「未讀」，不是「等你決定」；通知頁連回原來那則的名字是日期與種類', () => {
    const { sim, urgent, reminder } = muReminded();
    expect(reminder.title).toBe('提醒：「MU 跌幅審查」（12/24）還沒回報');
    expect(reminder.title).not.toMatch(/#\d/);
    expect(reminder.text).not.toContain('忘了');
    const d = ready(sim);
    expect(historyView(d).notifs.find((r) => r.id === reminder.id)!.statusLabel).toBe('未讀');
    const v = notifView(d, sim.acct.notifs.find((n) => n.id === reminder.id)!);
    expect(v.statusLabel).toBe('未讀');
    expect(v.refName).toBe('12/24 的當天通知「MU 跌幅審查」');
    expect(v.refName).toBe(notifName(urgent));
  });

  it('其他指到通知的地方也用日期與種類：月報「12 月月報」、你的操作「12/10 的「入金 $10,000 的清單」」', () => {
    expect(notifName({ kind: 'MONTHLY', date: '2026-12-01', title: '2026-12 月報' })).toBe('12 月月報');
    expect(notifName({ kind: 'CASHFLOW', date: '2026-12-10', title: '入金 $10,000 的清單' })).toBe('12/10 的「入金 $10,000 的清單」');
    expect(notifName({ kind: 'URGENT', date: '2027-01-06', title: 'NVDA：AI 審查認為你的前提不成立' })).toBe('1/6 的當天通知「NVDA：AI 審查認為你的前提不成立」');
  });
});

describe('T39a：乙類回「不同意，不動」', () => {
  const item = (ruleChoice: 'SKIP' | 'DO', brk: boolean) => ({
    key: 'i1',
    f: brk ? 'F24' : 'F7',
    kind: brk ? 'AI_ONLY' : 'OWN_RULE',
    ticker: 'NVDA',
    title: 'NVDA',
    choices: [
      { id: brk ? 'AI' : 'DO', label: brk ? '照 AI：減半' : '照做', lines: [{ ticker: 'NVDA', bucket: 'own', shares: -13, reason: '' }] },
      { id: 'SKIP', label: brk ? '不同意，不動' : '這次不做', lines: [] },
    ],
    choice: 'SKIP',
    ruleChoice,
    ...(brk ? { brk: { type: 'B', premiseId: 'P2' } } : {}),
  });
  const notif = (id: number, it: ReturnType<typeof item>): Notif => ({ id, kind: 'URGENT', date: '2027-01-06', seq: 0, title: 'NVDA：AI 審查認為你的前提不成立', status: 'SKIPPED', coreAbsorb: true, reminded: false, items: [it] }) as unknown as Notif;

  it('每一項本來就是不動（規則的選項就是不做）→ 狀態寫「不同意 AI，不動」，不是「這次不做」；真的沒照規則做的仍是「這次不做」', () => {
    const b = notif(901, item('SKIP', true));
    const skipped = notif(902, item('DO', false));
    expect(keptAsRule(b)).toBe('不同意 AI，不動');
    expect(keptAsRule(skipped)).toBeNull();
    const { sim } = december();
    sim.acct = { ...sim.acct, notifs: [...sim.acct.notifs, b, skipped] };
    const d = ready(sim);
    const rows = historyView(d).notifs;
    expect(rows.find((r) => r.id === 901)).toMatchObject({ statusLabel: '不同意 AI，不動', summary: '你不同意 AI 的建議，部位不動（規則本來就沒有動作）' });
    expect(rows.find((r) => r.id === 902)).toMatchObject({ statusLabel: '這次不做', summary: '整則沒做' });
    expect(notifView(d, b)).toMatchObject({ statusLabel: '不同意 AI，不動', kept: '不同意 AI，不動' });
    expect(notifView(d, skipped).kept).toBeNull();
  });
});

describe('T39a：出金的說明', () => {
  // T80（allocation_redesign §1.4）：順序改成 動能高於目標 → 核心（照比例，帳上現金先用）→ 動能其餘 → 自選
  it('說明的順序和引擎一樣：動能高於每檔目標的部分（賣回目標）→ 核心（照比例，帳上現金先用）→ 動能其餘 → 最後才是自選；清單裡動能只賣回目標、其餘從核心拿', () => {
    const sc = scenarios.s1();
    const sim = new Sim(sc.market, sc.init);
    sim.runUntil('2026-12-01');
    const view = sim.pre;
    const amt = 30000;
    const total = totalValue(sim.acct, view);
    const w = withdraw(sim.acct, view, amt);
    const lines = w.notif.items[0].choices[0].lines;
    const mom = lines.filter((l) => l.bucket === 'mom');
    expect(mom.length).toBeGreaterThan(0);
    expect(w.notif.preview!.lines.some((l) => l.bucket === 'core' && l.ticker === 'VOO' && l.shares < 0)).toBe(true);
    expect(w.notif.preview!.lines.some((l) => l.bucket === 'core' && l.ticker === 'SGOV' && l.shares < 0)).toBe(true);
    // 動能只賣到每檔目標（核心還有 VOO 可以賣，所以沒動到目標以下）
    const slot = momSlotTarget(sim.acct.cfg, total - amt, sim.acct.rule.effPrev ?? 1);
    for (const l of mom) expect(((sim.acct.lots.mom[l.ticker] ?? 0) + l.shares) * priceOf(view, l.ticker)).toBeGreaterThanOrEqual(slot - priceOf(view, l.ticker));
    expect(lines.some((l) => l.bucket === 'own' && l.shares < 0 && !/上限/.test(String(l.reason)))).toBe(false);
    const ctx: ExplainContext = { acct: w.acct, view, axis: [], rankOrder: [], aiNotes: [] };
    const why = explainItem(ctx, w.notif, w.notif.items[0]).why;
    expect(why).toContain('其餘依序從：動能高於每檔目標的部分（賣回目標）→ 核心（照比例賣 VOO 與 SGOV，帳上現金先用）→ 動能其餘的部分 → 最後才是自選');
    expect(why).not.toContain('照順序從核心、動能');
    expect(w.notif.title).toBe('出金 $30,000 的清單');
  });
});

describe('T39a：其他順手改到的', () => {
  it('帳本那一行：括號不套括號，核心那一行寫白話、不寫「核心 ETF」', () => {
    const { sim } = december();
    expect(eventReason('錢交給核心（買核心 ETF）', sim.acct)).toBe('剩下的現金交給核心：買 VOO');
    expect(eventReason('從核心拿錢（先用短債）', sim.acct)).toBe('不夠的錢從核心拿：先用短債');
    expect(eventReason('要用錢（賣光並移出自選）', sim.acct)).toBe('要用錢：賣光並移出自選');
  });

  it('待辦的順序：預設要下單的當天通知先、月報次之、預設不動的 AI 建議最後；史萊姆講排第一的那一則，核心補差額的單另外講', () => {
    const it = (f: string, lines: number, ruleChoice = 'DO') => ({ f, cancelled: false, ruleChoice, choices: [{ id: 'DO', lines: Array.from({ length: lines }, () => ({ ticker: 'X', bucket: 'own', shares: -1 })) }, { id: 'SKIP', lines: [] }] });
    const n = (kind: string, items: unknown[]) => ({ kind, items }) as unknown as Notif;
    expect(decideRank(n('URGENT', [it('F7', 1)]))).toBe(0);
    expect(decideRank(n('MONTHLY', [it('F2', 1)]))).toBe(1);
    expect(decideRank(n('URGENT', [it('F24', 1, 'SKIP')]))).toBe(3);
    expect(decideRank(n('MONTHLY', [it('CORE', 1)]))).toBe(3);
    const part = (ticker: string, bucket: string, shares: number, balance = false) => ({ ticker, bucket, bucketName: bucket, shares, amount: shares * 100, reason: '', balance });
    const o = (ticker: string, shares: number, bucket = 'mom', balance = false) => ({ ticker, shares, transfer: false, price: 100, amount: shares * 100, parts: [part(ticker, bucket, shares, balance)] });
    const composed: ComposedView = { orders: [o('ORCL', -28), o('GE', 20), o('VOO', 6, 'core', true)], cashBefore: 1500, cashAfter: 782, withdraw: 0, shortOfCash: false };
    const todo = (id: number, title: string): TodoView => ({ id, type: 'DECIDE', kindLabel: '月報', title, date: '2026-12-01', lines: [], note: null });
    const text = plain(todoBubble([todo(1, '2026-12 月報'), todo(2, 'NVDA：AI 審查認為你的前提不成立')], { composed, items: [] }));
    expect(text).toBe('先看「2026-12 月報」：賣 ORCL 28 股，買 GE 20 股；剩下的現金交給核心：買 VOO 6 股，共 3 張單，做完現金約 $782。另外還有 1 件。');
    // 清單本身不用下單、只有帳上原本的現金交給核心（乙類預設不動）
    const cashOnly: ComposedView = { orders: [o('VOO', 1, 'core', true)], cashBefore: 900, cashAfter: 400, withdraw: 0, shortOfCash: false };
    expect(plain(todoBubble([todo(2, 'NVDA：AI 審查認為你的前提不成立')], { composed: cashOnly, items: [] }))).toBe('這則本身不用下單；帳上原本的現金交給核心：買 VOO 1 股，共 1 張單，做完現金約 $400。');
  });

  it('首頁：情境 ② 的待辦裡，預設要下單的 MU 減半排在前面、史萊姆講它', () => {
    const { sim, urgent } = muReminded();
    const st = stateView(ready(sim));
    const decide = st.todo.filter((t) => t.type === 'DECIDE');
    expect(decide[0].id).toBe(urgent.id);
    expect(plain(st.bubble.todo)).toContain('MU');
  });

  it('走勢圖：減半線只畫在自選股上（動能、核心沒有這條規則）；持股頁列出還沒成交的清單上這一檔的單', () => {
    const { sim, m } = december();
    const d = ready(sim, m.monthly!.input.order);
    expect(chartOf(d, 'MU')!.halfLine.some((v) => v !== null)).toBe(true);
    expect(chartOf(d, 'PLTR')!.halfLine.every((v) => v === null)).toBe(true);
    expect(chartOf(d, 'VOO')!.halfLine.every((v) => v === null)).toBe(true);
    const pltr = holdingDetail(d, 'PLTR');
    expect(pltr.open).toEqual([{ notif: m.id, name: '12 月月報', text: expect.stringMatching(/^賣 PLTR \d+ 股（動能比例調回）$/), decided: false }]);
  });

  it('乙類預設不動、右邊只剩帳上現金交給核心時，那一行寫清楚不是這則通知要你下的單', () => {
    const { sim, m } = december();
    // 月報整則選不做：剩下的只有帳上現金交給核心
    const items = m.items.map((i) => ({ ...i, choice: 'SKIP' as const }));
    const v = notifView(ready(sim), { ...m, items });
    const voo = v.composed!.orders.find((o) => o.ticker === 'VOO');
    if (voo) {
      expect(voo.parts.every((p) => p.balance)).toBe(true);
      expect(voo.parts[0].reason).toContain('這則通知本身不用下單');
    } else expect(v.composed!.orders).toEqual([]);
  });
});

// ---------------------------------------------------------------- 逾時（T36、T32b 留下的小缺口）

const T0 = new Date('2026-11-30T23:40:00Z');
const fireOk: Fetcher = async () => Response.json({ claude_code_session_url: 'https://claude.ai/code/session_x' });
const pack = (runId: string) =>
  buildPack({
    runId,
    fn: 'OWN_REVIEW',
    promptVersion: 'own_review_v1',
    asOf: '2026-11-30',
    subject: { ticker: 'ZZZ' },
    question: '前提哪些成立？',
    policy: { level: 'A3', verdicts: ['EXIT', 'HALF', 'HOLD', 'STANDARD'], abstain: 'HOLD', min_evidence: 1, samples: 3 },
    rule: { action: '規則沒有動作' },
    premises: [{ id: 'P1', text: '毛利率維持在 60% 以上', origin: 'USER' }],
    documents: [{ id: 'D1', source_id: 'edgar:0000000000-26-000001', kind: 'filing', date: '2026-10-02', title: '假的 10-Q', text: 'Gross margin was 61.2% in the third quarter.' }],
    now: T0,
  }).pack;

describe('T39a：逾時的原因與告警', () => {
  it('超過時限才來取證據包：原因寫「太晚才來取」，不是「沒有來取」；告警列功能與代號，不列任務編號', async () => {
    const d = await freshDb();
    try {
      const env = { DB: d.db, ADMIN_TOKEN: 'a', AI_TASK_SECRET: 's', ROUTINE_FIRE_URL: 'https://api.example/fire', ROUTINE_TOKEN: 'rt' } as Env;
      const run = await startRun(env, fireOk, pack('2026-11-30_OWN_REVIEW_ZZZ_late99'), T0);
      const late = new Date(T0.getTime() + TASK_TIMEOUT_MS + 5 * 60_000);
      const res = await handle(new Request(`https://bot.example/ai/task/${run.taskId}/evidence`, { headers: { Authorization: 'Bearer s' } }), env, fireOk, late);
      expect(res.status).toBe(410);
      expect(await d.db.prepare('SELECT status, error FROM ai_tasks WHERE id = ?').bind(run.taskId).first()).toMatchObject({ status: 'TIMEOUT', error: LATE_FETCH_ERROR });
      await closeStaleRuns(d.db, late);
      const reason = (await getRun(d.db, run.runId))!.outcome!.reason;
      expect(reason).toContain(timeoutReason(false, true));
      expect(reason).not.toContain('沒有來取證據包');
      // 告警：功能與代號
      const labels = await taskLabels(d.db, [run.taskId!, 'f'.repeat(32)]);
      expect(labels).toEqual({ [run.taskId!]: '自選定期審查 ZZZ' });
      expect(timeoutAlert([{ id: run.taskId!, fetched: false }], labels)).toBe('1 個 AI 任務逾時，已照規則處理：雲端排程沒有來取證據包（多半是額度用完或 session 沒開成）：1 個（自選定期審查 ZZZ）。');
    } finally {
      await d.dispose();
    }
  });
});
