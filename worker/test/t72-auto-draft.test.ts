// T72：自動草擬的時機（confirm_audit_design_2026-11-21 §5）、理由一鍵選（§6）、改寫證據包的 W 撞號（T71 回報的）。
// 完成條件：
//   七種觸發各自會自動開；有還沒回覆的乙類、30 天內有前提被判不成立時不開（手動照舊可以）
//   同一個鍵只開一次（隔天再跑不重開）；每檔 7 天 1 次（自動與手動共用）；一天最多 2 檔、第 3 檔排到隔天
//   自動開的不推 LINE；「要看的事」那一行的新文字；RISK_REPEAT 接上
//   一鍵理由每種通知各一個（選項填進理由、「其他」要打字、空的照舊擋）；W 不再撞號
// AI 的回覆一律是假的；對外請求全部是假的（EDGAR、RSS、雲端排程、LINE）。
import { describe, expect, it } from 'vitest';
import type { NewRiskItem } from '../src/ai/freshEyes';
import type { StartCtx } from '../src/app/aiCtx';
import { aiStep } from '../src/app/aiStep';
import type { Env, Fetcher } from '../src/app/env';
import { runFlow } from '../src/app/flow';
import { loadAccount, saveAccount } from '../src/app/ledgerStore';
import { LINE_PUSH_URL } from '../src/app/line';
import { DRAFT_AUTO_DAILY, loadDrafts, pushDraftLines, requestOwnDraft, startAutoDrafts, type DraftRow } from '../src/app/ownDraft';
import { startOwnCheck } from '../src/app/ownCheckAi';
import { reasonPicksOf, REASON_PICKS_DISAGREE, REASON_PICKS_SKIP } from '../src/app/site/explain';
import { notifView } from '../src/app/site/views';
import {
  DRAFT_TRIGGER_KINDS,
  OWN_ATTN,
  draftKeyOf,
  holdingAttention,
  ownAttention,
  reviewSplitsKey,
  toAttention,
  withDraftNotes,
  type AttnHit,
  type ThesisFile,
  type ThesisReview,
} from '../src/app/thesis';
import { buildMarketView } from '../src/data/marketView';
import { loadSeries } from '../src/data/store';
import { SYSTEM_DEFAULT_PREMISES, breakNotice, condMetNotice, createAccount, missingReasons, type Account, type Item, type MarketView, type Notif, type Premise } from '../src/engine';
import { handle } from '../src/index';
import { freshDb } from './helpers/d1';
import { cronTime, fakeFetcher, newWorld, type World } from './helpers/fakeSources';
import { scenarios } from './helpers/scenarios';
import { Sim } from './helpers/sim';

interface ReasonJs {
  REASON_OTHER: string;
  reasonOptions(picks: string[] | null, prefill?: string): string[];
  initialReason(options: string[], current?: string, prefill?: string): { pick: string | null; typed: string };
  reasonValue(pick: string | null, typed?: string): string;
  needsTyping(pick: string | null): boolean;
}
const RJ = (await import('../public/js/reason-pick.js' as string)) as ReasonJs;
const DJ = (await import('../public/js/thesis-draft.js' as string)) as { draftButtonState(state: unknown, now?: Date): { mode: string; text: string | null } };

const USER_PREMISES: Premise[] = [
  { id: 'P1', text: '資料中心需求延續到 2027', origin: 'USER' },
  { id: 'P2', text: 'HBM 供給持續吃緊', origin: 'USER' },
];

// ---------------------------------------------------------------- 假的世界（和 t55 相同：EDGAR、RSS、雲端排程、LINE）

const TENQ = { accession: '0001045810-26-000300', form: '10-Q', items: '', acceptanceDateTime: '2026-10-30T20:10:00.000Z', filingDate: '2026-10-30', primaryDocument: 'q.htm' };
const TENQ_HTML = '<html><body><p>Item 2. Management’s Discussion and Analysis of Financial Condition and Results of Operations</p><p>Revenue for the third quarter was $160 million, up 33% from a year ago.</p><p>Item 3. Quantitative and Qualitative Disclosures About Market Risk</p></body></html>';
const FACTS = { cik: 1045810, facts: { 'us-gaap': { Revenues: { units: { USD: [{ start: '2025-07-01', end: '2025-09-30', val: 120, accn: 'a1', form: '10-Q', filed: '2025-11-01' }, { start: '2026-07-01', end: '2026-09-30', val: 160, accn: 'a2', form: '10-Q', filed: '2026-10-30' }] } } } } };

interface Net {
  fire: number;
  line: string[];
}
function fetcherOf(w: World, net: Net): Fetcher {
  const base = fakeFetcher(w);
  return async (url, init) => {
    if (url === 'https://api.example/fire') {
      net.fire++;
      return Response.json({ claude_code_session_url: 'https://claude.ai/code/x' });
    }
    if (url === LINE_PUSH_URL) {
      net.line.push(String(init?.body ?? ''));
      return new Response('{}');
    }
    if (/data\.sec\.gov\/submissions\/CIK\d+\.json/.test(url)) return Response.json({ cik: '1045810', name: 'NVIDIA CORP', tickers: [], filings: { recent: { accessionNumber: [TENQ.accession], form: [TENQ.form], items: [TENQ.items], acceptanceDateTime: [TENQ.acceptanceDateTime], filingDate: [TENQ.filingDate], primaryDocument: [TENQ.primaryDocument] } } });
    if (/companyfacts\/CIK\d+\.json/.test(url)) return Response.json(FACTS);
    const doc = /Archives\/edgar\/data\/\d+\/(\d+)\/(.+)$/.exec(url);
    if (doc) return doc[2] === 'index.json' ? Response.json({ directory: { item: [{ name: TENQ.primaryDocument }] } }) : new Response(TENQ_HTML);
    if (url.startsWith('https://www.nasdaq.com/feed/rssoutbound') || url.startsWith('https://feeds.finance.yahoo.com/rss/2.0/headline')) return new Response('<rss><channel></channel></rss>');
    return base(url, init);
  };
}

