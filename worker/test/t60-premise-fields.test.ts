// T60：前提的新欄位（composite_layer_design_2026-11-21 §2.2、§2.3）。
// 完成條件（設計第 7 章第 2 列）：
//   帳戶狀態：前提多 confirmsIf（怎樣算證實）、verify { by, source, every }（every 沒填用 100 天）、breaksIf 改成最多 3 個子句；
//     信念 = verify.by NONE：不進審查的逐條判定、不計入成績表、不觸發 WEB_DUE；連續 3 次沒驗到 →「要看的事」（程式不自動改）
//   編輯論點頁：三個欄位能看、能改、能標成信念（伺服器存檔與預覽、持股頁的資料；畫面的白話在 thesis-fields.js）
//   草稿格式與程式檢查：own_draft_v2；檢查多三條（子句不能已經成立、本文不放會過時的字樣、查得到的要寫 confirms_if），
//     「NONE 最多 1 條」換成「至少 2 條不是信念」
// check.ts 的逐字引用檢查沒有動（只有 PackPremise 的型別多欄位）；AI 的回覆一律是假的；對外請求全部是假的。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { judge, type EvidencePack, type PackDoc } from '../src/ai/check';
import { discussionPack, type DiscussionNumbers } from '../src/ai/discussion';
import { PAYLOAD_HOOKS } from '../src/ai/hooks';
import { DATED_WORDS, DRAFT_LIMITS, OWN_DRAFT, OWN_DRAFT_PROMPT, draftResult, ownDraftPack, type OwnDraft } from '../src/ai/ownDraft';
import { ownPremises, packPremise } from '../src/ai/pack';
import { clauseMetNow, parseXbrlClause, type ClauseQuarter } from '../src/ai/xbrlClause';
import { getRun } from '../src/app/aiRuns';
import type { Env, Fetcher } from '../src/app/env';
import { runFlow } from '../src/app/flow';
import { LINE_PUSH_URL } from '../src/app/line';
import { loadAccount, saveAccount } from '../src/app/ledgerStore';
import { startOwnReview } from '../src/app/ownAi';
import { draftPremiseFields, draftSave, type DraftView } from '../src/app/ownDraft';
import { STALE_DAYS, UNVERIFIED_AFTER, UNVERIFIED_TEXT, externalNeeds, filePremises, newEvidence, ownAttention, unverifiedStreak, type ThesisFile, type ThesisPremise, type ThesisReview } from '../src/app/thesis';
import type { HoldingDetail } from '../src/app/site/views';
import { XBRL_METRICS, type CompanyFacts, type QuarterRow, type XbrlFact } from '../src/data/edgar';
import { buildMarketView } from '../src/data/marketView';
import { loadSeries } from '../src/data/store';
import { PREMISE_FIELD_LIMITS, VERIFY_EVERY_DEFAULT, breaksOf, createAccount, isBelief, mapPremises, normVerify, setThesis, verifyEvery, type Account, type OwnMeta, type Premise } from '../src/engine';
import { handle } from '../src/index';
import { freshDb } from './helpers/d1';
import { cronTime, fakeFetcher, newWorld, type World } from './helpers/fakeSources';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const METRICS = new Set(Object.keys(XBRL_METRICS));

// 前端不碰 DOM 的部分直接 import（同 t56 的寫法）
interface FieldsJs {
  BELIEF_TEXT: string;
  verifyText(v: unknown): string | null;
  fieldsSummary(f: unknown): string;
  hasFields(f: unknown): boolean;
  draftPremiseFields(x: unknown): { breaksIf: string[]; confirmsIf: string; verify: Record<string, unknown> | null };
  checkableWarn(p: unknown): { tone: string; text: string } | null;
}
interface DraftJs {
  draftItems(p: unknown): { premises: Record<string, unknown>[] };
  checkLine(it: unknown): { ok: boolean; belief: boolean; text: string };
}
const FJ = (await import('../public/js/thesis-fields.js' as string)) as FieldsJs;
const DJ = (await import('../public/js/thesis-draft.js' as string)) as DraftJs;

// ---------------------------------------------------------------- 帳戶狀態（引擎，純函式）

