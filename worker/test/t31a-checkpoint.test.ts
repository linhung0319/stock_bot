// T31a：月底檢查點、審查失敗告警、拿掉 R1（own_thesis §3.7、§3.6.4、§3.9）。
// 完成條件：
//   六種「新證據」的原因各一個測試（NEVER、FILING、EVENT、THESIS、STALE、UNKNOWN）
//   一項都沒有時不開審查（reviewSkip、持股頁那一句、運作統計「審了幾檔、跳過幾檔」）
//   新聞標題不算新證據
//   連續 2 次失敗告警、票數不一致不算失敗、跑完一次歸零
//   連續 3 次票數不一致列進「要看的事」（NO_CONSENSUS）
//   拿掉 R1 之後重放驗收的數字完全相同（test/replay.test.ts；這裡另外確認每日檢查與證據包不再有 R1）
// 對外請求全部是假的：價格、成分股（固定檔）、EDGAR、Nasdaq RSS、雲端排程、LINE。
import { describe, expect, it } from 'vitest';
import type { EvidencePack, Outcome } from '../src/ai/check';
import { ownRuleFacts } from '../src/ai/pack';
import type { ApplyCtx } from '../src/app/aiCtx';
import { finalizeRun, getRun, listRuns, type AiRun } from '../src/app/aiRuns';
import type { Env, Fetcher } from '../src/app/env';
import { runFlow, type Attempt } from '../src/app/flow';
import { LINE_PUSH_URL } from '../src/app/line';
import { loadAccount, saveAccount } from '../src/app/ledgerStore';
import { buildOpsReport, checkpointSection } from '../src/app/opsReport';
import { checkpointKey, startOwnReview } from '../src/app/ownAi';
import { loadFails, nextCheckpoint, reviewFailText, reviewHealth, reviewHealthStmts, reviewStartFailed } from '../src/app/reviewHealth';
import { dueAttention, newEvidence, ownAttention, reviewFailsKey, reviewSplitsKey, thesisFile, type ThesisEvent, type ThesisFile } from '../src/app/thesis';
import type { CompanyFacts, XbrlFact } from '../src/data/edgar';
import { buildMarketView } from '../src/data/marketView';
import { loadSeries } from '../src/data/store';
import { createAccount, dailyCheck, type Account, type MarketView, type OwnMeta } from '../src/engine';
import * as engine from '../src/engine';
import type { HoldingDetail } from '../src/app/site/views';
import { handle } from '../src/index';
import { freshDb } from './helpers/d1';
import { makeMarket, viewAt } from './helpers/market';
import { cronTime, fakeFetcher, newWorld, type World } from './helpers/fakeSources';

// ---------------------------------------------------------------- 純函式用的假論點檔

const ASOF = '2026-11-27';
const LAST = { runId: 'rev-1', asOf: '2026-11-06', createdAt: '2026-11-06T16:00:00.000Z', thesisVersion: 1 };
function fileOf(o: Partial<ThesisFile> = {}): ThesisFile {
  return {
    ticker: 'MU',
    fileId: 'MU@2026-01-02',
    openedAt: '2026-01-02',
    origin: 'NEW',
    kind: 'THESIS',
    status: 'OPEN',
    thesis: { text: 'HBM 需求延續', setAt: '2026-01-02', source: 'TYPED', version: 1, afterBreak: 0, lastAfterBreakAt: null },
    premises: [],
    conditions: [],
    events: [],
    reviews: [],
    disputes: [],
    flags: [],
    lastReview: LAST,
    newSince: '2026-07-30',
    log: [],
    ...o,
  };
}
const filing = (form: string, filingDate: string, acceptedAt = `${filingDate}T21:00:00.000Z`) => ({ form, filingDate, acceptedAt });
/** 上一次審查之前的申報（不算）。 */
const OLD_FILINGS = [filing('10-Q', '2026-10-30'), filing('8-K', '2026-11-05')];
function event(o: Partial<ThesisEvent> = {}): ThesisEvent {
  return { id: 1, date: '2026-11-10', source: 'SCAN', code: 'MGMT_CHANGE', sub: 'SCAN_MGMT_CHANGE', form: '8-K', sourceId: 'edgar:0001045810-26-000400', accession: '0001045810-26-000400', detail: null, status: 'INFO', displayOnly: true, createdAt: '2026-11-10T16:00:00.000Z', isNew: true, ...o };
}

