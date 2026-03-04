/**
 * Sweep Reversal Strategy
 *
 * Predicts which side of the Asian session range gets swept first at RTH open,
 * waits for the sweep to occur, then enters a reversal trade toward the opposite side.
 *
 * Based on research findings:
 * - Pre-RTH sweep direction is predictable (87-90% OOS accuracy)
 * - First sweeps reverse 68-76% of the time
 * - Both patterns hold on NQ and ES
 */

import { BaseStrategy } from './base-strategy.js';
import { isValidCandle, roundTo } from './strategy-utils.js';

// --- DST Handling (inlined from research/utils/data-loader.js) ---

const DST_CACHE = {};

function getDSTTransitions(year) {
  if (DST_CACHE[year]) return DST_CACHE[year];

  // 2nd Sunday of March — DST starts at 2 AM ET = 7 AM UTC (EST offset -5)
  let sundayCount = 0;
  let dstStart;
  for (let d = 1; d <= 31; d++) {
    const dt = new Date(Date.UTC(year, 2, d));
    if (dt.getUTCDay() === 0) {
      sundayCount++;
      if (sundayCount === 2) {
        dstStart = Date.UTC(year, 2, d, 7, 0, 0);
        break;
      }
    }
  }

  // 1st Sunday of November — DST ends at 2 AM EDT = 6 AM UTC (EDT offset -4)
  let dstEnd;
  for (let d = 1; d <= 30; d++) {
    const dt = new Date(Date.UTC(year, 10, d));
    if (dt.getUTCDay() === 0) {
      dstEnd = Date.UTC(year, 10, d, 6, 0, 0);
      break;
    }
  }

  DST_CACHE[year] = { dstStart, dstEnd };
  return DST_CACHE[year];
}

function isDST(utcMs) {
  const year = new Date(utcMs).getUTCFullYear();
  const { dstStart, dstEnd } = getDSTTransitions(year);
  return utcMs >= dstStart && utcMs < dstEnd;
}

function toET(utcMs) {
  const offset = isDST(utcMs) ? -4 : -5;
  const etMs = utcMs + offset * 3600000;
  const d = new Date(etMs);
  const hour = d.getUTCHours();
  const minute = d.getUTCMinutes();
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth(),
    day: d.getUTCDate(),
    hour,
    minute,
    offset,
    timeInMinutes: hour * 60 + minute,
    dayOfWeek: d.getUTCDay(),
    date: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
  };
}

// --- Product defaults ---

const PRODUCT_DEFAULTS = {
  NQ: {
    sweepConfirmationPts: 3,
    stopBuffer: 15,
    maxStopDistance: 50,
    targetPoints: 100,
    trailingTrigger: 40,
    trailingOffset: 20,
    minAsianRange: 15,
    maxAsianRange: 300,
  },
  ES: {
    sweepConfirmationPts: 1,
    stopBuffer: 5,
    maxStopDistance: 15,
    targetPoints: 30,
    trailingTrigger: 12,
    trailingOffset: 6,
    minAsianRange: 5,
    maxAsianRange: 90,
  }
};

// Session boundaries in ET minutes-from-midnight
const SESSIONS = {
  ASIAN_START: 19 * 60,        // 7:00 PM ET (previous calendar day)
  ASIAN_END: 3 * 60,           // 3:00 AM ET
  EURO_START: 3 * 60,          // 3:00 AM ET
  EURO_END: 9 * 60 + 30,       // 9:30 AM ET
  RTH_START: 9 * 60 + 30,      // 9:30 AM ET
  RTH_END: 16 * 60,            // 4:00 PM ET
};

