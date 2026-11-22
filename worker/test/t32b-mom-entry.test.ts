// T32b：動能的進場審查（momentum_ai_design_2026-11-15 §5 的 T32b 那一列；§3.1～§3.4、§3.9、§3.10）。
// 完成條件：
//   上月第 20 名的股票這個月進前 5：回看掃描有它的 8-K
//   回看標到財測下修 → 開法庭
//   只有新聞標題的命中 → 「准許，附註」、不開法庭
//   只引用新聞的否決票被改掉
//   同一批證據第二個月不開法庭、否決沿用、遞補照記
//   新的 10-Q 出來 → 重開
//   法庭逾時 → 01:30 重開 → 再逾時 → 告警與月報說明
//   晚到的否決三種月報狀態各一個測試
// 對外請求全部是假的：價格、成分股（固定檔）、EDGAR、Nasdaq RSS、雲端排程、LINE。
import { describe, expect, it } from 'vitest';
import { judge, type EvidencePack } from '../src/ai/check';
import { PAYLOAD_HOOKS } from '../src/ai/hooks';
import { NEWS_ONLY_VETO_REASON, courtVerdict, entryNewEvidence, entryNote, entryRuleVerdict, evidenceKey, type EntryHit } from '../src/ai/momEntry';
import type { ApplyCtx } from '../src/app/aiCtx';
import { finalizeRun, listRuns, type AiRun } from '../src/app/aiRuns';
import type { Env, Fetcher } from '../src/app/env';
import { loadEvents } from '../src/app/filings';
import { ingest, runFlow } from '../src/app/flow';
import { LINE_PUSH_URL } from '../src/app/line';
import { loadAccount, saveAccount } from '../src/app/ledgerStore';
import { applyMomEntry, courtFailedText, loadReviews } from '../src/app/momAi';
import { scanEventHits } from '../src/app/momEvidence';
import { lookbackFailText, lookbackFilings } from '../src/app/momLookback';
import { lateVetoWaiter } from '../src/app/pushHold';
import type { Attempt } from '../src/app/schedule';
import { explainItem } from '../src/app/site/explain';
import { notifView } from '../src/app/site/views';
import { buildMarketView } from '../src/data/marketView';
import type { Filing } from '../src/data/sources';
import { loadConstituents, loadRanking, loadSeries } from '../src/data/store';
import { createAccount, hardEvent } from '../src/engine';
import { freshDb } from './helpers/d1';
import { cronTime, fakeFetcher, newWorld, type World } from './helpers/fakeSources';
import { scenarios } from './helpers/scenarios';
import { Sim } from './helpers/sim';

// ---------------------------------------------------------------- 純函式

const hit = (o: Partial<EntryHit> & { code: string; sub: string }): EntryHit => ({ detail: 'x', byRule: false, ...o });