interface Ctx {
  db: D1Database;
  env: Env;
  net: Net;
  fetcher: Fetcher;
  view: MarketView;
  axis: string[];
  call: <T = Record<string, unknown>>(method: 'GET' | 'POST', path: string, body: unknown, now: Date) => Promise<{ status: number; body: T }>;
}

/**
 * 2026-11-19 建立帳戶。tickers 都是自選（論點檔 <代號>@2026-11-19）；premises 給了就是使用者寫的前提（已有論點，新自選的那一次不開）。
 */
async function withWorld(fn: (c: Ctx) => Promise<void>, opt: { premises?: Premise[] | null; tickers?: string[] } = {}) {
  const d = await freshDb();
  try {
    const db = d.db;
    const w = newWorld('2026-11-19');
    const net: Net = { fire: 0, line: [] };
    const env: Env = { DB: db, ADMIN_TOKEN: 't', AI_TASK_SECRET: 's', EDGAR_USER_AGENT: 'test bot test@example.com', SITE_URL: 'https://bot.example', DEV_NO_AUTH: '1', ROUTINE_FIRE_URL: 'https://api.example/fire', ROUTINE_TOKEN: 'rt', LINE_CHANNEL_TOKEN: 'line', LINE_USER_ID: 'U1' };
    const fetcher = fetcherOf(w, net);
    await runFlow(env, fetcher, { now: cronTime('2026-11-19'), attempt: 'FIRST' });
    const tickers = opt.tickers ?? ['NVDA'];
    const { view, axis } = buildMarketView(await loadSeries(db, ['VOO', 'SGOV', ...tickers]), '2026-11-19', 'VOO');
    const premises = opt.premises === null ? SYSTEM_DEFAULT_PREMISES : (opt.premises ?? USER_PREMISES);
    const own = Object.fromEntries(tickers.map((t) => [t, { shares: Math.floor(20_000 / view.close[t][view.i]), stdWeight: 0.1, premises: structuredClone(premises) }]));
    const acct = createAccount({ paper: true, cash: 5000, core: { VOO: Math.floor(140_000 / view.close.VOO[view.i]) }, own }, view);
    await saveAccount(db, acct, null, '建立帳戶', new Date('2026-11-19T22:00:00Z'));
    // 已經寫了論點的（新自選的那一次不開）：照實際流程，前提 addedAt 是建立那天
    const call: Ctx['call'] = async (method, path, b, now) => {
      const r = await handle(new Request(`https://bot.example${path}`, { method, headers: { 'Content-Type': 'application/json' }, ...(b === undefined ? {} : { body: JSON.stringify(b) }) }), env, fetcher, now);
      return { status: r.status, body: (await r.json()) as never };
    };
    await fn({ db, env, net, fetcher, view, axis, call });
  } finally {
    await d.dispose();
  }
}

const acctOf = async (db: D1Database): Promise<Account> => (await loadAccount(db))!.acct;
async function mutate(db: D1Database, f: (a: Account) => Account | void) {
  const loaded = (await loadAccount(db))!;
  const a = structuredClone(loaded.acct);
  await saveAccount(db, f(a) ?? a, loaded, '測試', new Date('2026-11-19T23:00:00Z'));
}
const T0 = new Date('2026-11-20T01:00:00Z');
const at = (days: number, minutes = 0) => new Date(T0.getTime() + days * 86400_000 + minutes * 60_000);
const sessionOf = (days: number) => new Date(Date.parse('2026-11-19T00:00:00Z') + days * 86400_000).toISOString().slice(0, 10);
/** 第 days 天的每日流程開執行段（session 是那一天）。 */
async function startCtx(c: Ctx, days: number): Promise<StartCtx> {
  const session = sessionOf(days);
  return { env: c.env, fetcher: c.fetcher, acct: await acctOf(c.db), view: { ...c.view, date: session }, axis: c.axis, session, ov: {}, now: at(days), checks: [], res: { created: [], started: [], log: [], alerts: [] }, extras: {} };
}
async function runDay(c: Ctx, days: number): Promise<StartCtx> {
  const sc = await startCtx(c, days);
  await startAutoDrafts(sc);
  return sc;
}
const drafts = async (db: D1Database, t = 'NVDA'): Promise<DraftRow[]> => (await loadDrafts(db, t, 50)).reverse();
const keysOf = (r: DraftRow) => JSON.parse(r.attn_keys ?? 'null') as string[] | null;
/** 草稿結算（回來了／失敗）：直接改 own_drafts（結算本身在 t55 測過）。 */
const settle = (db: D1Database, runId: string, status: 'READY' | 'FAILED' | 'DISMISSED' | 'USED', when = at(0, 30)) =>
  db.prepare("UPDATE own_drafts SET status = ?, settled_at = ?, updated_at = ?, error = CASE WHEN ? = 'FAILED' THEN '測試：失敗' ELSE NULL END WHERE run_id = ?").bind(status, when.toISOString(), when.toISOString(), status, runId).run();

