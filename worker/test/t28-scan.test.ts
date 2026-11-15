// T28：每日掃描的補強（own_thesis_design_2026-11-15 §2.1～§2.3、§2.5、§2.6；問題 S1～S6、M2）。
//   ① 事件的類別與細項：sec_events.detail_code；8-K Item 編號（1.05、2.04、3.01…）、13D、5.02 的執行長與財務長離任由規則記下
//   ② event_scan_v2：每筆多一個 sub（不在列舉內的拿掉）；條件清單是觀察項與「只在審查時檢查」的條件；標到條件寫 CONDITION_HINT
//   ③ 標記分開（scan8k、news 記時間）；由舊到新、一次最多 10 份原文；有合格結論才往前推；失敗次數
//   ④ 01:30 重掃當天沒有結論的掃描；連續 2 次失敗推 SCAN_FAILED；AI 紀錄顯示「掃描失敗，下一次重掃」
//   ⑤ 條件確認（F25）最多 8 份，超過記 F25_OVERFLOW
// 5.02 的原文用 test/fixtures/edgar-502 的真實申報（見那裡的 index.json）；其他申報、新聞、雲端排程、LINE 都是假的。
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { listRuns, type AiRun } from '../src/app/aiRuns';
import type { Env, Fetcher } from '../src/app/env';
import { SCAN_FAILS, loadScanFails, newsCursorMs, pendingScanFilings, scanBase, scanFailText } from '../src/app/events';
import { loadEvents } from '../src/app/filings';
import { getFlowState, runFlow } from '../src/app/flow';
import { LINE_PUSH_URL } from '../src/app/line';
import { loadAccount, saveAccount } from '../src/app/ledgerStore';
import { F25_MAX_FILINGS } from '../src/app/ownAi';
import type { Attempt } from '../src/app/schedule';
import { SCAN_FAILED_TEXT, runRow } from '../src/app/site/aiViews';
import { judge, type EvidencePack, type Outcome } from '../src/ai/check';
import { EVENT_SCAN_PROMPT, SCAN_SUBS, scanEvents, scanQualified } from '../src/ai/events';
import { PAYLOAD_HOOKS } from '../src/ai/hooks';
import { buildMarketView } from '../src/data/marketView';
import { ADVANCE_DETAILS, classify502, eventHits, isAdvanceable, quickHits, SCAN_ITEMS } from '../src/data/secEvents';
import type { Filing } from '../src/data/sources';
import { loadConstituents, loadSeries } from '../src/data/store';
import { createAccount } from '../src/engine';
import { handle } from '../src/index';
import { freshDb } from './helpers/d1';
import { fakeFetcher, newWorld, type World } from './helpers/fakeSources';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX502 = join(HERE, 'fixtures', 'edgar-502');
const fixture = (f: string) => readFileSync(join(FIX502, f), 'utf8');

// ---------------------------------------------------------------- 假的 EDGAR、新聞、雲端排程、LINE

interface FakeFiling {
  accession: string;
  form: string;
  items: string;
  acceptanceDateTime: string;
  filingDate: string;
  primaryDocument: string;
  html: string;
}
interface Net {
  cos: Map<number, { name: string; filings: FakeFiling[] }>;
  /** 每檔的新聞標題（發布時間、標題）。 */
  news: Record<string, { at: string; title: string }[]>;
  fired: string[];
  line: string[];
}

