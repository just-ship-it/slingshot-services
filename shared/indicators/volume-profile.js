// Volume Profile Calculator
// Identifies Point of Control (POC), Value Area, and Low Volume Nodes
// Used to filter entries near high-volume support/resistance zones

import { TechnicalAnalysis } from '../utils/technical-analysis.js';

export class VolumeProfile {

  constructor(params = {}) {
    this.params = {
      // Price bucket size (tick size for NQ = 0.25)
      tickSize: params.tickSize || 0.25,
      // Value area percentage (70% is standard)
      valueAreaPercent: params.valueAreaPercent || 0.70,
      // Session definition for intraday profiles
      sessionStartHour: params.sessionStartHour || 9, // 9 AM
      sessionStartMinute: params.sessionStartMinute || 30,
      sessionEndHour: params.sessionEndHour || 16, // 4 PM
      sessionEndMinute: params.sessionEndMinute || 0,
      // Timezone offset from UTC (Eastern = -5 or -4 for DST)
      timezoneOffset: params.timezoneOffset || -5,
      ...params
    };

    // Profile data
    this.volumeByPrice = new Map();
    this.totalVolume = 0;
    this.highPrice = -Infinity;
    this.lowPrice = Infinity;
    this.candleCount = 0;
  }

  /**
   * Reset the profile (call at start of new session)
   */
  reset() {
    this.volumeByPrice.clear();
    this.totalVolume = 0;
    this.highPrice = -Infinity;
    this.lowPrice = Infinity;
    this.candleCount = 0;
  }

  /**
   * Round price to nearest tick
   * @private
   */
  _roundToTick(price) {
    return Math.round(price / this.params.tickSize) * this.params.tickSize;
  }

  /**
   * Add a candle to the volume profile
   * Distributes volume across the candle's price range
   *
   * @param {object} candle - Candle with {high, low, close, volume}
   */
  addCandle(candle) {
    if (!candle || typeof candle.volume === 'undefined') {
      return;
    }

    const { high, low, close, volume } = candle;

    if (volume === 0) return;

    this.candleCount++;
    this.totalVolume += volume;

    // Track price range
    this.highPrice = Math.max(this.highPrice, high);
    this.lowPrice = Math.min(this.lowPrice, low);

    // Round prices to tick boundaries
    const roundedHigh = this._roundToTick(high);
    const roundedLow = this._roundToTick(low);

    // Count price levels in this candle
    const priceLevels = Math.max(1, Math.round((roundedHigh - roundedLow) / this.params.tickSize) + 1);

    // Distribute volume across price levels
    // Weight more volume near close (simple TPO approximation)
    const roundedClose = this._roundToTick(close);

    for (let price = roundedLow; price <= roundedHigh; price += this.params.tickSize) {
      const roundedPrice = this._roundToTick(price);

      // Weight by proximity to close
      const distanceFromClose = Math.abs(roundedPrice - roundedClose);
      const maxDistance = Math.max(roundedHigh - roundedClose, roundedClose - roundedLow);
      const weight = maxDistance > 0 ? 1 - (distanceFromClose / maxDistance) * 0.5 : 1;

      const volumeForLevel = (volume / priceLevels) * weight;

      const existing = this.volumeByPrice.get(roundedPrice) || 0;
      this.volumeByPrice.set(roundedPrice, existing + volumeForLevel);
    }
  }

  /**
   * Build profile from array of candles
   *
   * @param {object[]} candles - Array of candles
   * @param {boolean} reset - Whether to reset before building (default true)
   */
  buildFromCandles(candles, reset = true) {
    if (reset) {
      this.reset();
    }

    for (const candle of candles) {
      this.addCandle(candle);
    }
  }

  /**
   * Get Point of Control (POC) - price level with highest volume
   *
   * @returns {object} {price: number, volume: number}
   */
  getPOC() {
    if (this.volumeByPrice.size === 0) {
      return { price: null, volume: null };
    }

    let maxVolume = 0;
    let pocPrice = null;

    for (const [price, volume] of this.volumeByPrice) {
      if (volume > maxVolume) {
        maxVolume = volume;
        pocPrice = price;
      }
    }

    return { price: pocPrice, volume: maxVolume };
  }

