#!/bin/bash

# Simple strategy comparison script
# Tests each strategy individually with the full dataset

echo "🚀 Starting comprehensive strategy analysis..."
echo "📅 Period: April 4, 2023 to December 19, 2025"
echo ""

# Output directory
TIMESTAMP=$(date +"%Y-%m-%dT%H-%M-%S")
OUTPUT_DIR="results/strategy_comparison_$TIMESTAMP"
mkdir -p "$OUTPUT_DIR"

echo "📁 Results will be saved to: $OUTPUT_DIR"
echo ""

# Common parameters
TICKER="NQ"
START_DATE="2023-04-04"
END_DATE="2025-12-19"
TIMEFRAME="15m"
COMMISSION="5"
CAPITAL="100000"

# Strategy list with descriptions
declare -A STRATEGIES
STRATEGIES[gex-recoil]="GEX Recoil Strategy"
STRATEGIES[gex-ldpm-confluence]="GEX-LDPM Confluence Strategy"
STRATEGIES[gex-ldpm-confluence-lt]="GEX-LDPM Confluence with LT Filtering"
STRATEGIES[gex-level-sweep]="GEX Level Sweep Strategy"

# Function to run a single backtest
run_backtest() {
    local strategy=$1
    local description=$2
    local output_file="$OUTPUT_DIR/${strategy}_results.json"

    echo "📊 Running: $description"
    echo "   Strategy: $strategy"
    echo "   Output: $(basename $output_file)"

    # Run the backtest
    node index.js \
        --ticker "$TICKER" \
        --start "$START_DATE" \
        --end "$END_DATE" \
        --timeframe "$TIMEFRAME" \
        --strategy "$strategy" \
        --commission "$COMMISSION" \
        --capital "$CAPITAL" \
        --output-json "$output_file" \
        --quiet

    local exit_code=$?

    if [ $exit_code -eq 0 ] && [ -f "$output_file" ]; then
        # Extract key metrics
        local trades=$(grep '"totalTrades"' "$output_file" | cut -d: -f2 | cut -d, -f1 | tr -d ' ')
        local win_rate=$(grep '"winRate"' "$output_file" | cut -d: -f2 | cut -d, -f1 | tr -d ' ')
        local pnl=$(grep '"totalPnL"' "$output_file" | cut -d: -f2 | cut -d, -f1 | tr -d ' ')
        local dd=$(grep '"maxDrawdown"' "$output_file" | cut -d: -f2 | cut -d, -f1 | tr -d ' ')

        echo "✅ Completed: $strategy"
        echo "   📈 Trades: $trades | Win Rate: ${win_rate}% | PnL: \$$pnl | DD: ${dd}%"
        echo ""
        return 0
    else
        echo "❌ Failed: $strategy (exit code: $exit_code)"
        echo ""
        return 1
    fi
}

# Run all strategies
echo "🔄 Running backtests..."
echo ""

successful_tests=0
total_tests=${#STRATEGIES[@]}

for strategy in "${!STRATEGIES[@]}"; do
    description="${STRATEGIES[$strategy]}"
    if run_backtest "$strategy" "$description"; then
        ((successful_tests++))
    fi
done

echo "======================================"
echo "🏁 Analysis Complete!"
echo "✅ Successful tests: $successful_tests/$total_tests"
echo "📁 Results saved in: $OUTPUT_DIR"

if [ $successful_tests -gt 0 ]; then
    echo ""
    echo "📊 Quick Performance Summary:"
    echo "| Strategy | Net PnL | Win Rate | Max DD |"
    echo "|----------|---------|----------|--------|"

    for strategy in "${!STRATEGIES[@]}"; do
        local output_file="$OUTPUT_DIR/${strategy}_results.json"
        if [ -f "$output_file" ]; then
            local pnl=$(grep '"totalPnL"' "$output_file" | cut -d: -f2 | cut -d, -f1 | tr -d ' ' | sed 's/^/$/g')
            local win_rate=$(grep '"winRate"' "$output_file" | cut -d: -f2 | cut -d, -f1 | tr -d ' ')
            local dd=$(grep '"maxDrawdown"' "$output_file" | cut -d: -f2 | cut -d, -f1 | tr -d ' ')
            echo "| $strategy | $pnl | ${win_rate}% | ${dd}% |"
        fi
    done

    echo ""
    echo "💡 Next steps:"
    echo "1. Review individual strategy results in $OUTPUT_DIR"
    echo "2. Identify best-performing strategies for enhancement"
    echo "3. Apply market structure and key levels improvements"
fi