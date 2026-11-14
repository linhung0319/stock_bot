// T11：F21 策略檢討提醒的 AI 說明（ai_layer_design F21 卡片；design_v2 §7）。
// 權限 A1、嚴格限制寫法：依前提清單逐條寫「目前證據」，必須同時寫成立與不成立的證據，不得給「停用／繼續」的建議。
// 程式先產生歷史回撤對照（French 動能因子：同等深度的回撤有幾次、多久恢復）。
import type { Fetcher } from '../data/sources';
import { unzipText } from '../data/xlsx';
import type { CheckedSample, EvidencePack, PackDoc, PackPremise } from './check';
import { buildPack } from './pack';

export const STRATEGY_REVIEW = 'STRATEGY_REVIEW';
export const STRATEGY_REVIEW_PROMPT = 'strategy_review_v1';

export const FRENCH_MOM_URL = 'https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/ftp/F-F_Momentum_Factor_CSV.zip';

/** French 動能因子（UMD）每月報酬（%）：CSV 裡第一段 YYYYMM 開頭的列。 */
export function parseFrenchMonthly(csv: string): { month: string; ret: number }[] {
  const out: { month: string; ret: number }[] = [];
  let started = false;
  for (const line of csv.split(/\r?\n/)) {
    const m = /^\s*(\d{6})\s*,\s*(-?[\d.]+)/.exec(line);
    if (m) {
      started = true;
      out.push({ month: `${m[1].slice(0, 4)}-${m[1].slice(4)}`, ret: Number(m[2]) / 100 });
    } else if (started && !line.trim()) break;
  }
  return out;
}

export async function fetchFrenchMomentum(fetcher: Fetcher): Promise<{ month: string; ret: number }[]> {
  const r = await fetcher(FRENCH_MOM_URL, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; stock-bot/1.0)' } });
  if (!r.ok) throw new Error(`French 資料庫 HTTP ${r.status}`);
  const files = await unzipText(new Uint8Array(await r.arrayBuffer()), (n) => /\.csv$/i.test(n));
  const csv = Object.values(files)[0];
  if (!csv) throw new Error('French 資料庫的 zip 裡沒有 CSV');
  return parseFrenchMonthly(csv);
}

export interface DrawdownEpisode {
  start: string;
  trough: string;
  depth: number;
  recovered: string | null;
  months: number | null;
}

/** 動能因子累積報酬的回撤事件（從高點到創新高）。 */
export function drawdownEpisodes(rets: { month: string; ret: number }[]): DrawdownEpisode[] {
  const out: DrawdownEpisode[] = [];
  let w = 1;
  let peak = 1;
  let peakMonth = rets[0]?.month ?? '';
  let cur: DrawdownEpisode | null = null;
  let k0 = 0;
  rets.forEach((r, k) => {
    w *= 1 + r.ret;
    if (w >= peak) {
      if (cur) {
        cur.recovered = r.month;
        cur.months = k - k0;
        out.push(cur);
        cur = null;
      }
      peak = w;
      peakMonth = r.month;
      k0 = k;
      return;
    }
    const dd = w / peak - 1;
    if (!cur) cur = { start: peakMonth, trough: r.month, depth: dd, recovered: null, months: null };
    if (dd < cur.depth) Object.assign(cur, { depth: dd, trough: r.month });
  });
  if (cur) out.push(cur);
  return out;
}

/** 同等深度（或更深）的回撤：次數、恢復月數的中位數。 */
export function historyTable(eps: DrawdownEpisode[], depth: number): { sameDepth: DrawdownEpisode[]; medianRecovery: number | null; text: string } {
  const same = eps.filter((e) => e.depth <= depth);
  const rec = same.map((e) => e.months).filter((x): x is number => x !== null).sort((a, b) => a - b);
  const med = rec.length ? rec[Math.floor((rec.length - 1) / 2)] : null;
  const p = (x: number) => `${(x * 100).toFixed(0)}%`;
  const text = [
    `French momentum factor (UMD, long-short) drawdowns at least as deep as ${p(depth)}: ${same.length} episodes; median months from peak to new high: ${med ?? '-'}.`,
    'Note: UMD is a long-short factor, not "momentum portfolio vs SPY"; it is an approximate historical reference only.',
    'start | trough | depth | recovered | months',
    ...same.map((e) => `${e.start} | ${e.trough} | ${p(e.depth)} | ${e.recovered ?? 'not yet'} | ${e.months ?? '-'}`),
  ].join('\n');
  return { sameDepth: same, medianRecovery: med, text };
}

