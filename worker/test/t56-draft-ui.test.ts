// T56：草稿的畫面與同意流程（web_evidence_design §2.3、§2.5、§2.6）。
// 完成條件：
//   （T70，confirm_audit_design §2 改掉：逐條勾選、預設不勾、出場條件過兩關 → 一鍵採用，測試在 t70-draft-adopt.test.ts；
//    這裡關於勾選與存檔的測試拿掉或改成採用）
//   草稿過期與版本不同的提示
//   DRAFT_READY（要看的事）、LINE 一行（使用者按的才推）
//   USED／DISMISSED 的寫入、「失效後修改」計次、按鈕防連按（同一檔同時只能有一列 PENDING）、各入口的按鈕狀態
// check.ts 沒有動；AI 的回覆一律是假的；對外請求全部是假的（EDGAR、RSS、雲端排程、LINE）。
import { describe, expect, it } from 'vitest';
import { judge, type PackDoc } from '../src/ai/check';
import { PAYLOAD_HOOKS } from '../src/ai/hooks';
import { OWN_DRAFT, draftResult, ownDraftPack, brokenNotice, type OwnDraft } from '../src/ai/ownDraft';
import { packOrigin, packPremise } from '../src/ai/pack';
import { getRun } from '../src/app/aiRuns';
import type { Env, Fetcher } from '../src/app/env';
import { pushPending, runFlow } from '../src/app/flow';
import { loadAccount, saveAccount } from '../src/app/ledgerStore';
import { LINE_PUSH_URL } from '../src/app/line';
import { DRAFT_GAP_DAYS, DraftError, draftLineText, draftStateOf, expireDrafts, loadDrafts, pushDraftLines, requestOwnDraft, startOwnDraft, type DraftRow, type DraftView } from '../src/app/ownDraft';
import { OWN_ATTN, thesisNote, type ThesisFile } from '../src/app/thesis';
import { XBRL_METRICS, type CompanyFacts, type XbrlFact } from '../src/data/edgar';
import { buildMarketView } from '../src/data/marketView';
import { loadSeries } from '../src/data/store';
import { SYSTEM_DEFAULT_PREMISES, createAccount, mapPremises, setThesis, type Account, type MarketView, type Premise } from '../src/engine';
import { handle } from '../src/index';
import { freshDb } from './helpers/d1';
import { cronTime, fakeFetcher, newWorld, type World } from './helpers/fakeSources';

const METRICS = new Set(Object.keys(XBRL_METRICS));

