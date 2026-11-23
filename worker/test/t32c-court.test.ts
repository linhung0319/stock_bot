// T32c：硬事件法庭（自選與動能共用；momentum_ai_design_2026-11-15 §3.5、§5 的 T32c 那一列；own_thesis §2.6 最後一段）。
// 完成條件：
//   法庭逾時後事件回到 NEW、下一次重開、連續 2 次告警
//   有結論後同一件事的新聞標題不重開、新的申報會重開
//   動能持股 180 天內第二次建議不通知
//   自選股的行為除了重試與重開規則外不變
// 另外：票數不一致算跑完了（不重開）、轉交事件的原文（修 Q14）、事件過期時再推一次告警、同一檔一次一個法庭、
//   動能部位賣光時清掉 180 天的紀錄、「不做」的說明。
// 對外請求全部是假的：價格、成分股（固定檔）、EDGAR、Nasdaq RSS、雲端排程、LINE。
import { describe, expect, it } from 'vitest';
import type { StartCtx } from '../src/app/aiCtx';
import { finalizeRun, getRun, listRuns, startRun, type AiRun } from '../src/app/aiRuns';
import type { Env, Fetcher } from '../src/app/env';
import { COURT_ALERT_AFTER, courtEventLabel, courtFailText, courtFailsKey, loadCourtFails, scanTargets, startCourts } from '../src/app/events';
import { loadEvents } from '../src/app/filings';
import { runFlow } from '../src/app/flow';
import { LINE_PUSH_URL } from '../src/app/line';
import { loadAccount, saveAccount } from '../src/app/ledgerStore';
import type { Attempt } from '../src/app/schedule';
import { explainItem } from '../src/app/site/explain';
import { buildPack } from '../src/ai/pack';
import { buildMarketView } from '../src/data/marketView';
import { loadConstituents, loadSeries } from '../src/data/store';
import { SYSTEM_DEFAULT_PREMISES, addLot, createAccount, hardEvent, hardToldDays, hardToldWithin, newOwnMeta, type Account, type Item, type Notif } from '../src/engine';
import { freshDb } from './helpers/d1';
import { fakeFetcher, newWorld, type World } from './helpers/fakeSources';
import { scenarios } from './helpers/scenarios';
import { Sim } from './helpers/sim';

// ---------------------------------------------------------------- 假的 EDGAR、雲端排程、LINE

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
    if (url === 'https://api.example/fire') return Response.json({ claude_code_session_url: 'https://claude.ai/code/x' });
    const sub = /data\.sec\.gov\/submissions\/CIK(\d+)\.json/.exec(url);
    if (sub) {
      const co = net.cos.get(Number(sub[1])) ?? { name: 'SOME CORP', filings: [] };
      const fs = [...co.filings].reverse();
      return Response.json({ cik: sub[1], name: co.name, tickers: [], sic: '3674', formerNames: [], filings: { recent: { accessionNumber: fs.map((f) => f.accession), form: fs.map((f) => f.form), items: fs.map((f) => f.items), acceptanceDateTime: fs.map((f) => f.acceptanceDateTime), filingDate: fs.map((f) => f.filingDate), primaryDocument: fs.map((f) => f.primaryDocument) } } });
    }
    if (/companyfacts\/CIK\d+\.json/.test(url)) {
      const q = (start: string, end: string, val: number, filed: string) => ({ start, end, val, filed, form: '10-Q', accn: `a-${filed}` });
      return Response.json({ cik: 1, facts: { 'us-gaap': { Revenues: { units: { USD: [q('2026-01-01', '2026-03-31', 1000, '2026-04-30'), q('2026-04-01', '2026-06-30', 1100, '2026-07-30'), q('2026-07-01', '2026-09-30', 1200, '2026-10-30')] } } } } });
    }
    if (/companyconcept\//.test(url)) return new Response('nf', { status: 404 });
    const doc = /Archives\/edgar\/data\/\d+\/(\d+)\/(.+)$/.exec(url);
    if (doc) {
      const f = findFiling(doc[1]);
      if (!f) return new Response('nf', { status: 404 });
      if (doc[2] === 'index.json') return Response.json({ directory: { item: [{ name: f.primaryDocument }] } });
      return new Response(f.html);
    }
    if (/nasdaq\.com\/feed\/rssoutbound/.test(url)) return new Response('<rss><channel></channel></rss>');
    return base(url, init);
  };
}

