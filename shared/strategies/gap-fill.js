/**
 * Gap Fill Strategy
 *
 * Trades the tendency for overnight gaps to fill back to the previous
 * session's close price. Gaps are measured as the difference between
 * the RTH open and the previous session close.
 *
 * Sources: Edgeful.com, QuantifiedStrategies, Trade That Swing
 *
 * Rules:
 * - Gap = RTH open (9:30 AM ET) vs previous RTH close (4:00 PM ET)
 * - Gap Up: Enter short targeting previous close (PSC)
 * - Gap Down: Enter long targeting previous close (PSC)
 * - Entry: After 15-min opening range forms, enter on break toward fill
 * - Stop: 75% of opening range on opposite side
 * - Target: Previous session close (gap fill level)
 * - Day-of-week filters (Wed best for NQ gap-downs, Mon worst)
 *
 * Statistics (Edgeful):
 * - ES gap-ups fill: 59%, gap-downs fill: 66%
 * - NQ Wed gap-downs fill: 77%
 * - NQ Mon gap-downs fill: 30% (avoid)
 * - Small gaps (0.0-0.19%) fill: 89-93%
 */

import { BaseStrategy } from './base-strategy.js';
import { isValidCandle, roundTo } from './strategy-utils.js';

export class GapFillStrategy extends BaseStrategy {
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
      // Gap thresholds (in points)
      minGapPoints: 5,       // Minimum gap to trade
      maxGapPoints: 120,     // Maximum gap (too large = risky)

      // Opening range configuration
      orMinutes: 15,         // Opening range period (minutes after RTH open)

      // Stop loss: percentage of the opening range
      stopORPercent: 0.75,

      // Maximum stop loss in points (override if OR is very wide)
      maxStopPoints: 40,

      // Target: gap fill percentage (1.0 = full fill to PSC)
      fillTargetPercent: 1.0,

      // Direction filters
      allowLongGapDown: true,   // Go long when gap down (fill up)
      allowShortGapUp: true,    // Go short when gap up (fill down)

      // Day of week filters
      useDayOfWeekFilter: false,
      // Days to SKIP for gap-down longs (0=Sun..6=Sat)
      skipGapDownDays: [1],     // Monday gap-downs have 30% fill (Edgeful)
      // Days to prefer for gap-down longs
      preferGapDownDays: [3],   // Wednesday gap-downs have 77% fill (Edgeful)

      // One trade per day
      maxTradesPerDay: 1,

      // Entry method
      // 'or_breakout': Enter on opening range breakout toward fill direction
      // 'immediate': Enter at OR close (after OR forms)
      entryMethod: 'or_breakout',

      // Max hold time
      maxHoldBars: 360,  // ~6 hours

      // No entries after this time
      entryWindowEndHour: 12,
      entryWindowEndMinute: 0,

      // Signal management
      signalCooldownMs: 12 * 60 * 60 * 1000,

      // Symbol
      tradingSymbol: 'NQ1!',
      defaultQuantity: 1,

