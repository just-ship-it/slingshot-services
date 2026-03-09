/**
 * Impulse FVG Strategy
 *
 * Detects abnormally large 1-minute candles (impulse candles) occurring OUTSIDE
 * of scheduled news events, then trades based on Fair Value Gap (FVG) context:
 *
 * 1. FVG Pullback Continuation: When an impulse candle creates an FVG (3-candle
 *    gap where candle[i-2].high < candle[i].low or vice versa), wait for price
 *    to retrace into the FVG zone, then enter in the impulse direction with a
 *    limit order at the FVG boundary. Structural stop at FVG opposite edge.
 *
 * 2. No-FVG Structural Fade: When an impulse candle does NOT create an FVG
 *    (immediate retrace), fade it with stop at the impulse extreme.
 *
 * Sweep-optimized results (Jun 2023 - Dec 2025, NQ, RTH):
 *   No-FVG Fade (default): PF=2.53, WR=71.9%, +$136,670, MaxDD=1.17% (1,318 trades)
 *   Best PF config:        PF=2.72, WR=72.9%, +$123,955, MaxDD=1.35% (1,117 trades, 30m cd)
 *   Best P&L config:       PF=2.35, WR=70.0%, +$218,385, MaxDD=1.31% (2,099 trades, 5m cd)
 *   FVG Pullback: Marginal edge (PF ~1.02-1.19), not recommended as primary mode.
 *
 * All parameters are configurable for parameter sweep optimization.
 */

import { BaseStrategy } from './base-strategy.js';
import { isValidCandle, roundTo } from './strategy-utils.js';

export class ImpulseFVGStrategy extends BaseStrategy {
  static getDataRequirements() {
    return {
      candles: { baseSymbol: 'NQ', quoteSymbols: ['CME_MINI:NQ1!'] },
      gex: false,
      lt: false,
      tradier: false,
      ivSkew: false
    };
  }

  constructor(params = {}) {
    super(params);

    this.defaultParams = {
      // Impulse detection
      minBodyPoints: 25,           // Minimum absolute body size to qualify as impulse
      minRangePoints: 0,           // Minimum candle range (0 = no range filter)

      // Mode: 'both', 'fvg-pullback', 'no-fvg-fade'
      mode: 'no-fvg-fade',

      // FVG Pullback parameters
      fvgPullbackEnabled: false,
      fvgPullbackBuffer: 2,        // Points inside FVG zone for limit entry
      fvgStopBuffer: 3,            // Points beyond FVG opposite edge for stop
      fvgTargetPoints: 30,         // Take profit target for FVG pullback
      fvgMaxWaitBars: 10,          // Max bars to wait for pullback into FVG
      fvgMinGapSize: 2,            // Minimum FVG gap size in points

      // No-FVG Fade parameters (sweep-optimized)
      noFvgFadeEnabled: true,
      noFvgStopBuffer: 2,          // Points beyond impulse extreme for stop
      noFvgTargetPoints: 30,       // Take profit target for fade
      noFvgMaxRisk: 40,            // Max risk in points for fade trades

      // Limit order entry for no-FVG fade
      // Instead of market order at bar 2 close, place a limit order at a retrace
      // level inside the impulse body for a better entry, with timeout.
      useLimitEntry: false,        // false = market order (default), true = limit order
      limitRetracePct: 50,         // Limit price at X% retrace into impulse body (0=extreme, 100=origin)
      limitTimeoutBars: 3,         // Cancel unfilled limit after N bars

      // Trailing stop (sweep-optimized: tight trail is critical)
      useTrailingStop: true,
      trailingTrigger: 6,          // Activate trailing when 6 pts in profit
      trailingOffset: 3,           // Trail 3 pts behind high water mark

      // Max hold
      maxHoldBars: 60,             // Max bars to hold (60 min on 1m)

      // Limit order timeout (for FVG pullback mode)
      limitOrderTimeout: 10,       // Cancel unfilled limit orders after N candles

      // Cooldown
      signalCooldownMs: 20 * 60 * 1000,  // 20 minutes between signals

      // Session filtering
      useSessionFilter: false,
      allowedSessions: ['overnight', 'premarket', 'rth', 'afterhours'],

      // Multi-bar momentum context
      momentumLookback: 3,         // Bars to check for prior momentum
      requireMomentumAlignment: false, // Require prior bars moving in impulse direction

      // Symbol configuration
      tradingSymbol: 'NQ1!',
      defaultQuantity: 1,
    };

    this.params = { ...this.defaultParams, ...params };

    // Apply mode shortcuts
    if (this.params.mode === 'fvg-pullback') {
      this.params.fvgPullbackEnabled = true;
      this.params.noFvgFadeEnabled = false;
    } else if (this.params.mode === 'no-fvg-fade') {
      this.params.fvgPullbackEnabled = false;
      this.params.noFvgFadeEnabled = true;
    }

    // Candle history buffer for FVG detection (need [i-2], [i-1], [i])
    this.candleBuffer = [];
    this.maxBufferSize = Math.max(10, this.params.momentumLookback + 3);

    // Pending impulse state: tracks impulse candle waiting for FVG confirmation
    this.pendingImpulse = null;

    // Dashboard tracking
    this.lastImpulseInfo = null;
    this.lastSignalInfo = null;
    this.signalCount = 0;

    // Event windows to exclude (ET minutes since midnight)
    this.eventWindows = [
      { start: 8 * 60 + 25, end: 8 * 60 + 40 },   // 8:25-8:40 (economic data)
      { start: 9 * 60 + 28, end: 9 * 60 + 37 },   // 9:28-9:37 (market open)
      { start: 9 * 60 + 58, end: 10 * 60 + 7 },   // 9:58-10:07 (10am data)
      { start: 13 * 60 + 58, end: 14 * 60 + 15 },  // 1:58-2:15 (FOMC)
      { start: 14 * 60 + 28, end: 14 * 60 + 42 },  // 2:28-2:42 (FOMC press)
    ];
  }

