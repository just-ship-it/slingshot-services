/**
 * Performance Metrics Calculator
 *
 * Calculates comprehensive performance statistics for backtesting results
 * Includes all standard metrics used in professional trading analysis
 */

import { roundTo } from '../../../shared/strategies/strategy-utils.js';

export class PerformanceCalculator {
  constructor(initialCapital = 100000, riskFreeRate = 0.02) {
    this.initialCapital = initialCapital;
    this.riskFreeRate = riskFreeRate; // Annual risk-free rate (e.g., 0.02 for 2%)
  }

  /**
   * Calculate comprehensive performance metrics
   *
   * @param {Object[]} trades - Array of completed trade objects
   * @param {Object[]} equityCurve - Array of equity curve points
   * @param {Date} startDate - Backtest start date
   * @param {Date} endDate - Backtest end date
   * @returns {Object} Complete performance analysis
   */
  calculateMetrics(trades, equityCurve, startDate, endDate) {
    if (!trades || trades.length === 0) {
      return this.getEmptyMetrics();
    }

    const basicStats = this.calculateBasicStats(trades);
    const returnMetrics = this.calculateReturnMetrics(trades, equityCurve, startDate, endDate);
    const riskMetrics = this.calculateRiskMetrics(equityCurve, returnMetrics.annualizedReturn);
    const drawdownMetrics = this.calculateDrawdownMetrics(equityCurve);
    const advancedMetrics = this.calculateAdvancedMetrics(returnMetrics, riskMetrics, drawdownMetrics);

    return {
      summary: {
        totalTrades: trades.length,
        totalPnL: basicStats.totalPnL,
        totalReturn: returnMetrics.totalReturn,
        annualizedReturn: returnMetrics.annualizedReturn,
        sharpeRatio: riskMetrics.sharpeRatio,
        maxDrawdown: drawdownMetrics.maxDrawdown,
        winRate: basicStats.winRate
      },
      basic: basicStats,
      returns: returnMetrics,
      risk: riskMetrics,
      drawdown: drawdownMetrics,
      advanced: advancedMetrics,
      period: {
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
        durationDays: Math.ceil((endDate - startDate) / (1000 * 60 * 60 * 24)),
        tradingDays: this.calculateTradingDays(startDate, endDate)
      }
    };
  }

  /**
   * Calculate basic trading statistics
   *
   * @param {Object[]} trades - Array of completed trades
   * @returns {Object} Basic statistics
   */
  calculateBasicStats(trades) {
    const winningTrades = trades.filter(t => t.netPnL > 0);
    const losingTrades = trades.filter(t => t.netPnL < 0);

    const totalPnL = trades.reduce((sum, t) => sum + t.netPnL, 0);
    const totalCommission = trades.reduce((sum, t) => sum + (t.commission || 0), 0);

    const avgWin = winningTrades.length > 0
      ? winningTrades.reduce((sum, t) => sum + t.netPnL, 0) / winningTrades.length
      : 0;

    const avgLoss = losingTrades.length > 0
      ? Math.abs(losingTrades.reduce((sum, t) => sum + t.netPnL, 0) / losingTrades.length)
      : 0;

    const largestWin = winningTrades.length > 0 ? Math.max(...winningTrades.map(t => t.netPnL)) : 0;
    const largestLoss = losingTrades.length > 0 ? Math.min(...losingTrades.map(t => t.netPnL)) : 0;

    // Calculate gross profit and gross loss for profit factor
    const grossProfit = winningTrades.reduce((sum, t) => sum + t.netPnL, 0);
    const grossLoss = Math.abs(losingTrades.reduce((sum, t) => sum + t.netPnL, 0));

    return {
      totalTrades: trades.length,
      winningTrades: winningTrades.length,
      losingTrades: losingTrades.length,
      winRate: trades.length > 0 ? roundTo((winningTrades.length / trades.length) * 100) : 0,
      lossRate: trades.length > 0 ? roundTo((losingTrades.length / trades.length) * 100) : 0,
      totalPnL: roundTo(totalPnL),
      totalCommission: roundTo(totalCommission),
      avgWin: roundTo(avgWin),
      avgLoss: roundTo(avgLoss),
      largestWin: roundTo(largestWin),
      largestLoss: roundTo(largestLoss),
      grossProfit: roundTo(grossProfit),
      grossLoss: roundTo(grossLoss),
      profitFactor: grossLoss > 0 ? roundTo(grossProfit / grossLoss) : grossProfit > 0 ? Infinity : 0,
      payoffRatio: avgLoss > 0 ? roundTo(avgWin / avgLoss) : avgWin > 0 ? Infinity : 0,
      avgTrade: trades.length > 0 ? roundTo(totalPnL / trades.length) : 0,
      expectancy: trades.length > 0 ? roundTo((winningTrades.length / trades.length) * avgWin - (losingTrades.length / trades.length) * avgLoss) : 0
    };
  }