describe('新證據（newEvidence）：六種原因各一個', () => {
  it('都沒有 → 空的清單（這個月不審）', () => {
    expect(newEvidence(fileOf(), OLD_FILINGS, ASOF)).toEqual([]);
  });

  it('NEVER：這份論點檔還沒有過有結論的審查（只回這一項）', () => {
    expect(newEvidence(fileOf({ lastReview: null }), null, ASOF)).toEqual(['NEVER']);
  });

  it('FILING：那次審查之後申報的 8-K、10-Q、10-K（含修正）；同一天看接受時間；其他表單與決策日之後的不算', () => {
    expect(newEvidence(fileOf(), [...OLD_FILINGS, filing('8-K', '2026-11-12')], ASOF)).toEqual(['FILING']);
    expect(newEvidence(fileOf(), [filing('10-K/A', '2026-11-20')], ASOF)).toEqual(['FILING']);
    // 同一天：審查開始之後才接受的算，之前的不算
    expect(newEvidence(fileOf(), [filing('8-K', '2026-11-06', '2026-11-06T21:00:00.000Z')], ASOF)).toEqual(['FILING']);
    expect(newEvidence(fileOf(), [filing('8-K', '2026-11-06', '2026-11-06T12:00:00.000Z')], ASOF)).toEqual([]);
    // 不算：Form 4、S-8、決策日之後的
    expect(newEvidence(fileOf(), [filing('4', '2026-11-12'), filing('S-8', '2026-11-13'), filing('8-K', '2026-11-30')], ASOF)).toEqual([]);
  });

  it('EVENT：sec_events 有建立時間比那次審查晚的列（任何狀態）；價格規則與新聞標題來源的不算', () => {
    expect(newEvidence(fileOf({ events: [event()] }), OLD_FILINGS, ASOF)).toEqual(['EVENT']);
    expect(newEvidence(fileOf({ events: [event({ status: 'HANDLED', source: 'EDGAR' })] }), OLD_FILINGS, ASOF)).toEqual(['EVENT']);
    // 建立時間在審查之前（事件日期再新也一樣）
    expect(newEvidence(fileOf({ events: [event({ createdAt: '2026-11-06T10:00:00.000Z' })] }), OLD_FILINGS, ASOF)).toEqual([]);
    expect(newEvidence(fileOf({ events: [event({ source: 'PRICE', code: 'PRICE_DROP', form: 'PRICE', sourceId: 'price:MU', accession: null })] }), OLD_FILINGS, ASOF)).toEqual([]);
  });

  it('新聞標題不算新證據：每日掃描從新聞標題標的事件（含條件提示）不算', () => {
    const news = event({ form: 'NEWS', sourceId: 'nasdaq-rss:MU:2026-11-20', accession: null, code: 'GUIDANCE_CUT', createdAt: '2026-11-21T00:00:00.000Z' });
    const hint = event({ form: 'NEWS', sourceId: 'nasdaq-rss:MU:2026-11-22', accession: null, code: 'CONDITION_HINT', status: 'INFO', createdAt: '2026-11-22T00:00:00.000Z' });
    expect(newEvidence(fileOf({ events: [news, hint] }), OLD_FILINGS, ASOF)).toEqual([]);
  });

  it('THESIS：論點版本和那次證據包記的不同、那次之後有 THESIS 紀錄、或有條件的變動（CONDITION）', () => {
    const v2 = fileOf({ thesis: { ...fileOf().thesis!, version: 2 } });
    expect(newEvidence(v2, OLD_FILINGS, ASOF)).toEqual(['THESIS']);
    const log = (kind: string, at: string) => ({ id: 1, kind, session: at.slice(0, 10), at, ref: null, body: {}, accountVersion: null });
    expect(newEvidence(fileOf({ log: [log('CONDITION', '2026-11-12T03:00:00.000Z')] }), OLD_FILINGS, ASOF)).toEqual(['THESIS']);
    // 舊的執行沒有記版本：靠 log 的 THESIS
    expect(newEvidence(fileOf({ lastReview: { ...LAST, thesisVersion: null }, log: [log('THESIS', '2026-11-12T03:00:00.000Z')] }), OLD_FILINGS, ASOF)).toEqual(['THESIS']);
    // 審查之前的紀錄、其他種類的紀錄不算
    expect(newEvidence(fileOf({ log: [log('CONDITION', '2026-11-05T03:00:00.000Z'), log('BREAK_NOTICE', '2026-11-12T03:00:00.000Z')] }), OLD_FILINGS, ASOF)).toEqual([]);
  });

  it('STALE：距那次審查的決策日滿 100 個日曆天（99 天不算）', () => {
    const at = (asOf: string) => fileOf({ lastReview: { ...LAST, asOf, createdAt: `${asOf}T16:00:00.000Z` } });
    expect(newEvidence(at('2026-08-19'), [], ASOF)).toEqual(['STALE']); // 100 天
    expect(newEvidence(at('2026-08-20'), [], ASOF)).toEqual([]); // 99 天
  });

  it('UNKNOWN：申報清單抓不到 → 當成有新證據', () => {
    expect(newEvidence(fileOf(), null, ASOF)).toEqual(['UNKNOWN']);
    expect(newEvidence(fileOf({ events: [event()] }), null, ASOF)).toEqual(['EVENT', 'UNKNOWN']);
  });
});

