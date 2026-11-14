// LINE Login（OAuth 2.0 authorization code ＋ OpenID Connect），2026-11-14 取代 Cloudflare Access。
//
//   GET /auth/line/login?next=#/…   產生 state、PKCE、nonce，存進一個 10 分鐘的簽名 cookie，導去 LINE
//   GET /auth/line/callback          LINE 導回來：比對 state → 用 code＋code_verifier 換 ID token → 驗 ID token
//                                    → sub 必須等於 LINE_USER_ID → 發 30 天的登入 cookie，回到 next
//   GET /auth/logout                 清掉登入 cookie
//
// ID token 的簽章：LINE 的文件一處寫網頁登入是 HS256（用 Channel secret 驗），OIDC 設定檔寫 ES256（公鑰在
// /oauth2/v2.1/certs），兩種都驗；其他演算法一律拒絕。另外驗 iss、aud（Channel ID）、exp、nonce。
//
// 需要的設定：LINE_LOGIN_CHANNEL_ID、LINE_LOGIN_CHANNEL_SECRET（LINE Login channel，要和 Messaging API 在同一個
// Provider，user ID 才會等於 LINE_USER_ID）、SESSION_SECRET（簽 cookie 用的亂碼）。
// LINE 後台的 Callback URL：`<網站>/auth/line/callback`。
import type { Env, Fetcher } from '../env';
import { b64urlDecode, b64urlEncode, hmacKey, LOGIN_PATH, lineLoginConfigured, readCookie, seal, SESSION_COOKIE, SESSION_DAYS, setCookie, unseal, type Session } from './auth';

export const LINE_AUTH_URL = 'https://access.line.me/oauth2/v2.1/authorize';
export const LINE_TOKEN_URL = 'https://api.line.me/oauth2/v2.1/token';
export const LINE_CERTS_URL = 'https://api.line.me/oauth2/v2.1/certs';
export const LINE_ISSUER = 'https://access.line.me';
export const CALLBACK_PATH = '/auth/line/callback';
export const LOGIN_COOKIE = '__Host-sb_login';
const LOGIN_TTL_SEC = 600;

interface LoginState {
  kind: 'login';
  state: string;
  verifier: string;
  nonce: string;
  next: string;
  exp: number;
}

const random = (bytes = 32): string => b64urlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
const sha256 = async (s: string): Promise<string> => b64urlEncode(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));

/** 登入後要回去的頁面：只收網站自己的 `#/…`，其他（別的網站、奇怪的字元）一律回首頁。 */
export function safeNext(next: string | null): string {
  return next && next.length <= 200 && /^#\/[A-Za-z0-9/_\-.~%?=&]*$/.test(next) ? next : '';
}

// ---------------------------------------------------------------- ID token

interface EcJwk {
  kid: string;
  kty: string;
  crv?: string;
  x: string;
  y: string;
}
let certsCache: { at: number; keys: EcJwk[] } | null = null;
const CERTS_TTL_MS = 60 * 60 * 1000;

async function lineKeys(fetcher: Fetcher, now: Date, force: boolean): Promise<EcJwk[]> {
  if (!force && certsCache && now.getTime() - certsCache.at < CERTS_TTL_MS) return certsCache.keys;
  const res = await fetcher(LINE_CERTS_URL);
  if (!res.ok) throw new Error(`讀不到 LINE 的公鑰（HTTP ${res.status}）`);
  const body = (await res.json()) as { keys?: EcJwk[] };
  certsCache = { at: now.getTime(), keys: body.keys ?? [] };
  return certsCache.keys;
}

/** 測試用：清掉公鑰快取。 */
export function resetLineCertsCache(): void {
  certsCache = null;
}

export interface IdClaims {
  iss?: string;
  sub?: string;
  aud?: string | string[];
  exp?: number;
  nonce?: string;
  name?: string;
}

