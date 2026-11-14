// 共用的畫面元件：走勢圖、AI 的說明、理由區、要下的單。
import { api } from './api.js';
import { actionText, day, h, money, pct, put, qty, s, signedPct } from './dom.js';
import { meterEl } from './layout.js';

export const bucketTag = (bucket, name) => h('span', { class: 'tag', 'data-b': bucket }, h('i', { class: 'g' }), name);

/** 收合的箭頭（放在 summary 裡）。 */
export const chevron = () => h('span', { class: 'chev', 'aria-hidden': 'true' });

// ---------------------------------------------------------------- 可以收合的區塊
// 開或關記在這個瀏覽器裡，下次打開還是一樣。

const FOLD_KEY = 'stockbot.fold';
function foldState() {
  try {
    return JSON.parse(localStorage.getItem(FOLD_KEY) ?? '{}') ?? {};
  } catch {
    return {};
  }
}
/** id：記住開關用的名字。head：標題那一列的內容（永遠看得到）。body：收合時藏起來的內容。 */
export function fold(id, head, body, cls = '', attrs = {}) {
  const el = h('details', { ...attrs, class: 'fold ' + cls, open: foldState()[id] !== false }, h('summary', null, head, chevron()), h('div', { class: 'fold-body' }, body));
  el.addEventListener('toggle', () => {
    const st = foldState();
    st[id] = el.open;
    try {
      localStorage.setItem(FOLD_KEY, JSON.stringify(st));
    } catch {
      /* 存不了就只在這次瀏覽有效 */
    }
  });
  return el;
}

export function sideChip(shares) {
  if (shares === 0) return h('span', { class: 'side none' }, '搬');
  return h('span', { class: 'side ' + (shares < 0 ? 'sell' : 'buy') }, shares < 0 ? '賣' : '買');
}

// ---------------------------------------------------------------- 走勢圖
// 收盤（粗黑線）、200 日均線（灰線）、減半線（紅色虛線 = 52 週高點的 80%）。滑過去看每天的數字。

export function chart(c) {
  if (!c || c.close.length < 2) return h('p', { class: 'small faint' }, '沒有這檔的價格資料。');
  const n = c.close.length;
  const all = [...c.close, ...c.ma200.filter((v) => v !== null), ...c.halfLine.filter((v) => v !== null)];
  let lo = Math.min(...all);
  let hi = Math.max(...all);
  const padY = (hi - lo) * 0.08 || 1;
  lo -= padY;
  hi += padY;
  const step = niceStep((hi - lo) / 4);
  const ticks = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) ticks.push(v);
  const tip = h('div', { class: 'chart-tip', hidden: true });
  const box = h('div', { class: 'chart' });
  let drawn = 0;
  // 照容器的實際寬度畫（字的大小才不會跟著縮放）；容器變寬變窄就重畫
  const draw = () => {
    const W = Math.max(260, Math.round(box.clientWidth || 640));
    if (W === drawn) return;
    drawn = W;
    const H = Math.round(Math.min(260, Math.max(170, W * 0.42)));
    const L = 46;
    const R = 8;
    const T = 8;
    const B = 22;
    const X = (k) => L + ((W - L - R) * k) / (n - 1);
    const Y = (v) => T + (H - T - B) * (1 - (v - lo) / (hi - lo));
    const path = (arr) => {
      let d = '';
      let pen = false;
      arr.forEach((v, k) => {
        if (v === null) {
          pen = false;
          return;
        }
        d += `${pen ? 'L' : 'M'}${X(k).toFixed(1)} ${Y(v).toFixed(1)}`;
        pen = true;
      });
      return d;
    };
    const cross = s('line', { class: 'cross', y1: T, y2: H - B, x1: 0, x2: 0, visibility: 'hidden' });
    const svg = s(
      'svg',
      { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': `走勢圖：${c.dates[0]} 到 ${c.dates[n - 1]}，最新收盤 ${c.close[n - 1]}` },
      ticks.map((v) => [s('line', { class: 'grid', x1: L, x2: W - R, y1: Y(v), y2: Y(v) }), s('text', { class: 'axis', x: L - 6, y: Y(v) + 4, 'text-anchor': 'end' }, v >= 1000 ? v.toLocaleString('en-US') : String(+v.toFixed(2)))]),
      s('text', { class: 'axis', x: L, y: H - 5 }, c.dates[0]),
      s('text', { class: 'axis', x: W - R, y: H - 5, 'text-anchor': 'end' }, c.dates[n - 1]),
      s('path', { class: 'l-half', d: path(c.halfLine) }),
      s('path', { class: 'l-ma', d: path(c.ma200) }),
      s('path', { class: 'l-close', d: path(c.close) }),
      c.marks.map((m) => {
        const k = c.dates.indexOf(m.date);
        return k < 0 ? null : s('circle', { class: 'mark', cx: X(k), cy: Y(c.close[k]), r: 5 }, s('title', null, `${m.date} ${m.label}`));
      }),
      cross,
    );
    const move = (ev) => {
      const r = svg.getBoundingClientRect();
      const k = Math.min(n - 1, Math.max(0, Math.round(((ev.clientX - r.left - L) / (W - L - R)) * (n - 1))));
      cross.setAttribute('x1', X(k));
      cross.setAttribute('x2', X(k));
      cross.setAttribute('visibility', 'visible');
      tip.hidden = false;
      put(tip, h('b', null, c.dates[k]), h('br'), `收盤 ${money(c.close[k], 2)}`, c.ma200[k] === null ? null : [h('br'), `200 日均線 ${money(c.ma200[k], 2)}`], c.halfLine[k] === null ? null : [h('br'), `減半線 ${money(c.halfLine[k], 2)}`]);
      tip.style.left = Math.min(W - tip.offsetWidth - 4, Math.max(0, X(k) + 10)) + 'px';
    };
    svg.addEventListener('pointermove', move);
    svg.addEventListener('pointerdown', move);
    svg.addEventListener('pointerleave', () => {
      tip.hidden = true;
      cross.setAttribute('visibility', 'hidden');
    });
    tip.hidden = true;
    box.replaceChildren(svg, tip);
  };
  if (typeof ResizeObserver === 'function') new ResizeObserver(draw).observe(box);
  else requestAnimationFrame(draw);
  return h(
    'div',
    null,
    h('div', { class: 'chart-legend' }, h('span', null, h('i'), '收盤'), h('span', null, h('i', { class: 'ma' }), '200 日均線'), h('span', null, h('i', { class: 'half' }), '減半線（52 週高點 −20%）'), c.marks.length ? h('span', null, '● 這檔出現在通知的日子') : null),
    box,
  );
}
function niceStep(raw) {
  const p = 10 ** Math.floor(Math.log10(raw));
  const f = raw / p;
  return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p;
}

