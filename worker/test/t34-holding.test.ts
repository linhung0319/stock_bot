// T34：持股頁的呈現（own_thesis §1.3、§1.5、§3.6.2、§3.6.6、§3.8），與照使用者的角度把自選股流程走一遍找到的缺口。
// 完成條件裡的畫面由截圖驗收（records/stage8/screens/T34/）；這裡鎖住畫面用到的資料與每個修掉的缺口：
//   持股頁的論點那一塊：前提最近一次的檢查、事件時間軸（白話、沒有英文代碼）、歷次審查與回應、靜默中的前提、減半檢視
//   示範模式也有論點那一塊與「要看的事」（從帳戶狀態算）
//   乙類項目的標題不寫成「賣 NVDA 13 股」、失效通知的說明不和項目重複
//   「要看的事」：集中度那一件連到占比最大的那檔；出場條件改寫回來沒勾的列一件（EXITS_UNCHECKED）
//   討論包的回應白話和論點檔 note 一致、掃描事件的說明沒有英文代碼
//   動能：晚到否決那一行不再叫人去帳戶頁排除；只有真的遞補上來的才寫「被否決後遞補」，遞補紀錄照排名配對
//   F24、F7、F25 抓 8-K 原文時，財報新聞稿的檔名沒有 99 也讀得到
//   券商畫面的代號寫法（BRK-B、BRK B、BRK/B）統一成 BRK.B
// 對外請求全部是假的：價格、成分股（固定檔）、EDGAR、Nasdaq RSS、雲端排程、LINE。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { discussionNumbers, discussionPack, parseThesisBlock } from '../src/ai/discussion';
import { replacements } from '../src/ai/momEntry';
import { concentrationHits } from '../src/app/concentration';
import type { Env, Fetcher } from '../src/app/env';
import { eventDetail } from '../src/app/eventText';
import { runFlow } from '../src/app/flow';
import { LINE_PUSH_URL } from '../src/app/line';
import { loadAccount, saveAccount, thesisLogStmt } from '../src/app/ledgerStore';
import { recordReplacements } from '../src/app/momAi';
import { progressSteps } from '../src/app/ownCheckAi';
import { REWRITE_DAYS, breakLogs, ownAttention, thesisFile, type FileCondition, type ThesisFile, type ThesisReview } from '../src/app/thesis';
import { reviewView, thesisView } from '../src/app/site/thesisView';
import { fetchFilingDoc } from '../src/data/edgar';
import { buildMarketView } from '../src/data/marketView';
import { loadSeries } from '../src/data/store';
import { breakNotice, createAccount, type Account, type MarketView, type Notif, type OwnMeta } from '../src/engine';
import { handle } from '../src/index';
import { freshDb } from './helpers/d1';
import { cronTime, fakeFetcher, newWorld, type World } from './helpers/fakeSources';

const HERE = dirname(fileURLToPath(import.meta.url));
const CODE = /[A-Z]{2,}_[A-Z_]+/;

// ---------------------------------------------------------------- 假的論點檔（純函式的測試）

function fileOf(o: Partial<ThesisFile> = {}): ThesisFile {
  return {
    ticker: 'NVDA',
    fileId: 'NVDA@2026-10-01',
    openedAt: '2026-10-01',
    origin: 'NEW',
    kind: 'THESIS',
    status: 'OPEN',
    thesis: { text: '資料中心的需求會延續到 2027', setAt: '2026-10-02', source: 'DISCUSSION', version: 2, afterBreak: 0, lastAfterBreakAt: null } as never,
    premises: [
      { id: 'P1', text: '資料中心需求延續到 2027', origin: 'USER', addedAt: '2026-10-02', lastCheck: { date: '2026-11-12', runId: 'r3', status: 'HOLDS' }, splitAfter: false },
      { id: 'P2', text: '毛利率維持在 65% 以上', origin: 'USER', addedAt: '2026-10-02', lastCheck: { date: '2026-10-20', runId: 'r1', status: 'BROKEN' }, splitAfter: true },
      { id: 'P3', text: '沒有大客戶自研晶片取代', origin: 'USER', addedAt: '2026-10-02', lastCheck: null, splitAfter: false },
    ],
    conditions: [],
    events: [],
    reviews: [],
    disputes: [],
    flags: [],
    lastReview: null,
    newSince: '2026-06-01',
    log: [],
    ...o,
  };
}
function review(o: Partial<ThesisReview> = {}): ThesisReview {
  return { runId: 'r1', date: '2026-10-20', fn: 'OWN_REVIEW', label: '定期審查', trigger: 'EARNINGS', status: 'AGREED', verdict: 'HALF', votes: { HALF: 3 }, brokenPremises: ['P2'], notif: null, response: null, premiseVotes: {}, summary: null, ...o };
}
const metaOf = (o: Partial<OwnMeta> = {}): OwnMeta => ({ premises: [], flags: [], ...o }) as unknown as OwnMeta;

