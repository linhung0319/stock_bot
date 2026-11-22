// 持股頁的論點那一塊（T34，own_thesis §1.3）：從論點檔組出畫面要的白話——前提最近一次的檢查、事件時間軸、
// 歷次審查與你的回應、靜默中的前提、減半檢視的狀態。純函式：論點檔由呼叫的地方組好（真實模式 thesisFile，示範模式 metaFile）。
import { verdictText } from '../../ai/functions';
import { DROP_CAUSE_TEXT, dropAttrText, isBelief, notifName, verifyEvery, type Account, type Attention, type MarketView, type OwnMeta } from '../../engine';
import { concentrationHits } from '../concentration';
import { CODE_TEXT, eventDetail, eventLabel, eventSource, eventStatus, eventVia } from '../eventText';
import { UNVERIFIED_AFTER, metaFile, openRisks, outcomeText, ownAttention, premiseStanding, toAttention, type OpenRisk, type PremiseStanding, type ThesisFile, type ThesisReview } from '../thesis';

/**
 * 一條前提最近一次的結果（T61，composite_layer_design §2.1 的「顯示」）：由歷次定期審查算出來（thesis.ts 的 premiseStanding），
 * 不是新的判定值。四種寫法：
 *   CONFIRMED   `11/20 證實`                       最近一次 3 票都判成立
 *   BROKEN      `11/20 被判不成立`                 最近一次 3 票都判不成立
 *   MISSED      `這次沒驗到（上次證實 9/30）`       最近一次是證據不足或票數不一致，連續不到 3 次
 *   MISSED_MANY `已經 3 次沒驗到`                  連續 3 次以上（同時列在「要看的事」）
 * 沒被審查過（含改過字之後還沒審、信念、示範資料）是 null。
 */
export interface PremiseCheck {
  kind: 'CONFIRMED' | 'BROKEN' | 'MISSED' | 'MISSED_MANY' | null;
  /** 畫面上的那一句（四種寫法之一；沒被審查過是「還沒有檢查過」）。 */
  text: string;
  /** 那一句的理由，放在同一塊：哪一次審查、三票怎麼判；沒驗到的寫為什麼。沒被審查過是 null。 */
  why: string | null;
}

export interface EventView {
  date: string;
  /** 類別（有細項用細項）：財測下修、執行長離任、個股自身大跌…。 */
  label: string;
  /** 來源：8-K、10-Q、新聞標題、價格規則…。 */
  source: string;
  /** 誰記下的：申報分類、每日掃描、AI 轉交、價格規則。 */
  via: string;
  /** 說明的白話（沒有英文代碼）。 */
  detail: string | null;
  status: string;
  /** 上一次有結論的審查之後的（下一次審查會讀）。 */
  isNew: boolean;
  /** 只記錄（不會叫 AI 來看）。 */
  displayOnly: boolean;
}

export interface ReviewView {
  runId: string;
  date: string;
  /** 定期審查、減半檢視、硬事件、條件確認、財報數字擷取。 */
  label: string;
  /** 為什麼審：財報後、提前審查、論點變動後、月底檢查點… */
  trigger: string | null;
  /** 「3 票一致：減半」「沒有一致結論」「逾時，沒有結論」「還在跑」。 */
  result: string;
  tone: 'ok' | 'warn' | 'hot' | 'now' | '';
  /** 三票都判不成立的前提（編號）。 */
  broken: string[];
  notif: number | null;
  /** 那則通知的名字（日期與種類，不用內部編號；T39a）。沒有通知或找不到是 null。 */
  notifName?: string | null;
  /** 「不同意：…」「還沒回」；沒有通知是 null。 */
  response: string | null;
}

export interface ThesisView {
  premiseChecks: Record<string, PremiseCheck>;
  events: EventView[];
  /** 事件總數（列表只列最近的幾件）。 */
  eventCount: number;
  reviews: ReviewView[];
  reviewCount: number;
  /** 靜默中的前提（還在期間內的）。 */
  silenced: { premiseId: string; text: string; since: string; until: string; reason: string }[];
  /** 減半之後的論點檢查（own_thesis §3.3；那則通知有最後結果時就清掉）。 */
  dropReview: { text: string; tone: 'ok' | 'warn' | 'hot' | 'now'; notif: number | null } | null;
  /** 減半檢視那一行連到的通知的名字（日期與種類，不用內部編號；T39a）。 */
  dropReviewNotifName: string | null;
  /** 示範模式：論點檔只有帳戶狀態（沒有條件、事件、審查紀錄）。 */
  partial: boolean;
  /**
   * 審查提到、你的前提沒有涵蓋的事（T63，composite_layer_design §3）：現在還列著的。
   * 編輯論點頁用（一鍵帶進右欄再改字）；持股頁的審查那一塊也列（T71：不再列進「要看的事」，「看過了，不加」拿掉）。只當建議。
   */
  risks: RiskView[];
}