/** 驗 LINE 的 ID token：簽章（HS256 或 ES256）、iss、aud、exp、nonce。通過回傳內容，否則 null。 */
export async function verifyIdToken(token: string, env: Env, nonce: string, fetcher: Fetcher, now: Date): Promise<(IdClaims & { sub: string }) | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  let header: { alg?: string; kid?: string };
  let claims: IdClaims;
  let sig: Uint8Array;
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[0])));
    claims = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1])));
    sig = b64urlDecode(parts[2]);
  } catch {
    return null;
  }
  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  let ok = false;
  if (header.alg === 'HS256') {
    ok = await crypto.subtle.verify('HMAC', await hmacKey(env.LINE_LOGIN_CHANNEL_SECRET!), sig, signed);
  } else if (header.alg === 'ES256' && header.kid) {
    let keys = await lineKeys(fetcher, now, false);
    let jwk = keys.find((k) => k.kid === header.kid);
    if (!jwk) {
      keys = await lineKeys(fetcher, now, true);
      jwk = keys.find((k) => k.kid === header.kid);
    }
    if (!jwk || jwk.kty !== 'EC') return null;
    const key = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    ok = sig.length === 64 && (await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig, signed));
  }
  if (!ok) return null;
  if (claims.iss !== LINE_ISSUER) return null;
  const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!auds.includes(env.LINE_LOGIN_CHANNEL_ID)) return null;
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= now.getTime()) return null;
  if (typeof claims.nonce !== 'string' || claims.nonce !== nonce) return null;
  if (typeof claims.sub !== 'string' || !claims.sub) return null;
  return { ...claims, sub: claims.sub };
}

