// T64：綜合層的市場摘要（MARKET_BRIEF；composite_layer_design_2026-11-21 §1.2～§1.5、§5.1；Y2 的四個媒體）。
// 完成條件：
//   共用清單加四個媒體（cnbc.com、finance.yahoo.com 只收文章路徑、npr.org、fortune.com）與兩個官方來源
//   官方來源的擷取與日期：聯準會演講的發布日、利率決議聲明的內文門檻、勞工統計局新聞稿的 <pre> 與發布時間那一行
//   觸發（§1.2）：大盤單日、族群單日、累積、當天有個股執行；頻率上限、同一個事件、定稿、重試
//   證據包（§1.3、§1.4）：程式算的數字、持股所屬的族群、價格表、總經儀表板、新聞標題、目錄；研究員可以取文件
//   輸出檢查（§1.5）：固定欄位；引用走 check.ts 的同一個逐字檢查；「不明」是合格的答案
//   結算、匯出、records_guide.md、prompt
// check.ts 沒有動；AI 的回覆一律是假的；對外請求全部是假的（FRED、RSS、網頁、EDGAR、雲端排程），不打真的網站。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DOC_FNS } from '../src/ai/added';
import { judge, type EvidencePack, type PackDoc } from '../src/ai/check';
import { fnInfo } from '../src/ai/functions';
import { PAYLOAD_HOOKS } from '../src/ai/hooks';
import { BRIEF, MARKET_BRIEF, MARKET_BRIEF_PROMPT, MARKET_DOC_TICKER, aiRunTrigger, assignTriggers, briefFacts, briefPeriod, briefResult, briefText, marketBriefPack, planOpen, priceTriggers, provisionalDoc, type BriefEvent, type BriefRowLite, type BriefTrigger, type MarketBrief, type TradingGap } from '../src/ai/marketBrief';
import type { ApplyCtx, StartCtx } from '../src/app/aiCtx';
import { closeStaleRuns, getRun } from '../src/app/aiRuns';
import { APPLIERS } from '../src/app/aiStep';
import type { Env, Fetcher } from '../src/app/env';
import { EXPORT_TABLES } from '../src/app/export';
import { setStateStmt } from '../src/app/filings';
import { runFlow } from '../src/app/flow';
import { loadAccount, saveAccount } from '../src/app/ledgerStore';
import { listedHeadlines } from '../src/app/webEvidence';
import { BRIEF_SCANNED_KEY, applyMarketBrief, briefGroups, briefHoldings, latestBrief, loadBriefs, settleBriefs, startMarketBrief, type BriefRow } from '../src/app/marketBrief';
import { tradingDaysBetween } from '../src/data/calendar';
import { buildMarketView } from '../src/data/marketView';
import { loadSeries, saveRanking } from '../src/data/store';
import { extractPage, fetchWebDoc, findPublishedInText, findReleaseDate, reflowPre, urlDate, WEB_BOT_UA } from '../src/data/webDoc';
import { probeWebPage } from '../src/data/webProbe';
import { WEB_SOURCES, matchWebSource } from '../src/data/webSources';
import { htmlToText } from '../src/data/edgar';
import { createAccount, type Account, type MarketView } from '../src/engine';
import { exportMd, foundView, runDetail, runRow } from '../src/app/site/aiViews';
import { handle } from '../src/index';
import { freshDb } from './helpers/d1';
import { cronTime, fakeFetcher, newWorld } from './helpers/fakeSources';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK = PAYLOAD_HOOKS[MARKET_BRIEF];

// ---------------------------------------------------------------- 假的網頁

const PARA = (s: string, n = 260) => `<p>${s.repeat(Math.ceil(n / s.length))}</p>`;
const article = (title: string, published: string, line: string, extraHead = '') =>
  `<!doctype html><html><head><title>${title} | Site</title><meta property="article:published_time" content="${published}">${extraHead}</head><body><h1>${title}</h1>${Array.from({ length: 8 }, (_, i) => PARA(`Paragraph ${i}: ${line} `)).join('\n')}</body></html>`;
const html = (body: string) => new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } });

const CNBC = 'https://www.cnbc.com/2026/11/05/stock-market-today-live-updates.html';
const CNBC_LINE = 'Stocks tumbled on Thursday after Federal Reserve officials signaled that a December rate cut was not assured.';
const NPR = 'https://www.npr.org/2026/11/05/nx-s1-555/stocks-fall-fed-rate-cut-doubts';
const NPR_LINE = 'Wall Street fell sharply as traders pared bets on a December rate cut following comments from Fed officials.';
const YAHOO = 'https://finance.yahoo.com/news/chip-stocks-slide-memory-prices-210000123.html';
const YAHOO_LINE = 'Chip stocks slid as analysts flagged softer memory contract prices heading into next quarter.';
const PAGES: Record<string, string> = {
  [CNBC]: article('Stocks tumble as rate cut hopes fade', '2026-11-05T21:10:00Z', CNBC_LINE),
  [NPR]: article('Stocks fall on Fed doubts', '2026-11-05T22:00:00Z', NPR_LINE),
  [YAHOO]: article('Chip stocks slide', '2026-11-05T21:00:00Z', YAHOO_LINE, '<script type="application/ld+json">{"datePublished":"2026-11-05T21:00:00.000Z"}</script>'),
};

// 聯準會演講：發布日那一行離第一段內文超過 15 行（標題、講者、地點、分享、影片、投影片…）
const FED_SPEECH_URL = 'https://www.federalreserve.gov/newsevents/speech/waller20261105a.htm';
const FED_SPEECH = `<!doctype html><html><head><title>Speech by Governor Waller on the economic outlook - Federal Reserve Board</title></head><body>
<div>News &amp; Events</div><div>Speeches</div>
<div id="article"><div class="heading"><p class="article__time">November 05, 2026</p><h3 class="title">The Outlook and Monetary Policy</h3><p class="speaker">Governor Christopher J. Waller</p><p class="location">At the Money Marketeers of New York University, New York, New York</p></div>
<div>Share</div><div>Watch Live</div>${Array.from({ length: 9 }, (_, i) => `<div>slide ${i + 1}</div>`).join('')}
${Array.from({ length: 6 }, (_, i) => PARA(`Paragraph ${i}: Thank you for the opportunity to speak with you today about the outlook for the economy and for monetary policy. `, 420)).join('\n')}
</div></body></html>`;

// 利率決議聲明：只有兩段超過 200 字（合計不到 1,500 字）
const FED_STMT_URL = 'https://www.federalreserve.gov/newsevents/pressreleases/monetary20261029a.htm';
const STMT_P1 = 'Recent indicators suggest that growth of economic activity has moderated. Job gains have slowed, and the unemployment rate has edged up but remains low. Inflation has moved up since earlier in the year and remains somewhat elevated. The Committee seeks to achieve maximum employment and inflation at the rate of 2 percent over the longer run.';
const STMT_P2 = 'In support of its goals and in light of the shift in the balance of risks, the Committee decided to lower the target range for the federal funds rate by 1/4 percentage point to 3-1/2 to 3-3/4 percent. In considering additional adjustments to the target range, the Committee will carefully assess incoming data, the evolving outlook, and the balance of risks.';
const FED_STMT = `<!doctype html><html><head><title>Federal Reserve Board - Federal Reserve issues FOMC statement</title></head><body>
<div>Press Releases</div><div id="article"><p class="article__time">October 29, 2026</p><h3 class="title">Federal Reserve issues FOMC statement</h3><p class="releaseTime">For release at 2:00 p.m. EDT</p><div>Share</div>
<p>${STMT_P1}</p><p>${STMT_P2}</p><p>Uncertainty about the economic outlook remains elevated.</p><p>Voting for the monetary policy action were the Chair and eleven members.</p></div></body></html>`;

// 勞工統計局的新聞稿：整篇放在 <pre>，每行固定寬度斷行
function wrap(text: string, width = 88): string {
  const out: string[] = [];
  let line = '';
  for (const w of text.split(' ')) {
    if (line && (line + ' ' + w).length > width) {
      out.push(line);
      line = w;
    } else line = line ? `${line} ${w}` : w;
  }
  if (line) out.push(line);
  return out.join('\n');
}
const BLS_URL = 'https://www.bls.gov/news.release/empsit.nr0.htm';
const BLS_P1 = 'Total nonfarm payroll employment changed little in October (+22,000) and has shown little change since April, the U.S. Bureau of Labor Statistics reported today. The unemployment rate, at 4.4 percent, also changed little. A job gain in health care was partially offset by losses in federal government and in mining, quarrying, and oil and gas extraction.';
const BLS_P2 = 'This news release presents statistics from two monthly surveys. The household survey measures labor force status, including unemployment, by demographic characteristics. The establishment survey measures nonfarm employment, hours, and earnings by industry. For more information about the concepts and statistical methodology used in these two surveys, see the Technical Note.';
const BLS_P3 = 'Both the unemployment rate, at 4.4 percent, and the number of unemployed people, at 7.5 million, changed little in October. The number of long-term unemployed (those jobless for 27 weeks or more) was little changed at 1.9 million and accounted for 25.7 percent of all unemployed people.';
const BLS = `<!doctype html><html><head><title>Employment Situation Summary - 2026 M10 Results</title></head><body><div>Economic News Release</div><div id="bodytext" class="verdana md">
<pre>
Transmission of material in this news release is embargoed until             USDL-26-1487
8:30 a.m. (ET) Friday, November 6, 2026

Technical information:
 Household data:      (202) 691-6378  *  cpsinfo@bls.gov  *  www.bls.gov/cps
 Establishment data:  (202) 691-6555  *  cesinfo@bls.gov  *  www.bls.gov/ces

Media contact:        (202) 691-5902  *  PressOffice@bls.gov


                        THE EMPLOYMENT SITUATION -- OCTOBER 2026


${wrap(BLS_P1)}

${wrap(BLS_P2)}

Household Survey Data

${wrap(BLS_P3)}

 Category                      Oct. 2025   Aug. 2026   Sept. 2026   Oct. 2026
 Unemployment rate                  4.1         4.3          4.3         4.4
 Participation rate                62.6        62.3         62.2        62.2
</pre></div></body></html>`;

// ---------------------------------------------------------------- 共用清單（Y2、§5.1）

describe('T64 共用清單：四個媒體與兩個官方來源（§0.4 Y2、§5.1）', () => {
  it('cnbc.com、finance.yahoo.com、npr.org、fortune.com 都是媒體級；Yahoo Finance 只收文章路徑', () => {
    const of = (u: string) => matchWebSource(new URL(u));
    expect(of(CNBC)).toMatchObject({ domain: 'cnbc.com', tier: 'MEDIA' });
    expect(of(NPR)).toMatchObject({ domain: 'npr.org', tier: 'MEDIA' });
    expect(of('https://fortune.com/2026/11/05/stocks-selloff/')).toMatchObject({ domain: 'fortune.com', tier: 'MEDIA' });
    expect(of(YAHOO)).toMatchObject({ domain: 'finance.yahoo.com', tier: 'MEDIA' });
    // 報價頁、列表頁不是文章
    expect(of('https://finance.yahoo.com/quote/MU/')).toEqual({ miss: 'PATH' });
    expect(of('https://finance.yahoo.com/markets/stocks/most-active/')).toEqual({ miss: 'PATH' });
    // Yahoo 的其他子網域不算
    expect(of('https://sports.yahoo.com/news/x.html')).toEqual({ miss: 'NOT_LISTED' });
  });

  it('M5 抓不到的（Axios、Nasdaq.com、美聯社、MarketWatch）沒有列入', () => {
    for (const d of ['axios.com', 'nasdaq.com', 'apnews.com', 'marketwatch.com']) expect(WEB_SOURCES.some((s) => s.domain === d)).toBe(false);
  });

  it('目錄：一手與指名的產業來源排在媒體前面（新加的財經媒體不會把它們擠出 20 項）；同一級裡新的在前', () => {
    const h = (link: string, at: string, title: string) => ({ link, at, date: at.slice(0, 10), title });
    const menu = listedHeadlines(
      [h(CNBC, '2026-11-05T21:10:00Z', 'cnbc new'), h('https://www.trendforce.com/presscenter/news/20261101-1.html', '2026-11-01T02:00:00Z', 'tf old'), h(YAHOO, '2026-11-05T21:00:00Z', 'yahoo'), h(FED_STMT_URL, '2026-10-29T18:00:00Z', 'fomc'), h('https://www.trendforce.com/news/2026/11/04/x/', '2026-11-04T02:00:00Z', 'tf new')],
      [],
      '2026-11-05',
      '2026-10-01',
    );
    expect(menu.map((e) => e.title)).toEqual(['tf new', 'tf old', 'fomc', 'cnbc new', 'yahoo']);
    expect(menu[2].text).toBe('聯準會（Federal Reserve Board）｜一手｜2026-10-29｜fomc');
  });

  it('聯準會與勞工統計局是一手來源，只收新聞稿、演講、證詞；會議紀錄不收', () => {
    expect(matchWebSource(new URL(FED_SPEECH_URL))).toMatchObject({ domain: 'federalreserve.gov', tier: 'PRIMARY', extract: { urlDate: true } });
    expect(matchWebSource(new URL(FED_STMT_URL))).toMatchObject({ tier: 'PRIMARY' });
    expect(matchWebSource(new URL('https://www.federalreserve.gov/monetarypolicy/fomcminutes20261029.htm'))).toEqual({ miss: 'PATH' });
    expect(matchWebSource(new URL(BLS_URL))).toMatchObject({ domain: 'bls.gov', tier: 'PRIMARY', extract: { pre: true, releaseLine: true } });
    expect(matchWebSource(new URL('https://www.bls.gov/cpi/'))).toEqual({ miss: 'PATH' });
    // 一般的來源沒有自己的擷取方式
    expect((matchWebSource(new URL(CNBC)) as { extract?: unknown }).extract).toBeUndefined();
  });
});

