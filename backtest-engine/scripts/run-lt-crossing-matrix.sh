#!/bin/bash
# Run LT Level Crossing strategy with symmetric stop/target matrix
# Goal: probability matrix showing how often price hits target vs stop
# at each R:R level (10, 20, 30, 40, 50 points symmetric)

cd "$(dirname "$0")/.."

TICKER=NQ
START=2025-01-02
END=2025-12-31

echo "============================================"
echo " LT Level Crossing — Symmetric R:R Matrix"
echo "============================================"
echo "  Ticker: ${TICKER}"
echo "  Period: ${START} to ${END}"
echo "  Levels: 10/10, 20/20, 30/30, 40/40, 50/50"
echo "============================================"
echo ""

for POINTS in 10 20 30 40 50; do
  echo "--- Running ${POINTS}/${POINTS} (stop=${POINTS} / target=${POINTS}) ---"
  node index.js \
    --ticker ${TICKER} \
    --start ${START} \
    --end ${END} \
    --strategy lt-cross \
    --stop-buffer ${POINTS} \
    --target-points ${POINTS} \
    --quiet \
    --output "results/lt-crossing-${POINTS}-${POINTS}.json" \
    --output-csv "results/lt-crossing-${POINTS}-${POINTS}.csv" \
    2>&1
  echo ""
done

echo "============================================"
echo " Results saved to results/lt-crossing-*.json"
echo "============================================"
