// LINE 推播（T7）：通知與告警的文字，以及送出。
// 用 Messaging API 的 push（只推給一個人）：
//   LINE_CHANNEL_TOKEN  channel access token（long-lived）
//   LINE_USER_ID        要收訊息的 user ID（LINE Developers 後台 Basic settings 的「Your user ID」）
// 兩個都放 `wrangler secret`。網站網址（訊息裡的連結）是 wrangler.jsonc 的 vars.SITE_URL。
import { PRICE_CODES, corePriceLine } from '../data/coreCheck';
import type { Account, DropStatus, Notif } from '../engine';
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

/**
 * LINE 訊息裡的網站連結：加 openExternalBrowser=1，點了用手機的瀏覽器開，不用 LINE 內建瀏覽器
 * （2026-11-15 使用者決定：LINE 只回狀態，操作一律到網站；設計 §10 第 41 點）。hash 是網站裡的頁面，例如 #/n/12。
 */
export function lineUrl(siteUrl: string | null | undefined, hash = ''): string | null {
  const base = (siteUrl ?? '').replace(/\/+$/, '');
  return base ? `${base}/?openExternalBrowser=1${hash}` : null;
}

export function notifLink(env: Env, id: number): string | null {
  return lineUrl(env.SITE_URL, `#/n/${id}`);
}

/**
 * 一則通知的 LINE 文字：等級與標題、要下的單（合併後的股數）、網站連結。
 * 等級：月報（每月第一個交易日）／當天（月中的緊急通知）／提醒。紙上交易的帳戶每則前面標【紙上】。
 */
export function notifText(acct: Account, n: Notif, link: string | null): string {
  const tag = n.kind === 'MONTHLY' || n.kind === 'MONTHLY_EMPTY' ? '月報' : n.kind === 'URGENT' ? '當天' : '提醒';
  const out: string[] = [`${acct.paper ? '【紙上】' : ''}【${tag}】${n.title}`];
  if (n.text) out.push(n.text);
  // 乙類的當天通知（own_thesis §1.10）：標題、哪條前提、AI 建議（要不要做由你決定）、連結；預設不動，沒有要下的單
  if (isBreakNotice(n)) {
    if (link) out.push(link);
    return out.join('\n');
  }
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
  // 核心 ETF 的價格和基準對不上、而且這份月報崩盤規則切換（core_ai §3.10）：下單清單後面加一行
  if (corePriceWarn(n)) out.push(corePriceLine(acct.cfg.coreTicker));
  // 慢規則減半：AI 論點檢查的一行，放在下單清單後面（own_thesis §3.4）。月報裡可能不只一檔，前面寫代號
  for (const it of n.items) {
    if (it.cancelled || it.f !== 'F7' || !it.drop) continue;
    out.push(`${n.kind === 'URGENT' ? '' : `${it.ticker} 的 `}${DROP_LINE[it.drop]}`);
  }
  // 崩盤規則的 AI 檢視只附一行（設計 §4.4）
  for (const it of n.items) if (!it.cancelled && it.aiLine?.startsWith('AI 檢視：')) out.push(it.aiLine);
  const optional = n.items.filter((it) => !it.cancelled && it.choice === 'SKIP' && (it.kind === 'AI_ONLY' || (it.kind === 'HARD' && it.choices.some((c) => c.id === 'AI')))).length;
  if (optional) out.push(`另有 ${optional} 項 AI 建議（預設不做），到網站決定。`);
  // 「要看的事」只加一行（own_thesis §3.6.6）：件數是自選股與動能持股合計；沒有就不加
  const attn = attentionLine(n);
  if (attn) out.push(attn);
  if (merged.length || n.items.length) out.push('', '下單前先到網站確認每一張單（照規則／這次不做），做完回來填快照。');
  if (link) out.push(link);
  return out.join('\n');
}

/** 月報訊號日的資料檢查有 DAY_GAP 或 MA_GAP，而且這份月報有崩盤規則切換的那一項（不是重列的）。 */
export const corePriceWarn = (n: Pick<Notif, 'kind' | 'items' | 'monthly'>): boolean =>
  (n.kind === 'MONTHLY' || n.kind === 'MONTHLY_EMPTY') && !!n.monthly?.input.coreCheck?.some((c) => PRICE_CODES.has(c)) && n.items.some((it) => (it.f === 'F5' || it.f === 'F6') && !it.relist && !it.cancelled);

/** 乙類的當天通知：只有 AI 判斷前提不成立的那一項（月報裡的乙類項目照月報的格式；慢規則減半項目上帶「AI 建議出清」的不算）。 */
export const isBreakNotice = (n: Pick<Notif, 'kind' | 'items'>): boolean => n.kind === 'URGENT' && n.items.length > 0 && n.items.every((it) => it.brk?.type === 'B' && !it.brk.withRule);

/** 慢規則減半通知多的那一行（own_thesis §3.4）。 */
export const DROP_LINE: Record<DropStatus, string> = {
  HOLD: 'AI 論點檢查：建議不動（預設仍是照規則），到網站決定',
  EXIT: 'AI 論點檢查：前提不成立，建議出清（預設仍是照規則），到網站決定',
  AGREE: 'AI 論點檢查：同意減半',
  PENDING: 'AI 論點檢查還沒有結論',
  NONE: 'AI 論點檢查沒有一致結論，照規則',
};

/** 月報的「要看的事」那一行：`持股有 3 件事要看（不用下單），在持股頁。`；不是月報或沒有就是 null。 */
export function attentionLine(n: Pick<Notif, 'kind' | 'attention'>): string | null {
  if (n.kind !== 'MONTHLY' && n.kind !== 'MONTHLY_EMPTY') return null;
  const k = n.attention?.length ?? 0;
  return k ? `持股有 ${k} 件事要看（不用下單），在持股頁。` : null;
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
  const url = lineUrl(siteUrl);
  if (url) out.push('', url);
  return out.join('\n');
}
