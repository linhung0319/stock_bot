// 單一持股頁（T34 改版，own_thesis §1.3、§1.5、§3.6.2、§3.6.6、§3.8）。
// 自選股以論點為主、慢規則為輔：論點與前提（最近一次檢查）→ 要看的事 → 出場條件 → 事件 → AI 審查與你的回應 → 慢規則與價格。
// 動能、核心的持股照舊（只檢查、不重排）：門檻條、走勢、數字、動能的事件。
import { api } from './api.js';
import { day, h, money, pct, qty, toast } from './dom.js';
import { glass, meterEl, page, tiles } from './layout.js';
import { aiBlock, attentionList, chart, refillText } from './parts.js';
import { actionButton, errBox } from './pages-notif.js';
import { ownMonitor } from './pages-ai.js';
import { attnDraftAction, copyPackButton, draftAction, takeAdoptFlash } from './pages-thesis.js';
import { BELIEF_TEXT } from './thesis-fields.js';
import { CHECK_TONE, premiseChecks, premiseSummary } from './premise-check.js';
import { RISK_TITLE, riskMeta } from './thesis-risks.js';

const em = (t) => ({ t, tone: 'em' });
const panelTop = (title, ...right) => h('div', { class: 'panel-top' }, h('h2', { class: 'panel-h' }, title), ...right);

export async function holdingPage(ctx, ticker) {
  const d = await api.get('/holding/' + encodeURIComponent(ticker));
  const st = ctx.state;
  const rows = st.account?.holdings.filter((x) => x.ticker === d.ticker) ?? [];
  const main = rows.find((x) => x.meter) ?? rows[0];
  return page({
    view: 'page',
    banner: {
      back: { href: '#/account', label: '帳戶' },
      title: h('span', { class: 'tk' }, d.ticker),
      sub: d.positions.length ? d.positions.map((p) => `${p.bucketName} ${qty(p.shares)} 股（${money(p.value)}，占 ${pct(p.pct)}）`).join('；') : '目前沒有持有。',
      bubble: d.own ? ownBubble(d, main) : ruleBubble(main),
    },
    pane: h('div', { class: 'stackv' }, d.own ? ownPanels(ctx, d, main) : otherPanels(d, main)),
    rail: tiles(st),
  });
}

function ruleBubble(main) {
  return main ? { k: '這一檔現在', say: [em(main.state), main.detail ? `。${main.detail}。` : '。'], mood: main.tone === 'alert' ? 'alert' : main.tone === 'warn' ? 'worry' : 'watch' } : { k: '這一檔現在', say: ['目前沒有持有。'], mood: 'idle' };
}

/** 自選股的那一句：先講論點（有沒有你的論點、前提最近一次檢查），再講慢規則。 */
function ownBubble(d, main) {
  const o = d.own;
  const checks = premiseChecks(d);
  // 審查後持有不是慢規則的狀態（有論點的股票沒有價格底線），直接寫狀態
  const rule = main ? (o.watch ? `${main.state}：跌幅審查之後沒有減半。` : `慢規則：${main.state}。`) : '';
  const mood = main?.tone === 'alert' ? 'alert' : main?.tone === 'warn' ? 'worry' : 'watch';
  if (o.pendingBreak) return { k: '這一檔現在', say: [`${o.pendingBreakName ?? '一則通知'}等你決定：`, em(`AI 審查認為前提${o.pendingBreak.premiseId ? ` ${o.pendingBreak.premiseId} ` : ''}不成立`), `。${rule}`], mood: 'alert' };
  if (o.kind === 'DEFAULT_ONLY') return { k: '這一檔現在', say: [em('還沒有你的論點'), `，AI 用系統預設前提做一般健康檢查。${rule}`], mood };
  // T61：照每條前提最近一次的結果數（證實／這次沒驗到／還沒檢查）；信念（T60）不進審查，不算在裡面
  const sum = premiseSummary(o.premises, checks);
  if (sum.broken.length) return { k: '這一檔現在', say: [`前提 ${sum.broken.join('、')} 最近一次審查`, em('被判不成立'), `。${rule}`], mood: 'worry' };
  if (!sum.judged) return { k: '這一檔現在', say: [em(`你的 ${o.premises.length} 條前提都是信念`), `，審查不逐條檢查。${rule}`], mood };
  return { k: '這一檔現在', say: [em(sum.text), `。${rule}`], mood };
}

