/**
 * LT Level Crossing Strategy
 *
 * NON-GEX PRIMARY STRATEGY: Uses Liquidity Trigger levels as primary signal.
 * GEX is used only as an optional filter, not the entry trigger.
 *
 * Core Logic (based on empirical analysis):
 * - Detect when price crosses ABOVE an LT level (upward crossing)
 * - Enter LONG when confirmed (price moves sufficiently above level)
 * - Optional sentiment filter: BULLISH sentiment shows ~54.5% accuracy
 *
 * This strategy complements the LT Failed Breakdown strategy:
 * - LT Failed Breakdown = Mean reversion (fade failed breakdowns)
 * - LT Level Crossing = Momentum (follow confirmed breakouts)
 *
 * GEX Filter (optional): Only trade when not near a strong GEX resistance level
 */

import { BaseStrategy } from './base-strategy.js';

export class LTLevelCrossingStrategy extends BaseStrategy {
  constructor(params = {}) {
    super(params);

    // LT Level Parameters
    this.params.crossingThreshold = params.crossingThreshold ?? 5;   // Points above level to confirm crossing
    this.params.momentumLookback = params.momentumLookback ?? 3;      // Candles to confirm momentum

    // Level Selection
    this.params.tradeLevels = params.tradeLevels ?? ['level_1', 'level_2', 'level_3', 'level_4', 'level_5'];
    this.params.preferLongTermLevels = params.preferLongTermLevels ?? false; // Prefer fib 377/610

    // Risk Management
    this.params.stopLossPoints = params.stopLossPoints ?? 15;
    this.params.takeProfitPoints = params.takeProfitPoints ?? 30;
    this.params.maxHoldBars = params.maxHoldBars ?? 40;

    // Trailing Stop
    this.params.useTrailingStop = params.useTrailingStop ?? true;
    this.params.trailingTrigger = params.trailingTrigger ?? 12;
    this.params.trailingOffset = params.trailingOffset ?? 6;

    // Signal Cooldown
    this.params.signalCooldownMs = params.signalCooldownMs ?? 900000; // 15 minutes

    // Session Filter
    this.params.useSessionFilter = params.useSessionFilter ?? false;
    this.params.allowedSessions = params.allowedSessions ?? ['rth', 'premarket', 'overnight', 'afterhours'];

    // Sentiment Filter (from LT data)
    this.params.useSentimentFilter = params.useSentimentFilter ?? true;
    this.params.requiredSentiment = params.requiredSentiment ?? 'BULLISH';

    // GEX Filter (optional - NOT primary signal)
    this.params.useGexFilter = params.useGexFilter ?? false;
    this.params.gexResistanceBuffer = params.gexResistanceBuffer ?? 20;

    // Symbol
    this.params.tradingSymbol = params.tradingSymbol ?? 'NQ';
    this.params.defaultQuantity = params.defaultQuantity ?? 1;

    // Debug
    this.params.debug = params.debug ?? false;

    // State tracking
    this.priceHistory = [];
    this.lastLevelState = new Map();  // levelKey -> 'above' | 'below'
    this.candleCount = 0;

    // LT data loader reference
    this.ltLevels = null;
    this.ltIndex = 0;
  }

  /**
   * Load LT levels data
   */
  loadLTData(ltData) {
    this.ltLevels = [...ltData].sort((a, b) => a.timestamp - b.timestamp);
    this.ltIndex = 0;

    if (this.params.debug) {
      console.log(`[LT-CROSS] Loaded ${this.ltLevels.length} LT level records`);
      if (this.ltLevels.length > 0) {
        const first = new Date(this.ltLevels[0].timestamp).toISOString();
        const last = new Date(this.ltLevels[this.ltLevels.length - 1].timestamp).toISOString();
        console.log(`[LT-CROSS] Date range: ${first} to ${last}`);
      }
    }
  }

  /**
   * Get LT levels at a specific timestamp
   */
  getLTAtTime(timestamp) {
    if (!this.ltLevels || this.ltLevels.length === 0) return null;

    while (this.ltIndex < this.ltLevels.length - 1 &&
           this.ltLevels[this.ltIndex + 1].timestamp <= timestamp) {
      this.ltIndex++;
    }

    if (this.ltLevels[this.ltIndex].timestamp > timestamp) {
      let idx = this.ltIndex;
      while (idx > 0 && this.ltLevels[idx].timestamp > timestamp) {
        idx--;
      }
      if (this.ltLevels[idx].timestamp <= timestamp) {
        return this.ltLevels[idx];
      }
      return null;
    }

    return this.ltLevels[this.ltIndex];
  }

  /**
   * Evaluate for level crossing signal
   */
  evaluateSignal(candle, prevCandle, marketData, options = {}) {
    const timestamp = this.toMs(candle.timestamp);
    const debug = this.params.debug || options.debug;

    this.candleCount++;

    if (debug && this.candleCount % 500 === 0) {
      console.log(`[LT-CROSS] evaluateSignal called ${this.candleCount} times, ltLevels: ${this.ltLevels?.length || 0}`);
    }

    // Check cooldown
    if (!this.checkCooldown(timestamp, this.params.signalCooldownMs)) {
      return null;
    }

    // Check session filter
    if (this.params.useSessionFilter && !this.isAllowedSession(timestamp)) {
      return null;
    }

    // Get current LT levels
    const ltData = this.getLTAtTime(timestamp);
    if (!ltData) {
      return null;
    }

    // Sentiment filter
    if (this.params.useSentimentFilter && ltData.sentiment !== this.params.requiredSentiment) {
      return null;
    }

    const currentPrice = candle.close;

    // Track previous price
    const prevPrice = this.priceHistory.length > 0 ?
      this.priceHistory[this.priceHistory.length - 1].price : null;

    // Update price history
    this.priceHistory.push({ timestamp, price: currentPrice, bar: this.candleCount });
    if (this.priceHistory.length > 30) {
      this.priceHistory.shift();
    }

    if (!prevPrice) return null;

    // Check for upward crossings
    const signal = this.checkUpwardCrossings(currentPrice, prevPrice, ltData, timestamp, debug);

    if (signal) {
      // Apply optional GEX filter
      if (!this.passesFilters(candle, marketData, debug)) {
        return null;
      }

      this.updateLastSignalTime(timestamp);
      return this.createSignal(candle, signal, ltData);
    }

    return null;
  }