// ---------------------------------------------------------------- 審查的兩個計數（reviewHealth）

const outcome = (status: Outcome['status'], reason = ''): Outcome => ({ status, verdict: null, votes: {}, actionable: false, followRule: true, reason, samples: [] });
const runOf = (runId: string, asOf: string, o: Outcome | null, ticker = 'MU'): AiRun => ({ runId, fn: 'OWN_REVIEW', ticker, asOf, createdAt: `${asOf}T15:30:00.000Z`, status: 'DONE', taskId: null, promptVersion: 'own_review_v2', packHash: '', pack: {} as EvidencePack, packNotes: [], outcome: o, process: [], completedAt: null, repoCommit: null });
const miniAcct = (fileId = 'MU@2026-01-02') => ({ own: { MU: { fileId } as OwnMeta } }) as unknown as Account;

/** 套用一次（和每日流程一樣：語句和帳戶同一批寫入）。回傳這次的告警。 */
async function applyHealth(db: D1Database, run: AiRun, acct = miniAcct()) {
  const ctx = { db, acct, session: run.asOf, now: new Date(`${run.asOf}T17:30:00.000Z`), stmts: [], log: [], alerts: [] } as unknown as ApplyCtx;
  await reviewHealthStmts(ctx, run);
  if (ctx.stmts.length) await db.batch(ctx.stmts);
  return { alerts: ctx.alerts ?? [], log: ctx.log };
}
const stateOf = async (db: D1Database, key: string) => {
  const v = (await db.prepare('SELECT value FROM flow_state WHERE key = ?').bind(key).first<{ value: string }>())?.value;
  return v ? JSON.parse(v) : null;
};

