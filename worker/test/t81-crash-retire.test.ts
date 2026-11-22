/// T81（階段十二）：崩盤規則與崩盤檢視退場（allocation_redesign §1.6、§2.3、§2.4）。
// 排程不再派崩盤檢視、舊資料（F5／F6、舊檢視紀錄）照樣看得到並標「（已停用）」、核心比例橫條、月報狀態文字、
// 首頁一次性說明、策略檢討提醒的一句、總經儀表板的文字。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { dashboardText, macroDashboard } from '../src/ai/crash';
import { FUNCTIONS } from '../src/ai/functions';
import { APPLIERS } from '../src/app/aiStep';
import { ackNoCrashNote, noCrashNote, NO_CRASH_TEXT } from '../src/app/noCrashNote';
import { PUSH_WAITERS } from '../src/app/pushHold';
import { stateView, coreBarOf, notifView } from '../src/app/site/views';
import { DEFAULT_CONFIG, STRATEGY_COST_NOTE, coreBandCheck, coreStatusText, migrateAccount, strategyReminder, type Account, type MarketView } from '../src/engine';
import { viewAt } from './helpers/market';
import { scenarios } from './helpers/scenarios';
import { freshDb } from './helpers/d1';

const HERE = dirname(fileURLToPath(import.meta.url));
const OLD = JSON.parse(readFileSync(join(HERE, 'fixtures', 'account-0.17.0.json'), 'utf8')) as { a: { acct: Account }; b: { acct: Account; d: number }; c: { acct: Account } };
const market = scenarios.s3().market;

describe('T81：排程不再派崩盤檢視', () => {
  it('APPLIERS 沒有 CRASH_REVIEW、PUSH_WAITERS 沒有崩盤檢視；AI 紀錄的功能名稱標已停用', () => {
    expect(Object.keys(APPLIERS)).not.toContain('CRASH_REVIEW');
    expect(PUSH_WAITERS.map((w) => w.name)).toEqual(['減半檢視', '晚到的進場否決']);
    expect(FUNCTIONS.CRASH_REVIEW.label).toBe('崩盤規則檢視（已停用）');
  });

  it('總經儀表板的文字不再有「真空頭開始時」那一欄（市場摘要不讀它）；儲存的 atBears 照舊', () => {
    const rows = macroDashboard(new Map([['UNRATE', { id: 'UNRATE', dates: ['2025-01-01', '2026-10-01'], values: [4, 4.2] }]]), '2026-11-27');
    expect(rows[0].atBears).toBeDefined();
    const text = dashboardText(rows, { above: 30, n: 50 }, { ticker: 'VOO', close: 500, ma: 480 });
    expect(text).not.toContain('bear starts');
    expect(text.split('\n')[0]).toBe('series | date | value | 6m change | derived | note');
    expect(text).toContain('breadth');
  });
});

describe('T81：月報狀態文字（§1.6）', () => {
  const acct = { cfg: DEFAULT_CONFIG, bondTicker: 'SGOV' } as unknown as Account;
  it('界線內／太少／太多（有 F26、換算不出整股）', () => {
    expect(coreStatusText(acct, coreBandCheck(19.2, 100, DEFAULT_CONFIG), false)).toBe('核心：SGOV 與現金 19.2%（這份月報其他單做完之後，15%～25% 之內不調）');
    expect(coreStatusText(acct, coreBandCheck(26.3, 100, DEFAULT_CONFIG), true)).toBe('核心：SGOV 與現金 26.3%（這份月報其他單做完之後，超過 25%，下面有調回 20% 的一項）');
    expect(coreStatusText(acct, coreBandCheck(12, 100, DEFAULT_CONFIG), false)).toBe('核心：SGOV 與現金 12.0%（這份月報其他單做完之後，低於 15%，這次換算不出整股，下個月再算）');
  });
});

describe('T81：核心比例橫條與舊資料（0.17.0 的樣本）', () => {
  const view = (k: 'b'): MarketView => viewAt(market, OLD[k].d - 1);

  it('橫條：0～40%、三段各有字、15／20／25 三個刻度、現在在哪一段', () => {
    const acct = migrateAccount(JSON.parse(JSON.stringify(OLD.b.acct)) as Account);
    const bar = coreBarOf(acct, view('b'))!;
    expect(bar.max).toBe(0.4);
    expect(bar.segs.map((s) => [s.from, s.to, s.label])).toEqual([
      [0, 0.15, '偏少，調回'],
      [0.15, 0.25, '界線內，不調'],
      [0.25, 0.4, '偏多，調回'],
    ]);
    expect(bar.ticks.map((t) => t.label)).toEqual(['15%', '20% 目標', '25%']);
    expect(['low', 'in', 'high']).toContain(bar.at);
    expect(bar.label).toContain('核心裡 SGOV 與現金占');
  });

  it('舊通知（F5／F6）的頁面不壞，項目名稱標「（已停用）」；帳戶頁沒有崩盤規則那一格', () => {
    const acct = migrateAccount(JSON.parse(JSON.stringify(OLD.b.acct)) as Account);
    const v = view('b');
    const d = { mode: 'real', acct, view: v, axis: [], rankOrder: [], rankSession: null, aiNotes: [], events: [], shadow: [], today: v.date, warnings: [] } as never;
    const f6 = acct.notifs.filter((n) => n.items.some((i) => i.f === 'F5' || i.f === 'F6'));
    expect(f6.length).toBeGreaterThan(0);
    for (const n of f6) {
      const nv = notifView(d, n);
      const crash = nv.items.filter((i) => i.label.startsWith('崩盤規則'));
      expect(crash.length).toBeGreaterThan(0);
      for (const i of crash) {
        expect(i.label).toMatch(/（已停用）$/);
        expect(i.explain.rule).toContain('已停用');
      }
    }
    const st = stateView(d);
    expect(st.account!.status.map((s) => s.label)).toEqual(['核心比例', '動能部位']);
    expect(JSON.stringify(st.account!.holdings)).not.toContain('崩盤規則');
  });
});

