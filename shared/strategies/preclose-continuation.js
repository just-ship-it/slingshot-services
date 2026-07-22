/**
 * Pre-Close Continuation (PCC)
 *
 * Mechanism (greenfield/explore R2 + B4a, 2026-07-17): options dealers and other
 * systematic hedgers must re-hedge into the close and execute the bulk of it
 * BEFORE the 15:50 ET market-on-close imbalance publication. That forced flow
 * pushes price further in the direction the day has already travelled. This is a
 * clock-locked flow, not generic momentum — the identical construction at 12:00 /
 * 13:00 / 14:00 shows nothing; only the 15:00->15:30 window works.
 *
 * Rule (frozen config, independently raw-data-verified):
 *   At 15:00 ET, day_move = 15:00 price - 09:30 RTH open.
 *   If |day_move| > moveAtrMult * ATR14(prior-day, full-session daily range):
 *     enter 1 contract MARKET in the direction of day_move (long up-day / short
 *     down-day). No stop, no target. Exit MARKET after holdBars minutes (15:30).
 *
 * ATR14 convention (V1 verification pinned this — must match exactly):
 *   Globex trade_date (ET bars >= 18:00 belong to the NEXT day's session).
 *   day_range = max(onHigh, rthHigh) - min(onLow, rthLow)  [ON = 18:00->09:29,
 *   RTH = 09:30->15:59; 16:00-16:59 settlement + 17:00-17:59 halt excluded].
 *   ATR14 = mean of the prior 14 FULL days' day_range (min 10), strictly prior.
 *   -> Computed in-strategy from the candle stream: no external file, live-ready.
 *   Requires the full session to be fed (run backtests without an RTH-only session
 *   filter; live: the 24h candle feed already supplies overnight bars).
 *
 * Verified backtest (this engine port target — full period 2021-04 -> 2026-06,
 * 1 NQ contract): ~709 trades, PF ~1.50, ~+$84.7k net; locked 2025-2026 PF 1.57.
 * Research: greenfield/explore/B4-preclose-expiry.md, V1-b4-verification.md.
 */

import { BaseStrategy } from './base-strategy.js';
import { isValidCandle, roundTo, etParts, secondsToNextDecision } from './strategy-utils.js';

const ONE_MIN_MS = 60 * 1000;

export class PreCloseContinuationStrategy extends BaseStrategy {
  static getDataRequirements() {
    return { candles: true, gex: false, lt: false, tradier: false, ivSkew: false };
  }

  constructor(params = {}) {
    super(params);

    this.defaultParams = {
      // Entry filter: |day move| must exceed this * ATR14 to trade (frozen: 0.30)
      moveAtrMult: 0.30,

      // ATR14 = mean of prior N full-session daily ranges (min minPeriods)
      atrPeriod: 14,
      atrMinPeriods: 10,

      // RTH open (day-move anchor) and decision time, Eastern Time
      rthOpenHour: 9,
      rthOpenMinute: 30,
      decisionHour: 15,
      decisionMinute: 0,

      // Hold: exit via max_hold_time this many 1m bars after entry (30 -> 15:30)
      holdBars: 30,

      // A session needs >= this many RTH 1m bars to count as a FULL day for ATR
      fullRthMinBars: 300,

      allowLongs: true,
      allowShorts: true,

      signalCooldownMs: 12 * 60 * 60 * 1000,

      tradingSymbol: 'NQ1!',
      defaultQuantity: 1,
      seedSymbol: 'NQ',   // data-service root used by seedHistoricalData

      debug: false
    };

    this.params = { ...this.defaultParams, ...params };

    // Rolling buffer of prior FULL-day ranges (most recent last); ATR = mean.
    this.dayRanges = [];

    // Current-session accumulators (Globex trade_date)
    this.sessTradeDate = null;
    this._resetSession();

    // Status-panel state (getInternalState): last observed price, last emitted
    // signal, the ET date we last fired, and the decision-time move evaluation.
    this._lastPrice = null;
    this._lastSignal = null;
    this._firedDate = null;
  }

  _resetSession() {
    this.onHigh = null;
    this.onLow = null;
    this.rthHigh = null;
    this.rthLow = null;
    this.rthOpen = null;
    this.rthBarCount = 0;
    this.firedToday = false;
  }

  /**
   * Finalize the session that just ended: if it was a full RTH day, append its
   * full-session day_range to the ATR buffer (keeping the last atrPeriod).
   */
  _finalizeSession() {
    if (this.rthBarCount >= this.params.fullRthMinBars &&
        this.rthHigh !== null && this.rthLow !== null) {
      const hi = this.onHigh !== null ? Math.max(this.onHigh, this.rthHigh) : this.rthHigh;
      const lo = this.onLow !== null ? Math.min(this.onLow, this.rthLow) : this.rthLow;
      this.dayRanges.push(hi - lo);
      if (this.dayRanges.length > this.params.atrPeriod) this.dayRanges.shift();
    }
  }