/** 各排程的時間：23:30 收盤後、兩小時後 01:30、再兩小時後 03:30（UTC）。 */
const slotTime = (date: string, attempt: Attempt) => new Date(Date.parse(date + 'T23:30:00Z') + { FIRST: 0, MANUAL: 0, FINAL: 2, APPLY: 4 }[attempt] * 3600_000);

interface Ctx {
  db: D1Database;
  env: Env;
  net: Net;
  w: World;
  fetcher: Fetcher;
  cik: (t: string) => number;
  run: (date: string, attempt?: Attempt) => ReturnType<typeof runFlow>;
}

/** 自選 NVDA；mom 給了就加一檔動能持股。 */
async function withWorld(fn: (c: Ctx) => Promise<void>, opt: { mom?: string } = {}) {
  const d = await freshDb();
  try {
    const db = d.db;
    const w = newWorld('2026-11-19');
    const net: Net = { cos: new Map(), line: [] };
    const env: Env = { DB: db, ADMIN_TOKEN: 't', AI_TASK_SECRET: 's', EDGAR_USER_AGENT: 'test bot test@example.com', SITE_URL: 'https://bot.example', LINE_CHANNEL_TOKEN: 'lt', LINE_USER_ID: 'U1', ROUTINE_FIRE_URL: 'https://api.example/fire', ROUTINE_TOKEN: 'rt' };
    const fetcher = fetcherOf(w, net);
    const run = (date: string, attempt: Attempt = 'FIRST') => {
      if (attempt !== 'APPLY') w.dataDate = date;
      return runFlow(env, fetcher, { now: slotTime(date, attempt), attempt });
    };
    await run('2026-11-19');
    const members = (await loadConstituents(db))!;
    const cik = (t: string) => Number(members.holdings.find((h) => h[0] === t)![2]);
    const { view } = buildMarketView(await loadSeries(db, ['VOO', 'SGOV', 'NVDA', ...(opt.mom ? [opt.mom] : [])]), '2026-11-19', 'VOO');
    const acct = createAccount(
      {
        paper: true,
        cash: 5000,
        core: { VOO: Math.floor(140_000 / view.close.VOO[view.i]) },
        ...(opt.mom ? { mom: { [opt.mom]: Math.floor(8000 / view.close[opt.mom][view.i]) } } : {}),
        own: { NVDA: { shares: Math.floor(40_000 / view.close.NVDA[view.i]), stdWeight: 0.15, premises: [{ id: 'P1', text: '資料中心需求延續到 2027', origin: 'USER' }] } },
      },
      view,
    );
    await saveAccount(db, acct, null, '建立帳戶', new Date('2026-11-19T12:00:00Z'));
    // 之前就有的申報（第一次看只記下最新的一筆，不追溯）
    for (const t of ['NVDA', ...(opt.mom ? [opt.mom] : [])]) addFiling(net, cik(t), { accession: `${String(cik(t)).padStart(10, '0')}-26-000100`, form: '10-Q', items: '', acceptanceDateTime: '2026-10-30T20:00:00.000Z', filingDate: '2026-10-30', primaryDocument: 'q.htm', html: '<p>10-Q</p>' });
    await run('2026-11-20');
    await fn({ db, env, net, w, fetcher, cik, run });
  } finally {
    await d.dispose();
  }
}

const addFiling = (net: Net, cik: number, f: FakeFiling) => {
  const co = net.cos.get(cik) ?? { name: 'SOME CORP', filings: [] };
  co.filings.push(f);
  net.cos.set(cik, co);
};

const quoteOf = (date: string) => `the previously issued financial statements for the quarter ended ${date} should no longer be relied upon`;
const k402 = (date: string) => `<html><body><p>Item 4.02 Non-Reliance on Previously Issued Financial Statements.</p><p>On ${date}, the Audit Committee concluded that ${quoteOf(date)} because revenue was recognized prematurely.</p></body></html>`;
/** 一份 8-K 4.02（規則段會分類成 ACCOUNTING 的待處理事件）。 */
function add402(c: Ctx, ticker: string, seq: number, date: string): string {
  const acc = `${String(c.cik(ticker)).padStart(10, '0')}-26-${String(seq).padStart(6, '0')}`;
  addFiling(c.net, c.cik(ticker), { accession: acc, form: '8-K', items: '4.02,9.01', acceptanceDateTime: `${date}T21:05:00.000Z`, filingDate: date, primaryDocument: `k402-${seq}.htm`, html: k402(date) });
  return acc;
}

