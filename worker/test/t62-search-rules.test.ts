// T62：找資料的三條規則（composite_layer_design §2.4）。
// 完成條件：
//   三個 prompt 與 run.md 都寫明同一個網站一次執行最多 4 篇（數字拿程式的常數比對）
//   取文件的順序：先取最新的、和現有說法相反的，再取支持的；8 份至少留 2 份給相反方向；找不到相反的要寫明找過什麼
//   審查與減半檢視的分析師對每一條前提的每一個 breaksIf 子句各列一個問題，沒找到的寫「沒有資料」（草稿的研究員沒有這一條）
//   不做：把草稿引用過的文件帶進審查的證據包（web_evidence §2.4 第 4 點不動）
//   （程式）逐句的問題不再被「最多 6 個」擋掉；運作統計記下每句有沒有各一個問題（只是紀錄）
// prompt 的內容用讀檔斷言；AI 的回覆一律是假的。repo 是公開的。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DOCS_MAX, DOCS_MAX_CALLS, DOCS_MAX_CHARS, LOOKUP_QUESTIONS, clauseSlots, cleanLookups, questionsCap } from '../src/ai/added';
import { OWN_DRAFT_PROMPT } from '../src/ai/ownDraft';
import { OWN_DROP_PROMPT } from '../src/ai/drops';
import { OWN_REVIEW_PROMPT } from '../src/ai/ownReview';
import type { AiRun } from '../src/app/aiRuns';
import type { Env, Fetcher } from '../src/app/env';
import { foundView } from '../src/app/site/aiViews';
import type { OpsReport, Row } from '../src/app/opsReport';
import { handle } from '../src/index';
import { WEB_DOC_PER_SITE } from '../src/data/webDoc';
import { freshDb } from './helpers/d1';

const PROMPTS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'ai', 'prompts');
const read = (f: string) => readFileSync(join(PROMPTS, f), 'utf8');

const DRAFT = `${OWN_DRAFT_PROMPT}.md`;
const REVIEW = `${OWN_REVIEW_PROMPT}.md`;
const DROP = `${OWN_DROP_PROMPT}.md`;
const ALL = ['run.md', DRAFT, REVIEW, DROP];

