// 從這台電腦實際抓一次（不是從 Cloudflare）：npx tsx scripts/probe-local.ts
// 只確認網址與解析在真實回應上可用。EDGAR 要設 EDGAR_USER_AGENT 環境變數才會連。
import { runProbe } from '../src/app/probe';

const fetcher = (url: string, init?: RequestInit) => fetch(url, init);
for (const part of ['A', 'B'] as const) {
  const t0 = Date.now();
  const rows = await runProbe({ EDGAR_USER_AGENT: process.env.EDGAR_USER_AGENT }, part, fetcher);
  const by: Record<string, { n: number; ok: number; ms: number }> = {};
  for (const r of rows) {
    const b = (by[r.source] ??= { n: 0, ok: 0, ms: 0 });
    b.n++;
    b.ok += r.ok ? 1 : 0;
    b.ms += r.ms;
  }
  console.log(`part ${part}（${Date.now() - t0} ms）`);
  for (const [s, b] of Object.entries(by)) console.log(`  ${s}: ${b.ok}/${b.n} 成功，平均 ${Math.round(b.ms / b.n)} ms`);
  for (const r of rows.filter((x) => !x.ok)) console.log(`  失敗 ${r.source} ${r.target}: ${r.detail}`);
  const sample = rows.filter((x) => x.ok).slice(0, 3);
  for (const r of sample) console.log(`  例 ${r.source} ${r.target}: ${r.detail}`);
}
