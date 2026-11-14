// AI 紀錄（T9）：一次 AI 執行一頁。結論與票數 → 前提逐條 → 每一票（引用逐條標出通過或被刪掉、條件是自動還是人工）
// → 程式算好的數字 → 過程 → 證據包原文。右邊是執行資訊與「匯出給 AI」。
import { api } from './api.js';
import { actionText, day, h, toast } from './dom.js';
import { glass, page } from './layout.js';
import { aiBlock, chevron } from './parts.js';

const ORIGIN = { USER: '你寫的', AI_DRAFT_ACCEPTED: 'AI 草擬、你勾選的', SYSTEM_DEFAULT: '系統預設' };
const TONE = { AGREED: 'ok', INSUFFICIENT: 'warn', SPLIT: 'warn', INVALID: 'hot', DATA_MISSING: 'warn', TIMEOUT: 'hot', NO_RESULT: 'hot', PENDING: 'now' };

const dl = (rows) => h('dl', { class: 'facts' }, rows.map(([k, v, note]) => [h('dt', null, k), h('dd', null, v, note ? h('small', null, note) : null)]));
const paras = (text) => String(text ?? '').split(/\n\s*\n/).map((p) => h('p', { style: 'margin-top:8px;white-space:pre-wrap' }, p.trim()));
const details = (title, body, open = false) => h('details', { class: 'more', open }, h('summary', null, title), h('div', { class: 'more-body' }, body));

function bubbleOf(d) {
  if (d.status === 'PENDING') return { k: 'AI 還在想', say: ['雲端排程還沒送回結果。', '回來之前照規則。'], mood: 'watch' };
  if (d.status === 'AGREED' && !d.followRule) return { k: 'AI 的建議', say: [`${d.samplesWanted} 票一致：`, { t: d.verdict, tone: 'em' }, '。會列在通知或月報上，由你決定。'], mood: 'alert' };
  if (d.status === 'AGREED') return { k: 'AI 的意見', say: [`${d.samplesWanted} 票一致：`, { t: d.verdict, tone: 'em' }, '。這個功能只說明、不改變下單。'], mood: 'watch' };
  return { k: '照規則', say: [d.reason], mood: 'worry' };
}

function sampleBlock(s, d) {
  const head = h(
    'span',
    { class: 'fold-title', style: 'display:inline-flex;flex-wrap:wrap;align-items:center;gap:6px 12px' },
    h('span', null, actionText(`第 ${s.index + 1} 票：${s.verdict}`)),
    !s.valid ? h('span', { class: 'chip hot' }, '格式不合格') : s.downgraded ? h('span', { class: 'chip warn' }, `原本是「${s.rawVerdict}」，證據不夠而降級`) : null,
    s.model ? h('span', { class: 'faint small' }, s.model) : null,
  );
  const body = h(
    'div',
    { class: 'stackv', style: 'gap:14px' },
    s.issues.length ? h('div', null, h('h5', null, '程式檢查發現'), h('ul', { class: 'small', style: 'padding-left:18px' }, s.issues.map((x) => h('li', null, x)))) : null,
    s.abstainReason ? h('p', { class: 'small' }, '證據不足的理由：' + s.abstainReason) : null,
    s.report ? h('div', null, h('h5', null, '報告'), paras(s.report)) : null,
    s.evidence.length
      ? h(
          'div',
          null,
          h('h5', null, `引用（${s.evidence.filter((e) => e.ok).length}／${s.evidence.length} 條通過檢查）`),
          s.evidence.map((e) =>
            h(
              'blockquote',
              { class: 'quote', style: e.ok ? null : 'opacity:.6;text-decoration:line-through' },
              h('span', { class: 'st ' + (e.ok ? 'HOLDS' : 'BROKEN'), style: 'margin-right:8px;text-decoration:none' }, e.ok ? '通過' : '刪掉'),
              `「${e.quote}」`,
              h('cite', { style: 'text-decoration:none' }, `${e.id} · ${docTitle(d, e.source)}，${e.date} → ${e.claim}${e.ok ? '' : `（${e.why}）`}`),
            ),
          ),
        )
      : null,
    s.conditions.length
      ? h(
          'div',
          null,
          h('h5', null, 'AI 寫下的條件'),
          h('table', { class: 'plain' }, h('tbody', null, s.conditions.map((c) => h('tr', null, h('td', null, c.text), h('td', null, c.auto ? h('span', { class: 'chip ok' }, '自動追蹤') : h('span', { class: 'chip warn', title: c.why ?? '' }, '人工')), h('td', { class: 'small faint' }, c.why ?? ''))))),
        )
      : null,
  );
  return h('details', { class: 'fold', open: s.index === 0 }, h('summary', null, head, chevron()), h('div', { class: 'fold-body' }, body));
}

