#!/usr/bin/env node
/**
 * GEX Pullback Strategy Analysis
 *
 * Analyzes backtest results to answer:
 * 1. Time from deviation signal to take_profit level hit
 * 2. Max drawdown from signal to profit target
 * 3. GEX regime impact on trade outcomes
 * 4. Which GEX levels produced best results
 */

import fs from 'fs';
import path from 'path';
import csv from 'csv-parser';

const RESULTS_FILE = './results/gex-pullback-full-backtest.json';
const GEX_DATA_DIR = './data/gex/nq';
const OHLCV_FILE = './data/ohlcv/nq/NQ_ohlcv_1m.csv';
const POINT_VALUE = 20; // NQ point value in dollars

// Load CSV using streaming parser
function loadCSV(filePath) {
    return new Promise((resolve, reject) => {
        const records = [];
        fs.createReadStream(filePath)
            .pipe(csv())
            .on('data', (row) => records.push(row))
            .on('end', () => resolve(records))
            .on('error', reject);
    });
}

/**
 * Filter candles to use only the primary (most liquid) contract for each time period
 * This handles contract rollovers by selecting the highest volume contract per hour
 */
function filterPrimaryContract(candles) {
    if (candles.length === 0) return candles;

    // Group candles by day and hour to detect contract transitions
    const contractVolumes = new Map();
    const result = [];

    // Calculate volume per contract symbol per hour
    candles.forEach(candle => {
        const hourKey = Math.floor(candle.timestamp / (60 * 60 * 1000)); // Hour buckets
        const symbol = candle.symbol;

        if (!contractVolumes.has(hourKey)) {
            contractVolumes.set(hourKey, new Map());
        }

        const hourData = contractVolumes.get(hourKey);
        const currentVol = hourData.get(symbol) || 0;
        hourData.set(symbol, currentVol + (candle.volume || 0));
    });

    // For each candle, check if it belongs to the primary contract for that time
    candles.forEach(candle => {
        const hourKey = Math.floor(candle.timestamp / (60 * 60 * 1000));
        const hourData = contractVolumes.get(hourKey);

        if (!hourData) {
            result.push(candle);
            return;
        }

        // Find the symbol with highest volume for this hour
        let primarySymbol = '';
        let maxVolume = 0;

        for (const [symbol, volume] of hourData.entries()) {
            if (volume > maxVolume) {
                maxVolume = volume;
                primarySymbol = symbol;
            }
        }

        // Only include candles from the primary contract
        if (candle.symbol === primarySymbol) {
            result.push(candle);
        }
    });

    return result;
}

// Load backtest results
console.log('Loading backtest results...');
const results = JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf-8'));
const trades = results.trades;
console.log(`Loaded ${trades.length} trades`);

// Load OHLCV data
console.log('Loading OHLCV data (this may take a moment)...');
const ohlcvRecords = await loadCSV(OHLCV_FILE);
console.log(`Loaded ${ohlcvRecords.length} raw OHLCV records`);

// Transform and filter OHLCV data (same logic as backtest engine)
console.log('Filtering calendar spreads and bad data...');
let validCandles = ohlcvRecords
    .map(record => {
        const ts = new Date(record.ts_event).getTime();
        return {
            timestamp: ts,
            symbol: record.symbol,
            open: parseFloat(record.open),
            high: parseFloat(record.high),
            low: parseFloat(record.low),
            close: parseFloat(record.close),
            volume: parseFloat(record.volume)
        };
    })
    .filter(candle => {
        // Filter out invalid timestamps
        if (isNaN(candle.timestamp)) return false;

        // Filter out calendar spreads (symbols containing '-')
        if (candle.symbol && candle.symbol.includes('-')) return false;

        // Filter out corrupted candles where all OHLC values are identical
        if (candle.open === candle.high && candle.high === candle.low && candle.low === candle.close) {
            return false;
        }

        // Filter out low volume single-tick candles (likely bad data)
        if (candle.volume <= 2 &&
            Math.abs(candle.high - candle.low) < 1 &&
            candle.open === candle.high && candle.high === candle.low && candle.low === candle.close) {
            return false;
        }

        return true;
    });

