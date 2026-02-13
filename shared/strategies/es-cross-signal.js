/**
 * ES Cross-Signal Composite Strategy
 *
 * Combines LT level crossings and GEX regime transitions into a composite
 * scoring system for ES futures. Generates long signals when bullish events
 * co-occur and short signals when bearish events co-occur.
 *
 * Signal Components:
 * 1. LT Level Crossings: A Fibonacci lookback level migrating through price
 *    - down_through (level drops below price) = +1 bullish
 *    - up_through (level rises above price) = -1 bearish
 * 2. GEX Regime Transitions: Change in gamma exposure environment
 *    - improving (more positive) = +1 bullish
 *    - deteriorating (more negative) = -1 bearish
 *
 * Key Performance (from Phase 2 analysis on ES continuous data):
 * - down_through + negative GEX: 77.4% win at 15min, +5.73 pts mean
 * - up_through + negative GEX: 83.7% short win at 15min, -6.36 pts mean
 * - RTH improving transition: 95.4% win at 15min, +7.39 pts mean
 * - RTH deteriorating transition: 96.8% short win at 15min, -8.54 pts mean
 * - Composite score >= +2 (long): 82.5% win at 15min, ~3.0/day
 * - Composite score <= -2 (short): 83.4% short win at 15min, ~3.0/day
 */

import { BaseStrategy } from './base-strategy.js';
import { isValidCandle, roundTo } from './strategy-utils.js';

// Ordered regime levels for transition detection
const REGIME_ORDER = ['strong_negative', 'negative', 'neutral', 'positive', 'strong_positive'];

export class ESCrossSignalStrategy extends BaseStrategy {
  static getDataRequirements() {
    return {
      candles: {
        baseSymbol: 'ES',
        quoteSymbols: ['CME_MINI:ES1!', 'CME_MINI:MES1!', 'AMEX:SPY']
      },
      gex: { etfSymbol: 'SPY', futuresSymbol: 'ES', defaultMultiplier: 10.5 },
      lt: { symbol: 'CME_MINI:ES1!', timeframe: '15' },
      tradier: true,
      tradierSymbols: ['SPY'],
      ivSkew: false
    };
  }

  constructor(params = {}) {
    super(params);

    this.defaultParams = {
      // Composite score thresholds
      longThreshold: 2,           // Minimum score for long entry
      shortThreshold: -2,         // Maximum score for short entry (negative)

      // Exit parameters
      targetPoints: 8.0,          // Take profit target
      stopPoints: 8.0,            // Initial stop loss (symmetrical with target)
      maxHoldBars: 30,            // Max candles to hold (30 minutes on 1m)

      // Trailing stop
      useTrailingStop: false,
      trailingTrigger: 4.0,       // Activate trailing when 4 pts in profit
      trailingOffset: 2.0,        // Trail 2 pts behind high water mark

      // Limit order timeout (cancel unfilled orders after N bars)
      limitOrderTimeout: 15,      // 15 bars = 15 minutes on 1m chart

      // Signal management
      signalCooldownMs: 5 * 60 * 1000,  // 5 min cooldown between signals
      signalDecayMs: 15 * 60 * 1000,    // 15 min window (matches GEX/LT snapshot interval)

      // Session filtering
      useSessionFilter: true,
      allowedSessions: ['rth'],   // RTH has strongest signals

      // LT crossing detection
      ltCrossingEnabled: true,
      ltLevelsToTrack: [1, 2, 3, 4, 5],  // All 5 Fibonacci lookback levels

      // Regime transition detection
      regimeTransitionEnabled: true,

      // Regime amplifier: boost score when in negative GEX regime
      useRegimeAmplifier: true,
      amplifiedRegimes: ['negative', 'strong_negative'],
      regimeAmplifierBonus: 1,    // Extra +1/-1 when regime matches

      // Entry filters (based on loser analysis)
      filterRegimeSide: null,     // Array of "regime_side" combos to block, e.g. ['strong_positive_buy']
      filterLtSpacingMax: null,   // Block signals when LT avg spacing exceeds this (points)

      // Symbol configuration
      tradingSymbol: 'ES1!',
      defaultQuantity: 1,
    };

    this.params = { ...this.defaultParams, ...params };

    // Handle CLI parameter name mapping
    if (params.stopLossPoints !== undefined && params.stopPoints === undefined) {
      this.params.stopPoints = params.stopLossPoints;
    }

    // Internal state for event detection
    this.prevLtLevels = null;       // Previous LT snapshot
    this.prevLtPrice = null;        // Price at time of previous LT snapshot
    this.prevGexRegime = null;      // Previous GEX regime string
    this.prevGexTimestamp = 0;      // Timestamp of previous GEX snapshot
    this.activeSignals = [];        // Recent signal events with timestamps
  }

