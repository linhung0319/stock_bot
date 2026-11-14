// 每一頁共用的骨架：最上面一條橫幅（標題、史萊姆、一句話）；下面左邊是要讀、要選的東西，
// 右邊在待辦與帳戶頁是一組儀表磚，在月報與「我要…」的流程是「合起來要下幾張單」的主控台（CTA 在它底部）。
import { day, h, money, pct } from './dom.js';
import { bubbleKids, mascotEl } from './slime.js';

const WD = ['日', '一', '二', '三', '四', '五', '六'];
/** 2026-12-01 → 12 月 1 日 · 星期二 */
export function longDay(date) {
  if (!date) return '';
  const d = new Date(date + 'T00:00:00Z');
  return `${d.getUTCMonth() + 1} 月 ${d.getUTCDate()} 日 · 星期${WD[d.getUTCDay()]}`;
}

/**
 * 一整頁。
 * view：todo（待辦與紀錄）／account（帳戶）／flow（月報與各種流程，右邊是主控台）／page（其他）。
 * banner：{ kicker, back: { href, label }, title（字串或節點）, sub, steps, bubble, mood, slime（false = 不放史萊姆） }
 * pane：左邊的內容；rail：右邊的內容（沒給就單欄）；cta：手機上貼在畫面底部的那一列。
 */
export function page({ view = 'page', banner, pane, rail = null, cta = null }) {
  const deck = h(
    'div',
    { class: 'deck', 'data-view': view, 'data-norail': rail ? null : true, 'data-noslime': banner.slime === false ? true : null },
    bannerEl(banner),
    h('main', { class: 'pane', id: 'main', tabindex: '-1' }, pane),
    rail ? h('aside', { class: 'rail', 'aria-label': view === 'flow' ? '要下的單' : '帳戶現況' }, rail) : null,
  );
  return cta ? [deck, cta] : [deck];
}

function bannerEl(b) {
  const bubble = b.bubble ? h('p', { class: 'bubble', 'aria-live': 'polite' }, bubbleKids(b.bubble)) : null;
  return h(
    'section',
    { class: 'banner' },
    h('div', { class: 'scene', 'aria-hidden': 'true' }, h('i', { class: 'l1' }), h('i', { class: 'l2' }), h('i', { class: 'l3' }), h('span', { class: 'motes' }), h('span', { class: 'motes b' })),
    h(
      'div',
      { class: 'bv' },
      b.back ? h('a', { class: 'back', href: b.back.href }, b.back.label) : null,
      b.kicker ? h('p', { class: 'kicker' }, b.kicker) : null,
      h('h1', null, b.title),
      b.sub ? h('p', { class: 'sub' }, b.sub) : null,
      b.steps ?? null,
    ),
    bubble,
    b.slime === false ? null : mascotEl(b.bubble?.mood ?? b.mood ?? 'watch'),
  );
}

/** 小卡片的外框。 */
export const glass = (cls, ...kids) => h('div', { class: 'glass ' + cls }, ...kids);

// ---------------------------------------------------------------- 門檻條

/**
 * 門檻條。size：mini（帳戶頁每一檔、右邊的磚）／big（建議單裡，上面有刻度說明、下面有白話結果）。
 * 條上面不加文字；條的長度＝離門檻走了多遠，白線＝門檻，白線之後＝會觸發的範圍（下面寫後果），白點＝現在。
 */
export function meterEl(m, size = 'mini') {
  if (!m) return null;
  const bar = h(
    'div',
    { class: 'meter-bar', style: `--t:${(m.t * 100).toFixed(1)}%` },
    h('i', { class: 'meter-zone', 'data-l': m.zone }),
    h('i', { class: 'meter-fill', style: `--v:${(m.v * 100).toFixed(1)}%` }),
    h('i', { class: 'meter-line' }),
  );
  const el = h('div', { class: 'meter ' + size, 'data-s': m.s, 'data-k': m.kind, role: 'img', 'aria-label': m.label + (m.say ? `。${m.say}` : '') }, bar, size === 'big' && m.say ? h('p', { class: 'meter-say' }, m.say) : null);
  return size === 'big' && m.cap ? [h('div', { class: 'meter-cap' }, m.cap), el] : el;
}

// ---------------------------------------------------------------- 右邊的儀表磚（待辦、帳戶、單一持股）

function bucketNote(a, id) {
  const rows = a.holdings.filter((x) => x.bucket === id && x.ticker !== '現金');
  if (id === 'core') return `${rows.map((x) => x.ticker).join('、') || '沒有持股'}${a.cash ? '與現金' : ''}`;
  if (!rows.length) return '空的';
  const hot = rows.filter((x) => x.tone === 'alert').length;
  const near = rows.filter((x) => x.tone === 'warn').length;
  return [`${rows.length} 檔，`, hot ? h('span', { class: 'hot' }, `${hot} 檔碰到門檻`) : near ? h('span', { class: 'warn' }, `${near} 檔接近門檻`) : '都正常'];
}