console.log(`After filtering bad data: ${validCandles.length} candles`);

// Apply primary contract filter (handles contract rollovers)
console.log('Applying primary contract filter for rollovers...');
validCandles = filterPrimaryContract(validCandles);
console.log(`After rollover filter: ${validCandles.length} candles`);

// Sort by timestamp
validCandles.sort((a, b) => a.timestamp - b.timestamp);

// Create timestamp index for fast lookup
const ohlcvByTimestamp = new Map();
validCandles.forEach(candle => {
    // Store by minute for easier lookup
    const minuteTs = Math.floor(candle.timestamp / 60000) * 60000;
    if (!ohlcvByTimestamp.has(minuteTs)) {
        ohlcvByTimestamp.set(minuteTs, candle);
    }
});
console.log(`Indexed ${ohlcvByTimestamp.size} unique minute timestamps`);

// Load GEX data for regime lookup
console.log('Loading GEX data for regime lookup...');
const gexDataByDate = new Map();
const gexFiles = fs.readdirSync(GEX_DATA_DIR).filter(f => f.endsWith('.json'));
for (const file of gexFiles) {
    const data = JSON.parse(fs.readFileSync(path.join(GEX_DATA_DIR, file), 'utf-8'));
    if (data.data) {
        for (const snapshot of data.data) {
            const ts = new Date(snapshot.timestamp).getTime();
            gexDataByDate.set(ts, snapshot);
        }
    }
}
console.log(`Loaded GEX snapshots for ${gexDataByDate.size} timestamps`);

// Helper function to find closest GEX snapshot
function findGexSnapshot(timestamp) {
    // Round to 15-minute interval
    const rounded = Math.floor(timestamp / (15 * 60 * 1000)) * (15 * 60 * 1000);

    // Try exact match first
    if (gexDataByDate.has(rounded)) {
        return gexDataByDate.get(rounded);
    }

    // Look for closest within 30 minutes
    for (let offset = 15 * 60 * 1000; offset <= 30 * 60 * 1000; offset += 15 * 60 * 1000) {
        if (gexDataByDate.has(rounded - offset)) return gexDataByDate.get(rounded - offset);
        if (gexDataByDate.has(rounded + offset)) return gexDataByDate.get(rounded + offset);
    }
    return null;
}

// Helper function to find when price reached a target level
// Now searches up to maxMinutes and handles gaps in data better
function findTimeToTarget(startTimestamp, targetPrice, side, maxMinutes = 2880) { // Default 2 days
    // Normalize to minute boundary
    let currentTs = Math.floor(startTimestamp / 60000) * 60000;
    const startTs = currentTs;
    let minPrice = Infinity;
    let maxPrice = -Infinity;
    let minutesSearched = 0;
    let candlesFound = 0;

    while (minutesSearched < maxMinutes) {
        const candle = ohlcvByTimestamp.get(currentTs);
        if (candle) {
            candlesFound++;
            minPrice = Math.min(minPrice, candle.low);
            maxPrice = Math.max(maxPrice, candle.high);

            // Check if target was hit
            if (side === 'buy' && candle.high >= targetPrice) {
                return {
                    hit: true,
                    timeMs: currentTs - startTs,
                    bars: candlesFound,
                    maxAdverse: minPrice,
                    minPrice,
                    maxPrice
                };
            }
            if (side === 'sell' && candle.low <= targetPrice) {
                return {
                    hit: true,
                    timeMs: currentTs - startTs,
                    bars: candlesFound,
                    maxAdverse: maxPrice,
                    minPrice,
                    maxPrice
                };
            }
        }

        currentTs += 60000; // 1 minute
        minutesSearched++;
    }

    return {
        hit: false,
        timeMs: null,
        bars: candlesFound,
        minutesSearched,
        minPrice: minPrice === Infinity ? null : minPrice,
        maxPrice: maxPrice === -Infinity ? null : maxPrice
    };
}

// Analyze each trade
console.log('\nAnalyzing trades...');

