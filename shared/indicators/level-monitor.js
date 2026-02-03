/**
 * Level Monitoring Engine
 *
 * Monitors confluence zones in real-time to detect when price tests levels
 * and provides confirmation signals for entries based on level behavior.
 *
 * Key Features:
 * - Real-time level proximity tracking
 * - Support/resistance behavior detection
 * - Confirmation pattern recognition
 * - Entry timing optimization
 */

export class LevelMonitor {
  constructor(options = {}) {
    this.options = {
      // Proximity thresholds
      approachThreshold: options.approachThreshold || 15,   // Points to consider "approaching"
      testThreshold: options.testThreshold || 5,           // Points to consider "testing"
      breachThreshold: options.breachThreshold || 3,       // Points to consider "breached"

      // Timing parameters
      confirmationPeriod: options.confirmationPeriod || 3, // Candles to confirm level holding
      maxWaitTime: options.maxWaitTime || 4 * 60 * 60 * 1000, // 4 hours in milliseconds
      minHoldTime: options.minHoldTime || 15 * 60 * 1000,  // 15 minutes in milliseconds

      // Recovery timeout (X bars for multi-candle recovery patterns)
      maxRecoveryBars: options.maxRecoveryBars || 6,       // Max bars to wait for recovery (6 x 15min = 90min)
      candleIntervalMs: options.candleIntervalMs || 15 * 60 * 1000, // 15 minutes per candle

      // Pattern recognition
      confirmationCandleType: options.confirmationCandleType || 'close_above', // 'close_above', 'bounce_back'
      requireVolumeConfirmation: options.requireVolumeConfirmation || false,

      // Stop loss configuration
      useStructuralStops: options.useStructuralStops || false,  // Toggle between structural and fixed stops
      stopLossPoints: options.stopLossPoints || 40,             // Fixed stop loss distance when not using structural
      stopBuffer: options.stopBuffer || 3,                      // Buffer for structural stops

      ...options
    };

    // Tracking data
    this.monitoredLevels = new Map();
    this.levelEvents = [];
    this.confirmationSignals = [];
  }

  /**
   * Start monitoring a confluence zone for entry opportunities
   */
  monitorLevel(levelData, signal, currentTimestamp = null) {
    // Use provided timestamp (for backtesting) or current time (for live trading)
    const timestamp = currentTimestamp || Date.now();
    const levelPrice = levelData.price || levelData.centerPrice; // Support legacy format
    const levelId = `${levelPrice.toFixed(2)}_${timestamp}`;

    const monitoredLevel = {
      id: levelId,
      levelData: levelData,
      originalSignal: signal,
      status: 'monitoring',

      // Store individual levels for precise testing
      individualLevels: levelData.levels || [],

      // Tracking states
      approached: false,
      tested: false,
      breached: false,
      holding: false,
      confirmed: false,
      levelLost: false,
      lostLevelPrice: null,

      // Timing
      originalSignalTime: signal.timestamp || timestamp,  // When initial confluence was detected
      monitoringStartTime: timestamp,                     // When we started monitoring this level
      startTime: timestamp,                               // Keeping for backward compatibility
      approachTime: null,
      testTime: null,
      confirmationTime: null,

      // Recovery tracking
      recoveryStartTime: null,      // When level was first lost (recovery attempt begins)
      recoveryExpired: false,       // Whether recovery period has expired

      // Price tracking
      closestApproach: null,
      testLow: null,       // Tracks the actual lowest low during monitoring (our structural sweep)
      testHigh: null,      // Tracks the actual highest high during monitoring (our structural sweep)
      confirmationCandle: null,
      confirmationType: null,
      testedLevel: null,

      // Events log
      events: []
    };

    this.monitoredLevels.set(levelId, monitoredLevel);
    this.logLevelEvent(levelId, 'monitoring_started', 'Started monitoring confluence zone');

    return levelId;
  }

  /**
   * Process new candle data for all monitored levels
   */
  processCandle(candle) {
    const confirmationSignals = [];

    this.monitoredLevels.forEach((monitoredLevel, levelId) => {
      if (monitoredLevel.status === 'expired' || monitoredLevel.status === 'confirmed') {
        return;
      }

      const result = this.processLevelCandle(monitoredLevel, candle);
      if (result && result.type === 'confirmation') {
        confirmationSignals.push(result);
      }

      // Check for timeout
      const elapsed = candle.timestamp - monitoredLevel.startTime;
      if (elapsed > this.options.maxWaitTime) {
        this.expireLevel(levelId, 'timeout');
      }
    });

    return confirmationSignals;
  }