const courtsOf = async (db: D1Database, ticker: string): Promise<AiRun[]> =>
  (await listRuns(db, new Date('2026-11-01T00:00:00Z'), { limit: 500 })).filter((r) => r.fn === 'HARD_EVENT' && r.ticker === ticker).sort((a, b) => a.createdAt.localeCompare(b.createdAt));

/** 三票（同一個判斷），引用證據包裡第一份申報原文。 */
async function vote3(db: D1Database, run: AiRun, verdicts: ('EXIT' | 'HOLD')[], at: Date) {
  const doc = run.pack.documents.find((x) => x.kind === 'filing')!;
  const quote = /the previously issued financial statements for the quarter ended [^ ]+ should no longer be relied upon/.exec(doc.text)![0];
  const prem = run.pack.premises.at(-1)!.id;
  const one = (v: 'EXIT' | 'HOLD') => ({ run_id: run.pack.run_id, verdict: v, model: 'claude-opus-5-5', premise_checks: [{ premise_id: prem, status: v === 'EXIT' ? 'BROKEN' : 'HOLDS', evidence_ids: ['E1'] }], evidence: [{ id: 'E1', source_id: doc.source_id, date: doc.date, quote, claim: '財報重編' }], payload: v === 'EXIT' ? { reason_code: 'ACCOUNTING', recommend_exit: true } : { recommend_exit: false }, report: v === 'EXIT' ? '建議出場。' : '不重大。' });
  const task = await db.prepare('SELECT * FROM ai_tasks WHERE id = ?').bind(run.taskId).first();
  return finalizeRun(db, task as never, { samples: verdicts.map(one) }, at);
}

const alertsOf = async (db: D1Database, kind: string) => (await db.prepare('SELECT message FROM alerts WHERE kind = ? ORDER BY id').bind(kind).all<{ message: string }>()).results.map((r) => r.message);
const flowLog = async (db: D1Database) => JSON.parse((await db.prepare('SELECT detail FROM flow_runs ORDER BY id DESC LIMIT 1').first<{ detail: string }>())!.detail) as { ai: { log: string[] } };
const eventOf = async (db: D1Database, ticker: string, accession: string) => (await loadEvents(db, { ticker })).find((e) => e.accession === accession)!;
const insertEvent = (db: D1Database, ticker: string, accession: string, form: string, date: string, sub: string, createdAt: string, source = 'SCAN') =>
  db.prepare("INSERT INTO sec_events (ticker, accession, form, event_date, accepted_at, code, sub, by_rule, display_only, source, detail, status, created_at) VALUES (?, ?, ?, ?, NULL, 'ACCOUNTING', ?, 0, 0, ?, '測試', 'NEW', ?)").bind(ticker, accession, form, date, sub, source, createdAt).run();

// ---------------------------------------------------------------- 沒有結論時重開與告警

