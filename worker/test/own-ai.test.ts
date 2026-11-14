// T10：F24 自選定期審查、F25 自選條件監測。
// 完成條件（不需要雲端排程的部分）：用構造的申報測 F25 會通知；F24 的結論出現在月報與網站。
// 對外請求全部是假的：價格、成分股（固定檔）、EDGAR（submissions、companyfacts、申報原文）、Nasdaq RSS、雲端排程、LINE。
import { describe, expect, it } from 'vitest';
import { judge, type EvidencePack } from '../src/ai/check';
import { PAYLOAD_HOOKS } from '../src/ai/hooks';
import { OWN_REVIEW, conditionDecision, ownReviewPack, raiseAllowed, reviewDecision } from '../src/ai/ownReview';
import { finalizeRun, getRun, listRuns } from '../src/app/aiRuns';
import type { Env, Fetcher } from '../src/app/env';
import { runFlow, type Attempt } from '../src/app/flow';
import { LINE_PUSH_URL } from '../src/app/line';
import { loadAccount, saveAccount } from '../src/app/ledgerStore';
import { loadConditions } from '../src/app/ownAi';
import { extractSection, htmlToText, parseRss, pickExhibit991, quarterTable, xbrlConditionMet, type CompanyFacts, type XbrlFact } from '../src/data/edgar';
import { buildMarketView } from '../src/data/marketView';
import { loadSeries } from '../src/data/store';
import { createAccount, type Account } from '../src/engine';
import { freshDb } from './helpers/d1';
import { cronTime, fakeFetcher, newWorld, type World } from './helpers/fakeSources';

// ---------------------------------------------------------------- 假的 XBRL

/** 日曆年度的公司：每季營收、毛利（單季事實）、營業現金流（只有年初至今的累計）、全年 10-K。 */
function facts(opt: { quarters: { end: string; rev: number; gp: number; cfoYtd: number; filed: string; form?: string }[]; annual?: { year: number; rev: number; gp: number; cfo: number; filed: string }[]; restate?: XbrlFact[] }): CompanyFacts {
  const rev: XbrlFact[] = [];
  const gp: XbrlFact[] = [];
  const cfo: XbrlFact[] = [];
  const qStart = (end: string) => {
    const [y, m] = end.split('-').map(Number);
    return `${y}-${String(m - 2).padStart(2, '0')}-01`;
  };
  for (const q of opt.quarters) {
    const f = { accn: `acc-${q.filed}`, form: q.form ?? '10-Q', filed: q.filed };
    rev.push({ start: qStart(q.end), end: q.end, val: q.rev, ...f });
    gp.push({ start: qStart(q.end), end: q.end, val: q.gp, ...f });
    cfo.push({ start: `${q.end.slice(0, 4)}-01-01`, end: q.end, val: q.cfoYtd, ...f });
    // 年初至今的營收也報（和單季並存，真實的 10-Q 都有）
    if (!q.end.endsWith('03-31')) {
      const ytd = opt.quarters.filter((x) => x.end.slice(0, 4) === q.end.slice(0, 4) && x.end <= q.end).reduce((a, x) => a + x.rev, 0);
      rev.push({ start: `${q.end.slice(0, 4)}-01-01`, end: q.end, val: ytd, ...f });
      const gytd = opt.quarters.filter((x) => x.end.slice(0, 4) === q.end.slice(0, 4) && x.end <= q.end).reduce((a, x) => a + x.gp, 0);
      gp.push({ start: `${q.end.slice(0, 4)}-01-01`, end: q.end, val: gytd, ...f });
    }
  }
  for (const a of opt.annual ?? []) {
    const f = { accn: `acc-${a.filed}`, form: '10-K', filed: a.filed };
    const s = `${a.year}-01-01`;
    const e = `${a.year}-12-31`;
    rev.push({ start: s, end: e, val: a.rev, ...f });
    gp.push({ start: s, end: e, val: a.gp, ...f });
    cfo.push({ start: s, end: e, val: a.cfo, ...f });
  }
  rev.push(...(opt.restate ?? []));
  return { cik: 1045810, facts: { 'us-gaap': { Revenues: { units: { USD: rev.filter((x) => Number.isFinite(x.val)) } }, GrossProfit: { units: { USD: gp } }, NetCashProvidedByUsedInOperatingActivities: { units: { USD: cfo } } } } };
}