describe('T32b：規則能下的結論（§3.3 的表）', () => {
  it('要法庭判斷的命中全部來自新聞標題 → 准許，附註、不開法庭；有一筆來自申報或程式算的 → 開法庭；增資附在後面', () => {
    const news = hit({ code: 'REGULATORY', sub: 'SCAN_REGULATORY_CANDIDATE', date: '2026-11-20', accession: 'nasdaq-rss:MU:2026-11-20', basis: 'NEWS' });
    const v = entryRuleVerdict([news]);
    expect(v).toMatchObject({ decision: 'ALLOW_WATCH', reasonCode: null, watchReason: '新聞標題標到「重大監管或訴訟」（11-20），只有標題、沒有申報，不能否決' });
    const dil = hit({ code: 'DILUTION', sub: 'SHARES_6M', detail: '流通股數 6 個月增加 8.0%', byRule: true, displayOnly: true, basis: 'CALC' });
    expect(entryRuleVerdict([news, dil]).watchReason).toBe('新聞標題標到「重大監管或訴訟」（11-20），只有標題、沒有申報，不能否決；增資（只顯示、不否決）：流通股數 6 個月增加 8.0%');
    const filing = hit({ code: 'REGULATORY', sub: 'SCAN_REGULATORY_CANDIDATE', date: '2026-11-18', accession: 'edgar:0000000001-26-000801', basis: 'FILING' });
    expect(entryRuleVerdict([news, filing])).toMatchObject({ decision: 'COURT' });
    expect(entryRuleVerdict([hit({ code: 'ONE_OFF_JUMP', sub: 'JUMP_SHARE', basis: 'CALC' })]).decision).toBe('COURT');
    // 舊的命中沒有 basis：當成申報
    expect(entryRuleVerdict([hit({ code: 'ACCOUNTING', sub: '8K_4.02' })]).decision).toBe('COURT');
    // 增資只顯示：准許，附註（以前寫「准許但觀察」）
    expect(entryRuleVerdict([dil]).note).toBe('只有增資命中：准許，附註');
  });

  it('證據指紋：申報 <code>|<sub>|<編號>、跳漲與 EPS 用日期；新聞標題不算；排序', () => {
    const k = evidenceKey([
      hit({ code: 'EARNINGS_DIVERGENCE', sub: 'EPS_DOWN_PRICE_UP', date: '2026-09-30', basis: 'CALC' }),
      hit({ code: 'ACCOUNTING', sub: '8K_4.02', accession: '0000000002-26-000020', basis: 'FILING' }),
      hit({ code: 'EARNINGS_DIVERGENCE', sub: 'SCAN_GUIDANCE_CUT', accession: 'edgar:0000000002-26-000030', basis: 'FILING' }),
      hit({ code: 'ONE_OFF_JUMP', sub: 'JUMP_SHARE', date: '2026-08-05', basis: 'CALC' }),
      hit({ code: 'REGULATORY', sub: 'SCAN_REGULATORY_CANDIDATE', accession: 'nasdaq-rss:X', basis: 'NEWS' }),
      hit({ code: 'DILUTION', sub: 'SHARES_6M', byRule: true, displayOnly: true, basis: 'CALC' }),
    ]);
    expect(k).toBe('ACCOUNTING|8K_4.02|0000000002-26-000020;EARNINGS_DIVERGENCE|EPS|2026-09-30;EARNINGS_DIVERGENCE|SCAN_GUIDANCE_CUT|0000000002-26-000030;ONE_OFF_JUMP|JUMP|2026-08-05');
  });

  it('新證據：沒有上一次 NEVER、指紋不同 HITS、新的 10-Q／10-K／8-K 2.02 FILING、滿 100 天 STALE；都沒有 → 沿用', () => {
    const prev = { month: '2026-11', evidenceKey: 'A', decidedOn: '2026-10-29' };
    const f = (form: string, filingDate: string, items: string[] = []) => ({ form, filingDate, items });
    expect(entryNewEvidence(null, { key: 'A', filings: [], asOf: '2026-11-27' })).toEqual(['NEVER']);
    expect(entryNewEvidence(prev, { key: 'A', filings: [f('8-K', '2026-11-05', ['8.01']), f('10-Q', '2026-10-20')], asOf: '2026-11-27' })).toEqual([]);
    expect(entryNewEvidence(prev, { key: 'B', filings: [], asOf: '2026-11-27' })).toEqual(['HITS']);
    expect(entryNewEvidence(prev, { key: 'A', filings: [f('10-Q', '2026-11-10')], asOf: '2026-11-27' })).toEqual(['FILING']);
    expect(entryNewEvidence(prev, { key: 'A', filings: [f('8-K/A', '2026-11-10', ['2.02'])], asOf: '2026-11-27' })).toEqual(['FILING']);
    expect(entryNewEvidence(prev, { key: 'A', filings: [], asOf: '2027-02-06' })).toEqual(['STALE']); // 100 天
    expect(entryNewEvidence(prev, { key: 'A', filings: [], asOf: '2027-02-05' })).toEqual([]);
  });

  it('月報那一項的說明：附註、三票准許、沿用、還在審、略過的文件；規則准許沒有命中不寫', () => {
    const h = [hit({ code: 'ACCOUNTING', sub: '8K_4.02', date: '2026-11-12', accession: '0000000002-26-000020', basis: 'FILING' })];
    const base = { decision: 'ALLOW' as const, source: 'RULE' as const, hits: [], runId: null, watchReason: null, note: null };
    expect(entryNote(base)).toBeNull();
    expect(entryNote({ ...base, decision: 'ALLOW_WATCH', watchReason: '增資' })).toBe('准許，附註：增資');
    expect(entryNote({ ...base, source: 'AI', runId: 'r', hits: h })).toBe('進場審查（3 票）：准許。規則偵測命中：8-K 4.02（2026-11-12）');
    expect(entryNote({ ...base, source: 'AI', runId: 'r', hits: h, carriedFrom: '2026-11' })).toBe('沿用 2026-11 的進場審查（准許）：之後沒有新的財報或命中');
    expect(entryNote({ ...base, source: 'DEFAULT', hits: h, late: true }, { running: true })).toBe('規則偵測命中：8-K 4.02（2026-11-12）；進場審查進行中，台灣 11:30 前更新');
    expect(entryNote({ ...base, source: 'AI', runId: 'r', hits: h, note: '3 票一致：ALLOW。；略過 2 份：8-K 2026-01-06、8-K 2026-01-05' })).toBe('進場審查（3 票）：准許。規則偵測命中：8-K 4.02（2026-11-12）（略過 2 份文件，見 AI 紀錄）');
  });

  it('sec_events 轉來的命中：三種候選照有效期間（監管 180 天）、財測下修只收申報來的 CUT／WITHDRAWN、100 天內；不看狀態', () => {
    const ev = (o: Partial<Parameters<typeof scanEventHits>[0][number]>) => ({ source: 'SCAN', code: 'REGULATORY', sub: 'SCAN_REGULATORY_CANDIDATE', detail: 'd', event_date: '2026-11-01', accession: 'edgar:0000000001-26-000001', form: '8-K', detail_code: null, ...o });
    const hs = scanEventHits(
      [
        ev({}),
        ev({ event_date: '2026-05-01', accession: 'edgar:0000000001-26-000002' }), // 監管 210 天前：過期
        ev({ code: 'PENDING_MA', sub: 'SCAN_PENDING_MA_CANDIDATE', event_date: '2026-01-10', accession: 'edgar:0000000001-26-000003' }), // 被收購 365 天內
        ev({ code: 'REGULATORY', accession: 'nasdaq-rss:MU:2026-11-02', form: 'NEWS', event_date: '2026-11-02' }),
        ev({ code: 'GUIDANCE_CUT', sub: 'SCAN_GUIDANCE_CUT', detail_code: 'CUT', accession: 'edgar:0000000001-26-000004', event_date: '2026-09-01' }),
        ev({ code: 'GUIDANCE_CUT', sub: 'SCAN_GUIDANCE_CUT', detail_code: 'CUT', accession: 'edgar:0000000001-26-000005', event_date: '2026-07-01' }), // 149 天：過期
        ev({ code: 'GUIDANCE_CUT', sub: 'SCAN_GUIDANCE_CUT', detail_code: 'WITHDRAWN', accession: 'nasdaq-rss:MU:2026-11-03', form: 'NEWS', event_date: '2026-11-03' }), // 新聞：不算
        ev({ code: 'MGMT_CHANGE', sub: 'SCAN_MGMT_CHANGE', detail_code: 'CEO_DEPART', accession: 'edgar:0000000001-26-000006' }),
        ev({ source: 'EDGAR', code: 'ACCOUNTING', sub: '8K_4.02', accession: '0000000001-26-000007' }),
      ],
      '2026-11-27',
    );
    expect(hs.map((h) => [h.code, h.sub, h.accession, h.basis])).toEqual([
      ['REGULATORY', 'SCAN_REGULATORY_CANDIDATE', 'edgar:0000000001-26-000001', 'FILING'],
      ['PENDING_MA', 'SCAN_PENDING_MA_CANDIDATE', 'edgar:0000000001-26-000003', 'FILING'],
      ['REGULATORY', 'SCAN_REGULATORY_CANDIDATE', 'nasdaq-rss:MU:2026-11-02', 'NEWS'],
      ['EARNINGS_DIVERGENCE', 'SCAN_GUIDANCE_CUT', 'edgar:0000000001-26-000004', 'FILING'],
    ]);
  });

  it('回看要看的 8-K：標記之後、30 天內有掃描項目的，或 100 天內最新一份 2.02（排第一）', () => {
    const f = (acc: string, filingDate: string, items: string[], form = '8-K'): Filing => ({ accession: acc, form, items, filingDate, acceptedAt: `${filingDate}T21:00:00.000Z`, primaryDocument: 'd.htm' });
    const all = [f('a1', '2026-11-20', ['5.02']), f('a2', '2026-11-10', ['8.01']), f('a3', '2026-10-20', ['8.01']), f('a4', '2026-10-28', ['2.02']), f('a5', '2026-08-01', ['2.02']), f('a6', '2026-11-15', ['9.01']), f('a7', '2026-11-12', [], '10-Q')];
    expect(lookbackFilings(all, '2026-11-27', null).map((x) => x.accession)).toEqual(['a4', 'a1', 'a2']);
    expect(lookbackFilings(all, '2026-11-27', '2026-11-10T21:00:00.000Z').map((x) => x.accession)).toEqual(['a1']);
    expect(lookbackFailText(2, [{ ticker: 'MU', label: '8-K 2026-11-20（Item 5.02）' }, { ticker: 'MU', label: '8-K 2026-10-28（Item 2.02）' }])).toBe('進場前回看連續 2 次沒有結論：MU 的 8-K 2026-11-20（Item 5.02）、8-K 2026-10-28（Item 2.02）還沒有被 AI 看過。規則偵測照常；月報照規則出。');
  });
});

