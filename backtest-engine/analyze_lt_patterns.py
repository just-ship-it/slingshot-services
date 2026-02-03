#!/usr/bin/env python3
"""
LT Level Pattern Analysis for GEX LDPM Strategy
Analyzes correlation between LT level ordering patterns and trade success/failure
"""

import json
import pandas as pd
from collections import defaultdict
import numpy as np
from scipy import stats

def classify_lt_ordering(levels):
    """Classify LT level ordering pattern"""
    try:
        l1, l2, l3, l4, l5 = levels['level_1'], levels['level_2'], levels['level_3'], levels['level_4'], levels['level_5']
        levels_list = [l1, l2, l3, l4, l5]

        # Check if ascending (each level higher than previous)
        ascending = all(levels_list[i] <= levels_list[i+1] for i in range(4))

        # Check if descending (each level lower than previous)
        descending = all(levels_list[i] >= levels_list[i+1] for i in range(4))

        if ascending and not descending:
            return "ASCENDING"
        elif descending and not ascending:
            return "DESCENDING"
        else:
            return "MIXED"
    except Exception as e:
        return "INVALID"

def analyze_pairwise_relationships(levels):
    """Analyze specific pairwise level relationships"""
    try:
        relationships = {}
        level_values = [levels[f'level_{i}'] for i in range(1, 6)]

        # Analyze each adjacent pair
        for i in range(4):
            curr_level = f"LT{i+1}"
            next_level = f"LT{i+2}"

            if level_values[i] < level_values[i+1]:
                relationships[f"{curr_level}_vs_{next_level}"] = "ASCENDING"
            elif level_values[i] > level_values[i+1]:
                relationships[f"{curr_level}_vs_{next_level}"] = "DESCENDING"
            else:
                relationships[f"{curr_level}_vs_{next_level}"] = "EQUAL"

        return relationships
    except Exception as e:
        return {}

def analyze_trades():
    """Main analysis function"""
    print("Loading GEX LDPM results...")

    with open('/home/drew/projects/slingshot-services/backtest-engine/results/gex-ldpm-results.json', 'r') as f:
        data = json.load(f)

    trades = data.get('trades', [])
    print(f"Found {len(trades)} trades to analyze")

    # Extract trade data
    trade_data = []

    for trade in trades:
        try:
            # Extract basic trade info
            trade_info = {
                'id': trade['id'],
                'side': trade['side'],
                'gross_pnl': trade.get('grossPnL', 0),
                'net_pnl': trade.get('netPnL', 0),
                'exit_reason': trade.get('exitReason', 'unknown'),
                'duration': trade.get('duration', 0)
            }

            # Determine win/loss
            trade_info['outcome'] = 'WIN' if trade_info['gross_pnl'] > 0 else 'LOSS'

            # Extract LT levels
            lt_levels = trade['signal'].get('availableLTLevels', {})
            if lt_levels and all(f'level_{i}' in lt_levels for i in range(1, 6)):
                trade_info['lt_levels'] = lt_levels
                trade_info['lt_sentiment'] = lt_levels.get('sentiment', 'UNKNOWN')
                trade_info['lt_ordering'] = classify_lt_ordering(lt_levels)
                trade_info['lt_relationships'] = analyze_pairwise_relationships(lt_levels)

                trade_data.append(trade_info)

        except Exception as e:
            print(f"Error processing trade {trade.get('id', 'unknown')}: {e}")
            continue

    print(f"Successfully processed {len(trade_data)} trades with LT data")

    # Convert to DataFrame for analysis
    df = pd.DataFrame(trade_data)

    # Expand pairwise relationships into separate columns
    relationship_cols = ['LT1_vs_LT2', 'LT2_vs_LT3', 'LT3_vs_LT4', 'LT4_vs_LT5']
    for col in relationship_cols:
        df[col] = df['lt_relationships'].apply(lambda x: x.get(col, 'UNKNOWN'))

    return df

def calculate_statistics(df, group_col, metric_col='outcome'):
    """Calculate win rates and statistics for grouped data"""
    stats_data = []

    for group_value in df[group_col].unique():
        subset = df[df[group_col] == group_value]

        total_trades = len(subset)
        wins = len(subset[subset['outcome'] == 'WIN'])
        losses = len(subset[subset['outcome'] == 'LOSS'])
        win_rate = wins / total_trades if total_trades > 0 else 0

        avg_pnl = subset['gross_pnl'].mean()
        total_pnl = subset['gross_pnl'].sum()

        stats_data.append({
            'pattern': group_value,
            'total_trades': total_trades,
            'wins': wins,
            'losses': losses,
            'win_rate': win_rate,
            'avg_pnl': avg_pnl,
            'total_pnl': total_pnl
        })

    return pd.DataFrame(stats_data)

