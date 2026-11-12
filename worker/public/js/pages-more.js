// 帳戶、單一持股、紀錄、「我要…」的各種操作、建立帳戶、登入。
import { api, setToken } from './api.js';
import { actionText, day, h, money, pct, put, qty, toast } from './dom.js';
import { aiBlock, bucketTag, chart, fold, rankTable, ruler } from './parts.js';
import { accountSummary, actionButton, errBox, historyRow, slips, tray } from './pages-notif.js';

// ---------------------------------------------------------------- 帳戶

const GROUPS = [
  { id: 'own', name: '自選', who: '你選的股票。慢規則當保險：比高點低 20% 減半，站回 200 日均線再買回。' },
  { id: 'mom', name: '動能', who: '規則照一年報酬的排名選 5 檔。掉出前 15 名才賣。' },
  { id: 'core', name: '核心', who: '其他兩桶減下來的錢都回到這裡；要加回的錢也從這裡拿。' },
];

function holdRow(x) {
  const tone = x.tone === 'warn' || x.tone === 'alert' ? x.tone : null;
  const inner = [
    h('div', null, h('span', { class: 'tk' }, x.ticker), x.shares ? h('span', { class: 'num dim', style: { marginLeft: '10px' } }, `${qty(x.shares)} 股`) : null, x.target ? h('span', { class: 'small faint', style: { marginLeft: '10px' } }, x.target) : null),
    h('div', { class: 'val' }, money(x.value), h('span', { class: 'faint', style: { marginLeft: '8px' } }, pct(x.pct))),
    h('div', { class: 'state', style: { gridColumn: '1 / -1' } }, h('b', { class: tone }, x.state), x.detail ? h('span', { class: 'dim', style: { marginLeft: '12px' } }, x.detail) : null),
    x.gauge ? h('div', { class: 'gz' }, ruler(x.gauge, true)) : null,
  ];
  return x.ticker === '現金' ? h('div', { class: 'hold' }, inner) : h('a', { class: 'hold', href: `#/h/${encodeURIComponent(x.ticker)}` }, inner);
}

