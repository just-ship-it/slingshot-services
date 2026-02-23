/**
 * Initial Balance Breakout (IBB) Strategy
 *
 * The Initial Balance is the price range established during the first hour
 * of Regular Trading Hours (9:30-10:30 AM ET). When price breaks out of
 * this range, it often continues in the breakout direction.
 *
 * Sources: Trade That Swing, NinjaTrader forums, Market Profile theory
 *
 * Rules:
 * - IB = High/Low of first hour (9:30-10:30 AM ET)
 * - Entry: On breakout, use pullback entry at 25% inside the IB range
 * - Stop Loss: 60% of IB range from the IB extreme
 * - Take Profit: 50% of IB range beyond the IB high/low
 * - One trade per day maximum
 * - Minimum IB range filter (avoid tight range days)
 *
 * Claimed results: 114 trades, 74.56% win rate, profit factor 2.512
 */

import { BaseStrategy } from './base-strategy.js';
import { isValidCandle, roundTo } from './strategy-utils.js';

export class InitialBalanceBreakoutStrategy extends BaseStrategy {
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
      // IB window definition (Eastern Time)
      ibStartHour: 9,
      ibStartMinute: 30,
      ibEndHour: 10,
      ibEndMinute: 30,

      // Entry configuration
      // pullbackPercent: How far inside the IB to place the pullback entry
      // 0.25 = 25% inside the IB from the breakout side
      pullbackPercent: 0.25,

      // Wait for breakout confirmation (close beyond IB) before placing entry
      requireCloseBreakout: true,

      // Stop loss: percentage of IB range
      stopPercent: 0.60,

      // Take profit: percentage of IB range beyond the IB extreme
      targetPercent: 0.50,

      // Minimum IB range (points) - filters out narrow/choppy days
      minIBRange: 15,

      // Maximum IB range (points) - filters out extreme volatility days
      maxIBRange: 150,

      // Direction filters
      allowLongs: true,
      allowShorts: true,

      // One trade per day
      maxTradesPerDay: 1,

      // Entry window: how long after IB to wait for breakout
      // After this window, skip the day
      entryWindowEndHour: 15,  // 3:00 PM ET (no entries after this)
      entryWindowEndMinute: 0,

      // Max hold time in bars (1-min bars)
      maxHoldBars: 330,  // ~5.5 hours

      // Signal management
      signalCooldownMs: 12 * 60 * 60 * 1000,  // 12 hours

      // Symbol configuration
      tradingSymbol: 'NQ1!',
      defaultQuantity: 1,

      // Alternative mode: market order on breakout (no pullback)
      useMarketEntry: false,

