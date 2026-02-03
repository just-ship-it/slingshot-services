/**
 * Sweep Labeler
 *
 * Labels historical sweeps as success or failure based on outcome criteria:
 * - NQ: Success = price moves 10+ points in reversal direction before 5 points against
 * - ES: Success = price moves 5+ points in reversal direction before 3 points against
 *
 * This provides the ground truth for measuring sweep detection accuracy.
 */

/**
 * Default labeling criteria for different instruments
 */
const LABELING_CRITERIA = {
  NQ: {
    targetPoints: 10,     // Points to consider success
    stopPoints: 5,        // Points against to consider failure
    maxLookforwardBars: 60, // Max bars to look forward (1 hour at 1m)
    minRR: 2.0            // Minimum R:R ratio
  },
  ES: {
    targetPoints: 5,
    stopPoints: 3,
    maxLookforwardBars: 60,
    minRR: 1.67
  },
  MNQ: {
    targetPoints: 10,
    stopPoints: 5,
    maxLookforwardBars: 60,
    minRR: 2.0
  },
  MES: {
    targetPoints: 5,
    stopPoints: 3,
    maxLookforwardBars: 60,
    minRR: 1.67
  }
};

/**
 * Outcome labels
 */
export const OUTCOME_LABELS = {
  SUCCESS: 'success',    // Hit target before stop
  FAILURE: 'failure',    // Hit stop before target
  TIMEOUT: 'timeout',    // Neither hit within lookforward window
  PARTIAL: 'partial'     // Made positive progress but didn't hit full target
};

export class SweepLabeler {
  /**
   * @param {Object} config - Configuration
   * @param {string} config.instrument - Instrument type ('NQ', 'ES', etc.)
   * @param {number} config.targetPoints - Override target points
   * @param {number} config.stopPoints - Override stop points
   * @param {number} config.maxLookforwardBars - Override lookforward window
   */
  constructor(config = {}) {
    const instrument = config.instrument || 'NQ';
    const criteria = LABELING_CRITERIA[instrument] || LABELING_CRITERIA.NQ;

    this.config = {
      instrument,
      targetPoints: config.targetPoints ?? criteria.targetPoints,
      stopPoints: config.stopPoints ?? criteria.stopPoints,
      maxLookforwardBars: config.maxLookforwardBars ?? criteria.maxLookforwardBars,
      minRR: config.minRR ?? criteria.minRR
    };

    // Statistics
    this.stats = {
      sweepsLabeled: 0,
      successes: 0,
      failures: 0,
      timeouts: 0,
      partials: 0,
      avgMAE: 0,
      avgMFE: 0,
      avgTimeToOutcome: 0,
      totalMAE: 0,
      totalMFE: 0,
      totalTimeToOutcome: 0
    };
  }

