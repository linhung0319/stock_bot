// T32a 動能：修補（momentum_ai_design_2026-11-15 §5 的 T32a 那一列、§3.11）。
// 整條流程的部分（掃描標到的 8-K 原文、申報抓不到、先套用再出月報、事件 10 天過期）在 t11-ai.test.ts 的「T32a」那一段。
import { describe, expect, it } from 'vitest';
import { entryRuleVerdict, type EntryHit } from '../src/ai/momEntry';
import { accOf } from '../src/app/filings';
import { explainItem } from '../src/app/site/explain';
import { hardEvent, monthlyCandidates, monthlyReport, resumeMonthly, type Account, type Item, type MonthlyContext, type Notif } from '../src/engine';
import { ranksAt, viewAt } from './helpers/market';
import { scenarios } from './helpers/scenarios';
import { Sim } from './helpers/sim';

const item = (n: Notif, f: string, ticker: string): Item => n.items.find((i) => i.f === f && i.ticker === ticker)!;
const has = (n: Notif, f: string, ticker: string) => n.items.some((i) => i.f === f && i.ticker === ticker);

describe('T32a：accOf（申報編號正規化，修 Q1）', () => {
  it('規則分類的申報編號、每日掃描的 edgar: 前綴 → 申報；nasdaq-rss: → 新聞；price:、執行編號、空的 → 沒有原文', () => {
    expect(accOf('0001045810-26-000400')).toEqual({ kind: 'FILING', acc: '0001045810-26-000400' });
    expect(accOf('edgar:0001045810-26-000400')).toEqual({ kind: 'FILING', acc: '0001045810-26-000400' });
    expect(accOf('nasdaq-rss:AAPL:2026-11-23')).toEqual({ kind: 'NEWS' });
    expect(accOf('price:MU:2026-11-20')).toEqual({ kind: 'NONE' });
    expect(accOf('2026-11-20_OWN_DROP_NVDA_a1b2c3')).toEqual({ kind: 'NONE' });
    expect(accOf(undefined)).toEqual({ kind: 'NONE' });
  });
});

describe('T32a：申報抓不到不寫成沒命中（§3.3 表第 6 列）', () => {
  it('沒有命中而且申報抓不到 → 准許、資料缺漏、說明寫原因；有規則否決或要法庭的命中照舊；抓得到時照舊是固定的准許說明', () => {
    const v = entryRuleVerdict([], { filingsMissing: 'HTTP 503' });
    expect(v).toMatchObject({ decision: 'ALLOW', dataMissing: true, note: '申報抓不到（HTTP 503），這次沒有檢查申報類的失效模式，照規則進場' });
    const jump: EntryHit = { code: 'ONE_OFF_JUMP', sub: 'JUMP_SHARE', detail: '單日跳漲占 70%', byRule: false };
    expect(entryRuleVerdict([jump], { filingsMissing: 'HTTP 503' })).toMatchObject({ decision: 'COURT' });
    const sus: EntryHit = { code: 'DATA_SUSPECT', sub: 'PRICE_JUMP_NO_FILING', detail: 'x', byRule: true };
    expect(entryRuleVerdict([sus], { filingsMissing: 'HTTP 503' })).toMatchObject({ decision: 'BLOCK' });
    const ok = entryRuleVerdict([]);
    expect(ok.decision).toBe('ALLOW');
    expect(ok.dataMissing).toBeUndefined();
    expect(ok.note).toContain('規則偵測沒有命中任何失效模式');
  });
});