  /**
   * Evaluate if a composite signal should be generated
   */
  evaluateSignal(candle, prevCandle, marketData, options = {}) {
    const debug = options.debug || this.params.debug;

    if (!isValidCandle(candle)) return null;

    // Check cooldown
    if (!this.checkCooldown(candle.timestamp, this.params.signalCooldownMs)) {
      return null;
    }

    // Check session filter
    if (this.params.useSessionFilter && !this.isAllowedSession(candle.timestamp)) {
      return null;
    }

    const { gexLevels, ltLevels } = marketData || {};
    const price = candle.close;
    const candleMs = this.toMs(candle.timestamp);

    // Use GEX futures_spot as price reference for LT crossing detection.
    // This matches Phase 2 methodology: es_spot and raw LT levels are in the
    // same contract price space. Using candle.close (back-adjusted) creates a
    // variable offset vs raw LT levels that distorts crossing detection.
    // Fall back to candle close if GEX spot not available.
    const crossingPrice = gexLevels?.futures_spot || gexLevels?.es_spot || price;

    // Diagnostic counters (first 5 occurrences only)
    if (!this._diagCounts) this._diagCounts = { ltNew: 0, gexNew: 0, crossings: 0, transitions: 0, signals: 0, noLt: 0, noGex: 0 };

    // --- Detect LT Level Crossings ---
    if (this.params.ltCrossingEnabled && ltLevels && this.prevLtLevels) {
      // Only check crossings when we have a NEW LT snapshot
      if (ltLevels.timestamp !== this.prevLtLevels.timestamp) {
        if (this._diagCounts.ltNew < 3) {
          console.log(`[DIAG] New LT snapshot: prev_ts=${this.prevLtLevels.timestamp} cur_ts=${ltLevels.timestamp} crossingPrice=${crossingPrice} candleClose=${price}`);
          console.log(`[DIAG]   prev levels: ${[1,2,3,4,5].map(n => `L${n}=${this.prevLtLevels['level_'+n]?.toFixed(2)}`).join(', ')}`);
          console.log(`[DIAG]   cur  levels: ${[1,2,3,4,5].map(n => `L${n}=${ltLevels['level_'+n]?.toFixed(2)}`).join(', ')}`);
        }
        this._diagCounts.ltNew++;

        const crossings = this.detectLTCrossings(crossingPrice, this.prevLtPrice, ltLevels, this.prevLtLevels, candleMs);
        if (crossings.length > 0 && this._diagCounts.crossings < 10) {
          console.log(`[DIAG] ${crossings.length} LT crossings detected at ${new Date(candleMs).toISOString()}: ${crossings.map(c => `${c.type}_L${c.levelNum}`).join(', ')}`);
          this._diagCounts.crossings++;
        }
        for (const crossing of crossings) {
          this.activeSignals.push(crossing);
        }
      }
    } else if (!ltLevels && this._diagCounts.noLt < 3) {
      this._diagCounts.noLt++;
      console.log(`[DIAG] No LT data at ${new Date(candleMs).toISOString()}`);
    }

    // Update previous LT state
    if (ltLevels && ltLevels.timestamp !== this.prevLtLevels?.timestamp) {
      this.prevLtLevels = { ...ltLevels };
      this.prevLtPrice = crossingPrice;
    }

    // --- Detect GEX Regime Transitions ---
    if (this.params.regimeTransitionEnabled && gexLevels && gexLevels.regime) {
      const gexTs = gexLevels.timestamp ? new Date(gexLevels.timestamp).getTime() : 0;

      // Only process if this is a new GEX snapshot
      if (gexTs > this.prevGexTimestamp && this.prevGexRegime !== null) {
        if (this._diagCounts.gexNew < 3) {
          console.log(`[DIAG] New GEX snapshot: ${this.prevGexRegime} -> ${gexLevels.regime} at ${new Date(candleMs).toISOString()}`);
          this._diagCounts.gexNew++;
        }

        const transition = this.detectRegimeTransition(gexLevels.regime, this.prevGexRegime, candleMs);
        if (transition) {
          this.activeSignals.push(transition);
          if (this._diagCounts.transitions < 10) {
            console.log(`[DIAG] Regime transition: ${transition.type} (${transition.from} -> ${transition.to}) score=${transition.score}`);
            this._diagCounts.transitions++;
          }
        }
      }

      if (gexTs > this.prevGexTimestamp) {
        this.prevGexRegime = gexLevels.regime;
        this.prevGexTimestamp = gexTs;
      }
    } else if (!gexLevels && this._diagCounts.noGex < 3) {
      this._diagCounts.noGex++;
      console.log(`[DIAG] No GEX data at ${new Date(candleMs).toISOString()}`);
    }

    // --- Prune expired signals ---
    this.activeSignals = this.activeSignals.filter(
      s => (candleMs - s.timestamp) <= this.params.signalDecayMs
    );

    // --- Compute composite score ---
    let compositeScore = 0;
    for (const signal of this.activeSignals) {
      compositeScore += signal.score;
    }

    // Apply regime amplifier
    if (this.params.useRegimeAmplifier && gexLevels &&
        this.params.amplifiedRegimes.includes(gexLevels.regime)) {
      if (compositeScore > 0) compositeScore += this.params.regimeAmplifierBonus;
      if (compositeScore < 0) compositeScore -= this.params.regimeAmplifierBonus;
    }

    if (debug && this.activeSignals.length > 0) {
      console.log(`[ES_CROSS] Active signals: ${this.activeSignals.length}, composite: ${compositeScore}, price: ${price}`);
    }

    // --- Apply entry filters before generating signal ---

    // LT spacing filter: block when levels are too spread out (low conviction)
    if (this.params.filterLtSpacingMax != null && ltLevels) {
      const levels = [ltLevels.level_1, ltLevels.level_2, ltLevels.level_3, ltLevels.level_4, ltLevels.level_5]
        .filter(l => l != null && !isNaN(l))
        .sort((a, b) => a - b);
      if (levels.length >= 2) {
        let totalSpacing = 0;
        for (let i = 1; i < levels.length; i++) totalSpacing += levels[i] - levels[i - 1];
        const avgSpacing = totalSpacing / (levels.length - 1);
        if (avgSpacing > this.params.filterLtSpacingMax) return null;
      }
    }

    // --- Generate entry signal if threshold met ---
    if (compositeScore >= this.params.longThreshold) {
      // Regime × side filter
      if (this.params.filterRegimeSide && gexLevels) {
        const combo = `${gexLevels.regime}_buy`;
        if (this.params.filterRegimeSide.includes(combo)) return null;
      }

      if (this._diagCounts.signals < 20) {
        console.log(`[DIAG] LONG SIGNAL: score=${compositeScore} at ${new Date(candleMs).toISOString()} price=${price} signals=${JSON.stringify(this.activeSignals.map(s => s.type))}`);
        this._diagCounts.signals++;
      }
      this.updateLastSignalTime(candle.timestamp);
      return this.generateSignal(candle, 'buy', compositeScore, gexLevels, ltLevels);
    }

    if (compositeScore <= this.params.shortThreshold) {
      // Regime × side filter
      if (this.params.filterRegimeSide && gexLevels) {
        const combo = `${gexLevels.regime}_sell`;
        if (this.params.filterRegimeSide.includes(combo)) return null;
      }

      if (this._diagCounts.signals < 20) {
        console.log(`[DIAG] SHORT SIGNAL: score=${compositeScore} at ${new Date(candleMs).toISOString()} price=${price} signals=${JSON.stringify(this.activeSignals.map(s => s.type))}`);
        this._diagCounts.signals++;
      }
      this.updateLastSignalTime(candle.timestamp);
      return this.generateSignal(candle, 'sell', compositeScore, gexLevels, ltLevels);
    }

    return null;
  }

