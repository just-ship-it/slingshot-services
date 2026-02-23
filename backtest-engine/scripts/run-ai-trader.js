#!/usr/bin/env node

/**
 * CLI runner for the AI Trader.
 *
 * Usage:
 *   # Dry run - show prompts without LLM calls
 *   node scripts/run-ai-trader.js --date 2025-06-12 --dry-run --verbose
 *
 *   # Single day
 *   ANTHROPIC_API_KEY=sk-... node scripts/run-ai-trader.js --date 2025-06-12
 *
 *   # 5 random days in 2025
 *   ANTHROPIC_API_KEY=sk-... node scripts/run-ai-trader.js --random 5 --output results.json
 *
 *   # Week range
 *   ANTHROPIC_API_KEY=sk-... node scripts/run-ai-trader.js --start 2025-06-09 --end 2025-06-13
 */

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { AITrader } from '../src/ai/ai-trader.js';
import { getTradingDays } from '../src/ai/session-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA_DIR = path.resolve(__dirname, '..', 'data');

const argv = yargs(hideBin(process.argv))
  .usage('Usage: $0 [options]')
  .option('date', {
    type: 'string',
    describe: 'Single trading day (YYYY-MM-DD)',
  })
  .option('start', {
    type: 'string',
    describe: 'Start date for range (YYYY-MM-DD)',
  })
  .option('end', {
    type: 'string',
    describe: 'End date for range (YYYY-MM-DD)',
  })
  .option('random', {
    type: 'number',
    describe: 'Pick N random trading days from 2025',
  })
  .option('ticker', {
    type: 'string',
    default: 'NQ',
    describe: 'Futures ticker (NQ or ES)',
  })
  .option('timeframe', {
    type: 'string',
    default: '5m',
    describe: 'Evaluation timeframe (1m, 3m, 5m, 15m)',
  })
  .option('threshold', {
    type: 'number',
    default: 30,
    describe: 'Level proximity threshold in points',
  })
  .option('max-entries', {
    type: 'number',
    default: 4,
    describe: 'Max entries per day (split across sessions)',
  })
  .option('max-entries-per-session', {
    type: 'number',
    default: 2,
    describe: 'Max entries per trading session (morning/afternoon)',
  })
  .option('max-losses', {
    type: 'number',
    default: 2,
    describe: 'Max losing trades before stopping for the day',
  })
  .option('model', {
    type: 'string',
    default: 'claude-sonnet-4-20250514',
    describe: 'Claude model ID',
  })
  .option('dry-run', {
    type: 'boolean',
    default: false,
    describe: 'Show prompts without calling LLM',
  })
  .option('verbose', {
    type: 'boolean',
    alias: 'v',
    default: false,
    describe: 'Verbose output',
  })
  .option('output', {
    type: 'string',
    alias: 'o',
    describe: 'Output results JSON file',
  })
  .option('data-dir', {
    type: 'string',
    default: DEFAULT_DATA_DIR,
    describe: 'Path to data directory',
  })
  .check((argv) => {
    if (!argv.date && !argv.start && !argv.random) {
      throw new Error('Must specify --date, --start/--end, or --random N');
    }
    if (argv.start && !argv.end) {
      throw new Error('--start requires --end');
    }
    if (!argv.dryRun && !process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY environment variable required (or use --dry-run)');
    }
    return true;
  })
  .help()
  .parseSync();