  /**
   * Main evaluation - called once per aggregated candle close
   */
  evaluateSignal(candle, prevCandle, marketData, options = {}) {
    if (!isValidCandle(candle)) return null;

    // Add to buffer
    this.candleBuffer.push(candle);
    if (this.candleBuffer.length > this.maxBufferSize) {
      this.candleBuffer.shift();
    }

    // Check cooldown
    if (!this.checkCooldown(candle.timestamp, this.params.signalCooldownMs)) {
      return null;
    }

    // Check session filter
    if (this.params.useSessionFilter && !this.isAllowedSession(candle.timestamp)) {
      return null;
    }

    // Check event windows
    if (this.isInEventWindow(candle.timestamp)) {
      return null;
    }

    // Need at least 3 candles for FVG detection
    if (this.candleBuffer.length < 3) return null;

    const buf = this.candleBuffer;
    const cur = buf[buf.length - 1];       // candle[i]   - current (just closed)
    const prev = buf[buf.length - 2];      // candle[i-1] - previous
    const prev2 = buf[buf.length - 3];     // candle[i-2] - two bars ago

    // --- Check if PREVIOUS bar was an impulse candle ---
    // We evaluate on the bar AFTER the impulse to see if an FVG formed
    const impulseCandle = prev;
    const bodySize = Math.abs(impulseCandle.close - impulseCandle.open);
    const range = impulseCandle.high - impulseCandle.low;
    const isBullishImpulse = impulseCandle.close > impulseCandle.open;

    // Check if previous candle qualifies as impulse
    if (bodySize < this.params.minBodyPoints) return null;
    if (this.params.minRangePoints > 0 && range < this.params.minRangePoints) return null;

    // Check if the impulse candle itself was in an event window
    if (this.isInEventWindow(impulseCandle.timestamp)) return null;

    // Check momentum alignment if required
    if (this.params.requireMomentumAlignment && buf.length >= this.params.momentumLookback + 2) {
      const lookback = this.params.momentumLookback;
      const startIdx = buf.length - 2 - lookback; // bars before the impulse
      let alignedBars = 0;
      for (let j = startIdx; j < buf.length - 2; j++) {
        if (j >= 0) {
          const barDir = buf[j].close - buf[j].open;
          if ((isBullishImpulse && barDir > 0) || (!isBullishImpulse && barDir < 0)) {
            alignedBars++;
          }
        }
      }
      if (alignedBars < Math.ceil(lookback / 2)) return null;
    }

    // --- FVG detection: does the current candle + impulse + pre-impulse form an FVG? ---
    // FVG = gap between candle[i-2] and candle[i] (the impulse is candle[i-1])
    const fvg = this.detectFVG(prev2, impulseCandle, cur);

    // Track impulse for dashboard
    this.lastImpulseInfo = {
      timestamp: new Date(impulseCandle.timestamp).toISOString(),
      direction: isBullishImpulse ? 'bullish' : 'bearish',
      bodySize: Math.round(bodySize * 100) / 100,
      range: Math.round(range * 100) / 100,
      fvgFormed: !!fvg,
      fvgGapSize: fvg ? Math.round(fvg.gapSize * 100) / 100 : null,
    };

    let signal = null;
    if (fvg && this.params.fvgPullbackEnabled) {
      signal = this.generateFVGPullbackSignal(candle, impulseCandle, fvg, isBullishImpulse);
    } else if (!fvg && this.params.noFvgFadeEnabled) {
      signal = this.generateNoFVGFadeSignal(candle, impulseCandle, isBullishImpulse);
    }

    if (signal) {
      this.signalCount = (this.signalCount || 0) + 1;
      this.lastSignalInfo = {
        timestamp: signal.timestamp,
        side: signal.side,
        setup: signal.metadata?.setup,
        price: signal.price,
        stop_loss: signal.stop_loss,
        take_profit: signal.take_profit,
      };
    }

    return signal;
  }

