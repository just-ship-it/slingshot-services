/**
 * Level Performance Tracker
 *
 * Tracks performance of each level+session combination over time.
 * Allows the strategy to adapt by deprioritizing underperforming
 * combinations and prioritizing winners.
 *
 * Uses a rolling window approach to track recent performance,
 * so the strategy adapts to changing market conditions.
 */

export class LevelPerformanceTracker {
  constructor(params = {}) {
    this.params = {
      // Rolling window for performance tracking (trades, not time)
      windowSize: 50,

      // Minimum trades before making decisions
      minTrades: 10,

      // Win rate threshold to be considered "active"
      minWinRate: 0.50,

      // Profit factor threshold
      minProfitFactor: 1.0,

      // Cool down period after disabling a combo (in trades across all combos)
      cooldownTrades: 100,

      // Auto-disable combos that underperform
      autoDisable: true,

      // Auto-enable combos that start performing
      autoEnable: true,

      ...params
    };

    // Performance data by level+session key
    // Key format: "LEVEL_NAME|SESSION" e.g., "VWAP|overnight"
    this.performance = new Map();

    // Disabled combos with cooldown counter
    this.disabled = new Map(); // key -> tradesUntilRecheck

    // Total trades counter for cooldown
    this.totalTrades = 0;

    // Snapshots for analysis
    this.snapshots = [];
  }

  /**
   * Get the key for a level+session combination
   */
  getKey(levelName, session) {
    return `${levelName}|${session}`;
  }

  /**
   * Record a trade result
   * @param {string} levelName - The level that triggered the trade
   * @param {string} session - The session: 'overnight', 'premarket', 'rth', 'afterhours'
   * @param {Object} trade - Trade result with { pnl, entryPrice, exitPrice, side }
   */
  recordTrade(levelName, session, trade) {
    const key = this.getKey(levelName, session);

    if (!this.performance.has(key)) {
      this.performance.set(key, {
        levelName,
        session,
        trades: [],
        totalTrades: 0,
        wins: 0,
        losses: 0,
        totalPnL: 0,
        enabled: true,
      });
    }

    const perf = this.performance.get(key);
    const isWin = trade.pnl > 0;

    // Add to rolling window
    perf.trades.push({
      pnl: trade.pnl,
      isWin,
      timestamp: trade.timestamp || Date.now(),
    });

    // Trim to window size
    while (perf.trades.length > this.params.windowSize) {
      perf.trades.shift();
    }

    // Update running totals
    perf.totalTrades++;
    perf.totalPnL += trade.pnl;
    if (isWin) {
      perf.wins++;
    } else {
      perf.losses++;
    }

    this.totalTrades++;

    // Decrement cooldowns
    for (const [disabledKey, remaining] of this.disabled.entries()) {
      if (remaining > 0) {
        this.disabled.set(disabledKey, remaining - 1);
      }
    }

    // Check if we should auto-disable
    if (this.params.autoDisable) {
      this.checkAutoDisable(key);
    }

    // Check if any disabled combos should be re-enabled
    if (this.params.autoEnable) {
      this.checkAutoEnable();
    }
  }

  /**
   * Check if a combo should be auto-disabled
   */
  checkAutoDisable(key) {
    const perf = this.performance.get(key);
    if (!perf || !perf.enabled) return;

    const windowStats = this.getWindowStats(key);
    if (windowStats.trades < this.params.minTrades) return;

    // Disable if win rate or profit factor falls below threshold
    if (windowStats.winRate < this.params.minWinRate ||
        windowStats.profitFactor < this.params.minProfitFactor) {
      perf.enabled = false;
      this.disabled.set(key, this.params.cooldownTrades);
      console.log(`[TRACKER] Disabled ${key}: WR=${(windowStats.winRate * 100).toFixed(1)}%, PF=${windowStats.profitFactor.toFixed(2)}`);
    }
  }

  /**
   * Check if any disabled combos should be re-enabled
   */
  checkAutoEnable() {
    for (const [key, remaining] of this.disabled.entries()) {
      if (remaining <= 0) {
        const perf = this.performance.get(key);
        if (perf && !perf.enabled) {
          // Re-enable and let it prove itself again
          perf.enabled = true;
          perf.trades = []; // Clear window for fresh start
          this.disabled.delete(key);
          console.log(`[TRACKER] Re-enabled ${key} for re-evaluation`);
        }
      }
    }
  }

  /**
   * Get rolling window statistics for a level+session combo
   */
  getWindowStats(key) {
    const perf = this.performance.get(key);
    if (!perf || perf.trades.length === 0) {
      return {
        trades: 0,
        wins: 0,
        losses: 0,
        winRate: 0,
        totalPnL: 0,
        avgWin: 0,
        avgLoss: 0,
        profitFactor: 0,
        enabled: true,
      };
    }

    const wins = perf.trades.filter(t => t.isWin);
    const losses = perf.trades.filter(t => !t.isWin);
    const totalPnL = perf.trades.reduce((sum, t) => sum + t.pnl, 0);
    const avgWin = wins.length > 0
      ? wins.reduce((sum, t) => sum + t.pnl, 0) / wins.length
      : 0;
    const avgLoss = losses.length > 0
      ? Math.abs(losses.reduce((sum, t) => sum + t.pnl, 0) / losses.length)
      : 0;
    const profitFactor = avgLoss > 0 ? avgWin / avgLoss * (wins.length / Math.max(1, losses.length)) : avgWin > 0 ? Infinity : 0;

    return {
      trades: perf.trades.length,
      wins: wins.length,
      losses: losses.length,
      winRate: perf.trades.length > 0 ? wins.length / perf.trades.length : 0,
      totalPnL,
      avgWin,
      avgLoss,
      profitFactor: this.calculateProfitFactor(perf.trades),
      enabled: perf.enabled,
    };
  }

