/**
 * Pre-fill-extreme cancel detection.
 *
 * Pure function used by the trade-orchestrator's pending-limit watcher.
 * Decides whether a pending limit order with cancelOnPreFillExtreme should
 * be cancelled based on the latest 1-bar high/low. Mirrors the same-named
 * flag in backtest-engine/src/execution/trade-simulator.js — invalidates a
 * structural-retrace setup when price runs past the bar extreme before the
 * limit fills.
 *
 * Originally introduced for the ls-flip-trigger-bar strategy; the flag is
 * opt-in per signal so other strategies remain unaffected.
 */

/**
 * @param {'buy'|'sell'} direction
 * @param {number} stopLoss
 * @param {number} takeProfit
 * @param {number|null} high - latest bar high (may be null on quote-only ticks)
 * @param {number|null} low  - latest bar low  (may be null on quote-only ticks)
 * @returns {string|null} reason string when a cancel should fire, else null
 */
export function shouldCancelOnPreFillExtreme(direction, stopLoss, takeProfit, high, low) {
  if (direction === 'buy') {
    if (high != null && high >= takeProfit) return `TP-first (high ${high} >= takeProfit ${takeProfit})`;
    if (low != null && low <= stopLoss) return `SL-first (low ${low} <= stopLoss ${stopLoss})`;
  } else if (direction === 'sell') {
    if (low != null && low <= takeProfit) return `TP-first (low ${low} <= takeProfit ${takeProfit})`;
    if (high != null && high >= stopLoss) return `SL-first (high ${high} >= stopLoss ${stopLoss})`;
  }
  return null;
}
