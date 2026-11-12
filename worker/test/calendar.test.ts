// T6：美股交易日曆。假日用 NYSE 公布過的日期對照。
import { describe, expect, it } from 'vitest';
import {
  easternTime,
  holidaysOf,
  isFirstTradingDayOfMonth,
  isLastTradingDayOfMonth,
  isTradingDay,
  lastCompletedSession,
  nextTradingDay,
  previousTradingDay,
  tradingDaysBetween,
} from '../src/data/calendar';

describe('NYSE 假日', () => {
  it('2025 年：10 個假日的日期', () => {
    expect(Object.keys(holidaysOf(2025)).sort()).toEqual(['2025-01-01', '2025-01-20', '2025-02-17', '2025-04-18', '2025-05-26', '2025-06-19', '2025-07-04', '2025-09-01', '2025-11-27', '2025-12-25']);
  });
  it('2026 年：獨立紀念日在週六 → 提前到 7/3（週五）', () => {
    expect(Object.keys(holidaysOf(2026)).sort()).toEqual(['2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25']);
  });
  it('元旦在週六不補假（2021-12-31 照常開市、2022 年沒有元旦假日）；在週日延到週一（2023-01-02）', () => {
    expect(isTradingDay('2021-12-31')).toBe(true);
    expect(Object.values(holidaysOf(2022))).not.toContain('元旦');
    expect(isTradingDay('2023-01-02')).toBe(false);
  });
  it('六月節從 2022 年開始；2021 年以前沒有', () => {
    expect(isTradingDay('2021-06-18')).toBe(true);
    expect(isTradingDay('2022-06-20')).toBe(false); // 6/19 是週日，延到週一
  });
  it('2024 年的交易日數是 252；2025 年是 250（含 1/9 國殤日休市）', () => {
    expect(tradingDaysBetween('2024-01-01', '2024-12-31')).toHaveLength(252);
    expect(tradingDaysBetween('2025-01-01', '2025-12-31')).toHaveLength(250);
    expect(isTradingDay('2025-01-09')).toBe(false);
  });
  it('臨時休市與例外可以由外面帶進來', () => {
    expect(isTradingDay('2026-11-12', { closed: new Set(['2026-11-12']) })).toBe(false);
    expect(isTradingDay('2026-11-26', { open: new Set(['2026-11-26']) })).toBe(true);
    expect(previousTradingDay('2026-11-13', { closed: new Set(['2026-11-12']) })).toBe('2026-11-11');
  });
});

describe('前後交易日與月初月底', () => {
  it('跨週末與假日', () => {
    expect(previousTradingDay('2026-11-30')).toBe('2026-11-27');
    expect(previousTradingDay('2026-11-27')).toBe('2026-11-25'); // 感恩節
    expect(nextTradingDay('2026-12-24')).toBe('2026-12-28'); // 聖誕節＋週末
  });
  it('月報的訊號日是當月最後一個交易日；執行日是下個月第一個交易日', () => {
    expect(isLastTradingDayOfMonth('2026-11-30')).toBe(true);
    expect(isLastTradingDayOfMonth('2026-11-27')).toBe(false);
    expect(isLastTradingDayOfMonth('2026-10-30')).toBe(true); // 10/31 是週六
    expect(isFirstTradingDayOfMonth('2026-12-01')).toBe(true);
    expect(isFirstTradingDayOfMonth('2027-01-04')).toBe(true); // 1/1 假日、1/2–3 週末
    expect(isFirstTradingDayOfMonth('2027-01-05')).toBe(false);
    expect(isLastTradingDayOfMonth('2026-11-28')).toBe(false); // 週六
  });
});

describe('美東時間與「最近一個已收盤的交易日」', () => {
  it('夏令與冬令時間', () => {
    expect(easternTime(new Date('2026-07-01T23:30:00Z'))).toEqual({ date: '2026-07-01', minutes: 19 * 60 + 30 });
    expect(easternTime(new Date('2026-12-01T23:30:00Z'))).toEqual({ date: '2026-12-01', minutes: 18 * 60 + 30 });
    expect(easternTime(new Date('2026-12-02T03:00:00Z')).date).toBe('2026-12-01');
  });
  it('收盤後（16:15 以後）是當天；盤中與開盤前是前一個交易日', () => {
    expect(lastCompletedSession(new Date('2026-11-12T23:30:00Z'))).toBe('2026-11-12');
    expect(lastCompletedSession(new Date('2026-11-12T21:10:00Z'))).toBe('2026-11-11'); // 16:10，還沒過 16:15
    expect(lastCompletedSession(new Date('2026-11-12T21:15:00Z'))).toBe('2026-11-12');
    expect(lastCompletedSession(new Date('2026-11-12T15:00:00Z'))).toBe('2026-11-11'); // 盤中
    expect(lastCompletedSession(new Date('2026-07-01T20:15:00Z'))).toBe('2026-07-01'); // 夏令 16:15
    expect(lastCompletedSession(new Date('2026-07-01T20:10:00Z'))).toBe('2026-06-30');
  });
  it('週末、假日 → 之前最近的交易日；台灣早上（美東前一天晚上）算美東那一天', () => {
    expect(lastCompletedSession(new Date('2026-11-14T23:30:00Z'))).toBe('2026-11-13'); // 週六
    expect(lastCompletedSession(new Date('2026-11-26T23:30:00Z'))).toBe('2026-11-25'); // 感恩節
    expect(lastCompletedSession(new Date('2026-11-13T00:30:00Z'))).toBe('2026-11-12'); // 台灣 11/13 08:30
  });
});
