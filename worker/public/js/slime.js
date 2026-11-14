// 史萊姆：網站唯一的角色。從橫幅底邊扒著探頭，替你說一句話。
// 動作（照設計稿第 7 版）：進頁面時冒上來、每 8 秒探頭一次、眼睛跟游標、跟著游標 3D 轉向（彈簧追，臉和高光分層位移）、
// 游標在主要按鈕上會興奮、改決定時抖一下、有風險時皺眉冒汗、照做時開心地彈一下、說話時嘴巴會動、往下捲時縮回邊緣後面。
// 系統設定「減少動態」時全部停止（CSS 也會把動畫關掉）。
import { h } from './dom.js';

const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
const tpl = document.getElementById('botTpl');
const handTpl = document.getElementById('handTpl');
const makeBot = () => tpl.content.firstElementChild.cloneNode(true);

/** 現在這一頁的史萊姆（換頁時換成新的那一隻）。 */
let mascot = null;
let mBot = null;
let face = null;
let hl = null;
let bubble = null;

// 頁首的小史萊姆（不會動，只有眼睛跟游標）
const logo = makeBot();
logo.setAttribute('viewBox', '0 8 200 160');
logo.dataset.mood = 'watch';
document.getElementById('brand').prepend(logo);

/** 橫幅右下角的史萊姆（含兩隻扒著底邊的手）。 */
export function mascotEl(mood = 'watch') {
  const bot = makeBot();
  bot.dataset.mood = mood;
  bot.dataset.rot = '-4';
  const hand = (side) => {
    const el = h('span', { class: 'hand ' + side, 'aria-hidden': 'true' });
    el.append(handTpl.content.firstElementChild.cloneNode(true));
    return el;
  };
  return h('div', { class: 'mascot' }, bot, hand('l'), hand('r'));
}

/** 新的一頁畫好之後呼叫：記下這一頁的史萊姆和對話框。 */
export function attach(root) {
  mascot = root.querySelector('.mascot');
  mBot = mascot?.querySelector('svg.bot') ?? null;
  face = mBot?.querySelector('.face') ?? null;
  hl = mBot?.querySelector('.hl') ?? null;
  bubble = root.querySelector('.banner .bubble');
  if (mBot) {
    const b = mBot;
    setTimeout(() => b.classList.add('risen'), 1200);
    tx = ty = vx = vy = 0;
  }
  sink();
  look();
}

function replay(el, cls, ms) {
  if (!el) return;
  el.classList.remove(cls);
  void el.getBoundingClientRect();
  el.classList.add(cls);
  setTimeout(() => el.classList.remove(cls), ms);
}

/** 一段話（伺服器給的 { k, say: [字串或 { t, tone }], mood }）畫成對話框的內容。 */
export function bubbleKids(b) {
  if (!b) return [];
  return [h('small', { class: 'bubble-k' }, b.k), ...b.say.map((s) => (typeof s === 'string' ? s : h('b', { class: s.tone === 'neg' ? 'neg' : null }, s.t)))];
}

/**
 * 史萊姆說一句新的話。
 * react：'jiggle' 改決定時抖一下；'hop' 照做時開心地彈一下。
 */
export function say(b, react = null) {
  if (!bubble || !b) return;
  bubble.replaceChildren(...bubbleKids(b));
  replay(bubble, 'pop', 400);
  if (b.mood) mood(b.mood);
  if (still) return;
  replay(mBot, 'talk', 900);
  if (react === 'jiggle' || react === 'hop') replay(mBot, 'jiggle', 720);
  if (react === 'hop' && mBot?.classList.contains('risen')) replay(mBot, 'hop', 800);
}

export function mood(m) {
  if (mBot) mBot.dataset.mood = m;
}

// ---------------------------------------------------------------- 眼睛跟著游標
let last = null;
let raf = 0;
let home = 0;
function look() {
  raf = 0;
  for (const b of document.querySelectorAll('svg.bot')) {
    const r = b.getBoundingClientRect();
    if (!r.width) continue;
    if (!last) {
      b.style.setProperty('--ex', '0px');
      b.style.setProperty('--ey', '0px');
      b.style.setProperty('--lean', '0deg');
      continue;
    }
    // 歪著放的那一隻：把游標方向轉回它自己的座標
    const a = (-(+b.dataset.rot || 0) * Math.PI) / 180;
    const sx = last.x - (r.left + r.width * 0.5);
    const sy = last.y - (r.top + r.height * 0.5);
    const dx = sx * Math.cos(a) - sy * Math.sin(a);
    const dy = sx * Math.sin(a) + sy * Math.cos(a);
    const d = Math.hypot(dx, dy) || 1;
    const k = Math.min(1, d / 240);
    b.style.setProperty('--ex', ((dx / d) * 4.6 * k).toFixed(2) + 'px');
    b.style.setProperty('--ey', ((dy / d) * 6 * k).toFixed(2) + 'px');
    b.style.setProperty('--lean', (-(dx / d) * 3.2 * Math.min(1, d / 500)).toFixed(2) + 'deg');
  }
}

