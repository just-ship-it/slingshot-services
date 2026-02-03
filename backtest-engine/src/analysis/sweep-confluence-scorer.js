/**
 * Sweep Confluence Scorer
 *
 * Scores detected sweeps based on multiple confluence factors to assign
 * confidence tiers. Only Tier A+ and A signals should be traded to
 * achieve the 90% accuracy target.
 *
 * Confluence Factors:
 * - Multiple Levels: 2+ levels within 10 points (+20% confidence)
 * - Order Flow Divergence: OFI reversing during sweep (+15%)
 * - Book Absorption: High volume with neutral imbalance (+15%)
 * - GEX Level (vs session): GEX levels more reliable (+10%)
 * - Favorable Session: Overnight/premarket > RTH (+10%)
 * - LT Level Crossing: 74% directional accuracy (+10%)
 *
 * Confidence Tiers:
 * - A+: Level sweep + 3+ confluence factors (95%+ expected accuracy)
 * - A:  Level sweep + 2 confluence factors (90%+ expected accuracy)
 * - B:  Level sweep + 1 confluence factor (80-90% expected accuracy)
 * - C:  Level sweep only (70-80% expected accuracy)
 */

import { LEVEL_TYPES } from '../levels/level-calculator.js';

/**
 * Confidence tier definitions
 */
export const CONFIDENCE_TIERS = {
  A_PLUS: 'A+',
  A: 'A',
  B: 'B',
  C: 'C',
  D: 'D'  // Below minimum threshold
};

/**
 * Tier thresholds based on confluence count
 */
const TIER_THRESHOLDS = {
  [CONFIDENCE_TIERS.A_PLUS]: 3,  // 3+ confluence factors
  [CONFIDENCE_TIERS.A]: 2,       // 2 confluence factors
  [CONFIDENCE_TIERS.B]: 1,       // 1 confluence factor
  [CONFIDENCE_TIERS.C]: 0        // Base level sweep only
};

/**
 * Confluence factor weights
 */
const CONFLUENCE_WEIGHTS = {
  multipleLevels: 0.20,
  orderFlowDivergence: 0.15,
  bookAbsorption: 0.15,
  gexLevel: 0.10,
  favorableSession: 0.10,
  ltLevelCrossing: 0.10,
  strongWickRatio: 0.10,
  highVolumeSpike: 0.10
};

/**
 * GEX level types that count as high-quality levels
 */
const GEX_LEVEL_TYPES = [
  LEVEL_TYPES.GEX_GAMMA_FLIP,
  LEVEL_TYPES.GEX_PUT_WALL,
  LEVEL_TYPES.GEX_CALL_WALL,
  LEVEL_TYPES.GEX_SUPPORT_1,
  LEVEL_TYPES.GEX_RESISTANCE_1
];

/**
 * Sessions ranked by historical sweep accuracy
 */
const SESSION_SCORES = {
  overnight: 0.9,    // Best - institutional activity
  premarket: 0.85,   // Good - price discovery
  rth: 0.7,          // Average - more noise
  afterhours: 0.6    // Below average
};

export class SweepConfluenceScorer {
  /**
   * @param {Object} config - Configuration
   * @param {Object} config.ltLoader - Liquidity Trigger data loader (optional)
   * @param {Object} config.orderFlowLoader - Order flow data loader (optional)
   * @param {Object} config.bookImbalanceLoader - Book imbalance loader (optional)
   */
  constructor(config = {}) {
    this.ltLoader = config.ltLoader || null;
    this.orderFlowLoader = config.orderFlowLoader || null;
    this.bookImbalanceLoader = config.bookImbalanceLoader || null;

    // State for LT level tracking
    this.lastLtLevels = null;
    this.ltCrossingDetected = false;

    // Statistics
    this.stats = {
      sweepsScored: 0,
      byTier: {
        [CONFIDENCE_TIERS.A_PLUS]: 0,
        [CONFIDENCE_TIERS.A]: 0,
        [CONFIDENCE_TIERS.B]: 0,
        [CONFIDENCE_TIERS.C]: 0,
        [CONFIDENCE_TIERS.D]: 0
      },
      avgConfidence: 0,
      totalConfidence: 0
    };
  }

