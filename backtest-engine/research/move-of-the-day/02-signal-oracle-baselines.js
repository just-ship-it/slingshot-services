// Phase 1b — Signal-restricted oracle + causal baselines.
//
// Universe = the actual signals each strategy fired in RTH (output/sessions.json).
// Each candidate's outcome = its own realized pointsPnL (strategy's own exit).
//
// Oracles (hindsight ceilings):
//   bestSignal  — per day, the single signal with max realized pointsPnL (achievable ceiling)
//   worstSignal — per day min (the floor / how bad selection can get)
// Causal baselines (no-lookahead, one trade/day):
//   firstSignal — take the first RTH signal of the day (any strategy)
//   first-<strat> — take the first signal of the day from a fixed strategy (skip days it's absent)
//   randomMean  — expected value of picking uniformly at random = mean of day's signals
//
// All evaluated as a one-trade-per-day series with risk-adjusted metrics.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { metrics, fmt } from './lib/metrics.js';
import oracleOhlcvJson from './output/oracle-ohlcv.json' with { type: 'json' };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, 'output');
const sessions = JSON.parse(fs.readFileSync(path.join(OUT, 'sessions.json'), 'utf8'));
const days = Object.keys(sessions).sort();

const pnl = s => s.outcome.pointsPnL;
const byEntry = (a, b) => a.entryTs - b.entryTs;

// ---- oracles ----
const bestSeries = [], worstSeries = [], randomSeries = [];
const bestPick = {}; // date -> chosen signal (for later inspection)
for (const d of days) {
  const sigs = sessions[d];
  const best = sigs.reduce((m, s) => pnl(s) > pnl(m) ? s : m, sigs[0]);
  const worst = sigs.reduce((m, s) => pnl(s) < pnl(m) ? s : m, sigs[0]);
  bestSeries.push(pnl(best));
  worstSeries.push(pnl(worst));
  randomSeries.push(sigs.reduce((a, s) => a + pnl(s), 0) / sigs.length);
  bestPick[d] = { strategy: best.strategy, side: best.side, pts: pnl(best), hourET: best.entryHourET, features: best.features };
}

// ---- causal baselines ----
const firstSeries = days.map(d => pnl([...sessions[d]].sort(byEntry)[0]));

function firstOfStrat(strat) {
  const series = [];
  for (const d of days) {
    const cand = [...sessions[d]].filter(s => s.strategy === strat).sort(byEntry);
    if (cand.length) series.push(pnl(cand[0]));
  }
  return series;
}

// ---- coverage vs OHLCV ceiling ----
let capturedOfTheoretical = 0, ohlcvDays = 0;
for (const d of days) {
  const o = oracleOhlcvJson[d];
  if (!o) continue;
  ohlcvDays++;
  capturedOfTheoretical += Math.max(0, bestSeries[ohlcvDays === 0 ? 0 : days.indexOf(d)]) / o.oracleMove;
}

console.log('========== SIGNAL-RESTRICTED ORACLE & BASELINES (one trade/day, RTH) ==========');
console.log(`Sessions: ${days.length}\n`);
console.log('ORACLES (hindsight ceilings):');
console.log('  best signal/day :', fmt(metrics(bestSeries)));
console.log('  worst signal/day:', fmt(metrics(worstSeries)));
console.log('\nCAUSAL BASELINES (no-lookahead):');
console.log('  random pick (EV):', fmt(metrics(randomSeries)));
console.log('  first signal/day:', fmt(metrics(firstSeries)));
for (const s of ['glx', 'glf', 'gfi', 'lstb']) {
  console.log(`  first ${s.padEnd(4)}/day  :`, fmt(metrics(firstOfStrat(s))));
}

// best-signal strategy attribution
const attर = {};
for (const d of days) { const s = bestPick[d].strategy; attर[s] = (attर[s] || 0) + 1; }
console.log('\nBest-signal-of-day attribution:', attर);

// coverage: of the theoretical OHLCV move, how much does the best ACHIEVABLE signal capture?
const ratios = days.filter(d => oracleOhlcvJson[d]).map(d => {
  const idx = days.indexOf(d);
  return Math.max(0, bestSeries[idx]) / oracleOhlcvJson[d].oracleMove;
});
const meanRatio = ratios.reduce((a, b) => a + b, 0) / ratios.length;
const bestOraclePts = metrics(bestSeries).totalPts;
const ohlcvPts = days.filter(d => oracleOhlcvJson[d]).reduce((a, d) => a + oracleOhlcvJson[d].oracleMove, 0);
console.log('\nCOVERAGE vs theoretical OHLCV ceiling:');
console.log(`  best-signal oracle: ${bestOraclePts.toFixed(0)} pts   vs OHLCV ceiling ${ohlcvPts.toFixed(0)} pts  → ${(bestOraclePts / ohlcvPts * 100).toFixed(1)}% of theoretical`);
console.log(`  mean per-day capture ratio (best signal / day max move): ${(meanRatio * 100).toFixed(1)}%`);

fs.writeFileSync(path.join(OUT, 'best-pick.json'), JSON.stringify(bestPick));
console.log('\nWrote output/best-pick.json');
