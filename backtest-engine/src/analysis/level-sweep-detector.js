/**
 * Level-Aware Liquidity Sweep Detector
 *
 * High-accuracy sweep detection that only flags sweeps occurring at
 * significant price levels. This is the core of the 90% accuracy target.
 *
 * A valid liquidity sweep must satisfy ALL criteria:
 * 1. Level Proximity: Price within tolerance of a significant level
 * 2. Volume Spike: Volume >= threshold std devs above rolling mean
 * 3. Wick Formation: Dominant wick >= threshold % of candle range
 * 4. Price Rejection: Close back inside the level (sweep + reclaim)
 *
 * Architecture:
 * LevelCalculator (levels) + VolumeSpikeDetector (volume) -> LevelSweepDetector
 */

import { LevelCalculator, LEVEL_TYPES, LEVEL_STRENGTHS } from '../levels/level-calculator.js';
import { VolumeSpikeDetector } from './volume-spike-detector.js';
import { getSession, toEasternTime } from '../levels/session-tracker.js';

/**
 * Default configuration for NQ futures
 */
const DEFAULT_CONFIG = {
  // Level proximity
  levelTolerance: 5,           // Points from level to consider "at level"

  // Volume spike thresholds
  volumeZThreshold: 2.0,       // Min volume z-score
  rangeZThreshold: 1.5,        // Min range z-score
  volumeLookback: 60,          // Rolling window (seconds for 1s data, bars for 1m)

  // Wick requirements
  wickRatio: 0.70,             // Min wick as % of total range (tuned from 0.6)
  minRange: 3.0,               // Min candle range in points

  // Additional filters
  requireVolumeSpike: true,    // Require volume spike (can disable for testing)
  requireLevelProximity: true, // Require level proximity (can disable for testing)

  // Time-based filters
  sessionFilter: null,         // null = all sessions, or ['rth', 'premarket', etc.]
  cooldownSeconds: 30          // Minimum seconds between sweep signals
};

/**
 * Sweep types and their trade directions
 */
export const SWEEP_TYPES = {
  BULLISH: 'bullish',    // Lower wick swept level, LONG opportunity
  BEARISH: 'bearish'     // Upper wick swept level, SHORT opportunity
};

export class LevelSweepDetector {
  /**
   * @param {Object} config - Configuration options
   * @param {Object} config.levelCalculator - LevelCalculator instance
   * @param {Object} config.volumeDetector - VolumeSpikeDetector instance (optional)
   * @param {Object} config.gexLoader - GexLoader instance (optional, for GEX levels)
   * @param {number} config.levelTolerance - Points from level (default: 5)
   * @param {number} config.volumeZThreshold - Volume z-score threshold (default: 2.0)
   * @param {number} config.rangeZThreshold - Range z-score threshold (default: 1.5)
   * @param {number} config.wickRatio - Min wick ratio (default: 0.6)
   * @param {number} config.minRange - Min range in points (default: 3.0)
   */
  constructor(config = {}) {
    // Merge config with defaults
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Initialize or use provided level calculator
    this.levelCalculator = config.levelCalculator || new LevelCalculator({
      gexLoader: config.gexLoader,
      levelTolerance: this.config.levelTolerance
    });

    // Initialize or use provided volume detector
    this.volumeDetector = config.volumeDetector || new VolumeSpikeDetector({
      lookback: this.config.volumeLookback,
      volumeThreshold: this.config.volumeZThreshold,
      rangeThreshold: this.config.rangeZThreshold,
      minRange: this.config.minRange
    });

    // State tracking
    this.lastSweepTimestamp = null;
    this.detectedSweeps = [];

    // Statistics
    this.stats = {
      candlesProcessed: 0,
      sweepsDetected: 0,
      bullishSweeps: 0,
      bearishSweeps: 0,
      filteredByVolume: 0,
      filteredByLevel: 0,
      filteredByWick: 0,
      filteredBySession: 0,
      filteredByCooldown: 0,
      byLevelType: {}
    };
  }

