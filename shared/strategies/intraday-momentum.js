/**
 * Intraday Momentum (Zarattini Concretum-bands breakout) — ES book sleeve.
 *
 * Mechanism (Zarattini-Aziz-Barbon 2024, SSRN 4824172; our 1s-honest build
 * research/intraday-momentum 2026-06-15, re-validated byte-exact 2026-08-09):
 * a vol-scaled "noise band" is anchored to the day open and prior RTH close;
 * a breakout ABOVE the band at a 30-min checkpoint marks a genuine trend day.
 * Convex trend-day capture: no stop, hold to the 15:45 ET cutoff. SHORT side
 * decisively dead; VWAP/band/trailing exits destroy the edge — do not add.
 *
 * Frozen config (parked 2026-06-15, promoted to book sleeve 2026-08-09 under
 * the capacity-constrained doctrine; conditioners tested NULL in I4 —
 * unconditional edge): lookback 14, mult 1.5, LONG-only, checkpoints
 * 10:00/10:30/11:00/11:30 ET (none after 12:00), one entry/day, market entry,
 * no stop/target, exit via max-hold at 15:45 ET.
 * Reference (1s-honest, 2021-02→2026-01): 135 trades, +$50,538/ES contract,
 * PF 1.94, Sharpe 2.67, maxDD $15.5k, WR 66%.
 *
 * Band math (must mirror research/intraday-momentum/02+03 exactly):
 *   open      = today's 09:30 ET 1m bar OPEN
 *   prevClose = prior trading day's 15:59 ET 1m close (fill-forwarded)
 *   sigma[m]  = mean over prior `lookback` days of |mClose[m]/dayOpen - 1|
 *               (mClose fill-forwarded across gaps/half-days; a day counts if
 *               it has an open; need >= max(5, lookback/2) valid days)
 *   UB[m]     = max(open, prevClose) + sigma[m] * mult * open
 *   Entry when checkpoint-instant price > UB[checkpointMinute].
 *
 * DECISION-BAR CONVENTION (the 2026-08-06 lesson, baked in from day one):
 * research evaluates the 1s close AT the checkpoint instant (e.g. 10:00:00).
 * Live/engine equivalent = the 1m bar that CLOSES at the checkpoint — the
 * 09:59/10:29/10:59/11:29-labeled bars — decision price = that bar's close.
 *
 * Live data: ES 1m candles (full session fine; only RTH consumed). Warmup =
 * `lookback` completed RTH days unless seeded (seedHistoricalData fetches
 * daily bars only for sanity; minute-profile seeding comes from the live
 * feed or a TV one-shot backfill — until seeded the strategy stays dormant).
 */

import { BaseStrategy } from './base-strategy.js';
import { isValidCandle, roundTo, etParts, secondsToNextDecision } from './strategy-utils.js';

const ONE_MIN_MS = 60 * 1000;
const RTH_MIN = 390;

export class IntradayMomentumStrategy extends BaseStrategy {
  static getDataRequirements() {
    return { candles: true, gex: false, lt: false, tradier: false, ivSkew: false };
  }

  constructor(params = {}) {
    super(params);

    this.defaultParams = {
      lookback: 14,          // sigma profile days (frozen)
      mult: 1.5,             // band multiplier (frozen)
      minValidDays: 7,       // max(5, lookback/2) — research buildBands guard
      checkpointGrid: 30,    // minutes between entry checkpoints
      firstCheckpointMin: 30,   // first checkpoint = RTH minute 30 (10:00 ET)
      lastCheckpointMin: 120,   // last = RTH minute 120 (11:30; none >= 12:00)
      eodExitHour: 15,       // max-hold target: flat by 15:45 ET
      eodExitMinute: 45,

      allowLongs: true,
      allowShorts: false,    // short side dead (research: adding shorts Sh 2.68->0.55)

      signalCooldownMs: 12 * 60 * 60 * 1000,   // one entry/day
      tradingSymbol: 'ES1!',
      defaultQuantity: 1,
      seedSymbol: 'ES',

      debug: false
    };
    this.params = { ...this.defaultParams, ...params };

    // Completed prior RTH days (most recent last): {open, mClose: Float64Array}
    this.prevDays = [];

    // Current session accumulators (Globex trade_date, same as PCC)
    this.sessTradeDate = null;
    this._resetSession();

    this._lastPrice = null;
    this._lastSignal = null;
    this._firedDate = null;
  }

  _resetSession() {
    this.rthOpen = null;
    this.mClose = new Float64Array(RTH_MIN).fill(NaN);
    this.firedToday = false;
  }

