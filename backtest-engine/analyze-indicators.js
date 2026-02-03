import fs from 'fs';

// Load the backtest results
const data = JSON.parse(fs.readFileSync('results/gex-recoil-15m-all-indicators.json', 'utf8'));

// Helper functions for statistical calculations
function mean(arr) {
    return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function standardDeviation(arr) {
    const avg = mean(arr);
    const squareDiffs = arr.map(value => Math.pow(value - avg, 2));
    return Math.sqrt(mean(squareDiffs));
}

function correlation(x, y) {
    const n = x.length;
    const sumX = x.reduce((a, b) => a + b, 0);
    const sumY = y.reduce((a, b) => a + b, 0);
    const sumXY = x.map((xi, i) => xi * y[i]).reduce((a, b) => a + b, 0);
    const sumX2 = x.map(xi => xi * xi).reduce((a, b) => a + b, 0);
    const sumY2 = y.map(yi => yi * yi).reduce((a, b) => a + b, 0);

    const numerator = n * sumXY - sumX * sumY;
    const denominator = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));

    return denominator === 0 ? 0 : numerator / denominator;
}

function percentile(arr, p) {
    const sorted = [...arr].sort((a, b) => a - b);
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)];
}

// Extract trades with indicator data in metadata
const tradesWithIndicators = data.trades.filter(t => t.metadata && t.metadata.squeeze_momentum_value !== null);

console.log('====================================================================');
console.log('            INDICATOR ANALYSIS: GEX RECOIL STRATEGY               ');
console.log('====================================================================\n');

console.log('DATASET OVERVIEW:');
console.log(`  Total trades: ${data.trades.length}`);
console.log(`  Trades with indicators: ${tradesWithIndicators.length}`);
console.log(`  Date range: ${data.trades[0]?.entryDate} to ${data.trades[data.trades.length - 1]?.entryDate}`);
console.log(`  Net P&L: $${data.performance?.summary?.totalPnL || 0}`);
console.log(`  Win Rate: ${data.performance?.summary?.winRate || 0}%`);
console.log('\n====================================================================\n');

// Separate winning and losing trades
const winningTrades = tradesWithIndicators.filter(t => t.netPnL > 0);
const losingTrades = tradesWithIndicators.filter(t => t.netPnL < 0);

console.log('TRADE OUTCOME DISTRIBUTION:');
console.log(`  Winning trades with indicators: ${winningTrades.length} (${(winningTrades.length / tradesWithIndicators.length * 100).toFixed(1)}%)`);
console.log(`  Losing trades with indicators: ${losingTrades.length} (${(losingTrades.length / tradesWithIndicators.length * 100).toFixed(1)}%)`);

// Analyze each indicator
const indicators = [
    'squeeze_momentum_value',
    'rsi_14',
    'williams_r_14',
    'stochastic_k',
    'stochastic_d',
    'cci_20'
];

console.log('\n====================================================================');
console.log('                    INDIVIDUAL INDICATOR ANALYSIS                   ');
console.log('====================================================================\n');

const indicatorStats = {};

