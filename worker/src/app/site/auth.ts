// 網站的登入：LINE Login，由 Worker 自己做（2026-11-14 取代 Cloudflare Access，見 lineLogin.ts）。
//
// 登入成功後發一個自己簽的 cookie（`__Host-sb_session`，HttpOnly、Secure、30 天）。每次請求驗：
//   簽章（SESSION_SECRET 的 HMAC）、種類是 session、還沒過期、裡面的 LINE user ID 等於 LINE_USER_ID
//   （換掉 LINE_USER_ID 或 SESSION_SECRET，所有舊的登入就一起失效）。
//
// 其他進得來的方式：
//   - 帶 ADMIN_TOKEN 的 Bearer（和 /admin 相同的金鑰；登入壞掉時的備用，網頁的登入畫面可以貼）
//   - 還沒設定 LINE 登入時，本機開發在 .dev.vars 設 DEV_NO_AUTH=1 可以直接用
//   - 其他一律 401
import { bearerOk, type Env } from '../env';

export const SESSION_COOKIE = '__Host-sb_session';
export const SESSION_DAYS = 30;
export const LOGIN_PATH = '/auth/line/login';

export interface AuthResult {
  ok: boolean;
  /** 登入的人（LINE user ID）；用金鑰或本機開發時是 null。 */
  who: string | null;
  /** 沒通過的原因（給畫面顯示該怎麼辦）。 */
  reason?: 'NOT_CONFIGURED' | 'NO_SESSION' | 'BAD_SESSION';
}

/** LINE 登入要的四個值都設了才算設定好。 */
export const lineLoginConfigured = (env: Env): boolean => !!(env.LINE_LOGIN_CHANNEL_ID && env.LINE_LOGIN_CHANNEL_SECRET && env.SESSION_SECRET && env.LINE_USER_ID);

// ---------------------------------------------------------------- base64url、HMAC 封裝

export function b64urlEncode(data: ArrayBuffer | Uint8Array | string): string {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('不是 base64url');
  const t = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(t + '='.repeat((4 - (t.length % 4)) % 4));
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
}

export const hmacKey = (secret: string) => crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);

/** 把一個物件簽起來放進 cookie：`<內容>.<簽章>`。內容沒有加密，不要放秘密。 */
export async function seal(secret: string, data: object): Promise<string> {
  const body = b64urlEncode(JSON.stringify(data));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), new TextEncoder().encode(body));
  return `${body}.${b64urlEncode(sig)}`;
}

/** 驗簽章（固定時間比較）並取回內容；不對就回 null。 */
export async function unseal<T>(secret: string, value: string): Promise<T | null> {
  const parts = value.split('.');
  if (parts.length !== 2) return null;
  try {
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), b64urlDecode(parts[1]), new TextEncoder().encode(parts[0]));
    if (!ok) return null;
    return JSON.parse(new TextDecoder().decode(b64urlDecode(parts[0]))) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- cookie

export function readCookie(req: Request, name: string): string | null {
  for (const part of (req.headers.get('Cookie') ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/** `__Host-` 開頭的 cookie 必須 Secure、Path=/、不帶 Domain，別的子網域就設不了、也蓋不掉。 */
export const setCookie = (name: string, value: string, maxAgeSec: number): string => `${name}=${value}; Path=/; Max-Age=${maxAgeSec}; HttpOnly; Secure; SameSite=Lax`;

export interface Session {
  kind: 'session';
  sub: string;
  /** 到期時間（Unix 秒）。 */
  exp: number;
}

export async function siteAuth(req: Request, env: Env, now: Date): Promise<AuthResult> {
  if (bearerOk(req, env.ADMIN_TOKEN)) return { ok: true, who: null };
  if (lineLoginConfigured(env)) {
    const raw = readCookie(req, SESSION_COOKIE);
    if (!raw) return { ok: false, who: null, reason: 'NO_SESSION' };
    const s = await unseal<Session>(env.SESSION_SECRET!, raw);
    if (!s || s.kind !== 'session' || typeof s.exp !== 'number' || s.exp * 1000 <= now.getTime() || s.sub !== env.LINE_USER_ID) return { ok: false, who: null, reason: 'BAD_SESSION' };
    return { ok: true, who: s.sub };
  }
  if (env.DEV_NO_AUTH === '1') return { ok: true, who: null };
  return { ok: false, who: null, reason: 'NOT_CONFIGURED' };
}
