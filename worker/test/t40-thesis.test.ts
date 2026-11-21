// T40：自選的初始論點與更新論點（own_thesis §1.7、§1.8，2026-11-16 使用者同意改）。
// 完成條件：
//   1. 買進時的一句話：快照與建立帳戶寫了一句話後這檔仍是「只有預設」；討論包是 NEW 而且帶這句話；L2 的證據包不帶
//   2. 存完之後的引導：快照結果與建立帳戶回傳還沒有論點的新自選；帳戶頁的清單直到有論點或關掉
//   3. 前提帶編號：解析 [P2] 沿用編號；改了字的排審查；只改標點的不排
//   4. 出場條件的對照：沒出現的出場條件預設保留、選撤下的變 RETIRED；勾選帶 supersedes 的改寫結果時舊條件撤下
//      （T42 改了設計：出場條件不帶編號、整組取代，對照交給改寫的 AI；這一節的測試照新設計改，細節在 t42-exits.test.ts）
// 對外請求全部是假的：價格、成分股（固定檔）、EDGAR、Nasdaq RSS、雲端排程、LINE。
import { describe, expect, it } from 'vitest';
import { discussionPack, parseThesisBlock, pickMode, planExits, type DiscussionNumbers } from '../src/ai/discussion';
import { finalizeRun, getRun } from '../src/app/aiRuns';
import type { Env, Fetcher } from '../src/app/env';
import { runFlow, type Attempt } from '../src/app/flow';
import { LINE_PUSH_URL } from '../src/app/line';
import { fileChanges, loadAccount, saveAccount } from '../src/app/ledgerStore';
import { startOwnReview } from '../src/app/ownAi';
import { loadConditions, metaFile } from '../src/app/thesis';
import type { StateView, SnapshotForm, HoldingDetail } from '../src/app/site/views';
import type { CompanyFacts, XbrlFact } from '../src/data/edgar';
import { buildMarketView } from '../src/data/marketView';
import { loadSeries } from '../src/data/store';
import { SYSTEM_DEFAULT_PREMISES, applySnapshot, createAccount, itemAction, mapPremises, setThesis, type Account, type MarketView, type Snapshot } from '../src/engine';
import { handle } from '../src/index';
import { freshDb } from './helpers/d1';
import { cronTime, fakeFetcher, newWorld, type World } from './helpers/fakeSources';

// ---------------------------------------------------------------- 假的世界（和 T27 的測試同一套寫法）

function quarterFacts(qs: { end: string; rev: number; filed: string }[]): CompanyFacts {
  const rev: XbrlFact[] = qs.map((q) => {
    const [y, m] = q.end.split('-').map(Number);
    return { start: `${y}-${String(m - 2).padStart(2, '0')}-01`, end: q.end, val: q.rev, accn: `acc-${q.filed}`, form: '10-Q', filed: q.filed };
  });
  return { cik: 1045810, facts: { 'us-gaap': { Revenues: { units: { USD: rev } } } } };
}
const BASE = quarterFacts([
  { end: '2025-06-30', rev: 110, filed: '2025-08-01' },
  { end: '2025-09-30', rev: 120, filed: '2025-11-01' },
  { end: '2026-06-30', rev: 150, filed: '2026-08-01' },
  { end: '2026-09-30', rev: 160, filed: '2026-10-30' },
]);
const TENQ = `<html><body><p>Item 2. Management’s Discussion and Analysis</p><p>Revenue for the third quarter was $160 million. Gross margin was 60.0%, down from 70.0% a year ago.</p><p>Item 3. Quantitative</p></body></html>`;
const TENQ_FILING = { accession: '0001045810-26-000300', form: '10-Q', items: '', acceptanceDateTime: '2026-10-30T20:10:00.000Z', filingDate: '2026-10-30', primaryDocument: 'q.htm', html: TENQ };

function fetcherOf(w: World): Fetcher {
  const base = fakeFetcher(w);
  return async (url, init) => {
    if (url === LINE_PUSH_URL) return Response.json({});
    if (url === 'https://api.example/fire') return Response.json({ claude_code_session_url: 'https://claude.ai/code/x' });
    if (/data\.sec\.gov\/submissions\/CIK\d+\.json/.test(url)) {
      const f = TENQ_FILING;
      return Response.json({ cik: '1045810', name: 'NVIDIA CORP', tickers: ['NVDA'], filings: { recent: { accessionNumber: [f.accession], form: [f.form], items: [f.items], acceptanceDateTime: [f.acceptanceDateTime], filingDate: [f.filingDate], primaryDocument: [f.primaryDocument] } } });
    }
    if (/companyfacts\/CIK\d+\.json/.test(url)) return Response.json(BASE);
    const doc = /Archives\/edgar\/data\/\d+\/(\d+)\/(.+)$/.exec(url);
    if (doc) return doc[2] === 'index.json' ? Response.json({ directory: { item: [{ name: TENQ_FILING.primaryDocument }] } }) : new Response(TENQ_FILING.html);
    if (url.startsWith('https://www.nasdaq.com/feed/rssoutbound')) return new Response('<rss><channel></channel></rss>');
    return base(url, init);
  };
}