  /**
   * Detect Fair Value Gap between 3 consecutive candles.
   * c0 = candle[i-2], c1 = candle[i-1] (impulse), c2 = candle[i]
   *
   * Bullish FVG: c0.high < c2.low (gap up — price jumped past c0 high)
   * Bearish FVG: c0.low > c2.high (gap down — price dropped past c0 low)
   */
  detectFVG(c0, c1, c2) {
    if (!c0 || !c1 || !c2) return null;

    const bullGap = c2.low - c0.high;
    const bearGap = c0.low - c2.high;

    if (bullGap >= this.params.fvgMinGapSize) {
      return { type: 'bullish', gapSize: bullGap, top: c2.low, bottom: c0.high };
    }
    if (bearGap >= this.params.fvgMinGapSize) {
      return { type: 'bearish', gapSize: bearGap, top: c0.low, bottom: c2.high };
    }
    return null;
  }

  /**
   * FVG Pullback Continuation:
   * After a bullish impulse creates a bullish FVG, place a limit buy at the
   * FVG top (+ buffer) anticipating price retraces into the gap then continues.
   * Stop at FVG bottom (- buffer). Target is fixed points above entry.
   */
  generateFVGPullbackSignal(currentCandle, impulseCandle, fvg, isBullishImpulse) {
    let entryPrice, stopPrice, targetPrice, side;

    if (isBullishImpulse && fvg.type === 'bullish') {
      // Bullish: limit buy at top of FVG zone (waiting for pullback down into gap)
      side = 'buy';
      entryPrice = roundTo(fvg.top + this.params.fvgPullbackBuffer);
      stopPrice = roundTo(fvg.bottom - this.params.fvgStopBuffer);
      targetPrice = roundTo(entryPrice + this.params.fvgTargetPoints);
    } else if (!isBullishImpulse && fvg.type === 'bearish') {
      // Bearish: limit sell at bottom of FVG zone (waiting for pullback up into gap)
      side = 'sell';
      entryPrice = roundTo(fvg.bottom - this.params.fvgPullbackBuffer);
      stopPrice = roundTo(fvg.top + this.params.fvgStopBuffer);
      targetPrice = roundTo(entryPrice - this.params.fvgTargetPoints);
    } else {
      // FVG direction doesn't match impulse direction — skip
      return null;
    }

    const risk = Math.abs(entryPrice - stopPrice);
    if (risk <= 0 || risk > this.params.noFvgMaxRisk) return null;

    this.updateLastSignalTime(currentCandle.timestamp);

    return {
      strategy: 'IMPULSE_FVG',
      side,
      action: 'place_limit',
      symbol: this.params.tradingSymbol,
      price: entryPrice,
      stop_loss: stopPrice,
      take_profit: targetPrice,
      quantity: this.params.defaultQuantity,
      timestamp: new Date(currentCandle.timestamp).toISOString(),

      trailing_trigger: this.params.useTrailingStop ? this.params.trailingTrigger : null,
      trailing_offset: this.params.useTrailingStop ? this.params.trailingOffset : null,
      maxHoldBars: this.params.maxHoldBars,
      timeoutCandles: this.params.limitOrderTimeout,

      metadata: {
        setup: 'fvg_pullback',
        impulse_body: roundTo(Math.abs(impulseCandle.close - impulseCandle.open)),
        impulse_range: roundTo(impulseCandle.high - impulseCandle.low),
        impulse_direction: isBullishImpulse ? 'bullish' : 'bearish',
        fvg_type: fvg.type,
        fvg_gap_size: roundTo(fvg.gapSize),
        fvg_top: roundTo(fvg.top),
        fvg_bottom: roundTo(fvg.bottom),
        risk_points: roundTo(risk),
        impulse_time: new Date(impulseCandle.timestamp).toISOString(),
      }
    };
  }