const PACK = (docs: EvidencePack['documents'], month = '2026-12'): EvidencePack =>
  ({
    run_id: 'r',
    function: 'MOM_ENTRY',
    as_of: '2026-11-27',
    policy: { level: 'A4', verdicts: ['ALLOW', 'ALLOW_WATCH', 'VETO', 'INSUFFICIENT'], abstain: 'INSUFFICIENT', min_evidence: 1, samples: 3 },
    premises: [],
    documents: docs,
    condition_types: [],
    data_quality: {},
    facts: [],
    rule: { action: '', detail: { month } },
  }) as unknown as EvidencePack;

const FILING_DOC = { id: 'D1', source_id: 'edgar:0000000002-26-000020', kind: 'filing' as const, date: '2026-11-05', title: '8-K', text: 'the financial statements for fiscal 2026 should no longer be relied upon because revenue of $40 million was recognized prematurely' };
const NEWS_DOC = { id: 'N1', source_id: 'nasdaq-rss:MU', kind: 'news' as const, date: '2026-11-20', title: '新聞標題', text: '2026-11-20 | Regulators open probe into chipmaker accounting practices' };
const vote = (source: string, quote: string, payload: Record<string, unknown> = { decision: 'VETO', reason_code: 'ACCOUNTING' }) => ({ verdict: 'VETO', evidence: [{ id: 'E1', source_id: source, date: '2026-11-05', quote, claim: 'x' }], payload, report: '財報不可信，營收提前認列。其他理由。' });

describe('T32b：否決要有申報、XBRL 或價格表的引用（§3.3，修 Q10）', () => {
  it('只引用新聞標題的否決票改成「准許，附註」（附註沒寫的補一句）；引用申報原文的照舊否決；lift_condition 不收', () => {
    const pack = PACK([FILING_DOC, NEWS_DOC]);
    const hook = PAYLOAD_HOOKS.MOM_ENTRY;
    const news = vote('nasdaq-rss:MU', 'Regulators open probe into chipmaker accounting practices');
    const o = judge(pack, [news, news, news], hook);
    expect(o.samples.map((s) => s.verdict)).toEqual(['ALLOW_WATCH', 'ALLOW_WATCH', 'ALLOW_WATCH']);
    expect(o.samples[0].payload?.watch_reason).toBe(NEWS_ONLY_VETO_REASON);
    expect(o.samples[0].issues.join('；')).toContain('只有新聞標題');
    expect(courtVerdict(o)).toMatchObject({ decision: 'ALLOW_WATCH', watchReason: NEWS_ONLY_VETO_REASON, source: 'AI' });
    // 自己寫了附註的保留
    const own = vote('nasdaq-rss:MU', 'Regulators open probe into chipmaker accounting practices', { decision: 'VETO', reason_code: 'REGULATORY', watch_reason: '調查還沒有結果' });
    expect(judge(pack, [own], hook).samples[0].payload?.watch_reason).toBe('調查還沒有結果');
    const filing = vote(FILING_DOC.source_id, 'revenue of $40 million was recognized prematurely', { decision: 'VETO', reason_code: 'ACCOUNTING', lift_condition: { type: 'filing_event', text: '重編完成' } });
    const v = judge(pack, [filing, filing, filing], hook);
    expect(v.samples[0].payload).not.toHaveProperty('lift_condition');
    expect(courtVerdict(v)).toMatchObject({ decision: 'VETO', reasonCode: 'ACCOUNTING', source: 'AI', liftCondition: null });
  });
});

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
    if (/companyfacts\/CIK\d+\.json/.test(url)) return Response.json({ cik: 1, facts: {} });
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