  /**
   * Score a detected sweep and assign confluence factors
   * @param {Object} sweep - Sweep detection result from LevelSweepDetector
   * @returns {Object} Scored sweep with tier and confluence details
   */
  score(sweep) {
    this.stats.sweepsScored++;

    const confluenceFactors = [];
    let totalWeight = 0;

    // 1. Check for multiple levels
    const multipleLevels = this.checkMultipleLevels(sweep);
    if (multipleLevels.detected) {
      confluenceFactors.push({
        factor: 'multipleLevels',
        weight: CONFLUENCE_WEIGHTS.multipleLevels,
        details: multipleLevels
      });
      totalWeight += CONFLUENCE_WEIGHTS.multipleLevels;
    }

    // 2. Check for GEX level (higher quality than session levels)
    const gexLevel = this.checkGexLevel(sweep);
    if (gexLevel.detected) {
      confluenceFactors.push({
        factor: 'gexLevel',
        weight: CONFLUENCE_WEIGHTS.gexLevel,
        details: gexLevel
      });
      totalWeight += CONFLUENCE_WEIGHTS.gexLevel;
    }

    // 3. Check favorable session
    const favorableSession = this.checkFavorableSession(sweep);
    if (favorableSession.detected) {
      confluenceFactors.push({
        factor: 'favorableSession',
        weight: CONFLUENCE_WEIGHTS.favorableSession,
        details: favorableSession
      });
      totalWeight += CONFLUENCE_WEIGHTS.favorableSession;
    }

    // 4. Check for strong wick ratio (above 70%)
    const strongWick = this.checkStrongWick(sweep);
    if (strongWick.detected) {
      confluenceFactors.push({
        factor: 'strongWickRatio',
        weight: CONFLUENCE_WEIGHTS.strongWickRatio,
        details: strongWick
      });
      totalWeight += CONFLUENCE_WEIGHTS.strongWickRatio;
    }

    // 5. Check for exceptional volume spike
    const highVolume = this.checkHighVolumeSpike(sweep);
    if (highVolume.detected) {
      confluenceFactors.push({
        factor: 'highVolumeSpike',
        weight: CONFLUENCE_WEIGHTS.highVolumeSpike,
        details: highVolume
      });
      totalWeight += CONFLUENCE_WEIGHTS.highVolumeSpike;
    }

    // 6. Check order flow divergence (if loader available)
    if (this.orderFlowLoader) {
      const ofiDivergence = this.checkOrderFlowDivergence(sweep);
      if (ofiDivergence.detected) {
        confluenceFactors.push({
          factor: 'orderFlowDivergence',
          weight: CONFLUENCE_WEIGHTS.orderFlowDivergence,
          details: ofiDivergence
        });
        totalWeight += CONFLUENCE_WEIGHTS.orderFlowDivergence;
      }
    }

    // 7. Check book absorption (if loader available)
    if (this.bookImbalanceLoader) {
      const absorption = this.checkBookAbsorption(sweep);
      if (absorption.detected) {
        confluenceFactors.push({
          factor: 'bookAbsorption',
          weight: CONFLUENCE_WEIGHTS.bookAbsorption,
          details: absorption
        });
        totalWeight += CONFLUENCE_WEIGHTS.bookAbsorption;
      }
    }

    // 8. Check LT level crossing (if loader available)
    if (this.ltLoader) {
      const ltCrossing = this.checkLtLevelCrossing(sweep);
      if (ltCrossing.detected) {
        confluenceFactors.push({
          factor: 'ltLevelCrossing',
          weight: CONFLUENCE_WEIGHTS.ltLevelCrossing,
          details: ltCrossing
        });
        totalWeight += CONFLUENCE_WEIGHTS.ltLevelCrossing;
      }
    }

    // Calculate confidence score
    const baseConfidence = sweep.confidence || 0.5;
    const confluenceBoost = totalWeight;
    const finalConfidence = Math.min(baseConfidence + confluenceBoost, 1.0);

    // Determine tier based on confluence count
    const confluenceCount = confluenceFactors.length;
    let tier;

    if (confluenceCount >= TIER_THRESHOLDS[CONFIDENCE_TIERS.A_PLUS]) {
      tier = CONFIDENCE_TIERS.A_PLUS;
    } else if (confluenceCount >= TIER_THRESHOLDS[CONFIDENCE_TIERS.A]) {
      tier = CONFIDENCE_TIERS.A;
    } else if (confluenceCount >= TIER_THRESHOLDS[CONFIDENCE_TIERS.B]) {
      tier = CONFIDENCE_TIERS.B;
    } else {
      tier = CONFIDENCE_TIERS.C;
    }

    // Update statistics
    this.stats.byTier[tier]++;
    this.stats.totalConfidence += finalConfidence;
    this.stats.avgConfidence = this.stats.totalConfidence / this.stats.sweepsScored;

    // Build scored sweep result
    return {
      ...sweep,
      scoring: {
        tier,
        confluenceCount,
        confluenceFactors,
        totalWeight: Math.round(totalWeight * 100) / 100,
        baseConfidence: Math.round(baseConfidence * 100) / 100,
        finalConfidence: Math.round(finalConfidence * 100) / 100,
        tradeable: tier === CONFIDENCE_TIERS.A_PLUS || tier === CONFIDENCE_TIERS.A
      }
    };
  }

