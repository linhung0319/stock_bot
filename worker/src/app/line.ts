// LINE 推播（T7）：通知與告警的文字，以及送出。
// 用 Messaging API 的 push（只推給一個人）：
//   LINE_CHANNEL_TOKEN  channel access token（long-lived）
//   LINE_USER_ID        要收訊息的 user ID（LINE Developers 後台 Basic settings 的「Your user ID」）
// 兩個都放 `wrangler secret`。網站網址（訊息裡的連結）是 wrangler.jsonc 的 vars.SITE_URL。
import type { Account, Notif } from '../engine';
import type { Env, Fetcher } from './env';

export const LINE_PUSH_URL = 'https://api.line.me/v2/bot/message/push';
/** LINE 一則文字訊息的上限是 5000 字；留一點餘裕。 */
export const LINE_MAX_TEXT = 4800;

export interface PushResult {
  ok: boolean;
  status: number | null;
  error?: string;
}

export const lineConfigured = (env: Env): boolean => !!(env.LINE_CHANNEL_TOKEN && env.LINE_USER_ID);

export async function pushLine(env: Env, fetcher: Fetcher, text: string): Promise<PushResult> {
  if (!lineConfigured(env)) return { ok: false, status: null, error: 'LINE 還沒設定（LINE_CHANNEL_TOKEN、LINE_USER_ID）' };
  const body = JSON.stringify({ to: env.LINE_USER_ID, messages: [{ type: 'text', text: clip(text) }] });
  try {
    const r = await fetcher(LINE_PUSH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.LINE_CHANNEL_TOKEN}` },
      body,
    });
    if (r.ok) return { ok: true, status: r.status };
    const detail = (await r.text().catch(() => '')).slice(0, 300);
    return { ok: false, status: r.status, error: `LINE 回 ${r.status}${detail ? '：' + detail : ''}` };
  } catch (e) {
    return { ok: false, status: null, error: e instanceof Error ? e.message : String(e) };
  }
}

function clip(text: string): string {
  return text.length <= LINE_MAX_TEXT ? text : text.slice(0, LINE_MAX_TEXT - 20) + '\n…（太長，其餘到網站看）';
}

// ---------------------------------------------------------------- 文字

const money = (x: number) => (x < 0 ? '-$' : '$') + Math.abs(Math.round(x)).toLocaleString('en-US');

export function notifLink(env: Env, id: number): string | null {
  const base = (env.SITE_URL ?? '').replace(/\/+$/, '');
  return base ? `${base}/#/n/${id}` : null;
}

/**
 * 一則通知的 LINE 文字：等級與標題、要下的單（合併後的股數）、網站連結。
 * 等級：月報（每月第一個交易日）／當天（月中的緊急通知）／提醒。紙上交易的帳戶每則前面標【紙上】。
 */
export function notifText(acct: Account, n: Notif, link: string | null): string {
  const tag = n.kind === 'MONTHLY' || n.kind === 'MONTHLY_EMPTY' ? '月報' : n.kind === 'URGENT' ? '當天' : '提醒';
  const out: string[] = [`${acct.paper ? '【紙上】' : ''}【${tag}】${n.title}`];
  if (n.text) out.push(n.text);
  const merged = (n.preview?.merged ?? []).filter((m) => m.shares !== 0);
  if (merged.length) {
    out.push('', '今晚美股開盤下單（市價、整股）：');
    for (const m of merged) {
      const reason = [...new Set(m.parts.map((p) => String(p.reason)).filter(Boolean))].join('、');
      out.push(`${m.shares < 0 ? '賣' : '買'} ${m.ticker} ${Math.abs(m.shares)} 股${reason ? ` · ${reason}` : ''}`);
    }
    if (n.preview) out.push(`做完現金約 ${money(n.preview.cashAfter)}`);
  } else if (n.kind === 'MONTHLY_EMPTY') {
    out.push('', '本月不用下單。');
  }
  // 崩盤規則的 AI 檢視只附一行（設計 §4.4）
  for (const it of n.items) if (!it.cancelled && it.aiLine?.startsWith('AI 檢視：')) out.push(it.aiLine);
  const optional = n.items.filter((it) => !it.cancelled && it.choice === 'SKIP' && (it.kind === 'AI_ONLY' || (it.kind === 'HARD' && it.choices.some((c) => c.id === 'AI')))).length;
  if (optional) out.push(`另有 ${optional} 項 AI 建議（預設不做），到網站決定。`);
  if (merged.length || n.items.length) out.push('', '下單前先到網站確認每一張單（照規則／這次不做），做完回來填快照。');
  if (link) out.push(link);
  return out.join('\n');
}

export interface AlertRow {
  id: number;
  session: string | null;
  kind: string;
  message: string;
}

/** 告警合成一則（同一次流程可能有好幾則）。 */
export function alertText(alerts: AlertRow[], paper: boolean, siteUrl?: string): string {
  const out = [`${paper ? '【紙上】' : ''}【告警】stock bot`];
  for (const a of alerts) out.push(`・${a.session ? a.session + ' ' : ''}${a.message}`);
  const base = (siteUrl ?? '').replace(/\/+$/, '');
  if (base) out.push('', `${base}/`);
  return out.join('\n');
}
