// 產生新帳戶的依波動度減碼起始歷史（src/engine/volSeed.ts）：npx tsx scripts/vol-seed.ts
// 用 B-8 重放（2000–2026，上線設定）每個換股日記下的 σ。σ 只看當月的動能名單，和減碼比例、自選股無關，
// 所以這份歷史就是「同一套規則從 2000 年跑到現在」會累積的歷史；新帳戶接著往下記，行為和回測一致。
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { replay } from '../src/engine/replay';
import { median } from '../src/engine/indicators';
import { BACKTEST_CONFIG, fixturesAvailable, loadReplay } from './replayData';

if (!fixturesAvailable()) {
  console.error('找不到 worker/fixtures/replay。先在 repo 根目錄執行：uv run python worker/scripts/export_replay_data.py');
  process.exit(1);
}
const { data, runs, fee, volWindow } = loadReplay();
const run = runs.find((r) => r.tag === '2000')!;
const cfg = { ...BACKTEST_CONFIG, volHystCapFirst: false, crossTrimAlways: true, momBase: 'total' as const };
const r = replay(data, { cfg, own: run.own, start: run.start, end: run.end, fee, volWindow });
const h = r.volHist;
const values = h.map((x) => Math.round(x.sigma * 1e6) / 1e6);
const out = `// 由 scripts/vol-seed.ts 產生，不要手改。
// 新帳戶的依波動度減碼起始歷史（design_v2 §10 第 31 點）：B-8 重放 ${run.start} → ${run.end}（上線設定）每個換股日記下的 σ
// （動能名單相對核心的年化超額波動，${volWindow} 個交易日）。共 ${values.length} 個月，中位數 ${median(values).toFixed(4)}。
export const VOL_HIST_SEED = {
  from: '${h[0].date}',
  to: '${h[h.length - 1].date}',
  values: [${values.join(', ')}],
} as const;
`;
const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'engine', 'volSeed.ts');
writeFileSync(file, out);
console.log(`寫入 ${file}：${values.length} 個月（${h[0].date} → ${h[h.length - 1].date}），中位數 ${median(values).toFixed(4)}，最後 6 個月 ${values.slice(-6).join(' ')}`);
