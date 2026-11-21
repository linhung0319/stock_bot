// T70：草稿一鍵採用（confirm_audit_design §2）。
// 完成條件：
//   採用後論點、前提（含 confirmsIf／verify／breaksIf／信念）、出場條件、同業都存進去
//   出場條件直接是 ACTIVE／REVIEW_ONLY／MANUAL，沒有等改寫確認的列；草稿標 USED、DraftUse 正確
//   keep_id 沿用的前提編號不變；被判不成立之後的草稿採用算一次失效後修改、keep_id 不能是被判不成立的那條
//   同業 EDGAR 對不到的不存並回原因；採用後再親手改出場條件的字仍走改寫
//   舊格式（有 domains、v2 的 EVENT 沒有 confirm_by）的草稿採用不會壞：那幾條改走改寫確認
//   運作統計依前提來源（原樣採用／你寫的）分開的數字
// check.ts 沒有動；AI 的回覆一律是假的；對外請求全部是假的（EDGAR、RSS、雲端排程）。
import { describe, expect, it } from 'vitest';
import type { PackDoc } from '../src/ai/check';
import { OWN_DRAFT, ownDraftPack } from '../src/ai/ownDraft';
import { getRun } from '../src/app/aiRuns';
import type { Env, Fetcher } from '../src/app/env';
import { runFlow } from '../src/app/flow';
import { loadAccount, saveAccount } from '../src/app/ledgerStore';
import { adoptOwnedCount, adoptPeers, draftAdoptPlan, draftLineText, loadDrafts, type DraftUse } from '../src/app/ownDraft';
import type { CompanyFacts, XbrlFact } from '../src/data/edgar';
import { buildMarketView } from '../src/data/marketView';
import { loadSeries } from '../src/data/store';
import { SYSTEM_DEFAULT_PREMISES, createAccount, routeReview, type Account, type MarketView, type Premise } from '../src/engine';
import type { OpsReport, Row } from '../src/app/opsReport';
import { handle } from '../src/index';
import { freshDb } from './helpers/d1';
import { cronTime, fakeFetcher, newWorld, type World } from './helpers/fakeSources';

// 前端的 thesis-draft.js 不碰 DOM，直接 import（瀏覽器直接載入的 JS 沒有型別宣告）
type Line = { tone: string; text: string };
interface DraftJs {
  ADOPT_HINT: string;
  adoptedNote(at: string): string;
  adoptCompare(pv: unknown): { h: string; rows: Line[] }[];
  adoptResultLines(r: unknown, at: string): Line[];
  draftItems(p: unknown): { premises: Record<string, unknown>[]; exits: Record<string, unknown>[]; peers: Record<string, unknown>[]; domains: Record<string, unknown>[] };
  draftNotices(d: unknown): Line[];
  exitMonitorText(x: unknown): Line;
}
const DJ = (await import('../public/js/thesis-draft.js' as string)) as DraftJs;

// ---------------------------------------------------------------- 原文與一份會通過檢查的草稿（own_draft_v3 的格式）

const Q_REV = 'Revenue for the third quarter was $160 million, up 33% from a year ago';
const Q_GM = 'Gross margin was 60.0%, down from 70.0% a year ago';
const RISK1 = 'Our three largest customers accounted for 61% of revenue';
const RISK2 = 'Export restrictions may limit our ability to sell to certain customers';
const RISK3 = 'Inventory provisions increased to $1.2 billion this quarter';
const TENQ_TEXT = `${Q_REV}. ${Q_GM}. ${RISK1}. ${RISK2}. ${RISK3}.`;
const USER_PREMISES: Premise[] = [
  { id: 'P1', text: '資料中心需求延續到 2027', origin: 'USER', breaksIf: ['大客戶下修資本支出'] },
  { id: 'P2', text: 'HBM 供給持續吃緊', origin: 'USER' },
];
type Cite = Pick<PackDoc, 'source_id' | 'date'>;
const E = (id: string, doc: Cite, quote: string) => ({ id, source_id: doc.source_id, date: doc.date, quote, claim: '測試' });
const evOf = (q: Cite) => [E('E1', q, Q_GM), E('E2', q, Q_REV), E('E3', q, RISK1), E('E4', q, RISK2), E('E5', q, RISK3)];

const DRAFT_THESIS = '資料中心的 GPU 需求帶動營收與毛利，持有的理由靠需求延續、供給吃緊與毛利率維持。';
const P0 = '資料中心營收連續四季年增超過 30%';
const P1 = 'HBM 的合約價到 2027 年上半年仍然逐季上漲';
const P2 = '毛利率維持在 55% 以上';
const X0 = '毛利率連兩季低於 55%';
const X1 = '公司在 8-K 宣布下修本季營收財測';
const X2 = '法說會上宣布砍掉 HBM 擴產計畫';
const X3 = '股價從高點跌超過 40%';
const C0 = '10-Q 的營收年增率仍高於 30%';
const C1 = 'TrendForce 最新一季的 HBM 合約價預估仍是季漲';
const XBRL_CHECK = { type: 'xbrl_metric_below', metric: 'GrossMarginPct', level: 0.55, quarters: 2 };
const PEERS = [
  { name: 'Micron', edgar: 'MU' },
  { name: 'SK hynix', edgar: 'HXSCL', yahoo: '000660.KS' },
  { name: 'Samsung', yahoo: '005930.KS' },
];
function goodPayload(o: { premises?: unknown[]; exits?: unknown[]; peers?: unknown[] } = {}): Record<string, unknown> {
  return {
    thesis: DRAFT_THESIS,
    premises: o.premises ?? [
      { text: P0, keep_id: null, confirms_if: C0, breaks_if: ['連兩季營收年增率低於 15%'], verify: { by: 'XBRL' }, evidence_ids: ['E2'] },
      { text: P1, keep_id: null, confirms_if: C1, breaks_if: ['TrendForce 的新聞稿報 HBM 合約價季跌', 'SK 海力士的財報說 HBM 供過於求'], verify: { by: 'WEB', source: 'trendforce.com', every: 90 }, evidence_ids: [] },
      { text: P2, keep_id: null, confirms_if: null, breaks_if: ['毛利率連兩季低於 55%'], verify: { by: 'NONE' }, evidence_ids: ['E1'] },
    ],
    exits: o.exits ?? [
      { text: X0, action: 'HALF', kind: 'XBRL', check: XBRL_CHECK, premise_index: 2, evidence_ids: ['E1'] },
      { text: X1, action: 'REVIEW', kind: 'EVENT', check: { type: 'event', confirm_by: ['8-K'] }, premise_index: 0, evidence_ids: [] },
      { text: X2, action: 'EXIT', kind: 'EVENT', check: { confirm_by: ['earnings_call', 'web:WWW.TrendForce.com'] }, premise_index: 1, evidence_ids: [] },
      { text: X3, action: 'REVIEW', kind: 'PRICE', check: null, premise_index: null, evidence_ids: [] },
    ],
    sources: { peers: o.peers ?? PEERS },
    against: [
      { text: '營收集中在三家客戶', evidence_ids: ['E3'] },
      { text: '出口管制限制銷售對象', evidence_ids: ['E4'] },
      { text: '存貨提列變大', evidence_ids: ['E5'] },
    ],
    would_buy_today: { answer: 'UNSURE', why: '需求還在，但客戶集中與存貨的風險都在上升' },
    not_checkable: ['大客戶自研晶片的進度'],
  };
}

