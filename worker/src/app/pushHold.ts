// 規則的通知等到第二次排程再推（T31b；own_thesis_design_2026-11-15 §3.5。core_ai_design §3.2 的月報共用這一段：T33b 的 crashWaiter）。
//
// 規則的通知不等 AI 的內容，只等到固定的時間：
//   通知產生的那一次流程（通常是 UTC 23:30）：通知上有還在等的 AI 結果（waiting）→ 這次不推 LINE，編號記在 flow_state 的 push:held
//   下一次流程（通常是 01:30）：套用結論之後照推，不管結果回來了沒；推出去時把跟著推出去的結果標成「講過了」（told）
//   再之後的流程（通常是 03:30）：通知推出去之後結果才回來 → 補推一行（followUps），每個結果一次
// 沒有在等的通知（AI 沒開成、AI 層沒設定、結果已經回來）照舊當場推。手動或補做的流程照同樣的條件判斷。
// 這裡只放判斷；實際推播與存檔在 src/app/flow.ts 的 pushPending。
import type { Account, Notif } from '../engine';

export interface PushFollowUp {
  /** 哪一則通知的結果。 */
  notif: number;
  /** 補推的那一行。 */
  text: string;
  /** 補推成功之後標成講過了（直接改傳進來的帳戶）。 */
  told(acct: Account): void;
}

export interface PushWaiter {
  name: string;
  /** 這則新通知上有還在等的 AI 結果 → 產生它的這次流程不推，下一次流程推。 */
  waiting(acct: Account, n: Notif): boolean;
  /** 通知推出去了：跟著推出去的結果標成講過了（直接改傳進來的帳戶）。 */
  told?(acct: Account, n: Notif): void;
  /** 通知推出去之後才回來的結果：要補推的。 */
  followUps?(acct: Account): PushFollowUp[];
}

/** flow_state 的鍵：這次留住、下一次流程要推的通知編號（JSON 陣列）。 */
export const PUSH_HELD_KEY = 'push:held';

const reduceItems = (n: Notif) => n.items.filter((it) => it.f === 'F7' && it.kind === 'OWN_RULE' && !it.cancelled && !!it.ticker);

/** 補推的那一行（own_thesis §3.5 的第三次排程）。 */
export const dropFollowUpText = (ticker: string, state: 'HOLD' | 'EXIT', notif: number): string => `${ticker} 的 AI 論點檢查回來了：${state === 'HOLD' ? '建議不動' : '前提不成立，建議出清'}。通知 #${notif} 已更新，預設仍是照規則。`;

/**
 * 慢規則減半通知與減半檢視（own_thesis §3.5）：
 *   等：新通知裡有減半項目，而且那檔的 dropReview 是 PENDING（沒開成或 AI 層沒設定是 NONE，照舊當場推）
 *   講過了：推出去時 dropReview 不是 PENDING 的，told 設成 true
 *   補推：dropReview 是不動或出清、told 是 false、通知還沒回覆（已經推過由 pushPending 判斷）；同意減半、沒有結論不補推
 */
export const dropWaiter: PushWaiter = {
  name: '減半檢視',
  waiting: (acct, n) => reduceItems(n).some((it) => acct.own[it.ticker!]?.dropReview?.status === 'PENDING'),
  told(acct, n) {
    for (const it of reduceItems(n)) {
      const dr = acct.own[it.ticker!]?.dropReview;
      if (dr && dr.status !== 'PENDING') dr.told = true;
    }
  },
  followUps(acct) {
    const out: PushFollowUp[] = [];
    for (const n of acct.notifs) {
      if (n.status !== 'PENDING') continue;
      for (const it of reduceItems(n)) {
        const t = it.ticker!;
        const dr = acct.own[t]?.dropReview;
        if (!dr || dr.told || (dr.status !== 'HOLD' && dr.status !== 'EXIT') || (it.drop !== 'HOLD' && it.drop !== 'EXIT')) continue;
        out.push({
          notif: n.id,
          text: dropFollowUpText(t, it.drop, n.id),
          told: (a) => {
            const d = a.own[t]?.dropReview;
            if (d && d.status !== 'PENDING') d.told = true;
          },
        });
      }
    }
    return out;
  },
};

