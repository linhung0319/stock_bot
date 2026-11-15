// T32d：動能——拿掉的與顯示（momentum_ai_design_2026-11-15 §5 的 T32d 那一列；§3.2、§3.6～§3.8；own_thesis §3.6.6）。
// 完成條件：
//   月報前一天不再開擬事件打分
//   動能持股跌 20% 不開 AI、持股頁與月報清單有那一行、LINE 的狀態文字沒有
//   scanTargets 沒有候選股
//   策略檢討提醒在 AI 沒設定時也有歷史對照
//   做完之後 DROP_EXPLAIN 沒有任何呼叫端（也不再有檢查與套用）
// 另外：momDropLine 的文字、momAttention 的三種（LATE_VETO 只在第三種月報狀態）、月報頻率、否決紀錄、運作統計的 F1 那一段、
//   每日抓價格時動能持股的產業 ETF、策略檢討的 AI 說明沒有回來。
// 對外請求全部是假的（價格、成分股固定檔、EDGAR、Nasdaq RSS、French 資料庫、雲端排程、LINE）。
import { describe, expect, it } from 'vitest';
import { MONTH_DROP, momDropLine } from '../src/ai/detect';
import { PAYLOAD_HOOKS } from '../src/ai/hooks';
import { FRENCH_MOM_URL } from '../src/ai/strategy';
import type { ApplyCtx } from '../src/app/aiCtx';
import { listRuns, type AiRun } from '../src/app/aiRuns';
import { APPLIERS } from '../src/app/aiStep';
import type { Env, Fetcher } from '../src/app/env';
import { scanTargets } from '../src/app/events';
import type { SecEventRow } from '../src/app/filings';
import { ingest, runFlow } from '../src/app/flow';
import { loadAccount, saveAccount } from '../src/app/ledgerStore';
import { LINE_PUSH_URL } from '../src/app/line';
import { loadReviews, type MomReview } from '../src/app/momAi';
import { MOM_ATTN, eventLabel, eventSource, forMonthly, momAttention, vetoEpisodes, type MomAttnInput } from '../src/app/momNotes';
import { VETO_HINT_EVERY, momEntrySection } from '../src/app/opsReport';
import type { Attempt } from '../src/app/schedule';
import { vetoView } from '../src/app/site/aiViews';
import { notifView } from '../src/app/site/views';
import { applyStrategyReview, historyLine, strategyHistory, withHistory } from '../src/app/strategyAi';
import { dueAttention } from '../src/app/thesis';
import { buildMarketView } from '../src/data/marketView';
import { loadSeries } from '../src/data/store';
import { createAccount, monthlyReport, type Account, type Item, type Notif } from '../src/engine';
import { handle } from '../src/index';
import { freshDb } from './helpers/d1';
import { cronTime, fakeFetcher, fakeParams, newWorld, type World } from './helpers/fakeSources';

// ---------------------------------------------------------------- 純函式：單月大跌那一行

/** 30 個交易日的時間軸；每一檔從 100 線性走到 end（只看頭尾）。 */
function series(ends: Record<string, number>) {
  const axis = Array.from({ length: 30 }, (_, k) => `2026-10-${String(k + 1).padStart(2, '0')}`).map((d, k) => (k < 31 ? d : d));
  const n = axis.length;
  const close: Record<string, number[]> = {};
  for (const [t, end] of Object.entries(ends)) close[t] = Array.from({ length: n }, (_, k) => (k < n - 22 ? 100 : 100 + ((end - 100) * (k - (n - 22))) / 21));
  return { axis, close, i: n - 1 };
}

