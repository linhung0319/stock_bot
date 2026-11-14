// 史萊姆說的話：改一個選項之後，只講那個選項造成的結果（choiceEffect）；
// 待辦頁（todoBubble）、帳戶頁（accountBubble）的一句話。和真實引擎一起跑的測試在 site.test.ts 情境 ①。
import { describe, expect, it } from 'vitest';
import { accountBubble, choiceEffect, plain, todoBubble, type ChoiceChange } from '../src/app/site/bubble';
import type { AccountView, ComposedView, HoldingView, ItemView, OrderView, TodoView } from '../src/app/site/views';

const order = (ticker: string, shares: number, price: number, bucket = 'mom'): OrderView => ({
  ticker,
  shares,
  transfer: false,
  price,
  amount: shares * price,
  parts: [{ ticker, bucket, bucketName: bucket, shares, amount: shares * price, reason: '' }],
});
const composed = (orders: OrderView[], cashAfter: number): ComposedView => ({ orders, cashBefore: 1500, cashAfter, withdraw: 0, shortOfCash: cashAfter < -1 });

const orcl: ChoiceChange['item'] = {
  ticker: 'ORCL',
  headline: '賣 ORCL 28 股（全部）',
  ruleChoice: 'DO',
  choices: [
    { id: 'DO', label: '照做', text: '賣 28 股', note: '', isDefault: true, lines: [{ ticker: 'ORCL', bucket: 'mom', bucketName: '動能', shares: -28, amount: -5537, reason: '' }] },
    { id: 'SKIP', label: '這次不做', text: '不下單', note: '', isDefault: false, lines: [] },
  ],
};
const full = composed([order('ORCL', -28, 197.75), order('PLTR', -19, 175.37), order('GE', 20, 294.45), order('VOO', 6, 616.5, 'core')], 782);
const noOrcl = composed([order('PLTR', -19, 175.37), order('GE', 20, 294.45)], -1057);

const account = (own: number, mom: number, total = 100_000): Pick<AccountView, 'total' | 'buckets'> => ({
  total,
  buckets: [
    { id: 'own', name: '自選', value: own, pct: own / total, budget: 0.2, who: '' },
    { id: 'mom', name: '動能', value: mom, pct: mom / total, budget: 0.3, who: '' },
    { id: 'core', name: '核心', value: total - own - mom, pct: (total - own - mom) / total, budget: 0.5, who: '' },
  ],
});

describe('choiceEffect：只講剛剛改的那一個選項', () => {
  it('ORCL 這次不做：少了 2 張單、VOO 也不用買了、現金變負的 → 皺眉', () => {
    const b = choiceEffect({ item: orcl, from: 'DO', to: 'SKIP', before: full, after: noOrcl });
    expect(b.k).toBe('ORCL：這次不做');
    expect(plain(b)).toBe('ORCL 這次不賣。右邊少了 2 張單（VOO 也不用買了），做完現金約 −$1,057（會是負的），要先補錢或改別張。');
    expect(b.mood).toBe('worry');
    // 負的現金用紅色、選項本身用亮色
    expect(b.say).toContainEqual({ t: '−$1,057', tone: 'neg' });
    expect(b.say).toContainEqual({ t: '不賣', tone: 'em' });
  });

  it('少了一張單、核心那一行從買變成賣：兩件事都講', () => {
    const sellVoo = composed([order('PLTR', -19, 175.37), order('GE', 20, 294.45), order('VOO', -2, 616.5, 'core')], 177);
    expect(plain(choiceEffect({ item: orcl, from: 'DO', to: 'SKIP', before: full, after: sellVoo }))).toBe('ORCL 這次不賣。右邊少了 1 張單（VOO 從買 6 股變成賣 2 股），做完現金約 $177。');
  });

  it('改回照做：現金回到正的 → 開心', () => {
    const b = choiceEffect({ item: orcl, from: 'SKIP', to: 'DO', before: noOrcl, after: full });
    expect(plain(b)).toBe('賣 ORCL 28 股。右邊多了 2 張單（多了 VOO 買 6 股），做完現金約 $782，回到正的了。');
    expect(b.mood).toBe('happy');
  });

  it('張數一樣、只有核心那一行的股數變了：講出是哪一檔、從幾股變幾股', () => {
    const msft: ChoiceChange['item'] = {
      ticker: 'MSFT',
      headline: '買 MSFT 3 股',
      ruleChoice: 'SKIP',
      choices: [
        { id: 'AI', label: '照 AI：提高到標準的 125%', text: '買 3 股', note: '', isDefault: false, lines: [{ ticker: 'MSFT', bucket: 'own', bucketName: '自選', shares: 3, amount: 1525, reason: '' }] },
        { id: 'SKIP', label: '這次不做', text: '不下單', note: '', isDefault: true, lines: [] },
      ],
    };
    const before = composed([order('ORCL', -28, 197.75), order('VOO', 6, 616.5, 'core')], 782);
    const after = composed([order('ORCL', -28, 197.75), order('MSFT', 3, 508.4, 'own'), order('VOO', 4, 616.5, 'core')], 490);
    const b = choiceEffect({ item: msft, from: 'SKIP', to: 'AI', before, after, account: account(20_000, 30_000) });
    expect(b.k).toBe('MSFT：照 AI');
    expect(plain(b)).toBe('照 AI：買 MSFT 3 股。右邊多了 1 張單（VOO 從買 6 股變成買 4 股），做完現金約 $490。');
    expect(b.mood).toBe('watch');
    const same = composed([order('ORCL', -28, 197.75), order('VOO', 4, 616.5, 'core')], 1300);
    expect(plain(choiceEffect({ item: msft, from: 'AI', to: 'AI', before, after: same }))).toContain('VOO 從買 6 股變成買 4 股');
  });

  it('這個選項讓一桶超出預算超過 5 個百分點：點名哪一桶、會占多少 → 皺眉', () => {
    const big: ChoiceChange['item'] = { ...orcl, ticker: 'NVDA', headline: '買 NVDA 40 股', ruleChoice: 'SKIP', choices: [{ id: 'AI', label: '照 AI', text: '買 40 股', note: '', isDefault: false, lines: [{ ticker: 'NVDA', bucket: 'own', bucketName: '自選', shares: 40, amount: 8000, reason: '' }] }, orcl.choices[1]] };
    const before = composed([], 1500);
    const after = composed([order('NVDA', 40, 200, 'own')], -6500);
    const b = choiceEffect({ item: big, from: 'SKIP', to: 'AI', before, after, account: account(20_000, 30_000) });
    expect(plain(b)).toBe('照 AI：買 NVDA 40 股。右邊多了 1 張單，做完現金約 −$6,500（會是負的），要先補錢或改別張，自選會占 28%，超過預算 20%。');
    expect(b.mood).toBe('worry');
    // 本來就超出預算、這個選項沒有讓它更高：不提
    const sell = composed([order('NVDA', -10, 200, 'own')], 3500);
    expect(plain(choiceEffect({ item: big, from: 'AI', to: 'SKIP', before, after: sell, account: account(30_000, 30_000) }))).not.toContain('預算');
  });
});

