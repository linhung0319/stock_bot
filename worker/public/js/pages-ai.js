// AI 紀錄（T9）：一次 AI 執行一頁。結論與票數 → 前提逐條 → 每一票（引用逐條標出通過或被刪掉、條件是自動還是人工）
// → 程式算好的數字 → 過程 → 證據包原文。右邊是執行資訊與「匯出給 AI」。
import { api } from './api.js';
import { actionText, day, h, toast } from './dom.js';
import { glass, page } from './layout.js';
import { aiBlock, chevron } from './parts.js';

const ORIGIN = { USER: '你寫的', AI_DRAFT_ACCEPTED: 'AI 草擬、你採用的', SYSTEM_DEFAULT: '系統預設' };
const TONE = { AGREED: 'ok', INSUFFICIENT: 'warn', SPLIT: 'warn', INVALID: 'hot', DATA_MISSING: 'warn', TIMEOUT: 'hot', NO_RESULT: 'hot', PENDING: 'now' };

const dl = (rows) => h('dl', { class: 'facts' }, rows.map(([k, v, note]) => [h('dt', null, k), h('dd', null, v, note ? h('small', null, note) : null)]));
const paras = (text) => String(text ?? '').split(/\n\s*\n/).map((p) => h('p', { style: 'margin-top:8px;white-space:pre-wrap' }, p.trim()));
const details = (title, body, open = false) => h('details', { class: 'more', open }, h('summary', null, title), h('div', { class: 'more-body' }, body));

// 出場條件改寫（OWN_CHECK）：結果在持股頁勾選，不會列在通知或月報（T39a）
const REWRITE = 'OWN_CHECK';
const useText = (d) => (d.fn === REWRITE ? '改寫好的出場條件列在持股頁，你勾選了才開始監測；不會列在通知或月報。' : '會列在通知或月報上，由你決定。');

// 市場摘要（MARKET_BRIEF，T65）：一份、只說明大盤與族群，不是對某一檔的建議
const BRIEF = 'MARKET_BRIEF';

function bubbleOf(d) {
  if (d.fn === BRIEF && d.brief?.state === 'READY') return { k: '市場摘要', say: ['大盤與族群為什麼大幅波動，', { t: '報導怎麼說', tone: 'em' }, '。只說明，不改變下單。'], mood: 'watch' };
  if (d.status === 'PENDING') return { k: 'AI 還在想', say: ['雲端排程還沒送回結果。', '回來之前照規則。'], mood: 'watch' };
  if (d.fn === REWRITE && d.status === 'AGREED') return { k: '改寫好了', say: [`${d.ticker ?? ''} 的出場條件`, { t: '改寫好了', tone: 'em' }, `。${useText(d)}`], mood: 'watch' };
  if (d.status === 'AGREED' && !d.followRule) return { k: 'AI 的建議', say: [`${d.samplesWanted} 票一致：`, { t: d.verdict, tone: 'em' }, `。${useText(d)}`], mood: 'alert' };
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

/**
 * 「AI 這次另外找了什麼」（T53，web_evidence_design §1.4、§1.5）：一行結論（沒有要找、取回幾份、想找但取到 0 份分得出來）、
 * 分析師要查的問題與搜尋的字、取回的文件（來源、級別、發布日、抓取日、連結、幾票引用與引用的片段）、沒有讀到的與原因。
 * 不提供整篇全文（著作權）：要看全文點原始網址。
 */
function foundBlock(f) {
  if (!f) return null;
  const about = (x) => (x ? h('span', { class: 'st', style: 'margin-right:8px' }, x) : null);
  const head = (t) => h('h5', { style: 'margin-top:16px' }, t);
  const ext = (url) => (url ? h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, '原始網址') : null);
  return glass(
    'pad',
    h('h2', { class: 'panel-h' }, 'AI 這次另外找了什麼'),
    h('p', { class: f.state === 'ZERO' ? 'notice' : null }, f.line),
    f.notes.map((n) => h('p', { class: 'small', style: 'margin-top:6px;color:var(--warn)' }, n)),
    f.questions.length ? [head(`分析師要查的問題（${f.questions.length} 個）`), h('ul', { class: 'found-list' }, f.questions.map((q) => h('li', null, about(q.about), q.ask)))] : null,
    f.queries.length
      ? [head(`搜尋的字（${f.queries.length} 次）`), h('ul', { class: 'found-list small' }, f.queries.map((q) => h('li', null, q))), h('p', { class: 'small faint', style: 'margin-top:4px' }, '搜尋結果只有標題與網址，不是證據；要當證據，原文要由程式抓回來、存快照（下面「取回的文件」）。')]
      : null,
    f.docs.length
      ? [
          head(`取回的文件（${f.docs.length} 份）`),
          f.docs.map((x) =>
            h(
              'div',
              { class: 'cond found-doc' },
              h('p', null, h('b', { style: 'font-weight:500' }, x.title)),
              h('p', { class: 'small dim', style: 'margin-top:2px' }, [x.source, x.level, `發布 ${x.published}`, `${x.fetched} 抓`, x.via, x.cut].filter(Boolean).join('；'), x.url ? ['；', ext(x.url)] : null),
              x.why || x.about ? h('p', { class: 'small', style: 'margin-top:4px' }, about(x.about), x.why ? `為什麼要：${x.why}` : '') : null,
              x.votes === null ? null : h('p', { class: 'small ' + (x.votes ? '' : 'faint'), style: 'margin-top:4px' }, x.votes ? `${x.votes} 票引用了它：` : '沒有一票引用它。'),
              x.quotes.map((q) => h('blockquote', { class: 'quote', style: 'margin-top:6px' }, `「${q}」`)),
            ),
          ),
        ]
      : null,
    f.missed.length
      ? [
          head(`沒有讀到的（${f.missed.length + f.missedMore} 份）`),
          f.missed.map((x) =>
            h(
              'div',
              { class: 'cond found-doc' },
              h('p', { class: 'found-what' }, x.url ? h('a', { href: x.url, target: '_blank', rel: 'noopener noreferrer' }, x.what) : x.what),
              h('p', { class: 'small', style: 'margin-top:2px;color:var(--warn)' }, `沒有讀到：${x.reason}`),
              x.why || x.about ? h('p', { class: 'small dim', style: 'margin-top:2px' }, about(x.about), x.why ? `為什麼要：${x.why}` : '') : null,
            ),
          ),
          f.missedMore ? h('p', { class: 'small faint' }, `另外 ${f.missedMore} 份沒有列出（紀錄只留前 ${f.missed.length} 筆）。`) : null,
          h('p', { class: 'small faint', style: 'margin-top:6px' }, '沒有讀到的網頁，AI 只能寫「有這樣的標題」，不能當成事實，也不能當引用。'),
        ]
      : null,
  );
}