describe('T32d：單月大跌那一行（momDropLine，§3.6）', () => {
  it('設計的範例文字：跌幅拆解、這段期間的事件、排名；沒有產業 ETF 時省略產業、沒有事件時寫沒有記到；已經掉出前 15 名', () => {
    const s = series({ MU: 76.6, VOO: 95.9, SOXX: 89.9 });
    const from = s.axis[s.i - 21];
    const events = [
      { date: '2026-10-10', label: '財測下修', source: '8-K' },
      { date: '2026-10-20', label: '高層異動', source: '新聞標題' },
      { date: from, label: '太早的事件', source: '8-K' }, // 起點那一天不算（期間是起點之後到今天）
    ];
    const r = momDropLine({ ...s, ticker: 'MU', market: 'VOO', sector: 'SOXX', events, rank: 7, exitRank: 15 })!;
    expect(r.text).toBe('MU 最近 21 個交易日跌 23.4%：大盤 -4.1%、產業（SOXX）比大盤 -6.0%、個股自身 -13.3%。這段期間記到的事件：10-10 財測下修（8-K）、10-20 高層異動（新聞標題）。動能的出場只看排名（目前第 7 名，掉出前 15 名才賣）。');
    const bare = momDropLine({ ...s, ticker: 'MU', market: 'VOO', sector: null, events: [], rank: null, exitRank: 15 })!;
    expect(bare.text).toBe('MU 最近 21 個交易日跌 23.4%：大盤 -4.1%、個股自身 -19.3%。這段期間沒有記到申報事件。動能的出場只看排名（目前不在排名的股票池內，月報會列出場）。');
    // 已經掉出前 15 名：不寫「掉出前 15 名才賣」
    expect(momDropLine({ ...s, ticker: 'MU', market: 'VOO', sector: null, events: [], rank: 22, exitRank: 15 })!.text).toContain('動能的出場只看排名（目前第 22 名，已經掉出前 15 名，月報會列出場）。');
  });

  it('門檻：剛好跌 20% 成立、跌 19.9% 不成立；資料不足不成立', () => {
    expect(MONTH_DROP).toBe(-0.2);
    const at = (end: number) => momDropLine({ ...series({ MU: end, VOO: 100 }), ticker: 'MU', market: 'VOO', sector: null, events: [], rank: 3, exitRank: 15 });
    expect(at(80)).not.toBeNull();
    expect(at(80.1)).toBeNull();
    const s = series({ MU: 70, VOO: 100 });
    expect(momDropLine({ ...s, i: 20, ticker: 'MU', market: 'VOO', sector: null, events: [], rank: 3, exitRank: 15 })).toBeNull();
  });

  it('事件的白話：細項優先、來源是表單名稱或新聞標題', () => {
    const ev = (o: Partial<SecEventRow>) => ({ code: 'OTHER', detail_code: null, form: '8-K', accession: '0000000001-26-000001', ...o }) as SecEventRow;
    expect(eventLabel(ev({ code: 'GUIDANCE_CUT', detail_code: 'CUT' }))).toBe('財測下修');
    expect(eventLabel(ev({ code: 'MGMT_CHANGE', detail_code: 'CEO_DEPART' }))).toBe('執行長離任');
    expect(eventLabel(ev({ code: 'MGMT_CHANGE' }))).toBe('高層異動');
    expect(eventLabel(ev({ code: 'DISTRESS', detail_code: 'DELISTING_NOTICE' }))).toBe('下市通知或不符上市規定');
    expect(eventSource(ev({}))).toBe('8-K');
    expect(eventSource(ev({ form: 'NEWS', accession: 'nasdaq-rss:MU:2026-11-10' }))).toBe('新聞標題');
    expect(eventSource(ev({ form: '8-K', accession: 'nasdaq-rss:MU:2026-11-10' }))).toBe('新聞標題');
  });
});

// ---------------------------------------------------------------- 純函式：動能的「要看的事」

const DATE = '2026-11-30';
function acctOf(o: { lots?: Record<string, number>; held?: string[]; notifs?: Notif[] } = {}): MomAttnInput['acct'] {
  return { lots: { own: {}, mom: o.lots ?? { MU: 10 }, core: {}, unc: {} }, rule: { heldMom: o.held ?? ['MU'] }, notifs: o.notifs ?? [], cfg: { coreTicker: 'VOO', exitRank: 15 } } as unknown as MomAttnInput['acct'];
}
function review(o: Partial<MomReview> = {}): MomReview {
  return { month: '2026-11', ticker: 'MU', rank: 3, decision: 'ALLOW', reasonCode: null, source: 'RULE', hits: [], runId: null, watchReason: null, liftCondition: null, replacedBy: null, note: null, ...o };
}
/** 月報那一則，裡面一個 MU 的 F1 項目（晚到的否決：push 有值 = 還沒填快照時補推過）。 */
function monthlyWith(status: Notif['status'], push: string | undefined): Notif {
  const it = { f: 'F1', ticker: 'MU', key: 'k', choices: [], choice: 'RULE', ruleChoice: 'RULE', lateVeto: { code: 'ACCOUNTING', runId: 'r-late', date: '2026-10-31', ...(push ? { push } : {}) } } as unknown as Item;
  return { id: 34, kind: 'MONTHLY', date: '2026-10-30', seq: 0, title: '2026-11 月報', items: [it], status, coreAbsorb: true, reminded: false, monthly: { input: { order: [], month: '2026-11' }, before: {} as never } } as Notif;
}
function inputOf(o: { acct?: MomAttnInput['acct']; reviews?: MomReview[]; end?: number; events?: SecEventRow[] } = {}): MomAttnInput {
  const s = series({ MU: o.end ?? 100, VOO: 100 });
  return { acct: o.acct ?? acctOf(), view: { date: DATE, close: s.close, i: s.i }, axis: s.axis, events: o.events ?? [], reviews: o.reviews ?? [], sectors: {}, rankOrder: ['AAPL', 'MU'] };
}

