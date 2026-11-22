// T31b：減半檢視與慢規則通知（own_thesis §3.2～§3.5、§1.9 表裡和慢規則通知有關的三列；問題 K1～K5）。
// 完成條件：
//   K1～K5 各一個重現再修好的測試
//   五種結果的條件；「不動」的程式核對（個股自身的跌幅超過整段的一半 → 沒有可用的結論）；只有預設前提的股票不會出現「不動」
//   PENDING 時第一次不推、第二次推，沒開成的當場推；第三次補推；回覆之後才回來的出清照 §1.9
//   理由沒寫送不出去；靜默期；乙類併入；加回的「照 AI」
// 重放驗收不變由 test/replay.test.ts 鎖住（這個任務沒有動規則引擎的參數與狀態機）。
//
// T82（階段十二，allocation_redesign §3.1、§3.2）之後這份測試鎖住兩件事：
//   ① 只有預設前提的股票「完全照舊」：引擎那幾段（那一行與選項、理由、靜默期、紀錄、推播）把情境裡的 MU 改成只有系統預設前提來跑；
//      「建議不動」（HOLD）已經沒有任何股票會產生（只有預設前提的本來就不能選，有論點的改成新的效力表），相關的斷言拿掉或換成還存在的狀態。
//   ② 有論點的股票的整條流程（NVDA）：照新的效力表改——-20% 只觸發審查，預設不動；三票判同一條前提不成立才減半。
// 新行為自己的測試（審查後持有、再跌一級、自動結案、重派、快照…）在 test/t82-watch.test.ts。
// 對外請求全部是假的：價格、成分股（固定檔）、EDGAR、Nasdaq RSS、雲端排程、LINE。
import { describe, expect, it } from 'vitest';
import { judge, type EvidencePack, type PackDoc } from '../src/ai/check';
import { OWN_DROP, OWN_DROP_PROMPT, dropDecision, idioWithinHalf, ownDropPack } from '../src/ai/drops';
import { PAYLOAD_HOOKS } from '../src/ai/hooks';
import { getRun } from '../src/app/aiRuns';
import { loadAccount, saveAccount } from '../src/app/ledgerStore';
import { DROP_LINE, notifText } from '../src/app/line';
import { PUSH_WAITERS, dropFollowUpText, dropWaiter, pushWaiting } from '../src/app/pushHold';
import { SCHEDULE } from '../src/app/schedule';
import { breakLogs, ruleBreakLogs, ruleResponseLogs, withRuleKeys } from '../src/app/thesis';
import {
  DEFAULT_ONLY_WHY,
  REDUCE_WHY,
  RULE_OVER_EXIT_REASON,
  breakNotice,
  missingReasons,
  monthlyReport,
  recordAiTier,
  refreshOwnAiChoice,
  reopen,
  respond,
  routeReview,
  type DropReview,
  type Item,
  type Notif,
  notifName,
} from '../src/engine';
import { EIGHTK, P1, crash, dropRuns, exitVotes, f7, holdVotes, logRows, notices, postResult, pushRows, reduceNotif, withWorld } from './helpers/dropWorld';
import { ranksAt } from './helpers/market';
import { scenarios } from './helpers/scenarios';
import { Sim } from './helpers/sim';

// ================================================================ 減半檢視的結論（純函式）

const PRICE_DOC: PackDoc = { id: 'P', source_id: 'price:MU', kind: 'price', date: '2026-11-23', title: 'p', text: '2026-11-23 MU close 70.00' };
const FILING_DOC: PackDoc = { id: 'D1', source_id: 'edgar:0001-26-000001', kind: 'filing', date: '2026-11-20', title: '8-K 2026-11-20', text: 'Certain HBM supply agreements were renegotiated at lower prices during the quarter.' };
const NEWS_DOC: PackDoc = { id: 'N1', source_id: 'nasdaq-rss:MU:2026-11-23', kind: 'news', date: '2026-11-23', title: '新聞標題', text: 'Micron shares tumble as HBM contracts are said to be repriced' };
/** 大盤一起跌：個股 -25%，其中個股自身 -5%。 */
const MARKET_ATTR = { stock: -0.25, market: -0.2, sector: null, idio: -0.05 };

function dropPack(o: { verdicts?: string[]; abstain?: string; attr?: unknown; dq?: EvidencePack['data_quality'] } = {}): EvidencePack {
  return {
    pack_version: 1,
    run_id: 'r',
    function: OWN_DROP,
    prompt_version: OWN_DROP_PROMPT,
    as_of: '2026-11-23',
    created_at: '2026-11-23T23:40:00Z',
    subject: { ticker: 'MU' },
    question: 'q',
    policy: { level: 'A3', verdicts: o.verdicts ?? ['EXIT', 'HALF', 'HOLD'], abstain: o.abstain ?? 'HALF', min_evidence: 1, samples: 3 },
    rule: { action: '減半', detail: { urgent: true, attr: o.attr === undefined ? MARKET_ATTR : o.attr } },
    facts: [],
    premises: [
      { id: 'P1', text: 'HBM 長約有價格保護' },
      { id: 'P2', text: 'AI 需求延續到 2027' },
    ],
    documents: [PRICE_DOC, FILING_DOC, NEWS_DOC],
    data_quality: o.dq ?? {},
    condition_types: [],
  };
}
const EV = {
  price: { id: 'E1', source_id: 'price:MU', date: '2026-11-23', quote: '2026-11-23 MU close 70.00', claim: '價格' },
  filing: { id: 'E2', source_id: 'edgar:0001-26-000001', date: '2026-11-20', quote: 'Certain HBM supply agreements were renegotiated at lower prices', claim: '合約重新議價' },
  news: { id: 'E3', source_id: 'nasdaq-rss:MU:2026-11-23', date: '2026-11-23', quote: 'HBM contracts are said to be repriced', claim: '新聞' },
  fake: { id: 'E4', source_id: 'edgar:0001-26-000001', date: '2026-11-20', quote: 'this sentence is not in the filing at all', claim: '編的' },
};
/** 一票：verdict、歸類、每條前提（[編號, 判斷, 引用哪一條證據]）。 */
function dv(verdict: string, cause: string, premises: [string, string, keyof typeof EV][] = []) {
  return { verdict, premise_checks: premises.map(([id, status, ev]) => ({ premise_id: id, status, evidence_ids: [EV[ev].id] })), evidence: Object.values(EV), payload: { tier: verdict, cause_class: cause }, report: '測試' };
}
/** 只有預設前提的股票的證據包：只能選出清或減半，拿不定主意照規則（減半）。 */
const defaultPack = (o: Parameters<typeof dropPack>[0] = {}) => dropPack({ verdicts: ['EXIT', 'HALF'], ...o });
/** 有論點的股票的證據包（跌幅審查）：三個檔位，拿不定主意是不動。 */
const thesisPack = (o: Parameters<typeof dropPack>[0] = {}) => dropPack({ abstain: 'HOLD', ...o });
const decide3 = (pack: EvidencePack, votes: unknown[]) => dropDecision(judge(pack, votes, PAYLOAD_HOOKS[OWN_DROP]), pack);
const three = <T>(v: T) => [v, v, v];

// T82：dropDecision 分兩條路。只有預設前提的股票（verdicts 沒有 HOLD）照舊是出清／同意減半／沒有可用的結論；
// 有論點的股票（verdicts 有 HOLD）改成 §3.2 的四種。原本這裡的「K4／不動」（歸類要是大盤或產業、程式核對跌幅拆解）整個拿掉了：
// 使用者的決定 D2——沒有前提被判不成立就不減半，不看歸因；idioWithinHalf 只留給下跌加碼（§4.4）
describe('T31b：減半檢視的結果——只有預設前提的股票照舊（own_thesis §3.3，修 K4）', () => {
  it('K4／出清：三票出清還要同一條前提、每一票都有申報或財報的引用；只有新聞或價格、各判不同的前提、引用沒過檢查 → 沒有可用的結論', () => {
    const pack = defaultPack();
    // 重現 K4：以前三票一致選出清就算，不看是不是同一條前提、有沒有申報引用
    expect(decide3(pack, three(dv('EXIT', 'FUNDAMENTAL', [['P1', 'BROKEN', 'news']])))).toMatchObject({ status: 'NONE', premiseId: null, thesis: false });
    expect(decide3(pack, three(dv('EXIT', 'FUNDAMENTAL', [['P1', 'BROKEN', 'price']]))).status).toBe('NONE');
    expect(decide3(pack, [dv('EXIT', 'FUNDAMENTAL', [['P1', 'BROKEN', 'filing']]), dv('EXIT', 'FUNDAMENTAL', [['P2', 'BROKEN', 'filing']]), dv('EXIT', 'FUNDAMENTAL', [['P1', 'BROKEN', 'filing']])]).status).toBe('NONE');
    expect(decide3(pack, [dv('EXIT', 'FUNDAMENTAL', [['P1', 'BROKEN', 'filing']]), dv('EXIT', 'FUNDAMENTAL', [['P1', 'BROKEN', 'fake']]), dv('EXIT', 'FUNDAMENTAL', [['P1', 'BROKEN', 'filing']])]).status).toBe('NONE');
    expect(decide3(pack, three(dv('EXIT', 'FUNDAMENTAL'))).status).toBe('NONE');
    // 修好：三票都判同一條、都有申報引用
    expect(decide3(pack, three(dv('EXIT', 'FUNDAMENTAL', [['P1', 'BROKEN', 'filing'], ['P2', 'HOLDS', 'price']])))).toMatchObject({ status: 'EXIT', premiseId: 'P1', cause: 'FUNDAMENTAL' });
    // 兩條都不成立時取編號最小的那條
    expect(decide3(pack, three(dv('EXIT', 'FUNDAMENTAL', [['P2', 'BROKEN', 'filing'], ['P1', 'BROKEN', 'filing']]))).premiseId).toBe('P1');
    // 資料缺漏 → 不能用
    expect(decide3(defaultPack({ dq: { filings: 'missing' } }), three(dv('EXIT', 'FUNDAMENTAL', [['P1', 'BROKEN', 'filing']]))).status).toBe('NONE');
  });

  it('同意減半與沒有可用的結論：三票自己選減半 → AGREE（帶歸類）；票數不一致、少送票、不合格、被降級成減半、逾時 → NONE', () => {
    const pack = defaultPack();
    expect(decide3(pack, three(dv('HALF', 'FUNDAMENTAL', [['P1', 'INSUFFICIENT', 'price']])))).toMatchObject({ status: 'AGREE', cause: 'FUNDAMENTAL', premiseId: null });
    expect(decide3(pack, [dv('HALF', 'SECTOR'), dv('EXIT', 'SECTOR', [['P1', 'BROKEN', 'filing']]), dv('HALF', 'SECTOR')]).status).toBe('NONE');
    expect(decide3(pack, [dv('HALF', 'SECTOR'), dv('HALF', 'SECTOR')]).status).toBe('NONE'); // 少送一票
    expect(decide3(pack, [dv('HALF', 'SECTOR'), dv('HALF', 'SECTOR'), { verdict: 'SELL' }]).status).toBe('NONE'); // 一票不合格
    expect(decide3(pack, [dv('HALF', 'SECTOR'), dv('HALF', 'SECTOR'), dv('HOLD', 'SECTOR')]).status).toBe('NONE'); // 不動不在可以選的檔位裡
    // 選出清、但沒有一條通過檢查的證據 → 那一票被降級成減半，不算「自己選的」
    const noEvidence = { verdict: 'EXIT', evidence: [], payload: { tier: 'EXIT', cause_class: 'FUNDAMENTAL' } };
    expect(decide3(pack, [dv('HALF', 'SECTOR'), dv('HALF', 'SECTOR'), noEvidence]).status).toBe('NONE');
    expect(dropDecision({ status: 'TIMEOUT', verdict: null, votes: {}, actionable: false, followRule: true, reason: '逾時，照規則。', samples: [] }, pack)).toMatchObject({ status: 'NONE', why: '逾時，照規則。' });
    expect(dropDecision({ status: 'NO_RESULT', verdict: null, votes: {}, actionable: false, followRule: true, reason: '被退回，照規則。', samples: [] }, pack).status).toBe('NONE');
  });
});

