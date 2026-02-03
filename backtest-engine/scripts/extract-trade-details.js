#!/usr/bin/env node
/**
 * Extract detailed trade information for chart verification
 * Loads trades from CSV and looks up GEX/LT data for each timestamp
 */

import fs from 'fs';
import path from 'path';
import { GexLoader } from '../src/data-loaders/gex-loader.js';
import { CSVLoader } from '../src/data/csv-loader.js';
import { fileURLToPath } from 'url';

// Simple CSV parser
function parseCSV(content) {
  const lines = content.trim().split('\n');
  const headers = lines[0].split(',');
  return lines.slice(1).map(line => {
    const values = line.split(',');
    const obj = {};
    headers.forEach((h, i) => obj[h] = values[i] || '');
    return obj;
  });
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataDir = path.join(__dirname, '..', 'data');

// Configuration
const CONFIG = {
  tradesFile: process.argv[2] || '/tmp/nov-dec-trades.csv',
  startDate: '2025-11-01',
  endDate: '2025-12-31',
  maxTrades: parseInt(process.argv[3]) || 15
};

// Load default config for CSVLoader
const defaultConfig = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'config', 'default.json'), 'utf8'));

async function main() {
  console.log('\n=== LDPM Level Sweep Trade Detail Extraction ===\n');

  // Load trades CSV
  if (!fs.existsSync(CONFIG.tradesFile)) {
    console.error(`Trades file not found: ${CONFIG.tradesFile}`);
    process.exit(1);
  }

  const tradesContent = fs.readFileSync(CONFIG.tradesFile, 'utf8');
  const trades = parseCSV(tradesContent);
  console.log(`Loaded ${trades.length} trades from ${CONFIG.tradesFile}`);

  // Filter for December trades only
  const decTrades = trades.filter(t => {
    const d = new Date(t.SignalTime);
    return d.getMonth() === 11 && d.getFullYear() === 2025;  // December 2025
  });

  console.log(`Found ${decTrades.length} December 2025 trades`);

  // Select sample trades (winners, losers, variety of times)
  const sampleTrades = selectDiverseSample(decTrades, CONFIG.maxTrades);
  console.log(`Selected ${sampleTrades.length} sample trades for analysis\n`);

  // Load GEX data
  console.log('Loading GEX data...');
  const gexLoader = new GexLoader(path.join(dataDir, 'gex'));
  await gexLoader.loadDateRange(new Date(CONFIG.startDate), new Date(CONFIG.endDate));
  console.log(`Loaded GEX data with ${gexLoader.sortedTimestamps.length} timestamps`);

  // Load LT (liquidity) data
  console.log('Loading LT data...');
  const csvLoader = new CSVLoader(dataDir, defaultConfig);
  const liquidityData = await csvLoader.loadLiquidityData('NQ', new Date(CONFIG.startDate), new Date(CONFIG.endDate));
  console.log(`Loaded ${liquidityData.length} LT records\n`);

  // Build LT lookup map (by 15-min bucket)
  const ltMap = new Map();
  for (const lt of liquidityData) {
    const ts = new Date(lt.datetime).getTime();
    // Round to 15-minute bucket
    const bucket = Math.floor(ts / (15 * 60 * 1000)) * (15 * 60 * 1000);
    ltMap.set(bucket, lt);
  }

  // Output detailed trades
  console.log('=' .repeat(90));
  console.log('DETAILED TRADE DATA FOR CHART VERIFICATION');
  console.log('=' .repeat(90));

  for (const trade of sampleTrades) {
    const signalTime = new Date(trade.SignalTime);
    const signalTs = signalTime.getTime();

    // Convert to EST
    const estString = signalTime.toLocaleString('en-US', {
      timeZone: 'America/New_York',
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });

    // Get GEX levels for this timestamp
    const gexLevels = gexLoader.getGexLevels(signalTime);

    // Get LT levels for this timestamp (round to 15-min bucket)
    const ltBucket = Math.floor(signalTs / (15 * 60 * 1000)) * (15 * 60 * 1000);
    const ltLevels = ltMap.get(ltBucket);

    // Calculate LDPM direction from LT levels
    let ldpmDirection = 'unknown';
    let ldpmSlope = null;
    if (ltLevels) {
      // Get previous LT levels for slope calculation
      const prevBucket = ltBucket - (15 * 60 * 1000);
      const prevLtLevels = ltMap.get(prevBucket);

      if (prevLtLevels) {
        // Calculate center of mass
        const currentCom = calculateCOM(ltLevels);
        const prevCom = calculateCOM(prevLtLevels);
        ldpmSlope = currentCom - prevCom;

        if (ldpmSlope > 3) {
          ldpmDirection = 'rising';
        } else if (ldpmSlope < -3) {
          ldpmDirection = 'falling';
        } else {
          ldpmDirection = 'flat';
        }
      }
    }

    // Determine bias from LDPM direction
    let tradeBias = 'either';
    if (ldpmDirection === 'rising') tradeBias = 'short';
    else if (ldpmDirection === 'falling') tradeBias = 'long';

    // Win/Loss status
    const pnl = parseFloat(trade.NetPnL);
    const status = pnl > 0 ? '✅ WIN' : (pnl < 0 ? '❌ LOSS' : '➖ FLAT');

    console.log('\n' + '-'.repeat(90));
    console.log(`${status} | ${trade.Side.toUpperCase()} at ${trade.EntryPrice} | P&L: $${pnl}`);
    console.log('-'.repeat(90));

    console.log('\n📅 TIMING:');
    console.log(`   Signal Time (EST): ${estString}`);
    console.log(`   Signal Time (UTC): ${trade.SignalTime}`);
    console.log(`   Exit Time (UTC):   ${trade.ExitTime}`);
    console.log(`   Duration:          ${formatDuration(parseInt(trade.Duration))}`);
    console.log(`   Exit Reason:       ${trade.ExitReason}`);

    console.log('\n💰 TRADE PARAMETERS:');
    console.log(`   Side:        ${trade.Side}`);
    console.log(`   Entry Price: ${trade.EntryPrice}`);
    console.log(`   Stop Loss:   ${parseFloat(trade.EntryPrice) + (trade.Side === 'buy' ? -50 : 50)} (50 pts)`);
    console.log(`   Take Profit: ${parseFloat(trade.EntryPrice) + (trade.Side === 'buy' ? 50 : -50)} (50 pts)`);
    console.log(`   Exit Price:  ${trade.ExitPrice}`);
    console.log(`   Points P&L:  ${trade.PointsPnL}`);

    console.log('\n🎯 GEX LEVELS AT ENTRY:');
    if (gexLevels) {
      console.log(`   Gamma Flip:   ${gexLevels.gamma_flip?.toFixed(2) || 'N/A'}`);
      console.log(`   Resistance 1: ${gexLevels.resistance?.[0]?.toFixed(2) || 'N/A'}`);
      console.log(`   Resistance 2: ${gexLevels.resistance?.[1]?.toFixed(2) || 'N/A'}`);
      console.log(`   Resistance 3: ${gexLevels.resistance?.[2]?.toFixed(2) || 'N/A'}`);
      console.log(`   Support 1:    ${gexLevels.support?.[0]?.toFixed(2) || 'N/A'}`);
      console.log(`   Support 2:    ${gexLevels.support?.[1]?.toFixed(2) || 'N/A'}`);
      console.log(`   Support 3:    ${gexLevels.support?.[2]?.toFixed(2) || 'N/A'}`);
      console.log(`   Regime:       ${gexLevels.regime || 'N/A'}`);
      console.log(`   Total GEX:    ${gexLevels.total_gex ? (gexLevels.total_gex / 1e9).toFixed(2) + 'B' : 'N/A'}`);
    } else {
      console.log('   ⚠️  No GEX data found for this timestamp');
    }

    console.log('\n📍 LT LEVELS AT ENTRY:');
    if (ltLevels) {
      console.log(`   Sentiment: ${ltLevels.sentiment || 'N/A'}`);
      console.log(`   Level 1:   ${ltLevels.level_1?.toFixed(2) || 'N/A'}`);
      console.log(`   Level 2:   ${ltLevels.level_2?.toFixed(2) || 'N/A'}`);
      console.log(`   Level 3:   ${ltLevels.level_3?.toFixed(2) || 'N/A'}`);
      console.log(`   Level 4:   ${ltLevels.level_4?.toFixed(2) || 'N/A'}`);
      console.log(`   Level 5:   ${ltLevels.level_5?.toFixed(2) || 'N/A'}`);
    } else {
      console.log('   ⚠️  No LT data found for this timestamp');
    }

    console.log('\n📈 LDPM DIRECTION:');
    console.log(`   Direction:   ${ldpmDirection}`);
    console.log(`   Slope:       ${ldpmSlope?.toFixed(2) || 'N/A'} pts/period`);
    console.log(`   Trade Bias:  ${tradeBias}`);
    console.log(`   Alignment:   ${checkAlignment(trade.Side, tradeBias) ? '✅ Aligned' : '⚠️ Not aligned'}`);
  }

  console.log('\n' + '='.repeat(90));
  console.log(`Total trades analyzed: ${sampleTrades.length}`);
  console.log('='.repeat(90) + '\n');
}

