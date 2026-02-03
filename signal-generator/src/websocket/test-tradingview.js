#!/usr/bin/env node

// Standalone test for TradingView WebSocket connection
import TradingViewClient from './tradingview-client.js';
import config from '../utils/config.js';

console.log('='.repeat(50));
console.log('TradingView WebSocket Connection Test');
console.log('='.repeat(50));

// Check for credentials
if (!config.TRADINGVIEW_CREDENTIALS && !config.TRADINGVIEW_JWT_TOKEN) {
  console.error('ERROR: No TradingView credentials found!');
  console.error('Please set TRADINGVIEW_CREDENTIALS or TRADINGVIEW_JWT_TOKEN in shared/.env');
  process.exit(1);
}

console.log('Configuration:');
console.log('- Symbols:', config.OHLCV_SYMBOLS.join(', '));
console.log('- LT Symbol:', config.LT_SYMBOL);
console.log('- Credentials:', config.TRADINGVIEW_CREDENTIALS ? 'Found' : 'Not found');
console.log('- JWT Token:', config.TRADINGVIEW_JWT_TOKEN ? 'Found' : 'Not found');
console.log('');

// Create client
const client = new TradingViewClient({
  credentials: config.TRADINGVIEW_CREDENTIALS,
  jwtToken: config.TRADINGVIEW_JWT_TOKEN,
  symbols: config.OHLCV_SYMBOLS.slice(0, 1) // Test with just first symbol
});

// Track received data
let quotesReceived = 0;
let candlesReceived = 0;
let ltLevelsReceived = 0;
const startTime = Date.now();

// Set up event handlers
client.on('connected', () => {
  console.log('✅ Connected to TradingView WebSocket');
});

client.on('quote', (data) => {
  quotesReceived++;
  console.log(`📊 Quote #${quotesReceived}:`, {
    symbol: data.symbol,
    close: data.close,
    volume: data.volume,
    timestamp: new Date(data.timestamp).toLocaleTimeString()
  });
});

client.on('candle', (data) => {
  candlesReceived++;
  console.log(`🕯️ 15-min Candle Closed:`, {
    symbol: data.symbol,
    open: data.open,
    high: data.high,
    low: data.low,
    close: data.close,
    volume: data.volume,
    time: new Date(data.timestamp * 1000).toLocaleString()
  });
});

client.on('lt_levels', (data) => {
  ltLevelsReceived++;
  const levels = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6']
    .filter(l => data[l] !== null)
    .map(l => `${l}: ${data[l]}`);

  console.log(`📈 LT Levels Update:`, {
    time: new Date(data.timestamp * 1000).toLocaleTimeString(),
    levels: levels.join(', ')
  });
});

client.on('error', (error) => {
  console.error('❌ Error:', error.message);
});

// Connect and start streaming
async function test() {
  try {
    console.log('Connecting to TradingView...');
    await client.connect();

    console.log('Starting data stream...');
    await client.startStreaming();

    console.log('Streaming data... Press Ctrl+C to stop\n');

    // Print stats every 10 seconds
    setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      console.log(`\n📊 Stats after ${elapsed}s:`);
      console.log(`  - Quotes received: ${quotesReceived}`);
      console.log(`  - Candles closed: ${candlesReceived}`);
      console.log(`  - LT updates: ${ltLevelsReceived}`);
      console.log(`  - Connection: ${client.isConnected() ? '✅ Connected' : '❌ Disconnected'}`);
    }, 10000);

  } catch (error) {
    console.error('Failed to connect:', error);
    process.exit(1);
  }
}

// Handle shutdown
process.on('SIGINT', async () => {
  console.log('\n\nShutting down...');
  await client.disconnect();

  const elapsed = Math.floor((Date.now() - startTime) / 1000);
  console.log('\nFinal Statistics:');
  console.log(`- Total runtime: ${elapsed} seconds`);
  console.log(`- Quotes received: ${quotesReceived}`);
  console.log(`- Candles closed: ${candlesReceived}`);
  console.log(`- LT updates: ${ltLevelsReceived}`);

  process.exit(0);
});

// Run the test
test();