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

import fs from 'fs';
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

      // Pre-open ET time from which the live ATR14 buffer is re-verified against
      // data-service daily candles (see dailyRefresh)
      refreshStartHhmm: 800,

      allowLongs: true,
      allowShorts: true,

      signalCooldownMs: 12 * 60 * 60 * 1000,

      tradingSymbol: 'NQ1!',
      defaultQuantity: 1,
      seedSymbol: 'NQ',   // data-service root used by seedHistoricalData

      // Optional breadth/stress conditioner (I1/I2 research, 2026-08-08).
      // conditionerFile: CSV `date,trin_1430,cor_chg5` (I3-build-pcc-conditioner.py).
      //   trin_1430 = NYSE TRIN last 1h bar closing <=14:30 ET (same-day, causal);
      //   cor_chg5  = COR1M prior-day close minus close 5 sessions earlier.
      // sizingMode:
      //   'off'    — ignore conditioner entirely (live default; no behavior change)
      //   'trin'   — trade only when TRIN aligns with side (TRIN<1 long / >1 short)
      //   'stress' — trade only when cor_chg5 > corChg5Min (rising correlation)
      //   'either' — trade when at least one condition holds
      //   'ladder' — quantity = defaultQuantity x tier (tier = #conditions true;
      //              tier 0 = no trade)
      conditionerFile: null,
      sizingMode: 'off',
      corChg5Min: 2.27,    // I2 E3 top-tercile edge (plateau >= +2)
      trinNeutral: 1.0,    // canonical TRIN midpoint

      debug: false
    };

    this.params = { ...this.defaultParams, ...params };

    // date -> { trin, cor } (null fields when missing). Backtest-only in
    // practice: live config never sets conditionerFile.
    this.conditioner = null;
    if (this.params.conditionerFile) {
      this.conditioner = new Map();
      const raw = fs.readFileSync(this.params.conditionerFile, 'utf8').trim().split('\n');
      for (let i = 1; i < raw.length; i++) {
        const c = raw[i].split(',');
        if (c.length < 3) continue;
        this.conditioner.set(c[0], {
          trin: c[1] === '' ? null : parseFloat(c[1]),
          cor: c[2] === '' ? null : parseFloat(c[2])
        });
      }
    }

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
    this._condLatest = null;

    // Live ATR re-verification (live only — dailyRefresh is never called by the
    // backtest engine).
    this._refreshedFor = null;
    this._refreshError = null;
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

    // Decision fires on the bar that CLOSES at the decision instant (15:00 ET),
    // i.e. the 14:59-labeled bar. The 15:00-labeled bar doesn't close — and live
    // isn't delivered via candle.close — until 15:01, which shipped signals a
    // minute late with a stale price. The 14:59 close IS the 15:00:00 price the
    // research decided on (B4a: last 1s close before 15:00, entry 15:00:01).
    const decMinOfDay = this.params.decisionHour * 60 + this.params.decisionMinute;
    const barMinOfDay = (decMinOfDay - 1 + 1440) % 1440;
    const decisionBarHHMM = Math.floor(barMinOfDay / 60) * 100 + (barMinOfDay % 60);
    if (et.hhmm !== decisionBarHHMM || this.firedToday) return null;
    this.firedToday = true; // fire-or-skip: one decision per day either way

    if (this.rthOpen === null) return null;
    const atr = this._atr();
    if (atr === null || atr <= 0) return null; // not yet seeded (warmup)
    if (!this.checkCooldown(timestamp, this.params.signalCooldownMs)) return null;

    const decisionPrice = candle.close; // last trade at/just before 15:00:00 ET
    const move = decisionPrice - this.rthOpen;
    if (Math.abs(move) <= this.params.moveAtrMult * atr) return null; // below filter

    const side = move > 0 ? 'long' : 'short';
    if (side === 'long' && !this.params.allowLongs) return null;
    if (side === 'short' && !this.params.allowShorts) return null;

    // Breadth/stress conditioner. Missing VALUE = that condition false
    // (conservative); NO DATA AT ALL for today (live fetch failed) = FAIL OPEN
    // to base 1-lot sizing — a data outage must degrade to the base strategy
    // (confirmed profitable live), never silently disable trading.
    let qty = this.params.defaultQuantity;
    let condMeta = null;
    if (this.params.sizingMode !== 'off') {
      const cond = this.conditioner ? this.conditioner.get(et.tradeDate) : undefined;
      if (!cond || (cond.trin == null && cond.cor == null)) {
        condMeta = { conditioner_missing: true };
      } else {
        const trinAligned = cond.trin != null &&
          ((cond.trin < this.params.trinNeutral) === (side === 'long'));
        const stress = cond.cor != null && cond.cor > this.params.corChg5Min;
        const tier = (trinAligned ? 1 : 0) + (stress ? 1 : 0);
        const mode = this.params.sizingMode;
        if (mode === 'trin' && !trinAligned) return null;
        if (mode === 'stress' && !stress) return null;
        if (mode === 'either' && tier === 0) return null;
        if (mode === 'ladder') {
          if (tier === 0) return null;
          qty = this.params.defaultQuantity * tier;
        }
        condMeta = {
          conditioner_tier: tier,
          trin_1430: cond.trin,
          cor_chg5: cond.cor,
          trin_aligned: trinAligned,
          stress
        };
      }
    }

    this.updateLastSignalTime(timestamp);
    this._firedDate = et.tradeDate;
    this._lastSignal = { ts: timestamp + ONE_MIN_MS, side: side === 'long' ? 'buy' : 'sell',
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
      quantity: options.quantity || qty,
      stopLoss: null,          // no stop — pure clock-locked drift
      takeProfit: null,        // no target — time exit only
      maxHoldBars: this.params.holdBars,
      metadata: {
        strategy: 'PRECLOSE_CONTINUATION',
        direction: side,
        ...(condMeta || {}),
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
    try {
      this.dayRanges = await this._fetchDayRanges(dataServiceUrl);
      if (this.params.debug) {
        const atr = this._atr();
        console.log(`[PCC] seeded ATR14 from ${this.dayRanges.length} daily bars → atr=${atr ? atr.toFixed(1) : 'n/a'}`);
      }
    } catch (err) {
      if (this.params.debug) console.log(`[PCC] seedHistoricalData failed: ${err.message} — building ATR from live candles`);
    }
  }

  /**
   * ATR14 day_range buffer from data-service daily candles, oldest→newest, with
   * today's still-forming bar dropped.
   */
  async _fetchDayRanges(dataServiceUrl) {
    const root = this.params.seedSymbol || 'NQ';
    const res = await fetch(`${dataServiceUrl}/candles/daily?symbol=${root}&count=${this.params.atrPeriod + 6}`);
    if (!res.ok) throw new Error(`daily candles HTTP ${res.status}`);
    const body = await res.json();
    const candles = Array.isArray(body?.candles) ? body.candles.slice() : [];
    if (candles.length < this.params.atrMinPeriods + 1) throw new Error(`only ${candles.length} daily candles`);
    candles.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    // Drop the last (today's still-forming) daily bar; keep the last atrPeriod completed.
    const use = candles.slice(0, -1).slice(-this.params.atrPeriod);
    const ranges = use.map(c => Number(c.high) - Number(c.low)).filter(r => r > 0);
    if (ranges.length < this.params.atrMinPeriods) throw new Error(`only ${ranges.length} usable day ranges`);
    return ranges;
  }

  /**
   * Pre-open re-verification of the rolling ATR14 buffer against data-service —
   * the independent check on the live stream's carry-forward. Called by the
   * multi-strategy engine's run loop (~30s); no-ops outside the window and once
   * it has succeeded for the day. On failure the seeded/stream-built buffer is
   * kept (a slightly stale ATR only mis-sizes the threshold — unlike gapup-fade,
   * no price REFERENCE rides on it), so this never stands the sleeve down.
   */
  async dailyRefresh(dataServiceUrl) {
    if (!dataServiceUrl) return;
    const et = etParts(Date.now());
    if (et.dow < 1 || et.dow > 5) return;
    const startMin = Math.floor(this.params.refreshStartHhmm / 100) * 60 + (this.params.refreshStartHhmm % 100);
    const decisionMin = this.params.decisionHour * 60 + this.params.decisionMinute;
    if (et.minutesOfDay < startMin || et.minutesOfDay >= decisionMin) return;
    if (this._refreshedFor === et.dateKey) return;

    try {
      const ranges = await this._fetchDayRanges(dataServiceUrl);
      const had = this._atr();
      this.dayRanges = ranges;
      this._refreshedFor = et.dateKey;
      this._refreshError = null;
      const now = this._atr();
      if (had !== null && now !== null && Math.abs(now - had) > 1.0) {
        console.warn(`[PCC] ATR14 refreshed before the open: ${had.toFixed(1)} → ${now.toFixed(1)} `
          + `(${ranges.length} daily bars) — the live carry-forward had drifted`);
      } else if (this.params.debug) {
        console.log(`[PCC] ${et.dateKey} ATR14 verified: ${now ? now.toFixed(1) : 'n/a'} from ${ranges.length} daily bars`);
      }
    } catch (err) {
      this._refreshError = err.message;   // keep the existing buffer and retry next tick
    }
  }

  isSeeded() {
    return this.dayRanges.length >= this.params.atrMinPeriods;
  }

  /**
   * Live conditioner injection (multi-strategy engine, ~14:40-14:59 ET via
   * pcc-conditioner-fetcher): today's TRIN reading (last 1h bar closing
   * <=14:30 ET) and prior-day COR1M 5-session change. Same tier logic as the
   * backtest conditionerFile path — this just feeds the same map.
   */
  setLiveConditioner({ date, trin = null, cor = null } = {}) {
    if (!date) return;
    if (!this.conditioner) this.conditioner = new Map();
    this.conditioner.set(date, { trin, cor });
    this._condLatest = { date, trin, cor };
  }

  hasConditionerFor(date) {
    const c = this.conditioner ? this.conditioner.get(date) : undefined;
    return !!c && (c.trin != null || c.cor != null);
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
      conditioner: this.params.sizingMode !== 'off'
        ? { mode: this.params.sizingMode, ...(this._condLatest || { date: null, trin: null, cor: null }) }
        : null,
    };
  }

  /**
   * Session reset (live engine, 18:00 ET Globex boundary). Clears INTRADAY
   * state only. dayRanges is a rolling multi-day ATR14 buffer — wiping it here
   * un-seeds the sleeve every evening, and the only re-seed path (data.ready)
   * fires on an incidental Schwab reconnect, so the strategy sat "warming up"
   * from 18:00 ET until whenever the streamer next reconnected.
   *
   * Finalize FIRST. This reset lands at 18:00 ET, the same boundary the Globex
   * trade_date rolls on, and always beats the 18:00 bar's ~18:01 delivery — so
   * nulling sessTradeDate here skipped the tradeDate-change branch in
   * evaluateSignal that is the only other caller of _finalizeSession(), and the
   * day's range was never appended: ATR14 stayed frozen at its seed value until
   * the next process restart. Guarded by fullRthMinBars, so a partial or
   * off-hours reset contributes nothing.
   */
  reset() {
    super.reset();
    this._finalizeSession();
    this.sessTradeDate = null;
    this._resetSession();
    this._lastPrice = null;
    this._lastSignal = null;
    this._firedDate = null;
    this._condLatest = null;
  }

  getName() { return 'PRECLOSE_CONTINUATION'; }
  getDescription() { return 'Pre-Close Continuation — ride the 15:00->15:30 dealer re-hedge flow on trended days'; }
  getRequiredMarketData() { return []; }
}

export default PreCloseContinuationStrategy;
