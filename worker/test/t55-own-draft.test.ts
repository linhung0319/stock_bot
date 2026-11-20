// T55：論點草稿任務（OWN_DRAFT，web_evidence_design §2.2、§2.4 第 6 點、§2.5）。
// 完成條件：
//   檢查表（§2.2）每一條各一個不過的例子
//   新的自選自動開一次、已有論點不開
//   使用者按的：7 天上限、還在跑的不重開、失敗的不算
//   有還沒回覆的乙類通知時不自動開；手動的草稿不能沿用被判不成立的那一條（文字很像的標出來）
//   own_drafts 表（匯出、records_guide.md）；證據包只放比重；草稿的研究員可以取文件
// check.ts 沒有動；AI 的回覆一律是假的；對外請求全部是假的（EDGAR、RSS、網頁、雲端排程）。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { judge, type EvidencePack, type PackDoc } from '../src/ai/check';
import { THESIS_LIMITS } from '../src/ai/discussion';
import { PAYLOAD_HOOKS } from '../src/ai/hooks';
import { DRAFT_LIMITS, OWN_DRAFT, OWN_DRAFT_PROMPT, brokenNotice, draftResult, likeText, ownDraftPack, type DraftBroken, type OwnDraft } from '../src/ai/ownDraft';
import type { ApplyCtx, StartCtx } from '../src/app/aiCtx';
import { getRun } from '../src/app/aiRuns';
import { APPLIERS, aiStep } from '../src/app/aiStep';
import type { Env, Fetcher } from '../src/app/env';
import { EXPORT_TABLES } from '../src/app/export';
import { runFlow } from '../src/app/flow';
import { loadAccount, saveAccount } from '../src/app/ledgerStore';
import { DRAFT_GAP_DAYS, DraftError, applyOwnDraft, expireDrafts, loadDrafts, pendingBreak, requestOwnDraft, startAutoDrafts, type DraftRow } from '../src/app/ownDraft';
import { XBRL_METRICS, type CompanyFacts, type XbrlFact } from '../src/data/edgar';
import { buildMarketView } from '../src/data/marketView';
import { loadSeries } from '../src/data/store';
import { SYSTEM_DEFAULT_PREMISES, createAccount, routeReview, setThesis, type Account, type MarketView, type Premise } from '../src/engine';
import { handle } from '../src/index';
import { freshDb } from './helpers/d1';
import { cronTime, fakeFetcher, newWorld, type World } from './helpers/fakeSources';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const METRICS = new Set(Object.keys(XBRL_METRICS));
const HOOK = PAYLOAD_HOOKS[OWN_DRAFT];

// ---------------------------------------------------------------- 原文（純函式的測試與假的 EDGAR 共用）

const Q_REV = 'Revenue for the third quarter was $160 million, up 33% from a year ago';
const Q_GM = 'Gross margin was 60.0%, down from 70.0% a year ago';
const RISK1 = 'Our three largest customers accounted for 61% of revenue';
const RISK2 = 'Export restrictions may limit our ability to sell to certain customers';
const RISK3 = 'Inventory provisions increased to $1.2 billion this quarter';
const NOTE_Q = '使用者覺得資料中心的需求會一直成長下去，所以買進';
const TENQ_TEXT = `${Q_REV}. ${Q_GM}. ${RISK1}. ${RISK2}. ${RISK3}.`;

const DOC_Q: PackDoc = { id: 'D1', source_id: 'edgar:q', kind: 'filing', date: '2026-10-30', title: '10-Q 2026-10-30：MD&A', text: TENQ_TEXT };
const DOC_NOTE: PackDoc = { id: 'T-NVDA', source_id: 'thesis:NVDA@2026-11-19', kind: 'note', date: '2026-11-19', title: 'NVDA 的論點檔（背景）', text: NOTE_Q };
const USER_PREMISES: Premise[] = [
  { id: 'P1', text: '資料中心需求延續到 2027', origin: 'USER' },
  { id: 'P2', text: 'HBM 供給持續吃緊', origin: 'USER' },
];
const BROKEN: DraftBroken = { premiseId: 'P2', text: 'HBM 供給持續吃緊', notif: 7, notice: brokenNotice('P2') };

type Cite = Pick<PackDoc, 'source_id' | 'date'>;
const E = (id: string, doc: Cite, quote: string) => ({ id, source_id: doc.source_id, date: doc.date, quote, claim: '測試' });
const evOf = (q: Cite, note: Cite = DOC_NOTE) => [E('E1', q, Q_GM), E('E2', q, Q_REV), E('E3', q, RISK1), E('E4', q, RISK2), E('E5', q, RISK3), E('E9', note, NOTE_Q)];

