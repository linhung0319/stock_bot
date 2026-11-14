// 證據包產生器（ai_layer_design §2.1）：程式先把資料與數字準備好，LLM 只能讀。
// 這裡是各功能共用的部分：組裝與檢查、價格與規則狀態的數字、價格表（讓 LLM 引用價格時也有原文可以對）。
// 各功能要的申報、XBRL、新聞由各自的產生器準備好再傳進來（T10、T11）。
import { SLOW, annualizedVol, drawdownFromHigh, sma, trailingReturn, type Account, type MarketView } from '../engine';
import { CONDITION_TYPES, type DataQuality, type EvidencePack, type PackDoc, type PackPolicy, type PackPremise } from './check';

/** 一份原文的上限（字元）。太長的只留開頭，並在結尾註明（§8.3：長文件中間的資訊容易漏，應該只給相關的那一節）。 */
export const MAX_DOC_CHARS = 60_000;
/** 整個證據包原文合計的上限。 */
export const MAX_PACK_CHARS = 400_000;

export interface PackInput {
  runId: string;
  fn: string;
  promptVersion: string;
  asOf: string;
  subject?: EvidencePack['subject'];
  question: string;
  policy: PackPolicy;
  rule: EvidencePack['rule'];
  facts?: EvidencePack['facts'];
  premises?: PackPremise[];
  documents?: PackDoc[];
  dataQuality?: Record<string, DataQuality>;
  conditionTypes?: string[];
  now: Date;
}

export interface BuiltPack {
  pack: EvidencePack;
  /** 組裝時拿掉或截短的東西（記在紀錄裡）。 */
  notes: string[];
}

/** 組裝證據包：決策日之後的原文一律拿掉（不偷看未來），太長的截短，編號不能重複。 */
export function buildPack(inp: PackInput): BuiltPack {
  const notes: string[] = [];
  const docs: PackDoc[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const d of inp.documents ?? []) {
    if (d.date > inp.asOf) {
      notes.push(`拿掉 ${d.source_id}：日期 ${d.date} 在決策日之後`);
      continue;
    }
    if (seen.has(d.source_id) || seen.has(d.id)) {
      notes.push(`拿掉重複的 ${d.source_id}`);
      continue;
    }
    let text = d.text;
    if (text.length > MAX_DOC_CHARS) {
      text = text.slice(0, MAX_DOC_CHARS) + '\n…（以下省略）';
      notes.push(`${d.source_id} 太長，只留前 ${MAX_DOC_CHARS} 字`);
    }
    if (total + text.length > MAX_PACK_CHARS) {
      notes.push(`拿掉 ${d.source_id}：證據包超過 ${MAX_PACK_CHARS} 字`);
      continue;
    }
    total += text.length;
    seen.add(d.source_id);
    seen.add(d.id);
    docs.push({ ...d, text });
  }
  const pol = inp.policy;
  if (!pol.verdicts.includes(pol.abstain)) throw new Error(`policy.abstain（${pol.abstain}）不在 verdicts 裡`);
  if (pol.samples < 1 || pol.samples > 5) throw new Error('policy.samples 要在 1～5 之間');
  return {
    pack: {
      pack_version: 1,
      run_id: inp.runId,
      function: inp.fn,
      prompt_version: inp.promptVersion,
      as_of: inp.asOf,
      created_at: inp.now.toISOString(),
      subject: inp.subject ?? {},
      question: inp.question,
      policy: pol,
      rule: inp.rule,
      facts: inp.facts ?? [],
      premises: inp.premises ?? [],
      documents: docs,
      data_quality: inp.dataQuality ?? {},
      condition_types: inp.conditionTypes ?? [...CONDITION_TYPES],
    },
    notes,
  };
}

/** 執行編號：日期_功能_代號_亂數。 */
export function newRunId(asOf: string, fn: string, ticker?: string): string {
  const b = new Uint8Array(3);
  crypto.getRandomValues(b);
  return [asOf, fn, ticker, [...b].map((x) => x.toString(16).padStart(2, '0')).join('')].filter(Boolean).join('_');
}

const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : '—');
const pc = (x: number) => (Number.isFinite(x) ? (x * 100).toFixed(1) + '%' : '—');

