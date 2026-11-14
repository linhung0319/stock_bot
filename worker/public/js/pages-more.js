// 帳戶、單一持股、「我要…」的各種操作、建立帳戶、登入。
import { api, setToken } from './api.js';
import { actionText, day, h, money, pct, put, qty, toast } from './dom.js';
import { consoleBox, glass, meterEl, menuList, page, tiles } from './layout.js';
import { aiBlock, bucketTag, chart, fold, rankTable } from './parts.js';
import { actionButton, errBox, linkButton, planBubble, slips, trayBody, trayTitle, undoButton } from './pages-notif.js';
import { ownMonitor, requestDrafts } from './pages-ai.js';
import { say } from './slime.js';

const em = (t) => ({ t, tone: 'em' });

// ---------------------------------------------------------------- 帳戶

const GROUPS = [
  { id: 'own', name: '自選', who: '你選的股票。慢規則當保險：比高點低 20% 減半，站回 200 日均線再買回。' },
  { id: 'mom', name: '動能', who: '規則照一年報酬的排名選 5 檔。掉出前 15 名才賣。' },
  { id: 'core', name: '核心', who: '其他兩桶減下來的錢都回到這裡；要加回的錢也從這裡拿。' },
];

function holdRow(x) {
  const inner = [
    h('div', null, h('span', { class: 'tk' }, x.ticker), x.shares ? h('span', { class: 'num dim', style: 'margin-left:12px' }, `${qty(x.shares)} 股`) : null, x.target ? h('span', { class: 'small faint', style: 'margin-left:12px' }, x.target) : null),
    h('div', { class: 'val' }, money(x.value), h('span', { class: 'faint', style: 'margin-left:10px' }, pct(x.pct))),
    // 有門檻條的就只放條（條本身就夠清楚）；沒有門檻的（現金、短債、你自己管的）寫一句狀態
    x.meter ? h('div', { class: 'gz', title: x.meter.label }, meterEl(x.meter)) : h('div', { class: 'state' }, h('b', { class: x.tone === 'warn' || x.tone === 'alert' ? x.tone : null }, x.state), x.detail ? h('span', { class: 'dim', style: 'margin-left:12px' }, x.detail) : null),
  ];
  return x.ticker === '現金' ? h('div', { class: 'hold' }, inner) : h('a', { class: 'hold', href: `#/h/${encodeURIComponent(x.ticker)}` }, inner);
}

function legend(a) {
  const ms = a.holdings.map((x) => x.meter).filter(Boolean);
  if (!ms.length) return null;
  const go = ms.some((m) => m.kind === 'go');
  return h(
    'div',
    { class: 'legend' },
    h('span', { class: 'legend-pic', 'aria-hidden': 'true' }, meterEl({ t: 0.7, v: 0.38, s: 'ok', zone: '', kind: 'stop', label: '' })),
    h('p', null, '每一檔下面的條：', h('b', null, '白點是現在的位置'), '，條越長代表越接近規則的門檻；', h('b', { class: 'r' }, '紅色的那一段'), '是會觸發規則（減半、賣出或啟動）的範圍。', go ? [h('b', { class: 'g2' }, '藍色的那一段'), '是會買回的範圍。'] : null),
  );
}

