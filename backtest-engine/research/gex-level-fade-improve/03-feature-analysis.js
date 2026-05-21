/**
 * Phase 3 — Per-trade feature analysis under gold policy.
 *
 * Aggregate gold-policy PnL by hour, DOW, level type, level group, side, and
 * pairwise (hour×side, level×side) to find filter levers.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { simulateAll, stats, statsByHour, statsByDow, statsByLevel, statsByGroup, statsBySide, GOLD_POLICY, bucketize } from './02-sim-exits.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const WALK_PATH = process.argv[2] || path.join(__dirname, 'output', '01-trades-walk.json');
console.log(`Loading ${WALK_PATH}...`);
const walks = JSON.parse(fs.readFileSync(WALK_PATH, 'utf-8'));
console.log(`Trades: ${walks.length}\n`);

const results = simulateAll(walks, GOLD_POLICY);
const overall = stats(results);
console.log('=== OVERALL GOLD-POLICY (sim) ===');
console.log(`n=${overall.n}  PnL=$${overall.pnl.toFixed(0)}  WR=${overall.wr.toFixed(1)}%  PF=${overall.pf.toFixed(2)}  Sh=${overall.sharpe.toFixed(2)}  DD=$${overall.maxDD.toFixed(0)}  avgWin=$${overall.avgWin.toFixed(0)}  avgLoss=$${overall.avgLoss.toFixed(0)}\n`);

function printBucket(title, byKey, sortKey = (k => k)) {
  console.log(`--- ${title} ---`);
  const keys = Object.keys(byKey).sort((a, b) => {
    const va = sortKey(a), vb = sortKey(b);
    if (typeof va === 'number' && typeof vb === 'number') return va - vb;
    return String(va).localeCompare(String(vb));
  });
  for (const k of keys) {
    const b = byKey[k];
    const avgPnL = b.n ? b.pnl / b.n : 0;
    console.log(`  ${String(k).padEnd(14)} n=${String(b.n).padStart(4)}  PnL=$${b.pnl.toFixed(0).padStart(7)}  avg=$${avgPnL.toFixed(0).padStart(5)}  WR=${b.wr.toFixed(0).padStart(3)}%  PF=${b.pf.toFixed(2)}  Sh=${b.sharpe.toFixed(2)}  DD=$${b.maxDD.toFixed(0).padStart(5)}`);
  }
  console.log('');
}

printBucket('By HOUR (ET)',  statsByHour(results),  k => +k);
printBucket('By DOW',        statsByDow(results),   k => ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(k));
printBucket('By LEVEL TYPE', statsByLevel(results));
printBucket('By LEVEL GROUP (PR/SHL/GEX/LT)', statsByGroup(results));
printBucket('By SIDE',       statsBySide(results));

// Pairwise: hour × side
console.log('--- HOUR × SIDE ---');
const hourSide = bucketize(results, r => `h${r.hourEt}_${r.direction}`);
const hsKeys = Object.keys(hourSide).sort();
for (const k of hsKeys) {
  const b = hourSide[k];
  const avg = b.n ? b.pnl / b.n : 0;
  console.log(`  ${k.padEnd(12)} n=${String(b.n).padStart(4)}  PnL=$${b.pnl.toFixed(0).padStart(7)}  avg=$${avg.toFixed(0).padStart(5)}  WR=${b.wr.toFixed(0)}%  PF=${b.pf.toFixed(2)}`);
}
console.log('');

// Level group × side
console.log('--- LEVEL GROUP × SIDE ---');
const grpSide = bucketize(results, r => `${r.levelGroup}_${r.direction}`);
for (const k of Object.keys(grpSide).sort()) {
  const b = grpSide[k];
  const avg = b.n ? b.pnl / b.n : 0;
  console.log(`  ${k.padEnd(12)} n=${String(b.n).padStart(4)}  PnL=$${b.pnl.toFixed(0).padStart(7)}  avg=$${avg.toFixed(0).padStart(5)}  WR=${b.wr.toFixed(0)}%  PF=${b.pf.toFixed(2)}`);
}
console.log('');

// MFE distribution of stops (looking for "MFE 50-80% of TP → SL" pattern)
console.log('--- MFE @ STOP_LOSS ---');
const stops = results.filter(r => !r.dropped && r.exit === 'stop');
const mfeBuckets = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
for (let i = 0; i < mfeBuckets.length - 1; i++) {
  const lo = mfeBuckets[i], hi = mfeBuckets[i + 1];
  const inBucket = stops.filter(r => r.mfe >= lo && r.mfe < hi);
  const tot = inBucket.length;
  console.log(`  MFE ${String(lo).padStart(3)}-${String(hi).padStart(3)}pt  stops=${String(tot).padStart(4)}  saved-pot-if-BE@${(lo+hi)/2}=$${(tot * ((lo+hi)/2 * 20)).toFixed(0)}`);
}
const big = stops.filter(r => r.mfe >= 100);
console.log(`  MFE  ≥100pt  stops=${String(big.length).padStart(4)}`);
console.log('');

// MFE distribution overall
console.log('--- MFE distribution (all taken trades) ---');
const taken = results.filter(r => !r.dropped);
const mfeSamples = taken.map(r => r.mfe).sort((a, b) => a - b);
const pct = p => mfeSamples[Math.floor(mfeSamples.length * p)] || 0;
console.log(`  p10=${pct(0.10).toFixed(1)}  p25=${pct(0.25).toFixed(1)}  p50=${pct(0.50).toFixed(1)}  p75=${pct(0.75).toFixed(1)}  p90=${pct(0.90).toFixed(1)}  p99=${pct(0.99).toFixed(1)}  max=${mfeSamples[mfeSamples.length - 1].toFixed(1)}`);

// Save JSON dump for later programmatic use
const summary = {
  overall,
  byHour: statsByHour(results),
  byDow: statsByDow(results),
  byLevel: statsByLevel(results),
  byGroup: statsByGroup(results),
  bySide: statsBySide(results),
  byHourSide: hourSide,
  byGroupSide: grpSide,
};
const outPath = path.join(__dirname, 'output', '03-feature-summary.json');
fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
console.log(`\nWrote ${outPath}`);
