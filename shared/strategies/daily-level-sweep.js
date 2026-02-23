/**
 * Daily Level Sweep & Reversal Strategy
 *
 * Identifies stop hunts / liquidity sweeps beyond the previous day's
 * high and low, then enters on the reversal back into range.
 *
 * Sources: Steady Turtle Trading, futures.io, ICT concepts
 *
 * Rules:
 * - Track previous day's RTH high and low
 * - Wait for price to spike BEYOND the level (sweeping stops)
 * - Enter on quick reversal back into range (momentum candle)
 * - Stop: Beyond the sweep extreme (recent pivot)
 * - Target: 2:1 R:R minimum, or next S/R level
 *
 * Concept: Retail traders place stops just beyond daily levels.
 * Institutions sweep these stops for liquidity, then reverse.
 */

import { BaseStrategy } from './base-strategy.js';
import { isValidCandle, roundTo } from './strategy-utils.js';

export class DailyLevelSweepStrategy extends BaseStrategy {
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
      // Sweep detection
      // How far beyond the level price must go (points) to count as a sweep
      minSweepDepth: 3,
      maxSweepDepth: 40,  // Too deep = real breakout, not a sweep

      // Reversal confirmation
      // Price must reclaim the level within N candles
      maxCandlesToReclaim: 5,

      // Reclaim candle must be strong (body > 50% of range)
      minReclaimBodyRatio: 0.5,

      // Risk management
      stopBeyondSweep: 5,  // Points beyond the sweep extreme for stop
      maxStopPoints: 35,
      rewardRiskRatio: 2.0,  // Target = entry + (stop_distance * R:R)

      // Direction filters
      allowLongs: true,   // Sweep below prev day low → long
      allowShorts: true,  // Sweep above prev day high → short

      // Session filter: only trade during RTH
      rthOnly: true,

      // One trade per day per direction
      maxTradesPerDay: 2,

      // Max hold
      maxHoldBars: 120,  // 2 hours

      // Entry window
      entryWindowStartHour: 9,
      entryWindowStartMinute: 45,  // Skip first 15 min
      entryWindowEndHour: 15,
      entryWindowEndMinute: 30,

      // Signal management
      signalCooldownMs: 2 * 60 * 60 * 1000,  // 2 hours between signals

      // Symbol
      tradingSymbol: 'NQ1!',
      defaultQuantity: 1,

