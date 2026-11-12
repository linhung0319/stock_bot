// T8：網站的 API。完成條件是「用網站走完情境 ① 與 ⑤，結果和 T3 的測試一致」：
// 這裡每一步都走兩條路——一條直接呼叫引擎（和 test/scenarios.test.ts 相同的 Sim），
// 一條只透過網站的 API——然後比對兩邊的帳戶狀態（各桶股數、現金、規則狀態、通知、事件、沒照做的紀錄）。
// D1 用本機模擬器；對外請求全部用假的 fetcher。
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env, Fetcher } from '../src/app/env';
import { loadAccount } from '../src/app/ledgerStore';
import { resetAccessCache } from '../src/app/site/access';
import type { ItemView, NotifView, SnapshotForm, StateView } from '../src/app/site/views';
import type { HistoryView, HoldingDetail } from '../src/app/site/views';
import { saveRanking, saveSeries, type Series } from '../src/data/store';
import { addOwn, changeRatio, classify, deposit, itemAction, liveShadow, recordAiTier, withdraw, type Account, type Notif } from '../src/engine';
import { handle } from '../src/index';
import { freshDb } from './helpers/d1';
import { ranksAt, type Market } from './helpers/market';
import { scenarios } from './helpers/scenarios';
import { Sim } from './helpers/sim';

let db: D1Database;
let dispose: () => Promise<void>;
let env: Env;
beforeAll(async () => {
  const d = await freshDb();
  db = d.db;
  dispose = d.dispose;
  env = { DB: db, DEV_NO_AUTH: '1' };
});
afterAll(() => dispose());

const noNet: Fetcher = async (url) => {
  throw new Error('測試不應該連網：' + url);
};
const NOW = new Date('2026-12-09T23:30:00Z');

/** 只透過網站 API 操作。 */
class Web {
  constructor(
    public base: '/api' | '/demo/api',
    /** 沒給就用共用的 env（describe 執行時 env 還沒準備好，所以到用的時候才取）。 */
    public e?: Env,
    public fetcher: Fetcher = noNet,
    public now: Date = NOW,
  ) {}
  async raw(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
    return handle(new Request('https://bot.example' + this.base + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }), this.e ?? env, this.fetcher, this.now);
  }
  async get<T>(path: string): Promise<T> {
    const r = await this.raw('GET', path);
    if (r.status !== 200) throw new Error(`GET ${path} → ${r.status} ${await r.text()}`);
    return (await r.json()) as T;
  }
  async post<T = Record<string, unknown>>(path: string, body: unknown = {}): Promise<T> {
    const r = await this.raw('POST', path, body);
    if (r.status !== 200) throw new Error(`POST ${path} → ${r.status} ${await r.text()}`);
    return (await r.json()) as T;
  }
  async fail(path: string, body: unknown = {}): Promise<{ status: number; error: string }> {
    const r = await this.raw('POST', path, body);
    return { status: r.status, error: ((await r.json()) as { error: string }).error };
  }
  state() {
    return this.get<StateView>('/state');
  }
  notif(id: number) {
    return this.get<NotifView>(`/notif/${id}`);
  }
  /** 「照清單下單、以開盤價成交」之後填快照；extra 是和清單不同的地方。 */
  async fill(extra: Record<string, number> = {}) {
    const snap = await demoSnapshot(extra);
    return this.post<{ completed: number[]; followUps: number[]; created: { id: number; kind: string; title: string }[] }>('/snapshot', snap);
  }
}

async function demoAcct(): Promise<{ acct: Account; d: number; scenario: string }> {
  const row = await db.prepare('SELECT scenario, d, body FROM demo_state WHERE id = 1').first<{ scenario: string; d: number; body: string }>();
  return { acct: JSON.parse(row!.body) as Account, d: row!.d, scenario: row!.scenario };
}

/** 和 Sim.snapshotAfter 相同的算法，但資料來自網站存的示範狀態（不四捨五入，才能和引擎逐位比對）。 */
async function demoSnapshot(extra: Record<string, number>) {
  const { demoFilledSnapshot } = await import('../src/demo/driver');
  const s = await demoAcct();
  return demoFilledSnapshot({ scenario: s.scenario as 's1', d: s.d, acct: s.acct }, extra, true);
}

/** 比對用：拿掉每次執行都不同的項目編號，以及網站加上的理由。 */
function normalize(acct: Account): unknown {
  const c = JSON.parse(JSON.stringify(acct)) as Account;
  for (const n of c.notifs) {
    for (const it of n.items as (Notif['items'][number] & { x?: unknown })[]) {
      it.key = '';
      delete it.x;
    }
  }
  return c;
}
async function expectSame(sim: Sim) {
  expect(normalize((await demoAcct()).acct)).toEqual(normalize(sim.acct));
}

const itemOf = (v: NotifView, label: string, ticker?: string): ItemView => {
  const it = v.items.find((i) => i.label === label && (!ticker || i.ticker === ticker));
  if (!it) throw new Error(`通知 #${v.id} 沒有 ${label} ${ticker ?? ''}：${v.items.map((i) => i.label + ':' + i.ticker).join(' ')}`);
  return it;
};
const orderOf = (v: NotifView | { composed: NotifView['composed'] }, ticker: string) => v.composed!.orders.find((o) => o.ticker === ticker);

// ================================================================ 情境 ①

