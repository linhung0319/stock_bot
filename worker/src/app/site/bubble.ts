// 史萊姆說的話：一句帶真實數字的白話。
// - 月報頁：每改一個選項，只講「這個選項造成的結果」（choiceEffect），用引擎在改之前、改之後各算一次的清單比較。
// - 待辦頁：照建議做完的結果（todoBubble）。
// - 帳戶頁：現在的狀況（accountBubble）。
// 用字：中文白話、帶實際數字、不出現內部代號。
import type { AccountView, ComposedView, ItemView, TodoView } from './views';

/** 一段字；em = 強調（亮色），neg = 壞消息（紅色）。 */
export type Seg = string | { t: string; tone: 'em' | 'neg' };

export interface Bubble {
  /** 上面那一行小標：這句話在講什麼。 */
  k: string;
  say: Seg[];
  /** 史萊姆的表情。happy = 照建議；worry = 有風險；watch = 改了但沒問題；alert = 有事等你；idle = 沒事。 */
  mood: 'happy' | 'worry' | 'watch' | 'alert' | 'idle';
}

const em = (t: string): Seg => ({ t, tone: 'em' });
const neg = (t: string): Seg => ({ t, tone: 'neg' });

export const money = (x: number): string => (Number.isFinite(x) ? `${x < 0 ? '−$' : '$'}${Math.round(Math.abs(x)).toLocaleString('en-US')}` : '—');
const pct0 = (x: number): string => `${Math.round(x * 100)}%`;

/** 現金低於這個數字才算「會是負的」（零頭不算）。 */
const NEG_CASH = -1;
/** 一桶比預算高出這麼多，才提醒「超出預算」。 */
const OVER_BUDGET = 0.05;

const orderCount = (c: ComposedView): number => c.orders.filter((o) => !o.transfer).length;
const sharesOf = (c: ComposedView, t: string): number => c.orders.find((o) => o.ticker === t)?.shares ?? 0;
const verb = (n: number): string => (n < 0 ? '賣' : n > 0 ? '買' : '動');
/** 「照 AI：提高到標準的 125%」→「照 AI」；「這次不做（下個月再列）」→「這次不做」。 */
export const shortLabel = (label: string): string => label.replace(/[：（].*$/, '');

function orderPhrase(n: number): string {
  return n === 0 ? '不用下單' : `${verb(n)} ${Math.abs(n)} 股`;
}

/** 做完之後各桶占多少（各桶的單加上去；核心吸收現金的變化）。 */
export function bucketsAfter(acct: Pick<AccountView, 'total' | 'buckets'>, c: ComposedView): Record<string, number> {
  const add: Record<string, number> = { own: 0, mom: 0 };
  for (const o of c.orders) for (const p of o.parts) if (p.bucket === 'own' || p.bucket === 'mom') add[p.bucket] += p.amount ?? 0;
  const v = (id: string) => acct.buckets.find((b) => b.id === id)?.value ?? 0;
  const own = v('own') + add.own;
  const mom = v('mom') + add.mom;
  const total = acct.total - (c.withdraw ?? 0);
  return { own: own / total, mom: mom / total, core: (total - own - mom) / total };
}

export interface ChoiceChange {
  item: Pick<ItemView, 'ticker' | 'headline' | 'choices' | 'ruleChoice'>;
  /** 改之前、改之後的選項 id。 */
  from: string;
  to: string;
  /** 引擎照改之前、改之後的選擇各算一次的清單。 */
  before: ComposedView;
  after: ComposedView;
  /** 有給才檢查「比例有沒有超出預算」。 */
  account?: Pick<AccountView, 'total' | 'buckets'> | null;
}

/**
 * 改了一個選項之後，史萊姆說的那句話：只講這個選項造成的結果。
 * 例：「ORCL 這次不賣。右邊少了 2 張單（VOO 也不用買了），做完現金約 −$1,057（會是負的），要先補錢或改別張。」
 */
