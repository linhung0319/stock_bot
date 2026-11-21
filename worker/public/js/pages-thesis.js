// 論點（T27，own_thesis §1.7、§1.8）：「複製討論包」與「編輯論點」頁。
// 論點在 claude.ai 討論；這裡只做頭（複製討論包）和尾（貼回 → 預覽 → 確認 → 出場條件送去改寫）。只求能用，版面在 T34 整理。
// T56（web_evidence_design §2.6）：stock bot 的草稿——編輯論點頁右邊多一塊草稿（反方 → 論點 → 前提 → 出場條件 → 同業 → 監測不了的）；
// 各入口的「請 stock bot 草擬」（draftAction）。T70（confirm_audit_design §2.1）：草稿那一塊只顯示，「採用這份草稿」整份照草稿存
// （現在有論點時先列對照、按「確定採用」），存完回持股頁。不碰 DOM 的部分在 thesis-draft.js。
// T63（composite_layer_design §3）：審查提到、你的前提沒有涵蓋的事——右欄上面多一塊，每一件可以「帶進右欄」再改字
// （T71，confirm_audit_design §4：「看過了，不加」拿掉，新風險也不再列「要看的事」）。
// 不碰 DOM 的部分在 thesis-risks.js。
import { api } from './api.js';
import { day, h, put, toast } from './dom.js';
import { glass, page } from './layout.js';
import { unsentBox } from './pages-ai.js';
import { actionButton, errBox } from './pages-notif.js';
import { say } from './slime.js';
import { replyOption } from './thesis-reply.js';
import { prevFill } from './thesis-prev.js';
import { sourcesEditor, sourcesNow } from './thesis-sources.js';
import { ACTION_TEXT as DRAFT_ACTION, ADOPT_HINT, ANSWER_TEXT, adoptCompare, adoptResultLines, checkLine, draftButtonState, draftItems, draftNotices, exitMonitorText, md } from './thesis-draft.js';
import { BELIEF_NOTE, EVERY_DEFAULT, LIMITS as FIELD_LIMITS, MAX_CLAUSES, VERIFY_OPTIONS, checkableWarn, fieldsSummary, hasFields, premiseFieldsOf, verifyText } from './thesis-fields.js';
import { RISK_INTRO, RISK_ROW_HINT, RISK_TITLE, riskButtons, riskMeta, riskPreviewLine } from './thesis-risks.js';

const ACTIONS = [
  ['EXIT', '出清'],
  ['HALF', '減半'],
  ['REVIEW', '重新審查'],
];
const LIMITS = { thesis: 600, premises: 5, premise: 200, exits: 6, exit: 300 };

/**
 * 採用草稿之後要在持股頁寫的那幾行（T70，§2.1「存完回到持股頁，畫面寫『已採用 M/D 的草稿；要改字在這一頁改』」）：
 * 代號 → adoptResultLines 的結果。持股頁讀了就拿掉（takeAdoptFlash），重新整理之後不再出現。
 */
export const adoptFlash = new Map();
export function takeAdoptFlash(ticker) {
  const x = adoptFlash.get(ticker) ?? null;
  adoptFlash.delete(ticker);
  return x;
}

/** 原本只有系統預設、這次也沒有自己的前提（T45，T41 第 2 條）：預覽與存檔結果同一句。 */
export const DEFAULT_ONLY_TEXT = '沒有寫前提：AI 照樣用系統預設的三條前提檢查，這檔仍算還沒有論點。';
/** 前提有變動、但 30 天內已經開過論點變動後的審查（T45，T41 第 9 條）：預覽與送不出去時的結果框同一句。 */
export const reviewHeldText = (at) => `${day(at)} 已經審過一次（每檔 30 天最多 1 次），這次的改動留到月底檢查點審。`;
/** 存檔後的前提變動會不會開審查（預覽、送不出去時的結果框）。 */
const reviewLine = (p) => (p.reviewHeld ? `前提有增減或字改了：${reviewHeldText(p.reviewHeld)}` : '前提有增減或字改了：隔天的每日流程會開一次審查，檢查每條前提（每檔 30 天最多 1 次）。');

/** 取討論包、放進剪貼簿。剪貼簿不能用時，在按鈕下面放一個選好的文字框讓使用者自己複製。 */
async function copyDiscussion(btn, ticker, notif) {
  const q = notif ? `?notif=${notif}` : '';
  const r = await api.get(`/own/${encodeURIComponent(ticker)}/discussion${q}`);
  try {
    await navigator.clipboard.writeText(r.text);
    toast(`已複製 ${ticker} 的討論包（${r.text.length.toLocaleString('en-US')} 字），貼到 claude.ai 的新對話`);
  } catch {
    const box = h('textarea', { rows: 8, readonly: true, style: 'margin-top:10px' }, r.text);
    const row = btn.closest('.btn-row') ?? btn;
    row.parentElement.querySelector('.pack-fallback')?.remove();
    const wrap = h('div', { class: 'pack-fallback' }, h('p', { class: 'small dim', style: 'margin-top:10px' }, '這個瀏覽器不讓網頁直接寫剪貼簿。下面的文字已經選好，按 Ctrl+C（手機長按 → 拷貝）。'), box);
    row.after(wrap);
    box.focus();
    box.select();
  }
}

/** 「複製討論包」按鈕（持股頁、編輯論點頁；乙類通知的「拿去討論」在 T29a 用同一個，帶通知編號）。 */
export function copyPackButton(ticker, notif = null, label = '複製討論包', cls = '') {
  const b = actionButton(label, cls, () => copyDiscussion(b, ticker, notif).catch((e) => toast(e.message)));
  return b;
}

// ---------------------------------------------------------------- 編輯論點頁

const rowStyle = 'display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:center;margin-top:8px';

/**
 * 右邊一條前提的「怎麼驗證」（T60，composite_layer_design §2.2、§2.3）：用什麼查（選了「查不到」就是信念）、來源、多久有新的一份、
 * 怎樣算證實、怎樣算不成立（最多 3 句，一句一件事）。收合時一行摘要；帶進來的（審查提到的風險）預設攤開（看得到填了什麼），
 * 現在的前提、貼回沿用的預設收合（左邊「現在的」看得到全文）。手寫的前提都可以不填。
 * 回傳 { el, get, set }：get() = { breaksIf, confirmsIf, verify }（送出的形狀；verify 沒選是 null）；
 * set(f, show) 換成 f（null = 清空；show 要不要攤開，沒給 = 有寫任何一欄就攤開）。
 */
function premFieldsEditor(init, onChange, open = hasFields(init)) {
  const noEnter = (el) => el.addEventListener('keydown', (ev) => ev.key === 'Enter' && ev.preventDefault());
  const sel = h('select', { 'aria-label': '用什麼查' }, VERIFY_OPTIONS.map(([v, t]) => h('option', { value: v }, t)));
  const src = h('input', { type: 'text', maxlength: FIELD_LIMITS.source, placeholder: '例如 trendforce.com、10-Q 的事業單位營收', 'aria-label': '來源' });
  const every = h('input', { type: 'text', inputmode: 'numeric', maxlength: 3, placeholder: String(EVERY_DEFAULT), 'aria-label': '多久有新的一份（天）' });
  const conf = h('textarea', { class: 'prem-in', rows: 1, maxlength: FIELD_LIMITS.confirmsIf, placeholder: '什麼樣的原文算證實（寫成看得到的事，「沒看到壞消息」不算）', 'aria-label': '怎樣算證實' });
  const bis = Array.from({ length: MAX_CLAUSES }, (_, j) => h('textarea', { class: 'prem-in', rows: 1, maxlength: FIELD_LIMITS.clause, placeholder: j === 0 ? '什麼情況算不成立（寫成查得到的事）' : `第 ${j + 1} 句（可以不填；一句寫一件事）`, 'aria-label': `怎樣算不成立第 ${j + 1} 句` }));
  [conf, ...bis].forEach(noEnter);
  const sum = h('summary', null);
  const beliefNote = h('p', { class: 'small prem-belief' }, BELIEF_NOTE);
  const srcRow = h('div', { class: 'prem-src' }, h('label', { class: 'prem-f' }, h('span', { class: 'small faint' }, '來源'), src), h('label', { class: 'prem-f prem-every' }, h('span', { class: 'small faint' }, '多久有新的一份（天）'), every));
  const everyHint = h('p', { class: 'small faint prem-hint' }, `不知道多久有新的一份就留空，用 ${EVERY_DEFAULT} 天。`);
  const confRow = h('label', { class: 'prem-f' }, h('span', { class: 'small faint' }, '怎樣算證實'), conf);
  const el = h(
    'details',
    { class: 'prem-more' },
    sum,
    h(
      'div',
      { class: 'prem-more-body' },
      h('label', { class: 'prem-f' }, h('span', { class: 'small faint' }, '用什麼查'), sel),
      beliefNote,
      srcRow,
      confRow,
      h('div', { class: 'prem-f' }, h('span', { class: 'small faint' }, `怎樣算不成立（最多 ${MAX_CLAUSES} 句，審查會逐句看）`), ...bis),
      everyHint,
    ),
  );
  const get = () => {
    const by = sel.value;
    const s = src.value.trim();
    const e = every.value.trim();
    return {
      breaksIf: bis.map((x) => x.value.trim()).filter(Boolean),
      confirmsIf: conf.value.trim(),
      verify: by ? { by, ...(by !== 'NONE' && s ? { source: s } : {}), ...(by !== 'NONE' && e ? { every: Number(e) } : {}) } : null,
    };
  };
  const sync = () => {
    const belief = sel.value === 'NONE';
    beliefNote.hidden = !belief;
    srcRow.hidden = belief;
    everyHint.hidden = belief;
    sum.textContent = fieldsSummary(get());
  };
  const set = (f, show = hasFields(f)) => {
    const v = f?.verify ?? null;
    sel.value = v?.by ?? '';
    src.value = v?.source ?? '';
    every.value = v?.every ? String(v.every) : '';
    conf.value = f?.confirmsIf ?? '';
    const bs = f?.breaksIf ?? [];
    bis.forEach((x, j) => (x.value = bs[j] ?? ''));
    el.open = show;
    sync();
  };
  for (const x of [src, every, conf, ...bis]) x.addEventListener('input', () => (sync(), onChange()));
  sel.addEventListener('change', () => (sync(), onChange()));
  set(init, open);
  return { el, get, set };
}
const removeBtn = (fn) => h('button', { class: 'btn quiet', type: 'button', 'aria-label': '拿掉這一條', onclick: fn }, '拿掉');
const counter = (el, max) => {
  const c = h('small', { class: 'faint' });
  const upd = () => (c.textContent = `${el.value.length}／${max} 字`);
  el.addEventListener('input', upd);
  upd();
  return c;
};

