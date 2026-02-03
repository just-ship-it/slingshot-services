/**
 * Liquidity Sweep Outcome Analyzer
 *
 * Analyzes the outcome of detected liquidity sweeps by tracking:
 * - Target hits (5, 10, 20, 50 points)
 * - Maximum Adverse Excursion (MAE)
 * - Maximum Favorable Excursion (MFE)
 * - Time to target
 * - Final P&L at various time windows
 */

/**
 * Session classifier for market hours
 */
function getSession(timestamp) {
  const date = new Date(timestamp);
  const hour = date.getUTCHours();
  const minute = date.getUTCMinutes();
  const timeInMinutes = hour * 60 + minute;

  // Convert UTC to EST (UTC-5, or UTC-4 during DST)
  // Approximate: check if in DST range (Mar-Nov)
  const month = date.getUTCMonth();
  const isDST = month >= 2 && month <= 10; // March through October
  const estOffset = isDST ? 4 : 5;
  const estHour = (hour - estOffset + 24) % 24;
  const estTimeInMinutes = estHour * 60 + minute;

  // Session times in EST minutes from midnight
  const sessions = {
    overnight: { start: 18 * 60, end: 8 * 60 },     // 6:00 PM - 8:00 AM
    premarket: { start: 8 * 60, end: 9 * 60 + 30 }, // 8:00 AM - 9:30 AM
    rth: { start: 9 * 60 + 30, end: 16 * 60 },      // 9:30 AM - 4:00 PM
    afterhours: { start: 16 * 60, end: 18 * 60 }    // 4:00 PM - 6:00 PM
  };

  if (estTimeInMinutes >= sessions.rth.start && estTimeInMinutes < sessions.rth.end) {
    return 'rth';
  } else if (estTimeInMinutes >= sessions.premarket.start && estTimeInMinutes < sessions.premarket.end) {
    return 'premarket';
  } else if (estTimeInMinutes >= sessions.afterhours.start && estTimeInMinutes < sessions.afterhours.end) {
    return 'afterhours';
  } else {
    return 'overnight';
  }
}

/**
 * Day of week classifier
 */
function getDayOfWeek(timestamp) {
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  return days[new Date(timestamp).getUTCDay()];
}

export class LiquiditySweepAnalyzer {
  /**
   * Create a new analyzer with configurable parameters
   *
   * @param {Object} config - Configuration options
   * @param {number[]} config.targets - Target points to track (default: [5, 10, 20, 50])
   * @param {number[]} config.timeWindows - Time windows in minutes (default: [15, 30, 60, 120])
   */
  constructor(config = {}) {
    this.targets = config.targets ?? [5, 10, 20, 50];
    this.timeWindows = config.timeWindows ?? [15, 30, 60, 120];
  }

