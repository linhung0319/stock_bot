// 使用者的操作：回覆清單、填快照、入金、出金、改比例、新增／移除自選、轉入自選、認養、排除、分類。
// 設計：§2.1.1（快照式帳本、入金出金）、§2.3（操作方式）、§2.3.1（操作和清單不同時）。
import {
  SYSTEM_DEFAULT_PREMISES,
  addLot,
  bookShares,
  bucketValue,
  cellValues,
  clone,
  flowUnits,
  makeItem,
  newNotif,
  newOwnMeta,
  priceOf,
  recommendStdWeights,
  shareCells,
  totalValue,
  type Account,
  type Effect,
  type Item,
  type MarketView,
  type Notif,
  type Premise,
  type ShadowRecord,
  type Tier,
} from './account';
import { momSlotTarget, planDay } from './allocator';
import { BUY_CASH_FRACTION, capBuys, planToLines, type OrderLine } from './orders';
import { composeNotif, monthlyReport, monthlyWait, recordExternalFlow, type MonthlyResult } from './report';
import { halveShares } from './slowRule';
import type { Bucket } from './types';

const sumFor = (lines: OrderLine[], ticker: string) => lines.filter((l) => l.ticker === ticker).reduce((a, l) => a + l.shares, 0);

// ---------------------------------------------------------------- 回覆通知

export interface ResponseInput {
  /** DO = 照目前每一項選的選項做；SKIP = 整則這次不做。 */
  mode: 'DO' | 'SKIP';
  /** 每一項選哪個選項（item key → RULE／AI／DO／SKIP）；沒給的用預設。 */
  choices?: Record<string, 'RULE' | 'AI' | 'DO' | 'SKIP'>;
}

function applyEffects(acct: Account, view: MarketView, effects: Effect[] | undefined): void {
  for (const e of effects ?? []) {
    if (e.type === 'REMOVE_OWN') removeOwnPick(acct, e.ticker);
    else if (e.type === 'MOM_DROP') acct.rule.heldMom = acct.rule.heldMom.filter((t) => t !== e.ticker);
    else if (e.type === 'CLEAR_FLAG') {
      if (acct.own[e.ticker]) acct.own[e.ticker].flags = [];
    } else applyTier(acct, view, e.ticker, e.tier);
  }
}

/** 照 AI 檔位做之後，慢規則狀態跟著改（設計 §2.2，2026-11-11 定案）。 */
export function applyTier(acct: Account, view: MarketView, ticker: string, tier: Tier): void {
  const meta = acct.own[ticker];
  const rule = acct.rule.own[ticker];
  if (!meta || !rule) return;
  if (tier === 'EXIT') {
    removeOwnPick(acct, ticker); // 照 AI 出清 = 移出自選（同 F15）
  } else if (tier === 'HALF' || tier === 'STANDARD') {
    const st = tier === 'HALF' ? 'HALF' : 'STD';
    meta.slow = { ...meta.slow, state: st, sinceSwitch: 0 }; // 切換日重新起算
    meta.pending = null;
    rule.applied = st;
  } else if (tier === 'RAISE') {
    rule.stdWeight *= 1.25;
    meta.raisedAt = view.date;
  }
}

function removeOwnPick(acct: Account, ticker: string): void {
  delete acct.own[ticker];
  delete acct.rule.own[ticker];
}

/** 晚回覆（提醒過才回）：規則狀態已反轉的自選項目取消，其餘自選規則單用今天的價格重算（設計 §2.3.1「忘了」）。 */
function recomputeLate(acct: Account, view: MarketView, n: Notif): void {
  for (const it of n.items) {
    if (it.kind !== 'OWN_RULE' || !it.ticker || it.cancelled) continue;
    const tk = it.ticker;
    const meta = acct.own[tk];
    const rule = acct.rule.own[tk];
    if (!meta || !rule) {
      it.cancelled = true;
      continue;
    }
    const expected = it.f === 'F7' ? 'HALF' : 'STD';
    if (meta.slow.state !== expected) {
      it.cancelled = true;
      it.note = '期間規則狀態已反轉，這一項取消';
      rule.applied = meta.slow.state;
      meta.pending = null;
      continue;
    }
    const cur = acct.lots.own[tk] ?? 0;
    const sh = it.f === 'F7' ? -halveShares(cur) : Math.max(0, Math.floor((rule.stdWeight * totalValue(acct, view)) / priceOf(view, tk)) - cur);
    it.choices[0].lines = sh ? [{ ticker: tk, bucket: 'own', shares: sh, reason: '自選訊號' }] : [];
    it.note = `晚回覆：用 ${view.date} 收盤價重算`;
  }
}

export function respond(acct0: Account, view: MarketView, id: number, input: ResponseInput): Account {
  const acct = clone(acct0);
  const n = acct.notifs.find((x) => x.id === id);
  if (!n || n.status !== 'PENDING') return acct;
  if (n.kind === 'INFO' || n.kind === 'MONTHLY_EMPTY' || !n.items.length) {
    n.status = 'READ';
    return acct;
  }
  if (n.reminded && input.mode !== 'SKIP') recomputeLate(acct, view, n);
  for (const it of n.items) {
    const c = input.mode === 'SKIP' ? 'SKIP' : input.choices?.[it.key];
    if (c && it.choices.some((x) => x.id === c)) it.choice = c;
  }
  n.respondedAt = view.date;
  n.respondedSeq = view.i;
  n.composed = composeNotif(acct, view, n);
  for (const it of n.items) {
    if (it.cancelled) continue;
    const rule = it.choices.find((c) => c.id === it.ruleChoice);
    const ai = it.choices.find((c) => c.id === 'AI');
    const act = it.choices.find((c) => c.id === it.choice);
    const tickers = it.ticker ? [it.ticker] : [...new Set((rule?.lines ?? []).map((l) => l.ticker))];
    for (const tk of tickers) {
      const rec = {
        date: view.date,
        f: it.f,
        ticker: tk,
        title: it.title,
        rule: sumFor(rule?.lines ?? [], tk),
        ai: ai ? sumFor(ai.lines, tk) : null,
        actual: sumFor(act?.lines ?? [], tk),
        price: view.close[tk] ? priceOf(view, tk) : 0,
        choice: it.choice,
        notif: n.id,
        ...(it.runIds?.length ? { runIds: [...it.runIds] } : {}),
      };
      if (rec.ai !== null || rec.actual !== rec.rule || it.aiLine) acct.shadow.push(rec);
      // 策略類不做 → 下一份月報把差額再列一次；自選規則與 AI 建議是一次性的，不再提醒
      if (it.kind === 'STRATEGY' && it.choice === 'SKIP' && rec.rule !== 0) acct.mom.owe[tk] = { since: view.date, notif: n.id };
    }
  }
  const nothingToTrade = n.composed.lines.length === 0;
  if (input.mode === 'SKIP' || n.items.every((i) => i.cancelled || i.choice === 'SKIP')) {
    n.status = 'SKIPPED';
  } else if (nothingToTrade && !n.withdraw) {
    // 選的選項不用下單（例如 AI「維持減半」）→ 直接完成（出金除外：快照時才記出金）
    for (const it of n.items) if (!it.cancelled) applyEffects(acct, view, it.choices.find((c) => c.id === it.choice)?.effects);
    n.status = 'DONE';
  } else {
    n.status = 'RESPONDED';
  }
  return acct;
}

