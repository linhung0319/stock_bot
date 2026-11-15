// 帳本的 D1 存取（T6）。引擎的 Account 拆開存：
//   account_state    目前的狀態（去掉 notifs／events／shadow），rev 每次存檔加 1；account_history 留每一版
//   notifications    每則通知一列（含回覆）
//   ledger_events、shadow_records  只增加：引擎只會往這兩個陣列加東西，載入時給空陣列，存檔時把新增的寫進去
//   snapshots        使用者填的快照原文
//   own_thesis_log   論點檔的開檔與結案：存檔時比較存檔前後的自選（fileId），和帳戶同一筆交易寫（own_thesis §1.2）
import type { Account, LedgerEvent, Notif, ShadowRecord } from '../engine/account';
import type { Snapshot } from '../engine/ops';
import { CASH } from '../engine/types';

export class ConflictError extends Error {}

export interface LoadedAccount {
  acct: Account;
  rev: number;
  /** 載入時每則通知的內容，存檔時只寫有變的。 */
  notifJson: Map<number, string>;
  /** 載入時每檔自選的論點檔編號（存檔時比較，寫開檔與結案）。 */
  ownFiles?: Record<string, string | undefined>;
}

type StateOnly = Omit<Account, 'notifs' | 'events' | 'shadow'>;

export async function loadAccount(db: D1Database): Promise<LoadedAccount | null> {
  const row = await db.prepare('SELECT rev, state FROM account_state WHERE id = 1').first<{ rev: number; state: string }>();
  if (!row) return null;
  const notifRows = (await db.prepare('SELECT id, body FROM notifications ORDER BY id').all<{ id: number; body: string }>()).results;
  const state = JSON.parse(row.state) as StateOnly;
  const acct: Account = { ...state, notifs: notifRows.map((r) => JSON.parse(r.body) as Notif), events: [], shadow: [] };
  return { acct, rev: row.rev, notifJson: new Map(notifRows.map((r) => [r.id, r.body])), ownFiles: ownFilesOf(acct) };
}

const ownFilesOf = (acct: Pick<Account, 'own'>): Record<string, string | undefined> => Object.fromEntries(Object.entries(acct.own ?? {}).map(([t, m]) => [t, m.fileId]));

