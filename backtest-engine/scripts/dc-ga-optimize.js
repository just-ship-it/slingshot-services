#!/usr/bin/env node

/**
 * DC-MSTGAM Genetic Algorithm Optimizer
 *
 * CLI tool for finding optimal weights for combining multiple DC strategies
 * across multiple thresholds using a genetic algorithm.
 *
 * Usage:
 *   node scripts/dc-ga-optimize.js --ticker NQ --start 2024-01-01 --end 2024-12-31
 *   node scripts/dc-ga-optimize.js --ticker NQ --start 2024-01-01 --end 2024-12-31 \
 *     --pop 200 --gen 100 --stop-loss 20 --take-profit 40 --seed 42
 */

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { CSVLoader } from '../src/data/csv-loader.js';
import { CandleAggregator } from '../../shared/utils/candle-aggregator.js';
import { MSTGAMOptimizer, SignalPrecomputer, LightweightSimulator } from '../../shared/dc/mstgam-optimizer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── CLI ──────────────────────────────────────────────────────────────────

async function main() {
  const args = yargs(hideBin(process.argv))
    .usage('Usage: $0 --ticker NQ --start YYYY-MM-DD --end YYYY-MM-DD [options]')
    .example('$0 --ticker NQ --start 2024-01-01 --end 2024-12-31', 'Basic GA optimization')
    .example('$0 --ticker NQ --start 2024-01-01 --end 2024-12-31 --pop 200 --gen 100 --seed 42', 'Custom GA parameters')

    // Required
    .option('ticker', {
      alias: 't',
      type: 'string',
      description: 'Ticker symbol (NQ, ES)',
      demandOption: true
    })
    .option('start', {
      alias: 's',
      type: 'string',
      description: 'Start date (YYYY-MM-DD)',
      demandOption: true
    })
    .option('end', {
      alias: 'e',
      type: 'string',
      description: 'End date (YYYY-MM-DD)',
      demandOption: true
    })

    // Train/test split
    .option('train-pct', {
      type: 'number',
      description: 'Fraction of data for training (rest = test)',
      default: 0.7
    })

    // GA parameters
    .group(['pop', 'gen', 'tournament', 'crossover', 'mutation', 'seed', 'runs'], 'GA Parameters:')
    .option('pop', {
      type: 'number',
      description: 'Population size',
      default: 150
    })
    .option('gen', {
      type: 'number',
      description: 'Number of generations',
      default: 50
    })
    .option('tournament', {
      type: 'number',
      description: 'Tournament size for selection',
      default: 2
    })
    .option('crossover', {
      type: 'number',
      description: 'Crossover rate (0-1)',
      default: 0.95
    })
    .option('mutation', {
      type: 'number',
      description: 'Mutation rate (0-1)',
      default: 0.05
    })
    .option('seed', {
      type: 'number',
      description: 'Random seed for reproducibility',
      default: 42
    })
    .option('runs', {
      type: 'number',
      description: 'Independent GA runs (best of N)',
      default: 1
    })

    // Trade parameters
    .group(['stop-loss', 'take-profit', 'slippage', 'commission'], 'Trade Parameters:')
    .option('stop-loss', {
      type: 'number',
      description: 'Stop loss in points',
      default: 15
    })
    .option('take-profit', {
      type: 'number',
      description: 'Take profit in points',
      default: 30
    })
    .option('slippage', {
      type: 'number',
      description: 'Slippage in points',
      default: 1
    })
    .option('commission', {
      type: 'number',
      description: 'Round-trip commission ($)',
      default: 5
    })

    // DC parameters
    .group(['dc-use-points', 'thresholds', 'entry-mult', 'duration-mult', 'rd-threshold', 'consecutive-count'], 'DC Parameters:')
    .option('dc-use-points', {
      type: 'boolean',
      description: 'Use absolute points instead of percentage for theta',
      default: false
    })
    .option('thresholds', {
      type: 'string',
      description: 'Custom thresholds for St1-St6 (comma-separated)'
    })
    .option('thresholds-st78', {
      type: 'string',
      description: 'Custom thresholds for St7-St8 (comma-separated)'
    })
    .option('entry-mult', {
      type: 'number',
      description: 'St1 entry multiplier',
      default: 2.0
    })
    .option('duration-mult', {
      type: 'number',
      description: 'St2 duration multiplier',
      default: 2.0
    })
    .option('rd-threshold', {
      type: 'number',
      description: 'St5 RD threshold',
      default: 2.0
    })
    .option('consecutive-count', {
      type: 'number',
      description: 'St7/St8 consecutive count',
      default: 3
    })

    // Futures / structural controls
    .group(['cooldown', 'min-votes', 'max-trades-day', 'futures-preset'], 'Futures Controls:')
    .option('cooldown', {
      type: 'number',
      description: 'Candles to wait after exit before next entry',
      default: 0
    })
    .option('min-votes', {
      type: 'number',
      description: 'Min non-Hold votes to trigger trade',
      default: 2
    })
    .option('max-trades-day', {
      type: 'number',
      description: 'Daily trade cap (0 = unlimited)',
      default: 0
    })
    .option('futures-preset', {
      type: 'boolean',
      description: 'Apply sensible futures defaults (larger thresholds, cooldown, etc.)',
      default: false
    })

    // Optimizer enhancements
    .group(['fitness-mode', 'min-trades', 'confirm-threshold', 'walk-forward'], 'Optimizer Enhancements:')
    .option('fitness-mode', {
      type: 'string',
      description: 'Fitness function',
      default: 'sharpe',
      choices: ['sharpe', 'sortino', 'calmar', 'composite']
    })
    .option('min-trades', {
      type: 'number',
      description: 'Minimum trade count (fewer = -Infinity fitness)',
      default: 20
    })
    .option('confirm-threshold', {
      type: 'number',
      description: 'Min |buyWeight - sellWeight| to trigger trade (0 = disabled)',
      default: 0
    })
    .option('walk-forward', {
      type: 'boolean',
      description: 'Run quarterly expanding-window walk-forward validation',
      default: false
    })

    // Data / output
    .group(['timeframe', 'data-dir', 'output', 'sessions'], 'Data & Output:')
    .option('timeframe', {
      alias: 'tf',
      type: 'string',
      description: 'Candle timeframe',
      default: '1m',
      choices: ['1m', '3m', '5m', '15m', '30m', '1h']
    })
    .option('sessions', {
      type: 'string',
      description: 'Allowed sessions (comma-sep: rth,premarket,overnight,afterhours)'
    })
    .option('data-dir', {
      type: 'string',
      description: 'Data directory path',
      default: path.join(__dirname, '..', 'data')
    })
    .option('output', {
      alias: 'o',
      type: 'string',
      description: 'Output JSON path (auto-generated if omitted)'
    })

    .help('h')
    .alias('h', 'help')
    .version('1.0.0')
    .wrap(120)
    .parse();

  // ── Futures preset (apply defaults before header so display reflects final values) ──

  let thresholdsSt1_6_preset = null;
  let thresholdsSt7_8_preset = null;

  if (args.futuresPreset) {
    const isDefault = (key, defaultVal) => args[key] === defaultVal;

    if (!args.thresholds) {
      thresholdsSt1_6_preset = [0.002, 0.004, 0.006, 0.008, 0.01, 0.015, 0.02, 0.03, 0.04, 0.05];
    }
    if (!args.thresholdsSt78) {
      thresholdsSt7_8_preset = [0.002, 0.004, 0.006, 0.008, 0.01];
    }
    if (isDefault('cooldown', 0)) args.cooldown = 10;
    if (isDefault('minVotes', 2)) args.minVotes = 5;
    if (isDefault('maxTradesDay', 0)) args.maxTradesDay = 10;
    if (isDefault('timeframe', '1m')) args.timeframe = '5m';
    if (isDefault('confirmThreshold', 0)) args.confirmThreshold = 0.3;
  }

  // ── Header ──

  console.log(chalk.blue.bold('\nDC-MSTGAM Genetic Algorithm Optimizer'));
  console.log(chalk.gray('─'.repeat(55)));
  console.log(chalk.white(`Ticker:       ${args.ticker.toUpperCase()}`));
  console.log(chalk.white(`Period:       ${args.start} to ${args.end}`));
  console.log(chalk.white(`Timeframe:    ${args.timeframe}`));
  if (args.futuresPreset) console.log(chalk.cyan(`Preset:       futures (larger thresholds, cooldown=${args.cooldown}, minVotes=${args.minVotes}, maxTrades/day=${args.maxTradesDay})`));
  console.log(chalk.white(`Train/Test:   ${(args.trainPct * 100).toFixed(0)}% / ${((1 - args.trainPct) * 100).toFixed(0)}%`));
  console.log(chalk.white(`GA:           pop=${args.pop}, gen=${args.gen}, crossover=${args.crossover}, mutation=${args.mutation}`));
  console.log(chalk.white(`Trade:        SL=${args.stopLoss}pts, TP=${args.takeProfit}pts, slip=${args.slippage}pts`));
  console.log(chalk.white(`Fitness:      ${args.fitnessMode}, minTrades=${args.minTrades}`));
  if (args.confirmThreshold > 0) console.log(chalk.white(`Confirm:      threshold=${args.confirmThreshold}`));
  if (args.cooldown > 0) console.log(chalk.white(`Cooldown:     ${args.cooldown} candles`));
  if (args.minVotes !== 2) console.log(chalk.white(`Min Votes:    ${args.minVotes}`));
  if (args.maxTradesDay > 0) console.log(chalk.white(`Max Trades:   ${args.maxTradesDay}/day`));
  console.log(chalk.white(`Seed:         ${args.seed}`));
  if (args.runs > 1) console.log(chalk.white(`Runs:         ${args.runs} (best of N)`));
  if (args.walkForward) console.log(chalk.white(`Walk-Forward: quarterly expanding-window`));
  console.log(chalk.gray('─'.repeat(55)));

  // ── Load Data ──

  console.log(chalk.yellow('\nLoading OHLCV data...'));
  const configPath = path.join(__dirname, '..', 'src', 'config', 'default.json');
  const defaultConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const csvLoader = new CSVLoader(args.dataDir, defaultConfig, { noContinuous: true });

  const startDate = new Date(args.start);
  const endDate = new Date(args.end);
  const { candles: rawCandles } = await csvLoader.loadOHLCVData(args.ticker.toUpperCase(), startDate, endDate);

  // Aggregate timeframe if needed
  let candles = rawCandles;
  if (args.timeframe !== '1m') {
    const aggregator = new CandleAggregator();
    candles = aggregator.aggregate(rawCandles, args.timeframe, { silent: true });
    console.log(`Aggregated to ${args.timeframe}: ${candles.length} candles`);
  }

  if (candles.length === 0) {
    console.error(chalk.red('No candle data loaded. Check your date range and data directory.'));
    process.exit(1);
  }

  // ── Train/Test Split ──

  const splitIdx = Math.floor(candles.length * args.trainPct);
  const trainCandles = candles.slice(0, splitIdx);
  const testCandles = candles.slice(splitIdx);

  console.log(chalk.white(`\nTrain set: ${trainCandles.length} candles (${new Date(trainCandles[0].timestamp).toISOString().slice(0, 10)} to ${new Date(trainCandles[trainCandles.length - 1].timestamp).toISOString().slice(0, 10)})`));
  console.log(chalk.white(`Test set:  ${testCandles.length} candles (${new Date(testCandles[0].timestamp).toISOString().slice(0, 10)} to ${new Date(testCandles[testCandles.length - 1].timestamp).toISOString().slice(0, 10)})`));

  // ── Parse Thresholds ──

  let thresholdsSt1_6 = thresholdsSt1_6_preset || undefined;
  let thresholdsSt7_8 = thresholdsSt7_8_preset || undefined;
  if (args.thresholds) {
    thresholdsSt1_6 = args.thresholds.split(',').map(Number);
    console.log(chalk.white(`Custom thresholds St1-6: [${thresholdsSt1_6.join(', ')}]`));
  }
  if (args.thresholdsSt78) {
    thresholdsSt7_8 = args.thresholdsSt78.split(',').map(Number);
    console.log(chalk.white(`Custom thresholds St7-8: [${thresholdsSt7_8.join(', ')}]`));
  }

  // ── Session filter ──

  let allowedSessions = null;
  if (args.sessions) {
    allowedSessions = args.sessions.split(',').map(s => s.trim());
    console.log(chalk.white(`Session filter: [${allowedSessions.join(', ')}]`));
  }

  // ── Precomputer / Simulator options ──

  const precomputerOptions = {
    thresholdsSt1_6,
    thresholdsSt7_8,
    usePoints: args.dcUsePoints,
    entryMultiplier: args.entryMult,
    durationMultiplier: args.durationMult,
    rdThreshold: args.rdThreshold,
    consecutiveCount: args.consecutiveCount,
    seed: args.seed,
    allowedSessions
  };

  const ticker = args.ticker.toUpperCase();
  const pointValue = defaultConfig.contracts[ticker]?.pointValue || 20;

  const simulatorOptions = {
    stopLossPoints: args.stopLoss,
    takeProfitPoints: args.takeProfit,
    slippage: args.slippage,
    commission: args.commission,
    pointValue,
    confirmThreshold: args.confirmThreshold,
    cooldownCandles: args.cooldown,
    minNonHoldVotes: args.minVotes,
    maxTradesPerDay: args.maxTradesDay
  };

  // ── Run GA ──

  console.log(chalk.yellow('\nStarting GA optimization...'));
  const gaStartTime = Date.now();

  let bestResult = null;

  for (let run = 0; run < args.runs; run++) {
    if (args.runs > 1) {
      console.log(chalk.blue(`\n--- Run ${run + 1} / ${args.runs} ---`));
    }

    const runSeed = args.seed + run * 1000;

    const optimizer = new MSTGAMOptimizer({
      populationSize: args.pop,
      generations: args.gen,
      tournamentSize: args.tournament,
      crossoverRate: args.crossover,
      mutationRate: args.mutation,
      fitnessMode: args.fitnessMode,
      minTradeCount: args.minTrades,
      seed: runSeed,
      onProgress: (gen, totalGens, bestFitness, avgFitness, metrics) => {
        const pct = ((gen / totalGens) * 100).toFixed(0);
        const bar = '='.repeat(Math.floor(gen / totalGens * 30)).padEnd(30);
        process.stdout.write(`\r  [${bar}] ${pct}% | Gen ${gen}/${totalGens} | Best Sharpe: ${bestFitness.toFixed(4)} | Avg: ${avgFitness.toFixed(4)} | Trades: ${metrics?.numTrades || 0} | PnL: $${(metrics?.totalPnL || 0).toFixed(0)}`);
      }
    });

    const result = optimizer.optimize(trainCandles, { ...precomputerOptions, seed: runSeed }, simulatorOptions);
    console.log(''); // newline after progress

    if (!bestResult || result.bestChromosome.fitness > bestResult.bestChromosome.fitness) {
      bestResult = result;
    }
  }

  const gaElapsed = ((Date.now() - gaStartTime) / 1000).toFixed(1);
  console.log(chalk.green(`\nGA complete in ${gaElapsed}s`));

  const { bestChromosome, generationHistory, precomputer, signalStats } = bestResult;

  // ── Training Results ──

  console.log(chalk.blue.bold('\n--- Training Results ---'));
  printMetrics(bestChromosome.metrics);

  // ── Test Evaluation ──

  console.log(chalk.yellow('\nEvaluating on test set...'));

  // Re-precompute signal matrix on test data (fresh DC engines)
  const testPrecomputer = new SignalPrecomputer({ ...precomputerOptions });
  const { matrix: testMatrix, numGenes } = testPrecomputer.compute(testCandles);
  const testSimulator = new LightweightSimulator(simulatorOptions);
  const testResult = testSimulator.evaluate(testCandles, testMatrix, bestChromosome.genes, numGenes);

  console.log(chalk.blue.bold('\n--- Test Results ---'));
  printMetrics(testResult);

  // ── Walk-Forward Validation ──

  let walkForwardResults = null;
  if (args.walkForward) {
    console.log(chalk.yellow('\nRunning walk-forward validation (quarterly expanding-window)...'));
    walkForwardResults = runWalkForward(candles, precomputerOptions, simulatorOptions, args);
  }

  // ── Active Genes ──

  const labels = precomputer.getGeneLabels();
  const activeGenes = [];
  for (let i = 0; i < bestChromosome.genes.length; i++) {
    if (bestChromosome.genes[i] > 0.01) {
      activeGenes.push({
        index: i,
        label: labels[i],
        weight: Math.round(bestChromosome.genes[i] * 1000) / 1000
      });
    }
  }
  activeGenes.sort((a, b) => b.weight - a.weight);

  console.log(chalk.blue.bold(`\n--- Active Genes (${activeGenes.length} / ${bestChromosome.genes.length}) ---`));
  for (const g of activeGenes.slice(0, 20)) {
    const bar = '|'.repeat(Math.round(g.weight * 40));
    console.log(chalk.white(`  ${g.label.padEnd(18)} ${g.weight.toFixed(3)} ${chalk.green(bar)}`));
  }
  if (activeGenes.length > 20) {
    console.log(chalk.gray(`  ... and ${activeGenes.length - 20} more`));
  }

  // ── Signal Stats ──

  console.log(chalk.blue.bold('\n--- Signal Distribution ---'));
  let totalBuy = 0, totalSell = 0, totalHold = 0;
  for (const label of labels) {
    const s = signalStats[label];
    totalBuy += s.buy;
    totalSell += s.sell;
    totalHold += s.hold;
  }
  console.log(chalk.white(`  Total: Buy=${totalBuy}, Sell=${totalSell}, Hold=${totalHold}`));

  // ── Output JSON ──

  const outputPath = args.output || `dc-mstgam-${ticker}-${args.start}-to-${args.end}-seed${args.seed}.json`;

  const output = {
    version: '1.2',
    config: {
      ticker,
      startDate: args.start,
      endDate: args.end,
      trainPct: args.trainPct,
      timeframe: args.timeframe,
      futuresPreset: args.futuresPreset || false,
      fitnessMode: args.fitnessMode,
      minTrades: args.minTrades,
      confirmThreshold: args.confirmThreshold,
      cooldownCandles: args.cooldown,
      minNonHoldVotes: args.minVotes,
      maxTradesPerDay: args.maxTradesDay,
      thresholdsSt1_6: precomputer.thresholdsSt1_6,
      thresholdsSt7_8: precomputer.thresholdsSt7_8,
      usePoints: precomputerOptions.usePoints,
      gaParams: {
        populationSize: args.pop,
        generations: args.gen,
        tournamentSize: args.tournament,
        crossoverRate: args.crossover,
        mutationRate: args.mutation,
        seed: args.seed,
        runs: args.runs
      },
      tradeParams: {
        stopLossPoints: args.stopLoss,
        takeProfitPoints: args.takeProfit,
        slippage: args.slippage,
        commission: args.commission,
        pointValue,
        cooldownCandles: args.cooldown,
        minNonHoldVotes: args.minVotes,
        maxTradesPerDay: args.maxTradesDay
      },
      dcParams: {
        entryMultiplier: precomputerOptions.entryMultiplier,
        durationMultiplier: precomputerOptions.durationMultiplier,
        rdThreshold: precomputerOptions.rdThreshold,
        consecutiveCount: precomputerOptions.consecutiveCount
      },
      allowedSessions
    },
    bestWeights: Array.from(bestChromosome.genes),
    geneLabels: labels,
    trainResults: bestChromosome.metrics,
    testResults: {
      sharpeRatio: testResult.sharpeRatio,
      totalPnL: testResult.totalPnL,
      winRate: testResult.winRate,
      numTrades: testResult.numTrades,
      maxDrawdown: testResult.maxDrawdown
    },
    walkForwardResults,
    generationHistory,
    signalStats,
    activeGenes
  };

  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(chalk.green(`\nResults saved to ${outputPath}`));
}