const slotTime = (date: string, attempt: Attempt) => new Date(Date.parse(date + 'T23:30:00Z') + { FIRST: 0, MANUAL: 0, FINAL: 2, APPLY: 4 }[attempt] * 3600_000);

interface Ctx {
  db: D1Database;
  env: Env;
  net: Net;
  w: World;
  order: string[];
  cik: (t: string) => number;
  run: (date: string, attempt?: Attempt) => ReturnType<typeof runFlow>;
}

/** 自選 NVDA、核心 VOO；先排一次名（假價格是平滑的指數，月報時的順序和現在相同）。before 在建立帳戶之前做（加申報、改排名、補舊紀錄）。 */
async function withWorld(fn: (c: Ctx) => Promise<void>, before?: (c: Omit<Ctx, 'run'>) => Promise<void>) {
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
    await ingest(env, fetcher, cronTime('2026-11-19'), true);
    const order = (await loadRanking(db))!.order;
    const members = (await loadConstituents(db))!;
    const cik = (t: string) => Number(members.holdings.find((h) => h[0] === t)![2]);
    if (before) await before({ db, env, net, w, order, cik });
    const { view } = buildMarketView(await loadSeries(db, ['VOO', 'SGOV', 'NVDA']), '2026-11-19', 'VOO');
    const acct = createAccount({ paper: true, cash: 5000, core: { VOO: Math.floor(140_000 / view.close.VOO[view.i]) }, own: { NVDA: { shares: Math.floor(40_000 / view.close.NVDA[view.i]), stdWeight: 0.15, premises: [{ id: 'P1', text: '資料中心需求延續到 2027', origin: 'USER' }] } } }, view);
    await saveAccount(db, acct, null, '建立帳戶', new Date('2026-11-19T12:00:00Z'));
    await fn({ db, env, net, w, order, cik, run });
  } finally {
    await d.dispose();
  }
}

const addFiling = (net: Net, cik: number, f: FakeFiling) => {
  const co = net.cos.get(cik) ?? { name: 'SOME CORP', filings: [] };
  co.filings.push(f);
  net.cos.set(cik, co);
};
const accOfT = (cik: number, seq: number) => `${String(cik).padStart(10, '0')}-26-${String(seq).padStart(6, '0')}`;
const K402 = '<html><body><p>Item 4.02 Non-Reliance on Previously Issued Financial Statements.</p><p>On November 3, 2026, the Audit Committee concluded that the previously issued financial statements for fiscal 2026 should no longer be relied upon because revenue of $40 million was recognized prematurely.</p></body></html>';
const K701 = '<html><body><p>Item 7.01 Regulation FD Disclosure.</p><p>On November 18, 2026, the Company lowered its full-year revenue guidance to $10.0 billion from $12.0 billion, citing weaker demand.</p></body></html>';
function add402(c: Pick<Ctx, 'net' | 'cik'>, t: string, seq: number, date: string): string {
  const acc = accOfT(c.cik(t), seq);
  addFiling(c.net, c.cik(t), { accession: acc, form: '8-K', items: '4.02,9.01', acceptanceDateTime: `${date}T21:05:00.000Z`, filingDate: date, primaryDocument: `k402-${seq}.htm`, html: K402 });
  return acc;
}

const runsOf = async (db: D1Database, fn: string) => (await listRuns(db, new Date('2026-11-01T00:00:00Z'), { limit: 500 })).filter((r) => r.fn === fn).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
const reviewsOf = async (db: D1Database) => new Map((await loadReviews(db, '2026-12')).map((r) => [r.ticker, r]));
const alertsOf = async (db: D1Database, kind: string) => (await db.prepare('SELECT message FROM alerts WHERE kind = ? ORDER BY id').bind(kind).all<{ message: string }>()).results.map((r) => r.message);
async function post(db: D1Database, run: AiRun, samples: unknown[], at: Date) {
  const task = await db.prepare('SELECT * FROM ai_tasks WHERE id = ?').bind(run.taskId).first();
  return finalizeRun(db, task as never, { samples }, at);
}
const veto3 = (run: AiRun) => {
  const doc = run.pack.documents.find((x) => x.kind === 'filing')!;
  const one = { run_id: run.pack.run_id, verdict: 'VETO', premise_checks: [{ premise_id: 'P2', status: 'BROKEN', evidence_ids: ['E1'] }], evidence: [{ id: 'E1', source_id: doc.source_id, date: doc.date, quote: 'revenue of $40 million was recognized prematurely', claim: '營收提前認列' }], payload: { decision: 'VETO', reason_code: 'ACCOUNTING' }, report: '財報不可信：營收提前認列。其他理由。' };
  return [one, one, one];
};
const monthlyOf = async (db: D1Database, id: number | null) => (await loadAccount(db))!.acct.notifs.find((n) => n.id === id)!;

