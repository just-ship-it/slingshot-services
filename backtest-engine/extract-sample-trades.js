#!/usr/bin/env node

/**
 * Extract Sample Losing Trades from Q4 2025
 *
 * Pulls specific losing trades from Oct-Dec 2025 timeframe
 * with all relevant details for chart analysis.
 */

import fs from 'fs/promises';

const resultsFile = '/home/drew/projects/slingshot-services/backtest-engine/results/comprehensive_analysis_2026-/gex-ldpm-confluence-conservative_results.json';

async function extractSampleTrades() {
  console.log('📋 Extracting Sample Losing Trades from Q4 2025');
  console.log('=' .repeat(80));
  console.log();

  try {
    const content = await fs.readFile(resultsFile, 'utf-8');
    const results = JSON.parse(content);

    const trades = results.trades;

    // Filter for Q4 2025 losing trades (Oct 1 - Dec 31, 2025)
    const q4Start = new Date('2025-10-01T00:00:00Z').getTime();
    const q4End = new Date('2025-12-31T23:59:59Z').getTime();

    const q4LosingTrades = trades.filter(trade => {
      const entryTime = trade.entryTime;
      return trade.grossPnL < 0 &&
             entryTime >= q4Start &&
             entryTime <= q4End;
    });

    console.log(`Found ${q4LosingTrades.length} losing trades in Q4 2025`);
    console.log();

    if (q4LosingTrades.length === 0) {
      console.log('❌ No losing trades found in Q4 2025 timeframe');
      return;
    }

    // Get 3 sample trades from different parts of Q4
    const sampleTrades = [];

    // Take trades from different months if possible
    const october = q4LosingTrades.filter(t => new Date(t.entryTime).getMonth() === 9); // October = month 9 (0-indexed)
    const november = q4LosingTrades.filter(t => new Date(t.entryTime).getMonth() === 10);
    const december = q4LosingTrades.filter(t => new Date(t.entryTime).getMonth() === 11);

    if (october.length > 0) sampleTrades.push(october[Math.floor(october.length / 2)]);
    if (november.length > 0) sampleTrades.push(november[Math.floor(november.length / 2)]);
    if (december.length > 0) sampleTrades.push(december[Math.floor(december.length / 2)]);

    // If we don't have enough, just take the last 3
    if (sampleTrades.length < 3) {
      sampleTrades.length = 0;
      sampleTrades.push(...q4LosingTrades.slice(-3));
    }

    console.log('📊 SAMPLE LOSING TRADES FROM Q4 2025');
    console.log('=' .repeat(80));

    sampleTrades.forEach((trade, index) => {
      const entryDate = new Date(trade.entryTime);
      const exitDate = new Date(trade.exitTime);

      // Convert UTC to EST (UTC-5, or UTC-4 during DST)
      const isEST = isDST(entryDate) ? false : true; // DST ended Nov 3, 2025
      const estOffset = isEST ? -5 : -4;

      const entryEST = new Date(entryDate.getTime() + (estOffset * 60 * 60 * 1000));
      const exitEST = new Date(exitDate.getTime() + (estOffset * 60 * 60 * 1000));

      console.log(`\n🔴 SAMPLE TRADE #${index + 1} - ${trade.id}`);
      console.log('-'.repeat(60));

      // Signal Information
      console.log('📡 SIGNAL DETAILS:');
      console.log(`   Signal ID: ${trade.signal?.id || 'N/A'}`);
      console.log(`   Strategy: ${trade.signal?.strategy || 'N/A'}`);
      console.log(`   Action: ${trade.signal?.action || 'N/A'}`);
      console.log(`   Side: ${trade.signal?.side?.toUpperCase() || 'N/A'}`);
      console.log(`   Symbol: ${trade.signal?.symbol || 'N/A'}`);
      console.log(`   Quantity: ${trade.signal?.quantity || 'N/A'}`);

      // Signal Timestamp (when signal was generated)
      if (trade.signal?.timestamp) {
        const signalDate = new Date(trade.signal.timestamp);
        const signalEST = new Date(signalDate.getTime() + (estOffset * 60 * 60 * 1000));
        console.log(`   Signal Time (EST): ${signalEST.toISOString().replace('T', ' ').slice(0, 19)} ${isEST ? 'EST' : 'EDT'}`);
      }

      console.log();
      console.log('💰 PRICE LEVELS:');
      console.log(`   Entry Price: $${trade.signal?.price || 'N/A'}`);
      console.log(`   Target Price: $${trade.signal?.take_profit || 'N/A'}`);
      console.log(`   Stop Loss: $${trade.signal?.stop_loss || 'N/A'}`);

      // Calculate distances
      const entryPrice = trade.signal?.price || 0;
      const targetPrice = trade.signal?.take_profit || 0;
      const stopPrice = trade.signal?.stop_loss || 0;

      if (entryPrice && targetPrice && stopPrice) {
        const targetDistance = Math.abs(targetPrice - entryPrice);
        const stopDistance = Math.abs(stopPrice - entryPrice);
        const riskReward = targetDistance / stopDistance;

        console.log(`   Target Distance: ${targetDistance.toFixed(2)} points`);
        console.log(`   Stop Distance: ${stopDistance.toFixed(2)} points`);
        console.log(`   Risk/Reward: 1:${riskReward.toFixed(2)}`);
      }

      console.log();
      console.log('📈 CONFLUENCE ZONE:');
      if (trade.signal?.confluenceZone) {
        const cz = trade.signal.confluenceZone;
        console.log(`   Center: $${cz.center || 'N/A'}`);
        console.log(`   Strength: ${cz.strength || 'N/A'}`);
        console.log(`   Types: ${cz.types ? cz.types.join(', ') : 'N/A'}`);
        console.log(`   Distance from Price: ${cz.distanceFromPrice ? cz.distanceFromPrice.toFixed(2) + ' points' : 'N/A'}`);
      }

      console.log();
      console.log('🎯 MARKET CONDITIONS:');
      console.log(`   Regime: ${trade.signal?.regime || 'N/A'}`);
      console.log(`   LT Sentiment: ${trade.signal?.availableLTLevels?.sentiment || 'N/A'}`);
      console.log(`   Risk Points: ${trade.signal?.riskPoints || 'N/A'}`);
      console.log(`   Reward Points: ${trade.signal?.rewardPoints ? trade.signal.rewardPoints.toFixed(2) : 'N/A'}`);
      console.log(`   Risk/Reward Ratio: ${trade.signal?.riskRewardRatio ? trade.signal.riskRewardRatio.toFixed(2) : 'N/A'}`);

      console.log();
      console.log('⏱️ TRADE EXECUTION:');
      console.log(`   Entry Time (EST): ${entryEST.toISOString().replace('T', ' ').slice(0, 19)} ${isEST ? 'EST' : 'EDT'}`);
      console.log(`   Exit Time (EST): ${exitEST.toISOString().replace('T', ' ').slice(0, 19)} ${isEST ? 'EST' : 'EDT'}`);
      console.log(`   Actual Entry: $${trade.entryCandle?.close || trade.signal?.price || 'N/A'}`);
      console.log(`   Actual Exit: $${trade.actualExit || 'N/A'}`);
      console.log(`   Exit Reason: ${trade.exitReason || 'N/A'}`);
      console.log(`   Duration: ${trade.candlesSinceSignal || 'N/A'} candles (${Math.round((trade.duration || 0) / 60000)} minutes)`);

      console.log();
      console.log('📊 ENTRY CANDLE DATA:');
      if (trade.entryCandle) {
        const candle = trade.entryCandle;
        console.log(`   Open: $${candle.open}`);
        console.log(`   High: $${candle.high}`);
        console.log(`   Low: $${candle.low}`);
        console.log(`   Close: $${candle.close}`);
        console.log(`   Volume: ${candle.volume || 'N/A'}`);

        const bodySize = Math.abs(candle.close - candle.open);
        const upperWick = candle.high - Math.max(candle.open, candle.close);
        const lowerWick = Math.min(candle.open, candle.close) - candle.low;

        console.log(`   Body Size: ${bodySize.toFixed(2)} points`);
        console.log(`   Upper Wick: ${upperWick.toFixed(2)} points`);
        console.log(`   Lower Wick: ${lowerWick.toFixed(2)} points`);
        console.log(`   Candle Type: ${candle.close > candle.open ? 'Bullish' : candle.close < candle.open ? 'Bearish' : 'Doji'}`);
      }

      console.log();
      console.log('💸 P&L RESULTS:');
      console.log(`   Gross P&L: $${trade.grossPnL || 'N/A'}`);
      console.log(`   Net P&L: $${trade.netPnL || 'N/A'}`);
      console.log(`   Commission: $${trade.commission || 'N/A'}`);

      // For chart analysis
      console.log();
      console.log('📋 FOR CHART ANALYSIS:');
      console.log(`   📅 Date: ${entryDate.toISOString().slice(0, 10)}`);
      console.log(`   🕐 Time: ${entryEST.toISOString().slice(11, 19)} ${isEST ? 'EST' : 'EDT'}`);
      console.log(`   📈 Entry: $${trade.signal?.price || 'N/A'}`);
      console.log(`   🎯 Target: $${trade.signal?.take_profit || 'N/A'}`);
      console.log(`   🛑 Stop: $${trade.signal?.stop_loss || 'N/A'}`);
      console.log(`   ⭐ Confluence: $${trade.signal?.confluenceZone?.center || 'N/A'} (${trade.signal?.confluenceZone?.types?.join(', ') || 'N/A'})`);

      if (index < sampleTrades.length - 1) {
        console.log('\n' + '═'.repeat(80));
      }
    });

    console.log('\n\n✅ Sample trades extracted successfully!');
    console.log('💡 Use these trades to analyze chart patterns and validate the momentum/structure filters.');

  } catch (error) {
    console.error('❌ Error extracting sample trades:', error.message);
  }
}

// Function to determine if a date is during Daylight Saving Time
function isDST(date) {
  // DST in 2025: March 9 - November 2
  const year = date.getFullYear();
  const dstStart = new Date(year, 2, 9); // March 9
  const dstEnd = new Date(year, 10, 2);   // November 2

  return date >= dstStart && date < dstEnd;
}

extractSampleTrades().catch(console.error);