interface Ctx {
  db: D1Database;
  env: Env;
  fetcher: Fetcher;
  viewAt: (date: string) => Promise<{ view: MarketView; axis: string[] }>;
  api: <T = Record<string, unknown>>(method: 'GET' | 'POST', path: string, body?: unknown, now?: Date) => Promise<{ status: number; body: T }>;
}

const USER_PREMISES = [
  { id: 'P1', text: '資料中心需求延續到 2027', origin: 'USER' as const },
  { id: 'P2', text: '毛利率維持在 65% 以上', origin: 'USER' as const },
];

async function withWorld(fn: (c: Ctx) => Promise<void>, opt: { premises?: typeof USER_PREMISES | null; acct?: (a: Account) => Account; noAccount?: boolean } = {}) {
  const d = await freshDb();
  try {
    const db = d.db;
    const w = newWorld('2026-11-19');
    const env: Env = { DB: db, ADMIN_TOKEN: 't', AI_TASK_SECRET: 's', EDGAR_USER_AGENT: 'test bot test@example.com', SITE_URL: 'https://bot.example', LINE_CHANNEL_TOKEN: 'lt', LINE_USER_ID: 'U1', DEV_NO_AUTH: '1', ROUTINE_FIRE_URL: 'https://api.example/fire', ROUTINE_TOKEN: 'rt' };
    const fetcher = fetcherOf(w);
    const run = (date: string, attempt: Attempt = 'FIRST') => {
      w.dataDate = date;
      return runFlow(env, fetcher, { now: cronTime(date), attempt });
    };
    const viewAt = async (date: string) => buildMarketView(await loadSeries(db, ['VOO', 'SGOV', 'NVDA']), date, 'VOO');
    const api: Ctx['api'] = async (method, path, body, now = new Date('2026-11-20T02:00:00Z')) => {
      const r = await handle(new Request(`https://bot.example/api/${path}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env, fetcher, now);
      return { status: r.status, body: (await r.json()) as never };
    };
    await run('2026-11-19');
    if (!opt.noAccount) {
      const { view } = await viewAt('2026-11-19');
      let acct = createAccount(
        {
          paper: true,
          cash: 5000,
          core: { VOO: Math.floor(140_000 / view.close.VOO[view.i]) },
          own: { NVDA: { shares: Math.floor(40_000 / view.close.NVDA[view.i]), stdWeight: 0.15, premises: opt.premises === null ? structuredClone(SYSTEM_DEFAULT_PREMISES) : (opt.premises ?? USER_PREMISES) } },
        },
        view,
      );
      if (opt.acct) acct = opt.acct(acct);
      await saveAccount(db, acct, null, '建立帳戶', new Date('2026-11-19T12:00:00Z'));
    }
    await fn({ db, env, fetcher, viewAt, api });
  } finally {
    await d.dispose();
  }
}

const FILE = 'NVDA@2026-11-19';
const GM = (level: number, quarters = 1) => ({ type: 'xbrl_metric_below', metric: 'GrossMarginPct', level, quarters });
const onlyDefault = (a: Account, t: string) => a.own[t].premises.every((p) => p.origin === 'SYSTEM_DEFAULT');
const NUMS: DiscussionNumbers = { date: '2026-11-19', close: 181.23, fromHigh: -0.12, ma200: 160.5, vsMa: 0.129, slow: 'STD', ret1y: 0.42, weight: 0.062, stdWeight: 0.05, ownTotal: 0.23, ownBudget: 0.2, xbrl: null, openedHalf: null };

interface CondSeed { text: string; kind?: string; check?: Record<string, unknown>; status: string; action: string; condId?: string }
async function seed(db: D1Database, o: CondSeed): Promise<number> {
  const r = await db
    .prepare('INSERT INTO own_conditions (ticker, run_id, cond_id, direction, kind, text, check_json, tier_if_met, status, created_at, origin, file_id, accepted_at, action, auto) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind('NVDA', 'r0', o.condId ?? 'U1', 'DOWN', o.kind ?? 'XBRL', o.text, JSON.stringify(o.check ?? GM(0.58, 2)), o.action === 'REVIEW' ? null : o.action, o.status, '2026-11-19T12:00:00.000Z', 'USER', FILE, '2026-11-19T12:00:00.000Z', o.action, 1)
    .run();
  return r.meta.last_row_id;
}
const condLogs = async (db: D1Database) => (await db.prepare("SELECT body FROM own_thesis_log WHERE kind = 'CONDITION' ORDER BY id").all<{ body: string }>()).results.map((r) => JSON.parse(r.body) as { id: number; change: string; action: string | null });
const thesisLogs = async (db: D1Database) => (await db.prepare("SELECT body FROM own_thesis_log WHERE kind = 'THESIS' ORDER BY id").all<{ body: string }>()).results.map((r) => JSON.parse(r.body) as Record<string, unknown>);
async function postResult(db: D1Database, runId: string, samples: unknown[], at: Date) {
  const run = (await getRun(db, runId))!;
  const task = await db.prepare('SELECT * FROM ai_tasks WHERE id = ?').bind(run.taskId).first();
  return finalizeRun(db, task as never, { samples }, at);
}

// ---------------------------------------------------------------- 1. 買進時的一句話

describe('T40 ①：買進時的一句話不是前提（own_thesis §1.8）', () => {
  it('快照新增自選寫了一句話：存成 buyNote、這檔仍是「只有預設」、不排審查；OPEN 的紀錄帶這句話', async () => {
    await withWorld(async (c) => {
      const { view } = await c.viewAt('2026-11-19');
      const acct = (await loadAccount(c.db))!.acct;
      // 新代號 AMD：借 NVDA 的價格序列（這裡只載了這幾檔）
      const v2 = { ...view, close: { ...view.close, AMD: view.close.NVDA } };
      const lots = { own: { ...acct.lots.own, AMD: 3 }, mom: {}, core: { ...acct.lots.core } };
      const snap: Snapshot = { shares: { ...lots.own, ...lots.core }, lots, cash: acct.cash - 3 * view.close.NVDA[view.i], why: { AMD: 'AI 加速器的第二供應商' } };
      const s = applySnapshot(acct, v2, snap);
      expect(s.error).toBeUndefined();
      expect(s.acct.own.AMD.buyNote).toEqual({ text: 'AI 加速器的第二供應商', at: view.date });
      expect(onlyDefault(s.acct, 'AMD')).toBe(true);
      expect(s.acct.own.AMD.thesis).toBeNull();
      expect(s.acct.own.AMD.thesisReviewDue).toBeUndefined();
      expect(metaFile(s.acct, 'AMD', view.date)!.kind).toBe('DEFAULT_ONLY');
      // 開檔的紀錄帶這句話（只是紀錄，不是前提）
      const open = fileChanges({ NVDA: FILE }, s.acct, new Date('2026-11-19T13:00:00Z')).find((l) => l.ticker === 'AMD')!;
      expect(open.kind).toBe('OPEN');
      expect(open.body).toMatchObject({ buyNote: { text: 'AI 加速器的第二供應商' } });
      expect((open.body.premises as { origin: string }[]).every((p) => p.origin === 'SYSTEM_DEFAULT')).toBe(true);
    });
  });

  it('轉入自選、認養的理由也存成 buyNote；已經有一句話的不覆蓋', async () => {
    await withWorld(async (c) => {
      const { view } = await c.viewAt('2026-11-19');
      const acct = (await loadAccount(c.db))!.acct;
      // 已經在自選的 NVDA 再認養一次：原本的一句話不被蓋掉
      const a0 = structuredClone(acct);
      a0.own.NVDA.buyNote = { text: '第一次的理由', at: '2026-11-01' };
      a0.lots.mom.NVDA = 5;
      const n = { id: 99, date: view.date, kind: 'MONTHLY', status: 'PENDING', title: '月報', items: [{ key: 'k', f: 'F2', kind: 'STRATEGY', ticker: 'NVDA', title: 'x', choices: [{ id: 'DO', label: '照做', lines: [{ ticker: 'NVDA', bucket: 'mom', shares: -5, reason: '動能出場' }] }], choice: 'DO', ruleChoice: 'DO', actions: ['TRANSFER'] }] };
      a0.notifs.push(n as never);
      const r = itemAction(a0, view, 99, 'k', { action: 'TRANSFER', reason: '第二次的理由' });
      expect(r.notif).not.toBeNull();
      expect(r.acct.own.NVDA.buyNote).toEqual({ text: '第一次的理由', at: '2026-11-01' });
      expect(r.acct.own.NVDA.premises.map((p) => p.text)).toEqual(USER_PREMISES.map((p) => p.text)); // 前提沒有被加一條
    });
  });

  it('建立帳戶寫了「持有的原因」：存成 buyNote、仍是「只有預設」；回傳還沒有論點的自選，帳戶頁的清單列出來，關掉就不見', async () => {
    await withWorld(
      async (c) => {
        const r = await c.api<{ ok: boolean; thesisTodo: string[] }>('POST', 'account', { paper: true, cash: 5000, coreShares: 100, own: [{ ticker: 'NVDA', shares: 50, why: 'AI 訓練需求還在成長' }, { ticker: 'MSFT', shares: 10 }] });
        expect(r.status).toBe(200);
        expect(r.body.thesisTodo).toEqual(['NVDA', 'MSFT']);
        const acct = (await loadAccount(c.db))!.acct;
        expect(acct.own.NVDA.buyNote).toEqual({ text: 'AI 訓練需求還在成長', at: acct.snapshotDate });
        expect(onlyDefault(acct, 'NVDA')).toBe(true);
        expect(acct.own.MSFT.buyNote).toBeUndefined();
        // 帳戶頁的入口：兩檔都列出來（帶那一句）
        let st = (await c.api<StateView>('GET', 'state')).body;
        expect(st.thesisTodo).toEqual([
          { ticker: 'NVDA', buyNote: { text: 'AI 訓練需求還在成長', at: acct.snapshotDate } },
          { ticker: 'MSFT', buyNote: null },
        ]);
        // 持股頁「還沒有你的論點」下面顯示這句話
        const hd = (await c.api<HoldingDetail>('GET', 'holding/NVDA')).body;
        expect(hd.own).toMatchObject({ kind: 'DEFAULT_ONLY', buyNote: { text: 'AI 訓練需求還在成長' } });
        // 寫了 MSFT 的論點 → MSFT 不再列
        const saved = await c.api('POST', 'ops/own-thesis', { ticker: 'MSFT', thesis: '雲端與軟體的訂閱收入', premises: [{ text: 'Azure 年增率維持兩位數' }], exitConditions: [], source: 'TYPED' });
        expect(saved.status).toBe(200);
        st = (await c.api<StateView>('GET', 'state')).body;
        expect(st.thesisTodo.map((x) => x.ticker)).toEqual(['NVDA']);
        // 關掉這張清單 → 入口不見
        expect((await c.api('POST', 'ops/thesis-todo/dismiss', {})).status).toBe(200);
        st = (await c.api<StateView>('GET', 'state')).body;
        expect(st.thesisTodo).toEqual([]);
      },
      { noAccount: true },
    );
  });

  it('快照（網站 API）：新加進自選、還沒有論點的列在結果（newOwn）並加進帳戶頁的清單；原本就在自選的不列', async () => {
    await withWorld(async (c) => {
      const form = (await c.api<SnapshotForm>('GET', 'snapshot/form')).body;
      const lots: Record<'own' | 'mom' | 'core', Record<string, number>> = { own: {}, mom: {}, core: {} };
      for (const b of ['own', 'mom', 'core'] as const) for (const r of form.buckets[b]) lots[b][r.ticker] = r.expected;
      lots.own.ORCL = 2;
      const r = await c.api<{ newOwn: string[] }>('POST', 'snapshot', { lots, cash: form.cashBook, why: { ORCL: '雲端資料庫訂單成長' } });
      expect(r.status).toBe(200);
      expect(r.body.newOwn).toEqual(['ORCL']);
      const acct = (await loadAccount(c.db))!.acct;
      expect(acct.own.ORCL.buyNote).toEqual({ text: '雲端資料庫訂單成長', at: '2026-11-19' });
      expect(onlyDefault(acct, 'ORCL')).toBe(true);
      expect(acct.thesisTodo).toEqual(['ORCL']);
      const st = (await c.api<StateView>('GET', 'state')).body;
      expect(st.thesisTodo).toEqual([{ ticker: 'ORCL', buyNote: { text: '雲端資料庫訂單成長', at: '2026-11-19' } }]);
    });
  });

  it('討論包：只有預設、有買進時的一句話 → NEW，帶「我買進時的想法」並從這句話問起；沒有那句話照舊先問為什麼買', async () => {
    await withWorld(
      async (c) => {
        const r = await c.api<{ text: string; mode: string }>('GET', 'own/NVDA/discussion');
        expect(r.body.mode).toBe('NEW');
        const t = r.body.text;
        expect(t).toContain('## 我買進時的想法');
        expect(t).toContain('這是我買的時候隨手寫的一句話，不一定對，也不是論點；請拿來當開場，不要當成已經成立的前提。');
        expect(t).toContain('「AI 訓練需求還在成長」（2026-11-10 寫的）');
        expect(t).toContain('請從那句話問起');
        expect(t).not.toContain('請先問我 3 個問題');
        // 這一節在「這次為什麼討論」之後、「我的論點」之前
        expect(t.indexOf('## 這次為什麼討論')).toBeLessThan(t.indexOf('## 我買進時的想法'));
        expect(t.indexOf('## 我買進時的想法')).toBeLessThan(t.indexOf('## 我的論點'));
      },
      { premises: null, acct: (a) => ({ ...a, own: { ...a.own, NVDA: { ...a.own.NVDA, buyNote: { text: 'AI 訓練需求還在成長', at: '2026-11-10' } } } }) },
    );
    // 沒有那句話：照舊先問 3 個問題，也沒有那一節
    const file = metaFile({ own: { NVDA: { premises: structuredClone(SYSTEM_DEFAULT_PREMISES), thesis: null, fileId: FILE, origin: 'NEW', flags: [] } as never } }, 'NVDA', '2026-11-19')!;
    expect(pickMode(file)).toBe('NEW');
    const t = discussionPack(file, NUMS, 'NEW');
    expect(t).toContain('請先問我 3 個問題');
    expect(t).not.toContain('## 我買進時的想法');
  });

  it('L2 的證據包不帶這句話（定期審查只看論點與前提）', async () => {
    await withWorld(
      async (c) => {
        const { view, axis } = await c.viewAt('2026-11-19');
        const acct = (await loadAccount(c.db))!.acct;
        expect(acct.own.NVDA.buyNote?.text).toBe('獨家的買進理由句子');
        const run = await startOwnReview(c.env, c.fetcher, acct, view, axis, 'NVDA', 'MANUAL', new Date('2026-11-20T01:00:00Z'));
        expect(JSON.stringify(run.pack)).not.toContain('獨家的買進理由句子');
        expect(run.pack.premises.every((p) => SYSTEM_DEFAULT_PREMISES.some((d) => d.text === p.text))).toBe(true);
      },
      { premises: null, acct: (a) => ({ ...a, own: { ...a.own, NVDA: { ...a.own.NVDA, buyNote: { text: '獨家的買進理由句子', at: '2026-11-19' } } } }) },
    );
  });
});

// ---------------------------------------------------------------- 2. 前提帶編號

describe('T40 ②：前提在討論包與貼回之間帶編號（own_thesis §1.7、§1.8）', () => {
  it('討論包的前提寫成「P2. …」；固定指示要沒改的前提照抄並保留編號（T42：出場條件不再帶 C 編號，區塊標記 v3）', async () => {
    await withWorld(async (c) => {
      const id = await seed(c.db, { text: '毛利率連兩季低於 58%', status: 'ACTIVE', action: 'EXIT' });
      const t = (await c.api<{ text: string }>('GET', 'own/NVDA/discussion')).body.text;
      expect(t).toContain('P2. 毛利率維持在 65% 以上');
      expect(t).toContain('- 毛利率連兩季低於 58% → 出清');
      expect(t).not.toContain(`C${id}.`);
      expect(t).toContain('沒改的前提照抄原文並保留編號，例如 `1. [P2] …`；');
      expect(t).toContain('意思改了就不要寫編號，寫成新的一條');
      expect(t).toContain('1. [P2] （沒改的前提：照抄原文，保留編號）');
      expect(t).toContain('===STOCKBOT 論點 v3 NVDA===');
    });
  });

  it('解析：行首的 [P2] 讀成沿用的編號；v2 區塊出場條件的 [C12] 只去掉標記（T42：不讀編號）；舊的 v1 區塊照收', () => {
    const v2 = ['===STOCKBOT 論點 v2 NVDA===', '論點：', '一句話', '前提：', '1. [P2] 毛利率維持在 60% 以上', '2. ［P1］資料中心需求延續到 2027', '3. 新的一條', '出場條件：', '1. [C12] 毛利率連兩季低於 58% → 出清', '2. 新的條件 → 減半', '這次的結論：維持', '理由：x', '===END==='].join('\n');
    const p = parseThesisBlock(v2, 'NVDA');
    expect(p.found).toBe(true);
    expect(p.premises).toEqual(['毛利率維持在 60% 以上', '資料中心需求延續到 2027', '新的一條']);
    expect(p.premiseIds).toEqual(['P2', 'P1', null]);
    expect(p.exits).toEqual([
      { text: '毛利率連兩季低於 58%', action: 'EXIT', guessed: false },
      { text: '新的條件', action: 'HALF', guessed: false },
    ]);
    const v1 = parseThesisBlock(['===STOCKBOT 論點 v1 NVDA===', '論點：', 'x', '前提：', '1. 舊格式的前提', '===END==='].join('\n'), 'NVDA');
    expect(v1).toMatchObject({ found: true, premises: ['舊格式的前提'], premiseIds: [null] });
  });

  it('沿用編號但字改了：預覽列成「沿用，但字改了」（左舊右新）、存檔後排論點變動後的審查；只改標點或空白的不排', async () => {
    await withWorld(async (c) => {
      // 只改標點與空白：P1、P2 都沿用，沒有字改了，不排審查
      const punct = { ticker: 'NVDA', thesis: '論點', premises: [{ id: 'P1', text: '資料中心需求延續到 2027。' }, { id: 'P2', text: '毛利率 維持在 65% 以上！' }], exitConditions: [], source: 'DISCUSSION' };
      type Pv = { preview: { kept: { id: string }[]; added: unknown[]; retired: unknown[]; edited: { id: string; before: string; after: string }[]; changed: boolean } };
      const d1 = await c.api<Pv>('POST', 'ops/own-thesis', { ...punct, dry: true });
      expect(d1.body.preview).toMatchObject({ kept: [{ id: 'P1' }, { id: 'P2' }], added: [], retired: [], edited: [], changed: false });
      expect((await c.api('POST', 'ops/own-thesis', punct)).status).toBe(200);
      let acct = (await loadAccount(c.db))!.acct;
      expect(acct.own.NVDA.thesisReviewDue ?? null).toBeNull();
      // 貼回的 [P2] 改了字：沿用 P2、但記成字改了 → 排審查
      const parsed = parseThesisBlock(['===STOCKBOT 論點 v2 NVDA===', '論點：', '論點', '前提：', '1. [P1] 資料中心需求延續到 2027', '2. [P2] 毛利率維持在 60% 以上', '===END==='].join('\n'), 'NVDA');
      const body = { ticker: 'NVDA', thesis: parsed.thesis, premises: parsed.premises.map((text, k) => ({ id: parsed.premiseIds[k], text })), exitConditions: [], source: 'DISCUSSION' };
      const d2 = await c.api<Pv>('POST', 'ops/own-thesis', { ...body, dry: true });
      expect(d2.body.preview).toMatchObject({ kept: [{ id: 'P1' }, { id: 'P2' }], added: [], retired: [], changed: true });
      expect(d2.body.preview.edited).toEqual([{ id: 'P2', before: '毛利率 維持在 65% 以上！', after: '毛利率維持在 60% 以上' }]);
      expect((await c.api('POST', 'ops/own-thesis', body)).status).toBe(200);
      acct = (await loadAccount(c.db))!.acct;
      expect(acct.own.NVDA.premises.map((p) => [p.id, p.text])).toEqual([
        ['P1', '資料中心需求延續到 2027'],
        ['P2', '毛利率維持在 60% 以上'],
      ]);
      expect(acct.own.NVDA.thesisReviewDue).toBe('2026-11-19');
      // 「當成新的一條」＝不帶編號送：發新編號、舊的 P2 撤下
      const d3 = await c.api<Pv>('POST', 'ops/own-thesis', { ...body, premises: [{ id: 'P1', text: '資料中心需求延續到 2027' }, { id: null, text: '毛利率維持在 55% 以上' }], dry: true });
      expect(d3.body.preview).toMatchObject({ kept: [{ id: 'P1' }], added: [{ id: 'P3' }], retired: [{ id: 'P2' }], edited: [] });
    });
  });

  it('mapPremises／setThesis：帶 id 但字改了記在 edited、算論點變動；只差標點不算', () => {
    const meta = { premises: [{ id: 'P1', text: '資料中心需求延續到 2027', origin: 'USER' as const }], premiseSeq: 2 };
    expect(mapPremises(meta, [{ id: 'P1', text: '資料中心需求延續到 2028' }], '2026-11-20').edited).toEqual([{ id: 'P1', before: '資料中心需求延續到 2027', after: '資料中心需求延續到 2028' }]);
    expect(mapPremises(meta, [{ id: 'P1', text: '資料中心需求，延續到 2027' }], '2026-11-20').edited).toEqual([]);
    const acct = { own: { NVDA: { ...meta, thesis: null } } } as unknown as Account;
    expect(setThesis(acct, 'NVDA', { text: 't', source: 'TYPED', premises: [{ id: 'P1', text: '資料中心需求延續到 2028' }], date: '2026-11-20' })).toMatchObject({ changed: true, acct: { own: { NVDA: { thesisReviewDue: '2026-11-20' } } } });
    expect(setThesis(acct, 'NVDA', { text: 't', source: 'TYPED', premises: [{ id: 'P1', text: '資料中心需求延續到 2027。' }], date: '2026-11-20' }).changed).toBe(false);
  });
});

// ---------------------------------------------------------------- 3. 出場條件的對照（T42 起：整組取代）

describe('T40 ③：出場條件的對照（own_thesis §1.8；T42 改成整組取代）', () => {
  it('planExits（取代 matchExits）：每一條都對到監測中的、條數相同 → 沒改動（動作不同另列）；改字、多一條、少一條 → 有改動', () => {
    const live = [
      { id: 7, text: '毛利率連兩季低於 58%', action: 'EXIT' as const, status: '監測中' },
      { id: 8, text: '公司在 8-K 下修全年財測', action: 'HALF' as const, status: '監測中' },
      { id: 9, text: '收盤跌破 100', action: 'REVIEW' as const, status: '只記錄' },
    ];
    const same = planExits(
      [
        { text: '收盤跌破 100。', action: 'REVIEW' },
        { text: '毛利率 連兩季低於 58%', action: 'EXIT' },
        { text: '公司在 8-K 下修全年財測', action: 'EXIT' },
      ],
      live,
    );
    expect(same.changed).toBe(false);
    expect(same.actionChanged.map((a) => [a.index, a.id, a.was, a.action])).toEqual([[2, 8, 'HALF', 'EXIT']]);
    expect(same.sameByText).toEqual({ 0: 9, 1: 7, 2: 8 });
    // 少一條、改字、多一條：都是有改動
    expect(planExits([{ text: '毛利率連兩季低於 58%', action: 'EXIT' }, { text: '公司在 8-K 下修全年財測', action: 'HALF' }], live).changed).toBe(true);
    expect(planExits([...live.slice(0, 2).map((c) => ({ text: c.text, action: c.action })), { text: '收盤跌破 90', action: 'REVIEW' as const }], live)).toMatchObject({ changed: true, sameByText: { 0: 7, 1: 8 } });
    expect(planExits([...live.map((c) => ({ text: c.text, action: c.action })), { text: '執行長離職', action: 'REVIEW' as const }], live).changed).toBe(true);
    expect(planExits([], []).changed).toBe(false);
  });

  it('出場條件沒改動（預填的監測中條件原樣送回）→ 不送改寫、條件不動；只改動作 → 存檔時直接改動作（log CONDITION ACTION_CHANGED）', async () => {
    await withWorld(async (c) => {
      const gm = await seed(c.db, { text: '毛利率連兩季低於 58%', status: 'ACTIVE', action: 'EXIT', condId: 'U1' });
      const ev = await seed(c.db, { text: '公司在 8-K 下修全年財測', kind: 'EVENT', check: { type: 'event', confirm_by: ['8-K'] }, status: 'ACTIVE', action: 'HALF', condId: 'U2' });
      const base = { ticker: 'NVDA', thesis: '論點', premises: USER_PREMISES.map((p) => ({ id: p.id, text: p.text })), source: 'DISCUSSION' };
      type Ex = { preview: { exits: { changed: boolean; live: number; actionChanged: { id: number }[] } } };
      const exits1 = [
        { text: '毛利率連兩季低於 58%', action: 'EXIT' },
        { text: '公司在 8-K 下修全年財測', action: 'HALF' },
      ];
      const dry = await c.api<Ex>('POST', 'ops/own-thesis', { ...base, exitConditions: exits1, dry: true });
      expect(dry.body.preview.exits).toMatchObject({ changed: false, live: 2, actionChanged: [] });
      const s1 = await c.api<{ rewrite: { status: string }; exits: unknown[] }>('POST', 'ops/own-thesis', { ...base, exitConditions: exits1 });
      expect(s1.status).toBe(200);
      expect(s1.body.rewrite.status).toBe('NONE');
      expect(s1.body.exits).toEqual([]);
      expect((await thesisLogs(c.db)).at(-1)).toMatchObject({ exitsChanged: false, exitLines: [] });
      // 毛利率那一條成立時改成減半：直接改動作
      const s2 = await c.api<{ rewrite: { status: string }; conds: { actionChanged: number[]; errors: string[] } }>('POST', 'ops/own-thesis', { ...base, exitConditions: [{ text: '毛利率連兩季低於 58%', action: 'HALF' }, exits1[1]] });
      expect(s2.body.rewrite.status).toBe('NONE');
      expect(s2.body.conds).toEqual({ actionChanged: [gm], errors: [] });
      const conds = await loadConditions(c.db, 'NVDA');
      expect(conds.find((x) => x.id === gm)).toMatchObject({ status: 'ACTIVE', action: 'HALF' });
      expect(conds.find((x) => x.id === ev)).toMatchObject({ status: 'ACTIVE', action: 'HALF' });
      expect(await condLogs(c.db)).toEqual([{ id: gm, change: 'ACTION_CHANGED', action: 'HALF', by: 'USER' }]);
    });
  });

  it('改寫帶 supersedes：持股頁列「會取代：…」；確認時新的開始監測、舊的撤下（同一套取代流程）', async () => {
    await withWorld(async (c) => {
      const old = await seed(c.db, { text: '毛利率連兩季低於 58%', status: 'ACTIVE', action: 'EXIT', condId: 'U1' });
      const base = { ticker: 'NVDA', thesis: '論點', premises: USER_PREMISES.map((p) => ({ id: p.id, text: p.text })), source: 'DISCUSSION' };
      // 門檻改了：整組（這一條）連同監測中的條件送去改寫；確認之前舊的照舊監測
      const s = await c.api<{ rewrite: { status: string; runId: string } }>('POST', 'ops/own-thesis', { ...base, exitConditions: [{ text: '毛利率連兩季低於 55%', action: 'EXIT' }] });
      expect(s.body.rewrite.status).toBe('SENT');
      const run = (await getRun(c.db, s.body.rewrite.runId))!;
      expect(run.pack.prompt_version).toBe('own_check_v6'); // T53：可以指名網頁來源（v5）
      expect(run.pack.question).toContain('supersedes');
      expect((run.pack.rule.detail as { condMap: Record<string, number> }).condMap).toEqual({ C1: old });
      expect(run.pack.facts.find((f) => f.id === 'C1')!.value).toBe('毛利率連兩季低於 58%');
      const price = run.pack.documents.find((d) => d.source_id === 'price:NVDA')!;
      await postResult(
        c.db,
        run.runId,
        [
          {
            run_id: run.runId,
            verdict: 'DONE',
            evidence: [{ id: 'E1', source_id: 'price:NVDA', date: price.date, quote: price.text.split('\n').at(-1)!, claim: '最新收盤' }],
            payload: { conditions: [{ id: 'C1', line: 'U1', supersedes: 'C1', direction: 'DOWN', kind: 'XBRL', text: '毛利率連兩季低於 55%', check: GM(0.55, 2), basis: ['E1'], tier_if_met: 'EXIT' }] },
            report: '改寫了一條，更新 C1 的門檻。',
          },
        ],
        new Date('2026-11-20T02:10:00Z'),
      );
      type Rw = { rewrites: { results: { runId: string; replaces: Record<string, string>; retire: unknown[]; conditions: { condId: string; supersedes: number | null }[] }[] } };
      const h = await c.api<Rw>('GET', 'holding/NVDA', undefined, new Date('2026-11-20T03:00:00Z'));
      expect(h.body.rewrites.results[0].conditions[0]).toMatchObject({ condId: 'U1', supersedes: old });
      expect(h.body.rewrites.results[0].replaces).toEqual({ U1: '毛利率連兩季低於 58%' });
      expect(h.body.rewrites.results[0].retire).toEqual([]); // 被取代的不算「沒提到」
      expect((await loadConditions(c.db, 'NVDA')).find((x) => x.id === old)!.status).toBe('ACTIVE'); // 確認之前照舊監測
      // 確認（勾新的）→ 舊的 RETIRED（寫明被哪一條取代），新的一列記 supersedes
      const acc = await c.api<{ added: number; retired: number[] }>('POST', 'ops/own-conditions', { ticker: 'NVDA', runId: run.runId, ids: ['U1'] }, new Date('2026-11-20T03:05:00Z'));
      expect(acc.body).toMatchObject({ added: 1, retired: [old] });
      const conds = await loadConditions(c.db, 'NVDA');
      const o = conds.find((x) => x.id === old)!;
      expect(o.status).toBe('RETIRED');
      expect(o.note).toContain('「毛利率連兩季低於 55%」取代');
      const fresh = conds.find((x) => x.text === '毛利率連兩季低於 55%')!;
      expect(fresh).toMatchObject({ status: 'ACTIVE', origin: 'USER', action: 'EXIT', supersedes: old });
      expect((await condLogs(c.db)).map((l) => [l.id, l.change])).toEqual([
        [fresh.id, 'ACCEPTED'],
        [old, 'RETIRED'],
      ]);
    });
  });
});
