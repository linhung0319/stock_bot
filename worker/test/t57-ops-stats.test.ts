// T57：成績與運作統計（web_evidence_design §2.4 第 7 點、§1.3、第 3 章）。
//   依前提來源分開的審查結果、每次執行取了幾份幾個字、被拒絕的原因、被略過與抓不到的網域、草稿的成功率與失敗原因；
//   匯出腳本（scripts/export_records.py）用假的 Worker（Node 的 http 伺服器接到真的 handle）存得到這幾段。
// 全部用假資料（repo 是公開的）。
import { execFile } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Env, Fetcher } from '../src/app/env';
import { LOOSE_MIN_CHECKS, OPS_SECTIONS, WEB_DOMAIN_ROWS, type OpsReport, type Row } from '../src/app/opsReport';
import { handle } from '../src/index';
import { freshDb } from './helpers/d1';

const NOW = new Date('2026-11-25T03:00:00Z');
const Q = '?from=2026-11-11&to=2026-11-24';
const fetcher: Fetcher = async () => new Response('x');

async function withDb(fn: (db: D1Database, env: Env) => Promise<void>) {
  const d = await freshDb();
  try {
    await fn(d.db, { DB: d.db, ADMIN_TOKEN: 'admin-secret', AI_TASK_SECRET: 'task-secret' });
  } finally {
    await d.dispose();
  }
}
const report = async (env: Env, query = Q): Promise<OpsReport> => {
  const res = await handle(new Request(`https://bot.example/admin/ops-report${query}`, { headers: { Authorization: 'Bearer admin-secret' } }), env, fetcher, NOW);
  expect(res.status).toBe(200);
  return (await res.json()) as OpsReport;
};
const rows = (r: OpsReport, id: string): Row[] => {
  const s = r.sections.find((x) => x.id === id);
  if (!s) throw new Error(`沒有 ${id} 這一段`);
  expect(s.error, id).toBeUndefined();
  return s.rows;
};
const row = (r: OpsReport, id: string, key: string, value: string): Row => {
  const found = rows(r, id).find((x) => x[key] === value);
  if (!found) throw new Error(`${id} 沒有 ${key} = ${value} 的列`);
  return found;
};

// ---------------------------------------------------------------- 構造資料

const run = (db: D1Database, sql: string, ...args: unknown[]) => db.prepare(sql).bind(...args).run();
const json = (v: unknown) => (v === null || v === undefined ? null : JSON.stringify(v));

interface PremiseSeed {
  id: string;
  text: string;
  /** 證據包裡寫的來源（草稿原樣勾選的在這裡也是 USER）。 */
  packOrigin: 'USER' | 'SYSTEM_DEFAULT';
  /** 每一票（合格的）判的結果。 */
  votes: string[];
}
async function review(db: D1Database, id: string, ticker: string, createdAt: string, premises: PremiseSeed[], opt: { fn?: string; outcomeStatus?: string; invalidVotes?: Record<string, string> } = {}) {
  const n = Math.max(...premises.map((p) => p.votes.length));
  const samples = Array.from({ length: n }, (_, k) => ({ index: k, valid: true, verdict: 'HOLD', premises: premises.filter((p) => p.votes[k]).map((p) => ({ premise_id: p.id, status: p.votes[k], evidence_ids: [] })) }));
  // 不合格的一票：它的前提判斷不算
  for (const [pid, st] of Object.entries(opt.invalidVotes ?? {})) samples.push({ index: samples.length, valid: false, verdict: 'abstain', premises: [{ premise_id: pid, status: st, evidence_ids: [] }] });
  const outcome = opt.outcomeStatus === 'TIMEOUT' ? { status: 'TIMEOUT', samples: [] } : { status: opt.outcomeStatus ?? 'AGREED', samples };
  const pack = { premises: premises.map((p) => ({ id: p.id, text: p.text, origin: p.packOrigin })) };
  await run(db, "INSERT INTO ai_runs (run_id, fn, ticker, as_of, created_at, status, prompt_version, pack_hash, pack, outcome) VALUES (?, ?, ?, ?, ?, 'DONE', 'v1', 'h', ?, ?)", id, opt.fn ?? 'OWN_REVIEW', ticker, createdAt.slice(0, 10), createdAt, json(pack), json(outcome));
}
async function history(db: D1Database, rev: number, at: string, own: Record<string, { id: string; text: string; origin: string }[]>) {
  const state = { own: Object.fromEntries(Object.entries(own).map(([t, premises]) => [t, { premises }])) };
  await run(db, "INSERT INTO account_history (rev, at, cause, state) VALUES (?, ?, 'test', ?)", rev, at, json(state));
}