/** 價格與指標的數字（程式算好，LLM 不得自己算，§2.1）。編號 F 開頭。 */
export function priceFacts(view: MarketView, ticker: string, prefix = 'F'): EvidencePack['facts'] {
  const c = view.close[ticker];
  if (!c || !Number.isFinite(c[view.i])) return [];
  const i = view.i;
  let above = 0;
  for (let k = i; k >= 0 && Number.isFinite(sma(c, k, SLOW.maDays)) && c[k] > sma(c, k, SLOW.maDays); k--) above++;
  const ma = sma(c, i, SLOW.maDays);
  const rows: [string, string, string?][] = [
    [`${ticker} 收盤（${view.date}）`, f2(c[i])],
    ['距 52 週高點', pc(drawdownFromHigh(c, i, SLOW.highDays)), '慢規則：跌 20% 減半'],
    ['200 日均線', f2(ma), Number.isFinite(ma) ? `收盤在均線${c[i] > ma ? '之上' : '之下'} ${pc(c[i] / ma - 1)}` : undefined],
    ['連續站上 200 日均線', `${above} 個交易日`, '慢規則：減半後連續 10 天才加回'],
    ['過去 252 個交易日報酬', pc(trailingReturn(c, i, 252))],
    ['過去 63 個交易日報酬', pc(trailingReturn(c, i, 63))],
    ['年化波動度（126 日）', pc(annualizedVol(c, i, 126))],
  ];
  return rows.map(([label, value, note], k) => ({ id: `${prefix}${k + 1}`, label, value, ...(note ? { note } : {}) }));
}

/** 最近幾個交易日的收盤表（一份原文；LLM 引用價格時引用這一份）。 */
export function priceDoc(view: MarketView, axis: string[], ticker: string, days = 60): PackDoc | null {
  const c = view.close[ticker];
  if (!c) return null;
  const lines: string[] = [];
  for (let k = Math.max(0, view.i - days + 1); k <= view.i; k++) if (Number.isFinite(c[k])) lines.push(`${axis[k]} ${ticker} close ${c[k].toFixed(2)}`);
  if (!lines.length) return null;
  return { id: `P-${ticker}`, source_id: `price:${ticker}`, kind: 'price', date: view.date, title: `${ticker} 最近 ${lines.length} 個交易日收盤（還原權值，訊號日等於實際收盤）`, text: lines.join('\n') };
}

/** 帳戶裡這一檔的規則狀態（自選）。編號 R 開頭。 */
export function ownRuleFacts(acct: Account, view: MarketView, ticker: string): EvidencePack['facts'] {
  const meta = acct.own[ticker];
  const st = acct.rule.own[ticker];
  if (!meta || !st) return [];
  const shares = acct.lots.own[ticker] ?? 0;
  const px = view.close[ticker]?.[view.i] ?? NaN;
  let total = acct.cash;
  for (const lots of [acct.lots.own, acct.lots.mom, acct.lots.core, acct.lots.unc]) for (const [t, n] of Object.entries(lots)) total += n * (view.close[t]?.[view.i] ?? 0);
  return [
    { id: 'R1', label: '慢規則狀態', value: st.applied === 'HALF' ? '減半中' : '標準' },
    { id: 'R2', label: '標準比重', value: pc(st.stdWeight) },
    { id: 'R3', label: '目前持有', value: `${shares} 股`, note: Number.isFinite(px) && total > 0 ? `占總資產 ${pc((shares * px) / total)}` : undefined },
    { id: 'R4', label: 'R1（MACD 柱狀體由正轉負等，只記錄）', value: meta.r1 === null ? '—' : meta.r1 ? '成立' : '不成立' },
    ...(meta.aiTier ? [{ id: 'R5', label: '上一次 AI 審查的檔位', value: `${meta.aiTier.tier}（${meta.aiTier.date}）` }] : []),
  ].map((x) => (x.note === undefined ? { id: x.id, label: x.label, value: x.value } : x));
}

/** 自選股的前提（使用者寫的、勾選的 AI 草稿，或系統預設）。 */
export function ownPremises(acct: Account, ticker: string): PackPremise[] {
  return (acct.own[ticker]?.premises ?? []).map((p) => ({ id: p.id, text: p.text, origin: p.origin, ...(p.breaksIf ? { breaksIf: p.breaksIf } : {}) }));
}