/**
 * 改決定：已經回覆、還沒填快照的清單退回「等你決定」。
 * 回覆時只記了三件事——合成的清單、沒照做的紀錄、策略單的欠單——這裡把它們收回；
 * 每一項原本選的選項留著（回到第一步時還是上次的選擇）。成交之後（已填快照）不能改。
 * 沒照做的紀錄只增不減，所以不刪，改成加一筆作廢記號；讀的時候用 liveShadow() 濾掉。
 */
export function reopen(acct0: Account, view: MarketView, id: number): { acct: Account; ok: boolean } {
  const acct = clone(acct0);
  const n = acct.notifs.find((x) => x.id === id);
  if (!n || n.status !== 'RESPONDED' || n.followUpOpen) return { acct, ok: false };
  n.status = 'PENDING';
  delete n.composed;
  delete n.respondedAt;
  delete n.respondedSeq;
  delete n.fillReminded;
  for (const [tk, o] of Object.entries(acct.mom.owe)) if (o.notif === id) delete acct.mom.owe[tk];
  acct.shadow.push({ date: view.date, f: 'REOPEN', ticker: null, title: '改決定：先前的回覆作廢', rule: 0, ai: null, actual: 0, price: 0, choice: 'REOPEN', notif: id });
  return { acct, ok: true };
}

/** 沒照做的紀錄裡，拿掉被「改決定」作廢的那幾筆（同一則通知、在作廢記號之前的）和記號本身。 */
export function liveShadow(records: ShadowRecord[]): ShadowRecord[] {
  const voidedBefore = new Map<number, number>();
  records.forEach((s, k) => {
    if (s.choice === 'REOPEN' && s.notif !== undefined) voidedBefore.set(s.notif, k);
  });
  if (!voidedBefore.size) return records;
  return records.filter((s, k) => s.choice !== 'REOPEN' && (s.notif === undefined || k > (voidedBefore.get(s.notif) ?? -1)));
}

// ---------------------------------------------------------------- 快照 → 事件

export type BucketShares = Record<'own' | 'mom' | 'core', Record<string, number>>;

export interface Snapshot {
  /** 每一檔的總股數（券商顯示的數字）。給了 lots 時要等於 lots 三桶相加。 */
  shares: Record<string, number>;
  /** 分桶快照（2026-11-15 起網站用這個）：每一桶每一檔的股數，由使用者決定變動放哪一桶，不再問分類。 */
  lots?: BucketShares;
  cash: number;
  /** 選填：這次自己交易（清單外的變動）的原因，記在那些事件上；核心的手動交易也記。 */
  note?: string;
  /** 分桶快照：新加進自選的代號，為什麼買（成為這檔的前提）。 */
  why?: Record<string, string>;
  /** 出金（這次完成的與之前還沒轉出的）還沒從券商轉出：券商的現金還沒扣掉（設計 §10 第 40 點）。 */
  withdrawPending?: boolean;
}

export interface SnapshotResult {
  acct: Account;
  /** 這次快照完成了哪些通知。 */
  completed: number[];
  /** 快照和清單不同、等使用者選「補做差額／就這樣」的通知。 */
  followUps: number[];
  /** 新產生的通知（只用總股數的舊快照才有：未分類的變動）。 */
  created: Notif[];
  /** 扣掉估計的成交金額後，現金多出（＋）或少掉（−）的部分；記成「其他現金變動」，不再問（2026-11-15）。 */
  cashOther: number;
  /**
   * 「可能填錯」：差額大到不像成交價差、手續費或股利（超過總資產 0.5%，而且超過這次成交金額的 3%）。
   * 只是警告：差額照樣記成其他現金變動；畫面提醒填錯了可以復原、或其實是入金出金要去登記。
   */
  cashWarn: boolean;
  /** 自己賣光、自動移出自選的代號。 */
  removedOwn: string[];
  /** 分桶快照不允許時的原因（帳戶不變）。 */
  error?: string;
}

/** 「可能填錯」的門檻（設計 §10 第 39 點）。 */
export const CASH_WARN = { ofTotal: 0.005, ofTraded: 0.03 };

/** 扣掉估計成交金額後剩下的現金差：不問，記成其他現金變動（成交價差、手續費、股利；設計 §10 第 38 點）。traded：這次估計的成交金額（買賣都算正的）。 */
function settleCash(acct: Account, view: MarketView, cash: number, expected: number, withdrawn: number, traded: number): { cashOther: number; cashWarn: boolean } {
  const residual = Math.round((cash - expected) * 100) / 100;
  acct.cash = cash;
  if (withdrawn) recordExternalFlow(acct, view, -withdrawn);
  if (Math.abs(residual) >= 0.01) acct.events.push({ date: view.date, kind: 'CASH_OTHER', amount: residual, reason: '和估計的成交金額不同（成交價、手續費、股利）' });
  const warn = Math.abs(residual) > Math.max(CASH_WARN.ofTotal * totalValue(acct, view), CASH_WARN.ofTraded * traded);
  return { cashOther: Math.abs(residual) >= 0.01 ? residual : 0, cashWarn: warn };
}

/**
 * 使用者填快照（每檔股數＋現金）。系統把「上一份快照 → 這一份」的差異拆成事件、分到各桶：
 *   清單上有的代號 → 照清單分到下單的那一桶（兩桶都有單時按股數比例）；差超過 1 股 → 問補做或就這樣
 *   清單上沒有的代號 → 核心 ETF／短債直接歸核心；其他問使用者屬於哪一桶，分類前月報不下單
 *   現金 → 扣掉清單的成交金額後的差額記成其他現金變動，不再問（2026-11-15）
 * 給了 lots（分桶快照，網站從 2026-11-15 起用這個）就照 applyBucketSnapshot：變動放哪一桶由使用者決定。
 * fill：估計成交價用的價格（預設用 view 的收盤）。
 */