  /**
   * Label a single sweep based on subsequent price action
   * @param {Object} sweep - Sweep detection result
   * @param {Object[]} subsequentCandles - Candles after the sweep
   * @returns {Object} Labeled sweep with outcome details
   */
  label(sweep, subsequentCandles) {
    this.stats.sweepsLabeled++;

    const entryPrice = sweep.entry;
    const direction = sweep.direction; // 'LONG' or 'SHORT'
    const sweepTime = sweep.timestamp;

    // Calculate target and stop levels
    const targetLevel = direction === 'LONG'
      ? entryPrice + this.config.targetPoints
      : entryPrice - this.config.targetPoints;

    const stopLevel = direction === 'LONG'
      ? entryPrice - this.config.stopPoints
      : entryPrice + this.config.stopPoints;

    // Track outcome
    let outcome = OUTCOME_LABELS.TIMEOUT;
    let outcomeTime = null;
    let outcomeBar = null;
    let outcomePrice = null;

    // Track MAE/MFE
    let mae = 0;  // Maximum Adverse Excursion
    let mfe = 0;  // Maximum Favorable Excursion
    let bestPnL = 0;
    let worstPnL = 0;

    // Process subsequent candles
    const maxBars = Math.min(subsequentCandles.length, this.config.maxLookforwardBars);

    for (let i = 0; i < maxBars; i++) {
      const candle = subsequentCandles[i];

      // Calculate P&L at this candle
      let highPnL, lowPnL;
      if (direction === 'LONG') {
        highPnL = candle.high - entryPrice;
        lowPnL = candle.low - entryPrice;
      } else {
        highPnL = entryPrice - candle.low;  // Short: profit when price falls
        lowPnL = entryPrice - candle.high;  // Loss when price rises
      }

      // Update MAE/MFE
      if (lowPnL < worstPnL) {
        worstPnL = lowPnL;
        mae = Math.abs(worstPnL);
      }
      if (highPnL > bestPnL) {
        bestPnL = highPnL;
        mfe = bestPnL;
      }

      // Check for stop hit (failure)
      if (direction === 'LONG' && candle.low <= stopLevel) {
        outcome = OUTCOME_LABELS.FAILURE;
        outcomeTime = candle.timestamp;
        outcomeBar = i;
        outcomePrice = stopLevel;
        break;
      }
      if (direction === 'SHORT' && candle.high >= stopLevel) {
        outcome = OUTCOME_LABELS.FAILURE;
        outcomeTime = candle.timestamp;
        outcomeBar = i;
        outcomePrice = stopLevel;
        break;
      }

      // Check for target hit (success)
      if (direction === 'LONG' && candle.high >= targetLevel) {
        outcome = OUTCOME_LABELS.SUCCESS;
        outcomeTime = candle.timestamp;
        outcomeBar = i;
        outcomePrice = targetLevel;
        break;
      }
      if (direction === 'SHORT' && candle.low <= targetLevel) {
        outcome = OUTCOME_LABELS.SUCCESS;
        outcomeTime = candle.timestamp;
        outcomeBar = i;
        outcomePrice = targetLevel;
        break;
      }
    }

    // Check for partial success (made progress but didn't hit target)
    if (outcome === OUTCOME_LABELS.TIMEOUT && mfe >= this.config.targetPoints * 0.5) {
      outcome = OUTCOME_LABELS.PARTIAL;
    }

    // Calculate realized P&L based on outcome
    let realizedPnL;
    if (outcome === OUTCOME_LABELS.SUCCESS) {
      realizedPnL = this.config.targetPoints;
    } else if (outcome === OUTCOME_LABELS.FAILURE) {
      realizedPnL = -this.config.stopPoints;
    } else {
      // Timeout/partial - use final candle close
      const lastCandle = subsequentCandles[maxBars - 1];
      if (lastCandle) {
        realizedPnL = direction === 'LONG'
          ? lastCandle.close - entryPrice
          : entryPrice - lastCandle.close;
      } else {
        realizedPnL = 0;
      }
    }

    // Calculate time to outcome
    const timeToOutcome = outcomeTime ? (outcomeTime - sweepTime) / 1000 : null;

    // Update statistics
    if (outcome === OUTCOME_LABELS.SUCCESS) this.stats.successes++;
    if (outcome === OUTCOME_LABELS.FAILURE) this.stats.failures++;
    if (outcome === OUTCOME_LABELS.TIMEOUT) this.stats.timeouts++;
    if (outcome === OUTCOME_LABELS.PARTIAL) this.stats.partials++;

    this.stats.totalMAE += mae;
    this.stats.totalMFE += mfe;
    this.stats.avgMAE = this.stats.totalMAE / this.stats.sweepsLabeled;
    this.stats.avgMFE = this.stats.totalMFE / this.stats.sweepsLabeled;

    if (timeToOutcome !== null) {
      this.stats.totalTimeToOutcome += timeToOutcome;
      this.stats.avgTimeToOutcome = this.stats.totalTimeToOutcome /
        (this.stats.successes + this.stats.failures);
    }

    // Build labeled result
    return {
      ...sweep,
      labeling: {
        outcome,
        outcomeTime: outcomeTime ? new Date(outcomeTime).toISOString() : null,
        outcomeBar,
        outcomePrice: outcomePrice ? Math.round(outcomePrice * 100) / 100 : null,
        timeToOutcomeSeconds: timeToOutcome ? Math.round(timeToOutcome) : null,
        targetLevel: Math.round(targetLevel * 100) / 100,
        stopLevel: Math.round(stopLevel * 100) / 100,
        targetPoints: this.config.targetPoints,
        stopPoints: this.config.stopPoints,
        mae: Math.round(mae * 100) / 100,
        mfe: Math.round(mfe * 100) / 100,
        realizedPnL: Math.round(realizedPnL * 100) / 100,
        isSuccess: outcome === OUTCOME_LABELS.SUCCESS,
        isFailure: outcome === OUTCOME_LABELS.FAILURE
      }
    };
  }

