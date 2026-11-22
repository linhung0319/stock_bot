// T26：條件的所有權（own_thesis §1.4、§1.5）。使用者在持股頁做的事：
//   勾選  舊資料的 AI 建議（PROPOSED）→ 你定的條件：寫勾選時間與成立時的動作，狀態依確認方式；有 supersedes 的，被取代的那條 RETIRED
//         （T71 起審查不再寫 PROPOSED，持股頁也沒有勾選的按鈕；端點留著給舊資料）
//   撤下  你定的條件、AI 監測中的條件 → RETIRED
//   改動作 你定的條件成立時做什麼（出清／減半／重新審查；加碼條件是補到標準比重／提高到 125%，T84）。出場與加碼之間不能只改動作互換
//         （要回編輯論點頁重寫，改寫的對照才寫得出「成立時：買進」）
//         AI 監測中的條件（T71，confirm_audit_design §3）改成出清或減半 → 寫 accepted_at，變成你定的（之後的審查換不掉）；
//         有 supersedes 的，被取代的那條 RETIRED（和勾選同一套）
// 你定的條件（ACTIVE＋REVIEW_ONLY）一檔最多 8 條；AI 監測中的另算（最多 3 條，由審查寫入時維持）。每一次都在 own_thesis_log 寫一筆 CONDITION。
import { fileMeta, type Account } from '../engine';
import { thesisLogStmt } from './ledgerStore';
import { COND_ACTIONS, MAX_OWNED, OWNED_LIVE, acceptStatus, defaultAction, entryConditions, fileConditions, isAddAction, isAiWatch, isEntryAction, isOwned, sameActionKind, type CondAction, type FileCondition } from './thesis';

export class CondError extends Error {}

export type CondOp = 'accept' | 'retire' | 'action';

const isAction = (x: unknown): x is CondAction => COND_ACTIONS.includes(x as CondAction);

/**
 * 一檔現在有幾條會自己發通知的你定的條件（ACTIVE＋REVIEW_ONLY）；except：不算這幾列（被取代的那一條）。
 * AI 監測中的（T71：同樣是 ACTIVE／REVIEW_ONLY，但不是你定的）不算，它們另算 3 條。
 */
// 進場條件（T85，allocation_redesign §4.5 第 11 點）另算、不占這 8 條（改寫確認時 conds 會帶候補的非價格進場條件）
export const ownedCount = (conds: FileCondition[], except: number[] = []) => conds.filter((c) => isOwned(c) && OWNED_LIVE.includes(c.status) && !isEntryAction(c.action) && !except.includes(c.id)).length;

/** 上限的檢查：再加 add 條會不會超過 8 條。 */
export function checkCap(conds: FileCondition[], add: number, except: number[] = []): void {
  const n = ownedCount(conds, except);
  if (n + add > MAX_OWNED) throw new CondError(`你定的條件已經有 ${n} 條（上限 ${MAX_OWNED} 條），先撤下一條才能再加。`);
}

/** CONDITION 那一筆 log（沒有論點檔編號的舊自選不寫）。條件不跟著帳戶的版本走，所以 account_version 是空的（復原快照不會刪）。 */
const logStmt = (db: D1Database, ticker: string, fileId: string | undefined, session: string, at: string, id: number, change: 'ACCEPTED' | 'RETIRED' | 'ACTION_CHANGED', action: CondAction | null, extra: Record<string, unknown> = {}) =>
  fileId ? [thesisLogStmt(db, { ticker, fileId, session, kind: 'CONDITION', ref: String(id), body: { id, change, action, by: 'USER', ...extra } }, null, at)] : [];