describe('T34：持股頁的論點那一塊（thesisView）', () => {
  // T61（composite_layer_design §2.1）改了這裡的顯示：原本是「最近一次 3 票一致的結果＋之後沒有一致結論另外標」，
  // 現在由歷次審查算出四種寫法之一（細節的測試在 t61-holds.test.ts）
  it('前提最近一次的結果：證實與日期；之後沒有一致結論寫「這次沒驗到」並帶上一次的結果；沒檢查過寫「還沒有檢查過」', () => {
    const reviews = [
      review({ runId: 'r3', date: '2026-11-12', premiseVotes: { P1: ['HOLDS', 'HOLDS', 'HOLDS'], P2: ['BROKEN', 'INSUFFICIENT', 'BROKEN'] } }),
      review({ runId: 'r1', date: '2026-10-20', premiseVotes: { P2: ['BROKEN', 'BROKEN', 'BROKEN'] } }),
    ];
    const v = thesisView(fileOf({ reviews }), metaOf(), { notifs: [] }, '2026-11-13');
    expect(v.premiseChecks.P1).toEqual({ kind: 'CONFIRMED', text: '11/12 證實', why: '3 票都判成立' });
    expect(v.premiseChecks.P2).toEqual({ kind: 'MISSED', text: '這次沒驗到（上次 10/20 被判不成立）', why: '11/12 審查：三票不一致（2 票不成立、1 票證據不足）' });
    expect(v.premiseChecks.P3).toEqual({ kind: null, text: '還沒有檢查過', why: null });
    // 示範模式（只有帳戶狀態）不說「還沒有檢查過」，說示範資料沒有紀錄
    expect(thesisView(fileOf(), metaOf(), { notifs: [] }, '2026-11-13', true).premiseChecks.P3.text).toBe('示範資料沒有審查紀錄');
  });

  it('事件時間軸：類別與說明都是白話（掃描事件原本帶英文代碼）、來源與誰記下的、上次審查之後的標新；開檔前的不列', () => {
    const ev = (o: Partial<ThesisFile['events'][number]>) => ({ id: 1, date: '2026-11-10', source: 'SCAN', code: 'GUIDANCE_CUT', sub: 'SCAN_GUIDANCE_CUT', form: '8-K', sourceId: 'edgar:0001045810-26-000101', accession: '0001045810-26-000101', detail: '每日掃描標記：GUIDANCE_CUT（CUT）；可能和 W1、C2 有關（等申報原文證實）', detailCode: 'CUT', status: 'NEW', displayOnly: false, createdAt: '2026-11-10T23:40:00Z', isNew: true, ...o });
    const f = fileOf({
      events: [
        ev({}),
        ev({ id: 2, date: '2026-11-03', source: 'EDGAR', code: 'MGMT_CHANGE', detailCode: 'CFO_DEPART', detail: '8-K Item 5.02：財務長離任（規則從原文判斷）', status: 'HANDLED', isNew: false }),
        ev({ id: 3, date: '2026-11-05', source: 'SCAN', code: 'MGMT_CHANGE', detailCode: 'DIRECTOR', form: 'NEWS', sourceId: 'nasdaq-rss:NVDA:2026-11-05', accession: null, detail: '每日掃描標記：MGMT_CHANGE（DIRECTOR）', status: 'INFO', displayOnly: true, isNew: false }),
        ev({ id: 4, date: '2026-09-01', source: 'EDGAR', code: 'ACTIVIST', detailCode: 'SC_13D', form: 'SCHEDULE 13D', detail: '有人申報持股 5% 以上，而且有意影響公司（13D，只記錄）', status: 'INFO', displayOnly: true, isNew: false }),
      ],
    });
    const v = thesisView(f, metaOf(), { notifs: [] }, '2026-11-13');
    expect(v.events.map((e) => [e.date, e.label, e.source, e.via, e.status, e.isNew])).toEqual([
      ['2026-11-10', '財測下修', '8-K', '每日掃描', '待處理', true],
      ['2026-11-03', '財務長離任', '8-K', '申報分類', '已處理', false],
      ['2026-11-05', '董事異動', '新聞標題', '每日掃描', '只記錄', false],
    ]);
    expect(v.events[0].detail).toBe('每日掃描標記：財測（財測下修）；可能和你的條件有關（等申報原文證實）');
    for (const e of v.events) expect(e.detail ?? '', e.label).not.toMatch(CODE);
    expect(v.eventCount).toBe(3);
  });

  it('歷次審查與你的回應：結論的白話、三票都判不成立的前提、通知與回應（理由）；還沒回寫「還沒回」；沒有結論的寫原因', () => {
    const f = fileOf({
      reviews: [
        review({ runId: 'r3', date: '2026-11-12', trigger: 'MONTHLY', verdict: 'HOLD', votes: { HOLD: 3 }, brokenPremises: [] }),
        review({ runId: 'r2', date: '2026-11-02', trigger: 'THESIS', status: 'SPLIT', verdict: 'HOLD', votes: { HOLD: 2, HALF: 1 }, brokenPremises: [] }),
        review({ runId: 'r1', notif: 7, response: { outcome: 'DISAGREE', reason: '毛利率下滑是一次性的', type: 'B' } }),
        review({ runId: 'r0', date: '2026-10-10', fn: 'HARD_EVENT', label: '硬事件', trigger: 'ACCOUNTING、PENDING_MA', verdict: 'HOLD', votes: { HOLD: 3 }, brokenPremises: [], notif: 3 }),
        review({ runId: 'rp', date: '2026-10-05', status: 'PENDING', verdict: null, votes: {}, brokenPremises: [] }),
        review({ runId: 'rt', date: '2026-10-04', status: 'TIMEOUT', verdict: null, votes: {}, brokenPremises: [] }),
      ],
    });
    const v = thesisView(f, metaOf(), { notifs: [] }, '2026-11-13');
    expect(v.reviews.map((r) => [r.runId, r.label, r.trigger, r.result, r.tone, r.broken, r.response])).toEqual([
      ['r3', '定期審查', '月底檢查點', '3 票一致：不動', 'ok', [], null],
      ['r2', '定期審查', '論點變動後', '三票沒有一致結論', 'warn', [], null],
      ['r1', '定期審查', '財報後', '3 票一致：減半', 'hot', ['P2'], '不同意：毛利率下滑是一次性的'],
      ['r0', '硬事件', '會計問題、被收購', '3 票一致：不用動', 'ok', [], '還沒回'],
      ['rp', '定期審查', '財報後', '還在跑', 'now', [], null],
      ['rt', '定期審查', '財報後', '逾時，沒有結論', 'hot', [], null],
    ]);
    // 回應的白話和論點檔的 note 一致（月報裡沒動的乙類、一直沒回的）
    expect(reviewView(review({ notif: 9, response: { outcome: 'SKIPPED', reason: null, type: 'B' } })).response).toBe('月報裡沒有動它（當成不同意）');
    expect(reviewView(review({ notif: 9, response: { outcome: 'NONE', reason: null, type: 'B' } })).response).toBe('上次的失效通知沒有回應');
    expect(reviewView(review({ notif: 9, response: { outcome: 'SKIPPED', reason: '先觀察', type: 'R' } })).response).toBe('這次不做：先觀察');
  });

  it('靜默中的前提：只列還在期間內的；減半檢視（dropReview）五種狀態的那一行與還沒回覆的減半通知', () => {
    const meta = metaOf({
      disputes: [
        { premiseId: 'P2', since: '2026-10-21', until: '2027-01-29', reason: '毛利率下滑是一次性的', notif: 7 },
        { premiseId: 'P9', since: '2026-05-01', until: '2026-08-09', reason: '舊的', notif: 2 },
      ],
      dropReview: { session: '2026-11-11', runId: 'd1', status: 'PENDING', cause: null, premiseId: null, told: false },
    });
    const n = { id: 12, status: 'PENDING', items: [{ ticker: 'NVDA', kind: 'OWN_RULE', f: 'F7', cancelled: false }] } as unknown as Notif;
    const v = thesisView(fileOf(), meta, { notifs: [n] }, '2026-11-13');
    expect(v.silenced).toEqual([{ premiseId: 'P2', text: '毛利率維持在 65% 以上', since: '2026-10-21', until: '2027-01-29', reason: '毛利率下滑是一次性的' }]);
    expect(v.dropReview).toEqual({ text: '11/11 減半之後的 AI 論點檢查還在跑，台灣 09:30 前會更新到通知上', tone: 'now', notif: 12 });
    const dr = (status: NonNullable<OwnMeta['dropReview']>['status'], o: Partial<NonNullable<OwnMeta['dropReview']>> = {}) => thesisView(fileOf(), metaOf({ dropReview: { session: '2026-11-11', runId: 'd1', status, cause: null, premiseId: null, told: true, ...o } }), { notifs: [] }, '2026-11-13').dropReview!;
    expect(dr('HOLD', { cause: 'MARKET' }).text).toBe('11/11 減半之後的 AI 論點檢查（3 票）：跌幅主要是大盤一起跌，前提都沒有被判不成立，AI 建議不動');
    expect(dr('EXIT', { premiseId: 'P2' })).toEqual({ text: '11/11 減半之後的 AI 論點檢查（3 票）：前提 P2 不成立，AI 建議出清', tone: 'hot', notif: null });
    expect(dr('AGREE', { cause: 'FUNDAMENTAL' }).text).toBe('11/11 減半之後的 AI 論點檢查（3 票）：同意減半（歸類：公司基本面）');
    expect(dr('NONE').text).toBe('11/11 減半之後的 AI 論點檢查沒有一致結論，照規則');
    expect(thesisView(fileOf(), metaOf(), { notifs: [] }, '2026-11-13').dropReview).toBeNull();
  });

  it('財報條件的進度條：要連續 2 季以上的才有；一季一段，已符合的寫那一季的數值，還沒到的寫「下一季」', () => {
    const c = (progress: FileCondition['progress']) => ({ progress, check: { type: 'xbrl_metric_below', metric: 'GrossMarginPct', level: 0.7, quarters: 2 } });
    expect(progressSteps(c({ at: '2026-11-05', basis: 'XBRL', period: '2026-09-30', values: [0.684, 0.71, 0.72, 0.73], level: 0.7, streak: 1, need: 2 }))).toEqual({ need: 2, done: 1, labels: ['68.4%', '下一季'] });
    expect(progressSteps(c({ at: '2026-11-05', basis: 'XBRL', period: '2026-09-30', values: [0.66, 0.68, 0.71, 0.73], level: 0.7, streak: 2, need: 3 }))).toEqual({ need: 3, done: 2, labels: ['68.0%', '66.0%', '下一季'] });
    expect(progressSteps(c({ at: '2026-11-05', basis: 'XBRL', period: '2026-09-30', values: [0.72], level: 0.7, streak: 0, need: 1 }))).toBeNull();
    expect(progressSteps(c(null))).toBeNull();
  });
});