export function accountPage(ctx) {
  const st = ctx.state;
  const a = st.account;
  if (!a) return page({ banner: { title: '帳戶', sub: '還沒有帳戶。', bubble: st.bubble.todo }, pane: h('a', { class: 'btn', href: '#/' }, '回待辦') });
  const refresh = () => ctx.refresh();
  const groups = GROUPS.map((g) => {
    const rows = a.holdings.filter((x) => x.bucket === g.id);
    const b = a.buckets.find((x) => x.id === g.id);
    const hot = rows.filter((x) => x.tone === 'alert').length;
    const near = rows.filter((x) => x.tone === 'warn').length;
    return fold(
      'account.' + g.id,
      [
        h('h2', { class: 'group-name', 'data-b': g.id }, h('i', { class: 'g' }), g.name),
        h('span', { class: 'group-val' }, money(b.value)),
        h('span', { class: 'small dim' }, '占 ', h('span', { class: 'num' }, pct(b.pct, 0)), '，預算 ', h('span', { class: 'num' }, pct(b.budget, 0))),
        hot ? h('span', { class: 'chip hot' }, h('i', { class: 'led' }), `${hot} 檔碰到門檻`) : near ? h('span', { class: 'chip warn' }, h('i', { class: 'led' }), `${near} 檔接近門檻`) : null,
        h('span', { class: 'small faint when-closed' }, rows.length ? rows.map((x) => x.ticker).join('、') : '空的'),
      ],
      [h('p', { class: 'small group-who' }, g.who), glass('', rows.length ? rows.map(holdRow) : h('p', { class: 'pad small faint' }, '這一桶現在是空的。'))],
      '',
      { 'data-b': g.id },
    );
  });
  const pane = [
    legend(a),
    a.monthlyBlocked ? h('p', { class: 'notice', style: 'margin:0 0 14px' }, '有還沒分類的持股變動，月報暫停中。到「待辦與紀錄」回答那筆變動屬於哪一桶。') : null,
    a.unclassified.length ? glass('pad', h('b', null, '還沒分類：'), a.unclassified.map((u) => `${u.ticker} ${u.shares > 0 ? '+' : '−'}${qty(u.shares)} 股`).join('、')) : null,
    groups,
    a.excluded.length
      ? [
          h('h2', { class: 'sec' }, '你排除的動能股票'),
          glass(
            '',
            a.excluded.map((x) =>
              h(
                'div',
                { class: 'hold' },
                h('div', null, h('span', { class: 'tk' }, x.ticker), h('span', { class: 'small dim', style: 'margin-left:10px' }, `${day(x.date)}：${x.reason}`)),
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
    a.adopted.length ? [h('h2', { class: 'sec' }, '你認養到自選的股票'), glass('pad small', a.adopted.map((x) => h('div', null, h('span', { class: 'tk' }, x.ticker), h('span', { style: 'margin-left:12px' }, `${day(x.date)}：${x.reason}`))))] : null,
    a.ranking.length
      ? h(
          'div',
          { style: 'margin-top:30px' },
          fold('account.ranking', [h('h2', { class: 'fold-title' }, '動能排名'), st.rankDate ? h('span', { class: 'small dim num' }, day(st.rankDate)) : null], [glass('pad', rankTable(a.ranking), h('p', { class: 'small faint', style: 'margin-top:8px' }, '買前 5 名；持有的掉出前 15 名才賣。'))]),
        )
      : null,
  ];
  return page({
    view: 'account',
    banner: { kicker: a.snapshotDate ? `上一份快照 ${day(a.snapshotDate)}` : '還沒有快照', title: '帳戶', sub: `每一股都記在三桶其中之一。上一份快照：${a.snapshotDate ? day(a.snapshotDate, true) : '還沒有'}。`, bubble: st.bubble.account },
    pane,
    rail: [...tiles(st), h('p', { class: 'rail-note' }, '三桶的比例是風險預算，不是要維持的目標：系統不會只為了把比例拉回來叫你下單。')],
  });
}

// ---------------------------------------------------------------- 單一持股

export async function holdingPage(ctx, ticker) {
  const d = await api.get('/holding/' + encodeURIComponent(ticker));
  const st = ctx.state;
  const rows = st.account?.holdings.filter((x) => x.ticker === d.ticker) ?? [];
  const main = rows.find((x) => x.meter) ?? rows[0];
  const bubble = main
    ? { k: '這一檔現在', say: [em(main.state), main.detail ? `。${main.detail}。` : '。'], mood: main.tone === 'alert' ? 'alert' : main.tone === 'warn' ? 'worry' : 'watch' }
    : { k: '這一檔現在', say: ['目前沒有持有。'], mood: 'idle' };
  return page({
    view: 'page',
    banner: {
      back: { href: '#/account', label: '帳戶' },
      title: h('span', { class: 'tk' }, d.ticker),
      sub: d.positions.length ? d.positions.map((p) => `${p.bucketName} ${qty(p.shares)} 股（${money(p.value)}，占 ${pct(p.pct)}）`).join('；') : '目前沒有持有。',
      bubble,
    },
    pane: h('div', { class: 'stackv' },
      main?.meter ? glass('pad', h('h2', { class: 'panel-h' }, main.meter.zone === '賣出' ? '離動能的賣出門檻多遠' : main.meter.zone === '啟動' ? '離崩盤規則多遠' : main.meter.zone === '買回' ? '離買回多遠' : '離慢規則的減半門檻多遠'), meterEl({ ...main.meter, say: `${main.state}。${main.detail}` }, 'big')) : null,
      glass('pad', chart(d.chart)),
      glass('pad', h('dl', { class: 'facts' }, d.facts.map((f) => [h('dt', null, f.label), h('dd', null, h('span', { class: 'num' }, f.value), f.note ? h('small', null, f.note) : null)]))),
      d.own
        ? glass(
            'pad',
            h('h2', { class: 'panel-h' }, actionText(`自選：${d.own.state}，標準比重 ${pct(d.own.stdWeight)}`)),
            h('h5', { style: 'margin-top:10px' }, '這檔的前提（你為什麼持有它）'),
            h('ul', { class: 'prem' }, d.own.premises.map((p) => h('li', null, h('span', { class: 'st' }, p.origin), h('span', null, p.text)))),
            d.own.lastReview ? h('p', { class: 'small dim', style: 'margin-top:10px' }, 'AI 最近一次審查：' + d.own.lastReview) : h('p', { class: 'small faint', style: 'margin-top:10px' }, 'AI 還沒有審查過這一檔。'),
            aiBlock(d.ai),
            ...ownMonitor(ctx, d),
            ...ownEdit(ctx, d),
          )
        : null,
      d.history.length ? [h('h2', { class: 'sec', style: 'margin:24px 0 0' }, '這檔的紀錄'), h('div', { class: 'glass rec' }, d.history.map((x) => (x.notif ? h('a', { class: 'rowlink', href: `#/n/${x.notif}` }, h('span', { class: 'd num' }, day(x.date)), h('span', null, x.text), h('span')) : h('div', { class: 'rowlink' }, h('span', { class: 'd num' }, day(x.date)), h('span', null, x.text), h('span')))))] : null,
    ),
    rail: tiles(st),
  });
}

// ---------------------------------------------------------------- 我要…

export function doPage(ctx) {
  return page({
    view: 'page',
    banner: { title: '我要…', sub: '你自己發起的操作。每一種都先試算給你看清單和理由，確定了才記下來。', bubble: { k: '我要…', say: ['每一種操作都會', em('先試算'), '給你看要下哪些單和理由，確定了才記下來。'], mood: 'watch' } },
    pane: menuList(ctx.state, 'menu glass'),
    rail: tiles(ctx.state),
  });
}

/**
 * 共用流程：左邊填表 → 右邊的主控台按「試算」→ 看清單與理由 → 確定。
 * fields：表單的內容；payload：送出的資料；path：API；confirmLabel：確定的按鈕。
 */
function opPage({ title, sub, fields, payload, path, confirmLabel, note }) {
  return (ctx) => {
    const msg = h('div');
    const out = h('div');
    const con = h('div', { style: 'display:contents' });
    const ctaBox = h('div', { class: 'sticky-cta' });
    let trial = null;
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
        trial = v;
        put(
          out,
          h('h2', { class: 'sec' }, '試算：會給你這份清單'),
          r.mergedIntoMonthly ? h('p', { class: 'notice', style: 'margin:0 0 12px' }, '今天的月報還沒回覆，所以入金會和月報合成一份清單，取代原本那一份。') : null,
          slips(v, { editable: false }),
          h('p', { class: 'small dim', style: 'margin:10px 0' }, note ?? '確定之後才會記進帳戶；清單會出現在「待辦與紀錄」。'),
        );
        draw();
        say(planBubble(v.composed, '試算的結果'), 'jiggle');
      } catch (e) {
        trial = null;
        out.replaceChildren();
        msg.replaceChildren(errBox(e));
        draw();
      }
    };
    const draw = () => {
      if (!trial) {
        const go = actionButton('試算', 'primary block', run(true));
        con.replaceChildren(consoleBox('要下的單', h('p', { class: 'con-empty' }, '左邊填好之後按「試算」，這裡會列出要下的單和做完的現金。'), [go, h('div', { class: 'linkrow' }, h('a', { class: 'linkbtn', href: '#/' }, '算了'))]));
        ctaBox.replaceChildren(h('div', { class: 'sum' }, '先試算，確定了才記下來'), actionButton('試算', 'primary', run(true)));
      } else {
        con.replaceChildren(consoleBox(trayTitle(trial.composed), trayBody(trial.composed), [actionButton(confirmLabel, 'primary block', run(false)), h('div', { class: 'linkrow' }, linkButton('改了數字，重新試算', run(true)), h('a', { class: 'linkbtn', href: '#/' }, '算了'))]));
        ctaBox.replaceChildren(h('div', { class: 'sum' }, `${trial.composed.orders.filter((o) => !o.transfer).length} 張單，做完現金約 ${money(trial.composed.cashAfter)}`), actionButton('確定', 'primary', run(false)));
      }
    };
    draw();
    const form = h('form', { class: 'glass pad narrow-sm', onsubmit: (ev) => ev.preventDefault() }, fields(ctx), msg);
    form.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && ev.target.tagName === 'INPUT') {
        ev.preventDefault();
        run(true)();
      }
    });
    return page({
      view: 'flow',
      banner: { back: { href: '#/do', label: '我要…' }, title, sub, bubble: { k: '試算之前', say: ['填好之後按「試算」，我會先算給你看要下哪些單；', em('確定了才記下來'), '。'], mood: 'watch' } },
      pane: [form, out],
      rail: con,
      cta: ctaBox,
    });
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
      return h('label', { class: 'field', style: 'margin:0' }, h('span', null, '入金金額（美元）'), h('div', { style: 'max-width:12em' }, amt), h('small', null, '登記後現金立刻入帳，清單才算得出來。'));
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
      return h('label', { class: 'field', style: 'margin:0' }, h('span', null, '出金金額（美元）'), h('div', { style: 'max-width:12em' }, amt), h('small', null, '現金在清單做完、你填快照的時候才扣。'));
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
      const row = (b, name, el, hint) => h('label', { class: 'field' }, h('span', null, bucketTag(b, name)), h('div', { style: 'display:flex;align-items:center;gap:8px' }, el, '%'), h('small', null, hint));
      return h('div', null, row('own', '自選', own, '你自己選的股票。每一檔的股數與標準比重會照新舊比例縮放。'), row('mom', '動能', strat, '規則照排名選的 5 檔。調成 0 就是全部賣掉。'), row('core', '核心', core, 'VOO。其他兩桶的差額都由這裡吸收。'), h('p', null, sum), h('p', { class: 'small dim', style: 'margin-top:6px' }, '在動能落後大盤的時候把它調成 0，等於在相對低點放棄它。系統不會擋，但原本的比例會繼續記著，之後可以回頭比較。'));
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

// 持股頁：改標準比重、加前提、請 AI 草擬前提（2026-11-15 起取代新增／移除自選兩頁；新增和賣光都在填快照做）
function ownEdit(ctx, d) {
  const msg = h('div');
  const fail = (e) => msg.replaceChildren(errBox(e));
  const std = h('input', { class: 'num-in', type: 'text', inputmode: 'decimal', value: (d.own.stdWeight * 100).toFixed(1), style: 'width:6em', 'aria-label': '標準比重（%）' });
  const saveStd = actionButton('改標準比重', '', async () => {
    const v = Number(std.value.replace(/[%\s]/g, ''));
    if (!(v > 0 && v <= 50)) return fail(new Error('標準比重填 0.1～50（%）'));
    try {
      await api.post('/ops/std-weight', { ticker: d.ticker, stdWeight: v / 100 });
      toast(`${d.ticker} 的標準比重改成 ${v}%`);
      ctx.refresh();
    } catch (e) {
      fail(e);
    }
  });
  const mine = h('textarea', { rows: 2, placeholder: '一行一條，例如：\nAI 伺服器出貨兩年內持續成長\n毛利率跌破 70% 就賣' });
  const addMine = actionButton('加進前提', '', async () => {
    const xs = mine.value.split('\n').map((x) => x.trim()).filter(Boolean);
    if (!xs.length) return fail(new Error('還沒寫前提'));
    try {
      await api.post('/ops/own-premises', { ticker: d.ticker, premises: xs.map((text) => ({ text })) });
      // 請 AI 把你寫的出場條件改寫成可以追蹤的格式（結果出現在這一頁，勾選後才監測；AI 層沒設定就略過）
      api.post('/ops/own-check', { ticker: d.ticker, lines: xs }).catch(() => {});
      toast('已加進前提');
      ctx.refresh();
    } catch (e) {
      fail(e);
    }
  });
  const draftSlot = h('div');
  const askAi = h('button', {
    class: 'btn',
    type: 'button',
    onclick: async (ev) => {
      ev.target.disabled = true;
      const status = h('span', { class: 'faint small', style: 'margin-left:8px' }, '已送出，AI 通常幾分鐘內回來…');
      ev.target.after(status);
      try {
        const v = await requestDrafts(d.ticker, [], (t) => (status.textContent = t));
        if (!v.drafts.length) throw new Error(v.summary || 'AI 沒有草擬出前提');
        status.remove();
        const boxes = v.drafts.map((x) => ({ x, box: h('input', { type: 'checkbox', checked: true }) }));
        draftSlot.replaceChildren(
          h('div', null, boxes.map(({ x, box }) => h('label', { style: 'display:block;margin:6px 0' }, box, ' ', x.text, h('span', { class: 'faint' }, `（不成立的訊號：${x.breaksIf}）`)))),
          actionButton('加入勾選的前提', '', async () => {
            const ps = boxes.filter((b) => b.box.checked).map((b) => ({ text: b.x.text, origin: 'AI_DRAFT_ACCEPTED', breaksIf: b.x.breaksIf }));
            if (!ps.length) return fail(new Error('至少勾一條'));
            try {
              await api.post('/ops/own-premises', { ticker: d.ticker, premises: ps });
              toast('已加進前提');
              ctx.refresh();
            } catch (e) {
              fail(e);
            }
          }),
        );
      } catch (e) {
        status.textContent = e.message;
        ev.target.disabled = false;
      }
    },
  }, '請 AI 草擬前提');
  return [
    h('h5', { style: 'margin-top:16px' }, '標準比重'),
    h('div', { class: 'btn-row', style: 'align-items:center' }, std, h('span', null, '%'), saveStd),
    h('p', { class: 'small faint' }, '加回、入金補到這個比重；改了不會馬上下單。系統推薦值是依波動度在自選預算內分的。'),
    h('h5', { style: 'margin-top:16px' }, '加前提'),
    mine,
    h('div', { class: 'btn-row', style: 'margin-top:8px' }, addMine, askAi),
    h('p', { class: 'small faint' }, '原本只有系統預設的前提時，加了你寫的就取代預設。AI 只草擬「現在的股價隱含了哪些前提」，不判斷該不該買。'),
    draftSlot,
    msg,
    h('p', { class: 'small faint', style: 'margin-top:14px' }, '不想再持有：到「填快照」把自選這一檔的股數改成 0，就會移出自選。'),
  ];
}

// ---------------------------------------------------------------- 復原上一份快照（設計 §10 第 39 點）

export function undoPage(ctx) {
  const u = ctx.state.undo;
  const at = u ? new Date(u.at).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  const body = u
    ? [
        h('p', null, `最後一份快照：${day(u.date)} 的收盤價，${at} 送出。`),
        u.cashOther ? h('p', { class: u.cashWarn ? 'small' : 'small dim', style: u.cashWarn ? 'color:var(--warn)' : null }, `那份快照的現金和估計的成交金額差 ${u.cashOther > 0 ? '+' : '−'}${money(Math.abs(u.cashOther), 2)}${u.cashWarn ? '，大到不太像成交價差、手續費或股利。' : '。'}`) : null,
        h('h5', { style: 'margin-top:14px' }, '復原會退回'),
        h('ul', { class: 'small dim', style: 'margin:6px 0 14px 1.2em' }, h('li', null, '那份快照記下的成交、其他現金變動；因為股數改成 0 而移出的自選（前提、標準比重、規則狀態都回來）。'), h('li', null, '那份快照完成的清單，回到「等成交」。'), h('li', null, '帳戶回到送出之前；之後到「填快照」重填。')),
        undoButton(ctx, '確定復原'),
      ]
    : [h('p', null, '現在沒有可以復原的快照。'), h('p', { class: 'small dim' }, '只能復原最後一份快照，而且之後帳戶還沒有其他變動（收盤後的每日流程、入金出金、回覆通知、改標準比重…）。不符合的話，再填一次快照把數字改對就好。'), h('div', { class: 'btn-row', style: 'margin-top:12px' }, h('a', { class: 'btn', href: '#/snapshot' }, '去填快照'))];
  return page({
    view: 'page',
    banner: { back: { href: '#/do', label: '我要…' }, title: '復原上一份快照', sub: '帳戶回到最後一份快照送出之前，再重填。', bubble: { k: '復原', say: [u ? `可以復原 ${day(u.date)} 那份快照。` : '現在沒有可以復原的快照。'], mood: u?.cashWarn ? 'worry' : u ? 'watch' : 'idle' } },
    pane: glass('pad narrow', body),
    rail: tiles(ctx.state),
  });
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
  const summary = h('ul', { class: 'sum-list' });
  const val = (el) => {
    const t = el.value.replace(/[,\s$]/g, '');
    return t === '' ? 0 : Number(t);
  };
  const recount = () => {
    const n = (k) => rows[k].filter((r) => r.ticker.value.trim()).length;
    put(summary, h('li', null, h('span', null, '核心'), h('span', { class: 'num' }, `VOO ${val(core) || 0} 股${val(bond) ? `、SGOV ${val(bond)} 股` : ''}`)), h('li', null, h('span', null, '現金'), h('span', { class: 'num' }, money(val(cash) || 0))), h('li', null, h('span', null, '自選'), h('span', null, `${n('own')} 檔`)), h('li', null, h('span', null, '動能'), h('span', null, `${n('mom')} 檔`)), h('li', null, h('span', null, '紙上交易'), h('span', null, paper.checked ? '是' : '否')));
  };
  const addRow = (kind) => {
    const r = { ticker: h('input', { type: 'text', placeholder: '代號', style: 'text-transform:uppercase;width:6.5em' }), shares: h('input', { class: 'num-in', type: 'text', inputmode: 'decimal', placeholder: '股數', style: 'width:6em' }), std: kind === 'own' ? h('input', { class: 'num-in', type: 'text', inputmode: 'decimal', placeholder: '建議值', style: 'width:5.5em' }) : null, why: kind === 'own' ? h('input', { type: 'text', placeholder: '為什麼持有（選填）', style: 'min-width:13em' }) : null };
    rows[kind].push(r);
    r.ticker.addEventListener('input', recount);
    lists[kind].append(h('tr', null, h('td', null, r.ticker), h('td', { class: 'r' }, r.shares), kind === 'own' ? [h('td', { class: 'r wide' }, h('div', { style: 'display:flex;gap:6px;align-items:center;justify-content:flex-end' }, r.std, '%')), h('td', { class: 'wide' }, r.why)] : null));
  };
  for (let k = 0; k < 4; k++) addRow('own');
  for (let k = 0; k < 5; k++) addRow('mom');
  [cash, core, bond, paper].forEach((e) => e.addEventListener('input', recount));
  recount();
  const msg = h('div');
  const create = async () => {
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
  };
  const table = (kind, heads) => h('div', { class: 'scroll-x' }, h('table', { class: 'snap' }, h('thead', null, h('tr', null, heads.map((x, k) => h('th', { class: k === 1 ? 'r' : k > 1 ? 'wide' : null }, x)))), lists[kind]));
  const sec = (b, name) => h('h2', { class: 'sec' }, bucketTag(b, name));
  return page({
    view: 'flow',
    banner: { back: { href: '#/', label: '回首頁' }, title: '建立帳戶', sub: '照券商現在的畫面填。只是分類，不會叫你交易；這份快照就是帳本的起點。', bubble: { k: '建立帳戶', say: ['照券商現在的畫面填就好。', em('不會叫你交易'), '，只是記下每一檔放在哪一桶。'], mood: 'watch' } },
    pane: [
      sec('core', '核心'),
      glass('pad narrow-sm', h('label', { class: 'field' }, h('span', null, 'VOO 股數'), h('div', { style: 'max-width:10em' }, core)), h('label', { class: 'field' }, h('span', null, 'SGOV（短債）股數'), h('div', { style: 'max-width:10em' }, bond), h('small', null, '沒有就留空。')), h('label', { class: 'field', style: 'margin:0' }, h('span', null, '現金（美元）'), h('div', { style: 'max-width:10em' }, cash))),
      sec('own', '自選'),
      h('p', { class: 'small dim', style: 'margin-bottom:10px' }, '你自己選的股票。標準比重留空就用建議值（自選預算 20% 內，波動越大比重越小）。現在已經比 52 週高點低 20% 以上的，一開始記成「減半」狀態。'),
      glass('', table('own', ['代號', '股數', '標準比重', '為什麼持有']), h('div', { class: 'pad' }, h('button', { class: 'btn', type: 'button', onclick: () => addRow('own') }, '再加一檔'))),
      sec('mom', '動能'),
      h('p', { class: 'small dim', style: 'margin-bottom:10px' }, '照動能名單買的股票。還沒開始照動能買的話，全部留空：下一份月報會給你進場的清單。'),
      glass('', table('mom', ['代號', '股數']), h('div', { class: 'pad' }, h('button', { class: 'btn', type: 'button', onclick: () => addRow('mom') }, '再加一檔'))),
      h('label', { class: 'check-row' }, paper, h('span', null, h('b', null, '紙上交易'), h('span', { class: 'dim', style: 'margin-left:12px' }, '流程照跑，帳本標記成紙上。正式上線前先用這個。'))),
      msg,
    ],
    rail: consoleBox('要建立的帳戶', summary, [actionButton('建立帳戶', 'primary block', create)], '帳戶'),
    cta: h('div', { class: 'sticky-cta' }, h('div', { class: 'sum' }, '填好就建立'), actionButton('建立帳戶', 'primary', create)),
  });
}

// ---------------------------------------------------------------- 登入

const KEY_AUTO_LOGIN = 'stockbot.autoLogin';

/** 401 時的畫面。設好 LINE 登入（data.login 有值）：沒登入過就直接導去 LINE（兩分鐘內最多自動一次，避免 cookie 被擋時繞圈），
 *  否則顯示「用 LINE 登入」按鈕。管理金鑰（ADMIN_TOKEN）一直留著當備用。 */
export function authPage(reason, retry, data = {}) {
  const loginHref = data.login ? `${data.login}?next=${encodeURIComponent(location.hash || '#/')}` : null;
  if (loginHref && reason === 'NO_SESSION') {
    let last = 0;
    try {
      last = Number(sessionStorage.getItem(KEY_AUTO_LOGIN)) || 0;
    } catch {
      /* 讀不到就當作沒試過 */
    }
    if (Date.now() - last > 120000) {
      try {
        sessionStorage.setItem(KEY_AUTO_LOGIN, String(Date.now()));
      } catch {
        /* 存不了：最多多導一次 */
      }
      location.replace(loginHref);
    }
  }
  const key = h('input', { type: 'password', autocomplete: 'off' });
  const keyForm = h(
    'form',
    {
      class: 'glass pad narrow-sm',
      style: loginHref ? 'margin-top:16px' : null,
      onsubmit: (ev) => {
        ev.preventDefault();
        setToken(key.value.trim());
        retry();
      },
    },
    h('label', { class: 'field' }, h('span', null, loginHref ? '備用：管理金鑰（ADMIN_TOKEN）' : '管理金鑰（ADMIN_TOKEN）'), key, h('small', null, '只留在這個分頁，關掉就沒了。')),
    h('button', { class: 'btn' + (loginHref ? '' : ' primary'), type: 'submit' }, '進入'),
  );
  if (loginHref) {
    const expired = reason === 'BAD_SESSION';
    return page({
      banner: { title: expired ? '需要重新登入' : '登入', sub: expired ? '登入已經過期（30 天）。用 LINE 再登入一次就好。' : '這個網站只給你自己的 LINE 帳號使用。', bubble: { k: '登入', say: ['在 LINE 裡打開的話，通常會', em('自動登入'), '。'], mood: 'idle' } },
      pane: [h('a', { class: 'btn primary', href: loginHref }, '用 LINE 登入'), keyForm],
    });
  }
  return page({
    banner: { title: '還沒設定登入', sub: '這個網站用 LINE 登入，Worker 還沒設定好。設定步驟在 worker/SETUP.md。', bubble: { k: '登入', say: ['設定好 LINE 登入之前，可以先用', em('管理金鑰'), '進來。'], mood: 'idle' } },
    pane: keyForm,
  });
}