export function choiceEffect(ch: ChoiceChange): Bubble {
  const { item, before, after } = ch;
  const toC = item.choices.find((c) => c.id === ch.to);
  const fromC = item.choices.find((c) => c.id === ch.from);
  const name = item.ticker ?? item.headline;
  const k = `${name}：${shortLabel(toC?.label ?? ch.to)}`;
  const say: Seg[] = [];

  // 1. 這個選項本身做什麼
  if (ch.to === 'SKIP') {
    const was = fromC ? fromC.lines.filter((l) => !item.ticker || l.ticker === item.ticker).reduce((a, l) => a + l.shares, 0) : 0;
    say.push(`${name} 這次`, em(`不${was < 0 ? '賣' : was > 0 ? '買' : '做'}`), '。');
  } else if (toC) {
    const mine = toC.lines.filter((l) => !item.ticker || l.ticker === item.ticker);
    const n = mine.reduce((a, l) => a + l.shares, 0);
    const what = item.ticker && mine.length ? `${verb(n)} ${item.ticker} ${Math.abs(n)} 股` : toC.text;
    say.push(ch.to === 'AI' ? '照 AI：' : '', em(what), '。');
  }

  // 2. 右邊的單差幾張；其他檔被連帶改到的
  const rest: Seg[][] = [];
  const diff = orderCount(after) - orderCount(before);
  const others = [...new Set([...before.orders, ...after.orders].map((o) => o.ticker))].filter((t) => t !== item.ticker);
  const gone = others.filter((t) => sharesOf(before, t) !== 0 && sharesOf(after, t) === 0);
  const added = others.filter((t) => sharesOf(before, t) === 0 && sharesOf(after, t) !== 0);
  const changed = others.filter((t) => sharesOf(before, t) !== 0 && sharesOf(after, t) !== 0 && sharesOf(before, t) !== sharesOf(after, t));
  const shift = (t: string) => `${t} 從${orderPhrase(sharesOf(before, t))}變成${orderPhrase(sharesOf(after, t))}`;
  if (diff !== 0) {
    const side: string[] = [];
    if (gone.length) side.push(`${gone.slice(0, 2).join('、')} 也不用${verb(sharesOf(before, gone[0]))}了`);
    if (added.length) side.push(`多了 ${added.slice(0, 2).map((t) => `${t} ${orderPhrase(sharesOf(after, t))}`).join('、')}`);
    if (changed.length && side.length < 2) side.push(shift(changed[0]));
    rest.push([`右邊${diff < 0 ? '少' : '多'}了 ${Math.abs(diff)} 張單`, side.length ? `（${side.join('；')}）` : '']);
  } else if (changed.length || gone.length || added.length) {
    rest.push([shift(changed[0] ?? gone[0] ?? added[0])]);
  } else if (ch.to !== ch.from) {
    rest.push(['右邊的單沒有變']);
  }

  // 3. 做完的現金
  const negAfter = after.cashAfter < NEG_CASH;
  const negBefore = before.cashAfter < NEG_CASH;
  if (negAfter) rest.push(['做完現金約 ', neg(money(after.cashAfter)), '（會是負的），要先補錢或改別張']);
  else if (negBefore) rest.push(['做完現金約 ', em(money(after.cashAfter)), '，回到正的了']);
  else rest.push(['做完現金約 ', em(money(after.cashAfter))]);

  // 4. 比例有沒有因為這個選項超出預算
  let over = false;
  if (ch.account) {
    const b0 = bucketsAfter(ch.account, before);
    const b1 = bucketsAfter(ch.account, after);
    for (const b of ch.account.buckets) {
      if (b.id === 'core') continue;
      if (b1[b.id] > b.budget + OVER_BUDGET && b1[b.id] > b0[b.id] + 0.0005) {
        rest.push([`${b.name}會占 `, neg(pct0(b1[b.id])), `，超過預算 ${pct0(b.budget)}`]);
        over = true;
        break;
      }
    }
  }

  rest.forEach((r, i) => say.push(...(i ? ['，'] : []), ...r));
  say.push('。');
  const mood: Bubble['mood'] = negAfter || over ? 'worry' : ch.to === item.ruleChoice ? 'happy' : 'watch';
  return { k, say: tidy(say), mood };
}

/** 合併相鄰的字串、去掉空字串。 */
function tidy(xs: Seg[]): Seg[] {
  const out: Seg[] = [];
  for (const x of xs) {
    if (x === '') continue;
    const last = out[out.length - 1];
    if (typeof x === 'string' && typeof last === 'string') out[out.length - 1] = last + x;
    else out.push(x);
  }
  return out;
}

