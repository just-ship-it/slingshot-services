/**
 * GEX-LDPM Confluence Zone Strategy - Shared Implementation
 *
 * Mean reversion strategy trading at confluence zones where GEX and LDPM levels cluster.
 * Based on analysis showing 98.3% correlation between GEX and LDPM levels.
 * Trades reversal back to confluence zone center when price moves 15+ points away.
 */

import { BaseStrategy } from './base-strategy.js';
import {
  isValidCandle,
  roundTo,
  roundToNQTick,
  calculateDistance,
  isWithinTimeWindow
} from './strategy-utils.js';
import { ImbalanceDetector } from './imbalance-detector.js';

export class GexLdpmConfluenceStrategy extends BaseStrategy {
  constructor(params = {}) {
    super(params);

    // Default strategy parameters
    this.defaultParams = {
      // Entry parameters
      confluenceThreshold: 10.0,        // Max distance between GEX and LDPM levels to form confluence
      entryDistance: 15.0,              // Points away from confluence to trigger entry
      volumeConfirmationPct: 20,        // Volume must be X% above average

      // Risk management
      stopLossPoints: 40.0,             // Fixed stop loss distance (optimized)
      targetAtCenter: true,             // Take profit at confluence zone center
      maxRisk: 50.0,                    // Maximum risk per trade

      // Position sizing based on regime
      positiveRegimeSize: 1.0,          // Standard size in positive GEX regime
      negativeRegimeSize: 1.3,          // Larger size in negative regime (lower vol)
      transitionRegimeSize: 0.7,        // Smaller size during regime transitions

      // Time filters
      rthOnly: false,                   // Trade only during RTH (9:30-16:00 EST)
      overnightReduced: true,           // Reduce position size overnight
      overnightSizeMultiplier: 0.8,     // Size multiplier for overnight

      // Session-based filtering (NEW)
      useSessionFilter: false,          // Enable session-based trade filtering
      blockedSessions: [],              // Sessions to block: 'overnight', 'premarket', 'afterhours'
      // Session definitions (in UTC):
      // overnight: 00:00-06:00 UTC (19:00-01:00 EST)
      // premarket: 06:00-09:00 UTC (01:00-04:00 EST)
      // afterhours: 21:00-00:00 UTC (16:00-19:00 EST)

      // LT Level Ordering Filters (NEW)
      useLTOrderingFilter: false,       // Enable LT level ordering-based filtering
      requireLT4BelowLT5: true,        // Require LT4 < LT5 (ascending pattern) - 42.5% vs 40.2% win rate
      requireLT1AboveLT2: false,       // Require LT1 > LT2 (descending pattern) - optional enhancement
      requireLT2AboveLT3: false,       // Require LT2 > LT3 (descending pattern) - optional enhancement

      // Cooldowns and filters
      signalCooldownMs: 300000,         // 5 minutes between signals
      tradingSymbol: 'NQ1!',
      defaultQuantity: 1,

      // Volume calculation
      volumeLookbackPeriods: 20,        // Periods for volume average calculation

      // Economic news filter
      avoidNewsMinutes: 30,             // Minutes to avoid trading around major releases

      // Logging
      verbose: false,                   // Enable verbose logging (regime transitions, etc.)

      // LT Level Entry System (NEW)
      useLTLevelEntries: false,         // Enable LT level based entries
      ltEntryTimeoutCandles: 6,         // Max candles to wait for LT level fill (1.5 hours)
      ltMinSpacing: 15.0,               // Minimum spacing for LT level to be considered
      ltMaxDistance: 150.0,             // Maximum distance to LT level for entry
      ltFallbackToSignal: true,         // Fall back to signal price if timeout

      // Fair Value Gap (FVG) Entry System (DEPRECATED)
      useFVGEntries: false,             // Disable FVG entries in favor of LT levels
      fvgTimeframe: '15m',              // Timeframe for FVG detection
      fvgLookback: 100,                 // Number of 15m candles to scan
      fvgMinSize: 5.0,                  // Minimum gap size in points
      fvgMaxAge: 48,                    // Hours before FVG expires
      ltFvgProximity: 50.0,             // Max distance LT level to FVG edge (more permissive)
      fvgEntryBuffer: 2.0,              // Points buffer from exact LT level
      fvgFillThreshold: 0.8             // Consider FVG filled if 80% retraced
    };

    // Merge with provided parameters
    this.params = { ...this.defaultParams, ...params };

    // State tracking
    this.volumeHistory = [];
    this.lastRegime = null;
    this.regimeTransitionTime = null;
    this.confluenceZones = new Map(); // Cache for confluence zones

    // Initialize FVG detector if enabled
    this.imbalanceDetector = null;
    this.fvgCache = new Map(); // Cache for detected FVGs by timestamp
    if (this.params.useFVGEntries) {
      this.imbalanceDetector = new ImbalanceDetector({
        minGapSize: this.params.fvgMinSize,
        maxGapAge: this.params.fvgMaxAge,
        fillThreshold: this.params.fvgFillThreshold
      });
    }

    if (this.params.verbose) {
      console.log(`📊 GEX-LDPM Confluence Strategy initialized with params:`, this.params);
    }
  }

