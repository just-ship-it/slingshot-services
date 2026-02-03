#!/usr/bin/env node

/**
 * GEX Level Price Behavior Analysis
 *
 * Analyzes how price behaves when it touches GEX support/resistance levels
 * using 1-second resolution data for accurate measurement.
 *
 * Key metrics:
 * - Max Favorable Excursion (MFE): How far price moves in the expected direction
 * - Max Adverse Excursion (MAE): How far price moves against before reversing
 * - Win rate at various target distances
 * - Time to reversal
 * - Optimal stop/target distances based on actual price action
 *
 * Usage:
 *   node scripts/analyze-gex-price-behavior.js [options]
 *
 * Options:
 *   --start <date>     Start date (default: 2025-01-01)
 *   --end <date>       End date (default: 2025-12-31)
 *   --output <file>    Output JSON file
 *   --verbose          Show detailed progress
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');

// Configuration
const CONFIG = {
  proximityThreshold: 5,     // Points to consider "touching" a level
  trackingWindowSeconds: 300, // 5 minutes of tracking after touch
  trackingWindowBars: 300,   // Max bars to track (5 min at 1s)
  levelTypes: ['support_1', 'support_2', 'resistance_1', 'resistance_2', 'gamma_flip']
};

// Parse arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    startDate: '2025-01-01',
    endDate: '2025-12-31',
    outputFile: path.join(projectRoot, 'results', 'gex-price-behavior-analysis.json'),
    verbose: false
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--start' && args[i + 1]) config.startDate = args[++i];
    else if (args[i] === '--end' && args[i + 1]) config.endDate = args[++i];
    else if (args[i] === '--output' && args[i + 1]) config.outputFile = args[++i];
    else if (args[i] === '--verbose' || args[i] === '-v') config.verbose = true;
    else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`
GEX Level Price Behavior Analysis

Analyzes price behavior around GEX levels using 1-second data.

Usage:
  node scripts/analyze-gex-price-behavior.js [options]

Options:
  --start <date>   Start date YYYY-MM-DD (default: 2025-01-01)
  --end <date>     End date YYYY-MM-DD (default: 2025-12-31)
  --output <file>  Output JSON file
  --verbose, -v    Show detailed progress
  --help, -h       Show this help
`);
      process.exit(0);
    }
  }

  return config;
}

// Load GEX levels from JSON files
function loadGexLevels(startDate, endDate) {
  const gexDir = path.join(projectRoot, 'data', 'gex');
  const levels = new Map(); // timestamp -> { support: [], resistance: [], gamma_flip }

  const start = new Date(startDate);
  const end = new Date(endDate);

  // Iterate through dates
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const dateStr = d.toISOString().split('T')[0];
    const filePath = path.join(gexDir, `nq_gex_${dateStr}.json`);

    if (!fs.existsSync(filePath)) continue;

    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

      for (const snapshot of data.data) {
        const ts = new Date(snapshot.timestamp).getTime();
        levels.set(ts, {
          support: snapshot.support || [],
          resistance: snapshot.resistance || [],
          gamma_flip: snapshot.gamma_flip,
          put_wall: snapshot.put_wall,
          call_wall: snapshot.call_wall,
          regime: snapshot.regime
        });
      }
    } catch (err) {
      // Skip invalid files
    }
  }

  return levels;
}

// Get active GEX levels for a given timestamp
function getActiveLevels(gexLevels, timestamp) {
  // Find the most recent GEX snapshot before this timestamp
  let activeSnapshot = null;
  let closestTime = 0;

  for (const [ts, snapshot] of gexLevels) {
    if (ts <= timestamp && ts > closestTime) {
      closestTime = ts;
      activeSnapshot = snapshot;
    }
  }

  if (!activeSnapshot) return null;

  // Build level objects
  const result = [];

  // Support levels (expect bounce UP)
  if (activeSnapshot.support) {
    activeSnapshot.support.forEach((price, i) => {
      result.push({
        type: `support_${i + 1}`,
        price,
        expectedDirection: 'up',
        regime: activeSnapshot.regime
      });
    });
  }

  // Resistance levels (expect bounce DOWN)
  if (activeSnapshot.resistance) {
    activeSnapshot.resistance.forEach((price, i) => {
      result.push({
        type: `resistance_${i + 1}`,
        price,
        expectedDirection: 'down',
        regime: activeSnapshot.regime
      });
    });
  }

  // Gamma flip (direction depends on approach)
  if (activeSnapshot.gamma_flip) {
    result.push({
      type: 'gamma_flip',
      price: activeSnapshot.gamma_flip,
      expectedDirection: 'reversal', // Special case
      regime: activeSnapshot.regime
    });
  }

  return result;
}

// Check if price is touching a level
function isTouchingLevel(price, level, threshold) {
  return Math.abs(price - level.price) <= threshold;
}

// Track price movement after a level touch
class TouchEvent {
  constructor(level, entryPrice, entryTime, side) {
    this.level = level;
    this.entryPrice = entryPrice;
    this.entryTime = entryTime;
    this.side = side; // 'long' for support touch, 'short' for resistance touch

    this.highWaterMark = entryPrice;
    this.lowWaterMark = entryPrice;
    this.bars = [];
    this.exitTime = null;
    this.exitPrice = null;
  }

  addBar(bar) {
    this.bars.push(bar);
    if (bar.high > this.highWaterMark) this.highWaterMark = bar.high;
    if (bar.low < this.lowWaterMark) this.lowWaterMark = bar.low;
  }

  getMFE() {
    // Max Favorable Excursion
    if (this.side === 'long') {
      return this.highWaterMark - this.entryPrice;
    } else {
      return this.entryPrice - this.lowWaterMark;
    }
  }

  getMAE() {
    // Max Adverse Excursion
    if (this.side === 'long') {
      return this.entryPrice - this.lowWaterMark;
    } else {
      return this.highWaterMark - this.entryPrice;
    }
  }

  getResult(targetPoints, stopPoints) {
    // Determine if this touch would have been profitable
    const mfe = this.getMFE();
    const mae = this.getMAE();

    if (mae >= stopPoints) return 'stop';
    if (mfe >= targetPoints) return 'target';
    return 'timeout';
  }
}

// Main analysis
async function analyzeGexBehavior(config) {
  console.log('═'.repeat(70));
  console.log('  GEX LEVEL PRICE BEHAVIOR ANALYSIS');
  console.log('═'.repeat(70));
  console.log();

  // Load GEX levels
  console.log('Loading GEX levels...');
  const gexLevels = loadGexLevels(config.startDate, config.endDate);
  console.log(`Loaded ${gexLevels.size} GEX snapshots`);
  console.log();

  // Prepare 1-second data path
  const secondDataPath = path.join(projectRoot, 'data', 'ohlcv', 'NQ_ohlcv_1s.csv');
  if (!fs.existsSync(secondDataPath)) {
    console.error('1-second data file not found:', secondDataPath);
    process.exit(1);
  }

  // Parse date range
  const startTime = new Date(config.startDate).getTime();
  const endTime = new Date(config.endDate + 'T23:59:59').getTime();

  // Statistics collection
  const touchEvents = [];
  const levelStats = {};
  for (const lt of CONFIG.levelTypes) {
    levelStats[lt] = {
      touches: 0,
      mfeSum: 0,
      maeSum: 0,
      mfeValues: [],
      maeValues: [],
      winRates: {} // target -> win rate
    };
  }

  // Active touch tracking
  const activeTouches = new Map(); // levelKey -> TouchEvent
  const cooldowns = new Map(); // levelKey -> timestamp (prevent double-counting)
  const COOLDOWN_MS = 60000; // 1 minute cooldown after a touch

  console.log('Streaming 1-second data...');
  console.log(`Date range: ${config.startDate} to ${config.endDate}`);
  console.log('(Filtering to primary contract only - excluding back-month quotes)');
  console.log();

  let linesProcessed = 0;
  let linesFiltered = 0;
  let touchCount = 0;
  let lastProgressTime = Date.now();

  // Buffer for collecting candles per minute to determine primary contract
  let currentMinute = null;
  let minuteBuffer = []; // All candles in current minute
  let minuteVolumeBySymbol = new Map(); // symbol -> total volume this minute

  // Helper to process a completed minute's data - returns filtered bars for primary contract only
  function processMinuteBuffer() {
    if (minuteBuffer.length === 0) return [];

    // Find the primary contract (highest volume) for this minute
    let primarySymbol = null;
    let maxVolume = 0;
    for (const [symbol, volume] of minuteVolumeBySymbol) {
      if (volume > maxVolume) {
        maxVolume = volume;
        primarySymbol = symbol;
      }
    }

    // Filter to only primary contract candles
    const filteredBars = minuteBuffer.filter(bar => bar.symbol === primarySymbol);
    linesFiltered += minuteBuffer.length - filteredBars.length;

    return filteredBars;
  }

  // Helper to process filtered bars for GEX level touches
  function processBarsForTouches(bars) {
    for (const bar of bars) {
      // Get active GEX levels
      const levels = getActiveLevels(gexLevels, bar.timestamp);
      if (!levels) continue;

      // Update active touches
      for (const [key, touch] of activeTouches) {
        touch.addBar(bar);

        // Complete touch after tracking window
        if (touch.bars.length >= CONFIG.trackingWindowBars) {
          touchEvents.push(touch);
          activeTouches.delete(key);
        }
      }

      // Check for new level touches
      for (const level of levels) {
        // Only track S1, S2, R1, R2, gamma_flip for now
        if (!CONFIG.levelTypes.includes(level.type)) continue;

        const levelKey = `${level.type}_${Math.round(level.price)}`;

        // Check cooldown
        const lastTouch = cooldowns.get(levelKey);
        if (lastTouch && bar.timestamp - lastTouch < COOLDOWN_MS) continue;

        // Check if already tracking this level
        if (activeTouches.has(levelKey)) continue;

        // Check if price is touching the level
        if (isTouchingLevel(bar.close, level, CONFIG.proximityThreshold)) {
          const side = level.expectedDirection === 'up' ? 'long' :
                       level.expectedDirection === 'down' ? 'short' :
                       (bar.close > level.price ? 'short' : 'long');

          const touch = new TouchEvent(level, bar.close, bar.timestamp, side);
          activeTouches.set(levelKey, touch);
          cooldowns.set(levelKey, bar.timestamp);
          touchCount++;

          if (config.verbose) {
            console.log(`  Touch: ${level.type} @ ${level.price.toFixed(2)}, price=${bar.close}`);
          }
        }
      }
    }
  }

  await new Promise((resolve, reject) => {
    const fileStream = fs.createReadStream(secondDataPath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });

    let isHeader = true;

    rl.on('line', (line) => {
      if (isHeader) {
        isHeader = false;
        return;
      }

      linesProcessed++;

      // Progress update every 10 seconds
      if (Date.now() - lastProgressTime > 10000) {
        console.log(`  Processed ${(linesProcessed / 1000000).toFixed(1)}M lines, ${touchCount} touches found, ${linesFiltered} back-month bars filtered...`);
        lastProgressTime = Date.now();
      }

      // Parse line
      const parts = line.split(',');
      if (parts.length < 10) return;

      const timestamp = new Date(parts[0]).getTime();

      // Skip if outside date range
      if (timestamp < startTime || timestamp > endTime) return;

      // Skip calendar spreads (symbols with '-')
      const symbol = parts[9];
      if (symbol && symbol.includes('-')) return;

      const bar = {
        timestamp,
        symbol,
        open: parseFloat(parts[4]),
        high: parseFloat(parts[5]),
        low: parseFloat(parts[6]),
        close: parseFloat(parts[7]),
        volume: parseFloat(parts[8])
      };

      // Determine which minute this bar belongs to
      const minuteTs = Math.floor(timestamp / 60000) * 60000;

      // If we've moved to a new minute, process the previous minute's buffer
      if (currentMinute !== null && minuteTs !== currentMinute) {
        const filteredBars = processMinuteBuffer();
        processBarsForTouches(filteredBars);

        // Reset buffer for new minute
        minuteBuffer = [];
        minuteVolumeBySymbol.clear();
      }

      currentMinute = minuteTs;

      // Add bar to buffer
      minuteBuffer.push(bar);
      minuteVolumeBySymbol.set(symbol, (minuteVolumeBySymbol.get(symbol) || 0) + bar.volume);
    });

    rl.on('close', () => {
      // Process final minute buffer
      if (minuteBuffer.length > 0) {
        const filteredBars = processMinuteBuffer();
        processBarsForTouches(filteredBars);
      }

      // Complete any remaining active touches
      for (const [key, touch] of activeTouches) {
        if (touch.bars.length > 0) {
          touchEvents.push(touch);
        }
      }
      resolve();
    });

    rl.on('error', reject);
    fileStream.on('error', reject);
  });

  console.log(`\nProcessed ${(linesProcessed / 1000000).toFixed(1)}M lines`);
  console.log(`Filtered out ${linesFiltered} back-month contract bars`);
  console.log(`Found ${touchEvents.length} level touch events`);
  console.log();

  // Analyze touch events
  console.log('═'.repeat(70));
  console.log('  ANALYSIS RESULTS');
  console.log('═'.repeat(70));
  console.log();

  // Calculate statistics per level type
  for (const touch of touchEvents) {
    const lt = touch.level.type;
    if (!levelStats[lt]) continue;

    const stats = levelStats[lt];
    const mfe = touch.getMFE();
    const mae = touch.getMAE();

    stats.touches++;
    stats.mfeSum += mfe;
    stats.maeSum += mae;
    stats.mfeValues.push(mfe);
    stats.maeValues.push(mae);
  }

  // Display MFE/MAE statistics
  console.log('┌─ MFE/MAE STATISTICS BY LEVEL TYPE ─────────────────────────────────┐');
  console.log('│ Level Type    │ Touches │ Avg MFE │ Avg MAE │ Med MFE │ Med MAE  │');
  console.log('├───────────────┼─────────┼─────────┼─────────┼─────────┼──────────┤');

  for (const [lt, stats] of Object.entries(levelStats)) {
    if (stats.touches === 0) continue;

    const avgMfe = stats.mfeSum / stats.touches;
    const avgMae = stats.maeSum / stats.touches;

    // Calculate medians
    stats.mfeValues.sort((a, b) => a - b);
    stats.maeValues.sort((a, b) => a - b);
    const medMfe = stats.mfeValues[Math.floor(stats.mfeValues.length / 2)] || 0;
    const medMae = stats.maeValues[Math.floor(stats.maeValues.length / 2)] || 0;

    console.log(
      '│ ' + lt.padEnd(13) + ' │ ' +
      stats.touches.toString().padStart(7) + ' │ ' +
      avgMfe.toFixed(2).padStart(7) + ' │ ' +
      avgMae.toFixed(2).padStart(7) + ' │ ' +
      medMfe.toFixed(2).padStart(7) + ' │ ' +
      medMae.toFixed(2).padStart(8) + ' │'
    );
  }
  console.log('└───────────────┴─────────┴─────────┴─────────┴─────────┴──────────┘');
  console.log();

  // SYMMETRIC ANALYSIS: Does price move X points in expected direction before X points against?
  // This answers: "At level touch, what's the probability of gaining N pts before losing N pts?"
  const symmetricPts = [15, 20, 25, 30, 35, 40, 45, 50];

  // Also run asymmetric for optimization
  const targets = [15, 20, 25, 30, 40, 50, 60, 75];
  const stops = [20, 25, 30, 35, 40, 45, 50];

  console.log('┌─ SYMMETRIC ANALYSIS: Win % at Equal Target/Stop ─────────────────────────────┐');
  console.log('│ "If price touches level, what % hit +Xpt before -Xpt?"                       │');
  console.log('├───────────────┬────────┬────────┬────────┬────────┬────────┬────────┬────────┤');
  console.log('│ Level Type    │  15pt  │  20pt  │  25pt  │  30pt  │  35pt  │  40pt  │  50pt  │');
  console.log('├───────────────┼────────┼────────┼────────┼────────┼────────┼────────┼────────┤');

  const s1Touches = touchEvents.filter(t => t.level.type === 'support_1');
  const r1Touches = touchEvents.filter(t => t.level.type === 'resistance_1');
  const s2Touches = touchEvents.filter(t => t.level.type === 'support_2');
  const r2Touches = touchEvents.filter(t => t.level.type === 'resistance_2');
  const gfTouches = touchEvents.filter(t => t.level.type === 'gamma_flip');

  // Helper function for symmetric win rate
  function getSymmetricWinRate(touches, pts) {
    let wins = 0;
    let losses = 0;
    for (const touch of touches) {
      const mfe = touch.getMFE();
      const mae = touch.getMAE();
      // Which happened first? We need to check which threshold was hit first
      // MFE/MAE are maximums over the window, so we check if target hit before stop
      if (mfe >= pts && mae < pts) {
        wins++; // Hit target, never hit stop
      } else if (mae >= pts && mfe < pts) {
        losses++; // Hit stop, never hit target
      } else if (mfe >= pts && mae >= pts) {
        // Both thresholds were exceeded - need to determine which came first
        // Use the price path from the touch event
        const path = touch.pricePath || [];
        let hitTarget = false;
        let hitStop = false;
        for (const p of path) {
          if (!hitTarget && !hitStop) {
            if (p.mfe >= pts) hitTarget = true;
            if (p.mae >= pts) hitStop = true;
          }
        }
        if (hitTarget && !hitStop) wins++;
        else if (hitStop && !hitTarget) losses++;
        else {
          // Can't determine from path, use heuristic: if MFE > MAE, likely won
          if (mfe > mae) wins++;
          else losses++;
        }
      }
      // else neither threshold hit = no decision
    }
    const decided = wins + losses;
    return decided > 0 ? (wins / decided * 100).toFixed(1) : 'N/A';
  }

  // Print symmetric analysis for each level type
  for (const [name, touches] of [
    ['S1 (Long)', s1Touches],
    ['R1 (Short)', r1Touches],
    ['S2 (Long)', s2Touches],
    ['R2 (Short)', r2Touches],
    ['Gamma Flip', gfTouches]
  ]) {
    if (touches.length === 0) continue;
    let row = '│ ' + name.padEnd(13) + ' │';
    for (const pts of [15, 20, 25, 30, 35, 40, 50]) {
      const winRate = getSymmetricWinRate(touches, pts);
      row += ` ${winRate.padStart(5)}% │`;
    }
    console.log(row);
  }
  console.log('├───────────────┴────────┴────────┴────────┴────────┴────────┴────────┴────────┤');
  console.log('│ >50% = edge exists (price more likely to move in expected direction)        │');
  console.log('└──────────────────────────────────────────────────────────────────────────────┘');
  console.log();

  // Also show detailed asymmetric matrix for optimization
  console.log('┌─ ASYMMETRIC MATRIX (Support 1 - S1 Longs) ───────────────────────────────────────────────┐');
  console.log('│ Target \\ Stop │   20pt │   25pt │   30pt │   35pt │   40pt │   45pt │   50pt │');
  console.log('├───────────────┼────────┼────────┼────────┼────────┼────────┼────────┼────────┤');

  for (const target of [15, 20, 25, 30, 40, 50]) {
    let row = '│ ' + `${target}pt`.padStart(13) + ' │';

    for (const stop of [20, 25, 30, 35, 40, 45, 50]) {
      let wins = 0;
      let total = 0;

      for (const touch of s1Touches) {
        const mfe = touch.getMFE();
        const mae = touch.getMAE();

        // Determine outcome
        total++;
        if (mae >= stop) {
          // Stopped out
        } else if (mfe >= target) {
          wins++;
        }
        // Else timeout (neither hit)
      }

      const winRate = total > 0 ? (wins / total * 100).toFixed(1) : 'N/A';
      row += ` ${winRate.padStart(5)}% │`;
    }

    console.log(row);
  }
  console.log('└───────────────┴────────┴────────┴────────┴────────┴────────┴────────┴────────┘');
  console.log();

  // Same for Resistance 1
  console.log('┌─ ASYMMETRIC MATRIX (Resistance 1 - R1 Shorts) ───────────────────────────────────────────┐');
  console.log('│ Target \\ Stop │   20pt │   25pt │   30pt │   35pt │   40pt │   45pt │   50pt │');
  console.log('├───────────────┼────────┼────────┼────────┼────────┼────────┼────────┼────────┤');

  for (const target of [15, 20, 25, 30, 40, 50]) {
    let row = '│ ' + `${target}pt`.padStart(13) + ' │';

    for (const stop of [20, 25, 30, 35, 40, 45, 50]) {
      let wins = 0;
      let total = 0;

      for (const touch of r1Touches) {
        const mfe = touch.getMFE();
        const mae = touch.getMAE();

        total++;
        if (mae >= stop) {
          // Stopped out
        } else if (mfe >= target) {
          wins++;
        }
      }

      const winRate = total > 0 ? (wins / total * 100).toFixed(1) : 'N/A';
      row += ` ${winRate.padStart(6)}% │`;
    }

    console.log(row);
  }
  console.log('└───────────────┴────────┴────────┴────────┴────────┴────────┴────────┴────────┘');
  console.log();

  // MFE/MAE distribution analysis
  console.log('═'.repeat(70));
  console.log('  MFE DISTRIBUTION (How far does price move in your favor?)');
  console.log('═'.repeat(70));
  console.log();

  for (const lt of ['support_1', 'resistance_1']) {
    const touches = touchEvents.filter(t => t.level.type === lt);
    if (touches.length === 0) continue;

    console.log(`${lt.toUpperCase()} (${touches.length} touches):`);

    const buckets = [10, 15, 20, 25, 30, 40, 50, 60, 75, 100];
    for (const threshold of buckets) {
      const count = touches.filter(t => t.getMFE() >= threshold).length;
      const pct = (count / touches.length * 100).toFixed(1);
      const bar = '█'.repeat(Math.round(pct / 2));
      console.log(`  >= ${threshold.toString().padStart(3)}pt: ${pct.padStart(5)}% ${bar}`);
    }
    console.log();
  }

  // MAE distribution
  console.log('═'.repeat(70));
  console.log('  MAE DISTRIBUTION (How far does price move against you?)');
  console.log('═'.repeat(70));
  console.log();

  for (const lt of ['support_1', 'resistance_1']) {
    const touches = touchEvents.filter(t => t.level.type === lt);
    if (touches.length === 0) continue;

    console.log(`${lt.toUpperCase()} (${touches.length} touches):`);

    const buckets = [10, 15, 20, 25, 30, 35, 40, 45, 50, 60];
    for (const threshold of buckets) {
      const count = touches.filter(t => t.getMAE() < threshold).length;
      const pct = (count / touches.length * 100).toFixed(1);
      const bar = '█'.repeat(Math.round(pct / 2));
      console.log(`  < ${threshold.toString().padStart(3)}pt: ${pct.padStart(5)}% ${bar}`);
    }
    console.log();
  }

  // Optimal configuration analysis
  console.log('═'.repeat(70));
  console.log('  OPTIMAL CONFIGURATION ANALYSIS');
  console.log('═'.repeat(70));
  console.log();

  // Find best target/stop combinations
  const results = [];

  for (const lt of ['support_1', 'resistance_1']) {
    const touches = touchEvents.filter(t => t.level.type === lt);
    if (touches.length === 0) continue;

    for (const target of targets) {
      for (const stop of stops) {
        let wins = 0;
        let losses = 0;
        let timeouts = 0;
        let pnl = 0;

        for (const touch of touches) {
          const mfe = touch.getMFE();
          const mae = touch.getMAE();

          if (mae >= stop) {
            losses++;
            pnl -= stop;
          } else if (mfe >= target) {
            wins++;
            pnl += target;
          } else {
            timeouts++;
            // No P&L for timeouts (would need trailing stop logic)
          }
        }

        const total = wins + losses + timeouts;
        const winRate = total > 0 ? wins / total * 100 : 0;
        const expectancy = total > 0 ? pnl / total : 0;

        results.push({
          levelType: lt,
          target,
          stop,
          wins,
          losses,
          timeouts,
          winRate,
          pnl,
          expectancy
        });
      }
    }
  }

  // Sort by expectancy
  results.sort((a, b) => b.expectancy - a.expectancy);

  console.log('Top 15 configurations by expectancy (points per trade):');
  console.log('─'.repeat(70));
  console.log('Rank | Level Type   | Target | Stop | Win%  | Expectancy | Total P&L');
  console.log('─'.repeat(70));

  results.slice(0, 15).forEach((r, i) => {
    console.log(
      `${(i + 1).toString().padStart(4)} | ${r.levelType.padEnd(12)} | ` +
      `${r.target.toString().padStart(6)} | ${r.stop.toString().padStart(4)} | ` +
      `${r.winRate.toFixed(1).padStart(5)}% | ` +
      `${r.expectancy.toFixed(2).padStart(10)} | ` +
      `${r.pnl.toFixed(0).padStart(9)}`
    );
  });

  console.log();

  // Save detailed results
  const output = {
    config,
    summary: {
      totalTouches: touchEvents.length,
      dateRange: { start: config.startDate, end: config.endDate },
      levelStats: Object.fromEntries(
        Object.entries(levelStats).map(([k, v]) => [k, {
          touches: v.touches,
          avgMfe: v.touches > 0 ? v.mfeSum / v.touches : 0,
          avgMae: v.touches > 0 ? v.maeSum / v.touches : 0
        }])
      )
    },
    configurations: results,
    mfeDistribution: {},
    maeDistribution: {}
  };

  // Add distributions
  for (const lt of ['support_1', 'resistance_1']) {
    const touches = touchEvents.filter(t => t.level.type === lt);
    output.mfeDistribution[lt] = touches.map(t => t.getMFE());
    output.maeDistribution[lt] = touches.map(t => t.getMAE());
  }

  fs.writeFileSync(config.outputFile, JSON.stringify(output, null, 2));
  console.log(`Detailed results saved to: ${config.outputFile}`);

  console.log();
  console.log('═'.repeat(70));
  console.log('  ANALYSIS COMPLETE');
  console.log('═'.repeat(70));
}

// Run
const config = parseArgs();
analyzeGexBehavior(config).catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
