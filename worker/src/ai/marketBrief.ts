// T64：綜合層的市場摘要（MARKET_BRIEF；設計 docs/design/composite_layer_design_2026-11-21.md 第 1 章 §1.1～§1.5）。
// 這個檔是純函式：不讀網路、不讀時鐘、不碰儲存。排程端（觸發的紀錄、開執行、結算）在 src/app/marketBrief.ts。
//
//   定位（§1.1）：一個新的 AI 功能，只說明——不下單、不改任何狀態、不發要操作的通知。等級比照草稿（A2，一份，不是三票）。
//     它回答個股層答不了、而且每一檔都會重複問的事：這幾天大盤或某個族群為什麼大幅波動。
//     市場摘要不能當前提不成立的依據（設計第 6 章、G12）：它的引用只證明「報導這樣寫」。分給個股、顯示（T65）：briefNoteDoc、briefLine。
//   觸發（§1.2）：priceTriggers（大盤單日、族群單日、累積）＋當天有減半檢視或提前審查；歸到哪個事件 assignTriggers；開不開 planOpen。
//   證據包（§1.3、§1.4）：briefFacts（程式算的數字，K 開頭）＋排程端準備的價格表、總經儀表板、新聞標題、目錄；marketBriefPack。
//   輸出檢查（§1.5）：checkBrief。引用照 check.ts 的同一個逐字檢查（check.ts 沒有動）；這裡只檢查 payload 的固定欄位。
import { webMetaOf } from './added';
import { normalizeText, type CheckedSample, type EvidencePack, type Outcome, type PackDoc } from './check';
import { buildPack } from './pack';

export const MARKET_BRIEF = 'MARKET_BRIEF';
export const MARKET_BRIEF_PROMPT = 'market_brief_v1';
/** 研究員取的網頁存進 web_docs 時的「代號」：市場摘要不屬於任何一檔。 */
export const MARKET_DOC_TICKER = '_MARKET';

/** 門檻與次數（§1.2；都是建議值，§5.2 用 2008～2026 的日線數過）。 */
export const BRIEF = {
  /** 大盤大漲跌：核心 ETF 單日漲跌幅的絕對值。 */
  marketDay: 0.025,
  /** 族群大漲跌：持股的產業 ETF 單日比大盤多跌或多漲幾個百分點。 */
  groupDay: 0.03,
  /** 累積：核心 ETF 幾個交易日跌多少，而且這段期間還沒有開過摘要。 */
  cumDays: 21,
  cumDrop: -0.1,
  /** 當天有減半檢視或提前審查要開：最近幾個交易日沒有摘要才算。 */
  aiQuietDays: 5,
  /** 頻率上限：幾個交易日內最多 1 份暫定稿；暫定稿之後這幾個交易日內又觸發的算同一個事件。 */
  gapDays: 10,
  /** 定稿：最後一次觸發之後第幾個交易日。 */
  finalAfterDays: 10,
  /** 暫定稿沒開成（或失敗）時，最後一次觸發之後幾個交易日內還會再試；過了就等定稿。 */
  provLateDays: 2,
  /** 定稿到期之後幾個交易日內還會再試；過了就不寫。 */
  finalLateDays: 5,
  /** 同一個事件的暫定稿、定稿各最多試幾次（含失敗的）。 */
  maxTries: 2,
  /** 流程漏跑時往回補看幾個交易日的觸發。 */
  scanBackDays: 10,
  /** 研究員取的網頁，發布日最早可以比期間的起點早幾個日曆天。 */
  webBeforeDays: 7,
} as const;

export type BriefStage = 'PROVISIONAL' | 'FINAL';
export type BriefTriggerKind = 'MARKET_DAY' | 'GROUP_DAY' | 'CUMULATIVE' | 'AI_RUN' | 'MANUAL';
export const TRIGGER_TEXT: Record<BriefTriggerKind, string> = { MARKET_DAY: '大盤大漲跌', GROUP_DAY: '族群大漲跌', CUMULATIVE: '大盤累積下跌', AI_RUN: '當天有減半檢視或提前審查', MANUAL: '手動' };

export interface BriefTrigger {
  session: string;
  kind: BriefTriggerKind;
  /** 產業 ETF（GROUP_DAY）；其他是 null。 */
  group: string | null;
  /** 觸發的數字：單日漲跌、比大盤多漲跌、21 日漲跌（小數）；沒有數字的是 null。 */
  value: number | null;
  /** 白話的一句。 */
  text: string;
}

const EPS = 1e-9;
/** +2.8%、-3.6%。 */
export const pct = (x: number): string => `${x >= 0 ? '+' : '-'}${Math.abs(x * 100).toFixed(1)}%`;
/** 比大盤「多跌 3.2 個百分點」「多漲 1.0 個百分點」；差不到 0.05 個百分點寫「和大盤相同」。 */
const vsCore = (d: number, core: string): string => (Math.abs(d * 100) < 0.05 ? `和 ${core} 相同` : `比 ${core} ${d < 0 ? '多跌' : '多漲'} ${Math.abs(d * 100).toFixed(1)} 個百分點`);
const fin = (x: number | undefined): x is number => typeof x === 'number' && Number.isFinite(x);
function ret(c: ArrayLike<number> | undefined, a: number, b: number): number | null {
  if (!c || a < 0 || b < 0 || !fin(c[a]) || !fin(c[b]) || c[a] <= 0) return null;
  return c[b] / c[a] - 1;
}

// ---------------------------------------------------------------- 觸發（§1.2）

/**
 * 位置 i 那一天，價格類的觸發成不成立（規則判斷，不靠 AI）：
 *   MARKET_DAY  核心 ETF 單日漲跌幅絕對值 ≥ 2.5%
 *   GROUP_DAY   持股的產業 ETF 單日比大盤多跌或多漲 ≥ 3 個百分點（groups：持股所屬的產業 ETF）
 *   CUMULATIVE  核心 ETF 21 個交易日跌 ≥ 10%（「這段期間還沒有開過摘要」由 assignTriggers 判斷）
 */