// ---------------------------------------------------------------- 官方來源的擷取與日期（§5.1）

const NOW = new Date('2026-11-21T00:00:00Z');
const one = (url: string, body: string): Fetcher => async (u) => (u === url ? html(body) : new Response('nf', { status: 404 }));

describe('T64 官方來源的擷取與日期（§5.1）', () => {
  it('聯準會演講：發布日那一行離內文太遠，一般的規則認不出來 → 用網址裡的日期', async () => {
    expect(findPublishedInText(htmlToText(FED_SPEECH))).toBeNull();
    const url = new URL(FED_SPEECH_URL);
    expect(extractPage(FED_SPEECH, url).published).toBeNull();
    expect(urlDate(url)).toBe('2026-11-05');
    const d = await fetchWebDoc(one(FED_SPEECH_URL, FED_SPEECH), FED_SPEECH_URL, NOW);
    expect(d).toMatchObject({ status: 'OK', tier: 'PRIMARY', domain: 'federalreserve.gov', published: '2026-11-05', publishedFrom: 'url' });
    expect(d.text).toContain('Thank you for the opportunity to speak');
  });

  it('聯準會的頁面寫得出日期時照舊用頁面上的那一行（不是網址）；網址沒有日期、頁面也沒有 → 認不出發布日', async () => {
    const d = await fetchWebDoc(one(FED_STMT_URL, FED_STMT), FED_STMT_URL, NOW);
    expect(d).toMatchObject({ status: 'OK', published: '2026-10-29', publishedFrom: 'text' });
    const odd = 'https://www.federalreserve.gov/newsevents/speech/remarks.htm';
    expect((await fetchWebDoc(one(odd, FED_SPEECH), odd, NOW)).status).toBe('NO_DATE');
    expect(urlDate(new URL('https://www.federalreserve.gov/newsevents/speech/x20261399a.htm'))).toBeNull();
  });

  it('利率決議聲明：內文只有 700 字上下 → 聯準會的門檻是 400 字，收；同一頁放在一般的來源會是內文太短', async () => {
    const page = extractPage(FED_STMT, new URL(FED_STMT_URL), { minBody: 400, urlDate: true });
    expect(page.body.length).toBeGreaterThan(600);
    expect(page.body.length).toBeLessThan(1500);
    const d = await fetchWebDoc(one(FED_STMT_URL, FED_STMT), FED_STMT_URL, NOW);
    expect(d.status).toBe('OK');
    expect(d.text).toContain('decided to lower the target range for the federal funds rate');
    const other = 'https://www.npr.org/2026/10/29/fomc-statement';
    expect(await fetchWebDoc(one(other, FED_STMT), other, NOW)).toMatchObject({ status: 'THIN' });
  });

  it('勞工統計局的新聞稿：<pre> 裡固定寬度斷行的內文接回成段落，發布日是開頭的發布時間那一行', async () => {
    // 照一般的規則：一段內文都沒有、也認不出日期（M5 量到的「內文擷取是 0 字」）
    const plain = extractPage(BLS, new URL(BLS_URL));
    expect(plain.body.length).toBe(0);
    expect(plain.published).toBeNull();
    const d = await fetchWebDoc(one(BLS_URL, BLS), BLS_URL, NOW);
    expect(d).toMatchObject({ status: 'OK', tier: 'PRIMARY', domain: 'bls.gov', published: '2026-11-06', publishedFrom: 'release-line' });
    // 接回之後整句是連續的：引用可以跨原本的斷行
    expect(d.text).toContain(BLS_P1);
    expect(d.text).toContain(BLS_P3);
    // 表格與對齊的清單照原樣一行一行留著，沒有被接成一長串
    expect(d.text).toMatch(/\nUnemployment rate 4\.1 4\.3 4\.3 4\.4\n/);
    expect(d.text).toMatch(/\nHousehold data: \(202\) 691-6378 \* cpsinfo@bls\.gov \* www\.bls\.gov\/cps\n/);
  });

  it('reflowPre、findReleaseDate：只接像句子的段落；發布時間那一行要在內文之前、以「星期幾, 月 日, 年」結尾', () => {
    const out = reflowPre('<pre>\nline one of a sentence\nline two of it.\n\nA      1.0     2.0\nB      3.0     4.0\n</pre><p>after</p>');
    expect(out).toBe('<p>line one of a sentence line two of it.</p>\n<p>A      1.0     2.0<br>B      3.0     4.0</p><p>after</p>');
    const long = 'x'.repeat(220);
    expect(findReleaseDate(`8:30 a.m. (ET) Thursday, November 12, 2026\nTitle\n${long}`)).toBe('2026-11-12');
    expect(findReleaseDate(`For release 10:00 a.m. (ET) Tuesday, Nov. 3, 2026\n\nTitle\n${long}`)).toBe('2026-11-03');
    // 內文之後的不算；沒有星期幾的不算（那是一般規則的事）
    expect(findReleaseDate(`Title\n${long}\n8:30 a.m. (ET) Thursday, November 12, 2026`)).toBeNull();
    expect(findReleaseDate(`Next release is scheduled for sometime in December 2026\n${long}`)).toBeNull();
    // CPI 新聞稿：同一行後面接著新聞稿編號（2026-11-21 真的頁面）
    expect(findReleaseDate(`Transmission of material in this release is embargoed until\n8:30 a.m. (ET) Tuesday, November 10, 2026      USDL-26-1685\n\nCONSUMER PRICE INDEX - OCTOBER 2026\n${long}`)).toBe('2026-11-10');
  });

  it('勞工統計局擋瀏覽器的 User-Agent：抓它的時候改用寫明是程式的（不含聯絡資料），其他網站照舊', async () => {
    const seen: Record<string, string> = {};
    const f: Fetcher = async (u, init) => {
      const ua = new Headers(init?.headers).get('User-Agent') ?? '';
      seen[new URL(u).hostname] = ua;
      if (u === BLS_URL) return ua === WEB_BOT_UA ? html(BLS) : new Response('denied', { status: 403 });
      return u === FED_SPEECH_URL ? html(FED_SPEECH) : new Response('nf', { status: 404 });
    };
    expect(await fetchWebDoc(f, BLS_URL, NOW)).toMatchObject({ status: 'OK', published: '2026-11-06' });
    expect(await fetchWebDoc(f, FED_SPEECH_URL, NOW)).toMatchObject({ status: 'OK' });
    expect(seen['www.bls.gov']).toBe(WEB_BOT_UA);
    expect(seen['www.federalreserve.gov']).toMatch(/^Mozilla\//);
    expect(WEB_BOT_UA).not.toMatch(/@|mailto|https?:/);
    seen['www.bls.gov'] = '';
    expect(await probeWebPage(f, BLS_URL)).toMatchObject({ ok: true, published: '2026-11-06' });
    expect(seen['www.bls.gov']).toBe(WEB_BOT_UA);
  });

  it('沒有寫擷取方式的來源照舊：<pre> 不接、門檻 1,500 字、不看網址與發布時間那一行', async () => {
    const u = 'https://www.cnbc.com/2026/11/06/empsit20261106a.htm';
    const d = await fetchWebDoc(one(u, BLS), u, NOW);
    expect(d.status).toBe('THIN');
    expect(extractPage(PAGES[CNBC], new URL(CNBC))).toMatchObject({ minBody: 1500, published: { date: '2026-11-05', from: 'meta' } });
  });

  it('量測用的 /admin/web/test 用同一套認法（部署後可以重測官方來源）', async () => {
    expect(await probeWebPage(one(BLS_URL, BLS), BLS_URL)).toMatchObject({ ok: true, published: '2026-11-06', publishedFrom: 'release-line', blockedHint: null });
    expect(await probeWebPage(one(FED_SPEECH_URL, FED_SPEECH), FED_SPEECH_URL)).toMatchObject({ ok: true, published: '2026-11-05', publishedFrom: 'url' });
    expect(await probeWebPage(one(FED_STMT_URL, FED_STMT), FED_STMT_URL)).toMatchObject({ ok: true, published: '2026-10-29', publishedFrom: 'text' });
  });
});

// ---------------------------------------------------------------- 假的市場（純函式與排程共用）

const DAYS = tradingDaysBetween('2025-06-02', '2026-12-31');
const UNIVERSE = Array.from({ length: 10 }, (_, k) => `UA${k}`);
const TICKERS = ['VOO', 'SPY', 'SGOV', 'XLK', 'XLE', 'XLF', 'NVDA', 'MU', 'XOM', ...UNIVERSE];
/** 代號 → 日期 → 那一天的漲跌（沒寫的日子是 0）。 */
type Moves = Record<string, Record<string, number>>;
function market(asOf: string, moves: Moves = {}): { view: MarketView; axis: string[] } {
  const axis = DAYS.filter((d) => d <= asOf);
  const close: Record<string, Float64Array> = {};
  for (const t of TICKERS) {
    const a = new Float64Array(axis.length);
    let p = 100;
    axis.forEach((d, k) => {
      p *= 1 + (moves[t]?.[d] ?? 0);
      a[k] = p;
    });
    close[t] = a;
  }
  return { view: { date: asOf, i: axis.length - 1, close }, axis };
}
/** D 之後第 n 個交易日。 */
const after = (d: string, n: number) => DAYS[DAYS.indexOf(d) + n];
const gap: TradingGap = (a, b) => (a >= b ? 0 : tradingDaysBetween(a, b).length - 1);
const D = '2026-11-05';
/** 整個市場一起動：核心 ETF、SPY 與三個產業 ETF 同一天同樣的漲跌（族群沒有比大盤多跌或多漲）。 */
const both = (date: string, r: number): Moves => Object.fromEntries(['VOO', 'SPY', 'XLK', 'XLE', 'XLF'].map((t) => [t, { [date]: r }]));
const merge = (...ms: Moves[]): Moves => {
  const out: Moves = {};
  for (const m of ms) for (const [t, v] of Object.entries(m)) out[t] = { ...(out[t] ?? {}), ...v };
  return out;
};

// ---------------------------------------------------------------- 觸發（§1.2，純函式）

describe('T64 觸發的門檻（§1.2）', () => {
  const at = (moves: Moves, date = D) => {
    const { view, axis } = market(date, moves);
    return priceTriggers(axis, view.close, view.i, 'VOO', ['XLK', 'XLE']);
  };

  it('大盤單日 ±2.5% 以上才算；2.4% 不算', () => {
    expect(at(both(D, -0.024))).toEqual([]);
    expect(at(both(D, -0.025))).toEqual([expect.objectContaining({ session: D, kind: 'MARKET_DAY', group: null, text: `VOO ${D} 單日 -2.5%（門檻 2.5%）` })]);
    expect(at(both(D, 0.031)).map((t) => [t.kind, t.text])).toEqual([['MARKET_DAY', `VOO ${D} 單日 +3.1%（門檻 2.5%）`]]);
    // 大盤跌 3%、某個持股族群那天沒跌：它比大盤「多漲」3 個百分點，也算族群的觸發
    expect(at(merge(both(D, -0.03), { XLE: { [D]: 0 } })).map((t) => [t.kind, t.group])).toEqual([
      ['MARKET_DAY', null],
      ['GROUP_DAY', 'XLE'],
    ]);
  });

  it('持股的產業 ETF 單日比大盤多跌或多漲 3 個百分點以上才算；2.9 不算；不是持股族群的不看', () => {
    expect(at({ XLK: { [D]: -0.029 } })).toEqual([]);
    const hit = at(merge(both(D, -0.005), { XLK: { [D]: -0.04 }, XLE: { [D]: 0.03 }, XLF: { [D]: -0.09 } }));
    expect(hit.map((t) => [t.kind, t.group])).toEqual([
      ['GROUP_DAY', 'XLE'],
      ['GROUP_DAY', 'XLK'],
    ]);
    expect(hit[1].text).toBe(`XLK ${D} 單日 -4.0%，比 VOO 多跌 3.5 個百分點（門檻 3 個百分點）`);
    expect(hit[0].text).toContain('比 VOO 多漲 3.5 個百分點');
  });

  it('累積：核心 ETF 21 個交易日跌 10% 以上', () => {
    const slide = (pct: number): Moves => {
      const m: Record<string, number> = {};
      for (let k = 0; k < BRIEF.cumDays; k++) m[after(D, -k)] = pct;
      return { VOO: m, SPY: m };
    };
    expect(at(slide(-0.0045))).toEqual([]); // 約 -9.0%
    expect(at(slide(-0.0055)).map((t) => t.kind)).toEqual(['CUMULATIVE']); // 約 -10.9%，單日都不到 2.5%
  });
});

describe('T64 觸發歸到哪個事件（§1.2、§5.2）', () => {
  const T = (kind: BriefTrigger['kind'], session = D): BriefTrigger => ({ session, kind, group: null, value: null, text: kind });
  const row = (session: string, o: Partial<BriefRowLite> = {}): BriefRowLite => ({ eventId: session, stage: 'PROVISIONAL', session, status: 'READY', ...o });
  const ev = (id: string, last = id): BriefEvent => ({ id, first: id, last });

  it('第一次觸發是新的事件；10 個交易日內又觸發算同一個事件，第 11 個交易日是新的', () => {
    expect(assignTriggers(D, [T('MARKET_DAY')], null, [], gap)).toEqual({ eventId: D, triggers: [T('MARKET_DAY')] });
    const d10 = after(D, 10);
    const d11 = after(D, 11);
    expect(assignTriggers(d10, [T('MARKET_DAY', d10)], ev(D), [row(D)], gap)?.eventId).toBe(D);
    expect(assignTriggers(d11, [T('MARKET_DAY', d11)], ev(D), [row(D)], gap)?.eventId).toBe(d11);
    // 接著算：最後一次觸發往後延，事件跟著延長
    expect(assignTriggers(after(D, 14), [T('GROUP_DAY', after(D, 14))], ev(D, after(D, 6)), [row(D)], gap)?.eventId).toBe(D);
  });

  it('事件已經開過定稿 → 之後的觸發是新的事件', () => {
    const d3 = after(D, 13);
    expect(assignTriggers(d3, [T('MARKET_DAY', d3)], ev(D, after(D, 4)), [row(D), row(after(D, 12), { eventId: D, stage: 'FINAL', status: 'FAILED' })], gap)?.eventId).toBe(d3);
  });

  it('累積：最近 21 個交易日開過摘要（不管成功失敗）就不算', () => {
    const day = after(D, 21);
    expect(assignTriggers(day, [T('CUMULATIVE', day)], null, [row(D, { status: 'FAILED' })], gap)).toBeNull();
    expect(assignTriggers(after(D, 22), [T('CUMULATIVE', after(D, 22))], null, [row(D)], gap)?.triggers).toHaveLength(1);
  });

  it('當天有減半檢視或提前審查：最近 5 個交易日有摘要（還在跑或寫好的）就不算；失敗的不算有', () => {
    const ai = (day: string) => aiRunTrigger(day, ['2026-11-12_OWN_DROP_MU_aaaaaa']);
    const d5 = after(D, 5);
    const d6 = after(D, 6);
    expect(assignTriggers(d5, [ai(d5)], ev(D), [row(D, { status: 'PENDING' })], gap)).toBeNull();
    expect(assignTriggers(d6, [ai(d6)], ev(D), [row(D)], gap)).toMatchObject({ eventId: D, triggers: [{ kind: 'AI_RUN' }] });
    expect(assignTriggers(d5, [ai(d5)], null, [row(D, { status: 'FAILED' })], gap)?.triggers).toHaveLength(1);
    // 同一天也有大盤的觸發：大盤的照記，個股執行的那一個不算
    expect(assignTriggers(d5, [T('MARKET_DAY', d5), ai(d5)], ev(D), [row(D)], gap)?.triggers.map((t) => t.kind)).toEqual(['MARKET_DAY']);
  });
});

describe('T64 開不開（§1.2：頻率上限、定稿、一個訊號日最多一次）', () => {
  const row = (session: string, o: Partial<BriefRowLite> = {}): BriefRowLite => ({ eventId: D, stage: 'PROVISIONAL', session, status: 'READY', ...o });
  const ev = (last = D, id = D): BriefEvent => ({ id, first: id, last });

  it('平靜的日子不開（不設每月固定的一次）；當天有觸發 → 開暫定稿', () => {
    expect(planOpen(D, [], [], gap).open).toBeNull();
    expect(planOpen(after(D, 3), [ev()], [row(D)], gap).open).toBeNull();
    expect(planOpen(D, [ev()], [], gap).open).toMatchObject({ eventId: D, stage: 'PROVISIONAL' });
  });

  it('一個訊號日最多開一次：今天那一份還在跑或寫好了就不再開', () => {
    expect(planOpen(D, [ev()], [row(D, { status: 'PENDING' })], gap).open).toBeNull();
    expect(planOpen(D, [ev()], [row(D)], gap).open).toBeNull();
  });

  it('10 個交易日內最多 1 份暫定稿：第 9 個交易日又觸發不開（寫進紀錄），第 10 個交易日觸發才開', () => {
    const d9 = after(D, 9);
    const blocked = planOpen(d9, [ev(d9)], [row(D)], gap);
    expect(blocked.open).toBeNull();
    expect(blocked.log.join()).toContain('10 個交易日內最多 1 份');
    const d10 = after(D, 10);
    expect(planOpen(d10, [ev(d10)], [row(D)], gap).open).toMatchObject({ eventId: D, stage: 'PROVISIONAL' });
    // 被上限擋下的那一次觸發，隔天上限過了也不補開（那一天沒有新的觸發）
    expect(planOpen(d10, [ev(d9)], [row(D)], gap).open).toBeNull();
  });

  it('定稿：最後一次觸發之後第 10 個交易日；第 9 個交易日還不開；又觸發就往後延', () => {
    expect(planOpen(after(D, 9), [ev()], [row(D)], gap).open).toBeNull();
    expect(planOpen(after(D, 10), [ev()], [row(D)], gap).open).toMatchObject({ eventId: D, stage: 'FINAL' });
    // 第 4 個交易日又觸發過：定稿延到第 14 個交易日
    const last = after(D, 4);
    expect(planOpen(after(D, 10), [ev(last)], [row(D)], gap).open).toBeNull();
    expect(planOpen(after(D, 14), [ev(last)], [row(D)], gap).open).toMatchObject({ stage: 'FINAL', why: expect.stringContaining(`最後一次觸發（${last}）之後第 10 個交易日`) });
    // 定稿寫好了就不再開
    expect(planOpen(after(D, 15), [ev(last)], [row(D), row(after(D, 14), { stage: 'FINAL' })], gap).open).toBeNull();
  });

  it('沒有成功的再試一次，最多 2 次：暫定稿只在最後一次觸發之後 2 個交易日內再試；定稿到期之後 5 個交易日內再試', () => {
    const failed = (session: string, o: Partial<BriefRowLite> = {}) => row(session, { status: 'FAILED', ...o });
    // 當天失敗一次 → 同一天（01:30）再試；兩次都失敗 → 不再開
    expect(planOpen(D, [ev()], [failed(D)], gap).open).toMatchObject({ stage: 'PROVISIONAL', why: expect.stringContaining('再試一次') });
    const twice = planOpen(D, [ev()], [failed(D), failed(D)], gap);
    expect(twice.open).toBeNull();
    expect(planOpen(after(D, 1), [ev()], [failed(D), failed(D)], gap).log.join()).toContain('已經失敗 2 次');
    // 當天一次都沒開成（雲端排程沒設定、流程出錯）→ 2 個交易日內補開；第 3 個交易日不補
    expect(planOpen(after(D, 2), [ev()], [], gap).open).toMatchObject({ stage: 'PROVISIONAL' });
    expect(planOpen(after(D, 3), [ev()], [], gap).open).toBeNull();
    // 沒有暫定稿的事件，定稿到期時照寫；定稿失敗 → 隔天再試一次；到期超過 5 個交易日就不寫
    expect(planOpen(after(D, 10), [ev()], [failed(D), failed(D)], gap).open).toMatchObject({ stage: 'FINAL' });
    expect(planOpen(after(D, 11), [ev()], [row(D), failed(after(D, 10), { stage: 'FINAL' })], gap).open).toMatchObject({ stage: 'FINAL', why: expect.stringContaining('再試一次') });
    expect(planOpen(after(D, 12), [ev()], [row(D), failed(after(D, 10), { stage: 'FINAL' }), failed(after(D, 11), { stage: 'FINAL' })], gap).open).toBeNull();
    expect(planOpen(after(D, 16), [ev()], [row(D)], gap).open).toBeNull();
  });

  it('期間往前涵蓋：單日的觸發從前一個交易日的收盤算起，累積的從 21 個交易日前算起', () => {
    const { axis } = market(after(D, 4));
    expect(briefPeriod(axis, [{ session: D, kind: 'MARKET_DAY' }], D)).toEqual({ from: after(D, -1), to: D });
    expect(briefPeriod(axis, [{ session: D, kind: 'GROUP_DAY' }, { session: after(D, 4), kind: 'MARKET_DAY' }], after(D, 4))).toEqual({ from: after(D, -1), to: after(D, 4) });
    expect(briefPeriod(axis, [{ session: D, kind: 'CUMULATIVE' }], D)).toEqual({ from: after(D, -21), to: D });
    expect(briefPeriod(axis, [{ session: D, kind: 'AI_RUN' }], D)).toEqual({ from: after(D, -21), to: D });
  });
});

// ---------------------------------------------------------------- 輸出檢查（§1.5，純函式）

const WEB = (id: string, domain: string, date: string, text: string, tier: 'MEDIA' | 'PRIMARY' = 'MEDIA'): PackDoc => ({ id, source_id: `web:${id}`, kind: 'web', date, title: `〔網頁｜${domain}〕${id}`, url: `https://www.${domain}/${id}`, text, tier, domain, label: domain }) as PackDoc;
const DOC = {
  cnbc: WEB('cnbc1', 'cnbc.com', D, `${CNBC_LINE} Treasury yields rose.`),
  npr: WEB('npr1', 'npr.org', D, `${NPR_LINE} The S&P 500 lost ground.`),
  cnbc2: WEB('cnbc2', 'cnbc.com', D, 'Hedge funds cut leverage at the fastest pace since 2022, according to prime brokerage data.'),
  yahoo: WEB('yahoo1', 'finance.yahoo.com', D, `${YAHOO_LINE} Memory makers led the decline.`),
  news: { id: 'N-SPY', source_id: 'yahoo-rss:SPY', kind: 'news', date: D, title: '大盤相關的新聞標題（SPY，只有標題）', text: `${D} | Stocks sink as traders rethink December rate cut\n${D} | Tech leads market lower` } as PackDoc,
  macro: { id: 'DASH', source_id: `macro:${D}`, kind: 'table', date: D, title: '總經儀表板', text: 'VIXCLS VIX | 2026-11-05 | 28.40 | 9.10 | - | - | ' } as PackDoc,
};
const Q = {
  cnbc: 'Federal Reserve officials signaled that a December rate cut was not assured',
  npr: 'traders pared bets on a December rate cut',
  flow: 'Hedge funds cut leverage at the fastest pace since 2022',
  yahoo: 'analysts flagged softer memory contract prices',
  news: 'Stocks sink as traders rethink December rate cut',
};
type Cite = Pick<PackDoc, 'source_id' | 'date'>;
const E = (id: string, doc: Cite, quote: string) => ({ id, source_id: doc.source_id, date: doc.date, quote, claim: '報導這樣寫' });
const EVID = [E('E1', DOC.cnbc, Q.cnbc), E('E2', DOC.npr, Q.npr), E('E3', DOC.cnbc2, Q.flow), E('E4', DOC.yahoo, Q.yahoo), E('E5', DOC.news, Q.news)];

const MOVES = merge(both(D, -0.036), { XLK: { [D]: -0.07 }, NVDA: { [D]: -0.09 }, MU: { [D]: -0.12 }, ...Object.fromEntries(UNIVERSE.slice(0, 7).map((t) => [t, { [D]: -0.02 }])) });
const TRIG: BriefTrigger[] = (() => {
  const { view, axis } = market(D, MOVES);
  return priceTriggers(axis, view.close, view.i, 'VOO', ['XLK']);
})();
const GROUPS = [{ etf: 'XLK', members: [{ ticker: 'MU', role: 'MOM' as const }, { ticker: 'NVDA', role: 'OWN' as const }] }];

function purePack(o: { stage?: 'PROVISIONAL' | 'FINAL'; provisional?: MarketBrief | null; asOf?: string } = {}): EvidencePack {
  const asOf = o.asOf ?? D;
  const { view, axis } = market(asOf, MOVES);
  const period = briefPeriod(axis, TRIG, asOf);
  const { facts } = briefFacts({ axis, close: view.close, i: view.i, core: 'VOO', groups: GROUPS, ungrouped: [{ ticker: 'XOM', role: 'MOM' }], universe: UNIVERSE, period, triggers: TRIG });
  return marketBriefPack({ runId: 'brief-test', asOf, stage: o.stage ?? 'PROVISIONAL', eventId: D, period, core: 'VOO', groups: GROUPS, triggers: TRIG, facts, docs: Object.values(DOC), dataQuality: { prices: 'ok', macro: 'ok', news: 'partial' }, provisional: o.provisional ?? null, webDomains: ['cnbc.com', 'npr.org'], now: new Date(`${asOf}T23:30:00Z`) }).pack;
}
const K = (pack: EvidencePack, part: string) => pack.facts.find((f) => /^K/.test(f.id) && f.value.includes(part))!.value;

function goodPayload(pack: EvidencePack): Record<string, unknown> {
  const d = pack.rule.detail as { period: unknown; stage: string };
  return {
    period: d.period,
    stage: d.stage,
    facts: [K(pack, '單日 -3.6%'), K(pack, `，${D} 下跌的有 70%`)],
    causes: [
      { scope: 'MARKET', group: null, kind: 'POLICY', text: '報導指出聯準會官員的談話讓市場下修 12 月降息的預期', confidence: 'HIGH', evidence_ids: ['E1', 'E2'] },
      { scope: 'GROUP', group: 'XLK', kind: 'SECTOR_NEWS', text: '報導指出記憶體報價轉弱拖累半導體類股', confidence: 'MEDIUM', evidence_ids: ['E4'] },
    ],
    unknown: false,
    clarity: 'HIGH',
    changed_since_provisional: null,
  };
}
const sampleOf = (pack: EvidencePack, payload: unknown, ev: unknown[] = EVID) => ({ run_id: pack.run_id, function: MARKET_BRIEF, verdict: 'DONE', evidence: ev, payload, report: '11-05 大盤跌 3.6%，報導主要歸因於降息預期下修。\n\n細節。' });
function briefOf(payload: unknown, o: { pack?: EvidencePack; ev?: unknown[] } = {}) {
  const pack = o.pack ?? purePack();
  const outcome = judge(pack, [sampleOf(pack, payload, o.ev)], HOOK);
  return { pack, outcome, result: briefResult(outcome, pack)! };
}
const okBrief = (payload: unknown, o: Parameters<typeof briefOf>[1] = {}): MarketBrief => {
  const { result } = briefOf(payload, o);
  if (!result.ok) throw new Error(result.why);
  return result.brief;
};
const failWhy = (payload: unknown, o: Parameters<typeof briefOf>[1] = {}): string => {
  const { result } = briefOf(payload, o);
  expect(result.ok).toBe(false);
  return (result as { why: string }).why;
};
const withP = (pack: EvidencePack, patch: Record<string, unknown>) => ({ ...goodPayload(pack), ...patch });

describe('T64 證據包（§1.3、§1.4，純函式）', () => {
  it('等級比照草稿：A2、一份；沒有前提、沒有條件種類；題目寫明只說明、不明是合格的答案', () => {
    const pack = purePack();
    expect(pack).toMatchObject({ function: 'MARKET_BRIEF', prompt_version: MARKET_BRIEF_PROMPT, as_of: D, premises: [], condition_types: [], subject: { name: '市場摘要（暫定稿）' }, policy: { level: 'A2', samples: 1, verdicts: ['DONE', 'INSUFFICIENT'], abstain: 'INSUFFICIENT' } });
    expect(pack.subject.ticker).toBeUndefined();
    expect(pack.rule.detail).toMatchObject({ stage: 'PROVISIONAL', eventId: D, period: { from: after(D, -1), to: D }, core: 'VOO', groups: ['XLK'], hasProvisional: false });
    expect(pack.question).toContain('不下單、不改任何狀態');
    expect(pack.question).toContain('原因不明（unknown = true），這是合格的答案');
    expect(pack.question).toContain('kind = FLOW）信心只能寫 LOW');
  });

  it('程式算的數字（K）：大盤與族群的漲跌、比大盤多跌幾個百分點、股票池下跌的比例；族群只列代號；個股的漲跌另外列（H）', () => {
    const pack = purePack();
    const k = pack.facts.filter((f) => /^K\d+$/.test(f.id)).map((f) => f.value);
    expect(k).toEqual(expect.arrayContaining([`VOO ${after(D, -1)}～${D} 漲跌 -3.6%`, `VOO ${D} 單日 -3.6%`, `VOO 到 ${D} 為止的 21 個交易日 -3.6%`, `VOO ${D} 的收盤距 52 週高點 -3.6%`, `股票池 10 檔裡，${D} 下跌的有 70%`, `XLK ${after(D, -1)}～${D} 漲跌 -7.0%，比 VOO 多跌 3.4 個百分點`, `XLK ${D} 單日 -7.0%，比 VOO 多跌 3.4 個百分點`]));
    expect(pack.facts.filter((f) => /^G/.test(f.id)).map((f) => f.value)).toEqual(['XLK：MU（動能）、NVDA（自選）', 'XOM（動能）']);
    expect(pack.facts.filter((f) => /^H/.test(f.id)).map((f) => f.value)).toEqual([`MU（XLK） ${after(D, -1)}～${D} 漲跌 -12.0%`, `NVDA（XLK） ${after(D, -1)}～${D} 漲跌 -9.0%`, `XOM ${after(D, -1)}～${D} 漲跌 +0.0%`]);
    expect(pack.facts.filter((f) => /^T/.test(f.id)).map((f) => f.label)).toEqual(['觸發：大盤大漲跌', '觸發：族群大漲跌']);
  });
});

describe('T64 輸出檢查（§1.5）：通過的摘要', () => {
  it('寫好的摘要通過，整理成固定的形狀；引用帶出處（級別、網域）', () => {
    const pack = purePack();
    const b = okBrief(goodPayload(pack), { pack });
    expect(b).toMatchObject({ event_id: D, as_of: D, stage: 'PROVISIONAL', period: { from: after(D, -1), to: D }, unknown: false, clarity: 'HIGH', changed_since_provisional: null, groups: ['XLK'], core: 'VOO', dropped: [], notes: [] });
    expect(b.facts).toEqual([`VOO ${D} 單日 -3.6%`, `股票池 10 檔裡，${D} 下跌的有 70%`]);
    expect(b.causes).toEqual([
      { scope: 'MARKET', group: null, kind: 'POLICY', text: '報導指出聯準會官員的談話讓市場下修 12 月降息的預期', confidence: 'HIGH', evidence_ids: ['E1', 'E2'], headline_only: false, lowered: null },
      // 只有一個網域的全文：MEDIUM 照收
      { scope: 'GROUP', group: 'XLK', kind: 'SECTOR_NEWS', text: '報導指出記憶體報價轉弱拖累半導體類股', confidence: 'MEDIUM', evidence_ids: ['E4'], headline_only: false, lowered: null },
    ]);
    expect(b.evidence.map((e) => [e.id, e.kind, e.tier, e.domain])).toEqual([
      ['E1', 'web', 'MEDIA', 'cnbc.com'],
      ['E2', 'web', 'MEDIA', 'npr.org'],
      ['E4', 'web', 'MEDIA', 'finance.yahoo.com'],
    ]);
    expect(b.evidence[0]).toMatchObject({ quote: Q.cnbc, url: 'https://www.cnbc.com/cnbc1' });
  });

  it('「不明」是合格的答案：causes 是空的、unknown = true → 通過（不算失敗）', () => {
    const pack = purePack();
    const { outcome, result } = briefOf(withP(pack, { causes: [], unknown: true, clarity: 'LOW' }), { pack, ev: [] });
    expect(outcome).toMatchObject({ status: 'AGREED', verdict: 'DONE' });
    expect(result).toMatchObject({ ok: true, brief: { causes: [], unknown: true, clarity: 'LOW', evidence: [] } });
  });

  it('有說法但整體說不通：unknown = true 和 causes 可以並存', () => {
    const pack = purePack();
    const b = okBrief(withP(pack, { unknown: true, clarity: 'LOW' }), { pack });
    expect(b.unknown).toBe(true);
    expect(b.causes).toHaveLength(2);
  });

  it('研究員自己說資料不夠（INSUFFICIENT）→ 沒有摘要，原因分得出來', () => {
    const pack = purePack();
    const outcome = judge(pack, [{ ...sampleOf(pack, {}), verdict: 'INSUFFICIENT', abstain_reason: '價格與新聞都抓不到' }], HOOK);
    expect(briefResult(outcome, pack)).toEqual({ ok: false, why: '研究員認為資料不夠寫摘要：價格與新聞都抓不到' });
    expect(briefResult(null, pack)).toBeNull();
  });
});

describe('T64 輸出檢查（§1.5）：整份退回的', () => {
  const pack = purePack();
  it('period、stage 和證據包不同', () => {
    expect(failWhy(withP(pack, { period: { from: '2026-11-01', to: D } }), { pack })).toContain(`period 要照證據包寫（${after(D, -1)}～${D}）`);
    expect(failWhy(withP(pack, { stage: 'FINAL' }), { pack })).toContain('stage 要是 PROVISIONAL');
  });
  it('facts 不是陣列，或沒有任何一條是原樣抄的', () => {
    expect(failWhy(withP(pack, { facts: 'VOO 跌了' }), { pack })).toContain('facts 要是陣列');
    expect(failWhy(withP(pack, { facts: ['VOO 單日大跌 3.6%', 'XLK 跌更多'] }), { pack })).toContain('facts 至少要有一條照證據包（K 開頭）原樣抄的數字');
    // H（個股）不能抄進 facts
    expect(failWhy(withP(pack, { facts: [pack.facts.find((f) => f.id === 'H1')!.value] }), { pack })).toContain('facts 至少要有一條');
  });
  it('causes 不是陣列；unknown、clarity 的格式不對', () => {
    expect(failWhy(withP(pack, { causes: null }), { pack })).toContain('causes 要是陣列');
    expect(failWhy(withP(pack, { unknown: 'no' }), { pack })).toContain('unknown 要是 true 或 false');
    expect(failWhy(withP(pack, { clarity: 'MEDIUM' }), { pack })).toContain('clarity 要是 HIGH 或 LOW');
  });
  it('程式檢查沒過的那一票算成證據不足（整份退回），原因寫進 issues', () => {
    const { outcome } = briefOf(withP(pack, { stage: 'FINAL' }), { pack });
    expect(outcome.status).toBe('INSUFFICIENT');
    expect(outcome.samples[0].issues).toEqual([expect.stringContaining('摘要檢查：stage 要是 PROVISIONAL')]);
  });
});

describe('T64 輸出檢查（§1.5）：只拿掉那一條、調低信心', () => {
  const pack = purePack();
  const cause = (o: Record<string, unknown>) => ({ scope: 'MARKET', group: null, kind: 'POLICY', text: '報導指出降息預期下修', confidence: 'MEDIUM', evidence_ids: ['E1'], ...o });

  it('不是原樣抄的數字拿掉（改了一個字也不行），原樣的留著', () => {
    const b = okBrief(withP(pack, { facts: [K(pack, '單日 -3.6%'), `VOO ${D} 單日 -3.7%`, 'XLK 跌更多'] }), { pack });
    expect(b.facts).toEqual([`VOO ${D} 單日 -3.6%`]);
    expect(b.dropped).toEqual([
      { what: 'FACT', text: `VOO ${D} 單日 -3.7%`, why: '不是證據包給的數字（K 開頭）原樣' },
      { what: 'FACT', text: 'XLK 跌更多', why: '不是證據包給的數字（K 開頭）原樣' },
    ]);
  });

  it('引用走 check.ts 的同一個逐字檢查：改寫過的引用不算，那個原因被拿掉；全部被拿掉 → 原因不明', () => {
    const ev = [E('E1', DOC.cnbc, 'Fed officials signalled a December rate cut is not assured'), E('E2', { source_id: 'web:nowhere', date: D }, Q.npr)];
    const { outcome, result } = briefOf(withP(pack, { causes: [cause({ evidence_ids: ['E1', 'E2'] })], clarity: 'LOW' }), { pack, ev });
    expect(outcome.samples[0].evidence.map((e) => [e.ok, e.why])).toEqual([
      [false, '引用不是原文的子字串'],
      [false, '來源 web:nowhere 不在證據包裡'],
    ]);
    expect(result).toMatchObject({ ok: true, brief: { causes: [], unknown: true, dropped: [{ what: 'CAUSE', text: '報導指出降息預期下修', why: '沒有通過逐字檢查的引用' }], notes: ['寫的原因都沒有通過檢查，改成原因不明'] } });
  });

  it('格式不對、族群不在證據包裡、沒有引用、超過 6 條的原因各自拿掉，其他照收', () => {
    const many = Array.from({ length: 5 }, (_, k) => cause({ text: `報導的說法 ${k}` }));
    const b = okBrief(withP(pack, { causes: [cause({ kind: 'RUMOR' }), cause({ scope: 'GROUP', group: 'XLE', text: '能源股的說法' }), cause({ evidence_ids: [], text: '沒有引用的說法' }), cause({ text: '字'.repeat(201) }), ...many, cause({ text: '第十條' })], clarity: 'LOW' }), { pack });
    expect(b.causes.map((c) => c.text)).toEqual(['報導的說法 0', '報導的說法 1']);
    expect(b.dropped.map((d) => d.why)).toEqual([expect.stringContaining('格式不對'), '族群 XLE 不在證據包列的產業 ETF 裡', '沒有通過逐字檢查的引用', expect.stringContaining('格式不對'), '超過 6 條', '超過 6 條', '超過 6 條', '超過 6 條']);
    expect(b.unknown).toBe(false);
  });

  it('資金面的原因（FLOW）在暫定稿只能是 LOW；定稿可以照寫', () => {
    const p = withP(pack, { causes: [cause({ kind: 'FLOW', text: '報導指出避險基金去槓桿', confidence: 'MEDIUM', evidence_ids: ['E3'] })], clarity: 'LOW' });
    expect(okBrief(p, { pack }).causes[0]).toMatchObject({ kind: 'FLOW', confidence: 'LOW', lowered: 'AI 寫的是中：資金面的原因在暫定稿只能是低' });
    const fin = purePack({ stage: 'FINAL' });
    expect(okBrief({ ...p, period: (fin.rule.detail as { period: unknown }).period, stage: 'FINAL', facts: [K(fin, '單日 -3.6%')] }, { pack: fin }).causes[0]).toMatchObject({ confidence: 'MEDIUM', lowered: null });
  });

  it('引用只有新聞標題（沒有讀到全文）→ 只能是 LOW，標出來', () => {
    const b = okBrief(withP(pack, { causes: [cause({ confidence: 'HIGH', evidence_ids: ['E5'] })], clarity: 'LOW' }), { pack });
    expect(b.causes[0]).toMatchObject({ confidence: 'LOW', headline_only: true, lowered: expect.stringContaining('引用只有新聞標題') });
    expect(b.evidence[0]).toMatchObject({ kind: 'news', tier: null, domain: null });
  });

  it('HIGH 要有兩個不同網域的網頁全文：同一個網域的兩篇只能是 MEDIUM；clarity 也一樣', () => {
    const b = okBrief(withP(pack, { causes: [cause({ confidence: 'HIGH', evidence_ids: ['E1', 'E3'] })], clarity: 'HIGH' }), { pack });
    expect(b.causes[0]).toMatchObject({ confidence: 'MEDIUM', lowered: 'AI 寫的是高：高要有兩個不同網域的網頁全文' });
    expect(b.clarity).toBe('LOW');
    expect(b.notes).toEqual(['引用的網頁不到兩個不同的網域，談不上各來源一致，clarity 改成 LOW']);
  });

  it('沒有列原因、unknown 卻寫 false → 程式改成原因不明', () => {
    const b = okBrief(withP(pack, { causes: [], unknown: false, clarity: 'LOW' }), { pack });
    expect(b).toMatchObject({ unknown: true, notes: ['沒有列出原因，改成原因不明'] });
  });
});

describe('T64 定稿（§1.2、§1.5）', () => {
  const prov = okBrief(goodPayload(purePack()));
  const asOf = after(D, 10);

  it('定稿的證據包附這個事件的暫定稿當背景（note）；題目寫明要對照', () => {
    const pack = purePack({ stage: 'FINAL', provisional: prov, asOf });
    expect(pack.rule.detail).toMatchObject({ stage: 'FINAL', hasProvisional: true, period: { from: after(D, -1), to: asOf } });
    expect(pack.subject.name).toBe('市場摘要（定稿）');
    const note = pack.documents.find((d) => d.source_id === `brief-prev:${D}`)!;
    expect(note).toMatchObject({ kind: 'note', date: asOf });
    expect(note.title).toContain('背景，不是證據，不能引用');
    expect(note.text).toContain('報導的說法（引用只證明報導這樣寫，不證明因果）');
    expect(note.text).toContain('〔大盤｜政策｜信心高〕報導指出聯準會官員的談話讓市場下修 12 月降息的預期');
    expect(pack.question).toContain('對照附上的暫定稿');
    expect(provisionalDoc(prov, asOf).source_id).toBe(note.source_id);
  });

  it('有暫定稿的定稿要寫 changed_since_provisional；沒寫、太長 → 整份退回', () => {
    const pack = purePack({ stage: 'FINAL', provisional: prov, asOf });
    const base = { ...goodPayload(pack), facts: [K(pack, `${D} 單日 -3.6%`)] };
    expect(failWhy({ ...base, changed_since_provisional: null }, { pack })).toContain('定稿要寫 changed_since_provisional');
    expect(failWhy({ ...base, changed_since_provisional: '字'.repeat(601) }, { pack })).toContain('超過 600 字');
    expect(okBrief({ ...base, changed_since_provisional: '和暫定稿相同；資金面的說法後來沒有報導跟進' }, { pack })).toMatchObject({ stage: 'FINAL', changed_since_provisional: '和暫定稿相同；資金面的說法後來沒有報導跟進' });
  });

  it('沒有暫定稿的事件：定稿可以不寫 changed_since_provisional', () => {
    const pack = purePack({ stage: 'FINAL', asOf });
    expect(pack.question).toContain('這個事件沒有寫成暫定稿');
    expect(okBrief({ ...goodPayload(pack), facts: [K(pack, `${D} 單日 -3.6%`)] }, { pack }).changed_since_provisional).toBeNull();
  });

  it('暫定稿那一份是背景：引用它的原因不算（市場摘要自己的話不能當證據）', () => {
    const pack = purePack({ stage: 'FINAL', provisional: prov, asOf });
    const note = pack.documents.find((d) => d.kind === 'note')!;
    const ev = [E('E9', note, '報導指出聯準會官員的談話讓市場下修 12 月降息的預期')];
    const { outcome, result } = briefOf({ ...goodPayload(pack), facts: [K(pack, `${D} 單日 -3.6%`)], causes: [{ scope: 'MARKET', group: null, kind: 'POLICY', text: '照暫定稿寫的說法', confidence: 'MEDIUM', evidence_ids: ['E9'] }], clarity: 'LOW', changed_since_provisional: '相同' }, { pack, ev });
    // 逐字檢查本身會過（它確實是那份文件的字），但程式不承認背景當引用
    expect(outcome.samples[0].evidence[0].ok).toBe(true);
    expect(result).toMatchObject({ ok: true, brief: { causes: [], unknown: true } });
  });

  it('briefText：可以只留大盤與某一個族群的說法（T65 分給個股用）；原因不明寫明', () => {
    const all = briefText(prov);
    expect(all).toContain(`市場摘要（暫定稿；期間 ${after(D, -1)}～${D}，${D} 寫）`);
    expect(all).toContain('〔XLK｜族群消息｜信心中〕');
    const xle = briefText(prov, { group: 'XLE' });
    expect(xle).toContain('〔大盤｜政策｜信心高〕');
    expect(xle).not.toContain('XLK｜');
    expect(briefText({ ...prov, causes: [], unknown: true })).toContain('原因：不明（沒有找到說得通的原因）。');
  });
});

// ---------------------------------------------------------------- 排程（假的 D1、假的對外請求）

interface Net {
  fire: number;
  fireDown: boolean;
  fredDown: boolean;
  calls: string[];
}
const rss = (items: { title: string; link: string; at: string }[]) => new Response(`<rss><channel>${items.map((i) => `<item><title>${i.title}</title><link>${i.link}</link><pubDate>${new Date(i.at).toUTCString()}</pubDate></item>`).join('')}</channel></rss>`);
const FEEDS: Record<string, { title: string; link: string; at: string }[]> = {
  SPY: [
    { title: 'Stocks tumble as rate cut hopes fade', link: CNBC, at: '2026-11-05T21:10:00Z' },
    { title: 'Why the market is down today', link: 'https://www.fool.com/investing/2026/11/05/why-market-down/', at: '2026-11-05T20:00:00Z' },
    { title: 'Wall Street slides', link: 'https://www.reuters.com/markets/us/wall-street-slides-2026-11-05/', at: '2026-11-05T21:30:00Z' },
    { title: 'An old story', link: 'https://www.cnbc.com/2026/09/01/old-story.html', at: '2026-09-01T12:00:00Z' },
  ],
  XLK: [{ title: 'Chip stocks slide', link: YAHOO, at: '2026-11-05T21:00:00Z' }],
};
function fetcherOf(net: Net): Fetcher {
  return async (url) => {
    net.calls.push(url);
    if (url === 'https://api.example/fire') {
      net.fire++;
      return net.fireDown ? new Response('quota', { status: 429 }) : Response.json({ claude_code_session_url: 'https://claude.ai/code/x' });
    }
    const fred = /fredgraph\.csv\?id=([A-Z0-9]+)/.exec(url);
    if (fred) return net.fredDown ? new Response('down', { status: 500 }) : new Response('observation_date,X\n2000-10-02,1.0\n2026-05-01,1.2\n2026-11-02,1.5\n');
    if (url.startsWith('https://www.nasdaq.com/feed/rssoutbound')) return new Response('cf', { status: 520 });
    const y = /feeds\.finance\.yahoo\.com\/rss\/2\.0\/headline\?s=([^&]+)/.exec(url);
    if (y) return rss(FEEDS[decodeURIComponent(y[1])] ?? []);
    if (PAGES[url]) return html(PAGES[url]);
    throw new Error('測試沒有預期到的網址：' + url);
  };
}

interface Ctx {
  db: D1Database;
  env: Env;
  net: Net;
  fetcher: Fetcher;
  /** 這個訊號日 23:30 的開執行段（moves 是到那天為止的價格）。 */
  sc: (day: string, moves?: Moves, hours?: number) => Promise<StartCtx>;
  call: <T = Record<string, unknown>>(method: 'GET' | 'POST', path: string, body: unknown, now: Date, auth?: string) => Promise<{ status: number; body: T }>;
}
const at = (day: string, hours = 0, minutes = 0) => new Date(Date.parse(`${day}T23:30:00Z`) + hours * 3600_000 + minutes * 60_000);
const acctOf = async (db: D1Database): Promise<Account> => (await loadAccount(db))!.acct;
const briefRows = async (db: D1Database) => (await db.prepare('SELECT * FROM market_briefs ORDER BY id').all<BriefRow>()).results;
const triggerRows = async (db: D1Database) => (await db.prepare('SELECT session, kind, grp, event_id FROM market_triggers ORDER BY session, kind, grp').all<{ session: string; kind: string; grp: string; event_id: string }>()).results;

/** 帳戶：自選 NVDA（XLK）、動能 MU（XLK）與 XOM（XLE）；股票池 10 檔。 */
async function withWorld(fn: (c: Ctx) => Promise<void>, opt: { sectors?: Record<string, string> } = {}) {
  const d = await freshDb();
  try {
    const db = d.db;
    const net: Net = { fire: 0, fireDown: false, fredDown: false, calls: [] };
    const env: Env = { DB: db, ADMIN_TOKEN: 't', AI_TASK_SECRET: 's', SITE_URL: 'https://bot.example', DEV_NO_AUTH: '1', ROUTINE_FIRE_URL: 'https://api.example/fire', ROUTINE_TOKEN: 'rt' };
    const fetcher = fetcherOf(net);
    const start = after(D, -3);
    const { view } = market(start);
    const acct = createAccount({ paper: true, cash: 5000, core: { VOO: 100 }, own: { NVDA: { shares: 10, stdWeight: 0.1 } }, mom: { MU: 5, XOM: 5 } }, view);
    await saveAccount(db, acct, null, '建立帳戶', new Date(`${start}T22:00:00Z`));
    const t0 = `${start}T22:00:00.000Z`;
    for (const [t, etf] of Object.entries(opt.sectors ?? { NVDA: 'XLK', MU: 'XLK', XOM: 'XLE' })) await setStateStmt(db, `sector:${t}`, etf, t0).run();
    await saveRanking(db, { session: start, createdAt: t0, order: UNIVERSE, detail: { universe: UNIVERSE.map((ticker) => ({ ticker, weight: 0.02, close: 100, dollarVolume: 1e9, momentum: 0.1 })), company: {}, missing: [], nConstituents: 500 } });
    const sc: Ctx['sc'] = async (day, moves = {}, hours = 0) => {
      const m = market(day, moves);
      return { env, fetcher, acct: await acctOf(db), view: m.view, axis: m.axis, session: day, ov: {}, now: at(day, hours), checks: [], res: { created: [], started: [], log: [], alerts: [] }, extras: {} };
    };
    const call: Ctx['call'] = async (method, path, b, now, auth) => {
      const r = await handle(new Request(`https://bot.example${path}`, { method, headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) }, ...(b === undefined ? {} : { body: JSON.stringify(b) }) }), env, fetcher, now);
      return { status: r.status, body: (await r.json()) as never };
    };
    await fn({ db, env, net, fetcher, sc, call });
  } finally {
    await d.dispose();
  }
}

