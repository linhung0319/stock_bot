// 小工具：建立 DOM（不用 innerHTML，使用者寫的理由、前提不會被當成 HTML 執行）、數字格式。

/** h('div', { class: 'x', onclick: fn }, 子節點…)；子節點可以是字串、節點、陣列、null。 */
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'value' && 'value' in el) el.value = v;
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  add(el, kids);
  return el;
}
function add(el, kid) {
  if (kid === null || kid === undefined || kid === false) return;
  if (Array.isArray(kid)) kid.forEach((k) => add(el, k));
  else el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
}

/** 把 el 的內容換成這些子節點（可以是陣列、null；和 h() 的子節點規則相同）。 */
export function put(el, ...kids) {
  el.replaceChildren();
  add(el, kids);
}
/** 在 el 後面加上這些子節點（規則同上）。 */
export function push(el, ...kids) {
  add(el, kids);
}

export const SVG = 'http://www.w3.org/2000/svg';
export function s(tag, attrs, ...kids) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs ?? {})) if (v !== null && v !== undefined) el.setAttribute(k, String(v));
  for (const k of kids.flat(Infinity)) if (k !== null && k !== undefined) el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return el;
}

export const money = (x, digits = 0) => (Number.isFinite(x) ? (x < 0 ? '−$' : '$') + Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }) : '—');
export const pct = (x, d = 1) => (Number.isFinite(x) ? (x * 100).toFixed(d) + '%' : '—');
export const signedPct = (x, d = 0) => (Number.isFinite(x) ? (x > 0 ? '+' : x < 0 ? '−' : '') + Math.abs(x * 100).toFixed(d) + '%' : '—');
export const qty = (n) => Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 4 });

const WD = ['日', '一', '二', '三', '四', '五', '六'];
/** 2026-12-01 → 12/1（二） */
export function day(date, withYear = false) {
  if (!date) return '';
  const d = new Date(date + 'T00:00:00Z');
  return `${withYear ? d.getUTCFullYear() + '/' : ''}${d.getUTCMonth() + 1}/${d.getUTCDate()}（${WD[d.getUTCDay()]}）`;
}

/** 「賣 ORCL 28 股」「2026-12 月報」之類的標題：代號與數字（含日期、金額、百分比）用窄體，中文用標題的明體。 */
export function actionText(text) {
  const out = [];
  const re = /([A-Z][A-Z0-9.]{0,6})|([$+−]?\d(?:[\d,./-]*\d)?%?)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(h('span', { class: m[1] ? 'tk' : 'n' }, m[0]));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function toast(msg) {
  const box = document.getElementById('toast');
  const el = h('div', null, msg);
  box.append(el);
  setTimeout(() => el.remove(), 2600);
}