function runWalkForward(candles, precomputerOptions, simulatorOptions, args) {
  // Split candles into quarters by date
  const startMs = new Date(candles[0].timestamp).getTime();
  const endMs = new Date(candles[candles.length - 1].timestamp).getTime();
  const rangeMs = endMs - startMs;
  const quarterMs = rangeMs / 4;

  const quarterBounds = [];
  for (let q = 0; q < 4; q++) {
    const qStart = startMs + q * quarterMs;
    const qEnd = q === 3 ? endMs + 1 : startMs + (q + 1) * quarterMs;
    quarterBounds.push({ start: qStart, end: qEnd });
  }

  // Split candles into quarters
  const quarters = [[], [], [], []];
  for (const candle of candles) {
    const ts = new Date(candle.timestamp).getTime();
    for (let q = 0; q < 4; q++) {
      if (ts >= quarterBounds[q].start && ts < quarterBounds[q].end) {
        quarters[q].push(candle);
        break;
      }
    }
  }

  const splits = [
    { name: 'Q1→Q2', train: [...quarters[0]], test: quarters[1] },
    { name: 'Q1-Q2→Q3', train: [...quarters[0], ...quarters[1]], test: quarters[2] },
    { name: 'Q1-Q3→Q4', train: [...quarters[0], ...quarters[1], ...quarters[2]], test: quarters[3] }
  ];

  const results = [];

  for (const split of splits) {
    if (split.train.length === 0 || split.test.length === 0) {
      console.log(chalk.red(`  ${split.name}: skipped (no data)`));
      continue;
    }

    console.log(chalk.yellow(`  ${split.name}: train=${split.train.length} candles, test=${split.test.length} candles`));

    const optimizer = new MSTGAMOptimizer({
      populationSize: args.pop,
      generations: args.gen,
      tournamentSize: args.tournament,
      crossoverRate: args.crossover,
      mutationRate: args.mutation,
      fitnessMode: args.fitnessMode,
      minTradeCount: args.minTrades,
      seed: args.seed,
      onProgress: (gen, totalGens, bestFitness) => {
        const pct = ((gen / totalGens) * 100).toFixed(0);
        process.stdout.write(`\r    Training ${pct}% | Best: ${bestFitness.toFixed(4)}`);
      }
    });

    const trainResult = optimizer.optimize(split.train, precomputerOptions, simulatorOptions);
    console.log('');

    // Evaluate on test split
    const testPrecomputer = new SignalPrecomputer(precomputerOptions);
    const { matrix: testMatrix, numGenes } = testPrecomputer.compute(split.test);
    const testSimulator = new LightweightSimulator(simulatorOptions);
    const testResult = testSimulator.evaluate(split.test, testMatrix, trainResult.bestChromosome.genes, numGenes);

    const splitResult = {
      name: split.name,
      trainCandles: split.train.length,
      testCandles: split.test.length,
      trainSharpe: trainResult.bestChromosome.metrics.sharpeRatio,
      trainPnL: trainResult.bestChromosome.metrics.totalPnL,
      testSharpe: testResult.sharpeRatio,
      testPnL: testResult.totalPnL,
      testWinRate: testResult.winRate,
      testTrades: testResult.numTrades,
      testMaxDD: testResult.maxDrawdown
    };

    results.push(splitResult);

    const color = testResult.sharpeRatio > 0 ? chalk.green : chalk.red;
    console.log(color(`    Test: Sharpe=${testResult.sharpeRatio.toFixed(4)}, PnL=$${testResult.totalPnL.toFixed(0)}, Trades=${testResult.numTrades}, WR=${(testResult.winRate * 100).toFixed(1)}%`));
  }

  // Summary
  const positiveSplits = results.filter(r => r.testSharpe > 0).length;
  console.log(chalk.blue.bold(`\n  Walk-Forward Summary: ${positiveSplits}/${results.length} splits with positive test Sharpe`));
  if (positiveSplits >= 2) {
    console.log(chalk.green.bold('  GO — Strategy shows out-of-sample robustness'));
  } else {
    console.log(chalk.red.bold('  NO-GO — Strategy does not generalize well'));
  }

  return { splits: results, positiveSplits, totalSplits: results.length };
}

function printMetrics(metrics) {
  console.log(chalk.white(`  Sharpe Ratio:  ${metrics.sharpeRatio?.toFixed(4) || 'N/A'}`));
  console.log(chalk.white(`  Total PnL:     $${metrics.totalPnL?.toFixed(2) || 'N/A'}`));
  console.log(chalk.white(`  Win Rate:      ${((metrics.winRate || 0) * 100).toFixed(1)}%`));
  console.log(chalk.white(`  Trades:        ${metrics.numTrades || 0}`));
  console.log(chalk.white(`  Max Drawdown:  $${metrics.maxDrawdown?.toFixed(2) || 'N/A'}`));
}

main().catch(err => {
  console.error(chalk.red('\nFatal error:'), err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
