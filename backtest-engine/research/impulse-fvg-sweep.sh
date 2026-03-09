#!/bin/bash
#
# Impulse FVG Parameter Sweep
#
# Sweeps key parameters across the impulse-fvg strategy to find optimal configs.
# Results are saved to research/output/sweeps/impulse-fvg/
#
# Usage:
#   chmod +x research/impulse-fvg-sweep.sh
#   ./research/impulse-fvg-sweep.sh                 # Full sweep
#   ./research/impulse-fvg-sweep.sh --quick          # Quick sweep (fewer combos)
#   ./research/impulse-fvg-sweep.sh --mode fvg-pullback  # Sweep one mode only
#

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENGINE_DIR="$(dirname "$SCRIPT_DIR")"
OUTPUT_DIR="$SCRIPT_DIR/output/sweeps/impulse-fvg"

START="2023-06-01"
END="2026-01-28"
TICKER="NQ"

# Parse args
QUICK=false
MODE_FILTER=""
for arg in "$@"; do
  case $arg in
    --quick) QUICK=true ;;
    --mode) shift; MODE_FILTER="$2" ;;
    --mode=*) MODE_FILTER="${arg#*=}" ;;
  esac
done

mkdir -p "$OUTPUT_DIR"

# Summary file
SUMMARY="$OUTPUT_DIR/sweep-summary.csv"
echo "mode,min_body,fvg_target,nofvg_target,trailing_trigger,trailing_offset,cooldown_ms,trades,win_rate,pf,total_pnl,max_dd_pct,sharpe,avg_trade" > "$SUMMARY"

run_backtest() {
  local label="$1"
  local mode="$2"
  local min_body="$3"
  local fvg_target="$4"
  local nofvg_target="$5"
  local trail_trigger="$6"
  local trail_offset="$7"
  local cooldown="$8"

  local json_file="$OUTPUT_DIR/${label}.json"

  echo "  Running: $label"

  # Build command
  local cmd="node index.js --ticker $TICKER --start $START --end $END"
  cmd+=" --strategy impulse-fvg --timeframe 1m --minute-resolution --quiet"
  cmd+=" --min-body-points $min_body"
  cmd+=" --impulse-mode $mode"
  cmd+=" --signal-cooldown-ms $cooldown"
  cmd+=" --trailing-trigger $trail_trigger"
  cmd+=" --trailing-offset $trail_offset"
  cmd+=" --output $json_file"

  if [ "$mode" = "fvg-pullback" ] || [ "$mode" = "both" ]; then
    cmd+=" --fvg-target-points $fvg_target"
  fi
  if [ "$mode" = "no-fvg-fade" ] || [ "$mode" = "both" ]; then
    cmd+=" --no-fvg-target-points $nofvg_target"
  fi

  # Run backtest
  cd "$ENGINE_DIR"
  eval $cmd 2>/dev/null

  # Extract results from JSON
  if [ -f "$json_file" ]; then
    local trades=$(node -e "const r=JSON.parse(require('fs').readFileSync('$json_file','utf8')); const b=r.performance?.basic||{}; console.log(b.totalTrades||0)")
    local win_rate=$(node -e "const r=JSON.parse(require('fs').readFileSync('$json_file','utf8')); const b=r.performance?.basic||{}; console.log((b.winRate||0).toFixed(1))")
    local pf=$(node -e "const r=JSON.parse(require('fs').readFileSync('$json_file','utf8')); const b=r.performance?.basic||{}; console.log((b.profitFactor||0).toFixed(2))")
    local total_pnl=$(node -e "const r=JSON.parse(require('fs').readFileSync('$json_file','utf8')); const b=r.performance?.basic||{}; console.log((b.totalPnL||0).toFixed(0))")
    local max_dd=$(node -e "const r=JSON.parse(require('fs').readFileSync('$json_file','utf8')); const d=r.performance?.drawdown||{}; console.log((d.maxDrawdown||0).toFixed(2))")
    local sharpe=$(node -e "const r=JSON.parse(require('fs').readFileSync('$json_file','utf8')); const k=r.performance?.risk||{}; console.log((k.sharpeRatio||0).toFixed(2))")
    local avg_trade=$(node -e "const r=JSON.parse(require('fs').readFileSync('$json_file','utf8')); const b=r.performance?.basic||{}; console.log((b.avgTrade||0).toFixed(0))")

    echo "$mode,$min_body,$fvg_target,$nofvg_target,$trail_trigger,$trail_offset,$cooldown,$trades,$win_rate,$pf,$total_pnl,$max_dd,$sharpe,$avg_trade" >> "$SUMMARY"
    echo "    -> Trades=$trades WR=$win_rate% PF=$pf P&L=\$$total_pnl DD=$max_dd%"
  else
    echo "    -> FAILED (no output)"
    echo "$mode,$min_body,$fvg_target,$nofvg_target,$trail_trigger,$trail_offset,$cooldown,0,0,0,0,0,0,0" >> "$SUMMARY"
  fi
}

