// T63：新眼光（composite_layer_design_2026-11-21 §3；計畫階段十）。
// 完成條件：
//   1 角色：審查與減半檢視的 prompt 多「新眼光」，排在分析師之後、多空（減半檢視是三票）之前；題目是設計原文；沒有升版號（v4 還沒部署）；
//     run.md 多「取新眼光的那一份」與 new_risks；prompt 裡的數字和程式的常數一致
//   2 新眼光拿不到前提、論點本文、歷次審查：給它的那一份（GET /ai/task/<編號>/fresh）由程式組，裡面沒有這些（也沒有條件與事件清單）；
//     有價格、目錄、原文與分析師取回的文件。這次沒有新眼光 → 403
//   3 new_risks：最多 3 條、每條一句加一個引用；引用照 check.ts 的逐字檢查（同一個函式，沒有放寬），沒通過的那一條拿掉；
//     引用的要是給它的文件；和現有前提的字重疊高的拿掉；彼此重複的拿掉
//   4 只當建議：同一組票，有沒有 new_risks，結論、檔位、通知、LINE 都一樣
//   5 「要看的事」NEW_RISK：文字照設計；持股頁列出；月報列一次
//   6 編輯論點頁：持股頁的資料帶著那幾件（引用與出處）；帶進右欄存檔 → 記成已帶進論點，不再列；前端的文字
//   7 頻率：減半檢視每次都跑；定期審查每檔每 90 個日曆天最多一次（程式決定、寫進證據包告訴 prompt）；逾時的那一次不算；
//     只有預設前提的不跑；沒有請它跑的那一次送回 new_risks 也不看
//   8 使用者看過不採用的，同一件事 180 天內不再列（之後的審查再提同一件也不列）；滿 180 天之後才再列
//   9 分析師替它留 8 份裡的 1 份：有新眼光時分析師第 8 份回 LIMIT；新眼光只能指定目錄裡的 1 份、不能給網址
// 對外請求全部是假的（價格、EDGAR、RSS、網頁、雲端排程、LINE）；AI 的回覆一律是假的。repo 是公開的。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DOCS_MAX, DOCS_MAX_CALLS, DOCS_MAX_CHARS, WEB_GIVE } from '../src/ai/added';
import { checkQuote, checkSample, judge, type EvidencePack, type PackDoc } from '../src/ai/check';
import { OWN_DROP, OWN_DROP_PROMPT, ownDropPack } from '../src/ai/drops';
import { FRESH_QUESTION, FRESH_RESERVE, FRESH_REVIEW_GAP_DAYS, FRESH_ROLE, NEW_RISKS_MAX, NEW_RISK_TEXT_MAX, RISK_SEEN_DAYS, checkNewRisks, freshPlan, freshView, overlapsPremise, type NewRiskItem } from '../src/ai/freshEyes';
import { PAYLOAD_HOOKS } from '../src/ai/hooks';
import { OWN_REVIEW, OWN_REVIEW_PROMPT, ownReviewPack, reviewDecision } from '../src/ai/ownReview';
import type { ApplyCtx, StartCtx } from '../src/app/aiCtx';
import { closeStaleRuns, getRun, lastFreshReview, listRuns, type AiRun } from '../src/app/aiRuns';
import { VALIDATORS } from '../src/app/aiTasks';
import { startDropRuns } from '../src/app/dropAi';
import type { Env, Fetcher } from '../src/app/env';
import { EXPORT_TABLES } from '../src/app/export';
import type { FilingCheck } from '../src/app/filings';
import { runFlow } from '../src/app/flow';
import { LINE_PUSH_URL } from '../src/app/line';
import { loadAccount, saveAccount } from '../src/app/ledgerStore';
import { applyOwnReview, startOwnReview } from '../src/app/ownAi';
import { foundView, risksView } from '../src/app/site/aiViews';
import type { RiskView } from '../src/app/site/thesisView';
import { OWN_ATTN, holdingAttention, monthOwnAttention, openRisks, ownAttention, riskLine, sameRisk, thesisFile, withRiskSeen, type ThesisFile, type ThesisPremise, type ThesisReview } from '../src/app/thesis';
import type { CompanyFacts, XbrlFact } from '../src/data/edgar';
import { buildMarketView } from '../src/data/marketView';
import { loadSeries } from '../src/data/store';
import { SYSTEM_DEFAULT_PREMISES, createAccount, type Account, type MarketView, type OwnMeta, type OwnWebSources, type Premise, type RiskSeen } from '../src/engine';
import { handle } from '../src/index';
import { freshDb } from './helpers/d1';
import { cronTime, fakeFetcher, newWorld, type World } from './helpers/fakeSources';

const PROMPTS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'ai', 'prompts');
const read = (f: string) => readFileSync(join(PROMPTS, f), 'utf8');
const REVIEW = `${OWN_REVIEW_PROMPT}.md`;
const DROP = `${OWN_DROP_PROMPT}.md`;

// 前端不碰 DOM 的部分直接 import（同 t56、t60 的寫法）
interface RisksJs {
  RISK_DAYS: number;
  RISK_TITLE: string;
  RISK_ROW_HINT: string;
  riskMeta(r: Partial<RiskView>): string;
  riskButtons(taken: boolean): { take: string | null; note: string | null; dismiss: string | null };
  riskDismissed(days?: number): string;
  riskPreviewLine(risks: unknown[] | null | undefined, days?: number): string | null;
}
const RJ = (await import('../public/js/thesis-risks.js' as string)) as RisksJs;

// ---------------------------------------------------------------- 1 prompt

describe('T63 prompt：新眼光那個角色（沒有升版號）', () => {
  it('沒有升版：審查 v4、減半檢視 v4；檔頭各有一段 T63 的說明', () => {
    expect([OWN_REVIEW_PROMPT, OWN_DROP_PROMPT]).toEqual(['own_review_v5', 'own_drop_v5']);
    for (const f of [REVIEW, DROP]) {
      const head = read(f).split('\n').slice(0, 8).join('\n');
      expect(head, f).toContain('新眼光（2026-11-21，T63，`composite_layer_design` §3；v4 還沒部署，直接改、沒有升版）');
      expect(head, f).toContain('**拿不到前提、論點本文與歷次審查**');
      expect(head, f).toContain('不影響三票、不影響檔位、不發通知');
    }
    expect(read(REVIEW).split('\n').slice(0, 8).join('\n')).toContain(`定期審查每檔每 ${FRESH_REVIEW_GAP_DAYS} 個日曆天最多一次`);
    expect(read(DROP).split('\n').slice(0, 8).join('\n')).toContain('減半檢視每次都跑');
  });

  it('順序：分析師 → 新眼光 → 多空（減半檢視是三票）；題目是設計原文；跑不跑看證據包的 fresh_eyes.run', () => {
    expect(FRESH_QUESTION).toBe('不看任何人的論點。這家公司現在最可能讓持有者後悔的三件事是什麼？各附原文引用。');
    const rv = read(REVIEW);
    const order = ['1. **分析師**', '2. **新眼光**', '3. **多方、空方**', '4. **經理**'].map((x) => rv.indexOf(x));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const dp = read(DROP);
    const order2 = ['1. **分析師**', '2. **新眼光**', '3. **三票**'].map((x) => dp.indexOf(x));
    expect(order2.every((i) => i > -1)).toBe(true);
    expect([...order2].sort((a, b) => a - b)).toEqual(order2);
    for (const [f, t] of [[REVIEW, rv], [DROP, dp]] as const) {
      expect(t, f).toContain(`題目（原樣給它）：「${FRESH_QUESTION}」`);
      expect(t, f).toContain('**只有證據包的 `fresh_eyes.run` 是 `true` 時才跑**');
      expect(t, f).toContain('- `fresh_eyes`（可能沒有）：這次要不要多跑「新眼光」那個角色，**由程式決定**');
      // 送回的 process 裡的角色名稱 = 取文件端點認的那個
      expect(t, f).toContain(`role 寫「${FRESH_ROLE}」`);
      expect(t, f).toContain(`"role": "${FRESH_ROLE}"`);
    }
  });

  it('拿不到前提：只給 fresh.json 與分析師摘要的前三段；分析師的前三段不能寫前提；新眼光不用 WebSearch、只能指定目錄裡的一份', () => {
    for (const f of [REVIEW, DROP]) {
      const t = read(f);
      expect(t, f).toContain('**不能讓它看到前提、論點本文與歷次審查**');
      expect(t, f).toContain('**只給它兩樣東西**：`fresh.json`，以及分析師摘要的**前三段**');
      expect(t, f).toContain('**不要給它** `task.json`');
      expect(t, f).toContain('沒有 `premises`、沒有論點那一份 note、沒有歷次審查的結論、沒有條件（`C`、`W`）與事件清單（`V`）');
      expect(t, f).toContain('**前三段不要提到前提與條件**');
      expect(t, f).toContain('**新眼光不用 WebSearch、不能給網址**');
      expect(t, f).toContain('只能從目錄（`M`）挑');
      expect(t, f).toContain('**不要讓新眼光看到前提、論點本文、歷次審查、條件**');
      // 原本的規則還在：只有分析師可以搜尋
      expect(t, f).toContain('**只有分析師可以用 WebSearch、可以取文件。**');
    }
    expect(read(REVIEW)).toContain('分析師摘要的第四段（條件）與第五段（這次另外找的資料：那一段是照前提逐句寫的）');
    expect(read(DROP)).toContain('分析師摘要的第四段（這次另外找的資料：那一段是照前提逐句寫的）');
  });

  it('new_risks 的格式與數字和程式一致：最多 3 條、一句話 120 字以內、一個引用；只當建議；留給新眼光的額度', () => {
    expect([NEW_RISKS_MAX, NEW_RISK_TEXT_MAX, FRESH_RESERVE.docs, FRESH_RESERVE.chars, FRESH_RESERVE.calls]).toEqual([3, 120, 1, 6000, 1]);
    for (const f of [REVIEW, DROP]) {
      const t = read(f);
      expect(t, f).toContain(`它交回 \`new_risks\`：**最多 ${NEW_RISKS_MAX} 條**，每條**一句話**（${NEW_RISK_TEXT_MAX} 字以內`);
      expect(t, f).toContain('加**一個引用**');
      expect(t, f).toContain('"new_risks": [');
      expect(t, f).toContain('程式逐字比對，**沒通過的那一條會被拿掉**');
      expect(t, f).toContain('**沒有跑新眼光的那一次不要放這個欄位**');
      expect(t, f).toContain('新眼光**只當建議**');
      expect(t, f).toContain('它不影響三票、不影響檔位、不發通知');
      // 分析師替它留的額度：8 − 1 份、6 − 1 次、60,000 − 6,000 字
      expect(t, f).toContain(`${DOCS_MAX} 份裡的 ${FRESH_RESERVE.docs} 份、${DOCS_MAX_CALLS} 次呼叫裡的 ${FRESH_RESERVE.calls} 次、${DOCS_MAX_CHARS.toLocaleString('en-US')} 字裡的 ${FRESH_RESERVE.chars.toLocaleString('en-US')} 字是**留給新眼光的**`);
      expect(t, f).toContain(`分析師最多取 ${DOCS_MAX - FRESH_RESERVE.docs} 份、呼叫 ${DOCS_MAX_CALLS - FRESH_RESERVE.calls} 次、${(DOCS_MAX_CHARS - FRESH_RESERVE.chars).toLocaleString('en-US')} 字`);
    }
    expect(read(REVIEW)).toContain('**`new_risks` 與新眼光的說明不給多方、空方與經理看**');
    expect(read(DROP)).toContain('**`new_risks` 與新眼光的說明不給三票看**');
  });

  it('run.md：多「取新眼光的那一份」（/fresh）、新眼光取文件的限制、送回的 new_risks；先部署 Worker 再貼', () => {
    const run = read('run.md');
    expect(run).toContain('2026-11-21（T63，`docs/design/composite_layer_design_2026-11-21.md` §3）再改過');
    expect(run).toContain('**一樣先部署 Worker 再貼**');
    expect(run).toContain('**取新眼光的那一份**');
    expect(run).toContain('/ai/task/<任務編號>/fresh');
    expect(run).toContain('**沒有前提、論點本文、歷次審查、條件與事件清單**');
    expect(run).toContain('`role` 寫「新眼光」的請求只能用 `menu`（不能給 `url`），這次執行最多 1 份');
    expect(run).toContain('"new_risks": []');
    expect(run).toContain('`new_risks` 只有功能的 prompt 有「新眼光」、而且這次有跑（證據包的 `fresh_eyes.run` 是 `true`）時才放');
    // 上網的規則沒有放寬
    expect(run).toContain('只有功能的 prompt 指定的那個角色可以用 WebSearch');
  });
});

