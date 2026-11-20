// T56：草稿的畫面與同意流程（web_evidence_design §2.3、§2.5、§2.6）。
// 完成條件：
//   預設都不勾（草稿的每一項 checked = false；一條都沒勾就存檔 → 草稿照舊等你看、沒有 AI_DRAFT_ACCEPTED 的前提）
//   原樣勾選記 AI_DRAFT_ACCEPTED、改字記 USER；breaks_if 存進 breaksIf；論點一字沒改記 DRAFT
//   出場條件仍然要在持股頁再確認（勾了只會送去改寫，條件不會直接開始監測）
//   草稿過期與版本不同的提示
//   DRAFT_READY（要看的事）、LINE 一行（使用者按的才推）
//   USED／DISMISSED 的寫入、「失效後修改」計次、按鈕防連按（同一檔同時只能有一列 PENDING）、各入口的按鈕狀態
// check.ts 沒有動；AI 的回覆一律是假的；對外請求全部是假的（EDGAR、RSS、雲端排程、LINE）。
import { describe, expect, it } from 'vitest';
import { judge, type PackDoc } from '../src/ai/check';
import { PAYLOAD_HOOKS } from '../src/ai/hooks';
import { OWN_DRAFT, draftResult, ownDraftPack, brokenNotice, type OwnDraft } from '../src/ai/ownDraft';
import { packOrigin } from '../src/ai/pack';
import { getRun } from '../src/app/aiRuns';
import type { Env, Fetcher } from '../src/app/env';
import { pushPending, runFlow } from '../src/app/flow';
import { loadAccount, saveAccount } from '../src/app/ledgerStore';
import { LINE_PUSH_URL } from '../src/app/line';
import { DRAFT_GAP_DAYS, DraftError, draftLineText, draftSave, draftStateOf, draftUsed, expireDrafts, loadDrafts, pushDraftLines, requestOwnDraft, startOwnDraft, type DraftRow, type DraftView } from '../src/app/ownDraft';
import { OWN_ATTN, thesisNote, type ThesisFile } from '../src/app/thesis';
import { XBRL_METRICS, type CompanyFacts, type XbrlFact } from '../src/data/edgar';
import { buildMarketView } from '../src/data/marketView';
import { loadSeries } from '../src/data/store';
import { SYSTEM_DEFAULT_PREMISES, createAccount, mapPremises, routeReview, setThesis, type Account, type MarketView, type Premise } from '../src/engine';
import { handle } from '../src/index';
import { freshDb } from './helpers/d1';
import { cronTime, fakeFetcher, newWorld, type World } from './helpers/fakeSources';

const METRICS = new Set(Object.keys(XBRL_METRICS));

// 前端的 thesis-draft.js 不碰 DOM，直接 import（同 t39b、t44 的寫法：瀏覽器直接載入的 JS 沒有型別宣告）
type Item = { k: number; checked: boolean; [x: string]: unknown };
interface DraftJs {
  ACTION_TEXT: Record<string, string>;
  NOT_CHECKABLE: string;
  checkLine(it: Item): { ok: boolean; text: string };
  draftButtonState(state: unknown, now?: Date): { mode: string; button: string | null; text: string | null };
  draftItems(p: unknown): { premises: Item[]; exits: Item[]; peers: Item[]; domains: Item[] };
  draftNotices(d: unknown): { tone: string; text: string }[];
  draftPreviewLines(pd: unknown): { tone: string; text: string }[];
  originHint(draftText: string, text: string): string;
  untouchedPremises(p: unknown, current: unknown[]): string[];
}
const { ACTION_TEXT, NOT_CHECKABLE, checkLine, draftButtonState, draftItems, draftNotices, draftPreviewLines, originHint, untouchedPremises } = (await import('../public/js/thesis-draft.js' as string)) as DraftJs;

// ---------------------------------------------------------------- 原文與一份會通過檢查的草稿（同 T55）

const Q_REV = 'Revenue for the third quarter was $160 million, up 33% from a year ago';
const Q_GM = 'Gross margin was 60.0%, down from 70.0% a year ago';
const RISK1 = 'Our three largest customers accounted for 61% of revenue';
const RISK2 = 'Export restrictions may limit our ability to sell to certain customers';
const RISK3 = 'Inventory provisions increased to $1.2 billion this quarter';
const TENQ_TEXT = `${Q_REV}. ${Q_GM}. ${RISK1}. ${RISK2}. ${RISK3}.`;
const USER_PREMISES: Premise[] = [
  { id: 'P1', text: '資料中心需求延續到 2027', origin: 'USER' },
  { id: 'P2', text: 'HBM 供給持續吃緊', origin: 'USER' },
];
type Cite = Pick<PackDoc, 'source_id' | 'date'>;
const E = (id: string, doc: Cite, quote: string) => ({ id, source_id: doc.source_id, date: doc.date, quote, claim: '測試' });
const evOf = (q: Cite) => [E('E1', q, Q_GM), E('E2', q, Q_REV), E('E3', q, RISK1), E('E4', q, RISK2), E('E5', q, RISK3)];

const DRAFT_THESIS = '資料中心的 GPU 需求帶動營收與毛利，持有的理由靠需求延續、供給吃緊與毛利率維持。';
const P0 = '資料中心營收連續四季年增超過 30%';
const P1 = 'HBM 的合約價到 2027 年上半年仍然逐季上漲';
const X0 = '毛利率連兩季低於 55%（最新一季 60%）';
function goodPayload(): Record<string, unknown> {
  return {
    thesis: DRAFT_THESIS,
    premises: [
      { text: P0, keep_id: null, breaks_if: '連兩季營收年增率低於 15%', checkable_by: 'XBRL', source_hint: null, evidence_ids: ['E2'] },
      { text: P1, keep_id: null, breaks_if: 'TrendForce 的新聞稿報 HBM 合約價季跌', checkable_by: 'WEB', source_hint: 'trendforce.com', evidence_ids: [] },
      { text: '毛利率維持在 55% 以上', keep_id: null, breaks_if: '毛利率連兩季低於 55%', checkable_by: 'NONE', source_hint: null, evidence_ids: ['E1'] },
    ],
    exits: [
      { text: X0, action: 'HALF', kind: 'XBRL', check: { type: 'xbrl_metric_below', metric: 'GrossMarginPct', level: 0.55, quarters: 2 }, premise_index: 2, evidence_ids: ['E1'] },
      { text: '公司在 8-K 宣布下修本季營收財測', action: 'REVIEW', kind: 'EVENT', check: null, premise_index: null, evidence_ids: [] },
    ],
    sources: { peers: [{ name: 'SK hynix', edgar: null, yahoo: '000660.KS' }], domains: ['www.micron.com', 'fool.com'] },
    against: [
      { text: '營收集中在三家客戶', evidence_ids: ['E3'] },
      { text: '出口管制限制銷售對象', evidence_ids: ['E4'] },
      { text: '存貨提列變大', evidence_ids: ['E5'] },
    ],
    would_buy_today: { answer: 'UNSURE', why: '需求還在，但客戶集中與存貨的風險都在上升' },
    not_checkable: ['大客戶自研晶片的進度'],
  };
}

