/// T33b：崩盤規則檢視的排程、顯示與影子（core_ai_design_2026-11-15 §5 的 T33b 那一列；§3.1～§3.5、§3.12）。
// T80（階段十二，allocation_redesign §1.6）：月報不再產生崩盤項目（F5／F6），所以整條流程的測試——月報等檢視才推、補推、
// 沒有結論的重開與告警、總經資料不足時項目上的字、項目上那一列的六種狀態、回覆崩盤項目的影子紀錄、月報等推的判斷——都拿掉了
// （檢視的排程本身在 T81 退場）。這裡留下不靠月報項目的：總經資料的過期判斷、月份標籤、crashReviewFor 沒有執行時的狀態、
// 舊紀錄的檢視表與 AI 紀錄列表。
import { describe, expect, it } from 'vitest';
import { macroDashboard, dashboardText, isStale, macroQuality } from '../src/ai/crash';
import { crashReviewFor, macroMissingText, macroMonthOf } from '../src/app/crashAi';
import { crashLogView, crashPreviewUnused } from '../src/app/site/views';
import type { FredSeries } from '../src/data/fred';
import type { Account, Notif, ShadowRecord } from '../src/engine';
import { freshDb } from './helpers/d1';

describe('T33b：總經資料（§3.5）', () => {
  it('過期：月資料停在 80 天前算過期、70 天前不算；日資料 11 天、週資料 22 天算過期；儀表板與 AI 看的文字標出來', () => {
    const asOf = '2026-11-27';
    const minus = (d: number) => new Date(Date.parse(asOf) - d * 86400_000).toISOString().slice(0, 10);
    expect(isStale('UNRATE', minus(80), asOf)).toBe(true);
    expect(isStale('UNRATE', minus(70), asOf)).toBe(false);
    expect(isStale('T10Y3M', minus(11), asOf)).toBe(true);
    expect(isStale('T10Y3M', minus(10), asOf)).toBe(false);
    expect(isStale('ICSA', minus(22), asOf)).toBe(true);
    expect(isStale('ICSA', minus(21), asOf)).toBe(false);
    const s = (date: string): FredSeries => ({ id: 'x', dates: ['2025-01-02', date], values: [4.0, 4.1] });
    const series = new Map<string, FredSeries>([
      ['UNRATE', s(minus(80))],
      ['INDPRO', s(minus(70))],
      ['T10Y3M', s(minus(1))],
    ]);
    const rows = macroDashboard(series, asOf);
    expect(rows.find((r) => r.id === 'UNRATE')).toMatchObject({ value: 4.1, stale: true });
    expect(rows.find((r) => r.id === 'INDPRO')).toMatchObject({ stale: false });
    expect(rows.find((r) => r.id === 'T10Y3M')).toMatchObject({ stale: false });
    expect(dashboardText(rows, null, null)).toContain(`（資料停在 ${minus(80)}，不能當證據）`);
    // 可用 = 有值而且沒過期：這裡只有 2 個 → 不足
    expect(macroQuality(rows)).toBe('missing');
    expect(macroMissingText({ rows })).toContain('只有 2 個可用（缺 SAHMREALTIME、ICSA、RRSFS、BAA10Y、BAMLH0A0HYM2、NFCI、VIXCLS；過期 UNRATE）');
  });

  it('/admin/macro 的月份標籤：月報前一天與訊號日是下個月，其他日子是當月', () => {
    expect(macroMonthOf('2026-11-27', {})).toBe('2026-12');
    expect(macroMonthOf('2026-11-30', {})).toBe('2026-12');
    expect(macroMonthOf('2026-12-02', {})).toBe('2026-12');
    expect(macroMonthOf('2026-11-20', {})).toBe('2026-11');
  });
});

// ---------------------------------------------------------------- 純函式：顯示、影子

describe('T33b：月報項目上的那一列（§3.3）', () => {
  it('crashReviewFor：沒有任何執行時，AI 層沒設定 → 沒有開；儀表板不足 → 總經資料抓不到', async () => {
    const d = await freshDb();
    try {
      expect(await crashReviewFor(d.db, '2026-12', 'ON', { ready: false })).toEqual({ state: 'OFF' });
      expect(await crashReviewFor(d.db, '2026-12', 'ON', { ready: true })).toEqual({ state: 'OFF' });
      const rows = macroDashboard(new Map(), '2026-11-27');
      await d.db.prepare("INSERT INTO macro_snapshots (month, as_of, data, created_at) VALUES ('2026-12', '2026-11-27', ?, 'x')").bind(JSON.stringify({ month: '2026-12', asOf: '2026-11-27', rows, breadth: null, core: null, missing: [] })).run();
      expect(await crashReviewFor(d.db, '2026-12', 'ON', { ready: true })).toEqual({ state: 'NO_DATA' });
      expect(await crashReviewFor(d.db, '2026-12', 'ON', { ready: false })).toEqual({ state: 'OFF' });
    } finally {
      await d.dispose();
    }
  });
});

