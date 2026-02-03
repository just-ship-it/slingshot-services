/**
 * Liquidity Sweep Strategy Simulator
 *
 * Simulates a trading strategy based on liquidity sweep detection:
 *
 * BULLISH sweep (lower wick) -> LONG trade:
 *   - Limit entry at/near the wick low (waiting for retracement)
 *   - Target: X points above original candle close
 *   - Stop: Below wick low (max risk capped)
 *
 * BEARISH sweep (upper wick) -> SHORT trade:
 *   - Limit entry at/near the wick high (waiting for retracement)
 *   - Target: X points below original candle close
 *   - Stop: Above wick high (max risk capped)
 */

export class LiquiditySweepStrategy {
  /**
   * @param {Object} config - Strategy configuration
   * @param {string} config.entryMode - 'wick_extreme' | 'wick_50' | 'offset_from_close'
   * @param {number} config.entryOffset - Points from close (if entryMode is 'offset_from_close')
   * @param {number} config.targetPoints - Points beyond candle close for target
   * @param {number} config.maxRisk - Maximum risk in points (stop distance cap)
   * @param {number} config.stopBuffer - Extra points beyond wick for stop
   * @param {number} config.orderTimeout - Seconds to wait for fill before canceling
   * @param {boolean} config.cancelIfTargetHitFirst - Cancel order if price hits target before fill
   */
  constructor(config = {}) {
    this.entryMode = config.entryMode ?? 'wick_50';
    this.entryOffset = config.entryOffset ?? 10;
    this.targetPoints = config.targetPoints ?? 10;
    this.maxRisk = config.maxRisk ?? 25;
    this.stopBuffer = config.stopBuffer ?? 2;
    this.orderTimeout = config.orderTimeout ?? 180; // 3 minutes default
    this.cancelIfTargetHitFirst = config.cancelIfTargetHitFirst ?? true;
  }

  /**
   * Calculate entry, stop, and target levels for a sweep
   *
   * @param {Object} sweep - Detected sweep from LiquiditySweepDetector
   * @returns {Object} Trade setup with entry, stop, target levels
   */
  calculateSetup(sweep) {
    const { type, entryPrice, metrics } = sweep;
    const { high, low, open, close, upperWick, lowerWick } = metrics;

    let limitEntry, stopLoss, takeProfit, direction;

    if (type === 'bullish') {
      // LONG trade - enter on pullback toward the low
      direction = 'LONG';

      // Calculate entry based on mode
      switch (this.entryMode) {
        case 'wick_extreme':
          limitEntry = low; // At the wick low
          break;
        case 'wick_50':
          // 50% of the lower wick (between low and body low)
          const bodyLow = Math.min(open, close);
          limitEntry = low + (bodyLow - low) * 0.5;
          break;
        case 'offset_from_close':
          limitEntry = close - this.entryOffset;
          break;
        default:
          limitEntry = low + lowerWick * 0.5;
      }

      // Stop below the wick low
      const naturalStop = low - this.stopBuffer;
      const riskFromEntry = limitEntry - naturalStop;

      // Cap risk at maxRisk
      if (riskFromEntry > this.maxRisk) {
        stopLoss = limitEntry - this.maxRisk;
      } else {
        stopLoss = naturalStop;
      }

      // Target is X points above the original close
      takeProfit = close + this.targetPoints;

    } else {
      // SHORT trade - enter on pullback toward the high
      direction = 'SHORT';

      // Calculate entry based on mode
      switch (this.entryMode) {
        case 'wick_extreme':
          limitEntry = high; // At the wick high
          break;
        case 'wick_50':
          // 50% of the upper wick (between high and body high)
          const bodyHigh = Math.max(open, close);
          limitEntry = high - (high - bodyHigh) * 0.5;
          break;
        case 'offset_from_close':
          limitEntry = close + this.entryOffset;
          break;
        default:
          limitEntry = high - upperWick * 0.5;
      }

      // Stop above the wick high
      const naturalStop = high + this.stopBuffer;
      const riskFromEntry = naturalStop - limitEntry;

      // Cap risk at maxRisk
      if (riskFromEntry > this.maxRisk) {
        stopLoss = limitEntry + this.maxRisk;
      } else {
        stopLoss = naturalStop;
      }

      // Target is X points below the original close
      takeProfit = close - this.targetPoints;
    }

    const risk = Math.abs(limitEntry - stopLoss);
    const reward = Math.abs(takeProfit - limitEntry);

    return {
      sweep,
      direction,
      limitEntry: round(limitEntry),
      stopLoss: round(stopLoss),
      takeProfit: round(takeProfit),
      originalClose: close,
      wickExtreme: type === 'bullish' ? low : high,
      risk: round(risk),
      reward: round(reward),
      rrRatio: round(reward / risk)
    };
  }

