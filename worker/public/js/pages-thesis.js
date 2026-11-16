// 論點（T27，own_thesis §1.7、§1.8）：「複製討論包」與「編輯論點」頁。
// 論點在 claude.ai 討論；這裡只做頭（複製討論包）和尾（貼回 → 預覽 → 確認 → 出場條件送去改寫）。只求能用，版面在 T34 整理。
import { api } from './api.js';
import { day, h, put, toast } from './dom.js';
import { glass, page } from './layout.js';
import { unsentBox } from './pages-ai.js';
import { actionButton, errBox } from './pages-notif.js';
import { say } from './slime.js';
import { replyOption } from './thesis-reply.js';

const ACTIONS = [
  ['EXIT', '出清'],
  ['HALF', '減半'],
  ['REVIEW', '重新審查'],
];
const LIMITS = { thesis: 600, premises: 5, premise: 200, exits: 6, exit: 300 };

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
const removeBtn = (fn) => h('button', { class: 'btn quiet', type: 'button', 'aria-label': '拿掉這一條', onclick: fn }, '拿掉');
const counter = (el, max) => {
  const c = h('small', { class: 'faint' });
  const upd = () => (c.textContent = `${el.value.length}／${max} 字`);
  el.addEventListener('input', upd);
  upd();
  return c;
};

