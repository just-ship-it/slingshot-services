/**
 * Micro-Structure Scalper Strategy
 *
 * An aggressive scalping strategy for NQ targeting 2-3 points per trade
 * using market structure patterns and trailing stops.
 *
 * Patterns detected:
 * - Fair Value Gaps (FVG) - Price returns to unfilled gaps
 * - Liquidity Sweeps - Sweep of swing point followed by rejection
 * - Engulfing Patterns - Strong reversal candles with volume
 * - Pin Bars / Hammers - Rejection wicks at key levels
 *
 * Designed for 3-minute charts with quick entries and exits.
 */

import { BaseStrategy } from './base-strategy.js';
import { isValidCandle, roundTo } from './strategy-utils.js';
import { PATTERNS, DEFAULT_ACTIVE_PATTERNS, validatePatterns } from './patterns/index.js';

// Import individual patterns for swing detection helpers
import { SwingLowSweepPattern } from './patterns/swing-low-sweep.js';
import { SwingHighSweepPattern } from './patterns/swing-high-sweep.js';

export class MicroStructureScalperStrategy extends BaseStrategy {
  constructor(params = {}) {
    super(params);

    this.defaultParams = {
      // Core exit parameters (scalping targets)
      targetPoints: 2.5,            // Set to null or 0 to disable target (trailing stop only)
      useTargetExit: true,          // Set to false to rely only on trailing stop
      stopLossPoints: 2.5,
      stopBuffer: 0.5,              // Buffer for pattern-specific stops (added to wick/level)
      useFixedStops: false,         // Use fixed stop loss instead of pattern-specific structural stops
      maxStopLoss: null,            // Max stop loss in points - skip trade if structural stop exceeds this
      trailingTrigger: 1.5,
      trailingOffset: 0.75,
      maxHoldBars: 5,

      // Pattern detection parameters
      swingLookback: 8,           // Candles for swing high/low detection
      sweepMaxBars: 2,            // Max candles for sweep duration
      rejectionWickPct: 0.3,      // Min wick % of range for reversal
      volumeMultiplier: 1.5,      // Volume confirmation threshold
      fvgMinPoints: 0.5,          // Minimum FVG size in points
      volumeLookback: 10,         // Candles for avg volume calculation

      // Active patterns (can be configured per-strategy)
      activePatterns: DEFAULT_ACTIVE_PATTERNS,

      // Signal management
      signalCooldownMs: 180000,   // 3 minutes between signals
      allowSimultaneous: false,   // One position at a time
      orderTimeoutBars: 3,        // Cancel unfilled limit orders after N bars

      // Symbol configuration
      tradingSymbol: 'NQ1!',
      defaultQuantity: 1,

      // Filter parameters
      useLongEntries: true,
      useShortEntries: true,
      invertSignals: false,       // Flip signal direction (for testing inverse)

      // Session filtering (all times in EST)
      useSessionFilter: true,
      allowedSessions: ['rth'],   // RTH only by default
      blockedHoursUTC: [],

      // GEX level integration (optional)
      useGexLevels: false,        // Use GEX levels for confluence
      gexProximityPoints: 5,      // Points from GEX level to add confluence

      // Order Flow (optional)
      useOrderFlow: false,
      orderFlowThreshold: 2.0,    // 2:1 imbalance

      // Pattern-specific overrides (applied per-pattern)
      patternOverrides: {}        // { pattern_name: { targetPoints: X, ... } }
    };

    // Merge with provided parameters
    this.params = { ...this.defaultParams, ...params };

    // Validate active patterns
    const validation = validatePatterns(this.params.activePatterns);
    if (!validation.valid) {
      console.warn(`[MICRO_SCALPER] Invalid patterns: ${validation.errors.join(', ')}`);
      // Fall back to default
      this.params.activePatterns = DEFAULT_ACTIVE_PATTERNS;
    }

    // Track swing points for sweep detection
    this.swingHighs = [];
    this.swingLows = [];

    // Track FVG zones
    this.bullishFVGs = [];
    this.bearishFVGs = [];

    // Volume tracking
    this.recentVolumes = [];
  }