/** 照證據包寫一份摘要送回（payload 可以改）；now 要在開執行後 45 分鐘內。 */
async function answer(c: Ctx, runId: string, now: Date, patch: Record<string, unknown> = {}, ev: unknown[] = []) {
  const run = (await getRun(c.db, runId))!;
  const d = run.pack.rule.detail as { period: unknown; stage: string; hasProvisional: boolean };
  await c.call('GET', `/ai/task/${run.taskId}/evidence`, undefined, now, 's');
  const payload = { period: d.period, stage: d.stage, facts: [run.pack.facts.find((f) => f.id === 'K1')!.value], causes: [], unknown: true, clarity: 'LOW', changed_since_provisional: d.stage === 'FINAL' && d.hasProvisional ? '和暫定稿相同' : null, ...patch };
  const sample = { run_id: run.runId, function: MARKET_BRIEF, verdict: 'DONE', evidence: ev, payload, report: '摘要。' };
  return c.call('POST', `/ai/task/${run.taskId}/result`, { task_id: run.taskId, kind: 'RUN', run_id: run.runId, samples: [sample], process: [{ role: '研究員', text: '事實摘要' }], lookups: { questions: [], queries: [], wanted: [] } }, now, 's');
}
/** 逾時：照規則結束那次執行，結算成 FAILED。 */
async function expire(c: Ctx, now: Date) {
  await closeStaleRuns(c.db, now);
  await settleBriefs(c.db, now);
}
/** D 那天整個市場跌 3%（各族群一樣跌 3%），股票池 10 檔裡 8 檔下跌。 */
const DROP = merge(both(D, -0.03), Object.fromEntries(UNIVERSE.slice(0, 8).map((t) => [t, { [D]: -0.02 }])));

