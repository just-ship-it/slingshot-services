/**
 * Console Reporter
 *
 * Formats and displays backtesting results in the console
 * Professional-looking tables and summaries
 */

import chalk from 'chalk';
import Table from 'cli-table3';
import { roundTo } from '../../../shared/strategies/strategy-utils.js';

export class ConsoleReporter {
  constructor(config = {}) {
    this.config = {
      precision: 2,
      showTrades: false,
      showSummary: true,
      ...config
    };
  }

  /**
   * Display strategy configuration details
   *
   * @param {Object} strategyParams - Strategy parameters
   * @param {Object} backtestConfig - Backtest configuration
   * @param {Object} contractSpecs - Contract specifications
   */
  displayStrategyConfiguration(strategyParams, backtestConfig, contractSpecs) {
    console.log('');
    console.log(chalk.cyan.bold('📊 STRATEGY CONFIGURATION'));
    console.log(chalk.gray('═'.repeat(60)));

    console.log(chalk.white(`Strategy: ${chalk.yellow(backtestConfig.strategy.toUpperCase())}`));

    // Display strategy-specific parameters
    const strategy = backtestConfig.strategy.toLowerCase();
    switch (strategy) {
      case 'gex-recoil':
        this.displayGexRecoilConfig(strategyParams);
        break;
      case 'gex-ldpm-confluence':
        this.displayGexLdpmConfluenceConfig(strategyParams);
        break;
      case 'gex-ldpm-confluence-lt':
        this.displayGexLdpmConfluenceLTConfig(strategyParams);
        break;
      default:
        // Fallback to original display for unknown strategies
        this.displayGenericStrategyConfig(strategyParams);
        break;
    }

    // Contract Specifications
    const ticker = backtestConfig.ticker.toUpperCase();
    const spec = contractSpecs[ticker];
    if (spec) {
      console.log(chalk.white(`└─ Contract Specs (${ticker}):`));
      console.log(chalk.gray(`   ├─ Point Value: $${spec.pointValue.toFixed(2)}`));
      console.log(chalk.gray(`   ├─ Tick Size: ${spec.tickSize}`));
      console.log(chalk.gray(`   ├─ Tick Value: $${spec.tickValue.toFixed(2)}`));
      console.log(chalk.gray(`   └─ Commission: $${backtestConfig.commission.toFixed(2)} round-trip`));
    }

    console.log(chalk.gray('═'.repeat(60)));
  }

  /**
   * Display GEX-Recoil strategy configuration
   */
  displayGexRecoilConfig(params) {
    // Entry/Exit Settings
    console.log(chalk.white('├─ Entry/Exit Settings:'));
    console.log(chalk.gray(`│  ├─ Target Points: ${params.targetPoints}`));
    console.log(chalk.gray(`│  ├─ Stop Buffer: ${params.stopBuffer} points`));
    console.log(chalk.gray(`│  ├─ Max Risk: ${params.maxRisk} points`));
    console.log(chalk.gray(`│  └─ Position Size: ${params.defaultQuantity || 1} contract(s)`));

    // Trailing Stop
    console.log(chalk.white('├─ Trailing Stop:'));
    console.log(chalk.gray(`│  ├─ Enabled: ${params.useTrailingStop ? chalk.green('Yes') : chalk.red('No')}`));
    if (params.trailingTrigger) {
      console.log(chalk.gray(`│  ├─ Trigger: ${params.trailingTrigger} points${!params.useTrailingStop ? ' (when enabled)' : ''}`));
    }
    if (params.trailingOffset) {
      console.log(chalk.gray(`│  └─ Offset: ${params.trailingOffset} points${!params.useTrailingStop ? ' (when enabled)' : ''}`));
    }

    // Risk Management
    console.log(chalk.white('├─ Risk Management:'));
    console.log(chalk.gray(`│  ├─ Liquidity Filter: ${params.useLiquidityFilter ? chalk.green('Enabled') : chalk.red('Disabled')}`));
    if (params.useLiquidityFilter && params.maxLtLevelsBelow) {
      console.log(chalk.gray(`│  │  └─ Max LT Levels Below: ${params.maxLtLevelsBelow}`));
    }
    console.log(chalk.gray(`│  ├─ Signal Cooldown: ${(params.signalCooldownMs / 60000).toFixed(0)} minutes`));
    console.log(chalk.gray(`│  └─ Market Close: 4:00 PM EST (force exit)`));
  }