describe('T60 帳戶狀態：前提的新欄位（§2.2）', () => {
  const meta = {
    premises: [
      { id: 'P1', text: 'HBM 合約價逐季上漲', origin: 'USER' as const, breaksIf: '合約價季跌', addedAt: '2026-11-01' },
      { id: 'P2', text: '大客戶長約照約履行', origin: 'USER' as const, addedAt: '2026-11-01' },
    ],
    premiseSeq: 3,
  };

  it('新的一條存 confirmsIf、verify、breaksIf（子句的陣列，最多 3 句）；沿用的送了就換、空的拿掉、沒送照舊（舊的一段字照舊留著）', () => {
    const m = mapPremises(
      meta,
      [
        { id: 'P1', text: 'HBM 合約價逐季上漲' },
        { id: 'P2', text: '大客戶長約照約履行', verify: { by: 'NONE' }, confirmsIf: '', breaksIf: ['8-K 揭露大客戶違約'] },
        { text: '資料中心營收沒有季減', confirmsIf: '10-Q 的資料中心營收季增', verify: { by: 'FILING', source: '10-Q 的事業單位營收', every: 91 }, breaksIf: ['資料中心營收季減', '公司不再分開揭露資料中心營收', '  ', '第四句會被截掉'] },
      ],
      '2026-11-21',
    );
    expect(m.premises).toEqual([
      { id: 'P1', text: 'HBM 合約價逐季上漲', origin: 'USER', breaksIf: '合約價季跌', addedAt: '2026-11-01' },
      { id: 'P2', text: '大客戶長約照約履行', origin: 'USER', verify: { by: 'NONE' }, breaksIf: ['8-K 揭露大客戶違約'], addedAt: '2026-11-01' },
      { id: 'P3', text: '資料中心營收沒有季減', origin: 'USER', confirmsIf: '10-Q 的資料中心營收季增', verify: { by: 'FILING', source: '10-Q 的事業單位營收', every: 91 }, breaksIf: ['資料中心營收季減', '公司不再分開揭露資料中心營收', '第四句會被截掉'], addedAt: '2026-11-21' },
    ]);
    // 空陣列、null 拿掉；verify 送 null 拿掉
    const cleared = mapPremises({ premises: m.premises, premiseSeq: m.premiseSeq }, [{ id: 'P1', text: 'HBM 合約價逐季上漲', breaksIf: [] }, { id: 'P2', text: '大客戶長約照約履行', verify: null, breaksIf: null }], '2026-11-22');
    expect(cleared.premises.map((p) => [p.id, p.breaksIf ?? null, p.verify ?? null])).toEqual([
      ['P1', null, null],
      ['P2', null, null],
    ]);
  });

  it('只改這三個欄位不算論點變動（不排論點變動後的審查）；字改了照舊算', () => {
    const acct = { own: { MU: { premises: structuredClone(meta.premises), premiseSeq: 3, thesis: null } } } as unknown as Account;
    const a = setThesis(acct, 'MU', { text: '', source: 'TYPED', date: '2026-11-21', premises: [{ id: 'P1', text: 'HBM 合約價逐季上漲', confirmsIf: 'TrendForce 報季漲', verify: { by: 'WEB', source: 'trendforce.com' } }, { id: 'P2', text: '大客戶長約照約履行', verify: { by: 'NONE' } }] });
    expect(a.changed).toBe(false);
    expect(a.acct.own.MU.thesisReviewDue ?? null).toBeNull();
    expect(a.acct.own.MU.premises[0]).toMatchObject({ confirmsIf: 'TrendForce 報季漲', verify: { by: 'WEB', source: 'trendforce.com' } });
    const b = setThesis(acct, 'MU', { text: '', source: 'TYPED', date: '2026-11-21', premises: [{ id: 'P1', text: 'HBM 合約價到 2027 年逐季上漲' }, { id: 'P2', text: '大客戶長約照約履行' }] });
    expect(b.changed).toBe(true);
  });

  it('讀的時候：舊的一段字當成一句；verify 整理（不認得的 by 不存、信念不存來源、every 要 7～400 的整數）；every 沒填用 100（= 月底檢查點的 STALE_DAYS）', () => {
    expect(breaksOf({ breaksIf: '合約價季跌' })).toEqual(['合約價季跌']);
    expect(breaksOf({ breaksIf: [' a ', '', 'b'] })).toEqual(['a', 'b']);
    expect(breaksOf({})).toEqual([]);
    expect(normVerify({ by: 'web', source: '  trendforce.com ', every: '90' })).toEqual({ by: 'WEB', source: 'trendforce.com', every: 90 });
    expect(normVerify({ by: 'NONE', source: 'x', every: 30 })).toEqual({ by: 'NONE' });
    expect(normVerify({ by: 'XBRL', every: 3 })).toEqual({ by: 'XBRL' });
    expect(normVerify({ by: 'XBRL', every: 90.5 })).toEqual({ by: 'XBRL' });
    expect(normVerify({ by: '' })).toBeNull();
    expect(normVerify({ by: 'MAYBE' })).toBeNull();
    expect(normVerify(null)).toBeNull();
    expect(verifyEvery({})).toBe(100);
    expect(verifyEvery({ verify: { by: 'WEB', every: 30 } })).toBe(30);
    expect(VERIFY_EVERY_DEFAULT).toBe(STALE_DAYS);
    expect(isBelief({ verify: { by: 'NONE' } })).toBe(true);
    expect(isBelief({})).toBe(false);
  });
});

// ---------------------------------------------------------------- 信念不進審查（§2.3）

const USER_BELIEF: Premise[] = [
  { id: 'P4', text: 'HBM 合約價逐季上漲', origin: 'AI_DRAFT_ACCEPTED', confirmsIf: 'TrendForce 最新一季的合約價預估仍是季漲', verify: { by: 'WEB', source: 'trendforce.com', every: 90 }, breaksIf: ['TrendForce 報 HBM 合約價季跌', 'SK 海力士宣布 HBM 擴產超過 50%'] },
  { id: 'P5', text: '毛利率維持在 55% 以上', origin: 'USER', breaksIf: '毛利率連兩季低於 55%' },
  { id: 'P6', text: '大客戶長約照約履行', origin: 'USER', verify: { by: 'NONE' }, breaksIf: ['8-K 揭露大客戶違約'] },
];
const acctWith = (premises: Premise[]) => ({ own: { MU: { premises } } }) as unknown as Account;

describe('T60 信念不進審查的逐條判定（§2.3）', () => {
  it('審查、減半檢視、硬事件、條件確認的證據包不放信念；草稿與出場條件的改寫要放（beliefs: true）', () => {
    const judged = ownPremises(acctWith(USER_BELIEF), 'MU');
    expect(judged.map((p) => p.id)).toEqual(['P4', 'P5']);
    // 證據包的形狀：子句是陣列（舊的一段字也變成一句）、怎樣算證實、怎麼驗證；草稿的前提照舊遮成 USER
    expect(judged).toEqual([
      { id: 'P4', text: 'HBM 合約價逐季上漲', origin: 'USER', breaksIf: ['TrendForce 報 HBM 合約價季跌', 'SK 海力士宣布 HBM 擴產超過 50%'], confirmsIf: 'TrendForce 最新一季的合約價預估仍是季漲', verify: { by: 'WEB', source: 'trendforce.com', every: 90 } },
      { id: 'P5', text: '毛利率維持在 55% 以上', origin: 'USER', breaksIf: ['毛利率連兩季低於 55%'] },
    ]);
    expect(ownPremises(acctWith(USER_BELIEF), 'MU', { beliefs: true }).map((p) => [p.id, p.verify?.by ?? null])).toEqual([
      ['P4', 'WEB'],
      ['P5', null],
      ['P6', 'NONE'],
    ]);
    // 論點檔組的（F19 硬事件）同樣不放
    const tf = { premises: USER_BELIEF.map((p) => ({ id: p.id, text: p.text, origin: p.origin, addedAt: null, breaksIf: breaksOf(p), ...(p.verify ? { verify: p.verify } : {}), lastCheck: null, splitAfter: false })) };
    expect(filePremises(tf).map((p) => p.id)).toEqual(['P4', 'P5']);
  });

  it('不觸發 WEB_DUE：信念永遠「沒被檢查過」，但不算需要外部資料', () => {
    const file = fileOf({ premises: [prem('P5', 'HOLDS'), prem('P6', null, { verify: { by: 'NONE' } })] });
    expect(externalNeeds(file).premises).toEqual([]);
    expect(newEvidence({ ...file, lastReview: { runId: 'r', asOf: '2026-10-01', createdAt: '2026-10-01T01:00:00Z', thesisVersion: null } }, [], '2026-11-30')).toEqual([]);
    // 對照：同一條不是信念 → 照舊 WEB_DUE
    const plain = fileOf({ premises: [prem('P5', 'HOLDS'), prem('P6', null)] });
    expect(newEvidence({ ...plain, lastReview: { runId: 'r', asOf: '2026-10-01', createdAt: '2026-10-01T01:00:00Z', thesisVersion: null } }, [], '2026-11-30')).toEqual(['WEB_DUE']);
  });

  it('不計入成績表：成績表數的是審查證據包裡的前提（ai_runs.pack.premises），信念不在裡面', () => {
    // 運作統計的 premise_origin 從 json_each(r.pack, '$.premises') 數（src/app/opsReport.ts）；證據包不放信念，就不會被算到
    const src = readFileSync(join(ROOT, 'worker', 'src', 'app', 'opsReport.ts'), 'utf8');
    expect(src).toContain("json_each(r.pack, '$.premises')");
    expect(ownPremises(acctWith(USER_BELIEF), 'MU').some((p) => p.id === 'P6')).toBe(false);
  });

  it('討論包的前提一節：信念寫「查不到，是我選擇相信的」，不寫「還沒有檢查過」', () => {
    const t = discussionPack(fileOf({ premises: [prem('P5', 'HOLDS'), prem('P6', null, { verify: { by: 'NONE' } })] }), NUMS, 'ROUTINE');
    expect(t).toContain('P6. 大客戶長約照約履行　— 信念：查不到，是我選擇相信的（審查不檢查這一條）');
    expect(t).toContain('P5. 毛利率維持在 55% 以上　— 成立（2026-11-01 審查）');
  });
});

