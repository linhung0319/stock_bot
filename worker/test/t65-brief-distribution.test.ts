// T65：市場摘要分給個股、顯示、RUNUP；資料庫大小的統計與告警（composite_layer_design_2026-11-21 §1.6～§1.8、§4.1；計畫階段十）。
// 完成條件：
//   1 分給個股（§1.6）：定期審查、提前審查、減半檢視、草稿的證據包多一份 brief:<訊號日>（kind = note）；只放 facts、大盤的原因、
//     這檔產業 ETF 的原因；30 個日曆天內最近的一份、有定稿用定稿（手動開的、沒寫成的、決策日之後的不取）；
//     不能當引用（不成立、正面引用都不認）；新眼光看得到、不能引用；三個個股 prompt 多一句（沒有升版號）
//   2 RUNUP（§1.7）：產業 ETF 兩年比大盤多漲 ≥ 100 個百分點 →「要看的事」一行（文字照設計）；持股頁成立就列、月報每檔每 6 個月一次；
//     不開審查、不下單、不發通知
//   3 顯示（§1.8）：AI 紀錄多一種（列表的說明、紀錄頁的市場摘要那一塊）；首頁最近 10 個交易日內有摘要時一行與連結；
//     LINE 不另外推，當天有其他通知時加一行「市場摘要：<第一個原因，或「原因不明」>」
//   4 資料庫大小（§4.1）：運作統計多一段；超過 300 MB 告警（每 30 天一次）
// 對外請求全部是假的（價格、EDGAR、RSS、雲端排程、LINE）；AI 的回覆一律是假的。repo 是公開的。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkSample, type EvidencePack, type PackDoc } from '../src/ai/check';
import { OWN_DROP, OWN_DROP_PROMPT } from '../src/ai/drops';
import { checkNewRisks, freshView } from '../src/ai/freshEyes';
import { BRIEF_HOME_DAYS, BRIEF_NOTE_HEAD, BRIEF_PACK_DAYS, MARKET_BRIEF, MARKET_BRIEF_PROMPT, briefFirstCause, briefLine, briefNoteDoc, isBriefDoc, type MarketBrief } from '../src/ai/marketBrief';
import { OWN_DRAFT_PROMPT } from '../src/ai/ownDraft';
import { OWN_REVIEW_PROMPT, brokenPremises } from '../src/ai/ownReview';
import type { StartCtx } from '../src/app/aiCtx';
import { listRuns, type AiRun } from '../src/app/aiRuns';
import { startDropRuns } from '../src/app/dropAi';
import type { Env, Fetcher } from '../src/app/env';
import type { FilingCheck } from '../src/app/filings';
import { setStateStmt } from '../src/app/filings';
import { pushPending, runFlow } from '../src/app/flow';
import { LINE_PUSH_URL, notifText } from '../src/app/line';
import { loadAccount, saveAccount } from '../src/app/ledgerStore';
import { briefLinesFor, briefNote, homeBrief, latestBrief } from '../src/app/marketBrief';
import { DB_ALERT_KEY, DB_SIZE, OPS_SECTIONS, buildOpsReport, dbSizeAlert, dbSizeSection } from '../src/app/opsReport';
import { startOwnReview } from '../src/app/ownAi';
import { startOwnDraft } from '../src/app/ownDraft';
import { RUNUP, runupHits, runupOf, runupText } from '../src/app/runup';
import { briefRunView, runDetail, runRow } from '../src/app/site/aiViews';
import { dueAttention, holdingAttention, monthOwnAttention } from '../src/app/thesis';
import { tradingDaysBetween } from '../src/data/calendar';
import type { CompanyFacts, XbrlFact } from '../src/data/edgar';
import { buildMarketView } from '../src/data/marketView';
import { loadSeries, saveSeries } from '../src/data/store';
import { createAccount, strategyReminder, type Account, type MarketView, type Premise } from '../src/engine';
import { handle } from '../src/index';
import { freshDb } from './helpers/d1';
import { cronTime, fakeFetcher, newWorld, type World } from './helpers/fakeSources';

const PROMPTS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'ai', 'prompts');
const read = (f: string) => readFileSync(join(PROMPTS, f), 'utf8');

// ---------------------------------------------------------------- 假的市場摘要