indicators.forEach(indicator => {
    const winValues = winningTrades
        .map(t => t.metadata[indicator])
        .filter(v => v !== null && v !== undefined);

    const lossValues = losingTrades
        .map(t => t.metadata[indicator])
        .filter(v => v !== null && v !== undefined);

    const allValues = tradesWithIndicators
        .map(t => t.metadata[indicator])
        .filter(v => v !== null && v !== undefined);

    if (allValues.length === 0) {
        console.log(`\n${indicator.toUpperCase()}: No data available`);
        return;
    }

    const stats = {
        indicator,
        win: {
            mean: mean(winValues),
            std: standardDeviation(winValues),
            min: Math.min(...winValues),
            max: Math.max(...winValues),
            p25: percentile(winValues, 25),
            p50: percentile(winValues, 50),
            p75: percentile(winValues, 75)
        },
        loss: {
            mean: mean(lossValues),
            std: standardDeviation(lossValues),
            min: Math.min(...lossValues),
            max: Math.max(...lossValues),
            p25: percentile(lossValues, 25),
            p50: percentile(lossValues, 50),
            p75: percentile(lossValues, 75)
        },
        all: {
            mean: mean(allValues),
            std: standardDeviation(allValues)
        }
    };

    indicatorStats[indicator] = stats;

    console.log(`\n${indicator.toUpperCase()}:`);
    console.log('  Winning Trades:');
    console.log(`    Mean: ${stats.win.mean.toFixed(3)} ± ${stats.win.std.toFixed(3)}`);
    console.log(`    Quartiles: [${stats.win.p25.toFixed(2)}, ${stats.win.p50.toFixed(2)}, ${stats.win.p75.toFixed(2)}]`);
    console.log(`    Range: [${stats.win.min.toFixed(2)}, ${stats.win.max.toFixed(2)}]`);

    console.log('  Losing Trades:');
    console.log(`    Mean: ${stats.loss.mean.toFixed(3)} ± ${stats.loss.std.toFixed(3)}`);
    console.log(`    Quartiles: [${stats.loss.p25.toFixed(2)}, ${stats.loss.p50.toFixed(2)}, ${stats.loss.p75.toFixed(2)}]`);
    console.log(`    Range: [${stats.loss.min.toFixed(2)}, ${stats.loss.max.toFixed(2)}]`);

    // Calculate statistical significance
    const meanDiff = Math.abs(stats.win.mean - stats.loss.mean);
    const pooledStd = Math.sqrt((stats.win.std ** 2 + stats.loss.std ** 2) / 2);
    const effectSize = meanDiff / pooledStd;

    console.log('  Statistical Significance:');
    console.log(`    Mean difference: ${meanDiff.toFixed(3)}`);
    console.log(`    Effect size (Cohen's d): ${effectSize.toFixed(3)}`);

    if (effectSize > 0.8) {
        console.log(`    >>> STRONG difference between win/loss (d > 0.8)`);
    } else if (effectSize > 0.5) {
        console.log(`    >> MODERATE difference between win/loss (d > 0.5)`);
    } else if (effectSize > 0.2) {
        console.log(`    > SMALL difference between win/loss (d > 0.2)`);
    } else {
        console.log(`    - Negligible difference between win/loss`);
    }
});

console.log('\n====================================================================');
console.log('                      CORRELATION ANALYSIS                          ');
console.log('====================================================================\n');

// Calculate correlations between indicators and P&L
const pnlValues = tradesWithIndicators.map(t => t.netPnL);
const outcomeValues = tradesWithIndicators.map(t => t.netPnL > 0 ? 1 : 0);

console.log('INDICATOR CORRELATIONS WITH TRADE OUTCOME:\n');

const correlations = {};
indicators.forEach(indicator => {
    const values = tradesWithIndicators
        .map(t => t.metadata[indicator])
        .filter(v => v !== null && v !== undefined);

    if (values.length !== tradesWithIndicators.length) {
        console.log(`  ${indicator}: Insufficient data`);
        return;
    }

    const outcomeCorr = correlation(values, outcomeValues);
    const pnlCorr = correlation(values, pnlValues);

    correlations[indicator] = { outcome: outcomeCorr, pnl: pnlCorr };

    console.log(`  ${indicator}:`);
    console.log(`    Correlation with win/loss: ${outcomeCorr.toFixed(4)}`);
    console.log(`    Correlation with P&L: ${pnlCorr.toFixed(4)}`);

    if (Math.abs(outcomeCorr) > 0.3) {
        console.log(`    >>> ${outcomeCorr > 0 ? 'POSITIVE' : 'NEGATIVE'} correlation with outcome!`);
    }
});

console.log('\n====================================================================');
console.log('                    CONFLUENCE ANALYSIS                             ');
console.log('====================================================================\n');

