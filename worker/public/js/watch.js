// 候補名單（allocation_redesign §4.5，T85）：帳戶頁自選下面那一塊（加、改比重、移除）與候補的詳細頁那一塊。
// 候補 = 還沒持有、想等條件到了再買的股票。加進來不下單、不發通知；系統每天抓價格、替它開一份論點檔。
import { api } from './api.js';
import { day, h, money, pct, toast } from './dom.js';
import { glass } from './layout.js';
import { actionButton, errBox, linkButton } from './pages-notif.js';

/** 填的是百分比（5 代表 5%）；空的 = 留空（用推薦值）。回傳小數或 null。 */
function weightOf(input) {
  const raw = input.value.replace(/[%\s]/g, '');
  if (!raw) return null;
  const v = Number(raw);
  if (!(v >= 0.1 && v <= 50)) throw new Error('比重填百分比，0.1～50；例如 4 代表 4%。不確定就留空，用推薦值');
  return v / 100;
}

const weightText = (x) => (x.stdWeight !== null ? `打算放 ${pct(x.stdWeight)}` : x.recWeight !== null ? `留空（推薦 ${pct(x.recWeight)}）` : '比重留空');

/** 一列候補：代號（連到詳細頁）、加入日、那一句話、比重、價格與距高點。 */
function watchRow(ctx, x) {
  const msg = h('div');
  const priceLine = x.priceMissing ? h('span', { class: 'tone-warn' }, '價格抓不到（代號可能打錯或已下市；不影響其他股票的訊號）') : h('span', { class: 'dim' }, `收盤 ${money(x.price, 2)}`, x.fromHigh === null ? '' : x.fromHigh > -0.0005 ? '，在 52 週高點' : `，比 52 週高點低 ${pct(-x.fromHigh)}`);
  const remove = linkButton('移除', async () => {
    if (!window.confirm(`把 ${x.ticker} 移出候補？它的論點檔會結案（之後再加回來是新的一份，看得到這一次寫的論點）。`)) return;
    try {
      await api.post('/ops/watch-remove', { ticker: x.ticker });
      toast(`${x.ticker} 已移出候補`);
      ctx.refresh();
    } catch (e) {
      msg.replaceChildren(errBox(e));
    }
  });
  return h(
    'div',
    { class: 'hold watch-row' },
    h('div', null, h('a', { class: 'tk', href: `#/h/${encodeURIComponent(x.ticker)}` }, x.ticker), h('span', { class: 'small faint', style: 'margin-left:12px;white-space:nowrap' }, `${day(x.addedAt)} 加入`)),
    h('div', { class: 'val small' }, weightText(x)),
    h(
      'div',
      { class: 'state' },
      x.note ? h('p', { style: 'margin:0 0 4px' }, `「${x.note}」`) : null,
      h('p', { class: 'small', style: 'margin:0' }, priceLine, h('span', { class: 'faint', style: 'margin-left:10px' }, x.kind === 'THESIS' ? '有你的論點' : x.hasThesisText ? '有論點本文' : '還沒有論點'), x.draft ? h('span', { class: 'chip now', style: 'margin-left:10px' }, x.draft) : null),
      x.entries.length ? h('ul', { class: 'small', style: 'margin:6px 0 0;padding-left:1.4em' }, x.entries.map((e) => h('li', null, `${e.text}：${e.state}`))) : null,
      x.blocked ? h('p', { class: 'small tone-warn', style: 'margin:4px 0 0' }, x.blocked) : null,
      h('div', { class: 'btn-row', style: 'margin-top:6px' }, h('a', { class: 'linkbtn', href: `#/h/${encodeURIComponent(x.ticker)}` }, '論點與比重'), remove),
      msg,
    ),
  );
}

/** 加候補的表單：代號、為什麼想買（選填）、比重（選填）。滿了就換成一句話。 */
function addForm(ctx, a) {
  if (a.watch.length >= a.watchMax) return h('p', { class: 'pad small dim watch-full' }, `候補已經有 ${a.watchMax} 檔（上限）：要加新的，先移除一檔。`);
  const msg = h('div');
  const tk = h('input', { type: 'text', maxlength: 10, placeholder: '例如 AMD', autocapitalize: 'characters', 'aria-label': '代號', style: 'max-width:9em' });
  const note = h('input', { type: 'text', maxlength: 300, placeholder: '一句話就好，之後寫論點時當開場', 'aria-label': '為什麼想買' });
  const w = h('input', { class: 'num-in short', type: 'text', inputmode: 'decimal', placeholder: '留空', 'aria-label': '打算放的比重（%）' });
  const go = actionButton('加進候補', 'primary', async () => {
    const t = tk.value.trim();
    if (!t) return msg.replaceChildren(errBox(new Error('先填代號')));
    let std;
    try {
      std = weightOf(w);
    } catch (e) {
      return msg.replaceChildren(errBox(e));
    }
    try {
      const r = await api.post('/ops/watch-add', { ticker: t, note: note.value.trim(), stdWeight: std });
      toast(`${r.ticker} 加進候補了：不會下單，論點檔開好了`);
      ctx.refresh();
    } catch (e) {
      msg.replaceChildren(errBox(e));
    }
  });
  const form = h(
    'form',
    { class: 'pad watch-add', onsubmit: (ev) => ev.preventDefault() },
    h('label', { class: 'field' }, h('span', null, '代號'), tk),
    h('label', { class: 'field' }, h('span', null, '為什麼想買（可以不寫）'), note, h('small', null, '只當之後討論、草擬論點時的開場，不是前提。')),
    h('label', { class: 'field' }, h('span', null, '打算放的比重（可以不寫）'), h('div', { style: 'display:flex;align-items:center;gap:8px' }, w, '%'), h('small', null, '占總資產的百分比。留空就用推薦值（自選的預算裡，依波動度分配）；之後在這一檔的頁面可以改。')),
    h('div', { class: 'btn-row' }, go),
    msg,
  );
  form.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && ev.target.tagName === 'INPUT') {
      ev.preventDefault();
      go.click();
    }
  });
  return form;
}