describe('情境 ① 平常的月報：用網站走完', () => {
  const web = new Web('/demo/api');
  /** 和 test/scenarios.test.ts 情境 ① 的 start() 相同。 */
  const simStart = () => {
    const sc = scenarios.s1();
    const sim = new Sim(sc.market, sc.init, { vetoes: { '2026-12': ['APP'] } });
    sim.runUntil('2026-12-01');
    sim.acct = recordAiTier(sim.acct, 'MSFT', 'RAISE', '2026-11-30', true);
    const n = sim.preOpen()!;
    return { sim, n };
  };
  beforeEach(async () => {
    await web.post('/reset', { scenario: 's1' });
  });

  it('打開網站：待辦是 12 月月報，每一行都寫著做什麼和因為什麼', async () => {
    const { sim, n } = simStart();
    await expectSame(sim);
    const st = await web.state();
    expect(st.mode).toBe('demo');
    expect(st.today).toBe('2026-12-01');
    expect(st.priceDate).toBe('2026-11-30');
    expect(st.todo).toHaveLength(1);
    const todo = st.todo[0];
    expect(todo).toMatchObject({ id: n.id, type: 'DECIDE', title: '2026-12 月報' });
    expect(todo.lines.map((l) => l.text)).toEqual(expect.arrayContaining(['賣 ORCL 28 股（全部）']));
    // 理由就在同一行，不用點進去
    for (const l of todo.lines) expect(l.why.length).toBeGreaterThan(5);
    expect(todo.lines.find((l) => l.text.startsWith('賣 ORCL'))!.why).toMatch(/排名掉到第 \d+，門檻是前 15/);
  });

  it('月報頁：項目、股數、預設選項和引擎相同；每一項都有理由、門檻尺與股數算法', async () => {
    const { n } = simStart();
    const v = await web.notif(n.id);
    expect(v).toMatchObject({ kind: 'MONTHLY', status: 'PENDING', step: 1 });
    // 和引擎直接產生的月報逐項相同（畫面上的順序照因果排：先出場、再進場，所以比對前先照代號排）
    const sig = (items: { ticker?: string | null; choice: string; choices: { id: string; lines: { bucket: string; ticker: string; shares: number }[] }[] }[]) =>
      items.map((i) => JSON.stringify([i.ticker ?? null, i.choice, i.choices.map((c) => [c.id, c.lines.map((l) => `${l.bucket}:${l.ticker}:${l.shares}`)])])).sort();
    expect(sig(v.items)).toEqual(sig(n.items));
    expect(v.items.map((i) => i.label)).toEqual(['動能出場', '動能進場', '動能比例調回', 'AI 建議提高比重']);
    expect(v.text).toBe('崩盤規則：未啟動。動能部位全額');
    const orcl = itemOf(v, '動能出場', 'ORCL');
    expect(orcl.headline).toBe('賣 ORCL 28 股（全部）');
    expect(orcl.bucket).toBe('mom');
    expect(orcl.explain.why).toMatch(/排名掉到第 \d+/);
    expect(orcl.explain.gauge!.marks[0]).toMatchObject({ at: 15 });
    expect(orcl.explain.gauge!.value).toBeGreaterThan(15);
    expect(orcl.explain.ranking!.find((r) => r.ticker === 'ORCL')!.mark).toBe('OUT');
    expect(orcl.actions.map((a) => a.id)).toEqual(['TRANSFER']);
    expect(orcl.choices.find((c) => c.id === 'SKIP')!.note).toContain('下個月月報會把差額再列一次');

    const ge = itemOf(v, '動能進場', 'GE');
    expect(ge.explain.why).toContain('APP 這個月被 AI 否決');
    expect(ge.explain.ai).toMatchObject({ kind: 'VETO', ticker: 'APP', fake: true });
    expect(ge.explain.ranking!.find((r) => r.ticker === 'APP')!.mark).toBe('VETO');
    expect(ge.explain.ranking!.find((r) => r.ticker === 'GE')!.mark).toBe('IN');
    expect(ge.explain.math!.join(' ')).toContain('÷ 5 檔');
    expect(ge.actions.map((a) => a.id)).toEqual(['EXCLUDE', 'ADOPT']);

    const pltr = itemOf(v, '動能比例調回', 'PLTR');
    expect(pltr.explain.gauge!.value).toBeGreaterThan(1.5);

    const msft = itemOf(v, 'AI 建議提高比重', 'MSFT');
    expect(msft.kind).toBe('AI_ONLY');
    expect(msft.choice).toBe('SKIP'); // 規則沒有動作：沒選就是不做
    expect(msft.explain.why).toContain('規則沒有動作');
    expect(msft.explain.ai!.premises!.every((p) => p.status === 'HOLDS')).toBe(true);
    expect(msft.choices.find((c) => c.id === 'AI')!.label).toBe('照 AI：提高到標準的 125%');

    // 合起來要下的單：和引擎的預覽相同；VOO 那一行寫明是核心吸收差額
    expect(v.composed!.orders.map((o) => `${o.ticker}:${o.shares}`).sort()).toEqual(n.preview!.merged.map((m) => `${m.ticker}:${m.shares}`).sort());
    expect(orderOf(v, 'MSFT')).toBeUndefined();
    expect(orderOf(v, 'VOO')!.parts[0].reason).toContain('交給核心');
    expect(v.composed!.cashAfter).toBeCloseTo(n.preview!.cashAfter, 6);
  });

  it('把 MSFT 改成「照 AI」：畫面上的試算跟著變（不存檔）；送出、填快照後和引擎相同', async () => {
    const { sim, n } = simStart();
    const v = await web.notif(n.id);
    const msft = itemOf(v, 'AI 建議提高比重', 'MSFT');
    const pv = await web.post<NotifView['composed'] & object>(`/notif/${n.id}/preview`, { choices: { [msft.key]: 'AI' } });
    expect(pv.orders.find((o) => o.ticker === 'MSFT')!.shares).toBeGreaterThan(0);
    expect(pv.orders.find((o) => o.ticker === 'VOO')!.shares).toBeLessThan(orderOf(v, 'VOO')!.shares);
    await expectSame(sim); // 試算沒有改帳戶

    const simKey = n.items.find((i) => i.f === 'F23')!.key;
    sim.respond(n.id, { mode: 'DO', choices: { [simKey]: 'AI' } });
    expect(await web.post(`/notif/${n.id}/respond`, { mode: 'DO', choices: { [msft.key]: 'AI' } })).toMatchObject({ status: 'RESPONDED' });
    await expectSame(sim);

    // 第二步：下單清單；待辦變成「等你下單、填快照」
    const st = await web.state();
    expect(st.todo[0]).toMatchObject({ id: n.id, type: 'TRADE' });
    expect((await web.notif(n.id)).step).toBe(2);

    // 第三步：填快照
    const form = await web.get<SnapshotForm>('/snapshot/form');
    expect(form.lists).toEqual([{ id: n.id, title: '2026-12 月報' }]);
    expect(form.rows.find((r) => r.ticker === 'ORCL')).toMatchObject({ book: 28, expected: 0, listed: -28 });
    const simR = sim.open()!;
    const webR = await web.fill();
    expect(webR).toMatchObject({ completed: simR.completed, followUps: simR.followUps, created: [] });
    await expectSame(sim);
    const { acct } = await demoAcct();
    expect(acct.rule.own.MSFT.stdWeight).toBeCloseTo(0.0625, 12);
    expect(acct.lots.own.MSFT).toBeGreaterThan(9);
    expect((await web.state()).todo).toEqual([]);
    const done = await web.notif(n.id);
    expect(done).toMatchObject({ status: 'DONE', step: 0 });
    expect(done.filled.find((f) => f.ticker === 'ORCL')).toMatchObject({ shares: -28, bucketName: '動能' });
  });

  it('照清單做完：帳本照清單分到各桶；1 月月報沒有規則單', async () => {
    const { sim, n } = simStart();
    sim.respond(n.id);
    await web.post(`/notif/${n.id}/respond`, { mode: 'DO' });
    sim.open();
    await web.fill();
    await expectSame(sim);
    sim.close();
    sim.d++;
    sim.runUntil('2027-01-04');
    const jan = sim.preOpen()!;
    const adv = await web.post<{ days: number; created: number[] }>('/advance', { mode: 'month' });
    expect(adv.created).toEqual([jan.id]);
    await expectSame(sim);
    const v = await web.notif(jan.id);
    expect(v.items.filter((i) => i.label !== '閒置現金')).toEqual([]);
  });

  it('GE 按「排除」：寫理由後清單重算，由下一名遞補；沒寫理由不能排除', async () => {
    const { sim, n } = simStart();
    const v = await web.notif(n.id);
    const ge = itemOf(v, '動能進場', 'GE');
    expect(await web.fail(`/notif/${n.id}/action`, { key: ge.key, action: 'EXCLUDE', reason: '  ' })).toMatchObject({ status: 422 });
    const r = itemAction(sim.acct, sim.pre, n.id, n.items.find((i) => i.f === 'F1' && i.ticker === 'GE')!.key, { action: 'EXCLUDE', reason: '不想碰航太' });
    sim.acct = r.acct;
    const w = await web.post<{ notifId: number }>(`/notif/${n.id}/action`, { key: ge.key, action: 'EXCLUDE', reason: '不想碰航太' });
    expect(w.notifId).toBe(r.notif!.id);
    await expectSame(sim);
    expect((await web.notif(n.id)).status).toBe('SUPERSEDED');
    const v2 = await web.notif(w.notifId);
    const gs = itemOf(v2, '動能進場', 'GS');
    expect(gs.explain.why).toContain('你排除了排在前面的 GE');
    expect((await web.state()).account!.excluded).toEqual([{ ticker: 'GE', reason: '不想碰航太', date: '2026-11-30' }]);
    sim.respond(r.notif!.id);
    sim.open();
    await web.post(`/notif/${w.notifId}/respond`, { mode: 'DO' });
    await web.fill();
    await expectSame(sim);
    // 排除清單在網站上可以取消
    await web.post('/ops/unexclude', { ticker: 'GE' });
    expect((await demoAcct()).acct.mom.excluded).toEqual({});
  });

  it('ORCL 按「我想留著」：不用下單，改歸自選，理由成為前提', async () => {
    const { sim, n } = simStart();
    const v = await web.notif(n.id);
    const r = itemAction(sim.acct, sim.pre, n.id, n.items.find((i) => i.f === 'F2')!.key, { action: 'TRANSFER', reason: '雲端訂單還在成長' });
    sim.acct = r.acct;
    await web.post(`/notif/${n.id}/action`, { key: itemOf(v, '動能出場', 'ORCL').key, action: 'TRANSFER', reason: '雲端訂單還在成長' });
    await expectSame(sim);
    const v2 = await web.notif(n.id);
    expect(itemOf(v2, '動能出場', 'ORCL')).toMatchObject({ cancelled: true, note: '已轉入自選（不用下單）' });
    expect(orderOf(v2, 'ORCL')).toBeUndefined();
    const h = (await web.state()).account!.holdings.find((x) => x.ticker === 'ORCL')!;
    expect(h).toMatchObject({ bucket: 'own', shares: 28 });
    const detail = await web.get<HoldingDetail>('/holding/ORCL');
    expect(detail.own!.premises[0]).toEqual({ text: '雲端訂單還在成長', origin: '你寫的' });
  });

  it('策略類「這次不做」：下一份月報把差額再列一次，理由寫明是上次沒做', async () => {
    const { sim, n } = simStart();
    const v = await web.notif(n.id);
    const key = (f: string) => n.items.find((i) => i.f === f)!.key;
    sim.respond(n.id, { mode: 'DO', choices: { [key('F2')]: 'SKIP', [key('F1')]: 'SKIP' } });
    await web.post(`/notif/${n.id}/respond`, { mode: 'DO', choices: { [itemOf(v, '動能出場', 'ORCL').key]: 'SKIP', [itemOf(v, '動能進場', 'GE').key]: 'SKIP' } });
    sim.open();
    await web.fill();
    await expectSame(sim);
    sim.close();
    sim.d++;
    sim.runUntil('2027-01-04');
    const jan = sim.preOpen()!;
    await web.post('/advance', { mode: 'month' });
    await expectSame(sim);
    const jv = await web.notif(jan.id);
    expect(itemOf(jv, '動能出場', 'ORCL').explain.why).toContain('上次的出場單沒有做');
    expect(itemOf(jv, '補做', 'GE').explain.why).toContain('上次的單沒有做完');
    // 紀錄：12 月那一則寫著做了幾項
    const hist = await web.get<HistoryView>('/history');
    expect(hist.notifs.find((x) => x.id === n.id)!.summary).toMatch(/^\d 項裡做了 \d 項/);
  });

  it('上一步：下單前可以回去改決定；先前的回覆作廢，改完的結果和一開始就這樣選相同；填過快照就不能改', async () => {
    const { sim, n } = simStart();
    const v = await web.notif(n.id);
    const orcl = itemOf(v, '動能出場', 'ORCL');
    const msft = itemOf(v, 'AI 建議提高比重', 'MSFT');
    expect((await web.fail(`/notif/${n.id}/reopen`)).status).toBe(409); // 還沒決定，沒有上一步
    // 第一次：ORCL 這次不做（留下欠單）、MSFT 照 AI（留下沒照規則的紀錄）
    await web.post(`/notif/${n.id}/respond`, { mode: 'DO', choices: { [orcl.key]: 'SKIP', [msft.key]: 'AI' } });
    let acct = (await demoAcct()).acct;
    expect(acct.mom.owe.ORCL).toMatchObject({ notif: n.id });
    expect(acct.shadow.filter((x) => x.notif === n.id).length).toBeGreaterThan(0);
    expect((await web.notif(n.id)).step).toBe(2);

    // 上一步
    await web.post(`/notif/${n.id}/reopen`);
    const back = await web.notif(n.id);
    expect(back).toMatchObject({ status: 'PENDING', step: 1, statusLabel: '等你決定' });
    // 上次選的還在，不用從頭選
    expect(itemOf(back, '動能出場', 'ORCL').choice).toBe('SKIP');
    expect(itemOf(back, 'AI 建議提高比重', 'MSFT').choice).toBe('AI');
    expect((await web.state()).todo[0]).toMatchObject({ id: n.id, type: 'DECIDE' });
    acct = (await demoAcct()).acct;
    expect(acct.mom.owe).toEqual({});
    expect(liveShadow(acct.shadow)).toEqual([]);
    expect((await web.get<HistoryView>('/history')).shadow).toEqual([]);
    expect((await web.get<SnapshotForm>('/snapshot/form')).lists).toEqual([]);

    // 改成全部照規則 → 和一開始就照規則的結果相同
    const key = (f: string) => n.items.find((i) => i.f === f)!.key;
    sim.respond(n.id, { mode: 'DO', choices: { [key('F2')]: n.items.find((i) => i.f === 'F2')!.ruleChoice, [key('F23')]: 'SKIP' } });
    await web.post(`/notif/${n.id}/respond`, { mode: 'DO', choices: { [orcl.key]: orcl.ruleChoice, [msft.key]: 'SKIP' } });
    sim.open();
    await web.fill();
    acct = (await demoAcct()).acct;
    const strip = (xs: Account['shadow']) => xs.map(({ notif: _n, ...x }) => x);
    expect(strip(liveShadow(acct.shadow))).toEqual(strip(sim.acct.shadow));
    expect(normalize({ ...acct, shadow: [] })).toEqual(normalize({ ...sim.acct, shadow: [] }));
    // 帳本已經照快照更新：不能再回上一步
    expect(await web.fail(`/notif/${n.id}/reopen`)).toMatchObject({ status: 409 });
  });

  it('整則「這次不做」；快照少做 → 問補做還是就這樣', async () => {
    const { sim, n } = simStart();
    sim.respond(n.id);
    await web.post(`/notif/${n.id}/respond`, { mode: 'DO' });
    const ge = n.preview!.merged.find((m) => m.ticker === 'GE')!.shares;
    const simR = sim.open({ GE: ge - 5 })!;
    const webR = await web.fill({ GE: ge - 5 });
    expect(webR.followUps).toEqual(simR.followUps);
    await expectSame(sim);
    const st = await web.state();
    expect(st.todo[0]).toMatchObject({ id: n.id, type: 'ANSWER' });
    expect(st.todo[0].lines[0].text).toBe(`GE：清單買 ${ge} 股，實際買 ${ge - 5} 股`);
    const w = await web.post<{ notifId: number }>(`/notif/${n.id}/followup`, { fix: true });
    const fix = await web.notif(w.notifId);
    expect(fix.kind).toBe('FIX');
    expect(fix.items[0].headline).toBe('買 GE 5 股');
    expect(fix.items[0].explain.why).toContain('差了 5 股');
    // 另一則直接整則不做
    expect(await web.post(`/notif/${w.notifId}/respond`, { mode: 'SKIP' })).toMatchObject({ status: 'SKIPPED' });
  });
});

