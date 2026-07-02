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
/**
 * Pick the high/low to evaluate, using ONLY price action SINCE the order was
 * placed. price.update carries the rolling 1m bar's high/low; a bar that was
 * already in progress at placement includes ticks from BEFORE the order existed
 * — for a tight bracket that pre-placement range straddles both stop and
 * target, so using it cancels the order on the very first tick. Rule:
 *   - bar STARTED at/after placement  → fully post-placement, use its high/low.
 *   - bar in progress at placement (or unknown bar start) → use only the live
 *     price (close), which is "now" and therefore strictly after placement.
 *
 * @param {{barStartMs:number|null, placedAtMs:number|null, high:number|null, low:number|null, close:number|null}} p
 * @returns {{high:number|null, low:number|null}}
 */
export function effectivePreFillExtremes({ barStartMs, placedAtMs, high, low, close }) {
  const fullyAfterPlacement =
    barStartMs != null && placedAtMs != null && barStartMs >= placedAtMs;
  if (fullyAfterPlacement) {
    return { high: high ?? null, low: low ?? null };
  }
  return { high: close ?? null, low: close ?? null };
}

/**
 * Adverse-LS-flip cancel decision. ls-flip-trigger-bar enters on an LS flip
 * (BULLISH → long, BEARISH → short — the signal-generator's sentiment→state
 * mapping in multi-strategy-engine.js). A pending lstb limit is invalidated
 * when the LS flips back the OPPOSITE way before the limit fills, mirroring
 * the backtest's adverseFlipCancelTs (the next LS flip, which always
 * alternates state). Accepts both 'long'/'short' and 'buy'/'sell'.
 *
 * @param {'buy'|'sell'|'long'|'short'} direction - pending order direction.
 * @param {string} sentiment - LS_STATUS sentiment ('BULLISH'|'BEARISH').
 * @returns {boolean} true when the flip is adverse to the pending direction.
 */
export function shouldCancelOnAdverseLsFlip(direction, sentiment) {
  const s = String(sentiment || '').toUpperCase();
  if (s !== 'BULLISH' && s !== 'BEARISH') return false;
  const isLong = direction === 'buy' || direction === 'long';
  const isShort = direction === 'sell' || direction === 'short';
  if (!isLong && !isShort) return false;
  // Long is invalidated by a BEARISH flip; short by a BULLISH flip.
  return (isLong && s === 'BEARISH') || (isShort && s === 'BULLISH');
}

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