  /**
   * Process candle for a specific monitored level
   */
  processLevelCandle(monitoredLevel, candle) {
    const zone = monitoredLevel.levelData;
    const signal = monitoredLevel.originalSignal;

    // ALWAYS track price extremes throughout the monitoring period
    // These represent the actual structural points that were tested
    if (monitoredLevel.testLow === null || candle.low < monitoredLevel.testLow) {
      monitoredLevel.testLow = candle.low;
    }
    if (monitoredLevel.testHigh === null || candle.high > monitoredLevel.testHigh) {
      monitoredLevel.testHigh = candle.high;
    }

    // For each level in the zone, check for support/resistance
    for (const level of monitoredLevel.individualLevels || [zone]) {
      const levelPrice = level.price || zone.price;

      // Pattern 1: Check for wick rejection (sweep and recovery in same candle)
      const wickRejection = this.checkWickRejection(candle, levelPrice, signal.side);
      if (wickRejection && !monitoredLevel.confirmed) {
        monitoredLevel.confirmed = true;
        monitoredLevel.testTime = candle.timestamp;      // When level was tested
        monitoredLevel.confirmationTime = candle.timestamp;  // Same for wick rejection
        monitoredLevel.confirmationCandle = candle;
        monitoredLevel.lastTestCandle = candle;  // Track the actual candle that tested the level
        monitoredLevel.status = 'confirmed';
        monitoredLevel.confirmationType = 'wick_rejection';
        monitoredLevel.testedLevel = levelPrice;

        this.logLevelEvent(monitoredLevel.id, 'confirmed',
          `Wick rejection at ${levelPrice.toFixed(2)} - Entry: ${candle.close} (bar close) - Sweep: ${signal.side === 'buy' ? candle.low.toFixed(2) : candle.high.toFixed(2)}`);

        return this.generateConfirmationSignal(monitoredLevel, candle, {
          isConfirmed: true,
          type: 'wick_rejection',
          entryPrice: candle.close, // Limit order placed at close of confirming bar
          stopLoss: this.calculateDynamicStopLoss(monitoredLevel, signal.side),
          confirmationStrength: this.calculateConfirmationStrength(monitoredLevel, candle),
          testedLevel: levelPrice
        });
      }

      // Pattern 2: Track level loss and recovery
      this.trackLevelStatus(monitoredLevel, candle, levelPrice, signal.side);
    }

    // Check for level recovery confirmation
    if (monitoredLevel.levelLost && !monitoredLevel.confirmed) {
      const recovery = this.checkLevelRecovery(monitoredLevel, candle, signal.side);
      if (recovery) {
        monitoredLevel.confirmed = true;
        monitoredLevel.confirmationTime = candle.timestamp;
        monitoredLevel.confirmationCandle = candle;
        monitoredLevel.status = 'confirmed';
        monitoredLevel.confirmationType = 'level_recovery';

        const sweepInfo = signal.side === 'buy' ?
          ` - Test Low: ${monitoredLevel.testLow?.toFixed(2)}` :
          ` - Test High: ${monitoredLevel.testHigh?.toFixed(2)}`;

        this.logLevelEvent(monitoredLevel.id, 'confirmed',
          `Level recovered at ${monitoredLevel.lostLevelPrice.toFixed(2)} - Entry: ${candle.close} (bar close)${sweepInfo}`);

        return this.generateConfirmationSignal(monitoredLevel, candle, {
          isConfirmed: true,
          type: 'level_recovery',
          entryPrice: candle.close, // Limit order placed at close of confirming bar
          stopLoss: this.calculateDynamicStopLoss(monitoredLevel, signal.side),
          confirmationStrength: this.calculateConfirmationStrength(monitoredLevel, candle),
          testedLevel: monitoredLevel.lostLevelPrice
        });
      }
    }

    return null;
  }