// ---------------------------------------------------------------- 連續 3 次沒驗到 →「要看的事」（§2.3）

const DATE = '2026-11-30';
function prem(id: string, status: string | null, extra: Partial<ThesisPremise> = {}): ThesisPremise {
  const text: Record<string, string> = { P4: 'HBM 合約價逐季上漲', P5: '毛利率維持在 55% 以上', P6: '大客戶長約照約履行' };
  return { id, text: text[id] ?? id, origin: 'USER', addedAt: '2026-01-02', lastCheck: status ? { date: '2026-11-01', runId: 'r0', status } : null, splitAfter: false, ...extra };
}
function fileOf(o: Partial<ThesisFile> = {}): ThesisFile {
  return { ticker: 'MU', fileId: 'MU@2026-01-02', openedAt: '2026-01-02', origin: 'NEW', kind: 'THESIS', status: 'OPEN', thesis: null, premises: [prem('P4', null)], conditions: [], events: [], reviews: [], disputes: [], flags: [], lastReview: null, newSince: '2025-09-01', log: [], ...o };
}
/** 一次定期審查：votes 是這一條前提的三票。 */
function rv(runId: string, date: string, votes: Record<string, string[]>, fn = 'OWN_REVIEW'): ThesisReview {
  return { runId, date, fn, label: '定期審查', trigger: 'MONTHLY', status: 'AGREED', verdict: 'HOLD', votes: { HOLD: 3 }, brokenPremises: [], notif: null, response: null, premiseVotes: votes, summary: null };
}
const I3 = ['INSUFFICIENT', 'INSUFFICIENT', 'INSUFFICIENT'];
const H3 = ['HOLDS', 'HOLDS', 'HOLDS'];
const B3 = ['BROKEN', 'BROKEN', 'BROKEN'];
const SPLIT = ['HOLDS', 'HOLDS', 'INSUFFICIENT'];
const acctOf = () => ({ own: { MU: {} as OwnMeta }, rule: { own: { MU: { applied: 'STD', stdWeight: 0.1 } } } as unknown as Account['rule'], notifs: [] });
const hits = (kind: string, file: ThesisFile) => ownAttention([file], acctOf(), { date: DATE }).filter((x) => x.kind === kind);

describe('T60 一條前提連續 3 次沒驗到 →「要看的事」（§2.3）', () => {
  it('證據不足、票數不一致都算沒驗到；3 次列一件（鍵帶這一串最早的那次），文字照設計；程式不改前提', () => {
    const reviews = [rv('r4', '2026-11-28', { P4: I3 }), rv('r3', '2026-10-31', { P4: SPLIT }), rv('r2', '2026-09-30', { P4: I3 }), rv('r1', '2026-08-29', { P4: H3 })];
    const file = fileOf({ premises: [prem('P4', 'INSUFFICIENT')], reviews });
    expect(unverifiedStreak(file, 'P4')).toEqual({ count: 3, first: 'r2', reachedAt: '2026-11-28', lastConfirmed: '2026-08-29' });
    expect(UNVERIFIED_AFTER).toBe(3);
    expect(hits('PREMISE_UNVERIFIED', file)).toEqual([
      { ticker: 'MU', kind: 'PREMISE_UNVERIFIED', src: 'own', key: 'PREMISE_UNVERIFIED:P4@r2', every: 6, since: '2026-11-28', text: `MU 的前提 P4「HBM 合約價逐季上漲」已經連續 3 次審查都沒驗到：${UNVERIFIED_TEXT}` },
    ]);
    expect(UNVERIFIED_TEXT).toBe('這一條一直查不到，可以改寫、配一個查得到的指標，或改標成信念');
    // 同一條不再列 PREMISE_NO_DATA（避免一件事列兩次）
    expect(hits('PREMISE_NO_DATA', file)).toEqual([]);
  });

  it('兩次不夠；中間 3 票都判成立或都判不成立就重算；減半檢視、逾時（沒有票）不算也不中斷', () => {
    const two = fileOf({ reviews: [rv('r3', '2026-11-28', { P4: I3 }), rv('r2', '2026-10-31', { P4: I3 })] });
    expect(hits('PREMISE_UNVERIFIED', two)).toEqual([]);
    const reset = fileOf({ reviews: [rv('r4', '2026-11-28', { P4: I3 }), rv('r3', '2026-10-31', { P4: H3 }), rv('r2', '2026-09-30', { P4: I3 }), rv('r1', '2026-08-29', { P4: I3 })] });
    expect(unverifiedStreak(reset, 'P4').count).toBe(1);
    const broken = fileOf({ reviews: [rv('r4', '2026-11-28', { P4: I3 }), rv('r3', '2026-10-31', { P4: I3 }), rv('r2', '2026-09-30', { P4: B3 }), rv('r1', '2026-08-29', { P4: I3 })] });
    expect(unverifiedStreak(broken, 'P4').count).toBe(2);
    const skips = fileOf({ reviews: [rv('r5', '2026-11-28', { P4: I3 }), rv('d1', '2026-11-10', { P4: I3 }, 'OWN_DROP'), rv('r4', '2026-11-01', {}), rv('r3', '2026-10-31', { P4: I3 }), rv('r2', '2026-09-30', { P4: I3 })] });
    expect(unverifiedStreak(skips, 'P4')).toMatchObject({ count: 3, first: 'r2' });
  });

  it('前提的字改過：改之前的審查不算（看的是舊的字）；只改標點不算改；信念不列', () => {
    const reviews = [rv('r4', '2026-11-28', { P4: I3 }), rv('r3', '2026-10-31', { P4: I3 }), rv('r2', '2026-09-30', { P4: I3 })];
    const log = (after: string) => [{ id: 1, kind: 'THESIS', session: '2026-10-15', at: '2026-10-15T01:00:00Z', ref: null, body: { before: { premises: [{ id: 'P4', text: 'HBM 合約價逐季上漲' }] }, after: { premises: [{ id: 'P4', text: after }] } }, accountVersion: null }];
    expect(unverifiedStreak(fileOf({ reviews, log: log('HBM 合約價到 2027 年逐季上漲') }), 'P4').count).toBe(2);
    expect(unverifiedStreak(fileOf({ reviews, log: log('HBM 合約價，逐季上漲。') }), 'P4').count).toBe(3);
    const belief = fileOf({ premises: [prem('P4', 'INSUFFICIENT', { verify: { by: 'NONE' } })], reviews });
    expect(hits('PREMISE_UNVERIFIED', belief)).toEqual([]);
    expect(hits('PREMISE_NO_DATA', belief)).toEqual([]);
  });
});