  /**
   * Evaluate if a trading signal should be generated
   *
   * @param {Object} candle - Current candle
   * @param {Object} prevCandle - Previous candle
   * @param {Object} marketData - Contains gexLevels, ltLevels, etc.
   * @param {Object} options - Additional options including historicalCandles
   * @returns {Object|null} Signal object or null
   */
  evaluateSignal(candle, prevCandle, marketData, options = {}) {
    const debug = options.debug || this.params.debug;

    // Validate inputs
    if (!isValidCandle(candle)) {
      if (debug) console.log('[MICRO_SCALPER] Invalid candle');
      return null;
    }

    // Check cooldown
    if (!this.checkCooldown(candle.timestamp, this.params.signalCooldownMs)) {
      if (debug) console.log('[MICRO_SCALPER] In cooldown');
      return null;
    }

    // Check session filter
    if (!this.isAllowedSession(candle.timestamp)) {
      if (debug) console.log('[MICRO_SCALPER] Session filter blocked');
      return null;
    }

    // Build pattern context
    const context = this.buildContext(candle, prevCandle, marketData, options);

    // Check each active pattern
    for (const patternName of this.params.activePatterns) {
      const pattern = PATTERNS[patternName];
      if (!pattern) continue;

      // Skip if direction doesn't match filters
      if (pattern.side === 'long' && !this.params.useLongEntries) continue;
      if (pattern.side === 'short' && !this.params.useShortEntries) continue;

      // Attempt pattern detection
      const detected = this.detectPattern(pattern, candle, prevCandle, context);

      if (!detected) continue;

      // Check pattern-specific filters
      if (!this.passesFilters(pattern, candle, context)) {
        if (debug) console.log(`[MICRO_SCALPER] ${patternName} filtered out`);
        continue;
      }

      // Pattern detected and passed filters - generate signal
      if (debug) console.log(`[MICRO_SCALPER] ✅ ${patternName} detected at ${candle.close}`);

      this.updateLastSignalTime(candle.timestamp);

      // Determine side for neutral patterns
      let side = pattern.side;
      if (side === 'neutral') {
        side = this.determineNeutralPatternSide(pattern, candle, prevCandle, context);
        if (!side) continue; // Could not determine direction
      }

      return this.generateSignal(candle, side, patternName, pattern, context);
    }

    return null;
  }

  /**
   * Build context object for pattern detection
   */
  buildContext(candle, prevCandle, marketData, options = {}) {
    const historicalCandles = options.historicalCandles || [];

    // Update swing points from historical candles
    if (historicalCandles.length >= this.params.swingLookback * 2) {
      this.updateSwingPoints(historicalCandles);
    }

    // Update FVG zones
    if (historicalCandles.length >= 3) {
      this.updateFVGZones(historicalCandles);
    }

    // Calculate average volume
    this.updateVolumeTracking(candle);
    const avgVolume = this.calculateAverageVolume();

    // Get third candle for 3-candle patterns
    const oldest = historicalCandles.length >= 3
      ? historicalCandles[historicalCandles.length - 3]
      : null;

    // Build GEX context
    const { gexLevels } = marketData || {};
    const nearSupport = this.isNearGexSupport(candle.close, gexLevels);
    const nearResistance = this.isNearGexResistance(candle.close, gexLevels);

    return {
      // Historical data
      candles: historicalCandles.slice(-20),
      oldest,

      // Swing points for sweep detection
      swingHighs: this.swingHighs.slice(-10),
      swingLows: this.swingLows.slice(-10),

      // FVG zones
      bullishFVGs: this.bullishFVGs,
      bearishFVGs: this.bearishFVGs,

      // Volume context
      avgVolume,
      volumeMultiplier: this.params.volumeMultiplier,

      // Pattern parameters
      minBodyRatio: 0.5,
      minWickRatio: this.params.rejectionWickPct,
      maxSweepBars: this.params.sweepMaxBars,
      swingLookback: this.params.swingLookback,
      minGapPoints: this.params.fvgMinPoints,
      stopBuffer: this.params.stopBuffer,  // Buffer for pattern-specific stops

      // GEX context
      gexLevels,
      nearSupport,
      nearResistance,

      // Session info
      session: this.getSession(candle.timestamp),
      hourOfDay: new Date(candle.timestamp).getUTCHours()
    };
  }

