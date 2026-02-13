/**
 * Overnight ES Charm/Vanna Strategy
 *
 * Profits from dealer charm/vanna hedging flows on ES overnight.
 *
 * Theory: Dealers who are short SPY options must rebalance hedges overnight as
 * time passes (charm) and IV compresses (vanna). Positive net charm exposure (CEX)
 * means dealers need to buy futures → upward pressure. The signal is generated at
 * EOD from the SPY options chain, and we trade ES overnight.
 *
 * Signal logic:
 * 1. At entry time (~4pm ET or 6pm futures open): look up today's precomputed CEX/VEX
 * 2. Determine direction: positive net_cex → buy ES, negative → sell ES
 * 3. Apply filters (CEX percentile, VEX confirmation, VIX regime, day-of-week)
 * 4. Generate market order signal with stop/target + forced time exit
 *
 * Exit strategy:
 * - Primary: Fixed time exit (configurable: 2am, 9:30am ET)
 * - Protective: Stop loss and take profit
 */

import { BaseStrategy } from './base-strategy.js';
import { roundTo } from './strategy-utils.js';

export class OvernightCharmVannaStrategy extends BaseStrategy {
  constructor(params = {}) {
    super(params);

    this.defaultParams = {
      // Entry/Exit timing (EST hours)
      entryHourET: 16,           // 4 PM ET — EOD signal
      exitHourET: 9.5,           // 9:30 AM ET — RTH open
      exitNextDay: true,         // Exit is next day (overnight hold)

      // Stop/Target
      stopLossPoints: 15,        // ES points
      takeProfitPoints: 20,      // ES points

      // CEX thresholds
      minCexPercentile: 50,      // Skip weak signals (percentile of historical CEX)
      minCexAbsolute: 0,         // Minimum absolute CEX value (0 = use percentile only)

      // Optional filters
      requireVexConfirmation: false,  // CEX and VEX must agree on direction
      useVixFilter: false,            // Skip VIX extremes
      minVix: 12,                     // Below this = no hedging pressure
      maxVix: 35,                     // Above this = crisis, skip
      useDayFilter: false,            // Skip specific days
      blockedDays: ['Friday'],        // Skip Friday overnight (weekend risk)

      // Session
      signalCooldownMs: 60000,
      maxHoldBars: 0,            // Disabled — use time exit instead
      forceCloseAtMarketClose: false,  // We WANT overnight holds

      // Symbol
      tradingSymbol: 'ES',
      defaultQuantity: 1,
    };

    this.params = { ...this.defaultParams, ...params };

    // CEX percentile tracking (computed from loaded data)
    this._cexValues = [];       // Historical CEX values for percentile calculation
    this._cexPercentiles = null; // Precomputed percentile thresholds
    this._lastSignalDate = null; // Track to avoid duplicate signals same day
    this._charmVannaLoader = null; // Set by engine via loadCharmVannaData()
  }

  /**
   * Load charm/vanna data loader reference (called by backtest engine)
   * @param {CharmVannaLoader} loader - The loader instance
   */
  loadCharmVannaData(loader) {
    this._charmVannaLoader = loader;

    // Build CEX percentile distribution from loaded daily data
    const allData = loader.getAllDailyData();
    this._cexValues = allData
      .map(d => d.netCex)
      .filter(v => !isNaN(v) && isFinite(v))
      .sort((a, b) => a - b);
  }

  /**
   * Get CEX percentile for a given value
   * @param {number} cexValue - CEX value to check
   * @returns {number} Percentile (0-100)
   */
  getCexPercentile(cexValue) {
    if (this._cexValues.length === 0) return 50;

    const absValues = this._cexValues.map(v => Math.abs(v)).sort((a, b) => a - b);
    const absCex = Math.abs(cexValue);

    // Binary search for position in sorted absolute values
    let left = 0;
    let right = absValues.length;
    while (left < right) {
      const mid = (left + right) >> 1;
      if (absValues[mid] < absCex) left = mid + 1;
      else right = mid;
    }

    return (left / absValues.length) * 100;
  }