  /**
   * Main strategy evaluation method
   * Required by BaseStrategy interface
   */
  evaluateSignal(candle, prevCandle, marketData, options = {}) {
    try {
      // Validate inputs
      if (!isValidCandle(candle) || !prevCandle || !marketData) {
        return null;
      }

      // Check cooldown
      if (!this.checkCooldown(candle.timestamp, this.params.signalCooldownMs)) {
        return null;
      }

      // Validate required market data (gamma_flip is optional)
      const requiredFields = [
        'gexLevels.regime',
        'ltLevels.level_1',
        'ltLevels.level_2',
        'ltLevels.level_3'
      ];

      if (!this.validateMarketData(marketData, requiredFields)) {
        return null;
      }

      // Check time filters
      if (!this.isValidTradingTime(candle.timestamp)) {
        return null;
      }

      // Check LT level ordering filters
      if (this.params.useLTOrderingFilter && !this.isValidLTOrdering(marketData.ltLevels)) {
        return null;
      }

      // Update volume history
      this.updateVolumeHistory(candle);

      // Detect regime transitions
      this.updateRegimeState(marketData.gexLevels?.regime, candle.timestamp);

      // Find confluence zones
      const confluenceZones = this.findConfluenceZones(marketData);


      if (confluenceZones.length === 0) {
        return null;
      }

      // Check for signal at each confluence zone
      for (const zone of confluenceZones) {
        const signal = this.evaluateZoneSignal(candle, prevCandle, zone, marketData);
        if (signal) {
          this.updateLastSignalTime(candle.timestamp);
          return signal;
        }
      }

      return null;

    } catch (error) {
      console.error('❌ Error in GexLdpmConfluenceStrategy.evaluateSignal:', error);
      return null;
    }
  }

  /**
   * Find confluence zones where GEX and LDPM levels cluster
   */
  findConfluenceZones(marketData) {
    const zones = [];
    const gexLevels = this.extractGexLevels(marketData.gexLevels);
    const ldpmLevels = this.extractLdpmLevels(marketData.ltLevels);

    // Find clusters of levels within confluence threshold
    for (const gexLevel of gexLevels) {
      const nearbyLdpmLevels = ldpmLevels.filter(ldpmLevel =>
        Math.abs(gexLevel.value - ldpmLevel.value) <= this.params.confluenceThreshold
      );

      if (nearbyLdpmLevels.length > 0) {
        // Calculate zone center as average of clustered levels
        const allLevels = [gexLevel, ...nearbyLdpmLevels];
        const center = allLevels.reduce((sum, level) => sum + level.value, 0) / allLevels.length;

        zones.push({
          center: roundTo(center, 0.25),
          gexLevel: gexLevel,
          ldpmLevels: nearbyLdpmLevels,
          strength: allLevels.length, // Number of levels in confluence
          types: [...new Set([gexLevel.type, ...nearbyLdpmLevels.map(l => l.type)])]
        });
      }
    }

    // Sort by strength (number of levels) descending
    return zones.sort((a, b) => b.strength - a.strength);
  }