describe('T32d：動能的「要看的事」（momAttention，§3.6）', () => {
  it('DROP_21D：有動能部位、21 個交易日跌 20% 以上才成立；文字是 momDropLine 那一行（事件照代號分、用白話）', () => {
    const ev = { ticker: 'MU', code: 'GUIDANCE_CUT', detail_code: 'CUT', form: '8-K', accession: '0000000001-26-000001', event_date: '2026-10-20', status: 'INFO' } as SecEventRow;
    const other = { ...ev, ticker: 'AAPL' };
    const [hit] = momAttention(inputOf({ end: 75, events: [ev, other] }));
    expect(hit).toMatchObject({ ticker: 'MU', kind: 'DROP_21D', src: 'mom', key: 'DROP_21D', every: 1, since: DATE });
    expect(hit.text).toBe('MU 最近 21 個交易日跌 25.0%：大盤 +0.0%、個股自身 -25.0%。這段期間記到的事件：10-20 財測下修（8-K）。動能的出場只看排名（目前第 2 名，掉出前 15 名才賣）。');
    expect(momAttention(inputOf({ end: 81 }))).toEqual([]);
    // 名單上但還沒買（月報還沒下單）：不算動能持股的大跌
    expect(momAttention(inputOf({ end: 75, acct: acctOf({ lots: {} }) }))).toEqual([]);
  });

  it('LATE_VETO：買進之後才回來的否決（月報已經填快照）才列；還沒回覆、已回覆還沒填快照（補推過）不列；沒有動能部位不列', () => {
    const late = review({ month: '2026-11', decision: 'ALLOW', source: 'AI', lateVerdict: 'VETO', reasonCode: 'ACCOUNTING', runId: 'r-late' });
    const done = momAttention(inputOf({ acct: acctOf({ notifs: [monthlyWith('DONE', undefined)] }), reviews: [late] }));
    expect(done).toEqual([{ ticker: 'MU', kind: 'LATE_VETO', src: 'mom', key: 'LATE_VETO@2026-11', every: null, since: '2026-10-31', text: 'MU：進場審查在你買進之後回來，3 票否決（財報可信度）。出場照排名；不想留可以在帳戶頁排除 MU' }]);
    expect(momAttention(inputOf({ acct: acctOf({ notifs: [monthlyWith('PENDING', '補推的文字')] }), reviews: [late] }))).toEqual([]);
    expect(momAttention(inputOf({ acct: acctOf({ notifs: [monthlyWith('RESPONDED', '提醒的文字')] }), reviews: [late] }))).toEqual([]);
    expect(momAttention(inputOf({ acct: acctOf({ lots: {}, held: [], notifs: [monthlyWith('DONE', undefined)] }), reviews: [late] }))).toEqual([]);
    expect(momAttention(inputOf({ acct: acctOf({ notifs: [monthlyWith('DONE', undefined)] }), reviews: [review()] }))).toEqual([]);
  });

  it('ENTRY_NOTE：進場時是「准許，附註」而且還在名單上；不列進月報', () => {
    const watch = review({ month: '2026-11', decision: 'ALLOW_WATCH', watchReason: '新聞標題標到「重大監管或訴訟」（10-20），只有標題、沒有申報，不能否決' });
    const [h] = momAttention(inputOf({ reviews: [watch] }));
    expect(h).toMatchObject({ kind: 'ENTRY_NOTE', src: 'mom', since: '2026-11-01', text: 'MU 進場時的附註：新聞標題標到「重大監管或訴訟」（10-20），只有標題、沒有申報，不能否決' });
    expect(forMonthly([h])).toEqual([]);
    expect(momAttention(inputOf({ reviews: [review({ decision: 'ALLOW' })] }))).toEqual([]);
    expect(momAttention(inputOf({ acct: acctOf({ held: [] }), reviews: [watch] }))).toEqual([]);
    // 最新一次審查才算（之前那次的附註不再列）
    expect(momAttention(inputOf({ reviews: [review({ month: '2026-12' }), watch] }))).toEqual([]);
    expect(MOM_ATTN.map((k) => [k.kind, k.monthly])).toEqual([
      ['DROP_21D', true],
      ['LATE_VETO', true],
      ['ENTRY_NOTE', false],
    ]);
  });

  it('月報的頻率（用月算）：單月大跌每檔每 1 個月一次；晚到的否決只列一次', () => {
    const late = review({ month: '2026-11', source: 'AI', lateVerdict: 'VETO', reasonCode: 'ACCOUNTING', runId: 'r-late' });
    const hits = forMonthly(momAttention(inputOf({ end: 75, acct: acctOf({ notifs: [monthlyWith('DONE', undefined)] }), reviews: [late] })));
    expect(hits.map((x) => x.kind)).toEqual(['DROP_21D', 'LATE_VETO']);
    const first = dueAttention(hits, {}, '2026-11-30');
    expect(first.due).toHaveLength(2);
    expect(first.shown).toEqual({ MU: { DROP_21D: '2026-11-30', 'LATE_VETO@2026-11': '2026-11-30' } });
    expect(dueAttention(hits, first.shown, '2026-11-30').due).toEqual([]);
    const next = dueAttention(hits, first.shown, '2026-12-31');
    expect(next.due.map((x) => x.kind)).toEqual(['DROP_21D']);
  });
});

// ---------------------------------------------------------------- 純函式：否決紀錄、策略檢討

