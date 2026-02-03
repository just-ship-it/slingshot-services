#!/bin/bash
# LT Level Migration - Longs Only Optimization Matrix
# Tests: Asymmetric R:R, Session Filters, Combined

set -e
cd "$(dirname "$0")/.."

echo "=== LT Longs-Only Optimization Matrix ==="
echo "Date range: 2025-01-02 to 2025-12-31"
echo ""

# Base command
BASE="node index.js --ticker NQ --start 2025-01-02 --end 2025-12-31 --strategy lt-mig --longs-only"

# Test 1: Asymmetric R:R ratios (tighter stop, wider target)
echo "=== PHASE 1: Asymmetric R:R Tests ==="
for STOP in 15 20 25; do
  for TARGET in 30 45 60; do
    if [ $TARGET -gt $STOP ]; then
      echo "--- Testing Stop: $STOP / Target: $TARGET ---"
      $BASE --stop-buffer $STOP --target-points $TARGET \
        --output results/lt-longs-${STOP}-${TARGET}.json \
        --output-csv results/lt-longs-${STOP}-${TARGET}.csv
      echo ""
    fi
  done
done

# Test 2: Session filters with best R:R from phase 1 (using 20/45 as baseline)
echo "=== PHASE 2: Session Filter Tests (20/45 R:R) ==="

echo "--- RTH Only ---"
$BASE --stop-buffer 20 --target-points 45 --use-session-filter --blocked-sessions overnight,premarket,afterhours \
  --output results/lt-longs-20-45-rth.json \
  --output-csv results/lt-longs-20-45-rth.csv
echo ""

echo "--- Overnight Only ---"
$BASE --stop-buffer 20 --target-points 45 --use-session-filter --blocked-sessions rth,premarket,afterhours \
  --output results/lt-longs-20-45-overnight.json \
  --output-csv results/lt-longs-20-45-overnight.csv
echo ""

echo "--- Pre-market + RTH ---"
$BASE --stop-buffer 20 --target-points 45 --use-session-filter --blocked-sessions overnight,afterhours \
  --output results/lt-longs-20-45-premarket-rth.json \
  --output-csv results/lt-longs-20-45-premarket-rth.csv
echo ""

# Test 3: Wider targets for trend capture
echo "=== PHASE 3: Wide Target Tests ==="
for TARGET in 75 100; do
  echo "--- Testing Stop: 25 / Target: $TARGET ---"
  $BASE --stop-buffer 25 --target-points $TARGET \
    --output results/lt-longs-25-${TARGET}.json \
    --output-csv results/lt-longs-25-${TARGET}.csv
  echo ""
done

echo "=== Optimization Complete ==="
echo "Results in: results/lt-longs-*.json"
