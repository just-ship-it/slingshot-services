/**
 * Order Flow Momentum Strategy
 *
 * Uses order flow data (CVD + Book Imbalance) as the PRIMARY signal generator.
 * Theory: Algorithmic traders leave footprints in order flow before price moves.
 *
 * Signal Generation:
 * - CVD slope change (momentum shift)
 * - Book imbalance alignment
 * - Combined confirmation for higher conviction
 *
 * This is fundamentally different from GEX strategies - we're not looking for
 * price levels, we're looking for order flow momentum shifts that precede moves.
 */

import { BaseStrategy } from './base-strategy.js';
import { isValidCandle } from './strategy-utils.js';
import { CVDCalculator } from '../indicators/cvd.js';
import { BookImbalanceCalculator } from '../indicators/book-imbalance.js';

export class OrderFlowMomentumStrategy extends BaseStrategy {
  constructor(params = {}) {
    super(params);

    this.defaultParams = {
      // CVD Signal Parameters
      cvdSlopeLookback: 5,           // Bars to calculate CVD slope
      cvdSlopeThreshold: 0.5,        // Minimum slope magnitude for signal
      cvdMomentumLookback: 10,       // Bars for momentum calculation
      cvdReversalConfirmBars: 2,     // Consecutive bars to confirm reversal

      // Book Imbalance Parameters
      imbalanceThreshold: 0.05,      // Minimum imbalance for confirmation
      imbalanceSlopeLookback: 3,     // Bars for imbalance trend
      requireImbalanceConfirm: true, // Require imbalance alignment

      // Signal Mode
      signalMode: 'cvd_reversal',    // 'cvd_reversal', 'cvd_momentum', 'imbalance_shift', 'combined'

      // Entry/Exit Parameters
      targetPoints: 15,              // Take profit target
      stopPoints: 8,                 // Stop loss
      maxHoldBars: 30,               // Max bars to hold position

      // Trailing Stop
      useTrailingStop: true,
      trailingTrigger: 8,            // Activate at 8 points profit
      trailingOffset: 4,             // Trail 4 points behind

      // Risk Management
      signalCooldownMs: 300000,      // 5 minutes between signals
      allowSimultaneous: false,

      // Symbol
      tradingSymbol: 'NQ1!',
      defaultQuantity: 1,

      // Session Filter
      useSessionFilter: true,
      allowedSessions: ['rth'],      // Regular trading hours only

      // Debug
      debug: false
    };

    this.params = { ...this.defaultParams, ...params };

    // Initialize CVD Calculator
    this.cvdCalculator = new CVDCalculator({
      slopeLookback: this.params.cvdSlopeLookback,
      divergenceLookback: this.params.cvdMomentumLookback
    });

    // Initialize Book Imbalance Calculator
    this.bookImbalanceCalculator = new BookImbalanceCalculator({
      slopeLookback: this.params.imbalanceSlopeLookback,
      minImbalanceThreshold: this.params.imbalanceThreshold
    });

    // Signal state tracking
    this.cvdHistory = [];
    this.imbalanceHistory = [];
    this.priceHistory = [];
    this.lastSignalDirection = null;
    this.consecutiveReversalBars = 0;
    this.lastCvdSlope = null;

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
   * Evaluate signal based on order flow momentum
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

    // Check session filter
    if (this.params.useSessionFilter && !this.isAllowedSession(candle.timestamp)) {
      return null;
    }

    // Get order flow data for this candle
    const candleTime = typeof candle.timestamp === 'number'
      ? candle.timestamp
      : new Date(candle.timestamp).getTime();

    const cvdData = this.cvdCalculator.getCVDAtTime(candleTime);
    const imbalanceData = this.bookImbalanceCalculator.getImbalanceAtTime(candleTime);

    // Process the data
    if (cvdData) {
      this.cvdCalculator.processCandle(cvdData);
    }
    if (imbalanceData) {
      this.bookImbalanceCalculator.processCandle(imbalanceData);
    }

    // Update history
    this.priceHistory.push(candle.close);
    if (this.priceHistory.length > 50) this.priceHistory.shift();

    // Get current order flow state
    const cvdSlope = this.cvdCalculator.getSlope(this.params.cvdSlopeLookback);
    const cvdMomentum = this.cvdCalculator.getMomentum(this.params.cvdMomentumLookback);
    const cvdValue = this.cvdCalculator.getCVD();

    const imbalance = this.bookImbalanceCalculator.getCurrentImbalance();
    const imbalanceSlope = this.bookImbalanceCalculator.getSlope(this.params.imbalanceSlopeLookback);
    const imbalanceStrength = this.bookImbalanceCalculator.getImbalanceStrength();

    if (debug) {
      console.log(`[OFM] CVD: slope=${cvdSlope?.toFixed(4)}, momentum=${cvdMomentum?.toFixed(4)}, value=${cvdValue?.toFixed(0)}`);
      console.log(`[OFM] Imbalance: ${imbalance?.toFixed(4)}, slope=${imbalanceSlope?.toFixed(4)}, strength=${imbalanceStrength}`);
    }

    // Generate signal based on mode
    let signal = null;

    switch (this.params.signalMode) {
      case 'cvd_reversal':
        signal = this.checkCVDReversal(cvdSlope, cvdMomentum, imbalance, imbalanceStrength, candle, debug);
        break;
      case 'cvd_momentum':
        signal = this.checkCVDMomentum(cvdSlope, cvdMomentum, imbalance, imbalanceStrength, candle, debug);
        break;
      case 'imbalance_shift':
        signal = this.checkImbalanceShift(imbalance, imbalanceSlope, imbalanceStrength, cvdSlope, candle, debug);
        break;
      case 'combined':
        signal = this.checkCombinedSignal(cvdSlope, cvdMomentum, imbalance, imbalanceSlope, imbalanceStrength, candle, debug);
        break;
      default:
        signal = this.checkCVDReversal(cvdSlope, cvdMomentum, imbalance, imbalanceStrength, candle, debug);
    }

    if (signal) {
      this.updateLastSignalTime(candle.timestamp);
      this.lastSignalDirection = signal.side;

      return this.generateSignalObject(candle, signal.side, signal.reason, {
        cvdSlope,
        cvdMomentum,
        cvdValue,
        imbalance,
        imbalanceSlope,
        imbalanceStrength
      });
    }

    // Track CVD slope for reversal detection
    this.lastCvdSlope = cvdSlope;

    return null;
  }