describe('T32d：否決紀錄（§3.7）', () => {
  it('每一次否決一列，連續沿用的月份算同一次；新證據重開又否決算新的一次；晚到的否決沒有遞補', () => {
    const rows: MomReview[] = [
      review({ month: '2026-12', decision: 'VETO', source: 'AI', reasonCode: 'ACCOUNTING', runId: '2026-11-27_MOM_ENTRY_MU_aaaaaa', replacedBy: 'AMD' }),
      review({ month: '2027-01', decision: 'VETO', source: 'AI', reasonCode: 'ACCOUNTING', runId: '2026-11-27_MOM_ENTRY_MU_aaaaaa', carriedFrom: '2026-12', replacedBy: 'AVGO' }),
      review({ month: '2027-03', decision: 'VETO', source: 'AI', reasonCode: 'ACCOUNTING', runId: '2027-02-25_MOM_ENTRY_MU_bbbbbb', replacedBy: 'ORCL' }),
      review({ month: '2027-03', ticker: 'NVDA', decision: 'ALLOW', source: 'AI', lateVerdict: 'VETO', reasonCode: 'REGULATORY', runId: '2027-02-26_MOM_ENTRY_NVDA_cccccc' }),
      review({ month: '2027-03', ticker: 'GE', decision: 'VETO', source: 'RULE', reasonCode: 'PENDING_MA' }), // 規則的否決不是 AI 的
    ];
    expect(vetoEpisodes(rows)).toEqual([
      { ticker: 'NVDA', date: '2027-02-26', code: 'REGULATORY', runId: '2027-02-26_MOM_ENTRY_NVDA_cccccc', months: ['2027-03'], replacedBy: null, late: true },
      { ticker: 'MU', date: '2027-02-25', code: 'ACCOUNTING', runId: '2027-02-25_MOM_ENTRY_MU_bbbbbb', months: ['2027-03'], replacedBy: 'ORCL', late: false },
      { ticker: 'MU', date: '2026-11-27', code: 'ACCOUNTING', runId: '2026-11-27_MOM_ENTRY_MU_aaaaaa', months: ['2026-12', '2027-01'], replacedBy: 'AMD', late: false },
    ]);
  });

  it('網站那一列：被否決者與遞補者之後 3、6 個月相對基準的報酬（還沒到是 null）', () => {
    const axis = Array.from({ length: 140 }, (_, k) => new Date(Date.parse('2026-11-27') + k * 86400_000).toISOString().slice(0, 10));
    const line = (g: number) => axis.map((_, k) => 100 * (1 + g * k));
    const close: Record<string, number[]> = { MU: line(-0.001), AMD: line(0.002), SPY: line(0.001) };
    const book = { axis, adj: (t: string, k: number) => close[t]?.[k] ?? NaN };
    const ep = { ticker: 'MU', date: '2026-11-27', code: 'ACCOUNTING', runId: 'r', months: ['2026-12'], replacedBy: 'AMD', late: false };
    const v = vetoView(book, ep, 'SPY');
    expect(v.codeText).toBe('財報可信度');
    expect(v.vetoed.m3).toBeCloseTo(-0.063 - 0.063, 6);
    expect(v.replacement!.m3).toBeCloseTo(0.126 - 0.063, 6);
    expect(v.vetoed.m6).toBeCloseTo(-0.126 - 0.126, 6);
    const short = vetoView({ axis: axis.slice(0, 70), adj: book.adj }, ep, 'SPY');
    expect(short.vetoed).toEqual({ m3: expect.any(Number), m6: null });
    expect(vetoView(null, { ...ep, replacedBy: null }, 'SPY')).toMatchObject({ vetoed: { m3: null, m6: null }, replacement: null });
  });
});

describe('T32d：策略檢討的歷史對照與 AI 說明沒有回來（§3.8）', () => {
  it('歷史對照那一句；抓不到時寫原因', async () => {
    expect(historyLine(-0.32, 7, 26)).toBe('歷史對照（French 動能因子，多空，只是近似）：同等深度（-32%）以上的回撤有 7 次，從高點到創新高的月數中位數是 26。');
    expect(historyLine(-0.32, 1, null)).toBe('歷史對照（French 動能因子，多空，只是近似）：同等深度（-32%）以上的回撤有 1 次，都還沒有回到高點。');
    expect(historyLine(-0.9, 0, null)).toBe('歷史對照（French 動能因子，多空，只是近似）：同等深度（-90%）以上的回撤沒有出現過。');
    const h = await strategyHistory(async () => new Response('busy', { status: 503 }), -0.3, '2026-11-20');
    expect(h).toEqual({ doc: null, line: '歷史對照抓不到（French 資料庫 HTTP 503）。', error: 'French 資料庫 HTTP 503' });
  });

  it('提醒只接一次；AI 說明沒有結論 → 提醒註明，有結論不動；通知頁連到報告', async () => {
    const n: Notif = { id: 7, kind: 'INFO', date: '2026-11-20', seq: 0, title: '策略檢討提醒', text: '動能相對基準落後超過 20%。', items: [], status: 'PENDING', coreAbsorb: false, reminded: false, runIds: ['r1'] };
    const acct = { notifs: [n], events: [] } as unknown as Account;
    const a1 = withHistory(acct, [7], '歷史對照抓不到（x）。')!;
    expect(a1.notifs[0].text).toBe('動能相對基準落後超過 20%。\n歷史對照抓不到（x）。');
    expect(withHistory(a1, [7], '歷史對照抓不到（x）。')).toBeNull();
    const ctx = (a: Account) => ({ acct: a, log: [], stmts: [] }) as unknown as ApplyCtx;
    const run = (status: string) => ({ runId: 'r1', fn: 'STRATEGY_REVIEW', outcome: { status } }) as unknown as AiRun;
    const ok = ctx(a1);
    await applyStrategyReview(ok, run('AGREED'));
    expect(ok.acct).toBe(a1);
    const bad = ctx(a1);
    await applyStrategyReview(bad, run('TIMEOUT'));
    expect(bad.acct.notifs[0].text).toBe('動能相對基準落後超過 20%。\n歷史對照抓不到（x）。\nAI 說明沒有回來（逾時），不重開。');
    const again = ctx(bad.acct);
    await applyStrategyReview(again, run('TIMEOUT'));
    expect(again.acct).toBe(bad.acct);
    expect(APPLIERS.STRATEGY_REVIEW).toBe(applyStrategyReview);
    expect(notifView({ acct: a1, view: {} as never, events: [] } as never, a1.notifs[0]).aiRun).toBe('r1');
  });
});