// Debug: check first trade timestamp matching
const firstTrade = trades[0];
console.log(`\nDebug: First trade deviation timestamp: ${firstTrade.signal?.metadata?.deviationTimestamp}`);
console.log(`Debug: First trade date: ${new Date(firstTrade.signal?.metadata?.deviationTimestamp).toISOString()}`);
console.log(`Debug: First trade target: ${firstTrade.takeProfit}, side: ${firstTrade.side}`);

// Check OHLCV data range
const ohlcvTimestamps = Array.from(ohlcvByTimestamp.keys()).sort((a, b) => a - b);
console.log(`Debug: OHLCV data range: ${new Date(ohlcvTimestamps[0]).toISOString()} to ${new Date(ohlcvTimestamps[ohlcvTimestamps.length-1]).toISOString()}`);

// Check if we can find data near the first trade
const nearbyTs = Math.floor(firstTrade.signal?.metadata?.deviationTimestamp / 60000) * 60000;
const nearbyCandle = ohlcvByTimestamp.get(nearbyTs);
console.log(`Debug: Nearby candle at ${nearbyTs}: ${nearbyCandle ? `found (high: ${nearbyCandle.high}, low: ${nearbyCandle.low})` : 'NOT FOUND'}`);

// Search around for data
let foundAt = null;
for (let offset = -300; offset <= 300; offset++) {
    const searchTs = nearbyTs + (offset * 60000);
    if (ohlcvByTimestamp.has(searchTs)) {
        foundAt = searchTs;
        break;
    }
}
console.log(`Debug: Nearest data found at: ${foundAt ? new Date(foundAt).toISOString() : 'NONE WITHIN 5 HOURS'}`);
console.log('');

const analysis = {
    timeToTarget: [],
    maxDrawdown: [],
    regimeAnalysis: {},
    levelAnalysis: {},
    overallStats: {
        totalTrades: trades.length,
        winners: 0,
        losers: 0,
        targetReached: 0,
        targetNotReached: 0
    }
};

