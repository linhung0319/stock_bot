// 編輯論點頁的「網頁證據的來源」（T52，web_evidence_design §1.3）：這檔的同業與專用的一手網站。只求能用，版面之後整理。
// 存檔照論點的同一個按鈕（POST /ops/own-thesis 的 webSources，有改動才送）；存檔前伺服器先試抓一次，抓不到的仍存、標「目前抓不到」。
import { api } from './api.js';
import { h, put } from './dom.js';
import { actionButton, errBox } from './pages-notif.js';

const LIMITS = { peers: 4, domains: 6 };

/** 試抓結果的那一項叫什麼（key：edgar:MU、yahoo:000660.KS、domain:news.skhynix.com）。 */
export function sourceLabel(key) {
  const i = key.indexOf(':');
  const [k, v] = [key.slice(0, i), key.slice(i + 1)];
  return k === 'edgar' ? `EDGAR ${v}（申報）` : k === 'yahoo' ? `Yahoo ${v}（新聞連結）` : `網站 ${v}`;
}

/** 一項試抓結果：抓得到／目前抓不到／沒有試，旁邊是原因。 */
const checkRow = (c) =>
  h(
    'li',
    { class: 'src-check' },
    h('span', { class: 'chip ' + (c.ok === true ? 'ok' : c.ok === false ? 'warn' : '') }, c.ok === true ? '抓得到' : c.ok === false ? '目前抓不到' : '沒有試'),
    h('span', { class: 'small' }, `${sourceLabel(c.key)}：${c.why}`),
  );

export const checkList = (items) => (items?.length ? h('ul', { class: 'src-checks' }, items.map(checkRow)) : null);

/** 「現在的」那一欄：存著的同業與網站，以及存檔時試抓的結果。 */
export function sourcesNow(ws, defaultOnly) {
  if (!ws) return h('p', { class: 'small faint', style: 'margin-top:4px' }, '沒有指定（審查只看這檔自己新聞裡、共用清單內的網站）');
  const items = ws.checked?.items ?? [];
  const failed = items.filter((c) => c.ok === false).length;
  const untried = items.filter((c) => c.ok === null).length;
  return h(
    'div',
    { class: 'small', style: 'margin-top:4px' },
    ws.peers.length ? h('p', null, `同業：${ws.peers.map((p) => `${p.name}（${[p.edgar && `EDGAR ${p.edgar}`, p.yahoo && `Yahoo ${p.yahoo}`].filter(Boolean).join('、')}）`).join('；')}`) : null,
    ws.domains.length ? h('p', null, `這檔的網站：${ws.domains.join('、')}`) : null,
    ws.checked ? h('p', { class: failed ? null : 'faint', style: failed ? 'color:var(--warn)' : null }, failed ? `存檔時試抓：${failed} 項目前抓不到（仍存著，抓得到之後就會用）` : untried === items.length ? '存檔時沒有真的試抓（原因在下面）' : untried ? `存檔時試抓：${untried} 項沒有試，其他都抓得到` : '存檔時試抓：都抓得到') : null,
    checkList(ws.checked?.items),
    defaultOnly ? h('p', { class: 'faint' }, '這檔目前只有系統預設前提：來源先存著，寫了自己的前提之後審查才會用。') : null,
  );
}

const norm = (ws) => JSON.stringify(ws ? { p: ws.peers.map((p) => [p.name, p.edgar ?? '', p.yahoo ?? '']), d: ws.domains } : null);

/**
 * 「新的」那一欄的編輯區。ticker：這檔；ws：現在存著的；onChange：改了就叫（重算預覽）。
 * 回傳 { el, value()：送出去的 webSources（全空是 null）, changed()：和現在存著的不同 }。
 */
