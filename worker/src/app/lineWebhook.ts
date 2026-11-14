// T15：LINE 關鍵字回覆（不用 AI）。
//   POST /line/webhook   LINE Platform 送來的事件。驗 X-Line-Signature（Messaging API 的 channel secret，HMAC-SHA256），
//                        只回 LINE_USER_ID 本人的一對一訊息；用 reply API（不占推播額度）。
// 關鍵字對照固定內容；不認得的訊息、貼圖、圖片回關鍵字列表。所有內容都是從 D1 讀的現況，不呼叫 AI、不改任何狀態。
//   LINE_CHANNEL_SECRET  Messaging API channel 的 Channel secret（Basic settings）；和 LINE Login channel 的不同
import { isLastTradingDayOfMonth, isTradingDay, nextTradingDay, easternTime, type CalendarOverrides } from '../data/calendar';
import { loadCalendarOverrides } from '../data/store';
import type { Notif } from '../engine';
import type { Env, Fetcher } from './env';
import { getFlowState } from './flow';
import { loadAccount } from './ledgerStore';
import { LINE_MAX_TEXT, lineUrl } from './line';

export const LINE_REPLY_URL = 'https://api.line.me/v2/bot/message/reply';

export type Command = 'HELP' | 'SITE' | 'STATUS' | 'TODO' | 'MONTHLY' | 'ALERTS';

/** 關鍵字（比對前去掉空白與標點、英文轉小寫，要整句相同）。 */
export const KEYWORDS: Record<Command, string[]> = {
  HELP: ['說明', '幫助', '指令', '選單', 'help', '?', '？'],
  SITE: ['網址', '網站', '連結', 'url', 'site'],
  STATUS: ['狀態', 'status'],
  TODO: ['待辦', '通知', 'todo'],
  MONTHLY: ['月報'],
  ALERTS: ['告警', 'alert', 'alerts'],
};

const HELP_LINES: [Command, string][] = [
  ['STATUS', '帳戶與每日流程的狀況'],
  ['TODO', '還沒處理的通知與連結'],
  ['MONTHLY', '下一份月報什麼時候出'],
  ['ALERTS', '最近 36 小時的告警'],
  ['SITE', '網站網址'],
  ['HELP', '這份列表'],
];

export function normalize(text: string): string {
  const t = text.trim().toLowerCase();
  if (t === '?' || t === '？') return t;
  return t.replace(/[\s\p{P}\p{S}]/gu, '');
}

export function commandOf(text: string): Command | null {
  const t = normalize(text);
  if (!t) return null;
  for (const [cmd, words] of Object.entries(KEYWORDS) as [Command, string[]][]) if (words.some((w) => normalize(w) === t)) return cmd;
  return null;
}

// ---------------------------------------------------------------- 簽章

const b64 = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf)));

