// T38 第 4 項（全站截圖）時修的：AI 紀錄分頁「最近的申報事件」不再露出掃描的類別代號、條件編號、表單代號 RULE。
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/app/env';
import { handle } from '../src/index';
import { freshDb } from './helpers/d1';

describe('T38 截圖檢查', () => {
  it('/api/ai/overview 的申報事件：來源與說明是白話（掃描的類別、細項、條件編號換掉；價格規則不寫 RULE）', async () => {
    const { db, dispose } = await freshDb();
    try {
      const ins = db.prepare('INSERT INTO sec_events (ticker, accession, form, event_date, accepted_at, code, sub, by_rule, display_only, source, detail, status, created_at, detail_code) VALUES (?, ?, ?, ?, NULL, ?, ?, 0, 0, ?, ?, ?, ?, ?)');
      await ins.bind('NVDA', '0001045810-26-000097', '8-K', '2026-11-10', 'GUIDANCE_CUT', 'SCAN_GUIDANCE_CUT', 'SCAN', '每日掃描標記：GUIDANCE_CUT（CUT）；可能和 C2 有關（等申報原文證實）', 'HANDLED', '2026-11-10T23:40:00Z', 'CUT').run();
      await ins.bind('MU', 'price:MU:2026-10-12', 'RULE', '2026-10-12', 'PRICE_DROP', 'RULE_IDIO_21D', 'PRICE', '最近 21 個交易日：個股 -24.1%', 'HANDLED', '2026-10-12T23:40:00Z', 'IDIO_21D').run();
      const env = { DB: db, ADMIN_TOKEN: 't', SITE_URL: 'https://bot.example', DEV_NO_AUTH: '1' } as unknown as Env;
      const r = await handle(new Request('https://bot.example/api/ai/overview'), env, (async () => new Response('nf', { status: 404 })) as never, new Date('2026-11-16T03:00:00Z'));
      expect(r.status).toBe(200);
      const o = (await r.json()) as { events: { ticker: string; form: string; detail: string | null }[] };
      const nvda = o.events.find((e) => e.ticker === 'NVDA')!;
      const mu = o.events.find((e) => e.ticker === 'MU')!;
      expect(nvda.form).toBe('8-K');
      expect(nvda.detail).toContain('可能和你的條件有關');
      expect(nvda.detail).not.toMatch(/GUIDANCE_CUT|（CUT）|C2/);
      expect(mu.form).toBe('價格規則');
    } finally {
      await dispose();
    }
  });
});