type Votes = Record<string, string[]>;
/** 直接寫一次有結論的定期審查（或減半檢視）：每條前提三票的判斷；risks 是新眼光通過檢查的風險。 */
async function seedReview(db: D1Database, id: string, asOf: string, votes: Votes, o: { fn?: string; risks?: Partial<NewRiskItem>[]; status?: string; ticker?: string } = {}) {
  const ids = Object.keys(votes);
  const samples = [0, 1, 2].map((k) => ({ index: k, valid: true, verdict: 'HOLD', premises: ids.map((p) => ({ premise_id: p, status: votes[p][k], evidence_ids: [] })) }));
  const outcome = { status: o.status ?? 'AGREED', verdict: 'HOLD', votes: { HOLD: 3 }, samples };
  const risks = o.risks ? JSON.stringify({ asked: true, returned: true, items: o.risks.map((r, k) => ({ k, ok: true, date: asOf, doc: { title: '10-Q', date: asOf, url: null, headline: false }, ...r })) }) : null;
  await db
    .prepare("INSERT INTO ai_runs (run_id, fn, ticker, as_of, created_at, status, prompt_version, pack_hash, pack, outcome, applied_at, new_risks) VALUES (?, ?, ?, ?, ?, 'DONE', 'own_review_v5', 'h', ?, ?, ?, ?)")
    .bind(id, o.fn ?? 'OWN_REVIEW', o.ticker ?? 'NVDA', asOf, `${asOf}T12:00:${String(id.length).padStart(2, '0')}.000Z`, JSON.stringify({ premises: ids.map((p) => ({ id: p, text: `t-${p}`, origin: 'USER' })), documents: [], facts: [] }), JSON.stringify(outcome), `${asOf}T12:30:00.000Z`, risks)
    .run();
}
const III = ['INSUFFICIENT', 'INSUFFICIENT', 'INSUFFICIENT'];
const HHH = ['HOLDS', 'HOLDS', 'HOLDS'];
const BBB = ['BROKEN', 'BROKEN', 'BROKEN'];
const RISK = { source_id: 'edgar:0001045810-26-000300', quote: 'Our three largest customers accounted for 61% of revenue', text: '營收集中在三家客戶' };

/** 每一種觸發怎麼做出來（一個世界裡只有這一種成立）。 */
const SETUPS: Record<(typeof DRAFT_TRIGGER_KINDS)[number], { days: number; premises?: Premise[] | null; setup(c: Ctx): Promise<void>; key: (k: string) => boolean }> = {
  HALF_NO_EXIT: {
    days: 1,
    setup: (c) => mutate(c.db, (a) => void (a.rule.own.NVDA.applied = 'HALF')),
    key: (k) => k === 'HALF_NO_EXIT@2026-11-19',
  },
  RISK_REPEAT: {
    days: 1,
    setup: async (c) => {
      await seedReview(c.db, 'r-a', '2026-11-19', { P1: HHH, P2: HHH }, { risks: [RISK] });
      await seedReview(c.db, 'r-bb', '2026-11-20', { P1: HHH, P2: HHH }, { fn: 'OWN_DROP', risks: [{ ...RISK, quote: `  ${RISK.quote} ` }] });
    },
    key: (k) => /^RISK_REPEAT:[0-9a-z]+$/.test(k),
  },
  PREMISE_UNVERIFIED: {
    days: 1,
    setup: async (c) => {
      for (const id of ['r-1', 'r-22', 'r-333']) await seedReview(c.db, id, '2026-11-19', { P1: III, P2: HHH });
    },
    key: (k) => k === 'PREMISE_UNVERIFIED:P1@r-1',
  },
  PREMISE_NO_DATA: {
    days: 1,
    setup: (c) => seedReview(c.db, 'r-1', '2026-11-19', { P1: III, P2: HHH }),
    key: (k) => k === 'PREMISE_NO_DATA:P1',
  },
  NO_CONSENSUS: {
    days: 1,
    setup: async (c) => {
      await c.db.prepare('INSERT INTO flow_state (key, value, updated_at) VALUES (?, ?, ?)').bind(reviewSplitsKey('NVDA'), JSON.stringify({ count: 3, fileId: 'NVDA@2026-11-19', first: 'r-s1', reachedAt: '2026-11-19' }), '2026-11-19T12:00:00Z').run();
    },
    key: (k) => k === 'NO_CONSENSUS@r-s1',
  },
  NO_THESIS: {
    // 新自選的那一次負責開檔 7 天內；過了 7 天還只有系統預設前提（那一次沒有跑成）→ NO_THESIS
    days: 8,
    premises: null,
    setup: async () => {},
    key: (k) => k === 'NO_THESIS',
  },
  THESIS_OLD: {
    days: 1,
    setup: (c) =>
      mutate(c.db, (a) => {
        for (const p of a.own.NVDA.premises) p.addedAt = '2025-06-01';
      }),
    key: (k) => k === 'THESIS_OLD@2026-06-01',
  },
};

// ---------------------------------------------------------------- §5 時機

describe('T72 七種觸發各自會自動開（§5）', () => {
  for (const kind of DRAFT_TRIGGER_KINDS) {
    it(`${kind}：當天的每日流程自動開一次草稿（AUTO、記下觸發的鍵）`, async () => {
      const s = SETUPS[kind];
      await withWorld(
        async (c) => {
          await s.setup(c);
          const sc = await runDay(c, s.days);
          const rows = await drafts(c.db);
          expect(rows).toHaveLength(1);
          expect(rows[0]).toMatchObject({ trigger: 'AUTO', status: 'PENDING', file_id: 'NVDA@2026-11-19' });
          const keys = keysOf(rows[0])!;
          expect(keys).toHaveLength(1);
          expect(s.key(keys[0]), keys[0]).toBe(true);
          expect(sc.res.started).toEqual([rows[0].run_id]);
          expect(sc.res.log.some((l) => l.includes('自動草擬論點') && l.startsWith('NVDA：'))).toBe(true);
        },
        { premises: s.premises === undefined ? USER_PREMISES : s.premises },
      );
    });
  }

  it('每日流程（aiStep）裡也會開：放在新自選的那一次之後', async () => {
    await withWorld(async (c) => {
      await seedReview(c.db, 'r-1', '2026-11-19', { P1: III, P2: HHH });
      const res = await aiStep(c.env, c.fetcher, T0, '2026-11-19', {}, true);
      const rows = await drafts(c.db);
      expect(rows.map(keysOf)).toEqual([['PREMISE_NO_DATA:P1']]);
      expect(res.started).toContain(rows[0].run_id);
    });
  });
});