/**
 * 「新眼光：前提以外的風險」（T63，composite_layer_design §3）：這次有沒有跑、列了哪幾件、哪幾件被程式拿掉與原因。
 * 只當建議，和上面三票的結論無關。
 */
function risksBlock(r) {
  if (!r) return null;
  return glass(
    'pad',
    h('h2', { class: 'panel-h' }, '新眼光：前提以外的風險'),
    h('p', { class: r.state === 'NONE' ? 'notice' : null }, r.line),
    r.items.map((x) =>
      h(
        'div',
        { class: 'cond found-doc' },
        h('div', { class: 'cond-h' }, h('b', null, x.text || '（沒有寫）'), h('span', { class: 'chip ' + (x.kept ? 'ok' : 'warn') }, x.kept ? '通過' : '拿掉')),
        x.note ? h('p', { class: 'small', style: 'margin-top:2px;color:var(--warn)' }, `拿掉的原因：${x.note}`) : null,
        x.quote ? h('blockquote', { class: 'quote', style: 'margin-top:6px' }, `「${x.quote}」`) : null,
        x.source ? h('p', { class: 'small dim', style: 'margin-top:2px' }, `${x.source}${x.date && !x.source.includes(x.date) ? `（${x.date}）` : ''}`, x.url ? ['；', h('a', { href: x.url, target: '_blank', rel: 'noopener noreferrer' }, '原始網址')] : null) : null,
      ),
    ),
  );
}

/**
 * 「市場摘要」（T65，composite_layer_design §1.8）：期間、為什麼開、程式算的數字、報導的說法（每一條附引用的片段與出處）、
 * 各來源一致不一致、和暫定稿不同的地方、被程式拿掉的。原因一律是「報導的說法」，原因不明也是合格的答案。
 */