describe('T32c：法庭沒有結論時（§3.5，修 Q12）', () => {
  it('逾時 → 事件回到 NEW、下一次（01:30）重開 → 再逾時 → 連續 2 次告警；有結論後標 HANDLED、失敗次數歸零', async () => {
    await withWorld(async (c) => {
      const acc = add402(c, 'NVDA', 400, '2026-11-23');
      await c.run('2026-11-23');
      let [c1] = await courtsOf(c.db, 'NVDA');
      expect(c1.status).toBe('PENDING');
      expect(await eventOf(c.db, 'NVDA', acc)).toMatchObject({ status: 'IN_COURT', handled_note: c1.runId });

      // 01:30：23:30 開的法庭超過 45 分鐘沒有回來 → 照規則結束（逾時）→ 事件回到 NEW → 同一次就重開
      await c.run('2026-11-23', 'FINAL');
      c1 = (await getRun(c.db, c1.runId))!;
      expect(c1.outcome!.status).toBe('TIMEOUT');
      let courts = await courtsOf(c.db, 'NVDA');
      expect(courts).toHaveLength(2);
      const c2 = courts[1];
      expect(c2.createdAt).toBe('2026-11-24T01:30:00.000Z');
      expect(c2.pack.documents.some((d) => d.source_id === `edgar:${acc}`)).toBe(true);
      expect(await eventOf(c.db, 'NVDA', acc)).toMatchObject({ status: 'IN_COURT', handled_note: c2.runId });
      expect(await loadCourtFails(c.db, 'NVDA')).toMatchObject({ count: 1, fails: [{ runId: c1.runId, why: '逾時' }] });
      expect(await alertsOf(c.db, 'HARD_COURT_FAILED')).toEqual([]); // 第一次不推

      // 03:30：01:30 開的也沒有回來 → 連續第 2 次 → 告警；03:30 不開新的
      c.net.line.length = 0;
      await c.run('2026-11-23', 'APPLY');
      expect(await courtsOf(c.db, 'NVDA')).toHaveLength(2);
      expect(await eventOf(c.db, 'NVDA', acc)).toMatchObject({ status: 'NEW' });
      const msg = 'NVDA 的硬事件法庭連續 2 次沒有結論（8-K 2026-11-23 Item 4.02）。規則沒有動作，這件事還沒有被 AI 看過；下一次流程會重開。';
      expect(await alertsOf(c.db, 'HARD_COURT_FAILED')).toEqual([msg]);
      expect(c.net.line.some((t) => t.includes(msg))).toBe(true);

      // 隔天 23:30 重開第三次 → 三票一致「不重大」→ 01:30 套用：事件 HANDLED、寫結論、失敗次數歸零、不通知
      await c.run('2026-11-24');
      courts = await courtsOf(c.db, 'NVDA');
      expect(courts).toHaveLength(3);
      await vote3(c.db, courts[2], ['HOLD', 'HOLD', 'HOLD'], new Date('2026-11-25T00:10:00Z'));
      const fin = await c.run('2026-11-24', 'FINAL');
      expect(await eventOf(c.db, 'NVDA', acc)).toMatchObject({ status: 'HANDLED', handled_note: `法庭 ${courts[2].runId}：HOLD` });
      expect(await loadCourtFails(c.db, 'NVDA')).toBeNull();
      expect(fin.created).toEqual([]);
      expect(await alertsOf(c.db, 'HARD_COURT_FAILED')).toEqual([msg]);
      // 有結論之後不再開
      await c.run('2026-11-25');
      expect(await courtsOf(c.db, 'NVDA')).toHaveLength(3);
    });
  });

  it('票數不一致算跑完了：事件 HANDLED（票數不一致，照規則），不重開、不算失敗', async () => {
    await withWorld(async (c) => {
      const acc = add402(c, 'NVDA', 400, '2026-11-23');
      await c.run('2026-11-23');
      const [c1] = await courtsOf(c.db, 'NVDA');
      await vote3(c.db, c1, ['EXIT', 'HOLD', 'HOLD'], new Date('2026-11-24T00:10:00Z'));
      await c.run('2026-11-23', 'FINAL');
      expect((await getRun(c.db, c1.runId))!.outcome!.status).toBe('SPLIT');
      expect(await eventOf(c.db, 'NVDA', acc)).toMatchObject({ status: 'HANDLED', handled_note: `法庭 ${c1.runId}：票數不一致，照規則` });
      expect(await courtsOf(c.db, 'NVDA')).toHaveLength(1);
      expect(await loadCourtFails(c.db, 'NVDA')).toBeNull();
    });
  });

  it('一直沒有結論、事件建立超過 10 天 → 過期、再推一次告警（已經停止重試），清掉失敗次數', async () => {
    await withWorld(async (c) => {
      await insertEvent(c.db, 'NVDA', 'edgar:0001045810-26-000999', '8-K', '2026-11-10', 'SCAN_ACCOUNTING_CANDIDATE', '2026-11-10T23:40:00.000Z');
      await c.db.prepare('INSERT INTO flow_state (key, value, updated_at) VALUES (?, ?, ?)').bind(courtFailsKey('NVDA'), JSON.stringify({ count: 3, fails: [], events: [] }), '2026-11-20T03:30:00.000Z').run();
      await c.run('2026-11-23');
      expect(await eventOf(c.db, 'NVDA', 'edgar:0001045810-26-000999')).toMatchObject({ status: 'HANDLED', handled_note: '過期：建立超過 10 天沒有處理' });
      expect(await alertsOf(c.db, 'HARD_COURT_FAILED')).toEqual(['NVDA 的硬事件法庭連續 3 次沒有結論（8-K 2026-11-10），事件建立已經超過 10 天，已經停止重試。規則沒有動作，這件事沒有被 AI 看過。']);
      expect(await loadCourtFails(c.db, 'NVDA')).toBeNull();
      expect(await courtsOf(c.db, 'NVDA')).toEqual([]);
    });
  });

  it('告警的文字與門檻', () => {
    expect(COURT_ALERT_AFTER).toBe(2);
    expect(courtEventLabel({ form: '8-K', event_date: '2027-01-06', sub: '8K_4.02', accession: '0000000001-27-000001' })).toBe('8-K 2027-01-06 Item 4.02');
    expect(courtEventLabel({ form: 'NEWS', event_date: '2027-01-06', sub: 'SCAN_ACCOUNTING_CANDIDATE', accession: 'nasdaq-rss:MU:2027-01-06' })).toBe('新聞標題 2027-01-06');
    expect(courtEventLabel({ form: 'AI', event_date: '2027-01-06', sub: 'AI_OWN_DROP', accession: '2027-01-06_OWN_DROP_MU_abc' })).toBe('AI 轉交 2027-01-06');
    expect(courtFailText('MU', 2, ['8-K 2027-01-06 Item 4.02'])).toBe('MU 的硬事件法庭連續 2 次沒有結論（8-K 2027-01-06 Item 4.02）。規則沒有動作，這件事還沒有被 AI 看過；下一次流程會重開。');
  });
});