describe('T72 不自動開的情況（§5）；手動照舊可以', () => {
  it('有還沒回覆的乙類通知 → 不開；使用者自己按照舊可以', async () => {
    await withWorld(async (c) => {
      await seedReview(c.db, 'r-1', '2026-11-19', { P1: III, P2: HHH });
      await mutate(c.db, (a) => breakNotice(a, c.view, 'NVDA', { tier: 'HALF', premiseId: 'P2', basis: '10-Q 2026-10-30' }).acct);
      const sc = await runDay(c, 1);
      expect(await drafts(c.db)).toEqual([]);
      expect(sc.res.log.some((l) => l.startsWith('NVDA：前提最近一次審查 3 票都是證據不足，但有還沒回覆的乙類通知') && l.endsWith('不自動草擬論點'))).toBe(true);
      const r = await requestOwnDraft(c.env, c.fetcher, await acctOf(c.db), { ...c.view, date: sessionOf(1) }, c.axis, 'NVDA', at(1, 5));
      expect(r.failed).toBeNull();
      expect((await drafts(c.db)).map((d) => [d.trigger, d.attn_keys])).toEqual([['MANUAL', null]]);
    });
  });

  it('最近 30 個日曆天內有前提被判不成立 → 不開（手動照舊可以）；滿 31 天、觸發還在就開', async () => {
    await withWorld(async (c) => {
      // 11-19 的審查：P2 三票不成立、P1 三票證據不足（PREMISE_NO_DATA 成立）
      await seedReview(c.db, 'r-1', '2026-11-19', { P1: III, P2: BBB });
      const sc = await runDay(c, 30);
      expect(await drafts(c.db)).toEqual([]);
      expect(sc.res.log).toContain('NVDA：前提最近一次審查 3 票都是證據不足，但 2026-11-19 的審查判前提 P2 不成立（30 天內），不自動草擬論點');
      const later = await runDay(c, 31);
      expect((await drafts(c.db)).map(keysOf)).toEqual([['PREMISE_NO_DATA:P1']]);
      expect(later.res.started).toHaveLength(1);
    });
    await withWorld(async (c) => {
      await seedReview(c.db, 'r-1', '2026-11-19', { P1: III, P2: BBB });
      await runDay(c, 1);
      expect(await drafts(c.db)).toEqual([]);
      await requestOwnDraft(c.env, c.fetcher, await acctOf(c.db), { ...c.view, date: sessionOf(1) }, c.axis, 'NVDA', at(1, 5));
      expect((await drafts(c.db)).map((d) => d.trigger)).toEqual(['MANUAL']);
    });
  });
});

describe('T72 頻率（§5）', () => {
  it('同一個鍵只自動開一次：隔天再跑不重開；草稿回來、你不用了，滿 7 天也不重開；失敗的重試一次', async () => {
    await withWorld(async (c) => {
      await seedReview(c.db, 'r-1', '2026-11-19', { P1: III, P2: HHH });
      await runDay(c, 1);
      const [d1] = await drafts(c.db);
      await settle(c.db, d1.run_id, 'READY');
      const next = await runDay(c, 2);
      expect(await drafts(c.db)).toHaveLength(1);
      expect(next.res.started).toEqual([]);
      await settle(c.db, d1.run_id, 'DISMISSED', at(3));
      const week = await runDay(c, 10);
      expect(await drafts(c.db)).toHaveLength(1);
      expect(week.res.log.some((l) => l.includes('NVDA：'))).toBe(false);
    });
    await withWorld(async (c) => {
      await seedReview(c.db, 'r-1', '2026-11-19', { P1: III, P2: HHH });
      await runDay(c, 1);
      await settle(c.db, (await drafts(c.db))[0].run_id, 'FAILED');
      await runDay(c, 2); // 失敗的不算 7 天一次，隔天重試一次
      const rows = await drafts(c.db);
      expect(rows.map((r) => keysOf(r))).toEqual([['PREMISE_NO_DATA:P1'], ['PREMISE_NO_DATA:P1']]);
      await settle(c.db, rows[1].run_id, 'FAILED');
      await runDay(c, 3);
      expect(await drafts(c.db)).toHaveLength(2);
    });
  });

  it('每檔 7 個日曆天最多 1 次，自動與手動共用：手動草擬之後 7 天內不自動開；滿 7 天才開', async () => {
    await withWorld(async (c) => {
      await requestOwnDraft(c.env, c.fetcher, await acctOf(c.db), c.view, c.axis, 'NVDA', at(0));
      const [m] = await drafts(c.db);
      await settle(c.db, m.run_id, 'DISMISSED');
      await seedReview(c.db, 'r-1', '2026-11-20', { P1: III, P2: HHH });
      const sc = await runDay(c, 3);
      expect((await drafts(c.db)).map((d) => d.trigger)).toEqual(['MANUAL']);
      expect(sc.res.log).toContain('NVDA：前提最近一次審查 3 票都是證據不足，11/20 已經草擬過（每檔 7 天最多一次），之後還成立再自動開');
      await runDay(c, 7);
      expect((await drafts(c.db)).map((d) => d.trigger)).toEqual(['MANUAL', 'AUTO']);
      // 反過來：自動開過的 7 天內，使用者按 → 409
      await settle(c.db, (await drafts(c.db))[1].run_id, 'READY', at(7, 30));
      await expect(requestOwnDraft(c.env, c.fetcher, await acctOf(c.db), { ...c.view, date: sessionOf(9) }, c.axis, 'NVDA', at(9))).rejects.toMatchObject({ status: 409 });
    });
  });

  it(`同一天最多自動開 ${DRAFT_AUTO_DAILY} 檔（照優先順序），第 3 檔排到隔天`, async () => {
    await withWorld(
      async (c) => {
        // NVDA 論點滿一年（最不急）、MU 減半中沒有出場條件（最急）、AMD 前提證據不足
        await mutate(c.db, (a) => {
          for (const p of a.own.NVDA.premises) p.addedAt = '2025-06-01';
          a.rule.own.MU.applied = 'HALF';
        });
        await seedReview(c.db, 'r-amd', '2026-11-19', { P1: III, P2: HHH }, { ticker: 'AMD' });
        const d1 = await runDay(c, 1);
        expect((await drafts(c.db, 'MU')).map(keysOf)).toEqual([['HALF_NO_EXIT@2026-11-19']]);
        expect((await drafts(c.db, 'AMD')).map(keysOf)).toEqual([['PREMISE_NO_DATA:P1']]);
        expect(await drafts(c.db, 'NVDA')).toEqual([]);
        expect(d1.res.started).toHaveLength(2);
        expect(d1.res.log).toContain('NVDA：論點滿一年，今天已經自動草擬 2 檔，排到之後的日子');
        // 同一天再跑一次（手動的每日流程）也不會多開
        await runDay(c, 1);
        expect(await drafts(c.db, 'NVDA')).toEqual([]);
        const d2 = await runDay(c, 2);
        expect((await drafts(c.db, 'NVDA')).map(keysOf)).toEqual([['THESIS_OLD@2026-06-01']]);
        expect(d2.res.started).toHaveLength(1);
      },
      { tickers: ['NVDA', 'MU', 'AMD'] },
    );
  });
});