  /**
   * Detect LT level crossings between current and previous snapshot.
   * Matches Phase 2 methodology: compare each level against the price AT ITS OWN
   * snapshot time. A crossing occurs when the level-vs-price relationship flips,
   * whether because the level moved, price moved, or both.
   */
  detectLTCrossings(currentPrice, prevPrice, currentLT, prevLT, timestamp) {
    const crossings = [];

    for (const levelNum of this.params.ltLevelsToTrack) {
      const levelKey = `level_${levelNum}`;
      const currentLevel = currentLT[levelKey];
      const prevLevel = prevLT[levelKey];

      if (currentLevel == null || prevLevel == null) continue;

      const wasAbove = prevLevel > prevPrice;       // was level above price at prev snapshot?
      const nowAbove = currentLevel > currentPrice;  // is level above price at current snapshot?

      if (wasAbove === nowAbove) continue; // no crossing

      // down_through: level was above price, now below (bullish - support forming)
      if (wasAbove && !nowAbove) {
        crossings.push({
          type: 'down_through',
          levelNum,
          score: 1,  // bullish
          timestamp,
          prevLevel,
          currentLevel,
          price: currentPrice,
        });
      }

      // up_through: level was below price, now above (bearish - resistance forming)
      if (!wasAbove && nowAbove) {
        crossings.push({
          type: 'up_through',
          levelNum,
          score: -1,  // bearish
          timestamp,
          prevLevel,
          currentLevel,
          price: currentPrice,
        });
      }
    }

    return crossings;
  }

