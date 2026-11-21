// T61：判「成立」（HOLDS）收緊（composite_layer_design_2026-11-21 §2.1；計畫階段十）。
// 完成條件：
//   1 prompt 升版：own_review_v4、own_drop_v4（§2.1 的表、confirm_ids、breaksIf 任一句成立就算、逐句回答、驗證頻率）；v3 開頭標「不再使用（2026-11-21）」；
//     程式的 prompt_version 跟著改；審查與減半檢視的證據包帶 policy.holds_fresh_days = 100
//   2 日期核對（check.ts，和引用檢查降級同一個地方）：判成立要指出正面的引用，那幾份原文裡最新的一份比「決策日減驗證頻率」還舊 → 這一票的這一條降成證據不足、標逾期；
//     驗證頻率用前提的 verify.every，沒寫用 100 天；用的是原文的日期，不是 AI 寫的日期；背景與新聞標題不算；沒設 holds_fresh_days 的證據包（其他功能、舊的執行）不核對
//   3 逐字引用檢查沒有放寬：改寫過的引用照樣被刪；confirm_ids 指到被刪的引用不算
//   4 證據不足的後果不變：不列建議、不動檔位；往上的檔位更少；減半檢視的「不動」不受影響
//   5 持股頁的四種寫法：由歷次定期審查算（證實／被判不成立／這次沒驗到（上次證實哪天）／已經 N 次沒驗到），理由在同一塊；整條流程（假的 AI 回覆）到持股頁的 API
//   6 審查紀錄頁：被改成證據不足的那一票標原因（逾期、沒有指出正面的引用、引用被刪）
//   7 運作統計：premise_origin 多 stale；新的一段 premise_prompt（依功能與 prompt 版本）
// 對外請求全部是假的（EDGAR、RSS、雲端排程、LINE）；AI 的回覆一律是假的。repo 是公開的。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withAdded, type AddedDoc } from '../src/ai/added';
import { checkSample, judge, type CheckedPremise, type EvidencePack, type PackDoc } from '../src/ai/check';
import type { Attribution } from '../src/ai/detect';
import { OWN_DROP, OWN_DROP_PROMPT, dropDecision, ownDropPack } from '../src/ai/drops';
import { HARD_EVENT } from '../src/ai/events';
import { PAYLOAD_HOOKS } from '../src/ai/hooks';
import { OWN_REVIEW, OWN_REVIEW_PROMPT, ownReviewPack, reviewDecision } from '../src/ai/ownReview';
import { finalizeRun, getRun, type AiRun } from '../src/app/aiRuns';
import type { Env, Fetcher } from '../src/app/env';
import { runFlow } from '../src/app/flow';
import { LINE_PUSH_URL } from '../src/app/line';
import { loadAccount, saveAccount } from '../src/app/ledgerStore';
import { OPS_SECTIONS, type OpsReport, type Row } from '../src/app/opsReport';
import { startOwnReview } from '../src/app/ownAi';
import { downgradeNote, runDetail } from '../src/app/site/aiViews';
import { premiseCheckOf, thesisView, type PremiseCheck } from '../src/app/site/thesisView';
import { UNVERIFIED_AFTER, premiseStanding, thesisFile, unverifiedStreak, type ThesisFile, type ThesisPremise, type ThesisReview } from '../src/app/thesis';
import type { CompanyFacts, XbrlFact } from '../src/data/edgar';
import { buildMarketView } from '../src/data/marketView';
import { loadSeries } from '../src/data/store';
import { VERIFY_EVERY_DEFAULT, createAccount, type Account, type MarketView, type OwnMeta, type Premise } from '../src/engine';
import { handle } from '../src/index';
import { freshDb } from './helpers/d1';
import { cronTime, fakeFetcher, newWorld, type World } from './helpers/fakeSources';

const PROMPTS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'ai', 'prompts');
const readPrompt = (f: string) => readFileSync(join(PROMPTS, f), 'utf8');

// 前端不碰 DOM 的部分直接 import（同 t60 的寫法）
interface CheckJs {
  CHECK_TONE: Record<string, string>;
  premiseChecks(d: unknown): Record<string, { kind: string | null; text: string; why: string | null }>;
  premiseSummary(premises: unknown[], checks: unknown): { broken: string[]; judged: number; text: string | null };
}
const CJ = (await import('../public/js/premise-check.js' as string)) as CheckJs;

// ---------------------------------------------------------------- 假的世界（決策日 2026-11-19）

const AS_OF = '2026-11-19';

function quarterFacts(qs: { end: string; rev: number; filed: string }[]): CompanyFacts {
  const rev: XbrlFact[] = qs.map((q) => {
    const [y, m] = q.end.split('-').map(Number);
    return { start: `${y}-${String(m - 2).padStart(2, '0')}-01`, end: q.end, val: q.rev, accn: `acc-${q.filed}`, form: '10-Q', filed: q.filed };
  });
  return { cik: 1045810, facts: { 'us-gaap': { Revenues: { units: { USD: rev } } } } };
}
function fetcherOf(w: World): Fetcher {
  const base = fakeFetcher(w);
  return async (url, init) => {
    if (url === LINE_PUSH_URL) return Response.json({});
    if (url === 'https://api.example/fire') return Response.json({ claude_code_session_url: 'https://claude.ai/code/x' });
    if (/data\.sec\.gov\/submissions\/CIK\d+\.json/.test(url)) return Response.json({ cik: '1045810', name: 'NVIDIA CORP', tickers: ['NVDA'], filings: { recent: { accessionNumber: [], form: [], items: [], acceptanceDateTime: [], filingDate: [], primaryDocument: [] } } });
    // 最新一季的財報 2026-10-30 申報：財報表（XBRL）那一份原文的日期是決策日前 20 天
    if (/companyfacts\/CIK\d+\.json/.test(url)) return Response.json(quarterFacts([{ end: '2025-09-30', rev: 120, filed: '2025-11-01' }, { end: '2026-09-30', rev: 160, filed: '2026-10-30' }]));
    if (url.startsWith('https://www.nasdaq.com/feed/rssoutbound') || url.startsWith('https://feeds.finance.yahoo.com/rss/2.0/headline')) return new Response('<rss><channel></channel></rss>');
    return base(url, init);
  };
}

/** P1 每 91 天有新的財報；P2 的來源 30 天一份；P3 沒寫怎麼驗證（用 100 天）；P4 是信念（不進審查）。 */
const PREMISES: Premise[] = [
  { id: 'P1', text: '資料中心需求延續到 2027', origin: 'USER', breaksIf: ['連兩季營收年增率低於 15%', '公司下修全年營收財測'], confirmsIf: '10-Q 的營收年增率仍高於 30%', verify: { by: 'XBRL', source: 'SEC XBRL', every: 91 } },
  { id: 'P2', text: 'HBM 的合約價仍然逐季上漲', origin: 'USER', breaksIf: ['TrendForce 的新聞稿報 HBM 合約價季跌'], confirmsIf: 'TrendForce 最新一季的合約價預估仍是季漲', verify: { by: 'WEB', source: 'trendforce.com', every: 30 } },
  { id: 'P3', text: '毛利率維持在 55% 以上', origin: 'USER' },
  { id: 'P4', text: '大客戶的長約照約履行', origin: 'USER', verify: { by: 'NONE' } },
];

