// 使用者的操作：回覆清單、填快照、入金、出金、改比例、新增／移除自選、轉入自選、認養、排除、分類。
// 設計：§2.1.1（快照式帳本、入金出金）、§2.3（操作方式）、§2.3.1（操作和清單不同時）。
import {
  SYSTEM_DEFAULT_PREMISES,
  addLot,
  bookShares,
  bucketValue,
  cellValues,
  clone,
  defaultStdWeight,
  flowUnits,
  makeItem,
  newNotif,
  newOwnMeta,
  nextPremiseSeq,
  priceOf,
  recommendStdWeights,
  shareCells,
  totalValue,
  type Account,
  type CloseReason,
  closedThesisOf,
  fileMeta,
  MAX_WATCH,
  newFileId,
  type WatchMeta,
  type Effect,
  type Item,
  type MarketView,
  type Notif,
  type OwnMeta,
  type Premise,
  type PremiseVerify,
  PREMISE_FIELD_LIMITS,
  breaksOf,
  normVerify,
  type ShadowRecord,
  type Thesis,
  type Tier,
  usd,
  notifDay,
} from './account';
import { momSlotTarget, ownDepositFill, ownDepositScale, planDay } from './allocator';
import { BUY_CASH_FRACTION, capBuys, planToLines, type OrderLine } from './orders';
import { EDITED_REASON, KEPT_REASON, RULE_OVER_EXIT_REASON, SELF_HALVE_MIN, SKIPPED_REASON, addDispute, clearBuild, endDisputesFor, afterOpenLists, cancelThesisDrop, composeNotif, crashReviewOf, leaveWatch, monthlyReport, monthlyWait, rebuildThesisDrop, watchEntryWant, recordExternalFlow, refreshCoreBand, refreshOwnAiChoice, restoreSaved, thesisDropShadow, type MonthlyResult } from './report';
import { halveShares } from './slowRule';
import { buyAllowed, lastBrokenAt, watchBuyFacts, watchRecWeight } from './buy';
import { appliedOf, cellKey, pickFrac, setApplied, type Bucket } from './types';

const sumFor = (lines: OrderLine[], ticker: string) => lines.filter((l) => l.ticker === ticker).reduce((a, l) => a + l.shares, 0);

// ---------------------------------------------------------------- 回覆通知

export interface ResponseInput {
  /** DO = 照目前每一項選的選項做；SKIP = 整則這次不做。 */
  mode: 'DO' | 'SKIP';
  /** 每一項選哪個選項（item key → RULE／AI／DO／SKIP）；沒給的用預設。 */
  choices?: Record<string, 'RULE' | 'AI' | 'DO' | 'SKIP'>;
  /** 每一項的一句理由（item key → 文字）：選了「這次不做」才記下（甲類、當天的乙類一定要寫，見 missingReasons）。 */
  reasons?: Record<string, string>;
}

/** 理由最多幾個字（own_thesis §1.10）。 */
export const REASON_MAX = 200;

/** 這次回覆最後選的選項（整則不做 = SKIP；沒給或不認得的用目前的）。 */
const finalChoice = (it: Item, input: ResponseInput) => {
  if (input.mode === 'SKIP') return 'SKIP';
  const c = input.choices?.[it.key];
  return c && it.choices.some((x) => x.id === c) ? c : it.choice;
};

/** 選了「這次不做」、卻沒寫理由的項目（要寫理由的：甲類、當天的乙類；own_thesis §1.10）。網站回覆前檢查，沒寫不能送出。 */
export function missingReasons(n: Notif, input: ResponseInput): Item[] {
  return n.items.filter((it) => !it.cancelled && it.reasonRequired && finalChoice(it, input) === 'SKIP' && !(input.reasons?.[it.key] ?? '').trim());
}

/** 崩盤規則的項目（F5 啟動／F6 解除，含重列的）。2026-11-22 起不再產生（allocation_redesign §1.6）；這裡只處理還留著的舊通知。 */
const isCrashItem = (it: Item) => it.f === 'F5' || it.f === 'F6';

/** f：產生這個選項的項目（F19 硬事件、F25 條件成立…），出清時記論點檔結案的原因用。 */
function applyEffects(acct: Account, view: MarketView, effects: Effect[] | undefined, f?: string): void {
  for (const e of effects ?? []) {
    if (e.type === 'REMOVE_OWN') removeOwnPick(acct, e.ticker, 'REMOVED', view.date);
    else if (e.type === 'MOM_DROP') acct.rule.heldMom = acct.rule.heldMom.filter((t) => t !== e.ticker);
    else if (e.type === 'CLEAR_FLAG') {
      if (acct.own[e.ticker]) acct.own[e.ticker].flags = [];
    } else if (e.type === 'BUILD_END') endBuildIn(acct, view, e.ticker, e.keep);
    else if (e.type === 'DIP_ADD') {
      // 下跌加碼照做了（allocation_redesign §4.4，T84）：記下哪一天（同一次下跌不會再提；提高到 125% 的 raisedAt 由同一個選項的 APPLY_TIER 記）
      const m = acct.own[e.ticker];
      if (m) m.dipAdd = { ...(m.dipAdd && m.dipAdd.episode === e.episode ? m.dipAdd : { episode: e.episode, level: m.watchLevel ?? 0, offered: view.date }), at: view.date };
    } else if (e.type === 'WATCH_ENTER') {
      // 候補進場（F29，allocation_redesign §4.5 第 17 點）：快照的自選桶這一檔真的有股數才轉成持股；沒買的還是候補
      if (!((acct.lots.own[e.ticker] ?? 0) > 0)) continue;
      // 候補已經不在（照做之後、填快照之前被別的路轉走）：這幾股還是要有人管，照自己買進開檔
      if (!promoteWatch(acct, view, e.ticker, 'F29', { std: e.std, ...(e.conds ? { conds: e.conds } : {}) }) && !acct.own[e.ticker]) ensureOwnMeta(acct, view, e.ticker, 'MANUAL', undefined, { shares: acct.lots.own[e.ticker] ?? 0 });
    } else applyTier(acct, view, e.ticker, e.tier, f === 'F19' ? 'HARD_EVENT' : f === 'F25' ? 'EXIT_CONDITION' : 'EXIT_AI');
  }
}

/** 照 AI 檔位做之後，慢規則狀態跟著改（設計 §2.2，2026-11-11 定案）。exitReason：出清時論點檔結案的原因。 */
export function applyTier(acct: Account, view: MarketView, ticker: string, tier: Tier, exitReason: CloseReason = 'EXIT_AI'): void {
  const meta = acct.own[ticker];
  const rule = acct.rule.own[ticker];
  if (!meta || !rule) return;
  if (tier === 'EXIT') {
    removeOwnPick(acct, ticker, exitReason, view.date); // 照 AI 出清 = 移出自選（同 F15）
  } else if (tier === 'HALF' || tier === 'STANDARD') {
    const st = tier === 'HALF' ? 'HALF' : 'STD';
    // 審查後持有的股票照做了減半（跌幅審查的選項、乙類、你定的條件）或回到標準：離開審查後持有（allocation_redesign §3.3）
    if (meta.slow.state === 'WATCH') leaveWatch(meta);
    // 先買一半的股票被減半（賣掉一半的一半）或回到標準：離開先買一半（§4.1；減半之後加回時回到標準比重）
    delete meta.build;
    delete meta.buildAsk;
    meta.slow = { ...meta.slow, state: st, sinceSwitch: 0 }; // 切換日重新起算
    meta.pending = null;
    // 先買一半被減半（乙類照做、你定的條件、跌幅審查選減半）：目標是標準的四分之一（setApplied 記 fromBuild）
    setApplied(rule, st);
  } else if (tier === 'RAISE') {
    rule.stdWeight *= 1.25;
    meta.raisedAt = view.date;
  }
}

/**
 * 移出自選 = 論點檔結案（own_thesis §1.2）：記下結案的論點檔與原因，存檔時寫 log 的 CLOSE。
 * T44：也記下那一刻的論點本文與自己的前提（last），再買回時新的論點檔看得到上一份。
 */
function removeOwnPick(acct: Account, ticker: string, reason: CloseReason, date: string): void {
  const meta = acct.own[ticker];
  const fileId = meta?.fileId;
  // 最近一次前提被判不成立的日子跟著結案紀錄走（allocation_redesign §4.5 第 7 點）：之後加進候補，30 天的防線看得到
  const brokenAt = meta ? lastBrokenAt(meta) : null;
  if (meta && fileId) acct.ownClosed = { ...(acct.ownClosed ?? {}), [ticker]: { fileId, reason, date, last: closedThesisOf(meta), ...(brokenAt ? { brokenAt } : {}) } };
  delete acct.own[ticker];
  delete acct.rule.own[ticker];
  cancelOwnItems(acct, ticker, reason, date);
}

/**
 * 移出自選之後，還沒回覆的通知上這一檔的自選項目（慢規則、AI 的建議、你定的條件成立、硬事件）跟著取消
 * （T34 走一遍的缺口：先自己賣光、才回乙類通知，按「照 AI」清單還會叫你賣一次這檔）。
 * 整則都取消的（月報以外）改成已取消：不留在「等你決定」，也沒有要下的單。
 */
