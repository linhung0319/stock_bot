// 減半檢視／跌幅審查的整條流程用的假世界（T31b 寫的，T82 搬出來共用）：假的價格、成分股、EDGAR、雲端排程、LINE。
// 帳戶：NVDA 占約 21%（減半的變動 ≥ 5%），預設有兩條自己的前提（有論點）；opt.defaultOnly = 只有系統預設前提；opt.ai = false = 雲端排程沒有設定。
import type { EvidencePack } from '../../src/ai/check';
import { OWN_DROP } from '../../src/ai/drops';
import { finalizeRun, getRun, listRuns } from '../../src/app/aiRuns';
import type { Env, Fetcher } from '../../src/app/env';
import { runFlow, type Attempt } from '../../src/app/flow';
import { loadAccount, saveAccount } from '../../src/app/ledgerStore';
import { LINE_PUSH_URL } from '../../src/app/line';
import { buildMarketView } from '../../src/data/marketView';
import { loadConstituents, loadSeries } from '../../src/data/store';
import { createAccount, type Account } from '../../src/engine';
import { handle } from '../../src/index';
import { freshDb } from './d1';
import { cronTime, fakeFetcher, newWorld, type World } from './fakeSources';

export interface FakeFiling {
  accession: string;
  form: string;
  items: string;
  acceptanceDateTime: string;
  filingDate: string;
  primaryDocument: string;
  html: string;
}
export interface Sec {
  cos: Map<number, FakeFiling[]>;
  line: string[];
  /** 雲端排程觸發失敗。 */
  fireDown: boolean;
}