  /**
   * Detect GEX regime transition direction
   */
  detectRegimeTransition(currentRegime, prevRegime, timestamp) {
    if (currentRegime === prevRegime) return null;

    const currentIdx = REGIME_ORDER.indexOf(currentRegime);
    const prevIdx = REGIME_ORDER.indexOf(prevRegime);

    if (currentIdx === -1 || prevIdx === -1) return null;

    if (currentIdx > prevIdx) {
      // Improving (moving toward more positive)
      return {
        type: 'regime_improving',
        score: 1,  // bullish
        timestamp,
        from: prevRegime,
        to: currentRegime,
      };
    } else {
      // Deteriorating (moving toward more negative)
      return {
        type: 'regime_deteriorating',
        score: -1,  // bearish
        timestamp,
        from: prevRegime,
        to: currentRegime,
      };
    }
  }

  /**
   * Generate signal object for the backtest engine
   */
  generateSignal(candle, side, compositeScore, gexLevels, ltLevels) {
    const entryPrice = candle.close;
    let stopPrice, targetPrice;

    if (side === 'buy') {
      stopPrice = entryPrice - this.params.stopPoints;
      targetPrice = entryPrice + this.params.targetPoints;
    } else {
      stopPrice = entryPrice + this.params.stopPoints;
      targetPrice = entryPrice - this.params.targetPoints;
    }

    // Collect active signal details for metadata
    const signalDetails = this.activeSignals.map(s => ({
      type: s.type,
      score: s.score,
      levelNum: s.levelNum || null,
    }));

    // When targetPoints is 0 (trail-only mode), set take_profit to null
    // so the trailing stop manages exits instead of an immediate TP at entry price
    const takeProfit = this.params.targetPoints > 0 ? roundTo(targetPrice) : null;

    return {
      strategy: 'ES_CROSS_SIGNAL',
      side,
      action: 'place_limit',
      symbol: this.params.tradingSymbol,
      price: roundTo(entryPrice),
      stop_loss: roundTo(stopPrice),
      take_profit: takeProfit,
      quantity: this.params.defaultQuantity,
      timestamp: new Date(candle.timestamp).toISOString(),

      trailing_trigger: this.params.useTrailingStop ? this.params.trailingTrigger : null,
      trailing_offset: this.params.useTrailingStop ? this.params.trailingOffset : null,
      maxHoldBars: this.params.maxHoldBars,
      timeoutCandles: this.params.limitOrderTimeout,

      metadata: {
        composite_score: compositeScore,
        active_signals: signalDetails.length,
        signal_components: signalDetails,
        target_points: this.params.targetPoints,
        stop_points: this.params.stopPoints,
        max_hold_minutes: this.params.maxHoldBars,
        gex_regime: gexLevels?.regime || 'unknown',
        lt_sentiment: ltLevels?.sentiment || 'unknown',
        entry_reason: `Composite score ${compositeScore} (${side === 'buy' ? '>=' : '<='} ${side === 'buy' ? this.params.longThreshold : this.params.shortThreshold})`,
      },
    };
  }