export async function thesisEditPage(ctx, ticker, notifParam) {
  const d = await api.get('/holding/' + encodeURIComponent(ticker));
  const back = { href: `#/h/${encodeURIComponent(d.ticker)}`, label: d.ticker };
  if (!d.own) return page({ view: 'page', banner: { back, title: '編輯論點', sub: `${d.ticker} 不是自選股，沒有論點可以編輯。`, bubble: { k: '編輯論點', say: ['只有自選股有論點。'], mood: 'idle' } }, pane: h('a', { class: 'btn', href: back.href }, '回持股頁') });
  const own = d.own;
  const notif = notifParam ?? own.pendingBreak?.notif ?? null;
  // 「這是對通知 #N 的回應」只給還沒回覆的乙類（own_thesis §1.10）；慢規則通知不能用修正論點結案（§3.4）
  // 只有從那則通知進來才預設勾著；從持股頁直接進來顯示但不勾（own_thesis §1.8，T39b）
  const replyOpt = replyOption(notifParam, own.pendingBreak?.notif ?? null);
  const replyNotif = replyOpt?.notif ?? null;
  const owned = (d.monitor ?? []).filter((c) => c.owned && c.code !== 'RETIRED');
  let source = 'TYPED';

  // ---- 右邊：新的（三欄都可以手改）
  const thesisIn = h('textarea', { rows: 6, maxlength: LIMITS.thesis, placeholder: '我為什麼持有它（一段，300 字以內最好）' });
  thesisIn.value = own.thesis?.text ?? '';
  const premList = h('div');
  const exitList = h('div');
  const prems = [];
  const exits = [];
  const addPrem = (p = { id: null, text: '' }) => {
    if (prems.length >= LIMITS.premises) return toast(`前提最多 ${LIMITS.premises} 條`);
    // 多行：長的前提也看得到全文（T39a：單行輸入框會把後半截掉）；Enter 不換行，前提是一句話
    const input = h('textarea', { class: 'prem-in', rows: 2, maxlength: LIMITS.premise, value: p.text, placeholder: '要繼續成立的事', 'aria-label': '前提' });
    input.addEventListener('keydown', (ev) => ev.key === 'Enter' && ev.preventDefault());
    const r = { id: p.id, input };
    const el = h('div', { style: rowStyle }, input, removeBtn(() => { prems.splice(prems.indexOf(r), 1); el.remove(); changed(); }));
    r.el = el;
    input.addEventListener('input', changed);
    prems.push(r);
    premList.append(el);
  };
  const addExit = (x = { text: '', action: 'REVIEW' }) => {
    if (exits.length >= LIMITS.exits) return toast(`出場條件最多 ${LIMITS.exits} 條`);
    const input = h('input', { type: 'text', maxlength: LIMITS.exit, value: x.text, placeholder: '查得到的事，例如：毛利率連兩季低於 70%', 'aria-label': '出場條件' });
    const sel = h('select', { style: 'width:auto', 'aria-label': '成立時' }, ACTIONS.map(([v, t]) => h('option', { value: v, selected: v === x.action }, t)));
    // ref：貼回的 [C12]（T40）：沿用的條件編號；存檔時程式再和監測中的條件對一次
    const r = { input, sel, guessed: !!x.guessed, ref: x.ref ?? null };
    input.addEventListener('input', changed);
    sel.addEventListener('change', changed);
    const el = h(
      'div',
      { class: 'exit-row' },
      h('div', { style: rowStyle.replace('margin-top:8px', 'margin-top:0') }, input, removeBtn(() => { exits.splice(exits.indexOf(r), 1); el.remove(); changed(); })),
      h('div', { class: 'btn-row cond-ctl' }, h('span', { class: 'small' }, '成立時'), sel, x.guessed ? h('span', { class: 'chip warn' }, '動作沒寫或不認得，先當成重新審查') : null),
    );
    exits.push(r);
    exitList.append(el);
  };
  const fill = (p) => {
    thesisIn.value = p.thesis;
    thesisIn.dispatchEvent(new Event('input'));
    prems.splice(0).forEach((r) => r.el.remove());
    exits.splice(0);
    exitList.replaceChildren();
    // 貼回的 [P2]（T40）是現行的一條 → 帶那個編號；沒寫編號、文字和現行的相同 → 帶上原本的編號（存檔時程式會再對一次）
    p.premises.forEach((t, k) => {
      const tag = p.premiseIds?.[k];
      const byTag = tag ? own.premises.find((x) => !x.system && x.id === tag) : null;
      addPrem({ id: byTag?.id ?? own.premises.find((x) => !x.system && norm(x.text) === norm(t))?.id ?? null, text: t });
    });
    if (!p.premises.length) addPrem();
    for (const x of p.exits) addExit(x);
    if (!p.exits.length) addExit();
    changed();
  };
  if (own.kind === 'THESIS') for (const p of own.premises) addPrem({ id: p.id, text: p.text.replace(/（不成立的訊號：.*）$/, '') });
  if (!prems.length) addPrem();
  addExit();

  // ---- 貼上
  const paste = h('textarea', { rows: 5, placeholder: '把 claude.ai 收尾時輸出的整個區塊貼在這裡（===STOCKBOT 論點 v2 … 到 ===END===）' });
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
  // 這次沒出現的監測中條件：選了「撤下」的編號（T40；預設繼續監測）
  const retireSel = new Set();
  let lastMissing = [];
  const payload = () => ({
    ticker: d.ticker,
    thesis: thesisIn.value.trim(),
    premises: prems.map((r) => ({ id: r.id, text: r.input.value.trim() })).filter((p) => p.text),
    exitConditions: exits.map((r) => ({ text: r.input.value.trim(), action: r.sel.value, ...(r.ref ? { ref: r.ref } : {}) })).filter((x) => x.text),
    retire: lastMissing.filter((c) => retireSel.has(c.id)).map((c) => c.id),
    source,
    replyTo: reply && reply.checked ? replyNotif : null,
  });
  /** 沿用編號、但字改了（T40）：左邊舊的、右邊新的；「當成新的一條」取消對應（這一條發新編號，舊的撤下）。 */
  const editedList = (xs) =>
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
          h('p', { class: 'faint', style: 'margin-top:4px' }, `沿用編號：之前的檢查結果與靜默期接著算。字改了也算論點變動，隔天會開一次審查。意思已經不同的，按「當成新的一條」。`),
        )
      : null;
  /** 出場條件的對照（T40）：沿用的不再送去改寫；這次沒出現的監測中條件，每一條選繼續監測或撤下。 */
  const exitPreview = (x) => {
    if (!x) return null;
    const rows = exits.map((r) => r.input.value.trim()).filter(Boolean);
    const kept = x.kept.map((k) => h('li', null, h('span', { class: 'st' }, `C${k.id}`), h('span', null, `${k.text}${k.actionChanged ? `（成立時改成${ACTIONS.find(([v]) => v === payload().exitConditions[k.index]?.action)?.[1] ?? ''}）` : ''}`)));
    const missing = x.missing.map((c) => {
      const name = `exit-${c.id}`;
      const keep = h('input', { type: 'radio', name, checked: !retireSel.has(c.id), onchange: () => { retireSel.delete(c.id); } });
      const drop = h('input', { type: 'radio', name, checked: retireSel.has(c.id), onchange: () => { retireSel.add(c.id); } });
      return h('li', null, h('div', null, h('p', null, h('span', { class: 'st' }, `C${c.id}`), ' ', c.text), h('p', { class: 'faint' }, `${c.status}${c.action ? `；成立時${ACTIONS.find(([v]) => v === c.action)?.[1] ?? ''}` : ''}`), h('div', { class: 'exit-pick' }, h('label', null, keep, '繼續監測'), h('label', null, drop, '撤下'))));
    });
    if (!rows.length && !missing.length) return null;
    return [
      h('b', null, '出場條件的對照'),
      kept.length ? h('div', { style: 'margin-top:6px' }, h('b', null, '沿用（不用再改寫）：'), h('ul', { class: 'diff-list' }, kept)) : null,
      x.fresh.length ? h('div', { style: 'margin-top:6px' }, `新的 ${x.fresh.length} 條：存檔後送 AI 改寫，回來後在持股頁勾選才開始監測。`) : null,
      missing.length
        ? h('div', { style: 'margin-top:8px' }, h('b', { style: 'color:var(--warn)' }, '目前監測中、這次沒有出現的：'), h('ul', { class: 'edit-cmp' }, missing), h('p', { class: 'faint', style: 'margin-top:4px' }, '預設繼續監測（不會因為這次沒抄到就撤下）。改了門檻的話，舊的選「撤下」，或等新的那一條改寫回來、勾選時取代它。'))
        : null,
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
        const line = (label, xs, warn) => (xs.length ? h('div', { style: 'margin-top:6px' }, h('b', { style: warn ? 'color:var(--hot)' : null }, label), h('ul', { class: 'diff-list' }, xs.map((x) => h('li', null, h('span', { class: 'st' }, x.id), h('span', null, x.text))))) : null);
        const edited = p.edited ?? [];
        lastMissing = p.exits?.missing ?? [];
        put(
          diff,
          h('b', null, '存檔後的前提'),
          line('沿用：', p.kept.filter((x) => !edited.some((e) => e.id === x.id)), false),
          editedList(edited),
          line('新的：', p.added, false),
          line('會撤下：', p.retired.map((x) => ({ ...x, text: x.origin === 'SYSTEM_DEFAULT' ? `${x.text}（系統預設）` : x.text })), true),
          h('div', { class: 'faint', style: 'margin-top:4px' }, p.changed ? '前提有增減或字改了：隔天的每日流程會開一次審查，檢查每條前提（每檔 30 天最多 1 次）。' : '前提沒有增減：不另外開審查。'),
          keptWarn(p),
        );
        put(exitDiff, exitPreview(p.exits));
      } catch (e) {
        diff.replaceChildren(errBox(e));
      }
    }, 350);
  }
  thesisIn.addEventListener('input', changed);

  const reply = replyOpt ? h('input', { type: 'checkbox', checked: replyOpt.checked, onchange: () => changed() }) : null;
  // 勾著回應、新的前提還留著被判不成立的那一條 → 存檔後當成不同意（own_thesis §1.10），先講清楚
  function keptWarn(p) {
    const pid = own.pendingBreak?.premiseId;
    if (!reply || !reply.checked || !pid || !p.kept.some((x) => x.id === pid)) return null;
    return h('div', { style: 'margin-top:6px;color:var(--hot)' }, `新的前提還留著被判不成立的 ${pid}：存檔後當成「不同意」，${pid} 進靜默期（到下一季財報出來、最長 100 天，不再因為它通知你）。想換掉它，就在右邊拿掉或寫成新的一條。`);
  }
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
            r.preview.changed ? h('p', { class: 'small dim', style: 'margin-top:6px' }, '前提有增減：隔天的每日流程會開一次審查。') : null,
            r.revised ? h('p', { class: 'small dim', style: 'margin-top:6px' }, `${r.revisedName ?? '那則通知'}已結案（修正論點，部位不動）${r.revised.kept ? `；新的論點還留著前提 ${r.revised.premiseId}，當成不同意，這條前提進靜默期` : ''}。`) : null,
            unsentBox(d.ticker, r.exits, `原因：${r.rewrite.error}`, () => ctx.go(back.href)),
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
      const rv = r.revised ? `；${r.revisedName ?? '那則通知'}結案（修正論點${r.revised.kept ? `，保留的前提 ${r.revised.premiseId} 進靜默期` : ''}）` : '';
      const cd = r.conds?.retired?.length ? `；撤下 ${r.conds.retired.length} 條出場條件` : '';
      toast([(r.rewrite.status === 'SENT' ? '論點已存；出場條件送去改寫，回來後在持股頁勾選' : '論點已存') + rv + cd, ...(r.conds?.errors ?? [])].join('；'));
      ctx.go(back.href);
    } catch (e) {
      msg.replaceChildren(errBox(e));
    }
  });

  const current = glass(
    'pad',
    h('h2', { class: 'panel-h' }, '現在的'),
    h('h5', { style: 'margin-top:10px' }, '論點'),
    own.thesis ? h('p', { class: 'small', style: 'white-space:pre-wrap;margin-top:4px' }, own.thesis.text) : h('p', { class: 'small faint', style: 'margin-top:4px' }, '還沒有'),
    h('h5', { style: 'margin-top:12px' }, own.kind === 'DEFAULT_ONLY' ? '前提（系統預設）' : '前提'),
    h('ul', { class: 'prem' }, own.premises.map((p) => h('li', null, h('span', { class: 'st' }, p.id), h('span', { class: 'small' }, p.text)))),
    h('h5', { style: 'margin-top:12px' }, '你定的條件'),
    owned.length ? h('ul', { class: 'small', style: 'margin:6px 0 0 1.2em' }, owned.map((c) => h('li', null, `${c.text} → ${c.actionText ?? '只記錄'}（${c.status}）`))) : h('p', { class: 'small faint', style: 'margin-top:4px' }, '還沒有'),
  );
  const next = glass(
    'pad',
    h('h2', { class: 'panel-h' }, '新的（可以直接改）'),
    h('label', { class: 'field', style: 'margin-top:10px' }, h('span', null, '論點'), thesisIn, counter(thesisIn, LIMITS.thesis)),
    h('div', { class: 'field' }, h('span', null, `前提（最多 ${LIMITS.premises} 條）`), own.kind === 'DEFAULT_ONLY' ? h('small', null, '目前用系統預設前提。寫了自己的前提，存檔時就取代預設。') : h('small', null, '和現在的文字相同的沿用原本的編號；拿掉的會撤下。'), premList, h('div', null, h('button', { class: 'linkbtn', type: 'button', onclick: () => { addPrem(); changed(); } }, '再加一條前提'))),
    h('div', { class: 'field', style: 'margin-bottom:0' }, h('span', null, `出場條件（最多 ${LIMITS.exits} 條）`), h('small', null, '不會存成前提。存檔後送 AI 改寫成查得到的格式，你在持股頁勾選才開始監測。'), exitList, h('div', null, h('button', { class: 'linkbtn', type: 'button', onclick: () => addExit() }, '再加一條出場條件'))),
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
    h('div', { class: 'thesis-cmp' }, current, next),
    glass(
      'pad',
      diff,
      exitDiff,
      reply ? h('label', { class: 'check-row', style: 'margin-top:12px' }, reply, h('span', null, `這是對${own.pendingBreakName ?? '那則通知'}的回應：修正論點，部位不動`)) : null,
      reply ? h('p', { class: 'small faint', style: 'margin:4px 0 0 1.8em' }, `${replyOpt.checked ? '' : '不是從那則通知進來，所以預設不勾：只是平常改論點就不用勾。'}勾著存檔：那則通知結案，論點記一次「失效後修改」。新的前提如果還留著被判不成立的那一條，當成不同意：那條前提到下一季財報出來之前不再通知你。`) : null,
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
      sub: '貼上 claude.ai 討論的結果，或直接手寫。左邊是現在的、右邊是新的；確認之後論點與前提馬上存好，出場條件送去改寫。',
      bubble: { k: '編輯論點', say: ['左右對照看一遍再確認。', { t: '出場條件', tone: 'em' }, '要你在持股頁勾選才會開始監測。'], mood: 'watch' },
    },
    pane: formBox,
    rail: glass(
      'pad',
      h('h2', { class: 'panel-h' }, '怎麼用'),
      h('ol', { class: 'small', style: 'margin:8px 0 0;display:grid;gap:6px' }, h('li', null, '1. 按「複製討論包」，貼到 claude.ai 的新對話。'), h('li', null, '2. 和它討論；它會站在反方問你。'), h('li', null, '3. 說「收尾」，把輸出的區塊貼回這裡、按「解析」。'), h('li', null, '4. 看左右對照，需要的話改，按「確認」。')),
      h('p', { class: 'small faint', style: 'margin-top:10px' }, '討論包只有比重，沒有金額與股數。「這次的結論」只顯示，不會自動下單。'),
    ),
  });
}