  /**
   * Calculate return-based metrics
   *
   * @param {Object[]} trades - Array of completed trades
   * @param {Object[]} equityCurve - Equity curve data
   * @param {Date} startDate - Start date
   * @param {Date} endDate - End date
   * @returns {Object} Return metrics
   */
  calculateReturnMetrics(trades, equityCurve, startDate, endDate) {
    const finalEquity = equityCurve.length > 0 ? equityCurve[equityCurve.length - 1].equity : this.initialCapital;
    const totalReturn = ((finalEquity - this.initialCapital) / this.initialCapital) * 100;

    const durationYears = (endDate - startDate) / (1000 * 60 * 60 * 24 * 365.25);
    const annualizedReturn = durationYears > 0 ? roundTo(Math.pow((finalEquity / this.initialCapital), (1 / durationYears)) - 1) * 100 : 0;

    // Calculate period returns for additional analysis
    const monthlyReturns = this.calculatePeriodReturns(equityCurve, 'monthly');
    const dailyReturns = this.calculatePeriodReturns(equityCurve, 'daily');

    return {
      totalReturn: roundTo(totalReturn),
      annualizedReturn: roundTo(annualizedReturn),
      cagr: roundTo(annualizedReturn), // Compound Annual Growth Rate
      initialCapital: this.initialCapital,
      finalCapital: roundTo(finalEquity),
      monthlyReturns: monthlyReturns,
      dailyReturns: dailyReturns
    };
  }

  /**
   * Calculate risk-based metrics
   *
   * @param {Object[]} equityCurve - Equity curve data
   * @param {number} annualizedReturn - Annualized return percentage
   * @returns {Object} Risk metrics
   */
  calculateRiskMetrics(equityCurve, annualizedReturn) {
    const dailyReturns = this.calculateDailyReturns(equityCurve);

    const volatility = this.calculateVolatility(dailyReturns);
    const annualizedVolatility = volatility * Math.sqrt(252); // 252 trading days per year

    const sharpeRatio = annualizedVolatility > 0
      ? (annualizedReturn / 100 - this.riskFreeRate) / annualizedVolatility
      : 0;

    // Calculate Sortino ratio (uses only downside volatility)
    const downsideReturns = dailyReturns.filter(r => r < 0);
    const downsideVolatility = this.calculateVolatility(downsideReturns);
    const annualizedDownsideVolatility = downsideVolatility * Math.sqrt(252);

    const sortinoRatio = annualizedDownsideVolatility > 0
      ? (annualizedReturn / 100 - this.riskFreeRate) / annualizedDownsideVolatility
      : 0;

    return {
      volatility: roundTo(volatility * 100),
      annualizedVolatility: roundTo(annualizedVolatility * 100),
      sharpeRatio: roundTo(sharpeRatio),
      sortinoRatio: roundTo(sortinoRatio),
      downsideVolatility: roundTo(downsideVolatility * 100),
      annualizedDownsideVolatility: roundTo(annualizedDownsideVolatility * 100),
      beta: 0, // Would need market benchmark data to calculate
      alpha: 0  // Would need market benchmark data to calculate
    };
  }