export function accountPage(ctx) {
  const st = ctx.state;
  const a = st.account;
  if (!a) return h('div', null, h('div', { class: 'page-head' }, h('h1', null, '帳戶')), h('p', null, '還沒有帳戶。', h('a', { href: '#/' }, '回首頁')));
  const refresh = () => ctx.refresh();
  return h(
    'div',
    null,
    h('div', { class: 'page-head' }, h('h1', null, '帳戶'), h('p', { class: 'sub' }, `每一股都記在三桶其中之一。上一份快照：${a.snapshotDate ? day(a.snapshotDate, true) : '還沒有'}。`)),
    h(
      'div',
      { class: 'cols rail-first' },
      h(
        'div',
        null,
        a.monthlyBlocked ? h('p', { class: 'notice', style: { margin: '0 0 12px' } }, '有還沒分類的持股變動，月報暫停中。到「待辦」回答那筆變動屬於哪一桶。') : null,
        a.unclassified.length ? h('div', { class: 'panel pad', style: { marginBottom: '12px' } }, h('b', null, '還沒分類：'), a.unclassified.map((u) => `${u.ticker} ${u.shares > 0 ? '+' : '−'}${qty(u.shares)} 股`).join('、')) : null,
        GROUPS.map((g) => {
          const rows = a.holdings.filter((x) => x.bucket === g.id);
          const b = a.buckets.find((x) => x.id === g.id);
          const near = rows.filter((x) => x.tone === 'warn' || x.tone === 'alert').length;
          return fold(
            'account.' + g.id,
            [
              h('h2', { class: 'group-name', 'data-b': g.id }, g.name),
              h('span', { class: 'group-val num' }, money(b.value)),
              h('span', { class: 'small dim' }, `占 ${pct(b.pct, 0)}，預算 ${pct(b.budget, 0)}`),
              near ? h('span', { class: 'pill ' + (rows.some((x) => x.tone === 'alert') ? 'sell' : 'warn') }, `${near} 檔接近或碰到門檻`) : null,
              h('span', { class: 'small faint when-closed' }, rows.length ? rows.map((x) => x.ticker).join('、') : '空的'),
            ],
            [h('p', { class: 'small dim group-who' }, g.who), h('div', { class: 'panel' }, rows.length ? rows.map(holdRow) : h('p', { class: 'pad small faint' }, '這一桶現在是空的。'))],
            'group',
          );
        }),
        a.excluded.length
          ? [
              h('h2', { class: 'sec' }, '你排除的動能股票'),
              h(
                'div',
                { class: 'panel' },
                a.excluded.map((x) =>
                  h(
                    'div',
                    { class: 'hold' },
                    h('div', null, h('span', { class: 'tk' }, x.ticker), h('span', { class: 'small dim', style: { marginLeft: '10px' } }, `${day(x.date)}：${x.reason}`)),
                    actionButton('取消排除', '', async () => {
                      await api.post('/ops/unexclude', { ticker: x.ticker });
                      toast(`${x.ticker} 下次月報會重新列入排名`);
                      refresh();
                    }),
                  ),
                ),
              ),
            ]
          : null,
        a.adopted.length ? [h('h2', { class: 'sec' }, '你認養到自選的股票'), h('div', { class: 'panel pad small' }, a.adopted.map((x) => h('div', null, h('span', { class: 'tk' }, x.ticker), h('span', { style: { marginLeft: '12px' } }, `${day(x.date)}：${x.reason}`))))] : null,
      ),
      h(
        'div',
        { class: 'rail' },
        accountSummary(a, st.priceDate),
        h('p', { class: 'small dim', style: { margin: '10px 2px' } }, '三桶的比例是風險預算，不是要維持的目標：系統不會只為了把比例拉回來叫你下單。'),
        a.ranking.length
          ? fold(
              'account.ranking',
              [h('h2', { class: 'fold-title' }, '動能排名'), st.rankDate ? h('span', { class: 'small dim num' }, day(st.rankDate)) : null],
              [rankTable(a.ranking), h('p', { class: 'small faint', style: { marginTop: '6px' } }, '買前 5 名；持有的掉出前 15 名才賣。')],
              'panel boxed',
            )
          : null,
      ),
    ),
  );
}

// ---------------------------------------------------------------- 單一持股

export async function holdingPage(ctx, ticker) {
  const d = await api.get('/holding/' + encodeURIComponent(ticker));
  return h(
    'div',
    { class: 'narrow', style: { maxWidth: '820px' } },
    h(
      'div',
      { class: 'page-head' },
      h('a', { class: 'back', href: '#/account' }, '帳戶'),
      h('h1', { class: 'tk' }, d.ticker),
      h('p', { class: 'sub' }, d.positions.length ? d.positions.map((p) => `${p.bucketName} ${qty(p.shares)} 股（${money(p.value)}，占 ${pct(p.pct)}）`).join('；') : '目前沒有持有。'),
    ),
    h('div', { class: 'panel pad' }, chart(d.chart)),
    h('div', { class: 'panel pad' }, h('dl', { class: 'facts' }, d.facts.map((f) => [h('dt', null, f.label), h('dd', null, h('span', { class: 'num' }, f.value), f.note ? h('small', null, f.note) : null)]))),
    d.own
      ? h(
          'div',
          { class: 'panel pad' },
          h('h2', { class: 'panel-h' }, actionText(`自選：${d.own.state}，標準比重 ${pct(d.own.stdWeight)}`)),
          h('h5', { style: { margin: '8px 0 4px', fontSize: '13px', color: 'var(--ink-2)' } }, '這檔的前提（你為什麼持有它）'),
          h('ul', { class: 'prem' }, d.own.premises.map((p) => h('li', null, h('span', { class: 'st' }, p.origin), h('span', null, p.text)))),
          d.own.lastReview ? h('p', { class: 'small dim', style: { marginTop: '8px' } }, 'AI 最近一次審查：' + d.own.lastReview) : h('p', { class: 'small faint', style: { marginTop: '8px' } }, 'AI 還沒有審查過這一檔。'),
          aiBlock(d.ai),
          d.canRemove ? h('div', { class: 'btn-row', style: { marginTop: '12px' } }, h('a', { class: 'btn', href: `#/do/remove/${encodeURIComponent(d.ticker)}` }, '移除自選')) : null,
        )
      : null,
    d.history.length ? [h('h2', { class: 'sec' }, '這檔的紀錄'), h('div', { class: 'panel' }, d.history.map((x) => (x.notif ? h('a', { class: 'rowlink', href: `#/n/${x.notif}` }, h('span', { class: 'd num' }, day(x.date)), h('span', null, x.text), h('span')) : h('div', { class: 'rowlink' }, h('span', { class: 'd num' }, day(x.date)), h('span', null, x.text), h('span')))))] : null,
  );
}

