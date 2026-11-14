// 門檻條（2026-11-14 改版）：把「現在離規則的門檻多遠」畫成一條橫條。
// - 條的長度 = 離門檻走了多遠；白線 = 門檻；白點 = 現在的位置。
// - 白線之後的那一段是「會觸發的範圍」，下面直接寫後果（減半、賣出、啟動…）。
// - 已經觸發時整條變色（減碼、賣出、啟動保險是紅色；進場、買回是藍色）。
// 刻度用真實數字算：白線固定在條的 75% 處，白點的位置 = 從起點走到門檻的比例；過了門檻之後，
// 剩下的 25% 對應「門檻 → 觸發範圍的另一端」。
import type { Gauge } from './types';

export interface Meter {
  /** 門檻（白線）在條上的位置，0–1。 */
  t: number;
  /** 現在（白點）在條上的位置，0–1。 */
  v: number;
  /** ok = 還遠；near = 走了四分之三以上；hit = 已經在觸發範圍內。 */
  s: 'ok' | 'near' | 'hit';
  /** 觸發的後果，寫在白線後面那一段的下面。 */
  zone: string;
  /** stop = 減碼、賣出、啟動保險（紅）；go = 進場、買回（藍）。 */
  kind: 'stop' | 'go';
  /** 給螢幕閱讀器的一句話。 */
  label: string;
  /** 大條上面的刻度說明（只有建議單裡的大條有）。 */
  cap?: string;
  /** 大條下面的白話結果，例如「已經掉出前 15 名 → 這次月報賣出全部 28 股」。 */
  say?: string;
}

/** 白線在條上的位置。 */
export const THRESHOLD_AT = 0.75;

export interface Scale {
  /** 條的起點（離觸發最遠的那一端）。 */
  start: number;
  /** 門檻。 */
  th: number;
  /** 觸發範圍的另一端（條的終點）。 */
  end: number;
  value: number;
  /** 已經觸發了沒有（照規則本身的判斷，例如排名要「大於」15 才算）。沒給就用「到了門檻就算」。 */
  hit?: boolean;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** 把真實數字換成條上的位置。 */
export function place(sc: Scale): { t: number; v: number; frac: number; hit: boolean } {
  const { start, th, end, value } = sc;
  const toward = th - start || 1;
  const frac = (value - start) / toward;
  const hit = sc.hit ?? frac >= 1;
  let v: number;
  if (frac <= 1) v = THRESHOLD_AT * clamp01(frac);
  else {
    const beyond = end - th;
    v = THRESHOLD_AT + (1 - THRESHOLD_AT) * (beyond ? clamp01((value - th) / beyond) : 1);
  }
  return { t: THRESHOLD_AT, v: Math.round(v * 1000) / 1000, frac, hit };
}

export function meter(sc: Scale, o: { zone: string; kind?: Meter['kind']; label: string; cap?: string; say?: string }): Meter {
  const p = place(sc);
  return { t: p.t, v: p.v, s: p.hit ? 'hit' : p.frac >= 0.75 ? 'near' : 'ok', zone: o.zone, kind: o.kind ?? 'stop', label: o.label, ...(o.cap ? { cap: o.cap } : {}), ...(o.say ? { say: o.say } : {}) };
}

/**
 * 從舊的門檻尺資料（通知裡存著的 Gauge）換成門檻條的刻度。
 * 一段觸發範圍：門檻 = 範圍靠裡面的那一端，起點 = 刻度另一頭。
 * 兩段觸發範圍（例如 ±50%）：改成「離目標多遠」，門檻是範圍的寬度。
 */
export function scaleOf(g: Gauge): Scale | null {
  if (!g.zones.length || !Number.isFinite(g.value)) return null;
  const eps = 1e-9;
  if (g.zones.length >= 2) {
    const lowTh = Math.max(g.zones[0].from, g.zones[0].to);
    const highTh = Math.min(g.zones[1].from, g.zones[1].to);
    const center = (lowTh + highTh) / 2;
    const band = highTh - center;
    const dev = Math.abs(g.value - center);
    return { start: 0, th: band, end: Math.max(band * 2, dev * 1.15), value: dev };
  }
  const z = g.zones[0];
  const lo = Math.min(z.from, z.to);
  const hi = Math.max(z.from, z.to);
  if (Math.abs(lo - Math.min(g.from, g.to)) < eps) return { start: Math.max(g.from, g.to), th: hi, end: lo, value: g.value };
  return { start: Math.min(g.from, g.to), th: lo, end: hi, value: g.value };
}

/** 一條簡單的說明（給螢幕閱讀器；畫面上不顯示）。 */
export function labelOf(g: Gauge, zone: string, hit: boolean): string {
  const mark = g.marks.map((m) => m.label).join('、');
  return `${g.caption}：現在 ${g.valueLabel}；門檻 ${mark}，${hit ? `已經到了「${zone}」` : `到了會${zone}`}`;
}