async function seedPremises(db: D1Database) {
  const own1 = { NVDA: [{ id: 'P1', text: 'NVDA 資料中心營收維持成長', origin: 'USER' }, { id: 'P2', text: '毛利率不低於 70%', origin: 'AI_DRAFT_ACCEPTED' }, { id: 'P3', text: 'sys', origin: 'SYSTEM_DEFAULT' }], AMD: [{ id: 'P1', text: 'AMD 伺服器市占上升', origin: 'AI_DRAFT_ACCEPTED' }] };
  await history(db, 1, '2026-11-10T00:00:00.000Z', own1);
  // 11-16 中午 NVDA 的 P2 勾了草稿又改字：變成你寫的
  await history(db, 2, '2026-11-16T12:00:00.000Z', { ...own1, NVDA: [own1.NVDA[0], { id: 'P2', text: '毛利率不低於 72%', origin: 'USER' }, own1.NVDA[2]] });
  const P1 = { id: 'P1', text: 'NVDA 資料中心營收維持成長', packOrigin: 'USER' as const };
  const P3 = { id: 'P3', text: 'sys', packOrigin: 'SYSTEM_DEFAULT' as const };
  await review(db, 'r1', 'NVDA', '2026-11-16T00:00:00.000Z', [
    { ...P1, votes: ['HOLDS', 'HOLDS', 'HOLDS'] },
    { id: 'P2', text: '毛利率不低於 70%', packOrigin: 'USER', votes: ['HOLDS', 'HOLDS', 'HOLDS'] },
    { ...P3, votes: ['INSUFFICIENT', 'INSUFFICIENT', 'INSUFFICIENT'] },
  ]);
  await review(db, 'r2', 'NVDA', '2026-11-17T00:00:00.000Z', [
    { ...P1, votes: ['HOLDS', 'HOLDS', 'BROKEN'] },
    { id: 'P2', text: '毛利率不低於 72%', packOrigin: 'USER', votes: ['BROKEN', 'BROKEN', 'BROKEN'] },
    { ...P3, votes: ['HOLDS', 'HOLDS', 'HOLDS'] },
  ]);
  // 只有 2 票合格（第 3 票不合格，它寫的 BROKEN 不算）→ 票數不到 3 張：split
  await review(db, 'r3', 'AMD', '2026-11-18T00:00:00.000Z', [{ id: 'P1', text: 'AMD 伺服器市占上升', packOrigin: 'USER', votes: ['HOLDS', 'HOLDS'] }], { outcomeStatus: 'SPLIT', invalidVotes: { P1: 'BROKEN' } });
  // 帳戶裡沒有這檔：來源不明
  await review(db, 'r4', 'MU', '2026-11-19T00:00:00.000Z', [{ id: 'P1', text: 'MU 的 HBM 出貨成長', packOrigin: 'USER', votes: ['HOLDS', 'HOLDS', 'HOLDS'] }]);
  // 不算的：逾時、減半檢視、期間外
  await review(db, 'r5', 'NVDA', '2026-11-19T01:00:00.000Z', [{ ...P1, votes: ['BROKEN', 'BROKEN', 'BROKEN'] }], { outcomeStatus: 'TIMEOUT' });
  await review(db, 'r6', 'NVDA', '2026-11-19T02:00:00.000Z', [{ ...P1, votes: ['BROKEN', 'BROKEN', 'BROKEN'] }], { fn: 'OWN_DROP' });
  await review(db, 'r7', 'NVDA', '2026-11-05T00:00:00.000Z', [{ ...P1, votes: ['BROKEN', 'BROKEN', 'BROKEN'] }]);
}

async function aiDocRun(db: D1Database, id: string, fn: string, createdAt: string, o: { docCtx?: unknown; added?: unknown; lookups?: unknown }) {
  await run(db, "INSERT INTO ai_runs (run_id, fn, ticker, as_of, created_at, status, prompt_version, pack_hash, pack, doc_ctx, added_docs, lookups) VALUES (?, ?, 'NVDA', ?, ?, 'DONE', 'v1', 'h', '{}', ?, ?, ?)", id, fn, createdAt.slice(0, 10), createdAt, json(o.docCtx), json(o.added), json(o.lookups));
}
const doc = (kind: 'web' | 'filing', truncated = false) => ({ id: 'A1', source_id: 'x', kind, tier: kind === 'web' ? 'NAMED' : null, date: '2026-11-10', title: 't', url: null, text: '…', truncated });
const refusedItem = (reason: string) => ({ url: 'https://example.com/a', menu: null, reason, detail: null, for: null, why: null, at: '2026-11-18T00:00:00.000Z' });
const added = (a: { calls: number; chars: number; docs: unknown[]; refused: unknown[]; refusedTotal: number; sites: Record<string, number> }) => a;

