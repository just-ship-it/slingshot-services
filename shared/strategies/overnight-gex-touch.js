/**
 * Overnight GEX First-Touch Strategy
 *
 * Trades first touches of GEX support/resistance levels during the overnight session.
 * Based on analysis showing 94-100% bounce rates on first touches, with 76-83% win rates
 * using tight 10pt stop/10pt target.
 *
 * Key mechanics:
 * - Support levels (S1, S2) → LONG on first touch
 * - Resistance levels (R1, R2) → SHORT on first touch
 * - Only first touch per level per overnight session (absorption effect reduces subsequent touches)
 * - Entry: limit order at GEX level price, filled via 1-second resolution on touch candle
 * - Configurable stop/target (optimal: SL=10, TP=10)
 *
 * Execution model:
 * - Strategy evaluates on 1m candles (higher timeframe confirmation)
 * - When a candle's range includes a GEX level → signal generated
 * - Engine replays 1-second data within that candle to find exact fill moment
 * - Exit monitoring continues at 1-second resolution
 *
 * Filters:
 * - Session: overnight only (6PM-8:30AM EST), with sub-session windows
 * - LT Sentiment: Bearish LT shows 80%+ win rate vs 73% for Bullish
 * - Day of week: Removing Monday/Sunday improves win rate by ~3-6%
 * - GEX regime: Both positive and negative work well
 */

import { BaseStrategy } from './base-strategy.js';
import { isValidCandle, roundTo } from './strategy-utils.js';

export class OvernightGexTouchStrategy extends BaseStrategy {
  constructor(params = {}) {
    super(params);

    this.defaultParams = {
      // Entry/Exit
      stopLossPoints: 10,
      takeProfitPoints: 10,

      // Trade levels
      tradeLevels: ['S1', 'S2', 'R1', 'R2'],

      // Session
      useSessionFilter: true,
      allowedSessions: ['overnight', 'premarket'],  // Overnight = 6PM-4AM, Premarket = 4AM-9:30AM
      sessionEndHour: 8.5,       // 8:30 AM EST — don't open new trades after this
      maxHoldBars: 60,           // Force exit after 60 1m bars (1 hour safety net)
      signalCooldownMs: 60000,   // 1 minute between signals

      // Filters
      useLTFilter: false,         // Filter by LT sentiment
      requiredLTSentiment: null,  // 'BEARISH', 'BULLISH', or null for no filter
      useDayFilter: false,        // Filter by day of week
      blockedDays: [],            // e.g., ['Monday', 'Sunday']
      useRegimeFilter: false,     // Filter by GEX regime
      allowedRegimes: null,       // e.g., ['positive', 'negative'] or null for all

      // Symbol
      tradingSymbol: 'NQ1!',
      defaultQuantity: 1,
    };

    this.params = { ...this.defaultParams, ...params };

    // Overnight session tracking state
    this._currentSessionDate = null;  // The RTH date this overnight belongs to
    this._touchedLevels = new Set();  // Which GEX levels have been touched this session
    this._sessionGexLevels = null;    // GEX levels for this session (from EOD)
    this._lastLTSentiment = null;     // LT sentiment at session start
  }

  /**
   * Get trading session from timestamp (EST-aware)
   */
  getSession(timestamp) {
    const date = new Date(timestamp);
    const estString = date.toLocaleString('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      minute: 'numeric',
      hour12: false
    });

    const [hourStr, minStr] = estString.split(':');
    const hour = parseInt(hourStr);
    const min = parseInt(minStr);
    const timeDecimal = hour + min / 60;

    if (timeDecimal >= 18 || timeDecimal < 4) return 'overnight';
    if (timeDecimal >= 4 && timeDecimal < 9.5) return 'premarket';
    if (timeDecimal >= 9.5 && timeDecimal < 16) return 'rth';
    return 'afterhours';
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
   * Get the overnight session date (the RTH date this overnight precedes)
   * Overnight 6PM Monday → belongs to Tuesday's trading date
   */
  getOvernightDate(timestamp) {
    const date = new Date(timestamp);

    // Extract EST/EDT date components directly to avoid UTC conversion issues
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);