const docTitle = (d, source) => d.documents.find((x) => x.source === source)?.title ?? source;

export async function aiRunPage(ctx, id) {
  const d = await api.get('/ai/run/' + encodeURIComponent(id));
  const back = { href: '#/history', label: '紀錄' };
  if (d.note) {
    // 示範資料：腳本裡的假說明，沒有完整的證據包
    return page({
      view: 'page',
      banner: { back, kicker: `${d.label} · ${day(d.date)}`, title: actionText(`${d.ticker ? d.ticker + '：' : ''}${d.verdict}`), sub: '示範資料：AI 的內容是假的，只有說明，沒有完整的證據包與每一票。', bubble: { k: '示範', say: ['真的系統這一頁會有證據包、每一票、每一條引用的檢查結果。'], mood: 'idle' } },
      pane: h('div', { class: 'stackv' }, glass('pad', aiBlock(d.note))),
    });
  }
  const rail = h(
    'div',
    { class: 'stackv' },
    glass(
      'pad',
      h('h2', { class: 'panel-h' }, '拿去問 AI'),
      h('p', { class: 'small dim' }, '匯出一個 md 檔：背景、這次的完整報告、證據包，還有寫好的 prompt（請另一個 AI 當反方審查）。上傳到 claude.ai 就能問。'),
      h(
        'div',
        { class: 'btn-row', style: 'margin-top:12px' },
        h(
          'button',
          {
            class: 'btn primary',
            type: 'button',
            onclick: async (e) => {
              e.currentTarget.disabled = true;
              try {
                await api.download(`/ai/run/${encodeURIComponent(d.id)}/md`, `${d.id}.md`);
              } catch (err) {
                toast(err.message);
              }
              e.currentTarget.disabled = false;
            },
          },
          '匯出給 AI（md）',
        ),
      ),
    ),
    glass('pad', h('h2', { class: 'panel-h' }, '這次執行'), dl(d.meta.map((m) => [m.label, h('span', { class: 'num', style: 'word-break:break-all' }, m.value)]))),
  );
  return page({
    view: 'page',
    banner: { back, kicker: `${d.label} · 決策日 ${day(d.date)}`, title: actionText(`${d.ticker ? d.ticker + '：' : ''}${d.verdict}`), sub: [h('span', { class: 'chip ' + (TONE[d.status] ?? '') }, d.statusLabel), d.followRule ? ' 照規則，AI 的意見只記錄。' : ' AI 的建議可以採用，由你決定。'], bubble: bubbleOf(d) },
    pane: h(
      'div',
      { class: 'stackv' },
      glass(
        'pad',
        h('h2', { class: 'panel-h' }, '結論'),
        h('p', null, d.reason),
        h('div', { style: 'display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:10px' }, d.votes.map((v) => h('span', { class: 'chip' }, `${v.text} ${v.n} 票`)), h('span', { class: 'faint small' }, `（要 ${d.samplesWanted} 票）`)),
        h('div', { style: 'margin-top:14px' }, dl([['問 AI 的問題', d.question], ['規則這次的動作', d.rule]])),
      ),
      d.premises.length
        ? glass(
            'pad',
            h('h2', { class: 'panel-h' }, '前提逐條'),
            h(
              'ul',
              { class: 'prem' },
              d.premises.map((p) =>
                h(
                  'li',
                  null,
                  h('span', { class: 'faint num' }, p.id),
                  h('span', null, p.text, p.origin ? h('span', { class: 'faint' }, `（${ORIGIN[p.origin] ?? p.origin}）`) : null),
                  h('small', null, p.votes.length ? p.votes.map((v) => [h('span', { class: 'st ' + v.status, style: 'margin-right:6px' }, `第 ${v.index + 1} 票 ${v.label}${v.downgraded ? '（引用被刪）' : ''}`)]) : '沒有判斷'),
                ),
              ),
            ),
          )
        : null,
      d.samples.length ? [h('h2', { class: 'sec', style: 'margin:8px 0 0' }, '每一票'), ...d.samples.map((s) => sampleBlock(s, d))] : glass('empty', h('p', { class: 'dim' }, d.status === 'PENDING' ? '還沒有結果。' : '沒有任何一票：' + d.reason)),
      d.followUp.length ? glass('pad', h('h2', { class: 'panel-h' }, '之後的實際結果'), dl(d.followUp.map((f) => [f.label, f.text]))) : null,
      d.facts.length ? details('程式算好的數字（AI 只能用這些）', dl(d.facts.map((f) => [`${f.id} ${f.label}`, h('span', { class: 'num' }, f.value), f.note]))) : null,
      d.process.length ? details('討論過程（每個角色的完整輸出）', d.process.map((p) => h('div', null, h('h5', null, p.role + (p.model ? `（${p.model}）` : '')), paras(p.text)))) : null,
      d.documents.length
        ? details(
            `證據包原文（${d.documents.length} 份）`,
            d.documents.map((x) =>
              h(
                'div',
                null,
                h('h5', null, `${x.title}（${day(x.date)}）`),
                h('p', { class: 'small faint' }, x.source, x.url ? [' · ', h('a', { href: x.url, target: '_blank', rel: 'noopener noreferrer' }, '原始網址')] : null, ` · ${x.chars.toLocaleString('en-US')} 字`),
                h('pre', { class: 'small', style: 'white-space:pre-wrap;max-height:18em;overflow:auto;margin-top:6px' }, x.preview + (x.chars > x.preview.length ? '\n…（完整原文在匯出的 md 裡）' : '')),
              ),
            ),
          )
        : null,
    ),
    rail,
  });
}