  /**
   * Process a candle and detect if it's a level sweep
   * @param {Object} candle - Candle with { timestamp, open, high, low, close, volume, symbol }
   * @returns {Object|null} Sweep detection result or null
   */
  detect(candle) {
    this.stats.candlesProcessed++;

    // Process candle through level calculator (updates session levels)
    this.levelCalculator.processCandle(candle);

    // Calculate candle metrics
    const metrics = this.calculateCandleMetrics(candle);

    // Check minimum range
    if (metrics.range < this.config.minRange) {
      return null;
    }

    // Check session filter if configured
    if (this.config.sessionFilter) {
      const session = getSession(candle.timestamp);
      if (!this.config.sessionFilter.includes(session)) {
        this.stats.filteredBySession++;
        return null;
      }
    }

    // Check cooldown
    if (this.lastSweepTimestamp) {
      const elapsed = (candle.timestamp - this.lastSweepTimestamp) / 1000;
      if (elapsed < this.config.cooldownSeconds) {
        this.stats.filteredByCooldown++;
        return null;
      }
    }

    // Check volume spike (if required)
    let volumeSpike = null;
    if (this.config.requireVolumeSpike) {
      volumeSpike = this.volumeDetector.detect(candle);
      if (!volumeSpike) {
        this.stats.filteredByVolume++;
        return null;
      }
    } else {
      // Still update volume detector state
      this.volumeDetector.detect(candle);
    }

    // Check wick pattern
    const wickAnalysis = this.analyzeWickPattern(candle, metrics);
    if (!wickAnalysis.valid) {
      this.stats.filteredByWick++;
      return null;
    }

    // Check level proximity and sweep
    let sweptLevel = null;
    if (this.config.requireLevelProximity) {
      // Check if candle swept through any levels
      const sweptLevels = this.levelCalculator.detectLevelSweeps(candle, this.config.levelTolerance);

      // Find a level that matches our sweep direction
      sweptLevel = sweptLevels.find(level =>
        level.sweepType === wickAnalysis.sweepType
      );

      if (!sweptLevel) {
        this.stats.filteredByLevel++;
        return null;
      }
    }

    // All criteria met - this is a valid sweep
    this.lastSweepTimestamp = candle.timestamp;
    this.stats.sweepsDetected++;

    if (wickAnalysis.sweepType === SWEEP_TYPES.BULLISH) {
      this.stats.bullishSweeps++;
    } else {
      this.stats.bearishSweeps++;
    }

    // Track by level type
    if (sweptLevel) {
      const levelType = sweptLevel.type;
      this.stats.byLevelType[levelType] = (this.stats.byLevelType[levelType] || 0) + 1;
    }

    // Build sweep result
    const sweep = this.buildSweepResult(candle, metrics, wickAnalysis, volumeSpike, sweptLevel);
    this.detectedSweeps.push(sweep);

    return sweep;
  }

  /**
   * Calculate candle metrics
   * @param {Object} candle - Candle object
   * @returns {Object} Calculated metrics
   */
  calculateCandleMetrics(candle) {
    const { open, high, low, close } = candle;

    const range = high - low;
    const body = Math.abs(close - open);
    const upperWick = high - Math.max(open, close);
    const lowerWick = Math.min(open, close) - low;
    const upperWickRatio = range > 0 ? upperWick / range : 0;
    const lowerWickRatio = range > 0 ? lowerWick / range : 0;
    const bodyRatio = range > 0 ? body / range : 0;
    const isBullish = close > open;

    return {
      range: Math.round(range * 100) / 100,
      body: Math.round(body * 100) / 100,
      upperWick: Math.round(upperWick * 100) / 100,
      lowerWick: Math.round(lowerWick * 100) / 100,
      upperWickRatio: Math.round(upperWickRatio * 100) / 100,
      lowerWickRatio: Math.round(lowerWickRatio * 100) / 100,
      bodyRatio: Math.round(bodyRatio * 100) / 100,
      isBullish
    };
  }