/** 設計 §5 的前提清單。 */
export const STRATEGY_PREMISES: PackPremise[] = [
  { id: 'P1', text: '動能效應本身仍然有效（沒有因為過度擁擠或市場結構改變而長期失效）', origin: 'SYSTEM_DEFAULT' },
  { id: 'P2', text: '這次落後是正常的長期落後，不是因子失效（歷史上動能曾長期沒有超額報酬）', origin: 'SYSTEM_DEFAULT' },
  { id: 'P3', text: '這次落後不是來自少數極端事件（例如動能崩盤）', origin: 'SYSTEM_DEFAULT' },
];

export interface StrategyInput {
  runId: string;
  asOf: string;
  alert: string;
  relDrawdown: number;
  eventStart: string | null;
  history: PackDoc | null;
  /** 自己的動能部位相對基準的走勢表。 */
  relDoc: PackDoc | null;
  dataQuality: EvidencePack['data_quality'];
  now: Date;
}

export function strategyPack(inp: StrategyInput) {
  return buildPack({
    runId: inp.runId,
    fn: STRATEGY_REVIEW,
    promptVersion: STRATEGY_REVIEW_PROMPT,
    asOf: inp.asOf,
    subject: { name: '策略檢討（動能）' },
    question:
      `${inp.alert}。請依前提清單逐條寫目前的證據：每一條都要同時寫「支持前提成立」與「支持前提不成立」的證據（payload.premise_evidence 的 for 與 against 都要有）。` +
      '不得建議停用或繼續；不要預測未來報酬。理由：落後最深的時候最容易寫出有說服力的放棄理由，而這正是策略檢討要避免的事。',
    policy: { level: 'A1', verdicts: ['DONE', 'INSUFFICIENT'], abstain: 'INSUFFICIENT', min_evidence: 0, samples: 1 },
    rule: { action: '只提醒，不自動停用', detail: { relDrawdown: inp.relDrawdown, eventStart: inp.eventStart } },
    facts: [
      { id: 'S1', label: '動能部位相對基準的回撤', value: `${(inp.relDrawdown * 100).toFixed(1)}%`, note: inp.eventStart ? `事件從 ${inp.eventStart} 開始` : undefined },
    ].map((f) => (f.note === undefined ? { id: f.id, label: f.label, value: f.value } : f)),
    premises: STRATEGY_PREMISES,
    documents: [inp.history, inp.relDoc].filter((d): d is PackDoc => !!d),
    dataQuality: inp.dataQuality,
    now: inp.now,
  });
}

/** 每一條前提都要同時有成立與不成立的證據；報告不能出現停用／繼續的建議（關鍵字檢查，抓明顯的）。 */
export function checkStrategyPayload(s: CheckedSample, pack: EvidencePack): void {
  const ids = new Set(pack.premises.map((p) => p.id));
  const list = Array.isArray(s.payload?.premise_evidence) ? (s.payload!.premise_evidence as Record<string, unknown>[]) : [];
  const seen = new Set<string>();
  for (const x of list) {
    if (!x || typeof x.premise !== 'string' || !ids.has(x.premise) || !Array.isArray(x.for) || !Array.isArray(x.against)) {
      s.issues.push(`premise_evidence 格式不對：${JSON.stringify(x).slice(0, 100)}`);
      continue;
    }
    seen.add(x.premise);
  }
  const missing = [...ids].filter((id) => !seen.has(id));
  if (missing.length) s.issues.push(`前提 ${missing.join('、')} 沒有同時寫成立與不成立的證據`);
  if (s.report && /(建議|應該|最好)(停用|放棄|暫停|關掉|繼續|維持|堅持)/.test(s.report)) {
    s.issues.push('報告裡出現停用或繼續的建議（這個功能不能給建議），這一票改成 INSUFFICIENT');
    s.verdict = 'INSUFFICIENT';
  }
}
