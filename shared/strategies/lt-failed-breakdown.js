/**
 * LT Failed Breakdown Strategy
 *
 * NON-GEX PRIMARY STRATEGY: Uses Liquidity Trigger levels as primary signal.
 * GEX is used only as an optional filter, not the entry trigger.
 *
 * Core Logic (based on empirical analysis):
 * - Detect when price crosses BELOW an LT level (downward crossing)
 * - Wait for price to return ABOVE the level (failed breakdown)
 * - Enter LONG when the failed breakdown is confirmed
 *
 * This strategy has shown:
 * - 54.9% win rate on failed downward crossings
 * - +2.56 pts average P&L per trade
 * - Better than pure continuation signals (which show ~44% WR)
 *
 * GEX Filter (optional): Only trade when not near a strong GEX resistance level
 */

import { BaseStrategy } from './base-strategy.js';

export class LTFailedBreakdownStrategy extends BaseStrategy {
  constructor(params = {}) {
    super(params);

    // LT Level Parameters
    this.params.crossingThreshold = params.crossingThreshold ?? 3;  // Points beyond level to confirm crossing
    this.params.returnThreshold = params.returnThreshold ?? 3;      // Points above level to confirm return
    this.params.maxReturnBars = params.maxReturnBars ?? 10;         // Max candles to wait for return

    // Level Selection
    this.params.tradeLevels = params.tradeLevels ?? ['level_1', 'level_2', 'level_3', 'level_4', 'level_5'];
    this.params.preferLongTermLevels = params.preferLongTermLevels ?? false; // Prefer fib 377/610

    // Risk Management
    this.params.stopLossPoints = params.stopLossPoints ?? 12;
    this.params.takeProfitPoints = params.takeProfitPoints ?? 24;
    this.params.maxHoldBars = params.maxHoldBars ?? 30;

    // Trailing Stop
    this.params.useTrailingStop = params.useTrailingStop ?? true;
    this.params.trailingTrigger = params.trailingTrigger ?? 8;
    this.params.trailingOffset = params.trailingOffset ?? 4;

    // Signal Cooldown
    this.params.signalCooldownMs = params.signalCooldownMs ?? 900000; // 15 minutes

    // Session Filter
    this.params.useSessionFilter = params.useSessionFilter ?? false;
    this.params.allowedSessions = params.allowedSessions ?? ['rth', 'premarket', 'overnight', 'afterhours'];

    // GEX Filter (optional - NOT primary signal)
    this.params.useGexFilter = params.useGexFilter ?? false;
    this.params.gexResistanceBuffer = params.gexResistanceBuffer ?? 20; // Avoid trades near GEX resistance

    // Sentiment Filter
    this.params.useSentimentFilter = params.useSentimentFilter ?? false;
    this.params.requiredSentiment = params.requiredSentiment ?? 'BULLISH';

    // Symbol
    this.params.tradingSymbol = params.tradingSymbol ?? 'NQ';
    this.params.defaultQuantity = params.defaultQuantity ?? 1;

    // Debug
    this.params.debug = params.debug ?? false;

    // State tracking - track breakdowns by level
    this.pendingBreakdowns = new Map(); // levelKey -> { timestamp, levelValue, breakdownPrice }
    this.priceHistory = [];             // Recent candle closes
    this.lastLTSnapshot = null;         // Last LT snapshot seen
    this.candleCount = 0;

    // LT data loader reference (set by backtest engine)
    this.ltLevels = null;
    this.ltIndex = 0;  // Current index in LT levels array
  }

  /**
   * Load LT levels data
   * @param {Object[]} ltData - Array of LT level records
   */
  loadLTData(ltData) {
    // Sort by timestamp
    this.ltLevels = [...ltData].sort((a, b) => a.timestamp - b.timestamp);
    this.ltIndex = 0;

    if (this.params.debug) {
      console.log(`[LT-FB] Loaded ${this.ltLevels.length} LT level records`);
      if (this.ltLevels.length > 0) {
        const first = new Date(this.ltLevels[0].timestamp).toISOString();
        const last = new Date(this.ltLevels[this.ltLevels.length - 1].timestamp).toISOString();
        console.log(`[LT-FB] Date range: ${first} to ${last}`);
      }
    }
  }

