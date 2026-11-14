// T11：其餘 AI 功能（F18 → F19 → F1 → F7／F8 → F14 → F5／F6 → F20 → F21 → F23）。
// 純函式的規則偵測與檢查用構造的資料測；整條流程用假的 EDGAR（依 CIK 分開的申報）、假的雲端排程、假的 LINE、假的 FRED。
import { describe, expect, it } from 'vitest';
import { judge, type EvidencePack } from '../src/ai/check';
import { checkCrashPayload, crashOpinionOf, macroDashboard } from '../src/ai/crash';
import { attribution, earningsDivergence, epsQuarters, jumpMetrics, oneOffJump, shareGrowth, sicToEtf, suspectMoves } from '../src/ai/detect';
import { dropDecision, explainLine } from '../src/ai/drops';
import { hardDecision, scanEvents } from '../src/ai/events';
import { PAYLOAD_HOOKS } from '../src/ai/hooks';
import { courtVerdict, entryRuleVerdict, previewOrder, resolveEntries, type EntryDecision } from '../src/ai/momEntry';
import { ownCheckResult } from '../src/ai/ownCheck';
import { ownReviewPack } from '../src/ai/ownReview';
import { checkStrategyPayload, drawdownEpisodes, historyTable, parseFrenchMonthly } from '../src/ai/strategy';
import { finalizeRun, getRun, listRuns } from '../src/app/aiRuns';
import type { ApplyCtx } from '../src/app/aiCtx';
import type { Env, Fetcher } from '../src/app/env';
import { loadEvents } from '../src/app/filings';
import { ingest, runFlow, type Attempt } from '../src/app/flow';
import { LINE_PUSH_URL } from '../src/app/line';
import { loadAccount, saveAccount } from '../src/app/ledgerStore';
import { loadReviews } from '../src/app/momAi';
import { applyOwnReview, loadConditions } from '../src/app/ownAi';
import { acceptOwnConditions, ownCheckView, startOwnCheck } from '../src/app/ownCheckAi';
import { loadSnapshot } from '../src/app/crashAi';
import { parseFredCsv } from '../src/data/fred';
import { buildMarketView } from '../src/data/marketView';
import { activeHits, classify401, classify424, classifyProxy, coverHits, quickHits, tenderSubject } from '../src/data/secEvents';
import type { Filing } from '../src/data/sources';
import { loadConstituents, loadRanking, loadSeries } from '../src/data/store';
import { createAccount, monthlyReport, refreshOwnAiChoice, recordAiTier, strategyReminder, type Account } from '../src/engine';
import { freshDb } from './helpers/d1';
import { cronTime, fakeFetcher, fakeParams, newWorld, type World } from './helpers/fakeSources';


// ---------------------------------------------------------------- 規則偵測：申報分類（B-9 的分類邏輯）

const filing = (o: Partial<Filing> & { form: string }): Filing => ({ accession: o.accession ?? '0000000000-26-000001', items: o.items ?? [], acceptedAt: o.acceptedAt ?? '2026-11-20T21:00:00.000Z', filingDate: o.filingDate ?? '2026-11-20', primaryDocument: o.primaryDocument ?? 'd.htm', form: o.form });

describe('F18 規則段：申報分類', () => {
  it('只看類型與 Item：NT 規則直接提出；4.02 要判斷重大性；SC 14D9 是被收購方；3.02 只顯示', () => {
    expect(quickHits(filing({ form: 'NT 10-Q' }))).toMatchObject([{ code: 'ACCOUNTING', sub: 'NT_10-Q', byRule: true }]);
    expect(quickHits(filing({ form: '8-K', items: ['4.02', '9.01'] }))).toMatchObject([{ code: 'ACCOUNTING', sub: '8K_4.02', byRule: false }]);
    expect(quickHits(filing({ form: 'SC 14D9' }))).toMatchObject([{ code: 'PENDING_MA', byRule: true }]);
    expect(quickHits(filing({ form: '8-K', items: ['3.02'] }))).toMatchObject([{ code: 'DILUTION', displayOnly: true }]);
    expect(quickHits(filing({ form: '8-K', items: ['2.02'] }))).toEqual([]);
  });

  it('4.01：會計師辭任才升級；公司解任、退休計畫只記錄', () => {
    expect(classify401('Item 4.01 Changes in Registrant’s Certifying Accountant. On May 1, 2026, Ernst & Young LLP resigned as the independent registered public accounting firm of the Company.').kind).toBe('RESIGN');
    expect(classify401('Item 4.01. The Audit Committee approved the dismissal of KPMG LLP. There were no disagreements with KPMG.')).toEqual({ kind: 'DISMISS', noDisagree: true });
    expect(classify401('Item 4.01 The Company dismissed Deloitte as the auditor of the Company’s 401(k) Savings Plan financial statements (Form 11-K).').kind).toBe('PLAN');
    const f = filing({ form: '8-K', items: ['4.01'] });
    expect(coverHits(f, 'Item 4.01 PwC resigned as auditor.', ['ACME CORP'])).toMatchObject([{ sub: '8K_4.01_RESIGN', byRule: false }]);
    expect(coverHits(f, 'Item 4.01 The Company dismissed PwC.', ['ACME CORP'])).toMatchObject([{ sub: '8K_4.01_DISMISS', displayOnly: true }]);
  });

  it('合併委託書：本公司是被收購方才算（收購方不算，B-9 的 14 次誤判）', () => {
    const target = 'PROXY STATEMENT. Dear Stockholders of Acme Corporation: On June 1, 2026, Acme Corporation entered into a merger agreement with BigCo. If the merger is completed, each share of Acme common stock will be converted into the right to receive $52.00 per share in cash.';
    expect(classifyProxy(target, ['ACME CORP'])).toEqual({ role: 'TARGET', offerPx: 52 });
    const acquirer = 'Dear Stockholders of BigCo Inc.: We are asking you to approve the issuance of shares of BigCo common stock to the stockholders of Acme in connection with the merger. Each share of Acme common stock will be converted into the right to receive 0.5 shares of BigCo common stock.';
    expect(classifyProxy(acquirer, ['BIGCO INC']).role).toBe('ACQUIRER');
    expect(tenderSubject('SCHEDULE TO Acme Corporation (Name of Subject Company (Issuer)) BigCo Merger Sub', ['ACME CORP'])).toMatchObject({ target: true });
    expect(tenderSubject('SCHEDULE TO Other Corp (Name of Subject Company (Issuer)) Acme Corporation (Offeror)', ['ACME CORP']).target).toBe(false);
  });

  it('424B：普通股、可轉債算增資（只顯示）；「不可轉換」的債券、出售股東不算', () => {
    expect(classify424('PROSPECTUS SUPPLEMENT (To Prospectus dated May 1, 2025) 10,000,000 Shares of Common Stock. We are offering 10,000,000 shares of our common stock.')).toMatchObject({ kind: 'EQUITY', shares: 10000000 });
    expect(classify424('PROSPECTUS SUPPLEMENT (To Prospectus dated May 1, 2025) $1,000,000,000 0.50% Convertible Senior Notes due 2031').kind).toBe('CONVERTIBLE');
    expect(classify424('PROSPECTUS SUPPLEMENT (To Prospectus dated May 1, 2025) $500,000,000 4.25% Senior Notes due 2034. The notes will not be convertible into common stock.').kind).toBe('DEBT');
    expect(classify424('PROSPECTUS SUPPLEMENT (To Prospectus dated May 1, 2025) 5,000,000 Shares of Common Stock offered by the selling stockholders. We will not receive any proceeds.').kind).toBe('EQUITY_SECONDARY');
  });

  it('有效期間：被收購 365 天、會計 180 天', () => {
    const hits = [
      { code: 'PENDING_MA', sub: 'SC_14D9', accession: 'a', form: 'SC 14D9', date: '2026-01-10', acceptedAt: '', byRule: true },
      { code: 'ACCOUNTING', sub: 'NT_10-Q', accession: 'b', form: 'NT 10-Q', date: '2026-04-01', acceptedAt: '', byRule: true },
      { code: 'ACCOUNTING', sub: 'NT_10-K', accession: 'c', form: 'NT 10-K', date: '2026-07-01', acceptedAt: '', byRule: true },
    ];
    expect(activeHits(hits, '2026-11-20').map((h) => h.accession)).toEqual(['a', 'c']);
  });
});