  /**
   * Detect a specific pattern
   */
  detectPattern(pattern, candle, prevCandle, context) {
    try {
      return pattern.detect(candle, prevCandle, context);
    } catch (error) {
      console.error(`[MICRO_SCALPER] Error detecting ${pattern.name}:`, error.message);
      return false;
    }
  }

  /**
   * Check if pattern passes all filters
   */
  passesFilters(pattern, candle, context) {
    const filters = { ...pattern.filters, ...(this.params.patternOverrides[pattern.name]?.filters || {}) };

    // Volume filter
    if (filters.volumeMultiplier && context.avgVolume > 0) {
      if (candle.volume < context.avgVolume * filters.volumeMultiplier) {
        return false;
      }
    }

    // Session filter
    if (filters.sessions && filters.sessions.length > 0) {
      if (!filters.sessions.includes(context.session)) {
        return false;
      }
    }

    // Hour filter
    if (filters.avoidHours && filters.avoidHours.length > 0) {
      if (filters.avoidHours.includes(context.hourOfDay)) {
        return false;
      }
    }

    // GEX level proximity filter (optional)
    if (filters.nearSupportRequired && !context.nearSupport) {
      return false;
    }
    if (filters.nearResistanceRequired && !context.nearResistance) {
      return false;
    }

    return true;
  }

  /**
   * Determine direction for neutral patterns
   */
  determineNeutralPatternSide(pattern, candle, prevCandle, context) {
    // Pattern-specific direction determination
    if (typeof pattern.getDirection === 'function') {
      return pattern.getDirection(candle, prevCandle, context);
    }

    // Default: use candle color
    return candle.close > candle.open ? 'long' : 'short';
  }

