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
 * @param {'buy'|'sell'|'long'|'short'} direction - the orchestrator stores
 *   pending.direction as 'long'/'short' (from normalizeDirection), while the
 *   backtest simulator uses 'buy'/'sell'. Accept BOTH vocabularies — passing
 *   'long'/'short' here previously matched neither branch and silently returned
 *   null, so the live cancel never fired.
 * @param {number} stopLoss
 * @param {number} takeProfit
 * @param {number|null} high - latest bar high (may be null on quote-only ticks)
 * @param {number|null} low  - latest bar low  (may be null on quote-only ticks)
 * @returns {string|null} reason string when a cancel should fire, else null
 */
export function shouldCancelOnPreFillExtreme(direction, stopLoss, takeProfit, high, low) {
  const isBuy = direction === 'buy' || direction === 'long';
  const isSell = direction === 'sell' || direction === 'short';
  if (isBuy) {
    if (high != null && high >= takeProfit) return `TP-first (high ${high} >= takeProfit ${takeProfit})`;
    if (low != null && low <= stopLoss) return `SL-first (low ${low} <= stopLoss ${stopLoss})`;
  } else if (isSell) {
    if (low != null && low <= takeProfit) return `TP-first (low ${low} <= takeProfit ${takeProfit})`;
    if (high != null && high >= stopLoss) return `SL-first (high ${high} >= stopLoss ${stopLoss})`;
  }
  return null;
}