// ---------------------------------------------------------------- 自選股

function ownPanels(ctx, d, main) {
  return [adoptedBox(d), openBox(d), thesisPanel(d), attentionPanel(d), condPanel(ctx, d), eventPanel(d), reviewPanel(d), rulePanel(ctx, d, main), d.mom ? momPanel(d.mom) : null, historyBlock(d)];
}

/** 論點、前提與最近一次檢查、編輯與討論的入口。 */
function thesisPanel(d) {
  const o = d.own;
  const t = d.thesis;
  const th = o.thesis;
  const def = o.kind === 'DEFAULT_ONLY';
  const edit = `#/h/${encodeURIComponent(d.ticker)}/thesis`;
  const pb = o.pendingBreak;
  return glass(
    'pad hp',
    // 只有前提、沒有論點本文時不寫「有你的論點」（T39a：和下面「還沒有論點本文」矛盾）
    panelTop('論點', h('span', { class: 'chip ' + (def ? 'warn' : 'ok') }, def ? '只有系統預設前提' : th ? '有你的論點' : '有你寫的前提')),
    pb ? h('p', { class: 'notice', style: 'margin:4px 0 12px' }, `${o.pendingBreakName ?? '一則通知'}等你決定：AI 審查認為前提${pb.premiseId ? ` ${pb.premiseId} ` : ''}不成立。`, h('a', { href: `#/n/${pb.notif}` }, '打開通知')) : null,
    th
      ? [h('p', { class: 'th-text' }, th.text), h('p', { class: 'small faint', style: 'margin-top:6px' }, `${day(th.setAt, true)} 定，${th.source}，第 ${th.version} 版${th.afterBreak ? `；失效後修改第 ${th.afterBreak} 次` : ''}`)]
      : h('p', { class: 'dim' }, def ? '還沒有你的論點。AI 審查時用下面三條系統預設前提做一般健康檢查，它們不是你持有的理由。' : '還沒有論點本文（為什麼持有它的那一段話），只有下面你寫的前提；AI 審查照這些前提檢查。'),
    // 買進時的一句話（T40，own_thesis §1.8）：不是前提，只當討論的開場
    def && o.buyNote
      ? h('div', { class: 'buy-note' }, h('p', { class: 'small faint' }, `買進時的一句話（${day(o.buyNote.at, true)} 寫的）`), h('p', null, `「${o.buyNote.text}」`), h('p', { class: 'small faint' }, '只當討論論點時的開場，不是前提；AI 審查不看這句話。'))
      : null,
    // 賣光之後又買回（T44）：還沒有這一次的論點時，上一次持有時的論點整塊攤開放在這裡
    def && o.prev ? prevBlock(o.prev, true) : null,
    o.openNote ? h('p', { class: 'notice', style: 'margin-top:12px' }, o.openNote) : null,
    h('h5', { style: 'margin-top:18px' }, def ? '前提（系統預設）' : `前提（${o.premises.length} 條，你為什麼持有它）`),
    premiseList(o, t, premiseChecks(d)),
    silencedRetired(o, t),
    o.reviewSkip ? h('p', { class: 'small dim', style: 'margin-top:10px' }, o.reviewSkip) : null,
    // 「請 stock bot 草擬」在前、「複製討論包」在後（T56，web_evidence_design §2.6）；草稿準備中、好了、要等幾天、上次失敗的原因寫在按鈕下面
    h(
      'div',
      { style: 'margin-top:18px' },
      def
        ? draftAction(d.ticker, o.draft, { primary: true, after: [copyPackButton(d.ticker), h('a', { class: 'btn', href: edit }, '編輯論點')] })
        : draftAction(d.ticker, o.draft, { before: [h('a', { class: 'btn primary', href: edit }, '編輯論點')], after: [copyPackButton(d.ticker)] }),
    ),
    pb ? h('p', { class: 'small', style: 'margin-top:8px;color:var(--hot)' }, `前提 ${pb.premiseId ?? ''} 剛被 AI 判不成立：這時候請 stock bot 草擬，草稿最上面會提醒你別只是替繼續持有找新理由，也不能沿用那一條。`) : null,
    h(
      'p',
      { class: 'small faint', style: 'margin-top:8px' },
      def
        ? `按「請 stock bot 草擬」，stock bot 讀申報、財報與網站寫一份草稿（反方先寫），你在「編輯論點」看過反方、按「採用這份草稿」才會生效。想自己和 AI 討論，按「複製討論包」貼到 claude.ai 的新對話，它會${o.prev ? '從上次為什麼賣、這次為什麼買回問起' : o.buyNote ? '從你買進時寫的那一句問起' : '先問你為什麼買'}；討論完說「收尾」，把結果貼回「編輯論點」。`
        : '「請 stock bot 草擬」寫一份新的草稿給你對照（每檔 7 天一次，按「採用這份草稿」才會整份換上）；「複製討論包」把論點、前提、條件、事件和數字整理成一段文字（不含金額與股數），貼到 claude.ai 討論，說「收尾」後把結果貼回「編輯論點」。',
    ),
    // 這一次已經有論點：上一次的收起來放在最下面，還是找得到（T44）
    !def && o.prev ? prevBlock(o.prev, false) : null,
  );
}

