/**
 * Contrarian Order Flow Strategy
 *
 * Based on empirical analysis of real Databento data showing:
 * - Rising CVD is a SELL signal (institutions distributing to retail)
 * - Bearish divergence (price up, CVD down) is a SELL signal (58% edge)
 * - Ask absorption (price rising, balanced order book) is a SELL signal (59% edge)
 *
 * The edge is in SELLING into strength when order flow shows distribution.
 * This is classic institutional behavior - selling into retail buying.
 */

import { BaseStrategy } from './base-strategy.js';
import { isValidCandle } from './strategy-utils.js';
import { CVDCalculator } from '../indicators/cvd.js';
import { BookImbalanceCalculator } from '../indicators/book-imbalance.js';

export class ContrarianOrderFlowStrategy extends BaseStrategy {
  constructor(params = {}) {
    super(params);

    this.defaultParams = {
      // Signal Modes (can combine)
      useAskAbsorption: true,        // 59% edge - price rising but balanced book
      useBearishDivergence: true,    // 58% edge - price up, CVD down
      useRisingCVDSell: false,       // 58% edge but noisy - sell when CVD rising

      // CVD Parameters (matched to analysis)
      cvdSlopeLookback: 5,           // Bars for slope calculation
      cvdSlopeThreshold: 50,         // Minimum slope magnitude for divergence
      divergencePriceLookback: 5,    // Bars to measure price change
      divergencePriceThreshold: 0.6, // ~3 pts over 5 bars (matches analysis priceChange > 3)

      // Book Imbalance Parameters (matched to analysis)
      absorptionImbalanceMax: 0.03,  // Max imbalance for "absorption" (balanced book)
      absorptionMinVolume: 100000,   // Analysis used 100000, not 50000

      // Entry/Exit Parameters (symmetric for directional edge measurement)
      targetPoints: 50,              // Test symmetric 50/50 for directional edge
      stopPoints: 50,                // Test symmetric 50/50 for directional edge
      maxHoldBars: 120,              // 2 hours - give time for move to play out

      // Trailing Stop - disabled for clean directional measurement
      useTrailingStop: false,
      trailingTrigger: 10,           // Activate at 10 points profit
      trailingOffset: 5,             // Trail 5 points behind

      // Risk Management
      signalCooldownMs: 1800000,     // 30 minutes between signals (match lookforward)
      allowSimultaneous: false,

      // Session Filter
      useSessionFilter: true,
      allowedSessions: ['rth'],      // RTH only

      // Symbol
      tradingSymbol: 'NQ1!',
      defaultQuantity: 1,

      debug: false
    };

    this.params = { ...this.defaultParams, ...params };

    // Initialize calculators
    this.cvdCalculator = new CVDCalculator({
      slopeLookback: this.params.cvdSlopeLookback
    });

    this.bookImbalanceCalculator = new BookImbalanceCalculator({
      slopeLookback: 5
    });

    // History tracking
    this.priceHistory = [];
    this.cvdHistory = [];

    // Data loaded flags
    this.cvdDataLoaded = false;
    this.bookImbalanceDataLoaded = false;
  }

  /**
   * Load CVD data
   */
  loadCVDData(cvdMap) {
    if (cvdMap && cvdMap.size > 0) {
      this.cvdCalculator.loadPrecomputedCVD(cvdMap);
      this.cvdDataLoaded = true;
    }
  }

  /**
   * Load book imbalance data
   */
  loadBookImbalanceData(imbalanceMap) {
    if (imbalanceMap && imbalanceMap.size > 0) {
      this.bookImbalanceCalculator.loadPrecomputedImbalance(imbalanceMap);
      this.bookImbalanceDataLoaded = true;
    }
  }