/** 一份通過檢查的草稿（改一欄做不過的例子）。 */
function goodPayload(): Record<string, unknown> {
  return {
    thesis: '資料中心的 GPU 需求帶動營收與毛利，持有的理由靠需求延續、供給吃緊與毛利率維持。',
    premises: [
      { text: '資料中心營收連續四季年增超過 30%', keep_id: null, breaks_if: '連兩季營收年增率低於 15%', checkable_by: 'XBRL', source_hint: null, evidence_ids: ['E2'] },
      { text: 'HBM 的合約價到 2027 年上半年仍然逐季上漲', keep_id: null, breaks_if: 'TrendForce 的新聞稿報 HBM 合約價季跌', checkable_by: 'WEB', source_hint: 'trendforce.com', evidence_ids: [] },
      { text: '毛利率維持在 55% 以上', keep_id: null, breaks_if: '毛利率連兩季低於 55%', checkable_by: 'XBRL', source_hint: null, evidence_ids: ['E1'] },
    ],
    exits: [
      { text: '毛利率連兩季低於 55%（最新一季 60%）', action: 'HALF', kind: 'XBRL', check: { type: 'xbrl_metric_below', metric: 'GrossMarginPct', level: 0.55, quarters: 2 }, premise_index: 2, evidence_ids: ['E1'] },
      { text: '公司在 8-K 宣布下修本季營收財測', action: 'REVIEW', kind: 'EVENT', check: null, premise_index: null, evidence_ids: [] },
    ],
    sources: { peers: [{ name: 'SK hynix', edgar: null, yahoo: '000660.KS' }], domains: ['news.skhynix.com', 'www.micron.com', 'fool.com'] },
    against: [
      { text: '營收集中在三家客戶', evidence_ids: ['E3'] },
      { text: '出口管制限制銷售對象', evidence_ids: ['E4'] },
      { text: '存貨提列變大', evidence_ids: ['E5'] },
    ],
    would_buy_today: { answer: 'UNSURE', why: '需求還在，但客戶集中與存貨的風險都在上升' },
    not_checkable: ['大客戶自研晶片的進度'],
  };
}

function purePack(o: { broken?: DraftBroken | null; premises?: Premise[] } = {}): EvidencePack {
  return ownDraftPack({ runId: 'draft-test', asOf: '2026-11-19', ticker: 'NVDA', trigger: 'MANUAL', held: true, premises: o.premises ?? USER_PREMISES, facts: [], docs: [DOC_Q, DOC_NOTE], dataQuality: {}, thesisVersion: 1, fileId: 'NVDA@2026-11-19', broken: o.broken ?? null, webDomains: ['trendforce.com', 'dramexchange.com', 'news.skhynix.com'], now: new Date('2026-11-20T01:00:00Z') }).pack;
}
const sampleOf = (pack: EvidencePack, payload: unknown, extra: Record<string, unknown> = {}, ev: unknown[] = evOf(DOC_Q)) => ({ run_id: pack.run_id, function: OWN_DRAFT, verdict: 'DONE', evidence: ev, payload, report: '草稿：論點靠需求、供給與毛利率。\n\n細節。', ...extra });
function draftOf(payload: unknown, o: { pack?: EvidencePack; extra?: Record<string, unknown>; ev?: unknown[] } = {}) {
  const pack = o.pack ?? purePack();
  const outcome = judge(pack, [sampleOf(pack, payload, o.extra, o.ev)], HOOK);
  return { outcome, result: draftResult(outcome, pack, METRICS)! };
}
/** 改一欄（路徑用點分開；陣列寫數字）。 */
function withField(path: string, value: unknown): Record<string, unknown> {
  const p = goodPayload();
  const keys = path.split('.');
  let o = p as Record<string, unknown>;
  for (const k of keys.slice(0, -1)) o = o[k] as Record<string, unknown>;
  const last = keys.at(-1)!;
  if (value === undefined) delete o[last];
  else o[last] = value;
  return p;
}
const failWhy = (payload: unknown, o: Parameters<typeof draftOf>[1] = {}) => {
  const { result } = draftOf(payload, o);
  expect(result.ok).toBe(false);
  return (result as { why: string }).why;
};

// ---------------------------------------------------------------- 檢查表（§2.2）

describe('T55 程式檢查（§2.2）：通過的草稿', () => {
  it('寫好的草稿通過，整理成固定的形狀：前提、出場條件（財報門檻有標記）、反方、來源（清單內／新的／不列入）、引用帶標題', () => {
    const { outcome, result } = draftOf(goodPayload());
    expect(outcome.status).toBe('AGREED');
    expect(result.ok).toBe(true);
    const d = (result as { draft: OwnDraft }).draft;
    expect(d.premises.map((p) => p.checkable_by)).toEqual(['XBRL', 'WEB', 'XBRL']);
    expect(d.exits.map((x) => [x.action, x.threshold])).toEqual([
      ['HALF', true],
      ['REVIEW', false],
    ]);
    expect(d.against.map((a) => a.evidence_ids)).toEqual([['E3'], ['E4'], ['E5']]);
    expect(d.sources.domains).toEqual([
      { domain: 'news.skhynix.com', state: 'LISTED', note: '已經在清單裡' },
      { domain: 'www.micron.com', state: 'NEW', note: '新的來源，存檔前會先試抓' },
      { domain: 'fool.com', state: 'EXCLUDED', note: '不列入的網站（評論、預測、社群）：加不進來' },
    ]);
    expect(d.sources.peers).toEqual([{ name: 'SK hynix', yahoo: '000660.KS' }]);
    expect(d.would_buy_today).toEqual({ answer: 'UNSURE', why: '需求還在，但客戶集中與存貨的風險都在上升' });
    expect(d.evidence.find((e) => e.id === 'E3')).toMatchObject({ source_id: 'edgar:q', title: '10-Q 2026-10-30：MD&A' });
    expect(d.premises.some((p) => p.like_broken)).toBe(false);
  });

  it('條數與字數上限和 parseThesisBlock（THESIS_LIMITS）一樣', () => {
    expect([DRAFT_LIMITS.premisesMax, DRAFT_LIMITS.exitsMax, DRAFT_LIMITS.thesis, DRAFT_LIMITS.premise, DRAFT_LIMITS.exit]).toEqual([THESIS_LIMITS.premises, THESIS_LIMITS.exits, THESIS_LIMITS.thesis, THESIS_LIMITS.premise, THESIS_LIMITS.exit]);
  });

  it('研究員自己說證據不夠（INSUFFICIENT）→ 沒有草稿，原因分得出來', () => {
    expect(failWhy(goodPayload(), { extra: { verdict: 'INSUFFICIENT', abstain_reason: '申報與財報都抓不到' } })).toBe('研究員認為證據不夠寫草稿：申報與財報都抓不到');
  });
});