// ---------------------------------------------------------------- 假的世界（EDGAR、RSS、雲端排程）

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
const TENQ = { accession: '0001045810-26-000300', form: '10-Q', items: '', acceptanceDateTime: '2026-10-30T20:10:00.000Z', filingDate: '2026-10-30', primaryDocument: 'q.htm' };
const TENQ_HTML = `<html><body><p>Item 2. Management’s Discussion and Analysis of Financial Condition and Results of Operations</p><p>${TENQ_TEXT}</p><p>Item 3. Quantitative and Qualitative Disclosures About Market Risk</p></body></html>`;
const subs = () => Response.json({ cik: '1045810', name: 'NVIDIA CORP', tickers: [], filings: { recent: { accessionNumber: [TENQ.accession], form: [TENQ.form], items: [TENQ.items], acceptanceDateTime: [TENQ.acceptanceDateTime], filingDate: [TENQ.filingDate], primaryDocument: [TENQ.primaryDocument] } } });

function fetcherOf(w: World): Fetcher {
  const base = fakeFetcher(w);
  return async (url, init) => {
    if (url === 'https://api.example/fire') return Response.json({ claude_code_session_url: 'https://claude.ai/code/x' });
    // EDGAR 的代號表：有 MU、NVDA；沒有 HXSCL（同業核對對不到）
    if (url.includes('sec.gov/files/company_tickers.json')) return Response.json({ 0: { cik_str: 1045810, ticker: 'NVDA', title: 'NVIDIA CORP' }, 1: { cik_str: 723125, ticker: 'MU', title: 'MICRON TECHNOLOGY INC' } });
    if (/data\.sec\.gov\/submissions\/CIK\d+\.json/.test(url)) return subs();
    if (/companyfacts\/CIK\d+\.json/.test(url)) return Response.json(BASE);
    const doc = /Archives\/edgar\/data\/\d+\/(\d+)\/(.+)$/.exec(url);
    if (doc) return doc[2] === 'index.json' ? Response.json({ directory: { item: [{ name: TENQ.primaryDocument }] } }) : new Response(TENQ_HTML);
    if (url.startsWith('https://www.nasdaq.com/feed/rssoutbound') || url.startsWith('https://feeds.finance.yahoo.com/rss/2.0/headline')) return new Response('<rss><channel><item><title>x</title><link>https://example.com/a</link></item></channel></rss>');
    return base(url, init);
  };
}

interface Ctx {
  db: D1Database;
  env: Env;
  view: MarketView;
  call: <T = Record<string, unknown>>(method: 'GET' | 'POST', path: string, body: unknown, now: Date, auth?: string) => Promise<{ status: number; body: T }>;
}

/** 2026-11-19 建立帳戶、NVDA 是自選（論點檔 NVDA@2026-11-19）。 */
async function withWorld(fn: (c: Ctx) => Promise<void>, opt: { premises?: Premise[] } = {}) {
  const d = await freshDb();
  try {
    const db = d.db;
    const w = newWorld('2026-11-19');
    const env: Env = { DB: db, ADMIN_TOKEN: 't', AI_TASK_SECRET: 's', EDGAR_USER_AGENT: 'test bot test@example.com', SITE_URL: 'https://bot.example', DEV_NO_AUTH: '1', ROUTINE_FIRE_URL: 'https://api.example/fire', ROUTINE_TOKEN: 'rt' };
    const fetcher = fetcherOf(w);
    await runFlow(env, fetcher, { now: cronTime('2026-11-19'), attempt: 'FIRST' });
    const { view } = buildMarketView(await loadSeries(db, ['VOO', 'SGOV', 'NVDA']), '2026-11-19', 'VOO');
    const shares = Math.floor(40_000 / view.close.NVDA[view.i]);
    const acct = createAccount({ paper: true, cash: 5000, core: { VOO: Math.floor(140_000 / view.close.VOO[view.i]) }, own: { NVDA: { shares, stdWeight: 0.15, premises: opt.premises ?? structuredClone(SYSTEM_DEFAULT_PREMISES), buyNote: 'AI 伺服器的需求還在早期' } } }, view);
    await saveAccount(db, acct, null, '建立帳戶', new Date('2026-11-19T22:00:00Z'));
    const call: Ctx['call'] = async (method, path, b, now, auth) => {
      const r = await handle(new Request(`https://bot.example${path}`, { method, headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) }, ...(b === undefined ? {} : { body: JSON.stringify(b) }) }), env, fetcher, now);
      return { status: r.status, body: (await r.json()) as never };
    };
    await fn({ db, env, view, call });
  } finally {
    await d.dispose();
  }
}

const acctOf = async (db: D1Database): Promise<Account> => (await loadAccount(db))!.acct;
async function mutate(db: D1Database, f: (a: Account) => Account) {
  const loaded = (await loadAccount(db))!;
  await saveAccount(db, f(structuredClone(loaded.acct)), loaded, '測試', new Date('2026-11-19T23:00:00Z'));
}
const T0 = new Date('2026-11-20T01:00:00Z');
const at = (base: Date, days: number, minutes = 0) => new Date(base.getTime() + days * 86400_000 + minutes * 60_000);
const draftsOf = (db: D1Database) => loadDrafts(db, 'NVDA', 50);

async function answer(c: Ctx, runId: string, now: Date, payload: unknown) {
  const run = (await getRun(c.db, runId))!;
  const q = run.pack.documents.find((d) => d.kind === 'filing')!;
  await c.call('GET', `/ai/task/${run.taskId}/evidence`, undefined, now, 's');
  const sample = { run_id: run.runId, function: OWN_DRAFT, verdict: 'DONE', evidence: evOf(q), payload, report: '草稿：論點靠需求、供給與毛利率。' };
  return c.call('POST', `/ai/task/${run.taskId}/result`, { task_id: run.taskId, kind: 'RUN', run_id: run.runId, samples: [sample], lookups: { questions: [], queries: [], wanted: [] } }, now, 's');
}
/** 使用者按「請 stock bot 草擬」、草稿回來。回傳最新那一列。 */
async function requestDraft(c: Ctx, payload: unknown = goodPayload(), now = T0) {
  const r = await c.call<{ runId: string }>('POST', '/api/ops/own-draft', { ticker: 'NVDA' }, now);
  expect(r.status).toBe(200);
  expect((await answer(c, r.body.runId, at(now, 0, 10), payload)).status).toBe(200);
  return (await draftsOf(c.db))[0];
}
async function readyDraft(c: Ctx, payload: unknown = goodPayload(), now = T0) {
  const row = await requestDraft(c, payload, now);
  expect(row.status, row.error ?? '').toBe('READY');
  return row;
}