export async function thesisEditPage(ctx, ticker, notifParam) {
  const enc = encodeURIComponent(ticker);
  // 草稿（T56）：這份論點檔等你看的那一份與草稿狀態；不是自選、示範模式回空的
  const [d, dd] = await Promise.all([api.get('/holding/' + enc), api.get(`/own/${enc}/draft`).catch(() => null)]);
  const back = { href: `#/h/${encodeURIComponent(d.ticker)}`, label: d.ticker };
  if (!d.own) return page({ view: 'page', banner: { back, title: '編輯論點', sub: `${d.ticker} 不是自選股，沒有論點可以編輯。`, bubble: { k: '編輯論點', say: ['只有自選股有論點。'], mood: 'idle' } }, pane: h('a', { class: 'btn', href: back.href }, '回持股頁') });
  const own = d.own;
  const draft = dd?.draft ?? null;
  const draftState = dd?.state ?? own.draft ?? null;
  const notif = notifParam ?? own.pendingBreak?.notif ?? null;
  // 「這是對通知 #N 的回應」只給還沒回覆的乙類（own_thesis §1.10）；慢規則通知不能用修正論點結案（§3.4）
  // 只有從那則通知進來才預設勾著；從持股頁直接進來顯示但不勾（own_thesis §1.8，T39b）
  const replyOpt = replyOption(notifParam, own.pendingBreak?.notif ?? null);
  const replyNotif = replyOpt?.notif ?? null;
  const owned = (d.monitor ?? []).filter((c) => c.owned && c.code !== 'RETIRED');
  // 目前監測中的你定的條件（T42）：右邊的出場條件預填這些；存檔時和它們比，有改動才整組送 AI 對照
  const live = owned.filter((c) => ['ACTIVE', 'REVIEW_ONLY', 'MANUAL'].includes(c.code));
  let source = 'TYPED';
  // 網頁證據的來源（T52）：和論點同一個存檔按鈕；有改動才送
  const srcEd = sourcesEditor(d.ticker, own.webSources ?? null, () => changed());

  // ---- 右邊：新的（三欄都可以手改）
  const thesisIn = h('textarea', { rows: 6, maxlength: LIMITS.thesis, placeholder: '我為什麼持有它（一段，300 字以內最好）' });
  thesisIn.value = own.thesis?.text ?? '';
  const premList = h('div');
  const exitList = h('div');
  const prems = [];
  const exits = [];
  const noEnter = (el) => el.addEventListener('keydown', (ev) => ev.key === 'Enter' && ev.preventDefault());
  /**
   * 右邊的一條前提。每一條都有「怎麼驗證」那一塊（T60：用什麼查、來源、多久有新的一份、怎樣算證實、怎樣算不成立最多 3 句；
   * 可以不填）；p.fields 是預填的值（現在的前提、貼回沿用的）。p.onRemove：按「拿掉」時。
   * p.risk（T63）：從「審查提到的前提以外的風險」帶來的（哪一次執行的第幾條）；下面一行提醒把它改寫成要繼續成立的事。
   */
  const addPrem = (p = { id: null, text: '' }) => {
    if (prems.length >= LIMITS.premises) {
      toast(`前提最多 ${LIMITS.premises} 條：先在「新的」拿掉一條`);
      return null;
    }
    // 多行：長的前提也看得到全文（T39a：單行輸入框會把後半截掉）；Enter 不換行，前提是一句話
    const input = h('textarea', { class: 'prem-in', rows: 2, maxlength: LIMITS.premise, value: p.text, placeholder: '要繼續成立的事', 'aria-label': '前提' });
    noEnter(input);
    const extras = h('div', { class: 'prem-extra' });
    const fe = premFieldsEditor(p.fields ?? null, () => changed(), p.open ?? hasFields(p.fields));
    extras.append(fe.el);
    const r = { id: p.id, input, draft: null, risk: p.risk ?? null, onRemove: p.onRemove ?? null };
    // 提醒放在那一句的正下方、「怎麼驗證」的上面：先改字，再填怎樣算不成立
    if (r.risk) extras.insertBefore(h('p', { class: 'small prem-from prem-risk' }, RISK_ROW_HINT), fe.el);
    r.getFields = fe.get;
    r.setFields = fe.set;
    const el = h('div', { class: 'prem-row' }, h('div', { style: rowStyle }, input, removeBtn(() => { prems.splice(prems.indexOf(r), 1); el.remove(); r.onRemove?.(); changed(); })), extras);
    r.el = el;
    input.addEventListener('input', changed);
    prems.push(r);
    premList.append(el);
    return r;
  };
  const addExit = (x = { text: '', action: 'REVIEW' }) => {
    if (exits.length >= LIMITS.exits) {
      toast(`出場條件最多 ${LIMITS.exits} 條：先在「新的」拿掉一條`);
      return null;
    }
    // 多行（T56：草稿的出場條件常常比一行長，單行輸入框會把後半截掉）；Enter 不換行
    const input = h('textarea', { class: 'prem-in', rows: 1, maxlength: LIMITS.exit, value: x.text, placeholder: '查得到的事，例如：毛利率連兩季低於 70%', 'aria-label': '出場條件' });
    noEnter(input);
    const sel = h('select', { style: 'width:auto', 'aria-label': '成立時' }, ACTIONS.map(([v, t]) => h('option', { value: v, selected: v === x.action }, t)));
    const r = { input, sel, guessed: !!x.guessed, onRemove: x.onRemove ?? null };
    input.addEventListener('input', changed);
    sel.addEventListener('change', changed);
    const el = h(
      'div',
      { class: 'exit-row' },
      h('div', { style: rowStyle.replace('margin-top:8px', 'margin-top:0') }, input, removeBtn(() => { exits.splice(exits.indexOf(r), 1); el.remove(); r.onRemove?.(); changed(); })),
      h('div', { class: 'btn-row cond-ctl' }, h('span', { class: 'small' }, '成立時'), sel, x.guessed ? h('span', { class: 'chip warn' }, '動作沒寫或不認得，先當成重新審查') : null),
    );
    r.el = el;
    exits.push(r);
    exitList.append(el);
    return r;
  };
  const fill = (p) => {
    thesisIn.value = p.thesis;
    thesisIn.dispatchEvent(new Event('input'));
    // 貼回的整組換掉右邊
    prems.splice(0).forEach((r) => (r.el.remove(), r.onRemove?.()));
    exits.splice(0).forEach((r) => r.onRemove?.());
    exitList.replaceChildren();
    // 貼回的 [P2]（T40）是現行的一條 → 帶那個編號；沒寫編號、文字和現行的相同 → 帶上原本的編號（存檔時程式會再對一次）
    // 沿用的那一條帶上現在的「怎麼驗證」（T60：貼回的區塊沒有這幾欄，不帶的話存檔會把它們清掉）
    p.premises.forEach((t, k) => {
      const tag = p.premiseIds?.[k];
      const byTag = tag ? own.premises.find((x) => !x.system && x.id === tag) : null;
      const hit = byTag ?? own.premises.find((x) => !x.system && norm(baseText(x)) === norm(t)) ?? null;
      addPrem({ id: hit?.id ?? null, text: t, fields: hit ? premiseFieldsOf(hit) : null, open: false });
    });
    if (!p.premises.length) addPrem();
    for (const x of p.exits) addExit(x);
    if (!p.exits.length) addExit();
    changed();
  };
  // 現在的前提連同「怎麼驗證」（T56 的怎樣算不成立；T60 的怎樣算證實、來源、信念）預填進右邊，可以改
  if (own.kind === 'THESIS') for (const p of own.premises) addPrem({ id: p.id, text: baseText(p), fields: premiseFieldsOf(p), open: false });
  if (!prems.length) addPrem();
  // 出場條件預填目前監測中的（T42）：右邊就是存檔後要的完整清單，沒動就是沒改動
  for (const c of live) addExit({ text: c.text, action: c.action ?? 'REVIEW' });
  if (!exits.length) addExit();

  // ---- 貼上
  const paste = h('textarea', { rows: 5, placeholder: '把 claude.ai 收尾時輸出的整個區塊貼在這裡（===STOCKBOT 論點 v3 … 到 ===END===）' });
  const parseMsg = h('div');
  const conclBox = h('div');
  const doParse = async () => {
    if (!paste.value.trim()) return parseMsg.replaceChildren(errBox(new Error('還沒貼上內容')));
    try {
      const p = await api.post('/ops/own-thesis/parse', { ticker: d.ticker, text: paste.value });
      if (p.error) {
        return parseMsg.replaceChildren(errBox(new Error(p.error)));
      }
      source = p.found ? 'DISCUSSION' : 'TYPED';
      fill(p);
      put(
        parseMsg,
        p.found ? h('p', { class: 'small', style: 'color:var(--core);margin-top:8px' }, `解析好了：論點 ${p.thesis.length} 字、前提 ${p.premises.length} 條、出場條件 ${p.exits.length} 條。請在右邊確認，需要的話直接改。`) : null,
        p.notes.length ? h('ul', { class: 'notice small', style: 'margin-top:8px;padding-left:2em' }, p.notes.map((n) => h('li', null, n))) : null,
      );
      const hint = p.conclusion && /減半|出清/.test(p.conclusion) && own.pendingBreak ? h('p', { class: 'small', style: 'margin-top:6px' }, `要減碼的話：回到 `, h('a', { href: `#/n/${own.pendingBreak.notif}` }, own.pendingBreakName ?? '那則通知'), ' 按「照 AI」。') : null;
      conclBox.replaceChildren(p.conclusion ? h('div', { class: 'glass pad', style: 'margin-top:12px' }, h('b', null, `這次的結論：${p.conclusion}`), p.reason ? h('p', { class: 'small dim', style: 'margin-top:4px' }, `理由：${p.reason}`) : null, h('p', { class: 'small faint', style: 'margin-top:4px' }, '只顯示，不會自動做任何事；部位照規則與你回覆的通知。'), hint) : '');
    } catch (e) {
      parseMsg.replaceChildren(errBox(e));
    }
  };

  // ---- 存檔前的變動（前提的對應：沿用、新的、會撤下；程式算）
  const diff = h('div', { class: 'small', style: 'margin-top:10px' });
  const exitDiff = h('div', { class: 'small', style: 'margin-top:14px' });
  // T70：草稿改成整份採用（另一個按鈕、另一個端點），這裡只送右邊寫的
  const payload = () => ({
    ticker: d.ticker,
    thesis: thesisIn.value.trim(),
    // 每一條都送「怎麼驗證」（T60）：右邊預填了現在的值，空的就是拿掉
    // 從審查提到的風險帶來的那一條帶 risk（T63）：存檔後那一件不再列在「要看的事」
    premises: prems.map((r) => ({ id: r.id, text: r.input.value.trim(), ...r.getFields(), ...(r.risk ? { risk: r.risk } : {}) })).filter((p) => p.text),
    exitConditions: exits.map((r) => ({ text: r.input.value.trim(), action: r.sel.value })).filter((x) => x.text),
    source,
    replyTo: reply && reply.checked ? replyNotif : null,
    ...(srcEd.changed() ? { webSources: srcEd.value() } : {}),
  });
  /** 沿用編號、但字改了（T40）：左邊舊的、右邊新的；「當成新的一條」取消對應（這一條發新編號，舊的撤下）。 */
  const editedList = (xs, held) =>
    xs.length
      ? h(
          'div',
          { style: 'margin-top:6px' },
          h('b', null, '沿用，但字改了：'),
          h(
            'ul',
            { class: 'edit-cmp' },
            xs.map((x) =>
              h(
                'li',
                null,
                h('div', { class: 'btn-row', style: 'align-items:center;justify-content:space-between' }, h('span', { class: 'st' }, x.id), h('button', { class: 'btn quiet', type: 'button', onclick: () => { const r = prems.find((y) => y.id === x.id); if (r) r.id = null; changed(); } }, '當成新的一條')),
                h('div', { class: 'edit-pair' }, h('div', null, h('p', { class: 'faint' }, '原本'), h('p', { class: 'was' }, x.before)), h('div', null, h('p', { class: 'faint' }, '改成'), h('p', null, x.after))),
              ),
            ),
          ),
          h('p', { class: 'faint', style: 'margin-top:4px' }, `沿用編號：之前的檢查結果接著算；這條前提如果在靜默期（你不同意過 AI 的判斷），靜默期結束，因為你不同意的是原本的字。字改了也算論點變動，${held ? reviewHeldText(held) : '隔天會開一次審查。'}意思已經不同的，按「當成新的一條」。`),
        )
      : null;
  const actName = (v) => ACTIONS.find(([a]) => a === v)?.[1] ?? '重新審查';
  /**
   * 出場條件（T42 整組取代）：沒改動 → 一句「沒有改動」（只改動作的列出來，存檔直接改）；
   * 有改動 → 一句「存檔後送 AI 對照與改寫，回來後在持股頁確認；確認之前，現在的 N 條照舊監測」。
   */
  const exitPreview = (x) => {
    if (!x) return null;
    const rows = exits.map((r) => r.input.value.trim()).filter(Boolean);
    if (!x.changed) {
      if (!x.live && !rows.length) return null;
      return [
        h('b', null, '出場條件'),
        h('p', { style: 'margin-top:6px' }, x.live ? `出場條件沒有改動：現在的 ${x.live} 條照舊監測，不用送 AI。` : '出場條件沒有改動。'),
        x.actionChanged.length
          ? h('div', { style: 'margin-top:6px' }, h('b', null, '只改成立時的動作（存檔時直接改）：'), h('ul', { class: 'diff-list' }, x.actionChanged.map((a) => h('li', null, h('span', null, `${a.text}：${actName(a.was)} → ${actName(a.action)}`)))))
          : null,
      ];
    }
    const head = rows.length
      ? `出場條件有改動：存檔後送 AI 對照與改寫，回來後在持股頁確認${x.live ? `；確認之前，現在的 ${x.live} 條照舊監測` : '，確認後才開始監測'}。`
      : `出場條件全部拿掉：存檔後在持股頁確認才撤下；確認之前，現在的 ${x.live} 條照舊監測。`;
    return [
      h('b', null, '出場條件'),
      h('p', { style: 'margin-top:6px' }, head),
      rows.length && x.live ? h('p', { class: 'faint', style: 'margin-top:4px' }, '右邊是存檔後你要的全部出場條件。AI 會標出哪幾條和現在的相同（不新增）、哪幾條取代舊的；右邊沒有寫到的舊條件，確認後撤下。') : null,
      x.pendingVersion ? h('p', { style: 'margin-top:6px;color:var(--warn)' }, `第 ${x.pendingVersion} 版存的出場條件改動還沒在持股頁確認；這次存檔後以這一版為準，第 ${x.pendingVersion} 版的改寫結果不再列。`) : null,
    ];
  };
  let timer = null;
  function changed() {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        const r = await api.post('/ops/own-thesis', { ...payload(), dry: true });
        const p = r.preview;
        // 一條一行（T34 整理：原本用分號接成一段）
        // 沿用的一條是原樣採用的草稿 → 後面寫「AI 草擬、你採用的」（T56；T70 起整份採用）
        const line = (label, xs, warn) => (xs.length ? h('div', { style: 'margin-top:6px' }, h('b', { style: warn ? 'color:var(--hot)' : null }, label), h('ul', { class: 'diff-list' }, xs.map((x) => h('li', null, h('span', { class: 'st' }, x.id), h('span', null, x.text, x.origin === 'AI_DRAFT_ACCEPTED' && !warn ? h('span', { class: 'faint' }, '（AI 草擬、你採用的）') : null))))) : null);
        const edited = p.edited ?? [];
        put(
          diff,
          riskPrev(p.risks),
          h('b', null, '存檔後的前提'),
          line('沿用：', p.kept.filter((x) => !edited.some((e) => e.id === x.id)), false),
          editedList(edited, p.reviewHeld),
          line('新的：', p.added, false),
          line('會撤下：', p.retired.map((x) => ({ ...x, text: x.origin === 'SYSTEM_DEFAULT' ? `${x.text}（系統預設）` : x.text })), true),
          p.defaultOnly
            ? h('div', { class: 'default-only', style: 'margin-top:4px;color:var(--warn)' }, DEFAULT_ONLY_TEXT)
            : h('div', { class: p.reviewHeld ? null : 'faint', style: `margin-top:4px${p.reviewHeld ? ';color:var(--warn)' : ''}` }, p.changed ? reviewLine(p) : '前提沒有增減：不另外開審查。'),
          p.silenceEnded?.length ? h('div', { style: 'margin-top:4px;color:var(--warn)' }, `${p.silenceEnded.join('、')} 正在靜默期，字改了：存檔後靜默期結束，AI 判斷新的字不成立時會照常通知你。`) : null,
          // 信念與查得到的前提（T60，composite §2.3）：少於 2 條查得到時提醒
          ((w) => (w ? h('div', { class: `belief-warn tone-${w.tone}`, style: 'margin-top:4px' }, w.text) : null))(checkableWarn(p)),
          keptWarn(p),
          srcPreview(p.sources),
        );
        put(exitDiff, exitPreview(p.exits));
      } catch (e) {
        diff.replaceChildren(errBox(e));
      }
    }, 350);
  }
  thesisIn.addEventListener('input', changed);
  /** 預覽裡「審查提到的風險」那一段（T63）：帶進來幾條、存檔後不再列。 */
  const riskPrev = (xs) => {
    const t = riskPreviewLine(xs);
    return t ? h('div', { class: 'draft-prev' }, h('b', null, RISK_TITLE), h('p', { class: 'tone-core' }, t)) : null;
  };
  /** 來源有改動（T52）：存檔時先試抓；全部拿掉的另外說。 */
  const srcPreview = (s) =>
    s?.cleared
      ? h('div', { class: 'src-preview', style: 'margin-top:10px' }, h('b', null, '網頁證據的來源'), h('p', { style: 'margin-top:4px' }, '全部拿掉：之後審查只看這檔自己新聞裡、共用清單內的網站。'))
      : s?.changed
        ? h('div', { class: 'src-preview', style: 'margin-top:10px' }, h('b', null, '網頁證據的來源'), h('p', { style: 'margin-top:4px' }, '有改動：存檔時會先試抓一次；抓不到的仍會存，標「目前抓不到」。'))
        : null;

  const reply = replyOpt ? h('input', { type: 'checkbox', checked: replyOpt.checked, onchange: () => changed() }) : null;
  // 勾著回應、新的前提原封不動留著被判不成立的那一條 → 存檔後當成不同意（own_thesis §1.10），先講清楚；
  // 同一個編號但字改了 → 照修正論點，不進靜默期（T46）
  function keptWarn(p) {
    const pid = own.pendingBreak?.premiseId;
    if (!reply || !reply.checked || !pid || !p.kept.some((x) => x.id === pid)) return null;
    if ((p.edited ?? []).some((e) => e.id === pid))
      return h('div', { class: 'reply-reworded', style: 'margin-top:6px;color:var(--warn)' }, `被判不成立的 ${pid} 字改了：這次算修正論點，${pid} 不進靜默期；AI 判斷新的字也不成立時，會再告訴你。只是不同意、不想改前提的話，把 ${pid} 的字改回原本的，或回那則通知按「不同意，不動」。`);
    return h('div', { class: 'reply-kept', style: 'margin-top:6px;color:var(--hot)' }, `新的前提原封不動留著被判不成立的 ${pid}：存檔後當成「不同意」，${pid} 進靜默期（到下一季財報出來、最長 100 天，不再因為它通知你）。想換掉它，就在右邊改字、拿掉或寫成新的一條。`);
  }
  /** 存檔結果裡那則通知的那一句（T46）：原封不動留著 → 進靜默期；字改了 → 不進靜默期。 */
  const revisedTail = (r, keptText, rewordedText) => (r.revised.kept ? keptText : (r.preview.edited ?? []).some((e) => e.id === r.revised.premiseId) ? rewordedText : '');
  const msg = h('div');
  const formBox = h('div', { class: 'stackv' });
  const save = actionButton('確認，存論點', 'primary', async () => {
    const body = payload();
    const longExit = body.exitConditions.find((x) => x.text.length > LIMITS.exit);
    if (longExit) return msg.replaceChildren(errBox(new Error(`出場條件每條最多 ${LIMITS.exit} 字`)));
    try {
      const r = await api.post('/ops/own-thesis', body);
      msg.replaceChildren();
      if (r.rewrite.status === 'FAILED') {
        // 論點已經存好；出場條件沒送出去 → 明白寫出來，給「重送」（N9）
        formBox.replaceChildren(
          glass(
            'pad',
            h('h2', { class: 'panel-h' }, `論點與前提已經存好（第 ${r.preview.version} 版）`),
            r.preview.changed ? h('p', { class: 'small dim', style: 'margin-top:6px' }, r.preview.reviewHeld ? `前提有增減：${reviewHeldText(r.preview.reviewHeld)}` : '前提有增減：隔天的每日流程會開一次審查。') : null,
            r.preview.defaultOnly ? h('p', { class: 'small', style: 'margin-top:6px;color:var(--warn)' }, DEFAULT_ONLY_TEXT) : null,
            r.revised ? h('p', { class: 'small dim', style: 'margin-top:6px' }, `${r.revisedName ?? '那則通知'}已結案（修正論點，部位不動）${revisedTail(r, `；新的論點還留著前提 ${r.revised.premiseId}，當成不同意，這條前提進靜默期`, `；前提 ${r.revised.premiseId} 的字改了，不進靜默期`)}。`) : null,
            unsentBox(d.ticker, r.exits, `原因：${r.rewrite.error}`, () => ctx.go(back.href), r.preview.version),
            h('p', { class: 'small faint', style: 'margin-top:10px' }, '持股頁也會一直提示，直到重送成功。'),
            h('div', { class: 'btn-row', style: 'margin-top:12px' }, h('a', { class: 'btn', href: back.href }, '回持股頁')),
          ),
        );
        say({ k: '存好了，但…', say: ['論點存好了；', { t: '出場條件還沒送去改寫', tone: 'em' }, '，可以按「重送」。'], mood: 'worry' });
        // 頁首跟著改成存好的這一版（T27 留下的：原本還寫「還沒有論點本文」）
        const kicker = document.querySelector('.banner .kicker');
        if (kicker) kicker.textContent = `第 ${r.preview.version} 版，${day(d.date)} 定`;
        const sub = document.querySelector('.banner .sub');
        if (sub) sub.textContent = '論點與前提已經存好；出場條件還沒送去改寫，按「重送」或回持股頁再送。';
        window.scrollTo({ top: 0 });
        return;
      }
      const rv = r.revised ? `；${r.revisedName ?? '那則通知'}結案（修正論點${revisedTail(r, `，保留的前提 ${r.revised.premiseId} 進靜默期`, `，${r.revised.premiseId} 的字改了、不進靜默期`)}）` : '';
      const cd = r.conds?.actionChanged?.length ? `；${r.conds.actionChanged.length} 條出場條件改了成立時的動作` : '';
      const srcBad = (r.preview.sources?.checked ?? []).filter((c) => c.ok === false).length;
      const sc = r.preview.sources?.changed ? `；網頁證據的來源已存${srcBad ? `（${srcBad} 項目前抓不到）` : ''}` : '';
      const ex = r.rewrite.status === 'SENT' ? '論點已存；出場條件送去 AI 對照與改寫，回來後在持股頁確認（確認之前舊的照舊監測）' : r.preview.exits?.changed ? '論點已存；出場條件全部拿掉，到持股頁確認才撤下' : '論點已存';
      // 從審查提到的風險帶進來的（T63）
      const rk = r.preview.risks?.length ? `；審查提到的 ${r.preview.risks.length} 件風險已經帶進論點，不再另外列出` : '';
      toast([ex + rv + cd + sc + rk, ...(r.preview.defaultOnly ? [DEFAULT_ONLY_TEXT.replace(/。$/, '')] : []), ...(r.conds?.errors ?? [])].join('；'));
      ctx.go(back.href);
    } catch (e) {
      msg.replaceChildren(errBox(e));
    }
  });

  // ---- stock bot 的草稿（T70，confirm_audit_design §2.1）：只顯示（反方 → 論點 → 前提 → 出場條件 → 同業 → 監測不了的），
  // 「採用這份草稿」整份照草稿存；現在有論點、前提、條件或同業時先列對照，再按「確定採用」。之後要改字就用下面原本的編輯流程
  const draftUi = draft ? buildDraftUi() : null;
  function buildDraftUi() {
    const P = draft.payload;
    const items = draftItems(P);
    const evMap = new Map((P.evidence ?? []).map((e) => [e.id, e]));
    const evList = (ids) => {
      const xs = (ids ?? []).map((id) => evMap.get(id)).filter(Boolean);
      if (!xs.length) return null;
      return h(
        'details',
        { class: 'more dr-ev' },
        h('summary', null, `引用（${xs.length}）`),
        h('ul', { class: 'more-body dr-ev-list' }, xs.map((e) => h('li', null, h('p', { class: 'small faint' }, e.url ? h('a', { href: e.url, target: '_blank', rel: 'noopener' }, e.title ?? e.source_id) : e.title ?? e.source_id, e.date ? `（${e.date}）` : ''), h('blockquote', { class: 'small' }, `「${e.quote}」`)))),
      );
    };
    const showRow = (body) => h('li', { class: 'dr-item dr-show' }, h('div', { class: 'dr-body' }, body));
    // 怎麼驗證（T60）：查得到 → 來源與多久有新的一份；信念 → 提醒的顏色（是你可以選的路，不是錯）
    const premCheck = (it) => {
      const c = checkLine(it);
      return h('p', { class: 'small', style: c.belief ? 'color:var(--warn)' : c.ok ? 'color:var(--ink-2)' : 'color:var(--hot)' }, c.text);
    };
    const notices = draftNotices(draft);
    const body = { ticker: d.ticker, id: draft.id };
    const replyTo = () => (reply && reply.checked ? replyNotif : null);
    const compareBox = h('div');
    const dismissBox = h('div');
    /** 真的採用：存好之後回持股頁，那裡寫「已採用 M/D 的草稿；要改字在這一頁改」。 */
    const doAdopt = async () => {
      const r = await api.post('/ops/own-draft/adopt', { ...body, replyTo: replyTo() });
      adoptFlash.set(d.ticker, adoptResultLines(r, draft.at));
      ctx.go(back.href);
    };
    /** 對照（§2.1）：哪幾條前提會被換掉、沿用哪幾條；出場條件、同業；這一步不勾，只多一個「確定採用」。 */
    const showCompare = (pv) => {
      const secs = adoptCompare(pv);
      put(
        compareBox,
        h(
          'div',
          { class: 'adopt-cmp' },
          h('b', null, '採用之後會這樣換'),
          secs.map((s) => h('div', { class: 'adopt-sec' }, h('p', { class: 'small adopt-h' }, s.h), h('ul', { class: 'diff-list adopt-list' }, s.rows.map((x) => h('li', { class: `small tone-${x.tone}` }, x.text))))),
          h('div', { class: 'btn-row', style: 'margin-top:10px' }, actionButton('確定採用', 'primary', async () => {
            try {
              await doAdopt();
            } catch (e) {
              put(compareBox, errBox(e));
            }
          }), h('button', { class: 'linkbtn', type: 'button', onclick: () => put(compareBox) }, '先不要')),
        ),
      );
      compareBox.scrollIntoView({ block: 'nearest' });
    };
    const adopt = actionButton('採用這份草稿', 'primary', async () => {
      put(dismissBox);
      try {
        const pv = await api.post('/ops/own-draft/adopt', { ...body, replyTo: replyTo(), dry: true });
        if (pv.preview?.draft?.differs) return showCompare(pv.preview);
        await doAdopt();
      } catch (e) {
        put(compareBox, errBox(e));
      }
    });
    const dismiss = actionButton('不用這份草稿', 'quiet', async () => {
      put(compareBox);
      put(
        dismissBox,
        h(
          'div',
          { class: 'btn-row', style: 'margin-top:8px;align-items:center' },
          h('span', { class: 'small' }, '確定不用？草稿會收起來，不再列在「要看的事」；你現在的論點不會變。'),
          actionButton('確定不用', '', async () => {
            try {
              await api.post('/ops/own-draft/dismiss', { ticker: d.ticker, id: draft.id });
              toast('這份草稿標成不用了');
              ctx.go(location.hash);
            } catch (e) {
              put(dismissBox, errBox(e));
            }
          }),
          h('button', { class: 'linkbtn', type: 'button', onclick: () => put(dismissBox) }, '算了'),
        ),
      );
    });
    const peerRows = items.peers.map((it) => showRow([h('p', null, `同業：${it.name}`), h('p', { class: 'small faint' }, [it.edgar ? `EDGAR ${it.edgar}（申報；採用時核對代號，對不到的不存）` : null, it.yahoo ? `Yahoo ${it.yahoo}（新聞連結）` : null].filter(Boolean).join('、'))]));
    const el = glass(
      'pad draft-box',
      h('div', { class: 'panel-top' }, h('h2', { class: 'panel-h' }, `stock bot 的草稿（${md(draft.at)}）`), h('span', { class: 'chip' }, draft.trigger === 'AUTO' ? '自動草擬' : '你請的'), h('a', { class: 'small dr-run', href: `#/ai/${encodeURIComponent(draft.runId)}` }, '完整紀錄')),
      notices.map((n) => h('p', { class: `dr-note tone-${n.tone}` }, n.text)),
      h('h5', { class: 'dr-h' }, '先看反方：最可能讓持有者後悔的三件事'),
      h('ol', { class: 'dr-against' }, P.against.map((a, i) => h('li', null, h('p', null, `${i + 1}. ${a.text}`), evList(a.evidence_ids)))),
      h('p', { class: 'dr-buy' }, h('span', { class: 'faint' }, '今天沒有持股的話，用這個價格會不會買：'), h('b', null, ANSWER_TEXT[P.would_buy_today.answer] ?? P.would_buy_today.answer), h('span', null, `。${P.would_buy_today.why}`)),
      h('h5', { class: 'dr-h' }, '論點'),
      h('p', { class: 'th-text dr-thesis' }, P.thesis),
      h('h5', { class: 'dr-h' }, `前提（${items.premises.length} 條）`),
      h(
        'ul',
        { class: 'dr-list' },
        items.premises.map((it) =>
          showRow([
            h('p', null, it.text),
            it.keepId ? h('p', { class: 'small', style: 'color:var(--ink-2)' }, `就是你現在的 ${it.keepId}（一字沒改，採用後編號不變）`) : null,
            it.likeBroken && draft.broken ? h('p', { class: 'small', style: 'color:var(--hot)' }, `和剛被判不成立的 ${draft.broken.premiseId} 很像：想一想是不是換個說法留著它`) : null,
            it.confirmsIf ? h('p', { class: 'small' }, h('span', { class: 'faint' }, '怎樣算證實：'), it.confirmsIf) : null,
            !it.breaksIf.length
              ? null
              : it.breaksIf.length === 1
                ? h('p', { class: 'small' }, h('span', { class: 'faint' }, '怎樣算不成立：'), it.breaksIf[0])
                : h('div', { class: 'small' }, h('span', { class: 'faint' }, `怎樣算不成立（任一句成立就算，${it.breaksIf.length} 句）：`), h('ul', { class: 'dr-plain' }, it.breaksIf.map((b) => h('li', null, b)))),
            premCheck(it),
            evList(it.evidence),
          ]),
        ),
      ),
      h('h5', { class: 'dr-h' }, `出場條件（${items.exits.length} 條）`),
      h(
        'ul',
        { class: 'dr-list' },
        items.exits.map((it) => {
          const m = exitMonitorText(it);
          return showRow([
            h('p', null, it.text),
            h('p', { class: 'small' }, h('span', { class: 'faint' }, '成立時：'), DRAFT_ACTION[it.action] ?? it.action, it.premiseIndex !== null && P.premises[it.premiseIndex] ? h('span', { class: 'faint' }, `；對應第 ${it.premiseIndex + 1} 條前提`) : null),
            h('p', { class: `small tone-${m.tone}` }, m.text),
            evList(it.evidence),
          ]);
        }),
      ),
      peerRows.length ? [h('h5', { class: 'dr-h' }, '同業（審查時 AI 可以另外讀的申報與新聞）'), h('ul', { class: 'dr-list' }, peerRows)] : null,
      P.not_checkable?.length ? [h('h5', { class: 'dr-h' }, 'stock bot 監測不了、要你自己留意的'), h('ul', { class: 'dr-plain' }, P.not_checkable.map((x) => h('li', { class: 'small' }, x)))] : null,
      P.report ? h('details', { class: 'more', style: 'margin-top:12px' }, h('summary', null, '主筆的說明'), h('p', { class: 'more-body small', style: 'white-space:pre-wrap' }, P.report)) : null,
      h('div', { class: 'adopt-bar' }, h('p', { class: 'small adopt-hint' }, ADOPT_HINT), h('div', { class: 'btn-row' }, adopt, dismiss)),
      compareBox,
      dismissBox,
    );
    return { el };
  }
  // ---- 審查提到、你的前提沒有涵蓋的事（T63，composite_layer_design §3）：每一件可以帶進右欄再改字（T71 拿掉「看過了，不加」）。
  // 只當建議：帶進來的要你改寫、存檔才算；不帶的不會自己變成前提
  const risks = d.thesis?.risks ?? [];
  const riskBox = risks.length ? buildRiskBox() : null;
  function buildRiskBox() {
    const list = h('ul', { class: 'risk-list' });
    const count = h('span', { class: 'chip warn' }, `${risks.length} 件`);
    const box = glass('pad draft-box risk-box', h('div', { class: 'panel-top' }, h('h2', { class: 'panel-h' }, RISK_TITLE), count), h('p', { class: 'small dim', style: 'margin-top:4px' }, RISK_INTRO), list);
    // 右欄空白、沒有編號也不是從草稿來的那幾條先拿掉，帶進來的才不會排在空白的後面
    const dropEmpty = () => prems.filter((r) => !r.input.value.trim() && r.draft === null && !r.id && !r.risk).forEach((r) => (prems.splice(prems.indexOf(r), 1), r.el.remove()));
    for (const r of risks) {
      const acts = h('div');
      const li = h(
        'li',
        { class: 'risk-item' },
        h('p', null, r.text),
        h('p', { class: 'small faint' }, riskMeta(r), r.url ? ['；', h('a', { href: r.url, target: '_blank', rel: 'noopener noreferrer' }, '原始網址')] : null),
        h('details', { class: 'more dr-ev' }, h('summary', null, '引用的原文'), h('blockquote', { class: 'more-body small risk-quote' }, `「${r.quote}」`)),
        acts,
      );
      const draw = (taken) => {
        const b = riskButtons(taken);
        put(acts, b.take ? h('div', { class: 'btn-row', style: 'margin-top:8px' }, h('button', { class: 'btn', type: 'button', onclick: take }, b.take)) : h('p', { class: 'small', style: 'margin-top:6px;color:var(--core)' }, b.note));
      };
      function take() {
        dropEmpty();
        const row = addPrem({ id: null, text: r.text, risk: { runId: r.runId, k: r.k }, open: true, onRemove: () => draw(false) });
        if (!row) {
          if (!prems.length) addPrem();
          return;
        }
        draw(true);
        changed();
        row.input.focus();
      }
      draw(false);
      list.append(li);
    }
    return box;
  }
  // 沒有等你看的草稿：右邊上面是「請 stock bot 草擬」那一塊（準備中、要等幾天、上次失敗的原因）
  const draftAsk = draft
    ? null
    : glass(
        'pad draft-box',
        h('h2', { class: 'panel-h' }, '請 stock bot 草擬'),
        h('p', { class: 'small dim', style: 'margin-top:4px' }, 'stock bot 讀這家公司的申報、財報與網站，先寫反方，再寫論點、前提與出場條件。回來後在這裡先看反方，再決定要不要整份採用。'),
        own.pendingBreak ? h('p', { class: 'small', style: 'margin-top:6px;color:var(--hot)' }, `前提 ${own.pendingBreak.premiseId ?? ''} 剛被 AI 判不成立：這時候請 stock bot 草擬，草稿最上面會提醒你別只是替繼續持有找新理由，也不能沿用那一條。`) : null,
        h('div', { style: 'margin-top:10px' }, draftAction(d.ticker, draftState, { onEdit: true })),
      );

  const current = glass(
    'pad',
    h('h2', { class: 'panel-h' }, '現在的'),
    h('h5', { style: 'margin-top:10px' }, '論點'),
    own.thesis ? h('p', { class: 'small', style: 'white-space:pre-wrap;margin-top:4px' }, own.thesis.text) : h('p', { class: 'small faint', style: 'margin-top:4px' }, '還沒有'),
    h('h5', { style: 'margin-top:12px' }, own.kind === 'DEFAULT_ONLY' ? '前提（系統預設）' : '前提'),
    // 每一條下面一行（T60）：怎樣算證實與怎麼驗證；信念寫「這一條查不到，是你選擇相信的」
    h(
      'ul',
      { class: 'prem' },
      own.premises.map((p) =>
        h(
          'li',
          null,
          h('span', { class: 'st' }, p.id),
          h('span', { class: 'small' }, p.text),
          p.confirmsIf ? h('small', null, `怎樣算證實：${p.confirmsIf}`) : null,
          verifyText(p.verify) ? h('small', { class: p.belief ? 'prem-belief' : null }, verifyText(p.verify)) : null,
        ),
      ),
    ),
    h('h5', { style: 'margin-top:12px' }, '你定的條件'),
    owned.length ? h('ul', { class: 'small', style: 'margin:6px 0 0 1.2em' }, owned.map((c) => h('li', null, `${c.text} → ${c.actionText ?? '只記錄'}（${c.status}）`))) : h('p', { class: 'small faint', style: 'margin-top:4px' }, '還沒有'),
    h('h5', { style: 'margin-top:12px' }, '網頁證據的來源'),
    sourcesNow(own.webSources ?? null, own.kind === 'DEFAULT_ONLY'),
  );
  // 賣光之後又買回（T44）：把上一次持有時的論點本文與前提填進右邊；前提當成新的，出場條件不帶
  const pf = prevFill(own.prev);
  const prevMsg = h('div');
  const prevBox = pf
    ? h(
        'div',
        { class: 'prev-fill' },
        h('p', { class: 'small' }, `上一次持有時（${own.prev.openedAt ? `${day(own.prev.openedAt)}開檔` : '開檔日不明'} → ${day(own.prev.closedAt)}${own.prev.closedVerb}）有論點${pf.thesis ? '' : '（沒有本文）'}${pf.premises.length ? `與 ${pf.premises.length} 條前提` : ''}。`),
        h(
          'div',
          { class: 'btn-row', style: 'margin-top:6px' },
          h(
            'button',
            {
              class: 'btn',
              type: 'button',
              onclick: () => {
                thesisIn.value = pf.thesis;
                thesisIn.dispatchEvent(new Event('input'));
                prems.splice(0).forEach((r) => (r.el.remove(), r.onRemove?.()));
                pf.premises.forEach((p) => addPrem(p));
                if (!prems.length) addPrem();
                source = 'TYPED';
                put(prevMsg, h('p', { class: 'small', style: 'color:var(--core);margin-top:6px' }, `已帶入上次的論點${pf.premises.length ? `與 ${pf.premises.length} 條前提（當成新的前提，存檔時發新的編號）` : ''}。出場條件沒有帶，要重新寫。`));
                changed();
              },
            },
            '帶入上次的論點',
          ),
        ),
        h('p', { class: 'small faint', style: 'margin-top:6px' }, '把上次的論點本文與前提填進下面，再照這次買回的理由改。前提當成新的；出場條件不帶，要重新寫（舊的條件不會恢復監測）。'),
        prevMsg,
      )
    : null;
  const next = glass(
    'pad',
    h('h2', { class: 'panel-h' }, '新的（可以直接改）'),
    prevBox,
    h('label', { class: 'field', style: 'margin-top:10px' }, h('span', null, '論點'), thesisIn, counter(thesisIn, LIMITS.thesis)),
    h(
      'div',
      { class: 'field' },
      h('span', null, `前提（最多 ${LIMITS.premises} 條）`),
      own.kind === 'DEFAULT_ONLY' ? h('small', null, '目前用系統預設前提。寫了自己的前提，存檔時就取代預設。') : h('small', null, '和現在的文字相同的沿用原本的編號；拿掉的會撤下。'),
      h('small', null, '每一條下面的「怎麼驗證」可以不填：寫了怎樣算證實、不成立與來源，審查判得比較準；外人查不到的事選「查不到：標成信念」，它不進審查。'),
      premList, h('div', null, h('button', { class: 'linkbtn', type: 'button', onclick: () => { addPrem(); changed(); } }, '再加一條前提'))),
    h(
      'div',
      { class: 'field', style: 'margin-bottom:0' },
      h('span', null, `出場條件（最多 ${LIMITS.exits} 條）`),
      h('small', null, live.length ? `這裡是存檔後你要的全部出場條件，已經填好現在監測中的 ${live.length} 條。沒改就不會送 AI；改了的話整組送 AI 對照，在持股頁確認後才換上新的。不會存成前提。` : '不會存成前提。存檔後送 AI 改寫成查得到的格式，你在持股頁確認才開始監測。'),
      exitList,
      h('div', null, h('button', { class: 'linkbtn', type: 'button', onclick: () => { addExit(); changed(); } }, '再加一條出場條件')),
    ),
    srcEd.el,
  );

  formBox.append(
    glass(
      'pad',
      h('h2', { class: 'panel-h' }, '貼上討論的結果'),
      h('p', { class: 'small dim', style: 'margin-top:4px' }, '在 claude.ai 說「收尾」之後，把它輸出的整個區塊貼進來，按「解析」。沒有討論也可以直接在下面手寫。'),
      h('div', { style: 'margin-top:10px' }, paste),
      h('div', { class: 'btn-row', style: 'margin-top:8px' }, actionButton('解析', '', doParse), copyPackButton(d.ticker, notif)),
      parseMsg,
      conclBox,
    ),
    // 草稿（T56）：在右邊「新的」那一欄上面（§2.3）；手機上依序是現在的、草稿、新的
    // 審查提到的前提以外的風險（T63）：在「新的」正上方，按「帶進右欄」就填到下面那一欄
    h('div', { class: 'thesis-cmp' }, current, h('div', { class: 'stackv thesis-next' }, draftUi?.el ?? draftAsk, riskBox, next)),
    glass(
      'pad',
      diff,
      exitDiff,
      reply ? h('label', { class: 'check-row', style: 'margin-top:12px' }, reply, h('span', null, `這是對${own.pendingBreakName ?? '那則通知'}的回應：修正論點，部位不動`)) : null,
      reply ? h('p', { class: 'small faint', style: 'margin:4px 0 0 1.8em' }, `${replyOpt.checked ? '' : '不是從那則通知進來，所以預設不勾：只是平常改論點就不用勾。'}勾著存檔：那則通知結案，論點記一次「失效後修改」。新的前提如果原封不動留著被判不成立的那一條，當成不同意：那條前提到下一季財報出來之前不再通知你；那一條的字改了就算修正論點，照常審查、照常通知。`) : null,
      h('div', { class: 'btn-row', style: 'margin-top:14px' }, save, h('a', { class: 'linkbtn', href: back.href }, '算了')),
      msg,
    ),
  );
  changed();

  return page({
    view: 'page',
    banner: {
      back,
      kicker: own.thesis ? `第 ${own.thesis.version} 版，${day(own.thesis.setAt)} 定` : '還沒有論點本文',
      title: `編輯論點：${d.ticker}`,
      sub: draft ? 'stock bot 的草稿回來了：在右邊先看反方的三點，還願意抱著就按「採用這份草稿」，整份照草稿存（出場條件採用後就生效）。不想用可以照舊貼上 claude.ai 討論的結果或手寫。' : '貼上 claude.ai 討論的結果、請 stock bot 草擬，或直接手寫。左邊是現在的、右邊是新的；確認之後論點與前提馬上存好，出場條件有改動才送 AI 對照與改寫。',
      bubble: draft ? { k: '草稿', say: ['先看', { t: '反方的三點', tone: 'em' }, '，還願意抱著再按「採用這份草稿」。'], mood: 'watch' } : { k: '編輯論點', say: ['左右對照看一遍再確認。', { t: '出場條件', tone: 'em' }, '改了的話，要你在持股頁確認才會換上新的。'], mood: 'watch' },
    },
    pane: formBox,
    rail: glass(
      'pad',
      h('h2', { class: 'panel-h' }, '怎麼用'),
      h('p', { class: 'small', style: 'margin-top:8px' }, h('b', null, '用 stock bot 的草稿')),
      h('ol', { class: 'small', style: 'margin:4px 0 0;display:grid;gap:6px' }, h('li', null, '1. 按「請 stock bot 草擬」，好了推 LINE。'), h('li', null, '2. 先看反方的三點，還願意抱著這檔就按「採用這份草稿」。'), h('li', null, '3. 現在有論點的話，會先列出哪幾條會被換掉，按「確定採用」；之後要改字在這一頁改。')),
      h('p', { class: 'small', style: 'margin-top:12px' }, h('b', null, '在 claude.ai 討論')),
      h('ol', { class: 'small', style: 'margin:4px 0 0;display:grid;gap:6px' }, h('li', null, '1. 按「複製討論包」，貼到 claude.ai 的新對話。'), h('li', null, '2. 和它討論；它會站在反方問你。'), h('li', null, '3. 說「收尾」，把輸出的區塊貼回這裡、按「解析」。'), h('li', null, '4. 看左右對照，需要的話改，按「確認」。')),
      h('p', { class: 'small faint', style: 'margin-top:10px' }, '討論包與草稿的證據包都只有比重，沒有金額與股數。「這次的結論」只顯示，不會自動下單。'),
    ),
  });
}

