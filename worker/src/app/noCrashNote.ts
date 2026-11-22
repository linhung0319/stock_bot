// 首頁一次性的說明（allocation_redesign §2.4）：崩盤規則退場之後，使用者第一次遇到「大盤跌了、月報沒叫我減碼」時，
// 首頁多一行固定文字，免得以為系統漏了。兩個場合各顯示一次，按「知道了」才算看過（flow_state 記）：
//   monthly  部署後第一份月報（月報輸入有 coreBand 的，T80 起才有）
//   drop     之後第一次核心 ETF 21 個交易日跌 ≥ 10% 觸發市場摘要（market_triggers 有 CUMULATIVE，最近 10 個交易日內）
// 只讀 flow_state 與 market_triggers；示範模式用 demo: 開頭的鍵，不碰真實模式的紀錄。
import type { Account } from '../engine';

export const NO_CRASH_TEXT = '2026-11 起沒有崩盤規則：核心固定留兩成 SGOV，不看 200 日線。';

export type NoCrashNoteId = 'monthly' | 'drop';
export interface NoCrashNote {
  id: NoCrashNoteId;
  text: string;
  /** 為什麼現在顯示（畫面上放在文字前面的短語）。 */
  why: string;
}

const key = (id: NoCrashNoteId, demo: boolean): string => `${demo ? 'demo:' : ''}note:no-crash:${id}`;
/** 示範模式重置時清掉的鍵前綴。 */
export const DEMO_NOTE_PREFIX = 'demo:note:no-crash:';

const WINDOW_DAYS = 10;

async function seen(db: D1Database, id: NoCrashNoteId, demo: boolean): Promise<boolean> {
  return !!(await db.prepare('SELECT 1 AS x FROM flow_state WHERE key = ?').bind(key(id, demo)).first());
}

/** 現在要不要顯示。monthly 優先；它看過了才輪到 drop。 */
export async function noCrashNote(db: D1Database, acct: Account, axis: readonly string[], demo = false): Promise<NoCrashNote | null> {
  const monthly = acct.notifs.some((n) => (n.kind === 'MONTHLY' || n.kind === 'MONTHLY_EMPTY') && n.monthly?.input.coreBand !== undefined);
  if (monthly && !(await seen(db, 'monthly', demo))) return { id: 'monthly', text: NO_CRASH_TEXT, why: '這份月報起' };
  if (demo || !axis.length) return null;
  const from = axis[Math.max(0, axis.length - WINDOW_DAYS)];
  const hit = await db.prepare("SELECT 1 AS x FROM market_triggers WHERE kind = 'CUMULATIVE' AND session >= ? LIMIT 1").bind(from).first();
  if (hit && !(await seen(db, 'drop', demo))) return { id: 'drop', text: NO_CRASH_TEXT, why: '大盤最近跌了一段' };
  return null;
}

/** 使用者按「知道了」：記下來，之後不再顯示。 */
export async function ackNoCrashNote(db: D1Database, id: NoCrashNoteId, now: Date, demo = false): Promise<void> {
  await db.prepare('INSERT INTO flow_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').bind(key(id, demo), now.toISOString(), now.toISOString()).run();
}

export const isNoCrashNoteId = (x: unknown): x is NoCrashNoteId => x === 'monthly' || x === 'drop';