async function seedWebRuns(db: D1Database) {
  const ctx = { menu: [], notBefore: '2026-07-01', domains: [], fileId: 'NVDA@2026-10-01', off: null };
  await aiDocRun(db, 'w1', 'OWN_REVIEW', '2026-11-16T00:00:00.000Z', { docCtx: { ...ctx, off: '只有系統預設前提' } });
  await aiDocRun(db, 'w2', 'OWN_REVIEW', '2026-11-17T00:00:00.000Z', { docCtx: ctx, added: added({ calls: 0, chars: 0, docs: [], refused: [], refusedTotal: 0, sites: {} }) });
  await aiDocRun(db, 'w3', 'OWN_REVIEW', '2026-11-18T00:00:00.000Z', {
    docCtx: ctx,
    added: added({ calls: 2, chars: 20000, docs: [doc('web'), doc('web', true), doc('filing')], refused: [refusedItem('THIN')], refusedTotal: 1, sites: { 'trendforce.com': 4, 'techpowerup.com': 1 } }),
    lookups: { questions: [{ for: 'P1', ask: 'a' }, { for: null, ask: 'b' }], queries: ['q1', 'q2', 'q3'], wanted: [{ url: 'u1' }, { menu: 'M1' }, { url: 'u2' }, { url: 'u3' }] },
  });
  await aiDocRun(db, 'w4', 'OWN_REVIEW', '2026-11-19T00:00:00.000Z', { docCtx: ctx, added: added({ calls: 1, chars: 0, docs: [], refused: [refusedItem('NOT_LISTED'), refusedItem('BLOCKED')], refusedTotal: 2, sites: {} }) });
  // 草稿：取滿 8 份、60,000 字；被拒絕 62 筆但只留 60 筆
  await aiDocRun(db, 'w5', 'OWN_DRAFT', '2026-11-20T00:00:00.000Z', {
    docCtx: ctx,
    added: added({
      calls: 3,
      chars: 60000,
      docs: [...Array.from({ length: 5 }, (_, k) => doc('web', k === 0)), doc('filing'), doc('filing'), doc('filing')],
      refused: [...Array.from({ length: 59 }, () => refusedItem('LIMIT')), refusedItem('TOO_OLD')],
      refusedTotal: 62,
      sites: { 'a.com': 4, 'b.com': 4 },
    }),
  });
  await aiDocRun(db, 'w6', 'OWN_DROP', '2026-11-21T00:00:00.000Z', {});
  // 不算的：別的功能、期間外
  await aiDocRun(db, 'w7', 'MOM_ENTRY', '2026-11-18T00:00:00.000Z', { added: added({ calls: 5, chars: 1, docs: [doc('web')], refused: [], refusedTotal: 0, sites: {} }) });
  await aiDocRun(db, 'w8', 'OWN_REVIEW', '2026-11-05T00:00:00.000Z', { docCtx: ctx, added: added({ calls: 1, chars: 9, docs: [doc('web')], refused: [refusedItem('ERROR')], refusedTotal: 1, sites: {} }) });
}

async function webDoc(db: D1Database, o: { url: string; status: string; at: string; domain?: string | null; error?: string | null; chars?: number | null; ticker?: string; title?: string | null }) {
  await run(db, "INSERT INTO web_docs (id, url, domain, ticker, via, fetched_at, status, error, chars, title) VALUES ('web:x', ?, ?, ?, 'SEARCH', ?, ?, ?, ?, ?)", o.url, o.domain ?? null, o.ticker ?? 'NVDA', o.at, o.status, o.error ?? null, o.chars ?? null, o.title ?? null);
}
async function seedWebDocs(db: D1Database) {
  // 被略過（NOT_LISTED）：視窗是 2026-08-27 00:00Z（含）到 2026-11-25 00:00Z（不含）
  await webDoc(db, { url: 'https://fool.com/x1', status: 'NOT_LISTED', error: 'EXCLUDED', at: '2026-11-16T00:00:00.000Z', title: 'Fool 1' });
  await webDoc(db, { url: 'https://www.fool.com/x2', status: 'NOT_LISTED', error: 'EXCLUDED', at: '2026-11-17T00:00:00.000Z', title: 'Fool 2' });
  await webDoc(db, { url: 'https://fool.com/x3', status: 'NOT_LISTED', error: 'EXCLUDED', at: '2026-11-18T00:00:00.000Z', ticker: 'MU', title: 'Fool 3' });
  await webDoc(db, { url: 'https://www.example.com/a', status: 'NOT_LISTED', error: 'NOT_LISTED', at: '2026-11-18T01:00:00.000Z' });
  await webDoc(db, { url: 'https://www.trendforce.com/research/download/1', status: 'NOT_LISTED', error: 'PATH', at: '2026-11-19T00:00:00.000Z', ticker: 'MU' });
  await webDoc(db, { url: 'https://edge.com/in', status: 'NOT_LISTED', error: 'NOT_LISTED', at: '2026-08-27T00:00:00.000Z' });
  await webDoc(db, { url: 'https://bad.com/old', status: 'NOT_LISTED', error: 'NOT_LISTED', at: '2026-08-26T23:59:59.000Z' });
  await webDoc(db, { url: 'https://later.com/new', status: 'NOT_LISTED', error: 'NOT_LISTED', at: '2026-11-25T00:00:00.000Z' });
  // 抓取（清單內）
  const tf = 'trendforce.com';
  await webDoc(db, { url: 'https://www.trendforce.com/news/1', domain: tf, status: 'OK', at: '2026-11-16T00:00:00.000Z', chars: 3000 });
  await webDoc(db, { url: 'https://www.trendforce.com/news/2', domain: tf, status: 'OK', at: '2026-11-17T00:00:00.000Z', chars: 3000 });
  await webDoc(db, { url: 'https://www.trendforce.com/news/3', domain: tf, status: 'THIN', error: '內文 900 字（不到 1500 字）', at: '2026-11-18T00:00:00.000Z', chars: 900 });
  await webDoc(db, { url: 'https://www.trendforce.com/news/4', domain: tf, status: 'BLOCKED', error: 'HTTP 403', at: '2026-11-19T00:00:00.000Z' });
  await webDoc(db, { url: 'https://www.trendforce.com/news/5', domain: tf, status: 'TOO_OLD', error: '發布日 2026-01-01 早於 2026-07-01', at: '2026-11-19T01:00:00.000Z', chars: 3000 });
  await webDoc(db, { url: 'https://www.trendforce.com/news/6', domain: tf, status: 'BLOCKED', error: 'HTTP 403', at: '2026-08-26T00:00:00.000Z' });
  const nv = 'nvidianews.nvidia.com';
  await webDoc(db, { url: 'https://nvidianews.nvidia.com/news/a', domain: nv, status: 'THIN', error: '內文 1000 字', at: '2026-11-16T00:00:00.000Z', chars: 1000 });
  await webDoc(db, { url: 'https://nvidianews.nvidia.com/news/b', domain: nv, status: 'THIN', error: '內文 500 字', at: '2026-11-17T00:00:00.000Z', chars: 500 });
  await webDoc(db, { url: 'https://nvidianews.nvidia.com/news/c', domain: nv, status: 'ERROR', error: '發布日 2026-12-01 晚於決策日 2026-11-18', at: '2026-11-18T00:00:00.000Z', chars: 3000 });
  await webDoc(db, { url: 'https://nvidianews.nvidia.com/news/d', domain: nv, status: 'NO_DATE', error: '認不出發布日', at: '2026-11-19T00:00:00.000Z', chars: 3000 });
  await webDoc(db, { url: 'https://www.techpowerup.com/1', domain: 'techpowerup.com', status: 'OK', at: '2026-11-16T00:00:00.000Z', chars: 2000 });
  await webDoc(db, { url: 'https://www.techpowerup.com/2', domain: 'techpowerup.com', status: 'OK', at: '2026-11-17T00:00:00.000Z', chars: 2000 });
  // 沒記網域的（用網址的主機）
  await webDoc(db, { url: 'https://www.weird.org/x', status: 'UNSUPPORTED', error: '不是網頁（application/pdf）', at: '2026-11-20T00:00:00.000Z' });
}