for (const trade of trades) {
    const deviationTimestamp = trade.signal?.metadata?.deviationTimestamp || trade.timestamp;
    const entryTime = trade.entryTime;
    const targetPrice = trade.takeProfit;
    const side = trade.side;
    const entryPrice = trade.actualEntry || trade.entryPrice;
    const exitReason = trade.exitReason;
    const levelType = trade.signal?.metadata?.entryLevel?.type || 'unknown';

    // Find GEX regime at entry
    const gexSnapshot = findGexSnapshot(entryTime);
    const regime = gexSnapshot?.regime || 'unknown';

    // Find time to target from deviation signal (search up to 5 days)
    const targetResult = findTimeToTarget(deviationTimestamp, targetPrice, side, 7200);

    // Calculate max drawdown from entry until trade exit
    // We need to search from entry to exit time
    let maxDrawdownPoints = 0;
    const exitTime = trade.exitTime || entryTime + (24 * 60 * 60 * 1000); // Default 1 day if no exit
    const tradeDurationMs = exitTime - entryTime;
    const tradeDurationMinutes = Math.ceil(tradeDurationMs / 60000);

    // Search from entry to exit for max adverse excursion
    const priceExcursion = findTimeToTarget(entryTime, side === 'buy' ? -Infinity : Infinity, side, tradeDurationMinutes + 60);

    if (side === 'buy') {
        // For longs, drawdown is how far price went below entry
        if (priceExcursion.minPrice && priceExcursion.minPrice < entryPrice) {
            maxDrawdownPoints = entryPrice - priceExcursion.minPrice;
        }
    } else {
        // For shorts, drawdown is how far price went above entry
        if (priceExcursion.maxPrice && priceExcursion.maxPrice > entryPrice) {
            maxDrawdownPoints = priceExcursion.maxPrice - entryPrice;
        }
    }

    // Sanity check: cap drawdown at 500 points (unrealistic for a single trade to have more)
    // This filters out data anomalies where gaps in OHLCV data cause incorrect min/max prices
    if (maxDrawdownPoints > 500) {
        maxDrawdownPoints = 0; // Mark as invalid/unknown
    }

    // Collect results
    const tradeAnalysis = {
        id: trade.id,
        deviationTimestamp,
        entryTime,
        side,
        entryPrice,
        targetPrice,
        stopLoss: trade.stopLoss,
        exitReason,
        regime,
        levelType,
        netPnL: trade.netPnL,
        pointsPnL: trade.pointsPnL,
        targetReached: targetResult.hit,
        timeToTargetMs: targetResult.timeMs,
        timeToTargetHours: targetResult.hit ? (targetResult.timeMs / (1000 * 60 * 60)).toFixed(2) : null,
        barsToTarget: targetResult.bars,
        maxDrawdownPoints: maxDrawdownPoints.toFixed(2),
        maxDrawdownDollars: (maxDrawdownPoints * POINT_VALUE).toFixed(2)
    };

    analysis.timeToTarget.push(tradeAnalysis);

    // Update stats
    if (trade.netPnL > 0) analysis.overallStats.winners++;
    else analysis.overallStats.losers++;

    if (targetResult.hit) analysis.overallStats.targetReached++;
    else analysis.overallStats.targetNotReached++;

    // Regime analysis
    if (!analysis.regimeAnalysis[regime]) {
        analysis.regimeAnalysis[regime] = {
            trades: 0,
            winners: 0,
            losers: 0,
            totalPnL: 0,
            avgPnL: 0,
            targetReached: 0,
            avgTimeToTarget: 0,
            avgDrawdown: 0,
            bySide: { buy: { trades: 0, winners: 0, totalPnL: 0 }, sell: { trades: 0, winners: 0, totalPnL: 0 } }
        };
    }
    const ra = analysis.regimeAnalysis[regime];
    ra.trades++;
    if (trade.netPnL > 0) ra.winners++;
    else ra.losers++;
    ra.totalPnL += trade.netPnL;
    if (targetResult.hit) {
        ra.targetReached++;
        ra.avgTimeToTarget += targetResult.timeMs / (1000 * 60 * 60);
    }
    ra.avgDrawdown += maxDrawdownPoints;
    ra.bySide[side].trades++;
    if (trade.netPnL > 0) ra.bySide[side].winners++;
    ra.bySide[side].totalPnL += trade.netPnL;

    // Level analysis
    if (!analysis.levelAnalysis[levelType]) {
        analysis.levelAnalysis[levelType] = {
            trades: 0,
            winners: 0,
            losers: 0,
            totalPnL: 0,
            avgPnL: 0,
            targetReached: 0,
            avgTimeToTarget: 0,
            avgDrawdown: 0
        };
    }
    const la = analysis.levelAnalysis[levelType];
    la.trades++;
    if (trade.netPnL > 0) la.winners++;
    else la.losers++;
    la.totalPnL += trade.netPnL;
    if (targetResult.hit) {
        la.targetReached++;
        la.avgTimeToTarget += targetResult.timeMs / (1000 * 60 * 60);
    }
    la.avgDrawdown += maxDrawdownPoints;
}

// Calculate averages
for (const regime in analysis.regimeAnalysis) {
    const ra = analysis.regimeAnalysis[regime];
    ra.avgPnL = ra.totalPnL / ra.trades;
    ra.winRate = ((ra.winners / ra.trades) * 100).toFixed(1) + '%';
    ra.targetHitRate = ((ra.targetReached / ra.trades) * 100).toFixed(1) + '%';
    if (ra.targetReached > 0) {
        ra.avgTimeToTarget = (ra.avgTimeToTarget / ra.targetReached).toFixed(2);
    } else {
        ra.avgTimeToTarget = 'N/A';
    }
    ra.avgDrawdown = (ra.avgDrawdown / ra.trades).toFixed(2);

    // Calculate side-specific win rates
    for (const side of ['buy', 'sell']) {
        if (ra.bySide[side].trades > 0) {
            ra.bySide[side].winRate = ((ra.bySide[side].winners / ra.bySide[side].trades) * 100).toFixed(1) + '%';
            ra.bySide[side].avgPnL = (ra.bySide[side].totalPnL / ra.bySide[side].trades).toFixed(2);
        }
    }
}