  /**
   * Display GEX-LDPM Confluence strategy configuration
   */
  displayGexLdpmConfluenceConfig(params) {
    // Entry/Exit Settings
    console.log(chalk.white('├─ Entry/Exit Settings:'));
    console.log(chalk.gray(`│  ├─ Confluence Threshold: ${params.confluenceThreshold} points`));
    console.log(chalk.gray(`│  ├─ Entry Distance: ${params.entryDistance} points`));
    console.log(chalk.gray(`│  ├─ Stop Loss: ${params.stopLossPoints} points`));
    console.log(chalk.gray(`│  ├─ Target at Center: ${params.targetAtCenter ? chalk.green('Yes') : chalk.red('No')}`));
    if (params.targetPoints) {
      console.log(chalk.gray(`│  ├─ Target Points: ${params.targetPoints} points`));
    }
    console.log(chalk.gray(`│  ├─ Max Risk: ${params.maxRisk} points`));
    console.log(chalk.gray(`│  ├─ Position Size: ${params.defaultQuantity || 1} contract(s)`));
    console.log(chalk.gray(`│  └─ Trailing Stop: ${params.useTrailingStop ? chalk.green('Enabled') : chalk.red('Disabled')}`));
    if (params.useTrailingStop && params.trailingTrigger) {
      console.log(chalk.gray(`│     ├─ Trigger: ${params.trailingTrigger} points`));
      console.log(chalk.gray(`│     └─ Offset: ${params.trailingOffset} points`));
    }

    // Regime-Based Position Sizing
    console.log(chalk.white('├─ Position Sizing by Regime:'));
    console.log(chalk.gray(`│  ├─ Positive Regime: ${params.positiveRegimeSize}x`));
    console.log(chalk.gray(`│  ├─ Negative Regime: ${params.negativeRegimeSize}x`));
    console.log(chalk.gray(`│  └─ Transition Regime: ${params.transitionRegimeSize}x`));

    // Volume Confirmation
    console.log(chalk.white('├─ Volume & Timing:'));
    console.log(chalk.gray(`│  ├─ Volume Confirmation: ${params.volumeConfirmationPct}% above average`));
    console.log(chalk.gray(`│  ├─ Volume Lookback: ${params.volumeLookbackPeriods} periods`));
    console.log(chalk.gray(`│  ├─ RTH Only: ${params.rthOnly ? chalk.green('Yes') : chalk.red('No')}`));
    console.log(chalk.gray(`│  ├─ Overnight Reduced: ${params.overnightReduced ? chalk.green('Yes') : chalk.red('No')}`));
    if (params.overnightReduced) {
      console.log(chalk.gray(`│  │  └─ Overnight Multiplier: ${params.overnightSizeMultiplier}x`));
    }
    console.log(chalk.gray(`│  └─ Signal Cooldown: ${(params.signalCooldownMs / 60000).toFixed(0)} minutes`));

    // Risk Management
    console.log(chalk.white('└─ Risk Management:'));
    console.log(chalk.gray(`   ├─ News Avoidance: ${params.avoidNewsMinutes} minutes around releases`));
    console.log(chalk.gray(`   └─ Market Close: 4:00 PM EST (force exit)`));
  }

  /**
   * Display GEX-LDPM Confluence LT strategy configuration
   */
  displayGexLdpmConfluenceLTConfig(params) {
    // Call base confluence config first
    this.displayGexLdpmConfluenceConfig(params);

    // Add LT-specific settings
    console.log(chalk.white('└─ LT Level Entry System:'));
    console.log(chalk.gray(`   ├─ LT Entries: ${params.useLTLevelEntries ? chalk.green('Enabled') : chalk.red('Disabled')}`));
    if (params.useLTLevelEntries) {
      console.log(chalk.gray(`   ├─ Entry Timeout: ${params.ltEntryTimeoutCandles} candles`));
      console.log(chalk.gray(`   ├─ Min LT Spacing: ${params.ltMinSpacing} points`));
      console.log(chalk.gray(`   ├─ Max LT Distance: ${params.ltMaxDistance} points`));
      console.log(chalk.gray(`   └─ Fallback to Signal: ${params.ltFallbackToSignal ? chalk.green('Yes') : chalk.red('No')}`));
    }
  }

