// T26：條件的所有權（own_thesis §1.4、§1.5）。使用者在持股頁做的三件事：
//   勾選  AI 建議的條件（PROPOSED）→ 你定的條件：寫勾選時間與成立時的動作，狀態依確認方式；有 supersedes 的，被取代的那條 RETIRED
//   撤下  你定的條件 → RETIRED
//   改動作 你定的條件成立時做什麼（出清／減半／重新審查）
// 你定的條件（ACTIVE＋REVIEW_ONLY）一檔最多 8 條。每一次都在 own_thesis_log 寫一筆 CONDITION。
import type { Account } from '../engine';
import { thesisLogStmt } from './ledgerStore';
import { COND_ACTIONS, MAX_OWNED, OWNED_LIVE, acceptStatus, defaultAction, fileConditions, isOwned, type CondAction, type FileCondition } from './thesis';

export class CondError extends Error {}

export type CondOp = 'accept' | 'retire' | 'action';

const isAction = (x: unknown): x is CondAction => COND_ACTIONS.includes(x as CondAction);

/** 一檔現在有幾條會自己發通知的你定的條件（ACTIVE＋REVIEW_ONLY）；except：不算這幾列（被取代的那一條）。 */
export const ownedCount = (conds: FileCondition[], except: number[] = []) => conds.filter((c) => OWNED_LIVE.includes(c.status) && !except.includes(c.id)).length;

/** 上限的檢查：再加 add 條會不會超過 8 條。 */
export function checkCap(conds: FileCondition[], add: number, except: number[] = []): void {
  const n = ownedCount(conds, except);
  if (n + add > MAX_OWNED) throw new CondError(`你定的條件已經有 ${n} 條（上限 ${MAX_OWNED} 條），先撤下一條才能再勾。`);
}

/** CONDITION 那一筆 log（沒有論點檔編號的舊自選不寫）。條件不跟著帳戶的版本走，所以 account_version 是空的（復原快照不會刪）。 */
const logStmt = (db: D1Database, ticker: string, fileId: string | undefined, session: string, at: string, id: number, change: 'ACCEPTED' | 'RETIRED' | 'ACTION_CHANGED', action: CondAction | null) =>
  fileId ? [thesisLogStmt(db, { ticker, fileId, session, kind: 'CONDITION', ref: String(id), body: { id, change, action, by: 'USER' } }, null, at)] : [];

/** 可以被取代的條件狀態（監測中、只在審查時檢查、只記錄、建議中）。 */
export const SUPERSEDABLE: readonly string[] = ['ACTIVE', 'REVIEW_ONLY', 'MANUAL', 'PROPOSED'];

/**
 * 被你勾選的新條件取代（own_thesis §1.5 第 3 點；T40 起出場條件改寫帶 supersedes 的也走這裡）：舊的那條 RETIRED、寫明被哪一條取代，log 寫 CONDITION。
 */
export function supersedeStmts(db: D1Database, ticker: string, fileId: string | undefined, session: string, at: string, old: Pick<FileCondition, 'id' | 'action'>, byText: string): D1PreparedStatement[] {
  return [db.prepare("UPDATE own_conditions SET status = 'RETIRED', note = ? WHERE id = ?").bind(`被你在 ${at.slice(0, 10)} 勾選的「${byText.slice(0, 60)}」取代`, old.id), ...logStmt(db, ticker, fileId, session, at, old.id, 'RETIRED', old.action)];
}

/**
 * 持股頁的條件操作。acct：現在的帳戶（只讀 fileId）；session：訊號日（log 用）。
 * 回傳這一條之後的狀態。不能做時丟 CondError（訊息直接給使用者看）。
 */
export async function conditionOp(db: D1Database, acct: Pick<Account, 'own'>, ticker: string, id: number, op: CondOp, action: unknown, session: string, now: Date): Promise<{ id: number; status: string; action: CondAction | null; retired?: number }> {
  const meta = acct.own[ticker];
  if (!meta) throw new CondError(`${ticker} 不是自選股。`);
  const conds = await fileConditions(db, acct, ticker);
  const c = conds.find((x) => x.id === id);
  if (!c) throw new CondError('找不到這條條件（可能是之前那一份論點檔的）。');
  if (action !== undefined && action !== null && !isAction(action)) throw new CondError('成立時的動作只能是出清、減半或重新審查。');
  const at = now.toISOString();
  const stmts: D1PreparedStatement[] = [];

  if (op === 'accept') {
    if (c.status !== 'PROPOSED') throw new CondError(c.status === 'EXPIRED' ? '這條建議已經過期（之後的審查寫了新的建議）。' : '這條不是建議中的條件，不用再勾。');
    const act: CondAction = isAction(action) ? action : defaultAction(c);
    const status = acceptStatus(c);
    const sup = c.supersedes ? conds.find((x) => x.id === c.supersedes && SUPERSEDABLE.includes(x.status)) : undefined;
    if (OWNED_LIVE.includes(status)) checkCap(conds, 1, sup ? [sup.id] : []);
    stmts.push(db.prepare("UPDATE own_conditions SET status = ?, accepted_at = ?, action = ? WHERE id = ? AND status = 'PROPOSED'").bind(status, at, act, c.id));
    stmts.push(...logStmt(db, ticker, meta.fileId, session, at, c.id, 'ACCEPTED', act));
    if (sup) stmts.push(...supersedeStmts(db, ticker, meta.fileId, session, at, sup, c.text));
    await db.batch(stmts);
    return { id: c.id, status, action: act, ...(sup ? { retired: sup.id } : {}) };
  }

  if (!isOwned(c) || !['ACTIVE', 'REVIEW_ONLY', 'MANUAL'].includes(c.status)) throw new CondError(c.status === 'MET' ? '這條條件已經成立過了（一次性），要再監測就重新定一條。' : '只有你定的、還在監測或記錄中的條件可以撤下或改動作。');
  if (op === 'retire') {
    stmts.push(db.prepare("UPDATE own_conditions SET status = 'RETIRED', note = ? WHERE id = ?").bind(`你在 ${at.slice(0, 10)} 撤下`, c.id));
    stmts.push(...logStmt(db, ticker, meta.fileId, session, at, c.id, 'RETIRED', c.action));
    await db.batch(stmts);
    return { id: c.id, status: 'RETIRED', action: c.action };
  }
  if (op === 'action') {
    if (!isAction(action)) throw new CondError('要選成立時做什麼：出清、減半或重新審查。');
    if (action === c.action) return { id: c.id, status: c.status, action };
    stmts.push(db.prepare('UPDATE own_conditions SET action = ? WHERE id = ?').bind(action, c.id));
    stmts.push(...logStmt(db, ticker, meta.fileId, session, at, c.id, 'ACTION_CHANGED', action));
    await db.batch(stmts);
    return { id: c.id, status: c.status, action };
  }
  throw new CondError(`不認得的操作：${String(op)}`);
}