function fetcherOf(w: World, net: Net): Fetcher {
  const base = fakeFetcher(w);
  const findFiling = (acc: string) => [...net.cos.values()].flatMap((c) => c.filings).find((f) => f.accession.replace(/-/g, '') === acc);
  return async (url, init) => {
    if (url === LINE_PUSH_URL) {
      net.line.push((JSON.parse(String(init?.body)) as { messages: { text: string }[] }).messages[0].text);
      return Response.json({});
    }
    if (url === 'https://api.example/fire') {
      net.fired.push(String(init?.body));
      return Response.json({ claude_code_session_url: 'https://claude.ai/code/x' });
    }
    const sub = /data\.sec\.gov\/submissions\/CIK(\d+)\.json/.exec(url);
    if (sub) {
      const co = net.cos.get(Number(sub[1])) ?? { name: 'SOME CORP', filings: [] };
      const fs = [...co.filings].reverse();
      return Response.json({ cik: sub[1], name: co.name, tickers: [], sic: '3674', formerNames: [], filings: { recent: { accessionNumber: fs.map((f) => f.accession), form: fs.map((f) => f.form), items: fs.map((f) => f.items), acceptanceDateTime: fs.map((f) => f.acceptanceDateTime), filingDate: fs.map((f) => f.filingDate), primaryDocument: fs.map((f) => f.primaryDocument) } } });
    }
    if (/companyfacts\/CIK\d+\.json/.test(url)) return Response.json({ cik: 1, facts: {} });
    if (/companyconcept\//.test(url)) return new Response('nf', { status: 404 });
    const doc = /Archives\/edgar\/data\/\d+\/(\d+)\/(.+)$/.exec(url);
    if (doc) {
      const f = findFiling(doc[1]);
      if (!f) return new Response('nf', { status: 404 });
      if (doc[2] === 'index.json') return Response.json({ directory: { item: [{ name: f.primaryDocument }] } });
      return new Response(f.html);
    }
    const rss = /nasdaq\.com\/feed\/rssoutbound\?symbol=([^&]+)/.exec(url);
    if (rss) {
      const items = (net.news[decodeURIComponent(rss[1])] ?? []).map((h) => `<item><title>${h.title}</title><link>https://n/${encodeURIComponent(h.title)}</link><pubDate>${new Date(h.at).toUTCString()}</pubDate></item>`);
      return new Response(`<rss><channel>${items.join('')}</channel></rss>`);
    }
    return base(url, init);
  };
}

/** 各排程的時間：23:30 收盤後、兩小時後 01:30、再兩小時後 03:30（UTC）。 */
const slotTime = (date: string, attempt: Attempt) => new Date(Date.parse(date + 'T23:30:00Z') + { FIRST: 0, MANUAL: 0, FINAL: 2, APPLY: 4 }[attempt] * 3600_000);

interface Ctx {
  db: D1Database;
  env: Env;
  net: Net;
  cik: (t: string) => number;
  run: (date: string, attempt?: Attempt) => ReturnType<typeof runFlow>;
}

async function withWorld(fn: (c: Ctx) => Promise<void>, opt: { mom?: string[]; before?: (db: D1Database, fileId: string) => Promise<void> } = {}) {
  const d = await freshDb();
  try {
    const db = d.db;
    const w = newWorld('2026-11-19');
    const net: Net = { cos: new Map(), news: {}, fired: [], line: [] };
    const env: Env = { DB: db, ADMIN_TOKEN: 't', AI_TASK_SECRET: 's', EDGAR_USER_AGENT: 'test bot test@example.com', SITE_URL: 'https://bot.example', LINE_CHANNEL_TOKEN: 'lt', LINE_USER_ID: 'U1', ROUTINE_FIRE_URL: 'https://api.example/fire', ROUTINE_TOKEN: 'rt' };
    const fetcher = fetcherOf(w, net);
    const run = (date: string, attempt: Attempt = 'FIRST') => {
      w.dataDate = date;
      return runFlow(env, fetcher, { now: slotTime(date, attempt), attempt });
    };
    await run('2026-11-19');
    const members = (await loadConstituents(db))!;
    const cik = (t: string) => Number(members.holdings.find((h) => h[0] === t)![2]);
    const tickers = ['VOO', 'SGOV', 'NVDA', ...(opt.mom ?? [])];
    const { view } = buildMarketView(await loadSeries(db, tickers), '2026-11-19', 'VOO');
    const acct = createAccount(
      {
        paper: true,
        cash: 5000,
        core: { VOO: Math.floor(140_000 / view.close.VOO[view.i]) },
        mom: Object.fromEntries((opt.mom ?? []).map((t) => [t, Math.floor(8000 / view.close[t][view.i])])),
        own: { NVDA: { shares: Math.floor(40_000 / view.close.NVDA[view.i]), stdWeight: 0.15, premises: [{ id: 'P1', text: '資料中心需求延續到 2027', origin: 'USER' }] } },
      },
      view,
    );
    await saveAccount(db, acct, null, '建立帳戶', new Date('2026-11-19T12:00:00Z'));
    if (opt.before) await opt.before(db, (await loadAccount(db))!.acct.own.NVDA.fileId!);
    // 之前就有的申報（11-20 第一次看申報只記下最新的一筆，不追溯）
    addFiling(net, cik('NVDA'), { accession: '0001045810-26-000300', form: '10-Q', items: '', acceptanceDateTime: '2026-10-30T20:10:00.000Z', filingDate: '2026-10-30', primaryDocument: 'q.htm', html: '<p>10-Q</p>' });
    await fn({ db, env, net, cik, run });
  } finally {
    await d.dispose();
  }
}

function addFiling(net: Net, cik: number, f: FakeFiling) {
  const co = net.cos.get(cik) ?? { name: 'NVIDIA CORP', filings: [] };
  co.filings.push(f);
  net.cos.set(cik, co);
}

/** 一份 8-K（申報編號 0001045810-26-000<n>；接受時間 <date>T21:<mm>）。 */
const eightK = (n: number, date: string, items: string, html: string, form = '8-K'): FakeFiling => ({
  accession: `0001045810-26-000${n}`,
  form,
  items,
  acceptanceDateTime: `${date}T21:${String(n % 60).padStart(2, '0')}:00.000Z`,
  filingDate: date,
  primaryDocument: `d${n}.htm`,
  html,
});
const OTHER_801 = (what: string) => `<html><body><p>Item 8.01 Other Events.</p><p>${what}</p></body></html>`;

const scanRuns = async (db: D1Database): Promise<AiRun[]> => (await listRuns(db, new Date('2026-11-01T00:00:00Z'), { limit: 500 })).filter((r) => r.fn === 'EVENT_SCAN').reverse();
const postResult = (env: Env, run: AiRun, samples: unknown[], at: Date) =>
  handle(new Request(`https://bot.example/ai/task/${run.taskId}/result`, { method: 'POST', headers: { Authorization: 'Bearer s' }, body: JSON.stringify({ task_id: run.taskId, kind: 'RUN', run_id: run.runId, samples }) }), env, async () => new Response('no net', { status: 599 }), at);
const nothing = (run: AiRun) => ({ run_id: run.pack.run_id, verdict: 'NOTHING', evidence: [], payload: { events: [] }, report: '沒有值得標的事。' });
const sources = (run: AiRun) => run.pack.documents.map((d) => d.source_id);
const eventRows = async (db: D1Database, ticker: string) => (await loadEvents(db, { ticker })).map((e) => ({ code: e.code, detail: e.detail_code ?? null, sub: e.sub, status: e.status, byRule: e.by_rule, accession: e.accession }));

// ---------------------------------------------------------------- ① 規則：細項、Item 編號、13D、5.02

describe('規則分類：事件的類別與細項', () => {
  it('classify502 用真實的 5.02：執行長、財務長離任記下；董事、事業部執行長、經歷、聘用條款不算', () => {
    const idx = JSON.parse(fixture('index.json')) as { files: { file: string; expect: { ceo: boolean; cfo: boolean }; why: string }[] };
    expect(idx.files.length).toBeGreaterThanOrEqual(10);
    for (const f of idx.files) expect({ file: f.file, ...classify502(fixture(f.file)) }).toEqual({ file: f.file, ...f.expect });
    // 至少各有一份成立與不成立
    expect(idx.files.some((f) => f.expect.ceo)).toBe(true);
    expect(idx.files.some((f) => f.expect.cfo)).toBe(true);
    expect(idx.files.filter((f) => !f.expect.ceo && !f.expect.cfo).length).toBeGreaterThanOrEqual(5);
    // 沒有 5.02 那一節就不判
    expect(classify502('The Chief Executive Officer resigned.')).toEqual({ ceo: false, cfo: false });
  });

  it('一般董事異動不是可提前的細項；可提前的只有 §2.2 標「是」的那幾種', () => {
    expect(classify502(fixture('intc-2024-08-22.txt'))).toEqual({ ceo: false, cfo: false });
    expect(classify502(fixture('nke-2025-06-18.txt'))).toEqual({ ceo: false, cfo: false });
    expect(isAdvanceable('MGMT_CHANGE', 'DIRECTOR')).toBe(false);
    expect(isAdvanceable('MGMT_CHANGE', 'EXEC_APPOINT')).toBe(false);
    expect(isAdvanceable('MGMT_CHANGE', 'OTHER_EXEC')).toBe(false);
    expect(isAdvanceable('MAJOR_CONTRACT', 'NEW')).toBe(false);
    expect(isAdvanceable('MGMT_CHANGE', null)).toBe(false);
    expect(isAdvanceable('MGMT_CHANGE', 'CEO_DEPART')).toBe(true);
    expect(isAdvanceable('GUIDANCE_CUT', 'WITHDRAWN')).toBe(true);
    expect(Object.keys(ADVANCE_DETAILS).sort()).toEqual(['CYBER', 'DISTRESS', 'GUIDANCE_CUT', 'MAJOR_CONTRACT', 'MGMT_CHANGE', 'RESTRUCTURING']);
  });

  it('Item 編號對照（1.02、1.03、1.05、2.04、2.05、2.06、3.01）與 13D；1.05、2.04、3.01 不交給 Haiku；動能進場的 quickHits 不變', () => {
    const F = (form: string, items: string[]): Filing => ({ accession: '0000000001-26-000001', form, items, filingDate: '2026-11-23', acceptedAt: '2026-11-23T21:00:00.000Z', primaryDocument: 'x.htm' }) as Filing;
    const got = (f: Filing) => eventHits(f).map((h) => [h.code, h.detailCode, h.sub]);
    expect(got(F('8-K', ['1.02']))).toEqual([['MAJOR_CONTRACT', 'TERMINATION', '8K_1.02']]);
    expect(got(F('8-K', ['1.03']))).toEqual([['DISTRESS', 'BANKRUPTCY', '8K_1.03']]);
    expect(got(F('8-K', ['1.05', '9.01']))).toEqual([['CYBER', 'INCIDENT', '8K_1.05']]);
    expect(got(F('8-K', ['2.04']))).toEqual([['DISTRESS', 'ACCELERATION', '8K_2.04']]);
    expect(got(F('8-K', ['2.05', '2.06']))).toEqual([['RESTRUCTURING', 'EXIT_PLAN', '8K_2.05'], ['RESTRUCTURING', 'IMPAIRMENT', '8K_2.06']]);
    expect(got(F('8-K/A', ['3.01']))).toEqual([['DISTRESS', 'DELISTING_NOTICE', '8K_3.01']]);
    expect(got(F('8-K', ['8.01']))).toEqual([]);
    // 13D：EDGAR 2024-12 起叫 SCHEDULE 13D（2026-11-15 抓 Intel、Nike 的申報清單確認：新的是 SCHEDULE 13G／13G/A，舊的是 SC 13D/A）
    expect(got(F('SCHEDULE 13D', []))).toEqual([['ACTIVIST', 'SC_13D', 'SC_13D']]);
    expect(got(F('SC 13D', []))).toEqual([['ACTIVIST', 'SC_13D', 'SC_13D']]);
    expect(got(F('SCHEDULE 13D/A', []))).toEqual([]);
    expect(got(F('SC 13D/A', []))).toEqual([]);
    expect(got(F('SCHEDULE 13G', []))).toEqual([]);
    expect(eventHits(F('SCHEDULE 13D', []))[0].displayOnly).toBe(true);
    for (const i of ['1.05', '2.04', '3.01']) expect(SCAN_ITEMS).not.toContain(i);
    for (const i of ['1.02', '1.03', '2.05', '2.06', '5.02']) expect(SCAN_ITEMS).toContain(i);
    // 動能進場的規則偵測（quickHits）沒有加這些（T32b 再看）
    expect(quickHits(F('8-K', ['1.05', '2.04', '3.01']))).toEqual([]);
  });

  it('流程：1.05、2.04、3.01 由規則記下（自選 NEW、動能 INFO）；13D 記成 ACTIVIST（只記錄）；13G、13D/A 不記', async () => {
    await withWorld(
      async ({ db, net, cik, run }) => {
        // AAPL 之前就有的申報（第一次看只記下最新的一筆）
        addFiling(net, cik('AAPL'), { accession: '0000320193-26-000100', form: '10-Q', items: '', acceptanceDateTime: '2026-10-30T20:00:00.000Z', filingDate: '2026-10-30', primaryDocument: 'q.htm', html: '<p>10-Q</p>' });
        await run('2026-11-20');
        addFiling(net, cik('NVDA'), eightK(501, '2026-11-23', '1.05,9.01', '<p>Item 1.05 Material Cybersecurity Incidents.</p>'));
        addFiling(net, cik('NVDA'), eightK(502, '2026-11-23', '2.04', '<p>Item 2.04 Triggering Events That Accelerate a Direct Financial Obligation.</p>'));
        addFiling(net, cik('NVDA'), eightK(503, '2026-11-23', '3.01', '<p>Item 3.01 Notice of Delisting.</p>'));
        addFiling(net, cik('NVDA'), eightK(504, '2026-11-23', '', '<p>Schedule 13D</p>', 'SCHEDULE 13D'));
        addFiling(net, cik('NVDA'), eightK(505, '2026-11-23', '', '<p>Schedule 13G</p>', 'SCHEDULE 13G'));
        addFiling(net, cik('NVDA'), eightK(506, '2026-11-23', '', '<p>Schedule 13D/A</p>', 'SCHEDULE 13D/A'));
        addFiling(net, cik('AAPL'), { ...eightK(507, '2026-11-23', '1.05', '<p>Item 1.05 Material Cybersecurity Incidents.</p>'), accession: '0000320193-26-000507' });
        await run('2026-11-23');
        const nvda = await eventRows(db, 'NVDA');
        expect(nvda.map(({ code, detail, sub, status, byRule }) => [code, detail, sub, status, byRule])).toEqual(
          expect.arrayContaining([
            // 自選股寫成 NEW；T29b 起同一次流程就由提前審查處理（HANDLED，開了一次提前審查）
            ['CYBER', 'INCIDENT', '8K_1.05', 'HANDLED', 1],
            ['DISTRESS', 'ACCELERATION', '8K_2.04', 'HANDLED', 1],
            ['DISTRESS', 'DELISTING_NOTICE', '8K_3.01', 'HANDLED', 1],
            ['ACTIVIST', 'SC_13D', 'SC_13D', 'INFO', 1],
          ]),
        );
        expect(nvda).toHaveLength(4); // 13G、13D/A 不記
        expect((await eventRows(db, 'AAPL')).map(({ code, detail, status }) => [code, detail, status])).toEqual([['CYBER', 'INCIDENT', 'INFO']]);
        // 這幾項不交給 Haiku：沒有可掃的 8-K、也沒有新聞 → 不開掃描
        expect(await scanRuns(db)).toEqual([]);
      },
      { mom: ['AAPL'] },
    );
  });

  it('流程：5.02 執行長辭任，Haiku 回「沒有」時規則照樣記下（NEW）；董事辭任的 5.02 規則不記，Haiku 標成董事 → 只記錄', async () => {
    await withWorld(async ({ db, env, net, cik, run }) => {
      await run('2026-11-20');
      const ceo = eightK(511, '2026-11-23', '5.02,7.01,9.01', fixture('intc-2024-12-03.txt'));
      addFiling(net, cik('NVDA'), ceo);
      await run('2026-11-23');
      const rule = (await eventRows(db, 'NVDA')).find((e) => e.sub === '8K_5.02_CEO_DEPART')!;
      // 寫成 NEW；T29b 起同一次流程就由提前審查處理（HANDLED）
      expect(rule).toMatchObject({ code: 'MGMT_CHANGE', detail: 'CEO_DEPART', status: 'HANDLED', byRule: 1, accession: ceo.accession });
      // 5.02 照樣送給 Haiku；Haiku 回「沒有」
      const [s1] = await scanRuns(db);
      expect(sources(s1)).toEqual([`edgar:${ceo.accession}`]);
      expect((await postResult(env, s1, [nothing(s1)], new Date('2026-11-23T23:40:00Z'))).status).toBe(200);
      await run('2026-11-23', 'FINAL');
      const after = await eventRows(db, 'NVDA');
      expect(after).toHaveLength(1);
      expect(after[0]).toMatchObject({ sub: '8K_5.02_CEO_DEPART', status: 'HANDLED' });
      expect(runRow((await scanRuns(db))[0]).verdict).toBe('沒有值得標的事');

      // 隔天：董事辭任的 5.02 → 規則不記；Haiku 標 MGMT_CHANGE／DIRECTOR → INFO（不是可提前的細項）
      const dir = eightK(512, '2026-11-24', '5.02', fixture('intc-2024-08-22.txt'));
      addFiling(net, cik('NVDA'), dir);
      await run('2026-11-24');
      expect((await eventRows(db, 'NVDA')).filter((e) => e.accession === dir.accession)).toEqual([]);
      const s2 = (await scanRuns(db)).at(-1)!;
      expect(sources(s2)).toEqual([`edgar:${dir.accession}`]); // 前一份已經掃過（標記推過了）
      const flag = { run_id: s2.pack.run_id, verdict: 'FLAGGED', evidence: [], payload: { events: [{ ticker: 'NVDA', class: 'MGMT_CHANGE', sub: 'DIRECTOR', source_id: `edgar:${dir.accession}` }] } };
      await postResult(env, s2, [flag], new Date('2026-11-24T23:40:00Z'));
      await run('2026-11-24', 'FINAL');
      expect((await eventRows(db, 'NVDA')).find((e) => e.accession === `edgar:${dir.accession}`)).toMatchObject({ code: 'MGMT_CHANGE', detail: 'DIRECTOR', sub: 'SCAN_MGMT_CHANGE', status: 'INFO', byRule: 0 });
    });
  });
});

// ---------------------------------------------------------------- ② event_scan_v2：細項、條件清單、CONDITION_HINT

describe('event_scan_v2', () => {
  it('prompt 升版：event_scan_v2.md 存在、程式用 v2；v1 標成不再使用', () => {
    expect(EVENT_SCAN_PROMPT).toBe('event_scan_v2');
    const prompts = join(HERE, '..', '..', 'ai', 'prompts');
    expect(existsSync(join(prompts, 'event_scan_v2.md'))).toBe(true);
    expect(readFileSync(join(prompts, 'event_scan_v1.md'), 'utf8').split('\n')[0]).toContain('不再使用');
    const v2 = readFileSync(join(prompts, 'event_scan_v2.md'), 'utf8');
    for (const subs of Object.values(SCAN_SUBS)) for (const s of subs!) expect(v2).toContain(s);
    expect(v2).toContain('不判斷重大性');
  });

  it('不在列舉內的細項拿掉（類別留著）；細項只對 Haiku 判的類別有意義', () => {
    const pack = {
      run_id: 'r',
      as_of: '2026-11-23',
      function: 'EVENT_SCAN',
      prompt_version: 'event_scan_v2',
      subject: {},
      question: '',
      policy: { level: 'A1', verdicts: ['FLAGGED', 'NOTHING'], abstain: 'NOTHING', min_evidence: 0, samples: 1 },
      rule: { action: '', detail: { targets: [{ ticker: 'MU', role: 'OWN' }], conds: { K1: 41 } } },
      facts: [{ id: 'K1', label: 'MU 的觀察項 W1', value: '大客戶取消訂單' }],
      premises: [],
      documents: [{ id: 'F1', source_id: 'edgar:0000000001-26-000001', kind: 'filing', date: '2026-11-23', title: 't', text: 'Item 5.02 The CFO resigned.' }],
      data_quality: {},
    } as unknown as EvidencePack;
    const ev = (o: Record<string, unknown>) => ({ ticker: 'MU', source_id: 'edgar:0000000001-26-000001', ...o });
    const o = judge(pack, [{ run_id: 'r', verdict: 'FLAGGED', evidence: [], payload: { events: [ev({ class: 'MGMT_CHANGE', sub: 'CFO_DEPART', condition_ids: ['K1'] }), ev({ class: 'MGMT_CHANGE', sub: 'CHAIRMAN' }), ev({ class: 'RESTRUCTURING', sub: 'IMPAIRMENT' }), ev({ class: 'GUIDANCE_CUT', sub: 'CUT' })] } }], PAYLOAD_HOOKS.EVENT_SCAN);
    expect(scanEvents(o, pack).map((e) => [e.cls, e.sub, e.conditionRows])).toEqual([
      ['MGMT_CHANGE', 'CFO_DEPART', [41]],
      ['MGMT_CHANGE', null, []],
      ['RESTRUCTURING', null, []],
      ['GUIDANCE_CUT', 'CUT', []],
    ]);
    expect(o.samples[0].issues.filter((x) => x.includes('細項'))).toHaveLength(2);
  });

  it('掃描的條件清單是觀察項（事件類）與只在審查時檢查的條件；標到條件寫 CONDITION_HINT（申報 → NEW、新聞 → INFO）；可提前的細項由申報標到才 NEW', async () => {
    const ids: Record<string, number> = {};
    await withWorld(
      async ({ db, env, net, cik, run }) => {
        await run('2026-11-20');
        const g1 = eightK(521, '2026-11-23', '8.01', OTHER_801('The Chief Financial Officer informed the Company of her resignation, and the largest customer cancelled its orders.'));
        addFiling(net, cik('NVDA'), g1);
        net.news.NVDA = [{ at: '2026-11-23T20:00:00Z', title: 'NVIDIA cuts outlook as customer delays' }];
        await run('2026-11-23');
        const [s1] = await scanRuns(db);
        // 條件清單：PROPOSED 的事件條件、REVIEW_ONLY；ACTIVE（申報確認）與財報類的觀察項不放
        const k = s1.pack.facts.filter((f) => /^K\d+$/.test(f.id));
        expect(k.map((f) => [f.id, f.label])).toEqual([
          ['K1', 'NVDA 的觀察項 W1'],
          ['K2', 'NVDA 的條件（只在審查時檢查） C2'],
        ]);
        expect((s1.pack.rule.detail as { conds: Record<string, number> }).conds).toEqual({ K1: ids.watch, K2: ids.reviewOnly });
        const news = `nasdaq-rss:NVDA:2026-11-23`;
        expect(sources(s1)).toEqual([`edgar:${g1.accession}`, news]);
        const flag = {
          run_id: s1.pack.run_id,
          verdict: 'FLAGGED',
          evidence: [],
          payload: {
            events: [
              { ticker: 'NVDA', class: 'MGMT_CHANGE', sub: 'CFO_DEPART', source_id: `edgar:${g1.accession}`, condition_ids: ['K1'] },
              { ticker: 'NVDA', class: 'GUIDANCE_CUT', sub: 'CUT', source_id: news, condition_ids: ['K2'] },
              { ticker: 'NVDA', class: 'OTHER', sub: 'WHATEVER', source_id: `edgar:${g1.accession}` },
            ],
          },
        };
        await postResult(env, s1, [flag], new Date('2026-11-23T23:40:00Z'));
        await run('2026-11-23', 'FINAL');
        const rows = (await eventRows(db, 'NVDA')).filter((e) => e.byRule === 0).map(({ code, detail, sub, status, accession }) => [code, detail, sub, status, accession]);
        expect(rows).toEqual(
          expect.arrayContaining([
            // 申報標到的可提前細項與條件提示寫成 NEW；T29b 起 01:30 同一次就由提前審查處理（HANDLED）
            ['MGMT_CHANGE', 'CFO_DEPART', 'SCAN_MGMT_CHANGE', 'HANDLED', `edgar:${g1.accession}`],
            ['GUIDANCE_CUT', 'CUT', 'SCAN_GUIDANCE_CUT', 'INFO', news],
            ['OTHER', null, 'SCAN_OTHER', 'INFO', `edgar:${g1.accession}`],
            ['CONDITION_HINT', String(ids.watch), `SCAN_CONDITION_HINT_${ids.watch}`, 'HANDLED', `edgar:${g1.accession}`],
            ['CONDITION_HINT', String(ids.reviewOnly), `SCAN_CONDITION_HINT_${ids.reviewOnly}`, 'INFO', news],
          ]),
        );
        expect(rows).toHaveLength(5);
        const hint = (await loadEvents(db, { ticker: 'NVDA' })).find((e) => e.detail_code === String(ids.watch))!;
        expect(hint.detail).toContain('觀察項 W1');
        // 硬事件法庭只看三種硬事件代碼：這些 NEW 不會開法庭
        expect((await listRuns(db, new Date('2026-11-24T02:00:00Z'), { limit: 100 })).filter((r) => r.fn === 'HARD_EVENT')).toEqual([]);
      },
      {
        before: async (db, fileId) => {
          const ins = db.prepare("INSERT INTO own_conditions (ticker, run_id, cond_id, direction, kind, text, check_json, tier_if_met, status, created_at, origin, file_id, accepted_at, auto) VALUES ('NVDA', 'r0', ?, 'DOWN', ?, ?, ?, 'HALF', ?, '2026-11-19', ?, ?, ?, 1) RETURNING id");
          const add = async (condId: string, kind: string, text: string, check: unknown, status: string, owned: boolean) => (await ins.bind(condId, kind, text, JSON.stringify(check), status, owned ? 'USER' : 'AI', fileId, owned ? '2026-11-19T12:00:00Z' : null).first<{ id: number }>())!.id;
          ids.watch = await add('W1', 'EVENT', '最大客戶取消訂單', { type: 'event', confirm_by: ['8-K'] }, 'PROPOSED', false);
          ids.reviewOnly = await add('C2', 'EVENT', '法說會下修全年財測', { type: 'event', confirm_by: ['earnings_call'] }, 'REVIEW_ONLY', true);
          ids.active = await add('C3', 'EVENT', '8-K 宣布失去政府合約', { type: 'event', confirm_by: ['8-K'] }, 'ACTIVE', true);
          ids.xbrlWatch = await add('W4', 'XBRL', '毛利率低於 55%', { type: 'xbrl_metric_below', metric: 'GrossMarginPct', level: 0.55, quarters: 1 }, 'PROPOSED', false);
        },
      },
    );
  });
});

// ---------------------------------------------------------------- ③ ④ 標記、收集、重掃、告警

describe('掃描失敗、漏看的處理', () => {
  it('掃描逾時 → 01:30 重掃同一批（標記不動）；連續 2 次沒有結論推告警，寫出哪些文件沒被看過；之後每次再推；有結論後標記往前、失敗次數歸零', async () => {
    await withWorld(async ({ db, env, net, cik, run }) => {
      await run('2026-11-20');
      const a = eightK(531, '2026-11-23', '8.01', OTHER_801('The Company received a subpoena.'));
      addFiling(net, cik('NVDA'), a);
      net.news.NVDA = [{ at: '2026-11-23T20:00:00Z', title: 'NVIDIA faces probe' }];
      const base = await getFlowState(db, 'scan8k:NVDA');
      expect(base).toBe('2026-10-30T20:10:00.000Z'); // 11-20 第一次：從當時的 edgar 標記開始，不追溯

      await run('2026-11-23');
      const [s1] = await scanRuns(db);
      expect(sources(s1)).toEqual([`edgar:${a.accession}`, 'nasdaq-rss:NVDA:2026-11-23']);
      expect((s1.pack.rule.detail as { cursors: unknown }).cursors).toEqual({ NVDA: { scan8k: a.acceptanceDateTime, news: '2026-11-23T20:00:00.000Z' } });
      // 開掃描時標記不動
      expect(await getFlowState(db, 'scan8k:NVDA')).toBe(base);
      expect(await getFlowState(db, 'news:NVDA')).toBeNull();

      // 雲端排程沒有送回 → 01:30：照規則結束、算一次失敗（還不推告警）、重掃同一批
      const fin = await run('2026-11-23', 'FINAL');
      expect(fin.alerts).not.toContain('SCAN_FAILED');
      expect(await loadScanFails(db)).toMatchObject({ count: 1, session: '2026-11-23', runId: s1.runId });
      const scans = await scanRuns(db);
      expect(scans).toHaveLength(2);
      expect(scans[0].outcome?.status).toBe('TIMEOUT');
      expect(runRow(scans[0]).verdict).toBe(SCAN_FAILED_TEXT);
      const s2 = scans[1];
      expect(s2.createdAt).toBe('2026-11-24T01:30:00.000Z');
      expect(sources(s2)).toEqual(sources(s1));
      expect(await getFlowState(db, 'scan8k:NVDA')).toBe(base);
      expect(await getFlowState(db, 'news:NVDA')).toBeNull();

      // 重掃也沒有送回 → 03:30 套用：連續 2 次 → 告警
      net.line.length = 0;
      const apply = await run('2026-11-23', 'APPLY');
      expect(apply.alerts).toContain('SCAN_FAILED');
      const msg = `每日掃描連續 2 次沒有結論：NVDA 的 8-K 2026-11-23（Item 8.01）、NVDA 的 1 則新聞標題還沒有被 AI 看過。規則分類照常；下一次流程會重掃。`;
      expect((await db.prepare("SELECT message FROM alerts WHERE kind = 'SCAN_FAILED' ORDER BY id").all<{ message: string }>()).results.map((r) => r.message)).toEqual([msg]);
      expect(net.line.some((t) => t.includes(msg))).toBe(true);
      expect(runRow((await scanRuns(db))[1]).verdict).toBe(SCAN_FAILED_TEXT);

      // 隔天 23:30：同一批加上新的標題（標記沒動）；又沒有送回 → 01:30 第 3 次 → 再推一次、再重掃
      net.news.NVDA.push({ at: '2026-11-24T19:00:00Z', title: 'NVIDIA shares fall' });
      await run('2026-11-24');
      const s3 = (await scanRuns(db)).at(-1)!;
      expect(sources(s3)).toEqual([`edgar:${a.accession}`, 'nasdaq-rss:NVDA:2026-11-24']);
      expect(s3.pack.documents[1].text).toContain('NVIDIA faces probe');
      expect(s3.pack.documents[1].text).toContain('NVIDIA shares fall');
      const fin2 = await run('2026-11-24', 'FINAL');
      expect(fin2.alerts).toContain('SCAN_FAILED');
      expect((await db.prepare("SELECT message FROM alerts WHERE kind = 'SCAN_FAILED' ORDER BY id DESC").first<{ message: string }>())!.message).toBe(`每日掃描連續 3 次沒有結論：NVDA 的 8-K 2026-11-23（Item 8.01）、NVDA 的 2 則新聞標題還沒有被 AI 看過。規則分類照常；下一次流程會重掃。`);
      const s4 = (await scanRuns(db)).at(-1)!;
      expect(s4.createdAt).toBe('2026-11-25T01:30:00.000Z');

      // 重掃這次有結論（沒有值得標的事）→ 03:30 套用：兩個標記推到 cursors、失敗次數歸零；不再重掃
      expect((await postResult(env, s4, [nothing(s4)], new Date('2026-11-25T01:40:00Z'))).status).toBe(200);
      const apply2 = await run('2026-11-24', 'APPLY');
      expect(apply2.alerts).not.toContain('SCAN_FAILED');
      expect(await getFlowState(db, 'scan8k:NVDA')).toBe(a.acceptanceDateTime);
      expect(await getFlowState(db, 'news:NVDA')).toBe('2026-11-24T19:00:00.000Z');
      expect(await getFlowState(db, SCAN_FAILS)).toBeNull();

      // 11-25：只有新的標題（8-K 與舊標題已經看過）
      net.news.NVDA.push({ at: '2026-11-25T18:00:00Z', title: 'NVIDIA new product' });
      await run('2026-11-25');
      const s5 = (await scanRuns(db)).at(-1)!;
      expect(sources(s5)).toEqual(['nasdaq-rss:NVDA:2026-11-25']);
      expect(s5.pack.documents[0].text).toBe('2026-11-25 | NVIDIA new product');
      // 有結論的那天，01:30 不重掃
      await postResult(env, s5, [nothing(s5)], new Date('2026-11-25T23:40:00Z'));
      await run('2026-11-25', 'FINAL');
      expect((await scanRuns(db)).filter((r) => r.asOf === '2026-11-25')).toHaveLength(1);
    });
  });

  it('掃描之後才出現的標題隔天掃得到（news 記發布時間）；舊的日期標記當成那一天的 23:59:59Z', async () => {
    await withWorld(async ({ db, env, net, run }) => {
      await run('2026-11-20');
      // T28 之前存的是日期
      await db.prepare("INSERT INTO flow_state (key, value, updated_at) VALUES ('news:NVDA', '2026-11-22', 'x')").run();
      net.news.NVDA = [
        { at: '2026-11-22T22:00:00Z', title: 'Seen before upgrade' },
        { at: '2026-11-23T20:00:00Z', title: 'Before the scan' },
      ];
      await run('2026-11-23');
      const [s1] = await scanRuns(db);
      expect(s1.pack.documents[0].text).toBe('2026-11-23 | Before the scan');
      await postResult(env, s1, [nothing(s1)], new Date('2026-11-23T23:40:00Z'));
      // 23:30 的掃描之後、同一天才出現的標題
      net.news.NVDA.push({ at: '2026-11-23T23:50:00Z', title: 'After the scan same day' });
      await run('2026-11-23', 'FINAL');
      expect(await getFlowState(db, 'news:NVDA')).toBe('2026-11-23T20:00:00.000Z');
      await run('2026-11-24');
      const s2 = (await scanRuns(db)).at(-1)!;
      expect(s2.pack.documents[0].text).toBe('2026-11-23 | After the scan same day');
    });
  });

  it('一檔 4 份 8-K 都被掃到；一次最多 10 份原文（由舊到新），裝不下的下一次接著掃；新聞最多 30 則、較舊的略過並寫進備註', async () => {
    await withWorld(async ({ db, env, net, cik, run }) => {
      await run('2026-11-20');
      const four = [eightK(541, '2026-11-23', '8.01', OTHER_801('one')), eightK(542, '2026-11-23', '7.01', '<p>Item 7.01 Regulation FD</p>'), eightK(543, '2026-11-23', '1.01', '<p>Item 1.01 Agreement</p>'), eightK(544, '2026-11-23', '2.05,2.06', '<p>Item 2.05 Exit plan</p>')];
      for (const f of four) addFiling(net, cik('NVDA'), f);
      await run('2026-11-23');
      const [s1] = await scanRuns(db);
      expect(sources(s1)).toEqual(four.map((f) => `edgar:${f.accession}`));
      // 2.05、2.06 由規則記下細項（自選股 → NEW，T29b 起同一次流程就由提前審查處理 → HANDLED），同時照樣交給 Haiku
      expect((await eventRows(db, 'NVDA')).filter((e) => e.byRule).map((e) => [e.code, e.detail, e.status])).toEqual(expect.arrayContaining([['RESTRUCTURING', 'EXIT_PLAN', 'HANDLED'], ['RESTRUCTURING', 'IMPAIRMENT', 'HANDLED']]));
      await postResult(env, s1, [nothing(s1)], new Date('2026-11-23T23:40:00Z'));
      await run('2026-11-23', 'FINAL');

      // 11-24：12 份 8-K、35 則標題
      const twelve = Array.from({ length: 12 }, (_, k) => eightK(550 + k, '2026-11-24', '8.01', OTHER_801(`event ${k}`)));
      for (const f of twelve) addFiling(net, cik('NVDA'), f);
      net.news.NVDA = Array.from({ length: 35 }, (_, k) => ({ at: new Date(Date.parse('2026-11-24T10:00:00Z') + k * 60_000).toISOString(), title: `headline ${k}` }));
      await run('2026-11-24');
      const s2 = (await scanRuns(db)).at(-1)!;
      const filings = s2.pack.documents.filter((d) => d.kind === 'filing');
      expect(filings.map((d) => d.source_id)).toEqual(twelve.slice(0, 10).map((f) => `edgar:${f.accession}`));
      const notes = (s2.pack.rule.detail as { notes: string[] }).notes;
      expect(notes).toEqual(['還有 2 份 8-K 排在下一次掃描（一次最多 10 份）', 'NVDA：略過 5 則較舊的標題（一次最多 30 則）']);
      expect(s2.packNotes).toEqual(expect.arrayContaining(notes));
      const newsDoc = s2.pack.documents.find((d) => d.kind === 'news')!;
      expect(newsDoc.text.split('\n')).toHaveLength(31);
      expect(newsDoc.text).toContain('headline 34');
      expect(newsDoc.text).not.toContain('headline 4\n');
      expect(newsDoc.text).toContain('（略過 5 則較舊的標題）');
      expect((s2.pack.rule.detail as { cursors: Record<string, unknown> }).cursors).toEqual({ NVDA: { scan8k: twelve[9].acceptanceDateTime, news: '2026-11-24T10:34:00.000Z' } });
      await postResult(env, s2, [nothing(s2)], new Date('2026-11-24T23:40:00Z'));
      await run('2026-11-24', 'FINAL');
      expect(await getFlowState(db, 'scan8k:NVDA')).toBe(twelve[9].acceptanceDateTime);

      // 11-25：接著掃剩下的 2 份
      await run('2026-11-25');
      const s3 = (await scanRuns(db)).at(-1)!;
      expect(sources(s3)).toEqual(twelve.slice(10).map((f) => `edgar:${f.accession}`));
    });
  });

  it('純函式：scan8k 的起點、要掃的 8-K、舊的 news 標記、告警文字、合格結論', () => {
    const F = (acc: string, at: string, form = '8-K', items = ['8.01']) => ({ accession: acc, form, items, filingDate: at.slice(0, 10), acceptedAt: at, primaryDocument: 'x' }) as Filing;
    const all = [F('a', '2026-11-01T10:00:00.000Z', '10-Q', []), F('b', '2026-11-02T10:00:00.000Z'), F('c', '2026-11-03T10:00:00.000Z', '8-K', ['9.01']), F('d', '2026-11-04T10:00:00.000Z')];
    // 沒有 scan8k：用 fresh 之前看過的最新一份（= 當時的 edgar 標記）；第一次看申報（fresh 是空的）是最新的一份
    expect(scanBase({ all, fresh: [all[3]] }, null)).toBe('2026-11-03T10:00:00.000Z');
    expect(scanBase({ all, fresh: [] }, null)).toBe('2026-11-04T10:00:00.000Z');
    expect(scanBase({ all, fresh: [] }, '2026-11-01T00:00:00Z')).toBe('2026-11-01T00:00:00Z');
    // 只要有 SCAN_ITEMS 的 8-K、由舊到新
    expect(pendingScanFilings([...all].reverse(), '2026-11-01T10:00:00.000Z').map((f) => f.accession)).toEqual(['b', 'd']);
    expect(pendingScanFilings(all, '').map((f) => f.accession)).toEqual(['b', 'd']);
    expect(newsCursorMs('2026-11-23')).toBe(Date.parse('2026-11-23T23:59:59Z'));
    expect(newsCursorMs('2026-11-23T20:00:00.000Z')).toBe(Date.parse('2026-11-23T20:00:00Z'));
    expect(newsCursorMs(null)).toBeNull();
    expect(scanFailText(2, [{ ticker: 'MU', kind: '8-K', label: 'MU 的 8-K 2027-01-06（Item 5.02）' }, { ticker: 'NVDA', kind: 'NEWS', label: 'NVDA 的 12 則新聞標題' }])).toBe(
      '每日掃描連續 2 次沒有結論：MU 的 8-K 2027-01-06（Item 5.02）、NVDA 的 12 則新聞標題還沒有被 AI 看過。規則分類照常；下一次流程會重掃。',
    );
    const o = (status: Outcome['status'], valid: boolean[]) => ({ status, samples: valid.map((v) => ({ valid: v })) }) as unknown as Outcome;
    expect(scanQualified(o('INSUFFICIENT', [true]))).toBe(true); // 沒有值得標的事
    expect(scanQualified(o('AGREED', [true]))).toBe(true);
    expect(scanQualified(o('INVALID', [false]))).toBe(false);
    expect(scanQualified(o('TIMEOUT', []))).toBe(false);
    expect(scanQualified(o('NO_RESULT', []))).toBe(false);
    expect(scanQualified(null)).toBe(false);
  });
});

// ---------------------------------------------------------------- ⑤ 條件確認（F25）最多 8 份

describe('條件確認的文件上限', () => {
  it('F25 有 9 份相關的新申報 → 取最新的 8 份，另推 F25_OVERFLOW 寫明沒放進去的那一份', async () => {
    await withWorld(
      async ({ db, net, cik, run }) => {
        await run('2026-11-20');
        const nine = Array.from({ length: 9 }, (_, k) => eightK(570 + k, '2026-11-23', '8.01', OTHER_801(`update ${k}`)));
        for (const f of nine) addFiling(net, cik('NVDA'), f);
        const r = await run('2026-11-23');
        const f25 = (await listRuns(db, new Date('2026-11-24T00:00:00Z'), { limit: 100 })).filter((x) => x.fn === 'OWN_CONDITION');
        expect(f25).toHaveLength(1);
        expect(F25_MAX_FILINGS).toBe(8);
        expect(f25[0].pack.documents.map((d) => d.source_id).sort()).toEqual(nine.slice(1).map((f) => `edgar:${f.accession}`).sort());
        expect(r.alerts).toContain('F25_OVERFLOW');
        const alert = await db.prepare("SELECT message FROM alerts WHERE kind = 'F25_OVERFLOW'").first<{ message: string }>();
        expect(alert!.message).toBe(`NVDA 有 9 份新申報可能確認條件，條件確認一次最多讀 8 份（取最新的），這幾份沒有放進去：8-K 2026-11-23（${nine[0].accession}）。`);
      },
      {
        before: async (db, fileId) => {
          await db
            .prepare("INSERT INTO own_conditions (ticker, run_id, cond_id, direction, kind, text, check_json, tier_if_met, status, created_at, origin, file_id, accepted_at, action, auto) VALUES ('NVDA', 'r0', 'C1', 'DOWN', 'EVENT', '8-K 宣布失去最大客戶', ?, 'EXIT', 'ACTIVE', '2026-11-19', 'USER', ?, '2026-11-19T12:00:00Z', 'EXIT', 1)")
            .bind(JSON.stringify({ type: 'event', confirm_by: ['8-K'] }), fileId)
            .run();
        },
      },
    );
  });
});
