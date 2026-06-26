/**
 * Combined deck-filter config: stack the two winning, orthogonal book tweaks.
 *   A1: lever lstb to 2x in favorable vol regime (ivPct>=0.5 & ivChg>0); optional downsize lumpy unfav.
 *   A3: gate the fade strategy (glf) by gamma sign (positive-gamma-only, and/or skip shorts in pos-gamma).
 * A1 acts on lstb sizing, A3 acts on glf selection → independent. Test the stack vs each alone vs baseline.
 *
 * Usage: node research/deck-filters/04-combined.js
 */
import { loadAnnotated } from './lib/annotate.js';
import { runBook, verdict } from './lib/engine.js';

const ALL = loadAnnotated();

const lstbFav = t => t.ivPct != null && t.ivPct >= 0.5 && t.ivChg > 0;
const lstbUnfav = t => t.ivPct != null && !(t.ivPct >= 0.5 && t.ivChg > 0);

// A1 best (lstb-fav 2x + downsize lumpy-unfav 0.5x)
const A1 = (k, t) => {
  if (k === 'lstb') return lstbFav(t) ? 2 : 1;
  // lumpy unfavorable downsize (use each strat's own unfav regime)
  if (k === 'gex-level-fade') return t.ivChg != null && t.ivChg >= 0 ? 0.5 : 1;
  if (k === 'gex-flip-ivpct') return t.ivPct != null && t.ivPct < 0.5 ? 0.5 : 1;
  return 1;
};
// A3 best forms
const A3_h1 = (k, t) => (k === 'gex-level-fade' && t.gammaSign < 0) ? 0 : 1;
const A3_h2b = (k, t) => (k === 'gex-level-fade' && t.side === 'short' && t.gammaSign > 0) ? 0 : 1;

const compose = (...fns) => (k, t) => { let m = 1; for (const f of fns) { const x = f(k, t); if (x === 0) return 0; m *= x; } return m; };

const base = runBook(ALL, () => 1);
const configs = [
  ['A1 alone (lstb 2x + downsize lumpy)', A1],
  ['A3-H1 alone (glf posGamma)', A3_h1],
  ['A3-H2b alone (glf skip shorts posG)', A3_h2b],
  ['A1 + A3-H1', compose(A1, A3_h1)],
  ['A1 + A3-H2b', compose(A1, A3_h2b)],
  ['A1 + A3-H1 + A3-H2b', compose(A1, A3_h1, A3_h2b)],
];

console.log('config'.padEnd(40), 'PnL'.padStart(11), 'PF'.padStart(6), 'Sh'.padStart(6), 'DD'.padStart(9), 'testPF'.padStart(7), ' verdict');
const row = (lbl, r, v) => console.log(lbl.padEnd(40), `$${Math.round(r.full.totalPnL).toLocaleString()}`.padStart(11), r.full.profitFactor.toFixed(2).padStart(6), r.full.sharpe.toFixed(1).padStart(6), `$${Math.round(r.full.ddDollar).toLocaleString()}`.padStart(9), r.test.profitFactor.toFixed(2).padStart(7), v ? (v.yes ? '  YES ✓' : '  no') : '');
row('baseline', base, null);
for (const [lbl, fn] of configs) { const r = runBook(ALL, fn); row(lbl, r, verdict(base, r)); }

// detail on the best stack
console.log('\n── A1 + A3-H1 + A3-H2b quarter detail ──');
const r = runBook(ALL, compose(A1, A3_h1, A3_h2b));
console.log('  quarters PF:', r.quarters.map(([n, m]) => `${n} ${m.profitFactor.toFixed(2)}`).join('  '));
console.log(`  full PnL $${Math.round(r.full.totalPnL).toLocaleString()} | train PF ${r.train.profitFactor.toFixed(2)} | test PF ${r.test.profitFactor.toFixed(2)}`);