describe('T64 觸發與開執行（§1.2；假的 D1）', () => {
  it('平靜的日子不記、不開；大盤單日 -3% → 記一筆觸發、開一份暫定稿（PENDING）；同一天再跑一次不會開第二份', async () => {
    await withWorld(async (c) => {
      const calm = await c.sc(after(D, -1));
      await startMarketBrief(calm);
      expect(await triggerRows(c.db)).toEqual([]);
      expect(await briefRows(c.db)).toEqual([]);
      expect(c.net.fire).toBe(0);

      const sc = await c.sc(D, DROP);
      await startMarketBrief(sc);
      expect(await triggerRows(c.db)).toEqual([{ session: D, kind: 'MARKET_DAY', grp: '', event_id: D }]);
      const rows = await briefRows(c.db);
      expect(rows).toEqual([expect.objectContaining({ event_id: D, stage: 'PROVISIONAL', session: D, period_from: after(D, -1), period_to: D, manual: 0, status: 'PENDING', payload: null })]);
      expect(sc.res.started).toEqual([rows[0].run_id]);
      expect(sc.res.log.join('\n')).toContain(`市場摘要的觸發（大盤大漲跌）：VOO ${D} 單日 -3.0%（門檻 2.5%）；事件 ${D}`);
      expect(sc.res.log.join('\n')).toContain('市場摘要：開暫定稿');
      expect(c.net.fire).toBe(1);

      const again = await c.sc(D, DROP, 2);
      await startMarketBrief(again, { final: true });
      expect(await briefRows(c.db)).toHaveLength(1);
      expect(await triggerRows(c.db)).toHaveLength(1);
      expect(again.res.started).toEqual([]);
    });
  });

  it('證據包：程式算的數字、持股的族群（只有代號）、價格表、總經儀表板、大盤與各族群的新聞標題、目錄與清單內的來源；沒有金額與股數', async () => {
    await withWorld(async (c) => {
      const sc = await c.sc(D, merge(DROP, { XLK: { [D]: -0.07 }, MU: { [D]: -0.12 } }));
      await startMarketBrief(sc);
      const run = (await getRun(c.db, sc.res.started[0]))!;
      const { pack } = run;
      expect(run).toMatchObject({ fn: 'MARKET_BRIEF', ticker: null, asOf: D, promptVersion: MARKET_BRIEF_PROMPT });
      expect(pack.policy).toMatchObject({ level: 'A2', samples: 1 });
      expect(pack.rule.detail).toMatchObject({ stage: 'PROVISIONAL', eventId: D, core: 'VOO', groups: ['XLE', 'XLK'], period: { from: after(D, -1), to: D }, triggers: [{ kind: 'GROUP_DAY', group: 'XLK' }, { kind: 'MARKET_DAY' }] });
      const val = (re: RegExp) => pack.facts.filter((f) => re.test(f.id)).map((f) => f.value);
      expect(val(/^K/)).toEqual(expect.arrayContaining([`VOO ${D} 單日 -3.0%`, `股票池 10 檔裡，${D} 下跌的有 80%`, `XLK ${D} 單日 -7.0%，比 VOO 多跌 4.0 個百分點`, `XLE ${after(D, -1)}～${D} 漲跌 -3.0%，和 VOO 相同`]));
      expect(val(/^G/)).toEqual(['XLE：XOM（動能）', 'XLK：NVDA（自選）、MU（動能）']);
      expect(val(/^H/)[0]).toBe(`MU（XLK） ${after(D, -1)}～${D} 漲跌 -12.0%`);
      // 目錄：標題裡連結在清單內、期間內的文章（fool.com 不列入、Reuters 不在清單、兩個月前的太舊）
      expect(val(/^M/)).toEqual([`CNBC｜媒體｜${D}｜Stocks tumble as rate cut hopes fade`, `Yahoo Finance｜媒體｜${D}｜Chip stocks slide`]);
      expect(val(/^S/)).toEqual(expect.arrayContaining(['cnbc.com｜CNBC｜媒體', 'npr.org｜NPR｜媒體', 'finance.yahoo.com｜Yahoo Finance｜媒體｜只收 /news/', 'bls.gov｜美國勞工統計局（BLS）｜一手｜只收 /news.release/']));
      expect(run.docCtx).toMatchObject({ domains: [], fileId: null, notBefore: '2026-10-28', menu: [{ id: 'M1', kind: 'web', url: CNBC }, { id: 'M2', kind: 'web', url: YAHOO }] });
      expect(run.docCtx?.off ?? null).toBeNull();
      // 文件：核心 ETF、兩個產業 ETF、漲跌最大的持股的價格表；總經儀表板；大盤與各族群的新聞標題
      const ids = pack.documents.map((d) => d.source_id);
      expect(ids).toEqual(expect.arrayContaining(['price:VOO', 'price:XLE', 'price:XLK', 'price:MU', `macro:${D}`, 'yahoo-rss:SPY', 'yahoo-rss:XLK']));
      expect(pack.documents.find((d) => d.source_id === 'price:VOO')!.text.split('\n').length).toBeGreaterThanOrEqual(30);
      expect(pack.documents.find((d) => d.source_id === 'yahoo-rss:SPY')).toMatchObject({ kind: 'news', title: '大盤相關的新聞標題（SPY，Yahoo Finance RSS，只有標題）' });
      expect(pack.documents.find((d) => d.source_id === 'yahoo-rss:XLK')!.title).toBe('XLK 族群相關的新聞標題（Yahoo Finance RSS，只有標題）');
      expect(pack.data_quality).toEqual({ prices: 'ok', macro: 'ok', news: 'partial' });
      // 只有代號：沒有股數、比重、金額
      const raw = JSON.stringify({ facts: pack.facts, question: pack.question, rule: pack.rule });
      expect(raw).not.toMatch(/\d+ 股/);
      expect(raw).not.toMatch(/占總資產|比重|現金/);
      // 總經儀表板是當場算的，沒有存進 macro_snapshots（那是崩盤規則檢視照月份讀的）
      expect((await c.db.prepare('SELECT COUNT(*) AS n FROM macro_snapshots').first<{ n: number }>())!.n).toBe(0);
    });
  });

  it('持股的產業 ETF 單日比大盤多跌 3 個百分點以上 → 族群的觸發；不是持股族群的 ETF 不看', async () => {
    await withWorld(async (c) => {
      const sc = await c.sc(D, { XLK: { [D]: -0.035 }, XLF: { [D]: -0.08 } });
      await startMarketBrief(sc);
      expect(await triggerRows(c.db)).toEqual([{ session: D, kind: 'GROUP_DAY', grp: 'XLK', event_id: D }]);
      expect(await briefRows(c.db)).toEqual([expect.objectContaining({ stage: 'PROVISIONAL', status: 'PENDING', why: expect.stringContaining(`事件 ${D}`) })]);
    });
  });

  it('持股：0 股的自選不算；沒有對到產業 ETF 的持股不當成族群', async () => {
    await withWorld(
      async (c) => {
        const acct = await acctOf(c.db);
        expect(briefHoldings(acct)).toEqual([
          { ticker: 'NVDA', role: 'OWN' },
          { ticker: 'MU', role: 'MOM' },
          { ticker: 'XOM', role: 'MOM' },
        ]);
        expect(briefHoldings({ ...acct, lots: { ...acct.lots, own: { NVDA: 0 } } }).map((h) => h.ticker)).toEqual(['MU', 'XOM']);
        const g = await briefGroups(c.db, acct, market(D).view);
        expect(g.groups).toEqual([{ etf: 'XLK', members: [{ ticker: 'NVDA', role: 'OWN' }] }]);
        expect(g.ungrouped.map((h) => h.ticker)).toEqual(['MU', 'XOM']);
        expect(g.notes).toEqual([`XOM 的產業 ETF XLB 沒有 ${D} 的價格，這次不當成一個族群`]);
      },
      { sectors: { NVDA: 'XLK', XOM: 'XLB' } },
    );
  });

  it('累積：21 個交易日跌 10% → 觸發一次，期間從 21 個交易日前算起；隔天還是跌超過 10% 也不再記', async () => {
    await withWorld(async (c) => {
      const m: Record<string, number> = {};
      for (let k = 0; k < 30; k++) m[after(D, -k)] = -0.0055;
      const slide: Moves = { VOO: m, SPY: m };
      const sc = await c.sc(D, slide);
      await startMarketBrief(sc);
      expect(await triggerRows(c.db)).toEqual([{ session: D, kind: 'CUMULATIVE', grp: '', event_id: D }]);
      expect(await briefRows(c.db)).toEqual([expect.objectContaining({ stage: 'PROVISIONAL', period_from: after(D, -21), period_to: D })]);
      const next = await c.sc(after(D, 1), { VOO: { ...m, [after(D, 1)]: -0.0055 }, SPY: m });
      await startMarketBrief(next);
      expect(await triggerRows(c.db)).toHaveLength(1);
      expect(await briefRows(c.db)).toHaveLength(1);
    });
  });

  it('當天有減半檢視或提前審查 → 開（最近 5 個交易日沒有摘要時）；一般的月底審查不算', async () => {
    await withWorld(async (c) => {
      const ins = (runId: string, fn: string, asOf: string, trigger?: string) =>
        c.db.prepare("INSERT INTO ai_runs (run_id, fn, ticker, as_of, created_at, status, prompt_version, pack_hash, pack, pack_notes) VALUES (?, ?, 'NVDA', ?, ?, 'PENDING', 'x', 'h', ?, '[]')").bind(runId, fn, asOf, `${asOf}T23:30:00.000Z`, JSON.stringify({ rule: { action: 'x', detail: trigger ? { trigger } : {} } })).run();
      // 月底的定期審查：不算
      await ins(`${D}_OWN_REVIEW_NVDA_000001`, 'OWN_REVIEW', D, 'MONTHLY');
      await startMarketBrief(await c.sc(D));
      expect(await briefRows(c.db)).toEqual([]);
      // 提前審查：算
      const d1 = after(D, 1);
      await ins(`${d1}_OWN_REVIEW_NVDA_000002`, 'OWN_REVIEW', d1, 'EARLY');
      const sc = await c.sc(d1);
      await startMarketBrief(sc);
      expect(await triggerRows(c.db)).toEqual([{ session: d1, kind: 'AI_RUN', grp: '', event_id: d1 }]);
      const [row] = await briefRows(c.db);
      expect(row).toMatchObject({ stage: 'PROVISIONAL', session: d1, period_from: after(d1, -21) });
      expect(((await getRun(c.db, row.run_id))!.pack.rule.detail as { triggers: BriefTrigger[] }).triggers).toEqual([expect.objectContaining({ kind: 'AI_RUN', text: `${d1} 開了減半檢視或提前審查（${d1}_OWN_REVIEW_NVDA_000002）` })]);
      await answer(c, row.run_id, at(d1, 0, 10));
      // 3 個交易日後又有減半檢視：最近 5 個交易日有摘要 → 不記、不開
      const d4 = after(d1, 3);
      await ins(`${d4}_OWN_DROP_NVDA_000003`, 'OWN_DROP', d4);
      await startMarketBrief(await c.sc(d4));
      expect(await triggerRows(c.db)).toHaveLength(1);
      expect(await briefRows(c.db)).toHaveLength(1);
    });
  });

  it('流程漏跑的日子下一次補看：兩天前的大跌照樣記在那一天、開一份涵蓋那一天的暫定稿；第一次跑只看今天', async () => {
    await withWorld(async (c) => {
      // 第一次跑（沒有看過的紀錄）：只看今天，前一天的大跌不追溯
      const first = await c.sc(after(D, -4), both(after(D, -5), -0.04));
      await startMarketBrief(first);
      expect(await triggerRows(c.db)).toEqual([]);
      expect((await c.db.prepare('SELECT value FROM flow_state WHERE key = ?').bind(BRIEF_SCANNED_KEY).first<{ value: string }>())!.value).toBe(after(D, -4));
      // 之後 D-3～D+1 都沒跑；D+2 才跑：補看到 D 的大跌
      const day = after(D, 2);
      const sc = await c.sc(day, DROP);
      await startMarketBrief(sc);
      expect(await triggerRows(c.db)).toEqual([{ session: D, kind: 'MARKET_DAY', grp: '', event_id: D }]);
      expect(await briefRows(c.db)).toEqual([expect.objectContaining({ event_id: D, stage: 'PROVISIONAL', session: day, period_from: after(D, -1), period_to: day })]);
    });
  });
});