  /**
   * Calculate drawdown metrics
   *
   * @param {Object[]} equityCurve - Equity curve data
   * @returns {Object} Drawdown metrics
   */
  calculateDrawdownMetrics(equityCurve) {
    if (!equityCurve || equityCurve.length === 0) {
      return {
        maxDrawdown: 0,
        maxDrawdownDuration: 0,
        currentDrawdown: 0,
        recoveryFactor: 0
      };
    }

    let peak = equityCurve[0].equity;
    let maxDrawdown = 0;
    let currentDrawdown = 0;
    let maxDrawdownDuration = 0;
    let currentDrawdownDuration = 0;
    let drawdownStart = null;

    const drawdowns = [];

    for (let i = 0; i < equityCurve.length; i++) {
      const equity = equityCurve[i].equity;

      if (equity > peak) {
        // New peak reached
        if (currentDrawdown > 0) {
          // End of drawdown period
          drawdowns.push({
            maxDrawdown: currentDrawdown,
            duration: currentDrawdownDuration,
            start: drawdownStart,
            end: equityCurve[i].timestamp
          });
          currentDrawdown = 0;
          currentDrawdownDuration = 0;
          drawdownStart = null;
        }
        peak = equity;
      } else {
        // In drawdown
        currentDrawdown = ((peak - equity) / peak) * 100;
        if (drawdownStart === null) {
          drawdownStart = equityCurve[i].timestamp;
        }
        currentDrawdownDuration = i - equityCurve.findIndex(point => point.equity === peak);

        if (currentDrawdown > maxDrawdown) {
          maxDrawdown = currentDrawdown;
        }

        if (currentDrawdownDuration > maxDrawdownDuration) {
          maxDrawdownDuration = currentDrawdownDuration;
        }
      }
    }

    const totalReturn = equityCurve.length > 0
      ? ((equityCurve[equityCurve.length - 1].equity - this.initialCapital) / this.initialCapital) * 100
      : 0;

    const recoveryFactor = maxDrawdown > 0 ? totalReturn / maxDrawdown : 0;

    return {
      maxDrawdown: roundTo(maxDrawdown),
      maxDrawdownDuration: maxDrawdownDuration,
      currentDrawdown: roundTo(currentDrawdown),
      recoveryFactor: roundTo(recoveryFactor),
      drawdowns: drawdowns
    };
  }

  /**
   * Calculate advanced performance metrics
   *
   * @param {Object} returnMetrics - Return metrics
   * @param {Object} riskMetrics - Risk metrics
   * @param {Object} drawdownMetrics - Drawdown metrics
   * @returns {Object} Advanced metrics
   */
  calculateAdvancedMetrics(returnMetrics, riskMetrics, drawdownMetrics) {
    // Calmar Ratio: Annualized return / Max drawdown
    const calmarRatio = drawdownMetrics.maxDrawdown > 0
      ? returnMetrics.annualizedReturn / drawdownMetrics.maxDrawdown
      : 0;

    // Sterling Ratio: Annualized return / Average drawdown
    const sterlingRatio = drawdownMetrics.drawdowns.length > 0
      ? returnMetrics.annualizedReturn / (drawdownMetrics.drawdowns.reduce((sum, dd) => sum + dd.maxDrawdown, 0) / drawdownMetrics.drawdowns.length)
      : 0;

    // Information Ratio (simplified without benchmark)
    const informationRatio = riskMetrics.annualizedVolatility > 0
      ? returnMetrics.annualizedReturn / riskMetrics.annualizedVolatility
      : 0;

    return {
      calmarRatio: roundTo(calmarRatio),
      sterlingRatio: roundTo(sterlingRatio),
      informationRatio: roundTo(informationRatio),
      treynorRatio: 0, // Would need beta calculation
      jensenAlpha: 0   // Would need market benchmark
    };
  }