describe('待辦頁與帳戶頁的一句話', () => {
  const todo = (type: TodoView['type'], title = '2026-12 月報', lines: TodoView['lines'] = []): TodoView => ({ id: 1, type, kindLabel: '月報', title, date: '2026-12-01', lines, note: null });

  it('沒有待辦：不用動', () => {
    expect(todoBubble([], null)).toMatchObject({ k: '現在', mood: 'idle' });
  });
  it('等你決定：列出賣、買、張數、做完的現金，以及預設不做的 AI 建議', () => {
    const b = todoBubble([todo('DECIDE')], { composed: full, items: [{ ticker: 'MSFT', headline: '買 MSFT 3 股', kind: 'AI_ONLY', choice: 'SKIP', cancelled: false, label: 'AI 建議提高比重' }] as Pick<ItemView, 'ticker' | 'headline' | 'kind' | 'choice' | 'cancelled' | 'label'>[] });
    expect(b.k).toBe('照建議做完的話');
    expect(plain(b)).toBe('賣 ORCL 28 股、PLTR 19 股，買 GE 20 股、VOO 6 股，共 4 張單，做完現金約 $782。MSFT 的 AI 建議預設不做。');
  });
  it('等你下單：張數', () => {
    expect(plain(todoBubble([todo('TRADE', '2026-12 月報', [{ text: '賣 ORCL 28 股', why: '', bucket: '' }, { text: '買 GE 20 股', why: '', bucket: '' }])], null))).toBe('到券商下這 2 張單，下完回來填快照。');
  });
  it('帳戶：三桶和預算、碰到門檻的持股', () => {
    const h = (ticker: string, tone: HoldingView['tone'], state: string, detail: string) => ({ ticker, tone, state, detail }) as HoldingView;
    const a = { ...account(21_538, 33_175, 100_606), cash: 1500, holdings: [h('ORCL', 'alert', '排名第 17', '已掉出前 15 名，下次月報會列出場'), h('MU', 'ok', '正常', '')], status: [{ label: '崩盤規則', value: '未啟動', tone: 'ok' as const, detail: '' }] };
    expect(plain(accountBubble(a))).toBe('三桶都在預算附近。ORCL 已掉出前 15 名，下次月報會列出場。');
    expect(accountBubble(a).mood).toBe('alert');
    const b = { ...account(16_000, 38_175, 100_606), cash: 1500, holdings: [h('MU', 'ok', '正常', '')], status: a.status };
    expect(plain(accountBubble(b))).toBe('動能占 38%，預算 30%。沒有持股碰到規則的門檻。');
  });
});