// ---------------------------------------------------------------- 立體感：跟著游標轉，用彈簧追
// 臉移得比身體多、高光往反方向移：三層位移不同，看起來就有前後的厚度。
let gx = 0;
let gy = 0;
let tx = 0;
let ty = 0;
let vx = 0;
let vy = 0;
let springing = false;
function kick() {
  if (!springing && mBot) {
    springing = true;
    requestAnimationFrame(spring);
  }
}
function spring() {
  if (!mBot) {
    springing = false;
    return;
  }
  const k = 0.07;
  const damp = 0.8;
  vx = (vx + (gx - tx) * k) * damp;
  vy = (vy + (gy - ty) * k) * damp;
  tx += vx;
  ty += vy;
  const sp = Math.min(1, Math.hypot(vx, vy) * 14); // 動得快的時候壓扁一點
  mBot.style.transform = `perspective(800px) rotateY(${(tx * 16).toFixed(2)}deg) rotateX(${(-ty * 9).toFixed(2)}deg) scale(${(1 + sp * 0.035).toFixed(3)}, ${(1 - sp * 0.045).toFixed(3)})`;
  face?.setAttribute('transform', `translate(${(tx * 8).toFixed(2)} ${(ty * 4).toFixed(2)})`);
  hl?.setAttribute('transform', `translate(${(-tx * 5).toFixed(2)} ${(-ty * 3).toFixed(2)})`);
  if (Math.abs(gx - tx) + Math.abs(gy - ty) + Math.abs(vx) + Math.abs(vy) > 0.0008) requestAnimationFrame(spring);
  else springing = false;
}

/** 往下捲的時候慢慢縮回橫幅底邊後面，捲回來再探頭。 */
function sink() {
  if (mascot && !still) mascot.style.setProperty('--sink', Math.min(1, window.scrollY / 280).toFixed(3));
}

if (!still) {
  window.addEventListener('pointermove', (e) => {
    last = { x: e.clientX, y: e.clientY };
    raf ||= requestAnimationFrame(look);
    if (mBot) {
      const r = mBot.getBoundingClientRect();
      if (r.width) {
        gx = Math.max(-1, Math.min(1, (e.clientX - (r.left + r.width / 2)) / 520));
        gy = Math.max(-1, Math.min(1, (e.clientY - (r.top + r.height * 0.45)) / 360));
        kick();
      }
    }
  });
  window.addEventListener('pointerdown', (e) => {
    last = { x: e.clientX, y: e.clientY };
    raf ||= requestAnimationFrame(look);
    clearTimeout(home);
    if (e.pointerType !== 'mouse')
      home = setTimeout(() => {
        last = null;
        gx = gy = 0;
        kick();
        look();
      }, 1600);
  });
  document.documentElement.addEventListener('pointerleave', () => {
    last = null;
    gx = gy = 0;
    kick();
    raf ||= requestAnimationFrame(look);
  });
  // 點史萊姆會抖一下
  document.addEventListener('click', (e) => {
    const b = e.target.closest?.('svg.bot');
    if (b && !b.closest('a')) replay(b, 'jiggle', 720);
  });
  // 每 8 秒探頭一次
  setInterval(() => {
    if (!document.hidden && mBot?.classList.contains('risen')) replay(mBot, 'peek', 1250);
  }, 8000);
  // 游標移到主要按鈕上會興奮
  document.addEventListener('pointerover', (e) => {
    if (e.target.closest?.('.btn.primary')) mascot?.classList.add('eager');
  });
  document.addEventListener('pointerout', (e) => {
    if (e.target.closest?.('.btn.primary')) mascot?.classList.remove('eager');
  });
  window.addEventListener('scroll', sink, { passive: true });
}

// 上方那一疊（頁首＋示範列）的高度：主控台靠它貼齊畫面
const stack = document.getElementById('stack');
if (typeof ResizeObserver === 'function') new ResizeObserver(() => document.documentElement.style.setProperty('--stack-h', stack.offsetHeight + 'px')).observe(stack);