// 前端的 thesis-draft.js 不碰 DOM，直接 import（同 t39b、t44 的寫法：瀏覽器直接載入的 JS 沒有型別宣告）
type Item = { k: number; [x: string]: unknown };
interface DraftJs {
  ACTION_TEXT: Record<string, string>;
  NOT_CHECKABLE: string;
  BELIEF_TEXT: string;
  checkLine(it: Item): { ok: boolean; belief: boolean; text: string };
  draftButtonState(state: unknown, now?: Date): { mode: string; button: string | null; text: string | null };
  draftItems(p: unknown): { premises: Item[]; exits: Item[]; peers: Item[]; domains: Item[] };
  draftNotices(d: unknown): { tone: string; text: string }[];
}
const { ACTION_TEXT, BELIEF_TEXT, checkLine, draftButtonState, draftItems, draftNotices } = (await import('../public/js/thesis-draft.js' as string)) as DraftJs;

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
const C0 = '10-Q 的營收年增率仍高於 30%';
const C1 = 'TrendForce 最新一季的 HBM 合約價預估仍是季漲';
function goodPayload(): Record<string, unknown> {
  return {
    thesis: DRAFT_THESIS,
    premises: [
      // T60（composite_layer_design §2.2、§2.3）：前提多 confirms_if、verify，breaks_if 是 1～3 句；第 3 條是信念（verify.by = NONE）
      { text: P0, keep_id: null, confirms_if: C0, breaks_if: ['連兩季營收年增率低於 15%'], verify: { by: 'XBRL' }, evidence_ids: ['E2'] },
      { text: P1, keep_id: null, confirms_if: C1, breaks_if: ['TrendForce 的新聞稿報 HBM 合約價季跌'], verify: { by: 'WEB', source: 'trendforce.com' }, evidence_ids: [] },
      { text: '毛利率維持在 55% 以上', keep_id: null, confirms_if: null, breaks_if: ['毛利率連兩季低於 55%'], verify: { by: 'NONE' }, evidence_ids: ['E1'] },
    ],
    exits: [
      { text: X0, action: 'HALF', kind: 'XBRL', check: { type: 'xbrl_metric_below', metric: 'GrossMarginPct', level: 0.55, quarters: 2 }, premise_index: 2, evidence_ids: ['E1'] },
      { text: '公司在 8-K 宣布下修本季營收財測', action: 'REVIEW', kind: 'EVENT', check: { type: 'event', confirm_by: ['8-K'] }, premise_index: null, evidence_ids: [] },
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
  const pack = ownDraftPack({ runId: 'r', asOf: '2026-11-19', ticker: 'NVDA', trigger: 'MANUAL', held: true, premises: premises.map(packPremise), facts: [], docs: [doc], dataQuality: {}, thesisVersion: 1, fileId: 'NVDA@2026-11-19', broken: null, webDomains: ['trendforce.com'], now: new Date('2026-11-20T01:00:00Z') }).pack;
  const out = judge(pack, [{ run_id: 'r', function: OWN_DRAFT, verdict: 'DONE', evidence: evOf(doc), payload, report: '草稿。' }], PAYLOAD_HOOKS[OWN_DRAFT]);
  const r = draftResult(out, pack, METRICS)!;
  if (!r.ok) throw new Error(r.why);
  return r.draft;
}
const viewOf = (d: OwnDraft, o: Partial<DraftView> = {}): DraftView => ({ id: 7, runId: 'run-7', trigger: 'MANUAL', createdAt: '2026-11-20T01:00:00Z', at: '2026-11-20T01:10:00Z', until: '2026-12-20', basedOn: 1, version: 1, stale: false, broken: null, payload: d, ...o });

// ---------------------------------------------------------------- 純函式：畫面上的文字與預設

// T70 改（confirm_audit_design §2.1）：草稿只顯示，沒有勾選框（原本是「每一項預設都不勾」）
describe('T56 草稿的每一項（T70 起只顯示）', () => {
  it('前提、出場條件、同業、網站都讀得出來、沒有勾選的狀態；網站都不能加（T68：每檔的網站不再讀，confirm_audit_design §1.7）', () => {
    // T69：新的草稿不再有 domains（§2.3）；這裡模擬 T69 以前存的舊草稿（有 domains），畫面照樣讀得出來
    const old = okDraft();
    old.sources.domains = [
      { domain: 'www.micron.com', state: 'NEW', note: '新的來源，存檔前會先試抓' },
      { domain: 'fool.com', state: 'EXCLUDED', note: '不列入的網站（評論、預測、社群）：加不進來' },
    ];
    expect(draftItems(okDraft()).domains).toEqual([]);
    const items = draftItems(old);
    const all = [...items.premises, ...items.exits, ...items.peers, ...items.domains];
    expect(all.length).toBe(3 + 2 + 1 + 2);
    expect(all.every((x) => !('checked' in x))).toBe(true);
    expect(items.domains.map((x) => [x.domain, x.state, x.checkable])).toEqual([
      ['www.micron.com', 'NEW', false],
      ['fool.com', 'EXCLUDED', false],
    ]);
  });

  // T60 改（composite_layer_design §2.3）：NONE 是信念，寫「這一條查不到，是你選擇相信的」，不再是紅字「stock bot 監測不了這一條」
  it('每條前提寫查得到的來源；NONE 寫信念；出場條件的動作是白話', () => {
    const items = draftItems(okDraft());
    expect(checkLine(items.premises[0])).toEqual({ ok: true, belief: false, text: '查得到：財報數字（程式比對）' });
    expect(checkLine(items.premises[1])).toEqual({ ok: true, belief: false, text: '查得到：清單內的網站（trendforce.com）' });
    expect(checkLine(items.premises[2])).toEqual({ ok: true, belief: true, text: BELIEF_TEXT });
    expect(ACTION_TEXT[items.exits[0].action as string]).toBe('減半');
    expect(items.exits[0].threshold).toBe(true);
  });

});

describe('T56 草稿的提示：過期日、版本不同、剛被判不成立（§2.3、§2.4 第 6 點）', () => {
  it('照的論點版本和現在不同 → 「這份草稿是照第 N 版寫的，之後你改過論點」；還沒有論點時寫的另一種說法', () => {
    const d = okDraft();
    expect(draftNotices(viewOf(d, { basedOn: 2, version: 3, stale: true })).map((x) => x.text)).toContain('這份草稿是照第 2 版論點寫的，之後你改過論點（現在第 3 版）。左邊「現在的」才是你現在的論點；按「採用」之後會先列出哪幾條會被換掉。');
    expect(draftNotices(viewOf(d, { basedOn: 0, version: 1, stale: true }))[0].text).toBe('這份草稿是在你還沒有論點的時候寫的，之後你自己存了論點（現在第 1 版）。按「採用」之後會先列出哪幾條會被換掉。');
    const plain = draftNotices(viewOf(d));
    expect(plain).toHaveLength(1);
    expect(plain[0].text).toBe('你在 11/20 請 stock bot 草擬的；12/20 之後不再列（30 天沒處理就過期）。採用就是整份照草稿存（論點、前提、出場條件、同業），出場條件採用後直接生效；之後要改字，在這一頁照平常的方式改。');
  });

  it('剛被判不成立 → 最上面固定那句話（紅字），寫明不能沿用、採用算一次失效後修改；那則通知還沒回覆時提醒回去', () => {
    const n = draftNotices(viewOf(okDraft(), { broken: { premiseId: 'P2', text: 'HBM 供給持續吃緊', notif: 3, notice: brokenNotice('P2'), open: true } }));
    expect(n[0]).toEqual({ tone: 'hot', text: '前提 P2 剛被判不成立。在這之後改論點，很容易只是替繼續持有找新理由。' });
    expect(n[1].text).toContain('這份草稿不能沿用 P2；採用這份草稿算一次「失效後修改」。那則通知還等你決定');
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
      // T60：存成子句的陣列（送一段字當成一句）
      { id: 'P1', text: '資料中心需求延續到 2027', origin: 'USER', addedAt: '2026-11-01', breaksIf: ['連兩季營收年增率低於 15%'] },
      { id: 'P4', text: 'HBM 長約有價格保護', origin: 'AI_DRAFT_ACCEPTED', addedAt: '2026-11-02' },
      { id: 'P6', text: P0, origin: 'AI_DRAFT_ACCEPTED', breaksIf: ['連兩季營收年增率低於 15%'], addedAt: '2026-11-21' },
      { id: 'P7', text: P1, origin: 'USER', addedAt: '2026-11-21' },
    ]);
  });
  it('原樣勾選的草稿前提之後被你改了字 → 來源改成 USER；只改標點不算', () => {
    expect(mapPremises(meta, [{ id: 'P4', text: 'HBM 長約有價格保護，到 2028' }], '2026-11-21').premises[0].origin).toBe('USER');
    expect(mapPremises(meta, [{ id: 'P4', text: 'HBM 長約，有價格保護。' }], '2026-11-21').premises[0]).toMatchObject({ origin: 'AI_DRAFT_ACCEPTED', breaksIf: '合約價季跌' });
  });
});

