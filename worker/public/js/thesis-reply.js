// 編輯論點頁的「這是對通知的回應」要不要出現、預設勾不勾（own_thesis §1.8，T39b）。
// 不碰 DOM，測試直接 import。

/**
 * notifParam：網址帶的通知編號（從通知進來：#/h/<代號>/thesis/<通知>），沒有是 null。
 * pendingNotif：這檔還沒回覆的乙類通知編號（可以用「修正論點」回應的那一則），沒有是 null。
 * 回傳 null = 不顯示這個勾選；否則 { notif, checked }：
 *   有還沒回覆的乙類就顯示（網址帶的是別的通知時不顯示）；
 *   只有從那則通知進來才預設勾著，從持股頁直接進來預設不勾，讓你自己勾。
 */
export function replyOption(notifParam, pendingNotif) {
  if (pendingNotif === null || pendingNotif === undefined) return null;
  const fromNotif = notifParam !== null && notifParam !== undefined;
  if (fromNotif && Number(notifParam) !== Number(pendingNotif)) return null;
  return { notif: pendingNotif, checked: fromNotif };
}
