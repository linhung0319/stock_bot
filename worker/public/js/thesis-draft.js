// stock bot 的論點草稿（T56，web_evidence_design §2.3、§2.5、§2.6）：不碰 DOM 的部分（文字、預設不勾、按鈕狀態），測試直接 import。
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
  return `${md(t)} ${t.slice(11, 16)}`;
}

import { BELIEF_TEXT, VERIFY_TEXT, draftPremiseFields, verifyText } from './thesis-fields.js';

export const ACTION_TEXT = { EXIT: '出清', HALF: '減半', REVIEW: '重新審查' };
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
 * 草稿的每一項（前提、出場條件、同業、網站）：預設都不勾（§2.3：勾了才填進「新的」，沒勾的不存在）。
 * 網站只有「新的來源」可以勾；已經在清單裡、不列入的只顯示。
 * 前提（T60）：breaksIf 是句子的陣列、confirmsIf、verify（by = NONE 是信念 belief）；T55 的舊草稿照樣讀得出來。
 */
export function draftItems(payload) {
  const p = payload ?? {};
  return {
    premises: (p.premises ?? []).map((x, k) => {
      const f = draftPremiseFields(x);
      return { k, checked: false, text: x.text, ...f, belief: f.verify?.by === 'NONE', keepId: x.keep_id ?? null, checkable: f.verify?.by ?? null, sourceHint: f.verify?.source ?? null, likeBroken: !!x.like_broken, evidence: x.evidence_ids ?? [] };
    }),
    exits: (p.exits ?? []).map((x, k) => ({ k, checked: false, text: x.text, action: x.action, threshold: !!x.threshold, premiseIndex: x.premise_index ?? null, evidence: x.evidence_ids ?? [] })),
    peers: (p.sources?.peers ?? []).map((x, k) => ({ k, checked: false, name: x.name, edgar: x.edgar ?? null, yahoo: x.yahoo ?? null })),
    domains: (p.sources?.domains ?? []).map((x, k) => ({ k, checked: false, domain: x.domain, state: x.state, note: x.note, checkable: false })),
  };
}

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
    out.push({ tone: 'hot', text: `這份草稿不能沿用 ${draft.broken.premiseId}；用了這份草稿存檔，算一次「失效後修改」${draft.broken.open ? '。那則通知還等你決定：可以在下面勾「這是對通知的回應」，或回通知選一項' : ''}。` });
  }
  if (draft.stale) {
    out.push({ tone: 'warn', text: draft.basedOn ? `這份草稿是照第 ${draft.basedOn} 版論點寫的，之後你改過論點（現在第 ${draft.version} 版）。左邊「現在的」才是你現在的論點，勾之前對照一下。` : `這份草稿是在你還沒有論點的時候寫的，之後你自己存了論點（現在第 ${draft.version} 版）。勾之前對照左邊「現在的」。` });
  }
  out.push({ tone: 'dim', text: `${draft.trigger === 'AUTO' ? '新加進自選時自動草擬的' : `你在 ${md(draft.createdAt)} 請 stock bot 草擬的`}；${md(draft.until)} 之後不再列（30 天沒處理就過期）。每一條都要你勾了才會填進「新的」，沒勾的不會存。` });
  return out;
}

/** 草稿沒有提到的你現在的前提（草稿只沿用一字沒改的；其他的「新的」裡照舊留著，要拿掉自己拿）。 */
export function untouchedPremises(payload, current) {
  const kept = new Set((payload?.premises ?? []).map((p) => p.keep_id).filter(Boolean));
  return (current ?? []).filter((p) => !p.system && !kept.has(p.id)).map((p) => p.id);
}

/**
 * 預覽裡「草稿」那一段（存檔前；pd 是伺服器回的 preview.draft）：
 *   一條都沒用（忘了勾）→ 草稿照舊留著；用了一部分（只勾一半）→ 列出沒勾的幾條，存檔後草稿標成用過、不再列；
 *   這份草稿是在前提被判不成立之後寫的 → 算一次「失效後修改」（第幾次）。
 */
