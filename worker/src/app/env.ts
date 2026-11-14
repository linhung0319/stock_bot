export interface Env {
  DB: D1Database;
  ADMIN_TOKEN?: string;
  AI_TASK_SECRET?: string;
  ROUTINE_FIRE_URL?: string;
  ROUTINE_TOKEN?: string;
  EDGAR_USER_AGENT?: string;
  /** 網站的 LINE 登入（src/app/site/lineLogin.ts）：LINE Login channel 的 ID 與 secret、簽登入 cookie 的亂碼。
   *  這三個加上 LINE_USER_ID 都設了才會開；只有 LINE_USER_ID 那個帳號能登入。 */
  LINE_LOGIN_CHANNEL_ID?: string;
  LINE_LOGIN_CHANNEL_SECRET?: string;
  SESSION_SECRET?: string;
  /** LINE Messaging API（T7）：channel access token 與收訊息的 user ID。都設了才會推播。 */
  LINE_CHANNEL_TOKEN?: string;
  LINE_USER_ID?: string;
  /** 網站網址（LINE 訊息裡的連結），wrangler.jsonc 的 vars。 */
  SITE_URL?: string;
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
