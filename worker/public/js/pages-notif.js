// 待辦、通知頁（三步驟：看建議與理由 → 下單 → 填快照）、填快照。
import { api, getMode } from './api.js';
import { actionText, day, h, money, pct, push, put, qty, toast } from './dom.js';
import { bucketTag, chevron, headline, orderRows, whyBlock } from './parts.js';

const errBox = (e) => h('p', { class: 'err', role: 'alert' }, e?.message ?? String(e));

/** 按鈕按下去到伺服器回應之前先停用，避免連按兩次。 */
export function busy(btn, fn) {
  return async (ev) => {
    ev?.preventDefault();
    if (btn.disabled) return;
    btn.disabled = true;
    try {
      await fn(ev);
    } finally {
      btn.disabled = false;
    }
  };
}
export function actionButton(label, cls, fn) {
  const b = h('button', { class: 'btn ' + cls, type: 'button' }, label);
  b.addEventListener('click', busy(b, fn));
  return b;
}

// ---------------------------------------------------------------- 帳戶摘要（首頁右邊、帳戶頁上方）

export function accountSummary(a, priceDate) {
  return h(
    'section',
    { class: 'panel pad', 'aria-label': '帳戶摘要' },
    h('div', { class: 'small dim' }, `總資產（${day(priceDate)}收盤）`, a.paper ? h('span', { class: 'pill warn', style: { marginLeft: '8px' } }, '紙上交易') : null),
    h('div', { class: 'total' }, money(a.total)),
    h(
      'div',
      { class: 'bbar', role: 'img', 'aria-label': a.buckets.map((b) => `${b.name} ${pct(b.pct, 0)}（預算 ${pct(b.budget, 0)}）`).join('、') },
      a.buckets.filter((b) => b.pct > 0.002).map((b) => h('span', { 'data-b': b.id, style: { flex: `${Math.max(b.pct, 0.001)} 1 0` }, title: `${b.name} ${money(b.value)}` })),
    ),
    h(
      'div',
      { class: 'blegend' },
      a.buckets.map((b) => h('div', { 'data-b': b.id }, h('b', null, b.name), h('div', { class: 'num' }, money(b.value)), h('div', { class: 'faint' }, `占 ${pct(b.pct, 0)}`, h('br'), `預算 ${pct(b.budget, 0)}`))),
    ),
    h(
      'div',
      { class: 'statuses' },
      a.status.map((x) => h('div', null, h('span', { class: 'dim' }, x.label), h('b', { class: x.tone === 'warn' ? 'warn' : null, style: x.tone === 'warn' ? { color: 'var(--warn)' } : null }, x.value), h('small', null, x.detail))),
    ),
  );
}

// ---------------------------------------------------------------- 待辦

const TODO = {
  ANSWER: { pill: '要你回答', cls: 'sell', cta: '回答' },
  TRADE: { pill: '等你下單、填快照', cls: 'now', cta: '看下單清單' },
  DECIDE: { pill: '等你決定', cls: 'now', cta: '看理由、做決定' },
  INFO: { pill: '提醒', cls: 'warn', cta: '打開' },
};

function todoCard(t, ctx) {
  const k = TODO[t.type];
  return h(
    'article',
    { class: 'todo' },
    h('div', { class: 'todo-head' }, h('span', { class: 'pill ' + k.cls }, k.pill), h('h3', null, actionText(t.title)), h('span', { class: 'small faint num' }, day(t.date))),
    t.lines.length ? h('ul', { class: 'todo-lines' }, t.lines.map((l) => h('li', { 'data-b': l.bucket }, h('span', { class: 't' }, l.text), l.why ? h('span', { class: 'w' }, l.why) : h('span')))) : null,
    t.type === 'INFO' && t.note ? h('p', { class: 'small dim', style: { padding: '0 16px 10px' } }, t.note) : null,
    h(
      'div',
      { class: 'todo-foot btn-row' },
      h('a', { class: 'btn primary', href: `#/n/${t.id}` }, k.cta),
      t.type === 'TRADE' ? h('a', { class: 'btn', href: '#/snapshot' }, '下完單了，填快照') : null,
      t.type === 'INFO'
        ? actionButton('知道了', '', async () => {
            await api.post(`/notif/${t.id}/respond`, { mode: 'DO' });
            ctx.refresh();
          })
        : null,
    ),
  );
}

