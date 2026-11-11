// 測試用的本機 D1（wrangler 的本機模擬，不需要 Cloudflare 帳號，資料不落地）。
// 每次呼叫給一個全新的資料庫並套用 migrations。
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPlatformProxy } from 'wrangler';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export async function freshDb(): Promise<{ db: D1Database; dispose: () => Promise<void> }> {
  const proxy = await getPlatformProxy<{ DB: D1Database }>({ configPath: join(ROOT, 'wrangler.jsonc'), persist: false });
  const db = proxy.env.DB;
  const dir = join(ROOT, 'migrations');
  for (const f of readdirSync(dir)
    .filter((x) => x.endsWith('.sql'))
    .sort()) {
    const sql = readFileSync(join(dir, f), 'utf8')
      .split('\n')
      .map((l) => l.replace(/--.*$/, ''))
      .join('\n');
    for (const stmt of sql
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean))
      await db.prepare(stmt).run();
  }
  return { db, dispose: () => proxy.dispose() };
}