describe('審查失敗的告警與兩個計數（own_thesis §3.6.4）', () => {
  it('哪些算失敗：逾時、觸發失敗、整份退回、三票格式都不合格、資料缺漏；票數不一致、三票一致不算', () => {
    expect(reviewHealth(outcome('TIMEOUT'))).toEqual({ kind: 'FAILED', reason: '逾時' });
    expect(reviewHealth(outcome('NO_RESULT', '雲端排程沒有觸發成功（HTTP 500），照規則。'))).toEqual({ kind: 'FAILED', reason: '觸發失敗' });
    expect(reviewHealth(outcome('NO_RESULT', '送回的結果被退回（格式不合格），照規則。'))).toEqual({ kind: 'FAILED', reason: '整份退回' });
    expect(reviewHealth(outcome('INVALID'))).toEqual({ kind: 'FAILED', reason: '三票格式都不合格' });
    expect(reviewHealth(outcome('DATA_MISSING'))).toEqual({ kind: 'FAILED', reason: '資料缺漏' });
    expect(reviewHealth(outcome('SPLIT')).kind).toBe('SPLIT');
    expect(reviewHealth(outcome('AGREED')).kind).toBe('CONSENSUS');
    expect(reviewHealth(outcome('INSUFFICIENT')).kind).toBe('CONSENSUS');
  });

  it('連續 2 次沒有結論 → 告警（日期與原因、下一次審查）；之後每多一次再推；票數不一致不算失敗、歸零；跑完一次歸零', async () => {
    const d = await freshDb();
    try {
      const db = d.db;
      expect((await applyHealth(db, runOf('r1', '2026-11-27', outcome('TIMEOUT')))).alerts).toEqual([]);
      const second = await applyHealth(db, runOf('r2', '2026-12-04', outcome('DATA_MISSING')));
      expect(second.alerts).toHaveLength(1);
      expect(second.alerts[0]).toMatchObject({ kind: 'REVIEW_FAILED', message: 'MU 的 AI 審查連續 2 次沒有結論（11-27 逾時、12-04 資料缺漏）。規則照常；下一次審查在 12-30 的月底檢查點，有新財報時會提早。' });
      // 第 3 次再推一次
      const third = await applyHealth(db, runOf('r3', '2026-12-07', outcome('INVALID')));
      expect(third.alerts.map((a) => a.message)).toEqual(['MU 的 AI 審查連續 3 次沒有結論（11-27 逾時、12-04 資料缺漏、12-07 三票格式都不合格）。規則照常；下一次審查在 12-30 的月底檢查點，有新財報時會提早。']);
      // 票數不一致：跑完了 → 失敗次數歸零，不告警
      expect((await applyHealth(db, runOf('r4', '2026-12-08', outcome('SPLIT')))).alerts).toEqual([]);
      expect(await stateOf(db, reviewFailsKey('MU'))).toBeNull();
      // 歸零之後要再連續 2 次才告警
      expect((await applyHealth(db, runOf('r5', '2026-12-09', outcome('TIMEOUT')))).alerts).toEqual([]);
      expect((await applyHealth(db, runOf('r6', '2026-12-30', outcome('AGREED')))).alerts).toEqual([]);
      expect(await stateOf(db, reviewFailsKey('MU'))).toBeNull();
      expect((await applyHealth(db, runOf('r7', '2027-01-05', outcome('TIMEOUT')))).alerts).toEqual([]);
      expect(await stateOf(db, reviewFailsKey('MU'))).toMatchObject({ count: 1, fails: [{ date: '2027-01-05', reason: '逾時' }] });
    } finally {
      await d.dispose();
    }
  });

  it('沒開成也算一次（另外照舊推 FLOW_ERROR，由呼叫的地方推）；換了論點檔從 0 算；下一個檢查點的日期', async () => {
    const d = await freshDb();
    try {
      const db = d.db;
      expect(await reviewStartFailed(db, 'MU', 'MU@2026-01-02', '2026-11-27', new Date('2026-11-27T15:30:00Z'))).toBeNull();
      const a = await reviewStartFailed(db, 'MU', 'MU@2026-01-02', '2026-11-30', new Date('2026-11-30T15:30:00Z'));
      expect(a?.message).toBe('MU 的 AI 審查連續 2 次沒有結論（11-27 沒開成、11-30 沒開成）。規則照常；下一次審查在 12-30 的月底檢查點，有新財報時會提早。');
      // 移出再加回（新的論點檔）：舊的次數不算
      expect(await loadFails(db, 'MU', 'MU@2026-12-01')).toBeNull();
      expect((await applyHealth(db, runOf('r1', '2026-12-02', outcome('TIMEOUT')), miniAcct('MU@2026-12-01'))).alerts).toEqual([]);
      // 不是自選股：不算
      const ctx = { db, acct: { own: {} }, session: '2026-12-02', now: new Date(), stmts: [], log: [], alerts: [] } as unknown as ApplyCtx;
      await reviewHealthStmts(ctx, runOf('r2', '2026-12-02', outcome('TIMEOUT')));
      expect(ctx.stmts).toEqual([]);
      // 月底檢查點 = 月報前一天（當月倒數第二個交易日）
      expect(nextCheckpoint('2026-11-20')).toBe('2026-11-27');
      expect(nextCheckpoint('2026-11-27')).toBe('2026-12-30');
      // 超過 5 次只列最近 5 次
      expect(reviewFailText('MU', { count: 7, fileId: null, fails: [1, 2, 3, 4, 5].map((k) => ({ date: `2026-12-0${k}`, reason: '逾時' })) }, '2026-12-05')).toContain('連續 7 次沒有結論（最近 5 次：12-01 逾時');
    } finally {
      await d.dispose();
    }
  });

  it('連續 3 次票數不一致 → 列進「要看的事」（NO_CONSENSUS，發生時一次）；失敗不打斷、三票一致歸零', async () => {
    const d = await freshDb();
    try {
      const db = d.db;
      const nc = async (acct = miniAcct()) => {
        const f = await thesisFileStub(db, acct);
        return ownAttention([f], { own: acct.own, rule: { own: {} } as unknown as Account['rule'], notifs: [] }, { date: '2026-12-30' }).filter((x) => x.kind === 'NO_CONSENSUS');
      };
      await applyHealth(db, runOf('s1', '2026-11-27', outcome('SPLIT')));
      await applyHealth(db, runOf('s2', '2026-12-04', outcome('TIMEOUT'))); // 失敗不算，也不打斷
      await applyHealth(db, runOf('s3', '2026-12-08', outcome('SPLIT')));
      expect(await nc()).toEqual([]);
      const third = await applyHealth(db, runOf('s4', '2026-12-30', outcome('SPLIT')));
      expect(third.log.join()).toContain('連續第 3 次（列進要看的事）');
      const hits = await nc();
      expect(hits).toEqual([{ ticker: 'MU', kind: 'NO_CONSENSUS', src: 'own', key: 'NO_CONSENSUS@s1', every: null, since: '2026-12-30', text: 'MU 最近 3 次審查都沒有一致結論，論點可能寫得不夠具體，可以拿去討論' }]);
      // 月報：發生時列一次，第 4 次（同一串）不再列
      const first = dueAttention(hits, {}, '2026-12-30');
      expect(first.due).toHaveLength(1);
      await applyHealth(db, runOf('s5', '2027-01-28', outcome('SPLIT')));
      const again = await nc();
      expect(again[0].text).toContain('最近 4 次');
      expect(dueAttention(again, first.shown, '2027-01-28').due).toEqual([]);
      // 有一次三票一致 → 歸零、不列
      await applyHealth(db, runOf('s6', '2027-02-25', outcome('INSUFFICIENT')));
      expect(await stateOf(db, reviewSplitsKey('MU'))).toBeNull();
      expect(await nc()).toEqual([]);
      // 換了論點檔：舊的次數不算
      await applyHealth(db, runOf('s7', '2027-03-01', outcome('SPLIT')));
      await applyHealth(db, runOf('s8', '2027-03-02', outcome('SPLIT')));
      await applyHealth(db, runOf('s9', '2027-03-03', outcome('SPLIT')));
      expect(await nc()).toHaveLength(1);
      expect(await nc(miniAcct('MU@2027-03-02'))).toEqual([]);
    } finally {
      await d.dispose();
    }
  });
});