// ---------------------------------------------------------------- 進場前回看

describe('T32b：進場前回看（§3.2）', () => {
  it('上月第 20 名的股票這個月進前 5：回看掃描有它的 8-K；回看標到財測下修 → 01:30 開法庭（事件收掉、標記往前推）；只有新聞標題的命中 → 准許，附註、不開法庭', async () => {
    let acc0 = '';
    await withWorld(
      async ({ db, order, run }) => {
        const [a, , c] = order;
        for (const d of ['2026-11-20', '2026-11-23', '2026-11-24', '2026-11-25']) await run(d);
        // 每日掃描的對象是上月底的第 6～10 名，看不到 a
        for (const s of await runsOf(db, 'EVENT_SCAN')) expect(s.pack.documents.map((x) => x.source_id)).not.toContain(`edgar:${acc0}`);
        await run('2026-11-27');
        let rev = await reviewsOf(db);
        expect(rev.get(a)).toMatchObject({ decision: 'ALLOW', source: 'RULE' });
        // 回看：a 的 8-K 在裡面，角色是進場候選
        const [lb] = (await runsOf(db, 'EVENT_SCAN')).filter((r) => r.runId.includes('_LOOKBACK_'));
        expect(lb.pack.rule.detail).toMatchObject({ kind: 'LOOKBACK', month: '2026-12' });
        const doc = lb.pack.documents.find((x) => x.source_id === `edgar:${acc0}`)!;
        expect(doc.text).toContain('lowered its full-year revenue guidance');
        expect(lb.pack.facts.find((f) => f.label === a)?.value).toBe('動能進場候選（本月）');
        // 只有新聞標題的命中（每日掃描在 c 還是候選時標的監管候選）→ 准許，附註、不開法庭；事件收掉
        expect(rev.get(c)).toMatchObject({ decision: 'ALLOW_WATCH', source: 'RULE', watchReason: '新聞標題標到「重大監管或訴訟」（11-18），只有標題、沒有申報，不能否決' });
        expect((await runsOf(db, 'MOM_ENTRY')).map((r) => r.ticker)).not.toContain(c);
        expect((await loadEvents(db, { ticker: c }))[0]).toMatchObject({ status: 'HANDLED', handled_note: 'F1 2026-12：RULE' });
        // 回看標到財測下修（申報）→ 01:30 套用、同一次開法庭
        await post(db, lb, [{ run_id: lb.pack.run_id, verdict: 'FLAGGED', evidence: [], payload: { events: [{ ticker: a, class: 'GUIDANCE_CUT', sub: 'CUT', source_id: `edgar:${acc0}` }] }, report: '標了一件。' }], new Date('2026-11-28T00:10:00Z'));
        await run('2026-11-27', 'FINAL');
        rev = await reviewsOf(db);
        const court = (await runsOf(db, 'MOM_ENTRY')).find((r) => r.ticker === a)!;
        expect(court.createdAt).toBe('2026-11-28T01:30:00.000Z');
        expect(rev.get(a)).toMatchObject({ decision: 'PENDING', runId: court.runId, courtTries: 1, evidenceKey: `EARNINGS_DIVERGENCE|SCAN_GUIDANCE_CUT|${acc0}` });
        expect(court.pack.documents.find((x) => x.source_id === `edgar:${acc0}`)?.kind).toBe('filing');
        expect(court.pack.rule.detail).toMatchObject({ month: '2026-12', reasons: ['NEVER'] });
        expect((await loadEvents(db, { ticker: a })).find((e) => e.sub === 'SCAN_GUIDANCE_CUT')).toMatchObject({ status: 'HANDLED', handled_note: `F1 2026-12：${court.runId}`, detail_code: 'CUT' });
        expect((await db.prepare('SELECT value FROM flow_state WHERE key = ?').bind(`lookback:${a}`).first<{ value: string }>())!.value).toBe('2026-11-18T21:00:00.000Z');
        // 月報：c 那一項寫附註
        const m = await run('2026-11-30');
        const monthly = await monthlyOf(db, m.monthly);
        expect(monthly.items.find((i) => i.f === 'F1' && i.ticker === c)!.note).toBe('准許，附註：新聞標題標到「重大監管或訴訟」（11-18），只有標題、沒有申報，不能否決');
      },
      async ({ db, net, order, cik }) => {
        // 上個月底的排名：a 是第 20 名（每日掃描的候選是第 6～10 名）
        const last = [...order.slice(1, 20), order[0], ...order.slice(20)];
        await db.prepare('UPDATE rankings SET ord = ? WHERE session = (SELECT MAX(session) FROM rankings)').bind(JSON.stringify(last)).run();
        acc0 = accOfT(cik(order[0]), 701);
        addFiling(net, cik(order[0]), { accession: acc0, form: '8-K', items: '7.01', acceptanceDateTime: '2026-11-18T21:00:00.000Z', filingDate: '2026-11-18', primaryDocument: 'k701.htm', html: K701 });
        await db
          .prepare("INSERT INTO sec_events (ticker, accession, form, event_date, accepted_at, code, sub, by_rule, display_only, source, detail, status, created_at) VALUES (?, ?, 'NEWS', '2026-11-18', NULL, 'REGULATORY', 'SCAN_REGULATORY_CANDIDATE', 0, 0, 'SCAN', '每日掃描標記：REGULATORY_CANDIDATE', 'NEW', '2026-11-18T23:40:00.000Z')")
          .bind(order[2], `nasdaq-rss:${order[2]}:2026-11-18`)
          .run();
      },
    );
  });
});