for (const level in analysis.levelAnalysis) {
    const la = analysis.levelAnalysis[level];
    la.avgPnL = la.totalPnL / la.trades;
    la.winRate = ((la.winners / la.trades) * 100).toFixed(1) + '%';
    la.targetHitRate = ((la.targetReached / la.trades) * 100).toFixed(1) + '%';
    if (la.targetReached > 0) {
        la.avgTimeToTarget = (la.avgTimeToTarget / la.targetReached).toFixed(2);
    } else {
        la.avgTimeToTarget = 'N/A';
    }
    la.avgDrawdown = (la.avgDrawdown / la.trades).toFixed(2);
}

// Print Results
console.log('═══════════════════════════════════════════════════════════════════════════════');
console.log('                    GEX PULLBACK STRATEGY ANALYSIS');
console.log('═══════════════════════════════════════════════════════════════════════════════\n');

console.log('OVERALL STATISTICS');
console.log('─────────────────────────────────────────────────────────────────────────────');
console.log(`Total Trades:           ${analysis.overallStats.totalTrades}`);
console.log(`Winners:                ${analysis.overallStats.winners} (${((analysis.overallStats.winners/analysis.overallStats.totalTrades)*100).toFixed(1)}%)`);
console.log(`Losers:                 ${analysis.overallStats.losers}`);
console.log(`Target Reached:         ${analysis.overallStats.targetReached} (${((analysis.overallStats.targetReached/analysis.overallStats.totalTrades)*100).toFixed(1)}%)`);
console.log(`Target Not Reached:     ${analysis.overallStats.targetNotReached}`);

// Time to target statistics
const targetHits = analysis.timeToTarget.filter(t => t.targetReached);
if (targetHits.length > 0) {
    const avgTimeHours = targetHits.reduce((sum, t) => sum + parseFloat(t.timeToTargetHours), 0) / targetHits.length;
    const medianTimeHours = targetHits.map(t => parseFloat(t.timeToTargetHours)).sort((a, b) => a - b)[Math.floor(targetHits.length / 2)];
    const minTimeHours = Math.min(...targetHits.map(t => parseFloat(t.timeToTargetHours)));
    const maxTimeHours = Math.max(...targetHits.map(t => parseFloat(t.timeToTargetHours)));

    console.log('\n\nQUESTION 1: TIME FROM DEVIATION SIGNAL TO TAKE_PROFIT');
    console.log('─────────────────────────────────────────────────────────────────────────────');
    console.log(`Signals that reached target: ${targetHits.length} / ${analysis.overallStats.totalTrades} (${((targetHits.length/analysis.overallStats.totalTrades)*100).toFixed(1)}%)`);
    console.log(`Average time to target:      ${avgTimeHours.toFixed(2)} hours`);
    console.log(`Median time to target:       ${medianTimeHours.toFixed(2)} hours`);
    console.log(`Fastest:                     ${minTimeHours.toFixed(2)} hours`);
    console.log(`Slowest:                     ${maxTimeHours.toFixed(2)} hours`);

    // Distribution buckets
    const buckets = { '<1h': 0, '1-4h': 0, '4-8h': 0, '8-24h': 0, '1-3d': 0, '>3d': 0 };
    for (const t of targetHits) {
        const hours = parseFloat(t.timeToTargetHours);
        if (hours < 1) buckets['<1h']++;
        else if (hours < 4) buckets['1-4h']++;
        else if (hours < 8) buckets['4-8h']++;
        else if (hours < 24) buckets['8-24h']++;
        else if (hours < 72) buckets['1-3d']++;
        else buckets['>3d']++;
    }
    console.log('\nTime Distribution:');
    for (const [bucket, count] of Object.entries(buckets)) {
        const pct = ((count / targetHits.length) * 100).toFixed(1);
        const bar = '█'.repeat(Math.round(pct / 2));
        console.log(`  ${bucket.padEnd(8)} ${count.toString().padStart(4)} (${pct.padStart(5)}%) ${bar}`);
    }
}