  /**
   * Calculate daily returns from equity curve
   *
   * Aggregates per-trade equity curve points to actual calendar days,
   * including zero-return days (trading days with no trades).
   *
   * @param {Object[]} equityCurve - Equity curve data (per-trade points)
   * @returns {number[]} Array of daily returns
   */
  calculateDailyReturns(equityCurve) {
    if (!equityCurve || equityCurve.length === 0) {
      return [];
    }

    // Aggregate equity by calendar day (use end-of-day equity for each day)
    const dailyEquity = new Map();
    for (const point of equityCurve) {
      const day = new Date(point.timestamp).toISOString().slice(0, 10);
      // Keep the last (highest timestamp) equity value for each day
      dailyEquity.set(day, point.equity);
    }

    // Get the date range
    const timestamps = equityCurve.map(p => p.timestamp);
    const startDate = new Date(Math.min(...timestamps));
    const endDate = new Date(Math.max(...timestamps));

    // Build list of all trading days (weekdays) in the period
    const allTradingDays = [];
    const d = new Date(startDate);
    d.setUTCHours(0, 0, 0, 0);

    while (d <= endDate) {
      const dow = d.getUTCDay();
      if (dow !== 0 && dow !== 6) { // Not weekend
        allTradingDays.push(d.toISOString().slice(0, 10));
      }
      d.setUTCDate(d.getUTCDate() + 1);
    }

    if (allTradingDays.length === 0) {
      return [];
    }

    // Calculate daily returns, including zero-return days
    const returns = [];
    let prevEquity = this.initialCapital;

    for (const day of allTradingDays) {
      // Use end-of-day equity if we have it, otherwise carry forward previous equity
      const currentEquity = dailyEquity.get(day) || prevEquity;
      const dailyReturn = (currentEquity - prevEquity) / prevEquity;
      returns.push(dailyReturn);
      prevEquity = currentEquity;
    }

    return returns;
  }

  /**
   * Calculate period returns (monthly, daily, etc.)
   *
   * @param {Object[]} equityCurve - Equity curve data
   * @param {string} period - Period type ('monthly', 'daily')
   * @returns {number[]} Array of period returns
   */
  calculatePeriodReturns(equityCurve, period) {
    // Simplified implementation - would need more sophisticated period grouping
    return this.calculateDailyReturns(equityCurve);
  }

  /**
   * Calculate volatility (standard deviation of returns)
   *
   * @param {number[]} returns - Array of returns
   * @returns {number} Volatility
   */
  calculateVolatility(returns) {
    if (returns.length <= 1) return 0;

    const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;
    const squaredDifferences = returns.map(r => Math.pow(r - mean, 2));
    const variance = squaredDifferences.reduce((sum, sq) => sum + sq, 0) / (returns.length - 1);

    return Math.sqrt(variance);
  }

  /**
   * Calculate approximate trading days in period
   *
   * @param {Date} startDate - Start date
   * @param {Date} endDate - End date
   * @returns {number} Estimated trading days
   */
  calculateTradingDays(startDate, endDate) {
    const totalDays = Math.ceil((endDate - startDate) / (1000 * 60 * 60 * 24));
    // Approximate: 252 trading days per 365 calendar days
    return Math.round(totalDays * (252 / 365));
  }

  /**
   * Get empty metrics object for zero trades
   *
   * @returns {Object} Empty metrics
   */
  getEmptyMetrics() {
    return {
      summary: {
        totalTrades: 0,
        totalPnL: 0,
        totalReturn: 0,
        annualizedReturn: 0,
        sharpeRatio: 0,
        maxDrawdown: 0,
        winRate: 0
      },
      basic: {
        totalTrades: 0,
        winningTrades: 0,
        losingTrades: 0,
        winRate: 0,
        totalPnL: 0,
        avgWin: 0,
        avgLoss: 0,
        grossProfit: 0,
        grossLoss: 0,
        profitFactor: 0,
        payoffRatio: 0,
        expectancy: 0
      },
      returns: {
        totalReturn: 0,
        annualizedReturn: 0,
        initialCapital: this.initialCapital,
        finalCapital: this.initialCapital
      },
      risk: {
        volatility: 0,
        sharpeRatio: 0,
        sortinoRatio: 0
      },
      drawdown: {
        maxDrawdown: 0,
        recoveryFactor: 0
      },
      advanced: {
        calmarRatio: 0,
        informationRatio: 0
      }
    };
  }
}