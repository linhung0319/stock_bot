// 首頁的市場摘要那一行（T65，composite_layer_design §1.8）：不碰 DOM 的部分（字），測試直接 import。畫面在 pages-notif.js 的 homePage。
/** 2026-11-05 → 11/5（這一行不寫星期，免得太長）。 */
const md = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;

/**
 * 最近 10 個交易日內有寫好的摘要時才有（伺服器的 homeBrief；沒有是 null）。
 * 第一個原因一律標「報導的說法」與信心；原因不明照寫。只說明，不用操作；連到那一次的 AI 紀錄。
 */
export function homeBriefText(b) {
  if (!b) return null;
  return {
    head: `市場摘要（${md(b.session)} ${b.stage === 'FINAL' ? '定稿' : '暫定稿'}，涵蓋 ${md(b.period.from)}～${md(b.period.to)}）`,
    text: b.tag ? `${b.tag}：${b.text}` : `${b.text}：沒有找到說得通的原因`,
    note: '大盤或你持股的族群最近大幅波動，這是報導怎麼說。只說明，不用操作；自選股的審查會把它當背景讀。',
  };
}
