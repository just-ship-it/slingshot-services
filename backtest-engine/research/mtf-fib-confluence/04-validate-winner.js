/**
 * 04-validate-winner.js -- lock the Phase-1 deliverable with train/test/quarter detail and the
 * APT control (glf-only random-drop of the SAME fraction). Confirms the lift is confluence
 * selection skill, not reduced trade count.
 *
 * 1s-honesty note: this research applies a pure post-hoc SELECTION to the v2 gold-standard trade
 * logs (already 1s-honest engine output) + re-runs the FCFS book (runBook reproduces baseline to
 * the dollar). No fills/exits are simulated here, so the CLAUDE.md 1s fill-bar bug has no surface.
 * Fib levels are causal (confirmed-pivot lag; activeFrom <= entryTime enforced in fib-confluence.js).
 */
import { runBook, fmtM } from '../deck-filters/lib/engine.js';
import { loadBookWithFib, MR_KEYS } from './lib/book-with-fib.js';
import { confluenceCount } from './lib/fib-confluence.js';

const trades = loadBookWithFib();
const base = runBook(trades);
const isConf5ote = t => confluenceCount(t.fib, 5, true) >= 1;

const line = (lbl, r) => console.log(`${lbl.padEnd(34)} full ${fmtM(r.full)}\n${' '.repeat(34)} train ${fmtM(r.train)}\n${' '.repeat(34)} test ${fmtM(r.test)}  qPF ${r.quarters.map(([n, m]) => m.profitFactor.toFixed(2)).join('/')}`);

line('BASELINE', base);
console.log();
line('WINNER glf FILTER prox<=5 OTE', runBook(trades, (k, t) => (k === 'gex-level-fade' && !isConf5ote(t)) ? 0 : 1));
console.log();

// apt control: random-drop the SAME number of glf trades the filter drops
const glf = trades.filter(t => t.strategyKey === 'gex-level-fade');
const nDrop = glf.filter(t => !isConf5ote(t)).length;
console.log(`(glf filter drops ${nDrop}/${glf.length} glf trades; control drops same count at random, 5 seeds)`);
let s = 999;
const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
for (let seed = 0; seed < 5; seed++) {
  const shuffled = glf.map(t => ({ id: t.id, k: rnd() })).sort((a, b) => a.k - b.k).slice(0, nDrop);
  const drop = new Set(shuffled.map(x => x.id));
  const r = runBook(trades, (k, t) => drop.has(t.id) ? 0 : 1);
  console.log(`  ctrl-rand seed${seed}: full ${fmtM(r.full)} | test PF ${r.test.profitFactor.toFixed(2)}`);
}
console.log();
line('INVERSE drop CONFLUENT glf', runBook(trades, (k, t) => (k === 'gex-level-fade' && isConf5ote(t)) ? 0 : 1));