describe('T55 程式檢查（§2.2）：每一條各一個不過的例子（整份退回，不給半份草稿）', () => {
  it('外殼照 check.ts：多了不認得的欄位、verdict 不在列舉值內 → 格式不合格', () => {
    expect(failWhy(goodPayload(), { extra: { draft: 'x' } })).toContain('送回的格式不合格');
    expect(failWhy(goodPayload(), { extra: { verdict: 'READY' } })).toContain('verdict 不在列舉值內');
  });

  it('引用照 check.ts：改寫過的引用被刪掉 → 反方那一點沒有通過檢查的引用', () => {
    const ev = evOf(DOC_Q).map((e) => (e.id === 'E4' ? { ...e, quote: 'Export restrictions will certainly destroy all of our sales' } : e));
    const why = failWhy(goodPayload(), { ev });
    expect(why).toContain('反方第 2 點沒有通過檢查的引用');
  });

  it('前提 3～5 條：2 條、6 條都不過', () => {
    const p = goodPayload().premises as unknown[];
    expect(failWhy(withField('premises', p.slice(0, 2)))).toContain('前提要 3～5 條（送回 2 條）');
    expect(failWhy(withField('premises', [...p, ...p]))).toContain('前提要 3～5 條（送回 6 條）');
  });

  it('出場條件 2～6 條：1 條、7 條都不過', () => {
    const x = goodPayload().exits as unknown[];
    expect(failWhy(withField('exits', x.slice(0, 1)))).toContain('出場條件要 2～6 條（送回 1 條）');
    expect(failWhy(withField('exits', [...x, ...x, ...x, x[1]]))).toContain('出場條件要 2～6 條（送回 7 條）');
  });

  it('字數上限同 parseThesisBlock：論點 600、前提 200、出場條件 300', () => {
    expect(failWhy(withField('thesis', '論'.repeat(601)))).toContain('論點超過 600 字');
    expect(failWhy(withField('premises.1.text', '前'.repeat(201)))).toContain('前提第 2 條超過 200 字');
    expect(failWhy(withField('exits.1.text', '出'.repeat(301)))).toContain('出場條件第 2 條超過 300 字');
    expect(failWhy(withField('thesis', ''))).toContain('沒有論點本文');
  });

  it('每一條前提都要有 breaks_if 與 checkable_by', () => {
    expect(failWhy(withField('premises.0.breaks_if', undefined))).toContain('前提第 1 條沒有寫怎樣算不成立（breaks_if）');
    expect(failWhy(withField('premises.2.checkable_by', 'MAYBE'))).toContain('前提第 3 條的 checkable_by 要是');
    expect(failWhy(withField('premises.2.checkable_by', undefined))).toContain('前提第 3 條的 checkable_by 要是');
  });

  it('checkable_by = NONE 最多 1 條（1 條可以，2 條不過）', () => {
    expect(draftOf(withField('premises.1.checkable_by', 'NONE')).result.ok).toBe(true);
    const p = withField('premises.1.checkable_by', 'NONE');
    (p.premises as Record<string, unknown>[])[0].checkable_by = 'NONE';
    expect(failWhy(p)).toContain('查不到的前提（checkable_by = NONE）最多 1 條（送回 2 條）');
  });

  it('至少一條出清或減半的財報數字門檻：動作是重新審查、指標程式算不出來、門檻沒有通過檢查的引用、只引用使用者的話、不是財報類，都不過', () => {
    const NEED = '至少要一條動作是出清或減半、而且是財報數字門檻的出場條件';
    expect(failWhy(withField('exits.0.action', 'REVIEW'))).toContain(NEED);
    expect(failWhy(withField('exits.0.check.metric', 'MarketShare'))).toContain(NEED);
    expect(failWhy(withField('exits.0.check.level', '55%'))).toContain(NEED);
    expect(failWhy(withField('exits.0.evidence_ids', []))).toContain(NEED);
    expect(failWhy(withField('exits.0.evidence_ids', ['E9']))).toContain(NEED);
    expect(failWhy(withField('exits.0.kind', 'EVENT'))).toContain(NEED);
    // 出清也可以
    expect(draftOf(withField('exits.0.action', 'EXIT')).result.ok).toBe(true);
  });

  it('反方要 3 點，每點至少一條通過檢查的引用（論點檔、使用者自己寫的不算）', () => {
    const a = goodPayload().against as unknown[];
    expect(failWhy(withField('against', a.slice(0, 2)))).toContain('反方要 3 點（送回 2 點）');
    expect(failWhy(withField('against', undefined))).toContain('反方要 3 點（送回 0 點）');
    expect(failWhy(withField('against.2.evidence_ids', ['E9']))).toContain('反方第 3 點沒有通過檢查的引用（論點檔與使用者自己寫的不算）');
    expect(failWhy(withField('against.0.evidence_ids', []))).toContain('反方第 1 點沒有通過檢查的引用');
  });

  it('今天會不會買要有答案與理由', () => {
    expect(failWhy(withField('would_buy_today', undefined))).toContain('would_buy_today 要有 answer');
    expect(failWhy(withField('would_buy_today.answer', 'MAYBE'))).toContain('would_buy_today 要有 answer');
  });

  it('來源的網域要通過 safeWebUrl：IP、localhost、http 的內部主機、沒有點的名稱都不過；同業代號格式不對也不過', () => {
    expect(failWhy(withField('sources.domains', ['192.168.0.1']))).toContain('來源的網域「192.168.0.1」不是公開的 https 網站');
    expect(failWhy(withField('sources.domains', ['localhost']))).toContain('不是公開的 https 網站');
    expect(failWhy(withField('sources.domains', ['http://intranet.local/x']))).toContain('不是公開的 https 網站');
    expect(failWhy(withField('sources.domains', ['https://news.example.com:8443/']))).toContain('不是公開的 https 網站');
    expect(failWhy(withField('sources.peers', [{ name: 'SK hynix', yahoo: '000 660' }]))).toContain('同業「SK hynix」要有名稱，與格式正確的 EDGAR 或 Yahoo 代號');
    // 網址也收（只取主機）
    const ok = draftOf(withField('sources.domains', ['https://www.trendforce.com/presscenter/news/x']));
    expect((ok.result as { draft: OwnDraft }).draft.sources.domains).toEqual([{ domain: 'www.trendforce.com', state: 'LISTED', note: '已經在清單裡' }]);
  });

  it('keep_id：沿用現行一字沒改的前提可以；字改了、不是現行的前提都不過', () => {
    const keep = withField('premises.0', { text: '資料中心需求延續到 2027', keep_id: 'P1', breaks_if: '連兩季營收年增率低於 15%', checkable_by: 'XBRL', evidence_ids: ['E2'] });
    expect((draftOf(keep).result as { draft: OwnDraft }).draft.premises[0].keep_id).toBe('P1');
    expect(failWhy(withField('premises.0.keep_id', 'P1'))).toContain('前提第 1 條沿用了 P1，但字改了');
    expect(failWhy(withField('premises.0.keep_id', 'P9'))).toContain('前提第 1 條的 keep_id P9 不是現行的前提');
  });
});

