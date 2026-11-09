// 畫面：上方「現在」（時間軸、剛才、接下來）、左邊 LINE、中間「時間軸／網站／觸發總表／情境說明／疑問筆記」、右邊帳戶。
// 中間的時間軸以「回合」為單位：你每按一次按鈕（前進時間、回覆、自己的操作）就是一個回合，底下列出這回合發生的事。
(function (G) {
  'use strict';
  const U = G.U, E = G.Engine, $ = (s) => document.querySelector(s), esc = U.esc;

  let sim = null;
  const ui = { tab: 'log', web: 'runs', run: null, tk: null, fFilter: '', tkFilter: '', keyOnly: true, scen: null, rounds: [], cur: null, base: null, scrollLog: null };

  // 觸發總表（設計 §2.0 的精簡版）
  const TABLE = [
    ['F1', '動能新股進場', '規則：每月，前 5 名且未持有', '任務 A（先跑規則偵測；有命中才開完整法庭）', 'A4 否決本月進場，下一名遞補', '月報'],
    ['F2', '動能出場', '規則：掉出前 15 名或股票池', '無', 'A0', '月報'],
    ['F3', '動能比例回調', '規則：偏離 ±50%，只搭便車', '無', 'A0', '月報'],
    ['F4', '依波動度減碼', '規則：每月，σ̃/σ 捨去到 1/3，0.10 遲滯', '任務 C 說明', 'A1', '月報'],
    ['F5', '崩盤規則啟動', '規則：每月，VOO < 200 日均線', '崩盤規則檢視（儀表板＋正反方＋法官 ×3）', 'A2 只說明＋影子；LINE 一行', '月報'],
    ['F6', '崩盤規則解除', '規則：每月，VOO > 200 日均線', '同 F5', 'A2', '月報'],
    ['F7', '自選慢規則減半', '規則：每天，距 52 週高點 -20%', '沿用 F24＋一次 Sonnet；跌幅拆解', 'A3 並列建議', '≥ 5% 當天；< 5% 月報'],
    ['F8', '自選慢規則加回', '規則：每天，200 日均線 10 天、間隔 15 天、不在暴跌', '沿用 F24；查未解除標記', 'A3 並列建議', '同 F7'],
    ['F9', '自選 R1', '規則：每天', '無，只記錄狀態', 'A0', '不通知'],
    ['F10', '單檔／跨桶上限', '規則：月報', '無', 'A0', '月報（可單獨下單）'],
    ['F11', '入金', '使用者', '無', 'A0', '當天清單'],
    ['F12', '出金', '使用者', '無', 'A0', '當天清單'],
    ['F13', '改比例', '使用者', '無（附相對回撤狀態，記影子）', 'A0', '當天清單'],
    ['F14', '新增自選', '使用者', '健檢：規則數字＋硬事件掃描＋前提', 'A1 只提供資訊', '當天清單'],
    ['F15', '移除自選', '使用者', '無', 'A0', '記影子'],
    ['F16', '轉入自選／認養／排除', '使用者', '無（轉入要寫理由→前提）', 'A0', '記影子'],
    ['F17', '這次不做／忘了／做錯／手動交易', '使用者', '無', 'A0', '記影子'],
    ['F18', '每日事件掃描', '規則：每天', '任務 B（Haiku）', '只標記、轉交', '不通知'],
    ['F19', '持股硬事件', '任務 B 標記', '任務 A 硬事件版 ×3', 'A3 升級給人', '當天'],
    ['F20', '持股單月跌 > 20%', '規則：每天', '任務 C', 'A1', '附在下一則'],
    ['F21', '策略檢討', '規則：落後 20／30／40／50%、每滿一年', '只列正反證據', 'A1', '不定期提醒'],
    ['F22', '換 strategy', '使用者', '無', 'A0', '（原型未做）'],
    ['F23', '提高自選標準比重', '規則：200 日均線之上 ≥ 6 個月等', 'F24 才能選 RAISE', 'A3 並列建議', '月報一行'],
    ['F24', '自選定期審查', '規則：每月（月報前一天）、財報後', '分析師→多空→經理 ×3', 'A3 月報並列建議', '月報'],
    ['F25', '自選條件監測', '規則：每天', '財報條件程式比對；事件條件 Sonnet ×3', 'A3 當天通知（每檔每月 1 則）', '當天'],
  ];
  const BASERATE = [
    ['2000-10', '2002-04', 18, '-19.3%'], ['2002-05', '2003-05', 12, '-13.4%'], ['2008-01', '2009-06', 17, '-34.1%'], ['2010-06', '2010-10', 4, '+7.2%'],
    ['2011-09', '2012-01', 4, '+5.7%'], ['2015-09', '2015-11', 2, '+8.4%'], ['2016-01', '2016-04', 3, '+2.5%'], ['2018-11', '2018-12', 1, '+3.2%'],
    ['2019-01', '2019-03', 2, '+14.0%'], ['2019-06', '2019-07', 1, '+8.3%'], ['2020-03', '2020-06', 3, '+2.4%'], ['2022-03', '2022-04', 1, '+4.5%'],
    ['2022-05', '2022-12', 7, '+0.0%'], ['2023-01', '2023-02', 1, '+5.4%'], ['2023-11', '2023-12', 1, '+8.7%'], ['2025-04', '2025-06', 2, '+5.4%'], ['2026-04', '2026-05', 1, '+10.3%'],
  ];
  // 權限等級、通知等級：用字說明，不只給代號
  const LVL = { A0: 'A0 AI 不參與', A1: 'A1 AI 只說明', A2: 'A2 AI 說明＋記影子', A3: 'A3 AI 並列建議／升級給人', A4: 'A4 AI 可否決', '標記': 'AI 只標記', 'A3（規則提出）': 'A3 規則直接提出' };
  const CLS = { '當天': '發當天通知', '月報': '進月報', '不通知': '不通知', '記影子': '記影子', '只放網站': '只放網站', '附在下一則': '附在下一則通知', '不定期提醒': '發提醒' };
  const KIND = { URGENT: ['當天', 'urgent'], MONTHLY: ['月報', 'monthly'], MONTHLY_EMPTY: ['月報', 'monthly'], CASHFLOW: ['當天清單', 'cash'], INFO: ['提醒', 'info'], CLASSIFY: ['要你回答', 'warn'] };

  function fcat(f) {
    if (f === 'SYS') return 'c-sys';
    if (f === 'SNAP') return 'c-snap';
    const n = Number(String(f).slice(1));
    if ([7, 8, 9, 23, 24, 25].includes(n)) return 'c-own';
    if ([18, 19, 20].includes(n)) return 'c-ai';
    if ([11, 12, 13, 14, 15, 16, 17, 22].includes(n)) return 'c-user';
    return 'c-rule';
  }
  function ftag(f, extra) { return '<span class="ftag ' + fcat(f) + (extra ? ' ' + extra : '') + '" title="' + esc(E.FNAME[f] || '') + '">' + (f === 'SNAP' ? '快照' : f === 'SYS' ? '系統' : esc(f)) + '</span>'; }
  function sharesTxt(n) { return n > 0 ? '買 ' + n + ' 股' : n < 0 ? '賣 ' + (-n) + ' 股' : '不動'; }
  function linesTxt(lines) { return lines.length === 1 ? sharesTxt(lines[0].shares) : lines.map((l) => l.tk + ' ' + sharesTxt(l.shares)).join('、'); }
  function when(date, phase) { return date.slice(5).replace('-', '/') + '（' + U.weekday(date) + '）' + (phase === 'PRE' ? '開盤前' : '收盤後'); }
  function nowWhen() { return when(sim.dateKey(), sim.phase); }
  function signed(n) { return (n > 0 ? '+' : '') + n; }
  function hasTk(e, tk) { return !tk || new RegExp('(^|[^A-Z])' + tk + '([^A-Z]|$)').test(e.title + ' ' + e.body); }
  function nidChip(nid) { return nid ? '<a class="chip" data-notif="' + nid + '">通知 #' + nid + '</a>' : ''; }

  // 例行紀錄：每天都會有、沒改變什麼的檢查，預設收起來
  function isRoutine(e) {
    if (e.warn) return false;
    if (e.f === 'F9' || e.f === 'F18') return true;
    if (/維持/.test(e.title)) return true;
    if (e.f === 'F24' && /（每月）/.test(e.title) && e.cls === '只放網站') return true;
    if (e.f === 'F24' && /排定明天/.test(e.title)) return true;
    if (e.f === 'F25' && e.cls === '不通知' && /不成立|已經成立過/.test(e.title + e.body)) return true;
    return false;
  }
  function isYou(e) { return /^你/.test(e.title); }

  // ---------------------------------------------------------------- 回合
  function beginRound(kind, label) {
    ui.cur = { kind, label, logFrom: sim.log.length, notifFrom: sim.notifs.length, fromDate: sim.dateKey(), fromPhase: sim.phase, fromD: sim.d, shares: Object.assign({}, sim.snap.shares), cash: sim.snap.cash };
  }
  function endRound(detail) {
    const r = ui.cur; if (!r) return; ui.cur = null;
    r.logTo = sim.log.length; r.notifTo = sim.notifs.length; r.toDate = sim.dateKey(); r.toPhase = sim.phase; r.toD = sim.d; r.detail = detail || '';
    r.delta = [];
    for (const tk of Object.keys(Object.assign({}, r.shares, sim.snap.shares))) { const d = (sim.snap.shares[tk] || 0) - (r.shares[tk] || 0); if (d) r.delta.push({ tk, d }); }
    r.cashDelta = sim.snap.cash - r.cash;
    r.id = ui.rounds.length;
    ui.rounds.push(r);
    ui.base = { shares: r.shares, cash: r.cash, label: r.label };
    ui.scrollLog = 'now';
  }
  // 你自己的操作：包成一個回合
  function act(label, fn, detail) { beginRound('you', label); fn(); endRound(typeof detail === 'function' ? detail() : detail); ui.forceBottom = true; renderAll(); }

  // ---------------------------------------------------------------- 啟動
  function load(id) {
    const sc = G.SCENARIOS.find((s) => s.id === id) || G.SCENARIOS[0];
    ui.scen = sc.id;
    sim = E.create(sc);
    ui.run = null; ui.fFilter = ''; ui.tkFilter = ''; ui.rounds = []; ui.cur = null;
    ui.tk = Object.keys(sim.own)[0];
    ui.rounds.push({ id: 0, kind: 'start', label: '情境開始：' + sc.title, logFrom: 0, logTo: sim.log.length, notifFrom: 0, notifTo: 0, fromDate: sim.dateKey(), fromPhase: sim.phase, fromD: sim.d, toDate: sim.dateKey(), toPhase: sim.phase, toD: sim.d, detail: '', delta: [], cashDelta: 0, shares: Object.assign({}, sim.snap.shares), cash: sim.snap.cash });
    ui.base = { shares: Object.assign({}, sim.snap.shares), cash: sim.snap.cash, label: '情境開始' };
    try { localStorage.setItem('stockbot-proto-scen', sc.id); } catch (e) { /* 沒有也沒關係 */ }
    ui.tab = 'guide'; markTabs();
    renderAll();
  }

  function renderAll() { renderHeader(); renderNow(); renderLine(); renderCenter(); renderRight(); }
  function renderHeader() {
    const end = sim.atEnd();
    for (const id of ['#step', '#day', '#nextNotif', '#nextMonth']) $(id).disabled = end;
  }

  // ---------------------------------------------------------------- 現在
  function pendingNotifs() { return sim.notifs.filter((n) => (n.status === 'PENDING' && (n.items.length || n.kind === 'CLASSIFY')) || n.followUpOpen); }
  function renderNow() {
    const days = sim.market.days, i0 = sim.market.idx0, i1 = days.length - 1;
    const X = (d) => ((d - i0) / Math.max(1, i1 - i0) * 100).toFixed(2) + '%';
    let tl = '<div class="tl"><div class="tlin"><div class="track"></div>';
    for (let d = i0; d <= i1; d++) if (d === i0 || sim.isFirstOfMonth(d)) tl += '<span class="month" style="left:' + X(d) + '">' + (d === i0 ? days[d].slice(5).replace('-', '/') : Number(days[d].slice(5, 7)) + '月') + '</span>';
    tl += '<span class="end">' + days[i1].slice(5).replace('-', '/') + ' 結束</span>';
    for (const n of sim.notifs) {
      const pend = n.status === 'PENDING' && (n.items.length || n.kind === 'CLASSIFY') || n.followUpOpen;
      tl += '<span class="dot k-' + n.kind + (pend ? ' pending' : '') + '" style="left:' + X(n.d) + '" data-notif="' + n.id + '" title="#' + n.id + ' ' + esc(n.title) + (pend ? '（等你回覆）' : '') + '"></span>';
    }
    tl += '<span class="cur" style="left:' + X(sim.d) + '" data-d="現在"></span></div></div>';

    const last = ui.rounds[ui.rounds.length - 1];
    let just = '';
    if (last && last.kind !== 'start') {
      const newN = sim.notifs.slice(last.notifFrom, last.notifTo);
      const es = sim.log.slice(last.logFrom, last.logTo);
      const keyN = es.filter((e) => !isRoutine(e)).length;
      just = '剛才：' + esc(last.label) + (last.kind === 'jump' ? '，' + when(last.fromDate, last.fromPhase) + ' → ' + when(last.toDate, last.toPhase) : '') + '。';
      const bits = [];
      if (newN.length) bits.push('新通知 ' + newN.map((n) => '#' + n.id).join('、'));
      if (es.length) bits.push('紀錄 ' + es.length + ' 條（重點 ' + keyN + '）');
      if (last.delta.length) bits.push('帳本變動 ' + last.delta.map((x) => x.tk + ' ' + signed(x.d)).join('、'));
      if (bits.length) just += bits.join('；') + '。';
    } else just = '還沒開始。先看「情境說明」，再按右邊的按鈕讓時間前進。';

    const pend = pendingNotifs();
    const responded = sim.notifs.filter((n) => n.status === 'RESPONDED');
    const infos = sim.notifs.filter((n) => n.status === 'PENDING' && !n.items.length && n.kind !== 'CLASSIFY');
    let next = '', cls = '', btn = '', bAct = '', sub = '';
    if (sim.atEnd()) { next = '情境到此結束。換一個情境，或按「重來」。'; cls = 'ok'; btn = '重來'; bAct = 'reset'; }
    else if (pend.length) {
      const n = pend[0];
      const what = n.followUpOpen ? '快照和清單不同，回答「補做差額」或「就這樣」' : n.kind === 'CLASSIFY' ? '回答這筆變動屬於哪一桶' : n.items.length + ' 項要你決定，選好後按「照清單做」';
      next = '等你回覆：通知 #' + n.id + '「' + esc(n.title) + '」。' + what + '。' + (pend.length > 1 ? '（另有 ' + (pend.length - 1) + ' 則待回覆）' : '');
      cls = 'wait'; btn = '去回覆 #' + n.id; bAct = 'reply:' + n.id; sub = '時間也可以照樣前進（試試「忘了」會怎樣）';
    } else if (responded.length) {
      next = '已回覆通知 ' + responded.map((n) => '#' + n.id).join('、') + '，還沒成交：按「下一步」到 ' + esc(sim.nextOpenLabel()) + ' 以開盤價成交、填快照。';
      cls = 'go'; btn = '下一步：成交'; bAct = 'step';
    } else {
      next = '沒有待辦。按「跳到下一則通知」讓時間前進。' + (infos.length ? '（有 ' + infos.length + ' 則提醒，按「已讀」即可）' : '');
      cls = 'ok'; btn = '跳到下一則通知'; bAct = 'next'; sub = '或：下一步、下一天、跳到下個月報';
    }
    $('#now').innerHTML = tl + '<div class="nowtext"><div class="clock"><b>' + esc(sim.dateKey()) + '（' + U.weekday(sim.dateKey()) + '）' + (sim.phase === 'PRE' ? '開盤前・台灣早上' : '收盤後・台灣清晨') + '</b></div><div class="just">' + just + '</div><div class="next ' + cls + '">' + next + '</div></div><div class="nowact"><button class="primary" data-now="' + bAct + '">' + esc(btn) + '</button>' + (sub ? '<span class="dim">' + esc(sub) + '</span>' : '') + '</div>';
  }

  // ---------------------------------------------------------------- 前因後果
  function creationIdx(n) {
    for (let i = 0; i < sim.log.length; i++) { const e = sim.log[i]; if (e.nid === n.id && e.d === n.d && e.phase === n.phase) return i; }
    return -1;
  }
  // 這一項為什麼會出現在清單上：同一個時點、同一個功能、提到同一檔的紀錄
  function itemWhy(n, it) {
    const ci = creationIdx(n); const lim = ci < 0 ? sim.log.length - 1 : ci;
    const out = [];
    for (let i = 0; i <= lim; i++) { const e = sim.log[i]; if (e.date === n.date && e.phase === n.phase && e.f === it.f && hasTk(e, it.tk) && !isYou(e)) out.push(i); }
    if (it.f === 'F1' && /遞補/.test(it.title)) for (let i = 0; i <= lim; i++) { const e = sim.log[i]; if (e.date === n.date && e.phase === n.phase && e.f === 'F1' && /否決/.test(e.title)) out.push(i); }
    if (it.f === 'F2' && /再列|沒照做/.test(it.title)) for (let i = 0; i <= lim; i++) { const e = sim.log[i]; if (e.date === n.date && e.phase === n.phase && e.f === 'F2' && hasTk(e, it.tk)) out.push(i); }
    if (!out.length && it.tk) for (let i = lim; i >= 0; i--) { const e = sim.log[i]; if (e.f === it.f && hasTk(e, it.tk) && !isYou(e)) { out.push(i); break; } }
    if (it.tk && (it.aiLine || it.kind === 'AI_ONLY' || it.f === 'F23')) for (let i = lim; i >= 0; i--) { const e = sim.log[i]; if (e.f === 'F24' && hasTk(e, it.tk) && !/排定/.test(e.title)) { out.push(i); break; } }
    return Array.from(new Set(out)).sort((a, b) => a - b).map((i) => ({ i, e: sim.log[i] }));
  }
  // 這則通知之後發生了什麼：之後提到它的紀錄
  function notifAfter(n) {
    const ci = creationIdx(n);
    const out = [];
    sim.log.forEach((e, i) => { if (e.nid === n.id && i > ci) out.push({ i, e }); });
    return out;
  }
  function whyBlock(list, summary) {
    if (!list.length) return '';
    return '<details class="why"><summary>' + esc(summary) + '</summary><div class="whybody">' + list.map((x) => '<div class="w">' + ftag(x.e.f) + ' <a class="t" data-log="' + x.i + '">' + esc(x.e.title) + '</a>' + (x.e.body ? '<div class="b">' + esc(x.e.body) + '</div>' : '') + '</div>').join('') + '</div></details>';
  }

  // ---------------------------------------------------------------- LINE
  function renderLine() {
    const box = $('#lineScroll');
    const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
    if (!sim.notifs.length) {
      box.innerHTML = '<div class="bubble"><div class="meta">stock bot</div>還沒有通知。按上方的「跳到下一則通知」讓時間前進。<br><span class="dim">不用操作的事不發通知；每則通知都附一份清單（設計 §2.5）。</span></div>';
      return;
    }
    box.innerHTML = sim.notifs.map(renderNotif).join('');
    if (ui.forceBottom) {
      const pend = pendingNotifs();
      const target = pend.length ? document.getElementById('n' + pend[0].id) : null;
      if (target) box.scrollTop = Math.max(0, target.offsetTop - 10); else box.scrollTop = box.scrollHeight;
    } else if (atBottom) box.scrollTop = box.scrollHeight;
    ui.forceBottom = false;
  }
  function renderNotif(n) {
    const k = KIND[n.kind] || ['', ''];
    const pending = n.status === 'PENDING';
    let h = '<div class="bubble ' + (pending ? '' : 'done') + '" id="n' + n.id + '">';
    h += '<div class="meta"><span class="tag ' + k[1] + '">' + k[0] + '</span><b>#' + n.id + '</b><span>收到：' + esc(when(n.date, n.phase)) + '</span>' + (n.reminded && pending ? '<span class="tag warn">已提醒</span>' : '') + '</div>';
    h += '<h3>' + esc(n.title) + '</h3>';
    if (n.ref) h += '<div class="dim">關於 ' + nidChip(n.ref) + '</div>';
    if (n.note) h += '<div class="dim">' + esc(n.note) + '</div>';
    if (pending && n.items.length) {
      const hasAi = n.items.some((i) => !i.cancelled && i.choices.some((c) => c.id === 'AI') && i.choices.some((c) => c.id === 'RULE' || c.id === 'DO'));
      const aiOnly = n.items.some((i) => !i.cancelled && (i.kind === 'AI_ONLY' || i.kind === 'HARD'));
      h += '<div class="ask">' + n.items.filter((i) => !i.cancelled).length + ' 項要你決定。' + (hasAi ? '規則和 AI 並列的項目預設照規則；' : '') + (aiOnly ? '只有 AI 建議的項目預設不做；' : '') + '選好後按「照清單做」，' + esc(sim.nextOpenLabel()) + '以開盤價成交。</div>';
    }
    if (pending && n.kind === 'CLASSIFY') h += '<div class="ask">回答這筆變動屬於哪一桶。回答之前月報不下單。</div>';
    for (const it of n.items) {
      h += '<div class="item ' + (it.cancelled ? 'cancelled' : '') + '"><div class="it-title">' + ftag(it.f) + ' ' + esc(it.title) + '</div>';
      if (it.note) h += '<div class="dim">' + esc(it.note) + '</div>';
      if (it.flags && it.flags.length) h += '<div class="dim">⚑ ' + esc(it.flags.join('；')) + '</div>';
      if (!it.cancelled) {
        const rule = it.choices.find((c) => c.id === 'RULE' || c.id === 'DO');
        if (rule) h += '<div class="lines">規則：<b>' + esc(linesTxt(rule.lines)) + '</b>' + (it.sameAsRule ? '（AI 檔位相同，只顯示一行）' : '') + '</div>';
        if (it.aiLine) h += '<div class="ai">' + esc(it.aiLine) + '</div>';
        if (pending && it.choices.length > 1) {
          h += '<div class="choices">' + it.choices.map((c) => '<button data-choice="' + n.id + '|' + it.key + '|' + c.id + '" class="' + (it.choice === c.id ? 'sel' : '') + '">' + esc(c.label) + '</button>').join('');
          for (const a of it.actions || []) h += '<button data-iact="' + n.id + '|' + it.key + '|' + a + '">' + { TRANSFER: '轉入自選', EXCLUDE: '排除', ADOPT: '認養' }[a] + '</button>';
          h += '<span class="dim">預設：' + esc((it.choices.find((c) => c.id === (it.defaultChoice || it.choices[0].id)) || {}).label || '') + '</span></div>';
        } else if (!pending) {
          const c = it.choices.find((x) => x.id === it.choice);
          h += '<div class="dim">你的選擇：<b>' + esc(c ? c.label : it.choice) + '</b></div>';
        }
        if (it.run) h += '<div><a data-run="' + esc(it.run) + '">理由與引用 → 網站</a></div>';
      }
      h += whyBlock(itemWhy(n, it), '為什麼有這一項');
      h += '</div>';
    }
    if (n.items.length && pending) {
      const comp = sim.compose(n);
      h += '<div class="merged"><div class="dim">合併後的下單清單（用 ' + esc(sim.signalDate()) + ' 收盤價換算股數；核心吸收差額）</div>';
      for (const m of comp.merged) {
        h += '<div class="row"><span>' + esc(m.tk) + '</span><span class="' + (m.shares > 0 ? 'buy' : m.shares < 0 ? 'sell' : '') + '">' + sharesTxt(m.shares) + '</span></div>';
        if (m.parts.length > 1 || m.parts[0].f === 'CORE') h += '<div class="dim" style="font-family:inherit">' + m.parts.map((p) => esc(E.BUCKET_NAME[p.bucket] + ' ' + signed(p.shares) + '：' + p.reason)).join('<br>') + '</div>';
      }
      if (!comp.merged.length) h += '<div>（沒有要下的單）</div>';
      h += '<div class="dim">成交後現金約 ' + U.money(comp.cashAfter) + (comp.cashAfter < 0 ? ' ⚠ 購買力不足' : '') + '</div></div>';
    } else if (n.composed && n.status !== 'SKIPPED') {
      h += '<div class="merged"><div class="dim">' + (n.fills && n.fills.length ? '成交' : '清單') + '</div>' + (n.fills && n.fills.length ? n.fills.map(esc).join('<br>') : n.composed.merged.map((m) => esc(m.tk + ' ' + sharesTxt(m.shares))).join('<br>') || '（沒有要下的單）') + '</div>';
    }
    for (const x of n.explain || []) h += '<div class="explain"><b>' + esc(x.f) + '</b> ' + esc(x.text) + (x.run ? ' <a data-run="' + esc(x.run) + '">→ 網站</a>' : '') + '</div>';
    if (n.text) h += '<div class="dim" style="white-space:pre-wrap">' + esc(n.text) + '</div>';
    if (n.runs && n.runs.length && !n.items.some((i) => i.run)) h += '<div><a data-run="' + esc(n.runs[0]) + '">完整報告 → 網站</a></div>';
    if (pending) {
      h += '<div class="actions">';
      if (n.kind === 'CLASSIFY') {
        h += '<button data-classify="' + n.id + '|own">自選（手動交易／新增自選）</button><button data-classify="' + n.id + '|mom">動能</button><button data-classify="' + n.id + '|core">核心</button>';
      } else if (!n.items.length) {
        h += '<button data-resp="' + n.id + '|READ">已讀</button>';
      } else if (n.reminded) {
        h += '<button class="primary" data-resp="' + n.id + '|ALL">忘了，給我補做清單</button><button data-resp="' + n.id + '|SKIP">這次不做</button>';
      } else {
        h += '<button class="primary" data-resp="' + n.id + '|ALL">照清單做</button><button data-resp="' + n.id + '|PARTIAL">部分完成</button><button data-resp="' + n.id + '|SKIP">這次不做</button>';
      }
      h += '</div>';
    } else {
      const st = { RESPONDED: '已回覆，等 ' + sim.nextOpenLabel() + '成交（按「下一步」）', DONE: '已成交（' + (n.execLabel || '') + '），你填了快照', SKIPPED: '這次不做（記影子）', READ: '已讀' }[n.status] || n.status;
      h += '<div class="status">' + esc(n.classified ? '已歸到' + n.classified : st) + '</div>';
    }
    if (n.followUpOpen) {
      h += '<div class="explain">快照和清單不同：' + esc(n.followUp.map((x) => x.tk + ' 清單 ' + sharesTxt(x.listed) + '，實際 ' + sharesTxt(x.done)).join('；')) + '</div><div class="actions"><button data-fu="' + n.id + '|1">補做差額（附清單）</button><button data-fu="' + n.id + '|0">就這樣（差額記影子）</button></div>';
    }
    const after = notifAfter(n);
    if (after.length) h += '<div class="after"><div class="ttl">這則通知之後</div>' + after.map((x) => '<div class="a"><span class="d">' + esc(when(x.e.date, x.e.phase)) + '</span><a data-log="' + x.i + '">' + esc(x.e.title) + '</a></div>').join('') + '</div>';
    return h + '</div>';
  }

  // ---------------------------------------------------------------- 中間
  function markTabs() { document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('sel', b.dataset.tab === ui.tab)); }
  function renderCenter() {
    const el = $('#centerBody');
    const f = { log: renderLog, web: renderWeb, table: renderTable, guide: renderGuide, notes: renderNotes }[ui.tab];
    el.innerHTML = '<div class="pane">' + f() + '</div>';
    if (ui.tab === 'notes') bindNotes();
    if (ui.tab === 'log') {
      const sel = $('#fSel'), ts = $('#tkSel');
      if (sel) sel.onchange = () => { ui.fFilter = sel.value; renderCenter(); };
      if (ts) ts.onchange = () => { ui.tkFilter = ts.value; renderCenter(); };
      if (ui.scrollLog === 'now') { const r = el.querySelector('.round.now'); if (r) el.scrollTop = Math.max(0, r.offsetTop - 50); }
      ui.scrollLog = null;
    }
  }

  function passFilter(e) {
    if (ui.fFilter === 'WARN') { if (!e.warn) return false; } else if (ui.fFilter && e.f !== ui.fFilter) return false;
    if (ui.tkFilter && !hasTk(e, ui.tkFilter)) return false;
    return true;
  }
  function renderEntry(x, routine, showDate) {
    const e = x.e;
    const you = isYou(e);
    let h = '<div class="le ' + (e.warn ? 'warn' : routine ? 'r' : 'key') + '" id="le' + x.i + '">' + (you ? '<span class="ftag c-you">你</span>' : ftag(e.f));
    h += '<div><div class="t">' + (showDate ? '<span class="dim">' + esc(when(e.date, e.phase)) + '</span> ' : '') + esc(e.title) + '</div>';
    const m = [];
    if (/^F\d+$/.test(e.f) && !routine) m.push('<span>' + esc(E.FNAME[e.f] || '') + '</span>');
    if (e.lvl) m.push('<span class="badge lvl" title="AI 權限等級">' + esc(LVL[e.lvl] || e.lvl) + '</span>');
    if (e.cls) m.push('<span class="badge cls-' + esc(e.cls) + '" title="通知等級">' + esc(CLS[e.cls] || e.cls) + '</span>');
    if (e.nid) m.push(nidChip(e.nid));
    if (e.run) m.push('<a data-run="' + esc(e.run) + '">AI 紀錄 →</a>');
    if (m.length) h += '<div class="m">' + m.join('') + '</div>';
    if (e.body) h += '<div class="b">' + esc(e.body) + '</div>';
    return h + '</div></div>';
  }
  function routineSummary(es) {
    const c = {};
    for (const x of es) {
      const e = x.e;
      const k = e.f === 'F9' ? 'R1 狀態切換' : e.f === 'F18' ? '每日事件掃描' : e.f === 'F24' && /排定/.test(e.title) ? '排定財報後審查' : e.f === 'F24' ? '自選審查沒有變化' : /崩盤/.test(e.title) ? '崩盤規則維持' : /波動/.test(e.title) ? '波動度比例維持' : e.f === 'F25' ? '條件沒成立' : '其他例行';
      c[k] = (c[k] || 0) + 1;
    }
    return Object.entries(c).map(([k, v]) => k + (v > 1 ? ' ×' + v : '')).join('、');
  }
  function renderLog() {
    const fs = Array.from(new Set(sim.log.map((e) => e.f))).sort((a, b) => (Number(a.slice(1)) || 99) - (Number(b.slice(1)) || 99));
    const tks = sim.market.tickers.filter((t) => sim.log.some((e) => hasTk(e, t)));
    let h = '<div class="logbar"><div class="seg"><button data-key="1" class="' + (ui.keyOnly ? 'sel' : '') + '">只看重點</button><button data-key="0" class="' + (!ui.keyOnly ? 'sel' : '') + '">全部</button></div>';
    h += '<select id="fSel"><option value="">所有功能</option>' + fs.map((f) => '<option value="' + f + '"' + (ui.fFilter === f ? ' selected' : '') + '>' + (f === 'SNAP' ? '快照' : f === 'SYS' ? '系統' : f + ' ' + (E.FNAME[f] || '')) + '</option>').join('') + '<option value="WARN"' + (ui.fFilter === 'WARN' ? ' selected' : '') + '>⚠ 規格未定</option></select>';
    h += '<select id="tkSel"><option value="">所有代號</option>' + tks.map((t) => '<option' + (ui.tkFilter === t ? ' selected' : '') + '>' + t + '</option>').join('') + '</select>';
    h += '<span class="dim">由上往下＝時間順序。每個圓點是你按的一次按鈕，底下是那一步發生的事。</span></div>';
    h += '<div class="legend-f"><span>' + ftag('F1') + ' 動能規則</span><span>' + ftag('F7') + ' 自選規則</span><span>' + ftag('F18') + ' 事件／AI</span><span>' + ftag('F11') + ' 使用者功能</span><span><span class="ftag c-you">你</span> 你的操作</span><span>' + ftag('SNAP') + ' 快照／帳本</span><span>' + ftag('SYS') + ' 系統</span></div>';

    const rounds = ui.rounds.slice();
    // 不屬於任何回合的紀錄（例如改選項）：掛到最後一個回合
    if (rounds.length && sim.log.length > rounds[rounds.length - 1].logTo) rounds[rounds.length - 1].logTo = sim.log.length;
    let quiet = [];
    const flushQuiet = () => {
      if (!quiet.length) return;
      const a = quiet[0], b = quiet[quiet.length - 1];
      h += '<div class="round k-jump"><span class="node"></span><div class="quiet">' + esc(when(a.fromDate, a.fromPhase)) + ' → ' + esc(when(b.toDate, b.toPhase)) + '：沒有符合篩選的紀錄' + (quiet.length > 1 ? '（' + quiet.length + ' 次前進）' : '') + '</div></div>';
      quiet = [];
    };
    rounds.forEach((r, ri) => {
      const isLast = ri === rounds.length - 1;
      const all = [];
      for (let i = r.logFrom; i < r.logTo; i++) if (passFilter(sim.log[i])) all.push({ i, e: sim.log[i] });
      const newN = sim.notifs.slice(r.notifFrom, r.notifTo);
      if (!isLast && r.kind === 'jump' && !all.some((x) => !isRoutine(x.e)) && !newN.length && !r.delta.length) { quiet.push(r); return; }
      flushQuiet();
      h += '<div class="round k-' + r.kind + (isLast ? ' now' : '') + '" id="r' + r.id + '"><span class="node"></span>';
      let span = '';
      if (r.kind === 'jump') span = esc(when(r.fromDate, r.fromPhase)) + ' → ' + esc(when(r.toDate, r.toPhase)) + (r.toD > r.fromD ? ' · ' + (r.toD - r.fromD) + ' 個交易日' : '');
      else span = esc(when(r.fromDate, r.fromPhase));
      if (r.detail) span += (span ? ' · ' : '') + '<span class="stop">' + esc(r.detail) + '</span>';
      h += '<div class="rhead"><div class="rlabel">' + esc(r.label) + '</div><div class="rspan">' + span + '</div></div>';
      if (!all.length) h += '<div class="quiet">' + (r.kind === 'jump' ? '這段時間沒有符合篩選的紀錄。' : '沒有紀錄。') + '</div>';
      // 依時點分組
      const groups = [];
      for (const x of all) { const key = x.e.date + '|' + x.e.phase; if (!groups.length || groups[groups.length - 1].key !== key) groups.push({ key, date: x.e.date, phase: x.e.phase, es: [] }); groups[groups.length - 1].es.push(x); }
      const showD = groups.length > 1 || r.kind === 'jump';
      let rq = [];
      const flushRoutine = () => {
        if (!rq.length) return;
        const es = rq.reduce((a, g) => a.concat(g.es), []);
        const a = rq[0], b = rq[rq.length - 1];
        h += '<div class="day">' + (showD ? '<div class="d">' + esc(when(a.date, a.phase)) + (rq.length > 1 ? ' → ' + esc(when(b.date, b.phase)) : '') + '</div>' : '') + '<details class="routine"><summary>例行檢查 ' + es.length + ' 條，沒改變什麼：' + esc(routineSummary(es)) + '</summary>' + es.map((x) => renderEntry(x, true, rq.length > 1)).join('') + '</details></div>';
        rq = [];
      };
      for (const g of groups) {
        if (ui.keyOnly) {
          const keys = g.es.filter((x) => !isRoutine(x.e)), rs = g.es.filter((x) => isRoutine(x.e));
          if (!keys.length) { rq.push({ date: g.date, phase: g.phase, es: rs }); continue; }
          flushRoutine();
          h += '<div class="day">' + (showD ? '<div class="d">' + esc(when(g.date, g.phase)) + '</div>' : '');
          for (const x of keys) h += renderEntry(x, false);
          if (rs.length) h += '<details class="routine"><summary>例行檢查 ' + rs.length + ' 條，沒改變什麼：' + esc(routineSummary(rs)) + '</summary>' + rs.map((x) => renderEntry(x, true)).join('') + '</details>';
          h += '</div>';
        } else {
          h += '<div class="day">' + (showD ? '<div class="d">' + esc(when(g.date, g.phase)) + '</div>' : '');
          for (const x of g.es) h += renderEntry(x, isRoutine(x.e));
          h += '</div>';
        }
      }
      flushRoutine();
      const sum = [];
      if (newN.length) sum.push('產生 ' + newN.map((n) => nidChip(n.id) + '<b>' + esc(n.title) + '</b>' + (n.items.length ? '（' + n.items.length + ' 項）' : '')).join('、'));
      if (r.delta.length) sum.push('帳本變動：<span class="d">' + r.delta.map((x) => esc(x.tk) + ' ' + signed(x.d)).join('、') + '</span>' + (r.cashDelta ? '；現金 ' + (r.cashDelta > 0 ? '+' : '−') + U.money(Math.abs(r.cashDelta)) : ''));
      if (sum.length) h += '<div class="rsum">' + sum.join('<br>') + '</div>';
      h += '</div>';
    });
    flushQuiet();
    return h;
  }

  // ---------------------------------------------------------------- 網站
  function renderWeb() {
    const subs = [['runs', 'AI 報告'], ['shadow', '影子組合'], ['crash', '崩盤規則'], ['stock', '個股時間軸'], ['lists', '排除／否決／觀察'], ['assume', '⚠ 規格未定（' + Object.keys(sim.assumptions).length + '）']];
    let h = '<div class="dim" style="margin-bottom:6px">網站：通知保持精簡，完整內容放這裡（設計 §6.6）。</div><div class="subnav">' + subs.map(([k, t]) => '<button data-web="' + k + '" class="' + (ui.web === k ? 'sel' : '') + '">' + t + '</button>').join('') + '</div>';
    if (ui.web === 'runs') h += ui.run ? runDetail(sim.aiRuns.find((r) => r.id === ui.run)) : runList();
    if (ui.web === 'shadow') h += shadowPage();
    if (ui.web === 'crash') h += crashPage();
    if (ui.web === 'stock') h += stockPage();
    if (ui.web === 'lists') h += listsPage();
    if (ui.web === 'assume') h += assumePage();
    return h;
  }
  function runList() {
    if (!sim.aiRuns.length) return '<div class="muted">還沒有 AI 紀錄。</div>';
    return sim.aiRuns.slice().reverse().map((r) => '<div class="card"><h4>' + ftag(r.f) + ' ' + esc(r.fname) + (r.tk ? ' · ' + esc(r.tk) : '') + '</h4><div class="dim">' + esc(r.created) + ' · 資料截至 ' + esc(r.as_of) + ' · ' + esc(r.model) + (r.vote ? ' · 票數 ' + esc(JSON.stringify(r.vote)) : '') + ' · 結論 <b>' + esc(r.verdict) + '</b></div><div>' + esc(r.summary) + '</div><a data-run="' + esc(r.id) + '">看完整紀錄</a></div>').join('');
  }
  function runDetail(r) {
    if (!r) return '';
    const related = [];
    sim.log.forEach((e, i) => { if (e.run === r.id) related.push({ i, e }); });
    let h = '<button data-run="">← 回列表</button> <button data-export="' + esc(r.id) + '">匯出給 AI（md）</button>';
    h += '<div class="card" style="margin-top:8px"><h4>' + esc(r.fname) + (r.tk ? ' · ' + esc(r.tk) : '') + '</h4><div class="dim">run_id ' + esc(r.id) + ' · ' + esc(r.created) + ' · 資料截至 ' + esc(r.as_of) + ' 收盤 · ' + esc(r.model) + ' · samples ' + (r.samples || 1) + '</div>';
    if (related.length) h += '<div class="dim">這份報告用在：' + related.map((x) => '<a data-log="' + x.i + '">' + esc(x.e.title) + '</a>').join('；') + '</div>';
    h += '<p><b>結論：' + esc(r.verdict) + '</b>' + (r.vote ? '　票數 ' + esc(JSON.stringify(r.vote)) : '') + (r.reason_code ? '　代碼 ' + esc(r.reason_code) : '') + '</p><p>' + esc(r.summary) + '</p>';
    if (r.ruleHits && r.ruleHits.length) h += '<div class="sec-t">規則偵測段命中（不用 LLM）</div><ul>' + r.ruleHits.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul>';
    if (r.premises && r.premises.length) h += '<div class="sec-t">前提逐條</div>' + r.premises.map((p) => '<div class="prem">' + esc(p.id) + ' ' + esc(p.text) + ' <span class="dim">（來源：' + esc({ USER: '使用者', AI_DRAFT_ACCEPTED: '使用者勾選的 AI 草稿', SYSTEM_DEFAULT: '系統預設' }[p.origin] || p.origin || '') + '）</span>' + (p.status ? ' → <span class="st-' + esc(p.status) + '">' + esc({ HOLDS: '成立', BROKEN: '不成立', INSUFFICIENT: '證據不足' }[p.status] || p.status) + '</span>' : '') + (p.evidence ? ' <span class="dim">' + esc(p.evidence) + '</span>' : '') + (p.breaks_if ? ' <span class="dim">不成立的訊號：' + esc(p.breaks_if) + '</span>' : '') + '</div>').join('');
    if (r.conditions && r.conditions.length) h += '<div class="sec-t">寫下的條件（交給 F25）</div><table><tr><th>id</th><th>類型</th><th>條件</th><th>成立時檔位</th><th>依據</th></tr>' + r.conditions.map((c) => '<tr><td>' + esc(c.id) + '</td><td>' + esc({ XBRL: '財報（程式比對）', EVENT: '事件（Sonnet ×3）', PRICE: '價格（只記錄）' }[c.kind] || c.kind) + '</td><td>' + esc(c.text) + '</td><td>' + esc(c.tier_if_met ? E.TIER_NAME[c.tier_if_met] : c.notify === false ? '不通知' : '') + '</td><td class="dim">' + esc(c.basis || '') + '</td></tr>').join('') + '</table>';
    if (r.evidence && r.evidence.length) h += '<div class="sec-t">證據（引用必須是證據包原文的子字串）</div><ul>' + r.evidence.map((e) => '<li>' + esc(e.id) + ' · ' + esc(e.source) + ' · ' + esc(e.date) + '：「' + esc(e.quote) + '」</li>').join('') + '</ul>';
    for (const s of r.sections || []) h += '<div class="sec-t">' + esc(s.title) + '</div><div style="white-space:pre-wrap">' + esc(s.text) + '</div>';
    if (r.lift) h += '<div class="sec-t">解除否決條件</div><div>' + esc(r.lift) + '</div>';
    const shell = { run_id: r.id, function: r.f, as_of: r.as_of, model: r.model, samples: r.samples, verdict: r.verdict, vote: r.vote, premise_checks: (r.premises || []).map((p) => ({ premise_id: p.id, status: p.status })), evidence: r.evidence, payload: r.conditions && r.conditions.length ? { tier: r.verdict, conditions: r.conditions } : {} };
    h += '<details><summary class="dim">輸出外殼 JSON（ai_layer §2.2）</summary><pre class="json">' + esc(JSON.stringify(shell, null, 2)) + '</pre></details>';
    h += '<div id="exportBox"></div></div>';
    return h;
  }
  function exportMd(r) {
    const lines = ['# 背景', '', '帳戶分桶：自選 ' + U.pct(sim.settings.ratio.own, 0) + ' / Strategy ' + U.pct(sim.settings.ratio.strat, 0) + ' / 核心 ' + U.pct(sim.settings.ratio.core, 0) + '。崩盤規則：' + (sim.crash.on ? '啟動中' : '未啟動') + '。', '', '# 這次事件', '', '- 功能：' + r.f + ' ' + r.fname + (r.tk ? '（' + r.tk + '）' : ''), '- 資料截至：' + r.as_of, '- 結論：' + r.verdict + (r.vote ? '，票數 ' + JSON.stringify(r.vote) : ''), '', r.summary, ''];
    for (const s of r.sections || []) lines.push('## ' + s.title, '', s.text, '');
    lines.push('# 請你做的事', '', '你是反方審查員。請檢查上面這份報告：證據是否足以支持結論？有沒有用到證據以外的數字？有沒有被近期股價帶著走？如果你是使用者，還需要知道什麼才能做決定？');
    return lines.join('\n');
  }
  function shadowPage() {
    let h = '<p class="muted">每一次有 AI 並列、使用者沒照規則、或 AI 有意見（崩盤規則）時都記一筆。數字＝（現價 − 當時價）× 股數差，粗略看「照 AI」「實際」相對「照規則」多賺或少賺多少（不含之後的交易）。設計上有三條線：照規則、照 AI、使用者實際。</p>';
    if (!sim.shadow.length) return h + '<div class="muted">還沒有紀錄。</div>';
    let sa = 0, su = 0;
    h += '<table><tr><th>日期</th><th>功能</th><th>代號</th><th>事件</th><th class="num">照規則</th><th class="num">照 AI</th><th class="num">實際</th><th class="num">AI − 規則</th><th class="num">實際 − 規則</th></tr>';
    for (const s of sim.shadow) {
      const dp = s.tk ? sim.price(s.tk) - s.price0 : 0;
      const a = s.ai === null ? null : (s.ai - s.rule) * dp;
      const u = (s.actual - s.rule) * dp;
      if (a !== null) sa += a; su += u;
      h += '<tr><td>' + esc(s.date) + '</td><td>' + esc(s.f) + '</td><td>' + esc(s.tk || '') + '</td><td>' + esc(s.title || '') + (s.aiOpinion ? '（AI 意見：' + esc(s.aiOpinion) + '）' : '') + (s.ratioOld ? '（' + esc(JSON.stringify(s.ratioOld)) + ' → ' + esc(JSON.stringify(s.ratioNew)) + '）' : '') + '</td><td class="num">' + (s.tk ? s.rule : '') + '</td><td class="num">' + (s.ai === null ? '—' : s.ai) + '</td><td class="num">' + (s.tk ? s.actual : '') + '</td><td class="num">' + (a === null ? '—' : U.money(a)) + '</td><td class="num">' + (s.tk ? U.money(u) : '') + '</td></tr>';
    }
    h += '<tr><th colspan="7">合計</th><th class="num">' + U.money(sa) + '</th><th class="num">' + U.money(su) + '</th></tr></table>';
    h += '<p class="dim">崩盤規則的 AI 意見（照做／延後）也記在這裡；「如果延後一個月」的結果要等下個月才知道。改比例那一筆，真正的系統會繼續跑「如果沒改」的整個影子組合，原型只記錄。</p>';
    return h;
  }
  function crashPage() {
    const s = sim.sIdx();
    const voo = sim.price('VOO'), ma = U.sma(sim.market.close.VOO, s, 200);
    let h = '<div class="card"><h4>目前：' + (sim.crash.on ? '啟動中（核心一半在短債、動能減半）' : '未啟動') + '</h4>VOO ' + U.px(voo) + '，200 日均線 ' + U.px(ma) + '（' + U.spct(voo / ma - 1) + '）。每月第一個交易日用前一日收盤判斷。</div>';
    const recs = [];
    for (const n of sim.notifs) for (const it of n.items) if ((it.f === 'F5' || it.f === 'F6') && n.status === 'DONE' && it.choice !== 'SKIP') recs.push({ f: it.f, date: n.execLabel, px: sim.openPx('VOO', sim.market.days.indexOf(n.execLabel.slice(0, 10))), op: it.aiOpinion });
    h += '<div class="sec-t">這次帳戶的保險紀錄</div>';
    if (!recs.length) h += '<div class="muted">還沒有啟動或解除。</div>';
    else {
      h += '<table><tr><th>動作</th><th>成交</th><th class="num">VOO 開盤價</th><th>AI 意見</th></tr>' + recs.map((r) => '<tr><td>' + (r.f === 'F5' ? '啟動：賣 VOO' : '解除：買回 VOO') + '</td><td>' + esc(r.date) + '</td><td class="num">' + U.px(r.px) + '</td><td>' + esc(r.op || '') + '</td></tr>').join('') + '</table>';
      const on = recs.find((r) => r.f === 'F5'), off = recs.find((r) => r.f === 'F6');
      if (on && off) h += '<p><b>買回價相對賣出價：' + U.spct(off.px / on.px - 1) + '</b>（正數＝買回更貴，這就是保險費）</p>';
    }
    h += '<div class="sec-t">基準率：2000–2026 每次觸發（ai_layer §3.3，真實回測數字）</div><table><tr><th>啟動</th><th>解除</th><th class="num">月數</th><th class="num">買回價／賣出價</th></tr>' + BASERATE.map((r) => '<tr><td>' + r[0] + '</td><td>' + r[1] + '</td><td class="num">' + r[2] + '</td><td class="num">' + r[3] + '</td></tr>').join('') + '</table><p class="dim">17 次中 3 次是真空頭（買回便宜 13～34%），13 次買回更貴。AI 意見的成績在上線後才會累積。</p>';
    return h;
  }
  function stockPage() {
    const tks = Object.keys(sim.snap.shares).filter((t) => sim.snap.shares[t] && t !== 'SGOV').concat(Object.keys(sim.own)).filter((v, i, a) => a.indexOf(v) === i);
    if (!ui.tk || !tks.includes(ui.tk)) ui.tk = tks[0];
    let h = '<div class="subnav">' + tks.map((t) => '<button data-tk="' + t + '" class="' + (t === ui.tk ? 'sel' : '') + '">' + t + '</button>').join('') + '</div>';
    const tk = ui.tk;
    const o = sim.own[tk];
    if (o) {
      h += '<div class="card"><h4>' + esc(tk) + ' 自選：' + (o.state === 'HALF' ? '減半狀態' : '標準狀態') + '，標準比重 ' + U.pct(o.std) + '</h4>';
      h += '<div class="sec-t">這檔的前提</div>' + (o.premises.length ? o.premises.map((p) => '<div class="prem">' + esc(p.id + ' ' + p.text) + ' <span class="dim">（' + esc({ USER: '使用者', AI_DRAFT_ACCEPTED: '使用者勾選的 AI 草稿', SYSTEM_DEFAULT: '系統預設' }[p.origin] || p.origin) + '）</span></div>').join('') : '<div class="muted">（沒有）</div>');
      h += '<div class="sec-t">F25 正在監測的條件</div>' + (o.conditions.length ? o.conditions.map((c) => '<div class="prem">' + esc(c.id + ' [' + c.kind + '] ' + c.text) + (o.metConds[c.id] ? ' <b class="st-BROKEN">已成立 ' + esc(o.metConds[c.id]) + '</b>' : '') + '</div>').join('') : '<div class="muted">（還沒有；第一次 F24 之後才有）</div>') + '</div>';
    }
    const es = [];
    sim.log.forEach((e, i) => { if (hasTk(e, tk) && !isRoutine(e)) es.push({ i, e }); });
    h += '<div class="sec-t">時間軸（規則狀態、AI 報告、交易；不含例行檢查）</div>' + (es.length ? es.map((x) => '<div class="le key"><span class="ftag ' + fcat(x.e.f) + '">' + esc(x.e.f === 'SNAP' ? '快照' : x.e.f === 'SYS' ? '系統' : x.e.f) + '</span><div><span class="dim">' + esc(when(x.e.date, x.e.phase)) + '</span> <a class="t" data-log="' + x.i + '">' + esc(x.e.title) + '</a>' + (x.e.nid ? ' ' + nidChip(x.e.nid) : '') + (x.e.run ? ' <a data-run="' + esc(x.e.run) + '">AI →</a>' : '') + '</div></div>').join('') : '<div class="muted">（還沒有）</div>');
    return h;
  }
  function listsPage() {
    let h = '<div class="sec-t">排除清單（動能，可隨時取消）</div>';
    const ex = Object.entries(sim.mom.excluded);
    h += ex.length ? ex.map(([tk, x]) => '<div>' + esc(tk) + '：' + esc(x.reason) + '（' + esc(x.date) + '）<button data-unexclude="' + tk + '">取消排除</button></div>').join('') : '<div class="muted">（空）</div>';
    h += '<div class="sec-t">任務 A 否決紀錄</div>';
    const ve = Object.entries(sim.mom.vetoes);
    h += ve.length ? ve.map(([tk, x]) => '<div>' + esc(tk) + '：' + esc(x.reason) + '（' + esc(x.month) + '）解除條件：' + esc(x.lift || '下個月重審') + '</div>').join('') : '<div class="muted">（空）</div>';
    h += '<div class="sec-t">准許但觀察（ALLOW_WATCH）</div>';
    const w = Object.entries(sim.mom.watch);
    h += w.length ? w.map(([tk, x]) => '<div>' + esc(tk) + '：' + esc(x) + '</div>').join('') : '<div class="muted">（空）</div>';
    h += '<div class="sec-t">認養</div>';
    const ad = Object.entries(sim.mom.adopted);
    h += ad.length ? ad.map(([tk, x]) => '<div>' + esc(tk) + '：' + esc(x.reason || '') + '（' + esc(x.date) + '）</div>').join('') : '<div class="muted">（空）</div>';
    return h;
  }
  function assumePage() {
    const a = Object.entries(sim.assumptions);
    let h = '<p class="muted">原型跑到設計文件沒寫清楚的地方時，先用一個假設繼續跑，並記在這裡。這些是要你決定的地方。（只列這次操作有碰到的。）</p>';
    if (!a.length) return h + '<div class="muted">這次操作還沒碰到。</div>';
    return h + a.map(([k, x]) => '<div class="note"><b>' + esc(x.first) + '</b> ' + esc(x.text) + '</div>').join('');
  }

  function renderTable() {
    let h = '<p class="muted">設計 §2.0 的觸發功能總表；右邊兩欄是這次操作中各功能被觸發的次數與最後一次的日期。AI 權限：A0 無／A1 說明／A2 前提檢查（只記影子）／A3 升級給人或並列建議／A4 否決。</p><table><tr><th>#</th><th>功能</th><th>觸發</th><th>AI 工作</th><th>AI 權限</th><th>通知</th><th class="num">次數</th><th>最後</th></tr>';
    for (const r of TABLE) {
      const n = sim.counters[r[0]] || 0;
      let lastI = -1;
      for (let i = sim.log.length - 1; i >= 0; i--) if (sim.log[i].f === r[0]) { lastI = i; break; }
      h += '<tr' + (n ? ' style="background:var(--accent-soft)"' : '') + '><td>' + ftag(r[0]) + '</td>' + r.slice(1).map((c) => '<td>' + esc(c) + '</td>').join('') + '<td class="num">' + n + '</td><td class="dim">' + (lastI >= 0 ? '<a data-log="' + lastI + '">' + esc(sim.log[lastI].date) + '</a>' : '') + '</td></tr>';
    }
    return h + '</table><p class="dim">F18 的次數包含沒事的日子。點最後日期可以跳到那條紀錄。</p>';
  }
  function renderGuide() {
    const sc = sim.scen, g = sc.guide || {};
    let h = '<h2 style="margin-top:0">' + esc(sc.title) + '</h2><p>' + esc(sc.summary) + '</p>';
    h += '<div class="sec-t">怎麼用這個原型</div><ul class="guide"><li><b>上方「現在」</b>：時間軸上每個點是一則通知（紅圈＝等你回覆），黑線是現在。右邊的大按鈕永遠是「接下來該按什麼」。</li><li><b>時間</b>：每個交易日分「開盤前（台灣早上）」與「收盤後」兩個時點。月報在每月第一個交易日開盤前發；當天通知在收盤後發、隔天開盤執行。</li><li><b>回覆</b>：在左邊的 LINE 選照規則／照 AI／這次不做，按「照清單做」。再按「下一步」才會以開盤價成交，原型會自動幫你「填快照」。每一項都可以展開「為什麼有這一項」。</li><li><b>不回覆也可以</b>：時間照樣前進（看「忘了」怎麼處理）。</li><li><b>自己操作</b>：LINE 下方的入金、出金、改比例、新增自選、手動交易，任何時候都能按。</li><li><b>看背後</b>：中間「時間軸」以你按的每一次按鈕為單位，列出那一步發生的事；例行檢查預設收起來。通知處理完後，氣泡底下會列出「這則通知之後」發生的事。</li><li><b>記疑問</b>：覺得「這跟我想的不一樣」時，到「疑問筆記」記一筆（會附上情境與日期），最後匯出成 md 給我。</li></ul>';
    if (g.focus) h += '<div class="sec-t">這個情境看什麼</div><ul class="guide">' + g.focus.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul>';
    if (g.tasks) h += '<div class="sec-t">建議操作</div><ul class="guide">' + g.tasks.map((x) => '<li><b>' + esc(x.when) + '</b>　' + esc(x.text) + '</li>').join('') + '</ul>';
    if (g.questions) h += '<div class="sec-t">操作時問自己</div><ul class="guide">' + g.questions.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul>';
    h += '<div class="sec-t">原型和真正系統的差別</div><ul class="guide"><li>價格是假資料（26 檔縮小版股票池），新聞與申報是虛構事件，AI 輸出是預先寫好的。</li><li>沒有做：換 strategy（F22）、劃撥、股利、入金遇到月報日的合併、零股、單位淨值、完整影子組合。</li><li>跑到設計沒寫清楚的地方，原型會先假設並在時間軸標 ⚠，集中在「網站 → ⚠ 規格未定」。</li></ul>';
    h += '<div class="actions"><button class="primary" data-tab="log">開始：到時間軸</button></div>';
    return h;
  }

  // 疑問筆記
  function getNotes() { try { return JSON.parse(localStorage.getItem('stockbot-proto-notes') || '[]'); } catch (e) { return ui.memNotes || []; } }
  function setNotes(a) { ui.memNotes = a; try { localStorage.setItem('stockbot-proto-notes', JSON.stringify(a)); } catch (e) { /* 存不了就只留在記憶體 */ } }
  function renderNotes() {
    const notes = getNotes();
    let h = '<p class="muted">操作時覺得「這和我想的不一樣」「這裡會卡住」就記下來。會自動附上情境與模擬日期。筆記存在這個瀏覽器裡，最後按「匯出」把 md 交給我。</p>';
    h += '<textarea id="noteText" placeholder="例如：MU 減半通知同時列出規則和 AI，我分不清要按哪個……"></textarea><div class="actions"><button class="primary" id="noteAdd">記下</button><button id="noteExport">匯出成 md</button><button id="noteClear">全部清除</button></div><div id="noteOut"></div>';
    h += notes.slice().reverse().map((n, i) => '<div class="note"><div class="dim">' + esc(n.scen) + ' · 模擬日 ' + esc(n.date) + ' · 記於 ' + esc(n.ts) + ' <a data-delnote="' + (notes.length - 1 - i) + '">刪除</a></div><div style="white-space:pre-wrap">' + esc(n.text) + '</div></div>').join('');
    return h;
  }
  function bindNotes() {
    $('#noteAdd').onclick = () => {
      const t = $('#noteText').value.trim(); if (!t) return;
      const a = getNotes();
      a.push({ scen: sim.scen.title, date: sim.dateLabel(), ts: new Date().toLocaleString(), text: t });
      setNotes(a); renderCenter();
    };
    $('#noteClear').onclick = () => { setNotes([]); renderCenter(); };
    $('#noteExport').onclick = () => {
      const a = getNotes();
      const md = '# stock bot 原型：操作疑問\n\n' + a.map((n) => '## ' + n.scen + '（' + n.date + '）\n\n' + n.text + '\n').join('\n') + '\n## 原型記下的「規格未定」\n\n' + Object.values(sim.assumptions).map((x) => '- ' + x.text).join('\n') + '\n';
      $('#noteOut').innerHTML = '<textarea style="min-height:200px" readonly>' + esc(md) + '</textarea>';
      try {
        const url = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }));
        $('#noteOut').innerHTML += '<a download="stock_bot_prototype_notes.md" href="' + url + '">下載 md 檔</a>';
      } catch (e) { /* 只顯示文字 */ }
    };
  }

  // ---------------------------------------------------------------- 右邊
  function renderRight() {
    const T = sim.total();
    const r = sim.settings.ratio;
    const bv = { own: sim.bucketValue('own'), mom: sim.bucketValue('mom'), core: sim.bucketValue('core') };
    const base = ui.base || { shares: {}, cash: sim.snap.cash };
    const cashD = sim.snap.cash - base.cash;
    let h = '<div class="kpi"><span class="big">' + U.money(T) + '</span><span class="dim">總資產（' + esc(sim.signalDate()) + ' 收盤）· 現金 ' + U.money(sim.snap.cash) + (cashD ? '（上一回合 ' + (cashD > 0 ? '+' : '−') + U.money(Math.abs(cashD)) + '）' : '') + '</span></div>';
    for (const [b, budget, c] of [['own', r.own, 'var(--own)'], ['mom', r.strat, 'var(--mom)'], ['core', r.core, 'var(--core)']]) {
      h += '<div class="bucket"><div style="display:flex;justify-content:space-between;font-size:13px"><span>' + E.BUCKET_NAME[b] + (b === 'mom' ? '（Strategy）' : '') + '</span><span class="mono">' + U.money(bv[b]) + ' · ' + U.pct(bv[b] / T) + ' <span class="dim">預算 ' + U.pct(budget, 0) + '</span></span></div><div class="bar"><span style="width:' + Math.min(100, bv[b] / T * 100) + '%;background:' + c + '"></span><i style="left:' + budget * 100 + '%" title="預算 ' + U.pct(budget, 0) + '"></i></div></div>';
    }
    h += '<div class="chips"><span class="chip2 ' + (sim.crash.on ? 'on' : '') + '">崩盤規則：' + (sim.crash.on ? '啟動中' : '未啟動') + '</span><span class="chip2 ' + (sim.mom.w < 1 ? 'on' : '') + '">動能比例 ' + U.thirdLabel(sim.mom.w) + '</span><span class="chip2 ' + (sim.stratDD() < -0.2 ? 'on' : '') + '">動能相對 SPY ' + U.spct(sim.stratDD(), 0) + (sim.strat.eventStart ? '（落後事件自 ' + esc(sim.strat.eventStart) + '）' : '') + '</span></div>';
    const rk = sim.ranks();
    const tks = Object.keys(sim.snap.shares).filter((t) => sim.snap.shares[t]).concat(Object.keys(sim.own), Object.keys(sim.lots.unc), Object.keys(base.shares).filter((t) => base.shares[t])).filter((v, i, a) => a.indexOf(v) === i);
    tks.sort((a, b) => (sim.snap.shares[b] || 0) * sim.price(b) - (sim.snap.shares[a] || 0) * sim.price(a));
    const anyD = tks.some((t) => (sim.snap.shares[t] || 0) !== (base.shares[t] || 0));
    h += '<div class="sec"><span>持股</span><span class="dim">點一下看走勢' + (anyD ? '；綠底＝上一回合有變動' : '') + '</span></div><div style="padding:0 6px"><table><tr><th>代號</th><th class="num">券商</th>' + (anyD ? '<th class="num">變動</th>' : '') + '<th class="num">自選/動能/核心</th><th class="num">占比</th><th>狀態</th></tr>';
    for (const tk of tks) {
      const n = sim.snap.shares[tk] || 0;
      const d = n - (base.shares[tk] || 0);
      const sp = ['own', 'mom', 'core'].map((b) => sim.lots[b][tk] || 0);
      const unc = sim.lots.unc[tk] || 0;
      let st = '';
      const o = sim.own[tk];
      if (o) { const ind = sim.ind(tk); st += '<span class="' + (o.state === 'HALF' ? 'st-half' : '') + '">' + (o.state === 'HALF' ? '減半' : '標準') + ' ' + U.pct(o.std, 1) + '</span> 距高 ' + U.pct(ind.dd, 0) + (o.aboveRun ? ' · 均線上 ' + o.aboveRun + ' 天' : '') + (o.r1 ? ' · R1' : ''); }
      if (sim.mom.model.includes(tk) || sim.lots.mom[tk]) st += (st ? '<br>' : '') + '動能排名 ' + (rk.map[tk] ? rk.map[tk].rank : '—') + (sim.mom.model.includes(tk) ? '' : '（不在名單）');
      if (unc) st += '<br><b>未分類 ' + unc + ' 股</b>';
      if (!n && !o) st += (st ? '<br>' : '') + '已出清';
      h += '<tr class="clickable ' + (tk === ui.tk ? 'selrow' : '') + (d ? ' changed' : '') + '" data-chart="' + tk + '"><td><b>' + tk + '</b></td><td class="num">' + n + '</td>' + (anyD ? '<td class="num ' + (d > 0 ? 'buy' : d < 0 ? 'sell' : '') + '">' + (d ? signed(d) : '') + '</td>' : '') + '<td class="num">' + sp.join(' / ') + '</td><td class="num">' + U.pct(n * sim.price(tk) / T) + '</td><td style="font-size:12px">' + st + '</td></tr>';
    }
    h += '</table></div>';
    h += '<div class="sec"><span>' + esc(ui.tk || '') + ' 走勢</span></div><div class="legend"><span style="--c:var(--s1)">收盤</span><span style="--c:var(--s2)">200 日均線</span><span class="dash" style="--c:var(--ink-3)">52 週高點 -20%（減半線）</span></div><div class="chartbox"><canvas id="chart"></canvas><div class="tip" id="tip"></div></div>';
    h += '<div class="sec"><span>動能排名（252 日報酬）</span></div><div style="padding:0 12px 12px;font-size:12px" class="mono">' + rk.list.slice(0, 16).map((x, k) => (k + 1) + '. ' + x.tk + ' ' + U.spct(x.r, 0) + (sim.mom.model.includes(x.tk) ? ' ●' : '') + (sim.mom.excluded[x.tk] ? ' 排除' : '')).join('<br>') + '<div class="dim">● 動能名單；前 5 名進場、掉出前 15 名出場</div></div>';
    $('#acct').innerHTML = h;
    drawChart();
  }
  function drawChart() {
    const cv = $('#chart'); if (!cv || !ui.tk || !sim.market.close[ui.tk]) return;
    const dpr = window.devicePixelRatio || 1;
    const W = cv.clientWidth, H = cv.clientHeight;
    cv.width = W * dpr; cv.height = H * dpr;
    const ctx = cv.getContext('2d'); ctx.scale(dpr, dpr);
    const cs = getComputedStyle(document.documentElement);
    const col = (v) => cs.getPropertyValue(v).trim();
    const c = sim.market.close[ui.tk];
    const end = sim.sIdx(), start = Math.max(260, end - 200);
    const xs = [], cl = [], ma = [], hl = [];
    for (let i = start; i <= end; i++) { xs.push(i); cl.push(c[i]); ma.push(U.sma(c, i, 200)); hl.push(U.maxBack(c, i, 252) * 0.8); }
    const all = cl.concat(ma, hl);
    let lo = Math.min(...all), hi = Math.max(...all); const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
    const L = 44, R = 6, Tp = 6, B = 18;
    const X = (k) => L + (W - L - R) * k / Math.max(1, xs.length - 1);
    const Y = (v) => Tp + (H - Tp - B) * (1 - (v - lo) / (hi - lo));
    ctx.font = '11px system-ui'; ctx.fillStyle = col('--ink-3'); ctx.strokeStyle = col('--line'); ctx.lineWidth = 1;
    for (let g = 0; g <= 3; g++) { const v = lo + (hi - lo) * g / 3; ctx.beginPath(); ctx.moveTo(L, Y(v)); ctx.lineTo(W - R, Y(v)); ctx.stroke(); ctx.fillText(v.toFixed(0), 4, Y(v) + 4); }
    const k0 = sim.market.idx0 - start;
    if (k0 > 0 && k0 < xs.length) { ctx.strokeStyle = col('--ink-3'); ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.moveTo(X(k0), Tp); ctx.lineTo(X(k0), H - B); ctx.stroke(); ctx.setLineDash([]); ctx.fillText('情境開始', X(k0) + 3, H - 5); }
    // 這檔的通知日
    for (const n of sim.notifs) if (n.items.some((i) => i.tk === ui.tk)) { const k = n.d - start; if (k >= 0 && k < xs.length) { ctx.fillStyle = col(n.kind === 'URGENT' ? '--bad' : '--accent'); ctx.beginPath(); ctx.arc(X(k), Y(cl[k]), 3.5, 0, Math.PI * 2); ctx.fill(); } }
    const line = (arr, color, dash) => { ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.setLineDash(dash || []); ctx.beginPath(); arr.forEach((v, k) => { if (v === null) return; k ? ctx.lineTo(X(k), Y(v)) : ctx.moveTo(X(k), Y(v)); }); ctx.stroke(); ctx.setLineDash([]); };
    line(hl, col('--ink-3'), [4, 3]); line(ma, col('--s2')); line(cl, col('--s1'));
    const tip = $('#tip');
    cv.onmousemove = (ev) => {
      const rect = cv.getBoundingClientRect(); const x = ev.clientX - rect.left;
      const k = Math.round((x - L) / (W - L - R) * (xs.length - 1));
      if (k < 0 || k >= xs.length) { tip.style.display = 'none'; return; }
      tip.style.display = 'block'; tip.style.left = Math.min(W - 150, Math.max(0, X(k) + 8)) + 'px'; tip.style.top = '8px';
      tip.innerHTML = esc(sim.dateKey(xs[k])) + '<br>收盤 ' + U.px(cl[k]) + '<br>200 日均線 ' + U.px(ma[k]) + '<br>減半線 ' + U.px(hl[k]);
    };
    cv.onmouseleave = () => { tip.style.display = 'none'; };
  }

  // ---------------------------------------------------------------- 對話框
  function modal(html, onOk) {
    $('#modalBox').innerHTML = html + '<div class="actions" style="margin-top:10px"><button class="primary" id="mOk">確定</button><button id="mCancel">取消</button></div>';
    $('#modal').style.display = 'flex';
    $('#mCancel').onclick = closeModal;
    $('#mOk').onclick = () => { const r = onOk(); if (r !== false) closeModal(); };
  }
  function closeModal() { $('#modal').style.display = 'none'; }
  function num(id) { return Number(($(id).value || '').replace(/[, $]/g, '')); }

  const ACTS = {
    deposit() { modal('<h3>入金（F11）</h3><p class="dim">你回報「入金 X 元」，系統當天給一份只買不賣的清單。</p><div class="formrow">金額 $ <input id="mAmt" value="10000"></div>', () => { const x = num('#mAmt'); if (!(x > 0)) return false; act('你入金 ' + U.money(x), () => sim.deposit(x)); }); },
    withdraw() { modal('<h3>出金（F12）</h3><p class="dim">你回報「要出金 X 元」，系統當天給一份只賣不買的清單；成交後你把錢轉出。</p><div class="formrow">金額 $ <input id="mAmt" value="30000"></div>', () => { const x = num('#mAmt'); if (!(x > 0) || x > sim.total()) return false; act('你出金 ' + U.money(x), () => sim.withdraw(x)); }); },
    ratio() {
      const r = sim.settings.ratio;
      modal('<h3>改比例（F13）</h3><p class="dim">比例是風險預算，不是要維持的目標。改比例當天給清單；系統附上動能目前的相對回撤狀態，AI 不評論。</p><div class="formrow">自選 <input id="mO" size="4" value="' + Math.round(r.own * 100) + '">% Strategy <input id="mS" size="4" value="' + Math.round(r.strat * 100) + '">% 核心 <input id="mC" size="4" value="' + Math.round(r.core * 100) + '">%</div><div class="dim">目前動能相對 SPY ' + U.spct(sim.stratDD(), 0) + '</div>', () => {
        const o = num('#mO'), s = num('#mS'), c = num('#mC');
        if (Math.abs(o + s + c - 100) > 0.01) { alertBox('三個加起來要是 100%'); return false; }
        const old = Math.round(r.own * 100) + '/' + Math.round(r.strat * 100) + '/' + Math.round(r.core * 100);
        act('你改比例 ' + old + ' → ' + o + '/' + s + '/' + c, () => sim.changeRatio({ own: o / 100, strat: s / 100, core: c / 100 }));
      });
    },
    addOwn() {
      const opts = sim.market.universe.filter((t) => !sim.own[t]).map((t) => '<option value="' + t + '">' + t + ' ' + esc(sim.market.info[t].name) + '</option>').join('');
      modal('<h3>新增自選（F14）</h3><p class="dim">自選股是你自己買的，系統不替你決定要不要買。健檢只提供資訊。</p><div class="formrow">代號 <select id="mTk">' + opts + '</select></div><div class="sec-t">這檔的前提（三層備案）</div><div class="formrow"><label><input type="radio" name="pm" value="USER" checked> ① 我自己寫（一行一條：買進理由與出場條件）</label></div><textarea id="mUser" placeholder="例如：AI 伺服器出貨兩年內持續成長&#10;毛利率跌破 70% 就賣"></textarea><div class="formrow"><label><input type="radio" name="pm" value="AI_DRAFT_ACCEPTED"> ② 讓 AI 草擬「這個價格隱含的前提」，我勾選</label> <button id="mDraft">產生草稿</button></div><div id="mDrafts"></div><div class="formrow"><label><input type="radio" name="pm" value="SYSTEM_DEFAULT"> ③ 用系統預設前提</label></div>', () => {
        const tk = $('#mTk').value;
        const mode = document.querySelector('input[name=pm]:checked').value;
        let items = [];
        if (mode === 'USER') { items = $('#mUser').value.split('\n').map((x) => x.trim()).filter(Boolean); if (!items.length) { alertBox('沒有寫前提：請寫，或改選 ② / ③'); return false; } }
        if (mode === 'AI_DRAFT_ACCEPTED') { items = Array.from(document.querySelectorAll('input[data-draft]:checked')).map((x) => JSON.parse(x.dataset.draft)); if (!items.length) { alertBox('請先產生草稿並勾選至少一條，或改選 ③'); return false; } }
        act('你新增自選 ' + tk, () => sim.addOwn(tk, { origin: mode, items }), '前提來源：' + { USER: '自己寫', AI_DRAFT_ACCEPTED: 'AI 草稿', SYSTEM_DEFAULT: '系統預設' }[mode]);
      });
      $('#mDraft').onclick = () => {
        const tk = $('#mTk').value;
        const ds = G.AI.draftPremises(sim, tk);
        $('#mDrafts').innerHTML = '<div class="dim">🤖 模擬的 AI 草稿（至少一條是不容易想到的風險）</div>' + ds.map((d) => '<label style="display:block"><input type="checkbox" data-draft="' + esc(JSON.stringify(d)) + '" checked> ' + esc(d.text) + ' <span class="dim">（不成立的訊號：' + esc(d.breaks_if) + '）</span></label>').join('');
        document.querySelector('input[name=pm][value=AI_DRAFT_ACCEPTED]').checked = true;
      };
    },
    removeOwn() {
      const opts = Object.keys(sim.own).map((t) => '<option>' + t + '</option>').join('');
      if (!opts) return alertBox('沒有自選股');
      modal('<h3>移除自選（F15）</h3><div class="formrow">代號 <select id="mTk">' + opts + '</select></div><p class="dim">賣掉的錢交給核心；記影子（如果繼續持有）。</p>', () => { const tk = $('#mTk').value; act('你移除自選 ' + tk, () => sim.removeOwn(tk)); });
    },
    manual() {
      const opts = sim.market.tickers.filter((t) => t !== 'SGOV').map((t) => '<option>' + t + '</option>').join('');
      modal('<h3>手動交易（你自己在 Firstrade 下的單）</h3><p class="dim">原型以目前價格成交，然後模擬你填快照。快照出現清單外的變動，系統會問屬於哪一桶。</p><div class="formrow">代號 <select id="mTk">' + opts + '</select> 股數 <input id="mQ" size="6" value="10"> <span class="dim">（負數＝賣）</span></div>', () => {
        const q = Math.round(num('#mQ')); const tk = $('#mTk').value;
        if (!q) return false;
        if (q < 0 && (sim.snap.shares[tk] || 0) < -q) { alertBox('持股不夠'); return false; }
        act('你手動' + (q > 0 ? '買進' : '賣出') + ' ' + tk + ' ' + Math.abs(q) + ' 股', () => sim.manualTrade(tk, q));
      });
    },
  };
  function alertBox(msg) {
    const d = document.createElement('div'); d.className = 'explain'; d.style.color = 'var(--bad)'; d.textContent = msg;
    $('#modalBox').insertBefore(d, $('#modalBox').querySelector('.actions'));
    setTimeout(() => d.remove(), 2500);
    return false;
  }
  function askReason(title, hint, cb) {
    modal('<h3>' + esc(title) + '</h3><p class="dim">' + esc(hint) + '</p><textarea id="mReason"></textarea>', () => { const t = $('#mReason').value.trim(); if (!t) { alertBox('要寫一句理由'); return false; } cb(t); });
  }

  // ---------------------------------------------------------------- 前進
  const JUMP = { step: '下一步（半天）', day: '下一天', nextNotif: '跳到下一則通知', nextMonth: '跳到下個月報' };
  function advance(which, cond, max) {
    if (sim.atEnd()) return;
    beginRound('jump', '你按了「' + JUMP[which] + '」');
    const n0 = sim.notifs.length;
    let k = 0, hit = false;
    while (k < (max || 400) && sim.step()) { k++; if (cond(n0)) { hit = true; break; } }
    let detail = '';
    if (sim.atEnd()) detail = '情境到此結束';
    else if (which === 'nextNotif') detail = hit ? '停下來：有新通知 ' + sim.notifs.slice(n0).map((n) => '#' + n.id).join('、') : '走了 ' + k + ' 步都沒有新通知';
    else if (which === 'nextMonth') detail = hit ? '停在月報日' : '';
    endRound(detail);
    ui.forceBottom = true;
    renderAll();
  }
  function describeReply(n, mode) {
    if (mode === 'SKIP') return '你回覆了通知 #' + n.id + '：這次不做';
    if (mode === 'READ') return '你已讀通知 #' + n.id;
    return '你回覆了通知 #' + n.id + '：' + (mode === 'PARTIAL' ? '部分完成' : '照清單做');
  }
  function replyDetail(n) {
    const bits = n.items.filter((i) => !i.cancelled && i.choices.length > 1).map((i) => { const c = i.choices.find((x) => x.id === i.choice); return (i.tk || i.f) + ' ' + (c ? c.label : i.choice); });
    return bits.join('、');
  }
  function jumpToLog(i) {
    const e = sim.log[i]; if (!e) return;
    if (!passFilter(e)) { ui.fFilter = ''; ui.tkFilter = ''; }
    ui.tab = 'log'; markTabs(); ui.scrollLog = null; renderCenter();
    const el = document.getElementById('le' + i); if (!el) return;
    const det = el.closest('details'); if (det) det.open = true;
    el.scrollIntoView({ block: 'center' });
    el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
  }
  function jumpToNotif(id) {
    const el = document.getElementById('n' + id); if (!el) return;
    el.scrollIntoView({ block: 'start', behavior: 'smooth' });
    el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
  }

  // ---------------------------------------------------------------- 事件
  document.addEventListener('click', (ev) => {
    const t = ev.target.closest('[data-choice],[data-iact],[data-resp],[data-run],[data-tab],[data-web],[data-key],[data-tk],[data-chart],[data-act],[data-fu],[data-classify],[data-export],[data-unexclude],[data-delnote],[data-log],[data-notif],[data-now]');
    if (!t) return;
    const d = t.dataset;
    if (d.choice !== undefined) { const [n, k, c] = d.choice.split('|'); sim.setChoice(Number(n), k, c); renderLine(); return; }
    if (d.iact !== undefined) {
      const [n, k, a] = d.iact.split('|');
      const label = { TRANSFER: ['轉入自選', '動能叫你賣、你想留。寫一句理由：它會成為這檔的前提，之後由 F24 每月檢查、F25 監測。「如果照賣」記進影子組合。'], EXCLUDE: ['排除（動能）', '不想買動能選出的這一檔。寫一句理由後排除，由下一名遞補（同否決，要過任務 A）。排除清單在網站，可隨時取消。'], ADOPT: ['認養', '動能選出一檔你也看好的股票，劃進自選。之後動能就算把它排除，也不會叫你賣。寫一句為什麼看好（成為前提）。'] }[a];
      const nt = sim.notifs.find((x) => x.id === Number(n)); const it = nt && nt.items.find((x) => x.key === k);
      askReason(label[0], label[1], (reason) => act('你在通知 #' + n + ' 對 ' + (it ? it.tk : '') + ' 按了「' + label[0] + '」', () => sim.itemAction(Number(n), k, a, { reason }), '理由：' + reason));
      return;
    }
    if (d.resp !== undefined) {
      const [n, m] = d.resp.split('|');
      const nt = sim.notifs.find((x) => x.id === Number(n));
      if (m === 'PARTIAL') {
        const comp = sim.compose(nt);
        modal('<h3>部分完成：填實際成交的股數</h3><p class="dim">就是你回到 stock bot 填快照時，這幾檔實際變動的股數（買為正、賣為負）。和清單差超過 1 股，系統會追問。</p>' + comp.merged.map((m2) => '<div class="formrow"><span style="width:60px">' + m2.tk + '</span>清單 ' + m2.shares + ' → 實際 <input data-pq="' + m2.tk + '" size="6" value="' + m2.shares + '"></div>').join(''), () => {
          const p = {}; document.querySelectorAll('input[data-pq]').forEach((x) => { p[x.dataset.pq] = Math.round(Number(x.value) || 0); });
          act(describeReply(nt, 'PARTIAL'), () => sim.respond(nt.id, 'PARTIAL', p), () => replyDetail(nt));
        });
        return;
      }
      act(describeReply(nt, m), () => sim.respond(Number(n), m === 'READ' ? 'ALL' : m), () => (m === 'READ' ? '' : replyDetail(nt)));
      return;
    }
    if (d.fu !== undefined) { const [n, f] = d.fu.split('|'); act('你對通知 #' + n + ' 的差額選了「' + (f === '1' ? '補做差額' : '就這樣') + '」', () => sim.resolveFollowUp(Number(n), f === '1')); return; }
    if (d.classify !== undefined) {
      const [n, b] = d.classify.split('|');
      const nt = sim.notifs.find((x) => x.id === Number(n));
      askReason('歸到' + E.BUCKET_NAME[b], b === 'own' ? '寫一句理由（如果是新的自選股，它會成為前提；不想寫就寫「系統預設」）。' : '寫一句理由（記錄用）。', (reason) => act('你回答：' + (nt ? nt.tk + ' ' + signed(nt.q) + ' 股' : '') + '歸到' + E.BUCKET_NAME[b], () => sim.classify(Number(n), b, reason === '系統預設' ? '' : reason)));
      return;
    }
    if (d.run !== undefined) { ui.tab = 'web'; ui.web = 'runs'; ui.run = d.run || null; markTabs(); renderCenter(); $('#centerBody').scrollTop = 0; return; }
    if (d.export !== undefined) { const r = sim.aiRuns.find((x) => x.id === d.export); $('#exportBox').innerHTML = '<div class="sec-t">匯出給 AI（複製到 claude.ai）</div><textarea style="min-height:220px" readonly>' + esc(exportMd(r)) + '</textarea>'; return; }
    if (d.tab !== undefined) { ui.tab = d.tab; markTabs(); if (ui.tab === 'log') ui.scrollLog = 'now'; renderCenter(); return; }
    if (d.web !== undefined) { ui.web = d.web; ui.run = null; renderCenter(); return; }
    if (d.key !== undefined) { ui.keyOnly = d.key === '1'; renderCenter(); return; }
    if (d.tk !== undefined) { ui.tk = d.tk; renderCenter(); renderRight(); return; }
    if (d.chart !== undefined) { ui.tk = d.chart; renderRight(); return; }
    if (d.act !== undefined) { ACTS[d.act](); return; }
    if (d.unexclude !== undefined) { act('你取消排除 ' + d.unexclude, () => { delete sim.mom.excluded[d.unexclude]; sim.addLog('F16', d.unexclude + ' 取消排除', '下一次月報重新列入排名候選。', { cls: '記影子' }); }); ui.tab = 'web'; markTabs(); renderCenter(); return; }
    if (d.delnote !== undefined) { const a = getNotes(); a.splice(Number(d.delnote), 1); setNotes(a); renderCenter(); return; }
    if (d.log !== undefined) { jumpToLog(Number(d.log)); return; }
    if (d.notif !== undefined) { jumpToNotif(Number(d.notif)); return; }
    if (d.now !== undefined) {
      const [a, arg] = d.now.split(':');
      if (a === 'reply') jumpToNotif(Number(arg));
      else if (a === 'step') advance('step', () => true, 1);
      else if (a === 'next') advance('nextNotif', (n0) => sim.notifs.length > n0);
      else if (a === 'reset') load(ui.scen);
    }
  });
  $('#step').onclick = () => advance('step', () => true, 1);
  $('#day').onclick = () => advance('day', () => false, 2);
  $('#nextNotif').onclick = () => advance('nextNotif', (n0) => sim.notifs.length > n0);
  $('#nextMonth').onclick = () => advance('nextMonth', () => sim.phase === 'PRE' && sim.isFirstOfMonth(sim.d));
  $('#reset').onclick = () => load(ui.scen);
  $('#scen').onchange = (e) => load(e.target.value);
  $('#modal').onclick = (e) => { if (e.target.id === 'modal') closeModal(); };
  $('#theme').onclick = () => {
    const r = document.documentElement;
    const cur = r.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    r.dataset.theme = cur === 'dark' ? 'light' : 'dark';
    renderRight();
  };
  window.addEventListener('resize', () => drawChart());

  $('#scen').innerHTML = G.SCENARIOS.map((s) => '<option value="' + s.id + '">' + esc(s.title) + '</option>').join('');
  let first = G.SCENARIOS[0].id;
  try { first = localStorage.getItem('stockbot-proto-scen') || first; } catch (e) { /* 預設第一個 */ }
  $('#scen').value = first;
  load(first);
  G.__sim = () => sim;
  G.__ui = ui;
})(window);
