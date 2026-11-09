// 假的 AI 層。真正的系統會：程式備好證據包 → LLM 只能引用證據包 → 程式檢查引用 → 票數。
// 這裡全部用情境預先寫好的輸出（scenario.ai），沒寫到的用預設輸出。所有內容都是虛構的。
(function (G) {
  'use strict';
  const U = G.U;

  let seq = 0;
  function runId(asOf, fn, tk) { seq++; return asOf + '_' + fn + (tk ? '_' + tk : '') + '_' + seq; }

  function base(sim, f, fname, tk, extra) {
    const asOf = sim.signalDate();
    return Object.assign({
      id: runId(asOf, f, tk), f, fname, tk: tk || null, as_of: asOf, created: sim.dateLabel(),
      model: 'claude-opus-5-5（模擬）', samples: 1, vote: null, verdict: null, summary: '', premises: [], evidence: [],
      conditions: [], sections: [], simulated: true,
    }, extra || {});
  }

  // F1 任務 A：否決法庭
  function taskA(sim, tk, rank) {
    const key = 'F1:' + tk;
    const sc = (sim.scen.ai || {})[key];
    const ruleHits = (sc && sc.ruleHits) || [];
    if (!ruleHits.length) {
      return base(sim, 'F1', '動能新股進場（任務 A）', tk, {
        model: 'claude-sonnet-5-5（模擬）', verdict: 'ALLOW', vote: null, ruleHits: [],
        summary: '規則偵測段沒有命中（EDGAR 申報、單日漲幅占比、XBRL 盈餘、增資都正常），只寫一句准許說明，沒有開完整法庭。',
        sections: [{ title: '准許說明（一次 Sonnet 呼叫）', text: tk + ' 目前排名第 ' + rank + '。過去 12 個月漲幅分散在多個月份，最大單日漲幅占 12 個月漲幅不到 15%；最近兩季稀釋 EPS 年增率為正；過去 6 個月沒有增資、收購相關申報。准許進場。' }],
      });
    }
    const r = base(sim, 'F1', '動能新股進場（任務 A）', tk, Object.assign({
      samples: 3, ruleHits,
    }, sc));
    return r;
  }

  // F5／F6 崩盤規則檢視
  function crashReview(sim, direction) {
    const key = (direction === 'ON' ? 'F5' : 'F6') + ':' + sim.monthKey();
    const sc = (sim.scen.ai || {})[key] || {};
    return base(sim, direction === 'ON' ? 'F5' : 'F6', direction === 'ON' ? '崩盤規則啟動的 AI 檢視' : '崩盤規則解除的 AI 檢視', null, Object.assign({
      samples: 3, verdict: 'FOLLOW', vote: { FOLLOW: 3, DELAY: 0 },
      summary: '基準率：過去 17 次觸發中 3 次是真空頭。儀表板沒有明顯異常，意見：照做。',
      sections: [{ title: '基準率', text: '2000–2026 啟動 17 次：3 次真空頭（買回便宜 13～34%）、1 次持平、13 次買回更貴（+2～+14%）。' }],
    }, sc));
  }

  // F24 自選定期審查
  function ownReview(sim, tk, why) {
    const own = sim.own[tk];
    const key = 'F24:' + tk + ':' + sim.dateKey();
    const key2 = 'F24:' + tk + ':' + sim.monthKey();
    const sc = (sim.scen.ai || {})[key] || (sim.scen.ai || {})[key2];
    const cur = own.state === 'HALF' ? 'HALF' : 'STANDARD';
    const premises = (own.premises || []).map((p) => Object.assign({ status: 'HOLDS' }, p));
    const out = base(sim, 'F24', '自選定期審查（' + why + '）', tk, {
      samples: 3, verdict: 'HOLD', vote: null, premises,
      summary: '前提都成立，沒有新的財報或事件證據。檔位：不動。只放網站。',
      conditions: own.conditions && own.conditions.length ? own.conditions : [],
      sections: [
        { title: '分析師（Sonnet）', text: '新聞：沒有和前提相關的事件。基本面：最近一季營收、毛利率與前一季相近。' },
        { title: '多方／空方（各自獨立寫，再互看一輪）', text: '多方：前提仍成立。空方：估值偏高，但「估值」不是可以推翻前提的具體證據。' },
        { title: '經理 ×3（Opus）', text: '3 票：不動。' },
      ],
    });
    if (sc) {
      Object.assign(out, sc);
      if (sc.premiseStatus) out.premises = premises.map((p) => Object.assign({}, p, sc.premiseStatus[p.id] || {}));
    }
    // 票數：沒寫就當 3 票一致
    if (!out.vote) { const v = {}; v[out.verdict] = 3; out.vote = v; }
    return out;
  }

  // F25 事件條件確認
  function conditionCheck(sim, tk, cond, news) {
    const key = 'F25:' + tk + ':' + cond.id;
    const sc = (sim.scen.ai || {})[key] || {};
    return base(sim, 'F25', '自選條件監測（事件條件確認）', tk, Object.assign({
      model: 'claude-sonnet-5-5 ×3（模擬）', samples: 3, verdict: 'MET', vote: { MET: 3, NOT_MET: 0 },
      summary: '條件 ' + cond.id + '「' + cond.text + '」：3 票都判斷成立，引用通過檢查。',
      evidence: [{ id: 'E1', source: news.source || '新聞', date: sim.dateKey(), quote: news.text }],
      condition: cond,
    }, sc));
  }

  // F19 持股硬事件
  function hardEvent(sim, tk, ev) {
    const key = 'F19:' + tk;
    const sc = (sim.scen.ai || {})[key] || {};
    return base(sim, 'F19', '持股硬事件（任務 A 硬事件版）', tk, Object.assign({
      samples: 3, verdict: 'EXIT', vote: { EXIT: 3, HOLD: 0 }, reason_code: ev.code,
      summary: '事件讓持有的前提失效，建議提早出場。',
      evidence: [{ id: 'E1', source: ev.form, date: sim.dateKey(), quote: ev.text }],
    }, sc));
  }

  // 任務 C：說明
  function taskC(sim, f, tk, ctx) {
    const key = 'C:' + f + ':' + (tk || '') + ':' + sim.monthKey();
    const sc = (sim.scen.ai || {})[key] || {};
    return base(sim, f, '原因說明（任務 C）', tk, Object.assign({
      model: 'claude-sonnet-5-5（模擬）', verdict: 'EXPLAIN',
      summary: ctx.summary || '',
      sections: ctx.sections || [],
    }, sc));
  }

  // F14 健檢
  function healthCheck(sim, tk, data) {
    const sc = (sim.scen.ai || {})['F14:' + tk] || {};
    return base(sim, 'F14', '新增自選健檢', tk, Object.assign({
      model: 'claude-sonnet-5-5（模擬）', verdict: 'INFO', summary: data.summary, sections: data.sections, premises: data.premises,
    }, sc.extra || {}));
  }
  function draftPremises(sim, tk) {
    const sc = (sim.scen.ai || {})['F14:' + tk];
    if (sc && sc.drafts) return sc.drafts;
    return [
      { id: 'D1', text: tk + ' 未來兩年營收維持兩位數成長（目前價格隱含的成長率）', breaks_if: '營收年增率連兩季低於 5%' },
      { id: 'D2', text: '主要產品的毛利率維持在最近四季的區間內', breaks_if: '毛利率低於最近四季最低值' },
      { id: 'D3', text: '（不容易想到的風險）最大客戶的訂單沒有轉向自製或競爭對手', breaks_if: '最大客戶公開宣布自製或更換供應商' },
    ];
  }

  // F21 策略檢討
  function strategyReview(sim, dd) {
    const sc = (sim.scen.ai || {})['F21:' + sim.monthKey()] || {};
    return base(sim, 'F21', '策略檢討說明', null, Object.assign({
      verdict: 'EXPLAIN',
      summary: '純動能部位相對 SPY 落後 ' + U.pct(-dd, 0) + '。只列前提的正反證據，不給停用或繼續的建議。',
      sections: [
        { title: '歷史對照（程式算）', text: 'French 動能因子 1927 年起，同等深度的相對回撤 7 次，中位數 26 個月恢復。' },
        { title: '前提：漲勢來自資訊慢慢反映', text: '支持：本月排名前 5 的漲勢仍是連續累積型。反對：最近 3 個月有 2 檔的漲幅集中在財報跳空。' },
        { title: '前提：漲勢有基本面支撐', text: '支持：持股最近一季盈餘多數上修。反對：其中 1 檔股價與盈餘背離。' },
      ],
    }, sc));
  }

  G.AI = { taskA, crashReview, ownReview, conditionCheck, hardEvent, taskC, healthCheck, draftPremises, strategyReview };
})(typeof window !== 'undefined' ? window : globalThis);
