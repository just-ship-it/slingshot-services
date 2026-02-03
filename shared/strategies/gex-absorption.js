/**
 * GEX Absorption Strategy
 *
 * Trades reversals at outer GEX levels (S2+/R2+) when order flow shows absorption.
 *
 * Key Discovery: When price approaches outer GEX levels while the order book shows
 * ABSORPTION (balanced despite directional pressure), reversal probability is very high.
 *
 * Walk-Forward Validated Performance (Q1-Q4 2025):
 * - Q1 2025 (Training): 84.8% win rate, +$30.85/trade
 * - Q2-Q4 2025 (Validation): 83.5% win rate, +$30.10/trade
 *
 * Best Level Types:
 * - S3: 97% win rate | R3: 96% win rate
 * - S2: 92% win rate | R4: 94% win rate
 * - Avoid S1/R1 (R1 has inverse edge at 44%)
 *
 * Entry Logic:
 * - LONG: Price falling to S2/S3/S4, book imbalance balanced (absorption)
 * - SHORT: Price rising to R2/R3/R4, book imbalance balanced (absorption)
 */

import { BaseStrategy } from './base-strategy.js';

export class GexAbsorptionStrategy extends BaseStrategy {
  constructor(params = {}) {
    super(params);

    this.defaultParams = {
      // Level proximity
      levelProximityThreshold: 20,  // Points from level to consider "at level"

      // Price slope thresholds
      minPriceSlopeForSupport: -0.3,   // Price must be falling to support
      minPriceSlopeForResistance: 0.3, // Price must be rising to resistance
      priceSlopeLookback: 5,           // Candles for slope calculation

      // Absorption detection (book imbalance)
      maxAbsorptionImbalance: 0.06,    // |imbalance| < 0.06 = balanced (absorption)
      minBookVolume: 40000,            // Minimum total book size for valid signal

      // Exit parameters
      stopLossPoints: 20,
      takeProfitPoints: 40,
      maxHoldBars: 120,                // 2 hours on 1m chart

      // Trailing stop (optional)
      useTrailingStop: false,
      trailingTrigger: 20,
      trailingOffset: 10,

      // Signal management
      signalCooldownMs: 1800000,       // 30 minutes between signals

      // Level filtering
      useOuterLevelsOnly: true,        // Only trade S2+/R2+ (skip S1/R1)
      tradeSupportLevels: [2, 3, 4],   // Which support levels to trade
      tradeResistanceLevels: [2, 3, 4], // Which resistance levels to trade
      tradeWalls: false,               // Trade put_wall/call_wall (lower win rate)

      // Session filtering
      useSessionFilter: true,
      allowedSessions: ['rth'],        // Regular trading hours only

      // Direction filtering
      allowLongs: true,
      allowShorts: true,

      // Symbol
      tradingSymbol: 'NQ1!',
      defaultQuantity: 1
    };

    this.params = { ...this.defaultParams, ...params };

    // Price history for slope calculation
    this.priceHistory = [];

    // Book imbalance data (loaded by backtest engine)
    this.bookImbalanceMap = null;
    this.bookImbalanceDataLoaded = false;
  }

  /**
   * Load precomputed book imbalance data
   */
  loadBookImbalanceData(bookImbalanceMap) {
    this.bookImbalanceMap = bookImbalanceMap;
    this.bookImbalanceDataLoaded = true;
  }

  /**
   * Get book imbalance for a timestamp
   */
  getBookImbalance(timestamp) {
    if (!this.bookImbalanceMap) return null;
    return this.bookImbalanceMap.get(timestamp);
  }

  /**
   * Calculate price slope over lookback period
   */
  calculatePriceSlope(lookback) {
    if (this.priceHistory.length < lookback) return null;

    const recent = this.priceHistory.slice(-lookback);
    const n = recent.length;
    const xMean = (n - 1) / 2;
    const yMean = recent.reduce((a, b) => a + b, 0) / n;

    let num = 0, den = 0;
    for (let i = 0; i < n; i++) {
      num += (i - xMean) * (recent[i] - yMean);
      den += (i - xMean) * (i - xMean);
    }

    return den === 0 ? 0 : num / den;
  }