export function briefBlock(b) {
  if (!b) return null;
  const head = (t) => h('h5', { style: 'margin-top:16px' }, t);
  return glass(
    'pad',
    h('h2', { class: 'panel-h' }, `市場摘要（${b.stage}${b.manual ? '，手動開的' : ''}）`),
    h('p', { class: b.state === 'FAILED' ? 'notice' : null }, b.line),
    b.period ? h('p', { class: 'small dim', style: 'margin-top:6px' }, `涵蓋 ${day(b.period.from)}～${day(b.period.to)}`) : null,
    b.triggers.length ? [head('為什麼開'), h('ul', { class: 'found-list small' }, b.triggers.map((t) => h('li', null, t)))] : null,
    b.facts.length ? [head('程式算的數字'), h('ul', { class: 'found-list small' }, b.facts.map((f) => h('li', { class: 'num' }, f)))] : null,
    b.state === 'READY'
      ? [
          head(b.causes.length ? `報導的說法（${b.causes.length} 條）` : '報導的說法'),
          b.causes.length
            ? b.causes.map((c) =>
                h(
                  'div',
                  { class: 'cond found-doc' },
                  h('div', { class: 'cond-h' }, h('b', { style: 'font-weight:500' }, c.text), h('span', { class: 'chip ' + (c.confidence === '高' ? 'ok' : c.confidence === '中' ? '' : 'warn') }, `信心${c.confidence}`)),
                  h('p', { class: 'small dim', style: 'margin-top:2px' }, [c.where, c.kind, c.headline ? '只有新聞標題，沒有讀到全文：當成線索' : null].filter(Boolean).join('；')),
                  c.lowered ? h('p', { class: 'small', style: 'margin-top:2px;color:var(--warn)' }, `信心被程式調低：${c.lowered}`) : null,
                  c.quotes.map((q) => h('blockquote', { class: 'quote', style: 'margin-top:6px' }, `「${q.quote}」`, h('cite', null, `${q.title}，${q.date}`, q.url ? ['；', h('a', { href: q.url, target: '_blank', rel: 'noopener noreferrer' }, '原始網址')] : null))),
                ),
              )
            : h('p', null, '原因不明：沒有找到說得通的原因。這是合格的答案，不是失敗。'),
          b.unknown && b.causes.length ? h('p', { class: 'small', style: 'margin-top:6px' }, '整體來說原因不明；上面只是報導提到的說法。') : null,
          h('p', { class: 'small', style: 'margin-top:10px' }, b.clarity),
          b.changed ? [head('和暫定稿不同的地方'), h('p', null, b.changed)] : null,
          h('p', { class: 'small faint', style: 'margin-top:8px' }, '引用逐字對得上只證明報導這樣寫，不證明因果。個股的審查會讀這份摘要當背景（只給大盤與那一檔族群的部分），但不能拿它判前提不成立。'),
        ]
      : null,
    b.dropped.length ? details(`被程式拿掉的（${b.dropped.length} 條）`, h('ul', { class: 'found-list small' }, b.dropped.map((x) => h('li', null, `${x.what}「${x.text}」：${x.why}`)))) : null,
    b.notes.length ? h('p', { class: 'small faint', style: 'margin-top:6px' }, b.notes.join('；')) : null,
  );
}

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
    banner: { back, kicker: `${d.label} · 決策日 ${day(d.date)}`, title: actionText(`${d.ticker ? d.ticker + '：' : ''}${d.fn === REWRITE && d.status === 'AGREED' ? '出場條件改寫好了' : d.verdict}`), sub: [h('span', { class: 'chip ' + (TONE[d.status] ?? '') }, d.statusLabel), d.fn === REWRITE ? ' 改寫的結果要你在持股頁勾選才會監測。' : d.fn === BRIEF ? ' 只說明，不下單、不改任何狀態。' : d.followRule ? ' 照規則，AI 的意見只記錄。' : ' AI 的建議可以採用，由你決定。'], bubble: bubbleOf(d) },
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
      // 沒有一票判斷前提的功能（例如出場條件改寫）：前提只是背景，不列「沒有判斷」（T39a）
      d.premises.length && (d.status === 'PENDING' || d.premises.some((p) => p.votes.length))
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
                  h('small', { class: 'prem-votes' }, p.votes.length ? p.votes.map((v) => [h('span', { class: 'st ' + v.status, style: 'margin-right:6px' }, `第 ${v.index + 1} 票 ${v.label}${v.downgraded ? `（${v.note ?? '引用被刪'}）` : ''}`)]) : '沒有判斷'),
                ),
              ),
            ),
          )
        : null,
      briefBlock(d.brief),
      foundBlock(d.found),
      risksBlock(d.risks),
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
                x.hidden ? h('p', { class: 'small dim', style: 'margin-top:6px' }, x.hidden) : h('pre', { class: 'small', style: 'white-space:pre-wrap;max-height:18em;overflow:auto;margin-top:6px' }, x.preview + (x.chars > x.preview.length ? '\n…（完整原文在匯出的 md 裡）' : '')),
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


// ---------------------------------------------------------------- 崩盤規則的檢視紀錄（T33b，core_ai §3.4）

/** 每次切換一列：月份方向、AI 檢視（連到那次執行）、你的選擇、1／3／6 個月後的三個金額。log 是 /history 的 crashLog。 */
export function crashLogBlock(log) {
  if (!log || !log.rows.length) return null;
  const amt = (v, label) => h('div', { class: 'small', style: 'white-space:nowrap' }, h('span', { class: 'faint' }, label + ' '), v === null || v === undefined ? h('span', { class: 'faint' }, '—') : h('span', { class: 'num', style: `color:${v > 0 ? 'var(--core)' : v < 0 ? 'var(--hot)' : 'inherit'}` }, money(v)));
  const hz = (x) => (x ? [amt(x.rule, '照規則比你'), amt(x.ai, '照 AI 比你'), amt(x.delay, '照規則比延後')] : h('span', { class: 'faint small' }, '還沒到'));
  const body = log.rows.length
    ? glass(
        'scroll-x',
        h(
          'table',
          { class: 'plain crash-log' },
          h('thead', null, h('tr', null, ['月份、方向', 'AI 檢視', '你的選擇', '1 個月後', '3 個月後', '6 個月後'].map((x) => h('th', null, x)))),
          h(
            'tbody',
            null,
            log.rows.map((r) =>
              h(
                'tr',
                null,
                h('td', { style: 'white-space:nowrap' }, r.notif ? h('a', { href: `#/n/${r.notif}` }, r.label) : r.label, r.relist ? h('div', { class: 'small faint' }, '上次沒做，再列') : null),
                h('td', null, r.runId ? h('a', { href: `#/ai/${encodeURIComponent(r.runId)}` }, r.ai) : r.ai),
                h('td', null, r.choice),
                h('td', null, hz(r.at['1m'])),
                h('td', null, hz(r.at['3m'])),
                h('td', null, hz(r.at['6m'])),
              ),
            ),
          ),
        ),
      )
    : null;
  return details(
    '崩盤規則的檢視紀錄（已停用）',
    h(
      'div',
      null,
      h('p', { style: 'margin-bottom:8px' }, log.head),
      body,
      h('p', { class: 'small faint', style: 'margin-top:8px' }, '金額是那一次股數差的價差（含股利），從當天收盤拿到觀察期結束：正數＝照規則（或照 AI）比你實際多賺；「照規則比延後」是把那次的單全部延後不做的對照，負數＝延後比較好。一年大約切換一次，統計上驗證不了，這張表給你逐次看。'),
      h('p', { class: 'small faint', style: 'margin-top:4px' }, '2026-11 起沒有崩盤規則：核心固定留兩成 SGOV，不看 200 日線。這裡只留下舊的紀錄。'),
    ),
  );
}

