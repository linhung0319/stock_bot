// T9：AI 共用骨架。完成條件：用假的 AI 回覆測過合格、不合格、逾時、票數不一致四種情況。
// 另外測每一項程式檢查（§2.3）、整趟來回（建任務 → 取證據包 → 送回 → 表決）、網站的紀錄頁與匯出 md、影子組合。
import { describe, expect, it } from 'vitest';
import { MIN_QUOTE, checkSample, decide, judge, normalizeText, type EvidencePack } from '../src/ai/check';
import { buildPack, newRunId, ownPremises, ownRuleFacts, priceDoc, priceFacts } from '../src/ai/pack';
import { betaSummary, bookFromView, followUp, shadowSummary } from '../src/ai/shadow';
import { closeStaleRuns, getRun, listRuns, startRun } from '../src/app/aiRuns';
import { TASK_TIMEOUT_MS } from '../src/app/aiTasks';
import type { Env, Fetcher } from '../src/app/env';
import { runFlow } from '../src/app/flow';
import { loadAccount, saveAccount } from '../src/app/ledgerStore';
import { exportMd, noteOfRun, runDetail } from '../src/app/site/aiViews';
import { buildMarketView } from '../src/data/marketView';
import { loadSeries } from '../src/data/store';
import { createAccount, type ShadowRecord } from '../src/engine';
import { handle } from '../src/index';
import { freshDb } from './helpers/d1';
import { cronTime, fakeFetcher, newWorld } from './helpers/fakeSources';

// ---------------------------------------------------------------- 假的證據包與假的 AI 回覆

const DOC_10Q = 'Gross margin was 61.2% in the third quarter, compared with 64.0% in the prior quarter, primarily reflecting lower HBM contract prices.';
const DOC_NEWS = 'Micron said its HBM supply for calendar 2027 is fully booked under long-term agreements with pricing set in advance.';

function testPack(over: Partial<EvidencePack['policy']> = {}, dq: EvidencePack['data_quality'] = { filings: 'ok', news: 'live' }): EvidencePack {
  return buildPack({
    runId: '2026-11-30_OWN_REVIEW_MU_abc123',
    fn: 'OWN_REVIEW',
    promptVersion: 'own_review_v1',
    asOf: '2026-11-30',
    subject: { ticker: 'MU' },
    question: '這檔的前提哪些成立、哪些不成立？各有什麼證據？',
    policy: { level: 'A3', verdicts: ['EXIT', 'HALF', 'HOLD', 'STANDARD'], abstain: 'HOLD', min_evidence: 1, samples: 3, ...over },
    rule: { action: '規則沒有動作（慢規則：標準）' },
    premises: [
      { id: 'P1', text: 'HBM 長約有價格保護', origin: 'USER' },
      { id: 'P2', text: '毛利率維持在 60% 以上', origin: 'USER' },
    ],
    documents: [
      { id: 'D1', source_id: 'edgar:0000723125-26-000045', kind: 'filing', date: '2026-10-02', title: 'MU 10-Q（2026 Q3）', text: DOC_10Q },
      { id: 'D2', source_id: 'news:reuters-2026-11-20', kind: 'news', date: '2026-11-20', title: 'Micron HBM 2027 booked', text: DOC_NEWS },
    ],
    dataQuality: dq,
    now: new Date('2026-11-30T23:40:00Z'),
  }).pack;
}

