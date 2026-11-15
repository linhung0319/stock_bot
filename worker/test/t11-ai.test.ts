// T11：其餘 AI 功能（F18 → F19 → F1 → F7／F8 → F14 → F5／F6 → F20 → F21 → F23）。
// 純函式的規則偵測與檢查用構造的資料測；整條流程用假的 EDGAR（依 CIK 分開的申報）、假的雲端排程、假的 LINE、假的 FRED。
import { describe, expect, it } from 'vitest';
import { judge, type EvidencePack } from '../src/ai/check';
import { checkCrashPayload, crashOpinionOf, macroDashboard } from '../src/ai/crash';
import { attribution, earningsDivergence, epsQuarters, jumpMetrics, oneOffJump, shareGrowth, sicToEtf, suspectMoves } from '../src/ai/detect';
import { dropDecision } from '../src/ai/drops';
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
import { createAccount, monthlyReport, refreshOwnAiChoice, strategyReminder, type Account } from '../src/engine';
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
    // T32b（momentum_ai §3.4）：三票一致的證據不足也算有結論，記 AI（之後沒有新證據就沿用）；以前記 DEFAULT
    expect(courtVerdict(o)).toMatchObject({ decision: 'ALLOW', source: 'AI' });
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
    // T28：多了細項 sub（沒給是 null）與條件的列編號（這個證據包沒有對照表：空的）
    expect(scanEvents(o, pack)).toEqual([
      { ticker: 'AAPL', cls: 'REGULATORY_CANDIDATE', sub: null, sourceId: 'nasdaq-rss:AAPL:2026-11-23', date: '2026-11-23', conditionIds: [], conditionRows: [] },
      { ticker: 'MU', cls: 'GUIDANCE_CUT', sub: null, sourceId: 'nasdaq-rss:AAPL:2026-11-23', date: '2026-11-23', conditionIds: ['MU 的事件條件 C2'], conditionRows: [] },
    ]);
    expect(o.samples[0].issues.length).toBe(2);
  });
});

// ---------------------------------------------------------------- F7、F20、F5／F6、F21、F14 的純函式

