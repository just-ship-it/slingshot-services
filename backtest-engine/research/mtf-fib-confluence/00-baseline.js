/**
 * 00-baseline.js  -- reproduce the 4-strategy FCFS book baseline through the reused engine,
 * confirming our pipeline is wired correctly before layering MTF-fib confluence on top.
 * Expect: full ~$614,730 / PF 1.77 / Sh 10.8 / DD $11,642 / 6,128 trades / test PF 2.04.
 */
import { loadAnnotated } from '../deck-filters/lib/annotate.js';
import { runBook, report } from '../deck-filters/lib/engine.js';

const trades = loadAnnotated();
const counts = {};
for (const t of trades) counts[t.strategyKey] = (counts[t.strategyKey] || 0) + 1;
console.log('Loaded trades by strategy:', counts, 'total', trades.length);
report('BASELINE (decide = keep all @1x)', runBook(trades));