export function fetcherOf(w: World, sec: Sec): Fetcher {
  const base = fakeFetcher(w);
  return async (url, init) => {
    if (url === LINE_PUSH_URL) {
      sec.line.push((JSON.parse(String(init?.body)) as { messages: { text: string }[] }).messages[0].text);
      return Response.json({});
    }
    if (url === 'https://api.example/fire') return sec.fireDown ? new Response('down', { status: 503 }) : Response.json({ claude_code_session_url: 'https://claude.ai/code/x' });
    const sub = /data\.sec\.gov\/submissions\/CIK(\d+)\.json/.exec(url);
    if (sub) {
      const fs = [...(sec.cos.get(Number(sub[1])) ?? [])].reverse();
      return Response.json({ cik: sub[1], name: 'SOME CORP', tickers: [], sic: '3674', formerNames: [], filings: { recent: { accessionNumber: fs.map((f) => f.accession), form: fs.map((f) => f.form), items: fs.map((f) => f.items), acceptanceDateTime: fs.map((f) => f.acceptanceDateTime), filingDate: fs.map((f) => f.filingDate), primaryDocument: fs.map((f) => f.primaryDocument) } } });
    }
    if (/companyfacts\/CIK\d+\.json/.test(url)) {
      const q = (start: string, end: string, val: number, filed: string) => ({ start, end, val, filed, form: '10-Q', accn: `a-${filed}` });
      return Response.json({ cik: 1, facts: { 'us-gaap': { Revenues: { units: { USD: [q('2025-07-01', '2025-09-30', 900, '2025-10-30'), q('2026-04-01', '2026-06-30', 1100, '2026-07-30'), q('2026-07-01', '2026-09-30', 1200, '2026-10-30')] } } } } });
    }
    if (/companyconcept\//.test(url)) return new Response('nf', { status: 404 });
    const doc = /Archives\/edgar\/data\/\d+\/(\d+)\/(.+)$/.exec(url);
    if (doc) {
      const f = [...sec.cos.values()].flat().find((x) => x.accession.replace(/-/g, '') === doc[1]);
      if (!f) return new Response('nf', { status: 404 });
      if (doc[2] === 'index.json') return Response.json({ directory: { item: [{ name: f.primaryDocument }] } });
      return new Response(f.html);
    }
    if (url.startsWith('https://www.nasdaq.com/feed/rssoutbound')) return new Response('<rss><channel></channel></rss>');
    if (url.startsWith('https://fred.stlouisfed.org/graph/fredgraph.csv')) return new Response('observation_date,X\n2000-10-02,1.0\n2026-05-01,1.2\n2026-11-02,1.5\n');
    if (url.startsWith('https://mba.tuck.dartmouth.edu/')) return new Response('nf', { status: 404 });
    return base(url, init);
  };
}

export interface Ctx {
  db: D1Database;
  w: World;
  sec: Sec;
  env: Env;
  cik: number;
  run: (date: string, attempt?: Attempt) => ReturnType<typeof runFlow>;
  acct: () => Promise<Account>;
  api: (path: string, body: unknown, now?: Date) => Promise<{ status: number; body: Record<string, unknown> }>;
}

export const HOURS: Record<Attempt, number> = { FIRST: 0, FINAL: 2, APPLY: 4, MANUAL: 0 };
export const P1 = '資料中心需求延續到 2027';

/** 帳戶：NVDA 占約 21%（減半的變動 ≥ 5%，當天通知），兩條自己的前提。opt.ai = false：雲端排程沒有設定。 */
export async function withWorld(fn: (c: Ctx) => Promise<void>, opt: { ai?: boolean; defaultOnly?: boolean; nvda?: number } = {}) {
  const d = await freshDb();
  try {
    const db = d.db;
    const w = newWorld('2026-11-19');
    const sec: Sec = { cos: new Map(), line: [], fireDown: false };
    const env: Env = { DB: db, ADMIN_TOKEN: 't', AI_TASK_SECRET: 's', EDGAR_USER_AGENT: 'test bot test@example.com', SITE_URL: 'https://bot.example', LINE_CHANNEL_TOKEN: 'lt', LINE_USER_ID: 'U1', DEV_NO_AUTH: '1', ...(opt.ai === false ? {} : { ROUTINE_FIRE_URL: 'https://api.example/fire', ROUTINE_TOKEN: 'rt' }) };
    const fetcher = fetcherOf(w, sec);
    const run = (date: string, attempt: Attempt = 'FIRST') => {
      w.dataDate = date;
      return runFlow(env, fetcher, { now: new Date(cronTime(date).getTime() + HOURS[attempt] * 3600_000), attempt });
    };
    await run('2026-11-19');
    const members = (await loadConstituents(db))!;
    const cik = Number(members.holdings.find((h) => h[0] === 'NVDA')![2]);
    const { view } = buildMarketView(await loadSeries(db, ['VOO', 'SGOV', 'NVDA']), '2026-11-19', 'VOO');
    const acct = createAccount(
      {
        paper: true,
        cash: 5000,
        core: { VOO: Math.floor(140_000 / view.close.VOO[view.i]) },
        own: {
          NVDA: {
            // opt.nvda：NVDA 的市值（預設 40,000，約占 21%；T82 用小一點的試「變動不到 5%」）
            shares: Math.floor((opt.nvda ?? 40_000) / view.close.NVDA[view.i]),
            stdWeight: 0.15,
            // defaultOnly：不寫自己的前提（系統預設三條）
            ...(opt.defaultOnly
              ? {}
              : {
                  premises: [
                    { id: 'P1', text: P1, origin: 'USER' as const },
                    { id: 'P2', text: '毛利率維持在 65% 以上', origin: 'USER' as const },
                  ],
                }),
          },
        },
      },
      view,
    );
    await saveAccount(db, acct, null, '建立帳戶', new Date('2026-11-19T12:00:00Z'));
    // 預設的時間是 23:30 那次流程之後 15 分鐘（減半檢視的結果還沒回來）
    const api: Ctx['api'] = async (path, body, now = new Date('2026-11-23T23:45:00Z')) => {
      const r = await handle(new Request(`https://bot.example/api/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env, fetcher, now);
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    };
    await fn({ db, w, sec, env, cik, run, acct: async () => (await loadAccount(db))!.acct, api });
  } finally {
    await d.dispose();
  }
}

export const dropRuns = async (db: D1Database) => (await listRuns(db, new Date('2026-11-01T00:00:00Z'), { limit: 500 })).filter((r) => r.fn === OWN_DROP);
export async function postResult(db: D1Database, runId: string, samples: unknown[], at: Date) {
  const run = (await getRun(db, runId))!;
  const task = await db.prepare('SELECT * FROM ai_tasks WHERE id = ?').bind(run.taskId).first();
  return finalizeRun(db, task as never, { samples }, at);
}
export const logRows = async (db: D1Database, kind: string) => (await db.prepare('SELECT * FROM own_thesis_log WHERE kind = ? ORDER BY id').bind(kind).all<{ ref: string; session: string; body: string }>()).results.map((r) => ({ ref: r.ref, session: r.session, body: JSON.parse(r.body) as Record<string, unknown> }));
/** 通知與補推的推播紀錄（告警不算：同一次流程可能另外推一則「別的 AI 任務逾時」）。 */
export const pushRows = async (db: D1Database) => (await db.prepare("SELECT kind, ref, ok FROM pushes WHERE kind != 'ALERT' ORDER BY id").all<{ kind: string; ref: number | null; ok: number }>()).results;
/** LINE 收到的訊息，不含告警。 */
export const notices = (sec: Sec) => sec.line.filter((t) => !t.includes('【告警】'));
export const reduceNotif = (a: Account) => a.notifs.find((n) => n.kind === 'URGENT' && n.items.some((i) => i.f === 'F7'))!;
export const f7 = (a: Account) => reduceNotif(a).items.find((i) => i.f === 'F7')!;

/** 產業一起跌：NVDA 和它的產業 ETF（XLK）同一天跌三成（個股自身的跌幅是 0）。alone：只有 NVDA 自己跌。 */
export function crash(w: World, date: string, alone = false) {
  w.shock.NVDA = { from: date, factor: 0.7 };
  if (!alone) w.shock.XLK = { from: date, factor: 0.7 };
}
/** 三票不動（產業一起跌、前提都成立，引用價格）。 */
export function holdVotes(pack: EvidencePack) {
  const price = pack.documents.find((d) => d.source_id === 'price:NVDA')!;
  const v = { run_id: pack.run_id, verdict: 'HOLD', premise_checks: [{ premise_id: 'P1', status: 'HOLDS', evidence_ids: ['E1'] }], evidence: [{ id: 'E1', source_id: price.source_id, date: price.date, quote: price.text.split('\n').at(-1)!, claim: '和產業一起跌' }], payload: { tier: 'HOLD', cause_class: 'SECTOR' }, report: '產業一起跌，前提沒有變。' };
  return [v, v, v];
}
export const EIGHTK: FakeFiling = { accession: '0001045810-26-000777', form: '8-K', items: '8.01', acceptanceDateTime: '2026-11-23T21:30:00.000Z', filingDate: '2026-11-23', primaryDocument: 'ek.htm', html: '<html><body><p>Item 8.01 Other Events.</p><p>The Company announced that two of its largest data center customers have cancelled their purchase commitments for fiscal 2027 and 2028.</p></body></html>' };
export const EXIT_QUOTE = 'two of its largest data center customers have cancelled their purchase commitments';
/** 三票出清（都判 P1 不成立，引用 8-K 原文）。 */
export function exitVotes(pack: EvidencePack) {
  const doc = pack.documents.find((d) => d.kind === 'filing' && d.text.includes(EXIT_QUOTE))!;
  const v = { run_id: pack.run_id, verdict: 'EXIT', premise_checks: [{ premise_id: 'P1', status: 'BROKEN', evidence_ids: ['E1'] }], evidence: [{ id: 'E1', source_id: doc.source_id, date: doc.date, quote: EXIT_QUOTE, claim: '大客戶取消訂單' }], payload: { tier: 'EXIT', cause_class: 'FUNDAMENTAL' }, report: '需求的前提不成立。' };
  return [v, v, v];
}

