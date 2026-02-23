/**
 * Session Transition / Overnight Range Play Strategy
 *
 * Trades sweeps of the overnight (Asia/London) session range at the
 * New York open. When price sweeps the overnight high/low and reclaims,
 * it indicates a failed breakout and likely reversal.
 *
 * Sources: Steady Turtle Trading, ICT community
 *
 * Rules:
 * - Track overnight session range (6 PM - 9:30 AM ET)
 * - At NY open, watch for sweep of overnight high or low
 * - If price sweeps overnight low and reclaims → long
 * - If price sweeps overnight high and fails → short
 * - Target: 2R or opposite side of overnight range
 */

import { BaseStrategy } from './base-strategy.js';
import { isValidCandle, roundTo } from './strategy-utils.js';

export class SessionTransitionStrategy extends BaseStrategy {
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
      // Overnight session window (ET)
      overnightStartHour: 18,   // 6 PM ET previous day
      overnightEndHour: 9,
      overnightEndMinute: 30,

      // Sweep detection
      minSweepDepth: 3,
      maxSweepDepth: 30,

      // Reclaim detection
      maxCandlesToReclaim: 5,
      minReclaimBodyRatio: 0.4,

      // Risk management
      stopBeyondSweep: 3,
      maxStopPoints: 30,
      rewardRiskRatio: 2.0,

      // Alternative target: opposite side of overnight range
      useOvernightRangeTarget: false,

      // Direction
      allowLongs: true,
      allowShorts: true,

      // Entry window: first 90 minutes of RTH
      entryWindowStartHour: 9,
      entryWindowStartMinute: 30,
      entryWindowEndHour: 11,
      entryWindowEndMinute: 0,

      maxTradesPerDay: 1,
      maxHoldBars: 120,

      signalCooldownMs: 12 * 60 * 60 * 1000,

      tradingSymbol: 'NQ1!',
      defaultQuantity: 1,

