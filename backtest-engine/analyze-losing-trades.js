#!/usr/bin/env node

import fs from 'fs';
import path from 'path';

// Read and parse the results file
const resultsPath = '/home/drew/projects/slingshot-services/backtest-engine/results/comprehensive_analysis_2026-/gex-ldpm-confluence-conservative_results.json';
console.log('Reading results file...');
const results = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));

// Extract losing trades
console.log('Extracting losing trades...');
const losingTrades = results.trades.filter(trade => trade.grossPnL < 0);

// Analysis categories
const analysis = {
    summary: {
        totalTrades: results.trades.length,
        losingTrades: losingTrades.length,
        losingTradeRate: (losingTrades.length / results.trades.length * 100).toFixed(2),
        averageLoss: (losingTrades.reduce((sum, trade) => sum + trade.grossPnL, 0) / losingTrades.length).toFixed(2),
        totalLoss: losingTrades.reduce((sum, trade) => sum + trade.grossPnL, 0),
        largestLoss: Math.min(...losingTrades.map(trade => trade.grossPnL)),
        smallestLoss: Math.max(...losingTrades.map(trade => trade.grossPnL))
    },
    byExitReason: {},
    byRegime: {},
    byLTSentiment: {},
    byConfluenceStrength: {},
    byRiskRewardRatio: {},
    byTimeOfDay: {},
    byTradeDuration: {},
    detailedLosses: []
};

// Categorize losing trades
losingTrades.forEach(trade => {
    // Exit reason analysis
    const exitReason = trade.exitReason;
    if (!analysis.byExitReason[exitReason]) {
        analysis.byExitReason[exitReason] = { count: 0, totalLoss: 0, trades: [] };
    }
    analysis.byExitReason[exitReason].count++;
    analysis.byExitReason[exitReason].totalLoss += trade.grossPnL;
    analysis.byExitReason[exitReason].trades.push(trade.id);

    // Market regime analysis
    const regime = trade.signal?.regime || 'unknown';
    if (!analysis.byRegime[regime]) {
        analysis.byRegime[regime] = { count: 0, totalLoss: 0, trades: [] };
    }
    analysis.byRegime[regime].count++;
    analysis.byRegime[regime].totalLoss += trade.grossPnL;
    analysis.byRegime[regime].trades.push(trade.id);

    // LT sentiment analysis
    const ltSentiment = trade.signal?.availableLTLevels?.sentiment || 'unknown';
    if (!analysis.byLTSentiment[ltSentiment]) {
        analysis.byLTSentiment[ltSentiment] = { count: 0, totalLoss: 0, trades: [] };
    }
    analysis.byLTSentiment[ltSentiment].count++;
    analysis.byLTSentiment[ltSentiment].totalLoss += trade.grossPnL;
    analysis.byLTSentiment[ltSentiment].trades.push(trade.id);

    // Confluence strength analysis
    const confluenceStrength = trade.signal?.confluenceZone?.strength || 0;
    const strengthBucket = confluenceStrength <= 2 ? 'weak' : confluenceStrength <= 4 ? 'medium' : 'strong';
    if (!analysis.byConfluenceStrength[strengthBucket]) {
        analysis.byConfluenceStrength[strengthBucket] = { count: 0, totalLoss: 0, trades: [] };
    }
    analysis.byConfluenceStrength[strengthBucket].count++;
    analysis.byConfluenceStrength[strengthBucket].totalLoss += trade.grossPnL;
    analysis.byConfluenceStrength[strengthBucket].trades.push(trade.id);

    // Risk reward ratio analysis
    const rrr = trade.signal?.riskRewardRatio || 0;
    const rrrBucket = rrr < 1 ? 'poor' : rrr < 1.5 ? 'moderate' : 'good';
    if (!analysis.byRiskRewardRatio[rrrBucket]) {
        analysis.byRiskRewardRatio[rrrBucket] = { count: 0, totalLoss: 0, trades: [] };
    }
    analysis.byRiskRewardRatio[rrrBucket].count++;
    analysis.byRiskRewardRatio[rrrBucket].totalLoss += trade.grossPnL;
    analysis.byRiskRewardRatio[rrrBucket].trades.push(trade.id);

    // Time of day analysis (assuming timestamps are in UTC)
    const entryDate = new Date(trade.entryTime);
    const hour = entryDate.getUTCHours();
    let timeSlot;
    if (hour >= 0 && hour < 6) timeSlot = 'overnight';
    else if (hour >= 6 && hour < 9) timeSlot = 'premarket';
    else if (hour >= 9 && hour < 16) timeSlot = 'rth';
    else timeSlot = 'afterhours';

    if (!analysis.byTimeOfDay[timeSlot]) {
        analysis.byTimeOfDay[timeSlot] = { count: 0, totalLoss: 0, trades: [] };
    }
    analysis.byTimeOfDay[timeSlot].count++;
    analysis.byTimeOfDay[timeSlot].totalLoss += trade.grossPnL;
    analysis.byTimeOfDay[timeSlot].trades.push(trade.id);

    // Trade duration analysis
    const durationCandles = trade.candlesSinceSignal || 0;
    let durationBucket;
    if (durationCandles <= 4) durationBucket = 'very_short';
    else if (durationCandles <= 12) durationBucket = 'short';
    else if (durationCandles <= 24) durationBucket = 'medium';
    else durationBucket = 'long';

    if (!analysis.byTradeDuration[durationBucket]) {
        analysis.byTradeDuration[durationBucket] = { count: 0, totalLoss: 0, trades: [] };
    }
    analysis.byTradeDuration[durationBucket].count++;
    analysis.byTradeDuration[durationBucket].totalLoss += trade.grossPnL;
    analysis.byTradeDuration[durationBucket].trades.push(trade.id);

    // Collect detailed information for worst trades
    analysis.detailedLosses.push({
        id: trade.id,
        entryTime: new Date(trade.entryTime).toISOString(),
        exitTime: new Date(trade.exitTime).toISOString(),
        entryPrice: trade.entryPrice,
        exitPrice: trade.actualExit,
        grossPnL: trade.grossPnL,
        exitReason: trade.exitReason,
        regime: trade.signal?.regime,
        ltSentiment: trade.signal?.availableLTLevels?.sentiment,
        confluenceStrength: trade.signal?.confluenceZone?.strength,
        confluenceTypes: trade.signal?.confluenceZone?.types,
        riskRewardRatio: trade.signal?.riskRewardRatio,
        tradeDurationCandles: trade.candlesSinceSignal,
        volume: trade.signal?.volume,
        avgVolume: trade.signal?.avgVolume,
        volumeRatio: trade.signal?.volumeRatio,
        side: trade.side
    });
});

