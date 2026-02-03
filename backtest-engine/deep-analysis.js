#!/usr/bin/env node

import fs from 'fs';

// Read the analysis results
const analysisPath = '/home/drew/projects/slingshot-services/backtest-engine/losing-trades-analysis.json';
const analysis = JSON.parse(fs.readFileSync(analysisPath, 'utf8'));

console.log('=== DEEP ANALYSIS OF LOSING TRADES ===\n');

// Key insights from the basic analysis
console.log('KEY FINDINGS:');
console.log(`• 1,144 losing trades out of 1,962 total trades (58.31% loss rate)`);
console.log(`• Average loss: $${analysis.summary.averageLoss}`);
console.log(`• Total losses: $${analysis.summary.totalLoss.toLocaleString()}`);
console.log(`• 90.82% of losses are stop-loss exits (1,039 trades)`);
console.log(`• Only 9.18% are market close exits (105 trades)`);
console.log(`• 85.05% of losing trades have weak confluence (973 trades)`);
console.log(`• 64.34% of losses occur in positive regimes (736 trades)`);

console.log('\n=== CRITICAL PATTERNS IDENTIFIED ===\n');

// Pattern 1: Stop Loss Dominance
console.log('1. STOP LOSS DOMINANCE:');
console.log(`   • 90.82% of all losses are from stop-loss hits`);
console.log(`   • Stop losses average $${analysis.byExitReason.stop_loss.avgLoss} vs market close $${analysis.byExitReason.market_close.avgLoss}`);
console.log(`   • This suggests the 40-point stop loss may be too tight for many market conditions`);

// Pattern 2: Confluence Quality Issues
console.log('\n2. CONFLUENCE QUALITY ISSUES:');
const weakConfluence = analysis.byConfluenceStrength.weak;
const mediumConfluence = analysis.byConfluenceStrength.medium;
const strongConfluence = analysis.byConfluenceStrength.strong;

console.log(`   • Weak confluence (≤2): ${weakConfluence.count} trades (${weakConfluence.percentage}%) - avg loss: $${weakConfluence.avgLoss}`);
console.log(`   • Medium confluence (3-4): ${mediumConfluence.count} trades (${mediumConfluence.percentage}%) - avg loss: $${mediumConfluence.avgLoss}`);
console.log(`   • Strong confluence (≥5): ${strongConfluence.count} trades (${strongConfluence.percentage}%) - avg loss: $${strongConfluence.avgLoss}`);
console.log(`   • 85% of losses have weak confluence - strategy should require higher confluence threshold`);

// Pattern 3: Regime Performance
console.log('\n3. REGIME-BASED PERFORMANCE:');
const positiveRegime = analysis.byRegime.positive;
const negativeRegime = analysis.byRegime.negative;

console.log(`   • Positive regime: ${positiveRegime.count} losses (${positiveRegime.percentage}%) - avg loss: $${positiveRegime.avgLoss}`);
console.log(`   • Negative regime: ${negativeRegime.count} losses (${negativeRegime.percentage}%) - avg loss: $${negativeRegime.avgLoss}`);
console.log(`   • Negative regime has worse average losses despite fewer trades`);

// Pattern 4: Time-Based Patterns
console.log('\n4. TIME-BASED PERFORMANCE:');
Object.entries(analysis.byTimeOfDay)
    .sort((a, b) => parseFloat(a[1].avgLoss) - parseFloat(b[1].avgLoss))
    .forEach(([timeSlot, data]) => {
        console.log(`   • ${timeSlot}: ${data.count} trades (${data.percentage}%) - avg loss: $${data.avgLoss}`);
    });
console.log(`   • Overnight and premarket sessions have the worst average losses`);

// Pattern 5: Duration Analysis
console.log('\n5. TRADE DURATION PATTERNS:');
Object.entries(analysis.byTradeDuration)
    .sort((a, b) => parseFloat(a[1].avgLoss) - parseFloat(b[1].avgLoss))
    .forEach(([duration, data]) => {
        console.log(`   • ${duration}: ${data.count} trades (${data.percentage}%) - avg loss: $${data.avgLoss}`);
    });
console.log(`   • Medium duration trades have worst losses, very short trades perform better`);

// Pattern 6: LT Sentiment Analysis
console.log('\n6. LT SENTIMENT ANALYSIS:');
Object.entries(analysis.byLTSentiment)
    .sort((a, b) => parseFloat(a[1].avgLoss) - parseFloat(b[1].avgLoss))
    .forEach(([sentiment, data]) => {
        console.log(`   • ${sentiment}: ${data.count} trades (${data.percentage}%) - avg loss: $${data.avgLoss}`);
    });

console.log('\n=== ACTIONABLE RECOMMENDATIONS ===\n');

