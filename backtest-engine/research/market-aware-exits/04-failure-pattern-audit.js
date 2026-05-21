/**
 * Phase 4 — Audit how often Drew's "MFE 60-80% of TP → bounce to full SL"
 * pattern actually occurs in v3's 553 trades.
 *
 * For each trade:
 *   - mfePeak (favorable pts)
 *   - exit reason
 *   - did it have a "double rejection" on the way to its stop?
 *
 * Goal: explain why the market-aware sweeps found nothing meaningful.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const WALK_PATH = process.argv[2] || path.join(__dirname, 'output', '01-trades-walk-v3.json');
const walks = JSON.parse(fs.readFileSync(WALK_PATH, 'utf-8'));

// Use engine-recorded MFE (the actual MFE during the trade's hold, bounded by
// when it exited). Walk-computed MFE would scan past the exit and include
// post-exit price action — that's not what Drew's pattern is about.
function classify(w) {
  const tgt = w.ruleTargetPts;
  const stp = w.ruleStopPts;
  const mfePeak = w.v3MfePoints ?? 0;
  const fracOfTp = mfePeak / tgt;
  return {
    tradeId: w.tradeId,
    ruleId: w.ruleId,
    exit: w.v3ExitReason,
    pnl: w.v3NetPnL,
    target: tgt,
    stop: stp,
    mfePeak,
    fracOfTp,
  };
}

const classified = walks.map(classify);

// Bucket the "failure pattern": MFE reached >= 50% of TP, then trade ended as a loss.
const buckets = {
  'BIG_LOSS_high_mfe (MFE≥60%TP + loss)': [],
  'BIG_LOSS_mid_mfe (40-60%TP + loss)': [],
  'BIG_LOSS_low_mfe (<40%TP + loss)': [],
  'WIN_target (target hit)': [],
  'WIN_be (BE/trail captured)': [],
  'WIN_maxhold_or_eod (time-based win)': [],
  'LOSS_no_mfe (<10%TP + loss)': [],
};

for (const t of classified) {
  if (t.pnl > 0) {
    if (t.exit === 'take_profit') buckets['WIN_target (target hit)'].push(t);
    else if (t.exit === 'trailing_stop') buckets['WIN_be (BE/trail captured)'].push(t);
    else buckets['WIN_maxhold_or_eod (time-based win)'].push(t);
  } else {
    if (t.fracOfTp >= 0.6) buckets['BIG_LOSS_high_mfe (MFE≥60%TP + loss)'].push(t);
    else if (t.fracOfTp >= 0.4) buckets['BIG_LOSS_mid_mfe (40-60%TP + loss)'].push(t);
    else if (t.fracOfTp >= 0.1) buckets['BIG_LOSS_low_mfe (<40%TP + loss)'].push(t);
    else buckets['LOSS_no_mfe (<10%TP + loss)'].push(t);
  }
}

console.log('=== v3 trades by outcome × MFE fraction of TP ===\n');
for (const [k, arr] of Object.entries(buckets)) {
  const pnl = arr.reduce((a, b) => a + b.pnl, 0);
  const avgPnL = arr.length ? pnl / arr.length : 0;
  console.log(`  ${k.padEnd(45)}  n=${String(arr.length).padStart(3)}  $${pnl.toFixed(0).padStart(7)}  avg=$${avgPnL.toFixed(0).padStart(5)}`);
}

console.log('\n=== Drew\'s failure pattern (BIG_LOSS_high_mfe ≥ 60% of TP) ===');
const fail = buckets['BIG_LOSS_high_mfe (MFE≥60%TP + loss)'];
console.log(`Count: ${fail.length} / 553 (${(fail.length/553*100).toFixed(1)}%)`);
console.log(`Total loss: $${fail.reduce((a, b) => a + b.pnl, 0).toFixed(0)}`);
if (fail.length > 0) {
  console.log(`Avg loss: $${(fail.reduce((a, b) => a + b.pnl, 0) / fail.length).toFixed(0)}`);
  console.log('\nWorst 10 examples:');
  for (const t of fail.sort((a, b) => a.pnl - b.pnl).slice(0, 10)) {
    console.log(`  ${t.tradeId} ${t.ruleId.padEnd(11)}  TP=${t.target.toString().padStart(3)}pt MFE=${t.mfePeak.toFixed(1).padStart(5)}pt (${(t.fracOfTp*100).toFixed(0)}% of TP)  exit=${t.exit.padEnd(13)} pnl=$${t.pnl.toFixed(0)}`);
  }
}

console.log('\n=== BIG_LOSS_mid_mfe (40-60% of TP) — also relevant to pattern ===');
const mid = buckets['BIG_LOSS_mid_mfe (40-60%TP + loss)'];
console.log(`Count: ${mid.length} / 553 (${(mid.length/553*100).toFixed(1)}%)`);
console.log(`Total loss: $${mid.reduce((a, b) => a + b.pnl, 0).toFixed(0)}`);

// Estimate: if we could close all BIG_LOSS_high_mfe at MFE * 0.3 (saving 70% of the loss
// because we'd lock in some profit instead of taking full SL), how much would we save?
console.log('\n=== Theoretical max from market-aware exits ===');
const POINT_VALUE = 20;
const ifWeCaughtAll = fail.reduce((acc, t) => {
  // Counterfactual: instead of full SL (avg ~$-1400), exit at 30% of MFE (lock-in profit)
  // = +30% * MFE pts * $20 - $5 commission
  const woulHaveSaved = t.mfePeak * 0.3 * POINT_VALUE - 5;
  return acc + (woulHaveSaved - t.pnl);  // delta vs actual
}, 0);
console.log(`If we caught all ${fail.length} high-MFE losers and exited at 30% of MFE: +$${ifWeCaughtAll.toFixed(0)} max upside`);
const ifWeCaughtMid = mid.reduce((acc, t) => {
  const woulHaveSaved = t.mfePeak * 0.3 * POINT_VALUE - 5;
  return acc + (woulHaveSaved - t.pnl);
}, 0);
console.log(`Plus catching all ${mid.length} mid-MFE losers: +$${ifWeCaughtMid.toFixed(0)} extra`);
console.log(`Combined max upside: +$${(ifWeCaughtAll + ifWeCaughtMid).toFixed(0)} (assuming 100% detection — actual will be much less)`);