echo "============================================"
echo "  Impulse FVG Parameter Sweep"
echo "  Period: $START to $END"
echo "  Ticker: $TICKER"
echo "============================================"
echo ""

# ── Phase 1: Mode comparison with default params ──────────────────
echo "=== Phase 1: Mode Comparison (defaults) ==="

if [ -z "$MODE_FILTER" ] || [ "$MODE_FILTER" = "both" ]; then
  run_backtest "mode-both" "both" 20 30 20 15 8 1800000
fi
if [ -z "$MODE_FILTER" ] || [ "$MODE_FILTER" = "fvg-pullback" ]; then
  run_backtest "mode-fvg" "fvg-pullback" 20 30 20 15 8 1800000
fi
if [ -z "$MODE_FILTER" ] || [ "$MODE_FILTER" = "no-fvg-fade" ]; then
  run_backtest "mode-nofvg" "no-fvg-fade" 20 30 20 15 8 1800000
fi

# ── Phase 2: Min body size sweep ──────────────────────────────────
echo ""
echo "=== Phase 2: Min Body Size ==="

for body in 15 20 25 30; do
  if [ -z "$MODE_FILTER" ] || [ "$MODE_FILTER" = "fvg-pullback" ]; then
    run_backtest "fvg-body${body}" "fvg-pullback" $body 30 20 15 8 1800000
  fi
  if [ -z "$MODE_FILTER" ] || [ "$MODE_FILTER" = "no-fvg-fade" ]; then
    run_backtest "nofvg-body${body}" "no-fvg-fade" $body 30 20 15 8 1800000
  fi
done

# ── Phase 3: Target points sweep ──────────────────────────────────
echo ""
echo "=== Phase 3: Target Points ==="

if $QUICK; then
  FVG_TARGETS="20 30 40"
  NOFVG_TARGETS="15 20 30"
else
  FVG_TARGETS="15 20 25 30 40 50"
  NOFVG_TARGETS="10 15 20 25 30"
fi

for target in $FVG_TARGETS; do
  if [ -z "$MODE_FILTER" ] || [ "$MODE_FILTER" = "fvg-pullback" ]; then
    run_backtest "fvg-tgt${target}" "fvg-pullback" 20 $target 20 15 8 1800000
  fi
done

for target in $NOFVG_TARGETS; do
  if [ -z "$MODE_FILTER" ] || [ "$MODE_FILTER" = "no-fvg-fade" ]; then
    run_backtest "nofvg-tgt${target}" "no-fvg-fade" 20 30 $target 15 8 1800000
  fi
done

# ── Phase 4: Trailing stop sweep ──────────────────────────────────
echo ""
echo "=== Phase 4: Trailing Stop ==="

if $QUICK; then
  TRIGGERS="10 15 20"
  OFFSETS="5 8 12"
else
  TRIGGERS="8 10 12 15 20 25"
  OFFSETS="3 5 8 10 12 15"
