#!/usr/bin/env node

/**
 * GEX-Liquidity Correlation Analysis CLI
 *
 * Analyzes the relationship between LDPS liquidity states and
 * price behavior at GEX support/resistance levels.
 *
 * Usage:
 *   node analyze-gex-liquidity.js [options]
 *
 * Options:
 *   --start       Start date (YYYY-MM-DD, default: 2023-03-28)
 *   --end         End date (YYYY-MM-DD, default: 2025-12-24)
 *   --output      Output JSON file path (optional)
 *   --threshold   Touch threshold in points (default: 5)
 *   --lookahead   Candles to look ahead for outcome (default: 60)
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { runAnalysis } from './src/analytics/gex-liquidity-analyzer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Parse command line arguments
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
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
GEX-Liquidity Correlation Analysis

Analyzes how price behaves at GEX support/resistance levels based on
the concurrent LDPS liquidity sentiment (BULLISH/BEARISH).

Usage:
  node analyze-gex-liquidity.js [options]

Options:
  --start <date>      Start date (YYYY-MM-DD, default: 2023-03-28)
  --end <date>        End date (YYYY-MM-DD, default: 2025-12-24)
  --output <file>     Export results to JSON file
  --threshold <pts>   Level touch threshold in points (default: 5)
  --lookahead <n>     Candles to analyze after touch (default: 60)
  --help, -h          Show this help message

Examples:
  # Run full analysis
  node analyze-gex-liquidity.js

  # Analyze specific date range
  node analyze-gex-liquidity.js --start 2024-01-01 --end 2024-12-31

  # Export results
  node analyze-gex-liquidity.js --output results/gex-liquidity-analysis.json

  # Adjust sensitivity
  node analyze-gex-liquidity.js --threshold 3 --lookahead 30
`);
      process.exit(0);
    }
  }

  return parsed;
}

// Main execution
async function main() {
  const args = parseArgs();

  console.log(`
╔═══════════════════════════════════════════════════════════════════════╗
║                    GEX-LIQUIDITY CORRELATION ANALYSIS                 ║
╚═══════════════════════════════════════════════════════════════════════╝

Analysis Period: ${args.startDate} to ${args.endDate}
Data Directory:  ${args.dataDir}
`);

  try {
    const results = await runAnalysis(args);

    // Summary
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('  ANALYSIS COMPLETE');
    console.log('═══════════════════════════════════════════════════════════\n');

    console.log(`Total level touch events analyzed: ${results.summary.totalEvents}`);

    if (results.summary.dateRange) {
      console.log(`Date range: ${results.summary.dateRange.start.toISOString().split('T')[0]} to ${results.summary.dateRange.end.toISOString().split('T')[0]}`);
    }

    if (args.outputFile) {
      console.log(`\nResults exported to: ${args.outputFile}`);
    }

    process.exit(0);
  } catch (error) {
    console.error('\n❌ Analysis failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

main();
