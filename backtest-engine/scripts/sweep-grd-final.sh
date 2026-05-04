#!/usr/bin/env bash
# Final-tune sweep — combine the best filters from variants sweep.
set -u
cd "$(dirname "$0")/.."

OUT=research/output/grd-final-$(date +%s).csv
echo "label,trades,pnl,pf,sharpe,max_dd,win_rate,avg_trade,calmar" > "$OUT"

run_one() {
  local label="$1" extra="$2"
  echo "[$(date +%H:%M:%S)] running $label" >&2
  local result
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

# Combinations to find optimal
run_one "morning_full+cross_down"        '--grd-hours 9,10,11,12,13,14,15,16 --grd-enable-cross-down'
run_one "morning_full+strong_pos_only"   '--grd-hours 9,10,11,12,13,14,15,16 --grd-regimes strong_positive'
run_one "11_to_15+cross_down"            '--grd-hours 11,12,13,14,15 --grd-enable-cross-down'
run_one "11_to_15+strong_pos_only"       '--grd-hours 11,12,13,14,15 --grd-regimes strong_positive'
run_one "default+strong_pos_only"        '--grd-hours 10,11,12,15 --grd-regimes strong_positive'
run_one "11_to_15+strong_pos+cross_down" '--grd-hours 11,12,13,14,15 --grd-regimes strong_positive --grd-enable-cross-down'
run_one "morning_full+pos_strong+xdown"  '--grd-hours 9,10,11,12,13,14,15,16 --grd-regimes positive,strong_positive --grd-enable-cross-down'
run_one "h15_only+strong_pos"            '--grd-hours 15 --grd-regimes strong_positive'
run_one "h15_only+cross_down"            '--grd-hours 15 --grd-enable-cross-down'
echo "---"
echo "Final-tune sweep complete: $OUT"