// ---------------------------------------------------------------- 規則偵測：價格與 XBRL

describe('F1 規則段：單日漲幅占比、盈餘背離、股數、資料可疑、跌幅拆解', () => {
  const series = (n: number, f: (k: number) => number) => Float64Array.from({ length: n }, (_, k) => f(k));

  it('單日跳漲占 12 個月漲幅 > 50% 而且之後 63 天沒有再相對上漲 → 命中；跳漲在最近 63 天內 → 還不能判斷', () => {
    const bench = series(300, () => 100);
    const jumpOld = series(300, (k) => (k < 100 ? 100 : 160) * (1 + 0.0002 * k));
    const m = jumpMetrics(jumpOld, bench, 299)!;
    expect(m.j1Share).toBeGreaterThan(0.5);
    expect(oneOffJump(m)!.hit).toBe(false); // 之後還在慢慢漲（相對 > 0）
    const flatAfter = series(300, (k) => (k < 100 ? 100 * (1 + 0.0005 * k) : 160 * (1 - 0.0003 * (k - 100))));
    expect(oneOffJump(jumpMetrics(flatAfter, bench, 299))!.hit).toBe(true);
    const recent = series(300, (k) => (k < 270 ? 100 : 170));
    const r = jumpMetrics(recent, bench, 299)!;
    expect(r.j1Post).toBeNull();
    expect(oneOffJump(r)!.hit).toBe(false);
    const smooth = series(300, (k) => 100 * Math.exp(0.002 * k));
    expect(oneOffJump(jumpMetrics(smooth, bench, 299))!.hit).toBe(false);
  });

  it('稀釋 EPS 取每期最早申報的值；第四季由全年推算；年增由正轉負而股價上漲 → 盈餘背離', () => {
    const q = (start: string, end: string, val: number, filed: string) => ({ start, end, val, filed, form: '10-Q' });
    const facts = [
      q('2025-01-01', '2025-03-31', 1.0, '2025-05-01'),
      q('2025-04-01', '2025-06-30', 1.1, '2025-08-01'),
      q('2025-07-01', '2025-09-30', 1.2, '2025-11-01'),
      { start: '2025-01-01', end: '2025-12-31', val: 4.6, filed: '2026-02-20', form: '10-K' },
      q('2026-01-01', '2026-03-31', 1.4, '2026-05-01'),
      q('2026-04-01', '2026-06-30', 1.3, '2026-08-01'),
      q('2026-07-01', '2026-09-30', 1.1, '2026-10-30'),
      // 重編（之後才申報）：看不到最早的值以外的
      q('2026-07-01', '2026-09-30', 0.9, '2026-12-15'),
    ];
    const qs = epsQuarters(facts, '2026-11-27');
    expect(qs.map((x) => [x.end, +x.eps.toFixed(2), x.derived])).toEqual([
      ['2026-09-30', 1.1, false],
      ['2026-06-30', 1.3, false],
      ['2026-03-31', 1.4, false],
      ['2025-12-31', 1.3, true],
      ['2025-09-30', 1.2, false],
      ['2025-06-30', 1.1, false],
      ['2025-03-31', 1.0, false],
    ]);
    expect(earningsDivergence(qs, 0.8)!.hit).toBe(true); // 年增 −0.1（前一季 +0.2）、連兩季下降
    expect(earningsDivergence(qs, -0.1)!.hit).toBe(false); // 股價沒漲就不算背離
  });

  it('股數 6 個月增加；日變動 > 25% 而前後沒有申報 → 資料可疑；跌幅拆解；SIC → 產業 ETF', () => {
    const sh = [
      { end: '2026-04-15', val: 1000, filed: '2026-05-01', form: '10-Q' },
      { end: '2026-10-15', val: 1080, filed: '2026-10-30', form: '10-Q' },
    ];
    expect(shareGrowth(sh, '2026-11-27')!.growth).toBeCloseTo(0.08);
    const axis = Array.from({ length: 10 }, (_, k) => `2026-11-${String(k + 10).padStart(2, '0')}`);
    const c = Float64Array.from([10, 10, 10, 14, 14, 14, 14, 9, 9, 9]);
    expect(suspectMoves(c, axis, 9, ['2026-11-17'])).toEqual(['2026-11-13（40%）']);
    const close = { X: Float64Array.from([100, 70]), VOO: Float64Array.from([100, 95]), XLK: Float64Array.from([100, 85]) };
    const a = attribution(['d0', 'd1'], close, 'X', 'VOO', 'XLK', 0, 1)!;
    expect([a.stock, a.market, a.sector, a.idio].map((x) => +x!.toFixed(2))).toEqual([-0.3, -0.05, -0.1, -0.15]);
    expect(sicToEtf('3674')).toBe('XLK');
    expect(sicToEtf('2834')).toBe('XLV');
    expect(sicToEtf('6022')).toBe('XLF');
    expect(sicToEtf(null)).toBeNull();
  });
});

// ---------------------------------------------------------------- F1：規則的結論、遞補、法庭

