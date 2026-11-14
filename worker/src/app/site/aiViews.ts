// 網站的 AI 紀錄（T9；design_v2 §6.6）：每一次 AI 執行一頁（輸入、每一票、檢查、結論、過程），「匯出 md 拿去問 AI」，
// 以及把 AI 紀錄轉成建議單上的 AI 說明（AiNote）。
import type { CheckedSample, Outcome } from '../../ai/check';
import { fnInfo, verdictText } from '../../ai/functions';
import type { AiRun } from '../aiRuns';
import type { AiNote } from './types';

export const OUTCOME_LABEL: Record<Outcome['status'] | 'PENDING', string> = {
  PENDING: '等結果中',
  AGREED: '票數一致',
  INSUFFICIENT: '證據不足',
  SPLIT: '票數不一致',
  INVALID: '格式不合格',
  DATA_MISSING: '資料有缺漏',
  TIMEOUT: '逾時',
  NO_RESULT: '沒有結果',
};

const PREMISE_LABEL: Record<string, string> = { HOLDS: '成立', BROKEN: '不成立', INSUFFICIENT: '證據不足' };

export interface RunRow {
  id: string;
  date: string;
  label: string;
  ticker: string | null;
  verdict: string;
  status: keyof typeof OUTCOME_LABEL;
  statusLabel: string;
  /** 照規則（AI 的意見只記錄）。 */
  followRule: boolean;
  summary: string;
  fake: boolean;
}

export interface RunDetail extends RunRow {
  fn: string;
  question: string;
  rule: string;
  reason: string;
  actionable: boolean;
  votes: { verdict: string; text: string; n: number }[];
  samplesWanted: number;
  facts: { id: string; label: string; value: string; note?: string }[];
  premises: { id: string; text: string; origin: string | null; votes: { index: number; status: string; label: string; downgraded: boolean; evidence: string[] }[] }[];
  samples: {
    index: number;
    valid: boolean;
    verdict: string;
    rawVerdict: string | null;
    downgraded: boolean;
    model: string | null;
    issues: string[];
    abstainReason: string | null;
    report: string | null;
    evidence: { id: string; source: string; date: string; quote: string; claim: string; ok: boolean; why: string | null }[];
    conditions: { text: string; type: string | null; auto: boolean; why: string | null }[];
  }[];
  documents: { source: string; kind: string; title: string; date: string; url: string | null; chars: number; preview: string }[];
  process: { role: string; model: string | null; text: string }[];
  meta: { label: string; value: string }[];
  followUp: { label: string; text: string }[];
}

function summaryOf(run: AiRun): string {
  const o = run.outcome;
  if (!o) return '雲端排程還在跑，結果回來之前照規則。';
  const first = pick(o)?.report?.split(/\n\s*\n/)[0]?.trim();
  return first ? first.slice(0, 240) : o.reason;
}

/** 代表這次結論的那一票：和結論一致的第一票，沒有就第一張合格的票。 */
function pick(o: Outcome): CheckedSample | undefined {
  return o.samples.find((s) => s.valid && s.verdict === o.verdict) ?? o.samples.find((s) => s.valid);
}

export function runRow(run: AiRun): RunRow {
  const o = run.outcome;
  const status = o?.status ?? 'PENDING';
  return {
    id: run.runId,
    date: run.asOf,
    label: fnInfo(run.fn).label,
    ticker: run.ticker,
    // 沒有一致的結論時，標題寫「照規則」，最多票的判斷只放在票數裡（避免被看成 AI 的結論）
    verdict: !o ? '等結果中' : o.status === 'AGREED' ? verdictText(run.fn, o.verdict) : '照規則',
    status,
    statusLabel: OUTCOME_LABEL[status],
    followRule: o ? o.followRule : true,
    summary: summaryOf(run),
    fake: false,
  };
}

const conditionText = (raw: Record<string, unknown>): string => {
  const t = typeof raw.text === 'string' ? raw.text : '';
  if (t) return t;
  return JSON.stringify(raw).slice(0, 200);
};

/** 說明裡的判斷代碼換成白話（例如 STANDARD → 回到標準）。 */
function plainVerdicts(fn: string, text: string): string {
  let out = text;
  for (const [code, label] of Object.entries(fnInfo(fn).verdicts).sort((a, b) => b[0].length - a[0].length)) out = out.replace(new RegExp(`\\b${code}\\b`, 'g'), label);
  return out;
}

