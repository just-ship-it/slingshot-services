#!/usr/bin/env bash
# Trailing-stop parameter sweep for gex-lt-3m-crossover.
# Runs all (trigger, offset) combos in parallel batches and emits a CSV summary.
#
# Usage: bash research/glx-trailing-sweep.sh
# Requires: jq

set -euo pipefail
cd "$(dirname "$0")/.."

START=2025-01-13
END=2026-04-23
GEX_DIR=data/gex/nq-cbbo
LT_FILE=research/lt-extraction/output/nq_lt_1m_raw.csv
OUT_DIR=/tmp/glx-sweep-trailing
SUMMARY=$OUT_DIR/summary.csv
LOG_DIR=$OUT_DIR/logs
PARALLEL=2

mkdir -p "$OUT_DIR" "$LOG_DIR"

# (trigger, offset) grid
TRIGGERS=(0 25 40 60 80)
OFFSETS=(0 10 20 30)

# Trigger=0 + Offset=0 = baseline (no trailing). Otherwise both must be > 0.
COMBOS=()
COMBOS+=("0:0")  # baseline
for t in "${TRIGGERS[@]}"; do
  [[ $t -eq 0 ]] && continue
  for o in "${OFFSETS[@]}"; do
    [[ $o -eq 0 ]] && continue
    COMBOS+=("${t}:${o}")
  done
done

echo "trigger,offset,n,pnl,pf,sharpe,maxdd_pct,wr_pct" > "$SUMMARY"

run_one() {
  local trig=$1 off=$2
  local tag=t${trig}_o${off}
  local out=$OUT_DIR/$tag.json
  local log=$LOG_DIR/$tag.log

  local extra=""
  if [[ $trig -gt 0 && $off -gt 0 ]]; then
    extra="--glx-trailing-trigger $trig --glx-trailing-offset $off"
  fi

  node index.js --ticker NQ --strategy gex-lt-3m-crossover --timeframe 1m --raw-contracts \
    --start $START --end $END \
    --gex-dir $GEX_DIR --lt-1m-file $LT_FILE \
    --eod-cutoff-et 16:40 \
    $extra \
    --output-json "$out" \
    --quiet > "$log" 2>&1

  # Parse summary stats from the result JSON
  local n pnl pf sharpe maxdd wr
  n=$(jq -r '.performance.summary.totalTrades' "$out")
  pnl=$(jq -r '.performance.summary.totalPnL' "$out")
  pf=$(jq -r '.performance.basic.profitFactor' "$out")
  sharpe=$(jq -r '.performance.summary.sharpeRatio' "$out")
  maxdd=$(jq -r '.performance.summary.maxDrawdown' "$out")
  wr=$(jq -r '.performance.summary.winRate' "$out")

  echo "$trig,$off,$n,$pnl,$pf,$sharpe,$maxdd,$wr" >> "$SUMMARY"
  echo "DONE  trig=$trig off=$off  n=$n  pnl=$pnl  pf=$pf  sharpe=$sharpe  dd=$maxdd"
}

export -f run_one
export START END GEX_DIR LT_FILE OUT_DIR LOG_DIR SUMMARY

# Run in parallel batches
for combo in "${COMBOS[@]}"; do
  trig=${combo%:*}
  off=${combo#*:}
  echo "QUEUEING trig=$trig off=$off"
  (run_one "$trig" "$off") &

  # Throttle: wait if too many backgrounds
  while [[ $(jobs -rp | wc -l) -ge $PARALLEL ]]; do
    sleep 5
  done
done
wait

echo "All done. Summary:"
sort -t, -k4 -nr "$SUMMARY"