/** 一件「前提以外的風險」給畫面的樣子：那一句、哪一次執行（日期與種類）、引用的原文與出處。 */
export interface RiskView {
  runId: string;
  k: number;
  date: string;
  /** 「審查」「減半檢視」。 */
  label: string;
  text: string;
  quote: string;
  /** 引用出自哪一份（標題與日期）；headline = 只有新聞標題，沒有全文。 */
  source: string;
  sourceDate: string;
  url: string | null;
  headline: boolean;
}

export const riskView = (r: OpenRisk): RiskView => ({ runId: r.runId, k: r.k, date: r.date, label: r.label, text: r.text, quote: r.quote, source: r.doc.title, sourceDate: r.doc.date, url: r.doc.url, headline: r.doc.headline });

/** 持股頁列幾件事件、幾次審查（其餘看 AI 紀錄頁）。 */
export const VIEW_EVENTS = 12;
export const VIEW_REVIEWS = 8;

const md = (iso: string) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;
const TRIGGER_TEXT: Record<string, string> = { MONTHLY: '月底檢查點', EARNINGS: '財報後', EARLY: '提前審查', CONDITION: '你定的條件要求重新審查', DROP: '慢規則減半', THESIS: '論點變動後', MANUAL: '手動' };
const FAIL_TEXT: Record<string, string> = { SPLIT: '三票沒有一致結論', INVALID: '格式不合格，沒有結論', DATA_MISSING: '資料缺漏，沒有結論', TIMEOUT: '逾時，沒有結論', NO_RESULT: '沒有結果' };

const VOTE_TEXT: Record<string, string> = { HOLDS: '成立', BROKEN: '不成立', INSUFFICIENT: '證據不足' };

/** 三票怎麼判：「3 票都判證據不足」「三票不一致（2 票成立、1 票證據不足）」「只有 2 票合格（…）」。 */
function votesText(votes: string[]): string {
  const cnt = new Map<string, number>();
  for (const v of votes) cnt.set(v, (cnt.get(v) ?? 0) + 1);
  const parts = ['HOLDS', 'BROKEN', 'INSUFFICIENT'].filter((k) => cnt.has(k)).map((k) => `${cnt.get(k)} 票${VOTE_TEXT[k]}`);
  if (cnt.size === 1) return votes.length >= 3 ? `${votes.length} 票都判${VOTE_TEXT[votes[0]] ?? votes[0]}` : `只有 ${parts[0]}，其他票不合格`;
  return `${votes.length >= 3 ? '三票不一致' : `只有 ${votes.length} 票合格`}（${parts.join('、')}）`;
}

/**
 * 一條前提的那一句與理由（composite_layer_design §2.1）。st：premiseStanding 的結果；every：這一條的驗證頻率（天）。
 * 「上次證實」只在這一串沒驗到之前最近一次 3 票一致的結果是證實時寫；那一次是被判不成立就照實寫，都沒有就寫還沒有證實過。
 */
export function premiseCheckOf(st: PremiseStanding | null, every: number, partial = false): PremiseCheck {
  if (!st) return { kind: null, text: partial ? '示範資料沒有審查紀錄' : '還沒有檢查過', why: null };
  if (st.result === 'HOLDS') return { kind: 'CONFIRMED', text: `${md(st.date)} 證實`, why: `${st.votes.length} 票都判成立` };
  if (st.result === 'BROKEN') return { kind: 'BROKEN', text: `${md(st.date)} 被判不成立`, why: `${st.votes.length} 票都判不成立` };
  const prior = st.prior ? (st.prior.result === 'HOLDS' ? `上次證實 ${md(st.prior.date)}` : `上次 ${md(st.prior.date)} 被判不成立`) : '還沒有證實過';
  const stale = st.stale ? `；其中 ${st.stale} 票原本判成立，但引用的原文比這一條的驗證頻率（${every} 天）還舊，算逾期` : '';
  const why = `${md(st.date)} 審查：${votesText(st.votes)}${stale}`;
  if (st.missed >= UNVERIFIED_AFTER) return { kind: 'MISSED_MANY', text: `已經 ${st.missed} 次沒驗到`, why: `最近一次是 ${why}。${prior}` };
  return { kind: 'MISSED', text: `這次沒驗到（${prior}）`, why };
}

