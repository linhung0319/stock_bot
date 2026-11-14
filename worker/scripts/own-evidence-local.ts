// 用真實資料看自選股審查（F24）的證據長什麼樣：npx tsx scripts/own-evidence-local.ts MU [決策日]
// EDGAR 的 User-Agent 讀 worker/.secrets.json 的 EDGAR_USER_AGENT（不印出來）。不會觸發任何 AI，也不寫 D1 以外的地方。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gatherOwnEvidence } from '../src/app/ownAi';
import { freshDb } from '../test/helpers/d1';

const ticker = (process.argv[2] ?? 'MU').toUpperCase();
const asOf = process.argv[3] ?? new Date().toISOString().slice(0, 10);
const secrets = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '.secrets.json'), 'utf8')) as { EDGAR_USER_AGENT?: string };
const { db, dispose } = await freshDb();
try {
  let calls = 0;
  const ev = await gatherOwnEvidence({ DB: db, EDGAR_USER_AGENT: secrets.EDGAR_USER_AGENT }, (url, init) => (calls++, fetch(url, init)), ticker, asOf);
  console.log(`${ticker} 決策日 ${asOf}：CIK ${ev.cik}，對外請求 ${calls} 次，data_quality ${JSON.stringify(ev.dataQuality)}`);
  if (ev.notes.length) console.log('備註：', ev.notes);
  console.log('\n--- XBRL 季度表 ---\n' + (ev.xbrl?.text ?? '（沒有）'));
  for (const d of ev.docs) console.log(`\n--- ${d.title}（${d.text.length} 字）${d.url} ---\n${d.text.slice(0, 900)}\n…\n${d.text.slice(-300)}`);
  console.log('\n--- 新聞標題 ---\n' + (ev.news?.text.split('\n').slice(0, 6).join('\n') ?? '（沒有）'));
} finally {
  await dispose();
}