// ---------------------------------------------------------------- 假的世界（和 t30 相同的做法）

type Api = <T = Record<string, unknown>>(method: 'GET' | 'POST', path: string, body?: unknown, now?: Date) => Promise<{ status: number; body: T }>;
interface Ctx {
  db: D1Database;
  w: World;
  env: Env;
  fetcher: Fetcher;
  view: MarketView;
  api: Api;
  demo: Api;
}
const PREMISES = [
  { id: 'P1', text: '資料中心需求延續到 2027', origin: 'USER' as const },
  { id: 'P2', text: '毛利率維持在 65% 以上', origin: 'USER' as const },
];

function fetcherOf(w: World): Fetcher {
  const base = fakeFetcher(w);
  return async (url, init) => {
    if (url === LINE_PUSH_URL) return Response.json({});
    if (url === 'https://api.example/fire') return Response.json({ claude_code_session_url: 'https://claude.ai/code/x' });
    if (/data\.sec\.gov\/submissions\/CIK\d+\.json/.test(url)) return Response.json({ cik: '1', name: 'X', tickers: [], filings: { recent: { accessionNumber: [], form: [], items: [], acceptanceDateTime: [], filingDate: [], primaryDocument: [] } } });
    if (/companyfacts\/CIK\d+\.json/.test(url)) return Response.json({ cik: 1, facts: {} });
    if (url.startsWith('https://www.nasdaq.com/feed/rssoutbound')) return new Response('<rss><channel></channel></rss>');
    return base(url, init);
  };
}

