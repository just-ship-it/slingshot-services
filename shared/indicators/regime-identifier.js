/**
 * RegimeIdentifier
 *
 * Main regime classification system that combines existing indicators:
 * - MarketStructureAnalyzer: Trend direction and structure breaks
 * - SqueezeMomentumIndicator: Volatility state (squeeze vs expansion)
 * - MomentumDivergenceDetector: Reversal signals
 * - TrendLineDetector: Trend line support/resistance
 * - RangeDetector: Range validation
 * - RegimeStabilizer: Anti-flapping mechanism
 *
 * Outputs 8-10 regime states:
 * - STRONG_TRENDING_UP/DOWN
 * - WEAK_TRENDING_UP/DOWN
 * - RANGING_TIGHT
 * - RANGING_CHOPPY
 * - BOUNCING_SUPPORT/RESISTANCE
 * - SESSION_OPENING
 * - NEUTRAL
 */

import { MarketStructureAnalyzer } from './market-structure.js';
import { SqueezeMomentumIndicator } from './squeeze-momentum.js';
import { MomentumDivergenceDetector } from './momentum-divergence.js';
import { TrendLineDetector } from './trend-line-detector.js';
import { RangeDetector } from './range-detector.js';
import { RegimeStabilizer } from './regime-stabilizer.js';
import { SessionFilter } from './session-filter.js';
import { TechnicalAnalysis } from '../utils/technical-analysis.js';

// Symbol-specific parameter configurations
const SYMBOL_CONFIGS = {
  NQ: {
    initialStopPoints: 20,
    profitProtectionPoints: 5,
    tickSize: 0.25,
    pointValue: 20,
    rangeATRMultiplier: 1.5,
    levelProximityPoints: 2,
    chopThreshold: 6
  },
  ES: {
    initialStopPoints: 8,
    profitProtectionPoints: 2,
    tickSize: 0.25,
    pointValue: 50,
    rangeATRMultiplier: 1.2,
    levelProximityPoints: 1,
    chopThreshold: 5
  }
};

export class RegimeIdentifier {
  constructor(params = {}) {
    // Get symbol-specific config
    const symbolConfig = SYMBOL_CONFIGS[params.symbol] || SYMBOL_CONFIGS.NQ;

    this.params = {
      // Symbol
      symbol: params.symbol || 'NQ',

      // Indicator parameters
      swingLookback: params.swingLookback || 5,
      trendLookbackSwings: params.trendLookbackSwings || 3,
      squeezeBBLength: params.squeezeBBLength || 20,
      squeezeKCLength: params.squeezeKCLength || 20,
      squeezeKCMult: params.squeezeKCMult || 1.5,
      atrPeriod: params.atrPeriod || 14,

      // Regime thresholds (aggressive settings for scalping)
      trendConfidenceThreshold: params.trendConfidenceThreshold || 55,
      weakTrendConfidenceThreshold: params.weakTrendConfidenceThreshold || 35,
      rangeATRMultiplier: params.rangeATRMultiplier || symbolConfig.rangeATRMultiplier,
      levelProximityPoints: params.levelProximityPoints || 4,  // Wider bouncing zone
      chopThreshold: params.chopThreshold || 4,  // Detect chop earlier

      // Session parameters
      sessionOpeningMinutes: params.sessionOpeningMinutes || 15,
      allowRTH: params.allowRTH !== undefined ? params.allowRTH : true,
      allowOvernight: params.allowOvernight !== undefined ? params.allowOvernight : true,

      ...symbolConfig,
      ...params
    };

    // Initialize indicators
    this.marketStructure = new MarketStructureAnalyzer({
      swingLookback: this.params.swingLookback,
      trendLookbackSwings: this.params.trendLookbackSwings
    });

    this.squeeze = new SqueezeMomentumIndicator({
      bbLength: this.params.squeezeBBLength,
      kcLength: this.params.squeezeKCLength,
      kcMult: this.params.squeezeKCMult
    });

    this.divergence = new MomentumDivergenceDetector();

    this.trendLineDetector = new TrendLineDetector({
      swingLookback: this.params.swingLookback
    });

    this.rangeDetector = new RangeDetector({
      maxRangeATRMultiplier: this.params.rangeATRMultiplier,
      touchProximity: this.params.levelProximityPoints
    });

    this.stabilizer = new RegimeStabilizer();

    this.sessionFilter = new SessionFilter({
      allowRTH: this.params.allowRTH,
      allowOvernight: this.params.allowOvernight,
      allowPremarket: this.params.allowPremarket,
      allowAftermarket: this.params.allowAftermarket
    });

    // State tracking
    this.lastTimestamp = null;
    this.structureBreakHistory = [];
  }