// ---------------------------------------------------------------- 什麼時候開

describe('T32c：法庭什麼時候開（§3.5，修 Q4、Q13）', () => {
  it('有結論後：同一件事的新聞標題不重開、同一份申報不重開；新的申報會重開；別的代碼從來沒有結論 → 開', async () => {
    await withWorld(async (c) => {
      const a = add402(c, 'NVDA', 400, '2026-11-23');
      await c.run('2026-11-23');
      const [c1] = await courtsOf(c.db, 'NVDA');
      await vote3(c.db, c1, ['HOLD', 'HOLD', 'HOLD'], new Date('2026-11-24T00:10:00Z'));
      await c.run('2026-11-23', 'FINAL');
      expect(await eventOf(c.db, 'NVDA', a)).toMatchObject({ status: 'HANDLED', handled_note: `法庭 ${c1.runId}：HOLD` });

      // 每日掃描之後從新聞標題、從同一份申報又標到財報可信度
      await insertEvent(c.db, 'NVDA', 'nasdaq-rss:NVDA:2026-11-24', 'NEWS', '2026-11-24', 'SCAN_ACCOUNTING_CANDIDATE', '2026-11-24T23:35:00.000Z');
      await insertEvent(c.db, 'NVDA', `edgar:${a}`, '8-K', '2026-11-23', 'SCAN_ACCOUNTING_CANDIDATE', '2026-11-24T23:35:00.000Z');
      await c.run('2026-11-24');
      expect(await courtsOf(c.db, 'NVDA')).toHaveLength(1);
      expect(await eventOf(c.db, 'NVDA', 'nasdaq-rss:NVDA:2026-11-24')).toMatchObject({ status: 'HANDLED', handled_note: `已有 ${c1.runId} 的結論，新聞標題不重開` });
      expect(await eventOf(c.db, 'NVDA', `edgar:${a}`)).toMatchObject({ status: 'HANDLED', handled_note: `已有 ${c1.runId} 的結論，申報已經看過，不重開` });

      // 新的 4.02 申報 → 重開，證據包有新的那一份
      const b = add402(c, 'NVDA', 401, '2026-11-25');
      await c.run('2026-11-25');
      const courts = await courtsOf(c.db, 'NVDA');
      expect(courts).toHaveLength(2);
      expect(courts[1].pack.documents.map((d) => d.source_id)).toContain(`edgar:${b}`);
      expect(await eventOf(c.db, 'NVDA', b)).toMatchObject({ status: 'IN_COURT', handled_note: courts[1].runId });
    });
  });

  it('從來沒有過有結論的法庭：只有新聞標題也開（照舊）；只有新聞標題的證據包不算申報缺漏', async () => {
    await withWorld(
      async (c) => {
        await insertEvent(c.db, 'AAPL', 'nasdaq-rss:AAPL:2026-11-23', 'NEWS', '2026-11-23', 'SCAN_ACCOUNTING_CANDIDATE', '2026-11-23T23:35:00.000Z');
        await c.run('2026-11-23');
        const [c1] = await courtsOf(c.db, 'AAPL');
        expect(c1.pack.rule.detail).toMatchObject({ codes: ['ACCOUNTING'], role: 'MOM' });
        expect(c1.pack.data_quality).not.toHaveProperty('filings');
      },
      { mom: 'AAPL' },
    );
  });

  it('轉交來的事件（減半檢視轉交，form = AI）：原文取自那次執行的證據包裡的申報（修 Q14）', async () => {
    await withWorld(async (c) => {
      const { pack } = buildPack({
        runId: '2026-11-23_OWN_DROP_NVDA_aaaaaa',
        fn: 'OWN_DROP',
        promptVersion: 'own_drop_v2',
        asOf: '2026-11-23',
        subject: { ticker: 'NVDA' },
        question: '減半檢視',
        policy: { level: 'A3', verdicts: ['EXIT', 'HALF', 'HOLD'], abstain: 'HALF', min_evidence: 1, samples: 3 },
        rule: { action: '減半' },
        premises: [{ id: 'P1', text: '資料中心需求延續到 2027', origin: 'USER' }],
        documents: [
          { id: 'F-0001045810-26-000777', source_id: 'edgar:0001045810-26-000777', kind: 'filing', date: '2026-11-18', title: '8-K 2026-11-18', text: 'The SEC has opened a formal investigation into the Company.' },
          { id: 'N-NVDA', source_id: 'nasdaq-rss:NVDA:2026-11-23', kind: 'news', date: '2026-11-23', title: '新聞標題', text: '2026-11-23 | headline' },
        ],
        now: new Date('2026-11-23T23:40:00Z'),
      });
      const fwd = await startRun(c.env, c.fetcher, pack, new Date('2026-11-23T23:40:00Z'));
      await c.db.prepare("INSERT INTO sec_events (ticker, accession, form, event_date, accepted_at, code, sub, by_rule, display_only, source, detail, status, created_at) VALUES ('NVDA', ?, 'AI', '2026-11-23', NULL, 'REGULATORY', 'AI_OWN_DROP', 0, 0, 'AI', '減半檢視的 AI 認為有硬事件，轉交法庭', 'NEW', '2026-11-24T00:30:00.000Z')").bind(fwd.runId).run();
      await c.run('2026-11-24');
      const [court] = await courtsOf(c.db, 'NVDA');
      const doc = court.pack.documents.find((d) => d.source_id === 'edgar:0001045810-26-000777')!;
      expect(doc).toMatchObject({ kind: 'filing', text: 'The SEC has opened a formal investigation into the Company.' });
      expect(court.pack.documents.some((d) => d.source_id === 'nasdaq-rss:NVDA:2026-11-23')).toBe(false);
      expect(court.pack.data_quality).toMatchObject({ filings: 'ok' });
    });
  });

  it('同一檔一次一個法庭：還在等結果時新的事件留著 NEW，下一次再看', async () => {
    await withWorld(async (c) => {
      const a = add402(c, 'NVDA', 400, '2026-11-23');
      await c.run('2026-11-23');
      const [c1] = await courtsOf(c.db, 'NVDA');
      await insertEvent(c.db, 'NVDA', 'nasdaq-rss:NVDA:2026-11-23', 'NEWS', '2026-11-23', 'SCAN_ACCOUNTING_CANDIDATE', '2026-11-23T23:50:00.000Z');
      // 23:50 再看一次（法庭 23:30 才開，還在等）
      const now = new Date('2026-11-23T23:50:00Z');
      const acct = (await loadAccount(c.db))!.acct;
      const { view, axis } = buildMarketView(await loadSeries(c.db, ['VOO', 'SGOV', 'NVDA']), '2026-11-23', 'VOO');
      const sc: StartCtx = { env: c.env, fetcher: c.fetcher, acct, view, axis, session: '2026-11-23', ov: {} as StartCtx['ov'], now, checks: [], res: { created: [], started: [], log: [], alerts: [] }, extras: {} };
      await startCourts(sc, scanTargets(acct));
      expect(sc.res.started).toEqual([]);
      expect(sc.res.log.join('\n')).toContain('NVDA 的硬事件法庭還在等結果');
      expect(await eventOf(c.db, 'NVDA', 'nasdaq-rss:NVDA:2026-11-23')).toMatchObject({ status: 'NEW' });
      expect(await eventOf(c.db, 'NVDA', a)).toMatchObject({ status: 'IN_COURT', handled_note: c1.runId });
    });
  });
});