// ---------------------------------------------------------------- 假的世界（決策日 2026-11-19）

const AS_OF = '2026-11-19';
const FILE = `NVDA@${AS_OF}`;
const THESIS_TEXT = 'AI 伺服器的資本支出還在擴張，資料中心的營收會延續高成長';
const PREMISES: Premise[] = [
  { id: 'P1', text: '資料中心需求延續到 2027', origin: 'USER', breaksIf: ['連兩季營收年增率低於 15%'], confirmsIf: '10-Q 的營收年增率仍高於 30%' },
  { id: 'P2', text: 'HBM 的合約價仍然逐季上漲', origin: 'USER', breaksIf: ['TrendForce 的新聞稿報 HBM 合約價季跌'] },
  // 信念：不進審查的證據包
  { id: 'P3', text: '大客戶的長約照約履行', origin: 'USER', verify: { by: 'NONE' } },
];
const COND_TEXT = '公司在 8-K 宣布下修全年資料中心營收財測';
const PRIOR_RUN = 'PRIOR_REVIEW_RUN_0001';
const WS: OwnWebSources = { peers: [{ name: 'Micron', edgar: 'MU' }], domains: ['news.skhynix.com'] };

const SENT = (tag: string, i: number) => `Paragraph ${i} of ${tag}: NAND spot prices have fallen about twenty percent in two weeks according to the survey. `;
const PARA = (s: string) => `<p>${s.repeat(Math.ceil(260 / s.length))}</p>`;
const page = (title: string, date: string, tag: string, n = 8) =>
  `<!doctype html><html><head><title>Site | ${title}</title><meta property="article:published_time" content="${date}T08:00:00Z"></head><body><ul><li>Home</li></ul><h1>${title}</h1>${Array.from({ length: n }, (_, i) => PARA(SENT(tag, i))).join('\n')}</body></html>`;
const TF = (n: number) => `https://www.trendforce.com/presscenter/news/2026111${n}-memory.html`;
const SK = (n: number) => `https://news.skhynix.com/story-${n}/`;
const BIG = (n: number) => `https://www.trendforce.com/presscenter/news/big-${n}.html`;
const BIGSK = (n: number) => `https://news.skhynix.com/big-${n}/`;
const PAGES: Record<string, string> = Object.fromEntries([
  ...[1, 2, 3, 4].map((n) => [TF(n), page(`TrendForce story ${n}`, `2026-11-1${n}`, `TF${n}`)]),
  ...[1, 2, 3, 4].map((n) => [SK(n), page(`SK hynix story ${n}`, `2026-11-1${n}`, `SK${n}`)]),
  // 每篇超過 12,000 字（給 AI 的只取開頭 12,000 字）
  ...[1, 2, 3, 4].map((n) => [BIG(n), page(`TrendForce long ${n}`, `2026-11-1${n}`, `BIGTF${n}`, 60)]),
  ...[1, 2].map((n) => [BIGSK(n), page(`SK hynix long ${n}`, `2026-11-1${n}`, `BIGSK${n}`, 60)]),
]);
const Q_TF1 = 'Paragraph 0 of TF1: NAND spot prices have fallen about twenty percent in two weeks';
const HEADLINE = 'NAND spot prices slide for a second week';
const Q_REV = 'Revenue for the third quarter was $160 million, up 33% from a year ago';

function quarterFacts(qs: { end: string; rev: number; filed: string }[]): CompanyFacts {
  const rev: XbrlFact[] = qs.map((q) => {
    const [y, m] = q.end.split('-').map(Number);
    return { start: `${y}-${String(m - 2).padStart(2, '0')}-01`, end: q.end, val: q.rev, accn: `acc-${q.filed}`, form: '10-Q', filed: q.filed };
  });
  return { cik: 1045810, facts: { 'us-gaap': { Revenues: { units: { USD: rev } } } } };
}
const BASE = quarterFacts([
  { end: '2025-09-30', rev: 120, filed: '2025-11-01' },
  { end: '2026-09-30', rev: 160, filed: '2026-10-30' },
]);
interface FakeFiling {
  accession: string;
  form: string;
  items: string;
  acceptanceDateTime: string;
  filingDate: string;
  primaryDocument: string;
  html: string;
}
const TENQ: FakeFiling = { accession: '0001045810-26-000300', form: '10-Q', items: '', acceptanceDateTime: '2026-10-30T20:10:00.000Z', filingDate: '2026-10-30', primaryDocument: 'q.htm', html: `<html><body><p>Item 2. Management’s Discussion and Analysis of Financial Condition and Results of Operations</p><p>${Q_REV}.</p><p>Item 3. Quantitative and Qualitative Disclosures About Market Risk</p></body></html>` };
// 同業的財報新聞稿：在上一次有結論的審查（2026-11-19 13:00Z）之後才申報，所以會列進目錄
const MU_K: FakeFiling = { accession: '0000723125-26-000101', form: '8-K', items: '2.02', acceptanceDateTime: '2026-11-19T21:00:00.000Z', filingDate: '2026-11-19', primaryDocument: 'mu1.htm', html: '<html><body><p>Item 2.02 Micron reported record HBM revenue and plans to expand HBM capacity.</p></body></html>' };
const subs = (cik: string, name: string, fs: FakeFiling[]) =>
  Response.json({ cik, name, tickers: [], filings: { recent: { accessionNumber: fs.map((f) => f.accession), form: fs.map((f) => f.form), items: fs.map((f) => f.items), acceptanceDateTime: fs.map((f) => f.acceptanceDateTime), filingDate: fs.map((f) => f.filingDate), primaryDocument: fs.map((f) => f.primaryDocument) } } });
const rss = (items: { title: string; link: string; date: string }[]) => `<rss><channel>${items.map((i) => `<item><title>${i.title}</title><link>${i.link}</link><pubDate>${new Date(`${i.date}T12:00:00Z`).toUTCString()}</pubDate></item>`).join('')}</channel></rss>`;
const NVDA_RSS = rss([{ title: HEADLINE, link: TF(1), date: '2026-11-18' }]);

function fetcherOf(w: World, line: string[]): Fetcher {
  const base = fakeFetcher(w);
  return async (url, init) => {
    if (url === LINE_PUSH_URL) {
      line.push((JSON.parse(String(init?.body)) as { messages: { text: string }[] }).messages[0].text);
      return Response.json({});
    }
    if (url === 'https://api.example/fire') return Response.json({ claude_code_session_url: 'https://claude.ai/code/x' });
    if (url.includes('submissions/CIK0001045810.json')) return subs('1045810', 'NVIDIA CORP', [TENQ]);
    if (url.includes('submissions/CIK0000723125.json')) return subs('723125', 'MICRON TECHNOLOGY INC', [MU_K]);
    if (/companyfacts\/CIK\d+\.json/.test(url)) return Response.json(BASE);
    const doc = /Archives\/edgar\/data\/(\d+)\/(\d+)\/(.+)$/.exec(url);
    if (doc) {
      const f = [TENQ, MU_K].find((x) => x.accession.replace(/-/g, '') === doc[2]);
      if (!f) return new Response('nf', { status: 404 });
      return doc[3] === 'index.json' ? Response.json({ directory: { item: [{ name: f.primaryDocument }] } }) : new Response(f.html);
    }
    if (url.startsWith('https://www.nasdaq.com/feed/rssoutbound')) return new Response(url.includes('NVDA') ? NVDA_RSS : '<rss><channel></channel></rss>');
    if (url.startsWith('https://feeds.finance.yahoo.com/rss/2.0/headline')) return new Response('<rss><channel></channel></rss>');
    if (PAGES[url]) return new Response(PAGES[url], { headers: { 'content-type': 'text/html; charset=utf-8' } });
    return base(url, init);
  };
}

interface Ctx {
  db: D1Database;
  env: Env;
  fetcher: Fetcher;
  line: string[];
  view: MarketView;
  axis: string[];
  call: <T = Record<string, unknown>>(method: 'GET' | 'POST', path: string, body?: unknown, now?: string) => Promise<{ status: number; body: T }>;
}
const acctOf = async (db: D1Database): Promise<Account> => (await loadAccount(db))!.acct;

