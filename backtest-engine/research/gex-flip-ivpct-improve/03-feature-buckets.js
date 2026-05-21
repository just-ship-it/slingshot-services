/**
 * Phase 3 — Per-trade feature bucket analysis on the tight-stop gold policy.
 *
 * Goals:
 *   1. Identify negative-expectancy filter buckets (hour, DOW, rule, regime).
 *   2. Characterize MFE/MAE distributions of winners vs losers.
 *   3. Show "rescue opportunity" buckets (trades that touched MFE>=X but
 *      reverted to stop): the candidates for fib-retrace / BE / DR exits.
 */
import fs from 'fs';
import { simulate, simulateAll, stats, statsByKey } from './02-sim-exits.js';

const WALK = process.argv[2] || './output/01-trades-walk.json';
const walks = JSON.parse(fs.readFileSync(WALK, 'utf-8'));
console.log(`Loaded ${walks.length} trades from ${WALK}`);

const GOLD_POLICY = {
  target: 200, stop: 60, beTrig: 70, beOff: 5, maxHoldMin: 600,
};
const results = simulateAll(walks, GOLD_POLICY);
const all = stats(results);
console.log(`\nGold: PnL=$${all.pnl.toFixed(0)} WR=${all.wr.toFixed(1)}% PF=${all.pf.toFixed(2)} Sharpe=${all.sharpe.toFixed(2)} DD=$${all.maxDD.toFixed(0)}`);

// MFE/MAE distribution for winners vs losers
const wins = results.filter(r => !r.dropped && r.pointsPnL * 20 - 5 > 0);
const losers = results.filter(r => !r.dropped && r.pointsPnL * 20 - 5 < 0);
console.log(`\nWinners n=${wins.length}, Losers n=${losers.length}`);

function percentiles(arr, pct) {
  const sorted = arr.slice().sort((a,b)=>a-b);
  return pct.map(p => sorted[Math.floor(p * sorted.length)] || 0);
}
const winMfes = wins.map(r => r.mfe);
const lossMfes = losers.map(r => r.mfe);
console.log('Winner MFE  p50/p75/p90/p99:', percentiles(winMfes, [0.5, 0.75, 0.9, 0.99]).map(v=>v.toFixed(1)));
console.log('Loser  MFE  p50/p75/p90/p99:', percentiles(lossMfes, [0.5, 0.75, 0.9, 0.99]).map(v=>v.toFixed(1)));

// Rescue opportunity: trades that hit MFE>=X but ended in stop/EOD loss.
// These are candidates for fib-retrace / MFT / DR exits.
function rescueAtMfe(mfeThreshold) {
  const grossLosers = losers.filter(r => r.mfe >= mfeThreshold);
  const pnlIfClosedAtFrac = (frac) => grossLosers.reduce((s, r) => s + (frac * r.mfe * 20 - 5), 0);
  const totalLoss = grossLosers.reduce((s, r) => s + (r.pointsPnL * 20 - 5), 0);
  return {
    n: grossLosers.length,
    totalLoss,
    p20rescue: pnlIfClosedAtFrac(0.20),
    p30rescue: pnlIfClosedAtFrac(0.30),
    p50rescue: pnlIfClosedAtFrac(0.50),
    p70rescue: pnlIfClosedAtFrac(0.70),
  };
}
console.log('\nRescue opportunity (closing at frac × MFE on trades that had MFE≥X but ended at stop/EOD loss):');
for (const mfe of [40, 60, 80, 100, 120, 140, 160, 180]) {
  const r = rescueAtMfe(mfe);
  console.log(`  MFE≥${mfe.toString().padStart(3)}pt n=${r.n.toString().padStart(2)}  ` +
    `actualLoss=$${r.totalLoss.toFixed(0).padStart(7)}  ` +
    `lock@20%=${r.p20rescue.toFixed(0).padStart(7)} 30%=${r.p30rescue.toFixed(0).padStart(7)} ` +
    `50%=${r.p50rescue.toFixed(0).padStart(7)} 70%=${r.p70rescue.toFixed(0).padStart(7)}`);
}