// ---------------------------------------------------------------- 草稿：格式與程式檢查（§2.2、§2.3）

const Q_REV = 'Revenue for the third quarter was $160 million, up 33% from a year ago';
const Q_GM = 'Gross margin was 60.0%, down from 70.0% a year ago';
const RISK1 = 'Our three largest customers accounted for 61% of revenue';
const RISK2 = 'Export restrictions may limit our ability to sell to certain customers';
const RISK3 = 'Inventory provisions increased to $1.2 billion this quarter';
const DOC_Q: PackDoc = { id: 'D1', source_id: 'edgar:q', kind: 'filing', date: '2026-10-30', title: '10-Q', text: `${Q_REV}. ${Q_GM}. ${RISK1}. ${RISK2}. ${RISK3}.` };
const EV = [Q_GM, Q_REV, RISK1, RISK2, RISK3].map((quote, i) => ({ id: `E${i + 1}`, source_id: DOC_Q.source_id, date: DOC_Q.date, quote, claim: '測試' }));

/** 季度數字（新的在前）：2026-06-30 那一季營收低於前一季（P5「任一季營收低於前一季」字面上已經成立的情況）。 */
const qr = (end: string, revenue: number, gm: number | null, yoy: number | null = null): QuarterRow => ({ end, filed: end, form: '10-Q', accn: `a-${end}`, revenue, grossProfit: null, operatingIncome: null, netIncome: null, epsDiluted: null, cfo: null, grossMarginPct: gm, operatingMarginPct: null, netMarginPct: null, revenueYoY: yoy, cfoToNetIncome: null });
const ROWS: QuarterRow[] = [qr('2026-09-30', 160, 0.6, 0.14), qr('2026-06-30', 150, 0.62, 0.12), qr('2026-03-31', 155, 0.66, 0.2), qr('2025-12-31', 140, 0.7, 0.25)];

function good(): Record<string, unknown> {
  return {
    thesis: '資料中心的需求帶動營收與毛利，持有的理由靠合約價、毛利率與大客戶的長約。',
    premises: [
      { text: 'HBM 的合約價到 2027 年上半年仍然逐季上漲', keep_id: null, confirms_if: 'TrendForce 最新一季的 HBM 合約價預估仍是季漲', breaks_if: ['TrendForce 的新聞稿報 HBM 合約價季跌', 'SK 海力士宣布 HBM 擴產超過 50%'], verify: { by: 'WEB', source: 'trendforce.com', every: 90 }, evidence_ids: [] },
      { text: '毛利率維持在 55% 以上', keep_id: null, confirms_if: '季報的毛利率仍在 55% 以上', breaks_if: ['毛利率連兩季低於 55%'], verify: { by: 'XBRL' }, evidence_ids: ['E1'] },
      { text: '大客戶的長約照約履行', keep_id: null, confirms_if: null, breaks_if: ['公司在 8-K 揭露大客戶違約或要求重議價格'], verify: { by: 'NONE' }, evidence_ids: [] },
    ],
    exits: [
      { text: '毛利率連兩季低於 55%（最新一季 60%）', action: 'HALF', kind: 'XBRL', check: { type: 'xbrl_metric_below', metric: 'GrossMarginPct', level: 0.55, quarters: 2 }, premise_index: 1, evidence_ids: ['E1'] },
      { text: '公司在 8-K 宣布下修本季營收財測', action: 'REVIEW', kind: 'EVENT', check: { type: 'event', confirm_by: ['8-K'] }, premise_index: null, evidence_ids: [] },
    ],
    sources: { peers: [], domains: [] },
    against: [
      { text: '營收集中在三家客戶', evidence_ids: ['E3'] },
      { text: '出口管制限制銷售對象', evidence_ids: ['E4'] },
      { text: '存貨提列變大', evidence_ids: ['E5'] },
    ],
    would_buy_today: { answer: 'UNSURE', why: '需求還在，但客戶集中的風險在上升' },
    not_checkable: [],
  };
}
function pack(quarters: QuarterRow[] | null = ROWS): EvidencePack {
  return ownDraftPack({ runId: 'd60', asOf: '2026-11-21', ticker: 'MU', trigger: 'MANUAL', held: true, premises: USER_BELIEF.map(packPremise), facts: [], docs: [DOC_Q], dataQuality: {}, thesisVersion: 1, fileId: 'MU@2026-01-02', broken: null, webDomains: ['trendforce.com'], quarters, now: new Date('2026-11-21T01:00:00Z') }).pack;
}
function run(payload: unknown, p: EvidencePack = pack()) {
  const out = judge(p, [{ run_id: p.run_id, function: OWN_DRAFT, verdict: 'DONE', evidence: EV, payload, report: '草稿。' }], PAYLOAD_HOOKS[OWN_DRAFT]);
  return draftResult(out, p, METRICS)!;
}
const why = (payload: unknown, p?: EvidencePack) => {
  const r = run(payload, p);
  expect(r.ok).toBe(false);
  return (r as { why: string }).why;
};
/** 改一條前提的一欄。 */
const withP = (k: number, field: string, value: unknown) => {
  const p = good();
  const x = (p.premises as Record<string, unknown>[])[k];
  if (value === undefined) delete x[field];
  else x[field] = value;
  return p;
};