describe('F1：規則的結論、遞補、法庭的檢查', () => {
  it('規則直接否決（被收購方、NT）；資料可疑不進場；要法庭的開法庭；只有增資 → 准許但觀察；沒命中 → 准許', () => {
    expect(entryRuleVerdict([{ code: 'PENDING_MA', sub: 'SC_14D9', detail: 'x', byRule: true }])).toMatchObject({ decision: 'VETO', reasonCode: 'PENDING_MA' });
    expect(entryRuleVerdict([{ code: 'ACCOUNTING', sub: 'NT_10-K', detail: 'x', byRule: true }])).toMatchObject({ decision: 'VETO', reasonCode: 'ACCOUNTING' });
    expect(entryRuleVerdict([{ code: 'PENDING_MA', sub: 'DEFM14A_ACQUIRER', detail: 'x', byRule: true, displayOnly: true }]).decision).toBe('ALLOW');
    expect(entryRuleVerdict([{ code: 'DATA_SUSPECT', sub: 'x', detail: 'x', byRule: true }]).decision).toBe('BLOCK');
    expect(entryRuleVerdict([{ code: 'ACCOUNTING', sub: '8K_4.02', detail: 'x', byRule: false }, { code: 'DILUTION', sub: 'SHARES_6M', detail: '股數 +8%', byRule: true, displayOnly: true }])).toMatchObject({ decision: 'COURT', watchReason: '股數 +8%' });
    expect(entryRuleVerdict([{ code: 'DILUTION', sub: '424B5_EQUITY', detail: '發行普通股', byRule: true, displayOnly: true }])).toMatchObject({ decision: 'ALLOW_WATCH' });
    expect(entryRuleVerdict([]).decision).toBe('ALLOW');
  });

  it('被否決的由下一名遞補；遞補者再被否決，那一格留在核心（emptySlots）；還沒審的先回報要審', () => {
    const order = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
    const select = (vetoed: string[], empty: number) => order.filter((t) => !vetoed.includes(t)).slice(0, 2 - empty);
    const d = (o: Record<string, EntryDecision>) => new Map(Object.entries(o));
    expect(resolveEntries(select, d({}))).toEqual({ vetoed: [], emptySlots: 0, need: ['A', 'B'] });
    expect(resolveEntries(select, d({ A: 'VETO', B: 'ALLOW' }))).toEqual({ vetoed: ['A'], emptySlots: 0, need: ['C'] });
    expect(resolveEntries(select, d({ A: 'VETO', B: 'ALLOW', C: 'ALLOW' }))).toEqual({ vetoed: ['A'], emptySlots: 0, need: [] });
    // 遞補的 C 也被否決 → 那一格留在核心，不再往下找
    expect(resolveEntries(select, d({ A: 'VETO', B: 'ALLOW', C: 'VETO' }))).toEqual({ vetoed: ['A', 'C'], emptySlots: 1, need: [] });
    expect(resolveEntries(select, d({ A: 'PENDING', B: 'BLOCK', C: 'ALLOW' })).vetoed).toEqual(['B']);
    expect(previewOrder(select, (t) => t === 'B')).toEqual(['A', 'B', 'C']);
  });

  it('法庭：3 票一致否決（合法代碼、引用通過）才算；DILUTION 不能否決；票數不一致照規則准許；觀察要寫理由', () => {
    const pack = {
      run_id: 'r',
      function: 'MOM_ENTRY',
      as_of: '2026-11-27',
      policy: { level: 'A4', verdicts: ['ALLOW', 'ALLOW_WATCH', 'VETO', 'INSUFFICIENT'], abstain: 'INSUFFICIENT', min_evidence: 1, samples: 3 },
      premises: [],
      documents: [{ id: 'D1', source_id: 'edgar:x', kind: 'filing', date: '2026-11-05', title: '8-K', text: 'the financial statements for fiscal 2026 should no longer be relied upon' }],
      condition_types: [],
      data_quality: {},
      facts: [],
      rule: { action: '', detail: {} },
    } as unknown as EvidencePack;
    const v = (verdict: string, payload: Record<string, unknown>) => ({ verdict, evidence: [{ id: 'E1', source_id: 'edgar:x', date: '2026-11-05', quote: 'should no longer be relied upon', claim: '重編' }], payload });
    const hook = PAYLOAD_HOOKS.MOM_ENTRY;
    const veto = v('VETO', { decision: 'VETO', reason_code: 'ACCOUNTING', lift_condition: { type: 'filing_event', text: '重編完成的 10-K/A' } });
    expect(courtVerdict(judge(pack, [veto, veto, veto], hook))).toMatchObject({ decision: 'VETO', source: 'AI', reasonCode: 'ACCOUNTING' });
    const dil = v('VETO', { decision: 'VETO', reason_code: 'DILUTION' });
    const o = judge(pack, [dil, dil, dil], hook);
    expect(o.status).toBe('INSUFFICIENT');
    expect(courtVerdict(o)).toMatchObject({ decision: 'ALLOW', source: 'DEFAULT' });
    expect(courtVerdict(judge(pack, [veto, veto, v('ALLOW', { decision: 'ALLOW' })], hook))).toMatchObject({ decision: 'ALLOW', source: 'DEFAULT' });
    const watch = v('ALLOW_WATCH', { decision: 'ALLOW_WATCH', watch_reason: '重編還沒完成' });
    expect(courtVerdict(judge(pack, [watch, watch, watch], hook))).toMatchObject({ decision: 'ALLOW_WATCH', watchReason: '重編還沒完成' });
    const noWhy = v('ALLOW_WATCH', { decision: 'ALLOW_WATCH' });
    expect(judge(pack, [noWhy], hook).samples[0].verdict).toBe('ALLOW');
  });
});

// ---------------------------------------------------------------- F18／F19 的檢查

describe('F18／F19：payload 檢查與結論', () => {
  const base = { run_id: 'r', as_of: '2026-11-23', premises: [], condition_types: [], data_quality: {} };

  it('F19：EXIT 要是這次事件的代碼、至少一條引用申報原文（新聞標題不夠）；3 票一致才通知', () => {
    const pack = {
      ...base,
      function: 'HARD_EVENT',
      policy: { level: 'A3', verdicts: ['EXIT', 'HOLD', 'INSUFFICIENT'], abstain: 'INSUFFICIENT', min_evidence: 1, samples: 3 },
      rule: { action: '', detail: { codes: ['ACCOUNTING'] } },
      facts: [],
      documents: [
        { id: 'F', source_id: 'edgar:a', kind: 'filing', date: '2026-11-23', title: '8-K', text: 'revenue of $40 million was recognized prematurely' },
        { id: 'N', source_id: 'nasdaq-rss:X', kind: 'news', date: '2026-11-23', title: 'news', text: '2026-11-23 | Company restates results after audit review' },
      ],
    } as unknown as EvidencePack;
    const exitBy = (src: string, quote: string, code = 'ACCOUNTING') => ({ verdict: 'EXIT', evidence: [{ id: 'E1', source_id: src, date: '2026-11-23', quote, claim: 'x' }], payload: { reason_code: code, recommend_exit: true } });
    const ok = exitBy('edgar:a', 'revenue of $40 million was recognized prematurely');
    const hook = PAYLOAD_HOOKS.HARD_EVENT;
    expect(hardDecision(judge(pack, [ok, ok, ok], hook))).toMatchObject({ exit: true, code: 'ACCOUNTING' });
    const newsOnly = exitBy('nasdaq-rss:X', 'Company restates results after audit review');
    expect(judge(pack, [newsOnly], hook).samples[0].verdict).toBe('INSUFFICIENT');
    expect(judge(pack, [exitBy('edgar:a', 'revenue of $40 million was recognized prematurely', 'REGULATORY')], hook).samples[0].verdict).toBe('INSUFFICIENT');
    expect(hardDecision(judge(pack, [ok, ok, { ...ok, verdict: 'HOLD', payload: {} }], hook)).exit).toBe(false);
  });

  it('F18：代號、類別、來源要對得上；_CANDIDATE 要有引用；條件編號換成條件名', () => {
    const pack = {
      ...base,
      function: 'EVENT_SCAN',
      policy: { level: 'A1', verdicts: ['FLAGGED', 'NOTHING'], abstain: 'NOTHING', min_evidence: 0, samples: 1 },
      rule: { action: '', detail: { targets: [{ ticker: 'MU', role: 'OWN' }, { ticker: 'AAPL', role: 'MOM' }] } },
      facts: [{ id: 'K1', label: 'MU 的事件條件 C2', value: '合約價下跌' }],
      documents: [{ id: 'N1', source_id: 'nasdaq-rss:AAPL:2026-11-23', kind: 'news', date: '2026-11-23', title: 't', text: '2026-11-23 | Apple faces EU antitrust probe over App Store fees' }],
    } as unknown as EvidencePack;
    const vote = {
      verdict: 'FLAGGED',
      evidence: [{ id: 'E1', source_id: 'nasdaq-rss:AAPL:2026-11-23', date: '2026-11-23', quote: 'Apple faces EU antitrust probe', claim: '監管' }],
      payload: {
        events: [
          { ticker: 'AAPL', class: 'REGULATORY_CANDIDATE', source_id: 'nasdaq-rss:AAPL:2026-11-23' },
          { ticker: 'MU', class: 'GUIDANCE_CUT', source_id: 'nasdaq-rss:AAPL:2026-11-23', condition_ids: ['K1', 'K9'] },
          { ticker: 'TSLA', class: 'OTHER', source_id: 'nasdaq-rss:AAPL:2026-11-23' },
          { ticker: 'MU', class: 'ACCOUNTING_CANDIDATE', source_id: 'nasdaq-rss:XX' },
        ],
      },
    };
    const o = judge(pack, [vote], PAYLOAD_HOOKS.EVENT_SCAN);
    expect(scanEvents(o, pack)).toEqual([
      { ticker: 'AAPL', cls: 'REGULATORY_CANDIDATE', sourceId: 'nasdaq-rss:AAPL:2026-11-23', date: '2026-11-23', conditionIds: [] },
      { ticker: 'MU', cls: 'GUIDANCE_CUT', sourceId: 'nasdaq-rss:AAPL:2026-11-23', date: '2026-11-23', conditionIds: ['MU 的事件條件 C2'] },
    ]);
    expect(o.samples[0].issues.length).toBe(2);
  });
});

// ---------------------------------------------------------------- F7、F20、F5／F6、F21、F14 的純函式