export class SweepReversalStrategy extends BaseStrategy {
  constructor(params = {}) {
    super(params);

    const product = (params.product || params.tradingSymbol || 'NQ').toUpperCase();
    // Normalize product from symbol like 'NQ1!' or 'ES1!' to 'NQ' or 'ES'
    this.product = product.replace(/[0-9!]+$/, '');
    const defaults = PRODUCT_DEFAULTS[this.product] || PRODUCT_DEFAULTS.NQ;

    // Core parameters
    this.entryMode = params.entryMode || 'market';
    this.sweepConfirmationPts = params.sweepConfirmationPts ?? defaults.sweepConfirmationPts;
    this.requireReclaim = params.requireReclaim ?? true;
    this.stopBuffer = params.stopBuffer ?? defaults.stopBuffer;
    this.maxStopDistance = params.maxStopDistance ?? defaults.maxStopDistance;
    this.targetMode = params.targetMode || 'opposite_side';
    this.targetPoints = params.targetPoints ?? defaults.targetPoints;
    this.trailingTrigger = params.trailingTrigger ?? defaults.trailingTrigger;
    this.trailingOffset = params.trailingOffset ?? defaults.trailingOffset;
    this.minAsianRange = params.minAsianRange ?? defaults.minAsianRange;
    this.maxAsianRange = params.maxAsianRange ?? defaults.maxAsianRange;
    this.signalCooldownMs = params.signalCooldownMs ?? 0;
    this.maxHoldBars = params.maxHoldBars ?? 0;
    this.defaultQuantity = params.defaultQuantity ?? 1;
    this.tradingSymbol = params.tradingSymbol || `${this.product}1!`;

    // Prediction filter
    this.usePredictionFilter = params.usePredictionFilter ?? true;
    this.predictionMinConfidence = params.predictionMinConfidence ?? 2;

    // GEX regime filter
    this.useGEXFilter = params.useGEXFilter ?? false;

    // GEX distance to opposite wall filter (best single reversal feature from research)
    this.useGexDistanceFilter = params.useGexDistanceFilter ?? false;
    this.maxGexDistanceToOppositeWall = params.maxGexDistanceToOppositeWall ?? (this.product === 'ES' ? 30 : 150);

    // Direction filters
    this.allowLongs = params.allowLongs ?? true;
    this.allowShorts = params.allowShorts ?? true;

    // Verbose logging
    this.verbose = params.verbose ?? false;
    this.debug = params.debug ?? false;

    // Entry window (default: 10:00 AM - 2:00 PM ET)
    this.entryStartHour = params.entryStartHour ?? 10;
    this.entryStartMinute = params.entryStartMinute ?? 0;
    this.entryCutoffHour = params.entryCutoffHour ?? 14;
    this.entryCutoffMinute = params.entryCutoffMinute ?? 0;

    // Force close at market close
    this.forceCloseAtMarketClose = params.forceCloseAtMarketClose ?? true;

    // Daily state
    this.resetDailyState();
  }

  resetDailyState() {
    this.tradingDate = null;
    this.asianHigh = -Infinity;
    this.asianLow = Infinity;
    this.asianRange = 0;
    this.overnightHigh = -Infinity;
    this.overnightLow = Infinity;
    this.overnightOpen = null;
    this.overnightClose = null;
    this.prevDayClose = this._nextPrevDayClose ?? null;
    this.euroSweptSide = 'none'; // 'high', 'low', 'both', 'none'
    this.expectedSweepSide = null; // 'high' or 'low'
    this.predictionConfidence = 0;
    this.firstSweepOccurred = false;
    this.sweepExtreme = null;
    this.sweepReclaimed = false;
    this.signalFired = false;
    this.rthFirstCandleProcessed = false;
  }

  reset() {
    super.reset();
    this._nextPrevDayClose = null;
    this.resetDailyState();
  }

  /**
   * Determine which session a candle belongs to based on ET time.
   * Returns 'asian', 'euro', 'rth', 'post_rth', or 'pre_asian'.
   */
  getSession(et) {
    const t = et.timeInMinutes;

    // Asian: 7 PM (1140) to midnight (next day), then midnight to 3 AM
    if (t >= SESSIONS.ASIAN_START) return 'asian';  // 19:00-23:59
    if (t < SESSIONS.ASIAN_END) return 'asian';      // 00:00-02:59

    // European: 3 AM to 9:30 AM
    if (t >= SESSIONS.EURO_START && t < SESSIONS.EURO_END) return 'euro';

    // RTH: 9:30 AM to 4 PM
    if (t >= SESSIONS.RTH_START && t < SESSIONS.RTH_END) return 'rth';

    // Post-RTH: 4 PM to 7 PM
    if (t >= SESSIONS.RTH_END && t < SESSIONS.ASIAN_START) return 'post_rth';

    return 'unknown';
  }

