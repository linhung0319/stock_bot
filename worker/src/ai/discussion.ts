// T27：討論包與貼回的解析（own_thesis §1.7、§1.8）。論點在 claude.ai 討論（方案 B），stock bot 只做頭和尾：
//   頭：discussionPack 組一段 markdown（固定指示 DISCUSSION_V1 ＋ 論點檔 ＋ 數字），使用者複製貼到 claude.ai
//   尾：parseThesisBlock 解析 claude.ai 收尾時輸出的固定格式區塊，給「編輯論點」頁預覽
// 純函式：不讀資料庫、網路、時鐘。固定指示和解析器要同一個版本，所以指示放在這裡（Worker 讀不到 repo 的 md）。
// 討論包只放比重，不放金額與股數。
import { SLOW, TIER_NAME, bucketValue, rollingMax, sma, totalValue, trailingReturn, type Account, type MarketView, type Tier } from '../engine';
import type { CondAction, ThesisFile } from '../app/thesis';

export const DISCUSSION_VERSION = 'discussion_v1';

/** 固定指示（own_thesis §1.7，照抄）。`<代號>` 在組討論包時換成這一檔的代號。 */
export const DISCUSSION_V1 = `你是我的反方審查員，不是我的啦啦隊。我們要討論的是我持有這檔股票的理由還成不成立。

1. 站在反方。不要順著我說；我講得越肯定，你越要問證據在哪裡。
2. 把「論點壞了」和「價格跌了」分開。價格下跌本身不是論點壞了的證據，價格上漲也不是論點成立的證據。
3. 討論中一定要問我，並且自己也回答：「如果我現在沒有這檔股票，今天會不會用現在的價格買進？」
4. 你可以上網查資料。每一件事都要給來源與日期，並分清楚「公司申報或財報裡寫的」和「報導或分析師說的」。
   查不到來源的事，就說查不到。下面這份資料是 stock bot 整理的，數字由程式算好，可以直接用。
5. 不要給目標價，不要建議買賣幾股。部位大小由 stock bot 的規則決定。
6. 如果「這次為什麼討論」寫的是前提被判不成立：先講這個判斷站不站得住，再談要不要改論點。
   在前提不成立之後才改論點，很容易只是替「繼續持有」找新理由；發現我在這樣做的時候請直接指出來。
7. 出場條件要寫成之後查得到的事：財報數字的門檻（例如毛利率連兩季低於 70%），
   或公司申報裡會寫的事（例如公司在 8-K 下修全年財測）。「基本面轉差」這種不算。
8. 我說「收尾」的時候，只輸出下面這個區塊，格式一字不改，裡面用我們討論出來的內容：

===STOCKBOT 論點 v1 <代號>===
論點：
（一段，300 字以內：我為什麼持有它）
前提：
1. （要繼續成立的事，一條一行，最多 5 條）
出場條件：
1. （查得到的事） → 出清
2. （查得到的事） → 減半
3. （查得到的事） → 重新審查
這次的結論：維持｜修正論點｜減半｜出清
理由：（一句）
===END===`;

/** 討論的情境（§1.7）：從乙類通知按的 BREAK；只有預設前提而且沒有論點本文 NEW；其餘 ROUTINE。 */
export type DiscussionMode = 'NEW' | 'ROUTINE' | 'BREAK';
export const DISCUSSION_MODES: readonly DiscussionMode[] = ['NEW', 'ROUTINE', 'BREAK'];

/** 沒指定情境時程式選（§1.7）。notif：從通知按的（通知編號）。 */
export function pickMode(file: Pick<ThesisFile, 'kind' | 'thesis'>, notif?: number | null): DiscussionMode {
  if (notif) return 'BREAK';
  return file.kind === 'DEFAULT_ONLY' && !file.thesis?.text ? 'NEW' : 'ROUTINE';
}