/** 展開時才去拿走勢圖的資料。 */
export function lazyChart(ticker) {
  const box = h('div', null, h('p', { class: 'small faint' }, '載入走勢圖…'));
  api
    .get('/holding/' + encodeURIComponent(ticker))
    .then((d) => box.replaceChildren(chart(d.chart)))
    .catch((e) => box.replaceChildren(h('p', { class: 'small faint' }, '走勢圖載入失敗：' + e.message)));
  return box;
}

// ---------------------------------------------------------------- AI 的說明

const PREM = { HOLDS: '成立', BROKEN: '不成立', INSUFFICIENT: '證據不足' };
const ORIGIN = { USER: '你寫的', AI_DRAFT_ACCEPTED: 'AI 草擬、你勾選', SYSTEM_DEFAULT: '系統預設' };

export function aiBlock(note) {
  if (!note) return null;
  return h(
    'div',
    { class: 'ai' },
    h('div', { class: 'ai-head' }, h('b', null, `AI ${day(note.date)}的結論：${note.verdict}`), note.votes ? h('span', { class: 'dim' }, note.votes) : null, note.fake ? h('span', { class: 'fake' }, '示範用的假內容') : null),
    h('p', null, note.summary),
    note.premises?.length
      ? h(
          'ul',
          { class: 'prem' },
          note.premises.map((p) => h('li', null, h('span', { class: 'st ' + p.status }, PREM[p.status]), h('span', null, p.text, ' ', h('span', { class: 'faint' }, `（${ORIGIN[p.origin] ?? p.origin}）`)), p.evidence ? h('small', null, '依據：' + p.evidence) : null)),
        )
      : null,
    (note.quotes ?? []).map((q) => h('blockquote', { class: 'quote' }, `「${q.quote}」`, h('cite', null, `${q.source}，${q.date}`))),
    note.conditions?.length || note.sections?.length
      ? h(
          'details',
          { class: 'more' },
          h('summary', null, 'AI 寫下的條件與討論過程'),
          h(
            'div',
            { class: 'more-body' },
            note.conditions?.length
              ? h('div', null, h('h5', null, '之後每天監測的條件'), h('table', { class: 'plain' }, h('tbody', null, note.conditions.map((c) => h('tr', null, h('td', null, c.kind), h('td', null, c.text), h('td', null, '成立時：' + c.then))))))
              : null,
            (note.sections ?? []).map((x) => h('div', null, h('h5', null, x.title), h('p', { class: 'small' }, x.text))),
          ),
        )
      : null,
  );
}

// ---------------------------------------------------------------- 理由區

const MARK = { HELD: '持有', IN: '這次買', OUT: '這次賣', VETO: 'AI 否決', EXCLUDED: '你排除' };