// ---------------------------------------------------------------- 紀錄

export async function historyPage() {
  const d = await api.get('/history');
  const body = h('div');
  const tabs = [
    ['通知', () => (d.notifs.length ? h('div', { class: 'panel' }, d.notifs.map(historyRow)) : h('p', { class: 'dim' }, '還沒有通知。'))],
    ['帳本', () => (d.events.length ? h('div', { class: 'panel' }, d.events.map((e) => (e.notif ? h('a', { class: 'rowlink', href: `#/n/${e.notif}` }, h('span', { class: 'd num' }, day(e.date)), h('span', null, e.text), h('span')) : h('div', { class: 'rowlink' }, h('span', { class: 'd num' }, day(e.date)), h('span', null, e.text), h('span'))))) : h('p', { class: 'dim' }, '帳本還沒有變動。'))],
    [
      '沒照規則做的',
      () =>
        d.shadow.length
          ? h(
              'div',
              null,
              h('p', { class: 'small dim', style: { marginBottom: '8px' } }, '每一次規則和 AI 的建議不同、或你沒照規則做，都記一筆。之後可以回頭看：照規則、照 AI、你實際做的，哪一個比較好。'),
              h(
                'div',
                { class: 'panel', style: { overflowX: 'auto' } },
                h(
                  'table',
                  { class: 'plain' },
                  h('thead', null, h('tr', null, h('th', null, '日期'), h('th', null, '代號'), h('th', null, '事件'), h('th', null, '照規則'), h('th', null, '照 AI'), h('th', null, '你實際'))),
                  h('tbody', null, d.shadow.map((x) => h('tr', null, h('td', { class: 'num' }, day(x.date)), h('td', { class: 'tk' }, x.ticker ?? ''), h('td', null, x.title, x.note ? h('div', { class: 'small faint' }, x.note) : null), h('td', null, x.rule), h('td', null, x.ai ?? '—'), h('td', null, x.actual)))),
                ),
              ),
            )
          : h('p', { class: 'dim' }, '還沒有。你每次都照規則做的話，這裡會是空的。'),
    ],
  ];
  const bar = h('div', { class: 'tabs', role: 'tablist' });
  const show = (k) => {
    [...bar.children].forEach((b, i) => b.setAttribute('aria-selected', String(i === k)));
    body.replaceChildren(tabs[k][1]());
  };
  tabs.forEach(([name], k) => bar.append(h('button', { type: 'button', role: 'tab', onclick: () => show(k) }, name)));
  show(0);
  return h('div', { class: 'narrow', style: { maxWidth: '860px' } }, h('div', { class: 'page-head' }, h('h1', null, '紀錄'), h('p', { class: 'sub' }, '每一則通知都留著當時的建議、理由和你的決定。')), bar, body);
}

// ---------------------------------------------------------------- 我要…

