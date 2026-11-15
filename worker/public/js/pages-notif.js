// 待辦與紀錄、通知頁（三步驟：看建議與理由 → 下單 → 填快照）、填快照。
import { api, getMode } from './api.js';
import { aiOverview, runRow, shadowLines } from './pages-ai.js';
import { actionText, day, h, money, put, qty, toast } from './dom.js';
import { consoleBox, glass, icon, longDay, menuList, page, tiles } from './layout.js';
import { actParts, attentionList, bucketTag, chevron, headline, orderRows, whyBlock } from './parts.js';
import { copyPackButton } from './pages-thesis.js';
import { say } from './slime.js';

const errBox = (e) => h('p', { class: 'err', role: 'alert' }, e?.message ?? String(e));
const em = (t) => ({ t, tone: 'em' });
const neg = (t) => ({ t, tone: 'neg' });

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
export function linkButton(label, fn) {
  const b = h('button', { class: 'linkbtn', type: 'button' }, label);
  b.addEventListener('click', busy(b, fn));
  return b;
}

// ---------------------------------------------------------------- 待辦與紀錄

const TODO = {
  ANSWER: { chip: '要你回答', cls: 'hot', cta: '回答' },
  TRADE: { chip: '等你下單、填快照', cls: 'now', cta: '看下單清單' },
  DECIDE: { chip: '等你決定', cls: 'now', cta: '看理由、做決定' },
  INFO: { chip: '提醒', cls: 'warn', cta: '打開' },
};

function todoCard(t, ctx) {
  const k = TODO[t.type];
  return h(
    'article',
    { class: 'todo glass' },
    h('div', { class: 'todo-head' }, h('span', { class: 'chip ' + k.cls }, h('i', { class: 'led' }), k.chip), h('h3', null, actionText(t.title)), h('span', { class: 'small faint num' }, day(t.date))),
    t.lines.length ? h('ul', { class: 'todo-lines' }, t.lines.map((l) => h('li', { 'data-b': l.bucket || null }, h('span', { class: 't' }, actParts(l.text)), l.why ? h('span', { class: 'w' }, l.why) : h('span')))) : null,
    t.type === 'INFO' && t.note ? h('p', { class: 'todo-note' }, t.note) : null,
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

export function historyRow(r) {
  return h('a', { class: 'rowlink', href: `#/n/${r.id}` }, h('span', { class: 'd num' }, day(r.date)), h('span', null, actionText(r.title)), h('span', { class: 'chip' }, r.statusLabel), r.summary ? h('span', { class: 's' }, r.summary) : null);
}
const eventRow = (e) => (e.notif ? h('a', { class: 'rowlink', href: `#/n/${e.notif}` }, h('span', { class: 'd num' }, day(e.date)), h('span', null, e.text), h('span', { class: 'chip' }, '帳本')) : h('div', { class: 'rowlink' }, h('span', { class: 'd num' }, day(e.date)), h('span', null, e.text), h('span', { class: 'chip' }, '帳本')));

/** 紀錄（併在待辦頁下面）：全部／通知／帳本／沒照規則做的。 */
function records(hist, initial = 0) {
  const PAGE = 8;
  const box = h('div');
  const kinds = [
    ['全部', () => [...hist.notifs.map((n) => ({ date: n.date, el: () => historyRow(n) })), ...hist.events.filter((e) => !e.notif).map((e) => ({ date: e.date, el: () => eventRow(e) }))].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)), '還沒有紀錄。'],
    ['通知', () => hist.notifs.map((n) => ({ el: () => historyRow(n) })), '還沒有通知。'],
    ['帳本', () => hist.events.map((e) => ({ el: () => eventRow(e) })), '帳本還沒有變動。'],
    ['AI 紀錄', () => (hist.runs ?? []).map((r) => ({ el: () => runRow(r) })), '還沒有 AI 紀錄。AI 層設定好之後，每一次審查、否決、檢視都會留在這裡：看了哪些資料、每一票怎麼判、哪些引用通過檢查。', aiOverview],
  ];
  const showList = (rows, empty, top) => {
    const head = top ? top() : null;
    if (!rows.length) return box.replaceChildren(...[head, glass('empty', h('p', { class: 'dim' }, empty))].filter(Boolean));
    let n = PAGE;
    const list = h('div', { class: 'glass rec' });
    const draw = () => {
      list.replaceChildren(...rows.slice(0, n).map((r) => r.el()));
      if (rows.length > n)
        list.append(
          h(
            'button',
            {
              class: 'rec-more',
              type: 'button',
              onclick: () => {
                n += PAGE * 2;
                draw();
              },
            },
            `再顯示 ${Math.min(PAGE * 2, rows.length - n)} 筆（共 ${rows.length} 筆）`,
          ),
        );
    };
    draw();
    box.replaceChildren(...[head, list].filter(Boolean));
  };
  const shadow = () => {
    if (!hist.shadow.length) return box.replaceChildren(glass('empty', h('p', { class: 'dim' }, '還沒有。你每次都照規則做的話，這裡會是空的。')));
    box.replaceChildren(
      h('p', { class: 'small dim', style: 'margin-bottom:10px' }, '每一次規則和 AI 的建議不同、或你沒照規則做，都記一筆。之後可以回頭看：照規則、照 AI、你實際做的，哪一個比較好。'),
      shadowLines(hist.shadowSum),
      glass(
        'scroll-x',
        h(
          'table',
          { class: 'plain' },
          h('thead', null, h('tr', null, ['日期', '代號', '事件', '照規則', '照 AI', '你實際'].map((x) => h('th', null, x)))),
          h('tbody', null, hist.shadow.map((x) => h('tr', null, h('td', { class: 'num' }, day(x.date)), h('td', { class: 'tk' }, x.ticker ?? ''), h('td', null, x.title, x.note ? h('div', { class: 'small faint' }, x.note) : null), h('td', null, x.rule), h('td', null, x.ai ?? '—'), h('td', null, x.actual)))),
        ),
      ),
    );
  };
  const chips = h('span', { class: 'chips', role: 'group', 'aria-label': '紀錄的種類' });
  const names = [...kinds.map((k) => k[0]), '沒照規則做的'];
  const pick = (i) => {
    [...chips.children].forEach((b, k) => b.setAttribute('aria-pressed', String(k === i)));
    if (i < kinds.length) showList(kinds[i][1](), kinds[i][2], kinds[i][3]);
    else shadow();
  };
  names.forEach((n, i) => chips.append(h('button', { type: 'button', 'aria-pressed': 'false', onclick: () => pick(i) }, n)));
  pick(initial);
  return h('div', { class: 'rec-area', id: 'records' }, h('h2', { class: 'sec' }, '紀錄', chips), box, h('p', { class: 'small faint rec-note' }, '每一則都留著當時的建議、理由和你的決定。'));
}