export function tiles(st) {
  const a = st.account;
  if (!a) return null;
  const [crash, vol] = a.status;
  const total = Math.round(a.total).toLocaleString('en-US');
  return [
    h(
      'section',
      { class: 'tile', 'aria-label': '帳戶' },
      h('div', { class: 'tile-head' }, h('h2', null, '帳戶總值'), a.paper ? h('span', { class: 'chip warn' }, '紙上交易') : null, h('span', { class: 'ctx' }, `${day(st.priceDate)}收盤`)),
      h(
        'div',
        { class: 'tile-body' },
        h('div', { class: 'total' }, h('span', { class: 'cur' }, a.total < 0 ? '−$' : '$'), h('span', { class: 'v' }, total.replace('-', '')), h('span', { class: 'unit' }, '美元')),
        h('div', { class: 'alloc', role: 'img', 'aria-label': a.buckets.map((b) => `${b.name} ${pct(b.pct, 0)}（預算 ${pct(b.budget, 0)}）`).join('、') }, h('div', { class: 'alloc-bar' }, a.buckets.filter((b) => b.pct > 0.002).map((b) => h('span', { 'data-b': b.id, style: `flex:${Math.max(b.pct, 0.001)}`, title: `${b.name} ${money(b.value)}` })))),
        a.buckets.map((b) =>
          h(
            'a',
            { class: 'brow', href: '#/account', 'data-b': b.id },
            h('b', null, h('i', { class: 'g' }), b.name),
            h('span', { class: 'p' }, h('span', { class: 'num' }, pct(b.pct, 0)), h('small', null, `預算 ${pct(b.budget, 0)}`)),
            h('span', { class: 'v num' }, money(b.value)),
            h('span', { class: 'go' }),
            h('span', { class: 'm' }, bucketNote(a, b.id)),
          ),
        ),
      ),
    ),
    h(
      'div',
      { class: 'tiles2' },
      crash
        ? h(
            'section',
            { class: 'tile', 'aria-label': '崩盤規則' },
            h('div', { class: 'tile-head' }, h('h2', null, '崩盤規則')),
            h('div', { class: 'tile-body' }, h('div', { class: 'meter-v' }, h('i', { class: 'led', style: `--tc:${crash.tone === 'warn' ? 'var(--hot)' : 'var(--core)'}` }), crash.value), meterEl(crash.meter), h('p', { class: 'meter-note' }, crash.detail)),
          )
        : null,
      vol
        ? h(
            'section',
            { class: 'tile', 'aria-label': '動能部位' },
            h('div', { class: 'tile-head' }, h('h2', null, '動能部位')),
            h('div', { class: 'tile-body' }, h('div', { class: 'meter-v' }, h('span', { class: 'cells', 'aria-hidden': 'true' }, [0, 1, 2].map((k) => h('i', { class: k < (vol.cells ?? 3) ? 'on' : null }))), vol.value.replace(/（.*）/, '')), h('p', { class: 'meter-note' }, vol.detail)),
          )
        : null,
    ),
  ];
}

// ---------------------------------------------------------------- 主控台（月報、我要…的流程）

/** title：標題；body：中間可以捲動的內容；foot：底部的 CTA。 */
export function consoleBox(title, body, foot = null, label = '要下的單') {
  return h('section', { class: 'console', 'aria-label': label }, h('div', { class: 'con-head' }, h('h2', null, title)), h('div', { class: 'con-body' }, body), foot ? h('div', { class: 'con-foot' }, foot) : null);
}

// ---------------------------------------------------------------- 「我要…」的選單

const ICON = {
  deposit: 'M9 2v9M5.5 7.5 9 11l3.5-3.5M2.5 12v3.5h13V12',
  withdraw: 'M9 11V2M5.5 5.5 9 2l3.5 3.5M2.5 12v3.5h13V12',
  snapshot: 'M2.5 6V2.5H6M12 2.5h3.5V6M15.5 12v3.5H12M6 15.5H2.5V12M5.5 9h7',
  add: 'M9 2 16 9l-7 7-7-7zM9 6.2v5.6M6.2 9h5.6',
  remove: 'M9 2 16 9l-7 7-7-7zM6.2 9h5.6',
  ratio: 'M2.5 5h13M2.5 9h13M2.5 13h13M6 3.5v3M11.5 7.5v3M8 11.5v3',
  setup: 'M9 2v14M2 9h14',
};
export const icon = (k) => {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 18 18');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.4');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', ICON[k]);
  svg.append(p);
  return svg;
};

export function menuItems(st) {
  const a = st.account;
  if (!a) return [['setup', '#/setup', '建立帳戶', '填第一份快照：每一檔的股數、現金，放自選還是動能。']];
  return [
    ['deposit', '#/do/deposit', '入金', '把錢匯進券商之後登記。只買不賣，先補離目標最遠的格子。'],
    ['withdraw', '#/do/withdraw', '出金', '要把錢領出來。只賣不買，先動核心、最後才是自選。'],
    ['snapshot', '#/snapshot', '填快照', '自己交易過，或只是想和券商對帳。'],
    ['add', '#/do/add', '新增自選', '加一檔你自己想買的股票。系統建議比重，不替你決定買不買。'],
    ['remove', '#/do/remove', '移除自選', '全部賣出，錢回核心，之後不再追蹤這一檔。'],
    ['ratio', '#/do/ratio', '改三桶的比例', `現在是自選 ${pct(a.ratio.own, 0)}／動能 ${pct(a.ratio.strat, 0)}／核心 ${pct(a.ratio.core, 0)}。`],
  ];
}

export function menuList(st, cls = 'menu') {
  return h(
    'ul',
    { class: cls },
    menuItems(st).map(([k, href, t, s]) => h('li', null, h('a', { href }, icon(k), h('b', null, t), h('span', null, s)))),
  );
}