describe('T62 prompt：沒有升版號，三個檔與 run.md 都照 §2.4 寫', () => {
  it('沒有升版：草稿 v2、審查 v4、減半檢視 v4（T60、T61 剛升、還沒部署）', () => {
    expect([OWN_DRAFT_PROMPT, OWN_REVIEW_PROMPT, OWN_DROP_PROMPT]).toEqual(['own_draft_v4', 'own_review_v6', 'own_drop_v6']);
  });

  it('① 同一個網站一次執行最多 4 篇：每個檔都寫、數字等於 WEB_DOC_PER_SITE；沒有別的數字', () => {
    expect(WEB_DOC_PER_SITE).toBe(4);
    for (const f of ALL) {
      const t = read(f);
      expect(t, f).toContain(`同一個網站一次執行最多 ${WEB_DOC_PER_SITE} 篇`);
      const nums = [...t.matchAll(/同一個網站一次執行最多\s*(\d+)\s*篇/g)].map((m) => Number(m[1]));
      expect(nums.length, f).toBeGreaterThan(0);
      expect(new Set(nums), f).toEqual(new Set([WEB_DOC_PER_SITE]));
    }
  });

  it('取文件的總上限在每個檔裡和程式的常數一致（8 份、60,000 字、6 次）', () => {
    expect([DOCS_MAX, DOCS_MAX_CHARS, DOCS_MAX_CALLS]).toEqual([8, 60_000, 6]);
    const chars = DOCS_MAX_CHARS.toLocaleString('en-US');
    expect(read('run.md')).toContain(`上限：${DOCS_MAX} 份、${chars} 字、${DOCS_MAX_CALLS} 次`);
    expect(read(DRAFT)).toContain(`這次執行最多取回 ${DOCS_MAX} 份、合計 ${chars} 字、呼叫 ${DOCS_MAX_CALLS} 次`);
    for (const f of [REVIEW, DROP]) expect(read(f), f).toContain(`這次執行最多取回 ${DOCS_MAX} 份、合計 ${chars} 字、最多呼叫 ${DOCS_MAX_CALLS} 次`);
  });

  it('② 取文件的順序：先取最新的、和現有說法相反的，再取支持的；8 份至少留 2 份給相反方向；找不到相反的要寫明找過什麼', () => {
    for (const f of ALL) {
      const t = read(f);
      const first = t.indexOf('先取最新的、和現有說法相反的');
      expect(first, f).toBeGreaterThan(-1);
      expect(t.indexOf('再取支持的', first), f).toBeGreaterThan(first);
      expect(t, f).toContain(`${DOCS_MAX} 份裡**至少留 2 份給相反方向**`);
      expect(t, f).toContain('找不到相反方向的文件時');
      expect(t, f).toContain('寫明找過什麼');
      expect(t, f).toContain('搜尋的字、取過與被拒絕的網址');
      expect(t, f).toContain('不能只寫「沒有」');
      expect(t, f).toContain('`wanted` 的 `why` 開頭寫「相反：」或「支持：」');
    }
    // run.md 的寫法稍有不同（「這次執行的 8 份裡」），數字一樣
    expect(read('run.md')).toContain('這次執行的 8 份裡**至少留 2 份給相反方向**');
    // 三個功能 prompt 另外寫明要寫在哪裡：摘要的「這次另外找的資料」那一段（分析師、研究員交給後面角色的那份）
    expect(read(REVIEW)).toContain('摘要的第五段寫「沒有找到相反方向的資料」');
    expect(read(DROP)).toContain('摘要的最後一段寫「沒有找到相反方向的資料」');
    expect(read(DRAFT)).toContain('事實摘要的「這次另外找的資料」寫「沒有找到相反方向的資料」');
  });

  it('③ 審查與減半檢視的分析師對每一條前提的每一個 breaksIf 子句各列一個問題；沒找到的寫「沒有資料」；草稿的研究員沒有這一條', () => {
    for (const f of [REVIEW, DROP]) {
      const t = read(f);
      expect(t, f).toContain('對每一條前提的**每一個** `breaksIf` 子句各列一個問題（沒有 `breaksIf` 的前提列一個）');
      expect(t, f).toContain('`for` 寫前提編號，`ask` 開頭寫「第 n 句：」');
      expect(t, f).toContain('不要把幾句併成一個問題');
      expect(t, f).toContain('**沒找到資料的子句寫「沒有資料」**');
      expect(t, f).toContain('每一條前提的每一句 `breaksIf` 各一行');
      // 逐句的問題不佔「其他最多 6 個」；lookups 的說明跟著改
      expect(t, f).toContain(`其他的最多 ${LOOKUP_QUESTIONS} 個`);
      expect(t, f).toContain('最多 5 條前提 × 3 句');
      expect(t, f).not.toContain('第 1 步列的問題（最多 6 個）');
    }
    expect(read(DRAFT)).not.toContain('每一個** `breaksIf` 子句各列一個問題');
    expect(read(DRAFT)).toContain('最多 6 個'); // 研究員的問題還是最多 6 個
    // run.md 是共用的外殼：不寫「每一句」（那是兩個功能的 prompt 的事）
    expect(read('run.md')).not.toContain('每一個** `breaksIf` 子句');
  });

  it('不做：審查與減半檢視的 prompt 沒有「把草稿引用過的文件帶進證據包」；web_evidence §2.4 第 4 點的文字還在設計文件裡', () => {
    for (const f of [REVIEW, DROP]) expect(read(f), f).not.toContain('草稿');
    const design = readFileSync(join(PROMPTS, '..', '..', 'docs', 'design', 'web_evidence_design_2026-11-20.md'), 'utf8');
    expect(design).toContain('### 2.4 怎麼避免 AI 出題又改考卷');
    const comp = readFileSync(join(PROMPTS, '..', '..', 'docs', 'design', 'composite_layer_design_2026-11-21.md'), 'utf8');
    expect(comp).toContain('不做：把草稿引用過的文件帶進審查的證據包');
  });
});

