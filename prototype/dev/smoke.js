// 開發用：在 node 裡把每個情境從頭跑到尾（自動「照清單做」），檢查不會出錯並印出重點紀錄。
// 用法：node prototype/dev/smoke.js [情境id] [--verbose] [--none]
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ctx = { console, Math, JSON, Date, Object, Array, String, Number, isNaN };
vm.createContext(ctx);
ctx.globalThis = ctx;
for (const f of ['util.js', 'market.js', 'ai.js', 'engine.js', 'scenarios.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', f), 'utf8'), ctx, { filename: f });
}
const args = process.argv.slice(2);
const only = args.find((a) => !a.startsWith('--'));
const verbose = args.includes('--verbose');
const none = args.includes('--none');
for (const sc of ctx.SCENARIOS) {
  if (only && sc.id !== only) continue;
  const sim = ctx.Engine.create(sc);
  const r = sim.ranks(sim.d - 1);
  console.log('\n=== ' + sc.title + ' ===');
  console.log('start ranks:', r.list.slice(0, 16).map((x, k) => (k + 1) + '.' + x.tk + '(' + (x.r * 100).toFixed(0) + ')').join(' '));
  console.log('T0=', sim.total().toFixed(0), 'sigma0=', sim.momSigma(sim.d - 1).toFixed(3), 'sigmaMed=', sim.settings.sigmaMedian.toFixed(3));
  let n = 0;
  while (sim.step()) {
    if (!none) for (const nt of sim.notifs) if (nt.status === 'PENDING') sim.respond(nt.id, 'ALL');
    if (++n > 400) break;
  }
  for (const e of sim.log) {
    if (!verbose && (e.f === 'F18' || /維持/.test(e.title) || e.f === 'SNAP')) continue;
    console.log(e.date, e.phase, e.f, e.lvl || '', e.cls || '', '|', e.title, verbose ? '| ' + e.body.replace(/\n/g, ' / ') : '');
  }
  console.log('notifs:', sim.notifs.length, 'aiRuns:', sim.aiRuns.length, 'shadow:', sim.shadow.length, 'T=', sim.total().toFixed(0), 'cash=', sim.snap.cash.toFixed(0));
  console.log('lots.mom', JSON.stringify(sim.lots.mom), 'own', JSON.stringify(sim.lots.own), 'core', JSON.stringify(sim.lots.core));
}