type DraftPv = DraftUse & { differs: boolean; afterBreakNo: number | null; premiseId: string | null; brokenOpen: boolean; thesisBefore: string; exitPlan: { add: { text: string; status: string }[]; keep: { id: number; action: string; was: string | null }[]; retire: { id: number; text: string }[]; rewrite: { text: string; why: string }[] }; peerPlan: { save: unknown[]; skip: string[]; before: unknown[] } };
type AdoptRes = {
  ok: boolean;
  error?: string;
  preview: { kept: { id: string; text: string; origin: string }[]; added: { id: string; text: string; origin: string }[]; retired: { id: string; origin: string }[]; draft: DraftPv; exits: { changed: boolean } };
  rewrite: { status: string; runId?: string };
  exits: { text: string; action: string }[];
  conds: { added: number; retired: number[]; actionChanged: number[]; errors: string[] };
  peersSkipped: string[];
  revised: { notif: number } | null;
};
const adopt = (c: Ctx, id: number, extra: Record<string, unknown> = {}, now = at(T0, 0, 20)) => c.call<AdoptRes>('POST', '/api/ops/own-draft/adopt', { ticker: 'NVDA', id, ...extra }, now);

interface CondRow {
  id: number;
  cond_id: string;
  kind: string;
  text: string;
  check_json: string;
  status: string;
  origin: string;
  accepted_at: string | null;
  action: string | null;
  premise_id: string | null;
  run_id: string;
  file_id: string | null;
  note: string | null;
}
const condsOf = async (db: D1Database) => (await db.prepare("SELECT * FROM own_conditions WHERE ticker = 'NVDA' ORDER BY id").all<CondRow>()).results;
const logsOf = async (db: D1Database, kind: string) => (await db.prepare('SELECT body FROM own_thesis_log WHERE kind = ? ORDER BY id').bind(kind).all<{ body: string }>()).results.map((x) => JSON.parse(x.body) as Record<string, unknown>);
const runsOf = async (db: D1Database, fn: string) => (await db.prepare('SELECT run_id FROM ai_runs WHERE fn = ?').bind(fn).all<{ run_id: string }>()).results;

// ---------------------------------------------------------------- 純函式

describe('T70 採用怎麼存（draftAdoptPlan、adoptPeers）', () => {
  it('前提整份照草稿：keep_id 帶編號、其他記 AI_DRAFT_ACCEPTED，三個欄位照草稿；出場條件分直接寫進條件、沿用、撤下、送改寫', () => {
    const d = {
      premises: [
        { text: '資料中心需求延續到 2027', keep_id: 'P1', confirms_if: 'x', breaks_if: ['a'], verify: { by: 'FILING' as const, source: null, every: null }, evidence_ids: [] },
        { text: P2, keep_id: null, confirms_if: null, breaks_if: ['b'], verify: { by: 'NONE' as const, source: null, every: null }, evidence_ids: [] },
      ],
      exits: [
        { text: X0, action: 'HALF' as const, premise_index: 1, evidence_ids: [], kind: 'XBRL' as const, check: XBRL_CHECK, threshold: true },
        { text: X1, action: 'REVIEW' as const, premise_index: null, evidence_ids: [], kind: 'EVENT' as const, check: { type: 'event', confirm_by: ['8-K'] }, threshold: false },
        { text: X2, action: 'EXIT' as const, premise_index: null, evidence_ids: [], kind: 'EVENT' as const, check: { type: 'event', confirm_by: ['major_news'] }, threshold: false },
        { text: X3, action: 'REVIEW' as const, premise_index: null, evidence_ids: [], kind: 'PRICE' as const, check: null, threshold: false },
        // T60 的舊草稿：事件條件沒有確認來源 → 送改寫
        { text: '執行長離職', action: 'REVIEW' as const, premise_index: null, evidence_ids: [], kind: 'EVENT' as const, check: null, threshold: false },
        // 監測中的那一條，字只差標點 → 沿用、動作改成草稿的
        { text: '舊的條件：營收衰退。', action: 'EXIT' as const, premise_index: null, evidence_ids: [], kind: 'EVENT' as const, check: null, threshold: false },
      ],
    };
    const live = [
      { id: 11, text: '舊的條件：營收衰退', action: 'HALF' as const, status: '監測中' },
      { id: 12, text: '草稿沒有的條件', action: 'EXIT' as const, status: '監測中' },
    ];
    const p = draftAdoptPlan(d, live);
    expect(p.premises).toEqual([
      { id: 'P1', text: '資料中心需求延續到 2027', breaksIf: ['a'], confirmsIf: 'x', verify: { by: 'FILING' } },
      { id: null, text: P2, origin: 'AI_DRAFT_ACCEPTED', breaksIf: ['b'], confirmsIf: '', verify: { by: 'NONE' } },
    ]);
    expect(p.add.map((x) => [x.k, x.kind, x.status, x.action, x.premiseIndex])).toEqual([
      [0, 'XBRL', 'ACTIVE', 'HALF', 1],
      [1, 'EVENT', 'ACTIVE', 'REVIEW', null],
      [2, 'EVENT', 'REVIEW_ONLY', 'EXIT', null],
      [3, 'PRICE', 'MANUAL', 'REVIEW', null],
    ]);
    expect(p.add[0].check).toEqual(XBRL_CHECK);
    expect(p.rewrite).toEqual([{ k: 4, text: '執行長離職', action: 'REVIEW', why: '舊格式的草稿：事件條件沒有寫用什麼確認' }]);
    expect(p.keep).toEqual([{ k: 5, id: 11, text: '舊的條件：營收衰退', action: 'EXIT', was: 'HALF' }]);
    expect(p.retire.map((c) => c.id)).toEqual([12]);
  });

  it('同業：EDGAR 對得到才存；對不到或沒核對成的，有 Yahoo 代號的只存 Yahoo、沒有的整家不存，都給原因；只有 Yahoo 代號的照存', () => {
    const r = adoptPeers(PEERS, [
      { key: 'edgar:MU', ok: true, why: 'EDGAR 找得到（CIK 0000723125）' },
      { key: 'edgar:HXSCL', ok: false, why: 'EDGAR 找不到這個代號' },
    ]);
    expect(r.save).toEqual([{ name: 'Micron', edgar: 'MU' }, { name: 'SK hynix', yahoo: '000660.KS' }, { name: 'Samsung', yahoo: '005930.KS' }]);
    expect(r.skip).toEqual([{ name: 'SK hynix', edgar: 'HXSCL', why: 'EDGAR 找不到這個代號', yahooKept: true }]);
    expect(adoptPeers([{ name: 'Micron', edgar: 'MU' }], null).skip).toEqual([{ name: 'Micron', edgar: 'MU', why: '沒有核對 EDGAR 代號' }]);
  });
});