const norm = (t) => String(t).normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
/** 伺服器給的前提文字後面接著「（不成立的訊號：…）」給持股頁看；編輯時只要前提本身。 */
const baseText = (p) => String(p.text).replace(/（不成立的訊號：.*）$/, '');

// ---------------------------------------------------------------- 還沒有論點的自選（T40，own_thesis §1.8「存完之後的引導」）

/**
 * 一張清單：每一檔「NVDA 還沒有你的論點」，旁邊「請 stock bot 草擬」（T56）、「複製討論包」與「編輯論點」；有買進時的一句話就寫在下面。
 * rows：[{ ticker, buyNote }]；drafts：{ 代號: 草稿狀態 }（自動開的那一次在跑時寫「草稿準備中」；沒有是 {}）。
 */
export function thesisTodoList(rows, drafts = {}) {
  return h(
    'ul',
    { class: 'todo-thesis' },
    rows.map((r) =>
      h(
        'li',
        null,
        h(
          'div',
          { class: 'tt-main' },
          h('p', null, h('span', { class: 'tk' }, r.ticker), ' 還沒有你的論點'),
          // 賣光之後又買回、上次持有時有論點（T44）：討論包會附上上次的論點，從上次為什麼賣問起
          r.prev ? h('p', { class: 'small tt-prev' }, `上次持有時有論點（${day(r.prev.closedAt)}${r.prev.closedVerb}）：討論包會附上，請 claude.ai 從上次為什麼賣、這次為什麼買回問起；也可以在「編輯論點」帶入上次的論點。`) : null,
          r.buyNote ? h('p', { class: 'small dim' }, `買進時的一句話：「${r.buyNote.text}」`) : r.prev ? null : h('p', { class: 'small faint' }, '沒有寫買進時的一句話；討論包會請 claude.ai 先問你為什麼買。'),
        ),
        // 「請 stock bot 草擬」在前、「複製討論包」在後（T56，web_evidence_design §2.6）；自動開的那一次在跑時寫「草稿準備中」
        h('div', { class: 'tt-act' }, draftAction(r.ticker, drafts?.[r.ticker] ?? null, { compact: true, after: [copyPackButton(r.ticker), h('a', { class: 'btn', href: `#/h/${encodeURIComponent(r.ticker)}/thesis` }, '編輯論點')] })),
      ),
    ),
  );
}

