#!/usr/bin/env node
/**
 * Momentum Confirmation Analysis
 *
 * Goal: Determine if squeeze/RSI/MACD at entry predict outcome
 *
 * Analysis:
 * 1. Calculate squeeze state at entry (squeeze_on/off/no_squeeze)
 * 2. Calculate RSI at entry (overbought/oversold/neutral)
 * 3. Calculate MACD histogram direction at entry
 * 4. Correlate each with win rate and P&L
 * 5. Find optimal momentum conditions for entry
 *
 * Hypothesis: Entries with momentum confirmation outperform.
 */

import {
  loadTrades,
  loadNQOHLCV,
  getCandlesAround
} from './utils/data-loader.js';

import {
  calculatePerformance,
  bucket,
  correlation,
  round,
  saveResults,
  analyzeDimension,
  formatCurrency,
  sma,
  roc
} from './utils/analysis-helpers.js';

// RSI calculation
function calculateRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;

  let gains = 0;
  let losses = 0;

  // Calculate first average
  for (let i = closes.length - period; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }

  const avgGain = gains / period;
  const avgLoss = losses / period;

  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;
  return round(100 - (100 / (1 + rs)), 2);
}

// MACD calculation
function calculateMACD(closes, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
  if (closes.length < slowPeriod + signalPeriod) return null;

  // Calculate EMAs
  const emaFast = calculateEMA(closes, fastPeriod);
  const emaSlow = calculateEMA(closes, slowPeriod);

  if (emaFast === null || emaSlow === null) return null;

  const macdLine = emaFast - emaSlow;

  // For histogram, we'd need full MACD line history - simplify for now
  return {
    macd: round(macdLine, 2),
    direction: macdLine > 0 ? 'bullish' : 'bearish'
  };
}

function calculateEMA(values, period) {
  if (values.length < period) return null;

  const multiplier = 2 / (period + 1);
  let ema = sma(values.slice(0, period), period);

  for (let i = period; i < values.length; i++) {
    ema = (values[i] - ema) * multiplier + ema;
  }

  return ema;
}

// Squeeze detection (simplified - BB inside KC)
function detectSqueeze(candles, bbPeriod = 20, bbMult = 2, kcPeriod = 20, kcMult = 1.5) {
  if (candles.length < Math.max(bbPeriod, kcPeriod) + 1) return null;

  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);

  // Bollinger Bands
  const bbSMA = sma(closes, bbPeriod);
  const stdDev = calculateStdDev(closes.slice(-bbPeriod), bbPeriod);
  const bbUpper = bbSMA + (bbMult * stdDev);
  const bbLower = bbSMA - (bbMult * stdDev);

  // Keltner Channels (simplified using ATR approximation)
  const kcSMA = sma(closes, kcPeriod);
  const ranges = [];
  for (let i = 1; i < candles.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    ranges.push(tr);
  }
  const atr = sma(ranges, kcPeriod);
  const kcUpper = kcSMA + (kcMult * atr);
  const kcLower = kcSMA - (kcMult * atr);

  // Squeeze conditions
  const squeezeOn = bbLower > kcLower && bbUpper < kcUpper;
  const squeezeOff = bbLower < kcLower && bbUpper > kcUpper;

  let state = 'no_squeeze';
  if (squeezeOn) state = 'squeeze_on';
  else if (squeezeOff) state = 'squeeze_off';

  return {
    state,
    squeezeOn,
    squeezeOff,
    bbWidth: round(bbUpper - bbLower, 2),
    kcWidth: round(kcUpper - kcLower, 2)
  };
}

function calculateStdDev(values, period) {
  if (values.length < period) return 0;

  const mean = values.reduce((a, b) => a + b, 0) / period;
  const squaredDiffs = values.map(v => Math.pow(v - mean, 2));
  return Math.sqrt(squaredDiffs.reduce((a, b) => a + b, 0) / period);
}