async function main() {
  // Determine trading days
  let tradingDays;
  let startDate, endDate;

  if (argv.date) {
    tradingDays = [argv.date];
    startDate = argv.date;
    endDate = argv.date;
  } else if (argv.start && argv.end) {
    tradingDays = getTradingDays(argv.start, argv.end);
    startDate = argv.start;
    endDate = argv.end;
  } else if (argv.random) {
    // Pick N random weekdays from Jan-Dec 2025 (best data coverage)
    const allDays = getTradingDays('2025-01-02', '2025-12-31');
    tradingDays = [];
    const shuffled = [...allDays].sort(() => Math.random() - 0.5);
    tradingDays = shuffled.slice(0, argv.random).sort();
    startDate = tradingDays[0];
    endDate = tradingDays[tradingDays.length - 1];
  }

  console.log(`\nAI Trader — ${argv.ticker} ${argv.timeframe}`);
  console.log(`Days: ${tradingDays.length} | Model: ${argv.model} | Dry run: ${argv.dryRun}`);
  console.log(`Threshold: ${argv.threshold} pts | Max entries/day: ${argv.maxEntries} (${argv.maxEntriesPerSession}/session) | Max losses/day: ${argv.maxLosses}`);
  console.log(`Dates: ${tradingDays.join(', ')}`);

  const trader = new AITrader({
    evaluationTimeframe: argv.timeframe,
    levelProximityThreshold: argv.threshold,
    maxEntriesPerDay: argv.maxEntries,
    maxEntriesPerSession: argv.maxEntriesPerSession,
    maxLossesPerDay: argv.maxLosses,
    rthOnly: true,
    dryRun: argv.dryRun,
    verbose: argv.verbose,
    ticker: argv.ticker,
    dataDir: argv.dataDir,
    model: argv.model,
  });

  // Load data
  await trader.loadData(startDate, endDate);

  // Run
  const results = await trader.runMultipleDays(tradingDays);

  // Print summary
  console.log('\n' + '═'.repeat(60));
  console.log('  RESULTS SUMMARY');
  console.log('═'.repeat(60));
  const s = results.summary;
  console.log(`  Days: ${s.totalDays} (active: ${s.activeDays}, skipped: ${s.skippedDays})`);
  console.log(`  Trades: ${s.totalTrades} (W: ${s.wins || 0}, L: ${s.losses || 0}, T: ${s.timeouts || 0})`);
  if (s.totalTrades > 0) {
    console.log(`  Win Rate: ${s.winRate}%`);
    console.log(`  Total P&L: ${s.totalPnlPoints > 0 ? '+' : ''}${s.totalPnlPoints} pts`);
    console.log(`  Avg P&L: ${s.avgPnlPoints > 0 ? '+' : ''}${s.avgPnlPoints} pts`);
    console.log(`  Avg Win: +${s.avgWinPoints} pts | Avg Loss: ${s.avgLossPoints} pts`);
    console.log(`  Profit Factor: ${s.profitFactor}`);
    if (s.avgRiskPoints) console.log(`  Avg Risk: ${s.avgRiskPoints} pts | Avg R:R: ${s.avgRewardRiskRatio}:1`);
    if (s.avgMFE || s.avgMAE) console.log(`  Avg MFE: +${s.avgMFE} pts | Avg MAE: ${s.avgMAE} pts`);
    if (s.trailedToBreakeven > 0 || s.managedExits > 0) {
      console.log(`  Trailed to breakeven: ${s.trailedToBreakeven} | Managed exits: ${s.managedExits}`);
    }
    console.log(`  Bias Accuracy: ${s.biasAccuracy}`);
    if (s.totalReassessments > 0) {
      console.log(`  Reassessments: ${s.totalReassessments} (${s.avgReassessmentsPerDay}/day avg) | Bias Reversals: ${s.totalBiasReversals}`);
    }
  }

  // Cost summary
  const cost = results.cost;
  console.log(`\n  API Cost: $${cost.estimatedCostUSD} (${cost.totalCalls} calls, ${cost.totalInputTokens} in / ${cost.totalOutputTokens} out tokens)`);
  console.log('═'.repeat(60));

  // Save output — always save, auto-generate filename if not specified
  const outputPath = argv.output
    ? path.resolve(argv.output)
    : path.resolve(__dirname, '..', 'results', 'ai-trader', `ai-trader-${startDate}-to-${endDate}.json`);

  // Ensure output directory exists
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
  console.log(`\nResults saved to: ${outputPath}`);
}

main().catch(err => {
  console.error('\nFatal error:', err.message);
  if (argv.verbose) console.error(err.stack);
  process.exit(1);
});
