/**
 * Control: confirm the annotation layer + generalized engine reproduce the FCFS baseline
 * ($614,730 / PF 1.77 / Sharpe 10.8 / DD $11,642) and report per-feature coverage so we know
 * which filters are even evaluable. Run this BEFORE trusting any thread result.
 *
 * Usage: node research/deck-filters/00-verify-baseline.js
 */
import { loadAnnotated } from './lib/annotate.js';
import { runBook, report } from './lib/engine.js';

const ALL = loadAnnotated();
console.log(`Loaded ${ALL.length} annotated trades`);

// per-strategy counts
const byS = {};
for (const t of ALL) (byS[t.strategyKey] ??= 0, byS[t.strategyKey]++);
console.log('per-strategy:', byS);

// feature coverage (% non-null)
const feats = ['stopPts', 'ivPct', 'ivChg', 'slope', 'ivSkew', 'ivSkewPct', 'gammaSign', 'atrNq', 'stopAtr', 'stopExpMove', 'ltAlign', 'distCallWall', 'distPutWall'];
console.log('\nfeature coverage (non-null %):');
for (const f of feats) { const n = ALL.filter(t => t[f] != null).length; console.log(`  ${f.padEnd(13)} ${(100 * n / ALL.length).toFixed(0)}%  (${n})`); }

// ltAlign coverage among lstb only
const lstb = ALL.filter(t => t.strategyKey === 'lstb');
console.log(`  ltAlign on lstb: ${(100 * lstb.filter(t => t.ltAlign != null).length / lstb.length).toFixed(0)}% of ${lstb.length}`);

// BASELINE
const base = runBook(ALL, () => 1);
report('═══ BASELINE (decide=1x, should match $614,730 / PF 1.77 / Sh 10.8 / DD $11,642) ═══', base);