  /**
   * Evaluate signal for a specific confluence zone
   */
  evaluateZoneSignal(candle, prevCandle, zone, marketData) {
    const currentPrice = candle.close;
    const distanceFromZone = Math.abs(currentPrice - zone.center);

    // Check if price is far enough from zone to trigger entry
    if (distanceFromZone < this.params.entryDistance) {
      return null;
    }

    // Determine signal direction
    const isLong = currentPrice < zone.center; // Price below zone = long signal
    const isShort = currentPrice > zone.center; // Price above zone = short signal

    // Volume confirmation
    if (!this.checkVolumeConfirmation(candle)) {
      return null;
    }

    // Calculate position sizing based on regime
    const positionSize = this.calculatePositionSize(marketData.gexLevels?.regime, candle.timestamp);

    // Target is always the confluence zone center (mean reversion)
    const takeProfit = zone.center;

    let entryPrice, stopLoss, risk, ltContext = null, fvgContext = null;

    // Try to find FVG-LT confluence entry if enabled
    if (this.params.useLTLevelEntries && marketData.ltLevels) {
      const ltLevels = this.extractLdpmLevels(marketData.ltLevels);

      // Debug logging
      if (this.params.verbose) {
        console.log(`🔍 LT Level Analysis: Price: ${currentPrice}, Direction: ${isLong ? 'LONG' : 'SHORT'}`);
      }

      const fvgEntry = this.findLTFVGEntry(currentPrice, isLong, ltLevels, marketData.fvgData, takeProfit);

      if (fvgEntry) {
        entryPrice = fvgEntry.price;
        stopLoss = fvgEntry.stopLevel;
        risk = fvgEntry.risk;

        fvgContext = {
          nearbyFVG: {
            type: fvgEntry.fvg.type,
            top: fvgEntry.fvg.top,
            bottom: fvgEntry.fvg.bottom,
            size: fvgEntry.fvg.size,
            age_hours: fvgEntry.fvg.age_hours,
            fill_percentage: fvgEntry.fvg.fill_percentage
          },
          ltEntry: {
            level: fvgEntry.ltLevel.value,
            type: fvgEntry.ltLevel.type,
            importance: fvgEntry.ltLevel.importance,
            distanceFromFVG: this.imbalanceDetector.calculateGapDistance(fvgEntry.ltLevel.value, fvgEntry.fvg).toNearEdge
          },
          entryRational: `${fvgEntry.ltLevel.type}_${isLong ? 'above' : 'below'}_${fvgEntry.fvg.type}`,
          entryScore: fvgEntry.score,
          riskReward: fvgEntry.riskReward
        };

        if (this.params.verbose) {
          console.log(`🎯 FVG-LT Entry Found: ${fvgEntry.ltLevel.type} (${fvgEntry.ltLevel.value}) ${isLong ? 'above' : 'below'} ${fvgEntry.fvg.type} (${fvgEntry.fvg.top}-${fvgEntry.fvg.bottom})`);
        }
      } else {
        if (this.params.verbose) {
          console.log(`⚠️ No FVG-LT confluence found, falling back to current price entry`);
        }
      }
    }

    // Fallback to original entry logic if no FVG entry found
    if (!entryPrice) {
      // Entry is always at current candle close (the extreme)
      entryPrice = currentPrice;

      // Stop loss: protect against trend continuation
      // For LONG: stop below entry | For SHORT: stop above entry
      stopLoss = isLong ?
        entryPrice - this.params.stopLossPoints :  // LONG: stop below entry
        entryPrice + this.params.stopLossPoints;   // SHORT: stop above entry
      risk = Math.abs(entryPrice - stopLoss);
    }

    // Risk validation
    if (risk > this.params.maxRisk) {
      return null;
    }

    // Create signal
    const signal = {
      id: `signal_${candle.timestamp}`,
      strategy: 'gex-ldpm-confluence',
      action: 'place_limit',
      side: isLong ? 'buy' : 'sell',
      symbol: this.params.tradingSymbol,
      price: roundToNQTick(entryPrice),
      stop_loss: roundToNQTick(stopLoss),
      take_profit: roundToNQTick(takeProfit),
      quantity: Math.round(this.params.defaultQuantity * positionSize),
      trailing_trigger: this.params.useTrailingStop ? this.params.trailingTrigger : null,
      trailing_offset: this.params.useTrailingStop ? this.params.trailingOffset : null,

      // Signal metadata
      timestamp: candle.timestamp,
      confluenceZone: {
        center: zone.center,
        strength: zone.strength,
        types: zone.types,
        distanceFromPrice: distanceFromZone
      },
      regime: marketData.gexLevels?.regime,
      riskPoints: risk,
      rewardPoints: Math.abs(takeProfit - entryPrice),
      riskRewardRatio: Math.abs(takeProfit - entryPrice) / risk,

      // Technical context
      volume: candle.volume,
      avgVolume: this.getAverageVolume(),
      volumeRatio: candle.volume / this.getAverageVolume(),

      // Debugging info
      debug: {
        gexLevels: zone.gexLevel,
        ldpmLevels: zone.ldpmLevels.map(l => ({ type: l.type, value: l.value })),
        positionSizeMultiplier: positionSize,
        entryMethod: fvgContext ? 'fvg_lt_confluence' : 'current_price',
        fvgContext: fvgContext
      },

      // Capture ALL available LT levels for historical analysis
      availableLTLevels: marketData.ltLevels ? {
        level_1: roundToNQTick(marketData.ltLevels.level_1),
        level_2: roundToNQTick(marketData.ltLevels.level_2),
        level_3: roundToNQTick(marketData.ltLevels.level_3),
        level_4: roundToNQTick(marketData.ltLevels.level_4),
        level_5: roundToNQTick(marketData.ltLevels.level_5),
        sentiment: marketData.ltLevels.sentiment
      } : null,

      // Analysis metadata for optimal entry determination
      entryAnalysis: {
        signalPrice: roundToNQTick(currentPrice),
        confluenceTarget: roundToNQTick(takeProfit),
        actualEntryPrice: roundToNQTick(entryPrice),
        direction: isLong ? 'long' : 'short',
        distanceToConfluence: Math.abs(takeProfit - currentPrice)
      }
    };

    if (this.params.verbose) {
      const signalTime = new Date(candle.timestamp).toISOString();
      console.log(`📊 GEX-LDPM Confluence Signal Generated at ${signalTime}:`, {
        side: signal.side,
        price: signal.price,
        zone: zone.center,
        distance: distanceFromZone,
        regime: marketData.gexLevels?.regime,
        volume: `${(signal.volumeRatio).toFixed(2)}x avg`,
        timestamp: candle.timestamp,
        time: signalTime
      });
    }

    return signal;
  }

