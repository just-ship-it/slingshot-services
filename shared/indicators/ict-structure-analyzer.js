/**
 * ICT Structure Analyzer
 *
 * Aggregates all ICT structure detection components into a unified analysis.
 * This is the main entry point for ICT market structure analysis.
 *
 * Components:
 * - CHoCH Detector: Change of Character (first sign of reversal)
 * - MSS Detector: Market Structure Shift (trend confirmation)
 * - Order Block Detector: Supply/demand zones
 * - FVG Detection: Fair Value Gaps (using existing ImbalanceDetector)
 */

import { CHoCHDetector } from './ict/choch-detector.js';
import { MSSDetector } from './ict/mss-detector.js';
import { OrderBlockDetector } from './ict/order-block-detector.js';

export class ICTStructureAnalyzer {
  constructor(options = {}) {
    this.options = {
      // CHoCH settings
      choch: {
        swingLookback: 5,
        minSwingSize: 10,
        breakConfirmation: 2,
        ...options.choch
      },

      // MSS settings
      mss: {
        breakBuffer: 2,
        requireCandleClose: true,
        swingLookback: 5,
        ...options.mss
      },

      // Order Block settings
      orderBlock: {
        minImpulseSize: 15,
        maxOrderBlockAge: 48,
        mitigationThreshold: 0.5,
        ...options.orderBlock
      },

      ...options
    };

    // Initialize detectors
    this.chochDetector = new CHoCHDetector(this.options.choch);
    this.mssDetector = new MSSDetector(this.options.mss);
    this.obDetector = new OrderBlockDetector(this.options.orderBlock);

    // State
    this.currentBias = null;           // 'bullish' | 'bearish' | 'neutral'
    this.lastCHoCH = null;
    this.lastMSS = null;
    this.structureHistory = [];
    this.analysisCache = null;
  }

  /**
   * Reset all detectors and state
   */
  reset() {
    this.chochDetector.reset();
    this.mssDetector.reset();
    this.obDetector.reset();
    this.currentBias = null;
    this.lastCHoCH = null;
    this.lastMSS = null;
    this.structureHistory = [];
    this.analysisCache = null;
  }

  /**
   * Full structure analysis on candles
   * @param {Object[]} candles - Candle array (should be higher timeframe like 4H)
   * @param {number|null} currentTime - Current timestamp for age filtering
   * @returns {Object} Complete structure analysis
   */
  analyzeStructure(candles, currentTime = null) {
    if (!candles || candles.length < 15) {
      return {
        bias: 'neutral',
        choch: null,
        mss: null,
        orderBlocks: [],
        swingHigh: null,
        swingLow: null,
        structureLevel: null,
        confidence: 0
      };
    }

    const timestamp = currentTime || candles[candles.length - 1].timestamp;

    // 1. Detect CHoCH
    const choch = this.chochDetector.analyze(candles);
    if (choch) {
      this.lastCHoCH = choch;
      this.structureHistory.push({
        type: 'choch',
        event: choch,
        timestamp: choch.timestamp
      });
    }

    // 2. Detect MSS (with CHoCH context if available)
    const mss = this.mssDetector.analyze(candles, this.lastCHoCH);
    if (mss) {
      this.lastMSS = mss;
      this.structureHistory.push({
        type: 'mss',
        event: mss,
        timestamp: mss.timestamp
      });
    }

    // 3. Detect Order Blocks
    const orderBlocks = this.obDetector.detectOrderBlocks(candles, timestamp);

    // 4. Update bias based on structure events
    this.updateBias(choch, mss);

    // 5. Get current swing points from CHoCH detector
    const chochState = this.chochDetector.getState();
    const swingHigh = chochState.swingHighs[chochState.swingHighs.length - 1] || null;
    const swingLow = chochState.swingLows[chochState.swingLows.length - 1] || null;

    // 6. Determine key structure level (for stop placement)
    const structureLevel = this.getKeyStructureLevel(chochState, this.currentBias);

    // 7. Calculate confidence
    const confidence = this.calculateConfidence(choch, mss, orderBlocks);

    // Cache the analysis
    this.analysisCache = {
      bias: this.currentBias,
      choch: choch,
      mss: mss,
      orderBlocks: orderBlocks,
      swingHigh: swingHigh,
      swingLow: swingLow,
      structureLevel: structureLevel,
      trend: chochState.trend,
      confidence: confidence,
      timestamp: timestamp
    };

    return this.analysisCache;
  }

  /**
   * Update market bias based on structure events
   * @param {Object|null} choch
   * @param {Object|null} mss
   */
  updateBias(choch, mss) {
    // MSS takes priority as it's confirmation
    if (mss) {
      this.currentBias = mss.direction;
      return;
    }

    // CHoCH provides initial bias hint
    if (choch) {
      this.currentBias = choch.type;  // 'bullish' or 'bearish'
      return;
    }

    // Keep existing bias if no new signals
    // Or use CHoCH detector's trend analysis
    const chochState = this.chochDetector.getState();
    if (chochState.trend && chochState.trend !== 'neutral') {
      this.currentBias = chochState.trend;
    }
  }