def analyze_by_direction(df, pattern_col):
    """Analyze patterns broken down by trade direction"""
    results = {}

    for side in ['buy', 'sell']:
        subset = df[df['side'] == side]
        if len(subset) > 0:
            results[side] = calculate_statistics(subset, pattern_col)

    return results

def main():
    print("=== LT Level Pattern Analysis for GEX LDPM Strategy ===\n")

    # Load and process data
    df = analyze_trades()

    if len(df) == 0:
        print("No valid trade data found!")
        return

    print(f"Analysis based on {len(df)} trades with complete LT level data\n")

    # Overall statistics
    total_wins = len(df[df['outcome'] == 'WIN'])
    total_losses = len(df[df['outcome'] == 'LOSS'])
    overall_win_rate = total_wins / len(df)
    overall_avg_pnl = df['gross_pnl'].mean()

    print(f"OVERALL STRATEGY PERFORMANCE:")
    print(f"Total Trades: {len(df)}")
    print(f"Wins: {total_wins} ({overall_win_rate:.2%})")
    print(f"Losses: {total_losses}")
    print(f"Average P&L: ${overall_avg_pnl:.2f}")
    print(f"Total P&L: ${df['gross_pnl'].sum():,.2f}\n")

    # 1. LT Ordering Pattern Analysis
    print("=" * 60)
    print("1. LT ORDERING PATTERN ANALYSIS")
    print("=" * 60)

    ordering_stats = calculate_statistics(df, 'lt_ordering')
    ordering_stats = ordering_stats.sort_values('win_rate', ascending=False)

    print("\nWin Rates by LT Ordering Pattern:")
    print(ordering_stats.to_string(index=False, float_format='%.3f'))

    # Breakdown by direction
    print("\n\nBreakdown by Trade Direction:")
    direction_analysis = analyze_by_direction(df, 'lt_ordering')

    for side, stats_df in direction_analysis.items():
        if len(stats_df) > 0:
            print(f"\n{side.upper()} trades:")
            print(stats_df.to_string(index=False, float_format='%.3f'))

    # 2. Pairwise Relationship Analysis
    print("\n\n" + "=" * 60)
    print("2. PAIRWISE RELATIONSHIP ANALYSIS")
    print("=" * 60)

    relationship_cols = ['LT1_vs_LT2', 'LT2_vs_LT3', 'LT3_vs_LT4', 'LT4_vs_LT5']

    for col in relationship_cols:
        print(f"\n{col.replace('_vs_', ' vs ')} Analysis:")
        rel_stats = calculate_statistics(df, col)
        rel_stats = rel_stats.sort_values('win_rate', ascending=False)
        print(rel_stats.to_string(index=False, float_format='%.3f'))

    # 3. Focus on LT4 vs LT5 (specifically requested)
    print("\n\n" + "=" * 60)
    print("3. DETAILED LT4 vs LT5 ANALYSIS")
    print("=" * 60)

    lt4_vs_lt5_stats = calculate_statistics(df, 'LT4_vs_LT5')
    lt4_vs_lt5_stats = lt4_vs_lt5_stats.sort_values('win_rate', ascending=False)

    print("\nLT4 vs LT5 Relationship Analysis:")
    print(lt4_vs_lt5_stats.to_string(index=False, float_format='%.3f'))

    # Direction breakdown for LT4 vs LT5
    lt4_lt5_direction = analyze_by_direction(df, 'LT4_vs_LT5')

    for side, stats_df in lt4_lt5_direction.items():
        if len(stats_df) > 0:
            print(f"\n{side.upper()} trades - LT4 vs LT5:")
            print(stats_df.to_string(index=False, float_format='%.3f'))

    # 4. Statistical Significance Testing
    print("\n\n" + "=" * 60)
    print("4. STATISTICAL SIGNIFICANCE ANALYSIS")
    print("=" * 60)

    # Chi-square test for LT ordering patterns
    contingency_ordering = pd.crosstab(df['lt_ordering'], df['outcome'])
    if contingency_ordering.shape[0] > 1 and contingency_ordering.shape[1] > 1:
        chi2, p_value, dof, expected = stats.chi2_contingency(contingency_ordering)
        print(f"\nLT Ordering Pattern Chi-square test:")
        print(f"Chi-square statistic: {chi2:.3f}")
        print(f"P-value: {p_value:.6f}")
        print(f"Significant at α=0.05: {'Yes' if p_value < 0.05 else 'No'}")

    # Chi-square test for LT4 vs LT5
    contingency_lt4_lt5 = pd.crosstab(df['LT4_vs_LT5'], df['outcome'])
    if contingency_lt4_lt5.shape[0] > 1 and contingency_lt4_lt5.shape[1] > 1:
        chi2, p_value, dof, expected = stats.chi2_contingency(contingency_lt4_lt5)
        print(f"\nLT4 vs LT5 Chi-square test:")
        print(f"Chi-square statistic: {chi2:.3f}")
        print(f"P-value: {p_value:.6f}")
        print(f"Significant at α=0.05: {'Yes' if p_value < 0.05 else 'No'}")

    # 5. Actionable Trading Rules
    print("\n\n" + "=" * 60)
    print("5. ACTIONABLE TRADING RULES & RECOMMENDATIONS")
    print("=" * 60)

    best_ordering = ordering_stats.iloc[0]
    worst_ordering = ordering_stats.iloc[-1]

    print(f"\nBEST PERFORMING LT ORDERING PATTERN:")
    print(f"Pattern: {best_ordering['pattern']}")
    print(f"Win Rate: {best_ordering['win_rate']:.2%}")
    print(f"Average P&L: ${best_ordering['avg_pnl']:.2f}")
    print(f"Total Trades: {best_ordering['total_trades']}")

    print(f"\nWORST PERFORMING LT ORDERING PATTERN:")
    print(f"Pattern: {worst_ordering['pattern']}")
    print(f"Win Rate: {worst_ordering['win_rate']:.2%}")
    print(f"Average P&L: ${worst_ordering['avg_pnl']:.2f}")
    print(f"Total Trades: {worst_ordering['total_trades']}")

    # LT4 vs LT5 specific recommendations
    lt4_lt5_best = lt4_vs_lt5_stats.iloc[0]
    lt4_lt5_worst = lt4_vs_lt5_stats.iloc[-1]

    print(f"\nLT4 vs LT5 ANALYSIS:")
    print(f"Best: {lt4_lt5_best['pattern']} - {lt4_lt5_best['win_rate']:.2%} win rate")
    print(f"Worst: {lt4_lt5_worst['pattern']} - {lt4_lt5_worst['win_rate']:.2%} win rate")

    # Generate filtering recommendations
    print(f"\nRECOMMENDED TRADE FILTERS:")

    if worst_ordering['win_rate'] < overall_win_rate * 0.8:  # Significantly worse
        print(f"• AVOID trades when LT ordering is {worst_ordering['pattern']}")

    if lt4_lt5_worst['win_rate'] < overall_win_rate * 0.8:
        print(f"• AVOID trades when LT4 vs LT5 is {lt4_lt5_worst['pattern']}")

    if best_ordering['win_rate'] > overall_win_rate * 1.2:  # Significantly better
        print(f"• PREFER trades when LT ordering is {best_ordering['pattern']}")

    if lt4_lt5_best['win_rate'] > overall_win_rate * 1.2:
        print(f"• PREFER trades when LT4 vs LT5 is {lt4_lt5_best['pattern']}")

    # Save detailed results
    print(f"\nSaving detailed analysis results...")

    # Create summary export with proper type conversion
    summary = {
        'overall_stats': {
            'total_trades': int(len(df)),
            'win_rate': float(overall_win_rate),
            'average_pnl': float(overall_avg_pnl),
            'total_pnl': float(df['gross_pnl'].sum())
        },
        'lt_ordering_analysis': ordering_stats.round(4).to_dict('records'),
        'lt4_vs_lt5_analysis': lt4_vs_lt5_stats.round(4).to_dict('records'),
        'recommendations': {
            'best_ordering_pattern': str(best_ordering['pattern']),
            'worst_ordering_pattern': str(worst_ordering['pattern']),
            'best_lt4_lt5_pattern': str(lt4_lt5_best['pattern']),
            'worst_lt4_lt5_pattern': str(lt4_lt5_worst['pattern'])
        }
    }

    with open('/home/drew/projects/slingshot-services/backtest-engine/lt_pattern_analysis.json', 'w') as f:
        json.dump(summary, f, indent=2, default=str)

    print("Analysis complete! Results saved to lt_pattern_analysis.json")

if __name__ == "__main__":
    main()