  /**
   * Display generic strategy configuration (fallback)
   */
  displayGenericStrategyConfig(params) {
    console.log(chalk.white('├─ Strategy Parameters:'));
    const importantParams = ['confluenceThreshold', 'entryDistance', 'stopLossPoints', 'targetPoints', 'stopBuffer', 'maxRisk', 'defaultQuantity'];

    importantParams.forEach((param, index) => {
      if (params[param] !== undefined) {
        const isLast = index === importantParams.length - 1 || !importantParams.slice(index + 1).some(p => params[p] !== undefined);
        const prefix = isLast ? '└─' : '├─';
        console.log(chalk.gray(`│  ${prefix} ${param}: ${params[param]}`));
      }
    });

    // Risk Management
    console.log(chalk.white('└─ Risk Management:'));
    console.log(chalk.gray(`   ├─ Signal Cooldown: ${(params.signalCooldownMs / 60000).toFixed(0)} minutes`));
    console.log(chalk.gray(`   └─ Market Close: 4:00 PM EST (force exit)`));
  }

  /**
   * Display complete backtesting results
   *
   * @param {Object} results - Backtesting results
   * @param {Object} backtestConfig - Backtest configuration
   */
  displayResults(results, backtestConfig) {
    console.log('');

    // Header
    this.displayHeader(backtestConfig);

    // Performance summary
    if (this.config.showSummary) {
      this.displayPerformanceSummary(results.performance);
    }

    // Detailed metrics
    this.displayDetailedMetrics(results.performance);

    // Trade breakdown
    if (results.trades && results.trades.length > 0) {
      this.displayTradeBreakdown(results.trades);
    }

    // Individual trades (if requested)
    if (this.config.showTrades && results.trades) {
      this.displayTradeList(results.trades);
    }

    // Footer with timing info
    this.displayFooter(results);
  }

  /**
   * Display header information
   *
   * @param {Object} config - Backtest configuration
   */
  displayHeader(config) {
    console.log(chalk.blue.bold('📊 BACKTEST RESULTS'));
    console.log(chalk.gray('═'.repeat(60)));
    console.log(chalk.white(`Strategy: ${config.strategy.toUpperCase()}`));
    console.log(chalk.white(`Symbol: ${config.ticker}`));
    console.log(chalk.white(`Period: ${config.startDate.toISOString().split('T')[0]} → ${config.endDate.toISOString().split('T')[0]}`));
    console.log(chalk.white(`Timeframe: ${config.timeframe}`));
    console.log(chalk.white(`Initial Capital: $${config.initialCapital.toLocaleString()}`));
    console.log(chalk.gray('═'.repeat(60)));
  }

  /**
   * Display performance summary table
   *
   * @param {Object} performance - Performance metrics
   */
  displayPerformanceSummary(performance) {
    const summary = performance.summary;

    const table = new Table({
      head: [chalk.bold('Metric'), chalk.bold('Value')],
      colWidths: [25, 20],
      style: { head: ['cyan'] }
    });

    // Color code performance metrics
    const totalReturn = summary.totalReturn;
    const returnColor = totalReturn >= 0 ? 'green' : 'red';

    const sharpeColor = summary.sharpeRatio >= 1.5 ? 'green' : summary.sharpeRatio >= 1.0 ? 'yellow' : 'red';
    const winRateColor = summary.winRate >= 60 ? 'green' : summary.winRate >= 40 ? 'yellow' : 'red';

    table.push(
      ['Total Trades', summary.totalTrades],
      ['Total Return', chalk[returnColor](`${this.formatPercent(totalReturn)}`)],
      ['Annualized Return', chalk[returnColor](`${this.formatPercent(summary.annualizedReturn)}`)],
      ['Total P&L', chalk[returnColor](`$${summary.totalPnL.toLocaleString()}`)],
      ['Sharpe Ratio', chalk[sharpeColor](this.formatNumber(summary.sharpeRatio))],
      ['Max Drawdown', chalk.red(`${this.formatPercent(summary.maxDrawdown)}`)],
      ['Win Rate', chalk[winRateColor](`${this.formatPercent(summary.winRate)}`)]
    );

    console.log('\n' + chalk.bold('📈 PERFORMANCE SUMMARY'));
    console.log(table.toString());
  }

  /**
   * Display detailed metrics in organized sections
   *
   * @param {Object} performance - Performance metrics
   */
  displayDetailedMetrics(performance) {
    // Trading Statistics
    this.displayTradingStats(performance.basic);

    // Risk Metrics
    this.displayRiskMetrics(performance.risk, performance.drawdown);

    // Advanced Metrics
    this.displayAdvancedMetrics(performance.advanced);
  }