export function homePage(ctx) {
  const st = ctx.state;
  if (!st.account) return noAccount(ctx);
  const n = st.todo.length;
  const quick = h(
    'div',
    { class: 'btn-row', style: { marginTop: '12px' } },
    h('a', { class: 'btn', href: '#/do/deposit' }, '入金'),
    h('a', { class: 'btn', href: '#/do/withdraw' }, '出金'),
    h('a', { class: 'btn', href: '#/snapshot' }, '填快照'),
    h('a', { class: 'btn quiet', href: '#/do' }, '其他操作'),
  );
  return h(
    'div',
    null,
    h('div', { class: 'page-head hero' }, h('h1', null, actionText(n ? `有 ${n} 件事等你` : '現在不用動')), h('p', { class: 'sub' }, `今天 ${day(st.today)}。數字用 ${day(st.priceDate)}的收盤價。`)),
    h(
      'div',
      { class: 'cols' },
      h(
        'div',
        null,
        n
          ? st.todo.map((t) => todoCard(t, ctx))
          : h('div', { class: 'panel empty' }, h('h3', null, '沒有要操作的事'), h('p', { class: 'dim' }, '有事的時候才會出現在這裡：每月第一個交易日的月報、自選股的大變動、或你自己登記的入金出金。沒照清單做也沒關係，隨時可以填快照對帳。')),
        st.recent.length ? [h('h2', { class: 'sec' }, '最近'), h('div', { class: 'panel' }, st.recent.map(historyRow))] : null,
      ),
      h('div', { class: 'rail' }, accountSummary(st.account, st.priceDate), quick),
    ),
  );
}

export function historyRow(r) {
  return h('a', { class: 'rowlink', href: `#/n/${r.id}` }, h('span', { class: 'd num' }, day(r.date)), h('span', null, r.title), h('span', { class: 'pill' }, r.statusLabel), r.summary ? h('span', { class: 's' }, r.summary) : null);
}

function noAccount(ctx) {
  const st = ctx.state;
  if (st.hasAccount) return h('div', { class: 'narrow' }, h('div', { class: 'page-head' }, h('h1', null, '暫時看不到帳戶')), h('p', null, '帳戶在，但還沒有可用的價格資料，所以算不出市值與清單。上面的訊息寫了原因。'));
  return h(
    'div',
    { class: 'narrow' },
    h('div', { class: 'page-head' }, h('h1', null, '還沒有帳戶'), h('p', { class: 'sub' }, '填一次券商裡現在的持股，stock bot 之後就從這份快照開始記帳。')),
    h(
      'div',
      { class: 'menu' },
      h('a', { href: '#/setup' }, h('b', null, '建立帳戶'), h('span', null, '填每一檔的股數與現金，決定每一檔放自選還是動能。預設是紙上交易。')),
      h(
        'a',
        {
          href: '#/',
          onclick: (ev) => {
            ev.preventDefault();
            ctx.setMode('demo');
          },
        },
        h('b', null, '先用示範資料看看'),
        h('span', null, '假的價格與假的 AI 內容，可以隨便按。不會動到真正的帳本。'),
      ),
    ),
  );
}

// ---------------------------------------------------------------- 通知頁

const STEPS = ['看建議、做決定', '到券商下單', '回來填快照'];
/**
 * 三步驟。cur：現在在第幾步（4 = 都做完了）。
 * back：可以點回去的步驟，{ 1: { label, go 或 href }, 2: … }；沒給的步驟只是顯示。
 */
export function stepBar(cur, back = {}) {
  return h(
    'ol',
    { class: 'steps', 'aria-label': '流程' },
    STEPS.map((t, k) => {
      const n = k + 1;
      const b = n < cur ? back[n] : null;
      const inner = [h('span', { class: 'step-n', 'aria-hidden': 'true' }, n < cur ? '✓' : String(n)), h('span', { class: 'step-t' }, t, b ? h('small', null, b.label) : null)];
      let node;
      if (b?.href) node = h('a', { class: 'step-in', href: b.href }, inner);
      else if (b?.go) {
        node = h('button', { class: 'step-in', type: 'button' }, inner);
        node.addEventListener('click', busy(node, b.go));
      } else node = h('span', { class: 'step-in' }, inner);
      return h('li', { class: n < cur ? 'done' : null, 'aria-current': n === cur ? 'step' : null }, node);
    }),
  );
}

/** 上一步：已經決定、還沒填快照的清單退回第一步。上次選的選項留著。 */
const reopenAndGo = (ctx, id) => async () => {
  try {
    await api.post(`/notif/${id}/reopen`);
    toast('回到第一步。上次選的還在，改好再按一次決定');
    ctx.go(`#/n/${id}`);
  } catch (e) {
    toast(e.message);
    ctx.refresh();
  }
};

// 建議單預設收合：收合時看得到「做什麼」、一句話的「為什麼」和目前的決定；點開才是完整的理由與選項。
// 只有一項的清單直接打開。開過、關過的會記住，同一頁重畫時不會彈回去。
const slipOpen = new Map();
const shortChoice = (c) => (c ? c.label.replace(/[：（].*$/, '') : '');