describe('T64 頻率上限、同一個事件、定稿（§1.2、§5.2；假的 D1）', () => {
  it('暫定稿之後 10 個交易日內又觸發：不另開、算同一個事件、定稿往後延；定稿附暫定稿；定稿之後的觸發是新的事件', async () => {
    await withWorld(async (c) => {
      const d4 = after(D, 4);
      const moves = merge(DROP, both(d4, 0.028));
      const step = async (n: number, m: Moves = moves, hours = 0) => {
        const sc = await c.sc(after(D, n), m, hours);
        await startMarketBrief(sc);
        return sc;
      };
      await step(0);
      const [prov] = await briefRows(c.db);
      expect((await answer(c, prov.run_id, at(D, 0, 10), { causes: [{ scope: 'MARKET', group: null, kind: 'POLICY', text: '報導的標題說降息預期下修', confidence: 'MEDIUM', evidence_ids: ['E1'] }], unknown: false }, [{ id: 'E1', source_id: 'yahoo-rss:SPY', date: D, quote: 'Stocks tumble as rate cut hopes fade', claim: '標題' }])).status).toBe(200);
      expect((await briefRows(c.db))[0]).toMatchObject({ status: 'READY' });

      for (let n = 1; n <= 3; n++) await step(n);
      const again = await step(4);
      expect(again.res.log.join('\n')).toContain('10 個交易日內最多 1 份');
      expect(await triggerRows(c.db)).toEqual([
        { session: D, kind: 'MARKET_DAY', grp: '', event_id: D },
        { session: d4, kind: 'MARKET_DAY', grp: '', event_id: D },
      ]);
      expect(await briefRows(c.db)).toHaveLength(1);

      // 原本的第 10 個交易日不寫定稿（最後一次觸發是第 4 個交易日）
      for (let n = 5; n <= 13; n++) await step(n);
      expect(await briefRows(c.db)).toHaveLength(1);
      const fin = await step(14);
      const rows = await briefRows(c.db);
      expect(rows).toHaveLength(2);
      expect(rows[1]).toMatchObject({ event_id: D, stage: 'FINAL', session: after(D, 14), period_from: after(D, -1), period_to: after(D, 14), status: 'PENDING' });
      expect(fin.res.log.join('\n')).toContain('市場摘要：開定稿');
      const run = (await getRun(c.db, rows[1].run_id))!;
      expect(run.pack.rule.detail).toMatchObject({ stage: 'FINAL', hasProvisional: true, triggers: [{ session: D }, { session: d4 }] });
      expect(run.pack.documents.find((x) => x.kind === 'note')).toMatchObject({ source_id: `brief-prev:${D}` });
      expect(run.pack.documents.find((x) => x.kind === 'note')!.text).toContain('報導的標題說降息預期下修');
      // 兩個觸發日的數字都在
      expect(run.pack.facts.map((f) => f.value)).toEqual(expect.arrayContaining([`VOO ${D} 單日 -3.0%`, `VOO ${d4} 單日 +2.8%`]));

      // 定稿沒寫和暫定稿不同的地方 → 失敗；隔天再試一次 → 寫好
      expect((await answer(c, rows[1].run_id, at(after(D, 14), 0, 10), { changed_since_provisional: null })).status).toBe(200);
      expect((await briefRows(c.db))[1]).toMatchObject({ status: 'FAILED', error: expect.stringContaining('定稿要寫 changed_since_provisional') });
      await step(15);
      const retry = (await briefRows(c.db))[2];
      expect(retry).toMatchObject({ event_id: D, stage: 'FINAL', session: after(D, 15), status: 'PENDING' });
      await answer(c, retry.run_id, at(after(D, 15), 0, 10));
      expect((await briefRows(c.db))[2]).toMatchObject({ status: 'READY' });
      expect(JSON.parse((await briefRows(c.db))[2].payload!)).toMatchObject({ stage: 'FINAL', changed_since_provisional: '和暫定稿相同', unknown: true });

      // 定稿之後再大跌：新的事件、新的暫定稿
      const d16 = after(D, 16);
      await step(16, merge(moves, both(d16, -0.031)));
      expect((await triggerRows(c.db)).at(-1)).toEqual({ session: d16, kind: 'MARKET_DAY', grp: '', event_id: d16 });
      expect((await briefRows(c.db)).at(-1)).toMatchObject({ event_id: d16, stage: 'PROVISIONAL', session: d16 });
    });
  });

  it('暫定稿沒有成功：01:30 再試一次；兩次都沒有成功就不再開，定稿到期時照寫（沒有暫定稿可以對照）', async () => {
    await withWorld(async (c) => {
      // 23:30 雲端排程觸發失敗 → 當場結算成 FAILED
      c.net.fireDown = true;
      await startMarketBrief(await c.sc(D, DROP));
      expect(await briefRows(c.db)).toEqual([expect.objectContaining({ stage: 'PROVISIONAL', status: 'FAILED', error: expect.stringContaining('雲端排程沒有觸發成功') })]);
      // 01:30 再試：開了，之後逾時
      c.net.fireDown = false;
      const retry = await c.sc(D, DROP, 2);
      await startMarketBrief(retry, { final: true });
      expect(retry.res.log.join('\n')).toContain('再試一次；01:30');
      expect((await briefRows(c.db)).map((r) => r.status)).toEqual(['FAILED', 'PENDING']);
      await expire(c, at(D, 4));
      expect((await briefRows(c.db))[1]).toMatchObject({ status: 'FAILED', error: expect.stringContaining('沒有收到結果') });
      // 隔天不再開
      const next = await c.sc(after(D, 1), DROP);
      await startMarketBrief(next);
      expect(await briefRows(c.db)).toHaveLength(2);
      expect(next.res.log.join('\n')).toContain(`事件 ${D} 的暫定稿已經失敗 2 次`);
      // 第 10 個交易日：定稿照寫，沒有暫定稿
      for (let n = 2; n <= 10; n++) await startMarketBrief(await c.sc(after(D, n), DROP));
      const fin = (await briefRows(c.db))[2];
      expect(fin).toMatchObject({ stage: 'FINAL', session: after(D, 10), status: 'PENDING' });
      const run = (await getRun(c.db, fin.run_id))!;
      expect(run.pack.rule.detail).toMatchObject({ hasProvisional: false });
      expect(run.pack.documents.some((x) => x.kind === 'note')).toBe(false);
      await answer(c, fin.run_id, at(after(D, 10), 0, 10));
      expect((await briefRows(c.db))[2]).toMatchObject({ status: 'READY' });
    });
  });

  it('總經資料抓不到：摘要照開，證據包沒有儀表板、寫明缺什麼', async () => {
    await withWorld(async (c) => {
      c.net.fredDown = true;
      const sc = await c.sc(D, DROP);
      await startMarketBrief(sc);
      const run = (await getRun(c.db, sc.res.started[0]))!;
      expect(run.pack.documents.some((d) => d.source_id.startsWith('macro:'))).toBe(false);
      expect(run.pack.data_quality.macro).toBe('missing');
      expect(run.packNotes).toContain('總經資料抓不到，這次的證據包沒有總經儀表板');
    });
  });
});

