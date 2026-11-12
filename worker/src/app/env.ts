export interface Env {
  DB: D1Database;
  ADMIN_TOKEN?: string;
  AI_TASK_SECRET?: string;
  ROUTINE_FIRE_URL?: string;
  ROUTINE_TOKEN?: string;
  EDGAR_USER_AGENT?: string;
  /** Cloudflare Access：團隊網域（例如 xxx.cloudflareaccess.com）與這個應用程式的 AUD。兩個都設了，網站才用 Access 驗證。 */
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  /** 只給本機開發（.dev.vars）：'1' = 網站不驗證登入。部署的環境不要設。 */
  DEV_NO_AUTH?: string;
}

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/** 比對 Bearer token（固定時間比較）。沒有設定金鑰時一律拒絕。 */
export function bearerOk(req: Request, secret: string | undefined): boolean {
  if (!secret) return false;
  const h = req.headers.get('Authorization') ?? '';
  const got = h.startsWith('Bearer ') ? h.slice(7) : '';
  const a = new TextEncoder().encode(got);
  const b = new TextEncoder().encode(secret);
  let diff = a.length ^ b.length;
  for (let i = 0; i < b.length; i++) diff |= (a[i % Math.max(1, a.length)] ?? 0) ^ b[i];
  return diff === 0;
}

export const json = (data: unknown, status = 200) => Response.json(data, { status });