  /**
   * Determine the "trading date" for this candle.
   * The trading date is the date of the RTH session this candle belongs to.
   * Overnight candles (after 7 PM) belong to the NEXT calendar day's RTH.
   */
  getTradingDate(et) {
    if (et.timeInMinutes >= SESSIONS.ASIAN_START) {
      // After 7 PM — belongs to next day's session
      const nextDay = new Date(Date.UTC(et.year, et.month, et.day + 1));
      return `${nextDay.getUTCFullYear()}-${String(nextDay.getUTCMonth() + 1).padStart(2, '0')}-${String(nextDay.getUTCDate()).padStart(2, '0')}`;
    }
    return et.date;
  }

  evaluateSignal(candle, prevCandle, marketData, options = {}) {
    if (!isValidCandle(candle)) return null;

    const ts = this.toMs(candle.timestamp);
    const et = toET(ts);
    const session = this.getSession(et);

    // Skip weekends
    if (et.dayOfWeek === 0 || et.dayOfWeek === 6) return null;

    // Skip post-RTH (4 PM - 7 PM ET) — dead zone between sessions
    if (session === 'post_rth') {
      // Track last RTH close as potential prevDayClose
      this._nextPrevDayClose = candle.close;
      return null;
    }

    // Determine trading date and detect day boundary
    const tradingDate = this.getTradingDate(et);

    if (this.tradingDate && tradingDate !== this.tradingDate) {
      // New trading day — reset
      if (this.debug) {
        console.log(`[SWEEP-REV] New trading day: ${tradingDate} (was ${this.tradingDate})`);
      }
      this.resetDailyState();
    }

    if (!this.tradingDate) {
      this.tradingDate = tradingDate;
    }

    // --- Phase 1: Accumulate session state ---

    if (session === 'asian') {
      return this.processAsianCandle(candle, et);
    }

    if (session === 'euro') {
      return this.processEuroCandle(candle, et);
    }

    // --- Phase 2 & 3: RTH ---
    if (session === 'rth') {
      return this.processRTHCandle(candle, prevCandle, et, marketData);
    }

    return null;
  }

  processAsianCandle(candle, et) {
    // Track Asian range
    if (candle.high > this.asianHigh) this.asianHigh = candle.high;
    if (candle.low < this.asianLow) this.asianLow = candle.low;

    // Track overnight high/low/open
    if (candle.high > this.overnightHigh) this.overnightHigh = candle.high;
    if (candle.low < this.overnightLow) this.overnightLow = candle.low;
    if (this.overnightOpen === null) this.overnightOpen = candle.open;
    this.overnightClose = candle.close;

    return null;
  }

  processEuroCandle(candle, et) {
    // Continue tracking overnight range
    if (candle.high > this.overnightHigh) this.overnightHigh = candle.high;
    if (candle.low < this.overnightLow) this.overnightLow = candle.low;
    this.overnightClose = candle.close;

    // Check if Euro session sweeps Asian levels
    if (this.asianHigh > -Infinity && this.asianLow < Infinity) {
      const sweptHigh = candle.high >= this.asianHigh + this.sweepConfirmationPts;
      const sweptLow = candle.low <= this.asianLow - this.sweepConfirmationPts;

      if (sweptHigh && sweptLow) {
        this.euroSweptSide = 'both';
      } else if (sweptHigh && this.euroSweptSide !== 'low' && this.euroSweptSide !== 'both') {
        this.euroSweptSide = this.euroSweptSide === 'none' ? 'high' : 'both';
      } else if (sweptLow && this.euroSweptSide !== 'high' && this.euroSweptSide !== 'both') {
        this.euroSweptSide = this.euroSweptSide === 'none' ? 'low' : 'both';
      }
    }

    return null;
  }

