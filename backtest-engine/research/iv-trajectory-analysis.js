/**
 * IV Trajectory Analysis
 *
 * For each trade in the 1m IV backtest, track how IV and skew evolve
 * bar-by-bar during the trade. Determine if IV shifts predict whether
 * a trade hits target or stop.
 *
 * Key questions:
 * 1. Does skew reversing (flipping sign) during a trade predict losers?
 * 2. How does IV change in the first N minutes for winners vs losers?
 * 3. Can we identify an early-exit threshold based on IV/skew shifts?
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';

const DATA_DIR = path.join(import.meta.dirname, '..', 'data');
const RESULTS_FILE = path.join(import.meta.dirname, '..', 'results', 'iv-skew-gex-iv1m.json');

async function loadIVData() {
  const ivFile = path.join(DATA_DIR, 'iv', 'qqq', 'qqq_atm_iv_1m.csv');
  const records = [];

  return new Promise((resolve, reject) => {
    let headers = null;
    const stream = fs.createReadStream(ivFile);
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    rl.on('line', (line) => {
      if (!headers) {
        headers = line.split(',');
        return;
      }
      const values = line.split(',');
      const record = {};
      headers.forEach((h, i) => record[h] = values[i]);

      const timestamp = new Date(record.timestamp).getTime();
      records.push({
        timestamp,
        iv: parseFloat(record.iv),
        callIV: parseFloat(record.call_iv),
        putIV: parseFloat(record.put_iv),
        skew: parseFloat(record.put_iv) - parseFloat(record.call_iv),
        spotPrice: parseFloat(record.spot_price)
      });
    });

    rl.on('close', () => {
      records.sort((a, b) => a.timestamp - b.timestamp);
      console.log(`Loaded ${records.length} IV records`);
      resolve(records);
    });
    rl.on('error', reject);
  });
}

function findIVAtTime(ivData, timestamp) {
  let left = 0;
  let right = ivData.length - 1;

  while (left < right) {
    const mid = Math.floor((left + right + 1) / 2);
    if (ivData[mid].timestamp <= timestamp) {
      left = mid;
    } else {
      right = mid - 1;
    }
  }

  if (ivData[left].timestamp <= timestamp) {
    return ivData[left];
  }
  return null;
}

function getIVTrajectory(ivData, entryTime, exitTime) {
  // Get all IV records between entry and exit
  const trajectory = [];

  // Binary search to find start index
  let left = 0;
  let right = ivData.length - 1;
  while (left < right) {
    const mid = Math.floor((left + right) / 2);
    if (ivData[mid].timestamp < entryTime) {
      left = mid + 1;
    } else {
      right = mid;
    }
  }

  // Collect all IV records from entry to exit
  for (let i = left; i < ivData.length && ivData[i].timestamp <= exitTime; i++) {
    trajectory.push({
      ...ivData[i],
      minutesInTrade: (ivData[i].timestamp - entryTime) / 60000
    });
  }

  return trajectory;
}

async function main() {
  console.log('Loading trade results...');
  const results = JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf-8'));
  const trades = results.trades.filter(t => t.status === 'completed');
  console.log(`${trades.length} completed trades`);

  console.log('\nLoading 1m IV data...');
  const ivData = await loadIVData();

  // Categorize trades
  const winners = trades.filter(t => t.netPnL > 0);
  const losers = trades.filter(t => t.netPnL <= 0);
  const targetHits = trades.filter(t => t.exitReason === 'take_profit');
  const stopHits = trades.filter(t => t.exitReason === 'stop_loss');
  const trailingHits = trades.filter(t => t.exitReason === 'trailing_stop');
  const maxHoldHits = trades.filter(t => t.exitReason === 'max_hold_time');

  console.log(`\nWinners: ${winners.length}, Losers: ${losers.length}`);
  console.log(`Target: ${targetHits.length}, Stop: ${stopHits.length}, Trailing: ${trailingHits.length}, MaxHold: ${maxHoldHits.length}`);

  // =========================================================
  // ANALYSIS 1: IV/Skew change from entry for each exit type
  // =========================================================
  console.log('\n' + '='.repeat(70));
  console.log('ANALYSIS 1: IV & Skew Change (Entry → Exit) by Exit Reason');
  console.log('='.repeat(70));

  const exitGroups = {
    'take_profit': targetHits,
    'stop_loss': stopHits,
    'trailing_stop': trailingHits,
    'max_hold_time': maxHoldHits
  };

  for (const [reason, group] of Object.entries(exitGroups)) {
    if (group.length === 0) continue;

    const ivChanges = [];
    const skewChanges = [];
    const skewFlips = { count: 0, total: 0 };

    for (const trade of group) {
      const entryIV = findIVAtTime(ivData, trade.entryTime);
      const exitIV = findIVAtTime(ivData, trade.exitTime);

      if (!entryIV || !exitIV) continue;

      const ivChange = exitIV.iv - entryIV.iv;
      const skewChange = exitIV.skew - entryIV.skew;

      ivChanges.push(ivChange);
      skewChanges.push(skewChange);

      // Did skew flip sign during the trade?
      skewFlips.total++;
      if (Math.sign(entryIV.skew) !== 0 && Math.sign(entryIV.skew) !== Math.sign(exitIV.skew)) {
        skewFlips.count++;
      }
    }

    const avgIVChange = ivChanges.reduce((s, v) => s + v, 0) / ivChanges.length;
    const avgSkewChange = skewChanges.reduce((s, v) => s + v, 0) / skewChanges.length;

    console.log(`\n  ${reason} (n=${group.length}):`);
    console.log(`    Avg IV change:   ${(avgIVChange * 100).toFixed(4)}% (${avgIVChange > 0 ? 'IV rose' : 'IV fell'})`);
    console.log(`    Avg Skew change: ${(avgSkewChange * 100).toFixed(4)}% (${avgSkewChange > 0 ? 'more fearful' : 'more complacent'})`);
    console.log(`    Skew flipped:    ${skewFlips.count}/${skewFlips.total} (${(skewFlips.count/skewFlips.total*100).toFixed(1)}%)`);
  }

  // =========================================================
  // ANALYSIS 2: Skew direction vs trade direction
  // =========================================================
  console.log('\n' + '='.repeat(70));
  console.log('ANALYSIS 2: Skew Moving Against Trade Thesis');
  console.log('  Long entries expect negative skew (calls expensive)');
  console.log('  Short entries expect positive skew (puts expensive)');
  console.log('  "Against" = skew moving toward reversing the entry condition');
  console.log('='.repeat(70));

  // For longs: entered on negative skew. If skew becomes MORE positive (toward fear),
  // that contradicts the complacent/bullish thesis → potential loser
  // For shorts: entered on positive skew. If skew becomes MORE negative,
  // that contradicts the fearful/bearish thesis → potential loser

  const analysis2 = { winners: { against: 0, with: 0 }, losers: { against: 0, with: 0 } };

  for (const trade of trades) {
    const entryIV = findIVAtTime(ivData, trade.entryTime);
    const exitIV = findIVAtTime(ivData, trade.exitTime);
    if (!entryIV || !exitIV) continue;

    const skewChange = exitIV.skew - entryIV.skew;
    const isWinner = trade.netPnL > 0;
    const bucket = isWinner ? 'winners' : 'losers';

    let movingAgainst = false;
    if (trade.side === 'long') {
      // Long entered on negative skew → skew going MORE positive = against thesis
      movingAgainst = skewChange > 0;
    } else {
      // Short entered on positive skew → skew going MORE negative = against thesis
      movingAgainst = skewChange < 0;
    }

    if (movingAgainst) {
      analysis2[bucket].against++;
    } else {
      analysis2[bucket].with++;
    }
  }

  console.log(`\n  Winners: ${analysis2.winners.against} against / ${analysis2.winners.with} with thesis`);
  console.log(`    (${(analysis2.winners.against/(analysis2.winners.against+analysis2.winners.with)*100).toFixed(1)}% had skew move against)`);
  console.log(`  Losers:  ${analysis2.losers.against} against / ${analysis2.losers.with} with thesis`);
  console.log(`    (${(analysis2.losers.against/(analysis2.losers.against+analysis2.losers.with)*100).toFixed(1)}% had skew move against)`);

  // =========================================================
  // ANALYSIS 3: Time-bucketed IV/skew trajectory (1, 2, 5, 10, 15, 30 min)
  // =========================================================
  console.log('\n' + '='.repeat(70));
  console.log('ANALYSIS 3: Skew Change at Time Buckets (Winners vs Losers vs Stops)');
  console.log('  Positive = skew became more positive (puts more expensive)');
  console.log('  Negative = skew became more negative (calls more expensive)');
  console.log('='.repeat(70));

  const buckets = [1, 2, 5, 10, 15, 20, 30];

  const trajectoryData = {
    winners: { skewChanges: {}, ivChanges: {}, counts: {} },
    losers: { skewChanges: {}, ivChanges: {}, counts: {} },
    stopHits: { skewChanges: {}, ivChanges: {}, counts: {} }
  };

  for (const b of buckets) {
    for (const cat of Object.keys(trajectoryData)) {
      trajectoryData[cat].skewChanges[b] = [];
      trajectoryData[cat].ivChanges[b] = [];
      trajectoryData[cat].counts[b] = 0;
    }
  }

  for (const trade of trades) {
    const entryIV = findIVAtTime(ivData, trade.entryTime);
    if (!entryIV) continue;

    const isWinner = trade.netPnL > 0;
    const isStop = trade.exitReason === 'stop_loss';
    const cat = isStop ? 'stopHits' : (isWinner ? 'winners' : 'losers');

    const tradeDurationMin = (trade.exitTime - trade.entryTime) / 60000;

    for (const b of buckets) {
      if (tradeDurationMin < b) continue; // Trade didn't last this long

      const checkTime = trade.entryTime + b * 60000;
      const ivAtCheck = findIVAtTime(ivData, checkTime);
      if (!ivAtCheck) continue;

      // Normalize skew change by trade direction
      // For longs: positive skewChange = against thesis
      // For shorts: negative skewChange = against thesis
      // Normalize: positive = against thesis for ALL trades
      let skewChange = ivAtCheck.skew - entryIV.skew;
      if (trade.side === 'short') skewChange = -skewChange;

      trajectoryData[cat].skewChanges[b].push(skewChange);
      trajectoryData[cat].ivChanges[b].push(ivAtCheck.iv - entryIV.iv);
      trajectoryData[cat].counts[b]++;
    }
  }

  console.log('\n  Minutes into trade →');
  console.log('  ' + 'Category'.padEnd(15) + buckets.map(b => `${b}m`.padStart(10)).join(''));
  console.log('  ' + '-'.repeat(15 + buckets.length * 10));

  for (const [cat, data] of Object.entries(trajectoryData)) {
    const skewRow = buckets.map(b => {
      const vals = data.skewChanges[b];
      if (vals.length === 0) return 'n/a'.padStart(10);
      const avg = vals.reduce((s, v) => s + v, 0) / vals.length;
      return (avg >= 0 ? '+' : '') + (avg * 100).toFixed(3) + '%';
    });
    const countRow = buckets.map(b => {
      return `(n=${data.counts[b]})`;
    });

    console.log(`  ${cat.padEnd(15)}${skewRow.map(s => s.padStart(10)).join('')}`);
    console.log(`  ${''.padEnd(15)}${countRow.map(s => s.padStart(10)).join('')}`);
  }

  // =========================================================
  // ANALYSIS 4: Early warning signals — what thresholds separate W/L?
  // =========================================================
  console.log('\n' + '='.repeat(70));
  console.log('ANALYSIS 4: Early Warning — Skew Change at 2/5/10 min as Classifier');
  console.log('  If we had exited when skew moved > X against thesis, what happens?');
  console.log('='.repeat(70));

  // For each time checkpoint, test various thresholds
  const checkpoints = [2, 5, 10];
  const thresholds = [0.001, 0.002, 0.005, 0.01, 0.015, 0.02, 0.03];

  for (const checkpoint of checkpoints) {
    console.log(`\n  At ${checkpoint} minutes into trade:`);
    console.log(`  ${'Threshold'.padEnd(12)} ${'Exits'.padStart(8)} ${'Saved(W→exit)'.padStart(15)} ${'Saved(L→exit)'.padStart(15)} ${'NetPnLSaved'.padStart(12)} ${'FalseExits%'.padStart(12)}`);
    console.log(`  ${'-'.repeat(75)}`);

    for (const threshold of thresholds) {
      let totalExits = 0;
      let winnerExits = 0; // Would have exited a winner (false positive)
      let loserExits = 0;  // Would have exited a loser (true positive)
      let pnlOfExitedWinners = 0;
      let pnlOfExitedLosers = 0;
      let remainingTrades = 0;

      for (const trade of trades) {
        const tradeDurationMin = (trade.exitTime - trade.entryTime) / 60000;
        if (tradeDurationMin < checkpoint) {
          remainingTrades++;
          continue;
        }

        const entryIV = findIVAtTime(ivData, trade.entryTime);
        const checkTime = trade.entryTime + checkpoint * 60000;
        const ivAtCheck = findIVAtTime(ivData, checkTime);

        if (!entryIV || !ivAtCheck) {
          remainingTrades++;
          continue;
        }

        let skewChange = ivAtCheck.skew - entryIV.skew;
        if (trade.side === 'short') skewChange = -skewChange;

        if (skewChange > threshold) {
          // Would exit this trade
          totalExits++;
          if (trade.netPnL > 0) {
            winnerExits++;
            pnlOfExitedWinners += trade.netPnL;
          } else {
            loserExits++;
            pnlOfExitedLosers += trade.netPnL;
          }
        } else {
          remainingTrades++;
        }
      }

      const falseExitPct = totalExits > 0 ? (winnerExits / totalExits * 100).toFixed(1) : 'n/a';
      // Net PnL impact: we'd lose the winner PnL but save the loser PnL
      // Losers have negative PnL, so "saving" them means we avoid that loss
      // But we also lose winner PnL. Net impact = -pnlOfExitedWinners + Math.abs(pnlOfExitedLosers)
      const netSaved = -pnlOfExitedWinners - pnlOfExitedLosers; // losers have neg PnL, so - neg = +

      console.log(`  ${('+' + (threshold * 100).toFixed(1) + '%').padEnd(12)} ${String(totalExits).padStart(8)} ${String(winnerExits).padStart(15)} ${String(loserExits).padStart(15)} ${('$' + netSaved.toFixed(0)).padStart(12)} ${String(falseExitPct + '%').padStart(12)}`);
    }
  }

  // =========================================================
  // ANALYSIS 5: IV absolute level during trade — regime matters?
  // =========================================================
  console.log('\n' + '='.repeat(70));
  console.log('ANALYSIS 5: Entry IV Level vs Outcome');
  console.log('  Does higher volatility at entry predict more losers?');
  console.log('='.repeat(70));

  const ivBuckets = [
    { label: '18-22%', min: 0.18, max: 0.22 },
    { label: '22-26%', min: 0.22, max: 0.26 },
    { label: '26-30%', min: 0.26, max: 0.30 },
    { label: '30-35%', min: 0.30, max: 0.35 },
    { label: '35-40%', min: 0.35, max: 0.40 },
    { label: '40%+', min: 0.40, max: 1.0 }
  ];

  console.log(`\n  ${'IV Range'.padEnd(12)} ${'Trades'.padStart(8)} ${'WinRate'.padStart(8)} ${'AvgPnL'.padStart(10)} ${'StopRate'.padStart(10)}`);
  console.log(`  ${'-'.repeat(50)}`);

  for (const bucket of ivBuckets) {
    const inBucket = trades.filter(t => {
      const iv = t.signal?.ivValue || 0;
      return iv >= bucket.min && iv < bucket.max;
    });

    if (inBucket.length === 0) continue;

    const winRate = inBucket.filter(t => t.netPnL > 0).length / inBucket.length * 100;
    const avgPnL = inBucket.reduce((s, t) => s + t.netPnL, 0) / inBucket.length;
    const stopRate = inBucket.filter(t => t.exitReason === 'stop_loss').length / inBucket.length * 100;

    console.log(`  ${bucket.label.padEnd(12)} ${String(inBucket.length).padStart(8)} ${(winRate.toFixed(1) + '%').padStart(8)} ${('$' + avgPnL.toFixed(0)).padStart(10)} ${(stopRate.toFixed(1) + '%').padStart(10)}`);
  }

  // =========================================================
  // ANALYSIS 6: Skew magnitude at entry vs outcome
  // =========================================================
  console.log('\n' + '='.repeat(70));
  console.log('ANALYSIS 6: Entry |Skew| Magnitude vs Outcome');
  console.log('  Stronger skew at entry = more conviction. Does it help?');
  console.log('='.repeat(70));

  const skewBuckets = [
    { label: '1.0-1.5%', min: 0.01, max: 0.015 },
    { label: '1.5-2.0%', min: 0.015, max: 0.02 },
    { label: '2.0-3.0%', min: 0.02, max: 0.03 },
    { label: '3.0-5.0%', min: 0.03, max: 0.05 },
    { label: '5.0%+', min: 0.05, max: 1.0 }
  ];

  console.log(`\n  ${'|Skew|'.padEnd(12)} ${'Trades'.padStart(8)} ${'WinRate'.padStart(8)} ${'AvgPnL'.padStart(10)} ${'StopRate'.padStart(10)} ${'AvgDuration'.padStart(12)}`);
  console.log(`  ${'-'.repeat(62)}`);

  for (const bucket of skewBuckets) {
    const inBucket = trades.filter(t => {
      const absSkew = Math.abs(t.signal?.ivSkew || 0);
      return absSkew >= bucket.min && absSkew < bucket.max;
    });

    if (inBucket.length === 0) continue;

    const winRate = inBucket.filter(t => t.netPnL > 0).length / inBucket.length * 100;
    const avgPnL = inBucket.reduce((s, t) => s + t.netPnL, 0) / inBucket.length;
    const stopRate = inBucket.filter(t => t.exitReason === 'stop_loss').length / inBucket.length * 100;
    const avgDuration = inBucket.reduce((s, t) => s + (t.exitTime - t.entryTime), 0) / inBucket.length / 60000;

    console.log(`  ${bucket.label.padEnd(12)} ${String(inBucket.length).padStart(8)} ${(winRate.toFixed(1) + '%').padStart(8)} ${('$' + avgPnL.toFixed(0)).padStart(10)} ${(stopRate.toFixed(1) + '%').padStart(10)} ${(avgDuration.toFixed(1) + 'min').padStart(12)}`);
  }

  // =========================================================
  // ANALYSIS 7: Skew at 2-min intervals — cumulative picture for W vs L
  // =========================================================
  console.log('\n' + '='.repeat(70));
  console.log('ANALYSIS 7: Minute-by-Minute Skew Trajectory (Normalized)');
  console.log('  Avg skew-change-against-thesis at each minute for W vs L');
  console.log('  Positive = skew moving against thesis');
  console.log('='.repeat(70));

  const maxMinutes = 30;
  const winnerTraj = Array(maxMinutes + 1).fill(null).map(() => []);
  const loserTraj = Array(maxMinutes + 1).fill(null).map(() => []);
  const stopTraj = Array(maxMinutes + 1).fill(null).map(() => []);

  for (const trade of trades) {
    const entryIV = findIVAtTime(ivData, trade.entryTime);
    if (!entryIV) continue;

    const isWinner = trade.netPnL > 0;
    const isStop = trade.exitReason === 'stop_loss';
    const tradeDurationMin = (trade.exitTime - trade.entryTime) / 60000;

    for (let m = 1; m <= Math.min(maxMinutes, Math.floor(tradeDurationMin)); m++) {
      const checkTime = trade.entryTime + m * 60000;
      const ivAtCheck = findIVAtTime(ivData, checkTime);
      if (!ivAtCheck) continue;

      let skewChange = ivAtCheck.skew - entryIV.skew;
      if (trade.side === 'short') skewChange = -skewChange;

      if (isStop) stopTraj[m].push(skewChange);
      else if (isWinner) winnerTraj[m].push(skewChange);
      else loserTraj[m].push(skewChange);
    }
  }

  console.log(`\n  ${'Min'.padEnd(5)} ${'Winners'.padStart(12)} ${'(n)'.padStart(6)} ${'Losers'.padStart(12)} ${'(n)'.padStart(6)} ${'StopHits'.padStart(12)} ${'(n)'.padStart(6)} ${'Separation'.padStart(12)}`);
  console.log(`  ${'-'.repeat(75)}`);

  for (let m = 1; m <= maxMinutes; m++) {
    const wAvg = winnerTraj[m].length > 0 ? winnerTraj[m].reduce((s, v) => s + v, 0) / winnerTraj[m].length : 0;
    const lAvg = loserTraj[m].length > 0 ? loserTraj[m].reduce((s, v) => s + v, 0) / loserTraj[m].length : 0;
    const sAvg = stopTraj[m].length > 0 ? stopTraj[m].reduce((s, v) => s + v, 0) / stopTraj[m].length : 0;
    const sep = lAvg - wAvg;

    const fmtPct = (v) => (v >= 0 ? '+' : '') + (v * 100).toFixed(4) + '%';

    console.log(`  ${String(m).padEnd(5)} ${fmtPct(wAvg).padStart(12)} ${('(' + winnerTraj[m].length + ')').padStart(6)} ${fmtPct(lAvg).padStart(12)} ${('(' + loserTraj[m].length + ')').padStart(6)} ${fmtPct(sAvg).padStart(12)} ${('(' + stopTraj[m].length + ')').padStart(6)} ${fmtPct(sep).padStart(12)}`);
  }

  // =========================================================
  // ANALYSIS 8: Best early-exit signal — combined skew threshold + time
  // =========================================================
  console.log('\n' + '='.repeat(70));
  console.log('ANALYSIS 8: Simulated Early Exit — PnL Impact');
  console.log('  If we exit at checkpoint when skew moves > threshold against thesis,');
  console.log('  what is the overall PnL impact vs letting all trades run?');
  console.log('='.repeat(70));

  const baselinePnL = trades.reduce((s, t) => s + t.netPnL, 0);
  console.log(`\n  Baseline PnL (no early exit): $${baselinePnL.toLocaleString()}`);
  console.log(`  Baseline trades: ${trades.length}, WR: ${(trades.filter(t => t.netPnL > 0).length / trades.length * 100).toFixed(1)}%\n`);

  // For early-exited trades, estimate PnL at that point
  // We'll use a rough estimate: if trade was in the money at checkpoint, partial profit
  // If it was losing at checkpoint, we avoid the full loss
  // More accurate: look at the candle data... but we don't have that loaded.
  // Instead, assume early exit at checkpoint saves ~50% of the eventual loss for losers,
  // and costs ~50% of the eventual gain for winners that get stopped.
  //
  // Actually, let's just compute: how many stop_loss trades would we catch vs
  // how many take_profit trades would we falsely exit

  const simResults = [];

  for (const checkpoint of [2, 5, 10]) {
    for (const threshold of [0.002, 0.005, 0.01, 0.015, 0.02]) {
      let earlyExits = 0;
      let stopsAvoided = 0;
      let winnersKilled = 0;
      let trailingKilled = 0;
      let maxholdKilled = 0;
      let pnlOfStopsAvoided = 0;
      let pnlOfWinnersKilled = 0;

      for (const trade of trades) {
        const tradeDurationMin = (trade.exitTime - trade.entryTime) / 60000;
        if (tradeDurationMin < checkpoint) continue;

        const entryIV = findIVAtTime(ivData, trade.entryTime);
        const checkTime = trade.entryTime + checkpoint * 60000;
        const ivAtCheck = findIVAtTime(ivData, checkTime);
        if (!entryIV || !ivAtCheck) continue;

        let skewChange = ivAtCheck.skew - entryIV.skew;
        if (trade.side === 'short') skewChange = -skewChange;

        if (skewChange > threshold) {
          earlyExits++;
          if (trade.exitReason === 'stop_loss') {
            stopsAvoided++;
            pnlOfStopsAvoided += trade.netPnL; // negative
          } else {
            if (trade.exitReason === 'take_profit') winnersKilled++;
            else if (trade.exitReason === 'trailing_stop') trailingKilled++;
            else maxholdKilled++;
            pnlOfWinnersKilled += trade.netPnL; // positive
          }
        }
      }

      simResults.push({
        checkpoint,
        threshold: (threshold * 100).toFixed(1) + '%',
        earlyExits,
        stopsAvoided,
        winnersKilled,
        trailingKilled,
        maxholdKilled,
        avgStopLoss: stopsAvoided > 0 ? (pnlOfStopsAvoided / stopsAvoided).toFixed(0) : 'n/a',
        avgWinnerKilled: winnersKilled + trailingKilled + maxholdKilled > 0 ?
          (pnlOfWinnersKilled / (winnersKilled + trailingKilled + maxholdKilled)).toFixed(0) : 'n/a',
        precision: earlyExits > 0 ? (stopsAvoided / earlyExits * 100).toFixed(1) + '%' : 'n/a'
      });
    }
  }

  console.log(`  ${'Check'.padEnd(7)} ${'Thresh'.padEnd(8)} ${'Exits'.padStart(7)} ${'Stops'.padStart(7)} ${'TP'.padStart(5)} ${'Trail'.padStart(7)} ${'MaxH'.padStart(6)} ${'Precision'.padStart(10)} ${'AvgStopPnL'.padStart(12)} ${'AvgWinPnL'.padStart(11)}`);
  console.log(`  ${'-'.repeat(85)}`);

  for (const r of simResults) {
    console.log(`  ${(r.checkpoint + 'min').padEnd(7)} ${r.threshold.padEnd(8)} ${String(r.earlyExits).padStart(7)} ${String(r.stopsAvoided).padStart(7)} ${String(r.winnersKilled).padStart(5)} ${String(r.trailingKilled).padStart(7)} ${String(r.maxholdKilled).padStart(6)} ${r.precision.padStart(10)} ${('$' + r.avgStopLoss).padStart(12)} ${('$' + r.avgWinnerKilled).padStart(11)}`);
  }

  console.log('\n  Key: Precision = what % of early exits were actual stop-loss trades');
  console.log('  Higher precision = more "correct" early exits, fewer false positives');

  console.log('\nDone.');
}

main().catch(console.error);
