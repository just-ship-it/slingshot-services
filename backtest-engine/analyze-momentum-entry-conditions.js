#!/usr/bin/env node

/**
 * Analyze Momentum Conditions at Entry Points
 *
 * This script examines the specific market conditions when losing trades
 * were entered to identify momentum/market structure patterns that could
 * help filter out bad trades.
 */

import fs from 'fs/promises';

const resultsFile = '/home/drew/projects/slingshot-services/backtest-engine/results/comprehensive_analysis_2026-/gex-ldpm-confluence-conservative_results.json';

async function analyzeMomentumConditions() {
  console.log('⚡ Analyzing Momentum Conditions at Entry Points');
  console.log('=' .repeat(80));
  console.log();

  try {
    const content = await fs.readFile(resultsFile, 'utf-8');
    const results = JSON.parse(content);

    const trades = results.trades;
    const losingTrades = trades.filter(t => t.grossPnL < 0);
    const winningTrades = trades.filter(t => t.grossPnL > 0);

    console.log('📊 Trade Overview:');
    console.log(`   Total: ${trades.length} | Winning: ${winningTrades.length} | Losing: ${losingTrades.length}`);
    console.log(`   Win Rate: ${(winningTrades.length / trades.length * 100).toFixed(1)}%`);
    console.log(`   Total P&L: $${trades.reduce((sum, t) => sum + t.grossPnL, 0).toFixed(2)}`);
    console.log();

    // Analyze entry conditions for losing vs winning trades
    console.log('🔍 ENTRY CONDITIONS ANALYSIS');
    console.log('-'.repeat(80));

    // Price action at entry (entry vs previous candle)
    const analyzeEntryMomentum = (tradeSet, label) => {
      const momentumStats = {
        favorableEntry: 0,    // Price moving toward target at entry
        unfavorableEntry: 0,  // Price moving against target at entry
        neutralEntry: 0,      // No clear momentum
        strongEntry: 0,       // Strong momentum (>10 points)
        weakEntry: 0          // Weak momentum (<5 points)
      };

      tradeSet.forEach(trade => {
        const entryPrice = trade.signal?.price || 0;
        const targetPrice = trade.signal?.take_profit || 0;
        const entryCandle = trade.entryCandle;

        if (entryCandle && entryPrice && targetPrice) {
          // Calculate momentum direction
          const candleMomentum = entryCandle.close - entryCandle.open;
          const targetDirection = trade.signal.side === 'buy' ? 'up' : 'down';
          const priceToTarget = Math.abs(entryPrice - targetPrice);

          // Check if momentum aligns with trade direction
          if (targetDirection === 'up' && candleMomentum > 0) {
            momentumStats.favorableEntry++;
          } else if (targetDirection === 'down' && candleMomentum < 0) {
            momentumStats.favorableEntry++;
          } else if (Math.abs(candleMomentum) < 2) {
            momentumStats.neutralEntry++;
          } else {
            momentumStats.unfavorableEntry++;
          }

          // Check momentum strength
          if (Math.abs(candleMomentum) > 10) {
            momentumStats.strongEntry++;
          } else if (Math.abs(candleMomentum) < 5) {
            momentumStats.weakEntry++;
          }
        }
      });

      console.log(`${label} Entry Momentum:`)
      console.log(`   Favorable Entry: ${momentumStats.favorableEntry} (${(momentumStats.favorableEntry/tradeSet.length*100).toFixed(1)}%)`);
      console.log(`   Unfavorable Entry: ${momentumStats.unfavorableEntry} (${(momentumStats.unfavorableEntry/tradeSet.length*100).toFixed(1)}%)`);
      console.log(`   Neutral Entry: ${momentumStats.neutralEntry} (${(momentumStats.neutralEntry/tradeSet.length*100).toFixed(1)}%)`);
      console.log(`   Strong Momentum: ${momentumStats.strongEntry} (${(momentumStats.strongEntry/tradeSet.length*100).toFixed(1)}%)`);
      console.log(`   Weak Momentum: ${momentumStats.weakEntry} (${(momentumStats.weakEntry/tradeSet.length*100).toFixed(1)}%)`);
      console.log();

      return momentumStats;
    };

    const losingMomentum = analyzeEntryMomentum(losingTrades, '🔴 LOSING');
    const winningMomentum = analyzeEntryMomentum(winningTrades, '🟢 WINNING');

    // Compare candle patterns at entry
    console.log('📈 ENTRY CANDLE ANALYSIS');
    console.log('-'.repeat(80));

    const analyzeCandlePatterns = (tradeSet, label) => {
      const patterns = {
        bullishCandle: 0,      // Close > Open
        bearishCandle: 0,      // Close < Open
        dojiCandle: 0,         // |Close - Open| < 2 points
        longWickUp: 0,         // Upper wick > 50% of body
        longWickDown: 0,       // Lower wick > 50% of body
        highVolume: 0,         // Above average volume (if available)
        insideCandle: 0,       // High < prev high and Low > prev low
        outsideCandle: 0       // High > prev high and Low < prev low
      };

      tradeSet.forEach(trade => {
        const candle = trade.entryCandle;
        if (candle) {
          const body = Math.abs(candle.close - candle.open);
          const upperWick = candle.high - Math.max(candle.open, candle.close);
          const lowerWick = Math.min(candle.open, candle.close) - candle.low;

          // Basic patterns
          if (candle.close > candle.open) patterns.bullishCandle++;
          else if (candle.close < candle.open) patterns.bearishCandle++;
          else patterns.dojiCandle++;

          if (body < 2) patterns.dojiCandle++;
          if (upperWick > body * 0.5) patterns.longWickUp++;
          if (lowerWick > body * 0.5) patterns.longWickDown++;

          // Volume analysis (if available)
          if (candle.volume) {
            const avgVolume = 1000; // Placeholder - would need historical average
            if (candle.volume > avgVolume * 1.5) patterns.highVolume++;
          }
        }
      });

      console.log(`${label} Candle Patterns:`);
      console.log(`   Bullish Candles: ${patterns.bullishCandle} (${(patterns.bullishCandle/tradeSet.length*100).toFixed(1)}%)`);
      console.log(`   Bearish Candles: ${patterns.bearishCandle} (${(patterns.bearishCandle/tradeSet.length*100).toFixed(1)}%)`);
      console.log(`   Doji/Small Body: ${patterns.dojiCandle} (${(patterns.dojiCandle/tradeSet.length*100).toFixed(1)}%)`);
      console.log(`   Long Upper Wick: ${patterns.longWickUp} (${(patterns.longWickUp/tradeSet.length*100).toFixed(1)}%)`);
      console.log(`   Long Lower Wick: ${patterns.longWickDown} (${(patterns.longWickDown/tradeSet.length*100).toFixed(1)}%)`);
      console.log(`   High Volume: ${patterns.highVolume} (${(patterns.highVolume/tradeSet.length*100).toFixed(1)}%)`);
      console.log();

      return patterns;
    };

    const losingPatterns = analyzeCandlePatterns(losingTrades, '🔴 LOSING');
    const winningPatterns = analyzeCandlePatterns(winningTrades, '🟢 WINNING');

    // Analyze specific problematic scenarios
    console.log('⚠️ PROBLEMATIC ENTRY SCENARIOS');
    console.log('-'.repeat(80));

    // Find trades that failed quickly (1-3 candles)
    const quickFailures = losingTrades.filter(t => (t.candlesSinceSignal || 0) <= 3);
    console.log(`Quick Failures (≤3 candles): ${quickFailures.length}/${losingTrades.length} (${(quickFailures.length/losingTrades.length*100).toFixed(1)}%)`);

    if (quickFailures.length > 0) {
      const quickFailureLoss = quickFailures.reduce((sum, t) => sum + t.grossPnL, 0);
      console.log(`   Total Loss from Quick Failures: $${quickFailureLoss.toFixed(2)}`);
      console.log(`   Average Loss per Quick Failure: $${(quickFailureLoss/quickFailures.length).toFixed(2)}`);

      // Analyze quick failure patterns
      const quickUnfavorable = quickFailures.filter(trade => {
        const candle = trade.entryCandle;
        const targetDirection = trade.signal?.side === 'buy' ? 'up' : 'down';
        if (!candle) return false;

        const momentum = candle.close - candle.open;
        return (targetDirection === 'up' && momentum < -2) ||
               (targetDirection === 'down' && momentum > 2);
      });

      console.log(`   Quick failures with unfavorable momentum: ${quickUnfavorable.length}/${quickFailures.length} (${(quickUnfavorable.length/quickFailures.length*100).toFixed(1)}%)`);
    }

    // Analyze regime vs sentiment mismatches
    console.log();
    console.log('🔄 REGIME vs SENTIMENT ANALYSIS');
    console.log('-'.repeat(80));

    const regimeMismatches = {
      positiveRegimeBearishLT: 0,
      negativeRegimeBullishLT: 0
    };

    losingTrades.forEach(trade => {
      const regime = trade.signal?.regime;
      const ltSentiment = trade.signal?.availableLTLevels?.sentiment;

      if (regime === 'positive' && ltSentiment === 'BEARISH') {
        regimeMismatches.positiveRegimeBearishLT++;
      } else if (regime === 'negative' && ltSentiment === 'BULLISH') {
        regimeMismatches.negativeRegimeBullishLT++;
      }
    });

    console.log('Regime/LT Sentiment Mismatches in Losing Trades:');
    console.log(`   Positive Regime + Bearish LT: ${regimeMismatches.positiveRegimeBearishLT}/${losingTrades.length} (${(regimeMismatches.positiveRegimeBearishLT/losingTrades.length*100).toFixed(1)}%)`);
    console.log(`   Negative Regime + Bullish LT: ${regimeMismatches.negativeRegimeBearishLT}/${losingTrades.length} (${(regimeMismatches.negativeRegimeBullishLT/losingTrades.length*100).toFixed(1)}%)`);

    console.log();
    console.log('💡 MOMENTUM-BASED FILTER RECOMMENDATIONS');
    console.log('-'.repeat(80));
    console.log('Based on the analysis, consider implementing these filters:');
    console.log();
    console.log('1. 📈 Entry Momentum Filter:');
    console.log('   - Require favorable candle momentum at entry (aligns with trade direction)');
    console.log('   - Avoid entries during counter-momentum candles');
    console.log();
    console.log('2. 🕯️ Candle Pattern Filter:');
    console.log('   - Avoid entries on doji candles or candles with excessive wicks');
    console.log('   - Prefer entries on directional candles with clean bodies');
    console.log();
    console.log('3. ⚡ Quick Failure Prevention:');
    console.log('   - Add a 1-candle momentum confirmation before entry');
    console.log('   - Require price to hold above/below confluence zone for 1 candle');
    console.log();
    console.log('4. 🔄 Regime Alignment Filter:');
    console.log('   - Weight trades higher when regime and LT sentiment align');
    console.log('   - Reduce position size or skip when they conflict');

  } catch (error) {
    console.error('❌ Error analyzing momentum conditions:', error.message);
  }
}

analyzeMomentumConditions().catch(console.error);