// 從這台電腦用真實資料預覽每日流程與月報的 LINE 文字（不會真的送 LINE，存進暫時的本機 D1）：
//   npx tsx scripts/flow-local.ts
// 1. 跑一次流程（含排名）→ 還沒有帳戶，只抓資料
// 2. 建一個範例帳戶（紙上；核心 VOO、自選 NVDA／MSFT／MU；依波動度減碼的起始歷史照網站建立帳戶的做法）
// 3. 假裝今天是月底（把這個月剩下的交易日當成休市），出一份「下個月」的月報，印出 LINE 會收到的文字
import { processSessions } from '../src/app/flow';
import { saveAccount } from '../src/app/ledgerStore';
import { notifLink, notifText } from '../src/app/line';
import { runFlow } from '../src/app/flow';
import { addDays, isTradingDay } from '../src/data/calendar';
import { buildMarketView } from '../src/data/marketView';
import { loadSeries } from '../src/data/store';
import { createAccount, priceOf } from '../src/engine';
import { VOL_HIST_SEED } from '../src/engine/volSeed';
import { LINE_PUSH_URL } from '../src/app/line';
import type { Env, Fetcher } from '../src/app/env';
import { freshDb } from '../test/helpers/d1';

const { db, dispose } = await freshDb();
try {
  const sent: string[] = [];
  let calls = 0;
  const fetcher: Fetcher = async (url, init) => {
    if (url === LINE_PUSH_URL) {
      sent.push((JSON.parse(String(init?.body)) as { messages: { text: string }[] }).messages[0].text);
      return Response.json({});
    }
    calls++;
    return fetch(url, init);
  };
  const env: Env = { DB: db, SITE_URL: 'https://stock-bot.linhung0319.workers.dev', LINE_CHANNEL_TOKEN: 'local-preview', LINE_USER_ID: 'local' };
  const r0 = await runFlow(env, fetcher, { now: new Date(), attempt: 'MANUAL', forceRank: true });
  console.log(`流程：訊號日 ${r0.session}，${r0.status}，${r0.ms} ms，對外請求 ${calls} 次，告警 ${JSON.stringify(r0.alerts)}`);

  const tickers = ['VOO', 'SGOV', 'NVDA', 'MSFT', 'MU'];
  const { view } = buildMarketView(await loadSeries(db, tickers), r0.session, 'VOO');
  const total = 100_000;
  const sh = (t: string, w: number) => Math.floor((w * total) / priceOf(view, t));
  const acct = createAccount(
    {
      paper: true,
      cash: 3_000,
      core: { VOO: sh('VOO', 0.67) },
      own: { NVDA: { shares: sh('NVDA', 0.12), stdWeight: 0.08 }, MSFT: { shares: sh('MSFT', 0.1), stdWeight: 0.06 }, MU: { shares: sh('MU', 0.08), stdWeight: 0.06 } },
      volHist: [...VOL_HIST_SEED.values],
    },
    view,
  );
  await saveAccount(db, acct, null, '建立帳戶（預覽）', new Date());

  // 這個月剩下的交易日當成休市 → 訊號日變成「當月最後一個交易日」
  const closed = new Set<string>();
  for (let d = addDays(r0.session, 1); d.slice(0, 7) === r0.session.slice(0, 7); d = addDays(d, 1)) if (isTradingDay(d)) closed.add(d);
  const p = await processSessions(db, acct, [r0.session], { closed });
  console.log(`\n預覽：新通知 ${p.created.join('、') || '無'}；告警 ${JSON.stringify(p.alerts.map((a) => a.kind))}`);
  console.log(`動能比例 ${p.acct.rule.volW ?? '（未定）'}；動能名單 ${p.acct.rule.heldMom.join(' ') || '（空）'}`);
  for (const id of p.created) {
    const n = p.acct.notifs.find((x) => x.id === id)!;
    console.log('\n----- LINE 會收到 -----\n' + notifText(p.acct, n, notifLink(env, n.id)));
  }
  if (sent.length) console.log('\n（第 1 步的流程推了', sent.length, '則：', sent.map((s) => s.split('\n')[0]).join('；'), '）');
} finally {
  await dispose();
}