  /**
   * Main identification method - called for each candle
   *
   * @param {Object} currentCandle - Current candle
   * @param {Array} historicalCandles - Historical candles (including current)
   * @param {Object} options - Additional options
   * @returns {Object} Regime identification result
   */
  identify(currentCandle, historicalCandles, options = {}) {
    // Check session filter
    const sessionInfo = this.sessionFilter.getSessionInfo(currentCandle.timestamp);
    if (!sessionInfo.allowed) {
      return this.getBlockedResult(currentCandle, sessionInfo);
    }

    // Reset indicators if session changed
    if (this.lastTimestamp) {
      const shouldReset = this.sessionFilter.shouldResetIndicators(
        currentCandle.timestamp,
        this.lastTimestamp
      );

      if (shouldReset) {
        this.reset();
      }
    }

    this.lastTimestamp = currentCandle.timestamp;

    // Analyze market structure
    const structureResult = this.marketStructure.analyzeStructure(historicalCandles);
    const { swings, trendStructure } = structureResult;

    // Convert swings object to array format for other indicators
    const swingArray = [
      ...swings.highs.map(s => ({ ...s, type: 'high' })),
      ...swings.lows.map(s => ({ ...s, type: 'low' }))
    ].sort((a, b) => a.index - b.index);

    // Analyze volatility state
    const squeezeState = this.squeeze.calculate(historicalCandles);

    // Calculate ATR
    const atrValues = TechnicalAnalysis.atr(historicalCandles, this.params.atrPeriod);
    const currentATR = atrValues[atrValues.length - 1];

    // Detect trend lines
    const trendLines = this.trendLineDetector.detectTrendLines(
      historicalCandles,
      swingArray
    );

    // Detect ranging behavior
    const rangeData = this.rangeDetector.detectRange(
      historicalCandles,
      swingArray
    );

    // Track structure breaks for chop detection
    if (structureResult.structureBreak) {
      this.structureBreakHistory.push({
        timestamp: currentCandle.timestamp,
        type: structureResult.structureBreak
      });

      // Keep only recent breaks (last 20 candles)
      if (this.structureBreakHistory.length > 20) {
        this.structureBreakHistory.shift();
      }
    }

    // Classify regime
    const rawRegime = this.classifyRegime({
      currentCandle,
      historicalCandles,
      structure: trendStructure,
      squeeze: squeezeState,
      atr: currentATR,
      trendLines,
      rangeData,
      swings: swingArray,
      sessionInfo
    });

    // Stabilize regime to prevent flapping
    const stabilizedRegime = this.stabilizer.stabilizeRegime(rawRegime, currentCandle);

    // Return comprehensive result
    return {
      ...stabilizedRegime,
      metadata: {
        structure: {
          trend: trendStructure.trend,
          confidence: trendStructure.confidence,
          structureBreak: structureResult.structureBreak
        },
        squeeze: {
          state: squeezeState.squeeze.state,
          momentum: squeezeState.momentum
        },
        atr: currentATR,
        trendLines: {
          valid: trendLines.isValid,
          distanceToUpper: trendLines.distanceToUpper,
          distanceToLower: trendLines.distanceToLower
        },
        range: {
          isRanging: rangeData.isRanging,
          confidence: rangeData.confidence
        },
        session: sessionInfo.session,
        price: currentCandle.close
      }
    };
  }