  /** Finalize the ended session into prevDays (fill-forward, require open). */
  _finalizeSession() {
    if (this.rthOpen === null) return;
    let last = this.rthOpen;
    const mc = this.mClose;
    for (let m = 0; m < RTH_MIN; m++) {
      if (isNaN(mc[m])) mc[m] = last;
      else last = mc[m];
    }
    this.prevDays.push({ open: this.rthOpen, mClose: mc });
    if (this.prevDays.length > this.params.lookback) this.prevDays.shift();
  }

  /** ET parts + Globex trade date (bars >= 18:00 ET belong to next session). */
  getETTime(timestamp) {
    const ms = typeof timestamp === 'number' ? timestamp : new Date(timestamp).getTime();
    const s = new Date(ms).toLocaleString('en-US', {
      timeZone: 'America/New_York', year: 'numeric', month: '2-digit',
      day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
    });
    const [datePart, timePart] = s.split(', ');
    const [month, day, year] = datePart.split('/');
    let [hour, minute] = timePart.split(':');
    hour = parseInt(hour); minute = parseInt(minute);
    if (hour === 24) hour = 0;
    const cal = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
    if (hour >= 18) cal.setDate(cal.getDate() + 1);
    const tdKey = `${cal.getFullYear()}-${String(cal.getMonth() + 1).padStart(2, '0')}-${String(cal.getDate()).padStart(2, '0')}`;
    return { hour, minute, hhmm: hour * 100 + minute, tradeDate: tdKey };
  }

  /** Upper band value at RTH minute m, or null while warming up. */
  _upperBand(m) {
    const lb = this.params.lookback;
    const days = this.prevDays;
    if (days.length < 1 || this.rthOpen === null) return null;
    let sum = 0, valid = 0;
    for (const d of days) {
      if (!d.open || isNaN(d.open) || d.open <= 0) continue;
      valid++;
      sum += Math.abs(d.mClose[m] / d.open - 1);
    }
    if (valid < Math.max(this.params.minValidDays, lb >> 1)) return null;
    const prevClose = days[days.length - 1].mClose[RTH_MIN - 1];
    const hi = Math.max(this.rthOpen, prevClose);
    return hi + (sum / valid) * this.params.mult * this.rthOpen;
  }

  evaluateSignal(candle, prevCandle, marketData, options = {}) {
    if (!isValidCandle(candle)) return null;
    const timestamp = this.toMs(candle.timestamp);
    const et = this.getETTime(timestamp);
    this._lastPrice = candle.close;

    if (et.tradeDate !== this.sessTradeDate) {
      if (this.sessTradeDate !== null) this._finalizeSession();
      this.sessTradeDate = et.tradeDate;
      this._resetSession();
    }

    // RTH accumulation (09:30 <= t < 16:00 ET)
    const isRTH = et.hhmm >= 930 && et.hhmm < 1600;
    if (isRTH) {
      const m = (et.hour * 60 + et.minute) - (9 * 60 + 30);
      if (m === 0 && this.rthOpen === null) this.rthOpen = candle.open;
      if (m >= 0 && m < RTH_MIN) this.mClose[m] = candle.close;
    }

    if (!isRTH || this.firedToday || !this.params.allowLongs) return null;

    // Decision: bar CLOSING at a checkpoint => bar minute m with (m+1) on the
    // grid, first..last checkpoint inclusive (10:00 -> RTH minute 30, etc.)
    const barMin = (et.hour * 60 + et.minute) - (9 * 60 + 30);
    const cp = barMin + 1;
    if (cp < this.params.firstCheckpointMin || cp > this.params.lastCheckpointMin
        || cp % this.params.checkpointGrid !== 0) return null;
    if (this.rthOpen === null) return null;
    if (!this.checkCooldown(timestamp, this.params.signalCooldownMs)) return null;

    const ub = this._upperBand(cp);
    if (ub === null) return null;   // warming up (needs `lookback` RTH days)

    const decisionPrice = candle.close;   // price AT the checkpoint instant
    if (decisionPrice <= ub) return null;

    this.firedToday = true;
    this.updateLastSignalTime(timestamp);
    this._firedDate = et.tradeDate;

    // Hold to 15:45 ET: minutes from the checkpoint to the cutoff
    const holdMin = (this.params.eodExitHour * 60 + this.params.eodExitMinute)
      - (9 * 60 + 30 + cp);
    this._lastSignal = { ts: timestamp + ONE_MIN_MS, side: 'buy',
      price: roundTo(decisionPrice), note: `LONG breakout · exit 15:45` };
    if (this.params.debug) {
      console.log(`[ZIM] ${et.tradeDate} LONG cp=${cp}min px=${decisionPrice.toFixed(2)} `
        + `ub=${ub.toFixed(2)} hold=${holdMin}min`);
    }

    return {
      timestamp: timestamp + ONE_MIN_MS,
      side: 'buy',
      action: 'place_market',
      strategy: 'INTRADAY_MOMENTUM',
      symbol: options.symbol || this.params.tradingSymbol,
      price: roundTo(decisionPrice),
      quantity: options.quantity || this.params.defaultQuantity,
      stopLoss: null,          // convex trend capture — no stop by design
      takeProfit: null,
      maxHoldBars: holdMin,    // minutes -> 15:45 ET flat
      metadata: {
        strategy: 'INTRADAY_MOMENTUM',
        direction: 'long',
        checkpoint_min: cp,
        upper_band: roundTo(ub),
        decision_price: roundTo(decisionPrice),
        rth_open: roundTo(this.rthOpen),
        band_dist: roundTo(decisionPrice - ub),
        trading_date: et.tradeDate
      }
    };
  }