describe('F7／F20／F5／F6／F21／F14：檢查與結論', () => {
  it('F7：3 票一致而且和規則（減半）不同才更新；轉交 F19 要寫代碼；F20 的一句話', () => {
    const pack = { run_id: 'r', function: 'OWN_DROP', as_of: '2026-11-23', policy: { level: 'A3', verdicts: ['EXIT', 'HALF', 'HOLD'], abstain: 'HALF', min_evidence: 1, samples: 3 }, premises: [], condition_types: [], data_quality: {}, facts: [], rule: { action: '', detail: {} }, documents: [{ id: 'P', source_id: 'price:MU', kind: 'price', date: '2026-11-23', title: 'p', text: '2026-11-23 MU close 70.00' }] } as unknown as EvidencePack;
    const v = (verdict: string, extra: Record<string, unknown> = {}) => ({ verdict, evidence: [{ id: 'E1', source_id: 'price:MU', date: '2026-11-23', quote: '2026-11-23 MU close 70.00', claim: 'x' }], payload: { tier: verdict, cause_class: 'MARKET', ...extra } });
    expect(dropDecision(judge(pack, [v('HOLD'), v('HOLD'), v('HOLD')], PAYLOAD_HOOKS.OWN_DROP))).toMatchObject({ tier: 'HOLD', cause: 'MARKET' });
    expect(dropDecision(judge(pack, [v('HALF'), v('HALF'), v('HALF')], PAYLOAD_HOOKS.OWN_DROP)).tier).toBeNull();
    const bad = judge(pack, [v('HOLD', { cause_class: 'VIBES', escalate_to_F19: true })], PAYLOAD_HOOKS.OWN_DROP);
    expect(bad.samples[0].payload).toMatchObject({ cause_class: 'UNKNOWN', escalate_to_F19: false });
    expect(explainLine('MU', -0.27, { samples: [{ valid: true, payload: { cause_class: 'SECTOR', summary: '記憶體類股一起跌。' } }] } as never)).toBe('MU 最近一個月跌 27%：產業一起跌。記憶體類股一起跌。（AI 說明，詳見網站）');
  });

  it('F5／F6：FRED CSV、儀表板（倒掛天數、年增、真空頭開始時的值）、意見只有 3 票一致才寫', () => {
    const s = parseFredCsv('T10Y3M', 'observation_date,T10Y3M\n2000-10-02,0.5\n2026-05-01,0.2\n2026-08-03,-0.1\n2026-11-02,-0.3\n2026-11-03,.\n2026-11-04,\n');
    expect(s.values).toEqual([0.5, 0.2, -0.1, -0.3]);
    const ind = parseFredCsv('INDPRO', 'DATE,INDPRO\n2025-10-01,100\n2026-10-01,103\n');
    const rows = macroDashboard(new Map([['T10Y3M', s], ['INDPRO', ind]]), '2026-11-20');
    const t = rows.find((r) => r.id === 'T10Y3M')!;
    expect(t).toMatchObject({ value: -0.3, date: '2026-11-02', derived: '倒掛 91 天（從 2026-08-03）' });
    expect(t.change6m).toBeCloseTo(-0.5);
    expect(t.atBears['2000-10']).toBeNull();
    expect(rows.find((r) => r.id === 'INDPRO')!.derived).toBe('年增 3.0%');
    expect(rows.find((r) => r.id === 'NFCI')!.note).toContain('抓不到');
    expect(crashOpinionOf({ status: 'AGREED', verdict: 'DELAY' } as never)).toBe('延後');
    expect(crashOpinionOf({ status: 'SPLIT', verdict: 'DELAY' } as never)).toBeNull();
    const pack = { rule: { detail: { direction: 'ON' } }, policy: { verdicts: ['FOLLOW', 'DELAY', 'INSUFFICIENT'] } } as unknown as EvidencePack;
    const smp = { rawVerdict: 'FOLLOW', verdict: 'FOLLOW', issues: [] as string[], payload: { bear_prob: 1.4, opinion: 'DELAY' } };
    checkCrashPayload(smp as never, pack);
    expect(smp.payload.bear_prob).toBeNull();
    expect(smp.issues).toHaveLength(2);
  });

  it('F21：French 動能因子的回撤事件；不得建議停用或繼續；每條前提都要有正反證據', () => {
    const rets = parseFrenchMonthly('header\n\n  ,Mom\n200001,  10.0\n200002, -20.0\n200003, -10.0\n200004,  50.0\n200005, -5.0\n\n Annual\n2000, 1.0\n');
    expect(rets.map((r) => r.month)).toEqual(['2000-01', '2000-02', '2000-03', '2000-04', '2000-05']);
    const eps = drawdownEpisodes(rets);
    expect(eps[0]).toMatchObject({ start: '2000-01', trough: '2000-03', recovered: '2000-04', months: 3 });
    expect(eps[0].depth).toBeCloseTo(-0.28);
    expect(historyTable(eps, -0.25).sameDepth).toHaveLength(1);
    const pack = { premises: [{ id: 'P1' }, { id: 'P2' }] } as unknown as EvidencePack;
    const s = { verdict: 'DONE', issues: [] as string[], report: '我建議停用這個策略。', payload: { premise_evidence: [{ premise: 'P1', for: ['E1'], against: [] }] } };
    checkStrategyPayload(s as never, pack);
    expect(s.verdict).toBe('INSUFFICIENT');
    expect(s.issues.join()).toContain('P2');
  });

  it('F14：草擬的前提最多 4 條；改寫的條件照 F24 的規則檢查', () => {
    const r = ownCheckResult(
      {
        status: 'AGREED',
        samples: [
          {
            valid: true,
            verdict: 'DONE',
            report: '改寫了一條。\n\n其他是理由。',
            payload: { premises_draft: [{ text: '資料中心需求延續', breaks_if: '營收年增轉負' }] },
            conditions: [
              { from: 'payload.conditions', auto: true, raw: { direction: 'DOWN', kind: 'XBRL', text: '毛利率低於 55%', check: { type: 'xbrl_metric_below', metric: 'GrossMarginPct', level: 0.55 }, tier_if_met: 'EXIT' } },
              { from: 'payload.conditions', auto: false, why: '價格條件只記錄', raw: { direction: 'DOWN', kind: 'PRICE', text: '跌破 100', check: { type: 'price_close_below', level: 100 } } },
            ],
          },
        ],
      } as never,
      'NVDA',
    );
    expect(r.drafts).toEqual([{ text: '資料中心需求延續', breaksIf: '營收年增轉負' }]);
    expect(r.conditions.map((c) => [c.condId, c.kind, c.manual, c.then])).toEqual([
      ['U1', 'XBRL', false, '成立時建議出清（當天通知）'],
      ['U2', 'PRICE', true, '只記錄：價格條件只記錄'],
    ]);
    expect(r.summary).toBe('改寫了一條。');
  });
});

// ---------------------------------------------------------------- 假的 EDGAR（依 CIK 分開）、雲端排程、LINE、FRED

interface FakeFiling {
  accession: string;
  form: string;
  items: string;
  acceptanceDateTime: string;
  filingDate: string;
  primaryDocument: string;
  html: string;
}
interface Sec {
  cos: Map<number, { name: string; filings: FakeFiling[] }>;
  fired: string[];
  line: string[];
  /** 某一天某一檔的新聞標題（沒有就不給）。 */
  headline: (ticker: string, date: string) => string | null;
}