// Max drawdown statistics
console.log('\n\nQUESTION 2: MAX DRAWDOWN FROM SIGNAL TO PROFIT TARGET');
console.log('─────────────────────────────────────────────────────────────────────────────');
const drawdowns = analysis.timeToTarget.map(t => parseFloat(t.maxDrawdownPoints)).filter(d => d > 0);
if (drawdowns.length > 0) {
    const avgDrawdown = drawdowns.reduce((sum, d) => sum + d, 0) / drawdowns.length;
    const medianDrawdown = drawdowns.sort((a, b) => a - b)[Math.floor(drawdowns.length / 2)];
    const maxDrawdown = Math.max(...drawdowns);
    const percentile90 = drawdowns.sort((a, b) => a - b)[Math.floor(drawdowns.length * 0.9)];

    console.log(`Average Max Drawdown:        ${avgDrawdown.toFixed(2)} points ($${(avgDrawdown * POINT_VALUE).toFixed(0)})`);
    console.log(`Median Max Drawdown:         ${medianDrawdown.toFixed(2)} points ($${(medianDrawdown * POINT_VALUE).toFixed(0)})`);
    console.log(`90th Percentile Drawdown:    ${percentile90.toFixed(2)} points ($${(percentile90 * POINT_VALUE).toFixed(0)})`);
    console.log(`Maximum Drawdown:            ${maxDrawdown.toFixed(2)} points ($${(maxDrawdown * POINT_VALUE).toFixed(0)})`);

    // Drawdown distribution
    const ddBuckets = { '0-10': 0, '10-25': 0, '25-50': 0, '50-100': 0, '>100': 0 };
    for (const dd of drawdowns) {
        if (dd < 10) ddBuckets['0-10']++;
        else if (dd < 25) ddBuckets['10-25']++;
        else if (dd < 50) ddBuckets['25-50']++;
        else if (dd < 100) ddBuckets['50-100']++;
        else ddBuckets['>100']++;
    }
    console.log('\nDrawdown Distribution (points):');
    for (const [bucket, count] of Object.entries(ddBuckets)) {
        const pct = ((count / drawdowns.length) * 100).toFixed(1);
        const bar = '█'.repeat(Math.round(pct / 2));
        console.log(`  ${bucket.padEnd(8)} ${count.toString().padStart(4)} (${pct.padStart(5)}%) ${bar}`);
    }
}

console.log('\n\nQUESTION 3: GEX REGIME IMPACT ON TRADE OUTCOMES');
console.log('─────────────────────────────────────────────────────────────────────────────');
console.log('Regime             | Trades | Win Rate | Avg PnL  | Target Hit | Avg Time | Avg DD');
console.log('-------------------|--------|----------|----------|------------|----------|--------');
const regimeOrder = ['strong_positive', 'positive', 'neutral', 'negative', 'strong_negative', 'unknown'];
for (const regime of regimeOrder) {
    const ra = analysis.regimeAnalysis[regime];
    if (ra) {
        console.log(`${regime.padEnd(18)} | ${ra.trades.toString().padStart(6)} | ${ra.winRate.padStart(8)} | $${ra.avgPnL.toFixed(0).padStart(6)} | ${ra.targetHitRate.padStart(10)} | ${ra.avgTimeToTarget.padStart(6)}h | ${ra.avgDrawdown.padStart(5)}pt`);
    }
}

// Side-specific regime analysis
console.log('\n\nRegime Performance by Trade Direction:');
console.log('─────────────────────────────────────────────────────────────────────────────');
for (const regime of regimeOrder) {
    const ra = analysis.regimeAnalysis[regime];
    if (ra) {
        console.log(`\n${regime}:`);
        for (const side of ['buy', 'sell']) {
            if (ra.bySide[side].trades > 0) {
                console.log(`  ${side.toUpperCase().padEnd(5)}: ${ra.bySide[side].trades} trades, ${ra.bySide[side].winRate} win rate, $${ra.bySide[side].avgPnL} avg PnL`);
            }
        }
    }
}

