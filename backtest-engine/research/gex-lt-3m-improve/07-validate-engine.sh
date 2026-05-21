#!/bin/bash
# Phase 7 — engine validation for each candidate preset.
# Run sequentially (1 at a time) to avoid CPU contention.

set -euo pipefail

cd "$(dirname "$0")/../.."

OUT_DIR=research/gex-lt-3m-improve/output
mkdir -p "$OUT_DIR/engine-runs"

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

PRESETS=("${@:-w12 v3-low-dd v3 v3-balanced v3-max}")

for preset in $PRESETS; do
  OUT="$OUT_DIR/engine-runs/engine-${preset}.json"
  echo ""
  echo "================================================================"
  echo "=== ENGINE preset=$preset → $OUT"
  echo "================================================================"
  START=$(date +%s)
  node index.js "${COMMON[@]}" --glx-preset "$preset" --output-format json --output-path "$OUT" 2>&1 | tail -50 || true
  ELAPSED=$(( $(date +%s) - START ))
  echo "  ⏱  elapsed: ${ELAPSED}s"
  if [ -f "$OUT" ]; then
    node -e "const d = require('./$OUT'); const p = d.performance.summary; console.log(\`  result: \${p.totalTrades} trades, \$\${p.totalPnL.toFixed(0)} PnL, WR \${p.winRate.toFixed(1)}%, PF \${d.performance.basic.profitFactor.toFixed(2)}, Sharpe \${p.sharpeRatio.toFixed(2)}, MaxDD \${p.maxDrawdown.toFixed(2)}%\`);" 2>/dev/null || echo "  (could not parse output JSON)"
  fi
done

echo ""
echo "All engine validations complete."
