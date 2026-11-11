// 測試用的情境驅動器：照日曆一天一天走，模擬「使用者照清單下單後填快照」。
// 時間模型和原型相同：每個交易日分「開盤前」與「收盤後」；月報在每月第一個交易日開盤前，
// 當天通知在收盤後發出、隔天開盤執行；回覆後的下一個開盤以開盤價成交。
import {
  applySnapshot,
  bookShares,
  composeNotif,
  createAccount,
  dailyCheck,
  excessVol,
  monthlyReport,
  respond,
  totalValue,
  type Account,
  type InitialAccount,
  type MarketView,
  type Notif,
  type ResponseInput,
  type Snapshot,
} from '../../src/engine';
import { ranksAt, viewAt, type Market } from './market';

export interface SimOptions {
  /** 本月被任務 A 否決的代號（月份 → 代號）。 */
  vetoes?: Record<string, string[]>;
  crashOpinion?: Record<string, '照做' | '延後'>;
  /** σ 的歷史中位數 = 開始時的 σ × 這個倍數（原型預設 1.35：一開始不減碼）。 */
  sigmaMedianFactor?: number;
  /** 自動回覆每一則通知（照預設選項）。 */
  autoRespond?: boolean;
}

export class Sim {
  acct: Account;
  /** 今天（第幾個交易日）。 */
  d: number;
  log: string[] = [];
  constructor(
    public market: Market,
    init: InitialAccount,
    public opt: SimOptions = {},
  ) {
    this.d = market.idx0;
    const v0 = viewAt(market, this.d - 1);
    const model = init.momModel ?? Object.keys(init.mom ?? {});
    const cache: Record<string, Float64Array> = {};
    const retOf = (t: string) => {
      if (!cache[t]) {
        const c = market.close[t];
        cache[t] = Float64Array.from(c.map((x, k) => (k ? x / c[k - 1] - 1 : NaN)));
      }
      return cache[t];
    };
    const s0 = excessVol(retOf, model, 'VOO', v0.i - 125, v0.i + 1);
    this.acct = createAccount({ volW: 1, volHist: Array.from({ length: 24 }, () => s0 * (opt.sigmaMedianFactor ?? 1.35)), ...init }, v0);
  }
  get date(): string {
    return this.market.days[this.d];
  }
  /** 開盤前看到的市場（昨天收盤）。 */
  get pre(): MarketView {
    return viewAt(this.market, this.d - 1);
  }
  /** 收盤後看到的市場。 */
  get post(): MarketView {
    return viewAt(this.market, this.d);
  }
  get month(): string {
    return this.date.slice(0, 7);
  }
  isFirstOfMonth(): boolean {
    return this.market.days[this.d - 1].slice(0, 7) !== this.month;
  }
  total(): number {
    return totalValue(this.acct, this.pre);
  }
  pending(): Notif[] {
    return this.acct.notifs.filter((n) => n.status === 'PENDING');
  }
  last(kind?: Notif['kind']): Notif {
    const xs = this.acct.notifs.filter((n) => !kind || n.kind === kind);
    return xs[xs.length - 1];
  }
  find(pred: (n: Notif) => boolean): Notif | undefined {
    return this.acct.notifs.find(pred);
  }

  /** 開盤前：月報日就出月報。 */
  preOpen(removedFromUniverse: string[] = []): Notif | null {
    if (!this.isFirstOfMonth()) return null;
    const r = monthlyReport(this.acct, this.pre, {
      order: ranksAt(this.market, this.d - 1, removedFromUniverse),
      vetoed: this.opt.vetoes?.[this.month],
      month: this.month,
      crashOpinion: this.opt.crashOpinion?.[this.month],
    });
    this.acct = r.acct;
    this.log.push(`${this.date} 開盤前 月報 #${r.notif.id}：${r.notif.items.map((i) => i.title).join('｜') || r.notif.title}`);
    return r.notif;
  }
  respond(id: number, input: ResponseInput = { mode: 'DO' }): void {
    this.acct = respond(this.acct, this.pre, id, input);
  }
  /** 收盤後回覆（用今天的收盤價合成清單）。 */
  respondAfterClose(id: number, input: ResponseInput = { mode: 'DO' }): void {
    this.acct = respond(this.acct, this.post, id, input);
  }
  /**
   * 開盤：已回覆的清單以今天開盤價成交，然後填快照。
   * partial：實際成交的股數（代號 → 股數變動），沒列的照清單。
   */
  open(partial: Record<string, number> = {}): ReturnType<typeof applySnapshot> | null {
    const todo = this.acct.notifs.filter((n) => n.status === 'RESPONDED');
    if (!todo.length && !Object.keys(partial).length) return null;
    const snap = this.snapshotAfter(todo, partial);
    const r = applySnapshot(this.acct, this.pre, snap, (t) => this.market.open[t][this.d]);
    this.acct = r.acct;
    return r;
  }
  snapshotAfter(todo: Notif[], partial: Record<string, number> = {}): Snapshot {
    const shares = bookShares(this.acct);
    let cash = this.acct.cash;
    const delta: Record<string, number> = {};
    for (const n of todo) {
      const comp = n.composed ?? composeNotif(this.acct, this.pre, n);
      for (const m of comp.merged) delta[m.ticker] = (delta[m.ticker] ?? 0) + m.shares;
      if (n.withdraw) cash -= n.withdraw;
    }
    Object.assign(delta, partial);
    for (const [t, q] of Object.entries(delta)) {
      shares[t] = (shares[t] ?? 0) + q;
      cash -= q * this.market.open[t][this.d];
    }
    return { shares, cash };
  }
  /** 收盤後：每日檢查。 */
  close(): Notif[] {
    const r = dailyCheck(this.acct, this.post);
    this.acct = r.acct;
    for (const l of r.log) this.log.push(`${this.date} 收盤後 ${l.ticker}：${l.what}`);
    for (const n of r.created) this.log.push(`${this.date} 收盤後 通知 #${n.id}：${n.title}`);
    return r.created;
  }
  /** 走完一天。hooks 可以在各時點插入操作。 */
  day(h: { afterMonthly?: (n: Notif) => void; afterClose?: (created: Notif[]) => void; removed?: string[] } = {}): void {
    const m = this.preOpen(h.removed);
    if (m) h.afterMonthly?.(m);
    if (this.opt.autoRespond) for (const n of this.pending()) this.respond(n.id);
    this.open();
    const created = this.close();
    h.afterClose?.(created);
    this.d++;
  }
  /** 一路走到某一天的開盤前（不含那一天）。 */
  runUntil(date: string, h: Parameters<Sim['day']>[0] = {}): void {
    while (this.date < date && this.d < this.market.days.length - 1) this.day(h);
  }
  atEnd(): boolean {
    return this.d >= this.market.days.length - 1;
  }
}

/** 清單摘要：['賣 ORCL 28', '買 GE 12', …]（合併後的淨額）。 */
export function listOf(n: Notif): string[] {
  const c = n.composed ?? n.preview;
  return (c?.merged ?? []).filter((m) => m.shares !== 0).map((m) => `${m.shares > 0 ? '買' : '賣'} ${m.ticker} ${Math.abs(m.shares)}`);
}