      debug: false
    };

    this.params = { ...this.defaultParams, ...params };

    // State
    this.overnightHigh = null;
    this.overnightLow = null;
    this.overnightDate = null;
    this.currentTradingDate = null;
    this.signalFiredToday = false;
    this.lowSweepActive = false;
    this.highSweepActive = false;
    this.sweepExtremeLow = null;
    this.sweepExtremeHigh = null;
    this.candlesSinceSweep = 0;
    this.isOvernightSession = false;
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
    };
  }

  isOvernightPeriod(et) {
    const min = et.hour * 60 + et.minute;
    const start = this.params.overnightStartHour * 60;
    const end = this.params.overnightEndHour * 60 + this.params.overnightEndMinute;
    return min >= start || min < end;
  }

  isInEntryWindow(et) {
    const min = et.hour * 60 + et.minute;
    const start = this.params.entryWindowStartHour * 60 + this.params.entryWindowStartMinute;
    const end = this.params.entryWindowEndHour * 60 + this.params.entryWindowEndMinute;
    return min >= start && min < end;
  }

  /**
   * Get the trading date (overnight belongs to the next calendar date)
   */
  getTradingDate(et) {
    if (et.hour >= this.params.overnightStartHour) {
      const next = new Date(et.year, et.month - 1, et.day + 1);
      return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`;
    }
    return et.dateKey;
  }

  evaluateSignal(candle, prevCandle, marketData, options = {}) {
    if (!isValidCandle(candle)) return null;

    const timestamp = this.toMs(candle.timestamp);
    const et = this.getETTime(timestamp);
    const tradingDate = this.getTradingDate(et);

    // Phase 1: Build overnight range
    if (this.isOvernightPeriod(et)) {
      if (tradingDate !== this.overnightDate) {
        // New overnight session
        this.overnightHigh = candle.high;
        this.overnightLow = candle.low;
        this.overnightDate = tradingDate;
        this.signalFiredToday = false;
        this.lowSweepActive = false;
        this.highSweepActive = false;
      } else {
        this.overnightHigh = Math.max(this.overnightHigh, candle.high);
        this.overnightLow = Math.min(this.overnightLow, candle.low);
      }
      return null;
    }

    // Reset on new trading date
    if (tradingDate !== this.currentTradingDate) {
      this.currentTradingDate = tradingDate;
      this.signalFiredToday = false;
      this.lowSweepActive = false;
      this.highSweepActive = false;
    }

    // Need overnight range
    if (!this.overnightHigh || !this.overnightLow) return null;
    if (this.signalFiredToday) return null;
    if (!this.isInEntryWindow(et)) return null;
    if (!this.checkCooldown(timestamp, this.params.signalCooldownMs)) return null;

    const overnightRange = this.overnightHigh - this.overnightLow;
    if (overnightRange <= 0) return null;

    // === LOW SWEEP → LONG ===
    if (this.params.allowLongs && !this.lowSweepActive) {
      if (candle.low < this.overnightLow) {
        const depth = this.overnightLow - candle.low;
        if (depth >= this.params.minSweepDepth && depth <= this.params.maxSweepDepth) {
          this.lowSweepActive = true;
          this.sweepExtremeLow = candle.low;
          this.candlesSinceSweep = 0;
        }
      }
    }

    if (this.lowSweepActive) {
      this.candlesSinceSweep++;
      this.sweepExtremeLow = Math.min(this.sweepExtremeLow, candle.low);

      if (candle.close > this.overnightLow) {
        const bodyRatio = (candle.high - candle.low) > 0
          ? Math.abs(candle.close - candle.open) / (candle.high - candle.low) : 0;

        if (bodyRatio >= this.params.minReclaimBodyRatio && candle.close > candle.open) {
          const signal = this.createSignal('long', candle, et, this.sweepExtremeLow, overnightRange);
          if (signal) {
            this.lowSweepActive = false;
            return signal;
          }
        }
      }

      if (this.candlesSinceSweep > this.params.maxCandlesToReclaim) {
        this.lowSweepActive = false;
      }
    }

    // === HIGH SWEEP → SHORT ===
    if (this.params.allowShorts && !this.highSweepActive) {
      if (candle.high > this.overnightHigh) {
        const depth = candle.high - this.overnightHigh;
        if (depth >= this.params.minSweepDepth && depth <= this.params.maxSweepDepth) {
          this.highSweepActive = true;
          this.sweepExtremeHigh = candle.high;
          this.candlesSinceSweep = 0;
        }
      }
    }

    if (this.highSweepActive) {
      this.candlesSinceSweep++;
      this.sweepExtremeHigh = Math.max(this.sweepExtremeHigh, candle.high);

      if (candle.close < this.overnightHigh) {
        const bodyRatio = (candle.high - candle.low) > 0
          ? Math.abs(candle.close - candle.open) / (candle.high - candle.low) : 0;

        if (bodyRatio >= this.params.minReclaimBodyRatio && candle.close < candle.open) {
          const signal = this.createSignal('short', candle, et, this.sweepExtremeHigh, overnightRange);
          if (signal) {
            this.highSweepActive = false;
            return signal;
          }
        }
      }

      if (this.candlesSinceSweep > this.params.maxCandlesToReclaim) {
        this.highSweepActive = false;
      }
    }

    return null;
  }

  createSignal(side, candle, et, sweepExtreme, overnightRange) {
    const timestamp = this.toMs(candle.timestamp);
    const entryPrice = candle.close;

    let stopPrice, stopDistance, targetPrice;

    if (side === 'long') {
      stopPrice = sweepExtreme - this.params.stopBeyondSweep;
      stopDistance = entryPrice - stopPrice;
      if (this.params.useOvernightRangeTarget) {
        targetPrice = this.overnightHigh;
      } else {
        targetPrice = entryPrice + (stopDistance * this.params.rewardRiskRatio);
      }
    } else {
      stopPrice = sweepExtreme + this.params.stopBeyondSweep;
      stopDistance = stopPrice - entryPrice;
      if (this.params.useOvernightRangeTarget) {
        targetPrice = this.overnightLow;
      } else {
        targetPrice = entryPrice - (stopDistance * this.params.rewardRiskRatio);
      }
    }

    if (stopDistance > this.params.maxStopPoints || stopDistance <= 0) return null;

    this.signalFiredToday = true;
    this.updateLastSignalTime(timestamp);

    const targetDistance = Math.abs(targetPrice - entryPrice);

    if (this.params.debug) {
      console.log(`[SESSION] ${et.dateKey} ${side.toUpperCase()}: entry=${entryPrice.toFixed(2)}, ON range=[${this.overnightLow.toFixed(2)}, ${this.overnightHigh.toFixed(2)}], stop=${stopPrice.toFixed(2)}, target=${targetPrice.toFixed(2)}`);
    }

    return {
      strategy: 'SESSION_TRANSITION',
      side: side === 'long' ? 'buy' : 'sell',
      action: 'place_market',
      symbol: this.params.tradingSymbol,
      price: roundTo(entryPrice),
      stop_loss: roundTo(stopPrice),
      take_profit: roundTo(targetPrice),
      trailing_trigger: null,
      trailing_offset: null,
      quantity: this.params.defaultQuantity,
      maxHoldBars: this.params.maxHoldBars,
      timestamp: new Date(timestamp).toISOString(),
      metadata: {
        strategy: 'SESSION_TRANSITION',
        direction: side,
        overnight_high: roundTo(this.overnightHigh),
        overnight_low: roundTo(this.overnightLow),
        overnight_range: roundTo(overnightRange),
        sweep_extreme: roundTo(sweepExtreme),
        sweep_depth: roundTo(Math.abs(sweepExtreme - (side === 'long' ? this.overnightLow : this.overnightHigh))),
        stop_distance: roundTo(stopDistance),
        target_distance: roundTo(targetDistance),
        rr_ratio: roundTo(targetDistance / stopDistance),
        trading_date: et.dateKey
      }
    };
  }

  reset() {
    super.reset();
    this.overnightHigh = null;
    this.overnightLow = null;
    this.overnightDate = null;
    this.currentTradingDate = null;
    this.signalFiredToday = false;
    this.lowSweepActive = false;
    this.highSweepActive = false;
    this.sweepExtremeLow = null;
    this.sweepExtremeHigh = null;
  }

  getName() { return 'SESSION_TRANSITION'; }
  getDescription() { return 'Session Transition - trades overnight range sweeps at NY open'; }
  getRequiredMarketData() { return []; }
}

export default SessionTransitionStrategy;
