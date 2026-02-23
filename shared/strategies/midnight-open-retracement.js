/**
 * Midnight Open Retracement Strategy
 *
 * Based on the ICT concept that the midnight (12:00 AM ET) candle open
 * serves as a key reference level. When RTH opens on the opposite side
 * of this level, price tends to retrace back toward it.
 *
 * Source: Edgeful.com statistical analysis (Jul 2024 - Jan 2025)
 *
 * Rules:
 * - Reference level = 12:00 AM ET candle open price
 * - If RTH open (9:30 AM ET) is BELOW midnight open → LONG targeting midnight open
 * - If RTH open (9:30 AM ET) is ABOVE midnight open → SHORT targeting midnight open
 * - Day-of-week filters (Tuesday best for NQ, Thursday best for ES)
 * - Minimum gap between midnight open and RTH open to filter noise
 *
 * Claimed results:
 * - ES longs (open below midnight): 69% win rate
 * - NQ longs (open below midnight): 63% win rate
 * - NQ Tuesday longs: 73% win rate
 * - Shorts generally weaker (<60%), optional
 */

import { BaseStrategy } from './base-strategy.js';
import { isValidCandle, roundTo } from './strategy-utils.js';

export class MidnightOpenRetracementStrategy extends BaseStrategy {
  static getDataRequirements() {
    return {
      candles: true,
      gex: false,
      lt: false,
      tradier: false,
      ivSkew: false
    };
  }

  constructor(params = {}) {
    super(params);

    this.defaultParams = {
      // Direction filters
      allowLongs: true,
      allowShorts: false,  // Shorts are weaker statistically, off by default

      // Minimum gap between midnight open and RTH open (points)
      // Filters out noise when price is right at the level
      minGapPoints: 5,

      // Maximum gap - if too far, target is unrealistic
      maxGapPoints: 100,

      // Stop loss: points beyond RTH open (opposite direction of trade)
      stopLossPoints: 30,

      // Alternatively, use a multiple of the gap as stop
      useGapMultipleStop: true,
      gapMultipleStop: 1.5,  // Stop = 1.5x the gap distance beyond entry

      // Max stop loss regardless of gap multiple
      maxStopLossPoints: 50,

      // Take profit: midnight open price (the gap fill)
      // Can also target a partial fill
      targetFillPercent: 1.0,  // 1.0 = full fill to midnight open, 0.8 = 80%

      // Trailing stop after partial fill
      useTrailingAfterPartialFill: false,
      trailingTriggerPercent: 0.5,  // Start trailing after 50% of gap filled
      trailingOffsetPoints: 10,

      // Time-based exit: force close at end of RTH if not hit
      maxHoldBars: 390,  // ~6.5 hours of 1-min bars (9:30 to 4:00)
      forceCloseTime: 16,  // 4:00 PM ET hour

      // Day of week filter (0=Sunday, 1=Monday, ... 6=Saturday)
      // Based on Edgeful stats: Tuesday best for NQ, Thursday for ES
      useDayOfWeekFilter: false,
      allowedDays: [1, 2, 3, 4, 5],  // Mon-Fri by default

      // Preferred days get larger position size (optional)
      preferredDays: [],  // e.g., [2] for Tuesday
      preferredDayMultiplier: 1,  // No position scaling by default

      // Signal management
      signalCooldownMs: 12 * 60 * 60 * 1000,  // 12 hours (one signal per day)

      // Symbol configuration
      tradingSymbol: 'NQ1!',
      defaultQuantity: 1,

      // Session filter - only trigger during RTH open window
      entryWindowStartHour: 9,
      entryWindowStartMinute: 30,
      entryWindowEndHour: 10,  // Must enter within first 30 min of RTH
      entryWindowEndMinute: 0,

      debug: false
    };

    this.params = { ...this.defaultParams, ...params };

    // State tracking
    this.midnightOpen = null;
    this.midnightOpenDate = null;  // Track which date's midnight open we have
    this.rthOpen = null;
    this.rthOpenDate = null;
    this.signalFiredToday = false;
    this.currentTradingDate = null;
  }

