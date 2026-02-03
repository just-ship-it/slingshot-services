/**
 * Market Structure Analyzer
 *
 * Detects market structure breaks, higher highs/lows, and fibonacci retracement levels
 * Used to confirm trend reversals and identify optimal entry points
 */

import { TechnicalAnalysis } from '../utils/technical-analysis.js';

export class MarketStructureAnalyzer {
  constructor(params = {}) {
    this.params = {
      // Structure detection
      swingLookback: params.swingLookback || 5,           // Candles to confirm swing high/low
      minSwingSize: params.minSwingSize || 10,            // Min points for valid swing
      structureBreakThreshold: params.structureBreakThreshold || 2, // Points beyond swing for break

      // Fibonacci levels
      fibLevels: params.fibLevels || [0.236, 0.382, 0.5, 0.618, 0.786], // Standard fib retracements
      fibProximityPoints: params.fibProximityPoints || 5,  // Points from fib level to consider "at level"

      // Trend determination
      trendLookbackSwings: params.trendLookbackSwings || 3, // Number of swings to determine trend
      requireStructureBreak: params.requireStructureBreak !== false, // Require break before reversal

      ...params
    };

    // State tracking
    this.swingHighs = [];
    this.swingLows = [];
    this.currentTrend = null;
    this.lastStructureBreak = null;
  }

  /**
   * Identify swing highs and lows in candle data
   */
  identifySwings(candles) {
    const swings = { highs: [], lows: [] };
    const lookback = this.params.swingLookback;

    for (let i = lookback; i < candles.length - lookback; i++) {
      const current = candles[i];
      let isSwingHigh = true;
      let isSwingLow = true;

      // Check for swing high
      for (let j = 1; j <= lookback; j++) {
        if (candles[i - j].high >= current.high || candles[i + j].high > current.high) {
          isSwingHigh = false;
        }
        if (candles[i - j].low <= current.low || candles[i + j].low < current.low) {
          isSwingLow = false;
        }
      }

      if (isSwingHigh) {
        swings.highs.push({
          index: i,
          price: current.high,
          timestamp: current.timestamp,
          candle: current
        });
      }

      if (isSwingLow) {
        swings.lows.push({
          index: i,
          price: current.low,
          timestamp: current.timestamp,
          candle: current
        });
      }
    }

    return swings;
  }

  /**
   * Determine if we have higher highs and higher lows (uptrend) or lower highs and lower lows (downtrend)
   */
  analyzeTrendStructure(swings) {
    const { highs, lows } = swings;

    if (highs.length < 2 || lows.length < 2) {
      return { trend: 'neutral', confidence: 0 };
    }

    // Get recent swings for analysis
    const recentHighs = highs.slice(-this.params.trendLookbackSwings);
    const recentLows = lows.slice(-this.params.trendLookbackSwings);

    // Check for higher highs and higher lows (uptrend)
    let higherHighs = 0;
    let higherLows = 0;
    let lowerHighs = 0;
    let lowerLows = 0;

    for (let i = 1; i < recentHighs.length; i++) {
      if (recentHighs[i].price > recentHighs[i - 1].price) {
        higherHighs++;
      } else {
        lowerHighs++;
      }
    }

    for (let i = 1; i < recentLows.length; i++) {
      if (recentLows[i].price > recentLows[i - 1].price) {
        higherLows++;
      } else {
        lowerLows++;
      }
    }

    // Determine trend
    let trend = 'neutral';
    let confidence = 0;

    if (higherHighs > lowerHighs && higherLows > lowerLows) {
      trend = 'bullish';
      confidence = ((higherHighs + higherLows) / (recentHighs.length + recentLows.length - 2)) * 100;
    } else if (lowerHighs > higherHighs && lowerLows > higherLows) {
      trend = 'bearish';
      confidence = ((lowerHighs + lowerLows) / (recentHighs.length + recentLows.length - 2)) * 100;
    }

    return {
      trend,
      confidence,
      higherHighs,
      higherLows,
      lowerHighs,
      lowerLows,
      lastHigh: recentHighs[recentHighs.length - 1],
      lastLow: recentLows[recentLows.length - 1]
    };
  }