  /**
   * Simulate trade execution given subsequent candles
   *
   * @param {Object} setup - Trade setup from calculateSetup()
   * @param {Object[]} subsequentCandles - Array of 1s candles after the sweep
   * @returns {Object} Trade result
   */
  simulateTrade(setup, subsequentCandles) {
    const {
      direction,
      limitEntry,
      stopLoss,
      takeProfit,
      originalClose,
      sweep
    } = setup;

    const sweepTime = sweep.timestamp;
    const timeoutMs = this.orderTimeout * 1000;

    let filled = false;
    let fillTime = null;
    let fillCandle = null;
    let fillPrice = limitEntry;

    let outcome = null; // 'win' | 'loss' | 'timeout' | 'canceled_target_first'
    let exitTime = null;
    let exitPrice = null;
    let pnl = 0;
    let mae = 0; // Max adverse excursion after fill
    let mfe = 0; // Max favorable excursion after fill

    // Track if target was hit before we got filled
    let targetHitBeforeFill = false;

    for (let i = 0; i < subsequentCandles.length; i++) {
      const candle = subsequentCandles[i];
      const elapsed = candle.timestamp - sweepTime;

      if (!filled) {
        // Still waiting for fill

        // Check timeout
        if (elapsed > timeoutMs) {
          outcome = 'timeout';
          break;
        }

        // Check if target hit before fill (cancel condition)
        if (this.cancelIfTargetHitFirst) {
          if (direction === 'LONG' && candle.high >= takeProfit) {
            outcome = 'canceled_target_first';
            targetHitBeforeFill = true;
            break;
          }
          if (direction === 'SHORT' && candle.low <= takeProfit) {
            outcome = 'canceled_target_first';
            targetHitBeforeFill = true;
            break;
          }
        }

        // Check for fill
        if (direction === 'LONG' && candle.low <= limitEntry) {
          filled = true;
          fillTime = candle.timestamp;
          fillCandle = i;
          // Fill at limit price (assuming limit order)
          fillPrice = limitEntry;
        } else if (direction === 'SHORT' && candle.high >= limitEntry) {
          filled = true;
          fillTime = candle.timestamp;
          fillCandle = i;
          fillPrice = limitEntry;
        }

      } else {
        // We're in a position - check for exit

        if (direction === 'LONG') {
          // Track MAE/MFE
          const candlePnL = candle.low - fillPrice;
          const candleMFE = candle.high - fillPrice;
          if (candlePnL < mae) mae = candlePnL;
          if (candleMFE > mfe) mfe = candleMFE;

          // Check stop hit (check low first - assume worst case)
          if (candle.low <= stopLoss) {
            outcome = 'loss';
            exitTime = candle.timestamp;
            exitPrice = stopLoss;
            pnl = stopLoss - fillPrice;
            break;
          }

          // Check target hit
          if (candle.high >= takeProfit) {
            outcome = 'win';
            exitTime = candle.timestamp;
            exitPrice = takeProfit;
            pnl = takeProfit - fillPrice;
            break;
          }

        } else {
          // SHORT position
          const candlePnL = fillPrice - candle.high;
          const candleMFE = fillPrice - candle.low;
          if (candlePnL < mae) mae = candlePnL;
          if (candleMFE > mfe) mfe = candleMFE;

          // Check stop hit (check high first - assume worst case)
          if (candle.high >= stopLoss) {
            outcome = 'loss';
            exitTime = candle.timestamp;
            exitPrice = stopLoss;
            pnl = fillPrice - stopLoss;
            break;
          }

          // Check target hit
          if (candle.low <= takeProfit) {
            outcome = 'win';
            exitTime = candle.timestamp;
            exitPrice = takeProfit;
            pnl = fillPrice - takeProfit;
            break;
          }
        }
      }
    }

    // If we ran out of candles while in position
    if (filled && !outcome) {
      const lastCandle = subsequentCandles[subsequentCandles.length - 1];
      outcome = 'open';
      exitTime = lastCandle.timestamp;
      exitPrice = lastCandle.close;
      pnl = direction === 'LONG'
        ? lastCandle.close - fillPrice
        : fillPrice - lastCandle.close;
    }

    // If we never filled and didn't timeout/cancel
    if (!filled && !outcome) {
      outcome = 'no_fill';
    }

    return {
      sweepTimestamp: new Date(sweepTime).toISOString(),
      sweepType: sweep.type,
      direction,
      setup: {
        limitEntry: setup.limitEntry,
        stopLoss: setup.stopLoss,
        takeProfit: setup.takeProfit,
        risk: setup.risk,
        reward: setup.reward,
        rrRatio: setup.rrRatio
      },
      execution: {
        filled,
        fillTime: fillTime ? new Date(fillTime).toISOString() : null,
        fillPrice: filled ? fillPrice : null,
        timeToFill: fillTime ? (fillTime - sweepTime) / 1000 : null,
        outcome,
        exitTime: exitTime ? new Date(exitTime).toISOString() : null,
        exitPrice,
        pnl: round(pnl),
        mae: round(mae),
        mfe: round(mfe),
        holdTime: exitTime && fillTime ? (exitTime - fillTime) / 1000 : null
      }
    };
  }

