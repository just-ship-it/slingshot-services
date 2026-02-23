/**
 * ES Micro-Scalper Strategy
 *
 * Captures 1-2 points of profit on ES futures using mean-reversion and
 * level-bounce patterns. Designed for 24/7 operation across all sessions.
 *
 * Uses 9 pattern detectors with embedded rolling indicator state.
 * Patterns are selected based on first-passage probability analysis
 * (target hit before stop hit).
 *
 * Fee reality: ES = $50/point, $5 round-trip commission = 0.1 points.
 */

import { BaseStrategy } from './base-strategy.js';
import { isValidCandle, roundTo } from './strategy-utils.js';

// ─── Embedded Indicator State ──────────────────────────────────────────

class IndicatorState {
  constructor() {
    // RSI Wilder smoothing state
    this.rsi3 = { period: 3, avgGain: 0, avgLoss: 0, count: 0, value: 50 };
    this.rsi6 = { period: 6, avgGain: 0, avgLoss: 0, count: 0, value: 50 };
    this.rsi14 = { period: 14, avgGain: 0, avgLoss: 0, count: 0, value: 50 };

    // EMA state
    this.ema9 = { period: 9, value: null, k: 2 / 10 };
    this.ema20 = { period: 20, value: null, k: 2 / 21 };
    this.ema50 = { period: 50, value: null, k: 2 / 51 };

    // Bollinger Bands (SMA 20, 2σ)
    this.bbWindow = [];
    this.bbPeriod = 20;

    // ATR(14) Wilder smoothing
    this.atr14 = { period: 14, value: 0, count: 0 };

    // Volume average (20-bar SMA)
    this.volWindow = [];
    this.volPeriod = 20;
    this.avgVolume = 0;

    // Consecutive candle tracking
    this.consecutiveGreen = 0;
    this.consecutiveRed = 0;

    // Warm-up tracking
    this.totalBars = 0;
    this.warmUpComplete = false;
  }

  update(candle, prevCandle) {
    this.totalBars++;
    const close = candle.close;
    const prevClose = prevCandle ? prevCandle.close : close;
    const change = close - prevClose;

    this._updateRSI(this.rsi3, change);
    this._updateRSI(this.rsi6, change);
    this._updateRSI(this.rsi14, change);

    this._updateEMA(this.ema9, close);
    this._updateEMA(this.ema20, close);
    this._updateEMA(this.ema50, close);

    this.bbWindow.push(close);
    if (this.bbWindow.length > this.bbPeriod) this.bbWindow.shift();

    if (prevCandle) {
      const tr = Math.max(
        candle.high - candle.low,
        Math.abs(candle.high - prevClose),
        Math.abs(candle.low - prevClose)
      );
      this._updateATR(tr);
    }

    this.volWindow.push(candle.volume);
    if (this.volWindow.length > this.volPeriod) this.volWindow.shift();
    this.avgVolume = this.volWindow.reduce((s, v) => s + v, 0) / this.volWindow.length;

    if (close > candle.open) {
      this.consecutiveGreen++;
      this.consecutiveRed = 0;
    } else if (close < candle.open) {
      this.consecutiveRed++;
      this.consecutiveGreen = 0;
    }

    if (this.totalBars >= 50) this.warmUpComplete = true;
  }

  _updateRSI(state, change) {
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    state.count++;
    if (state.count <= state.period) {
      state.avgGain += gain / state.period;
      state.avgLoss += loss / state.period;
      if (state.count === state.period) {
        state.value = state.avgLoss === 0 ? 100 : 100 - (100 / (1 + state.avgGain / state.avgLoss));
      }
    } else {
      state.avgGain = (state.avgGain * (state.period - 1) + gain) / state.period;
      state.avgLoss = (state.avgLoss * (state.period - 1) + loss) / state.period;
      state.value = state.avgLoss === 0 ? 100 : 100 - (100 / (1 + state.avgGain / state.avgLoss));
    }
  }

  _updateEMA(state, close) {
    if (state.value === null) {
      state.value = close;
    } else {
      state.value = close * state.k + state.value * (1 - state.k);
    }
  }

