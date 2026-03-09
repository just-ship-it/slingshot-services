#!/bin/bash
#
# Parameter Sweep Runner
# Runs strategy configurations through the full backtest engine with 1s exit resolution.
#
# Usage:
#   ./research/parameter-sweep.sh gsb       # GEX Support Bounce sweep
#   ./research/parameter-sweep.sh nle       # NQ-Leads-ES sweep
#   ./research/parameter-sweep.sh all       # Both
#
# Each run goes through the full backtest engine pipeline.
# Sweep period: 2024 (12 months). Best configs then validated on full 2023-2025 range.
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENGINE_DIR="$(dirname "$SCRIPT_DIR")"
RESULTS_DIR="$SCRIPT_DIR/output/sweeps"
mkdir -p "$RESULTS_DIR"

SWEEP_START="2024-01-01"
SWEEP_END="2024-12-31"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

# Helper: extract results from JSON and append to CSV
extract_results() {
  local JSON_FILE="$1"
  local PARAMS="$2"  # comma-separated param values
  local SUMMARY="$3"

  if [ ! -f "$JSON_FILE" ]; then
    echo "  -> FAILED (no output)"
    return 1
  fi

  local ROW
  ROW=$(node -e "
    const r = JSON.parse(require('fs').readFileSync('$JSON_FILE'));
    const s = r.performance?.summary || {};
    const b = r.performance?.basic || {};
    const rk = r.performance?.risk || {};
    const dd = r.performance?.drawdown || {};
    console.log([
      '$PARAMS',
      b.totalTrades || 0,
      (b.winRate || 0).toFixed(2),
      (b.profitFactor || 0).toFixed(3),
      (b.expectancy || 0).toFixed(2),
      (typeof rk.sharpeRatio === 'number' && isFinite(rk.sharpeRatio)) ? rk.sharpeRatio.toFixed(3) : 'N/A',
      (dd.maxDrawdown || s.maxDrawdown || 0).toFixed(2),
      (b.totalPnL || 0).toFixed(2),
      (b.avgWin || 0).toFixed(2),
      (b.avgLoss || 0).toFixed(2)
    ].join(','));
  " 2>/dev/null) || true

  if [ -n "$ROW" ]; then
    echo "$ROW" >> "$SUMMARY"
    echo "  -> $(echo "$ROW" | awk -F, '{
      n=NF; trades=$(n-8); wr=$(n-7); pf=$(n-6); exp=$(n-5); sh=$(n-4); dd=$(n-3);
      printf "trades=%s WR=%s%% PF=%s exp=$%s sharpe=%s dd=%s%%\n", trades, wr, pf, exp, sh, dd
    }')"
  else
    echo "  -> FAILED (extraction error)"
  fi

  rm -f "$JSON_FILE"
}

# ── GEX Support Bounce Sweep ──────────────────────────────────────────────
#
# Round 1: Coarse grid on most impactful params
# - proximityPct: how close to GEX level (defines signal count)
# - target/stop: R:R ratio
# - direction fixed at 'long' (research showed support bounce >> resistance rejection)
# - maxHoldBars fixed at 30 (30 min default)
#
# 5 * 5 * 5 = 125 combos, ~5min each = ~10 hours

run_gex_bounce_sweep() {
  local STRATEGY="gex-support-bounce"
  local SUMMARY="$RESULTS_DIR/${STRATEGY}_sweep_${TIMESTAMP}.csv"

  echo "proximity_pct,target_pts,stop_pts,trades,win_rate,pf,expectancy,sharpe,max_dd,net_pnl,avg_win,avg_loss" > "$SUMMARY"

  echo "=========================================="
  echo "GEX Support Bounce Parameter Sweep"
  echo "Period: $SWEEP_START to $SWEEP_END"
  echo "Direction: long | Max Hold: 30 bars"
  echo "Results: $SUMMARY"
  echo "=========================================="

  local COUNT=0
  local TOTAL=0

  for prox in 0.05 0.08 0.10 0.15 0.20; do
    for target in 10 15 20 25 30; do
      for stop in 6 8 10 12 15; do
        TOTAL=$((TOTAL + 1))
      done
    done
  done

  echo "Total configurations: $TOTAL"
  echo "Estimated time: ~$((TOTAL * 5 / 60)) hours"
  echo ""

  for prox in 0.05 0.08 0.10 0.15 0.20; do
    for target in 10 15 20 25 30; do
      for stop in 6 8 10 12 15; do
        COUNT=$((COUNT + 1))
        local LABEL="prox=${prox}_tgt=${target}_stp=${stop}"
        local JSON_OUT="$RESULTS_DIR/gsb_${LABEL}.json"

        echo "[$COUNT/$TOTAL] $LABEL"

        cd "$ENGINE_DIR"
        node index.js \
          --ticker NQ \
          --strategy gex-support-bounce \
          --start "$SWEEP_START" \
          --end "$SWEEP_END" \
          --timeframe 1m \
          --raw-contracts \
          --proximity-pct "$prox" \
          --target-points "$target" \
          --stop-points "$stop" \
          --direction long \
          --max-hold-bars 30 \
          --output-json "$JSON_OUT" \
          --quiet 2>/dev/null || true

        extract_results "$JSON_OUT" "$prox,$target,$stop" "$SUMMARY"
      done
    done
  done

  echo ""
  echo "=========================================="
  echo "GEX Support Bounce Sweep Complete!"
  echo "Results: $SUMMARY"
  echo ""
  echo "Top 20 by Profit Factor (min 30 trades):"
  echo "=========================================="
  echo "proximity_pct,target_pts,stop_pts,trades,win_rate,pf,expectancy,sharpe,max_dd,net_pnl,avg_win,avg_loss"
  tail -n +2 "$SUMMARY" | awk -F, '$4 >= 30' | sort -t, -k6 -rn | head -20
  echo ""
  echo "Top 20 by Sharpe Ratio (min 30 trades):"
  echo "=========================================="
  tail -n +2 "$SUMMARY" | awk -F, '$4 >= 30 && $8 != "N/A"' | sort -t, -k8 -rn | head -20
}