  /**
   * Analyze outcome for a single sweep given subsequent candles
   *
   * @param {Object} sweep - Detected sweep object from LiquiditySweepDetector
   * @param {Object[]} subsequentCandles - Array of candles after the sweep
   * @returns {Object} Outcome analysis
   */
  analyzeOutcome(sweep, subsequentCandles) {
    const entryPrice = sweep.entryPrice;
    const entryTime = sweep.timestamp;
    const direction = sweep.type === 'bullish' ? 1 : -1; // 1 = long, -1 = short

    // Initialize outcome tracking
    const outcomes = {};
    for (const windowMinutes of this.timeWindows) {
      outcomes[`${windowMinutes}min`] = {
        windowMinutes,
        mae: 0,           // Maximum adverse excursion (worst drawdown)
        mfe: 0,           // Maximum favorable excursion (best unrealized profit)
        finalPnL: 0,      // P&L at end of window
        targetHits: {},   // { 5: { hit: true, time: ms, candleIndex: n }, ... }
        endPrice: null
      };

      for (const target of this.targets) {
        outcomes[`${windowMinutes}min`].targetHits[target] = {
          hit: false,
          timeToHit: null,
          candleIndex: null
        };
      }
    }

    // Process subsequent candles
    let overallMAE = 0;
    let overallMFE = 0;

    for (let i = 0; i < subsequentCandles.length; i++) {
      const candle = subsequentCandles[i];
      const candleTime = candle.timestamp;
      const elapsedMs = candleTime - entryTime;
      const elapsedMinutes = elapsedMs / (1000 * 60);

      // Calculate P&L for this candle (high/low/close)
      const highPnL = (candle.high - entryPrice) * direction;
      const lowPnL = (candle.low - entryPrice) * direction;
      const closePnL = (candle.close - entryPrice) * direction;

      // Update MAE/MFE
      const candleMAE = Math.min(highPnL, lowPnL);
      const candleMFE = Math.max(highPnL, lowPnL);

      if (candleMAE < overallMAE) overallMAE = candleMAE;
      if (candleMFE > overallMFE) overallMFE = candleMFE;

      // Process each time window
      for (const windowMinutes of this.timeWindows) {
        const windowKey = `${windowMinutes}min`;
        const outcome = outcomes[windowKey];

        // Skip if beyond this window
        if (elapsedMinutes > windowMinutes) continue;

        // Update MAE/MFE for this window
        if (candleMAE < outcome.mae) outcome.mae = candleMAE;
        if (candleMFE > outcome.mfe) outcome.mfe = candleMFE;

        // Update final values for this window
        outcome.finalPnL = closePnL;
        outcome.endPrice = candle.close;

        // Check target hits
        for (const target of this.targets) {
          if (!outcome.targetHits[target].hit && candleMFE >= target) {
            outcome.targetHits[target] = {
              hit: true,
              timeToHit: elapsedMs,
              timeToHitFormatted: this.formatDuration(elapsedMs),
              candleIndex: i
            };
          }
        }
      }

      // Early exit if we've passed all time windows
      const maxWindow = Math.max(...this.timeWindows);
      if (elapsedMinutes > maxWindow) break;
    }

    // Round values for cleaner output
    for (const windowKey of Object.keys(outcomes)) {
      const outcome = outcomes[windowKey];
      outcome.mae = Math.round(outcome.mae * 100) / 100;
      outcome.mfe = Math.round(outcome.mfe * 100) / 100;
      outcome.finalPnL = Math.round(outcome.finalPnL * 100) / 100;
    }

    return {
      timestamp: new Date(sweep.timestamp).toISOString(),
      type: sweep.type,
      symbol: sweep.symbol,
      entryPrice: sweep.entryPrice,
      direction: sweep.type === 'bullish' ? 'LONG' : 'SHORT',
      session: getSession(sweep.timestamp),
      dayOfWeek: getDayOfWeek(sweep.timestamp),
      confidence: sweep.confidence,
      metrics: sweep.metrics,
      outcomes,
      summary: {
        overallMAE: Math.round(overallMAE * 100) / 100,
        overallMFE: Math.round(overallMFE * 100) / 100
      }
    };
  }