/** 純函式用：一份檢查過的草稿（OwnDraft）。 */
function okDraft(payload: Record<string, unknown> = goodPayload(), premises: Premise[] = USER_PREMISES): OwnDraft {
  const doc: PackDoc = { id: 'D1', source_id: 'edgar:q', kind: 'filing', date: '2026-10-30', title: '10-Q', text: TENQ_TEXT };
  const pack = ownDraftPack({ runId: 'r', asOf: '2026-11-19', ticker: 'NVDA', trigger: 'MANUAL', held: true, premises, facts: [], docs: [doc], dataQuality: {}, thesisVersion: 1, fileId: 'NVDA@2026-11-19', broken: null, webDomains: ['trendforce.com'], now: new Date('2026-11-20T01:00:00Z') }).pack;
  const out = judge(pack, [{ run_id: 'r', function: OWN_DRAFT, verdict: 'DONE', evidence: evOf(doc), payload, report: '草稿。' }], PAYLOAD_HOOKS[OWN_DRAFT]);
  const r = draftResult(out, pack, METRICS)!;
  if (!r.ok) throw new Error(r.why);
  return r.draft;
}
const viewOf = (d: OwnDraft, o: Partial<DraftView> = {}): DraftView => ({ id: 7, runId: 'run-7', trigger: 'MANUAL', createdAt: '2026-11-20T01:00:00Z', at: '2026-11-20T01:10:00Z', until: '2026-12-20', basedOn: 1, version: 1, stale: false, broken: null, payload: d, ...o });

// ---------------------------------------------------------------- 純函式：畫面上的文字與預設

describe('T56 草稿的每一項預設都不勾（§2.3）', () => {
  it('前提、出場條件、同業、網站全部 checked = false；網站只有「新的來源」可以勾', () => {
    const items = draftItems(okDraft());
    const all = [...items.premises, ...items.exits, ...items.peers, ...items.domains];
    expect(all.length).toBe(3 + 2 + 1 + 2);
    expect(all.every((x) => x.checked === false)).toBe(true);
    expect(items.domains.map((x) => [x.domain, x.state, x.checkable])).toEqual([
      ['www.micron.com', 'NEW', true],
      ['fool.com', 'EXCLUDED', false],
    ]);
  });

  it('每條前提寫查得到的來源；NONE 寫紅字「stock bot 監測不了這一條」；出場條件的動作是白話', () => {
    const items = draftItems(okDraft());
    expect(checkLine(items.premises[0])).toEqual({ ok: true, text: '查得到：財報數字（程式比對）' });
    expect(checkLine(items.premises[1])).toEqual({ ok: true, text: '查得到：清單內的網站（trendforce.com）' });
    expect(checkLine(items.premises[2])).toEqual({ ok: false, text: NOT_CHECKABLE });
    expect(ACTION_TEXT[items.exits[0].action as string]).toBe('減半');
    expect(items.exits[0].threshold).toBe(true);
  });

  it('勾來的那一條：原樣 → 存成「AI 草擬、你勾選的」；改過字（只改標點不算）→ 存成你寫的', () => {
    expect(originHint(P0, `${P0}。`)).toContain('AI 草擬、你勾選的');
    expect(originHint(P0, '資料中心營收連續三季年增超過 30%')).toContain('你改過字：存成你寫的前提');
  });

  it('草稿沒有沿用的你現在的前提列出來（「新的」裡照舊留著）', () => {
    const d = okDraft({ ...goodPayload(), premises: [{ text: '資料中心需求延續到 2027', keep_id: 'P1', breaks_if: '連兩季營收年增率低於 15%', checkable_by: 'XBRL', evidence_ids: ['E2'] }, ...(goodPayload().premises as unknown[]).slice(1)] });
    expect(untouchedPremises(d, [{ id: 'P1', system: false }, { id: 'P2', system: false }])).toEqual(['P2']);
  });
});

describe('T56 草稿的提示：過期日、版本不同、剛被判不成立（§2.3、§2.4 第 6 點）', () => {
  it('照的論點版本和現在不同 → 「這份草稿是照第 N 版寫的，之後你改過論點」；還沒有論點時寫的另一種說法', () => {
    const d = okDraft();
    expect(draftNotices(viewOf(d, { basedOn: 2, version: 3, stale: true })).map((x) => x.text)).toContain('這份草稿是照第 2 版論點寫的，之後你改過論點（現在第 3 版）。左邊「現在的」才是你現在的論點，勾之前對照一下。');
    expect(draftNotices(viewOf(d, { basedOn: 0, version: 1, stale: true }))[0].text).toBe('這份草稿是在你還沒有論點的時候寫的，之後你自己存了論點（現在第 1 版）。勾之前對照左邊「現在的」。');
    const plain = draftNotices(viewOf(d));
    expect(plain).toHaveLength(1);
    expect(plain[0].text).toBe('你在 11/20 請 stock bot 草擬的；12/20 之後不再列（30 天沒處理就過期）。每一條都要你勾了才會填進「新的」，沒勾的不會存。');
  });

  it('剛被判不成立 → 最上面固定那句話（紅字），寫明不能沿用、存檔算一次失效後修改；那則通知還沒回覆時提醒回去', () => {
    const n = draftNotices(viewOf(okDraft(), { broken: { premiseId: 'P2', text: 'HBM 供給持續吃緊', notif: 3, notice: brokenNotice('P2'), open: true } }));
    expect(n[0]).toEqual({ tone: 'hot', text: '前提 P2 剛被判不成立。在這之後改論點，很容易只是替繼續持有找新理由。' });
    expect(n[1].text).toContain('這份草稿不能沿用 P2；用了這份草稿存檔，算一次「失效後修改」。那則通知還等你決定');
  });

  it('預覽：一條都沒勾 → 草稿照舊留著；勾了一半 → 列出沒勾的幾條、存檔後不再列；過期的草稿照樣用', () => {
    expect(draftPreviewLines({ used: false, until: '2026-12-20' })[0].text).toBe('草稿一條都還沒勾：這次存檔不會用到草稿，草稿照舊留著，12/20 之前都可以回來勾。');
    const half = draftPreviewLines({ used: true, thesis: 'SAME', premises: { same: 1, edited: 1, kept: 0 }, exits: 1, peers: 0, domains: 0, unused: { premises: 1, exits: 1, sources: 2 }, status: 'READY', afterBreakNo: null });
    expect(half.map((x) => x.text)).toEqual(['從草稿用了：論點本文（一字沒改）、前提 1 條原樣（記成「AI 草擬、你勾選的」）、前提 1 條改過字（記成你寫的）、出場條件 1 條。', '沒勾的：前提 1 條、出場條件 1 條、同業與網站 2 項。存檔後這份草稿標成用過、不再列，沒勾的不會存；之後想要，要自己寫進來。']);
    const late = draftPreviewLines({ used: true, thesis: null, premises: { same: 1, edited: 0, kept: 0 }, exits: 0, peers: 0, domains: 0, unused: { premises: 2, exits: 2, sources: 0 }, status: 'EXPIRED', afterBreakNo: 2, premiseId: 'P2', brokenOpen: false });
    expect(late.map((x) => x.text)).toContain('這份草稿是在前提 P2 被判不成立之後寫的：存檔算一次「失效後修改」（第 2 次）。');
    expect(late.map((x) => x.text)).toContain('這份草稿已經過期（30 天沒處理，或之後有新的草稿）；存檔照樣用你勾的這些。');
  });
});

