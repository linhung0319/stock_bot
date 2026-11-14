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


// ---------------------------------------------------------------- AI 紀錄上方的總覽（T11）

const DECISION = { ALLOW: '准許', ALLOW_WATCH: '准許但觀察', VETO: '否決', BLOCK: '資料可疑，這個月不進場', PENDING: '等法庭' };
const SOURCE = { RULE: '規則', AI: 'AI 法庭', DEFAULT: '照規則（AI 沒有結論）' };
const CODE = { PENDING_MA: '被收購', ACCOUNTING: '會計問題', REGULATORY: '監管或訴訟', EARNINGS_DIVERGENCE: '盈餘背離', ONE_OFF_JUMP: '一次性跳漲', DILUTION: '增資', DATA_SUSPECT: '資料可疑', ALLOW_WATCH: '准許但觀察', ALLOW: '准許', VETO: '否決', INSUFFICIENT: '證據不足', EXIT: '建議出場', HOLD: '不用動' };
/** 網站不顯示代碼：把文字裡的代碼換成白話。 */
const plain = (t) => String(t ?? '').replace(/(PENDING_MA|ACCOUNTING|REGULATORY)_CANDIDATE/g, (_, c) => `${CODE[c]}候選`).replace(/\b(PENDING_MA|ACCOUNTING|REGULATORY|EARNINGS_DIVERGENCE|ONE_OFF_JUMP|DILUTION|DATA_SUSPECT|ALLOW_WATCH|ALLOW|VETO|INSUFFICIENT|EXIT|HOLD)\b/g, (m) => CODE[m]);
const fnum = (x, d = 2) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : x.toFixed(d));

/** 總經儀表板（每月都算）、本月動能新股進場審查、最近的申報事件。真實模式才有內容；載入失敗就不顯示。 */
export function aiOverview() {
  const box = h('div', { class: 'stackv', style: 'margin-bottom:14px' });
  api
    .get('/ai/overview')
    .then((o) => {
      const parts = [];
      if (o.reviews?.length)
        parts.push(
          details(
            `動能新股進場審查（${o.reviews[0].month} 月報）`,
            h('table', { class: 'plain' }, h('tbody', null, o.reviews.map((r) => h('tr', null, h('td', { style: 'white-space:nowrap' }, h('span', { class: 'tk' }, r.ticker), r.rank ? h('div', { class: 'small faint' }, `第 ${r.rank} 名`) : null), h('td', null, h('span', { class: 'chip ' + (r.decision === 'VETO' || r.decision === 'BLOCK' ? 'hot' : r.decision === 'ALLOW_WATCH' ? 'warn' : 'ok') }, DECISION[r.decision] ?? r.decision)), h('td', { class: 'small' }, `${SOURCE[r.source] ?? r.source}${r.reasonCode ? ` · ${CODE[r.reasonCode] ?? r.reasonCode}` : ''}${r.replacedBy ? ` · 由 ${r.replacedBy} 遞補` : ''}`, r.watchReason ? h('div', { class: 'faint' }, '觀察：' + r.watchReason) : null, r.note ? h('div', { class: 'faint' }, plain(r.note)) : null))))),
          ),
        );
      if (o.macro)
        parts.push(
          details(
            `總經儀表板（${day(o.macro.asOf)}，崩盤規則檢視用）`,
            h('div', null,
              h('dl', { class: 'facts' },
                o.macro.rows.map((r) => [
                  h('dt', null, r.label),
                  h('dd', null,
                    h('span', { class: 'num' }, r.value === null ? '抓不到' : fnum(r.value)),
                    r.date ? h('span', { class: 'faint small', style: 'margin-left:8px' }, r.date) : null,
                    h('small', null, [r.change6m === null ? null : `6 個月變化 ${r.change6m >= 0 ? '+' : ''}${fnum(r.change6m)}`, r.derived, Object.values(r.atBears ?? {}).some((v) => v !== null) ? `真空頭開始時 ${Object.values(r.atBears).map((v) => fnum(v)).join('／')}` : null, r.note].filter(Boolean).join('；')),
                  ),
                ]),
                o.macro.breadth ? [h('dt', null, '市場廣度'), h('dd', null, h('span', { class: 'num' }, `${Math.round((o.macro.breadth.above / o.macro.breadth.n) * 100)}%`), h('small', null, `市值前 50 大裡收盤在 200 日均線之上：${o.macro.breadth.above}／${o.macro.breadth.n}`))] : null,
              ),
              h('p', { class: 'small faint', style: 'margin-top:8px' }, '真空頭開始時（2000-10／2002-05／2008-01）的值是現在修正後的數字，不是當時看到的。過去 17 次跌破 200 日均線，3 次是真的空頭。'),
            ),
          ),
        );
      if (o.events?.length)
        parts.push(details('最近的申報事件（規則偵測、每日掃描）', h('table', { class: 'plain' }, h('tbody', null, o.events.map((e) => h('tr', null, h('td', { class: 'num' }, day(e.event_date)), h('td', { class: 'tk' }, e.ticker), h('td', null, `${e.form === 'NEWS' ? '新聞標題' : e.form} · ${CODE[e.code] ?? e.code}`, e.detail ? h('div', { class: 'small faint' }, plain(e.detail)) : null), h('td', { class: 'small' }, e.status === 'HANDLED' && /開法庭 (\S+)/.test(e.handled_note ?? '') ? h('a', { href: `#/ai/${/開法庭 (\S+)/.exec(e.handled_note)[1]}` }, '已開審查') : ({ NEW: '待處理', HANDLED: e.handled_note ?? '已處理', INFO: '只記錄' }[e.status] ?? e.status))))))));
      box.replaceChildren(...parts);
    })
    .catch(() => box.replaceChildren());
  return box;
}