/**
 * 回應頁的「新加進自選、還沒有論點」那一塊（快照結果頁；T45 起轉入、認養、清單外買進歸自選的回應頁也用）。
 * rows：[{ ticker, buyNote, prev? }]；沒有就回 null。drafts：這幾檔的草稿狀態（T56；回應的 newOwnDrafts）。
 */
export function newOwnBox(rows, lead = '新加進自選的', drafts = {}) {
  if (!rows?.length) return null;
  return glass(
    'pad new-own-box',
    h('h2', { class: 'panel-h' }, `${lead} ${rows.length} 檔還沒有你的論點`),
    h('p', { class: 'small dim', style: 'margin:4px 0 10px' }, '可以現在寫，也可以之後再做（帳戶頁會有入口）。不寫也不擋月報；目前用系統預設前提做一般健康檢查。'),
    thesisTodoList(rows, drafts),
  );
}

/** 「還沒有論點的自選」那一頁：建立帳戶完成後先到這裡；帳戶頁的入口也連到這裡。可以跳過、之後再做，也可以關掉。 */
export function thesisTodoPage(ctx) {
  const rows = ctx.state.thesisTodo ?? [];
  const after = { href: '#/account', label: '帳戶' };
  const dismiss = actionButton('關掉這張清單', 'quiet', async () => {
    try {
      await api.post('/ops/thesis-todo/dismiss', {});
      toast('關掉了；之後還是可以到各檔的持股頁寫論點');
      await ctx.refresh(false);
      ctx.go('#/account');
    } catch (e) {
      toast(e.message);
    }
  });
  const body = rows.length
    ? [
        h('p', null, '這些自選股還沒有你的論點，目前用系統預設前提做一般健康檢查。按「請 stock bot 草擬」讓 stock bot 先寫一份草稿（反方先寫），你在「編輯論點」看過反方再決定要不要採用；或按「複製討論包」貼到 claude.ai 討論，說「收尾」後把結果貼回「編輯論點」。'),
        h('p', { class: 'small dim', style: 'margin-top:6px' }, '不寫也可以：不擋上線，也不擋月報。買進時寫的那一句只當討論的開場，不是前提。'),
        h('div', { style: 'margin-top:14px' }, thesisTodoList(rows, ctx.state.drafts ?? {})),
        h('div', { class: 'btn-row', style: 'margin-top:16px' }, h('a', { class: 'btn primary', href: after.href }, '先跳過，之後再做'), dismiss),
        h('p', { class: 'small faint', style: 'margin-top:8px' }, '跳過的話，帳戶頁會一直有入口回到這裡，直到每一檔都有論點。關掉之後，現在這幾檔不再列；之後新加的自選還是會列。'),
      ]
    : [h('p', null, '每一檔自選都有你的論點了（或清單已經關掉）。'), h('div', { class: 'btn-row', style: 'margin-top:12px' }, h('a', { class: 'btn', href: after.href }, '回帳戶'))];
  return page({
    view: 'page',
    banner: {
      back: after,
      title: '還沒有論點的自選',
      sub: rows.length ? `${rows.length} 檔還沒有你的論點。可以現在寫，也可以之後再做。` : '沒有還沒寫論點的自選。',
      bubble: rows.length ? { k: '論點', say: [{ t: `${rows.length} 檔`, tone: 'em' }, '還沒有你的論點。可以請 stock bot 先草擬，或複製討論包到 claude.ai 聊聊為什麼持有它。'], mood: 'watch' } : { k: '論點', say: ['每一檔都有論點了。'], mood: 'happy' },
    },
    pane: glass('pad', body),
  });
}