  /**
   * Detect structure break (price breaking above previous high or below previous low)
   */
  detectStructureBreak(candles, swings) {
    if (!candles || candles.length === 0) return null;

    const currentCandle = candles[candles.length - 1];
    const { highs, lows } = swings;

    if (highs.length < 2 || lows.length < 2) return null;

    // Get the most recent swing points
    const lastHigh = highs[highs.length - 1];
    const lastLow = lows[lows.length - 1];
    const prevHigh = highs[highs.length - 2];
    const prevLow = lows[lows.length - 2];

    let structureBreak = null;

    // Check for bullish structure break (break above previous high)
    if (currentCandle.close > prevHigh.price + this.params.structureBreakThreshold) {
      structureBreak = {
        type: 'bullish',
        breakLevel: prevHigh.price,
        breakCandle: currentCandle,
        previousSwing: prevHigh,
        strength: ((currentCandle.close - prevHigh.price) / prevHigh.price) * 100
      };
    }
    // Check for bearish structure break (break below previous low)
    else if (currentCandle.close < prevLow.price - this.params.structureBreakThreshold) {
      structureBreak = {
        type: 'bearish',
        breakLevel: prevLow.price,
        breakCandle: currentCandle,
        previousSwing: prevLow,
        strength: ((prevLow.price - currentCandle.close) / prevLow.price) * 100
      };
    }

    return structureBreak;
  }

  /**
   * Calculate Fibonacci retracement levels between two price points
   */
  calculateFibonacciLevels(highPrice, lowPrice) {
    const range = highPrice - lowPrice;
    const levels = {};

    this.params.fibLevels.forEach(ratio => {
      levels[`fib_${ratio}`] = {
        ratio: ratio,
        price: highPrice - (range * ratio),
        description: `${(ratio * 100).toFixed(1)}% retracement`
      };
    });

    // Add 0% and 100% levels
    levels.fib_0 = { ratio: 0, price: highPrice, description: '0% (High)' };
    levels.fib_1 = { ratio: 1, price: lowPrice, description: '100% (Low)' };

    return levels;
  }

  /**
   * Find nearest Fibonacci level to current price
   */
  findNearestFibLevel(currentPrice, swings) {
    const { highs, lows } = swings;

    if (highs.length === 0 || lows.length === 0) return null;

    // Get the most recent significant swing points
    const recentHigh = highs[highs.length - 1];
    const recentLow = lows[lows.length - 1];

    // Calculate fib levels from the recent swing
    const fibLevels = this.calculateFibonacciLevels(recentHigh.price, recentLow.price);

    // Find the nearest level
    let nearestLevel = null;
    let minDistance = Infinity;

    Object.values(fibLevels).forEach(level => {
      const distance = Math.abs(currentPrice - level.price);
      if (distance < minDistance) {
        minDistance = distance;
        nearestLevel = { ...level, distance };
      }
    });

    // Check if price is within proximity threshold
    if (nearestLevel && nearestLevel.distance <= this.params.fibProximityPoints) {
      return {
        ...nearestLevel,
        isAtLevel: true,
        swingHigh: recentHigh,
        swingLow: recentLow
      };
    }

    return {
      ...nearestLevel,
      isAtLevel: false,
      swingHigh: recentHigh,
      swingLow: recentLow
    };
  }