let draftSeq = 0;
async function draft(db: D1Database, o: { ticker: string; trigger: 'AUTO' | 'MANUAL'; status: string; created: string; settledMin?: number; error?: string; used?: unknown }) {
  const settled = o.settledMin === undefined ? null : new Date(Date.parse(o.created) + o.settledMin * 60_000).toISOString();
  await run(db, 'INSERT INTO own_drafts (ticker, file_id, run_id, trigger, session, created_at, status, error, settled_at, used_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', o.ticker, `${o.ticker}@2026-10-01`, `d${++draftSeq}`, o.trigger, o.created.slice(0, 10), o.created, o.status, o.error ?? null, settled, json(o.used));
}
async function seedDrafts(db: D1Database) {
  await draft(db, { ticker: 'NVDA', trigger: 'AUTO', status: 'READY', created: '2026-11-16T00:00:00.000Z', settledMin: 10 });
  await draft(db, { ticker: 'NVDA', trigger: 'AUTO', status: 'FAILED', created: '2026-11-17T00:00:00.000Z', settledMin: 5, error: '程式檢查沒過：反方不足' });
  await draft(db, { ticker: 'AMD', trigger: 'AUTO', status: 'FAILED', created: '2026-11-17T00:00:00.000Z', error: '沒有來取證據包' });
  await draft(db, { ticker: 'MU', trigger: 'AUTO', status: 'USED', created: '2026-11-18T00:00:00.000Z', settledMin: 20, used: { premises: { same: 2, edited: 1, kept: 1 }, exits: 1, unused: { premises: 1, exits: 2, sources: 0 } } });
  await draft(db, { ticker: 'NVDA', trigger: 'MANUAL', status: 'PENDING', created: '2026-11-20T00:00:00.000Z' });
  await draft(db, { ticker: 'AMD', trigger: 'MANUAL', status: 'READY', created: '2026-11-19T00:00:00.000Z', settledMin: 30 });
  await draft(db, { ticker: 'MU', trigger: 'MANUAL', status: 'DISMISSED', created: '2026-11-19T00:00:00.000Z', settledMin: 40 });
  await draft(db, { ticker: 'NVDA', trigger: 'MANUAL', status: 'EXPIRED', created: '2026-11-12T00:00:00.000Z', settledMin: 20 });
  await draft(db, { ticker: 'AMD', trigger: 'MANUAL', status: 'FAILED', created: '2026-11-21T00:00:00.000Z', settledMin: 9, error: '送回的格式不合格（缺 against）' });
  await draft(db, { ticker: 'MU', trigger: 'MANUAL', status: 'FAILED', created: '2026-11-22T00:00:00.000Z', settledMin: 9, error: '程式檢查沒過：前提太少' });
  await draft(db, { ticker: 'NVDA', trigger: 'MANUAL', status: 'USED', created: '2026-11-15T00:00:00.000Z', settledMin: 10, used: { premises: { same: 0, edited: 2, kept: 0 }, exits: 0, unused: { premises: 0, exits: 1, sources: 1 } } });
  // 期間外
  await draft(db, { ticker: 'NVDA', trigger: 'AUTO', status: 'READY', created: '2026-11-05T00:00:00.000Z', settledMin: 10 });
}

