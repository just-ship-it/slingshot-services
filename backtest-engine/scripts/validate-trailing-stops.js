#!/usr/bin/env node

/**
 * Trailing Stop Validation Script
 *
 * Validates that backtest trailing stop exits are realistic by ensuring
 * no trade marked as "trailing_stop" exit actually would have hit the
 * fixed stop loss first in reality.
 *
 * Usage:
 *   node scripts/validate-trailing-stops.js --results ./results/gex-scalper-latest.json
 */

import fs from 'fs';
import path from 'path';
import csv from 'csv-parser';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    resultsFile: './results/gex-scalper-latest.json',
    dataDir: path.join(__dirname, '..', 'data'),
    verbose: false,
    showAll: false
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--results' && args[i + 1]) {
      config.resultsFile = args[++i];
    } else if (args[i] === '--data-dir' && args[i + 1]) {
      config.dataDir = args[++i];
    } else if (args[i] === '--verbose' || args[i] === '-v') {
      config.verbose = true;
    } else if (args[i] === '--show-all') {
      config.showAll = true;
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`
Trailing Stop Validation Script

Validates that backtest trailing stop exits are realistic.

Usage:
  node scripts/validate-trailing-stops.js [options]

Options:
  --results <path>   Path to backtest results JSON (default: ./results/gex-scalper-latest.json)
  --data-dir <path>  Path to data directory (default: ./data)
  --verbose, -v      Show detailed output for each trade
  --show-all         Show all trades, not just invalid ones
  --help, -h         Show this help message
`);
      process.exit(0);
    }
  }

  return config;
}

// Load OHLCV CSV data
async function loadOHLCVData(dataDir) {
  const filePath = path.join(dataDir, 'ohlcv', 'NQ_ohlcv_1m.csv');

  if (!fs.existsSync(filePath)) {
    throw new Error(`OHLCV data file not found: ${filePath}`);
  }

  console.log(`Loading OHLCV data from ${filePath}...`);

  return new Promise((resolve, reject) => {
    const candles = [];

    fs.createReadStream(filePath)
      .pipe(csv())
      .on('data', (row) => {
        // Skip calendar spreads (symbol contains '-')
        if (row.symbol && row.symbol.includes('-')) {
          return;
        }

        const candle = {
          timestamp: new Date(row.ts_event).getTime(),
          symbol: row.symbol,
          open: parseFloat(row.open),
          high: parseFloat(row.high),
          low: parseFloat(row.low),
          close: parseFloat(row.close),
          volume: parseFloat(row.volume)
        };

        // Skip invalid candles
        if (isNaN(candle.timestamp) || isNaN(candle.open)) {
          return;
        }

        candles.push(candle);
      })
      .on('end', () => {
        // Sort by timestamp
        candles.sort((a, b) => a.timestamp - b.timestamp);
        console.log(`Loaded ${candles.length} candles\n`);
        resolve(candles);
      })
      .on('error', reject);
  });
}

// Build a map for fast candle lookup by timestamp
function buildCandleIndex(candles) {
  const index = new Map();
  for (const candle of candles) {
    // Store by timestamp - there might be multiple contracts at same time
    if (!index.has(candle.timestamp)) {
      index.set(candle.timestamp, []);
    }
    index.get(candle.timestamp).push(candle);
  }
  return index;
}

// Get candles for a specific time range
function getCandlesInRange(candleIndex, startTime, endTime, entrySymbol) {
  const result = [];

  for (const [timestamp, candles] of candleIndex) {
    if (timestamp >= startTime && timestamp <= endTime) {
      // Prefer candles matching the entry symbol
      const matchingCandle = candles.find(c => c.symbol === entrySymbol);
      if (matchingCandle) {
        result.push(matchingCandle);
      } else if (candles.length > 0) {
        // Use the highest volume candle if no exact match
        const bestCandle = candles.reduce((a, b) => a.volume > b.volume ? a : b);
        result.push(bestCandle);
      }
    }
  }

  return result.sort((a, b) => a.timestamp - b.timestamp);
}

