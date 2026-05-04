#!/usr/bin/env bash
# Param sweep for gamma-regime-drift strategy.
# Each row: target  stop  description
# Captures Total P&L, PF, Sharpe, MaxDD, WR for each combo.

set -u
cd "$(dirname "$0")/.."

OUT=research/output/grd-sweep-$(date +%s).csv
echo "label,target,stop,trades,pnl,pf,sharpe,max_dd,win_rate,avg_trade,calmar" > "$OUT"

run_one() {
  local label="$1" tgt="$2" stp="$3"
  local result
  result=$(node index.js --ticker NQ --strategy gamma-regime-drift --timeframe 15m \
    --raw-contracts --gex-dir data/gex/nq-cbbo \
    --start 2025-01-13 --end 2026-04-23 \
    --target-points "$tgt" --stop-loss-points "$stp" 2>&1)
  local trades pnl pf sharpe mdd wr avg cal
  trades=$(echo "$result" | grep -oP 'Total Trades\s+\S+\s+\K[0-9]+' | head -1)
  pnl=$(echo "$result"   | grep -oP 'Total P&L\s+\S+\s+\K\$[\-0-9,]+' | head -1 | tr -d '$,')
  pf=$(echo "$result"    | grep -oP 'Profit Factor\s+\S+\s+\K[0-9\.]+' | head -1)
  sharpe=$(echo "$result"| grep -oP 'Sharpe Ratio\s+\S+\s+\K[\-0-9\.]+' | head -1)
  mdd=$(echo "$result"   | grep -oP 'Max Drawdown\s+\S+\s+\K[0-9\.]+' | head -1)
  wr=$(echo "$result"    | grep -oP 'Win Rate\s+\S+\s+\K[0-9\.]+' | head -1)
  avg=$(echo "$result"   | grep -oP 'Average Trade\s+\S+\s+\K\$[\-0-9\.]+' | head -1 | tr -d '$')
  cal=$(echo "$result"   | grep -oP 'Calmar Ratio\s+\S+\s+\K[\-0-9\.]+' | head -1)
  echo "$label,$tgt,$stp,$trades,$pnl,$pf,$sharpe,$mdd,$wr,$avg,$cal" | tee -a "$OUT"
}

# Hold-to-maxhold (no SL/TP triggering)
run_one "no_sl_no_tp"      500 500
# Wide stop, target on
run_one "tp30_sl500"        30 500
run_one "tp40_sl500"        40 500
run_one "tp25_sl500"        25 500
run_one "tp20_sl500"        20 500
# With stop
run_one "tp30_sl30"         30  30
run_one "tp30_sl40"         30  40
run_one "tp30_sl50"         30  50
run_one "tp30_sl60"         30  60
run_one "tp40_sl60"         40  60
run_one "tp50_sl60"         50  60
run_one "tp50_sl80"         50  80
# Wider
run_one "tp80_sl60"         80  60
run_one "tp80_sl80"         80  80
run_one "tp100_sl100"      100 100
echo "---"
echo "Sweep complete. Results: $OUT"
