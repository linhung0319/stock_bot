// T27：討論包、貼回、編輯論點（own_thesis §1.7、§1.8、§1.12 的「拿掉草擬」、§3.6.5、§3.8）。
// 完成條件：
//   貼回 → 改寫 → 勾選 → 監測 → 新財報成立時通知，整條一個測試
//   解析的每條規則（程式碼圍欄、代號不符、動作不認得、超過上限、找不到標記）
//   前提的對應（沿用編號、新的、撤下）
//   討論包沒有金額與股數、12,000 字以內
//   改寫失敗有提示、可以重送
//   前提有增減隔天開審查、30 天內第二次不開
//   草擬模式的入口不存在
// 另外：BREAK 情境與 replyTo（log 記 replyTo）、§3.8 持股頁與討論包的那一句、出場條件不存成前提。
// 對外請求全部是假的：價格、成分股（固定檔）、EDGAR、Nasdaq RSS、雲端排程、LINE。
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DISCUSSION_V3, MAX_PACK_CHARS, discussionPack, parseThesisBlock, pickMode, type DiscussionNumbers } from '../src/ai/discussion';
import { OWN_CHECK, ownCheckPack } from '../src/ai/ownCheck';
import type { ApplyCtx } from '../src/app/aiCtx';
import { finalizeRun, getRun, listRuns } from '../src/app/aiRuns';
import { breakInfo } from '../src/app/discussion';
import type { Env, Fetcher } from '../src/app/env';
import { runFlow, type Attempt } from '../src/app/flow';
import { LINE_PUSH_URL } from '../src/app/line';
import { loadAccount, saveAccount } from '../src/app/ledgerStore';
import { ownXbrlConditions } from '../src/app/ownAi';
import { monitorView } from '../src/app/ownCheckAi';
import { loadConditions, metaFile, type ThesisFile } from '../src/app/thesis';
import type { CompanyFacts, QuarterRow, XbrlFact } from '../src/data/edgar';
import { buildMarketView } from '../src/data/marketView';
import { loadSeries } from '../src/data/store';
import { SYSTEM_DEFAULT_PREMISES, breakNotice, createAccount, mapPremises, setThesis, type Account, type MarketView } from '../src/engine';
import { handle } from '../src/index';
import { freshDb } from './helpers/d1';
import { cronTime, fakeFetcher, newWorld, type World } from './helpers/fakeSources';

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- 假的世界（和 T26 的測試同一套寫法）

function quarterFacts(qs: { end: string; rev: number; filed: string }[]): CompanyFacts {
  const rev: XbrlFact[] = qs.map((q) => {
    const [y, m] = q.end.split('-').map(Number);
    return { start: `${y}-${String(m - 2).padStart(2, '0')}-01`, end: q.end, val: q.rev, accn: `acc-${q.filed}`, form: '10-Q', filed: q.filed };
  });
  return { cik: 1045810, facts: { 'us-gaap': { Revenues: { units: { USD: rev } } } } };
}
const BASE = quarterFacts([
  { end: '2025-06-30', rev: 110, filed: '2025-08-01' },
  { end: '2025-09-30', rev: 120, filed: '2025-11-01' },
  { end: '2026-06-30', rev: 150, filed: '2026-08-01' },
  { end: '2026-09-30', rev: 160, filed: '2026-10-30' },
]);
const TENQ = `<html><body><p>Item 2. Management’s Discussion and Analysis</p><p>Revenue for the third quarter was $160 million. Gross margin was 60.0%, down from 70.0% a year ago.</p><p>Item 3. Quantitative</p></body></html>`;
const TENQ_FILING = { accession: '0001045810-26-000300', form: '10-Q', items: '', acceptanceDateTime: '2026-10-30T20:10:00.000Z', filingDate: '2026-10-30', primaryDocument: 'q.htm', html: TENQ };

function fetcherOf(w: World, line: string[]): Fetcher {
  const base = fakeFetcher(w);
  return async (url, init) => {
    if (url === LINE_PUSH_URL) {
      line.push((JSON.parse(String(init?.body)) as { messages: { text: string }[] }).messages[0].text);
      return Response.json({});
    }
    if (url === 'https://api.example/fire') return Response.json({ claude_code_session_url: 'https://claude.ai/code/x' });
    if (/data\.sec\.gov\/submissions\/CIK\d+\.json/.test(url)) {
      const f = TENQ_FILING;
      return Response.json({ cik: '1045810', name: 'NVIDIA CORP', tickers: ['NVDA'], filings: { recent: { accessionNumber: [f.accession], form: [f.form], items: [f.items], acceptanceDateTime: [f.acceptanceDateTime], filingDate: [f.filingDate], primaryDocument: [f.primaryDocument] } } });
    }
    if (/companyfacts\/CIK\d+\.json/.test(url)) return Response.json(BASE);
    const doc = /Archives\/edgar\/data\/\d+\/(\d+)\/(.+)$/.exec(url);
    if (doc) return doc[2] === 'index.json' ? Response.json({ directory: { item: [{ name: TENQ_FILING.primaryDocument }] } }) : new Response(TENQ_FILING.html);
    if (url.startsWith('https://www.nasdaq.com/feed/rssoutbound')) return new Response('<rss><channel></channel></rss>');
    return base(url, init);
  };
}

interface Ctx {
  db: D1Database;
  env: Env;
  fetcher: Fetcher;
  line: string[];
  run: (date: string, attempt?: Attempt) => ReturnType<typeof runFlow>;
  viewAt: (date: string) => Promise<{ view: MarketView; axis: string[] }>;
  /** 打網站的 API（真實模式）。 */
  api: <T = Record<string, unknown>>(method: 'GET' | 'POST', path: string, body?: unknown, now?: Date) => Promise<{ status: number; body: T }>;
}

const USER_PREMISES = [
  { id: 'P1', text: '資料中心需求延續到 2027', origin: 'USER' as const },
  { id: 'P2', text: '毛利率維持在 65% 以上', origin: 'USER' as const },
];