/**
 * 上一次持有時（T44，own_thesis §1.2）：賣光（或出清、移出）之後又買回，上一份論點檔的論點本文、你的前提、
 * 當時監測中的出場條件、結案的原因。只是紀錄：不沿用、舊條件不恢復監測。open：攤開（還沒有這一次的論點）或收合。
 */
function prevBlock(p, open) {
  const head = `上一次持有時（${p.openedAt ? `${day(p.openedAt, true)} 開檔` : '開檔日不明'} → ${day(p.closedAt, true)} ${p.closedVerb}）`;
  const conds = p.conditions;
  const live = (conds ?? []).filter((c) => c.state === 'LIVE');
  const met = (conds ?? []).filter((c) => c.state === 'MET');
  const act = (c) => ({ EXIT: '出清', HALF: '減半', REVIEW: '重新審查' })[c.action] ?? '重新審查';
  const condList = (xs) => h('ul', { class: 'prev-list' }, xs.map((c) => h('li', null, `${c.text} → ${act(c)}`, h('span', { class: 'faint' }, `（${c.note}）`))));
  const body = [
    h('p', null, h('span', { class: 'faint' }, '結案的原因：'), p.reasonText),
    p.thesis ? h('div', null, h('p', { class: 'small faint' }, `那時的論點（第 ${p.thesis.version} 版，${day(p.thesis.setAt, true)} 定）`), h('p', { class: 'th-text prev-text' }, p.thesis.text)) : null,
    p.premises.length ? h('div', null, h('p', { class: 'small faint' }, `那時你的前提（${p.premises.length} 條）`), h('ul', { class: 'prev-list' }, p.premises.map((x) => h('li', null, x.text)))) : null,
    p.hasThesis ? null : h('p', { class: 'small dim' }, '那一次沒有寫下論點，只用系統預設前提做一般健康檢查。'),
    conds === null
      ? null
      : live.length || met.length
        ? h('div', null, live.length ? [h('p', { class: 'small faint' }, '當時監測中的出場條件（買回後不會再監測）'), condList(live)] : null, met.length ? [h('p', { class: 'small faint', style: live.length ? 'margin-top:8px' : null }, '那一次已經成立的出場條件'), condList(met)] : null)
        : h('p', { class: 'small dim' }, '那一次沒有定出場條件。'),
    h('p', { class: 'small faint' }, '只是紀錄：上一次的論點不會沿用，當時的出場條件也不會因為買回而恢復監測。「複製討論包」會附上這一段；想從上次的論點改起，到「編輯論點」按「帶入上次的論點」。'),
  ];
  return open
    ? h('div', { class: 'prev-file' }, h('h5', null, head), ...body)
    : h('details', { class: 'more prev-file-more' }, h('summary', null, head), h('div', { class: 'more-body prev-file-body' }, ...body));
}

/**
 * 前提：編號、文字、誰寫的、最近一次的結果（T61 的四種寫法：證實／被判不成立／這次沒驗到／已經 N 次沒驗到）；
 * 結果的理由（哪一次審查、三票怎麼判）緊接在下一行；信念、靜默中的各一行。
 */