function fetcherOf(w: World, sec: Sec): Fetcher {
  const base = fakeFetcher(w);
  const findFiling = (acc: string) => [...sec.cos.values()].flatMap((c) => c.filings).find((f) => f.accession.replace(/-/g, '') === acc);
  return async (url, init) => {
    if (url === LINE_PUSH_URL) {
      sec.line.push((JSON.parse(String(init?.body)) as { messages: { text: string }[] }).messages[0].text);
      return Response.json({});
    }
    if (url === 'https://api.example/fire') {
      sec.fired.push(String(init?.body));
      return Response.json({ claude_code_session_url: 'https://claude.ai/code/x' });
    }
    const sub = /data\.sec\.gov\/submissions\/CIK(\d+)\.json/.exec(url);
    if (sub) {
      const co = sec.cos.get(Number(sub[1])) ?? { name: 'SOME CORP', filings: [] };
      const fs = [...co.filings].reverse();
      return Response.json({ cik: sub[1], name: co.name, tickers: [], sic: '3674', formerNames: [], filings: { recent: { accessionNumber: fs.map((f) => f.accession), form: fs.map((f) => f.form), items: fs.map((f) => f.items), acceptanceDateTime: fs.map((f) => f.acceptanceDateTime), filingDate: fs.map((f) => f.filingDate), primaryDocument: fs.map((f) => f.primaryDocument) } } });
    }
    if (/companyfacts\/CIK\d+\.json/.test(url)) {
      // 每一家都給同一組季營收（重大性的數字從這裡取；沒有的話資料缺漏，AI 不能升級給人）
      const q = (start: string, end: string, val: number, filed: string) => ({ start, end, val, filed, form: '10-Q', accn: `a-${filed}` });
      return Response.json({ cik: 1, facts: { 'us-gaap': { Revenues: { units: { USD: [q('2025-07-01', '2025-09-30', 900, '2025-10-30'), q('2026-01-01', '2026-03-31', 1000, '2026-04-30'), q('2026-04-01', '2026-06-30', 1100, '2026-07-30'), q('2026-07-01', '2026-09-30', 1200, '2026-10-30')] } } } } });
    }
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
      const t = decodeURIComponent(rss[1]);
      const title = sec.headline(t, w.dataDate);
      return new Response(`<rss><channel>${title ? `<item><title>${title}</title><link>https://n/${t}</link><pubDate>${new Date(w.dataDate + 'T20:00:00Z').toUTCString()}</pubDate></item>` : ''}</channel></rss>`);
    }
    if (url.startsWith('https://fred.stlouisfed.org/graph/fredgraph.csv')) return new Response('observation_date,X\n2000-10-02,1.0\n2026-05-01,1.2\n2026-11-02,1.5\n');
    if (url.startsWith('https://mba.tuck.dartmouth.edu/')) return new Response('nf', { status: 404 });
    return base(url, init);
  };
}

interface Ctx {
  db: D1Database;
  w: World;
  sec: Sec;
  env: Env;
  fetcher: Fetcher;
  cik: (t: string) => number;
  run: (date: string, attempt?: Attempt) => ReturnType<typeof runFlow>;
}

async function withWorld(fn: (c: Ctx) => Promise<void>, opt: { mom?: string[]; crash?: boolean; acct?: (a: Account) => Account; before?: (c: Omit<Ctx, 'run'>) => Promise<void> } = {}) {
  const d = await freshDb();
  try {
    const db = d.db;
    const w = newWorld('2026-11-19');
    const sec: Sec = { cos: new Map(), fired: [], line: [], headline: () => null };
    const env: Env = { DB: db, ADMIN_TOKEN: 't', AI_TASK_SECRET: 's', EDGAR_USER_AGENT: 'test bot test@example.com', SITE_URL: 'https://bot.example', LINE_CHANNEL_TOKEN: 'lt', LINE_USER_ID: 'U1', ROUTINE_FIRE_URL: 'https://api.example/fire', ROUTINE_TOKEN: 'rt' };
    const fetcher = fetcherOf(w, sec);
    const run = (date: string, attempt: Attempt = 'FIRST') => {
      w.dataDate = date;
      return runFlow(env, fetcher, { now: attempt === 'FINAL' ? new Date(Date.parse(date + 'T23:30:00Z') + 2 * 3600_000) : cronTime(date), attempt });
    };
    await run('2026-11-19');
    const members = (await loadConstituents(db))!;
    const cik = (t: string) => Number(members.holdings.find((h) => h[0] === t)![2]);
    if (opt.before) await opt.before({ db, w, sec, env, fetcher, cik });
    const tickers = ['VOO', 'SGOV', 'NVDA', ...(opt.mom ?? [])];
    const { view } = buildMarketView(await loadSeries(db, tickers), '2026-11-19', 'VOO');
    let acct = createAccount(
      {
        paper: true,
        cash: 5000,
        crash: opt.crash ?? false,
        core: { VOO: Math.floor(140_000 / view.close.VOO[view.i]) },
        mom: Object.fromEntries((opt.mom ?? []).map((t) => [t, Math.floor(8000 / view.close[t][view.i])])),
        own: { NVDA: { shares: Math.floor(40_000 / view.close.NVDA[view.i]), stdWeight: 0.15, premises: [{ id: 'P1', text: '資料中心需求延續到 2027', origin: 'USER' }] } },
      },
      view,
    );
    if (opt.acct) acct = opt.acct(acct);
    await saveAccount(db, acct, null, '建立帳戶', new Date('2026-11-19T12:00:00Z'));
    await fn({ db, w, sec, env, fetcher, cik, run });
  } finally {
    await d.dispose();
  }
}

const runsOf = async (db: D1Database, fn: string) => (await listRuns(db, new Date('2026-11-01T00:00:00Z'), { limit: 500 })).filter((r) => r.fn === fn);

async function postResult(db: D1Database, runId: string, samples: unknown[], at: Date) {
  const run = (await getRun(db, runId))!;
  const task = await db.prepare('SELECT * FROM ai_tasks WHERE id = ?').bind(run.taskId).first();
  return finalizeRun(db, task as never, { samples }, at);
}

const addFiling = (sec: Sec, cik: number, f: FakeFiling, name = 'SOME CORP') => {
  const co = sec.cos.get(cik) ?? { name, filings: [] };
  co.filings.push(f);
  sec.cos.set(cik, co);
};

const EIGHTK_402 = '<html><body><p>Item 4.02 Non-Reliance on Previously Issued Financial Statements.</p><p>On November 23, 2026, the Audit Committee concluded that the previously issued financial statements for fiscal 2026 should no longer be relied upon because revenue of $40 million was recognized prematurely.</p></body></html>';

// ---------------------------------------------------------------- 整條流程