  /**
   * Display trading statistics
   *
   * @param {Object} basic - Basic trading stats
   */
  displayTradingStats(basic) {
    const table = new Table({
      head: [chalk.bold('Trading Statistics'), chalk.bold('Value')],
      colWidths: [25, 20],
      style: { head: ['green'] }
    });

    const profitFactorColor = basic.profitFactor >= 2.0 ? 'green' : basic.profitFactor >= 1.5 ? 'yellow' : 'red';
    const expectancyColor = basic.expectancy > 0 ? 'green' : 'red';

    table.push(
      ['Winning Trades', chalk.green(basic.winningTrades)],
      ['Losing Trades', chalk.red(basic.losingTrades)],
      ['Average Win', chalk.green(`$${this.formatNumber(basic.avgWin)}`)],
      ['Average Loss', chalk.red(`$${this.formatNumber(Math.abs(basic.avgLoss))}`)],
      ['Largest Win', chalk.green(`$${this.formatNumber(basic.largestWin)}`)],
      ['Largest Loss', chalk.red(`$${this.formatNumber(Math.abs(basic.largestLoss))}`)],
      ['Profit Factor', chalk[profitFactorColor](this.formatNumber(basic.profitFactor))],
      ['Expectancy', chalk[expectancyColor](`$${this.formatNumber(basic.expectancy)}`)],
      ['Average Trade', `$${this.formatNumber(basic.avgTrade)}`],
      ['Total Commission', chalk.yellow(`$${this.formatNumber(basic.totalCommission)}`)]
    );

    console.log('\n' + chalk.bold('📊 TRADING STATISTICS'));
    console.log(table.toString());
  }

  /**
   * Display risk metrics
   *
   * @param {Object} risk - Risk metrics
   * @param {Object} drawdown - Drawdown metrics
   */
  displayRiskMetrics(risk, drawdown) {
    const table = new Table({
      head: [chalk.bold('Risk Metrics'), chalk.bold('Value')],
      colWidths: [25, 20],
      style: { head: ['yellow'] }
    });

    const sharpeColor = risk.sharpeRatio >= 1.5 ? 'green' : risk.sharpeRatio >= 1.0 ? 'yellow' : 'red';
    const sortinoColor = risk.sortinoRatio >= 2.0 ? 'green' : risk.sortinoRatio >= 1.5 ? 'yellow' : 'red';

    table.push(
      ['Volatility (Annual)', `${this.formatPercent(risk.annualizedVolatility)}`],
      ['Sharpe Ratio', chalk[sharpeColor](this.formatNumber(risk.sharpeRatio))],
      ['Sortino Ratio', chalk[sortinoColor](this.formatNumber(risk.sortinoRatio))],
      ['Max Drawdown', chalk.red(`${this.formatPercent(drawdown.maxDrawdown)}`)],
      ['Current Drawdown', `${this.formatPercent(drawdown.currentDrawdown)}`],
      ['Recovery Factor', this.formatNumber(drawdown.recoveryFactor)],
      ['Max DD Duration', `${drawdown.maxDrawdownDuration} periods`]
    );

    console.log('\n' + chalk.bold('⚠️  RISK ANALYSIS'));
    console.log(table.toString());
  }

  /**
   * Display advanced metrics
   *
   * @param {Object} advanced - Advanced metrics
   */
  displayAdvancedMetrics(advanced) {
    const table = new Table({
      head: [chalk.bold('Advanced Metrics'), chalk.bold('Value')],
      colWidths: [25, 20],
      style: { head: ['magenta'] }
    });

    table.push(
      ['Calmar Ratio', this.formatNumber(advanced.calmarRatio)],
      ['Sterling Ratio', this.formatNumber(advanced.sterlingRatio)],
      ['Information Ratio', this.formatNumber(advanced.informationRatio)]
    );

    console.log('\n' + chalk.bold('🎯 ADVANCED METRICS'));
    console.log(table.toString());
  }

  /**
   * Display trade breakdown by exit reason
   *
   * @param {Object[]} trades - Array of completed trades
   */
  displayTradeBreakdown(trades) {
    const breakdown = this.analyzeTradeBreakdown(trades);

    const table = new Table({
      head: [chalk.bold('Exit Reason'), chalk.bold('Count'), chalk.bold('Total P&L'), chalk.bold('Avg P&L')],
      colWidths: [15, 10, 15, 15],
      style: { head: ['cyan'] }
    });

    Object.entries(breakdown).forEach(([reason, stats]) => {
      const pnlColor = stats.totalPnL >= 0 ? 'green' : 'red';
      table.push([
        reason.replace('_', ' ').toUpperCase(),
        stats.count,
        chalk[pnlColor](`$${this.formatNumber(stats.totalPnL)}`),
        chalk[pnlColor](`$${this.formatNumber(stats.avgPnL)}`)
      ]);
    });

    console.log('\n' + chalk.bold('📋 TRADE BREAKDOWN'));
    console.log(table.toString());
  }