describe('T81：策略檢討提醒多一句（§2.3）', () => {
  it('提醒文字最後是「動能沒有大盤跌就撤的規則…」', () => {
    const sc = scenarios.s5();
    const v = viewAt(sc.market, sc.market.idx0 + 10);
    const acct = migrateAccount(JSON.parse(JSON.stringify(OLD.a.acct)) as Account);
    const { notif } = strategyReminder(acct, v, '動能相對基準落後超過 20%');
    expect(STRATEGY_COST_NOTE).toBe('動能沒有「大盤跌就撤」的規則；整個帳戶的緩衝是核心的 SGOV。');
    expect(notif.text!.endsWith(STRATEGY_COST_NOTE)).toBe(true);
  });
});

describe('T81：首頁一次性的說明（§2.4）', () => {
  const withCoreBand = (): Account => {
    const a = migrateAccount(JSON.parse(JSON.stringify(OLD.a.acct)) as Account);
    const n = a.notifs.find((x) => x.kind === 'MONTHLY' && x.monthly)!;
    n.monthly!.input.coreBand = { s: 0.2, bond: 0.2, core: 1000 };
    return a;
  };
  const axis = Array.from({ length: 30 }, (_, k) => `2027-02-${String(k + 1).padStart(2, '0')}`);

  it('舊月報（沒有 coreBand）不顯示；新月報顯示一次，按「知道了」之後不再；示範模式用另外的鍵', async () => {
    const d = await freshDb();
    try {
      const old = migrateAccount(JSON.parse(JSON.stringify(OLD.a.acct)) as Account);
      expect(await noCrashNote(d.db, old, axis)).toBeNull();
      const a = withCoreBand();
      expect(await noCrashNote(d.db, a, axis)).toMatchObject({ id: 'monthly', text: NO_CRASH_TEXT });
      // 讀的時候不寫：再讀一次還在
      expect(await noCrashNote(d.db, a, axis)).toMatchObject({ id: 'monthly' });
      await ackNoCrashNote(d.db, 'monthly', new Date('2027-02-01T00:00:00Z'));
      expect(await noCrashNote(d.db, a, axis)).toBeNull();
      // 示範模式的鍵分開
      expect(await noCrashNote(d.db, a, [], true)).toMatchObject({ id: 'monthly' });
    } finally {
      await d.dispose();
    }
  });

  it('之後第一次 VOO 21 天跌 ≥ 10% 觸發市場摘要（market_triggers 有 CUMULATIVE、最近 10 個交易日內）→ 再顯示一次', async () => {
    const d = await freshDb();
    try {
      const a = withCoreBand();
      await ackNoCrashNote(d.db, 'monthly', new Date('2027-02-01T00:00:00Z'));
      expect(await noCrashNote(d.db, a, axis)).toBeNull();
      await d.db.prepare("INSERT INTO market_triggers (session, kind, grp, event_id, value, detail, created_at) VALUES ('2027-02-25', 'CUMULATIVE', '', 'e1', -0.11, 'x', 'x')").run();
      expect(await noCrashNote(d.db, a, axis)).toMatchObject({ id: 'drop', text: NO_CRASH_TEXT });
      // 太久以前的觸發不算
      expect(await noCrashNote(d.db, a, [...axis.slice(0, 5), ...Array.from({ length: 25 }, (_, k) => `2027-03-${String(k + 1).padStart(2, '0')}`)])).toBeNull();
      await ackNoCrashNote(d.db, 'drop', new Date('2027-02-26T00:00:00Z'));
      expect(await noCrashNote(d.db, a, axis)).toBeNull();
    } finally {
      await d.dispose();
    }
  });
});

describe('T81：核心比例橫條的位置算法（public/js/corebar-pos.js）', () => {
  it('刻度與白點是占整條的百分比、各段 flex 是千分比整數（加總 1000，才拉得滿一行）', async () => {
    const { corebarPos, barPct } = (await import('../public/js/corebar-pos.js' as string)) as { corebarPos: (c: unknown) => { ticks: number[]; dot: number; flex: number[] }; barPct: (x: number, max: number) => number };
    const acct = { cfg: DEFAULT_CONFIG, bondTicker: 'SGOV', cash: 0, lots: { own: {}, mom: {}, core: { VOO: 8, SGOV: 20 }, unc: {} } } as unknown as Account;
    const view = { date: '2026-11-30', i: 0, close: { VOO: [100], SGOV: [100] } } as unknown as MarketView; // VOO 800、SGOV 2000 → 71%
    const high = corebarPos(coreBarOf(acct, view)!);
    expect(high.ticks).toEqual([37.5, 50, 62.5]);
    expect(high.flex).toEqual([150, 100, 150]);
    expect(high.dot).toBe(100); // 超過 40% 貼在最右
    const mid = corebarPos(coreBarOf({ ...acct, lots: { ...acct.lots, core: { VOO: 8, SGOV: 2 } } } as Account, view)!); // 200／1000 = 20%
    expect(mid.dot).toBe(50);
    const left = corebarPos(coreBarOf({ ...acct, lots: { ...acct.lots, core: { VOO: 8, SGOV: 1.98 } } } as Account, view)!);
    expect(left.dot).toBeLessThan(50);
    expect(left.dot).toBeGreaterThan(37.5);
    expect(barPct(-1, 0.4)).toBe(0);
  });
});