// ---------------------------------------------------------------- 動能 180 天；自選不變

describe('T32c：動能持股同一檔同一類 180 天只通知一次；自選股照舊', () => {
  it('兩次法庭都建議出場：動能持股第二次不通知（紀錄寫明）；自選股兩次都通知', async () => {
    await withWorld(
      async (c) => {
        add402(c, 'AAPL', 400, '2026-11-23');
        add402(c, 'NVDA', 400, '2026-11-23');
        await c.run('2026-11-23');
        for (const t of ['AAPL', 'NVDA']) await vote3(c.db, (await courtsOf(c.db, t))[0], ['EXIT', 'EXIT', 'EXIT'], new Date('2026-11-24T00:10:00Z'));
        await c.run('2026-11-23', 'FINAL');
        let acct = (await loadAccount(c.db))!.acct;
        const hard = (t: string) => acct.notifs.filter((n) => n.title === `${t} 硬事件（ACCOUNTING）`);
        expect(hard('AAPL')).toHaveLength(1);
        expect(hard('NVDA')).toHaveLength(1);
        expect(acct.mom.hardTold).toEqual({ AAPL: { ACCOUNTING: '2026-11-23' } });
        expect(acct.rule.heldMom).toContain('AAPL'); // AI 建議不先改名單（T32a）

        // 隔天兩檔都有新的 4.02 → 新的申報會重開 → 又三票建議出場
        add402(c, 'AAPL', 401, '2026-11-24');
        add402(c, 'NVDA', 401, '2026-11-24');
        await c.run('2026-11-24');
        for (const t of ['AAPL', 'NVDA']) {
          const courts = await courtsOf(c.db, t);
          expect(courts).toHaveLength(2);
          await vote3(c.db, courts[1], ['EXIT', 'EXIT', 'EXIT'], new Date('2026-11-25T00:10:00Z'));
        }
        await c.run('2026-11-24', 'FINAL');
        acct = (await loadAccount(c.db))!.acct;
        expect(hard('AAPL')).toHaveLength(1);
        expect(hard('NVDA')).toHaveLength(2);
        expect((await flowLog(c.db)).ai.log).toContain('AAPL ACCOUNTING：11-23 已經通知過，180 天內不再通知（結論在 AI 紀錄）');
        expect(acct.mom.hardTold).toEqual({ AAPL: { ACCOUNTING: '2026-11-23' } });
      },
      { mom: 'AAPL' },
    );
  });
});