// ---------------------------------------------------------------- AI 紀錄上方的總覽（T11）

const DECISION = { ALLOW: '准許', ALLOW_WATCH: '准許，附註', VETO: '否決', BLOCK: '資料可疑，這個月不進場', PENDING: '等法庭' };
const SOURCE = { RULE: '規則', AI: 'AI 法庭', DEFAULT: '照規則（AI 沒有結論）' };
const CODE = { PENDING_MA: '被收購', ACCOUNTING: '會計問題', REGULATORY: '監管或訴訟', EARNINGS_DIVERGENCE: '盈餘背離', ONE_OFF_JUMP: '一次性跳漲', DILUTION: '增資', DATA_SUSPECT: '資料可疑', MGMT_CHANGE: '高層異動', GUIDANCE_CUT: '財測', RESTRUCTURING: '重組', MAJOR_CONTRACT: '重大合約', DISTRESS: '財務危機', CYBER: '資安事件', ACTIVIST: '大股東申報（13D）', CONDITION_HINT: '可能和條件有關', PRICE_DROP: '個股自身大跌', FINANCING: '籌資', EARNINGS: '財報', OTHER: '其他', ALLOW_WATCH: '准許，附註', ALLOW: '准許', VETO: '否決', INSUFFICIENT: '證據不足', EXIT: '建議出場', HOLD: '不用動' };
/** 網站不顯示代碼：把文字裡的代碼換成白話。 */
const plain = (t) => String(t ?? '')
  .replace(/（\d{4}-\d{2}-\d{2}_[A-Z_]+_[0-9a-f]{6}）/g, '')
  .replace(/\d{4}-\d{2}-\d{2}_[A-Z_]+_[0-9a-f]{6}/g, 'AI 紀錄').replace(/(PENDING_MA|ACCOUNTING|REGULATORY)_CANDIDATE/g, (_, c) => `${CODE[c]}候選`).replace(/\b(PENDING_MA|ACCOUNTING|REGULATORY|EARNINGS_DIVERGENCE|ONE_OFF_JUMP|DILUTION|DATA_SUSPECT|ALLOW_WATCH|ALLOW|VETO|INSUFFICIENT|EXIT|HOLD)\b/g, (m) => CODE[m]);
const fnum = (x, d = 2) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : x.toFixed(d));

