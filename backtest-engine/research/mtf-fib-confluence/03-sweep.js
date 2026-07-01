/**
 * 03-sweep.js -- honest FCFS-book test of MTF-fib confluence on the mean-reversion strategies.
 *
 * Unlike 02's standalone EV, this re-simulates the whole 4-strategy FCFS book (runBook), so
 * skipping a non-confluent glf/gfi trade causally frees the shared 1-NQ slot for the next
 * strategy. Acceptance = deck-filters PF-over-PnL rule (PF up, Sharpe not materially worse,
 * DD <= +2%, test-half PF beats baseline).
 *
 * Candidates:
 *   FILTER  : drop non-confluent MR trades (keep if confluenceCount>=1) -- on glf, gfi, or both.
 *   SIZE    : keep all, lever confluent MR trades 1.5x / 2x.
 *   COMBO   : drop non-confluent + lever confluent.
 *   CONTROLS: inverse filter (drop CONFLUENT) + random-drop matched count (sign + not-just-fewer).
 */
import { runBook, fmtM, verdict } from '../deck-filters/lib/engine.js';
import { loadBookWithFib, MR_KEYS } from './lib/book-with-fib.js';
import { confluenceCount } from './lib/fib-confluence.js';

const trades = loadBookWithFib();
const base = runBook(trades);
console.log('BASELINE:', fmtM(base.full), '| test', fmtM(base.test));

// seeded PRNG for reproducible random-drop control
let _s = 12345; const rnd = () => { _s = (_s * 1103515245 + 12345) & 0x7fffffff; return _s / 0x7fffffff; };

const isConf = (t, prox, ote) => confluenceCount(t.fib, prox, ote) >= 1;
const inScope = (key, scope) => scope === 'both' ? MR_KEYS.has(key) : key === scope;

function show(label, cand) {
  const v = verdict(base, cand);
  const tag = v.yes ? 'PASS' : `--   [${v.pfUp ? 'pf' : ''}${v.shUp ? 'sh' : ''}${v.ddOk ? 'dd' : ''}${v.oosPF ? 'oos' : ''}]`;
  console.log(`${tag}  ${label}`);
  console.log(`        full ${fmtM(cand.full)}`);
  console.log(`        test ${fmtM(cand.test)}  | qPF ${cand.quarters.map(([n, m]) => m.profitFactor.toFixed(2)).join('/')}`);
}

for (const scope of ['both', 'gex-level-fade', 'gex-flip-ivpct']) {
  console.log(`\n================  SCOPE: ${scope}  ================`);
  // FILTER: drop non-confluent
  for (const prox of [3, 5, 8, 12]) for (const ote of [false, true]) {
    show(`FILTER drop non-conf  prox<=${prox}${ote ? ' OTE' : ''}`, runBook(trades, (k, t) => (inScope(k, scope) && !isConf(t, prox, ote)) ? 0 : 1));
  }
  // SIZE: lever confluent
  for (const prox of [3, 5, 8]) for (const mult of [1.5, 2]) {
    show(`SIZE conf x${mult}        prox<=${prox}`, runBook(trades, (k, t) => (inScope(k, scope) && isConf(t, prox, false)) ? mult : 1));
  }
  // COMBO: drop non-conf + lever conf 1.5x
  for (const prox of [3, 5, 8]) {
    show(`COMBO drop non + conf x1.5 prox<=${prox}`, runBook(trades, (k, t) => { if (!inScope(k, scope)) return 1; return isConf(t, prox, false) ? 1.5 : 0; }));
  }
}

// ---- CONTROLS (scope=both, prox<=5) ----
console.log(`\n================  CONTROLS (both, prox<=5)  ================`);
show('CONTROL inverse: drop CONFLUENT (expect WORSE)', runBook(trades, (k, t) => (MR_KEYS.has(k) && isConf(t, 5, false)) ? 0 : 1));
// random-drop the same fraction of MR trades that prox<=5 filter drops
const mr = trades.filter(t => MR_KEYS.has(t.strategyKey));
const dropFrac = mr.filter(t => !isConf(t, 5, false)).length / mr.length;
const dropSet = new Set(); for (const t of mr) if (rnd() < dropFrac) dropSet.add(t.id);
show(`CONTROL random-drop ${(dropFrac * 100).toFixed(0)}% of MR (expect ~baseline/worse)`, runBook(trades, (k, t) => dropSet.has(t.id) ? 0 : 1));