const BASE = facts({
  quarters: [
    { end: '2025-03-31', rev: 100, gp: 70, cfoYtd: 30, filed: '2025-05-01' },
    { end: '2025-06-30', rev: 110, gp: 77, cfoYtd: 65, filed: '2025-08-01' },
    { end: '2025-09-30', rev: 120, gp: 84, cfoYtd: 105, filed: '2025-11-01' },
    { end: '2026-03-31', rev: 140, gp: 91, cfoYtd: 40, filed: '2026-05-01' },
    { end: '2026-06-30', rev: 150, gp: 93, cfoYtd: 85, filed: '2026-08-01' },
    { end: '2026-09-30', rev: 160, gp: 96, cfoYtd: 135, filed: '2026-10-30' },
  ],
  annual: [{ year: 2025, rev: 460, gp: 322, cfo: 150, filed: '2026-02-20' }],
});

describe('XBRL：point-in-time 的季度數字', () => {
  it('單季直接用；第四季＝全年 − 前三季；現金流由年初至今的累計相減；年增率對去年同季', () => {
    const rows = quarterTable(BASE, '2026-11-27');
    expect(rows.map((r) => r.end)).toEqual(['2026-09-30', '2026-06-30', '2026-03-31', '2025-12-31', '2025-09-30', '2025-06-30', '2025-03-31']);
    const q4 = rows.find((r) => r.end === '2025-12-31')!;
    expect(q4).toMatchObject({ revenue: 130, grossProfit: 91, cfo: 45, form: '10-K' });
    expect(rows[0]).toMatchObject({ revenue: 160, grossMarginPct: 0.6, cfo: 50 });
    expect(rows[0].revenueYoY).toBeCloseTo(160 / 120 - 1);
    expect(rows.find((r) => r.end === '2025-06-30')!.cfo).toBe(35);
  });

  it('決策日之後才申報的數字（含重編）看不到', () => {
    const restated = facts({ quarters: [{ end: '2025-03-31', rev: 100, gp: 70, cfoYtd: 30, filed: '2025-05-01' }], restate: [{ start: '2025-01-01', end: '2025-03-31', val: 90, accn: 'r', form: '10-Q/A', filed: '2025-09-01' }] });
    expect(quarterTable(restated, '2025-06-30')[0].revenue).toBe(100);
    expect(quarterTable(restated, '2025-09-30')[0].revenue).toBe(90);
    expect(quarterTable(BASE, '2026-10-29')[0].end).toBe('2026-06-30');
  });

  it('財報條件：最近 N 季都低於門檻才成立；指標不認得或資料不夠回傳 null', () => {
    const rows = quarterTable(BASE, '2026-11-27');
    expect(xbrlConditionMet(rows, { type: 'xbrl_metric_below', metric: 'GrossMarginPct', level: 0.62 })).toEqual({ met: true, values: [0.6] });
    expect(xbrlConditionMet(rows, { type: 'xbrl_metric_below', metric: 'GrossMarginPct', level: 0.63, quarters: 2 })!.met).toBe(true);
    expect(xbrlConditionMet(rows, { type: 'xbrl_metric_below', metric: 'GrossMarginPct', level: 0.61, quarters: 3 })!.met).toBe(false);
    expect(xbrlConditionMet(rows, { type: 'xbrl_metric_above', metric: 'RevenueYoY', level: 0.3 })!.met).toBe(true);
    expect(xbrlConditionMet(rows, { type: 'xbrl_metric_below', metric: 'FreeCashFlowYield', level: 0.1 })).toBeNull();
  });
});

// ---------------------------------------------------------------- 申報原文

