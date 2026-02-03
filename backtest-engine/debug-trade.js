#!/usr/bin/env node

/**
 * Debug trade execution to find P&L calculation issues
 */

import { TradeSimulator } from './src/execution/trade-simulator.js';
import fs from 'fs';
import path from 'path';

// Load config
const defaultConfigPath = path.join(path.dirname(new URL(import.meta.url).pathname), 'src/config/default.json');
const config = JSON.parse(fs.readFileSync(defaultConfigPath, 'utf8'));

// Create a test trade simulator
const tradeSimulator = new TradeSimulator({
  commission: 5.0,
  slippage: config.backtesting.slippage,
  contractSpecs: config.contracts
});

console.log('🔍 DEBUGGING TRADE P&L CALCULATIONS');
console.log('═'.repeat(50));

// Create a test signal
const testSignal = {
  webhook_type: 'trade_signal',
  action: 'place_limit',
  side: 'buy',
  symbol: 'NQ',
  price: 20000,  // Entry at 20,000
  stop_loss: 19970,  // Stop at 19,970 (30 points risk)
  take_profit: 20025,  // Target at 20,025 (25 points profit)
  quantity: 1,
  strategy: 'GEX_RECOIL'
};

// Process the signal
const trade = tradeSimulator.processSignal(testSignal, Date.now());
console.log('📊 Created trade:', {
  id: trade.id,
  side: trade.side,
  symbol: trade.symbol,
  entryPrice: trade.entryPrice,
  stopLoss: trade.stopLoss,
  takeProfit: trade.takeProfit,
  quantity: trade.quantity
});

// Simulate entry fill
const entryCandle = {
  timestamp: Date.now(),
  symbol: 'NQ',
  open: 20000,
  high: 20005,
  low: 19995,
  close: 20000,
  volume: 1000
};

console.log('\n🎯 ENTRY SIMULATION:');
const entryUpdate = tradeSimulator.updateActiveTrades(entryCandle)[0];
console.log('Entry result:', {
  status: entryUpdate.status,
  actualEntry: entryUpdate.actualEntry,
  event: entryUpdate.event
});

// Test take profit hit
const takeProfitCandle = {
  timestamp: Date.now() + 60000,
  symbol: 'NQ',
  open: 20020,
  high: 20030,  // Hits take profit
  low: 20015,
  close: 20025,
  volume: 1000
};

console.log('\n✅ TAKE PROFIT TEST:');
console.log('Candle:', {
  high: takeProfitCandle.high,
  takeProfit: entryUpdate.takeProfit,
  shouldHit: takeProfitCandle.high >= entryUpdate.takeProfit
});

const tpUpdate = tradeSimulator.updateActiveTrades(takeProfitCandle)[0];
console.log('Take profit result:', {
  exitReason: tpUpdate.exitReason,
  actualExit: tpUpdate.actualExit,
  pointsPnL: tpUpdate.pointsPnL,
  grossPnL: tpUpdate.grossPnL,
  netPnL: tpUpdate.netPnL,
  pointValue: tpUpdate.pointValue,
  baseSymbol: tpUpdate.baseSymbol
});

console.log('\n🧮 EXPECTED vs ACTUAL:');
console.log('Expected:');
console.log('  Points P&L: ~25 points');
console.log('  Gross P&L: 25 * $20 = $500');
console.log('  Net P&L: $500 - $5 = $495');

console.log('Actual:');
console.log(`  Points P&L: ${tpUpdate.pointsPnL}`);
console.log(`  Gross P&L: $${tpUpdate.grossPnL}`);
console.log(`  Net P&L: $${tpUpdate.netPnL}`);

// Reset and test stop loss
tradeSimulator.reset();

console.log('\n\n❌ STOP LOSS TEST:');
const trade2 = tradeSimulator.processSignal(testSignal, Date.now());
const entryUpdate2 = tradeSimulator.updateActiveTrades(entryCandle)[0];

const stopLossCandle = {
  timestamp: Date.now() + 60000,
  symbol: 'NQ',
  open: 19975,
  high: 19980,
  low: 19965,  // Hits stop loss
  close: 19970,
  volume: 1000
};

console.log('Candle:', {
  low: stopLossCandle.low,
  stopLoss: entryUpdate2.stopLoss,
  shouldHit: stopLossCandle.low <= entryUpdate2.stopLoss
});

const slUpdate = tradeSimulator.updateActiveTrades(stopLossCandle)[0];
console.log('Stop loss result:', {
  exitReason: slUpdate.exitReason,
  actualExit: slUpdate.actualExit,
  pointsPnL: slUpdate.pointsPnL,
  grossPnL: slUpdate.grossPnL,
  netPnL: slUpdate.netPnL
});

console.log('\n🧮 EXPECTED vs ACTUAL:');
console.log('Expected:');
console.log('  Points P&L: ~-30 points');
console.log('  Gross P&L: -30 * $20 = -$600');
console.log('  Net P&L: -$600 - $5 = -$605');

console.log('Actual:');
console.log(`  Points P&L: ${slUpdate.pointsPnL}`);
console.log(`  Gross P&L: $${slUpdate.grossPnL}`);
console.log(`  Net P&L: $${slUpdate.netPnL}`);