#!/bin/bash
# LT Level Migration — Symmetric R:R Matrix
# Runs 5 backtests with matching stop/target pairs to build a probability matrix.
#
# Usage:  bash scripts/run-lt-migration-matrix.sh
# Output: results/lt-migration-{N}-{N}.json  and  .csv  for each pair

set -e

cd "$(dirname "$0")/.."

echo "=== LT Level Migration Symmetric R:R Matrix ==="
echo "Date range: 2025-01-02 to 2025-12-31"
echo ""

for POINTS in 10 20 30 40 50; do
  echo "--- Running ${POINTS}/${POINTS} (stop/target) ---"
  node index.js --ticker NQ --start 2025-01-02 --end 2025-12-31 \
    --strategy lt-mig \
    --stop-buffer $POINTS --target-points $POINTS \
    --output results/lt-migration-${POINTS}-${POINTS}.json \
    --output-csv results/lt-migration-${POINTS}-${POINTS}.csv
  echo ""
done

echo "=== Matrix Complete ==="
echo "Results in: results/lt-migration-*.json"