  processRTHCandle(candle, prevCandle, et, marketData) {
    // Validate Asian range exists and is within bounds
    if (this.asianHigh <= -Infinity || this.asianLow >= Infinity) return null;

    this.asianRange = this.asianHigh - this.asianLow;
    if (this.asianRange < this.minAsianRange || this.asianRange > this.maxAsianRange) {
      return null;
    }

    // --- RTH first candle: compute prediction ---
    if (!this.rthFirstCandleProcessed) {
      this.rthFirstCandleProcessed = true;
      this.computePrediction(candle);

      if (this.debug) {
        console.log(`[SWEEP-REV] ${this.tradingDate} RTH open | Asian: ${roundTo(this.asianLow, 2)}-${roundTo(this.asianHigh, 2)} (${roundTo(this.asianRange, 2)}pts) | ON: ${roundTo(this.overnightLow, 2)}-${roundTo(this.overnightHigh, 2)} | Euro swept: ${this.euroSweptSide} | Prediction: ${this.expectedSweepSide} (conf=${this.predictionConfidence})`);
      }

      // If prediction filter is on and confidence too low, skip this day
      if (this.usePredictionFilter && this.predictionConfidence < this.predictionMinConfidence) {
        if (this.debug) {
          console.log(`[SWEEP-REV] ${this.tradingDate} Skipping — confidence ${this.predictionConfidence} < ${this.predictionMinConfidence}`);
        }
        return null;
      }
    }

    // Already fired a signal today
    if (this.signalFired) return null;

    // No prediction available
    if (!this.expectedSweepSide && this.usePredictionFilter) return null;

    // Entry window check
    const entryStart = this.entryStartHour * 60 + this.entryStartMinute;
    const cutoff = this.entryCutoffHour * 60 + this.entryCutoffMinute;
    if (et.timeInMinutes < entryStart || et.timeInMinutes >= cutoff) return null;

    // Cooldown check
    if (this.signalCooldownMs > 0 && !this.checkCooldown(candle.timestamp, this.signalCooldownMs)) {
      return null;
    }

    // GEX regime filter
    if (this.useGEXFilter && marketData?.gex) {
      const regime = marketData.gex.regime;
      if (regime === 'negative' || regime === 'strong_negative') return null;
    }

    // --- Phase 2: Watch for sweep ---
    if (!this.firstSweepOccurred) {
      return this.checkForSweep(candle, et, marketData);
    }

    // --- Phase 3: Wait for reclaim and enter ---
    if (this.requireReclaim && !this.sweepReclaimed) {
      return this.checkForReclaim(candle, et, marketData);
    }

    // Reclaim happened (or not required) — generate entry signal
    return this.generateSignal(candle, et, marketData);
  }

  computePrediction(candle) {
    let highVotes = 0;
    let lowVotes = 0;

    // Feature 1: price_position_in_on_range
    // Where is the current price relative to overnight range?
    // > 0.5 → price is in upper half → expect high sweep first
    if (this.overnightHigh > this.overnightLow) {
      const onRange = this.overnightHigh - this.overnightLow;
      const pricePos = (candle.open - this.overnightLow) / onRange;
      if (pricePos > 0.5) {
        highVotes++;
      } else if (pricePos < 0.5) {
        lowVotes++;
      }
    }

    // Feature 2: overnight_bias
    // Direction of overnight move: positive → biased up → expect high first
    if (this.overnightOpen !== null && this.overnightClose !== null) {
      const bias = this.overnightClose - this.overnightOpen;
      if (bias > 0) {
        highVotes++;
      } else if (bias < 0) {
        lowVotes++;
      }
    }

    // Feature 3: gap_from_pdc
    // Gap up from previous day close → expect high first
    if (this.prevDayClose !== null) {
      const gap = candle.open - this.prevDayClose;
      if (gap > 0) {
        highVotes++;
      } else if (gap < 0) {
        lowVotes++;
      }
    }

    // Feature 4: euroSweptSide
    // If Euro already swept high → RTH likely also sweeps high first
    if (this.euroSweptSide === 'high') {
      highVotes++;
    } else if (this.euroSweptSide === 'low') {
      lowVotes++;
    }
    // 'both' or 'none' don't vote

    // Majority vote
    if (highVotes > lowVotes) {
      this.expectedSweepSide = 'high';
      this.predictionConfidence = highVotes;
    } else if (lowVotes > highVotes) {
      this.expectedSweepSide = 'low';
      this.predictionConfidence = lowVotes;
    } else {
      // Tie — default to high (slight historical bias)
      this.expectedSweepSide = 'high';
      this.predictionConfidence = highVotes;
    }
  }

