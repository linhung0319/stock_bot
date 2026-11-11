// T4（本機部分）：各資料來源的解析。固定檔是 2026-11-11 從公開網址抓的真實回應。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  compareMembership,
  edgarSubmissionsUrl,
  fetchEdgarSubmissions,
  fetchYahooDaily,
  normalizeTicker,
  parseAsOf,
  parseEdgarSubmissions,
  parseSpyHoldings,
  parseWikiSp500,
  parseYahooChart,
  yahooChartUrl,
} from '../src/data/sources';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const bin = (f: string) => new Uint8Array(readFileSync(join(FIX, f)));
const text = (f: string) => readFileSync(join(FIX, f), 'utf8');

describe('Yahoo 日線', () => {
  it('解析 chart 回應：日期用美東日期，未調整收盤與還原收盤分開', () => {
    const s = parseYahooChart(JSON.parse(text('yahoo-aapl-5d.json')));
    expect(s.symbol).toBe('AAPL');
    expect(s.bars.length).toBeGreaterThanOrEqual(4);
    for (const b of s.bars) {
      expect(b.date).toMatch(/^2026-11-\d\d$/);
      expect(b.close).toBeGreaterThan(0);
      expect(b.volume).toBeGreaterThan(0);
      expect(new Date(b.date + 'T00:00:00Z').getUTCDay() % 6).not.toBe(0); // 不是週末
    }
    const dates = s.bars.map((b) => b.date);
    expect([...dates].sort()).toEqual(dates);
    expect(new Set(dates).size).toBe(dates.length);
  });
  it('代號的「.」換成「-」（BRK.B → BRK-B）', () => {
    expect(yahooChartUrl('BRK.B')).toContain('/chart/BRK-B?');
  });
  it('還沒收盤的那一根（close 是 null）跳過；錯誤回應丟出錯誤', () => {
    const j = { chart: { result: [{ meta: { symbol: 'X', gmtoffset: -18000 }, timestamp: [1794322200, 1794408600], indicators: { quote: [{ open: [1, 2], high: [1, 2], low: [1, 2], close: [1.5, null], volume: [10, null] }] } }] } };
    expect(parseYahooChart(j).bars).toHaveLength(1);
    expect(() => parseYahooChart({ chart: { result: null, error: { description: 'No data found' } } })).toThrow('No data found');
  });
  it('HTTP 錯誤會丟出錯誤（不會當成空資料）', async () => {
    await expect(fetchYahooDaily(async () => new Response('Too Many Requests', { status: 429 }), 'AAPL')).rejects.toThrow('429');
  });
});

describe('SSGA SPY 每日持股檔', () => {
  it('讀出日期、約 503 檔、權重合計接近 100%；非股票列排除', async () => {
    const h = await parseSpyHoldings(bin('spy-holdings-2026-11-10.xlsx'));
    expect(h.asOf).toMatch(/^2026-11-\d\d$/);
    expect(h.holdings.length).toBeGreaterThan(495);
    expect(h.holdings.length).toBeLessThan(510);
    const sum = h.holdings.reduce((a, x) => a + x.weight, 0);
    expect(sum).toBeGreaterThan(99);
    expect(sum).toBeLessThan(100.5);
    const top = [...h.holdings].sort((a, b) => b.weight - a.weight).slice(0, 10).map((x) => x.ticker);
    expect(top).toContain('NVDA');
    expect(top).toContain('MSFT');
    expect(h.holdings.every((x) => /^[A-Z][A-Z.]*$/.test(x.ticker))).toBe(true);
    // 兩類股分開列
    expect(h.holdings.some((x) => x.ticker === 'GOOGL')).toBe(true);
    expect(h.holdings.some((x) => x.ticker === 'GOOG')).toBe(true);
  });
  it('日期格式', () => {
    expect(parseAsOf('As of 10-Nov-2026')).toBe('2026-11-10');
    expect(parseAsOf('As of 5-Jan-2027')).toBe('2027-01-05');
    expect(parseAsOf('???')).toBeNull();
  });
  it('不是 xlsx → 丟出錯誤', async () => {
    await expect(parseSpyHoldings(new TextEncoder().encode('<html>blocked</html>'))).rejects.toThrow();
  });
});

describe('Wikipedia 目前的 S&P 500 名單', () => {
  it('解析 wikitext：約 503 檔，含 CIK', () => {
    const m = parseWikiSp500(text('wiki-sp500-2026-11-11.txt'));
    expect(m.length).toBeGreaterThan(495);
    expect(m.length).toBeLessThan(510);
    expect(m[0]).toEqual({ ticker: 'MMM', cik: '0000066740' });
    expect(m.find((x) => x.ticker === 'AAPL')!.cik).toBe('0000320193');
  });
  it('格式變了 → 丟出錯誤（不會回傳空名單）', () => {
    expect(() => parseWikiSp500('<html></html>')).toThrow('格式變了');
  });
  it('SPY 持股檔和 Wikipedia 名單比對：同一天的兩份真實資料一致', async () => {
    const spy = await parseSpyHoldings(bin('spy-holdings-2026-11-10.xlsx'));
    const wiki = parseWikiSp500(text('wiki-sp500-2026-11-11.txt'));
    const d = compareMembership(spy.holdings.map((h) => h.ticker), wiki.map((w) => w.ticker));
    expect(d).toEqual({ onlySpy: [], onlyWiki: [], consistent: true });
  });
  it('不一致時列出差異（→ 暫停換股並通知）', () => {
    expect(compareMembership(['AAPL', 'BRK.B', 'NEW'], ['AAPL', 'BRK-B', 'OLD'])).toEqual({ onlySpy: ['NEW'], onlyWiki: ['OLD'], consistent: false });
    expect(normalizeTicker('brk-b')).toBe('BRK.B');
  });
});

describe('EDGAR submissions', () => {
  const sample = {
    cik: '320193',
    name: 'Apple Inc.',
    tickers: ['AAPL'],
    filings: { recent: { accessionNumber: ['0000320193-26-000001', '0000320193-26-000002'], form: ['8-K', 'NT 10-Q'], items: ['2.02,9.01', ''], acceptanceDateTime: ['2026-10-29T20:30:41.000Z', '2026-11-09T21:01:00.000Z'], filingDate: ['2026-10-29', '2026-11-09'], primaryDocument: ['a.htm', 'b.htm'] } },
  };
  it('解析 form、items、接受時間', () => {
    const r = parseEdgarSubmissions(sample);
    expect(r.cik).toBe('0000320193');
    expect(r.filings[0]).toMatchObject({ form: '8-K', items: ['2.02', '9.01'], acceptedAt: '2026-10-29T20:30:41.000Z' });
    expect(r.filings[1]).toMatchObject({ form: 'NT 10-Q', items: [] });
  });
  it('網址補滿 10 碼；沒有設定 User-Agent 就不送出請求', async () => {
    expect(edgarSubmissionsUrl('320193')).toBe('https://data.sec.gov/submissions/CIK0000320193.json');
    let called = 0;
    const f = async () => (called++, Response.json(sample));
    await expect(fetchEdgarSubmissions(f, 320193, '')).rejects.toThrow('User-Agent');
    expect(called).toBe(0);
    const seen: string[] = [];
    await fetchEdgarSubmissions(async (_u, init) => (seen.push(new Headers(init?.headers).get('User-Agent') ?? ''), Response.json(sample)), 320193, 'test-agent contact');
    expect(seen).toEqual(['test-agent contact']);
  });
});