  /**
   * Check for CVD slope reversal (momentum shift)
   * Theory: When CVD slope changes from negative to positive, buyers are stepping in
   */
  checkCVDReversal(cvdSlope, cvdMomentum, imbalance, imbalanceStrength, candle, debug) {
    if (cvdSlope === null || this.lastCvdSlope === null) {
      return null;
    }

    const threshold = this.params.cvdSlopeThreshold;

    // Bullish reversal: CVD slope crosses from negative to positive
    if (this.lastCvdSlope < -threshold && cvdSlope > threshold) {
      // Check imbalance confirmation if required
      if (this.params.requireImbalanceConfirm) {
        if (imbalance < 0 || imbalanceStrength === 'strong_bearish' || imbalanceStrength === 'bearish') {
          if (debug) console.log(`[OFM] CVD bullish reversal blocked by bearish imbalance`);
          return null;
        }
      }

      if (debug) console.log(`[OFM] ✅ BULLISH CVD REVERSAL: slope ${this.lastCvdSlope.toFixed(4)} → ${cvdSlope.toFixed(4)}`);
      return { side: 'buy', reason: 'cvd_bullish_reversal' };
    }

    // Bearish reversal: CVD slope crosses from positive to negative
    if (this.lastCvdSlope > threshold && cvdSlope < -threshold) {
      // Check imbalance confirmation if required
      if (this.params.requireImbalanceConfirm) {
        if (imbalance > 0 || imbalanceStrength === 'strong_bullish' || imbalanceStrength === 'bullish') {
          if (debug) console.log(`[OFM] CVD bearish reversal blocked by bullish imbalance`);
          return null;
        }
      }

      if (debug) console.log(`[OFM] ✅ BEARISH CVD REVERSAL: slope ${this.lastCvdSlope.toFixed(4)} → ${cvdSlope.toFixed(4)}`);
      return { side: 'sell', reason: 'cvd_bearish_reversal' };
    }

    return null;
  }

