// T13：AI 紀錄補齊與匯出到本機。
//   ① 沒通過檢查（或逾時才送到）的 AI 輸出整份存下來（ai_rejections）
//   ② 雲端排程回報的 repo commit 存進 ai_runs.repo_commit
//   ③ AI 建議產生的通知項目、通知、影子紀錄帶 run_id；舊紀錄沒有這個欄位也讀得了
//   ④ /admin/export：驗證、分頁、不匯出的表與欄位、增量
// 全部用假資料（repo 是公開的）。
import { describe, expect, it } from 'vitest';
import { checkSample, type EvidencePack } from '../src/ai/check';
import { buildPack } from '../src/ai/pack';
import { commitOf, getRun, startRun } from '../src/app/aiRuns';
import { MAX_REJECTED_RAW_BYTES, TASK_TIMEOUT_MS, clipUtf8 } from '../src/app/aiTasks';
import type { Env, Fetcher } from '../src/app/env';
import { EXPORT_TABLES, exportPage } from '../src/app/export';
import { findNote } from '../src/app/site/explain';
import type { AiNote } from '../src/app/site/types';
import { condMetNotice, hardEvent, liveShadow, monthlyReport, recordAiTier, refreshOwnAiChoice, type Item, type Notif } from '../src/engine';
import { VERSION, handle } from '../src/index';
import { freshDb } from './helpers/d1';
import { ranksAt } from './helpers/market';
import { scenarios } from './helpers/scenarios';
import { Sim } from './helpers/sim';

const item = (n: Notif, f: string, ticker?: string): Item => {
  const it = n.items.find((i) => i.f === f && (!ticker || i.ticker === ticker));
  if (!it) throw new Error(`通知 #${n.id} 沒有 ${f} ${ticker ?? ''}`);
  return it;
};

async function withDb(fn: (db: D1Database, env: Env) => Promise<void>) {
  const d = await freshDb();
  try {
    const env: Env = { DB: d.db, ADMIN_TOKEN: 'admin-secret', AI_TASK_SECRET: 'task-secret', ROUTINE_FIRE_URL: 'https://api.example/fire', ROUTINE_TOKEN: 'rt' };
    await fn(d.db, env);
  } finally {
    await d.dispose();
  }
}

const fireOk: Fetcher = async () => Response.json({ claude_code_session_url: 'https://claude.ai/code/session_x' });
const T0 = new Date('2026-11-30T23:40:00Z');
const DOC = 'Gross margin was 61.2% in the third quarter, compared with 64.0% in the prior quarter.';

function pack(runId = '2026-11-30_OWN_REVIEW_ZZZ_abc123'): EvidencePack {
  return buildPack({
    runId,
    fn: 'OWN_REVIEW',
    promptVersion: 'own_review_v1',
    asOf: '2026-11-30',
    subject: { ticker: 'ZZZ' },
    question: '前提哪些成立？',
    policy: { level: 'A3', verdicts: ['EXIT', 'HALF', 'HOLD', 'STANDARD'], abstain: 'HOLD', min_evidence: 1, samples: 3 },
    rule: { action: '規則沒有動作' },
    premises: [{ id: 'P1', text: '毛利率維持在 60% 以上', origin: 'USER' }],
    documents: [{ id: 'D1', source_id: 'edgar:0000000000-26-000001', kind: 'filing', date: '2026-10-02', title: '假的 10-Q', text: DOC }],
    now: T0,
  }).pack;
}
const vote = (runId: string, extra: Record<string, unknown> = {}) => ({
  run_id: runId,
  verdict: 'HOLD',
  model: 'claude-opus-5-5',
  premise_checks: [{ premise_id: 'P1', status: 'HOLDS', evidence_ids: ['E1'] }],
  evidence: [{ id: 'E1', source_id: 'edgar:0000000000-26-000001', date: '2026-10-02', quote: 'Gross margin was 61.2% in the third quarter', claim: '毛利率仍在 60% 以上' }],
  payload: {},
  report: '前提成立。',
  ...extra,
});
const post = (env: Env, taskId: string, body: string, when = T0) => handle(new Request(`https://bot.example/ai/task/${taskId}/result`, { method: 'POST', headers: { Authorization: 'Bearer task-secret' }, body }), env, fireOk, when);
const rejections = async (db: D1Database, taskId: string) => (await db.prepare('SELECT * FROM ai_rejections WHERE task_id = ? ORDER BY id').bind(taskId).all<Record<string, unknown>>()).results;