describe('T60 草稿的格式（own_draft_v2）', () => {
  it('prompt 升版：own_draft_v2 寫明 confirms_if、verify、breaks_if 最多 3 句、信念與至少 2 條；v1 留著、開頭寫不再使用', () => {
    expect(OWN_DRAFT_PROMPT).toBe('own_draft_v3');
    const v2 = readFileSync(join(ROOT, 'ai', 'prompts', 'own_draft_v2.md'), 'utf8');
    for (const s of ['`confirms_if`', '`verify`', '1～3 句，一句寫一件事', '**至少要有 2 條不是信念的前提**', '配一個之後會出現在申報裡的替代指標', '**本文不放會過時的數字**', '寫之前先對證據包的 XBRL 季度表']) expect(v2).toContain(s);
    expect(v2).not.toContain('`NONE` 最多 1 條；');
    const v1 = readFileSync(join(ROOT, 'ai', 'prompts', 'own_draft_v1.md'), 'utf8');
    expect(v1.startsWith('> 不再使用（2026-11-21）')).toBe(true);
    expect(pack().prompt_version).toBe('own_draft_v3');
  });

  it('通過的草稿整理成新的形狀：confirms_if、breaks_if 陣列、verify（信念不存來源與天數）；證據包帶季度數字給程式比對', () => {
    const r = run(good());
    expect(r.ok).toBe(true);
    const d = (r as { draft: OwnDraft }).draft;
    expect(d.premises.map((p) => [p.confirms_if, p.breaks_if, p.verify])).toEqual([
      ['TrendForce 最新一季的 HBM 合約價預估仍是季漲', ['TrendForce 的新聞稿報 HBM 合約價季跌', 'SK 海力士宣布 HBM 擴產超過 50%'], { by: 'WEB', source: 'trendforce.com', every: 90 }],
      ['季報的毛利率仍在 55% 以上', ['毛利率連兩季低於 55%'], { by: 'XBRL', source: null, every: null }],
      [null, ['公司在 8-K 揭露大客戶違約或要求重議價格'], { by: 'NONE', source: null, every: null }],
    ]);
    expect((pack().rule.detail as { quarters: ClauseQuarter[] }).quarters.map((q) => [q.end, q.revenue])).toEqual(ROWS.map((q) => [q.end, q.revenue]));
    expect(pack(null).rule.detail).not.toHaveProperty('quarters');
    // 草稿的證據包看得到現行的信念（才能 keep_id 沿用）
    expect(pack().premises.find((p) => p.id === 'P6')?.verify).toEqual({ by: 'NONE' });
  });

  it('檢查 1：「怎樣算不成立」的子句用證據包的財報表看已經成立 → 整份退回（P5 的例子）；寫成往後看的、或還沒碰到的門檻就過', () => {
    const p5 = withP(1, 'breaks_if', ['任一季營收低於前一季']);
    expect(why(p5)).toContain('前提第 2 條的 breaks_if 第 1 句「任一季營收低於前一季」用證據包的財報表看已經成立（2026-06-30 那一季）');
    expect(why(withP(1, 'breaks_if', ['毛利率連兩季低於 65%']))).toContain('（2026-09-30 那一季）');
    expect(run(withP(1, 'breaks_if', ['之後任一季營收低於前一季'])).ok).toBe(true);
    expect(run(withP(1, 'breaks_if', ['下一季營收低於這一季'])).ok).toBe(true);
    expect(run(withP(1, 'breaks_if', ['營收低於前一季'])).ok).toBe(true); // 最新一季 160 > 150
    // 同業、網頁、信念的子句不比；沒有季度數字（XBRL 抓不到）不比
    expect(run(withP(0, 'breaks_if', ['任一季營收低於前一季'])).ok).toBe(true);
    expect(run(p5, pack(null)).ok).toBe(true);
  });

  it('檢查 2：前提的本文不放會過時的字樣（最新一季、財測約…）；同樣的字寫在 confirms_if、breaks_if、出場條件可以', () => {
    expect(why(withP(1, 'text', '毛利率維持在最新一季的 60% 附近'))).toContain('前提第 2 條的本文有會過時的字「最新一季」');
    expect(why(withP(1, 'text', '營收達到財測約 87 億美元'))).toContain('「財測約」');
    expect(DATED_WORDS.test('毛利率維持在 55% 以上')).toBe(false);
    expect(run(withP(1, 'confirms_if', '最新一季的毛利率仍在 55% 以上')).ok).toBe(true);
  });

  it('檢查 3：查得到的前提（verify.by 不是 NONE）要寫 confirms_if；信念可以不寫', () => {
    expect(why(withP(0, 'confirms_if', ''))).toContain('前提第 1 條查得到（verify.by 不是 NONE），要寫怎樣算證實（confirms_if）');
    expect(why(withP(1, 'confirms_if', undefined))).toContain('前提第 2 條查得到');
    expect(run(withP(2, 'confirms_if', undefined)).ok).toBe(true);
    expect(why(withP(0, 'confirms_if', '證'.repeat(301)))).toContain('confirms_if 超過 300 字');
  });

  it('breaks_if 1～3 句：4 句、空的一句、一句超過 300 字都不過；一段字當成一句可以', () => {
    expect(why(withP(0, 'breaks_if', ['a1', 'b2', 'c3', 'd4']))).toContain('前提第 1 條的 breaks_if 最多 3 句（送回 4 句）');
    expect(why(withP(0, 'breaks_if', ['TrendForce 報季跌', ' ']))).toContain('前提第 1 條的 breaks_if 有空的一句');
    expect(why(withP(0, 'breaks_if', ['不'.repeat(301)]))).toContain('breaks_if 第 1 句超過 300 字');
    expect(why(withP(0, 'breaks_if', []))).toContain('前提第 1 條沒有寫怎樣算不成立（breaks_if）');
    expect(run(withP(0, 'breaks_if', 'TrendForce 報 HBM 合約價季跌')).ok).toBe(true);
    expect(DRAFT_LIMITS.breaksClauses).toBe(PREMISE_FIELD_LIMITS.breaksClauses);
  });

  it('verify：by 五選一；source 200 字以內；every 寫了要是 7～400 的整數', () => {
    expect(why(withP(0, 'verify', { by: 'NEWS' }))).toContain('前提第 1 條的 verify.by 要是 XBRL、FILING、PEER_FILING、WEB、NONE 其中之一');
    expect(why(withP(0, 'verify', { by: 'WEB', source: '來'.repeat(201) }))).toContain('verify.source 超過 200 字');
    expect(why(withP(0, 'verify', { by: 'WEB', every: 3 }))).toContain('前提第 1 條的 verify.every 要是 7～400 的整數（天）');
    expect(why(withP(0, 'verify', { by: 'WEB', every: 'quarterly' }))).toContain('verify.every 要是 7～400 的整數');
  });

  it('至少 2 條不是信念（取代「NONE 最多 1 條」；細節在 t55）', () => {
    expect(why(withP(1, 'verify', { by: 'NONE' }))).toContain('至少要 2 條不是信念的前提（verify.by 不是 NONE；送回 1 條）');
  });
});