describe('T56 各入口的「請 stock bot 草擬」按鈕狀態（§2.5、§2.6）', () => {
  const base = { ready: null, pending: null, last: null, lastAt: null, nextAt: null, autoSoon: false, aiReady: true };
  const NOW = new Date('2026-11-21T03:00:00Z');
  it('可以按／準備中（自動的寫「正在自動草擬」）／好了／7 天內按過／上次失敗（再試一次）／明天會自動草擬／雲端排程沒設定', () => {
    expect(draftButtonState(null)).toEqual({ mode: 'ASK', button: '請 stock bot 草擬', text: null });
    expect(draftButtonState(base, NOW)).toMatchObject({ mode: 'ASK', button: '請 stock bot 草擬' });
    expect(draftButtonState({ ...base, pending: { runId: 'r', trigger: 'AUTO', createdAt: '2026-11-20T23:31:00Z' } }, NOW)).toMatchObject({ mode: 'PENDING', button: null, text: '新加進自選，stock bot 正在自動草擬（11/21 07:31 開始，通常 10 分鐘左右；好了會列在「要看的事」）' });
    expect(draftButtonState({ ...base, pending: { runId: 'r', trigger: 'MANUAL', createdAt: '2026-11-21T02:00:00Z' } }, NOW).text).toContain('草稿準備中（11/21 10:00 開始，通常 10 分鐘左右；好了推 LINE）');
    expect(draftButtonState({ ...base, ready: { id: 1, runId: 'r', trigger: 'MANUAL', createdAt: '', at: '2026-11-21T02:10:00Z', until: '2026-12-21', basedOn: 0, version: 0, stale: false } }, NOW)).toMatchObject({ mode: 'READY', text: '草稿好了（11/21），12/21 之後不再列' });
    expect(draftButtonState({ ...base, lastAt: '2026-11-20T01:00:00Z', nextAt: '2026-11-27T01:00:00Z', last: { id: 1, status: 'USED', trigger: 'MANUAL', createdAt: '2026-11-20T01:00:00Z', at: '', why: null } }, NOW)).toMatchObject({ mode: 'WAIT', button: null, text: '11/20 已經草擬過一次（每檔 7 天一次），11/27 之後可以再按；那一份你已經用過' });
    expect(draftButtonState({ ...base, last: { id: 1, status: 'FAILED', trigger: 'MANUAL', createdAt: '', at: '', why: '超過 45 分鐘沒有收到結果' } }, NOW)).toMatchObject({ mode: 'FAILED', button: '再試一次', text: '上次草擬沒有成功（超過 45 分鐘沒有收到結果）' });
    expect(draftButtonState({ ...base, autoSoon: true }, NOW)).toMatchObject({ mode: 'AUTO', button: '現在就草擬' });
    expect(draftButtonState({ ...base, aiReady: false }, NOW)).toMatchObject({ mode: 'OFF', button: null });
    expect(draftButtonState({ ...base, last: { id: 1, status: 'EXPIRED', trigger: 'AUTO', createdAt: '2026-10-01T00:00:00Z', at: '', why: null } }, NOW).text).toBe('上一份草稿（10/1）30 天沒處理，已經過期');
  });
});

// ---------------------------------------------------------------- 純函式：存檔時怎麼用草稿、狀態、LINE 文字、要看的事

describe('T56 前提的來源與 breaksIf（引擎 mapPremises）', () => {
  const meta = { premises: [{ id: 'P1', text: '資料中心需求延續到 2027', origin: 'USER' as const, addedAt: '2026-11-01' }, { id: 'P4', text: 'HBM 長約有價格保護', origin: 'AI_DRAFT_ACCEPTED' as const, breaksIf: '合約價季跌', addedAt: '2026-11-02' }], premiseSeq: 6 };
  it('新的一條帶 origin 與 breaksIf；沿用的照舊保留來源，送了 breaksIf 就換（空字串 = 拿掉）', () => {
    const m = mapPremises(meta, [{ id: 'P1', text: '資料中心需求延續到 2027', breaksIf: '連兩季營收年增率低於 15%' }, { id: 'P4', text: 'HBM 長約有價格保護', breaksIf: '' }, { text: P0, origin: 'AI_DRAFT_ACCEPTED', breaksIf: '連兩季營收年增率低於 15%' }, { text: P1, origin: 'USER' }], '2026-11-21');
    expect(m.premises).toEqual([
      { id: 'P1', text: '資料中心需求延續到 2027', origin: 'USER', addedAt: '2026-11-01', breaksIf: '連兩季營收年增率低於 15%' },
      { id: 'P4', text: 'HBM 長約有價格保護', origin: 'AI_DRAFT_ACCEPTED', addedAt: '2026-11-02' },
      { id: 'P6', text: P0, origin: 'AI_DRAFT_ACCEPTED', breaksIf: '連兩季營收年增率低於 15%', addedAt: '2026-11-21' },
      { id: 'P7', text: P1, origin: 'USER', addedAt: '2026-11-21' },
    ]);
  });
  it('原樣勾選的草稿前提之後被你改了字 → 來源改成 USER；只改標點不算', () => {
    expect(mapPremises(meta, [{ id: 'P4', text: 'HBM 長約有價格保護，到 2028' }], '2026-11-21').premises[0].origin).toBe('USER');
    expect(mapPremises(meta, [{ id: 'P4', text: 'HBM 長約，有價格保護。' }], '2026-11-21').premises[0]).toMatchObject({ origin: 'AI_DRAFT_ACCEPTED', breaksIf: '合約價季跌' });
  });
});

describe('T56 存檔時怎麼用這份草稿（draftSave）', () => {
  const d = okDraft();
  const ws = { peers: [{ name: 'SK hynix', yahoo: '000660.KS' }], domains: ['www.micron.com'] };
  it('原樣勾選 → AI_DRAFT_ACCEPTED；改字 → USER；breaks_if 預設用草稿的、你改了用你的；論點一字沒改 → DRAFT；沒勾的有幾條', () => {
    const r = draftSave(viewOf(d), { thesis: DRAFT_THESIS, thesisPressed: true, premises: [{ id: null, text: P0, draft: 0 }, { id: null, text: 'HBM 的合約價到 2027 年仍然上漲', breaksIf: '合約價連兩季下跌', draft: 1 }, { id: 'P1', text: '資料中心需求延續到 2027', draft: null }], exits: [0], peers: [0], domains: [0, 1], webSources: ws }, 3);
    expect(r.premises).toEqual([
      { id: null, text: P0, origin: 'AI_DRAFT_ACCEPTED', breaksIf: '連兩季營收年增率低於 15%' },
      { id: null, text: 'HBM 的合約價到 2027 年仍然上漲', origin: 'USER', breaksIf: '合約價連兩季下跌' },
      { id: 'P1', text: '資料中心需求延續到 2027' },
    ]);
    expect(r.source).toBe('DRAFT');
    // 不列入的網站（fool.com）勾了也不算
    expect(r.use).toMatchObject({ id: 7, version: 3, thesis: 'SAME', premises: { same: 1, edited: 1, kept: 0 }, exits: 1, peers: 1, domains: 1, unused: { premises: 1, exits: 1, sources: 0 }, afterBreak: false });
    expect(draftUsed(r.use)).toBe(true);
  });
  it('按了「用這段」又改了字 → 來源照舊（不是 DRAFT），記 EDITED；什麼都沒勾 → 沒有用到（草稿留著）', () => {
    const r = draftSave(viewOf(d), { thesis: `${DRAFT_THESIS}我自己再補一句。`, thesisPressed: true, premises: [], exits: [], peers: [], domains: [], webSources: undefined }, 2);
    expect(r.source).toBeNull();
    expect(r.use.thesis).toBe('EDITED');
    const none = draftSave(viewOf(d), { thesis: '我自己寫的', thesisPressed: false, premises: [{ id: null, text: '我自己的前提', draft: null }], exits: [], peers: [], domains: [], webSources: undefined }, 2);
    expect(draftUsed(none.use)).toBe(false);
    expect(none.premises).toEqual([{ id: null, text: '我自己的前提' }]);
  });
  it('剛被判不成立之後寫的草稿：用了才算一次「失效後修改」', () => {
    const broken = { premiseId: 'P2', text: 'HBM 供給持續吃緊', notif: 3, notice: brokenNotice('P2'), open: true };
    expect(draftSave(viewOf(d, { broken }), { thesis: '', thesisPressed: false, premises: [{ id: null, text: P0, draft: 0 }], exits: [], peers: [], domains: [] }, 2).use.afterBreak).toBe(true);
    expect(draftSave(viewOf(d, { broken }), { thesis: '', thesisPressed: false, premises: [], exits: [], peers: [], domains: [] }, 2).use.afterBreak).toBe(false);
  });
});