const seedAll = async (db: D1Database) => {
  await seedPremises(db);
  await seedWebRuns(db);
  await seedWebDocs(db);
  await seedDrafts(db);
};

// ---------------------------------------------------------------- 完成條件

describe('T57 依前提來源分開的審查結果（§2.4 第 7 點）', () => {
  it('來源讀帳戶狀態（證據包把原樣勾選的草稿遮成 USER）：依審查當時的帳戶歸類；系統預設讀證據包', async () => {
    await withDb(async (db, env) => {
      await seedPremises(db);
      const r = await report(env);
      // r1：P1 你寫的成立、P2（當時還是原樣勾選的草稿）成立、P3 系統預設證據不足；r2：P1 兩票成立一票不成立 → split、P2（11-16 中午改字之後是你寫的）三票不成立、P3 成立
      expect(row(r, 'premise_origin', 'origin', 'USER')).toMatchObject({ reviews: 2, premise_checks: 3, holds: 1, broken: 1, insufficient: 0, split: 1, holds_ratio: 0.333, broken_ratio: 0.333, insufficient_ratio: 0 });
      expect(row(r, 'premise_origin', 'origin', 'AI_DRAFT_ACCEPTED')).toMatchObject({ reviews: 2, premise_checks: 2, holds: 1, split: 1, holds_ratio: 0.5 });
      expect(row(r, 'premise_origin', 'origin', 'SYSTEM_DEFAULT')).toMatchObject({ reviews: 2, premise_checks: 2, holds: 1, insufficient: 1, insufficient_ratio: 0.5 });
      expect(row(r, 'premise_origin', 'origin', 'UNKNOWN')).toMatchObject({ reviews: 1, premise_checks: 1, holds: 1 });
      expect(row(r, 'premise_origin', 'origin', '合計')).toMatchObject({ reviews: 4, premise_checks: 8, holds: 4, broken: 1, insufficient: 1, split: 2, holds_ratio: 0.5, broken_ratio: 0.125, insufficient_ratio: 0.125 });
    });
  });

  it('只算有結論的定期審查：逾時、減半檢視、期間外不算；沒有任何審查時是空的', async () => {
    await withDb(async (db, env) => {
      expect(rows(await report(env), 'premise_origin')).toEqual([]);
      await seedPremises(db);
      const r = await report(env);
      // r5（逾時）、r6（OWN_DROP）、r7（11-05）三筆都是全部不成立；進了統計的話 USER 的 broken 會變多
      expect(row(r, 'premise_origin', 'origin', 'USER').broken).toBe(1);
      const wide = await report(env, '?from=2026-11-01&to=2026-11-24');
      expect(row(wide, 'premise_origin', 'origin', '合計')).toMatchObject({ premise_checks: 9, broken: 2 }); // 加上 r7（那天帳戶還沒有紀錄，來源不明）
      expect(row(wide, 'premise_origin', 'origin', 'UNKNOWN')).toMatchObject({ premise_checks: 2, broken: 1 });
    });
  });

  it('草稿的前提幾乎都判成立、你寫的不是 → 提示出題可能偏鬆；次數不夠或你寫的也都成立 → 不提示', async () => {
    const make = async (runs: number, userStatus: string) => {
      let note: unknown = 'unset';
      let draftRatio: unknown;
      await withDb(async (db, env) => {
        await history(db, 1, '2026-11-10T00:00:00.000Z', { NVDA: [{ id: 'P1', text: 'u', origin: 'USER' }, { id: 'P2', text: 'd', origin: 'AI_DRAFT_ACCEPTED' }] });
        for (let k = 0; k < runs; k++)
          await review(db, `l${k}`, 'NVDA', `2026-11-1${2 + k}T00:00:00.000Z`, [
            { id: 'P1', text: 'u', packOrigin: 'USER', votes: [userStatus, userStatus, userStatus] },
            { id: 'P2', text: 'd', packOrigin: 'USER', votes: ['HOLDS', 'HOLDS', 'HOLDS'] },
          ]);
        const r = await report(env);
        const d = row(r, 'premise_origin', 'origin', 'AI_DRAFT_ACCEPTED');
        note = d.note;
        draftRatio = d.holds_ratio;
      });
      return { note, draftRatio };
    };
    const loose = await make(LOOSE_MIN_CHECKS, 'BROKEN');
    expect(loose.draftRatio).toBe(1);
    expect(String(loose.note)).toContain('出題可能偏鬆');
    expect(String(loose.note)).toContain('100%');
    expect((await make(LOOSE_MIN_CHECKS - 1, 'BROKEN')).note).toBeNull();
    expect((await make(LOOSE_MIN_CHECKS, 'HOLDS')).note).toBeNull();
  });
});

