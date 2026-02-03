/**
 * VWAP Calculator
 *
 * Volume Weighted Average Price calculation with session-based resets.
 * Resets at 6 PM ET (start of new trading day for futures).
 *
 * VWAP = Cumulative(Typical Price * Volume) / Cumulative(Volume)
 * Typical Price = (High + Low + Close) / 3
 */

/**
 * Calculate VWAP for a given set of candles
 * @param {Array} candles - Array of candles with OHLCV data, sorted by timestamp
 * @returns {Array} Array of {timestamp, vwap, upperBand, lowerBand, deviation}
 */
export function calculateVWAP(candles) {
  if (!candles || candles.length === 0) {
    return [];
  }

  const results = [];
  let cumTypicalPriceVolume = 0;
  let cumVolume = 0;
  let cumSquaredDeviation = 0;

  candles.forEach((candle, index) => {
    const typicalPrice = (candle.high + candle.low + candle.close) / 3;
    const volume = candle.volume || 1; // Avoid division by zero

    cumTypicalPriceVolume += typicalPrice * volume;
    cumVolume += volume;

    const vwap = cumTypicalPriceVolume / cumVolume;

    // Calculate standard deviation bands
    const deviation = typicalPrice - vwap;
    cumSquaredDeviation += deviation * deviation * volume;

    const variance = cumVolume > 0 ? cumSquaredDeviation / cumVolume : 0;
    const stdDev = Math.sqrt(variance);

    results.push({
      timestamp: candle.timestamp,
      vwap,
      upperBand1: vwap + stdDev,
      upperBand2: vwap + (2 * stdDev),
      lowerBand1: vwap - stdDev,
      lowerBand2: vwap - (2 * stdDev),
      deviation: deviation,
      stdDev: stdDev,
      priceToVwap: candle.close - vwap,
      priceToVwapPercent: ((candle.close - vwap) / vwap) * 100
    });
  });

  return results;
}

/**
 * Calculate session-based VWAP with resets at 6 PM ET
 * @param {Map|Array} candleData - Candle data (Map or Array)
 * @returns {Map} Map of timestamp -> VWAP data
 */
export function calculateSessionVWAP(candleData) {
  // Convert Map to sorted array if needed
  let candles;
  if (candleData instanceof Map) {
    candles = Array.from(candleData.values()).sort((a, b) => a.timestamp - b.timestamp);
  } else {
    candles = [...candleData].sort((a, b) => a.timestamp - b.timestamp);
  }

  if (candles.length === 0) {
    return new Map();
  }

  const vwapMap = new Map();
  let sessionCandles = [];
  let currentSessionStart = getSessionStart(candles[0].timestamp);

  candles.forEach(candle => {
    const sessionStart = getSessionStart(candle.timestamp);

    // Check if we've moved to a new session (6 PM reset)
    if (sessionStart > currentSessionStart) {
      // Calculate VWAP for completed session
      if (sessionCandles.length > 0) {
        const sessionVwap = calculateVWAP(sessionCandles);
        sessionVwap.forEach(v => vwapMap.set(v.timestamp, v));
      }

      // Start new session
      sessionCandles = [];
      currentSessionStart = sessionStart;
    }

    sessionCandles.push(candle);

    // Calculate running VWAP for current session
    if (sessionCandles.length > 0) {
      const currentVwap = calculateVWAP(sessionCandles);
      if (currentVwap.length > 0) {
        vwapMap.set(candle.timestamp, currentVwap[currentVwap.length - 1]);
      }
    }
  });

  return vwapMap;
}

/**
 * Get session start timestamp (6 PM ET)
 * Sessions run from 6 PM to 6 PM next day
 * @param {number} timestamp - Timestamp to find session for
 * @returns {number} Session start timestamp
 */
function getSessionStart(timestamp) {
  const date = new Date(timestamp);

  // 6 PM ET = 18:00
  const hour = date.getHours();

  // If before 6 PM, session started previous day at 6 PM
  if (hour < 18) {
    date.setDate(date.getDate() - 1);
  }

  date.setHours(18, 0, 0, 0);

  return date.getTime();
}

/**
 * Get VWAP at a specific timestamp
 * @param {Map} vwapMap - Map of timestamp -> VWAP data
 * @param {number} timestamp - Target timestamp
 * @returns {object|null} VWAP data at closest timestamp
 */