describe('T70 畫面的文字（thesis-draft.js）：只顯示、採用、對照、採用後那一行', () => {
  it('草稿的每一項沒有勾選框；出場條件採用後怎麼監測寫清楚（舊格式的寫要送改寫）', () => {
    const items = DJ.draftItems(goodPayload());
    expect([...items.premises, ...items.exits, ...items.peers].every((x) => !('checked' in x))).toBe(true);
    expect(items.exits.map((x) => DJ.exitMonitorText({ ...x, threshold: x.kind === 'XBRL' }).text)).toEqual([
      '財報數字門檻：採用後新財報出來時由程式比對',
      '採用後監測中：新申報出來時由 AI 確認（8-K）',
      '採用後只在定期審查時檢查（法說會、WWW.TrendForce.com 的網頁）',
      '價格條件：採用後只記錄，不會通知',
    ]);
    expect(DJ.exitMonitorText({ kind: 'EVENT', check: null }).text).toContain('採用後這一條送 AI 改寫，回來後在持股頁確認才開始監測');
    expect(DJ.ADOPT_HINT).toBe('採用之前看一眼最上面的反方三點：還願意抱著這檔嗎？');
    expect(DJ.adoptedNote('2026-11-21T02:00:00Z')).toBe('已採用 11/21 的草稿；要改字在這一頁改');
  });

  it('提示不再寫「勾」：剛被判不成立 → 採用算一次失效後修改；最後一行說明採用＝整份照草稿存', () => {
    const base = { trigger: 'MANUAL', createdAt: '2026-11-20T01:00:00Z', until: '2026-12-20', stale: false, basedOn: 1, version: 1 };
    const n = DJ.draftNotices({ ...base, broken: { premiseId: 'P2', notice: '前提 P2 剛被判不成立。在這之後改論點，很容易只是替繼續持有找新理由', open: true } });
    expect(n.map((x) => x.text).join('')).not.toMatch(/勾了|沒勾|逐條勾/);
    expect(n[1].text).toContain('採用這份草稿算一次「失效後修改」');
    expect(n.at(-1)!.text).toContain('採用就是整份照草稿存（論點、前提、出場條件、同業），出場條件採用後直接生效');
  });

  it('LINE 一行與草稿證據包的題目、rule.action 改成採用的說法（T69 留下的）', () => {
    const row = { ticker: 'MU', status: 'READY' as const, error: null, settled_at: '2026-11-20T01:10:00Z', created_at: '2026-11-20T01:00:00Z' };
    expect(draftLineText(row, false, null)).toBe('MU 的論點草稿好了：先看反方的三點，再決定要不要整份採用（12/20 之後不再列）');
    const { pack } = ownDraftPack({ runId: 'r', asOf: '2026-11-19', ticker: 'NVDA', trigger: 'MANUAL', held: true, premises: [], facts: [], docs: [], dataQuality: {}, thesisVersion: 0, fileId: null, broken: null, webDomains: [], now: T0 });
    expect(pack.question).toContain('使用者看過反方、按「採用」才會整份生效');
    expect(pack.question).not.toContain('勾選');
    expect(pack.rule.action).toBe('只說明（草稿：使用者按「採用」才整份生效）');
  });
});

// ---------------------------------------------------------------- 整個流程（網站 API）