const AS_OF = '2026-11-19';
const B_DAY = '2026-11-05';
const CAUSE_MKT = '報導指出聯準會官員的談話讓市場下修 12 月降息的預期';
const CAUSE_XLK = '報導指出記憶體報價轉弱拖累半導體類股';
const CAUSE_XLE = '報導指出油價急跌拖累能源類股';
const FACTS = ['VOO 2026-11-05 單日 -3.6%', '股票池 50 檔裡，2026-11-05 下跌的有 76%', 'XLK 2026-11-04～2026-11-05 漲跌 -7.0%，比 VOO 多跌 3.4 個百分點'];
const cause = (scope: 'MARKET' | 'GROUP', group: string | null, text: string, confidence: 'HIGH' | 'MEDIUM' | 'LOW' = 'HIGH', o: Partial<MarketBrief['causes'][number]> = {}): MarketBrief['causes'][number] => ({ scope, group, kind: scope === 'MARKET' ? 'POLICY' : 'SECTOR_NEWS', text, confidence, evidence_ids: ['E1'], headline_only: false, lowered: null, ...o });
function mkBrief(session: string, o: Partial<MarketBrief> = {}): MarketBrief {
  return {
    event_id: session,
    as_of: session,
    period: { from: tradingDaysBetween('2026-10-01', session).at(-2)!, to: session },
    stage: 'PROVISIONAL',
    facts: FACTS,
    causes: [cause('MARKET', null, CAUSE_MKT), cause('GROUP', 'XLK', CAUSE_XLK, 'MEDIUM'), cause('GROUP', 'XLE', CAUSE_XLE, 'LOW')],
    unknown: false,
    clarity: 'HIGH',
    changed_since_provisional: null,
    groups: ['XLK', 'XLE'],
    core: 'VOO',
    evidence: [{ id: 'E1', source_id: 'web:cnbc1', date: session, quote: 'Federal Reserve officials signaled that a December rate cut was not assured', claim: '報導這樣寫', kind: 'web', title: '〔網頁｜cnbc.com〕Stocks tumble', url: 'https://www.cnbc.com/x', tier: 'MEDIA', domain: 'cnbc.com' }],
    dropped: [],
    notes: [],
    report: null,
    ...o,
  };
}
let seq = 0;
async function putBrief(db: D1Database, session: string, o: { stage?: 'PROVISIONAL' | 'FINAL'; manual?: boolean; status?: 'READY' | 'FAILED' | 'PENDING'; brief?: MarketBrief; runId?: string } = {}): Promise<string> {
  const stage = o.stage ?? 'PROVISIONAL';
  const runId = o.runId ?? `${session}_MARKET_BRIEF_${String(++seq).padStart(6, '0')}`;
  const b = o.brief ?? mkBrief(session, { stage });
  const status = o.status ?? 'READY';
  await db
    .prepare('INSERT INTO market_briefs (event_id, stage, run_id, session, period_from, period_to, why, manual, status, payload, created_at, settled_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(o.manual ? `manual-${session}` : session, stage, runId, session, b.period.from, b.period.to, '測試', o.manual ? 1 : 0, status, status === 'READY' ? JSON.stringify(b) : null, `${session}T23:40:00.000Z`, status === 'PENDING' ? null : `${session}T23:59:00.000Z`)
    .run();
  return runId;
}
const docOf = (pack: Pick<EvidencePack, 'documents'>) => pack.documents.find((d) => d.source_id.startsWith('brief:'));

// ---------------------------------------------------------------- 假的世界（自選 NVDA，產業 ETF 是 XLK）

const PREMISES: Premise[] = [
  { id: 'P1', text: '資料中心需求延續到 2027', origin: 'USER', breaksIf: ['連兩季營收年增率低於 15%'], confirmsIf: '10-Q 的營收年增率仍高於 30%' },
  { id: 'P2', text: 'HBM 的合約價仍然逐季上漲', origin: 'USER', breaksIf: ['TrendForce 的新聞稿報 HBM 合約價季跌'] },
];
const Q_REV = 'Revenue for the third quarter was $160 million, up 33% from a year ago';
const rev = (end: string, val: number, filed: string): XbrlFact => {
  const [y, m] = end.split('-').map(Number);
  return { start: `${y}-${String(m - 2).padStart(2, '0')}-01`, end, val, accn: `acc-${filed}`, form: '10-Q', filed };
};
const FACTS_XBRL: CompanyFacts = { cik: 1045810, facts: { 'us-gaap': { Revenues: { units: { USD: [rev('2025-09-30', 120, '2025-11-01'), rev('2026-09-30', 160, '2026-10-30')] } } } } };
const TENQ = { accession: '0001045810-26-000300', form: '10-Q', items: '', acceptanceDateTime: '2026-10-30T20:10:00.000Z', filingDate: '2026-10-30', primaryDocument: 'q.htm', html: `<html><body><p>Item 2. Management’s Discussion and Analysis of Financial Condition and Results of Operations</p><p>${Q_REV}.</p><p>Item 3. Quantitative and Qualitative Disclosures About Market Risk</p></body></html>` };
const subs = Response.json({ cik: '1045810', name: 'NVIDIA CORP', tickers: [], filings: { recent: { accessionNumber: [TENQ.accession], form: [TENQ.form], items: [TENQ.items], acceptanceDateTime: [TENQ.acceptanceDateTime], filingDate: [TENQ.filingDate], primaryDocument: [TENQ.primaryDocument] } } });

function fetcherOf(w: World, line: string[]): Fetcher {
  const base = fakeFetcher(w);
  return async (url, init) => {
    if (url === LINE_PUSH_URL) {
      line.push((JSON.parse(String(init?.body)) as { messages: { text: string }[] }).messages[0].text);
      return Response.json({});
    }
    if (url === 'https://api.example/fire') return Response.json({ claude_code_session_url: 'https://claude.ai/code/x' });
    if (url.includes('submissions/CIK0001045810.json')) return subs.clone();
    if (/companyfacts\/CIK\d+\.json/.test(url)) return Response.json(FACTS_XBRL);
    const doc = /Archives\/edgar\/data\/(\d+)\/(\d+)\/(.+)$/.exec(url);
    if (doc) return doc[3] === 'index.json' ? Response.json({ directory: { item: [{ name: TENQ.primaryDocument }] } }) : new Response(TENQ.html);
    if (url.startsWith('https://www.nasdaq.com/feed/rssoutbound') || url.startsWith('https://feeds.finance.yahoo.com/rss/2.0/headline')) return new Response('<rss><channel></channel></rss>');
    if (url.includes('sec.gov/files/company_tickers.json')) return Response.json({ 0: { cik_str: 1045810, ticker: 'NVDA', title: 'NVIDIA CORP' } });
    return base(url, init);
  };
}

interface Ctx {
  db: D1Database;
  env: Env;
  fetcher: Fetcher;
  line: string[];
  view: MarketView;
  axis: string[];
}
const acctOf = async (db: D1Database): Promise<Account> => (await loadAccount(db))!.acct;

async function withWorld(fn: (c: Ctx) => Promise<void>, opt: { sector?: string | null } = {}) {
  const d = await freshDb();
  try {
    const db = d.db;
    const w = newWorld(AS_OF);
    const line: string[] = [];
    const env: Env = { DB: db, ADMIN_TOKEN: 't', AI_TASK_SECRET: 's', EDGAR_USER_AGENT: 'test bot test@example.com', SITE_URL: 'https://bot.example', LINE_CHANNEL_TOKEN: 'lt', LINE_USER_ID: 'U1', DEV_NO_AUTH: '1', ROUTINE_FIRE_URL: 'https://api.example/fire', ROUTINE_TOKEN: 'rt' };
    const fetcher = fetcherOf(w, line);
    await runFlow(env, fetcher, { now: cronTime(AS_OF), attempt: 'FIRST' });
    const { view, axis } = buildMarketView(await loadSeries(db, ['VOO', 'SGOV', 'NVDA']), AS_OF, 'VOO');
    const acct = createAccount({ paper: true, cash: 5000, core: { VOO: Math.floor(140_000 / view.close.VOO[view.i]) }, own: { NVDA: { shares: Math.floor(40_000 / view.close.NVDA[view.i]), stdWeight: 0.15, premises: structuredClone(PREMISES) } } }, view);
    acct.own.NVDA.thesis = { text: 'AI 伺服器的資本支出還在擴張', setAt: AS_OF, source: 'TYPED', version: 1, afterBreak: 0, lastAfterBreakAt: null };
    await saveAccount(db, acct, null, '建立帳戶', new Date(`${AS_OF}T12:00:00Z`));
    if (opt.sector !== null) await setStateStmt(db, 'sector:NVDA', opt.sector ?? 'XLK', `${AS_OF}T12:00:00.000Z`).run();
    await fn({ db, env, fetcher, line, view, axis });
  } finally {
    await d.dispose();
  }
}
const T0 = new Date('2026-11-20T01:00:00Z');
const CHECKS: FilingCheck[] = [{ ticker: 'NVDA', cik: '0001045810', names: [], sic: null, all: [{ accession: TENQ.accession, form: '10-Q', filingDate: TENQ.filingDate, acceptedAt: TENQ.acceptanceDateTime, items: [], primaryDocument: 'q.htm' }], fresh: [], latest: '' }];
const dropCtx = async (c: Ctx, session = AS_OF): Promise<StartCtx> => ({ env: c.env, fetcher: c.fetcher, acct: await acctOf(c.db), view: { ...c.view, date: session }, axis: c.axis, session, ov: {}, now: new Date(`${session}T23:45:00Z`), checks: CHECKS, res: { created: [], started: [], log: [], alerts: [] }, extras: { reduced: [{ ticker: 'NVDA', session }] } });
const runsOf = async (c: Ctx, fn: string) => (await listRuns(c.db, new Date(`${AS_OF}T23:50:00Z`), { limit: 50 })).filter((r) => r.fn === fn);

/** 這份文件是只放大盤與 XLK 的市場摘要。 */
function expectBriefDoc(doc: PackDoc | undefined, group: string | null = 'XLK') {
  expect(doc).toBeDefined();
  expect(doc!.kind).toBe('note');
  expect(doc!.source_id).toBe(`brief:${B_DAY}`);
  expect(doc!.date).toBe(B_DAY);
  expect(doc!.title).toContain('不能引用');
  expect(doc!.text).toContain(BRIEF_NOTE_HEAD);
  expect(doc!.text).toContain('不要再找大盤為什麼跌');
  for (const f of FACTS) expect(doc!.text).toContain(f);
  expect(doc!.text).toContain(CAUSE_MKT);
  if (group === 'XLK') expect(doc!.text).toContain(CAUSE_XLK);
  else expect(doc!.text).not.toContain(CAUSE_XLK);
  expect(doc!.text).not.toContain(CAUSE_XLE);
  expect(doc!.text).toContain('報導的說法');
}

// ---------------------------------------------------------------- 1 分給個股（§1.6）

describe('T65 分給個股（§1.6）', () => {
  it('定期審查、提前審查、減半檢視、草稿的證據包都多一份 brief:<訊號日>：kind = note、只有大盤與這檔族群的原因、寫明不能引用；組證據包的紀錄寫一句', async () => {
    await withWorld(async (c) => {
      await putBrief(c.db, B_DAY);
      const acct = await acctOf(c.db);
      const review = await startOwnReview(c.env, c.fetcher, acct, c.view, c.axis, 'NVDA', 'MANUAL', T0);
      expectBriefDoc(docOf(review.pack));
      expect(review.packNotes.join('\n')).toContain(`附上 ${B_DAY} 的市場摘要（暫定稿；大盤與 XLK 的部分）`);
      const early = await startOwnReview(c.env, c.fetcher, acct, c.view, c.axis, 'NVDA', 'EARLY', new Date('2026-11-20T01:05:00Z'), undefined, undefined, { reason: '測試的提前審查', events: [] });
      expectBriefDoc(docOf(early.pack));
      await startDropRuns(await dropCtx(c));
      const [drop] = await runsOf(c, OWN_DROP);
      expect(drop.promptVersion).toBe('own_drop_v5');
      expectBriefDoc(docOf(drop.pack));
      expect(drop.packNotes.join('\n')).toContain(`附上 ${B_DAY} 的市場摘要`);
      const draft = await startOwnDraft(c.env, c.fetcher, await acctOf(c.db), c.view, c.axis, 'NVDA', 'MANUAL', new Date('2026-11-20T02:00:00Z'));
      expect(draft.promptVersion).toBe('own_draft_v3');
      expectBriefDoc(docOf(draft.pack));
      // 論點那一份照舊在（市場摘要是另外一份）
      expect(review.pack.documents.some((d) => d.source_id.startsWith('thesis:'))).toBe(true);
    });
  });

  it('這檔沒有對到產業 ETF：只放大盤的原因；沒有摘要：不放這一份、組證據包也不寫', async () => {
    await withWorld(
      async (c) => {
        await putBrief(c.db, B_DAY);
        const r = await startOwnReview(c.env, c.fetcher, await acctOf(c.db), c.view, c.axis, 'NVDA', 'MANUAL', T0);
        expectBriefDoc(docOf(r.pack), null);
        expect(r.packNotes.join('\n')).toContain('只有大盤的部分，這檔沒有對到產業 ETF');
      },
      { sector: null },
    );
    await withWorld(async (c) => {
      const r = await startOwnReview(c.env, c.fetcher, await acctOf(c.db), c.view, c.axis, 'NVDA', 'MANUAL', T0);
      expect(docOf(r.pack)).toBeUndefined();
      expect(r.packNotes.join('\n')).not.toContain('市場摘要');
    });
  });

  it('取哪一份：30 個日曆天內最近的一份，同一天有定稿用定稿；手動開的、沒寫成的、還在跑的、決策日之後的、超過 30 天的都不取', async () => {
    const d = await freshDb();
    try {
      const db = d.db;
      await setStateStmt(db, 'sector:MU', 'XLK', 'x').run();
      const got = async (asOf = AS_OF) => (await briefNote(db, 'MU', asOf)).doc;
      expect(await got()).toBeNull();
      // 超過 30 天的不取
      await putBrief(db, '2026-10-16');
      expect(BRIEF_PACK_DAYS).toBe(30);
      expect(await got()).toBeNull();
      expect((await got('2026-11-15'))!.source_id).toBe('brief:2026-10-16');
      // 手動開的、FAILED、PENDING 不取
      await putBrief(db, '2026-11-18', { manual: true });
      await putBrief(db, '2026-11-17', { status: 'FAILED' });
      await putBrief(db, '2026-11-16', { status: 'PENDING' });
      expect(await got()).toBeNull();
      // 30 天內的一份暫定稿 → 取；同一天又寫了定稿 → 用定稿
      await putBrief(db, '2026-11-05');
      expect((await got())!.title).toContain('暫定稿');
      await putBrief(db, '2026-11-05', { stage: 'FINAL', brief: mkBrief('2026-11-05', { stage: 'FINAL', changed_since_provisional: '多了資金面的說法' }) });
      const fin = (await got())!;
      expect(fin.title).toContain('定稿');
      expect(fin.text).toContain('和暫定稿不同的地方：多了資金面的說法');
      // 之後又有一份更近的暫定稿 → 取新的；決策日之後寫的不取（不偷看未來）
      await putBrief(db, '2026-11-12');
      expect((await got())!.source_id).toBe('brief:2026-11-12');
      await putBrief(db, '2026-11-20');
      expect((await got())!.source_id).toBe('brief:2026-11-12');
      // latestBrief 本身照舊讀得到手動開的（AI 紀錄、M7 用）；分給個股的只讀排程開的
      expect((await latestBrief(db, '2026-11-18'))!.row.manual).toBe(1);
      expect((await latestBrief(db, '2026-11-18', 30, { scheduledOnly: true }))!.row.session).toBe('2026-11-12');
    } finally {
      await d.dispose();
    }
  });

  it('不能當引用：三票都判不成立、只引用市場摘要 → 不算不成立；判成立、正面引用只有市場摘要 → 改成證據不足', async () => {
    await withWorld(async (c) => {
      await putBrief(c.db, B_DAY);
      const r = await startOwnReview(c.env, c.fetcher, await acctOf(c.db), c.view, c.axis, 'NVDA', 'MANUAL', T0);
      const brief = docOf(r.pack)!;
      const filing = r.pack.documents.find((x) => x.kind === 'filing')!;
      const quote = CAUSE_XLK; // 市場摘要裡一字不差的一句
      const vote = (k: number) => ({
        run_id: r.runId,
        verdict: 'HOLD',
        premise_checks: [
          { premise_id: 'P1', status: 'HOLDS', evidence_ids: ['E1', 'E2'], confirm_ids: ['E1'] },
          { premise_id: 'P2', status: 'BROKEN', evidence_ids: ['E1'] },
        ],
        evidence: [
          { id: 'E1', source_id: brief.source_id, date: brief.date, quote, claim: '市場摘要說記憶體報價轉弱' },
          { id: 'E2', source_id: filing.source_id, date: filing.date, quote: Q_REV, claim: '營收' },
        ],
        payload: { tier: 'HOLD', condition_checks: [], proposed_conditions: [] },
        report: `第 ${k} 票`,
      });
      const samples = [0, 1, 2].map((k) => checkSample(r.pack, vote(k), k));
      // 引用本身逐字對得上（check.ts 沒有放寬也沒有收緊）
      expect(samples[0].evidence.find((e) => e.id === 'E1')!.ok).toBe(true);
      // 判成立：正面的引用只有市場摘要 → 證據不足（沒有指出正面的引用）
      const p1 = samples[0].premises.find((p) => p.premise_id === 'P1')!;
      expect(p1.status).toBe('INSUFFICIENT');
      expect(p1.holdsIssue).toEqual({ why: 'NO_CONFIRM' });
      // 判不成立：三票都只引用市場摘要 → 不算不成立的前提
      expect(samples.every((s) => s.premises.find((p) => p.premise_id === 'P2')!.status === 'BROKEN')).toBe(true);
      expect(brokenPremises(samples, r.pack)).toEqual([]);
    });
  });

  it('新眼光：給它的那一份有市場摘要（背景）；引用市場摘要的那一條被拿掉', async () => {
    await withWorld(async (c) => {
      await putBrief(c.db, B_DAY);
      await startDropRuns(await dropCtx(c));
      const [drop] = await runsOf(c, OWN_DROP);
      expect(drop.pack.fresh_eyes?.run).toBe(true);
      const f = freshView(drop.pack);
      const shown = f.documents.find((x) => isBriefDoc(x));
      expect(shown?.source_id).toBe(`brief:${B_DAY}`);
      // 論點那一份、審查的摘要照舊不給
      expect(f.documents.some((x) => /^(thesis|review):/.test(x.source_id))).toBe(false);
      const filing = drop.pack.documents.find((x) => x.kind === 'filing')!;
      const rec = checkNewRisks(drop.pack, [
        { text: '記憶體報價轉弱，半導體類股一起跌', source_id: shown!.source_id, date: shown!.date, quote: CAUSE_XLK },
        { text: '營收成長要靠資料中心，一旦放緩影響很大', source_id: filing.source_id, date: filing.date, quote: Q_REV },
      ])!;
      expect(rec.items[0]).toMatchObject({ ok: false, drop: 'NOT_GIVEN', why: '引用的是市場摘要（背景，不能引用）' });
      expect(rec.items[1].ok).toBe(true);
    });
  });

  it('prompt：審查、減半檢視、草稿多一句（大盤與族群的原因已經在市場摘要裡，搜尋額度用在這檔自己的前提）；沒有升版號；市場摘要的 prompt 寫明第一條放最重要的', () => {
    expect([OWN_REVIEW_PROMPT, OWN_DROP_PROMPT, OWN_DRAFT_PROMPT, MARKET_BRIEF_PROMPT]).toEqual(['own_review_v5', 'own_drop_v5', 'own_draft_v3', 'market_brief_v2']);
    for (const f of ['own_review_v4.md', 'own_drop_v4.md', 'own_draft_v2.md']) {
      const t = read(f);
      expect(t, f).toContain('`brief:<訊號日>`');
      expect(t, f).toContain('不要再找大盤為什麼跌');
      expect(t, f).toMatch(/T65.*還沒部署，直接改、沒有升版/);
      expect(t, f).toContain('不能引用');
    }
    // 新眼光的那一份寫明有市場摘要
    expect(read('own_review_v4.md')).toContain('以及市場摘要那一份 note（有的話；背景，不能引用）');
    expect(read('own_drop_v4.md')).toContain('以及市場摘要那一份 note（有的話；背景，不能引用）');
    // 減半檢視：歸類照舊以跌幅拆解為準
    expect(read('own_drop_v4.md')).toContain('市場摘要不能推翻它');
    const mb = read('market_brief_v1.md');
    expect(mb).toContain('**第一條放報導支持得最多、和這次波動最有關的**');
    expect(mb).toMatch(/T65.*還沒部署也沒跑過，直接改、沒有升版/);
  });
});

// ---------------------------------------------------------------- 2 RUNUP（§1.7）

/** 兩年多的交易日；VOO 每天 +0.03%，XLK 在最近 RUNUP.days 個交易日漲 total（相對 VOO 的超額另外算）。 */
const RDAYS = tradingDaysBetween('2024-09-03', AS_OF);
function runupView(xlkTotal: number, n = RDAYS.length): Pick<MarketView, 'i' | 'close'> {
  const days = RDAYS.slice(-n);
  const voo = new Float64Array(days.map((_, k) => 100 * 1.0003 ** k));
  const xlk = new Float64Array(days.map((_, k) => 100 * (1 + xlkTotal) ** ((k - (days.length - 1 - RUNUP.days)) / RUNUP.days)));
  return { i: days.length - 1, close: { VOO: voo, XLK: xlk } };
}
const ACCT = { own: { MU: {} as never }, cfg: { coreTicker: 'VOO' } as never };

describe('T65 漲太多的提示 RUNUP（§1.7）', () => {
  it('門檻：產業 ETF 兩年比大盤多漲 100 個百分點（簡單相減）；文字照設計；資料不到兩年、沒有對到產業 ETF 不列', () => {
    expect(RUNUP).toEqual({ days: 500, minDays: 480, excess: 1, every: 6 });
    const v = runupView(1.5);
    const r = runupOf(v, 'XLK', 'VOO')!;
    expect(r.excess).toBeCloseTo(r.etf - r.core, 10);
    const hits = runupHits(ACCT, v, { MU: 'XLK' });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ ticker: 'MU', kind: 'RUNUP', src: 'own', key: 'RUNUP', every: 6, since: '' });
    expect(hits[0].text).toBe(runupText('MU', 'XLK', 'VOO', r));
    expect(hits[0].text).toMatch(/^MU 所屬的產業（XLK）兩年來比大盤多漲 1\d\d%（XLK \+1\d\d%，VOO \+\d+%）。研究顯示這種漲幅之後兩年內大跌的機率明顯升高，但平均報酬沒有變差；不用下單，留意部位大小$/);
    // 剛好不到門檻 → 不列
    const voo2y = runupOf(runupView(0), 'VOO', 'VOO')!.etf;
    expect(runupHits(ACCT, runupView(voo2y + 0.99), { MU: 'XLK' })).toEqual([]);
    expect(runupHits(ACCT, runupView(voo2y + 1.01), { MU: 'XLK' })).toHaveLength(1);
    // 資料不到 480 個交易日 → 不列（不用較短的期間代替）
    expect(runupHits(ACCT, runupView(3, 470), { MU: 'XLK' })).toEqual([]);
    expect(runupOf(runupView(3, 470), 'XLK', 'VOO')).toBeNull();
    // 沒有對到產業 ETF → 不列
    expect(runupHits(ACCT, v, {})).toEqual([]);
  });

  it('持股頁列出；月報每檔每 6 個月一次；不開審查、不下單、不發通知', async () => {
    const d = await freshDb();
    try {
      const db = d.db;
      const v = runupView(1.6);
      const toSeries = (t: string) => ({ ticker: t, fetchedAt: 'x', session: AS_OF, d: RDAYS, c: Array.from(v.close[t]), a: Array.from(v.close[t]), v: RDAYS.map(() => 1e6) });
      await saveSeries(db, [toSeries('VOO'), toSeries('XLK'), { ...toSeries('VOO'), ticker: 'MU' }, { ...toSeries('VOO'), ticker: 'SGOV' }]);
      const { view } = buildMarketView(await loadSeries(db, ['VOO', 'MU', 'SGOV']), AS_OF, 'VOO');
      const acct = createAccount({ paper: true, cash: 1000, core: { VOO: 10 }, own: { MU: { shares: 5, stdWeight: 0.1 } } }, view);
      await saveAccount(db, acct, null, '建立帳戶', new Date(`${AS_OF}T12:00:00Z`));
      // 還沒對到產業 ETF：不列
      expect((await holdingAttention(db, acct, view, 'MU')).some((x) => x.kind === 'RUNUP')).toBe(false);
      await setStateStmt(db, 'sector:MU', 'XLK', 'x').run();
      const hold = (await holdingAttention(db, acct, view, 'MU')).filter((x) => x.kind === 'RUNUP');
      expect(hold).toHaveLength(1);
      expect(hold[0].text).toContain('MU 所屬的產業（XLK）兩年來比大盤多漲');
      // 月報：第一次列、記 attnShown；不動通知與 AI
      const notifs = acct.notifs.length;
      const m1 = await monthOwnAttention(db, acct, view);
      expect(m1.items.filter((x) => x.kind === 'RUNUP')).toHaveLength(1);
      expect(m1.acct.own.MU.attnShown?.RUNUP).toBe(AS_OF);
      expect(m1.acct.notifs.length).toBe(notifs);
      expect((await db.prepare('SELECT COUNT(*) AS n FROM ai_runs').first<{ n: number }>())!.n).toBe(0);
      // 5 個月後不再列；6 個月後再列（同一個鍵、every = 6）
      const hit = [{ ticker: 'MU', kind: 'RUNUP', src: 'own' as const, key: 'RUNUP', every: 6, since: '', text: hold[0].text }];
      expect(dueAttention(hit, { MU: m1.acct.own.MU.attnShown }, '2027-04-30').due).toEqual([]);
      expect(dueAttention(hit, { MU: m1.acct.own.MU.attnShown }, '2027-05-28').due).toHaveLength(1);
    } finally {
      await d.dispose();
    }
  });
});