  _updateATR(tr) {
    this.atr14.count++;
    if (this.atr14.count <= this.atr14.period) {
      this.atr14.value += tr / this.atr14.period;
    } else {
      this.atr14.value = (this.atr14.value * (this.atr14.period - 1) + tr) / this.atr14.period;
    }
  }

  getBB() {
    if (this.bbWindow.length < this.bbPeriod) return { upper: null, middle: null, lower: null };
    const mean = this.bbWindow.reduce((s, v) => s + v, 0) / this.bbPeriod;
    const variance = this.bbWindow.reduce((s, v) => s + (v - mean) ** 2, 0) / this.bbPeriod;
    const std = Math.sqrt(variance);
    return { upper: mean + 2 * std, middle: mean, lower: mean - 2 * std };
  }

  reset() {
    this.rsi3 = { period: 3, avgGain: 0, avgLoss: 0, count: 0, value: 50 };
    this.rsi6 = { period: 6, avgGain: 0, avgLoss: 0, count: 0, value: 50 };
    this.rsi14 = { period: 14, avgGain: 0, avgLoss: 0, count: 0, value: 50 };
    this.ema9 = { period: 9, value: null, k: 2 / 10 };
    this.ema20 = { period: 20, value: null, k: 2 / 21 };
    this.ema50 = { period: 50, value: null, k: 2 / 51 };
    this.bbWindow = [];
    this.atr14 = { period: 14, value: 0, count: 0 };
    this.volWindow = [];
    this.avgVolume = 0;
    this.consecutiveGreen = 0;
    this.consecutiveRed = 0;
    this.totalBars = 0;
    this.warmUpComplete = false;
  }
}

// ─── Strategy Implementation ───────────────────────────────────────────

export class ESMicroScalperStrategy extends BaseStrategy {
  static getDataRequirements() {
    return {
      candles: {
        baseSymbol: 'ES',
        quoteSymbols: ['CME_MINI:ES1!']
      },
      gex: { etfSymbol: 'SPY', futuresSymbol: 'ES', defaultMultiplier: 10.0 },
      lt: { symbol: 'CME_MINI:ES1!' },
      tradier: false,
      ivSkew: false
    };
  }

  constructor(params = {}) {
    super(params);

    this.defaultParams = {
      // Entry parameters
      targetPoints: 1.50,
      stopPoints: 1.50,

      // Trailing stop
      useTrailingStop: true,
      trailingTrigger: 0.75,
      trailingOffset: 0.50,

      // Signal management
      signalCooldownMs: 60000,
      maxHoldBars: 30,
      limitOrderTimeout: 5,

      // Symbol configuration
      tradingSymbol: 'ES',
      defaultQuantity: 1,

      // Session filtering (24/7 by default)
      useSessionFilter: false,
      allowedSessions: ['overnight', 'premarket', 'rth', 'afterhours'],

      // Force close at market close (disabled for 24/7)
      forceCloseAtMarketClose: false,

      // Pattern configuration
      // Active patterns (all enabled by default; set to subset after analysis)
      activePatterns: [
        'rsi3_extreme', 'rsi6_extreme',
        'consecutive_candles',
        'bb_touch',
        'ema20_deviation',
        'large_candle_fade',
        'gex_proximity',
        'lt_proximity',
        'volume_spike_rejection'
      ],

      // Pattern-specific thresholds
      rsi3OversoldThreshold: 10,
      rsi3OverboughtThreshold: 90,
      rsi6OversoldThreshold: 15,
      rsi6OverboughtThreshold: 85,
      consecutiveCandleMin: 3,
      ema20DeviationPoints: 3,
      largeCandleAtrMultiple: 2.0,
      gexProximityPoints: 2.0,
      ltProximityPoints: 2.0,
      volumeSpikeMultiplier: 2.0,
      rejectionWickPct: 0.6,

      // Composite mode: require N+ concurrent patterns for signal
      compositeMode: false,
      minConcurrentPatterns: 2,

      // Debug
      debug: false
    };

    this.params = { ...this.defaultParams, ...params };

    // Handle CLI parameter name mapping
    if (params.stopLossPoints !== undefined && params.stopPoints === undefined) {
      this.params.stopPoints = params.stopLossPoints;
    }

    // Initialize indicator state
    this.indicators = new IndicatorState();

    // Track previous candle internally for indicator updates
    this._prevCandle = null;
  }