// ================================================================ 情境 ⑤

describe('情境 ⑤ 你自己的操作：用網站走完', () => {
  const web = new Web('/demo/api');
  const simStart = () => {
    const sc = scenarios.s5();
    const sim = new Sim(sc.market, sc.init);
    sim.runUntil('2026-12-10');
    return sim;
  };
  beforeEach(async () => {
    await web.post('/reset', { scenario: 's5' });
  });

  it('一開始沒有待辦；帳戶頁列出三桶、每一檔在哪一桶、規則狀態', async () => {
    const sim = simStart();
    await expectSame(sim);
    const st = await web.state();
    expect(st.todo).toEqual([]);
    const a = st.account!;
    expect(a.total).toBeCloseTo(sim.total(), 6);
    expect(a.buckets.map((b) => [b.id, b.budget])).toEqual([
      ['own', 0.2],
      ['mom', 0.3],
      ['core', 0.5],
    ]);
    expect(a.buckets.reduce((s, b) => s + b.pct, 0)).toBeCloseTo(1, 9);
    const mu = a.holdings.find((h) => h.ticker === 'MU')!;
    expect(mu).toMatchObject({ bucket: 'own', shares: 56, state: '正常', target: '標準比重 8.0%' });
    expect(mu.detail).toMatch(/比 52 週高點低 [\d.]+%；低 20% 會減半/);
    expect(mu.pct).toBeGreaterThan(0.12);
    const pltr = a.holdings.find((h) => h.ticker === 'PLTR')!;
    expect(pltr).toMatchObject({ bucket: 'mom', shares: 33, state: '排名第 1' });
    expect(a.holdings.find((h) => h.ticker === 'VOO')).toMatchObject({ bucket: 'core', shares: 64 });
    expect(a.status.map((s) => s.value)).toEqual(['未啟動', '全額']);
    expect(a.ranking[0]).toMatchObject({ rank: 1, ticker: 'PLTR', mark: 'HELD' });
  });

  it('入金 10,000：先試算（不存檔），確定後才建立清單；做完和引擎相同', async () => {
    const sim = simStart();
    const dry = await web.post<{ preview: NotifView }>('/ops/deposit', { amount: 10000, dry: true });
    await expectSame(sim); // 試算不改帳戶
    expect(dry.preview.items[0].explain.why).toContain('入金只買不賣');
    expect(dry.preview.composed!.orders.every((o) => o.shares > 0)).toBe(true);
    expect(dry.preview.composed!.orders.some((o) => o.ticker === 'MU')).toBe(false); // MU 已經高於目標

    const r = deposit(sim.acct, sim.pre, 10000);
    sim.acct = r.acct;
    const w = await web.post<{ notifId: number }>('/ops/deposit', { amount: '10,000' });
    expect(w.notifId).toBe(r.notif.id);
    await expectSame(sim);
    const v = await web.notif(w.notifId);
    expect(v.composed!.orders.map((o) => `${o.ticker}:${o.shares}`).sort()).toEqual(r.notif.preview!.merged.map((m) => `${m.ticker}:${m.shares}`).sort());
    // 入金的項目沒有「這次不做」
    expect(v.items[0].choices.map((c) => c.id)).toEqual(['DO']);
    // 每一行都說明現在占多少、目標多少
    expect(v.items[0].explain.facts!.length).toBe(v.items[0].choices[0].lines.length);
    expect(v.items[0].explain.facts![0].note).toMatch(/目前 [\d.]+%，目標 [\d.]+%/);
    sim.respond(r.notif.id);
    await web.post(`/notif/${w.notifId}/respond`, { mode: 'DO' });
    sim.open();
    expect((await web.fill()).created).toEqual([]);
    await expectSame(sim);
  });

  it('出金 30,000：MU 先減回 10%，其餘賣 VOO；填快照時扣掉轉出的錢', async () => {
    const sim = simStart();
    const r = withdraw(sim.acct, sim.pre, 30000);
    sim.acct = r.acct;
    const w = await web.post<{ notifId: number }>('/ops/withdraw', { amount: 30000 });
    await expectSame(sim);
    const v = await web.notif(w.notifId);
    expect(v.withdraw).toBe(30000);
    expect(v.items[0].headline).toBe('出金 $30,000');
    expect(v.items[0].explain.why).toContain('MU 在出金後會超過總資產 15%');
    expect(orderOf(v, 'VOO')!.parts[0].reason).toBe('不夠的錢從核心拿（賣 VOO）');
    expect(v.items[0].explain.facts!.find((f) => f.label === '自選 MU')!.note).toContain('單檔上限');
    expect(v.composed!.orders.every((o) => o.shares < 0)).toBe(true);
    expect(v.composed!.withdraw).toBe(30000);
    sim.respond(r.notif.id);
    await web.post(`/notif/${w.notifId}/respond`, { mode: 'DO' });
    const form = await web.get<SnapshotForm>('/snapshot/form');
    expect(form.withdraw).toBe(30000);
    sim.open();
    await web.fill();
    await expectSame(sim);
    expect((await demoAcct()).acct.cash).toBeLessThan(2500);
    // 出金超過總資產：擋下來
    expect(await web.fail('/ops/withdraw', { amount: 9e8 })).toMatchObject({ status: 422 });
  });

  it('改比例 動能 30% → 0%：賣掉動能持股、買 VOO；比例加起來不是 100% 會被擋', async () => {
    const sim = simStart();
    expect(await web.fail('/ops/ratio', { own: 0.2, strat: 0.1, core: 0.8 })).toMatchObject({ status: 422, error: '三個比例加起來要是 100%' });
    const r = changeRatio(sim.acct, sim.pre, { own: 0.2, strat: 0, core: 0.8 });
    sim.acct = r.acct;
    const w = await web.post<{ notifId: number }>('/ops/ratio', { own: 0.2, strat: 0, core: 0.8 });
    await expectSame(sim);
    const v = await web.notif(w.notifId);
    expect(v.items[0].explain.why).toContain('20% / 30% / 50% 改成 20% / 0% / 80%');
    expect(orderOf(v, 'VOO')!.shares).toBeGreaterThan(0);
    sim.respond(r.notif.id);
    await web.post(`/notif/${w.notifId}/respond`, { mode: 'DO' });
    sim.open();
    await web.fill();
    await expectSame(sim);
    expect((await web.state()).account!.buckets.find((b) => b.id === 'mom')).toMatchObject({ value: 0, budget: 0 });
  });

  it('新增自選 TSLA：試算時給健檢數字與 AI 草擬的前提；一開始就是減半，只買一半', async () => {
    const sim = simStart();
    const dry = await web.post<{ preview: NotifView; drafts: { text: string; breaksIf: string }[]; startsHalved: boolean }>('/ops/add-own', { ticker: 'tsla', dry: true });
    await expectSame(sim);
    expect(dry.startsHalved).toBe(true);
    expect(dry.drafts).toHaveLength(3);
    const x = dry.preview.items[0].explain;
    expect(x.why).toContain('一開始只買標準比重的一半');
    expect(x.facts!.map((f) => f.label)).toEqual(expect.arrayContaining(['年化波動度（近半年）', '距 52 週高點', '相對 200 日均線', '動能排名']));
    const premises = [{ text: '自駕計程車在 2027 年擴大到 10 個城市', origin: 'AI_DRAFT_ACCEPTED' as const, breaksIf: '主要城市的營運許可被撤回' }];
    const r = addOwn(sim.acct, sim.pre, 'TSLA', premises.map((p, k) => ({ id: `P${k + 1}`, ...p })));
    sim.acct = r.acct;
    const w = await web.post<{ notifId: number }>('/ops/add-own', { ticker: 'TSLA', premises });
    await expectSame(sim);
    const st = await web.state();
    expect(st.account!.holdings.find((h) => h.ticker === 'TSLA')).toMatchObject({ bucket: 'own', shares: 0, state: '減半中' });
    sim.respond(r.notif.id);
    await web.post(`/notif/${w.notifId}/respond`, { mode: 'DO' });
    sim.open();
    await web.fill();
    await expectSame(sim);
    // 已經在自選、代號不對、核心的標的：擋下來
    expect((await web.fail('/ops/add-own', { ticker: 'TSLA' })).error).toContain('已經在自選裡');
    expect((await web.fail('/ops/add-own', { ticker: 'ZZZZ' })).error).toContain('抓不到 ZZZZ');
    expect((await web.fail('/ops/add-own', { ticker: 'VOO' })).status).toBe(422);
    // 移除自選
    const rm = await web.post<{ notifId: number }>('/ops/remove-own', { ticker: 'TSLA' });
    expect((await web.notif(rm.notifId)).items[0].headline).toMatch(/^賣 TSLA \d+ 股（全部）$/);
  });

  it('自己買了 10 股 AAPL：快照出現清單外的變動 → 問哪一桶；分類前月報暫停；只能歸自選；分類後月報重算', async () => {
    const sim = simStart();
    const simR = sim.open({ AAPL: 10 })!;
    const webR = await web.fill({ AAPL: 10 });
    expect(webR.created.map((c) => c.kind)).toEqual(['CLASSIFY']);
    await expectSame(sim);
    const cid = webR.created[0].id;
    expect(cid).toBe(simR.created[0].id);
    let st = await web.state();
    expect(st.todo[0]).toMatchObject({ id: cid, type: 'ANSWER' });
    expect(st.account!.unclassified).toEqual([{ ticker: 'AAPL', shares: 10 }]);
    const ask = (await web.notif(cid)).ask;
    expect(ask).toEqual({ type: 'CLASSIFY', ticker: 'AAPL', quantity: 10, canMom: false });

    sim.runUntil('2027-01-04');
    sim.preOpen();
    await web.post('/advance', { mode: 'month' });
    await expectSame(sim);
    st = await web.state();
    expect(st.account!.monthlyBlocked).toBe(true);
    expect(st.todo.some((t) => t.title.includes('月報暫停'))).toBe(true);

    // AAPL 不在動能名單上 → 不能歸動能
    expect((await web.fail(`/notif/${cid}/classify`, { bucket: 'mom' })).error).toContain('只能歸自選');
    const ok = classify(sim.acct, sim.pre, cid, { bucket: 'own', reason: '想長期持有' });
    sim.acct = ok.acct;
    const again = sim.preOpen()!;
    const w = await web.post<{ monthlyUnblocked: boolean; notifId: number }>(`/notif/${cid}/classify`, { bucket: 'own', reason: '想長期持有' });
    expect(w).toMatchObject({ monthlyUnblocked: true, notifId: again.id });
    const { acct } = await demoAcct();
    expect(acct.lots.own.AAPL).toBe(10);
    expect(acct.own.AAPL.premises[0].text).toBe('想長期持有');
    expect(acct.monthlyBlocked).toBe(false);
    expect((await web.notif(w.notifId)).title).not.toContain('暫停');
  });

  it('現金和預期差很多 → 問是入金、出金、股利還是其他', async () => {
    simStart();
    const snap = await demoSnapshot({});
    const r = await web.post<{ created: { id: number; kind: string }[] }>('/snapshot', { ...snap, cash: snap.cash + 500 });
    expect(r.created.map((c) => c.kind)).toEqual(['CASH_DIFF']);
    const id = r.created[0].id;
    expect((await web.notif(id)).ask).toEqual({ type: 'CASH_DIFF', amount: 500 });
    expect((await web.fail(`/notif/${id}/cash`, { kind: '出金' })).status).toBe(422); // 現金變多不會是出金
    await web.post(`/notif/${id}/cash`, { kind: '股利' });
    expect((await web.notif(id)).status).toBe('DONE');
    expect((await demoAcct()).acct.events.at(-1)).toMatchObject({ kind: 'DIVIDEND', amount: 500 });
  });

  it('輸入檢查：金額、代號、股數不對都擋在外面，帳戶不變', async () => {
    const sim = simStart();
    for (const [path, b] of [
      ['/ops/deposit', { amount: -5 }],
      ['/ops/deposit', { amount: 'abc' }],
      ['/ops/add-own', { ticker: 'DROP TABLE' }],
      ['/snapshot', { shares: { MU: -3 }, cash: 100 }],
      ['/snapshot', { shares: { MU: 3 } }],
      ['/notif/99999/respond', { mode: 'DO' }],
    ] as const) {
      const r = await web.fail(path, b);
      expect([404, 422]).toContain(r.status);
    }
    expect((await web.raw('POST', '/ops/deposit', undefined)).status).toBe(422); // 沒有內容
    await expectSame(sim);
  });
});