describe('T72 自動開的不推 LINE（§5）；草稿回來照舊列 DRAFT_READY', () => {
  it('自動開的回來了不推；使用者按的照舊推一行', async () => {
    await withWorld(async (c) => {
      await seedReview(c.db, 'r-1', '2026-11-19', { P1: III, P2: HHH });
      await runDay(c, 1);
      const [auto] = await drafts(c.db);
      await settle(c.db, auto.run_id, 'READY', at(1, 30));
      expect(await pushDraftLines(c.env, c.fetcher, at(1, 40))).toEqual({ sent: 0, failed: 0, errors: [] });
      expect(c.net.line).toEqual([]);
      // 「要看的事」列 DRAFT_READY
      const att = await holdingAttention(c.db, await acctOf(c.db), { ...c.view, date: sessionOf(1) }, 'NVDA');
      expect(att.map((x) => x.kind)).toContain('DRAFT_READY');
      // 對照：使用者按的（8 天後）回來了會推
      await settle(c.db, auto.run_id, 'DISMISSED', at(2));
      await requestOwnDraft(c.env, c.fetcher, await acctOf(c.db), { ...c.view, date: sessionOf(9) }, c.axis, 'NVDA', at(9));
      const manual = (await drafts(c.db))[1];
      await settle(c.db, manual.run_id, 'READY', at(9, 30));
      expect((await pushDraftLines(c.env, c.fetcher, at(9, 40))).sent).toBe(1);
      expect(c.net.line).toHaveLength(1);
    });
  });
});

describe('T72 「要看的事」那一行（§5）', () => {
  it('自動開了 → 「<事實>。已經請 stock bot 草擬（M/D），好了會列在這裡」，帶 drafted（網站不放按鈕）；好了照舊；失敗了改回原本的寫法', async () => {
    await withWorld(async (c) => {
      await seedReview(c.db, 'r-1', '2026-11-19', { P1: III, P2: HHH });
      const view = { ...c.view, date: sessionOf(1) };
      const before = (await holdingAttention(c.db, await acctOf(c.db), view, 'NVDA')).find((x) => x.kind === 'PREMISE_NO_DATA')!;
      expect(before.text).toContain('也可以改寫成查得到的事');
      expect(before.drafted).toBeUndefined();
      await runDay(c, 1);
      const [d] = await drafts(c.db);
      const asked = (await holdingAttention(c.db, await acctOf(c.db), view, 'NVDA')).find((x) => x.kind === 'PREMISE_NO_DATA')!;
      expect(asked.text).toBe('NVDA 的前提 P1「資料中心需求延續到 2027」最近一次審查 3 票都是證據不足。已經請 stock bot 草擬（11/21），好了會列在這裡');
      expect(asked.drafted).toBe(d.created_at);
      await settle(c.db, d.run_id, 'READY', at(1, 30));
      const ready = await holdingAttention(c.db, await acctOf(c.db), view, 'NVDA');
      expect(ready.find((x) => x.kind === 'PREMISE_NO_DATA')!.text).toContain('已經請 stock bot 草擬（11/21）');
      expect(ready.some((x) => x.kind === 'DRAFT_READY')).toBe(true);
      await settle(c.db, d.run_id, 'FAILED', at(1, 40));
      const failed = (await holdingAttention(c.db, await acctOf(c.db), view, 'NVDA')).find((x) => x.kind === 'PREMISE_NO_DATA')!;
      expect(failed.text).toBe(before.text);
      expect(failed.drafted).toBeUndefined();
    });
  });

  it('每一種的事實部分（拿掉要你去做的那半句）；月報存的也一樣（toAttention 帶 drafted）', () => {
    const rec = { runId: 'r', keys: [] as string[], at: '2026-11-20T23:30:00.000Z', status: 'PENDING' };
    const hit = (kind: string, key: string, text: string, since = '2026-11-19'): AttnHit => ({ ticker: 'MU', kind, src: 'own', key, every: null, since, text });
    const cases: [AttnHit, string][] = [
      [hit('NO_CONSENSUS', 'NO_CONSENSUS@s', 'MU 最近 3 次審查都沒有一致結論，論點可能寫得不夠具體，可以拿去討論'), 'MU 最近 3 次審查都沒有一致結論'],
      [hit('PREMISE_UNVERIFIED', 'PREMISE_UNVERIFIED:P1@s', 'MU 的前提 P1「x」已經連續 3 次審查都沒驗到：這一條一直查不到，可以改寫、配一個查得到的指標，或改標成信念'), 'MU 的前提 P1「x」已經連續 3 次審查都沒驗到'],
      [hit('HALF_NO_EXIT', 'HALF_NO_EXIT', 'MU 減半中：站回 200 日均線之前規則不會再有動作，而你沒有定任何出場條件'), 'MU 減半中：站回 200 日均線之前規則不會再有動作，而你沒有定任何出場條件'],
      [hit('THESIS_OLD', 'THESIS_OLD', 'MU 的論點是 2025-11-20 寫的，已經一年沒有更新', '2026-11-20'), 'MU 的論點是 2025-11-20 寫的，已經一年沒有更新'],
      [hit('NO_THESIS', 'NO_THESIS', 'MU 還沒有你的論點，目前用系統預設前提檢查'), 'MU 還沒有你的論點，目前用系統預設前提檢查'],
    ];
    for (const [x, fact] of cases) {
      const [y] = withDraftNotes([x], { autoDrafts: [{ ...rec, keys: [draftKeyOf(x)] }] });
      expect(y.text).toBe(`${fact}。已經請 stock bot 草擬（11/21），好了會列在這裡`);
      expect(toAttention(y).drafted).toBe(rec.at);
    }
    // 鍵：論點滿一年、減半中帶 @<從哪天起>
    expect(draftKeyOf(cases[3][0])).toBe('THESIS_OLD@2026-11-20');
    expect(draftKeyOf(cases[2][0])).toBe('HALF_NO_EXIT@2026-11-19');
    expect(draftKeyOf(cases[0][0])).toBe('NO_CONSENSUS@s');
    // 不是觸發的種類不動
    const other = hit('COND_NEAR', 'COND_NEAR:1@q', 'x');
    expect(withDraftNotes([other], { autoDrafts: [{ ...rec, keys: ['COND_NEAR:1@q'] }] })).toEqual([other]);
  });
});