console.log('\n\nQUESTION 4: GEX LEVEL PERFORMANCE');
console.log('─────────────────────────────────────────────────────────────────────────────');
console.log('Level Type         | Trades | Win Rate | Avg PnL  | Target Hit | Avg Time | Avg DD');
console.log('-------------------|--------|----------|----------|------------|----------|--------');
const sortedLevels = Object.entries(analysis.levelAnalysis).sort((a, b) => b[1].avgPnL - a[1].avgPnL);
for (const [level, la] of sortedLevels) {
    console.log(`${level.padEnd(18)} | ${la.trades.toString().padStart(6)} | ${la.winRate.padStart(8)} | $${la.avgPnL.toFixed(0).padStart(6)} | ${la.targetHitRate.padStart(10)} | ${la.avgTimeToTarget.padStart(6)}h | ${la.avgDrawdown.padStart(5)}pt`);
}

// Key insights
console.log('\n\n═══════════════════════════════════════════════════════════════════════════════');
console.log('                           KEY INSIGHTS');
console.log('═══════════════════════════════════════════════════════════════════════════════\n');

// Best and worst regimes
const sortedRegimes = Object.entries(analysis.regimeAnalysis).sort((a, b) => b[1].avgPnL - a[1].avgPnL);
if (sortedRegimes.length > 0) {
    console.log(`Best regime:  ${sortedRegimes[0][0]} ($${sortedRegimes[0][1].avgPnL.toFixed(0)} avg PnL, ${sortedRegimes[0][1].winRate} win rate)`);
    console.log(`Worst regime: ${sortedRegimes[sortedRegimes.length-1][0]} ($${sortedRegimes[sortedRegimes.length-1][1].avgPnL.toFixed(0)} avg PnL, ${sortedRegimes[sortedRegimes.length-1][1].winRate} win rate)`);
}

// Best and worst levels
if (sortedLevels.length > 0) {
    console.log(`\nBest level:   ${sortedLevels[0][0]} ($${sortedLevels[0][1].avgPnL.toFixed(0)} avg PnL, ${sortedLevels[0][1].winRate} win rate)`);
    console.log(`Worst level:  ${sortedLevels[sortedLevels.length-1][0]} ($${sortedLevels[sortedLevels.length-1][1].avgPnL.toFixed(0)} avg PnL, ${sortedLevels[sortedLevels.length-1][1].winRate} win rate)`);
}

// Regime-direction recommendations
console.log('\n\nREGIME-DIRECTION RECOMMENDATIONS:');
console.log('─────────────────────────────────────────────────────────────────────────────');
for (const regime of regimeOrder) {
    const ra = analysis.regimeAnalysis[regime];
    if (ra && ra.bySide) {
        const buyPnL = parseFloat(ra.bySide.buy.avgPnL) || 0;
        const sellPnL = parseFloat(ra.bySide.sell.avgPnL) || 0;
        const buyTrades = ra.bySide.buy.trades || 0;
        const sellTrades = ra.bySide.sell.trades || 0;

        if (buyTrades >= 5 || sellTrades >= 5) {
            let recommendation = '';
            if (buyPnL > 0 && sellPnL > 0) {
                recommendation = 'Both directions profitable';
            } else if (buyPnL > 0 && sellPnL <= 0) {
                recommendation = 'FAVOR LONGS, avoid shorts';
            } else if (sellPnL > 0 && buyPnL <= 0) {
                recommendation = 'FAVOR SHORTS, avoid longs';
            } else {
                recommendation = 'Both directions unprofitable - BE CAUTIOUS';
            }
            console.log(`${regime.padEnd(18)}: ${recommendation}`);
        }
    }
}

// Save detailed results
const outputFile = './results/pullback-signal-analysis.json';
fs.writeFileSync(outputFile, JSON.stringify(analysis, null, 2));
console.log(`\n\nDetailed analysis saved to: ${outputFile}`);