export async function homePage(ctx, opt = {}) {
  const st = ctx.state;
  if (!st.account) return noAccount(ctx);
  const hist = await api.get('/history');
  const n = st.todo.length;
  return page({
    view: 'todo',
    banner: {
      kicker: longDay(st.today),
      title: actionText(n ? `有 ${n} 件事等你` : '現在不用動'),
      sub: `今天 ${day(st.today)}。數字用 ${day(st.priceDate)}的收盤價。`,
      bubble: st.bubble.todo,
    },
    pane: [
      // 上一份快照「可能填錯」（現金差額大到不像成交價差、手續費、股利）才提醒；平常要復原到「我要…」
      st.undo?.cashWarn ? cashWarnBox(ctx, st.undo.cashOther, st.undo.date) : null,
      h(
        'div',
        { class: 'todo-area' },
        n ? st.todo.map((t) => todoCard(t, ctx)) : glass('empty', h('h3', null, '沒有要操作的事'), h('p', { class: 'dim small' }, '有事的時候才會出現在這裡：每月第一個交易日的月報、自選股的大變動、或你自己登記的入金出金。沒照清單做也沒關係，隨時可以填快照對帳。')),
      ),
      records(hist, opt.records ?? 0),
    ],
    rail: tiles(st),
  });
}

function noAccount(ctx) {
  const st = ctx.state;
  if (st.hasAccount) return page({ banner: { title: '暫時看不到帳戶', sub: '帳戶在，但還沒有可用的價格資料，所以算不出市值與清單。上面的訊息寫了原因。', bubble: st.bubble.todo }, pane: null });
  const list = menuList(st, 'menu glass');
  const demo = h(
    'a',
    {
      href: '#/',
      onclick: (ev) => {
        ev.preventDefault();
        ctx.setMode('demo');
      },
    },
    icon('snapshot'),
    h('b', null, '先用示範資料看看'),
    h('span', null, '假的價格與假的 AI 內容，可以隨便按。不會動到真正的帳本。'),
  );
  list.append(h('li', null, demo));
  return page({ banner: { kicker: '開始', title: '還沒有帳戶', sub: '填一次券商裡現在的持股，stock bot 之後就從這份快照開始記帳。', bubble: st.bubble.todo }, pane: h('div', { class: 'narrow' }, list) });
}

// ---------------------------------------------------------------- 通知頁

const STEPS = ['看建議、做決定', '到券商下單', '回來填快照'];
/**
 * 三步驟（放在橫幅裡）。cur：現在在第幾步（4 = 都做完了）。
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

/** 取消自己發起的入金／出金／改比例（填快照之前；設計 §10 第 40 點）。按一次先問，再按一次才取消。 */
function cancelButton(ctx, v) {
  let armed = false;
  const b = linkButton(v.cancel.label, async () => {
    if (!armed) {
      armed = true;
      b.textContent = `確定${v.cancel.label}？再按一次`;
      return;
    }
    try {
      await api.post(`/notif/${v.id}/cancel`, {});
      toast('已取消');
      ctx.go('#/');
    } catch (e) {
      toast(e.message);
      ctx.refresh();
    }
  });
  return b;
}

/** 復原最後一份快照：帳戶回到送出之前，再重填（設計 §10 第 39 點）。 */
export function undoButton(ctx, label) {
  return actionButton(label, '', async () => {
    try {
      const r = await api.post('/snapshot/undo', {});
      toast(`已復原 ${day(r.date)} 的快照，帳戶回到送出之前`);
      ctx.go('#/snapshot');
    } catch (e) {
      toast(e.message);
      ctx.refresh();
    }
  });
}

/** 「可能填錯」的警告：差額照樣記成其他現金變動，沒填錯就不用理。 */
export function cashWarnBox(ctx, amount, date) {
  return glass(
    'pad warn-box',
    h('h3', { class: 'panel-h', style: 'color:var(--warn)' }, `${date ? `上一份快照（${day(date)}）` : '這份快照'}可能填錯了`),
    h('p', { class: 'small', style: 'margin:6px 0 10px' }, `現金和估計的成交金額差 ${amount > 0 ? '+' : '−'}${money(Math.abs(amount), 2)}，大到不太像成交價差、手續費或股利（例如忘了改現金、股數打錯）。差額已經記成其他現金變動；沒填錯就不用理。`),
    h('ul', { class: 'small dim', style: 'margin:0 0 12px 1.2em' }, h('li', null, '填錯了：復原，帳戶回到送出之前再重填。'), h('li', null, '其實是入金或出金：先復原，到「我要…」登記入金／出金後再填快照，單位淨值才不會把它算成報酬。')),
    undoButton(ctx, '復原這份快照'),
  );
}

// 建議單預設收合：收合時看得到「做什麼」、一句話的「為什麼」和目前的決定；點開才是完整的理由與選項。
// 只有一項的清單直接打開。開過、關過的會記住，同一頁重畫時不會彈回去。
const slipOpen = new Map();
const shortChoice = (c) => (c ? c.label.replace(/[：（].*$/, '') : '');