// ---------------------------------------------------------------- 頁面

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** 登入失敗時的簡單頁面（不經過網站的程式，所以不會又被導回 LINE 而繞圈）。 */
function messagePage(status: number, title: string, detail: string, cookies: string[] = [], retry = true): Response {
  const html = `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>stock bot：${esc(title)}</title>
<style>body{margin:0;background:#0b0f14;color:#e6edf3;font:16px/1.7 system-ui,-apple-system,"Noto Sans TC",sans-serif}main{max-width:32rem;margin:12vh auto;padding:0 16px}h1{font-size:1.4rem}p{color:#aab4bf}a{display:inline-block;margin:8px 12px 0 0;padding:10px 16px;border-radius:10px;background:#1f2a36;color:#e6edf3;text-decoration:none}a.primary{background:#06c755;color:#fff}</style></head>
<body><main><h1>${esc(title)}</h1><p>${esc(detail)}</p>${retry ? `<a class="primary" href="${LOGIN_PATH}">用 LINE 再登入一次</a>` : ''}<a href="/">回首頁</a></main></body></html>`;
  const headers = new Headers({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  for (const c of cookies) headers.append('Set-Cookie', c);
  return new Response(html, { status, headers });
}

function redirect(location: string, cookies: string[]): Response {
  const headers = new Headers({ Location: location, 'Cache-Control': 'no-store' });
  for (const c of cookies) headers.append('Set-Cookie', c);
  return new Response(null, { status: 302, headers });
}

// ---------------------------------------------------------------- 路由

/** 不是 /auth/ 底下的路徑回傳 null。 */
export async function handleLineLogin(req: Request, env: Env, fetcher: Fetcher, now: Date): Promise<Response | null> {
  const url = new URL(req.url);
  if (!url.pathname.startsWith('/auth/')) return null;
  if (req.method !== 'GET') return new Response('method not allowed', { status: 405 });
  if (url.pathname === '/auth/logout') return redirect('/', [setCookie(SESSION_COOKIE, '', 0)]);
  if (url.pathname !== LOGIN_PATH && url.pathname !== CALLBACK_PATH) return new Response('not found', { status: 404 });
  if (!lineLoginConfigured(env)) return messagePage(503, '還沒設定 LINE 登入', '要在 Worker 設好 LINE_LOGIN_CHANNEL_ID、LINE_LOGIN_CHANNEL_SECRET、SESSION_SECRET、LINE_USER_ID，步驟在 worker/SETUP.md。', [], false);
  const redirectUri = url.origin + CALLBACK_PATH;
  const sec = Math.floor(now.getTime() / 1000);

  if (url.pathname === LOGIN_PATH) {
    const st: LoginState = { kind: 'login', state: random(), verifier: random(), nonce: random(), next: safeNext(url.searchParams.get('next')), exp: sec + LOGIN_TTL_SEC };
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: env.LINE_LOGIN_CHANNEL_ID!,
      redirect_uri: redirectUri,
      state: st.state,
      scope: 'openid profile',
      nonce: st.nonce,
      code_challenge: await sha256(st.verifier),
      code_challenge_method: 'S256',
    });
    return redirect(`${LINE_AUTH_URL}?${q}`, [setCookie(LOGIN_COOKIE, await seal(env.SESSION_SECRET!, st), LOGIN_TTL_SEC)]);
  }

  // callback：不管成功失敗，一次性的登入 cookie 都清掉
  const clear = setCookie(LOGIN_COOKIE, '', 0);
  const raw = readCookie(req, LOGIN_COOKIE);
  const st = raw ? await unseal<LoginState>(env.SESSION_SECRET!, raw) : null;
  if (!st || st.kind !== 'login' || typeof st.exp !== 'number' || st.exp <= sec) return messagePage(400, '登入逾時', '從按下登入到回來超過 10 分鐘，或這個瀏覽器擋了 cookie。請再試一次。', [clear]);
  const err = url.searchParams.get('error');
  if (err) return messagePage(400, '沒有完成登入', err === 'access_denied' ? '在 LINE 的畫面取消了登入。' : `LINE 回覆：${err}`, [clear]);
  if (url.searchParams.get('state') !== st.state) return messagePage(400, '登入請求對不上', '這次回來的登入不是從這個瀏覽器開始的，所以沒有接受。請再試一次。', [clear]);
  const code = url.searchParams.get('code');
  if (!code) return messagePage(400, '沒有完成登入', 'LINE 沒有帶回登入代碼。', [clear]);

  let idToken: string | undefined;
  try {
    const res = await fetcher(LINE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: env.LINE_LOGIN_CHANNEL_ID!, client_secret: env.LINE_LOGIN_CHANNEL_SECRET!, code_verifier: st.verifier }).toString(),
    });
    if (!res.ok) {
      console.error('LINE token endpoint', res.status, (await res.text()).slice(0, 300));
      return messagePage(502, '登入失敗', `LINE 沒有發登入憑證（HTTP ${res.status}）。請再試一次；一直失敗的話檢查 Channel ID、Channel secret 與 Callback URL。`, [clear]);
    }
    idToken = ((await res.json()) as { id_token?: string }).id_token;
  } catch (e) {
    console.error('LINE token endpoint', e);
    return messagePage(502, '登入失敗', '連不上 LINE。請再試一次。', [clear]);
  }
  let claims: (IdClaims & { sub: string }) | null = null;
  try {
    claims = idToken ? await verifyIdToken(idToken, env, st.nonce, fetcher, now) : null;
  } catch (e) {
    console.error('驗證 LINE ID token', e);
  }
  if (!claims) return messagePage(502, '登入失敗', 'LINE 回來的登入資料驗證不過，所以沒有接受。請再試一次。', [clear]);
  if (claims.sub !== env.LINE_USER_ID) return messagePage(403, '這個 LINE 帳號不能登入', '這個網站只給設定好的那一個 LINE 帳號使用。', [clear], false);

  const session: Session = { kind: 'session', sub: claims.sub, exp: sec + SESSION_DAYS * 86400 };
  return redirect('/' + st.next, [clear, setCookie(SESSION_COOKIE, await seal(env.SESSION_SECRET!, session), SESSION_DAYS * 86400)]);
}
