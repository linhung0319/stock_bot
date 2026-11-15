// T37：「要看的事」清單（own_thesis §3.6.6、§1.5 第 6 點、§3.6.2 最後一點）。
// 完成條件：
//   五種（PROPOSED_CONDS、COND_NEAR、NO_THESIS、THESIS_OLD、HALF_NO_EXIT）各有成立與不成立的測試
//   頻率（同一件事下個月不再列、COND_NEAR 換季才再列）
//   「本月不用動」的月報也列
//   LINE 有與沒有那一行
//   不產生通知
// 對外請求全部是假的（價格、成分股固定檔、LINE）。
import { describe, expect, it } from 'vitest';
import type { Env, Fetcher } from '../src/app/env';
import { runFlow } from '../src/app/flow';
import { loadAccount, saveAccount } from '../src/app/ledgerStore';
import { LINE_PUSH_URL, attentionLine, notifText } from '../src/app/line';
import { dueAttention, monthOwnAttention, ownAttention, OWN_ATTN, type AttnHit, type FileCondition, type ThesisFile } from '../src/app/thesis';
import { buildMarketView } from '../src/data/marketView';
import { loadSeries } from '../src/data/store';
import { createAccount, monthlyReport, type Account, type Attention, type OwnMeta } from '../src/engine';
import { handle } from '../src/index';
import { freshDb } from './helpers/d1';
import { cronTime, fakeFetcher, newWorld } from './helpers/fakeSources';

// ---------------------------------------------------------------- 純函式用的假論點檔

const DATE = '2026-11-30';
function fileOf(o: Partial<ThesisFile> = {}): ThesisFile {
  return {
    ticker: 'MU',
    fileId: 'MU@2026-01-02',
    openedAt: '2026-01-02',
    origin: 'NEW',
    kind: 'THESIS',
    status: 'OPEN',
    thesis: null,
    premises: [{ id: 'P4', text: 'HBM 需求延續', origin: 'USER', addedAt: '2026-01-02', lastCheck: null, splitAfter: false }],
    conditions: [],
    events: [],
    reviews: [],
    disputes: [],
    flags: [],
    lastReview: null,
    newSince: '2025-09-01',
    log: [],
    ...o,
  };
}
const GM = { type: 'xbrl_metric_below', metric: 'GrossMarginPct', level: 0.7, quarters: 2 };
function cond(o: Partial<FileCondition> = {}): FileCondition {
  return {
    id: 7,
    ticker: 'MU',
    runId: 'rev-1',
    condId: 'N1',
    direction: 'DOWN',
    kind: 'XBRL',
    text: '毛利率連兩季低於 70%',
    check: GM,
    tierIfMet: 'EXIT',
    status: 'ACTIVE',
    createdAt: '2026-09-01T01:00:00.000Z',
    metAt: null,
    note: null,
    origin: 'AI',
    fileId: 'MU@2026-01-02',
    acceptedAt: '2026-09-02T01:00:00.000Z',
    action: 'EXIT',
    premiseId: null,
    supersedes: null,
    metBasis: null,
    verifiedAt: null,
    progress: { at: '2026-11-05', basis: 'XBRL', period: '2026-09-30', values: [0.684, 0.72], level: 0.7, streak: 1, need: 2 },
    auto: true,
    ...o,
  };
}
type MiniAcct = Parameters<typeof ownAttention>[1];
function acctOf(state: 'STD' | 'HALF' = 'STD', notifs: Account['notifs'] = []): MiniAcct {
  return { own: { MU: {} as OwnMeta }, rule: { own: { MU: { applied: state, stdWeight: 0.1 } } } as unknown as Account['rule'], notifs };
}
const hits = (kind: string, file: ThesisFile, acct: MiniAcct = acctOf(), date = DATE) => ownAttention([file], acct, { date }).filter((x) => x.kind === kind);

