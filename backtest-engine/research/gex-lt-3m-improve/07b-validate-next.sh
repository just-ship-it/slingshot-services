#!/bin/bash
# Phase 7b — launch v3-balanced + v3-low-dd engine validation (parallel).
# Run after v3 + v3-max finish (max 2 engines parallel).
#
# Usage: ./07b-validate-next.sh

set -euo pipefail
cd "$(dirname "$0")/../.."

OUT_DIR=research/gex-lt-3m-improve/output
mkdir -p "$OUT_DIR"

COMMON=(
  --ticker NQ
  --strategy gex-lt-3m-crossover
  --timeframe 1m
  --raw-contracts
  --start 2025-01-13
  --end 2026-04-23
  --gex-dir data/gex/nq-cbbo
  --lt-1m-file research/lt-extraction/output/nq_lt_1m_raw.csv
  --glx-force-any
  --eod-cutoff-et 16:40
  --glx-entry-window 07:00-16:00
  --glx-blocked-hours 13
)

echo "=== Launching v3-balanced engine ==="
node index.js "${COMMON[@]}" --glx-preset v3-balanced --output "$OUT_DIR/engine-v3-balanced.json" 2>&1 | tee "$OUT_DIR/engine-v3-balanced.log" &
PID_B=$!

echo "=== Launching v3-low-dd engine ==="
node index.js "${COMMON[@]}" --glx-preset v3-low-dd --output "$OUT_DIR/engine-v3-low-dd.json" 2>&1 | tee "$OUT_DIR/engine-v3-low-dd.log" &
PID_L=$!

wait $PID_B $PID_L
echo "Both engine validations complete."