  /**
   * Compute aggregate statistics from trade results
   *
   * @param {Object[]} results - Array of trade results from simulateTrade()
   * @returns {Object} Aggregate statistics
   */
  computeStatistics(results) {
    const total = results.length;
    if (total === 0) return this.getEmptyStats();

    // Group by outcome
    const filled = results.filter(r => r.execution.filled);
    const wins = results.filter(r => r.execution.outcome === 'win');
    const losses = results.filter(r => r.execution.outcome === 'loss');
    const timeouts = results.filter(r => r.execution.outcome === 'timeout');
    const canceledTargetFirst = results.filter(r => r.execution.outcome === 'canceled_target_first');
    const noFills = results.filter(r => r.execution.outcome === 'no_fill');
    const openTrades = results.filter(r => r.execution.outcome === 'open');

    // Fill statistics
    const fillRate = filled.length / total;
    const avgTimeToFill = filled.length > 0
      ? filled.reduce((sum, r) => sum + r.execution.timeToFill, 0) / filled.length
      : 0;

    // Win/loss statistics (only for filled trades that completed)
    const completedTrades = [...wins, ...losses];
    const winRate = completedTrades.length > 0
      ? wins.length / completedTrades.length
      : 0;

    // P&L statistics
    const totalPnL = filled.reduce((sum, r) => sum + r.execution.pnl, 0);
    const avgPnL = filled.length > 0 ? totalPnL / filled.length : 0;
    const avgWinPnL = wins.length > 0
      ? wins.reduce((sum, r) => sum + r.execution.pnl, 0) / wins.length
      : 0;
    const avgLossPnL = losses.length > 0
      ? losses.reduce((sum, r) => sum + r.execution.pnl, 0) / losses.length
      : 0;

    // Expectancy
    const expectancy = completedTrades.length > 0
      ? (winRate * avgWinPnL) + ((1 - winRate) * avgLossPnL)
      : 0;

    // Profit factor
    const grossProfit = wins.reduce((sum, r) => sum + r.execution.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((sum, r) => sum + r.execution.pnl, 0));
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

    // Average R:R
    const avgRR = results.reduce((sum, r) => sum + r.setup.rrRatio, 0) / total;

    // MAE/MFE for filled trades
    const avgMAE = filled.length > 0
      ? filled.reduce((sum, r) => sum + r.execution.mae, 0) / filled.length
      : 0;
    const avgMFE = filled.length > 0
      ? filled.reduce((sum, r) => sum + r.execution.mfe, 0) / filled.length
      : 0;

    // By direction
    const longTrades = results.filter(r => r.direction === 'LONG');
    const shortTrades = results.filter(r => r.direction === 'SHORT');

    const longFilled = longTrades.filter(r => r.execution.filled);
    const shortFilled = shortTrades.filter(r => r.execution.filled);

    const longWins = longTrades.filter(r => r.execution.outcome === 'win');
    const shortWins = shortTrades.filter(r => r.execution.outcome === 'win');

    const longCompleted = longTrades.filter(r => ['win', 'loss'].includes(r.execution.outcome));
    const shortCompleted = shortTrades.filter(r => ['win', 'loss'].includes(r.execution.outcome));

    // By session
    const sessions = ['overnight', 'premarket', 'rth', 'afterhours'];
    const bySession = {};

    sessions.forEach(session => {
      const sessionTrades = results.filter(r => r.session === session);
      if (sessionTrades.length === 0) return;

      const sessionFilled = sessionTrades.filter(r => r.execution.filled);
      const sessionWins = sessionTrades.filter(r => r.execution.outcome === 'win');
      const sessionCompleted = sessionTrades.filter(r => ['win', 'loss'].includes(r.execution.outcome));

      bySession[session] = {
        total: sessionTrades.length,
        filled: sessionFilled.length,
        fillRate: sessionTrades.length > 0 ? round((sessionFilled.length / sessionTrades.length) * 100) : 0,
        winRate: sessionCompleted.length > 0 ? round((sessionWins.length / sessionCompleted.length) * 100) : 0,
        avgPnL: sessionFilled.length > 0
          ? round(sessionFilled.reduce((sum, r) => sum + r.execution.pnl, 0) / sessionFilled.length)
          : 0
      };
    });

    return {
      total,
      outcomes: {
        filled: filled.length,
        wins: wins.length,
        losses: losses.length,
        timeouts: timeouts.length,
        canceledTargetFirst: canceledTargetFirst.length,
        noFill: noFills.length,
        open: openTrades.length
      },
      rates: {
        fillRate: round(fillRate * 100),
        winRate: round(winRate * 100),
        timeoutRate: round((timeouts.length / total) * 100),
        canceledRate: round((canceledTargetFirst.length / total) * 100)
      },
      timing: {
        avgTimeToFillSeconds: round(avgTimeToFill),
        avgHoldTimeSeconds: completedTrades.length > 0
          ? round(completedTrades.reduce((sum, r) => sum + r.execution.holdTime, 0) / completedTrades.length)
          : 0
      },
      pnl: {
        totalPnL: round(totalPnL),
        avgPnL: round(avgPnL),
        avgWinPnL: round(avgWinPnL),
        avgLossPnL: round(avgLossPnL),
        expectancy: round(expectancy),
        profitFactor: round(profitFactor)
      },
      risk: {
        avgRR: round(avgRR),
        avgMAE: round(avgMAE),
        avgMFE: round(avgMFE)
      },
      byDirection: {
        long: {
          total: longTrades.length,
          filled: longFilled.length,
          fillRate: longTrades.length > 0 ? round((longFilled.length / longTrades.length) * 100) : 0,
          winRate: longCompleted.length > 0 ? round((longWins.length / longCompleted.length) * 100) : 0,
          avgPnL: longFilled.length > 0
            ? round(longFilled.reduce((sum, r) => sum + r.execution.pnl, 0) / longFilled.length)
            : 0
        },
        short: {
          total: shortTrades.length,
          filled: shortFilled.length,
          fillRate: shortTrades.length > 0 ? round((shortFilled.length / shortTrades.length) * 100) : 0,
          winRate: shortCompleted.length > 0 ? round((shortWins.length / shortCompleted.length) * 100) : 0,
          avgPnL: shortFilled.length > 0
            ? round(shortFilled.reduce((sum, r) => sum + r.execution.pnl, 0) / shortFilled.length)
            : 0
        }
      },
      bySession
    };
  }

