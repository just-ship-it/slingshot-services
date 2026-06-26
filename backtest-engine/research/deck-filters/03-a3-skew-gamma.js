/**
 * THREAD A3 — Skew + gamma directional gate.
 *
 * Deck: `positioning` ("don't fade into a crowded one-sided book"; gamma sign + put/call skew as the
 * positioning read). Prior hypotheses to CONFIRM (from portfolio-filter research, not dredged here):
 *   (H1) gex-level-fade (the fade strat) hates NEGATIVE gamma.
 *   (H2) shorts are weak in POSITIVE gamma.
 *   (H3) extreme put/call skew (ivSkewPct) marks crowded positioning -> conditions a fade/flip.
 * Features: gammaSign (+1/-1 from NQ total_gex, ~78% cov, RTH), ivSkew=put_iv-call_iv & ivSkewPct
 *   (trailing-252 pctile, ~45-49% cov). Gate convention: null feature -> pass (keep), like vol sweep.
 *
 * Usage: node research/deck-filters/03-a3-skew-gamma.js
 */
import { loadAnnotated } from './lib/annotate.js';
import { runBook, report, verdict, fmtM } from './lib/engine.js';

const ALL = loadAnnotated();
const STRATS = ['lstb', 'gex-level-fade', 'gex-flip-ivpct', 'gex-lt-3m'];
const pf = ts => { const w = ts.filter(t => t.netPnL > 0).reduce((s, t) => s + t.netPnL, 0), l = Math.abs(ts.filter(t => t.netPnL <= 0).reduce((s, t) => s + t.netPnL, 0)); return l ? w / l : Infinity; };
const stat = ts => `n=${String(ts.length).padStart(4)}  WR=${(100 * ts.filter(t => t.netPnL > 0).length / ts.length).toFixed(0)}%  PF=${pf(ts).toFixed(2)}  $${Math.round(ts.reduce((s, t) => s + t.netPnL, 0)).toLocaleString()}`;

// ---- diagnostic 1: strategy × gammaSign ----
console.log('═══ DIAG 1: strategy × gamma sign (H1: fade hates neg gamma) ═══');
for (const k of STRATS) {
  const ts = ALL.filter(t => t.strategyKey === k);
  const cov = 100 * ts.filter(t => t.gammaSign != null).length / ts.length;
  console.log(`  ${k.padEnd(15)} (gamma cov ${cov.toFixed(0)}%)`);
  console.log(`     posGamma: ${stat(ts.filter(t => t.gammaSign > 0))}`);
  console.log(`     negGamma: ${stat(ts.filter(t => t.gammaSign < 0))}`);
}

// ---- diagnostic 2: side × gammaSign (H2: shorts weak in pos gamma) ----
console.log('\n═══ DIAG 2: side × gamma sign (H2: shorts weak in pos gamma), book-wide ═══');
for (const side of ['long', 'short']) {
  console.log(`  ${side}:`);
  console.log(`     posGamma: ${stat(ALL.filter(t => t.side === side && t.gammaSign > 0))}`);
  console.log(`     negGamma: ${stat(ALL.filter(t => t.side === side && t.gammaSign < 0))}`);
}

// ---- diagnostic 3: glf & gfi × ivSkewPct tertiles (H3) ----
console.log('\n═══ DIAG 3: skew tertiles (H3: extreme skew = crowded positioning) ═══');
for (const k of ['gex-level-fade', 'gex-flip-ivpct', 'lstb']) {
  const ts = ALL.filter(t => t.strategyKey === k && t.ivSkewPct != null).sort((a, b) => a.ivSkewPct - b.ivSkewPct);
  if (!ts.length) { console.log(`  ${k}: no skew coverage`); continue; }
  const n = ts.length; console.log(`  ${k} (skew cov ${(100 * n / ALL.filter(t => t.strategyKey === k).length).toFixed(0)}%):`);
  console.log(`     low skew  : ${stat(ts.slice(0, Math.floor(n / 3)))}`);
  console.log(`     mid skew  : ${stat(ts.slice(Math.floor(n / 3), Math.floor(2 * n / 3)))}`);
  console.log(`     high skew : ${stat(ts.slice(Math.floor(2 * n / 3)))}`);
}

// ---- gates on the book ----
const base = runBook(ALL, () => 1);
report('\n═══ BASELINE ═══', base);

const GATES = [
  ['H1: glf skip negGamma', (k, t) => (k === 'gex-level-fade' && t.gammaSign < 0) ? 0 : 1],
  ['H2: skip shorts in posGamma (all)', (k, t) => (t.side === 'short' && t.gammaSign > 0) ? 0 : 1],
  ['H2b: skip glf shorts in posGamma', (k, t) => (k === 'gex-level-fade' && t.side === 'short' && t.gammaSign > 0) ? 0 : 1],
  ['H1+H2 combined', (k, t) => { if (k === 'gex-level-fade' && t.gammaSign < 0) return 0; if (t.side === 'short' && t.gammaSign > 0) return 0; return 1; }],
];

const results = [];
for (const [label, decide] of GATES) {
  const r = runBook(ALL, decide); const v = verdict(base, r);
  results.push({ label, r, v });
  console.log(`\n── ${label} ──`);
  console.log(`  full:  ${fmtM(r.full)}`);
  console.log(`  test:  ${fmtM(r.test)}   quarters PF: ${r.quarters.map(([n, m]) => m.profitFactor.toFixed(2)).join(' ')}`);
  console.log(`  verdict: ${v.yes ? 'YES ✓' : 'no'}  [pfUp=${v.pfUp} shUp=${v.shUp} ddOk=${v.ddOk} oosPF=${v.oosPF}]`);
}

console.log('\n═══ A3 SUMMARY ═══');
console.log('config'.padEnd(34), 'PnL'.padStart(10), 'PF'.padStart(6), 'Sh'.padStart(6), 'DD'.padStart(9), 'testPF'.padStart(7), ' verdict');
console.log('baseline'.padEnd(34), `$${Math.round(base.full.totalPnL).toLocaleString()}`.padStart(10), base.full.profitFactor.toFixed(2).padStart(6), base.full.sharpe.toFixed(1).padStart(6), `$${Math.round(base.full.ddDollar).toLocaleString()}`.padStart(9), base.test.profitFactor.toFixed(2).padStart(7));
for (const { label, r, v } of results) console.log(label.padEnd(34), `$${Math.round(r.full.totalPnL).toLocaleString()}`.padStart(10), r.full.profitFactor.toFixed(2).padStart(6), r.full.sharpe.toFixed(1).padStart(6), `$${Math.round(r.full.ddDollar).toLocaleString()}`.padStart(9), r.test.profitFactor.toFixed(2).padStart(7), v.yes ? '  YES ✓' : '');
