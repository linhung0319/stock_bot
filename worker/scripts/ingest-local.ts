// 從這台電腦用真實資料跑一次每日抓取（含排名），存進暫時的本機 D1：npx tsx scripts/ingest-local.ts
// 只確認真實回應能走完整個流程；不是從 Cloudflare 跑。
import { runIngest } from '../src/data/ingest';
import { buildMarketView } from '../src/data/marketView';
import { loadSeries } from '../src/data/store';
import { freshDb } from '../test/helpers/d1';

const { db, dispose } = await freshDb();
try {
  let calls = 0;
  const r = await runIngest(db, (url, init) => (calls++, fetch(url, init)), { now: new Date(), required: ['VOO', 'SGOV'], forceRank: true });
  const { ranking, alerts, ...run } = r;
  console.log(JSON.stringify(run, null, 1));
  console.log('對外請求', calls, '次；告警', alerts.map((a) => `${a.kind}: ${a.message}`));
  if (ranking) {
    console.log('排名前 15：', ranking.order.slice(0, 15).join(' '));
    console.log('股票池', ranking.detail.universe.length, '檔；抓不到的成分股：', ranking.detail.missing.join(' ') || '無');
    console.log('同公司的類股：', JSON.stringify(ranking.detail.company));
    const top = ranking.detail.universe.filter((u) => ranking.order.slice(0, 5).includes(u.ticker));
    console.log(top.map((u) => `${u.ticker} 252日 ${((u.momentum ?? NaN) * 100).toFixed(1)}% 收盤 ${u.close}`).join('；'));
  }
  const built = buildMarketView(await loadSeries(db, ['VOO', 'SGOV', 'SPY']), r.session, 'VOO');
  console.log('市場資料：', built.view.date, '共', built.axis.length, '個交易日；VOO 收盤', built.view.close.VOO[built.view.i], '；補值', JSON.stringify(built.filled));
} finally {
  await dispose();
}