// Sort detailed losses by PnL (worst first)
analysis.detailedLosses.sort((a, b) => a.grossPnL - b.grossPnL);

// Calculate percentages for each category
Object.keys(analysis.byExitReason).forEach(key => {
    analysis.byExitReason[key].percentage = (analysis.byExitReason[key].count / losingTrades.length * 100).toFixed(2);
    analysis.byExitReason[key].avgLoss = (analysis.byExitReason[key].totalLoss / analysis.byExitReason[key].count).toFixed(2);
});

Object.keys(analysis.byRegime).forEach(key => {
    analysis.byRegime[key].percentage = (analysis.byRegime[key].count / losingTrades.length * 100).toFixed(2);
    analysis.byRegime[key].avgLoss = (analysis.byRegime[key].totalLoss / analysis.byRegime[key].count).toFixed(2);
});

Object.keys(analysis.byLTSentiment).forEach(key => {
    analysis.byLTSentiment[key].percentage = (analysis.byLTSentiment[key].count / losingTrades.length * 100).toFixed(2);
    analysis.byLTSentiment[key].avgLoss = (analysis.byLTSentiment[key].totalLoss / analysis.byLTSentiment[key].count).toFixed(2);
});

Object.keys(analysis.byConfluenceStrength).forEach(key => {
    analysis.byConfluenceStrength[key].percentage = (analysis.byConfluenceStrength[key].count / losingTrades.length * 100).toFixed(2);
    analysis.byConfluenceStrength[key].avgLoss = (analysis.byConfluenceStrength[key].totalLoss / analysis.byConfluenceStrength[key].count).toFixed(2);
});

Object.keys(analysis.byRiskRewardRatio).forEach(key => {
    analysis.byRiskRewardRatio[key].percentage = (analysis.byRiskRewardRatio[key].count / losingTrades.length * 100).toFixed(2);
    analysis.byRiskRewardRatio[key].avgLoss = (analysis.byRiskRewardRatio[key].totalLoss / analysis.byRiskRewardRatio[key].count).toFixed(2);
});

Object.keys(analysis.byTimeOfDay).forEach(key => {
    analysis.byTimeOfDay[key].percentage = (analysis.byTimeOfDay[key].count / losingTrades.length * 100).toFixed(2);
    analysis.byTimeOfDay[key].avgLoss = (analysis.byTimeOfDay[key].totalLoss / analysis.byTimeOfDay[key].count).toFixed(2);
});