  /**
   * Check for upward level crossings
   */
  checkUpwardCrossings(currentPrice, prevPrice, ltData, timestamp, debug) {
    const levels = this.getLevelsToCheck(ltData);

    if (debug && this.candleCount % 500 === 0) {
      console.log(`[LT-CROSS] checkUpwardCrossings #${this.candleCount}: levels.length=${levels.length}`);
    }

    for (const level of levels) {
      const levelValue = level.value;
      const levelKey = `${level.key}_${Math.round(levelValue)}`;

      // Detect UPWARD crossing: was below, now above (with threshold)
      if (prevPrice < levelValue - this.params.crossingThreshold &&
          currentPrice > levelValue + this.params.crossingThreshold) {

        if (debug) {
          console.log(`[LT-CROSS] ✅ Upward crossing: ${level.key} @ ${levelValue.toFixed(2)}`);
          console.log(`  Price: ${prevPrice.toFixed(2)} → ${currentPrice.toFixed(2)}`);
        }

        return {
          side: 'buy',
          levelKey: level.key,
          levelValue: levelValue,
          reason: 'upward_crossing',
          momentum: currentPrice - prevPrice
        };
      }
    }

    return null;
  }

  /**
   * Get levels to check for crossings
   */
  getLevelsToCheck(ltData) {
    const levels = [];
    const keys = ['level_1', 'level_2', 'level_3', 'level_4', 'level_5'];

    // Validate tradeLevels contains valid LT keys
    const tradeLevels = this.params.tradeLevels;
    const validLTKeys = tradeLevels && tradeLevels.length > 0 && tradeLevels.every(k => keys.includes(k));
    const levelsToUse = validLTKeys ? tradeLevels : keys;

    for (const key of keys) {
      if (!levelsToUse.includes(key)) continue;

      const value = ltData[key];
      if (value && !isNaN(value)) {
        levels.push({ key, value });
      }
    }

    if (this.params.preferLongTermLevels) {
      const filtered = levels.filter(l => l.key === 'level_4' || l.key === 'level_5');
      return filtered.length > 0 ? filtered : levels;
    }

    return levels;
  }

  /**
   * Apply optional GEX filter
   */
  passesFilters(candle, marketData, debug) {
    if (this.params.useGexFilter && marketData?.gexLevels) {
      const gex = marketData.gexLevels;
      const price = candle.close;

      const resistanceLevels = [
        gex.callWall,
        gex.gammaFlip,
        ...(gex.resistance || [])
      ].filter(l => l && !isNaN(l));

      for (const resistance of resistanceLevels) {
        if (Math.abs(price - resistance) < this.params.gexResistanceBuffer) {
          if (debug) console.log(`[LT-CROSS] Blocked: Near GEX resistance ${resistance.toFixed(2)}`);
          return false;
        }
      }
    }

    return true;
  }

  /**
   * Create signal object
   */
  createSignal(candle, signal, ltData) {
    const price = candle.close;

    const stopLoss = price - this.params.stopLossPoints;
    const takeProfit = price + this.params.takeProfitPoints;

    if (this.params.debug) {
      console.log(`[LT-CROSS] Signal: LONG at ${price.toFixed(2)}`);
      console.log(`  Reason: ${signal.reason}`);
      console.log(`  Level: ${signal.levelKey} @ ${signal.levelValue.toFixed(2)}`);
      console.log(`  Stop: ${stopLoss.toFixed(2)}, Target: ${takeProfit.toFixed(2)}`);
    }

    const signalObj = {
      timestamp: candle.timestamp,
      side: 'buy',
      price,
      strategy: 'LT_LEVEL_CROSSING',
      action: 'place_limit',
      symbol: this.params.tradingSymbol,
      quantity: this.params.defaultQuantity,
      stopLoss,
      takeProfit,
      maxHoldBars: this.params.maxHoldBars,

      // Signal metadata
      levelKey: signal.levelKey,
      levelValue: signal.levelValue,
      reason: signal.reason,
      momentum: signal.momentum,
      sentiment: ltData?.sentiment,

      // For bracket orders
      stop_loss: stopLoss,
      take_profit: takeProfit
    };

    if (this.params.useTrailingStop) {
      signalObj.trailingTrigger = this.params.trailingTrigger;
      signalObj.trailingOffset = this.params.trailingOffset;
      signalObj.trailing_trigger = this.params.trailingTrigger;
      signalObj.trailing_offset = this.params.trailingOffset;
    }

    return signalObj;
  }

  /**
   * Get session based on timestamp
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
    this.priceHistory = [];
    this.lastLevelState.clear();
    this.candleCount = 0;
    this.ltIndex = 0;
  }

  /**
   * Get strategy name
   */
  getName() {
    return 'LT Level Crossing';
  }
}

export default LTLevelCrossingStrategy;