/** 一份合格的外殼（判斷 = verdict）。 */
function sample(verdict: string, over: Record<string, unknown> = {}) {
  return {
    run_id: '2026-11-30_OWN_REVIEW_MU_abc123',
    function: 'OWN_REVIEW',
    as_of: '2026-11-30',
    model: 'claude-opus-5-5',
    prompt_version: 'own_review_v1',
    verdict,
    premise_checks: [
      { premise_id: 'P1', status: 'HOLDS', evidence_ids: ['E2'] },
      { premise_id: 'P2', status: 'HOLDS', evidence_ids: ['E1'] },
    ],
    evidence: [
      { id: 'E1', source_id: 'edgar:0000723125-26-000045', date: '2026-10-02', quote: 'Gross margin was 61.2% in the third quarter', claim: '毛利率 61.2%，仍在 60% 以上' },
      { id: 'E2', source_id: 'news:reuters-2026-11-20', date: '2026-11-20', quote: 'fully booked under long-term agreements with pricing set in advance', claim: '2027 年的 HBM 已用長約訂滿、價格事先談定' },
    ],
    lift_or_flip: [],
    abstain_reason: null,
    data_quality: {},
    payload: {
      conditions: [
        { id: 'C1', kind: 'XBRL', text: '毛利率低於 58%', check: { type: 'xbrl_metric_below', metric: 'GrossMarginPct', level: 0.58, quarters: 1 }, basis: ['E1'], tier_if_met: 'HALF' },
        { id: 'C2', kind: 'EVENT', text: 'HBM 長約被重新議價', check: { type: 'event', confirm_by: ['8-K'] }, basis: ['E2'], tier_if_met: 'EXIT' },
      ],
    },
    report: '前提都還成立。\n\n毛利率 61.2%，HBM 2027 年已訂滿。',
    ...over,
  };
}

// ---------------------------------------------------------------- 四種情況

describe('完成條件：四種情況', () => {
  it('合格：3 票一致、引用都通過 → 可以採用（A3 月報並列）', () => {
    const o = judge(testPack(), [sample('STANDARD'), sample('STANDARD'), sample('STANDARD')]);
    expect(o).toMatchObject({ status: 'AGREED', verdict: 'STANDARD', votes: { STANDARD: 3 }, actionable: true, followRule: false });
    expect(o.samples.every((s) => s.valid && s.evidence.every((e) => e.ok))).toBe(true);
    expect(o.samples[0].conditions.map((c) => c.auto)).toEqual([true, true]);
  });

  it('不合格：格式不對的票算成「證據不足」；三票都不對 → 照規則', () => {
    const bad = [{ verdict: 'SELL_ALL', evidence: [] }, 'not json', sample('STANDARD', { extra_field: 1 })];
    const o = judge(testPack(), bad);
    expect(o).toMatchObject({ status: 'INVALID', actionable: false, followRule: true });
    expect(o.samples[0].issues[0]).toContain('verdict 不在列舉值內');
    expect(o.samples[1].issues[0]).toBe('這一票不是 JSON 物件');
    expect(o.samples[2].issues[0]).toContain('多了不認得的欄位：extra_field');
    // 一票不合格、兩票合格 → 不一致（不合格的那票算 HOLD）
    const o2 = judge(testPack(), [sample('HALF'), sample('HALF'), bad[0]]);
    expect(o2).toMatchObject({ status: 'SPLIT', votes: { HALF: 2, HOLD: 1 }, followRule: true });
  });

  it('不合格：引用都不是原文 → 證據全被刪掉 → 每一票降級成「證據不足」→ 照規則', () => {
    const fake = sample('EXIT', {
      evidence: [{ id: 'E1', source_id: 'edgar:0000723125-26-000045', date: '2026-10-02', quote: 'Gross margin collapsed to 40% in the third quarter', claim: '毛利率崩到 40%' }],
      premise_checks: [{ premise_id: 'P2', status: 'BROKEN', evidence_ids: ['E1'] }],
    });
    const o = judge(testPack(), [fake, fake, fake]);
    expect(o).toMatchObject({ status: 'INSUFFICIENT', verdict: 'HOLD', actionable: false, followRule: true });
    const s = o.samples[0];
    expect(s.rawVerdict).toBe('EXIT');
    expect(s.evidence[0]).toMatchObject({ ok: false, why: '引用不是原文的子字串' });
    expect(s.premises[0]).toMatchObject({ status: 'INSUFFICIENT', downgradedFrom: 'BROKEN' });
    expect(s.issues.at(-1)).toContain('通過檢查的證據只有 0 條');
  });

  it('逾時：觸發之後一直沒有結果 → 照規則', async () => {
    await withDb(async (db) => {
      const env: Env = { DB: db, ROUTINE_FIRE_URL: 'https://api.example/fire', ROUTINE_TOKEN: 'rt' };
      const t0 = new Date('2026-11-30T23:40:00Z');
      const run = await startRun(env, fireOk, testPack(), t0);
      expect(run).toMatchObject({ status: 'PENDING', outcome: null });
      expect(await closeStaleRuns(db, new Date(t0.getTime() + 10 * 60_000))).toBe(0);
      const late = new Date(t0.getTime() + TASK_TIMEOUT_MS + 60_000);
      const r = (await getRun(db, run.runId, late))!;
      expect(r.status).toBe('DONE');
      expect(r.outcome).toMatchObject({ status: 'TIMEOUT', followRule: true, actionable: false });
      expect(r.outcome!.reason).toContain('沒有收到結果');
    });
  });

  it('票數不一致：2 比 1 → 照規則並記錄每一票', () => {
    const o = judge(testPack(), [sample('HALF'), sample('HALF'), sample('STANDARD')]);
    expect(o).toMatchObject({ status: 'SPLIT', verdict: 'HALF', votes: { HALF: 2, STANDARD: 1 }, actionable: false, followRule: true });
    expect(o.reason).toBe('3 票不一致（HALF 2、STANDARD 1），照規則並記錄。');
    expect(o.samples).toHaveLength(3);
    // 少送一票也算不一致（少的那票是 HOLD）
    expect(judge(testPack(), [sample('HALF'), sample('HALF')])).toMatchObject({ status: 'SPLIT', votes: { HALF: 2, HOLD: 1 } });
  });
});