  /**
   * Extract GEX levels from market data
   */
  extractGexLevels(gexData) {
    const levels = [];

    // Gamma flip level
    if (gexData.nq_gamma_flip && !isNaN(gexData.nq_gamma_flip)) {
      levels.push({
        type: 'gamma_flip',
        value: gexData.nq_gamma_flip,
        importance: 'high'
      });
    }

    // Put walls
    ['nq_put_wall_1', 'nq_put_wall_2', 'nq_put_wall_3'].forEach((key, index) => {
      if (gexData[key] && !isNaN(gexData[key])) {
        levels.push({
          type: `put_wall_${index + 1}`,
          value: gexData[key],
          importance: index === 0 ? 'high' : 'medium'
        });
      }
    });

    // Call walls
    ['nq_call_wall_1', 'nq_call_wall_2', 'nq_call_wall_3'].forEach((key, index) => {
      if (gexData[key] && !isNaN(gexData[key])) {
        levels.push({
          type: `call_wall_${index + 1}`,
          value: gexData[key],
          importance: index === 0 ? 'high' : 'medium'
        });
      }
    });

    return levels;
  }

  /**
   * Extract LDPM levels from market data
   */
  extractLdpmLevels(ldpmData) {
    const levels = [];

    ['level_1', 'level_2', 'level_3', 'level_4', 'level_5'].forEach((key, index) => {
      if (ldpmData[key] && !isNaN(ldpmData[key])) {
        levels.push({
          type: `ldpm_${key}`,
          value: ldpmData[key],
          importance: index < 2 ? 'high' : 'medium', // Level 1 and 2 are most important
          sentiment: ldpmData.sentiment
        });
      }
    });

    return levels;
  }

