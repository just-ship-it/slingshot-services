/**
 * Monday Strength (MON)
 *
 * Mechanism (greenfield R7 census + B7 1s sim, 2026-07-18): NQ exhibits a
 * persistent Monday RTH long drift — weekend risk-premium / start-of-week
 * re-risking flow. Census: 09:30→16:00 ET +24.6 pt, positive 6 of 7 years,
 * ES-replicated (+5.1 pt, t=2.32). 1s sim (frozen, 09:30 long → 15:45 flat,
 * no stop): dev 2021-24 PF 1.316 → LOCKED 2025-26 PF 1.677 (strengthened OOS).
 *
 * Rule: on Mondays, enter 1 contract LONG at the 09:30 ET RTH open. No stop,
 * no target. Exit via max-hold time at 15:45 ET (holdBars=375 min from 09:30) —
 * self-contained on the existing max-hold pattern, no EOD-cutoff wiring needed.
 *
 * HONEST RISK: this is long-only session BETA/momentum, not a two-sided edge.
 * It bleeds in sustained downtrends (lost in 2022, the one bear year) and its
 * drawdown is large for its return. In the book it is valued as a diversifier
 * (corr ≈ -0.02 with the pre-close edge, ~40% book-DD reduction), NOT as a
 * standalone core. Size accordingly.
 *
 * Book: greenfield/explore/book-monday-daily.csv ; sim: B7-dow-drift.md.
 */

import { BaseStrategy } from './base-strategy.js';
import { isValidCandle, roundTo, etParts, secondsToNextDecision } from './strategy-utils.js';

const ONE_MIN_MS = 60 * 1000;

export class MondayStrengthStrategy extends BaseStrategy {
  static getDataRequirements() {
    return { candles: true, gex: false, lt: false, tradier: false, ivSkew: false };
  }