# ── NQ-Leads-ES Sweep ─────────────────────────────────────────────────────
#
# Round 1: Key params are threshold, hold bars, and GEX regime
# - nqThreshold: signal sensitivity
# - holdBars: how long to hold
# - gexRegime: THE critical filter from research (positive = PF 3-10x)
# - stop/target: 0 = pure time-based exit, or fixed values
#
# 4 * 4 * 3 * 3 * 3 = 432 combos, ~5min each = ~36 hours

run_nq_leads_es_sweep() {
  local STRATEGY="nq-leads-es"
  local SUMMARY="$RESULTS_DIR/${STRATEGY}_sweep_${TIMESTAMP}.csv"

  echo "nq_threshold,hold_bars,gex_regime,stop_pts,target_pts,trades,win_rate,pf,expectancy,sharpe,max_dd,net_pnl,avg_win,avg_loss" > "$SUMMARY"

  echo "=========================================="
  echo "NQ-Leads-ES Parameter Sweep"
  echo "Period: $SWEEP_START to $SWEEP_END"
  echo "Results: $SUMMARY"
  echo "=========================================="

  local COUNT=0
  local TOTAL=0

  for thresh in 0.10 0.15 0.20 0.25; do
    for hold in 3 5 7 10; do
      for regime in any positive positive_or_neutral; do
        for stop in 0 5 10; do
          for target in 0 10 15; do
            TOTAL=$((TOTAL + 1))
          done
        done
      done
    done
  done

  echo "Total configurations: $TOTAL"
  echo "Estimated time: ~$((TOTAL * 5 / 60)) hours"
  echo ""

  for thresh in 0.10 0.15 0.20 0.25; do
    for hold in 3 5 7 10; do
      for regime in any positive positive_or_neutral; do
        for stop in 0 5 10; do
          for target in 0 10 15; do
            COUNT=$((COUNT + 1))
            local LABEL="thr=${thresh}_hold=${hold}_reg=${regime}_stp=${stop}_tgt=${target}"
            local JSON_OUT="$RESULTS_DIR/nle_${LABEL}.json"

            echo "[$COUNT/$TOTAL] $LABEL"

            cd "$ENGINE_DIR"
            node index.js \
              --ticker ES \
              --strategy nq-leads-es \
              --start "$SWEEP_START" \
              --end "$SWEEP_END" \
              --timeframe 1m \
              --nq-threshold "$thresh" \
              --hold-bars "$hold" \
              --gex-regime "$regime" \
              --stop-points "$stop" \
              --target-points "$target" \
              --output-json "$JSON_OUT" \
              --quiet 2>/dev/null || true

            extract_results "$JSON_OUT" "$thresh,$hold,$regime,$stop,$target" "$SUMMARY"
          done
        done
      done
    done
  done

  echo ""
  echo "=========================================="
  echo "NQ-Leads-ES Sweep Complete!"
  echo "Results: $SUMMARY"
  echo ""
  echo "Top 20 by Profit Factor (min 20 trades):"
  echo "=========================================="
  echo "nq_threshold,hold_bars,gex_regime,stop_pts,target_pts,trades,win_rate,pf,expectancy,sharpe,max_dd,net_pnl,avg_win,avg_loss"
  tail -n +2 "$SUMMARY" | awk -F, '$6 >= 20' | sort -t, -k8 -rn | head -20
  echo ""
  echo "Top 20 by Sharpe Ratio (min 20 trades):"
  echo "=========================================="
  tail -n +2 "$SUMMARY" | awk -F, '$6 >= 20 && $10 != "N/A"' | sort -t, -k10 -rn | head -20
}

# ── Main ───────────────────────────────────────────────────────────────────

case "${1:-all}" in
  gex-support-bounce|gsb)
    run_gex_bounce_sweep
    ;;
  nq-leads-es|nle)
    run_nq_leads_es_sweep
    ;;
  all)
    run_gex_bounce_sweep
    run_nq_leads_es_sweep
    ;;
  *)
    echo "Usage: $0 {gex-support-bounce|gsb|nq-leads-es|nle|all}"
    exit 1
    ;;
esac