  /**
   * Analyze wick pattern to determine sweep type
   * @param {Object} candle - Candle object
   * @param {Object} metrics - Calculated metrics
   * @returns {Object} Wick analysis result
   */
  analyzeWickPattern(candle, metrics) {
    const { upperWickRatio, lowerWickRatio } = metrics;

    // Bearish sweep: large upper wick, price rejected from high
    if (upperWickRatio >= this.config.wickRatio && upperWickRatio > lowerWickRatio) {
      return {
        valid: true,
        sweepType: SWEEP_TYPES.BEARISH,
        direction: 'SHORT',
        dominantWick: 'upper',
        wickRatio: upperWickRatio,
        wickPoints: metrics.upperWick
      };
    }

    // Bullish sweep: large lower wick, price rejected from low
    if (lowerWickRatio >= this.config.wickRatio && lowerWickRatio > upperWickRatio) {
      return {
        valid: true,
        sweepType: SWEEP_TYPES.BULLISH,
        direction: 'LONG',
        dominantWick: 'lower',
        wickRatio: lowerWickRatio,
        wickPoints: metrics.lowerWick
      };
    }

    return { valid: false };
  }

  /**
   * Build the complete sweep result object
   * @param {Object} candle - Original candle
   * @param {Object} metrics - Candle metrics
   * @param {Object} wickAnalysis - Wick analysis
   * @param {Object|null} volumeSpike - Volume spike info
   * @param {Object|null} sweptLevel - Level that was swept
   * @returns {Object} Complete sweep detection result
   */
  buildSweepResult(candle, metrics, wickAnalysis, volumeSpike, sweptLevel) {
    const session = getSession(candle.timestamp);
    const et = toEasternTime(candle.timestamp);

    // Calculate entry, stop, target
    const entry = candle.close;
    let stopLoss, takeProfit;

    if (wickAnalysis.sweepType === SWEEP_TYPES.BULLISH) {
      // Long entry - stop below low, target above
      stopLoss = candle.low - 2; // 2 point buffer
      takeProfit = entry + 15;    // 15 point target for NQ
    } else {
      // Short entry - stop above high, target below
      stopLoss = candle.high + 2;
      takeProfit = entry - 15;
    }

    const risk = Math.abs(entry - stopLoss);
    const reward = Math.abs(takeProfit - entry);

    // Calculate base confidence from wick pattern
    let confidence = 0.5;

    // Add confidence from wick ratio (max +20%)
    confidence += Math.min((wickAnalysis.wickRatio - this.config.wickRatio) / 0.3, 0.2);

    // Add confidence from volume spike (max +20%)
    if (volumeSpike) {
      confidence += Math.min(volumeSpike.confidence * 0.2, 0.2);
    }

    // Add confidence from level strength (max +10%)
    if (sweptLevel) {
      confidence += Math.min(sweptLevel.strength / 1000, 0.1);
    }

    // Cap at 1.0
    confidence = Math.min(confidence, 1.0);

    return {
      // Core identification
      type: wickAnalysis.sweepType,
      direction: wickAnalysis.direction,
      timestamp: candle.timestamp,
      datetime: new Date(candle.timestamp).toISOString(),
      symbol: candle.symbol,

      // Session info
      session,
      estHour: et.hour,
      estMinute: et.minute,

      // Price data
      entry: Math.round(entry * 100) / 100,
      stopLoss: Math.round(stopLoss * 100) / 100,
      takeProfit: Math.round(takeProfit * 100) / 100,
      risk: Math.round(risk * 100) / 100,
      reward: Math.round(reward * 100) / 100,
      rrRatio: Math.round((reward / risk) * 100) / 100,

      // Candle data
      candle: {
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume
      },

      // Metrics
      metrics,

      // Wick analysis
      wick: {
        type: wickAnalysis.dominantWick,
        ratio: wickAnalysis.wickRatio,
        points: wickAnalysis.wickPoints
      },

      // Volume spike (if detected)
      volumeSpike: volumeSpike ? {
        volumeZ: volumeSpike.volume?.zScore,
        rangeZ: volumeSpike.range?.zScore,
        volumePercentile: volumeSpike.volume?.percentile
      } : null,

      // Level info (if detected)
      level: sweptLevel ? {
        type: sweptLevel.type,
        price: sweptLevel.price,
        strength: sweptLevel.strength,
        description: sweptLevel.description,
        penetration: sweptLevel.penetration
      } : null,

      // Confidence score (0-1)
      confidence: Math.round(confidence * 100) / 100,

      // All nearby levels for context
      nearbyLevels: this.levelCalculator.getLevelsNearPrice(candle.close, 20)
    };
  }