  /** ET components + Globex trade_date key (bars >= 18:00 -> next day's session). */
  getETTime(timestamp) {
    const ms = typeof timestamp === 'number' ? timestamp : new Date(timestamp).getTime();
    const date = new Date(ms);
    const s = date.toLocaleString('en-US', {
      timeZone: 'America/New_York', year: 'numeric', month: '2-digit',
      day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
    });
    const [datePart, timePart] = s.split(', ');
    const [month, day, year] = datePart.split('/');
    let [hour, minute] = timePart.split(':');
    hour = parseInt(hour); minute = parseInt(minute);
    if (hour === 24) hour = 0; // en-US midnight quirk
    // Globex trade_date: bars at/after 18:00 ET belong to the next calendar day.
    const cal = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
    if (hour >= 18) cal.setDate(cal.getDate() + 1);
    const tdKey = `${cal.getFullYear()}-${String(cal.getMonth() + 1).padStart(2, '0')}-${String(cal.getDate()).padStart(2, '0')}`;
    return { hour, minute, hhmm: hour * 100 + minute, tradeDate: tdKey };
  }

  /** ATR14 from prior full days (null until minPeriods reached). */
  _atr() {
    if (this.dayRanges.length < this.params.atrMinPeriods) return null;
    return this.dayRanges.reduce((a, b) => a + b, 0) / this.dayRanges.length;
  }

  evaluateSignal(candle, prevCandle, marketData, options = {}) {
    if (!isValidCandle(candle)) return null;

    const timestamp = this.toMs(candle.timestamp);
    const et = this.getETTime(timestamp);
    this._lastPrice = candle.close; // for live day-move in getInternalState

    // New Globex session -> finalize the one that ended, reset accumulators.
    if (et.tradeDate !== this.sessTradeDate) {
      if (this.sessTradeDate !== null) this._finalizeSession();
      this.sessTradeDate = et.tradeDate;
      this._resetSession();
    }

    // Classify the bar's session and accumulate extremes.
    const isRTH = et.hhmm >= 930 && et.hhmm < 1600;
    const isON = et.hhmm >= 1800 || et.hhmm < 930;

    if (isON) {
      this.onHigh = this.onHigh === null ? candle.high : Math.max(this.onHigh, candle.high);
      this.onLow = this.onLow === null ? candle.low : Math.min(this.onLow, candle.low);
    } else if (isRTH) {
      if (et.hhmm === this.params.rthOpenHour * 100 + this.params.rthOpenMinute && this.rthOpen === null) {
        this.rthOpen = candle.open;
      }
      this.rthHigh = this.rthHigh === null ? candle.high : Math.max(this.rthHigh, candle.high);
      this.rthLow = this.rthLow === null ? candle.low : Math.min(this.rthLow, candle.low);
      this.rthBarCount++;
    }

    // Decision only at the 15:00 RTH bar, once per day.
    const decisionHHMM = this.params.decisionHour * 100 + this.params.decisionMinute;
    if (et.hhmm !== decisionHHMM || this.firedToday) return null;
    this.firedToday = true; // fire-or-skip: one decision per day either way

    if (this.rthOpen === null) return null;
    const atr = this._atr();
    if (atr === null || atr <= 0) return null; // not yet seeded (warmup)
    if (!this.checkCooldown(timestamp, this.params.signalCooldownMs)) return null;

    const decisionPrice = candle.open; // price at 15:00:00 ET
    const move = decisionPrice - this.rthOpen;
    if (Math.abs(move) <= this.params.moveAtrMult * atr) return null; // below filter

    const side = move > 0 ? 'long' : 'short';
    if (side === 'long' && !this.params.allowLongs) return null;
    if (side === 'short' && !this.params.allowShorts) return null;

    this.updateLastSignalTime(timestamp);
    this._firedDate = et.tradeDate;
    this._lastSignal = { ts: timestamp, side: side === 'long' ? 'buy' : 'sell',
      price: roundTo(decisionPrice), note: `${side.toUpperCase()} · exit 15:30` };
    if (this.params.debug) {
      console.log(`[PCC] ${et.tradeDate} ${side.toUpperCase()} move=${move.toFixed(1)} `
        + `atr14=${atr.toFixed(1)} thr=${(this.params.moveAtrMult * atr).toFixed(1)} `
        + `entry~${decisionPrice.toFixed(2)}`);
    }

    return {
      timestamp: timestamp + ONE_MIN_MS,
      side: side === 'long' ? 'buy' : 'sell',
      action: 'place_market',
      strategy: 'PRECLOSE_CONTINUATION',
      symbol: options.symbol || this.params.tradingSymbol,
      price: roundTo(decisionPrice),
      quantity: options.quantity || this.params.defaultQuantity,
      stopLoss: null,          // no stop — pure clock-locked drift
      takeProfit: null,        // no target — time exit only
      maxHoldBars: this.params.holdBars,
      metadata: {
        strategy: 'PRECLOSE_CONTINUATION',
        direction: side,
        day_move: roundTo(move),
        atr14_prior: roundTo(atr),
        move_threshold: roundTo(this.params.moveAtrMult * atr),
        rth_open: roundTo(this.rthOpen),
        decision_price: roundTo(decisionPrice),
        trading_date: et.tradeDate
      }
    };
  }