// ================================================================ 情境 ②（示範用；確認規則和 AI 並列時兩邊的理由都在）

describe('示範情境 ② 自選股大跌：規則和 AI 並列', () => {
  const web = new Web('/demo/api');
  it('整個情境從頭走到尾不出錯；MU 減半只有一行、META 兩行並列、F25 只有 AI 一行', async () => {
    await web.post('/reset', { scenario: 's2' });
    let st = await web.state();
    expect(st.today).toBe('2026-12-28');
    const urgent = st.todo.find((t) => t.type === 'DECIDE')!;
    expect(urgent.title).toBe('MU 慢規則減半');
    const v = await web.notif(urgent.id);
    const mu = itemOf(v, '慢規則減半', 'MU');
    expect(mu.choices.map((c) => c.id)).toEqual(['RULE', 'SKIP']);
    expect(mu.explain.why).toMatch(/比 52 週高點 \$[\d.]+ 低 2\d\.\d%/);
    expect(mu.explain.gauge!.value).toBeLessThanOrEqual(-0.2);
    // AI 和規則同一個動作：不多一行，但理由裡看得到 AI 的看法與那次審查
    expect(mu.explain.facts!.find((f) => f.label === 'AI 的看法')!.value).toContain('減半');
    expect(mu.explain.ai).toMatchObject({ kind: 'REVIEW', ticker: 'MU', verdict: '減半' });
    await web.post(`/notif/${urgent.id}/respond`, { mode: 'DO' });
    await web.fill();

    // 1/4 月報：META 規則說減半、AI 說不動
    await web.post('/advance', { mode: 'month' });
    st = await web.state();
    const jan = await web.notif(st.todo.find((t) => t.title === '2027-01 月報')!.id);
    const meta = itemOf(jan, '慢規則減半', 'META');
    expect(meta.choices.map((c) => c.id)).toEqual(['RULE', 'AI', 'SKIP']);
    expect(meta.choices[1]).toMatchObject({ label: '照 AI：不動', text: '不動' });
    expect(meta.choices[1].note).toContain('AI 12/31 審查的結論是「不動」');
    expect(meta.explain.why).toContain('併到這份月報');
    expect(meta.explain.ai!.verdict).toBe('不動');
    await web.post(`/notif/${jan.id}/respond`, { mode: 'DO', choices: { [meta.key]: 'AI' } });
    await web.fill();

    // 1/7 早上：AI 的條件成立，規則沒有動作
    let created: number[] = [];
    while (!created.length) created = (await web.post<{ created: number[] }>('/advance', { mode: 'notif' })).created;
    const f25 = await web.notif(created[0]);
    const it25 = itemOf(f25, 'AI 的條件成立', 'MU');
    expect(it25.choice).toBe('SKIP');
    expect(it25.explain.why).toContain('規則沒有動作');
    expect(it25.explain.ai!.quotes![0].quote).toContain('DRAM');

    // 一路走到情境結束
    for (let k = 0; k < 80; k++) {
      st = await web.state();
      if (st.demo!.atEnd) break;
      for (const t of st.todo) if (t.type === 'DECIDE' || t.type === 'INFO') await web.post(`/notif/${t.id}/respond`, { mode: 'DO' });
      await web.fill();
      await web.post('/advance', { mode: 'notif' });
    }
    expect((await web.state()).demo!.atEnd).toBe(true);
    const hist = await web.get<HistoryView>('/history');
    expect(hist.shadow.some((s) => s.ticker === 'META' && s.ai === '不動')).toBe(true);
  });
});