describe('T70 採用：整份照草稿存（§2.1～§2.3）', () => {
  it('論點、前提（confirmsIf／verify／breaksIf／信念）、出場條件、同業都存進去；草稿標 USED、DraftUse 正確', async () => {
    await withWorld(async (c) => {
      const row = await readyDraft(c);
      // 只有系統預設前提、沒有條件與同業：不用對照，直接採用
      const dry = await adopt(c, row.id, { dry: true });
      expect(dry.status).toBe(200);
      expect(dry.body.preview.draft).toMatchObject({ differs: false, thesisBefore: '' });
      expect((await draftsOf(c.db))[0].status).toBe('READY');
      expect(await condsOf(c.db)).toEqual([]);
      const r = await adopt(c, row.id);
      expect(r.status).toBe(200);
      const a = await acctOf(c.db);
      expect(a.own.NVDA.thesis).toMatchObject({ text: DRAFT_THESIS, source: 'DRAFT', version: 1, afterBreak: 0 });
      expect(a.own.NVDA.premises).toEqual([
        { id: 'P4', text: P0, origin: 'AI_DRAFT_ACCEPTED', breaksIf: ['連兩季營收年增率低於 15%'], confirmsIf: C0, verify: { by: 'XBRL' }, addedAt: '2026-11-19' },
        { id: 'P5', text: P1, origin: 'AI_DRAFT_ACCEPTED', breaksIf: ['TrendForce 的新聞稿報 HBM 合約價季跌', 'SK 海力士的財報說 HBM 供過於求'], confirmsIf: C1, verify: { by: 'WEB', source: 'trendforce.com', every: 90 }, addedAt: '2026-11-19' },
        { id: 'P6', text: P2, origin: 'AI_DRAFT_ACCEPTED', breaksIf: ['毛利率連兩季低於 55%'], verify: { by: 'NONE' }, addedAt: '2026-11-19' },
      ]);
      expect(a.own.NVDA.webSources?.peers).toEqual([{ name: 'Micron', edgar: 'MU' }, { name: 'SK hynix', yahoo: '000660.KS' }, { name: 'Samsung', yahoo: '005930.KS' }]);
      // 草稿 USED，DraftUse：整份採用、沒有「沒勾的」、沒有網站
      const after = (await draftsOf(c.db))[0];
      expect(after.status).toBe('USED');
      const use = JSON.parse(after.used_json!) as Record<string, unknown>;
      expect(use).toEqual({
        id: row.id,
        runId: row.run_id,
        version: 1,
        thesis: 'SAME',
        premises: { same: 3, edited: 0, kept: 0 },
        exits: 4,
        exitsKept: 0,
        exitsRewrite: 0,
        peers: 3,
        peersSkipped: [{ name: 'SK hynix', edgar: 'HXSCL', why: expect.stringContaining('EDGAR 找不到這個代號'), yahooKept: true }],
        afterBreak: false,
      });
      expect('unused' in use || 'domains' in use).toBe(false);
      expect((await logsOf(c.db, 'THESIS')).at(-1)).toMatchObject({ source: 'DRAFT', draft: { id: row.id, exits: 4 } });
      // 編輯論點頁讀不到了、要看的事不再列
      expect((await c.call<{ draft: unknown }>('GET', '/api/own/NVDA/draft', undefined, at(T0, 0, 30))).body.draft).toBeNull();
      const hd = await c.call<{ attention: { kind: string }[] }>('GET', '/api/holding/NVDA', undefined, at(T0, 0, 30));
      expect(hd.body.attention.some((x) => x.kind === 'DRAFT_READY')).toBe(false);
    });
  });

  it('出場條件直接是 ACTIVE／REVIEW_ONLY／MANUAL（origin AI_DRAFT_ACCEPTED、有採用時間、動作照草稿）；沒有送改寫、持股頁沒有等確認的列', async () => {
    await withWorld(async (c) => {
      const row = await readyDraft(c);
      const r = await adopt(c, row.id);
      expect(r.body.rewrite.status).toBe('NONE');
      expect(r.body.conds).toMatchObject({ added: 4, retired: [], errors: [] });
      const conds = await condsOf(c.db);
      expect(conds.map((x) => [x.cond_id, x.kind, x.text, x.status, x.origin, x.action, x.premise_id, x.file_id])).toEqual([
        ['D1', 'XBRL', X0, 'ACTIVE', 'AI_DRAFT_ACCEPTED', 'HALF', 'P6', 'NVDA@2026-11-19'],
        ['D2', 'EVENT', X1, 'ACTIVE', 'AI_DRAFT_ACCEPTED', 'REVIEW', 'P4', 'NVDA@2026-11-19'],
        ['D3', 'EVENT', X2, 'REVIEW_ONLY', 'AI_DRAFT_ACCEPTED', 'EXIT', 'P5', 'NVDA@2026-11-19'],
        ['D4', 'PRICE', X3, 'MANUAL', 'AI_DRAFT_ACCEPTED', 'REVIEW', null, 'NVDA@2026-11-19'],
      ]);
      expect(conds.every((x) => x.accepted_at === at(T0, 0, 20).toISOString() && x.run_id === row.run_id)).toBe(true);
      // 財報門檻照草稿的 check；事件條件的網頁來源寫成小寫（和改寫同一個格式檢查，T69 的 draftEventCheck）
      expect(JSON.parse(conds[0].check_json)).toEqual(XBRL_CHECK);
      expect(JSON.parse(conds[2].check_json)).toEqual({ type: 'event', confirm_by: ['earnings_call', 'web:www.trendforce.com'] });
      expect(await runsOf(c.db, 'OWN_CHECK')).toEqual([]);
      expect(conds.some((x) => x.status === 'PROPOSED')).toBe(false);
      // 持股頁：四條都是你定的、誰定的寫採用；沒有改寫結果、沒有「還沒送去改寫」
      const hd = await c.call<{ monitor: { text: string; owned: boolean; origin: string; status: string }[]; rewrites: { results: unknown[]; unsent: unknown; dropAll: unknown } }>('GET', '/api/holding/NVDA', undefined, at(T0, 0, 30));
      expect(hd.body.monitor.map((m) => [m.owned, m.status])).toEqual([
        [true, '監測中'],
        [true, '監測中'],
        [true, '只在定期審查時檢查'],
        [true, '只記錄'],
      ]);
      expect(hd.body.monitor[0].origin).toBe('stock bot 草稿，你在 11/20 採用');
      expect(hd.body.rewrites).toEqual({ results: [], unsent: null, dropAll: null });
      expect((await logsOf(c.db, 'EXITS_CONFIRMED')).at(-1)).toMatchObject({ by: 'DRAFT', version: 1, draftRunId: row.run_id });
      expect((await logsOf(c.db, 'CONDITION')).filter((l) => l.change === 'ACCEPTED' && l.by === 'DRAFT')).toHaveLength(4);
    });
  });

  it('現在有論點與條件時：預覽列出對照（換掉、沿用的前提；撤下、沿用的條件）；確定採用後照 T42 整組取代——草稿沒有的撤下、字一樣的沿用並改動作；keep_id 的編號不變', async () => {
    await withWorld(
      async (c) => {
        const fid = 'NVDA@2026-11-19';
        const ins = c.db.prepare("INSERT INTO own_conditions (ticker, run_id, cond_id, direction, kind, text, check_json, tier_if_met, status, created_at, origin, file_id, accepted_at, action, auto) VALUES ('NVDA', 'old-run', ?, 'DOWN', ?, ?, ?, NULL, ?, '2026-11-19T00:00:00Z', 'USER', ?, '2026-11-19T00:00:00Z', ?, 1)");
        await c.db.batch([ins.bind('U1', 'XBRL', `${X0}。`, JSON.stringify(XBRL_CHECK), 'ACTIVE', fid, 'EXIT'), ins.bind('U2', 'EVENT', '我自己的舊條件：公司被收購', JSON.stringify({ type: 'event', confirm_by: ['8-K'] }), 'ACTIVE', fid, 'EXIT')]);
        await c.call('POST', '/api/ops/own-thesis', { ticker: 'NVDA', thesis: '我自己的論點', premises: [{ id: 'P1', text: USER_PREMISES[0].text }, { id: 'P2', text: USER_PREMISES[1].text }], exitConditions: [{ text: `${X0}。`, action: 'EXIT' }, { text: '我自己的舊條件：公司被收購', action: 'EXIT' }], source: 'TYPED' }, at(T0, 0, -30));
        const payload = goodPayload({
          premises: [
            { text: USER_PREMISES[0].text, keep_id: 'P1', confirms_if: '雲端大廠的資本支出指引上修', breaks_if: ['兩家以上的大客戶下修資本支出'], verify: { by: 'PEER_FILING', source: '大客戶的 10-Q' }, evidence_ids: [] },
            { text: P0, keep_id: null, confirms_if: C0, breaks_if: ['連兩季營收年增率低於 15%'], verify: { by: 'XBRL' }, evidence_ids: ['E2'] },
            { text: P2, keep_id: null, confirms_if: null, breaks_if: ['毛利率連兩季低於 55%'], verify: { by: 'NONE' }, evidence_ids: ['E1'] },
          ],
        });
        const row = await readyDraft(c, payload);
        const dry = await adopt(c, row.id, { dry: true });
        expect(dry.status).toBe(200);
        const pv = dry.body.preview;
        expect(pv.draft.differs).toBe(true);
        expect(pv.kept.map((x) => x.id)).toEqual(['P1']);
        expect(pv.retired.map((x) => x.id)).toEqual(['P2']);
        expect(pv.added.map((x) => [x.id, x.origin])).toEqual([
          ['P3', 'AI_DRAFT_ACCEPTED'],
          ['P4', 'AI_DRAFT_ACCEPTED'],
        ]);
        const [u1, u2] = await condsOf(c.db);
        expect(pv.draft.exitPlan.keep).toEqual([{ id: u1.id, text: `${X0}。`, action: 'HALF', was: 'EXIT' }]);
        expect(pv.draft.exitPlan.retire).toEqual([{ id: u2.id, text: '我自己的舊條件：公司被收購' }]);
        expect(pv.draft.exitPlan.add.map((x) => x.text)).toEqual([X1, X2, X3]);
        // 畫面上的對照：換掉、沿用、新的、撤下
        const cmp = DJ.adoptCompare(pv);
        expect(cmp.map((s) => s.h)).toEqual(['論點與前提', '出場條件', '同業']);
        expect(cmp[0].rows.map((x) => x.text)).toEqual([
          '論點本文：換成草稿的那一段（現在的那段不留）',
          '換掉 P2：HBM 供給持續吃緊',
          `沿用 P1：${USER_PREMISES[0].text}（編號不變，之前的檢查結果接著算）`,
          `新的 P3：${P0}`,
          `新的 P4：${P2}`,
        ]);
        expect(cmp[1].rows.map((x) => x.text)[0]).toBe('撤下：我自己的舊條件：公司被收購');
        expect(cmp[1].rows.map((x) => x.text)[1]).toBe(`沿用：${X0}。（成立時 出清 → 減半）`);
        expect(cmp[2].rows.map((x) => x.text)).toContain('同業 SK hynix（EDGAR HXSCL）只存了 Yahoo 代號，EDGAR 代號沒有存：EDGAR 找不到這個代號（不在美國申報的公司多半沒有，可以只填 Yahoo 代號）');
        // 確定採用
        const r = await adopt(c, row.id, {}, at(T0, 0, 25));
        expect(r.status).toBe(200);
        const a = await acctOf(c.db);
        expect(a.own.NVDA.premises.map((p) => [p.id, p.origin])).toEqual([
          ['P1', 'USER'],
          ['P3', 'AI_DRAFT_ACCEPTED'],
          ['P4', 'AI_DRAFT_ACCEPTED'],
        ]);
        // 沿用的 P1：三個欄位換成草稿寫的
        expect(a.own.NVDA.premises[0]).toMatchObject({ confirmsIf: '雲端大廠的資本支出指引上修', breaksIf: ['兩家以上的大客戶下修資本支出'], verify: { by: 'PEER_FILING', source: '大客戶的 10-Q' } });
        const conds = await condsOf(c.db);
        expect(conds.find((x) => x.id === u1.id)).toMatchObject({ status: 'ACTIVE', action: 'HALF', origin: 'USER' });
        expect(conds.find((x) => x.id === u2.id)).toMatchObject({ status: 'RETIRED', note: expect.stringContaining('採用 stock bot 的草稿') });
        expect(conds.filter((x) => x.origin === 'AI_DRAFT_ACCEPTED').map((x) => x.text)).toEqual([X1, X2, X3]);
        expect(r.body.conds).toMatchObject({ added: 3, retired: [u2.id], actionChanged: [u1.id] });
        expect(JSON.parse((await draftsOf(c.db))[0].used_json!)).toMatchObject({ premises: { same: 2, edited: 0, kept: 1 }, exits: 3, exitsKept: 1 });
        // 採用後那幾行
        const lines = DJ.adoptResultLines(r.body, '2026-11-20T01:10:00Z').map((x) => x.text);
        expect(lines[0]).toBe('已採用 11/20 的草稿；要改字在這一頁改');
        expect(lines[1]).toBe('出場條件 3 條採用後就生效；1 條和原本的一樣，沿用；撤下原本的 1 條；同業 3 家。');
        expect(lines).toContain(r.body.peersSkipped[0]);
      },
      { premises: USER_PREMISES },
    );
  });

  it('同業：EDGAR 對不到的只存 Yahoo 代號，回應寫一行原因；只有 Yahoo 代號的照存', async () => {
    await withWorld(async (c) => {
      const row = await readyDraft(c);
      const r = await adopt(c, row.id);
      expect(r.body.peersSkipped).toEqual(['同業 SK hynix（EDGAR HXSCL）只存了 Yahoo 代號，EDGAR 代號沒有存：EDGAR 找不到這個代號（不在美國申報的公司多半沒有，可以只填 Yahoo 代號）']);
      const ws = (await acctOf(c.db)).own.NVDA.webSources!;
      expect(ws.peers).toEqual([{ name: 'Micron', edgar: 'MU' }, { name: 'SK hynix', yahoo: '000660.KS' }, { name: 'Samsung', yahoo: '005930.KS' }]);
      expect(ws.checked?.items.map((x) => [x.key, x.ok])).toEqual([
        ['edgar:MU', true],
        ['edgar:HXSCL', false],
      ]);
    });
  });

  it('只有還在等你看的草稿可以採用：採用過再按 409；示範模式 400；舊頁面送逐條勾選的 draft → 409', async () => {
    await withWorld(async (c) => {
      const row = await readyDraft(c);
      expect((await adopt(c, row.id)).status).toBe(200);
      const again = await adopt(c, row.id, {}, at(T0, 0, 21));
      expect(again.status).toBe(409);
      expect(again.body.error).toContain('採用過了');
      const old = await c.call<{ error: string }>('POST', '/api/ops/own-thesis', { ticker: 'NVDA', thesis: 'x', premises: [{ text: 'y' }], exitConditions: [], source: 'TYPED', draft: { id: row.id, thesis: false, peers: [], domains: [] } }, at(T0, 0, 22));
      expect(old.status).toBe(409);
      expect(old.body.error).toContain('草稿現在是整份採用');
      expect((await c.call('POST', '/demo/api/ops/own-draft/adopt', { ticker: 'NVDA', id: row.id }, at(T0, 0, 22))).status).toBe(400);
    });
  });
});