describe('T33b：影子紀錄（§3.4；舊紀錄的顯示）', () => {
  it('檢視紀錄的表：每次切換一列（同一則通知合成一列），三個金額；上方那一句', () => {
    const notifs = [
      { id: 7, kind: 'MONTHLY', monthly: { input: { month: '2027-01' } }, items: [{ f: 'F5', key: 'a', crashReview: { state: 'OPINION', opinion: '延後', votes: '3 票一致', runId: 'run-1' } }] },
      { id: 9, kind: 'MONTHLY', monthly: { input: { month: '2027-03' } }, items: [{ f: 'F6', key: 'b', crashReview: { state: 'NO_OPINION', votes: '照做 2、延後 1', runId: 'run-2' } }] },
    ] as unknown as Notif[];
    const rec = (o: Partial<ShadowRecord>): ShadowRecord => ({ date: '2027-01-04', f: 'F5', ticker: 'VOO', title: '崩盤規則啟動', rule: -10, ai: 0, actual: 0, price: 100, choice: 'SKIP', notif: 7, note: '想再看看', ...o });
    const records = [rec({}), rec({ ticker: 'SGOV', rule: 20, price: 50 }), rec({ date: '2027-03-01', f: 'F6', notif: 9, ticker: 'VOO', rule: 10, ai: null, actual: 10, choice: 'DO', note: undefined })];
    // 價格：VOO 一路漲 10%／月，SGOV 不動；時間軸每月 21 個交易日
    const axis = Array.from({ length: 200 }, (_, k) => `2027-${String(1 + Math.floor(k / 21)).padStart(2, '0')}-${String(4 + (k % 21)).padStart(2, '0')}`);
    const book = { axis, adj: (t: string, k: number) => (k < 0 || k >= axis.length ? NaN : t === 'VOO' ? 100 * Math.pow(1.1, k / 21) : 50) };
    const v = crashLogView({ notifs }, records, book);
    expect(v.head).toBe('崩盤規則（已停用）切換過 2 次；AI 說延後 1 次，其中 1 次延後一個月比較好。');
    expect(v.rows.map((r) => [r.label, r.ai, r.runId, r.choice])).toEqual([
      ['2027-03 解除', '沒有意見', 'run-2', '照做'],
      ['2027-01 啟動', '延後（3 票一致）', 'run-1', '這次不做：想再看看'],
    ]);
    // 1 月：照規則賣 10 股 VOO（價格 100），1 個月後 VOO 漲 10% → 照規則比你實際少賺 100；AI 延後 = 你實際 → 0；照規則比延後 = −100
    const jan = v.rows[1].at['1m']!;
    expect(jan.rule).toBeCloseTo(-100);
    expect(jan.ai).toBeCloseTo(0);
    expect(jan.delay).toBeCloseTo(-100);
    expect(v.rows[0].at['1m']!.ai).toBeNull();
    expect(crashLogView({ notifs: [] }, [], book).head).toBe('還沒有紀錄');
  });

  it('AI 紀錄的列表：預估的檢視在訊號日沒有切換 → 標「沒有用到」；有切換、還沒有月報、補開的都不標', () => {
    const run = (detail: Record<string, string>) => ({ fn: 'CRASH_REVIEW', pack: { rule: { detail } } }) as never;
    const pv = { kind: 'PREVIEW', month: '2026-12', direction: 'ON' };
    const monthly = (items: { f: string }[]) => ({ notifs: [{ id: 3, kind: 'MONTHLY', monthly: { input: { month: '2026-12' } }, items }] }) as unknown as Account;
    expect(crashPreviewUnused(run(pv), monthly([{ f: 'F1' }]))).toBe('預估會啟動，訊號日沒有切換，沒有用到');
    expect(crashPreviewUnused(run(pv), monthly([{ f: 'F5' }]))).toBeNull();
    expect(crashPreviewUnused(run(pv), { notifs: [] } as unknown as Account)).toBeNull();
    expect(crashPreviewUnused(run({ ...pv, kind: 'MAKEUP' }), monthly([]))).toBeNull();
  });
});