// ---------------------------------------------------------------- 各項檢查

describe('程式檢查（§2.3）', () => {
  it('證據：來源不在證據包、日期在決策日之後、引用太短，都會被刪掉；其他證據照留', () => {
    const s = checkSample(
      testPack(),
      sample('STANDARD', {
        evidence: [
          ...sample('STANDARD').evidence,
          { id: 'E3', source_id: 'news:made-up', date: '2026-11-01', quote: 'something somewhere happened', claim: 'x' },
          { id: 'E4', source_id: 'news:reuters-2026-11-20', date: '2026-12-02', quote: 'fully booked under long-term agreements', claim: '未來的日期' },
          { id: 'E5', source_id: 'news:reuters-2026-11-20', date: '2026-11-20', quote: 'Micron', claim: '太短' },
        ],
      }),
      0,
    );
    expect(s.evidence.map((e) => [e.id, e.ok, e.why ?? null])).toEqual([
      ['E1', true, null],
      ['E2', true, null],
      ['E3', false, '來源 news:made-up 不在證據包裡'],
      ['E4', false, '日期 2026-12-02 在決策日 2026-11-30 之後'],
      ['E5', false, `引用太短（至少 ${MIN_QUOTE} 個字）`],
    ]);
    expect(s.verdict).toBe('STANDARD');
  });

  it('引用比對不受彎引號、破折號、換行影響', () => {
    expect(normalizeText('pricing  set\nin “advance” — ok')).toBe('pricing set in "advance" - ok');
    const s = checkSample(testPack(), sample('STANDARD', { evidence: [{ id: 'E2', source_id: 'news:reuters-2026-11-20', date: '2026-11-20', quote: 'fully booked under\n long-term   agreements', claim: 'x' }] }), 0);
    expect(s.evidence[0].ok).toBe(true);
  });

  it('條件：類型不在清單、數字門檻沒有對應通過的證據 → 改標人工', () => {
    const s = checkSample(
      testPack(),
      sample('STANDARD', {
        lift_or_flip: [
          { type: 'rsi_below', level: 30 },
          { type: 'price_close_below', ticker: 'MU', level: 90, basis: ['E9'] },
          { type: 'price_close_above', ticker: 'MU', level: 120, basis: ['E1'] },
          { type: 'date_after', date: '2027-03-01' },
        ],
      }),
      0,
    );
    expect(s.conditions.filter((c) => c.from === 'lift_or_flip').map((c) => [c.type, c.auto, c.why ?? null])).toEqual([
      ['rsi_below', false, '條件類型 rsi_below 不在允許的清單內'],
      ['price_close_below', false, '數字門檻沒有對應到一條通過檢查的證據'],
      ['price_close_above', true, null],
      ['date_after', true, null],
    ]);
  });

  it('資料缺漏：一致也不能改變下單（A3／A4），照規則並記錄', () => {
    const o = judge(testPack({}, { filings: 'ok', news: 'missing' }), [sample('HALF'), sample('HALF'), sample('HALF')]);
    expect(o).toMatchObject({ status: 'DATA_MISSING', verdict: 'HALF', actionable: false, followRule: true });
    expect(o.reason).toContain('news');
  });

  it('A2（只說明）：一致也只記影子，不改變下單', () => {
    const pack = testPack({ level: 'A2', verdicts: ['FOLLOW', 'DELAY', 'INSUFFICIENT'], abstain: 'INSUFFICIENT' });
    const o = judge(pack, [sample('DELAY'), sample('DELAY'), sample('DELAY')]);
    expect(o).toMatchObject({ status: 'AGREED', verdict: 'DELAY', actionable: false, followRule: true });
  });

  it('單次執行（samples = 1）：一票合格就是結論', () => {
    const o = decide(testPack({ samples: 1 }), [checkSample(testPack({ samples: 1 }), sample('HALF'), 0)]);
    expect(o).toMatchObject({ status: 'AGREED', verdict: 'HALF', actionable: true });
  });

  it('證據包：決策日之後的原文拿掉，太長的截短，編號重複的拿掉', () => {
    const { pack, notes } = buildPack({
      runId: 'x',
      fn: 'TEST',
      promptVersion: 'v',
      asOf: '2026-11-30',
      question: 'q',
      policy: { level: 'A1', verdicts: ['OK', 'INSUFFICIENT'], abstain: 'INSUFFICIENT', min_evidence: 0, samples: 1 },
      rule: { action: '—' },
      documents: [
        { id: 'D1', source_id: 'a', kind: 'news', date: '2026-12-01', title: '未來', text: 'x' },
        { id: 'D2', source_id: 'b', kind: 'filing', date: '2026-11-01', title: '很長', text: 'y'.repeat(70_000) },
        { id: 'D3', source_id: 'b', kind: 'filing', date: '2026-11-01', title: '重複', text: 'z' },
      ],
      now: new Date(),
    });
    expect(pack.documents.map((d) => d.source_id)).toEqual(['b']);
    expect(pack.documents[0].text.length).toBeLessThan(61_000);
    expect(notes).toHaveLength(3);
    expect(() => buildPack({ runId: 'x', fn: 'T', promptVersion: 'v', asOf: '2026-11-30', question: 'q', policy: { level: 'A1', verdicts: ['OK'], abstain: 'NO', min_evidence: 0, samples: 1 }, rule: { action: '' }, now: new Date() })).toThrow();
    expect(newRunId('2026-11-30', 'OWN_REVIEW', 'MU')).toMatch(/^2026-11-30_OWN_REVIEW_MU_[0-9a-f]{6}$/);
  });
});