const spct = (x) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1)}%`);

/**
 * 動能新股進場審查的否決紀錄（momentum_ai §3.7）：每一次否決一塊（連續沿用的月份算同一次），之後 3、6 個月被否決者與遞補者各自相對基準的報酬。
 * 只求能用（版面在 T34 整理）。
 */
function vetoList(vs) {
  const after = (label, v) => h('div', { class: 'small' }, `${label}：`, `${v.ticker} ${spct(v.vetoed.m3)}`, v.replacement ? `、遞補的 ${v.replacedBy} ${spct(v.replacement.m3)}` : '', `（3 個月）；${v.ticker} ${spct(v.vetoed.m6)}`, v.replacement ? `、${v.replacedBy} ${spct(v.replacement.m6)}` : '', '（6 個月）');
  return h(
    'div',
    null,
    h(
      'ul',
      { style: 'list-style:none;margin:0;padding:0' },
      vs.map((v) =>
        h(
          'li',
          { style: 'padding:8px 0;border-top:1px solid var(--line)' },
          h('div', null, h('span', { class: 'num dim', style: 'margin-right:10px' }, day(v.date)), h('span', { class: 'tk' }, v.ticker), h('span', { class: 'chip hot', style: 'margin-left:10px' }, v.late ? `月報之後回來：否決（${v.codeText}）` : `否決：${v.codeText}`), v.runId ? h('a', { href: `#/ai/${v.runId}`, class: 'small', style: 'margin-left:10px' }, 'AI 紀錄') : null),
          h('div', { class: 'small dim' }, v.late ? '月報已經出了，只是建議，照規則買進了' : `由 ${v.replacedBy ?? '（沒有遞補，留在核心）'} 遞補`, v.months.length > 1 ? `；沿用到 ${v.months.at(-1)}（共 ${v.months.length} 個月）` : ''),
          after('之後相對大盤', v),
        ),
      ),
    ),
    h('p', { class: 'small faint', style: 'margin-top:8px' }, '從決策日的收盤起算、相對大盤（SPY）的超額報酬；還沒滿 3 或 6 個月的是「—」。被否決的那一檔之後比遞補的差，否決才算幫上忙。一年不到一次，統計上驗證不了，請逐次看；要不要收回 AI 的否決權由你決定。'),
  );
}

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
            h('table', { class: 'plain' }, h('tbody', null, o.reviews.map((r) => h('tr', null, h('td', { style: 'white-space:nowrap' }, h('span', { class: 'tk' }, r.ticker), r.rank ? h('div', { class: 'small faint' }, `第 ${r.rank} 名`) : null), h('td', null, h('span', { class: 'chip ' + (r.decision === 'VETO' || r.decision === 'BLOCK' ? 'hot' : r.decision === 'ALLOW_WATCH' ? 'warn' : 'ok') }, DECISION[r.decision] ?? r.decision), r.lateVerdict === 'VETO' ? h('div', null, h('span', { class: 'chip hot' }, '月報之後回來：否決')) : null), h('td', { class: 'small' }, `${r.carriedFrom ? `沿用 ${r.carriedFrom} 的 AI 法庭` : (SOURCE[r.source] ?? r.source)}${r.reasonCode ? ` · ${CODE[r.reasonCode] ?? r.reasonCode}` : ''}${r.replacedBy ? ` · 由 ${r.replacedBy} 遞補` : ''}`, r.watchReason ? h('div', { class: 'faint' }, '附註：' + plain(r.watchReason)) : null, r.note ? h('div', { class: 'faint' }, plain(r.note)) : null))))),
          ),
        );
      if (o.vetoes?.length) parts.push(details(`AI 否決的紀錄（${o.vetoes.length} 次）`, vetoList(o.vetoes)));
      if (o.macro) {
        // 可用 = 有值而且沒過期（core_ai §3.5）
        const usable = o.macro.rows.filter((r) => r.value !== null && !r.stale).length;
        parts.push(
          details(
            `總經儀表板（${day(o.macro.asOf)}，市場摘要用）：${o.macro.rows.length} 個序列有 ${usable} 個可用`,
            h('div', null,
              h('dl', { class: 'facts' },
                o.macro.rows.map((r) => [
                  h('dt', null, r.label),
                  h('dd', null,
                    h('span', { class: 'num' }, r.value === null ? '抓不到' : fnum(r.value)),
                    r.date ? h('span', { class: 'faint small', style: 'margin-left:8px' }, r.date) : null,
                    r.stale ? h('span', { class: 'small', style: 'margin-left:6px;color:var(--hot)' }, '資料停在這一天') : null,
                    h('small', null, [r.change6m === null ? null : `6 個月變化 ${r.change6m >= 0 ? '+' : ''}${fnum(r.change6m)}`, r.derived, r.note].filter(Boolean).join('；')),
                  ),
                ]),
                o.macro.breadth ? [h('dt', null, '市場廣度'), h('dd', null, h('span', { class: 'num' }, `${Math.round((o.macro.breadth.above / o.macro.breadth.n) * 100)}%`), h('small', null, `市值前 50 大裡收盤在 200 日均線之上：${o.macro.breadth.above}／${o.macro.breadth.n}`))] : null,
              ),
              h('p', { class: 'small faint', style: 'margin-top:8px' }, `抓不到或資料停太久（每日的 10 天、每週的 21 天、每月的 75 天）的序列不能當證據；只在市場摘要裡當背景資料，不影響任何規則。`),
            ),
          ),
        );
      }
      if (o.events?.length)
        // 日期和代號放同一欄（T39a：手機上原本四欄，中間的說明欄被擠得很窄）
        parts.push(details('最近的申報事件（規則偵測、每日掃描）', h('table', { class: 'plain' }, h('tbody', null, o.events.map((e) => h('tr', null, h('td', { style: 'white-space:nowrap' }, h('span', { class: 'num' }, day(e.event_date)), h('div', { class: 'tk' }, e.ticker)), h('td', null, `${e.form === 'NEWS' ? '新聞標題' : e.form} · ${CODE[e.code] ?? e.code}`, e.detail ? h('div', { class: 'small faint' }, plain(e.detail)) : null), h('td', { class: 'small', style: 'white-space:nowrap' }, e.status === 'IN_COURT' && e.handled_note ? h('a', { href: `#/ai/${e.handled_note}` }, '審查中') : e.status === 'HANDLED' && /^法庭 ([^\s：]+)：/.test(e.handled_note ?? '') ? h('a', { href: `#/ai/${/^法庭 ([^\s：]+)：/.exec(e.handled_note)[1]}` }, '已審查') : e.status === 'HANDLED' && /開法庭 (\S+)/.test(e.handled_note ?? '') ? h('a', { href: `#/ai/${/開法庭 (\S+)/.exec(e.handled_note)[1]}` }, '已開審查') : ({ NEW: '待處理', HANDLED: e.handled_note ?? '已處理', INFO: '只記錄', IN_COURT: '審查中' }[e.status] ?? e.status))))))));
      box.replaceChildren(...parts);
    })
    .catch(() => box.replaceChildren());
  return box;
}

// ---------------------------------------------------------------- 持股頁：條件與出場條件的改寫結果（T11、T26、T27）

const COND_ACTIONS = [
  ['EXIT', '出清'],
  ['HALF', '減半'],
  ['REVIEW', '重新審查'],
];
const MAX_OWNED = 8;
/** AI 監測中的條件一檔最多幾條（T71；和伺服器的 MAX_AI_WATCH 同一個數字）。 */
const MAX_AI_WATCH = 3;

/** 成立時做什麼的下拉選單。 */
function actionSelect(value, onchange) {
  return h('select', { style: 'width:auto;min-height:36px;padding:4px 10px', onchange }, COND_ACTIONS.map(([v, t]) => h('option', { value: v, selected: v === value }, t)));
}

// T68（confirm_audit_design §1.6）：勾選條件時選「用哪個網頁來源確認」的選單拿掉了；
// 條件寫的來源與它的級別寫在「怎麼確認」那一句裡（「審查時用 TrendForce（產業研究機構）的網頁檢查」）。