// ---------------------------------------------------------------- 取文件、送回、結算

describe('T64 研究員取文件、送回、結算（§1.4、§1.5）', () => {
  it('研究員向 Worker 取清單內的報導（兩個網域），引用通過逐字檢查 → 寫好的摘要；只說明：帳戶與通知都沒有變', async () => {
    await withWorld(async (c) => {
      const before = JSON.stringify(await acctOf(c.db));
      const sc = await c.sc(D, merge(DROP, { XLK: { [D]: -0.07 } }));
      await startMarketBrief(sc);
      const run = (await getRun(c.db, sc.res.started[0]))!;
      await c.call('GET', `/ai/task/${run.taskId}/evidence`, undefined, at(D, 0, 2), 's');
      const got = await c.call<{ docs: { source_id: string; date: string; text: string; tier: string }[]; refused: { reason: string; detail: string }[] }>(
        'POST',
        `/ai/task/${run.taskId}/docs`,
        { role: '研究員', want: [{ menu: 'M1', why: '支持：當天的市場報導' }, { url: NPR, title: 'Stocks fall on Fed doubts', why: '相反：另一家媒體怎麼說' }, { url: 'https://www.fool.com/investing/2026/11/05/why-market-down/', why: '支持：評論' }, { url: 'https://finance.yahoo.com/quote/SPY/', why: '支持：報價頁' }] },
        at(D, 0, 3),
        's',
      );
      expect(got.status).toBe(200);
      expect(got.body.docs.map((d) => [d.tier, d.date])).toEqual([
        ['MEDIA', D],
        ['MEDIA', D],
      ]);
      expect(got.body.refused.map((r) => [r.reason, r.detail])).toEqual([
        ['NOT_LISTED', 'EXCLUDED'],
        ['NOT_LISTED', 'PATH'],
      ]);
      // 快照記在固定的代號下（市場摘要不屬於任何一檔）
      const snaps = (await c.db.prepare("SELECT ticker, domain, status, used_by FROM web_docs WHERE status = 'OK' ORDER BY row_id").all<{ ticker: string; domain: string; status: string; used_by: string }>()).results;
      expect(snaps).toEqual([
        { ticker: MARKET_DOC_TICKER, domain: 'cnbc.com', status: 'OK', used_by: run.runId },
        { ticker: MARKET_DOC_TICKER, domain: 'npr.org', status: 'OK', used_by: run.runId },
      ]);
      const [cnbc, npr] = got.body.docs;
      const ev = [E('E1', cnbc, Q.cnbc), E('E2', npr, Q.npr), E('E3', cnbc, 'Fed officials said a rate cut is off the table')];
      const causes = [
        { scope: 'MARKET', group: null, kind: 'POLICY', text: '報導指出聯準會官員的談話讓市場下修 12 月降息的預期', confidence: 'HIGH', evidence_ids: ['E1', 'E2'] },
        { scope: 'MARKET', group: null, kind: 'OTHER', text: '引用被改寫過的說法', confidence: 'LOW', evidence_ids: ['E3'] },
      ];
      expect((await answer(c, run.runId, at(D, 0, 12), { facts: [`VOO ${D} 單日 -3.0%`, 'VOO 大跌'], causes, unknown: false, clarity: 'HIGH' }, ev)).status).toBe(200);
      // 送回時當場結算（不用等下一次每日流程）
      const [row] = await briefRows(c.db);
      expect(row).toMatchObject({ status: 'READY', error: null });
      const b = JSON.parse(row.payload!) as MarketBrief;
      expect(b).toMatchObject({ stage: 'PROVISIONAL', facts: [`VOO ${D} 單日 -3.0%`], unknown: false, clarity: 'HIGH', groups: ['XLE', 'XLK'] });
      expect(b.causes).toEqual([expect.objectContaining({ kind: 'POLICY', confidence: 'HIGH', evidence_ids: ['E1', 'E2'], lowered: null })]);
      expect(b.dropped.map((d) => [d.what, d.why])).toEqual([
        ['FACT', '不是證據包給的數字（K 開頭）原樣'],
        ['CAUSE', '沒有通過逐字檢查的引用'],
      ]);
      expect(b.evidence.map((e) => [e.domain, e.tier])).toEqual([
        ['cnbc.com', 'MEDIA'],
        ['npr.org', 'MEDIA'],
      ]);
      // 只說明：帳戶一個字都沒有變、沒有通知、沒有告警
      const done = (await getRun(c.db, run.runId))!;
      const ctx: ApplyCtx = { db: c.db, acct: await acctOf(c.db), view: sc.view, axis: sc.axis, session: D, now: at(D, 2), stmts: [], log: [], alerts: [] };
      await applyMarketBrief(ctx, done);
      expect(ctx.stmts).toEqual([]);
      expect(ctx.alerts).toEqual([]);
      expect(ctx.log).toEqual([`${run.runId}：市場摘要（暫定稿）寫好了：1 個報導的說法`]);
      expect(JSON.stringify(await acctOf(c.db))).toBe(before);
      expect(APPLIERS[MARKET_BRIEF]).toBe(applyMarketBrief);
      // 現有的「AI 紀錄」（還沒有市場摘要專用的畫面，T65）讀得了這一筆：名稱、結論、研究員另外取的文件
      expect(runRow(done)).toMatchObject({ id: run.runId, label: '市場摘要' });
      expect(() => runDetail(done)).not.toThrow();
      expect(foundView(done)).toMatchObject({ docs: [expect.objectContaining({ source: 'CNBC', level: '網頁（媒體）' }), expect.objectContaining({ source: 'NPR' })] });
      expect(exportMd(done, { background: [] })).toContain('市場摘要');
    });
  });

  it('逾時沒有結果 → 每日流程套用時結算成 FAILED（原因寫明），不發通知', async () => {
    await withWorld(async (c) => {
      const sc = await c.sc(D, DROP);
      await startMarketBrief(sc);
      await closeStaleRuns(c.db, at(D, 2));
      const run = (await getRun(c.db, sc.res.started[0]))!;
      expect(run.outcome?.status).toBe('TIMEOUT');
      const ctx: ApplyCtx = { db: c.db, acct: await acctOf(c.db), view: sc.view, axis: sc.axis, session: D, now: at(D, 2), stmts: [], log: [], alerts: [] };
      await applyMarketBrief(ctx, run);
      expect(await briefRows(c.db)).toEqual([expect.objectContaining({ status: 'FAILED', error: expect.stringContaining('沒有收到結果') })]);
      expect(ctx.log[0]).toContain('市場摘要（暫定稿）沒有成功');
      expect(ctx.alerts).toEqual([]);
    });
  });

  it('市場摘要列在可以取文件的功能裡；功能的白話名稱與結論的寫法', () => {
    expect([...DOC_FNS]).toEqual(['OWN_REVIEW', 'OWN_DROP', 'OWN_DRAFT', 'MARKET_BRIEF']);
    expect(fnInfo(MARKET_BRIEF)).toMatchObject({ label: '市場摘要', note: null, verdicts: { DONE: '寫好了', INSUFFICIENT: '沒有寫成' } });
  });

  it('T65 讀的：latestBrief 取最近一份寫好的（30 個日曆天內、不看未來、同一天有定稿用定稿）；loadBriefs 含失敗的', async () => {
    await withWorld(async (c) => {
      expect(await latestBrief(c.db, D)).toBeNull();
      const sc = await c.sc(D, DROP);
      await startMarketBrief(sc);
      await answer(c, sc.res.started[0], at(D, 0, 10));
      expect(await latestBrief(c.db, after(D, -1))).toBeNull();
      const got = (await latestBrief(c.db, after(D, 5)))!;
      expect(got.row).toMatchObject({ event_id: D, stage: 'PROVISIONAL', session: D });
      expect(got.brief).toMatchObject({ stage: 'PROVISIONAL', unknown: true, as_of: D, facts: [expect.stringContaining('VOO')] });
      expect(await latestBrief(c.db, '2026-12-04')).not.toBeNull();
      expect(await latestBrief(c.db, '2026-12-07')).toBeNull(); // 32 個日曆天後
      // 同一個訊號日有定稿與暫定稿 → 定稿
      await c.db.prepare("INSERT INTO market_briefs (event_id, stage, run_id, session, period_from, period_to, why, manual, status, payload, created_at) VALUES (?, 'FINAL', 'r-final', ?, ?, ?, 't', 0, 'READY', ?, ?)").bind(D, D, after(D, -1), D, JSON.stringify({ ...got.brief, stage: 'FINAL' }), `${D}T23:50:00.000Z`).run();
      await c.db.prepare("INSERT INTO market_briefs (event_id, stage, run_id, session, period_from, period_to, why, manual, status, error, created_at) VALUES (?, 'PROVISIONAL', 'r-fail', ?, ?, ?, 't', 0, 'FAILED', '逾時', ?)").bind(after(D, 3), after(D, 3), after(D, 2), after(D, 3), `${after(D, 3)}T23:50:00.000Z`).run();
      expect((await latestBrief(c.db, after(D, 5)))!.row.stage).toBe('FINAL');
      const all = await loadBriefs(c.db);
      expect(all.map((v) => [v.row.status, v.row.stage, !!v.brief])).toEqual([
        ['FAILED', 'PROVISIONAL', false],
        ['READY', 'FINAL', true],
        ['READY', 'PROVISIONAL', true],
      ]);
      expect(await loadBriefs(c.db, { status: 'READY' })).toHaveLength(2);
    });
  });

  it('手動開（POST /admin/ai/brief）：期間是最近 21 個交易日；不佔頻率上限、不屬於任何事件；沒有驗證、沒有帳戶不能開', async () => {
    await withIngested(async (x) => {
      const post = (auth?: string) => handle(new Request('https://bot.example/admin/ai/brief', { method: 'POST', headers: auth ? { Authorization: `Bearer ${auth}` } : {} }), x.env, x.fetcher, new Date('2026-11-20T00:10:00Z'));
      expect((await post()).status).toBe(401);
      const none = await post('t');
      expect(none.status).toBe(400);
      expect(await none.json()).toEqual({ error: '還沒有帳戶' });
      await x.account();
      const res = await post('t');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { runId: string; period: { from: string; to: string }; facts: string[] };
      expect(body.period).toEqual({ from: after('2026-11-19', -21), to: '2026-11-19' });
      expect(body.facts.some((f) => /^K1 VOO /.test(f))).toBe(true);
      expect(await briefRows(x.db)).toEqual([expect.objectContaining({ run_id: body.runId, event_id: 'manual-2026-11-19', stage: 'PROVISIONAL', manual: 1, status: 'PENDING', why: '手動開的' })]);
      expect(await triggerRows(x.db)).toEqual([]);
      expect(((await getRun(x.db, body.runId))!.pack.rule.detail as { manual?: boolean }).manual).toBe(true);
      // 隔天真的大跌：手動的那一份不佔頻率上限，照樣開暫定稿
      x.w.dataDate = '2026-11-20';
      x.w.shock = { VOO: { from: '2026-11-20', factor: 0.96 }, SPY: { from: '2026-11-20', factor: 0.96 } };
      await runFlow(x.env, x.fetcher, { now: cronTime('2026-11-20'), attempt: 'FIRST' });
      expect((await briefRows(x.db)).map((r) => [r.event_id, r.manual, r.session])).toEqual([
        ['manual-2026-11-19', 1, '2026-11-19'],
        ['2026-11-20', 0, '2026-11-20'],
      ]);
    });
  });
});