/** 一張建議單。editable = 還可以改選項。 */
function slip(it, v, ui) {
  const editable = ui.editable && !it.cancelled;
  const single = it.choices.find((c) => c.id !== 'SKIP');
  const multiLines = single && single.lines.length > 1;
  // 目前的決定（收合時也看得到）
  const chip = h('span', { class: 'stamp' });
  const setChip = (id) => {
    chip.textContent = shortChoice(it.choices.find((c) => c.id === id)) || id;
    chip.classList.toggle('off', id === 'SKIP');
  };
  let showChip = true;
  if (it.cancelled) {
    chip.textContent = '已取消';
    chip.classList.add('off');
  } else if (!editable && v.status === 'PENDING') showChip = false; // 試算：還沒有決定
  else setChip(editable ? ui.choices[it.key] : it.choice);
  const act = h(
    'div',
    { class: 'slip-act' },
    multiLines
      ? h(
          'ul',
          { class: 'act-lines' },
          single.lines.map((l) => {
            // 每一行自己的理由（目前占多少、目標多少，或是碰到哪條上限）
            const why = it.explain.facts?.find((f) => f.label === `${l.bucketName} ${l.ticker}`)?.note;
            return h('li', null, h('span', { class: 'side ' + (l.shares < 0 ? 'sell' : 'buy') }, l.shares < 0 ? '賣' : '買'), h('span', { class: 'tk' }, l.ticker), h('span', { class: 'num' }, `${qty(l.shares)} 股`), h('span', { class: 'small faint' }, l.bucketName), why ? h('span', { class: 'small dim line-why' }, why) : null);
          }),
        )
      : null,
    it.note ? h('p', { class: 'note-line' }, it.note) : null,
  );
  let pick;
  if (it.cancelled) pick = h('div', { class: 'slip-pick' }, h('p', { class: 'picked' }, '這一項已取消，不用下單。'));
  else if (!editable && v.status === 'PENDING') pick = h('div', { class: 'slip-pick' }); // 試算：還沒有決定可以顯示
  else if (!editable) {
    const c = it.choices.find((x) => x.id === it.choice);
    pick = h('div', { class: 'slip-pick' }, h('p', { class: 'picked' }, '你的決定：', h('b', null, c?.label ?? it.choice), c && c.id !== 'SKIP' && !multiLines ? `（${c.text}）` : ''));
  } else {
    const name = `pick-${v.id}-${it.key}`;
    const picks = h(
      'div',
      { class: 'picks', role: 'radiogroup', 'aria-label': `${it.headline}：你的決定` },
      it.choices.map((c) =>
        h(
          'label',
          { class: 'pick' },
          h('input', {
            type: 'radio',
            name,
            value: c.id,
            checked: ui.choices[it.key] === c.id,
            onchange: () => {
              setChip(c.id);
              ui.choose(it.key, c.id);
            },
          }),
          h('span', { class: 'lab' }, c.label, c.isDefault && it.choices.length > 1 ? h('span', { class: 'dflt' }, '沒選就是這個') : null),
          h('span', { class: 'what' }, c.text),
          c.note ? h('span', { class: 'note' }, c.note) : null,
        ),
      ),
    );
    const extra = h('div', { class: 'extra' });
    const formBox = h('div');
    for (const a of it.actions) {
      extra.append(
        h(
          'button',
          {
            class: 'linkbtn',
            type: 'button',
            onclick: () => {
              const ta = h('textarea', { rows: 2, 'aria-label': a.reasonLabel });
              const msg = h('div');
              const ok = actionButton(a.label, 'primary', async () => {
                try {
                  const r = await api.post(`/notif/${v.id}/action`, { key: it.key, action: a.id, reason: ta.value });
                  toast(a.id === 'EXCLUDE' ? '已排除，清單重算了' : a.id === 'TRANSFER' ? '已轉入自選' : '已認養到自選');
                  ui.afterAction(r.notifId);
                } catch (e) {
                  msg.replaceChildren(errBox(e));
                }
              });
              formBox.replaceChildren(h('div', { class: 'panel pad', style: { marginTop: '10px' } }, h('p', { class: 'small dim', style: { marginBottom: '8px' } }, a.hint), h('label', { class: 'field' }, h('span', null, a.reasonLabel), ta), msg, h('div', { class: 'btn-row' }, ok, h('button', { class: 'btn quiet', type: 'button', onclick: () => formBox.replaceChildren() }, '取消'))));
              ta.focus();
            },
          },
          a.label,
        ),
      );
    }
    pick = h('div', { class: 'slip-pick' }, picks, it.actions.length ? extra : null, formBox);
  }
  const hasAct = act.childNodes.length > 0;
  const sum = h(
    'summary',
    { class: 'slip-sum' },
    h('div', { class: 'slip-what' }, h('div', { class: 'slip-meta' }, bucketTag(it.bucket, it.bucketName), h('span', { class: 'label' }, it.label)), headline(it.headline)),
    h('div', { class: 'slip-because' }, h('div', { class: 'why-h' }, '為什麼'), h('p', { class: 'why-short' }, it.explain.short)),
    h('div', { class: 'slip-state' }, showChip ? chip : null, chevron()),
  );
  const k = `${v.id}:${it.key}`;
  const el = h('details', { class: 'slip' + (it.cancelled ? ' off' : ''), 'data-b': it.bucket, open: slipOpen.has(k) ? slipOpen.get(k) : !!ui.openAll }, sum, h('div', { class: 'slip-grid' + (hasAct ? '' : ' no-act') }, hasAct ? act : null, whyBlock(it.explain, it.ticker), pick));
  el.addEventListener('toggle', () => slipOpen.set(k, el.open));
  return el;
}