export function priceTriggers(axis: string[], close: Record<string, ArrayLike<number>>, i: number, core: string, groups: readonly string[]): BriefTrigger[] {
  const out: BriefTrigger[] = [];
  const session = axis[i];
  if (!session) return out;
  const day = ret(close[core], i - 1, i);
  if (day !== null && Math.abs(day) >= BRIEF.marketDay - EPS) out.push({ session, kind: 'MARKET_DAY', group: null, value: day, text: `${core} ${session} 單日 ${pct(day)}（門檻 ${(BRIEF.marketDay * 100).toFixed(1)}%）` });
  if (day !== null) {
    for (const g of [...new Set(groups)].sort()) {
      const r = ret(close[g], i - 1, i);
      if (r === null || Math.abs(r - day) < BRIEF.groupDay - EPS) continue;
      out.push({ session, kind: 'GROUP_DAY', group: g, value: r - day, text: `${g} ${session} 單日 ${pct(r)}，${vsCore(r - day, core)}（門檻 ${(BRIEF.groupDay * 100).toFixed(0)} 個百分點）` });
    }
  }
  const cum = ret(close[core], i - BRIEF.cumDays, i);
  if (cum !== null && cum <= BRIEF.cumDrop + EPS) out.push({ session, kind: 'CUMULATIVE', group: null, value: cum, text: `${core} 到 ${session} 為止的 ${BRIEF.cumDays} 個交易日 ${pct(cum)}（門檻 ${(BRIEF.cumDrop * 100).toFixed(0)}%）` });
  return out;
}

/** 當天有減半檢視或提前審查要開（§1.2 第四種）；「最近 5 個交易日沒有摘要」由 assignTriggers 判斷。 */
export const aiRunTrigger = (session: string, runIds: readonly string[]): BriefTrigger => ({ session, kind: 'AI_RUN', group: null, value: null, text: `${session} 開了減半檢視或提前審查（${runIds.join('、')}）` });

/** 一份摘要（market_briefs 的一列）在排程判斷時要看的欄位。手動開的不放進來（不佔頻率上限、不屬於任何事件）。 */
export interface BriefRowLite {
  eventId: string;
  stage: BriefStage;
  session: string;
  status: 'PENDING' | 'READY' | 'FAILED';
}

/** 一個事件：一串觸發，每一次都在前一次之後 10 個交易日內。id 是第一次觸發的訊號日。 */
export interface BriefEvent {
  id: string;
  first: string;
  last: string;
}

/** from 到 to 隔幾個交易日（同一天是 0；from 比 to 晚也是 0）。 */
export type TradingGap = (from: string, to: string) => number;

const alive = (b: BriefRowLite) => b.status !== 'FAILED';

/**
 * 這一天成立的觸發裡哪幾個算數、歸到哪個事件（§1.2、§5.2）。沒有算數的回 null。
 *   CUMULATIVE  最近 21 個交易日開過摘要（不管成功失敗）就不算
 *   AI_RUN      最近 5 個交易日有摘要（還在跑或寫好的）就不算
 *   事件        最近一個事件的最後一次觸發在 10 個交易日內、而且它還沒有開過定稿 → 算同一個事件（定稿往後延）；否則是新的事件
 */
export function assignTriggers(day: string, found: readonly BriefTrigger[], latest: BriefEvent | null, briefs: readonly BriefRowLite[], gap: TradingGap): { eventId: string; triggers: BriefTrigger[] } | null {
  const before = briefs.filter((b) => b.session <= day);
  const within = (rows: readonly BriefRowLite[], n: number) => rows.some((b) => gap(b.session, day) <= n);
  const keep = found.filter((t) => {
    if (t.kind === 'CUMULATIVE') return !within(before, BRIEF.cumDays);
    if (t.kind === 'AI_RUN') return !within(before.filter(alive), BRIEF.aiQuietDays);
    return true;
  });
  if (!keep.length) return null;
  const closed = !!latest && briefs.some((b) => b.eventId === latest.id && b.stage === 'FINAL');
  const joins = !!latest && !closed && latest.last <= day && gap(latest.last, day) <= BRIEF.gapDays;
  return { eventId: joins ? latest!.id : day, triggers: keep };
}

export interface BriefOpen {
  eventId: string;
  stage: BriefStage;
  why: string;
}

/**
 * 這個訊號日要不要開一次市場摘要、開哪一種（§1.2）。一個訊號日最多開一次（開了失敗的，同一天最多再試一次）。
 *   暫定稿  最近一個事件當天有觸發（或最後一次觸發在 2 個交易日內、而它一份暫定稿都還沒有：前一次沒開成或失敗了）、它還沒有開過定稿、
 *           最近 10 個交易日沒有還在跑或寫好的暫定稿（頻率上限；被上限擋下的觸發之後不補開）、這個事件的暫定稿失敗不到 2 次
 *   定稿    事件的最後一次觸發之後滿 10 個交易日（最多再晚 5 個交易日）、沒有還在跑或寫好的定稿、失敗不到 2 次
 * 兩個同時成立時先開暫定稿（定稿下一個訊號日再開）。
 */
