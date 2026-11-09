// 假價格產生器。
// 每段用「布朗橋」的方式：雜訊照產生，但整段的總報酬固定成指定值，
// 這樣情境作者可以精確控制「252 日報酬排名」「距 52 週高點」「是否跌破 200 日均線」。
(function (G) {
  'use strict';
  const U = G.U;

  const PRE = 330; // 情境開始前的歷史天數（要夠算 252 日報酬與 200 日均線）

  // 股票池（虛構的價格；代號只是為了好讀）
  const META_INFO = {
    VOO: { name: 'Vanguard S&P 500 ETF', sector: 'ETF' },
    SGOV: { name: '短期美債 ETF（核心的「現金」）', sector: 'ETF' },
    MU: { name: 'Micron', sector: '半導體' },
    NVDA: { name: 'NVIDIA', sector: '半導體' },
    MSFT: { name: 'Microsoft', sector: '軟體' },
    META: { name: 'Meta Platforms', sector: '通訊' },
    AAPL: { name: 'Apple', sector: '硬體' },
    AMZN: { name: 'Amazon', sector: '零售' },
    GOOGL: { name: 'Alphabet', sector: '通訊' },
    AVGO: { name: 'Broadcom', sector: '半導體' },
    TSLA: { name: 'Tesla', sector: '汽車' },
    LLY: { name: 'Eli Lilly', sector: '醫療' },
    JPM: { name: 'JPMorgan', sector: '金融' },
    V: { name: 'Visa', sector: '金融' },
    XOM: { name: 'Exxon', sector: '能源' },
    UNH: { name: 'UnitedHealth', sector: '醫療' },
    COST: { name: 'Costco', sector: '零售' },
    NFLX: { name: 'Netflix', sector: '通訊' },
    ORCL: { name: 'Oracle', sector: '軟體' },
    AMD: { name: 'AMD', sector: '半導體' },
    WMT: { name: 'Walmart', sector: '零售' },
    PLTR: { name: 'Palantir', sector: '軟體' },
    APP: { name: 'AppLovin', sector: '軟體' },
    GE: { name: 'GE Aerospace', sector: '工業' },
    GS: { name: 'Goldman Sachs', sector: '金融' },
    CAT: { name: 'Caterpillar', sector: '工業' },
    IBM: { name: 'IBM', sector: '軟體' },
    KO: { name: 'Coca-Cola', sector: '必需消費' },
  };
  // 動能股票池（設計 §3：S&P 500 → 成交金額前 100 → 市值前 50；這裡縮成 26 檔）
  const UNIVERSE = ['MU', 'NVDA', 'MSFT', 'META', 'AAPL', 'AMZN', 'GOOGL', 'AVGO', 'TSLA', 'LLY', 'JPM', 'V',
    'XOM', 'UNH', 'COST', 'NFLX', 'ORCL', 'AMD', 'WMT', 'PLTR', 'APP', 'GE', 'GS', 'CAT', 'IBM', 'KO'];

  function bridge(r, n, totalRet, annVol) {
    const dv = annVol / Math.sqrt(252);
    const z = [];
    for (let i = 0; i < n; i++) z.push(U.gauss(r) * dv);
    const m = z.reduce((a, b) => a + b, 0) / n;
    const target = Math.log(1 + totalRet) / n;
    return z.map((x) => x - m + target);
  }

  // spec: { start: '2026-11-23', nAfter: 70, tickers: { TK: { p0, hist:[{n,ret,vol}], path:[{n,ret,vol,gap}] } } }
  function build(spec) {
    const nAfter = spec.nAfter;
    const days = U.tradingDays(spec.start, PRE, nAfter);
    const idx0 = PRE;
    const close = {}, open = {};
    const all = Object.keys(spec.tickers);
    for (const tk of all) {
      const t = spec.tickers[tk];
      const r = U.rng(U.hashStr(tk + ':' + (spec.seed || 1)));
      const rets = [0];
      const gaps = [0];
      const hist = t.hist || [{ n: PRE - 252, ret: 0.05, vol: t.vol || 0.3 }, { n: 252, ret: t.r252 === undefined ? 0.1 : t.r252, vol: t.vol || 0.3 }];
      const segs = hist.concat(t.path || []);
      for (const s of segs) {
        if (s.vol === 0 || s.n === 1) {
          for (let i = 0; i < s.n; i++) { rets.push(Math.log(1 + s.ret) / s.n); gaps.push(s.gap === false ? 0.3 : 0.9); }
        } else {
          const b = bridge(r, s.n, s.ret, s.vol === undefined ? (t.vol || 0.3) : s.vol);
          for (const x of b) { rets.push(x); gaps.push(0.35); }
        }
      }
      // 不夠長就用預設漂移補
      const dflt = t.drift === undefined ? 0.08 : t.drift;
      const dv = (t.vol || 0.3) / Math.sqrt(252);
      while (rets.length < days.length) { rets.push(Math.log(1 + dflt) / 252 + U.gauss(r) * dv); gaps.push(0.35); }
      // 累積成價格；第 idx0-1 天收盤 = p0
      const c = [1];
      for (let i = 1; i < days.length; i++) c.push(c[i - 1] * Math.exp(rets[i]));
      const scale = t.p0 / c[idx0 - 1];
      const cc = c.map((x) => x * scale);
      const oo = cc.map((x, i) => {
        if (i === 0) return x;
        const lr = Math.log(cc[i] / cc[i - 1]);
        return cc[i - 1] * Math.exp(lr * gaps[i]);
      });
      close[tk] = cc; open[tk] = oo;
    }
    return { days, idx0, close, open, tickers: all, info: META_INFO, universe: UNIVERSE.filter((x) => all.includes(x)) };
  }

  G.Market = { build, PRE, META_INFO, UNIVERSE };
})(typeof window !== 'undefined' ? window : globalThis);