export function applySnapshot(acct0: Account, view: MarketView, snap: Snapshot, fill?: (ticker: string) => number): SnapshotResult {
  if (snap.lots) return applyBucketSnapshot(acct0, view, snap, fill);
  const acct = clone(acct0);
  const px = fill ?? ((t: string) => priceOf(view, t));
  const book = bookShares(acct);
  const diff: Record<string, number> = {};
  for (const t of new Set([...Object.keys(book), ...Object.keys(snap.shares)])) {
    const d = (snap.shares[t] ?? 0) - (book[t] ?? 0);
    if (Math.abs(d) > 1e-9) diff[t] = d;
  }
  const completed: number[] = [];
  const followUps: number[] = [];
  const created: Notif[] = [];
  const valueBefore = { own: bucketValue(acct, view, 'own'), mom: bucketValue(acct, view, 'mom'), core: bucketValue(acct, view, 'core') };
  const flows = { own: 0, mom: 0 };
  let expectedCash = acct.cash;
  let withdrawn = 0;
  let traded = 0;
  const assign = (bucket: Bucket, ticker: string, q: number, reason: string, notif?: number) => {
    if (!q) return;
    addLot(acct, bucket, ticker, q);
    if (bucket !== 'core') flows[bucket] += q * px(ticker);
    acct.events.push({ date: view.date, kind: 'TRADE', ticker, bucket, shares: q, reason, notif });
  };

  const reconcileResponded = () => {
    for (const n of acct.notifs) {
      if (n.status !== 'RESPONDED' || !n.composed) continue;
      const fu: NonNullable<Notif['followUp']> = [];
      for (const m of n.composed.merged) {
        const parts = m.parts.filter((l) => l.shares !== 0);
        if (m.shares === 0) {
          // 同代號兩桶對沖（劃撥）：不用下單，帳本直接搬
          for (const l of parts) {
            addLot(acct, l.bucket, l.ticker, l.shares);
            if (l.bucket !== 'core') flows[l.bucket] += l.shares * px(l.ticker);
            acct.events.push({ date: view.date, kind: 'TRANSFER', ticker: l.ticker, bucket: l.bucket, shares: l.shares, reason: String(l.reason), notif: n.id });
          }
          continue;
        }
        const d = diff[m.ticker] ?? 0;
        const q = Math.sign(d) === Math.sign(m.shares) ? d : 0;
        if (q) delete diff[m.ticker];
        let assigned = 0;
        parts.forEach((l, k) => {
          const a = q === m.shares ? l.shares : k === parts.length - 1 ? q - assigned : Math.round((l.shares * q) / m.shares);
          assigned += a;
          assign(l.bucket, l.ticker, a, String(l.reason), n.id);
        });
        expectedCash -= q * px(m.ticker);
        traded += Math.abs(q * px(m.ticker));
        if (Math.abs(q - m.shares) > 1) {
          fu.push({ ticker: m.ticker, listed: m.shares, done: q });
          // 策略類的差額，下個月月報再列
          if (n.items.some((i) => i.kind === 'STRATEGY' && !i.cancelled && i.choice !== 'SKIP' && (i.choices.find((c) => c.id === i.choice)?.lines ?? []).some((l) => l.ticker === m.ticker && l.bucket === 'mom'))) {
            acct.mom.owe[m.ticker] = { since: view.date, notif: n.id };
          }
        }
      }
      if (n.withdraw) {
        expectedCash -= n.withdraw;
        withdrawn += n.withdraw;
      }
      for (const it of n.items) if (!it.cancelled) applyEffects(acct, view, it.choices.find((c) => c.id === it.choice)?.effects);
      n.status = 'DONE';
      completed.push(n.id);
      if (fu.length) {
        n.followUp = fu;
        n.followUpOpen = true;
        followUps.push(n.id);
      }
    }
  };
  // 先對已回覆的清單，再看剩下的變動是不是照著還沒回覆的清單做的
  reconcileResponded();
  // 還沒按回覆、但快照顯示已經照清單做了（清單上非核心的代號有同方向的變動）→ 當成照預設選項回覆
  for (const n of acct.notifs) {
    if (n.status !== 'PENDING' || !n.items.length || n.kind === 'INFO') continue;
    const pv = composeNotif(acct, view, n);
    const own = new Set(pv.lines.filter((l) => l.bucket !== 'core').map((l) => l.ticker));
    if (pv.merged.some((m) => own.has(m.ticker) && m.shares !== 0 && diff[m.ticker] && Math.sign(diff[m.ticker]) === Math.sign(m.shares))) {
      n.composed = pv;
      n.respondedAt = view.date;
      n.status = 'RESPONDED';
    }
  }
  reconcileResponded();

  // 清單上沒有的變動
  for (const [t, d] of Object.entries(diff)) {
    expectedCash -= d * px(t);
    traded += Math.abs(d * px(t));
    if (t === acct.cfg.coreTicker || t === acct.bondTicker) {
      assign('core', t, d, snap.note ? `核心的手動交易：${snap.note}` : '核心的手動交易');
      continue;
    }
    addLot(acct, 'unc', t, d);
    acct.events.push({ date: view.date, kind: 'UNCLASSIFIED', ticker: t, shares: d, ...(snap.note ? { reason: snap.note } : {}) });
    const ex = acct.notifs.find((x) => x.kind === 'CLASSIFY' && x.status === 'PENDING' && x.ticker === t);
    if (ex) {
      ex.quantity = (ex.quantity ?? 0) + d;
      if (snap.note) ex.userNote = snap.note;
    } else created.push(newNotif(acct, view, { kind: 'CLASSIFY', title: `快照出現清單外的變動：${t} ${d > 0 ? '+' : ''}${d} 股`, ticker: t, quantity: d, coreAbsorb: false, text: '這是手動交易、新增自選還是轉入自選？屬於哪一桶？分類之前月報不下單。', ...(snap.note ? { userNote: snap.note } : {}) }));
  }

  // 單位數：自選與動能桶的淨買進是從核心流過去的錢
  acct.units.own = flowUnits(acct.units.own, valueBefore.own, flows.own);
  acct.units.mom = flowUnits(acct.units.mom, valueBefore.mom, flows.mom);
  acct.units.core = flowUnits(acct.units.core, valueBefore.core, -(flows.own + flows.mom));

  if (acct.monthlyBlocked && !Object.values(acct.lots.unc).some((x) => x) && !monthlyWait(acct)) acct.monthlyBlocked = false;
  // 現金
  const cashRes = settleCash(acct, view, snap.cash - (acct0.pendingWithdraw ?? 0), expectedCash, withdrawn, traded);
  acct.snapshotDate = view.date;
  return { acct, completed, followUps, created, ...cashRes, removedOwn: [] };
}

const BUCKETS3 = ['own', 'mom', 'core'] as const;

/**
 * 分桶快照（2026-11-15 使用者決定，設計 §10 第 38 點）：使用者照帳戶的三桶填每一桶每一檔的股數，
 * 變動放哪一桶由使用者決定，不再跳分類通知。
 *   清單上有的（桶＋代號）→ 照清單；差超過 1 股 → 問補做或就這樣（同 §2.3.1）
 *   清單外的：核心只能是核心 ETF／短債；動能的買進要在當月名單上、那一格還沒買足（2026-11-11 的規則照舊）；
 *     自選的新代號建立這檔（推薦標準比重、跌深就從減半開始、why 成為前提）；自選賣到 0 股 → 自動移出自選
 *   現金 → 不問，差額記成其他現金變動
 */