// ---------------------------------------------------------------- 3 顯示（§1.8）

/** 送回結果之前的一次市場摘要執行（假的 AiRun）。 */
function briefRun(o: { status?: AiRun['status']; outcome?: AiRun['outcome']; manual?: boolean; stage?: 'PROVISIONAL' | 'FINAL' } = {}): AiRun {
  return {
    runId: `${B_DAY}_MARKET_BRIEF_abc123`,
    fn: MARKET_BRIEF,
    ticker: null,
    asOf: B_DAY,
    createdAt: `${B_DAY}T23:40:00.000Z`,
    completedAt: o.outcome ? `${B_DAY}T23:59:00.000Z` : null,
    status: o.status ?? (o.outcome ? 'DONE' : 'PENDING'),
    promptVersion: MARKET_BRIEF_PROMPT,
    packHash: 'sha256:0000000000000000000000',
    pack: { pack_version: 1, run_id: 'r', function: MARKET_BRIEF, prompt_version: MARKET_BRIEF_PROMPT, as_of: B_DAY, created_at: '', subject: {}, question: 'q', policy: { level: 'A2', verdicts: ['DONE', 'INSUFFICIENT'], abstain: 'INSUFFICIENT', min_evidence: 0, samples: 1 }, rule: { action: '只說明', detail: { stage: o.stage ?? 'PROVISIONAL', eventId: B_DAY, period: { from: '2026-11-04', to: B_DAY }, core: 'VOO', groups: ['XLK'], triggers: o.manual ? [{ session: B_DAY, kind: 'MANUAL', group: null, value: null, text: '手動' }] : [{ session: B_DAY, kind: 'MARKET_DAY', group: null, value: -0.036, text: 'VOO 2026-11-05 單日 -3.6%（門檻 2.5%）' }], hasProvisional: false, ...(o.manual ? { manual: true } : {}) } }, facts: [], premises: [], documents: [], data_quality: {}, condition_types: [] },
    outcome: o.outcome ?? null,
    process: [],
    packNotes: [],
  } as unknown as AiRun;
}