function premiseList(o, t, checks) {
  return h(
    'ul',
    { class: 'plist' },
    o.premises.map((p) => {
      const c = checks[p.id];
      return h(
        'li',
        null,
        h('span', { class: 'st' }, p.id),
        h(
          'div',
          null,
          h('p', null, p.text),
          h(
            'p',
            { class: 'plist-meta' },
            h('span', { class: 'faint' }, p.origin),
            // 信念（T60，composite §2.3）：不進審查，不寫「還沒有檢查過」
            p.belief ? null : c?.kind ? h('span', { class: 'st ' + CHECK_TONE[c.kind] }, c.text) : t && !t.partial ? h('span', { class: 'faint' }, '還沒有檢查過') : null,
          ),
          !p.belief && c?.kind && c.why ? h('p', { class: 'small faint plist-why' }, c.why) : null,
          p.belief ? h('p', { class: 'small prem-belief' }, `${BELIEF_TEXT}（不進審查的逐條判定）`) : null,
          p.silenced ? h('p', { class: 'small plist-quiet' }, p.silenced) : null,
        ),
      );
    }),
  );
}

/** 靜默中、但已經從論點撤下的前提（修正論點時拿掉的）：仍然列出到期日。 */
function silencedRetired(o, t) {
  const gone = (t?.silenced ?? []).filter((s) => !o.premises.some((p) => p.id === s.premiseId));
  if (!gone.length) return null;
  return h('p', { class: 'small faint', style: 'margin-top:8px' }, gone.map((s) => `${s.premiseId}（已撤下）靜默到 ${s.until}`).join('；'));
}

function attentionPanel(d) {
  if (!d.attention?.length) return null;
  // 論點滿一年、前提證據不足、連續沒有一致結論的那一行多「請 stock bot 草擬」；草稿好了的那一行連到編輯論點頁（T56）
  return glass('pad hp', panelTop('要看的事', h('span', { class: 'chip warn' }, `${d.attention.length} 件`)), h('p', { class: 'small dim' }, '不用下單、不用回覆；月報也會列出來（同一件事不會每個月都列）。'), attentionList(d.attention, { link: false, action: (x) => attnDraftAction(x, d.own?.draft ?? null) }));
}

/** 出場條件：你定的、AI 監測中的（T71）、改寫回來還沒勾的。 */
function condPanel(ctx, d) {
  const body = ownMonitor(ctx, d).filter(Boolean);
  const edit = `#/h/${encodeURIComponent(d.ticker)}/thesis`;
  const partial = d.thesis?.partial;
  return glass(
    'pad hp',
    panelTop('出場條件'),
    body.length
      ? body
      : h('p', { class: 'small dim' }, partial ? '示範模式不記出場條件（通知裡提到的條件是示範腳本寫的）。真實帳戶這裡會列出你定的條件、AI 監測中的條件和進度。' : ['還沒有出場條件。在「', h('a', { href: edit }, '編輯論點'), '」寫下出場條件，AI 改寫成查得到的格式之後，回到這裡確認才會開始監測。']),
  );
}

/** 事件時間軸（新的在上面）：上一次有結論的審查之後的標「新」，下一次審查會讀。 */
function eventPanel(d) {
  const t = d.thesis;
  if (!t) return null;
  const count = t.eventCount > t.events.length ? `最近 ${t.events.length} 件（共 ${t.eventCount} 件）` : t.eventCount ? `${t.eventCount} 件` : '';
  const head = panelTop('事件', count ? h('span', { class: 'small faint' }, count) : null);
  if (t.partial) return glass('pad hp', head, h('p', { class: 'small faint' }, '示範資料沒有事件紀錄。真實帳戶這裡會列出申報分類、每日掃描、價格規則記到的事件。'));
  if (!t.events.length) return glass('pad hp', head, h('p', { class: 'small faint' }, '開檔之後還沒有記到事件。'));
  return glass(
    'pad hp',
    head,
    t.events.some((e) => e.isNew) ? h('p', { class: 'small dim' }, '標「新」的是上一次審查之後才記到的，下一次審查會讀。') : null,
    h(
      'ol',
      { class: 'tl' },
      t.events.map((e) =>
        h(
          'li',
          { class: e.isNew ? 'new' : null },
          h('span', { class: 'tl-d num' }, day(e.date)),
          h(
            'div',
            null,
            h('p', { class: 'tl-h' }, h('b', null, e.label), e.isNew ? h('span', { class: 'chip now' }, '新') : null),
            e.detail ? h('p', { class: 'small dim' }, e.detail) : null,
            h('p', { class: 'small faint' }, [...new Set([e.source, e.via, e.status])].join('；')),
          ),
        ),
      ),
    ),
  );
}