/** 一張建議單。editable = 還可以改選項。 */
function slip(it, v, ui) {
  const editable = ui.editable && !it.cancelled;
  const single = it.choices.find((c) => c.id !== 'SKIP');
  const multiLines = single && single.lines.length > 1;
  const chip = h('span', { class: 'stamp' });
  const setChip = (id) => {
    chip.textContent = shortChoice(it.choices.find((c) => c.id === id)) || id;
    chip.classList.toggle('off', id === 'SKIP');
  };
  let showChip = true;
  if (it.cancelled) {
    chip.textContent = it.revised ? '修正論點' : '已取消';
    chip.classList.add('off');
  } else if (!editable && v.status === 'PENDING') showChip = false; // 試算：還沒有決定
  else setChip(editable ? ui.choices[it.key] : it.choice);
  const act = [];
  if (multiLines) {
    act.push(
      h(
        'ul',
        { class: 'act-lines' },
        single.lines.map((l) => {
          // 每一行自己的理由（目前占多少、目標多少，或是碰到哪條上限）
          const why = it.explain.facts?.find((f) => f.label === `${l.bucketName} ${l.ticker}`)?.note;
          return h('li', null, h('span', { class: 'side ' + (l.shares < 0 ? 'sell' : 'buy') }, l.shares < 0 ? '賣' : '買'), h('span', { class: 'tk' }, l.ticker), h('span', { class: 'num' }, `${qty(l.shares)} 股`), h('span', { class: 'small faint' }, l.bucketName), why ? h('span', { class: 'small dim line-why' }, why) : null);
        }),
      ),
    );
  }
  // 慢規則項目：先寫 AI 論點檢查的結果，下面才是規則的底線與選項（own_thesis §3.2、§3.4）
  if (it.aiLine) act.push(h('p', { class: 'ai-line' }, it.aiLine));
  if (it.note) act.push(h('p', { class: 'note-line' }, it.note));
  let pick = null;
  if (it.cancelled) pick = h('p', { class: 'picked' }, it.revised ? '你用「修正論點」回應了這一項，不用下單。' : '這一項已取消，不用下單。');
  else if (!editable && v.status === 'PENDING') {
    /* 試算：還沒有決定可以顯示 */
  } else if (!editable) {
    const c = it.choices.find((x) => x.id === it.choice);
    pick = [h('p', { class: 'picked' }, '你的決定：', h('b', null, c?.label ?? it.choice), c && c.id !== 'SKIP' && !multiLines ? `（${c.text}）` : ''), it.reason ? h('p', { class: 'small dim' }, '你寫的理由：', it.reason) : null];
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
              syncReason(c.id);
              ui.choose(it.key, c.id);
            },
          }),
          h('span', { class: 'lab' }, c.label, c.isDefault && it.choices.length > 1 ? h('span', { class: 'dflt' }, '沒選就是這個') : null),
          h('span', { class: 'what' }, c.text),
          c.note ? h('span', { class: 'note' }, c.note) : null,
        ),
      ),
    );
    // 甲類的「這次不做」、當天乙類的「不同意，不動」、慢規則減半的「這次不做」：要寫一句理由（own_thesis §1.10、§3.4），選了才出現。
    // 月報裡的乙類：理由可以不寫，不寫記成「月報裡沒有動它」；兩種都會讓這條前提進靜默期（T30）
    let reasonBox = null;
    const rule = it.kind === 'OWN_RULE';
    const optional = !it.reasonRequired && it.discuss && !rule;
    if (it.reasonRequired || optional) {
      const skipIt = it.choices.find((c) => c.id === 'SKIP')?.label === '這次不做';
      const ta = h('textarea', { rows: 2, maxlength: 200, 'aria-label': '一句理由', placeholder: rule ? '為什麼這次不照規則減半（1～200 字）' : skipIt ? '為什麼這次不照當時的決定做（1～200 字）' : '為什麼不同意（1～200 字）' });
      ta.value = ui.reasons?.[it.key] ?? '';
      ta.addEventListener('input', () => {
        if (ui.reasons) ui.reasons[it.key] = ta.value;
      });
      const hint = rule
        ? it.drop === 'EXIT'
          ? '下一次審查會看到這句話。規則的狀態照樣記成已經減半。沒有照 AI 出清：那條前提會進靜默期，到下一季財報出來（最長 100 天）不再為它通知你。'
          : '下一次審查會看到這句話。規則的狀態照樣記成已經減半。'
        : it.discuss
          ? optional
            ? '下一次審查會看到這句話。不寫的話記成「月報裡沒有動它」。不管寫不寫，這條前提都會進靜默期：到下一季財報出來（最長 100 天）不再為它通知你。'
            : '下一次審查會看到這句話。這條前提會進靜默期：到下一季財報出來（最長 100 天）不再為它通知你。'
          : '下一次審查會看到這句話。';
      reasonBox = h('label', { class: 'field', style: 'margin-top:10px' }, h('span', null, skipIt ? '這次不做的理由（必填）' : optional ? '不同意的理由（可以不寫）' : '不同意的理由（必填）'), ta, h('small', null, hint));
    }
    function syncReason(id) {
      if (reasonBox) reasonBox.hidden = id !== 'SKIP';
    }
    syncReason(ui.choices[it.key]);
    // 乙類：拿去討論（複製 BREAK 討論包；通知留在「等你決定」）
    const discuss = it.discuss && it.ticker
      ? h('div', { class: 'extra' }, h('div', { class: 'btn-row' }, copyPackButton(it.ticker, v.id, '拿去討論')), h('p', { class: 'small dim', style: 'margin-top:6px' }, rule ? '把討論包貼到 claude.ai 討論 AI 判不成立的那條前提。這則通知會留在「等你決定」；改完論點之後，仍然要回來這裡選一項。' : '把討論包貼到 claude.ai 討論。這則通知會留在「等你決定」；改了論點，回來在「編輯論點」頁貼回、勾「這是對這則通知的回應」。'))
      : null;
    const formBox = h('div');
    const extra = it.actions.length
      ? h(
          'div',
          { class: 'extra' },
          it.actions.map((a) =>
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
                  formBox.replaceChildren(h('div', { class: 'act-form' }, h('p', { class: 'small dim', style: 'margin-bottom:10px' }, a.hint), h('label', { class: 'field' }, h('span', null, a.reasonLabel), ta), msg, h('div', { class: 'btn-row' }, ok, h('button', { class: 'btn quiet', type: 'button', onclick: () => formBox.replaceChildren() }, '取消'))));
                  ta.focus();
                },
              },
              a.label,
            ),
          ),
        )
      : null;
    pick = [picks, reasonBox, discuss, extra, formBox];
  }
  const sum = h(
    'summary',
    { class: 'slip-sum' },
    h('div', { class: 'slip-what' }, h('div', { class: 'slip-meta' }, bucketTag(it.bucket, it.bucketName), h('span', null, it.label)), headline(it.headline)),
    h('div', { class: 'slip-because' }, h('div', { class: 'why-h' }, '為什麼'), h('p', { class: 'why-short' }, it.explain.short)),
    h('div', { class: 'slip-state' }, showChip ? chip : null, chevron()),
  );
  const k = `${v.id}:${it.key}`;
  const left = act.length || pick ? h('div', { class: 'slip-left' }, act, pick) : null;
  const el = h('details', { class: 'slip glass' + (it.cancelled ? ' off' : ''), 'data-b': it.bucket === 'mixed' ? null : it.bucket, open: slipOpen.has(k) ? slipOpen.get(k) : !!ui.openAll }, sum, h('div', { class: 'slip-grid' }, left ?? h('div'), whyBlock(it.explain, it.ticker, it.meter)));
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

const orderN = (c) => c.orders.filter((o) => !o.transfer).length;

