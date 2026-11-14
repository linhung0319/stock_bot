// 用真實資料看 T11 的規則段：npx tsx scripts/t11-local.ts MU NVDA …
//   F1 規則偵測（EDGAR 申報分類、XBRL 小檔、單日漲幅占比、資料可疑）、F5／F6 的 FRED 儀表板、F21 的 French 動能因子回撤。
// EDGAR 的 User-Agent 讀 worker/.secrets.json 的 EDGAR_USER_AGENT（不印出來）。不會觸發任何 AI，只寫本機的暫時 D1。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dashboardText, macroDashboard } from '../src/ai/crash';
import { entryRuleVerdict } from '../src/ai/momEntry';
import { drawdownEpisodes, fetchFrenchMomentum, historyTable } from '../src/ai/strategy';
import { entryEvidence } from '../src/app/momAi';
import { MACRO_SERIES, fetchFred, type FredSeries } from '../src/data/fred';
import { buildMarketView } from '../src/data/marketView';
import { fetchYahooDaily } from '../src/data/sources';
import { saveSeries, seriesFromBars, loadSeries } from '../src/data/store';
import { freshDb } from '../test/helpers/d1';

const tickers = process.argv.slice(2).map((t) => t.toUpperCase());
const secrets = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '.secrets.json'), 'utf8')) as { EDGAR_USER_AGENT?: string };
const { db, dispose } = await freshDb();
let calls = 0;
const fetcher = (url: string, init?: RequestInit) => (calls++, fetch(url, init));
try {
  const all = ['VOO', ...tickers];
  const now = new Date().toISOString();
  const got = await Promise.all(all.map(async (t) => ({ t, s: await fetchYahooDaily(fetcher, t, '2y') })));
  const session = got[0].s.bars.at(-1)!.date;
  await saveSeries(db, got.map(({ t, s }) => seriesFromBars(t, s.bars, now, session)));
  const { view, axis } = buildMarketView(await loadSeries(db, all), session, 'VOO');
  for (const t of tickers) {
    const before = calls;
    const ev = await entryEvidence({ DB: db, EDGAR_USER_AGENT: secrets.EDGAR_USER_AGENT }, fetcher, view, axis, t, 'VOO', true);
    console.log(`\n=== ${t}（決策日 ${session}，對外請求 ${calls - before} 次）12 個月 ${(ev.r12 * 100).toFixed(1)}%`);
    console.log('規則的結論：', entryRuleVerdict(ev.hits));
    for (const h of ev.hits) console.log(`  命中 ${h.code} ${h.sub} ${h.date ?? ''}：${h.detail}`);
    console.log('  data_quality', ev.dataQuality, ev.notes.length ? ev.notes : '');
    for (const d of ev.docs) console.log(`  原文 ${d.source_id}（${d.text.length} 字）${d.title}`);
  }
  console.log('\n=== FRED 儀表板');
  const series = new Map<string, FredSeries>();
  for (const m of MACRO_SERIES) {
    try {
      series.set(m.id, await fetchFred(fetcher, m.id));
    } catch (e) {
      console.log(`  ${m.id} 抓不到：${e instanceof Error ? e.message : e}`);
    }
  }
  console.log(dashboardText(macroDashboard(series, session), null, null));
  console.log('\n=== French 動能因子（UMD）回撤，同等深度以上（-30%）');
  try {
    const rets = await fetchFrenchMomentum(fetcher);
    console.log(`  ${rets.length} 個月，${rets[0]?.month}～${rets.at(-1)?.month}`);
    console.log(historyTable(drawdownEpisodes(rets), -0.3).text);
  } catch (e) {
    console.log('  抓不到：', e instanceof Error ? e.message : e);
  }
  console.log(`\n全部對外請求 ${calls} 次`);
} finally {
  await dispose();
}