console.log('IMMEDIATE OPTIMIZATIONS:');
console.log('1. INCREASE CONFLUENCE THRESHOLD:');
console.log(`   • Current: 85% of losses have weak confluence (≤2 strength)`);
console.log(`   • Recommendation: Require minimum confluence strength of 3-4`);
console.log(`   • Potential impact: Could eliminate ${weakConfluence.count} losing trades ($${Math.abs(weakConfluence.totalLoss).toLocaleString()} in losses)`);

console.log('\n2. ADJUST STOP LOSS STRATEGY:');
console.log(`   • Current: 40-point fixed stop loss causing 90.82% of losses`);
console.log(`   • Recommendation: Consider dynamic stop based on market volatility/regime`);
console.log(`   • Alternative: Implement time-based stops for different market sessions`);

console.log('\n3. SESSION-SPECIFIC RULES:');
console.log(`   • Avoid or reduce size during overnight sessions (${analysis.byTimeOfDay.overnight.percentage}% of losses, $${analysis.byTimeOfDay.overnight.avgLoss} avg)`);
console.log(`   • Avoid or reduce size during premarket (${analysis.byTimeOfDay.premarket.percentage}% of losses, $${analysis.byTimeOfDay.premarket.avgLoss} avg)`);
console.log(`   • Focus on RTH and afterhours sessions where losses are smaller`);

console.log('\n4. REGIME-BASED ADJUSTMENTS:');
console.log(`   • Negative regime shows worse performance: ${negativeRegime.avgLoss} vs ${positiveRegime.avgLoss}`);
console.log(`   • Recommendation: Skip trades in negative regimes or use tighter stops`);

console.log('\n5. RISK-REWARD OPTIMIZATION:');
const poorRRR = analysis.byRiskRewardRatio.poor;
console.log(`   • ${poorRRR.count} trades (${poorRRR.percentage}%) have poor risk-reward ratios`);
console.log(`   • Recommendation: Require minimum 1.5:1 risk-reward ratio`);

console.log('\nPOTENTIAL IMPACT CALCULATION:');
console.log('If implementing confluence threshold ≥3:');
const potentialSavings = Math.abs(weakConfluence.totalLoss);
const remainingLosses = Math.abs(mediumConfluence.totalLoss + strongConfluence.totalLoss);
console.log(`• Potential loss reduction: $${potentialSavings.toLocaleString()}`);
console.log(`• Remaining losses: $${remainingLosses.toLocaleString()}`);
console.log(`• Loss reduction: ${((potentialSavings / Math.abs(analysis.summary.totalLoss)) * 100).toFixed(1)}%`);

// Correlation analysis
console.log('\n=== CORRELATION INSIGHTS ===\n');

// Analyze worst trades for patterns
const worstTrades = analysis.detailedLosses.slice(0, 50); // Top 50 worst trades
const worstTradePatterns = {
    regimes: {},
    confluenceStrengths: {},
    ltSentiments: {},
    exitReasons: {},
    durations: {}
};

worstTrades.forEach(trade => {
    worstTradePatterns.regimes[trade.regime] = (worstTradePatterns.regimes[trade.regime] || 0) + 1;
    const confStrength = trade.confluenceStrength <= 2 ? 'weak' : trade.confluenceStrength <= 4 ? 'medium' : 'strong';
    worstTradePatterns.confluenceStrengths[confStrength] = (worstTradePatterns.confluenceStrengths[confStrength] || 0) + 1;
    worstTradePatterns.ltSentiments[trade.ltSentiment] = (worstTradePatterns.ltSentiments[trade.ltSentiment] || 0) + 1;
    worstTradePatterns.exitReasons[trade.exitReason] = (worstTradePatterns.exitReasons[trade.exitReason] || 0) + 1;

    const duration = trade.tradeDurationCandles <= 4 ? 'very_short' :
                    trade.tradeDurationCandles <= 12 ? 'short' :
                    trade.tradeDurationCandles <= 24 ? 'medium' : 'long';
    worstTradePatterns.durations[duration] = (worstTradePatterns.durations[duration] || 0) + 1;
});

console.log('WORST 50 TRADES ANALYSIS:');
console.log('Regime distribution:', worstTradePatterns.regimes);
console.log('Confluence distribution:', worstTradePatterns.confluenceStrengths);
console.log('LT sentiment distribution:', worstTradePatterns.ltSentiments);
console.log('Exit reason distribution:', worstTradePatterns.exitReasons);
console.log('Duration distribution:', worstTradePatterns.durations);

console.log('\n=== SUMMARY ===');
console.log('The strategy suffers from:');
console.log('• Over-reliance on weak confluence signals (85% of losses)');
console.log('• Aggressive stop losses causing premature exits (90.82% of losses)');
console.log('• Poor performance in overnight/premarket sessions');
console.log('• Suboptimal performance in negative market regimes');
console.log('\nPriority fixes: 1) Increase confluence threshold, 2) Adjust stop strategy, 3) Add session filters');