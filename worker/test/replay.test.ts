// T2 重放驗收：TypeScript 引擎用回測的輸入逐日重放，結果要對上 Python 回測（B-8「緩衝 0.10」）。
// 需要 worker/fixtures/replay（檔案大，不進 git）。沒有的話這組測試會標成 skipped：
//   在 repo 根目錄執行 uv run python worker/scripts/export_replay_data.py
import { describe, expect, it } from 'vitest';
import { rankUniverse } from '../src/engine/momentum';
import { replay, replayStats } from '../src/engine/replay';
import { DEFAULT_CONFIG } from '../src/engine/types';
import { BACKTEST_CONFIG, fixturesAvailable, loadB8Orders, loadB8Stats, loadExpected, loadReplay, loadUniverse } from '../scripts/replayData';

const have = fixturesAvailable();

describe.skipIf(!have)('重放驗收（需要 fixtures/replay）', () => {
  const loaded = have ? loadReplay() : null;

  it('股票池與排名：356 個換股日都和回測相同', () => {
    const { data } = loaded!;
    const uni = loadUniverse();
    const bad: string[] = [];
    for (const [date, rows] of Object.entries(uni)) {
      const ranked = rankUniverse(
        rows.map(([ticker, weight, close, dv, momp]) => ({ ticker, weight, close, dollarVolume: dv ?? NaN, momentum: momp ?? NaN })),
      ).map((r) => r.ticker);
      if (ranked.join(',') !== data.ranks[date].join(',')) bad.push(date);
    }
    expect(Object.keys(uni).length).toBeGreaterThan(350);
    expect(bad).toEqual([]);
  });

  for (const tag of ['2000', '2013']) {
    it(`${tag} 起：每日淨值、下單日、每筆方向與比例、原因都和回測相同`, () => {
      const { data, runs, fee, volWindow } = loaded!;
      const run = runs.find((r) => r.tag === tag)!;
      const r = replay(data, { cfg: BACKTEST_CONFIG, own: run.own, start: run.start, end: run.end, fee, volWindow });
      const exp = loadExpected(tag);

      // 每日淨值
      expect(r.dates).toEqual(exp.dates);
      let maxRel = 0;
      r.nav.forEach((v, i) => {
        maxRel = Math.max(maxRel, Math.abs(v / exp.nav[i] - 1));
      });
      expect(maxRel).toBeLessThan(1e-9);

      // 下單日與每筆單：對照回測凍結的輸出 B8_orders_<年>.csv
      const csv = loadB8Orders(tag);
      expect(r.orders.map((o) => o.date)).toEqual(csv.map((o) => o.date));
      expect(r.orders).toEqual(csv);

      // 年化、Sharpe、最大回撤：對照 B8_account.csv
      const s = replayStats(r);
      const b8 = loadB8Stats(tag, '緩衝 0.10');
      expect(s.cagr).toBeCloseTo(b8.cagr, 9);
      expect(s.sharpe).toBeCloseTo(b8.sharpe, 9);
      expect(s.maxDrawdown).toBeCloseTo(b8.maxDrawdown, 9);

      // 回測沒有重算核心的那個情況（跨桶減碼減到自選）在這兩段歷史沒有發生
      expect(r.events.filter((e) => e.kind === 'CROSS_TRIM' && e.detail === 'OWN_PART')).toEqual([]);
    });
  }

  it('上線設定（照設計文字的三項差異）：數字和回測相差在 0.3 個百分點以內', () => {
    const { data, runs, fee, volWindow } = loaded!;
    const cfg = { ...DEFAULT_CONFIG, coreTicker: 'SPY' };
    for (const run of runs) {
      const r = replay(data, { cfg, own: run.own, start: run.start, end: run.end, fee, volWindow });
      const s = replayStats(r);
      const b8 = loadB8Stats(run.tag, '緩衝 0.10');
      expect(Math.abs(s.cagr - b8.cagr)).toBeLessThan(0.003);
      expect(Math.abs(s.maxDrawdown - b8.maxDrawdown)).toBeLessThan(0.01);
      expect(Math.abs(s.sharpe - b8.sharpe)).toBeLessThan(0.03);
    }
  });
});

describe.skipIf(have)('重放驗收', () => {
  it('fixtures/replay 不存在：先執行 uv run python worker/scripts/export_replay_data.py', () => {
    expect(have).toBe(false);
  });
});