/**
 * 月報之後才回來的進場否決（momentum_ai §3.3，T32b）：不留住通知，只補推一則（月報已經推過才補；每個項目一次）。
 * 文字在套用時寫進項目的 lateVeto.push（還沒回覆、已回覆還沒填快照兩種；已經填快照的不推），推出去之後拿掉。
 */
export const lateVetoWaiter: PushWaiter = {
  name: '晚到的進場否決',
  waiting: () => false,
  told(_acct, n) {
    // 月報整則重推（例如之前推失敗）時，新的內容已經在裡面，不另外補推
    for (const it of n.items) if (it.lateVeto?.push) delete it.lateVeto.push;
  },
  followUps(acct) {
    const out: PushFollowUp[] = [];
    for (const n of acct.notifs)
      for (const it of n.items) {
        if (it.f !== 'F1' || !it.lateVeto?.push) continue;
        const key = it.key;
        out.push({
          notif: n.id,
          text: it.lateVeto.push,
          told: (a) => {
            const x = a.notifs.find((m) => m.id === n.id)?.items.find((i) => i.key === key);
            if (x?.lateVeto) delete x.lateVeto.push;
          },
        });
      }
    return out;
  },
};

/** 月報裡會開檢視的崩盤項目（F5／F6，沒取消、不是重列的）。 */
const crashItems = (n: Notif) => (n.kind === 'MONTHLY' ? n.items.filter((it) => (it.f === 'F5' || it.f === 'F6') && !it.cancelled && !it.relist) : []);

/** 補推的那一行（core_ai §3.2 的 03:30）。month：月報的月份標籤（2026-12）。 */
export const crashFollowUpText = (opinion: '照做' | '延後', month: string | undefined, notif: number): string =>
  `崩盤規則的 AI 檢視回來了：${opinion}。${month ? `${Number(month.slice(5, 7))} 月` : ''}月報 #${notif} 已更新；規則的動作不變，預設仍是照做。`;

/**
 * 崩盤規則的月報（core_ai §3.2，使用者 2026-11-15 決定）：
 *   等：月報有 F5／F6，而且那一項的檢視是 PENDING（補開成功、還在等）；其他狀態照舊當場推
 *   講過了：推出去時文字裡有「AI 檢視：」那一行（OPINION）的，told 設成 true
 *   補推：OPINION、told 是 false、通知還沒回覆（已經推過由 pushPending 判斷）；每份月報最多一次。03:30 之後才回來的在套用時就標成講過了（只放網站）
 */
export const crashWaiter: PushWaiter = {
  name: '崩盤規則檢視',
  waiting: (_acct, n) => crashItems(n).some((it) => it.crashReview?.state === 'PENDING'),
  told(_acct, n) {
    for (const it of crashItems(n)) if (it.crashReview?.state === 'OPINION') it.crashReview.told = true;
  },
  followUps(acct) {
    const out: PushFollowUp[] = [];
    for (const n of acct.notifs) {
      if (n.status !== 'PENDING') continue;
      for (const it of crashItems(n)) {
        const cr = it.crashReview;
        if (!cr || cr.state !== 'OPINION' || !cr.opinion || cr.told) continue;
        const key = it.key;
        out.push({
          notif: n.id,
          text: crashFollowUpText(cr.opinion, n.monthly?.input.month, n.id),
          told: (a) => {
            const x = a.notifs.find((m) => m.id === n.id)?.items.find((i) => i.key === key);
            if (x?.crashReview) x.crashReview.told = true;
          },
        });
      }
    }
    return out;
  },
};

/** 所有「等到下一次流程再推」的規則通知。 */
export const PUSH_WAITERS: PushWaiter[] = [dropWaiter, lateVetoWaiter, crashWaiter];

/** 這則新通知要不要等到下一次流程再推。 */
export const pushWaiting = (acct: Account, n: Notif, waiters: PushWaiter[] = PUSH_WAITERS): boolean => waiters.some((w) => w.waiting(acct, n));

/** flow_state 裡留住的通知編號（格式壞了當成沒有）。 */
export function parseHeld(v: string | null): number[] {
  try {
    const j = JSON.parse(v ?? '[]') as unknown;
    return Array.isArray(j) ? j.filter((x): x is number => Number.isInteger(x)) : [];
  } catch {
    return [];
  }
}