/** 討論包的數字（由程式算好；只放比重，不放金額與股數）。比例都是小數。 */
export interface DiscussionNumbers {
  /** 收盤那一天（訊號日）。 */
  date: string;
  close: number | null;
  /** 距 52 週高點（負數）。 */
  fromHigh: number | null;
  ma200: number | null;
  /** 收盤相對 200 日均線。 */
  vsMa: number | null;
  slow: 'STD' | 'HALF';
  ret1y: number | null;
  /** 這檔占總資產。 */
  weight: number | null;
  stdWeight: number | null;
  /** 自選桶合計占總資產、自選的預算。 */
  ownTotal: number | null;
  ownBudget: number | null;
  /** 最近 8 季財報表（XBRL 原文）；沒有是 null。 */
  xbrl: string | null;
  /** 開檔時就是減半（§3.8）：加入時距 52 週高點的跌幅（負數）；不是或不知道是 null。 */
  openedHalf: number | null;
  /** 部位達標準比重 2 倍以上（§3.6.3，T35 填）：占總資產、是標準比重的幾倍。 */
  size?: { weight: number; ratio: number } | null;
}

const fin = (x: number) => (Number.isFinite(x) ? x : null);

/** 從帳戶與市場算討論包的數字（只有比例，沒有金額與股數）。xbrl：財報表原文（呼叫的地方取得）。 */
export function discussionNumbers(acct: Account, view: MarketView, ticker: string, xbrl: string | null): DiscussionNumbers {
  const c = view.close[ticker];
  const close = c ? fin(c[view.i]) : null;
  const hi = c ? fin(rollingMax(c, view.i, SLOW.highDays)) : null;
  const ma = c ? fin(sma(c, view.i, SLOW.maDays)) : null;
  const total = totalValue(acct, view);
  const sh = (acct.lots.own[ticker] ?? 0) + (acct.lots.mom[ticker] ?? 0) + (acct.lots.core[ticker] ?? 0);
  const meta = acct.own[ticker];
  const rule = acct.rule.own[ticker];
  const opened = meta?.opened;
  return {
    date: view.date,
    close,
    fromHigh: close !== null && hi ? close / hi - 1 : null,
    ma200: ma,
    vsMa: close !== null && ma ? close / ma - 1 : null,
    slow: rule?.applied === 'HALF' ? 'HALF' : 'STD',
    ret1y: c ? fin(trailingReturn(c, view.i)) : null,
    weight: total > 0 && close !== null ? (sh * close) / total : null,
    stdWeight: rule?.stdWeight ?? null,
    ownTotal: total > 0 ? bucketValue(acct, view, 'own') / total : null,
    ownBudget: acct.cfg.ratio.own,
    xbrl,
    openedHalf: opened?.startState === 'HALF' && opened.drawdownAtOpen !== null ? opened.drawdownAtOpen : null,
    size: null,
  };
}

/** BREAK 情境要的：審查判哪一條前提不成立、建議什麼、依據的原文。 */
export interface BreakInfo {
  notif: number | null;
  premiseId: string | null;
  premiseText: string | null;
  tier: Tier | null;
  quote: string | null;
  /** 原文的出處（例如「8-K 2027-01-06」）。 */
  source: string | null;
}

/** 討論包長度目標（字）。 */
export const MAX_PACK_CHARS = 12_000;
const MAX_EVENTS = 10;
const MAX_REVIEWS = 3;

const pc = (x: number | null, d = 1) => (x === null || !Number.isFinite(x) ? '—' : `${(x * 100).toFixed(d)}%`);
const spc = (x: number | null, d = 1) => (x === null || !Number.isFinite(x) ? '—' : `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(d)}%`);
const px = (x: number | null) => (x === null || !Number.isFinite(x) ? '—' : x.toFixed(2));