describe('T56 判的人看不到出題的過程（§2.4 第 4 點）', () => {
  it('證據包裡原樣勾選的草稿前提寫成 USER，系統預設照舊；論點那一份 note 不寫 DRAFT 的來源', () => {
    expect(packOrigin('AI_DRAFT_ACCEPTED')).toBe('USER');
    expect(packOrigin('SYSTEM_DEFAULT')).toBe('SYSTEM_DEFAULT');
    const tf = { ticker: 'NVDA', fileId: 'NVDA@2026-11-19', openedAt: '2026-11-19', origin: 'INITIAL', kind: 'THESIS', status: 'OPEN', thesis: { text: DRAFT_THESIS, setAt: '2026-11-21', source: 'DRAFT', version: 2, afterBreak: 0, lastAfterBreakAt: null }, premises: [], conditions: [], events: [], reviews: [], disputes: [], flags: [], lastReview: null, newSince: '2026-07-01', log: [] } as unknown as ThesisFile;
    const note = thesisNote(tf, '2026-11-21')!.text;
    expect(note).toContain('論點（2026-11-21 定，第 2 版）：');
    expect(note).not.toContain('草稿');
    expect(note).not.toContain('在網站手寫');
  });
});

describe('T56 草稿回來了：DRAFT_READY 與 LINE 一行（§2.5）', () => {
  it('要看的事：「MU 的論點草稿好了，等你看（12/20 之後不再列）」，每一份草稿列一次', () => {
    const k = OWN_ATTN.find((x) => x.kind === 'DRAFT_READY')!;
    const file = { ticker: 'MU', draft: { runId: 'run-1', at: '2026-11-20T01:10:00Z', until: '2026-12-20', trigger: 'AUTO' } } as unknown as ThesisFile;
    expect(k.detect({ file, meta: {} as never, acct: {} as never, view: { date: '2026-11-20' } })).toEqual([{ key: 'DRAFT_READY@run-1', every: null, since: '2026-11-20', text: 'MU 的論點草稿好了，等你看（12/20 之後不再列）' }]);
    expect(k.detect({ file: { ...file, draft: null }, meta: {} as never, acct: {} as never, view: { date: '2026-11-20' } })).toEqual([]);
  });
  it('LINE：回來了一行加編輯論點頁的連結；沒有成功寫原因與「再試一次」', () => {
    const row = { ticker: 'MU', status: 'READY' as const, error: null, settled_at: '2026-11-20T01:10:00Z', created_at: '2026-11-20T01:00:00Z' };
    expect(draftLineText(row, true, 'https://bot.example')).toBe('【紙上】MU 的論點草稿好了：先看反方，再逐條勾你同意的，沒勾的不會生效（12/20 之後不再列）\nhttps://bot.example/?openExternalBrowser=1#/h/MU/thesis');
    expect(draftLineText({ ...row, status: 'FAILED', error: '程式檢查沒過：反方要 3 點（送回 2 點）' }, false, 'https://bot.example').split('\n')).toEqual(['MU 的論點草稿沒有成功（程式檢查沒過：反方要 3 點（送回 2 點）），可以到網站再試一次', 'https://bot.example/?openExternalBrowser=1#/h/MU/thesis']);
  });
});

describe('T56 每檔的草稿狀態（draftStateOf）', () => {
  const acctOf = (o: Partial<Account['own'][string]> = {}, shares = 10) => ({ own: { NVDA: { fileId: 'NVDA@2026-11-19', premises: structuredClone(SYSTEM_DEFAULT_PREMISES), thesis: null, ...o } }, notifs: [], lots: { own: { NVDA: shares }, mom: {}, core: {}, unc: {} } }) as unknown as Account;
  const row = (o: Partial<DraftRow>): DraftRow => ({ id: 1, ticker: 'NVDA', file_id: 'NVDA@2026-11-19', run_id: 'r1', trigger: 'MANUAL', session: '2026-11-19', created_at: '2026-11-20T01:00:00Z', status: 'READY', payload: '{}', based_on_version: 0, broken: null, error: null, settled_at: '2026-11-20T01:10:00Z', updated_at: null, ...o });
  const NOW = new Date('2026-11-21T03:00:00Z');
  it('新的自選、還沒開過 → 明天會自動草擬（沒有持股、雲端排程沒設定、已經有論點都不會）', () => {
    expect(draftStateOf([], acctOf(), 'NVDA', NOW, '2026-11-20', true).autoSoon).toBe(true);
    expect(draftStateOf([], acctOf({}, 0), 'NVDA', NOW, '2026-11-20', true).autoSoon).toBe(false);
    expect(draftStateOf([], acctOf(), 'NVDA', NOW, '2026-11-20', false).autoSoon).toBe(false);
    expect(draftStateOf([], acctOf({ premises: USER_PREMISES }), 'NVDA', NOW, '2026-11-20', true).autoSoon).toBe(false);
    expect(draftStateOf([], acctOf(), 'NVDA', NOW, '2026-11-28', true).autoSoon).toBe(false);
  });
  it('READY：版本不同標 stale；7 天內草擬過 → nextAt；上一份論點檔的草稿不算這一份的', () => {
    const s = draftStateOf([row({})], acctOf({ thesis: { text: 'x', setAt: '2026-11-20', source: 'TYPED', version: 1, afterBreak: 0, lastAfterBreakAt: null } }), 'NVDA', NOW, '2026-11-20', true);
    expect(s.ready).toMatchObject({ id: 1, until: '2026-12-20', basedOn: 0, version: 1, stale: true });
    expect(s.nextAt).toBe(new Date(Date.parse('2026-11-20T01:00:00Z') + DRAFT_GAP_DAYS * 86400_000).toISOString());
    const old = draftStateOf([row({ file_id: 'NVDA@2026-10-01' })], acctOf(), 'NVDA', NOW, '2026-11-20', true);
    expect(old.ready).toBeNull();
    expect(old.last).toBeNull();
  });
  it('最近一次是失敗、過期、用過、不用 → last；失敗的不算進 7 天', () => {
    const f = draftStateOf([row({ status: 'FAILED', error: '逾時' })], acctOf(), 'NVDA', NOW, '2026-11-20', true);
    expect(f.last).toMatchObject({ status: 'FAILED', why: '逾時' });
    expect(f.nextAt).toBeNull();
    expect(draftStateOf([row({ status: 'EXPIRED', created_at: '2026-10-01T00:00:00Z', settled_at: '2026-10-01T00:10:00Z' })], acctOf(), 'NVDA', NOW, '2026-11-20', true).last?.status).toBe('EXPIRED');
  });
});