  /**
   * Calculate position size based on GEX regime and timing
   */
  calculatePositionSize(regime, timestamp) {
    let multiplier = this.params.positiveRegimeSize; // Default

    // Regime-based sizing
    if (regime === 'negative') {
      multiplier = this.params.negativeRegimeSize;
    } else if (this.isRegimeTransition(timestamp)) {
      multiplier = this.params.transitionRegimeSize;
    }

    // Overnight reduction
    if (this.params.overnightReduced && !this.isRTH(timestamp)) {
      multiplier *= this.params.overnightSizeMultiplier;
    }

    return multiplier;
  }

  /**
   * Check if we're in a regime transition period
   */
  isRegimeTransition(timestamp) {
    if (!this.regimeTransitionTime) return false;

    // Consider it a transition for 2 hours after regime change
    const transitionDuration = 2 * 60 * 60 * 1000; // 2 hours in ms
    return (timestamp - this.regimeTransitionTime) < transitionDuration;
  }

  /**
   * Update regime state and detect transitions
   */
  updateRegimeState(currentRegime, timestamp) {
    if (this.lastRegime && this.lastRegime !== currentRegime) {
      this.regimeTransitionTime = timestamp;
      if (this.params.verbose) {
        console.log(`🔄 GEX Regime Transition: ${this.lastRegime} → ${currentRegime} at ${new Date(timestamp).toISOString()}`);
      }
    }
    this.lastRegime = currentRegime;
  }

  /**
   * Check if current time is valid for trading
   */
  isValidTradingTime(timestamp) {
    if (this.params.rthOnly && !this.isRTH(timestamp)) {
      return false;
    }

    // Check session-based filtering
    if (this.params.useSessionFilter && this.params.blockedSessions.length > 0) {
      const session = this.getCurrentSession(timestamp);
      if (this.params.blockedSessions.includes(session)) {
        return false;
      }
    }

    // Add economic news filter if needed
    // TODO: Implement news calendar integration

    return true;
  }

  /**
   * Check if LT level ordering meets filter criteria
   */
  isValidLTOrdering(ltLevels) {
    if (!ltLevels || !this.params.useLTOrderingFilter) {
      return true; // No filtering if disabled or no LT data
    }

    // Extract LT levels
    const lt1 = ltLevels.level_1;
    const lt2 = ltLevels.level_2;
    const lt3 = ltLevels.level_3;
    const lt4 = ltLevels.level_4;
    const lt5 = ltLevels.level_5;

    // Check if all required levels are available
    if (lt1 === undefined || lt2 === undefined || lt3 === undefined ||
        lt4 === undefined || lt5 === undefined) {
      return false; // Require all LT levels for ordering analysis
    }

    // Apply LT4 < LT5 filter (primary filter based on analysis)
    if (this.params.requireLT4BelowLT5 && lt4 >= lt5) {
      return false;
    }

    // Apply optional LT1 > LT2 filter (enhancement)
    if (this.params.requireLT1AboveLT2 && lt1 <= lt2) {
      return false;
    }

    // Apply optional LT2 > LT3 filter (enhancement)
    if (this.params.requireLT2AboveLT3 && lt2 <= lt3) {
      return false;
    }

    return true; // Passed all LT ordering filters
  }