// ---------------------------------------------------------------- 「請 stock bot 草擬」（T56，web_evidence_design §2.5、§2.6）

/**
 * 「請 stock bot 草擬」那一塊：持股頁、還沒有論點的清單、編輯論點頁、「要看的事」那一行共用。
 * state：伺服器給的草稿狀態（沒有 = 示範模式或月報裡的舊清單：只放按鈕，按了照伺服器的回應寫）。
 * 按了之後原地換成新的狀態（準備中）；開不成的寫原因與「再試一次」。按鈕連按只會送一次（actionButton 送出時先停用；伺服器也擋同一檔同時兩次）。
 * opt：primary 主要按鈕；compact 字小一點；link 用連結的樣子（「要看的事」那一行）；onEdit 在編輯論點頁（草稿好了不用再連過去）；
 *      before／after：和草擬的按鈕排在同一列的其他按鈕（持股頁的「編輯論點」「複製討論包」）。
 */
export function draftAction(ticker, state, opt = {}) {
  const box = h('div', { class: 'draft-act' + (opt.compact ? ' compact' : '') + (opt.link ? ' as-link' : '') });
  const edit = `#/h/${encodeURIComponent(ticker)}/thesis`;
  const draw = (st, err = null) => {
    const v = draftButtonState(st);
    const label = err ? (err.status === 503 ? '再試一次' : v.button) : v.button;
    const go = async () => {
      try {
        const r = await api.post('/ops/own-draft', { ticker });
        toast(`已經請 stock bot 草擬 ${ticker}：通常 10 分鐘左右，好了推 LINE`);
        draw(r.state ?? { ready: null, pending: { runId: r.runId, trigger: 'MANUAL', createdAt: new Date().toISOString() }, last: null, lastAt: null, nextAt: null, autoSoon: false, aiReady: true });
      } catch (e) {
        draw(st, e);
      }
    };
    const btn = label ? (opt.link ? linkBtn(label, go) : actionButton(label, opt.primary ? 'primary' : '', go)) : null;
    const see = v.mode === 'READY' && !opt.onEdit ? h('a', { class: opt.link ? 'linkbtn' : 'btn' + (opt.primary ? ' primary' : ''), href: edit }, '看草稿') : null;
    const tone = v.mode === 'FAILED' || v.mode === 'OFF' ? 'warn' : v.mode === 'READY' ? 'core' : 'dim';
    const row = [...(opt.before ?? []), see, btn, ...(opt.after ?? [])].filter(Boolean);
    // 「要看的事」那一行：準備中、要等幾天這些話只寫一句短的（完整的在持股頁論點那一塊）
    const linkNote = { PENDING: '草稿準備中', WAIT: st?.nextAt ? `${md(st.nextAt)} 之後可以再請 stock bot 草擬` : null, FAILED: v.text, OFF: v.text };
    const note = opt.link ? (linkNote[v.mode] ?? null) : v.text;
    put(box, row.length ? h(opt.link ? 'span' : 'div', { class: opt.link ? 'draft-link' : 'btn-row' }, row) : null, note ? h(opt.link ? 'span' : 'p', { class: `small tone-${tone}` }, note) : null, err ? errBox(err) : null);
  };
  draw(state);
  return box;
}