  /**
   * No-FVG Structural Fade:
   * When an impulse candle does NOT produce an FVG (meaning the next bar
   * immediately retraced), fade the impulse with stop at the impulse extreme.
   *
   * Supports two entry modes:
   * 1. Market order (default): Enter at bar 2 close immediately
   * 2. Limit order (useLimitEntry=true): Place a limit order at a retrace level
   *    inside the impulse body for better entry. Cancel after limitTimeoutBars.
   */
  generateNoFVGFadeSignal(currentCandle, impulseCandle, isBullishImpulse) {
    let entryPrice, stopPrice, targetPrice, side;
    const useLimitEntry = this.params.useLimitEntry;

    if (isBullishImpulse) {
      // Bullish impulse, no FVG → fade it (sell)
      side = 'sell';
      stopPrice = roundTo(impulseCandle.high + this.params.noFvgStopBuffer);

      if (useLimitEntry) {
        // Limit entry: sell at a retrace UP into the impulse body
        // retracePct=50 means halfway between impulse low and high
        const retracePct = this.params.limitRetracePct / 100;
        entryPrice = roundTo(impulseCandle.low + (impulseCandle.high - impulseCandle.low) * retracePct);
        // Entry must be above current price (limit sell above market)
        if (entryPrice <= currentCandle.close) {
          // Retrace level already passed — fall back to no entry
          return null;
        }
      } else {
        entryPrice = currentCandle.close;
      }

      targetPrice = roundTo(entryPrice - this.params.noFvgTargetPoints);
      // Entry must be below the impulse high (otherwise impulse is continuing, not failing)
      if (entryPrice >= impulseCandle.high) return null;
    } else {
      // Bearish impulse, no FVG → fade it (buy)
      side = 'buy';
      stopPrice = roundTo(impulseCandle.low - this.params.noFvgStopBuffer);

      if (useLimitEntry) {
        // Limit entry: buy at a retrace DOWN into the impulse body
        // retracePct=50 means halfway between impulse high and low
        const retracePct = this.params.limitRetracePct / 100;
        entryPrice = roundTo(impulseCandle.high - (impulseCandle.high - impulseCandle.low) * retracePct);
        // Entry must be below current price (limit buy below market)
        if (entryPrice >= currentCandle.close) {
          return null;
        }
      } else {
        entryPrice = currentCandle.close;
      }

      targetPrice = roundTo(entryPrice + this.params.noFvgTargetPoints);
      // Entry must be above the impulse low (otherwise impulse is continuing, not failing)
      if (entryPrice <= impulseCandle.low) return null;
    }

    const risk = Math.abs(entryPrice - stopPrice);
    if (risk <= 0 || risk > this.params.noFvgMaxRisk) return null;

    this.updateLastSignalTime(currentCandle.timestamp);

    return {
      strategy: 'IMPULSE_FVG',
      side,
      action: useLimitEntry ? 'place_limit' : 'place_market',
      symbol: this.params.tradingSymbol,
      price: roundTo(entryPrice),
      stop_loss: stopPrice,
      take_profit: targetPrice,
      quantity: this.params.defaultQuantity,
      timestamp: new Date(currentCandle.timestamp).toISOString(),

      trailing_trigger: this.params.useTrailingStop ? this.params.trailingTrigger : null,
      trailing_offset: this.params.useTrailingStop ? this.params.trailingOffset : null,
      maxHoldBars: this.params.maxHoldBars,
      timeoutCandles: useLimitEntry ? this.params.limitTimeoutBars : 0,

      metadata: {
        setup: 'no_fvg_fade',
        entry_mode: useLimitEntry ? 'limit' : 'market',
        impulse_body: roundTo(Math.abs(impulseCandle.close - impulseCandle.open)),
        impulse_range: roundTo(impulseCandle.high - impulseCandle.low),
        impulse_direction: isBullishImpulse ? 'bullish' : 'bearish',
        risk_points: roundTo(risk),
        limit_retrace_pct: useLimitEntry ? this.params.limitRetracePct : null,
        impulse_time: new Date(impulseCandle.timestamp).toISOString(),
      }
    };
  }

