// T15：LINE 關鍵字回覆。簽章、只回本人、關鍵字、不認得的訊息、reply API、紀錄。全部假資料，LINE API 用假的 fetcher。
import { describe, expect, it } from 'vitest';
import type { Env, Fetcher } from '../src/app/env';
import { LINE_REPLY_URL, commandOf, nextMonthlySignal, replyText, signatureOk, type ReplyContext } from '../src/app/lineWebhook';
import { handle } from '../src/index';
import { freshDb } from './helpers/d1';

const SECRET = 'test-channel-secret';
const OWNER = 'Uowner000000000000000000000000000';
const NOW = new Date('2026-11-16T03:00:00Z');

async function sign(body: string, secret = SECRET): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)))));
}

interface Sent {
  url: string;
  auth: string | null;
  body: { replyToken: string; messages: { type: string; text: string }[] };
}
function lineApi(status = 200) {
  const sent: Sent[] = [];
  const fetcher: Fetcher = async (url, init) => {
    sent.push({ url, auth: new Headers(init?.headers).get('Authorization'), body: JSON.parse(String(init?.body)) });
    return new Response(status === 200 ? '{}' : '{"message":"Invalid reply token"}', { status });
  };
  return { sent, fetcher };
}

async function withDb(fn: (db: D1Database, env: Env) => Promise<void>) {
  const d = await freshDb();
  try {
    await fn(d.db, { DB: d.db, LINE_CHANNEL_SECRET: SECRET, LINE_CHANNEL_TOKEN: 'channel-token', LINE_USER_ID: OWNER, SITE_URL: 'https://bot.example' });
  } finally {
    await d.dispose();
  }
}

const textEvent = (text: string, userId = OWNER, sourceType = 'user') => ({ type: 'message', replyToken: `rt-${text}`, source: { type: sourceType, userId }, message: { type: 'text', id: '1', text } });

async function post(env: Env, fetcher: Fetcher, events: unknown[], opt: { sig?: string | null; raw?: string } = {}) {
  const body = opt.raw ?? JSON.stringify({ destination: 'Ubot', events });
  const sig = opt.sig === undefined ? await sign(body) : opt.sig;
  return handle(new Request('https://bot.example/line/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(sig ? { 'X-Line-Signature': sig } : {}) }, body }), env, fetcher, NOW);
}

/** 假帳戶：只放關鍵字回覆會讀到的欄位。 */
async function seedAccount(db: D1Database) {
  await db.prepare("INSERT INTO account_state (id, rev, updated_at, state) VALUES (1, 1, 'x', '{\"paper\":true}')").run();
  const n = (id: number, kind: string, date: string, title: string, status: string) =>
    db.prepare('INSERT INTO notifications (id, kind, date, status, updated_at, body) VALUES (?, ?, ?, ?, ?, ?)').bind(id, kind, date, status, 'x', JSON.stringify({ id, kind, date, title, status, items: [] })).run();
  await n(3, 'MONTHLY', '2026-10-30', '2026-11 月報', 'DONE');
  await n(7, 'URGENT', '2026-11-13', 'ZZZ 慢規則減半', 'PENDING');
  await db.prepare("INSERT INTO flow_state (key, value, updated_at) VALUES ('lastSession', '2026-11-13', 'x')").run();
  await db.prepare("INSERT INTO alerts (at, session, kind, message) VALUES ('2026-11-15T23:40:00.000Z', '2026-11-13', 'STALE', '價格不是最新的'), ('2026-11-15T23:41:00.000Z', null, 'TEST', '這是測試告警')").run();
}

describe('簽章與設定', () => {
  it('簽章不對、沒有簽章、用別的 secret 簽 → 401，不回覆；沒設定 → 503；不是 POST → 405', async () => {
    await withDb(async (_db, env) => {
      const { sent, fetcher } = lineApi();
      expect((await post(env, fetcher, [textEvent('狀態')], { sig: null })).status).toBe(401);
      expect((await post(env, fetcher, [textEvent('狀態')], { sig: 'AAAA' })).status).toBe(401);
      const body = JSON.stringify({ events: [textEvent('狀態')] });
      expect((await post(env, fetcher, [], { raw: body, sig: await sign(body, 'other-secret') })).status).toBe(401);
      // 簽的是別的 body
      expect((await post(env, fetcher, [], { raw: body, sig: await sign(body + ' ') })).status).toBe(401);
      expect(sent).toEqual([]);
      expect((await post({ ...env, LINE_CHANNEL_SECRET: undefined }, fetcher, [])).status).toBe(503);
      expect((await handle(new Request('https://bot.example/line/webhook'), env, fetcher, NOW)).status).toBe(405);
      expect(await signatureOk(SECRET, 'x', await sign('x'))).toBe(true);
    });
  });
  it('LINE 後台的 Verify（events 是空的）→ 200，不回覆', async () => {
    await withDb(async (_db, env) => {
      const { sent, fetcher } = lineApi();
      const r = await post(env, fetcher, []);
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ ok: true, replied: 0 });
      expect(sent).toEqual([]);
    });
  });
});