describe('F7／F20／F5／F6／F21／F14：檢查與結論', () => {
  // T31b 改了 dropDecision（own_thesis §3.3，修 K4）：結果是五種之一，「不動」多了程式核對（跌幅拆解在證據包的 rule.detail.attr）。
  // 各種結果的條件在 test/t31b-drop.test.ts；這裡留原本的兩個斷言（三票不動、三票減半）與轉交。F20 的一句話 T32d 拿掉（momentum_ai §3.6）
  it('F7：3 票一致而且和規則（減半）不同才給「照 AI」；轉交 F19 要寫代碼', () => {
    const pack = { run_id: 'r', function: 'OWN_DROP', as_of: '2026-11-23', policy: { level: 'A3', verdicts: ['EXIT', 'HALF', 'HOLD'], abstain: 'HALF', min_evidence: 1, samples: 3 }, premises: [], condition_types: [], data_quality: {}, facts: [], rule: { action: '', detail: { attr: { stock: -0.25, market: -0.2, sector: null, idio: -0.05 } } }, documents: [{ id: 'P', source_id: 'price:MU', kind: 'price', date: '2026-11-23', title: 'p', text: '2026-11-23 MU close 70.00' }] } as unknown as EvidencePack;
    const v = (verdict: string, extra: Record<string, unknown> = {}) => ({ verdict, evidence: [{ id: 'E1', source_id: 'price:MU', date: '2026-11-23', quote: '2026-11-23 MU close 70.00', claim: 'x' }], payload: { tier: verdict, cause_class: 'MARKET', ...extra } });
    expect(dropDecision(judge(pack, [v('HOLD'), v('HOLD'), v('HOLD')], PAYLOAD_HOOKS.OWN_DROP), pack)).toMatchObject({ status: 'HOLD', cause: 'MARKET' });
    expect(dropDecision(judge(pack, [v('HALF'), v('HALF'), v('HALF')], PAYLOAD_HOOKS.OWN_DROP), pack).status).toBe('AGREE');
    const bad = judge(pack, [v('HOLD', { cause_class: 'VIBES', escalate_to_F19: true })], PAYLOAD_HOOKS.OWN_DROP);
    expect(bad.samples[0].payload).toMatchObject({ cause_class: 'UNKNOWN', escalate_to_F19: false });
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
    // T33d 起不再檢查 bear_prob（送來就忽略，core_ai §3.9）；opinion 和 verdict 不同照樣記
    expect(smp.payload.bear_prob).toBe(1.4);
    expect(smp.issues).toEqual(['payload.opinion（DELAY）和 verdict 不同']);
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

  it('F14：改寫的條件照 F24 的規則檢查；成立時的動作帶使用者寫的那一條（T27：草擬前提拿掉）', () => {
    const r = ownCheckResult(
      {
        status: 'AGREED',
        samples: [
          {
            valid: true,
            verdict: 'DONE',
            report: '改寫了一條。\n\n其他是理由。',
            payload: {},
            conditions: [
              { from: 'payload.conditions', auto: true, raw: { line: 'U1', direction: 'DOWN', kind: 'XBRL', text: '毛利率低於 55%', check: { type: 'xbrl_metric_below', metric: 'GrossMarginPct', level: 0.55 }, tier_if_met: 'EXIT' } },
              { from: 'payload.conditions', auto: false, why: '價格條件只記錄', raw: { direction: 'DOWN', kind: 'PRICE', text: '跌破 100', check: { type: 'price_close_below', level: 100 } } },
            ],
          },
        ],
      } as never,
      'NVDA',
      [{ text: '毛利率跌破 55% 就減半', action: 'HALF' }],
    );
    expect('drafts' in r).toBe(false);
    // U1 對到使用者寫的第 1 條 → 用使用者選的減半（AI 寫的檔位是出清）；U2 沒寫 line、沒有檔位 → 重新審查
    expect(r.conditions.map((c) => [c.condId, c.kind, c.manual, c.then, c.action, c.from])).toEqual([
      ['U1', 'XBRL', false, '新財報出來時比對', 'HALF', '毛利率跌破 55% 就減半'],
      ['U2', 'PRICE', true, '只記錄：價格條件只記錄', 'REVIEW', null],
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
  /** 這些 CIK 的申報清單抓不到（T32a）。 */
  failSubs?: Set<number>;
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
    if (sub && sec.failSubs?.has(Number(sub[1]))) return new Response('busy', { status: 503 });
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
    // T33b：最新一筆是資料日那一天（core_ai §3.5 的過期判斷：每日序列停在 10 天以前的不能用，可用的不到 6 個不開檢視）
    if (url.startsWith('https://fred.stlouisfed.org/graph/fredgraph.csv')) return new Response(`observation_date,X\n2000-10-02,1.0\n2026-05-01,1.2\n${w.dataDate},1.5\n`);
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
  it('動能持股的 NT 10-Q 規則直接提出；自選的 8-K 4.02 開法庭 → 3 票建議出場 → 當天通知；每日掃描標記 → 同一次 01:30 就開法庭（T36）', async () => {
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
        expect(evs.map((e) => [e.ticker, e.sub, e.status])).toEqual(expect.arrayContaining([['AAPL', 'NT_10-Q', 'HANDLED'], ['NVDA', '8K_4.02', 'IN_COURT']])); // T32c：交給法庭的事件是 IN_COURT

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
        // 每日掃描標記的監管候選 → 同一次 01:30 套用之後就對動能持股（還沒賣）開法庭，不等到隔天（T36，own_thesis §2.7）
        expect((await loadEvents(db, { ticker: 'AAPL', status: 'NEW' })).map((e) => e.sub)).toEqual([]);
        expect((await loadEvents(db, { ticker: 'AAPL', status: 'IN_COURT' })).map((e) => e.sub)).toContain('SCAN_REGULATORY_CANDIDATE');
        // NVDA 的法庭有結論 → 事件標 HANDLED、寫結論（T32c）
        expect((await loadEvents(db, { ticker: 'NVDA' })).find((e) => e.sub === '8K_4.02')).toMatchObject({ status: 'HANDLED', handled_note: `法庭 ${court.runId}：EXIT` });
        const courts = await runsOf(db, 'HARD_EVENT');
        const aapl = courts.find((r) => r.ticker === 'AAPL')!;
        expect(aapl.createdAt).toBe('2026-11-24T01:30:00.000Z');
        expect(aapl.pack.rule.detail).toMatchObject({ codes: ['REGULATORY'], role: 'MOM' });
        expect(aapl.pack.premises.map((p) => p.id)).toEqual(['P2', 'P4']);
        // AAPL 的法庭一直沒有回來：隔天的流程照規則結束（逾時）→ 事件回到待處理 → 重開一次（T32c，修 Q12；以前是不再開）
        await run('2026-11-24');
        const again = (await runsOf(db, 'HARD_EVENT')).filter((r) => r.ticker === 'AAPL');
        expect(again).toHaveLength(2);
        expect((await loadEvents(db, { ticker: 'AAPL', status: 'IN_COURT' })).map((e) => e.handled_note)).toEqual([again.find((r) => r.runId !== aapl.runId)!.runId]);
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
        expect(await runsOf(db, 'MOM_SCORE')).toEqual([]); // T32d：擬事件打分拿掉（momentum_ai §3.7）

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

// ---------------------------------------------------------------- T32a 動能：修補（momentum_ai §5 的 T32a；引擎與純函式的部分在 t32a-mom-fixes.test.ts）

const EIGHTK_801 = '<html><body><p>Item 8.01 Other Events.</p><p>On November 17, 2026, the Company received a subpoena from the SEC Division of Enforcement requesting documents about revenue recognition practices.</p></body></html>';

describe('T32a：F1 的證據與月報', () => {
  it('每日掃描標到的 8-K（edgar: 開頭）原文出現在 F1 法庭的證據包；申報抓不到 → mom_reviews 的說明與 data_missing', async () => {
    let order: string[] = [];
    await withWorld(
      async ({ db, run }) => {
        for (const d of ['2026-11-20', '2026-11-23', '2026-11-24', '2026-11-25', '2026-11-27']) await run(d);
        const rev = new Map((await loadReviews(db, '2026-12')).map((r) => [r.ticker, r]));
        expect(rev.get(order[0])).toMatchObject({ decision: 'PENDING' });
        const court = (await runsOf(db, 'MOM_ENTRY')).find((r) => r.ticker === order[0])!;
        const doc = court.pack.documents.find((x) => x.source_id === 'edgar:0000000001-26-000801')!;
        expect(doc.kind).toBe('filing');
        expect(doc.text).toContain('subpoena from the SEC Division of Enforcement');
        // 申報抓不到：照規則准許，但不寫成「沒有命中」
        expect(rev.get(order[2])).toMatchObject({ decision: 'ALLOW', source: 'DEFAULT', dataMissing: true });
        expect(rev.get(order[2])!.note).toMatch(/^申報抓不到（.+），這次沒有檢查申報類的失效模式，照規則進場$/);
        expect(rev.get(order[2])!.note).not.toContain('沒有命中');
        // 抓得到、沒有命中的照舊
        expect(rev.get(order[3])).toMatchObject({ decision: 'ALLOW', source: 'RULE', dataMissing: false });
      },
      {
        before: async ({ db, sec, env, fetcher, cik }) => {
          await ingest(env, fetcher, cronTime('2026-11-19'), true);
          order = (await loadRanking(db))!.order;
          addFiling(sec, cik(order[0]), { accession: '0000000001-26-000801', form: '8-K', items: '8.01', acceptanceDateTime: '2026-11-18T21:00:00.000Z', filingDate: '2026-11-18', primaryDocument: 'k801.htm', html: EIGHTK_801 });
          // 每日掃描（那時它是第 6～10 名的候選）標過：監管候選，accession 是 edgar:<申報編號>
          await db
            .prepare("INSERT INTO sec_events (ticker, accession, form, event_date, accepted_at, code, sub, by_rule, display_only, source, detail, status, created_at) VALUES (?, 'edgar:0000000001-26-000801', '8-K', '2026-11-18', NULL, 'REGULATORY', 'SCAN_REGULATORY_CANDIDATE', 0, 0, 'SCAN', '每日掃描標記：REGULATORY_CANDIDATE', 'NEW', '2026-11-19T23:40:00.000Z')")
            .bind(order[0])
            .run();
          sec.failSubs = new Set([cik(order[2])]);
        },
      },
    );
  });

  it('第一次流程失敗、01:30 補做才開的法庭，在 01:30 之後才完成 → 月報用得到它的結論（先套用再出月報）', async () => {
    let order: string[] = [];
    await withWorld(
      async ({ db, run }) => {
        const b = order[1];
        for (const d of ['2026-11-20', '2026-11-23', '2026-11-24', '2026-11-25']) await run(d);
        // 11-27 的第一次流程沒有跑；01:30 補做（開法庭）
        await run('2026-11-27', 'FINAL');
        const court = (await runsOf(db, 'MOM_ENTRY')).find((r) => r.ticker === b)!;
        expect(court.createdAt).toBe('2026-11-28T01:30:00.000Z');
        const doc = court.pack.documents.find((x) => x.kind === 'filing')!;
        const veto = { run_id: court.pack.run_id, verdict: 'VETO', premise_checks: [{ premise_id: 'P2', status: 'BROKEN', evidence_ids: ['E1'] }], evidence: [{ id: 'E1', source_id: doc.source_id, date: doc.date, quote: 'revenue of $40 million was recognized prematurely', claim: '營收提前認列' }], payload: { decision: 'VETO', reason_code: 'ACCOUNTING' }, report: '財報不可信。' };
        // 01:50 才送回（03:30 那一次也沒有跑）
        await postResult(db, court.runId, [veto, veto, veto], new Date('2026-11-28T01:50:00Z'));
        expect((await loadReviews(db, '2026-12')).find((r) => r.ticker === b)).toMatchObject({ decision: 'PENDING' });
        const m = await run('2026-11-30');
        const rev = (await loadReviews(db, '2026-12')).find((r) => r.ticker === b)!;
        expect(rev).toMatchObject({ decision: 'VETO', reasonCode: 'ACCOUNTING', source: 'AI' });
        const acct = (await loadAccount(db))!.acct;
        const monthly = acct.notifs.find((n) => n.id === m.monthly)!;
        expect(monthly.monthly!.input.vetoed).toContain(b);
        expect(monthly.items.filter((i) => i.f === 'F1').map((i) => i.ticker)).not.toContain(b);
        expect((await db.prepare('SELECT applied_at FROM ai_runs WHERE run_id = ?').bind(court.runId).first<{ applied_at: string }>())!.applied_at).toBe('2026-11-30T23:30:00.000Z');
      },
      {
        before: async ({ db, sec, env, fetcher, cik }) => {
          await ingest(env, fetcher, cronTime('2026-11-19'), true);
          order = (await loadRanking(db))!.order;
          addFiling(sec, cik(order[1]), { accession: '0000000002-26-000020', form: '8-K', items: '4.02', acceptanceDateTime: '2026-11-05T21:00:00.000Z', filingDate: '2026-11-05', primaryDocument: 'k402.htm', html: EIGHTK_402 });
        },
      },
    );
  });
});

describe('T32a：硬事件的待處理事件 10 天過期（§3.5）', () => {
  it('建立超過 10 個日曆天的 NEW 事件不開法庭、標成已處理；10 天內的照常開', async () => {
    await withWorld(
      async ({ db, run }) => {
        const ins = db.prepare("INSERT INTO sec_events (ticker, accession, form, event_date, accepted_at, code, sub, by_rule, display_only, source, detail, status, created_at) VALUES ('AAPL', ?, 'NEWS', ?, NULL, 'REGULATORY', 'SCAN_REGULATORY_CANDIDATE', 0, 0, 'SCAN', '每日掃描標記', 'NEW', ?)");
        await db.batch([ins.bind('nasdaq-rss:AAPL:2026-11-09', '2026-11-09', '2026-11-09T23:40:00.000Z'), ins.bind('nasdaq-rss:AAPL:2026-11-18', '2026-11-18', '2026-11-18T23:40:00.000Z')]);
        await run('2026-11-20');
        const evs = new Map((await loadEvents(db, { ticker: 'AAPL' })).map((e) => [e.accession, e]));
        expect(evs.get('nasdaq-rss:AAPL:2026-11-09')).toMatchObject({ status: 'HANDLED', handled_note: '過期：建立超過 10 天沒有處理' });
        const fresh = evs.get('nasdaq-rss:AAPL:2026-11-18')!;
        const courts = (await runsOf(db, 'HARD_EVENT')).filter((r) => r.ticker === 'AAPL');
        expect(courts).toHaveLength(1);
        // T32c：交給法庭的事件標 IN_COURT、handled_note 是執行編號（以前是 HANDLED「開法庭 …」）
        expect(fresh).toMatchObject({ status: 'IN_COURT', handled_note: courts[0].runId });
        expect((courts[0].pack.rule.detail as { events: { date: string }[] }).events.map((e) => e.date)).toEqual(['2026-11-18']);
      },
      { mom: ['AAPL'] },
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
        expect(snap.rows.find((r) => r.id === 'T10Y3M')).toMatchObject({ value: 1.5, date: '2026-11-27', stale: false });
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

describe('T33a：崩盤規則檢視什麼時候開（core_ai §3.1 的 crashNeeds）', () => {
  const crashRuns = async (db: D1Database) => (await runsOf(db, 'CRASH_REVIEW')).filter((r) => (r.pack.rule.detail as { direction?: string }).direction !== 'NONE');

  it('前一天預估的檢視票數不一致（跑完了、沒有意見）→ 月報當天不再開', async () => {
    const up = fakeParams('VOO').g > 0;
    await withWorld(
      async ({ db, run }) => {
        for (const d of ['2026-11-20', '2026-11-23', '2026-11-24', '2026-11-25', '2026-11-27']) await run(d);
        const [cr] = await crashRuns(db);
        expect(cr.pack.rule.detail).toMatchObject({ direction: up ? 'OFF' : 'ON', month: '2026-12', kind: 'PREVIEW', basis: '2026-11-27', try: 1 });
        expect(cr.pack.question.startsWith('這是依 2026-11-27 的收盤預估的：訊號日（2026-11-30）收盤如果仍在均線的同一側，規則會切換。')).toBe(true);
        const dir = up ? 'OFF' : 'ON';
        const vote = (v: string) => ({ run_id: cr.pack.run_id, verdict: v, evidence: [], payload: { direction: dir, opinion: v }, report: '過去 17 次中 3 次是真空頭。' });
        await postResult(db, cr.runId, [vote('FOLLOW'), vote('DELAY'), vote('FOLLOW')], new Date('2026-11-28T00:10:00Z'));
        expect((await getRun(db, cr.runId))!.outcome!.status).toBe('SPLIT');
        await run('2026-11-27', 'FINAL');
        const m = await run('2026-11-30');
        const acct = (await loadAccount(db))!.acct;
        const it = acct.notifs.find((n) => n.id === m.monthly)!.items.find((i) => i.f === (up ? 'F6' : 'F5'))!;
        expect(it.aiLine).toBeUndefined(); // 沒有意見 → 沒有那一行
        // 舊的寫法這裡會因為沒有 aiLine 而補開第二次
        expect(await crashRuns(db)).toHaveLength(1);
        await run('2026-12-01');
        expect(await crashRuns(db)).toHaveLength(1);
      },
      { crash: up },
    );
  });

  it('訊號日的流程沒有跑成、隔天補做才出月報 → 補開（MAKEUP，不看今天是不是月底）；沒有結論的每天重開，同一個月份＋方向最多 3 次', async () => {
    const up = fakeParams('VOO').g > 0;
    await withWorld(
      async ({ db, run }) => {
        await run('2026-11-20');
        // 11-23～11-30 的流程都沒有跑；12-01 一次補做（含 11-30 的月報）
        const r = await run('2026-12-01');
        expect(r.processed).toContain('2026-11-30');
        const acct = (await loadAccount(db))!.acct;
        const monthly = acct.notifs.find((n) => n.id === r.monthly)!;
        expect(monthly.date).toBe('2026-11-30');
        expect(monthly.items.some((i) => i.f === (up ? 'F6' : 'F5'))).toBe(true);
        const runs = await crashRuns(db);
        expect(runs).toHaveLength(1);
        expect(runs[0].pack.rule.detail).toMatchObject({ direction: up ? 'OFF' : 'ON', month: '2026-12', kind: 'MAKEUP', basis: '2026-11-30', try: 1 });
        expect(runs[0].asOf).toBe('2026-12-01');
        // 一直沒有送回：逾時（沒有結論）→ 月報還沒回覆，隔天再開；第 3 次之後不再開
        for (const d of ['2026-12-02', '2026-12-03', '2026-12-04']) await run(d);
        const all = (await crashRuns(db)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        expect(all.map((x) => (x.pack.rule.detail as { try: number }).try)).toEqual([1, 2, 3]);
        expect(all.map((x) => x.asOf)).toEqual(['2026-12-01', '2026-12-02', '2026-12-03']);
        expect((await getRun(db, all[0].runId))!.outcome!.status).toBe('TIMEOUT');
      },
      { crash: up },
    );
  });

  it('核心 ETF 不滿 200 根日線 → 崩盤規則維持原狀態（不切換）並告警', async () => {
    const up = fakeParams('VOO').g > 0;
    await withWorld(
      async ({ db, w, run }) => {
        w.bars.VOO = 150;
        for (const d of ['2026-11-20', '2026-11-23', '2026-11-24', '2026-11-25', '2026-11-27']) await run(d);
        const m = await run('2026-11-30');
        const acct = (await loadAccount(db))!.acct;
        const monthly = acct.notifs.find((n) => n.id === m.monthly)!;
        expect(monthly.items.some((i) => i.f === 'F5' || i.f === 'F6')).toBe(false);
        expect(acct.rule.crash).toBe(up);
        expect(monthly.monthly!.input.crash).toMatchObject({ below: up, ma: null, bars: 150, date: '2026-11-30' });
        const alerts = (await db.prepare("SELECT message FROM alerts WHERE kind = 'CORE_MA_MISSING'").all<{ message: string }>()).results;
        expect(alerts.map((a) => a.message)).toEqual([`VOO 的 200 日均線算不出來（只有 150 根日線）。崩盤規則這個月維持原狀態（${up ? '啟動中' : '未啟動'}）。`]);
        expect(await crashRuns(db)).toHaveLength(0); // 預估也不會切換
      },
      // 均線算得出來時會切換的方向：VOO 在漲 → 帳戶設成啟動中（會解除）；在跌 → 未啟動（會啟動）
      { crash: up },
    );
  });
});

describe('整條流程：F7 減半檢視、動能持股單月大跌', () => {
  // T29b：自選股不再跑 F20（own_thesis §2.8）；T32d：動能的 F20 也拿掉（momentum_ai §3.6），改成「要看的事」的一行（不開 AI、不進月報的狀態文字）
  // T31b 改了這個行為（own_thesis §3.3，修 K4）：這裡三票「不動」的歸類是一次性事件、而且只有 NVDA 自己跌（個股自身的跌幅超過整段的一半），
  // 過不了「不動」的條件 → 沒有可用的結論，通知上不會出現「照 AI：不動」，也不動 aiTier。過得了的情況在 test/t31b-drop.test.ts
  it('自選暴跌 → 當天減半通知；F7 三票「不動」但只有個股自己跌 → 沒有可用的結論、照規則；動能持股大跌不開 AI、列在月報的「要看的事」', async () => {
    await withWorld(async ({ db, w, run }) => {
      await run('2026-11-20');
      w.shock.NVDA = { from: '2026-11-23', factor: 0.7 };
      w.shock.AAPL = { from: '2026-11-23', factor: 0.7 };
      await run('2026-11-23');
      let acct = (await loadAccount(db))!.acct;
      const urgent = acct.notifs.find((n) => n.kind === 'URGENT' && n.items.some((i) => i.f === 'F7'))!;
      const [drop] = await runsOf(db, 'OWN_DROP');
      expect(drop).toMatchObject({ ticker: 'NVDA', status: 'PENDING' });
      expect(drop.pack.rule.detail).toMatchObject({ urgent: true });
      expect(drop.pack.facts.find((f) => f.id === 'A2')!.value).toMatch(/^-/);
      expect(await runsOf(db, 'DROP_EXPLAIN')).toEqual([]);
      const price = drop.pack.documents.find((d) => d.source_id === 'price:NVDA')!;
      const quote = price.text.split('\n').at(-1)!;
      const hold = { run_id: drop.pack.run_id, verdict: 'HOLD', premise_checks: [{ premise_id: 'P1', status: 'HOLDS', evidence_ids: ['E1'] }], evidence: [{ id: 'E1', source_id: 'price:NVDA', date: price.date, quote, claim: '一天跌 30%，沒有申報' }], payload: { tier: 'HOLD', cause_class: 'ONE_OFF' }, report: '一次性下跌。' };
      await postResult(db, drop.runId, [hold, hold, hold], new Date('2026-11-24T00:10:00Z'));
      await run('2026-11-23', 'FINAL');
      acct = (await loadAccount(db))!.acct;
      const it = acct.notifs.find((n) => n.id === urgent.id)!.items.find((i) => i.f === 'F7')!;
      expect(it.choices.map((c) => c.id)).toEqual(['RULE', 'SKIP']);
      expect(it.aiLine).toBe('AI 論點檢查沒有一致結論，照規則');
      expect(acct.own.NVDA.dropReview).toMatchObject({ session: '2026-11-23', runId: drop.runId, status: 'NONE' });
      expect(acct.own.NVDA.aiTier).toBeNull();
      for (const d of ['2026-11-24', '2026-11-25', '2026-11-27']) await run(d);
      const m = await run('2026-11-30');
      const monthly = (await loadAccount(db))!.acct.notifs.find((n) => n.id === m.monthly)!;
      expect(monthly.text).not.toContain('AAPL 最近');
      expect(monthly.attention?.find((x) => x.ticker === 'AAPL')).toMatchObject({ kind: 'DROP_21D', src: 'mom' });
    }, { mom: ['AAPL'] });
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
      // T27：出場條件每條帶使用者選的動作（own_check_v2）
      const r = await startOwnCheck(env, fetcher, loaded.acct, view, axis, 'NVDA', [{ text: '公司下修營收財測就賣', action: 'EXIT' }, { text: '收盤跌破 100 就賣', action: 'EXIT' }], now);
      expect(r.pack.rule.detail).toMatchObject({ mode: 'REWRITE', lines: ['公司下修營收財測就賣', '收盤跌破 100 就賣'] });
      expect(r.pack.prompt_version).toBe('own_check_v2');
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
      // T25：條件屬於這檔現在的論點檔（file_id）
      await db.prepare("INSERT INTO own_conditions (ticker, run_id, cond_id, direction, kind, text, check_json, tier_if_met, status, created_at, file_id) VALUES ('NVDA', 'old', 'C9', 'DOWN', 'XBRL', '舊的 AI 條件', '{}', 'HALF', 'ACTIVE', 'x', ?)").bind(loaded.acct.own.NVDA.fileId).run();
      const tenq = { id: 'D1', source_id: 'edgar:x', kind: 'filing' as const, date: '2026-10-30', title: '10-Q', text: 'Gross margin was 60.0%, down from 70.0% a year ago' };
      const pack = ownReviewPack({ acct: loaded.acct, view, axis, ticker: 'NVDA', runId: 'rev1', trigger: 'MONTHLY', xbrl: null, filings: [tenq], news: null, dataQuality: { filings: 'ok' }, now }).pack;
      const vote = { verdict: 'HALF', premise_checks: [{ premise_id: 'P1', status: 'BROKEN', evidence_ids: ['E1'] }], evidence: [{ id: 'E1', source_id: 'edgar:x', date: '2026-10-30', quote: 'Gross margin was 60.0%, down from 70.0% a year ago', claim: '毛利率下滑' }], payload: { tier: 'HALF', proposed_conditions: [{ id: 'C1', direction: 'DOWN', kind: 'XBRL', text: '毛利率低於 55%', check: { type: 'xbrl_metric_below', metric: 'GrossMarginPct', level: 0.55 }, basis: ['E1'], tier_if_met: 'EXIT' }] } };
      const outcome = judge(pack, [vote, vote, vote], PAYLOAD_HOOKS.OWN_REVIEW);
      const ctx: ApplyCtx = { db, acct: loaded.acct, view, axis, session: '2026-11-20', now, stmts: [], log: [] };
      await applyOwnReview(ctx, { runId: 'rev1', fn: 'OWN_REVIEW', ticker: 'NVDA', asOf: '2026-11-20', outcome, pack } as never);
      await db.batch(ctx.stmts);
      const conds = await loadConditions(db, 'NVDA');
      // T26：審查不再整組替換條件（舊的 AI 條件 C9 也留著），新提的只是建議（勾選才監測）
      expect(conds.map((c) => [c.condId, c.origin, c.status])).toEqual([
        ['U1', 'USER', 'ACTIVE'],
        ['U2', 'USER', 'MANUAL'],
        ['C9', 'AI', 'ACTIVE'],
        ['C1', 'AI', 'PROPOSED'],
      ]);
      // 勾選的出場條件是「你定的條件」：有勾選時間、成立時的動作帶 AI 改寫時的檔位
      expect(conds.filter((c) => c.origin === 'USER').map((c) => [c.condId, !!c.acceptedAt, c.action])).toEqual([
        ['U1', true, 'EXIT'],
        ['U2', true, 'EXIT'],
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

  // T31b 改了這個行為（own_thesis §3.4）：重算看的是這次減半的論點檢查（dropReview），不是 aiTier 的檔位
  it('F7 的 AI 檢視晚回來：還沒回覆的減半項目照減半檢視的結果重算「照 AI」；已回覆的不動', async () => {
    await base((acct, view) => {
      const a = structuredClone(acct);
      const n = { id: 99, kind: 'URGENT', date: view.date, seq: view.i, title: 'x', status: 'PENDING', coreAbsorb: true, reminded: false, items: [{ key: 'k', f: 'F7', kind: 'OWN_RULE', ticker: 'NVDA', title: 't', choices: [{ id: 'RULE', label: '照規則', lines: [] }, { id: 'SKIP', label: '這次不做', lines: [] }], choice: 'RULE', ruleChoice: 'RULE' }] };
      a.notifs.push(n as never, { ...structuredClone(n), id: 100, status: 'RESPONDED' } as never);
      a.own.NVDA.dropReview = { session: view.date, runId: 'run-f7', status: 'EXIT', cause: 'FUNDAMENTAL', premiseId: 'P1', told: false };
      const r = refreshOwnAiChoice(a, view, 'NVDA');
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

  // T32d：任務 C（F20）的說明不再接在月報的狀態文字後面（momentum_ai §3.6，修 Q15）；舊月報留下的 notes 欄位不再讀
  it('月報：准許但觀察的進場項目註明理由；狀態文字沒有大跌說明；F21 提醒不附清單', async () => {
    await base((acct, view) => {
      const m = monthlyReport(acct, view, { order: ['AAPL', 'NVDA'], month: '2026-12', watch: { AAPL: '增資（只顯示）' }, ...({ notes: ['MU 最近一個月跌 25%：產業一起跌'] } as object) });
      const it = m.notif.items.find((i) => i.f === 'F1' && i.ticker === 'AAPL');
      if (it) expect(it.note).toBe('准許，附註：增資（只顯示）'); // T32b：「准許但觀察」改叫「准許，附註」（舊月報只有 watch 時照樣顯示）
      expect(m.notif.text).not.toContain('MU 最近一個月跌 25%');
      const s = strategyReminder(acct, view, '動能相對基準落後超過 20%');
      expect(s.notif).toMatchObject({ kind: 'INFO', title: '策略檢討提醒', items: [] });
      expect(s.acct.notifs.at(-1)!.id).toBe(s.notif.id);
    });
  });
});