fi

for trigger in $TRIGGERS; do
  for offset in $OFFSETS; do
    # Skip if offset >= trigger (makes no sense)
    if [ $offset -ge $trigger ]; then
      continue
    fi
    if [ -z "$MODE_FILTER" ] || [ "$MODE_FILTER" = "fvg-pullback" ]; then
      run_backtest "fvg-trail${trigger}-${offset}" "fvg-pullback" 20 30 20 $trigger $offset 1800000
    fi
    if [ -z "$MODE_FILTER" ] || [ "$MODE_FILTER" = "no-fvg-fade" ]; then
      run_backtest "nofvg-trail${trigger}-${offset}" "no-fvg-fade" 20 30 20 $trigger $offset 1800000
    fi
  done
done

# ── Phase 5: Cooldown sweep ──────────────────────────────────────
echo ""
echo "=== Phase 5: Cooldown ==="

for cooldown in 900000 1800000 3600000; do
  local_label=""
  case $cooldown in
    900000)  local_label="15m" ;;
    1800000) local_label="30m" ;;
    3600000) local_label="60m" ;;
  esac

  if [ -z "$MODE_FILTER" ] || [ "$MODE_FILTER" = "fvg-pullback" ]; then
    run_backtest "fvg-cd${local_label}" "fvg-pullback" 20 30 20 15 8 $cooldown
  fi
  if [ -z "$MODE_FILTER" ] || [ "$MODE_FILTER" = "no-fvg-fade" ]; then
    run_backtest "nofvg-cd${local_label}" "no-fvg-fade" 20 30 20 15 8 $cooldown
  fi
done

# ── Phase 6: No trailing stop comparison ──────────────────────────
echo ""
echo "=== Phase 6: No Trailing Stop ==="

if [ -z "$MODE_FILTER" ] || [ "$MODE_FILTER" = "fvg-pullback" ]; then
  cd "$ENGINE_DIR"
  node index.js --ticker $TICKER --start $START --end $END \
    --strategy impulse-fvg --timeframe 1m --minute-resolution --quiet \
    --impulse-mode fvg-pullback --min-body-points 20 \
    --fvg-target-points 30 --signal-cooldown-ms 1800000 \
    --use-trailing-stop false \
    --output "$OUTPUT_DIR/fvg-notrail.json" 2>/dev/null

  if [ -f "$OUTPUT_DIR/fvg-notrail.json" ]; then
    trades=$(node -e "const r=JSON.parse(require('fs').readFileSync('$OUTPUT_DIR/fvg-notrail.json','utf8')); const b=r.performance?.basic||{}; console.log(b.totalTrades||0)")
    pf=$(node -e "const r=JSON.parse(require('fs').readFileSync('$OUTPUT_DIR/fvg-notrail.json','utf8')); const b=r.performance?.basic||{}; console.log((b.profitFactor||0).toFixed(2))")
    total_pnl=$(node -e "const r=JSON.parse(require('fs').readFileSync('$OUTPUT_DIR/fvg-notrail.json','utf8')); const b=r.performance?.basic||{}; console.log((b.totalPnL||0).toFixed(0))")
    echo "  FVG no-trail: Trades=$trades PF=$pf P&L=\$$total_pnl"
    echo "fvg-pullback,20,30,20,0,0,1800000,$trades,0,$pf,$total_pnl,0,0,0" >> "$SUMMARY"
  fi
fi

echo ""
echo "============================================"
echo "  Sweep Complete!"
echo "  Results: $SUMMARY"
echo "============================================"
echo ""

# Print top 10 by profit factor
echo "=== Top 10 by Profit Factor ==="
head -1 "$SUMMARY"
tail -n +2 "$SUMMARY" | sort -t',' -k10 -rn | head -10

echo ""
echo "=== Top 10 by Total P&L ==="
head -1 "$SUMMARY"
tail -n +2 "$SUMMARY" | sort -t',' -k11 -rn | head -10