  /**
   * Get Eastern Time components from a timestamp
   */
  getETTime(timestamp) {
    const date = new Date(typeof timestamp === 'number' ? timestamp : new Date(timestamp).getTime());
    const estString = date.toLocaleString('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
    // Parse "MM/DD/YYYY, HH:MM"
    const [datePart, timePart] = estString.split(', ');
    const [month, day, year] = datePart.split('/');
    const [hour, minute] = timePart.split(':');
    return {
      year: parseInt(year),
      month: parseInt(month),
      day: parseInt(day),
      hour: parseInt(hour),
      minute: parseInt(minute),
      dateKey: `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`,
      dayOfWeek: new Date(parseInt(year), parseInt(month) - 1, parseInt(day)).getDay()
    };
  }

  /**
   * Get the trading date key. Midnight belongs to the NEXT trading day.
   * e.g., midnight at 00:00 Tuesday → trading date is Tuesday
   */
  getTradingDateKey(etTime) {
    // If hour < 18 (before 6 PM), it's today's trading date
    // If hour >= 18, it's the next trading day
    if (etTime.hour >= 18) {
      // This is the evening session for the NEXT day
      const nextDay = new Date(etTime.year, etTime.month - 1, etTime.day + 1);
      return `${nextDay.getFullYear()}-${String(nextDay.getMonth() + 1).padStart(2, '0')}-${String(nextDay.getDate()).padStart(2, '0')}`;
    }
    return etTime.dateKey;
  }

  evaluateSignal(candle, prevCandle, marketData, options = {}) {
    if (!isValidCandle(candle)) return null;

    const timestamp = this.toMs(candle.timestamp);
    const et = this.getETTime(timestamp);
    const tradingDate = this.getTradingDateKey(et);

    // Reset daily state on new trading date
    if (tradingDate !== this.currentTradingDate) {
      this.currentTradingDate = tradingDate;
      this.signalFiredToday = false;
      this.rthOpen = null;
      this.rthOpenDate = null;
    }

    // Capture midnight open (12:00 AM ET)
    if (et.hour === 0 && et.minute === 0) {
      this.midnightOpen = candle.open;
      this.midnightOpenDate = tradingDate;
      if (this.params.debug) {
        console.log(`[MIDNIGHT] Captured midnight open: ${this.midnightOpen.toFixed(2)} for ${tradingDate}`);
      }
    }

    // Capture RTH open (9:30 AM ET)
    if (et.hour === 9 && et.minute === 30) {
      this.rthOpen = candle.open;
      this.rthOpenDate = tradingDate;
      if (this.params.debug) {
        console.log(`[MIDNIGHT] RTH open: ${this.rthOpen.toFixed(2)} | Midnight: ${this.midnightOpen?.toFixed(2) ?? 'N/A'} for ${tradingDate}`);
      }
    }

    // Only evaluate during entry window
    if (!this.isInEntryWindow(et)) return null;

    // Need both reference levels for the same trading date
    if (!this.midnightOpen || !this.rthOpen) return null;
    if (this.midnightOpenDate !== tradingDate || this.rthOpenDate !== tradingDate) return null;

    // Only one signal per day
    if (this.signalFiredToday) return null;

    // Cooldown check
    if (!this.checkCooldown(timestamp, this.params.signalCooldownMs)) return null;

    // Day of week filter
    if (this.params.useDayOfWeekFilter) {
      if (!this.params.allowedDays.includes(et.dayOfWeek)) {
        if (this.params.debug) {
          console.log(`[MIDNIGHT] Skipping day ${et.dayOfWeek} (not in allowed days)`);
        }
        return null;
      }
    }

    // Calculate gap
    const gap = this.rthOpen - this.midnightOpen;  // Positive = RTH opened above midnight
    const gapAbs = Math.abs(gap);

    // Filter by gap size
    if (gapAbs < this.params.minGapPoints) {
      if (this.params.debug) {
        console.log(`[MIDNIGHT] Gap too small: ${gapAbs.toFixed(1)} pts (min: ${this.params.minGapPoints})`);
      }
      return null;
    }
    if (gapAbs > this.params.maxGapPoints) {
      if (this.params.debug) {
        console.log(`[MIDNIGHT] Gap too large: ${gapAbs.toFixed(1)} pts (max: ${this.params.maxGapPoints})`);
      }
      return null;
    }

    const price = candle.close;
    let signal = null;

    // LONG: RTH opened below midnight open → expect retracement up to midnight
    if (gap < 0 && this.params.allowLongs) {
      const targetPrice = this.midnightOpen - (gapAbs * (1 - this.params.targetFillPercent));
      const stopDistance = this.params.useGapMultipleStop
        ? Math.min(gapAbs * this.params.gapMultipleStop, this.params.maxStopLossPoints)
        : this.params.stopLossPoints;
      const stopPrice = price - stopDistance;

      signal = {
        strategy: 'MIDNIGHT_OPEN_RETRACEMENT',
        side: 'buy',
        action: 'place_market',
        symbol: this.params.tradingSymbol,
        price: roundTo(price),
        stop_loss: roundTo(stopPrice),
        take_profit: roundTo(targetPrice),
        trailing_trigger: null,
        trailing_offset: null,
        quantity: this.getQuantity(et),
        maxHoldBars: this.params.maxHoldBars,
        timestamp: new Date(timestamp).toISOString(),
        metadata: {
          strategy: 'MIDNIGHT_OPEN_RETRACEMENT',
          direction: 'long',
          midnight_open: roundTo(this.midnightOpen),
          rth_open: roundTo(this.rthOpen),
          gap_points: roundTo(gap),
          gap_abs: roundTo(gapAbs),
          stop_distance: roundTo(stopDistance),
          target_distance: roundTo(targetPrice - price),
          rr_ratio: roundTo((targetPrice - price) / stopDistance),
          day_of_week: et.dayOfWeek,
          day_name: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][et.dayOfWeek],
          trading_date: tradingDate
        }
      };
    }

    // SHORT: RTH opened above midnight open → expect retracement down to midnight
    if (gap > 0 && this.params.allowShorts) {
      const targetPrice = this.midnightOpen + (gapAbs * (1 - this.params.targetFillPercent));
      const stopDistance = this.params.useGapMultipleStop
        ? Math.min(gapAbs * this.params.gapMultipleStop, this.params.maxStopLossPoints)
        : this.params.stopLossPoints;
      const stopPrice = price + stopDistance;

      signal = {
        strategy: 'MIDNIGHT_OPEN_RETRACEMENT',
        side: 'sell',
        action: 'place_market',
        symbol: this.params.tradingSymbol,
        price: roundTo(price),
        stop_loss: roundTo(stopPrice),
        take_profit: roundTo(targetPrice),
        trailing_trigger: null,
        trailing_offset: null,
        quantity: this.getQuantity(et),
        maxHoldBars: this.params.maxHoldBars,
        timestamp: new Date(timestamp).toISOString(),
        metadata: {
          strategy: 'MIDNIGHT_OPEN_RETRACEMENT',
          direction: 'short',
          midnight_open: roundTo(this.midnightOpen),
          rth_open: roundTo(this.rthOpen),
          gap_points: roundTo(gap),
          gap_abs: roundTo(gapAbs),
          stop_distance: roundTo(stopDistance),
          target_distance: roundTo(price - targetPrice),
          rr_ratio: roundTo((price - targetPrice) / stopDistance),
          day_of_week: et.dayOfWeek,
          day_name: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][et.dayOfWeek],
          trading_date: tradingDate
        }
      };
    }