  checkForSweep(candle, et, marketData) {
    const sweepSide = this.usePredictionFilter ? this.expectedSweepSide : null;

    // Check high sweep
    if ((!sweepSide || sweepSide === 'high') && candle.high >= this.asianHigh + this.sweepConfirmationPts) {
      this.firstSweepOccurred = true;
      this.sweepExtreme = candle.high;
      this.actualSweepSide = 'high';

      if (this.debug) {
        console.log(`[SWEEP-REV] ${et.date} ${et.hour}:${String(et.minute).padStart(2, '0')} High sweep! Extreme=${roundTo(this.sweepExtreme, 2)} (Asian high=${roundTo(this.asianHigh, 2)})`);
      }

      if (!this.requireReclaim) {
        return this.generateSignal(candle, et, marketData);
      }
      // Check if this same candle also reclaims
      if (candle.close <= this.asianHigh) {
        this.sweepReclaimed = true;
        return this.generateSignal(candle, et, marketData);
      }
      return null;
    }

    // Check low sweep
    if ((!sweepSide || sweepSide === 'low') && candle.low <= this.asianLow - this.sweepConfirmationPts) {
      this.firstSweepOccurred = true;
      this.sweepExtreme = candle.low;
      this.actualSweepSide = 'low';

      if (this.debug) {
        console.log(`[SWEEP-REV] ${et.date} ${et.hour}:${String(et.minute).padStart(2, '0')} Low sweep! Extreme=${roundTo(this.sweepExtreme, 2)} (Asian low=${roundTo(this.asianLow, 2)})`);
      }

      if (!this.requireReclaim) {
        return this.generateSignal(candle, et, marketData);
      }
      // Check if this same candle also reclaims
      if (candle.close >= this.asianLow) {
        this.sweepReclaimed = true;
        return this.generateSignal(candle, et, marketData);
      }
      return null;
    }

    // If not using prediction filter, check for either side sweep
    if (!sweepSide) {
      // Already handled above with (!sweepSide || ...) conditions
    }

    return null;
  }

  checkForReclaim(candle, et, marketData) {
    // Update sweep extreme if price continues beyond
    if (this.actualSweepSide === 'high' && candle.high > this.sweepExtreme) {
      this.sweepExtreme = candle.high;
    } else if (this.actualSweepSide === 'low' && candle.low < this.sweepExtreme) {
      this.sweepExtreme = candle.low;
    }

    // Check reclaim: price closes back inside Asian range
    if (this.actualSweepSide === 'high' && candle.close <= this.asianHigh) {
      this.sweepReclaimed = true;
      if (this.debug) {
        console.log(`[SWEEP-REV] ${et.date} ${et.hour}:${String(et.minute).padStart(2, '0')} Reclaim! Close=${roundTo(candle.close, 2)} <= Asian high=${roundTo(this.asianHigh, 2)}`);
      }
      return this.generateSignal(candle, et, marketData);
    }

    if (this.actualSweepSide === 'low' && candle.close >= this.asianLow) {
      this.sweepReclaimed = true;
      if (this.debug) {
        console.log(`[SWEEP-REV] ${et.date} ${et.hour}:${String(et.minute).padStart(2, '0')} Reclaim! Close=${roundTo(candle.close, 2)} >= Asian low=${roundTo(this.asianLow, 2)}`);
      }
      return this.generateSignal(candle, et, marketData);
    }

    return null;
  }

