#!/usr/bin/env python3

import json
import numpy as np
import pandas as pd
from scipy import stats
import matplotlib.pyplot as plt

def analyze_momentum_correlation(json_file):
    """Analyze correlation between squeeze momentum values and trade outcomes"""

    # Load the JSON results
    with open(json_file, 'r') as f:
        data = json.load(f)

    # Extract trade data
    trades = data['trades']

    # Create lists to store data
    momentum_values = []
    is_winner = []
    pnl_values = []
    exit_reasons = []

    print(f"🔍 Analyzing {len(trades)} trades from GEX Recoil strategy")
    print("=" * 60)

    # Extract momentum values and outcomes
    for trade in trades:
        # Get squeeze momentum value
        momentum = trade['metadata'].get('squeeze_momentum_value')

        if momentum is not None:
            momentum_values.append(momentum)
            is_winner.append(trade['netPnL'] > 0)
            pnl_values.append(trade['netPnL'])
            exit_reasons.append(trade['exitReason'])

    # Convert to numpy arrays
    momentum_values = np.array(momentum_values)
    is_winner = np.array(is_winner)
    pnl_values = np.array(pnl_values)

    # Basic statistics
    total_trades = len(momentum_values)
    winning_trades = np.sum(is_winner)
    win_rate = winning_trades / total_trades * 100

    print(f"📊 BASIC STATISTICS")
    print(f"Total Trades: {total_trades}")
    print(f"Winning Trades: {winning_trades}")
    print(f"Win Rate: {win_rate:.1f}%")
    print(f"Average P&L: ${np.mean(pnl_values):.2f}")
    print()

    # Momentum statistics
    print(f"📈 MOMENTUM STATISTICS")
    print(f"Momentum Range: {np.min(momentum_values):.2f} to {np.max(momentum_values):.2f}")
    print(f"Average Momentum: {np.mean(momentum_values):.2f}")
    print(f"Momentum StdDev: {np.std(momentum_values):.2f}")
    print()

    # Separate winners and losers
    winner_momentum = momentum_values[is_winner]
    loser_momentum = momentum_values[~is_winner]

    print(f"🎯 MOMENTUM BY OUTCOME")
    print(f"Winners - Avg Momentum: {np.mean(winner_momentum):.2f}")
    print(f"Winners - Median Momentum: {np.median(winner_momentum):.2f}")
    print(f"Losers - Avg Momentum: {np.mean(loser_momentum):.2f}")
    print(f"Losers - Median Momentum: {np.median(loser_momentum):.2f}")
    print()

    # Statistical tests
    print(f"📊 STATISTICAL ANALYSIS")

    # T-test between winner and loser momentum
    t_stat, p_value = stats.ttest_ind(winner_momentum, loser_momentum)
    print(f"T-test (Winners vs Losers):")
    print(f"  t-statistic: {t_stat:.4f}")
    print(f"  p-value: {p_value:.6f}")
    print(f"  Significant difference: {'YES' if p_value < 0.05 else 'NO'}")
    print()

    # Correlation between momentum and P&L
    correlation, corr_p_value = stats.pearsonr(momentum_values, pnl_values)
    print(f"Correlation (Momentum vs P&L):")
    print(f"  Correlation coefficient: {correlation:.4f}")
    print(f"  p-value: {corr_p_value:.6f}")
    print(f"  Significant correlation: {'YES' if corr_p_value < 0.05 else 'NO'}")
    print()

    # Quartile analysis
    print(f"📈 QUARTILE ANALYSIS")
    quartiles = np.percentile(momentum_values, [25, 50, 75])
    print(f"Q1 (25%): {quartiles[0]:.2f}")
    print(f"Q2 (50%): {quartiles[1]:.2f}")
    print(f"Q3 (75%): {quartiles[2]:.2f}")
    print()

    # Performance by momentum quartiles
    q1_mask = momentum_values <= quartiles[0]
    q2_mask = (momentum_values > quartiles[0]) & (momentum_values <= quartiles[1])
    q3_mask = (momentum_values > quartiles[1]) & (momentum_values <= quartiles[2])
    q4_mask = momentum_values > quartiles[2]

    quartile_data = []
    for i, (mask, name) in enumerate([(q1_mask, 'Q1 (Most Bearish)'),
                                      (q2_mask, 'Q2 (Mild Bearish)'),
                                      (q3_mask, 'Q3 (Mild Bullish)'),
                                      (q4_mask, 'Q4 (Most Bullish)')]):
        if np.sum(mask) > 0:
            q_trades = np.sum(mask)
            q_wins = np.sum(is_winner[mask])
            q_win_rate = q_wins / q_trades * 100
            q_avg_pnl = np.mean(pnl_values[mask])
            q_avg_momentum = np.mean(momentum_values[mask])

            quartile_data.append({
                'quartile': name,
                'trades': q_trades,
                'win_rate': q_win_rate,
                'avg_pnl': q_avg_pnl,
                'avg_momentum': q_avg_momentum
            })

            print(f"{name}:")
            print(f"  Trades: {q_trades}")
            print(f"  Win Rate: {q_win_rate:.1f}%")
            print(f"  Avg P&L: ${q_avg_pnl:.2f}")
            print(f"  Avg Momentum: {q_avg_momentum:.2f}")
            print()

    # Momentum ranges analysis
    print(f"🎯 MOMENTUM RANGES ANALYSIS")

    # Define ranges
    ranges = [
        (lambda x: x < -50, "Very Bearish (< -50)"),
        (lambda x: (x >= -50) & (x < -10), "Bearish (-50 to -10)"),
        (lambda x: (x >= -10) & (x < 10), "Neutral (-10 to +10)"),
        (lambda x: (x >= 10) & (x < 50), "Bullish (+10 to +50)"),
        (lambda x: x >= 50, "Very Bullish (>= +50)")
    ]

    for range_func, range_name in ranges:
        mask = range_func(momentum_values)
        if np.sum(mask) > 0:
            r_trades = np.sum(mask)
            r_wins = np.sum(is_winner[mask])
            r_win_rate = r_wins / r_trades * 100
            r_avg_pnl = np.mean(pnl_values[mask])

            print(f"{range_name}:")
            print(f"  Trades: {r_trades}")
            print(f"  Win Rate: {r_win_rate:.1f}%")
            print(f"  Avg P&L: ${r_avg_pnl:.2f}")
            print()

    # Key insights
    print(f"🔑 KEY INSIGHTS")

    # Check if positive momentum performs better
    positive_mask = momentum_values > 0
    negative_mask = momentum_values <= 0

    if np.sum(positive_mask) > 0 and np.sum(negative_mask) > 0:
        pos_win_rate = np.sum(is_winner[positive_mask]) / np.sum(positive_mask) * 100
        neg_win_rate = np.sum(is_winner[negative_mask]) / np.sum(negative_mask) * 100
        pos_avg_pnl = np.mean(pnl_values[positive_mask])
        neg_avg_pnl = np.mean(pnl_values[negative_mask])

        print(f"Positive Momentum (Bullish): {np.sum(positive_mask)} trades, {pos_win_rate:.1f}% win rate, ${pos_avg_pnl:.2f} avg P&L")
        print(f"Negative Momentum (Bearish): {np.sum(negative_mask)} trades, {neg_win_rate:.1f}% win rate, ${neg_avg_pnl:.2f} avg P&L")
        print()

        if pos_win_rate > neg_win_rate:
            print("✅ POSITIVE momentum shows better win rate for long entries")
        else:
            print("❌ NEGATIVE momentum shows better win rate (counterintuitive)")

    # Best and worst performing momentum ranges
    best_quartile = max(quartile_data, key=lambda x: x['win_rate'])
    worst_quartile = min(quartile_data, key=lambda x: x['win_rate'])

    print(f"🏆 Best Performing: {best_quartile['quartile']} - {best_quartile['win_rate']:.1f}% win rate")
    print(f"💥 Worst Performing: {worst_quartile['quartile']} - {worst_quartile['win_rate']:.1f}% win rate")

    # Filtering recommendations
    print(f"\n💡 FILTERING RECOMMENDATIONS")

    # Find optimal momentum threshold
    if correlation > 0:
        print(f"✅ Positive correlation detected - consider filtering for positive momentum")
    else:
        print(f"❌ Negative correlation detected - momentum may not be helpful filter")

    # Check extreme values
    very_bearish_mask = momentum_values < -100
    if np.sum(very_bearish_mask) > 0:
        vb_win_rate = np.sum(is_winner[very_bearish_mask]) / np.sum(very_bearish_mask) * 100
        print(f"🚨 Very bearish momentum (< -100): {vb_win_rate:.1f}% win rate - consider avoiding")

    return {
        'total_trades': total_trades,
        'win_rate': win_rate,
        'correlation': correlation,
        'p_value': corr_p_value,
        'winner_avg_momentum': np.mean(winner_momentum),
        'loser_avg_momentum': np.mean(loser_momentum),
        'quartile_data': quartile_data
    }

if __name__ == "__main__":
    # Analyze the results
    results = analyze_momentum_correlation('results/gex-recoil-15m-with-momentum.json')
    print(f"\n✅ Analysis complete!")