export function doMenu(ctx) {
  const has = !!ctx.state.account;
  const items = has
    ? [
        ['#/do/deposit', '入金', '把錢匯進券商之後登記。只買不賣，先補離目標最遠的格子。'],
        ['#/do/withdraw', '出金', '要把錢領出來。只賣不買，先動核心、最後才是自選。'],
        ['#/snapshot', '填快照', '自己交易過，或只是想和券商對帳。'],
        ['#/do/add', '新增自選', '加一檔你自己想買的股票。系統建議比重，不替你決定買不買。'],
        ['#/do/remove', '移除自選', '全部賣出，錢回核心，之後不再追蹤這一檔。'],
        ['#/do/ratio', '改三桶的比例', `現在是自選 ${pct(ctx.state.account.ratio.own, 0)}／動能 ${pct(ctx.state.account.ratio.strat, 0)}／核心 ${pct(ctx.state.account.ratio.core, 0)}。`],
      ]
    : [['#/setup', '建立帳戶', '填第一份快照。']];
  return h('div', null, h('div', { class: 'page-head' }, h('h1', null, '我要…'), h('p', { class: 'sub' }, '你自己發起的操作。每一種都先試算給你看清單和理由，確定了才記下來。')), h('div', { class: 'menu' }, items.map(([href, t, s]) => h('a', { href }, h('b', null, t), h('span', null, s)))));
}

/** 共用流程：填表 → 試算（看清單與理由）→ 確定。 */
function opPage({ title, sub, fields, payload, path, confirmLabel, note }) {
  return (ctx) => {
    const msg = h('div');
    const out = h('div');
    const run = (dry) => async () => {
      let body;
      try {
        body = payload();
      } catch (e) {
        return msg.replaceChildren(errBox(e));
      }
      try {
        const r = await api.post(path, { ...body, dry });
        msg.replaceChildren();
        if (!dry) {
          toast('清單建立好了');
          return ctx.go(`#/n/${r.notifId}`);
        }
        const v = r.preview;
        put(
          out,
          h('h2', { class: 'sec' }, '試算：會給你這份清單'),
          r.mergedIntoMonthly ? h('p', { class: 'notice', style: { margin: '0 0 12px' } }, '今天的月報還沒回覆，所以入金會和月報合成一份清單，取代原本那一份。') : null,
          slips(v, { editable: false }),
          tray(v.composed),
          h('p', { class: 'small dim', style: { margin: '10px 0' } }, note ?? '確定之後才會記進帳戶；清單會出現在「待辦」。'),
          h('div', { class: 'btn-row' }, actionButton(confirmLabel, 'primary', run(false)), h('a', { class: 'btn quiet', href: '#/do' }, '算了')),
        );
        out.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } catch (e) {
        out.replaceChildren();
        msg.replaceChildren(errBox(e));
      }
    };
    const form = h('form', { class: 'panel pad', onsubmit: (ev) => ev.preventDefault() }, fields(ctx), msg, h('div', { class: 'btn-row' }, actionButton('試算', 'primary', run(true))));
    form.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && ev.target.tagName === 'INPUT') {
        ev.preventDefault();
        form.querySelector('.btn.primary').click();
      }
    });
    return h('div', { class: 'narrow', style: { maxWidth: '860px' } }, h('div', { class: 'page-head' }, h('a', { class: 'back', href: '#/do' }, '我要…'), h('h1', null, title), h('p', { class: 'sub' }, sub)), h('div', { style: { maxWidth: '520px' } }, form), out);
  };
}

const amountOf = (el, name) => {
  const x = Number(el.value.replace(/[,\s$]/g, ''));
  if (!(x > 0)) throw new Error(`${name}要填大於 0 的數字`);
  return x;
};