describe('整條流程：F18 → F19', () => {
  it('動能持股的 NT 10-Q 規則直接提出；自選的 8-K 4.02 開法庭 → 3 票建議出場 → 當天通知；每日掃描標記 → 隔天開法庭', async () => {
    await withWorld(
      async ({ db, sec, cik, run }) => {
        // 之前就有的申報（第一次看只記下最新的一筆，不追溯）
        addFiling(sec, cik('AAPL'), { accession: '0000320193-26-000100', form: '10-Q', items: '', acceptanceDateTime: '2026-10-30T20:00:00.000Z', filingDate: '2026-10-30', primaryDocument: 'q.htm', html: '<p>10-Q</p>' }, 'APPLE INC');
        addFiling(sec, cik('NVDA'), { accession: '0001045810-26-000300', form: '10-Q', items: '', acceptanceDateTime: '2026-10-30T20:10:00.000Z', filingDate: '2026-10-30', primaryDocument: 'q.htm', html: '<p>10-Q</p>' }, 'NVIDIA CORP');
        await run('2026-11-20');
        addFiling(sec, cik('AAPL'), { accession: '0000320193-26-000200', form: 'NT 10-Q', items: '', acceptanceDateTime: '2026-11-23T21:00:00.000Z', filingDate: '2026-11-23', primaryDocument: 'nt.htm', html: '<p>NT 10-Q</p>' }, 'APPLE INC');
        addFiling(sec, cik('NVDA'), { accession: '0001045810-26-000400', form: '8-K', items: '4.02,9.01', acceptanceDateTime: '2026-11-23T21:05:00.000Z', filingDate: '2026-11-23', primaryDocument: 'nvda-402.htm', html: EIGHTK_402 }, 'NVIDIA CORP');
        sec.headline = (t, d) => (t === 'AAPL' && d === '2026-11-23' ? 'Apple faces EU antitrust probe over App Store fees' : null);
        await run('2026-11-23');

        let acct = (await loadAccount(db))!.acct;
        const nt = acct.notifs.find((n) => n.title === 'AAPL 硬事件（ACCOUNTING）')!;
        expect(nt.kind).toBe('URGENT');
        expect(nt.items[0]).toMatchObject({ f: 'F19', kind: 'HARD', choice: 'DO' });
        expect(nt.items[0].choices[0].lines[0]).toMatchObject({ ticker: 'AAPL', bucket: 'mom' });
        expect(acct.rule.heldMom).not.toContain('AAPL');
        expect(acct.notifs.filter((n) => n.id === nt.id)).toHaveLength(1); // 同一則通知只出現一次（T10 的 push 兩次已修）
        const evs = await loadEvents(db);
        expect(evs.map((e) => [e.ticker, e.sub, e.status])).toEqual(expect.arrayContaining([['AAPL', 'NT_10-Q', 'HANDLED'], ['NVDA', '8K_4.02', 'HANDLED']]));

        const [court] = await runsOf(db, 'HARD_EVENT');
        expect(court).toMatchObject({ ticker: 'NVDA', status: 'PENDING' });
        expect(court.pack.rule.detail).toMatchObject({ codes: ['ACCOUNTING'], role: 'OWN' });
        expect(court.pack.premises.map((p) => p.id)).toEqual(['P1', 'PX']);
        const doc = court.pack.documents.find((x) => x.source_id === 'edgar:0001045810-26-000400')!;
        expect(doc.text).toContain('should no longer be relied upon');
        const [scan] = await runsOf(db, 'EVENT_SCAN');
        expect(scan.pack.documents.map((x) => x.source_id)).toEqual(['nasdaq-rss:AAPL:2026-11-23']);
        expect(scan.pack.policy).toMatchObject({ samples: 1, level: 'A1' });

        const exit = { run_id: court.pack.run_id, verdict: 'EXIT', model: 'claude-opus-5-5', premise_checks: [{ premise_id: 'PX', status: 'BROKEN', evidence_ids: ['E1'] }], evidence: [{ id: 'E1', source_id: doc.source_id, date: doc.date, quote: 'the previously issued financial statements for fiscal 2026 should no longer be relied upon', claim: '財報重編' }], payload: { reason_code: 'ACCOUNTING', recommend_exit: true }, report: '財報不可信，建議出場。' };
        await postResult(db, court.runId, [exit, exit, exit], new Date('2026-11-24T00:10:00Z'));
        const flag = { run_id: scan.pack.run_id, verdict: 'FLAGGED', evidence: [{ id: 'E1', source_id: 'nasdaq-rss:AAPL:2026-11-23', date: '2026-11-23', quote: 'Apple faces EU antitrust probe', claim: '反壟斷調查' }], payload: { events: [{ ticker: 'AAPL', class: 'REGULATORY_CANDIDATE', source_id: 'nasdaq-rss:AAPL:2026-11-23' }] } };
        await postResult(db, scan.runId, [flag], new Date('2026-11-24T00:12:00Z'));
        const lineBefore = sec.line.length;
        const fin = await run('2026-11-23', 'FINAL');
        acct = (await loadAccount(db))!.acct;
        const hard = acct.notifs.find((n) => n.title === 'NVDA 硬事件（ACCOUNTING）')!;
        expect(fin.created).toContain(hard.id);
        expect(hard.items[0]).toMatchObject({ kind: 'HARD', choice: 'SKIP' });
        expect(hard.items[0].choices[0]).toMatchObject({ id: 'AI', tier: 'EXIT' });
        expect(acct.own.NVDA.flags).toEqual(['ACCOUNTING']);
        expect(sec.line.slice(lineBefore).find((t) => t.includes('NVDA 硬事件'))).toContain('另有 1 項 AI 建議（預設不做）');
        expect((await loadEvents(db, { ticker: 'AAPL', status: 'NEW' })).map((e) => e.sub)).toEqual(['SCAN_REGULATORY_CANDIDATE']);

        // 隔天：每日掃描標記的監管候選 → 動能持股（還沒賣）開法庭
        await run('2026-11-24');
        const courts = await runsOf(db, 'HARD_EVENT');
        const aapl = courts.find((r) => r.ticker === 'AAPL')!;
        expect(aapl.pack.rule.detail).toMatchObject({ codes: ['REGULATORY'], role: 'MOM' });
        expect(aapl.pack.premises.map((p) => p.id)).toEqual(['P2', 'P4']);
      },
      { mom: ['AAPL'] },
    );
  });
});

describe('整條流程：F1 否決法庭', () => {
  it('月報前一天：被收購方規則否決、4.02 開法庭並先審遞補者 → 3 票否決 → 月報由下一名遞補、記下遞補', async () => {
    let order: string[] = [];
    await withWorld(
      async ({ db, run }) => {
        const [a, b] = order;
        for (const d of ['2026-11-20', '2026-11-23', '2026-11-24', '2026-11-25']) await run(d);
        await run('2026-11-27');
        let rev = new Map((await loadReviews(db, '2026-12')).map((r) => [r.ticker, r]));
        expect(rev.get(a)).toMatchObject({ decision: 'VETO', reasonCode: 'PENDING_MA', source: 'RULE' });
        expect(rev.get(b)).toMatchObject({ decision: 'PENDING', source: 'RULE' });
        // 前 5 名都審了；A、B 有風險 → 遞補者也先審
        expect(rev.size).toBe(7);
        const [court] = await runsOf(db, 'MOM_ENTRY');
        expect(court).toMatchObject({ ticker: b, status: 'PENDING' });
        expect(court.pack.policy).toMatchObject({ level: 'A4', samples: 3, abstain: 'INSUFFICIENT' });
        const doc = court.pack.documents.find((x) => x.kind === 'filing')!;
        expect(doc.text).toContain('should no longer be relied upon');
        expect(await runsOf(db, 'MOM_SCORE')).toHaveLength(1);

        const veto = { run_id: court.pack.run_id, verdict: 'VETO', premise_checks: [{ premise_id: 'P2', status: 'BROKEN', evidence_ids: ['E1'] }], evidence: [{ id: 'E1', source_id: doc.source_id, date: doc.date, quote: 'revenue of $40 million was recognized prematurely', claim: '營收提前認列' }], payload: { decision: 'VETO', reason_code: 'ACCOUNTING', lift_condition: { type: 'filing_event', text: '重編完成' } }, report: '財報不可信。' };
        await postResult(db, court.runId, [veto, veto, veto], new Date('2026-11-28T00:10:00Z'));
        await run('2026-11-27', 'FINAL');
        rev = new Map((await loadReviews(db, '2026-12')).map((r) => [r.ticker, r]));
        expect(rev.get(b)).toMatchObject({ decision: 'VETO', reasonCode: 'ACCOUNTING', source: 'AI' });

        const m = await run('2026-11-30');
        const acct = (await loadAccount(db))!.acct;
        const monthly = acct.notifs.find((n) => n.id === m.monthly)!;
        expect(monthly.monthly!.input.vetoed).toEqual([a, b]);
        const entries = monthly.items.filter((i) => i.f === 'F1').map((i) => i.ticker);
        expect(entries).toHaveLength(5);
        expect(entries).not.toContain(a);
        expect(entries).not.toContain(b);
        rev = new Map((await loadReviews(db, '2026-12')).map((r) => [r.ticker, r]));
        expect(entries).toContain(rev.get(a)!.replacedBy);
        expect(entries).toContain(rev.get(b)!.replacedBy);
      },
      {
        before: async ({ db, sec, env, fetcher, cik }) => {
          // 先排一次名（假價格是平滑的指數，11-27 的順序和現在相同）
          await ingest(env, fetcher, cronTime('2026-11-19'), true);
          order = (await loadRanking(db))!.order;
          addFiling(sec, cik(order[0]), { accession: '0000000001-26-000010', form: 'SC 14D9', items: '', acceptanceDateTime: '2026-11-10T21:00:00.000Z', filingDate: '2026-11-10', primaryDocument: 'sc14d9.htm', html: '<p>Solicitation/Recommendation Statement</p>' });
          addFiling(sec, cik(order[1]), { accession: '0000000002-26-000020', form: '8-K', items: '4.02', acceptanceDateTime: '2026-11-05T21:00:00.000Z', filingDate: '2026-11-05', primaryDocument: 'k402.htm', html: EIGHTK_402 });
        },
      },
    );
  });
});