      debug: false
    };

    this.params = { ...this.defaultParams, ...params };

    // State
    this.prevDayHigh = null;
    this.prevDayLow = null;
    this.currentDayHigh = null;
    this.currentDayLow = null;
    this.currentTradingDate = null;
    this.tradesThisDay = 0;

    // Sweep tracking
    this.lowSweepActive = false;
    this.highSweepActive = false;
    this.sweepExtremeLow = null;
    this.sweepExtremeHigh = null;
    this.sweepStartCandle = 0;
    this.candlesSinceSweep = 0;
    this.lowSwept = false;   // Already swept and traded low today
    this.highSwept = false;  // Already swept and traded high today
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

  isInRTH(et) {
    const min = et.hour * 60 + et.minute;
    return min >= 570 && min < 960;  // 9:30 to 16:00
  }

  isInEntryWindow(et) {
    const min = et.hour * 60 + et.minute;
    const start = this.params.entryWindowStartHour * 60 + this.params.entryWindowStartMinute;
    const end = this.params.entryWindowEndHour * 60 + this.params.entryWindowEndMinute;
    return min >= start && min < end;
  }

  evaluateSignal(candle, prevCandle, marketData, options = {}) {
    if (!isValidCandle(candle)) return null;

    const timestamp = this.toMs(candle.timestamp);
    const et = this.getETTime(timestamp);

    // Track RTH high/low for current day
    if (this.isInRTH(et)) {
      if (et.dateKey !== this.currentTradingDate) {
        // New trading day: rotate prev day levels
        if (this.currentDayHigh !== null) {
          this.prevDayHigh = this.currentDayHigh;
          this.prevDayLow = this.currentDayLow;
        }
        this.currentTradingDate = et.dateKey;
        this.currentDayHigh = candle.high;
        this.currentDayLow = candle.low;
        this.tradesThisDay = 0;
        this.lowSweepActive = false;
        this.highSweepActive = false;
        this.sweepExtremeLow = null;
        this.sweepExtremeHigh = null;
        this.lowSwept = false;
        this.highSwept = false;
      } else {
        this.currentDayHigh = Math.max(this.currentDayHigh, candle.high);
        this.currentDayLow = Math.min(this.currentDayLow, candle.low);
      }
    }

    // Need previous day levels
    if (!this.prevDayHigh || !this.prevDayLow) return null;

    // Session and window checks
    if (this.params.rthOnly && !this.isInRTH(et)) return null;
    if (!this.isInEntryWindow(et)) return null;
    if (this.tradesThisDay >= this.params.maxTradesPerDay) return null;
    if (!this.checkCooldown(timestamp, this.params.signalCooldownMs)) return null;

    const price = candle.close;

    // === LOW SWEEP DETECTION (potential long) ===
    if (this.params.allowLongs && !this.lowSwept) {
      if (!this.lowSweepActive) {
        // Check if price swept below prev day low
        if (candle.low < this.prevDayLow) {
          const sweepDepth = this.prevDayLow - candle.low;
          if (sweepDepth >= this.params.minSweepDepth && sweepDepth <= this.params.maxSweepDepth) {
            this.lowSweepActive = true;
            this.sweepExtremeLow = candle.low;
            this.candlesSinceSweep = 0;

            if (this.params.debug) {
              console.log(`[SWEEP] ${et.dateKey} Low sweep detected: prev low=${this.prevDayLow.toFixed(2)}, swept to=${candle.low.toFixed(2)}, depth=${sweepDepth.toFixed(1)}pts`);
            }
          }
        }
      } else {
        this.candlesSinceSweep++;
        this.sweepExtremeLow = Math.min(this.sweepExtremeLow, candle.low);

        // Check for reclaim (close back above prev day low)
        if (candle.close > this.prevDayLow) {
          const bodySize = Math.abs(candle.close - candle.open);
          const range = candle.high - candle.low;
          const bodyRatio = range > 0 ? bodySize / range : 0;

          if (bodyRatio >= this.params.minReclaimBodyRatio && candle.close > candle.open) {
            // Valid reclaim: enter long
            const signal = this.createSweepSignal('long', candle, et, this.sweepExtremeLow, this.prevDayLow);
            if (signal) {
              this.lowSwept = true;
              this.lowSweepActive = false;
              return signal;
            }
          }
        }

        // Timeout: sweep didn't reclaim in time
        if (this.candlesSinceSweep > this.params.maxCandlesToReclaim) {
          this.lowSweepActive = false;
          if (this.params.debug) {
            console.log(`[SWEEP] ${et.dateKey} Low sweep timed out after ${this.candlesSinceSweep} candles`);
          }
        }
      }
    }

    // === HIGH SWEEP DETECTION (potential short) ===
    if (this.params.allowShorts && !this.highSwept) {
      if (!this.highSweepActive) {
        if (candle.high > this.prevDayHigh) {
          const sweepDepth = candle.high - this.prevDayHigh;
          if (sweepDepth >= this.params.minSweepDepth && sweepDepth <= this.params.maxSweepDepth) {
            this.highSweepActive = true;
            this.sweepExtremeHigh = candle.high;
            this.candlesSinceSweep = 0;

            if (this.params.debug) {
              console.log(`[SWEEP] ${et.dateKey} High sweep detected: prev high=${this.prevDayHigh.toFixed(2)}, swept to=${candle.high.toFixed(2)}, depth=${sweepDepth.toFixed(1)}pts`);
            }
          }
        }
      } else {
        this.candlesSinceSweep++;
        this.sweepExtremeHigh = Math.max(this.sweepExtremeHigh, candle.high);

        if (candle.close < this.prevDayHigh) {
          const bodySize = Math.abs(candle.close - candle.open);
          const range = candle.high - candle.low;
          const bodyRatio = range > 0 ? bodySize / range : 0;

          if (bodyRatio >= this.params.minReclaimBodyRatio && candle.close < candle.open) {
            const signal = this.createSweepSignal('short', candle, et, this.sweepExtremeHigh, this.prevDayHigh);
            if (signal) {
              this.highSwept = true;
              this.highSweepActive = false;
              return signal;
            }
          }
        }

        if (this.candlesSinceSweep > this.params.maxCandlesToReclaim) {
          this.highSweepActive = false;
        }
      }
    }

    return null;
  }

  createSweepSignal(side, candle, et, sweepExtreme, levelPrice) {
    const timestamp = this.toMs(candle.timestamp);
    const entryPrice = candle.close;

    let stopPrice, stopDistance;

    if (side === 'long') {
      stopPrice = sweepExtreme - this.params.stopBeyondSweep;
      stopDistance = entryPrice - stopPrice;
    } else {
      stopPrice = sweepExtreme + this.params.stopBeyondSweep;
      stopDistance = stopPrice - entryPrice;
    }

    // Max stop check
    if (stopDistance > this.params.maxStopPoints) {
      if (this.params.debug) {
        console.log(`[SWEEP] ${et.dateKey} ${side} rejected: stop ${stopDistance.toFixed(1)}pts > max ${this.params.maxStopPoints}`);
      }
      return null;
    }

    const targetDistance = stopDistance * this.params.rewardRiskRatio;
    const targetPrice = side === 'long'
      ? entryPrice + targetDistance
      : entryPrice - targetDistance;

    this.tradesThisDay++;
    this.updateLastSignalTime(timestamp);

    if (this.params.debug) {
      console.log(`[SWEEP] ${et.dateKey} ${side.toUpperCase()} signal: entry=${entryPrice.toFixed(2)}, stop=${stopPrice.toFixed(2)} (${stopDistance.toFixed(1)}pts), target=${targetPrice.toFixed(2)} (${targetDistance.toFixed(1)}pts), R:R=${this.params.rewardRiskRatio}`);
    }

    return {
      strategy: 'DAILY_LEVEL_SWEEP',
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
        strategy: 'DAILY_LEVEL_SWEEP',
        direction: side,
        sweep_type: side === 'long' ? 'low_sweep' : 'high_sweep',
        level_price: roundTo(levelPrice),
        sweep_extreme: roundTo(sweepExtreme),
        sweep_depth: roundTo(Math.abs(sweepExtreme - levelPrice)),
        prev_day_high: roundTo(this.prevDayHigh),
        prev_day_low: roundTo(this.prevDayLow),
        stop_distance: roundTo(stopDistance),
        target_distance: roundTo(targetDistance),
        rr_ratio: this.params.rewardRiskRatio,
        candles_to_reclaim: this.candlesSinceSweep,
        day_of_week: et.dayOfWeek,
        day_name: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][et.dayOfWeek],
        trading_date: et.dateKey
      }
    };
  }

  reset() {
    super.reset();
    this.prevDayHigh = null;
    this.prevDayLow = null;
    this.currentDayHigh = null;
    this.currentDayLow = null;
    this.currentTradingDate = null;
    this.tradesThisDay = 0;
    this.lowSweepActive = false;
    this.highSweepActive = false;
    this.sweepExtremeLow = null;
    this.sweepExtremeHigh = null;
    this.lowSwept = false;
    this.highSwept = false;
  }

  getName() { return 'DAILY_LEVEL_SWEEP'; }
  getDescription() { return 'Daily Level Sweep - enters on stop hunt reversals at previous day high/low'; }
  getRequiredMarketData() { return []; }
}

export default DailyLevelSweepStrategy;