describe('T72 持股頁的草稿狀態：「要看的事」觸發的不寫「新加進自選」', () => {
  it('準備中的自動草稿帶 attn（有 attn_keys 的）；網站那句話照它寫', async () => {
    await withWorld(async (c) => {
      await seedReview(c.db, 'r-1', '2026-11-19', { P1: III, P2: HHH });
      await runDay(c, 1);
      const r = await c.call<{ state: { pending: { trigger: string; attn?: boolean } } }>('GET', '/api/own/NVDA/draft', undefined, at(1, 5));
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.state.pending).toMatchObject({ trigger: 'AUTO', attn: true });
      const v = DJ.draftButtonState({ ready: null, last: null, lastAt: null, nextAt: null, autoSoon: false, aiReady: true, pending: { runId: 'x', trigger: 'AUTO', createdAt: '2026-11-20T23:31:00Z', attn: true } });
      expect(v.text!.startsWith('為了「要看的事」裡列的事，stock bot 正在自動草擬（')).toBe(true);
      expect(v.text).not.toContain('新加進自選');
    });
  });
});

describe('T72 RISK_REPEAT 接上（§4、§5）', () => {
  const review = (runId: string, date: string, items: Partial<NewRiskItem>[], fn = 'OWN_REVIEW'): ThesisReview => ({
    runId,
    date,
    fn,
    label: '定期審查',
    trigger: null,
    status: 'AGREED',
    verdict: 'HOLD',
    votes: {},
    brokenPremises: [],
    notif: null,
    response: null,
    premiseVotes: {},
    summary: null,
    newRisks: items.map((x, k) => ({ k, ok: true, date, source_id: RISK.source_id, quote: RISK.quote, text: RISK.text, ...x })) as NewRiskItem[],
  });
  const fileOf = (reviews: ThesisReview[], o: Partial<ThesisFile> = {}): ThesisFile =>
    ({ ticker: 'NVDA', fileId: 'NVDA@2026-06-01', openedAt: '2026-06-01', kind: 'THESIS', premises: [{ id: 'P1', text: '資料中心需求延續到 2027', origin: 'USER', lastCheck: null, splitAfter: false }], conditions: [], events: [], reviews, log: [], disputes: [], flags: [], ...o }) as unknown as ThesisFile;
  const K = OWN_ATTN.find((k) => k.kind === 'RISK_REPEAT')!;
  const det = (f: ThesisFile, date = '2026-11-20') => K.detect({ file: f, meta: {} as never, acct: {} as never, view: { date } });

  it('兩次不同的審查引用同一段原文 → 一件（第二次的日期起）；只出現一次、不同原文、和前提重疊、超過 180 天的不算', () => {
    const two = fileOf([review('r2', '2026-11-10', [{}]), review('r1', '2026-08-10', [{}])]);
    const [x] = det(two);
    expect(x).toMatchObject({ since: '2026-11-10', every: null, text: 'NVDA 的 AI 審查兩次引用同一段原文，提到一件你的前提沒有涵蓋的事：營收集中在三家客戶' });
    expect(x.key).toMatch(/^RISK_REPEAT:[0-9a-z]+$/);
    // 第三次出現還是同一件（同一個鍵）
    expect(det(fileOf([review('r3', '2026-11-19', [{}]), ...two.reviews]))[0].key).toBe(x.key);
    expect(det(fileOf([review('r1', '2026-11-10', [{}])]))).toEqual([]);
    expect(det(fileOf([review('r2', '2026-11-10', [{ quote: 'Another sentence entirely' }]), review('r1', '2026-08-10', [{}])]))).toEqual([]);
    expect(det(fileOf(two.reviews, { premises: [{ id: 'P3', text: '營收集中在三家客戶', origin: 'USER' }] as never }))).toEqual([]);
    expect(det(two, '2027-02-10')).toEqual([]); // 08-10 那次超過 180 天
  });

  it('新風險本身不列「要看的事」：只在已經請 stock bot 草擬（準備中或好了）時列出那一行', () => {
    const f = fileOf([review('r2', '2026-11-10', [{}]), review('r1', '2026-08-10', [{}])]);
    const acct = { own: { NVDA: { premises: [], flags: [] } }, rule: { own: {} }, notifs: [] } as never;
    expect(ownAttention([f], acct, { date: '2026-11-20' }).filter((x) => x.kind === 'RISK_REPEAT')).toEqual([]);
    const key = det(f)[0].key;
    const asked = ownAttention([{ ...f, autoDrafts: [{ runId: 'd', keys: [key], at: '2026-11-20T23:30:00Z', status: 'PENDING' }] }], acct, { date: '2026-11-20' }).filter((x) => x.kind === 'RISK_REPEAT');
    expect(asked.map((x) => x.text)).toEqual(['NVDA 的 AI 審查兩次引用同一段原文，提到一件你的前提沒有涵蓋的事：營收集中在三家客戶。已經請 stock bot 草擬（11/21），好了會列在這裡']);
    expect(ownAttention([{ ...f, autoDrafts: [{ runId: 'd', keys: [key], at: '2026-11-20T23:30:00Z', status: 'DISMISSED' }] }], acct, { date: '2026-11-20' }).filter((x) => x.kind === 'RISK_REPEAT')).toEqual([]);
  });
});