describe('T82：跌幅審查的四種結果——有論點的股票（allocation_redesign §3.2，使用者的決定 D2）', () => {
  const hold = (cause = 'MARKET', p: [string, string, keyof typeof EV][] = [['P1', 'HOLDS', 'price']]) => dv('HOLD', cause, p);

  it('前提不成立：三票都判同一條、每一票都有合格的引用；不看三票選的檔位，三票都選出清時 exit', () => {
    const pack = thesisPack();
    expect(decide3(pack, three(dv('HALF', 'FUNDAMENTAL', [['P1', 'BROKEN', 'filing'], ['P2', 'HOLDS', 'price']])))).toMatchObject({ status: 'BROKEN', thesis: true, premiseId: 'P1', exit: false, cause: 'FUNDAMENTAL' });
    expect(decide3(pack, three(dv('EXIT', 'FUNDAMENTAL', [['P1', 'BROKEN', 'filing']])))).toMatchObject({ status: 'BROKEN', premiseId: 'P1', exit: true });
    // 檔位不一致也算：看的是前提
    expect(decide3(pack, [dv('EXIT', 'FUNDAMENTAL', [['P1', 'BROKEN', 'filing']]), dv('HALF', 'FUNDAMENTAL', [['P1', 'BROKEN', 'filing']]), dv('HOLD', 'SECTOR', [['P1', 'BROKEN', 'filing']])])).toMatchObject({ status: 'BROKEN', premiseId: 'P1', exit: false });
    // 兩條都不成立時取編號最小的那條
    expect(decide3(pack, three(dv('HALF', 'FUNDAMENTAL', [['P2', 'BROKEN', 'filing'], ['P1', 'BROKEN', 'filing']]))).premiseId).toBe('P1');
  });

  it('前提都沒有被判不成立：三票不動、沒有任何一票判不成立；不看跌幅的歸類，也不核對跌幅拆解（這檔自己跌的也一樣）', () => {
    expect(decide3(thesisPack(), three(hold()))).toMatchObject({ status: 'CLEAR', thesis: true, cause: 'MARKET', premiseId: null, exit: false });
    // 以前要三票都歸類成大盤或產業才算
    expect(decide3(thesisPack(), [hold('ONE_OFF'), hold('FUNDAMENTAL'), hold('UNKNOWN')]).status).toBe('CLEAR');
    // 以前程式核對跌幅拆解：個股 -30%，其中個股自身 -20%（超過一半）→ 不准不動。這個核對拿掉了
    const idio = { stock: -0.3, market: -0.08, sector: -0.02, idio: -0.2 };
    expect(idioWithinHalf(idio)).toBe(false);
    expect(decide3(thesisPack({ attr: idio }), three(hold())).status).toBe('CLEAR');
    expect(decide3(thesisPack({ attr: null }), three(hold())).status).toBe('CLEAR');
    // 大部分前提證據不足是正常的，不妨礙
    expect(decide3(thesisPack(), three(dv('HOLD', 'SECTOR', [['P1', 'INSUFFICIENT', 'price'], ['P2', 'INSUFFICIENT', 'price']]))).status).toBe('CLEAR');
    // 核對的函式留著給下跌加碼用（§4.4）：剛好一半算過；拆解算不出來、個股沒有跌不算
    expect(idioWithinHalf({ stock: -0.3, idio: -0.15 })).toBe(true);
    expect(idioWithinHalf({ stock: -0.3, idio: -0.1501 })).toBe(false);
    expect(idioWithinHalf({ stock: 0.05, idio: 0.01 })).toBe(false);
    expect(idioWithinHalf(null)).toBe(false);
  });

  it('票數不一致：跑完了，但對「哪一條前提不成立」沒有共識（1、2 票判、各判不同的前提、引用不合格），或沒有人判不成立但檔位不一致', () => {
    const pack = thesisPack();
    expect(decide3(pack, [hold(), hold('MARKET', [['P2', 'BROKEN', 'filing']]), hold()])).toMatchObject({ status: 'SPLIT', premiseId: null, splitPremise: 'P2', splitVotes: 1 });
    expect(decide3(pack, [dv('HALF', 'FUNDAMENTAL', [['P1', 'BROKEN', 'filing']]), dv('HALF', 'FUNDAMENTAL', [['P1', 'BROKEN', 'filing']]), hold()])).toMatchObject({ status: 'SPLIT', splitPremise: 'P1', splitVotes: 2 });
    // 各判不同的前提：取最多票的那一條
    expect(decide3(pack, [dv('EXIT', 'FUNDAMENTAL', [['P1', 'BROKEN', 'filing']]), dv('EXIT', 'FUNDAMENTAL', [['P2', 'BROKEN', 'filing']]), dv('EXIT', 'FUNDAMENTAL', [['P1', 'BROKEN', 'filing']])])).toMatchObject({ status: 'SPLIT', splitPremise: 'P1', splitVotes: 2 });
    // 三票都判了同一條，但只有新聞或價格當引用（不合格）→ 不算前提不成立
    expect(decide3(pack, three(dv('EXIT', 'FUNDAMENTAL', [['P1', 'BROKEN', 'news']])))).toMatchObject({ status: 'SPLIT', premiseId: null, splitPremise: 'P1', splitVotes: 3 });
    expect(decide3(pack, three(dv('EXIT', 'FUNDAMENTAL', [['P1', 'BROKEN', 'price']]))).status).toBe('SPLIT');
    // 引用沒過逐字檢查而被降級的也算判過
    expect(decide3(pack, [hold(), hold('MARKET', [['P2', 'BROKEN', 'fake']]), hold()])).toMatchObject({ status: 'SPLIT', splitPremise: 'P2', splitVotes: 1 });
    // 沒有人判不成立，但有人選了減半或出清（prompt 不准這樣選）→ 不會因此減半
    expect(decide3(pack, three(dv('HALF', 'FUNDAMENTAL', [['P1', 'INSUFFICIENT', 'price']])))).toMatchObject({ status: 'SPLIT', splitPremise: null, splitVotes: 0 });
    expect(decide3(pack, [hold(), hold(), dv('HALF', 'SECTOR')]).status).toBe('SPLIT');
    // 那一票另外被記下「選了減半，但沒有一條前提判成不成立」
    expect(judge(pack, three(dv('HALF', 'FUNDAMENTAL')), PAYLOAD_HOOKS[OWN_DROP]).samples[0].issues.join()).toContain('沒有一條前提判成不成立');
    expect(judge(pack, three(dv('HALF', 'FUNDAMENTAL', [['P1', 'BROKEN', 'filing']])), PAYLOAD_HOOKS[OWN_DROP]).samples[0].issues.join()).not.toContain('沒有一條前提判成不成立');
  });

  it('沒跑完：少送票、有不合格的票、資料缺漏、逾時、被退回 → 不動並重派（就算送回來的票判了前提不成立）', () => {
    const pack = thesisPack();
    const broken = dv('EXIT', 'FUNDAMENTAL', [['P1', 'BROKEN', 'filing']]);
    expect(decide3(pack, [broken, broken])).toMatchObject({ status: 'NONE', thesis: true, premiseId: null });
    expect(decide3(pack, [broken, broken, { verdict: 'SELL' }]).status).toBe('NONE');
    expect(decide3(thesisPack({ dq: { filings: 'missing' } }), three(broken)).status).toBe('NONE');
    expect(decide3(thesisPack({ dq: { filings: 'missing' } }), three(hold())).status).toBe('NONE');
    expect(dropDecision({ status: 'TIMEOUT', verdict: null, votes: {}, actionable: false, followRule: true, reason: '逾時，照規則。', samples: [] }, pack)).toMatchObject({ status: 'NONE', thesis: true, why: '逾時，照規則。' });
    expect(dropDecision({ status: 'NO_RESULT', verdict: null, votes: {}, actionable: false, followRule: true, reason: '被退回，照規則。', samples: [] }, pack).status).toBe('NONE');
  });

  // T82：有論點的股票（MU）題目改寫——跌幅只觸發審查，拿不定主意是不動（abstain HOLD），規則的動作寫「不動」；三票不動 → 前提都沒有被判不成立
  it('證據包分兩種：只有預設前提的只能選減半或出清（verdicts 沒有 HOLD、題目多一句，三票寫 HOLD 不合格）；有論點的題目是「只觸發審查」；prompt 升成 v6', () => {
    const sc = scenarios.s2();
    const sim = new Sim(sc.market, sc.init);
    const axis = sim.market.days.slice(0, sim.d);
    const inp = { acct: sim.acct, view: sim.pre, axis, runId: 'r1', attr: { from: '2026-10-01', to: sim.pre.date, sectorTicker: null, ...MARKET_ATTR }, base: null, baseRunId: null, docs: [], urgent: false, dataQuality: {}, now: new Date('2026-12-07T00:00:00Z') };
    // META 沒有自己的前提（系統預設三條）
    const meta = ownDropPack({ ...inp, ticker: 'META' }).pack;
    expect(meta.prompt_version).toBe('own_drop_v6'); // T54 升成 v3（分析師可以另外找資料）；T61 升成 v4（判成立要有正面的引用）
    expect(meta.policy.verdicts).toEqual(['EXIT', 'HALF']);
    expect(meta.question).toContain('這檔沒有使用者的論點，只能選照規則減半或出清');
    expect(meta.rule.detail).toMatchObject({ attr: { stock: -0.25, idio: -0.05 } });
    expect(meta.policy.abstain).toBe('HALF');
    expect(meta.rule.action).toBe('減半（賣掉一半）');
    // MU 有自己的前提：三個檔位，拿不定主意是不動；題目寫明跌幅不是賣出的理由、減半與出清要對應不成立的前提
    const mu = ownDropPack({ ...inp, ticker: 'MU' }).pack;
    expect(mu.policy.verdicts).toEqual(['EXIT', 'HALF', 'HOLD']);
    expect(mu.policy.abstain).toBe('HOLD');
    expect(mu.question).not.toContain('這檔沒有使用者的論點');
    expect(mu.question).toContain('跌幅只觸發這次審查，本身不是賣出的理由');
    expect(mu.question).toContain('HALF 與 EXIT 一定要對應一條你判成不成立（BROKEN）、而且有合格引用的前提');
    expect(mu.question).not.toContain('慢規則要減半');
    expect(mu.rule.action).toContain('不動');
    // 跌幅拆解照樣放進證據包（只顯示；下跌加碼的核對之後要用）
    expect(mu.rule.detail).toMatchObject({ attr: { stock: -0.25, idio: -0.05 } });
    // 預設前提的股票三票都寫 HOLD：不在可以選的檔位裡 → 不合格 → 沒有可用的結論
    const price = meta.documents.find((d) => d.source_id === 'price:META')!;
    const v = { run_id: meta.run_id, verdict: 'HOLD', premise_checks: [], evidence: [{ id: 'E1', source_id: price.source_id, date: price.date, quote: price.text.split('\n').at(-1)!, claim: '價格' }], payload: { tier: 'HOLD', cause_class: 'MARKET' } };
    expect(dropDecision(judge(meta, three(v), PAYLOAD_HOOKS[OWN_DROP]), meta).status).toBe('NONE');
    expect(dropDecision(judge(mu, three({ ...v, run_id: mu.run_id, evidence: [{ ...v.evidence[0], source_id: 'price:MU', quote: mu.documents.find((d) => d.source_id === 'price:MU')!.text.split('\n').at(-1)! }] }), PAYLOAD_HOOKS[OWN_DROP]), mu).status).toBe('CLEAR');
  });
});