const SOURCE_TEXT: Record<string, string> = { EDGAR: '申報分類', SCAN: '每日掃描標記', AI: 'AI 轉交', PRICE: '價格規則' };
const CODE_TEXT: Record<string, string> = {
  EARNINGS: '財報',
  MGMT_CHANGE: '高層異動',
  GUIDANCE_CUT: '財測',
  RESTRUCTURING: '重組',
  MAJOR_CONTRACT: '重大合約',
  FINANCING: '籌資',
  DILUTION: '增資',
  PENDING_MA: '被收購',
  ACCOUNTING: '會計問題',
  REGULATORY: '監管或訴訟',
  DISTRESS: '財務危機',
  CYBER: '資安事件',
  ACTIVIST: '大股東申報（13D）',
  CONDITION_HINT: '可能和條件有關',
  PRICE_DROP: '個股自身大跌',
  OTHER: '其他',
};
const TRIGGER_TEXT: Record<string, string> = { MONTHLY: '月審', EARNINGS: '財報後審查', THESIS: '論點變動後審查', MANUAL: '審查', EARLY: '提前審查', CONDITION: '條件觸發的審查', 慢規則減半: '減半檢視' };
const STATUS_TEXT: Record<string, string> = { SPLIT: '沒有一致結論', INVALID: '格式不合格，沒有結論', DATA_MISSING: '資料缺漏', TIMEOUT: '逾時，沒有結論', NO_RESULT: '沒有結果' };
const PREM_TEXT: Record<string, string> = { HOLDS: '成立', BROKEN: '不成立', INSUFFICIENT: '證據不足' };
const OUTCOME_TEXT: Record<string, string> = { FOLLOW: '照做', REVISE: '修正論點', DISAGREE: '不同意', SKIPPED: '沒有動它', NONE: '沒有回應', RULE: '照規則' };
const COND_STATE: Record<string, string> = { ACTIVE: '監測中', REVIEW_ONLY: '只在定期審查時檢查', MANUAL: '只記錄', MET: '已成立' };
const ACTION_TEXT: Record<CondAction, string> = { EXIT: '出清', HALF: '減半', REVIEW: '重新審查' };
/** 全形空白（討論包裡日期與內容之間的分隔，照 §1.7 的範例）。 */
const SP = '　';
const md = (iso: string | null) => (iso ? `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}` : '—');

function whySection(file: ThesisFile, n: DiscussionNumbers, mode: DiscussionMode, brk: BreakInfo | null): string[] {
  if (mode === 'NEW') {
    const L = ['我持有這檔，但還沒有寫下論點。請先問我 3 個問題（為什麼買、哪幾件事要繼續成立、什麼情況下我會承認看錯），', '我回答之後再和我討論，不要直接替我寫。'];
    if (n.openedHalf !== null) L.push(`這檔是在大跌之後買的（加入時比 52 週高點低 ${pc(-n.openedHalf, 0)}）。`, '請先問我：它為什麼跌、為什麼我認為市場錯了。');
    return L;
  }
  if (mode === 'ROUTINE') {
    const L = ['例行檢視。請先挑出論點裡最弱的一條前提，從那裡開始。'];
    if (n.size) L.push(`這檔現在占總資產 ${pc(n.size.weight)}，是標準比重的 ${n.size.ratio.toFixed(1)} 倍。`, '請問我：今天從零開始，會不會買到這個比重。');
    return L;
  }
  const p = brk?.premiseId ? `前提 ${brk.premiseId}「${brk.premiseText ?? '…'}」` : '我的一條前提';
  const tier = brk?.tier ? `建議${TIER_NAME[brk.tier]}` : '建議調整部位';
  const L = [`stock bot 的審查（3 票一致）認為${p}不成立，${tier}。它的依據：`];
  L.push(brk?.quote ? `「${brk.quote.slice(0, 500)}」— ${brk.source ?? '申報原文'}` : '（引用的原文在 stock bot 網站的審查紀錄）');
  L.push(`我還沒決定。這是我第 ${(file.thesis?.afterBreak ?? 0) + 1} 次在前提被判不成立之後討論這檔的論點。`);
  return L;
}

function thesisSection(file: ThesisFile): string[] {
  const t = file.thesis;
  if (!t?.text) return ['還沒有'];
  const meta = `（${t.setAt} 定，${t.source === 'DISCUSSION' ? '討論後貼回' : '在網站手寫'}，第 ${t.version} 版${t.afterBreak ? `，失效後修改第 ${t.afterBreak} 次` : ''}）`;
  return [t.text, meta];
}

function premiseSection(file: ThesisFile): string[] {
  if (!file.premises.length) return ['還沒有'];
  const L = file.premises.map((p) => {
    const chk = p.lastCheck ? `${PREM_TEXT[p.lastCheck.status] ?? p.lastCheck.status}（${p.lastCheck.date} 審查）` : '還沒有檢查過';
    const def = p.origin === 'SYSTEM_DEFAULT' ? '（系統預設）' : '';
    return `${p.id} ${p.text}${def}${SP}— ${chk}${p.splitAfter ? '；之後的審查沒有一致結論' : ''}`;
  });
  if (file.kind === 'DEFAULT_ONLY') L.push('（這些是系統預設的一般健康檢查，不是我的論點。）');
  return L;
}