  /**
   * Check for wick rejection pattern (sweep and recovery in same candle)
   */
  checkWickRejection(candle, levelPrice, side) {
    if (side === 'buy') {
      // For longs: wick below level but close above
      const wickedBelow = candle.low < levelPrice;
      const closedAbove = candle.close > levelPrice;
      const isGreenCandle = candle.close > candle.open;

      // Strong rejection: wicked below, closed above, and green candle
      if (wickedBelow && closedAbove && isGreenCandle) {
        // Additional filter: wick should be meaningful (not just 1-2 points)
        const wickSize = levelPrice - candle.low;
        if (wickSize >= 3) {
          return true;
        }
      }
    } else {
      // For shorts: wick above level but close below
      const wickedAbove = candle.high > levelPrice;
      const closedBelow = candle.close < levelPrice;
      const isRedCandle = candle.close < candle.open;

      if (wickedAbove && closedBelow && isRedCandle) {
        const wickSize = candle.high - levelPrice;
        if (wickSize >= 3) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Track if a level has been lost (closed below for support, above for resistance)
   */
  trackLevelStatus(monitoredLevel, candle, levelPrice, side) {
    if (!monitoredLevel.levelStatuses) {
      monitoredLevel.levelStatuses = new Map();
    }

    const levelKey = levelPrice.toFixed(2);
    const status = monitoredLevel.levelStatuses.get(levelKey) || { lost: false };

    if (side === 'buy') {
      // Track support level
      if (!status.lost && candle.close < levelPrice) {
        // Level lost - start tracking breakdown sequence
        status.lost = true;
        status.lostTime = candle.timestamp;
        status.lostCandle = candle;
        monitoredLevel.levelLost = true;
        monitoredLevel.lostLevelPrice = levelPrice;
        monitoredLevel.lastTestCandle = candle;  // Track the candle that tested the level
        // testLow is already being tracked at the start of processLevelCandle

        // Record when level was first tested (breached)
        if (!monitoredLevel.testTime) {
          monitoredLevel.testTime = candle.timestamp;
        }

        // Start recovery timeout tracking
        if (!monitoredLevel.recoveryStartTime) {
          monitoredLevel.recoveryStartTime = candle.timestamp;
        }

        this.logLevelEvent(monitoredLevel.id, 'level_lost',
          `Support at ${levelPrice.toFixed(2)} lost - Close: ${candle.close} - Low: ${candle.low.toFixed(2)}`);
      }
    } else {
      // Track resistance level
      if (!status.lost && candle.close > levelPrice) {
        // Level lost - start tracking breakdown sequence
        status.lost = true;
        status.lostTime = candle.timestamp;
        status.lostCandle = candle;
        monitoredLevel.levelLost = true;
        monitoredLevel.lostLevelPrice = levelPrice;
        monitoredLevel.lastTestCandle = candle;  // Track the candle that tested the level
        // testHigh is already being tracked at the start of processLevelCandle

        // Record when level was first tested (breached)
        if (!monitoredLevel.testTime) {
          monitoredLevel.testTime = candle.timestamp;
        }

        // Start recovery timeout tracking
        if (!monitoredLevel.recoveryStartTime) {
          monitoredLevel.recoveryStartTime = candle.timestamp;
        }

        this.logLevelEvent(monitoredLevel.id, 'level_lost',
          `Resistance at ${levelPrice.toFixed(2)} lost - Close: ${candle.close} - High: ${candle.high.toFixed(2)}`);
      }
    }

    monitoredLevel.levelStatuses.set(levelKey, status);
  }

  /**
   * Check if a lost level has been recovered
   */
  checkLevelRecovery(monitoredLevel, candle, side) {
    if (!monitoredLevel.levelLost || !monitoredLevel.lostLevelPrice) {
      return false;
    }

    // Check if recovery period has expired
    if (monitoredLevel.recoveryStartTime && !monitoredLevel.recoveryExpired) {
      const recoveryDuration = candle.timestamp - monitoredLevel.recoveryStartTime;
      const maxRecoveryTime = this.options.maxRecoveryBars * this.options.candleIntervalMs;

      if (recoveryDuration > maxRecoveryTime) {
        monitoredLevel.recoveryExpired = true;
        this.logLevelEvent(monitoredLevel.id, 'recovery_expired',
          `Recovery period expired after ${this.options.maxRecoveryBars} bars (${recoveryDuration / 60000} min)`);
        return false;
      }
    }

    // Return false if recovery has already expired
    if (monitoredLevel.recoveryExpired) {
      return false;
    }

    const levelPrice = monitoredLevel.lostLevelPrice;

    if (side === 'buy') {
      // For longs: level recovered if we close back above
      if (candle.close > levelPrice && candle.open < candle.close) {
        // Extremes are already being tracked in processLevelCandle
        return true;
      }
    } else {
      // For shorts: level recovered if we close back below
      if (candle.close < levelPrice && candle.open > candle.close) {
        // Extremes are already being tracked in processLevelCandle
        return true;
      }
    }

    return false;
  }


  /**
   * Calculate dynamic stop loss based on structural sweep extremes
   */
  calculateDynamicStopLoss(monitoredLevel, side) {
    // Check which stop mode to use
    if (this.options.useStructuralStops) {
      // STRUCTURAL STOPS: Use actual test candle extremes, not monitoring period extremes
      const buffer = this.options.stopBuffer || 3;

      if (side === 'buy') {
        // Use the low of the actual test candle, not the absolute monitoring low
        const testLow = monitoredLevel.lastTestCandle ? monitoredLevel.lastTestCandle.low : monitoredLevel.testLow;
        const stopPrice = testLow - buffer;
        // console.log(`📐 [Structural] Buy stop: Test Candle Low ${testLow.toFixed(2)} - ${buffer} = ${stopPrice.toFixed(2)}`);
        return stopPrice;
      } else {
        // Use the high of the actual test candle, not the absolute monitoring high
        const testHigh = monitoredLevel.lastTestCandle ? monitoredLevel.lastTestCandle.high : monitoredLevel.testHigh;
        const stopPrice = testHigh + buffer;
        // console.log(`📐 [Structural] Sell stop: Test Candle High ${testHigh.toFixed(2)} + ${buffer} = ${stopPrice.toFixed(2)}`);
        return stopPrice;
      }
    } else {
      // FIXED STOPS: Use entry price ± fixed points
      const stopDistance = this.options.stopLossPoints || 40;
      const entryPrice = monitoredLevel.confirmationCandle.close;

      if (side === 'buy') {
        const stopPrice = entryPrice - stopDistance;
        // console.log(`📐 [Fixed] Buy stop: Entry ${entryPrice.toFixed(2)} - ${stopDistance} = ${stopPrice.toFixed(2)}`);
        return stopPrice;
      } else {
        const stopPrice = entryPrice + stopDistance;
        // console.log(`📐 [Fixed] Sell stop: Entry ${entryPrice.toFixed(2)} + ${stopDistance} = ${stopPrice.toFixed(2)}`);
        return stopPrice;
      }
    }
  }

  /**
   * Calculate confirmation strength based on multiple factors
   */
  calculateConfirmationStrength(monitoredLevel, confirmationCandle) {
    let strength = 50; // Base strength

    // Confluence zone quality
    strength += (monitoredLevel.levelData.score || 1) * 5;

    // Time factor - quicker confirmation after test is stronger
    const testToConfirmTime = confirmationCandle.timestamp - monitoredLevel.testTime;
    const timeBonus = Math.max(0, (this.options.minHoldTime - testToConfirmTime) / 60000); // Minutes
    strength += timeBonus * 2;

    // Test depth - shallow tests are stronger
    const testDepth = monitoredLevel.closestApproach;
    const depthBonus = Math.max(0, (this.options.testThreshold - testDepth) * 3);
    strength += depthBonus;

    // Candle strength - larger confirmation candles are stronger
    const candleSize = Math.abs(confirmationCandle.close - confirmationCandle.open);
    strength += Math.min(20, candleSize * 0.5);

    return Math.min(100, strength);
  }

  /**
   * Generate confirmation signal for strategy consumption
   */
  generateConfirmationSignal(monitoredLevel, candle, confirmationResult) {
    const signal = {
      type: 'confirmation',
      timestamp: candle.timestamp,
      levelId: monitoredLevel.id,
      originalSignal: monitoredLevel.originalSignal,

      // Entry details
      side: monitoredLevel.originalSignal.side,
      entryPrice: confirmationResult.entryPrice,
      stopLoss: confirmationResult.stopLoss,

      // Risk management
      riskPoints: Math.abs(confirmationResult.entryPrice - confirmationResult.stopLoss),

      // Level details (clean structure)
      testedLevel: confirmationResult.testedLevel,
      levelSource: monitoredLevel.levelData?.levels?.[0]?.source || 'unknown',
      levelDescription: monitoredLevel.levelData?.levels?.[0]?.description || 'Level',

      // Confirmation details
      confirmationType: confirmationResult.type,
      confirmationStrength: confirmationResult.confirmationStrength,

      // Level test details
      testLow: monitoredLevel.testLow,
      testHigh: monitoredLevel.testHigh,
      testTime: monitoredLevel.testTime || monitoredLevel.confirmationTime,
      holdTime: 0, // Immediate confirmation on wick/recovery

      // Complete timing chain for trade reconstruction
      originalSignalTime: monitoredLevel.originalSignalTime,
      monitoringStartTime: monitoredLevel.monitoringStartTime,

      // Metadata
      confirmationCandle: {
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume
      }
    };

    // Validate risk/reward before sending signal
    let maxAcceptableRisk = this.options.maxAcceptableRisk || 50; // points

    // For structural stops, allow higher risk since stops are calculated from actual market extremes
    if (this.options.useStructuralStops) {
      // Structural stops can be wider, so increase acceptable risk by 50%
      maxAcceptableRisk = Math.max(maxAcceptableRisk, maxAcceptableRisk * 1.5);
      // But also enforce an absolute maximum to prevent runaway risk
      maxAcceptableRisk = Math.min(maxAcceptableRisk, 150); // Never exceed 150 points
    }

    if (signal.riskPoints <= maxAcceptableRisk) {
      this.confirmationSignals.push(signal);
      return signal;
    } else {
      this.logLevelEvent(monitoredLevel.id, 'risk_too_high',
        `Signal rejected - risk ${signal.riskPoints.toFixed(2)} exceeds max ${maxAcceptableRisk} (structural: ${this.options.useStructuralStops})`);
      this.expireLevel(monitoredLevel.id, 'risk_too_high');
      return null;
    }
  }

  /**
   * Expire a monitored level
   */
  expireLevel(levelId, reason = 'timeout') {
    const monitoredLevel = this.monitoredLevels.get(levelId);
    if (monitoredLevel) {
      monitoredLevel.status = 'expired';
      this.logLevelEvent(levelId, 'expired', `Level monitoring expired: ${reason}`);
    }
  }

  /**
   * Log level event for debugging and analysis
   */
  logLevelEvent(levelId, eventType, description) {
    const event = {
      timestamp: Date.now(),
      levelId: levelId,
      eventType: eventType,
      description: description
    };

    this.levelEvents.push(event);

    // Keep only recent events (last 1000)
    if (this.levelEvents.length > 1000) {
      this.levelEvents = this.levelEvents.slice(-1000);
    }
  }

  /**
   * Get status of all monitored levels
   */
  getMonitoredLevelsStatus() {
    const status = {
      totalLevels: this.monitoredLevels.size,
      statusBreakdown: {},
      activeLevels: [],
      recentEvents: this.levelEvents.slice(-20)
    };

    this.monitoredLevels.forEach((level, id) => {
      status.statusBreakdown[level.status] = (status.statusBreakdown[level.status] || 0) + 1;

      if (level.status === 'monitoring' || level.status === 'confirmed') {
        status.activeLevels.push({
          id: id,
          monitoredPrice: (level.levelData.price || level.levelData.centerPrice).toFixed(2),
          status: level.status,
          approached: level.approached,
          tested: level.tested,
          holding: level.holding,
          elapsed: ((Date.now() - level.startTime) / 60000).toFixed(1) + ' min'
        });
      }
    });

    return status;
  }

  /**
   * Clean up expired levels
   */
  cleanup() {
    const expiredIds = [];
    this.monitoredLevels.forEach((level, id) => {
      if (level.status === 'expired') {
        expiredIds.push(id);
      }
    });

    expiredIds.forEach(id => this.monitoredLevels.delete(id));

    return expiredIds.length;
  }
}