      debug: false
    };

    this.params = { ...this.defaultParams, ...params };

    // State tracking
    this.ibHigh = null;
    this.ibLow = null;
    this.ibComplete = false;
    this.ibCandleCount = 0;
    this.signalFiredToday = false;
    this.currentTradingDate = null;
    this.breakoutDetected = null;  // 'long' or 'short' or null
    this.pendingPullbackEntry = null;  // Tracks pullback level after breakout
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
   * Check if timestamp is within the IB formation window
   */
  isInIBWindow(et) {
    const currentMin = et.hour * 60 + et.minute;
    const startMin = this.params.ibStartHour * 60 + this.params.ibStartMinute;
    const endMin = this.params.ibEndHour * 60 + this.params.ibEndMinute;
    return currentMin >= startMin && currentMin < endMin;
  }

  /**
   * Check if timestamp is in the entry window (after IB, before cutoff)
   */
  isInEntryWindow(et) {
    const currentMin = et.hour * 60 + et.minute;
    const ibEndMin = this.params.ibEndHour * 60 + this.params.ibEndMinute;
    const entryEndMin = this.params.entryWindowEndHour * 60 + this.params.entryWindowEndMinute;
    return currentMin >= ibEndMin && currentMin < entryEndMin;
  }

  evaluateSignal(candle, prevCandle, marketData, options = {}) {
    if (!isValidCandle(candle)) return null;

    const timestamp = this.toMs(candle.timestamp);
    const et = this.getETTime(timestamp);

    // Reset state on new trading date
    if (et.dateKey !== this.currentTradingDate) {
      this.currentTradingDate = et.dateKey;
      this.ibHigh = null;
      this.ibLow = null;
      this.ibComplete = false;
      this.ibCandleCount = 0;
      this.signalFiredToday = false;
      this.breakoutDetected = null;
      this.pendingPullbackEntry = null;
    }

    // Phase 1: Build the Initial Balance (9:30-10:30)
    if (this.isInIBWindow(et)) {
      if (this.ibHigh === null) {
        this.ibHigh = candle.high;
        this.ibLow = candle.low;
      } else {
        this.ibHigh = Math.max(this.ibHigh, candle.high);
        this.ibLow = Math.min(this.ibLow, candle.low);
      }
      this.ibCandleCount++;
      return null;
    }

    // Mark IB as complete at 10:30
    if (!this.ibComplete && this.ibHigh !== null && this.ibLow !== null) {
      this.ibComplete = true;
      const ibRange = this.ibHigh - this.ibLow;

      if (this.params.debug) {
        console.log(`[IBB] ${et.dateKey} IB Complete: High=${this.ibHigh.toFixed(2)} Low=${this.ibLow.toFixed(2)} Range=${ibRange.toFixed(1)}pts (${this.ibCandleCount} candles)`);
      }

      // Filter by IB range
      if (ibRange < this.params.minIBRange || ibRange > this.params.maxIBRange) {
        if (this.params.debug) {
          console.log(`[IBB] ${et.dateKey} IB range ${ibRange.toFixed(1)} outside bounds [${this.params.minIBRange}, ${this.params.maxIBRange}], skipping day`);
        }
        this.signalFiredToday = true;  // Prevent any trades today
        return null;
      }
    }

    // Skip if IB not complete or already traded today
    if (!this.ibComplete || this.signalFiredToday) return null;

    // Skip if outside entry window
    if (!this.isInEntryWindow(et)) return null;

    // Cooldown check
    if (!this.checkCooldown(timestamp, this.params.signalCooldownMs)) return null;

    const ibRange = this.ibHigh - this.ibLow;
    const price = candle.close;

    // Phase 2: Detect breakout
    if (!this.breakoutDetected) {
      // Bullish breakout: close above IB high
      if (this.params.allowLongs && price > this.ibHigh) {
        if (!this.params.requireCloseBreakout || candle.close > this.ibHigh) {
          this.breakoutDetected = 'long';

          if (this.params.useMarketEntry) {
            // Enter immediately on breakout
            return this.createSignal('long', candle, et, ibRange, price);
          }

          // Set up pullback entry level
          this.pendingPullbackEntry = {
            direction: 'long',
            level: this.ibHigh + (ibRange * this.params.pullbackPercent),
            // Actually: enter at IB high + 25% inside = IB high - 25% of range
            // "25% inside the IB" means pullback from breakout
          };
          // Correct: pullback entry for long = breakout level minus pullback distance
          this.pendingPullbackEntry.level = this.ibHigh - (ibRange * this.params.pullbackPercent);

          if (this.params.debug) {
            console.log(`[IBB] ${et.dateKey} BULLISH breakout! Price ${price.toFixed(2)} > IB High ${this.ibHigh.toFixed(2)}. Pullback entry at ${this.pendingPullbackEntry.level.toFixed(2)}`);
          }
        }
      }

      // Bearish breakout: close below IB low
      if (this.params.allowShorts && price < this.ibLow) {
        if (!this.params.requireCloseBreakout || candle.close < this.ibLow) {
          this.breakoutDetected = 'short';

          if (this.params.useMarketEntry) {
            return this.createSignal('short', candle, et, ibRange, price);
          }

          // Pullback entry for short = breakout level plus pullback distance
          this.pendingPullbackEntry = {
            direction: 'short',
            level: this.ibLow + (ibRange * this.params.pullbackPercent)
          };

          if (this.params.debug) {
            console.log(`[IBB] ${et.dateKey} BEARISH breakout! Price ${price.toFixed(2)} < IB Low ${this.ibLow.toFixed(2)}. Pullback entry at ${this.pendingPullbackEntry.level.toFixed(2)}`);
          }
        }
      }
    }

    // Phase 3: Check for pullback entry fill
    if (this.pendingPullbackEntry && !this.signalFiredToday) {
      const pe = this.pendingPullbackEntry;

      if (pe.direction === 'long') {
        // Long pullback: price pulls back down to our level
        if (candle.low <= pe.level) {
          return this.createSignal('long', candle, et, ibRange, pe.level);
        }
      } else if (pe.direction === 'short') {
        // Short pullback: price rallies up to our level
        if (candle.high >= pe.level) {
          return this.createSignal('short', candle, et, ibRange, pe.level);
        }
      }
    }

    return null;
  }

  /**
   * Create a signal with IB-based stop and target
   */
  createSignal(side, candle, et, ibRange, entryPrice) {
    const timestamp = this.toMs(candle.timestamp);
    this.signalFiredToday = true;
    this.updateLastSignalTime(timestamp);

    const stopDistance = ibRange * this.params.stopPercent;
    const targetDistance = ibRange * this.params.targetPercent;

    let stopPrice, targetPrice;

    if (side === 'long') {
      stopPrice = entryPrice - stopDistance;
      targetPrice = this.ibHigh + targetDistance;
    } else {
      stopPrice = entryPrice + stopDistance;
      targetPrice = this.ibLow - targetDistance;
    }

    const riskReward = targetDistance / stopDistance;

    if (this.params.debug) {
      console.log(`[IBB] ${et.dateKey} ${side.toUpperCase()} signal: entry=${entryPrice.toFixed(2)}, stop=${stopPrice.toFixed(2)} (${stopDistance.toFixed(1)}pts), target=${targetPrice.toFixed(2)} (${targetDistance.toFixed(1)}pts), R:R=${riskReward.toFixed(2)}`);
    }

    return {
      strategy: 'INITIAL_BALANCE_BREAKOUT',
      side: side === 'long' ? 'buy' : 'sell',
      action: this.params.useMarketEntry ? 'place_market' : 'place_limit',
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
        strategy: 'INITIAL_BALANCE_BREAKOUT',
        direction: side,
        ib_high: roundTo(this.ibHigh),
        ib_low: roundTo(this.ibLow),
        ib_range: roundTo(ibRange),
        breakout_side: this.breakoutDetected,
        entry_type: this.params.useMarketEntry ? 'market_breakout' : 'pullback_limit',
        pullback_percent: this.params.pullbackPercent,
        stop_distance: roundTo(stopDistance),
        target_distance: roundTo(targetDistance),
        rr_ratio: roundTo(riskReward),
        stop_percent: this.params.stopPercent,
        target_percent: this.params.targetPercent,
        day_of_week: et.dayOfWeek,
        day_name: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][et.dayOfWeek],
        trading_date: et.dateKey
      }
    };
  }

  reset() {
    super.reset();
    this.ibHigh = null;
    this.ibLow = null;
    this.ibComplete = false;
    this.ibCandleCount = 0;
    this.signalFiredToday = false;
    this.currentTradingDate = null;
    this.breakoutDetected = null;
    this.pendingPullbackEntry = null;
  }

  getName() { return 'INITIAL_BALANCE_BREAKOUT'; }
  getDescription() { return 'Initial Balance Breakout - trades first hour range breakouts with pullback entry'; }
  getRequiredMarketData() { return []; }
}

export default InitialBalanceBreakoutStrategy;