  /**
   * Evaluate if a micro-scalp signal should be generated
   */
  evaluateSignal(candle, prevCandle, marketData, options = {}) {
    const debug = options.debug || this.params.debug;

    if (!isValidCandle(candle)) {
      if (debug) console.log('[ES_MICRO_SCALPER] Invalid candle');
      return null;
    }

    // Update indicators
    this.indicators.update(candle, this._prevCandle);
    this._prevCandle = candle;

    // Skip until warm-up complete
    if (!this.indicators.warmUpComplete) return null;

    // Check cooldown
    const cooldownMs = options.cooldownMs || this.params.signalCooldownMs;
    if (!this.checkCooldown(candle.timestamp, cooldownMs)) {
      if (debug) console.log('[ES_MICRO_SCALPER] In cooldown');
      return null;
    }

    // Check session filter
    if (this.params.useSessionFilter && !this.isAllowedSession(candle.timestamp)) {
      return null;
    }

    // Detect all active patterns
    const { gexLevels, ltLevels } = marketData || {};
    const detected = this.detectAllPatterns(candle, prevCandle, gexLevels, ltLevels);

    if (detected.long.length === 0 && detected.short.length === 0) {
      return null;
    }

    // Select best signal
    const signal = this.selectBestSignal(detected, candle, gexLevels, debug);
    if (!signal) return null;

    this.updateLastSignalTime(candle.timestamp);
    return signal;
  }