  /**
   * Check for multiple levels near the sweep
   * @param {Object} sweep - Sweep object
   * @returns {Object} { detected, count, levels }
   */
  checkMultipleLevels(sweep) {
    const nearbyLevels = sweep.nearbyLevels || [];
    const withinTolerance = nearbyLevels.filter(l => l.distance <= 10);

    return {
      detected: withinTolerance.length >= 2,
      count: withinTolerance.length,
      levels: withinTolerance.map(l => ({ type: l.type, price: l.price, distance: l.distance }))
    };
  }

  /**
   * Check if sweep occurred at a GEX level
   * @param {Object} sweep - Sweep object
   * @returns {Object} { detected, levelType }
   */
  checkGexLevel(sweep) {
    const level = sweep.level;
    if (!level) {
      return { detected: false };
    }

    const isGexLevel = GEX_LEVEL_TYPES.includes(level.type);

    return {
      detected: isGexLevel,
      levelType: level.type,
      levelStrength: level.strength
    };
  }

  /**
   * Check if sweep occurred in a favorable session
   * @param {Object} sweep - Sweep object
   * @returns {Object} { detected, session, score }
   */
  checkFavorableSession(sweep) {
    const session = sweep.session;
    const score = SESSION_SCORES[session] || 0.5;

    return {
      detected: score >= 0.8,  // overnight or premarket
      session,
      score
    };
  }

  /**
   * Check for exceptionally strong wick ratio (>70%)
   * @param {Object} sweep - Sweep object
   * @returns {Object} { detected, ratio }
   */
  checkStrongWick(sweep) {
    const wickRatio = sweep.wick?.ratio || 0;

    return {
      detected: wickRatio >= 0.70,
      ratio: wickRatio
    };
  }

  /**
   * Check for exceptional volume spike (z-score > 3.0)
   * @param {Object} sweep - Sweep object
   * @returns {Object} { detected, zScore, percentile }
   */
  checkHighVolumeSpike(sweep) {
    const volumeZ = sweep.volumeSpike?.volumeZ || 0;
    const percentile = sweep.volumeSpike?.volumePercentile || 50;

    return {
      detected: volumeZ >= 3.0 || percentile >= 95,
      zScore: volumeZ,
      percentile
    };
  }

  /**
   * Check for order flow divergence
   * OFI should be reversing in the direction of the sweep
   * @param {Object} sweep - Sweep object
   * @returns {Object} { detected, ofiDirection, sweepDirection }
   */
  checkOrderFlowDivergence(sweep) {
    if (!this.orderFlowLoader) {
      return { detected: false };
    }

    // Get OFI data around sweep timestamp
    const ofi = this.orderFlowLoader.getOFI?.(sweep.timestamp);
    if (!ofi) {
      return { detected: false };
    }

    // For a bullish sweep (going long), we want OFI to be turning positive
    // For a bearish sweep (going short), we want OFI to be turning negative
    const expectedDirection = sweep.direction === 'LONG' ? 'positive' : 'negative';
    const ofiDirection = ofi.delta > 0 ? 'positive' : 'negative';

    return {
      detected: ofiDirection === expectedDirection && Math.abs(ofi.delta) > ofi.threshold,
      ofiDirection,
      sweepDirection: sweep.direction,
      ofiDelta: ofi.delta
    };
  }

  /**
   * Check for book absorption
   * High volume with relatively neutral imbalance indicates absorption
   * @param {Object} sweep - Sweep object
   * @returns {Object} { detected, imbalance, volume }
   */
  checkBookAbsorption(sweep) {
    if (!this.bookImbalanceLoader) {
      return { detected: false };
    }

    const bookData = this.bookImbalanceLoader.getImbalance?.(sweep.timestamp);
    if (!bookData) {
      return { detected: false };
    }

    // Absorption: high volume but imbalance close to neutral
    const imbalanceRatio = Math.abs(bookData.imbalance) / (bookData.totalVolume || 1);
    const isAbsorption = imbalanceRatio < 0.3 && bookData.totalVolume > bookData.avgVolume * 2;

    return {
      detected: isAbsorption,
      imbalanceRatio: Math.round(imbalanceRatio * 100) / 100,
      volume: bookData.totalVolume,
      avgVolume: bookData.avgVolume
    };
  }