/** 只要 splits 的論點檔：用真的 thesisFile 讀 flow_state（帳戶只有 fileId 與一條前提）。 */
async function thesisFileStub(db: D1Database, acct: Account): Promise<ThesisFile> {
  const a = { own: { MU: { ...acct.own.MU, premises: [{ id: 'P4', text: 'x', origin: 'USER' }], origin: 'NEW', flags: [] } } } as unknown as Account;
  return (await thesisFile(db, a, 'MU', '2026-12-30'))!;
}

// ---------------------------------------------------------------- 整條流程：月底檢查點

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
interface FakeFiling {
  accession: string;
  form: string;
  items: string;
  acceptanceDateTime: string;
  filingDate: string;
  primaryDocument: string;
  html: string;
}
const TENQ_FILING: FakeFiling = { accession: '0001045810-26-000300', form: '10-Q', items: '', acceptanceDateTime: '2026-10-30T20:10:00.000Z', filingDate: '2026-10-30', primaryDocument: 'q.htm', html: TENQ };
const OTHER_8K: FakeFiling = { accession: '0001045810-26-000360', form: '8-K', items: '8.01', acceptanceDateTime: '2026-11-24T21:05:00.000Z', filingDate: '2026-11-24', primaryDocument: 'k.htm', html: '<html><body><p>Item 8.01 Other Events.</p><p>The company announced a share repurchase program.</p></body></html>' };

interface Edgar {
  filings: FakeFiling[];
  fireFails: boolean;
}

function fetcherOf(w: World, e: Edgar): Fetcher {
  const base = fakeFetcher(w);
  return async (url, init) => {
    if (url === LINE_PUSH_URL) return Response.json({});
    if (url === 'https://api.example/fire') return e.fireFails ? new Response('down', { status: 500 }) : Response.json({ claude_code_session_url: 'https://claude.ai/code/x' });
    if (/data\.sec\.gov\/submissions\/CIK\d+\.json/.test(url)) {
      const fs = [...e.filings].reverse();
      return Response.json({ cik: '1045810', name: 'NVIDIA CORP', tickers: ['NVDA'], filings: { recent: { accessionNumber: fs.map((f) => f.accession), form: fs.map((f) => f.form), items: fs.map((f) => f.items), acceptanceDateTime: fs.map((f) => f.acceptanceDateTime), filingDate: fs.map((f) => f.filingDate), primaryDocument: fs.map((f) => f.primaryDocument) } } });
    }
    if (/companyfacts\/CIK\d+\.json/.test(url)) return Response.json(BASE);
    const doc = /Archives\/edgar\/data\/\d+\/(\d+)\/(.+)$/.exec(url);
    if (doc) {
      const f = e.filings.find((x) => x.accession.replace(/-/g, '') === doc[1]);
      if (!f) return new Response('nf', { status: 404 });
      return doc[2] === 'index.json' ? Response.json({ directory: { item: [{ name: f.primaryDocument }] } }) : new Response(f.html);
    }
    if (url.startsWith('https://www.nasdaq.com/feed/rssoutbound')) return new Response('<rss><channel></channel></rss>');
    return base(url, init);
  };
}

interface Ctx {
  db: D1Database;
  env: Env;
  e: Edgar;
  fetcher: Fetcher;
  run: (date: string, attempt?: Attempt) => ReturnType<typeof runFlow>;
  viewAt: (date: string) => Promise<{ view: MarketView; axis: string[] }>;
  api: <T = Record<string, unknown>>(path: string, now: Date) => Promise<T>;
}