/** 一則通知的所有建議單。lead：清單上面的一句說明（可以不給）。兩項以上時右上角有「全部展開／全部收合」。 */
export function slips(v, ui, lead = null) {
  const cards = v.items.map((it) => slip(it, v, { ...ui, openAll: v.items.length === 1 }));
  if (cards.length < 2) return h('div', { class: 'slip-list' }, lead ? h('div', { class: 'slip-bar' }, h('p', null, lead)) : null, cards);
  const all = h('button', { class: 'linkbtn', type: 'button' });
  const sync = () => (all.textContent = cards.every((c) => c.open) ? '全部收合' : '全部展開');
  all.addEventListener('click', () => {
    const open = !cards.every((c) => c.open);
    for (const c of cards) c.open = open;
  });
  for (const c of cards) c.addEventListener('toggle', sync);
  sync();
  return h('div', { class: 'slip-list' }, h('div', { class: 'slip-bar' }, h('p', null, lead ?? `${cards.length} 項，點一下看完整的理由。`), all), cards);
}

function tray(c, opt = {}) {
  const n = c.orders.filter((o) => !o.transfer).length;
  return h(
    'section',
    { class: 'panel tray', 'aria-label': '合起來要下的單' },
    h('h2', null, opt.title ?? `合起來要下 ${n} 張單`),
    n || c.orders.length ? h('table', { class: 'orders' + (opt.check ? ' checklist' : '') }, h('tbody', null, orderRows(c, opt))) : h('p', { class: 'small dim', style: { padding: '0 16px 12px' } }, '照目前的選擇，不用下任何單。'),
    h(
      'div',
      { class: 'tray-foot' },
      h('div', { class: 'cash' }, '做完之後現金約 ', h('b', null, money(c.cashAfter)), c.withdraw ? `（已扣掉要轉出的 ${money(c.withdraw)}）` : '', c.shortOfCash ? h('div', { class: 'err' }, '現金不夠：買單的金額超過現金加賣單。') : null),
      opt.foot ?? null,
    ),
  );
}

export { tray };