// T68（confirm_audit_design §1.6）：勾選條件時選「用哪個網頁來源確認」拿掉了（使用者沒有判斷網站的依據）。
// 條件寫的 web:<網域> 原樣存；能不能確認成立看審查時那個網域的級別（一手或產業研究機構才算），排除列表的在檢查時就改標只記錄。

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
export async function conditionOp(db: D1Database, acct: Pick<Account, 'own'> & Partial<Pick<Account, 'watch'>>, ticker: string, id: number, op: CondOp, action: unknown, session: string, now: Date): Promise<{ id: number; status: string; action: CondAction | null; retired?: number }> {
  // 候補的論點檔也有條件（allocation_redesign §4.5 第 3 點）
  const meta = fileMeta(acct, ticker)?.meta;
  if (!meta) throw new CondError(`${ticker} 不是自選股，也不在候補名單裡。`);
  const conds = await fileConditions(db, acct, ticker);
  const c = conds.find((x) => x.id === id);
  if (!c) {
    // 進場條件（T85，allocation_redesign §4.5 第 20 點）：fileConditions 看不到，另外讀；非價格的只能撤下（動作只有一種），
    // 價格條件在候補那一塊整組改（ops/watch-price）
    const e = (await entryConditions(db, acct, ticker)).find((x) => x.id === id);
    if (!e) throw new CondError('找不到這條條件（可能是之前那一份論點檔的）。');
    if (e.kind === 'PRICE') throw new CondError('價格條件在候補那一塊改：清掉那一列的數字再按「存進場條件」。');
    if (op !== 'retire') throw new CondError('進場條件成立時只有一種動作（候補進場，先買一半），只能撤下；要改字到編輯論點頁的「進場條件」那一塊。');
    if (!['ACTIVE', 'REVIEW_ONLY', 'MANUAL'].includes(e.status)) throw new CondError(e.status === 'MET' ? '這條進場條件已經成立過了（一次性），要再等就重新定一條。' : '這條進場條件已經不在監測中。');
    const at = now.toISOString();
    await db.batch([db.prepare("UPDATE own_conditions SET status = 'RETIRED', note = ? WHERE id = ?").bind(`你在 ${at.slice(0, 10)} 撤下`, e.id), ...logStmt(db, ticker, meta.fileId, session, at, e.id, 'RETIRED', 'ENTRY')]);
    return { id: e.id, status: 'RETIRED', action: 'ENTRY' };
  }
  if (action !== undefined && action !== null && !isAction(action)) throw new CondError('成立時的動作只能是出清、減半或重新審查（加碼條件是補到標準比重或提高到 125%）。');
  // AI 不能自己提加碼條件（allocation_redesign §4.2）：AI 建議的、AI 監測中的條件不能變成加碼條件
  if (isAddAction(action) && !isOwned(c)) throw new CondError('AI 建議的條件不能改成加碼（AI 不能自己提加碼條件）；要加碼條件，到編輯論點頁自己寫一條。');
  const at = now.toISOString();
  const stmts: D1PreparedStatement[] = [];

  if (op === 'accept') {
    if (c.status !== 'PROPOSED') throw new CondError(c.status === 'EXPIRED' ? '這條建議已經過期（之後的審查寫了新的建議）。' : '這條不是建議中的條件，不用再勾。');
    const act: CondAction = isAction(action) ? action : defaultAction(c);
    const check = c.check;
    const status = acceptStatus(c);
    const sup = c.supersedes ? conds.find((x) => x.id === c.supersedes && SUPERSEDABLE.includes(x.status)) : undefined;
    if (OWNED_LIVE.includes(status)) checkCap(conds, 1, sup ? [sup.id] : []);
    stmts.push(db.prepare("UPDATE own_conditions SET status = ?, accepted_at = ?, action = ?, check_json = ? WHERE id = ? AND status = 'PROPOSED'").bind(status, at, act, JSON.stringify(check), c.id));
    stmts.push(...logStmt(db, ticker, meta.fileId, session, at, c.id, 'ACCEPTED', act));
    if (sup) stmts.push(...supersedeStmts(db, ticker, meta.fileId, session, at, sup, c.text));
    await db.batch(stmts);
    return { id: c.id, status, action: act, ...(sup ? { retired: sup.id } : {}) };
  }

  // AI 監測中的條件（T71）：可以撤下；改成出清或減半就變成你定的
  if (isAiWatch(c)) {
    if (op === 'retire') {
      stmts.push(db.prepare("UPDATE own_conditions SET status = 'RETIRED', note = ? WHERE id = ?").bind(`你在 ${at.slice(0, 10)} 撤下（AI 監測中的條件）`, c.id));
      stmts.push(...logStmt(db, ticker, meta.fileId, session, at, c.id, 'RETIRED', c.action, { aiWatch: true }));
      await db.batch(stmts);
      return { id: c.id, status: 'RETIRED', action: c.action };
    }
    if (op === 'action') {
      if (!isAction(action)) throw new CondError('要選成立時做什麼：出清、減半或重新審查。');
      // 重新審查本來就是 AI 監測中的動作：不變（要讓之後的審查換不掉，改成出清或減半）
      if (action === 'REVIEW') return { id: c.id, status: c.status, action: 'REVIEW' };
      const sup = c.supersedes ? conds.find((x) => x.id === c.supersedes && x.id !== c.id && SUPERSEDABLE.includes(x.status)) : undefined;
      if (OWNED_LIVE.includes(c.status)) checkCap(conds, 1, sup ? [sup.id] : []);
      stmts.push(db.prepare('UPDATE own_conditions SET action = ?, accepted_at = ? WHERE id = ? AND accepted_at IS NULL').bind(action, at, c.id));
      stmts.push(...logStmt(db, ticker, meta.fileId, session, at, c.id, 'ACCEPTED', action, { from: 'AI_WATCH' }));
      if (sup) stmts.push(...supersedeStmts(db, ticker, meta.fileId, session, at, sup, c.text));
      await db.batch(stmts);
      return { id: c.id, status: c.status, action, ...(sup ? { retired: sup.id } : {}) };
    }
    throw new CondError(`不認得的操作：${String(op)}`);
  }
  if (!isOwned(c) || !['ACTIVE', 'REVIEW_ONLY', 'MANUAL'].includes(c.status)) throw new CondError(c.status === 'MET' ? '這條條件已經成立過了（一次性），要再監測就重新定一條。' : '只有你定的或 AI 監測中、還在監測或記錄中的條件可以撤下或改動作。');
  if (op === 'retire') {
    stmts.push(db.prepare("UPDATE own_conditions SET status = 'RETIRED', note = ? WHERE id = ?").bind(`你在 ${at.slice(0, 10)} 撤下`, c.id));
    stmts.push(...logStmt(db, ticker, meta.fileId, session, at, c.id, 'RETIRED', c.action));
    await db.batch(stmts);
    return { id: c.id, status: 'RETIRED', action: c.action };
  }
  if (op === 'action') {
    if (!isAction(action)) throw new CondError('要選成立時做什麼：出清、減半或重新審查。');
    if (action === c.action) return { id: c.id, status: c.status, action };
    if (!sameActionKind(action, c.action ?? 'REVIEW')) throw new CondError(isAddAction(action) ? '出場條件不能直接改成加碼條件：到編輯論點頁把它寫成加碼條件，送去改寫、確認之後才生效。' : '加碼條件不能直接改成出場條件：到編輯論點頁把它寫成出場條件，送去改寫、確認之後才生效。');
    stmts.push(db.prepare('UPDATE own_conditions SET action = ? WHERE id = ?').bind(action, c.id));
    stmts.push(...logStmt(db, ticker, meta.fileId, session, at, c.id, 'ACTION_CHANGED', action));
    await db.batch(stmts);
    return { id: c.id, status: c.status, action };
  }
  throw new CondError(`不認得的操作：${String(op)}`);
}