/** 主控台的中間：要下的單＋做完的現金。 */
export function trayBody(c, opt = {}) {
  return [
    c.orders.length ? h('table', { class: 'orders' }, h('tbody', null, orderRows(c, opt))) : h('p', { class: 'con-empty' }, '照目前的選擇，不用下任何單。'),
    h(
      'p',
      { class: 'cash' },
      h('span', null, '做完之後現金約', c.withdraw ? `（已扣掉要轉出的 ${money(c.withdraw)}）` : ''),
      h('b', { class: c.cashAfter < -1 ? 'neg num' : 'num' }, money(c.cashAfter)),
      c.shortOfCash ? h('span', { class: 'err' }, '現金不夠：買單的金額超過現金加賣單。要先補錢，或把某一張買單改成這次不做。') : null,
      c.capNote ? h('span', { class: 'err' }, c.capNote) : null,
    ),
  ];
}
export const trayTitle = (c, prefix = '合起來要下') => [prefix, ' ', h('span', { class: 'n' }, String(orderN(c))), ' 張單'];

/** 照建議做完的一句話（試算、下單那一步用）。 */
export function planBubble(c, k = '照這樣做的話') {
  const n = orderN(c);
  const side = (s) => c.orders.filter((o) => !o.transfer && Math.sign(o.shares) === s);
  const list = (s) => {
    const xs = side(s);
    if (!xs.length) return '';
    return xs.length > 3 ? `${s < 0 ? '賣' : '買'} ${xs.length} 檔` : `${s < 0 ? '賣' : '買'} ${xs.map((o) => `${o.ticker} ${qty(o.shares)} 股`).join('、')}`;
  };
  const what = [list(-1), list(1)].filter(Boolean).join('，');
  return { k, say: [n ? what : em('不用下任何單'), n ? '，共 ' : '', n ? em(`${n} 張單`) : '', '，做完現金約 ', c.cashAfter < -1 ? neg(money(c.cashAfter)) : em(money(c.cashAfter)), c.cashAfter < -1 ? '（會是負的）' : '', '。'], mood: c.cashAfter < -1 ? 'worry' : 'watch' };
}

function notifBanner(v, extra = {}) {
  return {
    back: { href: '#/', label: '待辦與紀錄' },
    title: actionText(v.title),
    sub: [`${v.kindLabel}，用 ${day(v.date)}的收盤價算的。`, h('span', { class: 'chip' + (v.status === 'PENDING' || v.status === 'RESPONDED' ? ' now' : '') }, v.status === 'PENDING' || v.status === 'RESPONDED' ? h('i', { class: 'led' }) : null, v.statusLabel)],
    ...extra,
  };
}

/** 月報的「要看的事」（own_thesis §3.6.6）：不用下單、不用回覆；分自選股與動能持股兩段。 */
function attentionBox(v) {
  if (!v.attention?.length) return null;
  return h(
    'div',
    { class: 'glass pad', style: 'margin-top:16px' },
    h('h2', { class: 'panel-h' }, `持股有 ${v.attention.length} 件事要看（不用下單）`),
    h('p', { class: 'small dim' }, '這些不是清單上的單，也不用回覆。點一行到那一檔的持股頁看。'),
    attentionList(v.attention, { groups: true }),
  );
}