async function withWorld(fn: (c: Ctx) => Promise<void>, opt: { defaults?: boolean } = {}) {
  const d = await freshDb();
  try {
    const db = d.db;
    const w = newWorld(AS_OF);
    const line: string[] = [];
    const env: Env = { DB: db, ADMIN_TOKEN: 't', AI_TASK_SECRET: 's', EDGAR_USER_AGENT: 'test bot test@example.com', SITE_URL: 'https://bot.example', LINE_CHANNEL_TOKEN: 'lt', LINE_USER_ID: 'U1', DEV_NO_AUTH: '1', ROUTINE_FIRE_URL: 'https://api.example/fire', ROUTINE_TOKEN: 'rt' };
    const fetcher = fetcherOf(w, line);
    await runFlow(env, fetcher, { now: cronTime(AS_OF), attempt: 'FIRST' });
    const { view, axis } = buildMarketView(await loadSeries(db, ['VOO', 'SGOV', 'NVDA']), AS_OF, 'VOO');
    const acct = createAccount({ paper: true, cash: 5000, core: { VOO: Math.floor(140_000 / view.close.VOO[view.i]) }, own: { NVDA: { shares: Math.floor(40_000 / view.close.NVDA[view.i]), stdWeight: 0.15, premises: structuredClone(opt.defaults ? SYSTEM_DEFAULT_PREMISES : PREMISES) } } }, view);
    if (!opt.defaults) {
      acct.own.NVDA.webSources = structuredClone(WS);
      acct.own.NVDA.thesis = { text: THESIS_TEXT, setAt: AS_OF, source: 'TYPED', version: 1, afterBreak: 0, lastAfterBreakAt: null };
    }
    await saveAccount(db, acct, null, '建立帳戶', new Date(`${AS_OF}T12:00:00Z`));
    if (!opt.defaults) {
      // 你定的條件（C1）與一次之前有結論的定期審查（論點那一份 note 會寫它；減半檢視拿它當底）
      await db
        .prepare('INSERT INTO own_conditions (ticker, run_id, cond_id, direction, kind, text, check_json, tier_if_met, status, created_at, origin, file_id, accepted_at, action, auto) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind('NVDA', 'r0', 'U1', 'DOWN', 'EVENT', COND_TEXT, JSON.stringify({ type: 'event', confirm_by: ['8-K'] }), 'HALF', 'ACTIVE', `${AS_OF}T12:00:00.000Z`, 'USER', FILE, `${AS_OF}T12:30:00.000Z`, 'HALF', 1)
        .run();
      const pack = ownReviewPack({ acct, view, axis, ticker: 'NVDA', runId: PRIOR_RUN, trigger: 'MANUAL', xbrl: null, filings: [], news: null, dataQuality: {}, now: new Date(`${AS_OF}T13:00:00Z`) }).pack;
      const sample = (index: number) => ({ index, valid: true, verdict: 'HOLD', rawVerdict: 'HOLD', issues: [], evidence: [], premises: [{ premise_id: 'P1', status: 'HOLDS', evidence_ids: [] }, { premise_id: 'P2', status: 'INSUFFICIENT', evidence_ids: [] }], conditions: [], abstainReason: null, dataMissing: [], model: 'm', payload: {}, report: '上一次審查的報告：維持現狀' });
      const outcome = { status: 'AGREED', verdict: 'HOLD', votes: { HOLD: 3 }, actionable: false, followRule: true, reason: '', samples: [0, 1, 2].map(sample) };
      await db
        .prepare("INSERT INTO ai_runs (run_id, fn, ticker, as_of, created_at, status, prompt_version, pack_hash, pack, outcome, applied_at) VALUES (?, 'OWN_REVIEW', 'NVDA', ?, ?, 'DONE', 'own_review_v3', 'h', ?, ?, ?)")
        .bind(PRIOR_RUN, AS_OF, `${AS_OF}T13:00:00.000Z`, JSON.stringify(pack), JSON.stringify(outcome), `${AS_OF}T13:01:00.000Z`)
        .run();
    }
    const call: Ctx['call'] = async (method, path, b, now = '2026-11-20T01:10:00Z') => {
      const r = await handle(new Request(`https://bot.example${path}`, { method, headers: { 'Content-Type': 'application/json', ...(path.startsWith('/ai/') ? { Authorization: 'Bearer s' } : {}) }, ...(b === undefined ? {} : { body: JSON.stringify(b) }) }), env, fetcher, new Date(now));
      return { status: r.status, body: (await r.json()) as never };
    };
    await fn({ db, env, fetcher, line, view, axis, call });
  } finally {
    await d.dispose();
  }
}

const T0 = new Date('2026-11-20T01:00:00Z');
const review = async (c: Ctx, date = AS_OF, now = T0) => startOwnReview(c.env, c.fetcher, await acctOf(c.db), { ...c.view, date }, c.axis, 'NVDA', 'MANUAL', now);

type Shell = { run_id: string; verdict: string; premise_checks: unknown[]; evidence: unknown[]; payload: Record<string, unknown>; report: string };
/** 三票一樣的假票：P1 成立（引用 10-Q 的營收）、P2 證據不足，維持現狀。 */
function holdVotes(run: AiRun): Shell[] {
  const filing = run.pack.documents.find((d) => d.kind === 'filing')!;
  const v: Shell = {
    run_id: run.runId,
    verdict: 'HOLD',
    premise_checks: [{ premise_id: 'P1', status: 'HOLDS', evidence_ids: ['E1'], confirm_ids: ['E1'] }, { premise_id: 'P2', status: 'INSUFFICIENT', evidence_ids: [] }],
    evidence: [{ id: 'E1', source_id: filing.source_id, date: filing.date, quote: Q_REV, claim: '營收年增' }],
    payload: { tier: 'HOLD', condition_checks: [], proposed_conditions: [] },
    report: '維持。',
  };
  return [v, v, v];
}
const sendResult = (c: Ctx, run: AiRun, extra: Record<string, unknown> = {}, now?: string) => c.call('POST', `/ai/task/${run.taskId}/result`, { task_id: run.taskId, kind: 'RUN', run_id: run.runId, samples: holdVotes(run), process: [{ role: '分析師', text: '摘要' }], ...extra }, now);

const RISK_NAND = 'NAND 現貨價兩週跌兩成，而 NAND 約占營收三成';
const RISK_NAND_AGAIN = 'NAND 現貨價兩週內跌了兩成，NAND 約占營收三成';
const RISK_LIKE_P2 = 'HBM 的合約價不再逐季上漲';
const RISK_LIKE_BELIEF = '大客戶的長約沒有照約履行';

interface DocsBody {
  docs: { source_id: string; date: string; text: string; title: string }[];
  refused: { url?: string; menu?: string; reason: string; detail: string | null }[];
  left: { docs: number; chars: number; calls: number };
}
interface FreshBody {
  fresh: ReturnType<typeof freshView>;
}
interface HoldingBody {
  attention: { kind: string; text: string }[];
  thesis: { risks: RiskView[] };
}

/** 開一次審查、分析師取 TrendForce 那一篇、送回三票與 new_risks。回傳執行與取回的那一份。 */
async function runWithRisks(c: Ctx, risksOf: (tf: DocsBody['docs'][number]) => unknown) {
  const r = await review(c);
  await c.call('GET', `/ai/task/${r.taskId}/evidence`);
  const got = await c.call<DocsBody>('POST', `/ai/task/${r.taskId}/docs`, { role: '分析師', want: [{ menu: 'M2', for: 'P2', why: '相反：現貨價' }] });
  expect(got.status).toBe(200);
  const tf = got.body.docs[0];
  const res = await sendResult(c, r, { new_risks: risksOf(tf) });
  expect(res.status).toBe(200);
  return { run: (await getRun(c.db, r.runId))!, tf };
}

// ---------------------------------------------------------------- 2 給新眼光的那一份

describe('T63：新眼光拿不到前提、論點本文與歷次審查（給它的那一份由程式組）', () => {
  it('定期審查：/fresh 的回應沒有前提、論點本文、歷次審查、條件；有價格、目錄、原文與分析師取回的文件', async () => {
    await withWorld(async (c) => {
      const r = await review(c);
      expect(r.pack.fresh_eyes).toEqual({ run: true, why: '這檔的定期審查還沒跑過新眼光', max_risks: 3, docs: 1 });
      // 原本的證據包確實有這些（不然下面的「沒有」沒有意義）
      const whole = JSON.stringify(r.pack);
      for (const s of [PREMISES[0].text, PREMISES[1].text, '連兩季營收年增率低於 15%', THESIS_TEXT, COND_TEXT, PRIOR_RUN, '最近的定期審查']) expect(whole, s).toContain(s);
      expect(r.pack.documents.some((d) => d.source_id === `thesis:${FILE}`)).toBe(true);
      expect(r.pack.facts.map((f) => f.id)).toEqual(expect.arrayContaining(['T0', 'C1', 'R1', 'M1', 'M2', 'S1']));

      // 還沒取證據包 → 409
      expect((await c.call('GET', `/ai/task/${r.taskId}/fresh`)).status).toBe(409);
      await c.call('GET', `/ai/task/${r.taskId}/evidence`);
      const got = await c.call<DocsBody>('POST', `/ai/task/${r.taskId}/docs`, { role: '分析師', want: [{ menu: 'M2', for: 'P2', why: '相反：現貨價' }] });
      const res = await c.call<FreshBody>('GET', `/ai/task/${r.taskId}/fresh`);
      expect(res.status).toBe(200);
      const f = res.body.fresh;
      const text = JSON.stringify(res.body);

      // 沒有：前提（本文、怎樣算不成立、怎樣算證實）、信念、論點本文、歷次審查、條件、論點檔的字樣
      for (const p of PREMISES) expect(text, p.id).not.toContain(p.text);
      for (const s of ['連兩季營收年增率低於 15%', 'TrendForce 的新聞稿報 HBM 合約價季跌', '10-Q 的營收年增率仍高於 30%', THESIS_TEXT, COND_TEXT, PRIOR_RUN, '上一次審查的報告', '論點檔', '最近的定期審查', '靜默', 'premises', 'breaksIf', 'confirmsIf']) expect(text, s).not.toContain(s);
      expect(f).not.toHaveProperty('premises');
      expect(f).not.toHaveProperty('rule');
      expect(f.documents.some((d) => d.kind === 'note' || /^(thesis|review):/.test(d.source_id))).toBe(false);
      // 數字只有價格（F）、來源（S）、目錄（M）：沒有論點檔種類、條件、觀察項、事件、規則狀態與上一次的檔位
      expect(f.facts.length).toBeGreaterThan(0);
      expect(f.facts.every((x) => /^(?:[FASM]\d+|M\+)$/.test(x.id))).toBe(true);
      expect(f.facts.map((x) => x.id)).toEqual(expect.arrayContaining(['F1', 'S1', 'M1', 'M2']));
      // 題目是固定的那一句，不是原本那一題（原本那一題寫著要逐條檢查前提）
      expect(f.question).toBe(FRESH_QUESTION);
      expect(text).not.toContain(r.pack.question);
      expect(f).toMatchObject({ run_id: r.runId, function: OWN_REVIEW, as_of: AS_OF, role: '新眼光', max_risks: 3, docs: 1, subject: { ticker: 'NVDA' } });
      expect(f.omitted).toEqual(expect.arrayContaining(['使用者的前提', '論點本文', '歷次審查的結論與使用者的回應']));
      // 有：申報與財報表的原文、價格、新聞標題，以及分析師取回的那一份
      const kinds = new Set(f.documents.map((d) => d.kind));
      for (const k of ['filing', 'xbrl', 'price', 'news', 'web']) expect(kinds.has(k as PackDoc['kind']), k).toBe(true);
      expect(f.documents.find((d) => d.source_id === got.body.docs[0].source_id)!.text).toContain(Q_TF1);
      expect(f.documents.find((d) => d.kind === 'news')!.text).toContain(HEADLINE);

      // 送回結果之後 → 410
      await sendResult(c, r);
      expect((await c.call('GET', `/ai/task/${r.taskId}/fresh`)).status).toBe(410);
      // 沒帶金鑰 → 401
      const noAuth = await handle(new Request(`https://bot.example/ai/task/${r.taskId}/fresh`), c.env, c.fetcher, T0);
      expect(noAuth.status).toBe(401);
    });
  });

  it('freshView 是白名單：不認得的數字與文件種類一律不給（之後加進證據包的東西不會自己漏給新眼光）', () => {
    const pack = {
      pack_version: 1,
      run_id: 'r',
      function: OWN_REVIEW,
      prompt_version: OWN_REVIEW_PROMPT,
      as_of: AS_OF,
      created_at: '',
      subject: { ticker: 'MU' },
      question: '請逐條檢查使用者的前提',
      policy: { level: 'A3', verdicts: ['HOLD'], abstain: 'HOLD', min_evidence: 1, samples: 3 },
      rule: { action: '規則', detail: { conds: { C1: 7 }, reasons: ['WEB_DUE'] } },
      facts: ['F1', 'A2', 'S1', 'M3', 'M+', 'R1', 'R5', 'T0', 'D1', 'C1', 'W1', 'V1', 'Z9'].map((id) => ({ id, label: id, value: id })),
      premises: [{ id: 'P1', text: '前提' }],
      documents: (['filing', 'xbrl', 'news', 'price', 'table', 'web', 'note', 'rule'] as PackDoc['kind'][]).map((kind, k): PackDoc => ({ id: `D${k}`, source_id: `${kind}:x`, kind, date: AS_OF, title: kind, text: 'x'.repeat(20) })).concat([{ id: 'B', source_id: 'review:r0', kind: 'filing', date: AS_OF, title: '審查摘要', text: 'y'.repeat(20) }]),
      data_quality: {},
      condition_types: [],
      fresh_eyes: { run: true, why: 'w', max_risks: 3, docs: 0 },
    } as EvidencePack;
    const f = freshView(pack);
    expect(f.facts.map((x) => x.id)).toEqual(['F1', 'A2', 'S1', 'M3', 'M+']);
    expect(f.documents.map((d) => d.kind)).toEqual(['filing', 'xbrl', 'news', 'price', 'table', 'web']);
    expect(f.docs).toBe(0);
    expect(Object.keys(f).sort()).toEqual(['as_of', 'data_quality', 'docs', 'documents', 'facts', 'function', 'max_risks', 'omitted', 'question', 'role', 'run_id', 'subject']);
  });

  it('減半檢視：每次都跑（證據包 fresh_eyes.run = true）；/fresh 沒有最近一次審查的摘要、論點那一份與前提；只有預設前提的不跑、/fresh 回 403', async () => {
    const CHECKS: FilingCheck[] = [{ ticker: 'NVDA', cik: '0001045810', names: [], sic: null, all: [{ accession: TENQ.accession, form: '10-Q', filingDate: TENQ.filingDate, acceptedAt: TENQ.acceptanceDateTime, items: [], primaryDocument: 'q.htm' }], fresh: [], latest: '' }];
    const startCtx = async (c: Ctx, session: string): Promise<StartCtx> => ({ env: c.env, fetcher: c.fetcher, acct: await acctOf(c.db), view: { ...c.view, date: session }, axis: c.axis, session, ov: {}, now: new Date(`${session}T23:45:00Z`), checks: CHECKS, res: { created: [], started: [], log: [], alerts: [] }, extras: { reduced: [{ ticker: 'NVDA', session }] } });
    // listRuns 會先把逾時的執行結束掉：用開執行那一刻的時間讀
    const drops = async (c: Ctx) => (await listRuns(c.db, new Date(`${AS_OF}T23:50:00Z`), { limit: 50 })).filter((x) => x.fn === OWN_DROP).sort((a, b) => a.asOf.localeCompare(b.asOf));
    await withWorld(async (c) => {
      await startDropRuns(await startCtx(c, AS_OF));
      const [d1] = await drops(c);
      expect(d1.promptVersion).toBe('own_drop_v5');
      expect(d1.pack.fresh_eyes).toEqual({ run: true, why: '減半檢視每次都跑新眼光', max_risks: 3, docs: 1 });
      expect(d1.docCtx?.fresh).toEqual({ docs: 1, chars: 6000, calls: 1 });
      // 原本的證據包有最近一次審查的摘要（review:）與論點那一份
      expect(d1.pack.documents.map((x) => x.source_id)).toEqual(expect.arrayContaining([`review:${PRIOR_RUN}`, `thesis:${FILE}`]));
      await c.call('GET', `/ai/task/${d1.taskId}/evidence`, undefined, '2026-11-20T00:00:00Z');
      const res = await c.call<FreshBody>('GET', `/ai/task/${d1.taskId}/fresh`, undefined, '2026-11-20T00:01:00Z');
      expect(res.status).toBe(200);
      const text = JSON.stringify(res.body);
      for (const s of [PREMISES[0].text, PREMISES[1].text, THESIS_TEXT, COND_TEXT, PRIOR_RUN, '上一次審查的報告', '最近一次定期審查', '論點檔']) expect(text, s).not.toContain(s);
      expect(res.body.fresh.documents.some((x) => x.kind === 'note')).toBe(false);
      expect(res.body.fresh.documents.some((x) => x.kind === 'price')).toBe(true);
      // 隔一週又觸發一次：照樣跑（減半檢視沒有 90 天的限制）
      await startDropRuns(await startCtx(c, '2026-11-27'));
      const d2 = (await drops(c)).find((x) => x.asOf === '2026-11-27')!;
      expect(d2.pack.fresh_eyes).toEqual({ run: true, why: '減半檢視每次都跑新眼光', max_risks: 3, docs: 1 });
      // 減半檢視的新眼光不占定期審查那一次：之後第一次定期審查照樣跑
      expect(await lastFreshReview(c.db, 'NVDA', '2026-11-27')).toBeNull();
    });
    await withWorld(
      async (c) => {
        await startDropRuns(await startCtx(c, AS_OF));
        const [d] = await drops(c);
        expect(d.pack.fresh_eyes).toEqual({ run: false, why: '這檔還沒有使用者的論點（只有系統預設前提），不跑新眼光', max_risks: 3, docs: 0 });
        expect(d.docCtx?.fresh).toBeUndefined();
        await c.call('GET', `/ai/task/${d.taskId}/evidence`, undefined, '2026-11-20T00:00:00Z');
        expect((await c.call('GET', `/ai/task/${d.taskId}/fresh`, undefined, '2026-11-20T00:01:00Z')).status).toBe(403);
      },
      { defaults: true },
    );
  });
});

// ---------------------------------------------------------------- 3 new_risks 的程式檢查

const TENQ_DOC: PackDoc = { id: 'D1', source_id: 'edgar:q3', kind: 'filing', date: '2026-10-30', title: '10-Q 2026-10-30：MD&A', text: `${Q_REV}. NAND represented approximately 30% of total revenue. Inventory days rose to 150 from 120.` };
const NEWS_DOC: PackDoc = { id: 'N', source_id: 'yahoo-rss:MU', kind: 'news', date: '2026-11-18', title: 'MU 最近的新聞標題（Yahoo，只有標題）', text: `2026-11-18 | ${HEADLINE}` };
const NOTE_DOC: PackDoc = { id: 'T', source_id: 'thesis:MU@2026-01-02', kind: 'note', date: AS_OF, title: 'MU 的論點檔（背景，不是前提成立的證據）', text: '論點：記憶體的超級循環還在前半段，NAND 的庫存已經去化完畢。' };
const Q_NAND = 'NAND represented approximately 30% of total revenue';
const Q_INV = 'Inventory days rose to 150 from 120';

function unitPack(over: Partial<EvidencePack> = {}): EvidencePack {
  return {
    pack_version: 1,
    run_id: 'u63',
    function: OWN_REVIEW,
    prompt_version: OWN_REVIEW_PROMPT,
    as_of: AS_OF,
    created_at: `${AS_OF}T23:40:00Z`,
    subject: { ticker: 'MU' },
    question: 'q',
    policy: { level: 'A3', verdicts: ['EXIT', 'HALF', 'HOLD', 'STANDARD'], abstain: 'HOLD', min_evidence: 1, samples: 3 },
    rule: { action: '規則這次沒有動作' },
    facts: [],
    premises: [
      { id: 'P4', text: 'DRAM 合約價維持季漲', breaksIf: ['TrendForce 報 DRAM 合約價季跌', '庫存天數連兩季上升'] },
      { id: 'P5', text: 'HBM 的市占沒有流失', confirmsIf: '公司的 HBM 營收季增' },
    ],
    documents: [TENQ_DOC, NEWS_DOC, NOTE_DOC],
    data_quality: {},
    condition_types: [],
    fresh_eyes: { run: true, why: 'w', max_risks: 3, docs: 1 },
    ...over,
  };
}
const risk = (text: string, doc: PackDoc, quote: string, date = doc.date) => ({ text, source_id: doc.source_id, date, quote });
const brief = (x: NewRiskItem) => [x.k, x.ok, x.drop ?? null];

describe('T63：new_risks 的程式檢查（最多 3 條、每條一句加一個引用）', () => {
  it('通過的：一句話加一個逐字的引用；記下引用出自哪一份（只有新聞標題的標出來）', () => {
    const rec = checkNewRisks(unitPack(), [risk('NAND 約占營收三成，現貨價轉跌會直接拖累營收', TENQ_DOC, Q_NAND), risk('有報導的標題說 NAND 現貨價連兩週下滑', NEWS_DOC, HEADLINE)])!;
    expect(rec).toMatchObject({ asked: true, returned: true });
    expect(rec.items.map(brief)).toEqual([[0, true, null], [1, true, null]]);
    expect(rec.items[0]).toMatchObject({ text: 'NAND 約占營收三成，現貨價轉跌會直接拖累營收', source_id: 'edgar:q3', date: '2026-10-30', quote: Q_NAND, doc: { title: TENQ_DOC.title, date: '2026-10-30', url: null, headline: false } });
    expect(rec.items[1].doc).toMatchObject({ headline: true });
  });

  it('引用照 check.ts 的逐字檢查，沒有放寬：改寫過的、太短的、日期在決策日之後的、來源不在證據包的，那一條拿掉', () => {
    const bad = [
      risk('庫存天數上升', TENQ_DOC, 'Inventory days increased to 150 from 120'), // 改寫過
      risk('庫存天數上升', TENQ_DOC, 'Inventory'), // 太短
      risk('庫存天數上升', TENQ_DOC, Q_INV, '2026-11-25'), // 日期在決策日之後
    ];
    const rec = checkNewRisks(unitPack(), bad)!;
    expect(rec.items.map(brief)).toEqual([[0, false, 'QUOTE'], [1, false, 'QUOTE'], [2, false, 'QUOTE']]);
    expect(rec.items.map((x) => x.why)).toEqual(['引用不是原文的子字串', '引用太短（至少 12 個字）', '日期 2026-11-25 在決策日 2026-11-19 之後']);
    expect(checkNewRisks(unitPack(), [{ text: '庫存天數上升', source_id: 'web:not-in-pack', date: AS_OF, quote: Q_INV }])!.items[0]).toMatchObject({ ok: false, drop: 'QUOTE', why: '來源 web:not-in-pack 不在證據包裡' });
    // 和每一票的 evidence 是同一套規則：同樣的四條引用放進一票裡，結果一模一樣
    const pack = unitPack();
    const evs = [...bad, risk('x', TENQ_DOC, Q_INV)].map((r, k) => ({ id: `E${k}`, source_id: r.source_id, date: r.date, quote: r.quote, claim: 'c' }));
    const s = checkSample(pack, { run_id: pack.run_id, verdict: 'HOLD', premise_checks: [], evidence: evs, payload: { tier: 'HOLD' }, report: 'r' }, 0, PAYLOAD_HOOKS[OWN_REVIEW]);
    expect(s.evidence.map((e) => [e.ok, e.why ?? null])).toEqual(evs.map((e) => [checkQuote(pack, e).ok, checkQuote(pack, e).why ?? null]));
    expect(s.evidence.map((e) => e.ok)).toEqual([false, false, false, true]);
  });

  it('最多 3 條：只看前 3 條，第 4 條起拿掉（就算它的引用是對的）', () => {
    const four = [risk('第一件：營收集中在 NAND', TENQ_DOC, Q_NAND), risk('第二件：庫存天數升到 150 天', TENQ_DOC, Q_INV), risk('第三件：有報導的標題說現貨價下滑', NEWS_DOC, HEADLINE), risk('第四件：年增率可能放慢', TENQ_DOC, Q_REV)];
    const rec = checkNewRisks(unitPack(), four)!;
    expect(rec.items.map(brief)).toEqual([[0, true, null], [1, true, null], [2, true, null], [3, false, 'EXTRA']]);
    expect(rec.items[3].why).toBe('超過 3 條，只看前 3 條');
  });

  it('和現有前提的字重疊高的拿掉（本文、怎樣算不成立的每一句、怎樣算證實都比）；不重疊的留著', () => {
    const rec = checkNewRisks(unitPack(), [risk('DRAM 合約價不再維持季漲', TENQ_DOC, Q_REV), risk('庫存天數已經連兩季上升', TENQ_DOC, Q_INV), risk('NAND 約占營收三成，現貨價轉跌會拖累營收', TENQ_DOC, Q_NAND)])!;
    expect(rec.items.map(brief)).toEqual([[0, false, 'OVERLAP'], [1, false, 'OVERLAP'], [2, true, null]]);
    expect(rec.items[0]).toMatchObject({ premiseId: 'P4', why: '和現有的前提 P4 的字重疊高（已經有人看了）' });
    expect(rec.items[1].premiseId).toBe('P4');
    expect(overlapsPremise('公司的 HBM 營收沒有季增', unitPack().premises)).toBe('P5');
    expect(overlapsPremise('資料中心客戶延後拉貨', unitPack().premises)).toBeNull();
  });

  it('引用論點那一份的拿掉（不是給新眼光的文件）；彼此重複的拿掉；沒寫字、太長、格式不對的拿掉', () => {
    const rec = checkNewRisks(unitPack(), [risk('NAND 的庫存其實還沒去化完', NOTE_DOC, 'NAND 的庫存已經去化完畢'), risk('NAND 約占營收三成，現貨價轉跌會拖累營收', TENQ_DOC, Q_NAND), risk('NAND 約占營收三成，現貨價一轉跌就會拖累營收', TENQ_DOC, Q_NAND)])!;
    expect(rec.items.map(brief)).toEqual([[0, false, 'NOT_GIVEN'], [1, true, null], [2, false, 'DUP']]);
    const fmt = checkNewRisks(unitPack(), ['只有一句話', risk('', TENQ_DOC, Q_NAND), risk('長'.repeat(NEW_RISK_TEXT_MAX + 1), TENQ_DOC, Q_NAND)])!;
    expect(fmt.items.map(brief)).toEqual([[0, false, 'FORMAT'], [1, false, 'FORMAT'], [2, false, 'FORMAT']]);
    expect(fmt.items[2].why).toBe('太長（一句話，120 字以內）');
    // 剛好 120 字可以
    expect(checkNewRisks(unitPack(), [risk('短'.repeat(NEW_RISK_TEXT_MAX), TENQ_DOC, Q_NAND)])!.items[0].ok).toBe(true);
  });

  it('沒有請新眼光跑的那一次，送回 new_risks 也不看；有請但沒交 → 記成沒有交；交了空的 → 沒有找到', () => {
    const good = [risk('NAND 約占營收三成', TENQ_DOC, Q_NAND)];
    expect(checkNewRisks(unitPack({ fresh_eyes: { run: false, why: '未滿 90 天', max_risks: 3, docs: 0 } }), good)).toBeNull();
    expect(checkNewRisks(unitPack({ fresh_eyes: undefined }), good)).toBeNull();
    expect(checkNewRisks(unitPack(), undefined)).toEqual({ asked: true, returned: false, items: [] });
    expect(checkNewRisks(unitPack(), [])).toEqual({ asked: true, returned: true, items: [] });
    expect(checkNewRisks(unitPack(), { text: '不是陣列' })).toEqual({ asked: true, returned: true, items: [] });
  });

  it('送回結果的外層收 new_risks（不會整份退回）；匯出的 JSON 欄位有 new_risks', () => {
    const ok = VALIDATORS.RUN({ task_id: 't', kind: 'RUN', run_id: 'r', samples: [{}], new_risks: [{ text: 'x' }] }, { run_id: 'r' });
    expect(ok).toBeNull();
    expect(VALIDATORS.RUN({ task_id: 't', kind: 'RUN', run_id: 'r', samples: [{}], new_risk: [] }, { run_id: 'r' })).toContain('多了不認得的欄位');
    expect(EXPORT_TABLES.ai_runs.json).toContain('new_risks');
  });
});

// ---------------------------------------------------------------- 4～6 整條流程：只當建議、要看的事、編輯論點頁

describe('T63：整條流程（假的 AI 回覆）', () => {
  // T71（confirm_audit_design §4）改了這個行為：新風險不再列「要看的事」，只放持股頁的審查那一塊（thesis.risks）與紀錄頁
  it('送回 new_risks → 逐條檢查後存下來；通過的不列「要看的事」（T71）、持股頁帶著引用；紀錄頁列出拿掉的與原因', async () => {
    await withWorld(async (c) => {
      const { run, tf } = await runWithRisks(c, (d) => [
        { text: RISK_NAND, source_id: d.source_id, date: d.date, quote: Q_TF1 },
        { text: RISK_LIKE_P2, source_id: d.source_id, date: d.date, quote: Q_TF1 },
        { text: RISK_LIKE_BELIEF, source_id: d.source_id, date: d.date, quote: 'Paragraph 1 of TF1: NAND spot prices have fallen' },
        { text: '第四件事', source_id: d.source_id, date: d.date, quote: Q_TF1 },
      ]);
      expect(run.outcome!.status).toBe('INSUFFICIENT');
      expect(run.newRisks!.items.map(brief)).toEqual([[0, true, null], [1, false, 'OVERLAP'], [2, true, null], [3, false, 'EXTRA']]);
      expect(run.newRisks!.items[0].doc).toMatchObject({ date: tf.date, url: TF(1), headline: false });

      // 「要看的事」不列（T71）；信念 P3 不在證據包裡，和它重疊的那一條在列給持股頁時拿掉（已經有人看了）→ 持股頁只剩一件
      const acct = await acctOf(c.db);
      expect((await holdingAttention(c.db, acct, c.view, 'NVDA')).filter((x) => x.kind === 'NEW_RISK')).toEqual([]);
      // 設計的例句
      expect(riskLine('MU', { label: '審查', text: 'NAND 現貨價兩週跌 20%。' })).toBe('MU 的審查提到一件你的前提沒有涵蓋的事：NAND 現貨價兩週跌 20%。要不要加一條前提由你決定');
      expect(riskLine('MU', { label: '減半檢視', text: 'NAND 現貨價兩週跌 20%' })).toContain('MU 的減半檢視提到一件');

      // 持股頁的 API：要看的事沒有它；審查那一塊與編輯論點頁要的那幾件（引用與出處）
      const hd = (await c.call<HoldingBody>('GET', '/api/holding/NVDA')).body;
      expect(hd.attention.filter((x) => x.kind === 'NEW_RISK')).toEqual([]);
      expect(hd.thesis.risks).toEqual([{ runId: run.runId, k: 0, date: AS_OF, label: '審查', text: RISK_NAND, quote: Q_TF1, source: tf.title, sourceDate: tf.date, url: TF(1), headline: false }]);

      // 月報：也不列（T71）
      const m1 = await monthOwnAttention(c.db, acct, c.view);
      expect(m1.items.filter((x) => x.kind === 'NEW_RISK')).toEqual([]);
      expect(m1.acct.own.NVDA.attnShown ?? {}).not.toHaveProperty(`NEW_RISK@${run.runId}#0`);

      // 紀錄頁
      const rv = risksView(run)!;
      expect(rv.state).toBe('LISTED');
      expect(rv.line).toBe('新眼光列了 4 件前提以外的風險，2 件通過程式檢查，2 件被拿掉。通過的列在持股頁的審查那一塊，下一次 stock bot 草擬論點時會一起看。只當建議：不影響三票的結論、不影響檔位、不發通知。');
      expect(rv.items.map((x) => [x.kept, x.note])).toEqual([[true, null], [false, '和現有的前提 P2 的字重疊高（已經有人看了）'], [true, null], [false, '超過 3 條，只看前 3 條']]);
      const api = (await c.call<{ risks: typeof rv }>('GET', `/api/ai/run/${run.runId}`)).body.risks;
      expect(api).toEqual(rv);
    });
  });

  it('只當建議：同一組票，有沒有 new_risks，結論、檔位、建議、通知與 LINE 都一樣；套用審查不會因為它多出通知', async () => {
    const flow = async (withRisks: boolean) => {
      let out: unknown = null;
      await withWorld(async (c) => {
        const { run } = await runWithRisks(c, (d) => (withRisks ? [{ text: RISK_NAND, source_id: d.source_id, date: d.date, quote: Q_TF1 }] : []));
        const before = await acctOf(c.db);
        const ctx: ApplyCtx = { db: c.db, acct: before, view: c.view, axis: c.axis, session: AS_OF, now: new Date('2026-11-20T01:20:00Z'), stmts: [], log: [] };
        await applyOwnReview(ctx, run);
        const o = run.outcome!;
        const d = reviewDecision(o, before, 'NVDA', run.asOf, run.pack);
        out = {
          kept: (run.newRisks?.items ?? []).filter((x) => x.ok).length,
          outcome: { status: o.status, verdict: o.verdict, votes: o.votes, actionable: o.actionable, followRule: o.followRule, reason: o.reason, premises: o.samples.map((s) => s.premises) },
          decision: { tier: d.tier, suggest: d.suggest, consensus: d.consensus, proposed: d.proposed, brokenPremises: d.brokenPremises },
          aiTier: { ...ctx.acct.own.NVDA.aiTier, runId: null },
          notifs: ctx.acct.notifs.length,
          newNotifs: ctx.acct.notifs.length - before.notifs.length,
          line: c.line.length,
          stmts: ctx.stmts.length,
        };
      });
      return out as { kept: number; newNotifs: number };
    };
    const a = await flow(true);
    const b = await flow(false);
    expect(a.kept).toBe(1);
    expect(b.kept).toBe(0);
    expect({ ...a, kept: 0 }).toEqual(b);
    expect(a.newNotifs).toBe(0);
    // 純函式也一樣：judge 不讀 new_risks
    const pack = unitPack();
    const v = { run_id: pack.run_id, verdict: 'HOLD', premise_checks: [], evidence: [], payload: { tier: 'HOLD' }, report: 'r' };
    expect(judge(pack, [v, v, v], PAYLOAD_HOOKS[OWN_REVIEW]).status).toBe('INSUFFICIENT');
    expect(OWN_ATTN.map((k) => k.kind)).not.toContain('NEW_RISK'); // T71：不列「要看的事」
  });

  it('編輯論點頁：帶進右欄存檔 → 預覽寫帶進來幾條；存檔後記成已帶進論點（帳戶與論點檔的 log），那一件不再列', async () => {
    await withWorld(async (c) => {
      const { run } = await runWithRisks(c, (d) => [{ text: RISK_NAND, source_id: d.source_id, date: d.date, quote: Q_TF1 }, { text: '庫存天數升高，報價可能再跌', source_id: d.source_id, date: d.date, quote: 'Paragraph 2 of TF1: NAND spot prices have fallen' }]);
      const body = (dry: boolean) => ({
        ticker: 'NVDA',
        thesis: THESIS_TEXT,
        premises: [
          ...PREMISES.map((p) => ({ id: p.id, text: p.text, breaksIf: p.breaksIf ?? [], confirmsIf: p.confirmsIf ?? '', verify: p.verify ?? null })),
          // 帶進右欄之後改寫成「要繼續成立的事」；帶著是哪一次執行的第幾條
          { id: null, text: 'NAND 的報價在兩季內止跌', breaksIf: ['NAND 合約價連兩季下跌'], risk: { runId: run.runId, k: 0 } },
        ],
        exitConditions: [{ text: COND_TEXT, action: 'HALF' }],
        source: 'TYPED',
        dry,
      });
      const pre = await c.call<{ preview: { risks: { runId: string; k: number; text: string }[]; added: { id: string }[] } }>('POST', '/api/ops/own-thesis', body(true));
      expect(pre.status).toBe(200);
      expect(pre.body.preview.risks).toEqual([{ runId: run.runId, k: 0, text: RISK_NAND }]);
      expect(pre.body.preview.added).toHaveLength(1);
      // 預覽不會存
      expect((await acctOf(c.db)).own.NVDA.riskSeen).toBeUndefined();

      const saved = await c.call<{ preview: { risks: unknown[] } }>('POST', '/api/ops/own-thesis', body(false));
      expect(saved.status).toBe(200);
      const acct = await acctOf(c.db);
      expect(acct.own.NVDA.riskSeen).toEqual([{ text: RISK_NAND, at: AS_OF, runId: run.runId, k: 0, outcome: 'ADOPTED' }]);
      expect(acct.own.NVDA.premises.map((p) => p.text)).toContain('NAND 的報價在兩季內止跌');
      // 帶進來的是你寫的前提（不是 AI 草擬的）
      expect(acct.own.NVDA.premises.find((p) => p.text === 'NAND 的報價在兩季內止跌')!.origin).toBe('USER');
      const log = (await c.db.prepare("SELECT body FROM own_thesis_log WHERE kind = 'RISK_SEEN'").all<{ body: string }>()).results.map((r) => JSON.parse(r.body) as Record<string, unknown>);
      expect(log).toEqual([expect.objectContaining({ runId: run.runId, k: 0, text: RISK_NAND, outcome: 'ADOPTED' })]);
      // 那一件不再列；另一件（沒處理的）還在
      const hd = (await c.call<HoldingBody>('GET', '/api/holding/NVDA')).body;
      expect(hd.thesis.risks.map((r) => r.k)).toEqual([1]);
      expect(hd.attention.filter((x) => x.kind === 'NEW_RISK')).toEqual([]); // T71：不列「要看的事」
      // 不存在的那一件（編號亂寫）不會被記下
      const none = await c.call<{ preview: { risks: unknown[] } }>('POST', '/api/ops/own-thesis', { ...body(true), premises: [{ id: 'P1', text: PREMISES[0].text, risk: { runId: 'nope', k: 9 } }] });
      expect(none.body.preview.risks).toEqual([]);
    });
  });

  // T71（confirm_audit_design §4）：「看過了，不加」拿掉（dismiss 一律 null）；不再寫「要看的事」
  it('前端的文字（thesis-risks.js）：依據那一行、按鈕與帶進去之後的狀態、存檔前的那一句', () => {
    expect(RJ.RISK_DAYS).toBe(RISK_SEEN_DAYS);
    expect(RJ.RISK_TITLE).toBe('審查提到、你的前提沒有涵蓋的事');
    expect(RJ.riskMeta({ date: '2026-11-20', label: '審查', source: '〔網頁｜媒體｜CNBC〕NAND prices slide', headline: false })).toBe('11/20 的審查提的；依據：〔網頁｜媒體｜CNBC〕NAND prices slide');
    expect(RJ.riskMeta({ date: '2026-11-20', label: '減半檢視', source: 'MU 最近的新聞標題（Yahoo，只有標題）', headline: true })).toBe('11/20 的減半檢視提的；依據：MU 最近的新聞標題（Yahoo，只有標題）（只有新聞標題，沒有讀到全文：當成線索）');
    expect(RJ.riskButtons(false)).toEqual({ take: '帶進右欄', note: null, dismiss: null });
    expect(RJ.riskButtons(true)).toMatchObject({ take: null, dismiss: null });
    expect(RJ.riskButtons(true).note).toContain('已經帶進「新的」');
    expect(RJ.RISK_ROW_HINT).toContain('請改寫成「要繼續成立的事」');
    expect(RJ.riskDismissed()).toBe('記下了：這件事 180 天內不再列在「要看的事」。');
    expect(RJ.riskPreviewLine([])).toBeNull();
    expect(RJ.riskPreviewLine(null)).toBeNull();
    expect(RJ.riskPreviewLine([{}, {}])).toBe('從審查提到的風險帶進來 2 條：存檔後這 2 件不再另外列在持股頁與這裡（180 天內同一件事也不再列）。');
    // 畫面的文字不出現內部代號
    expect([RJ.RISK_TITLE, RJ.RISK_ROW_HINT, RJ.riskDismissed(), RJ.riskPreviewLine([{}])].join('')).not.toMatch(/NEW_RISK|new_risks|fresh|OVERLAP|DISMISSED|ADOPTED/);
  });
});

// ---------------------------------------------------------------- 7 頻率

describe('T63：頻率由程式決定（減半檢視每次都跑；定期審查每檔每 90 個日曆天最多一次）', () => {
  it('freshPlan：減半檢視每次都跑；定期審查看上一次跑的日子；只有預設前提的不跑；不能取文件時照樣跑、只是不能指定文件', () => {
    expect(FRESH_REVIEW_GAP_DAYS).toBe(90);
    expect(freshPlan(OWN_DROP, AS_OF, { defaultOnly: false, canFetch: true })).toEqual({ run: true, why: '減半檢視每次都跑新眼光', max_risks: 3, docs: 1 });
    expect(freshPlan(OWN_DROP, AS_OF, { defaultOnly: false, lastFresh: AS_OF, canFetch: false })).toMatchObject({ run: true, docs: 0 });
    expect(freshPlan(OWN_REVIEW, AS_OF, { defaultOnly: false, lastFresh: null, canFetch: true })).toMatchObject({ run: true, docs: 1 });
    // 89 天：不跑；90 天：跑
    expect(freshPlan(OWN_REVIEW, '2027-02-16', { defaultOnly: false, lastFresh: AS_OF, canFetch: true })).toEqual({ run: false, why: `這檔 ${AS_OF} 的定期審查跑過新眼光，未滿 90 天（定期審查每檔每 90 個日曆天最多一次）`, max_risks: 3, docs: 0 });
    expect(freshPlan(OWN_REVIEW, '2027-02-17', { defaultOnly: false, lastFresh: AS_OF, canFetch: true })).toEqual({ run: true, why: `這檔上次跑新眼光的定期審查是 ${AS_OF}，已滿 90 天`, max_risks: 3, docs: 1 });
    for (const fn of [OWN_REVIEW, OWN_DROP]) expect(freshPlan(fn, AS_OF, { defaultOnly: true, canFetch: false }).run).toBe(false);
    expect(freshPlan('OWN_CONDITION', AS_OF, { defaultOnly: false, canFetch: true }).run).toBe(false);
  });

  it('定期審查：第一次跑；29 天後不跑（證據包寫原因）、送回 new_risks 也不看；逾時的那一次不算；結果回來的那一次起算 90 天', async () => {
    await withWorld(async (c) => {
      // 第一次：跑（還在等結果也算，免得隔天又跑一次）
      const r1 = await review(c);
      expect(r1.pack.fresh_eyes?.run).toBe(true);
      expect(r1.docCtx?.fresh).toEqual({ docs: 1, chars: 6000, calls: 1 });
      expect(await lastFreshReview(c.db, 'NVDA', '2026-12-18')).toBe(AS_OF);
      const r2 = await review(c, '2026-12-18', new Date('2026-12-19T01:00:00Z'));
      expect(r2.pack.fresh_eyes).toEqual({ run: false, why: `這檔 ${AS_OF} 的定期審查跑過新眼光，未滿 90 天（定期審查每檔每 90 個日曆天最多一次）`, max_risks: 3, docs: 0 });
      expect(r2.docCtx?.fresh).toBeUndefined();
      // 沒有請它跑：/fresh 回 403、角色寫新眼光的取文件回 403、送回 new_risks 也不看
      await c.call('GET', `/ai/task/${r2.taskId}/evidence`, undefined, '2026-12-19T01:05:00Z');
      expect((await c.call('GET', `/ai/task/${r2.taskId}/fresh`, undefined, '2026-12-19T01:06:00Z')).status).toBe(403);
      expect((await c.call('POST', `/ai/task/${r2.taskId}/docs`, { role: '新眼光', want: [{ menu: 'M1' }] }, '2026-12-19T01:06:00Z')).status).toBe(403);
      const filing = r2.pack.documents.find((d) => d.kind === 'filing')!;
      expect((await sendResult(c, r2, { new_risks: [{ text: '營收成長可能放慢', source_id: filing.source_id, date: filing.date, quote: Q_REV }] }, '2026-12-19T01:10:00Z')).status).toBe(200);
      const done2 = (await getRun(c.db, r2.runId))!;
      expect(done2.outcome!.status).toBe('INSUFFICIENT');
      expect(done2.newRisks).toBeNull();
      expect(risksView(done2)).toMatchObject({ state: 'OFF', items: [] });
      expect((await holdingAttention(c.db, await acctOf(c.db), { ...c.view, date: '2026-12-18' }, 'NVDA')).some((x) => x.kind === 'NEW_RISK')).toBe(false);

      // 第一次逾時了（沒有結果）：不算，下一次審查再跑
      await closeStaleRuns(c.db, new Date('2026-12-19T02:00:00Z'));
      expect((await getRun(c.db, r1.runId))!.outcome!.status).toBe('TIMEOUT');
      expect(risksView((await getRun(c.db, r1.runId))!)).toMatchObject({ state: 'NONE' });
      expect(await lastFreshReview(c.db, 'NVDA', '2026-12-21')).toBeNull();
      const r3 = await review(c, '2026-12-21', new Date('2026-12-22T01:00:00Z'));
      expect(r3.pack.fresh_eyes?.run).toBe(true);
      // 這一次結果回來了（新眼光交了空的清單）：從這一天起算 90 天
      await c.call('GET', `/ai/task/${r3.taskId}/evidence`, undefined, '2026-12-22T01:05:00Z');
      expect((await sendResult(c, r3, { new_risks: [] }, '2026-12-22T01:10:00Z')).status).toBe(200);
      expect((await getRun(c.db, r3.runId))!.newRisks).toEqual({ asked: true, returned: true, items: [] });
      expect(risksView((await getRun(c.db, r3.runId))!)!.line).toBe('新眼光沒有列出前提以外的風險。只當建議：不影響三票的結論、不影響檔位、不發通知。');
      expect((await review(c, '2027-03-20', new Date('2027-03-21T01:00:00Z'))).pack.fresh_eyes?.run).toBe(false); // 89 天
      const r5 = await review(c, '2027-03-21', new Date('2027-03-22T01:00:00Z')); // 90 天
      expect(r5.pack.fresh_eyes).toMatchObject({ run: true, why: '這檔上次跑新眼光的定期審查是 2026-12-21，已滿 90 天' });
    });
  });

  it('只有系統預設前提的股票：定期審查不跑新眼光', async () => {
    await withWorld(
      async (c) => {
        const r = await review(c);
        expect(r.pack.fresh_eyes).toMatchObject({ run: false, why: '這檔還沒有使用者的論點（只有系統預設前提），不跑新眼光' });
        expect(await lastFreshReview(c.db, 'NVDA', AS_OF)).toBeNull();
      },
      { defaults: true },
    );
  });
});

// ---------------------------------------------------------------- 8 看過不採用的 180 天內不再列

const prem = (id: string, text: string, o: Partial<ThesisPremise> = {}): ThesisPremise => ({ id, text, origin: 'USER', addedAt: '2026-01-02', lastCheck: null, splitAfter: false, ...o });
const item = (k: number, text: string): NewRiskItem => ({ k, text, source_id: 'edgar:q3', date: '2026-10-30', quote: Q_NAND, ok: true, doc: { title: TENQ_DOC.title, date: '2026-10-30', url: null, headline: false } });
const rev = (runId: string, date: string, o: Partial<ThesisReview> = {}): ThesisReview => ({ runId, date, fn: 'OWN_REVIEW', label: '定期審查', trigger: 'MONTHLY', status: 'AGREED', verdict: 'HOLD', votes: { HOLD: 3 }, brokenPremises: [], notif: null, response: null, premiseVotes: {}, summary: null, ...o });
const fileOf = (o: Partial<ThesisFile> = {}): Pick<ThesisFile, 'reviews' | 'premises'> => ({ premises: [prem('P4', 'DRAM 合約價維持季漲')], reviews: [], ...o });
const seen = (text: string, at: string, outcome: RiskSeen['outcome'] = 'DISMISSED', runId = 'r1', k = 0): RiskSeen => ({ text, at, runId, k, outcome });
const keys = (xs: { runId: string; k: number }[]) => xs.map((x) => `${x.runId}#${x.k}`);

describe('T63：使用者看過不採用的，同一件事 180 天內不再列', () => {
  it('openRisks：看過不採用的不列；同一件事（字很像）之後的審查再提也不列；處理那天起滿 180 天之後才再列', () => {
    expect(RISK_SEEN_DAYS).toBe(180);
    const f1 = fileOf({ reviews: [rev('r1', '2026-11-20', { newRisks: [item(0, RISK_NAND), item(1, '庫存天數升到 150 天')] })] });
    expect(keys(openRisks(f1, {}, '2026-11-21'))).toEqual(['r1#0', 'r1#1']);
    const meta: Pick<OwnMeta, 'riskSeen'> = { riskSeen: [seen(RISK_NAND, '2026-11-21')] };
    expect(keys(openRisks(f1, meta, '2026-11-22'))).toEqual(['r1#1']);
    // 90 天後的審查又提同一件（字不完全一樣）：還在 180 天內，不列
    expect(sameRisk({ runId: 'r1', k: 0, text: RISK_NAND }, { runId: 'r2', k: 2, text: RISK_NAND_AGAIN })).toBe(true);
    const f2 = fileOf({ reviews: [rev('r2', '2027-02-20', { newRisks: [item(2, RISK_NAND_AGAIN), item(0, '客戶集中度升高')] }), ...f1.reviews] });
    expect(keys(openRisks(f2, meta, '2027-02-21'))).toEqual(['r2#0']);
    // 2026-11-21 + 179 天 = 2027-05-19：還不列；+180 天 = 2027-05-20：再提才列
    const f3 = fileOf({ reviews: [rev('r3', '2027-05-19', { newRisks: [item(0, RISK_NAND_AGAIN)] })] });
    expect(keys(openRisks(f3, meta, '2027-05-19'))).toEqual([]);
    expect(keys(openRisks(f3, meta, '2027-05-20'))).toEqual(['r3#0']);
    // 帶進論點的也一樣不再列
    expect(keys(openRisks(f1, { riskSeen: [seen(RISK_NAND, '2026-11-21', 'ADOPTED')] }, '2026-11-22'))).toEqual(['r1#1']);
  });

  it('openRisks：之後的新眼光有列東西就換成新的；沒列東西時舊的留著；滿 180 天不再列；還在跑的、別種功能的不算', () => {
    const old = rev('r1', '2026-11-20', { newRisks: [item(0, RISK_NAND)] });
    // 之後的審查沒有新眼光（或新眼光沒列東西）：舊的留著
    expect(keys(openRisks(fileOf({ reviews: [rev('r2', '2026-12-30'), old] }), {}, '2026-12-31'))).toEqual(['r1#0']);
    // 之後的減半檢視有列東西：換成新的
    const drop = rev('d1', '2027-01-10', { fn: 'OWN_DROP', label: '減半檢視', newRisks: [item(0, '客戶集中度升高')] });
    const got = openRisks(fileOf({ reviews: [drop, old] }), {}, '2027-01-11');
    expect(got.map((x) => [x.runId, x.label, x.text])).toEqual([['d1', '減半檢視', '客戶集中度升高']]);
    // 還在跑的不算；硬事件法庭之類的不算
    expect(keys(openRisks(fileOf({ reviews: [rev('p', '2027-01-12', { status: 'PENDING', newRisks: [item(0, 'x 還在跑')] }), rev('h', '2027-01-12', { fn: 'HARD_EVENT', newRisks: [item(0, 'y 不是審查')] }), old] }), {}, '2027-01-13'))).toEqual(['r1#0']);
    // 那次執行滿 180 天就不再列
    expect(keys(openRisks(fileOf({ reviews: [old] }), {}, '2027-05-18'))).toEqual(['r1#0']);
    expect(keys(openRisks(fileOf({ reviews: [old] }), {}, '2027-05-19'))).toEqual([]);
  });

  it('openRisks：之後才加的前提（含信念）和它重疊，就不再列（已經有人看了）', () => {
    const reviews = [rev('r1', '2026-11-20', { newRisks: [item(0, 'NAND 的報價持續下跌')] })];
    expect(keys(openRisks(fileOf({ reviews }), {}, '2026-11-21'))).toEqual(['r1#0']);
    expect(keys(openRisks(fileOf({ reviews, premises: [prem('P4', 'DRAM 合約價維持季漲'), prem('P6', 'NAND 的報價沒有持續下跌')] }), {}, '2026-11-21'))).toEqual([]);
    expect(keys(openRisks(fileOf({ reviews, premises: [prem('P7', '記憶體景氣還在上行', { breaksIf: ['NAND 的報價持續下跌兩季'] })] }), {}, '2026-11-21'))).toEqual([]);
    expect(keys(openRisks(fileOf({ reviews, premises: [prem('P8', 'NAND 的報價不會持續下跌', { verify: { by: 'NONE' } })] }), {}, '2026-11-21'))).toEqual([]);
  });

  it('withRiskSeen：超過 180 天的順手拿掉；同一條只留最新的一筆', () => {
    const a = seen('甲', '2026-01-01', 'DISMISSED', 'r0', 0);
    const b = seen('乙', '2026-10-01', 'DISMISSED', 'r1', 0);
    expect(withRiskSeen([a, b], [seen('丙', '2026-11-20', 'ADOPTED', 'r2', 1)], '2026-11-20').map((x) => x.text)).toEqual(['乙', '丙']);
    expect(withRiskSeen([b], [seen('乙', '2026-11-20', 'ADOPTED', 'r1', 0)], '2026-11-20')).toEqual([seen('乙', '2026-11-20', 'ADOPTED', 'r1', 0)]);
    expect(ownAttention([{ ticker: 'MU', ...fileOf({ reviews: [rev('r1', '2026-11-20', { newRisks: [item(0, RISK_NAND)] })] }) } as ThesisFile], { own: { MU: { riskSeen: [seen(RISK_NAND, '2026-11-21')] } as OwnMeta }, rule: { own: {} }, notifs: [] } as never, { date: '2026-11-22' }, OWN_ATTN.filter((k) => k.kind === 'NEW_RISK'))).toEqual([]);
  });

  it('整條流程：按「看過了，不加」→ 記進帳戶與論點檔的 log、不再列、再按一次 409；之後的審查再提同一件事也不列；不動論點、不發通知', async () => {
    await withWorld(async (c) => {
      const { run } = await runWithRisks(c, (d) => [{ text: RISK_NAND, source_id: d.source_id, date: d.date, quote: Q_TF1 }]);
      const before = await acctOf(c.db);
      expect((await c.call('POST', '/api/ops/own-risk', { ticker: 'NVDA', runId: run.runId, k: 5 })).status).toBe(409);
      expect((await c.call('POST', '/api/ops/own-risk', { ticker: 'NVDA' })).status).toBe(422);
      const res = await c.call<{ ok: boolean; days: number }>('POST', '/api/ops/own-risk', { ticker: 'NVDA', runId: run.runId, k: 0 });
      expect(res).toMatchObject({ status: 200, body: { ok: true, days: 180 } });
      const acct = await acctOf(c.db);
      expect(acct.own.NVDA.riskSeen).toEqual([{ text: RISK_NAND, at: AS_OF, runId: run.runId, k: 0, outcome: 'DISMISSED' }]);
      // 不動論點、不動檔位、不發通知
      expect(acct.own.NVDA.premises).toEqual(before.own.NVDA.premises);
      expect(acct.own.NVDA.thesis).toEqual(before.own.NVDA.thesis);
      expect(acct.own.NVDA.aiTier).toEqual(before.own.NVDA.aiTier);
      expect(acct.notifs.length).toBe(before.notifs.length);
      expect(c.line).toEqual([]);
      const log = (await c.db.prepare("SELECT file_id, body FROM own_thesis_log WHERE kind = 'RISK_SEEN'").all<{ file_id: string; body: string }>()).results;
      expect(log.map((r) => [r.file_id, (JSON.parse(r.body) as { outcome: string }).outcome])).toEqual([[FILE, 'DISMISSED']]);
      const hd = (await c.call<HoldingBody>('GET', '/api/holding/NVDA')).body;
      expect(hd.thesis.risks).toEqual([]);
      expect(hd.attention.some((x) => x.kind === 'NEW_RISK')).toBe(false);
      // 已經處理過：再按一次 409
      expect((await c.call('POST', '/api/ops/own-risk', { ticker: 'NVDA', runId: run.runId, k: 0 })).status).toBe(409);

      // 100 天後的審查（滿 90 天，新眼光再跑）又提同一件事：還在 180 天內，不列
      const later = '2027-02-27';
      const r2 = await review(c, later, new Date('2027-02-28T01:00:00Z'));
      expect(r2.pack.fresh_eyes?.run).toBe(true);
      await c.call('GET', `/ai/task/${r2.taskId}/evidence`, undefined, '2027-02-28T01:05:00Z');
      const filing = r2.pack.documents.find((d) => d.kind === 'filing')!;
      await sendResult(c, r2, { new_risks: [{ text: RISK_NAND_AGAIN, source_id: filing.source_id, date: filing.date, quote: Q_REV }] }, '2027-02-28T01:10:00Z');
      expect((await getRun(c.db, r2.runId))!.newRisks!.items.map(brief)).toEqual([[0, true, null]]);
      const file = (await thesisFile(c.db, acct, 'NVDA', later))!;
      expect(openRisks(file, acct.own.NVDA, later)).toEqual([]);
      // 180 天過了之後才列（2026-11-19 + 180 天 = 2027-05-18）
      expect(keys(openRisks(file, acct.own.NVDA, '2027-05-17'))).toEqual([]);
      expect(keys(openRisks(file, acct.own.NVDA, '2027-05-18'))).toEqual([`${r2.runId}#0`]);
    });
  });
});

// ---------------------------------------------------------------- 9 分析師替它留的額度

describe('T63：取文件的額度替新眼光留 1 份（8 份裡的 1 份；另外留 1 次呼叫與 6,000 字）', () => {
  it('有新眼光的執行：分析師最多 7 份，第 8 份回 LIMIT；新眼光只能指定目錄裡的 1 份、不能給網址；它取回的文件和別的一樣進證據包', async () => {
    await withWorld(async (c) => {
      const r = await review(c);
      await c.call('GET', `/ai/task/${r.taskId}/evidence`);
      const docs = (want: unknown[], role = '分析師') => c.call<DocsBody>('POST', `/ai/task/${r.taskId}/docs`, { role, want });
      // 分析師：同一個網站最多 4 篇，所以 TrendForce 4 篇＋SK 海力士 4 篇 = 8 篇，第 8 篇被留給新眼光的那一份擋下
      const a1 = await docs([1, 2, 3, 4].map((n) => ({ url: TF(n), for: 'P2', why: '相反：現貨價' })));
      expect(a1.body.docs).toHaveLength(4);
      expect(a1.body.left).toMatchObject({ docs: 3, calls: 4 });
      const a2 = await docs([1, 2, 3, 4].map((n) => ({ url: SK(n), for: 'P2', why: '支持：同業' })));
      expect(a2.body.docs).toHaveLength(3);
      expect(a2.body.refused).toEqual([{ url: SK(4), reason: 'LIMIT', detail: '每次執行最多取回 8 份（其中 1 份留給新眼光）' }]);
      expect(a2.body.left.docs).toBe(0);

      // 新眼光：不能給網址；目錄裡的一份可以；第二份回 LIMIT
      const f0 = await docs([{ url: SK(4), why: '想讀這一篇' }], FRESH_ROLE);
      expect(f0.body.docs).toEqual([]);
      expect(f0.body.refused).toEqual([{ url: SK(4), reason: 'ERROR', detail: '新眼光只能指定目錄（M 開頭）裡的文件，不能給網址' }]);
      expect(f0.body.left.docs).toBe(1);
      const f1 = await docs([{ menu: 'M1', why: '同業的財報新聞稿' }], FRESH_ROLE);
      expect(f1.status).toBe(200);
      expect(f1.body.docs).toHaveLength(1);
      expect(f1.body.docs[0].text).toContain('Micron reported record HBM revenue');
      expect(f1.body.left.docs).toBe(0);
      const f2 = await docs([{ menu: 'M2', why: '再一份' }], FRESH_ROLE);
      // M2 就是分析師已經取過的 TF(1)：原樣再給一次，不算份數
      expect(f2.body.docs).toHaveLength(1);
      expect(f2.body.refused).toEqual([]);

      const stored = (await getRun(c.db, r.runId))!;
      expect(stored.added!.docs).toHaveLength(8);
      expect(stored.added!.docs.filter((d) => d.role === FRESH_ROLE).map((d) => d.menu)).toEqual(['M1']);
      expect(stored.added!.freshCalls).toBe(3);
      // 新眼光引用它自己取回的那一份：照樣逐字檢查
      const mu = f1.body.docs[0];
      await sendResult(c, r, { new_risks: [{ text: '同業 Micron 打算擴產 HBM，供給可能轉鬆', source_id: mu.source_id, date: mu.date, quote: 'plans to expand HBM capacity' }, { text: '同業說 HBM 需求轉弱', source_id: mu.source_id, date: mu.date, quote: 'Micron said HBM demand is weakening' }] });
      const done = (await getRun(c.db, r.runId))!;
      expect(done.newRisks!.items.map(brief)).toEqual([[0, true, null], [1, false, 'QUOTE']]);
      expect(done.newRisks!.items[0].doc!.title).toContain('〔同業申報｜Micron〕');
      // 紀錄頁「AI 這次另外找了什麼」：新眼光指定的那一份另外標出來
      expect(foundView(done)!.docs.map((d) => d.via)).toEqual([...Array.from({ length: 7 }, () => '分析師搜尋到的'), '新眼光從目錄指定的']);
    });
  });

  it('新眼光指定的那一份還沒用掉時，分析師的字數上限是 54,000、呼叫上限是 5 次；用掉之後不再留', async () => {
    await withWorld(async (c) => {
      const r = await review(c);
      await c.call('GET', `/ai/task/${r.taskId}/evidence`);
      const docs = (want: unknown[], role = '分析師') => c.call<DocsBody>('POST', `/ai/task/${r.taskId}/docs`, { role, want });
      // 每篇給 12,000 字：4 篇 48,000 字，第 5 篇只剩 6,000 字（留了 6,000 字給新眼光），第 6 篇回 LIMIT
      const a1 = await docs([1, 2, 3, 4].map((n) => ({ url: BIG(n), for: 'P2', why: '相反' })));
      expect(a1.body.docs.map((d) => d.text.length)).toEqual([WEB_GIVE, WEB_GIVE, WEB_GIVE, WEB_GIVE]);
      expect(a1.body.left.chars).toBe(DOCS_MAX_CHARS - FRESH_RESERVE.chars - 4 * WEB_GIVE);
      const a2 = await docs([{ url: BIGSK(1), for: 'P2', why: '支持' }, { url: BIGSK(2), for: 'P2', why: '支持' }]);
      expect(a2.body.docs.map((d) => d.text.length)).toEqual([6000]);
      expect(a2.body.refused).toEqual([{ url: BIGSK(2), reason: 'LIMIT', detail: '每次執行合計最多 60,000 字（其中 6,000 字留給新眼光），已經用完' }]);
      expect(a2.body.left).toMatchObject({ chars: 0, calls: 3 });
      // 呼叫：分析師第 3、4、5 次可以，第 6 次留給新眼光
      for (const left of [2, 1, 0]) expect((await docs([])).body.left.calls).toBe(left);
      const a6 = await docs([{ url: TF(1), for: 'P2', why: '相反' }]);
      expect(a6.body.refused).toEqual([{ url: TF(1), reason: 'LIMIT', detail: '每次執行最多呼叫 6 次（其中 1 次留給新眼光）' }]);
    });
    await withWorld(async (c) => {
      const r = await review(c);
      await c.call('GET', `/ai/task/${r.taskId}/evidence`);
      const docs = (want: unknown[], role = '分析師') => c.call<DocsBody>('POST', `/ai/task/${r.taskId}/docs`, { role, want });
      // 新眼光先用掉它那一份：之後分析師看到的上限不再扣（8 份裡還有 7 份、字數與呼叫照原本的算）
      const f = await docs([{ menu: 'M1' }], FRESH_ROLE);
      expect(f.body.docs).toHaveLength(1);
      const used = f.body.docs[0].text.length;
      const a = await docs([{ url: TF(1), for: 'P2', why: '相反' }]);
      expect(a.body.left).toEqual({ docs: DOCS_MAX - 2, chars: DOCS_MAX_CHARS - used - a.body.docs[0].text.length, calls: DOCS_MAX_CALLS - 2 });
    });
  });

  it('沒有新眼光的執行照舊：分析師可以取滿 8 份；doc_ctx 沒有 fresh', async () => {
    const pack = ownDropPack({ acct: { own: { NVDA: { premises: PREMISES } }, rule: { own: {} }, lots: { own: {}, mom: {}, core: {}, unc: {} }, cash: 0 } as never, view: { date: AS_OF, i: 0, close: {} } as never, axis: [AS_OF], ticker: 'NVDA', runId: 'x', attr: null, base: null, baseRunId: null, docs: [], urgent: true, dataQuality: {}, now: T0 }).pack;
    // 呼叫的地方沒給 freshEyes：證據包沒有這個欄位（＝不跑）
    expect(pack).not.toHaveProperty('fresh_eyes');
    await withWorld(async (c) => {
      // 第二次審查（未滿 90 天）沒有新眼光
      await review(c);
      const r = await review(c, '2026-11-25', new Date('2026-11-26T01:00:00Z'));
      expect(r.pack.fresh_eyes?.run).toBe(false);
      await c.call('GET', `/ai/task/${r.taskId}/evidence`, undefined, '2026-11-26T01:05:00Z');
      const docs = (want: unknown[]) => c.call<DocsBody>('POST', `/ai/task/${r.taskId}/docs`, { role: '分析師', want }, '2026-11-26T01:06:00Z');
      expect((await docs([1, 2, 3, 4].map((n) => ({ url: TF(n), for: 'P2', why: '相反' })))).body.left.docs).toBe(4);
      const a2 = await docs([1, 2, 3, 4].map((n) => ({ url: SK(n), for: 'P2', why: '支持' })));
      expect(a2.body.docs).toHaveLength(4);
      expect(a2.body.refused).toEqual([]);
      expect(a2.body.left.docs).toBe(0);
    });
  });
});