// Validate a single trade
function validateTrade(trade, candleIndex, verbose) {
  const entry = trade.actualEntry;
  const side = trade.side;
  const triggerLevel = side === 'buy'
    ? entry + trade.trailingTrigger
    : entry - trade.trailingTrigger;
  const stopLevel = trade.stopLoss;
  const entryTime = trade.entryTime;
  const exitTime = trade.exitTime;
  const entrySymbol = trade.entryCandle?.symbol;

  // Get candles from entry to exit
  const candles = getCandlesInRange(candleIndex, entryTime, exitTime, entrySymbol);

  if (candles.length === 0) {
    return {
      valid: null,
      reason: 'no_candles_found',
      trade,
      details: `No candles found between ${new Date(entryTime).toISOString()} and ${new Date(exitTime).toISOString()}`
    };
  }

  let trailingActivated = false;
  let stopHitFirst = false;
  let activationCandle = null;
  let violationCandle = null;
  let activationCandleIndex = -1;
  let violationCandleIndex = -1;

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];

    if (side === 'buy') {
      // Long position
      // Check if trailing would activate (price goes 3+ points above entry)
      if (!trailingActivated && candle.high >= triggerLevel) {
        trailingActivated = true;
        activationCandle = candle;
        activationCandleIndex = i;
      }

      // Check if stop hit BEFORE activation
      if (!trailingActivated && candle.low <= stopLevel) {
        stopHitFirst = true;
        violationCandle = candle;
        violationCandleIndex = i;
        break;
      }
    } else {
      // Short position
      // Check if trailing would activate (price goes 3+ points below entry)
      if (!trailingActivated && candle.low <= triggerLevel) {
        trailingActivated = true;
        activationCandle = candle;
        activationCandleIndex = i;
      }

      // Check if stop hit BEFORE activation
      if (!trailingActivated && candle.high >= stopLevel) {
        stopHitFirst = true;
        violationCandle = candle;
        violationCandleIndex = i;
        break;
      }
    }
  }

  // Check for ambiguous entry candle (spans both trigger and stop)
  const entryCandle = trade.entryCandle;
  let entryAmbiguous = false;
  if (entryCandle) {
    if (side === 'buy') {
      const triggerable = entryCandle.high >= triggerLevel;
      const stoppable = entryCandle.low <= stopLevel;
      entryAmbiguous = triggerable && stoppable;
    } else {
      const triggerable = entryCandle.low <= triggerLevel;
      const stoppable = entryCandle.high >= stopLevel;
      entryAmbiguous = triggerable && stoppable;
    }
  }

  const result = {
    valid: !stopHitFirst,
    trailingActivated,
    stopHitFirst,
    entryAmbiguous,
    activationCandle,
    activationCandleIndex,
    violationCandle,
    violationCandleIndex,
    candleCount: candles.length,
    trade,
    details: null
  };

  if (stopHitFirst) {
    result.details = `Stop would have hit on candle ${violationCandleIndex + 1}/${candles.length} at ${new Date(violationCandle.timestamp).toISOString()}. ` +
      `Low=${violationCandle.low} reached stop=${stopLevel} before high reached trigger=${triggerLevel}`;
  } else if (entryAmbiguous) {
    result.details = `Entry candle spans both trigger (${triggerLevel}) and stop (${stopLevel}). ` +
      `High=${entryCandle.high}, Low=${entryCandle.low}. Cannot determine execution order.`;
  } else if (!trailingActivated) {
    result.details = `Trailing never activated despite exitReason=trailing_stop. Entry=${entry}, Trigger=${triggerLevel}`;
  }

  return result;
}

// Format time for display
function formatTime(timestamp) {
  return new Date(timestamp).toISOString().replace('T', ' ').substring(0, 19);
}