describe('T55 剛被判不成立的前提（§2.4 第 6 點）', () => {
  it('題目最上面寫固定的那句話、記在 rule.detail.broken', () => {
    const pack = purePack({ broken: BROKEN });
    expect(pack.question.startsWith('前提 P2 剛被判不成立。在這之後改論點，很容易只是替繼續持有找新理由。草稿不能沿用前提 P2')).toBe(true);
    expect((pack.rule.detail as { broken: DraftBroken }).broken).toEqual(BROKEN);
    expect(purePack().question).not.toContain('剛被判不成立');
  });

  it('keep_id 是被判不成立的那一條 → 程式擋下（整份退回）', () => {
    const p = withField('premises.0', { text: 'HBM 供給持續吃緊', keep_id: 'P2', breaks_if: 'TrendForce 報 HBM 合約價季跌', checkable_by: 'WEB', evidence_ids: [] });
    expect(failWhy(p, { pack: purePack({ broken: BROKEN }) })).toContain('前提第 1 條沿用了剛被判不成立的前提 P2（keep_id 不能是它）');
    // 沒有被判不成立時，同一條可以沿用
    expect(draftOf(p).result.ok).toBe(true);
  });

  it('沒有寫 keep_id、但文字很像被判不成立的那一條 → 標出來（不擋）', () => {
    const p = withField('premises.1.text', 'HBM 供給到 2027 年仍然持續吃緊');
    const d = (draftOf(p, { pack: purePack({ broken: BROKEN }) }).result as { draft: OwnDraft }).draft;
    expect(d.premises.map((x) => !!x.like_broken)).toEqual([false, true, false]);
    expect(likeText('HBM 供給持續吃緊。', 'HBM供給持續吃緊')).toBe(true);
    expect(likeText('資料中心需求延續到 2027', 'HBM 供給持續吃緊')).toBe(false);
  });
});

// ---------------------------------------------------------------- 假的世界（EDGAR、RSS、網頁、雲端排程）

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
const PARA = (s: string) => `<p>${s.repeat(Math.ceil(260 / s.length))}</p>`;
const TF = 'https://www.trendforce.com/presscenter/news/20261111-memory.html';
const TF_PAGE = `<!doctype html><html><head><title>Site | HBM prices</title><meta property="article:published_time" content="2026-11-11T08:00:00Z"></head><body><h1>HBM prices</h1>${Array.from({ length: 8 }, (_, i) => PARA(`Paragraph ${i}: HBM contract prices rose again in the fourth quarter according to the survey. `)).join('\n')}</body></html>`;