describe('T56 判的人看不到出題的過程（§2.4 第 4 點）', () => {
  it('證據包裡原樣採用的草稿前提寫成 USER，系統預設照舊；論點那一份 note 不寫 DRAFT 的來源', () => {
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
    expect(draftLineText(row, true, 'https://bot.example')).toBe('【紙上】MU 的論點草稿好了：先看反方的三點，再決定要不要整份採用（12/20 之後不再列）\nhttps://bot.example/?openExternalBrowser=1#/h/MU/thesis');
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

// T70 改：勾選與存檔換成一鍵採用（POST /api/ops/own-draft/adopt）；勾選的三個測試拿掉，採用的測試在 t70-draft-adopt.test.ts
describe('T56 存檔與草稿的狀態（§2.3）', () => {
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

  it('草稿回來前自己先寫了論點 → 草稿標「照第 0 版寫的」；採用照樣存（整份換成草稿的，你寫的那條撤下）', async () => {
    await withWorld(async (c) => {
      const r = await c.call<{ runId: string }>('POST', '/api/ops/own-draft', { ticker: 'NVDA' }, T0);
      expect((await save(c, { thesis: '我等不及自己先寫了', premises: [{ text: '我自己的前提' }] }, at(T0, 0, 5))).status).toBe(200);
      await answer(c, r.body.runId, at(T0, 0, 10));
      const g = await c.call<{ draft: DraftView }>('GET', '/api/own/NVDA/draft', undefined, at(T0, 0, 15));
      expect(g.body.draft).toMatchObject({ basedOn: 0, version: 1, stale: true });
      expect(draftNotices(g.body.draft)[0].text).toContain('這份草稿是在你還沒有論點的時候寫的，之後你自己存了論點（現在第 1 版）');
      const s = await c.call<{ preview: { retired: { id: string }[] } }>('POST', '/api/ops/own-draft/adopt', { ticker: 'NVDA', id: g.body.draft.id }, at(T0, 0, 20));
      expect(s.status).toBe(200);
      expect(s.body.preview.retired.map((x) => x.id)).toEqual(['P4']);
      expect((await acctOf(c.db)).own.NVDA.premises.map((p) => [p.id, p.origin])).toEqual([
        ['P5', 'AI_DRAFT_ACCEPTED'],
        ['P6', 'AI_DRAFT_ACCEPTED'],
        ['P7', 'AI_DRAFT_ACCEPTED'],
      ]);
    });
  });

  it('草稿過期（30 天沒處理）→ 編輯論點頁讀不到、狀態寫過期；頁面開著時過期了，採用 → 409（T70：只有還在等你看的可以採用）', async () => {
    await withWorld(async (c) => {
      const row = await readyDraft(c);
      expect(await expireDrafts(c.db, at(T0, 31))).toBe(1);
      const g = await c.call<{ draft: null; state: { last: { status: string } } }>('GET', '/api/own/NVDA/draft', undefined, at(T0, 31));
      expect(g.body.draft).toBeNull();
      expect(g.body.state.last.status).toBe('EXPIRED');
      expect(draftButtonState(g.body.state as never, at(T0, 31)).text).toBe('上一份草稿（11/20）30 天沒處理，已經過期');
      const s = await c.call<{ error: string }>('POST', '/api/ops/own-draft/adopt', { ticker: 'NVDA', id: row.id }, at(T0, 31, 5));
      expect(s.status).toBe(409);
      expect(s.body.error).toContain('過期了');
      expect((await draftsOf(c.db))[0].status).toBe('EXPIRED');
      expect((await acctOf(c.db)).own.NVDA.premises.every((p) => p.origin === 'SYSTEM_DEFAULT')).toBe(true);
    });
  });

  it('上一份論點檔的草稿（賣光又買回之後）不能用在這一份 → 409', async () => {
    await withWorld(async (c) => {
      const row = await readyDraft(c);
      await c.db.prepare('UPDATE own_drafts SET file_id = ? WHERE id = ?').bind('NVDA@2026-10-01', row.id).run();
      expect((await c.call('POST', '/api/ops/own-draft/adopt', { ticker: 'NVDA', id: row.id }, at(T0, 0, 20))).status).toBe(409);
      expect((await c.call<{ draft: unknown }>('GET', '/api/own/NVDA/draft', undefined, at(T0, 0, 20))).body.draft).toBeNull();
    });
  });
});

// T70：剛被判不成立之後的草稿「失效後修改」計次改成採用時算，測試在 t70-draft-adopt.test.ts（原本這裡是勾選存檔的兩個測試）

describe('T56 LINE 一行（§2.5）：使用者按的才推、只推一次', () => {
  it('使用者按的草稿回來 → 推一則（一行加連結）；再結算、每日流程推播都不會重推', async () => {
    await withWorld(async (c) => {
      await readyDraft(c);
      expect(draftLines(c.net)).toEqual(['【紙上】NVDA 的論點草稿好了：先看反方的三點，再決定要不要整份採用（12/20 之後不再列）\nhttps://bot.example/?openExternalBrowser=1#/h/NVDA/thesis']);
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