export const depositPage = (() => {
  const amt = h('input', { class: 'num-in', type: 'text', inputmode: 'decimal', placeholder: '10,000' });
  return opPage({
    title: '入金',
    sub: '錢已經匯進券商（或正要匯）。系統當天給一份只買不賣的清單。',
    fields: () => {
      amt.value = '';
      return h('label', { class: 'field' }, h('span', null, '入金金額（美元）'), h('div', { style: { maxWidth: '12em' } }, amt), h('small', null, '登記後現金立刻入帳，清單才算得出來。'));
    },
    payload: () => ({ amount: amountOf(amt, '入金金額') }),
    path: '/ops/deposit',
    confirmLabel: '確定入金，建立清單',
  });
})();

export const withdrawPage = (() => {
  const amt = h('input', { class: 'num-in', type: 'text', inputmode: 'decimal', placeholder: '30,000' });
  return opPage({
    title: '出金',
    sub: '告訴系統你要領多少，它給一份只賣不買的清單。清單做完後你再從券商轉出。',
    fields: () => {
      amt.value = '';
      return h('label', { class: 'field' }, h('span', null, '出金金額（美元）'), h('div', { style: { maxWidth: '12em' } }, amt), h('small', null, '現金在清單做完、你填快照的時候才扣。'));
    },
    payload: () => ({ amount: amountOf(amt, '出金金額') }),
    path: '/ops/withdraw',
    confirmLabel: '確定出金，建立清單',
  });
})();

export const ratioPage = (() => {
  const mk = () => h('input', { class: 'num-in short', type: 'text', inputmode: 'decimal' });
  const own = mk();
  const strat = mk();
  const core = mk();
  const sum = h('span', { class: 'small dim' });
  const upd = () => {
    const t = [own, strat, core].reduce((a, e) => a + (Number(e.value) || 0), 0);
    sum.textContent = `合計 ${t}%${Math.abs(t - 100) > 0.001 ? '（要剛好 100%）' : ''}`;
  };
  [own, strat, core].forEach((e) => e.addEventListener('input', upd));
  return opPage({
    title: '改三桶的比例',
    sub: '比例是風險預算，不是要維持的目標。改了之後，當天給一份清單。',
    fields: (ctx) => {
      const r = ctx.state.account.ratio;
      own.value = String(Math.round(r.own * 100));
      strat.value = String(Math.round(r.strat * 100));
      core.value = String(Math.round(r.core * 100));
      upd();
      const row = (name, el, hint) => h('label', { class: 'field' }, h('span', null, name), h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } }, el, '%'), h('small', null, hint));
      return h('div', null, row('自選', own, '你自己選的股票。每一檔的股數與標準比重會照新舊比例縮放。'), row('動能', strat, '規則照排名選的 5 檔。調成 0 就是全部賣掉。'), row('核心', core, 'VOO。其他兩桶的差額都由這裡吸收。'), h('p', null, sum), h('p', { class: 'small dim', style: { margin: '6px 0 12px' } }, '在動能落後大盤的時候把它調成 0，等於在相對低點放棄它。系統不會擋，但原本的比例會繼續記著，之後可以回頭比較。'));
    },
    payload: () => {
      const v = [own, strat, core].map((e) => Number(e.value));
      if (v.some((x) => !Number.isFinite(x) || x < 0)) throw new Error('三個比例都要填 0 以上的數字');
      if (Math.abs(v[0] + v[1] + v[2] - 100) > 0.001) throw new Error('三個比例加起來要是 100%');
      return { own: v[0] / 100, strat: v[1] / 100, core: v[2] / 100 };
    },
    path: '/ops/ratio',
    confirmLabel: '確定改比例，建立清單',
  });
})();

export function removePage(ctx, preset) {
  const sel = h('select', null, ctx.state.account.ownTickers.map((t) => h('option', { value: t, selected: t === preset }, t)));
  return opPage({
    title: '移除自選',
    sub: '全部賣出，錢交給核心。之後這一檔不再有規則或 AI 追蹤；想再買要重新新增。',
    fields: () => (ctx.state.account.ownTickers.length ? h('label', { class: 'field' }, h('span', null, '哪一檔'), h('div', { style: { maxWidth: '12em' } }, sel)) : h('p', null, '自選桶現在是空的。')),
    payload: () => ({ ticker: sel.value }),
    path: '/ops/remove-own',
    confirmLabel: '確定移除，建立清單',
  })(ctx);
}