/** 歷次 AI 審查（定期審查、減半檢視、硬事件、條件確認、財報數字擷取）與你對通知的回應；點一列看那次的完整紀錄。 */
function reviewPanel(d) {
  const t = d.thesis;
  const head = panelTop('AI 審查與你的回應', t?.reviewCount ? h('span', { class: 'small faint' }, t.reviewCount > t.reviews.length ? `最近 ${t.reviews.length} 次（共 ${t.reviewCount} 次）` : `${t.reviewCount} 次`) : null);
  const last = d.ai ? h('details', { class: 'more' }, h('summary', null, `最近一次審查的完整說明（${day(d.ai.date)}）`), h('div', { class: 'more-body' }, aiBlock(d.ai))) : null;
  if (!t || t.partial) return glass('pad hp', head, d.ai ? aiBlock(d.ai) : h('p', { class: 'small faint' }, 'AI 還沒有審查過這一檔。'));
  if (!t.reviews.length) return glass('pad hp', head, h('p', { class: 'small faint' }, 'AI 還沒有審查過這一檔。月底檢查點有新證據時、財報後、論點改了之後都會審。'));
  return glass(
    'pad hp',
    head,
    h(
      'div',
      { class: 'rv-list' },
      t.reviews.map((r) =>
        h(
          'a',
          { class: 'rv', href: `#/ai/${encodeURIComponent(r.runId)}` },
          h('span', { class: 'tl-d num' }, day(r.date)),
          h(
            'div',
            null,
            h('p', { class: 'tl-h' }, h('b', null, r.label), r.trigger ? h('span', { class: 'small faint' }, r.trigger) : null),
            h('p', { class: 'rv-res' }, h('span', { class: 'chip ' + r.tone }, r.result), r.broken.length ? h('span', { class: 'small rv-broken' }, `不成立：${r.broken.join('、')}`) : null),
            r.response ? h('p', { class: 'small dim' }, `${r.notifName ? `${r.notifName}，` : ''}你的回應：${r.response}`) : null,
          ),
          h('span', { class: 'chev', 'aria-hidden': 'true' }),
        ),
      ),
    ),
    risksBox(d),
    last,
  );
}

/**
 * 審查提到、你的前提沒有涵蓋的事（T71，confirm_audit_design §4：不再列「要看的事」，放在審查這一塊；只當建議）。
 * 每一件：那一句、哪一次審查提的與依據（原文收合）；要不要加成前提，到編輯論點頁帶進右欄再改字。
 */
function risksBox(d) {
  const rs = d.thesis?.risks ?? [];
  if (!rs.length) return null;
  const edit = `#/h/${encodeURIComponent(d.ticker)}/thesis`;
  return h(
    'div',
    { class: 'risk-sum', style: 'margin-top:14px' },
    h('h5', null, `${RISK_TITLE}（${rs.length} 件）`),
    h('p', { class: 'small dim' }, '審查時有一個角色不看你的前提、只讀原文，列出持有者最可能後悔的事。只是建議：不影響審查的結論與部位，也不會通知你。下一次 stock bot 草擬論點時會一起看。'),
    h(
      'ul',
      { class: 'risk-list' },
      rs.map((r) =>
        h(
          'li',
          { class: 'risk-item' },
          h('p', null, r.text),
          h('p', { class: 'small faint' }, riskMeta(r), '；', h('a', { href: `#/ai/${encodeURIComponent(r.runId)}` }, '那次審查')),
          h('details', { class: 'more dr-ev' }, h('summary', null, '引用的原文'), h('blockquote', { class: 'more-body small risk-quote' }, `「${r.quote}」`)),
        ),
      ),
    ),
    h('p', { class: 'small', style: 'margin-top:6px' }, '要加成前提：', h('a', { href: edit }, '編輯論點'), '，在右欄上面按「帶進右欄」再改字。'),
  );
}