// ---------------------------------------------------------------- 每日流程的掛點

/** 真的每日流程（假的 Yahoo、成分股）：2026-11-19 抓好資料；account() 建一個只有核心 ETF 的帳戶。 */
async function withIngested(fn: (x: { db: D1Database; env: Env; fetcher: Fetcher; w: ReturnType<typeof newWorld>; account: () => Promise<void> }) => Promise<void>) {
  const d = await freshDb();
  try {
    const db = d.db;
    const w = newWorld('2026-11-19');
    const net: Net = { fire: 0, fireDown: false, fredDown: false, calls: [] };
    const env: Env = { DB: db, ADMIN_TOKEN: 't', AI_TASK_SECRET: 's', SITE_URL: 'https://bot.example', DEV_NO_AUTH: '1', ROUTINE_FIRE_URL: 'https://api.example/fire', ROUTINE_TOKEN: 'rt' };
    const base = fakeFetcher(w);
    const mine = fetcherOf(net);
    const fetcher: Fetcher = async (url, init) => (/query1\.finance\.yahoo\.com|ssga\.com|wikipedia\.org/.test(url) ? base(url, init) : mine(url, init));
    await runFlow(env, fetcher, { now: cronTime('2026-11-19'), attempt: 'FIRST' });
    const account = async () => {
      const { view } = buildMarketView(await loadSeries(db, ['VOO', 'SGOV']), '2026-11-19', 'VOO');
      await saveAccount(db, createAccount({ paper: true, cash: 1000, core: { VOO: 100 } }, view), null, '建立帳戶', new Date('2026-11-19T23:40:00Z'));
    };
    await fn({ db, env, fetcher, w, account });
  } finally {
    await d.dispose();
  }
}

