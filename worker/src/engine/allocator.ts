// 分桶配置：把「今天有哪些觸發」變成每一格的目標金額。
// 這是 backtest/account_backtest.py 的 simulate_account 每日主體的 TypeScript 版（純函式）。
// 設計：§2.1（分桶、核心當清算中心、搭便車）、§2.1.1（入金出金）、§2.2（自選、上限）、§3、§4。
//
// 以金額為單位：呼叫端給每一格目前的市值，引擎回傳每一格的目標市值與原因。
// 換成股數（上線）或比重（重放）是呼叫端的事，見 orders.ts 與 replay.ts。
import { selectMomentum, type Selection } from './momentum';
import { coreBandCheck, type CoreBand } from './orders';
import { volScale, type VolScaleResult } from './risk';
import {
  CASH,
  RATIO_REASONS,
  cellKey,
  coreCfg,
  parseCell,
  pickFrac,
  setApplied,
  type CellKey,
  type CellMap,
  type EngineConfig,
  type OwnAction,
  type Reason,
  type RuleState,
} from './types';

export interface MonthlyInput {
  /** 股票池照動能排名由高到低的代號。 */
  order: string[];
  /** 給一份名單，回傳它相對 SPY 的年化超額波動（由呼叫端用歷史價格算好的純函式）。 */
  excessVol: (names: string[]) => number;
  /** 核心 ETF 前一日收盤是否低於 200 日均線。只有重放的舊路徑（PlanInput.legacyCrash）看它；正式流程不用給。 */
  coreBelow200?: boolean;
  /** 不能新進場的代號（否決、排除、認養）。 */
  blocked?: string[];
  companyOf?: (ticker: string) => string;
  /** 上次的策略單沒照做、這個月要把差額再列一次的動能代號（設計 §2.3.1）。 */
  owed?: string[];
  /** 遞補者也被否決、這個月留在核心的格數（設計 §2.4）。 */
  emptySlots?: number;
}

export interface FlowInput {
  kind: '入金' | '出金';
  amount: number;
  /** 入金全進核心、不照目標分配（B-6 的對照組）。 */
  naive?: boolean;
}

export interface PlanInput {
  cfg: EngineConfig;
  /** 每一格目前的市值。 */
  values: CellMap;
  state: RuleState;
  /** 起步日：自選買到標準比重、核心照固定比例分配（舊路徑：照崩盤規則）。 */
  first?: boolean;
  /**
   * 重放 B-8 基準用的舊路徑（allocation_redesign §1.6）：崩盤規則（monthly.coreBelow200 → 核心一半現金、動能減半）、
   * 錢平時進出核心 ETF、崩盤中進出現金、出金的舊順序。正式流程不給：核心固定比例（§1.1～§1.4）、動能只依波動度減碼（§2.1）。
   */
  legacyCrash?: boolean;
  /** 今天要執行的自選訊號。 */
  ownActions?: Record<string, OwnAction>;
  /** 月報日的輸入；不是月報日就不給。 */
  monthly?: MonthlyInput;
  flow?: FlowInput;
}

export type PlanEventKind =
  | 'REDUCE'
  | 'READD'
  | 'TRIM'
  | 'CROSS_LIMIT_BUY'
  | 'CROSS_TRIM'
  | 'MOM_ENTRY'
  | 'MOM_EXIT'
  | 'VOL_SCALE'
  | 'CRASH_ON'
  | 'CRASH_OFF'
  | 'CORE_BAND'
  | 'LAZY_REBALANCE'
  | 'LAZY_SKIPPED';

export interface PlanEvent {
  kind: PlanEventKind;
  ticker?: string;
  detail?: string;
}