  /**
   * Label multiple sweeps
   * Requires candle data indexed by timestamp for efficient lookup
   * @param {Object[]} sweeps - Array of sweep detections
   * @param {Object[]} allCandles - All candles (sorted by timestamp)
   * @returns {Object[]} Array of labeled sweeps
   */
  labelAll(sweeps, allCandles) {
    // Build timestamp index for efficient lookups
    const candleIndex = new Map();
    allCandles.forEach((candle, idx) => {
      candleIndex.set(candle.timestamp, idx);
    });

    const labeledSweeps = [];

    for (const sweep of sweeps) {
      const startIdx = candleIndex.get(sweep.timestamp);

      if (startIdx === undefined) {
        // Try to find nearest timestamp
        let nearestIdx = null;
        let minDiff = Infinity;

        for (let i = 0; i < allCandles.length; i++) {
          const diff = Math.abs(allCandles[i].timestamp - sweep.timestamp);
          if (diff < minDiff) {
            minDiff = diff;
            nearestIdx = i;
          }
        }

        if (nearestIdx === null || minDiff > 60000) {
          // No candle within 1 minute, skip
          continue;
        }

        const subsequentCandles = allCandles.slice(nearestIdx + 1, nearestIdx + 1 + this.config.maxLookforwardBars);
        labeledSweeps.push(this.label(sweep, subsequentCandles));
      } else {
        const subsequentCandles = allCandles.slice(startIdx + 1, startIdx + 1 + this.config.maxLookforwardBars);
        labeledSweeps.push(this.label(sweep, subsequentCandles));
      }
    }

    return labeledSweeps;
  }

  /**
   * Calculate accuracy metrics from labeled sweeps
   * @param {Object[]} labeledSweeps - Array of labeled sweeps
   * @returns {Object} Accuracy metrics
   */
  calculateAccuracy(labeledSweeps) {
    const total = labeledSweeps.length;
    if (total === 0) {
      return { accuracy: 0, total: 0 };
    }

    const successes = labeledSweeps.filter(s => s.labeling.isSuccess).length;
    const failures = labeledSweeps.filter(s => s.labeling.isFailure).length;
    const timeouts = labeledSweeps.filter(s => s.labeling.outcome === OUTCOME_LABELS.TIMEOUT).length;
    const partials = labeledSweeps.filter(s => s.labeling.outcome === OUTCOME_LABELS.PARTIAL).length;

    // Calculate resolved accuracy (success / (success + failure))
    const resolved = successes + failures;
    const resolvedAccuracy = resolved > 0 ? (successes / resolved) * 100 : 0;

    // Calculate overall accuracy (success / total)
    const overallAccuracy = (successes / total) * 100;

    // Calculate expectancy
    const avgWin = this.config.targetPoints;
    const avgLoss = this.config.stopPoints;
    const winRate = resolved > 0 ? successes / resolved : 0;
    const expectancy = (winRate * avgWin) - ((1 - winRate) * avgLoss);

    // Calculate profit factor
    const grossProfit = successes * avgWin;
    const grossLoss = failures * avgLoss;
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

    // Calculate MAE/MFE averages
    const maeValues = labeledSweeps.map(s => s.labeling.mae);
    const mfeValues = labeledSweeps.map(s => s.labeling.mfe);
    const avgMAE = maeValues.reduce((a, b) => a + b, 0) / total;
    const avgMFE = mfeValues.reduce((a, b) => a + b, 0) / total;

    // Calculate time to outcome
    const resolvedTimes = labeledSweeps
      .filter(s => s.labeling.timeToOutcomeSeconds !== null)
      .map(s => s.labeling.timeToOutcomeSeconds);
    const avgTimeToOutcome = resolvedTimes.length > 0
      ? resolvedTimes.reduce((a, b) => a + b, 0) / resolvedTimes.length
      : 0;

    return {
      total,
      successes,
      failures,
      timeouts,
      partials,
      resolved,
      resolvedAccuracy: Math.round(resolvedAccuracy * 100) / 100,
      overallAccuracy: Math.round(overallAccuracy * 100) / 100,
      winRate: Math.round(winRate * 100 * 100) / 100,
      expectancy: Math.round(expectancy * 100) / 100,
      profitFactor: Math.round(profitFactor * 100) / 100,
      avgMAE: Math.round(avgMAE * 100) / 100,
      avgMFE: Math.round(avgMFE * 100) / 100,
      avgTimeToOutcomeSeconds: Math.round(avgTimeToOutcome),
      targetPoints: this.config.targetPoints,
      stopPoints: this.config.stopPoints
    };
  }