// ================================================================ 引擎：慢規則通知上 AI 的那一行與選項

const item = (n: Notif, f: string, ticker?: string): Item => {
  const it = n.items.find((i) => i.f === f && (!ticker || i.ticker === ticker));
  if (!it) throw new Error(`通知 #${n.id} 沒有 ${f} ${ticker ?? ''}`);
  return it;
};
const HBM = 'HBM 長約有價格保護，記憶體循環這次不會像以前一樣崩';
const dr = (o: Partial<DropReview> = {}): DropReview => ({ session: '2026-12-24', runId: 'run-f7', status: 'PENDING', cause: null, premiseId: null, told: false, ...o });

/**
 * T82（allocation_redesign §3.1）：有論點的股票 -20% 改走跌幅審查（test/t82-watch.test.ts）。這幾段鎖住的是「只有預設前提的股票完全照舊」，
 * 所以把情境裡 MU 的兩條前提改成系統預設的（編號與字不變，通知上那一行的文字才對得上）。
 */
const asDefaultOnly = (sim: Sim): Sim => {
  sim.acct.own.MU.premises = sim.acct.own.MU.premises.map((p) => ({ ...p, origin: 'SYSTEM_DEFAULT' as const }));
  return sim;
};

/** 情境 ②：MU（只有預設前提，58 股）12/24 觸發減半，當天通知；回傳 12/28 早上的狀態與那則通知。before：觸發之前先做的事。 */
function muReduce(before?: (sim: Sim) => void, until = '2026-12-28') {
  const sc = scenarios.s2();
  const sim = asDefaultOnly(new Sim(sc.market, sc.init));
  if (before) {
    sim.runUntil('2026-12-24');
    before(sim);
  }
  sim.runUntil(until);
  const id = sim.acct.notifs.find((n) => n.kind === 'URGENT' && n.items.some((i) => i.f === 'F7' && i.ticker === 'MU'))!.id;
  const notif = () => sim.acct.notifs.find((n) => n.id === id)!;
  const it = () => item(notif(), 'F7', 'MU');
  /** 寫入減半檢視的狀態並重算那一行（等於 startDropRuns／applyOwnDrop 做的事）。 */
  const set = (o: Partial<DropReview>) => {
    sim.acct.own.MU.dropReview = dr(o);
    sim.acct = refreshOwnAiChoice(sim.acct, sim.pre, 'MU').acct;
    return it();
  };
  return { sim, id, notif, it, set };
}