async function withWorld(fn: (c: Ctx) => Promise<void>, filings: FakeFiling[] = [TENQ_FILING]) {
  const d = await freshDb();
  try {
    const db = d.db;
    const w = newWorld('2026-11-19');
    const e: Edgar = { filings: [...filings], fireFails: false };
    const env: Env = { DB: db, ADMIN_TOKEN: 't', AI_TASK_SECRET: 's', EDGAR_USER_AGENT: 'test bot test@example.com', SITE_URL: 'https://bot.example', LINE_CHANNEL_TOKEN: 'lt', LINE_USER_ID: 'U1', DEV_NO_AUTH: '1', ROUTINE_FIRE_URL: 'https://api.example/fire', ROUTINE_TOKEN: 'rt' };
    const fetcher = fetcherOf(w, e);
    const run = (date: string, attempt: Attempt = 'FIRST') => {
      w.dataDate = date;
      return runFlow(env, fetcher, { now: attempt === 'FINAL' ? new Date(Date.parse(date + 'T23:30:00Z') + 2 * 3600_000) : cronTime(date), attempt });
    };
    const viewAt = async (date: string) => buildMarketView(await loadSeries(db, ['VOO', 'SGOV', 'NVDA']), date, 'VOO');
    const api: Ctx['api'] = async (path, now) => (await (await handle(new Request(`https://bot.example/api/${path}`), env, fetcher, now)).json()) as never;
    await run('2026-11-19');
    const { view } = await viewAt('2026-11-19');
    const acct = createAccount(
      {
        paper: true,
        cash: 5000,
        core: { VOO: Math.floor(140_000 / view.close.VOO[view.i]) },
        own: {
          NVDA: {
            shares: Math.floor(40_000 / view.close.NVDA[view.i]),
            stdWeight: 0.15,
            premises: [
              { id: 'P1', text: '資料中心需求延續到 2027', origin: 'USER' },
              { id: 'P2', text: '毛利率維持在 55% 以上', origin: 'USER' },
            ],
          },
        },
      },
      view,
    );
    await saveAccount(db, acct, null, '建立帳戶', new Date('2026-11-19T12:00:00Z'));
    await fn({ db, env, e, fetcher, run, viewAt, api });
  } finally {
    await d.dispose();
  }
}

async function postResult(db: D1Database, runId: string, samples: unknown[], at: Date) {
  const run = (await getRun(db, runId))!;
  const task = await db.prepare('SELECT * FROM ai_tasks WHERE id = ?').bind(run.taskId).first();
  return finalizeRun(db, task as never, { samples }, at);
}
/** 一份合格的 F24 票（前提都成立，引用 10-Q）。 */
function vote(pack: EvidencePack, verdict: string) {
  const q = pack.documents.find((d) => d.source_id === `edgar:${TENQ_FILING.accession}`)!;
  return {
    run_id: pack.run_id,
    verdict,
    model: 'claude-opus-5-5',
    premise_checks: [
      { premise_id: 'P1', status: 'HOLDS', evidence_ids: ['E1'] },
      { premise_id: 'P2', status: 'HOLDS', evidence_ids: ['E2'] },
    ],
    evidence: [
      { id: 'E1', source_id: q.source_id, date: q.date, quote: 'Revenue for the third quarter was $160 million', claim: '需求仍在' },
      { id: 'E2', source_id: q.source_id, date: q.date, quote: 'Gross margin was 60.0%', claim: '毛利率 60%，高於 55%' },
    ],
    payload: { tier: verdict, condition_checks: [], proposed_conditions: [] },
    report: '前提都還成立，維持。',
  };
}
/** 自選審查的執行（讀紀錄時會把超過時限的照規則結束，所以 now 用 11-28 00:00）。 */
const reviews = async (db: D1Database) => (await listRuns(db, new Date('2026-11-28T00:00:00Z'), { limit: 500 })).filter((r) => r.fn === 'OWN_REVIEW');
const flowLog = async (db: D1Database, session: string) => {
  const r = await db.prepare("SELECT detail FROM flow_runs WHERE session = ? AND attempt = 'FIRST' ORDER BY id DESC LIMIT 1").bind(session).first<{ detail: string }>();
  return ((JSON.parse(r!.detail) as { ai?: { log: string[] } }).ai?.log ?? []).join('\n');
};

/** 11-20 手動開一次審查，三票一致「不動」，11-23 的流程套用 → 有結論的審查（決策日 11-20）。 */
async function conclusiveReview(c: Ctx) {
  await c.run('2026-11-20');
  const { view, axis } = await c.viewAt('2026-11-20');
  const r = await startOwnReview(c.env, c.fetcher, (await loadAccount(c.db))!.acct, view, axis, 'NVDA', 'MANUAL', new Date('2026-11-21T01:00:00Z'));
  expect(r.pack.rule.detail).toMatchObject({ trigger: 'MANUAL', thesisVersion: 0 });
  expect(r.pack.rule.detail).not.toHaveProperty('reasons');
  await postResult(c.db, r.runId, [vote(r.pack, 'HOLD'), vote(r.pack, 'HOLD'), vote(r.pack, 'HOLD')], new Date('2026-11-21T01:20:00Z'));
  await c.run('2026-11-23');
  return r;
}

