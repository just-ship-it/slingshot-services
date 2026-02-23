/**
 * Value Area 80% Rule Strategy
 *
 * Based on Market Profile theory: if price opens outside the previous
 * day's Value Area and moves back inside, there's an ~80% chance it
 * traverses the entire Value Area to the opposite side.
 *
 * Sources: futures.io, QuantVPS, Market Profile / CBOT research
 *
 * Rules:
 * - Compute previous day's Value Area (VAH, VAL, POC) from volume profile
 * - If price opens outside VA and moves back inside → trade to opposite side
 * - Must stay inside VA for 30 minutes before acting
 * - Target: Opposite side of Value Area
 * - Stop: Beyond the VA boundary where price entered
 */

import { BaseStrategy } from './base-strategy.js';
import { isValidCandle, roundTo } from './strategy-utils.js';

export class ValueArea80Strategy extends BaseStrategy {
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
      // Value Area computation
      // VA covers 70% of volume (standard Market Profile)
      valueAreaPercent: 0.70,

      // Price bucketing for volume profile (tick size in points)
      priceBucketSize: 1.0,  // 1-point buckets for NQ

      // 80% Rule parameters
      // Minutes price must stay inside VA before entry
      confirmationMinutes: 30,

      // Minimum VA width (points) - skip narrow days
      minVAWidth: 15,
      maxVAWidth: 200,

      // Stop: points beyond the VA boundary
      stopBeyondVA: 5,
      maxStopPoints: 40,

      // Target: opposite side of VA (or partial)
      targetPercent: 1.0,  // 1.0 = full VA width

      // Direction
      allowLongs: true,   // Open below VA, re-enters → long to VAH
      allowShorts: true,  // Open above VA, re-enters → short to VAL

      // Session
      rthOnly: true,
      entryWindowStartHour: 10,  // After first 30 min
      entryWindowStartMinute: 0,
      entryWindowEndHour: 14,
      entryWindowEndMinute: 0,

      maxTradesPerDay: 1,
      maxHoldBars: 300,  // 5 hours

      signalCooldownMs: 12 * 60 * 60 * 1000,

      tradingSymbol: 'NQ1!',
      defaultQuantity: 1,