  constructor(params = {}) {
    super(params);

    this.defaultParams = {
      // Entry anchor: the RTH open, Eastern Time
      rthOpenHour: 9,
      rthOpenMinute: 30,
      // Enter this many minutes BEFORE the open (fire on the bar closing at
      // 09:30 - lead). Default 1 -> decision on the 09:28-labeled bar, entry
      // stamps ~09:29:03 live. Measured on the 249-Monday 1s history
      // (2026-08-10): pre-open drift +1.3pt/trade in the final minute
      // (t=2.2-3.1) AND the first RTH second trades a 6-13pt range vs ~1.3pt
      // pre-open — entering early both captures the drift tail and removes
      // the unmodelable open-second slippage die-roll. Set 0 for the original
      // frozen at-the-open behavior.
      preOpenLeadMin: 1,
      // Monday = day-of-week 1 (JS getDay: 0=Sun,1=Mon)
      tradeDow: 1,
      // Exit via max-hold time anchored to the 15:45 ET production flat:
      // maxHold = holdBars + preOpenLeadMin so the exit time is invariant to
      // the entry lead. Self-contained on the existing max-hold pattern.
      holdBars: 375,
      tradingSymbol: 'NQ1!',
      defaultQuantity: 1,
      signalCooldownMs: 12 * 60 * 60 * 1000,
      debug: false
    };

    this.params = { ...this.defaultParams, ...params };
    this.currentTradingDate = null;
    this.firedToday = false;
    this._lastSignal = null;   // status panel
    this._firedDate = null;
  }

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
    if (hour === 24) hour = 0;
    return {
      hour, minute, hhmm: hour * 100 + minute,
      dateKey: `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`,
      dow: new Date(parseInt(year), parseInt(month) - 1, parseInt(day)).getDay()
    };
  }

  evaluateSignal(candle, prevCandle, marketData, options = {}) {
    if (!isValidCandle(candle)) return null;

    const timestamp = this.toMs(candle.timestamp);
    const et = this.getETTime(timestamp);

    if (et.dateKey !== this.currentTradingDate) {
      this.currentTradingDate = et.dateKey;
      this.firedToday = false;
    }

    // Only Mondays, once per day, on the bar that CLOSES at (09:30 - lead) —
    // with the default lead of 1 that is the 09:28-labeled bar, whose close
    // arrives live ~09:29:02, so the market entry stamps ~09:29:03: inside the
    // calm pre-open tape, ahead of the 09:30:00 chaos second. (lead 0 = the
    // original at-the-open behavior via the 09:29-labeled bar.)
    if (et.dow !== this.params.tradeDow) return null;
    const lead = this.params.preOpenLeadMin || 0;
    const openMinOfDay = this.params.rthOpenHour * 60 + this.params.rthOpenMinute;
    const barMinOfDay = (openMinOfDay - 1 - lead + 1440) % 1440;
    if (et.hhmm !== Math.floor(barMinOfDay / 60) * 100 + (barMinOfDay % 60)) return null;
    if (this.firedToday) return null;
    if (!this.checkCooldown(timestamp, this.params.signalCooldownMs)) return null;

    this.firedToday = true;
    this.updateLastSignalTime(timestamp);
    const entryPrice = candle.close; // last print before the entry instant
    this._firedDate = et.dateKey;
    this._lastSignal = { ts: timestamp + ONE_MIN_MS, side: 'buy', price: roundTo(entryPrice), note: 'LONG · exit 15:45' };

    if (this.params.debug) {
      console.log(`[MON] ${et.dateKey} Monday LONG @ open ${entryPrice.toFixed(2)} → 15:45 flat`);
    }

    return {
      timestamp: timestamp + ONE_MIN_MS,
      side: 'buy',
      action: 'place_market',
      strategy: 'MONDAY_STRENGTH',
      symbol: options.symbol || this.params.tradingSymbol,
      price: roundTo(entryPrice),
      quantity: options.quantity || this.params.defaultQuantity,
      stopLoss: null,   // no stop
      takeProfit: null, // no target — EOD-cutoff time exit
      // exit time invariant at 15:45 ET regardless of entry lead
      maxHoldBars: this.params.holdBars + lead,
      metadata: {
        strategy: 'MONDAY_STRENGTH',
        direction: 'long',
        entry_lead_min: lead,
        rth_open: roundTo(entryPrice),
        trading_date: et.dateKey
      }
    };
  }

  /**
   * Readiness snapshot for the dashboard book panel. Unconditional strategy —
   * "distance" is purely the countdown to the next Monday 09:30 open.
   */
  getInternalState() {
    const now = Date.now();
    const et = etParts(now);
    const decMin = this.params.rthOpenHour * 60 + this.params.rthOpenMinute;
    const isMon = et.dow === this.params.tradeDow;
    const decisionPassed = isMon && et.minutesOfDay >= decMin;
    const firedToday = this._firedDate === et.dateKey;

    let state;
    if (firedToday) state = 'fired';
    else if (!isMon) state = 'dormant';
    else if (decisionPassed) state = 'stood-down';
    else state = 'armed'; // Monday pre-open — unconditional, certain to fire

    const lead = this.params.preOpenLeadMin || 0;
    return {
      kind: 'monday', state, seeded: true, atr14: null,
      decision: { label: lead ? `Mon 09:${30 - lead} ET (pre-open)` : 'Mon 09:30 ET',
        secondsTo: secondsToNextDecision(now, this.params.rthOpenHour, this.params.rthOpenMinute, [this.params.tradeDow]) },
      direction: 'LONG',
      condition: { kind: 'unconditional', label: 'Fires at the Monday open', met: state === 'armed' ? true : null },
      firedToday, lastSignal: this._lastSignal,
    };
  }

  reset() {
    super.reset();
    this.currentTradingDate = null;
    this.firedToday = false;
    this._lastSignal = null;
    this._firedDate = null;
  }

  getName() { return 'MONDAY_STRENGTH'; }
  getDescription() { return 'Monday Strength — long the Monday RTH open to the 15:45 ET flat (weekend re-risking drift)'; }
  getRequiredMarketData() { return []; }
}

export default MondayStrengthStrategy;
