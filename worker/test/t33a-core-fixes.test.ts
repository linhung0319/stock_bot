// T33a：核心的修補（core_ai_design_2026-11-15 §5 的 T33a 那一列與「還沒決定的」C14）。
// T80（階段十二，allocation_redesign §1.2、§1.6）：崩盤規則退場，這裡只留還適用的——C14（核心不夠付時買單往回減）與 crashDecision 這個純函式。
// 拿掉的：§3.8 崩盤規則啟動期間多的錢放短債（halfUpTo；錢進出核心改成一律照比例，測試在 t80-core-ratio.test.ts）、
// §3.1 crashNeeds 看月報上的 F5、§3.3 崩盤項目的 AI 說明、§3.7 月報暫停後用訊號日的崩盤判斷、§3.10 月報裡均線不足不解除（月報不再產生 F5／F6）。
import { describe, expect, it } from 'vitest';
import { capNoteOf } from '../src/app/site/views';
import { composeWithCore, crashDecision, DEFAULT_CONFIG, type OrderLine } from '../src/engine';

const cfg = DEFAULT_CONFIG;

describe('C14：核心不夠付時，買單會不會超過現金', () => {
  const price = (t: string) => ({ NVDA: 100, AAPL: 100, VOO: 500, SGOV: 100 })[t] ?? 100;
  const ctx = { cfg, price, bondTicker: 'SGOV', cash: 1000, coreShares: 10, bondShares: 0, total: 20000 };
  const lines: OrderLine[] = [
    { ticker: 'AAPL', bucket: 'mom', shares: 30, reason: '動能換股' },
    { ticker: 'NVDA', bucket: 'own', shares: 50, reason: '新增自選' },
  ];

  // 修之前這一個測試的結果：cashAfter = -2000（買 8000，現金 1000＋核心賣光 5000）→ C14 成立
  it('買 8000、現金 1000、核心只有 5000 → 核心賣光後買單從最後一行往回減，做完現金不是負的', () => {
    const c = composeWithCore(lines, ctx);
    expect(c.merged.find((m) => m.ticker === 'VOO')!.shares).toBe(-10);
    expect(c.cashAfter).toBeGreaterThanOrEqual(0);
    // 可用 = 現金 1000 + 核心 5000；買單上限 98% = 5880 → AAPL 不動（3000），NVDA 從 50 減到 28（2800）
    expect(c.merged.find((m) => m.ticker === 'AAPL')!.shares).toBe(30);
    expect(c.merged.find((m) => m.ticker === 'NVDA')!.shares).toBe(28);
    expect(c.capped).toEqual([{ ticker: 'NVDA', cut: 22 }]);
    expect(capNoteOf(c)).toBe('核心的錢不夠付這份清單的買單，已經從最後一張買單往回減：NVDA 少買 22 股。');
  });

  it('短債與核心 ETF 兩邊都賣光還不夠才減買單；核心夠付時不減、沒有說明', () => {
    const c = composeWithCore(lines, { ...ctx, coreShares: 4, bondShares: 20 });
    expect(c.merged.find((m) => m.ticker === 'SGOV')!.shares).toBe(-20);
    expect(c.merged.find((m) => m.ticker === 'VOO')!.shares).toBe(-4);
    expect(c.cashAfter).toBeGreaterThanOrEqual(0);
    expect(c.capped?.length).toBe(1);
    const ok = composeWithCore(lines, { ...ctx, coreShares: 100 });
    expect(ok.capped).toBeUndefined();
    expect(capNoteOf(ok)).toBeNull();
    expect(ok.merged.find((m) => m.ticker === 'NVDA')!.shares).toBe(50);
  });
});

describe('§3.10 均線算不出來：crashDecision 維持原狀態', () => {
  it('不滿 200 根有效收盤 → below = 原狀態、ok = false；夠的時候照收盤與均線', () => {
    const up = Array.from({ length: 200 }, (_, k) => 100 + k);
    expect(crashDecision(up, 199, true)).toMatchObject({ below: false, ok: true });
    expect(crashDecision(up, 150, true)).toMatchObject({ below: true, ok: false });
    expect(crashDecision(up, 150, false)).toMatchObject({ below: false, ok: false });
    expect(crashDecision(undefined, 10, true)).toMatchObject({ below: true, ok: false });
  });

});