// Main function
async function main() {
  const config = parseArgs();

  console.log('========================================');
  console.log('   TRAILING STOP VALIDATION ANALYSIS');
  console.log('========================================\n');

  // Resolve results file path
  const resultsPath = path.isAbsolute(config.resultsFile)
    ? config.resultsFile
    : path.join(process.cwd(), config.resultsFile);

  if (!fs.existsSync(resultsPath)) {
    console.error(`Results file not found: ${resultsPath}`);
    process.exit(1);
  }

  // Load backtest results
  console.log(`Loading results from ${resultsPath}...`);
  const results = JSON.parse(fs.readFileSync(resultsPath, 'utf-8'));

  // Filter for trailing stop exits
  const trailingStopTrades = results.trades.filter(t =>
    t.exitReason === 'trailing_stop' && t.trailingStop?.triggered === true
  );

  console.log(`Total trades: ${results.trades.length}`);
  console.log(`Trailing stop exits: ${trailingStopTrades.length}\n`);

  if (trailingStopTrades.length === 0) {
    console.log('No trailing stop exits found to validate.');
    return;
  }

  // Load OHLCV data
  const candles = await loadOHLCVData(config.dataDir);
  const candleIndex = buildCandleIndex(candles);

  // Validate each trade
  const validations = [];
  let validCount = 0;
  let invalidCount = 0;
  let ambiguousCount = 0;
  let unknownCount = 0;

  console.log('Validating trailing stop exits...\n');

  for (const trade of trailingStopTrades) {
    const result = validateTrade(trade, candleIndex, config.verbose);
    validations.push(result);

    if (result.valid === null) {
      unknownCount++;
    } else if (result.stopHitFirst) {
      invalidCount++;
    } else if (result.entryAmbiguous) {
      ambiguousCount++;
    } else {
      validCount++;
    }
  }

  // Summary
  console.log('========================================');
  console.log('            VALIDATION SUMMARY');
  console.log('========================================\n');

  console.log(`Total trailing stop exits analyzed: ${trailingStopTrades.length}`);
  console.log(`  Valid (stop never hit first):     ${validCount} (${(validCount / trailingStopTrades.length * 100).toFixed(1)}%)`);
  console.log(`  INVALID (stop hit first):         ${invalidCount} (${(invalidCount / trailingStopTrades.length * 100).toFixed(1)}%)`);
  console.log(`  Ambiguous (entry candle spans):   ${ambiguousCount} (${(ambiguousCount / trailingStopTrades.length * 100).toFixed(1)}%)`);
  console.log(`  Unknown (no data):                ${unknownCount}`);

  // Show invalid trades
  const invalidTrades = validations.filter(v => v.stopHitFirst);
  if (invalidTrades.length > 0) {
    console.log('\n========================================');
    console.log('         INVALID TRADES (STOP HIT FIRST)');
    console.log('========================================\n');

    for (const v of invalidTrades.slice(0, 20)) {
      const t = v.trade;
      console.log(`Trade ${t.id} | ${t.side.toUpperCase()} @ ${t.actualEntry}`);
      console.log(`  Entry:  ${formatTime(t.entryTime)}`);
      console.log(`  Exit:   ${formatTime(t.exitTime)} (reported as trailing_stop)`);
      console.log(`  Stop:   ${t.stopLoss} | Trigger: ${t.side === 'buy' ? t.actualEntry + t.trailingTrigger : t.actualEntry - t.trailingTrigger}`);
      console.log(`  Result: ${v.details}`);
      if (v.violationCandle) {
        console.log(`  Violation candle: O=${v.violationCandle.open} H=${v.violationCandle.high} L=${v.violationCandle.low} C=${v.violationCandle.close}`);
      }
      console.log(`  P&L reported: $${t.netPnL} (${t.pointsPnL} pts)`);
      console.log('');
    }

    if (invalidTrades.length > 20) {
      console.log(`... and ${invalidTrades.length - 20} more invalid trades\n`);
    }
  }

  // Show ambiguous trades
  const ambiguousTrades = validations.filter(v => v.entryAmbiguous && !v.stopHitFirst);
  if (ambiguousTrades.length > 0) {
    console.log('\n========================================');
    console.log('      AMBIGUOUS TRADES (ENTRY CANDLE)');
    console.log('========================================\n');

    for (const v of ambiguousTrades.slice(0, 10)) {
      const t = v.trade;
      console.log(`Trade ${t.id} | ${t.side.toUpperCase()} @ ${t.actualEntry}`);
      console.log(`  Entry candle: O=${t.entryCandle.open} H=${t.entryCandle.high} L=${t.entryCandle.low} C=${t.entryCandle.close}`);
      console.log(`  Stop: ${t.stopLoss} | Trigger: ${t.side === 'buy' ? t.actualEntry + t.trailingTrigger : t.actualEntry - t.trailingTrigger}`);
      console.log(`  Note: Entry candle spans both levels - outcome is indeterminate`);
      console.log('');
    }

    if (ambiguousTrades.length > 10) {
      console.log(`... and ${ambiguousTrades.length - 10} more ambiguous trades\n`);
    }
  }

  // Calculate impact
  if (invalidCount > 0) {
    const invalidPnL = invalidTrades.reduce((sum, v) => sum + v.trade.netPnL, 0);
    const totalPnL = results.performance?.basic?.totalPnL || results.trades.reduce((sum, t) => sum + t.netPnL, 0);

    console.log('\n========================================');
    console.log('            IMPACT ANALYSIS');
    console.log('========================================\n');

    console.log(`P&L from invalid trailing stops: $${invalidPnL.toFixed(2)}`);
    console.log(`Total backtest P&L: $${totalPnL.toFixed(2)}`);
    console.log(`Impact: ${(invalidPnL / totalPnL * 100).toFixed(2)}% of total P&L`);

    // Estimate corrected P&L (assuming invalid trades would have been stop losses)
    const correctedPnL = invalidTrades.reduce((sum, v) => {
      const t = v.trade;
      // If the trade would have stopped out at original stop, calculate new P&L
      const stopPoints = t.side === 'buy'
        ? t.stopLoss - t.actualEntry  // Negative for long
        : t.actualEntry - t.stopLoss; // Negative for short
      const correctedTradePnL = stopPoints * t.quantity * (t.pointValue || 20) - (t.commission || 5);
      return sum + correctedTradePnL;
    }, 0);

    console.log(`\nIf these trades hit original stop loss instead:`);
    console.log(`  Reported P&L:  $${invalidPnL.toFixed(2)}`);
    console.log(`  Corrected P&L: $${correctedPnL.toFixed(2)}`);
    console.log(`  Difference:    $${(invalidPnL - correctedPnL).toFixed(2)}`);
  }

  console.log('\n========================================');
  console.log('           VALIDATION COMPLETE');
  console.log('========================================\n');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