// ---------------------------------------------------------------- 整趟來回與網站

const fireOk: Fetcher = async () => Response.json({ claude_code_session_url: 'https://claude.ai/code/session_x' });

async function withDb(fn: (db: D1Database) => Promise<void>) {
  const d = await freshDb();
  try {
    await fn(d.db);
  } finally {
    await d.dispose();
  }
}

/** 有價格、有帳戶（自選 NVDA），可以用真的資料組證據包。 */
async function withAccount(fn: (db: D1Database, env: Env, w: ReturnType<typeof newWorld>) => Promise<void>) {
  await withDb(async (db) => {
    const w = newWorld('2026-11-19');
    const env: Env = { DB: db, ADMIN_TOKEN: 't', AI_TASK_SECRET: 's', ROUTINE_FIRE_URL: 'https://api.example/fire', ROUTINE_TOKEN: 'rt', DEV_NO_AUTH: '1' };
    await runFlow(env, fakeFetcher(w), { now: cronTime('2026-11-19'), attempt: 'FIRST' });
    const { view } = buildMarketView(await loadSeries(db, ['VOO', 'SGOV', 'NVDA']), '2026-11-19', 'VOO');
    const acct = createAccount({ paper: true, cash: 5000, core: { VOO: 100 }, own: { NVDA: { shares: 50, stdWeight: 0.08, premises: [{ id: 'P1', text: '資料中心需求延續到 2027', origin: 'USER' }] } } }, view);
    await saveAccount(db, acct, null, '建立帳戶', new Date('2026-11-19T12:00:00Z'));
    await fn(db, env, w);
  });
}