export async function notifPage(ctx, id) {
  const v = await api.get(`/notif/${id}`);
  const head = h(
    'div',
    { class: 'page-head' },
    h('a', { class: 'back', href: '#/' }, '待辦'),
    h('h1', null, actionText(v.title)),
    h('p', { class: 'sub' }, `${v.kindLabel}，用 ${day(v.date)}的收盤價算的。`, ' ', h('span', { class: 'pill' + (v.status === 'PENDING' || v.status === 'RESPONDED' ? ' now' : '') }, v.statusLabel)),
  );
  const root = h('div', null, head);

  // ---- 問答型：清單外的變動、現金差額
  if (v.ask && v.status === 'PENDING') {
    root.append(askForm(v, ctx));
    return root;
  }
  // ---- 沒有清單的通知
  if (!v.items.length) {
    root.append(
      h(
        'div',
        { class: 'panel pad narrow' },
        v.text ? h('p', null, v.text) : null,
        v.note ? h('p', { class: 'dim' }, '你的回答：' + ({ own: '歸自選', mom: '歸動能' }[v.note] ?? v.note)) : null,
        v.ref ? h('p', { style: { marginTop: '8px' } }, h('a', { href: `#/n/${v.ref}` }, `打開通知 #${v.ref}`)) : null,
        v.status === 'PENDING'
          ? h(
              'div',
              { class: 'btn-row', style: { marginTop: '12px' } },
              actionButton('知道了', 'primary', async () => {
                await api.post(`/notif/${v.id}/respond`, { mode: 'DO' });
                ctx.go('#/');
              }),
            )
          : null,
      ),
    );
    return root;
  }

  const backToDecide = reopenAndGo(ctx, v.id);
  if (v.step) root.append(stepBar(v.step, v.step === 2 ? { 1: { label: '回去改決定', go: backToDecide } } : {}));
  if (v.reminded && v.status === 'PENDING') root.append(h('p', { class: 'notice', style: { margin: '0 0 14px' } }, '這則通知已經超過 2 個交易日。現在回覆的話，自選慢規則的單會用最新的收盤價重算；如果這段時間規則狀態已經反轉，那一項會取消。'));

  if (v.step === 1) {
    // ---------- 第一步：每張建議單左邊是做什麼、右邊是為什麼；右欄隨時顯示合起來要下的單
    const choices = Object.fromEntries(v.items.map((it) => [it.key, it.choice]));
    let composed = v.composed;
    const trayBox = h('div');
    const sumBox = h('div', { class: 'sum' });
    const msg = h('div');
    const submit = async (mode) => {
      try {
        const r = await api.post(`/notif/${v.id}/respond`, { mode, choices });
        toast(r.status === 'RESPONDED' ? '已記下你的決定' : r.status === 'SKIPPED' ? '這次不做，已記下' : '完成');
        await ctx.refresh();
      } catch (e) {
        msg.replaceChildren(errBox(e));
        msg.scrollIntoView({ block: 'center' });
      }
    };
    const live = v.items.filter((i) => !i.cancelled);
    const skippable = live.some((i) => i.choices.some((c) => c.id === 'SKIP'));
    const drawTray = (prev) => {
      const go = actionButton('決定好了，看下單清單', 'primary block', () => submit('DO'));
      const skipAll = skippable ? actionButton('整則這次不做', 'quiet', () => submit('SKIP')) : null;
      trayBox.replaceChildren(tray(composed, { prev, foot: h('div', null, go, skipAll ? h('div', { style: { textAlign: 'center' } }, skipAll) : null, h('p', { class: 'small faint' }, '按下去只是記下你的決定，系統不會替你下單。')) }));
      const k = composed.orders.filter((o) => !o.transfer).length;
      sumBox.textContent = `${k} 張單，做完現金約 ${money(composed.cashAfter)}`;
    };
    const ui = {
      editable: true,
      choices,
      async choose(key, c) {
        choices[key] = c;
        try {
          const prev = composed;
          composed = await api.post(`/notif/${v.id}/preview`, { choices });
          drawTray(prev);
        } catch (e) {
          msg.replaceChildren(errBox(e));
        }
      },
      afterAction: (nid) => (nid && nid !== v.id ? ctx.go(`#/n/${nid}`) : ctx.refresh()),
    };
    drawTray(null);
    const mobileGo = actionButton('決定好了', 'primary', () => submit('DO'));
    root.append(
      h(
        'div',
        { class: 'cols' },
        h('div', null, v.text ? h('p', { class: 'dim', style: { marginBottom: '12px' } }, v.text) : null, slips(v, ui, `${live.length} 項建議，點開看完整的理由、改決定。沒改的就照每一張右上角寫的做。`), msg),
        h('div', { class: 'rail' }, trayBox),
      ),
      h('div', { class: 'sticky-cta' }, sumBox, mobileGo),
    );
    return root;
  }

  if (v.step === 2) {
    // ---------- 第二步：拿著這張清單去券商下單
    const text = v.composed.orders.filter((o) => !o.transfer).map((o) => `${o.shares < 0 ? '賣' : '買'} ${o.ticker} ${qty(o.shares)} 股`).join('\n');
    const foot = h(
      'div',
      null,
      h('a', { class: 'btn primary block', href: '#/snapshot' }, '下完單了，填快照'),
      h(
        'div',
        { class: 'btn-row', style: { justifyContent: 'center' } },
        actionButton('上一步：改決定', 'quiet', backToDecide),
        actionButton('複製清單', 'quiet', async () => {
          try {
            await navigator.clipboard.writeText(text);
            toast('已複製');
          } catch {
            toast('複製失敗，請手動選取');
          }
        }),
      ),
    );
    root.append(
      h(
        'div',
        { class: 'cols' },
        h(
          'div',
          null,
          tray(v.composed, { title: '到券商下這些單', check: true }),
          h(
            'div',
            { class: 'panel pad', style: { marginTop: '12px' } },
            h('p', null, '下單方式：開盤市價單、整股。股數是用 ', h('span', { class: 'num' }, day(v.date)), '的收盤價換算的。'),
            v.withdraw ? h('p', { style: { marginTop: '6px' } }, '清單做完後，從券商轉出 ', h('b', { class: 'num' }, money(v.withdraw)), '，再回來填快照。') : null,
            h('p', { class: 'dim', style: { marginTop: '6px' } }, '沒有全部做完也沒關係：照實填快照，系統會問你要補做還是就這樣。'),
          ),
          h('h2', { class: 'sec' }, '你的決定與理由'),
          slips(v, { editable: false }),
        ),
        h('div', { class: 'rail' }, h('div', { class: 'panel pad' }, foot)),
      ),
      h('div', { class: 'sticky-cta' }, h('div', { class: 'sum' }, actionButton('上一步', 'quiet', backToDecide)), h('a', { class: 'btn primary', href: '#/snapshot' }, '下完單了，填快照')),
    );
    return root;
  }

  // ---------- 已結束：留著理由給之後回頭看
  const body = h('div', { class: 'narrow', style: { maxWidth: '860px' } });
  if (v.followUp) {
    const msg = h('div');
    const answer = (fix) => async () => {
      try {
        const r = await api.post(`/notif/${v.id}/followup`, { fix });
        if (r.notifId) ctx.go(`#/n/${r.notifId}`);
        else {
          toast('好，就這樣。差額記在紀錄裡');
          ctx.refresh();
        }
      } catch (e) {
        msg.replaceChildren(errBox(e));
      }
    };
    body.append(
      h(
        'div',
        { class: 'panel pad', style: { marginBottom: '14px', borderColor: 'var(--sell)' } },
        h('h2', { class: 'panel-h' }, '快照和清單不同'),
        h('ul', null, v.followUp.map((x) => h('li', null, h('span', { class: 'tk' }, x.ticker), `：清單${x.listed < 0 ? '賣' : '買'} ${qty(x.listed)} 股，快照顯示${x.done === 0 ? '沒有變動' : `${x.done < 0 ? '賣了' : '買了'} ${qty(x.done)} 股`}`))),
        h('p', { class: 'dim small', style: { margin: '8px 0 12px' } }, '補做：給你一份差額的清單。就這樣：不再提醒，差額記在紀錄裡（動能的單下個月月報仍會再列）。'),
        msg,
        h('div', { class: 'btn-row' }, actionButton('補做差額', 'primary', answer(true)), actionButton('就這樣', '', answer(false))),
      ),
    );
  }
  if (v.status === 'SUPERSEDED') body.append(h('p', { class: 'notice', style: { margin: '0 0 14px' } }, '這份清單已經被重算過的新清單取代（排除某一檔，或月報日登記了入金）。以新的那一份為準。'));
  if (v.filled.length) {
    body.append(
      h('h2', { class: 'sec', style: { marginTop: '0' } }, '實際成交（照快照記進帳本）'),
      h('div', { class: 'panel' }, h('table', { class: 'orders' }, h('tbody', null, v.filled.map((f) => h('tr', null, h('td', null, h('span', { class: 'side ' + (f.shares < 0 ? 'sell' : 'buy') }, f.shares < 0 ? '賣' : '買')), h('td', null, h('span', { class: 'tk' }, f.ticker), ' ', h('span', { class: 'small faint' }, f.bucketName)), h('td', { class: 'q' }, `${qty(f.shares)} 股`)))))),
    );
  }
  push(body, h('h2', { class: 'sec' }, v.status === 'SKIPPED' ? '當時的建議與理由（這次沒做）' : '當時的建議、你的決定與理由'), slips(v, { editable: false }));
  root.append(body);
  return root;
}

