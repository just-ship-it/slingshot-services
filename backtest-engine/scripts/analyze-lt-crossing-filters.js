#!/usr/bin/env node

/**
 * Analyze LT Level Crossing trades to find filter correlations
 *
 * Compares winning vs losing trades across:
 * - GEX levels (proximity to support/resistance, regime)
 * - IV levels (high/low volatility)
 * - Order flow (book imbalance, trade imbalance)
 * - Time of day / session
 * - Which LT level triggered
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '../data');
const RESULTS_DIR = path.join(__dirname, '../results');

// ============================================================================
// Data Loaders
// ============================================================================

function loadJSON(filepath) {
  const content = fs.readFileSync(filepath, 'utf-8');
  return JSON.parse(content);
}

function loadCSV(filepath) {
  const content = fs.readFileSync(filepath, 'utf-8');
  const lines = content.trim().split('\n');
  const headers = lines[0].split(',');

  return lines.slice(1).map(line => {
    const values = line.split(',');
    const obj = {};
    headers.forEach((h, i) => {
      const val = values[i];
      // Try to parse as number
      const num = parseFloat(val);
      obj[h.trim()] = isNaN(num) ? val : num;
    });
    return obj;
  });
}

function loadGexIntraday(date) {
  // Format: nq_gex_YYYY-MM-DD.json
  const dateStr = new Date(date).toISOString().split('T')[0];
  const filepath = path.join(DATA_DIR, 'gex/nq', `nq_gex_${dateStr}.json`);

  if (!fs.existsSync(filepath)) return null;

  try {
    return loadJSON(filepath);
  } catch (e) {
    return null;
  }
}

// ============================================================================
// Analysis Functions
// ============================================================================

function getSession(timestamp) {
  const date = new Date(timestamp);
  const estString = date.toLocaleString('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false
  });

  const [hourStr, minStr] = estString.split(':');
  const hour = parseInt(hourStr);
  const min = parseInt(minStr);
  const timeDecimal = hour + min / 60;

  if (timeDecimal >= 18 || timeDecimal < 4) return 'overnight';
  if (timeDecimal >= 4 && timeDecimal < 9.5) return 'premarket';
  if (timeDecimal >= 9.5 && timeDecimal < 16) return 'rth';
  return 'afterhours';
}

function getHourOfDay(timestamp) {
  const date = new Date(timestamp);
  const estString = date.toLocaleString('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    hour12: false
  });
  return parseInt(estString);
}

function findClosestGexSnapshot(gexData, timestamp) {
  if (!gexData || !gexData.data) return null;

  let closest = null;
  let minDiff = Infinity;

  for (const snapshot of gexData.data) {
    const snapTime = new Date(snapshot.timestamp).getTime();
    const diff = Math.abs(snapTime - timestamp);
    if (diff < minDiff && snapTime <= timestamp) {
      minDiff = diff;
      closest = snapshot;
    }
  }

  return closest;
}

function findClosestRecord(records, timestamp, timestampField = 'timestamp') {
  if (!records || records.length === 0) return null;

  let closest = null;
  let minDiff = Infinity;

  for (const record of records) {
    let recordTime;
    if (typeof record[timestampField] === 'string') {
      recordTime = new Date(record[timestampField]).getTime();
    } else {
      recordTime = record[timestampField];
    }

    const diff = Math.abs(recordTime - timestamp);
    if (diff < minDiff && recordTime <= timestamp) {
      minDiff = diff;
      closest = record;
    }
  }

  return closest;
}

function analyzeGexProximity(price, gexSnapshot) {
  if (!gexSnapshot) return { nearSupport: false, nearResistance: false, regime: 'unknown' };

  const threshold = 30; // points

  // Check support levels
  const supports = [
    gexSnapshot.put_wall,
    ...(gexSnapshot.support || [])
  ].filter(l => l && !isNaN(l));

  const resistances = [
    gexSnapshot.call_wall,
    gexSnapshot.gamma_flip,
    ...(gexSnapshot.resistance || [])
  ].filter(l => l && !isNaN(l));

  const nearSupport = supports.some(s => Math.abs(price - s) < threshold);
  const nearResistance = resistances.some(r => Math.abs(price - r) < threshold);

  // Distance to nearest support/resistance
  const supportDist = supports.length > 0 ? Math.min(...supports.map(s => Math.abs(price - s))) : 999;
  const resistanceDist = resistances.length > 0 ? Math.min(...resistances.map(r => Math.abs(price - r))) : 999;

  // Check if price is above or below gamma flip
  const aboveGammaFlip = gexSnapshot.gamma_flip ? price > gexSnapshot.gamma_flip : null;

  return {
    nearSupport,
    nearResistance,
    supportDist,
    resistanceDist,
    aboveGammaFlip,
    regime: gexSnapshot.regime || 'unknown',
    totalGex: gexSnapshot.total_gex,
    gammaFlip: gexSnapshot.gamma_flip
  };
}

// ============================================================================
// Main Analysis
// ============================================================================

async function main() {
  console.log('Loading trade results...');
  const results = loadJSON(path.join(RESULTS_DIR, 'lc-50-2025.json'));
  const trades = results.trades;

  console.log(`Loaded ${trades.length} trades`);

  // Separate winners and losers (use netPnL field)
  const winners = trades.filter(t => t.netPnL > 0);
  const losers = trades.filter(t => t.netPnL < 0);
  const breakeven = trades.filter(t => t.netPnL === 0);

  console.log(`Winners: ${winners.length}, Losers: ${losers.length}, Breakeven: ${breakeven.length}`);

  // Load auxiliary data
  console.log('\nLoading IV data...');
  const ivData = loadCSV(path.join(DATA_DIR, 'iv/qqq/qqq_atm_iv_15m.csv'));
  console.log(`Loaded ${ivData.length} IV records`);

  console.log('Loading order flow data...');
  let bookImbalance = [];
  let tradeOfi = [];

  const bookImbalancePath = path.join(DATA_DIR, 'orderflow/nq/book-imbalance-1m.csv');
  const tradeOfiPath = path.join(DATA_DIR, 'orderflow/nq/trade-ofi-1m.csv');

  if (fs.existsSync(bookImbalancePath)) {
    bookImbalance = loadCSV(bookImbalancePath);
    console.log(`Loaded ${bookImbalance.length} book imbalance records`);
  }

  if (fs.existsSync(tradeOfiPath)) {
    tradeOfi = loadCSV(tradeOfiPath);
    console.log(`Loaded ${tradeOfi.length} trade OFI records`);
  }

  // Load CBBO metrics if available
  console.log('Loading CBBO metrics...');
  let cbboMetrics = [];
  const cbboPath = path.join(DATA_DIR, 'cbbo-1m/cbbo-metrics-1m.csv');
  if (fs.existsSync(cbboPath)) {
    cbboMetrics = loadCSV(cbboPath);
    console.log(`Loaded ${cbboMetrics.length} CBBO metrics records`);
  }

  // Analyze each trade
  console.log('\nEnriching trades with market context...');

  const enrichedTrades = [];
  let gexCache = {};

  for (const trade of trades) {
    const entryTime = trade.timestamp || trade.signalTime;
    const entryDate = new Date(entryTime).toISOString().split('T')[0];

    // Load GEX data for this date (with caching)
    if (!gexCache[entryDate]) {
      gexCache[entryDate] = loadGexIntraday(entryTime);
    }
    const gexData = gexCache[entryDate];
    const gexSnapshot = findClosestGexSnapshot(gexData, entryTime);

    // Get IV at entry
    const ivRecord = findClosestRecord(ivData, entryTime, 'timestamp');

    // Get book imbalance at entry
    const bookRecord = findClosestRecord(bookImbalance, entryTime, 'timestamp');

    // Get trade OFI at entry
    const ofiRecord = findClosestRecord(tradeOfi, entryTime, 'timestamp');

    // Get CBBO metrics at entry
    const cbboRecord = findClosestRecord(cbboMetrics, entryTime, 'timestamp');

    // Analyze GEX proximity
    const gexAnalysis = analyzeGexProximity(trade.entryPrice, gexSnapshot);

    const enriched = {
      id: trade.id,
      entryTime,
      entryPrice: trade.entryPrice,
      exitPrice: trade.actualExit,
      pnl: trade.netPnL,
      pnlPoints: trade.pointsPnL,
      exitReason: trade.exitReason,
      isWinner: trade.netPnL > 0,

      // Signal info
      levelKey: trade.signal?.levelKey,
      momentum: trade.signal?.momentum,

      // Session/time
      session: getSession(entryTime),
      hourOfDay: getHourOfDay(entryTime),
      dayOfWeek: new Date(entryTime).getDay(),

      // GEX context
      ...gexAnalysis,

      // IV context
      iv: ivRecord?.iv,
      callIv: ivRecord?.call_iv,
      putIv: ivRecord?.put_iv,
      ivSkew: ivRecord ? (ivRecord.put_iv - ivRecord.call_iv) : null,

      // Book imbalance
      sizeImbalance: bookRecord?.sizeImbalance,
      bidAskRatio: bookRecord?.bidAskRatio,

      // Trade OFI
      volumeImbalance: ofiRecord?.volumeImbalance,
      tradeImbalance: ofiRecord?.tradeImbalance,
      buyRatio: ofiRecord?.buyRatio,

      // CBBO metrics
      avgSpread: cbboRecord?.avgSpread,
      putCallSpreadRatio: cbboRecord?.putCallSpreadRatio,
      putCallSizeRatio: cbboRecord?.putCallSizeRatio
    };

    enrichedTrades.push(enriched);
  }

  console.log(`Enriched ${enrichedTrades.length} trades`);

  // ============================================================================
  // Statistical Analysis
  // ============================================================================

  console.log('\n' + '='.repeat(80));
  console.log('FILTER ANALYSIS: Comparing Winners vs Losers');
  console.log('='.repeat(80));

  const winnerData = enrichedTrades.filter(t => t.isWinner);
  const loserData = enrichedTrades.filter(t => !t.isWinner);

  // Helper function to compute stats
  function computeStats(arr, field) {
    const values = arr.map(t => t[field]).filter(v => v !== null && v !== undefined && !isNaN(v));
    if (values.length === 0) return { mean: null, median: null, std: null, count: 0 };

    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const sorted = [...values].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length;
    const std = Math.sqrt(variance);

    return { mean, median, std, count: values.length, min: sorted[0], max: sorted[sorted.length - 1] };
  }

  // Helper to compute categorical breakdown
  function categoricalBreakdown(arr, field) {
    const counts = {};
    for (const t of arr) {
      const val = t[field];
      counts[val] = (counts[val] || 0) + 1;
    }
    return counts;
  }

  // Helper to compute win rate by category
  function winRateByCategory(allTrades, field) {
    const categories = {};
    for (const t of allTrades) {
      const val = t[field];
      if (val === null || val === undefined) continue;

      if (!categories[val]) {
        categories[val] = { wins: 0, losses: 0, total: 0, totalPnl: 0 };
      }
      categories[val].total++;
      categories[val].totalPnl += t.pnl;
      if (t.isWinner) {
        categories[val].wins++;
      } else {
        categories[val].losses++;
      }
    }

    for (const cat of Object.keys(categories)) {
      categories[cat].winRate = (categories[cat].wins / categories[cat].total * 100).toFixed(1);
      categories[cat].avgPnl = (categories[cat].totalPnl / categories[cat].total).toFixed(2);
    }

    return categories;
  }

  // Helper to bin numeric values
  function binValues(arr, field, bins) {
    const results = {};
    for (const bin of bins) {
      results[bin.label] = { wins: 0, losses: 0, total: 0, totalPnl: 0 };
    }

    for (const t of arr) {
      const val = t[field];
      if (val === null || val === undefined || isNaN(val)) continue;

      for (const bin of bins) {
        if (val >= bin.min && val < bin.max) {
          results[bin.label].total++;
          results[bin.label].totalPnl += t.pnl;
          if (t.isWinner) results[bin.label].wins++;
          else results[bin.label].losses++;
          break;
        }
      }
    }

    for (const label of Object.keys(results)) {
      if (results[label].total > 0) {
        results[label].winRate = (results[label].wins / results[label].total * 100).toFixed(1);
        results[label].avgPnl = (results[label].totalPnl / results[label].total).toFixed(2);
      }
    }

    return results;
  }

  // ============================================================================
  // 1. LT Level Analysis
  // ============================================================================
  console.log('\n--- LT LEVEL PERFORMANCE ---');
  const levelStats = winRateByCategory(enrichedTrades, 'levelKey');
  console.log('\nLevel    | Trades | Win Rate | Avg P&L');
  console.log('-'.repeat(45));
  for (const [level, stats] of Object.entries(levelStats).sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`${level.padEnd(8)} | ${String(stats.total).padStart(6)} | ${stats.winRate.padStart(7)}% | $${stats.avgPnl}`);
  }

  // ============================================================================
  // 2. Session Analysis
  // ============================================================================
  console.log('\n--- SESSION PERFORMANCE ---');
  const sessionStats = winRateByCategory(enrichedTrades, 'session');
  console.log('\nSession     | Trades | Win Rate | Avg P&L');
  console.log('-'.repeat(50));
  for (const [session, stats] of Object.entries(sessionStats)) {
    console.log(`${session.padEnd(11)} | ${String(stats.total).padStart(6)} | ${stats.winRate.padStart(7)}% | $${stats.avgPnl}`);
  }

  // ============================================================================
  // 3. Hour of Day Analysis
  // ============================================================================
  console.log('\n--- HOUR OF DAY PERFORMANCE (EST) ---');
  const hourStats = winRateByCategory(enrichedTrades, 'hourOfDay');
  console.log('\nHour | Trades | Win Rate | Avg P&L');
  console.log('-'.repeat(40));
  for (const [hour, stats] of Object.entries(hourStats).sort((a, b) => parseInt(a) - parseInt(b))) {
    if (stats.total >= 5) { // Only show hours with enough trades
      console.log(`${hour.padStart(4)} | ${String(stats.total).padStart(6)} | ${stats.winRate.padStart(7)}% | $${stats.avgPnl}`);
    }
  }

  // ============================================================================
  // 4. GEX Regime Analysis
  // ============================================================================
  console.log('\n--- GEX REGIME PERFORMANCE ---');
  const regimeStats = winRateByCategory(enrichedTrades, 'regime');
  console.log('\nRegime   | Trades | Win Rate | Avg P&L');
  console.log('-'.repeat(45));
  for (const [regime, stats] of Object.entries(regimeStats)) {
    console.log(`${regime.padEnd(8)} | ${String(stats.total).padStart(6)} | ${stats.winRate.padStart(7)}% | $${stats.avgPnl}`);
  }

  // ============================================================================
  // 5. GEX Position (Above/Below Gamma Flip)
  // ============================================================================
  console.log('\n--- POSITION RELATIVE TO GAMMA FLIP ---');
  const gammaFlipStats = winRateByCategory(enrichedTrades, 'aboveGammaFlip');
  console.log('\nPosition       | Trades | Win Rate | Avg P&L');
  console.log('-'.repeat(50));
  for (const [pos, stats] of Object.entries(gammaFlipStats)) {
    const label = pos === 'true' ? 'Above GF' : pos === 'false' ? 'Below GF' : 'Unknown';
    console.log(`${label.padEnd(14)} | ${String(stats.total).padStart(6)} | ${stats.winRate.padStart(7)}% | $${stats.avgPnl}`);
  }

  // ============================================================================
  // 6. GEX Proximity Analysis
  // ============================================================================
  console.log('\n--- GEX PROXIMITY ANALYSIS ---');

  // Near support
  const nearSupportStats = winRateByCategory(enrichedTrades, 'nearSupport');
  console.log('\nNear GEX Support (< 30 pts):');
  for (const [near, stats] of Object.entries(nearSupportStats)) {
    const label = near === 'true' ? 'Near Support' : 'Not Near';
    console.log(`  ${label}: ${stats.total} trades, ${stats.winRate}% win rate, $${stats.avgPnl} avg`);
  }

  // Near resistance
  const nearResStats = winRateByCategory(enrichedTrades, 'nearResistance');
  console.log('\nNear GEX Resistance (< 30 pts):');
  for (const [near, stats] of Object.entries(nearResStats)) {
    const label = near === 'true' ? 'Near Resistance' : 'Not Near';
    console.log(`  ${label}: ${stats.total} trades, ${stats.winRate}% win rate, $${stats.avgPnl} avg`);
  }

  // Distance to resistance bins
  console.log('\nDistance to Nearest GEX Resistance:');
  const resBins = [
    { label: '0-20 pts', min: 0, max: 20 },
    { label: '20-50 pts', min: 20, max: 50 },
    { label: '50-100 pts', min: 50, max: 100 },
    { label: '100+ pts', min: 100, max: 9999 }
  ];
  const resDistStats = binValues(enrichedTrades, 'resistanceDist', resBins);
  for (const [label, stats] of Object.entries(resDistStats)) {
    if (stats.total > 0) {
      console.log(`  ${label}: ${stats.total} trades, ${stats.winRate}% win rate, $${stats.avgPnl} avg`);
    }
  }

  // ============================================================================
  // 7. IV Analysis
  // ============================================================================
  console.log('\n--- IMPLIED VOLATILITY ANALYSIS ---');

  const winnerIV = computeStats(winnerData, 'iv');
  const loserIV = computeStats(loserData, 'iv');

  console.log(`\nWinner IV: mean=${winnerIV.mean?.toFixed(4)}, median=${winnerIV.median?.toFixed(4)} (n=${winnerIV.count})`);
  console.log(`Loser IV:  mean=${loserIV.mean?.toFixed(4)}, median=${loserIV.median?.toFixed(4)} (n=${loserIV.count})`);

  // IV bins
  const ivBins = [
    { label: 'IV < 0.15', min: 0, max: 0.15 },
    { label: 'IV 0.15-0.20', min: 0.15, max: 0.20 },
    { label: 'IV 0.20-0.25', min: 0.20, max: 0.25 },
    { label: 'IV 0.25-0.30', min: 0.25, max: 0.30 },
    { label: 'IV > 0.30', min: 0.30, max: 1.0 }
  ];
  const ivStats = binValues(enrichedTrades, 'iv', ivBins);
  console.log('\nWin Rate by IV Level:');
  for (const [label, stats] of Object.entries(ivStats)) {
    if (stats.total > 0) {
      console.log(`  ${label}: ${stats.total} trades, ${stats.winRate}% win rate, $${stats.avgPnl} avg`);
    }
  }

  // IV Skew (put - call IV)
  console.log('\nIV Skew (Put IV - Call IV):');
  const skewBins = [
    { label: 'Negative (<0)', min: -1, max: 0 },
    { label: 'Low (0-0.02)', min: 0, max: 0.02 },
    { label: 'Medium (0.02-0.05)', min: 0.02, max: 0.05 },
    { label: 'High (>0.05)', min: 0.05, max: 1 }
  ];
  const skewStats = binValues(enrichedTrades, 'ivSkew', skewBins);
  for (const [label, stats] of Object.entries(skewStats)) {
    if (stats.total > 0) {
      console.log(`  ${label}: ${stats.total} trades, ${stats.winRate}% win rate, $${stats.avgPnl} avg`);
    }
  }

  // ============================================================================
  // 8. Order Flow Analysis
  // ============================================================================
  console.log('\n--- ORDER FLOW ANALYSIS ---');

  // Book imbalance
  const winnerImbalance = computeStats(winnerData, 'sizeImbalance');
  const loserImbalance = computeStats(loserData, 'sizeImbalance');

  console.log(`\nBook Size Imbalance (positive = more bids):`);
  console.log(`  Winners: mean=${winnerImbalance.mean?.toFixed(4)} (n=${winnerImbalance.count})`);
  console.log(`  Losers:  mean=${loserImbalance.mean?.toFixed(4)} (n=${loserImbalance.count})`);

  // Imbalance bins for long trades
  const imbalanceBins = [
    { label: 'Strong Sell (<-0.3)', min: -1, max: -0.3 },
    { label: 'Weak Sell (-0.3 to -0.1)', min: -0.3, max: -0.1 },
    { label: 'Neutral (-0.1 to 0.1)', min: -0.1, max: 0.1 },
    { label: 'Weak Buy (0.1 to 0.3)', min: 0.1, max: 0.3 },
    { label: 'Strong Buy (>0.3)', min: 0.3, max: 1 }
  ];
  const imbalanceStats = binValues(enrichedTrades, 'sizeImbalance', imbalanceBins);
  console.log('\nWin Rate by Book Imbalance:');
  for (const [label, stats] of Object.entries(imbalanceStats)) {
    if (stats.total > 0) {
      console.log(`  ${label}: ${stats.total} trades, ${stats.winRate}% win rate, $${stats.avgPnl} avg`);
    }
  }

  // Trade volume imbalance
  const volImbalanceBins = [
    { label: 'Selling (<-0.2)', min: -1, max: -0.2 },
    { label: 'Slight Sell (-0.2 to 0)', min: -0.2, max: 0 },
    { label: 'Slight Buy (0 to 0.2)', min: 0, max: 0.2 },
    { label: 'Buying (>0.2)', min: 0.2, max: 1 }
  ];
  const volImbalanceStats = binValues(enrichedTrades, 'volumeImbalance', volImbalanceBins);
  console.log('\nWin Rate by Trade Volume Imbalance:');
  for (const [label, stats] of Object.entries(volImbalanceStats)) {
    if (stats.total > 0) {
      console.log(`  ${label}: ${stats.total} trades, ${stats.winRate}% win rate, $${stats.avgPnl} avg`);
    }
  }

  // ============================================================================
  // 9. CBBO Spread Analysis
  // ============================================================================
  console.log('\n--- OPTIONS SPREAD ANALYSIS ---');

  const spreadBins = [
    { label: 'Tight (<0.05)', min: 0, max: 0.05 },
    { label: 'Normal (0.05-0.10)', min: 0.05, max: 0.10 },
    { label: 'Wide (0.10-0.15)', min: 0.10, max: 0.15 },
    { label: 'Very Wide (>0.15)', min: 0.15, max: 10 }
  ];
  const spreadStats = binValues(enrichedTrades, 'avgSpread', spreadBins);
  console.log('\nWin Rate by Avg Options Spread:');
  for (const [label, stats] of Object.entries(spreadStats)) {
    if (stats.total > 0) {
      console.log(`  ${label}: ${stats.total} trades, ${stats.winRate}% win rate, $${stats.avgPnl} avg`);
    }
  }

  // ============================================================================
  // 10. Exit Reason Analysis
  // ============================================================================
  console.log('\n--- EXIT REASON ANALYSIS ---');
  const exitStats = winRateByCategory(enrichedTrades, 'exitReason');
  console.log('\nExit Reason    | Count | Win Rate | Avg P&L');
  console.log('-'.repeat(50));
  for (const [reason, stats] of Object.entries(exitStats)) {
    console.log(`${(reason || 'unknown').padEnd(14)} | ${String(stats.total).padStart(5)} | ${stats.winRate.padStart(7)}% | $${stats.avgPnl}`);
  }

  // ============================================================================
  // 11. Momentum Analysis
  // ============================================================================
  console.log('\n--- MOMENTUM AT ENTRY ANALYSIS ---');

  const momentumBins = [
    { label: 'Low (<10 pts)', min: 0, max: 10 },
    { label: 'Medium (10-20 pts)', min: 10, max: 20 },
    { label: 'High (20-30 pts)', min: 20, max: 30 },
    { label: 'Very High (>30 pts)', min: 30, max: 1000 }
  ];
  const momentumStats = binValues(enrichedTrades, 'momentum', momentumBins);
  console.log('\nWin Rate by Entry Momentum:');
  for (const [label, stats] of Object.entries(momentumStats)) {
    if (stats.total > 0) {
      console.log(`  ${label}: ${stats.total} trades, ${stats.winRate}% win rate, $${stats.avgPnl} avg`);
    }
  }

  // ============================================================================
  // 12. Day of Week Analysis
  // ============================================================================
  console.log('\n--- DAY OF WEEK PERFORMANCE ---');
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const dayStats = winRateByCategory(enrichedTrades, 'dayOfWeek');
  console.log('\nDay | Trades | Win Rate | Avg P&L');
  console.log('-'.repeat(40));
  for (const [day, stats] of Object.entries(dayStats).sort((a, b) => parseInt(a) - parseInt(b))) {
    console.log(`${dayNames[parseInt(day)]} | ${String(stats.total).padStart(6)} | ${stats.winRate.padStart(7)}% | $${stats.avgPnl}`);
  }

  // ============================================================================
  // Summary: Best Filters Found
  // ============================================================================
  console.log('\n' + '='.repeat(80));
  console.log('FILTER RECOMMENDATIONS');
  console.log('='.repeat(80));

  // Collect all filter candidates with significant win rate differences
  const filterCandidates = [];

  // Check for significant differences in each category
  const baselineWinRate = 55.53;

  // Helper to find best/worst categories
  function findSignificantFilters(stats, categoryName, minTrades = 20) {
    for (const [cat, data] of Object.entries(stats)) {
      if (data.total >= minTrades) {
        const winRate = parseFloat(data.winRate);
        const diff = winRate - baselineWinRate;
        if (Math.abs(diff) > 5) { // 5% threshold
          filterCandidates.push({
            category: categoryName,
            value: cat,
            winRate,
            diff,
            trades: data.total,
            avgPnl: parseFloat(data.avgPnl)
          });
        }
      }
    }
  }

  findSignificantFilters(levelStats, 'LT Level');
  findSignificantFilters(sessionStats, 'Session');
  findSignificantFilters(hourStats, 'Hour', 10);
  findSignificantFilters(regimeStats, 'GEX Regime');
  findSignificantFilters(gammaFlipStats, 'Gamma Flip Position');
  findSignificantFilters(nearSupportStats, 'Near GEX Support');
  findSignificantFilters(nearResStats, 'Near GEX Resistance');
  findSignificantFilters(resDistStats, 'Resistance Distance');
  findSignificantFilters(ivStats, 'IV Level');
  findSignificantFilters(skewStats, 'IV Skew');
  findSignificantFilters(imbalanceStats, 'Book Imbalance');
  findSignificantFilters(volImbalanceStats, 'Volume Imbalance');
  findSignificantFilters(spreadStats, 'Options Spread');
  findSignificantFilters(momentumStats, 'Momentum');
  findSignificantFilters(dayStats, 'Day of Week');

  // Sort by impact (win rate diff * trade count for significance)
  filterCandidates.sort((a, b) => Math.abs(b.diff * b.trades) - Math.abs(a.diff * a.trades));

  console.log('\nPotential INCLUSION filters (higher win rate than baseline):');
  const inclusions = filterCandidates.filter(f => f.diff > 0);
  for (const f of inclusions.slice(0, 10)) {
    console.log(`  ${f.category} = ${f.value}: ${f.winRate}% win rate (+${f.diff.toFixed(1)}%), ${f.trades} trades, $${f.avgPnl} avg`);
  }

  console.log('\nPotential EXCLUSION filters (lower win rate than baseline):');
  const exclusions = filterCandidates.filter(f => f.diff < 0);
  for (const f of exclusions.slice(0, 10)) {
    console.log(`  ${f.category} = ${f.value}: ${f.winRate}% win rate (${f.diff.toFixed(1)}%), ${f.trades} trades, $${f.avgPnl} avg`);
  }

  // Save enriched data for further analysis
  const outputPath = path.join(RESULTS_DIR, 'lc-50-2025-enriched.json');
  fs.writeFileSync(outputPath, JSON.stringify(enrichedTrades, null, 2));
  console.log(`\nEnriched trade data saved to: ${outputPath}`);
}

main().catch(console.error);