describe('整趟來回：建任務 → 取證據包 → 送回 → 檢查與表決', () => {
  it('用帳戶與價格組證據包；雲端排程取得到；送回 3 票之後紀錄有結論與過程', async () => {
    await withAccount(async (db, env) => {
      const loaded = (await loadAccount(db))!;
      const series = await loadSeries(db, ['VOO', 'NVDA']);
      const built = buildMarketView(series, '2026-11-19', 'VOO');
      const facts = [...priceFacts(built.view, 'NVDA'), ...ownRuleFacts(loaded.acct, built.view, 'NVDA')];
      expect(facts.find((f) => f.label === '慢規則狀態')!.value).toBe('標準');
      const doc = priceDoc(built.view, built.axis, 'NVDA', 5)!;
      expect(doc.text.split('\n')).toHaveLength(5);
      const { pack } = buildPack({
        runId: newRunId('2026-11-19', 'OWN_REVIEW', 'NVDA'),
        fn: 'OWN_REVIEW',
        promptVersion: 'own_review_v1',
        asOf: '2026-11-19',
        subject: { ticker: 'NVDA' },
        question: '前提哪些成立？',
        policy: { level: 'A3', verdicts: ['EXIT', 'HALF', 'HOLD', 'STANDARD'], abstain: 'HOLD', min_evidence: 1, samples: 3 },
        rule: { action: '規則沒有動作' },
        facts,
        premises: ownPremises(loaded.acct, 'NVDA'),
        documents: [doc],
        now: new Date('2026-11-19T23:40:00Z'),
      });
      const fired: { url: string; body: string }[] = [];
      const now = new Date('2026-11-19T23:40:00Z');
      const run = await startRun(env, async (url, init) => (fired.push({ url, body: String(init?.body) }), fireOk(url, init)), pack, now);
      expect(fired[0].body).toBe(JSON.stringify({ text: `task_id=${run.taskId}` }));

      const auth = { Authorization: 'Bearer s' };
      const ev = (await (await handle(new Request(`https://bot.example/ai/task/${run.taskId}/evidence`, { headers: auth }), env, fireOk, now)).json()) as { kind: string; evidence: { run_id: string; pack: EvidencePack } };
      expect(ev.kind).toBe('RUN');
      expect(ev.evidence.pack.run_id).toBe(pack.run_id);

      const line = doc.text.split('\n')[2];
      const vote = (v: string) => ({
        run_id: pack.run_id,
        verdict: v,
        model: 'claude-opus-5-5',
        premise_checks: [{ premise_id: 'P1', status: 'HOLDS', evidence_ids: ['E1'] }],
        evidence: [{ id: 'E1', source_id: 'price:NVDA', date: '2026-11-19', quote: line, claim: '價格仍在上升' }],
        payload: {},
        report: '前提成立，回到標準。',
      });
      const body = { task_id: run.taskId, kind: 'RUN', run_id: pack.run_id, samples: [vote('STANDARD'), vote('STANDARD'), vote('STANDARD')], process: [{ role: '經理', model: 'claude-opus-5-5', text: '逐條判斷……' }] };
      const res = await handle(new Request(`https://bot.example/ai/task/${run.taskId}/result`, { method: 'POST', headers: auth, body: JSON.stringify(body) }), env, fireOk, now);
      expect(res.status).toBe(200);
      const done = (await getRun(db, run.runId, now))!;
      expect(done).toMatchObject({ status: 'DONE', outcome: { status: 'AGREED', verdict: 'STANDARD', actionable: true } });
      expect(done.process[0].role).toBe('經理');

      // 網站：紀錄列表、單次執行頁、匯出 md；建議單上的 AI 說明
      const api = (path: string) => handle(new Request('https://bot.example/api' + path), env, fireOk, now);
      const hist = (await (await api('/history')).json()) as { runs: { id: string; label: string; verdict: string; statusLabel: string }[] };
      expect(hist.runs[0]).toMatchObject({ id: run.runId, label: '自選定期審查', verdict: '回到標準', statusLabel: '票數一致' });
      const det = (await (await api(`/ai/run/${run.runId}`)).json()) as ReturnType<typeof runDetail>;
      expect(det.votes).toEqual([{ verdict: 'STANDARD', text: '回到標準', n: 3 }]);
      expect(det.samples[0].evidence[0]).toMatchObject({ ok: true, quote: line });
      expect(det.premises[0].votes.map((v) => v.label)).toEqual(['成立', '成立', '成立']);
      expect(det.followUp.map((f) => f.text)).toEqual(['還沒到', '還沒到', '還沒到']);
      const md = await api(`/ai/run/${run.runId}/md`);
      expect(md.headers.get('Content-Type')).toContain('text/markdown');
      expect(md.headers.get('Content-Disposition')).toContain(`${run.runId}.md`);
      const text = await md.text();
      expect(text).toContain('# 自選定期審查：NVDA（2026-11-19）');
      expect(text).toContain('你是反方審查員');
      expect(text).toContain('NVDA 目前持有：自選 50 股');
      expect(text).toContain(`✓ [E1] price:NVDA（2026-11-19）「${line}」`);
      const note = noteOfRun(done)!;
      expect(note).toMatchObject({ kind: 'REVIEW', ticker: 'NVDA', verdict: '回到標準', votes: '3 票一致', fake: false });
      expect(note.premises![0]).toMatchObject({ status: 'HOLDS', origin: 'USER', evidence: '價格仍在上升' });
    });
  });

  it('整份送回的格式就不對 → 任務退回、紀錄存「沒有結果，照規則」；觸發失敗也一樣', async () => {
    await withAccount(async (db, env) => {
      const now = new Date('2026-11-19T23:40:00Z');
      const run = await startRun(env, fireOk, testPack(), now);
      const res = await handle(new Request(`https://bot.example/ai/task/${run.taskId}/result`, { method: 'POST', headers: { Authorization: 'Bearer s' }, body: JSON.stringify({ task_id: run.taskId, kind: 'RUN', run_id: 'other', samples: [] }) }), env, fireOk, now);
      expect(res.status).toBe(422);
      const r = (await getRun(db, run.runId, now))!;
      expect(r.outcome).toMatchObject({ status: 'NO_RESULT', followRule: true });
      expect(r.outcome!.reason).toContain('run_id 和證據包不同');

      const pack2 = { ...testPack(), run_id: '2026-11-30_OWN_REVIEW_MU_zzz999' };
      const r2 = await startRun(env, async () => new Response('nope', { status: 500 }), pack2, now);
      expect(r2.outcome).toMatchObject({ status: 'NO_RESULT', followRule: true });
      expect(r2.outcome!.reason).toContain('雲端排程沒有觸發成功');
      expect((await listRuns(db, now)).map((x) => x.outcome?.status)).toEqual(['NO_RESULT', 'NO_RESULT']);
    });
  });

  it('匯出 md：證據包很長時只放前面，完整原文在網站', () => {
    const p = testPack();
    p.documents[0].text = 'x'.repeat(7000);
    const md = exportMd({ runId: p.run_id, fn: p.function, ticker: 'MU', asOf: p.as_of, createdAt: '', status: 'DONE', taskId: null, promptVersion: 'v', packHash: 'sha256:0', pack: p, packNotes: [], outcome: judge(p, [sample('HOLD')]), process: [], completedAt: null }, { background: ['測試'] });
    expect(md).toContain('以下省略，完整原文在網站');
  });
});