function askForm(v, ctx) {
  const msg = h('div');
  if (v.ask.type === 'CASH_DIFF') {
    const amt = v.ask.amount;
    const kinds = amt > 0 ? ['入金', '股利', '其他'] : ['出金', '其他'];
    const pick = async (kind) => {
      try {
        await api.post(`/notif/${v.id}/cash`, { kind });
        toast('已記下：' + kind);
        ctx.go('#/');
      } catch (e) {
        msg.replaceChildren(errBox(e));
      }
    };
    return h(
      'div',
      { class: 'panel pad narrow' },
      h('p', null, '扣掉清單的成交金額之後，現金比預期', amt > 0 ? '多' : '少', '了 ', h('b', { class: 'num' }, money(Math.abs(amt), 2)), '。這筆是什麼？'),
      h('p', { class: 'small dim', style: { margin: '6px 0 12px' } }, '入金與出金不算報酬（各桶的單位淨值不受影響）；股利與其他算報酬。'),
      msg,
      h('div', { class: 'btn-row' }, kinds.map((k) => actionButton(k, k === kinds[0] ? 'primary' : '', () => pick(k)))),
    );
  }
  const { ticker, quantity, canMom } = v.ask;
  const reason = h('textarea', { rows: 2 });
  const send = (bucket) => async () => {
    try {
      const r = await api.post(`/notif/${v.id}/classify`, { bucket, reason: reason.value });
      toast(`已歸到${bucket === 'own' ? '自選' : '動能'}`);
      ctx.go(r.notifId ? `#/n/${r.notifId}` : '#/');
    } catch (e) {
      msg.replaceChildren(errBox(e));
    }
  };
  return h(
    'div',
    { class: 'panel pad narrow' },
    h('p', null, '快照裡 ', h('span', { class: 'tk' }, ticker), quantity > 0 ? ' 多了 ' : ' 少了 ', h('b', { class: 'num' }, qty(quantity)), ' 股，不在任何清單上。這筆要記在哪一桶？'),
    h('p', { class: 'small dim', style: { margin: '6px 0 12px' } }, quantity > 0 ? '清單以外自己買的股票歸自選，之後由自選的慢規則管。只有它在這個月的動能名單上、而且那一格還沒買足時，才能歸動能。' : '賣出的部分從持有它的那一桶扣。', '回答之前，月報會暫停。'),
    quantity > 0 ? h('label', { class: 'field' }, h('span', null, '為什麼買（選填，會成為這檔的前提）'), reason, h('small', null, '沒寫就用系統預設的前提。')) : null,
    msg,
    h('div', { class: 'btn-row' }, actionButton('歸自選', 'primary', send('own')), canMom ? actionButton('歸動能', '', send('mom')) : null),
  );
}