// ---------------------------------------------------------------- 程式：問題數的上限跟著子句數

describe('T62 逐句的問題：上限、紀錄頁的提示、運作統計', () => {
  const ps = [{ breaksIf: ['a', 'b'] }, { breaksIf: ['a', 'b', 'c'] }, {}, { breaksIf: [] }];

  it('clauseSlots：每句一個、沒有 breaksIf 的前提算一個；questionsCap：審查與減半檢視加上句數、草稿與別的功能照舊 6 個', () => {
    expect(clauseSlots(ps)).toBe(2 + 3 + 1 + 1);
    expect(clauseSlots([])).toBe(0);
    expect(clauseSlots(undefined)).toBe(0);
    expect(questionsCap('OWN_REVIEW', ps)).toBe(LOOKUP_QUESTIONS + 7);
    expect(questionsCap('OWN_DROP', ps)).toBe(LOOKUP_QUESTIONS + 7);
    expect(questionsCap('OWN_DRAFT', ps)).toBe(LOOKUP_QUESTIONS);
    expect(questionsCap('OWN_REVIEW', undefined)).toBe(LOOKUP_QUESTIONS);
    // 最多 5 條前提、每條 3 句
    expect(questionsCap('OWN_REVIEW', Array.from({ length: 5 }, () => ({ breaksIf: ['a', 'b', 'c'] })))).toBe(LOOKUP_QUESTIONS + 15);
  });

  it('cleanLookups：最多 5 條前提 × 3 句加上其他 6 個（21 個）都存得下', () => {
    const qs = Array.from({ length: 21 }, (_, k) => ({ for: `P${(k % 5) + 1}`, ask: `第 ${k} 句` }));
    expect(cleanLookups({ questions: qs })!.questions).toHaveLength(21);
  });

  it('審查紀錄頁：問題數在「6 + 句數」以內不提示；超過才寫「超過規定的 N 個」；草稿照舊 6 個', () => {
    const base = { runId: 'r', ticker: 'MU', asOf: '2026-11-20', status: 'DONE', outcome: null, docCtx: { menu: [], notBefore: '', domains: [], fileId: null } };
    const q = (n: number) => ({ questions: Array.from({ length: n }, (_, k) => ({ for: 'P1', ask: `q${k}` })), queries: [], wanted: [] });
    const pack = { documents: [], premises: [{ id: 'P1', text: 'x', breaksIf: ['a', 'b', 'c'] }, { id: 'P2', text: 'y' }] }; // 4 句
    const rev = (n: number) => foundView({ ...base, fn: 'OWN_REVIEW', pack, lookups: q(n) } as unknown as AiRun)!;
    expect(rev(10).notes).toEqual([]); // 6 + 4
    expect(rev(11).notes).toEqual(['分析師列了 11 個問題，超過規定的 10 個。']);
    const draft = foundView({ ...base, fn: 'OWN_DRAFT', pack, lookups: q(7) } as unknown as AiRun)!;
    expect(draft.notes).toEqual(['分析師列了 7 個問題，超過規定的 6 個。']);
    expect(foundView({ ...base, fn: 'OWN_DRAFT', pack, lookups: q(6) } as unknown as AiRun)!.notes).toEqual([]);
  });
});

// 運作統計：clause_runs、clause_slots、clause_asked（只是紀錄，不影響任何一次執行）
const NOW = new Date('2026-11-25T03:00:00Z');
const fetcher: Fetcher = async () => new Response('x');
const json = (v: unknown) => (v === null || v === undefined ? null : JSON.stringify(v));