// ---------------------------------------------------------------- 沿用、重開、逾時

describe('T32b：有新證據才重開（§3.4）、失敗與重試（§3.3）', () => {
  it('同一批證據第二個月不開法庭、否決沿用、遞補照記；新的 10-Q → 重開；法庭逾時 → 01:30 重開 → 再逾時 → 告警與月報說明', async () => {
    const accs: string[] = [];
    await withWorld(
      async ({ db, order, run }) => {
        const [a, b, c] = order;
        for (const d of ['2026-11-20', '2026-11-23', '2026-11-24', '2026-11-25']) await run(d);
        await run('2026-11-27');
        let rev = await reviewsOf(db);
        let courts = await runsOf(db, 'MOM_ENTRY');
        // a：同一批證據 → 不開法庭、否決沿用
        expect(courts.map((r) => r.ticker)).not.toContain(a);
        expect(rev.get(a)).toMatchObject({ decision: 'VETO', source: 'AI', reasonCode: 'ACCOUNTING', carriedFrom: '2026-11', runId: `2026-10-29_MOM_ENTRY_${a}_abcdef` });
        expect(rev.get(a)!.note).toBe(`沿用 2026-11 的進場審查（2026-10-29_MOM_ENTRY_${a}_abcdef）：之後沒有新的財報，命中沒有變`);
        // b：上次之後有新的 10-Q → 重開
        const cb = courts.find((r) => r.ticker === b)!;
        expect(cb.pack.rule.detail).toMatchObject({ reasons: ['FILING'] });
        // c：第一次審 → 開法庭
        const c1 = courts.find((r) => r.ticker === c)!;
        expect(rev.get(c)).toMatchObject({ decision: 'PENDING', runId: c1.runId, courtTries: 1 });
        await post(db, cb, veto3(cb), new Date('2026-11-28T00:10:00Z'));
        // 01:30：c 的法庭逾時（照規則結束）→ 重開一次
        await run('2026-11-27', 'FINAL');
        courts = await runsOf(db, 'MOM_ENTRY');
        const cs = courts.filter((r) => r.ticker === c);
        expect(cs).toHaveLength(2);
        expect(cs[1].createdAt).toBe('2026-11-28T01:30:00.000Z');
        expect(cs[1].pack.rule.detail).toMatchObject({ reasons: ['RETRY'] });
        rev = await reviewsOf(db);
        expect(rev.get(b)).toMatchObject({ decision: 'VETO', source: 'AI', carriedFrom: null });
        expect(rev.get(c)).toMatchObject({ decision: 'PENDING', runId: cs[1].runId, courtTries: 2 });
        expect(await alertsOf(db, 'F1_COURT_FAILED')).toEqual([]);
        // 月報：再逾時 → 照規則准許、告警、那一項寫明
        const m = await run('2026-11-30');
        rev = await reviewsOf(db);
        expect(rev.get(c)).toMatchObject({ decision: 'ALLOW', source: 'DEFAULT' });
        const why = `規則偵測命中：8-K 4.02（2026-11-05）；進場審查 2 次沒有結論（逾時、逾時），照規則進場`;
        expect(rev.get(c)!.note).toBe(why);
        expect(await alertsOf(db, 'F1_COURT_FAILED')).toEqual([courtFailedText(c, ['逾時', '逾時'], rev.get(c)!.hits)]);
        expect((await alertsOf(db, 'F1_COURT_FAILED'))[0]).toBe(`${c} 的進場審查連續 2 次沒有結論（逾時、逾時）。規則偵測命中：8-K 4.02（2026-11-05）。月報照規則讓它進場；不想買可以在月報對 ${c} 按「排除」。`);
        const monthly = await monthlyOf(db, m.monthly);
        expect(monthly.items.find((i) => i.f === 'F1' && i.ticker === c)!.note).toBe(why);
        // 否決（含沿用的）由下一名遞補，遞補照記
        expect(monthly.monthly!.input.vetoed).toEqual(expect.arrayContaining([a, b]));
        expect(monthly.monthly!.input.vetoCarried).toEqual({ [a]: '2026-11' });
        const entries = monthly.items.filter((i) => i.f === 'F1').map((i) => i.ticker!);
        expect(entries).not.toContain(a);
        expect(entries).toContain(rev.get(a)!.replacedBy);
        expect(entries).toContain(rev.get(b)!.replacedBy);
        // 遞補者的說明：沿用的否決後面加「（沿用 2026-11 的審查）」
        const acct = (await loadAccount(db))!.acct;
        const { view, axis } = buildMarketView(await loadSeries(db, ['VOO', ...order]), '2026-11-30', 'VOO');
        const firstRep = monthly.items.find((i) => i.f === 'F1' && i.ticker === rev.get(a)!.replacedBy)!;
        expect(explainItem({ acct, view, axis, rankOrder: order, aiNotes: [] } as never, monthly, firstRep).why).toContain(`${a}（沿用 2026-11 的審查）`);
      },
      async ({ db, net, order, cik }) => {
        const [a, b, c] = order;
        accs.push(add402({ net, cik }, a, 20, '2026-10-20'), add402({ net, cik }, b, 20, '2026-10-20'), add402({ net, cik }, c, 20, '2026-11-05'));
        addFiling(net, cik(b), { accession: accOfT(cik(b), 30), form: '10-Q', items: '', acceptanceDateTime: '2026-11-10T21:00:00.000Z', filingDate: '2026-11-10', primaryDocument: 'q.htm', html: '<p>10-Q</p>' });
        // 上個月（2026-11 月報）的法庭：三票否決（同一份 4.02）
        const ins = db.prepare("INSERT INTO mom_reviews (month, ticker, rank, decision, reason_code, source, hits, run_id, watch_reason, note, evidence_key, created_at, updated_at) VALUES ('2026-11', ?, 3, 'VETO', 'ACCOUNTING', 'AI', '[]', ?, NULL, '3 票一致：VETO。', ?, '2026-10-30T01:00:00Z', '2026-10-30T01:00:00Z')");
        await db.batch([a, b].map((t, k) => ins.bind(t, `2026-10-29_MOM_ENTRY_${t}_abcdef`, `ACCOUNTING|8K_4.02|${accs[k]}`)));
      },
    );
  });
});