/** 紀錄區的「AI 紀錄」分頁。 */
export function runRow(r) {
  return h('a', { class: 'rowlink', href: `#/ai/${encodeURIComponent(r.id)}` }, h('span', { class: 'd num' }, day(r.date)), h('span', null, actionText(`${r.label}${r.ticker ? ' ' + r.ticker : ''}：${r.verdict}`)), h('span', { class: 'chip ' + (TONE[r.status] ?? '') }, r.fake ? '示範' : r.statusLabel), h('span', { class: 's' }, r.summary));
}

const money = (x) => (x > 0 ? '+$' : x < 0 ? '−$' : '$') + Math.abs(Math.round(x)).toLocaleString('en-US');

/** 「沒照規則做的」上面的三條線比較。 */
export function shadowLines(sum) {
  if (!sum || !sum.rows.length) return null;
  const cell = (v, n) => (n ? h('span', { class: 'num', style: `color:${v > 0 ? 'var(--core)' : v < 0 ? 'var(--hot)' : 'inherit'}` }, money(v)) : h('span', { class: 'faint' }, '—'));
  return h(
    'div',
    { style: 'margin-bottom:14px' },
    glass(
      'scroll-x',
      h(
        'table',
        { class: 'plain' },
        h('thead', null, h('tr', null, ['觀察期', '照規則 − 你實際', '照 AI − 你實際', '算進來', '還沒到'].map((x) => h('th', null, x)))),
        h('tbody', null, sum.lines.map((l) => h('tr', null, h('td', null, l.label), h('td', null, cell(l.rule, l.nRule)), h('td', null, cell(l.ai, l.nAi)), h('td', { class: 'num' }, `${l.nRule} 筆`), h('td', { class: 'num faint' }, `${l.pending} 筆`)))),
      ),
    ),
    h('p', { class: 'small faint', style: 'margin-top:8px' }, `正數＝照規則（或照 AI）會比你實際做的多賺；負數＝你的決定比較好。每一筆只算那次的股數差，從當天收盤拿到觀察期結束（含股利），不算之後規則又做了什麼。價格到 ${day(sum.asOf)}。`),
  );
}