describe('T57 每次執行取了幾份、幾個字、被拒絕的原因', () => {
  it('web_runs：依功能的沒有要找、沒取到、取到幾份、幾個字、被截掉、同網站抓滿、分析師回報的找資料', async () => {
    await withDb(async (db, env) => {
      await seedWebRuns(db);
      const r = await report(env);
      expect(row(r, 'web_runs', 'fn', 'OWN_REVIEW')).toMatchObject({
        runs: 4, off: 1, not_looking: 1, looked: 2, got_none: 1, got_some: 1, calls: 3, docs: 3, web_docs: 2, filing_docs: 1, chars: 20000, truncated_docs: 1, max_docs: 3, max_chars: 20000, sites_at_cap: 1, refused: 3,
        lookups_reported: 1, questions: 2, queries: 3, wanted: 4, avg_docs: 1.5, avg_chars: 10000,
      });
      expect(row(r, 'web_runs', 'fn', 'OWN_DRAFT')).toMatchObject({ runs: 1, off: 0, not_looking: 0, looked: 1, got_some: 1, calls: 3, docs: 8, web_docs: 5, filing_docs: 3, chars: 60000, truncated_docs: 1, max_docs: 8, max_chars: 60000, sites_at_cap: 2, refused: 62, lookups_reported: 0, avg_docs: 8, avg_chars: 60000 });
      // 沒有 doc_ctx 也沒有 added_docs 的（例如舊的列）：算「沒有要找」，不丟錯
      expect(row(r, 'web_runs', 'fn', 'OWN_DROP')).toMatchObject({ runs: 1, off: 0, not_looking: 1, looked: 0, docs: 0, chars: 0, avg_docs: null, avg_chars: null });
      expect(rows(r, 'web_runs').find((x) => x.fn === 'MOM_ENTRY')).toBeUndefined();
      expect(row(r, 'web_runs', 'fn', '合計')).toMatchObject({ runs: 6, off: 1, not_looking: 2, looked: 3, got_none: 1, got_some: 2, calls: 6, docs: 11, web_docs: 7, filing_docs: 4, chars: 80000, truncated_docs: 2, max_docs: 8, max_chars: 60000, sites_at_cap: 3, refused: 65, lookups_reported: 1, avg_docs: 3.7, avg_chars: 26667 });
    });
  });

  it('web_refused：依功能與原因；超過 60 筆的合成 OVER_CAP，各功能的列加起來等於被拒絕的總數', async () => {
    await withDb(async (db, env) => {
      await seedWebRuns(db);
      const r = await report(env);
      const rev = rows(r, 'web_refused').filter((x) => x.fn === 'OWN_REVIEW');
      expect(Object.fromEntries(rev.map((x) => [x.reason, x.n]))).toEqual({ THIN: 1, NOT_LISTED: 1, BLOCKED: 1 });
      const dr = rows(r, 'web_refused').filter((x) => x.fn === 'OWN_DRAFT');
      expect(Object.fromEntries(dr.map((x) => [x.reason, x.n]))).toEqual({ LIMIT: 59, TOO_OLD: 1, OVER_CAP: 2 });
      expect(row(r, 'web_refused', 'fn', '合計').n).toBe(65);
      expect(row(r, 'web_runs', 'fn', '合計').refused).toBe(65);
    });
  });
});

describe('T57 被略過與抓不到的網域', () => {
  it('web_skipped：不在清單的網域依次數排；去掉 www、分排除／路徑／清單外；最近 90 天（含第一天、不含迄日之後）', async () => {
    await withDb(async (db, env) => {
      await seedWebDocs(db);
      const r = await report(env);
      const list = rows(r, 'web_skipped');
      expect(list.map((x) => x.domain)).toEqual(['fool.com', 'edge.com', 'example.com', 'trendforce.com', '合計（全部網域）']);
      expect(list[0]).toMatchObject({ n: 3, excluded: 3, path: 0, not_listed: 0, tickers: 2, last_at: '2026-11-18T00:00:00.000Z', last_title: 'Fool 3' });
      expect(list[3]).toMatchObject({ n: 1, path: 1 });
      expect(list.at(-1)).toMatchObject({ n: 6, excluded: 3, path: 1, not_listed: 2, tickers: 2 });
      // 90 天的視窗跟著 to 走、不跟 from：to 改成 12-01，08-27 的那一筆掉出去，11-25 的進來
      const later = await report(env, '?from=2026-11-11&to=2026-12-01');
      const doms = rows(later, 'web_skipped').map((x) => x.domain);
      expect(doms).not.toContain('edge.com');
      expect(doms).toContain('later.com');
    });
  });

  it('web_failed：失敗多的網域在前；內文太短、被擋、不是網頁、認不出日期、其他分開數；太舊不算失敗；沒記網域的用網址的主機；清單外的不算抓取', async () => {
    await withDb(async (db, env) => {
      await seedWebDocs(db);
      const r = await report(env);
      const list = rows(r, 'web_failed');
      expect(list.map((x) => x.domain)).toEqual(['nvidianews.nvidia.com', 'trendforce.com', 'weird.org', '合計（全部網域）']);
      expect(list[0]).toMatchObject({ attempts: 4, ok: 0, failed: 4, thin: 2, blocked: 0, no_date: 1, error: 1, too_old: 0, fail_ratio: 1, thin_avg_chars: 750, last_error: 'NO_DATE：認不出發布日' });
      expect(list[1]).toMatchObject({ attempts: 5, ok: 2, failed: 2, thin: 1, blocked: 1, too_old: 1, fail_ratio: 0.4, thin_avg_chars: 900, last_error: 'BLOCKED：HTTP 403' });
      expect(list[2]).toMatchObject({ attempts: 1, failed: 1, unsupported: 1 });
      // 合計：techpowerup 沒有失敗、不單獨列，但算進合計；視窗外的那筆 BLOCKED 不算
      expect(list[3]).toMatchObject({ attempts: 12, ok: 4, failed: 7, thin: 3, blocked: 1, unsupported: 1, no_date: 1, error: 1, too_old: 1, fail_ratio: 0.583, thin_avg_chars: 800, last_error: null });
    });
  });

  it('網域表最多列 WEB_DOMAIN_ROWS 個，合計列仍算全部', async () => {
    await withDb(async (db, env) => {
      const total = WEB_DOMAIN_ROWS + 5;
      for (let k = 0; k < total; k++) await webDoc(db, { url: `https://site${String(k).padStart(2, '0')}.com/a`, status: 'NOT_LISTED', error: 'NOT_LISTED', at: '2026-11-16T00:00:00.000Z' });
      for (let k = 0; k < total; k++) await webDoc(db, { url: `https://f${String(k).padStart(2, '0')}.com/a`, domain: `f${String(k).padStart(2, '0')}.com`, status: 'BLOCKED', error: 'HTTP 403', at: '2026-11-16T00:00:00.000Z' });
      const r = await report(env);
      expect(rows(r, 'web_skipped')).toHaveLength(WEB_DOMAIN_ROWS + 1);
      expect(rows(r, 'web_skipped').at(-1)).toMatchObject({ domain: '合計（全部網域）', n: total });
      expect(rows(r, 'web_failed')).toHaveLength(WEB_DOMAIN_ROWS + 1);
      expect(rows(r, 'web_failed').at(-1)).toMatchObject({ attempts: total, failed: total });
    });
  });
});