async function seed(db: D1Database, id: string, fn: string, o: { premises?: unknown[]; lookups?: unknown; off?: boolean; at?: string }) {
  const ctx = { menu: [], notBefore: '2026-07-01', domains: [], fileId: 'MU@2026-10-01', off: o.off ? '只有系統預設前提' : null };
  const at = o.at ?? '2026-11-18T00:00:00.000Z';
  await db
    .prepare("INSERT INTO ai_runs (run_id, fn, ticker, as_of, created_at, status, prompt_version, pack_hash, pack, doc_ctx, added_docs, lookups) VALUES (?, ?, 'MU', ?, ?, 'DONE', 'v1', 'h', ?, ?, ?, ?)")
    .bind(id, fn, at.slice(0, 10), at, json({ premises: o.premises ?? [] }), json(ctx), json({ calls: 1, chars: 0, docs: [], refused: [], refusedTotal: 0, sites: {} }), json(o.lookups))
    .run();
}
const lk = (...forIds: string[]) => ({ questions: forIds.map((f, k) => ({ for: f, ask: `q${k}` })), queries: [], wanted: [] });

describe('T62 運作統計：每一句 breaksIf 有沒有各一個問題', () => {
  it('web_runs 多 clause_runs、clause_slots、clause_asked：只算審查與減半檢視、有回報 lookups、可以找資料的；多問的不多算；for 不是那條前提的不算', async () => {
    const d = await freshDb();
    try {
      const P = [{ id: 'P1', text: 'a', breaksIf: ['x', 'y'] }, { id: 'P2', text: 'b', breaksIf: ['x', 'y', 'z'] }, { id: 'P3', text: 'c' }];
      // A：P1 兩句都問了（2）、P2 只問了一句（1）、P3 沒有 breaksIf 也沒問（0；for 寫 C1 的是條件的問題，不算）→ 句數 6、有問的 3
      await seed(d.db, 'a', 'OWN_REVIEW', { premises: P, lookups: lk('P1', 'P1', 'P2', 'C1') });
      // B：減半檢視，一句、問了三次（多的不多算）→ 1／1
      await seed(d.db, 'b', 'OWN_DROP', { premises: [{ id: 'P1', text: 'a', breaksIf: ['x'] }], lookups: lk('P1', 'P1', 'P1'), at: '2026-11-19T00:00:00.000Z' });
      // 不算的：不能找資料的（只有系統預設前提）、沒有回報 lookups、草稿、期間外
      await seed(d.db, 'c', 'OWN_REVIEW', { premises: P, lookups: lk('P1'), off: true, at: '2026-11-17T00:00:00.000Z' });
      await seed(d.db, 'd', 'OWN_REVIEW', { premises: P, at: '2026-11-16T00:00:00.000Z' });
      await seed(d.db, 'e', 'OWN_DRAFT', { premises: P, lookups: lk('P1', 'P2'), at: '2026-11-20T00:00:00.000Z' });
      await seed(d.db, 'f', 'OWN_REVIEW', { premises: P, lookups: lk('P1', 'P2'), at: '2026-11-05T00:00:00.000Z' });
      const env: Env = { DB: d.db, ADMIN_TOKEN: 'admin-secret', AI_TASK_SECRET: 'task-secret' };
      const res = await handle(new Request('https://bot.example/admin/ops-report?from=2026-11-11&to=2026-11-24', { headers: { Authorization: 'Bearer admin-secret' } }), env, fetcher, NOW);
      expect(res.status).toBe(200);
      const r = (await res.json()) as OpsReport;
      const s = r.sections.find((x) => x.id === 'web_runs')!;
      expect(s.error).toBeUndefined();
      const by = (fn: string): Row => s.rows.find((x) => x.fn === fn)!;
      expect(by('OWN_REVIEW')).toMatchObject({ runs: 3, lookups_reported: 2, clause_runs: 1, clause_slots: 6, clause_asked: 3 });
      expect(by('OWN_DROP')).toMatchObject({ clause_runs: 1, clause_slots: 1, clause_asked: 1 });
      expect(by('OWN_DRAFT')).toMatchObject({ clause_runs: 0, clause_slots: 0, clause_asked: 0 });
      expect(by('合計')).toMatchObject({ clause_runs: 2, clause_slots: 7, clause_asked: 4 });
    } finally {
      await d.dispose();
    }
  });
});
