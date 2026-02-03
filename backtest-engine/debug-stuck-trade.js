#!/usr/bin/env node
/**
 * Debug script to trace the stuck trade with full timeline
 */

import { BacktestEngine } from './src/backtest-engine.js';

async function main() {
  const engine = new BacktestEngine({
    ticker: 'NQ',
    startDate: new Date('2025-03-03'),
    endDate: new Date('2025-03-05'),
    strategy: 'iv-skew-gex',
    timeframe: '15m',
    verbose: true,
    quiet: false,
    dataDir: '/home/drew/projects/slingshot-services/backtest-engine/data'
  });

  // Hook into the trade simulator to log detailed info
  const originalProcessSignal = engine.tradeSimulator.processSignal.bind(engine.tradeSimulator);
  engine.tradeSimulator.processSignal = function(signal, timestamp) {
    const estTime = new Date(timestamp).toLocaleString('en-US', { timeZone: 'America/New_York' });
    console.log('\n' + '='.repeat(80));
    console.log('SIGNAL GENERATED');
    console.log('='.repeat(80));
    console.log(`  Time (EST): ${estTime}`);
    console.log(`  Side: ${signal.side}`);
    console.log(`  Entry Price: ${signal.price}`);
    console.log(`  Stop Loss: ${signal.stop_loss || signal.stopLoss}`);
    console.log(`  Take Profit: ${signal.take_profit || signal.takeProfit}`);
    console.log(`  Signal Contract: ${signal.signalContract || 'not set'}`);
    console.log(`  Max Hold Bars: ${signal.maxHoldBars}`);
    return originalProcessSignal(signal, timestamp);
  };

  // Hook into updateTradeWithSecondResolution
  const originalUpdate = engine.tradeSimulator.updateTradeWithSecondResolution.bind(engine.tradeSimulator);
  let lastLoggedMinute = null;
  let barCount = 0;
  let conversions = [];

  engine.tradeSimulator.updateTradeWithSecondResolution = function(trade, secondCandles, minuteCandle) {
    const minuteTime = minuteCandle?.timestamp;
    const estTime = minuteCandle ? new Date(minuteCandle.timestamp).toLocaleString('en-US', { timeZone: 'America/New_York' }) : 'N/A';

    // Log once per minute
    if (minuteTime !== lastLoggedMinute && trade.status === 'active') {
      if (lastLoggedMinute !== null) {
        console.log(`  Minute processed: ${barCount} bars, ${conversions.length} conversions`);
        if (conversions.length > 0) {
          const avgSpread = conversions.reduce((a, b) => a + b, 0) / conversions.length;
          console.log(`  Avg spread: ${avgSpread.toFixed(2)}`);
        }
      }

      console.log('\n' + '-'.repeat(60));
      console.log(`MINUTE: ${estTime}`);
      console.log(`  Trade Status: ${trade.status}`);
      console.log(`  Entry: ${trade.actualEntry} on ${trade.entryCandle?.symbol}`);
      console.log(`  Stop: ${trade.stopLoss} | Target: ${trade.takeProfit}`);
      console.log(`  Bars Since Entry: ${trade.barsSinceEntry}`);
      console.log(`  Current candle symbol: ${minuteCandle?.symbol}`);

      lastLoggedMinute = minuteTime;
      barCount = 0;
      conversions = [];
    }

    // Count bars and track conversions
    for (const bar of secondCandles) {
      barCount++;
      if (bar.symbol !== trade.entryCandle?.symbol) {
        // Would need conversion
        const spread = this.calendarSpreadsByTime?.get(bar.timestamp)?.get(trade.entryCandle?.symbol);
        if (spread) conversions.push(spread);
      }
    }

    return originalUpdate(trade, secondCandles, minuteCandle);
  };

  // Hook into exitTrade
  const originalExit = engine.tradeSimulator.exitTrade.bind(engine.tradeSimulator);
  engine.tradeSimulator.exitTrade = function(trade, candle, reason, price) {
    const estTime = new Date(candle.timestamp).toLocaleString('en-US', { timeZone: 'America/New_York' });
    console.log('\n' + '='.repeat(80));
    console.log('TRADE EXIT');
    console.log('='.repeat(80));
    console.log(`  Time (EST): ${estTime}`);
    console.log(`  Reason: ${reason}`);
    console.log(`  Exit Price: ${price}`);
    console.log(`  Entry was: ${trade.actualEntry} on ${trade.entryCandle?.symbol}`);
    console.log(`  Current candle symbol: ${candle.symbol}`);
    console.log(`  P&L: ${((trade.side === 'long' ? price - trade.actualEntry : trade.actualEntry - price) * 20).toFixed(2)}`);
    return originalExit(trade, candle, reason, price);
  };

  try {
    const results = await engine.run();
    console.log('\n' + '='.repeat(80));
    console.log('BACKTEST COMPLETE');
    console.log(`Total trades: ${results.trades?.length || 0}`);
    console.log(`Active trades remaining: ${engine.tradeSimulator.activeTrades.size}`);
  } catch (err) {
    console.error('Error:', err.message);
  }
}

main().catch(console.error);
