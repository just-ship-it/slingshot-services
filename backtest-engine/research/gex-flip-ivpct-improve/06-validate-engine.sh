#!/bin/bash
# Phase 6 — Engine validation. Runs each preset candidate in the actual backtest
# engine and saves the resulting trade JSON to data/gold-standard/.
#
# Run from backtest-engine/. Each run takes ~15min — keep <=2 in parallel.

set -euo pipefail
cd "$(dirname "$0")/../.."   # = backtest-engine/

START="2025-01-13"
END="2026-04-20"

BASE_ARGS=(
  --ticker NQ --strategy gex-flip-ivpct
  --timeframe 5m --raw-contracts
  --start "$START" --end "$END"
  --iv-resolution 1m
  --eod-cutoff-et 16:40
)

run_candidate() {
  local name="$1"; shift
  local outpath="data/gold-standard/${name}.json"
  echo ""
  echo "==================================================="
  echo "[$(date +%H:%M:%S)] Running candidate: ${name}"
  echo "==================================================="
  node index.js "${BASE_ARGS[@]}" \
    --output "${outpath}" \
    "$@" 2>&1 | tail -50
}

# Each engine validation in foreground (caller decides parallelism with shell &).
# Usage:
#   ./06-validate-engine.sh gold              # rerun gold for sanity
#   ./06-validate-engine.sh v2 v2-max         # run specific candidates
#   ./06-validate-engine.sh all               # run all candidates

case "${1:-help}" in
  gold)
    run_candidate "gex-flip-ivpct-tight-rerun" \
      --gfi-stop-pts 60 --gfi-target-pts 200 \
      --gfi-breakeven-stop --gfi-breakeven-trigger 70 --gfi-breakeven-offset 5 \
      --gfi-blocked-hours 6,7,8
    ;;
  v2)
    run_candidate "gex-flip-ivpct-v2" \
      --gfi-preset v2
    ;;
  v2-max)
    run_candidate "gex-flip-ivpct-v2-max" \
      --gfi-preset v2-max
    ;;
  v2-balanced)
    run_candidate "gex-flip-ivpct-v2-balanced" \
      --gfi-preset v2-balanced
    ;;
  v2-low-dd)
    run_candidate "gex-flip-ivpct-v2-low-dd" \
      --gfi-preset v2-low-dd
    ;;
  *)
    echo "Usage: $0 {gold|v2|v2-max|v2-balanced|v2-low-dd}"
    exit 1
    ;;
esac