function applyBucketSnapshot(acct0: Account, view: MarketView, snap: Snapshot, fill?: (ticker: string) => number): SnapshotResult {
  const acct = clone(acct0);
  const lots = snap.lots!;
  const px = fill ?? ((t: string) => priceOf(view, t));
  const fail = (error: string): SnapshotResult => ({ acct: acct0, completed: [], followUps: [], created: [], cashOther: 0, cashWarn: false, removedOwn: [], error });
  for (const t of Object.keys(lots.core)) if (lots.core[t] && t !== acct.cfg.coreTicker && t !== acct.bondTicker) return fail(`${t} 不是核心的標的：核心只放 ${acct.cfg.coreTicker} 和 ${acct.bondTicker}`);
  for (const t of Object.keys(lots.own)) if (lots.own[t] && (t === acct.cfg.coreTicker || t === acct.bondTicker)) return fail(`${t} 是核心的標的，請填在核心`);
  for (const t of Object.keys(lots.mom)) if (lots.mom[t] && (t === acct.cfg.coreTicker || t === acct.bondTicker)) return fail(`${t} 是核心的標的，請填在核心`);

  const d: BucketShares = { own: {}, mom: {}, core: {} };
  for (const b of BUCKETS3) {
    for (const t of new Set([...Object.keys(acct.lots[b]), ...Object.keys(lots[b])])) {
      const x = (lots[b][t] ?? 0) - (acct.lots[b][t] ?? 0);
      if (Math.abs(x) > 1e-9) d[b][t] = x;
    }
  }
  // 舊的「未分類」持股：已經付過錢，這次由三桶的數字決定放哪；還沒回答的分類通知一起結束
  const unc = acct.lots.unc;
  acct.lots.unc = {};
  for (const n of acct.notifs) if (n.kind === 'CLASSIFY' && n.status === 'PENDING') {
    n.status = 'DONE';
    n.note = 'snapshot';
  }

  const completed: number[] = [];
  const followUps: number[] = [];
  const removedOwn: string[] = [];
  const total0 = totalValue(acct0, view);
  const valueBefore = { own: bucketValue(acct, view, 'own'), mom: bucketValue(acct, view, 'mom'), core: bucketValue(acct, view, 'core') };
  const flows = { own: 0, mom: 0 };
  let expectedCash = acct.cash;
  for (const [t, q] of Object.entries(unc)) expectedCash += q * px(t); // 未分類的股數已經付過錢
  let withdrawn = 0;
  let traded = 0;
  const assign = (bucket: Bucket, ticker: string, q: number, reason: string, notif?: number, kind: 'TRADE' | 'TRANSFER' = 'TRADE') => {
    if (!q) return;
    addLot(acct, bucket, ticker, q);
    if (bucket !== 'core') flows[bucket] += q * px(ticker);
    if (kind === 'TRADE') {
      expectedCash -= q * px(ticker);
      traded += Math.abs(q * px(ticker));
    }
    acct.events.push({ date: view.date, kind, ticker, bucket, shares: q, reason, ...(notif !== undefined ? { notif } : {}) });
  };
  /** 拿走這一桶這一檔同方向的變動（整筆算給清單，和舊的總股數快照相同）。 */
  const take = (b: 'own' | 'mom' | 'core', t: string, listed: number): number => {
    const x = d[b][t] ?? 0;
    if (!x || Math.sign(x) !== Math.sign(listed)) return 0;
    delete d[b][t];
    return x;
  };

  const reconcileResponded = () => {
    for (const n of acct.notifs) {
      if (n.status !== 'RESPONDED' || !n.composed) continue;
      const fu: NonNullable<Notif['followUp']> = [];
      for (const m of n.composed.merged) {
        // 同一桶的幾行合起來（例如兩個原因都是自選 MU）
        const per = new Map<'own' | 'mom' | 'core', { shares: number; reason: string }>();
        for (const l of m.parts) {
          if (!l.shares) continue;
          const cur = per.get(l.bucket) ?? { shares: 0, reason: '' };
          per.set(l.bucket, { shares: cur.shares + l.shares, reason: cur.reason ? `${cur.reason}、${l.reason}` : String(l.reason) });
        }
        if (m.shares === 0) {
          // 同代號兩桶對沖（劃撥）：不用下單，照三桶的數字搬
          for (const [b, p] of per) assign(b, m.ticker, take(b, m.ticker, p.shares), p.reason, n.id, 'TRANSFER');
          continue;
        }
        let done = 0;
        for (const [b, p] of per) {
          const q = take(b, m.ticker, p.shares);
          assign(b, m.ticker, q, p.reason, n.id);
          done += q;
        }
        if (Math.abs(done - m.shares) > 1) {
          fu.push({ ticker: m.ticker, listed: m.shares, done });
          if (n.items.some((i) => i.kind === 'STRATEGY' && !i.cancelled && i.choice !== 'SKIP' && (i.choices.find((c) => c.id === i.choice)?.lines ?? []).some((l) => l.ticker === m.ticker && l.bucket === 'mom'))) {
            acct.mom.owe[m.ticker] = { since: view.date, notif: n.id };
          }
        }
      }
      if (n.withdraw) {
        expectedCash -= n.withdraw;
        withdrawn += n.withdraw;
      }
      for (const it of n.items) if (!it.cancelled) applyEffects(acct, view, it.choices.find((c) => c.id === it.choice)?.effects);
      n.status = 'DONE';
      completed.push(n.id);
      if (fu.length) {
        n.followUp = fu;
        n.followUpOpen = true;
        followUps.push(n.id);
      }
    }
  };
  reconcileResponded();
  // 還沒按回覆、但快照顯示已經照清單做了（非核心的那幾行，同一桶有同方向的變動）→ 當成照預設選項回覆
  for (const n of acct.notifs) {
    if (n.status !== 'PENDING' || !n.items.length || n.kind === 'INFO') continue;
    const pv = composeNotif(acct, view, n);
    if (pv.lines.some((l) => l.bucket !== 'core' && l.shares !== 0 && d[l.bucket][l.ticker] && Math.sign(d[l.bucket][l.ticker]) === Math.sign(l.shares))) {
      n.composed = pv;
      n.respondedAt = view.date;
      n.status = 'RESPONDED';
    }
  }
  reconcileResponded();

  // 清單外的變動：使用者已經決定放哪一桶
  const note = snap.note;
  for (const [t, q] of Object.entries(d.core)) assign('core', t, q, note ? `核心的手動交易：${note}` : '核心的手動交易');
  for (const [t, q] of Object.entries(d.mom)) {
    if (q > 0) {
      const slot = momSlotTarget(acct.cfg, total0, acct.rule.effPrev ?? 1);
      const held = (acct.lots.mom[t] ?? 0) * px(t);
      if (!acct.rule.heldMom.includes(t)) return fail(`${t} 不在這個月的動能名單上：清單外買進的只能放自選`);
      if (held + q * px(t) > slot * (1 + (acct.cfg.lazyBand ?? 0.5))) return fail(`${t} 的動能那一格已經買足：多買的部分請放自選`);
      delete acct.mom.owe[t];
    }
    assign('mom', t, q, note ? `動能的手動交易：${note}` : '動能的手動交易');
    acct.shadow.push({ date: view.date, f: 'F17', ticker: t, title: '手動交易（動能）', rule: 0, ai: null, actual: q, price: px(t), choice: 'MANUAL', ...(note ? { note } : {}) });
  }
  for (const [t, q] of Object.entries(d.own)) {
    const why = snap.why?.[t]?.trim();
    if (q > 0) ensureOwnMeta(acct, view, t, 'MANUAL', why || undefined);
    // 自己賣到 0 股：自動移出自選（之後不再追蹤，也不會被加回或入金買回）
    const soldOut = q < 0 && (acct.lots.own[t] ?? 0) + q === 0 && !!acct.own[t];
    const reason = [note ? `自選的手動交易：${note}` : '自選的手動交易', soldOut ? '賣光，移出自選' : ''].filter(Boolean).join('；');
    assign('own', t, q, reason);
    if (soldOut) {
      removeOwnPick(acct, t);
      removedOwn.push(t);
    }
    acct.shadow.push({ date: view.date, f: 'F17', ticker: t, title: soldOut ? '手動交易：賣光並移出自選（如果繼續持有）' : '手動交易（自選）', rule: 0, ai: null, actual: q, price: px(t), choice: 'MANUAL', ...(note ? { note } : {}) });
  }

  acct.units.own = flowUnits(acct.units.own, valueBefore.own, flows.own);
  acct.units.mom = flowUnits(acct.units.mom, valueBefore.mom, flows.mom);
  acct.units.core = flowUnits(acct.units.core, valueBefore.core, -(flows.own + flows.mom));
  if (acct.monthlyBlocked && !monthlyWait(acct)) acct.monthlyBlocked = false;
  // 出金還沒轉出：記成出金（單位照樣贖回），但券商的現金還沒扣，對帳時先扣掉，之後的快照再扣到轉出為止
  const pendingAfter = snap.withdrawPending ? Math.round(((acct0.pendingWithdraw ?? 0) + withdrawn) * 100) / 100 : 0;
  const cashRes = settleCash(acct, view, snap.cash - pendingAfter, expectedCash, withdrawn, traded);
  if (pendingAfter) acct.pendingWithdraw = pendingAfter;
  else delete acct.pendingWithdraw;
  acct.snapshotDate = view.date;
  return { acct, completed, followUps, created: [], ...cashRes, removedOwn };
}