describe('T65 顯示（§1.8）', () => {
  it('一句話：第一個原因一律標「報導的說法」與信心；沒有原因或整體原因不明時是「原因不明」', () => {
    expect(briefLine(mkBrief(B_DAY))).toBe(`市場摘要（報導的說法，信心高）：${CAUSE_MKT}`);
    expect(briefLine(mkBrief(B_DAY, { causes: [], unknown: true }))).toBe('市場摘要：原因不明');
    expect(briefLine(mkBrief(B_DAY, { unknown: true }))).toBe('市場摘要：原因不明');
    expect(briefLine(mkBrief(B_DAY, { causes: [cause('MARKET', null, '有報導的標題說科技股領跌。', 'LOW', { headline_only: true })] }))).toBe('市場摘要（報導的說法，信心低，只有新聞標題）：有報導的標題說科技股領跌');
    expect(briefFirstCause(mkBrief(B_DAY, { causes: [] , unknown: true}))).toEqual({ tag: null, text: '原因不明' });
  });

  it('首頁：最近 10 個交易日內有寫好的摘要才有一行（第 10 個交易日還有、第 11 個沒有）；手動開的不算；同一天有定稿用定稿', async () => {
    const d = await freshDb();
    try {
      const db = d.db;
      const axisTo = (end: string) => tradingDaysBetween('2026-09-01', end);
      expect(await homeBrief(db, axisTo(AS_OF))).toBeNull();
      const run = await putBrief(db, B_DAY);
      const days = tradingDaysBetween(B_DAY, '2026-12-31');
      expect(BRIEF_HOME_DAYS).toBe(10);
      // B_DAY 當天算第 1 個交易日：第 10 個交易日還顯示、第 11 個不顯示
      const h10 = await homeBrief(db, axisTo(days[9]));
      expect(h10).toEqual({ runId: run, session: B_DAY, stage: 'PROVISIONAL', period: mkBrief(B_DAY).period, tag: '報導的說法，信心高', text: CAUSE_MKT });
      expect(await homeBrief(db, axisTo(days[10]))).toBeNull();
      const fin = await putBrief(db, B_DAY, { stage: 'FINAL', brief: mkBrief(B_DAY, { stage: 'FINAL', causes: [], unknown: true, changed_since_provisional: '原本的說法被推翻' }) });
      expect(await homeBrief(db, axisTo(days[3]))).toMatchObject({ runId: fin, stage: 'FINAL', tag: null, text: '原因不明' });
      // 手動開的比較新，也不上首頁
      await putBrief(db, days[5], { manual: true });
      expect((await homeBrief(db, axisTo(days[6])))!.runId).toBe(fin);
    } finally {
      await d.dispose();
    }
  });

  it('首頁的資料（/api/state 的 brief）；前端那一行的字', async () => {
    await withWorld(async (c) => {
      const call = async () => (await (await handle(new Request('https://bot.example/api/state'), c.env, c.fetcher, new Date('2026-11-20T02:00:00Z'))).json()) as { brief: unknown };
      expect((await call()).brief).toBeNull();
      // 11-05 到 11-19 是 11 個交易日：首頁不顯示；11-12 的在 10 個交易日內
      await putBrief(c.db, B_DAY);
      expect((await call()).brief).toBeNull();
      const run = await putBrief(c.db, '2026-11-12');
      expect((await call()).brief).toEqual({ runId: run, session: '2026-11-12', stage: 'PROVISIONAL', period: mkBrief('2026-11-12').period, tag: '報導的說法，信心高', text: CAUSE_MKT });
    });
    const js = (await import('../public/js/brief-home.js' as string)) as { homeBriefText(b: unknown): { head: string; text: string; note: string } | null };
    expect(js.homeBriefText(null)).toBeNull();
    const t = js.homeBriefText({ runId: 'x', session: B_DAY, stage: 'FINAL', period: { from: '2026-11-04', to: B_DAY }, tag: '報導的說法，信心高', text: CAUSE_MKT })!;
    expect(t.head).toBe('市場摘要（11/5 定稿，涵蓋 11/4～11/5）');
    expect(t.text).toBe(`報導的說法，信心高：${CAUSE_MKT}`);
    expect(t.note).toContain('只說明，不用操作');
    expect(js.homeBriefText({ runId: 'x', session: B_DAY, stage: 'PROVISIONAL', period: { from: '2026-11-04', to: B_DAY }, tag: null, text: '原因不明' })!.text).toBe('原因不明：沒有找到說得通的原因');
  });

  it('AI 紀錄多一種：列表寫第一個原因；紀錄頁的市場摘要那一塊（寫好了、沒寫成、還在跑、手動開的）', async () => {
    // 用真的程式檢查做出一份寫好的（和存進 market_briefs 的是同一個函式）
    const { judge } = await import('../src/ai/check');
    const { PAYLOAD_HOOKS } = await import('../src/ai/hooks');
    const pending = briefRun();
    expect(briefRunView(pending)).toMatchObject({ state: 'PENDING', stage: '暫定稿', manual: false, triggers: ['大盤大漲跌：VOO 2026-11-05 單日 -3.6%（門檻 2.5%）'] });
    const pack: EvidencePack = {
      ...pending.pack,
      facts: [{ id: 'K1', label: 'k', value: FACTS[0] }],
      documents: [{ id: 'W1', source_id: 'web:cnbc1', kind: 'web', date: B_DAY, title: '〔網頁｜cnbc.com〕Stocks tumble', url: 'https://www.cnbc.com/x', text: 'Stocks tumbled after Federal Reserve officials signaled that a December rate cut was not assured.', tier: 'MEDIA', domain: 'cnbc.com', label: 'cnbc.com' } as PackDoc],
    };
    const sample = { run_id: 'r', function: MARKET_BRIEF, verdict: 'DONE', evidence: [{ id: 'E1', source_id: 'web:cnbc1', date: B_DAY, quote: 'Federal Reserve officials signaled that a December rate cut was not assured', claim: '報導這樣寫' }], payload: { period: { from: '2026-11-04', to: B_DAY }, stage: 'PROVISIONAL', facts: [FACTS[0]], causes: [{ scope: 'MARKET', group: null, kind: 'POLICY', text: CAUSE_MKT, confidence: 'MEDIUM', evidence_ids: ['E1'] }], unknown: false, clarity: 'LOW', changed_since_provisional: null }, report: '報告' };
    const ok = { ...pending, pack, status: 'DONE', outcome: judge(pack, [sample], PAYLOAD_HOOKS[MARKET_BRIEF]) } as AiRun;
    const row = runRow(ok);
    expect(row.label).toBe('市場摘要');
    expect(row.summary).toBe(`市場摘要（報導的說法，信心中）：${CAUSE_MKT}`);
    const v = runDetail(ok).brief!;
    expect(v).toMatchObject({ state: 'READY', stage: '暫定稿', facts: [FACTS[0]], unknown: false, clarity: '各來源的說法不一致，或來源不足' });
    expect(v.line).toContain('不能當前提不成立的依據');
    expect(v.causes).toEqual([{ where: '大盤', kind: '政策', text: CAUSE_MKT, confidence: '中', headline: false, lowered: null, quotes: [{ quote: 'Federal Reserve officials signaled that a December rate cut was not assured', title: 'Stocks tumble', date: B_DAY, url: 'https://www.cnbc.com/x' }] }]);
    // 沒寫成：寫原因
    const bad = { ...ok, outcome: judge(pack, [{ ...sample, payload: { ...sample.payload, facts: ['自己算的數字'] } }], PAYLOAD_HOOKS[MARKET_BRIEF]) } as AiRun;
    const bv = briefRunView(bad)!;
    expect(bv.state).toBe('FAILED');
    expect(bv.line).toMatch(/^這次沒有寫成摘要：程式檢查沒過/);
    expect(runRow(bad).summary).toMatch(/^沒有寫成：程式檢查沒過/);
    // 手動開的：標出來
    expect(briefRunView(briefRun({ manual: true }))).toMatchObject({ manual: true, triggers: ['手動開的（量時間用，不分給個股、不上首頁與 LINE）'] });
    // 不是市場摘要的執行沒有這一塊
    expect(briefRunView({ ...ok, fn: 'OWN_REVIEW' } as AiRun)).toBeNull();
    // 前端有畫這一塊（import 不碰 DOM 的那幾個字）
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'js', 'pages-ai.js'), 'utf8');
    expect(src).toContain('briefBlock(d.brief)');
    expect(src).toContain('報導的說法');
  });

  it('LINE：通知的訊號日有寫好的摘要就加一行；手動開的、別天的不加；沒有摘要不加；沒有通知時不另外推', async () => {
    await withWorld(async (c) => {
      const acct0 = await acctOf(c.db);
      const { acct, notif } = strategyReminder(acct0, c.view, '測試的提醒');
      await saveAccount(c.db, acct, (await loadAccount(c.db))!, '加一則提醒', new Date('2026-11-20T00:00:00Z'));
      expect(notif.date).toBe(AS_OF);
      const text = (n = notif) => notifText(acct, n, 'https://bot.example/#/n/1', null);
      expect(text()).not.toContain('市場摘要');
      // 別天的、手動開的：不加
      await putBrief(c.db, '2026-11-18');
      await putBrief(c.db, AS_OF, { manual: true });
      expect((await briefLinesFor(c.db, [AS_OF])).size).toBe(0);
      await pushPending(c.env, c.fetcher, new Date('2026-11-20T00:30:00Z'), acct, [notif.id], false);
      expect(c.line).toHaveLength(1);
      expect(c.line[0]).not.toContain('市場摘要');
      // 當天寫好的（同一天有定稿用定稿）→ 加一行，在連結前面
      await putBrief(c.db, AS_OF);
      await putBrief(c.db, AS_OF, { stage: 'FINAL', brief: mkBrief(AS_OF, { stage: 'FINAL', causes: [], unknown: true }) });
      const lines = await briefLinesFor(c.db, [AS_OF, '2026-11-18', '2026-11-17']);
      expect(lines.get(AS_OF)).toBe('市場摘要：原因不明');
      expect(lines.get('2026-11-18')).toBe(`市場摘要（報導的說法，信心高）：${CAUSE_MKT}`);
      expect(lines.has('2026-11-17')).toBe(false);
      c.line.length = 0;
      await pushPending(c.env, c.fetcher, new Date('2026-11-20T00:40:00Z'), acct, [notif.id], false);
      expect(c.line).toHaveLength(1);
      const out = c.line[0].split('\n');
      expect(out).toContain('市場摘要：原因不明');
      expect(out.indexOf('市場摘要：原因不明')).toBeLessThan(out.findIndex((l) => l.startsWith('https://')));
      // 沒有通知：不另外推（摘要本身不推）
      c.line.length = 0;
      await pushPending(c.env, c.fetcher, new Date('2026-11-20T00:50:00Z'), acct, [], false);
      expect(c.line).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------- 4 資料庫大小（§4.1）

/** D1 包一層：量大小的那一句回傳假的 size_after，其他照舊。 */
function sizedDb(db: D1Database, bytes: () => number): D1Database {
  return new Proxy(db, {
    get(target, prop, recv) {
      if (prop === 'prepare')
        return (sql: string) => {
          const st = target.prepare(sql);
          if (sql !== 'SELECT 1 AS x') return st;
          return { ...st, all: async () => ({ results: [{ x: 1 }], success: true, meta: { size_after: bytes() } }) } as unknown as D1PreparedStatement;
        };
      const v = Reflect.get(target, prop, recv);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

describe('T65 資料庫大小（§4.1）', () => {
  it('運作統計多一段 db_size：一行，現在的大小（bytes、MB）、告警線 300、免費方案上限 500', async () => {
    const d = await freshDb();
    try {
      expect(OPS_SECTIONS.at(-1)).toBe(dbSizeSection);
      const r = await buildOpsReport(d.db, { from: null, to: AS_OF, fromSource: 'none' }, T0);
      const s = r.sections.find((x) => x.id === 'db_size')!;
      expect(s.error).toBeUndefined();
      expect(s.rows).toHaveLength(1);
      const row = s.rows[0];
      expect(typeof row.bytes).toBe('number');
      expect(row.bytes as number).toBeGreaterThan(0);
      expect(row.mb).toBe(Math.round((row.bytes as number) / 1e5) / 10);
      expect(row).toMatchObject({ alert_mb: 300, free_limit_mb: 500, over_alert: 0 });
      expect(s.title).toContain('不看期間');
      const big = await dbSizeSection(sizedDb(d.db, () => 312_400_000), { from: null, to: AS_OF, fromSource: 'none' });
      expect(big.rows[0]).toMatchObject({ bytes: 312_400_000, mb: 312.4, over_alert: 1, used_ratio: 0.625 });
    } finally {
      await d.dispose();
    }
  });

  it('告警：超過 300 MB 推一次 DB_SIZE、30 天內不再推、30 天後再推；沒超過不推；每日流程掃逾時的那一段會呼叫', async () => {
    const d = await freshDb();
    try {
      let bytes = 299_000_000;
      const db = sizedDb(d.db, () => bytes);
      expect(DB_SIZE).toEqual({ alertMb: 300, freeLimitMb: 500, alertEveryDays: 30 });
      expect(await dbSizeAlert(db, T0)).toBeNull();
      bytes = 301_500_000;
      const a = (await dbSizeAlert(db, T0))!;
      expect(a.kind).toBe('DB_SIZE');
      expect(a.message).toContain('資料庫已經 301.5 MB，超過 300 MB 的告警線');
      expect(a.message).toContain('不影響任何功能');
      expect((await d.db.prepare('SELECT value FROM flow_state WHERE key = ?').bind(DB_ALERT_KEY).first<{ value: string }>())!.value).toBe(T0.toISOString());
      expect(await dbSizeAlert(db, new Date(T0.getTime() + 29 * 86_400_000))).toBeNull();
      expect((await dbSizeAlert(db, new Date(T0.getTime() + 30 * 86_400_000)))?.kind).toBe('DB_SIZE');

      // 每日流程（03:30 的套用，有掃逾時）：寫進 alerts
      await d.db.prepare('DELETE FROM flow_state WHERE key = ?').bind(DB_ALERT_KEY).run();
      const w = newWorld(AS_OF);
      const env: Env = { DB: db, ADMIN_TOKEN: 't', AI_TASK_SECRET: 's', SITE_URL: 'https://bot.example', DEV_NO_AUTH: '1' };
      await runFlow(env, fakeFetcher(w), { now: new Date(`${AS_OF}T03:30:00Z`), attempt: 'APPLY' });
      const rows = (await d.db.prepare("SELECT kind, message FROM alerts WHERE kind = 'DB_SIZE'").all<{ kind: string; message: string }>()).results;
      expect(rows).toHaveLength(1);
      expect(rows[0].message).toContain('301.5 MB');
    } finally {
      await d.dispose();
    }
  });
});

// 讓 briefNoteDoc 這個純函式也直接測一次（給的 group 決定留哪幾條）
describe('T65 briefNoteDoc（純函式）', () => {
  it('group 給 XLK 留大盤與 XLK；給 null 只留大盤；source_id 是 brief:<訊號日>、date 是那一天', () => {
    const b = mkBrief(B_DAY);
    const x = briefNoteDoc(b, B_DAY, 'XLK');
    expect(x).toMatchObject({ id: 'MB', source_id: `brief:${B_DAY}`, kind: 'note', date: B_DAY });
    expect(x.text).toContain(CAUSE_XLK);
    expect(x.text).not.toContain(CAUSE_XLE);
    const n = briefNoteDoc(b, B_DAY, null);
    expect(n.text).toContain(CAUSE_MKT);
    expect(n.text).not.toContain(CAUSE_XLK);
    expect(isBriefDoc(n)).toBe(true);
    expect(isBriefDoc({ ...n, kind: 'web' })).toBe(false);
    expect(isBriefDoc({ ...n, source_id: 'thesis:MU' })).toBe(false);
  });
});