// ---------------------------------------------------------------- 填快照

export async function snapshotPage(ctx) {
  const f = await api.get('/snapshot/form');
  const only = f.lists.length === 1 ? f.lists[0] : null;
  const inputs = new Map();
  const tbody = h('tbody');
  const cash = h('input', { class: 'num-in', type: 'text', inputmode: 'decimal', placeholder: `估計約 ${f.cashExpected.toLocaleString('en-US')}`, 'aria-label': '券商顯示的現金' });
  const parse = (el) => {
    const t = el.value.replace(/[,\s$]/g, '');
    return t === '' ? NaN : Number(t);
  };
  const addRow = (r, isNew = false) => {
    const input = h('input', { class: 'num-in', type: 'text', inputmode: 'decimal', value: String(r.expected), 'aria-label': `${r.ticker || '新代號'} 的股數` });
    const tkIn = isNew ? h('input', { type: 'text', placeholder: '代號', style: { width: '6em', textTransform: 'uppercase' }, 'aria-label': '股票代號' }) : null;
    const delta = h('span', { class: 'delta' });
    const tr = h(
      'tr',
      null,
      h('td', null, isNew ? tkIn : h('span', { class: 'tk' }, r.ticker), r.where ? h('div', { class: 'small faint' }, r.where) : isNew ? h('div', { class: 'small faint' }, '清單外的股票') : null),
      h('td', { class: 'r num wide' }, isNew ? '—' : qty(r.book)),
      h('td', { class: 'r num wide' }, r.listed ? (r.listed > 0 ? '+' : '−') + qty(r.listed) : ''),
      h('td', { class: 'r' }, input),
      h('td', null, delta),
    );
    const upd = () => {
      const v = parse(input);
      const d = v - r.expected;
      const off = Number.isFinite(v) && Math.abs(d) > 1e-9;
      tr.classList.toggle('diff', off || !Number.isFinite(v));
      delta.textContent = !Number.isFinite(v) ? '要填數字' : off ? `和預期差 ${d > 0 ? '+' : '−'}${qty(d)}` : '';
    };
    input.addEventListener('input', upd);
    inputs.set(tr, { ticker: () => (isNew ? tkIn.value.trim().toUpperCase() : r.ticker), input });
    tbody.append(tr);
    if (isNew) tkIn.focus();
  };
  f.rows.forEach((r) => addRow(r));
  const msg = h('div');
  const out = h('div');
  const send = actionButton('送出快照', 'primary', async () => {
    const shares = {};
    for (const { ticker, input } of inputs.values()) {
      const t = ticker();
      const q = parse(input);
      if (!t && !(q > 0)) continue;
      if (!t) return msg.replaceChildren(errBox(new Error('有一列沒填代號')));
      if (!Number.isFinite(q) || q < 0) return msg.replaceChildren(errBox(new Error(`${t} 的股數要填 0 以上的數字`)));
      shares[t] = (shares[t] ?? 0) + q;
    }
    const c = parse(cash);
    if (!Number.isFinite(c)) {
      cash.focus();
      return msg.replaceChildren(errBox(new Error('請填券商現在顯示的現金（可用資金）。')));
    }
    try {
      const r = await api.post('/snapshot', { shares, cash: c });
      msg.replaceChildren();
      await ctx.refresh(false);
      form.hidden = true;
      // 帳本已經照快照更新，不能再回上一步
      put(stepBox, f.lists.length ? stepBar(4) : null);
      const more = r.followUps.length + r.created.length;
      out.replaceChildren(
        h(
          'div',
          { class: 'panel pad' },
          h('h2', { class: 'panel-h' }, more ? '快照收到了，還有事要你回答' : '快照收到了，帳本已更新'),
          r.completed.length ? h('p', null, `完成了 ${r.completed.length} 份清單，成交已照清單分到各桶。`) : h('p', null, '沒有等成交的清單；這份快照成為新的起點。'),
          r.followUps.length ? h('p', null, `有 ${r.followUps.length} 份清單和快照對不上，要你選補做還是就這樣。`) : null,
          r.created.map((n) => h('p', null, n.title)),
          h('div', { class: 'btn-row', style: { marginTop: '12px' } }, h('a', { class: 'btn primary', href: '#/' }, more ? '去回答' : '回待辦'), h('a', { class: 'btn', href: '#/account' }, '看帳戶')),
        ),
      );
    } catch (e) {
      msg.replaceChildren(errBox(e));
    }
  });
  const fill = f.autofill
    ? h(
        'button',
        {
          class: 'btn',
          type: 'button',
          onclick: () => {
            for (const { ticker, input } of inputs.values()) {
              input.value = String(f.autofill.shares[ticker()] ?? 0);
              input.dispatchEvent(new Event('input'));
            }
            cash.value = String(f.autofill.cash);
            toast('已填入「照清單、以開盤價成交」後的數字');
          },
        },
        '示範：幫我填成交後的數字',
      )
    : null;
  const form = h(
    'div',
    null,
    f.lists.length
      ? h('p', { style: { marginBottom: '12px' } }, '等成交的清單：', f.lists.map((l, k) => [k ? '、' : '', h('a', { href: `#/n/${l.id}` }, l.title)]), '。股數先幫你填好「照清單做完」的數字，和券商不一樣的地方直接改。')
      : h('p', { style: { marginBottom: '12px' } }, '現在沒有等成交的清單。自己交易過、或只是想對帳，都可以填：把和券商不一樣的地方改掉就好。'),
    h(
      'div',
      { class: 'panel' },
      h('table', { class: 'snap' }, h('thead', null, h('tr', null, h('th', null, '代號'), h('th', { class: 'r wide' }, '帳本'), h('th', { class: 'r wide' }, '清單'), h('th', { class: 'r' }, '券商現在的股數'), h('th', null, ''))), tbody),
      h('div', { class: 'pad btn-row' }, h('button', { class: 'btn', type: 'button', onclick: () => addRow({ ticker: '', book: 0, expected: 0, listed: 0, where: '' }, true) }, '加一檔清單外的股票'), fill),
    ),
    h(
      'div',
      { class: 'panel pad', style: { marginTop: '12px' } },
      h('label', { class: 'field', style: { marginBottom: '0' } }, h('span', null, '券商現在顯示的現金'), h('div', { style: { maxWidth: '14em' } }, cash), h('small', null, `帳本上是 ${money(f.cashBook, 2)}`, f.withdraw ? `；清單做完要轉出 ${money(f.withdraw)}，請填轉出之後的現金` : '', '。不用填成交價，系統用現金的變化對帳；差太多會問你是入金、出金還是股利。')),
    ),
    msg,
    h('div', { class: 'btn-row', style: { marginTop: '14px' } }, send, f.lists.length ? h('a', { class: 'btn', href: only ? `#/n/${only.id}` : '#/' }, '上一步：回下單清單') : null, h('a', { class: 'btn quiet', href: '#/' }, '先不填')),
    f.lists.length ? h('p', { class: 'small faint', style: { marginTop: '8px' } }, '送出之前都可以回上一步。送出之後帳本就照這份快照更新；填錯了再填一次快照就好。') : null,
  );
  // 送出之前可以回上一步：只有一份清單時直接回那一份；有好幾份就回待辦挑
  const stepBox = h('div');
  if (f.lists.length) {
    const pickOne = { label: '回待辦挑一份清單', href: '#/' };
    put(stepBox, stepBar(3, only ? { 1: { label: '回去改決定', go: reopenAndGo(ctx, only.id) }, 2: { label: '回去看下單清單', href: `#/n/${only.id}` } } : { 1: pickOne, 2: pickOne }));
  }
  return h(
    'div',
    { class: 'narrow', style: { maxWidth: '760px' } },
    h('div', { class: 'page-head' }, h('a', { class: 'back', href: '#/' }, '待辦'), h('h1', null, '填快照'), h('p', { class: 'sub' }, '照券商現在的畫面，填每一檔的股數和現金。這份快照就是帳本新的起點。')),
    stepBox,
    form,
    out,
  );
}

export { errBox, getMode };