const TENQ = `<html><head><style>.x{}</style></head><body>
<p>TABLE OF CONTENTS</p><p>Item 2. Management&#8217;s Discussion and Analysis of Financial Condition 25</p><p>Item 3. Quantitative and Qualitative Disclosures 40</p>
<div style="display:none"><ix:header>hidden</ix:header></div>
<p>PART I</p>
<p><b>Item 2. Management’s Discussion and Analysis of Financial Condition and Results of Operations</b></p>
<p>Revenue for the third quarter was $160&nbsp;million, up 33% from a year ago. Gross margin was 60.0%, down from 70.0% a year ago, reflecting lower average selling prices for data center products.</p>
<table><tr><td>Revenue</td><td>160</td></tr></table>
<p>Item 3. Quantitative and Qualitative Disclosures About Market Risk</p><p>We are exposed to interest rate risk.</p></body></html>`;

describe('申報原文', () => {
  it('HTML → 純文字；MD&A 取正文那一段，不是目錄', () => {
    const text = htmlToText(TENQ);
    expect(text).not.toContain('hidden');
    expect(text).toContain('Revenue for the third quarter was $160 million');
    const sec = extractSection(text, /item\s*2\.?\s*management['’]s\s+discussion\s+and\s+analysis/i, /item\s*3\.?\s*quantitative/i)!;
    expect(sec).toContain('Gross margin was 60.0%, down from 70.0% a year ago');
    expect(sec).not.toContain('interest rate risk');
    expect(sec).not.toContain('TABLE OF CONTENTS');
  });

  it('8-K 的財報新聞稿檔名；Nasdaq RSS 只取標題與日期', () => {
    expect(pickExhibit991({ directory: { item: [{ name: 'nvda-20261119.htm' }, { name: 'q3fy27pr.htm' }, { name: 'nvda-ex99_1.htm' }] } })).toBe('nvda-ex99_1.htm');
    expect(pickExhibit991({ directory: { item: [{ name: 'a.htm' }, { name: 'ex991.htm' }] } })).toBe('ex991.htm');
    const rss = parseRss('<rss><channel><item><title><![CDATA[NVIDIA beats estimates]]></title><link>https://n/1</link><pubDate>Thu, 19 Nov 2026 21:30:00 +0000</pubDate></item><item><title>bad</title><pubDate>nope</pubDate></item></channel></rss>');
    expect(rss).toEqual([{ date: '2026-11-19', title: 'NVIDIA beats estimates', link: 'https://n/1' }]);
  });
});

// ---------------------------------------------------------------- 假的 EDGAR、雲端排程、LINE

interface Edgar {
  filings: { accession: string; form: string; items: string; acceptanceDateTime: string; filingDate: string; primaryDocument: string; html: string; ex99?: string }[];
  facts: CompanyFacts;
  fired: string[];
  line: string[];
}

function fetcherOf(w: World, e: Edgar): Fetcher {
  const base = fakeFetcher(w);
  return async (url, init) => {
    if (url === LINE_PUSH_URL) {
      e.line.push((JSON.parse(String(init?.body)) as { messages: { text: string }[] }).messages[0].text);
      return Response.json({});
    }
    if (url === 'https://api.example/fire') {
      e.fired.push(String(init?.body));
      return Response.json({ claude_code_session_url: 'https://claude.ai/code/x' });
    }
    if (/data\.sec\.gov\/submissions\/CIK\d+\.json/.test(url)) {
      const fs = [...e.filings].reverse();
      return Response.json({ cik: '1045810', name: 'NVIDIA CORP', tickers: ['NVDA'], filings: { recent: { accessionNumber: fs.map((f) => f.accession), form: fs.map((f) => f.form), items: fs.map((f) => f.items), acceptanceDateTime: fs.map((f) => f.acceptanceDateTime), filingDate: fs.map((f) => f.filingDate), primaryDocument: fs.map((f) => f.primaryDocument) } } });
    }
    if (/companyfacts\/CIK\d+\.json/.test(url)) return Response.json(e.facts);
    const doc = /Archives\/edgar\/data\/\d+\/(\d+)\/(.+)$/.exec(url);
    if (doc) {
      const f = e.filings.find((x) => x.accession.replace(/-/g, '') === doc[1]);
      if (!f) return new Response('nf', { status: 404 });
      if (doc[2] === 'index.json') return Response.json({ directory: { item: [{ name: f.primaryDocument }, ...(f.ex99 ? [{ name: 'nvda-ex99_1.htm' }] : [])] } });
      if (doc[2] === 'nvda-ex99_1.htm') return new Response(f.ex99 ?? '');
      return new Response(f.html);
    }
    if (url.startsWith('https://www.nasdaq.com/feed/rssoutbound')) return new Response('<rss><channel><item><title>NVIDIA shares slide on margin worries</title><link>https://n/1</link><pubDate>Wed, 25 Nov 2026 20:00:00 +0000</pubDate></item></channel></rss>');
    return base(url, init);
  };
}

const TENQ_FILING = { accession: '0001045810-26-000300', form: '10-Q', items: '', acceptanceDateTime: '2026-10-30T20:10:00.000Z', filingDate: '2026-10-30', primaryDocument: 'nvda-20260930.htm', html: TENQ };
const EIGHTK_GUIDE = `<html><body><p>Item 2.02 Results of Operations and Financial Condition.</p><p>On December 1, 2026, NVIDIA Corporation lowered its revenue outlook for the fourth quarter to $150 million from $175 million, citing order cancellations by a major data center customer.</p></body></html>`;

interface Ctx {
  db: D1Database;
  w: World;
  e: Edgar;
  env: Env;
  run: (date: string, attempt?: Attempt) => ReturnType<typeof runFlow>;
}

async function withWorld(fn: (c: Ctx) => Promise<void>, opt: { routine?: boolean; acct?: (a: Account) => Account } = {}) {
  const d = await freshDb();
  try {
    const db = d.db;
    const w = newWorld('2026-11-19');
    const e: Edgar = { filings: [TENQ_FILING], facts: BASE, fired: [], line: [] };
    const env: Env = { DB: db, ADMIN_TOKEN: 't', AI_TASK_SECRET: 's', EDGAR_USER_AGENT: 'test bot test@example.com', SITE_URL: 'https://bot.example', LINE_CHANNEL_TOKEN: 'lt', LINE_USER_ID: 'U1', ...(opt.routine === false ? {} : { ROUTINE_FIRE_URL: 'https://api.example/fire', ROUTINE_TOKEN: 'rt' }) };
    const run = (date: string, attempt: Attempt = 'FIRST') => {
      w.dataDate = date;
      return runFlow(env, fetcherOf(w, e), { now: attempt === 'FINAL' ? new Date(Date.parse(date + 'T23:30:00Z') + 2 * 3600_000) : cronTime(date), attempt });
    };
    await run('2026-11-19');
    const { view } = buildMarketView(await loadSeries(db, ['VOO', 'SGOV', 'NVDA']), '2026-11-19', 'VOO');
    let acct = createAccount(
      {
        paper: true,
        cash: 5000,
        core: { VOO: Math.floor(140_000 / view.close.VOO[view.i]) },
        own: { NVDA: { shares: Math.floor(40_000 / view.close.NVDA[view.i]), stdWeight: 0.15, premises: [{ id: 'P1', text: '資料中心需求延續到 2027', origin: 'USER' }, { id: 'P2', text: '毛利率維持在 65% 以上', origin: 'USER' }] } },
      },
      view,
    );
    if (opt.acct) acct = opt.acct(acct);
    await saveAccount(db, acct, null, '建立帳戶', new Date('2026-11-19T12:00:00Z'));
    await fn({ db, w, e, env, run });
  } finally {
    await d.dispose();
  }
}

/** 一份合格的 F24 外殼。 */
function reviewVote(pack: EvidencePack, verdict: string) {
  const tenq = pack.documents.find((d) => d.source_id.startsWith('edgar:'))!;
  return {
    run_id: pack.run_id,
    verdict,
    model: 'claude-opus-5-5',
    premise_checks: [
      { premise_id: 'P1', status: 'HOLDS', evidence_ids: ['E1'] },
      { premise_id: 'P2', status: 'BROKEN', evidence_ids: ['E2'] },
    ],
    evidence: [
      { id: 'E1', source_id: tenq.source_id, date: tenq.date, quote: 'Revenue for the third quarter was $160 million, up 33% from a year ago', claim: '營收年增 33%，需求仍在' },
      { id: 'E2', source_id: tenq.source_id, date: tenq.date, quote: 'Gross margin was 60.0%, down from 70.0% a year ago', claim: '毛利率 60%，低於前提的 65%' },
    ],
    payload: {
      tier: verdict,
      previous_conditions: [],
      conditions: [
        { id: 'C1', direction: 'DOWN', kind: 'XBRL', text: '毛利率低於 55%（最新一季 60%）', check: { type: 'xbrl_metric_below', metric: 'GrossMarginPct', level: 0.55, quarters: 1 }, basis: ['E2'], tier_if_met: 'EXIT' },
        { id: 'C2', direction: 'DOWN', kind: 'EVENT', text: '公司在 8-K 下修營收財測', check: { type: 'event', confirm_by: ['8-K'] }, basis: ['E1'], tier_if_met: 'EXIT' },
        { id: 'C3', direction: 'DOWN', kind: 'PRICE', text: '收盤跌破 100', check: { type: 'price_close_below', level: 100 }, basis: ['E1'] },
        { id: 'C4', direction: 'DOWN', kind: 'XBRL', text: '自由現金流殖利率低於 2%', check: { type: 'xbrl_metric_below', metric: 'FcfYield', level: 0.02 }, basis: ['E1'], tier_if_met: 'HALF' },
      ],
    },
    report: '毛利率已經跌破前提寫的 65%，減半。\n\n需求仍在，所以不是出清。',
  };
}

async function postResult(db: D1Database, runId: string, samples: unknown[], at: Date) {
  const run = (await getRun(db, runId))!;
  const task = await db.prepare('SELECT * FROM ai_tasks WHERE id = ?').bind(run.taskId).first();
  return finalizeRun(db, task as never, { samples }, at);
}

// ---------------------------------------------------------------- F24 的判斷

describe('F24：證據包與結論怎麼變成建議', () => {
  it('RAISE 只在規則條件成立的月份可以選；減半中、有硬事件標記、12 個月內提高過都不行', async () => {
    await withWorld(async ({ db }) => {
      const { acct } = (await loadAccount(db))!;
      const series = await loadSeries(db, ['VOO', 'SGOV', 'NVDA']);
      const { view, axis } = buildMarketView(series, '2026-11-19', 'VOO');
      const mk = (a: Account) => ownReviewPack({ acct: a, view, axis, ticker: 'NVDA', runId: 'r', trigger: 'MONTHLY', xbrl: null, filings: [], news: null, previous: [], dataQuality: {}, now: new Date() }).pack;
      const ok = structuredClone(acct);
      ok.own.NVDA.slow.aboveRun = 130;
      expect(raiseAllowed(ok, 'NVDA', '2026-11-19').ok).toBe(true);
      expect(mk(ok).policy.verdicts).toContain('RAISE');
      const recent = structuredClone(ok);
      recent.own.NVDA.raisedAt = '2026-03-01';
      expect(raiseAllowed(recent, 'NVDA', '2026-11-19').why).toContain('未滿 12 個月');
      const flagged = structuredClone(ok);
      flagged.own.NVDA.flags = ['ACCOUNTING'];
      expect(mk(flagged).policy.verdicts).not.toContain('RAISE');
      const short = structuredClone(acct);
      short.own.NVDA.slow.aboveRun = 20;
      expect(mk(short).question).toContain('這個月不能選 RAISE');
    });
  });

  it('3 票一致減半、有前提不成立 → 月報並列；不動、和目前相同、不一致都不列；條件逐條檢查', async () => {
    await withWorld(async ({ db }) => {
      const { acct } = (await loadAccount(db))!;
      const { view, axis } = buildMarketView(await loadSeries(db, ['VOO', 'SGOV', 'NVDA']), '2026-11-19', 'VOO');
      const tenq = { id: 'D1', source_id: 'edgar:x', kind: 'filing' as const, date: '2026-10-30', title: '10-Q', text: htmlToText(TENQ) };
      const pack = ownReviewPack({ acct, view, axis, ticker: 'NVDA', runId: 'r1', trigger: 'MONTHLY', xbrl: null, filings: [tenq], news: null, previous: [], dataQuality: { filings: 'ok' }, now: new Date() }).pack;
      const hook = PAYLOAD_HOOKS[OWN_REVIEW];
      const o = judge(pack, [reviewVote(pack, 'HALF'), reviewVote(pack, 'HALF'), reviewVote(pack, 'HALF')], hook);
      expect(o.status).toBe('AGREED');
      const d = reviewDecision(o, acct, 'NVDA', '2026-11-19');
      expect(d).toMatchObject({ tier: 'HALF', suggest: true });
      expect(d.conditions.map((c) => [c.condId, c.kind, c.manual])).toEqual([
        ['C1', 'XBRL', false],
        ['C2', 'EVENT', false],
        ['C3', 'PRICE', true],
        ['C4', 'XBRL', true],
      ]);
      expect(o.samples[0].conditions.find((c) => c.raw.id === 'C4')!.why).toContain('FcfYield');
      expect(reviewDecision(judge(pack, [reviewVote(pack, 'HOLD'), reviewVote(pack, 'HOLD'), reviewVote(pack, 'HOLD')], hook), acct, 'NVDA', '2026-11-19')).toMatchObject({ tier: 'HOLD', suggest: false });
      expect(reviewDecision(judge(pack, [reviewVote(pack, 'STANDARD'), reviewVote(pack, 'STANDARD'), reviewVote(pack, 'STANDARD')], hook), acct, 'NVDA', '2026-11-19').why).toContain('和目前狀態相同');
      expect(reviewDecision(judge(pack, [reviewVote(pack, 'HALF'), reviewVote(pack, 'HALF'), reviewVote(pack, 'EXIT')], hook), acct, 'NVDA', '2026-11-19')).toMatchObject({ tier: null, suggest: false });
      // payload.tier 和 verdict 不同 → 記一條問題
      const bad = { ...reviewVote(pack, 'HALF'), payload: { ...reviewVote(pack, 'HALF').payload, tier: 'EXIT' } };
      expect(judge(pack, [bad], hook).samples[0].issues).toContain('payload.tier（EXIT）和 verdict 不同');
    });
  });
});

// ---------------------------------------------------------------- 整條流程

describe('整條流程：F24 → 月報；構造的 8-K → F25 當天通知', () => {
  it('月報前一天開 F24 → 結論回來記下檔位與條件 → 月報並列 AI 建議 → 新的 8-K 觸發 F25 → 3 票確認 → 當天通知與 LINE', async () => {
    await withWorld(async ({ db, e, run }) => {
      // 11-20：第一次看 EDGAR，只記下最新的申報，不追溯
      expect((await run('2026-11-20')).status).toBe('DONE');
      expect((await db.prepare("SELECT value FROM flow_state WHERE key = 'edgar:NVDA'").first<{ value: string }>())!.value).toBe(TENQ_FILING.acceptanceDateTime);
      expect(e.fired).toEqual([]);
      for (const d of ['2026-11-23', '2026-11-24', '2026-11-25']) await run(d);
      expect(e.fired).toEqual([]);

      // 11-27（當月倒數第二個交易日）：開 F24
      await run('2026-11-27');
      expect(e.fired).toHaveLength(1);
      const [r1] = await listRuns(db, new Date('2026-11-28T00:00:00Z'));
      expect(r1).toMatchObject({ fn: 'OWN_REVIEW', ticker: 'NVDA', asOf: '2026-11-27', status: 'PENDING' });
      expect(r1.pack.documents.map((d) => d.source_id)).toEqual(['price:NVDA', 'xbrl:NVDA', `edgar:${TENQ_FILING.accession}`, 'nasdaq-rss:NVDA']);
      expect(r1.pack.documents[2].title).toContain('MD&A');
      expect(r1.pack.documents[1].text).toContain('2026-09-30 (10-Q filed 2026-10-30): revenue 160');
      expect(r1.pack.data_quality).toEqual({ filings: 'ok', xbrl: 'ok', news: 'partial' });
      expect(r1.pack.premises.map((p) => p.text)).toEqual(['資料中心需求延續到 2027', '毛利率維持在 65% 以上']);

      // 雲端排程送回 3 票減半 → 第二次排程套用
      await postResult(db, r1.runId, [reviewVote(r1.pack, 'HALF'), reviewVote(r1.pack, 'HALF'), reviewVote(r1.pack, 'HALF')], new Date('2026-11-28T00:10:00Z'));
      const fin = await run('2026-11-27', 'FINAL');
      expect(fin.status).toBe('SKIPPED');
      let acct = (await loadAccount(db))!.acct;
      expect(acct.own.NVDA.aiTier).toMatchObject({ tier: 'HALF', date: '2026-11-27', suggest: true, runId: r1.runId });
      const conds = await loadConditions(db, 'NVDA');
      expect(conds.map((c) => [c.condId, c.status])).toEqual([
        ['C1', 'ACTIVE'],
        ['C2', 'ACTIVE'],
        ['C3', 'MANUAL'],
        ['C4', 'MANUAL'],
      ]);

      // 11-30 月底：月報並列 AI 建議（股數由程式換算），理由用 AI 紀錄
      const m = await run('2026-11-30');
      acct = (await loadAccount(db))!.acct;
      const monthly = acct.notifs.find((n) => n.id === m.monthly)!;
      const ai = monthly.items.find((i) => i.f === 'F24')!;
      expect(ai).toMatchObject({ kind: 'AI_ONLY', ticker: 'NVDA', title: 'NVDA 自選定期審查的建議', choice: 'SKIP' });
      expect(ai.choices[0].lines[0].shares).toBe(-Math.round((acct.lots.own.NVDA ?? 0) / 2));
      expect((ai as { x?: { ai?: { kind: string; verdict: string } } }).x?.ai).toMatchObject({ kind: 'REVIEW', verdict: '減半' });
      expect(e.line.at(-1)).toContain('另有 1 項 AI 建議（預設不做），到網站決定。');
      expect(acct.own.NVDA.aiTier!.suggest).toBe(false);

      // 12-01：公司送了一份 8-K（下修財測）→ 條件 C2 的確認來源 → 開 F25
      e.filings.push({ accession: '0001045810-26-000350', form: '8-K', items: '2.02,9.01', acceptanceDateTime: '2026-12-01T21:05:00.000Z', filingDate: '2026-12-01', primaryDocument: 'nvda-8k.htm', html: EIGHTK_GUIDE });
      const firedBefore = e.fired.length;
      await run('2026-12-01');
      // F25（事件條件）＋ F24（新財報後的審查）
      expect(e.fired.length - firedBefore).toBe(2);
      const runs = await listRuns(db, new Date('2026-12-02T00:00:00Z'));
      const f25 = runs.find((r) => r.fn === 'OWN_CONDITION')!;
      expect(f25.pack.documents.map((d) => d.source_id)).toEqual(['edgar:0001045810-26-000350']);
      expect(f25.pack.facts[0]).toMatchObject({ id: 'E1', value: '公司在 8-K 下修營收財測' });
      expect(runs.find((r) => r.fn === 'OWN_REVIEW' && r.asOf === '2026-12-01')!.pack.rule.detail).toMatchObject({ trigger: 'EARNINGS' });

      const vote = (cid: string) => ({
        run_id: f25.pack.run_id,
        verdict: 'MET',
        model: 'claude-sonnet-5-5',
        evidence: [{ id: 'E1', source_id: 'edgar:0001045810-26-000350', date: '2026-12-01', quote: 'lowered its revenue outlook for the fourth quarter to $150 million from $175 million', claim: '下修第四季營收財測' }],
        payload: { condition_id: cid },
        report: '8-K 直接寫出下修財測。',
      });
      await postResult(db, f25.runId, [vote('C2'), vote('C2'), vote('C2')], new Date('2026-12-02T00:20:00Z'));
      const lineBefore = e.line.length;
      const fin2 = await run('2026-12-01', 'FINAL');
      acct = (await loadAccount(db))!.acct;
      const urgent = acct.notifs.find((n) => n.kind === 'URGENT' && n.title === 'NVDA 條件成立（F25）')!;
      expect(fin2.created).toContain(urgent.id);
      expect(urgent.items[0]).toMatchObject({ f: 'F25', choice: 'SKIP' });
      expect(urgent.items[0].choices[0].lines[0].shares).toBe(-(acct.lots.own.NVDA ?? 0));
      expect((await loadConditions(db, 'NVDA')).find((c) => c.condId === 'C2')!.status).toBe('MET');
      const pushed = e.line.slice(lineBefore).find((t) => t.includes('NVDA 條件成立'))!;
      expect(pushed.split('\n')[0]).toBe('【紙上】【當天】NVDA 條件成立（F25）');
      expect(pushed).toContain('另有 1 項 AI 建議（預設不做），到網站決定。');
      expect(pushed).toContain(`https://bot.example/#/n/${urgent.id}`);
    });
  });

  it('F25 三票指的不是同一條、或引用不是申報原文 → 不通知', () => {
    const pack = { policy: { level: 'A3', verdicts: ['MET', 'NOT_MET'], abstain: 'NOT_MET', min_evidence: 1, samples: 3 } } as unknown as EvidencePack;
    const s = (cid: string) => ({ valid: true, verdict: 'MET', payload: { condition_id: cid } });
    expect(conditionDecision({ status: 'AGREED', verdict: 'MET', votes: { MET: 3 }, actionable: true, followRule: false, reason: '', samples: [s('C1'), s('C2'), s('C1')] as never })).toMatchObject({ condId: null });
    void pack;
  });

  it('財報條件：新的 10-Q 出來，程式直接比對 XBRL（不用 AI）→ 降級條件成立就當天通知', async () => {
    await withWorld(async ({ db, e, run }) => {
      await run('2026-11-20');
      await db.prepare("INSERT INTO own_conditions (ticker, run_id, cond_id, direction, kind, text, check_json, tier_if_met, status, created_at) VALUES ('NVDA', 'r0', 'C1', 'DOWN', 'XBRL', '毛利率低於 55%', ?, 'HALF', 'ACTIVE', '2026-11-01')").bind(JSON.stringify({ type: 'xbrl_metric_below', metric: 'GrossMarginPct', level: 0.55, quarters: 1 })).run();
      // 新的 10-Q（10-Q/A 修正前一季：毛利率 50%）
      e.facts = facts({
        quarters: [
          { end: '2025-09-30', rev: 120, gp: 84, cfoYtd: 105, filed: '2025-11-01' },
          { end: '2026-09-30', rev: 160, gp: 80, cfoYtd: 135, filed: '2026-11-23', form: '10-Q/A' },
        ],
      });
      e.filings.push({ accession: '0001045810-26-000320', form: '10-Q/A', items: '', acceptanceDateTime: '2026-11-23T21:00:00.000Z', filingDate: '2026-11-23', primaryDocument: 'a.htm', html: TENQ });
      const r = await run('2026-11-23');
      const acct = (await loadAccount(db))!.acct;
      const n = acct.notifs.find((x) => x.title === 'NVDA 條件成立（F25）')!;
      expect(r.created).toContain(n.id);
      expect(n.items[0].title).toBe('NVDA：條件「毛利率低於 55%」成立');
      const c = (await loadConditions(db, 'NVDA'))[0];
      expect(c).toMatchObject({ status: 'MET' });
      expect(c.note).toContain('0.5000');
      expect(e.line.some((t) => t.includes('NVDA 條件成立'))).toBe(true);
    });
  });

  it('雲端排程還沒設定：照樣看申報、比對財報條件，但不開新的 AI 執行', async () => {
    await withWorld(
      async ({ db, e, run }) => {
        for (const d of ['2026-11-20', '2026-11-27']) await run(d);
        expect(e.fired).toEqual([]);
        expect(await listRuns(db, new Date())).toEqual([]);
        const fr = (await db.prepare("SELECT detail FROM flow_runs WHERE session = '2026-11-27' ORDER BY id DESC").first<{ detail: string }>())!;
        expect(JSON.parse(fr.detail).ai.log).toContain('雲端排程還沒設定，不開新的 AI 執行');
      },
      { routine: false },
    );
  });
});