describe('整條流程：F5／F6 崩盤規則檢視', () => {
  it('月報前一天預估會切換 → 3 票檢視＋儀表板 → 月報那一項與 LINE 附「AI 檢視：照做」', async () => {
    const up = fakeParams('VOO').g > 0;
    await withWorld(
      async ({ db, sec, run }) => {
        for (const d of ['2026-11-20', '2026-11-23', '2026-11-24', '2026-11-25', '2026-11-27']) await run(d);
        const [cr] = await runsOf(db, 'CRASH_REVIEW');
        expect(cr.pack.rule.detail).toMatchObject({ direction: up ? 'OFF' : 'ON', month: '2026-12' });
        expect(cr.pack.policy).toMatchObject({ level: 'A2', samples: 3 });
        expect(cr.pack.documents.map((x) => x.source_id)).toEqual(['base-rate:crash', 'macro:2026-11-27']);
        const snap = (await loadSnapshot(db, '2026-12'))!;
        expect(snap.rows.find((r) => r.id === 'T10Y3M')).toMatchObject({ value: 1.5, date: '2026-11-02' });
        const v = { run_id: cr.pack.run_id, verdict: 'FOLLOW', evidence: [], payload: { direction: up ? 'OFF' : 'ON', opinion: 'FOLLOW', bear_prob: 0.2 }, report: '過去 17 次中 3 次是真空頭。' };
        await postResult(db, cr.runId, [v, v, v], new Date('2026-11-28T00:10:00Z'));
        await run('2026-11-27', 'FINAL');
        const m = await run('2026-11-30');
        const acct = (await loadAccount(db))!.acct;
        const it = acct.notifs.find((n) => n.id === m.monthly)!.items.find((i) => i.f === (up ? 'F6' : 'F5'))!;
        expect(it.aiLine).toBe('AI 檢視：照做');
        expect(sec.line.find((t) => t.includes('月報'))).toContain('AI 檢視：照做');
      },
      { crash: up },
    );
  });
});

describe('整條流程：F7 減半檢視、F20 大跌說明', () => {
  it('自選暴跌 → 當天減半通知；F7 三票「不動」回來 → 還沒回覆的通知更新 AI 建議；F20 的說明附在月報', async () => {
    await withWorld(async ({ db, w, run }) => {
      await run('2026-11-20');
      w.shock.NVDA = { from: '2026-11-23', factor: 0.7 };
      await run('2026-11-23');
      let acct = (await loadAccount(db))!.acct;
      const urgent = acct.notifs.find((n) => n.kind === 'URGENT' && n.items.some((i) => i.f === 'F7'))!;
      const [drop] = await runsOf(db, 'OWN_DROP');
      expect(drop).toMatchObject({ ticker: 'NVDA', status: 'PENDING' });
      expect(drop.pack.rule.detail).toMatchObject({ urgent: true });
      expect(drop.pack.facts.find((f) => f.id === 'A2')!.value).toMatch(/^-/);
      const [expl] = await runsOf(db, 'DROP_EXPLAIN');
      expect(expl.ticker).toBe('NVDA');
      const price = drop.pack.documents.find((d) => d.source_id === 'price:NVDA')!;
      const quote = price.text.split('\n').at(-1)!;
      const hold = { run_id: drop.pack.run_id, verdict: 'HOLD', premise_checks: [{ premise_id: 'P1', status: 'HOLDS', evidence_ids: ['E1'] }], evidence: [{ id: 'E1', source_id: 'price:NVDA', date: price.date, quote, claim: '一天跌 30%，沒有申報' }], payload: { tier: 'HOLD', cause_class: 'ONE_OFF' }, report: '一次性下跌。' };
      await postResult(db, drop.runId, [hold, hold, hold], new Date('2026-11-24T00:10:00Z'));
      await postResult(db, expl.runId, [{ run_id: expl.pack.run_id, verdict: 'EXPLAINED', evidence: [], payload: { cause_class: 'ONE_OFF', summary: '一天跌了三成，沒有相關申報。' } }], new Date('2026-11-24T00:11:00Z'));
      await run('2026-11-23', 'FINAL');
      acct = (await loadAccount(db))!.acct;
      const it = acct.notifs.find((n) => n.id === urgent.id)!.items.find((i) => i.f === 'F7')!;
      expect(it.choices.map((c) => c.id)).toEqual(['RULE', 'AI', 'SKIP']);
      expect(it.choices[1]).toMatchObject({ tier: 'HOLD', lines: [] });
      expect(it.aiLine).toContain('不動');
      expect(acct.own.NVDA.aiTier).toMatchObject({ tier: 'HOLD', suggest: false });
      for (const d of ['2026-11-24', '2026-11-25', '2026-11-27']) await run(d);
      const m = await run('2026-11-30');
      const monthly = (await loadAccount(db))!.acct.notifs.find((n) => n.id === m.monthly)!;
      expect(monthly.text).toContain('NVDA 最近一個月跌');
      expect(monthly.text).toContain('一天跌了三成');
    });
  });
});

describe('整條流程：F21 策略檢討', () => {
  it('動能名單落後基準超過 20% → 不附清單的提醒＋AI 說明（French 資料抓不到時照樣開，標資料缺漏）', async () => {
    const voo = fakeParams('VOO').g;
    const laggard = ['AAPL', 'MSFT', 'AMZN', 'META', 'JPM', 'XOM', 'WMT', 'KO', 'PG', 'JNJ'].find((t) => fakeParams(t).g < voo - 1e-5)!;
    await withWorld(
      async ({ db, run }) => {
        await db.prepare("INSERT INTO flow_state (key, value, updated_at) VALUES ('strategyReview', ?, 'x')").bind(JSON.stringify({ rel: 0.800001, peak: 1, eventStart: null, notified: [], yearsNotified: 0 })).run();
        const r = await run('2026-11-20');
        const acct = (await loadAccount(db))!.acct;
        const n = acct.notifs.find((x) => x.title === '策略檢討提醒')!;
        expect(r.created).toContain(n.id);
        expect(n).toMatchObject({ kind: 'INFO', items: [] });
        expect(n.text).toContain('落後超過 20%');
        const [sr] = await runsOf(db, 'STRATEGY_REVIEW');
        expect(sr.pack.premises.map((p) => p.id)).toEqual(['P1', 'P2', 'P3']);
        expect(sr.pack.data_quality).toEqual({ history: 'missing' });
        const st = JSON.parse((await db.prepare("SELECT value FROM flow_state WHERE key = 'strategyReview'").first<{ value: string }>())!.value);
        expect(st.notified).toEqual([-0.2]);
      },
      { mom: [laggard] },
    );
  });
});