export interface PlanResult {
  /** 入金出金之前的總資產。 */
  totalBefore: number;
  /** 入金出金之後的總資產（之後的規則以這個為準）。 */
  total: number;
  targets: CellMap;
  /** 這一格為什麼被改。沒有被規則改到的格子不在裡面（核心被動吸收的差額也不在）。 */
  why: Record<CellKey, Reason>;
  state: RuleState;
  events: PlanEvent[];
  crashChanged: boolean;
  /**
   * 核心比例的界線檢查（月報日、不是舊路徑才有；金額模式，重放用）：合成其他格子的變動之後、調回之前的比例。
   * 正式流程的清單用整股另外算（report.ts 的 coreBandItem），不看這裡。
   */
  coreBand: CoreBand | null;
  /** 這一天因為超出界線把核心調回目標比例（金額模式）。 */
  coreRebal: boolean;
  selection: Selection | null;
  vol: VolScaleResult | null;
  /** 動能每檔目標金額（月報日才有）。 */
  slotTarget: number | null;
}

const get = (m: CellMap, k: CellKey) => m[k] ?? 0;

function sumBucket(m: CellMap, bucket: string): number {
  let s = 0;
  for (const [k, v] of Object.entries(m)) if (k.startsWith(bucket + ':')) s += v;
  return s;
}

/** 自選這一檔在目前狀態下的目標金額：標準比重（減半狀態是一半）。 */
export function ownStateTarget(state: RuleState, ticker: string, total: number): number {
  const o = state.own[ticker];
  if (!o) return 0;
  return o.stdWeight * total * pickFrac(o);
}

/**
 * 入金時自選格子目標的縮放（T43，design_v2 §10 第 50 點）：自選各檔目標的合計（標準比重，減半的算一半）超過自選比例時
 * = 自選比例 ÷ 合計，否則 1。只用在入金的分配，讓自選桶照 §2.2「自選桶合計」靠入金慢慢回到預算；
 * 加回、月報、單檔上限、AI 檔位、改比例、部位大小都照舊用沒縮的標準比重。
 */
export function ownDepositScale(state: Pick<RuleState, 'own'>, ratioOwn: number): number {
  let s = 0;
  for (const o of Object.values(state.own)) s += o.stdWeight * pickFrac(o);
  return s > ratioOwn + 1e-9 ? ratioOwn / s : 1;
}

/** 入金會把這檔自選補到占總資產多少（縮放過、不超過 ownCapTo；不是自選回傳 null）。 */
export function ownDepositFill(state: Pick<RuleState, 'own'>, cfg: Pick<EngineConfig, 'ratio' | 'ownCapTo'>, ticker: string): number | null {
  const o = state.own[ticker];
  if (!o) return null;
  return Math.min(o.stdWeight * pickFrac(o) * ownDepositScale(state, cfg.ratio.own), cfg.ownCapTo);
}

/** 動能每檔目標（設計 §2.1.1）：總資產 × Strategy 比例 × 有效比例 ÷ 檔數。 */
export function momSlotTarget(cfg: EngineConfig, total: number, eff: number, ownValue?: number): number {
  if (cfg.momBase === 'system' && ownValue !== undefined) {
    const frac = cfg.ratio.strat / (1 - cfg.ratio.own);
    return ((total - ownValue) * frac * eff) / cfg.momSlots;
  }
  return (total * cfg.ratio.strat * eff) / cfg.momSlots;
}

