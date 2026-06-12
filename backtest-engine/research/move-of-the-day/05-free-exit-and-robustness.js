// Phase 2c — (A) "free-exit / ride-the-move" upside test, (B) robustness of the core rule.
//
// (A) The user asked to compare the selector-over-signals vs a freer engine that uses
//     signals as features. The cleanest causal proxy for "ride the day's move" is to keep
//     the SAME causal entry but ask: how much of each pick's own MFE did the strategy exit
//     capture, and what would a simple wider/trailing exit have banked? MFE/MAE are realized
//     excursions already in the dataset (no new simulation, no lookahead in the entry).
//
// (B) Robustness: the core discovered rule is "take the first glx-or-gfi signal of the day."
//     Test it directly (no fitted tau), plus simple ablations, across H1/H2.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { metrics, fmt } from './lib/metrics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, 'output');
const sessions = JSON.parse(fs.readFileSync(path.join(OUT, 'sessions.json'), 'utf8'));
const days = Object.keys(sessions).sort();
const mid = days[Math.floor(days.length / 2)];

const pnl = s => s.outcome.pointsPnL;
const byEntry = (a, b) => a.entryTs - b.entryTs;

// ---------- (B) Robust rule: first signal of day matching a strategy set ----------
function firstMatch(daySet, stratSet, hourMax = 24) {
  const series = [], picks = [];
  for (const d of daySet) {
    const pick = [...sessions[d]].sort(byEntry).find(s => stratSet.includes(s.strategy) && s.entryHourET < hourMax);
    if (pick) { series.push(pnl(pick)); picks.push(pick); }
  }
  return { series, picks };
}

const H1 = days.filter(d => d < mid), H2 = days.filter(d => d >= mid);
const rules = [
  ['first glx+gfi',           ['glx', 'gfi']],
  ['first glx only',          ['glx']],
  ['first glx+gfi+glf',       ['glx', 'gfi', 'glf']],
  ['first glx+gfi (<=11 ET)', ['glx', 'gfi'], 11],
  ['first any (baseline)',    ['glx', 'gfi', 'glf', 'lstb']],
];

console.log('========== (B) ROBUST RULE ABLATIONS — first matching signal/day ==========');
for (const [label, set, hm] of rules) {
  const all = firstMatch(days, set, hm ?? 24);
  const h1 = firstMatch(H1, set, hm ?? 24);
  const h2 = firstMatch(H2, set, hm ?? 24);
  console.log(`\n${label}`);
  console.log(`  ALL: ${fmt(metrics(all.series))}  [${all.series.length}/${days.length} days]`);
  console.log(`  H1 : ${fmt(metrics(h1.series))}`);
  console.log(`  H2 : ${fmt(metrics(h2.series))}`);
}

// ---------- (A) Free-exit upside on the core rule's picks ----------
console.log('\n\n========== (A) FREE-EXIT / RIDE-THE-MOVE upside (core rule picks: first glx+gfi) ==========');
const picks = firstMatch(days, ['glx', 'gfi']).picks;
const realized = picks.map(pnl);
// MFE-capture: had we exited at the favorable extreme (perfect, upper bound on any exit)
const mfe = picks.map(p => p.outcome.mfePoints).filter(x => x != null);
// A deployable wider exit: capture min(MFE, cap) but give back via a trailing assumption.
// Approximate "trail from MFE by give-back G": exit = realized if loss; else max(realized, MFE - G).
function trailVariant(G) {
  return picks.map(p => {
    const r = pnl(p), m = p.outcome.mfePoints ?? r;
    if (r <= 0) return r;                 // losers unchanged (stop/BE already hit)
    return Math.max(r, Math.min(m, m - G)); // can't beat MFE; give back G from the peak
  });
}
const sum = a => a.reduce((x, y) => x + y, 0);
console.log(`  realized (own exit):      ${fmt(metrics(realized))}`);
console.log(`  perfect MFE-capture:      total ${sum(mfe).toFixed(0)}pt  ($${(sum(mfe) * 20).toLocaleString()})  mean ${(sum(mfe) / mfe.length).toFixed(1)}pt  [upper bound]`);
for (const G of [10, 20, 30, 40]) {
  console.log(`  trail give-back ${String(G).padStart(2)}pt:      ${fmt(metrics(trailVariant(G)))}`);
}
const avgRealized = sum(realized) / realized.length;
const avgMfe = sum(mfe) / mfe.length;
console.log(`\n  Avg MFE ${avgMfe.toFixed(1)}pt vs avg realized ${avgRealized.toFixed(1)}pt  → own exit captures ${(avgRealized / avgMfe * 100).toFixed(0)}% of peak favorable move.`);