  /**
   * Get the key structure level for stop placement
   * @param {Object} chochState
   * @param {string} bias
   * @returns {Object|null}
   */
  getKeyStructureLevel(chochState, bias) {
    if (bias === 'bullish') {
      // For bullish bias, structure level is the swing low
      // Stop should be below this level
      const swingLows = chochState.swingLows;
      if (swingLows.length > 0) {
        return {
          type: 'swing_low',
          price: swingLows[swingLows.length - 1].price,
          timestamp: swingLows[swingLows.length - 1].timestamp,
          stopSide: 'below'
        };
      }
    } else if (bias === 'bearish') {
      // For bearish bias, structure level is the swing high
      // Stop should be above this level
      const swingHighs = chochState.swingHighs;
      if (swingHighs.length > 0) {
        return {
          type: 'swing_high',
          price: swingHighs[swingHighs.length - 1].price,
          timestamp: swingHighs[swingHighs.length - 1].timestamp,
          stopSide: 'above'
        };
      }
    }

    return null;
  }

  /**
   * Calculate confidence score for current analysis
   * @param {Object|null} choch
   * @param {Object|null} mss
   * @param {Object[]} orderBlocks
   * @returns {number} Confidence 0-100
   */
  calculateConfidence(choch, mss, orderBlocks) {
    let confidence = 0;

    // CHoCH detected adds 30 points
    if (choch) {
      confidence += 30;
      // Stronger CHoCH adds more
      if (choch.strength > 20) confidence += 10;
    }

    // MSS confirmed adds 40 points
    if (mss) {
      confidence += 40;
      // MSS with CHoCH confirmation adds more
      if (mss.confirmsChoch) confidence += 10;
    }

    // Relevant order blocks add confidence
    const relevantOBs = orderBlocks.filter(ob =>
      ob.type === (this.currentBias === 'bullish' ? 'bullish' : 'bearish') &&
      !ob.mitigated
    );
    confidence += Math.min(relevantOBs.length * 5, 20);

    return Math.min(confidence, 100);
  }

  /**
   * Get order blocks relevant for the current bias
   * @param {number} currentPrice
   * @returns {Object[]}
   */
  getRelevantOrderBlocks(currentPrice) {
    if (!this.currentBias) return [];

    const side = this.currentBias === 'bullish' ? 'buy' : 'sell';
    return this.obDetector.getRelevantOrderBlocks(currentPrice, side);
  }

  /**
   * Get the nearest order block to current price
   * @param {number} currentPrice
   * @returns {Object|null}
   */
  getNearestOrderBlock(currentPrice) {
    const type = this.currentBias === 'bullish' ? 'bullish' : 'bearish';
    return this.obDetector.getNearestOrderBlock(currentPrice, type);
  }

  /**
   * Check if price is at/near an order block
   * @param {number} price
   * @param {number} proximityPoints
   * @returns {Object|null}
   */
  isAtOrderBlock(price, proximityPoints = 5) {
    const ob = this.obDetector.isInsideOrderBlock(price);
    if (ob) return ob;

    // Check if within proximity
    const nearestOB = this.getNearestOrderBlock(price);
    if (nearestOB) {
      const distance = Math.min(
        Math.abs(price - nearestOB.high),
        Math.abs(price - nearestOB.low)
      );
      if (distance <= proximityPoints) {
        return { ...nearestOB, isProximity: true, distance };
      }
    }

    return null;
  }

  /**
   * Get premium/discount zone based on recent swing range
   * Premium = top 30%, Equilibrium = middle 40%, Discount = bottom 30%
   * @returns {Object|null}
   */
  getPremiumDiscountZones() {
    const chochState = this.chochDetector.getState();
    const swingHighs = chochState.swingHighs;
    const swingLows = chochState.swingLows;

    if (swingHighs.length === 0 || swingLows.length === 0) return null;

    const high = swingHighs[swingHighs.length - 1].price;
    const low = swingLows[swingLows.length - 1].price;
    const range = high - low;

    return {
      high: high,
      low: low,
      equilibrium: (high + low) / 2,
      premium: {
        top: high,
        bottom: high - (range * 0.3),
        zone: 'premium'
      },
      discount: {
        top: low + (range * 0.3),
        bottom: low,
        zone: 'discount'
      },
      isPremium: (price) => price >= high - (range * 0.3),
      isDiscount: (price) => price <= low + (range * 0.3),
      isEquilibrium: (price) => price > low + (range * 0.3) && price < high - (range * 0.3)
    };
  }

  /**
   * Get current state for external access
   * @returns {Object}
   */
  getState() {
    return {
      bias: this.currentBias,
      lastCHoCH: this.lastCHoCH,
      lastMSS: this.lastMSS,
      structureHistory: this.structureHistory.slice(-10),
      chochState: this.chochDetector.getState(),
      mssState: this.mssDetector.getState(),
      obState: this.obDetector.getState(),
      lastAnalysis: this.analysisCache
    };
  }

  /**
   * Quick check if structure supports a trade direction
   * @param {string} side - 'buy' | 'sell'
   * @returns {Object} { supported: boolean, reason: string, confidence: number }
   */
  supportsDirection(side) {
    if (!this.currentBias) {
      return {
        supported: false,
        reason: 'No established bias',
        confidence: 0
      };
    }

    const biasAligned = (side === 'buy' && this.currentBias === 'bullish') ||
                        (side === 'sell' && this.currentBias === 'bearish');

    if (!biasAligned) {
      return {
        supported: false,
        reason: `Current bias is ${this.currentBias}, proposed direction is ${side}`,
        confidence: 0
      };
    }

    const confidence = this.analysisCache?.confidence || 50;

    return {
      supported: true,
      reason: `Structure supports ${side} with ${this.currentBias} bias`,
      confidence: confidence,
      mssConfirmed: !!this.lastMSS,
      chochDetected: !!this.lastCHoCH
    };
  }
}

export default ICTStructureAnalyzer;
