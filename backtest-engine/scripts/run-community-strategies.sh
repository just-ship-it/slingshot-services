#!/bin/bash
# Run all community strategy backtests sequentially
# Results saved to backtest-engine/ directory

cd "$(dirname "$0")/.."

echo "============================================"
echo "Community Strategy Backtests"
echo "NQ: 2023-01-01 to 2025-12-25 (~3 years)"
echo "============================================"

strategies=(
  "gap-fill:gap-fill-nq-results.json"
  "daily-level-sweep:daily-level-sweep-nq-results.json"
  "vwap-bounce:vwap-bounce-nq-results.json"
  "session-transition:session-transition-nq-results.json"
  "value-area-80:va80-nq-results.json"
)

for item in "${strategies[@]}"; do
  IFS=':' read -r strategy outfile <<< "$item"
  echo ""
  echo ">>> Running $strategy ..."
  echo ">>> Output: $outfile"
  echo ""
  node index.js \
    --ticker NQ \
    --start 2023-01-01 \
    --end 2025-12-25 \
    --strategy "$strategy" \
    --timeframe 1m \
    --output-json "$outfile" 2>&1 | grep -E "(Trades|Win Rate|Profit Factor|P&L|Sharpe|Drawdown|totalTrades|winRate|Backtest completed|Results saved|Error|Cannot)"
  echo ">>> $strategy complete"
  echo ""
done

echo "============================================"
echo "All backtests complete!"
echo "============================================"