describe('T60 子句能不能用財報表比對（src/ai/xbrlClause.ts）', () => {
  const rows: ClauseQuarter[] = ROWS;
  it('認得的寫法：指標＋低於／高於數字、季減、年減、轉負；沒寫期間 = 最新一季、「連兩季」、「任一季」', () => {
    expect(parseXbrlClause('毛利率連兩季低於 55%')).toMatchObject({ metric: 'GrossMarginPct', rel: { kind: 'BELOW', level: 0.55 }, quarters: 2, any: false });
    expect(parseXbrlClause('連兩季營收年增率低於 15%')).toMatchObject({ metric: 'RevenueYoY', rel: { kind: 'BELOW', level: 0.15 }, quarters: 2 });
    expect(parseXbrlClause('任一季營收低於前一季')).toMatchObject({ metric: 'Revenue', rel: { kind: 'QOQ_DOWN' }, quarters: 1, any: true });
    expect(parseXbrlClause('營收年減')).toMatchObject({ metric: 'Revenue', rel: { kind: 'YOY_DOWN' } });
    expect(parseXbrlClause('稀釋每股盈餘轉負')).toMatchObject({ metric: 'EPSDiluted', rel: { kind: 'NEG' } });
    expect(parseXbrlClause('毛利率跌到 50% 以下')).toMatchObject({ rel: { kind: 'BELOW', level: 0.5 } });
    expect(clauseMetNow('毛利率連兩季低於 65%', rows)).toEqual({ met: true, end: '2026-09-30' });
    expect(clauseMetNow('毛利率連兩季低於 61%', rows)).toEqual({ met: false, end: null });
    expect(clauseMetNow('營收年增率低於 15%', rows)).toEqual({ met: true, end: '2026-09-30' });
    expect(clauseMetNow('任一季營收低於前一季', rows)).toEqual({ met: true, end: '2026-06-30' });
    expect(clauseMetNow('營收連兩季低於前一季', rows)).toEqual({ met: false, end: null });
  });

  it('認不得的不擋：往後看的、主詞是別的（事業單位、同業）、一句兩個指標、營收的金額或幅度、沒有指標；資料不夠也不擋', () => {
    for (const t of ['下一季營收低於這一季', '之後任一季營收低於前一季', '毛利率再跌破 55%', '資料中心營收季減', 'SK 海力士營收季減', '營收季減且毛利率低於 50%', '營收低於 300 億美元', '營收季減超過 10%', 'TrendForce 報 HBM 合約價季跌'])
      expect(parseXbrlClause(t), t).toBeNull();
    expect(clauseMetNow('營收年減', [qr('2026-09-30', 160, null, null)])).toBeNull();
    expect(clauseMetNow('營收低於前一季', [qr('2026-09-30', 100, null), qr('2025-09-30', 200, null)])).toBeNull(); // 差一年，不是前一季
    expect(clauseMetNow('毛利率低於 55%', null)).toBeNull();
  });
});

// ---------------------------------------------------------------- 存檔時怎麼用草稿（draftSave；新舊兩種草稿）

describe('T60 勾了草稿的前提：三個欄位照草稿的，送了就用送的；T55 的舊草稿照樣讀', () => {
  const okDraft = (run(good()) as { draft: OwnDraft }).draft;
  const viewOf = (d: OwnDraft): DraftView => ({ id: 9, runId: 'd60', trigger: 'MANUAL', createdAt: '2026-11-21T01:00:00Z', at: '2026-11-21T01:10:00Z', until: '2026-12-21', basedOn: 1, version: 1, stale: false, broken: null, payload: d });
  it('原樣勾選：怎樣算證實、子句、怎麼驗證都帶上；信念帶 verify NONE；右邊改過的用改過的', () => {
    const r = draftSave(viewOf(okDraft), { thesis: '', thesisPressed: false, premises: [{ id: null, text: okDraft.premises[0].text, draft: 0 }, { id: null, text: okDraft.premises[2].text, draft: 2 }, { id: null, text: okDraft.premises[1].text, confirmsIf: '我自己的證實', verify: { by: 'FILING', every: 91 }, breaksIf: ['我自己的一句'], draft: 1 }], exits: [], peers: [], domains: [] }, 2);
    expect(r.premises).toEqual([
      { id: null, text: okDraft.premises[0].text, origin: 'AI_DRAFT_ACCEPTED', breaksIf: okDraft.premises[0].breaks_if, confirmsIf: okDraft.premises[0].confirms_if, verify: { by: 'WEB', source: 'trendforce.com', every: 90 } },
      { id: null, text: okDraft.premises[2].text, origin: 'AI_DRAFT_ACCEPTED', breaksIf: okDraft.premises[2].breaks_if, confirmsIf: '', verify: { by: 'NONE' } },
      { id: null, text: okDraft.premises[1].text, origin: 'AI_DRAFT_ACCEPTED', breaksIf: ['我自己的一句'], confirmsIf: '我自己的證實', verify: { by: 'FILING', every: 91 } },
    ]);
  });
  it('T55 的舊草稿（breaks_if 一段字、checkable_by、source_hint）：一段字當成一句、checkable_by 當成怎麼查', () => {
    expect(draftPremiseFields({ text: 'x', keep_id: null, breaks_if: 'TrendForce 報季跌', checkable_by: 'WEB', source_hint: 'trendforce.com', evidence_ids: [] } as never)).toEqual({ breaksIf: ['TrendForce 報季跌'], confirmsIf: '', verify: { by: 'WEB', source: 'trendforce.com' } });
    expect(draftPremiseFields({ text: 'x', keep_id: null, breaks_if: '查不到', checkable_by: 'NONE', source_hint: null, evidence_ids: [] } as never).verify).toEqual({ by: 'NONE' });
  });
});

// ---------------------------------------------------------------- 編輯論點頁的白話（前端不碰 DOM 的部分）