// ---------------------------------------------------------------- 影子組合

describe('影子組合：照規則、照 AI、你實際', () => {
  const axis = Array.from({ length: 200 }, (_, k) => `2026-${String(1 + Math.floor(k / 28)).padStart(2, '0')}-${String(1 + (k % 28)).padStart(2, '0')}`);
  const close = {
    MU: Float64Array.from(axis, (_, k) => 100 + k), // 每天漲 1
    SPY: Float64Array.from(axis, () => 500),
  };
  const book = bookFromView(axis, close);
  const rec = (o: Partial<ShadowRecord>): ShadowRecord => ({ date: axis[10], f: 'F7', ticker: 'MU', title: 'MU 慢規則減半', rule: -10, ai: null, actual: 0, price: 110, choice: 'SKIP', ...o });

  it('規則說賣 10 股、你沒賣：之後漲了，照規則會少賺；照 AI（不動）和你一樣', () => {
    const s = shadowSummary([rec({ ai: 0 })], book);
    const row = s.rows[0];
    expect(row).toMatchObject({ ruleDiff: -10, aiDiff: 0 });
    // 1 個月 = 21 個交易日：110 → 131
    expect(row.at['1m']!.rule).toBeCloseTo(-10 * 21);
    expect(row.at['6m']!.rule).toBeCloseTo(-10 * 126);
    const by = Object.fromEntries(s.lines.map((l) => [l.key, l]));
    expect(by['3m']).toMatchObject({ nRule: 1, nAi: 0, pending: 0 });
    expect(by['3m'].rule).toBeCloseTo(-630);
    expect(by.now.rule).toBeCloseTo(-10 * (199 - 10));
  });

  it('還沒過觀察期的不算進來；沒有股數差的紀錄不列', () => {
    const s = shadowSummary([rec({ date: axis[150] }), rec({ rule: 5, actual: 5 })], book);
    expect(s.rows).toHaveLength(1);
    const by = Object.fromEntries(s.lines.map((l) => [l.key, l]));
    expect(by['1m']).toMatchObject({ nRule: 1, pending: 0 });
    expect(by['3m']).toMatchObject({ nRule: 0, pending: 1 });
  });

  it('AI 判斷之後的報酬（相對基準）；成績用 Beta 後驗', () => {
    const f = followUp(book, 'MU', axis[10], 'SPY');
    expect(f['1m']!.ret).toBeCloseTo(21 / 110);
    expect(f['1m']!.bench).toBe(0);
    expect(followUp(book, 'MU', axis[190], 'SPY')['1m']).toBeNull();
    // ai_layer_design §8.3 的表：7/10 → P(準確率 > 50%) ≈ 0.89，90% 區間 0.44～0.86
    const b = betaSummary(7, 10);
    expect(b.pAbove50).toBeCloseTo(0.887, 2);
    expect(b.lo).toBeCloseTo(0.44, 2);
    expect(b.hi).toBeCloseTo(0.86, 2);
  });
});