// ---------------------------------------------------------------- 月報之後才回來的否決

describe('T32b：月報之後才回來的否決（§3.3）', () => {
  it('月報當天才進榜：先照規則准許（進場審查進行中）→ 月報之後開法庭 → 01:30 回來三票否決 → 月報不改、那一項加 AI 那一行、LINE 補推一則（只一次）', async () => {
    await withWorld(
      async ({ db, net, order, run }) => {
        const b = order[1];
        for (const d of ['2026-11-20', '2026-11-23', '2026-11-24', '2026-11-25']) await run(d);
        // 11-27 的流程沒有跑（月報前一天沒有先審）；11-30 補做 11-27 與 11-30
        const m = await run('2026-11-30');
        let rev = await reviewsOf(db);
        expect(rev.get(b)).toMatchObject({ decision: 'ALLOW', source: 'DEFAULT', late: true });
        let monthly = await monthlyOf(db, m.monthly);
        expect(monthly.items.find((i) => i.f === 'F1' && i.ticker === b)!.note).toBe('規則偵測命中：8-K 4.02（2026-11-05）；進場審查進行中，台灣 11:30 前更新');
        // 月報之後同一次流程開法庭（decision 不改）
        const court = (await runsOf(db, 'MOM_ENTRY')).find((r) => r.ticker === b)!;
        expect(court.createdAt).toBe('2026-11-30T23:30:00.000Z');
        expect(rev.get(b)).toMatchObject({ decision: 'ALLOW', runId: court.runId, courtTries: 1 });
        await post(db, court, veto3(court), new Date('2026-12-01T00:10:00Z'));
        const before = net.line.length;
        await run('2026-11-30', 'FINAL');
        rev = await reviewsOf(db);
        expect(rev.get(b)).toMatchObject({ decision: 'ALLOW', lateVerdict: 'VETO', reasonCode: 'ACCOUNTING', lateTold: true });
        monthly = await monthlyOf(db, m.monthly);
        expect(monthly.monthly!.input.vetoed ?? []).not.toContain(b);
        const it = monthly.items.find((i) => i.f === 'F1' && i.ticker === b)!;
        expect(it.choice).toBe('DO');
        expect(it.aiLine).toBe('進場審查（3 票）在月報之後回來：否決（財報可信度）。財報不可信：營收提前認列。');
        const pushed = net.line.slice(before);
        const late = pushed.filter((t) => t.includes('的進場審查回來了'));
        expect(late).toHaveLength(1);
        expect(late[0]).toContain(`${b} 的進場審查回來了：3 票否決（財報可信度）。12 月月報 #${monthly.id} 已更新，預設仍是照規則買進；要照否決，到網站對 ${b} 按「排除」（排除會一直有效，之後要在帳戶頁取消）。`);
        expect(late[0]).toContain(`#/n/${monthly.id}`);
        // 03:30 不再補推
        const n2 = net.line.length;
        await run('2026-11-30', 'APPLY');
        expect(net.line.slice(n2).filter((t) => t.includes('的進場審查回來了'))).toEqual([]);
        // 按「排除」時理由欄先填
        const acct = (await loadAccount(db))!.acct;
        // T80（allocation_redesign §1.2）：清單的核心那幾行照比例買賣 VOO 與 SGOV，畫面要有 SGOV 的價格
        const { view } = buildMarketView(await loadSeries(db, ['VOO', 'SGOV', ...order]), '2026-11-30', 'VOO');
        const v = notifView({ mode: 'real', acct, view, axis: [], rankOrder: order, rankSession: null, aiNotes: [], events: [], shadow: [] } as never, monthly).items.find((x) => x.key === it.key)!;
        expect(v.actions.find((x) => x.id === 'EXCLUDE')?.prefill).toBe('AI 否決：財報可信度');
        expect(v.aiLine).toBe(it.aiLine);
        // 影子紀錄（存在 shadow_records）
        const shadows = (await db.prepare("SELECT body FROM shadow_records WHERE f = 'F1'").all<{ body: string }>()).results.map((r) => JSON.parse(r.body) as { choice: string });
        expect(shadows.find((s) => s.choice === 'LATE_VETO')).toMatchObject({ f: 'F1', ticker: b, ai: 0, notif: monthly.id, runIds: [court.runId] });
      },
      async ({ net, order, cik }) => {
        add402({ net, cik }, order[1], 20, '2026-11-05');
      },
    );
  });

  // 引擎情境（s4）的一月月報：直接套用一個三票否決的結果，看三種月報狀態
  async function lateCase(state: 'PENDING' | 'RESPONDED' | 'DONE') {
    const sc = scenarios.s4();
    const sim = new Sim(sc.market, sc.init);
    // 動能少一檔（AI 建議出場、照做），一月月報才有新進場的項目（同 t32a 的寫法）
    sim.runUntil('2026-12-10');
    sim.day();
    const r = hardEvent(sim.acct, sim.pre, 'ORCL', 'ACCOUNTING', false, ['run-f19']);
    sim.acct = r.acct;
    const it19 = r.notif!.items.find((i) => i.f === 'F19')!;
    sim.respond(r.notif!.id, { mode: 'DO', choices: { [it19.key]: 'AI' } });
    sim.open();
    sim.runUntil('2027-01-04');
    const m = sim.preOpen()!;
    const f1 = m.items.find((i) => i.f === 'F1')!;
    expect(f1).toBeTruthy();
    if (state !== 'PENDING') sim.respond(m.id, { mode: 'DO' });
    if (state === 'DONE') sim.open();
    const d = await freshDb();
    try {
      const db = d.db;
      const t = f1.ticker!;
      await db.prepare("INSERT INTO mom_reviews (month, ticker, rank, decision, source, hits, run_id, late, created_at, updated_at) VALUES (?, ?, 4, 'ALLOW', 'DEFAULT', '[]', 'R-late', 1, 'x', 'x')").bind(sim.month, t).run();
      const pack = PACK([FILING_DOC], sim.month);
      const outcome = judge(pack, [vote(FILING_DOC.source_id, 'revenue of $40 million was recognized prematurely'), vote(FILING_DOC.source_id, 'revenue of $40 million was recognized prematurely'), vote(FILING_DOC.source_id, 'revenue of $40 million was recognized prematurely')], PAYLOAD_HOOKS.MOM_ENTRY);
      const run = { runId: 'R-late', fn: 'MOM_ENTRY', ticker: t, asOf: sim.pre.date, createdAt: 'x', status: 'DONE', taskId: null, promptVersion: 'mom_entry_v2', packHash: '', pack, packNotes: [], outcome, process: [], completedAt: 'x', repoCommit: null } as AiRun;
      const ctx: ApplyCtx = { db, acct: sim.acct, view: sim.pre, axis: [], session: sim.pre.date, now: new Date('2027-01-05T01:30:00Z'), stmts: [], log: [], alerts: [] };
      await applyMomEntry(ctx, run);
      await db.batch(ctx.stmts);
      const n = ctx.acct.notifs.find((x) => x.id === m.id)!;
      const it = n.items.find((i) => i.key === f1.key)!;
      const row = (await loadReviews(db, sim.month))[0];
      return { t, n, it, row, acct: ctx.acct, log: ctx.log };
    } finally {
      await d.dispose();
    }
  }

  it('還沒回覆：項目加 AI 那一行、預設仍是照規則買進、補推一則（說明怎麼排除）；影子紀錄', async () => {
    const { t, n, it, row, acct } = await lateCase('PENDING');
    expect(n.status).toBe('PENDING');
    expect(it.choice).toBe('DO');
    expect(it.aiLine).toBe('進場審查（3 票）在月報之後回來：否決（財報可信度）。財報不可信，營收提前認列。');
    expect(it.lateVeto?.push).toBe(`${t} 的進場審查回來了：3 票否決（財報可信度）。1 月月報 #${n.id} 已更新，預設仍是照規則買進；要照否決，到網站對 ${t} 按「排除」（排除會一直有效，之後要在帳戶頁取消）。`);
    expect(row).toMatchObject({ decision: 'ALLOW', lateVerdict: 'VETO', reasonCode: 'ACCOUNTING', lateTold: true });
    const sh = acct.shadow.find((s) => s.choice === 'LATE_VETO')!;
    expect(sh).toMatchObject({ f: 'F1', ticker: t, ai: 0, notif: n.id, runIds: ['R-late'] });
    expect(sh.rule).toBeGreaterThan(0);
    // 補推只做一次：推出去之後拿掉
    const fu = lateVetoWaiter.followUps!(acct);
    expect(fu.map((f) => [f.notif, f.text])).toEqual([[n.id, it.lateVeto!.push]]);
    fu[0].told(acct);
    expect(lateVetoWaiter.followUps!(acct)).toEqual([]);
  });

  it('已回覆、還沒填快照：同樣更新項目，推一則提醒（還沒下單的話可以回通知排除）', async () => {
    const { t, n, it, row } = await lateCase('RESPONDED');
    expect(n.status).toBe('RESPONDED');
    expect(it.aiLine).toContain('在月報之後回來：否決（財報可信度）');
    expect(it.lateVeto?.push).toBe(`${t} 的進場審查回來了：3 票否決（財報可信度）。你已經決定了；還沒下單的話可以回通知 #${n.id} 對 ${t} 按「排除」（排除會一直有效，之後要在帳戶頁取消）。`);
    expect(row).toMatchObject({ lateVerdict: 'VETO', lateTold: true });
  });

  it('已經填快照：只更新項目，不推', async () => {
    const { n, it, row, acct } = await lateCase('DONE');
    expect(n.status).toBe('DONE');
    expect(it.aiLine).toContain('在月報之後回來：否決（財報可信度）');
    expect(it.lateVeto).toMatchObject({ code: 'ACCOUNTING', runId: 'R-late' });
    expect(it.lateVeto?.push).toBeUndefined();
    expect(lateVetoWaiter.followUps!(acct)).toEqual([]);
    expect(row).toMatchObject({ decision: 'ALLOW', lateVerdict: 'VETO' });
  });
});
