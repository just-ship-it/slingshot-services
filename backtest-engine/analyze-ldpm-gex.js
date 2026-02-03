#!/usr/bin/env node

/**
 * LDPM-GEX Correlation Analysis CLI
 *
 * Analyzes how LDPM level characteristics (ordering, stacking, direction)
 * affect price behavior at GEX support/resistance levels.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { runLdpmAnalysis } from './src/analytics/ldpm-gex-analyzer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {
    dataDir: path.join(__dirname, 'data'),
    startDate: '2023-03-28',
    endDate: '2025-12-24',
    outputFile: null,
    config: {}
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--start' && args[i + 1]) {
      parsed.startDate = args[++i];
    } else if (arg === '--end' && args[i + 1]) {
      parsed.endDate = args[++i];
    } else if (arg === '--output' && args[i + 1]) {
      parsed.outputFile = args[++i];
    } else if (arg === '--threshold' && args[i + 1]) {
      parsed.config.touchThreshold = parseFloat(args[++i]);
    } else if (arg === '--lookahead' && args[i + 1]) {
      parsed.config.lookAheadCandles = parseInt(args[++i]);
    } else if (arg === '--lookback' && args[i + 1]) {
      parsed.config.lookBackPeriods = parseInt(args[++i]);
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
LDPM-GEX Correlation Analysis

Analyzes how LDPM level characteristics affect price at GEX levels:
- Level ordering (ascending, descending, V-pattern, mixed)
- Level stacking (tight vs spread)
- Level direction (rising vs falling as price approaches GEX)
- LDPM-GEX confluence and alignment

Usage:
  node analyze-ldpm-gex.js [options]

Options:
  --start <date>      Start date (YYYY-MM-DD, default: 2023-03-28)
  --end <date>        End date (YYYY-MM-DD, default: 2025-12-24)
  --output <file>     Export results to JSON file
  --threshold <pts>   Level touch threshold in points (default: 5)
  --lookahead <n>     Candles to analyze after touch (default: 60)
  --lookback <n>      15-min periods to analyze LDPM direction (default: 4)
  --help, -h          Show this help message
`);
      process.exit(0);
    }
  }

  return parsed;
}

async function main() {
  const args = parseArgs();

  console.log(`
╔═══════════════════════════════════════════════════════════════════════╗
║                    LDPM-GEX CORRELATION ANALYSIS                      ║
╚═══════════════════════════════════════════════════════════════════════╝

Analysis Period: ${args.startDate} to ${args.endDate}
Data Directory:  ${args.dataDir}
`);

  try {
    await runLdpmAnalysis(args);
    process.exit(0);
  } catch (error) {
    console.error('\nAnalysis failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

main();