export function planOpen(session: string, events: readonly BriefEvent[], briefs: readonly BriefRowLite[], gap: TradingGap): { open: BriefOpen | null; log: string[] } {
  const log: string[] = [];
  const today = briefs.filter((b) => b.session === session);
  if (today.some(alive)) return { open: null, log };
  if (today.length >= BRIEF.maxTries) return { open: null, log: [`市場摘要：今天已經試了 ${today.length} 次都沒有成功，不再開`] };
  const of = (id: string, stage: BriefStage) => briefs.filter((b) => b.eventId === id && b.stage === stage);
  const sorted = [...events].filter((e) => e.last <= session).sort((a, b) => a.last.localeCompare(b.last));
  const latest = sorted.at(-1);
  if (latest && gap(latest.last, session) <= BRIEF.provLateDays && !of(latest.id, 'FINAL').length) {
    const provs = of(latest.id, 'PROVISIONAL');
    const fails = provs.filter((b) => !alive(b)).length;
    const recent = briefs.filter((b) => b.stage === 'PROVISIONAL' && alive(b) && b.session <= session && gap(b.session, session) < BRIEF.gapDays);
    const fresh = latest.last === session;
    if (recent.length) {
      if (fresh) log.push(`市場摘要：今天有觸發，但 ${recent[0].session} 已經有一份暫定稿（${BRIEF.gapDays} 個交易日內最多 1 份），算進同一個事件、定稿往後延`);
    } else if (!fresh && provs.some(alive)) {
      // 前幾天的觸發當時被頻率上限擋下（這個事件已經有暫定稿）：上限過了也不補開，等下一次觸發或定稿
    } else if (fails >= BRIEF.maxTries) log.push(`市場摘要：事件 ${latest.id} 的暫定稿已經失敗 ${fails} 次，不再開（定稿到期時照寫）`);
    else return { open: { eventId: latest.id, stage: 'PROVISIONAL', why: fails ? `事件 ${latest.id} 的暫定稿上一次沒有成功，再試一次` : `事件 ${latest.id}（最後一次觸發 ${latest.last}）` }, log };
  }
  for (const e of sorted) {
    const waited = gap(e.last, session);
    if (waited < BRIEF.finalAfterDays || waited > BRIEF.finalAfterDays + BRIEF.finalLateDays) continue;
    const finals = of(e.id, 'FINAL');
    if (finals.some(alive)) continue;
    if (finals.length >= BRIEF.maxTries) {
      log.push(`市場摘要：事件 ${e.id} 的定稿已經失敗 ${finals.length} 次，不再開`);
      continue;
    }
    return { open: { eventId: e.id, stage: 'FINAL', why: `事件 ${e.id} 最後一次觸發（${e.last}）之後第 ${waited} 個交易日${finals.length ? '；上一次沒有成功，再試一次' : ''}` }, log };
  }
  return { open: null, log };
}

/**
 * 摘要涵蓋的期間（§1.2「期間往前涵蓋」、§1.5 的 period）：from 是這個事件每一次觸發的「起算日」裡最早的——
 * 單日的觸發是前一個交易日（那天的收盤是漲跌的基準），累積、當天有個股執行、手動的是 21 個交易日前；to 是決策日。
 */
export function briefPeriod(axis: string[], triggers: readonly Pick<BriefTrigger, 'session' | 'kind'>[], asOf: string): { from: string; to: string } {
  const end = axis.indexOf(asOf);
  let from = end < 0 ? axis.length - 1 : end;
  for (const t of triggers) {
    const k = axis.indexOf(t.session);
    const back = t.kind === 'MARKET_DAY' || t.kind === 'GROUP_DAY' ? 1 : BRIEF.cumDays;
    from = Math.min(from, Math.max(0, (k < 0 ? 0 : k) - back));
  }
  return { from: axis[Math.max(0, from)] ?? asOf, to: asOf };
}

// ---------------------------------------------------------------- 證據包（§1.3、§1.4）

export interface BriefGroup {
  /** 產業 ETF（flow_state 的 sector:<代號>，從 SIC 對出來的）。 */
  etf: string;
  members: { ticker: string; role: 'OWN' | 'MOM' }[];
}

type Fact = EvidencePack['facts'][number];
const ROLE_TEXT = { OWN: '自選', MOM: '動能' } as const;
/** 單日的數字最多列幾個觸發日（新的在前）；漲跌最大的持股列幾檔。 */
const FACT_DAYS = 6;
const FACT_MOVERS = 5;

export interface BriefFactsInput {
  axis: string[];
  close: Record<string, ArrayLike<number>>;
  /** 決策日在 axis 的位置。 */
  i: number;
  core: string;
  groups: BriefGroup[];
  /** 持股裡沒有對到產業 ETF 的。 */
  ungrouped: { ticker: string; role: 'OWN' | 'MOM' }[];
  /** 股票池（排名用的那 50 檔）。 */
  universe: string[];
  period: { from: string; to: string };
  triggers: BriefTrigger[];
}

/**
 * 程式算的數字（§1.3）。編號：
 *   K  大盤與族群的漲跌、股票池下跌的比例——value 是一句完整的話，摘要的 facts 只能從這幾句原樣抄
 *   G  哪幾檔持股屬於哪個族群（只有代號，沒有金額與股數）
 *   H  這段期間漲跌最大的幾檔持股（給研究員當線索；摘要不細到個股，不能抄進 facts）
 *   T  這個事件的每一次觸發
 * movers：H 那幾檔的代號（排程端替它們各附一份價格表）。
 */