// ---------------------------------------------------------------- 假的世界（EDGAR、RSS、雲端排程、LINE）

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

interface Net {
  fireDown: boolean;
  lines: string[];
  lineDown: boolean;
}
function fetcherOf(w: World, net: Net): Fetcher {
  const base = fakeFetcher(w);
  return async (url, init) => {
    if (url === 'https://api.example/fire') return net.fireDown ? new Response('quota', { status: 429 }) : Response.json({ claude_code_session_url: 'https://claude.ai/code/x' });
    if (url === LINE_PUSH_URL) {
      if (net.lineDown) return new Response('down', { status: 500 });
      net.lines.push((JSON.parse(String(init?.body)) as { messages: { text: string }[] }).messages[0].text);
      return Response.json({});
    }
    if (/data\.sec\.gov\/submissions\/CIK\d+\.json/.test(url)) return subs();
    if (/companyfacts\/CIK\d+\.json/.test(url)) return Response.json(BASE);
    const doc = /Archives\/edgar\/data\/\d+\/(\d+)\/(.+)$/.exec(url);
    if (doc) return doc[2] === 'index.json' ? Response.json({ directory: { item: [{ name: TENQ.primaryDocument }] } }) : new Response(TENQ_HTML);
    if (url.startsWith('https://www.nasdaq.com/feed/rssoutbound') || url.startsWith('https://feeds.finance.yahoo.com/rss/2.0/headline')) return new Response('<rss><channel><item><title>x</title><link>https://example.com/a</link></item></channel></rss>');
    if (url.startsWith('https://www.micron.com')) return new Response('<html><body>ok</body></html>');
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
  call: <T = Record<string, unknown>>(method: 'GET' | 'POST', path: string, body: unknown, now: Date, auth?: string) => Promise<{ status: number; body: T }>;
}

/** 2026-11-19 建立帳戶、NVDA 是新的自選（論點檔 NVDA@2026-11-19）；LINE 設定好了（推出去的字在 net.lines）。 */
async function withWorld(fn: (c: Ctx) => Promise<void>, opt: { premises?: Premise[] } = {}) {
  const d = await freshDb();
  try {
    const db = d.db;
    const w = newWorld('2026-11-19');
    const net: Net = { fireDown: false, lines: [], lineDown: false };
    const env: Env = { DB: db, ADMIN_TOKEN: 't', AI_TASK_SECRET: 's', EDGAR_USER_AGENT: 'test bot test@example.com', SITE_URL: 'https://bot.example', DEV_NO_AUTH: '1', ROUTINE_FIRE_URL: 'https://api.example/fire', ROUTINE_TOKEN: 'rt', LINE_CHANNEL_TOKEN: 'line', LINE_USER_ID: 'U1' };
    const fetcher = fetcherOf(w, net);
    await runFlow(env, fetcher, { now: cronTime('2026-11-19'), attempt: 'FIRST' });
    const { view, axis } = buildMarketView(await loadSeries(db, ['VOO', 'SGOV', 'NVDA']), '2026-11-19', 'VOO');
    const shares = Math.floor(40_000 / view.close.NVDA[view.i]);
    const acct = createAccount({ paper: true, cash: 5000, core: { VOO: Math.floor(140_000 / view.close.VOO[view.i]) }, own: { NVDA: { shares, stdWeight: 0.15, premises: opt.premises ?? structuredClone(SYSTEM_DEFAULT_PREMISES), buyNote: 'AI 伺服器的需求還在早期' } } }, view);
    await saveAccount(db, acct, null, '建立帳戶', new Date('2026-11-19T22:00:00Z'));
    net.lines = [];
    const call: Ctx['call'] = async (method, path, b, now, auth) => {
      const r = await handle(new Request(`https://bot.example${path}`, { method, headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) }, ...(b === undefined ? {} : { body: JSON.stringify(b) }) }), env, fetcher, now);
      return { status: r.status, body: (await r.json()) as never };
    };
    await fn({ db, env, net, fetcher, view, axis, call });
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
const draftLines = (net: Net) => net.lines.filter((l) => l.includes('論點草稿'));

/** 照證據包的 10-Q 組一份草稿送回；now 要在開執行後 45 分鐘內。 */
async function answer(c: Ctx, runId: string, now: Date, payload: unknown = goodPayload()) {
  const run = (await getRun(c.db, runId))!;
  const q = run.pack.documents.find((d) => d.kind === 'filing')!;
  await c.call('GET', `/ai/task/${run.taskId}/evidence`, undefined, now, 's');
  const sample = { run_id: run.runId, function: OWN_DRAFT, verdict: 'DONE', evidence: evOf(q), payload, report: '草稿：論點靠需求、供給與毛利率。' };
  return c.call('POST', `/ai/task/${run.taskId}/result`, { task_id: run.taskId, kind: 'RUN', run_id: run.runId, samples: [sample], lookups: { questions: [], queries: [], wanted: [] } }, now, 's');
}
/** 使用者按「請 stock bot 草擬」、草稿回來（READY）。 */
async function readyDraft(c: Ctx, now = T0, payload: unknown = goodPayload()) {
  const r = await c.call<{ runId: string }>('POST', '/api/ops/own-draft', { ticker: 'NVDA' }, now);
  expect(r.status).toBe(200);
  expect((await answer(c, r.body.runId, at(now, 0, 10), payload)).status).toBe(200);
  const row = (await draftsOf(c.db))[0];
  expect(row.status).toBe('READY');
  return row;
}
type SaveRes = { ok: boolean; preview: { added: { id: string; text: string; origin: string }[]; draft: (Record<string, unknown> & { used: boolean }) | null; exits: { changed: boolean } }; rewrite: { status: string; runId?: string } };
const save = (c: Ctx, body: Record<string, unknown>, now = at(T0, 0, 20)) => c.call<SaveRes>('POST', '/api/ops/own-thesis', { ticker: 'NVDA', source: 'TYPED', exitConditions: [], ...body }, now);

// ---------------------------------------------------------------- 整個流程（網站 API）

describe('T56 草稿回來、網站讀得到（讀草稿的 API、持股頁、清單的狀態）', () => {
  it('GET /api/own/NVDA/draft：草稿、照的版本、哪天之後不再列；持股頁與 /api/state 帶草稿狀態；要看的事有 DRAFT_READY', async () => {
    await withWorld(async (c) => {
      const before = await c.call<{ draft: null; state: { autoSoon: boolean; aiReady: boolean } }>('GET', '/api/own/NVDA/draft', undefined, T0);
      expect(before.body.draft).toBeNull();
      expect(before.body.state).toMatchObject({ autoSoon: true, aiReady: true });
      const row = await readyDraft(c);
      const g = await c.call<{ draft: DraftView; state: { ready: { id: number } } }>('GET', '/api/own/NVDA/draft', undefined, at(T0, 0, 15));
      expect(g.body.draft).toMatchObject({ id: row.id, trigger: 'MANUAL', basedOn: 0, version: 0, stale: false, broken: null, until: '2026-12-20' });
      expect(g.body.draft.payload.premises.map((p) => p.text)).toEqual([P0, P1, '毛利率維持在 55% 以上']);
      expect(g.body.state.ready.id).toBe(row.id);
      const hd = await c.call<{ own: { draft: { ready: { id: number } } }; attention: { kind: string; text: string }[] }>('GET', '/api/holding/NVDA', undefined, at(T0, 0, 15));
      expect(hd.body.own.draft.ready.id).toBe(row.id);
      expect(hd.body.attention.find((x) => x.kind === 'DRAFT_READY')?.text).toBe('NVDA 的論點草稿好了，等你看（12/20 之後不再列）');
      const st = await c.call<{ drafts: Record<string, { ready: unknown }> }>('GET', '/api/state', undefined, at(T0, 0, 15));
      expect(st.body.drafts.NVDA.ready).toBeTruthy();
    });
  });
});

describe('T56 勾選與存檔（§2.3）', () => {
  it('一條都沒勾就存檔（忘了勾）→ 草稿照舊等你看；前提沒有 AI_DRAFT_ACCEPTED', async () => {
    await withWorld(async (c) => {
      const row = await readyDraft(c);
      const r = await save(c, { thesis: '我自己的論點', premises: [{ text: '我自己的前提' }], draft: { id: row.id, thesis: false, peers: [], domains: [] } });
      expect(r.status).toBe(200);
      expect(r.body.preview.draft).toMatchObject({ used: false });
      expect((await draftsOf(c.db))[0].status).toBe('READY');
      const a = await acctOf(c.db);
      expect(a.own.NVDA.premises.map((p) => p.origin)).toEqual(['USER']);
      expect(a.own.NVDA.thesis?.source).toBe('TYPED');
    });
  });

  it('原樣勾選記 AI_DRAFT_ACCEPTED、改字記 USER；breaks_if 存進 breaksIf；論點一字沒改記 DRAFT；草稿標 USED、log 記用了哪些；只勾一半的預覽列出沒勾的', async () => {
    await withWorld(async (c) => {
      const row = await readyDraft(c);
      const body = {
        thesis: DRAFT_THESIS,
        premises: [
          { text: P0, breaksIf: '連兩季營收年增率低於 15%', draft: 0 },
          { text: 'HBM 的合約價到 2027 年仍然上漲', breaksIf: 'TrendForce 的新聞稿報 HBM 合約價季跌', draft: 1 },
        ],
        draft: { id: row.id, thesis: true, peers: [], domains: [] },
      };
      const dry = await save(c, { ...body, dry: true });
      expect(dry.body.preview.added.map((x) => x.origin)).toEqual(['AI_DRAFT_ACCEPTED', 'USER']);
      expect(dry.body.preview.draft).toMatchObject({ used: true, thesis: 'SAME', premises: { same: 1, edited: 1, kept: 0 }, exits: 0, unused: { premises: 1, exits: 2 }, status: 'READY' });
      expect((await draftsOf(c.db))[0].status).toBe('READY');
      const r = await save(c, body);
      expect(r.status).toBe(200);
      const a = await acctOf(c.db);
      expect(a.own.NVDA.premises).toEqual([
        { id: 'P4', text: P0, origin: 'AI_DRAFT_ACCEPTED', breaksIf: '連兩季營收年增率低於 15%', addedAt: '2026-11-19' },
        { id: 'P5', text: 'HBM 的合約價到 2027 年仍然上漲', origin: 'USER', breaksIf: 'TrendForce 的新聞稿報 HBM 合約價季跌', addedAt: '2026-11-19' },
      ]);
      expect(a.own.NVDA.thesis).toMatchObject({ text: DRAFT_THESIS, source: 'DRAFT', version: 1, afterBreak: 0 });
      const after = (await draftsOf(c.db))[0];
      expect(after.status).toBe('USED');
      expect(JSON.parse(after.used_json!)).toMatchObject({ id: row.id, version: 1, thesis: 'SAME', premises: { same: 1, edited: 1, kept: 0 } });
      const log = (await c.db.prepare("SELECT body FROM own_thesis_log WHERE kind = 'THESIS'").all<{ body: string }>()).results.map((x) => JSON.parse(x.body));
      expect(log.at(-1)).toMatchObject({ source: 'DRAFT', draft: { id: row.id, thesis: 'SAME' } });
      // 用過的草稿不再列在要看的事、編輯論點頁讀不到
      const hd = await c.call<{ attention: { kind: string }[]; own: { thesis: { source: string } } }>('GET', '/api/holding/NVDA', undefined, at(T0, 0, 30));
      expect(hd.body.attention.some((x) => x.kind === 'DRAFT_READY')).toBe(false);
      expect(hd.body.own.thesis.source).toBe('用了 stock bot 的草稿');
      expect((await c.call<{ draft: unknown }>('GET', '/api/own/NVDA/draft', undefined, at(T0, 0, 30))).body.draft).toBeNull();
      // 審查的證據包看不到題目是誰出的：前提寫成 USER
      const { ownPremises } = await import('../src/ai/pack');
      expect(ownPremises(a, 'NVDA').map((p) => p.origin)).toEqual(['USER', 'USER']);
    });
  });

  it('出場條件勾了也不會直接監測：存檔後送去改寫（一票），沒有任何條件開始監測，要回持股頁確認', async () => {
    await withWorld(async (c) => {
      const row = await readyDraft(c);
      const r = await save(c, { thesis: '', premises: [{ text: P0, draft: 0 }], exitConditions: [{ text: X0, action: 'HALF', draft: 0 }], draft: { id: row.id, thesis: false, peers: [0], domains: [] }, webSources: { peers: [{ name: 'SK hynix', yahoo: '000660.KS' }], domains: [] } });
      expect(r.status).toBe(200);
      expect(r.body.preview.exits.changed).toBe(true);
      expect(r.body.rewrite.status).toBe('SENT');
      const run = (await getRun(c.db, r.body.rewrite.runId!))!;
      expect(run.fn).toBe('OWN_CHECK');
      expect(JSON.stringify(run.pack)).toContain(X0);
      expect((await c.db.prepare("SELECT COUNT(*) AS n FROM own_conditions WHERE ticker = 'NVDA' AND status IN ('ACTIVE', 'REVIEW_ONLY', 'MANUAL')").first<{ n: number }>())!.n).toBe(0);
      expect(JSON.parse((await draftsOf(c.db))[0].used_json!)).toMatchObject({ exits: 1, peers: 1 });
      expect((await acctOf(c.db)).own.NVDA.webSources?.peers).toEqual([{ name: 'SK hynix', yahoo: '000660.KS' }]);
    });
  });

  it('「不用這份草稿」→ DISMISSED；再按一次 409；不再列在要看的事', async () => {
    await withWorld(async (c) => {
      const row = await readyDraft(c);
      expect((await c.call('POST', '/api/ops/own-draft/dismiss', { ticker: 'NVDA', id: row.id }, at(T0, 0, 20))).status).toBe(200);
      expect((await draftsOf(c.db))[0].status).toBe('DISMISSED');
      expect((await c.call('POST', '/api/ops/own-draft/dismiss', { ticker: 'NVDA', id: row.id }, at(T0, 0, 21))).status).toBe(409);
      const hd = await c.call<{ attention: { kind: string }[]; own: { draft: { ready: unknown; last: { status: string } } } }>('GET', '/api/holding/NVDA', undefined, at(T0, 0, 22));
      expect(hd.body.attention.some((x) => x.kind === 'DRAFT_READY')).toBe(false);
      expect(hd.body.own.draft).toMatchObject({ ready: null, last: { status: 'DISMISSED' } });
    });
  });

  it('草稿回來前自己先寫了論點 → 草稿標「照第 0 版寫的」；勾了照樣存', async () => {
    await withWorld(async (c) => {
      const r = await c.call<{ runId: string }>('POST', '/api/ops/own-draft', { ticker: 'NVDA' }, T0);
      expect((await save(c, { thesis: '我等不及自己先寫了', premises: [{ text: '我自己的前提' }] }, at(T0, 0, 5))).status).toBe(200);
      await answer(c, r.body.runId, at(T0, 0, 10));
      const g = await c.call<{ draft: DraftView }>('GET', '/api/own/NVDA/draft', undefined, at(T0, 0, 15));
      expect(g.body.draft).toMatchObject({ basedOn: 0, version: 1, stale: true });
      expect(draftNotices(g.body.draft)[0].text).toContain('這份草稿是在你還沒有論點的時候寫的，之後你自己存了論點（現在第 1 版）');
      const s = await save(c, { thesis: '我等不及自己先寫了', premises: [{ id: 'P4', text: '我自己的前提' }, { text: P0, draft: 0 }], draft: { id: g.body.draft.id, thesis: false, peers: [], domains: [] } }, at(T0, 0, 20));
      expect(s.status).toBe(200);
      expect((await acctOf(c.db)).own.NVDA.premises.map((p) => [p.id, p.origin])).toEqual([
        ['P4', 'USER'],
        ['P5', 'AI_DRAFT_ACCEPTED'],
      ]);
    });
  });

  it('草稿過期（30 天沒處理）→ 編輯論點頁讀不到、狀態寫過期；頁面開著時過期了，存檔照樣用勾的、標成 USED', async () => {
    await withWorld(async (c) => {
      const row = await readyDraft(c);
      expect(await expireDrafts(c.db, at(T0, 31))).toBe(1);
      const g = await c.call<{ draft: null; state: { last: { status: string } } }>('GET', '/api/own/NVDA/draft', undefined, at(T0, 31));
      expect(g.body.draft).toBeNull();
      expect(g.body.state.last.status).toBe('EXPIRED');
      expect(draftButtonState(g.body.state as never, at(T0, 31)).text).toBe('上一份草稿（11/20）30 天沒處理，已經過期');
      const s = await save(c, { thesis: '', premises: [{ text: P0, draft: 0 }], draft: { id: row.id, thesis: false, peers: [], domains: [] } }, at(T0, 31, 5));
      expect(s.body.preview.draft).toMatchObject({ used: true, status: 'EXPIRED' });
      expect((await draftsOf(c.db))[0].status).toBe('USED');
      expect((await acctOf(c.db)).own.NVDA.premises[0].origin).toBe('AI_DRAFT_ACCEPTED');
    });
  });

  it('上一份論點檔的草稿（賣光又買回之後）不能用在這一份 → 409', async () => {
    await withWorld(async (c) => {
      const row = await readyDraft(c);
      await c.db.prepare('UPDATE own_drafts SET file_id = ? WHERE id = ?').bind('NVDA@2026-10-01', row.id).run();
      expect((await save(c, { thesis: '', premises: [{ text: P0, draft: 0 }], draft: { id: row.id, thesis: false, peers: [], domains: [] } })).status).toBe(409);
      expect((await c.call<{ draft: unknown }>('GET', '/api/own/NVDA/draft', undefined, at(T0, 0, 20))).body.draft).toBeNull();
    });
  });
});

describe('T56 剛被判不成立之後的草稿：「失效後修改」計次（§2.4 第 6 點）', () => {
  it('用了這份草稿存檔 → 失效後修改加 1（沒勾回應時那則通知仍等你決定）；一條都沒用 → 不算；勾了回應也只算一次', async () => {
    await withWorld(
      async (c) => {
        await mutate(c.db, (a) => routeReview(a, c.view, 'NVDA', { tier: 'HALF', suggest: true, consensus: true, premiseId: 'P2', trigger: 'EARNINGS', date: '2026-11-19' }).acct);
        const row = await readyDraft(c);
        const g = await c.call<{ draft: DraftView }>('GET', '/api/own/NVDA/draft', undefined, at(T0, 0, 15));
        expect(g.body.draft.broken).toMatchObject({ premiseId: 'P2', open: true });
        const notif = g.body.draft.broken!.notif;
        // 沒用到草稿：不算
        await save(c, { thesis: '先改一個字', premises: [{ id: 'P1', text: '資料中心需求延續到 2027' }, { id: 'P2', text: 'HBM 供給持續吃緊' }], draft: { id: row.id, thesis: false, peers: [], domains: [] } });
        expect((await acctOf(c.db)).own.NVDA.thesis?.afterBreak).toBe(0);
        // 用了：算一次，通知還在
        const dry = await save(c, { thesis: '先改一個字', premises: [{ id: 'P1', text: '資料中心需求延續到 2027' }, { text: P0, draft: 0 }], draft: { id: row.id, thesis: false, peers: [], domains: [] }, dry: true }, at(T0, 0, 25));
        expect(dry.body.preview.draft).toMatchObject({ afterBreak: true, afterBreakNo: 1, premiseId: 'P2', brokenOpen: true });
        await save(c, { thesis: '先改一個字', premises: [{ id: 'P1', text: '資料中心需求延續到 2027' }, { text: P0, draft: 0 }], draft: { id: row.id, thesis: false, peers: [], domains: [] } }, at(T0, 0, 26));
        const a = await acctOf(c.db);
        expect(a.own.NVDA.thesis).toMatchObject({ afterBreak: 1, lastAfterBreakAt: '2026-11-19' });
        expect(a.notifs.find((n) => n.id === notif)?.status).toBe('PENDING');
        const log = (await c.db.prepare("SELECT body FROM own_thesis_log WHERE kind = 'THESIS' ORDER BY id").all<{ body: string }>()).results.map((x) => JSON.parse(x.body));
        expect(log.at(-1)).toMatchObject({ afterBreak: true, draft: { afterBreak: true } });
      },
      { premises: USER_PREMISES },
    );
  });

  it('同時勾著「這是對通知的回應」→ 修正論點結案，失效後修改只加 1', async () => {
    await withWorld(
      async (c) => {
        await mutate(c.db, (a) => routeReview(a, c.view, 'NVDA', { tier: 'HALF', suggest: true, consensus: true, premiseId: 'P2', trigger: 'EARNINGS', date: '2026-11-19' }).acct);
        const row = await readyDraft(c);
        const notif = JSON.parse(row.broken!).notif as number;
        const r = await save(c, { thesis: '', premises: [{ id: 'P1', text: '資料中心需求延續到 2027' }, { text: P0, draft: 0 }], replyTo: notif, draft: { id: row.id, thesis: false, peers: [], domains: [] } });
        expect(r.status).toBe(200);
        const a = await acctOf(c.db);
        expect(a.own.NVDA.thesis?.afterBreak).toBe(1);
        expect(a.notifs.find((n) => n.id === notif)?.status).toBe('DONE');
      },
      { premises: USER_PREMISES },
    );
  });
});

describe('T56 LINE 一行（§2.5）：使用者按的才推、只推一次', () => {
  it('使用者按的草稿回來 → 推一則（一行加連結）；再結算、每日流程推播都不會重推', async () => {
    await withWorld(async (c) => {
      await readyDraft(c);
      expect(draftLines(c.net)).toEqual(['【紙上】NVDA 的論點草稿好了：先看反方，再逐條勾你同意的，沒勾的不會生效（12/20 之後不再列）\nhttps://bot.example/?openExternalBrowser=1#/h/NVDA/thesis']);
      await pushDraftLines(c.env, c.fetcher, at(T0, 0, 30));
      await pushPending(c.env, c.fetcher, at(T0, 0, 40), await acctOf(c.db), [], false);
      expect(draftLines(c.net)).toHaveLength(1);
      expect((await c.db.prepare("SELECT COUNT(*) AS n FROM pushes WHERE kind = 'DRAFT' AND ok = 1").first<{ n: number }>())!.n).toBe(1);
    });
  });

  it('自動開的回來 → 不推（月報的「要看的事」會算到）', async () => {
    await withWorld(async (c) => {
      const run = await startOwnDraft(c.env, c.fetcher, await acctOf(c.db), c.view, c.axis, 'NVDA', 'AUTO', T0);
      await answer(c, run.runId, at(T0, 0, 10));
      expect((await draftsOf(c.db))[0]).toMatchObject({ trigger: 'AUTO', status: 'READY' });
      expect(draftLines(c.net)).toEqual([]);
    });
  });

  it('使用者按的草稿沒有成功（程式檢查沒過、逾時）→ 推原因；逾時的在每日流程推播時推；推失敗下一次重推', async () => {
    await withWorld(async (c) => {
      const r1 = await c.call<{ runId: string }>('POST', '/api/ops/own-draft', { ticker: 'NVDA' }, T0);
      await answer(c, r1.body.runId, at(T0, 0, 10), { ...goodPayload(), against: [] });
      expect(draftLines(c.net)).toHaveLength(1);
      expect(draftLines(c.net)[0]).toMatch(/^【紙上】NVDA 的論點草稿沒有成功（程式檢查沒過：反方要 3 點（送回 0 點）.*），可以到網站再試一次\n/);
      // 再按一次（失敗的不算 7 天），這次逾時；LINE 當下壞了 → 下一次流程重推
      const r2 = await c.call<{ runId: string }>('POST', '/api/ops/own-draft', { ticker: 'NVDA' }, at(T0, 0, 20));
      expect(r2.status).toBe(200);
      c.net.lineDown = true;
      await c.call('GET', '/api/state', undefined, at(T0, 0, 80));
      expect((await draftsOf(c.db))[0]).toMatchObject({ status: 'FAILED' });
      await pushPending(c.env, c.fetcher, at(T0, 0, 90), await acctOf(c.db), [], false);
      expect(draftLines(c.net)).toHaveLength(1);
      c.net.lineDown = false;
      await pushPending(c.env, c.fetcher, at(T0, 0, 200), await acctOf(c.db), [], false);
      expect(draftLines(c.net)).toHaveLength(2);
      expect(draftLines(c.net)[1]).toContain('超過 45 分鐘沒有收到結果');
    });
  });

  it('失敗之後又按了一次：舊的失敗不推（SKIP）', async () => {
    await withWorld(async (c) => {
      c.net.lineDown = true;
      const r1 = await c.call<{ runId: string }>('POST', '/api/ops/own-draft', { ticker: 'NVDA' }, T0);
      await answer(c, r1.body.runId, at(T0, 0, 10), { ...goodPayload(), against: [] });
      c.net.lineDown = false;
      await c.call('POST', '/api/ops/own-draft', { ticker: 'NVDA' }, at(T0, 0, 20));
      await pushDraftLines(c.env, c.fetcher, at(T0, 0, 25));
      expect(draftLines(c.net)).toEqual([]);
      expect((await draftsOf(c.db)).map((d) => [d.status, d.pushed_at])).toEqual([
        ['PENDING', null],
        ['FAILED', 'SKIP'],
      ]);
    });
  });
});

describe('T56 按鈕：防連按、當場失敗、示範模式', () => {
  it('同一檔同時按兩次（兩個分頁）→ 只開一次，另一個 409；同一檔同時只能有一列 PENDING', async () => {
    await withWorld(async (c) => {
      const acct = await acctOf(c.db);
      const rs = await Promise.allSettled([requestOwnDraft(c.env, c.fetcher, acct, c.view, c.axis, 'NVDA', T0), requestOwnDraft(c.env, c.fetcher, acct, c.view, c.axis, 'NVDA', T0)]);
      expect(rs.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const bad = rs.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(bad.reason).toBeInstanceOf(DraftError);
      expect((bad.reason as DraftError).status).toBe(409);
      expect((await draftsOf(c.db)).filter((d) => d.status === 'PENDING')).toHaveLength(1);
      expect((await c.db.prepare("SELECT COUNT(*) AS n FROM ai_runs WHERE fn = 'OWN_DRAFT'").first<{ n: number }>())!.n).toBe(1);
      await expect(c.db.prepare("INSERT INTO own_drafts (ticker, run_id, trigger, session, created_at, status) VALUES ('NVDA', 'x', 'MANUAL', '2026-11-19', '2026-11-20', 'PENDING')").run()).rejects.toThrow(/UNIQUE/);
    });
  });

  it('按下去當場就沒有開成（雲端排程沒有觸發）→ 503 與原因（網站寫「再試一次」），不推 LINE；失敗的可以馬上再按', async () => {
    await withWorld(async (c) => {
      c.net.fireDown = true;
      const r = await c.call<{ error: string }>('POST', '/api/ops/own-draft', { ticker: 'NVDA' }, T0);
      expect(r.status).toBe(503);
      expect(r.body.error).toMatch(/^沒有開成：雲端排程沒有觸發成功.*失敗的不算在 7 天一次裡，可以再試一次$/);
      expect((await draftsOf(c.db))[0]).toMatchObject({ status: 'FAILED', pushed_at: 'SYNC' });
      await pushDraftLines(c.env, c.fetcher, at(T0, 0, 5));
      expect(draftLines(c.net)).toEqual([]);
      c.net.fireDown = false;
      const again = await c.call<{ state: { pending: unknown } }>('POST', '/api/ops/own-draft', { ticker: 'NVDA' }, at(T0, 0, 1));
      expect(again.status).toBe(200);
      expect(again.body.state.pending).toBeTruthy();
    });
  });

  it('示範模式：讀草稿是空的、按了 400、存檔帶草稿 409', async () => {
    await withWorld(async (c) => {
      expect((await c.call<{ draft: null; state: null }>('GET', '/demo/api/own/MSFT/draft', undefined, T0)).body).toEqual({ draft: null, state: null });
      expect((await c.call('POST', '/demo/api/ops/own-draft', { ticker: 'MSFT' }, T0)).status).toBe(400);
      expect((await c.call('POST', '/demo/api/ops/own-thesis', { ticker: 'MSFT', thesis: 'x', premises: [{ text: 'y' }], exitConditions: [], source: 'TYPED', draft: { id: 1 } }, T0)).status).toBe(409);
    });
  });
});

describe('T56 各入口：新的自選、要看的事', () => {
  it('新加進自選（快照）→ 回應帶這幾檔的草稿狀態（明天早上會自動草擬）；/api/state 帶每檔的狀態', async () => {
    await withWorld(async (c) => {
      const st = await c.call<{ drafts: Record<string, { autoSoon: boolean }> }>('GET', '/api/state', undefined, T0);
      expect(st.body.drafts.NVDA.autoSoon).toBe(true);
      // 已經有論點就不會自動草擬
      await mutate(c.db, (a) => setThesis(a, 'NVDA', { text: '我自己的論點', source: 'TYPED', premises: [{ text: '我的前提' }], date: '2026-11-19' }).acct);
      const st2 = await c.call<{ drafts: Record<string, { autoSoon: boolean }> }>('GET', '/api/state', undefined, T0);
      expect(st2.body.drafts.NVDA.autoSoon).toBe(false);
    });
  });
});
