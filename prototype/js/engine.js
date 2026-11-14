// 規則引擎（原型版）。對照 docs/design/design_v2_momentum_2026-11-07.md §2.0 觸發總表 F1–F25。
// 時間模型：每個交易日分兩個時點
//   PRE  = 台灣早上、美股開盤前：月報（每月第一個交易日）；你按的回覆在「下一步」時以今天開盤價成交
//   POST = 美股收盤後：每日檢查（慢規則、事件掃描、條件監測…）；當天通知在這時發出，隔天開盤執行
(function (G) {
  'use strict';
  const U = G.U, AI = G.AI;

  const FNAME = {
    F1: '動能新股進場', F2: '動能出場', F3: '動能比例回調（搭便車）', F4: '依波動度減碼', F5: '崩盤規則啟動', F6: '崩盤規則解除',
    F7: '自選慢規則減半', F8: '自選慢規則加回', F9: '自選 R1', F10: '單檔／跨桶上限', F11: '入金', F12: '出金', F13: '改比例',
    F14: '新增自選（健檢）', F15: '移除自選', F16: '轉入自選／認養／劃撥', F17: '這次不做／忘了／做錯／手動交易', F18: '每日事件掃描（任務 B）',
    F19: '持股硬事件', F20: '持股單月跌 > 20%', F21: '策略檢討', F22: '換 strategy', F23: '提高自選標準比重', F24: '自選定期審查', F25: '自選條件監測',
    SNAP: '快照 → 事件', SYS: '系統',
  };
  const BUCKET_NAME = { own: '自選', mom: '動能', core: '核心', unc: '未分類' };
  const TIER_NAME = { EXIT: '出清', HALF: '標準的一半', HOLD: '不動', STANDARD: '回到標準', RAISE: '提高到標準的 125%' };

  function create(scen) {
    const market = G.Market.build(scen.market);
    const st = scen.initial;
    const sim = {
      scen, market, FNAME, BUCKET_NAME, TIER_NAME,
      d: market.idx0, phase: 'PRE',
      settings: Object.assign({
        ratio: { own: 0.2, strat: 0.3, core: 0.5 }, urgent: 0.05, capHi: 0.15, capTo: 0.10, crossBuy: 0.10, crossHi: 0.15,
        volBuffer: 0.10, minGap: 0.0025, f25PerMonth: 1, sigmaMedian: null, reviewMax: 3,
      }, scen.settings || {}),
      snap: { shares: {}, cash: st.cash },
      lots: { own: {}, mom: {}, core: {}, unc: {} },
      own: {}, mom: { model: [], w: st.w || 1, excluded: {}, adopted: {}, vetoes: {}, owe: {}, watch: {} },
      crash: { on: !!st.crashOn, since: null },
      strat: { rel: 1 + (st.stratDD || 0), peak: 1, eventStart: st.stratEventStart || null, notified: (st.stratNotified || []).slice(), lastYearly: null },
      notifs: [], log: [], aiRuns: [], shadow: [], notes: [], assumptions: {},
      counters: {}, pendingExplain: [], f24Scheduled: [], f20Done: {}, history: [],
      nid: 0,
    };
    Object.assign(sim, api);
    // 初始持股
    for (const b of ['own', 'mom', 'core']) {
      for (const [tk, n] of Object.entries(st[b] || {})) {
        sim.lots[b][tk] = (sim.lots[b][tk] || 0) + n;
        sim.snap.shares[tk] = (sim.snap.shares[tk] || 0) + n;
      }
    }
    for (const [tk, o] of Object.entries(st.ownMeta || {})) {
      sim.own[tk] = Object.assign({ state: 'STD', lastSwitch: -999, std: 0.05, premises: [], conditions: [], r1: null, lastF24: null, f24Suggest: null, f25Sent: {}, metConds: {}, raisedAt: null, flags: [], pendingMonthly: null }, o);
      if (o.state === 'HALF') sim.own[tk].lastSwitch = market.idx0 - 30;
    }
    // 自選股的「站上 200 日均線連續幾天」與 R1 從歷史算起
    for (const tk of Object.keys(sim.own)) {
      let run = 0;
      for (let i = market.idx0 - 60; i < market.idx0; i++) run = market.close[tk][i] > U.sma(market.close[tk], i, 200) ? run + 1 : 0;
      sim.own[tk].aboveRun = run;
      sim.own[tk].r1 = sim.ind(tk, market.idx0 - 1).r1;
    }
    sim.mom.model = (st.momModel || Object.keys(st.mom || {})).slice();
    if (sim.settings.sigmaMedian === null) {
      const s0 = sim.momSigma(market.idx0 - 1);
      sim.settings.sigmaMedian = s0 * (scen.sigmaMedianFactor || 1.35);
    }
    sim.log.push({ d: sim.d, date: sim.dateKey(), phase: 'PRE', f: 'SYS', title: '情境開始：' + scen.title, body: scen.summary || '', cls: '' });
    sim.snapshotHistory();
    return sim;
  }

  const api = {
    // ---------- 時間與價格 ----------
    dateKey(d) { return this.market.days[d === undefined ? this.d : d]; },
    monthKey(d) { return this.dateKey(d).slice(0, 7); },
    dateLabel() { const k = this.dateKey(); return k + '（' + U.weekday(k) + '）' + (this.phase === 'PRE' ? '開盤前・台灣早上' : '收盤後'); },
    sIdx() { return this.phase === 'PRE' ? this.d - 1 : this.d; },
    signalDate() { return this.dateKey(this.sIdx()); },
    price(tk, i) { const a = this.market.close[tk]; return a ? a[i === undefined ? this.sIdx() : i] : NaN; },
    openPx(tk, i) { return this.market.open[tk][i === undefined ? this.d : i]; },
    isFirstOfMonth(d) { return d > 0 && this.monthKey(d) !== this.monthKey(d - 1); },
    isLastOfMonth(d) { return d + 1 < this.market.days.length && this.monthKey(d) !== this.monthKey(d + 1); },
    atEnd() { return this.d >= this.market.days.length - 2; },

    total(i) {
      let t = this.snap.cash;
      for (const [tk, n] of Object.entries(this.snap.shares)) if (n) t += n * this.price(tk, i);
      return t;
    },
    bucketValue(b, i) {
      let v = 0;
      for (const [tk, n] of Object.entries(this.lots[b])) if (n) v += n * this.price(tk, i);
      if (b === 'core') v += this.snap.cash;
      return v;
    },
    tkValue(tk, b) { return (this.lots[b][tk] || 0) * this.price(tk); },

    // ---------- 紀錄 ----------
    addLog(f, title, body, opt) {
      const e = Object.assign({ d: this.d, date: this.dateKey(), phase: this.phase, f, title, body: body || '', cls: '', lvl: '' }, opt || {});
      if (!e.nid) { const m = /(?:通知|清單) #(\d+)/.exec(title + ' ' + (body || '')); if (m) e.nid = Number(m[1]); }
      this.log.push(e);
      if (/^F\d+$/.test(f) && !(opt && opt.noCount)) this.counters[f] = (this.counters[f] || 0) + 1;
      return e;
    },
    assume(key, text) {
      if (!this.assumptions[key]) {
        this.assumptions[key] = { text, first: this.dateKey() };
        this.addLog('SYS', '⚠ 規格未定，原型先這樣假設', text, { warn: true });
      }
    },
    addRun(run) { this.aiRuns.push(run); return run; },
    snapshotHistory() {
      const i = this.sIdx();
      this.history.push({ d: this.d, date: this.dateKey(), phase: this.phase, total: this.total(i), own: this.bucketValue('own', i), mom: this.bucketValue('mom', i), core: this.bucketValue('core', i) });
    },

    // ---------- 指標 ----------
    ind(tk, i) {
      i = i === undefined ? this.sIdx() : i;
      const c = this.market.close[tk];
      const close = c[i];
      const hi = U.maxBack(c, i, 252);
      const ma200 = U.sma(c, i, 200), ma50 = U.sma(c, i, 50);
      const r252 = c[i] / c[i - 252] - 1;
      const r21 = c[i] / c[i - 21] - 1;
      const rets = [];
      for (let k = i - 125; k <= i; k++) rets.push(Math.log(c[k] / c[k - 1]));
      const vol = U.stdev(rets) * Math.sqrt(252);
      return { close, hi, dd: close / hi - 1, ma200, ma50, r252, r21, vol, above200: close > ma200, r1: close < ma50 && U.macdHist(c, i) < 0 };
    },
    ranks(i) {
      i = i === undefined ? this.sIdx() : i;
      const out = this.market.universe.filter((tk) => !(this.scen.universeOut || {})[tk] || this.dateKey(i) < this.scen.universeOut[tk])
        .map((tk) => ({ tk, r: this.market.close[tk][i] / this.market.close[tk][i - 252] - 1 }));
      out.sort((a, b) => b.r - a.r);
      const m = {};
      out.forEach((x, k) => { m[x.tk] = { rank: k + 1, r: x.r }; });
      return { list: out, map: m };
    },
    momSigma(i, model) {
      model = model || this.mom.model;
      if (!model.length) return 0;
      const xs = [];
      for (let k = i - 125; k <= i; k++) {
        let r = 0;
        for (const tk of model) r += this.market.close[tk][k] / this.market.close[tk][k - 1] - 1;
        r /= model.length;
        xs.push(r - (this.market.close.VOO[k] / this.market.close.VOO[k - 1] - 1));
      }
      return U.stdev(xs) * Math.sqrt(252);
    },
    slotTarget(T, crashOn, w) {
      const s = this.settings;
      return T * s.ratio.strat * (w === undefined ? this.mom.w : w) * ((crashOn === undefined ? this.crash.on : crashOn) ? 0.5 : 1) / 5;
    },
    ownTarget(tk, T, tier) {
      const o = this.own[tk];
      tier = tier || (o.state === 'HALF' ? 'HALF' : 'STANDARD');
      const m = { EXIT: 0, HALF: 0.5, STANDARD: 1, RAISE: 1.25 }[tier];
      if (tier === 'HOLD') return this.tkValue(tk, 'own');
      return o.std * T * m;
    },
    recommendStd(tks) {
      const inv = tks.map((tk) => 1 / this.ind(tk).vol);
      const s = inv.reduce((a, b) => a + b, 0);
      const out = {};
      tks.forEach((tk, k) => { out[tk] = this.settings.ratio.own * inv[k] / s; });
      return out;
    },

    // ---------- 清單 ----------
    line(tk, bucket, shares, reason, f) { return { tk, bucket, shares, reason, f }; },
    sharesFor(value, tk) { return Math.floor(value / this.price(tk)); },
    newNotif(o) {
      const n = Object.assign({ id: ++this.nid, d: this.d, date: this.dateKey(), phase: this.phase, label: this.dateLabel(), status: 'PENDING', items: [], coreAbsorb: true, explain: [], runs: [], reminded: false, followUp: null, reserveCash: 0 }, o);
      // 待附上的任務 C 說明（F20）
      if (this.pendingExplain.length && n.kind !== 'INFO') {
        n.explain = n.explain.concat(this.pendingExplain);
        this.pendingExplain = [];
      }
      this.notifs.push(n);
      return n;
    },
    item(o) {
      const it = Object.assign({ key: 'i' + Math.random().toString(36).slice(2, 8), choices: [], choice: null, actions: [], note: '' }, o);
      if (!it.choices.find((c) => c.id === 'SKIP') && !it.noSkip) it.choices.push({ id: 'SKIP', label: '這次不做', lines: [] });
      if (!it.choice) it.choice = it.defaultChoice || it.choices[0].id;
      return it;
    },
    // 把選好的各項合成最終清單；核心（VOO／短債）吸收差額
    compose(n) {
      const lines = [];
      for (const it of n.items) {
        if (it.cancelled) continue;
        const c = it.choices.find((x) => x.id === it.choice);
        if (c) for (const l of c.lines) if (l.shares) lines.push(l);
      }
      const coreLines = [];
      if (n.coreAbsorb) {
        let sells = 0, buys = 0;
        for (const l of lines) { const v = l.shares * this.price(l.tk); if (v < 0) sells -= v; else buys += v; }
        const T = this.total();
        const cashAvail = this.snap.cash + sells;
        let net = cashAvail - buys - n.reserveCash;
        const buffer = 0.02 * cashAvail;
        if (lines.length || Math.abs(this.snap.cash) > this.settings.minGap * T) {
          if (net - buffer > this.settings.minGap * T) {
            const inv = net - buffer;
            if (this.crash.on) {
              const a = this.sharesFor(inv / 2, 'VOO'), b = this.sharesFor(inv / 2, 'SGOV');
              if (a) coreLines.push(this.line('VOO', 'core', a, '錢交給核心（崩盤規則啟動中：一半買 VOO）', 'CORE'));
              if (b) coreLines.push(this.line('SGOV', 'core', b, '錢交給核心（崩盤規則啟動中：一半放短債）', 'CORE'));
            } else {
              const a = this.sharesFor(inv, 'VOO');
              if (a) coreLines.push(this.line('VOO', 'core', a, '錢交給核心（買 VOO）', 'CORE'));
            }
          } else if (net < 0) {
            let need = -net * 1.02;
            const order = this.crash.on ? ['SGOV', 'VOO'] : ['VOO', 'SGOV'];
            for (const tk of order) {
              if (need <= 0) break;
              const have = this.lots.core[tk] || 0;
              const pending = lines.filter((l) => l.tk === tk && l.bucket === 'core').reduce((a, l) => a + l.shares, 0);
              const avail = have + pending;
              const n2 = Math.min(avail, Math.ceil(need / this.price(tk)));
              if (n2 > 0) { coreLines.push(this.line(tk, 'core', -n2, '從核心拿錢（' + (tk === 'SGOV' ? '先用短債' : '賣 VOO') + '）', 'CORE')); need -= n2 * this.price(tk); }
            }
          }
        }
      }
      const all = lines.concat(coreLines);
      const merged = {};
      for (const l of all) {
        merged[l.tk] = merged[l.tk] || { tk: l.tk, shares: 0, parts: [] };
        merged[l.tk].shares += l.shares;
        merged[l.tk].parts.push(l);
      }
      let cashAfter = this.snap.cash;
      for (const l of all) cashAfter -= l.shares * this.price(l.tk);
      return { lines: all, merged: Object.values(merged).filter((m) => m.shares !== 0 || m.parts.length > 1), cashAfter: cashAfter - n.reserveCash };
    },
    setChoice(nid, key, choice) {
      const n = this.notifs.find((x) => x.id === nid); if (!n) return;
      const it = n.items.find((x) => x.key === key); if (!it) return;
      it.choice = choice;
    },

    // ---------- 回覆通知 ----------
    respond(nid, mode, partial) {
      const n = this.notifs.find((x) => x.id === nid);
      if (!n || (n.status !== 'PENDING')) return;
      if (n.kind === 'INFO' || n.kind === 'MONTHLY_EMPTY' || !n.items.length) { n.status = 'READ'; return; }
      // 忘了：過了提醒期才回覆 → 用今天價格重算；規則狀態若已反轉，取消那一項
      if (n.reminded && mode !== 'SKIP') {
        this.recompute(n);
        this.addLog('F17', '忘了 → 用今天價格重算補做清單', '通知 #' + n.id + '（' + n.date + '）晚了才回覆。規則狀態已反轉的項目取消，其餘用 ' + this.signalDate() + ' 收盤價重算股數。', { cls: '記影子', lvl: 'A0' });
      }
      if (mode === 'SKIP') for (const it of n.items) it.choice = 'SKIP';
      n.response = { mode, partial: partial || null, at: this.dateLabel() };
      n.status = mode === 'SKIP' ? 'SKIPPED' : 'RESPONDED';
      n.composed = this.compose(n);
      // 影子紀錄：有 AI 並列或使用者不照規則時
      for (const it of n.items) {
        if (it.cancelled) continue;
        const rule = it.choices.find((c) => c.id === (it.ruleChoice || it.choices[0].id));
        const ai = it.choices.find((c) => c.id === 'AI');
        const act = it.choices.find((c) => c.id === it.choice);
        const tk = it.tk;
        if (!tk) continue;
        const sum = (c) => (c ? c.lines.filter((l) => l.tk === tk).reduce((a, l) => a + l.shares, 0) : 0);
        const rec = { date: this.dateKey(), f: it.f, tk, title: it.title, rule: sum(rule), ai: ai ? sum(ai) : null, actual: mode === 'PARTIAL' && partial && partial[tk] !== undefined ? partial[tk] : sum(act), price0: this.price(tk), choice: it.choice, aiOpinion: it.aiOpinion || null };
        if (rec.ai !== null || rec.actual !== rec.rule || it.aiOpinion) {
          this.shadow.push(rec);
        }
        // 策略類不做 → 下個月再列
        if (it.kind === 'STRATEGY' && it.choice === 'SKIP') {
          this.mom.owe[tk] = { since: this.dateKey(), f: it.f, nid: n.id };
          this.addLog('F17', '策略類「這次不做」：' + tk, '動能、核心、比例回調、上限的單是策略目標。下一份月報會把差額再列一次；不想再看到要選「排除」或「轉入自選」並寫理由（§2.3.1）。', { cls: '記影子', lvl: 'A0', nid: n.id });
        }
        if (it.kind === 'OWN_RULE' && it.choice === 'SKIP') {
          this.addLog('F17', '自選規則「這次不做」：' + tk, '規則狀態照樣前進（記成 ' + (this.own[tk] ? this.own[tk].state : '') + '），目標改用實際股數，不再提醒，直到下一次狀態切換（§2.3.1）。差額記影子。', { cls: '記影子', lvl: 'A0', nid: n.id });
        }
        if ((it.kind === 'AI_ONLY' || it.kind === 'HARD') && it.choice === 'SKIP') {
          this.addLog('F17', 'AI 建議「不做」：' + tk, 'AI 建議是一次性的，使用者的決定就是最終決定，不再提醒；「照 AI」那條線記進影子組合。', { cls: '記影子', lvl: 'A0', nid: n.id });
        }
      }
      if (mode === 'SKIP') this.addLog('F17', '通知 #' + n.id + '：這次不做', '', { cls: '記影子' });
      else this.addLog('SYS', '你回覆了通知 #' + n.id + '（' + ({ ALL: '照清單做', PARTIAL: '部分完成' }[mode] || mode) + '）', '會在下一個開盤（' + this.nextOpenLabel() + '）以開盤價成交，成交後模擬你填快照。', {});
    },
    nextOpenLabel() { const d = this.phase === 'PRE' ? this.d : this.d + 1; return this.dateKey(d) + ' 開盤'; },
    recompute(n) {
      for (const it of n.items) {
        if (it.kind === 'OWN_RULE' && it.tk && this.own[it.tk] && this.own[it.tk].lastSwitch > n.d) {
          it.cancelled = true;
          it.note = '期間規則狀態已反轉，這一項取消';
          continue;
        }
        if (it.rebuild) it.rebuild(it);
      }
    },

    // ---------- 執行與快照 ----------
    executeResponded() {
      for (const n of this.notifs) {
        if (n.status !== 'RESPONDED') continue;
        const comp = this.compose(n);
        const executed = {};
        for (const m of comp.merged) {
          let qty = m.shares;
          if (n.response.mode === 'PARTIAL' && n.response.partial && n.response.partial[m.tk] !== undefined) qty = n.response.partial[m.tk];
          executed[m.tk] = qty;
        }
        // 只有部分完成表單裡多出來、清單沒有的代號 → 清單外變動
        let cashDelta = 0;
        const fills = [];
        for (const [tk, q] of Object.entries(executed)) {
          if (!q) continue;
          const p = this.openPx(tk);
          this.snap.shares[tk] = (this.snap.shares[tk] || 0) + q;
          cashDelta -= q * p;
          fills.push(tk + ' ' + (q > 0 ? '買 ' : '賣 ') + Math.abs(q) + ' 股 @ ' + U.px(p));
        }
        this.snap.cash += cashDelta;
        if (n.withdraw) this.snap.cash -= n.withdraw;
        if (n.deposit) { /* 入金在回報時已經進現金 */ }
        n.status = 'DONE';
        n.execLabel = this.dateKey() + ' 開盤';
        n.fills = fills;
        this.addLog('SNAP', '通知 #' + n.id + ' 成交，你填了快照', (fills.join('；') || '（沒有成交）') + (n.withdraw ? '；出金 ' + U.money(n.withdraw) : '') + '。快照現金 ' + U.money(this.snap.cash) + (this.snap.cash < 0 ? '（⚠ 現金為負：買單超過購買力，實際會被券商擋下）' : ''), {});
        this.reconcile(n, comp, executed);
        // 執行後的效果（例如提高標準比重、出清移除）
        for (const it of n.items) if (!it.cancelled && it.onDone) it.onDone(it, it.choice);
      }
    },
    // 快照 → 事件：清單上有的代號照清單分到各桶
    reconcile(n, comp, executed) {
      const parts = [];
      for (const m of comp.merged) {
        const q = executed[m.tk] || 0;
        const listed = m.shares;
        if (listed === 0 && q === 0) {
          // 同代號兩桶對沖（劃撥）：直接照清單搬
          for (const l of m.parts) this.lots[l.bucket][l.tk] = (this.lots[l.bucket][l.tk] || 0) + l.shares;
          parts.push(m.tk + '：兩桶對沖，不用下單，帳本直接劃撥');
          continue;
        }
        const ps = m.parts.filter((l) => l.shares !== 0);
        let assigned = 0;
        ps.forEach((l, k) => {
          const a = q === listed ? l.shares : (k === ps.length - 1 ? q - assigned : Math.round(l.shares * q / listed));
          assigned += a;
          this.lots[l.bucket][l.tk] = (this.lots[l.bucket][l.tk] || 0) + a;
          parts.push(l.tk + ' ' + (a >= 0 ? '+' : '') + a + ' 股 → ' + BUCKET_NAME[l.bucket] + '（' + l.reason + '）');
        });
        if (Math.abs(q - listed) > 1) {
          n.followUp = n.followUp || [];
          n.followUp.push({ tk: m.tk, listed, done: q });
        }
      }
      for (const b of ['own', 'mom', 'core']) for (const tk of Object.keys(this.lots[b])) if (this.lots[b][tk] === 0) delete this.lots[b][tk];
      this.addLog('SNAP', '帳本：上一份快照 → 這一份快照，拆成事件', parts.join('\n') || '沒有變動', {});
      if (n.followUp && n.followUp.length) {
        const txt = n.followUp.map((x) => x.tk + '：清單 ' + (x.listed > 0 ? '買 ' : '賣 ') + Math.abs(x.listed) + ' 股，快照只' + (x.listed > 0 ? '多 ' : '少 ') + Math.abs(x.done) + ' 股').join('；');
        this.addLog('F17', '做錯：快照和清單不同', txt + '。系統問你：補做差額（附清單）或就這樣（差額記影子）。策略類的差額下個月仍會再列。', { cls: '當天', lvl: 'A0' });
        n.followUpOpen = true;
        for (const x of n.followUp) {
          const it = n.items.find((i) => i.tk === x.tk && i.kind === 'STRATEGY');
          if (it) this.mom.owe[x.tk] = { since: this.dateKey(), f: it.f, nid: n.id };
        }
      }
    },
    resolveFollowUp(nid, fix) {
      const n = this.notifs.find((x) => x.id === nid);
      if (!n || !n.followUpOpen) return;
      n.followUpOpen = false;
      if (!fix) {
        for (const x of n.followUp) this.shadow.push({ date: this.dateKey(), f: 'F17', tk: x.tk, title: '做錯：就這樣', rule: x.listed, ai: null, actual: x.done, price0: this.price(x.tk), choice: 'AS_IS' });
        this.addLog('F17', '做錯 → 就這樣', '差額記進影子組合。', { cls: '記影子' });
        return;
      }
      const items = n.followUp.map((x) => {
        const orig = n.composed.lines.filter((l) => l.tk === x.tk);
        const bucket = orig.length ? orig[0].bucket : 'core';
        const diff = x.listed - x.done;
        return this.item({ f: 'F17', tk: x.tk, kind: 'FIX', title: x.tk + ' 補做差額', choices: [{ id: 'DO', label: '補做', lines: [this.line(x.tk, bucket, diff, '補做差額', 'F17')] }] });
      });
      const m = this.newNotif({ kind: 'URGENT', title: '補做差額清單', items, coreAbsorb: true });
      this.addLog('F17', '做錯 → 補做差額', '產生通知 #' + m.id, { cls: '當天' });
    },

    // ---------- 前進 ----------
    step() {
      if (this.atEnd()) return false;
      if (this.phase === 'PRE') {
        this.executeResponded();
        this.phase = 'POST';
        this.daily();
      } else {
        this.d += 1;
        this.phase = 'PRE';
        this.updateStrat();
        if (this.isFirstOfMonth(this.d)) this.monthly();
      }
      this.snapshotHistory();
      return true;
    },

    // ---------- 每日（收盤後） ----------
    daily() {
      const T = this.total();
      const date = this.dateKey();
      // 情境事件
      const evs = (this.scen.events || {})[date] || [];
      // F18 每日事件掃描（任務 B）
      const scanned = [];
      for (const ev of evs) this.handleEvent(ev, scanned);
      if (!evs.length) this.counters.F18 = (this.counters.F18 || 0) + 1;
      else this.addLog('F18', '每日事件掃描（任務 B，Haiku）', scanned.join('\n'), { cls: '不通知', lvl: '標記' });

      // 自選：R1、慢規則
      for (const tk of Object.keys(this.own)) this.ownDaily(tk, T);

      // F24 財報後審查（排在申報後的下一個交易日）
      const due = this.f24Scheduled.filter((x) => x.d === this.d);
      this.f24Scheduled = this.f24Scheduled.filter((x) => x.d !== this.d);
      for (const x of due) if (this.own[x.tk]) this.runF24(x.tk, '財報後');
      // 月報前一天：所有自選 F24
      if (this.isLastOfMonth(this.d)) {
        for (const tk of Object.keys(this.own)) this.runF24(tk, '每月');
      }

      // F20 持股單月跌 > 20%
      for (const tk of Object.keys(this.snap.shares)) {
        if (!this.snap.shares[tk] || tk === 'VOO' || tk === 'SGOV') continue;
        const r21 = this.ind(tk).r21;
        const k = tk + ':' + this.monthKey();
        if (r21 < -0.2 && !this.f20Done[k]) {
          this.f20Done[k] = true;
          const ind = this.ind(tk);
          const run = this.addRun(AI.taskC(this, 'F20', tk, {
            summary: tk + ' 近 21 個交易日 ' + U.spct(r21) + '。跌幅拆解（程式算）：大盤 ' + U.spct(this.market.close.VOO[this.d] / this.market.close.VOO[this.d - 21] - 1) + '，其餘為產業與個股。沒有找到硬事件，不轉交 F19。',
            sections: [{ title: '說明（一次 Sonnet）', text: '跌幅主要發生在財報或產業新聞之後；距 52 週高點 ' + U.pct(ind.dd) + '。' }],
          }));
          this.pendingExplain.push({ f: 'F20', tk, run: run.id, text: tk + ' 單月跌 ' + U.pct(-r21, 0) + '：' + run.summary });
          this.addLog('F20', tk + ' 單月跌幅 > 20% → 任務 C 寫說明', '不單獨發通知，附在下一則通知或月報（設計 §6.4）。', { cls: '附在下一則', lvl: 'A1', run: run.id });
        }
      }

      // 提醒：發出後 2 個交易日沒有回報
      for (const n of this.notifs) {
        if (n.status === 'PENDING' && !n.reminded && n.items.length && this.d - n.d >= 2) {
          n.reminded = true;
          this.newNotif({ kind: 'INFO', title: '提醒：通知 #' + n.id + '（' + n.date + '）還沒回報', text: '照做了嗎？之後回覆時，系統會問「忘了還是不做」；選忘了就用當天價格重算補做清單。', ref: n.id });
          this.addLog('F17', '忘了？通知 #' + n.id + ' 兩個交易日沒有回報 → 提醒一次', '', { cls: '當天', lvl: 'A0' });
        }
      }
      // 策略相對表現
    },

    handleEvent(ev, scanned) {
      const tk = ev.tk;
      const T = this.total();
      const inOwn = !!this.own[tk];
      const inMom = !!this.lots.mom[tk];
      const held = inOwn || inMom || this.snap.shares[tk];
      if (ev.type === 'filing') {
        scanned.push('EDGAR 新申報：' + tk + ' ' + ev.form + (ev.items ? ' Item ' + ev.items : '') + ' → ' + (ev.cls || '一般事件，不處理'));
        if (ev.cls === 'PENDING_MA' && inMom && !inOwn) {
          // 動能持股被收購：規則直接提出，不需要 AI
          const n = this.newNotif({
            kind: 'URGENT', title: '動能持股被收購（' + tk + '）：建議提早出場',
            items: [this.item({ f: 'F19', tk, kind: 'HARD', title: tk + ' ' + ev.form + '：已宣布被收購，股價被鎖在收購價附近', choices: [{ id: 'DO', label: '確認出場', lines: [this.line(tk, 'mom', -(this.lots.mom[tk] || 0), '硬事件 PENDING_MA', 'F19')] }], note: '動能持股的 PENDING_MA 由規則直接提出（出現 ' + ev.form + '），不需要 AI 判斷（設計 §6.2）。' })],
          });
          this.mom.model = this.mom.model.filter((x) => x !== tk);
          this.addLog('F19', tk + '：' + ev.form + ' → 規則直接提出提早出場', '動能持股的前提 P4（股價可以自由反映未來資訊）已不在。使用者確認才執行。通知 #' + n.id + '。動能下個月照排名遞補。', { cls: '當天', lvl: 'A3（規則提出）' });
          return;
        }
        if (ev.cls === 'ACCOUNTING' || ev.cls === 'REGULATORY' || (ev.cls === 'PENDING_MA' && inOwn)) {
          const run = this.addRun(AI.hardEvent(this, tk, { code: ev.cls, form: ev.form + (ev.items ? ' Item ' + ev.items : ''), text: ev.text }));
          this.addLog('F19', tk + '：' + ev.cls + ' 候選 → 任務 A（硬事件版）完整法庭 ×3', '票數 ' + JSON.stringify(run.vote) + '，結論：' + run.verdict, { cls: run.verdict === 'EXIT' && this.unanimous(run.vote, 'EXIT') ? '當天' : '只放網站', lvl: 'A3', run: run.id });
          if (run.verdict === 'EXIT' && this.unanimous(run.vote, 'EXIT')) {
            const items = [];
            if (inOwn) {
              const cur = this.lots.own[tk] || 0;
              items.push(this.item({
                f: 'F19', tk, kind: 'HARD', title: tk + ' ' + ev.cls + '：AI 建議提早出場（自選）', aiLine: 'AI：' + run.summary,
                choices: [{ id: 'AI', label: '照 AI（出清）', lines: [this.line(tk, 'own', -cur, '硬事件 ' + ev.cls, 'F19')] }], defaultChoice: 'SKIP', ruleChoice: 'SKIP', run: run.id,
                onDone: (it, ch) => { if (ch === 'AI') this.removeOwnPick(tk, '硬事件出清'); },
              }));
            }
            if (inMom) items.push(this.item({ f: 'F19', tk, kind: 'HARD', title: tk + ' ' + ev.cls + '：AI 建議提早出場（動能）', choices: [{ id: 'AI', label: '照 AI（出場）', lines: [this.line(tk, 'mom', -(this.lots.mom[tk] || 0), '硬事件 ' + ev.cls, 'F19')] }], defaultChoice: 'SKIP', ruleChoice: 'SKIP', run: run.id }));
            this.own[tk] && (this.own[tk].flags = this.own[tk].flags.concat([ev.cls]));
            const n = this.newNotif({ kind: 'URGENT', title: tk + ' 硬事件（' + ev.cls + '）', items, runs: [run.id] });
            this.assume('hard-default', 'F19 的通知預設是「不做」（AI 建議是升級給人，使用者確認才做）。UI 上要你主動選「照 AI」。');
            n.note = '使用者確認後才執行';
          }
          return;
        }
        if ((ev.form === '8-K' && /2\.02/.test(ev.items || '')) || ev.form === '10-Q' || ev.form === '10-K') {
          if (inOwn) {
            this.f24Scheduled.push({ tk, d: this.d + 1 });
            this.addLog('F24', tk + ' 新財報申報 → 排定明天跑財報後審查', '', { cls: '不通知', noCount: true });
          }
          // F25 財報條件：程式直接比對
          if (inOwn && ev.xbrl) this.checkXbrlConditions(tk, ev);
        }
        return;
      }
      if (ev.type === 'news') {
        scanned.push('新聞：' + tk + '「' + ev.text + '」→ ' + (ev.cond ? '可能符合條件 ' + ev.cond : '沒有命中任何類別'));
        if (ev.cond && inOwn) {
          const o = this.own[tk];
          const cond = (o.conditions || []).find((c) => c.id === ev.cond);
          if (!cond) { scanned.push('（' + tk + ' 目前沒有條件 ' + ev.cond + '，可能已被新的 F24 替換）'); return; }
          if (cond.kind !== 'EVENT') return;
          if (o.metConds[cond.id]) { this.addLog('F25', tk + ' 條件 ' + cond.id + ' 已經成立過', '同一條件成立後不再觸發，直到下一次 F24 更新條件。', { cls: '不通知', lvl: 'A3', noCount: true }); return; }
          const run = this.addRun(AI.conditionCheck(this, tk, cond, ev));
          this.f25Met(tk, cond, run, T);
        } else if (ev.cls && held) {
          scanned.push('（標記 ' + ev.cls + '，交給下一次審查）');
        }
        return;
      }
      if (ev.type === 'note') {
        this.addLog('SYS', ev.title || '情境事件', ev.text || '', {});
      }
    },
    unanimous(vote, key) { return vote && vote[key] === 3; },

    checkXbrlConditions(tk, ev) {
      const o = this.own[tk];
      for (const c of o.conditions || []) {
        if (c.kind !== 'XBRL' || o.metConds[c.id]) continue;
        const v = ev.xbrl[c.metric];
        if (v === undefined) continue;
        const met = c.below ? v < c.level : v > c.level;
        this.addLog('F25', tk + ' 財報條件 ' + c.id + '：' + c.text, '程式比對 XBRL：' + c.metric + ' = ' + v + '，門檻 ' + (c.below ? '<' : '>') + ' ' + c.level + ' → ' + (met ? '成立' : '不成立') + '（不用 LLM）', { cls: met ? '當天' : '不通知', lvl: 'A3' });
        if (met) {
          const run = this.addRun({ id: this.dateKey() + '_F25_' + tk + '_' + c.id, f: 'F25', fname: '自選條件監測（財報條件，程式比對）', tk, as_of: this.signalDate(), created: this.dateLabel(), model: '不用 LLM', verdict: 'MET', vote: null, summary: c.text + '：XBRL ' + c.metric + ' = ' + v, evidence: [{ id: 'E1', source: ev.form, date: this.dateKey(), quote: c.metric + ' = ' + v }], premises: [], conditions: [], sections: [], condition: c });
          this.f25Met(tk, c, run, this.total());
        }
      }
    },
    f25Met(tk, cond, run, T) {
      const o = this.own[tk];
      const ok = run.verdict === 'MET' && (!run.vote || this.unanimous(run.vote, 'MET'));
      this.addLog('F25', tk + ' 條件 ' + cond.id + '「' + cond.text + '」' + (ok ? '成立' : '未確認'), run.vote ? '事件條件：Haiku 初判可能成立 → Sonnet ×3：' + JSON.stringify(run.vote) + '（3 票都成立且引用通過才算）' : '', { cls: ok ? '當天' : '不通知', lvl: 'A3', run: run.id });
      if (!ok) return;
      o.metConds[cond.id] = this.dateKey();
      if (cond.direction === 'UP') {
        this.addLog('F25', '升級條件成立 → 下一次月報', '升級不發當天通知；RAISE 只在 F23 規則條件成立時才可選。', { cls: '月報', lvl: 'A3', noCount: true });
        return;
      }
      const mk = this.monthKey();
      if ((o.f25Sent[mk] || 0) >= this.settings.f25PerMonth) {
        this.addLog('F25', '本月 ' + tk + ' 已經發過當天通知 → 這次不發', '每檔每月最多 ' + this.settings.f25PerMonth + ' 則（設定可調），只放網站。', { cls: '只放網站', lvl: 'A3', noCount: true });
        return;
      }
      const urgentThisMonth = this.notifs.some((n) => n.kind === 'URGENT' && n.date.slice(0, 7) === mk && n.items.some((i) => i.tk === tk && i.f === 'F7'));
      if (urgentThisMonth) this.assume('f25-vs-f7', 'F25「每檔每月最多 1 則」只計 F25 自己的通知，不含同月的 F7 慢規則當天通知。所以同一檔同一個月可能收到兩則（慢規則一則、條件一則）。');
      o.f25Sent[mk] = (o.f25Sent[mk] || 0) + 1;
      const tier = cond.tier_if_met || 'HALF';
      const target = this.ownTarget(tk, T, tier);
      const cur = this.lots.own[tk] || 0;
      const delta = Math.round(target / this.price(tk)) - cur;
      if (delta >= 0) { this.addLog('F25', '條件成立，但檔位 ' + TIER_NAME[tier] + ' 不需要賣', '', { noCount: true }); return; }
      const it = this.item({
        f: 'F25', tk, kind: 'AI_ONLY', title: tk + '：條件 ' + cond.id + '「' + cond.text + '」成立', aiLine: 'AI 建議' + TIER_NAME[tier] + '，' + (delta < 0 ? '賣 ' + (-delta) : '買 ' + delta) + ' 股',
        choices: [{ id: 'AI', label: '照 AI', lines: [this.line(tk, 'own', delta, 'F25 條件成立：' + TIER_NAME[tier], 'F25')] }], defaultChoice: 'SKIP', ruleChoice: 'SKIP', run: run.id,
        onDone: (it2, ch) => { if (ch === 'AI') this.applyTier(tk, tier); },
      });
      const n = this.newNotif({ kind: 'URGENT', title: tk + ' 條件成立（F25）', items: [it], runs: [run.id], note: '規則沒有動作，所以只列 AI 那一行＋「不做」' });
      this.addLog('F25', '→ 當天通知 #' + n.id, '規則沒有動作，只列 AI 那一行；使用者選。', { cls: '當天', lvl: 'A3', noCount: true });
    },
    applyTier(tk, tier) {
      const o = this.own[tk]; if (!o) return;
      if (tier === 'EXIT') { this.removeOwnPick(tk, '照 AI 出清'); return; }
      if (tier === 'HALF' || tier === 'STANDARD' || tier === 'HOLD') {
        const ns = tier === 'HALF' ? 'HALF' : tier === 'STANDARD' ? 'STD' : o.state;
        if (ns !== o.state) { o.state = ns; o.lastSwitch = this.d; }
        this.assume('ai-tier-state', '照 AI 選「標準的一半」後，這檔的慢規則狀態改成「減半」（之後照加回條件補足）；選「回到標準」則改成「標準」。設計沒有明寫 AI 檔位會不會改變規則狀態。');
      }
      if (tier === 'RAISE') { o.std *= 1.25; o.raisedAt = this.dateKey(); this.addLog('F23', tk + ' 標準比重提高到 ' + U.pct(o.std), '接受 RAISE 後標準比重改成 125%。', { noCount: true }); }
    },
    removeOwnPick(tk, why) {
      const o = this.own[tk]; if (!o) return;
      delete this.own[tk];
      this.addLog('F15', tk + ' 移出自選（' + why + '）', '', { noCount: true });
      this.assume('exit-removes', '照 AI「出清」＝這檔移出自選（等同 F15），之後不再跑慢規則加回、F24、F25。若你希望出清後仍追蹤、加回時再買回，這裡要改。');
    },

    ownDaily(tk, T) {
      const o = this.own[tk];
      const ind = this.ind(tk);
      o.aboveRun = ind.above200 ? (o.aboveRun || 0) + 1 : 0;
      o.lastInd = ind;
      if (o.r1 !== ind.r1) {
        if (o.r1 !== null) this.addLog('F9', tk + ' R1 ' + (ind.r1 ? '成立' : '解除') + '（收盤 ' + (ind.r1 ? '<' : '>') + ' 50 日均線且 MACD 柱 ' + (ind.r1 ? '< 0' : '≥ 0') + '）', '只記錄狀態，放進 F7、F24 的證據包；不通知、不呼叫 AI。', { cls: '不通知', lvl: 'A0' });
        o.r1 = ind.r1;
      }
      const cur = this.lots.own[tk] || 0;
      if (o.state === 'STD' && ind.dd <= -0.2) {
        o.state = 'HALF'; o.lastSwitch = this.d;
        this.ownSwitch(tk, 'F7', T, ind);
      } else if (o.state === 'HALF' && o.aboveRun >= 10 && this.d - o.lastSwitch >= 15 && ind.dd > -0.2) {
        o.state = 'STD'; o.lastSwitch = this.d;
        this.ownSwitch(tk, 'F8', T, ind);
      }
    },
    ownRuleLines(tk, f) {
      const T = this.total();
      const cur = this.lots.own[tk] || 0;
      if (f === 'F7') return [this.line(tk, 'own', -Math.round(cur / 2), '自選慢規則減半', 'F7')];
      const tgt = Math.floor(this.ownTarget(tk, T, 'STANDARD') / this.price(tk));
      return [this.line(tk, 'own', Math.max(0, tgt - cur), '自選慢規則加回', 'F8')];
    },
    ownAiChoice(tk, ruleLines, f) {
      const o = this.own[tk];
      const sc = (this.scen.ai || {})[f + ':' + tk + ':' + this.monthKey()] || (this.scen.ai || {})[f + ':' + tk];
      const r = o.lastF24 && this.aiRuns.find((x) => x.id === o.lastF24);
      let tier = null, runId = null;
      if (sc) {
        tier = sc.tier;
        const run = this.addRun(AI.taskC(this, f, tk, { summary: sc.summary || '', sections: sc.sections || [] }));
        Object.assign(run, { verdict: tier, vote: sc.vote || null, premises: sc.premises || [], fname: f === 'F7' ? '慢規則減半時的 AI 檢視（沿用 F24＋一次 Sonnet）' : '慢規則加回時的 AI 檢視（沿用 F24）' });
        runId = run.id;
      } else if (r && (r.verdict === 'HALF' || r.verdict === 'EXIT')) { tier = r.verdict; runId = r.id; }
      else if (f === 'F7') { tier = 'HALF'; runId = r ? r.id : null; }
      else if (r && r.verdict === 'HOLD') this.assume('f8-hold', '加回（F8）時，最近一次 F24 的檔位是「不動」：原型當成 AI 沒有異議，只顯示規則一行。另一種解讀是「不動＝維持減半」，那每次加回都會多一行「AI：維持一半」。');
      if (!tier) return null;
      if ((f === 'F7' && tier === 'HALF') || (f === 'F8' && tier === 'STANDARD')) {
        if (f === 'F7') this.assume('half-def', '慢規則減半時，AI 檔位「標準的一半」當成「同意規則」，只顯示一行。嚴格算的話：規則「減半」＝賣掉目前股數的一半（B-1/B-5 做法），AI「標準的一半」＝標準比重 × 0.5；部位高於標準時兩者股數不同。');
        return { same: true, tier, run: runId };
      }
      const T = this.total();
      const shares = tier === 'HOLD' ? 0 : Math.round(this.ownTarget(tk, T, tier) / this.price(tk)) - (this.lots.own[tk] || 0);
      return { tier, run: runId, lines: [this.line(tk, 'own', shares, 'AI 檔位：' + TIER_NAME[tier], f)] };
    },
    ownSwitch(tk, f, T, ind) {
      const o = this.own[tk];
      const lines = this.ownRuleLines(tk, f);
      const chg = Math.abs(lines[0].shares) * this.price(tk);
      const urgent = chg >= this.settings.urgent * T;
      const what = f === 'F7' ? '減半（距 52 週高點 ' + U.pct(ind.dd) + '）' : '加回（站上 200 日均線 ' + o.aboveRun + ' 天）';
      // 加回：檢查未解除標記
      const flags = [];
      if (f === 'F8') {
        if (o.flags.length) flags.push('未解除的硬事件標記：' + o.flags.join('、'));
        const met = Object.keys(o.metConds);
        if (met.length) flags.push('已成立的降級條件：' + met.join('、'));
      }
      if (!urgent) {
        if (o.pendingMonthly && o.pendingMonthly.f !== f) {
          this.addLog(f, tk + ' 慢規則' + what + '，和本月稍早尚未下單的切換互相抵銷', '月報不列這一檔。', { cls: '月報', lvl: 'A3' });
          o.pendingMonthly = null;
          return;
        }
        o.pendingMonthly = { f, date: this.dateKey() };
        this.addLog(f, tk + ' 慢規則' + what + '：變動 ' + U.pct(chg / T) + ' < 5% → 累積到月報', '規則狀態現在就切換（記成 ' + o.state + '），股數在月報當天用前一日收盤價重算。' + (flags.length ? ' ' + flags.join('；') : ''), { cls: '月報', lvl: 'A3' });
        return;
      }
      // 當天通知
      const ai = this.ownAiChoice(tk, lines, f);
      const attr = this.attribution(tk);
      const run = f === 'F7' ? this.addRun(AI.taskC(this, 'F7', tk, {
        summary: '跌幅拆解（程式算，近 63 日）：大盤 ' + U.spct(attr.market) + '、產業 ' + U.spct(attr.sector) + '、個股 ' + U.spct(attr.idio) + '。以最近一次 F24 為底，用一次 Sonnet 補上之後的新證據。',
        sections: [{ title: '歸類', text: attr.idio < attr.market ? '公司基本面／個股為主' : '大盤為主' }],
      })) : null;
      const choices = [{ id: 'RULE', label: '照規則', lines }];
      let aiLine = null;
      if (ai && !ai.same) { choices.push({ id: 'AI', label: '照 AI', lines: ai.lines }); aiLine = 'AI（F24 檔位：' + TIER_NAME[ai.tier] + '）：' + (ai.lines[0].shares < 0 ? '賣 ' + (-ai.lines[0].shares) : ai.lines[0].shares > 0 ? '買 ' + ai.lines[0].shares : '不動，0') + ' 股'; }
      const it = this.item({
        f, tk, kind: 'OWN_RULE', title: tk + ' 慢規則' + what, choices, aiLine, sameAsRule: ai && ai.same, run: ai ? ai.run : null, flags,
        rebuild: (it2) => { const nl = this.ownRuleLines(tk, f); it2.choices[0].lines = nl; },
        onDone: (it2, ch) => { if (ch === 'AI' && ai) this.applyTier(tk, ai.tier); },
      });
      const n = this.newNotif({ kind: 'URGENT', title: tk + ' 慢規則' + (f === 'F7' ? '減半' : '加回'), items: [it], runs: [run && run.id, ai && ai.run].filter(Boolean) });
      this.addLog(f, tk + ' 慢規則' + what + '：變動 ' + U.pct(chg / T) + ' ≥ 5% → 當天通知 #' + n.id, (ai ? (ai.same ? 'AI 檔位和規則一致，只顯示一行。' : 'AI 檔位（' + TIER_NAME[ai.tier] + '）和規則不同，清單多一行「AI 建議」，使用者選；不選照規則。') : '還沒有 F24 審查紀錄，只有規則一行。') + (flags.length ? ' ' + flags.join('；') : ''), { cls: '當天', lvl: 'A3', run: run && run.id });
    },
    attribution(tk) {
      const i = this.sIdx(), k = i - 63;
      const c = this.market.close;
      const tot = c[tk][i] / c[tk][k] - 1;
      const market = c.VOO[i] / c.VOO[k] - 1;
      const peers = { 半導體: ['NVDA', 'AMD', 'AVGO', 'MU'], 軟體: ['MSFT', 'ORCL', 'PLTR', 'IBM'], 通訊: ['META', 'GOOGL', 'NFLX'] }[this.market.info[tk].sector] || ['VOO'];
      const ps = peers.filter((p) => p !== tk && c[p]);
      const sec = ps.length ? ps.reduce((a, p) => a + (c[p][i] / c[p][k] - 1), 0) / ps.length : market;
      return { total: tot, market, sector: sec - market, idio: tot - sec };
    },
    runF24(tk, why) {
      const run = this.addRun(AI.ownReview(this, tk, why));
      const o = this.own[tk];
      o.lastF24 = run.id;
      if (run.conditions && run.conditions.length && run.newConditions !== false) {
        const changed = JSON.stringify(run.conditions.map((c) => c.id + c.text)) !== JSON.stringify((o.conditions || []).map((c) => c.id + c.text));
        o.conditions = run.conditions;
        if (changed) o.metConds = {};
      }
      const cur = o.state === 'HALF' ? 'HALF' : 'STANDARD';
      const differs = run.verdict !== 'HOLD' && run.verdict !== cur;
      const hasEvidence = (run.premises || []).some((p) => p.status === 'BROKEN') || Object.keys(o.metConds).length > 0 || run.evidenceOk;
      let suggest = differs && this.unanimous(run.vote, run.verdict) && hasEvidence;
      let note = '';
      if (run.verdict === 'RAISE') {
        const f23 = this.f23ok(tk);
        if (!f23.ok) { suggest = false; note = 'F23 規則條件不成立（' + f23.why + '），RAISE 不能選'; }
        else { suggest = this.unanimous(run.vote, 'RAISE'); note = 'F23 規則條件成立；前提全部成立、沒有硬事件標記'; }
      }
      o.f24Suggest = suggest ? { run: run.id, tier: run.verdict } : null;
      this.addLog('F24', tk + ' 自選定期審查（' + why + '）→ 檔位：' + TIER_NAME[run.verdict], '新聞＋基本面分析師 → 多空各自獨立 → 經理 ×3。票數 ' + JSON.stringify(run.vote) + '。' + (suggest ? '3 票一致、和目前狀態不同、有通過檢查的證據 → 月報並列建議。' : (note || '不符合並列條件（票數不一致、和目前相同，或沒有通過檢查的證據）→ 只放網站。')) + (run.conditions && run.conditions.length ? ' 寫下 ' + run.conditions.length + ' 條條件交給 F25。' : ''), { cls: suggest ? '月報' : '只放網站', lvl: 'A3', run: run.id });
    },
    f23ok(tk) {
      const o = this.own[tk];
      if (o.state !== 'STD') return { ok: false, why: '在減半狀態' };
      const i = this.sIdx();
      const c = this.market.close[tk];
      for (let k = i - 125; k <= i; k += 21) { const m = U.sma(c, k, 200); if (c[k] < m) return { ok: false, why: '過去 6 個月有月底收在 200 日均線之下' }; }
      if (o.raisedAt && this.dateKey() < String(Number(o.raisedAt.slice(0, 4)) + 1) + o.raisedAt.slice(4)) return { ok: false, why: '距上次提起不到 12 個月' };
      if (o.flags.length) return { ok: false, why: '有硬事件標記' };
      return { ok: true };
    },

    updateStrat() {
      // 純動能部位（模型組合）相對 SPY 的累積表現
      const i = this.d - 1;
      if (!this.mom.model.length) return;
      let r = 0;
      for (const tk of this.mom.model) r += this.market.close[tk][i] / this.market.close[tk][i - 1] - 1;
      r /= this.mom.model.length;
      const rv = this.market.close.VOO[i] / this.market.close.VOO[i - 1] - 1;
      this.strat.rel *= (1 + r - rv);
      if (this.strat.rel > this.strat.peak) { this.strat.peak = this.strat.rel; if (this.strat.eventStart) { this.addLog('F21', '相對表現創新高 → 這次落後事件結束', '', { noCount: true }); this.strat.eventStart = null; this.strat.notified = []; } }
    },
    stratDD() { return this.strat.rel / this.strat.peak - 1; },

    // ---------- 月報 ----------
    monthly() {
      const T = this.total();
      const s = this.sIdx();
      const items = [];
      const runs = [];
      this.addLog('SYS', '月報計算開始（用 ' + this.signalDate() + ' 收盤）', '總資產 ' + U.money(T) + '。順序：崩盤規則 → 動能（出場、波動度、進場＋任務 A）→ 自選（累積的慢規則、F24、F23）→ 上限 → 搭便車 → 核心吸收差額。', {});
      if (Object.values(this.lots.unc).some((x) => x)) {
        this.addLog('F17', '有清單外的變動還沒分類 → 月報暫停', '標記之前月報不下單（§2.1.1）。請先在 LINE 回答那筆變動屬於哪一桶。', { cls: '當天', lvl: 'A0' });
        this.newNotif({ kind: 'INFO', title: '月報暫停：有未分類的持股變動', text: '請先回答「這是手動交易、新增自選還是轉入自選，屬於哪一桶」。分類後按「重算月報」。' });
        this.monthlyBlocked = true;
        return;
      }
      this.monthlyBlocked = false;

      // A. 崩盤規則
      const voo = this.market.close.VOO[s], ma = U.sma(this.market.close.VOO, s, 200);
      const below = voo < ma;
      const crashFlip = below !== this.crash.on;
      const wasOn = this.crash.on;
      let crashItem = null;
      if (crashFlip) {
        this.crash.on = below;
        this.crash.since = this.dateKey();
        const run = this.addRun(AI.crashReview(this, below ? 'ON' : 'OFF'));
        runs.push(run.id);
        const coreVal = this.bucketValue('core', s) - this.snap.cash;
        const lines = [];
        if (below) {
          const move = (coreVal + this.snap.cash) / 2 - (this.lots.core.SGOV || 0) * this.price('SGOV');
          lines.push(this.line('VOO', 'core', -Math.round(move / this.price('VOO')), '崩盤規則啟動：核心一半換現金', 'F5'));
          lines.push(this.line('SGOV', 'core', Math.floor(move / this.price('SGOV')), '崩盤規則啟動：核心一半換現金', 'F5'));
        } else {
          const sg = this.lots.core.SGOV || 0;
          lines.push(this.line('SGOV', 'core', -sg, '崩盤規則解除：短債換回 VOO', 'F6'));
          lines.push(this.line('VOO', 'core', Math.floor(sg * this.price('SGOV') / this.price('VOO')), '崩盤規則解除：短債換回 VOO', 'F6'));
        }
        const f = below ? 'F5' : 'F6';
        const op = run.verdict === 'DELAY' ? '延後' : '照做';
        crashItem = this.item({ f, kind: 'STRATEGY', tk: 'VOO', title: '崩盤規則' + (below ? '啟動' : '解除') + '（VOO ' + U.px(voo) + ' vs 200 日均線 ' + U.px(ma) + '）', choices: [{ id: 'DO', label: '照做', lines }], aiLine: 'AI 檢視：' + op, aiOpinion: op, run: run.id });
        items.push(crashItem);
        this.addLog(f, '崩盤規則' + (below ? '啟動' : '解除') + '：VOO ' + U.px(voo) + (below ? ' < ' : ' > ') + '200 日均線 ' + U.px(ma), '核心' + (below ? '一半換短債、動能部位減半' : '短債換回 VOO、動能部位恢復') + '。AI 檢視（儀表板＋正反方＋法官 ×3）意見：' + op + '，票數 ' + JSON.stringify(run.vote) + '。AI 只說明＋影子，不能否決或延後（§4.4）；LINE 只附一行。', { cls: '月報', lvl: 'A2', run: run.id });
      } else {
        this.addLog('F5', '崩盤規則：維持' + (this.crash.on ? '啟動' : '未啟動'), 'VOO ' + U.px(voo) + '，200 日均線 ' + U.px(ma) + '（' + U.spct(voo / ma - 1) + '）', { cls: '不通知', noCount: true });
      }

      // B. 動能
      const rk = this.ranks(s);
      const model = this.mom.model.slice();
      const exits = [];
      for (const tk of model) {
        const r = rk.map[tk];
        if (!r || r.rank > 15) exits.push({ tk, why: !r ? 'UNIVERSE_OUT' : 'RANK_OUT', rank: r ? r.rank : null });
      }
      // 波動度減碼（用換股前的持股）
      const sig = this.momSigma(s, model);
      const ratio = this.settings.sigmaMedian / sig;
      const w0 = this.mom.w;
      const cand = U.floorThird(Math.min(1, ratio));
      let w1 = w0;
      if (cand > w0) w1 = Math.max(w0, Math.min(cand, U.floorThird(Math.min(1, ratio - this.settings.volBuffer))));
      else if (cand < w0) w1 = Math.min(w0, Math.max(cand, U.floorThird(Math.min(1, ratio + this.settings.volBuffer))));
      const blocked = cand !== w0 && w1 === w0;
      this.mom.w = w1;
      let f4run = null;
      if (w1 !== w0) {
        // 貢獻最大的持股
        const contrib = model.map((tk) => ({ tk, v: this.ind(tk, s).vol })).sort((a, b) => b.v - a.v);
        f4run = this.addRun(AI.taskC(this, 'F4', null, {
          summary: '動能部位相對 SPY 的超額波動 σ = ' + U.pct(sig) + '，歷史中位數 σ̃ = ' + U.pct(this.settings.sigmaMedian) + '，σ̃/σ = ' + ratio.toFixed(2) + ' → 比例 ' + U.thirdLabel(w0) + ' → ' + U.thirdLabel(w1) + '。波動最大的是 ' + contrib[0].tk + '（年化 ' + U.pct(contrib[0].v, 0) + '）。',
          sections: [{ title: '說明（模板或一次 Sonnet）', text: '這是統計性的規則，個別新聞推翻不了「現在波動很高」。減下來的錢交給核心。' }],
        }));
        runs.push(f4run.id);
        this.addLog('F4', '依波動度減碼：' + U.thirdLabel(w0) + ' → ' + U.thirdLabel(w1), f4run.summary, { cls: '月報', lvl: 'A1', run: f4run.id });
      } else {
        this.addLog('F4', '依波動度減碼：維持 ' + U.thirdLabel(w0), 'σ = ' + U.pct(sig) + '，σ̃ = ' + U.pct(this.settings.sigmaMedian) + '，σ̃/σ = ' + ratio.toFixed(2) + (blocked ? '。原始格子是 ' + U.thirdLabel(cand) + '，但 σ̃/σ ' + (cand > w0 ? '− ' : '+ ') + '0.10 = ' + (cand > w0 ? ratio - 0.1 : ratio + 0.1).toFixed(2) + ' 不在新格子裡 → 遲滯擋下（B-8）' : ''), { cls: '不通知', noCount: true });
      }
      const slotT = this.slotTarget(T);
      const crossRoom = (tk) => this.settings.crossBuy * T - this.tkValue(tk, 'own') - this.tkValue(tk, 'mom');
      // 出場
      for (const x of exits) {
        this.mom.model = this.mom.model.filter((t) => t !== x.tk);
        const held = this.lots.mom[x.tk] || 0;
        this.addLog('F2', '動能出場：' + x.tk + (x.why === 'RANK_OUT' ? '（排名第 ' + x.rank + '，掉出前 15）' : '（掉出股票池）'), 'AI 不參與（A0）。想留可以「轉入自選」（要寫理由，建立前提）。', { cls: '月報', lvl: 'A0' });
        if (held) items.push(this.momExitItem(x.tk, held, x.why === 'RANK_OUT' ? '排名第 ' + x.rank + '，掉出前 15 名' : '掉出股票池'));
      }
      // 上次沒照做的出場
      for (const tk of Object.keys(this.lots.mom)) {
        if (this.lots.mom[tk] > 0 && !this.mom.model.includes(tk) && !exits.find((x) => x.tk === tk)) {
          const owe = this.mom.owe[tk];
          const oweTxt = owe && owe.nid ? '通知 #' + owe.nid + '（' + owe.since + '）選了這次不做' : '上次沒照做';
          items.push(this.momExitItem(tk, this.lots.mom[tk], oweTxt + '，策略類持續列入'));
          this.addLog('F2', tk + '：上次的出場沒照做 → 再列一次', oweTxt + '。策略類的偏離要明確選「轉入自選」，否則持續列入月報（§2.3.1）。', { cls: '月報', lvl: 'A0', noCount: true, nid: owe && owe.nid });
        }
      }
      // 進場
      let reviews = 0;
      const tried = {};
      const isCandidate = (tk) => !this.mom.model.includes(tk) && !this.mom.excluded[tk] && !this.mom.adopted[tk] && !tried[tk];
      while (this.mom.model.length < 5) {
        let c = rk.list.find((x, k) => k < 5 && isCandidate(x.tk));
        let replacement = false;
        if (!c) {
          // 前 5 名都已持有或處理過：遞補（只在有人被否決時）
          if (!Object.values(tried).some((v) => v === 'VETO')) break;
          c = rk.list.find((x) => isCandidate(x.tk)); replacement = true;
          if (!c) break;
        }
        if (reviews >= this.settings.reviewMax) { this.addLog('F1', '本月已審 ' + reviews + ' 檔（上限 ' + this.settings.reviewMax + '）→ 剩下的格子留在核心到下個月', '', { cls: '月報', noCount: true }); break; }
        reviews++;
        const rank = rk.map[c.tk].rank;
        const run = this.addRun(AI.taskA(this, c.tk, rank));
        runs.push(run.id);
        const veto = run.verdict === 'VETO' && this.unanimous(run.vote, 'VETO');
        if (run.verdict === 'VETO' && !veto) this.assume('veto-votes', '任務 A 的否決要 3 票都說否決才成立；票數不一致照規則（准許）並記錄（ai_layer §2.4「票數不一致照規則」的推論）。');
        tried[c.tk] = veto ? 'VETO' : 'OK';
        if (veto) {
          this.mom.vetoes[c.tk] = { month: this.monthKey(), reason: run.reason_code, lift: run.lift };
          this.shadow.push({ date: this.dateKey(), f: 'F1', tk: c.tk, title: '否決進場（' + run.reason_code + '）', rule: this.sharesFor(Math.min(slotT, crossRoom(c.tk)), c.tk), ai: 0, actual: 0, price0: this.price(c.tk), choice: 'VETO' });
          this.addLog('F1', '任務 A 否決 ' + c.tk + '（排名第 ' + rank + '）：' + run.reason_code, '規則偵測命中：' + (run.ruleHits || []).join('、') + ' → 完整法庭（檢方、辯方各自獨立 → 互看一輪 → Opus 法官 ×3）票數 ' + JSON.stringify(run.vote) + '。由下一名遞補，遞補者也要過任務 A' + (replacement ? '；這已經是遞補者，再被否決的話那一格留在核心到下個月' : '') + '。', { cls: '月報', lvl: 'A4', run: run.id });
          if (replacement) break;
          continue;
        }
        const room = crossRoom(c.tk);
        const val = Math.min(slotT, room);
        if (room < slotT) this.addLog('F10', c.tk + ' 跨桶上限：最多買到總資產 10%', '自選已有 ' + U.money(this.tkValue(c.tk, 'own')) + '，動能只能買 ' + U.money(Math.max(0, val)) + '，被擋下的留在核心。', { cls: '月報', lvl: 'A0' });
        this.mom.model.push(c.tk);
        const sh = Math.max(0, this.sharesFor(val, c.tk));
        items.push(this.momEntryItem(c.tk, sh, rank, run, replacement));
        this.addLog('F1', '動能新股進場：' + c.tk + '（排名第 ' + rank + '）→ 任務 A：' + run.verdict + (replacement ? '（遞補）' : ''), run.summary + (run.verdict === 'ALLOW_WATCH' ? ' 准許但觀察：照常進場，任務 B 提高掃描頻率，月報列出觀察理由。' : ''), { cls: '月報', lvl: 'A4', run: run.id });
        if (run.verdict === 'ALLOW_WATCH') this.mom.watch[c.tk] = run.watch_reason || run.summary;
        delete this.mom.owe[c.tk];
      }
      // 留任股：波動度或崩盤改變比例 → 全部調到新目標；上次沒照做 → 補差額
      const stayers = this.mom.model.filter((tk) => this.lots.mom[tk] !== undefined || this.mom.owe[tk]);
      const scaleReason = crashFlip && w1 !== w0 ? '崩盤規則＋依波動度減碼' : crashFlip ? (this.crash.on ? '崩盤規則：動能減半' : '崩盤規則解除：動能恢復') : w1 !== w0 ? '依波動度減碼' : null;
      const stayerLines = [];
      for (const tk of stayers) {
        if (items.find((i) => i.tk === tk && i.f === 'F1')) continue;
        const cur = this.lots.mom[tk] || 0;
        const tgt = Math.max(0, this.sharesFor(Math.min(slotT, Math.max(cur * this.price(tk), crossRoom(tk) + cur * this.price(tk))), tk));
        if (scaleReason) { if (tgt !== cur) stayerLines.push(this.line(tk, 'mom', tgt - cur, scaleReason, crashFlip ? (this.crash.on ? 'F5' : 'F6') : 'F4')); }
        else if (this.mom.owe[tk]) {
          const owe = this.mom.owe[tk];
          stayerLines.push(this.line(tk, 'mom', tgt - cur, '上次沒照做' + (owe.nid ? '（通知 #' + owe.nid + '）' : '') + '，策略類持續列入', owe.f));
          this.addLog('F17', tk + '：上次的策略單沒照做 → 差額再列', owe.nid ? '通知 #' + owe.nid + '（' + owe.since + '）沒有照做，差額這個月再列一次。' : '', { cls: '月報', noCount: true, nid: owe.nid });
          delete this.mom.owe[tk];
        }
      }
      if (stayerLines.length) {
        if (crashItem && crashFlip) {
          crashItem.choices[0].lines = crashItem.choices[0].lines.concat(stayerLines.filter((l) => /崩盤/.test(l.reason)));
          const rest = stayerLines.filter((l) => !/崩盤/.test(l.reason));
          if (rest.length) items.push(this.item({ f: 'F4', kind: 'STRATEGY', title: '動能部位調整（' + (scaleReason || '') + '）', choices: [{ id: 'DO', label: '照做', lines: rest }], run: f4run && f4run.id }));
        } else {
          const scaleL = stayerLines.filter((l) => !/上次沒照做/.test(l.reason));
          if (scaleL.length) items.push(this.item({ f: 'F4', kind: 'STRATEGY', title: '動能部位調整（' + scaleReason + '：比例 ' + U.thirdLabel(w0) + ' → ' + U.thirdLabel(w1) + '）', choices: [{ id: 'DO', label: '照做', lines: scaleL }], run: f4run && f4run.id }));
          for (const l of stayerLines.filter((x) => /上次沒照做/.test(x.reason))) items.push(this.item({ f: l.f, tk: l.tk, kind: 'STRATEGY', title: l.tk + '：' + l.reason, choices: [{ id: 'DO', label: '照做', lines: [l] }] }));
        }
      }

      // C. 自選
      for (const tk of Object.keys(this.own)) {
        const o = this.own[tk];
        if (o.pendingMonthly) {
          const f = o.pendingMonthly.f;
          const lines = this.ownRuleLines(tk, f);
          const ai = this.ownAiChoice(tk, lines, f);
          const choices = [{ id: 'RULE', label: '照規則', lines }];
          let aiLine = null;
          if (ai && !ai.same) { choices.push({ id: 'AI', label: '照 AI', lines: ai.lines }); aiLine = 'AI（F24 檔位：' + TIER_NAME[ai.tier] + '）：' + (ai.lines[0].shares < 0 ? '賣 ' + (-ai.lines[0].shares) : ai.lines[0].shares > 0 ? '買 ' + ai.lines[0].shares : '不動，0') + ' 股'; }
          items.push(this.item({ f, tk, kind: 'OWN_RULE', title: tk + ' 慢規則' + (f === 'F7' ? '減半' : '加回') + '（' + o.pendingMonthly.date + ' 觸發，變動 < 5%，併入月報）', choices, aiLine, sameAsRule: ai && ai.same, run: ai && ai.run, onDone: (it, ch) => { if (ch === 'AI' && ai) this.applyTier(tk, ai.tier); } }));
          o.pendingMonthly = null;
          o.f24Suggest = null;
        } else if (o.f24Suggest) {
          const sgg = o.f24Suggest;
          const sh = Math.round(this.ownTarget(tk, T, sgg.tier) / this.price(tk)) - (this.lots.own[tk] || 0);
          if (sh !== 0) {
            const f = sgg.tier === 'RAISE' ? 'F23' : 'F24';
            items.push(this.item({
              f, tk, kind: 'AI_ONLY', title: tk + (sgg.tier === 'RAISE' ? ' 提高標準比重的建議（F23 規則條件成立＋F24 前提全部成立）' : ' 自選定期審查的建議'),
              aiLine: 'AI 建議：' + TIER_NAME[sgg.tier] + '，' + (sh < 0 ? '賣 ' + (-sh) : '買 ' + sh) + ' 股',
              choices: [{ id: 'AI', label: '照 AI', lines: [this.line(tk, 'own', sh, 'AI 檔位：' + TIER_NAME[sgg.tier], f)] }], defaultChoice: 'SKIP', ruleChoice: 'SKIP', run: sgg.run,
              onDone: (it, ch) => { if (ch === 'AI') this.applyTier(tk, sgg.tier); },
            }));
            if (f === 'F23') this.addLog('F23', tk + '：F24 選了 RAISE，月報列一行（附股數）', '同一檔每年最多一次；使用者選才做，接受後標準比重改成 125%。', { cls: '月報', lvl: 'A3', run: sgg.run });
          }
          o.f24Suggest = null;
        }
      }

      // D. 單檔上限、跨桶上限
      const allTk = new Set(Object.keys(this.lots.own).concat(Object.keys(this.lots.mom)));
      for (const tk of allTk) {
        const ov = this.tkValue(tk, 'own'), mv = this.tkValue(tk, 'mom');
        if (ov + mv > this.settings.crossHi * T && mv > 0 && ov > 0) {
          let cut = ov + mv - this.settings.capTo * T;
          const lines = [];
          const m = Math.min(mv, cut); lines.push(this.line(tk, 'mom', -Math.round(m / this.price(tk)), '跨桶上限：先減動能', 'F10')); cut -= m;
          if (cut > 0) lines.push(this.line(tk, 'own', -Math.round(cut / this.price(tk)), '跨桶上限', 'F10'));
          items.push(this.item({ f: 'F10', tk, kind: 'STRATEGY', title: tk + ' 自選＋動能合計 ' + U.pct((ov + mv) / T) + ' > 15% → 減回 10%', choices: [{ id: 'DO', label: '照做', lines }] }));
          this.addLog('F10', tk + ' 跨桶上限', '合計 ' + U.pct((ov + mv) / T) + '，先減動能那部分。不需要搭便車。', { cls: '月報', lvl: 'A0' });
        } else if (ov > this.settings.capHi * T) {
          const sh = -Math.round((ov - this.settings.capTo * T) / this.price(tk));
          items.push(this.item({ f: 'F10', tk, kind: 'STRATEGY', title: tk + ' 自選單檔 ' + U.pct(ov / T) + ' > 15% → 減回 10%', choices: [{ id: 'DO', label: '照做', lines: [this.line(tk, 'own', sh, '單檔上限', 'F10')] }] }));
          this.addLog('F10', tk + ' 單檔上限', '自選單檔 ' + U.pct(ov / T) + '。月報可以只為它下單。', { cls: '月報', lvl: 'A0' });
        }
      }

      // E. 搭便車：動能留任股偏離 ±50%
      const hasOther = items.length > 0;
      for (const tk of this.mom.model) {
        if (items.find((i) => i.tk === tk && i.kind === 'STRATEGY') || stayerLines.find((l) => l.tk === tk)) continue;
        const cur = this.lots.mom[tk] || 0;
        if (!cur) continue;
        const dev = cur * this.price(tk) / slotT - 1;
        if (Math.abs(dev) > 0.5) {
          if (hasOther) {
            const tgt = this.sharesFor(Math.min(slotT, crossRoom(tk) + cur * this.price(tk)), tk);
            items.push(this.item({ f: 'F3', tk, kind: 'STRATEGY', title: tk + ' 動能比例回調（偏離目標 ' + U.spct(dev, 0) + '，搭本月其他單）', choices: [{ id: 'DO', label: '照做', lines: [this.line(tk, 'mom', tgt - cur, '動能比例回調（搭便車）', 'F3')] }] }));
            this.addLog('F3', tk + ' 偏離 ' + U.spct(dev, 0) + ' → 搭便車回調', '本月本來就有其他單，所以一起做。', { cls: '月報', lvl: 'A0' });
          } else {
            this.addLog('F3', tk + ' 偏離 ' + U.spct(dev, 0) + '，但本月沒有其他單 → 不動', '只因比例漂移的調整不單獨發通知（§2.1 第 5 點）。', { cls: '不通知', lvl: 'A0', noCount: true });
          }
        }
      }

      // 還沒回覆的「補做差額」清單，和本月重列的策略單重疊 → 取消舊的
      for (const old of this.notifs) {
        if (old.status !== 'PENDING' || old.kind === 'MONTHLY') continue;
        for (const it of old.items) {
          if (it.kind === 'FIX' && !it.cancelled && items.some((i) => i.tk === it.tk && i.kind === 'STRATEGY')) {
            it.cancelled = true; it.note = '已併入 ' + this.monthKey() + ' 月報（策略類差額每月重列）';
            this.assume('fix-vs-monthly', '「做錯 → 補做差額」的清單還沒做、月報又把同一檔的策略類差額重列時，原型取消舊的補做清單、以月報為準，避免同一筆差額做兩次。');
          }
        }
        if (old.items.length && old.items.every((i) => i.cancelled)) old.status = 'READ';
      }

      // 狀態摘要
      const status = '崩盤規則：' + (this.crash.on ? '啟動中' : '未啟動') + '（VOO ' + U.spct(voo / ma - 1) + ' vs 200 日均線）；動能比例 ' + U.thirdLabel(this.mom.w) + '；動能相對 SPY ' + U.spct(this.stratDD(), 0);
      const top = rk.list.slice(0, 8).map((x, k) => (k + 1) + '.' + x.tk).join(' ');
      if (!items.length) {
        const n = this.newNotif({ kind: 'MONTHLY_EMPTY', title: this.monthKey() + ' 月報：本月不用動', text: status + '\n排名：' + top, runs, coreAbsorb: false });
        n.status = 'PENDING';
        this.addLog('SYS', '月報：本月不用動 → 通知 #' + n.id, '', { cls: '月報' });
      } else {
        const n = this.newNotif({ kind: 'MONTHLY', title: this.monthKey() + ' 月報', items, runs, text: status + '\n排名：' + top });
        this.addLog('SYS', '月報產生 → 通知 #' + n.id + '（' + items.length + ' 項）', '合併下單：先算每一桶的目標，再按代號合併成淨買賣清單；核心吸收差額。', { cls: '月報' });
      }
      // F21 策略檢討
      this.checkF21();
      if (wasOn !== this.crash.on) { /* 已記錄 */ }
    },
    momExitItem(tk, held, why) {
      return this.item({
        f: 'F2', tk, kind: 'STRATEGY', title: tk + ' 動能出場（' + why + '）', choices: [{ id: 'DO', label: '照做', lines: [this.line(tk, 'mom', -held, '動能出場', 'F2')] }],
        actions: ['TRANSFER'],
      });
    },
    momEntryItem(tk, sh, rank, run, replacement) {
      return this.item({
        f: 'F1', tk, kind: 'STRATEGY', title: tk + ' 動能進場（排名第 ' + rank + (replacement ? '，遞補' : '') + '）', choices: [{ id: 'DO', label: '照做', lines: [this.line(tk, 'mom', sh, '動能換股', 'F1')] }],
        actions: ['EXCLUDE', 'ADOPT'], run: run.id, aiLine: run.verdict === 'ALLOW_WATCH' ? '任務 A：准許但觀察（' + (run.watch_reason || '') + '）' : null,
      });
    },
    checkF21() {
      const dd = this.stratDD();
      for (const th of [-0.2, -0.3, -0.4, -0.5]) {
        if (dd <= th && !this.strat.notified.includes(th)) {
          this.strat.notified.push(th);
          if (!this.strat.eventStart) this.strat.eventStart = this.monthKey();
          const run = this.addRun(AI.strategyReview(this, dd));
          this.newNotif({ kind: 'INFO', title: '策略檢討提醒：動能相對 SPY 落後超過 ' + U.pct(-th, 0), text: '這是提醒，不附清單、不會自動停用。落後事件從 ' + this.strat.eventStart + ' 開始，目前 ' + U.spct(dd, 0) + '。前提的正反證據 → 網站。', runs: [run.id] });
          this.addLog('F21', '策略檢討提醒：落後 ' + U.pct(-th, 0), 'AI 只列前提的正反證據，不給停用或繼續的建議（A1）。要暫停可以把 Strategy 比例調成 0（F13）。', { cls: '不定期提醒', lvl: 'A1', run: run.id });
        }
      }
    },

    // ---------- 使用者觸發 ----------
    itemAction(nid, key, action, payload) {
      const n = this.notifs.find((x) => x.id === nid);
      const it = n && n.items.find((x) => x.key === key);
      if (!it || n.status !== 'PENDING') return;
      const tk = it.tk;
      if (action === 'TRANSFER') {
        // 轉入自選：動能叫你賣，你想留
        const sh = this.lots.mom[tk] || 0;
        this.lots.mom[tk] = 0; delete this.lots.mom[tk];
        this.lots.own[tk] = (this.lots.own[tk] || 0) + sh;
        this.addOwnMeta(tk, payload.reason, 'TRANSFER');
        it.cancelled = true; it.note = '已轉入自選（不用下單）';
        this.shadow.push({ date: this.dateKey(), f: 'F16', tk, title: '轉入自選（如果照賣）', rule: -sh, ai: null, actual: 0, price0: this.price(tk), choice: 'TRANSFER' });
        this.addLog('F16', tk + ' 轉入自選：' + sh + ' 股改歸自選桶', '理由：「' + payload.reason + '」→ 成為這檔的前提（來源：使用者），之後 F24 每月檢查、F25 監測。「如果照賣」記進影子。動能桶這一格本月已由排名遞補（若有）。' + (this.tkValue(tk, 'own') > this.settings.capHi * this.total() ? ' 轉入後超過 15%，照單檔上限處理。' : ''), { cls: '記影子', lvl: 'A0' });
      } else if (action === 'EXCLUDE') {
        this.mom.excluded[tk] = { reason: payload.reason, date: this.dateKey() };
        this.mom.model = this.mom.model.filter((x) => x !== tk);
        it.cancelled = true; it.note = '已排除：' + payload.reason;
        this.shadow.push({ date: this.dateKey(), f: 'F16', tk, title: '排除（如果沒排除）', rule: it.choices[0].lines[0].shares, ai: null, actual: 0, price0: this.price(tk), choice: 'EXCLUDE' });
        this.addLog('F16', tk + ' 排除（動能）', '理由：「' + payload.reason + '」。排除清單在網站，可隨時取消；由下一名遞補（同否決，受任務 A 審查）。「如果沒排除」記進影子。', { cls: '記影子', lvl: 'A0' });
        // 遞補
        const rk = this.ranks();
        const c = rk.list.find((x) => !this.mom.model.includes(x.tk) && !this.mom.excluded[x.tk] && !this.mom.adopted[x.tk] && !(this.mom.vetoes[x.tk] && this.mom.vetoes[x.tk].month === this.monthKey()) && !n.items.find((i) => i.tk === x.tk));
        if (c) {
          const run = this.addRun(AI.taskA(this, c.tk, rk.map[c.tk].rank));
          if (!(run.verdict === 'VETO' && this.unanimous(run.vote, 'VETO'))) {
            this.mom.model.push(c.tk);
            const T = this.total();
            const val = Math.min(this.slotTarget(T), this.settings.crossBuy * T - this.tkValue(c.tk, 'own') - this.tkValue(c.tk, 'mom'));
            n.items.push(this.momEntryItem(c.tk, Math.max(0, this.sharesFor(val, c.tk)), rk.map[c.tk].rank, run, true));
            this.addLog('F1', '遞補：' + c.tk + '（排名第 ' + rk.map[c.tk].rank + '）→ 任務 A：' + run.verdict, '加到同一份清單。', { cls: '月報', lvl: 'A4', run: run.id });
          }
        }
      } else if (action === 'ADOPT') {
        // 認養：動能選出、你也看好 → 劃進自選。這裡的作法：照常買進，但記在自選桶
        this.mom.adopted[tk] = { date: this.dateKey(), reason: payload.reason };
        this.mom.model = this.mom.model.filter((x) => x !== tk);
        const ln = it.choices[0].lines[0];
        it.choices[0].lines = [this.line(tk, 'own', ln.shares, '認養：買進後歸自選', 'F16')];
        it.title += '（認養 → 自選）';
        this.addOwnMeta(tk, payload.reason, 'ADOPT');
        this.addLog('F16', tk + ' 認養', '劃進自選，之後動能就算把它排除也不會叫你賣。動能少一檔，下一次月報照排名遞補（受跨桶上限限制）。', { cls: '記影子', lvl: 'A0' });
        this.assume('adopt-buy', '認養的這一筆照常買進，但記在自選桶；這一格動能下個月才遞補（設計 §2.3 寫「下一次月報照排名遞補」）。所以本月動能只有 4 檔。');
      }
    },
    addOwnMeta(tk, reason, origin) {
      if (this.own[tk]) { if (reason) this.own[tk].premises.push({ id: 'P' + (this.own[tk].premises.length + 1), text: reason, origin: 'USER' }); return; }
      const rec = this.recommendStd(Object.keys(this.own).concat([tk]));
      const ind = this.ind(tk);
      this.own[tk] = { state: ind.dd <= -0.2 ? 'HALF' : 'STD', lastSwitch: this.d, std: rec[tk], premises: reason ? [{ id: 'P1', text: reason, origin: 'USER' }] : [], conditions: [], r1: null, lastF24: null, f24Suggest: null, f25Sent: {}, metConds: {}, raisedAt: null, flags: [], pendingMonthly: null, origin };
    },

    deposit(x) {
      const T0 = this.total();
      const T = T0 + x;
      this.snap.cash += x;
      const items = [];
      const cells = [];
      for (const tk of Object.keys(this.own)) cells.push({ tk, bucket: 'own', gap: this.ownTarget(tk, T) - this.tkValue(tk, 'own'), what: '自選標準比重' + (this.own[tk].state === 'HALF' ? '的一半' : '') });
      const slotT = this.slotTarget(T);
      for (const tk of this.mom.model) {
        const room = this.settings.crossBuy * T - this.tkValue(tk, 'own') - this.tkValue(tk, 'mom');
        cells.push({ tk, bucket: 'mom', gap: Math.min(slotT - this.tkValue(tk, 'mom'), room), what: '動能每檔目標' });
      }
      cells.sort((a, b) => b.gap - a.gap);
      let budget = (this.snap.cash) * 0.98;
      const lines = [];
      const skipped = [];
      for (const c of cells) {
        if (c.gap < this.settings.minGap * T) { if (c.gap > 0) skipped.push(c.tk); continue; }
        const v = Math.min(c.gap, budget);
        const sh = this.sharesFor(v, c.tk);
        if (sh <= 0) continue;
        lines.push(this.line(c.tk, c.bucket, sh, '入金：補「低於目標最多」的格子（' + c.what + '）', 'F11'));
        budget -= sh * this.price(c.tk);
      }
      if (budget > 0) {
        if (this.crash.on) {
          const a = this.sharesFor(budget / 2, 'VOO'), b = this.sharesFor(budget / 2, 'SGOV');
          if (a) lines.push(this.line('VOO', 'core', a, '入金剩下的進核心（崩盤規則啟動中：一半 VOO）', 'F11'));
          if (b) lines.push(this.line('SGOV', 'core', b, '入金剩下的進核心（一半短債）', 'F11'));
        } else {
          const a = this.sharesFor(budget, 'VOO');
          if (a) lines.push(this.line('VOO', 'core', a, '入金剩下的進核心', 'F11'));
        }
      }
      items.push(this.item({ f: 'F11', kind: 'CASHFLOW', title: '入金 ' + U.money(x) + '：只買不賣', choices: [{ id: 'DO', label: '照做', lines }] }));
      const n = this.newNotif({ kind: 'CASHFLOW', title: '入金 ' + U.money(x) + ' 的清單', items, coreAbsorb: false });
      this.addLog('F11', '入金 ' + U.money(x) + ' → 當天清單 #' + n.id, '用入金後的總資產 ' + U.money(T) + ' 算每一格的當下目標，依序補給低於目標最多的格子；缺口 < 0.25% 不補' + (skipped.length ? '（' + skipped.join('、') + '）' : '') + '；剩下的進核心。不為了入金賣任何東西。', { cls: '當天', lvl: 'A0' });
      if (this.isFirstOfMonth(this.d) && this.phase === 'PRE') this.assume('deposit-monthly', '入金剛好在月報日時，設計說要和月報合成一份清單；原型沒有合併，會是兩則通知。');
    },
    withdraw(x) {
      const T0 = this.total();
      const T = T0 - x;
      const lines = [];
      const notes = [];
      let need = x - Math.max(0, this.snap.cash);
      const sell = (tk, bucket, val, reason) => {
        const have = (this.lots[bucket][tk] || 0) + lines.filter((l) => l.tk === tk && l.bucket === bucket).reduce((a, l) => a + l.shares, 0);
        const sh = Math.min(have, Math.ceil(val / this.price(tk)));
        if (sh > 0) { lines.push(this.line(tk, bucket, -sh, reason, 'F12')); return sh * this.price(tk); }
        return 0;
      };
      // 單檔上限預先檢查
      for (const tk of Object.keys(this.own)) {
        const v = this.tkValue(tk, 'own');
        if (v > this.settings.capHi * T) { const got = sell(tk, 'own', v - this.settings.capTo * T, '出金前單檔上限檢查：出金後會超過 15% → 減回 10%'); need -= got; notes.push(tk + ' 出金後會占 ' + U.pct(v / T) + '，先減回 10%'); }
      }
      if (need > 0 && this.crash.on) need -= sell('SGOV', 'core', need, '① 核心的現金（短債）');
      if (need > 0) {
        const slotT = this.slotTarget(T);
        for (const tk of this.mom.model) { if (need <= 0) break; const over = this.tkValue(tk, 'mom') - slotT; if (over > 0) need -= sell(tk, 'mom', Math.min(over, need), '② 動能高於目標的部分'); }
      }
      if (need > 0) need -= sell('VOO', 'core', need, '③ VOO');
      if (need > 0) { const tot = this.bucketValue('mom'); for (const tk of this.mom.model) need -= sell(tk, 'mom', need * this.tkValue(tk, 'mom') / tot, '④ 動能按比例'); }
      if (need > 0) { const tot = this.bucketValue('own'); for (const tk of Object.keys(this.own)) sell(tk, 'own', need * this.tkValue(tk, 'own') / tot, '⑤ 自選按比例'); }
      const it = this.item({ f: 'F12', kind: 'CASHFLOW', title: '出金 ' + U.money(x) + '：只賣不買', choices: [{ id: 'DO', label: '照做', lines }] });
      const n = this.newNotif({ kind: 'CASHFLOW', title: '出金 ' + U.money(x) + ' 的清單', items: [it], coreAbsorb: false, withdraw: x });
      this.addLog('F12', '出金 ' + U.money(x) + ' → 當天清單 #' + n.id, (notes.length ? notes.join('；') + '。' : '') + '順序：① 核心的現金（崩盤規則啟動時）→ ② 動能高於目標 → ③ VOO → ④ 動能按比例 → ⑤ 自選按比例。成交後模擬你把錢轉出。', { cls: '當天', lvl: 'A0' });
    },
    changeRatio(r) {
      const old = Object.assign({}, this.settings.ratio);
      const T = this.total();
      const dd = this.stratDD();
      this.settings.ratio = r;
      const lines = [];
      // 自選：按比例縮放（股數 × 新/舊），標準比重同比例
      if (Math.abs(r.own - old.own) > 1e-9) {
        this.assume('ratio-own', '改自選比例時，每檔自選的股數與標準比重都乘上「新比例 / 舊比例」（保留各檔之間的漂移）。設計沒有寫自選這一側怎麼調。');
        for (const tk of Object.keys(this.own)) {
          const f = old.own > 0 ? r.own / old.own : 1;
          this.own[tk].std *= f;
          const cur = this.lots.own[tk] || 0;
          const d = Math.round(cur * f) - cur;
          if (d) lines.push(this.line(tk, 'own', d, '改比例：自選 ' + U.pct(old.own, 0) + ' → ' + U.pct(r.own, 0), 'F13'));
        }
      }
      const slotT = this.slotTarget(T);
      for (const tk of Object.keys(this.lots.mom)) {
        const cur = this.lots.mom[tk] || 0;
        const tgt = this.mom.model.includes(tk) ? this.sharesFor(slotT, tk) : 0;
        if (tgt !== cur) lines.push(this.line(tk, 'mom', tgt - cur, '改比例：Strategy ' + U.pct(old.strat, 0) + ' → ' + U.pct(r.strat, 0), 'F13'));
      }
      const it = this.item({ f: 'F13', kind: 'CASHFLOW', title: '改比例：自選 / Strategy / 核心 ' + [old.own, old.strat, old.core].map((x) => U.pct(x, 0)).join(' / ') + ' → ' + [r.own, r.strat, r.core].map((x) => U.pct(x, 0)).join(' / '), choices: [{ id: 'DO', label: '照做', lines }] });
      const n = this.newNotif({ kind: 'CASHFLOW', title: '改比例的清單', items: [it], explain: [{ f: 'F13', text: '附上狀態（規則算的，AI 不評論）：動能目前相對 SPY ' + U.spct(dd, 0) + (this.strat.eventStart ? '，落後事件從 ' + this.strat.eventStart + ' 開始。在落後時調成 0 等於在相對低點放棄它（§2.1 第 7 點）。' : '。') }] });
      this.shadow.push({ date: this.dateKey(), f: 'F13', tk: null, title: '改比例（影子組合繼續追蹤「如果沒改」）', rule: 0, ai: null, actual: 0, price0: 0, choice: 'RATIO', ratioOld: old, ratioNew: r });
      this.addLog('F13', '改比例 → 當天清單 #' + n.id, '和入金一樣是使用者觸發的事件。記錄日期與原因；影子組合繼續追蹤「如果沒改」。AI 不參與（A0）。', { cls: '當天', lvl: 'A0' });
    },
    addOwn(tk, prem) {
      const T = this.total();
      const ind = this.ind(tk);
      const rec = this.recommendStd(Object.keys(this.own).concat([tk]));
      const half = ind.dd <= -0.2;
      const rk = this.ranks().map[tk];
      // 健檢
      const corrs = Object.keys(this.own).concat(this.mom.model).filter((x) => x !== tk).map((x) => {
        const a = [], b = [];
        const i = this.sIdx();
        for (let k = i - 251; k <= i; k++) { a.push(this.market.close[tk][k] / this.market.close[tk][k - 1] - 1); b.push(this.market.close[x][k] / this.market.close[x][k - 1] - 1); }
        return { tk: x, c: U.corr(a, b) };
      }).sort((p, q) => q.c - p.c);
      const hits = ((this.scen.hardScan || {})[tk]) || [];
      let premises;
      if (prem.origin === 'USER') premises = prem.items.map((t, k) => ({ id: 'P' + (k + 1), text: t, origin: 'USER' }));
      else if (prem.origin === 'AI_DRAFT_ACCEPTED') premises = prem.items.map((p, k) => ({ id: 'P' + (k + 1), text: p.text, breaks_if: p.breaks_if, origin: 'AI_DRAFT_ACCEPTED' }));
      else premises = [
        { id: 'P1', text: '沒有硬事件（重編、換會計師、被收購、重大監管）', origin: 'SYSTEM_DEFAULT' },
        { id: 'P2', text: '營收年增率沒有連兩季轉負', origin: 'SYSTEM_DEFAULT' },
        { id: 'P3', text: '稀釋 EPS 沒有連兩季年減', origin: 'SYSTEM_DEFAULT' },
        { id: 'P4', text: '慢規則本身（距高點 -20% 減半）', origin: 'SYSTEM_DEFAULT' },
      ];
      const summary = '距高點 ' + U.pct(ind.dd) + '、' + (ind.above200 ? '在' : '在') + ' 200 日均線' + (ind.above200 ? '之上' : '之下') + '、動能排名 ' + (rk ? '第 ' + rk.rank : '不在股票池') + '、年化波動 ' + U.pct(ind.vol, 0) + '；和 ' + corrs[0].tk + ' 一年相關係數 ' + corrs[0].c.toFixed(2) + '；硬事件掃描 ' + (hits.length ? '命中 ' + hits.length + ' 項' : '沒有命中') + '。';
      const run = this.addRun(AI.healthCheck(this, tk, {
        summary,
        premises,
        sections: [
          { title: '① 規則數字（程式算）', text: '距 52 週高點 ' + U.pct(ind.dd) + '；200 日均線 ' + U.px(ind.ma200) + '（收盤 ' + U.px(ind.close) + '）；動能排名 ' + (rk ? rk.rank : '—') + '；年化波動 ' + U.pct(ind.vol, 0) + '。建議標準比重（波動度反比，自選預算 ' + U.pct(this.settings.ratio.own, 0) + ' 內）：' + Object.entries(rec).map(([k, v]) => k + ' ' + U.pct(v)).join('、') + '。其他自選股的推薦值也重算了，但不會因此叫你賣。' },
          { title: '② 和現有持股的一年相關係數（題材集中）', text: corrs.slice(0, 5).map((x) => x.tk + ' ' + x.c.toFixed(2)).join('、') },
          { title: '③ 硬事件掃描（規則偵測，同任務 A）', text: hits.length ? hits.join('\n') : '8-K 4.02／4.01、延遲申報、被收購、增資：都沒有命中。' },
          { title: '④ 這檔的前提（來源：' + { USER: '使用者寫的', AI_DRAFT_ACCEPTED: '使用者勾選的 AI 草稿', SYSTEM_DEFAULT: '系統預設' }[prem.origin] + '）', text: premises.map((p) => p.id + ' ' + p.text + (p.breaks_if ? '（不成立的訊號：' + p.breaks_if + '）' : '')).join('\n') },
          { title: '不做的事', text: '健檢只提供資訊，不給「建議買／不建議買」的結論；完整 /trading-analysis 不自動跑，網站保留手動按鈕。第一次 F24 在下一個月報前跑。' },
        ],
      }));
      this.own[tk] = { state: half ? 'HALF' : 'STD', lastSwitch: this.d, std: rec[tk], premises, conditions: [], r1: null, lastF24: null, f24Suggest: null, f25Sent: {}, metConds: {}, raisedAt: null, flags: [], pendingMonthly: null, origin: 'NEW' };
      const tgt = this.ownTarget(tk, T);
      const sh = this.sharesFor(tgt, tk);
      const room = this.settings.crossBuy * T - this.tkValue(tk, 'mom');
      const it = this.item({ f: 'F14', tk, kind: 'CASHFLOW', title: '新增自選 ' + tk + '：' + (half ? '已距高點 ' + U.pct(ind.dd) + ' → 一開始就是「減半」狀態，只買標準比重的一半' : '買到標準比重 ' + U.pct(rec[tk])), choices: [{ id: 'DO', label: '照做', lines: [this.line(tk, 'own', sh, '新增自選', 'F14')] }], run: run.id, aiLine: '健檢：' + summary });
      const n = this.newNotif({ kind: 'CASHFLOW', title: '新增自選 ' + tk, items: [it], runs: [run.id], coreAbsorb: true, text: '錢從核心出（賣 VOO）。單檔上限還剩 ' + U.money(this.settings.capHi * T - tgt) + '；跨桶上限：動能已持有 ' + U.money(this.tkValue(tk, 'mom')) + '。' });
      this.addLog('F14', '新增自選 ' + tk + ' → 健檢＋當天清單 #' + n.id, '健檢（A1，只提供資訊）：' + summary + ' 前提來源：' + prem.origin + '。', { cls: '當天', lvl: 'A1', run: run.id });
      if (room < tgt) this.addLog('F10', tk + '：自選＋動能合計會超過 10%', '動能已經持有，跨桶上限的空間只剩 ' + U.money(room) + '。', { noCount: true });
    },
    removeOwn(tk) {
      const sh = this.lots.own[tk] || 0;
      const it = this.item({ f: 'F15', tk, kind: 'CASHFLOW', title: '移除自選 ' + tk, choices: [{ id: 'DO', label: '照做', lines: [this.line(tk, 'own', -sh, '移除自選', 'F15')] }], onDone: (it2, ch) => { if (ch === 'DO') { delete this.own[tk]; } } });
      const n = this.newNotif({ kind: 'CASHFLOW', title: '移除自選 ' + tk, items: [it] });
      this.shadow.push({ date: this.dateKey(), f: 'F15', tk, title: '移除自選（如果繼續持有）', rule: 0, ai: null, actual: -sh, price0: this.price(tk), choice: 'REMOVE' });
      this.addLog('F15', '移除自選 ' + tk + ' → 清單 #' + n.id, '賣掉的錢交給核心。AI 不參與；記影子。', { cls: '當天', lvl: 'A0' });
    },
    manualTrade(tk, q) {
      const p = this.price(tk);
      this.snap.shares[tk] = (this.snap.shares[tk] || 0) + q;
      this.snap.cash -= q * p;
      this.lots.unc[tk] = (this.lots.unc[tk] || 0) + q;
      const n = this.newNotif({ kind: 'CLASSIFY', title: '快照出現清單外的變動：' + tk + ' ' + (q > 0 ? '+' : '') + q + ' 股', tk, q, coreAbsorb: false });
      this.addLog('F17', '你填了快照：' + tk + ' ' + (q > 0 ? '+' : '') + q + ' 股（清單上沒有）', '系統問：這是手動交易、新增自選還是轉入自選？屬於哪一桶？標記之前月報不下單（§2.1.1）。', { cls: '當天', lvl: 'A0' });
    },
    classify(nid, bucket, reason) {
      const n = this.notifs.find((x) => x.id === nid);
      if (!n || n.status !== 'PENDING') return;
      const tk = n.tk, q = this.lots.unc[tk] || 0;
      delete this.lots.unc[tk];
      if (bucket === 'own' && !this.own[tk] && q > 0) { this.addOwnMeta(tk, reason, 'MANUAL'); if (!reason) this.own[tk].premises = [{ id: 'P1', text: '系統預設前提（沒有硬事件；營收、EPS 沒有連兩季轉差；慢規則）', origin: 'SYSTEM_DEFAULT' }]; }
      if (bucket === 'mom' && q > 0 && !this.mom.model.includes(tk)) this.assume('manual-mom', '手動買進的股票被劃到動能桶，但它不在動能模型名單裡 → 下一份月報會把它當成「上次沒照做的出場」再列一次。');
      this.lots[bucket][tk] = (this.lots[bucket][tk] || 0) + q;
      n.status = 'DONE';
      n.classified = BUCKET_NAME[bucket];
      this.addLog('F17', tk + ' ' + (q > 0 ? '+' : '') + q + ' 股 → 歸到' + BUCKET_NAME[bucket], reason ? '理由：' + reason : '', { cls: '記影子', lvl: 'A0' });
      if (this.monthlyBlocked && !Object.values(this.lots.unc).some((x) => x)) {
        this.addLog('SYS', '分類完成 → 重算月報', '', {});
        this.monthly();
      }
    },
  };

  G.Engine = { create, FNAME, BUCKET_NAME, TIER_NAME };
})(typeof window !== 'undefined' ? window : globalThis);
