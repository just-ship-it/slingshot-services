/**
 * Swing Reversal Strategy
 *
 * Trades confirmed swing points on 1-minute NQ candles. An 8-bar confirmed
 * swing high triggers a SELL; an 8-bar confirmed swing low triggers a BUY.
 * Uses limit orders at the confirmation candle's close (no slippage) with a
 * fixed stop distance from fill price and trailing stop exits (no fixed take
 * profit target). Orders cancelled after a configurable timeout if not filled.
 *
 * Validated both in-sample (Jan-Jul 2025: PF 1.32, 78.6% WR) and
 * out-of-sample (Jul-Dec 2024: PF 1.17, 77.9% WR).
 *
 * Key finding: no feature filter improves upon simply waiting for full
 * 8-bar confirmation. The edge comes from the swing structure itself.
 */

import { BaseStrategy } from './base-strategy.js';
import { isValidCandle, roundTo } from './strategy-utils.js';

export class SwingReversalStrategy extends BaseStrategy {
  static getDataRequirements() {
    return {
      candles: {
        baseSymbol: 'NQ',
        quoteSymbols: ['CME_MINI:NQ1!']
      },
      gex: false,
      lt: false,
      tradier: false,
      ivSkew: false
    };
  }

  constructor(params = {}) {
    super(params);

    this.defaultParams = {
      // Swing detection
      swingLookback: 8,           // Bars each side for swing confirmation

      // Risk management
      stopDistance: 30,            // Fixed stop distance in points from fill price
      limitBuffer: 0,             // Points beyond close for limit price (better entry, fewer fills)
      maxHoldBars: 240,           // Force exit after N bars in trade

      // Signal management
      signalCooldownMs: 0,        // No cooldown — trade simulator enforces 1 position at a time
      limitOrderTimeout: 3,       // Cancel unfilled limit orders after N candles

      // Direction filtering
      allowLongs: true,
      allowShorts: true,

      // Symbol configuration
      tradingSymbol: 'NQ',
      defaultQuantity: 1,

      // Trailing stop defaults (can be overridden by --use-trailing-stop CLI flags)
      trailingTrigger: 8,
      trailingOffset: 3,

      // Debug
      debug: false
    };

    this.params = { ...this.defaultParams, ...params };
  }

  /**
   * Evaluate if a swing reversal signal should be generated.
   *
   * The current candle is the confirmation bar. The pivot candidate sits
   * `swingLookback` bars back. We need at least `2 * swingLookback + 1`
   * candles in the historical window.
   */
  evaluateSignal(candle, prevCandle, marketData, options = {}) {
    const debug = options.debug || this.params.debug;

    if (!isValidCandle(candle)) {
      return null;
    }

    // Check cooldown
    const cooldownMs = options.cooldownMs || this.params.signalCooldownMs;
    if (cooldownMs > 0 && !this.checkCooldown(candle.timestamp, cooldownMs)) {
      return null;
    }

    const historicalCandles = options.historicalCandles;
    const lookback = this.params.swingLookback;
    const windowSize = 2 * lookback + 1;

    if (!historicalCandles || historicalCandles.length < windowSize) {
      return null;
    }

    // The pivot candidate is at index length - lookback - 1
    // (lookback bars before the current/confirmation bar)
    const pivotIndex = historicalCandles.length - lookback - 1;
    if (pivotIndex < 0) return null;

    const pivotCandle = historicalCandles[pivotIndex];

    // Build the window around the pivot: [pivotIndex - lookback, pivotIndex + lookback]
    const windowStart = pivotIndex - lookback;
    if (windowStart < 0) return null;

    let isSwingHigh = true;
    let isSwingLow = true;

    // Check all bars in the window against the pivot
    for (let i = windowStart; i <= pivotIndex + lookback; i++) {
      if (i === pivotIndex) continue;

      const c = historicalCandles[i];

      // Swing HIGH: pivot high must be strictly > all other highs
      if (c.high >= pivotCandle.high) {
        isSwingHigh = false;
      }

      // Swing LOW: pivot low must be strictly < all other lows
      if (c.low <= pivotCandle.low) {
        isSwingLow = false;
      }

      // Early exit if neither can be true
      if (!isSwingHigh && !isSwingLow) return null;
    }

    // Require wick on the pivot candle
    if (isSwingHigh) {
      const upperWick = pivotCandle.high - Math.max(pivotCandle.open, pivotCandle.close);
      if (upperWick <= 0) isSwingHigh = false;
    }

    if (isSwingLow) {
      const lowerWick = Math.min(pivotCandle.open, pivotCandle.close) - pivotCandle.low;
      if (lowerWick <= 0) isSwingLow = false;
    }

    // If both (extremely rare with lookback=8) → skip
    if (isSwingHigh && isSwingLow) {
      if (debug) console.log('[SWING_REVERSAL] Both swing high and low detected — skipping');
      return null;
    }

    if (!isSwingHigh && !isSwingLow) return null;

    // Direction
    let side;
    let swingType;
    let pivotPrice;

    if (isSwingHigh && this.params.allowShorts) {
      side = 'sell';
      swingType = 'swing_high';
      pivotPrice = pivotCandle.high;
    } else if (isSwingLow && this.params.allowLongs) {
      side = 'buy';
      swingType = 'swing_low';
      pivotPrice = pivotCandle.low;
    } else {
      return null; // Direction filtered out
    }

    if (debug) {
      console.log(`[SWING_REVERSAL] ${swingType.toUpperCase()} confirmed | pivot=${pivotPrice} | entry=${candle.close} | side=${side}`);
    }

    this.updateLastSignalTime(candle.timestamp);

    const buffer = this.params.limitBuffer || 0;
    // For buy: limit below close (wait for dip). For sell: limit above close (wait for pop).
    const entryPrice = side === 'buy'
      ? candle.close - buffer
      : candle.close + buffer;
    const stopDistance = this.params.stopDistance;

    // Placeholder stop — will be recalculated from actual fill price by trade simulator
    const stopLoss = side === 'buy'
      ? entryPrice - stopDistance
      : entryPrice + stopDistance;

    return {
      strategy: 'SWING_REVERSAL',
      side,
      action: 'place_limit',
      symbol: this.params.tradingSymbol,
      price: roundTo(entryPrice),
      stop_loss: roundTo(stopLoss),
      take_profit: null,  // No fixed target — trailing handles exits
      stopDistance,        // Trade simulator recalculates stop from actual fill price
      trailing_trigger: this.params.trailingTrigger,
      trailing_offset: this.params.trailingOffset,
      maxHoldBars: this.params.maxHoldBars,
      timeoutCandles: this.params.limitOrderTimeout,
      quantity: this.params.defaultQuantity,
      timestamp: new Date(candle.timestamp).toISOString(),
      metadata: {
        swing_type: swingType,
        pivot_price: roundTo(pivotPrice),
        pivot_timestamp: new Date(pivotCandle.timestamp).toISOString(),
        lookback,
        entry_slip: roundTo(Math.abs(entryPrice - pivotPrice))
      }
    };
  }

  getName() {
    return 'SWING_REVERSAL';
  }

  getDescription() {
    return 'Swing Reversal — trades confirmed 8-bar swing points with trailing stop exits';
  }

  getRequiredMarketData() {
    return []; // No external market data required
  }
}

export default SwingReversalStrategy;