/** 慢規則（底線）與價格：門檻條、減半之後的論點檢查、走勢、數字、標準比重。 */
function rulePanel(ctx, d, main) {
  const o = d.own;
  const dr = d.thesis?.dropReview;
  return glass(
    'pad hp',
    // 有論點的股票（allocation_redesign §3.1）：比高點低 20% 只觸發跌幅審查，不是賣出的理由；只有預設前提的照舊是底線
    panelTop(o.thesisKind ? '跌幅審查與價格' : '慢規則（底線）', h('span', { class: 'chip ' + (o.state === '正常' ? '' : 'warn') }, o.state)),
    h(
      'p',
      { class: 'small dim' },
      o.thesisKind
        ? '這檔有你的論點，沒有價格底線：比 52 週高點低 20% 以上只觸發論點檢查（跌幅審查，3 票），3 票判同一條前提不成立才減半；其餘不動，之後每多跌 10 個百分點再審一次。已經減半的，站回 200 日均線連續 10 天再買回。'
        : '比 52 週高點低 20% 減半，站回 200 日均線連續 10 天再買回。它是底線：不管論點，到了就照做；論點由上面的 AI 審查與你的出場條件管。這檔還沒有你的論點；寫了論點之後，跌 20% 會改成只觸發論點檢查。',
    ),
    // 審查後持有：整句說明另外放，條下面只留狀態（說明太長，塞進條的那一句會擠）
    main?.meter ? meterEl({ ...main.meter, say: o.watch ? `${main.state}。` : `${main.state}。${main.detail}` }, 'big') : null,
    o.watch ? h('p', { class: 'notice watch-note', style: 'margin-top:12px' }, o.watch) : null,
    dr ? h('p', { class: 'ai-line', style: 'margin-top:12px' }, dr.text, dr.notif ? [' ', h('a', { href: `#/n/${dr.notif}` }, `到 ${d.thesis.dropReviewNotifName ?? '那則通知'} 決定`)] : null) : null,
    h('div', { style: 'margin-top:16px' }, chart(d.chart)),
    h('dl', { class: 'facts', style: 'margin-top:16px' }, d.facts.map((f) => [h('dt', null, f.label), h('dd', null, h('span', { class: 'num' }, f.value), f.note ? h('small', null, f.note) : null)])),
    ...stdWeightEdit(ctx, d),
  );
}

// 改標準比重（2026-11-15 起取代新增／移除自選兩頁；新增和賣光都在填快照做；前提在「編輯論點」頁，T27）
function stdWeightEdit(ctx, d) {
  const msg = h('div');
  const fail = (e) => msg.replaceChildren(errBox(e));
  const std = h('input', { class: 'num-in', type: 'text', inputmode: 'decimal', value: (d.own.stdWeight * 100).toFixed(1), style: 'width:6em', 'aria-label': '標準比重（%）' });
  const saveStd = actionButton('改標準比重', '', async () => {
    const v = Number(std.value.replace(/[%\s]/g, ''));
    // 填的是百分比：5 代表 5%（填成 0.05 會變成 0.05%，T34 走一遍的缺口）
    if (!(v >= 0.1 && v <= 50)) return fail(new Error('標準比重填百分比，0.1～50；例如 5 代表 5%'));
    try {
      await api.post('/ops/std-weight', { ticker: d.ticker, stdWeight: v / 100 });
      toast(`${d.ticker} 的標準比重改成 ${v}%`);
      ctx.refresh();
    } catch (e) {
      fail(e);
    }
  });
  const o = d.own;
  // T43：標準比重是看得見的目標——寫出現在占多少，以及它在什麼時候起作用
  const low = o.stdWeight - o.weight > 0.0025;
  return [
    h('h5', { style: 'margin-top:20px' }, `標準比重 ${pct(o.stdWeight)}`),
    h('p', { class: 'small', style: 'margin:2px 0 8px' }, `現在占總資產 ${pct(o.weight)}。`, low ? `比標準比重低：${refillText({ weight: o.weight, std: o.stdWeight, half: o.half, fill: o.fill, scaled: o.scaled })}。` : ''),
    h('div', { class: 'btn-row', style: 'align-items:center' }, std, h('span', null, '%'), saveStd),
    h(
      'p',
      { class: 'small faint' },
      o.scaled
        ? '減半後加回補到這個比重。入金補自選時，自選各檔的目標合計超過自選比例，就照比例少補，自選桶慢慢回到預算。改了不會馬上下單；不想補回就把它改成現在的比重。'
        : '減半後加回、入金補自選，都補到這個比重；改了不會馬上下單。不想補回就把它改成現在的比重。',
    ),
    msg,
    h('p', { class: 'small faint', style: 'margin-top:14px' }, '不想再持有：到「填快照」把自選這一檔的股數改成 0，就會移出自選。'),
  ];
}

