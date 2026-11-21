// T72（confirm_audit_design §6）：「這次不做」「不同意，不動」的理由一鍵選。純函式（測試直接 import；畫面在 pages-notif.js）。
// 伺服器給每一項的選項（ItemView.reasonPicks：甲類、慢規則減半、崩盤是「這次不做」的三個，乙類是「不同意」的三個），
// 這裡最後加「其他」：選了「其他」才要自己打字；其他選項的字就是理由。理由的長度與「沒寫不能送出」照舊（伺服器的 missingReasons）。

/** 最後一個選項：選了才出現打字的欄位。 */
export const REASON_OTHER = '其他';

/**
 * 這一項的選項（不含「其他」以外的重複）：先填的字（崩盤項目 AI 檢視說延後時的「照 AI 檢視：延後」）排第一個，再來伺服器給的，最後「其他」。
 * picks 是 null（不用寫理由的項目）→ 空陣列。
 */
export function reasonOptions(picks, prefill = '') {
  if (!Array.isArray(picks)) return [];
  const pre = typeof prefill === 'string' ? prefill.trim() : '';
  return [...new Set([...(pre ? [pre] : []), ...picks, REASON_OTHER])];
}

/**
 * 一開始選哪一個：已經有理由（改決定之後再回覆、或剛剛選過）→ 是選項之一就選它，不是就選「其他」並把字放進打字欄；
 * 沒有理由但有先填的字 → 選先填的那一個；都沒有 → 不選（要使用者自己點）。
 * 回傳 { pick, typed }：pick 是選中的選項（沒有是 null），typed 是打字欄的字。
 */
export function initialReason(options, current = '', prefill = '') {
  const cur = typeof current === 'string' ? current.trim() : '';
  if (cur) return options.includes(cur) && cur !== REASON_OTHER ? { pick: cur, typed: '' } : { pick: REASON_OTHER, typed: cur };
  const pre = typeof prefill === 'string' ? prefill.trim() : '';
  if (pre && options.includes(pre)) return { pick: pre, typed: '' };
  return { pick: null, typed: '' };
}

/** 送出的理由：選了「其他」是打的字；選了別的是選項的字；沒選是空的（要寫理由的項目會被擋下）。 */
export function reasonValue(pick, typed = '') {
  if (pick === REASON_OTHER) return typeof typed === 'string' ? typed.trim() : '';
  return typeof pick === 'string' ? pick : '';
}

/** 打字欄要不要出現：只有選了「其他」。 */
export const needsTyping = (pick) => pick === REASON_OTHER;