interface Net {
  fire: number;
  fireDown: boolean;
}
function fetcherOf(w: World, net: Net): Fetcher {
  const base = fakeFetcher(w);
  return async (url, init) => {
    if (url === 'https://api.example/fire') {
      net.fire++;
      return net.fireDown ? new Response('quota', { status: 429 }) : Response.json({ claude_code_session_url: 'https://claude.ai/code/x' });
    }
    if (/data\.sec\.gov\/submissions\/CIK\d+\.json/.test(url)) return subs();
    if (/companyfacts\/CIK\d+\.json/.test(url)) return Response.json(BASE);
    const doc = /Archives\/edgar\/data\/\d+\/(\d+)\/(.+)$/.exec(url);
    if (doc) return doc[2] === 'index.json' ? Response.json({ directory: { item: [{ name: TENQ.primaryDocument }] } }) : new Response(TENQ_HTML);
    if (url.startsWith('https://www.nasdaq.com/feed/rssoutbound') || url.startsWith('https://feeds.finance.yahoo.com/rss/2.0/headline')) return new Response('<rss><channel></channel></rss>');
    if (url === TF) return new Response(TF_PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    return base(url, init);
  };
}

interface Ctx {
  db: D1Database;
  env: Env;
  net: Net;
  fetcher: Fetcher;
  view: MarketView;
  axis: string[];
  shares: number;
  call: <T = Record<string, unknown>>(method: 'GET' | 'POST', path: string, body: unknown, now: Date, auth?: string) => Promise<{ status: number; body: T }>;
}

/** 2026-11-19 建立帳戶、NVDA 是新的自選（論點檔 NVDA@2026-11-19）；opt.premises 給了就是使用者寫的前提（已有論點）。 */
async function withWorld(fn: (c: Ctx) => Promise<void>, opt: { premises?: Premise[] } = {}) {
  const d = await freshDb();
  try {
    const db = d.db;
    const w = newWorld('2026-11-19');
    const net: Net = { fire: 0, fireDown: false };
    const env: Env = { DB: db, ADMIN_TOKEN: 't', AI_TASK_SECRET: 's', EDGAR_USER_AGENT: 'test bot test@example.com', SITE_URL: 'https://bot.example', DEV_NO_AUTH: '1', ROUTINE_FIRE_URL: 'https://api.example/fire', ROUTINE_TOKEN: 'rt' };
    const fetcher = fetcherOf(w, net);
    await runFlow(env, fetcher, { now: cronTime('2026-11-19'), attempt: 'FIRST' });
    const { view, axis } = buildMarketView(await loadSeries(db, ['VOO', 'SGOV', 'NVDA']), '2026-11-19', 'VOO');
    const shares = Math.floor(40_000 / view.close.NVDA[view.i]);
    const acct = createAccount({ paper: true, cash: 5000, core: { VOO: Math.floor(140_000 / view.close.VOO[view.i]) }, own: { NVDA: { shares, stdWeight: 0.15, premises: opt.premises ?? structuredClone(SYSTEM_DEFAULT_PREMISES), buyNote: 'AI 伺服器的需求還在早期' } } }, view);
    await saveAccount(db, acct, null, '建立帳戶', new Date('2026-11-19T22:00:00Z'));
    const call: Ctx['call'] = async (method, path, b, now, auth) => {
      const r = await handle(new Request(`https://bot.example${path}`, { method, headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) }, ...(b === undefined ? {} : { body: JSON.stringify(b) }) }), env, fetcher, now);
      return { status: r.status, body: (await r.json()) as never };
    };
    await fn({ db, env, net, fetcher, view, axis, shares, call });
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
async function startCtx(c: Ctx, now: Date, session = '2026-11-19'): Promise<StartCtx> {
  return { env: c.env, fetcher: c.fetcher, acct: await acctOf(c.db), view: { ...c.view, date: session }, axis: c.axis, session, ov: {}, now, checks: [], res: { created: [], started: [], log: [], alerts: [] }, extras: {} };
}
const applyCtx = async (c: Ctx, now: Date): Promise<ApplyCtx> => ({ db: c.db, acct: await acctOf(c.db), view: c.view, axis: c.axis, session: '2026-11-19', now, stmts: [], log: [], alerts: [] });
const draftRuns = async (db: D1Database) => (await db.prepare("SELECT run_id FROM ai_runs WHERE fn = 'OWN_DRAFT' ORDER BY created_at").all<{ run_id: string }>()).results.map((r) => r.run_id);
const draftsOf = (db: D1Database) => loadDrafts(db, 'NVDA', 50);

/** 照證據包的 10-Q 組一份草稿送回（payload 可以改）；now 要在開執行後 45 分鐘內。 */
async function answer(c: Ctx, runId: string, now: Date, payload: unknown = goodPayload(), extra: Record<string, unknown> = {}) {
  const run = (await getRun(c.db, runId))!;
  const q = run.pack.documents.find((d) => d.kind === 'filing')!;
  const note = run.pack.documents.find((d) => d.kind === 'note') ?? q;
  await c.call('GET', `/ai/task/${run.taskId}/evidence`, undefined, now, 's');
  const sample = { run_id: run.runId, function: OWN_DRAFT, verdict: 'DONE', evidence: evOf(q, note), payload, report: '草稿。', ...extra };
  return c.call('POST', `/ai/task/${run.taskId}/result`, { task_id: run.taskId, kind: 'RUN', run_id: run.runId, samples: [sample], process: [{ role: '研究員', text: '摘要' }, { role: '反方', text: '三件事' }, { role: '正方', text: '回應' }], lookups: { questions: [], queries: [], wanted: [] } }, now, 's');
}

// ---------------------------------------------------------------- 時機（§2.5）

describe('T55 新的自選自動開一次（§2.5）', () => {
  it('還沒有論點的新自選 → 每日第一次流程開一次（AUTO、PENDING）；第二天不再開', async () => {
    await withWorld(async (c) => {
      const res = await aiStep(c.env, c.fetcher, T0, '2026-11-19', {}, true);
      const runs = await draftRuns(c.db);
      expect(runs).toHaveLength(1);
      expect(res.started).toContain(runs[0]);
      expect(res.log.some((l) => l.includes('新的自選，自動草擬論點'))).toBe(true);
      expect(await draftsOf(c.db)).toEqual([expect.objectContaining({ ticker: 'NVDA', file_id: 'NVDA@2026-11-19', run_id: runs[0], trigger: 'AUTO', status: 'PENDING', based_on_version: 0, broken: null })]);
      const sc = await startCtx(c, at(T0, 1), '2026-11-20');
      await startAutoDrafts(sc);
      expect(await draftRuns(c.db)).toHaveLength(1);
      expect(APPLIERS[OWN_DRAFT]).toBe(applyOwnDraft);
    });
  });

  it('使用者已經寫了自己的前提 → 不開', async () => {
    await withWorld(
      async (c) => {
        await startAutoDrafts(await startCtx(c, T0));
        expect(await draftRuns(c.db)).toEqual([]);
      },
      { premises: USER_PREMISES },
    );
  });

  it('開執行之前使用者存了論點（只寫本文、前提仍是系統預設）→ 不開', async () => {
    await withWorld(async (c) => {
      await mutate(c.db, (a) => setThesis(a, 'NVDA', { text: '我自己的論點', source: 'TYPED', premises: [], date: '2026-11-19' }).acct);
      await startAutoDrafts(await startCtx(c, T0));
      expect(await draftRuns(c.db)).toEqual([]);
    });
  });

  it('開檔超過 7 天的不再補開；現在 0 股的等持有後再開', async () => {
    await withWorld(async (c) => {
      const late = await startCtx(c, at(T0, 8), '2026-11-27');
      await startAutoDrafts(late);
      expect(await draftRuns(c.db)).toEqual([]);
      await mutate(c.db, (a) => ({ ...a, lots: { ...a.lots, own: { ...a.lots.own, NVDA: 0 } } }));
      const sc = await startCtx(c, T0);
      await startAutoDrafts(sc);
      expect(await draftRuns(c.db)).toEqual([]);
      expect(sc.res.log).toContain('NVDA：新的自選現在 0 股，論點草稿等持有後再開');
    });
  });

  it('有還沒回覆的乙類通知 → 不自動開（手動可以，見下面）', async () => {
    await withWorld(async (c) => {
      await mutate(c.db, (a) => routeReview(a, c.view, 'NVDA', { tier: 'EXIT', suggest: true, consensus: true, premiseId: 'P1', trigger: 'EARNINGS', date: '2026-11-19' }).acct);
      const acct = await acctOf(c.db);
      expect(pendingBreak(acct, 'NVDA')).toMatchObject({ premiseId: 'P1' });
      const sc = await startCtx(c, T0);
      await startAutoDrafts(sc);
      expect(await draftRuns(c.db)).toEqual([]);
      expect(sc.res.log.some((l) => l.startsWith('NVDA：有還沒回覆的乙類通知') && l.includes('不自動草擬論點'))).toBe(true);
    });
  });

  it('自動的失敗了：下一次流程重試一次；再失敗 → 告警 DRAFT_FAILED，之後不再自動開', async () => {
    await withWorld(async (c) => {
      await startAutoDrafts(await startCtx(c, T0));
      const [r1] = await draftRuns(c.db);
      expect((await answer(c, r1, at(T0, 0, 10), withField('against', []))).status).toBe(200);
      expect((await draftsOf(c.db))[0]).toMatchObject({ status: 'FAILED', trigger: 'AUTO' });
      const a1 = await applyCtx(c, at(T0, 0, 20));
      await applyOwnDraft(a1, (await getRun(c.db, r1))!);
      expect(a1.alerts).toEqual([]);
      expect(a1.log.some((l) => l.includes('第 1 次失敗，下一次每日流程重試一次'))).toBe(true);
      // 重試
      await startAutoDrafts(await startCtx(c, at(T0, 1), '2026-11-20'));
      const runs = await draftRuns(c.db);
      expect(runs).toHaveLength(2);
      // 第二次沒觸發成（額度用完）以外的失敗：逾時 → 每日流程套用時結算
      const a2 = await applyCtx(c, at(T0, 1, 60));
      const r2 = (await getRun(c.db, runs[1], at(T0, 1, 60)))!;
      expect(r2.outcome?.status).toBe('TIMEOUT');
      await applyOwnDraft(a2, r2);
      expect((await draftsOf(c.db))[0]).toMatchObject({ run_id: runs[1], status: 'FAILED' });
      expect((await draftsOf(c.db))[0].error).toContain('超過 45 分鐘沒有收到結果');
      expect(a2.alerts).toEqual([expect.objectContaining({ kind: 'DRAFT_FAILED' })]);
      expect(a2.alerts![0].message).toMatch(/^NVDA 的論點草稿自動試了 2 次都沒有成功（11-19 程式檢查沒過：反方要 3 點/);
      // 不再自動開
      await startAutoDrafts(await startCtx(c, at(T0, 2), '2026-11-21'));
      expect(await draftRuns(c.db)).toHaveLength(2);
    });
  });
});

describe('T55 使用者按「請 stock bot 草擬」（§2.5）', () => {
  it('立刻開；還在跑的不重開；回來之後 7 天內再按 → 409 寫明哪天之後可以；滿 7 天可以再按', async () => {
    await withWorld(
      async (c) => {
        const first = await c.call<{ ok: boolean; runId: string; broken: null }>('POST', '/api/ops/own-draft', { ticker: 'NVDA' }, T0);
        expect(first.status).toBe(200);
        expect(first.body).toMatchObject({ ok: true, broken: null });
        expect(await draftsOf(c.db)).toEqual([expect.objectContaining({ run_id: first.body.runId, trigger: 'MANUAL', status: 'PENDING', based_on_version: 0 })]);
        const again = await c.call<{ error: string }>('POST', '/api/ops/own-draft', { ticker: 'NVDA' }, at(T0, 0, 5));
        expect(again.status).toBe(409);
        expect(JSON.stringify(again.body)).toContain('NVDA 的草稿還在準備中');
        // 回來了（結果送回時當場結算成 READY）
        expect((await answer(c, first.body.runId, at(T0, 0, 10))).status).toBe(200);
        expect((await draftsOf(c.db))[0]).toMatchObject({ status: 'READY' });
        const week = await c.call('POST', '/api/ops/own-draft', { ticker: 'NVDA' }, at(T0, 6, 23 * 60));
        expect(week.status).toBe(409);
        expect(JSON.stringify(week.body)).toContain(`11/20 已經草擬過一次（每檔 ${DRAFT_GAP_DAYS} 天最多一次），11/27 之後可以再按`);
        const ok = await c.call<{ runId: string }>('POST', '/api/ops/own-draft', { ticker: 'NVDA' }, at(T0, 7, 1));
        expect(ok.status).toBe(200);
        expect((await draftsOf(c.db)).map((d) => d.status)).toEqual(['PENDING', 'READY']);
      },
      { premises: USER_PREMISES },
    );
  });

  it('失敗的不算進 7 天（沒觸發成、程式檢查沒過都可以馬上再按）；自動開的那一次算', async () => {
    await withWorld(async (c) => {
      c.net.fireDown = true;
      const acct = await acctOf(c.db);
      const r1 = await requestOwnDraft(c.env, c.fetcher, acct, c.view, c.axis, 'NVDA', T0);
      expect((await draftsOf(c.db))[0]).toMatchObject({ run_id: r1.runId, status: 'FAILED' });
      expect((await draftsOf(c.db))[0].error).toContain('雲端排程沒有觸發成功');
      c.net.fireDown = false;
      const r2 = await requestOwnDraft(c.env, c.fetcher, acct, c.view, c.axis, 'NVDA', at(T0, 0, 1));
      await answer(c, r2.runId, at(T0, 0, 10), withField('premises', []));
      expect((await draftsOf(c.db))[0]).toMatchObject({ run_id: r2.runId, status: 'FAILED' });
      expect((await draftsOf(c.db))[0].error).toContain('程式檢查沒過：前提要 3～5 條（送回 0 條）');
      // 自動開的成功了 → 7 天內手動不行
      await startAutoDrafts(await startCtx(c, at(T0, 0, 20)));
      const auto = (await draftsOf(c.db))[0];
      expect(auto).toMatchObject({ trigger: 'AUTO', status: 'PENDING' });
      await answer(c, auto.run_id, at(T0, 0, 30));
      await expect(requestOwnDraft(c.env, c.fetcher, acct, c.view, c.axis, 'NVDA', at(T0, 1))).rejects.toThrow(DraftError);
    });
  });

  it('不是自選、示範模式 → 不開', async () => {
    await withWorld(async (c) => {
      expect((await c.call('POST', '/api/ops/own-draft', { ticker: 'AAPL' }, T0)).status).toBe(422);
      expect((await c.call('POST', '/demo/api/ops/own-draft', { ticker: 'NVDA' }, T0)).status).toBe(400);
    });
  });

  it('有還沒回覆的乙類通知時手動可以開：草稿帶 broken（固定的那句話），沿用被判不成立的那一條 → 整份退回；文字很像的標出來', async () => {
    await withWorld(
      async (c) => {
        await mutate(c.db, (a) => routeReview(a, c.view, 'NVDA', { tier: 'HALF', suggest: true, consensus: true, premiseId: 'P2', trigger: 'EARNINGS', date: '2026-11-19' }).acct);
        const acct = await acctOf(c.db);
        const notif = pendingBreak(acct, 'NVDA')!.notif;
        const r = await requestOwnDraft(c.env, c.fetcher, acct, c.view, c.axis, 'NVDA', T0);
        const want = { premiseId: 'P2', text: 'HBM 供給持續吃緊', notif, notice: '前提 P2 剛被判不成立。在這之後改論點，很容易只是替繼續持有找新理由' };
        expect(r.broken).toEqual(want);
        expect(JSON.parse((await draftsOf(c.db))[0].broken!)).toEqual(want);
        const run = (await getRun(c.db, r.runId))!;
        expect(run.pack.question.startsWith(want.notice)).toBe(true);
        const keep = withField('premises.0', { text: 'HBM 供給持續吃緊', keep_id: 'P2', breaks_if: 'TrendForce 報 HBM 合約價季跌', checkable_by: 'WEB', evidence_ids: [] });
        await answer(c, r.runId, at(T0, 0, 10), keep);
        expect((await draftsOf(c.db))[0]).toMatchObject({ status: 'FAILED' });
        expect((await draftsOf(c.db))[0].error).toContain('沿用了剛被判不成立的前提 P2（keep_id 不能是它）');
        // 再按一次（失敗的不算）：換個說法寫回來 → 通過，但標出來
        const r2 = await requestOwnDraft(c.env, c.fetcher, acct, c.view, c.axis, 'NVDA', at(T0, 0, 20));
        await answer(c, r2.runId, at(T0, 0, 30), withField('premises.1.text', 'HBM 供給到 2027 年仍然持續吃緊'));
        const row = (await draftsOf(c.db))[0];
        expect(row.status).toBe('READY');
        expect((JSON.parse(row.payload!) as OwnDraft).premises.map((p) => !!p.like_broken)).toEqual([false, true, false]);
      },
      { premises: USER_PREMISES },
    );
  });
});

// ---------------------------------------------------------------- 證據包、取文件、結算、表

describe('T55 證據包與取文件（§2.2）', () => {
  it('證據包：論點檔（買進時的一句話）、價格與比重、XBRL、10-Q 的 MD&A、目錄與清單內的網頁來源；不放金額與股數', async () => {
    await withWorld(async (c) => {
      const r = await requestOwnDraft(c.env, c.fetcher, await acctOf(c.db), c.view, c.axis, 'NVDA', T0);
      const run = (await getRun(c.db, r.runId))!;
      const { pack } = run;
      expect(pack).toMatchObject({ function: 'OWN_DRAFT', prompt_version: OWN_DRAFT_PROMPT, policy: { level: 'A2', samples: 1, verdicts: ['DONE', 'INSUFFICIENT'], abstain: 'INSUFFICIENT' } });
      expect(pack.rule.detail).toMatchObject({ trigger: 'MANUAL', thesisVersion: 0, fileId: 'NVDA@2026-11-19', broken: null });
      const ids = pack.facts.map((f) => f.id);
      expect(ids).toEqual(expect.arrayContaining(['F1', 'R1', 'R2', 'R3', 'B1', 'T0', 'D1', 'D2', 'D3', 'S1']));
      expect(pack.facts.find((f) => f.id === 'B1')?.value).toBe('AI 伺服器的需求還在早期');
      expect(pack.facts.find((f) => f.id === 'R3')?.value).toMatch(/^\d+\.\d%$/);
      expect(pack.documents.map((d) => d.kind)).toEqual(expect.arrayContaining(['price', 'xbrl', 'filing']));
      expect(pack.documents.find((d) => d.kind === 'filing')?.text).toContain(RISK1);
      const raw = JSON.stringify(pack);
      expect(raw).not.toContain(`${c.shares} 股`);
      // 只有系統預設前提也組了目錄、可以取文件（審查是 off）
      expect(run.docCtx).toMatchObject({ fileId: 'NVDA@2026-11-19' });
      expect(run.docCtx?.off ?? null).toBeNull();
    });
  });

  it('研究員可以向 Worker 取清單內的網頁；取回的文件可以當引用', async () => {
    await withWorld(async (c) => {
      const r = await requestOwnDraft(c.env, c.fetcher, await acctOf(c.db), c.view, c.axis, 'NVDA', T0);
      const run = (await getRun(c.db, r.runId))!;
      await c.call('GET', `/ai/task/${run.taskId}/evidence`, undefined, at(T0, 0, 2), 's');
      const got = await c.call<{ docs: { source_id: string; date: string; text: string; tier: string }[] }>('POST', `/ai/task/${run.taskId}/docs`, { role: '研究員', want: [{ url: TF, title: 'HBM prices', why: 'HBM 合約價' }] }, at(T0, 0, 3), 's');
      expect(got.status).toBe(200);
      expect(got.body.docs).toEqual([expect.objectContaining({ tier: 'NAMED', date: '2026-11-11' })]);
      // 第三點反方引用取回的網頁
      const web = got.body.docs[0];
      const p = withField('against.2.evidence_ids', ['W1']);
      const q = run.pack.documents.find((d) => d.kind === 'filing')!;
      const sample = { run_id: run.runId, function: OWN_DRAFT, verdict: 'DONE', evidence: [...evOf(q), E('W1', web, 'HBM contract prices rose again in the fourth quarter')], payload: p, report: '草稿。' };
      expect((await c.call('POST', `/ai/task/${run.taskId}/result`, { task_id: run.taskId, kind: 'RUN', run_id: run.runId, samples: [sample] }, at(T0, 0, 10), 's')).status).toBe(200);
      const row = (await draftsOf(c.db))[0];
      expect(row.status).toBe('READY');
      expect((JSON.parse(row.payload!) as OwnDraft).against[2].evidence_ids).toEqual(['W1']);
    });
  });
});

describe('T55 own_drafts：結算、過期、匯出', () => {
  it('新的草稿回來時同一檔舊的 READY 標 EXPIRED；READY 30 天沒處理 → EXPIRED', async () => {
    await withWorld(async (c) => {
      const acct = await acctOf(c.db);
      const r1 = await requestOwnDraft(c.env, c.fetcher, acct, c.view, c.axis, 'NVDA', T0);
      await answer(c, r1.runId, at(T0, 0, 10));
      const r2 = await requestOwnDraft(c.env, c.fetcher, acct, c.view, c.axis, 'NVDA', at(T0, 8));
      expect((await draftsOf(c.db)).map((d) => d.status)).toEqual(['PENDING', 'READY']);
      await answer(c, r2.runId, at(T0, 8, 10));
      expect((await draftsOf(c.db)).map((d: DraftRow) => [d.run_id, d.status])).toEqual([
        [r2.runId, 'READY'],
        [r1.runId, 'EXPIRED'],
      ]);
      expect(await expireDrafts(c.db, at(T0, 8 + 29))).toBe(0);
      expect(await expireDrafts(c.db, at(T0, 8 + 31))).toBe(1);
      expect((await draftsOf(c.db))[0].status).toBe('EXPIRED');
    });
  });

  it('own_drafts 照整張重拉匯出（payload、broken 解析成物件）；records_guide.md 有這張表與 OWN_DRAFT', () => {
    expect(EXPORT_TABLES.own_drafts).toMatchObject({ mode: 'replace', json: ['payload', 'broken'] });
    const guide = readFileSync(join(ROOT, 'docs', 'analysis', 'records_guide.md'), 'utf8');
    expect(guide).toContain('| `own_drafts` |');
    expect(guide).toContain('`OWN_DRAFT`（論點草稿');
  });

  it('prompt：own_draft_v1 存在，寫明研究員可以找、其他角色不上網，反方先寫', () => {
    const p = readFileSync(join(ROOT, 'ai', 'prompts', `${OWN_DRAFT_PROMPT}.md`), 'utf8');
    expect(OWN_DRAFT_PROMPT).toBe('own_draft_v1');
    expect(p).toContain('只有研究員可以用 WebSearch、可以取文件');
    expect(p).toContain('**反方**（Sonnet，**先寫**');
    expect(p).toContain('反方、正方、主筆不要用 WebSearch、不要取文件');
  });
});