  /**
   * Calculate accuracy by tier
   * @param {Object[]} labeledSweeps - Array of labeled sweeps (with scoring)
   * @returns {Object} Accuracy by tier
   */
  calculateAccuracyByTier(labeledSweeps) {
    const tiers = ['A+', 'A', 'B', 'C'];
    const byTier = {};

    for (const tier of tiers) {
      const tierSweeps = labeledSweeps.filter(s => s.scoring?.tier === tier);
      if (tierSweeps.length > 0) {
        byTier[tier] = this.calculateAccuracy(tierSweeps);
      } else {
        byTier[tier] = { total: 0, accuracy: 0 };
      }
    }

    return byTier;
  }

  /**
   * Calculate accuracy by session
   * @param {Object[]} labeledSweeps - Array of labeled sweeps
   * @returns {Object} Accuracy by session
   */
  calculateAccuracyBySession(labeledSweeps) {
    const sessions = ['overnight', 'premarket', 'rth', 'afterhours'];
    const bySession = {};

    for (const session of sessions) {
      const sessionSweeps = labeledSweeps.filter(s => s.session === session);
      if (sessionSweeps.length > 0) {
        bySession[session] = this.calculateAccuracy(sessionSweeps);
      } else {
        bySession[session] = { total: 0, accuracy: 0 };
      }
    }

    return bySession;
  }

  /**
   * Calculate accuracy by sweep type (bullish/bearish)
   * @param {Object[]} labeledSweeps - Array of labeled sweeps
   * @returns {Object} Accuracy by type
   */
  calculateAccuracyByType(labeledSweeps) {
    return {
      bullish: this.calculateAccuracy(labeledSweeps.filter(s => s.type === 'bullish')),
      bearish: this.calculateAccuracy(labeledSweeps.filter(s => s.type === 'bearish'))
    };
  }

  /**
   * Calculate accuracy by level type
   * @param {Object[]} labeledSweeps - Array of labeled sweeps
   * @returns {Object} Accuracy by level type
   */
  calculateAccuracyByLevelType(labeledSweeps) {
    const byLevel = {};

    for (const sweep of labeledSweeps) {
      const levelType = sweep.level?.type || 'no_level';

      if (!byLevel[levelType]) {
        byLevel[levelType] = [];
      }
      byLevel[levelType].push(sweep);
    }

    const result = {};
    for (const [levelType, sweeps] of Object.entries(byLevel)) {
      result[levelType] = this.calculateAccuracy(sweeps);
    }

    return result;
  }

  /**
   * Get statistics
   * @returns {Object} Labeling statistics
   */
  getStats() {
    const total = this.stats.sweepsLabeled;
    return {
      ...this.stats,
      winRate: total > 0 ? Math.round((this.stats.successes / total) * 100 * 100) / 100 : 0,
      resolvedRate: total > 0 ?
        Math.round(((this.stats.successes + this.stats.failures) / total) * 100 * 100) / 100 : 0
    };
  }

  /**
   * Reset statistics
   */
  resetStats() {
    this.stats = {
      sweepsLabeled: 0,
      successes: 0,
      failures: 0,
      timeouts: 0,
      partials: 0,
      avgMAE: 0,
      avgMFE: 0,
      avgTimeToOutcome: 0,
      totalMAE: 0,
      totalMFE: 0,
      totalTimeToOutcome: 0
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
  }
}

export default SweepLabeler;