function cancelOwnItems(acct: Account, ticker: string, reason: CloseReason, date: string): void {
  const md = `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
  for (const n of acct.notifs) {
    if (n.status !== 'PENDING') continue;
    let hit = false;
    for (const it of n.items) {
      if (it.cancelled || it.ticker !== ticker || !it.choices.some((c) => c.lines.some((l) => l.ticker === ticker && l.bucket === 'own'))) continue;
      it.cancelled = true;
      it.note = `${md} ${ticker} 已經${reason === 'SOLD_OUT' ? '賣光、' : ''}移出自選，這一項取消`;
      hit = true;
    }
    if (hit && n.kind !== 'MONTHLY' && n.items.every((i) => i.cancelled)) {
      n.coreAbsorb = false;
      n.status = 'CANCELLED';
      delete n.preview; // 產生時試算的清單（含核心吸收現金的那一行）不再適用
    }
  }
}

/**
 * 策略項目的一行用回覆當天的總資產與價格重算（T39b；和 planToLines 同一套換算）：目標 = 訊號日的目標比例 × 今天的總資產，
 * 和今天帳本上的市值比——目標 0 → 全部賣出；要賣 → 四捨五入、不超過持有；要買 → 無條件捨去。
 * 方向和原本那一行相反時（價格動了、已經不用做）當成 0，和自選加回「不買負的」相同。
 */
function lateLine(acct: Account, view: MarketView, l: OrderLine, w: number, total: number): OrderLine {
  const have = acct.lots[l.bucket][l.ticker] ?? 0;
  const px = priceOf(view, l.ticker);
  const cur = have * px;
  const tgt = w * total;
  const sh = tgt <= 1e-9 ? -have : tgt < cur ? -Math.min(have, Math.round((cur - tgt) / px)) : Math.floor((tgt - cur) / px + 1e-9);
  return { ...l, shares: Math.sign(sh) === Math.sign(l.shares) ? sh : 0 };
}

/**
 * 晚回覆的策略項目（動能、回調、上限、閒置現金、併進月報的入金；T39b 第 3 項）：照 §2.3.1「忘了」用回覆當天的價格重算股數，
 * 和自選慢規則項目同一套。有目標比例（targetW）的行照 lateLine；核心吸收的那幾行本來就在回覆時用當天的現金與價格合成，不用另外算；
 * 核心比例調回（F26）另外重算（refreshCoreBand）。沒有 targetW 的舊通知、舊的崩盤項目（F5／F6，規則已經退場）照原本的股數。
 */
function recomputeLateStrategy(acct: Account, view: MarketView, it: Item): void {
  const c = it.choices[0];
  if (!c || (it.kind !== 'STRATEGY' && it.f !== 'F11')) return;
  if (!it.targetW || isCrashItem(it)) return;
  const total = totalValue(acct, view);
  const lines = c.lines.flatMap((l) => {
    if (l.bucket === 'core') return [l];
    const w = it.targetW?.[cellKey(l.bucket, l.ticker)];
    return w === undefined ? [l] : [lateLine(acct, view, l, w, total)];
  });
  c.lines = lines.filter((l) => l.shares !== 0);
  const note = `晚回覆：用 ${view.date} 收盤價重算`;
  it.note = it.note && !it.note.includes('晚回覆') ? `${it.note}；${note}` : note;
}

/**
 * 晚回覆的候補進場（F29，allocation_redesign §4.5）：候補已經不在（移除了、或自己先買轉成持股）→ 取消；
 * 其餘照回覆當天的總資產與價格重算先買一半的股數，買進前的程式檢查（30 天內前提被判不成立、跨桶上限）再過一次，沒過就不用買。
 * 這一行是 bucket own，但 rule.own 還沒有這檔，所以不走自選規則單那一套（那一套看慢規則狀態）。
 */
function recomputeLateEntry(acct: Account, view: MarketView, it: Item): void {
  const tk = it.ticker!;
  const c = it.choices.find((x) => x.id === 'DO');
  if (!acct.watch?.[tk] || !c || !it.watchEntry) {
    it.cancelled = true;
    it.note = acct.own[tk] ? `${tk} 已經轉成持股，這一項取消` : `${tk} 已經不在候補名單，這一項取消`;
    return;
  }
  const v = buyAllowed(watchBuyFacts(acct, view, tk, view.date, watchEntryWant(acct, view, tk, it.watchEntry.std)));
  c.lines = v.ok ? [{ ticker: tk, bucket: 'own', shares: v.shares, reason: '候補進場' }] : [];
  c.label = v.ok ? `照做：先買一半，買 ${v.shares} 股` : '照做（重算後不用買）';
  it.note = `晚回覆：用 ${view.date} 收盤價重算${v.ok ? `，買 ${v.shares} 股` : `；${v.why ?? '買進前的程式檢查沒過'}，不用買`}`;
}

/** 晚回覆（提醒過才回）：規則狀態已反轉的自選項目取消，其餘自選規則單與策略項目用今天的價格重算（設計 §2.3.1「忘了」）。 */
function recomputeLate(acct: Account, view: MarketView, n: Notif): void {
  for (const it of n.items) {
    if (!it.cancelled && it.kind === 'WATCH_ENTRY') {
      recomputeLateEntry(acct, view, it);
      continue;
    }
    if (!it.cancelled && it.kind !== 'OWN_RULE') recomputeLateStrategy(acct, view, it);
    if (it.kind !== 'OWN_RULE' || !it.ticker || it.cancelled) continue;
    const tk = it.ticker;
    const meta = acct.own[tk];
    const rule = acct.rule.own[tk];
    if (!meta || !rule) {
      it.cancelled = true;
      continue;
    }
    if (it.thesisDrop) {
      // 有論點的股票的跌幅審查（allocation_redesign §3.2）：狀態照做了才變；已經不在審查後持有（回到標準、另外減半了）就取消，否則照今天的持股重算股數
      if (meta.slow.state !== 'WATCH') {
        it.cancelled = true;
        it.note = '這檔已經不在審查後持有（回到標準或已經減半），這一項取消';
        continue;
      }
      rebuildThesisDrop(acct, view, n, it);
      it.note = `晚回覆：用 ${view.date} 收盤價重算`;
      continue;
    }
    const expected = it.f === 'F7' ? 'HALF' : 'STD';
    if (meta.slow.state !== expected) {
      it.cancelled = true;
      it.note = '期間規則狀態已反轉，這一項取消';
      setApplied(rule, appliedOf(meta.slow.state, !!meta.build));
      meta.pending = null;
      continue;
    }
    const cur = acct.lots.own[tk] ?? 0;
    const sh = it.f === 'F7' ? -halveShares(cur) : Math.max(0, Math.floor((rule.stdWeight * totalValue(acct, view)) / priceOf(view, tk)) - cur);
    it.choices[0].lines = sh ? [{ ticker: tk, bucket: 'own', shares: sh, reason: '自選訊號' }] : [];
    it.note = `晚回覆：用 ${view.date} 收盤價重算`;
  }
  // 核心比例調回（F26）：其他項目重算完之後，照今天的持股與價格再檢查一次（allocation_redesign §1.3）
  refreshCoreBand(acct, view, n);
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
    // 選了不做的那一句理由（改決定之後再回覆時以這次的為準）
    const why = (input.reasons?.[it.key] ?? '').trim().slice(0, REASON_MAX);
    if (it.choice === 'SKIP' && why) it.reason = why;
    else delete it.reason;
  }
  n.respondedAt = view.date;
  n.respondedSeq = view.i;
  n.composed = composeNotif(acct, view, n);
  for (const it of n.items) {
    if (it.cancelled) continue;
    // 改比例（core_ai §3.11）：照合成後的清單（含核心）每一檔記一筆，規則 0 股（沒改的話不動），現有的影子算法就算得出「如果沒改」
    if (it.f === 'F13') {
      const note = /(\d+% \/ \d+% \/ \d+% → \d+% \/ \d+% \/ \d+%)/.exec(it.title)?.[1];
      for (const m of n.composed.merged) {
        if (!m.shares) continue;
        acct.shadow.push({ date: view.date, f: 'F13', ticker: m.ticker, title: RATIO_SHADOW_TITLE, rule: 0, ai: null, actual: m.shares, price: priceOf(view, m.ticker), choice: 'RATIO', notif: n.id, ...(note ? { note } : {}) });
      }
      continue;
    }
    // 跌幅審查（有論點的股票）：三條線每一次都記——照舊的慢規則（減半）、照 AI、實際（allocation_redesign §3.2）
    if (it.thesisDrop && it.ticker) {
      acct.shadow.push(thesisDropShadow(view, n, it));
      continue;
    }
    const rule = it.choices.find((c) => c.id === it.ruleChoice);
    const ai = it.choices.find((c) => c.id === 'AI');
    const act = it.choices.find((c) => c.id === it.choice);
    const crash = isCrashItem(it);
    // 崩盤項目（core_ai §3.4）：照做那一行的每一檔都記（VOO、短債、動能那幾檔）；AI 的意見來自檢視的狀態（三票一致才有，延後 = 0 股）
    const cr = crash ? crashReviewOf(it) : undefined;
    const tickers = it.ticker && !crash ? [it.ticker] : [...new Set((rule?.lines ?? []).map((l) => l.ticker))];
    for (const tk of tickers) {
      const ruleSh = sumFor(rule?.lines ?? [], tk);
      const rec = {
        date: view.date,
        f: it.f,
        ticker: tk,
        title: it.title,
        rule: ruleSh,
        ai: crash ? (cr?.state === 'OPINION' && cr.opinion ? (cr.opinion === '照做' ? ruleSh : 0) : null) : ai ? sumFor(ai.lines, tk) : null,
        actual: sumFor(act?.lines ?? [], tk),
        price: view.close[tk] ? priceOf(view, tk) : 0,
        choice: it.choice,
        notif: n.id,
        ...(it.runIds?.length ? { runIds: [...it.runIds] } : {}),
        ...(it.reason ? { note: it.reason } : {}),
      };
      // 慢規則項目上 AI 的那一行可能只是「同意減半」「沒有一致結論」（沒有另一個選項）：照規則做了就不用記
      // 崩盤項目一律記（每一次切換都有紀錄，§3.4）
      // 補滿（F27）、你定的加碼條件（F28）、候補進場（F29）每一次都記三條線（allocation_redesign §6；T84、T85）：照做了也記，之後看得到買進的效果
      if (crash || rec.ai !== null || rec.actual !== rec.rule || (it.aiLine && it.kind !== 'OWN_RULE') || it.kind === 'OWN_FILL' || it.kind === 'OWN_ADD' || it.kind === 'WATCH_ENTRY') acct.shadow.push(rec);
      // 策略類不做 → 下一份月報把差額再列一次；自選規則與 AI 建議是一次性的，不再提醒。
      // 舊的崩盤項目（規則已經退場）與核心比例調回（F26，kind 是 CORE_BAND）不記欠單：下個月月報照持股重算（allocation_redesign §1.3）
      if (it.kind === 'STRATEGY' && it.choice === 'SKIP' && rec.rule !== 0 && !isCrashItem(it)) acct.mom.owe[tk] = { since: view.date, notif: n.id };
    }
  }
  // 乙類沒有照 AI（不同意並寫了理由，或月報裡沒動它）→ 那條前提進靜默期（own_thesis §1.10）
  // 慢規則減半項目上 AI 建議出清、你選了照規則或這次不做 → 一樣進靜默期（§3.4），免得下一次審查又為同一條前提通知
  for (const it of n.items) {
    if (it.cancelled || it.brk?.type !== 'B' || !it.ticker || !acct.own[it.ticker]) continue;
    if (it.brk.withRule) {
      if (disputesRule(it)) addDispute(acct.own[it.ticker], it.brk.premiseId, view.date, it.reason ?? RULE_OVER_EXIT_REASON, n.id);
    } else if (it.choice === 'SKIP') addDispute(acct.own[it.ticker], it.brk.premiseId, view.date, it.reason ?? SKIPPED_REASON, n.id);
  }
  const nothingToTrade = n.composed.lines.length === 0;
  if (input.mode === 'SKIP' || n.items.every((i) => i.cancelled || i.choice === 'SKIP')) {
    n.status = 'SKIPPED';
    // 「這次不做」也有效果的項目（補滿 F27：不做 → 標準比重改成實際的比重，allocation_redesign §4.1）：整則不做時沒有快照可等，回覆當下套用
    for (const it of n.items) if (!it.cancelled) applyEffects(acct, view, it.choices.find((c) => c.id === 'SKIP')?.effects, it.f);
  } else if (nothingToTrade && !n.withdraw) {
    // 選的選項不用下單（例如 AI「維持減半」）→ 直接完成（出金除外：快照時才記出金）
    for (const it of n.items) if (!it.cancelled) applyEffects(acct, view, it.choices.find((c) => c.id === it.choice)?.effects, it.f);
    n.status = 'DONE';
  } else {
    n.status = 'RESPONDED';
  }
  // 減半項目有了最後的結果（這次不做、不用下單）→ 這一次減半的論點檢查清掉；等你下單的先留著（還可以改決定），填快照時清
  if (n.status !== 'RESPONDED') clearDropReviews(acct, n);
  return acct;
}

/**
 * 這則通知的減半項目有了最後的結果 → 那幾檔這一次減半的論點檢查清掉（own_thesis §3.3）。
 * 有論點的股票還留在審查後持有的（選了不動、這次不做）不清：持股頁要寫上一次審查的結果，留到它回到標準、減半或再跌一級（allocation_redesign §3.3）。
 */
function clearDropReviews(acct: Account, n: Notif): void {
  for (const it of n.items) {
    if (it.f !== 'F7' || it.kind !== 'OWN_RULE' || it.cancelled || !it.ticker) continue;
    const meta = acct.own[it.ticker];
    if (!meta || (meta.dropReview?.thesis && meta.slow.state === 'WATCH')) continue;
    delete meta.dropReview;
  }
}

/**
 * 慢規則項目上帶著「前提不成立」的那一行（brk.withRule），這個選擇算不算沒有照 AI → 那條前提進靜默期（own_thesis §3.4）。
 *   只有預設前提的股票（照舊）：AI 建議出清，你選了照規則或這次不做
 *   有論點的股票的跌幅審查（allocation_redesign §3.6）：這次不做；或 3 票建議出清、你選了減半
 */
function disputesRule(it: Item): boolean {
  if (!it.thesisDrop) return it.choice !== 'AI';
  return it.choice === 'SKIP' || (it.choice === 'RULE' && it.choices.some((c) => c.id === 'AI'));
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
  // 回覆時乙類「不同意」寫的靜默期一起收回（修正論點寫的那一項已經取消，不在這裡）
  for (const it of n.items) {
    if (it.cancelled || it.brk?.type !== 'B' || !it.ticker) continue;
    if (it.brk.withRule ? !disputesRule(it) : it.choice !== 'SKIP') continue;
    const meta = acct.own[it.ticker];
    const pid = it.brk.premiseId;
    if (meta?.disputes) meta.disputes = meta.disputes.filter((d) => !(d.notif === id && d.premiseId === pid));
  }
  acct.shadow.push({ date: view.date, f: 'REOPEN', ticker: null, title: '改決定：先前的回覆作廢', rule: 0, ai: null, actual: 0, price: 0, choice: 'REOPEN', notif: id });
  // 回覆之後才回來的減半檢視結果當時不動已回覆的通知（own_thesis §3.5）：退回「等你決定」時補上那一行與選項
  let out = acct;
  for (const t of new Set(n.items.filter((i) => i.kind === 'OWN_RULE' && i.f === 'F7' && !i.cancelled && !!i.ticker && !!acct.own[i.ticker]?.dropReview).map((i) => i.ticker!))) out = refreshOwnAiChoice(out, view, t).acct;
  return { acct: out, ok: true };
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
  /** 分桶快照：新加進自選的代號，使用者填的標準比重（小數）。沒填 = 現在占總資產的比重（不超過單檔上限；T43）。 */
  std?: Record<string, number>;
  /** 出金（這次完成的與之前還沒轉出的）還沒從券商轉出：券商的現金還沒扣掉（設計 §10 第 40 點）。 */
  withdrawPending?: boolean;
  /** 送出那一刻的美東日期（拆股用，design_v2 §10 第 48 點）：券商的股數已經包含生效日在這一天以前的拆股。沒給 = 訊號日。 */
  asOf?: string;
}

/** 快照之後的 splitAsOf：送出那一刻的美東日期（沒給用訊號日），不往回退。 */
function splitAsOfAfter(acct0: Account, view: MarketView, snap: Snapshot): string {
  const at = snap.asOf && snap.asOf > view.date ? snap.asOf : view.date;
  const prev = acct0.splitAsOf ?? '';
  return prev > at ? prev : at;
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
  /** 自己減碼（清單外）之後低於標準比重、之後入金與加回會補回來的自選（T43）。 */
  belowStd: BelowStd[];
  /**
   * 審查後持有的自選股，你自己賣了一半左右（清單外、賣掉原本股數的四分之一以上、還沒賣光）→ 之後照減半處理（allocation_redesign §3.6）：
   * 狀態改成減半，站回 200 日均線會提醒加回。沒有就不留這個欄位。
   */
  watchHalved?: string[];
  /** 這份快照從候補轉成持股的（allocation_redesign §4.5 第 17 點）：照月報的進場項目買的（F29）或你自己先買的（SELF），與進場後的狀態。沒有就不留這個欄位。 */
  entered?: { ticker: string; via: 'F29' | 'SELF'; state: OwnMeta['slow']['state'] }[];
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
      for (const it of n.items) if (!it.cancelled) applyEffects(acct, view, it.choices.find((c) => c.id === it.choice)?.effects, it.f);
      n.status = 'DONE';
      clearDropReviews(acct, n);
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
  acct.splitAsOf = splitAsOfAfter(acct0, view, snap);
  return { acct, completed, followUps, created, ...cashRes, removedOwn: [], belowStd: [] };
}

/**
 * 自己減碼之後低於標準比重的一檔（T43）：weight 現在占總資產、std 標準比重（加回補到這裡）、half 減半中、
 * fill 入金會補到的比重（減半的算一半；自選各檔合計超過自選比例時照比例縮小，ownDepositFill）。
 */
export interface BelowStd {
  ticker: string;
  weight: number;
  std: number;
  half: boolean;
  /** 先買一半（allocation_redesign §4.1）：入金只補到一半，另一半等財報過關後的補滿。 */
  build?: boolean;
  fill: number;
  /** 自選各檔合計超過自選比例，入金照比例少補（fill 是縮過的）。 */
  scaled: boolean;
}

/**
 * 快照裡自己賣（清單外）、還沒賣光的自選，賣完之後比標準比重低超過入金會補的最小缺口（orderMin）→ 列出來（T43）：
 * 之後的加回（減半後）補到標準比重、入金補到 fill，會把它買回來，使用者要知道。
 */
function belowStdAfterSelfSell(acct: Account, view: MarketView, tickers: string[]): BelowStd[] {
  const total = totalValue(acct, view);
  if (!(total > 0)) return [];
  const out: BelowStd[] = [];
  const scaled = ownDepositScale(acct.rule, acct.cfg.ratio.own) < 1;
  for (const t of tickers) {
    const r = acct.rule.own[t];
    if (!r || !(r.stdWeight > 0)) continue;
    const weight = ((acct.lots.own[t] ?? 0) * priceOf(view, t)) / total;
    if (r.stdWeight - weight > acct.cfg.orderMin) out.push({ ticker: t, weight, std: r.stdWeight, half: r.applied === 'HALF', ...(r.applied === 'BUILD' ? { build: true } : {}), fill: ownDepositFill(acct.rule, acct.cfg, t)!, scaled });
  }
  return out;
}

const BUCKETS3 = ['own', 'mom', 'core'] as const;

/**
 * 分桶快照（2026-11-15 使用者決定，設計 §10 第 38 點）：使用者照帳戶的三桶填每一桶每一檔的股數，
 * 變動放哪一桶由使用者決定，不再跳分類通知。
 *   清單上有的（桶＋代號）→ 照清單；差超過 1 股 → 問補做或就這樣（同 §2.3.1）
 *   清單外的：核心只能是核心 ETF／短債；動能的買進要在當月名單上、那一格還沒買足（2026-11-11 的規則照舊）；
 *     自選的新代號建立這檔（標準比重沒填就用現在占總資產的比重 T43、跌深就從減半開始、why 存成買進時的一句話，T40）；自選賣到 0 股 → 自動移出自選
 *     自己減碼之後低於標準比重的列在 belowStd（T43）
 *   現金 → 不問，差額記成其他現金變動
 */
function applyBucketSnapshot(acct0: Account, view: MarketView, snap: Snapshot, fill?: (ticker: string) => number): SnapshotResult {
  const acct = clone(acct0);
  const lots = snap.lots!;
  const px = fill ?? ((t: string) => priceOf(view, t));
  const fail = (error: string): SnapshotResult => ({ acct: acct0, completed: [], followUps: [], created: [], cashOther: 0, cashWarn: false, removedOwn: [], belowStd: [], error });
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
  /** 幾份已回覆的清單都列了同一桶同一檔時，事先分好的股數（通知編號:桶:代號 → 股數）。 */
  let split = new Map<string, number>();
  /** 拿走這一桶這一檔同方向的變動（整筆算給清單，和舊的總股數快照相同）；幾份清單共用的照 split。 */
  const take = (b: 'own' | 'mom' | 'core', t: string, listed: number, id?: number): number => {
    const k = `${id}:${b}:${t}`;
    if (split.has(k)) {
      const q = split.get(k)!;
      split.delete(k);
      return q;
    }
    const x = d[b][t] ?? 0;
    if (!x || Math.sign(x) !== Math.sign(listed)) return 0;
    delete d[b][t];
    return x;
  };
  /**
   * 同時有兩份以上已回覆、還沒填快照的清單列了同一桶同一檔（T38 走一遍的缺口：例如月報買 GE 20、入金清單又補 GE 2，
   * 或月報賣 PLTR 19、入金清單買 PLTR 3）：原本整筆變動都算給第一份，兩份都跳「和清單不同」。
   * 合計和快照的變動差不到 1 股 → 每一份照它列的股數算；否則照清單的順序、同方向的先分到它列的股數為止，多出來的算給最後一份同方向的。
   */
  const planSplit = () => {
    split = new Map();
    const claims = new Map<string, { id: number; listed: number }[]>();
    for (const n of acct.notifs) {
      if (n.status !== 'RESPONDED' || !n.composed) continue;
      const per = new Map<string, number>();
      for (const l of n.composed.lines) if (l.shares) per.set(`${l.bucket}:${l.ticker}`, (per.get(`${l.bucket}:${l.ticker}`) ?? 0) + l.shares);
      for (const [k, listed] of per) if (listed) claims.set(k, [...(claims.get(k) ?? []), { id: n.id, listed }]);
    }
    for (const [k, cs] of claims) {
      if (cs.length < 2) continue;
      const [b, t] = k.split(':') as ['own' | 'mom' | 'core', string];
      const x = d[b][t] ?? 0;
      const sum = cs.reduce((a, c) => a + c.listed, 0);
      const alloc = cs.map((c) => c.listed);
      let rest = 0;
      if (Math.abs(x - sum) <= 1) alloc[alloc.length - 1] += x - sum;
      else {
        rest = x;
        cs.forEach((c, i) => {
          const q = rest && Math.sign(c.listed) === Math.sign(rest) ? Math.sign(rest) * Math.min(Math.abs(rest), Math.abs(c.listed)) : 0;
          alloc[i] = q;
          rest -= q;
        });
        const last = cs.map((c) => Math.sign(c.listed)).lastIndexOf(Math.sign(rest));
        if (rest && last >= 0) {
          alloc[last] += rest;
          rest = 0;
        }
      }
      cs.forEach((c, i) => split.set(`${c.id}:${k}`, alloc[i]));
      if (rest) d[b][t] = rest;
      else delete d[b][t];
    }
  };

  const reconcileResponded = () => {
    planSplit();
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
          for (const [b, p] of per) assign(b, m.ticker, take(b, m.ticker, p.shares, n.id), p.reason, n.id, 'TRANSFER');
          continue;
        }
        let done = 0;
        for (const [b, p] of per) {
          const q = take(b, m.ticker, p.shares, n.id);
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
      for (const it of n.items) if (!it.cancelled) applyEffects(acct, view, it.choices.find((c) => c.id === it.choice)?.effects, it.f);
      n.status = 'DONE';
      clearDropReviews(acct, n);
      completed.push(n.id);
      if (fu.length) {
        n.followUp = fu;
        n.followUpOpen = true;
        followUps.push(n.id);
      }
    }
  };
  // 還沒按回覆、但快照顯示已經照清單做了（非核心的那幾行，同一桶有同方向的變動）→ 當成照預設選項回覆。
  // 變動先扣掉已回覆的清單列的股數再比，再和已回覆的一起對帳（T38 走一遍的缺口：同一桶同一檔在已回覆和還沒回覆的清單上都有時，
  // 原本整筆變動先算給已回覆的那一份，兩份都跳「和清單不同」，還沒回覆的那一份也留在「等你決定」）
  const claimed = new Map<string, number>();
  const claim = (c: NonNullable<Notif['composed']>) => {
    for (const l of c.lines) if (l.shares) claimed.set(`${l.bucket}:${l.ticker}`, (claimed.get(`${l.bucket}:${l.ticker}`) ?? 0) + l.shares);
  };
  for (const n of acct.notifs) if (n.status === 'RESPONDED' && n.composed) claim(n.composed);
  const left = (b: 'own' | 'mom' | 'core', t: string) => (d[b][t] ?? 0) - (claimed.get(`${b}:${t}`) ?? 0);
  for (const n of acct.notifs) {
    if (n.status !== 'PENDING' || !n.items.length || n.kind === 'INFO') continue;
    const pv = composeNotif(acct, view, n);
    if (pv.lines.some((l) => l.bucket !== 'core' && l.shares !== 0 && Math.abs(left(l.bucket, l.ticker)) > 1e-9 && Math.sign(left(l.bucket, l.ticker)) === Math.sign(l.shares))) {
      n.composed = pv;
      n.respondedAt = view.date;
      n.status = 'RESPONDED';
      claim(pv);
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
  /** 這次新加進自選、沒填標準比重的（T43：等現金也記好之後，標準比重用現在占總資產的比重）。 */
  const fresh: string[] = [];
  /** 自己賣（清單外）、還沒賣光的自選（T43：低於標準比重的要提醒，之後入金與加回會補回來）。 */
  const selfSold: string[] = [];
  /** 審查後持有、自己賣了一半左右的（allocation_redesign §3.6）：之後照減半處理。 */
  const watchHalved: string[] = [];
  for (const [t, q] of Object.entries(d.own)) {
    const why = snap.why?.[t]?.trim();
    const std = snap.std?.[t];
    const had = acct.lots.own[t] ?? 0;
    if (q > 0 && ensureOwnMeta(acct, view, t, 'MANUAL', why || undefined, std ? { std } : {}) && !std) fresh.push(t);
    // 自己賣到 0 股：自動移出自選（之後不再追蹤，也不會被加回或入金買回）
    const soldOut = q < 0 && (acct.lots.own[t] ?? 0) + q === 0 && !!acct.own[t];
    const reason = [note ? `自選的手動交易：${note}` : '自選的手動交易', soldOut ? '賣光，移出自選' : ''].filter(Boolean).join('；');
    assign('own', t, q, reason);
    if (soldOut) {
      removeOwnPick(acct, t, 'SOLD_OUT', view.date);
      removedOwn.push(t);
    } else if (q < 0 && acct.own[t]) {
      selfSold.push(t);
      // 審查後持有（通知說不減半），你自己還是賣了一半左右：系統照實際股數記，狀態改成減半，之後站回 200 日均線會有加回通知（§3.6）
      const meta = acct.own[t];
      if (meta.slow.state === 'WATCH' && had > 0 && -q >= SELF_HALVE_MIN * had && acct.rule.own[t]) {
        leaveWatch(meta);
        // 先買一半期間跌 20%、審查之後沒減半、你自己賣了一半：一樣照減半處理，離開先買一半（§4.1）
        delete meta.build;
        delete meta.buildAsk;
        meta.slow = { ...meta.slow, state: 'HALF', sinceSwitch: 0 };
        setApplied(acct.rule.own[t], 'HALF');
        cancelThesisDrop(acct, t, `${view.date} 的快照顯示你自己賣了 ${-q} 股，這檔之後照減半處理，這一項取消`);
        watchHalved.push(t);
      }
    }
    acct.shadow.push({ date: view.date, f: 'F17', ticker: t, title: soldOut ? '手動交易：賣光並移出自選（如果繼續持有）' : '手動交易（自選）', rule: 0, ai: null, actual: q, price: px(t), choice: 'MANUAL', ...(note ? { note } : {}) });
  }
  // 已回覆的清單要買（或賣）這檔自選，你卻在同一份快照把它賣光、移出自選（T38 走一遍的缺口）：
  // 那一行不再問「補做差額」（補做會替已經移出的自選再買回來）
  for (const id of [...followUps]) {
    const n = acct.notifs.find((x) => x.id === id)!;
    const ownOnly = (t: string) => (n.composed?.lines ?? []).filter((l) => l.ticker === t && l.shares).every((l) => l.bucket === 'own');
    n.followUp = (n.followUp ?? []).filter((x) => !(removedOwn.includes(x.ticker) && ownOnly(x.ticker)));
    if (!n.followUp.length) {
      delete n.followUp;
      delete n.followUpOpen;
      followUps.splice(followUps.indexOf(id), 1);
    }
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
  // 候補名單裡的代號在自選桶有了股數卻還沒轉（不該發生的組合，保險用）：照自己先買轉成持股（allocation_redesign §4.5 第 17 點）
  for (const t of Object.keys(acct.watch ?? {})) if ((acct.lots.own[t] ?? 0) > 0) promoteWatch(acct, view, t, 'SELF');
  // 這份快照從候補轉成持股的：進場時的股數照快照記好之後的
  const entered: NonNullable<SnapshotResult['entered']> = [];
  for (const [t, m] of Object.entries(acct.own)) {
    if (!m.entered || m.entered.date !== view.date || acct0.own[t]) continue;
    m.entered.shares = acct.lots.own[t] ?? 0;
    entered.push({ ticker: t, via: m.entered.via, state: m.entered.state });
  }
  // T43：新加進自選、沒填標準比重的 → 現在占總資產的比重（股數與現金都記好之後算）
  for (const t of fresh) if (acct.rule.own[t]) acct.rule.own[t].stdWeight = defaultStdFor(acct, view, t, acct.lots.own[t] ?? 0);
  const belowStd = belowStdAfterSelfSell(acct, view, selfSold);
  acct.snapshotDate = view.date;
  acct.splitAsOf = splitAsOfAfter(acct0, view, snap);
  return { acct, completed, followUps, created: [], ...cashRes, removedOwn, belowStd, ...(watchHalved.length ? { watchHalved } : {}), ...(entered.length ? { entered } : {}) };
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
    // 候補進場照做了但還沒買（候補還在）：補做的那幾股買進來之後一樣轉成持股（allocation_redesign §4.5 第 17 點）
    const enter = acct.watch?.[x.ticker] ? n.items.flatMap((i) => (i.cancelled ? [] : (i.choices.find((c) => c.id === i.choice)?.effects ?? []))).filter((e) => e.type === 'WATCH_ENTER' && e.ticker === x.ticker) : [];
    return makeItem({ f: 'F17', kind: 'FIX', ticker: x.ticker, title: `${x.ticker} 補做差額`, choices: [{ id: 'DO', label: '補做', lines: [{ ticker: x.ticker, bucket, shares: x.listed - x.done, reason: '策略單補做' }], ...(enter.length ? { effects: enter } : {}) }] });
  });
  const notif = newNotif(acct, view, { kind: 'FIX', title: '補做差額清單', items });
  notif.preview = composeNotif(acct, view, notif);
  return { acct, notif };
}

// ---------------------------------------------------------------- 入金、出金、改比例

/**
 * 入金（設計 §2.1.1）：只買不賣，當天給清單。
 * 入金遇到月報日：月報還沒回覆 → 用新的現金重算，取代原本的月報清單；已經回覆 → 另給一份入金清單。
 * 月報之後另一份清單已經回覆、還沒填快照（或有未分類的持股）時，重算的月報會暫停、入金會不見（T38 走一遍的缺口）
 * → 這時也另給一份入金清單（還沒回覆的月報先當成照預設做完了，afterOpenLists）。
 */
export function deposit(acct0: Account, view: MarketView, amount: number): { acct: Account; notif: Notif; mergedIntoMonthly: boolean } {
  const pendingMonthly = acct0.notifs.find((n) => (n.kind === 'MONTHLY' || n.kind === 'MONTHLY_EMPTY') && n.status === 'PENDING' && n.date === view.date && n.monthly);
  if (pendingMonthly?.monthly && !monthlyWait(acct0)) {
    const base = clone(acct0);
    const old = base.notifs.find((n) => n.id === pendingMonthly.id)!;
    old.status = 'SUPERSEDED';
    restoreSaved(base, old.monthly!.before);
    const r = monthlyReport(base, view, old.monthly!.input, { kind: '入金', amount });
    return { acct: r.acct, notif: r.notif, mergedIntoMonthly: true };
  }
  const acct = clone(acct0);
  // 還沒填快照的清單（已回覆的、還沒回覆的照目前的選項）先當成做完了，才不會把它們要買的再列一次（T38）
  const base = afterOpenLists(acct, view, { pending: true });
  const values = cellValues(base, view);
  const plan = planDay({ cfg: acct.cfg, values, state: base.rule, flow: { kind: '入金', amount } });
  acct.cash += amount;
  recordExternalFlow(acct, view, amount);
  const price = (t: string) => priceOf(view, t);
  // 補「低於目標最多」的格子：照缺口由大到小排，買單合計不超過現金的 98%
  const lines = planToLines(plan, values, { price, shares: shareCells(base) }).sort((a, b) => b.shares * price(b.ticker) - a.shares * price(a.ticker));
  const capped = capBuys(lines, BUY_CASH_FRACTION * Math.max(0, base.cash + amount), price);
  const item = makeItem({ f: 'F11', kind: 'CASHFLOW', title: `入金 ${usd(amount)}：只買不賣`, choices: [{ id: 'DO', label: '照做', lines: capped }], noSkip: true, why: '依序補低於目標最多的格子；缺口小於總資產 0.25% 的不補；剩下的照比例進核心' });
  const notif = newNotif(acct, view, { kind: 'CASHFLOW', title: `入金 ${usd(amount)} 的清單`, items: [item], deposit: amount });
  notif.preview = composeNotif(acct, view, notif);
  return { acct, notif, mergedIntoMonthly: false };
}

/**
 * 出金（allocation_redesign §1.4）：只賣不買，當天給清單。先做單檔上限檢查，再照
 * ① 動能高於目標的部分 → ② 核心（照比例，帳上現金先用）→ ③ 動能按比例 → ④ 自選按比例。
 */
export function withdraw(acct0: Account, view: MarketView, amount: number): { acct: Account; notif: Notif } {
  const acct = clone(acct0);
  const base = afterOpenLists(acct, view, { pending: true }); // 同入金（T38）
  const values = cellValues(base, view);
  const plan = planDay({ cfg: acct.cfg, values, state: base.rule, flow: { kind: '出金', amount } });
  const lines = planToLines(plan, values, { price: (t) => priceOf(view, t), shares: shareCells(base) });
  const item = makeItem({ f: 'F12', kind: 'CASHFLOW', title: `出金 ${usd(amount)}：只賣不買`, choices: [{ id: 'DO', label: '照做', lines }], noSkip: true, why: '先做單檔上限檢查；再照 動能高於目標 → 核心（照比例，帳上現金先用）→ 動能 → 自選' });
  const notif = newNotif(acct, view, { kind: 'CASHFLOW', title: `出金 ${usd(amount)} 的清單`, items: [item], withdraw: amount });
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
  // 之後的入金、出金、改比例是照這一筆做完之後算的（T38）：先取消後面那一份。
  // 例如改了兩次比例（A → B → C），取消第一次會把比例改回 A，第二份清單卻還是照 C 列的
  const later = acct.notifs.find((x) => x.id > id && cashflowKind(x) && (x.status === 'PENDING' || x.status === 'RESPONDED'));
  if (later) return { acct: acct0, ok: false, error: `之後的「${later.title}」（${notifDay(later.date)}）是照這一筆做完之後算的，還沒填快照：先取消那一份，再取消這一筆` };
  const kind = cashflowKind(n)!;
  if (kind === '入金') {
    const amt = n.deposit ?? 0;
    acct.cash -= amt;
    recordExternalFlow(acct, view, -amt);
    const ev = acct.events.at(-1);
    if (ev) ev.reason = `取消 ${notifDay(n.date)} 的入金`;
  } else if (kind === '改比例' && n.ratioBefore) {
    acct.cfg = { ...acct.cfg, ratio: { ...n.ratioBefore.ratio } };
    for (const [t, w] of Object.entries(n.ratioBefore.std)) if (acct.rule.own[t]) acct.rule.own[t].stdWeight = w;
    // 改成 0% 時記下的標準比重（T39b）也回到改之前：取消「改成 0%」→ 拿掉；取消「從 0% 改回」→ 記錄回來。沒有這個欄位的舊清單不動
    if (n.ratioBefore.ownZero !== undefined) {
      if (n.ratioBefore.ownZero) acct.ownZero = clone(n.ratioBefore.ownZero);
      else delete acct.ownZero;
    }
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

/** 改比例的影子紀錄標題（回覆時每一檔一筆，core_ai §3.11）。 */
export const RATIO_SHADOW_TITLE = '改比例（影子組合繼續追蹤「如果沒改」）';

/** 改比例（設計 §2.1 第 7 點）：使用者觸發，當天給清單；影子組合繼續追蹤「如果沒改」。 */
export function changeRatio(acct0: Account, view: MarketView, ratio: { own: number; strat: number; core: number }): { acct: Account; notif: Notif } {
  const acct = clone(acct0);
  const old = acct.cfg.ratio;
  const ratioBefore = { ratio: { ...old }, std: Object.fromEntries(Object.entries(acct.rule.own).map(([t, o]) => [t, o.stdWeight])), ownZero: acct.ownZero ? clone(acct.ownZero) : null };
  // 同入金（T38）：還沒填快照的清單先當成做完了，股數從那之後算
  const base = afterOpenLists(acct, view, { pending: true });
  const total = totalValue(base, view);
  const lines: OrderLine[] = [];
  const zero = (x: number) => x <= 1e-9;
  if (zero(old.own) && !zero(ratio.own)) {
    // 從 0% 改回（T39b，design_v2 §10 第 47 點）：標準比重用改成 0% 時記下的（照新舊比例縮放），沒有記錄的用新增自選時的推薦比重；
    // 0 股的照新的標準比重買回（減半中的買一半，同新增自選）
    const rec = acct.ownZero;
    const recommended = recommendStdWeights(view, Object.keys(acct.rule.own), ratio.own);
    for (const tk of Object.keys(acct.rule.own)) {
      const r = acct.rule.own[tk];
      const kept = rec && rec.from > 0 ? rec.std[tk] : undefined;
      r.stdWeight = kept !== undefined ? (kept * ratio.own) / rec!.from : recommended[tk];
      if (!base.rule.own[tk]) continue; // 還沒填快照的清單要把它移出自選：不買回
      const cur = base.lots.own[tk] ?? 0;
      const want = Math.floor((r.stdWeight * total * pickFrac(r)) / priceOf(view, tk));
      if (want > cur) lines.push({ ticker: tk, bucket: 'own', shares: want - cur, reason: '改比例' });
    }
    delete acct.ownZero;
  } else if (Math.abs(ratio.own - old.own) > 1e-9) {
    // 自選：每檔股數與標準比重都乘上「新比例 ÷ 舊比例」（原型假設 7）；改成 0% 時先把每檔原本的標準比重記下來（T39b）
    if (zero(ratio.own)) acct.ownZero = { from: old.own, std: { ...ratioBefore.std }, date: view.date };
    const f = ratio.own / old.own;
    for (const tk of Object.keys(acct.rule.own)) {
      acct.rule.own[tk].stdWeight *= f;
      const cur = base.lots.own[tk] ?? 0;
      const d = Math.round(cur * f) - cur;
      if (d) lines.push({ ticker: tk, bucket: 'own', shares: d, reason: '改比例' });
    }
  }
  acct.cfg = { ...acct.cfg, ratio: { ...ratio } };
  const slot = momSlotTarget(acct.cfg, total, acct.rule.effPrev ?? 1);
  for (const tk of new Set([...Object.keys(base.lots.mom), ...base.rule.heldMom])) {
    const cur = base.lots.mom[tk] ?? 0;
    let tgt = 0;
    if (base.rule.heldMom.includes(tk)) {
      const ownVal = (base.lots.own[tk] ?? 0) * priceOf(view, tk);
      const room = acct.cfg.crossCapBuy !== null ? Math.max(0, acct.cfg.crossCapBuy * total - ownVal) : Infinity;
      tgt = Math.floor(Math.min(slot, room) / priceOf(view, tk));
    }
    if (tgt !== cur) lines.push({ ticker: tk, bucket: 'mom', shares: tgt - cur, reason: '改比例' });
  }
  const fmt = (r: typeof ratio) => [r.own, r.strat, r.core].map((x) => `${Math.round(x * 100)}%`).join(' / ');
  const item = makeItem({ f: 'F13', kind: 'CASHFLOW', title: `改比例：自選 / Strategy / 核心 ${fmt(old)} → ${fmt(ratio)}`, choices: [{ id: 'DO', label: '照做', lines }], noSkip: true });
  const notif = newNotif(acct, view, { kind: 'CASHFLOW', title: '改比例的清單', items: [item], ratioBefore });
  notif.preview = composeNotif(acct, view, notif);
  // 影子紀錄在回覆時照合成後的清單每一檔寫（core_ai §3.11），這裡不再寫 0 股的那一筆
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
  const meta = newOwnMeta(view, ticker, 'NEW', premises?.length ? premises : clone(SYSTEM_DEFAULT_PREMISES), acct.ownClosed?.[ticker]?.fileId);
  const std = stdWeight ?? recommended[ticker];
  const half = meta.slow.state === 'HALF';
  // 有論點、距高點已跌超過 20%：先買一半，開檔後第一份財報的審查過關再補滿（allocation_redesign §4.1）
  const build = meta.slow.state === 'BUILD';
  acct.own[ticker] = meta;
  acct.rule.own[ticker] = { applied: appliedOf(meta.slow.state, !!meta.build), stdWeight: std };
  const total = totalValue(acct, view);
  const px = priceOf(view, ticker);
  const cur = acct.lots.own[ticker] ?? 0;
  const sh = Math.max(0, Math.floor((std * total * (half || build ? 0.5 : 1)) / px) - cur);
  const crossRoom = (acct.cfg.crossCapBuy ?? Infinity) * total - (acct.lots.mom[ticker] ?? 0) * px;
  const item = makeItem({
    f: 'F14',
    kind: 'CASHFLOW',
    ticker,
    title: half
      ? `新增自選 ${ticker}：距高點已跌超過 20% → 一開始就是減半狀態，只買標準比重的一半`
      : build
        ? `新增自選 ${ticker}：距高點已跌超過 20%、有你的論點 → 先買標準比重的一半，開檔後第一份財報的審查過關再補滿`
        : `新增自選 ${ticker}：買到標準比重 ${(std * 100).toFixed(1)}%`,
    choices: [{ id: 'DO', label: '照做', lines: sh ? [{ ticker, bucket: 'own', shares: sh, reason: '新增自選' }] : [] }],
    why: '錢從核心照比例拿（帳上現金先用）',
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

// ---------------------------------------------------------------- 候補名單（allocation_redesign §4.5，T85）

/** 候補不能加、不能改時（訊息直接給使用者看；網站回 422）。 */
export class WatchError extends Error {}

/** 「為什麼想買」最多幾個字（和買進時的一句話相同）。 */
export const WATCH_NOTE_MAX = 300;

/**
 * 加一檔候補（§4.5「怎麼加」）：開一份論點檔（編號照舊 `<代號>@<訊號日>`，進場後沿用），前提是系統預設的三條（種類「只有預設」）。
 * note：「為什麼想買」→ buyNote（不是前提）；stdWeight：打算放的標準比重，沒填是 null（列進場項目時用推薦值）。
 * 不下單、不發通知、不開任何 AI（自動草擬是 T85 丙段）。最多 MAX_WATCH 檔；已在自選、已在候補、核心的標的不能加。
 */
export function addWatch(acct0: Account, view: MarketView, ticker: string, opt: { note?: string | null; stdWeight?: number | null } = {}): Account {
  const acct = clone(acct0);
  const watch = acct.watch ?? {};
  if (acct.own[ticker]) throw new WatchError(`${ticker} 已經在自選裡了，不用加候補`);
  if (watch[ticker]) throw new WatchError(`${ticker} 已經在候補名單裡了`);
  if (ticker === acct.cfg.coreTicker || ticker === acct.bondTicker) throw new WatchError(`${ticker} 是核心的標的，不能加進候補`);
  if (Object.keys(watch).length >= MAX_WATCH) throw new WatchError(`候補最多 ${MAX_WATCH} 檔：先移除一檔再加`);
  const note = opt.note?.trim() ? { text: opt.note.trim().slice(0, WATCH_NOTE_MAX), at: view.date } : null;
  const premises = clone(SYSTEM_DEFAULT_PREMISES).map((p) => ({ ...p, addedAt: view.date }));
  const meta: WatchMeta = {
    fileId: newFileId(ticker, view.date, acct.ownClosed?.[ticker]?.fileId),
    premises,
    thesis: null,
    premiseSeq: nextPremiseSeq({ premises }),
    ...(note ? { buyNote: note } : {}),
    addedAt: view.date,
    stdWeight: opt.stdWeight ?? null,
    lastListed: null,
  };
  acct.watch = { ...watch, [ticker]: meta };
  return acct;
}

/**
 * 改一檔候補（帳戶頁的候補那一塊）：stdWeight 給了就改（null = 改回留空，用推薦值）；note 給了就改「為什麼想買」（空字串 = 拿掉）。
 */
export function updateWatch(acct0: Account, view: MarketView, ticker: string, opt: { note?: string | null; stdWeight?: number | null }): Account {
  const acct = clone(acct0);
  const meta = acct.watch?.[ticker];
  if (!meta) throw new WatchError(`${ticker} 不在候補名單裡`);
  if (opt.stdWeight !== undefined) meta.stdWeight = opt.stdWeight;
  if (opt.note !== undefined) meta.buyNote = opt.note?.trim() ? { text: opt.note.trim().slice(0, WATCH_NOTE_MAX), at: view.date } : null;
  return acct;
}

/**
 * 移除候補（§4.5「其他」）：論點檔結案（原因 WATCH_REMOVED，存檔時寫 log 的 CLOSE）；條件不用動（跟著論點檔編號，之後不會再讀）。
 * ownClosed 每檔只有一筆，同時是「上一次持有時的論點」的來源：原本那一筆若是持有的結案就搬進 held（候補的論點不能蓋掉上一次持有的），
 * 前提被判不成立的日子（brokenAt）照帶（30 天的防線，§4.5 第 7 點）。
 * 還沒回覆的進場項目（F29）跟著取消；已經決定照做、還沒填快照的不能移除（先改決定）。
 */
export function removeWatch(acct0: Account, view: MarketView, ticker: string): Account {
  const acct = clone(acct0);
  const meta = acct.watch?.[ticker];
  if (!meta) throw new WatchError(`${ticker} 不在候補名單裡`);
  // 進場項目（F29）已經決定照做、還沒填快照：先改決定再移除（不然買進來的股數沒有論點檔接）
  const decided = acct.notifs.find((n) => n.status === 'RESPONDED' && !!n.composed && n.items.some((i) => !i.cancelled && i.kind === 'WATCH_ENTRY' && i.ticker === ticker && i.choice === 'DO'));
  if (decided) throw new WatchError(`${ticker} 的進場項目已經決定照做、還沒填快照（${notifDay(decided.date)} 的「${decided.title}」）：已經買了就先填快照；還沒買就到那則通知改決定，再移除候補`);
  // 還沒回覆的進場項目跟著取消
  for (const n of acct.notifs) {
    if (n.status !== 'PENDING') continue;
    let hit = false;
    for (const it of n.items) {
      if (it.cancelled || it.kind !== 'WATCH_ENTRY' || it.ticker !== ticker) continue;
      it.cancelled = true;
      it.note = `${notifDay(view.date)} ${ticker} 已經移出候補，這一項取消`;
      hit = true;
    }
    if (hit) n.preview = composeNotif(acct, view, n);
  }
  const prev = acct.ownClosed?.[ticker];
  const held = prev ? (prev.reason === 'WATCH_REMOVED' ? (prev.held ?? null) : { fileId: prev.fileId, reason: prev.reason, date: prev.date, ...(prev.last ? { last: prev.last } : {}) }) : null;
  acct.ownClosed = {
    ...(acct.ownClosed ?? {}),
    [ticker]: { fileId: meta.fileId, reason: 'WATCH_REMOVED', date: view.date, last: closedThesisOf(meta), ...(prev?.brokenAt ? { brokenAt: prev.brokenAt } : {}), ...(held ? { held } : {}) },
  };
  delete acct.watch![ticker];
  return acct;
}

// ---------------------------------------------------------------- 月報上的動作：轉入自選、排除、認養

/**
 * 幫一檔自選加前提（持股頁，2026-11-15 起取代新增自選頁的前提欄）。
 * 原本只有系統預設前提時，換成新寫的（三層備案：你寫的 → 採用的 AI 草稿 → 系統預設）；否則接在後面。
 * 新的前提從 premiseSeq 接著編號；既有的編號不變、拿掉的編號不再用（own_thesis §1.2，修 N7）。date：加入的訊號日。
 */
export function addPremises(acct0: Account, ticker: string, premises: Omit<Premise, 'id'>[], date: string): Account {
  const acct = clone(acct0);
  const meta = acct.own[ticker];
  if (!meta || !premises.length) return acct0;
  let seq = nextPremiseSeq(meta);
  const keep = meta.premises.every((p) => p.origin === 'SYSTEM_DEFAULT') ? [] : meta.premises;
  meta.premises = [...keep, ...premises.map((p) => ({ ...p, id: `P${seq++}`, addedAt: p.addedAt ?? date }))];
  meta.premiseSeq = seq;
  return acct;
}

/** 比較前提文字用：去掉空白與標點（own_thesis §1.8「前提的對應」）。 */
export const premiseKey = (t: string): string => t.normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();

export interface PremiseMapping {
  /** 存檔後的前提（沿用的保留原本的 id、來源與加入日；新的發新的 id、來源是 USER）。 */
  premises: Premise[];
  /** 沿用原本編號的。 */
  kept: string[];
  /** 新的（新發的編號）。 */
  added: string[];
  /** 現行有、新的沒有 → 撤下（原本只有系統預設、寫了自己的前提時，系統預設也在這裡）。 */
  retired: Premise[];
  /** 沿用編號、但字改了（去掉空白與標點後不同；T40，own_thesis §1.8）：也算論點變動。 */
  edited: { id: string; before: string; after: string }[];
  /** 下一條前提的編號。 */
  premiseSeq: number;
}

/**
 * 編輯論點時，新的前提怎麼對應現行的（own_thesis §1.8，純函式）：
 *   帶 id、而且是現行的一條 → 沿用（使用者在預覽裡改了字、或貼回的 [P2] 字改了，也算同一條；記在 edited，T40）；
 *   文字和現行的一條相同（去掉空白與標點後比）→ 沿用那條的 id；
 *   其他 → 新的，從 premiseSeq 接著編號（編號不重用、不重排）；
 *   現行有、新的沒對到 → 撤下。
 * 新的一條都沒有：原本只有系統預設 → 預設留著；原本有你的前提 → 丟錯（至少留一條）。
 * 草稿（T56，web_evidence_design §2.3）：新的一條帶 origin（原樣採用的草稿是 AI_DRAFT_ACCEPTED，其他 USER；T70 起是整份採用）與 breaksIf（怎樣算不成立）；
 *   沿用的一條照舊保留原本的來源，帶了 breaksIf 就換成新的（空字串 = 拿掉）。原樣採用的草稿前提之後被你改了字 → 來源改成 USER（字是你的了）。
 * T60（composite_layer_design §2.2、§2.3）：breaksIf 存成子句的陣列（最多 3 句）；confirmsIf、verify 和 breaksIf 同一個規則（送了就換、空的拿掉、沒送照舊）。
 *   只改這三個欄位不算論點變動（edited 只看前提的字）。
 */
export function mapPremises(meta: Pick<OwnMeta, 'premises' | 'premiseSeq'>, next: PremiseInput[], date: string): PremiseMapping {
  const cur = meta.premises;
  const onlyDefault = cur.every((p) => p.origin === 'SYSTEM_DEFAULT');
  // 原樣送回來的系統預設前提（預覽裡沒動的）：全部都是 → 照舊；混了自己的前提 → 預設整組拿掉
  const isDefaultEcho = (r: { text: string }) => cur.some((p) => p.origin === 'SYSTEM_DEFAULT' && premiseKey(p.text) === premiseKey(r.text));
  const all = next.map((p) => ({ id: p.id ?? null, text: p.text.trim(), origin: p.origin, ...premiseFieldsIn(p) })).filter((p) => p.text);
  const rows = all.filter((r) => !isDefaultEcho(r));
  let seq = nextPremiseSeq(meta);
  if (!rows.length) {
    if (onlyDefault) return { premises: clone(cur), kept: cur.map((p) => p.id), added: [], retired: [], edited: [], premiseSeq: seq };
    throw new Error('至少要留一條前提');
  }
  const used = new Set<string>();
  const premises: Premise[] = [];
  const kept: string[] = [];
  const added: string[] = [];
  const edited: PremiseMapping['edited'] = [];
  for (const r of rows) {
    // 系統預設前提不能被「沿用」成你的前提：寫了自己的前提就整組換掉（照舊）
    const pool = cur.filter((p) => p.origin !== 'SYSTEM_DEFAULT' && !used.has(p.id));
    const hit = (r.id ? pool.find((p) => p.id === r.id) : undefined) ?? pool.find((p) => premiseKey(p.text) === premiseKey(r.text));
    if (hit) {
      used.add(hit.id);
      kept.push(hit.id);
      const changed = premiseKey(hit.text) !== premiseKey(r.text);
      if (changed) edited.push({ id: hit.id, before: hit.text, after: r.text });
      const p: Premise = { ...hit, text: r.text, ...(changed && hit.origin === 'AI_DRAFT_ACCEPTED' ? { origin: 'USER' as const } : {}) };
      // 新欄位（T56 的 breaksIf；T60 的 confirmsIf、verify）：送了就換（空的 = 拿掉），沒送照舊
      if (r.breaksIf !== undefined) {
        if (r.breaksIf.length) p.breaksIf = r.breaksIf;
        else delete p.breaksIf;
      }
      if (r.confirmsIf !== undefined) {
        if (r.confirmsIf) p.confirmsIf = r.confirmsIf;
        else delete p.confirmsIf;
      }
      if (r.verify !== undefined) {
        if (r.verify) p.verify = r.verify;
        else delete p.verify;
      }
      premises.push(p);
    } else {
      const id = `P${seq++}`;
      added.push(id);
      premises.push({
        id,
        text: r.text,
        origin: r.origin === 'AI_DRAFT_ACCEPTED' ? 'AI_DRAFT_ACCEPTED' : 'USER',
        ...(r.breaksIf?.length ? { breaksIf: r.breaksIf } : {}),
        ...(r.confirmsIf ? { confirmsIf: r.confirmsIf } : {}),
        ...(r.verify ? { verify: r.verify } : {}),
        addedAt: date,
      });
    }
  }
  return { premises, kept, added, retired: cur.filter((p) => !used.has(p.id)), edited, premiseSeq: seq };
}

/**
 * 送來的一條前提的新欄位整理成存檔的形狀（undefined = 沒送、照舊；空陣列、空字串、null = 拿掉）：
 * breaksIf 一段字當成一句、陣列去空白去空的、最多取前 3 句（多的由呼叫的地方先擋）；confirmsIf 去頭尾空白；verify 經過 normVerify。
 */
function premiseFieldsIn(p: PremiseInput): { breaksIf?: string[]; confirmsIf?: string; verify?: PremiseVerify | null } {
  const out: { breaksIf?: string[]; confirmsIf?: string; verify?: PremiseVerify | null } = {};
  if (p.breaksIf !== undefined) out.breaksIf = p.breaksIf === null ? [] : breaksOf({ breaksIf: p.breaksIf }).slice(0, PREMISE_FIELD_LIMITS.breaksClauses);
  if (p.confirmsIf !== undefined) out.confirmsIf = (p.confirmsIf ?? '').trim();
  if (p.verify !== undefined) out.verify = p.verify === null ? null : normVerify(p.verify);
  return out;
}

/** 編輯論點時送來的一條前提（T56 起可以帶草稿的來源與「怎樣算不成立」；T60 起帶「怎樣算證實」與怎麼驗證）。 */
export interface PremiseInput {
  id?: string | null;
  text: string;
  /** 新的一條的來源：原樣採用的草稿是 AI_DRAFT_ACCEPTED；沒給是 USER。沿用的一條不看這個。 */
  origin?: 'USER' | 'AI_DRAFT_ACCEPTED';
  /** 怎樣算不成立（進審查的證據包；最多 3 句）。undefined = 不改（沿用的照舊）；空陣列、空字串或 null = 拿掉。一段字當成一句。 */
  breaksIf?: string[] | string | null;
  /** 怎樣算證實（T60）。undefined = 不改；空字串或 null = 拿掉。 */
  confirmsIf?: string | null;
  /** 怎麼驗證（T60；by = NONE 是信念）。undefined = 不改；null（或不認得的 by）= 拿掉。 */
  verify?: PremiseVerify | null;
}

export interface ThesisInput {
  text: string;
  source: Thesis['source'];
  premises: PremiseInput[];
  /** 訊號日。 */
  date: string;
  /** 這是對乙類通知的回應（修正論點，own_thesis §1.10）：「失效後修改」的次數加 1、記日期。 */
  afterBreak?: boolean;
}

/**
 * 存論點與前提（持股頁的「編輯論點」，own_thesis §1.8 確認的第 1 點；§3.6.5）：論點本文與前提立刻存進帳戶狀態，version 加 1。
 * 前提有新增或撤下、或沿用編號但字改了（T40）→ thesisReviewDue 記今天（下一次每日第一次流程開論點變動後的審查）；
 * 只改論點本文、只改前提的標點或空白不算。
 * inp.afterBreak（對乙類通知的回應）→ thesis.afterBreak 加 1、lastAfterBreakAt 記今天（§1.10 的 REVISE）。
 * 沿用編號、但字改了的前提（T42，§1.10）：這條前提還在期間內的靜默期結束（記結束日與原因「前提的字改了」）；silenceEnded 列出是哪幾條。
 */
export function setThesis(acct0: Account, ticker: string, inp: ThesisInput): { acct: Account; mapping: PremiseMapping; before: { text: string; premises: Premise[] }; changed: boolean; silenceEnded: string[] } {
  const acct = clone(acct0);
  // 候補也有論點檔（allocation_redesign §4.5 第 3 點）：論點與前提一樣存；候補沒有審查與靜默期，不排論點變動後的審查
  const fm = fileMeta(acct, ticker);
  if (!fm) throw new Error(`${ticker} 不在自選裡，也不在候補名單裡`);
  const meta = fm.meta;
  const mapping = mapPremises(meta, inp.premises, inp.date);
  const before = { text: meta.thesis?.text ?? '', premises: clone(meta.premises) };
  const prev = meta.thesis ?? null;
  const afterBreak = (prev?.afterBreak ?? 0) + (inp.afterBreak ? 1 : 0);
  const lastAfterBreakAt = inp.afterBreak ? inp.date : (prev?.lastAfterBreakAt ?? null);
  meta.thesis = { text: inp.text.trim(), setAt: inp.date, source: inp.source, version: (prev?.version ?? 0) + 1, afterBreak, lastAfterBreakAt };
  meta.premises = mapping.premises;
  meta.premiseSeq = mapping.premiseSeq;
  const changed = mapping.added.length > 0 || mapping.retired.length > 0 || mapping.edited.length > 0;
  if (changed && fm.held) fm.meta.thesisReviewDue = inp.date;
  const silenceEnded = fm.held ? endDisputesFor(fm.meta, mapping.edited.map((e) => e.id), inp.date, EDITED_REASON) : [];
  return { acct, mapping, before, changed, silenceEnded };
}

/** 可以用「修正論點」結案的乙類項目：還沒回覆的通知裡、這檔還沒取消的乙類（own_thesis §1.10）。 */
export function revisableBreak(acct: Pick<Account, 'notifs'>, id: number, ticker: string): { n: Notif; it: Item } | null {
  const n = acct.notifs.find((x) => x.id === id);
  if (!n || n.status !== 'PENDING') return null;
  // 慢規則減半項目上的「AI 建議出清」不能用修正論點結案（§3.4：改完論點仍要回通知選一項）
  const it = n.items.find((i) => i.ticker === ticker && !i.cancelled && i.brk?.type === 'B' && !i.brk.withRule);
  return it ? { n, it } : null;
}

/**
 * 乙類的「修正論點」（own_thesis §1.10 的 REVISE）：論點已經用 setThesis 存好（afterBreak 加過 1），這裡讓通知結案。
 *   那一項取消（部位不動、不用下單），記下修正的日子；沒照 AI 的那筆照樣進「沒照規則做的」紀錄。
 *   通知只剩取消的項目 → 結案（DONE）；月報裡還有別的項目 → 通知留著等你回覆其他項。
 *   新的前提原封不動留著被判不成立的那一條（同一個 id、字沒改）→ 當成不同意：那條前提進靜默期（理由「修正論點但保留這條前提」）。
 *   同一個 id 但字改了（edited：這次存檔 mapPremises 判定「沿用編號、但字改了」的編號）→ 照修正論點，不進靜默期（T46）：
 *   不同意針對的是原本的字，新的字還沒被檢查過，不能先靜默。
 * 找不到可以結案的項目（已經回覆過、不是這檔的乙類）→ ok = false，帳戶不變。
 */
export function reviseBreak(acct0: Account, view: MarketView, id: number, ticker: string, edited: string[] = []): { acct: Account; ok: boolean; premiseId: string | null; kept: boolean } {
  const acct = clone(acct0);
  const hit = revisableBreak(acct, id, ticker);
  const meta = acct.own[ticker];
  if (!hit || !meta || hit.it.brk?.type !== 'B') return { acct: acct0, ok: false, premiseId: null, kept: false };
  const { n, it } = hit;
  const pid = hit.it.brk.premiseId;
  const reworded = edited.includes(pid);
  const kept = !reworded && meta.premises.some((p) => p.id === pid);
  const md = `${Number(view.date.slice(5, 7))}/${Number(view.date.slice(8, 10))}`;
  it.cancelled = true;
  it.revised = view.date;
  it.note = `你在 ${md} 修正了論點（失效後修改第 ${meta.thesis?.afterBreak ?? 1} 次），部位不動${kept ? `。新的論點還留著前提 ${pid}，當成不同意：這條前提進靜默期` : reworded ? `。前提 ${pid} 的字改了：不進靜默期，之後的審查看新的字` : ''}`;
  const ai = it.choices.find((c) => c.id === 'AI');
  acct.shadow.push({
    date: view.date,
    f: it.f,
    ticker,
    title: it.title,
    rule: 0,
    ai: ai ? sumFor(ai.lines, ticker) : null,
    actual: 0,
    price: view.close[ticker] ? priceOf(view, ticker) : 0,
    choice: 'SKIP',
    notif: n.id,
    ...(it.runIds?.length ? { runIds: [...it.runIds] } : {}),
    note: kept ? KEPT_REASON : '修正論點',
  });
  if (kept) addDispute(meta, pid, view.date, KEPT_REASON, n.id);
  if (n.items.every((i) => i.cancelled)) {
    // 結案：沒有要下的單，核心也不另外吸收現金（不然通知頁會列出「買 VOO」）
    n.coreAbsorb = false;
    n.status = 'DONE';
    n.respondedAt = view.date;
    n.respondedSeq = view.i;
  }
  n.preview = composeNotif(acct, view, n);
  return { acct, ok: true, premiseId: pid, kept };
}

/**
 * 改一檔自選的標準比重（持股頁；設計 §2.2「系統推薦，使用者可改」）。只改之後加回、入金用的目標，不下單。
 * opt.build（allocation_redesign §4.1，T83）：開檔後第一次設定標準比重時（OwnMeta.buildAsk）的選擇——true「先買一半，確認後再補滿」→ 先買一半（BUILD），
 * false 或沒給「已經買到這個比例」→ 照舊（標準）。不論選哪個，存了之後就不再問。只有標準狀態的股票能選先買一半（減半中、審查後持有的不問）。
 */
export function setStdWeight(acct0: Account, ticker: string, stdWeight: number, opt: { build?: boolean; date?: string } = {}): Account {
  const acct = clone(acct0);
  const meta = acct.own[ticker];
  if (!acct.rule.own[ticker] || !(stdWeight > 0)) return acct0;
  acct.rule.own[ticker].stdWeight = stdWeight;
  if (meta?.buildAsk) {
    delete meta.buildAsk;
    if (opt.build && meta.slow.state === 'STD' && acct.rule.own[ticker].applied === 'STD') {
      meta.slow = { ...meta.slow, state: 'BUILD' };
      meta.build = { since: openedOn(meta, ticker, opt.date), confirmBy: 'EARNINGS', misses: 0 };
      acct.rule.own[ticker].applied = 'BUILD';
    }
  }
  return acct;
}

/**
 * 開始持有的訊號日：heldSince（從候補進場的，allocation_redesign §4.5 第 4 點）；沒有就用論點檔開檔的訊號日（fileId 是 `<代號>@<訊號日>`）；
 * 舊資料沒有編號時用 fallback。
 */
function openedOn(meta: Pick<OwnMeta, 'fileId' | 'heldSince'>, ticker: string, fallback?: string): string {
  if (meta.heldSince) return meta.heldSince;
  const d = meta.fileId?.slice(ticker.length + 1, ticker.length + 11);
  return d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : (fallback ?? '');
}

/**
 * 離開先買一半（allocation_redesign §4.1；直接改傳進來的帳戶；本體是 report.ts 的 clearBuild）：
 *   keep = false：補滿照做、或「選了先買一半但其實買足了」改成已經買到這個比例 → 目標回到標準比重（標準比重不變）
 *   keep = true：補滿不做、或兩份財報（200 天）沒過關後選「維持現在的大小」→ 標準比重改成現在的實際比重（之後不再提）
 */
const endBuildIn = clearBuild;

/** 持股頁的按鈕（allocation_redesign §4.1、§4.6）：「維持現在的大小」（keep）、「改成已經買到這個比例」（不 keep）。不是先買一半就原樣回傳。 */
export function endBuild(acct0: Account, view: MarketView, ticker: string, keep: boolean): Account {
  if (!acct0.own[ticker]?.build) return acct0;
  const acct = clone(acct0);
  endBuildIn(acct, view, ticker, keep);
  // 還沒回覆的補滿（F27）跟著取消：已經離開先買一半
  for (const n of acct.notifs) {
    if (n.status !== 'PENDING') continue;
    for (const it of n.items) {
      if (it.cancelled || it.f !== 'F27' || it.ticker !== ticker) continue;
      it.cancelled = true;
      it.note = keep ? '你選了維持現在的大小，這一項取消' : '你改成已經買到這個比例，這一項取消';
    }
  }
  return acct;
}

/**
 * 候補 → 持股（allocation_redesign §4.5 第 17 點）。直接改傳進來的帳戶；不是候補（或已經在自選）回傳 false。
 *   論點檔沿用（fileId、論點、前提、編號、網頁來源、那一句話、要看的事的紀錄），origin = WATCH，heldSince = 進場那份快照的訊號日
 *   （「開檔滿幾天」「先買一半的 200 天」從進場算，不從加入候補算）。
 *   via F29（照月報的進場項目買的）：先買一半（BUILD），不問；只有預設前提、進場時已經比高點低 20% 以上的照 §4.1 既有規則從減半開始。
 *   via SELF（你自己先買的）：標準（STD）＋ buildAsk（持股頁問一次，預選「先買一半」）；跌深的同上（有論點 → 先買一半；只有預設 → 減半）。
 *   有論點、已經比高點低 20% 以上的開在先買一半：之後的每日流程照常觸發跌幅審查（§3，不因為剛買而例外）。
 *   標準比重：opt.std（項目上用的、或快照表單填的）→ 候補那一欄 → 推薦值。還沒回覆的進場項目取消（自己先買時）。
 *   進場條件在資料庫、不跟帳戶版本走：這裡不改，下一次每日流程（syncWatchConds）照 entered 補寫。
 */
export function promoteWatch(acct: Account, view: MarketView, ticker: string, via: 'F29' | 'SELF', opt: { std?: number; shares?: number; conds?: number[] } = {}): boolean {
  const w = acct.watch?.[ticker];
  if (!w || acct.own[ticker]) return false;
  const meta = newOwnMeta(view, ticker, 'WATCH', clone(w.premises));
  meta.fileId = w.fileId;
  meta.thesis = w.thesis ?? null;
  meta.premiseSeq = Math.max(w.premiseSeq ?? 0, nextPremiseSeq(w));
  if (w.webSources) meta.webSources = w.webSources;
  if (w.buyNote) meta.buyNote = w.buyNote;
  if (w.attnShown) meta.attnShown = w.attnShown;
  meta.heldSince = view.date;
  if (via === 'F29' && meta.slow.state === 'STD') {
    meta.slow = { ...meta.slow, state: 'BUILD' };
    meta.build = { since: view.date, confirmBy: 'EARNINGS', misses: 0 };
    delete meta.buildAsk;
    meta.opened = { startState: 'BUILD', drawdownAtOpen: meta.opened?.drawdownAtOpen ?? null };
  }
  const std = opt.std ?? w.stdWeight ?? watchRecWeight(acct, view, ticker) ?? defaultStdFor(acct, view, ticker, opt.shares ?? acct.lots.own[ticker] ?? 0);
  meta.entered = { via, date: view.date, shares: opt.shares ?? acct.lots.own[ticker] ?? 0, state: meta.slow.state, addedAt: w.addedAt, ...(opt.conds?.length ? { conds: [...opt.conds] } : {}) };
  acct.own[ticker] = meta;
  acct.rule.own[ticker] = { applied: appliedOf(meta.slow.state, !!meta.build), stdWeight: std };
  delete acct.watch![ticker];
  if (via === 'SELF') {
    for (const n of acct.notifs) {
      if (n.status !== 'PENDING') continue;
      let hit = false;
      for (const it of n.items) {
        if (it.cancelled || it.kind !== 'WATCH_ENTRY' || it.ticker !== ticker) continue;
        it.cancelled = true;
        it.note = `${notifDay(view.date)} 你自己先買了，${ticker} 已經從候補轉成持股，這一項取消`;
        hit = true;
      }
      if (hit) n.preview = composeNotif(acct, view, n);
    }
  }
  return true;
}

/**
 * 清單外買進、轉入、認養時建立這檔自選（已經在自選就不重建；回傳有沒有新建）。
 * 標準比重：opt.std（使用者填的）→ opt.shares 股占現在總資產的比重（T43，不超過單檔上限）→ 0 股用推薦值。
 * reason：使用者寫的那一句 → 買進時的一句話（T40，own_thesis §1.8）：不是前提，這檔維持「只有預設」直到第一次存論點；
 * 已經有這句話的不覆蓋。
 */
function ensureOwnMeta(acct: Account, view: MarketView, ticker: string, origin: 'TRANSFER' | 'ADOPT' | 'MANUAL', reason?: string, opt: { shares?: number; std?: number } = {}): boolean {
  const note = reason?.trim() ? { text: reason.trim().slice(0, 300), at: view.date } : null;
  // 候補中的代號（allocation_redesign §4.5 第 17 點）：你沒等條件、自己先買了（清單外買進、轉入自選、認養、舊式分類都算）→ 候補直接轉成持股，
  // 論點檔沿用、不重複開檔。回傳 false（不是新建：標準比重用候補那一欄，不改成現在的比重）
  if (!acct.own[ticker] && acct.watch?.[ticker]) {
    promoteWatch(acct, view, ticker, 'SELF', { ...(opt.std ? { std: opt.std } : {}), ...(opt.shares !== undefined ? { shares: opt.shares } : {}) });
    const m: OwnMeta | undefined = Object.entries(acct.own).find(([t]) => t === ticker)?.[1];
    if (m && note && !m.buyNote) m.buyNote = note;
    return false;
  }
  if (acct.own[ticker]) {
    if (note && !acct.own[ticker].buyNote) acct.own[ticker].buyNote = note;
    return false;
  }
  const meta = newOwnMeta(view, ticker, origin, clone(SYSTEM_DEFAULT_PREMISES), acct.ownClosed?.[ticker]?.fileId);
  if (note) meta.buyNote = note;
  acct.own[ticker] = meta;
  acct.rule.own[ticker] = { applied: appliedOf(meta.slow.state, !!meta.build), stdWeight: opt.std ?? defaultStdFor(acct, view, ticker, opt.shares ?? 0) };
  return true;
}

/**
 * 標準比重沒填時的預設（T43，design_v2 §10 第 50 點）：shares 股（這檔之後在自選桶的股數）占現在總資產的比重，不超過單檔上限；
 * 0 股時用推薦值（波動度反比，加入後的自選一起算）。
 */
function defaultStdFor(acct: Account, view: MarketView, ticker: string, shares: number): number {
  const rec = recommendStdWeights(view, [...new Set([...Object.keys(acct.rule.own), ticker])], acct.cfg.ratio.own)[ticker];
  return defaultStdWeight(shares * priceOf(view, ticker), totalValue(acct, view), acct.cfg.ownCapHi, rec);
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
  /** 要寫一句理由（轉入自選、認養時存成這檔買進時的一句話，T40；不是前提）。 */
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
    // 標準比重預設 = 轉進來之後占總資產的比重（T43；搬桶不改總資產）
    ensureOwnMeta(acct, view, tk, 'TRANSFER', input.reason, { shares: (acct.lots.own[tk] ?? 0) + sh });
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
    // 標準比重預設 = 照清單買進之後占總資產的比重（T43；買進是現金換股票，總資產不變）
    ensureOwnMeta(acct, view, tk, 'ADOPT', input.reason, { shares: (acct.lots.own[tk] ?? 0) + Math.max(0, listed) });
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
  restoreSaved(acct, n.monthly.before);
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
  /** 買進歸自選時的一句理由（存成買進時的一句話，T40；前提照樣是系統預設）；賣出時是為什麼賣（記在事件與影子上）。 */
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
  // 標準比重預設 = 歸進自選之後占總資產的比重（T43；未分類的股數本來就算在總資產裡，所以在拿出未分類之前算）
  if (input.bucket === 'own' && q > 0) ensureOwnMeta(acct, view, tk, 'MANUAL', input.reason, { shares: (acct.lots.own[tk] ?? 0) + q });
  delete acct.lots.unc[tk];
  addLot(acct, input.bucket, tk, q);
  acct.units[input.bucket] = flowUnits(acct.units[input.bucket], vBefore, q * px);
  acct.units.core = flowUnits(acct.units.core, coreBefore + q * px, -q * px);
  if (input.bucket === 'mom') delete acct.mom.owe[tk];
  if (removing) removeOwnPick(acct, tk, 'SOLD_OUT', view.date);
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
