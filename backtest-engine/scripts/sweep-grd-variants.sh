#!/usr/bin/env bash
# Variant sweep for gamma-regime-drift: hours, regimes, short side.
# Uses --grd-hours, --grd-regimes, --grd-enable-cross-down CLI flags.
# Always with --target-points 500 --stop-loss-points 500 (max-hold-only) since
# that's the best baseline so far.

set -u
cd "$(dirname "$0")/.."

OUT=research/output/grd-variants-$(date +%s).csv
echo "label,trades,pnl,pf,sharpe,max_dd,win_rate,avg_trade,calmar" > "$OUT"

run_one() {
  local label="$1" extra="$2"
  local result
  echo "[$(date +%H:%M:%S)] running $label" >&2
  result=$(node index.js --ticker NQ --strategy gamma-regime-drift --timeframe 15m \
    --raw-contracts --gex-dir data/gex/nq-cbbo \
    --start 2025-01-13 --end 2026-04-23 \
    --target-points 500 --stop-loss-points 500 $extra 2>&1)
  local trades pnl pf sharpe mdd wr avg cal
  trades=$(echo "$result" | grep -oP 'Total Trades\s+\S+\s+\K[0-9]+' | head -1)
  pnl=$(echo "$result"   | grep -oP 'Total P&L\s+\S+\s+\K\$[\-0-9,]+' | head -1 | tr -d '$,')
  pf=$(echo "$result"    | grep -oP 'Profit Factor\s+\S+\s+\K[0-9\.]+' | head -1)
  sharpe=$(echo "$result"| grep -oP 'Sharpe Ratio\s+\S+\s+\K[\-0-9\.]+' | head -1)
  mdd=$(echo "$result"   | grep -oP 'Max Drawdown\s+\S+\s+\K[0-9\.]+' | head -1)
  wr=$(echo "$result"    | grep -oP 'Win Rate\s+\S+\s+\K[0-9\.]+' | head -1)
  avg=$(echo "$result"   | grep -oP 'Average Trade\s+\S+\s+\K\$[\-0-9\.]+' | head -1 | tr -d '$')
  cal=$(echo "$result"   | grep -oP 'Calmar Ratio\s+\S+\s+\K[\-0-9\.]+' | head -1)
  echo "$label,$trades,$pnl,$pf,$sharpe,$mdd,$wr,$avg,$cal" | tee -a "$OUT"
}

# Hours
run_one "hours_default"     '--grd-hours 10,11,12,15'
run_one "hours_just_11_12"  '--grd-hours 11,12'
run_one "hours_11_to_15"    '--grd-hours 11,12,13,14,15'
run_one "hours_10_to_12"    '--grd-hours 10,11,12'
run_one "hours_15_only"     '--grd-hours 15'
run_one "hours_morning_full" '--grd-hours 9,10,11,12,13,14,15,16'
# Regimes
run_one "regime_strong_pos_only" '--grd-regimes strong_positive'
run_one "regime_pos_neutral"     '--grd-regimes positive,strong_positive,neutral'
# Short side
run_one "with_cross_down"        '--grd-enable-cross-down'
# Combined: best directional setup
run_one "hours_11_12_strong_pos" '--grd-hours 11,12 --grd-regimes strong_positive'

echo "---"
echo "Variants sweep complete. Results: $OUT"