/**
 * 一條條件：文字與狀態、誰定的與怎麼確認、進度條、說明；controls 是這一條能做的事。
 * 狀態標籤和「怎麼確認」相同時（只在定期審查時檢查、只記錄）只寫一次（T24 留下的重複，T34 整理）。
 */
function condRow(c, controls, extra = null) {
  const tone = c.code === 'MET' ? 'hot' : c.code === 'ACTIVE' ? 'ok' : c.code === 'PROPOSED' ? 'now' : '';
  // 舊資料的建議中（PROPOSED）不監測：不寫「怎麼確認」（T71 起沒有勾選）
  const how = c.confirm && c.confirm !== c.status && c.code !== 'PROPOSED' ? c.confirm : null;
  return h(
    'div',
    { class: 'cond' },
    h('div', { class: 'cond-h' }, h('b', null, c.text), h('span', { class: 'chip ' + tone }, c.status)),
    h('p', { class: 'small dim', style: 'margin-top:4px' }, [c.origin, c.kind ? `${c.kind}條件` : null, how].filter(Boolean).join('；')),
    c.steps ? stepsBar(c.steps) : null,
    c.progress ? h('p', { class: 'small', style: 'margin-top:2px' }, c.progress) : null,
    c.note ? h('p', { class: 'small faint', style: 'margin-top:2px' }, c.note) : null,
    extra,
    controls ? h('div', { class: 'btn-row cond-ctl' }, controls) : null,
  );
}

/** 財報條件的進度條（§3.6.2；要連續 N 季的才有）：一季一段，左到右是時間順序，已符合的段落標那一季的數值。 */
function stepsBar(s) {
  return h('div', { class: 'qbar', role: 'img', 'aria-label': `要連續 ${s.need} 季，已經 ${s.done} 季符合` }, s.labels.map((l, k) => h('span', { class: k < s.done ? 'on' : null }, l)));
}

/** 條件的操作（勾選、撤下、改動作）：成功就重畫這一頁，失敗把原因寫在 msg。 */
async function condOp(ctx, ticker, msg, body, done) {
  try {
    await api.post('/ops/own-condition', { ticker, ...body });
    toast(done);
    ctx.refresh();
  } catch (e) {
    msg.replaceChildren(h('p', { class: 'small', style: 'color:var(--hot)' }, e.message));
  }
}

/**
 * 這檔的條件，分兩組（T71，confirm_audit_design §3）：
 *   你定的：成立時照你選的動作通知你，之後的審查換不掉。
 *   AI 監測中（成立時重新審查）：審查三票一致建議、寫入就監測；成立時不叫你賣，只再開一次審查。把動作改成出清或減半就變成你定的。
 * 下面接最近一次健檢 AI 改寫的出場條件（勾選後開始監測）。
 */
export function ownMonitor(ctx, d) {
  const out = [];
  const all = d.monitor ?? [];
  const owned = all.filter((c) => c.owned);
  const ai = all.filter((c) => c.ai);
  const live = owned.filter((c) => c.code === 'ACTIVE' || c.code === 'REVIEW_ONLY').length;
  const watching = ai.filter((c) => c.code !== 'MET' && c.code !== 'PROPOSED').length;
  const msg = h('div');
  if (owned.length)
    out.push(
      h('h5', { style: 'margin-top:4px' }, `你定的（會通知的 ${live}／${MAX_OWNED} 條）`),
      h('p', { class: 'small dim' }, '成立時照你選的動作通知你；之後的審查不會換掉它們。價格條件只記錄。'),
      owned.map((c) =>
        condRow(
          c,
          c.code === 'MET'
            ? [h('span', { class: 'small dim' }, `成立時：${c.actionText ?? '—'}（一次性，要再監測就重新定一條）`)]
            : [
                ...(c.recordOnly
                  ? [h('span', { class: 'small dim' }, '只記錄，不會通知')]
                  : [h('span', { class: 'small' }, '成立時'), actionSelect(c.action, (e) => condOp(ctx, d.ticker, msg, { id: c.id, op: 'action', action: e.target.value }, `改成成立時${COND_ACTIONS.find(([v]) => v === e.target.value)[1]}`))]),
                h('button', { class: 'btn quiet', type: 'button', onclick: () => window.confirm(`撤下「${c.text}」？撤下之後不再監測。`) && condOp(ctx, d.ticker, msg, { id: c.id, op: 'retire' }, '已撤下') }, '撤下'),
              ],
        ),
      ),
    );
  if (ai.length)
    out.push(
      h('h5', { style: owned.length ? 'margin-top:18px' : 'margin-top:4px' }, `AI 監測中（成立時重新審查；${watching}／${MAX_AI_WATCH} 條）`),
      h(
        'p',
        { class: 'small dim' },
        `審查三票一致建議的條件，寫下就開始監測。成立時不會叫你賣，只會再開一次審查，由那次審查判斷要不要建議你動。下一次審查有新的建議時，還沒成立的這幾條會換成新的。想讓它成立時直接通知你出清或減半，就把成立時的動作改掉：它會變成你定的，之後的審查換不掉${live >= MAX_OWNED ? `（你定的已經 ${MAX_OWNED} 條，要先撤下一條）` : ''}。`,
      ),
      ai.map((c) => {
        if (c.code === 'PROPOSED') return condRow(c, [h('span', { class: 'small dim' }, '改版前的建議（舊資料），不會監測；下一次審查有新的建議時會過期')]);
        const extra = h('p', { class: 'small', style: 'margin-top:2px' }, c.aiTier, c.replaces ? h('span', { class: 'dim' }, `；改成出清或減半之後，會取代你原本的「${c.replaces}」`) : null);
        if (c.code === 'MET') return condRow(c, [h('span', { class: 'small dim' }, '成立時：重新審查（已經開過一次審查；一次性）')], extra);
        return condRow(
          c,
          [
            ...(c.recordOnly
              ? [h('span', { class: 'small dim' }, '只記錄，不會開審查')]
              : [
                  h('span', { class: 'small' }, '成立時'),
                  actionSelect(c.action ?? 'REVIEW', (e) => {
                    const v = e.target.value;
                    if (v === 'REVIEW') return;
                    const name = COND_ACTIONS.find(([x]) => x === v)[1];
                    if (!window.confirm(`改成成立時${name}之後，這條變成你定的：成立時直接通知你${name}，之後的審查不會換掉它。${c.replaces ? `你原本的「${c.replaces}」會撤下。` : ''}`)) {
                      e.target.value = 'REVIEW';
                      return;
                    }
                    condOp(ctx, d.ticker, msg, { id: c.id, op: 'action', action: v }, `改成成立時${name}，這條變成你定的`);
                  }),
                ]),
            h('button', { class: 'btn quiet', type: 'button', onclick: () => window.confirm(`撤下「${c.text}」？撤下之後不再監測（之後的審查可能再建議）。`) && condOp(ctx, d.ticker, msg, { id: c.id, op: 'retire' }, '已撤下') }, '撤下'),
          ],
          extra,
        );
      }),
    );
  if (owned.length || ai.length) out.push(msg);
  out.push(...rewriteBlock(ctx, d));
  return out;
}