      debug: false
    };

    this.params = { ...this.defaultParams, ...params };

    // Previous day volume profile data
    this.prevDayVAH = null;
    this.prevDayVAL = null;
    this.prevDayPOC = null;

    // Current day volume profile accumulator
    this.currentDayVolProfile = {};  // price_bucket → volume
    this.currentDayDate = null;

    // Entry tracking
    this.currentTradingDate = null;
    this.signalFiredToday = false;
    this.openedOutsideVA = null;  // 'above' or 'below' or null
    this.reEnteredVA = false;
    this.reEntryTime = null;
    this.confirmationComplete = false;
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

  isInRTH(et) {
    const min = et.hour * 60 + et.minute;
    return min >= 570 && min < 960;
  }

  isInEntryWindow(et) {
    const min = et.hour * 60 + et.minute;
    const start = this.params.entryWindowStartHour * 60 + this.params.entryWindowStartMinute;
    const end = this.params.entryWindowEndHour * 60 + this.params.entryWindowEndMinute;
    return min >= start && min < end;
  }

  /**
   * Add candle volume to the daily volume profile
   */
  addToVolumeProfile(candle) {
    const typicalPrice = (candle.high + candle.low + candle.close) / 3;
    const bucket = Math.round(typicalPrice / this.params.priceBucketSize) * this.params.priceBucketSize;
    const vol = candle.volume || 1;

    // Distribute volume across the candle range
    const low = Math.round(candle.low / this.params.priceBucketSize) * this.params.priceBucketSize;
    const high = Math.round(candle.high / this.params.priceBucketSize) * this.params.priceBucketSize;

    if (high === low) {
      this.currentDayVolProfile[bucket] = (this.currentDayVolProfile[bucket] || 0) + vol;
    } else {
      // Distribute proportionally
      const steps = Math.round((high - low) / this.params.priceBucketSize) + 1;
      const volPerStep = vol / steps;
      for (let p = low; p <= high; p += this.params.priceBucketSize) {
        const key = Math.round(p * 100) / 100;
        this.currentDayVolProfile[key] = (this.currentDayVolProfile[key] || 0) + volPerStep;
      }
    }
  }

  /**
   * Compute Value Area from volume profile
   * Returns { vah, val, poc }
   */
  computeValueArea(volProfile) {
    const entries = Object.entries(volProfile)
      .map(([price, vol]) => ({ price: parseFloat(price), volume: vol }))
      .filter(e => e.volume > 0);

    if (entries.length < 5) return null;

    // Find POC (price with highest volume)
    entries.sort((a, b) => b.volume - a.volume);
    const poc = entries[0].price;

    // Sort by price for VA computation
    entries.sort((a, b) => a.price - b.price);
    const totalVolume = entries.reduce((s, e) => s + e.volume, 0);
    const targetVolume = totalVolume * this.params.valueAreaPercent;

    // Start from POC and expand outward
    const pocIndex = entries.findIndex(e => e.price === poc);
    let vaLow = pocIndex;
    let vaHigh = pocIndex;
    let accumulatedVolume = entries[pocIndex].volume;

    while (accumulatedVolume < targetVolume && (vaLow > 0 || vaHigh < entries.length - 1)) {
      const canExpand = {
        below: vaLow > 0 ? entries[vaLow - 1].volume : -1,
        above: vaHigh < entries.length - 1 ? entries[vaHigh + 1].volume : -1
      };

      if (canExpand.above >= canExpand.below) {
        vaHigh++;
        accumulatedVolume += entries[vaHigh].volume;
      } else {
        vaLow--;
        accumulatedVolume += entries[vaLow].volume;
      }
    }

    return {
      vah: entries[vaHigh].price,
      val: entries[vaLow].price,
      poc
    };
  }

  evaluateSignal(candle, prevCandle, marketData, options = {}) {
    if (!isValidCandle(candle)) return null;

    const timestamp = this.toMs(candle.timestamp);
    const et = this.getETTime(timestamp);

    // Track volume profile during RTH
    if (this.isInRTH(et)) {
      if (et.dateKey !== this.currentDayDate) {
        // Compute previous day's VA before resetting
        if (this.currentDayDate && Object.keys(this.currentDayVolProfile).length > 0) {
          const va = this.computeValueArea(this.currentDayVolProfile);
          if (va) {
            this.prevDayVAH = va.vah;
            this.prevDayVAL = va.val;
            this.prevDayPOC = va.poc;

            if (this.params.debug) {
              console.log(`[VA80] Previous day VA: VAH=${va.vah.toFixed(2)} POC=${va.poc.toFixed(2)} VAL=${va.val.toFixed(2)} Width=${(va.vah - va.val).toFixed(1)}pts`);
            }
          }
        }

        // Reset for new day
        this.currentDayDate = et.dateKey;
        this.currentDayVolProfile = {};
        this.signalFiredToday = false;
        this.openedOutsideVA = null;
        this.reEnteredVA = false;
        this.reEntryTime = null;
        this.confirmationComplete = false;
      }

      this.addToVolumeProfile(candle);
    }

    // Need previous day's VA
    if (!this.prevDayVAH || !this.prevDayVAL) return null;

    const vaWidth = this.prevDayVAH - this.prevDayVAL;
    if (vaWidth < this.params.minVAWidth || vaWidth > this.params.maxVAWidth) return null;

    // Detect opening outside VA at 9:30
    if (et.hour === 9 && et.minute === 30 && this.openedOutsideVA === null) {
      const openPrice = candle.open;
      if (openPrice > this.prevDayVAH) {
        this.openedOutsideVA = 'above';
        if (this.params.debug) {
          console.log(`[VA80] ${et.dateKey} Opened ABOVE VA: open=${openPrice.toFixed(2)}, VAH=${this.prevDayVAH.toFixed(2)}`);
        }
      } else if (openPrice < this.prevDayVAL) {
        this.openedOutsideVA = 'below';
        if (this.params.debug) {
          console.log(`[VA80] ${et.dateKey} Opened BELOW VA: open=${openPrice.toFixed(2)}, VAL=${this.prevDayVAL.toFixed(2)}`);
        }
      } else {
        this.openedOutsideVA = 'inside';  // Not applicable for 80% rule
      }
    }

    // 80% rule only applies when opened outside
    if (!this.openedOutsideVA || this.openedOutsideVA === 'inside') return null;
    if (this.signalFiredToday) return null;

    const price = candle.close;

    // Detect re-entry into VA
    if (!this.reEnteredVA) {
      if (this.openedOutsideVA === 'above' && price <= this.prevDayVAH) {
        this.reEnteredVA = true;
        this.reEntryTime = timestamp;
        if (this.params.debug) {
          console.log(`[VA80] ${et.dateKey} Re-entered VA from above at ${price.toFixed(2)}`);
        }
      } else if (this.openedOutsideVA === 'below' && price >= this.prevDayVAL) {
        this.reEnteredVA = true;
        this.reEntryTime = timestamp;
        if (this.params.debug) {
          console.log(`[VA80] ${et.dateKey} Re-entered VA from below at ${price.toFixed(2)}`);
        }
      }
      return null;
    }

    // Check if price left the VA again (invalidation)
    if (this.openedOutsideVA === 'above' && price > this.prevDayVAH) {
      this.reEnteredVA = false;
      this.confirmationComplete = false;
      return null;
    }
    if (this.openedOutsideVA === 'below' && price < this.prevDayVAL) {
      this.reEnteredVA = false;
      this.confirmationComplete = false;
      return null;
    }

    // Wait for confirmation period
    if (!this.confirmationComplete) {
      const minutesInside = (timestamp - this.reEntryTime) / (60 * 1000);
      if (minutesInside >= this.params.confirmationMinutes) {
        this.confirmationComplete = true;
        if (this.params.debug) {
          console.log(`[VA80] ${et.dateKey} Confirmation complete after ${minutesInside.toFixed(0)} minutes inside VA`);
        }
      } else {
        return null;
      }
    }

    // Entry window check
    if (!this.isInEntryWindow(et)) return null;
    if (!this.checkCooldown(timestamp, this.params.signalCooldownMs)) return null;

    // Generate signal
    if (this.openedOutsideVA === 'above' && this.params.allowShorts) {
      // Opened above, re-entered → short to VAL
      return this.createSignal('short', candle, et, vaWidth);
    }

    if (this.openedOutsideVA === 'below' && this.params.allowLongs) {
      // Opened below, re-entered → long to VAH
      return this.createSignal('long', candle, et, vaWidth);
    }

    return null;
  }

  createSignal(side, candle, et, vaWidth) {
    const timestamp = this.toMs(candle.timestamp);
    const entryPrice = candle.close;

    let stopPrice, targetPrice, stopDistance;

    if (side === 'long') {
      // Opened below VA, re-entered, target VAH
      stopPrice = this.prevDayVAL - this.params.stopBeyondVA;
      targetPrice = this.prevDayVAL + (vaWidth * this.params.targetPercent);
      stopDistance = entryPrice - stopPrice;
    } else {
      // Opened above VA, re-entered, target VAL
      stopPrice = this.prevDayVAH + this.params.stopBeyondVA;
      targetPrice = this.prevDayVAH - (vaWidth * this.params.targetPercent);
      stopDistance = stopPrice - entryPrice;
    }

    if (stopDistance > this.params.maxStopPoints || stopDistance <= 0) return null;

    this.signalFiredToday = true;
    this.updateLastSignalTime(timestamp);

    const targetDistance = Math.abs(targetPrice - entryPrice);

    if (this.params.debug) {
      console.log(`[VA80] ${et.dateKey} ${side.toUpperCase()}: entry=${entryPrice.toFixed(2)}, VA=[${this.prevDayVAL.toFixed(2)}, ${this.prevDayVAH.toFixed(2)}], POC=${this.prevDayPOC.toFixed(2)}, stop=${stopPrice.toFixed(2)}, target=${targetPrice.toFixed(2)}`);
    }

    return {
      strategy: 'VALUE_AREA_80',
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
        strategy: 'VALUE_AREA_80',
        direction: side,
        prev_day_vah: roundTo(this.prevDayVAH),
        prev_day_val: roundTo(this.prevDayVAL),
        prev_day_poc: roundTo(this.prevDayPOC),
        va_width: roundTo(vaWidth),
        opened_outside: this.openedOutsideVA,
        stop_distance: roundTo(stopDistance),
        target_distance: roundTo(targetDistance),
        rr_ratio: roundTo(targetDistance / stopDistance),
        trading_date: et.dateKey
      }
    };
  }

  reset() {
    super.reset();
    this.prevDayVAH = null;
    this.prevDayVAL = null;
    this.prevDayPOC = null;
    this.currentDayVolProfile = {};
    this.currentDayDate = null;
    this.currentTradingDate = null;
    this.signalFiredToday = false;
    this.openedOutsideVA = null;
    this.reEnteredVA = false;
    this.reEntryTime = null;
    this.confirmationComplete = false;
  }

  getName() { return 'VALUE_AREA_80'; }
  getDescription() { return 'Value Area 80% Rule - trades VA reversion when price opens outside and re-enters'; }
  getRequiredMarketData() { return []; }
}

export default ValueArea80Strategy;