  /**
   * Classify regime from indicator signals
   *
   * @param {Object} data - All indicator data
   * @returns {Object} Raw regime classification
   */
  classifyRegime(data) {
    const {
      currentCandle,
      historicalCandles,
      structure,
      squeeze,
      atr,
      trendLines,
      rangeData,
      swings,
      sessionInfo
    } = data;

    // Check for session opening regime (first 30 minutes of RTH)
    if (sessionInfo.session === 'rth') {
      const minutesIntoSession = this.sessionFilter.getMinutesIntoSession(
        currentCandle.timestamp
      );

      if (minutesIntoSession < this.params.sessionOpeningMinutes) {
        return {
          regime: 'SESSION_OPENING',
          confidence: 0.8
        };
      }
    }

    // Priority 1: Strong Trending
    if (structure.trend === 'bullish' &&
        structure.confidence >= this.params.trendConfidenceThreshold &&
        squeeze.squeeze.state !== 'squeeze_on') {
      return {
        regime: 'STRONG_TRENDING_UP',
        confidence: Math.min(structure.confidence / 100, 0.95)
      };
    }

    if (structure.trend === 'bearish' &&
        structure.confidence >= this.params.trendConfidenceThreshold &&
        squeeze.squeeze.state !== 'squeeze_on') {
      return {
        regime: 'STRONG_TRENDING_DOWN',
        confidence: Math.min(structure.confidence / 100, 0.95)
      };
    }

    // Priority 2: Weak Trending (with divergence or squeeze)
    if (structure.trend === 'bullish' &&
        structure.confidence >= this.params.weakTrendConfidenceThreshold &&
        (squeeze.squeeze.state === 'squeeze_on' || structure.confidence < this.params.trendConfidenceThreshold)) {
      return {
        regime: 'WEAK_TRENDING_UP',
        confidence: structure.confidence / 100 * 0.7
      };
    }

    if (structure.trend === 'bearish' &&
        structure.confidence >= this.params.weakTrendConfidenceThreshold &&
        (squeeze.squeeze.state === 'squeeze_on' || structure.confidence < this.params.trendConfidenceThreshold)) {
      return {
        regime: 'WEAK_TRENDING_DOWN',
        confidence: structure.confidence / 100 * 0.7
      };
    }

    // Priority 3: Ranging Tight (squeeze + valid range)
    if (squeeze.squeeze.state === 'squeeze_on' && rangeData.isRanging) {
      return {
        regime: 'RANGING_TIGHT',
        confidence: Math.min(rangeData.confidence + 0.2, 0.9)
      };
    }

    // Priority 4: Choppy (multiple structure breaks)
    const chopIntensity = this.calculateChopIntensity();
    if (chopIntensity >= this.params.chopThreshold) {
      return {
        regime: 'RANGING_CHOPPY',
        confidence: Math.min(chopIntensity / (this.params.chopThreshold * 2), 0.8)
      };
    }

    // Priority 5: Bouncing (near key levels with potential reversal)
    const levelProximity = this.checkLevelProximity(
      currentCandle,
      swings,
      trendLines,
      rangeData
    );

    if (levelProximity.nearLevel) {
      const regime = levelProximity.type === 'support'
        ? 'BOUNCING_SUPPORT'
        : 'BOUNCING_RESISTANCE';

      return {
        regime,
        confidence: levelProximity.confidence
      };
    }

    // Priority 6: Ranging (valid range detected)
    if (rangeData.isRanging) {
      return {
        regime: 'RANGING_TIGHT',
        confidence: rangeData.confidence
      };
    }

    // Priority 7: Momentum boost - escape NEUTRAL on squeeze fire
    // If squeeze just released and we have momentum, identify as weak trend
    if (squeeze.squeeze.state === 'squeeze_off' && squeeze.momentum) {
      const momentumValue = squeeze.momentum.value || squeeze.momentum;
      if (typeof momentumValue === 'number' && momentumValue !== 0) {
        if (momentumValue > 0) {
          return {
            regime: 'WEAK_TRENDING_UP',
            confidence: 0.5
          };
        } else {
          return {
            regime: 'WEAK_TRENDING_DOWN',
            confidence: 0.5
          };
        }
      }
    }

    // Default: Neutral (no clear regime) - scale confidence with structure
    return {
      regime: 'NEUTRAL',
      confidence: Math.max(0.2, (structure.confidence || 0) / 200)
    };
  }

  /**
   * Calculate chop intensity from structure break history
   *
   * @returns {number} Chop intensity score
   */
  calculateChopIntensity() {
    if (this.structureBreakHistory.length < 5) return 0;

    // Count structure breaks in recent history
    const recentBreaks = this.structureBreakHistory.slice(-15);

    // Count direction changes (bullish break -> bearish break or vice versa)
    let directionChanges = 0;
    for (let i = 1; i < recentBreaks.length; i++) {
      const prev = recentBreaks[i - 1].type;
      const curr = recentBreaks[i].type;

      if ((prev === 'bullish' && curr === 'bearish') ||
          (prev === 'bearish' && curr === 'bullish')) {
        directionChanges++;
      }
    }

    return directionChanges;
  }