export function getVWAPAtTime(vwapMap, timestamp) {
  // Try exact match first
  if (vwapMap.has(timestamp)) {
    return vwapMap.get(timestamp);
  }

  // Find closest timestamp before
  const timestamps = Array.from(vwapMap.keys()).sort((a, b) => a - b);

  let closest = null;
  for (const ts of timestamps) {
    if (ts <= timestamp) {
      closest = ts;
    } else {
      break;
    }
  }

  return closest ? vwapMap.get(closest) : null;
}

/**
 * Analyze price relationship to VWAP
 * @param {number} price - Current price
 * @param {object} vwapData - VWAP data with bands
 * @returns {object} Analysis of price position relative to VWAP
 */
export function analyzeVWAPPosition(price, vwapData) {
  if (!vwapData || !vwapData.vwap) {
    return null;
  }

  const distanceFromVwap = price - vwapData.vwap;
  const distancePercent = (distanceFromVwap / vwapData.vwap) * 100;

  let position = 'at_vwap';

  if (price > vwapData.upperBand2) {
    position = 'extended_above';
  } else if (price > vwapData.upperBand1) {
    position = 'above_band1';
  } else if (price > vwapData.vwap + (vwapData.stdDev * 0.5)) {
    position = 'slightly_above';
  } else if (price < vwapData.lowerBand2) {
    position = 'extended_below';
  } else if (price < vwapData.lowerBand1) {
    position = 'below_band1';
  } else if (price < vwapData.vwap - (vwapData.stdDev * 0.5)) {
    position = 'slightly_below';
  }

  return {
    price,
    vwap: vwapData.vwap,
    distance: distanceFromVwap,
    distancePercent,
    position,
    stdDevs: vwapData.stdDev > 0 ? distanceFromVwap / vwapData.stdDev : 0,
    isAbove: price > vwapData.vwap,
    isAtVwap: Math.abs(distanceFromVwap) < (vwapData.stdDev * 0.5)
  };
}

/**
 * Detect VWAP touches/tests
 * @param {Array} candles - Recent candles
 * @param {Map} vwapMap - VWAP data map
 * @param {number} touchThreshold - Points within to count as a touch
 * @returns {Array} Array of touch events
 */
export function detectVWAPTouches(candles, vwapMap, touchThreshold = 3) {
  const touches = [];

  candles.forEach((candle, index) => {
    if (index === 0) return;

    const vwap = getVWAPAtTime(vwapMap, candle.timestamp);
    if (!vwap) return;

    const prevCandle = candles[index - 1];
    const prevVwap = getVWAPAtTime(vwapMap, prevCandle.timestamp);
    if (!prevVwap) return;

    // Check for VWAP cross
    const prevAbove = prevCandle.close > prevVwap.vwap;
    const currAbove = candle.close > vwap.vwap;

    if (prevAbove !== currAbove) {
      touches.push({
        timestamp: candle.timestamp,
        type: 'cross',
        direction: currAbove ? 'cross_above' : 'cross_below',
        vwap: vwap.vwap,
        price: candle.close
      });
    }

    // Check for VWAP bounce (wick touch but close on other side)
    const lowTouchedVwap = candle.low <= vwap.vwap + touchThreshold &&
                          candle.low >= vwap.vwap - touchThreshold;
    const highTouchedVwap = candle.high <= vwap.vwap + touchThreshold &&
                           candle.high >= vwap.vwap - touchThreshold;

    if (lowTouchedVwap && candle.close > vwap.vwap) {
      touches.push({
        timestamp: candle.timestamp,
        type: 'bounce',
        direction: 'bounce_up',
        vwap: vwap.vwap,
        price: candle.close
      });
    }

    if (highTouchedVwap && candle.close < vwap.vwap) {
      touches.push({
        timestamp: candle.timestamp,
        type: 'bounce',
        direction: 'bounce_down',
        vwap: vwap.vwap,
        price: candle.close
      });
    }
  });

  return touches;
}

export default {
  calculateVWAP,
  calculateSessionVWAP,
  getVWAPAtTime,
  analyzeVWAPPosition,
  detectVWAPTouches
};