// ---------------------------------------------------------------- §6 理由一鍵選

/** 網站的流程：從伺服器給的選項點一個（或選「其他」打字）→ 送出的理由。 */
function pickReason(it: { reasonPicks: string[] | null; reasonText?: { prefill: string } | null }, pick: string | null, typed = ''): string {
  const opts = RJ.reasonOptions(it.reasonPicks, it.reasonText?.prefill ?? '');
  if (pick !== null) expect(opts).toContain(pick);
  return RJ.reasonValue(pick, typed);
}

/** 每種通知共用的檢查：選項的字、點選項 → 理由、「其他」要打字、空的照舊擋。 */
function checkReasons(n: Notif, it: Item, picks: readonly string[]) {
  expect(reasonPicksOf(it)).toEqual([...picks]);
  const view = { reasonPicks: reasonPicksOf(it), reasonText: null };
  expect(RJ.reasonOptions(view.reasonPicks)).toEqual([...picks, '其他']);
  const skip = { mode: 'DO' as const, choices: { [it.key]: 'SKIP' as const } };
  // 點一個選項：選項的字就是理由，送得出去
  const chosen = pickReason(view, picks[1]);
  expect(chosen).toBe(picks[1]);
  expect(missingReasons(n, { ...skip, reasons: { [it.key]: chosen } })).toEqual([]);
  // 選「其他」沒打字 → 空的，照舊擋；打了字就可以
  expect(RJ.needsTyping('其他')).toBe(true);
  expect(RJ.needsTyping(picks[0])).toBe(false);
  expect(missingReasons(n, { ...skip, reasons: { [it.key]: pickReason(view, '其他', '   ') } }).map((x) => x.key)).toEqual([it.key]);
  expect(missingReasons(n, { ...skip, reasons: { [it.key]: pickReason(view, '其他', '我自己的理由') } })).toEqual([]);
  // 什麼都沒點 → 空的，照舊擋
  expect(missingReasons(n, { ...skip, reasons: { [it.key]: pickReason(view, null) } }).map((x) => x.key)).toEqual([it.key]);
}

const ready = (acct: Account, view: MarketView) => ({ mode: 'real', acct, view, axis: [], rankOrder: [], rankSession: null, aiNotes: [], events: [], shadow: [], today: view.date, warnings: [] }) as never;

