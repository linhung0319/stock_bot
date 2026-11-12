// 主程式：路由（網址的 # 後面）、上方導覽、示範列、錯誤處理。
// 每次換頁都先拿一次最新的狀態（待辦、帳戶摘要），頁面再各自拿自己要的資料。
import { ApiError, api, getMode, setMode } from './api.js';
import { day, h, toast } from './dom.js';
import { accountPage, addOwnPage, authPage, depositPage, doMenu, historyPage, holdingPage, ratioPage, removePage, setupPage, withdrawPage } from './pages-more.js';
import { homePage, notifPage, snapshotPage } from './pages-notif.js';

const main = document.getElementById('main');
const modeBtn = document.getElementById('modeBtn');
const demoBar = document.getElementById('demoBar');
const notices = document.getElementById('notices');
const badge = document.getElementById('navBadge');

const ctx = {
  state: null,
  go(hash) {
    if (location.hash === hash) render();
    else location.hash = hash;
  },
  /** 重新拿狀態；rerender = false 時只更新上方（待辦數、示範列），不重畫頁面。 */
  async refresh(rerender = true) {
    if (rerender) return render();
    await loadState();
  },
  setMode(m) {
    setMode(m);
    ctx.go('#/');
  },
};

const ROUTES = [
  [/^#?\/?$/, 'home', () => homePage(ctx)],
  [/^#\/n\/(\d+)$/, 'home', (m) => notifPage(ctx, Number(m[1]))],
  [/^#\/snapshot$/, 'home', () => snapshotPage(ctx)],
  [/^#\/account$/, 'account', () => accountPage(ctx)],
  [/^#\/h\/([A-Za-z0-9.%-]+)$/, 'account', (m) => holdingPage(ctx, decodeURIComponent(m[1]))],
  [/^#\/history$/, 'history', () => historyPage(ctx)],
  [/^#\/do$/, 'do', () => doMenu(ctx)],
  [/^#\/do\/deposit$/, 'do', () => depositPage(ctx)],
  [/^#\/do\/withdraw$/, 'do', () => withdrawPage(ctx)],
  [/^#\/do\/ratio$/, 'do', () => ratioPage(ctx)],
  [/^#\/do\/add$/, 'do', () => addOwnPage(ctx)],
  [/^#\/do\/remove(?:\/([A-Za-z0-9.%-]+))?$/, 'do', (m) => removePage(ctx, m[1] ? decodeURIComponent(m[1]) : null)],
  [/^#\/setup$/, 'do', () => setupPage(ctx)],
];
// 這些頁面要有帳戶才看得到
const NEED_ACCOUNT = /^#\/(n\/|snapshot|h\/|history|do\/)/;

async function loadState() {
  ctx.state = await api.get('/state');
  const st = ctx.state;
  const n = st.todo.length;
  badge.hidden = !n;
  badge.textContent = String(n);
  document.title = (n ? `(${n}) ` : '') + 'stock bot' + (st.mode === 'demo' ? '（示範）' : '');
  modeBtn.setAttribute('aria-pressed', String(st.mode === 'demo'));
  modeBtn.textContent = st.mode === 'demo' ? '示範資料：開' : '示範資料';
  drawDemoBar(st);
  notices.replaceChildren(...st.warnings.map((w) => h('p', { class: 'notice', role: 'status' }, w)));
}

function drawDemoBar(st) {
  demoBar.hidden = st.mode !== 'demo';
  if (st.mode !== 'demo' || !st.demo) return;
  const d = st.demo;
  const act = (label, fn) => {
    const b = h('button', { type: 'button', disabled: d.atEnd && label !== '重來' }, label);
    b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        await fn();
      } catch (e) {
        toast(e.message);
      }
      b.disabled = false;
    });
    return b;
  };
  const advance = (mode) => async () => {
    const r = await api.post('/advance', { mode });
    toast(r.created.length ? `過了 ${r.days} 個交易日，有 ${r.created.length} 則新通知` : `過了 ${r.days} 個交易日，沒有新通知`);
    ctx.go('#/');
  };
  const sel = h(
    'select',
    {
      'aria-label': '情境',
      onchange: async () => {
        await api.post('/reset', { scenario: sel.value });
        ctx.go('#/');
      },
    },
    d.scenarios.map((x) => h('option', { value: x.id, selected: x.id === d.scenario }, x.title)),
  );
  demoBar.replaceChildren(
    h(
      'div',
      { class: 'demo-in' },
      h('strong', null, '示範資料'),
      h('span', null, '價格和 AI 內容都是假的，不會動到真正的帳本。'),
      sel,
      h('span', null, `模擬的今天：${day(st.today, true)}${d.atEnd ? '（情境結束）' : ''}`),
      act('到明天', advance('day')),
      act('到下一則通知', advance('notif')),
      act('到下個月報', advance('month')),
      act('重來', async () => {
        await api.post('/reset', { scenario: d.scenario });
        toast('情境重新開始');
        ctx.go('#/');
      }),
      h('details', { class: 'demo-tips' }, h('summary', null, `這個情境：${d.summary}`), h('ul', null, d.tips.map((t) => h('li', null, t)))),
    ),
  );
}

let seq = 0;
async function render() {
  const my = ++seq;
  const hash = location.hash || '#/';
  const route = ROUTES.find(([re]) => re.test(hash));
  document.querySelectorAll('.nav a').forEach((a) => (a.dataset.nav === (route?.[1] ?? '') ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  if (!main.firstChild) main.replaceChildren(h('p', { class: 'loading' }, '載入中…'));
  try {
    await loadState();
    if (my !== seq) return;
    let node;
    if (!route) node = h('div', null, h('div', { class: 'page-head' }, h('h1', null, '沒有這一頁')), h('a', { class: 'btn', href: '#/' }, '回待辦'));
    else if (!ctx.state.account && NEED_ACCOUNT.test(hash)) node = homePage(ctx);
    else node = await route[2](route[0].exec(hash));
    if (my !== seq) return;
    main.replaceChildren(node);
    window.scrollTo(0, 0);
  } catch (e) {
    if (my !== seq) return;
    if (e instanceof ApiError && e.status === 401) {
      demoBar.hidden = true;
      main.replaceChildren(authPage(e.data.reason, render));
    } else {
      main.replaceChildren(h('div', { class: 'narrow' }, h('div', { class: 'page-head' }, h('h1', null, '這一頁打不開')), h('p', { class: 'err' }, e.message), h('div', { class: 'btn-row' }, h('button', { class: 'btn primary', type: 'button', onclick: render }, '再試一次'), h('a', { class: 'btn', href: '#/' }, '回待辦'))));
    }
  }
}

modeBtn.addEventListener('click', () => ctx.setMode(getMode() === 'demo' ? 'real' : 'demo'));
document.getElementById('themeBtn').addEventListener('click', () => {
  const root = document.documentElement;
  const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  root.dataset.theme = dark ? 'light' : 'dark';
  try {
    localStorage.setItem('stockbot.theme', root.dataset.theme);
  } catch {
    /* 存不了就只在這次瀏覽有效 */
  }
});
window.addEventListener('hashchange', render);
render();
