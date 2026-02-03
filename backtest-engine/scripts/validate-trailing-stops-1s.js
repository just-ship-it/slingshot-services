#!/usr/bin/env node

/**
 * Trailing Stop Validation Script (1-Second Resolution)
 *
 * Uses 1-second OHLCV data to definitively resolve ambiguous trailing stop trades.
 * Streams the large 1s data file to avoid memory issues.
 *
 * Usage:
 *   node scripts/validate-trailing-stops-1s.js --results ./results/gex-scalper-latest.json
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    resultsFile: './results/gex-scalper-latest.json',
    dataDir: path.join(__dirname, '..', 'data'),
    verbose: false
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--results' && args[i + 1]) {
      config.resultsFile = args[++i];
    } else if (args[i] === '--data-dir' && args[i + 1]) {
      config.dataDir = args[++i];
    } else if (args[i] === '--verbose' || args[i] === '-v') {
      config.verbose = true;
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`
Trailing Stop Validation Script (1-Second Resolution)

Validates ambiguous trailing stop exits using 1-second data.

Usage:
  node scripts/validate-trailing-stops-1s.js [options]

Options:
  --results <path>   Path to backtest results JSON (default: ./results/gex-scalper-latest.json)
  --data-dir <path>  Path to data directory (default: ./data)
  --verbose, -v      Show detailed output for each trade
  --help, -h         Show this help message
`);
      process.exit(0);
    }
  }

  return config;
}

// Identify ambiguous trades from results
function identifyAmbiguousTrades(trades) {
  const ambiguous = [];

  for (const t of trades) {
    if (t.exitReason !== 'trailing_stop' || !t.trailingStop?.triggered) continue;

    const entry = t.actualEntry;
    const side = t.side;
    const trigger = side === 'buy' ? entry + t.trailingTrigger : entry - t.trailingTrigger;
    const stop = t.stopLoss;
    const candle = t.entryCandle;

    if (!candle) continue;

    // Check if entry candle spans both trigger and stop
    let triggerable, stoppable;
    if (side === 'buy') {
      triggerable = candle.high >= trigger;
      stoppable = candle.low <= stop;
    } else {
      triggerable = candle.low <= trigger;
      stoppable = candle.high >= stop;
    }

    if (triggerable && stoppable) {
      ambiguous.push({
        trade: t,
        entryMinute: t.entryTime, // Timestamp of entry candle (minute resolution)
        entry,
        side,
        trigger,
        stop,
        entrySymbol: candle.symbol
      });
    }
  }

  return ambiguous;
}

// Build a map of minute timestamps we need to analyze
function buildMinuteMap(ambiguousTrades) {
  const minuteMap = new Map(); // minute timestamp -> array of trades needing that minute

  for (const at of ambiguousTrades) {
    const minuteTs = at.entryMinute;
    if (!minuteMap.has(minuteTs)) {
      minuteMap.set(minuteTs, []);
    }
    minuteMap.get(minuteTs).push(at);
  }

  return minuteMap;
}

// Validate a trade using 1-second bars
function validateTradeWith1sData(ambiguousTrade, secondBars) {
  const { trade, entry, side, trigger, stop, entrySymbol } = ambiguousTrade;

  // Filter to matching symbol (or use all if no exact match)
  let bars = secondBars.filter(b => b.symbol === entrySymbol);
  if (bars.length === 0) {
    // Try to use any available bars for that minute
    bars = secondBars.filter(b => !b.symbol.includes('-')); // Exclude calendar spreads
  }

  if (bars.length === 0) {
    return { result: 'no_data', trade };
  }

  // Sort by timestamp
  bars.sort((a, b) => a.timestamp - b.timestamp);

  // Walk through second by second
  let trailingTriggered = false;
  let stopHit = false;
  let triggerSecond = null;
  let stopSecond = null;

  for (const bar of bars) {
    if (side === 'buy') {
      // Long position
      // Check trigger first (price needs to go UP to trigger)
      if (!trailingTriggered && bar.high >= trigger) {
        trailingTriggered = true;
        triggerSecond = bar;
      }
      // Check stop (price goes DOWN to stop)
      if (!trailingTriggered && bar.low <= stop) {
        stopHit = true;
        stopSecond = bar;
        break;
      }
    } else {
      // Short position
      // Check trigger first (price needs to go DOWN to trigger)
      if (!trailingTriggered && bar.low <= trigger) {
        trailingTriggered = true;
        triggerSecond = bar;
      }
      // Check stop (price goes UP to stop)
      if (!trailingTriggered && bar.high >= stop) {
        stopHit = true;
        stopSecond = bar;
        break;
      }
    }
  }

  if (stopHit) {
    return {
      result: 'invalid',
      trade,
      reason: 'stop_hit_first',
      stopSecond,
      barsAnalyzed: bars.length
    };
  } else if (trailingTriggered) {
    return {
      result: 'valid',
      trade,
      reason: 'trigger_hit_first',
      triggerSecond,
      barsAnalyzed: bars.length
    };
  } else {
    // Neither hit in the 1s data - this shouldn't happen if 1m showed both were hittable
    return {
      result: 'inconclusive',
      trade,
      reason: 'neither_hit_in_1s_data',
      barsAnalyzed: bars.length
    };
  }
}

// Stream through 1-second data file and validate trades
async function streamValidate(dataPath, minuteMap, verbose) {
  return new Promise((resolve, reject) => {
    const results = [];
    let currentMinute = null;
    let currentSecondBars = [];
    let linesProcessed = 0;
    let matchedMinutes = 0;

    // Get the time range we care about
    const minuteTimestamps = Array.from(minuteMap.keys()).sort((a, b) => a - b);
    const minTime = minuteTimestamps[0];
    const maxTime = minuteTimestamps[minuteTimestamps.length - 1] + 60000; // +1 minute

    console.log(`Looking for ${minuteMap.size} specific minutes between ${new Date(minTime).toISOString()} and ${new Date(maxTime).toISOString()}`);

    const fileStream = fs.createReadStream(dataPath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });

    let isHeader = true;
    let lastProgressReport = Date.now();

    rl.on('line', (line) => {
      if (isHeader) {
        isHeader = false;
        return;
      }

      linesProcessed++;

      // Progress report every 10 seconds
      if (Date.now() - lastProgressReport > 10000) {
        console.log(`  Processed ${(linesProcessed / 1000000).toFixed(1)}M lines, found ${matchedMinutes}/${minuteMap.size} minutes...`);
        lastProgressReport = Date.now();
      }

      // Parse the line
      const parts = line.split(',');
      if (parts.length < 10) return;

      const timestamp = new Date(parts[0]).getTime();

      // Skip if outside our time range
      if (timestamp < minTime - 60000 || timestamp > maxTime + 60000) return;

      // Skip calendar spreads
      const symbol = parts[9];
      if (symbol && symbol.includes('-')) return;

      // Round down to minute
      const minuteTs = Math.floor(timestamp / 60000) * 60000;

      // Check if this is a minute we care about
      if (!minuteMap.has(minuteTs)) return;

      // If we've moved to a new minute, process the previous one
      if (currentMinute !== null && currentMinute !== minuteTs) {
        // Process trades for the completed minute
        const tradesForMinute = minuteMap.get(currentMinute);
        if (tradesForMinute && currentSecondBars.length > 0) {
          matchedMinutes++;
          for (const at of tradesForMinute) {
            const result = validateTradeWith1sData(at, currentSecondBars);
            results.push(result);
            if (verbose && result.result === 'invalid') {
              console.log(`  [INVALID] Trade ${at.trade.id}: stop hit at ${new Date(result.stopSecond.timestamp).toISOString()}`);
            }
          }
        }
        currentSecondBars = [];
      }

      currentMinute = minuteTs;

      // Add this second bar
      currentSecondBars.push({
        timestamp,
        symbol,
        open: parseFloat(parts[4]),
        high: parseFloat(parts[5]),
        low: parseFloat(parts[6]),
        close: parseFloat(parts[7]),
        volume: parseFloat(parts[8])
      });
    });

    rl.on('close', () => {
      // Process the last minute if needed
      if (currentMinute !== null && minuteMap.has(currentMinute) && currentSecondBars.length > 0) {
        matchedMinutes++;
        const tradesForMinute = minuteMap.get(currentMinute);
        for (const at of tradesForMinute) {
          const result = validateTradeWith1sData(at, currentSecondBars);
          results.push(result);
        }
      }

      console.log(`\nProcessed ${(linesProcessed / 1000000).toFixed(1)}M lines total`);
      console.log(`Found 1s data for ${matchedMinutes}/${minuteMap.size} minutes`);

      resolve(results);
    });

    rl.on('error', reject);
    fileStream.on('error', reject);
  });
}

// Calculate what P&L would be if trade stopped out
function calcStoppedPnL(trade) {
  const stopPoints = trade.side === 'buy'
    ? trade.stopLoss - trade.actualEntry
    : trade.actualEntry - trade.stopLoss;
  return stopPoints * trade.quantity * (trade.pointValue || 20) - (trade.commission || 5);
}

// Format time for display
function formatTime(timestamp) {
  return new Date(timestamp).toISOString().replace('T', ' ').substring(0, 19);
}

// Main function
async function main() {
  const config = parseArgs();

  console.log('========================================');
  console.log(' TRAILING STOP VALIDATION (1-SECOND)');
  console.log('========================================\n');

  // Load results
  const resultsPath = path.isAbsolute(config.resultsFile)
    ? config.resultsFile
    : path.join(process.cwd(), config.resultsFile);

  if (!fs.existsSync(resultsPath)) {
    console.error(`Results file not found: ${resultsPath}`);
    process.exit(1);
  }

  console.log(`Loading results from ${resultsPath}...`);
  const results = JSON.parse(fs.readFileSync(resultsPath, 'utf-8'));

  // Identify ambiguous trades
  const ambiguousTrades = identifyAmbiguousTrades(results.trades);
  console.log(`Found ${ambiguousTrades.length} ambiguous trailing stop trades to validate\n`);

  if (ambiguousTrades.length === 0) {
    console.log('No ambiguous trades to validate.');
    return;
  }

  // Build minute map
  const minuteMap = buildMinuteMap(ambiguousTrades);
  console.log(`Need to check ${minuteMap.size} unique minutes\n`);

  // Check 1s data file
  const dataPath = path.join(config.dataDir, 'ohlcv', 'NQ_ohlcv_1s.csv');
  if (!fs.existsSync(dataPath)) {
    console.error(`1-second data file not found: ${dataPath}`);
    process.exit(1);
  }

  console.log(`Streaming 1-second data from ${dataPath}...`);
  console.log('This may take a few minutes for large files.\n');

  // Stream and validate
  const validationResults = await streamValidate(dataPath, minuteMap, config.verbose);

  // Tally results
  let validCount = 0;
  let invalidCount = 0;
  let inconclusiveCount = 0;
  let noDataCount = 0;

  let validPnL = 0;
  let invalidPnL = 0;
  let inconclusivePnL = 0;

  const invalidTrades = [];

  for (const r of validationResults) {
    const pnl = r.trade.netPnL;

    if (r.result === 'valid') {
      validCount++;
      validPnL += pnl;
    } else if (r.result === 'invalid') {
      invalidCount++;
      invalidPnL += pnl;
      invalidTrades.push(r);
    } else if (r.result === 'inconclusive') {
      inconclusiveCount++;
      inconclusivePnL += pnl;
    } else {
      noDataCount++;
    }
  }

  // Summary
  console.log('\n========================================');
  console.log('     1-SECOND VALIDATION RESULTS');
  console.log('========================================\n');

  console.log(`Ambiguous trades analyzed: ${validationResults.length}`);
  console.log(`  VALID (trailing triggered first):   ${validCount} (${(validCount/validationResults.length*100).toFixed(1)}%)`);
  console.log(`  INVALID (stop hit first):           ${invalidCount} (${(invalidCount/validationResults.length*100).toFixed(1)}%)`);
  console.log(`  Inconclusive:                       ${inconclusiveCount}`);
  console.log(`  No 1s data found:                   ${noDataCount}`);

  console.log('\n--- P&L Breakdown ---');
  console.log(`Valid trades P&L:      $${validPnL.toFixed(2)}`);
  console.log(`Invalid trades P&L:    $${invalidPnL.toFixed(2)}`);
  if (inconclusiveCount > 0) {
    console.log(`Inconclusive P&L:      $${inconclusivePnL.toFixed(2)}`);
  }

  // Impact analysis
  if (invalidCount > 0) {
    const correctedPnL = invalidTrades.reduce((sum, r) => sum + calcStoppedPnL(r.trade), 0);
    const overstatement = invalidPnL - correctedPnL;

    console.log('\n========================================');
    console.log('         IMPACT ANALYSIS');
    console.log('========================================\n');

    console.log(`Invalid trades reported P&L: $${invalidPnL.toFixed(2)}`);
    console.log(`If stopped out instead:      $${correctedPnL.toFixed(2)}`);
    console.log(`Overstatement from ambiguous: $${overstatement.toFixed(2)}`);

    // Combined with the 170 definitively invalid from original analysis
    console.log('\n--- Combined with Previous Analysis ---');
    console.log('Previously identified invalid trades: 170 ($33,035 overstatement)');
    console.log(`Newly confirmed invalid from ambiguous: ${invalidCount} ($${overstatement.toFixed(2)} overstatement)`);
    console.log(`TOTAL OVERSTATEMENT: $${(33035 + overstatement).toFixed(2)}`);
    console.log(`Total backtest P&L: $${results.performance.basic.totalPnL.toFixed(2)}`);
    console.log(`Overstatement %: ${((33035 + overstatement) / results.performance.basic.totalPnL * 100).toFixed(2)}%`);
  }

  // Show some invalid trades
  if (invalidTrades.length > 0) {
    console.log('\n========================================');
    console.log('    SAMPLE INVALID TRADES (1s proof)');
    console.log('========================================\n');

    for (const r of invalidTrades.slice(0, 10)) {
      const t = r.trade;
      console.log(`Trade ${t.id} | ${t.side.toUpperCase()} @ ${t.actualEntry}`);
      console.log(`  Entry minute: ${formatTime(t.entryTime)}`);
      console.log(`  Stop: ${t.stopLoss} | Trigger: ${t.side === 'buy' ? t.actualEntry + t.trailingTrigger : t.actualEntry - t.trailingTrigger}`);
      console.log(`  Stop hit at: ${formatTime(r.stopSecond.timestamp)}`);
      console.log(`  1s bar: O=${r.stopSecond.open} H=${r.stopSecond.high} L=${r.stopSecond.low} C=${r.stopSecond.close}`);
      console.log(`  Reported P&L: $${t.netPnL} | Should be: $${calcStoppedPnL(t).toFixed(2)}`);
      console.log('');
    }

    if (invalidTrades.length > 10) {
      console.log(`... and ${invalidTrades.length - 10} more invalid trades\n`);
    }
  }

  console.log('\n========================================');
  console.log('        VALIDATION COMPLETE');
  console.log('========================================\n');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