  /**
   * Check if price is near key levels
   *
   * @param {Object} currentCandle
   * @param {Array} swings
   * @param {Object} trendLines
   * @param {Object} rangeData
   * @returns {Object} Level proximity data
   */
  checkLevelProximity(currentCandle, swings, trendLines, rangeData) {
    const price = currentCandle.close;
    const proximity = this.params.levelProximityPoints;

    // Check trend line proximity
    if (trendLines.isValid) {
      if (trendLines.lowerTrendLine.valid) {
        const distance = Math.abs(trendLines.distanceToLower);
        if (distance <= proximity) {
          return {
            nearLevel: true,
            type: 'support',
            level: trendLines.lowerTrendLine.currentValue,
            distance: distance,
            confidence: 0.75
          };
        }
      }

      if (trendLines.upperTrendLine.valid) {
        const distance = Math.abs(trendLines.distanceToUpper);
        if (distance <= proximity) {
          return {
            nearLevel: true,
            type: 'resistance',
            level: trendLines.upperTrendLine.currentValue,
            distance: distance,
            confidence: 0.75
          };
        }
      }
    }

    // Check range boundary proximity
    if (rangeData.isRanging) {
      const boundaryCheck = this.rangeDetector.isNearBoundary(rangeData);

      if (boundaryCheck.nearSupport) {
        return {
          nearLevel: true,
          type: 'support',
          level: rangeData.support,
          distance: Math.abs(price - rangeData.support),
          confidence: 0.8
        };
      }

      if (boundaryCheck.nearResistance) {
        return {
          nearLevel: true,
          type: 'resistance',
          level: rangeData.resistance,
          distance: Math.abs(price - rangeData.resistance),
          confidence: 0.8
        };
      }
    }

    // Check swing level proximity
    if (swings.length >= 2) {
      const recentSwingLows = swings
        .filter(s => s.type === 'low')
        .slice(-3)
        .map(s => s.price);

      const recentSwingHighs = swings
        .filter(s => s.type === 'high')
        .slice(-3)
        .map(s => s.price);

      // Check support (swing lows)
      for (const swingLow of recentSwingLows) {
        const distance = Math.abs(price - swingLow);
        if (distance <= proximity) {
          return {
            nearLevel: true,
            type: 'support',
            level: swingLow,
            distance: distance,
            confidence: 0.7
          };
        }
      }

      // Check resistance (swing highs)
      for (const swingHigh of recentSwingHighs) {
        const distance = Math.abs(price - swingHigh);
        if (distance <= proximity) {
          return {
            nearLevel: true,
            type: 'resistance',
            level: swingHigh,
            distance: distance,
            confidence: 0.7
          };
        }
      }
    }

    return {
      nearLevel: false,
      type: null,
      level: null,
      distance: null,
      confidence: 0
    };
  }

  /**
   * Get blocked result for filtered sessions
   */
  getBlockedResult(currentCandle, sessionInfo) {
    return {
      regime: 'SESSION_BLOCKED',
      confidence: 1.0,
      transitionState: 'blocked',
      candlesInRegime: 0,
      metadata: {
        session: sessionInfo.session,
        price: currentCandle.close,
        reason: 'Session filtered out'
      }
    };
  }

  /**
   * Reset indicators (e.g., at session boundaries)
   */
  reset() {
    this.stabilizer.reset();
    this.structureBreakHistory = [];
    this.sessionFilter.reset();
  }

  /**
   * Get parameter configuration
   */
  getParams() {
    return { ...this.params };
  }
}

// Preset configurations for different trading styles
const REGIME_PRESETS = {
  conservative: {
    // Original conservative settings - long regime durations, high confidence required
    minRegimeDuration: 5,
    changeConfidenceThreshold: 0.7,
    maintainConfidenceThreshold: 0.5,
    consensusWindowSize: 20,
    consensusThreshold: 0.6,
    trendConfidenceThreshold: 70,
    weakTrendConfidenceThreshold: 50,
    sessionOpeningMinutes: 30,
    levelProximityPoints: 2,
    chopThreshold: 6
  },
  balanced: {
    // Middle ground - moderate responsiveness
    minRegimeDuration: 3,
    changeConfidenceThreshold: 0.6,
    maintainConfidenceThreshold: 0.45,
    consensusWindowSize: 12,
    consensusThreshold: 0.5,
    trendConfidenceThreshold: 60,
    weakTrendConfidenceThreshold: 40,
    sessionOpeningMinutes: 20,
    levelProximityPoints: 3,
    chopThreshold: 5
  },
  aggressive: {
    // Current defaults - fast regime transitions for scalping
    minRegimeDuration: 2,
    changeConfidenceThreshold: 0.55,
    maintainConfidenceThreshold: 0.4,
    consensusWindowSize: 8,
    consensusThreshold: 0.4,
    trendConfidenceThreshold: 55,
    weakTrendConfidenceThreshold: 35,
    sessionOpeningMinutes: 15,
    levelProximityPoints: 4,
    chopThreshold: 4
  },
  ultraAggressive: {
    // Maximum responsiveness - for testing only
    minRegimeDuration: 1,
    changeConfidenceThreshold: 0.45,
    maintainConfidenceThreshold: 0.35,
    consensusWindowSize: 5,
    consensusThreshold: 0.3,
    trendConfidenceThreshold: 45,
    weakTrendConfidenceThreshold: 30,
    sessionOpeningMinutes: 10,
    levelProximityPoints: 5,
    chopThreshold: 3
  }
};

export { SYMBOL_CONFIGS, REGIME_PRESETS };