describe('T60 編輯論點頁、草稿那一塊的白話（thesis-fields.js、thesis-draft.js）', () => {
  it('怎麼驗證的一句；信念寫「這一條查不到，是你選擇相信的」；收合時的摘要', () => {
    expect(FJ.verifyText({ by: 'WEB', source: 'trendforce.com', every: 90 })).toBe('查得到：清單內的網站（trendforce.com），約每 90 天有新的一份');
    expect(FJ.verifyText({ by: 'XBRL' })).toBe('查得到：財報數字（程式比對）');
    expect(FJ.verifyText({ by: 'NONE' })).toBe('信念：這一條查不到，是你選擇相信的');
    expect(FJ.verifyText(null)).toBeNull();
    expect(FJ.fieldsSummary({ breaksIf: [], confirmsIf: '', verify: null })).toBe('怎麼驗證：還沒寫（可以不填）');
    expect(FJ.fieldsSummary({ breaksIf: ['a', 'b'], confirmsIf: 'c', verify: { by: 'WEB', source: 'trendforce.com' } })).toBe('怎麼驗證：用清單內的網站查（trendforce.com）、寫了怎樣算證實、怎樣算不成立 2 句');
    expect(FJ.fieldsSummary({ breaksIf: ['a'], confirmsIf: '', verify: { by: 'NONE' } })).toBe('怎麼驗證：信念（這一條查不到，是你選擇相信的）');
    expect(FJ.hasFields({ breaksIf: [], confirmsIf: '', verify: null })).toBe(false);
    expect(FJ.hasFields({ breaksIf: ['a'], confirmsIf: '', verify: null })).toBe(true);
  });

  it('草稿的前提（新舊兩種）都讀得出三個欄位；信念那一條用提醒的顏色，不是紅字', () => {
    const okDraft = (run(good()) as { draft: OwnDraft }).draft;
    const items = DJ.draftItems(okDraft).premises;
    expect(items.map((x) => [x.breaksIf, x.confirmsIf, x.belief])).toEqual([
      [okDraft.premises[0].breaks_if, okDraft.premises[0].confirms_if, false],
      [okDraft.premises[1].breaks_if, okDraft.premises[1].confirms_if, false],
      [okDraft.premises[2].breaks_if, '', true],
    ]);
    expect(DJ.checkLine(items[0])).toEqual({ ok: true, belief: false, text: '查得到：清單內的網站（trendforce.com），約每 90 天有新的一份' });
    expect(DJ.checkLine(items[2])).toEqual({ ok: true, belief: true, text: FJ.BELIEF_TEXT });
    const old = DJ.draftItems({ premises: [{ text: 'x', breaks_if: '一段字', checkable_by: 'FILING', source_hint: '10-Q', evidence_ids: [] }] }).premises[0];
    expect([old.breaksIf, old.verify]).toEqual([['一段字'], { by: 'FILING', source: '10-Q' }]);
  });

  it('預覽：查得到的少於 2 條時提醒；2 條以上只說哪幾條是信念；只有預設前提不說', () => {
    expect(FJ.checkableWarn({ checkable: null, beliefs: [] })).toBeNull();
    expect(FJ.checkableWarn({ checkable: 3, beliefs: [] })).toBeNull();
    expect(FJ.checkableWarn({ checkable: 2, beliefs: ['P6'] })).toEqual({ tone: 'dim', text: 'P6 是信念：不進審查的逐條判定，審查檢查另外 2 條。' });
    expect(FJ.checkableWarn({ checkable: 1, beliefs: ['P5', 'P6'] })?.text).toContain('只有 1 條前提查得到（P5、P6 是信念）');
    expect(FJ.checkableWarn({ checkable: 0, beliefs: ['P6'] })?.text).toContain('每一條前提都標成信念');
  });
});

// ---------------------------------------------------------------- 網站：存檔、預覽、持股頁；審查的證據包（整個流程）

const NUMS: DiscussionNumbers = { date: '2026-11-30', close: 181.23, fromHigh: -0.12, ma200: 160.5, vsMa: 0.129, slow: 'STD', ret1y: 0.42, weight: 0.062, stdWeight: 0.05, ownTotal: 0.23, ownBudget: 0.2, xbrl: null, openedHalf: null };

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
    if (/companyfacts\/CIK\d+\.json/.test(url)) return Response.json(quarterFacts([{ end: '2025-09-30', rev: 120, filed: '2025-11-01' }, { end: '2026-09-30', rev: 160, filed: '2026-10-30' }]));
    if (url.startsWith('https://www.nasdaq.com/feed/rssoutbound') || url.startsWith('https://feeds.finance.yahoo.com/rss/2.0/headline')) return new Response('<rss><channel></channel></rss>');
    return base(url, init);
  };
}
const SEEDED: Premise[] = [
  { id: 'P1', text: '資料中心需求延續到 2027', origin: 'USER', breaksIf: '連兩季營收年增率低於 15%' },
  { id: 'P2', text: 'HBM 長約有價格保護', origin: 'USER' },
];