/** 還沒成交的清單上這一檔的單（T39a：動能這個月超過目標 ±50% 要賣，持股頁原本沒提）。 */
/**
 * 剛採用 stock bot 的草稿、從編輯論點頁回來（T70，confirm_audit_design §2.1）：最上面寫「已採用 M/D 的草稿；要改字在這一頁改」
 * （「這一頁」連到編輯論點頁），下面是出場條件與同業怎麼存的、沒存的同業的原因。只出現這一次（重新整理就不見）。
 */
function adoptedBox(d) {
  const xs = takeAdoptFlash(d.ticker);
  if (!xs?.length) return null;
  const [first, ...rest] = xs;
  const edit = `#/h/${encodeURIComponent(d.ticker)}/thesis`;
  const [pre, post] = first.text.split('這一頁');
  return glass(
    'pad adopt-flash',
    h('p', { class: `tone-${first.tone}` }, pre, post !== undefined ? [h('a', { href: edit }, '這一頁'), post] : null),
    rest.map((x) => h('p', { class: `small tone-${x.tone}` }, x.text)),
  );
}

function openBox(d) {
  if (!d.open?.length) return null;
  return h(
    'div',
    { class: 'notice', style: 'margin:0' },
    h('b', null, '還沒成交的單：'),
    d.open.map((x, k) => [k ? '；' : '', `${x.name}${x.decided ? '（你已經決定、等下單）' : '（等你決定）'}：${x.text} `, h('a', { href: `#/n/${x.notif}` }, '打開')]),
  );
}

// ---------------------------------------------------------------- 動能、核心（照舊）

function otherPanels(d, main) {
  return [
    openBox(d),
    main?.meter ? glass('pad', h('h2', { class: 'panel-h' }, main.meter.zone === '賣出' ? '離動能的賣出門檻多遠' : main.meter.zone === '啟動' ? '離崩盤規則多遠' : main.meter.zone === '買回' ? '離買回多遠' : '離慢規則的減半門檻多遠'), meterEl({ ...main.meter, say: `${main.state}。${main.detail}` }, 'big')) : null,
    glass('pad', chart(d.chart)),
    glass('pad', h('dl', { class: 'facts' }, d.facts.map((f) => [h('dt', null, f.label), h('dd', null, h('span', { class: 'num' }, f.value), f.note ? h('small', null, f.note) : null)]))),
    d.mom ? momPanel(d.mom) : null,
    historyBlock(d),
  ];
}

/**
 * 動能持股的事件與附註（momentum_ai §3.6）：事件只記錄、不發通知；「要看的事」含單月大跌那一行、晚到的否決、進場時的附註。
 */
function momPanel(m) {
  return glass(
    'pad',
    h('h2', { class: 'panel-h' }, '動能持股：要看的事與事件'),
    m.attention.length ? [h('h5', { style: 'margin-top:4px' }, `要看的事（${m.attention.length} 件，不用下單）`), attentionList(m.attention, { link: false })] : h('p', { class: 'small faint' }, '目前沒有要看的事。'),
    h('h5', { style: 'margin-top:14px' }, `最近 90 天記到的事件（${m.events.length} 件）`),
    m.events.length
      ? h('ul', { style: 'list-style:none;margin:6px 0 0;padding:0' }, m.events.map((e) => h('li', { style: 'padding:6px 0;border-top:1px solid var(--line);display:flex;gap:12px' }, h('span', { class: 'num dim', style: 'white-space:nowrap' }, day(e.date)), h('span', null, e.label, h('span', { class: 'small faint', style: 'margin-left:8px' }, e.source)))))
      : h('p', { class: 'small faint' }, '最近 90 天沒有記到事件。'),
    h('p', { class: 'small faint', style: 'margin-top:10px' }, '動能持股的事件只記錄、不發通知，也不會叫 AI 來看；出場只看排名。被收購、會計問題、重大監管這三種另外由 AI 審查，建議出場時才會通知你。'),
  );
}

function historyBlock(d) {
  if (!d.history.length) return null;
  return [
    h('h2', { class: 'sec', style: 'margin:24px 0 0' }, '這檔的紀錄'),
    h(
      'div',
      { class: 'glass rec' },
      d.history.map((x) => (x.notif ? h('a', { class: 'rowlink', href: `#/n/${x.notif}` }, h('span', { class: 'd num' }, day(x.date)), h('span', null, x.text), h('span')) : h('div', { class: 'rowlink' }, h('span', { class: 'd num' }, day(x.date)), h('span', null, x.text), h('span')))),
    ),
  ];
}