const norm = (t) => String(t).normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();

// ---------------------------------------------------------------- 還沒有論點的自選（T40，own_thesis §1.8「存完之後的引導」）

/**
 * 一張清單：每一檔「NVDA 還沒有你的論點」，旁邊「複製討論包」與「編輯論點」；有買進時的一句話就寫在下面。
 * rows：[{ ticker, buyNote }]。
 */
export function thesisTodoList(rows) {
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
          r.buyNote ? h('p', { class: 'small dim' }, `買進時的一句話：「${r.buyNote.text}」`) : h('p', { class: 'small faint' }, '沒有寫買進時的一句話；討論包會請 claude.ai 先問你為什麼買。'),
        ),
        h('div', { class: 'btn-row tt-act' }, copyPackButton(r.ticker), h('a', { class: 'btn', href: `#/h/${encodeURIComponent(r.ticker)}/thesis` }, '編輯論點')),
      ),
    ),
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
        h('p', null, '這些自選股還沒有你的論點，目前用系統預設前提做一般健康檢查。按「複製討論包」貼到 claude.ai 討論，說「收尾」後把結果貼回「編輯論點」。'),
        h('p', { class: 'small dim', style: 'margin-top:6px' }, '不寫也可以：不擋上線，也不擋月報。買進時寫的那一句只當討論的開場，不是前提。'),
        h('div', { style: 'margin-top:14px' }, thesisTodoList(rows)),
        h('div', { class: 'btn-row', style: 'margin-top:16px' }, h('a', { class: 'btn primary', href: after.href }, '先跳過，之後再做'), dismiss),
        h('p', { class: 'small faint', style: 'margin-top:8px' }, '跳過的話，帳戶頁會一直有入口回到這裡，直到每一檔都有論點；「關掉這張清單」就不再出現。'),
      ]
    : [h('p', null, '每一檔自選都有你的論點了（或清單已經關掉）。'), h('div', { class: 'btn-row', style: 'margin-top:12px' }, h('a', { class: 'btn', href: after.href }, '回帳戶'))];
  return page({
    view: 'page',
    banner: {
      back: after,
      title: '還沒有論點的自選',
      sub: rows.length ? `${rows.length} 檔還沒有你的論點。可以現在寫，也可以之後再做。` : '沒有還沒寫論點的自選。',
      bubble: rows.length ? { k: '論點', say: [{ t: `${rows.length} 檔`, tone: 'em' }, '還沒有你的論點。先複製討論包，到 claude.ai 聊聊為什麼持有它。'], mood: 'watch' } : { k: '論點', say: ['每一檔都有論點了。'], mood: 'happy' },
    },
    pane: glass('pad', body),
  });
}