  /**
   * Check for strong CVD momentum
   * Theory: Strong directional CVD momentum indicates institutional participation
   */
  checkCVDMomentum(cvdSlope, cvdMomentum, imbalance, imbalanceStrength, candle, debug) {
    if (cvdSlope === null || cvdMomentum === null) {
      return null;
    }

    const slopeThreshold = this.params.cvdSlopeThreshold * 2; // Higher threshold for momentum
    const momentumThreshold = 1.5;

    // Strong bullish momentum
    if (cvdSlope > slopeThreshold && cvdMomentum > momentumThreshold) {
      if (this.params.requireImbalanceConfirm && imbalance < -this.params.imbalanceThreshold) {
        return null;
      }

      if (debug) console.log(`[OFM] ✅ BULLISH MOMENTUM: slope=${cvdSlope.toFixed(4)}, momentum=${cvdMomentum.toFixed(4)}`);
      return { side: 'buy', reason: 'cvd_bullish_momentum' };
    }

    // Strong bearish momentum
    if (cvdSlope < -slopeThreshold && cvdMomentum < -momentumThreshold) {
      if (this.params.requireImbalanceConfirm && imbalance > this.params.imbalanceThreshold) {
        return null;
      }

      if (debug) console.log(`[OFM] ✅ BEARISH MOMENTUM: slope=${cvdSlope.toFixed(4)}, momentum=${cvdMomentum.toFixed(4)}`);
      return { side: 'sell', reason: 'cvd_bearish_momentum' };
    }

    return null;
  }

  /**
   * Check for book imbalance regime shift
   * Theory: Sudden shifts in bid/ask imbalance indicate institutional repositioning
   */
  checkImbalanceShift(imbalance, imbalanceSlope, imbalanceStrength, cvdSlope, candle, debug) {
    if (imbalance === null || imbalanceSlope === null) {
      return null;
    }

    const threshold = this.params.imbalanceThreshold * 2; // Strong imbalance required

    // Strong bullish imbalance with improving slope
    if (imbalance > threshold && imbalanceSlope > 0.01) {
      // Optionally require CVD alignment
      if (cvdSlope !== null && cvdSlope < -this.params.cvdSlopeThreshold) {
        if (debug) console.log(`[OFM] Bullish imbalance blocked by bearish CVD`);
        return null;
      }

      if (debug) console.log(`[OFM] ✅ BULLISH IMBALANCE SHIFT: imbalance=${imbalance.toFixed(4)}, slope=${imbalanceSlope.toFixed(4)}`);
      return { side: 'buy', reason: 'imbalance_bullish_shift' };
    }

    // Strong bearish imbalance with worsening slope
    if (imbalance < -threshold && imbalanceSlope < -0.01) {
      if (cvdSlope !== null && cvdSlope > this.params.cvdSlopeThreshold) {
        if (debug) console.log(`[OFM] Bearish imbalance blocked by bullish CVD`);
        return null;
      }

      if (debug) console.log(`[OFM] ✅ BEARISH IMBALANCE SHIFT: imbalance=${imbalance.toFixed(4)}, slope=${imbalanceSlope.toFixed(4)}`);
      return { side: 'sell', reason: 'imbalance_bearish_shift' };
    }

    return null;
  }