describe('五種要看的事：成立與不成立', () => {
  it('PROPOSED_CONDS：有建議中的條件才列；件數是建議中的條數；過期、監測中的不算', () => {
    const f = fileOf({ conditions: [cond({ id: 1, status: 'PROPOSED', runId: 'rev-1', acceptedAt: null, createdAt: '2026-10-05T01:00:00.000Z' }), cond({ id: 2, status: 'PROPOSED', runId: 'rev-2', acceptedAt: null, createdAt: '2026-11-06T01:00:00.000Z' }), cond({ id: 3, status: 'ACTIVE' })] });
    expect(hits('PROPOSED_CONDS', f)).toEqual([{ ticker: 'MU', kind: 'PROPOSED_CONDS', src: 'own', text: 'MU 有 2 條 AI 建議的條件等你看', since: '2026-11-06', key: 'PROPOSED_CONDS@rev-2', every: null }]);
    expect(hits('PROPOSED_CONDS', fileOf({ conditions: [cond({ status: 'EXPIRED', acceptedAt: null }), cond({ status: 'ACTIVE' })] }))).toEqual([]);
    expect(hits('PROPOSED_CONDS', fileOf())).toEqual([]);
  });

  it('COND_NEAR：你定的、要連續 N 季（N ≥ 2）、已經 N−1 季才列；文字照設計', () => {
    expect(hits('COND_NEAR', fileOf({ conditions: [cond()] }))).toEqual([
      { ticker: 'MU', kind: 'COND_NEAR', src: 'own', text: 'MU：你定的條件「毛利率連兩季低於 70%」已經有一季低於門檻（68.4%），下一季也低於就會成立 → 出清', since: '2026-11-05', key: 'COND_NEAR:7@2026-09-30', every: null },
    ]);
    // 要連續 3 季、已經 2 季；高於門檻；動作是減半
    const three = cond({ check: { type: 'xbrl_metric_above', metric: 'GrossMarginPct', level: 0.7, quarters: 3 }, text: '毛利率連三季高於 70%', action: 'HALF', progress: { at: '2026-11-05', basis: 'XBRL', period: '2026-09-30', values: [0.72, 0.71, 0.6], level: 0.7, streak: 2, need: 3 } });
    expect(hits('COND_NEAR', fileOf({ conditions: [three] }))[0].text).toBe('MU：你定的條件「毛利率連三季高於 70%」已經連續兩季高於門檻（72.0%），下一季也高於就會成立 → 減半');
    // 不成立：還沒有一季符合、只要一季、已經成立（streak = need）、AI 建議還沒勾選、撤下的、沒有進度
    const p = cond().progress!;
    for (const c of [
      cond({ progress: { ...p, streak: 0 } }),
      cond({ progress: { ...p, need: 1, streak: 0 } }),
      cond({ progress: { ...p, streak: 2 } }),
      cond({ status: 'PROPOSED', acceptedAt: null }),
      cond({ status: 'RETIRED' }),
      cond({ progress: null }),
    ])
      expect(hits('COND_NEAR', fileOf({ conditions: [c] }))).toEqual([]);
  });

  it('NO_THESIS：只有系統預設前提才列；有你的論點不列', () => {
    const def = fileOf({ kind: 'DEFAULT_ONLY', premises: [{ id: 'P1', text: '財報可信', origin: 'SYSTEM_DEFAULT', addedAt: '2026-01-02', lastCheck: null, splitAfter: false }] });
    expect(hits('NO_THESIS', def)).toEqual([{ ticker: 'MU', kind: 'NO_THESIS', src: 'own', text: 'MU 還沒有你的論點，目前用系統預設前提檢查', since: '2026-01-02', key: 'NO_THESIS', every: 6 }]);
    expect(hits('NO_THESIS', fileOf())).toEqual([]);
  });

  it('THESIS_OLD：論點本文寫了滿 365 天才列；沒有本文時看最新一條你的前提；只有預設前提不列', () => {
    const thesis = (setAt: string) => ({ text: '論點', setAt, source: 'TYPED' as const, version: 1, afterBreak: 0, lastAfterBreakAt: null });
    expect(hits('THESIS_OLD', fileOf({ thesis: thesis('2025-11-20') }))).toEqual([{ ticker: 'MU', kind: 'THESIS_OLD', src: 'own', text: 'MU 的論點是 2025-11-20 寫的，已經一年沒有更新', since: '2026-11-20', key: 'THESIS_OLD', every: 12 }]);
    expect(hits('THESIS_OLD', fileOf({ thesis: thesis('2025-12-01') }))).toEqual([]); // 364 天
    // 本文是新的，前提舊：看本文
    expect(hits('THESIS_OLD', fileOf({ thesis: thesis('2026-06-01'), premises: [{ id: 'P4', text: 'x', origin: 'USER', addedAt: '2024-01-02', lastCheck: null, splitAfter: false }] }))).toEqual([]);
    // 沒有本文：最新一條使用者前提
    const prem = (addedAt: string, origin = 'USER') => ({ id: 'P' + addedAt, text: 'x', origin, addedAt, lastCheck: null, splitAfter: false });
    expect(hits('THESIS_OLD', fileOf({ premises: [prem('2025-06-01'), prem('2025-10-01')] }))[0].text).toBe('MU 的論點是 2025-10-01 寫的，已經一年沒有更新');
    expect(hits('THESIS_OLD', fileOf({ premises: [prem('2025-06-01'), prem('2026-02-01', 'AI_DRAFT_ACCEPTED')] }))).toEqual([]);
    expect(hits('THESIS_OLD', fileOf({ kind: 'DEFAULT_ONLY', premises: [prem('2020-01-02', 'SYSTEM_DEFAULT')] }))).toEqual([]);
  });

  it('HALF_NO_EXIT：減半中而且沒有你定的條件（監測中＋只在審查時檢查）才列；只記錄的不算出場條件', () => {
    const notifs = [{ id: 3, date: '2026-10-14', items: [{ f: 'F7', ticker: 'MU' }] }] as unknown as Account['notifs'];
    expect(hits('HALF_NO_EXIT', fileOf(), acctOf('HALF', notifs))).toEqual([{ ticker: 'MU', kind: 'HALF_NO_EXIT', src: 'own', text: 'MU 減半中：站回 200 日均線之前規則不會再有動作，而你沒有定任何出場條件', since: '2026-10-14', key: 'HALF_NO_EXIT', every: 3 }]);
    // 一開始就是減半：從開檔日起
    expect(hits('HALF_NO_EXIT', fileOf(), acctOf('HALF'))[0].since).toBe('2026-01-02');
    expect(hits('HALF_NO_EXIT', fileOf({ conditions: [cond({ kind: 'PRICE', status: 'MANUAL', progress: null })] }), acctOf('HALF'))).toHaveLength(1);
    expect(hits('HALF_NO_EXIT', fileOf({ conditions: [cond({ status: 'PROPOSED', acceptedAt: null })] }), acctOf('HALF'))).toHaveLength(1);
    // 不成立：有你定的條件、標準狀態
    expect(hits('HALF_NO_EXIT', fileOf({ conditions: [cond()] }), acctOf('HALF'))).toEqual([]);
    expect(hits('HALF_NO_EXIT', fileOf({ conditions: [cond({ kind: 'EVENT', status: 'REVIEW_ONLY', progress: null })] }), acctOf('HALF'))).toEqual([]);
    expect(hits('HALF_NO_EXIT', fileOf(), acctOf('STD'))).toEqual([]);
  });

  it('加一種只要在 OWN_ATTN 加一個物件；不是自選的論點檔不列', () => {
    const extra = { kind: 'TEST_KIND', detect: () => [{ key: 'TEST_KIND', every: 1, since: DATE, text: 'MU 測試' }] };
    expect(ownAttention([fileOf()], acctOf(), { date: DATE }, [...OWN_ATTN, extra]).map((x) => x.kind)).toContain('TEST_KIND');
    expect(ownAttention([fileOf({ ticker: 'AMD' })], acctOf(), { date: DATE })).toEqual([]);
  });
});