export function briefFacts(inp: BriefFactsInput): { facts: Fact[]; movers: string[] } {
  const { axis, close, i, core, period } = inp;
  const a = Math.max(0, axis.indexOf(period.from));
  const span = `${period.from}～${period.to}`;
  const k: string[] = [];
  const c = close[core];
  const whole = ret(c, a, i);
  if (whole !== null) k.push(`${core} ${span} 漲跌 ${pct(whole)}`);
  const days = [...new Set(inp.triggers.filter((t) => t.kind === 'MARKET_DAY' || t.kind === 'GROUP_DAY').map((t) => t.session))].sort().reverse().slice(0, FACT_DAYS);
  for (const d of days) {
    const j = axis.indexOf(d);
    const r = ret(c, j - 1, j);
    if (r !== null) k.push(`${core} ${d} 單日 ${pct(r)}`);
  }
  const cum = ret(c, i - BRIEF.cumDays, i);
  if (cum !== null) k.push(`${core} 到 ${period.to} 為止的 ${BRIEF.cumDays} 個交易日 ${pct(cum)}`);
  if (c && fin(c[i])) {
    let hi = -Infinity;
    for (let j = Math.max(0, i - 251); j <= i; j++) if (fin(c[j]) && c[j] > hi) hi = c[j];
    if (hi > 0) k.push(`${core} ${period.to} 的收盤距 52 週高點 ${pct(c[i] / hi - 1)}`);
  }
  // 股票池下跌的比例：整段期間，以及大盤大漲跌的那幾天
  const share = (from: number, to: number): { n: number; down: number } => {
    let n = 0;
    let down = 0;
    for (const t of inp.universe) {
      const r = ret(close[t], from, to);
      if (r === null) continue;
      n++;
      if (r < 0) down++;
    }
    return { n, down };
  };
  const all = share(a, i);
  if (all.n && a < i) k.push(`股票池 ${all.n} 檔裡，${span} 下跌的有 ${((all.down / all.n) * 100).toFixed(0)}%`);
  for (const d of [...new Set(inp.triggers.filter((t) => t.kind === 'MARKET_DAY').map((t) => t.session))].sort().reverse().slice(0, FACT_DAYS)) {
    const j = axis.indexOf(d);
    const s = j > 0 ? share(j - 1, j) : { n: 0, down: 0 };
    if (s.n) k.push(`股票池 ${s.n} 檔裡，${d} 下跌的有 ${((s.down / s.n) * 100).toFixed(0)}%`);
  }
  // 每個持股族群：整段期間，以及它自己觸發的那幾天
  for (const g of inp.groups) {
    const r = ret(close[g.etf], a, i);
    if (r !== null && whole !== null) k.push(`${g.etf} ${span} 漲跌 ${pct(r)}，${vsCore(r - whole, core)}`);
    for (const d of [...new Set(inp.triggers.filter((t) => t.kind === 'GROUP_DAY' && t.group === g.etf).map((t) => t.session))].sort().reverse().slice(0, FACT_DAYS)) {
      const j = axis.indexOf(d);
      const rg = ret(close[g.etf], j - 1, j);
      const rc = ret(c, j - 1, j);
      if (rg !== null && rc !== null) k.push(`${g.etf} ${d} 單日 ${pct(rg)}，${vsCore(rg - rc, core)}`);
    }
  }
  const names = (ms: BriefGroup['members']) => ms.map((m) => `${m.ticker}（${ROLE_TEXT[m.role]}）`).join('、');
  const movers = [...inp.groups.flatMap((g) => g.members.map((m) => ({ ...m, etf: g.etf as string | null }))), ...inp.ungrouped.map((m) => ({ ...m, etf: null as string | null }))]
    .map((m) => ({ ...m, r: ret(close[m.ticker], a, i) }))
    .filter((m): m is typeof m & { r: number } => m.r !== null)
    .sort((x, y) => Math.abs(y.r) - Math.abs(x.r) || x.ticker.localeCompare(y.ticker))
    .slice(0, FACT_MOVERS);
  const facts: Fact[] = [
    ...k.map((value, n) => ({ id: `K${n + 1}`, label: '程式算的數字（摘要的 facts 只能從 K 開頭的原樣抄）', value })),
    ...inp.groups.map((g, n) => ({ id: `G${n + 1}`, label: '持股所屬的族群（產業 ETF）', value: `${g.etf}：${names(g.members)}` })),
    ...(inp.ungrouped.length ? [{ id: `G${inp.groups.length + 1}`, label: '沒有對到產業 ETF 的持股', value: names(inp.ungrouped) }] : []),
    ...movers.map((m, n) => ({ id: `H${n + 1}`, label: '這段期間漲跌最大的持股（線索；摘要不細到個股）', value: `${m.ticker}${m.etf ? `（${m.etf}）` : ''} ${span} 漲跌 ${pct(m.r)}` })),
    ...inp.triggers.map((t, n) => ({ id: `T${n + 1}`, label: `觸發：${TRIGGER_TEXT[t.kind]}`, value: t.text })),
  ];
  return { facts, movers: movers.map((m) => m.ticker) };
}

/** 證據包的 rule.detail（程式檢查與結算讀）。 */
export interface BriefDetail {
  stage: BriefStage;
  eventId: string;
  period: { from: string; to: string };
  core: string;
  /** 持股所屬的產業 ETF：causes 的 group 只能寫這幾個。 */
  groups: string[];
  triggers: BriefTrigger[];
  /** 定稿的證據包裡有沒有附這個事件的暫定稿（有的話 changed_since_provisional 必填）。 */
  hasProvisional: boolean;
  manual?: boolean;
  /** 清單內的網頁來源（共用清單）。 */
  webDomains?: string[];
}

export interface MarketBriefInput {
  runId: string;
  asOf: string;
  stage: BriefStage;
  eventId: string;
  period: { from: string; to: string };
  core: string;
  groups: BriefGroup[];
  triggers: BriefTrigger[];
  facts: Fact[];
  docs: PackDoc[];
  dataQuality: EvidencePack['data_quality'];
  /** 定稿：這個事件寫好的暫定稿（當背景附上，不能當引用）。 */
  provisional: MarketBrief | null;
  webDomains: string[];
  manual?: boolean;
  now: Date;
}