  /**
   * Live seeding: the sigma profile needs `lookback` days of per-minute RTH
   * closes — more than the data-service candle buffer holds. The signal-
   * generator factory injects params.seedLoader (TV one-shot ES1! 1m backfill,
   * tv-series-fetcher.fetchZimSeedDays); on any failure the strategy falls
   * back to live-feed warmup (~14 RTH sessions, dormant until then). Engine
   * backtests warm up naturally from the candle stream (no loader injected).
   */
  async seedHistoricalData(_dataServiceUrl) {
    if (typeof this.params.seedLoader !== 'function') return;
    try {
      const days = await this.params.seedLoader();
      if (Array.isArray(days) && days.length >= this.params.minValidDays) {
        this.prevDays = days.slice(-this.params.lookback)
          .map(d => ({ open: d.open, mClose: Float64Array.from(d.mClose) }));
        if (this.params.debug) {
          console.log(`[ZIM] seeded ${this.prevDays.length} RTH days from backfill`);
        }
      }
    } catch (err) {
      if (this.params.debug) console.log(`[ZIM] seed failed (${err.message}) — live warmup`);
    }
  }

  isSeeded() {
    return this.prevDays.length >= Math.max(this.params.minValidDays, this.params.lookback >> 1);
  }

  getInternalState() {
    const now = Date.now();
    const et = etParts(now);
    const seeded = this.isSeeded();
    const isWeekday = et.dow >= 1 && et.dow <= 5;
    const firedToday = this._firedDate === et.dateKey;
    const lastCpPassed = isWeekday
      && et.minutesOfDay > (9 * 60 + 30 + this.params.lastCheckpointMin);

    // Band distance at the NEXT checkpoint (context for the panel)
    let bandVal = null, dist = null;
    if (seeded && this.rthOpen !== null) {
      const rthMin = et.minutesOfDay - (9 * 60 + 30);
      const nextCp = Math.min(
        Math.max(this.params.firstCheckpointMin,
          Math.ceil(Math.max(rthMin, 0) / this.params.checkpointGrid) * this.params.checkpointGrid),
        this.params.lastCheckpointMin);
      const ub = this._upperBand(nextCp);
      if (ub !== null && this._lastPrice != null) {
        bandVal = roundTo(ub);
        dist = roundTo(this._lastPrice - ub);
      }
    }

    let state;
    if (!seeded) state = 'dormant';
    else if (firedToday) state = 'fired';
    else if (!isWeekday || lastCpPassed) state = 'stood-down';
    else state = dist != null && dist > 0 ? 'armed' : 'watching';

    return {
      kind: 'breakout', state, seeded,
      warmupDays: `${this.prevDays.length}/${this.params.lookback}`,
      decision: { label: 'checkpoints 10:00-11:30 ET',
        secondsTo: secondsToNextDecision(now, 10, 0, [1, 2, 3, 4, 5]) },
      direction: 'LONG',
      condition: {
        kind: 'threshold', label: 'Price vs noise band',
        value: dist, valuePts: dist, threshold: 0,
        thresholdPts: bandVal, unit: 'pts', met: dist != null && dist > 0,
        refPrice: bandVal,
      },
      firedToday, lastSignal: this._lastSignal,
    };
  }

  reset() {
    super.reset();
    this.prevDays = [];
    this.sessTradeDate = null;
    this._resetSession();
    this._lastPrice = null;
    this._lastSignal = null;
    this._firedDate = null;
  }

  getName() { return 'INTRADAY_MOMENTUM'; }
  getDescription() { return 'Zarattini noise-band breakout — long ES trend days, hold to 15:45 ET'; }
  getRequiredMarketData() { return []; }
}

export default IntradayMomentumStrategy;