  /**
   * Detect all active patterns, returning separate long and short arrays
   */
  detectAllPatterns(candle, prevCandle, gexLevels, ltLevels) {
    const long = [];
    const short = [];
    const price = candle.close;
    const active = this.params.activePatterns;

    // Pattern 1: RSI(3) extreme
    if (active.includes('rsi3_extreme')) {
      if (this.indicators.rsi3.value < this.params.rsi3OversoldThreshold) {
        long.push({ name: 'rsi3_oversold', strength: this.params.rsi3OversoldThreshold - this.indicators.rsi3.value, rsi: this.indicators.rsi3.value });
      }
      if (this.indicators.rsi3.value > this.params.rsi3OverboughtThreshold) {
        short.push({ name: 'rsi3_overbought', strength: this.indicators.rsi3.value - this.params.rsi3OverboughtThreshold, rsi: this.indicators.rsi3.value });
      }
    }

    // Pattern 2: RSI(6) extreme
    if (active.includes('rsi6_extreme')) {
      if (this.indicators.rsi6.value < this.params.rsi6OversoldThreshold) {
        long.push({ name: 'rsi6_oversold', strength: this.params.rsi6OversoldThreshold - this.indicators.rsi6.value, rsi: this.indicators.rsi6.value });
      }
      if (this.indicators.rsi6.value > this.params.rsi6OverboughtThreshold) {
        short.push({ name: 'rsi6_overbought', strength: this.indicators.rsi6.value - this.params.rsi6OverboughtThreshold, rsi: this.indicators.rsi6.value });
      }
    }

    // Pattern 3: Consecutive candles (fade the run)
    if (active.includes('consecutive_candles')) {
      const minN = this.params.consecutiveCandleMin;
      if (this.indicators.consecutiveGreen >= minN) {
        short.push({ name: `consecutive_green_${this.indicators.consecutiveGreen}`, strength: this.indicators.consecutiveGreen - minN + 1 });
      }
      if (this.indicators.consecutiveRed >= minN) {
        long.push({ name: `consecutive_red_${this.indicators.consecutiveRed}`, strength: this.indicators.consecutiveRed - minN + 1 });
      }
    }

    // Pattern 4: Bollinger Band touch/pierce
    if (active.includes('bb_touch')) {
      const bb = this.indicators.getBB();
      if (bb.lower !== null) {
        if (price <= bb.lower) {
          long.push({ name: 'bb_lower_touch', strength: (bb.lower - price) / Math.max(bb.upper - bb.lower, 0.01) * 100 });
        }
        if (price >= bb.upper) {
          short.push({ name: 'bb_upper_touch', strength: (price - bb.upper) / Math.max(bb.upper - bb.lower, 0.01) * 100 });
        }
      }
    }

    // Pattern 5: EMA(20) deviation
    if (active.includes('ema20_deviation') && this.indicators.ema20.value !== null) {
      const deviation = price - this.indicators.ema20.value;
      const threshold = this.params.ema20DeviationPoints;
      if (deviation > threshold) {
        short.push({ name: `ema20_above_${threshold}pt`, strength: deviation - threshold, deviation });
      }
      if (deviation < -threshold) {
        long.push({ name: `ema20_below_${threshold}pt`, strength: (-deviation) - threshold, deviation });
      }
    }

    // Pattern 6: Large candle fade
    if (active.includes('large_candle_fade') && this.indicators.atr14.value > 0) {
      const body = Math.abs(candle.close - candle.open);
      const threshold = this.params.largeCandleAtrMultiple * this.indicators.atr14.value;
      if (body > threshold) {
        if (candle.close > candle.open) {
          short.push({ name: 'large_candle_bullish_fade', strength: body / this.indicators.atr14.value });
        } else {
          long.push({ name: 'large_candle_bearish_fade', strength: body / this.indicators.atr14.value });
        }
      }
    }

    // Pattern 7: GEX S1/R1 proximity
    if (active.includes('gex_proximity') && gexLevels) {
      const s1 = gexLevels.support?.[0];
      const r1 = gexLevels.resistance?.[0];
      const threshold = this.params.gexProximityPoints;
      if (s1 != null && Math.abs(price - s1) <= threshold) {
        long.push({ name: 'gex_s1_proximity', strength: threshold - Math.abs(price - s1), level: s1 });
      }
      if (r1 != null && Math.abs(price - r1) <= threshold) {
        short.push({ name: 'gex_r1_proximity', strength: threshold - Math.abs(price - r1), level: r1 });
      }
    }

    // Pattern 8: LT level proximity
    if (active.includes('lt_proximity') && ltLevels) {
      const levels = ltLevels.levels || [ltLevels.level_1, ltLevels.level_2, ltLevels.level_3, ltLevels.level_4, ltLevels.level_5].filter(v => v != null);
      const threshold = this.params.ltProximityPoints;
      for (let i = 0; i < levels.length; i++) {
        const level = levels[i];
        if (level == null) continue;
        const dist = Math.abs(price - level);
        if (dist <= threshold) {
          const side = price >= level ? long : short;
          side.push({ name: `lt_level_${i + 1}_proximity`, strength: threshold - dist, level });
        }
      }
    }

    // Pattern 9: Volume spike + reversal candle
    if (active.includes('volume_spike_rejection') && this.indicators.avgVolume > 0) {
      if (candle.volume > this.params.volumeSpikeMultiplier * this.indicators.avgVolume) {
        const range = candle.high - candle.low;
        if (range > 0) {
          const upperWick = candle.high - Math.max(candle.open, candle.close);
          const lowerWick = Math.min(candle.open, candle.close) - candle.low;

          if (upperWick / range > this.params.rejectionWickPct) {
            short.push({ name: 'volume_spike_rejection_top', strength: candle.volume / this.indicators.avgVolume });
          }
          if (lowerWick / range > this.params.rejectionWickPct) {
            long.push({ name: 'volume_spike_rejection_bottom', strength: candle.volume / this.indicators.avgVolume });
          }
        }
      }
    }

    return { long, short };
  }