describe('F14：新增自選健檢 → 確認出場條件 → 之後的 F24 不會換掉使用者的條件', () => {
  it('改寫出場條件 → 勾選開始監測（origin USER）→ F24 整組替換時只換 AI 寫的', async () => {
    await withWorld(async ({ db, env, fetcher, run }) => {
      await run('2026-11-20');
      const loaded = (await loadAccount(db))!;
      const { view, axis } = buildMarketView(await loadSeries(db, ['VOO', 'SGOV', 'NVDA']), '2026-11-20', 'VOO');
      const now = new Date('2026-11-21T01:00:00Z');
      const r = await startOwnCheck(env, fetcher, loaded.acct, view, axis, 'NVDA', ['資料中心需求延續', '收盤跌破 100 就賣'], now);
      expect(r.pack.rule.detail).toMatchObject({ mode: 'REWRITE', lines: ['資料中心需求延續', '收盤跌破 100 就賣'] });
      const price = r.pack.documents.find((d) => d.source_id === 'price:NVDA')!;
      const quote = price.text.split('\n').at(-1)!;
      await postResult(
        db,
        r.runId,
        [
          {
            run_id: r.pack.run_id,
            verdict: 'DONE',
            evidence: [{ id: 'E1', source_id: 'price:NVDA', date: price.date, quote, claim: '最新收盤' }],
            payload: {
              conditions: [
                { id: 'C1', direction: 'DOWN', kind: 'EVENT', text: '公司在 8-K 下修營收財測', check: { type: 'event', confirm_by: ['8-K'] }, basis: ['E1'], tier_if_met: 'EXIT' },
                { id: 'C2', direction: 'DOWN', kind: 'PRICE', text: '收盤跌破 100', check: { type: 'price_close_below', level: 100 }, basis: ['E1'], tier_if_met: 'EXIT' },
              ],
            },
            report: '把「跌破 100 就賣」改寫成價格條件（只記錄）。',
          },
        ],
        new Date('2026-11-21T01:10:00Z'),
      );
      const v = (await ownCheckView(env, r.runId, now))!;
      expect(v.conditions.map((c) => [c.condId, c.kind, c.manual])).toEqual([
        ['U1', 'EVENT', false],
        ['U2', 'PRICE', true],
      ]);
      expect(await acceptOwnConditions(env, 'NVDA', r.runId, ['U1', 'U2'], now)).toBe(2);
      expect(await acceptOwnConditions(env, 'NVDA', r.runId, ['U1'], now)).toBe(0); // 不重複寫
      // 之後一次 F24（3 票減半）整組替換：使用者的兩條留著
      await db.prepare("INSERT INTO own_conditions (ticker, run_id, cond_id, direction, kind, text, check_json, tier_if_met, status, created_at) VALUES ('NVDA', 'old', 'C9', 'DOWN', 'XBRL', '舊的 AI 條件', '{}', 'HALF', 'ACTIVE', 'x')").run();
      const tenq = { id: 'D1', source_id: 'edgar:x', kind: 'filing' as const, date: '2026-10-30', title: '10-Q', text: 'Gross margin was 60.0%, down from 70.0% a year ago' };
      const pack = ownReviewPack({ acct: loaded.acct, view, axis, ticker: 'NVDA', runId: 'rev1', trigger: 'MONTHLY', xbrl: null, filings: [tenq], news: null, previous: [], dataQuality: { filings: 'ok' }, now }).pack;
      const vote = { verdict: 'HALF', premise_checks: [{ premise_id: 'P1', status: 'BROKEN', evidence_ids: ['E1'] }], evidence: [{ id: 'E1', source_id: 'edgar:x', date: '2026-10-30', quote: 'Gross margin was 60.0%, down from 70.0% a year ago', claim: '毛利率下滑' }], payload: { tier: 'HALF', conditions: [{ id: 'C1', direction: 'DOWN', kind: 'XBRL', text: '毛利率低於 55%', check: { type: 'xbrl_metric_below', metric: 'GrossMarginPct', level: 0.55 }, basis: ['E1'], tier_if_met: 'EXIT' }] } };
      const outcome = judge(pack, [vote, vote, vote], PAYLOAD_HOOKS.OWN_REVIEW);
      const ctx: ApplyCtx = { db, acct: loaded.acct, view, axis, session: '2026-11-20', now, stmts: [], log: [] };
      await applyOwnReview(ctx, { runId: 'rev1', fn: 'OWN_REVIEW', ticker: 'NVDA', asOf: '2026-11-20', outcome, pack } as never);
      await db.batch(ctx.stmts);
      const conds = await loadConditions(db, 'NVDA');
      expect(conds.map((c) => [c.condId, c.origin, c.status])).toEqual([
        ['U1', 'USER', 'ACTIVE'],
        ['U2', 'USER', 'MANUAL'],
        ['C1', 'AI', 'ACTIVE'],
      ]);
    });
  });
});

// ---------------------------------------------------------------- 引擎：F8 註明、F7 事後更新、F19 規則提出的自選、月報的觀察理由與說明、F21 提醒、F23

describe('引擎的 T11 部分', () => {
  async function base(fn: (a: Account, view: ReturnType<typeof buildMarketView>['view']) => void) {
    await withWorld(async ({ db }) => {
      const { acct } = (await loadAccount(db))!;
      const { view } = buildMarketView(await loadSeries(db, ['VOO', 'SGOV', 'NVDA', 'AAPL']), '2026-11-19', 'VOO');
      fn(acct, view);
    });
  }

  it('F7 的 AI 檢視晚回來：還沒回覆的減半項目照新的檔位重算「照 AI」；已回覆的不動', async () => {
    await base((acct, view) => {
      const a = structuredClone(acct);
      const n = { id: 99, kind: 'URGENT', date: view.date, seq: view.i, title: 'x', status: 'PENDING', coreAbsorb: true, reminded: false, items: [{ key: 'k', f: 'F7', kind: 'OWN_RULE', ticker: 'NVDA', title: 't', choices: [{ id: 'RULE', label: '照規則', lines: [] }, { id: 'SKIP', label: '這次不做', lines: [] }], choice: 'RULE', ruleChoice: 'RULE' }] };
      a.notifs.push(n as never, { ...structuredClone(n), id: 100, status: 'RESPONDED' } as never);
      const r = refreshOwnAiChoice(recordAiTier(a, 'NVDA', 'EXIT', view.date, false), view, 'NVDA');
      expect(r.changed).toEqual([99]);
      const it = r.acct.notifs.find((x) => x.id === 99)!.items[0];
      expect(it.choices.map((c) => c.id)).toEqual(['RULE', 'AI', 'SKIP']);
      expect(it.choices[1].lines[0].shares).toBe(-(a.lots.own.NVDA ?? 0));
      expect(r.acct.notifs.find((x) => x.id === 100)!.items[0].choices).toHaveLength(2);
    });
  });

  it('F8：加回時註明未解除的硬事件標記與已成立的降級條件', async () => {
    await base((acct, view) => {
      const a = structuredClone(acct);
      a.rule.own.NVDA.applied = 'HALF';
      // 減半中只剩約 5%、標準 10%：加回要買得到，又不會碰到單檔 15% 的上限
      a.lots.own.NVDA = Math.floor(a.lots.own.NVDA / 4);
      a.rule.own.NVDA.stdWeight = 0.1;
      a.own.NVDA.pending = { action: 'READD', date: view.date };
      a.own.NVDA.flags = ['ACCOUNTING'];
      a.own.NVDA.metConds = ['毛利率低於 55%'];
      const m = monthlyReport(a, view, { order: [], month: '2026-12' });
      const it = m.notif.items.find((i) => i.f === 'F8')!;
      expect(it.note).toBe('注意：未解除的硬事件標記：ACCOUNTING；已成立的降級條件：毛利率低於 55%');
    });
  });

  it('月報：准許但觀察的進場項目註明理由；任務 C 的說明接在狀態後面；F21 提醒不附清單', async () => {
    await base((acct, view) => {
      const m = monthlyReport(acct, view, { order: ['AAPL', 'NVDA'], month: '2026-12', watch: { AAPL: '增資（只顯示）' }, notes: ['MU 最近一個月跌 25%：產業一起跌'] });
      const it = m.notif.items.find((i) => i.f === 'F1' && i.ticker === 'AAPL');
      if (it) expect(it.note).toBe('准許但觀察：增資（只顯示）');
      expect(m.notif.text).toContain('\nMU 最近一個月跌 25%：產業一起跌');
      const s = strategyReminder(acct, view, '動能相對基準落後超過 20%');
      expect(s.notif).toMatchObject({ kind: 'INFO', title: '策略檢討提醒', items: [] });
      expect(s.acct.notifs.at(-1)!.id).toBe(s.notif.id);
    });
  });
});