describe('整條流程：月底檢查點（own_thesis §3.7）', () => {
  it('一項新證據都沒有 → 不開審查；記 reviewSkip、紀錄那一句、持股頁那一句；運作統計算跳過 1 檔', async () => {
    await withWorld(async (c) => {
      const r = await conclusiveReview(c);
      expect((await thesisFile(c.db, (await loadAccount(c.db))!.acct, 'NVDA', '2026-11-27'))!.lastReview).toMatchObject({ runId: r.runId, asOf: '2026-11-20', thesisVersion: 0 });
      for (const d of ['2026-11-24', '2026-11-25', '2026-11-27']) await c.run(d);
      // 11-27（月報前一天）：沒有新申報、事件、論點變動 → 不開
      expect((await reviews(c.db)).map((x) => x.asOf)).toEqual(['2026-11-20']);
      expect(await flowLog(c.db, '2026-11-27')).toContain('NVDA：11-20 的審查之後沒有新的申報、事件或論點變動，這個月不審查');
      const acct = (await loadAccount(c.db))!.acct;
      expect(acct.own.NVDA.reviewSkip).toEqual({ month: '2026-11', since: '2026-11-20' });
      expect(await stateOf(c.db, checkpointKey('2026-11-27'))).toEqual({ session: '2026-11-27', reviewed: [], skipped: [{ ticker: 'NVDA', since: '2026-11-20' }], notStarted: [] });
      // 持股頁
      const h = await c.api<HoldingDetail>('holding/NVDA', new Date('2026-11-28T03:00:00Z'));
      expect(h.own!.lastReview).toBe('2026-11-20：不動');
      expect(h.own!.reviewSkip).toBe('這個月沒有新證據，沿用 2026-11-20 的審查。');
      // 月報照出（用上一次的結論）
      expect((await c.run('2026-11-30')).monthly).not.toBeNull();
      // 跨月之後寫哪個月
      await c.run('2026-12-01');
      expect((await c.api<HoldingDetail>('holding/NVDA', new Date('2026-12-02T03:00:00Z'))).own!.reviewSkip).toBe('11 月底檢查時沒有新證據，沿用 2026-11-20 的審查。');
      // 運作統計：月底檢查點審了 0 檔、跳過 1 檔
      const sec = await checkpointSection(c.db, { from: '2026-11-01', to: '2026-11-30', fromSource: 'param' });
      expect(sec.rows[0]).toMatchObject({ month: '2026-11', session: '2026-11-27', reviewed: 0, skipped: 1, not_started: 0, skip_ratio: 1 });
      expect((await checkpointSection(c.db, { from: '2026-12-01', to: '2026-12-31', fromSource: 'param' })).rows).toEqual([]);
    });
  });

  it('有新的申報 → 照審（觸發原因照舊 MONTHLY）；證據包記原因清單與論點版本；開了審查就清掉 reviewSkip；運作統計算審了 1 檔', async () => {
    await withWorld(async (c) => {
      await conclusiveReview(c);
      // 先放一個舊的 reviewSkip（上個月跳過），這次開了審查就清掉
      const loaded = (await loadAccount(c.db))!;
      const a = structuredClone(loaded.acct);
      a.own.NVDA.reviewSkip = { month: '2026-10', since: '2026-09-29' };
      await saveAccount(c.db, a, loaded, '測試', new Date('2026-11-23T12:00:00Z'));
      // 11-24 公司送了一份 8-K（8.01 其他事件，不是財報）
      c.e.filings.push(OTHER_8K);
      for (const d of ['2026-11-24', '2026-11-25', '2026-11-27']) await c.run(d);
      const m = (await reviews(c.db)).find((x) => x.asOf === '2026-11-27')!;
      expect(m.pack.rule.detail).toMatchObject({ trigger: 'MONTHLY', reasons: ['FILING'], thesisVersion: 0 });
      expect(await flowLog(c.db, '2026-11-27')).toContain('NVDA：月底檢查點有新證據（有新的申報），開審查');
      expect((await loadAccount(c.db))!.acct.own.NVDA.reviewSkip).toBeNull();
      expect(await stateOf(c.db, checkpointKey('2026-11-27'))).toMatchObject({ reviewed: [{ ticker: 'NVDA', reasons: ['FILING'] }], skipped: [] });
      const report = await buildOpsReport(c.db, { from: '2026-11-01', to: '2026-11-30', fromSource: 'param' }, new Date('2026-12-01T00:00:00Z'));
      const sec = report.sections.find((s) => s.id === 'checkpoints')!;
      expect(sec.rows[0]).toMatchObject({ reviewed: 1, skipped: 0, filing: 1, never: 0, skip_ratio: 0 });
      expect(sec.rows.at(-1)).toMatchObject({ month: '合計', reviewed: 1, skipped: 0 });
    }, [TENQ_FILING]);
  });

  it('連續 2 次沒有結論 → REVIEW_FAILED 告警；月底檢查點（還沒有有結論的審查 = NEVER）開的審查票數不一致 → 失敗歸零、不告警', async () => {
    await withWorld(async (c) => {
      await c.run('2026-11-20');
      c.e.fireFails = true;
      const start = async (date: string, now: string) => {
        const { view, axis } = await c.viewAt(date);
        return startOwnReview(c.env, c.fetcher, (await loadAccount(c.db))!.acct, view, axis, 'NVDA', 'MANUAL', new Date(now));
      };
      await start('2026-11-20', '2026-11-21T01:00:00Z');
      await c.run('2026-11-23');
      await start('2026-11-23', '2026-11-24T01:00:00Z');
      await c.run('2026-11-24');
      const alerts = (await c.db.prepare("SELECT message FROM alerts WHERE kind = 'REVIEW_FAILED' ORDER BY id").all<{ message: string }>()).results.map((x) => x.message);
      expect(alerts).toEqual(['NVDA 的 AI 審查連續 2 次沒有結論（11-20 觸發失敗、11-23 觸發失敗）。規則照常；下一次審查在 11-27 的月底檢查點，有新財報時會提早。']);
      // 月底檢查點：沒有有結論的審查 → NEVER → 開審查；三票不一致
      c.e.fireFails = false;
      await c.run('2026-11-25');
      await c.run('2026-11-27');
      const m = (await reviews(c.db)).find((x) => x.asOf === '2026-11-27')!;
      expect(m.pack.rule.detail).toMatchObject({ trigger: 'MONTHLY', reasons: ['NEVER'] });
      await postResult(c.db, m.runId, [vote(m.pack, 'HOLD'), vote(m.pack, 'HOLD'), vote(m.pack, 'HALF')], new Date('2026-11-28T00:10:00Z'));
      await c.run('2026-11-27', 'FINAL');
      expect(await stateOf(c.db, reviewFailsKey('NVDA'))).toBeNull();
      expect(await stateOf(c.db, reviewSplitsKey('NVDA'))).toMatchObject({ count: 1, first: m.runId, reachedAt: null });
      expect((await c.db.prepare("SELECT COUNT(*) AS n FROM alerts WHERE kind = 'REVIEW_FAILED'").first<{ n: number }>())!.n).toBe(1);
    });
  });
});