  /**
   * Determine the current trading session
   */
  getCurrentSession(timestamp) {
    const date = new Date(timestamp);
    const hours = date.getUTCHours();
    const minutes = date.getUTCMinutes();
    const totalMinutes = hours * 60 + minutes;

    // Session definitions in UTC:
    // RTH: 14:30-21:00 UTC (9:30 AM - 4:00 PM EST)
    // After-hours: 21:00-00:00 UTC (4:00 PM - 7:00 PM EST)
    // Overnight: 00:00-06:00 UTC (7:00 PM - 1:00 AM EST)
    // Premarket: 06:00-14:30 UTC (1:00 AM - 9:30 AM EST)

    if (totalMinutes >= 0 && totalMinutes < 360) {
      return 'overnight'; // 00:00-06:00 UTC
    } else if (totalMinutes >= 360 && totalMinutes < 870) {
      return 'premarket'; // 06:00-14:30 UTC
    } else if (totalMinutes >= 870 && totalMinutes < 1260) {
      return 'rth'; // 14:30-21:00 UTC
    } else {
      return 'afterhours'; // 21:00-00:00 UTC
    }
  }

  /**
   * Check if timestamp is during Regular Trading Hours (RTH)
   */
  isRTH(timestamp) {
    const date = new Date(timestamp);
    const hours = date.getUTCHours();
    const minutes = date.getUTCMinutes();

    // RTH: 9:30 AM - 4:00 PM EST = 14:30 - 21:00 UTC
    const startTime = 14 * 60 + 30; // 14:30 UTC in minutes
    const endTime = 21 * 60; // 21:00 UTC in minutes
    const currentTime = hours * 60 + minutes;

    return currentTime >= startTime && currentTime < endTime;
  }

  /**
   * Update volume history for average calculation
   */
  updateVolumeHistory(candle) {
    this.volumeHistory.push(candle.volume);

    // Keep only last N periods
    if (this.volumeHistory.length > this.params.volumeLookbackPeriods) {
      this.volumeHistory.shift();
    }
  }

  /**
   * Get average volume from history
   */
  getAverageVolume() {
    if (this.volumeHistory.length === 0) return 1; // Default fallback - allow all trades initially

    return this.volumeHistory.reduce((sum, vol) => sum + vol, 0) / this.volumeHistory.length;
  }

  /**
   * Check volume confirmation
   */
  checkVolumeConfirmation(candle) {
    const avgVolume = this.getAverageVolume();
    const requiredVolume = avgVolume * (1 + this.params.volumeConfirmationPct / 100);

    return candle.volume >= requiredVolume;
  }