describe('T57 草稿的成功率', () => {
  it('drafts：依觸發的各狀態、成功率（通過檢查 ÷ 已結束）、存檔用了多少、平均幾分鐘；進行中與期間外不算進分母', async () => {
    await withDb(async (db, env) => {
      await seedDrafts(db);
      const r = await report(env);
      expect(row(r, 'drafts', 'trigger', 'AUTO')).toMatchObject({
        drafts: 4, pending: 0, ready: 1, used: 1, dismissed: 0, expired: 0, failed: 2, finished: 4, ok: 2, success_ratio: 0.5, used_ratio: 0.5, avg_minutes: 15,
        premises_same: 2, premises_edited: 1, premises_kept: 1, premises_unused: 1, premises_taken_ratio: 0.75, exits_used: 1, exits_unused: 2,
      });
      expect(row(r, 'drafts', 'trigger', 'MANUAL')).toMatchObject({
        drafts: 7, pending: 1, ready: 1, used: 1, dismissed: 1, expired: 1, failed: 2, finished: 6, ok: 4, success_ratio: 0.667, used_ratio: 0.25, avg_minutes: 25,
        premises_same: 0, premises_edited: 2, premises_unused: 0, premises_taken_ratio: 1, exits_used: 0, exits_unused: 1,
      });
      expect(row(r, 'drafts', 'trigger', '合計')).toMatchObject({ drafts: 11, pending: 1, ready: 2, used: 2, dismissed: 1, expired: 1, failed: 4, finished: 10, ok: 6, success_ratio: 0.6, used_ratio: 0.333, premises_same: 2, premises_edited: 3, premises_kept: 1, premises_unused: 1, premises_taken_ratio: 0.833, exits_used: 1, exits_unused: 3 });
    });
  });

  it('draft_failures：失敗的原因取冒號或括號之前的字，依觸發分開數', async () => {
    await withDb(async (db, env) => {
      await seedDrafts(db);
      const r = await report(env);
      const f = rows(r, 'draft_failures');
      const n = (trigger: string, reason: string) => f.find((x) => x.trigger === trigger && x.reason === reason)?.n;
      expect(n('AUTO', '程式檢查沒過')).toBe(1);
      expect(n('AUTO', '沒有來取證據包')).toBe(1);
      expect(n('MANUAL', '送回的格式不合格')).toBe(1);
      expect(n('MANUAL', '程式檢查沒過')).toBe(1);
      expect(f.find((x) => x.trigger === '合計')?.n).toBe(4);
    });
  });

  it('沒有草稿時兩段都是空的', async () => {
    await withDb(async (_db, env) => {
      const r = await report(env);
      expect(rows(r, 'drafts')).toEqual([]);
      expect(rows(r, 'draft_failures')).toEqual([]);
    });
  });
});