  /**
   * Evaluate signal
   */
  evaluateSignal(candle, prevCandle, marketData, options = {}) {
    const debug = this.params.debug || options.debug;

    if (!isValidCandle(candle)) {
      return null;
    }

    // Check cooldown
    if (!this.checkCooldown(candle.timestamp, this.params.signalCooldownMs)) {
      return null;
    }

    // Check session
    if (this.params.useSessionFilter && !this.isAllowedSession(candle.timestamp)) {
      return null;
    }

    // Get order flow data
    const candleTime = typeof candle.timestamp === 'number'
      ? candle.timestamp
      : new Date(candle.timestamp).getTime();

    const cvdData = this.cvdCalculator.getCVDAtTime(candleTime);
    const imbalanceData = this.bookImbalanceCalculator.getImbalanceAtTime(candleTime);

    // Process data
    if (cvdData) {
      this.cvdCalculator.processCandle(cvdData);
      this.cvdHistory.push({
        timestamp: candleTime,
        cvd: cvdData.cumulativeDelta,
        delta: cvdData.delta
      });
      if (this.cvdHistory.length > 30) this.cvdHistory.shift();
    }

    if (imbalanceData) {
      this.bookImbalanceCalculator.processCandle(imbalanceData);
    }

    // Update price history
    this.priceHistory.push({ timestamp: candleTime, close: candle.close });
    if (this.priceHistory.length > 30) this.priceHistory.shift();

    // Need sufficient history
    if (this.priceHistory.length < 10 || this.cvdHistory.length < 10) {
      return null;
    }

    // Calculate metrics
    const cvdSlope = this.calculateSlope(this.cvdHistory.map(h => h.cvd), this.params.cvdSlopeLookback);
    const priceSlope = this.calculateSlope(this.priceHistory.map(h => h.close), this.params.divergencePriceLookback);

    const currentImbalance = imbalanceData?.sizeImbalance || 0;
    const totalVolume = (imbalanceData?.totalBidSize || 0) + (imbalanceData?.totalAskSize || 0);

    if (debug) {
      console.log(`[COF] CVD slope: ${cvdSlope?.toFixed(2)}, Price slope: ${priceSlope?.toFixed(4)}, Imbalance: ${currentImbalance?.toFixed(4)}, Volume: ${totalVolume}`);
    }

    // Check for SELL signals (the edge is in selling)
    let signal = null;
    let reason = null;

    // 1. Ask Absorption: Price rising but balanced order book (59% edge)
    if (this.params.useAskAbsorption) {
      const isAbsorption = Math.abs(currentImbalance) < this.params.absorptionImbalanceMax
        && totalVolume > this.params.absorptionMinVolume;
      const isPriceRising = priceSlope > this.params.divergencePriceThreshold;

      if (isAbsorption && isPriceRising) {
        signal = 'sell';
        reason = 'ask_absorption';
        if (debug) console.log(`[COF] ✅ ASK ABSORPTION: price rising (${priceSlope.toFixed(4)}) but balanced book (${currentImbalance.toFixed(4)})`);
      }
    }

    // 2. Bearish Divergence: Price rising but CVD falling (58% edge)
    if (!signal && this.params.useBearishDivergence) {
      const isPriceRising = priceSlope > this.params.divergencePriceThreshold;
      const isCVDFalling = cvdSlope < -this.params.cvdSlopeThreshold;

      if (isPriceRising && isCVDFalling) {
        signal = 'sell';
        reason = 'bearish_divergence';
        if (debug) console.log(`[COF] ✅ BEARISH DIVERGENCE: price up (${priceSlope.toFixed(4)}) but CVD down (${cvdSlope.toFixed(2)})`);
      }
    }

    // 3. Rising CVD Contrarian: CVD rising strongly = retail buying = sell (58% edge but noisy)
    if (!signal && this.params.useRisingCVDSell) {
      const isCVDRising = cvdSlope > this.params.cvdSlopeThreshold * 2; // Higher threshold for noise

      if (isCVDRising) {
        signal = 'sell';
        reason = 'rising_cvd_contrarian';
        if (debug) console.log(`[COF] ✅ RISING CVD CONTRARIAN: retail buying (CVD slope: ${cvdSlope.toFixed(2)})`);
      }
    }

    if (signal) {
      this.updateLastSignalTime(candle.timestamp);
      return this.generateSignalObject(candle, signal, reason, {
        cvdSlope,
        priceSlope,
        imbalance: currentImbalance,
        totalVolume
      });
    }

    return null;
  }

  /**
   * Calculate slope over N periods
   */
  calculateSlope(values, lookback) {
    if (values.length < lookback) return null;

    const recent = values.slice(-lookback);
    const n = recent.length;

    // Linear regression slope
    const xMean = (n - 1) / 2;
    const yMean = recent.reduce((a, b) => a + b, 0) / n;

    let numerator = 0;
    let denominator = 0;

    for (let i = 0; i < n; i++) {
      numerator += (i - xMean) * (recent[i] - yMean);
      denominator += (i - xMean) * (i - xMean);
    }

    return denominator === 0 ? 0 : numerator / denominator;
  }

  /**
   * Generate signal object
   */
  generateSignalObject(candle, side, reason, metrics) {
    const price = candle.close;

    // For SELL: stop above, target below
    const stopLoss = side === 'sell'
      ? price + this.params.stopPoints
      : price - this.params.stopPoints;

    const takeProfit = side === 'sell'
      ? price - this.params.targetPoints
      : price + this.params.targetPoints;

    return {
      timestamp: candle.timestamp,
      strategy: 'CONTRARIAN_ORDERFLOW',
      action: 'place_limit',
      side: side,
      symbol: this.params.tradingSymbol,
      price: price,
      quantity: this.params.defaultQuantity,
      stopLoss: stopLoss,
      takeProfit: takeProfit,
      stop_loss: stopLoss,
      take_profit: takeProfit,
      trailingTrigger: this.params.useTrailingStop ? this.params.trailingTrigger : null,
      trailingOffset: this.params.useTrailingStop ? this.params.trailingOffset : null,
      trailing_trigger: this.params.useTrailingStop ? this.params.trailingTrigger : null,
      trailing_offset: this.params.useTrailingStop ? this.params.trailingOffset : null,
      maxHoldBars: this.params.maxHoldBars,
      reason: reason,
      metadata: {
        reason,
        cvdSlope: metrics.cvdSlope,
        priceSlope: metrics.priceSlope,
        imbalance: metrics.imbalance,
        totalVolume: metrics.totalVolume
      }
    };
  }

  /**
   * Get session
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
   * Check session
   */
  isAllowedSession(timestamp) {
    if (!this.params.useSessionFilter) return true;
    return this.params.allowedSessions.includes(this.getSession(timestamp));
  }

  getName() {
    return 'Contrarian Order Flow';
  }
}

export default ContrarianOrderFlowStrategy;