  /**
   * Check if timestamp is in allowed session
   */
  isInAllowedSession(timestamp) {
    if (!this.params.useSessionFilter) return true;

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

    const sessions = this.params.allowedSessions || ['rth'];

    for (const session of sessions) {
      if (session === 'overnight' && (timeDecimal >= 18 || timeDecimal < 4)) return true;
      if (session === 'premarket' && timeDecimal >= 4 && timeDecimal < 9.5) return true;
      if (session === 'rth' && timeDecimal >= 9.5 && timeDecimal < 16) return true;
      if (session === 'afterhours' && timeDecimal >= 16 && timeDecimal < 18) return true;
    }

    return false;
  }

  /**
   * Find nearest outer GEX level
   */
  findNearestLevel(price, gexLevels, side) {
    if (!gexLevels) return null;

    const levels = [];
    const threshold = this.params.levelProximityThreshold;

    if (side === 'support') {
      // Check support levels (S2, S3, S4, etc.)
      const supportLevels = this.params.tradeSupportLevels || [2, 3, 4];
      const support = gexLevels.support || [];

      for (const levelNum of supportLevels) {
        const idx = levelNum - 1; // 0-indexed
        if (support[idx]) {
          const dist = Math.abs(price - support[idx]);
          if (dist <= threshold) {
            levels.push({ level: support[idx], type: `S${levelNum}`, distance: dist });
          }
        }
      }

      // Check put_wall if enabled
      if (this.params.tradeWalls && gexLevels.putWall) {
        const dist = Math.abs(price - gexLevels.putWall);
        if (dist <= threshold) {
          levels.push({ level: gexLevels.putWall, type: 'PUT_WALL', distance: dist });
        }
      }
    } else {
      // Check resistance levels (R2, R3, R4, etc.)
      const resistanceLevels = this.params.tradeResistanceLevels || [2, 3, 4];
      const resistance = gexLevels.resistance || [];

      for (const levelNum of resistanceLevels) {
        const idx = levelNum - 1;
        if (resistance[idx]) {
          const dist = Math.abs(price - resistance[idx]);
          if (dist <= threshold) {
            levels.push({ level: resistance[idx], type: `R${levelNum}`, distance: dist });
          }
        }
      }

      // Check call_wall if enabled
      if (this.params.tradeWalls && gexLevels.callWall) {
        const dist = Math.abs(price - gexLevels.callWall);
        if (dist <= threshold) {
          levels.push({ level: gexLevels.callWall, type: 'CALL_WALL', distance: dist });
        }
      }
    }

    // Return nearest level
    if (levels.length === 0) return null;
    return levels.reduce((nearest, l) => l.distance < nearest.distance ? l : nearest);
  }

  /**
   * Check if book shows absorption (balanced despite directional pressure)
   */
  checkAbsorption(bookData) {
    if (!bookData || bookData.updates < 100) return { isAbsorption: false };

    const imbalance = bookData.sizeImbalance;
    const totalVolume = (bookData.totalBidSize || 0) + (bookData.totalAskSize || 0);

    const isBalanced = Math.abs(imbalance) < this.params.maxAbsorptionImbalance;
    const hasVolume = totalVolume >= this.params.minBookVolume;

    return {
      isAbsorption: isBalanced && hasVolume,
      imbalance,
      totalVolume,
      isBalanced,
      hasVolume
    };
  }