// ================================================================ 真實帳本（D1）

function seriesOf(m: Market, ticker: string, upTo: number): Series {
  return { ticker, fetchedAt: NOW.toISOString(), session: m.days[upTo], d: m.days.slice(0, upTo + 1), c: m.close[ticker].slice(0, upTo + 1), a: m.close[ticker].slice(0, upTo + 1), v: m.days.slice(0, upTo + 1).map(() => 1e6) };
}

/** 假的 Yahoo：回傳假市場裡那一檔的日線。 */
function yahooOf(m: Market, upTo: number): { fetcher: Fetcher; calls: string[] } {
  const calls: string[] = [];
  const fetcher: Fetcher = async (url) => {
    calls.push(url);
    const sym = /chart\/([^?]+)/.exec(url)?.[1] ?? '';
    const c = m.close[sym];
    if (!c) return Response.json({ chart: { result: null, error: { description: 'No data found' } } }, { status: 404 });
    const px = c.slice(0, upTo + 1);
    const ts = m.days.slice(0, upTo + 1).map((d) => Date.parse(d + 'T14:30:00Z') / 1000);
    return Response.json({ chart: { result: [{ meta: { symbol: sym, currency: 'USD', gmtoffset: -18000 }, timestamp: ts, indicators: { quote: [{ open: px, high: px, low: px, close: px, volume: px.map(() => 1e6) }], adjclose: [{ adjclose: px }] } }], error: null } });
  };
  return { fetcher, calls };
}