  /**
   * Check for combined CVD + Imbalance alignment
   * Theory: When both CVD and book imbalance agree, signal is higher conviction
   */
  checkCombinedSignal(cvdSlope, cvdMomentum, imbalance, imbalanceSlope, imbalanceStrength, candle, debug) {
    if (cvdSlope === null || imbalance === null) {
      return null;
    }

    const cvdThreshold = this.params.cvdSlopeThreshold;
    const imbalanceThreshold = this.params.imbalanceThreshold;

    // Bullish alignment: positive CVD slope + bullish imbalance
    if (cvdSlope > cvdThreshold && imbalance > imbalanceThreshold) {
      // Extra confirmation: imbalance improving
      if (imbalanceSlope !== null && imbalanceSlope > 0) {
        if (debug) console.log(`[OFM] ✅ BULLISH COMBINED: CVD slope=${cvdSlope.toFixed(4)}, imbalance=${imbalance.toFixed(4)}`);
        return { side: 'buy', reason: 'combined_bullish' };
      }
    }

    // Bearish alignment: negative CVD slope + bearish imbalance
    if (cvdSlope < -cvdThreshold && imbalance < -imbalanceThreshold) {
      // Extra confirmation: imbalance worsening
      if (imbalanceSlope !== null && imbalanceSlope < 0) {
        if (debug) console.log(`[OFM] ✅ BEARISH COMBINED: CVD slope=${cvdSlope.toFixed(4)}, imbalance=${imbalance.toFixed(4)}`);
        return { side: 'sell', reason: 'combined_bearish' };
      }
    }

    return null;
  }

  /**
   * Generate signal object
   */
  generateSignalObject(candle, side, reason, orderFlowState) {
    const price = candle.close;

    const stopLoss = side === 'buy'
      ? price - this.params.stopPoints
      : price + this.params.stopPoints;

    const takeProfit = side === 'buy'
      ? price + this.params.targetPoints
      : price - this.params.targetPoints;

    return {
      timestamp: candle.timestamp,
      strategy: 'ORDER_FLOW_MOMENTUM',
      action: 'place_limit',
      side: side,
      symbol: this.params.tradingSymbol,
      price: price,
      quantity: this.params.defaultQuantity,
      stopLoss: stopLoss,
      takeProfit: takeProfit,
      trailingTrigger: this.params.useTrailingStop ? this.params.trailingTrigger : null,
      trailingOffset: this.params.useTrailingStop ? this.params.trailingOffset : null,
      maxHoldBars: this.params.maxHoldBars,
      reason: reason,
      metadata: {
        signalMode: this.params.signalMode,
        orderFlowState: orderFlowState,
        entryPrice: price
      }
    };
  }

  /**
   * Get session based on timestamp (EST)
   */
  getSession(timestamp) {
    const date = new Date(timestamp);

    // Convert to EST
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

    // Session definitions (EST):
    // overnight:   6:00 PM - 4:00 AM (18:00 - 04:00)
    // premarket:   4:00 AM - 9:30 AM (04:00 - 09:30)
    // rth:         9:30 AM - 4:00 PM (09:30 - 16:00)
    // afterhours:  4:00 PM - 6:00 PM (16:00 - 18:00)

    if (timeDecimal >= 18 || timeDecimal < 4) {
      return 'overnight';
    } else if (timeDecimal >= 4 && timeDecimal < 9.5) {
      return 'premarket';
    } else if (timeDecimal >= 9.5 && timeDecimal < 16) {
      return 'rth';
    } else {
      return 'afterhours';
    }
  }

  /**
   * Check if current session is allowed
   */
  isAllowedSession(timestamp) {
    if (!this.params.useSessionFilter) {
      return true;
    }
    const currentSession = this.getSession(timestamp);
    return this.params.allowedSessions.includes(currentSession);
  }

  /**
   * Get strategy name
   */
  getName() {
    return 'Order Flow Momentum';
  }
}

export default OrderFlowMomentumStrategy;