  /**
   * Evaluate signal
   */
  evaluateSignal(candle, prevCandle, marketData, options = {}) {
    const debug = options.debug || this.params.debug;

    // Update price history
    this.priceHistory.push(candle.close);
    if (this.priceHistory.length > 50) this.priceHistory.shift();

    // Check session filter
    if (!this.isInAllowedSession(candle.timestamp)) {
      return null;
    }

    // Check cooldown
    if (!this.checkCooldown(candle.timestamp, this.params.signalCooldownMs)) {
      return null;
    }

    // Need enough price history
    if (this.priceHistory.length < this.params.priceSlopeLookback) {
      return null;
    }

    // Need GEX levels
    const gexLevels = marketData.gexLevels;
    if (!gexLevels) {
      return null;
    }

    // Get book imbalance data
    const bookData = this.getBookImbalance(candle.timestamp);

    // Calculate price slope
    const priceSlope = this.calculatePriceSlope(this.params.priceSlopeLookback);

    // Check for LONG signal (support absorption)
    if (this.params.allowLongs && priceSlope < this.params.minPriceSlopeForSupport) {
      const nearestSupport = this.findNearestLevel(candle.close, gexLevels, 'support');

      if (nearestSupport) {
        const absorption = this.checkAbsorption(bookData);

        if (debug) {
          console.log(`[ABSORPTION] LONG check @ ${candle.close}: Level=${nearestSupport.type} @ ${nearestSupport.level} (dist=${nearestSupport.distance.toFixed(1)}), absorption=${absorption.isAbsorption} (imb=${absorption.imbalance?.toFixed(4)}, vol=${absorption.totalVolume})`);
        }

        if (absorption.isAbsorption) {
          const signal = this.createSignal('buy', candle, nearestSupport, absorption, gexLevels);
          this.updateLastSignalTime(candle.timestamp);
          return signal;
        }
      }
    }

    // Check for SHORT signal (resistance absorption)
    if (this.params.allowShorts && priceSlope > this.params.minPriceSlopeForResistance) {
      const nearestResistance = this.findNearestLevel(candle.close, gexLevels, 'resistance');

      if (nearestResistance) {
        const absorption = this.checkAbsorption(bookData);

        if (debug) {
          console.log(`[ABSORPTION] SHORT check @ ${candle.close}: Level=${nearestResistance.type} @ ${nearestResistance.level} (dist=${nearestResistance.distance.toFixed(1)}), absorption=${absorption.isAbsorption} (imb=${absorption.imbalance?.toFixed(4)}, vol=${absorption.totalVolume})`);
        }

        if (absorption.isAbsorption) {
          const signal = this.createSignal('sell', candle, nearestResistance, absorption, gexLevels);
          this.updateLastSignalTime(candle.timestamp);
          return signal;
        }
      }
    }

    return null;
  }

  /**
   * Create signal object
   */
  createSignal(side, candle, levelInfo, absorption, gexLevels) {
    const entryPrice = candle.close;

    let stopLoss, takeProfit;
    if (side === 'buy') {
      stopLoss = entryPrice - this.params.stopLossPoints;
      takeProfit = entryPrice + this.params.takeProfitPoints;
    } else {
      stopLoss = entryPrice + this.params.stopLossPoints;
      takeProfit = entryPrice - this.params.takeProfitPoints;
    }

    const signal = {
      strategy: 'GEX_ABSORPTION',
      action: 'place_limit',
      side: side,
      symbol: this.params.tradingSymbol,
      price: entryPrice,
      entryPrice: entryPrice,
      stopLoss: stopLoss,
      takeProfit: takeProfit,
      quantity: this.params.defaultQuantity,
      maxHoldBars: this.params.maxHoldBars,
      timestamp: candle.timestamp,

      // Metadata for analysis
      levelType: levelInfo.type,
      levelPrice: levelInfo.level,
      levelDistance: levelInfo.distance,
      bookImbalance: absorption.imbalance,
      bookVolume: absorption.totalVolume,
      regime: gexLevels.regime
    };

    // Add trailing stop if enabled
    if (this.params.useTrailingStop) {
      signal.trailingTrigger = this.params.trailingTrigger;
      signal.trailingOffset = this.params.trailingOffset;
    }

    return signal;
  }

  /**
   * Reset strategy state
   */
  reset() {
    super.reset();
    this.priceHistory = [];
  }
}

export default GexAbsorptionStrategy;
