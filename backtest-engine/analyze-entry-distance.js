#!/usr/bin/env node
/**
 * Analyze Entry Distance from Gamma Flip
 *
 * Examines the distribution of entry distances and their impact on R/R and win rate.
 * Goal: Find optimal distance thresholds to filter out bad R/R trades.
 */

import { BacktestEngine } from './src/backtest-engine.js';
import fs from 'fs';

// Run a detailed backtest that captures trade-level data
const testPeriod = { name: 'Full 2025', startDate: '2025-01-13', endDate: '2025-12-24' };

const baselineParams = {
  tradingSymbol: 'NQ',
  defaultQuantity: 1,
  stopBuffer: 30.0,
  maxRisk: 200.0,
  useGexLevelStops: false,
  targetMode: 'gamma_flip',
  fixedTargetPoints: 30.0,
  useTrailingStop: false,
  signalCooldownMs: 0,
  requirePositiveGex: false,
  useTimeFilter: false,
  useSentimentFilter: false,
  useDistanceFilter: false,
  useIvFilter: false,
  allowLong: true,
  allowShort: false
};

async function runAnalysis() {
  console.log('='.repeat(100));
  console.log('ENTRY DISTANCE ANALYSIS - Contrarian Bounce Strategy');
  console.log('='.repeat(100));

  const config = {
    ticker: 'NQ',
    startDate: new Date(testPeriod.startDate),
    endDate: new Date(testPeriod.endDate),
    timeframe: '15m',
    strategy: 'contrarian-bounce',
    strategyParams: baselineParams,
    commission: 5,
    initialCapital: 100000,
    dataDir: 'data',
    quiet: true,
    showTrades: false
  };

  const engine = new BacktestEngine(config);
  const results = await engine.run();

  if (!results || !results.trades || results.trades.length === 0) {
    console.log('No trades to analyze');
    return;
  }

  const trades = results.trades;
  console.log(`\nTotal trades: ${trades.length}`);

  // Extract distance data from each trade
  const tradeAnalysis = trades.map(trade => {
    const entryPrice = trade.entryPrice;
    const gammaFlip = trade.signal?.metadata?.gamma_flip || trade.metadata?.gamma_flip;
    const stopLoss = trade.stopLoss;
    const takeProfit = trade.takeProfit;
    const pnl = trade.netPnL || trade.grossPnL || 0;
    const exitReason = trade.exitReason || 'unknown';

    // Calculate distances
    const distanceFromFlip = gammaFlip ? gammaFlip - entryPrice : null;
    const riskPoints = entryPrice - stopLoss;
    const rewardPoints = takeProfit ? takeProfit - entryPrice : null;
    const rrRatio = (riskPoints > 0 && rewardPoints) ? rewardPoints / riskPoints : null;

    return {
      entryTime: trade.entryTime,
      entryPrice,
      gammaFlip,
      distanceFromFlip,
      stopLoss,
      takeProfit,
      riskPoints,
      rewardPoints,
      rrRatio,
      pnl,
      exitReason,
      isWinner: pnl > 0,
      pointsPnL: trade.pointsPnL || 0
    };
  }).filter(t => t.distanceFromFlip !== null);

  console.log(`Trades with distance data: ${tradeAnalysis.length}`);

  // === DISTANCE DISTRIBUTION ===
  console.log('\n' + '='.repeat(100));
  console.log('DISTANCE DISTRIBUTION (Points Below Gamma Flip at Entry)');
  console.log('='.repeat(100));

  const distanceBuckets = [
    { min: 0, max: 10, label: '0-10 pts' },
    { min: 10, max: 20, label: '10-20 pts' },
    { min: 20, max: 30, label: '20-30 pts' },
    { min: 30, max: 50, label: '30-50 pts' },
    { min: 50, max: 75, label: '50-75 pts' },
    { min: 75, max: 100, label: '75-100 pts' },
    { min: 100, max: 150, label: '100-150 pts' },
    { min: 150, max: 9999, label: '150+ pts' }
  ];

  console.log('\nBucket         | Trades | Win Rate |  Avg P&L  |  Total P&L  | Avg R:R | Avg Distance');
  console.log('-'.repeat(100));

  for (const bucket of distanceBuckets) {
    const bucketTrades = tradeAnalysis.filter(t =>
      t.distanceFromFlip >= bucket.min && t.distanceFromFlip < bucket.max
    );

    if (bucketTrades.length === 0) continue;

    const winners = bucketTrades.filter(t => t.isWinner).length;
    const winRate = (winners / bucketTrades.length * 100).toFixed(1);
    const totalPnl = bucketTrades.reduce((sum, t) => sum + t.pnl, 0);
    const avgPnl = totalPnl / bucketTrades.length;
    const avgRR = bucketTrades.filter(t => t.rrRatio).reduce((sum, t) => sum + t.rrRatio, 0) / bucketTrades.filter(t => t.rrRatio).length;
    const avgDist = bucketTrades.reduce((sum, t) => sum + t.distanceFromFlip, 0) / bucketTrades.length;

    console.log(
      `${bucket.label.padEnd(14)} | ${String(bucketTrades.length).padStart(6)} | ${winRate.padStart(6)}% | $${avgPnl.toFixed(0).padStart(8)} | $${totalPnl.toFixed(0).padStart(10)} | ${avgRR.toFixed(2).padStart(6)} | ${avgDist.toFixed(1).padStart(6)} pts`
    );
  }

  // === R/R RATIO ANALYSIS ===
  console.log('\n' + '='.repeat(100));
  console.log('RISK/REWARD RATIO ANALYSIS');
  console.log('='.repeat(100));

  const rrBuckets = [
    { min: 0, max: 0.5, label: 'R:R < 0.5' },
    { min: 0.5, max: 1.0, label: 'R:R 0.5-1.0' },
    { min: 1.0, max: 1.5, label: 'R:R 1.0-1.5' },
    { min: 1.5, max: 2.0, label: 'R:R 1.5-2.0' },
    { min: 2.0, max: 3.0, label: 'R:R 2.0-3.0' },
    { min: 3.0, max: 5.0, label: 'R:R 3.0-5.0' },
    { min: 5.0, max: 9999, label: 'R:R 5.0+' }
  ];

  console.log('\nR:R Bucket     | Trades | Win Rate |  Avg P&L  |  Total P&L  | Avg Distance');
  console.log('-'.repeat(100));

  for (const bucket of rrBuckets) {
    const bucketTrades = tradeAnalysis.filter(t =>
      t.rrRatio !== null && t.rrRatio >= bucket.min && t.rrRatio < bucket.max
    );

    if (bucketTrades.length === 0) continue;

    const winners = bucketTrades.filter(t => t.isWinner).length;
    const winRate = (winners / bucketTrades.length * 100).toFixed(1);
    const totalPnl = bucketTrades.reduce((sum, t) => sum + t.pnl, 0);
    const avgPnl = totalPnl / bucketTrades.length;
    const avgDist = bucketTrades.reduce((sum, t) => sum + t.distanceFromFlip, 0) / bucketTrades.length;

    console.log(
      `${bucket.label.padEnd(14)} | ${String(bucketTrades.length).padStart(6)} | ${winRate.padStart(6)}% | $${avgPnl.toFixed(0).padStart(8)} | $${totalPnl.toFixed(0).padStart(10)} | ${avgDist.toFixed(1).padStart(6)} pts`
    );
  }

  // === EXIT REASON ANALYSIS ===
  console.log('\n' + '='.repeat(100));
  console.log('EXIT REASON ANALYSIS');
  console.log('='.repeat(100));

  const exitReasons = {};
  for (const trade of tradeAnalysis) {
    const reason = trade.exitReason;
    if (!exitReasons[reason]) {
      exitReasons[reason] = { count: 0, totalPnl: 0, winners: 0 };
    }
    exitReasons[reason].count++;
    exitReasons[reason].totalPnl += trade.pnl;
    if (trade.isWinner) exitReasons[reason].winners++;
  }

  console.log('\nExit Reason          | Trades | Win Rate |  Total P&L  |  Avg P&L');
  console.log('-'.repeat(80));

  for (const [reason, data] of Object.entries(exitReasons).sort((a, b) => b[1].count - a[1].count)) {
    const winRate = (data.winners / data.count * 100).toFixed(1);
    const avgPnl = data.totalPnl / data.count;
    console.log(
      `${reason.padEnd(20)} | ${String(data.count).padStart(6)} | ${winRate.padStart(6)}% | $${data.totalPnl.toFixed(0).padStart(10)} | $${avgPnl.toFixed(0).padStart(8)}`
    );
  }

  // === CUMULATIVE P&L BY MINIMUM DISTANCE THRESHOLD ===
  console.log('\n' + '='.repeat(100));
  console.log('CUMULATIVE P&L BY MINIMUM DISTANCE THRESHOLD');
  console.log('(Shows what happens if we require minimum X points below gamma flip)');
  console.log('='.repeat(100));

  console.log('\nMin Distance | Trades | Win Rate |  Total P&L  | Avg P&L | Avg R:R');
  console.log('-'.repeat(80));

  for (let minDist = 0; minDist <= 100; minDist += 10) {
    const filteredTrades = tradeAnalysis.filter(t => t.distanceFromFlip >= minDist);

    if (filteredTrades.length === 0) continue;

    const winners = filteredTrades.filter(t => t.isWinner).length;
    const winRate = (winners / filteredTrades.length * 100).toFixed(1);
    const totalPnl = filteredTrades.reduce((sum, t) => sum + t.pnl, 0);
    const avgPnl = totalPnl / filteredTrades.length;
    const avgRR = filteredTrades.filter(t => t.rrRatio).reduce((sum, t) => sum + t.rrRatio, 0) / filteredTrades.filter(t => t.rrRatio).length;

    console.log(
      `${String(minDist).padStart(8)} pts | ${String(filteredTrades.length).padStart(6)} | ${winRate.padStart(6)}% | $${totalPnl.toFixed(0).padStart(10)} | $${avgPnl.toFixed(0).padStart(6)} | ${avgRR.toFixed(2).padStart(6)}`
    );
  }

  // === SAMPLE LOSING TRADES (CLOSE TO GAMMA FLIP) ===
  console.log('\n' + '='.repeat(100));
  console.log('SAMPLE LOSING TRADES (Distance < 20 pts)');
  console.log('='.repeat(100));

  const closeLosers = tradeAnalysis
    .filter(t => !t.isWinner && t.distanceFromFlip < 20)
    .slice(0, 15);

  console.log('\nEntry Time                | Entry    | Gamma Flip | Distance | R:R   | P&L     | Exit Reason');
  console.log('-'.repeat(100));

  for (const trade of closeLosers) {
    const entryTime = new Date(trade.entryTime).toISOString().slice(0, 19);
    console.log(
      `${entryTime} | ${trade.entryPrice.toFixed(2).padStart(8)} | ${trade.gammaFlip.toFixed(2).padStart(10)} | ${trade.distanceFromFlip.toFixed(1).padStart(8)} | ${(trade.rrRatio || 0).toFixed(2).padStart(5)} | $${trade.pnl.toFixed(0).padStart(6)} | ${trade.exitReason}`
    );
  }

  // === SAMPLE WINNING TRADES (FAR FROM GAMMA FLIP) ===
  console.log('\n' + '='.repeat(100));
  console.log('SAMPLE WINNING TRADES (Distance > 50 pts)');
  console.log('='.repeat(100));

  const farWinners = tradeAnalysis
    .filter(t => t.isWinner && t.distanceFromFlip > 50)
    .slice(0, 15);

  console.log('\nEntry Time                | Entry    | Gamma Flip | Distance | R:R   | P&L     | Exit Reason');
  console.log('-'.repeat(100));

  for (const trade of farWinners) {
    const entryTime = new Date(trade.entryTime).toISOString().slice(0, 19);
    console.log(
      `${entryTime} | ${trade.entryPrice.toFixed(2).padStart(8)} | ${trade.gammaFlip.toFixed(2).padStart(10)} | ${trade.distanceFromFlip.toFixed(1).padStart(8)} | ${(trade.rrRatio || 0).toFixed(2).padStart(5)} | $${trade.pnl.toFixed(0).padStart(6)} | ${trade.exitReason}`
    );
  }

  // Save detailed analysis to JSON
  const outputPath = './results/entry-distance-analysis.json';
  const outputData = {
    analysisDate: new Date().toISOString(),
    totalTrades: tradeAnalysis.length,
    distanceBucketStats: distanceBuckets.map(bucket => {
      const bucketTrades = tradeAnalysis.filter(t =>
        t.distanceFromFlip >= bucket.min && t.distanceFromFlip < bucket.max
      );
      return {
        bucket: bucket.label,
        trades: bucketTrades.length,
        winRate: bucketTrades.length > 0 ? (bucketTrades.filter(t => t.isWinner).length / bucketTrades.length * 100) : 0,
        totalPnl: bucketTrades.reduce((sum, t) => sum + t.pnl, 0),
        avgRR: bucketTrades.filter(t => t.rrRatio).length > 0
          ? bucketTrades.filter(t => t.rrRatio).reduce((sum, t) => sum + t.rrRatio, 0) / bucketTrades.filter(t => t.rrRatio).length
          : 0
      };
    }),
    minDistanceThresholds: Array.from({ length: 11 }, (_, i) => i * 10).map(minDist => {
      const filteredTrades = tradeAnalysis.filter(t => t.distanceFromFlip >= minDist);
      return {
        minDistance: minDist,
        trades: filteredTrades.length,
        winRate: filteredTrades.length > 0 ? (filteredTrades.filter(t => t.isWinner).length / filteredTrades.length * 100) : 0,
        totalPnl: filteredTrades.reduce((sum, t) => sum + t.pnl, 0)
      };
    })
  };

  fs.writeFileSync(outputPath, JSON.stringify(outputData, null, 2));
  console.log(`\nDetailed analysis saved to: ${outputPath}`);
}

runAnalysis().catch(console.error);