  /**
   * Process multiple candles (for batch processing)
   * @param {Object[]} candles - Array of candles
   * @returns {Object[]} Array of detected sweeps
   */
  processCandles(candles) {
    const sweeps = [];

    for (const candle of candles) {
      const sweep = this.detect(candle);
      if (sweep) {
        sweeps.push(sweep);
      }
    }

    return sweeps;
  }

  /**
   * Get all detected sweeps
   * @returns {Object[]} Array of sweeps
   */
  getSweeps() {
    return [...this.detectedSweeps];
  }

  /**
   * Get sweeps filtered by type
   * @param {string} type - 'bullish' or 'bearish'
   * @returns {Object[]} Filtered sweeps
   */
  getSweepsByType(type) {
    return this.detectedSweeps.filter(s => s.type === type);
  }

  /**
   * Get sweeps filtered by session
   * @param {string} session - Session name
   * @returns {Object[]} Filtered sweeps
   */
  getSweepsBySession(session) {
    return this.detectedSweeps.filter(s => s.session === session);
  }

  /**
   * Get sweeps filtered by level type
   * @param {string} levelType - Level type from LEVEL_TYPES
   * @returns {Object[]} Filtered sweeps
   */
  getSweepsByLevelType(levelType) {
    return this.detectedSweeps.filter(s => s.level?.type === levelType);
  }

  /**
   * Get current levels
   * @returns {Object} Current level state
   */
  getLevels() {
    return this.levelCalculator.getLevelsAt(Date.now());
  }

  /**
   * Reset state (call when switching symbols/days)
   */
  reset() {
    this.levelCalculator.reset();
    this.volumeDetector.reset();
    this.lastSweepTimestamp = null;
    this.detectedSweeps = [];
  }

  /**
   * Get detection statistics
   * @returns {Object} Statistics
   */
  getStats() {
    return { ...this.stats };
  }

  /**
   * Reset statistics
   */
  resetStats() {
    this.stats = {
      candlesProcessed: 0,
      sweepsDetected: 0,
      bullishSweeps: 0,
      bearishSweeps: 0,
      filteredByVolume: 0,
      filteredByLevel: 0,
      filteredByWick: 0,
      filteredBySession: 0,
      filteredByCooldown: 0,
      byLevelType: {}
    };
  }

  /**
   * Get configuration
   * @returns {Object} Current configuration
   */
  getConfig() {
    return { ...this.config };
  }

  /**
   * Update configuration
   * @param {Object} newConfig - New configuration values
   */
  updateConfig(newConfig) {
    Object.assign(this.config, newConfig);

    // Update child components if relevant
    if (newConfig.levelTolerance) {
      this.levelCalculator.levelTolerance = newConfig.levelTolerance;
    }

    if (newConfig.volumeZThreshold || newConfig.rangeZThreshold || newConfig.volumeLookback) {
      this.volumeDetector.updateConfig({
        volumeThreshold: newConfig.volumeZThreshold,
        rangeThreshold: newConfig.rangeZThreshold,
        lookback: newConfig.volumeLookback
      });
    }
  }
}

export default LevelSweepDetector;