interface Ctx {
  db: D1Database;
  env: Env;
  fetcher: Fetcher;
  acct: Account;
  view: MarketView;
  axis: string[];
  api: <T = Record<string, unknown>>(method: 'GET' | 'POST', path: string, body?: unknown) => Promise<{ status: number; body: T }>;
}
async function openWorld(): Promise<{ c: Ctx; dispose: () => Promise<void> }> {
  const d = await freshDb();
  const db = d.db;
  const w = newWorld(AS_OF);
  const env: Env = { DB: db, ADMIN_TOKEN: 'admin-secret', AI_TASK_SECRET: 's', EDGAR_USER_AGENT: 'test bot test@example.com', SITE_URL: 'https://bot.example', DEV_NO_AUTH: '1', ROUTINE_FIRE_URL: 'https://api.example/fire', ROUTINE_TOKEN: 'rt' };
  const fetcher = fetcherOf(w);
  await runFlow(env, fetcher, { now: cronTime(AS_OF), attempt: 'FIRST' });
  const { view, axis } = buildMarketView(await loadSeries(db, ['VOO', 'SGOV', 'NVDA']), AS_OF, 'VOO');
  const acct = createAccount({ paper: true, cash: 5000, core: { VOO: Math.floor(140_000 / view.close.VOO[view.i]) }, own: { NVDA: { shares: Math.floor(40_000 / view.close.NVDA[view.i]), stdWeight: 0.15, premises: structuredClone(PREMISES) } } }, view);
  await saveAccount(db, acct, null, '建立帳戶', new Date('2026-11-19T12:00:00Z'));
  const api: Ctx['api'] = async (method, path, body) => {
    const r = await handle(new Request(`https://bot.example/api/${path}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env, fetcher, new Date('2026-11-20T02:00:00Z'));
    return { status: r.status, body: (await r.json()) as never };
  };
  return { c: { db, env, fetcher, acct, view, axis, api }, dispose: () => d.dispose() };
}

// ---------------------------------------------------------------- 證據包的文件（直接組，不經過抓取）

const Q_REV = 'Revenue for the third quarter was $160 million, up 33% from a year ago';
const Q_GM = 'Gross margin was 60.0%, down from 70.0% a year ago';
const Q_TOP = 'The agreements with our strategic customers are structured as take-or-pay contracts';
const T_UP = 'HBM contract prices are expected to rise 8% quarter over quarter';
/** 最近一份 10-Q：決策日前 20 天。 */
const TENQ: PackDoc = { id: 'D1', source_id: 'edgar:q3', kind: 'filing', date: '2026-10-30', title: '10-Q 2026-10-30：MD&A', text: `${Q_REV}. ${Q_GM}. ${Q_TOP}.` };
/** 上一年的 10-K：決策日前 270 天。 */
const OLD_K: PackDoc = { id: 'D2', source_id: 'edgar:k', kind: 'filing', date: '2026-02-22', title: '10-K 2026-02-22：MD&A', text: 'Demand for our data center products exceeded supply throughout the fiscal year.' };
const Q_OLD = 'Demand for our data center products exceeded supply throughout the fiscal year';
const NEWS: PackDoc = { id: 'N-NVDA', source_id: 'yahoo-rss:NVDA', kind: 'news', date: '2026-11-18', title: 'NVDA 最近的新聞標題（Yahoo，只有標題）', text: '2026-11-18 | HBM contract prices keep rising as AI demand stays strong' };
const Q_NEWS = 'HBM contract prices keep rising as AI demand stays strong';
const NOTE: PackDoc = { id: 'T-NVDA', source_id: 'thesis:NVDA@2026-10-01', kind: 'note', date: AS_OF, title: 'NVDA 的論點檔（背景，不是前提成立的證據）', text: '上次審查（2026-10-20）：P1 成立、P2 成立、P3 成立。使用者的回應：沒有。' };
const Q_NOTE = '上次審查（2026-10-20）：P1 成立、P2 成立、P3 成立';

let seq = 0;
function web(o: Pick<AddedDoc, 'source_id' | 'date' | 'text'>): AddedDoc {
  return { id: `A${++seq}`, kind: 'web', tier: 'NAMED', domain: 'trendforce.com', label: 'TrendForce', title: '〔網頁｜指名的產業來源｜TrendForce〕', url: 'https://www.trendforce.com/presscenter/news/x.html', truncated: false, fetched_at: '2026-11-20T01:05:00.000Z', via: 'SEARCH', menu: null, for: 'P2', why: '查證', role: '分析師', at: '2026-11-20T01:05:00.000Z', row_id: seq, ...o };
}
/** TrendForce 的兩份新聞稿：一份 8 天前、一份 51 天前（P2 的驗證頻率是 30 天）。 */
const TF_NEW = web({ source_id: 'web:tfnew00000000001', date: '2026-11-11', text: `TrendForce says ${T_UP} in the first quarter of 2027.` });
const TF_OLD = web({ source_id: 'web:tfold00000000001', date: '2026-09-29', text: `TrendForce says ${T_UP} in the fourth quarter of 2026.` });

type Cite = { source_id: string; date: string };
const E = (id: string, doc: Cite, quote: string, date = doc.date) => ({ id, source_id: doc.source_id, date, quote, claim: '測試' });
type Check = { premise_id: string; status: string; evidence_ids: string[]; confirm_ids?: string[] };
const vote = (pack: EvidencePack, verdict: string, premise_checks: Check[], evidence: unknown[], payload: Record<string, unknown> = {}) => ({ run_id: pack.run_id, verdict, premise_checks, evidence, payload: { tier: verdict, condition_checks: [], proposed_conditions: [], ...payload }, report: '測試' });
const three = <T>(v: T) => [v, v, v];
const HOOK = PAYLOAD_HOOKS[OWN_REVIEW];
const EV = [E('E1', TENQ, Q_REV), E('E2', TENQ, Q_GM), E('E3', TENQ, Q_TOP), E('E4', TF_NEW, T_UP), E('E5', TF_OLD, T_UP), E('E6', OLD_K, Q_OLD), E('E7', NEWS, Q_NEWS), E('E8', NOTE, Q_NOTE)];

describe('T61 判「成立」要有正面的引用（composite_layer_design §2.1）', () => {
  let w: Awaited<ReturnType<typeof openWorld>>;
  beforeAll(async () => {
    w = await openWorld();
  });
  afterAll(() => w.dispose());

  const reviewPack = (acct: Account = w.c.acct, added: AddedDoc[] = [TF_NEW, TF_OLD]): EvidencePack => {
    const { pack } = ownReviewPack({ acct, view: w.c.view, axis: w.c.axis, ticker: 'NVDA', runId: `rev-${++seq}`, trigger: 'MONTHLY', xbrl: null, filings: [TENQ, OLD_K], news: NEWS, extraDocs: [NOTE], dataQuality: { filings: 'ok' }, now: new Date('2026-11-20T01:00:00Z') });
    return withAdded(pack, added);
  };
  /** 一票只判一條前提（另外兩條寫證據不足），回傳程式檢查之後那一條的結果。 */
  const one = (pack: EvidencePack, c: Check, evidence: unknown[] = EV): { p: CheckedPremise; issues: string[] } => {
    const s = checkSample(pack, vote(pack, 'HOLD', [c], evidence), 0, PAYLOAD_HOOKS[pack.function]);
    expect(s.valid).toBe(true);
    return { p: s.premises[0], issues: s.issues };
  };

  // ------------------------------------------------------------ 1 prompt 升版

  it('prompt 升成 own_review_v4、own_drop_v4：§2.1 的表、confirm_ids、逾期、breaksIf 任一句成立就算；v3 開頭標「不再使用（2026-11-21）」；v3 的內容 v4 照樣有', () => {
    expect([OWN_REVIEW_PROMPT, OWN_DROP_PROMPT]).toEqual(['own_review_v5', 'own_drop_v5']);
    for (const [cur, old] of [['own_review_v4.md', 'own_review_v3.md'], ['own_drop_v4.md', 'own_drop_v3.md']]) {
      const v4 = readPrompt(cur);
      // §2.1 的表：四種情況
      expect(v4, cur).toContain('**什麼時候可以判 `HOLDS`（成立）**——要有正面的引用，不是「沒有反證」');
      expect(v4, cur).toContain('有引用**直接顯示前提說的事現在是真的**');
      expect(v4, cur).toContain('只有「沒有看到相反的揭露」');
      expect(v4, cur).toContain('引用只說明事情的**結構**');
      expect(v4, cur).toContain('正面的引用比這條前提的驗證頻率還舊 | `INSUFFICIENT`，在 `report` 寫「逾期」');
      // 票要指出哪一條引用是正面的；程式核對日期
      expect(v4, cur).toContain('"confirm_ids": ["E2"]');
      expect(v4, cur).toContain('判 `HOLDS` 時一定要寫');
      expect(v4, cur).toContain('**程式會用原文的日期核對**');
      expect(v4, cur).toContain('驗證頻率是這條前提的 `verify.every`，沒寫是 100 天');
      // T60 的三個欄位；多句的 breaksIf 是「任一句成立就算」，逐句回答
      expect(v4, cur).toContain('**任何一句成立，這條前提就算不成立**');
      expect(v4, cur).toContain('**`breaksIf` 逐句回答**：每一句各自判「成立／沒有成立／沒有資料」');
      expect(v4, cur).toContain('`confirmsIf`（可能沒有）');
      expect(v4, cur).toContain('信念）不在 `premises` 裡');
      // 判不成立的來源規則、取文件的做法沒有動
      expect(v4, cur).toContain('**兩個不同網域**');
      expect(v4, cur).toContain('**只有分析師可以用 WebSearch、可以取文件。**');
      expect(v4, cur).toContain('"lookups": {');
      // 舊檔留著、開頭標不再使用
      const head = readPrompt(old).split('\n')[0];
      expect(head, old).toContain(`不再使用（2026-11-21）：T61 起改用 \`${cur}\``);
      expect(readPrompt(old), old).toContain(`# ${old.replace('.md', '')}：`);
    }
    expect(readPrompt('own_review_v4.md')).toContain('**往上的檔位（`STANDARD`、`RAISE`）不能只靠網頁**');
    expect(readPrompt('own_drop_v4.md')).toContain('**大部分前提會是 `INSUFFICIENT`，這是正常的**');
    // own_check_v5、own_draft_v2 指到 own_review_v3.md 的章節：v3 的檔案還在，章節沒有改名
    expect(readPrompt('own_review_v3.md')).toContain('## 送回的結果');
  });

  it('審查與減半檢視的證據包：prompt_version 是 v4、policy.holds_fresh_days = 100；前提帶 breaksIf、confirmsIf、verify，信念不在裡面', () => {
    const rev = reviewPack(w.c.acct, []);
    expect(rev.prompt_version).toBe('own_review_v5');
    expect(rev.policy.holds_fresh_days).toBe(100);
    expect(VERIFY_EVERY_DEFAULT).toBe(100);
    expect(rev.premises.map((p) => [p.id, p.breaksIf?.length ?? 0, p.confirmsIf ?? null, p.verify?.every ?? null])).toEqual([
      ['P1', 2, '10-Q 的營收年增率仍高於 30%', 91],
      ['P2', 1, 'TrendForce 最新一季的合約價預估仍是季漲', 30],
      ['P3', 0, null, null],
    ]);
    const drop = ownDropPack({ acct: w.c.acct, view: w.c.view, axis: w.c.axis, ticker: 'NVDA', runId: 'drop-1', attr: null, base: null, baseRunId: null, docs: [TENQ], urgent: false, dataQuality: { filings: 'ok' }, now: new Date('2026-11-20T01:00:00Z') }).pack;
    expect(drop.prompt_version).toBe('own_drop_v5');
    expect(drop.policy.holds_fresh_days).toBe(100);
    expect(drop.premises.map((p) => p.id)).toEqual(['P1', 'P2', 'P3']);
  });

  // ------------------------------------------------------------ 2 日期核對

  it('有正面的引用、原文在驗證頻率以內 → 成立照舊，記下 confirm_ids；不成立、證據不足的判斷不受影響', () => {
    const pack = reviewPack();
    expect(one(pack, { premise_id: 'P1', status: 'HOLDS', evidence_ids: ['E1', 'E3'], confirm_ids: ['E1'] })).toEqual({ p: { premise_id: 'P1', status: 'HOLDS', evidence_ids: ['E1', 'E3'], confirm_ids: ['E1'] }, issues: [] });
    expect(one(pack, { premise_id: 'P2', status: 'HOLDS', evidence_ids: ['E4'], confirm_ids: ['E4'] }).p).toMatchObject({ status: 'HOLDS', confirm_ids: ['E4'] });
    // 不成立、證據不足不用 confirm_ids，也不核對日期（引用再舊也照舊）
    expect(one(pack, { premise_id: 'P2', status: 'BROKEN', evidence_ids: ['E5'] }).p).toEqual({ premise_id: 'P2', status: 'BROKEN', evidence_ids: ['E5'] });
    expect(one(pack, { premise_id: 'P3', status: 'INSUFFICIENT', evidence_ids: [] }).p).toEqual({ premise_id: 'P3', status: 'INSUFFICIENT', evidence_ids: [] });
  });

  it('正面的引用比驗證頻率還舊 → 這一票的這一條降成證據不足、標逾期（verify.every；沒寫用 100 天）', () => {
    const pack = reviewPack();
    // P2 的驗證頻率 30 天：2026-09-29 的新聞稿（51 天前）逾期
    const p2 = one(pack, { premise_id: 'P2', status: 'HOLDS', evidence_ids: ['E5'], confirm_ids: ['E5'] });
    expect(p2.p).toEqual({ premise_id: 'P2', status: 'INSUFFICIENT', evidence_ids: ['E5'], downgradedFrom: 'HOLDS', holdsIssue: { why: 'STALE', latest: '2026-09-29', days: 30 } });
    expect(p2.issues).toEqual(['前提 P2 判成立，但正面的引用裡最新一份原文是 2026-09-29，比決策日 2026-11-19 減驗證頻率 30 天還舊（逾期），這一條改成證據不足']);
    // 同一份 51 天前的原文，P3 沒寫驗證頻率（100 天）就不算逾期；270 天前的 10-K 才算
    expect(one(pack, { premise_id: 'P3', status: 'HOLDS', evidence_ids: ['E5'], confirm_ids: ['E5'] }).p.status).toBe('HOLDS');
    expect(one(pack, { premise_id: 'P3', status: 'HOLDS', evidence_ids: ['E6'], confirm_ids: ['E6'] }).p).toMatchObject({ status: 'INSUFFICIENT', downgradedFrom: 'HOLDS', holdsIssue: { why: 'STALE', latest: '2026-02-22', days: 100 } });
    // P1 的驗證頻率 91 天：20 天前的 10-Q 可以，270 天前的 10-K 逾期
    expect(one(pack, { premise_id: 'P1', status: 'HOLDS', evidence_ids: ['E6'], confirm_ids: ['E6'] }).p.holdsIssue).toEqual({ why: 'STALE', latest: '2026-02-22', days: 91 });
  });

  it('看的是正面的引用裡「最新一份」的日期：新舊各一份 → 可以；正面的只有舊的那份、新的只是背景 → 逾期', () => {
    const pack = reviewPack();
    expect(one(pack, { premise_id: 'P2', status: 'HOLDS', evidence_ids: ['E4', 'E5'], confirm_ids: ['E5', 'E4'] }).p).toMatchObject({ status: 'HOLDS', confirm_ids: ['E5', 'E4'] });
    // 10-Q 那一句只說明合約的結構（放在 evidence_ids、不在 confirm_ids）：救不了逾期的正面引用
    expect(one(pack, { premise_id: 'P2', status: 'HOLDS', evidence_ids: ['E3', 'E5'], confirm_ids: ['E5'] }).p).toMatchObject({ status: 'INSUFFICIENT', evidence_ids: ['E3', 'E5'], holdsIssue: { why: 'STALE', latest: '2026-09-29', days: 30 } });
  });

  it('剛好等於驗證頻率的那一天不算逾期，多一天才算', () => {
    const at = (date: string) => {
      const d: PackDoc = { ...TENQ, source_id: `edgar:${date}`, id: `D-${date}`, date };
      const { pack } = ownReviewPack({ acct: w.c.acct, view: w.c.view, axis: w.c.axis, ticker: 'NVDA', runId: `rev-${++seq}`, trigger: 'MONTHLY', xbrl: null, filings: [d], news: null, dataQuality: { filings: 'ok' }, now: new Date('2026-11-20T01:00:00Z') });
      return one(pack, { premise_id: 'P1', status: 'HOLDS', evidence_ids: ['E1'], confirm_ids: ['E1'] }, [E('E1', d, Q_REV)]).p;
    };
    // 2026-11-19 往前 91 天是 2026-08-20
    expect(at('2026-08-20').status).toBe('HOLDS');
    expect(at('2026-08-19')).toMatchObject({ status: 'INSUFFICIENT', holdsIssue: { why: 'STALE', latest: '2026-08-19', days: 91 } });
  });

  it('用的是原文的日期（程式記的），不是 AI 在引用裡寫的日期', () => {
    const pack = reviewPack();
    // AI 把 2026-09-29 的新聞稿寫成 2026-11-18：照樣逾期
    expect(one(pack, { premise_id: 'P2', status: 'HOLDS', evidence_ids: ['E5'], confirm_ids: ['E5'] }, [E('E5', TF_OLD, T_UP, '2026-11-18')]).p.holdsIssue).toEqual({ why: 'STALE', latest: '2026-09-29', days: 30 });
  });

  it('沒有指出正面的引用（沒寫 confirm_ids、寫了空的、指到沒有的編號）→ 降成證據不足；背景（論點 note）與新聞標題不能當正面的引用', () => {
    const pack = reviewPack();
    const none = one(pack, { premise_id: 'P1', status: 'HOLDS', evidence_ids: ['E1'] });
    expect(none.p).toEqual({ premise_id: 'P1', status: 'INSUFFICIENT', evidence_ids: ['E1'], downgradedFrom: 'HOLDS', holdsIssue: { why: 'NO_CONFIRM' } });
    expect(none.issues).toEqual(['前提 P1 判成立，但沒有指出哪一條引用正面顯示它成立（要通過逐字檢查、出自原文，不是背景或新聞標題），這一條改成證據不足']);
    expect(one(pack, { premise_id: 'P1', status: 'HOLDS', evidence_ids: ['E1'], confirm_ids: [] }).p.holdsIssue).toEqual({ why: 'NO_CONFIRM' });
    expect(one(pack, { premise_id: 'P1', status: 'HOLDS', evidence_ids: ['E1'], confirm_ids: ['E99'] }).p.holdsIssue).toEqual({ why: 'NO_CONFIRM' });
    // 新聞標題（日期是昨天）、論點那一份 note（日期是今天）：日期再新也不算
    expect(one(pack, { premise_id: 'P2', status: 'HOLDS', evidence_ids: ['E7'], confirm_ids: ['E7'] }).p.holdsIssue).toEqual({ why: 'NO_CONFIRM' });
    expect(one(pack, { premise_id: 'P1', status: 'HOLDS', evidence_ids: ['E8'], confirm_ids: ['E8'] }).p.holdsIssue).toEqual({ why: 'NO_CONFIRM' });
    // 標題加一份逾期的原文：看原文的日期 → 逾期
    expect(one(pack, { premise_id: 'P2', status: 'HOLDS', evidence_ids: ['E5', 'E7'], confirm_ids: ['E5', 'E7'] }).p.holdsIssue).toEqual({ why: 'STALE', latest: '2026-09-29', days: 30 });
  });

  it('沒設 holds_fresh_days 的證據包（其他功能、T61 之前開的執行）不核對：成立照舊', () => {
    const pack = reviewPack();
    const old: EvidencePack = { ...pack, prompt_version: 'own_review_v3', policy: { level: 'A3', verdicts: pack.policy.verdicts, abstain: 'HOLD', min_evidence: 1, samples: 3 } };
    expect(one(old, { premise_id: 'P2', status: 'HOLDS', evidence_ids: ['E5'] }).p).toEqual({ premise_id: 'P2', status: 'HOLDS', evidence_ids: ['E5'] });
    const court: EvidencePack = { ...old, function: HARD_EVENT, policy: { level: 'A3', verdicts: ['EXIT', 'HOLD'], abstain: 'HOLD', min_evidence: 1, samples: 3 } };
    const s = checkSample(court, { verdict: 'HOLD', premise_checks: [{ premise_id: 'P2', status: 'HOLDS', evidence_ids: ['E5'] }], evidence: EV, report: '測試' }, 0);
    expect(s.premises).toEqual([{ premise_id: 'P2', status: 'HOLDS', evidence_ids: ['E5'] }]);
  });

  // ------------------------------------------------------------ 3 逐字引用檢查沒有放寬

  it('逐字引用檢查沒有放寬：改寫過的引用照樣被刪；confirm_ids 指到被刪的引用不算正面的引用', () => {
    const pack = reviewPack();
    const para = { id: 'E4', source_id: TF_NEW.source_id, date: TF_NEW.date, quote: 'HBM contract prices will rise about 8% next quarter', claim: '改寫過的' };
    const s = checkSample(pack, vote(pack, 'HOLD', [{ premise_id: 'P2', status: 'HOLDS', evidence_ids: ['E4'], confirm_ids: ['E4'] }, { premise_id: 'P1', status: 'HOLDS', evidence_ids: ['E1', 'E4'], confirm_ids: ['E4'] }], [E('E1', TENQ, Q_REV), para]), 0, HOOK);
    expect(s.evidence.find((e) => e.id === 'E4')).toMatchObject({ ok: false, why: '引用不是原文的子字串' });
    // P2 只有那一條 → 照舊「引用被刪」的降級；P1 另有通過的引用，但指出的正面引用被刪了 → 沒有正面的引用
    expect(s.premises).toEqual([
      { premise_id: 'P2', status: 'INSUFFICIENT', evidence_ids: [], downgradedFrom: 'HOLDS' },
      { premise_id: 'P1', status: 'INSUFFICIENT', evidence_ids: ['E1'], downgradedFrom: 'HOLDS', holdsIssue: { why: 'NO_CONFIRM' } },
    ]);
  });

  // ------------------------------------------------------------ 4 證據不足的後果不變

  it('往上的檔位更少：提高到 125% 要每條前提都成立，有一條逾期或沒指出正面的引用就不列', () => {
    const ok = structuredClone(w.c.acct);
    ok.own.NVDA.slow.aboveRun = 130;
    const pack = reviewPack(ok);
    expect(pack.policy.verdicts).toContain('RAISE');
    const run = (p2: Check) => reviewDecision(judge(pack, three(vote(pack, 'RAISE', [{ premise_id: 'P1', status: 'HOLDS', evidence_ids: ['E1'], confirm_ids: ['E1'] }, p2, { premise_id: 'P3', status: 'HOLDS', evidence_ids: ['E2'], confirm_ids: ['E2'] }], EV)), HOOK), ok, 'NVDA', AS_OF, pack);
    // 三條都有沒逾期的正面引用（P2 另附申報的引用：往上的檔位不能只靠網頁，T53）
    expect(run({ premise_id: 'P2', status: 'HOLDS', evidence_ids: ['E4', 'E2'], confirm_ids: ['E4', 'E2'] })).toMatchObject({ tier: 'RAISE', suggest: true });
    const stale = run({ premise_id: 'P2', status: 'HOLDS', evidence_ids: ['E5', 'E2'], confirm_ids: ['E5'] });
    expect(stale).toMatchObject({ tier: 'RAISE', suggest: false, why: '要提高到 125%，前提要全部成立。' });
    expect(run({ premise_id: 'P2', status: 'HOLDS', evidence_ids: ['E4', 'E2'] })).toMatchObject({ suggest: false });
  });

  it('證據不足不發通知、不動檔位：三票選不動、成立的都被降成證據不足 → 沒有建議、沒有不成立的前提，結論照舊是三票一致的不動', () => {
    const pack = reviewPack();
    const outcome = judge(pack, three(vote(pack, 'HOLD', [{ premise_id: 'P1', status: 'HOLDS', evidence_ids: ['E3'] }, { premise_id: 'P2', status: 'HOLDS', evidence_ids: ['E5'], confirm_ids: ['E5'] }, { premise_id: 'P3', status: 'INSUFFICIENT', evidence_ids: [] }], EV)), HOOK);
    expect(outcome.samples.map((s) => s.premises.map((p) => p.status))).toEqual(three(['INSUFFICIENT', 'INSUFFICIENT', 'INSUFFICIENT']));
    // 這一票的檔位沒有被降級（降的只有那幾條前提）
    expect(outcome).toMatchObject({ status: 'INSUFFICIENT', verdict: 'HOLD', followRule: true, reason: '3 票一致：HOLD（維持現狀，照規則）。' });
    expect(reviewDecision(outcome, w.c.acct, 'NVDA', AS_OF, pack)).toMatchObject({ tier: 'HOLD', suggest: false, consensus: true, brokenPremises: [], premiseId: null });
  });

  it('減半檢視：成立被降成證據不足不影響「不動」（只要求沒有前提被判不成立）；出清照舊要三票判同一條不成立', () => {
    const attr: Attribution = { from: '2026-09-01', to: AS_OF, stock: -0.25, market: -0.2, sector: -0.02, idio: -0.03, sectorTicker: 'SMH' };
    const { pack: base } = ownDropPack({ acct: w.c.acct, view: w.c.view, axis: w.c.axis, ticker: 'NVDA', runId: 'drop-2', attr, base: null, baseRunId: null, docs: [TENQ, OLD_K], urgent: false, dataQuality: { filings: 'ok' }, extraDocs: [NOTE], now: new Date('2026-11-20T01:00:00Z') });
    const pack = withAdded(base, [TF_OLD]);
    const hold = { verdict: 'HOLD', premise_checks: [{ premise_id: 'P2', status: 'HOLDS', evidence_ids: ['E5'], confirm_ids: ['E5'] }, { premise_id: 'P1', status: 'HOLDS', evidence_ids: ['E8'], confirm_ids: ['E8'] }], evidence: EV, payload: { tier: 'HOLD', cause_class: 'MARKET' }, report: '大盤一起跌。' };
    const outcome = judge(pack, three(hold), PAYLOAD_HOOKS[OWN_DROP]);
    expect(outcome.samples[0].premises.map((p) => [p.premise_id, p.status, p.holdsIssue?.why])).toEqual([['P2', 'INSUFFICIENT', 'STALE'], ['P1', 'INSUFFICIENT', 'NO_CONFIRM']]);
    expect(dropDecision(outcome, pack)).toMatchObject({ status: 'HOLD', cause: 'MARKET' });
    const exit = { verdict: 'EXIT', premise_checks: [{ premise_id: 'P2', status: 'BROKEN', evidence_ids: ['E5'] }], evidence: EV, payload: { tier: 'EXIT', cause_class: 'FUNDAMENTAL' }, report: '測試' };
    expect(dropDecision(judge(pack, three(exit), PAYLOAD_HOOKS[OWN_DROP]), pack)).toMatchObject({ status: 'EXIT', premiseId: 'P2' });
  });

  // ------------------------------------------------------------ 6 審查紀錄頁

  it('審查紀錄頁：被改成證據不足的那一票寫原因（逾期／沒有指出正面的引用／引用被刪）；日期與驗證頻率在「程式檢查發現」', () => {
    const pack = reviewPack();
    const para = { id: 'E9', source_id: TENQ.source_id, date: TENQ.date, quote: 'Gross margin stayed around sixty percent', claim: '改寫過的' };
    const v = vote(pack, 'HOLD', [{ premise_id: 'P1', status: 'HOLDS', evidence_ids: ['E1'] }, { premise_id: 'P2', status: 'HOLDS', evidence_ids: ['E5'], confirm_ids: ['E5'] }, { premise_id: 'P3', status: 'HOLDS', evidence_ids: ['E9'], confirm_ids: ['E9'] }], [...EV, para]);
    const outcome = judge(pack, three(v), HOOK);
    const d = runDetail({ runId: pack.run_id, fn: OWN_REVIEW, ticker: 'NVDA', asOf: AS_OF, createdAt: '2026-11-20T01:00:00.000Z', status: 'DONE', taskId: null, promptVersion: pack.prompt_version, packHash: 'sha256:0000000000000000', pack, packNotes: [], outcome, process: [], completedAt: null, repoCommit: null } as unknown as AiRun);
    expect(d.premises.map((p) => [p.id, p.votes[0].label, p.votes[0].downgraded, p.votes[0].note])).toEqual([
      ['P1', '證據不足', true, '原本判成立，沒有指出正面的引用'],
      ['P2', '證據不足', true, '原本判成立，引用逾期'],
      ['P3', '證據不足', true, '引用被刪'],
    ]);
    expect(d.samples[0].issues.join('\n')).toContain('最新一份原文是 2026-09-29，比決策日 2026-11-19 減驗證頻率 30 天還舊（逾期）');
    expect(downgradeNote({})).toBeNull();
  });
});