/** 回答現金差額是什麼：入金／出金會調整單位數（不算報酬）；股利與其他算報酬。 */
export function explainCash(acct0: Account, view: MarketView, id: number, kind: '入金' | '出金' | '股利' | '其他'): Account {
  const acct = clone(acct0);
  const n = acct.notifs.find((x) => x.id === id && x.kind === 'CASH_DIFF' && x.status === 'PENDING');
  if (!n) return acct;
  const amt = n.amount ?? 0;
  if (kind === '入金' || kind === '出金') recordExternalFlow(acct, view, amt);
  else acct.events.push({ date: view.date, kind: kind === '股利' ? 'DIVIDEND' : 'CASH_OTHER', amount: amt });
  n.status = 'DONE';
  n.note = kind;
  return acct;
}

/** 做錯（快照和清單差超過 1 股）：補做差額（附清單）或就這樣（差額記影子）。 */
export function resolveFollowUp(acct0: Account, view: MarketView, id: number, fix: boolean): { acct: Account; notif: Notif | null } {
  const acct = clone(acct0);
  const n = acct.notifs.find((x) => x.id === id);
  if (!n || !n.followUpOpen || !n.followUp) return { acct, notif: null };
  n.followUpOpen = false;
  if (!fix) {
    for (const x of n.followUp) acct.shadow.push({ date: view.date, f: 'F17', ticker: x.ticker, title: '做錯：就這樣', rule: x.listed, ai: null, actual: x.done, price: priceOf(view, x.ticker), choice: 'AS_IS' });
    return { acct, notif: null };
  }
  const items = n.followUp.map((x) => {
    const orig = (n.composed?.lines ?? []).filter((l) => l.ticker === x.ticker && l.shares !== 0);
    const bucket = orig.length ? orig[0].bucket : 'core';
    return makeItem({ f: 'F17', kind: 'FIX', ticker: x.ticker, title: `${x.ticker} 補做差額`, choices: [{ id: 'DO', label: '補做', lines: [{ ticker: x.ticker, bucket, shares: x.listed - x.done, reason: '策略單補做' }] }] });
  });
  const notif = newNotif(acct, view, { kind: 'FIX', title: '補做差額清單', items });
  notif.preview = composeNotif(acct, view, notif);
  return { acct, notif };
}

// ---------------------------------------------------------------- 入金、出金、改比例

/**
 * 入金（設計 §2.1.1）：只買不賣，當天給清單。
 * 入金遇到月報日：月報還沒回覆 → 用新的現金重算，取代原本的月報清單；已經回覆 → 另給一份入金清單。
 */
export function deposit(acct0: Account, view: MarketView, amount: number): { acct: Account; notif: Notif; mergedIntoMonthly: boolean } {
  const pendingMonthly = acct0.notifs.find((n) => (n.kind === 'MONTHLY' || n.kind === 'MONTHLY_EMPTY') && n.status === 'PENDING' && n.date === view.date && n.monthly);
  if (pendingMonthly?.monthly) {
    const base = clone(acct0);
    const old = base.notifs.find((n) => n.id === pendingMonthly.id)!;
    old.status = 'SUPERSEDED';
    base.rule = clone(old.monthly!.before.rule);
    base.own = clone(old.monthly!.before.own);
    base.mom.owe = clone(old.monthly!.before.owe);
    const r = monthlyReport(base, view, old.monthly!.input, { kind: '入金', amount });
    return { acct: r.acct, notif: r.notif, mergedIntoMonthly: true };
  }
  const acct = clone(acct0);
  const values = cellValues(acct, view);
  const plan = planDay({ cfg: acct.cfg, values, state: acct.rule, flow: { kind: '入金', amount } });
  acct.cash += amount;
  recordExternalFlow(acct, view, amount);
  const price = (t: string) => priceOf(view, t);
  // 補「低於目標最多」的格子：照缺口由大到小排，買單合計不超過現金的 98%
  const lines = planToLines(plan, values, { price, shares: shareCells(acct) }).sort((a, b) => b.shares * price(b.ticker) - a.shares * price(a.ticker));
  const capped = capBuys(lines, BUY_CASH_FRACTION * Math.max(0, acct.cash), price);
  const item = makeItem({ f: 'F11', kind: 'CASHFLOW', title: `入金 ${amount}：只買不賣`, choices: [{ id: 'DO', label: '照做', lines: capped }], noSkip: true, why: '依序補低於目標最多的格子；缺口小於總資產 0.25% 的不補；剩下的進核心' });
  const notif = newNotif(acct, view, { kind: 'CASHFLOW', title: `入金 ${amount} 的清單`, items: [item], deposit: amount });
  notif.preview = composeNotif(acct, view, notif);
  return { acct, notif, mergedIntoMonthly: false };
}

/**
 * 出金（設計 §2.1.1）：只賣不買，當天給清單。先做單檔上限檢查，再照
 * ① 核心的現金 → ② 動能高於目標的部分 → ③ 核心 ETF → ④ 動能按比例 → ⑤ 自選按比例。
 */