  /**
   * Compute aggregate statistics from multiple sweep outcomes
   *
   * @param {Object[]} sweepOutcomes - Array of analyzed sweep outcomes
   * @returns {Object} Aggregate statistics
   */
  computeStatistics(sweepOutcomes) {
    if (sweepOutcomes.length === 0) {
      return this.getEmptyStatistics();
    }

    const stats = {
      totalSweeps: sweepOutcomes.length,
      bullishSweeps: sweepOutcomes.filter(s => s.type === 'bullish').length,
      bearishSweeps: sweepOutcomes.filter(s => s.type === 'bearish').length,
      byTarget: {},
      byTimeWindow: {},
      bySession: {},
      byDayOfWeek: {},
      byType: {
        bullish: { count: 0, avgMAE: 0, avgMFE: 0, avgPnL: 0 },
        bearish: { count: 0, avgMAE: 0, avgMFE: 0, avgPnL: 0 }
      }
    };

    // Initialize aggregators
    for (const target of this.targets) {
      stats.byTarget[`${target}pt`] = {
        target,
        totalHits: 0,
        winRate: 0,
        avgTimeToTarget: 0,
        avgMAEBeforeHit: 0,
        totalTimes: [],
        totalMAEs: []
      };
    }

    for (const window of this.timeWindows) {
      stats.byTimeWindow[`${window}min`] = {
        windowMinutes: window,
        avgPnL: 0,
        winRate: 0,
        avgMAE: 0,
        avgMFE: 0,
        wins: 0,
        losses: 0,
        pnls: [],
        maes: [],
        mfes: []
      };
    }

    const sessions = ['overnight', 'premarket', 'rth', 'afterhours'];
    for (const session of sessions) {
      stats.bySession[session] = {
        count: 0,
        avgPnL: 0,
        winRate: 0,
        avgMAE: 0,
        pnls: [],
        maes: []
      };
    }

    const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    for (const day of days) {
      stats.byDayOfWeek[day] = {
        count: 0,
        avgPnL: 0,
        winRate: 0,
        pnls: []
      };
    }

    // Process each outcome
    for (const outcome of sweepOutcomes) {
      // By type
      const typeStats = stats.byType[outcome.type];
      typeStats.count++;

      // Use 30min window as reference for type stats
      const refWindow = outcome.outcomes['30min'] || outcome.outcomes[Object.keys(outcome.outcomes)[0]];
      if (refWindow) {
        typeStats.avgMAE += refWindow.mae;
        typeStats.avgMFE += refWindow.mfe;
        typeStats.avgPnL += refWindow.finalPnL;
      }

      // By target
      for (const target of this.targets) {
        const targetKey = `${target}pt`;
        // Check all time windows for target hits
        for (const windowKey of Object.keys(outcome.outcomes)) {
          const windowOutcome = outcome.outcomes[windowKey];
          const targetHit = windowOutcome.targetHits[target];
          if (targetHit && targetHit.hit) {
            stats.byTarget[targetKey].totalHits++;
            stats.byTarget[targetKey].totalTimes.push(targetHit.timeToHit);
            stats.byTarget[targetKey].totalMAEs.push(windowOutcome.mae);
            break; // Count once per sweep
          }
        }
      }

      // By time window
      for (const windowKey of Object.keys(outcome.outcomes)) {
        const windowOutcome = outcome.outcomes[windowKey];
        const windowStats = stats.byTimeWindow[windowKey];

        if (windowStats) {
          windowStats.pnls.push(windowOutcome.finalPnL);
          windowStats.maes.push(windowOutcome.mae);
          windowStats.mfes.push(windowOutcome.mfe);
          if (windowOutcome.finalPnL > 0) {
            windowStats.wins++;
          } else {
            windowStats.losses++;
          }
        }
      }

      // By session
      const sessionStats = stats.bySession[outcome.session];
      if (sessionStats) {
        sessionStats.count++;
        const refPnL = refWindow ? refWindow.finalPnL : 0;
        const refMAE = refWindow ? refWindow.mae : 0;
        sessionStats.pnls.push(refPnL);
        sessionStats.maes.push(refMAE);
      }

      // By day of week
      const dayStats = stats.byDayOfWeek[outcome.dayOfWeek];
      if (dayStats) {
        dayStats.count++;
        const refPnL = refWindow ? refWindow.finalPnL : 0;
        dayStats.pnls.push(refPnL);
      }
    }

    // Compute averages for types
    for (const type of ['bullish', 'bearish']) {
      const typeStats = stats.byType[type];
      if (typeStats.count > 0) {
        typeStats.avgMAE = Math.round((typeStats.avgMAE / typeStats.count) * 100) / 100;
        typeStats.avgMFE = Math.round((typeStats.avgMFE / typeStats.count) * 100) / 100;
        typeStats.avgPnL = Math.round((typeStats.avgPnL / typeStats.count) * 100) / 100;
      }
    }

    // Compute averages for targets
    for (const target of this.targets) {
      const targetKey = `${target}pt`;
      const targetStats = stats.byTarget[targetKey];
      targetStats.winRate = Math.round((targetStats.totalHits / sweepOutcomes.length) * 100 * 100) / 100;

      if (targetStats.totalTimes.length > 0) {
        const avgTime = targetStats.totalTimes.reduce((a, b) => a + b, 0) / targetStats.totalTimes.length;
        targetStats.avgTimeToTarget = this.formatDuration(avgTime);
        targetStats.avgMAEBeforeHit = Math.round(
          (targetStats.totalMAEs.reduce((a, b) => a + b, 0) / targetStats.totalMAEs.length) * 100
        ) / 100;
      }

      // Clean up temp arrays
      delete targetStats.totalTimes;
      delete targetStats.totalMAEs;
    }

    // Compute averages for time windows
    for (const window of this.timeWindows) {
      const windowKey = `${window}min`;
      const windowStats = stats.byTimeWindow[windowKey];

      if (windowStats.pnls.length > 0) {
        windowStats.avgPnL = Math.round(
          (windowStats.pnls.reduce((a, b) => a + b, 0) / windowStats.pnls.length) * 100
        ) / 100;
        windowStats.avgMAE = Math.round(
          (windowStats.maes.reduce((a, b) => a + b, 0) / windowStats.maes.length) * 100
        ) / 100;
        windowStats.avgMFE = Math.round(
          (windowStats.mfes.reduce((a, b) => a + b, 0) / windowStats.mfes.length) * 100
        ) / 100;
        windowStats.winRate = Math.round((windowStats.wins / windowStats.pnls.length) * 100 * 100) / 100;
      }

      // Clean up temp arrays
      delete windowStats.pnls;
      delete windowStats.maes;
      delete windowStats.mfes;
    }

    // Compute averages for sessions
    for (const session of sessions) {
      const sessionStats = stats.bySession[session];
      if (sessionStats.pnls.length > 0) {
        sessionStats.avgPnL = Math.round(
          (sessionStats.pnls.reduce((a, b) => a + b, 0) / sessionStats.pnls.length) * 100
        ) / 100;
        sessionStats.avgMAE = Math.round(
          (sessionStats.maes.reduce((a, b) => a + b, 0) / sessionStats.maes.length) * 100
        ) / 100;
        const wins = sessionStats.pnls.filter(p => p > 0).length;
        sessionStats.winRate = Math.round((wins / sessionStats.pnls.length) * 100 * 100) / 100;
      }
      delete sessionStats.pnls;
      delete sessionStats.maes;
    }

    // Compute averages for days
    for (const day of days) {
      const dayStats = stats.byDayOfWeek[day];
      if (dayStats.pnls.length > 0) {
        dayStats.avgPnL = Math.round(
          (dayStats.pnls.reduce((a, b) => a + b, 0) / dayStats.pnls.length) * 100
        ) / 100;
        const wins = dayStats.pnls.filter(p => p > 0).length;
        dayStats.winRate = Math.round((wins / dayStats.pnls.length) * 100 * 100) / 100;
      }
      delete dayStats.pnls;
    }

    return stats;
  }