  /**
   * Get LT levels at a specific timestamp (advances internal index)
   * @param {number} timestamp - Timestamp in ms
   * @returns {Object|null} LT levels or null
   */
  getLTAtTime(timestamp) {
    if (!this.ltLevels || this.ltLevels.length === 0) return null;

    // Advance index to find the latest LT snapshot at or before timestamp
    while (this.ltIndex < this.ltLevels.length - 1 &&
           this.ltLevels[this.ltIndex + 1].timestamp <= timestamp) {
      this.ltIndex++;
    }

    // Make sure we're not past the timestamp
    if (this.ltLevels[this.ltIndex].timestamp > timestamp) {
      // Look back for a valid entry
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
   * Evaluate for failed breakdown signal
   */
  evaluateSignal(candle, prevCandle, marketData, options = {}) {
    const timestamp = this.toMs(candle.timestamp);
    const debug = this.params.debug || options.debug;

    this.candleCount++;

    // DEBUG: Log every 500 candles to show evaluateSignal is being called
    if (debug && this.candleCount % 500 === 0) {
      console.log(`[LT-FB] evaluateSignal called ${this.candleCount} times, ltLevels: ${this.ltLevels?.length || 0}, priceHistory: ${this.priceHistory.length}`);
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
      if (debug && this.candleCount % 100 === 0) {
        console.log(`[LT-FB] No LT data at ${new Date(timestamp).toISOString()}`);
      }
      return null;
    }

    const currentPrice = candle.close;

    // Track previous price for crossing detection
    const prevPrice = this.priceHistory.length > 0 ?
      this.priceHistory[this.priceHistory.length - 1].price : null;

    // Update price history
    this.priceHistory.push({ timestamp, price: currentPrice, bar: this.candleCount });
    if (this.priceHistory.length > 30) {
      this.priceHistory.shift();
    }

    // Check for new breakdowns AND failed breakdown recoveries
    const signal = this.processLevels(currentPrice, prevPrice, ltData, timestamp, debug);

    if (signal) {
      // Apply optional filters
      if (!this.passesFilters(candle, marketData, signal, debug)) {
        return null;
      }

      this.updateLastSignalTime(timestamp);
      return this.createSignal(candle, signal, ltData);
    }

    return null;
  }

  /**
   * Process all LT levels for breakdowns and recoveries
   */
  processLevels(currentPrice, prevPrice, ltData, timestamp, debug) {
    if (!prevPrice) return null;

    const levels = this.getLevelsToCheck(ltData);

    // DEBUG: Log price vs levels periodically
    if (this.candleCount % 500 === 0) {
      console.log(`[LT-FB] processLevels #${this.candleCount}: prevPrice=${prevPrice?.toFixed(2)}, currentPrice=${currentPrice?.toFixed(2)}, levels.length=${levels.length}, ltData=${ltData ? 'yes' : 'no'}`);
    }

    // First, check for new breakdowns
    for (const level of levels) {
      const levelValue = level.value;
      const levelKey = `${level.key}_${Math.round(levelValue)}`;

      // Skip if already tracking this level
      if (this.pendingBreakdowns.has(levelKey)) continue;

      // Detect DOWNWARD crossing: was above, now below
      if (prevPrice > levelValue + this.params.crossingThreshold &&
          currentPrice < levelValue - this.params.crossingThreshold) {

        if (debug) {
          console.log(`[LT-FB] Breakdown: ${level.key} @ ${levelValue.toFixed(2)} | price: ${prevPrice.toFixed(2)} → ${currentPrice.toFixed(2)}`);
        }

        this.pendingBreakdowns.set(levelKey, {
          timestamp,
          bar: this.candleCount,
          levelKey: level.key,
          levelValue,
          breakdownPrice: currentPrice
        });
      }
    }

    // Second, check for failed breakdowns (price returned above level)
    for (const [key, breakdown] of this.pendingBreakdowns) {
      const levelValue = breakdown.levelValue;
      const barsElapsed = this.candleCount - breakdown.bar;

      // Timeout - remove stale breakdowns
      if (barsElapsed > this.params.maxReturnBars) {
        this.pendingBreakdowns.delete(key);
        continue;
      }

      // Check if price returned ABOVE the level
      if (currentPrice > levelValue + this.params.returnThreshold) {
        if (debug) {
          console.log(`[LT-FB] ✅ FAILED BREAKDOWN! Level: ${breakdown.levelKey} @ ${levelValue.toFixed(2)}`);
          console.log(`        Broke at bar ${breakdown.bar}, returned at bar ${this.candleCount} (${barsElapsed} bars)`);
        }

        // Clear this breakdown
        this.pendingBreakdowns.delete(key);

        return {
          side: 'buy',
          levelKey: breakdown.levelKey,
          levelValue: levelValue,
          reason: 'failed_breakdown',
          barsToReturn: barsElapsed
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

    // Use internal tradeLevels (this.params.tradeLevels might be overridden by CLI with incompatible GEX values)
    // Check if tradeLevels contains valid LT level keys
    const tradeLevels = this.params.tradeLevels;
    const validLTKeys = tradeLevels && tradeLevels.length > 0 && tradeLevels.every(k => keys.includes(k));
    const levelsToUse = validLTKeys ? tradeLevels : keys; // Default to all levels if invalid

    for (const key of keys) {
      if (!levelsToUse.includes(key)) continue;

      const value = ltData[key];
      if (value && !isNaN(value)) {
        levels.push({ key, value });
      }
    }

    // Optionally prefer long-term levels (fib 377/610 = level_4/5)
    if (this.params.preferLongTermLevels) {
      const filtered = levels.filter(l => l.key === 'level_4' || l.key === 'level_5');
      return filtered.length > 0 ? filtered : levels;
    }

    return levels;
  }

  /**
   * Apply optional filters
   */
  passesFilters(candle, marketData, signal, debug) {
    // GEX Filter: Avoid trades near resistance
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
          if (debug) console.log(`[LT-FB] Blocked: Near GEX resistance ${resistance.toFixed(2)}`);
          return false;
        }
      }
    }

    // Sentiment Filter (from LT data)
    if (this.params.useSentimentFilter) {
      const ltData = this.getLTAtTime(this.toMs(candle.timestamp));
      if (ltData && ltData.sentiment !== this.params.requiredSentiment) {
        if (debug) console.log(`[LT-FB] Blocked: Sentiment ${ltData.sentiment} != ${this.params.requiredSentiment}`);
        return false;
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
      console.log(`[LT-FB] Signal: LONG at ${price.toFixed(2)}`);
      console.log(`  Reason: ${signal.reason}`);
      console.log(`  Level: ${signal.levelKey} @ ${signal.levelValue.toFixed(2)}`);
      console.log(`  Stop: ${stopLoss.toFixed(2)}, Target: ${takeProfit.toFixed(2)}`);
    }

    const signalObj = {
      timestamp: candle.timestamp,
      side: 'buy',
      price,
      strategy: 'LT_FAILED_BREAKDOWN',
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
      barsToReturn: signal.barsToReturn,
      sentiment: ltData?.sentiment,

      // For bracket orders (snake_case for trade orchestrator)
      stop_loss: stopLoss,
      take_profit: takeProfit
    };

    // Add trailing stop if enabled
    if (this.params.useTrailingStop) {
      signalObj.trailingTrigger = this.params.trailingTrigger;
      signalObj.trailingOffset = this.params.trailingOffset;
      signalObj.trailing_trigger = this.params.trailingTrigger;
      signalObj.trailing_offset = this.params.trailingOffset;
    }

    return signalObj;
  }

  /**
   * Get session based on timestamp (EST)
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
    this.pendingBreakdowns.clear();
    this.lastLTSnapshot = null;
    this.candleCount = 0;
    this.ltIndex = 0;
  }

  /**
   * Get strategy name
   */
  getName() {
    return 'LT Failed Breakdown';
  }
}

export default LTFailedBreakdownStrategy;