  /**
   * Find optimal entry using FVG-LT confluence
   *
   * @param {number} currentPrice - Current market price
   * @param {boolean} isLong - True for long position
   * @param {Array} ltLevels - Available LT levels
   * @param {Array} fvgData - Detected Fair Value Gaps
   * @param {number} confluenceTarget - Confluence zone center for target
   * @returns {Object|null} Entry details or null
   */
  findLTFVGEntry(currentPrice, isLong, ltLevels, fvgData, confluenceTarget) {
    if (!this.params.useFVGEntries || !fvgData || fvgData.length === 0) {
      return null;
    }

    // Find relevant FVGs for the trade direction
    const relevantGaps = this.imbalanceDetector.findRelevantGaps(fvgData, currentPrice, isLong);

    if (relevantGaps.length === 0) {
      return null;
    }

    // Find LT levels within proximity of FVGs
    let bestEntry = null;
    let bestScore = 0;

    for (const gap of relevantGaps) {
      for (const ltLevel of ltLevels) {
        const distance = this.imbalanceDetector.calculateGapDistance(ltLevel.value, gap);

        // Check if LT level is within proximity threshold
        if (distance.toNearEdge > this.params.ltFvgProximity) {
          continue;
        }

        // For long positions: LT level should be above bearish FVG
        // For short positions: LT level should be below bullish FVG
        let validPosition = false;
        let stopLevel = null;

        if (isLong && gap.type === 'bearish_fvg') {
          // LT level should be above the bearish gap
          if (ltLevel.value > gap.top) {
            validPosition = true;
            stopLevel = gap.bottom - this.params.fvgEntryBuffer; // Stop below FVG
          }
        } else if (!isLong && gap.type === 'bullish_fvg') {
          // LT level should be below the bullish gap
          if (ltLevel.value < gap.bottom) {
            validPosition = true;
            stopLevel = gap.top + this.params.fvgEntryBuffer; // Stop above FVG
          }
        }

        if (!validPosition) continue;

        // Calculate entry price with buffer
        const entryPrice = isLong ?
          ltLevel.value + this.params.fvgEntryBuffer :
          ltLevel.value - this.params.fvgEntryBuffer;

        // Calculate risk/reward
        const risk = Math.abs(entryPrice - stopLevel);
        const reward = Math.abs(confluenceTarget - entryPrice);
        const riskReward = reward / risk;

        // Skip if risk/reward is poor
        if (riskReward < 1.0 || risk > this.params.maxRisk) {
          continue;
        }

        // Score based on multiple factors
        const score = this.calculateEntryScore(ltLevel, gap, distance, riskReward);

        if (score > bestScore) {
          bestScore = score;
          bestEntry = {
            price: roundToNQTick(entryPrice),
            stopLevel: roundToNQTick(stopLevel),
            ltLevel: ltLevel,
            fvg: gap,
            riskReward: roundTo(riskReward, 0.1),
            risk: roundTo(risk, 0.25),
            reward: roundTo(reward, 0.25),
            score: roundTo(score, 0.1)
          };
        }
      }
    }

    return bestEntry;
  }

  /**
   * Calculate score for FVG-LT entry combination
   *
   * @param {Object} ltLevel - LT level object
   * @param {Object} gap - FVG object
   * @param {Object} distance - Distance calculations
   * @param {number} riskReward - Risk/reward ratio
   * @returns {number} Entry quality score
   */
  calculateEntryScore(ltLevel, gap, distance, riskReward) {
    let score = 0;

    // Prefer higher importance LT levels
    if (ltLevel.importance === 'high') score += 30;
    else if (ltLevel.importance === 'medium') score += 20;
    else score += 10;

    // Prefer larger FVGs (more significant imbalances)
    score += Math.min(gap.size * 2, 20); // Cap at 20 points

    // Prefer closer proximity to FVG
    const proximityScore = Math.max(0, 15 - distance.toNearEdge);
    score += proximityScore;

    // Prefer better risk/reward ratios
    score += Math.min(riskReward * 10, 30); // Cap at 30 points

    // Prefer newer FVGs
    const ageScore = Math.max(0, 10 - gap.age_hours / 4.8); // Decreases over 48 hours
    score += ageScore;

    // Prefer less filled FVGs
    score += (1 - gap.fill_percentage) * 10;

    return score;
  }

  /**
   * Reset strategy state for backtesting
   */
  reset() {
    super.reset();
    this.volumeHistory = [];
    this.lastRegime = null;
    this.regimeTransitionTime = null;
    this.confluenceZones.clear();
    if (this.fvgCache) {
      this.fvgCache.clear();
    }
  }

  /**
   * Get strategy configuration for reporting
   */
  getConfig() {
    return {
      strategy: 'gex-ldpm-confluence',
      version: '1.0.0',
      description: 'Mean reversion at GEX-LDPM confluence zones',
      parameters: this.params,
      requiredData: [
        'gex.nq_gamma_flip',
        'gex.regime',
        'gex.nq_put_wall_1',
        'gex.nq_call_wall_1',
        'ldpm.level_1',
        'ldpm.level_2',
        'ldpm.level_3',
        'ldpm.sentiment'
      ]
    };
  }
}

export default GexLdpmConfluenceStrategy;