  /**
   * Seed the ATR14 buffer from data-service daily candles so the strategy can
   * trade from day one instead of waiting ~14 live sessions. TradingView daily
   * candles use 18:00 ET session boundaries — the SAME Globex trade_date this
   * strategy uses — so a completed daily bar's (high - low) IS the full-session
   * day_range. Called once at startup by the signal-generator (multi-strategy
   * engine seedStrategies). Best-effort: on any failure it silently falls back
   * to building ATR from live candles.
   */
  async seedHistoricalData(dataServiceUrl) {
    const root = this.params.seedSymbol || 'NQ';
    try {
      const res = await fetch(`${dataServiceUrl}/candles/daily?symbol=${root}&count=${this.params.atrPeriod + 6}`);
      if (!res.ok) throw new Error(`daily candles HTTP ${res.status}`);
      const body = await res.json();
      const candles = Array.isArray(body?.candles) ? body.candles.slice() : [];
      if (candles.length < this.params.atrMinPeriods + 1) {
        if (this.params.debug) console.log(`[PCC] seed: only ${candles.length} daily candles — building ATR from live bars`);
        return;
      }
      candles.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
      // Drop the last (today's still-forming) daily bar; keep the last atrPeriod completed.
      const use = candles.slice(0, -1).slice(-this.params.atrPeriod);
      this.dayRanges = use.map(c => Number(c.high) - Number(c.low)).filter(r => r > 0);
      if (this.params.debug) {
        const atr = this._atr();
        console.log(`[PCC] seeded ATR14 from ${this.dayRanges.length} daily bars → atr=${atr ? atr.toFixed(1) : 'n/a'}`);
      }
    } catch (err) {
      if (this.params.debug) console.log(`[PCC] seedHistoricalData failed: ${err.message} — building ATR from live candles`);
    }
  }

  isSeeded() {
    return this.dayRanges.length >= this.params.atrMinPeriods;
  }

  /**
   * Readiness snapshot for the dashboard book panel. Reports how close the
   * strategy is to firing: the countdown to the 15:00 decision plus the live
   * day-move vs the 0.30×ATR threshold. States: armed | watching | fired |
   * stood-down | dormant.
   */
  getInternalState() {
    const now = Date.now();
    const et = etParts(now);
    const atr = this._atr();
    const seeded = this.isSeeded();
    const decMin = this.params.decisionHour * 60 + this.params.decisionMinute;
    const isWeekday = et.dow >= 1 && et.dow <= 5;
    const decisionPassed = isWeekday && et.minutesOfDay >= decMin;
    const firedToday = this._firedDate === et.dateKey;

    let moveP = null, moveAtr = null, direction = null, met = null;
    if (this.rthOpen != null && this._lastPrice != null) {
      moveP = this._lastPrice - this.rthOpen;
      if (atr) { moveAtr = moveP / atr; met = Math.abs(moveP) > this.params.moveAtrMult * atr; }
      direction = moveP > 0 ? 'LONG' : (moveP < 0 ? 'SHORT' : null);
    }

    let state;
    if (!seeded) state = 'dormant';
    else if (firedToday) state = 'fired';
    else if (!isWeekday) state = 'dormant';
    else if (decisionPassed) state = 'stood-down';
    else state = met === true ? 'armed' : 'watching';

    const thrPts = atr ? this.params.moveAtrMult * atr : null;
    return {
      kind: 'preclose', state, seeded, atr14: atr ? roundTo(atr, 1) : null,
      decision: { label: '15:00 ET', secondsTo: secondsToNextDecision(now, this.params.decisionHour, this.params.decisionMinute, [1, 2, 3, 4, 5]) },
      direction: firedToday && this._lastSignal ? (this._lastSignal.side === 'buy' ? 'LONG' : 'SHORT') : direction,
      condition: {
        kind: 'threshold', label: 'Day move vs threshold',
        value: moveAtr != null ? roundTo(moveAtr, 2) : null,
        valuePts: moveP != null ? roundTo(moveP, 0) : null,
        threshold: this.params.moveAtrMult, thresholdPts: thrPts != null ? roundTo(thrPts, 0) : null,
        unit: 'ATR', met, refPrice: this.rthOpen != null ? roundTo(this.rthOpen, 0) : null,
      },
      firedToday, lastSignal: this._lastSignal,
    };
  }

  reset() {
    super.reset();
    this.dayRanges = [];
    this.sessTradeDate = null;
    this._resetSession();
    this._lastPrice = null;
    this._lastSignal = null;
    this._firedDate = null;
  }

  getName() { return 'PRECLOSE_CONTINUATION'; }
  getDescription() { return 'Pre-Close Continuation — ride the 15:00->15:30 dealer re-hedge flow on trended days'; }
  getRequiredMarketData() { return []; }
}

export default PreCloseContinuationStrategy;