  /**
   * Check for LT level crossing
   * Based on research showing 74% directional accuracy
   * @param {Object} sweep - Sweep object
   * @returns {Object} { detected, crossingType, direction }
   */
  checkLtLevelCrossing(sweep) {
    if (!this.ltLoader) {
      return { detected: false };
    }

    const ltLevels = this.ltLoader.getLevels?.(sweep.timestamp);
    if (!ltLevels) {
      return { detected: false };
    }

    // Check if any LT level crossed through price recently
    const price = sweep.entry;
    const levels = [ltLevels.level_1, ltLevels.level_2, ltLevels.level_3, ltLevels.level_4, ltLevels.level_5]
      .filter(l => l !== null);

    // Simple check: is price very close to an LT level?
    const nearLT = levels.some(level => Math.abs(price - level) < 5);

    // More sophisticated: check if level crossed price since last check
    let crossingDetected = false;
    if (this.lastLtLevels) {
      for (let i = 0; i < levels.length; i++) {
        const currentLevel = levels[i];
        const prevLevel = [
          this.lastLtLevels.level_1,
          this.lastLtLevels.level_2,
          this.lastLtLevels.level_3,
          this.lastLtLevels.level_4,
          this.lastLtLevels.level_5
        ][i];

        if (prevLevel && currentLevel) {
          // Level crossed up through price
          if (prevLevel < price && currentLevel >= price) {
            crossingDetected = true;
          }
          // Level crossed down through price
          if (prevLevel > price && currentLevel <= price) {
            crossingDetected = true;
          }
        }
      }
    }

    this.lastLtLevels = ltLevels;

    return {
      detected: nearLT || crossingDetected,
      nearLT,
      crossingDetected,
      sentiment: ltLevels.sentiment
    };
  }

  /**
   * Score multiple sweeps
   * @param {Object[]} sweeps - Array of sweeps
   * @returns {Object[]} Array of scored sweeps
   */
  scoreAll(sweeps) {
    return sweeps.map(sweep => this.score(sweep));
  }

  /**
   * Filter sweeps to tradeable tier (A+ and A only)
   * @param {Object[]} scoredSweeps - Array of scored sweeps
   * @returns {Object[]} Filtered sweeps
   */
  getTradeableSweeps(scoredSweeps) {
    return scoredSweeps.filter(s => s.scoring.tradeable);
  }

  /**
   * Get sweeps by tier
   * @param {Object[]} scoredSweeps - Array of scored sweeps
   * @param {string} tier - Tier to filter by
   * @returns {Object[]} Filtered sweeps
   */
  getSweepsByTier(scoredSweeps, tier) {
    return scoredSweeps.filter(s => s.scoring.tier === tier);
  }

  /**
   * Get statistics
   * @returns {Object} Scoring statistics
   */
  getStats() {
    return { ...this.stats };
  }

  /**
   * Reset state and statistics
   */
  reset() {
    this.lastLtLevels = null;
    this.ltCrossingDetected = false;
    this.stats = {
      sweepsScored: 0,
      byTier: {
        [CONFIDENCE_TIERS.A_PLUS]: 0,
        [CONFIDENCE_TIERS.A]: 0,
        [CONFIDENCE_TIERS.B]: 0,
        [CONFIDENCE_TIERS.C]: 0,
        [CONFIDENCE_TIERS.D]: 0
      },
      avgConfidence: 0,
      totalConfidence: 0
    };
  }

  /**
   * Get tier distribution as percentages
   * @returns {Object} Tier percentages
   */
  getTierDistribution() {
    const total = this.stats.sweepsScored;
    if (total === 0) return {};

    return {
      [CONFIDENCE_TIERS.A_PLUS]: Math.round((this.stats.byTier[CONFIDENCE_TIERS.A_PLUS] / total) * 100),
      [CONFIDENCE_TIERS.A]: Math.round((this.stats.byTier[CONFIDENCE_TIERS.A] / total) * 100),
      [CONFIDENCE_TIERS.B]: Math.round((this.stats.byTier[CONFIDENCE_TIERS.B] / total) * 100),
      [CONFIDENCE_TIERS.C]: Math.round((this.stats.byTier[CONFIDENCE_TIERS.C] / total) * 100)
    };
  }
}

export default SweepConfluenceScorer;