  /**
   * Get Value Area - price range containing valueAreaPercent of volume
   *
   * @returns {object} {high: number, low: number, volume: number, percent: number}
   */
  getValueArea() {
    if (this.volumeByPrice.size === 0 || this.totalVolume === 0) {
      return { high: null, low: null, volume: null, percent: null };
    }

    const poc = this.getPOC();
    if (poc.price === null) {
      return { high: null, low: null, volume: null, percent: null };
    }

    const targetVolume = this.totalVolume * this.params.valueAreaPercent;

    // Sort prices
    const sortedPrices = Array.from(this.volumeByPrice.keys()).sort((a, b) => a - b);
    const pocIndex = sortedPrices.indexOf(poc.price);

    // Expand from POC until we reach target volume
    let vaVolume = this.volumeByPrice.get(poc.price);
    let lowIndex = pocIndex;
    let highIndex = pocIndex;

    while (vaVolume < targetVolume && (lowIndex > 0 || highIndex < sortedPrices.length - 1)) {
      const lowerVolume = lowIndex > 0 ? this.volumeByPrice.get(sortedPrices[lowIndex - 1]) : 0;
      const upperVolume = highIndex < sortedPrices.length - 1 ? this.volumeByPrice.get(sortedPrices[highIndex + 1]) : 0;

      if (lowerVolume >= upperVolume && lowIndex > 0) {
        lowIndex--;
        vaVolume += lowerVolume;
      } else if (highIndex < sortedPrices.length - 1) {
        highIndex++;
        vaVolume += upperVolume;
      } else if (lowIndex > 0) {
        lowIndex--;
        vaVolume += lowerVolume;
      } else {
        break;
      }
    }

    return {
      high: sortedPrices[highIndex],
      low: sortedPrices[lowIndex],
      volume: vaVolume,
      percent: vaVolume / this.totalVolume
    };
  }

  /**
   * Get Low Volume Nodes (LVN) - price levels with significantly below average volume
   *
   * @param {number} threshold - Multiplier below average to consider LVN (default 0.5)
   * @returns {object[]} Array of {price, volume, isLVN: true}
   */
  getLowVolumeNodes(threshold = 0.5) {
    if (this.volumeByPrice.size === 0) {
      return [];
    }

    const avgVolume = this.totalVolume / this.volumeByPrice.size;
    const lvnThreshold = avgVolume * threshold;

    const lvns = [];
    for (const [price, volume] of this.volumeByPrice) {
      if (volume < lvnThreshold) {
        lvns.push({ price, volume, isLVN: true });
      }
    }

    return lvns.sort((a, b) => a.price - b.price);
  }

  /**
   * Get High Volume Nodes (HVN) - price levels with significantly above average volume
   *
   * @param {number} threshold - Multiplier above average to consider HVN (default 1.5)
   * @returns {object[]} Array of {price, volume, isHVN: true}
   */
  getHighVolumeNodes(threshold = 1.5) {
    if (this.volumeByPrice.size === 0) {
      return [];
    }

    const avgVolume = this.totalVolume / this.volumeByPrice.size;
    const hvnThreshold = avgVolume * threshold;

    const hvns = [];
    for (const [price, volume] of this.volumeByPrice) {
      if (volume > hvnThreshold) {
        hvns.push({ price, volume, isHVN: true });
      }
    }

    return hvns.sort((a, b) => b.volume - a.volume);
  }

  /**
   * Check if a price is near the POC
   *
   * @param {number} price - Price to check
   * @param {number} threshold - Distance in points (default 5)
   * @returns {object} {isNearPOC: boolean, distance: number, poc: number}
   */
  isNearPOC(price, threshold = 5) {
    const poc = this.getPOC();
    if (poc.price === null) {
      return { isNearPOC: null, distance: null, poc: null };
    }

    const distance = Math.abs(price - poc.price);
    return {
      isNearPOC: distance <= threshold,
      distance,
      poc: poc.price
    };
  }

  /**
   * Check if a price is within the Value Area
   *
   * @param {number} price - Price to check
   * @returns {object} {isInValueArea: boolean, valueArea: object}
   */
  isInValueArea(price) {
    const va = this.getValueArea();
    if (va.high === null || va.low === null) {
      return { isInValueArea: null, valueArea: va };
    }

    return {
      isInValueArea: price >= va.low && price <= va.high,
      valueArea: va
    };
  }

  /**
   * Check if a price is in a Low Volume Node
   *
   * @param {number} price - Price to check
   * @param {number} threshold - LVN threshold (default 0.5)
   * @returns {object} {isInLVN: boolean, nearestLVN: object}
   */
  isInLVN(price, threshold = 0.5) {
    const lvns = this.getLowVolumeNodes(threshold);

    if (lvns.length === 0) {
      return { isInLVN: false, nearestLVN: null };
    }

    const roundedPrice = this._roundToTick(price);
    const inLVN = lvns.find(lvn => lvn.price === roundedPrice);

    if (inLVN) {
      return { isInLVN: true, nearestLVN: inLVN };
    }

    // Find nearest LVN
    let nearestLVN = lvns[0];
    let minDistance = Math.abs(lvns[0].price - roundedPrice);

    for (const lvn of lvns) {
      const distance = Math.abs(lvn.price - roundedPrice);
      if (distance < minDistance) {
        minDistance = distance;
        nearestLVN = lvn;
      }
    }

    return { isInLVN: false, nearestLVN, distanceToLVN: minDistance };
  }