// 新增自選：先看這檔的數字（健檢），再決定前提，最後才建立清單
export function addOwnPage(ctx) {
  const tk = h('input', { type: 'text', placeholder: '例如 TSLA', style: { textTransform: 'uppercase', maxWidth: '10em' }, autocapitalize: 'characters' });
  const msg = h('div');
  const out = h('div');
  const check = actionButton('看這檔的數字', 'primary', async () => {
    const ticker = tk.value.trim().toUpperCase();
    if (!ticker) return msg.replaceChildren(errBox(new Error('請填股票代號')));
    try {
      const r = await api.post('/ops/add-own', { ticker, dry: true });
      msg.replaceChildren();
      const v = r.preview;
      const mine = h('textarea', { rows: 3, placeholder: '一行一條，例如：\nAI 伺服器出貨兩年內持續成長\n毛利率跌破 70% 就賣' });
      const drafts = (r.drafts ?? []).map((d) => ({ ...d, box: h('input', { type: 'checkbox', checked: true }) }));
      const mode = { v: drafts.length ? 'AI' : 'MINE' };
      const radio = (val, label, extra) => h('label', { class: 'pick', style: { gridTemplateColumns: 'auto 1fr' } }, h('input', { type: 'radio', name: 'pm', checked: mode.v === val, onchange: () => (mode.v = val) }), h('span', { class: 'lab' }, label), extra ? h('span', { class: 'note', style: { gridColumn: '2' } }, extra) : null);
      const premises = () => {
        if (mode.v === 'MINE') {
          const xs = mine.value.split('\n').map((x) => x.trim()).filter(Boolean);
          if (!xs.length) throw new Error('還沒寫前提。寫一兩句，或改選「用系統預設的前提」。');
          return xs.map((text) => ({ text, origin: 'USER' }));
        }
        if (mode.v === 'AI') {
          const xs = drafts.filter((d) => d.box.checked);
          if (!xs.length) throw new Error('至少勾一條，或改選別的方式。');
          return xs.map((d) => ({ text: d.text, origin: 'AI_DRAFT_ACCEPTED', breaksIf: d.breaksIf }));
        }
        return [];
      };
      const msg2 = h('div');
      const confirm = actionButton(`加入自選，建立 ${ticker} 的清單`, 'primary', async () => {
        try {
          const done = await api.post('/ops/add-own', { ticker, premises: premises() });
          toast(`${ticker} 已加入自選`);
          ctx.go(`#/n/${done.notifId}`);
        } catch (e) {
          msg2.replaceChildren(errBox(e));
        }
      });
      put(
        out,
        h('h2', { class: 'sec' }, `${ticker}：加進自選會怎樣`),
        slips(v, { editable: false }),
        h('h2', { class: 'sec' }, '你為什麼要買它'),
        h('p', { class: 'small dim', style: { marginBottom: '10px' } }, '這幾句話是這檔的「前提」。之後 AI 每個月拿它來對照：前提不成立時會建議你減碼。寫不出來也可以，三種方式選一種。'),
        h(
          'div',
          { class: 'picks', style: { maxWidth: '640px' } },
          radio('MINE', '我自己寫', mine),
          drafts.length
            ? radio('AI', 'AI 草擬，我勾選', h('span', null, h('span', { class: 'fake' }, '示範用的假內容'), drafts.map((d) => h('label', { style: { display: 'block', margin: '6px 0' } }, d.box, ' ', d.text, h('span', { class: 'faint' }, `（不成立的訊號：${d.breaksIf}）`)))))
            : h('p', { class: 'small faint' }, 'AI 草擬前提要等 AI 層上線。'),
          radio('DEFAULT', '用系統預設的前提', '沒有硬事件；營收年增率沒有連兩季轉負；稀釋 EPS 沒有連兩季年減；慢規則本身。'),
        ),
        msg2,
        h('div', { class: 'btn-row', style: { marginTop: '14px' } }, confirm, h('a', { class: 'btn quiet', href: '#/do' }, '算了')),
      );
      out.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {
      out.replaceChildren();
      msg.replaceChildren(errBox(e));
    }
  });
  tk.addEventListener('keydown', (ev) => ev.key === 'Enter' && check.click());
  return h(
    'div',
    { class: 'narrow', style: { maxWidth: '860px' } },
    h('div', { class: 'page-head' }, h('a', { class: 'back', href: '#/do' }, '我要…'), h('h1', null, '新增自選'), h('p', { class: 'sub' }, '自選股是你自己要買的，系統不替你決定買不買；它只告訴你這檔現在的數字、建議的比重。')),
    h('div', { class: 'panel pad', style: { maxWidth: '520px' } }, h('label', { class: 'field' }, h('span', null, '股票代號'), tk), msg, check),
    out,
  );
}

// ---------------------------------------------------------------- 建立帳戶

export function setupPage(ctx) {
  const numIn = (ph = '0') => h('input', { class: 'num-in', type: 'text', inputmode: 'decimal', placeholder: ph });
  const cash = numIn();
  const core = numIn();
  const bond = numIn();
  const paper = h('input', { type: 'checkbox', checked: true });
  const rows = { own: [], mom: [] };
  const lists = { own: h('tbody'), mom: h('tbody') };
  const addRow = (kind) => {
    const r = { ticker: h('input', { type: 'text', placeholder: '代號', style: { textTransform: 'uppercase', width: '6.5em' } }), shares: h('input', { class: 'num-in', type: 'text', inputmode: 'decimal', placeholder: '股數', style: { width: '6em' } }), std: kind === 'own' ? h('input', { class: 'num-in', type: 'text', inputmode: 'decimal', placeholder: '建議值', style: { width: '5em' } }) : null, why: kind === 'own' ? h('input', { type: 'text', placeholder: '為什麼持有（選填）', style: { width: '100%', minWidth: '13em' } }) : null };
    rows[kind].push(r);
    lists[kind].append(h('tr', null, h('td', null, r.ticker), h('td', { class: 'r' }, r.shares), kind === 'own' ? [h('td', { class: 'r wide' }, h('div', { style: { display: 'flex', gap: '4px', alignItems: 'center', justifyContent: 'flex-end' } }, r.std, '%')), h('td', { class: 'wide' }, r.why)] : null));
  };
  for (let k = 0; k < 4; k++) addRow('own');
  for (let k = 0; k < 5; k++) addRow('mom');
  const val = (el) => {
    const t = el.value.replace(/[,\s$]/g, '');
    return t === '' ? 0 : Number(t);
  };
  const msg = h('div');
  const go = actionButton('建立帳戶', 'primary', async () => {
    const pick = (kind) => rows[kind].filter((r) => r.ticker.value.trim()).map((r) => ({ ticker: r.ticker.value.trim().toUpperCase(), shares: val(r.shares), ...(r.std && r.std.value.trim() ? { stdWeight: val(r.std) / 100 } : {}), ...(r.why && r.why.value.trim() ? { premises: [{ text: r.why.value.trim() }] } : {}) }));
    try {
      await api.post('/account', { paper: paper.checked, cash: val(cash), coreShares: val(core), bondShares: val(bond), own: pick('own'), mom: pick('mom') });
      toast('帳戶建立好了');
      await ctx.refresh(false);
      ctx.go('#/account');
    } catch (e) {
      msg.replaceChildren(errBox(e));
      msg.scrollIntoView({ block: 'center' });
    }
  });
  const table = (kind, heads) => h('table', { class: 'snap' }, h('thead', null, h('tr', null, heads.map((x, k) => h('th', { class: k === 1 ? 'r' : k > 1 ? 'wide' : null }, x)))), lists[kind]);
  return h(
    'div',
    { class: 'narrow', style: { maxWidth: '760px' } },
    h('div', { class: 'page-head' }, h('a', { class: 'back', href: '#/' }, '回首頁'), h('h1', null, '建立帳戶'), h('p', { class: 'sub' }, '照券商現在的畫面填。只是分類，不會叫你交易；這份快照就是帳本的起點。')),
    h('h2', { class: 'sec', style: { marginTop: '0' } }, bucketTag('core', '核心')),
    h('div', { class: 'panel pad' }, h('label', { class: 'field' }, h('span', null, 'VOO 股數'), h('div', { style: { maxWidth: '10em' } }, core)), h('label', { class: 'field' }, h('span', null, 'SGOV（短債）股數'), h('div', { style: { maxWidth: '10em' } }, bond), h('small', null, '沒有就留空。')), h('label', { class: 'field', style: { marginBottom: '0' } }, h('span', null, '現金（美元）'), h('div', { style: { maxWidth: '10em' } }, cash))),
    h('h2', { class: 'sec' }, bucketTag('own', '自選')),
    h('p', { class: 'small dim', style: { marginBottom: '8px' } }, '你自己選的股票。標準比重留空就用建議值（自選預算 20% 內，波動越大比重越小）。現在已經比 52 週高點低 20% 以上的，一開始記成「減半」狀態。'),
    h('div', { class: 'panel' }, table('own', ['代號', '股數', '標準比重', '為什麼持有']), h('div', { class: 'pad' }, h('button', { class: 'btn', type: 'button', onclick: () => addRow('own') }, '再加一檔'))),
    h('h2', { class: 'sec' }, bucketTag('mom', '動能')),
    h('p', { class: 'small dim', style: { marginBottom: '8px' } }, '照動能名單買的股票。還沒開始照動能買的話，全部留空：下一份月報會給你進場的清單。'),
    h('div', { class: 'panel' }, table('mom', ['代號', '股數']), h('div', { class: 'pad' }, h('button', { class: 'btn', type: 'button', onclick: () => addRow('mom') }, '再加一檔'))),
    h('label', { style: { display: 'flex', gap: '8px', alignItems: 'baseline', margin: '18px 0 6px' } }, paper, h('span', null, h('b', null, '紙上交易'), h('span', { class: 'dim', style: { marginLeft: '12px' } }, '流程照跑，帳本標記成紙上。正式上線前先用這個。'))),
    msg,
    h('div', { class: 'btn-row', style: { marginTop: '10px' } }, go),
  );
}

// ---------------------------------------------------------------- 登入

export function authPage(reason, retry) {
  if (reason !== 'NOT_CONFIGURED') {
    return h('div', { class: 'narrow' }, h('div', { class: 'page-head' }, h('h1', null, '需要重新登入')), h('p', null, '登入已經過期，或這個瀏覽器還沒通過 Cloudflare Access。重新整理頁面就會回到登入畫面。'), h('div', { class: 'btn-row', style: { marginTop: '14px' } }, h('button', { class: 'btn primary', type: 'button', onclick: () => location.reload() }, '重新整理')));
  }
  const key = h('input', { type: 'password', autocomplete: 'off' });
  return h(
    'div',
    { class: 'narrow' },
    h('div', { class: 'page-head' }, h('h1', null, '還沒設定登入'), h('p', { class: 'sub' }, '這個網站要用 Cloudflare Access 限制誰能登入。設定步驟在 worker/SETUP.md。')),
    h(
      'form',
      {
        class: 'panel pad',
        onsubmit: (ev) => {
          ev.preventDefault();
          setToken(key.value.trim());
          retry();
        },
      },
      h('label', { class: 'field' }, h('span', null, '設定好之前，可以先用管理金鑰（ADMIN_TOKEN）'), key, h('small', null, '只留在這個分頁，關掉就沒了。Access 設好之後這個方式會自動失效。')),
      h('button', { class: 'btn primary', type: 'submit' }, '進入'),
    ),
  );
}