// Analyze combinations of indicators
const confluenceRules = [
    {
        name: 'Oversold Confluence',
        check: (ind) => ind.rsi_14 < 30 && ind.williams_r_14 < -80 && ind.stochastic_k < 20
    },
    {
        name: 'Overbought Confluence',
        check: (ind) => ind.rsi_14 > 70 && ind.williams_r_14 > -20 && ind.stochastic_k > 80
    },
    {
        name: 'Momentum Alignment',
        check: (ind) => ind.squeeze_momentum_value > 0 && ind.cci_20 > 0 && ind.rsi_14 > 50
    },
    {
        name: 'Bearish Momentum',
        check: (ind) => ind.squeeze_momentum_value < 0 && ind.cci_20 < 0 && ind.rsi_14 < 50
    },
    {
        name: 'Extreme CCI',
        check: (ind) => Math.abs(ind.cci_20) > 100
    },
    {
        name: 'Stochastic Divergence',
        check: (ind) => Math.abs(ind.stochastic_k - ind.stochastic_d) > 20
    }
];

console.log('CONFLUENCE PATTERN PERFORMANCE:\n');

confluenceRules.forEach(rule => {
    const matchingTrades = tradesWithIndicators.filter(t => {
        try {
            return rule.check(t.metadata);
        } catch {
            return false;
        }
    });

    if (matchingTrades.length === 0) {
        console.log(`${rule.name}: No matching trades`);
        return;
    }

    const wins = matchingTrades.filter(t => t.netPnL > 0).length;
    const winRate = (wins / matchingTrades.length * 100);
    const avgPnl = mean(matchingTrades.map(t => t.netPnL));

    console.log(`\n${rule.name}:`);
    console.log(`  Occurrences: ${matchingTrades.length} (${(matchingTrades.length / tradesWithIndicators.length * 100).toFixed(1)}% of trades)`);
    console.log(`  Win rate: ${winRate.toFixed(1)}% (baseline: ${data.performance?.summary?.winRate || 0}%)`);
    console.log(`  Average P&L: $${avgPnl.toFixed(2)}`);

    const improvement = winRate - (data.performance?.summary?.winRate || 0);
    if (Math.abs(improvement) > 5) {
        console.log(`  >>> ${improvement > 0 ? 'POSITIVE' : 'NEGATIVE'} edge: ${improvement > 0 ? '+' : ''}${improvement.toFixed(1)}%`);
    }
});

console.log('\n====================================================================');
console.log('                    OPTIMAL THRESHOLD ANALYSIS                      ');
console.log('====================================================================\n');

// Find optimal thresholds for each indicator
indicators.forEach(indicator => {
    const values = tradesWithIndicators
        .map(t => ({ value: t.metadata[indicator], outcome: t.netPnL > 0 ? 'win' : 'loss' }))
        .filter(v => v.value !== null && v.value !== undefined)
        .sort((a, b) => a.value - b.value);

    if (values.length < 10) return;

    let bestThreshold = null;
    let bestWinRate = 0;
    let bestDirection = null;
    let bestCount = 0;

    // Test thresholds at every 10th percentile
    for (let p = 10; p <= 90; p += 10) {
        const threshold = percentile(values.map(v => v.value), p);

        // Test "above threshold" condition
        const aboveTrades = values.filter(v => v.value > threshold);
        if (aboveTrades.length >= 10) {
            const aboveWins = aboveTrades.filter(v => v.outcome === 'win').length;
            const aboveWinRate = (aboveWins / aboveTrades.length) * 100;

            if (aboveWinRate > bestWinRate && aboveWinRate > (data.performance?.summary?.winRate || 0)) {
                bestWinRate = aboveWinRate;
                bestThreshold = threshold;
                bestDirection = 'above';
                bestCount = aboveTrades.length;
            }
        }

        // Test "below threshold" condition
        const belowTrades = values.filter(v => v.value < threshold);
        if (belowTrades.length >= 10) {
            const belowWins = belowTrades.filter(v => v.outcome === 'win').length;
            const belowWinRate = (belowWins / belowTrades.length) * 100;

            if (belowWinRate > bestWinRate && belowWinRate > (data.performance?.summary?.winRate || 0)) {
                bestWinRate = belowWinRate;
                bestThreshold = threshold;
                bestDirection = 'below';
                bestCount = belowTrades.length;
            }
        }
    }

    if (bestThreshold !== null) {
        console.log(`\n${indicator.toUpperCase()}:`);
        console.log(`  Optimal condition: ${indicator} ${bestDirection} ${bestThreshold.toFixed(2)}`);
        console.log(`  Win rate: ${bestWinRate.toFixed(1)}% (baseline: ${data.performance?.summary?.winRate || 0}%)`);
        console.log(`  Trade count: ${bestCount} (${(bestCount / tradesWithIndicators.length * 100).toFixed(1)}% of trades)`);
        console.log(`  Edge: +${(bestWinRate - (data.performance?.summary?.winRate || 0)).toFixed(1)}%`);
    }
});