describe('T32a：動能持股的 AI 出場建議不先改名單（§3.5，修 Q11）', () => {
  const start = () => {
    const sc = scenarios.s4();
    const sim = new Sim(sc.market, sc.init);
    sim.runUntil('2026-12-10');
    sim.day();
    return sim;
  };
  const jan = (sim: Sim) => {
    sim.runUntil('2027-01-04');
    const input: MonthlyContext = { order: ranksAt(sim.market, sim.d - 1), month: sim.month };
    const candidates = monthlyCandidates(sim.acct, sim.pre, input);
    return { report: sim.preOpen()!, candidates, order: input.order };
  };

  it('選「不做」：名單不變；下個月月報沒有那一檔的賣單（第 7 名），在前 5 名的也不當成新進場再審一次', () => {
    const sim = start();
    for (const t of ['ORCL', 'AMD']) {
      const r = hardEvent(sim.acct, sim.pre, t, 'ACCOUNTING', false, [`run-f19-${t}`]);
      sim.acct = r.acct;
      const it19 = item(r.notif!, 'F19', t);
      expect(it19.choice).toBe('SKIP');
      expect(it19.choices[0]).toMatchObject({ id: 'AI', effects: [{ type: 'MOM_DROP', ticker: t }] });
      expect(sim.acct.rule.heldMom).toContain(t);
      sim.respond(r.notif!.id, { mode: 'SKIP' });
    }
    expect(sim.acct.rule.heldMom).toEqual(['PLTR', 'AVGO', 'NFLX', 'AMD', 'ORCL']);
    const { report, candidates, order } = jan(sim);
    expect(order.indexOf('ORCL') + 1).toBe(7);
    expect(order.indexOf('AMD') + 1).toBeLessThanOrEqual(5);
    expect(has(report, 'F2', 'ORCL')).toBe(false);
    expect(has(report, 'F1', 'AMD')).toBe(false);
    expect(candidates).not.toContain('AMD');
    expect(candidates).not.toContain('ORCL');
    expect(sim.acct.rule.heldMom).toEqual(expect.arrayContaining(['AMD', 'ORCL']));
  });

  it('選「照 AI」：賣出、填快照之後名單少一檔，下個月照排名遞補', () => {
    const sim = start();
    const r = hardEvent(sim.acct, sim.pre, 'ORCL', 'ACCOUNTING', false, ['run-f19']);
    sim.acct = r.acct;
    const it19 = item(r.notif!, 'F19', 'ORCL');
    sim.respond(r.notif!.id, { mode: 'DO', choices: { [it19.key]: 'AI' } });
    expect(sim.acct.rule.heldMom).toContain('ORCL'); // 回覆時還沒做，填快照才算
    sim.open();
    expect(sim.acct.lots.mom.ORCL).toBeUndefined();
    expect(sim.acct.rule.heldMom).toHaveLength(4);
    expect(sim.acct.rule.heldMom).not.toContain('ORCL');
    const { report } = jan(sim);
    expect(has(report, 'F2', 'ORCL')).toBe(false);
    expect(report.items.filter((i) => i.f === 'F1')).toHaveLength(1);
  });

  it('規則直接提出的（被收購方）照舊：當場從名單拿掉，沒有 MOM_DROP 效果', () => {
    const sim = start();
    const r = hardEvent(sim.acct, sim.pre, 'ORCL', 'PENDING_MA', true);
    expect(r.acct.rule.heldMom).not.toContain('ORCL');
    expect(item(r.notif!, 'F19', 'ORCL').choices[0].effects).toBeUndefined();
  });

  it('選項說明：動能的 AI 建議寫「不做 = 留在名單」', () => {
    const sim = start();
    const r = hardEvent(sim.acct, sim.pre, 'ORCL', 'ACCOUNTING', false, ['run-f19']);
    const ex = explainItem({ acct: r.acct, view: sim.pre, axis: [], rankOrder: [], aiNotes: [] } as never, r.notif!, item(r.notif!, 'F19', 'ORCL'));
    expect(ex.choiceNotes?.SKIP).toBe('不做：這一檔留在動能名單，之後照排名進出。同一類事件 180 天內不再通知。'); // T32c 補上後半句
    expect(ex.choiceNotes?.AI).toContain('離開動能名單');
  });
});

describe('T32a：月報暫停後重算時，依波動度減碼用訊號日的值（§3.11）', () => {
  it('暫停期間超額波動越過門檻 → 重算後的減碼和訊號日相同；排除後重算也一樣；沒有這個欄位的舊月報照舊當場算', () => {
    const sc = scenarios.s4();
    const sim = new Sim(sc.market, sc.init);
    sim.runUntil('2027-01-04');
    const input: MonthlyContext = { order: ranksAt(sim.market, sim.d - 1), month: sim.month };
    // 訊號日沒有暫停時的結果
    const direct = monthlyReport(sim.acct, sim.pre, input);
    const sigma = direct.notif.monthly!.input.excessVol!;
    expect(sigma).toBeGreaterThan(0);
    expect(direct.plan!.vol!.w).toBe(1);
    // 有未分類的變動 → 暫停；暫停那一則已經記下訊號日的超額波動
    const blocked: Account = { ...sim.acct, lots: { ...sim.acct.lots, unc: { NFLX: 1 } } };
    const paused = monthlyReport(blocked, sim.pre, input);
    expect(paused.notif.title).toContain('月報暫停');
    expect(paused.notif.monthly!.input.excessVol).toBeCloseTo(sigma, 12);
    // 暫停期間動能持股大起大落：用重算那天的資料算會減碼到 0
    for (const t of sim.acct.rule.heldMom) for (let k = 0; k < 5; k++) sim.market.close[t][sim.d + k] = sim.market.close[t][sim.d - 1] * (k % 2 ? 1.25 : 0.8);
    const later = viewAt(sim.market, sim.d + 4);
    const classified: Account = { ...paused.acct, lots: { ...paused.acct.lots, unc: {} } };
    const live = monthlyReport(classified, later, input); // 舊月報（沒有 excessVol）：當場算
    expect(live.plan!.vol!.w).toBe(0);
    // 重算：和訊號日相同
    const resumed = resumeMonthly(classified, later);
    // T80（allocation_redesign §1.2）：這個月沒有規則單；以前帳上的閒置現金會單獨成一項（MONTHLY），現在現金算 SGOV 那一邊、不為它發單 → 本月不用動
    expect(resumed.notif!.kind).toBe('MONTHLY_EMPTY');
    expect(resumed.notif!.title).not.toContain('月報暫停');
    expect(resumed.acct.rule.volW).toBe(direct.acct.rule.volW);
    expect(resumed.acct.rule.volHist.at(-1)).toBeCloseTo(sigma, 12);
    expect(resumed.notif!.monthly!.input.excessVol).toBeCloseTo(sigma, 12);
    // 同一份月報之後再重算（排除、入金合併都是拿 monthly.input 再跑一次）也一樣
    const again = monthlyReport({ ...classified, rule: resumed.notif!.monthly!.before.rule }, later, resumed.notif!.monthly!.input);
    expect(again.plan!.vol!.w).toBe(1);
    // 算不出來（null）→ 照「算不出來」處理，和第一次相同
    const nan = monthlyReport(classified, later, { ...input, excessVol: null });
    expect(nan.notif.monthly!.input.excessVol).toBeNull();
  });
});