async function withWorld(fn: (c: Ctx) => Promise<void>, opt: { routine?: boolean; premises?: typeof USER_PREMISES | null; acct?: (a: Account) => Account } = {}) {
  const d = await freshDb();
  try {
    const db = d.db;
    const w = newWorld('2026-11-19');
    const line: string[] = [];
    const env: Env = { DB: db, ADMIN_TOKEN: 't', AI_TASK_SECRET: 's', EDGAR_USER_AGENT: 'test bot test@example.com', SITE_URL: 'https://bot.example', LINE_CHANNEL_TOKEN: 'lt', LINE_USER_ID: 'U1', DEV_NO_AUTH: '1', ...(opt.routine === false ? {} : { ROUTINE_FIRE_URL: 'https://api.example/fire', ROUTINE_TOKEN: 'rt' }) };
    const fetcher = fetcherOf(w, line);
    const run = (date: string, attempt: Attempt = 'FIRST') => {
      w.dataDate = date;
      return runFlow(env, fetcher, { now: attempt === 'FINAL' ? new Date(Date.parse(date + 'T23:30:00Z') + 2 * 3600_000) : cronTime(date), attempt });
    };
    const viewAt = async (date: string) => buildMarketView(await loadSeries(db, ['VOO', 'SGOV', 'NVDA']), date, 'VOO');
    const api: Ctx['api'] = async (method, path, body, now = new Date('2026-11-20T02:00:00Z')) => {
      const r = await handle(new Request(`https://bot.example/api/${path}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env, fetcher, now);
      return { status: r.status, body: (await r.json()) as never };
    };
    await run('2026-11-19');
    const { view } = await viewAt('2026-11-19');
    let acct = createAccount(
      {
        paper: true,
        cash: 5000,
        core: { VOO: Math.floor(140_000 / view.close.VOO[view.i]) },
        own: { NVDA: { shares: Math.floor(40_000 / view.close.NVDA[view.i]), stdWeight: 0.15, premises: opt.premises === null ? structuredClone(SYSTEM_DEFAULT_PREMISES) : (opt.premises ?? USER_PREMISES) } },
      },
      view,
    );
    if (opt.acct) acct = opt.acct(acct);
    await saveAccount(db, acct, null, '建立帳戶', new Date('2026-11-19T12:00:00Z'));
    await fn({ db, env, fetcher, line, run, viewAt, api });
  } finally {
    await d.dispose();
  }
}

const FILE = 'NVDA@2026-11-19';
const GM = (level: number, quarters = 1) => ({ type: 'xbrl_metric_below', metric: 'GrossMarginPct', level, quarters });
const block = (ticker: string, body: string) => `===STOCKBOT 論點 v1 ${ticker}===\n${body}\n===END===`;
const BLOCK = block(
  'NVDA',
  ['論點：', 'AI 訓練與推論的需求會延續到 2027，NVIDIA 的軟體生態讓客戶換不走。', '前提：', '1. 資料中心需求延續到 2027', '2. 毛利率維持在 70% 以上', '出場條件：', '1. 毛利率連兩季低於 58% → 出清', '2. 公司在 8-K 下修全年財測 → 減半', '這次的結論：修正論點', '理由：毛利率門檻寫得更具體。'].join('\n'),
);

async function postResult(db: D1Database, runId: string, samples: unknown[], at: Date) {
  const run = (await getRun(db, runId))!;
  const task = await db.prepare('SELECT * FROM ai_tasks WHERE id = ?').bind(run.taskId).first();
  return finalizeRun(db, task as never, { samples }, at);
}
const thesisLog = async (db: D1Database) => (await db.prepare("SELECT body, account_version, session FROM own_thesis_log WHERE kind = 'THESIS' ORDER BY id").all<{ body: string; account_version: number | null; session: string }>()).results.map((r) => ({ ...r, body: JSON.parse(r.body) as Record<string, unknown> }));
function qrow(end: string, gm: number): QuarterRow {
  return { end, filed: end.replace(/-\d\d$/, '-28'), form: '10-Q', accn: 'a', revenue: 100, grossProfit: gm * 100, operatingIncome: null, netIncome: null, epsDiluted: null, cfo: null, grossMarginPct: gm, operatingMarginPct: null, netMarginPct: null, revenueYoY: null, cfoToNetIncome: null };
}

// ---------------------------------------------------------------- 整條

describe('T27：貼回 → 改寫 → 勾選 → 監測 → 新財報成立時通知', () => {
  it('整條：解析貼回的區塊、存論點（log THESIS）、出場條件送去改寫、持股頁勾選（改動作）、新財報成立 → 當天通知', async () => {
    await withWorld(async (c) => {
      // 1. 貼回、解析
      const p = await c.api<ReturnType<typeof parseThesisBlock>>('POST', 'ops/own-thesis/parse', { ticker: 'NVDA', text: '```\n' + BLOCK + '\n```' });
      expect(p.status).toBe(200);
      expect(p.body).toMatchObject({ found: true, error: null, premises: ['資料中心需求延續到 2027', '毛利率維持在 70% 以上'], conclusion: '修正論點' });
      // 2. 預覽（不存）：P1 文字相同沿用，P2 改了字是新的（P3），舊的 P2 撤下
      const payload = { ticker: 'NVDA', thesis: p.body.thesis, premises: p.body.premises.map((text) => ({ text })), exitConditions: p.body.exits.map((x) => ({ text: x.text, action: x.action })), source: 'DISCUSSION' };
      const dry = await c.api<{ preview: { kept: { id: string }[]; added: { id: string }[]; retired: { id: string }[]; changed: boolean } }>('POST', 'ops/own-thesis', { ...payload, dry: true });
      expect(dry.body.preview).toMatchObject({ kept: [{ id: 'P1' }], added: [{ id: 'P3' }], retired: [{ id: 'P2' }], changed: true });
      expect((await loadAccount(c.db))!.acct.own.NVDA.thesis).toBeNull(); // 預覽不存
      // 3. 確認：論點與前提立刻存好；出場條件送去改寫
      const now = new Date('2026-11-20T02:00:00Z');
      const saved = await c.api<{ rewrite: { status: string; runId: string } }>('POST', 'ops/own-thesis', payload, now);
      expect(saved.status).toBe(200);
      expect(saved.body.rewrite.status).toBe('SENT');
      const acct = (await loadAccount(c.db))!.acct;
      expect(acct.own.NVDA.thesis).toMatchObject({ text: p.body.thesis, source: 'DISCUSSION', version: 1, setAt: '2026-11-19', afterBreak: 0 });
      expect(acct.own.NVDA.premises.map((x) => [x.id, x.text, x.origin])).toEqual([
        ['P1', '資料中心需求延續到 2027', 'USER'],
        ['P3', '毛利率維持在 70% 以上', 'USER'],
      ]);
      // 出場條件不存成前提
      expect(acct.own.NVDA.premises.some((x) => x.text.includes('下修'))).toBe(false);
      expect(acct.own.NVDA.thesisReviewDue).toBe('2026-11-19');
      const [log] = await thesisLog(c.db);
      expect(log.body).toMatchObject({ version: 1, source: 'DISCUSSION', retired: ['P2'], afterBreak: false, replyTo: null, exitLines: ['毛利率連兩季低於 58%', '公司在 8-K 下修全年財測'], exitActions: ['EXIT', 'HALF'] });
      expect((log.body.before as { premises: unknown[] }).premises).toHaveLength(2);
      expect(log.account_version).not.toBeNull();
      // 改寫的證據包：v2、帶論點、前提與使用者選的動作
      const run = (await getRun(c.db, saved.body.rewrite.runId))!;
      expect(run.fn).toBe(OWN_CHECK);
      expect(run.pack.prompt_version).toBe('own_check_v4'); // T42：整組取代、每一條標 same／supersedes
      expect(run.pack.facts.filter((f) => f.id.startsWith('U')).map((f) => [f.label, f.value])).toEqual([
        ['使用者要的出場條件（整組取代目前監測中的；成立時：出清）', '毛利率連兩季低於 58%'],
        ['使用者要的出場條件（整組取代目前監測中的；成立時：減半）', '公司在 8-K 下修全年財測'],
      ]);
      expect(run.pack.premises.map((x) => x.id)).toEqual(['P1', 'P3']);
      expect(run.pack.documents.some((d) => d.source_id === `thesis:${FILE}` && d.text.includes('換不走'))).toBe(true);
      expect(run.pack.question).toContain('持有自選股 NVDA');
      // 4. 改寫回來（一票）
      const price = run.pack.documents.find((d) => d.source_id === 'price:NVDA')!;
      await postResult(
        c.db,
        run.runId,
        [
          {
            run_id: run.runId,
            verdict: 'DONE',
            evidence: [{ id: 'E1', source_id: 'price:NVDA', date: price.date, quote: price.text.split('\n').at(-1)!, claim: '最新收盤' }],
            payload: {
              conditions: [
                { id: 'C1', line: 'U1', direction: 'DOWN', kind: 'XBRL', text: '毛利率連兩季低於 58%', check: GM(0.58, 2), basis: ['E1'], tier_if_met: 'EXIT' },
                { id: 'C2', line: 'U2', direction: 'DOWN', kind: 'EVENT', text: '公司在 8-K 下修全年財測', check: { type: 'event', confirm_by: ['8-K'] }, basis: ['E1'], tier_if_met: 'HALF' },
              ],
            },
            report: '改寫了兩條。',
          },
        ],
        new Date('2026-11-20T02:10:00Z'),
      );
      // 5. 持股頁：列出還沒勾的改寫結果，動作帶使用者選的
      type Rw = { rewrites: { results: { runId: string; accepted: string[]; conditions: { condId: string; action: string; from: string }[] }[]; unsent: unknown } };
      let h = await c.api<Rw>('GET', 'holding/NVDA', undefined, new Date('2026-11-20T03:00:00Z'));
      expect(h.body.rewrites.unsent).toBeNull();
      expect(h.body.rewrites.results).toHaveLength(1);
      expect(h.body.rewrites.results[0].conditions.map((x) => [x.condId, x.action, x.from])).toEqual([
        ['U1', 'EXIT', '毛利率連兩季低於 58%'],
        ['U2', 'HALF', '公司在 8-K 下修全年財測'],
      ]);
      // 6. 勾第一條，改成減半
      const acc = await c.api<{ added: number }>('POST', 'ops/own-conditions', { ticker: 'NVDA', runId: run.runId, ids: ['U1'], actions: { U1: 'HALF' } }, new Date('2026-11-20T03:05:00Z'));
      expect(acc.body.added).toBe(1);
      const mon = await monitorView(c.env, 'NVDA');
      expect(mon.map((m) => [m.text, m.code, m.action, m.owned])).toEqual([['毛利率連兩季低於 58%', 'ACTIVE', 'HALF', true]]);
      h = await c.api<Rw>('GET', 'holding/NVDA', undefined, new Date('2026-11-20T03:10:00Z'));
      // T42：確認是一次做完（勾選的開始監測、沒勾的不監測），這一版確認過就不再列（原本：勾過的標出來、沒勾的那一條還在）
      expect(h.body.rewrites.results).toEqual([]);
      // 7. 新財報：連兩季低於 58% → 成立、當天通知
      const { view, axis } = await c.viewAt('2026-11-19');
      const ctx: ApplyCtx = { db: c.db, acct: (await loadAccount(c.db))!.acct, view, axis, session: '2027-02-05', now: new Date('2027-02-05T23:40:00Z'), stmts: [], log: [] };
      await ownXbrlConditions(ctx, new Map([['NVDA', [qrow('2026-12-31', 0.55), qrow('2026-09-30', 0.56), qrow('2026-06-30', 0.6)]]]));
      await c.db.batch(ctx.stmts);
      const cond = (await loadConditions(c.db, 'NVDA')).find((x) => x.condId === 'U1')!;
      expect(cond).toMatchObject({ status: 'MET', metBasis: 'XBRL', origin: 'USER', action: 'HALF', fileId: FILE });
      expect(ctx.acct.notifs.some((n) => n.kind === 'URGENT' && n.items.some((i) => i.ticker === 'NVDA'))).toBe(true);
    });
  });
});

// ---------------------------------------------------------------- 解析

describe('T27：parseThesisBlock 的每條規則（§1.8）', () => {
  it('程式碼圍欄去掉；全形或半形冒號；標籤後面同一行的內容也算', () => {
    const p = parseThesisBlock('前面的聊天\n```text\n' + block('NVDA', '論點: 一句話的論點\n前提:\n1) 第一條\n2、第二條\n出場條件：\n1. 毛利率低於 70% -> 出清\n這次的結論：維持\n理由: 沒變') + '\n```\n後面', 'nvda');
    expect(p).toMatchObject({ found: true, error: null, thesis: '一句話的論點', premises: ['第一條', '第二條'], exits: [{ text: '毛利率低於 70%', action: 'EXIT', guessed: false }], conclusion: '維持', reason: '沒變', notes: [] });
  });

  it('代號不符 → 擋下並說明', () => {
    const p = parseThesisBlock(block('MU', '論點：x'), 'NVDA');
    expect(p.found).toBe(true);
    expect(p.error).toBe('這段是 MU 的論點，這一頁是 NVDA。請貼這一檔的討論結果。');
    expect(p.thesis).toBe('');
  });

  it('動作不認得或沒寫 → 當成重新審查並標出來；用最後一個箭頭切', () => {
    const p = parseThesisBlock(block('NVDA', '出場條件：\n1. 營收 → 年增轉負 → 賣掉\n2. 毛利率低於 60%\n3. 執行長離職 → 重新審查。'), 'NVDA');
    expect(p.exits).toEqual([
      { text: '營收 → 年增轉負', action: 'REVIEW', guessed: true },
      { text: '毛利率低於 60%', action: 'REVIEW', guessed: true },
      { text: '執行長離職', action: 'REVIEW', guessed: false },
    ]);
    expect(p.notes).toEqual(['出場條件第 1 條的動作「賣掉」不認得，先當成「重新審查」', '出場條件第 2 條的動作沒寫，先當成「重新審查」']);
  });

  it('超過上限 → 截掉並標出來（論點 600 字、前提 5 條各 200 字、出場條件 6 條各 300 字）；沒編號的行不算', () => {
    const body = ['論點：', 'a'.repeat(650), '前提：', ...Array.from({ length: 6 }, (_, k) => `${k + 1}. ${k === 0 ? 'p'.repeat(210) : `前提 ${k + 1}`}`), '- 沒有編號的一行', '出場條件：', ...Array.from({ length: 7 }, (_, k) => `${k + 1}. ${k === 0 ? 'e'.repeat(310) : `條件 ${k + 1}`} → 減半`)].join('\n');
    const p = parseThesisBlock(block('NVDA', body), 'NVDA');
    expect(p.thesis).toHaveLength(600);
    expect(p.premises).toHaveLength(5);
    expect(p.premises[0]).toHaveLength(200);
    expect(p.exits).toHaveLength(6);
    expect(p.exits[0].text).toHaveLength(300);
    expect(p.notes).toEqual([
      '論點超過 600 字，後面截掉了',
      '前提有 1 行沒有編號，沒有算進去',
      '前提超過 5 條，只留前 5 條',
      '前提第 1 條超過 200 字，後面截掉了',
      '出場條件超過 6 條，只留前 6 條',
      '出場條件第 1 條超過 300 字，後面截掉了',
    ]);
  });

  it('找不到標記（或沒有結尾）→ 整段放進論點欄、提示自己分；有好幾個區塊取最後一個', () => {
    const none = parseThesisBlock('我覺得 NVDA 還可以\n毛利率很高', 'NVDA');
    expect(none).toMatchObject({ found: false, error: null, thesis: '我覺得 NVDA 還可以\n毛利率很高', premises: [], exits: [], notes: ['沒找到固定格式，請自己分到三欄'] });
    expect(parseThesisBlock('===STOCKBOT 論點 v1 NVDA===\n論點：沒有結尾', 'NVDA').found).toBe(false);
    const two = parseThesisBlock(block('NVDA', '論點：第一版') + '\n討論繼續\n' + block('NVDA', '論點：第二版'), 'NVDA');
    expect(two.thesis).toBe('第二版');
  });
});

// ---------------------------------------------------------------- 前提的對應

describe('T27：前提的對應（沿用編號、新的、撤下；§1.8）', () => {
  const meta = { premises: [{ id: 'P1', text: '資料中心需求延續到 2027', origin: 'USER' as const, addedAt: '2026-11-01' }, { id: 'P4', text: 'HBM 長約有價格保護', origin: 'AI_DRAFT_ACCEPTED' as const, addedAt: '2026-11-02' }], premiseSeq: 6 };

  it('文字相同（去掉空白與標點）→ 沿用編號與來源；改了字的是新的；沒對到的撤下；新編號接著 premiseSeq、不重用', () => {
    const m = mapPremises(meta, [{ text: 'HBM 長約，有價格保護。' }, { text: '資料中心需求延續到 2028' }], '2026-11-20');
    expect(m.premises).toEqual([
      { id: 'P4', text: 'HBM 長約，有價格保護。', origin: 'AI_DRAFT_ACCEPTED', addedAt: '2026-11-02' },
      { id: 'P6', text: '資料中心需求延續到 2028', origin: 'USER', addedAt: '2026-11-20' },
    ]);
    expect(m.kept).toEqual(['P4']);
    expect(m.added).toEqual(['P6']);
    expect(m.retired.map((p) => p.id)).toEqual(['P1']);
    expect(m.premiseSeq).toBe(7);
  });

  it('帶 id（預覽裡改字）→ 沿用那一條；同一條不會被沿用兩次', () => {
    const m = mapPremises(meta, [{ id: 'P1', text: '資料中心需求延續到 2028' }, { text: '資料中心需求延續到 2027' }], '2026-11-20');
    expect(m.premises.map((p) => p.id)).toEqual(['P1', 'P6']);
    expect(m.retired.map((p) => p.id)).toEqual(['P4']);
  });

  it('原本只有系統預設：寫了自己的前提就整組換掉；原樣送回預設或一條都沒寫 → 照舊；原本有你的前提卻一條都沒寫 → 擋下', () => {
    const def = { premises: structuredClone(SYSTEM_DEFAULT_PREMISES), premiseSeq: 4 };
    const m = mapPremises(def, [{ text: SYSTEM_DEFAULT_PREMISES[1].text }, { text: '我的第一條' }], '2026-11-20');
    expect(m.premises).toEqual([{ id: 'P4', text: '我的第一條', origin: 'USER', addedAt: '2026-11-20' }]);
    expect(m.retired.map((p) => p.id)).toEqual(['P1', 'P2', 'P3']);
    expect(mapPremises(def, SYSTEM_DEFAULT_PREMISES.map((p) => ({ text: p.text })), '2026-11-20')).toMatchObject({ added: [], retired: [], kept: ['P1', 'P2', 'P3'] });
    expect(mapPremises(def, [], '2026-11-20').retired).toEqual([]);
    expect(() => mapPremises(meta, [{ text: '  ' }], '2026-11-20')).toThrow('至少要留一條前提');
  });

  it('setThesis：version 加 1；只改論點本文不算前提變動（不記 thesisReviewDue）', async () => {
    await withWorld(async (c) => {
      const acct = (await loadAccount(c.db))!.acct;
      const a = setThesis(acct, 'NVDA', { text: '第一版', source: 'TYPED', premises: USER_PREMISES, date: '2026-11-20' });
      expect(a.changed).toBe(false);
      expect(a.acct.own.NVDA.thesis).toMatchObject({ text: '第一版', version: 1 });
      expect(a.acct.own.NVDA.thesisReviewDue).toBeUndefined();
      const b = setThesis(a.acct, 'NVDA', { text: '第二版', source: 'DISCUSSION', premises: [...USER_PREMISES, { id: null, text: '新的一條' }], date: '2026-11-21' });
      expect(b.changed).toBe(true);
      expect(b.acct.own.NVDA.thesis).toMatchObject({ text: '第二版', version: 2, source: 'DISCUSSION', setAt: '2026-11-21' });
      expect(b.acct.own.NVDA.thesisReviewDue).toBe('2026-11-21');
      expect(acct.own.NVDA.thesis).toBeNull(); // 純函式，不改原本的
    });
  });
});

// ---------------------------------------------------------------- 討論包

const NUMS: DiscussionNumbers = { date: '2026-11-19', close: 181.23, fromHigh: -0.12, ma200: 160.5, vsMa: 0.129, slow: 'STD', ret1y: 0.42, weight: 0.062, stdWeight: 0.05, ownTotal: 0.23, ownBudget: 0.2, xbrl: 'NVDA quarterly figures\n2026-09-30: revenue 160M', openedHalf: null };

describe('T27：討論包（§1.7）', () => {
  it('網站 API：沒有金額與股數；只有比重；12,000 字以內；固定指示照抄、收尾格式換成這一檔的代號；情境由程式選', async () => {
    await withWorld(async (c) => {
      const acct = (await loadAccount(c.db))!.acct;
      const shares = acct.lots.own.NVDA;
      const r = await c.api<{ text: string; mode: string }>('GET', 'own/NVDA/discussion');
      expect(r.status).toBe(200);
      expect(r.body.mode).toBe('ROUTINE');
      const t = r.body.text;
      expect(t.length).toBeLessThanOrEqual(MAX_PACK_CHARS);
      expect(t).not.toMatch(/\$/);
      expect(t).not.toMatch(/\d[\d,]*\s*股/);
      expect(t).not.toContain(String(shares));
      expect(t).not.toContain(shares.toLocaleString('en-US'));
      expect(t).toMatch(/比重：占總資產 \d+\.\d%，標準比重 15\.0%；自選桶合計 \d+%（預算 20%）/);
      // T42：固定指示升成 discussion_v3（第 8 點：前提帶編號、出場條件寫全部；第 9 點是收尾格式）、區塊標記 v3、前提帶「P1.」
      expect(t).toContain('# NVDA 論點討論包（stock bot，2026-11-19，discussion_v3）');
      expect(t).toContain(DISCUSSION_V3.slice(0, DISCUSSION_V3.indexOf('\n9. ')).trim());
      expect(t).toContain('===STOCKBOT 論點 v3 NVDA===');
      expect(t).not.toContain('<代號>');
      expect(t).toContain('P1. 資料中心需求延續到 2027');
      expect(t).toContain('例行檢視。請先挑出論點裡最弱的一條前提');
      expect(t).toContain('2026-09-30'); // 財報表：沒有審查時當場抓一次 XBRL
      // 情境：mode 參數、不認得的回 422
      expect((await c.api<{ mode: string }>('GET', 'own/NVDA/discussion?mode=NEW')).body.mode).toBe('NEW');
      expect((await c.api('GET', 'own/NVDA/discussion?mode=XX')).status).toBe(422);
      expect((await c.api('GET', 'own/AAPL/discussion')).status).toBe(422);
      // 示範模式也拿得到（只用帳戶狀態）
      const demo = await handle(new Request('https://bot.example/demo/api/own/MU/discussion'), c.env, c.fetcher, new Date('2026-11-20T02:00:00Z'));
      const dt = ((await demo.json()) as { text: string }).text;
      expect(dt).toContain('# MU 論點討論包');
      expect(dt).not.toMatch(/\$|\d[\d,]*\s*股/);
    });
  });

  it('塞到最滿也在 12,000 字以內（事件最多 10 件、審查最多 3 次、財報表先縮）', () => {
    const base = metaFile({ own: { NVDA: { premises: Array.from({ length: 5 }, (_, k) => ({ id: `P${k + 1}`, text: 'x'.repeat(200), origin: 'USER' })), thesis: { text: 't'.repeat(600), setAt: '2026-11-01', source: 'TYPED', version: 3, afterBreak: 1, lastAfterBreakAt: null }, fileId: FILE, origin: 'NEW', flags: [] } as never } }, 'NVDA', '2026-11-19')!;
    const file: ThesisFile = {
      ...base,
      conditions: Array.from({ length: 11 }, (_, k) => ({ id: k, ticker: 'NVDA', runId: 'r', condId: `C${k}`, direction: 'DOWN', kind: 'XBRL', text: 'c'.repeat(300), check: GM(0.5), tierIfMet: 'HALF', status: k < 8 ? 'ACTIVE' : 'PROPOSED', createdAt: '2026-11-01T00:00:00Z', metAt: null, note: null, origin: k < 8 ? 'USER' : 'AI', fileId: FILE, acceptedAt: '2026-11-01T00:00:00Z', action: 'EXIT', premiseId: null, supersedes: null, metBasis: null, verifiedAt: null, progress: null, auto: true })) as never,
      events: Array.from({ length: 30 }, (_, k) => ({ id: k, date: '2026-11-10', source: 'SCAN', code: 'MGMT_CHANGE', sub: 'CEO_DEPART', form: '8-K', sourceId: 'edgar:x', accession: 'x', detail: 'd'.repeat(500), status: 'NEW', displayOnly: false, createdAt: 'x', isNew: true })),
      reviews: Array.from({ length: 8 }, (_, k) => ({ runId: `r${k}`, date: '2026-11-10', fn: 'OWN_REVIEW', label: '定期審查', trigger: 'MONTHLY', status: 'AGREED', verdict: 'HOLD', votes: { HOLD: 3 }, brokenPremises: ['P1', 'P2'], notif: 3, response: { outcome: 'DISAGREE', reason: 'r'.repeat(200) }, premiseVotes: {}, summary: 's'.repeat(400) })),
    };
    const huge = { ...NUMS, xbrl: Array.from({ length: 200 }, (_, k) => `2026-0${(k % 9) + 1}-30 (10-Q filed x): revenue ${k}M, gross margin 70.0%, operating margin 40.0%`).join('\n') };
    const t = discussionPack(file, huge, 'ROUTINE');
    expect(t.length).toBeLessThanOrEqual(MAX_PACK_CHARS);
    expect(t).toContain('===STOCKBOT 論點 v3 NVDA==='); // T42：區塊標記 v3
    expect(t.match(/MGMT|高層異動/g)!.length).toBe(10);
    expect(t.match(/月審：/g)!.length).toBe(3);
    expect(t).toContain('失效後修改第 1 次');
  });

  it('三種情境的文字；開檔時是減半的股票 NEW 多一句；BREAK 帶依據與第幾次', () => {
    const own = { NVDA: { premises: structuredClone(SYSTEM_DEFAULT_PREMISES), thesis: null, fileId: FILE, origin: 'NEW', flags: [] } as never };
    const f = metaFile({ own }, 'NVDA', '2026-11-19')!;
    expect(pickMode(f)).toBe('NEW');
    expect(pickMode(f, 12)).toBe('BREAK');
    expect(pickMode({ ...f, kind: 'THESIS' })).toBe('ROUTINE');
    const n = discussionPack(f, { ...NUMS, openedHalf: -0.23 }, 'NEW');
    expect(n).toContain('我持有這檔，但還沒有寫下論點。請先問我 3 個問題');
    expect(n).toContain('這檔是在大跌之後買的（加入時比 52 週高點低 23%）。\n請先問我：它為什麼跌、為什麼我認為市場錯了。');
    expect(n).toContain('（這些是系統預設的一般健康檢查，不是我的論點。）');
    expect(n).toContain('## 我的論點\n還沒有');
    expect(discussionPack(f, NUMS, 'NEW')).not.toContain('大跌之後');
    const b = discussionPack({ ...f, thesis: { text: 'x', setAt: '2026-11-01', source: 'TYPED', version: 1, afterBreak: 1, lastAfterBreakAt: null } }, NUMS, 'BREAK', { notif: 12, premiseId: 'P2', premiseText: '營收年增率沒有連兩季是負的', tier: 'HALF', quote: 'Revenue decreased 12%', source: '8-K（2027-01-06）' });
    expect(b).toContain('stock bot 的審查（3 票一致）認為前提 P2「營收年增率沒有連兩季是負的」不成立，建議減半。它的依據：\n「Revenue decreased 12%」— 8-K（2027-01-06）\n我還沒決定。這是我第 2 次在前提被判不成立之後討論這檔的論點。');
  });

  it('BREAK 的依據：通知上的 AI 項目（檔位、執行）→ 審查判不成立的前提；找不到原文時寫在網站', async () => {
    const acct = { own: { NVDA: { premises: USER_PREMISES, aiTier: { tier: 'EXIT', date: '2026-11-19', suggest: true, premiseId: 'P2', runId: 'rv1' } } }, notifs: [{ id: 7, items: [{ ticker: 'NVDA', f: 'F24', choices: [{ id: 'AI', tier: 'HALF' }], runIds: ['rv1'] }] }] } as unknown as Account;
    const f = metaFile(acct, 'NVDA', '2026-11-19')!;
    const info = await breakInfo(null, acct, f, 7);
    expect(info).toEqual({ notif: 7, premiseId: 'P2', premiseText: '毛利率維持在 65% 以上', tier: 'HALF', quote: null, source: null });
    expect(discussionPack(f, NUMS, 'BREAK', info)).toContain('認為前提 P2「毛利率維持在 65% 以上」不成立，建議減半。它的依據：\n（引用的原文在 stock bot 網站的審查紀錄）');
  });
});

// ---------------------------------------------------------------- 改寫失敗

describe('T27：改寫失敗有提示、可以重送（N9）', () => {
  it('AI 層沒設定 → 論點照存、回 FAILED 與原因；持股頁一直提示「還沒送去改寫」；重送成功後提示消失；改寫沒有結果 → 列出來、可以重送', async () => {
    await withWorld(
      async (c) => {
        const t0 = new Date('2026-11-20T02:00:00Z');
        const r = await c.api<{ rewrite: { status: string; error: string }; exits: unknown[] }>('POST', 'ops/own-thesis', { ticker: 'NVDA', thesis: '論點', premises: USER_PREMISES, exitConditions: [{ text: '毛利率低於 58%', action: 'EXIT' }], source: 'TYPED' }, t0);
        expect(r.status).toBe(200);
        expect(r.body.rewrite.status).toBe('FAILED');
        expect(r.body.rewrite.error).toContain('雲端排程還沒設定');
        expect(r.body.exits).toEqual([{ text: '毛利率低於 58%', action: 'EXIT' }]);
        expect((await loadAccount(c.db))!.acct.own.NVDA.thesis?.text).toBe('論點'); // 論點照存
        type Rw = { rewrites: { results: { runId: string; status: string; failed: boolean; exits: unknown[] }[]; unsent: { exits: unknown[] } | null } };
        let h = await c.api<Rw>('GET', 'holding/NVDA', undefined, new Date('2026-11-20T03:00:00Z'));
        expect(h.body.rewrites.unsent).toMatchObject({ exits: [{ text: '毛利率低於 58%', action: 'EXIT' }] });
        // 之後只改論點本文（沒有出場條件）：剛才沒送出去的提示還在
        await c.api('POST', 'ops/own-thesis', { ticker: 'NVDA', thesis: '論點第二版', premises: USER_PREMISES, exitConditions: [] }, new Date('2026-11-20T03:30:00Z'));
        h = await c.api<Rw>('GET', 'holding/NVDA', undefined, new Date('2026-11-20T03:40:00Z'));
        expect(h.body.rewrites.unsent).not.toBeNull();
        // 設定好雲端排程之後重送
        c.env.ROUTINE_FIRE_URL = 'https://api.example/fire';
        c.env.ROUTINE_TOKEN = 'rt';
        const re = await c.api<{ runId: string }>('POST', 'ops/own-check', { ticker: 'NVDA', exits: h.body.rewrites.unsent!.exits }, new Date('2026-11-20T04:00:00Z'));
        expect(re.status).toBe(200);
        h = await c.api<Rw>('GET', 'holding/NVDA', undefined, new Date('2026-11-20T04:05:00Z'));
        expect(h.body.rewrites.unsent).toBeNull();
        expect(h.body.rewrites.results.map((x) => [x.runId, x.status, x.failed])).toEqual([[re.body.runId, 'PENDING', false]]);
        // 改寫回來但沒有結果（格式不合格）→ 列成失敗、帶當時的出場條件可以重送
        await postResult(c.db, re.body.runId, [{ run_id: re.body.runId, verdict: 'NOPE' }], new Date('2026-11-20T04:10:00Z'));
        h = await c.api<Rw>('GET', 'holding/NVDA', undefined, new Date('2026-11-20T04:20:00Z'));
        expect(h.body.rewrites.results.map((x) => [x.runId, x.failed, x.exits])).toEqual([[re.body.runId, true, [{ text: '毛利率低於 58%', action: 'EXIT' }]]]);
        // 再重送一次 → 之前失敗的那次不再列
        const re2 = await c.api<{ runId: string }>('POST', 'ops/own-check', { ticker: 'NVDA', exits: [{ text: '毛利率低於 58%', action: 'EXIT' }] }, new Date('2026-11-20T04:30:00Z'));
        h = await c.api<Rw>('GET', 'holding/NVDA', undefined, new Date('2026-11-20T04:35:00Z'));
        expect(h.body.rewrites.results.map((x) => x.runId)).toEqual([re2.body.runId]);
        // 30 天以前的不列
        h = await c.api<Rw>('GET', 'holding/NVDA', undefined, new Date('2026-12-25T00:00:00Z'));
        expect(h.body.rewrites.results).toEqual([]);
      },
      { routine: false },
    );
  });
});

// ---------------------------------------------------------------- 論點變動後的審查

describe('T27：前提有增減 → 下一次每日第一次流程開審查（觸發原因 THESIS），每檔 30 天 1 次（§3.6.5）', () => {
  it('隔天開審查並記 thesisReviewAt；30 天內再改前提 → 只清掉、不開；只改論點本文不開', async () => {
    await withWorld(async (c) => {
      const thesisRuns = async () => (await listRuns(c.db, new Date('2026-11-01T00:00:00Z'), { limit: 200 })).filter((r) => r.fn === 'OWN_REVIEW' && (r.pack.rule.detail as { trigger?: string }).trigger === 'THESIS');
      // 只改論點本文：不記
      await c.api('POST', 'ops/own-thesis', { ticker: 'NVDA', thesis: '只改本文', premises: USER_PREMISES, exitConditions: [] });
      expect((await loadAccount(c.db))!.acct.own.NVDA.thesisReviewDue).toBeUndefined();
      // 加一條前提 → 記下；隔天的每日流程開審查
      await c.api('POST', 'ops/own-thesis', { ticker: 'NVDA', thesis: '只改本文', premises: [...USER_PREMISES, { text: '新的前提' }], exitConditions: [] });
      expect((await loadAccount(c.db))!.acct.own.NVDA.thesisReviewDue).toBe('2026-11-19');
      await c.run('2026-11-20');
      let runs = await thesisRuns();
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ ticker: 'NVDA', asOf: '2026-11-20' });
      expect(runs[0].pack.premises.map((p) => p.id)).toEqual(['P1', 'P2', 'P3']);
      let m = (await loadAccount(c.db))!.acct.own.NVDA;
      expect(m.thesisReviewDue).toBeNull();
      expect(m.thesisReviewAt).toBe('2026-11-20');
      // 30 天內再撤一條 → 隔天不開，只清掉
      await c.api('POST', 'ops/own-thesis', { ticker: 'NVDA', thesis: '只改本文', premises: USER_PREMISES, exitConditions: [] }, new Date('2026-11-21T02:00:00Z'));
      expect((await loadAccount(c.db))!.acct.own.NVDA.thesisReviewDue).toBe('2026-11-20');
      await c.run('2026-11-23');
      runs = await thesisRuns();
      expect(runs).toHaveLength(1);
      m = (await loadAccount(c.db))!.acct.own.NVDA;
      expect(m.thesisReviewDue).toBeNull();
      expect(m.thesisReviewAt).toBe('2026-11-20');
    });
  });

  it('今天已經因為別的原因開了審查（月報前一天）→ 不另外開，只清掉，也不占 30 天的額度', async () => {
    await withWorld(async (c) => {
      await c.run('2026-11-25');
      await c.api('POST', 'ops/own-thesis', { ticker: 'NVDA', thesis: '', premises: [...USER_PREMISES, { text: '新的前提' }], exitConditions: [] }, new Date('2026-11-26T02:00:00Z'));
      expect((await loadAccount(c.db))!.acct.own.NVDA.thesisReviewDue).toBe('2026-11-25');
      // 11-27 的下一個交易日是 11-30（當月最後一個交易日）→ 月報前一天的審查
      await c.run('2026-11-27');
      const reviews = (await listRuns(c.db, new Date('2026-11-01T00:00:00Z'), { limit: 200 })).filter((r) => r.fn === 'OWN_REVIEW');
      expect(reviews.map((r) => [(r.pack.rule.detail as { trigger: string }).trigger, r.asOf])).toEqual([['MONTHLY', '2026-11-27']]);
      const m = (await loadAccount(c.db))!.acct.own.NVDA;
      expect(m.thesisReviewDue).toBeNull();
      expect(m.thesisReviewAt).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------- BREAK、replyTo、§3.8

describe('T27：replyTo、BREAK 情境、開檔時是減半的那一句', () => {
  it('編輯論點帶 replyTo → log 記下（T30 起是修正論點：afterBreak 為 true）；不存在的通知擋下；從通知來的討論包是 BREAK', async () => {
    await withWorld(async (c) => {
      const loaded = (await loadAccount(c.db))!;
      const { view } = await c.viewAt('2026-11-19');
      // T29a 起用乙類的當天通知（之前借用條件成立的通知）
      const n = breakNotice(loaded.acct, view, 'NVDA', { tier: 'HALF', premiseId: 'P1', basis: '8-K 2026-11-18' });
      await saveAccount(c.db, n.acct, loaded, '測試', new Date('2026-11-19T13:00:00Z'));
      const id = n.notif!.id;
      expect((await c.api('POST', 'ops/own-thesis', { ticker: 'NVDA', thesis: 'x', premises: USER_PREMISES, exitConditions: [], replyTo: 9999 })).status).toBe(404);
      const r = await c.api('POST', 'ops/own-thesis', { ticker: 'NVDA', thesis: 'x', premises: USER_PREMISES, exitConditions: [], replyTo: id, source: 'DISCUSSION' });
      expect(r.status).toBe(200);
      expect((await thesisLog(c.db)).at(-1)!.body).toMatchObject({ replyTo: id, afterBreak: true, source: 'DISCUSSION' }); // T30：對乙類的回應 = 修正論點
      const d = await c.api<{ mode: string; text: string }>('GET', `own/NVDA/discussion?notif=${id}`);
      expect(d.body.mode).toBe('BREAK');
      expect(d.body.text).toContain('stock bot 的審查（3 票一致）認為');
      expect((await c.api('GET', 'own/NVDA/discussion?notif=9999')).status).toBe(404);
    });
  });

  it('開檔時是減半、還沒加回過：持股頁那一句與討論包 NEW 的那一句', async () => {
    await withWorld(
      async (c) => {
        const h = await c.api<{ own: { openNote: string | null; kind: string; thesis: unknown } }>('GET', 'holding/NVDA');
        expect(h.body.own.openNote).toBe('加入時比 52 週高點低 23%，慢規則從減半開始：站回 200 日均線連續 10 天之前，規則不會再有動作。');
        expect(h.body.own.kind).toBe('DEFAULT_ONLY');
        expect(h.body.own.thesis).toBeNull();
        const d = await c.api<{ mode: string; text: string }>('GET', 'own/NVDA/discussion');
        expect(d.body.mode).toBe('NEW');
        expect(d.body.text).toContain('這檔是在大跌之後買的（加入時比 52 週高點低 23%）');
      },
      {
        premises: null,
        acct: (a) => {
          a.own.NVDA.opened = { startState: 'HALF', drawdownAtOpen: -0.23 };
          a.own.NVDA.slow.state = 'HALF';
          a.rule.own.NVDA.applied = 'HALF';
          return a;
        },
      },
    );
  });
});

// ---------------------------------------------------------------- 草擬模式拿掉

describe('T27：草擬模式的入口不存在（§1.12）', () => {
  it('沒有出場條件不能送改寫；舊的「加前提」與草擬的網址不在；畫面沒有草擬的按鈕；prompt 只有改寫', async () => {
    expect(() => ownCheckPack({ runId: 'r', asOf: '2026-11-19', ticker: 'NVDA', exits: [], held: true, premises: [], condFacts: [], facts: [], hits: [], docs: [], dataQuality: {}, thesisVersion: null, now: new Date() })).toThrow('沒有要改寫的出場條件');
    await withWorld(async (c) => {
      // 舊的寫法（lines 空的 = 草擬）→ 擋下
      const r = await c.api<{ error: string }>('POST', 'ops/own-check', { ticker: 'NVDA', lines: [] });
      expect(r.status).toBe(422);
      expect(r.body.error).toBe('沒有要改寫的出場條件');
      expect((await c.api('POST', 'ops/own-premises', { ticker: 'NVDA', premises: [{ text: 'x' }] })).status).toBe(404);
      // 新增自選的試算不再附 AI 草擬的前提
      const dry = await handle(new Request('https://bot.example/demo/api/ops/add-own', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticker: 'TSLA', dry: true }) }), c.env, c.fetcher, new Date('2026-11-20T02:00:00Z'));
      expect('drafts' in ((await dry.json()) as object)).toBe(false);
    });
    const js = join(HERE, '..', 'public', 'js');
    for (const f of readdirSync(js).filter((x) => x.endsWith('.js'))) {
      const s = readFileSync(join(js, f), 'utf8');
      expect(s, f).not.toContain('請 AI 草擬前提');
      expect(s, f).not.toContain('requestDrafts');
      expect(s, f).not.toContain('/ops/own-premises');
      expect(s, f).not.toMatch(/own-check', \{ ticker: [^}]*lines/);
    }
    expect(readFileSync(join(js, 'pages-holding.js'), 'utf8')).toContain('複製討論包');
    const v2 = readFileSync(join(HERE, '..', '..', 'ai', 'prompts', 'own_check_v2.md'), 'utf8');
    expect(v2).not.toMatch(/premises_draft|DRAFT/);
    expect(readFileSync(join(HERE, '..', '..', 'ai', 'prompts', 'own_check_v1.md'), 'utf8').split('\n')[0]).toContain('不再使用');
  });
});