function calculateCOM(ltLevels) {
  const levels = [
    ltLevels.level_1,
    ltLevels.level_2,
    ltLevels.level_3,
    ltLevels.level_4,
    ltLevels.level_5
  ].filter(l => l !== null && l !== undefined);

  if (levels.length === 0) return 0;
  return levels.reduce((sum, l) => sum + l, 0) / levels.length;
}

function selectDiverseSample(trades, maxCount) {
  // Get a mix of winners, losers, buys, sells, different times of day
  const winners = trades.filter(t => parseFloat(t.NetPnL) > 0);
  const losers = trades.filter(t => parseFloat(t.NetPnL) < 0);
  const buys = trades.filter(t => t.Side === 'buy');
  const sells = trades.filter(t => t.Side === 'sell');

  const sample = [];
  const used = new Set();

  // Add some winners
  for (const t of winners.slice(0, Math.ceil(maxCount / 3))) {
    if (!used.has(t.TradeID)) {
      sample.push(t);
      used.add(t.TradeID);
    }
  }

  // Add some losers
  for (const t of losers.slice(0, Math.ceil(maxCount / 3))) {
    if (!used.has(t.TradeID) && sample.length < maxCount) {
      sample.push(t);
      used.add(t.TradeID);
    }
  }

  // Add some sells (for variety)
  for (const t of sells.slice(0, Math.ceil(maxCount / 4))) {
    if (!used.has(t.TradeID) && sample.length < maxCount) {
      sample.push(t);
      used.add(t.TradeID);
    }
  }

  // Fill remaining with other trades
  for (const t of trades) {
    if (!used.has(t.TradeID) && sample.length < maxCount) {
      sample.push(t);
      used.add(t.TradeID);
    }
  }

  // Sort by signal time
  return sample.sort((a, b) => new Date(a.SignalTime) - new Date(b.SignalTime));
}

function checkAlignment(side, bias) {
  if (bias === 'either') return true;
  if (bias === 'long' && side === 'buy') return true;
  if (bias === 'short' && side === 'sell') return true;
  return false;
}

function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

main().catch(console.error);