describe('T70 前提剛被判不成立之後的草稿（§2.1、web_evidence §2.4 第 6 點）', () => {
  const brokenWorld = (fn: (c: Ctx, notif: number) => Promise<void>) =>
    withWorld(
      async (c) => {
        await mutate(c.db, (a) => routeReview(a, c.view, 'NVDA', { tier: 'HALF', suggest: true, consensus: true, premiseId: 'P2', trigger: 'EARNINGS', date: '2026-11-19' }).acct);
        const notif = (await acctOf(c.db)).notifs.at(-1)!.id;
        await fn(c, notif);
      },
      { premises: USER_PREMISES },
    );

  it('採用算一次「失效後修改」（那則通知仍等你決定）；勾著「這是對通知的回應」→ 修正論點結案，也只算一次', async () => {
    await brokenWorld(async (c, notif) => {
      const row = await readyDraft(c);
      const dry = await adopt(c, row.id, { dry: true });
      expect(dry.body.preview.draft).toMatchObject({ afterBreak: true, afterBreakNo: 1, premiseId: 'P2', brokenOpen: true });
      expect(DJ.adoptCompare(dry.body.preview).at(-1)!.rows[0].text).toContain('採用算一次「失效後修改」（第 1 次）');
      const r = await adopt(c, row.id);
      expect(r.status).toBe(200);
      let a = await acctOf(c.db);
      expect(a.own.NVDA.thesis).toMatchObject({ afterBreak: 1, lastAfterBreakAt: '2026-11-19' });
      expect(a.notifs.find((n) => n.id === notif)?.status).toBe('PENDING');
      expect((await logsOf(c.db, 'THESIS')).at(-1)).toMatchObject({ afterBreak: true, draft: { afterBreak: true } });
      expect(DJ.adoptResultLines(r.body, row.settled_at!).map((x) => x.text)).toContain('這次算一次「失效後修改」（第 1 次）。');
      // 再一份（7 天後），這次勾著回應
      const row2 = await readyDraft(c, goodPayload(), at(T0, 8));
      const r2 = await adopt(c, row2.id, { replyTo: notif }, at(T0, 8, 20));
      expect(r2.status).toBe(200);
      a = await acctOf(c.db);
      expect(a.own.NVDA.thesis?.afterBreak).toBe(2);
      expect(a.notifs.find((n) => n.id === notif)?.status).toBe('DONE');
    });
  });

  it('keep_id 不能是被判不成立的那一條：草稿檢查整份退回；字一模一樣（被對回那一條）的採用 → 422、什麼都沒存', async () => {
    await brokenWorld(async (c) => {
      const keepBroken = goodPayload({ premises: [{ text: USER_PREMISES[1].text, keep_id: 'P2', confirms_if: 'x', breaks_if: ['y'], verify: { by: 'FILING' }, evidence_ids: [] }, ...(goodPayload().premises as unknown[]).slice(0, 2)] });
      const failed = await requestDraft(c, keepBroken);
      expect(failed.status).toBe('FAILED');
      expect(failed.error).toContain('沿用了剛被判不成立的前提 P2（keep_id 不能是它）');
      const sameText = goodPayload({ premises: [{ text: USER_PREMISES[1].text, keep_id: null, confirms_if: 'x', breaks_if: ['y'], verify: { by: 'FILING' }, evidence_ids: [] }, ...(goodPayload().premises as unknown[]).slice(0, 2)] });
      // 失敗的不算 7 天一次，可以馬上再按
      const row = await readyDraft(c, sameText, at(T0, 0, 30));
      const before = await acctOf(c.db);
      const r = await adopt(c, row.id, {}, at(T0, 0, 50));
      expect(r.status).toBe(422);
      expect(r.body.error).toContain('和剛被判不成立的 P2 一字不差');
      expect((await acctOf(c.db)).own.NVDA).toEqual(before.own.NVDA);
      expect(await condsOf(c.db)).toEqual([]);
      expect((await draftsOf(c.db))[0].status).toBe('READY');
    });
  });
});