export function rankTable(rows, focus) {
  return h(
    'table',
    { class: 'plain' },
    h('thead', null, h('tr', null, h('th', null, '排名'), h('th', null, '代號'), h('th', { class: 'r' }, '一年報酬'), h('th', null, ''))),
    h(
      'tbody',
      null,
      rows.map((r) => h('tr', { class: r.ticker === focus ? 'hl' : null }, h('td', { class: 'num' }, r.rank), h('td', { class: 'tk' }, r.ticker), h('td', { class: 'num r' }, r.ret === null ? '—' : signedPct(r.ret)), h('td', null, r.mark ? h('span', { class: 'mk ' + r.mark }, MARK[r.mark]) : null))),
    ),
  );
}

/** 一項建議完整的「為什麼」（建議單展開後的右半邊）：理由和門檻條；數字、算法、排名、規則原文、走勢圖再收一層。 */
export function whyBlock(x, ticker, meter = null) {
  const more = [];
  if (x.math?.length) more.push(h('div', null, h('h5', null, '股數怎麼算的'), h('ul', { class: 'math' }, x.math.map((m) => h('li', null, m)))));
  if (x.facts?.length) more.push(h('div', null, h('h5', null, '數字'), h('dl', { class: 'facts' }, x.facts.map((f) => [h('dt', null, f.label), h('dd', null, f.value ? h('span', { class: 'num' }, f.value) : null, f.note ? h('small', null, f.note) : null)]))));
  if (x.ranking?.length) more.push(h('div', null, h('h5', null, '這個月的排名'), rankTable(x.ranking, ticker)));
  if (x.rule) more.push(h('div', null, h('h5', null, '規則'), h('p', { class: 'rule-text' }, x.rule)));
  const det = more.length || x.chart ? h('details', { class: 'more' }, h('summary', null, [x.math?.length ? '算法' : null, x.facts?.length ? '數字' : null, x.ranking?.length ? '排名' : null, x.rule ? '規則' : null, x.chart ? '走勢圖' : null].filter(Boolean).join('、')), h('div', { class: 'more-body' }, more)) : null;
  if (det && x.chart) {
    let loaded = false;
    det.addEventListener('toggle', () => {
      if (det.open && !loaded) {
        loaded = true;
        det.querySelector('.more-body').append(h('div', null, h('h5', null, `${x.chart} 走勢`), lazyChart(x.chart)));
      }
    });
  }
  return h('div', { class: 'slip-why' }, h('p', { class: 'why' }, x.why), meterEl(meter, 'big'), aiBlock(x.ai), x.aiMissing && !x.ai ? h('p', { class: 'small faint', style: { marginTop: '8px' } }, 'AI 的完整報告要等 AI 層上線後才會出現在這裡。') : null, det);
}

// ---------------------------------------------------------------- 要下的單

export function orderRows(c, opt = {}) {
  const prev = opt.prev ?? null;
  return c.orders.map((o) => {
    const was = prev?.orders.find((p) => p.ticker === o.ticker);
    const changed = prev && (!was || was.shares !== o.shares);
    const multi = o.parts.length > 1 || o.parts.some((p) => p.bucket === 'core');
    return [
      h(
        'tr',
        { class: changed ? 'changed' : null },
        opt.check ? h('td', { class: 'ck' }, h('input', { type: 'checkbox', 'aria-label': `${o.ticker} 已下單`, onchange: (ev) => ev.target.closest('tr').classList.toggle('done-row', ev.target.checked) })) : null,
        h('td', { class: 'sd' }, sideChip(o.shares)),
        h('td', null, h('span', { class: 'tk' }, o.ticker)),
        h('td', { class: 'q' }, o.transfer ? h('small', null, '不用下單') : [qty(o.shares), h('small', null, '股')], o.amount !== null && !o.transfer ? h('div', { class: 'amt' }, '約 ' + money(Math.abs(o.amount))) : null),
      ),
      multi || o.transfer ? h('tr', { class: 'parts' }, h('td', { colspan: opt.check ? 4 : 3 }, o.parts.map((p) => h('div', null, `${p.bucketName} ${p.shares > 0 ? '+' : '−'}${qty(p.shares)}：${p.reason}`)))) : null,
    ];
  });
}

/** 「賣 ORCL 28 股（全部）」→ 賣的標記、代號、股數；結尾的括號用小字。 */
export function actParts(text) {
  const m = /^(.*?)（([^（）]*)）$/.exec(text);
  const body = m ? m[1] : text;
  const sb = /^(賣|買) (.*)$/.exec(body);
  return [sb ? h('span', { class: 'side ' + (sb[1] === '賣' ? 'sell' : 'buy') }, sb[1]) : null, actionText(sb ? sb[2] : body), m ? h('small', null, m[2]) : null];
}

export function headline(text) {
  return h('h3', { class: 'act' }, actParts(text));
}

export { pct };