// ---------------------------------------------------------------- 持股頁：監測條件與新增自選健檢（T11，F14／F25）

/** 這檔監測中的條件，與最近一次健檢 AI 改寫的出場條件（勾選後開始監測）。 */
export function ownMonitor(ctx, d) {
  const out = [];
  if (d.monitor?.length)
    out.push(h('h5', { style: 'margin-top:12px' }, '監測中的條件（新申報出來時檢查；價格條件只記錄）'), h('table', { class: 'plain' }, h('tbody', null, d.monitor.map((c) => h('tr', null, h('td', null, c.text, c.note ? h('div', { class: 'small faint' }, c.note) : null), h('td', { class: 'small' }, `${c.kind} · ${c.origin}`), h('td', null, h('span', { class: 'chip ' + (c.status === '已成立' ? 'hot' : c.status === '監測中' ? 'ok' : '') }, c.status)))))));
  const c = d.check;
  if (c && c.mode === 'REWRITE') {
    if (c.status === 'PENDING') out.push(h('p', { class: 'small dim', style: 'margin-top:10px' }, 'AI 正在把你寫的出場條件改寫成可以追蹤的格式，回來之後會出現在這裡。'));
    else if (c.conditions.length) {
      const boxes = c.conditions.map((x) => ({ x, box: h('input', { type: 'checkbox', checked: !x.manual && !c.accepted.includes(x.condId), disabled: c.accepted.includes(x.condId) }) }));
      const msg = h('div');
      out.push(
        h('h5', { style: 'margin-top:12px' }, 'AI 改寫的出場條件（勾選的會開始監測，成立時當天通知）'),
        h('div', null, boxes.map(({ x, box }) => h('label', { style: 'display:block;margin:6px 0' }, box, ' ', x.text, h('span', { class: 'faint small' }, `（${x.then}${c.accepted.includes(x.condId) ? '；已在監測' : ''}）`)))),
        c.summary ? h('p', { class: 'small faint' }, c.summary) : null,
        h(
          'div',
          { class: 'btn-row', style: 'margin-top:8px' },
          h(
            'button',
            {
              class: 'btn',
              type: 'button',
              onclick: async () => {
                try {
                  const ids = boxes.filter((b) => b.box.checked && !b.box.disabled).map((b) => b.x.condId);
                  const r = await api.post('/ops/own-conditions', { ticker: d.ticker, runId: c.runId, ids });
                  toast(`開始監測 ${r.added} 條`);
                  ctx.refresh();
                } catch (e) {
                  msg.replaceChildren(h('p', { class: 'small', style: 'color:var(--hot)' }, e.message));
                }
              },
            },
            '開始監測勾選的條件',
          ),
        ),
        msg,
      );
    }
  }
  return out;
}

/** 新增自選頁：請 AI 草擬前提，等結果（每 15 秒看一次，最多 20 分鐘）。onDrafts(drafts) 收到結果時呼叫。 */
export async function requestDrafts(ticker, lines, onStatus) {
  const r = await api.post('/ops/own-check', { ticker, lines });
  for (let k = 0; k < 80; k++) {
    await new Promise((res) => setTimeout(res, k ? 15000 : 3000));
    const v = await api.get('/ai/own-check/' + encodeURIComponent(r.runId));
    if (v.status === 'DONE') return v;
    onStatus?.(`AI 還在想（${Math.round(((k + 1) * 15) / 60)} 分鐘）…`);
  }
  throw new Error('等太久了，AI 還沒有回來。之後可以到這檔的持股頁看結果。');
}