  /**
   * Format duration in milliseconds to human readable string
   * @param {number} ms - Duration in milliseconds
   * @returns {string} Formatted duration
   */
  formatDuration(ms) {
    if (ms < 1000) return `${ms}ms`;

    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }

  /**
   * Get empty statistics object
   * @returns {Object} Empty statistics structure
   */
  getEmptyStatistics() {
    const stats = {
      totalSweeps: 0,
      bullishSweeps: 0,
      bearishSweeps: 0,
      byTarget: {},
      byTimeWindow: {},
      bySession: {},
      byDayOfWeek: {},
      byType: {
        bullish: { count: 0, avgMAE: 0, avgMFE: 0, avgPnL: 0 },
        bearish: { count: 0, avgMAE: 0, avgMFE: 0, avgPnL: 0 }
      }
    };

    for (const target of this.targets) {
      stats.byTarget[`${target}pt`] = {
        target,
        totalHits: 0,
        winRate: 0,
        avgTimeToTarget: '0s',
        avgMAEBeforeHit: 0
      };
    }

    for (const window of this.timeWindows) {
      stats.byTimeWindow[`${window}min`] = {
        windowMinutes: window,
        avgPnL: 0,
        winRate: 0,
        avgMAE: 0,
        avgMFE: 0,
        wins: 0,
        losses: 0
      };
    }

    return stats;
  }

  /**
   * Get configuration
   * @returns {Object} Current configuration
   */
  getConfig() {
    return {
      targets: [...this.targets],
      timeWindows: [...this.timeWindows]
    };
  }
}