  // ── Time helpers ──────────────────────────────────────────────────

  getETMinutes(ts) {
    const d = new Date(ts);
    const month = d.getUTCMonth();
    // EDT (Mar-Nov) = UTC-4, EST (Nov-Mar) = UTC-5
    const offset = (month >= 2 && month <= 10) ? 4 : 5;
    return ((d.getUTCHours() - offset + 24) % 24) * 60 + d.getUTCMinutes();
  }

  isInEventWindow(ts) {
    const m = this.getETMinutes(ts);
    return this.eventWindows.some(w => m >= w.start && m <= w.end);
  }

  getSession(timestamp) {
    const date = new Date(timestamp);
    const estString = date.toLocaleString('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      minute: 'numeric',
      hour12: false
    });
    const [hourStr, minStr] = estString.split(':');
    const hour = parseInt(hourStr);
    const min = parseInt(minStr);
    const timeDecimal = hour + min / 60;

    if (timeDecimal >= 18 || timeDecimal < 4) return 'overnight';
    if (timeDecimal >= 4 && timeDecimal < 9.5) return 'premarket';
    if (timeDecimal >= 9.5 && timeDecimal < 16) return 'rth';
    return 'afterhours';
  }

  isAllowedSession(timestamp) {
    if (!this.params.useSessionFilter) return true;
    return this.params.allowedSessions.includes(this.getSession(timestamp));
  }

  // ── Dashboard state ──────────────────────────────────────────────

  getInternalState() {
    const now = Date.now();
    const cooldownMs = this.params.signalCooldownMs;
    const lastSignal = this.lastSignalTime || 0;
    const cooldownRemaining = Math.max(0, lastSignal + cooldownMs - now);

    const lastCandle = this.candleBuffer.length > 0
      ? this.candleBuffer[this.candleBuffer.length - 1]
      : null;

    return {
      mode: this.params.mode,
      lastImpulse: this.lastImpulseInfo || null,
      lastSignalInfo: this.lastSignalInfo || null,
      signalCount: this.signalCount || 0,
      cooldown: {
        remaining_ms: cooldownRemaining,
        remaining_s: Math.ceil(cooldownRemaining / 1000),
        total_ms: cooldownMs,
      },
      eventWindow: {
        in_window: lastCandle ? this.isInEventWindow(lastCandle.timestamp) : false,
        windows: this.eventWindows,
      },
      buffer: {
        size: this.candleBuffer.length,
        maxSize: this.maxBufferSize,
      },
      lastPrice: lastCandle?.close || null,
      params: {
        minBodyPoints: this.params.minBodyPoints,
        noFvgTargetPoints: this.params.noFvgTargetPoints,
        noFvgStopBuffer: this.params.noFvgStopBuffer,
        noFvgMaxRisk: this.params.noFvgMaxRisk,
        trailingTrigger: this.params.trailingTrigger,
        trailingOffset: this.params.trailingOffset,
        maxHoldBars: this.params.maxHoldBars,
        fvgTargetPoints: this.params.fvgTargetPoints,
        useLimitEntry: this.params.useLimitEntry,
        limitRetracePct: this.params.limitRetracePct,
        limitTimeoutBars: this.params.limitTimeoutBars,
      },
    };
  }

  // ── Lifecycle ─────────────────────────────────────────────────────

  reset() {
    super.reset();
    this.candleBuffer = [];
    this.pendingImpulse = null;
    this.lastImpulseInfo = null;
    this.lastSignalInfo = null;
    this.signalCount = 0;
  }

  getName() { return 'IMPULSE_FVG'; }

  getDescription() {
    return 'Impulse candle + FVG pullback continuation and no-FVG structural fade strategy';
  }
}

export default ImpulseFVGStrategy;