  /**
   * Generate the trading signal
   */
  generateSignal(candle, side, patternName, pattern, context) {
    // Invert signal direction if enabled (for testing inverse strategy)
    if (this.params.invertSignals) {
      side = side === 'long' ? 'short' : 'long';
    }

    // Get previous candle for pattern entry calculation
    const prevCandle = context.candles?.[context.candles.length - 2] || null;

    // Add side to context for neutral patterns (needed by getEntryPrice)
    context.side = side;

    // Get pattern-specific entry price (optimal limit order level)
    // Falls back to candle close if pattern doesn't define getEntryPrice
    let entryPrice;
    if (typeof pattern.getEntryPrice === 'function') {
      entryPrice = pattern.getEntryPrice(candle, prevCandle, context);
    } else {
      // Fallback to candle close for patterns without custom entry
      entryPrice = candle.close;
    }

    // Get exit parameters with proper precedence:
    // 1. Pattern defaults (lowest priority)
    // 2. Strategy defaults
    // 3. CLI/runtime params (highest priority - override pattern defaults)
    // 4. Explicit pattern overrides from config
    const exits = {
      ...this.defaultParams,           // Strategy defaults
      ...pattern.exits,                // Pattern-specific defaults
      ...this.params,                  // CLI/runtime params override patterns
      ...(this.params.patternOverrides[patternName]?.exits || {})  // Explicit overrides
    };

    // Determine if we should use a target exit
    // Target is disabled if: useTargetExit is false, OR targetPoints is null/0
    const useTarget = exits.useTargetExit !== false &&
                      exits.targetPoints != null &&
                      exits.targetPoints > 0;

    // Get stop price - use fixed or pattern-specific structural stop
    let stopPrice;
    if (this.params.useFixedStops) {
      // Use fixed stop loss points from entry (ignores pattern structural stops)
      if (side === 'long') {
        stopPrice = entryPrice - exits.stopLossPoints;
      } else {
        stopPrice = entryPrice + exits.stopLossPoints;
      }
    } else if (typeof pattern.getStopPrice === 'function') {
      // Use pattern-specific structural stop (wick extreme + buffer)
      // Pattern returns stop for ORIGINAL direction, need to adjust if inverted
      const patternStop = pattern.getStopPrice(candle, prevCandle, context);

      if (this.params.invertSignals) {
        // When inverted, use the same risk distance but on opposite side of entry
        const riskPoints = Math.abs(entryPrice - patternStop);
        if (side === 'long') {
          stopPrice = entryPrice - riskPoints;
        } else {
          stopPrice = entryPrice + riskPoints;
        }
      } else {
        stopPrice = patternStop;
      }
    } else {
      // Fallback to fixed stop loss points from entry
      if (side === 'long') {
        stopPrice = entryPrice - exits.stopLossPoints;
      } else {
        stopPrice = entryPrice + exits.stopLossPoints;
      }
    }

    // Calculate target price from entry
    let targetPrice;
    if (side === 'long') {
      targetPrice = useTarget ? entryPrice + exits.targetPoints : null;
    } else {
      targetPrice = useTarget ? entryPrice - exits.targetPoints : null;
    }

    // Determine order action based on pattern's entry type
    // - 'limit': Standard limit order (default)
    // - 'stop': Stop order for breakout entries (inside bar)
    // - 'market': Market order (immediate fill)
    const entryType = pattern.entryType || 'limit';
    let action;
    switch (entryType) {
      case 'stop':
        action = 'place_stop'; // Stop order for breakouts
        break;
      case 'market':
        action = 'place_market';
        break;
      case 'limit':
      default:
        action = 'place_limit';
    }

    // Calculate risk (distance from entry to stop)
    const risk = Math.abs(entryPrice - stopPrice);

    // Check max stop loss - skip trade if structural stop exceeds limit
    if (this.params.maxStopLoss != null && risk > this.params.maxStopLoss) {
      if (this.params.debug) {
        console.log(`[MICRO_SCALPER] Skipping ${patternName} - risk ${roundTo(risk, 2)} pts exceeds maxStopLoss ${this.params.maxStopLoss} pts`);
      }
      return null;
    }

    const signal = {
      // Core signal data
      strategy: 'MICRO_STRUCTURE_SCALPER',
      side: side === 'long' ? 'buy' : 'sell',
      action,
      symbol: this.params.tradingSymbol,
      price: roundTo(entryPrice),
      stop_loss: roundTo(stopPrice),
      take_profit: targetPrice !== null ? roundTo(targetPrice) : null,
      quantity: this.params.defaultQuantity,
      timestamp: new Date(candle.timestamp).toISOString(),

      // Order management
      timeoutCandles: this.params.orderTimeoutBars,  // Cancel unfilled limit orders after N bars
      maxHoldBars: exits.maxHoldBars,                // Force exit after N bars in trade

      // Trailing stop configuration
      trailing_trigger: exits.trailingTrigger,
      trailing_offset: exits.trailingOffset,

      // Strategy metadata
      metadata: {
        pattern: patternName,
        pattern_strength: pattern.getStrength
          ? pattern.getStrength(candle, prevCandle, context)
          : 0.5,
        entry_type: entryType,
        target_points: useTarget ? exits.targetPoints : null,
        use_target_exit: useTarget,
        trailing_only: !useTarget,
        stop_points: roundTo(risk, 2),
        risk_points: roundTo(risk, 2),
        trailing_trigger: exits.trailingTrigger,
        trailing_offset: exits.trailingOffset,
        max_hold_bars: exits.maxHoldBars,
        candle_close: roundTo(candle.close),
        candle_high: roundTo(candle.high),
        candle_low: roundTo(candle.low),
        candle_time: new Date(candle.timestamp).toISOString(),
        entry_reason: `${patternName} ${entryType} at ${roundTo(entryPrice)}` +
                      (!useTarget ? ' (trailing stop only)' : ''),

        // Context
        avg_volume: context.avgVolume,
        volume_ratio: context.avgVolume > 0 ? roundTo(candle.volume / context.avgVolume, 2) : null,
        session: context.session,
        near_gex_support: context.nearSupport,
        near_gex_resistance: context.nearResistance,

        // Pattern-specific context from detection
        swept_level: context.sweptLevel ? roundTo(context.sweptLevel) : null,
        sweep_depth: context.sweepDepth ? roundTo(context.sweepDepth, 2) : null,
        wick_ratio: context.wickRatio ? roundTo(context.wickRatio, 2) : null
      }
    };

    return signal;
  }