    let year, month, day;
    for (const p of parts) {
      if (p.type === 'year') year = parseInt(p.value);
      if (p.type === 'month') month = parseInt(p.value);
      if (p.type === 'day') day = parseInt(p.value);
    }

    const estHour = this.getESTHour(timestamp);

    if (estHour >= 18) {
      // After 6PM: this belongs to tomorrow's trading date
      const d = new Date(year, month - 1, day + 1);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    } else {
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  /**
   * Get day of week for a date string
   */
  getDayOfWeek(dateStr) {
    return new Date(dateStr + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long' });
  }

  /**
   * Check if current session is allowed
   */
  isAllowedSession(timestamp) {
    if (!this.params.useSessionFilter) return true;
    const session = this.getSession(timestamp);
    return this.params.allowedSessions.includes(session);
  }

  /**
   * Extract GEX levels from market data into named levels (S1, S2, R1, R2, etc.)
   */
  extractGexLevels(gexLevels) {
    if (!gexLevels) return null;

    const levels = {};

    // Support levels (put walls)
    if (gexLevels.support && gexLevels.support.length > 0) {
      gexLevels.support.forEach((price, i) => {
        levels[`S${i + 1}`] = { price, type: 'support' };
      });
    } else {
      // Fallback to CSV format
      if (gexLevels.nq_put_wall_1) levels.S1 = { price: gexLevels.nq_put_wall_1, type: 'support' };
      if (gexLevels.nq_put_wall_2) levels.S2 = { price: gexLevels.nq_put_wall_2, type: 'support' };
      if (gexLevels.nq_put_wall_3) levels.S3 = { price: gexLevels.nq_put_wall_3, type: 'support' };
    }

    // Resistance levels (call walls)
    if (gexLevels.resistance && gexLevels.resistance.length > 0) {
      gexLevels.resistance.forEach((price, i) => {
        levels[`R${i + 1}`] = { price, type: 'resistance' };
      });
    } else {
      if (gexLevels.nq_call_wall_1) levels.R1 = { price: gexLevels.nq_call_wall_1, type: 'resistance' };
      if (gexLevels.nq_call_wall_2) levels.R2 = { price: gexLevels.nq_call_wall_2, type: 'resistance' };
      if (gexLevels.nq_call_wall_3) levels.R3 = { price: gexLevels.nq_call_wall_3, type: 'resistance' };
    }

    return levels;
  }

  /**
   * Main signal evaluation — called on each candle by the backtest engine.
   *
   * Touch-detection model: detects when this candle's range includes a GEX level
   * (first touch of the session). The engine then replays 1-second data within
   * this candle to find the exact fill moment for the limit order at the level price.
   */
  evaluateSignal(candle, prevCandle, marketData, options = {}) {
    if (!isValidCandle(candle) || !isValidCandle(prevCandle)) {
      return null;
    }

    const timestamp = candle.timestamp;
    const estHour = this.getESTHour(timestamp);

    // --- Session check ---
    if (!this.isAllowedSession(timestamp)) {
      // If we're in RTH or afterhours, reset session state for next overnight
      if (this.getSession(timestamp) === 'rth' || this.getSession(timestamp) === 'afterhours') {
        this._currentSessionDate = null;
        this._touchedLevels.clear();
        this._sessionGexLevels = null;
        this._lastLTSentiment = null;
      }
      return null;
    }

    // Don't open new trades after the session end cutoff (default 8:30 AM EST)
    if (estHour >= this.params.sessionEndHour && estHour < 18) {
      return null;
    }

    // --- Session state management ---
    const overnightDate = this.getOvernightDate(timestamp);

    if (overnightDate !== this._currentSessionDate) {
      // New overnight session — reset state
      this._currentSessionDate = overnightDate;
      this._touchedLevels.clear();
      this._sessionGexLevels = null;
      this._lastLTSentiment = null;
    }

    // --- Load GEX levels for this session ---
    const { gexLevels, ltLevels } = marketData || {};

    if (gexLevels) {
      // Cache GEX levels for the session (they come from EOD data)
      if (!this._sessionGexLevels) {
        this._sessionGexLevels = this.extractGexLevels(gexLevels);
      }
    }

    if (!this._sessionGexLevels) {
      return null; // No GEX data available
    }

    // Cache LT sentiment at session start
    if (ltLevels && !this._lastLTSentiment) {
      this._lastLTSentiment = ltLevels.sentiment || null;
    }

    // --- Detect first touches on this candle ---
    // A "touch" means the level price is within the candle's [low, high] range.
    // Mark ALL touched levels (even if we can't trade them due to filters/position),
    // then generate a signal for the first tradeable one.
    const newTouches = [];
    for (const levelName of this.params.tradeLevels) {
      const levelInfo = this._sessionGexLevels[levelName];
      if (!levelInfo || this._touchedLevels.has(levelName)) continue;

      const levelPrice = levelInfo.price;

      // Level price must be within candle's range (exact touch required)
      if (candle.low <= levelPrice && candle.high >= levelPrice) {
        this._touchedLevels.add(levelName);
        newTouches.push({ name: levelName, price: levelPrice, type: levelInfo.type });
      }
    }

    if (newTouches.length === 0) return null;

    // --- Apply filters ---

    // LT Sentiment filter
    if (this.params.useLTFilter && this.params.requiredLTSentiment) {
      if (this._lastLTSentiment !== this.params.requiredLTSentiment) {
        return null;
      }
    }

    // Day of week filter
    if (this.params.useDayFilter && this.params.blockedDays.length > 0) {
      const dayOfWeek = this.getDayOfWeek(this._currentSessionDate);
      if (this.params.blockedDays.includes(dayOfWeek)) {
        return null;
      }
    }

    // GEX regime filter
    if (this.params.useRegimeFilter && this.params.allowedRegimes) {
      const regime = gexLevels?.regime || 'unknown';
      if (!this.params.allowedRegimes.includes(regime)) {
        return null;
      }
    }

    // --- Cooldown check ---
    if (!this.checkCooldown(timestamp, this.params.signalCooldownMs)) {
      return null;
    }

    // --- Generate signal for the first new touch ---
    const touch = newTouches[0];
    const isLong = touch.type === 'support';
    const side = isLong ? 'buy' : 'sell';
    const levelPrice = touch.price;

    const stopLoss = isLong
      ? roundTo(levelPrice - this.params.stopLossPoints)
      : roundTo(levelPrice + this.params.stopLossPoints);

    const takeProfit = isLong
      ? roundTo(levelPrice + this.params.takeProfitPoints)
      : roundTo(levelPrice - this.params.takeProfitPoints);

    this.updateLastSignalTime(timestamp);

    const session = this.getSession(timestamp);

    return {
      strategy: 'OVERNIGHT_GEX_TOUCH',
      action: 'place_limit',
      side: side,
      symbol: this.params.tradingSymbol,
      price: roundTo(levelPrice),
      stop_loss: stopLoss,
      take_profit: takeProfit,
      quantity: this.params.defaultQuantity,
      maxHoldBars: this.params.maxHoldBars,
      sameCandleFill: true,  // Engine replays 1s data within this candle for fill
      timeoutCandles: 1,     // Safety: cancel if not filled (should be handled by engine)
      timestamp: new Date(timestamp).toISOString(),
      metadata: {
        gex_level: roundTo(levelPrice),
        gex_level_name: touch.name,
        gex_level_type: touch.type,
        entry_reason: `First touch ${touch.name} (${touch.type}) @ ${levelPrice.toFixed(2)}`,
        overnight_date: this._currentSessionDate,
        session: session,
        lt_sentiment: this._lastLTSentiment,
        gex_regime: gexLevels?.regime || 'unknown',
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
    this._currentSessionDate = null;
    this._touchedLevels = new Set();
    this._sessionGexLevels = null;
    this._lastLTSentiment = null;
  }

  getName() {
    return 'OVERNIGHT_GEX_TOUCH';
  }

  getDescription() {
    return 'Overnight GEX level first-touch bounce strategy';
  }

  getRequiredMarketData() {
    return ['gexLevels'];
  }

  validateParams(params) {
    const errors = [];
    if (params.stopLossPoints <= 0) errors.push('stopLossPoints must be > 0');
    if (params.takeProfitPoints <= 0) errors.push('takeProfitPoints must be > 0');
    return { valid: errors.length === 0, errors };
  }
}