function conditionSection(file: ThesisFile): string[] {
  const owned = file.conditions.filter((c) => (!!c.acceptedAt || c.origin === 'USER') && c.status in COND_STATE);
  const proposed = file.conditions.filter((c) => c.status === 'PROPOSED');
  if (!owned.length && !proposed.length) return ['還沒有'];
  const L: string[] = [];
  if (owned.length) {
    L.push('你定的：');
    owned.forEach((c, k) => {
      const act = c.action ? ACTION_TEXT[c.action] : '重新審查';
      L.push(`C${k + 1} ${c.text} → ${act}（${md(c.acceptedAt ?? c.createdAt)} 定；${c.status === 'MET' ? `已成立 ${c.metAt?.slice(0, 10) ?? ''}` : COND_STATE[c.status]}）`);
    });
  }
  if (proposed.length) {
    L.push('AI 建議、還沒勾選的：');
    proposed.forEach((c, k) => L.push(`W${k + 1} ${c.text}`));
  }
  return L;
}

function eventSection(file: ThesisFile): string[] {
  const evs = file.events.filter((e) => e.isNew).slice(0, MAX_EVENTS);
  if (!evs.length) return ['沒有'];
  return evs.map((e) => {
    const what = CODE_TEXT[e.code] ?? e.code;
    const form = e.form === 'NEWS' ? '新聞標題' : e.form;
    const src = SOURCE_TEXT[e.source] ?? e.source;
    const detail = e.detail ? `：${e.detail.replace(/\s+/g, ' ').slice(0, 160)}` : '';
    return `${e.date}${SP}${form}${SP}${src}：${what}${detail}`;
  });
}

function reviewSection(file: ThesisFile): string[] {
  const rs = file.reviews.filter((r) => r.status !== 'PENDING' && (r.fn === 'OWN_REVIEW' || r.fn === 'OWN_DROP')).slice(0, MAX_REVIEWS);
  if (!rs.length) return ['還沒有'];
  const L: string[] = [];
  for (const r of rs) {
    const kind = TRIGGER_TEXT[r.trigger ?? ''] ?? r.label;
    const votes = Math.max(0, ...Object.values(r.votes));
    const head = r.status === 'AGREED' || r.status === 'INSUFFICIENT' ? `${r.verdict ? (TIER_NAME[r.verdict as Tier] ?? r.verdict) : '—'}（${votes} 票）` : (STATUS_TEXT[r.status] ?? r.status);
    const broken = r.brokenPremises.length ? `不成立：${r.brokenPremises.join('、')}。` : '';
    const resp = r.response ? `我的回應：${OUTCOME_TEXT[r.response.outcome] ?? r.response.outcome}${r.response.reason ? `（${r.response.reason}）` : ''}。` : r.notif ? '我的回應：還沒回。' : '';
    L.push(`${r.date}${SP}${kind}：${head}。${broken}${resp}`);
    if (r.summary) L.push(`${SP}${r.summary.replace(/\s+/g, ' ')}`);
  }
  return L;
}

function numberSection(n: DiscussionNumbers, xbrl: string | null): string[] {
  const L = [
    `收盤 ${px(n.close)}（${n.date}）；距 52 週高點 ${spc(n.fromHigh)}；200 日均線 ${px(n.ma200)}（收盤相對均線 ${spc(n.vsMa)}）`,
    `慢規則狀態：${n.slow === 'HALF' ? '減半中' : '標準'}；過去一年報酬 ${spc(n.ret1y)}`,
    `比重：占總資產 ${pc(n.weight)}，標準比重 ${pc(n.stdWeight)}；自選桶合計 ${pc(n.ownTotal, 0)}（預算 ${pc(n.ownBudget, 0)}）`,
    '',
    '最近 8 季財報表（XBRL）：',
    xbrl ?? '沒有財報表',
  ];
  return L;
}

/**
 * 組討論包（own_thesis §1.7）。file：論點檔；n：程式算好的數字；mode：情境；brk：BREAK 情境的依據。
 * 長度目標 12,000 字以內：事件最多 10 件、審查最多 3 次；還是太長時先縮財報表，最後截斷。
 */