async function withWorld(fn: (c: Ctx) => Promise<void>, own: Record<string, { w: number; premises?: typeof PREMISES }> = { NVDA: { w: 40_000, premises: PREMISES } }) {
  const d = await freshDb();
  try {
    const db = d.db;
    const w = newWorld('2026-11-19');
    const env: Env = { DB: db, ADMIN_TOKEN: 't', AI_TASK_SECRET: 's', EDGAR_USER_AGENT: 'test bot test@example.com', SITE_URL: 'https://bot.example', LINE_CHANNEL_TOKEN: 'lt', LINE_USER_ID: 'U1', ROUTINE_FIRE_URL: 'https://api.example/fire', ROUTINE_TOKEN: 'rt', DEV_NO_AUTH: '1' };
    const fetcher = fetcherOf(w);
    await runFlow(env, fetcher, { now: cronTime('2026-11-19'), attempt: 'FIRST' });
    const { view } = buildMarketView(await loadSeries(db, ['VOO', 'SGOV', ...Object.keys(own)]), '2026-11-19', 'VOO');
    const acct = createAccount(
      {
        paper: true,
        cash: 5000,
        core: { VOO: Math.floor(140_000 / view.close.VOO[view.i]) },
        own: Object.fromEntries(Object.entries(own).map(([t, o]) => [t, { shares: Math.floor(o.w / view.close[t][view.i]), stdWeight: 0.1, ...(o.premises ? { premises: structuredClone(o.premises) } : {}) }])),
      },
      view,
    );
    await saveAccount(db, acct, null, '建立帳戶', new Date('2026-11-19T12:00:00Z'));
    const call = (prefix: string): Api => async (method, path, body, now = new Date('2026-11-20T02:00:00Z')) => {
      const r = await handle(new Request(`https://bot.example/${prefix}/${path}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env, fetcher, now);
      return { status: r.status, body: (await r.json()) as never };
    };
    await fn({ db, w, env, fetcher, view, api: call('api'), demo: call('demo/api') });
  } finally {
    await d.dispose();
  }
}

/** 直接寫一筆 AI 執行（持股頁只讀結論；證據包只放畫面用得到的欄位）。 */
async function insertRun(db: D1Database, o: { runId: string; fn: string; ticker: string; asOf: string; createdAt: string; outcome: unknown; detail?: Record<string, unknown>; premises?: unknown[] }) {
  const pack = { run_id: o.runId, fn: o.fn, subject: { ticker: o.ticker }, as_of: o.asOf, premises: o.premises ?? [], documents: [], facts: [], rule: { detail: o.detail ?? {} }, policy: { samples: 3, abstain: 'HOLD' }, data_quality: {} };
  await db
    .prepare('INSERT INTO ai_runs (run_id, fn, ticker, as_of, created_at, status, task_id, prompt_version, pack_hash, pack, pack_notes, outcome, process, completed_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, ?, NULL, ?)')
    .bind(o.runId, o.fn, o.ticker, o.asOf, o.createdAt, o.outcome ? 'DONE' : 'PENDING', 'v', 'h', JSON.stringify(pack), o.outcome ? JSON.stringify(o.outcome) : null, o.outcome ? o.createdAt : null)
    .run();
}
const reviewOutcome = (verdict: string, prem: [string, string][]) => {
  const s = { valid: true, verdict, rawVerdict: verdict, premises: prem.map(([premise_id, status]) => ({ premise_id, status, evidence_ids: [] })), evidence: [], conditions: [], report: '測試用的報告。' };
  return { status: 'AGREED', verdict, votes: { [verdict]: 3 }, actionable: true, followRule: false, reason: '3 票一致', samples: [s, s, s] };
};
const checkOutcome = (texts: string[]) => {
  const s = { valid: true, verdict: 'DONE', rawVerdict: 'DONE', premises: [], evidence: [], report: '改寫好了。', conditions: texts.map((text, k) => ({ from: 'payload.conditions', auto: true, type: 'xbrl_metric_below', raw: { kind: 'XBRL', direction: 'DOWN', text, check: { type: 'xbrl_metric_below', metric: 'GrossMarginPct', level: 0.45, quarters: 2 }, tier_if_met: 'EXIT', line: `U${k + 1}` } })) };
  return { status: 'AGREED', verdict: 'DONE', votes: { DONE: 1 }, actionable: false, followRule: false, reason: '完成', samples: [s] };
};
const insEvent = (db: D1Database, o: { accession: string; date: string; code: string; sub: string; source: string; form: string; detail: string; status: string; detailCode?: string | null }) =>
  db
    .prepare('INSERT INTO sec_events (ticker, accession, form, event_date, accepted_at, code, sub, by_rule, display_only, source, detail, status, created_at, detail_code) VALUES (?, ?, ?, ?, NULL, ?, ?, 0, 0, ?, ?, ?, ?, ?)')
    .bind('NVDA', o.accession, o.form, o.date, o.code, o.sub, o.source, o.detail, o.status, `${o.date}T23:40:00Z`, o.detailCode ?? null)
    .run();

describe('T34：持股頁的 API', () => {
  it('真實模式：論點那一塊（前提最近一次的檢查、事件的白話、審查與回應）；事件說明沒有英文代碼', async () => {
    await withWorld(async (c) => {
      await insertRun(c.db, { runId: '2026-11-19_OWN_REVIEW_NVDA_aaa', fn: 'OWN_REVIEW', ticker: 'NVDA', asOf: '2026-11-19', createdAt: '2026-11-19T23:40:00Z', outcome: reviewOutcome('HALF', [['P1', 'HOLDS'], ['P2', 'BROKEN']]), detail: { trigger: 'EARNINGS' }, premises: PREMISES });
      await insEvent(c.db, { accession: 'edgar:0001045810-26-000101', date: '2026-11-19', code: 'GUIDANCE_CUT', sub: 'SCAN_GUIDANCE_CUT', source: 'SCAN', form: '8-K', detail: '每日掃描標記：GUIDANCE_CUT（CUT）；可能和 C1 有關（等申報原文證實）', status: 'NEW', detailCode: 'CUT' });
      // 乙類通知與「不同意」的回應（論點檔的 BREAK_NOTICE、RESPONSE）
      const loaded = (await loadAccount(c.db))!;
      const b = breakNotice(loaded.acct, c.view, 'NVDA', { tier: 'HALF', premiseId: 'P2', basis: '10-Q 2026-10-30', runIds: ['2026-11-19_OWN_REVIEW_NVDA_aaa'] });
      const at = new Date('2026-11-19T13:00:00Z');
      await saveAccount(c.db, b.acct, loaded, '測試：乙類', at, breakLogs(b.acct, [b.notif!]).map((l) => thesisLogStmt(c.db, l, null, at.toISOString())));
      const r = await c.api<{ thesis: { premiseChecks: Record<string, { kind: string; text: string }>; events: { label: string; detail: string }[]; reviews: { result: string; broken: string[]; response: string | null; trigger: string }[]; silenced: unknown[]; partial: boolean }; own: { pendingBreak: unknown } }>('GET', 'holding/NVDA');
      expect(r.status).toBe(200);
      const t = r.body.thesis;
      expect(t.partial).toBe(false);
      // T61：四種寫法（證實／被判不成立／這次沒驗到／已經 N 次沒驗到）
      expect(t.premiseChecks.P1).toMatchObject({ kind: 'CONFIRMED', text: '11/19 證實' });
      expect(t.premiseChecks.P2).toMatchObject({ kind: 'BROKEN', text: '11/19 被判不成立' });
      expect(t.events.map((e) => e.label)).toEqual(['財測下修']);
      expect(t.events[0].detail).toBe('每日掃描標記：財測（財測下修）；可能和你的條件有關（等申報原文證實）');
      expect(t.reviews[0]).toMatchObject({ result: '3 票一致：減半', broken: ['P2'], response: '還沒回', trigger: '財報後' });
      // 回覆「不同意」→ 審查那一列寫回應與理由，前提進靜默期
      const n = b.notif!;
      expect((await c.api('POST', `notif/${n.id}/respond`, { mode: 'DO', reasons: { [n.items[0].key]: '毛利率下滑是一次性的' } })).status).toBe(200);
      const r2 = await c.api<{ thesis: { reviews: { response: string | null }[]; silenced: { premiseId: string; reason: string }[] } }>('GET', 'holding/NVDA');
      expect(r2.body.thesis.reviews[0].response).toBe('不同意：毛利率下滑是一次性的');
      expect(r2.body.thesis.silenced).toMatchObject([{ premiseId: 'P2', reason: '毛利率下滑是一次性的' }]);
    });
  });

  it('示範模式（T34 的決定）：也有論點那一塊（只有帳戶狀態）與「要看的事」（只有預設前提的列 NO_THESIS）', async () => {
    await withWorld(async (c) => {
      const meta = await c.demo<{ thesis: { partial: boolean; premiseChecks: Record<string, { text: string }>; events: unknown[]; reviews: unknown[] }; attention: { kind: string; text: string }[]; own: { kind: string } }>('GET', 'holding/META');
      expect(meta.status).toBe(200);
      expect(meta.body.own.kind).toBe('DEFAULT_ONLY');
      expect(meta.body.thesis.partial).toBe(true);
      expect(meta.body.thesis.events).toEqual([]);
      expect(Object.values(meta.body.thesis.premiseChecks).map((p) => p.text)).toEqual(['示範資料沒有審查紀錄', '示範資料沒有審查紀錄', '示範資料沒有審查紀錄']);
      expect(meta.body.attention.map((x) => x.kind)).toContain('NO_THESIS');
      const mu = await c.demo<{ thesis: unknown; attention: { kind: string }[] }>('GET', 'holding/MU');
      expect(mu.body.thesis).not.toBeNull();
      expect(mu.body.attention.map((x) => x.kind)).not.toContain('NO_THESIS');
      // 不是自選：沒有論點那一塊
      expect((await c.demo<{ thesis: unknown }>('GET', 'holding/VOO')).body.thesis).toBeNull();
    });
  });

  it('乙類項目的標題寫「NVDA 不動」、括號裡是 AI 的建議（預設不動，不寫成「賣 NVDA 13 股」）；修正論點結案後寫「不動」；失效通知不重複顯示 LINE 那幾行說明', async () => {
    await withWorld(async (c) => {
      const loaded = (await loadAccount(c.db))!;
      const b = breakNotice(loaded.acct, c.view, 'NVDA', { tier: 'HALF', premiseId: 'P2', basis: '10-Q 2026-10-30', runIds: ['rev-1'] });
      const at = new Date('2026-11-19T13:00:00Z');
      await saveAccount(c.db, b.acct, loaded, '測試：乙類', at, breakLogs(b.acct, [b.notif!]).map((l) => thesisLogStmt(c.db, l, null, at.toISOString())));
      const n = b.notif!;
      const sh = -n.items[0].choices.find((x) => x.id === 'AI')!.lines[0].shares;
      const v = await c.api<{ text: string | null; items: { headline: string; choice: string; cancelled: boolean }[] }>('GET', `notif/${n.id}`);
      expect(v.body.items[0].headline).toBe(`NVDA 不動（AI 建議減半，賣 ${sh} 股）`);
      expect(v.body.items[0].choice).toBe('SKIP');
      expect(n.text).toBeTruthy(); // LINE 那幾行還在通知裡
      expect(v.body.text).toBeNull(); // 網站不另外顯示
      // 修正論點（勾「這是對通知 #N 的回應」）→ 通知結案、這一項取消 → 標題「NVDA 不動」
      const s = await c.api('POST', 'ops/own-thesis', { ticker: 'NVDA', thesis: '改寫後的論點', premises: [{ id: 'P1', text: PREMISES[0].text }, { text: '毛利率維持在 60% 以上' }], exitConditions: [], source: 'TYPED', replyTo: n.id });
      expect(s.status).toBe(200);
      const v2 = await c.api<{ items: { headline: string; cancelled: boolean }[] }>('GET', `notif/${n.id}`);
      expect(v2.body.items[0]).toMatchObject({ cancelled: true, headline: 'NVDA 不動' });
    });
  });
});

// ---------------------------------------------------------------- 走一遍：順序不同、填錯

/** 存一則 NVDA 的乙類當天通知（和每日流程一樣寫 BREAK_NOTICE）。 */
async function seedBreak(c: Ctx): Promise<Notif> {
  const loaded = (await loadAccount(c.db))!;
  const b = breakNotice(loaded.acct, c.view, 'NVDA', { tier: 'HALF', premiseId: 'P2', basis: '10-Q 2026-10-30', runIds: ['rev-1'] });
  const at = new Date('2026-11-19T13:00:00Z');
  await saveAccount(c.db, b.acct, loaded, '測試：乙類', at, breakLogs(b.acct, [b.notif!]).map((l) => thesisLogStmt(c.db, l, null, at.toISOString())));
  return b.notif!;
}

describe('T34：自選股的流程走一遍找到的缺口', () => {
  it('先自己賣光、才回乙類通知：那一項跟著取消、整則改成已取消，不留在「等你決定」，也不會再叫你賣一次', async () => {
    await withWorld(async (c) => {
      const n = await seedBreak(c);
      const a0 = (await loadAccount(c.db))!.acct;
      const nv = a0.lots.own.NVDA;
      const snap = await c.api<{ removedOwn: string[] }>('POST', 'snapshot', { cash: a0.cash + nv * c.view.close.NVDA[c.view.i], lots: { own: { NVDA: 0 }, mom: {}, core: a0.lots.core } });
      expect(snap.status).toBe(200);
      expect(snap.body.removedOwn).toEqual(['NVDA']);
      const v = await c.api<{ status: string; composed: unknown; items: { cancelled: boolean; note: string | null; headline: string }[] }>('GET', `notif/${n.id}`);
      expect(v.body.status).toBe('CANCELLED');
      expect(v.body.items[0]).toMatchObject({ cancelled: true, headline: 'NVDA 不動', note: '11/19 NVDA 已經賣光、移出自選，這一項取消' });
      expect(v.body.composed).toBeNull();
      const st = await c.api<{ todo: { id: number }[] }>('GET', 'state');
      expect(st.body.todo.map((t) => t.id)).not.toContain(n.id);
      expect((await c.api('POST', `notif/${n.id}/respond`, { mode: 'DO', choices: { [n.items[0].key]: 'AI' } })).status).toBe(409);
    });
  });

  it('從持股頁按「複製討論包」而這檔有還沒回覆的乙類通知：照那一則組「前提被判不成立」的討論包（原本給例行檢視）', async () => {
    await withWorld(async (c) => {
      const before = await c.api<{ mode: string; text: string }>('GET', 'own/NVDA/discussion');
      expect(before.body.mode).toBe('ROUTINE');
      const n = await seedBreak(c);
      const r = await c.api<{ mode: string; text: string }>('GET', 'own/NVDA/discussion');
      expect(r.body.mode).toBe('BREAK');
      expect(r.body.text).toContain('stock bot 的審查（3 票一致）認為前提 P2「毛利率維持在 65% 以上」不成立，建議減半。');
      // 指定情境的照指定的
      expect((await c.api<{ mode: string }>('GET', 'own/NVDA/discussion?mode=ROUTINE')).body.mode).toBe('ROUTINE');
      expect((await c.api<{ mode: string }>('GET', `own/NVDA/discussion?notif=${n.id}`)).body.mode).toBe('BREAK');
    });
  });

  it('標準比重填錯（填成小數或超過 50%）：錯誤訊息用畫面上的百分比講', async () => {
    await withWorld(async (c) => {
      const r = await c.api<{ error: string }>('POST', 'ops/std-weight', { ticker: 'NVDA', stdWeight: 0.0005 });
      expect(r.status).toBe(422);
      expect(r.body.error).toBe('標準比重要在 0.1% 到 50% 之間（畫面上填百分比，例如 5 代表 5%）');
      expect((await c.api('POST', 'ops/std-weight', { ticker: 'NVDA', stdWeight: 0.06 })).status).toBe(200);
      expect((await loadAccount(c.db))!.acct.rule.own.NVDA.stdWeight).toBe(0.06);
      expect(readFileSync(join(HERE, '..', 'public', 'js', 'pages-holding.js'), 'utf8')).toContain('v >= 0.1 && v <= 50');
    });
  });
});

// ---------------------------------------------------------------- 「要看的事」

const N = 300;
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32 - 0.5;
  };
}
function series(common: number[], noise: number, seed: number): number[] {
  const r = rng(seed);
  const out = [100];
  for (let k = 1; k < N; k++) out.push(out[k - 1] * (1 + 0.04 * common[k] + 0.04 * noise * r()));
  const f = 100 / out[N - 1];
  return out.map((x) => x * f);
}
const common = (seed: number) => {
  const r = rng(seed);
  return Array.from({ length: N }, () => r());
};

describe('T34：「要看的事」', () => {
  it('集中度那一件：掛在字母排第一的自選股（頻率用），但連到文字開頭、占比最大的那一檔（link）', () => {
    const A = common(11);
    const view: MarketView = { date: '2026-11-30', i: N - 1, close: { VOO: series(common(1), 0.5, 1), SGOV: Array.from({ length: N }, () => 100), NVDA: series(A, 0.2, 101), MU: series(A, 0.2, 102) } };
    const total = 1_000_000;
    const acct = createAccount({ paper: true, cash: total - (900 + 700 + 4000) * 100, core: { VOO: 4000 }, own: { NVDA: { shares: 900, stdWeight: 0.05 }, MU: { shares: 700, stdWeight: 0.05 } } }, view);
    const [hit] = concentrationHits(acct, view);
    expect(hit.ticker).toBe('MU');
    expect(hit.text.startsWith('NVDA、MU')).toBe(true);
    expect(hit.link).toBe('NVDA');
    // 占比最大的就是字母排第一的：不另外帶 link
    const acct2 = createAccount({ paper: true, cash: total - (700 + 900 + 4000) * 100, core: { VOO: 4000 }, own: { NVDA: { shares: 700, stdWeight: 0.05 }, MU: { shares: 900, stdWeight: 0.05 } } }, view);
    expect(concentrationHits(acct2, view)[0].link).toBeUndefined();
  });

  it('出場條件改寫回來、還沒勾（EXITS_UNCHECKED）：列一件；確認後不列；超過 30 天不列（走一遍的缺口：沒勾的 30 天後就不在持股頁）', async () => {
    await withWorld(async (c) => {
      const acct = (await loadAccount(c.db))!.acct;
      // T42：只算最近一次出場條件有改動的那一版論點（THESIS log 的 exitsChanged）送的改寫
      const exits = [{ text: '毛利率掉到 45% 以下', action: 'EXIT' }, { text: '營收衰退', action: 'HALF' }];
      await c.db
        .prepare("INSERT INTO own_thesis_log (ticker, file_id, at, session, kind, ref, body) VALUES ('NVDA', ?, '2026-11-19T14:00:00Z', '2026-11-19', 'THESIS', NULL, ?)")
        .bind(acct.own.NVDA.fileId, JSON.stringify({ version: 1, exitsChanged: true, exitLines: exits.map((e) => e.text), exitActions: exits.map((e) => e.action), exitsLive: [], exitSame: {} }))
        .run();
      await insertRun(c.db, { runId: '2026-11-19_OWN_CHECK_NVDA_aaa', fn: 'OWN_CHECK', ticker: 'NVDA', asOf: '2026-11-19', createdAt: '2026-11-19T15:00:00Z', outcome: checkOutcome(['毛利率連兩季低於 45%', '營收年增率連兩季是負的']), detail: { mode: 'REWRITE', exits, exitsVersion: 1, live: [], sameByText: {} } });
      const f = (await thesisFile(c.db, acct, 'NVDA', '2026-11-19'))!;
      expect(f.unchecked).toEqual([{ runId: '2026-11-19_OWN_CHECK_NVDA_aaa', at: '2026-11-19T15:00:00Z', pending: 2 }]);
      const hits = ownAttention([f], acct, { date: '2026-11-19' }).filter((x) => x.kind === 'EXITS_UNCHECKED');
      expect(hits).toEqual([{ ticker: 'NVDA', kind: 'EXITS_UNCHECKED', src: 'own', key: 'EXITS_UNCHECKED@2026-11-19_OWN_CHECK_NVDA_aaa', every: null, since: '2026-11-19', text: `NVDA：你寫的 2 條出場條件 AI 改寫好了，還沒勾選；勾選之後才會開始監測（2026-12-19 之後就不再列在持股頁）` }]);
      expect(REWRITE_DAYS).toBe(30);
      // 持股頁也看得到
      const h = await c.api<{ attention: { kind: string }[] }>('GET', 'holding/NVDA');
      expect(h.body.attention.map((x) => x.kind)).toContain('EXITS_UNCHECKED');
      // 沒有記版本的改寫（之前版本的、或 T42 之前的）不算
      await insertRun(c.db, { runId: '2026-11-19_OWN_CHECK_NVDA_old', fn: 'OWN_CHECK', ticker: 'NVDA', asOf: '2026-11-19', createdAt: '2026-11-19T16:00:00Z', outcome: checkOutcome(['淨利率低於 20%']), detail: { mode: 'REWRITE', exits: [] } });
      expect((await thesisFile(c.db, acct, 'NVDA', '2026-11-19'))!.unchecked).toHaveLength(1);
      // 超過 30 天的改寫不算（持股頁也不再列）
      expect((await thesisFile(c.db, acct, 'NVDA', '2026-12-20'))!.unchecked).toEqual([]);
      // 確認（T42：一次做完，只勾一條也算確認了這一版）→ 不列（原本：勾一條剩 1 條、兩條都勾才不列）
      expect((await c.api('POST', 'ops/own-conditions', { ticker: 'NVDA', runId: '2026-11-19_OWN_CHECK_NVDA_aaa', ids: ['U1'] })).status).toBe(200);
      expect((await thesisFile(c.db, acct, 'NVDA', '2026-11-19'))!.unchecked).toEqual([]);
    });
  });

  it('動能晚到的否決那一行：帳戶頁沒有排除持有中動能股的功能，照實寫怎麼做（走一遍的缺口）', () => {
    const text = readFileSync(join(HERE, '..', 'src', 'app', 'momNotes.ts'), 'utf8');
    expect(text).not.toContain('在帳戶頁排除');
    expect(text).toContain('自己賣掉、填快照時記在動能，下次月報再列 ${ticker} 時按「排除」');
  });
});

// ---------------------------------------------------------------- 討論包

describe('T34：討論包的白話', () => {
  it('回應的白話和論點檔 note 一致（SKIPPED、NONE）；掃描事件的說明沒有英文代碼', () => {
    const f = fileOf({
      reviews: [review({ notif: 7, response: { outcome: 'SKIPPED', reason: null, type: 'B' } }), review({ runId: 'r0', date: '2026-10-10', notif: 3, response: { outcome: 'NONE', reason: null, type: 'B' } })],
      events: [{ id: 1, date: '2026-11-10', source: 'SCAN', code: 'MGMT_CHANGE', sub: 'SCAN_MGMT_CHANGE', form: '8-K', sourceId: 'edgar:0001045810-26-000101', accession: '0001045810-26-000101', detail: '每日掃描標記：MGMT_CHANGE（CEO_DEPART）', detailCode: 'CEO_DEPART', status: 'NEW', displayOnly: false, createdAt: '2026-11-10T23:40:00Z', isNew: true }],
    });
    const VIEW: MarketView = { date: '2026-11-13', i: 299, close: { VOO: Array.from({ length: 300 }, () => 500), SGOV: Array.from({ length: 300 }, () => 100), NVDA: Array.from({ length: 300 }, (_, k) => 100 + k * 0.1) } };
    const acct = createAccount({ paper: true, cash: 1000, core: { VOO: 100 }, own: { NVDA: { shares: 100, stdWeight: 0.05, premises: [{ id: 'P1', text: '資料中心需求延續到 2027', origin: 'USER' }] } } }, VIEW);
    const text = discussionPack(f, discussionNumbers(acct, VIEW, 'NVDA', null), 'ROUTINE');
    expect(text).toContain('我的回應：月報裡沒有動它（當成不同意）。');
    expect(text).toContain('我的回應：上次的失效通知沒有回應。');
    expect(text).toContain('每日掃描標記：執行長離任');
    expect(text).toContain('每日掃描標記：高層異動（執行長離任）');
    expect(text).not.toMatch(/MGMT_CHANGE|CEO_DEPART/);
  });

  it('eventDetail：掃描事件的類別、細項換成中文；條件的編號換成「你的條件」；回測的代號換掉；規則分類的照舊', () => {
    expect(eventDetail('每日掃描標記：ACCOUNTING_CANDIDATE；可能和 W1 有關（等申報原文證實）')).toBe('每日掃描標記：可能是會計問題；可能和你的條件有關（等申報原文證實）');
    expect(eventDetail('每日掃描標記：MAJOR_CONTRACT（NEW）')).toBe('每日掃描標記：重大合約（新的重大合約）');
    expect(eventDetail('延遲申報（B-9：之後 12 個月相對 SPY −8.9%）')).toBe('延遲申報（回測：之後 12 個月相對 SPY −8.9%）');
    expect(eventDetail('8-K Item 5.02：財務長離任（規則從原文判斷）')).toBe('8-K Item 5.02：財務長離任（規則從原文判斷）');
    expect(eventDetail(null)).toBeNull();
  });
});

// ---------------------------------------------------------------- 動能：誰是遞補上來的

describe('T34：只有真的遞補上來的才寫「被否決後遞補」（走一遍的缺口）', () => {
  const order = ['SPGI', 'SYK', 'T', 'VYLR', 'COST', 'GOOG', 'MSI', 'AAPL'];
  it('replacements：沒有否決時會買的是排名最前的那幾檔；不在那幾檔之內的進場才是遞補，照排名配對；遞補者也被否決的那一格留在核心', () => {
    // 5 個空位，SPGI、SYK 被否決 → 進場 T、VYLR、COST、GOOG、MSI；COST 沒有否決也會買
    expect([...replacements(order, ['COST', 'GOOG', 'MSI', 'T', 'VYLR'], ['SYK', 'SPGI'])]).toEqual([
      ['SPGI', 'GOOG'],
      ['SYK', 'MSI'],
    ]);
    // 遞補者 GOOG 也被否決、留一格在核心
    expect([...replacements(order, ['T', 'VYLR', 'COST', 'MSI'], ['SPGI', 'GOOG'], 1)]).toEqual([
      ['SPGI', 'MSI'],
      ['GOOG', null],
    ]);
    // 被否決的排在所有進場的後面（只是遞補候選）：不配
    expect([...replacements(order, ['SPGI', 'SYK'], ['AAPL'])]).toEqual([['AAPL', null]]);
  });

  it('recordReplacements：遞補紀錄照排名配對（原本把沒有否決也會買的 COST 記成 SPGI 的遞補）', async () => {
    const d = await freshDb();
    try {
      const ins = d.db.prepare("INSERT INTO mom_reviews (month, ticker, rank, decision, source, hits, created_at, updated_at) VALUES ('2026-12', ?, ?, 'VETO', 'AI', '[]', 'x', 'x')");
      await ins.bind('SPGI', 1).run();
      await ins.bind('SYK', 2).run();
      await recordReplacements(d.db, '2026-12', ['COST', 'GOOG', 'MSI', 'T', 'VYLR'], order, 0);
      const rows = (await d.db.prepare("SELECT ticker, replaced_by FROM mom_reviews WHERE month = '2026-12' ORDER BY ticker").all<{ ticker: string; replaced_by: string }>()).results;
      expect(rows).toEqual([
        { ticker: 'SPGI', replaced_by: 'GOOG' },
        { ticker: 'SYK', replaced_by: 'MSI' },
      ]);
    } finally {
      await d.dispose();
    }
  });
});

// ---------------------------------------------------------------- 申報原文

describe('T34：F24、F7、F25 讀得到檔名沒有 99 的財報新聞稿（走一遍的缺口）', () => {
  it('fetchFilingDoc：8-K Item 2.02 的目錄找不到 EX-99.1 → 讀索引頁的 Type 欄；不是 2.02 的不多抓', async () => {
    const index = readFileSync(join(HERE, 'fixtures', 'edgar-press', 'nvda-2026-08-26-index.html'), 'utf8');
    const urls: string[] = [];
    const fetcher: Fetcher = async (url) => {
      urls.push(url);
      if (url.endsWith('/index.json')) return Response.json({ directory: { item: [{ name: 'nvda-20260826.htm' }, { name: 'q2fy27pr.htm' }] } });
      if (url.endsWith('-index.html')) return new Response(index);
      if (url.endsWith('q2fy27pr.htm')) return new Response('<html><body><p>NVIDIA Announces Financial Results for Second Quarter Fiscal 2027</p></body></html>');
      return new Response('<html><body><p>Item 2.02 Results of Operations and Financial Condition.</p></body></html>');
    };
    const ref = { accession: '0001045810-26-000073', form: '8-K', items: ['2.02', '9.01'], filingDate: '2026-08-26', acceptedAt: '2026-08-26T20:20:00.000Z', primaryDocument: 'nvda-20260826.htm' };
    const doc = await fetchFilingDoc(fetcher, '1045810', ref, 'ua');
    expect(doc.title).toContain('＋EX-99.1');
    expect(doc.text).toContain('NVIDIA Announces Financial Results');
    expect(urls.some((u) => u.endsWith('0001045810-26-000073-index.html'))).toBe(true);
    // 不是財報（例如 5.02）：目錄找不到就只用本文，不多讀索引頁
    urls.length = 0;
    const other = await fetchFilingDoc(fetcher, '1045810', { ...ref, items: ['5.02'] }, 'ua');
    expect(other.title).not.toContain('EX-99.1');
    expect(urls.some((u) => u.endsWith('-index.html'))).toBe(false);
  });
});

// ---------------------------------------------------------------- 券商畫面的代號寫法

describe('T34：券商畫面的代號寫法不一樣（走一遍的缺口）', () => {
  it('BRK-B、BRK B、brk/b 都當成 BRK.B：持股頁的網址、貼回的論點區塊', async () => {
    await withWorld(async (c) => {
      for (const t of ['BRK-B', 'brk.b']) {
        const r = await c.api<{ ticker: string }>('GET', `holding/${t}`);
        expect(r.status, t).toBe(200);
        expect(r.body.ticker, t).toBe('BRK.B');
      }
    });
    const block = (tk: string) => `===STOCKBOT 論點 v1 ${tk}===\n論點：\n波克夏的保險浮存金\n前提：\n1. 保險本業持續獲利\n出場條件：\n1. 公司在 8-K 宣布停止買回 → 重新審查\n這次的結論：維持\n理由：沒變\n===END===`;
    expect(parseThesisBlock(block('BRK-B'), 'BRK.B')).toMatchObject({ found: true, error: null, premises: ['保險本業持續獲利'] });
    expect(parseThesisBlock(block('BRK.B'), 'BRK.B').error).toBeNull();
    expect(parseThesisBlock(block('MU'), 'BRK.B').error).toBe('這段是 MU 的論點，這一頁是 BRK.B。請貼這一檔的討論結果。');
  });

  it('填快照新增自選：代號寫成 BRK-B 也記成 BRK.B（不會變成兩檔）', async () => {
    await withWorld(async (c) => {
      const form = await c.api<{ buckets: Record<string, { ticker: string; expected: number }[]>; cashExpected: number }>('GET', 'snapshot/form');
      expect(form.status).toBe(200);
      const acct0 = (await loadAccount(c.db))!.acct;
      const own = Object.fromEntries(form.body.buckets.own.map((r) => [r.ticker, r.expected]));
      const core = Object.fromEntries(form.body.buckets.core.map((r) => [r.ticker, r.expected]));
      const r = await c.api('POST', 'snapshot', { cash: acct0.cash - 10 * c.view.close.VOO[c.view.i], lots: { own: { ...own, 'BRK-B': 10 }, mom: {}, core }, why: { 'BRK-B': '保險浮存金' } });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const a = (await loadAccount(c.db))!.acct as Account;
      expect(a.lots.own['BRK.B']).toBe(10);
      expect(a.lots.own['BRK-B']).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------- 只能從畫面驗收的部分

describe('T34：只能從畫面驗收的修補（截圖之外，鎖住程式還在）', () => {
  const js = (f: string) => readFileSync(join(HERE, '..', 'public', 'js', f), 'utf8');
  it('整則「這次不做」而減半項目沒寫理由：直接打開那一項、選好「這次不做」，理由欄就出現', () => {
    expect(js('pages-notif.js')).toMatch(/input\[type="radio"\]\[value="SKIP"\]/);
  });
  it('編輯論點頁存檔之後（出場條件沒送出去）頁首小字改成存好的版本', () => {
    expect(js('pages-thesis.js')).toContain("document.querySelector('.banner .kicker')");
  });
  it('持股頁以論點為主：論點、要看的事、出場條件、事件、AI 審查與你的回應、慢規則（底線）', () => {
    const s = js('pages-holding.js');
    for (const t of ["panelTop('論點'", "panelTop('要看的事'", "panelTop('出場條件'", "panelTop('事件'", "panelTop('AI 審查與你的回應'", "panelTop('慢規則（底線）'"]) expect(s).toContain(t);
    expect(s.indexOf('thesisPanel(d), attentionPanel(d), condPanel(ctx, d), eventPanel(d), reviewPanel(d), rulePanel(ctx, d, main)')).toBeGreaterThan(0);
  });
  it('「要看的事」不再整行是連結；崩盤檢視紀錄表的表頭不換行、表在自己的框裡左右捲', () => {
    expect(js('parts.js')).not.toContain("h('a', { href: `#/h/${encodeURIComponent(x.ticker)}` }, x.text)");
    const css = readFileSync(join(HERE, '..', 'public', 'app.css'), 'utf8');
    expect(css).toContain('.crash-log th { white-space: nowrap; }');
    expect(css).toContain('.more-body > * { min-width: 0; }');
  });
});