// ---------------------------------------------------------------- ① 被拒絕的輸出

describe('① 沒通過檢查的 AI 輸出整份存下來', () => {
  it('外層格式不對 → 任務 REJECTED，原始輸出與完整原因存在 ai_rejections；紀錄照規則', async () => {
    await withDb(async (db, env) => {
      const run = await startRun(env, fireOk, pack(), T0);
      const body = JSON.stringify({ task_id: run.taskId, kind: 'RUN', run_id: run.runId, samples: [vote(run.runId)], verdict_summary: '多出來的欄位' });
      const res = await post(env, run.taskId!, body);
      expect(res.status).toBe(422);
      const rows = await rejections(db, run.taskId!);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ kind: 'RUN', status: 'REJECTED', http_status: 422, raw: body, raw_bytes: new TextEncoder().encode(body).length, truncated: 0 });
      expect(rows[0].reason).toContain('多了不認得的欄位：verdict_summary');
      const r = (await getRun(db, run.runId, T0))!;
      expect(r.outcome).toMatchObject({ status: 'NO_RESULT', followRule: true });
      // 不是 JSON 也照樣留原文
      const run2 = await startRun(env, fireOk, pack('2026-11-30_OWN_REVIEW_ZZZ_def456'), T0);
      expect((await post(env, run2.taskId!, 'not json {')).status).toBe(422);
      expect((await rejections(db, run2.taskId!))[0]).toMatchObject({ raw: 'not json {', reason: '不是合法的 JSON' });
    });
  });

  it('太大的輸出 → 413，只留前 256 KiB（不切斷字元）並記下原本的大小', async () => {
    await withDb(async (db, env) => {
      const run = await startRun(env, fireOk, pack(), T0);
      const body = JSON.stringify({ task_id: run.taskId, kind: 'RUN', run_id: run.runId, samples: [vote(run.runId, { report: '中'.repeat(100_000) })] });
      expect(new TextEncoder().encode(body).length).toBeGreaterThan(MAX_REJECTED_RAW_BYTES);
      expect((await post(env, run.taskId!, body)).status).toBe(413);
      const [row] = await rejections(db, run.taskId!);
      expect(row).toMatchObject({ status: 'REJECTED', http_status: 413, raw_bytes: new TextEncoder().encode(body).length, truncated: 1 });
      const raw = row.raw as string;
      expect(new TextEncoder().encode(raw).length).toBeLessThanOrEqual(MAX_REJECTED_RAW_BYTES);
      expect(body.startsWith(raw)).toBe(true);
      expect(raw).not.toContain('�');
    });
  });

  it('逾時之後才送到 → 410、任務 TIMEOUT，輸出照樣存（LATE）', async () => {
    await withDb(async (db, env) => {
      const run = await startRun(env, fireOk, pack(), T0);
      const body = JSON.stringify({ task_id: run.taskId, kind: 'RUN', run_id: run.runId, samples: [vote(run.runId)] });
      expect((await post(env, run.taskId!, body, new Date(T0.getTime() + TASK_TIMEOUT_MS + 1000))).status).toBe(410);
      expect((await rejections(db, run.taskId!))[0]).toMatchObject({ status: 'LATE', http_status: 410, raw: body });
    });
  });

  it('合格的結果不會寫進 ai_rejections；clipUtf8 在多位元組字元的邊界退回', async () => {
    await withDb(async (db, env) => {
      const run = await startRun(env, fireOk, pack(), T0);
      expect((await post(env, run.taskId!, JSON.stringify({ task_id: run.taskId, kind: 'RUN', run_id: run.runId, samples: [vote(run.runId)] }))).status).toBe(200);
      expect(await rejections(db, run.taskId!)).toEqual([]);
    });
    expect(clipUtf8('ab中', 4)).toEqual({ text: 'ab', bytes: 5, truncated: true });
    expect(clipUtf8('ab中', 5)).toEqual({ text: 'ab中', bytes: 5, truncated: false });
  });
});