export function sourcesEditor(ticker, ws, onChange) {
  const peerList = h('div');
  const domList = h('div');
  const peers = [];
  const doms = [];
  const inp = (v, ph, label, max) => {
    const el = h('input', { type: 'text', maxlength: max, value: v ?? '', placeholder: ph, 'aria-label': label });
    el.addEventListener('input', onChange);
    return el;
  };
  const rm = (fn) => h('button', { class: 'btn quiet', type: 'button', 'aria-label': '拿掉這一項', onclick: fn }, '拿掉');
  const addPeer = (p = {}) => {
    if (peers.length >= LIMITS.peers) return;
    const r = { name: inp(p.name, '名稱，例如 SK 海力士', '同業名稱', 60), edgar: inp(p.edgar, 'EDGAR 代號', 'EDGAR 代號', 12), yahoo: inp(p.yahoo, 'Yahoo 代號', 'Yahoo 代號', 20) };
    r.el = h(
      'div',
      { class: 'src-peer' },
      r.name,
      h('div', { class: 'src-codes' }, r.edgar, r.yahoo),
      rm(() => {
        peers.splice(peers.indexOf(r), 1);
        r.el.remove();
        onChange();
      }),
    );
    peers.push(r);
    peerList.append(r.el);
  };
  const addDom = (d = '') => {
    if (doms.length >= LIMITS.domains) return;
    const r = { input: inp(d, '例如 news.skhynix.com', '網站', 200) };
    r.el = h(
      'div',
      { class: 'src-dom' },
      r.input,
      rm(() => {
        doms.splice(doms.indexOf(r), 1);
        r.el.remove();
        onChange();
      }),
    );
    doms.push(r);
    domList.append(r.el);
  };
  for (const p of ws?.peers ?? []) addPeer(p);
  for (const d of ws?.domains ?? []) addDom(d);
  const value = () => {
    const ps = peers.map((r) => ({ name: r.name.value.trim(), edgar: r.edgar.value.trim().toUpperCase(), yahoo: r.yahoo.value.trim().toUpperCase() })).filter((p) => p.name || p.edgar || p.yahoo);
    const ds = doms.map((r) => r.input.value.trim()).filter(Boolean);
    return ps.length || ds.length ? { peers: ps.map((p) => ({ name: p.name, ...(p.edgar ? { edgar: p.edgar } : {}), ...(p.yahoo ? { yahoo: p.yahoo } : {}) })), domains: ds } : null;
  };
  const probeMsg = h('div');
  const probe = actionButton('試抓這些來源', '', async () => {
    const v = value();
    if (!v) return put(probeMsg, h('p', { class: 'small faint', style: 'margin-top:6px' }, '還沒有填任何來源。'));
    try {
      const r = await api.post('/ops/own-sources/probe', { ticker, webSources: v });
      const bad = r.items.filter((c) => c.ok === false).length;
      put(probeMsg, h('p', { class: 'small', style: `margin-top:6px${bad ? ';color:var(--warn)' : ''}` }, bad ? `${bad} 項目前抓不到：仍可以存，網站會標「目前抓不到」，審查時取不到它的文件。` : r.items.every((c) => c.ok === null) ? '沒有真的試抓（原因在下面）；還沒存。' : '試抓完成，都抓得到（還沒存）。'), checkList(r.items));
    } catch (e) {
      put(probeMsg, errBox(e));
    }
  });
  const el = h(
    'div',
    { class: 'field src-edit', style: 'margin:16px 0 0' },
    h('span', null, '網頁證據的來源（選填）'),
    h('small', null, `審查時 AI 可以另外讀的同業申報與網站。同業最多 ${LIMITS.peers} 家：填 EDGAR 代號（美股，例如 MU）會列出它在 SEC 的申報，填 Yahoo 代號（例如 000660.KS）會看它新聞裡的連結，至少填一個。這檔專用的網站最多 ${LIMITS.domains} 個（公司與同業的新聞室、投資人關係網站）。TrendForce 這類共用的產業來源不用另外加；評論與社群網站加不進來。存檔時會先試抓一次，抓不到的仍會存。`),
    h('b', { class: 'small', style: 'margin-top:4px' }, '同業'),
    peerList,
    h('div', null, h('button', { class: 'linkbtn', type: 'button', onclick: () => { addPeer(); onChange(); } }, '再加一家同業')),
    h('b', { class: 'small', style: 'margin-top:4px' }, '這檔的網站'),
    domList,
    h('div', null, h('button', { class: 'linkbtn', type: 'button', onclick: () => { addDom(); onChange(); } }, '再加一個網站')),
    h('div', { class: 'btn-row', style: 'margin-top:6px' }, probe),
    probeMsg,
  );
  return { el, value, changed: () => norm(value()) !== norm(ws) };
}