Object.keys(analysis.byTradeDuration).forEach(key => {
    analysis.byTradeDuration[key].percentage = (analysis.byTradeDuration[key].count / losingTrades.length * 100).toFixed(2);
    analysis.byTradeDuration[key].avgLoss = (analysis.byTradeDuration[key].totalLoss / analysis.byTradeDuration[key].count).toFixed(2);
});

// Print summary
console.log('\n=== GEX LDPM STRATEGY - LOSING TRADES ANALYSIS ===\n');

console.log('SUMMARY STATISTICS:');
console.log(`Total Trades: ${analysis.summary.totalTrades}`);
console.log(`Losing Trades: ${analysis.summary.losingTrades}`);
console.log(`Loss Rate: ${analysis.summary.losingTradeRate}%`);
console.log(`Average Loss: $${analysis.summary.averageLoss}`);
console.log(`Total Loss: $${analysis.summary.totalLoss}`);
console.log(`Largest Loss: $${analysis.summary.largestLoss}`);
console.log(`Smallest Loss: $${analysis.summary.smallestLoss}`);

console.log('\nBY EXIT REASON:');
Object.entries(analysis.byExitReason)
    .sort((a, b) => b[1].count - a[1].count)
    .forEach(([reason, data]) => {
        console.log(`${reason}: ${data.count} trades (${data.percentage}%), avg loss: $${data.avgLoss}, total: $${data.totalLoss}`);
    });

console.log('\nBY MARKET REGIME:');
Object.entries(analysis.byRegime)
    .sort((a, b) => b[1].count - a[1].count)
    .forEach(([regime, data]) => {
        console.log(`${regime}: ${data.count} trades (${data.percentage}%), avg loss: $${data.avgLoss}, total: $${data.totalLoss}`);
    });

console.log('\nBY LT SENTIMENT:');
Object.entries(analysis.byLTSentiment)
    .sort((a, b) => b[1].count - a[1].count)
    .forEach(([sentiment, data]) => {
        console.log(`${sentiment}: ${data.count} trades (${data.percentage}%), avg loss: $${data.avgLoss}, total: $${data.totalLoss}`);
    });

console.log('\nBY CONFLUENCE STRENGTH:');
Object.entries(analysis.byConfluenceStrength)
    .sort((a, b) => b[1].count - a[1].count)
    .forEach(([strength, data]) => {
        console.log(`${strength}: ${data.count} trades (${data.percentage}%), avg loss: $${data.avgLoss}, total: $${data.totalLoss}`);
    });

console.log('\nBY RISK-REWARD RATIO:');
Object.entries(analysis.byRiskRewardRatio)
    .sort((a, b) => b[1].count - a[1].count)
    .forEach(([rrr, data]) => {
        console.log(`${rrr}: ${data.count} trades (${data.percentage}%), avg loss: $${data.avgLoss}, total: $${data.totalLoss}`);
    });

console.log('\nBY TIME OF DAY:');
Object.entries(analysis.byTimeOfDay)
    .sort((a, b) => b[1].count - a[1].count)
    .forEach(([timeSlot, data]) => {
        console.log(`${timeSlot}: ${data.count} trades (${data.percentage}%), avg loss: $${data.avgLoss}, total: $${data.totalLoss}`);
    });

console.log('\nBY TRADE DURATION:');
Object.entries(analysis.byTradeDuration)
    .sort((a, b) => b[1].count - a[1].count)
    .forEach(([duration, data]) => {
        console.log(`${duration}: ${data.count} trades (${data.percentage}%), avg loss: $${data.avgLoss}, total: $${data.totalLoss}`);
    });

console.log('\nWORST 20 TRADES:');
analysis.detailedLosses.slice(0, 20).forEach((trade, index) => {
    console.log(`${index + 1}. ${trade.id}: $${trade.grossPnL} | ${trade.exitReason} | ${trade.regime} regime | ${trade.ltSentiment} LT | Confluence: ${trade.confluenceStrength} | RRR: ${trade.riskRewardRatio?.toFixed(2)} | Duration: ${trade.tradeDurationCandles} candles`);
});

// Save detailed analysis to file
const outputPath = '/home/drew/projects/slingshot-services/backtest-engine/losing-trades-analysis.json';
fs.writeFileSync(outputPath, JSON.stringify(analysis, null, 2));
console.log(`\nDetailed analysis saved to: ${outputPath}`);