// ---------------------------------------------------------------- ② repo commit

describe('② 雲端排程回報的 repo commit', () => {
  const SHA = 'a'.repeat(8) + '0123456789abcdef0123456789abcdef';
  it('送回的 repo_commit 存進 ai_runs，讀得到；大寫與空白會整理', async () => {
    await withDb(async (db, env) => {
      const run = await startRun(env, fireOk, pack(), T0);
      expect(run.repoCommit).toBeNull();
      const body = { task_id: run.taskId, kind: 'RUN', run_id: run.runId, repo_commit: ` ${SHA.toUpperCase()}\n`, samples: [vote(run.runId), vote(run.runId), vote(run.runId)] };
      expect((await post(env, run.taskId!, JSON.stringify(body))).status).toBe(200);
      const r = (await getRun(db, run.runId, T0))!;
      expect(r.repoCommit).toBe(SHA);
      expect((await db.prepare('SELECT repo_commit FROM ai_runs WHERE run_id = ?').bind(run.runId).first())!.repo_commit).toBe(SHA);
    });
  });
  it('沒回報、null、不像 commit → 結果照收、commit 存 NULL；不是字串 → 整份退回（原文存下來）', async () => {
    await withDb(async (db, env) => {
      for (const [k, rc] of [
        [1, undefined],
        [2, null],
        [3, 'unknown'],
      ] as const) {
        const run = await startRun(env, fireOk, pack(`2026-11-30_OWN_REVIEW_ZZZ_ok${k}`), T0);
        const body = { task_id: run.taskId, kind: 'RUN', run_id: run.runId, ...(rc === undefined ? {} : { repo_commit: rc }), samples: [vote(run.runId)] };
        expect((await post(env, run.taskId!, JSON.stringify(body))).status).toBe(200);
        expect((await getRun(db, run.runId, T0))!.repoCommit).toBeNull();
      }
      const bad = await startRun(env, fireOk, pack('2026-11-30_OWN_REVIEW_ZZZ_bad'), T0);
      expect((await post(env, bad.taskId!, JSON.stringify({ task_id: bad.taskId, kind: 'RUN', run_id: bad.runId, repo_commit: 42, samples: [vote(bad.runId)] }))).status).toBe(422);
      expect((await rejections(db, bad.taskId!))[0].reason).toContain('repo_commit');
    });
    expect(commitOf('abc1234')).toBe('abc1234');
    expect(commitOf('abc12')).toBeNull();
  });
  it('子代理把 repo_commit 抄進每一票：那一票照樣合格', () => {
    const p = pack();
    const s = checkSample(p, vote(p.run_id, { repo_commit: SHA }), 0);
    expect(s.issues).toEqual([]);
    expect(s.valid).toBe(true);
  });
});

// ---------------------------------------------------------------- ③ run_id