  /**
   * Update swing high/low tracking from historical candles
   */
  updateSwingPoints(candles) {
    const lookback = this.params.swingLookback;

    // Use pattern helper functions for swing detection
    this.swingLows = SwingLowSweepPattern.findSwingLows(candles, lookback);
    this.swingHighs = SwingHighSweepPattern.findSwingHighs(candles, lookback);
  }

  /**
   * Update FVG zone tracking
   */
  updateFVGZones(candles) {
    const maxAge = 50; // Max candles to keep FVG active

    // Check for new FVGs in last 3 candles
    if (candles.length >= 3) {
      const recent = candles.slice(-3);
      const [oldest, middle, newest] = recent;

      // Check bullish FVG
      if (oldest.high < newest.low) {
        this.bullishFVGs.push({
          type: 'bullish',
          top: newest.low,
          bottom: oldest.high,
          timestamp: newest.timestamp,
          filled: false
        });
      }

      // Check bearish FVG
      if (oldest.low > newest.high) {
        this.bearishFVGs.push({
          type: 'bearish',
          top: oldest.low,
          bottom: newest.high,
          timestamp: newest.timestamp,
          filled: false
        });
      }
    }

    // Clean up old/filled FVGs
    const currentTime = candles[candles.length - 1]?.timestamp || Date.now();
    const maxAgeMs = maxAge * 3 * 60 * 1000; // Assuming 3m candles

    this.bullishFVGs = this.bullishFVGs
      .filter(fvg => !fvg.filled && (currentTime - fvg.timestamp) < maxAgeMs)
      .slice(-20); // Keep max 20

    this.bearishFVGs = this.bearishFVGs
      .filter(fvg => !fvg.filled && (currentTime - fvg.timestamp) < maxAgeMs)
      .slice(-20);
  }

  /**
   * Update volume tracking
   */
  updateVolumeTracking(candle) {
    this.recentVolumes.push(candle.volume);
    if (this.recentVolumes.length > this.params.volumeLookback) {
      this.recentVolumes.shift();
    }
  }

  /**
   * Calculate average volume
   */
  calculateAverageVolume() {
    if (this.recentVolumes.length === 0) return 0;
    return this.recentVolumes.reduce((a, b) => a + b, 0) / this.recentVolumes.length;
  }

  /**
   * Check if price is near GEX support
   */
  isNearGexSupport(price, gexLevels) {
    if (!this.params.useGexLevels || !gexLevels) return false;

    const support = gexLevels.support || [];
    for (const level of support) {
      if (Math.abs(price - level) <= this.params.gexProximityPoints) {
        return true;
      }
    }
    return false;
  }

  /**
   * Check if price is near GEX resistance
   */
  isNearGexResistance(price, gexLevels) {
    if (!this.params.useGexLevels || !gexLevels) return false;

    const resistance = gexLevels.resistance || [];
    for (const level of resistance) {
      if (Math.abs(price - level) <= this.params.gexProximityPoints) {
        return true;
      }
    }
    return false;
  }

  /**
   * Get the current trading session
   */
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

  /**
   * Check if current session is allowed
   */
  isAllowedSession(timestamp) {
    if (!this.params.useSessionFilter) return true;

    const currentSession = this.getSession(timestamp);
    return this.params.allowedSessions.includes(currentSession);
  }

  /**
   * Reset strategy state
   */
  reset() {
    super.reset();
    this.swingHighs = [];
    this.swingLows = [];
    this.bullishFVGs = [];
    this.bearishFVGs = [];
    this.recentVolumes = [];
  }

  /**
   * Get strategy name
   */
  getName() {
    return 'MICRO_STRUCTURE_SCALPER';
  }

  /**
   * Get strategy description
   */
  getDescription() {
    return 'Aggressive scalping strategy using market structure patterns (FVG, sweeps, engulfing) targeting 2-3 points with trailing stops';
  }

  /**
   * Get required market data fields
   */
  getRequiredMarketData() {
    return []; // Works without GEX, but can use it for confluence
  }
}

export default MicroStructureScalperStrategy;