  /**
   * Get EST hour as decimal from timestamp
   */
  getESTHour(timestamp) {
    const date = new Date(timestamp);
    const estString = date.toLocaleString('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      minute: 'numeric',
      hour12: false
    });
    const [hourStr, minStr] = estString.split(':');
    return parseInt(hourStr) + parseInt(minStr) / 60;
  }

  /**
   * Get EST date string from timestamp
   */
  getESTDateStr(timestamp) {
    const date = new Date(timestamp);
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);

    let year, month, day;
    for (const p of parts) {
      if (p.type === 'year') year = p.value;
      if (p.type === 'month') month = p.value;
      if (p.type === 'day') day = p.value;
    }
    return `${year}-${month}-${day}`;
  }

  /**
   * Get day of week name from date string
   */
  getDayOfWeek(dateStr) {
    return new Date(dateStr + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long' });
  }

  /**
   * Compute the forced exit UTC timestamp for tonight's overnight trade.
   *
   * @param {number} entryTimestamp - Entry timestamp in ms
   * @returns {number} Exit timestamp in ms (UTC)
   */
  computeForceExitTime(entryTimestamp) {
    const exitHour = this.params.exitHourET;
    const exitHourInt = Math.floor(exitHour);
    const exitMinInt = Math.round((exitHour - exitHourInt) * 60);

    // Get the EST date of entry
    const estDateStr = this.getESTDateStr(entryTimestamp);

    // Exit is next calendar day (overnight hold)
    const exitDate = new Date(estDateStr + 'T00:00:00');
    exitDate.setDate(exitDate.getDate() + 1);
    const exitDateStr = exitDate.toISOString().split('T')[0];

    // Construct exit time in ET (EDT = UTC-4, EST = UTC-5)
    // Use America/New_York to handle DST automatically
    // We'll approximate: create a date at the exit time and convert
    const exitStr = `${exitDateStr}T${String(exitHourInt).padStart(2, '0')}:${String(exitMinInt).padStart(2, '0')}:00`;

    // Parse as ET — use a hack: create date and adjust for ET offset
    const exitUTC = new Date(exitStr + '-05:00'); // EST (will be close enough; DST diff is 1hr)

    return exitUTC.getTime();
  }

  /**
   * Main signal evaluation — called on each candle by the backtest engine.
   */
  evaluateSignal(candle, prevCandle, marketData, options = {}) {
    if (!this._charmVannaLoader) return null;

    const timestamp = candle.timestamp;
    const estHour = this.getESTHour(timestamp);
    const estDateStr = this.getESTDateStr(timestamp);

    // Only generate signal at the entry hour (15m candle containing entry time)
    // Entry at 4pm ET = estHour between 15.75 and 16.25 (allowing 15m window)
    const entryHour = this.params.entryHourET;
    if (estHour < entryHour - 0.25 || estHour > entryHour + 0.25) {
      return null;
    }

    // One signal per day
    if (this._lastSignalDate === estDateStr) {
      return null;
    }

    // Cooldown check
    if (!this.checkCooldown(timestamp, this.params.signalCooldownMs)) {
      return null;
    }

    // Get today's charm/vanna data
    const cvData = this._charmVannaLoader.getDataForDate(timestamp);
    if (!cvData) return null;

    const netCex = cvData.netCex;
    const netVex = cvData.netVex;

    // Determine direction
    // Positive CEX → dealers need to buy → go long
    // Negative CEX → dealers need to sell → go short
    if (netCex === 0 || isNaN(netCex)) return null;
    const isLong = netCex > 0;
    const side = isLong ? 'buy' : 'sell';

    // --- Filters ---

    // CEX magnitude (percentile threshold)
    const cexPercentile = this.getCexPercentile(netCex);
    if (cexPercentile < this.params.minCexPercentile) {
      return null;
    }

    // Absolute CEX minimum
    if (this.params.minCexAbsolute > 0 && Math.abs(netCex) < this.params.minCexAbsolute) {
      return null;
    }

    // VEX confirmation: CEX and VEX should agree on direction
    if (this.params.requireVexConfirmation) {
      if ((netCex > 0 && netVex < 0) || (netCex < 0 && netVex > 0)) {
        return null;
      }
    }

    // VIX filter
    if (this.params.useVixFilter && cvData.vixClose != null) {
      if (cvData.vixClose > this.params.maxVix || cvData.vixClose < this.params.minVix) {
        return null;
      }
    }

    // Day filter
    if (this.params.useDayFilter && this.params.blockedDays.length > 0) {
      const dayOfWeek = this.getDayOfWeek(estDateStr);
      if (this.params.blockedDays.includes(dayOfWeek)) {
        return null;
      }
    }

    // --- Generate signal ---
    this._lastSignalDate = estDateStr;
    this.updateLastSignalTime(timestamp);

    const entryPrice = candle.close;
    const stopLoss = isLong
      ? roundTo(entryPrice - this.params.stopLossPoints)
      : roundTo(entryPrice + this.params.stopLossPoints);
    const takeProfit = isLong
      ? roundTo(entryPrice + this.params.takeProfitPoints)
      : roundTo(entryPrice - this.params.takeProfitPoints);

    // Compute forced exit time (e.g., 9:30 AM ET next day)
    const forceExitTimeUTC = this.computeForceExitTime(timestamp);

    return {
      strategy: 'OVERNIGHT_CHARM_VANNA',
      action: 'place_market',
      side: side,
      symbol: this.params.tradingSymbol,
      price: roundTo(entryPrice),
      stop_loss: stopLoss,
      take_profit: takeProfit,
      quantity: this.params.defaultQuantity,
      forceExitTimeUTC: forceExitTimeUTC,
      maxHoldBars: this.params.maxHoldBars || 0,
      timestamp: new Date(timestamp).toISOString(),
      metadata: {
        net_cex: roundTo(netCex, 0),
        net_vex: roundTo(netVex, 0),
        cex_percentile: roundTo(cexPercentile, 1),
        cex_direction: isLong ? 'positive' : 'negative',
        vix_close: cvData.vixClose,
        spy_spot: cvData.spySpot,
        es_spot: cvData.esSpot,
        multiplier: cvData.multiplier,
        regime: cvData.regime,
        short_term_cex: roundTo(cvData.shortTermCex, 0),
        medium_term_cex: roundTo(cvData.mediumTermCex, 0),
        long_term_cex: roundTo(cvData.longTermCex, 0),
        entry_date: estDateStr,
        entry_reason: `CEX ${isLong ? '+' : '-'} @ P${cexPercentile.toFixed(0)} (${side} ES overnight)`,
        force_exit_time: new Date(forceExitTimeUTC).toISOString(),
        target_points: this.params.takeProfitPoints,
        stop_points: this.params.stopLossPoints,
      }
    };
  }

  /**
   * Reset strategy state for a new backtest run
   */
  reset() {
    super.reset();
    this._lastSignalDate = null;
  }

  getName() {
    return 'OVERNIGHT_CHARM_VANNA';
  }

  getDescription() {
    return 'Overnight ES charm/vanna dealer hedging flow strategy';
  }

  getRequiredMarketData() {
    return ['charmVannaData'];
  }

  validateParams(params) {
    const errors = [];
    if (params.stopLossPoints <= 0) errors.push('stopLossPoints must be > 0');
    if (params.takeProfitPoints <= 0) errors.push('takeProfitPoints must be > 0');
    if (params.minCexPercentile < 0 || params.minCexPercentile > 100) {
      errors.push('minCexPercentile must be between 0 and 100');
    }
    return { valid: errors.length === 0, errors };
  }
}
