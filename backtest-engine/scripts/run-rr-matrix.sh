#!/usr/bin/env bash

#Run asymmetric R/R matrix for CBBO-LT Volatility strategy

set -e

# Test matrix
STOPS=(10 15 20 25 30 40 50)
TARGETS=(20 30 40 50 60 80 100)

# Results directory
RESULTS_DIR="results/rr-matrix"
mkdir -p "$RESULTS_DIR"

echo "🚀 Starting Asymmetric R/R Matrix Analysis"
echo "📊 Testing ${#STOPS[@]} stops × ${#TARGETS[@]} targets = $((${#STOPS[@]} * ${#TARGETS[@]})) configurations"
echo ""

TOTAL=$((${#STOPS[@]} * ${#TARGETS[@]}))
COUNT=0

for STOP in "${STOPS[@]}"; do
  for TARGET in "${TARGETS[@]}"; do
    COUNT=$((COUNT + 1))
    RR=$(echo "scale=2; $TARGET / $STOP" | bc)

    echo "[$COUNT/$TOTAL] Testing: Stop=${STOP}pts, Target=${TARGET}pts (R/R=${RR})"

    # Run backtest and save to file
    OUTPUT_FILE="$RESULTS_DIR/stop${STOP}_target${TARGET}.txt"

    node index.js \
      --ticker NQ \
      --start 2025-01-13 \
      --end 2025-01-31 \
      --strategy cbbo-lt-volatility \
      --timeframe 5m \
      --stop-buffer "$STOP" \
      --target-points "$TARGET" \
      > "$OUTPUT_FILE" 2>&1

    # Extract key metrics for quick summary
    TRADES=$(grep "Total Trades" "$OUTPUT_FILE" | awk '{print $NF}' || echo "0")
    WIN_RATE=$(grep "Win Rate" "$OUTPUT_FILE" | grep -oP '\d+\.\d+(?=%)' || echo "0")
    PNL=$(grep "Total P&L" "$OUTPUT_FILE" | grep -oP '\$-?\d+(,\d+)?' | tr -d '$,' || echo "0")

    echo "   → $TRADES trades, ${WIN_RATE}% win rate, \$${PNL} P&L"
    echo ""
  done
done

echo "✅ All configurations complete! Results saved to $RESULTS_DIR/"
echo "📊 Generating summary report..."

# Generate summary CSV
SUMMARY_FILE="$RESULTS_DIR/summary.csv"
echo "Stop,Target,R/R,Trades,WinRate,PnL,ProfitFactor,Expectancy" > "$SUMMARY_FILE"

for STOP in "${STOPS[@]}"; do
  for TARGET in "${STOPS[@]}"; do
    OUTPUT_FILE="$RESULTS_DIR/stop${STOP}_target${TARGET}.txt"
    if [ -f "$OUTPUT_FILE" ]; then
      RR=$(echo "scale=2; $TARGET / $STOP" | bc)
      TRADES=$(grep "Total Trades" "$OUTPUT_FILE" | awk '{print $NF}' || echo "0")
      WIN_RATE=$(grep "Win Rate" "$OUTPUT_FILE" | grep -oP '\d+\.\d+(?=%)' || echo "0")
      PNL=$(grep "Total P&L" "$OUTPUT_FILE" | grep -oP -- '-?\d+(,\d+)?' | tr -d ',' || echo "0")
      PF=$(grep "Profit Factor" "$OUTPUT_FILE" | awk '{print $NF}' || echo "0")
      EXP=$(grep "Expectancy" "$OUTPUT_FILE" | grep -oP -- '\$-?\d+\.\d+' | tr -d '$' || echo "0")

      echo "$STOP,$TARGET,$RR,$TRADES,$WIN_RATE,$PNL,$PF,$EXP" >> "$SUMMARY_FILE"
    fi
  done
done

echo "💾 Summary saved to: $SUMMARY_FILE"