    if (signal) {
      this.signalFiredToday = true;
      this.updateLastSignalTime(timestamp);

      if (this.params.debug) {
        const m = signal.metadata;
        console.log(`[MIDNIGHT] ${m.direction.toUpperCase()} signal: entry=${signal.price}, stop=${signal.stop_loss}, target=${signal.take_profit}, gap=${m.gap_points}pts, R:R=${m.rr_ratio}, ${m.day_name}`);
      }
    }

    return signal;
  }

  /**
   * Check if we're in the entry window (first 30 min of RTH by default)
   */
  isInEntryWindow(et) {
    const currentMinutes = et.hour * 60 + et.minute;
    const startMinutes = this.params.entryWindowStartHour * 60 + this.params.entryWindowStartMinute;
    const endMinutes = this.params.entryWindowEndHour * 60 + this.params.entryWindowEndMinute;
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  }

  /**
   * Get quantity, potentially scaled for preferred days
   */
  getQuantity(et) {
    if (this.params.preferredDays.includes(et.dayOfWeek)) {
      return this.params.defaultQuantity * this.params.preferredDayMultiplier;
    }
    return this.params.defaultQuantity;
  }

  reset() {
    super.reset();
    this.midnightOpen = null;
    this.midnightOpenDate = null;
    this.rthOpen = null;
    this.rthOpenDate = null;
    this.signalFiredToday = false;
    this.currentTradingDate = null;
  }

  getName() { return 'MIDNIGHT_OPEN_RETRACEMENT'; }
  getDescription() { return 'ICT Midnight Open Retracement - trades toward midnight open when RTH opens on opposite side'; }
  getRequiredMarketData() { return []; }
}

export default MidnightOpenRetracementStrategy;