export function planDay(inp: PlanInput): PlanResult {
  const { cfg } = inp;
  const val = inp.values;
  const legacy = !!inp.legacyCrash;
  const st: RuleState = {
    own: Object.fromEntries(Object.entries(inp.state.own).map(([k, v]) => [k, { ...v }])),
    heldMom: [...inp.state.heldMom],
    effPrev: inp.state.effPrev,
    // 崩盤規則的狀態只有舊路徑讀寫；正式流程不帶（allocation_redesign §1.5）
    ...(legacy ? { crash: !!inp.state.crash } : {}),
    volHist: [...inp.state.volHist],
    volW: inp.state.volW,
  };
  const ownTickers = Object.keys(st.own);
  const CORE = cellKey('core', cfg.coreTicker);
  const CORE_CASH = cellKey('core', CASH);
  const first = !!inp.first;
  const events: PlanEvent[] = [];

  const totalBefore = Object.values(val).reduce((a, b) => a + b, 0);
  let total = totalBefore;
  const tgt: CellMap = { ...val };
  const why: Record<CellKey, Reason> = {};

  // ---- 入金／出金（§2.1.1）：先處理，之後的規則以入金出金後的帳為準
  if (inp.flow) {
    const kind = inp.flow.kind;
    const amt = kind === '入金' ? inp.flow.amount : -inp.flow.amount;
    const newTotal = total + amt;
    // 非核心格子的當下目標
    const cells: CellMap = {};
    for (const tk of ownTickers) {
      cells[cellKey('own', tk)] = Math.min(ownStateTarget(st, tk, newTotal), cfg.ownCapTo * newTotal);
    }
    if (st.heldMom.length && st.effPrev !== null) {
      const nt = momSlotTarget({ ...cfg, momBase: 'total' }, newTotal, st.effPrev);
      for (const t of st.heldMom) {
        const ok = cellKey('own', t);
        const o = ok in cells ? cells[ok] : get(tgt, ok);
        cells[cellKey('mom', t)] = cfg.crossCapBuy !== null ? Math.min(nt, Math.max(0, cfg.crossCapBuy * newTotal - o)) : nt;
      }
    }
    const cashFrac = legacy && st.crash ? 1 - cfg.crashCut : 0;
    if (kind === '入金') {
      // 自選各檔目標合計超過自選比例 → 自選格子的入金目標照比例縮小（T43；沒超過時 scale = 1，完全不變）。
      // 動能的跨桶上限照舊用沒縮的自選目標算（上面已經算好）
      const scale = ownDepositScale(st, cfg.ratio.own);
      if (scale < 1) for (const tk of ownTickers) cells[cellKey('own', tk)] = Math.min(ownStateTarget(st, tk, newTotal) * scale, cfg.ownCapTo * newTotal);
      // 只買不賣：依序補給低於目標最多的格子；缺口太小不補；剩下的進核心
      let left = amt;
      if (!inp.flow.naive) {
        const gaps = Object.entries(cells)
          .map(([k, c]) => ({ k, g: c - get(tgt, k) }))
          .sort((a, b) => b.g - a.g || (a.k < b.k ? 1 : -1));
        for (const { k, g } of gaps) {
          if (left <= 0) break;
          if (g <= cfg.orderMin * newTotal) continue;
          const b = Math.min(g, left);
          tgt[k] = get(tgt, k) + b;
          why[k] = '入金';
          left -= b;
        }
      }
      // 剩下的進核心。舊路徑：平時進核心 ETF、崩盤中一半放現金；正式流程：不先放，最後由核心照比例吸收（§1.4）
      if (legacy) {
        tgt[CORE_CASH] = get(tgt, CORE_CASH) + left * cashFrac;
        tgt[CORE] = get(tgt, CORE) + left * (1 - cashFrac);
      }
    } else {
      // 只賣不買
      let need = -amt;
      // 出金後會超過單檔上限的自選股，同一份清單先減回（減下來的錢抵出金）
      for (const tk of ownTickers) {
        const k = cellKey('own', tk);
        if (get(tgt, k) > cfg.ownCapHi * newTotal) {
          const b = Math.min(tgt[k] - cfg.ownCapTo * newTotal, need);
          tgt[k] -= b;
          why[k] = '單檔上限';
          need -= b;
        }
      }
      // 順序（allocation_redesign §1.4）：① 動能高於目標的部分 → ② 核心（照比例，帳上現金先用）→ ③ 動能按比例 → ④ 自選按比例。
      // 舊路徑（設計 §2.1.1）：① 核心的現金 → ② 動能高於目標 → ③ 核心 ETF → ④ 動能 → ⑤ 自選
      let c: number;
      if (legacy) {
        c = Math.min(need, get(tgt, CORE_CASH));
        tgt[CORE_CASH] = get(tgt, CORE_CASH) - c;
        need -= c;
      }
      // 動能高於目標的部分
      const over = Object.entries(cells)
        .filter(([k]) => k.startsWith('mom:'))
        .map(([k, c_]) => ({ k, e: get(tgt, k) - c_ }))
        .sort((a, b) => b.e - a.e || (a.k < b.k ? 1 : -1));
      for (const { k, e } of over) {
        if (e <= 0 || need <= 0) break;
        const b = Math.min(e, need);
        tgt[k] -= b;
        why[k] = '出金';
        need -= b;
      }
      if (legacy) {
        c = Math.min(need, get(tgt, CORE));
        tgt[CORE] = get(tgt, CORE) - c;
        need -= c;
      } else {
        // 核心：這裡只算拿多少；兩個格子怎麼分在最後「核心照比例吸收」那一段
        need -= Math.min(need, Math.max(0, get(tgt, CORE) + get(tgt, CORE_CASH)));
      }
      // 動能按比例 → 最後才是自選按比例
      for (const bucket of ['mom', 'own'] as const) {
        if (need <= 1e-12) break;
        const rest = Object.entries(tgt).filter(([k, v]) => k.startsWith(bucket + ':') && v > 0);
        const rs = rest.reduce((a, [, v]) => a + v, 0);
        if (rs <= 0) continue;
        c = Math.min(need, rs);
        for (const [k, v] of rest) {
          tgt[k] = v - (c * v) / rs;
          why[k] = '出金';
        }
        need -= c;
      }
    }
    total = newTotal;
  }

  // ---- 自選桶
  if (first) {
    for (const tk of ownTickers) {
      tgt[cellKey('own', tk)] = st.own[tk].stdWeight * total;
      why[cellKey('own', tk)] = '起步';
    }
  }
  for (const [tk, act] of Object.entries(inp.ownActions ?? {})) {
    const o = st.own[tk];
    if (!o) continue;
    const k = cellKey('own', tk);
    const cur = get(tgt, k);
    // 先買一半（BUILD，allocation_redesign §4.1）和標準一樣可以被減半：賣掉當時持有的一半，之後是減半（重放走不到 BUILD）
    if (act === 'REDUCE' && o.applied !== 'HALF') {
      tgt[k] = cur * 0.5;
      why[k] = '自選訊號';
      setApplied(o, 'HALF');
      events.push({ kind: 'REDUCE', ticker: tk });
    } else if (act === 'READD' && o.applied === 'HALF') {
      tgt[k] = Math.max(cur, o.stdWeight * total);
      why[k] = '自選訊號';
      setApplied(o, 'STD');
      events.push({ kind: 'READD', ticker: tk });
    }
  }
  if (inp.monthly) {
    // 單檔上限：超過 15% → 減回 10%（不需要搭便車）
    for (const tk of ownTickers) {
      const k = cellKey('own', tk);
      if (get(tgt, k) > cfg.ownCapHi * total) {
        tgt[k] = cfg.ownCapTo * total;
        why[k] = '單檔上限';
        events.push({ kind: 'TRIM', ticker: tk });
      }
    }
  }
  const ownValForMom = sumBucket(tgt, 'own');

  // ---- 動能桶（只在月報日決定）
  const lazyPrev: CellMap = {};
  let crashChanged = false;
  let selection: Selection | null = null;
  let vol: VolScaleResult | null = null;
  let slotTarget: number | null = null;
  if (inp.monthly) {
    const m = inp.monthly;
    selection = selectMomentum(m.order, st.heldMom, {
      slots: Math.max(0, cfg.momSlots - (m.emptySlots ?? 0)),
      exitRank: cfg.exitRank,
      blocked: m.blocked,
      companyOf: m.companyOf,
    });
    const names = selection.names;
    const added = new Set(selection.added);
    const owed = new Set(m.owed ?? []);
    let w = 1;
    if (cfg.volScale) {
      const sigma = m.excessVol(names);
      vol = volScale({
        sigma,
        history: st.volHist,
        prevW: st.volW,
        hyst: cfg.volHyst,
        minHistory: cfg.volMinHistory,
        capFirst: cfg.volHystCapFirst,
      });
      w = vol.w;
      if (vol.nextW !== st.volW && st.volW !== null && vol.nextW !== null) {
        events.push({ kind: 'VOL_SCALE', detail: `${st.volW.toFixed(4)}→${vol.nextW.toFixed(4)}` });
      }
      st.volW = vol.nextW;
      st.volHist.push(sigma);
    }
    // 正式流程：動能只依波動度減碼（allocation_redesign §2.1）；崩盤規則的減半只在舊路徑
    const newCrash = legacy && !!m.coreBelow200;
    const eff = w * (newCrash ? cfg.crashCut : 1);
    const nameT = momSlotTarget(cfg, total, eff, ownValForMom);
    slotTarget = nameT;
    for (const x of selection.exits) events.push({ kind: 'MOM_EXIT', ticker: x.ticker, detail: x.why });
    for (const t of selection.added) events.push({ kind: 'MOM_ENTRY', ticker: t });
    for (const k of Object.keys(tgt)) {
      const c = parseCell(k);
      if (c.bucket === 'mom' && !names.includes(c.ticker)) {
        tgt[k] = 0;
        why[k] = '動能換股';
      }
    }
    const changed = st.effPrev === null || eff !== st.effPrev;
    const crashFlip = legacy && newCrash !== st.crash;
    const wReason: Reason = crashFlip ? '崩盤規則' : '波動度減碼';
    for (const t of names) {
      const mk = cellKey('mom', t);
      const ok = cellKey('own', t);
      const cur = get(tgt, mk);
      const ownT = get(tgt, ok);
      let tT = nameT;
      if (cfg.crossCapBuy !== null) {
        tT = Math.min(nameT, Math.max(0, cfg.crossCapBuy * total - ownT));
        if (tT < nameT && (added.has(t) || changed)) events.push({ kind: 'CROSS_LIMIT_BUY', ticker: t });
      }
      if (added.has(t)) {
        tgt[mk] = tT;
        why[mk] = '動能換股';
      } else if (changed) {
        tgt[mk] = tT;
        why[mk] = wReason;
      } else if (owed.has(t)) {
        tgt[mk] = tT;
        why[mk] = '策略單補做';
      } else if (cfg.lazyBand !== null && Math.abs(cur - tT) > cfg.lazyBand * tT) {
        lazyPrev[mk] = cur;
        tgt[mk] = tT;
        why[mk] = '動能比例回調';
      }
      if (cfg.crossCapBuy !== null) {
        const mv = get(tgt, mk);
        if (ownT + mv > cfg.crossCapHi * total) {
          // 合計超過 15% → 減回 10%，先減動能那部分
          const excess = ownT + mv - cfg.crossCapBuy * total;
          const cut = Math.min(mv, excess);
          tgt[mk] = mv - cut;
          why[mk] = '跨桶上限';
          if (excess - cut > 0) {
            tgt[ok] = ownT - (excess - cut);
            why[ok] = '跨桶上限';
          }
          events.push({ kind: 'CROSS_TRIM', ticker: t, detail: excess - cut > 0 ? 'OWN_PART' : 'MOM_ONLY' });
        }
      }
    }
    st.heldMom = names;
    st.effPrev = eff;
    crashChanged = crashFlip;
    if (crashFlip) events.push({ kind: newCrash ? 'CRASH_ON' : 'CRASH_OFF' });
    if (legacy) st.crash = newCrash;
  }

  // ---- 搭便車：當天沒有其他原因的單，就撤回動能比例回調（§2.1 第 5 點）
  if (Object.keys(lazyPrev).length) {
    let keepLazy = true;
    if (cfg.piggyback && !first) {
      const others =
        crashChanged ||
        Object.entries(why).some(([k, r]) => r !== '動能比例回調' && Math.abs(get(tgt, k) - get(val, k)) > cfg.orderMin * total);
      if (!others) {
        keepLazy = false;
        for (const [k, c0] of Object.entries(lazyPrev)) {
          tgt[k] = c0;
          delete why[k];
          const t = parseCell(k).ticker;
          events.push({ kind: 'LAZY_SKIPPED', ticker: t });
          // 回調撤回後，跨桶上限仍要檢查（上限是風險控制，不需要搭便車）
          if (cfg.crossTrimAlways && cfg.crossCapBuy !== null) {
            const ok = cellKey('own', t);
            const ownT = get(tgt, ok);
            if (ownT + c0 > cfg.crossCapHi * total) {
              const excess = ownT + c0 - cfg.crossCapBuy * total;
              const cut = Math.min(c0, excess);
              tgt[k] = c0 - cut;
              why[k] = '跨桶上限';
              if (excess - cut > 0) {
                tgt[ok] = ownT - (excess - cut);
                why[ok] = '跨桶上限';
              }
              events.push({ kind: 'CROSS_TRIM', ticker: t, detail: excess - cut > 0 ? 'OWN_PART' : 'MOM_ONLY' });
            }
          }
        }
      }
    }
    if (keepLazy) for (const k of Object.keys(lazyPrev)) events.push({ kind: 'LAZY_REBALANCE', ticker: parseCell(k).ticker });
  }

  // ---- 核心桶 = 總資產 − 自選 − 動能；核心是清算中心
  const ownVal = sumBucket(tgt, 'own');
  const momVal = sumBucket(tgt, 'mom');
  const core = total - ownVal - momVal;
  let coreBand: CoreBand | null = null;
  let coreRebal = false;
  if (!legacy) {
    // 固定比例（allocation_redesign §1.2、§1.3；和 backtest/b10_account.py 的 core_policy='ratio' 同一套算式）：
    // 進出核心的差額照目標比例分到兩個格子（一邊不夠由另一邊補）；月報日超出界線才把現金格調回目標
    const { bond } = coreCfg(cfg);
    let cs = core * bond;
    if (!first) {
      const delta = core - get(tgt, CORE) - get(tgt, CORE_CASH);
      cs = get(tgt, CORE_CASH) + bond * delta;
      const etf = get(tgt, CORE) + (1 - bond) * delta;
      if (cs < 0) cs = 0;
      if (etf < 0) cs = core;
      if (inp.monthly) {
        coreBand = coreBandCheck(cs, core, cfg);
        if (coreBand.out) {
          cs = core * bond;
          coreRebal = true;
          events.push({ kind: 'CORE_BAND', detail: coreBand.s.toFixed(4) });
        }
      }
    }
    tgt[CORE_CASH] = cs;
    tgt[CORE] = core - cs;
  } else if (first || crashChanged) {
    const cashT = st.crash ? core * (1 - cfg.crashCut) : 0;
    tgt[CORE_CASH] = cashT;
    tgt[CORE] = core - cashT;
  } else {
    // 差額由清算中心吸收：崩盤規則啟動時進出現金，平時進出核心 ETF
    const delta = core - get(tgt, CORE) - get(tgt, CORE_CASH);
    const [a, b] = st.crash ? [CORE_CASH, CORE] : [CORE, CORE_CASH];
    tgt[a] = get(tgt, a) + delta;
    if (tgt[a] < 0) {
      tgt[b] = get(tgt, b) + tgt[a];
      tgt[a] = 0;
    }
  }

  return { totalBefore, total, targets: tgt, why, state: st, events, crashChanged, coreBand, coreRebal, selection, vol, slotTarget };
}