describe('T31b：減半項目上 AI 的那一行與選項（own_thesis §3.4；只有預設前提的股票照舊）', () => {
  it('K1：觸發之前的審查檔位（三票證據不足而停在不動）不會變成通知上的「AI：不動」', () => {
    // 重現：12/18 的定期審查三票都說證據不足、停在 HOLD，被記成檔位；12/24 慢規則減半時以前會並列「AI：不動」
    const { it, set } = muReduce((sim) => (sim.acct = recordAiTier(sim.acct, 'MU', 'HOLD', '2026-12-18', false, 'run-f24-old')));
    expect(it().choices.map((c) => c.id)).toEqual(['RULE', 'SKIP']);
    expect(it().aiLine).toBeUndefined();
    expect(it().runIds).toBeUndefined();
    // 減半檢視開了：只寫「進行中」，仍然沒有「照 AI」
    const pending = set({ status: 'PENDING' });
    expect(pending.aiLine).toBe('AI 論點檢查進行中，台灣 09:30 前更新');
    expect(pending.choices.map((c) => c.id)).toEqual(['RULE', 'SKIP']);
    expect(pending.runIds).toEqual(['run-f7']);
  });

  it('K2：減半檢視同意減半或沒有一致結論 → 通知寫的是這次檢查的結果，舊的檔位不會留在上面', () => {
    const { set } = muReduce((sim) => (sim.acct = recordAiTier(sim.acct, 'MU', 'HOLD', '2026-12-18', false, 'run-f24-old')));
    const agree = set({ status: 'AGREE', cause: 'FUNDAMENTAL' });
    expect(agree.aiLine).toBe('論點檢查（3 票）：同意減半（歸類：公司基本面）');
    expect(agree.choices.map((c) => c.id)).toEqual(['RULE', 'SKIP']);
    expect(agree.drop).toBe('AGREE');
    const none = set({ status: 'NONE' });
    expect(none.aiLine).toBe('AI 論點檢查沒有一致結論，照規則');
    expect(none.choices.map((c) => c.id)).toEqual(['RULE', 'SKIP']);
    expect(none.drop).toBe('NONE');
  });

  // T82：「建議不動」拿掉了（有論點的股票改成跌幅審查、預設就是不動；只有預設前提的本來就不能選）。剩下四種狀態
  it('減半項目的狀態：標題、理由、那一行、選項的順序與預設；沒有 dropReview（舊通知）不顯示；狀態被寫成不動（舊資料）當成沒有結論', () => {
    const { sim, it, set } = muReduce();
    // 標題與理由（慢規則是底線）；預設照規則；選「這次不做」要寫理由
    expect(it().title).toMatch(/^MU：比 52 週高點低 2\d\.\d% → 慢規則減半$/);
    expect(it().why).toBe(REDUCE_WHY);
    expect(it()).toMatchObject({ choice: 'RULE', ruleChoice: 'RULE', reasonRequired: true });
    expect(it().aiLine).toBeUndefined();
    expect(it().drop).toBeUndefined();
    expect(set({ status: 'PENDING' })).toMatchObject({ aiLine: 'AI 論點檢查進行中，台灣 09:30 前更新', drop: 'PENDING' });
    // 只有預設前提的股票沒有「不動」：萬一狀態被寫成不動（2026-11-22 以前的資料），當成沒有可用的結論
    const hold = set({ status: 'HOLD', cause: 'SECTOR' });
    expect(hold.aiLine).toBe('AI 論點檢查沒有一致結論，照規則');
    expect(hold.choices.map((c) => [c.id, c.label])).toEqual([
      ['RULE', '照規則'],
      ['SKIP', '這次不做'],
    ]);
    expect(hold).toMatchObject({ drop: 'NONE', choice: 'RULE', ruleChoice: 'RULE' });
    expect(hold.brk).toBeUndefined();
    expect(hold.why).toBe(REDUCE_WHY + DEFAULT_ONLY_WHY);
    // 出清：多一個「照 AI：出清，賣 58 股」，帶著哪一條前提（拿去討論、BREAK_NOTICE、靜默期用）
    const exit = set({ status: 'EXIT', cause: 'FUNDAMENTAL', premiseId: 'P1' });
    expect(exit.aiLine).toBe(`論點檢查（3 票）：前提「${HBM}」不成立。AI 建議出清，賣 58 股`);
    expect(exit.choices.map((c) => c.id)).toEqual(['RULE', 'AI', 'SKIP']);
    expect(exit.choices[1]).toMatchObject({ label: '照 AI：出清，賣 58 股', tier: 'EXIT', lines: [{ ticker: 'MU', bucket: 'own', shares: -58 }], effects: [{ type: 'APPLY_TIER', ticker: 'MU', tier: 'EXIT' }] });
    expect(exit).toMatchObject({ drop: 'EXIT', brk: { type: 'B', premiseId: 'P1', withRule: true }, choice: 'RULE' });
    // 從出清改回同意減半：選項與 brk 一起拿掉
    const agree = set({ status: 'AGREE', cause: 'ONE_OFF' });
    expect(agree.aiLine).toBe('論點檢查（3 票）：同意減半（歸類：一次性事件）');
    expect(agree.brk).toBeUndefined();
    expect(agree.choices.map((c) => c.id)).toEqual(['RULE', 'SKIP']);
    expect(set({ status: 'NONE' }).aiLine).toBe('AI 論點檢查沒有一致結論，照規則');
    // 使用者原本選了照 AI、後來那個選項沒了 → 退回照規則
    set({ status: 'EXIT', premiseId: 'P1' });
    it().choice = 'AI';
    expect(set({ status: 'NONE' }).choice).toBe('RULE');
    // 清單預設仍是照規則的單
    expect(sim.acct.notifs.find((n) => n.items.includes(it()))!.preview!.merged.find((m) => m.ticker === 'MU')!.shares).toBe(-29);
  });

  it('只有預設前提的股票（併入月報的 META）：理由多一句、標題寫觸發那天的跌幅，而且不會出現「不動」', () => {
    const sc = scenarios.s2();
    const sim = new Sim(sc.market, sc.init);
    sim.runUntil('2026-12-31');
    expect(sim.acct.own.META.reduceDd).toBeLessThan(-0.2);
    const ddText = (-sim.acct.own.META.reduceDd! * 100).toFixed(1);
    // 就算狀態被寫成不動（實際上證據包沒有這個檔位），通知上也不會出現「照 AI：不動」
    sim.acct.own.META.dropReview = dr({ status: 'HOLD', cause: 'SECTOR' });
    sim.runUntil('2027-01-04');
    const jan = sim.preOpen()!;
    const it7 = item(jan, 'F7', 'META');
    expect(it7.title).toBe(`META：比 52 週高點低 ${ddText}% → 慢規則減半（2026-12-24 觸發；這一筆不到總資產的 5%，所以併入月報）`);
    expect(it7.why).toBe(REDUCE_WHY + DEFAULT_ONLY_WHY);
    expect(it7.choices.map((c) => c.id)).toEqual(['RULE', 'SKIP']);
    expect(it7.aiLine).toBe('AI 論點檢查沒有一致結論，照規則');
    // 同意減半照常寫
    sim.acct.own.META.dropReview = dr({ status: 'AGREE', cause: 'SECTOR' });
    sim.acct = refreshOwnAiChoice(sim.acct, sim.pre, 'META').acct;
    const again = item(sim.acct.notifs.find((n) => n.id === jan.id)!, 'F7', 'META');
    expect(again.aiLine).toBe('論點檢查（3 票）：同意減半（歸類：產業一起跌）');
    expect(again.why).toBe(REDUCE_WHY + DEFAULT_ONLY_WHY);
  });

  // T82：減半檢視的底從「建議不動」換成「同意減半」（不動已經不會出現）；另外的審查怎麼蓋上去照舊
  it('觸發之後另外有審查回來：出清 → 換成出清（寫審查的日期）；減半而且有不成立的前提 → 寫那次審查同意減半；其他不影響；靜默中加註記', () => {
    const { sim, set } = muReduce();
    const review = (tier: 'EXIT' | 'HALF' | 'HOLD', date: string, extra: Parameters<typeof recordAiTier>[6]) => {
      sim.acct = recordAiTier(sim.acct, 'MU', tier, date, false, 'run-f24', extra);
      return set({ status: 'AGREE', cause: 'SECTOR' });
    };
    // 出清（三票一致、前提 P1 不成立）
    const exit = review('EXIT', '2026-12-28', { premiseId: 'P1', trigger: 'EARNINGS', agreed: true });
    expect(exit.aiLine).toBe(`12/28 的審查（3 票）：前提「${HBM}」不成立。AI 建議出清，賣 58 股`);
    expect(exit.choices.map((c) => [c.id, c.tier ?? null])).toEqual([['RULE', null], ['AI', 'EXIT'], ['SKIP', null]]);
    expect(exit).toMatchObject({ drop: 'EXIT', brk: { type: 'B', premiseId: 'P1', withRule: true }, runIds: ['run-f24'] });
    // 減半、有不成立的前提：那一行換成那次審查
    const half = review('HALF', '2026-12-28', { premiseId: 'P1', trigger: 'EARNINGS', agreed: true });
    expect(half.aiLine).toBe(`12/28 的審查認為前提「${HBM}」不成立，同意減半`);
    expect(half.choices.map((c) => c.id)).toEqual(['RULE', 'SKIP']);
    expect(half.drop).toBe('AGREE');
    // 沒有不成立的前提、不是三票一致、觸發之前的、減半檢視自己寫的 → 不影響減半檢視的結果
    for (const [tier, date, extra] of [
      ['HALF', '2026-12-28', { trigger: 'EARNINGS', agreed: true }],
      ['EXIT', '2026-12-28', { premiseId: 'P1', trigger: 'EARNINGS' }],
      ['EXIT', '2026-12-23', { premiseId: 'P1', trigger: 'EARNINGS', agreed: true }],
      ['EXIT', '2026-12-28', { premiseId: 'P1', trigger: 'DROP', agreed: true }],
      ['EXIT', '2026-12-28', { premiseId: 'P9', trigger: 'EARNINGS', agreed: true }],
    ] as const) {
      const same = review(tier, date, extra);
      expect(same.aiLine).toBe('論點檢查（3 票）：同意減半（歸類：產業一起跌）');
      expect(same.choices.map((c) => [c.id, c.tier ?? null])).toEqual([['RULE', null], ['SKIP', null]]);
    }
    // 那條前提在靜默中：照樣列，後面加一句（靜默期不擋這一行）
    sim.acct.own.MU.disputes = [{ premiseId: 'P1', since: '2026-12-20', until: '2027-03-30', reason: '長約還在', notif: null }];
    expect(review('EXIT', '2026-12-28', { premiseId: 'P1', trigger: 'EARNINGS', agreed: true }).aiLine).toBe(`12/28 的審查（3 票）：前提「${HBM}」不成立。AI 建議出清，賣 58 股（你在 12/20 對這條前提表示不同意）`);
    expect(review('HALF', '2026-12-28', { premiseId: 'P1', trigger: 'EARNINGS', agreed: true }).aiLine).toBe(`12/28 的審查認為前提「${HBM}」不成立，同意減半（你在 12/20 對這條前提表示不同意）`);
    expect(set({ status: 'EXIT', premiseId: 'P1' }).aiLine).toContain('（你在 12/20 對這條前提表示不同意）');
  });

  it('§1.9：這檔有還沒回覆的慢規則通知時審查回來 → 不另發，更新那則通知上的那一行（已經減半所以審查的「減半」不算新建議、前提在靜默中，都照樣更新）', () => {
    const { sim, id, set } = muReduce();
    set({ status: 'AGREE', cause: 'SECTOR' });
    const before = sim.acct.notifs.length;
    // 規則的狀態已經是減半：審查的「減半」和目前相同（suggest = false），以前只放網站；現在那一行改寫成同意減半
    const half = routeReview(sim.acct, sim.pre, 'MU', { tier: 'HALF', suggest: false, consensus: true, premiseId: 'P1', trigger: 'EARNINGS', date: '2026-12-28', runId: 'run-a' });
    expect(half).toMatchObject({ route: 'RULE_NOTICE', notif: null, changed: [id] });
    expect(half.acct.notifs).toHaveLength(before);
    expect(item(half.acct.notifs.find((n) => n.id === id)!, 'F7', 'MU').aiLine).toContain('同意減半');
    // 靜默中的前提：不另發乙類，但慢規則通知上照樣列出清
    sim.acct.own.MU.disputes = [{ premiseId: 'P1', since: '2026-12-20', until: '2027-03-30', reason: '長約還在', notif: null }];
    const exit = routeReview(sim.acct, sim.pre, 'MU', { tier: 'EXIT', suggest: true, consensus: true, premiseId: 'P1', trigger: 'EARNINGS', date: '2026-12-28', runId: 'run-b' });
    expect(exit).toMatchObject({ route: 'RULE_NOTICE', notif: null, changed: [id] });
    expect(exit.acct.notifs).toHaveLength(before);
    expect(exit.acct.own.MU.aiTier).toMatchObject({ tier: 'EXIT', suggest: false, premiseId: 'P1', agreed: true });
    expect(item(exit.acct.notifs.find((n) => n.id === id)!, 'F7', 'MU').choices.map((c) => c.tier ?? null)).toEqual([null, 'EXIT', null]);
    // 沒有不成立的前提的審查：那一行不變（減半檢視的結果還在）
    const hold = routeReview(sim.acct, sim.pre, 'MU', { tier: 'HOLD', suggest: false, consensus: true, premiseId: null, trigger: 'EARNINGS', date: '2026-12-28', runId: 'run-c' });
    expect(hold.route).toBe('NONE');
    expect(item(hold.acct.notifs.find((n) => n.id === id)!, 'F7', 'MU').aiLine).toBe('論點檢查（3 票）：同意減半（歸類：產業一起跌）');
  });

  it('慢規則通知產生時同一檔有還沒回覆的乙類：乙類標成被取代，內容併進減半項目（出清 → 照 AI：出清；減半 → 同意減半）；月中記著等月報的建議一樣併進來', () => {
    // 乙類：12/23 當天通知（審查建議出清），還沒回覆；12/24 慢規則觸發減半
    const exitCase = muReduce((sim) => {
      sim.acct = recordAiTier(sim.acct, 'MU', 'EXIT', '2026-12-23', false, 'run-b', { premiseId: 'P1', trigger: 'EARNINGS', agreed: true });
      sim.acct = breakNotice(sim.acct, sim.pre, 'MU', { tier: 'EXIT', premiseId: 'P1', basis: '8-K 2026-12-22', runIds: ['run-b'] }).acct;
    });
    const brk = exitCase.sim.acct.notifs.find((n) => n.items.some((i) => i.f === 'F24' && i.brk?.type === 'B'))!;
    expect(brk.status).toBe('SUPERSEDED');
    expect(brk.items[0]).toMatchObject({ cancelled: true });
    expect(brk.items[0].note).toContain('併進 MU 的慢規則減半通知');
    const it1 = exitCase.it();
    expect(it1.absorbed).toMatchObject({ notif: brk.id, tier: 'EXIT', premiseId: 'P1', date: '2026-12-23', runIds: ['run-b'] });
    expect(it1.aiLine).toBe(`12/23 的審查（3 票）：前提「${HBM}」不成立。AI 建議出清，賣 58 股`);
    expect(it1.choices.map((c) => c.tier ?? null)).toEqual([null, 'EXIT', null]);
    expect(it1.brk).toEqual({ type: 'B', premiseId: 'P1', withRule: true });
    // 之後減半檢視回來（同意減半）：併進來的出清還在
    expect(exitCase.set({ status: 'AGREE', cause: 'FUNDAMENTAL' }).aiLine).toContain('AI 建議出清');
    // 乙類建議減半 → 那一行寫審查認為前提不成立、同意減半，沒有另一個選項
    const halfCase = muReduce((sim) => {
      sim.acct = breakNotice(sim.acct, sim.pre, 'MU', { tier: 'HALF', premiseId: 'P2', basis: '10-Q 2026-12-22', runIds: ['run-h'] }).acct;
    });
    expect(halfCase.sim.acct.notifs.find((n) => n.items.some((i) => i.f === 'F24'))!.status).toBe('SUPERSEDED');
    expect(halfCase.it().aiLine).toBe('12/23 的審查認為前提「AI 資料中心需求至少延續到 2027」不成立，同意減半');
    expect(halfCase.it().choices.map((c) => c.id)).toEqual(['RULE', 'SKIP']);
    expect(halfCase.set({ status: 'AGREE', cause: 'SECTOR' }).choices.map((c) => c.id)).toEqual(['RULE', 'SKIP']);
    // 月中記著等月報的建議（30 天內已經發過當天通知）→ 併進減半項目，不再進月報
    const kept = muReduce((sim) => (sim.acct = recordAiTier(sim.acct, 'MU', 'HALF', '2026-12-18', true, 'run-m', { premiseId: 'P1', trigger: 'EARNINGS', agreed: true })));
    expect(kept.it().absorbed).toMatchObject({ notif: 0, tier: 'HALF', premiseId: 'P1', date: '2026-12-18' });
    expect(kept.it().aiLine).toBe(`12/18 的審查認為前提「${HBM}」不成立，同意減半`);
    expect(kept.sim.acct.own.MU.aiTier!.suggest).toBe(false);
    kept.sim.runUntil('2027-01-04');
    expect(kept.sim.preOpen()!.items.some((i) => i.ticker === 'MU' && i.f === 'F24')).toBe(false);
  });
});