export function draftPreviewLines(pd) {
  if (!pd) return [];
  const out = [];
  if (!pd.used) {
    out.push({ tone: 'warn', text: `草稿一條都還沒勾：這次存檔不會用到草稿，草稿照舊留著，${md(pd.until ?? '')}${pd.until ? ' 之前' : ''}都可以回來勾。` });
    return out;
  }
  const parts = [];
  if (pd.thesis) parts.push(pd.thesis === 'SAME' ? '論點本文（一字沒改）' : '論點本文（改過字）');
  const pr = pd.premises;
  if (pr.same) parts.push(`前提 ${pr.same} 條原樣（記成「AI 草擬、你勾選的」）`);
  if (pr.edited) parts.push(`前提 ${pr.edited} 條改過字（記成你寫的）`);
  if (pr.kept) parts.push(`草稿沿用你現在的前提 ${pr.kept} 條`);
  if (pd.exits) parts.push(`出場條件 ${pd.exits} 條`);
  if (pd.peers) parts.push(`同業 ${pd.peers} 家`);
  if (pd.domains) parts.push(`網站 ${pd.domains} 個`);
  out.push({ tone: 'core', text: `從草稿用了：${parts.join('、')}。` });
  const un = pd.unused;
  const left = [un.premises ? `前提 ${un.premises} 條` : '', un.exits ? `出場條件 ${un.exits} 條` : '', un.sources ? `同業與網站 ${un.sources} 項` : ''].filter(Boolean);
  out.push({ tone: left.length ? 'warn' : 'dim', text: left.length ? `沒勾的：${left.join('、')}。存檔後這份草稿標成用過、不再列，沒勾的不會存；之後想要，要自己寫進來。` : '草稿的每一項都勾了。存檔後這份草稿標成用過。' });
  if (pd.afterBreakNo) out.push({ tone: 'hot', text: `這份草稿是在前提 ${pd.premiseId} 被判不成立之後寫的：存檔算一次「失效後修改」（第 ${pd.afterBreakNo} 次）${pd.brokenOpen ? '；那則通知仍要你決定（勾下面的「這是對通知的回應」，或回通知選一項）' : ''}。` });
  if (pd.status === 'EXPIRED') out.push({ tone: 'warn', text: '這份草稿已經過期（30 天沒處理，或之後有新的草稿）；存檔照樣用你勾的這些。' });
  if (pd.status === 'USED' || pd.status === 'DISMISSED') out.push({ tone: 'dim', text: `這份草稿已經${pd.status === 'USED' ? '用過' : '標成不用'}了（可能在另一個分頁）；存檔照樣用你勾的這些。` });
  return out;
}

/** 右邊那一條是從草稿勾來的：原樣 → 記成「AI 草擬、你勾選的」；改過字 → 記成你寫的。 */
export function originHint(draftText, text) {
  const n = (t) => String(t ?? '').normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
  return n(draftText) === n(text) ? '從草稿原樣勾來：存成「AI 草擬、你勾選的」' : '從草稿勾來、你改過字：存成你寫的前提';
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
  if (state.pending) return { mode: 'PENDING', button: null, text: `${state.pending.trigger === 'AUTO' ? '新加進自選，stock bot 正在自動草擬' : '草稿準備中'}（${hm(state.pending.createdAt)} 開始，通常 10 分鐘左右；好了${state.pending.trigger === 'AUTO' ? '會列在「要看的事」' : '推 LINE'}）` };
  if (!state.aiReady) return { mode: 'OFF', button: null, text: 'AI 層的雲端排程還沒設定，現在沒辦法草擬' };
  if (state.nextAt && Date.parse(state.nextAt) > now.getTime()) return { mode: 'WAIT', button: null, text: `${md(state.lastAt)} 已經草擬過一次（每檔 7 天一次），${md(state.nextAt)} 之後可以再按${state.last?.status === 'USED' ? '；那一份你已經用過' : state.last?.status === 'DISMISSED' ? '；那一份你標了不用' : state.last?.status === 'EXPIRED' ? '；那一份已經過期' : ''}` };
  if (state.last?.status === 'FAILED') return { mode: 'FAILED', button: '再試一次', text: `上次草擬沒有成功（${state.last.why ?? '原因不明'}）` };
  if (state.autoSoon) return { mode: 'AUTO', button: '現在就草擬', text: '下一次每日流程（台灣早上 7:30）會自動草擬一次，不用按；不想等可以現在按' };
  const tail = state.last?.status === 'EXPIRED' ? `上一份草稿（${md(state.last.createdAt)}）30 天沒處理，已經過期` : state.last?.status === 'USED' ? `上一份草稿（${md(state.last.createdAt)}）你已經用過` : state.last?.status === 'DISMISSED' ? `上一份草稿（${md(state.last.createdAt)}）你標了不用` : null;
  return { mode: 'ASK', button: '請 stock bot 草擬', text: tail };
}