/** 把出場條件重新送去改寫（編輯論點頁送出失敗、或改寫沒有結果時）。version：那一版論點（T42：伺服器只收最新的那一版）。 */
export async function resendExits(ticker, exits, version = null) {
  return api.post('/ops/own-check', { ticker, exits, ...(version ? { version } : {}) });
}

const ACTION_NAME = Object.fromEntries(COND_ACTIONS);
const day2 = (iso) => (iso ? `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}` : '');

/** 「出場條件還沒送去改寫」與「重送」（own_thesis §1.8 確認的第 3 點：不能沒有提示）。 */
export function unsentBox(ticker, exits, reason, onSent, version = null) {
  const msg = h('div');
  return h(
    'div',
    { class: 'notice', style: 'margin-top:12px' },
    h('b', null, '出場條件還沒送去改寫'),
    h('p', { class: 'small', style: 'margin-top:4px' }, reason),
    h('ul', { class: 'small', style: 'margin:6px 0 0 1.2em' }, exits.map((x) => h('li', null, `${x.text} → ${ACTION_NAME[x.action] ?? '重新審查'}`))),
    h('p', { class: 'small faint', style: 'margin-top:6px' }, '送去改寫、回來確認之前，現在的出場條件照舊監測。'),
    h('div', { class: 'btn-row', style: 'margin-top:8px' }, h('button', {
      class: 'btn',
      type: 'button',
      onclick: async (ev) => {
        ev.currentTarget.disabled = true;
        try {
          await resendExits(ticker, exits, version);
          toast('已重送，AI 通常幾分鐘內回來');
          onSent?.();
        } catch (e) {
          msg.replaceChildren(h('p', { class: 'small', style: 'color:var(--hot);margin-top:6px' }, e.message));
          ev.currentTarget.disabled = false;
        }
      },
    }, '重送')),
    msg,
  );
}

/** 按了先停用、做完再開（避免按兩次）。 */
const busyButton = (label, fn) => {
  const b = h('button', { class: 'btn', type: 'button', onclick: async () => { b.disabled = true; try { await fn(); } finally { b.disabled = false; } } }, label);
  return b;
};
const errLine = (box, e) => box.replaceChildren(h('p', { class: 'small', style: 'color:var(--hot);margin-top:6px' }, e.message ?? e));
/** 確認後會撤下的那幾條（T42：這次的出場條件沒有提到的）。 */
const retireList = (xs) =>
  xs.length
    ? h('div', { class: 'rw-retire' }, h('b', null, `確認後會撤下（這次的出場條件沒有提到，${xs.length} 條）：`), h('ul', { class: 'small', style: 'margin:4px 0 0 1.2em' }, xs.map((x) => h('li', null, x.text))))
    : null;

/**
 * 持股頁：最新一版論點的出場條件改寫結果（T42 整組取代，30 天內）。每一條寫明「和現在的相同（不新增）」「會取代：…」或新的；
 * 下面列「確認後會撤下」。按確認：勾選的新條件開始監測，被取代的與沒提到的撤下。沒確認之前舊的照舊監測。
 */