// ---------------------------------------------------------------- 自選訊號：今天執行哪些（§2.5 通知分級）

export interface DueOwnInput {
  cfg: EngineConfig;
  /** 還沒執行的自選訊號（每檔只留最新一個）。 */
  pending: Record<string, OwnAction>;
  state: RuleState;
  values: CellMap;
  isMonthly: boolean;
}

/**
 * 月報日：全部執行。平日：只執行單筆變動 ≥ 總資產 urgentFrac（5%）的訊號（當天通知、隔天執行），
 * 其餘累積到月報。
 */
export function dueOwnActions(inp: DueOwnInput): { todo: Record<string, OwnAction>; urgent: boolean } {
  const { cfg, pending, state, values } = inp;
  if (!Object.keys(pending).length) return { todo: {}, urgent: false };
  if (inp.isMonthly) return { todo: { ...pending }, urgent: false };
  if (cfg.urgentFrac === null) return { todo: {}, urgent: false };
  const total = Object.values(values).reduce((a, b) => a + b, 0);
  const todo: Record<string, OwnAction> = {};
  for (const [tk, act] of Object.entries(pending)) {
    const change = ownSignalChange(state, values, tk, act, total);
    if (change > 0 && change >= cfg.urgentFrac * total) todo[tk] = act;
  }
  return { todo, urgent: Object.keys(todo).length > 0 };
}