/** 帳戶頁：自選下面的「候補」那一塊。 */
export function watchSection(ctx, a) {
  const rows = a.watch ?? [];
  return h(
    'section',
    { class: 'watch-sec', 'data-b': 'own' },
    h('h2', { class: 'sec' }, '候補', h('span', { class: 'small dim', style: 'font-weight:400' }, `${rows.length} / ${a.watchMax} 檔`)),
    h('p', { class: 'small group-who' }, '還沒持有、想等條件到了再買的股票。加進來不會下單、不發通知、不占自選的預算；系統每天抓它的價格，並替它開一份論點檔，你可以先寫為什麼想買。'),
    glass('', rows.length ? rows.map((x) => watchRow(ctx, x)) : h('p', { class: 'pad small faint' }, '還沒有候補。'), h('div', { class: 'watch-add-wrap' }, addForm(ctx, a))),
  );
}

/**
 * 候補的詳細頁最上面那一塊：加入日、那一句話、比重（改、改回推薦值）、移除。
 * d.watch：holdingDetail 的 watch（WatchRow 加上 max、count）。
 */
export function watchPanel(ctx, d) {
  const x = d.watch;
  const msg = h('div');
  const fail = (e) => msg.replaceChildren(errBox(e));
  const w = h('input', { class: 'num-in short', type: 'text', inputmode: 'decimal', value: x.stdWeight !== null ? (x.stdWeight * 100).toFixed(1) : '', placeholder: x.recWeight !== null ? (x.recWeight * 100).toFixed(1) : '留空', 'aria-label': '打算放的比重（%）' });
  const save = actionButton('存比重', '', async () => {
    let std;
    try {
      std = weightOf(w);
    } catch (e) {
      return fail(e);
    }
    try {
      await api.post('/ops/watch-update', { ticker: d.ticker, stdWeight: std });
      toast(std === null ? `${d.ticker} 的比重改回留空（用推薦值）` : `${d.ticker} 打算放 ${pct(std)}`);
      ctx.refresh();
    } catch (e) {
      fail(e);
    }
  });
  const note = h('input', { type: 'text', maxlength: 300, value: x.note ?? '', placeholder: '一句話就好', 'aria-label': '為什麼想買' });
  const saveNote = actionButton('存這句話', '', async () => {
    try {
      await api.post('/ops/watch-update', { ticker: d.ticker, note: note.value.trim() });
      toast('存好了');
      ctx.refresh();
    } catch (e) {
      fail(e);
    }
  });
  const remove = actionButton('移出候補', 'quiet', async () => {
    if (!window.confirm(`把 ${d.ticker} 移出候補？它的論點檔會結案（之後再加回來是新的一份，看得到這一次寫的論點）。`)) return;
    try {
      await api.post('/ops/watch-remove', { ticker: d.ticker });
      toast(`${d.ticker} 已移出候補`);
      ctx.go('#/account');
    } catch (e) {
      fail(e);
    }
  });
  return glass(
    'pad hp watch-panel',
    h('div', { class: 'panel-top' }, h('h2', { class: 'panel-h' }, '候補'), h('span', { class: 'chip' }, `${day(x.addedAt, true)} 加入`)),
    h('p', null, '還沒持有。加進候補不會下單；系統每天抓它的價格，論點檔已經開好，可以在下面寫論點。'),
    x.priceMissing ? h('p', { class: 'notice', style: 'margin-top:10px' }, '這次抓不到它的價格（代號可能打錯或已下市）。不影響其他股票的訊號；確定打錯的話，移出候補再用正確的代號加一次。') : null,
    h('h5', { style: 'margin-top:16px' }, '為什麼想買'),
    h('div', { class: 'btn-row', style: 'align-items:center' }, h('div', { style: 'flex:1 1 16em;min-width:0' }, note), saveNote),
    h('p', { class: 'small faint', style: 'margin-top:4px' }, '只當討論、草擬論點時的開場，不是前提。'),
    h('h5', { style: 'margin-top:16px' }, x.stdWeight !== null ? `打算放 ${pct(x.stdWeight)}` : `比重留空${x.recWeight !== null ? `（推薦 ${pct(x.recWeight)}）` : ''}`),
    h('div', { class: 'btn-row', style: 'align-items:center' }, w, h('span', null, '%'), save),
    h('p', { class: 'small faint', style: 'margin-top:4px' }, '占總資產的百分比。清空再存 = 改回留空、用推薦值（自選的預算裡依波動度分配，加進候補時現算）。'),
    h('div', { class: 'btn-row', style: 'margin-top:16px' }, remove),
    msg,
  );
}