function rewriteBlock(ctx, d) {
  const rw = d.rewrites;
  if (!rw) return [];
  const out = [];
  if (rw.unsent) out.push(unsentBox(d.ticker, rw.unsent.exits, `${day2(rw.unsent.at)} 存第 ${rw.unsent.version} 版論點時沒有送出去（AI 層沒設定或送出失敗）。論點與前提已經存好了。`, () => ctx.refresh(), rw.unsent.version));
  if (rw.dropAll) {
    const msg = h('div');
    out.push(
      h(
        'div',
        { class: 'notice', style: 'margin-top:12px' },
        h('b', null, `第 ${rw.dropAll.version} 版論點拿掉了全部出場條件（${day2(rw.dropAll.at)} 存）`),
        retireList(rw.dropAll.retire),
        h('p', { class: 'small faint', style: 'margin-top:6px' }, '確認之前，這幾條照舊監測；不確認就一直照舊。'),
        h('div', { class: 'btn-row', style: 'margin-top:8px' }, busyButton('確認撤下', async () => {
          try {
            const r = await api.post('/ops/own-exits-retire', { ticker: d.ticker, version: rw.dropAll.version });
            toast(`撤下 ${r.retired.length} 條出場條件`);
            ctx.refresh();
          } catch (e) {
            errLine(msg, e);
          }
        })),
        msg,
      ),
    );
  }
  for (const c of rw.results) {
    if (c.status === 'PENDING') {
      out.push(h('p', { class: 'small dim', style: 'margin-top:12px' }, `${day2(c.createdAt)} 送出的 ${c.exits.length} 條出場條件，AI 正在對照與改寫成可以追蹤的格式，回來之後會出現在這裡。確認之前，現在的出場條件照舊監測。`));
      continue;
    }
    if (c.failed) {
      out.push(unsentBox(d.ticker, c.exits, `${day2(c.createdAt)} 送去改寫，但沒有結果（${c.summary ?? '原因不明'}）。`, () => ctx.refresh(), c.exitsVersion));
      continue;
    }
    const msg = h('div');
    const rows = c.conditions.map((x) => {
      const same = c.sames?.[x.condId] ?? null;
      let act = x.action;
      const box = same ? null : h('input', { type: 'checkbox', checked: !x.manual, 'aria-label': '勾選：開始監測' });
      return { x, same, box, get act() { return act; }, sel: same || x.manual ? null : actionSelect(act, (e) => (act = e.target.value)) };
    });
    const tag = (r) => {
      if (r.same) return h('span', { class: 'rw-tag same' }, `和現在的「${r.same.text}」相同：不新增，舊的接著監測${r.same.actionTo ? `（成立時改成${ACTION_NAME[r.same.actionTo]}）` : ''}`);
      if (c.replaces?.[r.x.condId]) return h('span', { class: 'rw-tag sup' }, `會取代：${c.replaces[r.x.condId]}（勾選並確認後，舊的那條撤下）`);
      return h('span', { class: 'rw-tag new' }, '新的');
    };
    const fresh = rows.filter((r) => !r.same).length;
    out.push(
      h('h5', { style: 'margin-top:18px' }, `出場條件的改寫結果，等你確認（第 ${c.exitsVersion ?? '—'} 版論點，${day2(c.createdAt)} 送出）`),
      h('p', { class: 'small dim' }, `你這次寫的是完整的出場條件，AI 對照了現在監測中的條件。${fresh ? '勾選的新條件確認後開始監測，成立時照你選的動作通知你。' : ''}確認之前，現在的條件照舊監測；不確認的話，30 天後這份結果不再列，舊的仍照舊監測。`),
      rows.map((r) =>
        h(
          'div',
          { class: 'cond' },
          h(
            r.box ? 'label' : 'div',
            { class: 'check-row', style: 'margin:0' },
            r.box ?? h('span', { class: 'rw-dot', 'aria-hidden': 'true' }),
            h(
              'span',
              null,
              h('b', { style: 'font-weight:500' }, r.x.text),
              r.x.from ? h('span', { class: 'small faint', style: 'display:block' }, `你寫的：${r.x.from}`) : null,
              r.same ? null : h('span', { class: 'small dim', style: 'display:block' }, r.x.then),
              tag(r),
            ),
          ),
          r.sel ? h('div', { class: 'btn-row cond-ctl' }, h('span', { class: 'small' }, '成立時'), r.sel) : null,
        ),
      ),
      c.unmatched?.length ? h('div', { class: 'small', style: 'margin-top:8px;color:var(--warn)' }, h('b', null, 'AI 沒有改寫出來、不會監測的：'), h('ul', { style: 'margin:4px 0 0 1.2em' }, c.unmatched.map((x) => h('li', null, `${x.text} → ${ACTION_NAME[x.action] ?? '重新審查'}`))), h('p', { class: 'faint' }, '原因見下面 AI 的說明；要監測的話，改寫法後再存一次論點。')) : null,
      retireList(c.retire ?? []),
      c.summary ? h('p', { class: 'small faint', style: 'margin-top:6px' }, c.summary) : null,
      h(
        'div',
        { class: 'btn-row', style: 'margin-top:8px' },
        busyButton('確認', async () => {
          const pick = rows.filter((r) => r.box?.checked);
          try {
            const r = await api.post('/ops/own-conditions', { ticker: d.ticker, runId: c.runId, ids: pick.map((p) => p.x.condId), actions: Object.fromEntries(pick.map((p) => [p.x.condId, p.act])) });
            toast([`開始監測 ${r.added} 條`, r.retired?.length ? `撤下 ${r.retired.length} 條` : '', r.actionChanged?.length ? `${r.actionChanged.length} 條改了成立時的動作` : ''].filter(Boolean).join('，'));
            ctx.refresh();
          } catch (e) {
            errLine(msg, e);
          }
        }),
      ),
      msg,
    );
  }
  return out;
}