async function runAnalysis() {
  console.log('='.repeat(70));
  console.log('  Momentum Confirmation Analysis');
  console.log('='.repeat(70));
  console.log();

  // Load data
  console.log('Loading data...');
  const trades = await loadTrades();
  const ohlcv = await loadNQOHLCV('2025-01-01', '2025-12-31');

  console.log();

  // Calculate momentum indicators at each trade entry
  const tradesWithMomentum = [];

  for (const trade of trades) {
    // Get candles leading up to entry
    const candles = getCandlesAround(ohlcv, trade.entryTime, 30, 0);

    if (candles.length < 30) continue;

    const closes = candles.map(c => c.close);

    // Calculate RSI
    const rsi = calculateRSI(closes);
    let rsiZone = 'neutral';
    if (rsi !== null) {
      if (rsi >= 70) rsiZone = 'overbought';
      else if (rsi >= 60) rsiZone = 'slightly_overbought';
      else if (rsi <= 30) rsiZone = 'oversold';
      else if (rsi <= 40) rsiZone = 'slightly_oversold';
    }

    // Calculate MACD
    const macd = calculateMACD(closes);

    // Detect squeeze
    const squeeze = detectSqueeze(candles);

    // Calculate momentum (rate of change)
    const roc5 = roc(closes, 5);
    const roc10 = roc(closes, 10);
    const roc20 = roc(closes, 20);

    // Determine momentum direction
    let momentumDir = 'neutral';
    if (roc5 > 0.1 && roc10 > 0.1) momentumDir = 'bullish';
    else if (roc5 < -0.1 && roc10 < -0.1) momentumDir = 'bearish';

    // Momentum alignment with trade direction
    let momentumAlignment = 'neutral';
    if (momentumDir === 'bullish' && trade.side === 'buy') momentumAlignment = 'aligned';
    else if (momentumDir === 'bearish' && trade.side === 'sell') momentumAlignment = 'aligned';
    else if (momentumDir !== 'neutral') momentumAlignment = 'counter';

    tradesWithMomentum.push({
      ...trade,
      rsi,
      rsiZone,
      macd: macd?.macd || null,
      macdDirection: macd?.direction || 'unknown',
      squeezeState: squeeze?.state || 'unknown',
      roc5: round(roc5 || 0, 2),
      roc10: round(roc10 || 0, 2),
      momentumDir,
      momentumAlignment
    });
  }

  console.log(`Analyzed momentum for ${tradesWithMomentum.length} trades\n`);

  // Analysis 1: Squeeze State Performance
  console.log('1. Performance by Squeeze State');
  console.log('-'.repeat(50));

  const squeezeAnalysis = analyzeDimension(tradesWithMomentum, 'squeezeState', 'Squeeze State');

  squeezeAnalysis.groups.forEach(g => {
    console.log(`  ${g.name.padEnd(15)}: ${g.tradeCount} trades, ${g.winRate}% WR, ${formatCurrency(g.avgPnL)} avg`);
  });

  // Analysis 2: RSI Zone Performance
  console.log('\n2. Performance by RSI Zone');
  console.log('-'.repeat(50));

  const rsiAnalysis = analyzeDimension(tradesWithMomentum, 'rsiZone', 'RSI Zone');

  rsiAnalysis.groups.forEach(g => {
    console.log(`  ${g.name.padEnd(20)}: ${g.tradeCount} trades, ${g.winRate}% WR, ${formatCurrency(g.avgPnL)} avg`);
  });

  // Analysis 3: MACD Direction Performance
  console.log('\n3. Performance by MACD Direction');
  console.log('-'.repeat(50));

  const macdAnalysis = analyzeDimension(tradesWithMomentum, 'macdDirection', 'MACD Direction');

  macdAnalysis.groups.forEach(g => {
    console.log(`  ${g.name.padEnd(12)}: ${g.tradeCount} trades, ${g.winRate}% WR, ${formatCurrency(g.avgPnL)} avg`);
  });

  // Analysis 4: Momentum Alignment Performance
  console.log('\n4. Performance by Momentum Alignment');
  console.log('-'.repeat(50));

  const alignAnalysis = analyzeDimension(tradesWithMomentum, 'momentumAlignment', 'Momentum Alignment');

  alignAnalysis.groups.forEach(g => {
    console.log(`  ${g.name.padEnd(12)}: ${g.tradeCount} trades, ${g.winRate}% WR, ${formatCurrency(g.totalPnL)} total`);
  });

  // Analysis 5: Momentum Direction Performance
  console.log('\n5. Performance by Momentum Direction');
  console.log('-'.repeat(50));

  const momDirAnalysis = analyzeDimension(tradesWithMomentum, 'momentumDir', 'Momentum Direction');

  momDirAnalysis.groups.forEach(g => {
    console.log(`  ${g.name.padEnd(12)}: ${g.tradeCount} trades, ${g.winRate}% WR, ${formatCurrency(g.avgPnL)} avg`);
  });

  // Analysis 6: RSI + Trade Direction
  console.log('\n6. RSI Analysis by Trade Direction');
  console.log('-'.repeat(50));

  for (const direction of ['buy', 'sell']) {
    const subset = tradesWithMomentum.filter(t => t.side === direction);

    console.log(`  ${direction.toUpperCase()}S:`);

    for (const zone of ['overbought', 'slightly_overbought', 'neutral', 'slightly_oversold', 'oversold']) {
      const zoneSubset = subset.filter(t => t.rsiZone === zone);
      if (zoneSubset.length >= 10) {
        const perf = calculatePerformance(zoneSubset);
        console.log(`    ${zone.padEnd(20)}: ${perf.tradeCount} trades, ${perf.winRate}% WR`);
      }
    }
  }

  // Analysis 7: Combined Momentum Conditions
  console.log('\n7. Combined Momentum Analysis');
  console.log('-'.repeat(50));

  // Aligned momentum + squeeze releasing
  const alignedSqueezeOff = tradesWithMomentum.filter(
    t => t.momentumAlignment === 'aligned' && t.squeezeState === 'squeeze_off'
  );
  if (alignedSqueezeOff.length >= 5) {
    const perf = calculatePerformance(alignedSqueezeOff);
    console.log(`  Aligned + Squeeze Off: ${perf.tradeCount} trades, ${perf.winRate}% WR, ${formatCurrency(perf.avgPnL)} avg`);
  }

  // Counter-trend with oversold/overbought
  const counterOversold = tradesWithMomentum.filter(
    t => t.side === 'buy' && (t.rsiZone === 'oversold' || t.rsiZone === 'slightly_oversold')
  );
  if (counterOversold.length >= 5) {
    const perf = calculatePerformance(counterOversold);
    console.log(`  Buy when RSI oversold: ${perf.tradeCount} trades, ${perf.winRate}% WR, ${formatCurrency(perf.avgPnL)} avg`);
  }

  const counterOverbought = tradesWithMomentum.filter(
    t => t.side === 'sell' && (t.rsiZone === 'overbought' || t.rsiZone === 'slightly_overbought')
  );
  if (counterOverbought.length >= 5) {
    const perf = calculatePerformance(counterOverbought);
    console.log(`  Sell when RSI overbought: ${perf.tradeCount} trades, ${perf.winRate}% WR, ${formatCurrency(perf.avgPnL)} avg`);
  }

  // Correlations
  console.log('\n8. Correlation Analysis');
  console.log('-'.repeat(50));

  const validTrades = tradesWithMomentum.filter(t => t.rsi !== null);
  const rsis = validTrades.map(t => t.rsi);
  const pnls = validTrades.map(t => t.netPnL);
  const roc5s = validTrades.map(t => t.roc5);

  console.log(`  RSI vs P&L correlation:   ${correlation(rsis, pnls)}`);
  console.log(`  ROC(5) vs P&L correlation: ${correlation(roc5s, pnls)}`);

  // Compile results
  const results = {
    analysis: 'Momentum Confirmation Analysis',
    timestamp: new Date().toISOString(),
    summary: {
      totalTrades: tradesWithMomentum.length,
      hypothesis: 'Entries with momentum confirmation outperform',
      finding: 'See recommendations'
    },
    correlations: {
      rsiVsPnL: correlation(rsis, pnls),
      rocVsPnL: correlation(roc5s, pnls)
    },
    bySqueezeState: squeezeAnalysis.groups,
    byRSIZone: rsiAnalysis.groups,
    byMACDDirection: macdAnalysis.groups,
    byMomentumAlignment: alignAnalysis.groups,
    byMomentumDirection: momDirAnalysis.groups,
    recommendations: []
  };

  // Generate recommendations
  const alignedPerf = alignAnalysis.groups.find(g => g.name === 'aligned');
  const counterPerf = alignAnalysis.groups.find(g => g.name === 'counter');

  if (alignedPerf && counterPerf && alignedPerf.winRate > counterPerf.winRate + 5) {
    results.summary.finding = 'SUPPORTED - Momentum aligned trades outperform';
    results.recommendations.push(`Trade with momentum: ${alignedPerf.winRate}% vs ${counterPerf.winRate}% WR`);
  } else if (alignedPerf && counterPerf && counterPerf.winRate > alignedPerf.winRate + 5) {
    results.summary.finding = 'CONTRADICTED - Counter-momentum trades outperform';
    results.recommendations.push(`Consider counter-momentum entries`);
  } else {
    results.summary.finding = 'INCONCLUSIVE - No clear momentum edge';
  }

  const bestSqueeze = squeezeAnalysis.groups[0];
  if (bestSqueeze.winRate > 35) {
    results.recommendations.push(`Best squeeze state: ${bestSqueeze.name} with ${bestSqueeze.winRate}% WR`);
  }

  const bestRSI = rsiAnalysis.groups[0];
  if (bestRSI.winRate > 35) {
    results.recommendations.push(`Best RSI zone: ${bestRSI.name} with ${bestRSI.winRate}% WR`);
  }

  // Print summary
  console.log('\n' + '='.repeat(70));
  console.log('  SUMMARY');
  console.log('='.repeat(70));
  console.log(`  Hypothesis: ${results.summary.hypothesis}`);
  console.log(`  Finding: ${results.summary.finding}`);
  console.log();

  if (results.recommendations.length > 0) {
    console.log('  Recommendations:');
    results.recommendations.forEach(r => console.log(`    - ${r}`));
  }

  // Save results
  saveResults('05_momentum_analysis.json', results);

  return results;
}

runAnalysis().catch(console.error);