export async function notifPage(ctx, id) {
  const v = await api.get(`/notif/${id}`);
  const st = ctx.state;

  // ---- 問答型：清單外的變動、現金差額
  if (v.ask && v.status === 'PENDING') {
    return page({ view: 'page', banner: notifBanner(v, { bubble: { k: '要你回答', say: [em(v.title), '。回答之前，月報會先暫停。'], mood: 'alert' } }), pane: h('div', { class: 'narrow' }, askForm(v, ctx)), rail: tiles(st) });
  }
  // ---- 沒有清單的通知
  if (!v.items.length) {
    const body = glass(
      'pad narrow',
      v.text ? h('p', null, v.text) : null,
      v.note ? h('p', { class: 'dim' }, '你的回答：' + ({ own: '歸自選', mom: '歸動能' }[v.note] ?? v.note)) : null,
      v.ref ? h('p', { style: 'margin-top:8px' }, h('a', { href: `#/n/${v.ref}` }, `打開通知 #${v.ref}`)) : null,
      v.status === 'PENDING'
        ? h(
            'div',
            { class: 'btn-row', style: 'margin-top:14px' },
            actionButton('知道了', 'primary', async () => {
              await api.post(`/notif/${v.id}/respond`, { mode: 'DO' });
              ctx.go('#/');
            }),
          )
        : null,
    );
    return page({ view: 'page', banner: notifBanner(v, { bubble: { k: v.status === 'PENDING' ? '提醒' : '當時', say: [v.text ?? v.title], mood: v.status === 'PENDING' ? 'alert' : 'watch' } }), pane: [body, attentionBox(v)], rail: tiles(st) });
  }

  const backToDecide = reopenAndGo(ctx, v.id);
  const reminded = v.reminded && v.status === 'PENDING' ? h('p', { class: 'notice', style: 'margin:0 0 16px' }, '這則通知已經超過 2 個交易日。現在回覆的話，自選慢規則的單會用最新的收盤價重算；如果這段時間規則狀態已經反轉，那一項會取消。') : null;

  if (v.step === 1) {
    // ---------- 第一步：每張建議單左邊是做什麼、右邊是為什麼；右邊的主控台隨時顯示合起來要下的單
    const choices = Object.fromEntries(v.items.map((it) => [it.key, it.choice]));
    const reasons = {};
    let composed = v.composed;
    const trayBox = h('div', { style: 'display:contents' });
    const sumBox = h('div', { class: 'sum' });
    const msg = h('div');
    const submit = async (mode) => {
      // 要寫理由的項目選了不做卻沒寫：先在這裡擋下，打開那一張單（伺服器也會再檢查）
      const miss = v.items.filter((it) => !it.cancelled && it.reasonRequired && (mode === 'SKIP' || choices[it.key] === 'SKIP') && !(reasons[it.key] ?? '').trim());
      if (miss.length) {
        msg.replaceChildren(errBox({ message: mode === 'SKIP' ? `${miss.map((it) => it.ticker ?? it.headline).join('、')} 這次不做要寫一句理由：先在那一項選「這次不做」（或「不同意，不動」）、寫下理由，再按一次。` : `${miss.map((it) => it.ticker ?? it.headline).join('、')} 選了不做，要寫一句理由。` }));
        if (mode === 'SKIP') return msg.scrollIntoView({ block: 'center' });
        const el = [...document.querySelectorAll('details.slip')][v.items.indexOf(miss[0])];
        if (el) {
          el.open = true;
          el.querySelector('textarea')?.focus();
        }
        return;
      }
      try {
        const r = await api.post(`/notif/${v.id}/respond`, { mode, choices, reasons });
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
      const foot = [actionButton('決定好了，看下單清單', 'primary block', () => submit('DO')), skippable ? h('div', { class: 'linkrow' }, linkButton('整則這次不做', () => submit('SKIP'))) : null, v.cancel ? h('div', { class: 'linkrow' }, cancelButton(ctx, v)) : null, h('p', { class: 'small faint', style: 'text-align:center' }, '按下去只是記下你的決定，系統不會替你下單。')];
      trayBox.replaceChildren(consoleBox(trayTitle(composed), trayBody(composed, { prev }), foot));
      sumBox.textContent = `${orderN(composed)} 張單，做完現金約 ${money(composed.cashAfter)}`;
    };
    const ui = {
      editable: true,
      choices,
      reasons,
      async choose(key, c) {
        const from = choices[key];
        choices[key] = c;
        try {
          const prev = composed;
          const r = await api.post(`/notif/${v.id}/preview`, { choices, changed: { key, from } });
          const { effect, ...next } = r;
          composed = next;
          drawTray(prev);
          msg.replaceChildren();
          // 史萊姆只講剛剛改的那一個選項造成的結果
          if (effect) say(effect, effect.mood === 'happy' ? 'hop' : 'jiggle');
        } catch (e) {
          msg.replaceChildren(errBox(e));
        }
      },
      afterAction: (nid) => (nid && nid !== v.id ? ctx.go(`#/n/${nid}`) : ctx.refresh()),
    };
    drawTray(null);
    return page({
      view: 'flow',
      banner: notifBanner(v, {
        steps: stepBar(1),
        bubble: { k: '改決定的時候', say: ['點任何一個選項，我會馬上告訴你', em('那樣做的結果'), '。按下去只是記下決定，我不會替你下單。'], mood: 'watch' },
      }),
      pane: [reminded, v.text ? h('p', { class: 'dim', style: 'margin-bottom:12px;white-space:pre-line' }, v.text) : null, slips(v, ui, `${live.length} 項建議，點開看完整的理由、改決定。沒改的就照每一張右上角寫的做。`), msg, attentionBox(v)],
      rail: trayBox,
      cta: h('div', { class: 'sticky-cta' }, sumBox, actionButton('決定好了', 'primary', () => submit('DO'))),
    });
  }

  if (v.step === 2) {
    // ---------- 第二步：拿著這張清單去券商下單
    const c = v.composed;
    const text = c.orders.filter((o) => !o.transfer).map((o) => `${o.shares < 0 ? '賣' : '買'} ${o.ticker} ${qty(o.shares)} 股`).join('\n');
    const copy = linkButton('複製清單', async () => {
      try {
        await navigator.clipboard.writeText(text);
        toast('已複製');
      } catch {
        toast('複製失敗，請手動選取');
      }
    });
    const n = orderN(c);
    return page({
      view: 'flow',
      banner: notifBanner(v, {
        steps: stepBar(2, v.cancel ? {} : { 1: { label: '回去改決定', go: backToDecide } }),
        bubble: { k: '下單的時候', say: ['到券商下這 ', em(`${n} 張單`), '（開盤市價單、整股）', v.withdraw ? `，做完從券商轉出 ${money(v.withdraw)}` : '', '，下完回來填快照。'], mood: 'alert' },
      }),
      pane: [
        glass(
          'pad',
          h('p', null, '下單方式：開盤市價單、整股。股數是用 ', h('span', { class: 'num' }, day(v.date)), '的收盤價換算的。'),
          v.withdraw ? h('p', { style: 'margin-top:6px' }, '清單做完後，從券商轉出 ', h('b', { class: 'num' }, money(v.withdraw)), '，再回來填快照。') : null,
          h('p', { class: 'dim', style: 'margin-top:6px' }, '沒有全部做完也沒關係：照實填快照，系統會問你要補做還是就這樣。右邊每下完一張可以打勾，只是幫你記，不會存。'),
        ),
        h('h2', { class: 'sec' }, '你的決定與理由'),
        slips(v, { editable: false }),
        attentionBox(v),
      ],
      rail: consoleBox(trayTitle(c, '到券商下這'), trayBody(c, { check: true }), [h('a', { class: 'btn primary block', href: '#/snapshot' }, '下完單了，填快照'), h('div', { class: 'linkrow' }, v.cancel ? cancelButton(ctx, v) : linkButton('上一步：改決定', backToDecide), copy)]),
      cta: h('div', { class: 'sticky-cta' }, h('div', { class: 'sum' }, v.cancel ? cancelButton(ctx, v) : linkButton('上一步', backToDecide)), h('a', { class: 'btn primary', href: '#/snapshot' }, '下完單了，填快照')),
    });
  }

  // ---------- 已結束：留著理由給之後回頭看
  const body = [];
  let bubble = { k: '當時', say: [v.statusLabel, '。'], mood: 'watch' };
  if (v.status === 'DONE') bubble = { k: '當時', say: ['這份清單', em('已經完成'), v.filled.length ? `，${v.filled.length} 筆成交照快照記進帳本了。` : '。'], mood: 'happy' };
  if (v.status === 'DONE' && v.items.length && v.items.every((i) => i.revised)) bubble = { k: '當時', say: ['你用', em('修正論點'), '回應了這則通知，部位不動。'], mood: 'watch' };
  if (v.status === 'SKIPPED') bubble = { k: '當時', say: ['這次', em('整則沒做'), '。差異記在「沒照規則做的」紀錄裡。'], mood: 'watch' };
  if (v.status === 'SUPERSEDED') bubble = { k: '當時', say: ['這份清單被', em('重算過的新清單'), '取代了，以新的為準。'], mood: 'watch' };
  if (v.status === 'CANCELLED') bubble = { k: '當時', say: ['這份清單', em('取消了'), v.withdraw ? '，出金沒有記帳。' : '。'], mood: 'watch' };
  if (v.followUp) {
    bubble = { k: '要你回答', say: ['快照和清單', neg('對不上'), `（${v.followUp.length} 檔）。要補做差額，還是就這樣？`], mood: 'worry' };
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
    body.push(
      glass(
        'pad',
        h('h2', { class: 'panel-h' }, '快照和清單不同'),
        h('ul', { class: 'sum-list' }, v.followUp.map((x) => h('li', null, h('span', { class: 'tk' }, x.ticker), h('span', null, `清單${x.listed < 0 ? '賣' : '買'} ${qty(x.listed)} 股，快照顯示${x.done === 0 ? '沒有變動' : `${x.done < 0 ? '賣了' : '買了'} ${qty(x.done)} 股`}`)))),
        h('p', { class: 'dim small', style: 'margin:10px 0 14px' }, '補做：給你一份差額的清單。就這樣：不再提醒，差額記在紀錄裡（動能的單下個月月報仍會再列）。'),
        msg,
        h('div', { class: 'btn-row' }, actionButton('補做差額', 'primary', answer(true)), actionButton('就這樣', '', answer(false))),
      ),
    );
  }
  if (v.status === 'SUPERSEDED') body.push(h('p', { class: 'notice', style: 'margin:0 0 14px' }, '這份清單已經被重算過的新清單取代（排除某一檔，或月報日登記了入金）。以新的那一份為準。'));
  if (v.filled.length) {
    body.push(
      h('h2', { class: 'sec' }, '實際成交（照快照記進帳本）'),
      glass('pad', h('table', { class: 'orders' }, h('tbody', null, v.filled.map((f) => h('tr', null, h('td', { class: 'sd' }, h('span', { class: 'side ' + (f.shares < 0 ? 'sell' : 'buy') }, f.shares < 0 ? '賣' : '買')), h('td', null, h('span', { class: 'tk' }, f.ticker), ' ', h('span', { class: 'small faint' }, f.bucketName)), h('td', { class: 'q' }, qty(f.shares), h('small', null, '股'))))))),
    );
  }
  body.push(h('h2', { class: 'sec' }, v.status === 'SKIPPED' ? '當時的建議與理由（這次沒做）' : '當時的建議、你的決定與理由'), slips(v, { editable: false }), attentionBox(v));
  return page({
    view: 'page',
    banner: notifBanner(v, { bubble }),
    pane: body,
    rail: v.composed ? consoleBox(trayTitle(v.composed, '當時合起來要下'), trayBody(v.composed), null, '當時的單') : tiles(st),
  });
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
    return glass(
      'pad',
      h('p', null, '扣掉清單的成交金額之後，現金比預期', amt > 0 ? '多' : '少', '了 ', h('b', { class: 'num' }, money(Math.abs(amt), 2)), '。這筆是什麼？'),
      h('p', { class: 'small dim', style: 'margin:6px 0 14px' }, '入金與出金不算報酬（各桶的單位淨值不受影響）；股利與其他算報酬。'),
      msg,
      h('div', { class: 'btn-row' }, kinds.map((k) => actionButton(k, k === kinds[0] ? 'primary' : '', () => pick(k)))),
    );
  }
  const { ticker, quantity, canMom, canOwn, canRemoveOwn, note } = v.ask;
  const reason = h('textarea', { rows: 2 });
  if (note) reason.value = note;
  // 自選賣到 0 股：預設同時移出自選（不然之後加回或入金會把它買回來）
  const remove = canRemoveOwn ? h('input', { type: 'checkbox', checked: true }) : null;
  const send = (bucket) => async () => {
    try {
      const removeOwn = bucket === 'own' && !!remove?.checked;
      const r = await api.post(`/notif/${v.id}/classify`, { bucket, reason: reason.value, removeOwn });
      toast(removeOwn ? `已從自選扣掉，${ticker} 移出自選` : `已歸到${bucket === 'own' ? '自選' : '動能'}`);
      ctx.go(r.notifId ? `#/n/${r.notifId}` : '#/');
    } catch (e) {
      msg.replaceChildren(errBox(e));
    }
  };
  return glass(
    'pad',
    h('p', null, '快照裡 ', h('span', { class: 'tk' }, ticker), quantity > 0 ? ' 多了 ' : ' 少了 ', h('b', { class: 'num' }, qty(quantity)), ' 股，不在任何清單上。這筆要記在哪一桶？'),
    h('p', { class: 'small dim', style: 'margin:6px 0 14px' }, quantity > 0 ? '清單以外自己買的股票歸自選，之後由自選的慢規則管。只有它在這個月的動能名單上、而且那一格還沒買足時，才能歸動能。' : '賣出的部分從持有它的那一桶扣。', '回答之前，月報會暫停。'),
    quantity > 0
      ? h('label', { class: 'field' }, h('span', null, '為什麼買（選填，會成為這檔的前提）'), reason, h('small', null, '沒寫就用系統預設的前提。'))
      : h('label', { class: 'field' }, h('span', null, '為什麼賣（選填）'), reason, h('small', null, '記在帳本與「沒照規則做的」紀錄上，之後回頭看這次自己的判斷。')),
    remove
      ? h('label', { class: 'check-row' }, remove, h('span', null, '自選的 ', h('span', { class: 'tk' }, ticker), ' 全部賣掉了：同時移出自選（之後不再追蹤，也不會被加回或入金買回來）'))
      : null,
    msg,
    h('div', { class: 'btn-row' }, canOwn ? actionButton(quantity > 0 ? '歸自選' : '從自選扣', 'primary', send('own')) : null, canMom ? actionButton(quantity > 0 ? '歸動能' : '從動能扣', canOwn ? '' : 'primary', send('mom')) : null),
  );
}