function triggerText(r: Pick<ThesisReview, 'fn' | 'trigger'>): string | null {
  if (!r.trigger) return null;
  if (r.fn === 'OWN_REVIEW') return TRIGGER_TEXT[r.trigger] ?? null;
  // 硬事件：觸發的是事件代碼（PENDING_MA、ACCOUNTING…）
  if (r.fn === 'HARD_EVENT') return r.trigger.split('、').map((c) => CODE_TEXT[c] ?? '其他').join('、');
  return r.trigger;
}

export function reviewView(r: ThesisReview): ReviewView {
  let result: string;
  let tone: ReviewView['tone'];
  if (r.status === 'PENDING') {
    result = '還在跑';
    tone = 'now';
  } else if (r.status === 'AGREED' || r.status === 'INSUFFICIENT') {
    const n = Math.max(0, ...Object.values(r.votes));
    result = r.status === 'AGREED' ? `${n} 票一致：${verdictText(r.fn, r.verdict)}` : `證據不足${r.verdict ? `（${verdictText(r.fn, r.verdict)}）` : ''}`;
    tone = r.status === 'AGREED' ? (r.verdict === 'EXIT' || r.verdict === 'HALF' || r.verdict === 'MET' ? 'hot' : 'ok') : 'warn';
  } else {
    result = FAIL_TEXT[r.status] ?? '沒有結論';
    tone = r.status === 'SPLIT' ? 'warn' : 'hot';
  }
  const response = r.response ? `${outcomeText(r.response)}${r.response.reason ? `：${r.response.reason}` : ''}` : r.notif !== null ? '還沒回' : null;
  return { runId: r.runId, date: r.date, label: r.label, trigger: triggerText(r), result, tone, broken: r.brokenPremises, notif: r.notif, response };
}

function dropText(dr: NonNullable<OwnMeta['dropReview']>, meta?: Pick<OwnMeta, 'premises' | 'pending'>): { text: string; tone: 'ok' | 'warn' | 'hot' | 'now' } {
  if (dr.thesis) {
    // 有論點的股票的跌幅審查（allocation_redesign §3.2）：只有前提不成立會讓它賣
    const w = `${md(dr.session)} 觸發的跌幅審查`;
    const attr = dropAttrText(dr.attr);
    const p = meta?.premises.find((x) => x.id === dr.premiseId)?.text ?? dr.premiseId ?? '';
    switch (dr.status) {
      case 'PENDING':
        return { text: `${w}還在跑，台灣 09:30 前會更新到通知上；結果出來之前先不動`, tone: 'now' };
      case 'BROKEN':
        return { text: `${w}（3 票）：前提「${p}」不成立${dr.exit ? '，3 票都建議出清' : ''}。${meta?.pending?.action === 'REDUCE' ? '這一筆不到總資產 5%，減半併入下一份月報' : '預設減半'}`, tone: 'hot' };
      case 'CLEAR':
        return { text: `${w}（3 票）：前提都沒有被判不成立，不減半${attr ? `。${attr}` : ''}`, tone: 'ok' };
      case 'SPLIT':
        return { text: `${w}：${dr.splitPremise && dr.splitVotes ? `3 票裡有 ${dr.splitVotes} 票認為前提「${meta?.premises.find((x) => x.id === dr.splitPremise)?.text ?? dr.splitPremise}」不成立，` : '3 票的結論不一致，'}沒有一致結論，不減半`, tone: 'warn' };
      default:
        return { text: dr.failed ? `${w}沒有跑完，不動；之後財報後的審查與再跌一級時仍會檢查` : `${w}還沒有結論，先不動；會再檢查`, tone: 'warn' };
    }
  }
  const when = `${md(dr.session)} 減半之後的 AI 論點檢查`;
  switch (dr.status) {
    case 'PENDING':
      return { text: `${when}還在跑，台灣 09:30 前會更新到通知上`, tone: 'now' };
    case 'HOLD':
      return { text: `${when}（3 票）：跌幅主要是${dr.cause === 'MARKET' ? '大盤一起跌' : '產業一起跌'}，前提都沒有被判不成立，AI 建議不動`, tone: 'ok' };
    case 'EXIT':
      return { text: `${when}（3 票）：${dr.premiseId ? `前提 ${dr.premiseId} ` : '有一條前提'}不成立，AI 建議出清`, tone: 'hot' };
    case 'AGREE':
      return { text: `${when}（3 票）：同意減半${dr.cause && DROP_CAUSE_TEXT[dr.cause] ? `（歸類：${DROP_CAUSE_TEXT[dr.cause]}）` : ''}`, tone: 'warn' };
    default:
      return { text: `${when}沒有一致結論，照規則`, tone: 'warn' };
  }
}