export function withdraw(acct0: Account, view: MarketView, amount: number): { acct: Account; notif: Notif } {
  const acct = clone(acct0);
  const values = cellValues(acct, view);
  const plan = planDay({ cfg: acct.cfg, values, state: acct.rule, flow: { kind: '出金', amount } });
  const lines = planToLines(plan, values, { price: (t) => priceOf(view, t), shares: shareCells(acct) });
  const item = makeItem({ f: 'F12', kind: 'CASHFLOW', title: `出金 ${amount}：只賣不買`, choices: [{ id: 'DO', label: '照做', lines }], noSkip: true, why: '先做單檔上限檢查；再照 核心現金 → 動能高於目標 → 核心 ETF → 動能 → 自選' });
  const notif = newNotif(acct, view, { kind: 'CASHFLOW', title: `出金 ${amount} 的清單`, items: [item], withdraw: amount });
  notif.preview = composeNotif(acct, view, notif);
  return { acct, notif };
}

/**
 * 取消自己發起的入金／出金／改比例（設計 §10 第 40 點）：只有還沒填快照前可以（等你決定、等你下單）。
 * 入金：帳上現金與單位退回（記一筆出金「取消入金」）；出金：清單作廢（快照之前還沒記帳）；改比例：比例與標準比重改回，影子紀錄作廢。
 */
export function cancelCashflow(acct0: Account, view: MarketView, id: number): { acct: Account; ok: boolean; error?: string } {
  const acct = clone(acct0);
  const n = acct.notifs.find((x) => x.id === id);
  if (!n || n.kind !== 'CASHFLOW' || !cashflowKind(n)) return { acct: acct0, ok: false, error: '這則不是入金、出金或改比例的清單' };
  if (n.status !== 'PENDING' && n.status !== 'RESPONDED') return { acct: acct0, ok: false, error: '這份清單已經結束（填過快照），要改請用「復原上一份快照」' };
  const kind = cashflowKind(n)!;
  if (kind === '入金') {
    const amt = n.deposit ?? 0;
    acct.cash -= amt;
    recordExternalFlow(acct, view, -amt);
    const ev = acct.events.at(-1);
    if (ev) ev.reason = `取消入金（通知 #${id}）`;
  } else if (kind === '改比例' && n.ratioBefore) {
    acct.cfg = { ...acct.cfg, ratio: { ...n.ratioBefore.ratio } };
    for (const [t, w] of Object.entries(n.ratioBefore.std)) if (acct.rule.own[t]) acct.rule.own[t].stdWeight = w;
    acct.shadow.push({ date: view.date, f: 'REOPEN', ticker: null, title: '取消改比例：先前的紀錄作廢', rule: 0, ai: null, actual: 0, price: 0, choice: 'REOPEN', notif: id });
  }
  for (const [tk, o] of Object.entries(acct.mom.owe)) if (o.notif === id) delete acct.mom.owe[tk];
  n.status = 'CANCELLED';
  n.note = `已取消（${view.date}）`;
  return { acct, ok: true };
}

/** 入金、出金、改比例的清單是哪一種（看項目的功能代號）。 */
export function cashflowKind(n: Notif): '入金' | '出金' | '改比例' | null {
  if (n.kind !== 'CASHFLOW') return null;
  const f = n.items[0]?.f;
  return f === 'F11' ? '入金' : f === 'F12' ? '出金' : f === 'F13' ? '改比例' : null;
}

/** 改比例（設計 §2.1 第 7 點）：使用者觸發，當天給清單；影子組合繼續追蹤「如果沒改」。 */
export function changeRatio(acct0: Account, view: MarketView, ratio: { own: number; strat: number; core: number }): { acct: Account; notif: Notif } {
  const acct = clone(acct0);
  const old = acct.cfg.ratio;
  const ratioBefore = { ratio: { ...old }, std: Object.fromEntries(Object.entries(acct.rule.own).map(([t, o]) => [t, o.stdWeight])) };
  const total = totalValue(acct, view);
  const lines: OrderLine[] = [];
  // 自選：每檔股數與標準比重都乘上「新比例 ÷ 舊比例」（原型假設 7）
  if (Math.abs(ratio.own - old.own) > 1e-9) {
    const f = old.own > 0 ? ratio.own / old.own : 1;
    for (const tk of Object.keys(acct.rule.own)) {
      acct.rule.own[tk].stdWeight *= f;
      const cur = acct.lots.own[tk] ?? 0;
      const d = Math.round(cur * f) - cur;
      if (d) lines.push({ ticker: tk, bucket: 'own', shares: d, reason: '改比例' });
    }
  }
  acct.cfg = { ...acct.cfg, ratio: { ...ratio } };
  const slot = momSlotTarget(acct.cfg, total, acct.rule.effPrev ?? 1);
  for (const tk of new Set([...Object.keys(acct.lots.mom), ...acct.rule.heldMom])) {
    const cur = acct.lots.mom[tk] ?? 0;
    let tgt = 0;
    if (acct.rule.heldMom.includes(tk)) {
      const ownVal = (acct.lots.own[tk] ?? 0) * priceOf(view, tk);
      const room = acct.cfg.crossCapBuy !== null ? Math.max(0, acct.cfg.crossCapBuy * total - ownVal) : Infinity;
      tgt = Math.floor(Math.min(slot, room) / priceOf(view, tk));
    }
    if (tgt !== cur) lines.push({ ticker: tk, bucket: 'mom', shares: tgt - cur, reason: '改比例' });
  }
  const fmt = (r: typeof ratio) => [r.own, r.strat, r.core].map((x) => `${Math.round(x * 100)}%`).join(' / ');
  const item = makeItem({ f: 'F13', kind: 'CASHFLOW', title: `改比例：自選 / Strategy / 核心 ${fmt(old)} → ${fmt(ratio)}`, choices: [{ id: 'DO', label: '照做', lines }], noSkip: true });
  const notif = newNotif(acct, view, { kind: 'CASHFLOW', title: '改比例的清單', items: [item], ratioBefore });
  notif.preview = composeNotif(acct, view, notif);
  acct.shadow.push({ date: view.date, f: 'F13', ticker: null, title: '改比例（影子組合繼續追蹤「如果沒改」）', rule: 0, ai: null, actual: 0, price: 0, choice: 'RATIO', note: `${fmt(old)} → ${fmt(ratio)}`, notif: notif.id });
  return { acct, notif };
}

// ---------------------------------------------------------------- 自選：新增、移除

export interface AddOwnResult {
  acct: Account;
  notif: Notif;
  /** 加入後每檔自選的推薦標準比重（其他檔只是重算推薦值，不會因此叫你賣）。 */
  recommended: Record<string, number>;
  /** 一開始就是減半狀態（距 52 週高點已跌 ≥ 20%）。 */
  startsHalved: boolean;
  /** 跨桶上限：動能已持有這檔時，自選還能買到多少金額。 */
  crossRoom: number;
}