describe('T72 理由一鍵選（§6）', () => {
  it('選項的字（設計原文）；「其他」在最後；一開始的選法（改決定之後再回覆、崩盤的先填）', () => {
    expect([...REASON_PICKS_SKIP, '其他']).toEqual(['價格已經反映', '想再觀察一陣子', '這檔對我有其他用途（避險、配置）', '其他']);
    expect([...REASON_PICKS_DISAGREE, '其他']).toEqual(['我認為這條前提還成立', '報導不可信', '想等下一份財報', '其他']);
    const opts = RJ.reasonOptions([...REASON_PICKS_SKIP]);
    expect(RJ.initialReason(opts)).toEqual({ pick: null, typed: '' });
    expect(RJ.initialReason(opts, '想再觀察一陣子')).toEqual({ pick: '想再觀察一陣子', typed: '' });
    expect(RJ.initialReason(opts, '自己寫的')).toEqual({ pick: '其他', typed: '自己寫的' });
    const crash = RJ.reasonOptions([...REASON_PICKS_SKIP], '照 AI 檢視：延後');
    expect(crash[0]).toBe('照 AI 檢視：延後');
    expect(RJ.initialReason(crash, '', '照 AI 檢視：延後')).toEqual({ pick: '照 AI 檢視：延後', typed: '' });
    expect(RJ.reasonOptions(null)).toEqual([]);
  });

  it('甲類「這次不做」：一鍵選項填進理由並寫進論點檔', async () => {
    await withWorld(async (c) => {
      await mutate(c.db, (a) => condMetNotice(a, c.view, 'NVDA', { id: 1, text: '毛利率連兩季低於 55%', action: 'EXIT', setAt: '2026-11-19', aiProposed: false, why: '測試' }).acct);
      const n = (await acctOf(c.db)).notifs.at(-1)!;
      const it = n.items.find((x) => x.kind === 'OWN_COND')!;
      expect(it.reasonRequired).toBe(true);
      checkReasons(n, it, REASON_PICKS_SKIP);
      const iv = notifView(ready(await acctOf(c.db), c.view), n).items.find((x) => x.key === it.key)!;
      expect(iv.reasonPicks).toEqual([...REASON_PICKS_SKIP]);
      // 空的照舊擋（伺服器）
      expect((await c.call('POST', `/api/notif/${n.id}/respond`, { mode: 'DO', choices: { [it.key]: 'SKIP' }, reasons: {} }, at(0))).status).toBe(422);
      const r = await c.call('POST', `/api/notif/${n.id}/respond`, { mode: 'DO', choices: { [it.key]: 'SKIP' }, reasons: { [it.key]: pickReason(iv, '價格已經反映') } }, at(0));
      expect(r.status).toBe(200);
      const log = (await c.db.prepare("SELECT body FROM own_thesis_log WHERE kind = 'RESPONSE'").all<{ body: string }>()).results.map((x) => JSON.parse(x.body) as Record<string, unknown>);
      expect(log).toEqual([expect.objectContaining({ type: 'A', outcome: 'SKIPPED', reason: '價格已經反映' })]);
    });
  });

  it('乙類「不同意，不動」：不同意的三個選項；選了寫進論點檔、照舊進靜默期', async () => {
    await withWorld(async (c) => {
      await mutate(c.db, (a) => breakNotice(a, c.view, 'NVDA', { tier: 'HALF', premiseId: 'P2', basis: '10-Q 2026-10-30' }).acct);
      const n = (await acctOf(c.db)).notifs.at(-1)!;
      const it = n.items.find((x) => x.brk?.type === 'B')!;
      checkReasons(n, it, REASON_PICKS_DISAGREE);
      const iv = notifView(ready(await acctOf(c.db), c.view), n).items.find((x) => x.key === it.key)!;
      expect(iv.reasonPicks).toEqual([...REASON_PICKS_DISAGREE]);
      const r = await c.call('POST', `/api/notif/${n.id}/respond`, { mode: 'DO', choices: { [it.key]: 'SKIP' }, reasons: { [it.key]: pickReason(iv, '報導不可信') } }, at(0));
      expect(r.status).toBe(200);
      const log = (await c.db.prepare("SELECT body FROM own_thesis_log WHERE kind = 'RESPONSE'").all<{ body: string }>()).results.map((x) => JSON.parse(x.body) as Record<string, unknown>);
      expect(log).toEqual([expect.objectContaining({ type: 'B', outcome: 'DISAGREE', reason: '報導不可信' })]);
      expect((await acctOf(c.db)).own.NVDA.disputes?.map((x) => x.premiseId)).toEqual(['P2']);
    });
  });

  // T80（階段十二，allocation_redesign §1.6）：月報不再產生崩盤項目（F5／F6），原本這裡崩盤項目的那一半（理由選項、
  // AI 說延後時先選好、選項的字存進 coreOwe）拿掉了；慢規則減半的照舊
  it('慢規則減半的「這次不做」：這次不做的三個選項；選項的字存成那一項的理由', () => {
    const sc = scenarios.s3();
    const sim = new Sim(sc.market, sc.init);
    sim.runUntil('2027-01-04');
    const jan = sim.preOpen()!;
    const f7 = jan.items.find((i) => i.f === 'F7' && i.kind === 'OWN_RULE')!;
    expect(jan.items.some((i) => i.f === 'F5' || i.f === 'F6')).toBe(false);
    checkReasons(jan, f7, REASON_PICKS_SKIP);
    const v7 = notifView(ready(sim.acct, sim.pre), jan).items.find((x) => x.key === f7.key)!;
    sim.respond(jan.id, { mode: 'DO', choices: { [f7.key]: 'SKIP' }, reasons: { [f7.key]: pickReason(v7, '價格已經反映') } });
    const after = sim.acct.notifs.find((x) => x.id === jan.id)!;
    expect(after.items.find((x) => x.key === f7.key)!.reason).toBe('價格已經反映');
    // 不用寫理由的項目沒有選項
    const other = jan.items.find((i) => !i.reasonRequired && i.brk?.type !== 'B');
    if (other) expect(reasonPicksOf(other)).toBeNull();
  });
});

// ---------------------------------------------------------------- T71 回報的：改寫證據包的 W 撞號

describe('T72 改寫證據包：建議的標準比重不再和 AI 監測中的條件撞號', () => {
  it('有 AI 監測中的條件 W1 時，標準比重是 R1；facts 的編號不重複', async () => {
    await withWorld(async (c) => {
      await c.db
        .prepare('INSERT INTO own_conditions (ticker, run_id, cond_id, direction, kind, text, check_json, tier_if_met, status, created_at, origin, file_id, action, auto) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind('NVDA', 'r0', 'W1', 'DOWN', 'EVENT', '公司宣布下修財測', JSON.stringify({ type: 'event', confirm_by: ['8-K'] }), 'HALF', 'ACTIVE', '2026-11-19T12:00:00.000Z', 'AI', 'NVDA@2026-11-19', 'REVIEW', 1)
        .run();
      const run = await startOwnCheck(c.env, c.fetcher, await acctOf(c.db), c.view, c.axis, 'NVDA', [{ text: '毛利率連兩季低於 55% 就減半', action: 'HALF' }], at(0), { version: 1, live: [], sameByText: {} });
      const ids = run.pack.facts.map((f) => f.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(run.pack.facts.find((f) => f.id === 'W1')?.label).toContain('AI 監測中的條件');
      expect(run.pack.facts.find((f) => f.label === '建議的標準比重')?.id).toBe('R1');
    });
  });
});

describe('主持者驗收 T72 時修：準備中那一行的時間（thesis-draft.js 的 hm）', () => {
  it('台北下午 4 點以後開始的草稿，日期不會多一天', async () => {
    const { hm } = (await import('../public/js/thesis-draft.js' as string)) as { hm: (iso: string) => string };
    expect(hm('2026-11-21T13:13:00Z')).toBe('11/21 21:13');
    expect(hm('2026-11-21T01:00:00Z')).toBe('11/21 09:00');
    expect(hm('2026-11-21T16:30:00Z')).toBe('11/22 00:30');
  });
});
