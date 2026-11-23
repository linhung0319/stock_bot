// 審查提到、你的前提沒有涵蓋的事（T63，composite_layer_design §3）：不碰 DOM 的部分（文字、按鈕的狀態、預覽的那一句），測試直接 import。
// 畫面在 pages-thesis.js（編輯論點頁右欄上面的那一塊：帶進右欄再改字）、pages-holding.js（持股頁的審查那一塊）與 pages-ai.js（紀錄頁的「新眼光」那一塊）。
// T71（confirm_audit_design §4）：不再列進「要看的事」，「看過了，不加」拿掉（伺服器的端點 T88 拿掉）。

/** 處理過的同一件事幾天內不再列（和伺服器的 RISK_SEEN_DAYS 同一個數字；伺服器回的 days 為準）。 */
export const RISK_DAYS = 180;

/** 那一塊的標題與說明。 */
export const RISK_TITLE = '審查提到、你的前提沒有涵蓋的事';
export const RISK_INTRO = '審查時有一個角色不看你的前提，只讀原文，列出持有者最可能後悔的事；和你現有的前提重複的已經拿掉。這些只是建議：不影響審查的結論與部位，要不要加一條前提由你決定。';

/** 2026-11-20 → 11/20。 */
const md = (d) => (d ? `${Number(String(d).slice(5, 7))}/${Number(String(d).slice(8, 10))}` : '');

/** 一件下面的小字：哪一次提的、依據哪一份。只有新聞標題的寫明（標題不是事實，只是線索）。 */
export function riskMeta(r) {
  return `${md(r.date)} 的${r.label}提的；依據：${r.source}${r.headline ? '（只有新聞標題，沒有讀到全文：當成線索）' : ''}`;
}

/** 帶進右欄之後，那一條前提下面的提醒：它是一件風險，要改寫成「要繼續成立的事」。 */
export const RISK_ROW_HINT = '從審查提到的風險帶來的：它寫的是一件可能出錯的事，請改寫成「要繼續成立的事」（例如把「現貨價下跌」寫成「現貨價沒有持續下跌」），再填怎樣算不成立。存檔後這一件不再另外列出。';

/** 一件的按鈕狀態：taken 已經帶進右欄（按鈕停用，右欄拿掉那一條才能再帶）。T71 拿掉「看過了，不加」，T88 拿掉留著的 dismiss 欄位。 */
export function riskButtons(taken) {
  return taken ? { take: null, note: '已經帶進「新的」，在右邊改字；不要了就在那一條按「拿掉」。' } : { take: '帶進右欄', note: null };
}

/** 存檔前的預覽：從這裡帶進來幾條（伺服器回的 preview.risks）。沒有 → null。 */
export function riskPreviewLine(risks, days = RISK_DAYS) {
  const n = risks?.length ?? 0;
  return n ? `從審查提到的風險帶進來 ${n} 條：存檔後這 ${n} 件不再另外列在持股頁與這裡（${days} 天內同一件事也不再列）。` : null;
}