export function discussionPack(file: ThesisFile, n: DiscussionNumbers, mode: DiscussionMode, brk: BreakInfo | null = null): string {
  const cut = DISCUSSION_V1.indexOf('\n8. ');
  const ask = DISCUSSION_V1.slice(0, cut).trim();
  const out = DISCUSSION_V1.slice(cut + 1).replace('<代號>', file.ticker);
  const build = (xbrl: string | null) =>
    [
      `# ${file.ticker} 論點討論包（stock bot，${n.date}，${DISCUSSION_VERSION}）`,
      '',
      '## 請你做的事',
      ask,
      '',
      '## 這次為什麼討論',
      ...whySection(file, n, mode, brk),
      '',
      '## 我的論點',
      ...thesisSection(file),
      '',
      '## 前提（最近一次檢查）',
      ...premiseSection(file),
      '',
      '## 出場條件',
      ...conditionSection(file),
      '',
      '## 上次審查之後的事件',
      ...eventSection(file),
      '',
      '## 最近的審查與我的回應',
      ...reviewSection(file),
      '',
      '## 數字',
      ...numberSection(n, xbrl),
      '',
      '## 收尾時的輸出格式',
      out,
      '',
    ].join('\n');
  let xbrl = n.xbrl;
  let text = build(xbrl);
  // 太長：財報表一季一季拿掉（舊的先拿），再不夠就整張拿掉
  while (text.length > MAX_PACK_CHARS && xbrl && xbrl.split('\n').length > 2) {
    xbrl = xbrl.split('\n').slice(0, -1).join('\n');
    text = build(xbrl);
  }
  if (text.length > MAX_PACK_CHARS && xbrl) text = build('（放不下，沒有放進來）');
  if (text.length > MAX_PACK_CHARS) {
    // 最後手段：保留開頭與收尾的格式，中間截斷
    const tail = `\n…（中間太長，截斷）\n\n## 收尾時的輸出格式\n${out}\n`;
    text = text.slice(0, MAX_PACK_CHARS - tail.length) + tail;
  }
  return text;
}

// ---------------------------------------------------------------- 貼回的解析（§1.8）

export interface ParsedExit {
  text: string;
  action: CondAction;
  /** 動作沒寫或不認得，當成「重新審查」（預覽要標出來）。 */
  guessed: boolean;
}

export interface ParsedThesis {
  /** 找到固定格式的區塊。 */
  found: boolean;
  /** 擋下來的原因（代號不符）；有值時其他欄位是空的。 */
  error: string | null;
  thesis: string;
  premises: string[];
  exits: ParsedExit[];
  /** 「這次的結論」（只顯示，不會自動做任何事）。 */
  conclusion: string | null;
  reason: string | null;
  /** 預覽要標出來的事（截掉的、動作不認得的、沒找到格式）。 */
  notes: string[];
}

/** 上限（§1.8）。 */
export const THESIS_LIMITS = { thesis: 600, premises: 5, premise: 200, exits: 6, exit: 300 } as const;

const ACTIONS: Record<string, CondAction> = { 出清: 'EXIT', 減半: 'HALF', 重新審查: 'REVIEW' };
const TAG = /^\s*(論點|前提|出場條件|這次的結論|理由)\s*[：:]\s*(.*)$/;
const ITEM = /^\s*(\d+)\s*[.、)）．]\s*(.*)$/;

/**
 * 解析 claude.ai 收尾時輸出的區塊（own_thesis §1.8）：
 *   先去掉 markdown 的程式碼圍欄；找 `===STOCKBOT 論點 v1 <代號>===` 到 `===END===`（有好幾個時取最後一個）；代號要和這一頁相同。
 *   區塊內照行首的標籤切（全形或半形冒號）；前提、出場條件只算行首是「數字 + . 、 )」的行；
 *   出場條件用最後一個 → 或 -> 切成條件與動作，動作只收出清、減半、重新審查，其他當成重新審查並標出來；
 *   超過上限的截掉並標出來；找不到標記時整段放進論點欄。
 */