describe('T32c：引擎的 180 天上限（hardEvent、hardTold）', () => {
  const item = (n: Notif, f: string, ticker: string): Item | undefined => n.items.find((i) => i.f === f && i.ticker === ticker);
  const start = () => {
    const sc = scenarios.s4();
    const sim = new Sim(sc.market, sc.init);
    sim.runUntil('2026-12-10');
    sim.day();
    return sim;
  };

  it('期間：一般 180 天、被收購 365 天；179 天內擋、滿 180 天再通知', () => {
    expect(hardToldDays('ACCOUNTING')).toBe(180);
    expect(hardToldDays('REGULATORY')).toBe(180);
    expect(hardToldDays('PENDING_MA')).toBe(365);
    const a = { mom: { excluded: {}, adopted: {}, owe: {}, hardTold: { MU: { ACCOUNTING: '2026-01-01', PENDING_MA: '2026-01-01' } } } } as Pick<Account, 'mom'>;
    expect(hardToldWithin(a, 'MU', 'ACCOUNTING', '2026-06-29')).toBe('2026-01-01'); // 179 天
    expect(hardToldWithin(a, 'MU', 'ACCOUNTING', '2026-06-30')).toBeNull(); // 180 天
    expect(hardToldWithin(a, 'MU', 'REGULATORY', '2026-02-01')).toBeNull(); // 別的類別
    expect(hardToldWithin(a, 'MU', 'PENDING_MA', '2026-12-31')).toBe('2026-01-01');
    expect(hardToldWithin(a, 'MU', 'PENDING_MA', '2027-01-01')).toBeNull();
    expect(hardToldWithin({ mom: { excluded: {}, adopted: {}, owe: {} } }, 'MU', 'ACCOUNTING', '2026-02-01')).toBeNull(); // 舊帳戶沒有這個欄位
  });

  it('動能持股：第一次通知時記下、期間內第二次沒有通知；規則直接提出的不受影響也不記', () => {
    const sim = start();
    const r1 = hardEvent(sim.acct, sim.pre, 'ORCL', 'ACCOUNTING', false, ['run-1']);
    expect(r1.notif).not.toBeNull();
    expect(r1.acct.mom.hardTold).toEqual({ ORCL: { ACCOUNTING: sim.pre.date } });
    const r2 = hardEvent(r1.acct, sim.pre, 'ORCL', 'ACCOUNTING', false, ['run-2']);
    expect(r2.notif).toBeNull();
    expect(r2.momToldOn).toBe(sim.pre.date);
    // 別的類別照樣通知
    expect(hardEvent(r1.acct, sim.pre, 'ORCL', 'REGULATORY', false, ['run-3']).notif).not.toBeNull();
    // 規則直接提出（被收購方）不看也不記
    const r4 = hardEvent(r1.acct, sim.pre, 'ORCL', 'PENDING_MA', true);
    expect(item(r4.notif!, 'F19', 'ORCL')).toBeTruthy();
    expect(r4.acct.mom.hardTold).toEqual({ ORCL: { ACCOUNTING: sim.pre.date } });
  });

  it('同一檔自選與動能都有：動能那一項被擋、自選那一項照舊通知', () => {
    const sim = start();
    const acct = structuredClone(sim.acct);
    acct.lots.own.ORCL = 3;
    acct.own.ORCL = newOwnMeta(sim.pre, 'ORCL', 'NEW', structuredClone(SYSTEM_DEFAULT_PREMISES));
    acct.mom.hardTold = { ORCL: { ACCOUNTING: sim.pre.date } };
    const r = hardEvent(acct, sim.pre, 'ORCL', 'ACCOUNTING', false, ['run-2']);
    expect(r.momToldOn).toBe(sim.pre.date);
    expect(r.notif!.items.map((i) => i.title)).toEqual(['ORCL ACCOUNTING：AI 建議提早出場（自選）']);
  });

  it('動能部位賣光時清掉這一檔的紀錄（之後重新進場、再出事會通知）', () => {
    const sim = start();
    const r1 = hardEvent(sim.acct, sim.pre, 'ORCL', 'ACCOUNTING', false, ['run-1']);
    const acct = structuredClone(r1.acct);
    addLot(acct, 'mom', 'ORCL', -1);
    expect(acct.mom.hardTold?.ORCL).toBeDefined(); // 還有部位
    addLot(acct, 'mom', 'ORCL', -(acct.lots.mom.ORCL ?? 0));
    expect(acct.lots.mom.ORCL).toBeUndefined();
    expect(acct.mom.hardTold?.ORCL).toBeUndefined();
  });

  it('「不做」的說明補上「同一類事件 180 天內不再通知」（被收購 365 天）', () => {
    const sim = start();
    for (const [code, days] of [['ACCOUNTING', 180], ['PENDING_MA', 365]] as const) {
      const r = hardEvent(sim.acct, sim.pre, 'ORCL', code, false, ['run-f19']);
      const ex = explainItem({ acct: r.acct, view: sim.pre, axis: [], rankOrder: [], aiNotes: [] } as never, r.notif!, item(r.notif!, 'F19', 'ORCL')!);
      expect(ex.choiceNotes?.SKIP).toBe(`不做：這一檔留在動能名單，之後照排名進出。同一類事件 ${days} 天內不再通知。`);
    }
  });
});