describe('T32d：拿掉的執行沒有呼叫端', () => {
  it('DROP_EXPLAIN、MOM_SCORE 沒有檢查也沒有套用（舊紀錄只顯示）', () => {
    expect(Object.keys(PAYLOAD_HOOKS)).not.toContain('DROP_EXPLAIN');
    expect(Object.keys(PAYLOAD_HOOKS)).not.toContain('MOM_SCORE');
    expect(Object.keys(APPLIERS)).not.toContain('DROP_EXPLAIN');
  });

  it('scanTargets 沒有候選股（排名 6～10 不再掃）', async () => {
    const d = await freshDb();
    try {
      await d.db.prepare("INSERT INTO rankings (session, ord, detail, created_at) VALUES ('2026-11-27', ?, '{}', 'x')").bind(JSON.stringify(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K'])).run();
      const t = await scanTargets(d.db, { own: { NVDA: {} }, rule: { heldMom: ['A', 'B'] }, lots: { mom: { A: 5, C: 3 } } });
      expect(t).toEqual([
        { ticker: 'NVDA', role: 'OWN' },
        { ticker: 'A', role: 'MOM' },
        { ticker: 'B', role: 'MOM' },
        { ticker: 'C', role: 'MOM' },
      ]);
    } finally {
      await d.dispose();
    }
  });
});

// ---------------------------------------------------------------- 運作統計

describe('T32d：運作統計的 F1 法庭（§3.7）', () => {
  it('開了幾次法庭（依代碼）、否決、沿用、沒有結論、晚到；累積滿 5 次與之後每滿 5 次提示看否決紀錄', async () => {
    const d = await freshDb();
    try {
      const db = d.db;
      const run = (id: string, at: string, hits: unknown[], status: string, st: string | null) =>
        db.prepare("INSERT INTO ai_runs (run_id, fn, ticker, as_of, created_at, status, prompt_version, pack_hash, pack, outcome) VALUES (?, 'MOM_ENTRY', 'MU', ?, ?, ?, 'mom_entry_v2', 'h', ?, ?)").bind(id, at.slice(0, 10), at, status, JSON.stringify({ rule: { detail: { hits } } }), st ? JSON.stringify({ status: st }) : null).run();
      const h = (code: string, o: Record<string, unknown> = {}) => ({ code, sub: 'x', byRule: false, ...o });
      await run('r1', '2026-11-27T23:40:00.000Z', [h('ACCOUNTING'), h('EARNINGS_DIVERGENCE'), h('REGULATORY', { basis: 'NEWS' }), h('PENDING_MA', { byRule: true })], 'DONE', 'AGREED');
      await run('r2', '2026-11-27T23:41:00.000Z', [h('ACCOUNTING')], 'DONE', 'TIMEOUT');
      await run('r3', '2026-11-28T01:30:00.000Z', [h('ONE_OFF_JUMP')], 'DONE', 'SPLIT');
      await run('r4', '2026-11-28T01:31:00.000Z', [h('ONE_OFF_JUMP')], 'PENDING', null);
      await run('r0', '2026-10-29T23:40:00.000Z', [h('ACCOUNTING')], 'DONE', 'AGREED'); // 期間外
      const rev = (month: string, ticker: string, o: Record<string, unknown>, at: string) =>
        db.prepare("INSERT INTO mom_reviews (month, ticker, rank, decision, reason_code, source, hits, run_id, carried_from, late_verdict, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?, '[]', ?, ?, ?, ?, ?)").bind(month, ticker, o.decision ?? 'ALLOW', o.code ?? null, o.source ?? 'RULE', o.run ?? null, o.carried ?? null, o.late ?? null, at, at).run();
      // 期間之前：4 次否決（一次是沿用、不算）
      for (const [k, t] of ['A', 'B', 'C', 'D'].entries()) await rev('2026-10', t, { decision: 'VETO', source: 'AI', run: `o${k}` }, '2026-09-29T23:40:00.000Z');
      await rev('2026-11', 'A', { decision: 'VETO', source: 'AI', run: 'o0', carried: '2026-10' }, '2026-10-29T23:40:00.000Z');
      // 期間內：1 次新否決（累積到 5）、1 次沿用的准許、1 次晚到的否決（累積到 6）、規則否決不算
      await rev('2026-12', 'MU', { decision: 'VETO', source: 'AI', run: 'r1', code: 'ACCOUNTING' }, '2026-11-27T23:40:00.000Z');
      await rev('2026-12', 'B', { decision: 'ALLOW', source: 'AI', run: 'o1', carried: '2026-10' }, '2026-11-27T23:40:00.000Z');
      await rev('2026-12', 'NVDA', { decision: 'ALLOW', source: 'AI', run: 'r9', late: 'VETO' }, '2026-11-30T23:40:00.000Z');
      await rev('2026-12', 'GE', { decision: 'VETO', source: 'RULE', code: 'PENDING_MA' }, '2026-11-27T23:40:00.000Z');
      const s = await momEntrySection(db, { from: '2026-11-01', to: '2026-11-30', fromSource: 'param' });
      expect(s.id).toBe('mom_entry');
      expect(s.rows).toEqual([
        { item: 'courts', code: null, n: 4, note: null },
        { item: 'courts_by_code', code: 'ACCOUNTING', n: 2, note: null },
        { item: 'courts_by_code', code: 'EARNINGS_DIVERGENCE', n: 1, note: null },
        { item: 'courts_by_code', code: 'ONE_OFF_JUMP', n: 2, note: null },
        { item: 'vetoes', code: null, n: 1, note: null },
        { item: 'carried', code: null, n: 1, note: null },
        { item: 'carried', code: 'ALLOW', n: 1, note: null },
        { item: 'no_conclusion', code: null, n: 1, note: null },
        { item: 'late', code: null, n: 1, note: null },
        { item: 'veto_total', code: null, n: 6, note: '累積 6 次否決：看一次否決的紀錄（網站「AI 紀錄」上方的「AI 否決的紀錄」），決定要不要留著 AI 的否決權' },
      ]);
      expect(VETO_HINT_EVERY).toBe(5);
      // 下一段期間沒有跨過 10：不提示
      const later = await momEntrySection(db, { from: '2026-12-01', to: '2026-12-31', fromSource: 'param' });
      expect(later.rows.find((r) => r.item === 'veto_total')).toEqual({ item: 'veto_total', code: null, n: 6, note: null });
      // 只到 10 月底：累積 4 次，還沒滿 5
      const early = await momEntrySection(db, { from: null, to: '2026-10-31', fromSource: 'none' });
      expect(early.rows.find((r) => r.item === 'veto_total')).toEqual({ item: 'veto_total', code: null, n: 4, note: null });
    } finally {
      await d.dispose();
    }
  });
});

// ---------------------------------------------------------------- 整條流程

/** 只放一個 CSV 的 zip（不壓縮）。 */
function storedZip(name: string, text: string): Uint8Array {
  const enc = new TextEncoder();
  const nm = enc.encode(name);
  const data = enc.encode(text);
  const local = new Uint8Array(30 + nm.length + data.length);
  const lv = new DataView(local.buffer);
  lv.setUint32(0, 0x04034b50, true);
  lv.setUint32(18, data.length, true);
  lv.setUint32(22, data.length, true);
  lv.setUint16(26, nm.length, true);
  local.set(nm, 30);
  local.set(data, 30 + nm.length);
  const cen = new Uint8Array(46 + nm.length);
  const cv = new DataView(cen.buffer);
  cv.setUint32(0, 0x02014b50, true);
  cv.setUint32(20, data.length, true);
  cv.setUint32(24, data.length, true);
  cv.setUint16(28, nm.length, true);
  cen.set(nm, 46);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, 1, true);
  ev.setUint16(10, 1, true);
  ev.setUint32(12, cen.length, true);
  ev.setUint32(16, local.length, true);
  const out = new Uint8Array(local.length + cen.length + end.length);
  out.set(local, 0);
  out.set(cen, local.length);
  out.set(end, local.length + cen.length);
  return out;
}
/** 兩次深回撤：-60%（2 個月回到高點）、-55%（3 個月）。 */
const FRENCH_CSV = 'This file was created by CMPT_ME_PRIOR_RETS\n\n,Mom\n200001,   0.00\n200002, -60.00\n200003, 150.00\n200004, -55.00\n200005,  50.00\n200006,  50.00\n\n Annual Factors\n2000, 1.0\n';

interface Net {
  line: string[];
  french: boolean;
}
function fetcherOf(w: World, net: Net): Fetcher {
  const base = fakeFetcher(w);
  return async (url, init) => {
    if (url === LINE_PUSH_URL) {
      net.line.push((JSON.parse(String(init?.body)) as { messages: { text: string }[] }).messages[0].text);
      return Response.json({});
    }
    if (url === 'https://api.example/fire') return Response.json({ claude_code_session_url: 'https://claude.ai/code/x' });
    if (/data\.sec\.gov\/submissions\/CIK(\d+)\.json/.test(url)) return Response.json({ cik: '1', name: 'SOME CORP', tickers: [], sic: '3674', formerNames: [], filings: { recent: { accessionNumber: [], form: [], items: [], acceptanceDateTime: [], filingDate: [], primaryDocument: [] } } });
    if (/companyfacts\/CIK\d+\.json/.test(url)) return Response.json({ cik: 1, facts: {} });
    if (/companyconcept\//.test(url)) return new Response('nf', { status: 404 });
    if (/nasdaq\.com\/feed\/rssoutbound/.test(url)) return new Response('<rss><channel></channel></rss>');
    if (url.startsWith('https://fred.stlouisfed.org/graph/fredgraph.csv')) return new Response(`observation_date,X\n2000-10-02,1.0\n2026-05-01,1.2\n${w.dataDate},1.5\n`);
    if (url === FRENCH_MOM_URL) return net.french ? new Response(storedZip('F-F_Momentum_Factor.CSV', FRENCH_CSV)) : new Response('nf', { status: 404 });
    return base(url, init);
  };
}

interface Ctx {
  db: D1Database;
  env: Env;
  net: Net;
  w: World;
  fetcher: Fetcher;
  run: (date: string, attempt?: Attempt) => ReturnType<typeof runFlow>;
}
const slotTime = (date: string, attempt: Attempt) => new Date(Date.parse(date + 'T23:30:00Z') + { FIRST: 0, MANUAL: 0, FINAL: 2, APPLY: 4 }[attempt] * 3600_000);

/** 自選 NVDA、動能 mom、核心 VOO。routine = false：雲端排程沒設定（AI 層不開）。 */
async function withWorld(fn: (c: Ctx) => Promise<void>, opt: { mom: string[]; routine?: boolean; french?: boolean; before?: (db: D1Database) => Promise<void> }) {
  const d = await freshDb();
  try {
    const db = d.db;
    const w = newWorld('2026-11-19');
    const net: Net = { line: [], french: opt.french ?? false };
    const env: Env = { DB: db, ADMIN_TOKEN: 't', AI_TASK_SECRET: 's', EDGAR_USER_AGENT: 'test bot test@example.com', SITE_URL: 'https://bot.example', LINE_CHANNEL_TOKEN: 'lt', LINE_USER_ID: 'U1', DEV_NO_AUTH: '1', ...(opt.routine === false ? {} : { ROUTINE_FIRE_URL: 'https://api.example/fire', ROUTINE_TOKEN: 'rt' }) };
    const fetcher = fetcherOf(w, net);
    const run = (date: string, attempt: Attempt = 'FIRST') => {
      if (attempt !== 'APPLY') w.dataDate = date;
      return runFlow(env, fetcher, { now: slotTime(date, attempt), attempt });
    };
    await run('2026-11-19');
    const { view } = buildMarketView(await loadSeries(db, ['VOO', 'SGOV', 'NVDA', ...opt.mom]), '2026-11-19', 'VOO');
    const acct = createAccount(
      {
        paper: true,
        cash: 5000,
        core: { VOO: Math.floor(140_000 / view.close.VOO[view.i]) },
        mom: Object.fromEntries(opt.mom.map((t) => [t, Math.floor(8000 / view.close[t][view.i])])),
        own: { NVDA: { shares: Math.floor(40_000 / view.close.NVDA[view.i]), stdWeight: 0.15, premises: [{ id: 'P1', text: '資料中心需求延續到 2027', origin: 'USER' }] } },
      },
      view,
    );
    await saveAccount(db, acct, null, '建立帳戶', new Date('2026-11-19T12:00:00Z'));
    if (opt.before) await opt.before(db);
    await fn({ db, env, net, w, fetcher, run });
  } finally {
    await d.dispose();
  }
}
const runsOf = async (db: D1Database, fn: string) => (await listRuns(db, new Date('2026-11-01T00:00:00Z'), { limit: 500 })).filter((r) => r.fn === fn);

describe('T32d：整條流程', () => {
  it('動能持股跌 20%：不開 AI；月報的「要看的事」有那一行（LINE 只有件數那一行、狀態文字沒有）；持股頁有那一行與事件；月報前一天不開擬事件打分', async () => {
    await withWorld(
      async ({ db, env, net, w, run }) => {
        await run('2026-11-20');
        w.shock.AAPL = { from: '2026-11-23', factor: 0.7 };
        for (const d of ['2026-11-23', '2026-11-24', '2026-11-25']) await run(d);
        // 月報前一天（11-27 是月報前一天的訊號日；11-30 出月報）
        await run('2026-11-27');
        expect(await runsOf(db, 'MOM_SCORE')).toEqual([]);
        expect((await loadReviews(db, '2026-12')).length).toBeGreaterThan(0); // 月報前一天的進場審查照常跑（雲端排程設定好了）
        await run('2026-11-27', 'FINAL');
        expect(await runsOf(db, 'DROP_EXPLAIN')).toEqual([]);
        net.line.length = 0;
        const m = await run('2026-11-30');
        await run('2026-11-30', 'FINAL');
        const acct = (await loadAccount(db))!.acct;
        const monthly = acct.notifs.find((n) => n.id === m.monthly)!;
        expect(await runsOf(db, 'DROP_EXPLAIN')).toEqual([]);
        expect((await listRuns(db, new Date('2026-11-01T00:00:00Z'), { limit: 500 })).filter((r) => r.ticker === 'AAPL')).toEqual([]); // 這一檔沒有任何 AI 執行
        const drop = monthly.attention!.find((x) => x.kind === 'DROP_21D')!;
        expect(drop).toMatchObject({ ticker: 'AAPL', src: 'mom', since: '2026-11-30' });
        expect(drop.text).toMatch(/^AAPL 最近 21 個交易日跌 \d+\.\d%：大盤 [+-]\d+\.\d%、產業（XLK）比大盤 [+-]\d+\.\d%、個股自身 -\d+\.\d%。這段期間沒有記到申報事件。動能的出場只看排名（目前/);
        expect(monthly.monthly!.input.attention).toEqual(monthly.attention);
        expect(monthly.text).not.toContain('AAPL 最近');
        expect(acct.mom.attnShown).toEqual({ AAPL: { DROP_21D: '2026-11-30' } });
        const push = net.line.find((t) => t.includes('2026-12 月報'))!;
        expect(push).toContain(`持股有 ${monthly.attention!.length} 件事要看（不用下單），在持股頁。`);
        expect(push).not.toContain('最近 21 個交易日');
        // 持股頁（真實模式）：動能那一塊有那一行
        const res = await handle(new Request('https://bot.example/api/holding/AAPL'), env, fakeFetcher(newWorld('2026-11-30')), new Date('2026-12-01T02:00:00Z'));
        const body = (await res.json()) as { mom: { attention: { kind: string; text: string }[]; events: unknown[] } | null };
        expect(body.mom!.attention.map((x) => x.kind)).toEqual(['DROP_21D']);
        expect(body.mom!.attention[0].text).toBe(drop.text);
        expect(body.mom!.events).toEqual([]);
        // 自選股的持股頁沒有動能那一塊
        const nv = (await (await handle(new Request('https://bot.example/api/holding/NVDA'), env, fakeFetcher(newWorld('2026-11-30')), new Date('2026-12-01T02:00:00Z'))).json()) as { mom: unknown };
        expect(nv.mom).toBeNull();
      },
      { mom: ['AAPL'] },
    );
  });

  it('持股頁的事件：最近 90 天（含只記錄的），日期、類別的中文、來源；進場時的附註', async () => {
    await withWorld(
      async ({ db, env, run }) => {
        await run('2026-11-20');
        const ins = db.prepare("INSERT INTO sec_events (ticker, accession, form, event_date, accepted_at, code, sub, by_rule, display_only, source, detail, status, created_at, detail_code) VALUES ('AAPL', ?, ?, ?, NULL, ?, ?, 0, 0, 'SCAN', 'd', 'INFO', 'x', ?)");
        await ins.bind('edgar:0000320193-26-000001', '8-K', '2026-11-03', 'GUIDANCE_CUT', 'SCAN_GUIDANCE_CUT', 'CUT').run();
        await ins.bind('nasdaq-rss:AAPL:2026-11-10', 'NEWS', '2026-11-10', 'MGMT_CHANGE', 'SCAN_MGMT_CHANGE', null).run();
        await ins.bind('edgar:0000320193-26-000000', '8-K', '2026-07-01', 'EARNINGS', 'SCAN_EARNINGS', null).run(); // 超過 90 天
        await db.prepare("INSERT INTO mom_reviews (month, ticker, rank, decision, source, hits, watch_reason, created_at, updated_at) VALUES ('2026-11', 'AAPL', 2, 'ALLOW_WATCH', 'RULE', '[]', '只有增資命中', 'x', 'x')").run();
        const res = await handle(new Request('https://bot.example/api/holding/AAPL'), env, fakeFetcher(newWorld('2026-11-20')), new Date('2026-11-21T02:00:00Z'));
        const body = (await res.json()) as { mom: { attention: { kind: string; text: string }[]; events: unknown[] } };
        expect(body.mom.events).toEqual([
          { date: '2026-11-10', label: '高層異動', source: '新聞標題' },
          { date: '2026-11-03', label: '財測下修', source: '8-K' },
        ]);
        expect(body.mom.attention).toEqual([{ ticker: 'AAPL', kind: 'ENTRY_NOTE', text: 'AAPL 進場時的附註：只有增資命中', since: '2026-11-01', src: 'mom' }]);
      },
      { mom: ['AAPL'] },
    );
  });

  it('策略檢討提醒在 AI 沒設定時也有歷史對照（LINE 收到的也有）；不開 AI', async () => {
    const voo = fakeParams('VOO').g;
    const laggard = ['AAPL', 'MSFT', 'AMZN', 'META', 'JPM', 'XOM', 'WMT', 'KO', 'PG', 'JNJ'].find((t) => fakeParams(t).g < voo - 1e-5)!;
    await withWorld(
      async ({ db, net, run }) => {
        net.line.length = 0;
        await run('2026-11-20');
        const acct = (await loadAccount(db))!.acct;
        const n = acct.notifs.find((x) => x.title === '策略檢討提醒')!;
        expect(n.text).toMatch(/\n歷史對照（French 動能因子，多空，只是近似）：同等深度（-2\d%）以上的回撤有 2 次，從高點到創新高的月數中位數是 2。$/);
        expect(await runsOf(db, 'STRATEGY_REVIEW')).toEqual([]);
        expect(net.line.find((t) => t.includes('策略檢討提醒'))).toContain('歷史對照（French 動能因子');
      },
      {
        mom: [laggard],
        routine: false,
        french: true,
        before: async (db) => {
          await db.prepare("INSERT INTO flow_state (key, value, updated_at) VALUES ('strategyReview', ?, 'x')").bind(JSON.stringify({ rel: 0.800001, peak: 1, eventStart: null, notified: [], yearsNotified: 0 })).run();
        },
      },
    );
  });

  it('每日抓價格時，動能持股的產業 ETF 也抓（跌幅拆解用）', async () => {
    await withWorld(
      async ({ db, env, fetcher }) => {
        await db.prepare("INSERT INTO flow_state (key, value, updated_at) VALUES ('sector:AAPL', 'XLE', 'x') ON CONFLICT(key) DO UPDATE SET value = 'XLE'").run();
        await ingest(env, fetcher, cronTime('2026-11-20'));
        expect((await loadSeries(db, ['XLE'])).get('XLE')?.d.length).toBeGreaterThan(0);
      },
      { mom: ['AAPL'] },
    );
  });

  it('月報引擎：舊月報留下的 notes 不再接到狀態文字（LINE 的狀態文字沒有大跌說明）', async () => {
    await withWorld(
      async ({ db }) => {
        const loaded = (await loadAccount(db))!;
        const { view } = buildMarketView(await loadSeries(db, ['VOO', 'SGOV', 'NVDA', 'AAPL']), '2026-11-19', 'VOO');
        const m = monthlyReport(loaded.acct, view, { order: ['AAPL'], month: '2026-12', ...({ notes: ['AAPL 最近一個月跌 25%'] } as object) });
        expect(m.notif.text).not.toContain('AAPL 最近一個月跌');
      },
      { mom: ['AAPL'] },
    );
  });
});
