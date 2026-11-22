// stock bot 的論點草稿（T56，web_evidence_design §2.5、§2.6）：不碰 DOM 的部分（文字、按鈕狀態），測試直接 import。
// T70（confirm_audit_design §2）：逐條勾選改成一鍵採用——草稿那一塊只顯示，「採用這份草稿」整份照草稿存；採用前的對照與採用後的那幾行也在這裡。
// 畫面在 pages-thesis.js（編輯論點頁的草稿那一塊、各入口的「請 stock bot 草擬」）。

/** 2026-12-20 → 12/20；ISO 時間照台北時間的日期。 */
export function md(s) {
  if (!s) return '';
  const t = String(s);
  const d = t.includes('T') ? new Date(Date.parse(t) + 8 * 3600_000).toISOString() : t;
  return `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
}
/** ISO 時間 → 台北時間的 12/20 14:05（準備中那一行用）。 */
export function hm(iso) {
  const t = new Date(Date.parse(iso) + 8 * 3600_000).toISOString();
  // t 已經是台北時間：日期直接取前 10 碼（交給 md() 會再加 8 小時，台北下午 4 點以後會多一天）
  return `${md(t.slice(0, 10))} ${t.slice(11, 16)}`;
}

import { BELIEF_TEXT, VERIFY_TEXT, draftPremiseFields, verifyText } from './thesis-fields.js';

export const ACTION_TEXT = { EXIT: '出清', HALF: '減半', REVIEW: '重新審查', FILL: '買進（補到標準比重）', RAISE: '買進（提高到標準的 125%）' };
export const ANSWER_TEXT = { YES: '會買', NO: '不會買', UNSURE: '說不準' };
/** 前提查得到的來源（verify.by；T55 叫 checkable_by）→ 白話；NONE 是信念（T60）。 */
export const CHECK_TEXT = VERIFY_TEXT;
/**
 * T55 的寫法（紅字「stock bot 監測不了這一條」）。T60 起 NONE 是信念（composite_layer_design §2.3：「這一條查不到，是你選擇相信的」），
 * 畫面改寫 BELIEF_TEXT；這個字串留著給還沒指定來源的舊草稿。
 */
export const NOT_CHECKABLE = 'stock bot 監測不了這一條';
export { BELIEF_TEXT };

/**
 * 草稿的每一項（前提、出場條件、同業；T69 以前的舊草稿另外有網站）整理成畫面要的形狀。T70 起只顯示，沒有勾選框。
 * 前提（T60）：breaksIf 是句子的陣列、confirmsIf、verify（by = NONE 是信念 belief）；T55 的舊草稿照樣讀得出來。
 * 出場條件帶 kind、check（怎麼監測，exitMonitorText）。網站（舊草稿才有）不能加，只留給讀舊草稿。
 */
export function draftItems(payload) {
  const p = payload ?? {};
  return {
    premises: (p.premises ?? []).map((x, k) => {
      const f = draftPremiseFields(x);
      return { k, text: x.text, ...f, belief: f.verify?.by === 'NONE', keepId: x.keep_id ?? null, checkable: f.verify?.by ?? null, sourceHint: f.verify?.source ?? null, likeBroken: !!x.like_broken, evidence: x.evidence_ids ?? [] };
    }),
    exits: (p.exits ?? []).map((x, k) => ({ k, text: x.text, action: x.action, threshold: !!x.threshold, kind: x.kind ?? null, check: x.check ?? null, premiseIndex: x.premise_index ?? null, evidence: x.evidence_ids ?? [] })),
    // 加碼條件（T84，own_draft_v4；舊草稿沒有）：k 接在出場條件後面（和採用時的編號一致）
    adds: (p.adds ?? []).map((x, k) => ({ k: (p.exits ?? []).length + k, text: x.text, action: x.action, threshold: !!x.threshold, kind: x.kind ?? null, check: x.check ?? null, premiseIndex: x.premise_index ?? null, evidence: x.evidence_ids ?? [] })),
    peers: (p.sources?.peers ?? []).map((x, k) => ({ k, name: x.name, edgar: x.edgar ?? null, yahoo: x.yahoo ?? null })),
    domains: (p.sources?.domains ?? []).map((x, k) => ({ k, domain: x.domain, state: x.state, note: x.note, checkable: false })),
  };
}

/** 確認來源的白話（事件條件的 confirm_by）。 */
const CONFIRM_TEXT = { '8-K': '8-K', '10-Q': '10-Q', '10-K': '10-K', SEC: 'SEC 申報', earnings_call: '法說會', major_news: '重大新聞' };
const FILING_BY = ['8-K', '10-Q', '10-K', 'SEC'];

/**
 * 草稿的一條出場條件採用後怎麼監測（T70，§2.2：採用就生效，不再送改寫與確認）：
 *   財報門檻 → 新財報出來時程式比對；事件條件有申報類的確認來源 → 新申報出來時由 AI 確認；只有法說會、新聞、網頁 → 只在定期審查時檢查；
 *   價格條件 → 只記錄；舊格式（事件條件沒寫用什麼確認）→ 採用後送 AI 改寫，回來後在持股頁確認。tone：ok／warn／dim。
 */
export function exitMonitorText(x) {
  const by = Array.isArray(x?.check?.confirm_by) ? x.check.confirm_by : null;
  if (x?.kind === 'XBRL' && x.check) return { tone: 'ok', text: x.threshold ? '財報數字門檻：採用後新財報出來時由程式比對' : '財報條件：指標程式算不出來，採用後只記錄' };
  if (x?.kind === 'PRICE') return { tone: 'dim', text: '價格條件：採用後只記錄，不會通知' };
  if (x?.kind === 'EVENT' && by?.length) {
    const names = by.map((b) => (String(b).startsWith('web:') ? `${String(b).slice(4)} 的網頁` : (CONFIRM_TEXT[b] ?? b)));
    return by.some((b) => FILING_BY.includes(b)) ? { tone: 'ok', text: `採用後監測中：新申報出來時由 AI 確認（${names.join('、')}）` } : { tone: 'ok', text: `採用後只在定期審查時檢查（${names.join('、')}）` };
  }
  return { tone: 'warn', text: '舊格式的草稿沒有寫用什麼確認：採用後這一條送 AI 改寫，回來後在持股頁確認才開始監測' };
}

/** 按鈕旁那一行（§2.1：不需要專業知識，只問意願）。 */
export const ADOPT_HINT = '採用之前看一眼最上面的反方三點：還願意抱著這檔嗎？';
/** 採用後持股頁那一行（§2.1）。 */
export const adoptedNote = (at) => `已採用 ${md(at)} 的草稿；要改字在這一頁改`;

/**
 * 一條前提「怎麼驗證」：{ ok, text, belief }。查得到 → 來源與多久有新的一份；信念（T60）→「信念：這一條查不到，是你選擇相信的」
 * （不是錯，是使用者可以選的路，畫面用提醒的顏色）；沒有指定來源的（只有很舊的草稿）→ 紅字「stock bot 監測不了這一條」。
 */
export function checkLine(item) {
  if (item.verify?.by === 'NONE') return { ok: true, belief: true, text: BELIEF_TEXT };
  const t = verifyText(item.verify);
  if (!t) return { ok: false, belief: false, text: NOT_CHECKABLE };
  return { ok: true, belief: false, text: t };
}

/**
 * 草稿最上面的提示（tone：hot 紅、warn 黃、dim 灰）：
 *   開的時候有還沒回覆的乙類通知 → 固定的那句話（§2.4 第 6 點）＋不能沿用那一條、存檔算一次「失效後修改」；
 *   照的論點版本和現在不同 → 「這份草稿是照第 N 版寫的，之後你改過論點」（§2.3）；
 *   哪天之後不再列、誰開的。
 */
export function draftNotices(draft) {
  const out = [];
  if (draft.broken) {
    out.push({ tone: 'hot', text: `${draft.broken.notice}。` });
    out.push({ tone: 'hot', text: `這份草稿不能沿用 ${draft.broken.premiseId}；採用這份草稿算一次「失效後修改」${draft.broken.open ? '。那則通知還等你決定：可以先勾下面的「這是對通知的回應」再採用，或回通知選一項' : ''}。` });
  }
  if (draft.stale) {
    out.push({ tone: 'warn', text: draft.basedOn ? `這份草稿是照第 ${draft.basedOn} 版論點寫的，之後你改過論點（現在第 ${draft.version} 版）。左邊「現在的」才是你現在的論點；按「採用」之後會先列出哪幾條會被換掉。` : `這份草稿是在你還沒有論點的時候寫的，之後你自己存了論點（現在第 ${draft.version} 版）。按「採用」之後會先列出哪幾條會被換掉。` });
  }
  out.push({ tone: 'dim', text: `${draft.trigger === 'AUTO' ? '新加進自選時自動草擬的' : `你在 ${md(draft.createdAt)} 請 stock bot 草擬的`}；${md(draft.until)} 之後不再列（30 天沒處理就過期）。採用就是整份照草稿存（論點、前提、出場條件、同業），出場條件採用後直接生效；之後要改字，在這一頁照平常的方式改。` });
  return out;
}

const ACT = ACTION_TEXT;
const STATUS_TEXT = { ACTIVE: '監測中', REVIEW_ONLY: '只在定期審查時檢查', MANUAL: '只記錄' };
const peerText = (p) => `${p.name}（${[p.edgar && `EDGAR ${p.edgar}`, p.yahoo && `Yahoo ${p.yahoo}`].filter(Boolean).join('、')}）`;

/**
 * 採用前的對照（§2.1：現有論點和草稿不同時；pv 是伺服器 dry 回的 preview）。回傳一段一段：{ h: 標題, rows: [{ tone, text }] }。
 * 前提：哪幾條會被換掉（撤下）、沿用哪幾條（編號不變）、新的幾條；出場條件：新增（採用後就監測）、沿用、撤下、送改寫的；同業；失效後修改。
 */
export function adoptCompare(pv) {
  const dr = pv?.draft;
  if (!dr) return [];
  const out = [];
  const mine = (pv.retired ?? []).filter((x) => x.origin !== 'SYSTEM_DEFAULT');
  const sys = (pv.retired ?? []).filter((x) => x.origin === 'SYSTEM_DEFAULT');
  const prem = [
    ...(dr.thesisBefore ? [{ tone: 'warn', text: '論點本文：換成草稿的那一段（現在的那段不留）' }] : []),
    ...mine.map((x) => ({ tone: 'hot', text: `換掉 ${x.id}：${x.text}` })),
    ...(sys.length ? [{ tone: 'dim', text: `系統預設的 ${sys.length} 條前提換成草稿的` }] : []),
    ...(pv.kept ?? []).map((x) => ({ tone: 'core', text: `沿用 ${x.id}：${x.text}（編號不變，之前的檢查結果接著算）` })),
    ...(pv.added ?? []).map((x) => ({ tone: 'dim', text: `新的 ${x.id}：${x.text}` })),
  ];
  out.push({ h: '論點與前提', rows: prem });
  const ep = dr.exitPlan ?? { add: [], keep: [], retire: [], rewrite: [] };
  const ex = [
    ...ep.retire.map((x) => ({ tone: 'hot', text: `撤下：${x.text}` })),
    ...ep.keep.map((x) => ({ tone: 'core', text: `沿用：${x.text}${x.was && x.was !== x.action ? `（成立時 ${ACT[x.was]} → ${ACT[x.action]}）` : ''}` })),
    ...ep.add.map((x) => ({ tone: 'dim', text: `新增：${x.text}（成立時${ACT[x.action] ?? x.action}；採用後${STATUS_TEXT[x.status] ?? x.status}）` })),
    ...ep.rewrite.map((x) => ({ tone: 'warn', text: `送 AI 改寫、回來後在持股頁確認：${x.text}（${x.why}）` })),
  ];
  // 加碼條件（T84）和出場條件同一張表、一起整組取代：有加碼條件時標題寫兩種
  const hasAdd = [...ep.add, ...ep.keep, ...ep.rewrite].some((x) => x.action === 'FILL' || x.action === 'RAISE');
  if (ex.length) out.push({ h: hasAdd ? '出場條件與加碼條件' : '出場條件', rows: ex });
  const pp = dr.peerPlan ?? { save: [], skip: [], before: [] };
  const key = (p) => `${p.edgar ?? ''}|${p.yahoo ?? ''}`;
  const now = new Set(pp.save.map(key));
  const peers = [
    ...pp.before.filter((p) => !now.has(key(p))).map((p) => ({ tone: 'hot', text: `拿掉：${peerText(p)}` })),
    ...pp.save.map((p) => ({ tone: 'dim', text: `${pp.before.some((b) => key(b) === key(p)) ? '沿用' : '加上'}：${peerText(p)}` })),
    ...pp.skip.map((t) => ({ tone: 'warn', text: t })),
  ];
  if (peers.length) out.push({ h: '同業', rows: peers });
  if (dr.afterBreakNo) out.push({ h: '另外', rows: [{ tone: 'hot', text: `這份草稿是在前提 ${dr.premiseId} 被判不成立之後寫的：採用算一次「失效後修改」（第 ${dr.afterBreakNo} 次）${dr.brokenOpen ? '；那則通知仍要你決定（勾下面的「這是對通知的回應」，或回通知選一項）' : ''}。` }] });
  return out;
}

/** 採用之後持股頁那一塊的幾行（r 是伺服器的回應；at 是草稿回來的時間）：那一行、出場條件與同業、同業沒存的原因、送改寫的、寫條件失敗、失效後修改、通知結案。 */
export function adoptResultLines(r, at) {
  const dr = r?.preview?.draft;
  const out = [{ tone: 'core', text: adoptedNote(at) }];
  const bits = [];
  if (dr?.exits) bits.push(`出場條件 ${dr.exits} 條採用後就生效`);
  if (dr?.exitsKept) bits.push(`${dr.exitsKept} 條和原本的一樣，沿用`);
  if (r?.conds?.retired?.length) bits.push(`撤下原本的 ${r.conds.retired.length} 條`);
  if (dr?.peers) bits.push(`同業 ${dr.peers} 家`);
  if (bits.length) out.push({ tone: 'dim', text: `${bits.join('；')}。` });
  if (r?.rewrite?.status === 'SENT') out.push({ tone: 'warn', text: `${r.exits.length} 條舊格式的出場條件送去 AI 改寫，回來後在這一頁確認才開始監測。` });
  if (r?.rewrite?.status === 'FAILED') out.push({ tone: 'warn', text: `${r.exits.length} 條舊格式的出場條件還沒送去改寫（${r.rewrite.error}）：在這一頁的出場條件那一塊可以重送。` });
  for (const t of r?.peersSkipped ?? []) out.push({ tone: 'warn', text: t });
  for (const t of r?.conds?.errors ?? []) out.push({ tone: 'hot', text: t });
  if (dr?.afterBreakNo) out.push({ tone: 'hot', text: `這次算一次「失效後修改」（第 ${dr.afterBreakNo} 次）。` });
  if (r?.revised) out.push({ tone: 'dim', text: `${r.revisedName ?? '那則通知'}已結案（修正論點，部位不動）。` });
  return out;
}

/**
 * 「請 stock bot 草擬」那一塊要顯示什麼（各入口共用；state 是伺服器的草稿狀態，沒有是 null＝示範模式或清單裡沒帶）。
 * mode：
 *   READY   草稿好了（連到編輯論點頁）
 *   PENDING 準備中（不給按）
 *   WAIT    7 天內草擬過（寫哪天之後可以再按）
 *   FAILED  上次沒有成功（寫原因；可以再試一次）
 *   AUTO    新的自選、下一次每日流程會自動草擬（還是可以現在按）
 *   OFF     雲端排程還沒設定（按了也開不成）
 *   ASK     可以按
 * button：按鈕上的字（沒有按鈕是 null）；text：旁邊的一句話。
 */
export function draftButtonState(state, now = new Date()) {
  if (!state) return { mode: 'ASK', button: '請 stock bot 草擬', text: null };
  if (state.ready) return { mode: 'READY', button: null, text: `草稿好了（${md(state.ready.at)}），${md(state.ready.until)} 之後不再列` };
  if (state.pending) return { mode: 'PENDING', button: null, text: `${state.pending.trigger === 'AUTO' ? (state.pending.attn ? '為了「要看的事」裡列的事，stock bot 正在自動草擬' : '新加進自選，stock bot 正在自動草擬') : '草稿準備中'}（${hm(state.pending.createdAt)} 開始，通常 10 分鐘左右；好了${state.pending.trigger === 'AUTO' ? '會列在「要看的事」' : '推 LINE'}）` };
  if (!state.aiReady) return { mode: 'OFF', button: null, text: 'AI 層的雲端排程還沒設定，現在沒辦法草擬' };
  if (state.nextAt && Date.parse(state.nextAt) > now.getTime()) return { mode: 'WAIT', button: null, text: `${md(state.lastAt)} 已經草擬過一次（每檔 7 天一次），${md(state.nextAt)} 之後可以再按${state.last?.status === 'USED' ? '；那一份你已經用過' : state.last?.status === 'DISMISSED' ? '；那一份你標了不用' : state.last?.status === 'EXPIRED' ? '；那一份已經過期' : ''}` };
  if (state.last?.status === 'FAILED') return { mode: 'FAILED', button: '再試一次', text: `上次草擬沒有成功（${state.last.why ?? '原因不明'}）` };
  if (state.autoSoon) return { mode: 'AUTO', button: '現在就草擬', text: '下一次每日流程（台灣早上 7:30）會自動草擬一次，不用按；不想等可以現在按' };
  const tail = state.last?.status === 'EXPIRED' ? `上一份草稿（${md(state.last.createdAt)}）30 天沒處理，已經過期` : state.last?.status === 'USED' ? `上一份草稿（${md(state.last.createdAt)}）你已經用過` : state.last?.status === 'DISMISSED' ? `上一份草稿（${md(state.last.createdAt)}）你標了不用` : null;
  return { mode: 'ASK', button: '請 stock bot 草擬', text: tail };
}