describe('T31b：加回項目的「照 AI」（own_thesis §3.4，修 K5）', () => {
  /** 情境 ②：MU 2/18 觸發加回，併入 3 月月報。before：2/26 早上先做的事。 */
  function muReadd(before: (sim: Sim) => void) {
    const sc = scenarios.s2();
    const sim = asDefaultOnly(new Sim(sc.market, sc.init, { autoRespond: true }));
    sim.runUntil('2027-02-26');
    before(sim);
    sim.opt.autoRespond = false;
    sim.runUntil('2027-03-01');
    const mar = sim.preOpen()!;
    return { sim, mar, it: item(mar, 'F8', 'MU') };
  }

  it('K5：審查在減半狀態下選「減半」但沒有不成立的前提 → 加回只有規則一行（以前會並列「AI：維持減半」）', () => {
    // 重現：T10 實際跑的那次，三票的理由是「站上 200 日均線才 2/10 天」（規則自己的條件），沒有任何前提被判不成立
    const { it } = muReadd((sim) => (sim.acct = recordAiTier(sim.acct, 'MU', 'HALF', '2027-02-26', false, 'run-x', { trigger: 'MONTHLY', agreed: true })));
    expect(it.choices.map((c) => c.id)).toEqual(['RULE', 'SKIP']);
    expect(it.aiLine).toBeUndefined();
    expect(it.reasonRequired).toBeUndefined(); // 加回選這次不做不用寫理由
  });

  it('有不成立的前提（三票判同一條）才列：維持減半；出清寫股數；那條前提已經撤下、不是三票一致 → 不列；靜默中照列並加註記', () => {
    const half = muReadd((sim) => (sim.acct = recordAiTier(sim.acct, 'MU', 'HALF', '2027-02-26', false, 'run-y', { premiseId: 'P1', trigger: 'MONTHLY', agreed: true })));
    expect(half.it.choices.map((c) => [c.id, c.label])).toEqual([
      ['RULE', '照規則'],
      ['AI', '照 AI：維持減半'],
      ['SKIP', '這次不做'],
    ]);
    expect(half.it.choices[1]).toMatchObject({ tier: 'HALF', lines: [] });
    expect(half.it.aiLine).toBe(`2/26 的審查認為前提「${HBM}」不成立：AI 建議維持減半`);
    expect(half.it).toMatchObject({ choice: 'RULE', runIds: ['run-y'] });
    const exit = muReadd((sim) => (sim.acct = recordAiTier(sim.acct, 'MU', 'EXIT', '2027-02-26', false, 'run-z', { premiseId: 'P1', trigger: 'DROP', agreed: true })));
    expect(exit.it.choices[1]).toMatchObject({ label: '照 AI：出清，賣 29 股', tier: 'EXIT', lines: [{ shares: -29 }] });
    expect(exit.it.aiLine).toBe(`2/26 的審查認為前提「${HBM}」不成立：AI 建議出清，賣 29 股`);
    // 前提已經不在現行的前提裡
    const retired = muReadd((sim) => {
      sim.acct = recordAiTier(sim.acct, 'MU', 'HALF', '2027-02-26', false, 'run-y', { premiseId: 'P1', trigger: 'MONTHLY', agreed: true });
      sim.acct.own.MU.premises = sim.acct.own.MU.premises.filter((p) => p.id !== 'P1');
    });
    expect(retired.it.choices.map((c) => c.id)).toEqual(['RULE', 'SKIP']);
    // 不是三票一致（舊資料沒有記）
    const loose = muReadd((sim) => (sim.acct = recordAiTier(sim.acct, 'MU', 'HALF', '2027-02-26', false, 'run-y', { premiseId: 'P1', trigger: 'MONTHLY' })));
    expect(loose.it.choices.map((c) => c.id)).toEqual(['RULE', 'SKIP']);
    // 靜默中
    const silent = muReadd((sim) => {
      sim.acct = recordAiTier(sim.acct, 'MU', 'HALF', '2027-02-26', false, 'run-y', { premiseId: 'P1', trigger: 'MONTHLY', agreed: true });
      sim.acct.own.MU.disputes = [{ premiseId: 'P1', since: '2027-01-15', until: '2027-04-25', reason: '長約還在', notif: null }];
    });
    expect(silent.it.aiLine).toBe(`2/26 的審查認為前提「${HBM}」不成立：AI 建議維持減半（你在 1/15 對這條前提表示不同意）`);
    expect(silent.it.choices.map((c) => c.id)).toEqual(['RULE', 'AI', 'SKIP']);
  });
});

describe('T31b：這次不做的理由、回應與靜默期、紀錄（own_thesis §3.4）', () => {
  it('減半項目選「這次不做」要寫一句理由：沒寫送不出去（整則這次不做也一樣）；照規則、照 AI 不用寫；理由記在項目與影子紀錄上', () => {
    // T82：有「照 AI」選項的狀態只剩建議出清（原本用建議不動）；影子紀錄的照 AI 那條線跟著是出清的 58 股
    const { sim, id, notif, it, set } = muReduce();
    set({ status: 'EXIT', cause: 'FUNDAMENTAL', premiseId: 'P1' });
    const key = it().key;
    expect(missingReasons(notif(), { mode: 'DO', choices: { [key]: 'SKIP' } }).map((i) => i.ticker)).toEqual(['MU']);
    expect(missingReasons(notif(), { mode: 'SKIP' }).map((i) => i.ticker)).toEqual(['MU']);
    expect(missingReasons(notif(), { mode: 'DO', choices: { [key]: 'SKIP' }, reasons: { [key]: '   ' } })).toHaveLength(1);
    expect(missingReasons(notif(), { mode: 'DO', choices: { [key]: 'SKIP' }, reasons: { [key]: '只是產業一起跌' } })).toEqual([]);
    expect(missingReasons(notif(), { mode: 'DO' })).toEqual([]);
    expect(missingReasons(notif(), { mode: 'DO', choices: { [key]: 'AI' } })).toEqual([]);
    sim.respond(id, { mode: 'DO', choices: { [key]: 'SKIP' }, reasons: { [key]: '只是產業一起跌' } });
    expect(notif().status).toBe('SKIPPED');
    expect(it().reason).toBe('只是產業一起跌');
    expect(sim.acct.shadow.find((s) => s.f === 'F7' && s.ticker === 'MU')).toMatchObject({ rule: -29, ai: -58, actual: 0, choice: 'SKIP', note: '只是產業一起跌' });
    // 規則狀態照舊前進（只有預設前提的股票：記成已減半；有論點的改成留在審查後持有，見 t82）
    expect(sim.acct.rule.own.MU.applied).toBe('HALF');
    expect(sim.acct.own.MU.slow.state).toBe('HALF');
  });

  it('AI 建議出清、你選了照規則或這次不做 → 那條前提進靜默期（理由記你寫的，沒寫記固定的一句）；照 AI 出清不進；改決定時收回', () => {
    // 照規則
    const a = muReduce();
    a.set({ status: 'EXIT', cause: 'FUNDAMENTAL', premiseId: 'P1' });
    a.sim.respond(a.id, { mode: 'DO' });
    expect(a.notif().status).toBe('RESPONDED');
    expect(a.sim.acct.own.MU.disputes).toEqual([{ premiseId: 'P1', since: '2026-12-24', until: '2027-04-03', reason: RULE_OVER_EXIT_REASON, notif: a.id }]);
    // 之後同一條前提的審查建議（減半或出清）在靜默期內：不通知、不進月報
    for (const tier of ['HALF', 'EXIT'] as const) {
      const r = routeReview(a.sim.acct, a.sim.pre, 'MU', { tier, suggest: true, consensus: true, premiseId: 'P1', trigger: 'EARNINGS', date: '2027-01-20', runId: 'run-later' });
      expect(r).toMatchObject({ route: 'SILENT', notif: null });
      expect(r.acct.own.MU.aiTier!.suggest).toBe(false);
    }
    // 別條前提照給
    expect(routeReview(a.sim.acct, a.sim.pre, 'MU', { tier: 'EXIT', suggest: true, consensus: true, premiseId: 'P2', trigger: 'EARNINGS', date: '2027-01-20', runId: 'run-later' }).route).toBe('SAME_DAY');
    // 改決定：靜默期收回，通知回到等你決定、那一行還在
    const back = reopen(a.sim.acct, a.sim.pre, a.id);
    expect(back.ok).toBe(true);
    expect(back.acct.own.MU.disputes).toEqual([]);
    expect(item(back.acct.notifs.find((n) => n.id === a.id)!, 'F7', 'MU').choices.map((c) => c.tier ?? null)).toEqual([null, 'EXIT', null]);
    // 這次不做並寫理由
    const b = muReduce();
    const key = b.set({ status: 'EXIT', premiseId: 'P1' }).key;
    b.sim.respond(b.id, { mode: 'DO', choices: { [key]: 'SKIP' }, reasons: { [key]: '重新議價的只是小客戶' } });
    expect(b.sim.acct.own.MU.disputes).toMatchObject([{ premiseId: 'P1', reason: '重新議價的只是小客戶', notif: b.id }]);
    // 照 AI 出清：不進靜默期；填快照後移出自選、論點檔結案
    const c = muReduce();
    const k2 = c.set({ status: 'EXIT', premiseId: 'P1' }).key;
    c.sim.respond(c.id, { mode: 'DO', choices: { [k2]: 'AI' } });
    expect(c.sim.acct.own.MU.disputes ?? []).toEqual([]);
    c.sim.open();
    expect(c.sim.acct.own.MU).toBeUndefined();
    expect(c.sim.acct.lots.own.MU).toBeUndefined();
    expect(c.sim.acct.ownClosed!.MU).toMatchObject({ reason: 'EXIT_AI' });
    // AI 同意減半、選了照規則：沒有哪一條前提不成立，不進靜默期
    const d = muReduce();
    d.set({ status: 'AGREE', cause: 'SECTOR' });
    d.sim.respond(d.id, { mode: 'DO' });
    expect(d.sim.acct.own.MU.disputes ?? []).toEqual([]);
  });

  it('dropReview 什麼時候清掉：這次不做、填了快照之後；等你下單時留著（還可以改決定）；慢規則下一次切換時', () => {
    // T82：原本中間有一段「照 AI：不動 → 不用下單、當下完成、清掉」，那個選項已經沒有了，拿掉（有論點的股票選不動之後的事在 t82）
    const skip = muReduce();
    const key = skip.set({ status: 'AGREE', cause: 'SECTOR' }).key;
    skip.sim.respond(skip.id, { mode: 'DO', choices: { [key]: 'SKIP' }, reasons: { [key]: '先不賣' } });
    expect(skip.sim.acct.own.MU.dropReview).toBeUndefined();
    // 照規則：等你下單時留著，填快照之後清掉
    const rule = muReduce();
    rule.set({ status: 'AGREE', cause: 'SECTOR' });
    rule.sim.respond(rule.id, { mode: 'DO' });
    expect(rule.notif().status).toBe('RESPONDED');
    expect(rule.sim.acct.own.MU.dropReview).toMatchObject({ status: 'AGREE' });
    rule.sim.open();
    expect(rule.notif().status).toBe('DONE');
    expect(rule.sim.acct.own.MU.dropReview).toBeUndefined();
    // 慢規則下一次切換（2/18 加回）：上一次減半的論點檢查不再對應
    const sc = scenarios.s2();
    const sim = asDefaultOnly(new Sim(sc.market, sc.init, { autoRespond: true }));
    sim.runUntil('2027-02-18');
    sim.acct.own.MU.dropReview = dr({ status: 'AGREE' });
    sim.runUntil('2027-02-19');
    expect(sim.acct.own.MU.pending).toEqual({ action: 'READD', date: '2027-02-18' });
    expect(sim.acct.own.MU.dropReview).toBeUndefined();
  });

  it('紀錄：帶「出清」那一行時寫 BREAK_NOTICE（withRule）；既有的通知更新成出清的那一刻只寫一次；回覆寫 RESPONSE（type R：RULE／FOLLOW／SKIPPED、理由、aiOffered）', () => {
    const { sim, id, notif, it, set } = muReduce();
    const fileId = sim.acct.own.MU.fileId!;
    // 還不是出清：沒有 BREAK_NOTICE
    set({ status: 'AGREE', cause: 'SECTOR' });
    expect(breakLogs(sim.acct, [notif()])).toEqual([]);
    const before = structuredClone(sim.acct);
    const had = withRuleKeys(before);
    const oldIds = new Set(before.notifs.map((n) => n.id));
    // 更新成出清的那一刻
    set({ status: 'EXIT', cause: 'FUNDAMENTAL', premiseId: 'P1' });
    const logs = ruleBreakLogs(had, oldIds, sim.acct);
    expect(logs).toEqual([{ ticker: 'MU', fileId, session: '2026-12-24', kind: 'BREAK_NOTICE', ref: String(id), body: { type: 'B', notif: id, runIds: ['run-f7'], conditionId: null, premiseId: 'P1', tier: 'EXIT', sameDay: true, withRule: true } }]);
    // 已經寫過的不重寫；換了一條前提才再寫
    expect(ruleBreakLogs(withRuleKeys(sim.acct), oldIds, sim.acct)).toEqual([]);
    const had2 = withRuleKeys(sim.acct);
    set({ status: 'EXIT', premiseId: 'P2' });
    expect(ruleBreakLogs(had2, oldIds, sim.acct).map((l) => l.body.premiseId)).toEqual(['P2']);
    // 回覆：三種
    const key = it().key;
    const answered = (input: Parameters<typeof respond>[3]) => {
      const acct = respond(sim.acct, sim.pre, id, input);
      return ruleResponseLogs(sim.acct, acct.notifs.find((n) => n.id === id)!, '2026-12-28').map((l) => ({ kind: l.kind, ref: l.ref, fileId: l.fileId, ...l.body }));
    };
    expect(answered({ mode: 'DO' })).toEqual([{ kind: 'RESPONSE', ref: String(id), fileId, notif: id, type: 'R', outcome: 'RULE', reason: null, aiOffered: 'EXIT', premiseId: 'P2', runIds: ['run-f7'] }]);
    expect(answered({ mode: 'DO', choices: { [key]: 'AI' } })[0]).toMatchObject({ type: 'R', outcome: 'FOLLOW', reason: null, aiOffered: 'EXIT' });
    expect(answered({ mode: 'DO', choices: { [key]: 'SKIP' }, reasons: { [key]: '先看下一季' } })[0]).toMatchObject({ type: 'R', outcome: 'SKIPPED', reason: '先看下一季', aiOffered: 'EXIT' });
    // 同意減半時 aiOffered 是空的（T82：建議不動已經不會出現，那一行斷言拿掉）
    set({ status: 'AGREE', cause: 'SECTOR' });
    expect(answered({ mode: 'DO' })[0]).toMatchObject({ outcome: 'RULE', aiOffered: null });
  });

  it('LINE 多的一行（放在下單清單後面）；月報裡前面寫代號；沒有 dropReview 的舊通知不加', () => {
    const { sim, notif, set } = muReduce();
    const text = () => notifText(sim.acct, notif(), 'https://bot.example/#/n/1');
    expect(text()).not.toContain('AI 論點檢查');
    for (const [o, line] of [
      [{ status: 'PENDING' }, 'AI 論點檢查還沒有結論'],
      [{ status: 'EXIT', premiseId: 'P1' }, 'AI 論點檢查：前提不成立，建議出清（預設仍是照規則），到網站決定'],
      [{ status: 'AGREE', cause: 'SECTOR' }, 'AI 論點檢查：同意減半'],
      [{ status: 'NONE' }, 'AI 論點檢查沒有一致結論，照規則'],
    ] as const) {
      set(o);
      const lines = text().split('\n');
      expect(lines).toContain(line);
      // 在下單清單（賣 MU 29 股）後面；帶出清那一行的慢規則通知不是乙類的格式，下單清單照列
      expect(lines.indexOf(line)).toBeGreaterThan(lines.findIndex((l) => l.startsWith('賣 MU 29 股')));
      expect(lines[0]).toBe('【當天】MU 慢規則減半');
    }
    expect(DROP_LINE.HOLD).toContain('預設仍是照規則');
    // 月報：前面寫代號
    const sc = scenarios.s2();
    const m = new Sim(sc.market, sc.init);
    m.runUntil('2026-12-31');
    m.acct.own.META.dropReview = dr({ status: 'AGREE', cause: 'SECTOR' });
    m.runUntil('2027-01-04');
    const jan = monthlyReport(m.acct, m.pre, { order: ranksAt(m.market, m.d - 1), month: '2027-01' });
    expect(notifText(jan.acct, jan.notif, null).split('\n')).toContain('META 的 AI 論點檢查：同意減半');
  });

  it('共用的那一段（規則的通知等到下一次流程再推）：有減半項目而且還在等才等；推出去時標成講過了（還在等的不標）；出清才補推，一個結果一次', () => {
    const { sim, id, notif, set } = muReduce();
    expect(PUSH_WAITERS).toContain(dropWaiter);
    expect(SCHEDULE.FIRST.holdWaiting).toBe(true);
    expect(SCHEDULE.MANUAL.holdWaiting).toBe(true);
    expect(SCHEDULE.FINAL.holdWaiting).toBe(false);
    expect(SCHEDULE.APPLY.holdWaiting).toBe(false);
    // 沒有 dropReview、沒開成（NONE）、已經有結果 → 不等
    expect(pushWaiting(sim.acct, notif())).toBe(false);
    set({ status: 'NONE' });
    expect(pushWaiting(sim.acct, notif())).toBe(false);
    set({ status: 'PENDING' });
    expect(pushWaiting(sim.acct, notif())).toBe(true);
    // 還在等的時候推出去：不標講過了
    dropWaiter.told!(sim.acct, notif());
    expect(sim.acct.own.MU.dropReview!.told).toBe(false);
    expect(dropWaiter.followUps!(sim.acct)).toEqual([]);
    // 結果回來（出清）：補推一行，補完標講過了（T82：原本用建議不動，那個狀態已經不會出現）
    set({ status: 'EXIT', premiseId: 'P1' });
    const f = dropWaiter.followUps!(sim.acct);
    expect(f.map((x) => [x.notif, x.text])).toEqual([[id, `MU 的 AI 論點檢查回來了：前提不成立，建議出清。通知 #${id} 已更新，預設仍是照規則。`]]);
    f[0].told(sim.acct);
    expect(sim.acct.own.MU.dropReview!.told).toBe(true);
    expect(dropWaiter.followUps!(sim.acct)).toEqual([]);
    // 出清的文字；同意減半、沒有結論不補推；已經回覆的不補推
    set({ status: 'EXIT', premiseId: 'P1' });
    expect(dropWaiter.followUps!(sim.acct)[0].text).toBe(dropFollowUpText('MU', 'EXIT', id));
    expect(dropFollowUpText('MU', 'EXIT', 12)).toBe('MU 的 AI 論點檢查回來了：前提不成立，建議出清。通知 #12 已更新，預設仍是照規則。');
    set({ status: 'AGREE', cause: 'SECTOR' });
    expect(dropWaiter.followUps!(sim.acct)).toEqual([]);
    set({ status: 'NONE' });
    expect(dropWaiter.followUps!(sim.acct)).toEqual([]);
    set({ status: 'EXIT', premiseId: 'P1' });
    sim.respond(id, { mode: 'DO' });
    expect(dropWaiter.followUps!(sim.acct)).toEqual([]);
    // 跟著通知推出去的結果：標講過了
    const b = muReduce();
    b.set({ status: 'AGREE', cause: 'SECTOR' });
    dropWaiter.told!(b.sim.acct, b.notif());
    expect(b.sim.acct.own.MU.dropReview!.told).toBe(true);
  });
});