/** 新增自選（設計 §2.2）：建議標準比重（波動度反比）、錢從核心出、初始狀態照慢規則。 */
export function addOwn(acct0: Account, view: MarketView, ticker: string, premises?: Premise[], stdWeight?: number): AddOwnResult {
  const acct = clone(acct0);
  const recommended = recommendStdWeights(view, [...Object.keys(acct.rule.own), ticker], acct.cfg.ratio.own);
  const meta = newOwnMeta(view, ticker, 'NEW', premises?.length ? premises : clone(SYSTEM_DEFAULT_PREMISES));
  const std = stdWeight ?? recommended[ticker];
  const half = meta.slow.state === 'HALF';
  acct.own[ticker] = meta;
  acct.rule.own[ticker] = { applied: meta.slow.state, stdWeight: std };
  const total = totalValue(acct, view);
  const px = priceOf(view, ticker);
  const cur = acct.lots.own[ticker] ?? 0;
  const sh = Math.max(0, Math.floor((std * total * (half ? 0.5 : 1)) / px) - cur);
  const crossRoom = (acct.cfg.crossCapBuy ?? Infinity) * total - (acct.lots.mom[ticker] ?? 0) * px;
  const item = makeItem({
    f: 'F14',
    kind: 'CASHFLOW',
    ticker,
    title: half ? `新增自選 ${ticker}：距高點已跌超過 20% → 一開始就是減半狀態，只買標準比重的一半` : `新增自選 ${ticker}：買到標準比重 ${(std * 100).toFixed(1)}%`,
    choices: [{ id: 'DO', label: '照做', lines: sh ? [{ ticker, bucket: 'own', shares: sh, reason: '新增自選' }] : [] }],
    why: '錢從核心出（賣核心 ETF）',
  });
  const notif = newNotif(acct, view, { kind: 'CASHFLOW', title: `新增自選 ${ticker}`, items: [item] });
  notif.preview = composeNotif(acct, view, notif);
  return { acct, notif, recommended, startsHalved: half, crossRoom };
}

/** 移除自選（F15）：全部賣出、錢回核心，這檔不再有規則或 AI 追蹤；影子組合繼續記「如果繼續持有」。 */
export function removeOwn(acct0: Account, view: MarketView, ticker: string): { acct: Account; notif: Notif } {
  const acct = clone(acct0);
  const sh = acct.lots.own[ticker] ?? 0;
  const item = makeItem({
    f: 'F15',
    kind: 'CASHFLOW',
    ticker,
    title: `移除自選 ${ticker}`,
    choices: [{ id: 'DO', label: '照做', lines: sh ? [{ ticker, bucket: 'own', shares: -sh, reason: '移除自選' }] : [], effects: [{ type: 'REMOVE_OWN', ticker }] }],
  });
  const notif = newNotif(acct, view, { kind: 'CASHFLOW', title: `移除自選 ${ticker}`, items: [item] });
  notif.preview = composeNotif(acct, view, notif);
  acct.shadow.push({ date: view.date, f: 'F15', ticker, title: '移除自選（如果繼續持有）', rule: 0, ai: null, actual: -sh, price: priceOf(view, ticker), choice: 'REMOVE' });
  return { acct, notif };
}

// ---------------------------------------------------------------- 月報上的動作：轉入自選、排除、認養

/**
 * 幫一檔自選加前提（持股頁，2026-11-15 起取代新增自選頁的前提欄）。
 * 原本只有系統預設前提時，換成新寫的（三層備案：你寫的 → 勾選的 AI 草稿 → 系統預設）；否則接在後面。
 */
export function addPremises(acct0: Account, ticker: string, premises: Omit<Premise, 'id'>[]): Account {
  const acct = clone(acct0);
  const meta = acct.own[ticker];
  if (!meta || !premises.length) return acct0;
  const keep = meta.premises.every((p) => p.origin === 'SYSTEM_DEFAULT') ? [] : meta.premises;
  meta.premises = [...keep, ...premises].map((p, k) => ({ ...p, id: `P${k + 1}` }));
  return acct;
}

/** 改一檔自選的標準比重（持股頁；設計 §2.2「系統推薦，使用者可改」）。只改之後加回、入金用的目標，不下單。 */
export function setStdWeight(acct0: Account, ticker: string, stdWeight: number): Account {
  const acct = clone(acct0);
  if (!acct.rule.own[ticker] || !(stdWeight > 0)) return acct0;
  acct.rule.own[ticker].stdWeight = stdWeight;
  return acct;
}

function ensureOwnMeta(acct: Account, view: MarketView, ticker: string, origin: 'TRANSFER' | 'ADOPT' | 'MANUAL', reason?: string): void {
  if (acct.own[ticker]) {
    if (reason) acct.own[ticker].premises = addPremises(acct, ticker, [{ text: reason, origin: 'USER' }]).own[ticker].premises;
    return;
  }
  const rec = recommendStdWeights(view, [...Object.keys(acct.rule.own), ticker], acct.cfg.ratio.own);
  const meta = newOwnMeta(view, ticker, origin, reason ? [{ id: 'P1', text: reason, origin: 'USER' }] : clone(SYSTEM_DEFAULT_PREMISES));
  acct.own[ticker] = meta;
  acct.rule.own[ticker] = { applied: meta.slow.state, stdWeight: rec[ticker] };
}

/** 桶和桶之間搬股數（不用下單）時，單位數跟著搬。 */
function moveBetweenBuckets(acct: Account, view: MarketView, from: 'own' | 'mom', to: 'own' | 'mom', ticker: string, shares: number): void {
  const amt = shares * priceOf(view, ticker);
  const vFrom = bucketValue(acct, view, from);
  const vTo = bucketValue(acct, view, to);
  addLot(acct, from, ticker, -shares);
  addLot(acct, to, ticker, shares);
  acct.units[from] = flowUnits(acct.units[from], vFrom, -amt);
  acct.units[to] = flowUnits(acct.units[to], vTo, amt);
  acct.events.push({ date: view.date, kind: 'TRANSFER', ticker, bucket: to, shares, reason: `${from} → ${to}` });
}

export interface ItemActionInput {
  action: 'TRANSFER' | 'EXCLUDE' | 'ADOPT';
  /** 要寫一句理由（轉入自選、認養時成為這檔的前提）。 */
  reason: string;
  /** 排除後重算月報時，本月被任務 A 否決的代號（遞補者也要過任務 A）。 */
  vetoed?: string[];
}

/**
 * 轉入自選：動能叫你賣但你想留 → 這部分改歸自選桶，不用下單。
 * 排除：不想買動能選出的某一檔 → 寫理由後排除，由下一名遞補（重算月報）。
 * 認養：動能選出、你也看好 → 照常買進但記在自選；動能那一格下個月才遞補（原型假設 8）。
 */