// ---------------------------------------------------------------- 5 持股頁的四種寫法

const H3 = ['HOLDS', 'HOLDS', 'HOLDS'];
const B3 = ['BROKEN', 'BROKEN', 'BROKEN'];
const I3 = ['INSUFFICIENT', 'INSUFFICIENT', 'INSUFFICIENT'];
const SPLIT = ['HOLDS', 'HOLDS', 'INSUFFICIENT'];
function prem(id: string, extra: Partial<ThesisPremise> = {}): ThesisPremise {
  return { id, text: `前提 ${id}`, origin: 'USER', addedAt: '2026-01-02', lastCheck: null, splitAfter: false, ...extra };
}
function fileOf(o: Partial<ThesisFile> = {}): ThesisFile {
  return { ticker: 'MU', fileId: 'MU@2026-01-02', openedAt: '2026-01-02', origin: 'NEW', kind: 'THESIS', status: 'OPEN', thesis: null, premises: [prem('P4')], conditions: [], events: [], reviews: [], disputes: [], flags: [], lastReview: null, newSince: '2025-09-01', log: [], ...o };
}
function rv(runId: string, date: string, votes: Record<string, string[]>, o: Partial<ThesisReview> = {}): ThesisReview {
  return { runId, date, fn: 'OWN_REVIEW', label: '定期審查', trigger: 'MONTHLY', status: 'AGREED', verdict: 'HOLD', votes: { HOLD: 3 }, brokenPremises: [], notif: null, response: null, premiseVotes: votes, summary: null, ...o };
}
const metaOf = (): OwnMeta => ({ premises: [], flags: [] }) as unknown as OwnMeta;
const checkOf = (reviews: ThesisReview[], o: Partial<ThesisFile> = {}, id = 'P4'): PremiseCheck => thesisView(fileOf({ reviews, ...o }), metaOf(), { notifs: [] }, '2026-11-30').premiseChecks[id];