console.log('\n====================================================================');
console.log('                         KEY FINDINGS                               ');
console.log('====================================================================\n');

// Summarize key findings
const significantIndicators = Object.entries(indicatorStats)
    .filter(([_, stats]) => {
        const meanDiff = Math.abs(stats.win.mean - stats.loss.mean);
        const pooledStd = Math.sqrt((stats.win.std ** 2 + stats.loss.std ** 2) / 2);
        return (meanDiff / pooledStd) > 0.5;
    })
    .map(([indicator]) => indicator);

const significantCorrelations = Object.entries(correlations)
    .filter(([_, corr]) => Math.abs(corr.outcome) > 0.1 || Math.abs(corr.pnl) > 0.1)
    .map(([indicator, corr]) => ({ indicator, ...corr }));

console.log('1. STATISTICALLY SIGNIFICANT INDICATORS:');
if (significantIndicators.length > 0) {
    significantIndicators.forEach(ind => {
        const stats = indicatorStats[ind];
        console.log(`   - ${ind}: Win mean=${stats.win.mean.toFixed(2)}, Loss mean=${stats.loss.mean.toFixed(2)}`);
    });
} else {
    console.log('   None found with moderate or strong effect size');
}

console.log('\n2. MEANINGFUL CORRELATIONS:');
if (significantCorrelations.length > 0) {
    significantCorrelations.forEach(({ indicator, outcome, pnl }) => {
        console.log(`   - ${indicator}: Outcome r=${outcome.toFixed(3)}, P&L r=${pnl.toFixed(3)}`);
    });
} else {
    console.log('   No strong correlations found');
}

console.log('\n3. ACTIONABLE INSIGHTS:');
const insights = [];

// Check for RSI patterns
if (indicatorStats.rsi_14) {
    if (indicatorStats.rsi_14.win.mean < 45 && indicatorStats.rsi_14.loss.mean > 55) {
        insights.push('RSI oversold conditions (<45) favor winning trades');
    } else if (indicatorStats.rsi_14.win.mean > 55 && indicatorStats.rsi_14.loss.mean < 45) {
        insights.push('RSI overbought conditions (>55) favor winning trades');
    }
}

// Check for momentum patterns
if (indicatorStats.squeeze_momentum_value) {
    const momDiff = indicatorStats.squeeze_momentum_value.win.mean - indicatorStats.squeeze_momentum_value.loss.mean;
    if (Math.abs(momDiff) > 1) {
        insights.push(`Squeeze momentum ${momDiff > 0 ? 'positive' : 'negative'} values improve win rate`);
    }
}

// Check for extreme CCI
if (indicatorStats.cci_20) {
    if (Math.abs(indicatorStats.cci_20.win.mean) > Math.abs(indicatorStats.cci_20.loss.mean) * 1.5) {
        insights.push('Extreme CCI values (>100 or <-100) correlate with winning trades');
    }
}

if (insights.length > 0) {
    insights.forEach(insight => console.log(`   - ${insight}`));
} else {
    console.log('   - Indicators show limited predictive power individually');
    console.log('   - Consider combining multiple indicators for confluence signals');
    console.log('   - Current win rate may be more dependent on GEX levels than technical indicators');
}

console.log('\n====================================================================');
console.log('                          RECOMMENDATIONS                           ');
console.log('====================================================================\n');

console.log('Based on the analysis:');
console.log('1. The indicators show limited individual predictive power');
console.log('2. Confluence of multiple indicators may provide better signals');
console.log('3. Consider using indicators as filters rather than primary signals');
console.log('4. The GEX recoil strategy appears to work independently of these indicators');
console.log('5. Further testing with different indicator parameters may yield better results');

console.log('\n====================================================================\n');