describe('只回本人', () => {
  it('別人、群組裡的訊息、沒有 replyToken 的事件、其他事件 → 200 但不回', async () => {
    await withDb(async (_db, env) => {
      const { sent, fetcher } = lineApi();
      const r = await post(env, fetcher, [textEvent('狀態', 'Ustranger'), textEvent('狀態', OWNER, 'group'), { ...textEvent('狀態'), replyToken: undefined }, { type: 'unfollow', source: { type: 'user', userId: OWNER } }]);
      expect(r.status).toBe(200);
      expect(sent).toEqual([]);
    });
  });
  it('本人的訊息：用 reply API（replyToken、channel token），回覆記在 pushes（REPLY）', async () => {
    await withDb(async (db, env) => {
      await seedAccount(db);
      const { sent, fetcher } = lineApi();
      const r = await post(env, fetcher, [textEvent('狀態')]);
      expect(await r.json()).toEqual({ ok: true, replied: 1 });
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ url: LINE_REPLY_URL, auth: 'Bearer channel-token', body: { replyToken: 'rt-狀態' } });
      const text = sent[0].body.messages[0].text;
      expect(text).toContain('【紙上】【狀態】紙上交易');
      expect(text).toContain('每日流程處理到：2026-11-13');
      expect(text).toContain('#7 ZZZ 慢規則減半');
      expect(text).toContain('https://bot.example/?openExternalBrowser=1#/n/7');
      expect(text).toContain('最近 36 小時的告警：1 則'); // 測試告警不算
      expect(text).toContain('12 月月報，2026-11-30 美股收盤後出（台灣 12/1 早上 7:30 左右）');
      const row = await db.prepare("SELECT kind, ok, status, text FROM pushes WHERE kind = 'REPLY'").first<{ ok: number; status: number; text: string }>();
      expect(row).toMatchObject({ ok: 1, status: 200, text });
    });
  });
  it('LINE 回錯誤（例如 replyToken 過期）→ 照樣回 200 給 LINE，紀錄 ok = 0', async () => {
    await withDb(async (db, env) => {
      const { fetcher } = lineApi(400);
      const r = await post(env, fetcher, [textEvent('網址')]);
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ ok: true, replied: 0 });
      expect(await db.prepare("SELECT ok, status FROM pushes WHERE kind = 'REPLY'").first()).toEqual({ ok: 0, status: 400 });
    });
  });
});