export function itemAction(acct0: Account, view: MarketView, notifId: number, itemKey: string, input: ItemActionInput): { acct: Account; notif: Notif | null } {
  const acct = clone(acct0);
  const n = acct.notifs.find((x) => x.id === notifId);
  const it = n?.items.find((x) => x.key === itemKey);
  if (!n || !it || n.status !== 'PENDING' || !it.ticker || !it.actions?.includes(input.action)) return { acct, notif: null };
  const tk = it.ticker;
  const listed = sumFor(it.choices[0].lines, tk);
  if (input.action === 'TRANSFER') {
    const sh = acct.lots.mom[tk] ?? 0;
    ensureOwnMeta(acct, view, tk, 'TRANSFER', input.reason);
    moveBetweenBuckets(acct, view, 'mom', 'own', tk, sh);
    it.cancelled = true;
    it.note = '已轉入自選（不用下單）';
    acct.shadow.push({ date: view.date, f: 'F16', ticker: tk, title: '轉入自選（如果照賣）', rule: -sh, ai: null, actual: 0, price: priceOf(view, tk), choice: 'TRANSFER', note: input.reason });
    n.preview = composeNotif(acct, view, n);
    return { acct, notif: n };
  }
  if (input.action === 'ADOPT') {
    acct.mom.adopted[tk] = { reason: input.reason, date: view.date };
    acct.rule.heldMom = acct.rule.heldMom.filter((x) => x !== tk);
    ensureOwnMeta(acct, view, tk, 'ADOPT', input.reason);
    it.choices[0].lines = it.choices[0].lines.map((l) => ({ ...l, bucket: 'own' as const, reason: '新增自選' }));
    it.title += '（認養 → 自選）';
    it.actions = [];
    it.kind = 'CASHFLOW';
    n.preview = composeNotif(acct, view, n);
    return { acct, notif: n };
  }
  // EXCLUDE：回到月報前的狀態重算，被排除的由下一名遞補
  if (!n.monthly) return { acct, notif: null };
  acct.mom.excluded[tk] = { reason: input.reason, date: view.date };
  acct.shadow.push({ date: view.date, f: 'F16', ticker: tk, title: '排除（如果沒排除）', rule: listed, ai: null, actual: 0, price: priceOf(view, tk), choice: 'EXCLUDE', note: input.reason });
  n.status = 'SUPERSEDED';
  acct.rule = clone(n.monthly.before.rule);
  acct.own = clone(n.monthly.before.own);
  acct.mom.owe = clone(n.monthly.before.owe);
  const ctx = { ...n.monthly.input, vetoed: [...new Set([...(n.monthly.input.vetoed ?? []), ...(input.vetoed ?? [])])] };
  const flow = n.deposit ? ({ kind: '入金', amount: n.deposit } as const) : undefined;
  const r: MonthlyResult = monthlyReport(acct, view, ctx, flow, true);
  return { acct: r.acct, notif: r.notif };
}

/** 取消排除（排除清單在網站，可隨時取消）。 */
export function unexclude(acct0: Account, ticker: string): Account {
  const acct = clone(acct0);
  delete acct.mom.excluded[ticker];
  return acct;
}

// ---------------------------------------------------------------- 清單外的變動：分類

export interface ClassifyInput {
  bucket: 'own' | 'mom';
  /** 買進歸自選時的一句理由（成為前提，沒寫用系統預設前提）；賣出時是為什麼賣（記在事件與影子上）。 */
  reason?: string;
  /** 自選賣到 0 股時，同時移出自選（同移除自選，不用下單；設計 §10 第 37 點）。 */
  removeOwn?: boolean;
}

/**
 * 快照出現清單外的變動，使用者回答屬於哪一桶（設計 §2.3.1，2026-11-11 定案）：
 *   清單外買進的股票只能歸自選（新增或加碼）；
 *   只有該檔在當月動能名單上、而且動能那一格還沒買足時，才能歸動能。
 *   賣出則從持有它的那一桶扣。
 * 回傳 error 表示這個分類不允許。
 */
export function classify(acct0: Account, view: MarketView, notifId: number, input: ClassifyInput): { acct: Account; error?: string; monthlyUnblocked: boolean } {
  const acct = clone(acct0);
  const n = acct.notifs.find((x) => x.id === notifId && x.kind === 'CLASSIFY' && x.status === 'PENDING');
  if (!n || !n.ticker) return { acct: acct0, error: '找不到這則分類通知', monthlyUnblocked: false };
  const tk = n.ticker;
  const q = acct.lots.unc[tk] ?? 0;
  const px = priceOf(view, tk);
  if (q > 0 && input.bucket === 'mom') {
    const total = totalValue(acct, view);
    const slot = momSlotTarget(acct.cfg, total, acct.rule.effPrev ?? 1);
    const held = (acct.lots.mom[tk] ?? 0) * px;
    if (!acct.rule.heldMom.includes(tk)) return { acct: acct0, error: `${tk} 不在這個月的動能名單上，清單外買進只能歸自選`, monthlyUnblocked: false };
    if (held + q * px > slot * (1 + (acct.cfg.lazyBand ?? 0.5))) return { acct: acct0, error: `${tk} 的動能那一格已經買足，多買的部分只能歸自選`, monthlyUnblocked: false };
  }
  if (q < 0 && (acct.lots[input.bucket][tk] ?? 0) < -q) return { acct: acct0, error: `${input.bucket === 'own' ? '自選' : '動能'}桶沒有這麼多 ${tk} 可以賣`, monthlyUnblocked: false };
  const removing = !!input.removeOwn;
  if (removing && !(input.bucket === 'own' && q < 0 && acct.own[tk] && (acct.lots.own[tk] ?? 0) + q === 0)) return { acct: acct0, error: `只有把自選的 ${tk} 全部賣掉時，才能同時移出自選`, monthlyUnblocked: false };
  const vBefore = bucketValue(acct, view, input.bucket);
  const coreBefore = bucketValue(acct, view, 'core');
  delete acct.lots.unc[tk];
  if (input.bucket === 'own' && q > 0) ensureOwnMeta(acct, view, tk, 'MANUAL', input.reason);
  addLot(acct, input.bucket, tk, q);
  acct.units[input.bucket] = flowUnits(acct.units[input.bucket], vBefore, q * px);
  acct.units.core = flowUnits(acct.units.core, coreBefore + q * px, -q * px);
  if (input.bucket === 'mom') delete acct.mom.owe[tk];
  if (removing) removeOwnPick(acct, tk);
  const why = removing ? (input.reason ? `${input.reason}（賣光並移出自選）` : '賣光並移出自選') : input.reason;
  acct.events.push({ date: view.date, kind: 'CLASSIFIED', ticker: tk, bucket: input.bucket, shares: q, reason: why });
  acct.shadow.push({ date: view.date, f: 'F17', ticker: tk, title: removing ? '手動交易：賣光並移出自選（如果繼續持有）' : '手動交易', rule: 0, ai: null, actual: q, price: px, choice: 'MANUAL', note: why });
  n.status = 'DONE';
  n.note = input.bucket;
  const unblocked = acct.monthlyBlocked && !monthlyWait(acct);
  if (unblocked) acct.monthlyBlocked = false;
  return { acct, monthlyUnblocked: unblocked };
}

export type { Item };