  getEmptyStats() {
    return {
      total: 0,
      outcomes: { filled: 0, wins: 0, losses: 0, timeouts: 0, canceledTargetFirst: 0, noFill: 0, open: 0 },
      rates: { fillRate: 0, winRate: 0, timeoutRate: 0, canceledRate: 0 },
      timing: { avgTimeToFillSeconds: 0, avgHoldTimeSeconds: 0 },
      pnl: { totalPnL: 0, avgPnL: 0, avgWinPnL: 0, avgLossPnL: 0, expectancy: 0, profitFactor: 0 },
      risk: { avgRR: 0, avgMAE: 0, avgMFE: 0 },
      byDirection: {
        long: { total: 0, filled: 0, fillRate: 0, winRate: 0, avgPnL: 0 },
        short: { total: 0, filled: 0, fillRate: 0, winRate: 0, avgPnL: 0 }
      }
    };
  }

  getConfig() {
    return {
      entryMode: this.entryMode,
      entryOffset: this.entryOffset,
      targetPoints: this.targetPoints,
      maxRisk: this.maxRisk,
      stopBuffer: this.stopBuffer,
      orderTimeout: this.orderTimeout,
      cancelIfTargetHitFirst: this.cancelIfTargetHitFirst
    };
  }
}

function round(value, decimals = 2) {
  return Math.round(value * Math.pow(10, decimals)) / Math.pow(10, decimals);
}
