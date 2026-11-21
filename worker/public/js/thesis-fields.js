// 前提的新欄位（T60，composite_layer_design §2.2、§2.3）：怎樣算證實、怎樣算不成立（最多 3 句）、怎麼驗證（來源、多久有新的一份）、信念。
// 不碰 DOM 的部分（白話、收合時的一句、預覽的提醒、草稿的一條轉成右邊的欄位），測試直接 import；畫面在 pages-thesis.js、pages-holding.js。

/** 用什麼查 → 白話（NONE 是信念，另外寫）。 */
export const VERIFY_TEXT = { XBRL: '財報數字（程式比對）', FILING: '這家公司的申報原文', PEER_FILING: '同業的申報', WEB: '清單內的網站', NONE: null };
/** 編輯論點頁的選單（第一項 = 不指定：照舊進審查）。 */
export const VERIFY_OPTIONS = [
  ['', '不指定'],
  ['XBRL', '財報數字'],
  ['FILING', '這家公司的申報'],
  ['PEER_FILING', '同業的申報'],
  ['WEB', '清單內的網站'],
  ['NONE', '查不到：標成信念'],
];
/** 信念的那一句（設計原文：「這一條查不到，是你選擇相信的」）。 */
export const BELIEF_TEXT = '信念：這一條查不到，是你選擇相信的';
/** 選了信念時多說明的一句：之後會怎樣。 */
export const BELIEF_NOTE = '信念不進審查的逐條判定、不計入成績，月底也不會為它再審；它留在論點裡提醒你自己留意。';
/** 多久有新的一份：沒填用 100 天（和月底檢查點的 100 天同一個數字）。 */
export const EVERY_DEFAULT = 100;
export const MAX_CLAUSES = 3;
export const LIMITS = { clause: 300, confirmsIf: 300, source: 200, everyMin: 7, everyMax: 400 };

/** 怎麼驗證的一句：「查得到：清單內的網站（trendforce.com），約每 90 天有新的一份」；信念寫信念；沒指定是 null。 */
export function verifyText(v) {
  if (!v?.by) return null;
  if (v.by === 'NONE') return BELIEF_TEXT;
  const what = VERIFY_TEXT[v.by] ?? v.by;
  return `查得到：${what}${v.source ? `（${v.source}）` : ''}${v.every ? `，約每 ${v.every} 天有新的一份` : ''}`;
}

/** 右邊一條前提「怎麼驗證」那一塊收合時的一句（f = { breaksIf, confirmsIf, verify }）。 */
export function fieldsSummary(f) {
  if (f?.verify?.by === 'NONE') return `怎麼驗證：${BELIEF_TEXT.replace('信念：', '信念（')}）`;
  const bits = [];
  if (f?.verify?.by) bits.push(`用${VERIFY_OPTIONS.find(([v]) => v === f.verify.by)?.[1] ?? f.verify.by}查${f.verify.source ? `（${f.verify.source}）` : ''}`);
  if (f?.confirmsIf) bits.push('寫了怎樣算證實');
  if (f?.breaksIf?.length) bits.push(`怎樣算不成立 ${f.breaksIf.length} 句`);
  return bits.length ? `怎麼驗證：${bits.join('、')}` : '怎麼驗證：還沒寫（可以不填）';
}

/** 有沒有寫任何一個欄位（有的話「怎麼驗證」那一塊預設攤開）。 */
export const hasFields = (f) => !!(f && (f.verify?.by || f.confirmsIf || f.breaksIf?.length));

/**
 * 草稿的一條前提 → 右邊那一條要填的欄位。T60 的形狀（confirms_if、breaks_if 陣列、verify）與 T55 的舊草稿
 * （breaks_if 一段字、checkable_by、source_hint）都收。
 */
export function draftPremiseFields(x) {
  const v = x?.verify ?? (x?.checkable_by ? { by: x.checkable_by, source: x.source_hint ?? null, every: null } : null);
  const breaks = Array.isArray(x?.breaks_if) ? x.breaks_if.filter(Boolean) : x?.breaks_if ? [x.breaks_if] : [];
  const verify = v?.by ? { by: v.by, ...(v.by !== 'NONE' && v.source ? { source: v.source } : {}), ...(v.by !== 'NONE' && v.every ? { every: v.every } : {}) } : null;
  return { breaksIf: breaks, confirmsIf: x?.confirms_if ?? '', verify };
}

/** 持股頁、編輯論點頁「現在的」：伺服器給的一條前提 → 同樣的三個欄位。 */
export const premiseFieldsOf = (p) => ({ breaksIf: p?.breaksIf ?? [], confirmsIf: p?.confirmsIf ?? '', verify: p?.verify ?? null });

/**
 * 存檔前的預覽：信念與查得到的前提有幾條（伺服器的 preview.beliefs、preview.checkable；composite §2.3）。
 * 至少 2 條查得到就只說哪幾條是信念；少於 2 條提醒（只有系統預設、沒有你的前提時 checkable 是 null，不說）。
 */
export function checkableWarn(p) {
  if (p?.checkable === null || p?.checkable === undefined) return null;
  const b = p.beliefs ?? [];
  if (p.checkable >= 2) return b.length ? { tone: 'dim', text: `${b.join('、')} 是信念：不進審查的逐條判定，審查檢查另外 ${p.checkable} 條。` } : null;
  if (p.checkable === 0) return { tone: 'warn', text: '每一條前提都標成信念：審查沒有前提可以逐條檢查，只看你定的出場條件與硬事件。建議至少 2 條寫成查得到的事。' };
  return { tone: 'warn', text: `只有 1 條前提查得到（${b.join('、')} 是信念）：審查只檢查這 1 條。建議至少 2 條寫成查得到的事；查不到的先配一個之後會出現在申報裡的指標。` };
}