/** 這個自選訊號會讓這一格變動多少金額（已經不適用的訊號 = 0）。 */
export function ownSignalChange(state: RuleState, values: CellMap, ticker: string, act: OwnAction, total: number): number {
  const o = state.own[ticker];
  if (!o) return 0;
  const cur = get(values, cellKey('own', ticker));
  if (act === 'REDUCE' && o.applied !== 'HALF') return cur * 0.5;
  if (act === 'READD' && o.applied === 'HALF') return Math.max(0, o.stdWeight * total - cur);
  return 0;
}

// ---------------------------------------------------------------- 合併下單與「下單日」

export interface OrderSummary {
  /** 按代號合併後的淨買賣金額（不含現金格）。 */
  net: Record<string, number>;
  /** 淨成交金額合計（算手續費用）。 */
  traded: number;
  /** 超過門檻、真的要下的單。入金出金日會包含短債 ETF。 */
  orders: { ticker: string; amount: number; frac: number }[];
  reasons: string[];
  /** 只因為比例漂移而下單。 */
  ratioOnly: boolean;
}

export const SHORT_BOND_LABEL = '短債ETF';

/** 先算每一桶的目標，再按代號合併，只留最後的淨買賣（設計 §2.3 合併下單）。 */
export function summarizeOrders(
  cfg: EngineConfig,
  values: CellMap,
  plan: Pick<PlanResult, 'targets' | 'why' | 'total' | 'crashChanged'> & Partial<Pick<PlanResult, 'coreRebal'>>,
  flowKind?: '入金' | '出金',
  /** cashLabel：核心現金格的變動也算一張單、用這個名字列出（新規則的重放基準：短債的買賣也要下單）。沒給 = 只有入金出金日才列（舊路徑）。 */
  opt: { cashLabel?: string } = {},
): OrderSummary {
  const { targets: tgt, why, total } = plan;
  const keys = new Set([...Object.keys(tgt), ...Object.keys(values)]);
  const net: Record<string, number> = {};
  for (const k of keys) {
    const { ticker } = parseCell(k);
    if (ticker === CASH) continue;
    net[ticker] = (net[ticker] ?? 0) + get(tgt, k) - get(values, k);
  }
  const traded = Object.values(net).reduce((a, x) => a + Math.abs(x), 0);
  const shown: Record<string, number> = { ...net };
  if (flowKind || opt.cashLabel) {
    const dc = get(tgt, cellKey('core', CASH)) - get(values, cellKey('core', CASH));
    if (Math.abs(dc) > 1e-12) shown[opt.cashLabel ?? SHORT_BOND_LABEL] = dc;
  }
  let big = Object.entries(shown).filter(([, x]) => Math.abs(x) > cfg.orderMin * total);
  const bigSet = new Set(big.map(([t]) => t));
  const reasons = new Set<string>();
  for (const k of keys) {
    const c = parseCell(k);
    if (c.bucket === 'core' || !bigSet.has(c.ticker)) continue;
    if (Math.abs(get(tgt, k) - get(values, k)) > cfg.orderMin * total && why[k]) reasons.add(why[k]);
  }
  if (plan.crashChanged) reasons.add('崩盤規則');
  if (plan.coreRebal) reasons.add('核心比例');
  if (flowKind) {
    reasons.add(flowKind);
    if (!big.length) big = Object.entries(shown).filter(([, x]) => Math.abs(x) > 1e-9); // 入金出金當天一定要操作
  }
  const orders = big
    .map(([ticker, amount]) => ({ ticker, amount, frac: Math.abs(amount) / total }))
    .sort((a, b) => Number((b.frac * total).toFixed(12)) - Number((a.frac * total).toFixed(12)) || (a.ticker < b.ticker ? -1 : 1));
  const rs = [...reasons].sort();
  return { net, traded, orders, reasons: rs, ratioOnly: rs.length > 0 && rs.every((r) => RATIO_REASONS.has(r)) };
}
