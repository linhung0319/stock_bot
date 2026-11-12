// 網站的登入：Cloudflare Access。
// Access 在 Cloudflare 的邊緣擋下沒登入的人，通過的請求會帶一個簽過名的 JWT（header `Cf-Access-Jwt-Assertion`）。
// Worker 這裡再驗一次簽章、對象（AUD）與期限：就算 Access 的設定被改壞（例如某個路徑被設成略過），API 也不會打開。
//
// 還沒設定 Access 的時候（ACCESS_TEAM_DOMAIN／ACCESS_AUD 沒有設）：
//   - 帶 ADMIN_TOKEN 的 Bearer 可以用（和 /admin 相同的金鑰，設好 Access 之後這條路就關掉）
//   - 本機開發在 .dev.vars 設 DEV_NO_AUTH=1 可以直接用
//   - 其他一律 401
import { bearerOk, type Env, type Fetcher } from '../env';

export interface AuthResult {
  ok: boolean;
  /** 登入的人（Access 的 JWT 裡的 email）；用金鑰或本機開發時是 null。 */
  who: string | null;
  /** 沒通過的原因（給畫面顯示該怎麼辦）。 */
  reason?: 'NOT_CONFIGURED' | 'NO_TOKEN' | 'BAD_TOKEN';
}

interface Jwk {
  kid: string;
  kty: string;
  alg?: string;
  n: string;
  e: string;
}

// 同一個 isolate 裡快取 Access 的公鑰（Cloudflare 大約每 6 週換一次；找不到 kid 時會重抓）
let jwksCache: { domain: string; at: number; keys: Jwk[] } | null = null;
const JWKS_TTL_MS = 60 * 60 * 1000;

async function accessKeys(domain: string, fetcher: Fetcher, now: Date, force = false): Promise<Jwk[]> {
  if (!force && jwksCache && jwksCache.domain === domain && now.getTime() - jwksCache.at < JWKS_TTL_MS) return jwksCache.keys;
  const res = await fetcher(`https://${domain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`讀不到 Access 的公鑰（HTTP ${res.status}）`);
  const body = (await res.json()) as { keys?: Jwk[] };
  jwksCache = { domain, at: now.getTime(), keys: body.keys ?? [] };
  return jwksCache.keys;
}

function b64url(s: string): Uint8Array {
  const t = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(t + '='.repeat((4 - (t.length % 4)) % 4));
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
}

const normalizeDomain = (d: string): string => d.replace(/^https?:\/\//, '').replace(/\/+$/, '');

/** 驗 Access 的 JWT：RS256 簽章、iss、aud、exp。通過回傳 email（沒有 email 的服務權杖回傳 sub）。 */
export async function verifyAccessJwt(token: string, teamDomain: string, aud: string, fetcher: Fetcher, now: Date): Promise<string | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  let header: { alg?: string; kid?: string };
  let claims: { aud?: string | string[]; iss?: string; exp?: number; nbf?: number; email?: string; sub?: string };
  try {
    header = JSON.parse(new TextDecoder().decode(b64url(parts[0])));
    claims = JSON.parse(new TextDecoder().decode(b64url(parts[1])));
  } catch {
    return null;
  }
  if (header.alg !== 'RS256' || !header.kid) return null;
  const domain = normalizeDomain(teamDomain);
  let keys = await accessKeys(domain, fetcher, now);
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    keys = await accessKeys(domain, fetcher, now, true);
    jwk = keys.find((k) => k.kid === header.kid);
  }
  if (!jwk) return null;
  const key = await crypto.subtle.importKey('jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  let sig: Uint8Array;
  try {
    sig = b64url(parts[2]);
  } catch {
    return null;
  }
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!ok) return null;
  const sec = now.getTime() / 1000;
  if (typeof claims.exp !== 'number' || claims.exp < sec) return null;
  if (typeof claims.nbf === 'number' && claims.nbf > sec + 60) return null;
  if (claims.iss !== `https://${domain}`) return null;
  const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!auds.includes(aud)) return null;
  return claims.email ?? claims.sub ?? '';
}

function cookie(req: Request, name: string): string | null {
  const m = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(req.headers.get('Cookie') ?? '');
  return m ? m[1] : null;
}

export async function siteAuth(req: Request, env: Env, fetcher: Fetcher, now: Date): Promise<AuthResult> {
  if (env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD) {
    const token = req.headers.get('Cf-Access-Jwt-Assertion') ?? cookie(req, 'CF_Authorization');
    if (!token) return { ok: false, who: null, reason: 'NO_TOKEN' };
    try {
      const who = await verifyAccessJwt(token, env.ACCESS_TEAM_DOMAIN, env.ACCESS_AUD, fetcher, now);
      return who === null ? { ok: false, who: null, reason: 'BAD_TOKEN' } : { ok: true, who };
    } catch (e) {
      console.error('驗證 Access 權杖失敗', e);
      return { ok: false, who: null, reason: 'BAD_TOKEN' };
    }
  }
  if (bearerOk(req, env.ADMIN_TOKEN)) return { ok: true, who: null };
  if (env.DEV_NO_AUTH === '1') return { ok: true, who: null };
  return { ok: false, who: null, reason: 'NOT_CONFIGURED' };
}

/** 測試用：清掉公鑰快取。 */
export function resetAccessCache(): void {
  jwksCache = null;
}