  /**
   * Select the best signal from detected patterns
   */
  selectBestSignal(detected, candle, gexLevels, debug) {
    if (this.params.compositeMode) {
      // Require N+ concurrent patterns on the same side
      const minN = this.params.minConcurrentPatterns;
      let side = null;
      let patterns = [];

      if (detected.long.length >= minN) {
        side = 'buy';
        patterns = detected.long;
      } else if (detected.short.length >= minN) {
        side = 'sell';
        patterns = detected.short;
      }

      if (!side) {
        if (debug) console.log(`[ES_MICRO_SCALPER] Composite mode: need ${minN}+ patterns, got L:${detected.long.length} S:${detected.short.length}`);
        return null;
      }

      return this.generateSignal(candle, side, patterns, gexLevels);
    }

    // Single-pattern mode: strongest pattern wins
    const allLong = detected.long.sort((a, b) => b.strength - a.strength);
    const allShort = detected.short.sort((a, b) => b.strength - a.strength);

    let bestSide = null;
    let bestPattern = null;

    if (allLong.length > 0 && allShort.length > 0) {
      // Both sides have patterns - pick stronger
      if (allLong[0].strength >= allShort[0].strength) {
        bestSide = 'buy';
        bestPattern = allLong;
      } else {
        bestSide = 'sell';
        bestPattern = allShort;
      }
    } else if (allLong.length > 0) {
      bestSide = 'buy';
      bestPattern = allLong;
    } else if (allShort.length > 0) {
      bestSide = 'sell';
      bestPattern = allShort;
    }

    if (!bestSide) return null;

    if (debug) {
      console.log(`[ES_MICRO_SCALPER] Signal: ${bestSide.toUpperCase()} | patterns: ${bestPattern.map(p => p.name).join(', ')}`);
    }

    return this.generateSignal(candle, bestSide, bestPattern, gexLevels);
  }

  /**
   * Generate the signal object
   */
  generateSignal(candle, side, patterns, gexLevels) {
    const entryPrice = candle.close;
    let stopPrice, targetPrice;

    if (side === 'buy') {
      stopPrice = entryPrice - this.params.stopPoints;
      targetPrice = entryPrice + this.params.targetPoints;
    } else {
      stopPrice = entryPrice + this.params.stopPoints;
      targetPrice = entryPrice - this.params.targetPoints;
    }

    return {
      strategy: 'ES_MICRO_SCALPER',
      action: 'place_limit',
      side,
      symbol: this.params.tradingSymbol,
      price: roundTo(entryPrice),
      stop_loss: roundTo(stopPrice),
      take_profit: roundTo(targetPrice),
      quantity: this.params.defaultQuantity,
      timestamp: new Date(candle.timestamp).toISOString(),

      trailing_trigger: this.params.useTrailingStop ? this.params.trailingTrigger : null,
      trailing_offset: this.params.useTrailingStop ? this.params.trailingOffset : null,

      metadata: {
        patterns: patterns.map(p => p.name),
        pattern_count: patterns.length,
        strongest_pattern: patterns[0]?.name,
        strongest_strength: roundTo(patterns[0]?.strength || 0),
        target_points: this.params.targetPoints,
        stop_points: this.params.stopPoints,
        trailing_trigger: this.params.trailingTrigger,
        trailing_offset: this.params.trailingOffset,
        max_hold_bars: this.params.maxHoldBars,
        timeout_candles: this.params.limitOrderTimeout,
        rsi3: roundTo(this.indicators.rsi3.value),
        rsi6: roundTo(this.indicators.rsi6.value),
        rsi14: roundTo(this.indicators.rsi14.value),
        atr14: roundTo(this.indicators.atr14.value, 3),
        ema20: this.indicators.ema20.value ? roundTo(this.indicators.ema20.value) : null,
        session: this.getSession(candle.timestamp),
        gex_regime: gexLevels?.regime || 'unknown'
      }
    };
  }

  /**
   * Get the current trading session based on timestamp
   */
  getSession(timestamp) {
    const date = new Date(timestamp);
    const estString = date.toLocaleString('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric', minute: 'numeric', hour12: false
    });
    const [hourStr, minStr] = estString.split(':');
    const timeDecimal = parseInt(hourStr) + parseInt(minStr) / 60;

    if (timeDecimal >= 18 || timeDecimal < 4) return 'overnight';
    if (timeDecimal < 9.5) return 'premarket';
    if (timeDecimal < 16) return 'rth';
    return 'afterhours';
  }

  isAllowedSession(timestamp) {
    const currentSession = this.getSession(timestamp);
    return this.params.allowedSessions.includes(currentSession);
  }

  reset() {
    super.reset();
    this.indicators.reset();
    this._prevCandle = null;
  }

  getName() {
    return 'ES_MICRO_SCALPER';
  }

  getDescription() {
    return 'ES Micro-Scalper - captures 1-2 points using mean-reversion patterns across all sessions';
  }

  getRequiredMarketData() {
    return ['gexLevels'];
  }
}

export default ESMicroScalperStrategy;
