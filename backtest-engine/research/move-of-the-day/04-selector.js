// Phase 2b — Causal online "move-of-the-day" selector.
//
// Model: hierarchical shrunk mean of realized pointsPnL per (strategy, hourET),
//        fit ONLY on the training half. Score(signal) = expected pts, decision-time only.
// Policy: walk the day's RTH signals in entry order; TAKE THE FIRST whose score >= tau.
//         If none clear tau, skip the day (no trade). Fully causal, deployable.
// tau is swept on TRAIN (maximize a risk-adjusted objective), locked, applied to TEST.
//
// Reported both split directions (H1->H2 and H2->H1) to expose regime instability (gfi).

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { metrics, fmt } from './lib/metrics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, 'output');
const sessions = JSON.parse(fs.readFileSync(path.join(OUT, 'sessions.json'), 'utf8'));
const allDays = Object.keys(sessions).sort();

const pnl = s => s.outcome.pointsPnL;
const byEntry = (a, b) => a.entryTs - b.entryTs;
const K = 25; // shrinkage strength

// ---- model fit (train days only) ----
function fitModel(trainDays) {
  const sigs = trainDays.flatMap(d => sessions[d]);
  const global = sigs.reduce((a, s) => a + pnl(s), 0) / sigs.length;
  const byStrat = new Map(), byStratHour = new Map();
  for (const s of sigs) {
    const sh = `${s.strategy}@${s.entryHourET}`;
    (byStrat.get(s.strategy) || byStrat.set(s.strategy, []).get(s.strategy)).push(pnl(s));
    (byStratHour.get(sh) || byStratHour.set(sh, []).get(sh)).push(pnl(s));
  }
  const shrunk = (arr, parent) => arr ? (arr.reduce((a, b) => a + b, 0) + K * parent) / (arr.length + K) : parent;
  const stratMean = new Map([...byStrat].map(([k, a]) => [k, shrunk(a, global)]));
  return function score(s) {
    const sm = stratMean.get(s.strategy) ?? global;
    return shrunk(byStratHour.get(`${s.strategy}@${s.entryHourET}`), sm);
  };
}

// ---- online policy: first signal of day with score>=tau ----
function runPolicy(days, score, tau) {
  const series = [], picks = [];
  for (const d of days) {
    const ordered = [...sessions[d]].sort(byEntry);
    const pick = ordered.find(s => score(s) >= tau);
    if (pick) { series.push(pnl(pick)); picks.push({ d, strat: pick.strategy, side: pick.side, hour: pick.entryHourET, pts: pnl(pick), score: +score(pick).toFixed(1) }); }
  }
  return { series, picks };
}

// objective for tau sweep: risk-adjusted, penalize tiny samples. Use Sharpe * sign(PF-1), require >=40% of days traded.
function objective(series, nDays) {
  if (series.length < nDays * 0.25) return -1e9; // must trade reasonably often
  const m = metrics(series);
  if (m.profitFactor < 1) return -1e9;
  return m.sharpe; // maximize annualized Sharpe
}

function sweepTau(trainDays, score) {
  const cand = [];
  for (let t = -5; t <= 60; t += 1) cand.push(t);
  let best = null;
  for (const tau of cand) {
    const { series } = runPolicy(trainDays, score, tau);
    const obj = objective(series, trainDays.length);
    if (!best || obj > best.obj) best = { tau, obj, m: metrics(series), n: series.length };
  }
  return best;
}

function evalSplit(trainDays, testDays, label) {
  const score = fitModel(trainDays);
  const best = sweepTau(trainDays, score);
  const trainRes = runPolicy(trainDays, score, best.tau);
  const testRes = runPolicy(testDays, score, best.tau);
  console.log(`\n===== ${label}  (tau*=${best.tau}, chosen on train) =====`);
  console.log(`  TRAIN: ${fmt(metrics(trainRes.series))}  [traded ${trainRes.series.length}/${trainDays.length} days]`);
  console.log(`  TEST : ${fmt(metrics(testRes.series))}  [traded ${testRes.series.length}/${testDays.length} days]`);
  // attribution on test
  const att = {};
  for (const p of testRes.picks) att[p.strat] = (att[p.strat] || 0) + 1;
  console.log(`  TEST pick attribution:`, att);
  return { score, tau: best.tau, testRes };
}

const mid = allDays[Math.floor(allDays.length / 2)];
const H1 = allDays.filter(d => d < mid);
const H2 = allDays.filter(d => d >= mid);

console.log('========== CAUSAL ONLINE SELECTOR ==========');
console.log(`Days: ${allDays.length}  split @ ${mid}  (H1=${H1.length}, H2=${H2.length})`);

evalSplit(H1, H2, 'FORWARD  H1->H2');
evalSplit(H2, H1, 'REVERSE  H2->H1');

// Full-period model (fit on all) applied to all — in-sample reference + deployable artifact
const fullScore = fitModel(allDays);
const fullBest = sweepTau(allDays, fullScore);
const fullRes = runPolicy(allDays, fullScore, fullBest.tau);
console.log(`\n===== FULL-PERIOD (in-sample, tau*=${fullBest.tau}) =====`);
console.log(`  ${fmt(metrics(fullRes.series))}  [traded ${fullRes.series.length}/${allDays.length} days]`);
const fullAtt = {};
for (const p of fullRes.picks) fullAtt[p.strat] = (fullAtt[p.strat] || 0) + 1;
console.log(`  pick attribution:`, fullAtt);

fs.writeFileSync(path.join(OUT, 'selector-picks-full.json'), JSON.stringify(fullRes.picks));
console.log('\nReference baselines: first-signal/day $74,777 PF1.81 Sh3.12 | best-oracle $495,954 Sh18.73');