describe('真實帳本：建立帳戶、操作、存進 D1', () => {
  const m = scenarios.s5().market;
  const upTo = m.days.indexOf('2026-12-09');
  const STORED = ['VOO', 'SGOV', 'SPY', 'MU', 'NVDA', 'PLTR', 'AVGO', 'NFLX', 'AMD', 'ORCL', 'GE', 'APP'];
  const y = yahooOf(m, upTo);
  const web = new Web('/api', undefined, y.fetcher);

  it('還沒有價格資料、還沒有帳戶：畫面知道要顯示什麼', async () => {
    const st = await web.state();
    expect(st).toMatchObject({ mode: 'real', hasAccount: false, account: null, priceDate: null });
    expect(st.warnings[0]).toContain('還沒有價格資料');
    expect((await web.fail('/ops/deposit', { amount: 100 })).error).toContain('還沒有帳戶');
  });

  it('建立帳戶：填第一份快照、每一檔放哪一桶；沒存過價格的代號當場去抓', async () => {
    // SPY 在假市場裡沒有，借 VOO 的價格
    await saveSeries(db, [...STORED.filter((t) => t !== 'SPY').map((t) => seriesOf(m, t, upTo)), { ...seriesOf(m, 'VOO', upTo), ticker: 'SPY' }]);
    await saveRanking(db, { session: '2026-11-30', createdAt: NOW.toISOString(), order: ranksAt(m, m.days.indexOf('2026-11-30')), detail: { universe: [], company: {}, missing: [], nConstituents: 26 } });
    let st = await web.state();
    expect(st).toMatchObject({ hasAccount: false, priceDate: '2026-12-09', warnings: [] });

    const snap = {
      paper: true,
      cash: 2000,
      coreShares: 64,
      bondShares: 0,
      own: [
        { ticker: 'MU', shares: 56, premises: [{ text: 'HBM 長約有價格保護' }] },
        { ticker: 'nvda', shares: 25 },
        { ticker: 'MSFT', shares: 8, stdWeight: 0.05 }, // MSFT 沒存過價格
      ],
      mom: [
        { ticker: 'PLTR', shares: 33 },
        { ticker: 'AVGO', shares: 18 },
      ],
    };
    expect((await web.fail('/account', { ...snap, own: [...snap.own, { ticker: 'QQQQ', shares: 1 }] })).error).toContain('抓不到這些代號');
    expect((await web.fail('/account', { ...snap, own: [...snap.own, { ticker: 'VOO', shares: 1 }] })).error).toContain('屬於核心');
    await web.post('/account', snap);
    expect(y.calls.some((u) => u.includes('/MSFT?'))).toBe(true);
    expect((await web.fail('/account', snap)).error).toBe('帳戶已經建立過了');

    st = await web.state();
    const a = st.account!;
    expect(a.paper).toBe(true);
    expect(a.holdings.filter((h) => h.bucket === 'own').map((h) => h.ticker).sort()).toEqual(['MSFT', 'MU', 'NVDA']);
    expect(a.holdings.find((h) => h.ticker === 'MSFT')!.target).toBe('標準比重 5.0%');
    // 沒填標準比重的照波動度反比推薦，三檔合計不超過自選預算
    const loaded = (await loadAccount(db))!;
    expect(loaded.acct.rule.own.MU.stdWeight + loaded.acct.rule.own.NVDA.stdWeight).toBeLessThan(0.2);
    expect(loaded.acct.own.MU.premises[0]).toMatchObject({ text: 'HBM 長約有價格保護', origin: 'USER' });
    expect(loaded.acct.own.NVDA.premises.every((p) => p.origin === 'SYSTEM_DEFAULT')).toBe(true);
    expect(loaded.acct.rule.heldMom).toEqual(['PLTR', 'AVGO']);
    const snaps = (await db.prepare('SELECT date, cash, positions FROM snapshots').all<{ date: string; cash: number; positions: string }>()).results;
    expect(snaps).toHaveLength(1);
    expect(JSON.parse(snaps[0].positions)).toMatchObject({ VOO: 64, MU: 56, PLTR: 33 });
    // 動能排名用的是最近一次存下來的排名
    expect(a.holdings.find((h) => h.ticker === 'PLTR')!.state).toBe('排名第 1');
    expect(st.rankDate).toBe('2026-11-30');
  });

  it('入金 → 回覆 → 填快照：每一步都存進 D1，理由跟著通知一起存', async () => {
    const before = (await loadAccount(db))!;
    const w = await web.post<{ notifId: number }>('/ops/deposit', { amount: 5000 });
    const after = (await loadAccount(db))!;
    expect(after.rev).toBe(before.rev + 1);
    expect(after.acct.cash).toBe(before.acct.cash + 5000);
    const stored = after.acct.notifs.find((n) => n.id === w.notifId)! as Notif & { items: { x?: { why: string } }[] };
    expect(stored.items[0].x!.why).toContain('入金只買不賣');
    const v = await web.notif(w.notifId);
    await web.post(`/notif/${w.notifId}/respond`, { mode: 'DO' });
    // 上一步（改決定）也存進 D1：通知退回等你決定，再回覆一次
    await web.post(`/notif/${w.notifId}/reopen`);
    const reopened = (await loadAccount(db))!;
    expect(reopened.rev).toBe(after.rev + 2);
    expect(reopened.acct.notifs.find((n) => n.id === w.notifId)).toMatchObject({ status: 'PENDING' });
    expect((await web.get<HistoryView>('/history')).shadow).toEqual([]); // 作廢記號不顯示
    await web.post(`/notif/${w.notifId}/respond`, { mode: 'DO' });
    const form = await web.get<SnapshotForm>('/snapshot/form');
    expect(form.autofill).toBeNull(); // 真實模式沒有「幫我填」
    const shares = Object.fromEntries(form.rows.map((r) => [r.ticker, r.expected]));
    const r = await web.post<{ completed: number[]; created: unknown[] }>('/snapshot', { shares, cash: form.cashExpected });
    expect(r).toMatchObject({ completed: [w.notifId], created: [] });
    const done = (await loadAccount(db))!;
    for (const o of v.composed!.orders) {
      const b = (t: string) => (before.acct.lots.own[t] ?? 0) + (before.acct.lots.mom[t] ?? 0) + (before.acct.lots.core[t] ?? 0);
      const a2 = (t: string) => (done.acct.lots.own[t] ?? 0) + (done.acct.lots.mom[t] ?? 0) + (done.acct.lots.core[t] ?? 0);
      expect(a2(o.ticker) - b(o.ticker)).toBe(o.shares);
    }
    const hist = await web.get<HistoryView>('/history');
    expect(hist.events.some((e) => e.text.startsWith('入金：$5,000'))).toBe(true);
    expect(hist.events.some((e) => e.text.startsWith('成交：') && e.notif === w.notifId)).toBe(true);
    expect(hist.notifs[0]).toMatchObject({ id: w.notifId, status: 'DONE' });
  });

  it('快照出現沒存過價格的代號：當場抓價格，再問屬於哪一桶', async () => {
    const form = await web.get<SnapshotForm>('/snapshot/form');
    const shares = Object.fromEntries(form.rows.map((r) => [r.ticker, r.expected]));
    const px = m.close.COST[upTo];
    const r = await web.post<{ created: { id: number; kind: string }[] }>('/snapshot', { shares: { ...shares, COST: 2 }, cash: form.cashBook - 2 * px });
    expect(r.created.map((c) => c.kind)).toEqual(['CLASSIFY']);
    await web.post(`/notif/${r.created[0].id}/classify`, { bucket: 'own' });
    expect((await loadAccount(db))!.acct.lots.own.COST).toBe(2);
  });

  it('價格不是最新的：畫面上有警告', async () => {
    const late = new Web('/api', undefined, y.fetcher, new Date('2026-12-11T23:30:00Z'));
    const st = await late.state();
    expect(st.warnings.join()).toContain('價格只更新到 2026-12-09（應該要有 2026-12-11）');
  });

  it('示範資料和真實帳本分開：示範模式的操作不會動到真實帳本', async () => {
    const before = (await loadAccount(db))!;
    const demo = new Web('/demo/api');
    await demo.post('/reset', { scenario: 's5' });
    await demo.post('/ops/deposit', { amount: 7777 });
    const after = (await loadAccount(db))!;
    expect(after.rev).toBe(before.rev);
    expect(after.acct.cash).toBe(before.acct.cash);
  });
});