describe('③ AI 建議產生的通知項目、通知、影子紀錄帶 run_id', () => {
  it('F25：項目與通知帶 run_id；這次不做（寫理由）之後影子紀錄也帶', () => {
    const sc = scenarios.s1();
    const sim = new Sim(sc.market, sc.init);
    sim.runUntil('2026-12-10');
    sim.day();
    const ticker = Object.keys(sim.acct.own)[0];
    // T29a：F25 是甲類（你定的條件成立），預設照當時的決定；照做和規則相同不留影子紀錄，所以這裡選這次不做
    const r = condMetNotice(sim.acct, sim.pre, ticker, { id: 1, text: '假的條件', action: 'EXIT', setAt: '2026-12-01', aiProposed: false, why: '測試', runIds: ['run-f25', 'run-f24'] });
    sim.acct = r.acct;
    const it25 = item(r.notif!, 'F25', ticker);
    expect(it25.runIds).toEqual(['run-f25', 'run-f24']);
    expect(r.notif!.runIds).toEqual(['run-f25', 'run-f24']);
    sim.respond(r.notif!.id, { mode: 'DO', choices: { [it25.key]: 'SKIP' }, reasons: { [it25.key]: '測試的理由' } });
    const rec = liveShadow(sim.acct.shadow).find((s) => s.f === 'F25');
    expect(rec).toMatchObject({ ticker, notif: r.notif!.id, runIds: ['run-f25', 'run-f24'], note: '測試的理由' });
  });

  it('F19：AI 法庭提出的帶 run_id；規則直接提出的沒有', () => {
    const sc = scenarios.s4();
    const sim = new Sim(sc.market, sc.init);
    sim.runUntil('2026-12-15');
    sim.day();
    const ai = hardEvent(sim.acct, sim.pre, 'META', 'ACCOUNTING', false, ['run-f19']);
    expect(item(ai.notif!, 'F19', 'META').runIds).toEqual(['run-f19']);
    expect(ai.notif!.runIds).toEqual(['run-f19']);
    const rule = hardEvent(sim.acct, sim.pre, 'ORCL', 'PENDING_MA', true);
    expect(item(rule.notif!, 'F19', 'ORCL').runIds).toBeUndefined();
    expect(rule.notif!.runIds).toBeUndefined();
  });

  // T31b 改了這個行為（own_thesis §3.4）：減半項目上 AI 的那一行只來自看過這次觸發的結論——減半檢視（dropReview），或觸發之後另外回來的審查；
  // 觸發之前的定期審查檔位不再並列，所以這裡改成：項目帶的是那次減半檢視的執行，之後另外有審查回來（建議出清）時換成那一次
  // T82（allocation_redesign §3.2）：MU 有論點，12/24 是跌幅審查的項目；結果改成「前提都沒有被判不成立」（以前是建議不動）。
  // 預設不動的通知 2 個交易日後會自動結案，所以停在觸發那天收盤後
  it('F7：跌幅審查項目帶那次審查的執行；觸發之後另外有審查回來（建議出清）時跟著換', () => {
    const sc = scenarios.s2();
    const sim = new Sim(sc.market, sc.init);
    let urgent!: Notif;
    while (!urgent) sim.day({ afterClose: (c) => (urgent = c.find((n) => n.kind === 'URGENT' && n.items.some((i) => i.f === 'F7' && i.ticker === 'MU'))!) });
    expect(urgent.date).toBe('2026-12-24');
    // 觸發（12/24）之前的定期審查不會出現在項目上
    sim.acct = recordAiTier(sim.acct, 'MU', 'HOLD', '2026-12-18', false, 'run-f24-old');
    expect(item(urgent, 'F7', 'MU').runIds).toBeUndefined();
    // 跌幅審查開了（等結果）→ 回來：前提都沒有被判不成立。項目帶那次執行
    sim.acct.own.MU.dropReview = { session: '2026-12-24', runId: 'run-f7-mu', status: 'CLEAR', cause: 'SECTOR', premiseId: null, told: false, thesis: true, level: 0 };
    sim.acct = refreshOwnAiChoice(sim.acct, sim.pre, 'MU').acct;
    const it7 = item(sim.acct.notifs.find((n) => n.id === urgent.id)!, 'F7', 'MU');
    expect(it7.runIds).toEqual(['run-f7-mu']);
    expect(sim.acct.notifs.find((n) => n.id === urgent.id)!.runIds).toContain('run-f7-mu');
    // 觸發之後另外有審查回來（三票一致、前提 P1 不成立、建議出清）→ 還沒回覆的通知換成那一次的 run_id
    sim.acct = recordAiTier(sim.acct, 'MU', 'EXIT', '2026-12-30', false, 'run-f24-mu', { premiseId: 'P1', trigger: 'EARNINGS', agreed: true });
    sim.acct = refreshOwnAiChoice(sim.acct, sim.pre, 'MU').acct;
    const after = sim.acct.notifs.find((n) => n.id === urgent.id)!;
    expect(item(after, 'F7', 'MU').runIds).toEqual(['run-f24-mu']);
    expect(after.runIds).toEqual(expect.arrayContaining(['run-f7-mu', 'run-f24-mu']));
    sim.respond(urgent.id, { mode: 'DO', choices: { [it7.key]: 'AI' } });
    expect(liveShadow(sim.acct.shadow).find((s) => s.f === 'F7' && s.ticker === 'MU')!.runIds).toEqual(['run-f24-mu']);
  });

  // T32d：F20 說明拿掉（momentum_ai §3.6），月報的輸入沒有 notes，通知上不再掛 F20 的 run_id
  it('月報：F24／F23 建議、F1 進場帶各自的 run_id；被否決的代號的 run_id 掛在通知上', () => {
    const sc = scenarios.s1();
    const sim = new Sim(sc.market, sc.init);
    sim.runUntil('2026-12-01');
    sim.acct = recordAiTier(sim.acct, 'MSFT', 'RAISE', '2026-11-30', true, 'run-f24-msft');
    const r = monthlyReport(sim.acct, sim.pre, {
      order: ranksAt(sim.market, sim.d - 1),
      vetoed: ['APP'],
      month: '2026-12',
      runIds: { entry: { APP: 'run-f1-app', GE: 'run-f1-ge' } },
    });
    expect(item(r.notif, 'F23', 'MSFT').runIds).toEqual(['run-f24-msft']);
    expect(item(r.notif, 'F1', 'GE').runIds).toEqual(['run-f1-ge']);
    expect(item(r.notif, 'F2', 'ORCL').runIds).toBeUndefined(); // 純規則的項目沒有
    expect(new Set(r.notif.runIds)).toEqual(new Set(['run-f24-msft', 'run-f1-ge', 'run-f1-app']));
  });

  // T80（階段十二，allocation_redesign §1.6）：原本這裡是「F5／F6：崩盤規則項目帶檢視的 run_id」。月報不再產生崩盤項目
  it('2026-11-22 起月報沒有崩盤項目：VOO 在 200 日線之下、給了檢視的 run_id 也沒有 F5／F6，通知不帶它', () => {
    const sc = scenarios.s3();
    const sim = new Sim(sc.market, sc.init);
    sim.runUntil('2027-01-04');
    const r = monthlyReport(sim.acct, sim.pre, { order: ranksAt(sim.market, sim.d - 1), month: '2027-01', crashOpinion: '延後', runIds: { crash: 'run-crash' } });
    expect(r.notif.items.some((i) => i.f === 'F5' || i.f === 'F6')).toBe(false);
    expect(r.notif.runIds ?? []).not.toContain('run-crash');
  });

  it('舊紀錄沒有 run_id：網站照舊用代號＋日期找 AI 說明；有 run_id 就找那一次', () => {
    const note = (runId: string | undefined, date: string, verdict: string): AiNote => ({ kind: 'REVIEW', ticker: 'ZZZ', date, verdict, summary: '', fake: false, ...(runId ? { runId } : {}) });
    const notes = [note('run-old', '2026-11-01', '舊的'), note('run-new', '2026-11-20', '新的'), note(undefined, '2026-11-25', '示範')];
    expect(findNote(notes, 'REVIEW', 'ZZZ', '2026-11-30')!.verdict).toBe('示範');
    expect(findNote(notes, 'REVIEW', 'ZZZ', '2026-11-30', ['run-old'])!.verdict).toBe('舊的');
    expect(findNote(notes, 'REVIEW', 'ZZZ', '2026-11-30', ['run-missing'])!.verdict).toBe('示範');
    // 影子紀錄沒有 runIds 也能照常過濾
    expect(liveShadow([{ date: '2026-11-01', f: 'F7', ticker: 'ZZZ', title: '', rule: -1, ai: 0, actual: 0, price: 1, choice: 'AI', notif: 1 }])).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- ④ 匯出

describe('④ /admin/export', () => {
  const get = (env: Env, q: string, token = 'admin-secret') => handle(new Request(`https://bot.example/admin/export${q}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} }), env, fireOk, T0);

  async function seed(db: D1Database, n: number, from = 0) {
    for (let i = from; i < from + n; i++) await db.prepare('INSERT INTO shadow_records (rev, date, f, ticker, body) VALUES (?, ?, ?, ?, ?)').bind(i + 1, '2026-11-30', 'F7', 'ZZZ', JSON.stringify({ i, f: 'F7', runIds: ['run-x'] })).run();
  }

  it('沒有 ADMIN_TOKEN 的 Bearer → 401', async () => {
    await withDb(async (_db, env) => {
      expect((await get(env, '', '')).status).toBe(401);
      expect((await get(env, '?table=shadow_records', 'wrong')).status).toBe(401);
      expect((await get(env, '', 'task-secret')).status).toBe(401);
      expect((await get(env, '', 'admin-secret')).status).toBe(200);
    });
  });

  it('概要：Worker 版本、上線日（還沒有是 null）、每張表的拉法、列數、最後 rowid；不列 probe_runs、demo_state', async () => {
    await withDb(async (db, env) => {
      await seed(db, 3);
      const m = (await (await get(env, '')).json()) as { version: string; launch_date: string | null; not_exported: string[]; tables: Record<string, { mode: string; rows: number; last_rowid: number; key: string; omit: string[] }> };
      expect(m.version).toBe(VERSION);
      expect(m.launch_date).toBeNull();
      expect(m.tables.shadow_records).toEqual({ mode: 'append', rows: 3, last_rowid: 3, key: '_rowid', omit: [] });
      expect(m.tables.ai_tasks.omit).toEqual(['evidence']);
      expect(m.tables.price_series).toMatchObject({ mode: 'replace', key: 'ticker' });
      expect(m.tables.rankings).toMatchObject({ mode: 'append', key: 'session' });
      expect(Object.keys(m.tables)).not.toContain('probe_runs');
      expect(Object.keys(m.tables)).not.toContain('demo_state');
      expect(m.not_exported).toEqual(['probe_runs', 'demo_state', 'snapshot_undo']);
      // 每張 migration 建的表都要決定匯不匯出
      const all = (await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%'").all<{ name: string }>()).results.map((r) => r.name);
      expect(all.filter((t) => !(t in m.tables) && !m.not_exported.includes(t))).toEqual([]);
      // T17 寫進上線日之後
      await db.prepare("INSERT INTO flow_state (key, value, updated_at) VALUES ('launch_date', '2026-12-01', '')").run();
      expect(((await (await get(env, '')).json()) as { launch_date: string }).launch_date).toBe('2026-12-01');
    });
  });

  it('不匯出的表與不認得的表 → 400；分頁參數不對 → 400', async () => {
    await withDb(async (_db, env) => {
      expect(await (await get(env, '?table=probe_runs')).json()).toMatchObject({ error: 'not_exported' });
      expect(await (await get(env, '?table=demo_state')).json()).toMatchObject({ error: 'not_exported' });
      expect((await get(env, '?table=sqlite_master')).status).toBe(400);
      expect((await get(env, '?table=shadow_records;DROP')).status).toBe(400);
      expect((await get(env, '?table=shadow_records&after=-1')).status).toBe(400);
      expect((await get(env, '?table=shadow_records&limit=0')).status).toBe(400);
    });
  });

  it('照 rowid 分頁：limit 列一頁，next_after 接著拉，拉完 done；JSON 欄位解析成物件', async () => {
    await withDb(async (db, env) => {
      await seed(db, 5);
      const pages: { rows: { _rowid: number; body: { i: number } }[]; next_after: number; done: boolean }[] = [];
      let after = 0;
      for (;;) {
        const p = (await (await get(env, `?table=shadow_records&after=${after}&limit=2`)).json()) as (typeof pages)[number];
        pages.push(p);
        after = p.next_after;
        if (p.done) break;
      }
      expect(pages.map((p) => p.rows.map((r) => r._rowid))).toEqual([[1, 2], [3, 4], [5]]);
      expect(pages[0].rows[0].body).toEqual({ i: 0, f: 'F7', runIds: ['run-x'] });
      // 增量：從上次的最後 rowid 接著拉，只拿到新的
      await seed(db, 2, 5);
      const inc = (await (await get(env, '?table=shadow_records&after=5')).json()) as (typeof pages)[number];
      expect(inc.rows.map((r) => r._rowid)).toEqual([6, 7]);
      expect(inc.done).toBe(true);
    });
  });

  it('price_series 照回應大小分頁：超過一頁的位元組就切，至少回一列', async () => {
    await withDb(async (db) => {
      const bars = JSON.stringify({ d: Array(500).fill('2026-01-02'), c: Array(500).fill(100.5), a: Array(500).fill(99.25), v: Array(500).fill(123456) });
      for (const t of ['AAA', 'BBB', 'CCC']) await db.prepare('INSERT INTO price_series (ticker, fetched_at, session, last_date, n, bars) VALUES (?, ?, ?, ?, ?, ?)').bind(t, '', '2026-11-30', '2026-11-30', 500, bars).run();
      const p1 = await exportPage(db, 'price_series', 0, undefined, bars.length * 1.5);
      expect(p1.rows.map((r) => r.ticker)).toEqual(['AAA']);
      expect(p1.done).toBe(false);
      expect((p1.rows[0].bars as { c: number[] }).c).toHaveLength(500);
      const tiny = await exportPage(db, 'price_series', p1.next_after, undefined, 10);
      expect(tiny.rows.map((r) => r.ticker)).toEqual(['BBB']);
      expect(EXPORT_TABLES.price_series.pageRows).toBeLessThanOrEqual(50);
    });
  });

  it('ai_tasks 不帶 evidence；ai_runs 帶 repo_commit 與解析好的證據包；ai_rejections 增量拉', async () => {
    await withDb(async (db, env) => {
      const run = await startRun(env, fireOk, pack(), T0);
      await post(env, run.taskId!, 'not json {');
      const tasks = (await (await get(env, '?table=ai_tasks')).json()) as { rows: Record<string, unknown>[] };
      expect(tasks.rows).toHaveLength(1);
      expect(tasks.rows[0]).not.toHaveProperty('evidence');
      expect(tasks.rows[0]).toMatchObject({ id: run.taskId, status: 'REJECTED' });
      const runs = (await (await get(env, '?table=ai_runs')).json()) as { rows: Record<string, unknown>[] };
      expect(runs.rows[0]).toHaveProperty('repo_commit', null);
      expect((runs.rows[0].pack as EvidencePack).run_id).toBe(run.runId);
      const rej = (await (await get(env, '?table=ai_rejections')).json()) as { rows: Record<string, unknown>[] };
      expect(rej.rows[0]).toMatchObject({ _rowid: 1, task_id: run.taskId, raw: 'not json {' });
      expect(((await (await get(env, '?table=ai_rejections&after=1')).json()) as { rows: unknown[] }).rows).toEqual([]);
    });
  });
});