describe('T70 採用之後你親手改出場條件的字：照舊走改寫與確認（§2.2）', () => {
  it('字沒動 → 不送改寫；改了一條的字 → 整組送改寫，確認之前採用的條件照舊監測', async () => {
    await withWorld(async (c) => {
      const row = await readyDraft(c);
      await adopt(c, row.id);
      const a = await acctOf(c.db);
      const premises = a.own.NVDA.premises.map((p) => ({ id: p.id, text: p.text }));
      const exits = (await condsOf(c.db)).map((x) => ({ text: x.text, action: x.action }));
      const same = await c.call<{ rewrite: { status: string }; preview: { exits: { changed: boolean } } }>('POST', '/api/ops/own-thesis', { ticker: 'NVDA', thesis: DRAFT_THESIS, premises, exitConditions: exits, source: 'TYPED' }, at(T0, 0, 40));
      expect(same.body.preview.exits.changed).toBe(false);
      expect(same.body.rewrite.status).toBe('NONE');
      const edited = exits.map((x, k) => (k === 1 ? { ...x, text: '公司在 8-K 宣布下修全年營收財測' } : x));
      const r = await c.call<{ rewrite: { status: string; runId: string }; preview: { exits: { changed: boolean } } }>('POST', '/api/ops/own-thesis', { ticker: 'NVDA', thesis: DRAFT_THESIS, premises, exitConditions: edited, source: 'TYPED' }, at(T0, 0, 45));
      expect(r.body.preview.exits.changed).toBe(true);
      expect(r.body.rewrite.status).toBe('SENT');
      const run = (await getRun(c.db, r.body.rewrite.runId))!;
      expect(run.fn).toBe('OWN_CHECK');
      expect(JSON.stringify(run.pack)).toContain('公司在 8-K 宣布下修全年營收財測');
      // 採用的四條在改寫的證據包裡是「你定的條件」，確認之前照舊監測
      expect((run.pack.rule.detail as { live: number[] }).live).toHaveLength(4);
      expect((await condsOf(c.db)).map((x) => x.status)).toEqual(['ACTIVE', 'ACTIVE', 'REVIEW_ONLY', 'MANUAL']);
    });
  });
});

describe('T70 舊格式的草稿（T69 以前存的：有 domains、事件條件沒有 confirm_by）', () => {
  it('採用不會壞：網站不看；沒有確認來源的事件條件改走改寫確認（寫進回應），其他直接生效', async () => {
    await withWorld(async (c) => {
      const row = await readyDraft(c);
      // 換成 T60（own_draft_v2）存的樣子：事件條件的 check 是 null、sources 有 domains
      const p = JSON.parse(row.payload!) as Record<string, unknown> & { exits: Record<string, unknown>[]; sources: Record<string, unknown> };
      p.exits = p.exits.slice(0, 2).map((x) => (x.kind === 'EVENT' ? { ...x, check: null } : x));
      p.sources = { peers: [], domains: [{ domain: 'www.micron.com', state: 'NEW', note: '新的來源，存檔前會先試抓' }] };
      await c.db.prepare('UPDATE own_drafts SET payload = ? WHERE id = ?').bind(JSON.stringify(p), row.id).run();
      const dry = await adopt(c, row.id, { dry: true });
      expect(dry.status).toBe(200);
      expect(dry.body.preview.draft.exitPlan.rewrite).toEqual([{ text: X1, action: 'REVIEW', why: '舊格式的草稿：事件條件沒有寫用什麼確認' }]);
      expect(DJ.adoptCompare(dry.body.preview)[1].rows.map((x) => x.text)).toContain(`送 AI 改寫、回來後在持股頁確認：${X1}（舊格式的草稿：事件條件沒有寫用什麼確認）`);
      const r = await adopt(c, row.id);
      expect(r.status).toBe(200);
      expect(r.body.exits).toEqual([{ text: X1, action: 'REVIEW' }]);
      expect(r.body.rewrite.status).toBe('SENT');
      const run = (await getRun(c.db, r.body.rewrite.runId!))!;
      expect(run.fn).toBe('OWN_CHECK');
      expect((run.pack.rule.detail as { exits: { text: string }[] }).exits.map((x) => x.text)).toEqual([X1]);
      // 財報門檻直接生效；那一條等改寫回來在持股頁確認
      expect((await condsOf(c.db)).map((x) => [x.text, x.status])).toEqual([[X0, 'ACTIVE']]);
      expect(JSON.parse((await draftsOf(c.db))[0].used_json!)).toMatchObject({ exits: 1, exitsRewrite: 1, peers: 0 });
      expect((await logsOf(c.db, 'THESIS')).at(-1)).toMatchObject({ exitsChanged: true, exitLines: [X1], exitsLive: [] });
      expect(await logsOf(c.db, 'EXITS_CONFIRMED')).toEqual([]);
      const hd = await c.call<{ rewrites: { results: { runId: string }[]; unsent: unknown } }>('GET', '/api/holding/NVDA', undefined, at(T0, 0, 30));
      expect(hd.body.rewrites.results.map((x) => x.runId)).toEqual([r.body.rewrite.runId]);
      expect(DJ.adoptResultLines(r.body, row.settled_at!).map((x) => x.text)).toContain('1 條舊格式的出場條件送去 AI 改寫，回來後在這一頁確認才開始監測。');
      // 舊的網站沒有存進來（T68 起不讀）
      expect((await acctOf(c.db)).own.NVDA.webSources ?? null).toBeNull();
    });
  });
});