// ---------------------------------------------------------------- 頻率

const hit = (key: string, every: number | null, kind = key.split(/[:@]/)[0]): AttnHit => ({ ticker: 'MU', kind, key, every, text: key, since: DATE, src: 'own' });

describe('月報多久列一次', () => {
  it('同一件事下個月不再列；隔滿設定的月數才再列（NO_THESIS 6 個月、HALF_NO_EXIT 3 個月、THESIS_OLD 12 個月）', () => {
    const xs = [hit('NO_THESIS', 6), hit('HALF_NO_EXIT', 3), hit('THESIS_OLD', 12)];
    const m1 = dueAttention(xs, {}, '2026-11-30');
    expect(m1.due.map((x) => x.key)).toEqual(['NO_THESIS', 'HALF_NO_EXIT', 'THESIS_OLD']);
    expect(m1.shown).toEqual({ MU: { NO_THESIS: '2026-11-30', HALF_NO_EXIT: '2026-11-30', THESIS_OLD: '2026-11-30' } });
    // 下個月：都不列，attnShown 不變
    const m2 = dueAttention(xs, m1.shown, '2026-12-31');
    expect(m2.due).toEqual([]);
    expect(m2.shown).toEqual({});
    // 3 個月後（2 月最後一個交易日只差 88 天，也算 3 個月）：只有 HALF_NO_EXIT
    const m4 = dueAttention(xs, m1.shown, '2027-02-26');
    expect(m4.due.map((x) => x.key)).toEqual(['HALF_NO_EXIT']);
    expect(m4.shown.MU).toEqual({ NO_THESIS: '2026-11-30', HALF_NO_EXIT: '2027-02-26', THESIS_OLD: '2026-11-30' });
    expect(dueAttention(xs, m1.shown, '2027-05-28').due.map((x) => x.key)).toEqual(['NO_THESIS', 'HALF_NO_EXIT']);
    expect(dueAttention(xs, m1.shown, '2027-11-30').due.map((x) => x.key)).toEqual(['NO_THESIS', 'HALF_NO_EXIT', 'THESIS_OLD']);
  });

  it('COND_NEAR 換季才再列；PROPOSED_CONDS 有新的審查寫入建議才再列', () => {
    const first = dueAttention([hit('COND_NEAR:7@2026-09-30', null), hit('PROPOSED_CONDS@rev-1', null)], {}, '2026-11-30');
    expect(first.due).toHaveLength(2);
    // 同一季、同一次審查：之後每個月都不再列
    for (const d of ['2026-12-31', '2027-01-29', '2028-01-31']) expect(dueAttention([hit('COND_NEAR:7@2026-09-30', null), hit('PROPOSED_CONDS@rev-1', null)], first.shown, d).due).toEqual([]);
    // 新的一季（進度的季末日換了）、新的審查寫了建議 → 再列
    const next = dueAttention([hit('COND_NEAR:7@2026-12-31', null), hit('PROPOSED_CONDS@rev-2', null)], first.shown, '2027-02-26');
    expect(next.due.map((x) => x.key)).toEqual(['COND_NEAR:7@2026-12-31', 'PROPOSED_CONDS@rev-2']);
    // 別的條件同一季：各算各的
    expect(dueAttention([hit('COND_NEAR:8@2026-09-30', null)], first.shown, '2026-12-31').due).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- 流程、月報、LINE、網站

interface Ctx {
  db: D1Database;
  env: Env;
  line: string[];
  run: (date: string) => ReturnType<typeof runFlow>;
}

async function withWorld(fn: (c: Ctx) => Promise<void>) {
  const d = await freshDb();
  try {
    const db = d.db;
    const w = newWorld('2026-11-19');
    const line: string[] = [];
    const base = fakeFetcher(w);
    const fetcher: Fetcher = async (url, init) => {
      if (url === LINE_PUSH_URL) {
        line.push((JSON.parse(String(init?.body)) as { messages: { text: string }[] }).messages[0].text);
        return Response.json({});
      }
      return base(url, init);
    };
    const env: Env = { DB: db, ADMIN_TOKEN: 't', SITE_URL: 'https://bot.example', LINE_CHANNEL_TOKEN: 'lt', LINE_USER_ID: 'U1', DEV_NO_AUTH: '1' };
    const run = (date: string) => {
      w.dataDate = date;
      return runFlow(env, fetcher, { now: cronTime(date), attempt: 'FIRST' });
    };
    await run('2026-11-19');
    const { view } = buildMarketView(await loadSeries(db, ['VOO', 'SGOV', 'NVDA', 'MSFT']), '2026-11-19', 'VOO');
    const px = (t: string) => view.close[t][view.i];
    // NVDA 只有系統預設前提；MSFT 有你的前提
    const acct = createAccount(
      {
        paper: true,
        cash: 10_000,
        core: { VOO: Math.floor(124_000 / px('VOO')) },
        own: {
          NVDA: { shares: Math.floor(40_000 / px('NVDA')), stdWeight: 0.1 },
          MSFT: { shares: Math.floor(16_000 / px('MSFT')), stdWeight: 0.05, premises: [{ id: 'P1', text: '雲端營收維持兩位數成長', origin: 'USER' }] },
        },
      },
      view,
    );
    await saveAccount(db, acct, null, '建立帳戶', new Date('2026-11-19T12:00:00Z'));
    await fn({ db, env, line, run });
  } finally {
    await d.dispose();
  }
}

async function seedCond(db: D1Database, o: { ticker: string; fileId: string; status: string; runId?: string; accepted?: boolean; progress?: unknown }) {
  await db
    .prepare('INSERT INTO own_conditions (ticker, run_id, cond_id, direction, kind, text, check_json, tier_if_met, status, created_at, origin, file_id, accepted_at, action, auto, progress_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(o.ticker, o.runId ?? 'rev-x', 'N1', 'DOWN', 'XBRL', '毛利率連兩季低於 70%', JSON.stringify(GM), 'EXIT', o.status, '2026-11-20T01:00:00.000Z', 'AI', o.fileId, o.accepted ? '2026-11-21T01:00:00.000Z' : null, o.accepted ? 'EXIT' : null, 1, o.progress ? JSON.stringify(o.progress) : null)
    .run();
}

describe('月報與網站', () => {
  it('月底的月報帶「要看的事」、記下 attnShown；LINE 只加一行；不產生通知；同一天再算不會再列；持股頁列出全部', async () => {
    await withWorld(async ({ db, env, line, run }) => {
      const a0 = (await loadAccount(db))!.acct;
      // NVDA：2 條 AI 建議；MSFT：你定的條件已經一季低於門檻
      await seedCond(db, { ticker: 'NVDA', fileId: a0.own.NVDA.fileId!, status: 'PROPOSED', runId: 'rev-n' });
      await seedCond(db, { ticker: 'NVDA', fileId: a0.own.NVDA.fileId!, status: 'PROPOSED', runId: 'rev-n' });
      await seedCond(db, { ticker: 'MSFT', fileId: a0.own.MSFT.fileId!, status: 'ACTIVE', accepted: true, progress: { at: '2026-11-05', basis: 'XBRL', period: '2026-09-30', values: [0.684, 0.72], level: 0.7, streak: 1, need: 2 } });
      for (const day of ['2026-11-20', '2026-11-23', '2026-11-24', '2026-11-25', '2026-11-27']) await run(day);
      const before = (await loadAccount(db))!.acct;
      line.length = 0;
      const r = await run('2026-11-30');
      expect(r.status).toBe('DONE');
      const acct = (await loadAccount(db))!.acct;
      const n = acct.notifs.find((x) => x.id === r.monthly)!;
      expect(n.kind).toBe('MONTHLY');
      const want: Attention[] = [
        { ticker: 'NVDA', kind: 'PROPOSED_CONDS', text: 'NVDA 有 2 條 AI 建議的條件等你看', since: '2026-11-20', src: 'own' },
        { ticker: 'NVDA', kind: 'NO_THESIS', text: 'NVDA 還沒有你的論點，目前用系統預設前提檢查', since: '2026-11-19', src: 'own' },
        { ticker: 'MSFT', kind: 'COND_NEAR', text: 'MSFT：你定的條件「毛利率連兩季低於 70%」已經有一季低於門檻（68.4%），下一季也低於就會成立 → 出清', since: '2026-11-05', src: 'own' },
      ];
      expect(n.attention).toEqual(want);
      expect(n.monthly!.input.attention).toEqual(want);
      expect(acct.own.NVDA.attnShown).toEqual({ 'PROPOSED_CONDS@rev-n': '2026-11-30', NO_THESIS: '2026-11-30' });
      expect(Object.keys(acct.own.MSFT.attnShown!)).toEqual([expect.stringMatching(/^COND_NEAR:\d+@2026-09-30$/)]);
      // 不產生通知：這一天只多了月報那一則；LINE 只推月報，裡面一行
      expect(r.created).toEqual([n.id]);
      expect(acct.notifs.length).toBe(before.notifs.length + 1);
      expect(line).toHaveLength(1);
      expect(line[0]).toContain('\n持股有 3 件事要看（不用下單），在持股頁。\n');
      expect(line[0].match(/件事要看/g)).toHaveLength(1);

      // 同一天、同樣的狀態再算一次：都列過了
      const { view } = buildMarketView(await loadSeries(db, ['VOO', 'SGOV', 'NVDA', 'MSFT']), '2026-11-30', 'VOO');
      const again = await monthOwnAttention(db, acct, view);
      expect(again.items).toEqual([]);
      expect(again.acct).toBe(acct);

      // 持股頁：不看頻率，這一檔現在成立的全部
      const res = await handle(new Request('https://bot.example/api/holding/NVDA'), env, fakeFetcher(newWorld('2026-11-30')), new Date('2026-12-01T02:00:00Z'));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { attention: Attention[] };
      expect(body.attention.map((x) => x.kind)).toEqual(['PROPOSED_CONDS', 'NO_THESIS']);
      // 月報頁：通知的資料帶 attention
      const nv = (await (await handle(new Request(`https://bot.example/api/notif/${n.id}`), env, fakeFetcher(newWorld('2026-11-30')), new Date('2026-12-01T02:00:00Z'))).json()) as { attention: Attention[] };
      expect(nv.attention).toEqual(want);
    });
  });

  it('「本月不用動」的月報也列；LINE 有與沒有那一行', async () => {
    await withWorld(async ({ db }) => {
      const { view } = buildMarketView(await loadSeries(db, ['VOO', 'SGOV', 'NVDA', 'MSFT']), '2026-11-19', 'VOO');
      // 沒有自選、動能、閒置現金的帳戶：月報沒有任何一項
      const acct = createAccount({ paper: false, cash: 0, core: { VOO: 100 } }, view);
      const att: Attention[] = [{ ticker: 'MU', kind: 'NO_THESIS', text: 'MU 還沒有你的論點，目前用系統預設前提檢查', since: '2026-01-02', src: 'own' }];
      const withAtt = monthlyReport(acct, view, { order: [], month: '2026-12', attention: att }).notif;
      expect(withAtt.kind).toBe('MONTHLY_EMPTY');
      expect(withAtt.attention).toEqual(att);
      const text = notifText(acct, withAtt, 'https://bot.example/x');
      expect(text).toBe(['【月報】2026-12 月報：本月不用動', withAtt.text, '', '本月不用下單。', '持股有 1 件事要看（不用下單），在持股頁。', 'https://bot.example/x'].join('\n'));
      // 沒有要看的事：沒有那一行，通知也沒有 attention 欄位
      const without = monthlyReport(acct, view, { order: [], month: '2026-12' }).notif;
      expect(without.kind).toBe('MONTHLY_EMPTY');
      expect('attention' in without).toBe(false);
      expect(notifText(acct, without, null)).not.toContain('件事要看');
      // 不是月報就不加
      expect(attentionLine({ kind: 'URGENT', attention: att })).toBeNull();
      expect(attentionLine({ kind: 'MONTHLY', attention: [...att, { ...att[0], ticker: 'AMD', src: 'mom' }] })).toBe('持股有 2 件事要看（不用下單），在持股頁。');
    });
  });
});