/** 這個事件的暫定稿 → 定稿證據包裡的一份背景（kind = note：不能當引用，checkBrief 會拿掉）。 */
export function provisionalDoc(b: MarketBrief, asOf: string): PackDoc {
  return { id: 'PREV', source_id: `brief-prev:${b.event_id}`, kind: 'note', date: asOf, title: `這個事件的暫定稿（${b.as_of} 寫的；背景，不是證據，不能引用）`, text: briefText(b) };
}

export function marketBriefPack(inp: MarketBriefInput) {
  const etfs = inp.groups.map((g) => g.etf);
  const span = `${inp.period.from}～${inp.period.to}`;
  const detail: BriefDetail = {
    stage: inp.stage,
    eventId: inp.eventId,
    period: inp.period,
    core: inp.core,
    groups: etfs,
    triggers: inp.triggers,
    hasProvisional: !!inp.provisional,
    ...(inp.manual ? { manual: true } : {}),
    ...(inp.webDomains.length ? { webDomains: inp.webDomains } : {}),
  };
  return buildPack({
    runId: inp.runId,
    fn: MARKET_BRIEF,
    promptVersion: MARKET_BRIEF_PROMPT,
    asOf: inp.asOf,
    subject: { name: `市場摘要（${inp.stage === 'FINAL' ? '定稿' : '暫定稿'}）` },
    question:
      `這段期間（${span}）大盤${etfs.length ? `或持股所屬的族群（${etfs.join('、')}）` : ''}大幅波動，或有個股的檢視需要背景。` +
      `請整理：大盤（${inp.core}）${etfs.length ? '與這幾個族群' : ''}這段期間為什麼大幅波動——報導怎麼說、各來源的說法一致不一致。` +
      '這份摘要只說明：不下單、不改任何狀態、不談任何一檔股票該不該買賣，也不細到個股（個股自己的事由個股的審查處理）。' +
      '引用逐字對得上只證明「報導這樣寫」，不證明因果，所以原因一律寫成報導的說法；沒有找到說得通的原因就寫原因不明（unknown = true），這是合格的答案，不算失敗。' +
      (inp.stage === 'FINAL'
        ? `這是定稿（最後一次觸發之後第 ${BRIEF.finalAfterDays} 個交易日再看一次）：當天的解釋常是事後配的說法，資金面的原因要幾週後才確認。${inp.provisional ? '對照附上的暫定稿（背景，不能引用），在 changed_since_provisional 寫明和它不同的地方。' : '這個事件沒有寫成暫定稿。'}`
        : '這是暫定稿：資金面的原因（去槓桿、部位擁擠，kind = FLOW）信心只能寫 LOW。'),
    policy: { level: 'A2', verdicts: ['DONE', 'INSUFFICIENT'], abstain: 'INSUFFICIENT', min_evidence: 0, samples: 1 },
    rule: { action: '只說明（市場摘要：不下單、不改任何狀態、不發要操作的通知）', detail },
    facts: inp.facts,
    premises: [],
    documents: [...inp.docs, ...(inp.provisional ? [provisionalDoc(inp.provisional, inp.asOf)] : [])],
    dataQuality: inp.dataQuality,
    conditionTypes: [],
    now: inp.now,
  });
}

// ---------------------------------------------------------------- 輸出（§1.5）

export const CAUSE_SCOPES = ['MARKET', 'GROUP'] as const;
export const CAUSE_KINDS = ['MACRO_DATA', 'POLICY', 'EARNINGS', 'SECTOR_NEWS', 'FLOW', 'GEOPOLITICS', 'OTHER'] as const;
export const CONFIDENCES = ['HIGH', 'MEDIUM', 'LOW'] as const;
export const CLARITIES = ['HIGH', 'LOW'] as const;
export const CAUSE_KIND_TEXT: Record<(typeof CAUSE_KINDS)[number], string> = { MACRO_DATA: '總經數據', POLICY: '政策', EARNINGS: '財報', SECTOR_NEWS: '族群消息', FLOW: '資金面', GEOPOLITICS: '地緣政治', OTHER: '其他' };
export const CONFIDENCE_TEXT: Record<(typeof CONFIDENCES)[number], string> = { HIGH: '高', MEDIUM: '中', LOW: '低' };

/** 條數與字數上限。 */
export const BRIEF_LIMITS = { facts: 12, causes: 6, causeText: 200, changed: 600 } as const;

export interface BriefCause {
  scope: (typeof CAUSE_SCOPES)[number];
  /** 產業 ETF（scope 是 GROUP 時）；大盤的是 null。 */
  group: string | null;
  kind: (typeof CAUSE_KINDS)[number];
  /** 一句：報導說的原因。顯示時一律標成「報導的說法」。 */
  text: string;
  /** 程式檢查之後的信心（可能比 AI 寫的低，見 lowered）。 */
  confidence: (typeof CONFIDENCES)[number];
  /** 通過逐字檢查的引用（對到 evidence 的 id）。 */
  evidence_ids: string[];
  /** 引用全部是新聞標題（沒有讀到全文）：只能當線索。 */
  headline_only: boolean;
  /** 信心被程式調低的原因；沒有調是 null。 */
  lowered: string | null;
}

export interface BriefEvidence {
  id: string;
  source_id: string;
  date: string;
  quote: string;
  claim: string;
  /** 出自哪一種文件（web 網頁全文、news 只有標題、table 總經儀表板、price 價格表）。 */
  kind: PackDoc['kind'];
  title: string;
  url: string | null;
  /** 網頁的級別與網域（不是網頁是 null）。 */
  tier: 'PRIMARY' | 'NAMED' | 'MEDIA' | null;
  domain: string | null;
}

