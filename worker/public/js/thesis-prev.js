// 編輯論點頁的「帶入上次的論點」（T44，own_thesis §1.2）：賣光之後又買回時，把上一份論點檔的本文與前提填進右邊。
// 不碰 DOM，測試直接 import。

/**
 * prev：持股頁資料的 own.prev（上一份論點檔）；沒有、或上一份沒有論點本文也沒有自己的前提 → null（不給這個按鈕）。
 * 回傳要填進右邊的：論點本文、前提（一律當成新的一條，不帶上一份的編號：那些編號屬於已經結案的論點檔，
 * 帶過來會和這一份的系統預設前提 P1～P3 撞號）。出場條件不帶，要重新寫（舊的條件不會恢復監測）。
 */
export function prevFill(prev) {
  if (!prev || !prev.hasThesis) return null;
  return {
    thesis: prev.thesis?.text ?? '',
    premises: (prev.premises ?? []).map((p) => ({ id: null, text: p.text })).filter((p) => p.text),
  };
}