async function withWorld(fn: (c: { db: D1Database; env: Env; fetcher: Fetcher; api: <T = Record<string, unknown>>(method: 'GET' | 'POST', path: string, body?: unknown) => Promise<{ status: number; body: T }> }) => Promise<void>) {
  const d = await freshDb();
  try {
    const db = d.db;
    const w = newWorld('2026-11-19');
    const env: Env = { DB: db, ADMIN_TOKEN: 't', AI_TASK_SECRET: 's', EDGAR_USER_AGENT: 'test bot test@example.com', SITE_URL: 'https://bot.example', DEV_NO_AUTH: '1', ROUTINE_FIRE_URL: 'https://api.example/fire', ROUTINE_TOKEN: 'rt' };
    const fetcher = fetcherOf(w);
    await runFlow(env, fetcher, { now: cronTime('2026-11-19'), attempt: 'FIRST' });
    const { view } = buildMarketView(await loadSeries(db, ['VOO', 'SGOV', 'NVDA']), '2026-11-19', 'VOO');
    const acct = createAccount({ paper: true, cash: 5000, core: { VOO: Math.floor(140_000 / view.close.VOO[view.i]) }, own: { NVDA: { shares: Math.floor(40_000 / view.close.NVDA[view.i]), stdWeight: 0.15, premises: structuredClone(SEEDED) } } }, view);
    await saveAccount(db, acct, null, '建立帳戶', new Date('2026-11-19T12:00:00Z'));
    const api = async <T,>(method: 'GET' | 'POST', path: string, body?: unknown) => {
      const r = await handle(new Request(`https://bot.example/api/${path}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env, fetcher, new Date('2026-11-20T02:00:00Z'));
      return { status: r.status, body: (await r.json()) as T };
    };
    await fn({ db, env, fetcher, api });
  } finally {
    await d.dispose();
  }
}
const acctOfDb = async (db: D1Database): Promise<Account> => (await loadAccount(db))!.acct;
type Preview = { preview: { beliefs: string[]; checkable: number | null; changed: boolean; edited: unknown[] } };

describe('T60 編輯論點：存檔、預覽、持股頁、審查的證據包（網站 API）', () => {
  it('存怎樣算證實、最多 3 句的怎樣算不成立、怎麼驗證；標成信念；預覽寫哪幾條是信念、查得到的幾條；持股頁看得到；審查的證據包不放信念', async () => {
    await withWorld(async ({ db, env, fetcher, api }) => {
      const body = {
        ticker: 'NVDA',
        source: 'TYPED',
        thesis: '',
        exitConditions: [],
        premises: [
          { id: 'P1', text: '資料中心需求延續到 2027', confirmsIf: '10-Q 的營收年增率仍高於 30%', breaksIf: ['連兩季營收年增率低於 15%', '公司下修全年營收財測'], verify: { by: 'XBRL', source: 'SEC XBRL', every: '91' } },
          { id: 'P2', text: 'HBM 長約有價格保護', confirmsIf: '', breaksIf: ['8-K 揭露客戶要求重議價格'], verify: { by: 'NONE', source: '不會存' } },
        ],
      };
      const dry = await api<Preview>('POST', 'ops/own-thesis', { ...body, dry: true });
      expect(dry.status).toBe(200);
      expect(dry.body.preview).toMatchObject({ beliefs: ['P2'], checkable: 1, changed: false, edited: [] });
      const r = await api<Preview>('POST', 'ops/own-thesis', body);
      expect(r.status).toBe(200);
      const a = await acctOfDb(db);
      expect(a.own.NVDA.premises).toEqual([
        { id: 'P1', text: '資料中心需求延續到 2027', origin: 'USER', confirmsIf: '10-Q 的營收年增率仍高於 30%', breaksIf: ['連兩季營收年增率低於 15%', '公司下修全年營收財測'], verify: { by: 'XBRL', source: 'SEC XBRL', every: 91 }, addedAt: '2026-11-19' },
        { id: 'P2', text: 'HBM 長約有價格保護', origin: 'USER', breaksIf: ['8-K 揭露客戶要求重議價格'], verify: { by: 'NONE' }, addedAt: '2026-11-19' },
      ]);
      // log 的 THESIS 標出信念
      const log = (await db.prepare("SELECT body FROM own_thesis_log WHERE kind = 'THESIS' ORDER BY id DESC LIMIT 1").first<{ body: string }>())!;
      expect((JSON.parse(log.body) as { after: { premises: { id: string; belief?: boolean }[] } }).after.premises).toEqual([
        { id: 'P1', text: '資料中心需求延續到 2027', origin: 'USER' },
        { id: 'P2', text: 'HBM 長約有價格保護', origin: 'USER', belief: true },
      ]);
      // 持股頁（編輯論點頁也讀這一份）
      const hd = await api<HoldingDetail>('GET', 'holding/NVDA');
      expect(hd.body.own!.premises.map((p) => [p.id, p.text, p.breaksIf, p.confirmsIf, p.verify, p.belief])).toEqual([
        ['P1', '資料中心需求延續到 2027（不成立的訊號：連兩季營收年增率低於 15%；公司下修全年營收財測）', ['連兩季營收年增率低於 15%', '公司下修全年營收財測'], '10-Q 的營收年增率仍高於 30%', { by: 'XBRL', source: 'SEC XBRL', every: 91 }, false],
        ['P2', 'HBM 長約有價格保護（不成立的訊號：8-K 揭露客戶要求重議價格）', ['8-K 揭露客戶要求重議價格'], null, { by: 'NONE' }, true],
      ]);
      // 沒送這幾欄（例如 /thesis 從 repo 回填）→ 照舊；verify 送 null → 拿掉
      expect((await api('POST', 'ops/own-thesis', { ticker: 'NVDA', source: 'TYPED', thesis: '', exitConditions: [], premises: [{ id: 'P1', text: '資料中心需求延續到 2027' }, { id: 'P2', text: 'HBM 長約有價格保護' }] })).status).toBe(200);
      expect((await acctOfDb(db)).own.NVDA.premises.map((p) => p.verify?.by ?? null)).toEqual(['XBRL', 'NONE']);
      // 審查：證據包只放查得到的 P1（信念不進逐條判定）
      const acct = await acctOfDb(db);
      const { view, axis } = buildMarketView(await loadSeries(db, ['VOO', 'SGOV', 'NVDA']), '2026-11-19', 'VOO');
      const rr = await startOwnReview(env, fetcher, acct, view, axis, 'NVDA', 'MANUAL', new Date('2026-11-20T03:00:00Z'));
      const run = (await getRun(db, rr.runId))!;
      expect(run.pack.premises).toEqual([{ id: 'P1', text: '資料中心需求延續到 2027', origin: 'USER', breaksIf: ['連兩季營收年增率低於 15%', '公司下修全年營收財測'], confirmsIf: '10-Q 的營收年增率仍高於 30%', verify: { by: 'XBRL', source: 'SEC XBRL', every: 91 } }]);
      const off = await api<Preview>('POST', 'ops/own-thesis', { ticker: 'NVDA', source: 'TYPED', thesis: '', exitConditions: [], premises: [{ id: 'P1', text: '資料中心需求延續到 2027' }, { id: 'P2', text: 'HBM 長約有價格保護', verify: null }] });
      expect(off.body.preview).toMatchObject({ beliefs: [], checkable: 2 });
      expect((await acctOfDb(db)).own.NVDA.premises[1].verify).toBeUndefined();
    });
  });

  it('擋下來的：怎樣算不成立超過 3 句、多久有新的一份不是 7～400 的整數、每句超過 300 字（帳戶不變）', async () => {
    await withWorld(async ({ db, api }) => {
      const base = { ticker: 'NVDA', source: 'TYPED', thesis: '', exitConditions: [] };
      const four = await api<{ error: string }>('POST', 'ops/own-thesis', { ...base, premises: [{ id: 'P1', text: '資料中心需求延續到 2027', breaksIf: ['a', 'b', 'c', 'd'] }] });
      expect(four.status).toBe(422);
      expect(four.body.error).toBe('第 1 條前提「怎樣算不成立」最多 3 句（一句寫一件事）');
      const ev = await api<{ error: string }>('POST', 'ops/own-thesis', { ...base, premises: [{ id: 'P1', text: '資料中心需求延續到 2027', verify: { by: 'WEB', every: 1000 } }] });
      expect(ev.status).toBe(422);
      expect(ev.body.error).toContain('「多久有新的一份」要是 7～400 的整數（天）；不知道就留空，用 100 天');
      const long = await api<{ error: string }>('POST', 'ops/own-thesis', { ...base, premises: [{ id: 'P1', text: '資料中心需求延續到 2027', breaksIf: ['不'.repeat(301)] }] });
      expect(long.status).toBe(422);
      expect((await acctOfDb(db)).own.NVDA.premises).toEqual(SEEDED.map((p) => ({ ...p, addedAt: '2026-11-19' })));
    });
  });
});