/** 還沒回覆、有這檔慢規則減半項目的通知（減半檢視的結果顯示在那一則上）。 */
function pendingRuleNotif(acct: Pick<Account, 'notifs'>, ticker: string): number | null {
  for (const n of [...acct.notifs].reverse()) if (n.status === 'PENDING' && n.items.some((i) => i.ticker === ticker && i.kind === 'OWN_RULE' && i.f === 'F7' && !i.cancelled)) return n.id;
  return null;
}

/**
 * 持股頁的論點那一塊（own_thesis §1.3）。file：這檔的論點檔；meta：帳戶狀態裡的這一檔；date：訊號日。
 * partial：示範模式的論點檔只有帳戶狀態（沒有事件、審查），畫面要說清楚。
 */
export function thesisView(file: ThesisFile, meta: OwnMeta, acct: Pick<Account, 'notifs'>, date: string, partial = false): ThesisView {
  // 每條前提最近一次的結果（T61 的四種寫法）；信念不進審查，沒有結果
  const premiseChecks: Record<string, PremiseCheck> = {};
  for (const p of file.premises) premiseChecks[p.id] = premiseCheckOf(isBelief(p) ? null : premiseStanding(file, p.id), verifyEvery(p), partial);
  const events: EventView[] = file.events
    .filter((e) => !file.openedAt || e.date >= file.openedAt || e.isNew)
    .map((e) => ({
      date: e.date,
      label: eventLabel({ code: e.code, detail_code: e.detailCode ?? null }),
      source: eventSource({ form: e.form, accession: e.sourceId }),
      via: eventVia(e.source),
      detail: eventDetail(e.detail),
      status: eventStatus(e.status),
      isNew: e.isNew,
      displayOnly: e.displayOnly,
    }));
  const nameOf = (id: number | null): string | null => {
    const n = id === null ? undefined : acct.notifs.find((x) => x.id === id);
    return n ? notifName(n) : null;
  };
  const reviews = file.reviews.map(reviewView).map((v) => ({ ...v, notifName: nameOf(v.notif) }));
  const silenced = (meta.disputes ?? [])
    .filter((d) => d.until >= date)
    .map((d) => ({ premiseId: d.premiseId, text: file.premises.find((p) => p.id === d.premiseId)?.text ?? '（已撤下的前提）', since: d.since, until: d.until, reason: d.reason }));
  const dr = meta.dropReview;
  return {
    premiseChecks,
    events: events.slice(0, VIEW_EVENTS),
    eventCount: events.length,
    reviews: reviews.slice(0, VIEW_REVIEWS),
    reviewCount: reviews.length,
    silenced,
    dropReview: dr ? { ...dropText(dr, meta), notif: pendingRuleNotif(acct, file.ticker) } : null,
    dropReviewNotifName: dr ? nameOf(pendingRuleNotif(acct, file.ticker)) : null,
    partial,
    risks: openRisks(file, meta, date).map(riskView),
  };
}

/**
 * 示範模式的持股頁（T34 的決定：示範也看得到論點那一塊與「要看的事」）。示範的帳戶不在 D1 的那幾張表裡，
 * 論點檔只用帳戶狀態組（metaFile：沒有條件、事件、審查紀錄），「要看的事」也從它算（加上集中度）。
 */
export function demoHolding(acct: Account, view: MarketView, ticker: string): { thesis: ThesisView | null; attention: Attention[] } {
  const file = metaFile(acct, ticker, view.date);
  const meta = acct.own[ticker];
  if (!file || !meta) return { thesis: null, attention: [] };
  const conc = (() => {
    try {
      return concentrationHits(acct, view).filter((x) => x.members.includes(ticker));
    } catch {
      return []; // 價格不齊算不出來：這次不列集中度
    }
  })();
  // 示範模式不記出場條件：「減半中而你沒有定任何出場條件」會和示範腳本裡的甲類通知矛盾，不列（T39a）
  const own = ownAttention([file], acct, view).filter((x) => x.key !== 'HALF_NO_EXIT');
  return { thesis: thesisView(file, meta, acct, view.date, true), attention: [...own, ...conc].map(toAttention) };
}
