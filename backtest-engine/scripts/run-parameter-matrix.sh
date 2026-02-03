#!/bin/bash
# Run symmetric stop/target matrix for iv-skew-gex strategy
# Tests 10 point levels: 10, 20, 30, 40, 50, 60, 70, 80, 90, 100

cd "$(dirname "$0")/.."

RESULTS_DIR="results/parameter-matrix"
mkdir -p "$RESULTS_DIR"

echo "=========================================="
echo " SYMMETRIC STOP/TARGET PARAMETER MATRIX"
echo "=========================================="
echo ""
echo "Strategy: iv-skew-gex"
echo "Date Range: 2025-01-13 to 2025-12-24"
echo "Points: 10, 20, 30, 40, 50, 60, 70, 80, 90, 100"
echo "Output: $RESULTS_DIR/"
echo ""

for POINTS in 10 20 30 40 50 60 70 80 90 100; do
  echo "[$POINTS pts] Running backtest: Stop=$POINTS, Target=$POINTS..."

  node index.js \
    --ticker NQ \
    --start 2025-01-13 \
    --end 2025-12-24 \
    --strategy iv-skew-gex \
    --timeframe 15m \
    --stop-loss-points $POINTS \
    --target-points $POINTS \
    --output-json "$RESULTS_DIR/symmetric-${POINTS}pts.json" \
    --quiet

  if [ $? -eq 0 ]; then
    echo "[$POINTS pts] Complete"
  else
    echo "[$POINTS pts] FAILED"
  fi
done

echo ""
echo "All backtests complete!"
echo ""
echo "Analyzing results..."
node scripts/analyze-parameter-matrix.js

echo ""
echo "Results saved to: $RESULTS_DIR/"