/** X-Line-Signature = base64(HMAC-SHA256(channel secret, 原始 body))。固定時間比較。 */
export async function signatureOk(secret: string, body: string, signature: string | null): Promise<boolean> {
  if (!signature) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const want = b64(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
  let diff = want.length ^ signature.length;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ (signature.charCodeAt(i % Math.max(1, signature.length)) || 0);
  return diff === 0;
}

// ---------------------------------------------------------------- 回覆的內容

export interface ReplyContext {
  siteUrl: string | null;
  /** null = 還沒建立帳戶。 */
  paper: boolean | null;
  pending: Pick<Notif, 'id' | 'kind' | 'date' | 'title'>[];
  lastSession: string | null;
  alerts: { at: string; message: string }[];
  /** 下一份月報：訊號日（當月最後一個交易日）與月份。 */
  nextMonthly: { signal: string; month: string } | null;
  latestMonthly: Pick<Notif, 'id' | 'date' | 'title' | 'status'> | null;
}

/** 和推播的連結相同（line.ts 的 lineUrl：用手機的瀏覽器打開）。 */
const link = (ctx: ReplyContext, id: number) => lineUrl(ctx.siteUrl, `#/n/${id}`);
const tag = (ctx: ReplyContext) => (ctx.paper ? '【紙上】' : '');

/** 美東日期 YYYY-MM-DD 的下一天（月報在美東訊號日收盤後的 UTC 23:30 出，台灣是隔天早上 7:30）。 */
const twMorningOf = (signal: string) => {
  const d = new Date(`${signal}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
};

function helpText(ctx: ReplyContext, unknown?: string): string {
  const out = [unknown !== undefined ? (unknown ? `不認得「${unknown.slice(0, 30)}」。可以傳這些字：` : '只看得懂文字。可以傳這些字：') : 'stock bot 可以回這些字：'];
  for (const [cmd, what] of HELP_LINES) out.push(`・${KEYWORDS[cmd][0]}：${what}`);
  out.push('', '這裡只回固定的內容，不會下單、也不會改帳戶。要操作請到網站。');
  const url = lineUrl(ctx.siteUrl);
  if (url) out.push(url);
  return out.join('\n');
}

function todoLines(ctx: ReplyContext, max = 5): string[] {
  if (!ctx.pending.length) return ['待辦：沒有'];
  const out = [`待辦：${ctx.pending.length} 則`];
  for (const n of ctx.pending.slice(-max).reverse()) {
    const l = link(ctx, n.id);
    out.push(`・#${n.id} ${n.title}（${n.date}）${l ? `\n  ${l}` : ''}`);
  }
  if (ctx.pending.length > max) out.push(`・其餘 ${ctx.pending.length - max} 則在網站`);
  return out;
}

function monthlyLine(ctx: ReplyContext): string {
  if (!ctx.nextMonthly) return '下一份月報：算不出來（交易日曆）';
  const m = Number(ctx.nextMonthly.month.slice(5, 7));
  return `下一份月報：${m} 月月報，${ctx.nextMonthly.signal} 美股收盤後出（台灣 ${twMorningOf(ctx.nextMonthly.signal)} 早上 7:30 左右）`;
}

export function replyText(cmd: Command | null, text: string | null, ctx: ReplyContext): string {
  const site = lineUrl(ctx.siteUrl);
  switch (cmd) {
    case 'SITE':
      return site ? `網站：${site}\n（會用手機的瀏覽器打開；用 LINE 登入，只有你本人能進）` : '網站網址還沒設定（SITE_URL）。';
    case 'STATUS': {
      if (ctx.paper === null) return ['還沒有帳戶：請到網站建立帳戶（填第一份快照）。', ...(site ? [site] : [])].join('\n');
      const out = [`${tag(ctx)}【狀態】${ctx.paper ? '紙上交易' : '真實帳戶'}`, `每日流程處理到：${ctx.lastSession ?? '還沒跑過'}（美東交易日）`, ...todoLines(ctx, 3)];
      out.push(ctx.alerts.length ? `最近 36 小時的告警：${ctx.alerts.length} 則（傳「告警」看內容）` : '最近 36 小時沒有告警');
      out.push(monthlyLine(ctx));
      if (site) out.push('', site);
      return out.join('\n');
    }
    case 'TODO':
      if (ctx.paper === null) return '還沒有帳戶，沒有待辦。';
      return [`${tag(ctx)}${todoLines(ctx).join('\n')}`, ...(ctx.pending.length ? [] : site ? ['', site] : [])].join('\n');
    case 'MONTHLY': {
      const out = [monthlyLine(ctx)];
      if (ctx.latestMonthly) {
        const l = link(ctx, ctx.latestMonthly.id);
        out.push(`最近一份：${ctx.latestMonthly.title}（${ctx.latestMonthly.date}，${ctx.latestMonthly.status === 'PENDING' ? '還沒處理' : '已處理'}）${l ? `\n${l}` : ''}`);
      }
      if (ctx.paper === null) out.push('還沒有帳戶：要在月底前到網站建立帳戶，月報才會出。');
      return out.join('\n');
    }
    case 'ALERTS':
      if (!ctx.alerts.length) return '最近 36 小時沒有告警。';
      return ['最近 36 小時的告警：', ...ctx.alerts.map((a) => `・${a.at.slice(0, 16).replace('T', ' ')} UTC ${a.message}`), ...(site ? ['', site] : [])].join('\n');
    case 'HELP':
      return helpText(ctx);
    default:
      return helpText(ctx, text ?? '');
  }
}

/** 下一份月報的訊號日：每日流程已處理到的下一個交易日起，第一個「當月最後一個交易日」。 */
export function nextMonthlySignal(lastSession: string | null, now: Date, ov: CalendarOverrides): { signal: string; month: string } | null {
  let d = lastSession ? nextTradingDay(lastSession, ov) : easternTime(now).date;
  for (let k = 0; k < 60; k++) {
    if (isTradingDay(d, ov) && isLastTradingDayOfMonth(d, ov)) return { signal: d, month: nextTradingDay(d, ov).slice(0, 7) };
    d = nextTradingDay(d, ov);
  }
  return null;
}

export async function loadReplyContext(env: Env, now: Date): Promise<ReplyContext> {
  const db = env.DB;
  const [loaded, lastSession, ov] = await Promise.all([loadAccount(db), getFlowState(db, 'lastSession'), loadCalendarOverrides(db)]);
  const since = new Date(now.getTime() - 36 * 3600_000).toISOString();
  // 和網站警示列同一個條件：已解決的、測試用的不算
  const alerts = (await db.prepare("SELECT message, MAX(at) AS at FROM alerts WHERE at >= ? AND kind != 'TEST' AND (sent_at IS NULL OR sent_at NOT IN ('RESOLVED', 'SKIPPED_OLD')) GROUP BY message ORDER BY at DESC LIMIT 5").bind(since).all<{ message: string; at: string }>()).results;
  const notifs = loaded?.acct.notifs ?? [];
  const monthly = notifs.filter((n) => n.kind === 'MONTHLY' || n.kind === 'MONTHLY_EMPTY').at(-1) ?? null;
  return {
    siteUrl: env.SITE_URL ?? null,
    paper: loaded ? loaded.acct.paper : null,
    pending: notifs.filter((n) => n.status === 'PENDING').map((n) => ({ id: n.id, kind: n.kind, date: n.date, title: n.title })),
    lastSession,
    alerts,
    nextMonthly: nextMonthlySignal(lastSession, now, ov),
    latestMonthly: monthly && { id: monthly.id, date: monthly.date, title: monthly.title, status: monthly.status },
  };
}

// ---------------------------------------------------------------- 端點

interface LineEvent {
  type: string;
  replyToken?: string;
  source?: { type?: string; userId?: string };
  message?: { type?: string; text?: string };
  deliveryContext?: { isRedelivery?: boolean };
}

export const lineWebhookConfigured = (env: Env): boolean => !!(env.LINE_CHANNEL_SECRET && env.LINE_CHANNEL_TOKEN && env.LINE_USER_ID);

async function reply(env: Env, fetcher: Fetcher, token: string, text: string): Promise<{ ok: boolean; status: number | null; error?: string }> {
  const t = text.length <= LINE_MAX_TEXT ? text : text.slice(0, LINE_MAX_TEXT - 20) + '\n…（太長，其餘到網站看）';
  try {
    const r = await fetcher(LINE_REPLY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.LINE_CHANNEL_TOKEN}` },
      body: JSON.stringify({ replyToken: token, messages: [{ type: 'text', text: t }] }),
    });
    if (r.ok) return { ok: true, status: r.status };
    return { ok: false, status: r.status, error: `LINE 回 ${r.status}：${(await r.text().catch(() => '')).slice(0, 300)}` };
  } catch (e) {
    return { ok: false, status: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * LINE 的 webhook。簽章不對 → 401；沒設定 → 503；其他一律 200（LINE 的「Verify」送的是空的 events）。
 * 只處理 LINE_USER_ID 本人一對一的訊息與加好友事件；別人、群組、其他事件不回。回覆記在 pushes（kind = REPLY）。
 */
export async function handleLineWebhook(request: Request, env: Env, fetcher: Fetcher, now: Date): Promise<Response> {
  if (request.method !== 'POST') return Response.json({ error: 'method_not_allowed' }, { status: 405 });
  if (!lineWebhookConfigured(env)) return Response.json({ error: 'not_configured' }, { status: 503 });
  const body = await request.text();
  if (!(await signatureOk(env.LINE_CHANNEL_SECRET!, body, request.headers.get('x-line-signature')))) return Response.json({ error: 'bad_signature' }, { status: 401 });
  let events: LineEvent[] = [];
  try {
    const parsed = JSON.parse(body) as { events?: unknown };
    if (Array.isArray(parsed.events)) events = parsed.events as LineEvent[];
  } catch {
    return Response.json({ error: 'bad_json' }, { status: 400 });
  }
  let replied = 0;
  let ctx: ReplyContext | null = null;
  for (const e of events.slice(0, 20)) {
    if (!e.replyToken || e.source?.type !== 'user' || e.source.userId !== env.LINE_USER_ID) continue;
    let text: string;
    if (e.type === 'message') {
      ctx ??= await loadReplyContext(env, now);
      const msg = e.message?.type === 'text' ? (e.message.text ?? '') : null;
      text = replyText(msg === null ? null : commandOf(msg), msg, ctx);
    } else if (e.type === 'follow') {
      ctx ??= await loadReplyContext(env, now);
      text = replyText('HELP', null, ctx);
    } else continue;
    const r = await reply(env, fetcher, e.replyToken, text);
    await env.DB.prepare('INSERT INTO pushes (at, kind, ref, ok, status, error, text) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(now.toISOString(), 'REPLY', null, r.ok ? 1 : 0, r.status, r.error ?? null, text).run();
    if (r.ok) replied++;
  }
  return Response.json({ ok: true, replied });
}