  /**
   * Main analysis method - checks for structure confirmation
   */
  analyzeStructure(candles) {
    if (!candles || candles.length < this.params.swingLookback * 2 + 1) {
      return null;
    }

    // Identify swings
    const swings = this.identifySwings(candles);

    // Analyze trend structure
    const trendStructure = this.analyzeTrendStructure(swings);

    // Check for structure break
    const structureBreak = this.detectStructureBreak(candles, swings);

    // Find nearest Fibonacci level
    const currentPrice = candles[candles.length - 1].close;
    const fibLevel = this.findNearestFibLevel(currentPrice, swings);

    // Determine if we have a valid reversal setup
    let reversalSetup = null;

    if (structureBreak && fibLevel && fibLevel.isAtLevel) {
      // Bullish reversal: bearish trend + bullish structure break + at fib support
      if (trendStructure.trend === 'bearish' && structureBreak.type === 'bullish') {
        reversalSetup = {
          type: 'bullish',
          confidence: (trendStructure.confidence + structureBreak.strength) / 2,
          entryPrice: fibLevel.price,
          stopLoss: swings.lows[swings.lows.length - 1].price - this.params.minSwingSize * 0.25,
          structureBreak,
          fibLevel,
          trendBefore: 'bearish'
        };
      }
      // Bearish reversal: bullish trend + bearish structure break + at fib resistance
      else if (trendStructure.trend === 'bullish' && structureBreak.type === 'bearish') {
        reversalSetup = {
          type: 'bearish',
          confidence: (trendStructure.confidence + structureBreak.strength) / 2,
          entryPrice: fibLevel.price,
          stopLoss: swings.highs[swings.highs.length - 1].price + this.params.minSwingSize * 0.25,
          structureBreak,
          fibLevel,
          trendBefore: 'bullish'
        };
      }
    }

    return {
      swings,
      trendStructure,
      structureBreak,
      fibLevel,
      reversalSetup,
      currentPrice,
      timestamp: candles[candles.length - 1].timestamp
    };
  }

  /**
   * Quick check if market structure supports a particular trade direction
   */
  confirmDirection(candles, proposedDirection) {
    const analysis = this.analyzeStructure(candles);

    if (!analysis) return { confirmed: false, reason: 'Insufficient data' };

    const { trendStructure, structureBreak, fibLevel, reversalSetup } = analysis;

    // For long trades
    if (proposedDirection === 'buy' || proposedDirection === 'long') {
      // Best case: bullish reversal setup
      if (reversalSetup && reversalSetup.type === 'bullish') {
        return {
          confirmed: true,
          confidence: reversalSetup.confidence,
          reason: 'Bullish reversal at Fibonacci support',
          entryPrice: reversalSetup.entryPrice,
          stopLoss: reversalSetup.stopLoss
        };
      }

      // Good case: bullish structure break
      if (structureBreak && structureBreak.type === 'bullish') {
        return {
          confirmed: true,
          confidence: 70,
          reason: 'Bullish structure break',
          entryPrice: fibLevel ? fibLevel.price : null
        };
      }

      // Weak case: already in uptrend
      if (trendStructure.trend === 'bullish') {
        return {
          confirmed: true,
          confidence: 50,
          reason: 'Continuation of bullish trend',
          warning: 'Late entry in trend'
        };
      }
    }

    // For short trades
    if (proposedDirection === 'sell' || proposedDirection === 'short') {
      // Best case: bearish reversal setup
      if (reversalSetup && reversalSetup.type === 'bearish') {
        return {
          confirmed: true,
          confidence: reversalSetup.confidence,
          reason: 'Bearish reversal at Fibonacci resistance',
          entryPrice: reversalSetup.entryPrice,
          stopLoss: reversalSetup.stopLoss
        };
      }

      // Good case: bearish structure break
      if (structureBreak && structureBreak.type === 'bearish') {
        return {
          confirmed: true,
          confidence: 70,
          reason: 'Bearish structure break',
          entryPrice: fibLevel ? fibLevel.price : null
        };
      }

      // Weak case: already in downtrend
      if (trendStructure.trend === 'bearish') {
        return {
          confirmed: true,
          confidence: 50,
          reason: 'Continuation of bearish trend',
          warning: 'Late entry in trend'
        };
      }
    }

    return {
      confirmed: false,
      reason: 'No structural confirmation',
      trendStructure,
      structureBreak
    };
  }
}

export default MarketStructureAnalyzer;