// ================================================================ 登入

describe('登入：Cloudflare Access', () => {
  const b64 = (x: ArrayBuffer | string) => Buffer.from(typeof x === 'string' ? x : new Uint8Array(x)).toString('base64url');
  const TEAM = 'myteam.cloudflareaccess.com';
  const AUD = 'aud-tag-0123456789';
  let pair: CryptoKeyPair;
  let jwk: JsonWebKey;
  let certCalls = 0;
  const certs: Fetcher = async (url) => {
    if (url !== `https://${TEAM}/cdn-cgi/access/certs`) throw new Error('測試不應該連網：' + url);
    certCalls++;
    return Response.json({ keys: [{ kid: 'k1', kty: 'RSA', alg: 'RS256', n: jwk.n, e: jwk.e }] });
  };
  async function token(claims: Record<string, unknown>, opt: { kid?: string; key?: CryptoKey; alg?: string } = {}) {
    const head = b64(JSON.stringify({ alg: opt.alg ?? 'RS256', kid: opt.kid ?? 'k1', typ: 'JWT' }));
    const payload = b64(JSON.stringify(claims));
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', opt.key ?? pair.privateKey, new TextEncoder().encode(`${head}.${payload}`));
    return `${head}.${payload}.${b64(sig)}`;
  }
  const sec = Math.floor(NOW.getTime() / 1000);
  const good = { aud: [AUD], iss: `https://${TEAM}`, exp: sec + 600, iat: sec - 10, email: 'someone@example.com' };
  const call = (e: Env, headers: Record<string, string> = {}, path = '/demo/api/state') => handle(new Request('https://bot.example' + path, { headers }), e, certs, NOW);

  beforeAll(async () => {
    pair = (await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
  });
  beforeEach(() => {
    resetAccessCache();
    certCalls = 0;
  });

  it('還沒設定 Access：預設關閉；/admin 的金鑰可以暫時用；本機開發可以略過', async () => {
    const closed = await call({ DB: db });
    expect(closed.status).toBe(401);
    expect(await closed.json()).toEqual({ error: 'unauthorized', reason: 'NOT_CONFIGURED' });
    expect((await call({ DB: db, ADMIN_TOKEN: 'admin-secret' })).status).toBe(401);
    expect((await call({ DB: db, ADMIN_TOKEN: 'admin-secret' }, { Authorization: 'Bearer wrong' })).status).toBe(401);
    expect((await call({ DB: db, ADMIN_TOKEN: 'admin-secret' }, { Authorization: 'Bearer admin-secret' })).status).toBe(200);
    expect((await call({ DB: db, DEV_NO_AUTH: '1' })).status).toBe(200);
    expect((await call({ DB: db }, {}, '/api/state')).status).toBe(401);
  });

  it('設定 Access 之後：只認 Access 簽的權杖（header 或 cookie）；金鑰與本機略過都不再有效', async () => {
    const e: Env = { DB: db, ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ADMIN_TOKEN: 'admin-secret', DEV_NO_AUTH: '1' };
    const none = await call(e);
    expect(none.status).toBe(401);
    expect(await none.json()).toMatchObject({ reason: 'NO_TOKEN' });
    expect((await call(e, { Authorization: 'Bearer admin-secret' })).status).toBe(401);
    const t = await token(good);
    expect((await call(e, { 'Cf-Access-Jwt-Assertion': t })).status).toBe(200);
    expect((await call(e, { Cookie: `other=1; CF_Authorization=${t}` })).status).toBe(200);
    expect((await call(e, { 'Cf-Access-Jwt-Assertion': t }, '/api/state')).status).toBe(200);
    expect(certCalls).toBe(1); // 公鑰有快取
    // 團隊網域寫成網址也可以
    expect((await call({ ...e, ACCESS_TEAM_DOMAIN: `https://${TEAM}/` }, { 'Cf-Access-Jwt-Assertion': t })).status).toBe(200);
  });

  it('權杖不對一律拒絕：過期、別的應用程式、別的團隊、簽章不符、演算法不對、亂碼', async () => {
    const e: Env = { DB: db, ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD };
    const other = (await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const ok = await token(good);
    const [h, p, s] = ok.split('.');
    const bad = [
      await token({ ...good, exp: sec - 1 }),
      await token({ ...good, aud: ['someone-else'] }),
      await token({ ...good, iss: 'https://evil.cloudflareaccess.com' }),
      await token(good, { key: other.privateKey }),
      await token(good, { kid: 'unknown' }),
      await token(good, { alg: 'none' }),
      `${h}.${b64(JSON.stringify({ ...good, email: 'attacker@example.com' }))}.${s}`,
      `${h}.${p}.`,
      'not-a-jwt',
      '',
    ];
    for (const t of bad) {
      const r = await call(e, { 'Cf-Access-Jwt-Assertion': t });
      expect(r.status).toBe(401);
    }
    expect((await call(e, { 'Cf-Access-Jwt-Assertion': ok })).status).toBe(200);
  });

  it('別的網站不能替你送出操作：來源不是這個網站、或不是 JSON 的請求一律拒絕', async () => {
    const e: Env = { DB: db, ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD };
    const t = await token(good);
    const post = (headers: Record<string, string>, body = '{"amount":100,"dry":true}') =>
      handle(new Request('https://bot.example/demo/api/ops/deposit', { method: 'POST', headers: { 'Cf-Access-Jwt-Assertion': t, ...headers }, body }), e, certs, NOW);
    expect((await post({ 'Content-Type': 'application/json', Origin: 'https://bot.example' })).status).toBe(200);
    expect((await post({ 'Content-Type': 'application/json' })).status).toBe(200); // 沒有 Origin（例如 curl）
    expect((await post({ 'Content-Type': 'application/json', Origin: 'https://evil.example' })).status).toBe(403);
    // 表單可以不經過跨來源檢查就送出 text/plain：內容再像 JSON 也不收
    expect((await post({ 'Content-Type': 'text/plain', Origin: 'https://bot.example' })).status).toBe(415);
    expect((await post({})).status).toBe(415);
  });

  it('其他端點不受影響：/health 不用登入；/admin 與 /ai 仍然各用各的金鑰', async () => {
    const e: Env = { DB: db, ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ADMIN_TOKEN: 'admin-secret', AI_TASK_SECRET: 'task-secret' };
    expect((await call(e, {}, '/health')).status).toBe(200);
    expect((await call(e, {}, '/admin/data/status')).status).toBe(401);
    expect((await call(e, { Authorization: 'Bearer admin-secret' }, '/admin/data/status')).status).toBe(200);
    expect((await call(e, { 'Cf-Access-Jwt-Assertion': await token(good) }, '/admin/data/status')).status).toBe(401);
    expect((await call(e, {}, '/nothing-here')).status).toBe(404);
  });
});