// ---------------------------------------------------------------- 拿掉 R1（own_thesis §3.9）

describe('拿掉 R1', () => {
  it('每日檢查不再算、不再寫紀錄；舊資料的 r1 留著不動；證據包沒有 R4、R5 的編號不變；引擎不再匯出 r1', () => {
    const m = makeMarket('2026-06-01', 120);
    const view = viewAt(m, m.idx0 + 100);
    const acct = createAccount({ cash: 5000, core: { VOO: 100 }, own: { NVDA: { shares: 50, stdWeight: 0.1, premises: [{ id: 'P1', text: 'x', origin: 'USER' }] } } }, view);
    expect(acct.own.NVDA).not.toHaveProperty('r1');
    const legacy = structuredClone(acct);
    legacy.own.NVDA.r1 = true;
    const r = dailyCheck(legacy, view);
    expect(r.acct.own.NVDA.r1).toBe(true); // 不讀不寫
    expect(r.log.some((l) => l.what.includes('R1'))).toBe(false);
    // 慢規則照常前進（狀態和沒有 r1 的帳戶相同）
    expect(r.acct.own.NVDA.slow).toEqual(dailyCheck(acct, view).acct.own.NVDA.slow);
    expect(dailyCheck(acct, view).acct.own.NVDA).not.toHaveProperty('r1');
    expect(ownRuleFacts(acct, view, 'NVDA').map((f) => f.id)).toEqual(['R1', 'R2', 'R3']);
    const tiered = structuredClone(acct);
    tiered.own.NVDA.aiTier = { tier: 'HOLD', date: '2026-11-06', suggest: false };
    expect(ownRuleFacts(tiered, view, 'NVDA').map((f) => f.id)).toEqual(['R1', 'R2', 'R3', 'R5']);
    expect('r1' in engine).toBe(false);
    expect('macdHist' in engine).toBe(false);
  });
});