// ================================================================ 整條流程（假的 EDGAR、雲端排程、LINE；世界在 test/helpers/dropWorld.ts，T82 的測試共用）

// T82（allocation_redesign §3.2）：這個世界的 NVDA 有兩條自己的前提，-20% 只觸發跌幅審查。下面幾個流程照新的效力表改：
// 每一個測試前面的註解寫原本的行為與改成什麼。推播時間（07:30 產生、09:30 推、之後補推）沒有變。
describe('T31b：整條流程——推播時間（own_thesis §3.5，修 K3；T82 起是跌幅審查）', () => {
  // 原本：23:30 產生「慢規則減半」的通知（預設照規則賣一半），01:30 三票不動、過了程式核對 → 多一個「照 AI：不動」，LINE 帶著賣單與那一行。
  // 現在：23:30 產生「跌幅審查」的通知（預設不動），01:30 三票不動、沒有前提被判不成立 → 仍是不動，LINE 一行說完、沒有賣單
  it('K3：23:30 開了跌幅審查還在等 → 通知產生但不推 LINE；01:30 套用（三票不動、沒有前提被判不成立）之後才推，一行說完不減半；03:30 不再補推', async () => {
    await withWorld(async ({ db, w, sec, run, acct }) => {
      await run('2026-11-20');
      crash(w, '2026-11-23');
      const r1 = await run('2026-11-23');
      const n = reduceNotif(await acct());
      expect(r1.created).toContain(n.id);
      expect(n.title).toBe('NVDA 跌幅審查');
      // 重現 K3：以前 07:30 就推 LINE，之後的結論只改網站
      expect(sec.line).toEqual([]);
      expect(r1.push).toMatchObject({ sent: 0, failed: 0, held: [n.id] });
      expect(await pushRows(db)).toEqual([]);
      const [drop] = await dropRuns(db);
      expect(drop).toMatchObject({ ticker: 'NVDA', status: 'PENDING', promptVersion: 'own_drop_v6' }); // T54：v3、T61：v4、T69：v5、T82：v6（題目改寫），推播時間照舊
      expect(drop.pack.policy).toMatchObject({ verdicts: ['EXIT', 'HALF', 'HOLD'], abstain: 'HOLD' });
      expect(drop.pack.question).toContain('跌幅只觸發這次審查，本身不是賣出的理由');
      const a0 = await acct();
      expect(a0.own.NVDA.dropReview).toMatchObject({ session: '2026-11-23', runId: drop.runId, status: 'PENDING', cause: null, premiseId: null, told: false, thesis: true, level: 0, days: 1, lastTry: '2026-11-23', sameDay: 1 });
      // 沒有減半：審查後持有，目標還是標準比重
      expect([a0.own.NVDA.slow.state, a0.rule.own.NVDA.applied, a0.own.NVDA.pending]).toEqual(['WATCH', 'STD', null]);
      expect(f7(a0)).toMatchObject({ aiLine: 'AI 論點檢查進行中，台灣 09:30 前更新；結果出來之前先不動', drop: 'PENDING', choice: 'SKIP', ruleChoice: 'RULE' });
      // 程式算的跌幅拆解照樣在證據包裡（現在只顯示，不拿來核對）
      const attr = (drop.pack.rule.detail as { attr: { stock: number; idio: number } }).attr;
      expect(attr.stock).toBeLessThan(-0.25);
      await postResult(db, drop.runId, holdVotes(drop.pack), new Date('2026-11-24T00:10:00Z'));
      // 01:30：套用之後推
      const r2 = await run('2026-11-23', 'FINAL');
      expect(r2.push.failed).toBe(0);
      expect(r2.push.held).toBeUndefined();
      const a = await acct();
      expect(f7(a).choices.map((c) => [c.id, c.label])).toEqual([
        ['SKIP', '不動'],
        ['RULE', '減半'],
      ]);
      expect(f7(a).aiLine).toMatch(/^論點檢查（3 票）：你的 2 條前提都沒有被判不成立。這次下跌：大盤 [+-]?\d+%、產業比大盤 -\d+%、個股自身 [+-]?\d+%$/);
      expect(f7(a)).toMatchObject({ drop: 'CLEAR', choice: 'SKIP' });
      expect(f7(a).reasonRequired).toBeUndefined();
      expect(a.own.NVDA.dropReview).toMatchObject({ status: 'CLEAR', cause: 'SECTOR', told: true });
      expect(a.own.NVDA.aiTier).toBeNull(); // 沒有前提不成立不寫 aiTier
      expect(notices(sec)).toHaveLength(1);
      const lines = notices(sec)[0].split('\n');
      expect(lines[0]).toMatch(/^【紙上】【當天】NVDA 比高點低 \d+\.\d%：論點檢查（3 票）前提都沒有被判不成立，不減半。不用下單；細節在網站。$/);
      expect(lines.some((l) => l.startsWith('賣 NVDA'))).toBe(false);
      expect(await pushRows(db)).toEqual([{ kind: 'NOTIF', ref: n.id, ok: 1 }]);
      // 03:30 與隔天：不重推、不補推
      await run('2026-11-23', 'APPLY');
      await run('2026-11-24');
      expect(notices(sec)).toHaveLength(1);
      expect(await pushRows(db)).toHaveLength(1);
    });
  });

  // 原本：逾時、沒開成、AI 層沒設定 → 沒有可用的結論，照規則減半。現在：沒跑完 → 不動；逾時的 01:30 重派一次（之後的重派與告警在 t82）
  it('跌幅審查逾時 → 沒跑完：01:30 照推（先不動；會再檢查）並重派一次；沒開成（雲端排程觸發失敗）與 AI 層沒設定 → 23:30 當場推，一樣不動', async () => {
    // 逾時：23:30 開了、一直沒有送回
    await withWorld(async ({ db, w, sec, run, acct }) => {
      await run('2026-11-20');
      crash(w, '2026-11-23', true);
      await run('2026-11-23');
      expect(sec.line).toEqual([]);
      await run('2026-11-23', 'FINAL');
      const runs = (await dropRuns(db)).sort((x, y) => x.createdAt.localeCompare(y.createdAt));
      expect(runs).toHaveLength(2);
      expect((await getRun(db, runs[0].runId))!.outcome!.status).toBe('TIMEOUT');
      expect(runs[1].status).toBe('PENDING');
      const a = await acct();
      expect(a.own.NVDA.dropReview).toMatchObject({ session: '2026-11-23', runId: runs[1].runId, status: 'PENDING', days: 1, sameDay: 2, told: false });
      expect(f7(a)).toMatchObject({ choice: 'SKIP', drop: 'PENDING' });
      expect([a.own.NVDA.slow.state, a.rule.own.NVDA.applied]).toEqual(['WATCH', 'STD']);
      expect(notices(sec)).toHaveLength(1);
      expect(notices(sec)[0]).toContain('AI 論點檢查還沒有結論，先不動；會再檢查。不用下單；細節在網站。');
      expect(notices(sec)[0]).not.toContain('賣 NVDA');
    });
    // 沒開成
    await withWorld(async ({ db, w, sec, run, acct }) => {
      await run('2026-11-20');
      crash(w, '2026-11-23', true);
      sec.fireDown = true;
      const r = await run('2026-11-23');
      expect((await acct()).own.NVDA.dropReview).toMatchObject({ session: '2026-11-23', status: 'NONE', told: true, thesis: true, days: 1, sameDay: 1 });
      expect(r.push).toMatchObject({ sent: 1 });
      expect(r.push.held).toBeUndefined();
      expect(sec.line[0]).toMatch(/NVDA 比高點低 \d+\.\d%：AI 論點檢查還沒有結論，先不動；會再檢查。/);
      expect(f7(await acct()).choices.map((c) => c.id)).toEqual(['SKIP', 'RULE']);
      expect((await dropRuns(db))[0].status).toBe('DONE');
    });
    // AI 層沒設定：不會有審查，也不會重派
    await withWorld(
      async ({ db, w, sec, run, acct }) => {
        await run('2026-11-20');
        crash(w, '2026-11-23', true);
        const r = await run('2026-11-23');
        expect(await dropRuns(db)).toEqual([]);
        expect((await acct()).own.NVDA.dropReview).toMatchObject({ session: '2026-11-23', runId: null, status: 'NONE', thesis: true, failed: true });
        expect(r.push).toMatchObject({ sent: 1 });
        expect(sec.line[0]).toMatch(/NVDA 比高點低 \d+\.\d%：AI 論點檢查沒有跑完，不動。不用下單；細節在網站。/);
      },
      { ai: false },
    );
  });

  // 原本：補推「建議不動。通知已更新，預設仍是照規則」。現在：補推「前提都沒有被判不成立，不減半。不用下單」
  it('第三次補推：23:30 沒跑成、01:30 才處理 → 還在等也照推（「還沒有結論，先不動」）；結果回來後 03:30 補推一行，只補一次', async () => {
    await withWorld(async ({ db, w, sec, run, acct }) => {
      await run('2026-11-20');
      crash(w, '2026-11-23');
      w.fail.add('NVDA');
      expect((await run('2026-11-23')).status).toBe('NO_SIGNAL');
      w.fail.clear();
      const r2 = await run('2026-11-23', 'FINAL');
      expect(r2.status).toBe('DONE');
      const n = reduceNotif(await acct());
      const [drop] = await dropRuns(db);
      expect(drop.status).toBe('PENDING');
      // 01:30 不等：照推，文字寫還沒有結論；還在等的不算講過
      const first = sec.line.find((t) => t.includes('NVDA 比高點低'))!;
      expect(first).toContain('AI 論點檢查還沒有結論，先不動；會再檢查');
      expect((await acct()).own.NVDA.dropReview).toMatchObject({ status: 'PENDING', told: false });
      // 結果回來（三票不動）→ 03:30 套用、補推一行
      await postResult(db, drop.runId, holdVotes(drop.pack), new Date('2026-11-24T02:00:00Z'));
      const r3 = await run('2026-11-23', 'APPLY');
      expect(r3.push.failed).toBe(0);
      expect(notices(sec).at(-1)).toBe(`【紙上】NVDA 的 AI 論點檢查回來了：前提都沒有被判不成立，不減半。不用下單；細節在通知 #${n.id}。\nhttps://bot.example/?openExternalBrowser=1#/n/${n.id}`);
      expect((await acct()).own.NVDA.dropReview).toMatchObject({ status: 'CLEAR', told: true });
      expect((await pushRows(db)).filter((p) => p.ref === n.id)).toEqual([
        { kind: 'NOTIF', ref: n.id, ok: 1 },
        { kind: 'FOLLOWUP', ref: n.id, ok: 1 },
      ]);
      // 之後不再補推
      await run('2026-11-24');
      await run('2026-11-24', 'FINAL');
      expect(sec.line.filter((t) => t.includes('AI 論點檢查回來了'))).toHaveLength(1);
      expect(notices(sec).filter((t) => t.includes('NVDA 比高點低'))).toHaveLength(1);
    });
  });
});

