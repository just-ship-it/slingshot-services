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

/**
 * Full per-order decision for the adverse-LS-flip watcher: given a pending
 * order and an LS_STATUS flip, should this order be cancelled? Pure — the
 * index.js loop applies this to every pending order and performs the actual
 * cancel/telemetry on true.
 *
 * @param {object} pending - pendingOrders entry ({cancelOnAdverseLsFlip,
 *   cancelRequested, action, signalId, direction, adverseFlipCreatedTs, underlying}).
 * @param {string} product - LS_STATUS product (already uppercased), e.g. 'NQ'.
 * @param {string} sentiment - LS_STATUS sentiment ('BULLISH'|'BEARISH').
 * @param {number|null} flipTsMs - flip timestamp in ms (null when unknown).
 * @returns {boolean}
 */
export function shouldCancelPendingOnFlip(pending, product, sentiment, flipTsMs) {
  if (!pending || !pending.cancelOnAdverseLsFlip) return false;
  if (pending.cancelRequested) return false;
  // Working entry orders only (resting limit OR resting stop entry) — a
  // place_market entry never rests, so there is nothing to cancel.
  if (pending.action !== 'place_limit' && pending.action !== 'place_stop') return false;
  if (!pending.signalId) return false;
  if (pending.underlying !== product) return false;
  if (!shouldCancelOnAdverseLsFlip(pending.direction, sentiment)) return false;
  // Only a flip strictly AFTER the one that created the order counts — a
  // stale/replayed flip (or the creating flip itself) must not self-cancel.
  if (flipTsMs != null && pending.adverseFlipCreatedTs != null &&
      flipTsMs <= pending.adverseFlipCreatedTs) return false;
  return true;
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

/**
 * Cancel-on-close-beyond: sanitize the opt-in signal field.
 *
 * Signal contract (opt-in; absent/malformed → feature off for that signal):
 *   cancelOnCloseBeyond: { price: <number>, side: 'above'|'below' }
 * meaning "cancel my working entry order if a 1m candle CLOSES beyond
 * `price` in direction `side`". Used by fvg-bear to kill a resting limit
 * when a 1m close exceeds the gap-invalidation level.
 *
 * @returns {{price:number, side:'above'|'below'}|null}
 */
export function normalizeCancelOnCloseBeyond(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const price = Number(raw.price);
  const side = String(raw.side || '').toLowerCase();
  if (!Number.isFinite(price)) return null;
  if (side !== 'above' && side !== 'below') return null;
  return { price, side };
}

/**
 * Full per-order decision for the cancel-on-close-beyond watcher, driven by
 * 1m candle.close bus messages (NOT price.update ticks — the whole point is
 * bar-CLOSE confirmation; intra-bar wicks through the level must not cancel).
 *
 * Trigger-bar guard: only bars that CLOSE strictly after the order was placed
 * count. candle.close carries the bar-START timestamp; the bar's close happens
 * at barStart + 60s. This keeps the signal's own trigger bar (whose close the
 * strategy already evaluated before emitting the signal) from self-cancelling
 * when its candle.close event races the trade.signal through the bus. When the
 * bar timestamp is missing/unparseable we evaluate anyway — data-service
 * always stamps it, and failing open here only risks cancelling an order whose
 * setup is invalidated per the strategy's own definition.
 *
 * @param {object} pending - pendingOrders entry ({cancelOnCloseBeyond,
 *   cancelRequested, action, signalId, underlying, requestedAt}).
 * @param {object} bar - { product, close, barStartMs } from candle.close
 *   (product = base symbol e.g. 'NQ'; barStartMs = bar-start epoch ms | null).
 * @returns {boolean} true when the pending order should be cancelled.
 */
export function shouldCancelOnCloseBeyond(pending, { product, close, barStartMs }) {
  if (!pending) return false;
  const cfg = normalizeCancelOnCloseBeyond(pending.cancelOnCloseBeyond);
  if (!cfg) return false;
  if (pending.cancelRequested) return false;
  if (pending.action !== 'place_limit' && pending.action !== 'place_stop') return false;
  if (!pending.signalId) return false;
  if (!product || pending.underlying !== product) return false;
  const c = Number(close);
  if (!Number.isFinite(c)) return false;
  if (Number.isFinite(barStartMs) && Number.isFinite(pending.requestedAt)) {
    const barEndMs = barStartMs + 60_000;
    if (barEndMs <= pending.requestedAt) return false; // bar closed at/before placement
  }
  return cfg.side === 'above' ? c > cfg.price : c < cfg.price;
}
