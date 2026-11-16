// T8：網站的 API。完成條件是「用網站走完情境 ① 與 ⑤，結果和 T3 的測試一致」：
// 這裡每一步都走兩條路——一條直接呼叫引擎（和 test/scenarios.test.ts 相同的 Sim），
// 一條只透過網站的 API——然後比對兩邊的帳戶狀態（各桶股數、現金、規則狀態、通知、事件、沒照做的紀錄）。
// D1 用本機模擬器；對外請求全部用假的 fetcher。
import { VOL_HIST_SEED } from '../src/engine/volSeed';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env, Fetcher } from '../src/app/env';
import { loadAccount } from '../src/app/ledgerStore';
import { SESSION_COOKIE } from '../src/app/site/auth';
import { LINE_CERTS_URL, LINE_TOKEN_URL, LOGIN_COOKIE, resetLineCertsCache, safeNext } from '../src/app/site/lineLogin';
import type { ItemView, NotifView, SnapshotForm, StateView } from '../src/app/site/views';
import type { HistoryView, HoldingDetail } from '../src/app/site/views';
import { saveRanking, saveSeries, type Series } from '../src/data/store';
import { addOwn, changeRatio, classify, deposit, itemAction, liveShadow, recordAiTier, withdraw, type Account, type Notif } from '../src/engine';
import { handle } from '../src/index';
import { money } from '../src/app/site/bubble';
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

    // 第二步：下單後填快照（2026-11-16 起「到券商下單」併進填快照）；待辦變成「等你下單、填快照」
    const st = await web.state();
    expect(st.todo[0]).toMatchObject({ id: n.id, type: 'TRADE' });
    expect((await web.notif(n.id)).step).toBe(2);

    // 填快照頁要有下單用的資料：清單的日期（股數用哪天的收盤價算）、月報不是自己發起的（可以回去改決定）
    const form = await web.get<SnapshotForm>('/snapshot/form');
    expect(form.lists).toEqual([{ id: n.id, title: '2026-12 月報', date: n.date, cancel: false }]);
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

  it('史萊姆的話：改一個選項只講那個選項的結果，數字和引擎前後兩次試算一致；待辦與帳戶頁也用真實數字', async () => {
    const { sim, n } = simStart();
    const v = await web.notif(n.id);
    const orcl = itemOf(v, '動能出場', 'ORCL');
    // 門檻條：排名掉出前 15 → 整條變紅，下面寫著這次賣出全部
    expect(orcl.meter).toMatchObject({ s: 'hit', zone: '賣出', kind: 'stop' });
    expect(orcl.meter!.v).toBeGreaterThan(orcl.meter!.t);
    expect(orcl.meter!.say).toBe('已經掉出前 15 名 → 這次月報賣出全部 28 股');
    expect(itemOf(v, '動能比例調回', 'PLTR').meter).toMatchObject({ s: 'hit', zone: '調回' });
    expect(itemOf(v, '動能進場', 'GE').meter).toMatchObject({ s: 'hit', zone: '進場', kind: 'go' });
    expect(itemOf(v, 'AI 建議提高比重', 'MSFT').meter).toMatchObject({ zone: '可提高', kind: 'go' });

    type Pv = NonNullable<NotifView['composed']> & { effect?: import('../src/app/site/bubble').Bubble };
    const before = await web.post<Pv>(`/notif/${n.id}/preview`, { choices: {} });
    expect(before.effect).toBeUndefined(); // 沒說改了哪一個，就只回清單
    const after = await web.post<Pv>(`/notif/${n.id}/preview`, { choices: { [orcl.key]: 'SKIP' }, changed: { key: orcl.key, from: 'DO' } });
    const e = after.effect!;
    const text = e.say.map((s) => (typeof s === 'string' ? s : s.t)).join('');
    const count = (c: Pv) => c.orders.filter((o) => !o.transfer).length;
    const diff = count(before) - count(after);
    expect(e.k).toBe('ORCL：這次不做');
    expect(text.startsWith('ORCL 這次不賣。')).toBe(true);
    expect(text).toContain(`右邊少了 ${diff} 張單`);
    expect(text).toContain(money(after.cashAfter));
    expect(e.mood).toBe(after.cashAfter < -1 || text.includes('超過預算') ? 'worry' : 'watch');
    if (after.cashAfter < -1) expect(text).toContain('會是負的');
    // 改回照做：開心
    const back = await web.post<Pv>(`/notif/${n.id}/preview`, { choices: { [orcl.key]: 'DO' }, changed: { key: orcl.key, from: 'SKIP' } });
    expect(back.effect!.mood).toBe('happy');
    expect(back.effect!.say.map((s) => (typeof s === 'string' ? s : s.t)).join('')).toContain('賣 ORCL 28 股');
    await expectSame(sim); // 試算沒有改帳戶

    // 待辦頁：照建議做完的結果，現金和右邊的清單相同
    const st = await web.state();
    const todoText = st.bubble.todo.say.map((s) => (typeof s === 'string' ? s : s.t)).join('');
    expect(st.bubble.todo.k).toBe('照建議做完的話');
    expect(todoText).toContain(`共 ${count(before)} 張單`);
    expect(todoText).toContain(money(v.composed!.cashAfter));
    expect(todoText).toContain('MSFT 的 AI 建議預設不做');
    // 帳戶頁：現在的狀況，點名掉出名單的 ORCL
    const acctText = st.bubble.account!.say.map((s) => (typeof s === 'string' ? s : s.t)).join('');
    expect(acctText).toContain('ORCL');
    expect(st.account!.holdings.find((h) => h.ticker === 'ORCL')!.meter).toMatchObject({ s: 'hit', zone: '賣出' });
    expect(st.account!.status[0].meter).toMatchObject({ zone: '啟動', s: 'ok' });
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

  it('ORCL 按「我想留著」：不用下單，改歸自選，理由存成買進時的一句話（T40）', async () => {
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
    // T40：理由是買進時的一句話（持股頁「還沒有你的論點」下面顯示），前提仍是系統預設
    expect(detail.own!.buyNote).toMatchObject({ text: '雲端訂單還在成長' });
    expect(detail.own!.kind).toBe('DEFAULT_ONLY');
    expect(detail.own!.premises[0]).toMatchObject({ id: 'P1', system: true, silenced: null }); // T27：持股頁的前提帶編號；T30：靜默中的那一句
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
    sim.respond(r.notif.id); // 自己發起的：按確定就是決定了，直接到第 2 步（T14）
    const w = await web.post<{ notifId: number }>('/ops/deposit', { amount: '10,000' });
    expect(w.notifId).toBe(r.notif.id);
    await expectSame(sim);
    const v = await web.notif(w.notifId);
    expect(v.composed!.orders.map((o) => `${o.ticker}:${o.shares}`).sort()).toEqual(r.notif.preview!.merged.map((m) => `${m.ticker}:${m.shares}`).sort());
    // 入金的項目沒有「這次不做」
    expect(v.items[0].choices.map((c) => c.id)).toEqual(['DO']);
    // 每一行都說明現在占多少、目標多少；T33d 起最上面多一列「做完之後」（core_ai §3.11）
    const lineFacts = v.items[0].explain.facts!.filter((f) => f.label !== '做完之後');
    expect(v.items[0].explain.facts![0].label).toBe('做完之後');
    expect(lineFacts.length).toBe(v.items[0].choices[0].lines.length);
    // T43：入金補自選的那一行寫補到多少（這個情境的自選標準比重合計超過 20%，入金照比例少補，寫「入金補到」）；動能照舊寫目標
    for (const [k, l] of v.items[0].choices[0].lines.entries()) expect(lineFacts[k].note).toMatch(l.bucket === 'own' ? /^目前 [\d.]+%，(補到標準比重|入金補到) [\d.]+%/ : /目前 [\d.]+%，目標 [\d.]+%/);
    sim.open();
    expect((await web.fill()).created).toEqual([]);
    await expectSame(sim);
  });

  it('出金 30,000：MU 先減回 10%，其餘賣 VOO；填快照時扣掉轉出的錢', async () => {
    const sim = simStart();
    const r = withdraw(sim.acct, sim.pre, 30000);
    sim.acct = r.acct;
    sim.respond(r.notif.id); // 自己發起的：按確定就是決定了，直接到第 2 步（T14）
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
    sim.respond(r.notif.id); // 自己發起的：按確定就是決定了，直接到第 2 步（T14）
    const w = await web.post<{ notifId: number }>('/ops/ratio', { own: 0.2, strat: 0, core: 0.8 });
    await expectSame(sim);
    const v = await web.notif(w.notifId);
    expect(v.items[0].explain.why).toContain('20% / 30% / 50% 改成 20% / 0% / 80%');
    expect(orderOf(v, 'VOO')!.shares).toBeGreaterThan(0);
    sim.open();
    await web.fill();
    await expectSame(sim);
    expect((await web.state()).account!.buckets.find((b) => b.id === 'mom')).toMatchObject({ value: 0, budget: 0 });
  });

  it('新增自選 TSLA：試算時給健檢數字；一開始就是減半，只買一半（T27：AI 草擬的前提拿掉）', async () => {
    const sim = simStart();
    const dry = await web.post<{ preview: NotifView; drafts?: unknown; startsHalved: boolean }>('/ops/add-own', { ticker: 'tsla', dry: true });
    await expectSame(sim);
    expect(dry.startsHalved).toBe(true);
    expect(dry.drafts).toBeUndefined();
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
    expect(ask).toEqual({ type: 'CLASSIFY', ticker: 'AAPL', quantity: 10, canMom: false, canOwn: true, canRemoveOwn: false, note: null });

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
    expect(acct.own.AAPL.buyNote?.text).toBe('想長期持有'); // T40：買進時的一句話，不是前提
    expect(acct.monthlyBlocked).toBe(false);
    expect((await web.notif(w.notifId)).title).not.toContain('暫停');
  });

  it('現金和預期差很多：不再問，記成其他現金變動；超過總資產 0.5%、又沒有成交可以解釋 → 回傳「可能填錯」（2026-11-15）', async () => {
    simStart();
    const snap = await demoSnapshot({});
    const r = await web.post<{ created: unknown[]; cashOther: number; cashWarn: boolean }>('/snapshot', { ...snap, cash: snap.cash + 500 });
    expect(r).toMatchObject({ created: [], cashOther: 500, cashWarn: true }); // 總資產約 9.7 萬，0.5% 約 490
    expect((await demoAcct()).acct.events.at(-1)).toMatchObject({ kind: 'CASH_OTHER', amount: 500 });
    expect((await web.state()).todo).toEqual([]);
  });

  it('入金按確定就到第 2 步；忘了填快照到月報日 → 月報暫停；取消入金 → 暫停解除、月報重算（T14）', async () => {
    simStart();
    const before = (await demoAcct()).acct;
    const w = await web.post<{ notifId: number }>('/ops/deposit', { amount: 3000 });
    let v = await web.notif(w.notifId);
    expect(v).toMatchObject({ status: 'RESPONDED', step: 2, cancel: { label: '取消這筆入金' } });
    // 填快照頁：入金清單只能取消、不能回去改決定（畫面上不給「上一步：改決定」）
    expect((await web.get<SnapshotForm>('/snapshot/form')).lists).toEqual([{ id: w.notifId, title: v.title, date: v.date, cancel: true }]);
    await web.post('/advance', { mode: 'month' });
    let st = await web.state();
    const paused = st.todo.find((t) => t.title.startsWith('月報暫停'));
    expect(paused?.title).toBe('月報暫停：「入金 $3,000 的清單」決定了還沒填快照');
    expect(st.account!.monthlyBlocked).toBe(true);
    await web.post(`/notif/${w.notifId}/cancel`);
    v = await web.notif(w.notifId);
    expect(v).toMatchObject({ status: 'CANCELLED', statusLabel: '已取消', cancel: null });
    const after = (await demoAcct()).acct;
    expect(after.cash).toBeCloseTo(before.cash, 6);
    expect(after.monthlyBlocked).toBe(false);
    st = await web.state();
    expect(st.todo.some((t) => t.title.startsWith('月報暫停'))).toBe(false);
    expect(after.notifs.some((n) => (n.kind === 'MONTHLY' || n.kind === 'MONTHLY_EMPTY') && n.status === 'PENDING')).toBe(true);
    expect((await web.fail(`/notif/${w.notifId}/cancel`)).status).toBe(409);
  });

  it('示範模式也可以復原上一份快照（T14）', async () => {
    simStart();
    const before = (await demoAcct()).acct;
    const f = await web.get<SnapshotForm>('/snapshot/form');
    const lots = { own: Object.fromEntries(f.buckets.own.map((x) => [x.ticker, x.expected])), mom: Object.fromEntries(f.buckets.mom.map((x) => [x.ticker, x.expected])), core: Object.fromEntries(f.buckets.core.map((x) => [x.ticker, x.expected])) };
    lots.own.MU = 0; // 不小心把自選填成 0 → 移出自選
    const r = await web.post<{ removedOwn: string[] }>('/snapshot', { lots, cash: f.cashBook });
    expect(r.removedOwn).toEqual(['MU']);
    expect((await demoAcct()).acct.own.MU).toBeUndefined();
    // 現金沒跟著改：差一整檔的錢 → 待辦頁會提醒「可能填錯」
    expect((await web.state()).undo).toMatchObject({ cashWarn: true });
    expect((await web.state()).undo!.cashOther).toBeLessThan(0);
    await web.post('/snapshot/undo');
    expect((await demoAcct()).acct).toEqual(before); // 前提、標準比重、規則狀態都回來
    expect((await web.state()).undo).toBeNull();
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

// T31b 改了減半項目上 AI 的那一部分（own_thesis §3.3、§3.4）：「照 AI」只來自看過這次觸發的結論；只有系統預設前提的股票（META）不能選不動。
// 所以示範腳本改成：MU 由 12/18 的審查（前提不成立、減半）併進來寫「同意減半」；META 的減半檢視同意減半，並寫明只檢查系統預設前提
describe('示範情境 ② 自選股大跌：規則和 AI 並列', () => {
  const web = new Web('/demo/api');
  it('整個情境從頭走到尾不出錯；MU 減半寫審查同意減半、META 只檢查預設前提同意減半、這次不做要寫理由、你定的條件成立預設照當時的決定、乙類要寫理由', async () => {
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
    // AI 和規則同一個動作：不多一個選項，那一行寫 12/18 的審查認為哪一條前提不成立、同意減半；理由裡看得到那次審查
    expect(mu.aiLine).toBe('12/18 的審查認為前提「HBM 長約有價格保護，記憶體循環這次不會像以前一樣崩」不成立，同意減半');
    expect(mu.drop).toBe('AGREE');
    expect(mu.explain.short).toContain('AI 同意減半');
    expect(mu.explain.ai).toMatchObject({ kind: 'REVIEW', ticker: 'MU', verdict: '減半' });
    // 減半項目選「這次不做」要寫一句理由（整則這次不做也一樣）
    expect(mu.reasonRequired).toBe(true);
    expect(await web.fail(`/notif/${urgent.id}/respond`, { mode: 'DO', choices: { [mu.key]: 'SKIP' } })).toMatchObject({ status: 422 });
    expect(await web.fail(`/notif/${urgent.id}/respond`, { mode: 'SKIP' })).toMatchObject({ status: 422 });
    await web.post(`/notif/${urgent.id}/respond`, { mode: 'DO' });
    await web.fill();

    // 1/4 月報：META 只有系統預設前提 → AI 只能同意減半或建議出清，沒有「不動」；那一行寫明只檢查系統預設前提
    await web.post('/advance', { mode: 'month' });
    st = await web.state();
    const jan = await web.notif(st.todo.find((t) => t.title === '2027-01 月報')!.id);
    const meta = itemOf(jan, '慢規則減半', 'META');
    expect(meta.choices.map((c) => c.id)).toEqual(['RULE', 'SKIP']);
    expect(meta.aiLine).toBe('論點檢查（3 票）：同意減半（歸類：產業一起跌）。這檔還沒有你的論點，AI 只檢查系統預設前提。');
    expect(meta.title).toMatch(/^META：比 52 週高點低 2\d\.\d% → 慢規則減半（2026-12-24 觸發/);
    expect(meta.explain.why).toContain('併到這份月報');
    expect(meta.explain.ai!.verdict).toBe('減半（照規則）');
    await web.post(`/notif/${jan.id}/respond`, { mode: 'DO' });
    await web.fill();

    // 1/7 早上：你定的條件成立（T29a 起是甲類：預設照當時的決定、規則沒有動作）
    let created: number[] = [];
    while (!created.length) created = (await web.post<{ created: number[] }>('/advance', { mode: 'notif' })).created;
    const f25 = await web.notif(created[0]);
    const it25 = itemOf(f25, '你定的條件成立', 'MU');
    expect(it25.choice).toBe('DO');
    expect(it25.reasonRequired).toBe(true);
    expect(it25.explain.why).toContain('規則沒有動作');
    expect(it25.explain.ai!.quotes![0].quote).toContain('DRAM');
    // 「這次不做」沒寫理由送不出去
    expect(await web.fail(`/notif/${f25.id}/respond`, { mode: 'DO', choices: { [it25.key]: 'SKIP' } })).toMatchObject({ status: 422 });

    // 一路走到情境結束（乙類的「不同意，不動」要寫理由：每一項都帶一句）
    for (let k = 0; k < 80; k++) {
      st = await web.state();
      if (st.demo!.atEnd) break;
      for (const t of st.todo) {
        if (t.type !== 'DECIDE' && t.type !== 'INFO') continue;
        const nv = await web.notif(t.id);
        await web.post(`/notif/${t.id}/respond`, { mode: 'DO', reasons: Object.fromEntries(nv.items.map((i) => [i.key, '示範：先不動'])) });
      }
      await web.fill();
      await web.post('/advance', { mode: 'notif' });
    }
    expect((await web.state()).demo!.atEnd).toBe(true);
    const hist = await web.get<HistoryView>('/history');
    // META 的減半（AI 同意，沒有另一個選項）照規則做了：不算「沒照規則做的」，紀錄裡沒有這一筆
    expect(hist.shadow.some((s) => s.ticker === 'META' && s.title.includes('慢規則減半'))).toBe(false);
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
    // 沒填標準比重的用現在占總資產的比重（T43，原本照波動度反比推薦）
    const loaded = (await loadAccount(db))!;
    for (const t of ['MU', 'NVDA']) {
      const hd = await web.get<HoldingDetail>(`/holding/${t}`);
      expect(hd.own!.weight).toBeGreaterThan(0);
      // 超過單檔上限 15% 的取上限（MU 在這個情境占 18%）
      expect(loaded.acct.rule.own[t].stdWeight).toBeCloseTo(Math.min(0.15, hd.own!.weight), 12);
    }
    expect(loaded.acct.rule.own.MU.stdWeight).toBe(0.15);
    expect(loaded.acct.rule.own.MSFT.stdWeight).toBe(0.05); // 有填的照填的
    // T40：建立帳戶的「持有的原因」存成買進時的一句話，前提仍是系統預設
    expect(loaded.acct.own.MU.buyNote).toEqual({ text: 'HBM 長約有價格保護', at: loaded.acct.snapshotDate });
    expect(loaded.acct.own.MU.premises.every((p) => p.origin === 'SYSTEM_DEFAULT')).toBe(true);
    expect(loaded.acct.own.NVDA.premises.every((p) => p.origin === 'SYSTEM_DEFAULT')).toBe(true);
    expect(loaded.acct.rule.heldMom).toEqual(['PLTR', 'AVGO']);
    // 依波動度減碼的起始歷史接上回測重放（不用等 24 個月）；比例由第一份月報決定
    expect(loaded.acct.rule.volHist).toEqual([...VOL_HIST_SEED.values]);
    expect(loaded.acct.rule.volW).toBeNull();
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
    expect(v.status).toBe('RESPONDED'); // 自己發起的：按確定就是決定了（T14）
    expect(v.cancel).toEqual({ label: '取消這筆入金' });
    // 上一步（改決定）也存進 D1：通知退回等你決定，再回覆一次
    await web.post(`/notif/${w.notifId}/reopen`);
    const reopened = (await loadAccount(db))!;
    expect(reopened.rev).toBe(after.rev + 1);
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

  it('緊急賣（T14）：快照的原因帶進分類；自選賣光可以同時移出自選；核心賣出也記原因', async () => {
    const form = await web.get<SnapshotForm>('/snapshot/form');
    const shares = Object.fromEntries(form.rows.map((r) => [r.ticker, r.expected]));
    const pc = m.close.COST[upTo];
    const pv = m.close.VOO[upTo];
    const r = await web.post<{ created: { id: number; kind: string }[] }>('/snapshot', { shares: { ...shares, COST: 0, VOO: shares.VOO - 1 }, cash: form.cashBook + 2 * pc + pv, note: '要用錢' });
    expect(r.created.map((c) => c.kind)).toEqual(['CLASSIFY']);
    const id = r.created[0].id;
    expect((await web.notif(id)).ask).toEqual({ type: 'CLASSIFY', ticker: 'COST', quantity: -2, canMom: false, canOwn: true, canRemoveOwn: true, note: '要用錢' });
    await web.post(`/notif/${id}/classify`, { bucket: 'own', reason: '要用錢', removeOwn: true });
    const acct = (await loadAccount(db))!.acct;
    expect(acct.own.COST).toBeUndefined();
    expect(acct.rule.own.COST).toBeUndefined();
    const hist = await web.get<HistoryView>('/history');
    expect(hist.events.some((e) => e.text === '分類：自選 COST -2 股（要用錢：賣光並移出自選）')).toBe(true);
    expect(hist.events.some((e) => e.text === '成交：核心 VOO -1 股（核心的手動交易：要用錢）')).toBe(true);
    // 只賣一部分不能移出；理由太長擋下
    const f2 = await web.get<SnapshotForm>('/snapshot/form');
    const s2 = Object.fromEntries(f2.rows.map((x) => [x.ticker, x.expected]));
    expect((await web.fail('/snapshot', { shares: s2, cash: f2.cashBook, note: 'x'.repeat(301) })).status).toBe(422);
    const r2 = await web.post<{ created: { id: number }[] }>('/snapshot', { shares: { ...s2, MU: s2.MU - 1 }, cash: f2.cashBook + m.close.MU[upTo] });
    const ask = (await web.notif(r2.created[0].id)).ask;
    expect(ask).toMatchObject({ canOwn: true, canRemoveOwn: false, note: null });
    expect((await web.fail(`/notif/${r2.created[0].id}/classify`, { bucket: 'own', removeOwn: true })).error).toContain('全部賣掉時');
    await web.post(`/notif/${r2.created[0].id}/classify`, { bucket: 'own', reason: '先減一點' });
    expect((await loadAccount(db))!.acct.own.MU).toBeDefined();
  });

  it('分桶快照（T14 改版）：表單分三桶；清單外的變動照填的桶記帳、不問分類與現金；持股頁改標準比重、加前提', async () => {
    const form = await web.get<SnapshotForm>('/snapshot/form');
    expect(form.coreTickers).toEqual(['VOO', 'SGOV']);
    expect(form.buckets.core[0]).toMatchObject({ ticker: 'VOO', listed: 0 });
    expect(form.buckets.own.some((r) => r.ticker === 'MU')).toBe(true);
    const lots = { own: Object.fromEntries(form.buckets.own.map((r) => [r.ticker, r.expected])), mom: Object.fromEntries(form.buckets.mom.map((r) => [r.ticker, r.expected])), core: Object.fromEntries(form.buckets.core.map((r) => [r.ticker, r.expected])) };
    const pMU = m.close.MU[upTo];
    const pOR = m.close.ORCL[upTo];
    // 動能放不在名單上的 → 擋下，帳戶不變
    const before = (await loadAccount(db))!;
    const bad = await web.fail('/snapshot', { lots: { ...lots, mom: { ...lots.mom, ORCL: 1 } }, cash: form.cashBook - pOR });
    expect(bad).toMatchObject({ status: 422 });
    expect(bad.error).toContain('不在這個月的動能名單上');
    expect((await loadAccount(db))!.rev).toBe(before.rev);
    // 自選賣 1 股 MU、新加 2 股 ORCL（寫為什麼買），現金比估計多 3 元
    const r = await web.post<{ created: unknown[]; cashOther: number; cashWarn: boolean; removedOwn: string[] }>('/snapshot', {
      lots: { ...lots, own: { ...lots.own, MU: lots.own.MU - 1, ORCL: 2 } },
      cash: form.cashBook + pMU - 2 * pOR + 3,
      note: '換股',
      why: { ORCL: '雲端資料庫訂單成長' },
    });
    expect(r).toMatchObject({ created: [], cashOther: 3, cashWarn: false, removedOwn: [] });
    let acct = (await loadAccount(db))!.acct;
    expect(acct.lots.own.ORCL).toBe(2);
    expect(acct.lots.own.MU).toBe(lots.own.MU - 1);
    // T25：前提多記加入的訊號日（own_thesis §1.2）
    // T40：買進時的一句話（不是前提）；前提是系統預設
    expect(acct.own.ORCL.buyNote).toEqual({ text: '雲端資料庫訂單成長', at: '2026-12-09' });
    expect(acct.own.ORCL.premises.every((p) => p.origin === 'SYSTEM_DEFAULT' && p.addedAt === '2026-12-09')).toBe(true);
    expect((await web.state()).todo).toEqual([]);
    const hist = await web.get<HistoryView>('/history');
    expect(hist.events.some((e) => e.text === '成交：自選 ORCL +2 股（自選的手動交易：換股）')).toBe(true);
    expect(hist.events.some((e) => e.text.startsWith('其他現金變動：'))).toBe(true);
    // 持股頁：改標準比重、編輯論點（T27 起取代「加前提」：原本的前提照文字沿用，新的接在後面）
    await web.post('/ops/std-weight', { ticker: 'ORCL', stdWeight: 0.04 });
    expect((await web.fail('/ops/std-weight', { ticker: 'AMD', stdWeight: 0.04 })).error).toContain('不在自選裡');
    expect((await web.fail('/ops/std-weight', { ticker: 'ORCL', stdWeight: 0.9 })).status).toBe(422);
    await web.post('/ops/own-thesis', { ticker: 'ORCL', thesis: '', premises: [{ text: '雲端資料庫訂單成長' }, { text: '毛利率維持 70% 以上' }], exitConditions: [] });
    acct = (await loadAccount(db))!.acct;
    expect(acct.rule.own.ORCL.stdWeight).toBe(0.04);
    expect(acct.own.ORCL.premises.map((p) => p.text)).toEqual(['雲端資料庫訂單成長', '毛利率維持 70% 以上']);
    expect((await web.get<HoldingDetail>('/holding/ORCL')).own!.stdWeight).toBe(0.04);
    // 自選股數改成 0 → 自動移出自選
    const f2 = await web.get<SnapshotForm>('/snapshot/form');
    const l2 = { own: Object.fromEntries(f2.buckets.own.map((x) => [x.ticker, x.expected])), mom: Object.fromEntries(f2.buckets.mom.map((x) => [x.ticker, x.expected])), core: Object.fromEntries(f2.buckets.core.map((x) => [x.ticker, x.expected])) };
    const r2 = await web.post<{ removedOwn: string[] }>('/snapshot', { lots: { ...l2, own: { ...l2.own, ORCL: 0 } }, cash: f2.cashBook + 2 * pOR });
    expect(r2.removedOwn).toEqual(['ORCL']);
    expect((await loadAccount(db))!.acct.own.ORCL).toBeUndefined();
  });

  it('復原上一份快照（T14）：帳戶、通知、帳本事件、影子、快照原文一起退回；之後有其他操作就不能復原', async () => {
    const count = async (t: string) => (await db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first<{ n: number }>())!.n;
    const lotsOf = (f: SnapshotForm) => ({ own: Object.fromEntries(f.buckets.own.map((x) => [x.ticker, x.expected])), mom: Object.fromEntries(f.buckets.mom.map((x) => [x.ticker, x.expected])), core: Object.fromEntries(f.buckets.core.map((x) => [x.ticker, x.expected])) });
    // 帳戶頁的核心：VOO、SGOV（0 股也列）、現金三列
    const core = (await web.state()).account!.holdings.filter((x) => x.bucket === 'core').map((x) => x.ticker);
    expect(core).toEqual(['VOO', 'SGOV', '現金']);

    const w = await web.post<{ notifId: number }>('/ops/deposit', { amount: 5000 });
    const mid = (await loadAccount(db))!;
    const n0 = { ev: await count('ledger_events'), sh: await count('shadow_records'), snap: await count('snapshots') };
    const form = await web.get<SnapshotForm>('/snapshot/form');
    const lots = lotsOf(form);
    lots.core.VOO -= 1; // 外加一筆清單外的賣出，現金也故意差 7 元
    const r = await web.post<{ completed: number[]; undoable: boolean }>('/snapshot', { lots, cash: form.cashExpected + m.close.VOO[upTo] + 7, note: '填錯的' });
    expect(r).toMatchObject({ completed: [w.notifId], undoable: true });
    expect(await count('ledger_events')).toBeGreaterThan(n0.ev);
    expect((await web.state()).undo).toEqual({ date: '2026-12-09', at: NOW.toISOString(), cashOther: 7, cashWarn: false });
    await web.post('/snapshot/undo');
    const back = (await loadAccount(db))!;
    expect(back.rev).toBe(mid.rev + 2);
    expect(back.acct.lots).toEqual(mid.acct.lots);
    expect(back.acct.cash).toBe(mid.acct.cash);
    expect(back.acct.notifs).toEqual(mid.acct.notifs); // 入金清單回到「等成交」
    expect({ ev: await count('ledger_events'), sh: await count('shadow_records'), snap: await count('snapshots') }).toEqual(n0);
    expect((await db.prepare('SELECT cause FROM account_history ORDER BY rev DESC LIMIT 1').first<{ cause: string }>())!.cause).toContain('復原快照');
    expect((await web.state()).undo).toBeNull();
    expect((await web.fail('/snapshot/undo')).status).toBe(409);
    // 重填正確的；之後做了別的操作 → 不能復原
    const r2 = await web.post<{ completed: number[] }>('/snapshot', { lots: lotsOf(form), cash: form.cashExpected });
    expect(r2.completed).toEqual([w.notifId]);
    expect((await web.state()).undo).not.toBeNull();
    await web.post('/ops/std-weight', { ticker: 'MU', stdWeight: 0.05 });
    expect((await web.state()).undo).toBeNull();
    expect((await web.fail('/snapshot/undo')).error).toContain('不能復原');
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

describe('登入：LINE Login（Worker 自己做）', () => {
  const b64 = (x: ArrayBuffer | Uint8Array | string) => Buffer.from(typeof x === 'string' ? x : x instanceof Uint8Array ? x : new Uint8Array(x)).toString('base64url');
  const CH_ID = '2001234567';
  const CH_SECRET = 'line-channel-secret-0123456789abcdef';
  const USER = 'U0123456789abcdef0123456789abcdef';
  const ORIGIN = 'https://bot.example';
  const sec = Math.floor(NOW.getTime() / 1000);
  const noNet: Fetcher = async (u) => {
    throw new Error('測試不應該連網：' + u);
  };
  let conf: Env;
  let ec: CryptoKeyPair;
  let ecJwk: JsonWebKey;

  function cookieOf(res: Response, name: string): string | null {
    for (const c of res.headers.getSetCookie()) if (c.startsWith(name + '=')) return c.slice(name.length + 1).split(';')[0];
    return null;
  }

  /** 假的 LINE：token 端點檢查 code、code_verifier、client_secret、redirect_uri，回傳 make() 產生的 ID token。 */
  function fakeLine(make: (nonce: string) => Promise<string>, opt: { tokenStatus?: number } = {}) {
    const calls = { token: 0, certs: 0 };
    let nonce = '';
    let challenge = '';
    const fetcher: Fetcher = async (url, init) => {
      if (url === LINE_CERTS_URL) {
        calls.certs++;
        return Response.json({ keys: [{ kid: 'ec1', kty: 'EC', alg: 'ES256', crv: 'P-256', x: ecJwk.x, y: ecJwk.y, use: 'sig' }] });
      }
      if (url === LINE_TOKEN_URL) {
        calls.token++;
        const body = new URLSearchParams(String(init?.body));
        expect(init?.method).toBe('POST');
        expect(body.get('grant_type')).toBe('authorization_code');
        expect(body.get('code')).toBe('the-code');
        expect(body.get('client_id')).toBe(CH_ID);
        expect(body.get('client_secret')).toBe(CH_SECRET);
        expect(body.get('redirect_uri')).toBe(`${ORIGIN}/auth/line/callback`);
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body.get('code_verifier') ?? ''));
        expect(b64(digest)).toBe(challenge); // PKCE：送回的 verifier 要對得上一開始的 challenge
        if (opt.tokenStatus) return new Response('nope', { status: opt.tokenStatus });
        return Response.json({ access_token: 'at', token_type: 'Bearer', expires_in: 2592000, id_token: await make(nonce) });
      }
      throw new Error('測試不應該連網：' + url);
    };
    return {
      calls,
      fetcher,
      /** 走一次「按登入 → LINE 導回來」，回傳 callback 的回應與一開始的登入 cookie。 */
      async run(e: Env = conf, tweak: (q: URLSearchParams) => void = () => {}, next = '#/account', at: Date = NOW) {
        const start = await handle(new Request(`${ORIGIN}/auth/line/login?next=${encodeURIComponent(next)}`), e, fetcher, NOW);
        expect(start.status).toBe(302);
        const loc = new URL(start.headers.get('Location')!);
        expect(loc.origin + loc.pathname).toBe('https://access.line.me/oauth2/v2.1/authorize');
        nonce = loc.searchParams.get('nonce')!;
        challenge = loc.searchParams.get('code_challenge')!;
        const loginCookie = cookieOf(start, LOGIN_COOKIE)!;
        const q = new URLSearchParams({ code: 'the-code', state: loc.searchParams.get('state')! });
        tweak(q);
        const cb = await handle(new Request(`${ORIGIN}/auth/line/callback?${q}`, { headers: { Cookie: `${LOGIN_COOKIE}=${loginCookie}` } }), e, fetcher, at);
        return { start, loc, cb, loginCookie };
      },
    };
  }
  const hs256 = async (claims: Record<string, unknown>, secret = CH_SECRET) => {
    const head = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const body = b64(JSON.stringify(claims));
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return `${head}.${body}.${b64(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${head}.${body}`)))}`;
  };
  const es256 = async (claims: Record<string, unknown>, key: CryptoKey = ec.privateKey, kid = 'ec1') => {
    const head = b64(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid }));
    const body = b64(JSON.stringify(claims));
    return `${head}.${body}.${b64(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(`${head}.${body}`)))}`;
  };
  const idClaims = (nonce: string, o: Record<string, unknown> = {}) => ({ iss: 'https://access.line.me', sub: USER, aud: CH_ID, exp: sec + 3600, iat: sec, nonce, name: 'me', ...o });
  const api = (e: Env, headers: Record<string, string> = {}, path = '/demo/api/state', at: Date = NOW) => handle(new Request(ORIGIN + path, { headers }), e, noNet, at);
  const loggedIn = async () => {
    const { cb } = await fakeLine((n) => hs256(idClaims(n))).run();
    return `${SESSION_COOKIE}=${cookieOf(cb, SESSION_COOKIE)}`;
  };

  beforeAll(async () => {
    conf = { DB: db, LINE_LOGIN_CHANNEL_ID: CH_ID, LINE_LOGIN_CHANNEL_SECRET: CH_SECRET, SESSION_SECRET: 'session-secret-xyz', LINE_USER_ID: USER, ADMIN_TOKEN: 'admin-secret', AI_TASK_SECRET: 'task-secret' };
    ec = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    ecJwk = (await crypto.subtle.exportKey('jwk', ec.publicKey)) as JsonWebKey;
  });
  beforeEach(() => resetLineCertsCache());

  it('還沒設定 LINE 登入：API 預設關閉；管理金鑰可以用；本機開發可以略過；登入網址說明還沒設定', async () => {
    const closed = await api({ DB: db });
    expect(closed.status).toBe(401);
    expect(await closed.json()).toEqual({ error: 'unauthorized', reason: 'NOT_CONFIGURED' });
    expect((await api({ DB: db, ADMIN_TOKEN: 'admin-secret' }, { Authorization: 'Bearer wrong' })).status).toBe(401);
    expect((await api({ DB: db, ADMIN_TOKEN: 'admin-secret' }, { Authorization: 'Bearer admin-secret' })).status).toBe(200);
    expect((await api({ DB: db, DEV_NO_AUTH: '1' })).status).toBe(200);
    expect((await api({ DB: db }, {}, '/api/state')).status).toBe(401);
    const page = await handle(new Request(`${ORIGIN}/auth/line/login`), { DB: db, LINE_USER_ID: USER }, noNet, NOW);
    expect(page.status).toBe(503);
    expect(await page.text()).toContain('還沒設定 LINE 登入');
  });

  it('整趟登入（HS256）：導去 LINE 時帶 state、nonce、PKCE；回來後發 30 天的登入 cookie、回到原本的頁面；之後 API 用 cookie 就能用', async () => {
    const line = fakeLine((n) => hs256(idClaims(n)));
    const { loc, cb } = await line.run();
    expect(Object.fromEntries(loc.searchParams)).toMatchObject({ response_type: 'code', client_id: CH_ID, redirect_uri: `${ORIGIN}/auth/line/callback`, scope: 'openid profile', code_challenge_method: 'S256' });
    expect(loc.searchParams.get('state')!.length).toBeGreaterThanOrEqual(40);
    expect(cb.status).toBe(302);
    expect(cb.headers.get('Location')).toBe('/#/account');
    const set = cb.headers.getSetCookie();
    expect(set.find((c) => c.startsWith(SESSION_COOKIE + '='))).toMatch(/Path=\/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax/);
    expect(set.find((c) => c.startsWith(LOGIN_COOKIE + '='))).toMatch(/^__Host-sb_login=; .*Max-Age=0/); // 一次性的登入 cookie 清掉
    const cookie = `${SESSION_COOKIE}=${cookieOf(cb, SESSION_COOKIE)}`;
    expect((await api(conf, { Cookie: `other=1; ${cookie}` })).status).toBe(200);
    expect((await api(conf, { Cookie: cookie }, '/api/state')).status).toBe(200);
    expect(line.calls.token).toBe(1);
  });

  it('ES256 的 ID token 也驗得過（公鑰從 LINE 抓、有快取）', async () => {
    const line = fakeLine((n) => es256(idClaims(n)));
    expect((await line.run()).cb.status).toBe(302);
    expect((await line.run()).cb.status).toBe(302);
    expect(line.calls.certs).toBe(1);
  });

  it('LINE 導回來的請求不對一律不接受、也不發登入 cookie：state 不符、沒有登入 cookie、超過 10 分鐘、取消登入、沒有 code、LINE 不發憑證', async () => {
    const line = fakeLine((n) => hs256(idClaims(n)));
    const bad = [
      (await line.run(conf, (q) => q.set('state', 'forged'))).cb,
      (await line.run(conf, () => {}, '#/', new Date(NOW.getTime() + 601_000))).cb,
      (
        await line.run(conf, (q) => {
          q.delete('code');
          q.set('error', 'access_denied');
        })
      ).cb,
      (await line.run(conf, (q) => q.delete('code'))).cb,
      (await fakeLine((n) => hs256(idClaims(n)), { tokenStatus: 400 }).run()).cb,
    ];
    const { loc } = await line.run();
    bad.push(await handle(new Request(`${ORIGIN}/auth/line/callback?code=the-code&state=${loc.searchParams.get('state')}`), conf, line.fetcher, NOW)); // 別的瀏覽器（沒有登入 cookie）
    for (const r of bad) {
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(cookieOf(r, SESSION_COOKIE)).toBeNull();
    }
    expect(await bad[2].text()).toContain('取消了登入');
  });

  it('ID token 不對一律拒絕：nonce、aud、iss、過期、簽章不符、演算法 none、竄改內容、別的 LINE 帳號（403）', async () => {
    const other = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const makers: ((n: string) => Promise<string>)[] = [
      (n) => hs256(idClaims('x' + n)),
      (n) => hs256(idClaims(n, { aud: '1999999999' })),
      (n) => hs256(idClaims(n, { iss: 'https://evil.example' })),
      (n) => hs256(idClaims(n, { exp: sec - 1 })),
      (n) => hs256(idClaims(n), 'wrong-secret'),
      (n) => es256(idClaims(n), other.privateKey),
      (n) => es256(idClaims(n), ec.privateKey, 'unknown-kid'),
      async (n) => `${b64(JSON.stringify({ alg: 'none' }))}.${b64(JSON.stringify(idClaims(n)))}.`,
      async (n) => {
        const [h, , s] = (await hs256(idClaims(n, { sub: 'Uother' }))).split('.');
        return `${h}.${b64(JSON.stringify(idClaims(n)))}.${s}`;
      },
      async () => 'not-a-jwt',
    ];
    for (const m of makers) {
      const { cb } = await fakeLine(m).run();
      expect(cb.status).toBe(502);
      expect(cookieOf(cb, SESSION_COOKIE)).toBeNull();
    }
    const stranger = (await fakeLine((n) => hs256(idClaims(n, { sub: 'Ustranger' }))).run()).cb;
    expect(stranger.status).toBe(403);
    expect(cookieOf(stranger, SESSION_COOKIE)).toBeNull();
  });

  it('登入 cookie：過期、竄改、拿一次性的登入 cookie 冒充、換了 LINE_USER_ID 或 SESSION_SECRET 都失效；沒登入時告訴網頁去哪裡登入', async () => {
    const { cb, loginCookie } = await fakeLine((n) => hs256(idClaims(n))).run();
    const val = cookieOf(cb, SESSION_COOKIE)!;
    const cookie = { Cookie: `${SESSION_COOKIE}=${val}` };
    const none = await api(conf);
    expect(none.status).toBe(401);
    expect(await none.json()).toEqual({ error: 'unauthorized', reason: 'NO_SESSION', login: '/auth/line/login' });
    expect((await api(conf, cookie, '/demo/api/state', new Date(NOW.getTime() + 29 * 86400_000))).status).toBe(200);
    const expired = await api(conf, cookie, '/demo/api/state', new Date(NOW.getTime() + 30 * 86400_000 + 1000));
    expect(await expired.json()).toMatchObject({ reason: 'BAD_SESSION' });
    const [body, sig] = val.split('.');
    const forged = b64(JSON.stringify({ kind: 'session', sub: USER, exp: sec + 999 * 86400 }));
    for (const c of [`${forged}.${sig}`, `${body}.`, body, loginCookie, 'garbage']) expect((await api(conf, { Cookie: `${SESSION_COOKIE}=${c}` })).status).toBe(401);
    expect((await api({ ...conf, LINE_USER_ID: 'Unew' }, cookie)).status).toBe(401);
    expect((await api({ ...conf, SESSION_SECRET: 'rotated' }, cookie)).status).toBe(401);
    // 設好 LINE 登入之後，本機略過不再有效；管理金鑰仍是備用
    expect((await api({ ...conf, DEV_NO_AUTH: '1' })).status).toBe(401);
    expect((await api(conf, { Authorization: 'Bearer admin-secret' })).status).toBe(200);
    // 登出清掉 cookie
    const out = await handle(new Request(`${ORIGIN}/auth/logout`), conf, noNet, NOW);
    expect(out.status).toBe(302);
    expect(out.headers.getSetCookie()[0]).toMatch(/^__Host-sb_session=; .*Max-Age=0/);
  });

  it('登入後要回去的頁面只收網站自己的 #/…', async () => {
    expect(safeNext('#/h/MU')).toBe('#/h/MU');
    for (const n of ['https://evil.example', '//evil.example', '/#/x', '#/<script>', 'javascript:alert(1)', null, '#/' + 'a'.repeat(300)]) expect(safeNext(n)).toBe('');
    const { cb } = await fakeLine((n) => hs256(idClaims(n))).run(conf, () => {}, 'https://evil.example');
    expect(cb.headers.get('Location')).toBe('/');
  });

  it('別的網站不能替你送出操作：來源不是這個網站、或不是 JSON 的請求一律拒絕', async () => {
    const cookie = await loggedIn();
    const post = (headers: Record<string, string>, body = '{"amount":100,"dry":true}') =>
      handle(new Request(`${ORIGIN}/demo/api/ops/deposit`, { method: 'POST', headers: { Cookie: cookie, ...headers }, body }), conf, noNet, NOW);
    expect((await post({ 'Content-Type': 'application/json', Origin: ORIGIN })).status).toBe(200);
    expect((await post({ 'Content-Type': 'application/json' })).status).toBe(200); // 沒有 Origin（例如 curl）
    expect((await post({ 'Content-Type': 'application/json', Origin: 'https://evil.example' })).status).toBe(403);
    // 表單可以不經過跨來源檢查就送出 text/plain：內容再像 JSON 也不收
    expect((await post({ 'Content-Type': 'text/plain', Origin: ORIGIN })).status).toBe(415);
    expect((await post({})).status).toBe(415);
  });

  it('其他端點不受影響：/health 不用登入；/admin 與 /ai 仍然各用各的金鑰，登入 cookie 進不去', async () => {
    const cookie = { Cookie: await loggedIn() };
    expect((await api(conf, {}, '/health')).status).toBe(200);
    expect((await api(conf, {}, '/admin/data/status')).status).toBe(401);
    expect((await api(conf, { Authorization: 'Bearer admin-secret' }, '/admin/data/status')).status).toBe(200);
    expect((await api(conf, cookie, '/admin/data/status')).status).toBe(401);
    expect((await api(conf, cookie, '/ai/task/00000000000000000000000000000000/evidence')).status).toBe(401);
    expect((await api(conf, {}, '/auth/nothing')).status).toBe(404);
    expect((await api(conf, {}, '/nothing-here')).status).toBe(404);
  });
});