describe('關鍵字', () => {
  it('比對時去掉空白與標點、英文不分大小寫；別名都認得', () => {
    expect(commandOf(' 狀態 ')).toBe('STATUS');
    expect(commandOf('Status!')).toBe('STATUS');
    expect(commandOf('網址。')).toBe('SITE');
    expect(commandOf('網站')).toBe('SITE');
    expect(commandOf('？')).toBe('HELP');
    expect(commandOf('help')).toBe('HELP');
    expect(commandOf('待辦')).toBe('TODO');
    expect(commandOf('月報')).toBe('MONTHLY');
    expect(commandOf('告警')).toBe('ALERTS');
    expect(commandOf('狀態好嗎')).toBeNull();
    expect(commandOf('買 NVDA')).toBeNull();
    expect(commandOf('')).toBeNull();
  });

  const ctx: ReplyContext = {
    siteUrl: 'https://bot.example',
    paper: false,
    pending: [],
    lastSession: '2026-11-13',
    alerts: [],
    nextMonthly: { signal: '2026-11-30', month: '2026-12' },
    latestMonthly: { id: 3, date: '2026-10-30', title: '2026-11 月報', status: 'DONE' },
  };
  it('各關鍵字的內容；真實帳戶不標紙上', () => {
    // LINE 裡的連結一律用手機的瀏覽器打開（openExternalBrowser=1，2026-11-15）
    expect(replyText('SITE', '網址', ctx)).toBe('網站：https://bot.example/?openExternalBrowser=1\n（會用手機的瀏覽器打開；用 LINE 登入，只有你本人能進）');
    expect(replyText('STATUS', '狀態', ctx)).toMatch(/^【狀態】真實帳戶\n/);
    expect(replyText('TODO', '待辦', ctx)).toBe('待辦：沒有\n\nhttps://bot.example/?openExternalBrowser=1');
    expect(replyText('MONTHLY', '月報', ctx)).toContain('最近一份：2026-11 月報（2026-10-30，已處理）\nhttps://bot.example/?openExternalBrowser=1#/n/3');
    expect(replyText('ALERTS', '告警', ctx)).toBe('最近 36 小時沒有告警。');
    const many = { ...ctx, pending: Array.from({ length: 7 }, (_, i) => ({ id: i + 1, kind: 'URGENT' as const, date: '2026-11-13', title: `通知 ${i + 1}` })) };
    const todo = replyText('TODO', '待辦', many);
    expect(todo).toContain('待辦：7 則');
    expect(todo.indexOf('#7')).toBeLessThan(todo.indexOf('#3')); // 新的在前
    expect(todo).not.toContain('#2 ');
    expect(todo).toContain('其餘 2 則在網站');
  });
  it('不認得的文字、貼圖 → 關鍵字列表；說明也是同一份列表', () => {
    const unknown = replyText(null, '買 NVDA', ctx);
    expect(unknown).toContain('不認得「買 NVDA」');
    for (const w of ['狀態', '待辦', '月報', '告警', '網址', '說明']) expect(unknown).toContain(`・${w}：`);
    expect(unknown).toContain('不會下單');
    expect(replyText(null, null, ctx)).toContain('只看得懂文字');
    expect(replyText('HELP', '說明', ctx)).toContain('stock bot 可以回這些字');
  });
  it('還沒有帳戶時也回得出來', () => {
    const none = { ...ctx, paper: null, latestMonthly: null };
    expect(replyText('STATUS', '狀態', none)).toContain('還沒有帳戶');
    expect(replyText('TODO', '待辦', none)).toBe('還沒有帳戶，沒有待辦。');
    expect(replyText('MONTHLY', '月報', none)).toContain('月底前到網站建立帳戶');
  });
  it('貼圖、加好友：本人才回，回關鍵字列表', async () => {
    await withDb(async (_db, env) => {
      const { sent, fetcher } = lineApi();
      await post(env, fetcher, [{ type: 'message', replyToken: 'rt-s', source: { type: 'user', userId: OWNER }, message: { type: 'sticker' } }, { type: 'follow', replyToken: 'rt-f', source: { type: 'user', userId: OWNER } }]);
      expect(sent.map((s) => s.body.replyToken)).toEqual(['rt-s', 'rt-f']);
      expect(sent[0].body.messages[0].text).toContain('只看得懂文字');
      expect(sent[1].body.messages[0].text).toContain('stock bot 可以回這些字');
    });
  });
});

describe('下一份月報的時間', () => {
  it('從每日流程處理到的下一個交易日起，找當月最後一個交易日；跨年遇到元旦', () => {
    expect(nextMonthlySignal('2026-11-13', NOW, {})).toEqual({ signal: '2026-11-30', month: '2026-12' });
    expect(nextMonthlySignal('2026-11-30', NOW, {})).toEqual({ signal: '2026-12-31', month: '2027-01' });
    expect(nextMonthlySignal(null, NOW, {})).toEqual({ signal: '2026-11-30', month: '2026-12' });
  });
});