      debug: false
    };

    this.params = { ...this.defaultParams, ...params };

    // State tracking
    this.previousClose = null;
    this.previousCloseDate = null;
    this.rthOpen = null;
    this.rthOpenDate = null;
    this.orHigh = null;
    this.orLow = null;
    this.orComplete = false;
    this.orCandleCount = 0;
    this.gapDirection = null;  // 'up' or 'down'
    this.gapSize = null;
    this.signalFiredToday = false;
    this.currentTradingDate = null;

    // Track previous session close
    this.lastRTHClose = null;
    this.lastRTHCloseDate = null;
  }

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

  evaluateSignal(candle, prevCandle, marketData, options = {}) {
    if (!isValidCandle(candle)) return null;

    const timestamp = this.toMs(candle.timestamp);
    const et = this.getETTime(timestamp);

    // Track previous RTH close (3:59 or 4:00 PM ET candle close)
    if (et.hour === 15 && et.minute === 59) {
      this.lastRTHClose = candle.close;
      this.lastRTHCloseDate = et.dateKey;
    }

    // Reset state on new trading date
    if (et.dateKey !== this.currentTradingDate) {
      this.currentTradingDate = et.dateKey;

      // Carry over previous close
      if (this.lastRTHClose !== null && this.lastRTHCloseDate !== et.dateKey) {
        this.previousClose = this.lastRTHClose;
        this.previousCloseDate = this.lastRTHCloseDate;
      }

      this.rthOpen = null;
      this.rthOpenDate = null;
      this.orHigh = null;
      this.orLow = null;
      this.orComplete = false;
      this.orCandleCount = 0;
      this.gapDirection = null;
      this.gapSize = null;
      this.signalFiredToday = false;
    }

    // Capture RTH open
    if (et.hour === 9 && et.minute === 30 && !this.rthOpen) {
      this.rthOpen = candle.open;
      this.rthOpenDate = et.dateKey;

      // Calculate gap
      if (this.previousClose) {
        this.gapSize = this.rthOpen - this.previousClose;
        this.gapDirection = this.gapSize > 0 ? 'up' : 'down';

        if (this.params.debug) {
          console.log(`[GAP] ${et.dateKey} RTH Open: ${this.rthOpen.toFixed(2)}, PSC: ${this.previousClose.toFixed(2)}, Gap: ${this.gapSize.toFixed(1)}pts ${this.gapDirection}`);
        }
      }
    }

    // Build opening range (first N minutes of RTH)
    const minutesSinceOpen = (et.hour - 9) * 60 + (et.minute - 30);
    if (minutesSinceOpen >= 0 && minutesSinceOpen < this.params.orMinutes) {
      if (this.orHigh === null) {
        this.orHigh = candle.high;
        this.orLow = candle.low;
      } else {
        this.orHigh = Math.max(this.orHigh, candle.high);
        this.orLow = Math.min(this.orLow, candle.low);
      }
      this.orCandleCount++;
      return null;
    }

    // Mark OR complete
    if (!this.orComplete && this.orHigh !== null) {
      this.orComplete = true;
      if (this.params.debug && this.gapSize) {
        console.log(`[GAP] ${et.dateKey} OR Complete: High=${this.orHigh.toFixed(2)} Low=${this.orLow.toFixed(2)} Range=${(this.orHigh - this.orLow).toFixed(1)}pts`);
      }
    }

    // Skip if not ready
    if (!this.orComplete || !this.gapSize || this.signalFiredToday) return null;
    if (!this.checkCooldown(timestamp, this.params.signalCooldownMs)) return null;

    const gapAbs = Math.abs(this.gapSize);
    if (gapAbs < this.params.minGapPoints || gapAbs > this.params.maxGapPoints) return null;

    // Entry window check
    const currentMin = et.hour * 60 + et.minute;
    const endMin = this.params.entryWindowEndHour * 60 + this.params.entryWindowEndMinute;
    if (currentMin >= endMin) return null;

    const price = candle.close;
    const orRange = this.orHigh - this.orLow;
    if (orRange <= 0) return null;

    // GAP DOWN → LONG (expecting fill upward toward PSC)
    if (this.gapDirection === 'down' && this.params.allowLongGapDown) {
      // Day of week filter
      if (this.params.useDayOfWeekFilter && this.params.skipGapDownDays.includes(et.dayOfWeek)) {
        return null;
      }

      if (this.params.entryMethod === 'or_breakout') {
        // Enter on break above OR high (confirms fill direction)
        if (price > this.orHigh) {
          return this.createGapFillSignal('long', candle, et, price, orRange);
        }
      } else {
        // Immediate entry after OR
        return this.createGapFillSignal('long', candle, et, price, orRange);
      }
    }

    // GAP UP → SHORT (expecting fill downward toward PSC)
    if (this.gapDirection === 'up' && this.params.allowShortGapUp) {
      if (this.params.entryMethod === 'or_breakout') {
        // Enter on break below OR low (confirms fill direction)
        if (price < this.orLow) {
          return this.createGapFillSignal('short', candle, et, price, orRange);
        }
      } else {
        return this.createGapFillSignal('short', candle, et, price, orRange);
      }
    }

    return null;
  }

  createGapFillSignal(side, candle, et, entryPrice, orRange) {
    const timestamp = this.toMs(candle.timestamp);
    this.signalFiredToday = true;
    this.updateLastSignalTime(timestamp);

    const stopDistance = Math.min(orRange * this.params.stopORPercent, this.params.maxStopPoints);
    const gapAbs = Math.abs(this.gapSize);

    // Target: previous session close (or partial fill)
    const targetPrice = side === 'long'
      ? entryPrice + (gapAbs * this.params.fillTargetPercent)
      : entryPrice - (gapAbs * this.params.fillTargetPercent);

    // Adjust target to not exceed PSC
    const adjustedTarget = side === 'long'
      ? Math.min(targetPrice, this.previousClose)
      : Math.max(targetPrice, this.previousClose);

    const stopPrice = side === 'long'
      ? entryPrice - stopDistance
      : entryPrice + stopDistance;

    const targetDist = Math.abs(adjustedTarget - entryPrice);
    const rr = targetDist / stopDistance;

    if (this.params.debug) {
      console.log(`[GAP] ${et.dateKey} ${side.toUpperCase()} signal: entry=${entryPrice.toFixed(2)}, stop=${stopPrice.toFixed(2)} (${stopDistance.toFixed(1)}pts), target=${adjustedTarget.toFixed(2)} (${targetDist.toFixed(1)}pts), R:R=${rr.toFixed(2)}`);
    }

    return {
      strategy: 'GAP_FILL',
      side: side === 'long' ? 'buy' : 'sell',
      action: 'place_market',
      symbol: this.params.tradingSymbol,
      price: roundTo(entryPrice),
      stop_loss: roundTo(stopPrice),
      take_profit: roundTo(adjustedTarget),
      trailing_trigger: null,
      trailing_offset: null,
      quantity: this.params.defaultQuantity,
      maxHoldBars: this.params.maxHoldBars,
      timestamp: new Date(timestamp).toISOString(),
      metadata: {
        strategy: 'GAP_FILL',
        direction: side,
        gap_direction: this.gapDirection,
        gap_size: roundTo(this.gapSize),
        gap_abs: roundTo(Math.abs(this.gapSize)),
        previous_close: roundTo(this.previousClose),
        rth_open: roundTo(this.rthOpen),
        or_high: roundTo(this.orHigh),
        or_low: roundTo(this.orLow),
        or_range: roundTo(orRange),
        stop_distance: roundTo(stopDistance),
        target_distance: roundTo(targetDist),
        rr_ratio: roundTo(rr),
        entry_method: this.params.entryMethod,
        day_of_week: et.dayOfWeek,
        day_name: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][et.dayOfWeek],
        trading_date: et.dateKey
      }
    };
  }

  reset() {
    super.reset();
    this.previousClose = null;
    this.previousCloseDate = null;
    this.rthOpen = null;
    this.rthOpenDate = null;
    this.orHigh = null;
    this.orLow = null;
    this.orComplete = false;
    this.orCandleCount = 0;
    this.gapDirection = null;
    this.gapSize = null;
    this.signalFiredToday = false;
    this.currentTradingDate = null;
    this.lastRTHClose = null;
    this.lastRTHCloseDate = null;
  }

  getName() { return 'GAP_FILL'; }
  getDescription() { return 'Gap Fill - trades overnight gaps back to previous session close'; }
  getRequiredMarketData() { return []; }
}

export default GapFillStrategy;