  /**
   * Calculate profit factor from trades
   */
  calculateProfitFactor(trades) {
    const grossProfit = trades
      .filter(t => t.pnl > 0)
      .reduce((sum, t) => sum + t.pnl, 0);
    const grossLoss = Math.abs(trades
      .filter(t => t.pnl < 0)
      .reduce((sum, t) => sum + t.pnl, 0));

    return grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
  }

  /**
   * Check if a level+session combo is currently enabled
   */
  isEnabled(levelName, session) {
    const key = this.getKey(levelName, session);
    const perf = this.performance.get(key);

    // New combos are enabled by default
    if (!perf) return true;

    return perf.enabled;
  }

  /**
   * Get all combos sorted by performance
   */
  getRankings() {
    const rankings = [];

    for (const [key, perf] of this.performance.entries()) {
      const stats = this.getWindowStats(key);
      rankings.push({
        key,
        levelName: perf.levelName,
        session: perf.session,
        ...stats,
        allTimeWins: perf.wins,
        allTimeLosses: perf.losses,
        allTimePnL: perf.totalPnL,
        allTimeTrades: perf.totalTrades,
      });
    }

    // Sort by profit factor, then win rate, then P&L
    rankings.sort((a, b) => {
      if (a.profitFactor !== b.profitFactor) {
        return b.profitFactor - a.profitFactor;
      }
      if (a.winRate !== b.winRate) {
        return b.winRate - a.winRate;
      }
      return b.totalPnL - a.totalPnL;
    });

    return rankings;
  }

  /**
   * Get summary of all performance
   */
  getSummary() {
    const rankings = this.getRankings();
    const enabled = rankings.filter(r => r.enabled);
    const disabled = rankings.filter(r => !r.enabled);

    return {
      totalCombos: rankings.length,
      enabledCombos: enabled.length,
      disabledCombos: disabled.length,
      totalTrades: this.totalTrades,
      rankings,
      enabled,
      disabled,
    };
  }

  /**
   * Take a snapshot of current performance (for time-series analysis)
   */
  takeSnapshot(timestamp = Date.now()) {
    const snapshot = {
      timestamp,
      totalTrades: this.totalTrades,
      combos: [],
    };

    for (const [key, perf] of this.performance.entries()) {
      const stats = this.getWindowStats(key);
      snapshot.combos.push({
        key,
        levelName: perf.levelName,
        session: perf.session,
        ...stats,
      });
    }

    this.snapshots.push(snapshot);

    // Keep last 100 snapshots
    while (this.snapshots.length > 100) {
      this.snapshots.shift();
    }

    return snapshot;
  }

  /**
   * Print a formatted performance report
   */
  printReport() {
    const summary = this.getSummary();

    console.log('\n═══════════════════════════════════════════════════════════════════════════════');
    console.log('LEVEL PERFORMANCE TRACKER REPORT');
    console.log('═══════════════════════════════════════════════════════════════════════════════');
    console.log(`Total Trades: ${summary.totalTrades} | Combos: ${summary.enabledCombos} enabled, ${summary.disabledCombos} disabled`);
    console.log('───────────────────────────────────────────────────────────────────────────────');
    console.log('Level+Session'.padEnd(28) + 'Window'.padStart(8) + 'Win%'.padStart(8) + 'PF'.padStart(8) + 'P&L'.padStart(10) + 'Status'.padStart(10));
    console.log('───────────────────────────────────────────────────────────────────────────────');

    for (const r of summary.rankings) {
      const status = r.enabled ? '✅ Active' : '⛔ Disabled';
      const pnlStr = r.totalPnL >= 0 ? `+$${r.totalPnL.toFixed(0)}` : `-$${Math.abs(r.totalPnL).toFixed(0)}`;
      console.log(
        `${r.levelName}|${r.session}`.padEnd(28) +
        String(r.trades).padStart(8) +
        `${(r.winRate * 100).toFixed(1)}%`.padStart(8) +
        (r.profitFactor === Infinity ? '∞' : r.profitFactor.toFixed(2)).padStart(8) +
        pnlStr.padStart(10) +
        status.padStart(10)
      );
    }
    console.log('═══════════════════════════════════════════════════════════════════════════════\n');
  }

  /**
   * Reset all tracking data
   */
  reset() {
    this.performance.clear();
    this.disabled.clear();
    this.totalTrades = 0;
    this.snapshots = [];
  }

  /**
   * Export performance data for persistence
   */
  export() {
    const data = {
      params: this.params,
      totalTrades: this.totalTrades,
      performance: {},
      disabled: {},
    };

    for (const [key, perf] of this.performance.entries()) {
      data.performance[key] = {
        ...perf,
        trades: perf.trades.slice(-this.params.windowSize),
      };
    }

    for (const [key, remaining] of this.disabled.entries()) {
      data.disabled[key] = remaining;
    }

    return data;
  }

  /**
   * Import performance data from persistence
   */
  import(data) {
    if (data.params) {
      this.params = { ...this.params, ...data.params };
    }
    if (data.totalTrades) {
      this.totalTrades = data.totalTrades;
    }
    if (data.performance) {
      for (const [key, perf] of Object.entries(data.performance)) {
        this.performance.set(key, perf);
      }
    }
    if (data.disabled) {
      for (const [key, remaining] of Object.entries(data.disabled)) {
        this.disabled.set(key, remaining);
      }
    }
  }
}

export default LevelPerformanceTracker;