export function runDetail(run: AiRun, followUp: Record<string, { ret: number; bench: number; excess: number } | null> | null = null): RunDetail {
  const o = run.outcome;
  const pack = run.pack;
  const pc = (x: number) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1)}%`;
  const models = [...new Set([...(o?.samples.map((s) => s.model) ?? []), ...run.process.map((p) => p.model)].filter((m): m is string => !!m))];
  return {
    ...runRow(run),
    fn: run.fn,
    question: pack.question,
    rule: pack.rule.action,
    reason: plainVerdicts(run.fn, o?.reason ?? '雲端排程還在跑；結果回來之前照規則。'),
    actionable: o?.actionable ?? false,
    votes: Object.entries(o?.votes ?? {}).map(([v, n]) => ({ verdict: v, text: verdictText(run.fn, v), n })),
    samplesWanted: pack.policy.samples,
    facts: pack.facts,
    premises: pack.premises.map((p) => ({
      id: p.id,
      text: p.text,
      origin: p.origin ?? null,
      votes: (o?.samples ?? []).flatMap((s) => {
        const c = s.premises.find((x) => x.premise_id === p.id);
        return c ? [{ index: s.index, status: c.status, label: PREMISE_LABEL[c.status], downgraded: !!c.downgradedFrom, evidence: c.evidence_ids }] : [];
      }),
    })),
    samples: (o?.samples ?? []).map((s) => ({
      index: s.index,
      valid: s.valid,
      verdict: verdictText(run.fn, s.verdict),
      rawVerdict: s.rawVerdict === null ? null : verdictText(run.fn, s.rawVerdict),
      downgraded: s.valid && s.rawVerdict !== s.verdict,
      model: s.model,
      issues: s.issues,
      abstainReason: s.abstainReason,
      report: s.report,
      evidence: s.evidence.map((e) => ({ id: e.id, source: e.source_id, date: e.date, quote: e.quote, claim: e.claim, ok: e.ok, why: e.why ?? null })),
      conditions: s.conditions.map((c) => ({ text: conditionText(c.raw), type: c.type, auto: c.auto, why: c.why ?? null })),
    })),
    documents: pack.documents.map((d) => ({ source: d.source_id, kind: d.kind, title: d.title, date: d.date, url: d.url ?? null, chars: d.text.length, preview: d.text.slice(0, 1500) })),
    process: run.process.map((p) => ({ role: p.role, model: p.model ?? null, text: p.text })),
    meta: [
      { label: '決策日', value: run.asOf },
      { label: '建立', value: run.createdAt.replace('T', ' ').slice(0, 16) + ' UTC' },
      { label: '完成', value: run.completedAt ? run.completedAt.replace('T', ' ').slice(0, 16) + ' UTC' : '—' },
      { label: '模型', value: models.join('、') || '—' },
      { label: 'prompt 版本', value: run.promptVersion },
      { label: '證據包', value: run.packHash.slice(0, 19) + '…' },
      { label: '執行編號', value: run.runId },
      ...(run.packNotes.length ? [{ label: '組裝證據包時', value: run.packNotes.join('；') }] : []),
    ],
    followUp: followUp
      ? [
          ['1m', '1 個月後'],
          ['3m', '3 個月後'],
          ['6m', '6 個月後'],
        ].map(([k, label]) => {
          const f = followUp[k];
          return { label, text: f ? `${run.ticker} ${pc(f.ret)}，基準 ${pc(f.bench)}，相對 ${pc(f.excess)}` : '還沒到' };
        })
      : [],
  };
}

const CONDITION_KIND = (type: string | null): '財報' | '事件' | '價格' => (type?.startsWith('xbrl') ? '財報' : type?.startsWith('price') || type?.startsWith('ma_') ? '價格' : '事件');

/** AI 紀錄 → 建議單上的 AI 說明（只用有結論的；逾時、格式不合格的不顯示成 AI 意見）。 */
export function noteOfRun(run: AiRun): AiNote | null {
  const info = fnInfo(run.fn);
  const o = run.outcome;
  if (!info.note || !o || o.status === 'TIMEOUT' || o.status === 'NO_RESULT' || o.status === 'INVALID') return null;
  const s = pick(o);
  const voteText = o.status === 'AGREED' ? `${o.samples.length} 票一致` : Object.entries(o.votes).map(([v, n]) => `${verdictText(run.fn, v)} ${n} 票`).join('、');
  const evidence = new Map((s?.evidence ?? []).filter((e) => e.ok).map((e) => [e.id, e]));
  return {
    kind: info.note,
    ticker: run.ticker ?? undefined,
    date: run.asOf,
    verdict: verdictText(run.fn, o.verdict) + (o.followRule && o.status !== 'AGREED' ? `（${OUTCOME_LABEL[o.status]}，照規則）` : ''),
    votes: voteText,
    summary: summaryOf(run),
    premises: run.pack.premises.map((p) => {
      const c = s?.premises.find((x) => x.premise_id === p.id);
      const ev = c?.evidence_ids.map((id) => evidence.get(id)?.claim).filter(Boolean).join('；');
      return { text: p.text, origin: p.origin === 'USER' || p.origin === 'AI_DRAFT_ACCEPTED' ? p.origin : 'SYSTEM_DEFAULT', status: c?.status ?? 'INSUFFICIENT', ...(ev ? { evidence: ev } : {}) };
    }),
    quotes: [...evidence.values()].map((e) => ({ source: run.pack.documents.find((d) => d.source_id === e.source_id)?.title ?? e.source_id, date: e.date, quote: e.quote })),
    conditions: (s?.conditions ?? [])
      .filter((c) => c.auto && c.from === 'payload.conditions')
      .map((c) => ({ kind: CONDITION_KIND(c.type), text: conditionText(c.raw), then: typeof c.raw.tier_if_met === 'string' ? `建議${verdictText('OWN_REVIEW', c.raw.tier_if_met)}` : '重新審查' })),
    sections: run.process.map((p) => ({ title: p.role, text: p.text })),
    fake: false,
  };
}

/** 示範模式：腳本裡的假 AI 說明 → 紀錄列（只有列表，沒有完整的證據包）。 */
export function rowOfNote(n: AiNote, k: number): RunRow {
  const label = { REVIEW: '自選定期審查', VETO: '動能新股進場審查', CONDITION: '自選條件監測', CRASH: '崩盤規則檢視', HARD: '持股硬事件' }[n.kind];
  return { id: `demo-${k}`, date: n.date, label, ticker: n.ticker ?? null, verdict: n.verdict, status: 'AGREED', statusLabel: n.votes ?? '', followRule: false, summary: n.summary, fake: true };
}

// ---------------------------------------------------------------- 匯出 md

export interface ExportContext {
  /** 帳戶分桶比例等背景（一兩行）。 */
  background: string[];
  ruleText?: string;
}

/** 「匯出給 AI」：背景＋這次的完整報告＋寫好的 prompt，一個 md 檔（design_v2 §6.6）。 */
export function exportMd(run: AiRun, ctx: ExportContext): string {
  const d = runDetail(run);
  const info = fnInfo(run.fn);
  const L: string[] = [];
  L.push(`# ${info.label}${run.ticker ? `：${run.ticker}` : ''}（${run.asOf}）`, '');
  L.push('## 請你做的事', '', info.askPrompt, '');
  L.push('## 背景', '', ...ctx.background.map((x) => `- ${x}`), `- 這份紀錄是 stock bot 的 AI 層產生的。AI 只能讀程式準備好的證據包（下面「證據包」一節），所有數字由程式算好；引用必須是原文的子字串，不合格的會被程式刪掉。`, '');
  if (ctx.ruleText) L.push(`規則：${ctx.ruleText}`, '');
  L.push('## 問題與規則的動作', '', `- 問 AI 的問題：${d.question}`, `- 規則這次的動作：${d.rule}`, '');
  L.push('## 結論', '', `- ${d.statusLabel}：${d.verdict}`, `- 票數：${d.votes.map((v) => `${v.text} ${v.n}`).join('、') || '—'}（要 ${d.samplesWanted} 票）`, `- ${d.reason}`, `- ${d.followRule ? '照規則（AI 的意見只記錄）' : 'AI 的建議可以採用（由你決定）'}`, '');
  if (d.facts.length) L.push('## 程式算好的數字', '', '| 編號 | 項目 | 數值 | 說明 |', '|---|---|---|---|', ...d.facts.map((f) => `| ${f.id} | ${f.label} | ${f.value} | ${f.note ?? ''} |`), '');
  if (d.premises.length) {
    L.push('## 前提逐條', '');
    for (const p of d.premises) L.push(`- **${p.id}** ${p.text}：${p.votes.map((v) => `第 ${v.index + 1} 票 ${v.label}${v.downgraded ? '（引用被刪，改成證據不足）' : ''}`).join('；') || '沒有判斷'}`);
    L.push('');
  }
  d.samples.forEach((s) => {
    L.push(`## 第 ${s.index + 1} 票：${s.verdict}${s.downgraded ? `（原本是 ${s.rawVerdict}，證據不夠而降級）` : ''}${s.valid ? '' : '（格式不合格）'}`, '');
    if (s.model) L.push(`模型：${s.model}`, '');
    if (s.issues.length) L.push('程式檢查發現：', ...s.issues.map((x) => `- ${x}`), '');
    if (s.abstainReason) L.push(`證據不足的理由：${s.abstainReason}`, '');
    if (s.evidence.length) {
      L.push('引用：', '');
      for (const e of s.evidence) L.push(`- ${e.ok ? '✓' : '✗'} [${e.id}] ${e.source}（${e.date}）「${e.quote}」→ ${e.claim}${e.ok ? '' : `（被刪掉：${e.why}）`}`);
      L.push('');
    }
    if (s.conditions.length) L.push('條件：', ...s.conditions.map((c) => `- ${c.text}（${c.auto ? '自動追蹤' : `人工：${c.why}`}）`), '');
    if (s.report) L.push('報告：', '', s.report, '');
  });
  if (d.process.length) {
    L.push('## 過程（每個角色的完整輸出）', '');
    for (const p of d.process) L.push(`### ${p.role}${p.model ? `（${p.model}）` : ''}`, '', p.text, '');
  }
  L.push('## 證據包', '');
  for (const doc of run.pack.documents) L.push(`### ${doc.source_id}：${doc.title}（${doc.date}）`, doc.url ? `來源：${doc.url}` : '', '', '```', doc.text.length > 6000 ? doc.text.slice(0, 6000) + '\n…（以下省略，完整原文在網站）' : doc.text, '```', '');
  L.push('---', ...d.meta.map((m) => `${m.label}：${m.value}`));
  return L.filter((x, i, a) => !(x === '' && a[i - 1] === '')).join('\n');
}