describe('T61 持股頁每條前提最近一次的結果：四種寫法（§2.1 的「顯示」），由歷次定期審查算', () => {
  it('① 最近一次 3 票都判成立 →「11/20 證實」', () => {
    const reviews = [rv('r2', '2026-11-20', { P4: H3 }), rv('r1', '2026-10-31', { P4: I3 })];
    expect(premiseStanding(fileOf({ reviews }), 'P4')).toEqual({ runId: 'r2', date: '2026-11-20', result: 'HOLDS', votes: H3, stale: 0, missed: 0, prior: null });
    expect(checkOf(reviews)).toEqual({ kind: 'CONFIRMED', text: '11/20 證實', why: '3 票都判成立' });
  });

  it('② 最近一次 3 票都判不成立 →「11/20 被判不成立」', () => {
    expect(checkOf([rv('r2', '2026-11-20', { P4: B3 }), rv('r1', '2026-10-31', { P4: H3 })])).toEqual({ kind: 'BROKEN', text: '11/20 被判不成立', why: '3 票都判不成立' });
  });

  it('③ 最近一次是證據不足或票數不一致 →「這次沒驗到（上次證實 9/30）」；理由寫哪一次審查、三票怎麼判', () => {
    const insuf = [rv('r3', '2026-11-20', { P4: I3 }), rv('r2', '2026-09-30', { P4: H3 }), rv('r1', '2026-08-29', { P4: I3 })];
    expect(premiseStanding(fileOf({ reviews: insuf }), 'P4')).toMatchObject({ result: 'UNVERIFIED', missed: 1, prior: { result: 'HOLDS', date: '2026-09-30' } });
    expect(checkOf(insuf)).toEqual({ kind: 'MISSED', text: '這次沒驗到（上次證實 9/30）', why: '11/20 審查：3 票都判證據不足' });
    // 票數不一致也算沒驗到；連續 2 次還是這一種寫法
    const split = [rv('r3', '2026-11-20', { P4: SPLIT }), rv('r2', '2026-10-31', { P4: I3 }), rv('r1', '2026-09-30', { P4: H3 })];
    expect(checkOf(split)).toEqual({ kind: 'MISSED', text: '這次沒驗到（上次證實 9/30）', why: '11/20 審查：三票不一致（2 票成立、1 票證據不足）' });
    // 沒有證實過；上一次有結論的是被判不成立（照實寫，不寫更早那次的證實）
    expect(checkOf([rv('r1', '2026-11-20', { P4: I3 })]).text).toBe('這次沒驗到（還沒有證實過）');
    expect(checkOf([rv('r3', '2026-11-20', { P4: I3 }), rv('r2', '2026-10-31', { P4: B3 }), rv('r1', '2026-09-30', { P4: H3 })]).text).toBe('這次沒驗到（上次 10/31 被判不成立）');
    // 只有 2 票合格
    expect(checkOf([rv('r1', '2026-11-20', { P4: ['HOLDS', 'HOLDS'] })]).why).toBe('11/20 審查：只有 2 票成立，其他票不合格');
  });

  it('③ 沒驗到是因為逾期：理由寫幾票原本判成立、引用比這一條的驗證頻率還舊', () => {
    const reviews = [rv('r2', '2026-11-20', { P4: I3 }, { premiseStale: { P4: 2 } }), rv('r1', '2026-09-30', { P4: H3 })];
    const file = fileOf({ reviews, premises: [prem('P4', { verify: { by: 'WEB', source: 'trendforce.com', every: 30 } })] });
    expect(premiseStanding(file, 'P4')?.stale).toBe(2);
    expect(thesisView(file, metaOf(), { notifs: [] }, '2026-11-30').premiseChecks.P4).toEqual({ kind: 'MISSED', text: '這次沒驗到（上次證實 9/30）', why: '11/20 審查：3 票都判證據不足；其中 2 票原本判成立，但引用的原文比這一條的驗證頻率（30 天）還舊，算逾期' });
    // 沒寫驗證頻率的前提：100 天
    expect(checkOf(reviews).why).toContain('驗證頻率（100 天）');
  });

  it('④ 連續 3 次沒驗到 →「已經 3 次沒驗到」（和「要看的事」同一個門檻、同一種算法）', () => {
    const reviews = [rv('r4', '2026-11-28', { P4: I3 }), rv('r3', '2026-10-31', { P4: SPLIT }), rv('r2', '2026-09-30', { P4: I3 }), rv('r1', '2026-08-29', { P4: H3 })];
    const file = fileOf({ reviews });
    expect(UNVERIFIED_AFTER).toBe(3);
    expect(premiseStanding(file, 'P4')?.missed).toBe(unverifiedStreak(file, 'P4').count);
    expect(checkOf(reviews)).toEqual({ kind: 'MISSED_MANY', text: '已經 3 次沒驗到', why: '最近一次是 11/28 審查：3 票都判證據不足。上次證實 8/29' });
    const four = [rv('r5', '2026-12-30', { P4: I3 }), ...reviews.slice(0, 3)];
    expect(checkOf(four)).toMatchObject({ kind: 'MISSED_MANY', text: '已經 4 次沒驗到' });
    expect(checkOf(four).why).toContain('還沒有證實過');
  });

  it('不是新的判定值，只看定期審查：減半檢視、逾時（沒有票）不算；前提的字改過以前的審查不算；信念、沒審過的沒有結果', () => {
    // 減半檢視判不成立、逾時的那次沒有票：最近一次的結果還是 10/31 的證實
    const reviews = [rv('d1', '2026-11-25', { P4: B3 }, { fn: 'OWN_DROP' }), rv('r2', '2026-11-20', {}, { status: 'TIMEOUT' }), rv('r1', '2026-10-31', { P4: H3 })];
    expect(checkOf(reviews).text).toBe('10/31 證實');
    // 11/10 改了字：10/31 的證實看的是舊的字 → 還沒有檢查過；只改標點不算改
    const log = (after: string) => [{ id: 1, kind: 'THESIS', session: '2026-11-10', at: '2026-11-10T01:00:00Z', ref: null, body: { before: { premises: [{ id: 'P4', text: '前提 P4' }] }, after: { premises: [{ id: 'P4', text: after }] } }, accountVersion: null }];
    expect(checkOf([rv('r1', '2026-10-31', { P4: H3 })], { log: log('前提 P4 到 2027 年') })).toEqual({ kind: null, text: '還沒有檢查過', why: null });
    expect(checkOf([rv('r1', '2026-10-31', { P4: H3 })], { log: log('前提 P4。') }).kind).toBe('CONFIRMED');
    // 信念不進審查：就算以前（還不是信念時）被審過，也不顯示結果
    expect(checkOf([rv('r1', '2026-10-31', { P4: H3 })], { premises: [prem('P4', { verify: { by: 'NONE' } })] }).kind).toBeNull();
    expect(premiseStanding(fileOf(), 'P4')).toBeNull();
    expect(premiseCheckOf(null, 100, true)).toEqual({ kind: null, text: '示範資料沒有審查紀錄', why: null });
  });

  it('畫面：四種寫法各自的顏色；史萊姆那一句照結果數（沒驗到和被判不成立分開，信念不算）；示範模式從示範的審查補上', () => {
    expect(CJ.CHECK_TONE).toEqual({ CONFIRMED: 'HOLDS', BROKEN: 'BROKEN', MISSED: 'INSUFFICIENT', MISSED_MANY: 'INSUFFICIENT' });
    const ps = [{ id: 'P4' }, { id: 'P5' }, { id: 'P6' }, { id: 'P7' }, { id: 'P8', belief: true }];
    const checks = { P4: { kind: 'CONFIRMED' }, P5: { kind: 'MISSED' }, P6: { kind: 'MISSED_MANY' }, P7: { kind: null } };
    expect(CJ.premiseSummary(ps, checks)).toEqual({ broken: [], judged: 4, text: '你的 4 條前提：1 條證實、2 條這次沒驗到、1 條還沒檢查' });
    expect(CJ.premiseSummary(ps.slice(0, 1), checks).text).toBe('你的 1 條前提最近一次審查都證實');
    expect(CJ.premiseSummary(ps, {}).text).toBe('你的 4 條前提還沒有被 AI 審查過');
    expect(CJ.premiseSummary(ps, { ...checks, P7: { kind: 'BROKEN' } })).toMatchObject({ broken: ['P7'] });
    expect(CJ.premiseSummary([{ id: 'P8', belief: true }], {})).toEqual({ broken: [], judged: 0, text: null });
    // 示範模式（論點檔沒有審查紀錄）：從持股頁下面那次示範的審查補
    const demo = { thesis: { premiseChecks: { P1: { kind: null, text: '示範資料沒有審查紀錄', why: null } } }, own: { premises: [{ id: 'P1', text: '需求延續' }, { id: 'P2', text: '毛利率' }, { id: 'P3', text: '長約', belief: true }] }, ai: { date: '2026-11-20', premises: [{ text: '需求延續', status: 'HOLDS' }, { text: '毛利率', status: 'INSUFFICIENT' }, { text: '長約', status: 'HOLDS' }] } };
    expect(CJ.premiseChecks(demo)).toEqual({ P1: { kind: 'CONFIRMED', text: '11/20 證實', why: null }, P2: { kind: 'MISSED', text: '這次沒驗到（還沒有證實過）', why: '11/20 審查：證據不足' } });
    // 持股頁用這幾個欄位畫（原始碼裡不再有舊的「之後的審查對這一條沒有一致結論」那一行）
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'js', 'pages-holding.js'), 'utf8');
    expect(src).toContain("h('span', { class: 'st ' + CHECK_TONE[c.kind] }, c.text)");
    expect(src).toContain("h('p', { class: 'small faint plist-why' }, c.why)");
    expect(src).not.toContain('之後的審查對這一條沒有一致結論');
  });
});

