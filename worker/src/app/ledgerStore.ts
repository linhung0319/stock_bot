// 帳本的 D1 存取（T6）。引擎的 Account 拆開存：
//   account_state    目前的狀態（去掉 notifs／events／shadow），rev 每次存檔加 1；account_history 留每一版
//   notifications    每則通知一列（含回覆）
//   ledger_events、shadow_records  只增加：引擎只會往這兩個陣列加東西，載入時給空陣列，存檔時把新增的寫進去
//   snapshots        使用者填的快照原文
import type { Account, LedgerEvent, Notif, ShadowRecord } from '../engine/account';
import type { Snapshot } from '../engine/ops';
import { CASH } from '../engine/types';

export class ConflictError extends Error {}

export interface LoadedAccount {
  acct: Account;
  rev: number;
  /** 載入時每則通知的內容，存檔時只寫有變的。 */
  notifJson: Map<number, string>;
}

type StateOnly = Omit<Account, 'notifs' | 'events' | 'shadow'>;

export async function loadAccount(db: D1Database): Promise<LoadedAccount | null> {
  const row = await db.prepare('SELECT rev, state FROM account_state WHERE id = 1').first<{ rev: number; state: string }>();
  if (!row) return null;
  const notifRows = (await db.prepare('SELECT id, body FROM notifications ORDER BY id').all<{ id: number; body: string }>()).results;
  const state = JSON.parse(row.state) as StateOnly;
  const acct: Account = { ...state, notifs: notifRows.map((r) => JSON.parse(r.body) as Notif), events: [], shadow: [] };
  return { acct, rev: row.rev, notifJson: new Map(notifRows.map((r) => [r.id, r.body])) };
}

/**
 * 存一版。prev = 載入時拿到的那份（第一次建立帳戶時是 null）。
 * extra：要和帳戶一起寫進同一筆交易的其他語句。
 * 整批是一筆交易；如果這段時間有別的存檔先進來，account_history 的主鍵會撞到，整批取消並丟 ConflictError。
 * 回傳新的 rev。
 */
export async function saveAccount(db: D1Database, acct: Account, prev: LoadedAccount | null, cause: string, now: Date, extra: D1PreparedStatement[] = []): Promise<number> {
  const rev = (prev?.rev ?? 0) + 1;
  const at = now.toISOString();
  const { notifs, events, shadow, ...state } = acct;
  const json = JSON.stringify(state);
  const stmts: D1PreparedStatement[] = [
    db.prepare('INSERT INTO account_history (rev, at, cause, state) VALUES (?, ?, ?, ?)').bind(rev, at, cause, json),
    db.prepare('INSERT INTO account_state (id, rev, updated_at, state) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET rev = excluded.rev, updated_at = excluded.updated_at, state = excluded.state').bind(rev, at, json),
  ];
  const upsert = db.prepare('INSERT INTO notifications (id, kind, date, status, updated_at, body) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, status = excluded.status, updated_at = excluded.updated_at, body = excluded.body');
  for (const n of notifs) {
    const body = JSON.stringify(n);
    if (prev?.notifJson.get(n.id) !== body) stmts.push(upsert.bind(n.id, n.kind, n.date, n.status, at, body));
  }
  const ev = db.prepare('INSERT INTO ledger_events (rev, date, kind, ticker, bucket, shares, amount, reason, notif) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (const e of events) stmts.push(ev.bind(rev, e.date, e.kind, e.ticker ?? null, e.bucket ?? null, e.shares ?? null, e.amount ?? null, e.reason ?? null, e.notif ?? null));
  const sh = db.prepare('INSERT INTO shadow_records (rev, date, f, ticker, body) VALUES (?, ?, ?, ?, ?)');
  for (const s of shadow) stmts.push(sh.bind(rev, s.date, s.f, s.ticker, JSON.stringify(s)));
  // 和帳戶同一筆交易一起寫的（例如每日流程處理到哪一天）
  stmts.push(...extra);
  try {
    await db.batch(stmts);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/UNIQUE|constraint/i.test(msg)) throw new ConflictError(`帳戶已經被另一個操作更新（rev ${rev} 已存在），請重新載入再做一次`);
    throw e;
  }
  return rev;
}

export async function saveSnapshot(db: D1Database, date: string, snap: Snapshot, now: Date, rev: number | null): Promise<void> {
  await db.prepare('INSERT INTO snapshots (date, submitted_at, cash, positions, rev) VALUES (?, ?, ?, ?, ?)').bind(date, now.toISOString(), snap.cash, JSON.stringify(snap.shares), rev).run();
}

export async function loadEvents(db: D1Database, limit = 200): Promise<LedgerEvent[]> {
  const rows = (await db.prepare('SELECT date, kind, ticker, bucket, shares, amount, reason, notif FROM ledger_events ORDER BY id DESC LIMIT ?').bind(limit).all<Record<string, unknown>>()).results;
  // null 欄位拿掉，和引擎的 LedgerEvent 形狀一致
  return rows.reverse().map((r) => Object.fromEntries(Object.entries(r).filter(([, v]) => v !== null)) as unknown as LedgerEvent);
}
export async function loadShadow(db: D1Database, limit = 500): Promise<ShadowRecord[]> {
  const rows = (await db.prepare('SELECT body FROM shadow_records ORDER BY id DESC LIMIT ?').bind(limit).all<{ body: string }>()).results;
  return rows.reverse().map((r) => JSON.parse(r.body) as ShadowRecord);
}

/** 每天一定要有最新價格的代號：核心 ETF、短債 ETF、三桶（含未分類）的持股、動能名單、自選。 */
export function requiredTickers(acct: Account | null, defaults: { core: string; bond: string } = { core: 'VOO', bond: 'SGOV' }): string[] {
  if (!acct) return [defaults.core, defaults.bond];
  const set = new Set<string>([acct.cfg.coreTicker, acct.bondTicker, ...acct.rule.heldMom, ...Object.keys(acct.own)]);
  for (const lots of [acct.lots.own, acct.lots.mom, acct.lots.core, acct.lots.unc]) for (const [t, n] of Object.entries(lots)) if (n) set.add(t);
  set.delete(CASH);
  return [...set];
}