  /**
   * Get complete profile analysis
   *
   * @returns {object} Full profile data
   */
  getProfile() {
    return {
      poc: this.getPOC(),
      valueArea: this.getValueArea(),
      hvns: this.getHighVolumeNodes(),
      lvns: this.getLowVolumeNodes(),
      totalVolume: this.totalVolume,
      candleCount: this.candleCount,
      priceRange: {
        high: this.highPrice,
        low: this.lowPrice
      },
      levelCount: this.volumeByPrice.size
    };
  }

  /**
   * Get volume at specific price
   *
   * @param {number} price - Price to query
   * @returns {number} Volume at that price level
   */
  getVolumeAtPrice(price) {
    const roundedPrice = this._roundToTick(price);
    return this.volumeByPrice.get(roundedPrice) || 0;
  }

  /**
   * Check if entry is supported by volume profile
   * Good entries are near POC/HVN (support), bad entries are in LVN (no support)
   *
   * @param {number} price - Entry price
   * @param {string} side - 'buy' or 'sell'
   * @param {object} options - Filter options
   * @returns {object} {passes: boolean, score: number, reasons: string[]}
   */
  checkEntry(price, side, options = {}) {
    const {
      requireNearPOC = false,
      pocThreshold = 10,
      avoidLVN = true,
      lvnThreshold = 0.5,
      requireInValueArea = false
    } = options;

    const reasons = [];
    let score = 50; // Start neutral

    // Check POC proximity
    const pocCheck = this.isNearPOC(price, pocThreshold);
    if (pocCheck.isNearPOC) {
      score += 20;
      reasons.push(`Near POC (${pocCheck.distance.toFixed(2)} pts away)`);
    } else if (requireNearPOC) {
      score -= 30;
      reasons.push(`Not near POC (${pocCheck.distance?.toFixed(2)} pts away)`);
    }

    // Check Value Area
    const vaCheck = this.isInValueArea(price);
    if (vaCheck.isInValueArea) {
      score += 15;
      reasons.push('Within Value Area');
    } else if (requireInValueArea) {
      score -= 20;
      reasons.push('Outside Value Area');
    }

    // Check LVN
    const lvnCheck = this.isInLVN(price, lvnThreshold);
    if (lvnCheck.isInLVN && avoidLVN) {
      score -= 25;
      reasons.push('In Low Volume Node (weak support)');
    }

    // Check HVN
    const hvns = this.getHighVolumeNodes();
    const nearHVN = hvns.find(hvn => Math.abs(hvn.price - price) <= pocThreshold);
    if (nearHVN) {
      score += 15;
      reasons.push(`Near High Volume Node at ${nearHVN.price}`);
    }

    return {
      passes: score >= 50,
      score: Math.max(0, Math.min(100, score)),
      reasons,
      details: {
        poc: pocCheck,
        valueArea: vaCheck,
        lvn: lvnCheck
      }
    };
  }
}


/**
 * Session Volume Profile Manager
 * Maintains separate profiles for different sessions
 */
export class SessionVolumeProfiles {

  constructor(params = {}) {
    this.params = {
      tickSize: params.tickSize || 0.25,
      ...params
    };

    // Store profiles by date
    this.profiles = new Map();
    this.currentDate = null;
    this.currentProfile = null;
  }

  /**
   * Get or create profile for a date
   * @private
   */
  _getProfile(date) {
    const dateKey = date.toISOString().split('T')[0];

    if (!this.profiles.has(dateKey)) {
      this.profiles.set(dateKey, new VolumeProfile(this.params));
    }

    return this.profiles.get(dateKey);
  }

  /**
   * Process a candle and add to appropriate session profile
   *
   * @param {object} candle - Candle with timestamp
   */
  processCandle(candle) {
    if (!candle || !candle.timestamp) return;

    const date = new Date(candle.timestamp);
    const profile = this._getProfile(date);
    profile.addCandle(candle);

    this.currentDate = date;
    this.currentProfile = profile;
  }

  /**
   * Get the previous session's profile
   *
   * @param {Date} currentDate - Current date
   * @returns {VolumeProfile} Previous session's profile
   */
  getPreviousSessionProfile(currentDate) {
    const dates = Array.from(this.profiles.keys()).sort();
    const currentKey = currentDate.toISOString().split('T')[0];
    const currentIndex = dates.indexOf(currentKey);

    if (currentIndex <= 0) {
      return null;
    }

    return this.profiles.get(dates[currentIndex - 1]);
  }

  /**
   * Get developing profile for current session
   *
   * @returns {VolumeProfile} Current session's profile
   */
  getCurrentSessionProfile() {
    return this.currentProfile;
  }

  /**
   * Clear old profiles to manage memory
   *
   * @param {number} keepDays - Number of days to keep (default 5)
   */
  pruneOldProfiles(keepDays = 5) {
    const dates = Array.from(this.profiles.keys()).sort();
    const cutoff = dates.length - keepDays;

    if (cutoff > 0) {
      for (let i = 0; i < cutoff; i++) {
        this.profiles.delete(dates[i]);
      }
    }
  }
}


export default VolumeProfile;