  generateSignal(candle, et, marketData) {
    // Determine trade direction — enter toward the opposite side of the sweep
    const side = this.actualSweepSide === 'high' ? 'sell' : 'buy';

    // Direction filter
    if (side === 'buy' && !this.allowLongs) return null;
    if (side === 'sell' && !this.allowShorts) return null;

    // GEX distance to opposite wall filter (best single reversal feature from research)
    // After a high sweep, check distance down to put wall (magnet for reversal)
    // After a low sweep, check distance up to call wall (magnet for reversal)
    if (this.useGexDistanceFilter) {
      const oppositeWallDist = this._computeGexDistance(candle.close, marketData);
      if (oppositeWallDist !== null && oppositeWallDist > this.maxGexDistanceToOppositeWall) {
        if (this.debug) {
          console.log(`[SWEEP-REV] ${et.date} GEX distance filter: opposite wall ${roundTo(oppositeWallDist, 2)}pts away > ${this.maxGexDistanceToOppositeWall}`);
        }
        return null;
      }
    }

    // Calculate entry price
    const entryPrice = this.entryMode === 'limit'
      ? (this.actualSweepSide === 'high' ? this.asianHigh : this.asianLow)
      : candle.close;

    // Calculate stop — beyond the sweep extreme + buffer
    const stopLoss = this.actualSweepSide === 'high'
      ? this.sweepExtreme + this.stopBuffer
      : this.sweepExtreme - this.stopBuffer;

    // Validate stop distance
    const risk = this.calculateRisk(entryPrice, stopLoss);
    if (risk > this.maxStopDistance) {
      if (this.debug) {
        console.log(`[SWEEP-REV] ${et.date} Stop too wide: ${roundTo(risk, 2)} > ${this.maxStopDistance}`);
      }
      return null;
    }

    if (risk <= 0) return null;

    // Calculate target
    let takeProfit;
    if (this.targetMode === 'opposite_side') {
      // Target: opposite side of Asian range
      takeProfit = this.actualSweepSide === 'high' ? this.asianLow : this.asianHigh;
    } else {
      // Fixed target points
      takeProfit = side === 'buy'
        ? entryPrice + this.targetPoints
        : entryPrice - this.targetPoints;
    }

    this.signalFired = true;
    this.updateLastSignalTime(candle.timestamp);

    const action = this.entryMode === 'limit' ? 'place_limit' : 'place_market';

    if (this.debug) {
      console.log(`[SWEEP-REV] ${et.date} ${et.hour}:${String(et.minute).padStart(2, '0')} SIGNAL: ${side.toUpperCase()} @ ${roundTo(entryPrice, 2)} | Stop=${roundTo(stopLoss, 2)} (${roundTo(risk, 2)}pts) | Target=${roundTo(takeProfit, 2)} | Sweep=${this.actualSweepSide} extreme=${roundTo(this.sweepExtreme, 2)}`);
    }

    return {
      strategy: 'SWEEP_REVERSAL',
      action,
      side,
      symbol: this.tradingSymbol,
      price: roundTo(entryPrice, 2),
      stop_loss: roundTo(stopLoss, 2),
      take_profit: roundTo(takeProfit, 2),
      trailing_trigger: this.trailingTrigger,
      trailing_offset: this.trailingOffset,
      quantity: this.defaultQuantity,
      maxHoldBars: this.maxHoldBars || undefined,
      metadata: {
        asianHigh: roundTo(this.asianHigh, 2),
        asianLow: roundTo(this.asianLow, 2),
        asianRange: roundTo(this.asianRange, 2),
        sweepSide: this.actualSweepSide,
        sweepExtreme: roundTo(this.sweepExtreme, 2),
        expectedSweepSide: this.expectedSweepSide,
        predictionConfidence: this.predictionConfidence,
        euroSweptSide: this.euroSweptSide,
        tradingDate: this.tradingDate,
        gexRegime: marketData?.gexLevels?.regime || null,
        gexDistanceToOppositeWall: this._computeGexDistance(candle.close, marketData),
      }
    };
  }

  _computeGexDistance(price, marketData) {
    const gex = marketData?.gexLevels;
    if (!gex) return null;

    if (this.actualSweepSide === 'high') {
      const putWall = gex.put_wall || (gex.support && gex.support[0]);
      return putWall ? roundTo(price - putWall, 2) : null;
    } else {
      const callWall = gex.call_wall || (gex.resistance && gex.resistance[0]);
      return callWall ? roundTo(callWall - price, 2) : null;
    }
  }
}

export default SweepReversalStrategy;