/** 程式檢查之後的市場摘要（market_briefs.payload；T65 讀這一份）。 */
export interface MarketBrief {
  event_id: string;
  /** 寫這一份的訊號日（決策日）。 */
  as_of: string;
  period: { from: string; to: string };
  stage: BriefStage;
  /** 程式給的數字，原樣（每一句都對得到證據包 K 開頭的一行）。 */
  facts: string[];
  causes: BriefCause[];
  /** 沒有找到說得通的原因（causes 是空的時候一定是 true）。 */
  unknown: boolean;
  /** 各來源的說法一致不一致。 */
  clarity: (typeof CLARITIES)[number];
  /** 定稿：和暫定稿不同的地方；暫定稿是 null。 */
  changed_since_provisional: string | null;
  /** 這次看的族群（產業 ETF）；T65 分給個股時用 causes 的 group 對。 */
  groups: string[];
  core: string;
  /** causes 引用到的原文片段。 */
  evidence: BriefEvidence[];
  /** 被程式拿掉的（不是原樣抄的數字、引用沒過的原因…）與原因。 */
  dropped: { what: 'FACT' | 'CAUSE'; text: string; why: string }[];
  /** 程式改過的地方（原因不明、來源不足…）。 */
  notes: string[];
  report: string | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const txt = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const oneOf = <T extends string>(v: unknown, list: readonly T[]): T | null => (typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : null);

/**
 * 市場摘要的程式檢查（§1.5）。引用已經由 check.ts 逐字檢查過（s.evidence 的 ok）；這裡檢查固定欄位：
 *   整份退回（errors）：period、stage 和證據包不同；facts、causes 不是陣列；沒有任何一條原樣抄的數字；unknown、clarity 的格式不對；定稿沒寫和暫定稿不同的地方
 *   拿掉那一條（dropped）：不是原樣抄的數字；格式不對、族群不在證據包裡、沒有通過逐字檢查的引用（背景那一份暫定稿不算）的原因；超過條數的
 *   調低信心（lowered）：暫定稿的資金面原因只能是 LOW；引用只有新聞標題的只能是 LOW；HIGH 要有兩個不同網域的網頁全文
 *   原因都被拿掉、或本來就沒有 → unknown 一定是 true（「不明」是合格的答案）；引用不到兩個不同網域時 clarity 只能是 LOW
 */
export function checkBrief(s: Pick<CheckedSample, 'payload' | 'evidence' | 'report'>, pack: Pick<EvidencePack, 'documents' | 'facts' | 'rule' | 'as_of'>): { brief: MarketBrief | null; errors: string[] } {
  const errors: string[] = [];
  const d = (pack.rule.detail ?? {}) as Partial<BriefDetail>;
  const p = s.payload ?? {};
  const period = d.period ?? { from: '', to: '' };
  const stage = d.stage ?? 'PROVISIONAL';
  const dropped: MarketBrief['dropped'] = [];
  const notes: string[] = [];

  if (!isObj(p.period) || p.period.from !== period.from || p.period.to !== period.to) errors.push(`period 要照證據包寫（${period.from}～${period.to}）`);
  if (p.stage !== stage) errors.push(`stage 要是 ${stage}`);

  // facts：只能從證據包 K 開頭的數字原樣抄
  const given = new Map(pack.facts.filter((f) => /^K\d+$/.test(f.id)).map((f) => [normalizeText(f.value), f.value]));
  const facts: string[] = [];
  if (!Array.isArray(p.facts)) errors.push('facts 要是陣列');
  else {
    for (const raw of p.facts.slice(0, BRIEF_LIMITS.facts)) {
      const hit = typeof raw === 'string' ? given.get(normalizeText(raw)) : undefined;
      if (hit === undefined) dropped.push({ what: 'FACT', text: String(typeof raw === 'string' ? raw : JSON.stringify(raw)).slice(0, 200), why: '不是證據包給的數字（K 開頭）原樣' });
      else if (!facts.includes(hit)) facts.push(hit);
    }
    if (!facts.length) errors.push('facts 至少要有一條照證據包（K 開頭）原樣抄的數字');
  }

  // 引用：通過逐字檢查、而且不是背景（暫定稿那一份 note）
  const docs = new Map(pack.documents.map((x) => [x.source_id, x]));
  const cite = new Map(s.evidence.filter((e) => e.ok && docs.has(e.source_id) && docs.get(e.source_id)!.kind !== 'note').map((e) => [e.id, e]));
  const domainOf = (id: string): string | null => {
    const doc = docs.get(cite.get(id)?.source_id ?? '');
    return doc ? (webMetaOf(doc)?.domain ?? null) : null;
  };
  const groups = new Set(d.groups ?? []);
  const causes: BriefCause[] = [];
  if (!Array.isArray(p.causes)) errors.push('causes 要是陣列（沒有原因就寫空的陣列，unknown 寫 true）');
  else {
    for (const [n, raw] of p.causes.entries()) {
      const label = isObj(raw) && txt(raw.text) ? txt(raw.text).slice(0, 200) : `第 ${n + 1} 條`;
      const drop = (why: string) => void dropped.push({ what: 'CAUSE', text: label, why });
      if (n >= BRIEF_LIMITS.causes) {
        drop(`超過 ${BRIEF_LIMITS.causes} 條`);
        continue;
      }
      if (!isObj(raw)) {
        drop('格式不對');
        continue;
      }
      const scope = oneOf(raw.scope, CAUSE_SCOPES);
      const kind = oneOf(raw.kind, CAUSE_KINDS);
      const claimed = oneOf(raw.confidence, CONFIDENCES);
      const text = txt(raw.text);
      if (!scope || !kind || !claimed || !text || text.length > BRIEF_LIMITS.causeText) {
        drop(`格式不對（scope、kind、confidence 要用列舉值，text 一句、${BRIEF_LIMITS.causeText} 字以內）`);
        continue;
      }
      const group = scope === 'GROUP' ? txt(raw.group).toUpperCase() : null;
      if (scope === 'GROUP' && (!group || !groups.has(group))) {
        drop(`族群 ${group || '（沒寫）'} 不在證據包列的產業 ETF 裡`);
        continue;
      }
      const ids = [...new Set((Array.isArray(raw.evidence_ids) ? raw.evidence_ids : []).filter((x): x is string => typeof x === 'string' && cite.has(x)))];
      if (!ids.length) {
        drop('沒有通過逐字檢查的引用');
        continue;
      }
      const kinds = ids.map((id) => docs.get(cite.get(id)!.source_id)!.kind);
      const headlineOnly = kinds.every((x) => x === 'news');
      const domains = new Set(ids.map(domainOf).filter((x): x is string => !!x));
      let confidence = claimed;
      const why: string[] = [];
      if (stage === 'PROVISIONAL' && kind === 'FLOW' && confidence !== 'LOW') {
        confidence = 'LOW';
        why.push('資金面的原因在暫定稿只能是低');
      }
      if (headlineOnly && confidence !== 'LOW') {
        confidence = 'LOW';
        why.push('引用只有新聞標題，沒有讀到全文');
      }
      if (confidence === 'HIGH' && domains.size < 2) {
        confidence = 'MEDIUM';
        why.push('高要有兩個不同網域的網頁全文');
      }
      causes.push({ scope, group, kind, text, confidence, evidence_ids: ids, headline_only: headlineOnly, lowered: why.length ? `AI 寫的是${CONFIDENCE_TEXT[claimed]}：${why.join('；')}` : null });
    }
  }

  let unknown = false;
  if (typeof p.unknown !== 'boolean') errors.push('unknown 要是 true 或 false');
  else unknown = p.unknown;
  if (!causes.length && !unknown && typeof p.unknown === 'boolean') {
    unknown = true;
    notes.push(Array.isArray(p.causes) && p.causes.length ? '寫的原因都沒有通過檢查，改成原因不明' : '沒有列出原因，改成原因不明');
  }

  let clarity = oneOf(p.clarity, CLARITIES);
  if (!clarity) errors.push('clarity 要是 HIGH 或 LOW');
  const allDomains = new Set(causes.flatMap((c) => c.evidence_ids.map(domainOf)).filter((x): x is string => !!x));
  if (clarity === 'HIGH' && allDomains.size < 2) {
    clarity = 'LOW';
    notes.push('引用的網頁不到兩個不同的網域，談不上各來源一致，clarity 改成 LOW');
  }

  let changed: string | null = null;
  if (stage === 'FINAL') {
    const c = txt(p.changed_since_provisional);
    if (c.length > BRIEF_LIMITS.changed) errors.push(`changed_since_provisional 超過 ${BRIEF_LIMITS.changed} 字`);
    else if (!c && d.hasProvisional) errors.push('定稿要寫 changed_since_provisional：和暫定稿不同的地方（沒有不同也要寫明）');
    else changed = c || null;
  }

  if (errors.length) return { brief: null, errors };
  const used = new Set(causes.flatMap((c) => c.evidence_ids));
  const evidence: BriefEvidence[] = [...cite.values()]
    .filter((e) => used.has(e.id))
    .map((e) => {
      const doc = docs.get(e.source_id)!;
      const web = webMetaOf(doc);
      return { id: e.id, source_id: e.source_id, date: e.date, quote: e.quote, claim: e.claim, kind: doc.kind, title: doc.title, url: doc.url ?? null, tier: web?.tier ?? null, domain: web?.domain ?? null };
    });
  return {
    brief: { event_id: d.eventId ?? '', as_of: pack.as_of, period, stage, facts, causes, unknown, clarity: clarity!, changed_since_provisional: changed, groups: [...groups], core: d.core ?? '', evidence, dropped, notes, report: s.report },
    errors: [],
  };
}

/** 摘要檢查沒過時寫進 issues 的前綴（briefResult 用它分辨「程式檢查沒過」與「研究員說證據不夠」）。 */
export const BRIEF_ISSUE = '摘要檢查：';

/** MARKET_BRIEF 的 payload 檢查（PayloadHook）：寫了摘要（DONE）而檢查不過 → 這一票改成 INSUFFICIENT、原因寫進 issues（整份退回）。 */
export function checkBriefPayload(s: CheckedSample, pack: EvidencePack): void {
  if (s.verdict !== 'DONE') return;
  const r = checkBrief(s, pack);
  if (!r.errors.length) return;
  s.issues.push(...r.errors.map((e) => `${BRIEF_ISSUE}${e}`));
  s.verdict = pack.policy.abstain;
}

/**
 * 一次市場摘要的結果：ok = 檢查過的摘要；不 ok = 原因（白話，market_briefs.error）。還沒有結論是 null。
 * 寫好、檢查過的才算（原因不明也算寫好）；逾時、沒觸發成、整份退回、格式不合格、研究員說證據不夠、程式檢查沒過都是失敗。
 */
export function briefResult(outcome: Outcome | null, pack: Pick<EvidencePack, 'documents' | 'facts' | 'rule' | 'as_of'>): { ok: true; brief: MarketBrief } | { ok: false; why: string } | null {
  if (!outcome) return null;
  const s = outcome.samples.find((x) => x.valid) ?? outcome.samples[0];
  if (outcome.status === 'AGREED' && outcome.verdict === 'DONE' && s) {
    const r = checkBrief(s, pack);
    if (r.brief) return { ok: true, brief: r.brief };
    return { ok: false, why: `程式檢查沒過：${r.errors.join('；')}` };
  }
  const bad = s?.issues.filter((x) => x.startsWith(BRIEF_ISSUE)).map((x) => x.slice(BRIEF_ISSUE.length)) ?? [];
  if (bad.length) return { ok: false, why: `程式檢查沒過：${bad.join('；')}` };
  if (outcome.status === 'INVALID') return { ok: false, why: `送回的格式不合格${s?.issues.length ? `（${s.issues.slice(0, 3).join('；')}）` : ''}` };
  if (outcome.status === 'INSUFFICIENT') return { ok: false, why: `研究員認為資料不夠寫摘要${s?.abstainReason ? `：${s.abstainReason}` : ''}` };
  return { ok: false, why: outcome.reason.replace(/，照規則。$/, '') };
}

/**
 * 摘要的白話文字（定稿的證據包附暫定稿時用；T65 分給個股時也可以用）。
 * group：給了就只留大盤的原因與這個產業 ETF 的原因（§1.6：個股的證據包只放和它有關的部分）；沒給是全部。
 * 原因一律寫成「報導的說法」。這份文字是背景，不能當引用。
 */
export function briefText(b: MarketBrief, opt: { group?: string | null } = {}): string {
  const causes = opt.group === undefined ? b.causes : b.causes.filter((c) => c.scope === 'MARKET' || (!!opt.group && c.group === opt.group));
  const L = [`市場摘要（${b.stage === 'FINAL' ? '定稿' : '暫定稿'}；期間 ${b.period.from}～${b.period.to}，${b.as_of} 寫）`, '', '程式算的數字：', ...b.facts.map((f) => `- ${f}`), ''];
  if (causes.length) {
    L.push('報導的說法（引用只證明報導這樣寫，不證明因果）：');
    for (const c of causes) L.push(`- 〔${c.scope === 'MARKET' ? '大盤' : c.group}｜${CAUSE_KIND_TEXT[c.kind]}｜信心${CONFIDENCE_TEXT[c.confidence]}${c.headline_only ? '｜只有新聞標題' : ''}〕${c.text}`);
  } else L.push(b.causes.length ? '報導的說法：沒有和大盤或這個族群有關的。' : '原因：不明（沒有找到說得通的原因）。');
  if (b.unknown && causes.length) L.push('整體來說沒有找到說得通的原因（原因不明）；上面只是報導提到的說法。');
  L.push('', `各來源的說法：${b.clarity === 'HIGH' ? '一致' : '不一致，或來源不足'}`);
  if (b.changed_since_provisional) L.push('', `和暫定稿不同的地方：${b.changed_since_provisional}`);
  return L.join('\n');
}

// ---------------------------------------------------------------- 分給個股、顯示（T65，§1.6～§1.8）

/** 個股證據包裡市場摘要那一份 note 的 source_id 開頭（§1.6：`brief:<訊號日>`）。 */
export const BRIEF_DOC_PREFIX = 'brief:';
/** 這一份是不是分給個股的市場摘要（新眼光拿得到、不能引用，src/ai/freshEyes.ts）。 */
export const isBriefDoc = (d: Pick<PackDoc, 'kind' | 'source_id'>): boolean => d.kind === 'note' && d.source_id.startsWith(BRIEF_DOC_PREFIX);
/** 個股證據包取最近幾個日曆天內的一份（§1.6）。 */
export const BRIEF_PACK_DAYS = 30;
/** 首頁：最近幾個交易日內有摘要時顯示一行（§1.8）。 */
export const BRIEF_HOME_DAYS = 10;
/** 分給個股的那一份 note 開頭的說明（prompt 也寫了同樣的意思）。 */
export const BRIEF_NOTE_HEAD = '這一份是背景，不是證據：不能引用，也不能當成前提成立或不成立的依據（報導的說法只證明報導這樣寫，不證明因果）。';

/**
 * 分給個股的市場摘要（§1.6）：kind = note、source_id = brief:<訊號日>。只放 facts、大盤的原因，以及 group 等於這檔產業 ETF 的原因
 * （briefText 的 group；這檔沒有對到產業 ETF 時是 null，只留大盤的）。和論點那一份 note 一樣不能當引用：
 * check.ts 的正面引用核對、ownReview 的不成立與條件成立的引用都不認 note（沒有另外寫程式）。
 */
export function briefNoteDoc(b: MarketBrief, session: string, group: string | null): PackDoc {
  const head = [BRIEF_NOTE_HEAD, `大盤${group ? `與這檔所屬的族群（${group}）` : ''}這段期間為什麼大幅波動，報導怎麼說已經整理在這裡；分析師的搜尋額度用在這檔自己的前提，不要再找大盤為什麼跌。`, ''];
  return { id: 'MB', source_id: `${BRIEF_DOC_PREFIX}${session}`, kind: 'note', date: session, title: `市場摘要（${b.stage === 'FINAL' ? '定稿' : '暫定稿'}，${b.period.from}～${b.period.to}；背景，不是證據，不能引用）`, text: [...head, briefText(b, { group })].join('\n') };
}

/**
 * 一句話的摘要（LINE 那一行、首頁那一行、AI 紀錄列表的說明；§1.8）：第一個原因（一律標「報導的說法」），沒有原因或整體原因不明時是「原因不明」。
 */
export function briefFirstCause(b: Pick<MarketBrief, 'causes' | 'unknown'>): { tag: string | null; text: string } {
  const c = b.causes[0];
  if (!c || b.unknown) return { tag: null, text: '原因不明' };
  return { tag: `報導的說法，信心${CONFIDENCE_TEXT[c.confidence]}${c.headline_only ? '，只有新聞標題' : ''}`, text: c.text.replace(/[。．.]+$/, '') };
}

/** LINE：當天有其他通知時，通知裡加的那一行（§1.8；LINE 不另外推）：`市場摘要（報導的說法，信心高）：…`／`市場摘要：原因不明`。 */
export function briefLine(b: Pick<MarketBrief, 'causes' | 'unknown'>): string {
  const f = briefFirstCause(b);
  return `市場摘要${f.tag ? `（${f.tag}）` : ''}：${f.text}`;
}
