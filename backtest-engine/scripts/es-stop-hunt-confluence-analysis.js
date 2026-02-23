#!/usr/bin/env node
/**
 * ES Stop Hunt Confluence Analysis
 *
 * Cross-references the stop hunt backtest trades against all available
 * timestamped data to find what distinguishes winners from losers:
 *
 * Data sources:
 * 1. OFI (Order Flow Imbalance) - buy/sell volume, imbalance, large trades
 * 2. GEX snapshots - total_gex, total_vex, total_cex, regime, gamma_flip distance
 * 3. LT levels - proximity to LT levels, sentiment
 * 4. MBO tick-level trades - raw order book events around entry
 *
 * Usage:
 *   node scripts/es-stop-hunt-confluence-analysis.js [options]
 *   --trades <path>   Path to backtest trades JSON (default: results/es-orderflow/stop-hunt-strategy-backtest.json)
 *   --output <path>   Output path (default: results/es-orderflow/stop-hunt-confluence.json)
 *   --window <min>    OFI lookback/forward window in minutes (default: 10)
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { GexLoader } from '../src/data-loaders/gex-loader.js';

const args = process.argv.slice(2);
const getArg = (name, defaultValue) => {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 ? args[idx + 1] : defaultValue;
};

const tradesPath = getArg('trades', 'results/es-orderflow/stop-hunt-strategy-backtest.json');
const outputPath = getArg('output', 'results/es-orderflow/stop-hunt-confluence.json');
const ofiWindow = parseInt(getArg('window', '10'));

const dataDir = path.resolve(process.cwd(), 'data');

console.log('='.repeat(80));
console.log('ES STOP HUNT CONFLUENCE ANALYSIS');
console.log('='.repeat(80));
console.log(`Trades: ${tradesPath}`);
console.log(`OFI window: ±${ofiWindow} minutes`);
console.log();

// ============================================================================
// 1. Load Backtest Trades
// ============================================================================

function loadTrades() {
  const fullPath = path.resolve(process.cwd(), tradesPath);
  const raw = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
  console.log(`Loaded ${raw.trades.length} trades from backtest`);
  return raw.trades;
}

// ============================================================================
// 2. Load OFI Data (1-minute pre-aggregated order flow)
// ============================================================================

async function loadOFIData(trades) {
  const filePath = path.join(dataDir, 'orderflow/es/trade-ofi-1m.csv');
  console.log('Loading OFI data...');

  // Determine date range we need
  const tradeTimestamps = trades.map(t => new Date(t.entryTime).getTime());
  const minTs = Math.min(...tradeTimestamps) - ofiWindow * 60 * 1000 * 2;
  const maxTs = Math.max(...tradeTimestamps) + ofiWindow * 60 * 1000 * 2;

  const ofiMap = new Map(); // timestamp_ms -> OFI row
  const rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });
  let headerSkipped = false;
  let loaded = 0;

  for await (const line of rl) {
    if (!headerSkipped) { headerSkipped = true; continue; }
    const parts = line.split(',');
    if (parts.length < 17) continue;

    const ts = new Date(parts[0]).getTime();
    if (ts < minTs || ts > maxTs) continue;

    ofiMap.set(ts, {
      timestamp: ts,
      buyVolume: parseInt(parts[1]),
      sellVolume: parseInt(parts[2]),
      netVolume: parseInt(parts[3]),
      totalVolume: parseInt(parts[4]),
      buyTrades: parseInt(parts[5]),
      sellTrades: parseInt(parts[6]),
      totalTrades: parseInt(parts[7]),
      volumeImbalance: parseFloat(parts[8]),
      avgTradeSize: parseFloat(parts[9]),
      maxTradeSize: parseInt(parts[10]),
      largeTradeBuyVol: parseInt(parts[11]),
      largeTradeSellVol: parseInt(parts[12]),
      vwap: parseFloat(parts[13]),
      avgBuySize: parseFloat(parts[14]),
      avgSellSize: parseFloat(parts[15]),
      tradeImbalance: parseFloat(parts[16])
    });
    loaded++;
  }

  console.log(`  Loaded ${loaded} OFI rows covering trade time range`);
  return ofiMap;
}

// ============================================================================
// 3. Load LT Levels (15-minute)
// ============================================================================

async function loadLTLevels(trades) {
  const filePath = path.join(dataDir, 'liquidity/es/ES_liquidity_levels_15m.csv');
  console.log('Loading LT levels (15m)...');

  const tradeTimestamps = trades.map(t => new Date(t.entryTime).getTime());
  const minTs = Math.min(...tradeTimestamps) - 3600000;
  const maxTs = Math.max(...tradeTimestamps) + 3600000;

  const ltData = []; // sorted array of { timestamp, sentiment, levels[] }
  const rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });
  let headerSkipped = false;

  for await (const line of rl) {
    if (!headerSkipped) { headerSkipped = true; continue; }
    const parts = line.split(',');
    if (parts.length < 8) continue;

    const ts = parseInt(parts[1]); // unix_timestamp is in ms
    if (ts < minTs || ts > maxTs) continue;

    ltData.push({
      timestamp: ts,
      sentiment: parts[2]?.trim(),
      levels: [
        parseFloat(parts[3]),
        parseFloat(parts[4]),
        parseFloat(parts[5]),
        parseFloat(parts[6]),
        parseFloat(parts[7])
      ]
    });
  }

  ltData.sort((a, b) => a.timestamp - b.timestamp);
  console.log(`  Loaded ${ltData.length} LT snapshots`);
  return ltData;
}

function getLTAtTime(ltData, targetTs) {
  // Binary search for most recent LT snapshot before targetTs
  let lo = 0, hi = ltData.length - 1;
  let result = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ltData[mid].timestamp <= targetTs) {
      result = ltData[mid];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return result;
}

// ============================================================================
// 4. Load GEX Data via GexLoader
// ============================================================================

async function loadGEXData(trades) {
  console.log('Loading GEX data...');
  const tradeTimestamps = trades.map(t => new Date(t.entryTime));
  const minDate = new Date(Math.min(...tradeTimestamps.map(d => d.getTime())) - 86400000);
  const maxDate = new Date(Math.max(...tradeTimestamps.map(d => d.getTime())) + 86400000);

  const gexLoader = new GexLoader(path.join(dataDir, 'gex'), 'es');
  await gexLoader.loadDateRange(minDate, maxDate);
  console.log(`  GEX data range: ${gexLoader.sortedTimestamps.length} snapshots`);
  return gexLoader;
}

// ============================================================================
// 5. Enrichment: For each trade, gather all confluence data
// ============================================================================

function getOFIWindow(ofiMap, centerTs, windowMinutes) {
  const rows = [];
  for (let offset = -windowMinutes; offset <= windowMinutes; offset++) {
    const ts = centerTs + offset * 60000;
    const row = ofiMap.get(ts);
    if (row) rows.push({ ...row, offset });
  }
  return rows;
}

function aggregateOFI(rows) {
  if (rows.length === 0) return null;
  const sum = (arr, key) => arr.reduce((s, r) => s + (r[key] || 0), 0);
  const avg = (arr, key) => sum(arr, key) / arr.length;

  return {
    count: rows.length,
    totalBuyVolume: sum(rows, 'buyVolume'),
    totalSellVolume: sum(rows, 'sellVolume'),
    totalNetVolume: sum(rows, 'netVolume'),
    totalVolume: sum(rows, 'totalVolume'),
    avgVolumeImbalance: avg(rows, 'volumeImbalance'),
    avgTradeImbalance: avg(rows, 'tradeImbalance'),
    totalLargeBuyVol: sum(rows, 'largeTradeBuyVol'),
    totalLargeSellVol: sum(rows, 'largeTradeSellVol'),
    maxTradeSize: Math.max(...rows.map(r => r.maxTradeSize)),
    avgAvgTradeSize: avg(rows, 'avgTradeSize'),
    avgBuySize: avg(rows, 'avgBuySize'),
    avgSellSize: avg(rows, 'avgSellSize')
  };
}

function enrichTrade(trade, ofiMap, ltData, gexLoader) {
  const entryTs = new Date(trade.entryTime).getTime();
  const entryDate = new Date(trade.entryTime);
  const isWin = trade.pointsPnL > 0;

  // -- OFI at entry minute --
  const entryOFI = ofiMap.get(entryTs) || null;

  // -- OFI in pre-entry window (the extension phase) --
  const preRows = getOFIWindow(ofiMap, entryTs, ofiWindow)
    .filter(r => r.offset >= -ofiWindow && r.offset < 0);
  const preOFI = aggregateOFI(preRows);

  // -- OFI at entry minute only --
  const entryRows = getOFIWindow(ofiMap, entryTs, 0);
  const entryOFIAgg = aggregateOFI(entryRows);

  // -- OFI post-entry (how does flow develop after entry) --
  const postRows = getOFIWindow(ofiMap, entryTs, ofiWindow)
    .filter(r => r.offset > 0 && r.offset <= ofiWindow);
  const postOFI = aggregateOFI(postRows);

  // -- Extension phase OFI (1-5 bars before entry = the stop hunt itself) --
  const barsToReversal = trade.metadata?.bars_to_reversal || 1;
  const extensionRows = getOFIWindow(ofiMap, entryTs, barsToReversal + 1)
    .filter(r => r.offset >= -(barsToReversal + 1) && r.offset < 0);
  const extensionOFI = aggregateOFI(extensionRows);

  // -- Reversal bar OFI (the entry bar itself) --
  const reversalOFI = entryOFI;

  // -- GEX snapshot at entry --
  const gexData = gexLoader.getGexLevels(entryDate);
  let gexFeatures = null;
  if (gexData) {
    const gammaFlipDist = gexData.gamma_flip ? trade.entryPrice - gexData.gamma_flip : null;
    const callWallDist = gexData.call_wall ? trade.entryPrice - gexData.call_wall : null;
    const putWallDist = gexData.put_wall ? trade.entryPrice - gexData.put_wall : null;

    // How many support levels are below entry? (more = deeper support)
    const supportsBelow = (gexData.support || []).filter(s => s < trade.entryPrice).length;
    const resistancesAbove = (gexData.resistance || []).filter(r => r > trade.entryPrice).length;

    gexFeatures = {
      regime: gexData.regime,
      totalGex: gexData.total_gex,
      totalVex: gexData.total_vex,
      totalCex: gexData.total_cex,
      gammaFlipDistance: gammaFlipDist,
      callWallDistance: callWallDist,
      putWallDistance: putWallDist,
      supportsBelow,
      resistancesAbove,
      optionsCount: gexData.options_count,
      isPositiveGEX: gexData.total_gex > 1e9,
      isNegativeGEX: gexData.total_gex < -1e9,
      gexMagnitude: Math.abs(gexData.total_gex)
    };
  }

  // -- LT levels at entry --
  const ltSnapshot = getLTAtTime(ltData, entryTs);
  let ltFeatures = null;
  if (ltSnapshot) {
    const allLevels = ltSnapshot.levels.filter(l => !isNaN(l));
    const levelsBelow = allLevels.filter(l => l < trade.entryPrice);
    const levelsAbove = allLevels.filter(l => l > trade.entryPrice);
    const closestBelow = levelsBelow.length ? Math.max(...levelsBelow) : null;
    const closestAbove = levelsAbove.length ? Math.min(...levelsAbove) : null;

    ltFeatures = {
      sentiment: ltSnapshot.sentiment,
      levelsBelow: levelsBelow.length,
      levelsAbove: levelsAbove.length,
      closestBelowDist: closestBelow ? trade.entryPrice - closestBelow : null,
      closestAboveDist: closestAbove ? closestAbove - trade.entryPrice : null,
      levelSpread: closestAbove && closestBelow ? closestAbove - closestBelow : null,
      // Check if any LT level is near the hunted GEX level (confluence)
      ltNearHuntedLevel: allLevels.some(l =>
        Math.abs(l - trade.metadata.hunted_level) < 5
      ),
      ltLevelDistances: allLevels.map(l => l - trade.entryPrice)
    };
  }

  // -- Derived confluence features --
  const confluence = {};

  // Buy-side absorption on reversal bar: buyers dominate on the entry bar
  if (reversalOFI) {
    confluence.reversalBuyDominant = reversalOFI.netVolume > 0;
    confluence.reversalVolumeImbalance = reversalOFI.volumeImbalance;
    confluence.reversalLargeBuyPct = reversalOFI.totalVolume > 0
      ? reversalOFI.largeTradeBuyVol / reversalOFI.totalVolume : 0;
    confluence.reversalLargeSellPct = reversalOFI.totalVolume > 0
      ? reversalOFI.largeTradeSellVol / reversalOFI.totalVolume : 0;
    confluence.reversalLargeNetPct = confluence.reversalLargeBuyPct - confluence.reversalLargeSellPct;
  }

  // Extension phase: sellers dominate during the hunt
  if (extensionOFI) {
    confluence.extensionSellDominant = extensionOFI.totalNetVolume < 0;
    confluence.extensionImbalance = extensionOFI.avgVolumeImbalance;
    confluence.extensionLargeSellPct = extensionOFI.totalVolume > 0
      ? extensionOFI.totalLargeSellVol / extensionOFI.totalVolume : 0;
  }

  // Flow reversal: extension was sell-dominated, reversal bar is buy-dominated
  if (extensionOFI && reversalOFI) {
    confluence.flowReversal = extensionOFI.totalNetVolume < 0 && reversalOFI.netVolume > 0;
    confluence.imbalanceSwing = reversalOFI.volumeImbalance - extensionOFI.avgVolumeImbalance;
  }

  // LT + GEX confluence
  if (ltFeatures) {
    confluence.ltGexConfluence = ltFeatures.ltNearHuntedLevel;
    confluence.ltSentimentBullish = ltFeatures.sentiment === 'BULLISH';
  }

  // GEX magnitude context
  if (gexFeatures) {
    confluence.belowGammaFlip = gexFeatures.gammaFlipDistance !== null && gexFeatures.gammaFlipDistance < 0;
    confluence.gexRegime = gexFeatures.regime;
  }

  return {
    id: trade.id,
    entryTime: trade.entryTime,
    exitTime: trade.exitTime,
    entryPrice: trade.entryPrice,
    exitPrice: trade.exitPrice,
    pointsPnL: trade.pointsPnL,
    isWin,
    exitReason: trade.exitReason,
    mfe: trade.mfe,
    mae: trade.mae,
    barsHeld: trade.barsHeld,
    metadata: trade.metadata,
    ofi: {
      entry: entryOFI ? {
        buyVolume: entryOFI.buyVolume,
        sellVolume: entryOFI.sellVolume,
        netVolume: entryOFI.netVolume,
        totalVolume: entryOFI.totalVolume,
        volumeImbalance: entryOFI.volumeImbalance,
        tradeImbalance: entryOFI.tradeImbalance,
        largeTradeBuyVol: entryOFI.largeTradeBuyVol,
        largeTradeSellVol: entryOFI.largeTradeSellVol,
        maxTradeSize: entryOFI.maxTradeSize,
        avgTradeSize: entryOFI.avgTradeSize
      } : null,
      pre: preOFI,
      post: postOFI,
      extension: extensionOFI
    },
    gex: gexFeatures,
    lt: ltFeatures,
    confluence
  };
}

// ============================================================================
// 6. Statistical Analysis: Compare winners vs losers
// ============================================================================

function analyzeFeature(enrichedTrades, featurePath, featureName, opts = {}) {
  const winners = [];
  const losers = [];

  for (const t of enrichedTrades) {
    const val = getNestedValue(t, featurePath);
    if (val === null || val === undefined || isNaN(val)) continue;
    if (t.isWin) winners.push(val);
    else losers.push(val);
  }

  if (winners.length < 5 || losers.length < 5) return null;

  const winStats = computeStats(winners);
  const loseStats = computeStats(losers);

  // Effect size (Cohen's d)
  const pooledStd = Math.sqrt(
    ((winners.length - 1) * winStats.std ** 2 + (losers.length - 1) * loseStats.std ** 2) /
    (winners.length + losers.length - 2)
  );
  const cohensD = pooledStd > 0 ? (winStats.mean - loseStats.mean) / pooledStd : 0;

  // Mann-Whitney U approximation (z-score)
  const zScore = mannWhitneyZ(winners, losers);

  return {
    feature: featureName,
    winnerN: winners.length,
    loserN: losers.length,
    winnerMean: round(winStats.mean),
    loserMean: round(loseStats.mean),
    winnerMedian: round(winStats.median),
    loserMedian: round(loseStats.median),
    winnerStd: round(winStats.std),
    loserStd: round(loseStats.std),
    meanDiff: round(winStats.mean - loseStats.mean),
    medianDiff: round(winStats.median - loseStats.median),
    cohensD: round(cohensD),
    zScore: round(zScore),
    significant: Math.abs(zScore) >= 1.96 // p < 0.05
  };
}

function analyzeBooleanFeature(enrichedTrades, featurePath, featureName) {
  let winTrue = 0, winFalse = 0, loseTrue = 0, loseFalse = 0;

  for (const t of enrichedTrades) {
    const val = getNestedValue(t, featurePath);
    if (val === null || val === undefined) continue;
    if (t.isWin) {
      if (val) winTrue++; else winFalse++;
    } else {
      if (val) loseTrue++; else loseFalse++;
    }
  }

  const totalTrue = winTrue + loseTrue;
  const totalFalse = winFalse + loseFalse;
  if (totalTrue < 5 || totalFalse < 5) return null;

  const winRateWhenTrue = totalTrue > 0 ? winTrue / totalTrue : 0;
  const winRateWhenFalse = totalFalse > 0 ? winFalse / totalFalse : 0;

  return {
    feature: featureName,
    trueCount: totalTrue,
    falseCount: totalFalse,
    winRateWhenTrue: round(winRateWhenTrue * 100),
    winRateWhenFalse: round(winRateWhenFalse * 100),
    winRateDiff: round((winRateWhenTrue - winRateWhenFalse) * 100),
    significant: Math.abs(winRateWhenTrue - winRateWhenFalse) > 0.10 // 10%+ difference
  };
}

// Analyze categorical features
function analyzeCategoricalFeature(enrichedTrades, featurePath, featureName) {
  const buckets = {};

  for (const t of enrichedTrades) {
    const val = getNestedValue(t, featurePath);
    if (val === null || val === undefined) continue;
    if (!buckets[val]) buckets[val] = { wins: 0, losses: 0, totalPnL: 0 };
    if (t.isWin) buckets[val].wins++;
    else buckets[val].losses++;
    buckets[val].totalPnL += t.pointsPnL;
  }

  const results = {};
  for (const [key, data] of Object.entries(buckets)) {
    const total = data.wins + data.losses;
    if (total < 3) continue;
    results[key] = {
      count: total,
      winRate: round((data.wins / total) * 100),
      avgPnL: round(data.totalPnL / total),
      totalPnL: round(data.totalPnL)
    };
  }
  return { feature: featureName, categories: results };
}

// ============================================================================
// 7. Optimal Threshold Analysis
// ============================================================================

function findOptimalThreshold(enrichedTrades, featurePath, featureName, direction = 'above') {
  const valid = enrichedTrades
    .map(t => ({ val: getNestedValue(t, featurePath), isWin: t.isWin, pnl: t.pointsPnL }))
    .filter(t => t.val !== null && t.val !== undefined && !isNaN(t.val));

  if (valid.length < 20) return null;

  const sorted = valid.map(v => v.val).sort((a, b) => a - b);
  const percentiles = [10, 20, 25, 30, 40, 50, 60, 70, 75, 80, 90];

  let bestThreshold = null;
  let bestScore = -Infinity;
  const thresholdResults = [];

  for (const pct of percentiles) {
    const idx = Math.floor(sorted.length * pct / 100);
    const threshold = sorted[idx];

    const passing = direction === 'above'
      ? valid.filter(v => v.val >= threshold)
      : valid.filter(v => v.val <= threshold);

    if (passing.length < 10) continue;

    const wins = passing.filter(v => v.isWin).length;
    const winRate = wins / passing.length;
    const avgPnL = passing.reduce((s, v) => s + v.pnl, 0) / passing.length;
    const totalPnL = passing.reduce((s, v) => s + v.pnl, 0);

    // Score: winRate * sqrt(n) * avgPnL — balances WR, sample size, and profitability
    const score = winRate * Math.sqrt(passing.length) * (avgPnL > 0 ? avgPnL : 0);

    thresholdResults.push({
      percentile: pct,
      threshold: round(threshold),
      n: passing.length,
      winRate: round(winRate * 100),
      avgPnL: round(avgPnL),
      totalPnL: round(totalPnL),
      score: round(score)
    });

    if (score > bestScore) {
      bestScore = score;
      bestThreshold = { percentile: pct, threshold: round(threshold), n: passing.length, winRate: round(winRate * 100), avgPnL: round(avgPnL) };
    }
  }

  return {
    feature: featureName,
    direction,
    best: bestThreshold,
    thresholds: thresholdResults
  };
}

// ============================================================================
// 8. Combined Filter Analysis
// ============================================================================

function testCombinedFilters(enrichedTrades) {
  console.log('\n🔬 COMBINED FILTER ANALYSIS');
  console.log('='.repeat(60));

  const filters = {
    'Flow Reversal': t => t.confluence.flowReversal === true,
    'Reversal Buy Dominant': t => t.confluence.reversalBuyDominant === true,
    'Extension Sell Dominant': t => t.confluence.extensionSellDominant === true,
    'Large Buy on Reversal (>5%)': t => (t.confluence.reversalLargeBuyPct || 0) > 0.05,
    'Large Buy on Reversal (>10%)': t => (t.confluence.reversalLargeBuyPct || 0) > 0.10,
    'Imbalance Swing > 0.1': t => (t.confluence.imbalanceSwing || 0) > 0.1,
    'Imbalance Swing > 0.2': t => (t.confluence.imbalanceSwing || 0) > 0.2,
    'Imbalance Swing > 0.3': t => (t.confluence.imbalanceSwing || 0) > 0.3,
    'LT+GEX Confluence': t => t.confluence.ltGexConfluence === true,
    'LT Bullish': t => t.confluence.ltSentimentBullish === true,
    'Below Gamma Flip': t => t.confluence.belowGammaFlip === true,
    'Positive Regime': t => t.gex?.regime === 'positive',
    'Negative Regime': t => t.gex?.regime === 'negative',
    'Entry Vol Imbalance > 0': t => (t.ofi?.entry?.volumeImbalance || 0) > 0,
    'Entry Vol Imbalance > 0.1': t => (t.ofi?.entry?.volumeImbalance || 0) > 0.1,
    'Entry Large Buy > Large Sell': t => (t.ofi?.entry?.largeTradeBuyVol || 0) > (t.ofi?.entry?.largeTradeSellVol || 0),
    'Entry MaxTradeSize > 50': t => (t.ofi?.entry?.maxTradeSize || 0) > 50,
    'Entry MaxTradeSize > 100': t => (t.ofi?.entry?.maxTradeSize || 0) > 100,
    'LT Support Below (>=3)': t => (t.lt?.levelsBelow || 0) >= 3,
    'RTH Session': t => t.metadata?.session === 'rth',
    'Pre-market Session': t => t.metadata?.session === 'premarket',
    'Penetration Depth > 2': t => (t.metadata?.penetration_depth || 0) > 2,
    'Volume Ratio > 2': t => (t.metadata?.volume_ratio || 0) > 2,
    'Volume Ratio > 3': t => (t.metadata?.volume_ratio || 0) > 3,
    'Bars to Reversal = 1': t => (t.metadata?.bars_to_reversal || 0) === 1,
  };

  const singleResults = {};

  for (const [name, filterFn] of Object.entries(filters)) {
    const passing = enrichedTrades.filter(filterFn);
    if (passing.length < 5) continue;

    const wins = passing.filter(t => t.isWin).length;
    const winRate = wins / passing.length;
    const avgPnL = passing.reduce((s, t) => s + t.pointsPnL, 0) / passing.length;
    const totalPnL = passing.reduce((s, t) => s + t.pointsPnL, 0);

    singleResults[name] = {
      n: passing.length,
      wins,
      winRate: round(winRate * 100),
      avgPnL: round(avgPnL),
      totalPnL: round(totalPnL)
    };
  }

  // Sort by win rate
  const sorted = Object.entries(singleResults)
    .sort(([, a], [, b]) => b.winRate - a.winRate);

  console.log(`\n${'Filter'.padEnd(40)} ${'n'.padStart(5)} ${'WR%'.padStart(7)} ${'AvgPnL'.padStart(8)} ${'TotPnL'.padStart(8)}`);
  console.log('-'.repeat(70));
  for (const [name, r] of sorted) {
    console.log(`${name.padEnd(40)} ${String(r.n).padStart(5)} ${String(r.winRate + '%').padStart(7)} ${String(r.avgPnL).padStart(8)} ${String(r.totalPnL).padStart(8)}`);
  }

  // Now test combinations of the top individual filters
  console.log('\n\n📊 TOP FILTER COMBINATIONS');
  console.log('='.repeat(60));

  const filterEntries = Object.entries(filters);
  const combos = [];

  // Test all pairs
  for (let i = 0; i < filterEntries.length; i++) {
    for (let j = i + 1; j < filterEntries.length; j++) {
      const [nameA, fnA] = filterEntries[i];
      const [nameB, fnB] = filterEntries[j];

      const passing = enrichedTrades.filter(t => fnA(t) && fnB(t));
      if (passing.length < 8) continue;

      const wins = passing.filter(t => t.isWin).length;
      const winRate = wins / passing.length;
      const avgPnL = passing.reduce((s, t) => s + t.pointsPnL, 0) / passing.length;
      const totalPnL = passing.reduce((s, t) => s + t.pointsPnL, 0);

      combos.push({
        filters: `${nameA} + ${nameB}`,
        n: passing.length,
        wins,
        winRate: round(winRate * 100),
        avgPnL: round(avgPnL),
        totalPnL: round(totalPnL)
      });
    }
  }

  // Test triples of promising filters (top 8 by win rate)
  const topFilters = sorted.slice(0, 8).map(([name]) => filterEntries.find(([n]) => n === name)).filter(Boolean);
  for (let i = 0; i < topFilters.length; i++) {
    for (let j = i + 1; j < topFilters.length; j++) {
      for (let k = j + 1; k < topFilters.length; k++) {
        const [nameA, fnA] = topFilters[i];
        const [nameB, fnB] = topFilters[j];
        const [nameC, fnC] = topFilters[k];

        const passing = enrichedTrades.filter(t => fnA(t) && fnB(t) && fnC(t));
        if (passing.length < 5) continue;

        const wins = passing.filter(t => t.isWin).length;
        const winRate = wins / passing.length;
        const avgPnL = passing.reduce((s, t) => s + t.pointsPnL, 0) / passing.length;
        const totalPnL = passing.reduce((s, t) => s + t.pointsPnL, 0);

        combos.push({
          filters: `${nameA} + ${nameB} + ${nameC}`,
          n: passing.length,
          wins,
          winRate: round(winRate * 100),
          avgPnL: round(avgPnL),
          totalPnL: round(totalPnL)
        });
      }
    }
  }

  combos.sort((a, b) => b.winRate - a.winRate || b.avgPnL - a.avgPnL);

  console.log(`\n${'Filters'.padEnd(70)} ${'n'.padStart(4)} ${'WR%'.padStart(7)} ${'Avg'.padStart(7)} ${'Tot'.padStart(7)}`);
  console.log('-'.repeat(97));
  for (const c of combos.slice(0, 40)) {
    console.log(`${c.filters.substring(0, 70).padEnd(70)} ${String(c.n).padStart(4)} ${String(c.winRate + '%').padStart(7)} ${String(c.avgPnL).padStart(7)} ${String(c.totalPnL).padStart(7)}`);
  }

  return { singles: singleResults, topCombos: combos.slice(0, 40) };
}

// ============================================================================
// Utility Functions
// ============================================================================

function getNestedValue(obj, path) {
  const parts = path.split('.');
  let current = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return null;
    current = current[part];
  }
  return current;
}

function computeStats(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const n = arr.length;
  const mean = arr.reduce((s, v) => s + v, 0) / n;
  const variance = arr.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1);
  const std = Math.sqrt(variance);
  const median = n % 2 === 0
    ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2
    : sorted[(n - 1) / 2];
  const q25 = sorted[Math.floor(n * 0.25)];
  const q75 = sorted[Math.floor(n * 0.75)];
  return { mean, median, std, min: sorted[0], max: sorted[n - 1], q25, q75 };
}

function mannWhitneyZ(a, b) {
  // Approximate z-score for Mann-Whitney U test
  const combined = [
    ...a.map(v => ({ v, group: 'a' })),
    ...b.map(v => ({ v, group: 'b' }))
  ].sort((x, y) => x.v - y.v);

  let rankSum = 0;
  for (let i = 0; i < combined.length; i++) {
    if (combined[i].group === 'a') rankSum += i + 1;
  }

  const na = a.length, nb = b.length;
  const U = rankSum - na * (na + 1) / 2;
  const meanU = na * nb / 2;
  const stdU = Math.sqrt(na * nb * (na + nb + 1) / 12);

  return stdU > 0 ? (U - meanU) / stdU : 0;
}

function round(v, decimals = 4) {
  return Math.round(v * 10 ** decimals) / 10 ** decimals;
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const trades = loadTrades();

  // Load all data sources in parallel
  const [ofiMap, ltData, gexLoader] = await Promise.all([
    loadOFIData(trades),
    loadLTLevels(trades),
    loadGEXData(trades)
  ]);

  // Enrich each trade
  console.log('\nEnriching trades with confluence data...');
  const enriched = trades.map(t => enrichTrade(t, ofiMap, ltData, gexLoader));
  console.log(`  Enriched ${enriched.length} trades`);

  // Count data availability
  const hasOFI = enriched.filter(t => t.ofi.entry !== null).length;
  const hasGEX = enriched.filter(t => t.gex !== null).length;
  const hasLT = enriched.filter(t => t.lt !== null).length;
  console.log(`  OFI data: ${hasOFI}/${enriched.length} trades`);
  console.log(`  GEX data: ${hasGEX}/${enriched.length} trades`);
  console.log(`  LT data:  ${hasLT}/${enriched.length} trades`);

  const winCount = enriched.filter(t => t.isWin).length;
  const loseCount = enriched.filter(t => !t.isWin).length;
  console.log(`\n  Winners: ${winCount}, Losers: ${loseCount}, Win Rate: ${round(winCount / enriched.length * 100, 1)}%`);

  // ========================================================================
  // Statistical Analysis
  // ========================================================================

  console.log('\n' + '='.repeat(80));
  console.log('FEATURE ANALYSIS: WINNERS vs LOSERS');
  console.log('='.repeat(80));

  // Numeric features to compare
  const numericFeatures = [
    // OFI entry features
    ['ofi.entry.volumeImbalance', 'Entry Volume Imbalance'],
    ['ofi.entry.tradeImbalance', 'Entry Trade Imbalance'],
    ['ofi.entry.netVolume', 'Entry Net Volume'],
    ['ofi.entry.totalVolume', 'Entry Total Volume'],
    ['ofi.entry.largeTradeBuyVol', 'Entry Large Buy Vol'],
    ['ofi.entry.largeTradeSellVol', 'Entry Large Sell Vol'],
    ['ofi.entry.maxTradeSize', 'Entry Max Trade Size'],
    ['ofi.entry.avgTradeSize', 'Entry Avg Trade Size'],
    // OFI pre-entry
    ['ofi.pre.avgVolumeImbalance', 'Pre-Entry Avg Vol Imbalance'],
    ['ofi.pre.avgTradeImbalance', 'Pre-Entry Avg Trade Imbalance'],
    ['ofi.pre.totalLargeBuyVol', 'Pre-Entry Large Buy Vol'],
    ['ofi.pre.totalLargeSellVol', 'Pre-Entry Large Sell Vol'],
    ['ofi.pre.maxTradeSize', 'Pre-Entry Max Trade Size'],
    // OFI extension phase
    ['ofi.extension.avgVolumeImbalance', 'Extension Vol Imbalance'],
    ['ofi.extension.totalLargeBuyVol', 'Extension Large Buy Vol'],
    ['ofi.extension.totalLargeSellVol', 'Extension Large Sell Vol'],
    // Confluence derived
    ['confluence.reversalVolumeImbalance', 'Reversal Vol Imbalance'],
    ['confluence.reversalLargeBuyPct', 'Reversal Large Buy %'],
    ['confluence.reversalLargeSellPct', 'Reversal Large Sell %'],
    ['confluence.reversalLargeNetPct', 'Reversal Large Net %'],
    ['confluence.imbalanceSwing', 'Imbalance Swing (ext→rev)'],
    ['confluence.extensionImbalance', 'Extension Imbalance'],
    ['confluence.extensionLargeSellPct', 'Extension Large Sell %'],
    // GEX features
    ['gex.totalGex', 'Total GEX'],
    ['gex.totalVex', 'Total VEX'],
    ['gex.totalCex', 'Total CEX'],
    ['gex.gammaFlipDistance', 'Gamma Flip Distance'],
    ['gex.putWallDistance', 'Put Wall Distance'],
    ['gex.callWallDistance', 'Call Wall Distance'],
    ['gex.supportsBelow', 'GEX Supports Below Entry'],
    ['gex.resistancesAbove', 'GEX Resistances Above Entry'],
    ['gex.gexMagnitude', 'GEX Magnitude (abs)'],
    ['gex.optionsCount', 'Options Count'],
    // LT features
    ['lt.levelsBelow', 'LT Levels Below Entry'],
    ['lt.levelsAbove', 'LT Levels Above Entry'],
    ['lt.closestBelowDist', 'LT Closest Below Dist'],
    ['lt.closestAboveDist', 'LT Closest Above Dist'],
    ['lt.levelSpread', 'LT Level Spread'],
    // Trade metadata
    ['metadata.penetration_depth', 'Penetration Depth'],
    ['metadata.risk_points', 'Risk Points'],
    ['metadata.volume_ratio', 'Volume Ratio'],
    ['metadata.bars_to_reversal', 'Bars to Reversal'],
    ['mfe', 'Max Favorable Excursion'],
    ['mae', 'Max Adverse Excursion'],
  ];

  const numericResults = [];
  for (const [path, name] of numericFeatures) {
    const result = analyzeFeature(enriched, path, name);
    if (result) numericResults.push(result);
  }

  // Sort by absolute effect size
  numericResults.sort((a, b) => Math.abs(b.cohensD) - Math.abs(a.cohensD));

  console.log('\n📈 NUMERIC FEATURES (sorted by effect size)');
  console.log(`${'Feature'.padEnd(35)} ${'Win Mean'.padStart(10)} ${'Lose Mean'.padStart(10)} ${'Diff'.padStart(8)} ${"Cohen's d".padStart(10)} ${'z-score'.padStart(8)} ${'Sig?'.padStart(5)}`);
  console.log('-'.repeat(90));
  for (const r of numericResults) {
    const sig = r.significant ? ' ***' : '';
    console.log(`${r.feature.padEnd(35)} ${String(r.winnerMean).padStart(10)} ${String(r.loserMean).padStart(10)} ${String(r.meanDiff).padStart(8)} ${String(r.cohensD).padStart(10)} ${String(r.zScore).padStart(8)} ${sig.padStart(5)}`);
  }

  // Boolean features
  const booleanFeatures = [
    ['confluence.flowReversal', 'Flow Reversal (sell→buy)'],
    ['confluence.reversalBuyDominant', 'Reversal Bar Buy Dominant'],
    ['confluence.extensionSellDominant', 'Extension Sell Dominant'],
    ['confluence.ltGexConfluence', 'LT+GEX Level Confluence'],
    ['confluence.ltSentimentBullish', 'LT Sentiment Bullish'],
    ['confluence.belowGammaFlip', 'Below Gamma Flip'],
    ['gex.isPositiveGEX', 'Positive GEX (>1B)'],
    ['gex.isNegativeGEX', 'Negative GEX (<-1B)'],
  ];

  const booleanResults = [];
  for (const [path, name] of booleanFeatures) {
    const result = analyzeBooleanFeature(enriched, path, name);
    if (result) booleanResults.push(result);
  }

  booleanResults.sort((a, b) => Math.abs(b.winRateDiff) - Math.abs(a.winRateDiff));

  console.log('\n\n📊 BOOLEAN FEATURES (sorted by win rate difference)');
  console.log(`${'Feature'.padEnd(35)} ${'True WR%'.padStart(10)} ${'False WR%'.padStart(10)} ${'Diff'.padStart(8)} ${'True n'.padStart(8)} ${'False n'.padStart(8)} ${'Sig?'.padStart(5)}`);
  console.log('-'.repeat(87));
  for (const r of booleanResults) {
    const sig = r.significant ? ' ***' : '';
    console.log(`${r.feature.padEnd(35)} ${String(r.winRateWhenTrue + '%').padStart(10)} ${String(r.winRateWhenFalse + '%').padStart(10)} ${String(r.winRateDiff + '%').padStart(8)} ${String(r.trueCount).padStart(8)} ${String(r.falseCount).padStart(8)} ${sig.padStart(5)}`);
  }

  // Categorical features
  const categoricalFeatures = [
    ['gex.regime', 'GEX Regime'],
    ['metadata.level_type', 'Hunted Level Type'],
    ['metadata.session', 'Trading Session'],
    ['exitReason', 'Exit Reason'],
    ['lt.sentiment', 'LT Sentiment'],
  ];

  console.log('\n\n📋 CATEGORICAL FEATURES');
  const categoricalResults = [];
  for (const [path, name] of categoricalFeatures) {
    const result = analyzeCategoricalFeature(enriched, path, name);
    if (result) {
      categoricalResults.push(result);
      console.log(`\n  ${name}:`);
      console.log(`  ${'Category'.padEnd(20)} ${'n'.padStart(5)} ${'WR%'.padStart(8)} ${'AvgPnL'.padStart(8)} ${'TotPnL'.padStart(8)}`);
      console.log(`  ${'-'.repeat(50)}`);
      const sorted = Object.entries(result.categories).sort(([, a], [, b]) => b.winRate - a.winRate);
      for (const [cat, data] of sorted) {
        console.log(`  ${cat.padEnd(20)} ${String(data.count).padStart(5)} ${String(data.winRate + '%').padStart(8)} ${String(data.avgPnL).padStart(8)} ${String(data.totalPnL).padStart(8)}`);
      }
    }
  }

  // ========================================================================
  // Optimal Thresholds
  // ========================================================================

  console.log('\n\n' + '='.repeat(80));
  console.log('OPTIMAL THRESHOLD ANALYSIS');
  console.log('='.repeat(80));

  const thresholdFeatures = [
    ['ofi.entry.volumeImbalance', 'Entry Vol Imbalance', 'above'],
    ['ofi.entry.netVolume', 'Entry Net Volume', 'above'],
    ['ofi.entry.largeTradeBuyVol', 'Entry Large Buy Vol', 'above'],
    ['ofi.entry.maxTradeSize', 'Entry Max Trade Size', 'above'],
    ['confluence.imbalanceSwing', 'Imbalance Swing', 'above'],
    ['confluence.reversalLargeBuyPct', 'Reversal Large Buy %', 'above'],
    ['confluence.reversalLargeNetPct', 'Reversal Large Net %', 'above'],
    ['metadata.volume_ratio', 'Volume Ratio', 'above'],
    ['metadata.penetration_depth', 'Penetration Depth', 'above'],
    ['gex.gexMagnitude', 'GEX Magnitude', 'above'],
    ['lt.levelsBelow', 'LT Levels Below', 'above'],
  ];

  const thresholdResults = [];
  for (const [path, name, dir] of thresholdFeatures) {
    const result = findOptimalThreshold(enriched, path, name, dir);
    if (result && result.best) {
      thresholdResults.push(result);
      console.log(`\n  ${name} (filter: ${dir} threshold)`);
      console.log(`  Best: >= ${result.best.threshold} → n=${result.best.n}, WR=${result.best.winRate}%, AvgPnL=${result.best.avgPnL}`);
      console.log(`  ${'Pctl'.padStart(6)} ${'Threshold'.padStart(12)} ${'n'.padStart(5)} ${'WR%'.padStart(7)} ${'AvgPnL'.padStart(8)} ${'TotPnL'.padStart(8)}`);
      for (const t of result.thresholds) {
        console.log(`  ${String(t.percentile + '%').padStart(6)} ${String(t.threshold).padStart(12)} ${String(t.n).padStart(5)} ${String(t.winRate + '%').padStart(7)} ${String(t.avgPnL).padStart(8)} ${String(t.totalPnL).padStart(8)}`);
      }
    }
  }

  // ========================================================================
  // Combined Filter Analysis
  // ========================================================================

  const combinedResults = testCombinedFilters(enriched);

  // ========================================================================
  // Save Results
  // ========================================================================

  const outputDir = path.dirname(path.resolve(process.cwd(), outputPath));
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const output = {
    meta: {
      generatedAt: new Date().toISOString(),
      tradesAnalyzed: enriched.length,
      ofiWindow,
      dataAvailability: { ofi: hasOFI, gex: hasGEX, lt: hasLT }
    },
    summary: {
      totalTrades: enriched.length,
      winners: winCount,
      losers: loseCount,
      winRate: round(winCount / enriched.length * 100, 1)
    },
    numericFeatures: numericResults,
    booleanFeatures: booleanResults,
    categoricalFeatures: categoricalResults,
    thresholdAnalysis: thresholdResults,
    combinedFilters: combinedResults,
    enrichedTrades: enriched
  };

  fs.writeFileSync(
    path.resolve(process.cwd(), outputPath),
    JSON.stringify(output, null, 2)
  );
  console.log(`\n\nResults saved to ${outputPath}`);
}

main().catch(console.error);