describe('T70 運作統計：依前提的來源分開（§2.4，「原樣採用」）', () => {
  it('採用的前提記 AI_DRAFT_ACCEPTED、之後你改了字的記 USER，審查結果分兩列算', async () => {
    await withWorld(async (c) => {
      const row = await readyDraft(c);
      await adopt(c, row.id);
      // 之後你改了 P5 的字 → 來源變成你寫的
      const a = await acctOf(c.db);
      const premises = a.own.NVDA.premises.map((p) => ({ id: p.id, text: p.id === 'P5' ? 'HBM 的合約價到 2027 年仍然上漲' : p.text }));
      const exits = (await condsOf(c.db)).map((x) => ({ text: x.text, action: x.action }));
      expect((await c.call('POST', '/api/ops/own-thesis', { ticker: 'NVDA', thesis: DRAFT_THESIS, premises, exitConditions: exits, source: 'TYPED' }, at(T0, 0, 40))).status).toBe(200);
      const now = (await acctOf(c.db)).own.NVDA.premises;
      expect(now.map((p) => [p.id, p.origin])).toEqual([
        ['P4', 'AI_DRAFT_ACCEPTED'],
        ['P5', 'USER'],
        ['P6', 'AI_DRAFT_ACCEPTED'],
      ]);
      // 一次定期審查（證據包把來源遮成 USER）：P4 三票成立、P5 三票不成立
      const pack = { premises: now.slice(0, 2).map((p) => ({ id: p.id, text: p.text, origin: 'USER' })) };
      const vote = (st4: string, st5: string) => ({ valid: true, verdict: 'HOLD', premises: [{ premise_id: 'P4', status: st4, evidence_ids: [] }, { premise_id: 'P5', status: st5, evidence_ids: [] }] });
      const outcome = { status: 'AGREED', samples: [vote('HOLDS', 'BROKEN'), vote('HOLDS', 'BROKEN'), vote('HOLDS', 'BROKEN')] };
      await c.db.prepare("INSERT INTO ai_runs (run_id, fn, ticker, as_of, created_at, status, prompt_version, pack_hash, pack, outcome) VALUES ('rv1', 'OWN_REVIEW', 'NVDA', '2026-11-20', ?, 'DONE', 'own_review_v5', 'h', ?, ?)").bind(at(T0, 0, 50).toISOString(), JSON.stringify(pack), JSON.stringify(outcome)).run();
      const res = await c.call<OpsReport>('GET', '/admin/ops-report?from=2026-11-01&to=2026-11-30', undefined, at(T0, 1), 't');
      const sec = res.body.sections.find((s) => s.id === 'premise_origin')!;
      expect(sec.title).toContain('AI_DRAFT_ACCEPTED 原樣採用的草稿');
      const byOrigin = (o: string) => sec.rows.find((r: Row) => r.origin === o)!;
      expect(byOrigin('AI_DRAFT_ACCEPTED')).toMatchObject({ reviews: 1, premise_checks: 1, holds: 1, broken: 0 });
      expect(byOrigin('USER')).toMatchObject({ reviews: 1, premise_checks: 1, holds: 0, broken: 1 });
      // 草稿那一段：採用的那一份算 used，原樣採用的前提 3 條
      const drafts = res.body.sections.find((s) => s.id === 'drafts')!;
      expect(drafts.rows.find((r: Row) => r.trigger === 'MANUAL')).toMatchObject({ used: 1, premises_same: 3, premises_unused: 0, exits_used: 4 });
    });
  });
});

// ---------------------------------------------------------------- T71：採用時的 8 條上限、AI 監測中的不動

describe('T71 採用草稿與條件的上限（confirm_audit_design §3）', () => {
  it('adoptOwnedCount：沿用的（看現在的狀態）＋直接寫進去的（看寫進去之後的狀態），只記錄的不算', () => {
    const add = (status: 'ACTIVE' | 'REVIEW_ONLY' | 'MANUAL', k = 0) => ({ k, text: `x${k}`, action: 'HALF' as const, kind: 'XBRL' as const, check: XBRL_CHECK, premiseIndex: null, status });
    const keep = (id: number) => ({ k: 9, id, text: `c${id}`, action: 'EXIT' as const, was: 'EXIT' as const });
    const live = [
      { id: 1, text: 'c1', action: 'EXIT' as const, status: '監測中', code: 'ACTIVE' },
      { id: 2, text: 'c2', action: 'EXIT' as const, status: '只記錄', code: 'MANUAL' },
      { id: 3, text: 'c3', action: 'EXIT' as const, status: '監測中' },
    ];
    expect(adoptOwnedCount({ keep: [keep(1), keep(2)], add: [add('ACTIVE'), add('REVIEW_ONLY'), add('MANUAL')] }, live)).toBe(3);
    // 舊的呼叫端沒給 code：沿用的那條算一條
    expect(adoptOwnedCount({ keep: [keep(3)], add: [] }, live)).toBe(1);
    expect(adoptOwnedCount({ keep: [], add: Array.from({ length: 9 }, (_, k) => add('ACTIVE', k)) }, live)).toBe(9);
  });

  it('AI 監測中的條件：採用不撤下、不改、不算在你定的條件裡；採用之後你定的超過 8 條 → 422（預覽與存檔都擋），什麼都沒存', async () => {
    await withWorld(async (c) => {
      const fid = 'NVDA@2026-11-19';
      const ins = (cid: string, text: string) =>
        c.db.prepare("INSERT INTO own_conditions (ticker, run_id, cond_id, direction, kind, text, check_json, tier_if_met, status, created_at, origin, file_id, action, auto) VALUES ('NVDA', 'rev-0', ?, 'DOWN', 'XBRL', ?, ?, 'HALF', 'ACTIVE', '2026-11-19T23:00:00.000Z', 'AI', ?, 'REVIEW', 1)").bind(cid, text, JSON.stringify(XBRL_CHECK), fid).run();
      await ins('W1', 'AI 監測中：毛利率低於 50%');
      await ins('W2', 'AI 監測中：毛利率低於 45%');
      const row = await readyDraft(c);
      // 先把存下的那一份改成出場條件 9 條（正常的草稿最多 6 條，檢查擋得住；這裡模擬上限被突破）
      const good = row.payload!;
      const nine = Array.from({ length: 9 }, (_, k) => ({ text: `毛利率連兩季低於 ${40 + k}%`, action: 'HALF', kind: 'XBRL', check: { ...XBRL_CHECK, level: 0.4 + k / 100 }, premise_index: null, evidence_ids: [] }));
      await c.db.prepare('UPDATE own_drafts SET payload = ? WHERE id = ?').bind(JSON.stringify({ ...(JSON.parse(good) as Record<string, unknown>), exits: nine }), row.id).run();
      const before = await acctOf(c.db);
      for (const dry of [true, false]) {
        const bad = await adopt(c, row.id, { dry });
        expect(bad.status).toBe(422);
        expect(bad.body.error).toBe('採用這份草稿之後，你定的條件會有 9 條（上限 8 條），這份草稿不能採用。按「不用這份草稿」，或到編輯論點自己寫出場條件。');
      }
      expect((await acctOf(c.db)).own.NVDA.thesis).toEqual(before.own.NVDA.thesis);
      expect((await condsOf(c.db)).map((x) => x.cond_id)).toEqual(['W1', 'W2']);
      expect((await draftsOf(c.db)).find((d) => d.id === row.id)!.status).toBe('READY');

      // 正常的那一份：AI 監測中的兩條不撤下（對照裡也沒有）、不改；你定的是草稿的 4 條
      await c.db.prepare('UPDATE own_drafts SET payload = ? WHERE id = ?').bind(good, row.id).run();
      const pv = await adopt(c, row.id, { dry: true });
      expect(pv.status).toBe(200);
      expect(pv.body.preview.draft.exitPlan.retire).toEqual([]);
      const r = await adopt(c, row.id);
      expect(r.status).toBe(200);
      const all = await condsOf(c.db);
      expect(all.filter((x) => x.origin === 'AI').map((x) => [x.cond_id, x.status, x.accepted_at, x.action])).toEqual([
        ['W1', 'ACTIVE', null, 'REVIEW'],
        ['W2', 'ACTIVE', null, 'REVIEW'],
      ]);
      expect(all.filter((x) => x.origin === 'AI_DRAFT_ACCEPTED')).toHaveLength(4);
      const hd = await c.call<{ monitor: { owned: boolean; ai: boolean }[] }>('GET', '/api/holding/NVDA', undefined, at(T0, 0, 30));
      expect([hd.body.monitor.filter((m) => m.owned).length, hd.body.monitor.filter((m) => m.ai).length]).toEqual([4, 2]);
    });
  });
});