// ---------------------------------------------------------------- 整條流程：開審查 → 假的三票 → 持股頁（真實模式的 API）

describe('T61 整條流程（假的 AI 回覆）', () => {
  it('審查的三票：P1 有沒逾期的正面引用、P2 沒寫 confirm_ids、P3 的驗證頻率改成 14 天而財報是 20 天前的 → 持股頁寫「證實」「這次沒驗到」並說明逾期；信念不顯示結果', async () => {
    const { c, dispose } = await openWorld();
    try {
      const loaded = (await loadAccount(c.db))!;
      loaded.acct.own.NVDA.premises[2].verify = { by: 'XBRL', every: 14 };
      await saveAccount(c.db, loaded.acct, loaded, '測試：P3 每 14 天', new Date('2026-11-19T12:30:00Z'));
      const acct = (await loadAccount(c.db))!.acct;
      const rr = await startOwnReview(c.env, c.fetcher, acct, c.view, c.axis, 'NVDA', 'MANUAL', new Date('2026-11-20T01:00:00Z'));
      const run = (await getRun(c.db, rr.runId))!;
      expect(run.promptVersion).toBe('own_review_v5');
      expect(run.pack.policy.holds_fresh_days).toBe(100);
      expect(run.pack.premises.map((p) => p.id)).toEqual(['P1', 'P2', 'P3']);
      const xbrl = run.pack.documents.find((d) => d.kind === 'xbrl')!;
      expect(xbrl.date).toBe('2026-10-30');
      const quote = xbrl.text.split('\n').find((l) => l.includes('2026-09-30'))!;
      const v = {
        run_id: run.runId,
        verdict: 'HOLD',
        model: 'claude-opus-5-5',
        premise_checks: [
          { premise_id: 'P1', status: 'HOLDS', evidence_ids: ['E1'], confirm_ids: ['E1'] },
          { premise_id: 'P2', status: 'HOLDS', evidence_ids: ['E1'] },
          { premise_id: 'P3', status: 'HOLDS', evidence_ids: ['E1'], confirm_ids: ['E1'] },
        ],
        evidence: [{ id: 'E1', source_id: xbrl.source_id, date: xbrl.date, quote, claim: '最新一季的營收' }],
        payload: { tier: 'HOLD', condition_checks: [], proposed_conditions: [] },
        report: '前提沒有變。',
      };
      const task = await c.db.prepare('SELECT * FROM ai_tasks WHERE id = ?').bind(run.taskId).first();
      const outcome = (await finalizeRun(c.db, task as never, { samples: three(v) }, new Date('2026-11-20T01:30:00Z')))!;
      expect(outcome.samples[0].premises.map((p) => [p.premise_id, p.status, p.holdsIssue?.why ?? null])).toEqual([['P1', 'HOLDS', null], ['P2', 'INSUFFICIENT', 'NO_CONFIRM'], ['P3', 'INSUFFICIENT', 'STALE']]);
      const file = (await thesisFile(c.db, acct, 'NVDA', AS_OF))!;
      expect(file.reviews[0]).toMatchObject({ runId: run.runId, premiseVotes: { P1: H3, P2: I3, P3: I3 }, premiseStale: { P3: 3 } });
      const r = await c.api<{ thesis: { premiseChecks: Record<string, PremiseCheck> }; own: { premises: { id: string; belief: boolean }[] } }>('GET', 'holding/NVDA');
      expect(r.status).toBe(200);
      expect(r.body.thesis.premiseChecks).toEqual({
        P1: { kind: 'CONFIRMED', text: '11/19 證實', why: '3 票都判成立' },
        P2: { kind: 'MISSED', text: '這次沒驗到（還沒有證實過）', why: '11/19 審查：3 票都判證據不足' },
        P3: { kind: 'MISSED', text: '這次沒驗到（還沒有證實過）', why: '11/19 審查：3 票都判證據不足；其中 3 票原本判成立，但引用的原文比這一條的驗證頻率（14 天）還舊，算逾期' },
        P4: { kind: null, text: '還沒有檢查過', why: null },
      });
      expect(r.body.own.premises.find((p) => p.id === 'P4')?.belief).toBe(true);
    } finally {
      await dispose();
    }
  });
});