/** PRESS_CHECK：財報新聞稿成立的條件，10-Q／10-K 核對不一致（T29c，own_thesis §1.11 的「log 記一筆」）。 */
export type ThesisLogKind = 'OPEN' | 'THESIS' | 'BREAK_NOTICE' | 'RESPONSE' | 'CONDITION' | 'CLOSE' | 'PRESS_CHECK';
export interface ThesisLogInput {
  ticker: string;
  fileId: string;
  session: string;
  kind: ThesisLogKind;
  ref?: string | null;
  body: Record<string, unknown>;
}
/** 寫一列 own_thesis_log（accountVersion：和哪一版帳戶一起存，復原快照時用來刪）。 */
export const thesisLogStmt = (db: D1Database, l: ThesisLogInput, accountVersion: number | null, at: string) =>
  db.prepare('INSERT INTO own_thesis_log (ticker, file_id, at, session, kind, ref, body, account_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(l.ticker, l.fileId, at, l.session, l.kind, l.ref ?? null, JSON.stringify(l.body), accountVersion);

/**
 * 存檔前後的自選比一比（own_thesis §1.2）：新的論點檔 → OPEN；不見的（移出、出清、股數改 0）→ CLOSE。
 * 沒有 fileId 的舊資料不寫。
 */
export function fileChanges(before: Record<string, string | undefined>, acct: Account, now: Date): ThesisLogInput[] {
  const out: ThesisLogInput[] = [];
  const own = acct.own ?? {};
  const after = new Set(Object.values(own).map((m) => m.fileId).filter(Boolean));
  for (const [t, fid] of Object.entries(before)) {
    if (!fid || after.has(fid)) continue;
    const c = acct.ownClosed?.[t];
    const hit = c?.fileId === fid ? c : null;
    out.push({ ticker: t, fileId: fid, session: hit?.date ?? now.toISOString().slice(0, 10), kind: 'CLOSE', body: { reason: hit?.reason ?? 'REMOVED' } });
  }
  const had = new Set(Object.values(before).filter(Boolean));
  for (const [t, m] of Object.entries(own)) {
    if (!m.fileId || had.has(m.fileId)) continue;
    out.push({
      ticker: t,
      fileId: m.fileId,
      session: m.fileId.slice(t.length + 1, t.length + 11),
      kind: 'OPEN',
      body: { origin: m.origin, premises: m.premises, startState: m.opened?.startState ?? m.slow.state, drawdownAtOpen: m.opened?.drawdownAtOpen ?? null },
    });
  }
  return out;
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
  // 論點檔的開檔與結案（和這一版帳戶一起存，復原快照時一起刪）
  for (const l of fileChanges(prev ? (prev.ownFiles ?? ownFilesOf(prev.acct)) : {}, acct, now)) stmts.push(thesisLogStmt(db, l, rev, at));
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

/** 影子紀錄裡、某一天之後出現過的代號（影子組合要用它們之後的價格，即使已經不持有）。 */
export async function shadowTickers(db: D1Database, since: string): Promise<string[]> {
  const rows = (await db.prepare('SELECT DISTINCT ticker FROM shadow_records WHERE ticker IS NOT NULL AND date >= ?').bind(since).all<{ ticker: string }>()).results;
  return rows.map((r) => r.ticker);
}

/** 每天一定要有最新價格的代號：核心 ETF、短債 ETF、三桶（含未分類）的持股、動能名單、自選。 */
export function requiredTickers(acct: Account | null, defaults: { core: string; bond: string } = { core: 'VOO', bond: 'SGOV' }): string[] {
  if (!acct) return [defaults.core, defaults.bond];
  const set = new Set<string>([acct.cfg.coreTicker, acct.bondTicker, ...acct.rule.heldMom, ...Object.keys(acct.own)]);
  for (const lots of [acct.lots.own, acct.lots.mom, acct.lots.core, acct.lots.unc]) for (const [t, n] of Object.entries(lots)) if (n) set.add(t);
  set.delete(CASH);
  return [...set];
}

// ---------------------------------------------------------------- 復原上一份快照（T14，設計 §10 第 39 點）

export interface SnapshotUndoInfo {
  rev: number;
  date: string;
  at: string;
  /** 那份快照的現金差額與「可能填錯」（待辦頁只在可能填錯時提醒）。 */
  cashOther: number;
  cashWarn: boolean;
}
export interface SnapshotWarn {
  cashOther: number;
  cashWarn: boolean;
}
/** snapshot_undo.notifs 欄位裡的警告（舊的列沒有就當沒事）。 */
export function warnOf(notifsJson: string): SnapshotWarn {
  try {
    const w = (JSON.parse(notifsJson) as { warn?: SnapshotWarn }).warn;
    return { cashOther: w?.cashOther ?? 0, cashWarn: !!w?.cashWarn };
  } catch {
    return { cashOther: 0, cashWarn: false };
  }
}

/**
 * 快照存檔後呼叫：留下送出前的帳戶，好讓使用者復原。只留最後一份（新的蓋掉舊的）。
 * 通知只存這次有變的（送出前的內容）與這次新產生的編號，避免整份通知太大。
 */
export async function saveSnapshotUndo(db: D1Database, rev: number, before: Account, after: Account, date: string, now: Date, warn: SnapshotWarn): Promise<void> {
  const prev = new Map(before.notifs.map((n) => [n.id, JSON.stringify(n)]));
  const changed: Notif[] = [];
  const created: number[] = [];
  for (const n of after.notifs) {
    const p = prev.get(n.id);
    if (p === undefined) created.push(n.id);
    else if (p !== JSON.stringify(n)) changed.push(JSON.parse(p) as Notif);
  }
  const { notifs: _n, events: _e, shadow: _s, ...state } = before;
  await db
    .prepare("INSERT INTO snapshot_undo (mode, rev, date, at, state, notifs) VALUES ('real', ?, ?, ?, ?, ?) ON CONFLICT(mode) DO UPDATE SET rev = excluded.rev, date = excluded.date, at = excluded.at, state = excluded.state, notifs = excluded.notifs")
    .bind(rev, date, now.toISOString(), JSON.stringify(state), JSON.stringify({ changed, created, warn }))
    .run();
}

/** 現在可以復原的快照（帳戶版本還停在那份快照存檔後）；沒有就是 null。 */
export async function snapshotUndoInfo(db: D1Database, currentRev: number | null): Promise<SnapshotUndoInfo | null> {
  const row = await db.prepare("SELECT rev, date, at, notifs FROM snapshot_undo WHERE mode = 'real'").first<{ rev: number; date: string; at: string; notifs: string }>();
  return row && currentRev !== null && row.rev === currentRev ? { rev: row.rev, date: row.date, at: row.at, ...warnOf(row.notifs) } : null;
}

/**
 * 復原：帳戶回到快照送出前（狀態、通知），刪掉那次存檔寫進去的帳本事件、影子紀錄、快照原文。
 * 帳戶版本已經不是那份快照存檔後的（之後有每日流程或其他操作）就拒絕。整批是一筆交易。
 */
export async function undoSnapshot(db: D1Database, now: Date): Promise<{ ok: true; date: string } | { ok: false; reason: string }> {
  const row = await db.prepare("SELECT rev, date, state, notifs FROM snapshot_undo WHERE mode = 'real'").first<{ rev: number; date: string; state: string; notifs: string }>();
  if (!row) return { ok: false, reason: '沒有可以復原的快照。' };
  const cur = await db.prepare('SELECT rev FROM account_state WHERE id = 1').first<{ rev: number }>();
  if (!cur || cur.rev !== row.rev) return { ok: false, reason: '這份快照之後帳戶已經有其他變動（每日流程或其他操作），不能復原了。請再填一次快照修正。' };
  const at = now.toISOString();
  const { changed, created } = JSON.parse(row.notifs) as { changed: Notif[]; created: number[] };
  const upsert = db.prepare('INSERT INTO notifications (id, kind, date, status, updated_at, body) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, status = excluded.status, updated_at = excluded.updated_at, body = excluded.body');
  const stmts: D1PreparedStatement[] = [
    // 版本加 1（history 的主鍵擋住同時發生的存檔）
    db.prepare('INSERT INTO account_history (rev, at, cause, state) VALUES (?, ?, ?, ?)').bind(row.rev + 1, at, `復原快照（${row.date}，版本 ${row.rev}）`, row.state),
    db.prepare('UPDATE account_state SET rev = ?, updated_at = ?, state = ? WHERE id = 1 AND rev = ?').bind(row.rev + 1, at, row.state, row.rev),
    ...changed.map((n) => upsert.bind(n.id, n.kind, n.date, n.status, at, JSON.stringify(n))),
    ...created.map((id) => db.prepare('DELETE FROM notifications WHERE id = ?').bind(id)),
    db.prepare('DELETE FROM ledger_events WHERE rev = ?').bind(row.rev),
    db.prepare('DELETE FROM shadow_records WHERE rev = ?').bind(row.rev),
    db.prepare('DELETE FROM snapshots WHERE rev = ?').bind(row.rev),
    // 那一版寫的論點檔紀錄（開檔、結案…）：帳戶回到之前，論點檔編號與條件也就接回來（own_thesis §1.2）
    db.prepare('DELETE FROM own_thesis_log WHERE account_version = ?').bind(row.rev),
    db.prepare("DELETE FROM snapshot_undo WHERE mode = 'real'"),
  ];
  try {
    await db.batch(stmts);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/UNIQUE|constraint/i.test(msg)) return { ok: false, reason: '帳戶剛好被另一個操作更新，不能復原了。請重新整理。' };
    throw e;
  }
  return { ok: true, date: row.date };
}

/**
 * 帳戶已經存好之後還要改一點東西（開 AI 執行時記狀態、推播之後記「講過了」）：重新讀、改、存；和網站同時存檔時重來，最多 3 次。
 * fn 回傳 null = 不用存。stmts：和帳戶同一筆交易要寫的語句。回傳存好的帳戶（沒有存是 null）；存不成只記在 log。
 */
export async function patchAccount(db: D1Database, now: Date, cause: string, fn: (acct: Account) => { acct: Account; stmts?: D1PreparedStatement[] } | null, log?: string[]): Promise<Account | null> {
  for (let k = 0; k < 3; k++) {
    const loaded = await loadAccount(db);
    if (!loaded) return null;
    const next = fn(loaded.acct);
    if (!next) return null;
    try {
      await saveAccount(db, next.acct, loaded, cause, now, next.stmts ?? []);
      return next.acct;
    } catch (e) {
      if (!(e instanceof ConflictError) || k === 2) {
        log?.push(`${cause}：帳戶沒有存成（${e instanceof Error ? e.message : String(e)}）`);
        return null;
      }
    }
  }
  return null;
}