/** 連結樣子的按鈕（送出時先停用）。 */
function linkBtn(label, fn) {
  const b = h('button', { class: 'linkbtn', type: 'button' }, label);
  b.addEventListener('click', async () => {
    if (b.disabled) return;
    b.disabled = true;
    try {
      await fn();
    } finally {
      b.disabled = false;
    }
  });
  return b;
}

/**
 * 「要看的事」裡可以請 stock bot 草擬的那幾種（§2.5：論點滿一年、前提證據不足、連續沒有一致結論；T72 加減半中沒有出場條件、沒有論點）。
 * T72（confirm_audit_design §5）起這幾種會自動草擬；已經自動請了的那一行帶 drafted，不放連結。還沒自動開的（有還沒回覆的乙類、
 * 30 天內有前提被判不成立、7 天內已經草擬過）照舊可以自己按。
 */
export const DRAFT_ATTN = ['THESIS_OLD', 'PREMISE_NO_DATA', 'NO_CONSENSUS', 'HALF_NO_EXIT', 'NO_THESIS'];

/**
 * 「要看的事」那一行後面的動作（持股頁、月報頁）：草稿好了 → 「看草稿」；論點滿一年、前提證據不足、連續沒有一致結論 → 「請 stock bot 草擬」。
 * state：這檔的草稿狀態（持股頁有；月報頁是當時的清單，沒有）。
 */
export function attnDraftAction(x, state = null) {
  if ((x.src ?? 'own') !== 'own') return null;
  // 已經自動請 stock bot 草擬（T72）：那一行寫了「好了會列在這裡」，不用再按
  if (x.drafted) return null;
  if (x.kind === 'DRAFT_READY') return h('a', { class: 'linkbtn', href: `#/h/${encodeURIComponent(x.ticker)}/thesis` }, '看草稿');
  // 前提一直沒驗到（T60，composite §2.3）：改寫、配一個查得到的指標，或改標成信念，都在編輯論點頁做
  if (x.kind === 'PREMISE_UNVERIFIED') return h('a', { class: 'linkbtn', href: `#/h/${encodeURIComponent(x.ticker)}/thesis` }, '編輯論點');
  // 審查提到的前提以外的風險（T63，composite §3）：T71 起不再列「要看的事」；這一行只給舊的月報（當時存下的清單）用
  if (x.kind === 'NEW_RISK') return h('a', { class: 'linkbtn', href: `#/h/${encodeURIComponent(x.ticker)}/thesis` }, '看依據，決定要不要加');
  if (DRAFT_ATTN.includes(x.kind)) return draftAction(x.ticker, state, { link: true });
  return null;
}
