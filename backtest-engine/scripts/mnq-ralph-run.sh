#!/usr/bin/env bash
# mnq-ralph-run.sh — Wrapper for MNQ Adaptive Scalper backtests
# Used by the Ralph Loop to run backtests and extract machine-readable summaries.
#
# Usage:
#   bash scripts/mnq-ralph-run.sh --start 2024-01-01 --end 2024-12-31 --stop-points 20 [...]
#
# All arguments are forwarded to the backtest engine with fixed flags:
#   --ticker NQ --strategy mnq --quiet --output-json /tmp/mnq-ralph-results.json

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENGINE_DIR="$(dirname "$SCRIPT_DIR")"
OUTPUT_JSON="/tmp/mnq-ralph-results.json"

# Remove stale output
rm -f "$OUTPUT_JSON"

# Run backtest engine with all forwarded params
node "$ENGINE_DIR/index.js" \
  --ticker NQ \
  --strategy mnq \
  --quiet \
  --output-json "$OUTPUT_JSON" \
  "$@"

# Check if output was created
if [ ! -f "$OUTPUT_JSON" ]; then
  echo "ERROR: Backtest produced no output file"
  exit 1
fi

# Post-process JSON to extract concise summary
node -e '
const fs = require("fs");
const data = JSON.parse(fs.readFileSync("/tmp/mnq-ralph-results.json", "utf8"));

const perf = data.performance || {};
const trades = data.trades || [];

// --- Overall metrics ---
// Trade P&L is in pointsPnL (points), netPnL (dollar), or grossPnL (dollar)
const pnl = (t) => t.pointsPnL ?? t.pnl ?? 0;
const totalTrades = trades.length;
const wins = trades.filter(t => pnl(t) > 0).length;
const losses = trades.filter(t => pnl(t) <= 0).length;
const wr = totalTrades > 0 ? (wins / totalTrades * 100).toFixed(1) : "0.0";
const totalPnL = trades.reduce((s, t) => s + pnl(t), 0);
const avgWin = wins > 0 ? trades.filter(t => pnl(t) > 0).reduce((s, t) => s + pnl(t), 0) / wins : 0;
const avgLoss = losses > 0 ? trades.filter(t => pnl(t) <= 0).reduce((s, t) => s + pnl(t), 0) / losses : 0;
const grossWins = trades.filter(t => pnl(t) > 0).reduce((s, t) => s + pnl(t), 0);
const grossLosses = Math.abs(trades.filter(t => pnl(t) <= 0).reduce((s, t) => s + pnl(t), 0));
const pf = grossLosses > 0 ? grossWins / grossLosses : (grossWins > 0 ? 999 : 0);
const expectancy = totalTrades > 0 ? totalPnL / totalTrades : 0;
const maxDDPct = perf.summary?.maxDrawdown || perf.drawdown?.maxDrawdown || 0;
const maxDDDollars = perf.basic?.grossLoss ? Math.abs(perf.basic.largestLoss) : 0;

// --- Exit breakdown ---
const exitCounts = {};
const exitPnL = {};
for (const t of trades) {
  const reason = t.exitReason || t.exit_reason || "unknown";
  exitCounts[reason] = (exitCounts[reason] || 0) + 1;
  exitPnL[reason] = (exitPnL[reason] || 0) + pnl(t);
}

// --- Daily aggregates (6 PM EST cutoff for trading day) ---
function tradingDay(ts) {
  const d = new Date(ts);
  // Simplified EST offset (EDT = -4, EST = -5)
  const month = d.getUTCMonth();
  const offset = (month >= 3 && month <= 10) ? 4 : 5;
  const estMs = d.getTime() - offset * 3600000;
  const estDate = new Date(estMs);
  const h = estDate.getUTCHours();
  if (h >= 18) {
    const next = new Date(estMs + 86400000);
    return next.toISOString().slice(0, 10);
  }
  return estDate.toISOString().slice(0, 10);
}

const dailyPnL = {};
for (const t of trades) {
  const day = tradingDay(t.exitTime || t.exit_time || t.entryTime || t.entry_time);
  dailyPnL[day] = (dailyPnL[day] || 0) + pnl(t);
}

const days = Object.keys(dailyPnL).sort();
const numDays = days.length;
const dailyValues = days.map(d => dailyPnL[d]);
const daysPositive = dailyValues.filter(v => v > 0).length;
const daysNegative = dailyValues.filter(v => v <= 0).length;
const avgDailyPnL = numDays > 0 ? dailyValues.reduce((s, v) => s + v, 0) / numDays : 0;
const worstDay = numDays > 0 ? Math.min(...dailyValues) : 0;
const bestDay = numDays > 0 ? Math.max(...dailyValues) : 0;

// Use strategy params to check target/loss limits
const params = data.config?.strategyParams || {};
const dailyTarget = params.dailyTarget || 50;
const dailyLossLimit = params.dailyLossLimit || -25;
const daysHitTarget = dailyValues.filter(v => v >= dailyTarget).length;
const daysHitLossLimit = dailyValues.filter(v => v <= dailyLossLimit).length;

// --- Print summary ---
console.log("=== MNQ ADAPTIVE SCALPER BACKTEST SUMMARY ===");
console.log("");
console.log("OVERALL:");
console.log("  Trades: " + totalTrades + " | Wins: " + wins + " | Losses: " + losses);
console.log("  WR: " + wr + "% | PF: " + pf.toFixed(2) + " | Expectancy: " + expectancy.toFixed(2) + " pts");
console.log("  Total P&L: " + totalPnL.toFixed(1) + " pts | Avg Win: " + avgWin.toFixed(2) + " | Avg Loss: " + avgLoss.toFixed(2));
console.log("  Max DD: " + maxDDPct.toFixed(2) + "% | Largest Loss: $" + maxDDDollars);
console.log("");
console.log("EXIT BREAKDOWN:");
for (const [reason, count] of Object.entries(exitCounts).sort((a, b) => b[1] - a[1])) {
  console.log("  " + reason + ": " + count + " trades, P&L=" + (exitPnL[reason] || 0).toFixed(1) + " pts");
}
console.log("");
console.log("DAILY AGGREGATES:");
console.log("  Trading Days: " + numDays);
console.log("  Days Positive: " + daysPositive + " | Days Negative: " + daysNegative);
console.log("  Days Hit Target (>=" + dailyTarget + "): " + daysHitTarget);
console.log("  Days Hit Loss Limit (<=" + dailyLossLimit + "): " + daysHitLossLimit);
console.log("  Avg Daily P&L: " + avgDailyPnL.toFixed(2) + " pts");
console.log("  Best Day: " + bestDay.toFixed(1) + " pts | Worst Day: " + worstDay.toFixed(1) + " pts");
console.log("");
console.log("PARAMS: stop=" + (params.stopPoints || "?") + " soft=" + (params.softStopPoints || 0) + " target=" + (params.targetPoints || "?") + " trail=" + (params.trailingTrigger || "?") + "/" + (params.trailingOffset || "?") + " prox=" + (params.proximity || "?") + " cooldown=" + (params.signalCooldownMs || "?") + "ms daily_limit=" + (params.dailyLossLimit || "?") + "/" + (params.dailyTarget || "?"));
'