// Feature buckets
function dumpBucket(label, st) {
  const keys = Object.keys(st).sort();
  console.log(`\n--- by ${label} ---`);
  for (const k of keys) {
    const b = st[k];
    console.log(`  ${String(k).padEnd(18)} n=${b.n.toString().padStart(3)} PnL=$${b.pnl.toFixed(0).padStart(7)} WR=${b.wr.toFixed(0).padStart(3)}% PF=${b.pf.toFixed(2)} Sh=${b.sharpe.toFixed(2)} DD=$${b.maxDD.toFixed(0).padStart(5)}`);
  }
}
dumpBucket('rule', statsByKey(results, r => r.ruleId));
dumpBucket('hour', statsByKey(results, r => r.hourEt));
dumpBucket('dow', statsByKey(results, r => r.dow));
dumpBucket('regime', statsByKey(results, r => r.regime));
dumpBucket('ivPct', statsByKey(results, r => {
  if (r.ivPct == null) return 'unknown';
  if (r.ivPct < 0.2) return '0.0-0.2';
  if (r.ivPct < 0.4) return '0.2-0.4';
  if (r.ivPct < 0.6) return '0.4-0.6';
  if (r.ivPct < 0.8) return '0.6-0.8';
  return '0.8-1.0';
}));

// Cross: hour × rule
console.log('\n--- hour × rule (top n=2+ buckets only) ---');
const byHR = {};
for (const r of results) {
  if (r.dropped) continue;
  const k = `${r.hourEt}_${r.ruleId}`;
  (byHR[k] = byHR[k] || []).push(r);
}
const rows = Object.entries(byHR).map(([k, arr]) => {
  const s = stats(arr);
  return { k, ...s };
}).filter(r => r.n >= 2).sort((a, b) => a.pnl - b.pnl);
for (const r of rows.slice(0, 30)) {
  console.log(`  ${r.k.padEnd(8)} n=${r.n.toString().padStart(2)} PnL=$${r.pnl.toFixed(0).padStart(6)} WR=${r.wr.toFixed(0)}% PF=${r.pf.toFixed(2)}`);
}
console.log('  ...');
for (const r of rows.slice(-10)) {
  console.log(`  ${r.k.padEnd(8)} n=${r.n.toString().padStart(2)} PnL=$${r.pnl.toFixed(0).padStart(6)} WR=${r.wr.toFixed(0)}% PF=${r.pf.toFixed(2)}`);
}

// Per-rule MFE peaks
console.log('\n--- per-rule MFE distribution (gold-policy MFE) ---');
const byRuleRaw = {};
for (const r of results) {
  if (r.dropped) continue;
  (byRuleRaw[r.ruleId] = byRuleRaw[r.ruleId] || []).push(r);
}
for (const k of Object.keys(byRuleRaw).sort()) {
  const arr = byRuleRaw[k];
  const wMfes = arr.filter(r => r.pointsPnL * 20 - 5 > 0).map(r => r.mfe);
  const lMfes = arr.filter(r => r.pointsPnL * 20 - 5 < 0).map(r => r.mfe);
  console.log(`  ${k} winners n=${wMfes.length}: med=${percentiles(wMfes, [0.5])[0].toFixed(0)} p90=${percentiles(wMfes, [0.9])[0].toFixed(0)} | losers n=${lMfes.length}: med=${percentiles(lMfes, [0.5])[0].toFixed(0)} p90=${percentiles(lMfes, [0.9])[0].toFixed(0)}`);
}

console.log('\n--- gold exit-reason breakdown ---');
const goldExitCounts = {};
const goldExitPnl = {};
for (const w of walks) {
  goldExitCounts[w.goldExitReason] = (goldExitCounts[w.goldExitReason] || 0) + 1;
  goldExitPnl[w.goldExitReason] = (goldExitPnl[w.goldExitReason] || 0) + (w.goldNetPnL || 0);
}
for (const k of Object.keys(goldExitCounts).sort()) {
  console.log(`  ${k.padEnd(16)} n=${goldExitCounts[k]} netPnL=$${goldExitPnl[k].toFixed(0)}`);
}