describe('T57 登記在報表裡', () => {
  it('七段接在原本的十四段後面，空的資料庫不出錯', async () => {
    await withDb(async (_db, env) => {
      const r = await report(env, '');
      // T61 在 premise_origin 後面加了一段 premise_prompt（前提的判定，依功能與 prompt 版本）
      // T65 在最後加了一段 db_size（資料庫大小，現在的大小；空的資料庫也有一行，t65 的測試看它）
      // T68 在 web_failed 後面加了一段 web_ratings（網頁來源的評級，t68 的測試看它）
      // T88 在 crash_reviews 後面加了三段 new_items、drop_reviews、kept_returns（t57 這七段往後移 3 格，ops-report.test 看它們）
      expect(r.sections.slice(17, 26).map((s) => s.id)).toEqual(['premise_origin', 'premise_prompt', 'web_runs', 'web_refused', 'web_skipped', 'web_failed', 'web_ratings', 'drafts', 'draft_failures']);
      expect(OPS_SECTIONS).toHaveLength(27);
      for (const s of r.sections.slice(17, 26)) {
        expect(s.error, s.id).toBeUndefined();
        expect(s.rows, s.id).toEqual([]);
        expect(s.title.length).toBeGreaterThan(0);
      }
    });
  });
});

// ---------------------------------------------------------------- 匯出腳本（假的 Worker）

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 試哪一個 Python：先 uv（專案規定），再 python。都不能跑就是 null（測試略過）。 */
async function pythonCommand(): Promise<string[] | null> {
  for (const cmd of [['uv', 'run', '--no-project', 'python'], ['python']]) {
    const ver = await new Promise<string>((resolve) => execFile(cmd[0], [...cmd.slice(1), '--version'], { cwd: REPO, shell: process.platform === 'win32' }, (e, stdout, stderr) => resolve(e ? '' : `${stdout}${stderr}`)));
    const m = /Python (\d+)\.(\d+)/.exec(ver);
    if (m && (Number(m[1]) > 3 || (Number(m[1]) === 3 && Number(m[2]) >= 11))) return cmd;
  }
  return null;
}

describe('T57 匯出腳本存得到新的幾段', () => {
  it('scripts/export_records.py 對假的 Worker（Node 的 http 伺服器接到真的 handle）匯出：reports/ops_<日期>.json 有七段、數字和端點一樣', async () => {
    const py = await pythonCommand();
    if (!py) {
      console.warn('沒有可用的 Python（uv 或 python 3.11+），略過匯出腳本的測試');
      return;
    }
    const out = mkdtempSync(join(tmpdir(), 't57-export-'));
    try {
      await withDb(async (db, env) => {
        await seedAll(db);
        const server = createServer((req, res) => {
          const chunks: Buffer[] = [];
          req.on('data', (c: Buffer) => chunks.push(c));
          req.on('end', () => {
            void (async () => {
              const r = await handle(new Request(`https://bot.example${req.url}`, { method: req.method, headers: { Authorization: String(req.headers.authorization ?? '') } }), env, fetcher, NOW);
              res.writeHead(r.status, { 'content-type': 'application/json' });
              res.end(Buffer.from(await r.arrayBuffer()));
            })();
          });
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const port = (server.address() as AddressInfo).port;
        try {
          const done = await new Promise<{ code: number; text: string }>((resolve) => {
            execFile(py[0], [...py.slice(1), 'scripts/export_records.py', '--url', `http://127.0.0.1:${port}`, '--out', out, '--report-from', '2026-11-11', '--report-to', '2026-11-24'], { cwd: REPO, shell: process.platform === 'win32', env: { ...process.env, STOCKBOT_ADMIN_TOKEN: 'admin-secret', PYTHONIOENCODING: 'utf-8' }, timeout: 100_000 }, (e, stdout, stderr) => resolve({ code: e ? ((e as { code?: number }).code ?? 1) : 0, text: `${stdout}${stderr}` }));
          });
          expect(done.code, done.text).toBe(0);
          expect(done.text).toContain('運作統計');
          const files = readdirSync(join(out, 'reports'));
          expect(files).toHaveLength(1);
          expect(files[0]).toMatch(/^ops_\d{4}-\d{2}-\d{2}\.json$/);
          const saved = JSON.parse(readFileSync(join(out, 'reports', files[0]), 'utf8')) as OpsReport;
          const live = await report(env);
          // 存下來的就是端點回的（除了 generated_at 用的是假的時鐘，兩邊相同）
          expect(saved.sections.map((s) => s.id)).toEqual(live.sections.map((s) => s.id));
          for (const id of ['premise_origin', 'web_runs', 'web_refused', 'web_skipped', 'web_failed', 'drafts', 'draft_failures']) expect(saved.sections.find((s) => s.id === id)?.rows, id).toEqual(rows(live, id));
          expect(row(saved, 'premise_origin', 'origin', 'AI_DRAFT_ACCEPTED').premise_checks).toBe(2);
          expect(row(saved, 'web_runs', 'fn', '合計').docs).toBe(11);
          expect(row(saved, 'web_skipped', 'domain', 'fool.com').n).toBe(3);
          expect(row(saved, 'drafts', 'trigger', '合計').success_ratio).toBe(0.6);
          // 新的資料也一起匯出：草稿與網頁快照的原始列
          const drafts = readFileSync(join(out, 'raw', 'own_drafts.jsonl'), 'utf8').trim().split('\n');
          expect(drafts).toHaveLength(12);
          expect(readFileSync(join(out, 'raw', 'web_docs.jsonl'), 'utf8').trim().split('\n')).toHaveLength(21);
        } finally {
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      });
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