  /**
   * Display list of individual trades
   *
   * @param {Object[]} trades - Array of completed trades
   */
  displayTradeList(trades) {
    const table = new Table({
      head: [
        chalk.bold('ID'),
        chalk.bold('Entry'),
        chalk.bold('Exit'),
        chalk.bold('P&L'),
        chalk.bold('Points'),
        chalk.bold('Exit Reason')
      ],
      colWidths: [8, 12, 12, 12, 10, 12],
      style: { head: ['white'] }
    });

    trades.slice(-20).forEach(trade => { // Show last 20 trades
      const pnlColor = trade.netPnL >= 0 ? 'green' : 'red';
      const entryDate = new Date(trade.entryTime).toLocaleDateString();
      const exitDate = new Date(trade.exitTime).toLocaleDateString();

      table.push([
        trade.id,
        entryDate,
        exitDate,
        chalk[pnlColor](`$${this.formatNumber(trade.netPnL)}`),
        chalk[pnlColor](this.formatNumber(trade.pointsPnL)),
        trade.exitReason.replace('_', ' ')
      ]);
    });

    console.log('\n' + chalk.bold('📝 RECENT TRADES'));
    console.log(table.toString());

    if (trades.length > 20) {
      console.log(chalk.gray(`... and ${trades.length - 20} more trades`));
    }
  }

  /**
   * Display footer with execution info
   *
   * @param {Object} results - Backtest results
   */
  displayFooter(results) {
    console.log('\n' + chalk.gray('═'.repeat(60)));

    // Show signal statistics
    if (results.simulation) {
      console.log(chalk.gray(`Signals Generated: ${results.simulation.totalSignals}`));
      if (results.simulation.rejectedSignals > 0) {
        console.log(chalk.yellow(`Signals Rejected: ${results.simulation.rejectedSignals} (position already active)`));
      }
      console.log(chalk.gray(`Trades Executed: ${results.simulation.executedTrades}`));
    }

    console.log(chalk.gray(`Backtest completed in ${results.executionTimeMs || 0}ms`));
    console.log(chalk.gray(`Generated on ${new Date().toISOString()}`));
    console.log(chalk.blue('🚀 Slingshot Backtesting Engine'));
    console.log('');
  }

  /**
   * Analyze trades by exit reason
   *
   * @param {Object[]} trades - Array of completed trades
   * @returns {Object} Breakdown by exit reason
   */
  analyzeTradeBreakdown(trades) {
    const breakdown = {};

    trades.forEach(trade => {
      const reason = trade.exitReason || 'unknown';

      if (!breakdown[reason]) {
        breakdown[reason] = {
          count: 0,
          totalPnL: 0,
          avgPnL: 0
        };
      }

      breakdown[reason].count++;
      breakdown[reason].totalPnL += trade.netPnL;
    });

    // Calculate averages
    Object.values(breakdown).forEach(stats => {
      stats.avgPnL = stats.count > 0 ? stats.totalPnL / stats.count : 0;
    });

    return breakdown;
  }

  /**
   * Display error message
   *
   * @param {string} message - Error message
   * @param {Error} error - Error object
   */
  displayError(message, error) {
    console.log('');
    console.log(chalk.red.bold('❌ ERROR'));
    console.log(chalk.red(message));
    if (error && error.stack && process.env.NODE_ENV === 'development') {
      console.log(chalk.gray(error.stack));
    }
    console.log('');
  }

  /**
   * Display warning message
   *
   * @param {string} message - Warning message
   */
  displayWarning(message) {
    console.log(chalk.yellow(`⚠️  ${message}`));
  }

  /**
   * Display success message
   *
   * @param {string} message - Success message
   */
  displaySuccess(message) {
    console.log(chalk.green(`✅ ${message}`));
  }

  /**
   * Format number with specified precision
   *
   * @param {number} value - Number to format
   * @returns {string} Formatted number
   */
  formatNumber(value) {
    if (value === Infinity) return '∞';
    if (value === -Infinity) return '-∞';
    if (isNaN(value)) return 'N/A';
    return value.toFixed(this.config.precision);
  }

  /**
   * Format percentage with % symbol
   *
   * @param {number} value - Percentage value
   * @returns {string} Formatted percentage
   */
  formatPercent(value) {
    return `${this.formatNumber(value)}%`;
  }
}