describe('T31b：整條流程——前提不成立、回應的紀錄、回覆之後才回來的結果（T82 起是跌幅審查）', () => {
  // 原本：預設照規則減半，三票出清多一個「照 AI：出清」。現在：三票判同一條前提不成立才會讓預設變成減半（狀態是前提不成立）；
  // 三票都選出清所以照樣多「照 AI：出清」。選了減半（沒有照 AI 出清）那條前提照舊進靜默期；回應記成 HALVED（以前是 RULE）
  it('三票出清（同一條前提、有申報引用）→ 前提不成立：預設減半、多「照 AI：出清」、寫 BREAK_NOTICE（withRule）、aiTier 記出清；這次不做沒寫理由送不出去；選減半 → RESPONSE（type R）與靜默期；改論點算「失效後修改」、不能用修正論點結案', async () => {
    await withWorld(async ({ db, w, sec, cik, run, acct, api }) => {
      await run('2026-11-20');
      crash(w, '2026-11-23', true);
      sec.cos.set(cik, [EIGHTK]);
      await run('2026-11-23');
      // 結果回來之前：預設不動、不用寫理由
      expect(f7(await acct())).toMatchObject({ choice: 'SKIP', drop: 'PENDING' });
      const [drop] = await dropRuns(db);
      await postResult(db, drop.runId, exitVotes(drop.pack), new Date('2026-11-24T00:10:00Z'));
      await run('2026-11-23', 'FINAL');
      let a = await acct();
      const n = reduceNotif(a);
      const shares = a.lots.own.NVDA;
      expect(f7(a).aiLine).toBe(`論點檢查（3 票）：前提「${P1}」不成立。AI 建議出清，賣 ${shares} 股`);
      expect(f7(a).choices.map((c) => [c.id, c.tier ?? null])).toEqual([['RULE', 'HALF'], ['AI', 'EXIT'], ['SKIP', null]]);
      expect(f7(a)).toMatchObject({ choice: 'RULE', drop: 'BROKEN', reasonRequired: true });
      expect(f7(a).brk).toEqual({ type: 'B', premiseId: 'P1', withRule: true });
      expect(a.own.NVDA.dropReview).toMatchObject({ status: 'BROKEN', exit: true, premiseId: 'P1', cause: 'FUNDAMENTAL', told: true });
      expect(a.own.NVDA.aiTier).toMatchObject({ tier: 'EXIT', premiseId: 'P1', trigger: 'DROP', suggest: false, agreed: true, runId: drop.runId });
      // 還沒照做：審查後持有
      expect([a.own.NVDA.slow.state, a.rule.own.NVDA.applied]).toEqual(['WATCH', 'STD']);
      const lines = notices(sec).at(-1)!.split('\n');
      expect(lines[0]).toBe('【紙上】【當天】NVDA 跌幅審查');
      expect(lines).toContain(DROP_LINE.BROKEN);
      expect(lines.some((l) => l.startsWith(`賣 NVDA ${Math.round(shares / 2)} 股`))).toBe(true);
      // 沒有另外發乙類通知；BREAK_NOTICE 寫一筆（withRule）
      expect(a.notifs.filter((x) => x.items.some((i) => i.f === 'F24'))).toEqual([]);
      expect(await logRows(db, 'BREAK_NOTICE')).toEqual([{ ref: String(n.id), session: '2026-11-23', body: { type: 'B', notif: n.id, runIds: [drop.runId], conditionId: null, premiseId: 'P1', tier: 'EXIT', sameDay: true, withRule: true } }]);
      // 再跑一次流程不會重寫
      await run('2026-11-23', 'APPLY');
      expect(await logRows(db, 'BREAK_NOTICE')).toHaveLength(1);
      // 改論點（保留 P1、P2）：不能勾「這是對通知的回應」；直接存的話算一次「失效後修改」，通知仍然等你決定
      const later = new Date('2026-11-24T04:00:00Z');
      const thesis = { ticker: 'NVDA', thesis: '資料中心的需求比我想的集中，但長期不變', premises: [{ id: 'P1', text: P1 }, { id: 'P2', text: '毛利率維持在 65% 以上' }], exitConditions: [], source: 'TYPED' };
      expect((await api('ops/own-thesis', { ...thesis, replyTo: n.id }, later)).status).toBe(409);
      expect((await api('ops/own-thesis', thesis, later)).status).toBe(200);
      a = await acct();
      expect(a.own.NVDA.thesis).toMatchObject({ afterBreak: 1, lastAfterBreakAt: '2026-11-23' });
      expect(reduceNotif(a).status).toBe('PENDING');
      // 這次不做沒寫理由：送不出去（單項與整則都是）
      const key = f7(a).key;
      expect((await api(`notif/${n.id}/respond`, { mode: 'DO', choices: { [key]: 'SKIP' } }, later)).status).toBe(422);
      expect((await api(`notif/${n.id}/respond`, { mode: 'SKIP' }, later)).status).toBe(422);
      // 減半（沒有照 AI 出清）
      expect((await api(`notif/${n.id}/respond`, { mode: 'DO' }, later)).status).toBe(200);
      a = await acct();
      expect(reduceNotif(a).status).toBe('RESPONDED');
      expect(a.own.NVDA.disputes).toMatchObject([{ premiseId: 'P1', since: '2026-11-23', reason: RULE_OVER_EXIT_REASON, notif: n.id }]);
      expect(await logRows(db, 'RESPONSE')).toEqual([{ ref: String(n.id), session: '2026-11-23', body: { notif: n.id, type: 'R', outcome: 'HALVED', reason: null, aiOffered: 'EXIT', premiseId: 'P1', runIds: [drop.runId] } }]);
    });
  });

  // 原本：使用者先選了照規則（減半），之後才回來的出清照 §1.9。現在預設是不動，所以「先選了減半」要自己點；之後才回來的出清照樣照 §1.9，
  // 而且不會為同一件事另外再發一張減半的單。（先選了不動、之後才判前提不成立的情況在 t82）
  it('回覆之後才回來的出清照 §1.9（你先選了減半）：30 天內沒發過 AI 的當天通知 → 當天發乙類；發過 → 記著進月報。已回覆的通知不動、不另外再發減半', async () => {
    for (const notified of [false, true]) {
      await withWorld(async ({ db, w, sec, cik, run, acct, api }) => {
        await run('2026-11-20');
        if (notified) {
          const l = (await loadAccount(db))!;
          l.acct.own.NVDA.aiNotifiedAt = '2026-11-10';
          await saveAccount(db, l.acct, l, '測試：之前發過 AI 的當天通知', new Date('2026-11-21T00:00:00Z'));
        }
        crash(w, '2026-11-23', true);
        sec.cos.set(cik, [EIGHTK]);
        await run('2026-11-23');
        const n = reduceNotif(await acct());
        const key = f7(await acct()).key;
        // 使用者在網站上看到就先決定自己減半，結果還沒回來
        expect((await api(`notif/${n.id}/respond`, { mode: 'DO', choices: { [key]: 'RULE' } })).status).toBe(200);
        expect((await acct()).own.NVDA.dropReview).toMatchObject({ status: 'PENDING' }); // 等你下單時留著
        const [drop] = await dropRuns(db);
        await postResult(db, drop.runId, exitVotes(drop.pack), new Date('2026-11-23T23:55:00Z'));
        const r2 = await run('2026-11-23', 'FINAL');
        const a = await acct();
        const rule = reduceNotif(a);
        expect(rule.status).toBe('RESPONDED');
        expect(rule.items[0].choices.map((c) => c.id)).toEqual(['SKIP', 'RULE']); // 已回覆的不動
        expect(a.notifs.filter((x) => x.items.some((i) => i.f === 'F7'))).toHaveLength(1); // 沒有另外再發減半
        const breaks = a.notifs.filter((x) => x.items.some((i) => i.f === 'F24' && i.brk?.type === 'B'));
        if (!notified) {
          expect(breaks).toHaveLength(1);
          expect(r2.created).toContain(breaks[0].id);
          expect(breaks[0]).toMatchObject({ kind: 'URGENT', status: 'PENDING', title: 'NVDA：AI 審查認為你的前提不成立' });
          expect(breaks[0].items[0]).toMatchObject({ brk: { type: 'B', premiseId: 'P1' }, choice: 'SKIP', runIds: [drop.runId] });
          expect(breaks[0].items[0].choices[0]).toMatchObject({ id: 'AI', tier: 'EXIT' });
          expect(a.own.NVDA.aiNotifiedAt).toBe('2026-11-23');
          expect(a.own.NVDA.aiTier).toMatchObject({ tier: 'EXIT', trigger: 'DROP', suggest: false });
          expect(sec.line.some((t) => t.includes('NVDA：AI 審查認為你的前提不成立'))).toBe(true);
          // 乙類自己的 BREAK_NOTICE（不是 withRule）
          expect((await logRows(db, 'BREAK_NOTICE')).map((l) => [l.ref, l.body.withRule ?? false])).toEqual([[String(breaks[0].id), false]]);
        } else {
          expect(breaks).toEqual([]);
          expect(a.own.NVDA.aiTier).toMatchObject({ tier: 'EXIT', trigger: 'DROP', suggest: true, premiseId: 'P1' });
        }
        // 跌幅審查的通知一直沒推（先回覆了，不再是等你決定）
        expect(notices(sec).some((t) => t.includes('NVDA 比高點低') || t.includes('NVDA 跌幅審查'))).toBe(false);
      });
    }
  });

  // 原本：選了照規則、之後回來「建議不動」→ 推一則提醒；選了這次不做 → 只放網站。現在：你自己先選了減半、之後回來「前提都沒有被判不成立」
  // → 推一則提醒（還沒下單可以回去改）；先選了不動（預設、不用理由）→ 結果只放網站，審查的結果留著給持股頁
  it('回覆之後才回來的「前提都沒有被判不成立」：你先選了減半、還沒填快照 → 推一則提醒；先選了不動 → 只放網站。改決定時那一行補上', async () => {
    // 先選了減半、還沒填快照
    await withWorld(async ({ db, w, sec, run, acct, api }) => {
      await run('2026-11-20');
      crash(w, '2026-11-23');
      await run('2026-11-23');
      const n = reduceNotif(await acct());
      const key = f7(await acct()).key;
      await api(`notif/${n.id}/respond`, { mode: 'DO', choices: { [key]: 'RULE' } });
      expect((await logRows(db, 'RESPONSE'))[0].body).toMatchObject({ type: 'R', outcome: 'HALVED', reason: null, aiOffered: null });
      const [drop] = await dropRuns(db);
      await postResult(db, drop.runId, holdVotes(drop.pack), new Date('2026-11-23T23:55:00Z'));
      const r2 = await run('2026-11-23', 'FINAL');
      const a = await acct();
      const info = a.notifs.find((x) => x.kind === 'INFO' && x.ref === n.id && x.title.includes('AI 論點檢查回來了'))!;
      expect(r2.created).toEqual([info.id]);
      expect(info.text).toBe(`NVDA 的 AI 論點檢查回來了：前提都沒有被判不成立（預設是不動）。你已經選了減半；還沒下單的話可以回${notifName(n)}改決定。`);
      expect(sec.line.some((t) => t.includes('你已經選了減半'))).toBe(true);
      expect(reduceNotif(a).items[0].choices.map((c) => c.id)).toEqual(['SKIP', 'RULE']); // 已回覆的不動
      expect(reduceNotif(a).items[0].choice).toBe('RULE');
      expect(a.own.NVDA.dropReview).toMatchObject({ status: 'CLEAR', told: true });
      // 回通知改決定：那一行補上，選項回到預設（不動）
      expect((await api(`notif/${n.id}/reopen`, {}, new Date('2026-11-24T02:00:00Z'))).status).toBe(200);
      const back = await acct();
      expect(reduceNotif(back).status).toBe('PENDING');
      expect(f7(back).choices.map((c) => c.id)).toEqual(['SKIP', 'RULE']);
      expect(f7(back).aiLine).toContain('都沒有被判不成立');
      expect(f7(back).choice).toBe('SKIP');
    });
    // 先選了不動（預設；不用寫理由）
    await withWorld(async ({ db, w, sec, run, acct, api }) => {
      await run('2026-11-20');
      crash(w, '2026-11-23');
      await run('2026-11-23');
      const n = reduceNotif(await acct());
      expect((await api(`notif/${n.id}/respond`, { mode: 'DO' })).status).toBe(200);
      // 審查的狀態留著（還在審查後持有；以前「這次不做」會清掉）
      expect((await acct()).own.NVDA.dropReview).toMatchObject({ status: 'PENDING' });
      expect((await acct()).own.NVDA.slow.state).toBe('WATCH');
      expect((await logRows(db, 'RESPONSE'))[0].body).toMatchObject({ type: 'R', outcome: 'KEPT', reason: null, aiOffered: null });
      const [drop] = await dropRuns(db);
      await postResult(db, drop.runId, holdVotes(drop.pack), new Date('2026-11-23T23:55:00Z'));
      const r2 = await run('2026-11-23', 'FINAL');
      expect(r2.created).toEqual([]);
      expect(notices(sec)).toEqual([]);
      const a = await acct();
      expect(reduceNotif(a).status).toBe('SKIPPED');
      expect(a.notifs.some((x) => x.title.includes('AI 論點檢查回來了'))).toBe(false);
      expect(a.own.NVDA.dropReview).toMatchObject({ status: 'CLEAR' });
    });
  });

  // 原本的結果是「建議不動」，現在是「前提都沒有被判不成立」；不動 aiTier 這一點沒有變。只有預設前提的那一半完全照舊
  it('月中記著等月報的建議不會被跌幅審查蓋掉（沒有前提不成立時不動 aiTier）；只有預設前提的股票整條流程照舊、不會出現「不動」', async () => {
    await withWorld(async ({ db, w, run, acct }) => {
      await run('2026-11-20');
      // 月中記著的建議（別條前提）
      const l = (await loadAccount(db))!;
      l.acct = recordAiTier(l.acct, 'NVDA', 'STANDARD', '2026-11-20', true, 'run-keep', { trigger: 'EARNINGS', agreed: true });
      await saveAccount(db, l.acct, l, '測試：月中記著的建議', new Date('2026-11-21T00:00:00Z'));
      crash(w, '2026-11-23');
      await run('2026-11-23');
      const [drop] = await dropRuns(db);
      await postResult(db, drop.runId, holdVotes(drop.pack), new Date('2026-11-24T00:10:00Z'));
      await run('2026-11-23', 'FINAL');
      const a = await acct();
      expect(a.own.NVDA.dropReview).toMatchObject({ status: 'CLEAR' });
      expect(a.own.NVDA.aiTier).toMatchObject({ tier: 'STANDARD', date: '2026-11-20', suggest: true, runId: 'run-keep' });
    });
    // 只有預設前提：規則照舊減半（當天通知、預設照規則）；證據包沒有 HOLD，三票硬寫 HOLD → 不合格 → 沒有可用的結論
    await withWorld(
      async ({ db, w, sec, run, acct }) => {
        await run('2026-11-20');
        crash(w, '2026-11-23');
        await run('2026-11-23');
        const a0 = await acct();
        expect(reduceNotif(a0).title).toBe('NVDA 慢規則減半');
        expect([a0.own.NVDA.slow.state, a0.rule.own.NVDA.applied, a0.own.NVDA.watchLevel]).toEqual(['HALF', 'HALF', undefined]);
        expect(a0.own.NVDA.dropReview).toEqual({ session: '2026-11-23', runId: expect.any(String), status: 'PENDING', cause: null, premiseId: null, told: false });
        expect(f7(a0)).toMatchObject({ aiLine: 'AI 論點檢查進行中，台灣 09:30 前更新', drop: 'PENDING', choice: 'RULE' });
        expect(f7(a0).thesisDrop).toBeUndefined();
        const [drop] = await dropRuns(db);
        expect(drop.pack.policy.verdicts).toEqual(['EXIT', 'HALF']);
        expect(drop.pack.question).toContain('這檔沒有使用者的論點，只能選照規則減半或出清');
        await postResult(db, drop.runId, holdVotes(drop.pack), new Date('2026-11-24T00:10:00Z'));
        await run('2026-11-23', 'FINAL');
        const a = await acct();
        expect(a.own.NVDA.dropReview).toMatchObject({ status: 'NONE' });
        expect(f7(a).choices.map((c) => c.id)).toEqual(['RULE', 'SKIP']);
        expect(f7(a).aiLine).toBe('AI 論點檢查沒有一致結論，照規則');
        expect(f7(a).why).toBe(REDUCE_WHY + DEFAULT_ONLY_WHY);
        const lines = notices(sec)[0].split('\n');
        expect(lines[0]).toBe('【紙上】【當天】NVDA 慢規則減半');
        expect(lines.some((l) => l.startsWith('賣 NVDA'))).toBe(true);
        expect(lines).toContain('AI 論點檢查沒有一致結論，照規則');
        // 沒跑完也不重派（重派只有有論點的股票的跌幅審查）
        expect(await dropRuns(db)).toHaveLength(1);
      },
      { defaultOnly: true },
    );
  });
});