  /**
   * Session helpers (borrowed from GexScalpStrategy pattern)
   */
  getSession(timestamp) {
    const date = new Date(timestamp);
    const estString = date.toLocaleString('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
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

  /**
   * Reset strategy state
   */
  reset() {
    super.reset();
    this.prevLtLevels = null;
    this.prevLtPrice = null;
    this.prevGexRegime = null;
    this.prevGexTimestamp = 0;
    this.activeSignals = [];
  }

  /**
   * Get internal strategy state for live monitoring dashboard
   */
  getInternalState() {
    // Compute current composite score from active signals
    let compositeScore = 0;
    for (const signal of this.activeSignals) {
      compositeScore += signal.score;
    }

    // Apply regime amplifier (must match evaluateSignal logic)
    if (this.params.useRegimeAmplifier &&
        this.prevGexRegime &&
        this.params.amplifiedRegimes.includes(this.prevGexRegime)) {
      if (compositeScore > 0) compositeScore += this.params.regimeAmplifierBonus;
      if (compositeScore < 0) compositeScore -= this.params.regimeAmplifierBonus;
    }

    return {
      compositeScore,
      longThreshold: this.params.longThreshold,
      shortThreshold: this.params.shortThreshold,
      activeSignals: this.activeSignals.map(s => ({
        type: s.type,
        score: s.score,
        levelNum: s.levelNum || null,
        from: s.from || null,
        to: s.to || null,
        timestamp: s.timestamp,
        age_seconds: Math.round((Date.now() - s.timestamp) / 1000)
      })),
      signalDecayMs: this.params.signalDecayMs,
      prevGexRegime: this.prevGexRegime,
      prevLtLevels: this.prevLtLevels ? {
        level_1: this.prevLtLevels.level_1,
        level_2: this.prevLtLevels.level_2,
        level_3: this.prevLtLevels.level_3,
        level_4: this.prevLtLevels.level_4,
        level_5: this.prevLtLevels.level_5,
        sentiment: this.prevLtLevels.sentiment,
        timestamp: this.prevLtLevels.timestamp
      } : null,
      filters: {
        regimeSide: this.params.filterRegimeSide,
        ltSpacingMax: this.params.filterLtSpacingMax,
        regimeAmplifier: this.params.useRegimeAmplifier,
        amplifiedRegimes: this.params.amplifiedRegimes
      },
      exitParams: {
        targetPoints: this.params.targetPoints,
        stopPoints: this.params.stopPoints,
        breakevenStop: this.params.breakevenStop,
        breakevenTrigger: this.params.breakevenTrigger
      }
    };
  }

  getName() { return 'ES_CROSS_SIGNAL'; }
  getDescription() { return 'ES cross-signal composite strategy combining LT crossings and GEX regime transitions'; }
  getRequiredMarketData() { return ['gexLevels', 'ltLevels']; }
}

export default ESCrossSignalStrategy;