/** 純文字（測試和螢幕閱讀器用）。 */
export const plain = (b: Bubble): string => b.say.map((s) => (typeof s === 'string' ? s : s.t)).join('');

function listOrders(c: ComposedView, side: -1 | 1): string {
  const xs = c.orders.filter((o) => !o.transfer && Math.sign(o.shares) === side);
  if (!xs.length) return '';
  if (xs.length > 3) return `${side < 0 ? '賣' : '買'} ${xs.length} 檔`;
  return `${side < 0 ? '賣' : '買'} ${xs.map((o) => `${o.ticker} ${Math.abs(o.shares)} 股`).join('、')}`;
}

/** 待辦頁：照建議做完的話會怎樣；沒有清單的待辦，就說要做什麼。 */
export function todoBubble(todo: TodoView[], plan: { composed: ComposedView | null; items: Pick<ItemView, 'ticker' | 'headline' | 'kind' | 'choice' | 'cancelled' | 'label'>[] } | null): Bubble {
  const t = todo[0];
  if (!t) return { k: '現在', say: ['不用動。有新的月報或通知，會出現在這裡。'], mood: 'idle' };
  const more = todo.length > 1 ? `另外還有 ${todo.length - 1} 件。` : '';
  if (t.type === 'DECIDE' && plan?.composed) {
    const c = plan.composed;
    const n = orderCount(c);
    const sells = listOrders(c, -1);
    const buys = listOrders(c, 1);
    const say: Seg[] = [];
    if (n) say.push([sells, buys].filter(Boolean).join('，'), '，共 ', em(`${n} 張單`));
    else say.push(em('不用下任何單'));
    say.push('，做完現金約 ', c.cashAfter < NEG_CASH ? neg(money(c.cashAfter)) : em(money(c.cashAfter)), '。');
    const off = plan.items.filter((i) => !i.cancelled && i.choice === 'SKIP' && (i.kind === 'AI_ONLY' || i.kind === 'HARD'));
    if (off.length) say.push(`${off.map((i) => i.ticker ?? i.headline).join('、')} 的 AI 建議預設不做。`);
    if (more) say.push(more);
    return { k: '照建議做完的話', say: tidy(say), mood: 'alert' };
  }
  if (t.type === 'TRADE') {
    const n = t.lines.length;
    return { k: '等你下單', say: tidy([`到券商下這 `, em(`${n} 張單`), '，下完回來填快照。', more]), mood: 'alert' };
  }
  if (t.type === 'ANSWER') return { k: '要你回答', say: tidy([em(t.title), '。回答之前，月報會先暫停。', more]), mood: 'alert' };
  return { k: '提醒', say: tidy([em(t.title), '。', more]), mood: 'alert' };
}

/** 帳戶頁：現在的狀況。 */
export function accountBubble(a: Pick<AccountView, 'buckets' | 'holdings' | 'cash' | 'status'>): Bubble {
  const say: Seg[] = [];
  const off = a.buckets.filter((b) => Math.abs(b.pct - b.budget) > OVER_BUDGET);
  if (!off.length) say.push('三桶都在預算附近。');
  else say.push(...off.slice(0, 2).flatMap((b, i) => [i ? '；' : '', `${b.name}占 `, em(pct0(b.pct)), `，預算 ${pct0(b.budget)}`]), '。');
  const alerts = a.holdings.filter((h) => h.tone === 'alert');
  if (alerts.length) {
    const phrase = (h: (typeof alerts)[number]) => (h.state.startsWith('排名') ? h.detail : h.state);
    alerts.slice(0, 2).forEach((h, i) => say.push(i ? '；' : '', em(h.ticker), ` ${phrase(h)}`));
    if (alerts.length > 2) say.push(`，還有 ${alerts.length - 2} 檔`);
    say.push('。');
  } else say.push('沒有持股碰到規則的門檻。');
  const crash = a.status.find((s) => s.label === '崩盤規則');
  if (crash && crash.value !== '未啟動') say.push('崩盤規則', neg('啟動中'), '。');
  if (a.cash < NEG_CASH) say.push('帳上現金是 ', neg(money(a.cash)), '。');
  return { k: '現在的狀況', say: tidy(say), mood: alerts.length ? 'alert' : 'watch' };
}