// ---------------------------------------------------------------- 7 運作統計

describe('T61 運作統計（/admin/ops-report）', () => {
  const NOW = new Date('2026-11-25T03:00:00Z');
  const json = (v: unknown) => JSON.stringify(v);
  type Vote = [status: string, issue?: 'STALE' | 'NO_CONFIRM'];
  /** 直接寫一筆有結論的執行：votes 是每條前提三票的判斷（被程式改成證據不足的帶原因）。 */
  async function seed(db: D1Database, id: string, fn: string, prompt: string, createdAt: string, votes: Record<string, Vote[]>, outcomeStatus = 'AGREED') {
    const ids = Object.keys(votes);
    const samples = [0, 1, 2].map((k) => ({ index: k, valid: true, verdict: 'HOLD', premises: ids.filter((p) => votes[p][k]).map((p) => ({ premise_id: p, status: votes[p][k][0], evidence_ids: [], ...(votes[p][k][1] ? { downgradedFrom: 'HOLDS', holdsIssue: votes[p][k][1] === 'STALE' ? { why: 'STALE', latest: '2026-08-01', days: 30 } : { why: 'NO_CONFIRM' } } : {}) })) }));
    const pack = { premises: ids.map((p) => ({ id: p, text: `t-${p}`, origin: 'USER' })) };
    await db.prepare("INSERT INTO ai_runs (run_id, fn, ticker, as_of, created_at, status, prompt_version, pack_hash, pack, outcome) VALUES (?, ?, 'NVDA', ?, ?, 'DONE', ?, 'h', ?, ?)").bind(id, fn, createdAt.slice(0, 10), createdAt, prompt, json(pack), json({ status: outcomeStatus, samples })).run();
  }
  const H: Vote = ['HOLDS'];
  const I: Vote = ['INSUFFICIENT'];
  const B: Vote = ['BROKEN'];
  const S: Vote = ['INSUFFICIENT', 'STALE'];
  const N: Vote = ['INSUFFICIENT', 'NO_CONFIRM'];
  const report = async (db: D1Database, query = '?from=2026-11-11&to=2026-11-24'): Promise<OpsReport> => {
    const env: Env = { DB: db, ADMIN_TOKEN: 'admin-secret', AI_TASK_SECRET: 's' };
    const res = await handle(new Request(`https://bot.example/admin/ops-report${query}`, { headers: { Authorization: 'Bearer admin-secret' } }), env, async () => new Response('x'), NOW);
    expect(res.status).toBe(200);
    return (await res.json()) as OpsReport;
  };
  const rowsOf = (r: OpsReport, id: string): Row[] => {
    const s = r.sections.find((x) => x.id === id)!;
    expect(s.error, id).toBeUndefined();
    return s.rows;
  };

  it('premise_prompt：依功能與 prompt 版本分開列成立、不成立、證據不足、票數不一致，以及逾期、沒指出正面引用的次數；premise_origin 多 stale', async () => {
    const d = await freshDb();
    try {
      const db = d.db;
      expect(OPS_SECTIONS.map((f) => f.name)).toContain('premisePromptSection');
      expect(rowsOf(await report(db), 'premise_prompt')).toEqual([]);
      await db.prepare("INSERT INTO account_history (rev, at, cause, state) VALUES (1, '2026-11-10T00:00:00.000Z', 'test', ?)").bind(json({ own: { NVDA: { premises: ['P1', 'P2', 'P3'].map((id) => ({ id, text: `t-${id}`, origin: 'USER' })) } } })).run();
      // 收緊之前（v3）：三條都判成立
      await seed(db, 'a1', 'OWN_REVIEW', 'own_review_v3', '2026-11-12T00:00:00.000Z', { P1: [H, H, H], P2: [H, H, H], P3: [H, H, H] });
      // 收緊之後（v4）：P1 成立；P2 三票都逾期；P3 一票逾期、兩票成立（票數不一致）
      await seed(db, 'b1', 'OWN_REVIEW', 'own_review_v4', '2026-11-22T00:00:00.000Z', { P1: [H, H, H], P2: [S, S, S], P3: [S, H, H] }, 'INSUFFICIENT');
      // P1 不成立；P2 一票沒指出正面的引用、兩票自己判證據不足；P3 自己判證據不足
      await seed(db, 'b2', 'OWN_REVIEW', 'own_review_v4', '2026-11-23T00:00:00.000Z', { P1: [B, B, B], P2: [N, I, I], P3: [I, I, I] });
      // 減半檢視（v4）另一列；逾時與期間外的不算
      await seed(db, 'c1', 'OWN_DROP', 'own_drop_v4', '2026-11-23T01:00:00.000Z', { P1: [I, I, I], P2: [S, I, I] });
      await seed(db, 'x1', 'OWN_REVIEW', 'own_review_v4', '2026-11-23T02:00:00.000Z', { P1: [S, S, S] }, 'TIMEOUT');
      await seed(db, 'x2', 'OWN_REVIEW', 'own_review_v4', '2026-11-05T00:00:00.000Z', { P1: [S, S, S] });
      const r = await report(db);
      expect(rowsOf(r, 'premise_prompt')).toEqual([
        { fn: 'OWN_DROP', prompt_version: 'own_drop_v4', runs: 1, premise_checks: 2, holds: 0, broken: 0, insufficient: 2, split: 0, stale: 1, no_confirm: 0, holds_ratio: 0, insufficient_ratio: 1 },
        { fn: 'OWN_REVIEW', prompt_version: 'own_review_v3', runs: 1, premise_checks: 3, holds: 3, broken: 0, insufficient: 0, split: 0, stale: 0, no_confirm: 0, holds_ratio: 1, insufficient_ratio: 0 },
        { fn: 'OWN_REVIEW', prompt_version: 'own_review_v4', runs: 2, premise_checks: 6, holds: 1, broken: 1, insufficient: 3, split: 1, stale: 2, no_confirm: 1, holds_ratio: 0.167, insufficient_ratio: 0.5 },
        { fn: '合計', prompt_version: null, runs: 4, premise_checks: 11, holds: 4, broken: 1, insufficient: 5, split: 1, stale: 3, no_confirm: 1, holds_ratio: 0.364, insufficient_ratio: 0.455 },
      ]);
      // 成績表（依前提的來源；只算定期審查）：逾期的那幾次已經算在證據不足或票數不一致裡，另外數出來
      expect(rowsOf(r, 'premise_origin').find((x) => x.origin === 'USER')).toMatchObject({ reviews: 3, premise_checks: 9, holds: 4, broken: 1, insufficient: 3, split: 1, stale: 2 });
      expect(rowsOf(r, 'premise_origin').find((x) => x.origin === '合計')).toMatchObject({ premise_checks: 9, stale: 2 });
    } finally {
      await d.dispose();
    }
  });
});