// ---------------------------------------------------------------- 填快照

export async function snapshotPage(ctx) {
  const f = await api.get('/snapshot/form');
  const only = f.lists.length === 1 ? f.lists[0] : null;
  const NAMES = { own: '自選', mom: '動能', core: '核心' };
  const HINT = {
    own: '你自己選的股票。清單以外自己買的放這裡（新代號會加進自選、可以寫為什麼買）；股數改成 0 就移出自選。',
    mom: '照動能清單買的。清單以外的買進，只有那檔在這個月的動能名單上、那一格還沒買足時才能放這裡。',
    core: `${f.coreTickers.join('、')} 和現金。現金照券商畫面填就好，不用算成交價；和估計的差額會記成其他現金變動，不會問你。入金、出金請用「我要…」登記。`,
  };
  /** 每一列：{ bucket, ticker(), input, expected, why? } */
  const rows = [];
  const parse = (el) => {
    const t = el.value.replace(/[,\s$]/g, '');
    return t === '' ? NaN : Number(t);
  };
  const cash = h('input', { class: 'num-in', type: 'text', inputmode: 'decimal', placeholder: `約 ${Math.round(f.cashExpected).toLocaleString('en-US')}`, 'aria-label': '券商顯示的現金' });
  const note = h('input', { type: 'text', maxlength: 300, placeholder: '例如：財報不如預期，先賣掉一半', 'aria-label': '這次自己交易的原因' });
  const summary = h('ul', { class: 'sum-list' });
  let lastSaid = '';
  const recount = () => {
    const off = [];
    for (const r of rows) {
      const t = r.ticker();
      const q = parse(r.input);
      if (!t && !(q > 0)) continue;
      if (!Number.isFinite(q)) off.push(`${NAMES[r.bucket]} ${t || '新代號'} 要填數字`);
      else if (Math.abs(q - r.expected) > 1e-9) off.push(`${NAMES[r.bucket]} ${t || '新代號'} ${q - r.expected > 0 ? '+' : '−'}${qty(q - r.expected)} 股`);
    }
    const c = parse(cash);
    put(
      summary,
      f.lists.length ? h('li', null, h('span', null, '等成交的清單'), h('span', null, f.lists.map((l) => l.title).join('、'))) : null,
      h('li', null, h('span', null, '和清單不同'), h('span', { class: off.length ? 'num' : 'num faint' }, off.length ? `${off.length} 處` : '沒有')),
      h('li', null, h('span', null, '現金'), h('span', { class: 'num' }, Number.isFinite(c) ? money(c, 2) : '還沒填')),
    );
    const b = off.length
      ? { k: '和清單不同的地方', say: [em(off.slice(0, 3).join('、')), off.length > 3 ? ` 等 ${off.length} 處` : '', '。照你填的桶記帳；可以在下面寫一句原因。'], mood: 'watch' }
      : { k: '填快照', say: [f.lists.length ? '股數都和「清單做完」一樣。' : '股數和帳本一樣。', Number.isFinite(c) ? '送出就完成。' : '最後填上券商顯示的現金。'], mood: f.lists.length ? 'happy' : 'watch' };
    const key = JSON.stringify(b.say);
    if (key !== lastSaid) {
      if (lastSaid) say(b);
      lastSaid = key;
    }
    return b;
  };
  const tbodies = { own: h('tbody'), mom: h('tbody'), core: h('tbody') };
  const addRow = (bucket, r, isNew = false) => {
    const input = h('input', { class: 'num-in', type: 'text', inputmode: 'decimal', value: String(r.expected), 'aria-label': `${NAMES[bucket]} ${r.ticker || '新代號'} 的股數` });
    const tkIn = isNew ? h('input', { type: 'text', placeholder: '代號', value: r.ticker || '', style: 'width:6.5em;text-transform:uppercase', 'aria-label': '股票代號' }) : null;
    const why = isNew && bucket === 'own' ? h('input', { type: 'text', maxlength: 300, placeholder: '為什麼買（選填，會成為這檔的前提）', style: 'width:100%', 'aria-label': '為什麼買' }) : null;
    const delta = h('span', { class: 'delta' });
    const tr = h(
      'tr',
      null,
      h('td', null, isNew ? tkIn : h('span', { class: 'tk' }, r.ticker), isNew ? h('div', { class: 'small faint' }, bucket === 'own' ? '新加進自選' : '清單外買進') : null),
      h('td', { class: 'r num wide' }, isNew ? '—' : qty(r.book)),
      h('td', { class: 'r num wide' }, r.listed ? (r.listed > 0 ? '+' : '−') + qty(r.listed) : ''),
      h('td', { class: 'r' }, input),
      h('td', null, delta),
    );
    const row = { bucket, ticker: () => (isNew ? tkIn.value.trim().toUpperCase() : r.ticker), input, expected: isNew ? 0 : r.expected, why };
    const upd = () => {
      const v = parse(input);
      const d = v - row.expected;
      const off = Number.isFinite(v) && Math.abs(d) > 1e-9;
      tr.classList.toggle('diff', off || !Number.isFinite(v));
      delta.textContent = !Number.isFinite(v) ? '要填數字' : off ? `${d > 0 ? '+' : '−'}${qty(d)}${bucket === 'own' && !isNew && v === 0 ? '（移出自選）' : ''}` : '';
      recount();
    };
    input.addEventListener('input', upd);
    tkIn?.addEventListener('input', recount);
    rows.push(row);
    tbodies[bucket].append(tr);
    // 新加進自選的「為什麼買」放在下一列，橫跨整張表（手機上代號那一欄太窄）
    if (why) tbodies[bucket].append(h('tr', { class: 'why-row' }, h('td', { colspan: 5, style: 'padding-top:0' }, why)));
    if (isNew && !r.ticker) tkIn.focus();
    if (isNew) upd();
  };
  for (const b of ['own', 'mom', 'core']) f.buckets[b].forEach((r) => addRow(b, r));
  for (const t of f.coreTickers) if (!f.buckets.core.some((r) => r.ticker === t)) addRow('core', { ticker: t, book: 0, listed: 0, expected: 0 });
  const cashDelta = Math.round((f.cashExpected - f.cashBook) * 100) / 100;
  // 出金：券商的現金可能要等錢轉出才扣（設計 §10 第 40 點）
  const wdAmount = Math.round((f.withdraw + f.pendingWithdraw) * 100) / 100;
  const wdPending = wdAmount ? h('input', { type: 'checkbox', checked: f.pendingWithdraw > 0 && !f.withdraw }) : null;
  tbodies.core.append(
    h(
      'tr',
      { class: 'cash-row' },
      h('td', null, h('span', { class: 'tk' }, '現金'), wdAmount ? h('div', { class: 'small faint' }, `照券商現在顯示的填；出金 ${money(wdAmount)} 還沒扣的話勾下面`) : null),
      h('td', { class: 'r num wide' }, money(f.cashBook, 2)),
      h('td', { class: 'r num wide' }, cashDelta ? `約 ${cashDelta > 0 ? '+' : '−'}${money(Math.abs(cashDelta))}` : ''),
      h('td', { class: 'r' }, cash),
      h('td', null),
    ),
  );
  // 改版前留下的未分類持股：先放進自選那一桶，你可以改放動能
  for (const u of f.unc) addRow('own', { ticker: u.ticker, book: 0, listed: 0, expected: u.shares }, true);
  cash.addEventListener('input', recount);

  const fill = f.autofill
    ? h(
        'button',
        {
          class: 'btn',
          type: 'button',
          onclick: () => {
            for (const r of rows) {
              r.input.value = String(r.expected);
              r.input.dispatchEvent(new Event('input'));
            }
            cash.value = String(f.autofill.cash);
            recount();
            toast('已填入「照清單、以開盤價成交」後的數字');
          },
        },
        '示範：幫我填成交後的數字',
      )
    : null;
  // 和帳戶頁一樣：每一桶有自己的記號與顏色
  const wdRow = wdPending
    ? h('label', { class: 'check-row', style: 'margin:0;padding:12px 20px' }, wdPending, h('span', { class: 'small' }, `出金 ${money(wdAmount)} 還沒從券商轉出（券商的現金還沒扣掉）。勾了系統會先扣掉這筆再對帳，下次填快照再問一次。`))
    : null;
  const section = (b) =>
    h(
      'section',
      { class: 'snap-group', 'data-b': b },
      h('h2', { class: 'group-name', 'data-b': b }, h('i', { class: 'g' }), NAMES[b]),
      h('p', { class: 'small group-who' }, HINT[b]),
      glass(
      '',
      h('div', { class: 'scroll-x' }, h('table', { class: 'snap' }, h('thead', null, h('tr', null, h('th', null, '代號'), h('th', { class: 'r wide' }, '帳本'), h('th', { class: 'r wide' }, '清單'), h('th', { class: 'r' }, b === 'core' ? '券商現在的股數／現金' : '券商現在的股數'), h('th', null, ''))), tbodies[b])),
      b === 'core' ? [wdRow, fill ? h('div', { class: 'pad btn-row' }, fill) : null] : h('div', { class: 'pad btn-row' }, h('button', { class: 'btn', type: 'button', onclick: () => addRow(b, { ticker: '', book: 0, listed: 0, expected: 0 }, true) }, b === 'own' ? '加一檔到自選' : '加一檔到動能')),
      ),
    );

  const msg = h('div');
  const out = h('div');
  const foot = h('div', { style: 'display:contents' });
  const send = actionButton('送出快照', 'primary block', async () => {
    const lots = { own: {}, mom: {}, core: {} };
    const why = {};
    for (const r of rows) {
      const t = r.ticker();
      const q = parse(r.input);
      if (!t && !(q > 0)) continue;
      if (!t) return msg.replaceChildren(errBox(new Error(`${NAMES[r.bucket]}有一列沒填代號`)));
      if (!Number.isFinite(q) || q < 0) return msg.replaceChildren(errBox(new Error(`${NAMES[r.bucket]} ${t} 的股數要填 0 以上的數字`)));
      lots[r.bucket][t] = (lots[r.bucket][t] ?? 0) + q;
      if (r.why?.value.trim()) why[t] = r.why.value.trim();
    }
    const c = parse(cash);
    if (!Number.isFinite(c)) {
      cash.focus();
      return msg.replaceChildren(errBox(new Error('請填券商現在顯示的現金（可用資金）。')));
    }
    try {
      const r = await api.post('/snapshot', { lots, cash: c, note: note.value, why, withdrawPending: !!wdPending?.checked });
      msg.replaceChildren();
      // 「為什麼買」只存成一條前提，不送去改寫（出場條件在持股頁的「編輯論點」寫；own_thesis §1.8）
      await ctx.refresh(false);
      form.hidden = true;
      // 帳本已經照快照更新，不能再回上一步
      const stepsEl = document.querySelector('.banner .steps');
      if (stepsEl) stepsEl.replaceWith(stepBar(4));
      const more = r.followUps.length + r.created.length;
      foot.replaceChildren(h('a', { class: 'btn primary block', href: r.monthlyId ? `#/n/${r.monthlyId}` : '#/' }, more ? '去回答' : r.monthlyId ? '看重算的月報' : '回待辦'), h('div', { class: 'linkrow' }, h('a', { class: 'linkbtn', href: '#/account' }, '看帳戶')));
      say(more ? { k: '快照收到了', say: ['帳本更新了，', neg(`還有 ${more} 件事要你回答`), '。'], mood: 'alert' } : { k: '快照收到了', say: [em('帳本已更新'), r.completed.length ? `，${r.completed.length} 份清單完成。` : '，這份快照是新的起點。'], mood: 'happy' }, 'hop');
      out.replaceChildren(
        glass(
          'pad',
          h('h2', { class: 'panel-h' }, more ? '快照收到了，還有事要你回答' : '快照收到了，帳本已更新'),
          r.completed.length ? h('p', null, `完成了 ${r.completed.length} 份清單，成交照你填的桶記帳。`) : h('p', null, '沒有等成交的清單；這份快照成為新的起點。'),
          r.followUps.length ? h('p', null, `有 ${r.followUps.length} 份清單和快照差超過 1 股，要你選補做還是就這樣。`) : null,
          r.removedOwn.length ? h('p', null, `${r.removedOwn.join('、')} 賣光了，已移出自選（之後不再追蹤，也不會被買回）。`) : null,
          r.cashOther ? h('p', { class: 'small dim' }, `現金和估計的成交金額差 ${r.cashOther > 0 ? '+' : '−'}${money(Math.abs(r.cashOther), 2)}，記成其他現金變動（成交價、手續費、股利）。`) : null,
          r.created.map((n) => h('p', null, n.title)),
          r.cashWarn ? null : h('p', { class: 'small faint' }, '填錯了可以到「我要…」→「復原上一份快照」，回到送出之前再重填。'),
        ),
        ...(r.cashWarn ? [cashWarnBox(ctx, r.cashOther, null)] : []),
      );
    } catch (e) {
      msg.replaceChildren(errBox(e));
    }
  });
  const form = h(
    'div',
    { class: 'stackv' },
    f.lists.length
      ? h('p', null, '等成交的清單：', f.lists.map((l, k) => [k ? '、' : '', h('a', { href: `#/n/${l.id}` }, l.title)]), '。每一桶的股數先幫你填好「照清單做完」的數字，和券商不一樣的地方直接改。')
      : h('p', null, '現在沒有等成交的清單。自己交易過、或只是想對帳，都可以填：把和券商不一樣的地方改掉，變動放在哪一桶由你決定。'),
    f.unc.length ? h('p', { class: 'small', style: 'color:var(--warn)' }, `改版前有還沒分類的持股（${f.unc.map((u) => `${u.ticker} ${qty(u.shares)} 股`).join('、')}），先放在自選那一桶；要放動能就把它移過去。`) : null,
    section('own'),
    section('mom'),
    section('core'),
    msg,
    f.lists.length ? h('p', { class: 'small faint' }, '送出之前都可以回上一步。送出之後帳本就照這份快照更新；填錯了再填一次快照就好。') : null,
  );
  foot.append(send, h('div', { class: 'linkrow' }, f.lists.length ? h('a', { class: 'linkbtn', href: only ? `#/n/${only.id}` : '#/' }, '上一步：回下單清單') : null, h('a', { class: 'linkbtn', href: '#/' }, '先不填')));
  const pickOne = { label: '回待辦挑一份清單', href: '#/' };
  const steps = f.lists.length ? stepBar(3, only ? { 1: { label: '回去改決定', go: reopenAndGo(ctx, only.id) }, 2: { label: '回去看下單清單', href: `#/n/${only.id}` } } : { 1: pickOne, 2: pickOne }) : null;
  const first = recount();
  return page({
    view: 'flow',
    banner: { back: { href: '#/', label: '待辦與紀錄' }, title: '填快照', sub: '照券商現在的畫面，填每一桶每一檔的股數和現金。這份快照就是帳本新的起點。', steps, bubble: first },
    pane: [form, out],
    rail: consoleBox('送出快照', h('div', null, summary, h('label', { class: 'field', style: 'margin:16px 0 0' }, h('span', null, '這次自己交易的原因（選填）'), note, h('small', null, '有清單以外的買賣時寫一句，記在帳本那幾筆變動上。'))), foot, '快照'),
    cta: h('div', { class: 'sticky-cta' }, h('div', { class: 'sum' }, '填好股數與現金'), h('button', { class: 'btn primary', type: 'button', onclick: () => send.click() }, '送出快照')),
  });
}

export { errBox, getMode };
