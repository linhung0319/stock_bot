// 重放驗收（T2）：npm run replay
// 用回測的行為重放並和 backtest/results 比對，再列出「上線設定」各項差異對數字的影響。
import { rankUniverse } from '../src/engine/momentum';
import { replay, replayStats, type ReplayResult } from '../src/engine/replay';
import type { EngineConfig } from '../src/engine/types';
import { BACKTEST_CONFIG, fixturesAvailable, loadB8Orders, loadB8Stats, loadExpected, loadReplay, loadUniverse } from './replayData';

if (!fixturesAvailable()) {
  console.error('找不到 worker/fixtures/replay。先在 repo 根目錄執行：uv run python worker/scripts/export_replay_data.py');
  process.exit(1);
}
const { data, runs, fee, volWindow } = loadReplay();
const pct = (x: number, d = 2) => (x * 100).toFixed(d) + '%';

// 1. 股票池與排名
const uni = loadUniverse();
let rankMismatch = 0;
for (const [date, rows] of Object.entries(uni)) {
  const ranked = rankUniverse(
    rows.map(([ticker, weight, close, dv, momp]) => ({ ticker, weight, close, dollarVolume: dv ?? NaN, momentum: momp ?? NaN })),
  ).map((r) => r.ticker);
  if (ranked.join(',') !== data.ranks[date].join(',')) {
    rankMismatch++;
    if (rankMismatch <= 5) console.log('排名不符', date);
  }
}
console.log(`股票池與排名：${Object.keys(uni).length} 個換股日，不符 ${rankMismatch} 個`);

function compare(tag: string, r: ReplayResult) {
  const exp = loadExpected(tag);
  let maxRel = 0;
  let firstBad = '';
  r.nav.forEach((v, i) => {
    const rel = Math.abs(v / exp.nav[i] - 1);
    if (rel > maxRel) maxRel = rel;
    if (rel > 1e-9 && !firstBad) firstBad = r.dates[i];
  });
  const csv = loadB8Orders(tag);
  const mine = new Map(r.orders.map((o) => [o.date, o]));
  const theirs = new Map(csv.map((o) => [o.date, o]));
  const onlyMine = r.orders.filter((o) => !theirs.has(o.date)).map((o) => o.date);
  const onlyTheirs = csv.filter((o) => !mine.has(o.date)).map((o) => o.date);
  let diffOrders = 0;
  let diffReasons = 0;
  for (const o of csv) {
    const m = mine.get(o.date);
    if (!m) continue;
    if (m.orders !== o.orders) {
      diffOrders++;
      if (diffOrders <= 3) console.log(`  單不同 ${o.date}\n    回測：${o.orders}\n    重放：${m.orders}`);
    }
    if (m.reasons !== o.reasons || m.ratioOnly !== o.ratioOnly) diffReasons++;
  }
  console.log(
    `  每日淨值最大相對誤差 ${maxRel.toExponential(2)}${firstBad ? '（第一個超過 1e-9：' + firstBad + '）' : ''}；` +
      `下單日 回測 ${csv.length}／重放 ${r.orders.length}，只有重放 ${onlyMine.length}、只有回測 ${onlyTheirs.length}，` +
      `內容不同 ${diffOrders}、原因不同 ${diffReasons}`,
  );
  if (onlyMine.length) console.log('  只有重放：', onlyMine.slice(0, 10).join(' '));
  if (onlyTheirs.length) console.log('  只有回測：', onlyTheirs.slice(0, 10).join(' '));
}

const variants: [string, Partial<EngineConfig>][] = [
  ['回測的行為（對照 B-8「緩衝 0.10」）', {}],
  ['只改：遲滯用原始比值（可以回到 1）', { volHystCapFirst: false }],
  ['只改：跨桶上限一定減回', { crossTrimAlways: true }],
  ['只改：動能目標 = 總資產 × 30%', { momBase: 'total' }],
  ['上線設定（三項都照設計文字）', { volHystCapFirst: false, crossTrimAlways: true, momBase: 'total' }],
];

for (const run of runs) {
  console.log(`\n== ${run.start} → ${run.end}，自選 ${run.own.join('/')} ==`);
  const b8 = loadB8Stats(run.tag, '緩衝 0.10');
  console.log(`B8_account.csv：年化 ${pct(b8.cagr)}  Sharpe ${b8.sharpe.toFixed(3)}  最大回撤 ${pct(b8.maxDrawdown, 1)}`);
  for (const [name, over] of variants) {
    const cfg = { ...BACKTEST_CONFIG, ...over };
    const r = replay(data, { cfg, own: run.own, start: run.start, end: run.end, fee, volWindow });
    const s = replayStats(r);
    const avgW = r.volPath.length ? r.volPath.reduce((a, b) => a + b, 0) / r.volPath.length : 1;
    const ownPart = r.events.filter((e) => e.kind === 'CROSS_TRIM' && e.detail === 'OWN_PART').length;
    const trims = r.events.filter((e) => e.kind === 'CROSS_TRIM').length;
    console.log(
      `${name}\n  年化 ${pct(s.cagr)}  Sharpe ${s.sharpe.toFixed(3)}  最大回撤 ${pct(s.maxDrawdown, 1)}  下單日/年 ${s.orderDaysPerYear.toFixed(2)}` +
        `  平均波動度比例 ${avgW.toFixed(2)}  跨桶減碼 ${trims} 次（減到自選 ${ownPart} 次）  月中當天通知 ${r.urgentDays} 天`,
    );
    if (name.startsWith('回測')) compare(run.tag, r);
  }
}