describe('T64 每日流程的掛點（23:30 開執行的那一段、01:30 的 finalStarts）', () => {
  it('大盤大跌的那一天：23:30 的流程開一份市場摘要；結果回來之後 01:30、03:30 不再開；沒有因此多出通知', async () => {
    await withIngested(async ({ db, env, fetcher, w, account }) => {
      await account();
      // 2026-11-20：核心 ETF（與 SPY）單日 -4%
      w.dataDate = '2026-11-20';
      w.shock = { VOO: { from: '2026-11-20', factor: 0.96 }, SPY: { from: '2026-11-20', factor: 0.96 } };
      const first = await runFlow(env, fetcher, { now: cronTime('2026-11-20'), attempt: 'FIRST' });
      expect(first.status).toBe('DONE');
      const rows = await briefRows(db);
      expect(rows).toEqual([expect.objectContaining({ event_id: '2026-11-20', stage: 'PROVISIONAL', session: '2026-11-20', status: 'PENDING' })]);
      const detail = JSON.parse((await db.prepare("SELECT detail FROM flow_runs WHERE session = '2026-11-20' ORDER BY id DESC LIMIT 1").first<{ detail: string }>())!.detail) as { ai: { started: string[]; log: string[] } };
      expect(detail.ai.started).toContain(rows[0].run_id);
      expect(detail.ai.log.join('\n')).toContain('市場摘要的觸發（大盤大漲跌）');
      // 送回一份「原因不明」
      const run = (await getRun(db, rows[0].run_id))!;
      const call = async (method: string, path: string, body?: unknown) => handle(new Request(`https://bot.example${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer s' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env, fetcher, new Date('2026-11-20T23:45:00Z'));
      await call('GET', `/ai/task/${run.taskId}/evidence`);
      const dt = run.pack.rule.detail as { period: unknown };
      const sample = { run_id: run.runId, function: MARKET_BRIEF, verdict: 'DONE', evidence: [], payload: { period: dt.period, stage: 'PROVISIONAL', facts: [run.pack.facts.find((f) => f.id === 'K1')!.value], causes: [], unknown: true, clarity: 'LOW', changed_since_provisional: null }, report: '原因不明。' };
      expect((await call('POST', `/ai/task/${run.taskId}/result`, { task_id: run.taskId, kind: 'RUN', run_id: run.runId, samples: [sample] })).status).toBe(200);
      expect((await briefRows(db))[0].status).toBe('READY');
      const notifs = (await acctOf(db)).notifs.length;
      // 01:30（finalStarts）與 03:30：不再開
      const fin = await runFlow(env, fetcher, { now: new Date('2026-11-21T01:30:00Z'), attempt: 'FINAL' });
      await runFlow(env, fetcher, { now: new Date('2026-11-21T03:30:00Z'), attempt: 'APPLY' });
      expect(await briefRows(db)).toHaveLength(1);
      expect(fin.created).toEqual([]);
      expect((await acctOf(db)).notifs.length).toBe(notifs);
      expect((await db.prepare('SELECT applied_at FROM ai_runs WHERE run_id = ?').bind(run.runId).first<{ applied_at: string | null }>())!.applied_at).not.toBeNull();
    });
  });

  it('23:30 開的那一份逾時：01:30 的流程結算成失敗，接著（finalStarts）再試一次', async () => {
    await withIngested(async ({ db, env, fetcher, w, account }) => {
      await account();
      w.dataDate = '2026-11-20';
      w.shock = { VOO: { from: '2026-11-20', factor: 0.96 }, SPY: { from: '2026-11-20', factor: 0.96 } };
      await runFlow(env, fetcher, { now: cronTime('2026-11-20'), attempt: 'FIRST' });
      expect((await briefRows(db)).map((r) => r.status)).toEqual(['PENDING']);
      await runFlow(env, fetcher, { now: new Date('2026-11-21T01:30:00Z'), attempt: 'FINAL' });
      expect((await briefRows(db)).map((r) => [r.stage, r.status, r.session])).toEqual([
        ['PROVISIONAL', 'FAILED', '2026-11-20'],
        ['PROVISIONAL', 'PENDING', '2026-11-20'],
      ]);
      // 03:30 不開新的執行
      await runFlow(env, fetcher, { now: new Date('2026-11-21T03:30:00Z'), attempt: 'APPLY' });
      expect((await briefRows(db)).map((r) => r.status)).toEqual(['FAILED', 'FAILED']);
    });
  });
});

// ---------------------------------------------------------------- 匯出、說明、prompt

describe('T64 匯出、records_guide.md、prompt', () => {
  it('market_briefs 照整張重拉（payload 解析成物件）、market_triggers 只增加；records_guide.md 有這兩張表與 MARKET_BRIEF', () => {
    expect(EXPORT_TABLES.market_briefs).toMatchObject({ mode: 'replace', json: ['payload'] });
    expect(EXPORT_TABLES.market_triggers).toMatchObject({ mode: 'append' });
    const guide = readFileSync(join(ROOT, 'docs', 'analysis', 'records_guide.md'), 'utf8');
    expect(guide).toContain('| `market_briefs` |');
    expect(guide).toContain('| `market_triggers` |');
    expect(guide).toContain('`MARKET_BRIEF`（市場摘要');
    expect(guide).toContain('`_MARKET`');
  });

  it('prompt：market_brief_v1 是新檔；只有研究員可以上網與取文件；原因是報導的說法、不明是合格的答案、不能當前提不成立的依據', () => {
    expect(MARKET_BRIEF_PROMPT).toBe('market_brief_v1');
    const p = readFileSync(join(ROOT, 'ai', 'prompts', `${MARKET_BRIEF_PROMPT}.md`), 'utf8');
    expect(p).toContain('只有研究員可以用 WebSearch、可以取文件');
    expect(p).toContain('主筆不要用 WebSearch、不要取文件');
    expect(p).toContain('不設多空辯論');
    expect(p).toContain('**原因一律是「報導的說法」。**');
    expect(p).toContain('**「不明」是合格的答案，不算失敗。**');
    expect(p).toContain('不能當成任何前提不成立的依據');
    expect(p).toContain('**`kind` 是 `FLOW` 的，在暫定稿只能寫 `LOW`**');
    expect(p).toContain('同一個網站一次執行最多 4 篇');
    expect(p).toContain('至少取兩個不同網域的報導');
    expect(p).toContain('找不到不同說法時，要寫明找過什麼');
    // 輸出格式的欄位都寫了
    for (const k of ['"period"', '"stage"', '"facts"', '"causes"', '"scope"', '"group"', '"kind"', '"confidence"', '"evidence_ids"', '"unknown"', '"clarity"', '"changed_since_provisional"']) expect(p).toContain(k);
    for (const k of ['MACRO_DATA', 'POLICY', 'EARNINGS', 'SECTOR_NEWS', 'FLOW', 'GEOPOLITICS', 'OTHER']) expect(p).toContain(`\`${k}\``);
  });
});