export function parseThesisBlock(text: string, ticker: string): ParsedThesis {
  const empty: ParsedThesis = { found: false, error: null, thesis: '', premises: [], exits: [], conclusion: null, reason: null, notes: [] };
  const lines = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((l) => !/^\s*(```|~~~)/.test(l));
  const starts = lines.map((l, i) => ({ i, m: /^\s*===\s*STOCKBOT\s+論點\s+v1\s+([A-Za-z0-9.-]+)\s*===\s*$/.exec(l) })).filter((x) => x.m);
  const start = starts.at(-1);
  const end = start ? lines.findIndex((l, i) => i > start.i && /^\s*===\s*END\s*===\s*$/.test(l)) : -1;
  if (!start || end < 0) {
    const whole = lines.join('\n').trim();
    return { ...empty, thesis: whole, notes: whole ? ['沒找到固定格式，請自己分到三欄'] : [] };
  }
  const got = start.m![1].toUpperCase();
  if (got !== ticker.toUpperCase()) return { ...empty, found: true, error: `這段是 ${got} 的論點，這一頁是 ${ticker.toUpperCase()}。請貼這一檔的討論結果。` };

  const sec: Record<string, string[]> = { 論點: [], 前提: [], 出場條件: [], 這次的結論: [], 理由: [] };
  let cur: string | null = null;
  for (const l of lines.slice(start.i + 1, end)) {
    const t = TAG.exec(l);
    if (t) {
      cur = t[1];
      if (t[2].trim()) sec[cur].push(t[2]);
      continue;
    }
    if (cur) sec[cur].push(l);
  }
  const notes: string[] = [];
  const items = (rows: string[], label: string) => {
    const out: string[] = [];
    let loose = 0;
    for (const r of rows) {
      const m = ITEM.exec(r);
      if (m) {
        if (m[2].trim()) out.push(m[2].trim());
      } else if (r.trim()) loose++;
    }
    if (loose) notes.push(`${label}有 ${loose} 行沒有編號，沒有算進去`);
    return out;
  };

  let thesis = sec.論點.map((l) => l.trim()).filter(Boolean).join('\n');
  if (thesis.length > THESIS_LIMITS.thesis) {
    notes.push(`論點超過 ${THESIS_LIMITS.thesis} 字，後面截掉了`);
    thesis = thesis.slice(0, THESIS_LIMITS.thesis);
  }
  let premises = items(sec.前提, '前提');
  if (premises.length > THESIS_LIMITS.premises) {
    notes.push(`前提超過 ${THESIS_LIMITS.premises} 條，只留前 ${THESIS_LIMITS.premises} 條`);
    premises = premises.slice(0, THESIS_LIMITS.premises);
  }
  premises = premises.map((p, k) => {
    if (p.length <= THESIS_LIMITS.premise) return p;
    notes.push(`前提第 ${k + 1} 條超過 ${THESIS_LIMITS.premise} 字，後面截掉了`);
    return p.slice(0, THESIS_LIMITS.premise);
  });
  let exitRows = items(sec.出場條件, '出場條件');
  if (exitRows.length > THESIS_LIMITS.exits) {
    notes.push(`出場條件超過 ${THESIS_LIMITS.exits} 條，只留前 ${THESIS_LIMITS.exits} 條`);
    exitRows = exitRows.slice(0, THESIS_LIMITS.exits);
  }
  const exits: ParsedExit[] = exitRows.map((row, k) => {
    const a = row.lastIndexOf('→');
    const b = row.lastIndexOf('->');
    const [at, len] = a >= b ? [a, 1] : [b, 2];
    let cond = at >= 0 ? row.slice(0, at).trim() : row.trim();
    const word = at >= 0 ? row.slice(at + len).trim().replace(/[。.．,，;；!！\s]+$/, '') : '';
    const action = ACTIONS[word];
    if (!action) notes.push(`出場條件第 ${k + 1} 條的動作${word ? `「${word}」不認得` : '沒寫'}，先當成「重新審查」`);
    if (cond.length > THESIS_LIMITS.exit) {
      notes.push(`出場條件第 ${k + 1} 條超過 ${THESIS_LIMITS.exit} 字，後面截掉了`);
      cond = cond.slice(0, THESIS_LIMITS.exit);
    }
    return { text: cond, action: action ?? 'REVIEW', guessed: !action };
  });
  const one = (rows: string[]) => rows.map((l) => l.trim()).filter(Boolean).join(' ') || null;
  return { found: true, error: null, thesis, premises, exits, conclusion: one(sec.這次的結論), reason: one(sec.理由), notes };
}
