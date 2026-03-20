/**
 * LT Candle Regime — Profit Trajectory & Exit Optimization Analysis
 *
 * For every BELOW→ABOVE and ABOVE→BELOW transition event, track:
 *   - Minute-by-minute P&L trajectory (0-120 minutes)
 *   - Time to max favorable excursion (when does the peak happen?)
 *   - Time to max adverse excursion (when does the worst drawdown happen?)
 *   - Profit at various time checkpoints (5m, 10m, 15m, 20m, 30m, 45m, 60m, 90m, 120m)
 *   - For winners: how much profit is left on the table at 30m exit?
 *   - For losers: when did they turn negative and stay negative?
 *   - Trailing stop analysis: if we trailed X pts behind the peak, what's the capture?
 *   - Time-based ratchet analysis: if we move stop to breakeven at Xm, then trail after Ym
 *   - Structural analysis: how often does price return to entry after being +N pts in profit?
 *
 * Uses raw contract OHLCV data for price space alignment with LT levels.
 *
 * Usage: cd backtest-engine && node research/lt-regime-profit-trajectory.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { CSVLoader } from '../src/data/csv-loader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'config', 'default.json'), 'utf-8'));

const R = (v, w) => String(v).padStart(w);

const START_DATE = new Date('2023-04-01');
const END_DATE = new Date('2025-12-25');
const MAX_BARS = 120; // Track up to 2 hours
const CHECKPOINTS = [5, 10, 15, 20, 25, 30, 45, 60, 90, 120];

// Trailing stop distances to test (points behind peak)
const TRAIL_DISTANCES = [5, 8, 10, 12, 15, 20, 25, 30, 40, 50];

// Time-based ratchet: move stop to BE after N minutes in profit
const BE_TRIGGER_MINUTES = [3, 5, 7, 10, 15, 20];
const BE_TRIGGER_PROFIT = [2, 3, 5, 8, 10, 15, 20]; // pts in profit before BE activates

// ============================================================================
// TIMEZONE
// ============================================================================
function isDST(ms) {
  const d = new Date(ms), y = d.getUTCFullYear(), m = d.getUTCMonth();
  if (m >= 3 && m <= 9) return true;
  if (m === 0 || m === 1 || m === 11) return false;
  if (m === 2) { const fd = new Date(Date.UTC(y, 2, 1)).getUTCDay(); return ms >= Date.UTC(y, 2, fd === 0 ? 8 : 15 - fd, 7); }
  if (m === 10) { const fd = new Date(Date.UTC(y, 10, 1)).getUTCDay(); return ms < Date.UTC(y, 10, fd === 0 ? 1 : 8 - fd, 6); }
  return false;
}
function getSession(ts) {
  const offset = isDST(ts) ? -4 : -5;
  const d = new Date(ts + offset * 3600000);
  const h = d.getUTCHours() + d.getUTCMinutes() / 60;
  if (h >= 18 || h < 4) return 'overnight';
  if (h >= 4 && h < 9.5) return 'premarket';
  if (h >= 9.5 && h < 16) return 'rth';
  return 'afterhours';
}
function isRollWeek(ts) {
  const offset = isDST(ts) ? -4 : -5;
  const d = new Date(ts + offset * 3600000);
  const month = d.getUTCMonth();
  if (month !== 2 && month !== 5 && month !== 8 && month !== 11) return false;
  return d.getUTCDate() >= 7 && d.getUTCDate() <= 21;
}

// ============================================================================
// DATA LOADING
// ============================================================================
async function loadData() {
  console.log('Loading data (raw contracts)...');
  const csvLoader = new CSVLoader(DATA_DIR, CONFIG, { noContinuous: true });
  const { candles: raw } = await csvLoader.loadOHLCVData('NQ', START_DATE, END_DATE);
  const candles = csvLoader.filterPrimaryContract(raw);
  const ltRecords = await csvLoader.loadLiquidityData('NQ', START_DATE, END_DATE);

  console.log(`  ${candles.length.toLocaleString()} candles, ${ltRecords.length.toLocaleString()} LT records`);

  const rolloverPath = path.join(DATA_DIR, 'ohlcv', 'nq', 'NQ_rollover_log.csv');
  const rolloverDates = new Set();
  if (fs.existsSync(rolloverPath)) {
    const lines = fs.readFileSync(rolloverPath, 'utf-8').trim().split('\n').slice(1);
    for (const line of lines) {
      const [date] = line.split(',');
      const d = new Date(date);
      for (let offset = -1; offset <= 1; offset++) {
        rolloverDates.add(new Date(d.getTime() + offset * 86400000).toISOString().slice(0, 10));
      }
    }
  }

  return { candles, ltRecords, rolloverDates };
}

// ============================================================================
// DETECT TRANSITIONS & BUILD TRAJECTORIES
// ============================================================================
function buildTrajectories(candles, ltRecords, rolloverDates) {
  console.log('\nBuilding minute-by-minute trajectories...');

  const candleArray = candles;
  const candleTimestamps = candleArray.map(c => c.timestamp);

  function findCandleIndex(ts) {
    let lo = 0, hi = candleTimestamps.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (candleTimestamps[mid] < ts) lo = mid + 1;
      else hi = mid - 1;
    }
    return lo;
  }

  function getCandleAt(ts) {
    const idx = findCandleIndex(ts);
    for (let d = 0; d <= 2; d++) {
      if (idx + d < candleArray.length && Math.abs(candleArray[idx + d].timestamp - ts) <= 120000) return { candle: candleArray[idx + d], idx: idx + d };
      if (idx - d >= 0 && d > 0 && Math.abs(candleArray[idx - d].timestamp - ts) <= 120000) return { candle: candleArray[idx - d], idx: idx - d };
    }
    return null;
  }

  function getCandleState(candle, levelPrice) {
    if (levelPrice == null || isNaN(levelPrice)) return null;
    if (candle.low > levelPrice) return 'ABOVE';
    if (candle.high < levelPrice) return 'BELOW';
    return 'STRADDLE';
  }

  // Build trajectory for a trade starting at candleIdx
  function buildTrajectory(startIdx, side) {
    const entryPrice = candleArray[startIdx].close;
    const entrySymbol = candleArray[startIdx].symbol;
    const sign = side === 'buy' ? 1 : -1;

    const trajectory = []; // { bar, pnl, high, low, mfe, mae }
    let mfe = 0, mae = 0, mfeBar = 0, maeBar = 0;
    let peakPnl = 0;

    for (let bar = 1; bar <= MAX_BARS; bar++) {
      const idx = startIdx + bar;
      if (idx >= candleArray.length) break;

      const c = candleArray[idx];
      // Stop at rollover
      if (c.symbol !== entrySymbol) break;

      const pnl = (c.close - entryPrice) * sign;
      const highPnl = (side === 'buy' ? c.high - entryPrice : entryPrice - c.low);
      const lowPnl = (side === 'buy' ? c.low - entryPrice : entryPrice - c.high);

      if (highPnl > mfe) { mfe = highPnl; mfeBar = bar; }
      if (lowPnl < mae) { mae = lowPnl; maeBar = bar; }
      if (pnl > peakPnl) peakPnl = pnl;

      trajectory.push({ bar, pnl, highPnl, lowPnl, mfe, mae, peakPnl });
    }

    return { trajectory, mfe, mae, mfeBar, maeBar, entryPrice };
  }

  const LEVEL_KEYS = ['level_1', 'level_2', 'level_3', 'level_4', 'level_5'];
  const prevState = {};
  const lastEventTs = {};
  const cooldownMs = 15 * 60000;
  const events = [];

  for (let i = 1; i < ltRecords.length; i++) {
    const prevLT = ltRecords[i - 1];
    const currLT = ltRecords[i];

    if (currLT.timestamp - prevLT.timestamp > 30 * 60000) {
      for (const k of LEVEL_KEYS) prevState[k] = null;
      continue;
    }

    const currMatch = getCandleAt(currLT.timestamp);
    const prevMatch = getCandleAt(prevLT.timestamp);
    if (!currMatch || !prevMatch) continue;

    const dateStr = new Date(currLT.timestamp).toISOString().slice(0, 10);
    if (rolloverDates.has(dateStr)) continue;
    if (isRollWeek(currLT.timestamp)) continue;
    if (getSession(currLT.timestamp) === 'afterhours') continue;

    for (let li = 0; li < LEVEL_KEYS.length; li++) {
      const levelKey = LEVEL_KEYS[li];
      const prevLevel = prevLT[levelKey];
      const currLevel = currLT[levelKey];
      if (prevLevel == null || currLevel == null) continue;

      const pState = getCandleState(prevMatch.candle, prevLevel);
      const cState = getCandleState(currMatch.candle, currLevel);
      if (!pState || !cState) continue;

      if (prevState[levelKey] == null) prevState[levelKey] = pState;
      const fromState = prevState[levelKey];
      const toState = cState;
      prevState[levelKey] = toState;

      if (fromState === toState) continue;

      let side = null;
      if (fromState === 'BELOW' && toState === 'ABOVE') side = 'buy';
      else if (fromState === 'ABOVE' && toState === 'BELOW') side = 'sell';
      if (!side) continue;

      if (lastEventTs[levelKey] && (currLT.timestamp - lastEventTs[levelKey]) < cooldownMs) continue;
      lastEventTs[levelKey] = currLT.timestamp;

      // Reset all states after signal
      for (const k of LEVEL_KEYS) prevState[k] = null;

      const traj = buildTrajectory(currMatch.idx, side);
      if (traj.trajectory.length < 30) continue; // Need at least 30 bars

      events.push({
        timestamp: currLT.timestamp,
        dateStr,
        session: getSession(currLT.timestamp),
        side,
        sentiment: currLT.sentiment,
        ...traj,
      });

      break; // Only one signal per LT snapshot
    }
  }

  console.log(`  ${events.length} trade trajectories built`);
  return events;
}

// ============================================================================
// ANALYSIS: PROFIT TRAJECTORY OVER TIME
// ============================================================================
function analyzeTrajectory(events) {
  console.log('\n' + '='.repeat(100));
  console.log('SECTION 1: AVERAGE P&L TRAJECTORY (minute by minute)');
  console.log('='.repeat(100));
  console.log('How does average P&L evolve over the hold period?\n');

  const all = events;
  const winners30 = events.filter(e => e.trajectory[29]?.pnl > 0);
  const losers30 = events.filter(e => e.trajectory[29]?.pnl <= 0);

  console.log(`Total: ${all.length} | Winners@30m: ${winners30.length} (${(winners30.length/all.length*100).toFixed(1)}%) | Losers@30m: ${losers30.length}`);

  console.log(`\n  ${R('Bar',4)} | ${R('All Mean',9)} ${R('All Med',8)} | ${R('Win Mean',9)} ${R('Win Med',8)} | ${R('Los Mean',9)} ${R('Los Med',8)} | ${R('MFE Avg',8)} ${R('MAE Avg',8)}`);

  for (const checkpoint of [1, 2, 3, 5, 7, 10, 15, 20, 25, 30, 45, 60, 90, 120]) {
    const barIdx = checkpoint - 1;

    const allPnls = all.map(e => e.trajectory[barIdx]?.pnl).filter(v => v != null);
    const winPnls = winners30.map(e => e.trajectory[barIdx]?.pnl).filter(v => v != null);
    const losPnls = losers30.map(e => e.trajectory[barIdx]?.pnl).filter(v => v != null);
    const allMFE = all.map(e => e.trajectory[barIdx]?.mfe).filter(v => v != null);
    const allMAE = all.map(e => e.trajectory[barIdx]?.mae).filter(v => v != null);

    if (allPnls.length < 50) continue;

    const mean = arr => arr.reduce((s,v) => s+v, 0) / arr.length;
    const median = arr => { const s = [...arr].sort((a,b)=>a-b); return s[Math.floor(s.length/2)]; };

    console.log(`  ${R(checkpoint+'m',4)} | ${R(mean(allPnls).toFixed(1),9)} ${R(median(allPnls).toFixed(1),8)} | ${R(mean(winPnls).toFixed(1),9)} ${R(median(winPnls).toFixed(1),8)} | ${R(mean(losPnls).toFixed(1),9)} ${R(median(losPnls).toFixed(1),8)} | ${R(mean(allMFE).toFixed(1),8)} ${R(mean(allMAE).toFixed(1),8)}`);
  }
}

// ============================================================================
// ANALYSIS: TIME TO MFE / MAE
// ============================================================================
function analyzeTimingMFEMAE(events) {
  console.log('\n' + '='.repeat(100));
  console.log('SECTION 2: TIME TO PEAK PROFIT (MFE) AND WORST DRAWDOWN (MAE)');
  console.log('='.repeat(100));

  const mfeBars = events.map(e => e.mfeBar);
  const maeBars = events.map(e => e.maeBar);
  const mfePts = events.map(e => e.mfe);
  const maePts = events.map(e => e.mae);

  const mean = arr => arr.reduce((s,v)=>s+v,0)/arr.length;
  const median = arr => { const s=[...arr].sort((a,b)=>a-b); return s[Math.floor(s.length/2)]; };
  const pct = (arr, p) => { const s=[...arr].sort((a,b)=>a-b); return s[Math.floor(s.length*p)]; };

  console.log(`\nTime to MFE (when peak profit occurs within 120 bars):`);
  console.log(`  Mean:   ${mean(mfeBars).toFixed(1)} bars`);
  console.log(`  Median: ${median(mfeBars)} bars`);
  console.log(`  p25:    ${pct(mfeBars, 0.25)} bars`);
  console.log(`  p75:    ${pct(mfeBars, 0.75)} bars`);
  console.log(`  MFE amount: mean=${mean(mfePts).toFixed(1)}pts median=${median(mfePts).toFixed(1)}pts`);

  console.log(`\nTime to MAE (when worst drawdown occurs within 120 bars):`);
  console.log(`  Mean:   ${mean(maeBars).toFixed(1)} bars`);
  console.log(`  Median: ${median(maeBars)} bars`);
  console.log(`  p25:    ${pct(maeBars, 0.25)} bars`);
  console.log(`  p75:    ${pct(maeBars, 0.75)} bars`);
  console.log(`  MAE amount: mean=${mean(maePts).toFixed(1)}pts median=${median(maePts).toFixed(1)}pts`);

  // Distribution: how many trades peak before 15m, 30m, 60m?
  console.log(`\n  MFE timing distribution:`);
  for (const cutoff of [5, 10, 15, 20, 30, 45, 60, 90, 120]) {
    const count = mfeBars.filter(b => b <= cutoff).length;
    console.log(`    Peak within ${R(cutoff+'m',4)}: ${count} (${(count/events.length*100).toFixed(1)}%)`);
  }
}

// ============================================================================
// ANALYSIS: PROFIT GIVEBACK — HOW MUCH DO WINNERS LOSE?
// ============================================================================
function analyzeGiveback(events) {
  console.log('\n' + '='.repeat(100));
  console.log('SECTION 3: PROFIT GIVEBACK ANALYSIS');
  console.log('='.repeat(100));
  console.log('For winners: how much of the peak profit is captured at each exit time?\n');

  const mean = arr => arr.reduce((s,v)=>s+v,0)/arr.length;

  for (const exitBar of [15, 20, 25, 30, 45, 60, 90, 120]) {
    const valid = events.filter(e => e.trajectory.length >= exitBar);
    if (valid.length < 50) continue;

    const exitPnls = valid.map(e => e.trajectory[exitBar - 1].pnl);
    const peaksAtExit = valid.map(e => e.trajectory[exitBar - 1].peakPnl);
    const givebacks = valid.map((e, i) => peaksAtExit[i] - exitPnls[i]);
    const captureRatios = valid.map((e, i) => peaksAtExit[i] > 0 ? exitPnls[i] / peaksAtExit[i] : 0);

    const winners = valid.filter((e, i) => exitPnls[i] > 0);
    const winGivebacks = winners.map(e => {
      const t = e.trajectory[exitBar - 1];
      return t.peakPnl - t.pnl;
    });

    console.log(`  Exit at ${R(exitBar+'m',4)}: avgPnl=${R(mean(exitPnls).toFixed(1),7)} | avgPeakByThen=${R(mean(peaksAtExit).toFixed(1),7)} | avgGiveback=${R(mean(givebacks).toFixed(1),7)} | captureRatio=${(mean(captureRatios)*100).toFixed(0)}%${winners.length > 0 ? ' | winnerGiveback=' + mean(winGivebacks).toFixed(1) : ''}`);
  }
}

// ============================================================================
// ANALYSIS: TRAILING STOP SIMULATION
// ============================================================================
function analyzeTrailingStops(events) {
  console.log('\n' + '='.repeat(100));
  console.log('SECTION 4: TRAILING STOP SIMULATION');
  console.log('='.repeat(100));
  console.log('If we trail a stop N points behind the peak, what happens?\n');

  const results = [];

  for (const trailDist of TRAIL_DISTANCES) {
    let totalPnl = 0, wins = 0, losses = 0, totalBars = 0;
    const pnls = [];

    for (const event of events) {
      let peakPnl = 0;
      let exitPnl = null;
      let exitBar = 0;

      for (const t of event.trajectory) {
        if (t.highPnl > peakPnl) peakPnl = t.highPnl;

        // Trailing stop: once peak > trailDist, stop is at peak - trailDist
        // Check if lowPnl hits the stop
        if (peakPnl >= trailDist) {
          const stopLevel = peakPnl - trailDist;
          if (t.lowPnl <= stopLevel) {
            exitPnl = stopLevel; // Fill at stop level
            exitBar = t.bar;
            break;
          }
        }

        // Max hold fallback
        if (t.bar >= MAX_BARS) {
          exitPnl = t.pnl;
          exitBar = t.bar;
          break;
        }
      }

      if (exitPnl === null) {
        // Didn't exit — use last bar
        const last = event.trajectory[event.trajectory.length - 1];
        exitPnl = last?.pnl || 0;
        exitBar = last?.bar || MAX_BARS;
      }

      totalPnl += exitPnl;
      totalBars += exitBar;
      if (exitPnl > 0) wins++; else losses++;
      pnls.push(exitPnl);
    }

    const n = events.length;
    const wr = (wins / n * 100).toFixed(1);
    const avgPnl = (totalPnl / n).toFixed(1);
    const avgBars = (totalBars / n).toFixed(0);
    const pf = pnls.filter(p => p > 0).reduce((s,v)=>s+v,0) / Math.abs(pnls.filter(p => p < 0).reduce((s,v)=>s+v,0) || 1);

    results.push({ trailDist, n, wins, losses, wr, avgPnl, avgBars, totalPnl: totalPnl.toFixed(0), pf: pf.toFixed(2) });
    console.log(`  Trail ${R(trailDist+'pts',6)}: WR=${R(wr+'%',6)} PF=${R(pf.toFixed(2),5)} | AvgPnl=${R(avgPnl,7)}pts | AvgBars=${R(avgBars,4)} | TotalPnl=${R((totalPnl*20).toFixed(0),10)} ($NQ)`);
  }

  // Also test no trailing stop (pure 30m exit) for comparison
  let baseTotal = 0, baseWins = 0;
  for (const e of events) {
    const pnl = e.trajectory[29]?.pnl || 0;
    baseTotal += pnl;
    if (pnl > 0) baseWins++;
  }
  console.log(`\n  Baseline (30m exit, no trail): WR=${(baseWins/events.length*100).toFixed(1)}% | AvgPnl=${(baseTotal/events.length).toFixed(1)}pts | TotalPnl=${(baseTotal*20).toFixed(0)} ($NQ)`);

  // And pure 120m exit
  let base120 = 0, wins120 = 0;
  for (const e of events) {
    const last = e.trajectory[Math.min(119, e.trajectory.length-1)];
    const pnl = last?.pnl || 0;
    base120 += pnl;
    if (pnl > 0) wins120++;
  }
  console.log(`  Baseline (120m exit, no trail): WR=${(wins120/events.length*100).toFixed(1)}% | AvgPnl=${(base120/events.length).toFixed(1)}pts | TotalPnl=${(base120*20).toFixed(0)} ($NQ)`);
}

// ============================================================================
// ANALYSIS: TIME-BASED RATCHET (BE stop after N mins in profit)
// ============================================================================
function analyzeTimeRatchet(events) {
  console.log('\n' + '='.repeat(100));
  console.log('SECTION 5: TIME-BASED RATCHET (move stop to BE after conditions met)');
  console.log('='.repeat(100));
  console.log('Move stop to breakeven after trade is +N pts for M consecutive minutes.\n');

  console.log(`  ${R('Trigger',8)} ${R('MinBars',8)} | ${R('WR',6)} ${R('PF',6)} | ${R('AvgPnl',8)} ${R('AvgBars',8)} | ${R('TotalPnl($NQ)',15)}`);

  for (const triggerPts of BE_TRIGGER_PROFIT) {
    for (const minBars of [1, 3, 5]) {
      let totalPnl = 0, wins = 0, totalBars = 0;
      const pnls = [];

      for (const event of events) {
        let barsInProfit = 0;
        let beActive = false;
        let exitPnl = null;
        let exitBar = 0;
        let peakPnl = 0;

        for (const t of event.trajectory) {
          if (t.pnl >= triggerPts) barsInProfit++;
          else barsInProfit = 0;

          if (!beActive && barsInProfit >= minBars) {
            beActive = true;
          }

          if (t.highPnl > peakPnl) peakPnl = t.highPnl;

          // BE stop: if active and price returns to entry (pnl <= 0)
          if (beActive && t.lowPnl <= 0) {
            exitPnl = 0; // Breakeven
            exitBar = t.bar;
            break;
          }

          if (t.bar >= MAX_BARS) {
            exitPnl = t.pnl;
            exitBar = t.bar;
            break;
          }
        }

        if (exitPnl === null) {
          const last = event.trajectory[event.trajectory.length - 1];
          exitPnl = last?.pnl || 0;
          exitBar = last?.bar || MAX_BARS;
        }

        totalPnl += exitPnl;
        totalBars += exitBar;
        if (exitPnl > 0) wins++;
        pnls.push(exitPnl);
      }

      const n = events.length;
      const pf = pnls.filter(p=>p>0).reduce((s,v)=>s+v,0) / Math.abs(pnls.filter(p=>p<0).reduce((s,v)=>s+v,0) || 1);

      console.log(`  ${R(triggerPts+'pts',8)} ${R(minBars+'bars',8)} | ${R((wins/n*100).toFixed(1)+'%',6)} ${R(pf.toFixed(2),6)} | ${R((totalPnl/n).toFixed(1),8)} ${R((totalBars/n).toFixed(0),8)} | ${R((totalPnl*20).toFixed(0),15)}`);
    }
  }
}

// ============================================================================
// ANALYSIS: COMBINED RATCHET (BE + trailing after peak)
// ============================================================================
function analyzeCombinedRatchet(events) {
  console.log('\n' + '='.repeat(100));
  console.log('SECTION 6: COMBINED RATCHET (BE trigger + trailing stop)');
  console.log('='.repeat(100));
  console.log('Phase 1: Move stop to BE when +N pts. Phase 2: Trail M pts behind peak.\n');

  const beTriggers = [5, 8, 10, 15, 20];
  const trailStarts = [15, 20, 25, 30]; // Start trailing after this many pts of MFE
  const trailDists = [8, 10, 12, 15, 20];

  const results = [];

  for (const beTrigger of beTriggers) {
    for (const trailStart of trailStarts) {
      for (const trailDist of trailDists) {
        if (trailDist >= trailStart) continue; // Trail must be tighter than start

        let totalPnl = 0, wins = 0, totalBars = 0;
        const pnls = [];

        for (const event of events) {
          let beActive = false;
          let trailActive = false;
          let peakPnl = 0;
          let exitPnl = null;

          for (const t of event.trajectory) {
            if (t.highPnl > peakPnl) peakPnl = t.highPnl;

            // Phase 1: Activate BE
            if (!beActive && t.pnl >= beTrigger) beActive = true;

            // Phase 2: Activate trail
            if (!trailActive && peakPnl >= trailStart) trailActive = true;

            // Check exits
            if (trailActive) {
              const stopLevel = peakPnl - trailDist;
              if (t.lowPnl <= stopLevel) {
                exitPnl = Math.max(stopLevel, 0); // Never worse than BE once BE is active
                break;
              }
            } else if (beActive) {
              if (t.lowPnl <= 0) {
                exitPnl = 0;
                break;
              }
            }

            if (t.bar >= MAX_BARS) {
              exitPnl = t.pnl;
              break;
            }
          }

          if (exitPnl === null) {
            const last = event.trajectory[event.trajectory.length - 1];
            exitPnl = last?.pnl || 0;
          }

          totalPnl += exitPnl;
          if (exitPnl > 0) wins++;
          pnls.push(exitPnl);
        }

        const n = events.length;
        const pf = pnls.filter(p=>p>0).reduce((s,v)=>s+v,0) / Math.abs(pnls.filter(p=>p<0).reduce((s,v)=>s+v,0) || 1);
        const avgPnl = totalPnl / n;

        results.push({ beTrigger, trailStart, trailDist, wr: wins/n, pf, avgPnl, totalPnl });
      }
    }
  }

  // Sort by total PnL descending
  results.sort((a, b) => b.totalPnl - a.totalPnl);

  console.log(`  ${R('BE@',5)} ${R('Trail@',7)} ${R('TrailD',7)} | ${R('WR',6)} ${R('PF',6)} | ${R('AvgPnl',8)} | ${R('Total($NQ)',12)}`);
  console.log('  ' + '-'.repeat(80));

  for (const r of results.slice(0, 30)) {
    console.log(`  ${R(r.beTrigger+'pts',5)} ${R(r.trailStart+'pts',7)} ${R(r.trailDist+'pts',7)} | ${R((r.wr*100).toFixed(1)+'%',6)} ${R(r.pf.toFixed(2),6)} | ${R(r.avgPnl.toFixed(1),8)} | ${R((r.totalPnl*20).toFixed(0),12)}`);
  }
}

// ============================================================================
// ANALYSIS: RETURN-TO-ENTRY PROBABILITY
// ============================================================================
function analyzeReturnToEntry(events) {
  console.log('\n' + '='.repeat(100));
  console.log('SECTION 7: RETURN-TO-ENTRY PROBABILITY');
  console.log('='.repeat(100));
  console.log('Once a trade reaches +N pts of profit, how often does price return to entry?\n');

  const thresholds = [3, 5, 8, 10, 15, 20, 25, 30, 40, 50];

  for (const threshold of thresholds) {
    let reached = 0, returnedToEntry = 0, returnedToHalf = 0;

    for (const event of events) {
      let hitThreshold = false;
      for (const t of event.trajectory) {
        if (!hitThreshold && t.highPnl >= threshold) {
          hitThreshold = true;
        }
        if (hitThreshold) {
          if (t.lowPnl <= 0) { returnedToEntry++; break; }
          if (t.lowPnl <= threshold / 2) { returnedToHalf++; }
        }
      }
      if (hitThreshold) reached++;
    }

    if (reached < 20) continue;
    console.log(`  After +${R(threshold+'pts',5)}: ${reached} trades reached it | ${returnedToEntry} returned to entry (${(returnedToEntry/reached*100).toFixed(1)}%) | ${returnedToHalf} gave back half (${(returnedToHalf/reached*100).toFixed(1)}%)`);
  }
}

// ============================================================================
// MAIN
// ============================================================================
async function main() {
  console.log('LT Candle Regime — Profit Trajectory & Exit Optimization');
  console.log('='.repeat(60));

  const { candles, ltRecords, rolloverDates } = await loadData();
  const events = buildTrajectories(candles, ltRecords, rolloverDates);

  analyzeTrajectory(events);
  analyzeTimingMFEMAE(events);
  analyzeGiveback(events);
  analyzeTrailingStops(events);
  analyzeTimeRatchet(events);
  analyzeCombinedRatchet(events);
  analyzeReturnToEntry(events);

  console.log('\nDone.');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
