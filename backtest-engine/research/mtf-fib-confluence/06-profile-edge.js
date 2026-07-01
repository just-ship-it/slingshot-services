/**
 * 06-profile-edge.js -- characterize WHERE the per-trade MTF-fib confluence edge concentrates,
 * to (a) decide if a sharper/larger-sample slice could survive in-book and (b) inform a Phase-2
 * standalone sleeve. Standalone EV unless noted (per-trade signal is what we're profiling).
 *
 * Dimensions: by TF (15m/1h/4h independently) · by binding fib ratio (shallow vs OTE) ·
 * by gamma-sign (incremental beyond gamma?) · by leg size · by side. n shown everywhere; ignore
 * buckets with n<25.
 */
import { loadBookWithFib, MR_KEYS } from './lib/book-with-fib.js';

const trades = loadBookWithFib();
const mr = trades.filter(t => MR_KEYS.has(t.strategyKey));
const glf = mr.filter(t => t.strategyKey === 'gex-level-fade');
const gfi = mr.filter(t => t.strategyKey === 'gex-flip-ivpct');

function stat(ts) {
  if (!ts.length) return { n: 0 };
  const w = ts.filter(t => t.netPnL > 0);
  const gp = w.reduce((s, t) => s + t.netPnL, 0), gl = ts.filter(t => t.netPnL <= 0).reduce((s, t) => s + t.netPnL, 0);
  return { n: ts.length, wr: +(w.length / ts.length * 100).toFixed(0), avg: Math.round(ts.reduce((s, t) => s + t.netPnL, 0) / ts.length), pf: gl === 0 ? 99 : +(gp / -gl).toFixed(2) };
}
const f = s => s.n ? `n=${String(s.n).padStart(4)} WR=${String(s.wr).padStart(2)}% avg=$${String(s.avg).padStart(5)} PF=${s.pf}` : 'n=0';
const TFK = { '15m': '15', '1h': '60', '4h': '240' };
const isC = (t, k, prox) => t.fib['d' + k] != null && t.fib['d' + k] <= prox;
const anyC = (t, prox) => ['15', '60', '240'].some(k => isC(t, k, prox));
// binding TF = nearest matched fib; its ratio
const binding = t => { let bk = null, bd = Infinity; for (const k of ['15', '60', '240']) { const d = t.fib['d' + k]; if (d != null && d < bd) { bd = d; bk = k; } } return bk ? { k: bk, d: bd, r: t.fib['r' + bk], legR: t.fib['legR' + bk] } : null; };

console.log('============ 1. BY TIMEFRAME (independent confluence, prox<=5) ============');
for (const [lbl, pool] of [['glf', glf], ['gfi', gfi]]) {
  console.log(`\n-- ${lbl} (ALL ${f(stat(pool))}) --`);
  for (const [tf, k] of Object.entries(TFK)) {
    console.log(`  ${tf.padEnd(4)} CONF ${f(stat(pool.filter(t => isC(t, k, 5))))}   | NON ${f(stat(pool.filter(t => !isC(t, k, 5))))}`);
  }
}

console.log('\n============ 2. BY BINDING FIB RATIO (trades with dmin<=5) ============');
for (const [lbl, pool] of [['glf', glf], ['gfi', gfi]]) {
  console.log(`\n-- ${lbl} --`);
  const conf = pool.filter(t => anyC(t, 5));
  for (const [rlbl, pred] of [['shallow .382', r => r <= 0.4], ['half .50', r => r > 0.4 && r <= 0.55], ['golden .618', r => r > 0.55 && r <= 0.66], ['OTE .705/.786', r => r > 0.66]]) {
    console.log(`  ${rlbl.padEnd(14)} ${f(stat(conf.filter(t => { const b = binding(t); return b && pred(b.r); })))}`);
  }
}

console.log('\n============ 3. GAMMA-SIGN INTERACTION (does confluence add BEYOND gamma?) ============');
for (const [lbl, pool] of [['glf', glf], ['gfi', gfi]]) {
  console.log(`\n-- ${lbl} --`);
  for (const [glbl, gs] of [['POS gamma', 1], ['NEG gamma', -1]]) {
    const g = pool.filter(t => t.gammaSign === gs);
    console.log(`  ${glbl}: ALL ${f(stat(g))}  || CONF<=5 ${f(stat(g.filter(t => anyC(t, 5))))}  || NON ${f(stat(g.filter(t => !anyC(t, 5))))}`);
  }
}

console.log('\n============ 4. BY LEG SIZE of binding TF (conf<=5) ============');
for (const [lbl, pool] of [['glf', glf], ['gfi', gfi]]) {
  console.log(`\n-- ${lbl} --`);
  const conf = pool.filter(t => anyC(t, 5));
  for (const [llbl, pred] of [['small <40', r => r < 40], ['mid 40-80', r => r >= 40 && r < 80], ['big 80-150', r => r >= 80 && r < 150], ['huge >=150', r => r >= 150]]) {
    console.log(`  legR ${llbl.padEnd(10)} ${f(stat(conf.filter(t => { const b = binding(t); return b && pred(b.legR); })))}`);
  }
}

console.log('\n============ 5. BY SIDE (conf<=5 vs non) ============');
for (const [lbl, pool] of [['glf', glf], ['gfi', gfi]]) {
  console.log(`\n-- ${lbl} --`);
  for (const sd of ['long', 'short']) {
    const s = pool.filter(t => t.side === sd);
    console.log(`  ${sd.padEnd(5)} CONF ${f(stat(s.filter(t => anyC(t, 5))))} | NON ${f(stat(s.filter(t => !anyC(t, 5))))}`);
  }
}
