/**
 * Gap-Up Fade (GUF) — the book's downside HEDGE.
 *
 * Mechanism (greenfield R8 census + B9 1s sim, 2026-07-18): a large opening
 * gap UP over-extends and reliably fades back through the morning — index gap-ups
 * exhaust while the up-drift that rescues them only kicks in later in the day.
 * SHORT the exhaustion. Census/1s: full-sample PF 1.61, locked 2025-26 PF 2.07;
 * loses ONLY in melt-up 2021 (when the long book wins), pays hardest in down/vol
 * years (2025 +$26k) — a genuine negative-correlation hedge for the long edges.
 *
 * Rule: at the 09:30 ET RTH open, gap = open − prior RTH close. If
 * gap >= gapAtrMult * ATR14(prior-day, full-session), SHORT 1 contract at the
 * open. No stop, no target. Exit at 11:00 ET (maxHoldBars minutes from 09:30).
 *
 * ATR14 convention: identical to preclose-continuation.js (Globex trade_date,
 * day_range = max(onHigh,rthHigh)−min(onLow,rthLow), mean of prior 14 full days) —
 * computed in-strategy, no external file; needs the full-session feed.
 * Prior RTH close is tracked from the stream (the last RTH bar's close). Run on
 * CONTINUOUS data (default) so the gap is roll-adjusted — a maxGapAtr sanity cap
 * guards against data glitches / any residual roll artifact.
 *
 * HONEST NOTE: standalone it fails the strict "positive every year" bar (2021
 * melt-up) — it is a HEDGE sleeve, valued by its composite contribution (adds PnL
 * for ~zero added book drawdown), not as a standalone core.
 */

import { BaseStrategy } from './base-strategy.js';
import { isValidCandle, roundTo, etParts, secondsToNextDecision } from './strategy-utils.js';

const ONE_MIN_MS = 60 * 1000;

export class GapUpFadeStrategy extends BaseStrategy {
  static getDataRequirements() {
    return { candles: true, gex: false, lt: false, tradier: false, ivSkew: false };
  }

  constructor(params = {}) {
    super(params);

    this.defaultParams = {
      gapAtrMult: 0.50,        // short if gap >= this * ATR14 (frozen research K=0.5,
                               // PF 1.61; 0.30 is a more-inclusive tested band, 5/6yr)
      maxGapAtr: 3.0,          // skip absurd gaps (roll artifact / data glitch)
      atrPeriod: 14,
      atrMinPeriods: 10,
      rthOpenHour: 9,
      rthOpenMinute: 30,
      holdBars: 90,            // 09:30 -> 11:00 ET
      fullRthMinBars: 300,

      // Live re-verification of the prior RTH close (see dailyRefresh). Window
      // runs from refreshStartHhmm ET to one minute before the decision bar.
      refreshStartHhmm: 800,
      maxRefAgeDays: 7,        // a prior-close reference older than this is never traded on
      refToleranceP: 1.0,      // |points| disagreement counted as a correction (logged loudly)

      tradingSymbol: 'NQ1!',
      defaultQuantity: 1,
      seedSymbol: 'NQ',   // data-service root used by seedHistoricalData
      signalCooldownMs: 12 * 60 * 60 * 1000,
      debug: false
    };
    this.params = { ...this.defaultParams, ...params };

    this.dayRanges = [];
    this.sessTradeDate = null;
    this.priorRthClose = null;      // prior trade_date's last RTH close
    this.priorRthCloseDate = null;  // the trade_date that close belongs to
    this._resetSession();

    // Live re-verification state (live only — set by seedHistoricalData /
    // dailyRefresh, which the backtest engine never calls).
    this._liveMode = false;
    this._verifiedFor = null;    // ET dateKey the reference was last re-verified for
    this._refreshError = null;
    this._lastRefresh = null;

    // Status-panel state (getInternalState).
    this._lastSignal = null;
    this._firedDate = null;
    this._lastGapEval = null;    // { date, gapPts, gapAtr, met } — set at the 09:30 decision, fired or not
  }

  _resetSession() {
    this.onHigh = null; this.onLow = null;
    this.rthHigh = null; this.rthLow = null; this.rthClose = null;
    this.rthOpen = null; this.rthBarCount = 0;
    this.firedToday = false;
  }

  _finalizeSession() {
    if (this.rthBarCount >= this.params.fullRthMinBars &&
        this.rthHigh !== null && this.rthLow !== null) {
      const hi = this.onHigh !== null ? Math.max(this.onHigh, this.rthHigh) : this.rthHigh;
      const lo = this.onLow !== null ? Math.min(this.onLow, this.rthLow) : this.rthLow;
      this.dayRanges.push(hi - lo);
      if (this.dayRanges.length > this.params.atrPeriod) this.dayRanges.shift();
      if (this.rthClose !== null) {
        this.priorRthClose = this.rthClose;              // carry for next day's gap
        this.priorRthCloseDate = this.sessTradeDate;
      }
    }
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
    const cal = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
    if (hour >= 18) cal.setDate(cal.getDate() + 1);
    const tdKey = `${cal.getFullYear()}-${String(cal.getMonth() + 1).padStart(2, '0')}-${String(cal.getDate()).padStart(2, '0')}`;
    return { hour, minute, hhmm: hour * 100 + minute, tradeDate: tdKey };
  }

  _atr() {
    if (this.dayRanges.length < this.params.atrMinPeriods) return null;
    return this.dayRanges.reduce((a, b) => a + b, 0) / this.dayRanges.length;
  }

  /** Whole calendar days from dateKey `from` to dateKey `to` (both YYYY-MM-DD). */
  _dayAge(from, to) {
    const utc = k => { const [y, m, d] = k.split('-').map(Number); return Date.UTC(y, m - 1, d); };
    return Math.round((utc(to) - utc(from)) / 86400000);
  }

  evaluateSignal(candle, prevCandle, marketData, options = {}) {
    if (!isValidCandle(candle)) return null;

    const timestamp = this.toMs(candle.timestamp);
    const et = this.getETTime(timestamp);

    if (et.tradeDate !== this.sessTradeDate) {
      if (this.sessTradeDate !== null) this._finalizeSession();
      this.sessTradeDate = et.tradeDate;
      this._resetSession();
    }

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
      this.rthClose = candle.close; // last RTH bar seen = session close so far
      this.rthBarCount++;
    }

    // Decision fires on the bar that CLOSES at the 09:30 RTH open — i.e. the
    // 09:29-labeled bar. Live, candle.close for the 09:30-labeled bar only
    // arrives at 09:31, which measured the gap late and entered a minute after
    // the open. The 09:29 close is the last pre-open print ≈ the 09:30 open.
    const openMinOfDay = this.params.rthOpenHour * 60 + this.params.rthOpenMinute;
    const barMinOfDay = (openMinOfDay - 1 + 1440) % 1440;
    if (et.hhmm !== Math.floor(barMinOfDay / 60) * 100 + (barMinOfDay % 60) || this.firedToday) return null;
    this.firedToday = true;

    if (this.priorRthClose === null) return null;

    // The gap IS the signal, and it is measured entirely against priorRthClose —
    // a stale reference does not degrade the edge, it manufactures a phantom gap
    // out of several sessions of drift. Live, refuse to trade unless dailyRefresh
    // re-verified the reference against data-service this morning; in every mode,
    // refuse a reference that is not from a recent prior session. (2026-08-28: a
    // reference frozen 4 sessions back turned a −64pt gap DOWN into a +529pt
    // "gap up" and fired a live short.)
    const refAge = this.priorRthCloseDate === null ? null : this._dayAge(this.priorRthCloseDate, et.tradeDate);
    let refBlock = null;
    if (this._liveMode && this._verifiedFor !== et.tradeDate) {
      refBlock = this._refreshError
        || 'prior RTH close was not re-verified against data-service before the open';
    } else if (refAge !== null && (refAge < 1 || refAge > this.params.maxRefAgeDays)) {
      refBlock = `prior RTH close is dated ${this.priorRthCloseDate} (${refAge}d before ${et.tradeDate}) `
        + `— outside 1..${this.params.maxRefAgeDays}d`;
    }
    if (refBlock) {
      this._lastGapEval = { date: et.tradeDate, gapPts: null, gapAtr: null, atr: this._atr(), met: false, blocked: refBlock };
      console.warn(`[GUF] ${et.tradeDate} STOOD DOWN — ${refBlock}`);
      return null;
    }

    const atr = this._atr();
    if (atr === null || atr <= 0) return null;
    if (!this.checkCooldown(timestamp, this.params.signalCooldownMs)) return null;

    const gap = candle.close - this.priorRthClose;
    const gapAtr = gap / atr;
    const gapMet = gapAtr >= this.params.gapAtrMult && gapAtr <= this.params.maxGapAtr;
    // Record the decision-time gap for the status panel — fired or not.
    this._lastGapEval = { date: et.tradeDate, gapPts: gap, gapAtr, atr, met: gapMet, blocked: null };
    if (gapAtr < this.params.gapAtrMult) return null;          // not a large gap-up
    if (gapAtr > this.params.maxGapAtr) return null;           // roll/glitch guard

    const entryPrice = candle.close; // last pre-open print ≈ the 09:30 open
    if (this.params.debug) {
      console.log(`[GUF] ${et.tradeDate} SHORT gap=${gap.toFixed(1)} (${gapAtr.toFixed(2)}ATR) `
        + `atr14=${atr.toFixed(1)} entry~${entryPrice.toFixed(2)} → 11:00`);
    }

    this._firedDate = et.tradeDate;
    this._lastSignal = { ts: timestamp + ONE_MIN_MS, side: 'sell', price: roundTo(entryPrice), note: 'SHORT · exit 11:00' };

    return {
      timestamp: timestamp + ONE_MIN_MS,
      side: 'sell',
      action: 'place_market',
      strategy: 'GAPUP_FADE',
      symbol: options.symbol || this.params.tradingSymbol,
      price: roundTo(entryPrice),
      quantity: options.quantity || this.params.defaultQuantity,
      stopLoss: null,
      takeProfit: null,
      maxHoldBars: this.params.holdBars,
      metadata: {
        strategy: 'GAPUP_FADE',
        direction: 'short',
        gap: roundTo(gap),
        gap_atr: roundTo(gapAtr),
        atr14_prior: roundTo(atr),
        prior_rth_close: roundTo(this.priorRthClose),
        rth_open: roundTo(entryPrice),
        trading_date: et.tradeDate
      }
    };
  }

  /**
   * ATR14 day_range buffer from data-service daily candles. TV daily bars use
   * 18:00-ET session boundaries — the same Globex trade_date this strategy uses —
   * so a completed daily bar's (high − low) IS the full-session day_range.
   * Returns oldest→newest ranges with today's still-forming bar dropped, or null
   * if the feed can't supply enough completed sessions.
   */
  async _fetchDayRanges(dataServiceUrl) {
    const root = this.params.seedSymbol || 'NQ';
    const res = await fetch(`${dataServiceUrl}/candles/daily?symbol=${root}&count=${this.params.atrPeriod + 6}`);
    if (!res.ok) throw new Error(`daily candles HTTP ${res.status}`);
    const body = await res.json();
    const candles = Array.isArray(body?.candles) ? body.candles.slice() : [];
    if (candles.length < this.params.atrMinPeriods + 1) {
      throw new Error(`only ${candles.length} daily candles`);
    }
    candles.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    const use = candles.slice(0, -1).slice(-this.params.atrPeriod);
    const ranges = use.map(c => Number(c.high) - Number(c.low)).filter(r => r > 0);
    if (ranges.length < this.params.atrMinPeriods) throw new Error(`only ${ranges.length} usable day ranges`);
    return ranges;
  }

  /**
   * Prior session's RTH close from data-service hourly candles: the last 15:00-ET
   * bar that has finished (its close is the 15:59 print ≈ the 16:00 RTH close).
   * Returns { close, dateKey }.
   */
  async _fetchPriorRthClose(dataServiceUrl) {
    const root = this.params.seedSymbol || 'NQ';
    const res = await fetch(`${dataServiceUrl}/candles/hourly?symbol=${root}&count=48`);
    if (!res.ok) throw new Error(`hourly candles HTTP ${res.status}`);
    const body = await res.json();
    const hc = Array.isArray(body?.candles) ? body.candles.slice() : [];
    hc.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    const cutoff = Date.now() - 60 * 60 * 1000; // bar must have closed (16:00 passed)
    let best = null;
    for (const c of hc) {
      const et = this.getETTime(c.timestamp);
      if (et.hhmm === 1500 && new Date(c.timestamp).getTime() < cutoff) best = c;
    }
    if (!best) throw new Error('no completed 15:00-ET hourly bar in the feed');
    return { close: Number(best.close), dateKey: this.getETTime(best.timestamp).tradeDate };
  }

  /**
   * Pre-open re-verification of the two multi-day inputs — the independent check
   * on the live stream's carry-forward, and the reason the sleeve is allowed to
   * fire at all in live mode.
   *
   * Called by the multi-strategy engine's run loop (~30s) and cheap to call
   * repeatedly: it no-ops outside the pre-open window and once it has succeeded
   * for the day. On every weekday between refreshStartHhmm ET and one minute
   * before the decision bar it re-pulls the prior RTH close and the ATR buffer
   * from data-service, adopts them, and shouts if they disagree with what the
   * stream produced. Failure leaves the day unverified, which stands the sleeve
   * down rather than letting it trade a reference nobody confirmed.
   */
  async dailyRefresh(dataServiceUrl) {
    if (!dataServiceUrl) return;
    const now = Date.now();
    const et = etParts(now);
    if (et.dow < 1 || et.dow > 5) return;
    const startMin = Math.floor(this.params.refreshStartHhmm / 100) * 60 + (this.params.refreshStartHhmm % 100);
    const decisionMin = this.params.rthOpenHour * 60 + this.params.rthOpenMinute - 1; // the 09:29 bar
    if (et.minutesOfDay < startMin || et.minutesOfDay >= decisionMin) return;
    if (this._verifiedFor === et.dateKey) return;

    this._liveMode = true;
    const errs = [];
    let ranges = null, ref = null;
    try { ranges = await this._fetchDayRanges(dataServiceUrl); } catch (err) { errs.push(`ATR14: ${err.message}`); }
    try { ref = await this._fetchPriorRthClose(dataServiceUrl); } catch (err) { errs.push(`priorRthClose: ${err.message}`); }

    if (ranges) this.dayRanges = ranges;

    if (!ref) {
      this._refreshError = errs.join('; ');
      return;   // unverified -> the 09:30 decision stands down
    }
    const age = this._dayAge(ref.dateKey, et.dateKey);
    if (age < 1 || age > this.params.maxRefAgeDays) {
      this._refreshError = `data-service prior RTH close is dated ${ref.dateKey} (${age}d before ${et.dateKey}) `
        + `— outside 1..${this.params.maxRefAgeDays}d, feed is stale`;
      console.warn(`[GUF] ${this._refreshError}`);
      return;
    }

    const had = this.priorRthClose;
    const drift = had === null ? null : ref.close - had;
    if (had !== null && (Math.abs(drift) > this.params.refToleranceP || this.priorRthCloseDate !== ref.dateKey)) {
      console.warn(`[GUF] prior-RTH-close CORRECTED before the open: had ${roundTo(had)} `
        + `(${this.priorRthCloseDate ?? 'undated'}) → ${roundTo(ref.close)} (${ref.dateKey}) from data-service, `
        + `drift ${drift.toFixed(2)}pts — the live carry-forward is not keeping up`);
    }
    this.priorRthClose = ref.close;
    this.priorRthCloseDate = ref.dateKey;
    this._verifiedFor = et.dateKey;
    this._refreshError = errs.length ? errs.join('; ') : null;
    this._lastRefresh = {
      at: now, close: roundTo(ref.close), dateKey: ref.dateKey,
      driftPts: drift === null ? null : roundTo(drift), atrBars: this.dayRanges.length
    };
    if (this.params.debug) {
      const atr = this._atr();
      console.log(`[GUF] ${et.dateKey} verified: priorRthClose=${roundTo(ref.close)} (${ref.dateKey}), `
        + `atr14=${atr ? atr.toFixed(1) : 'n/a'} from ${this.dayRanges.length} daily bars`);
    }
  }

  /**
   * Seed ATR14 and priorRthClose at startup so the strategy can evaluate the
   * opening gap on day one. Best-effort; on failure it builds ATR from live
   * candles and waits one live RTH session for priorRthClose. Marks the strategy
   * live — the backtest engine never calls this — which arms the pre-open
   * verification requirement in evaluateSignal.
   */
  async seedHistoricalData(dataServiceUrl) {
    this._liveMode = true;
    try {
      this.dayRanges = await this._fetchDayRanges(dataServiceUrl);
    } catch (err) {
      if (this.params.debug) console.log(`[GUF] ATR seed failed: ${err.message} — building from live candles`);
    }
    try {
      const ref = await this._fetchPriorRthClose(dataServiceUrl);
      this.priorRthClose = ref.close;
      this.priorRthCloseDate = ref.dateKey;
    } catch (err) {
      if (this.params.debug) console.log(`[GUF] priorRthClose seed failed: ${err.message} — waiting one live RTH session`);
    }
    if (this.params.debug) {
      const atr = this._atr();
      console.log(`[GUF] seeded: ATR14 from ${this.dayRanges.length} daily bars (atr=${atr ? atr.toFixed(1) : 'n/a'}), `
        + `priorRthClose=${this.priorRthClose ?? 'pending live session'} (${this.priorRthCloseDate ?? 'undated'})`);
    }
  }

  isSeeded() {
    return this.dayRanges.length >= this.params.atrMinPeriods && this.priorRthClose !== null;
  }

  /**
   * Readiness snapshot for the dashboard book panel. "Distance" is the countdown
   * to the 09:30 open (where the gap is evaluated); the gap itself is only known
   * at the open, so pre-open the condition is pending. After the open the card
   * shows the actual gap vs the 0.50×ATR threshold. States: watching (pre-open) |
   * fired | stood-down (gap too small) | dormant.
   */
  getInternalState() {
    const now = Date.now();
    const et = etParts(now);
    const atr = this._atr();
    const seeded = this.isSeeded();
    const decMin = this.params.rthOpenHour * 60 + this.params.rthOpenMinute;
    const isWeekday = et.dow >= 1 && et.dow <= 5;
    const decisionPassed = isWeekday && et.minutesOfDay >= decMin;
    const firedToday = this._firedDate === et.dateKey;
    const gapToday = this._lastGapEval && this._lastGapEval.date === et.dateKey ? this._lastGapEval : null;

    let state;
    if (!seeded) state = 'dormant';
    else if (firedToday) state = 'fired';
    else if (!isWeekday) state = 'dormant';
    else if (decisionPassed) state = 'stood-down';
    else state = 'watching';

    const thrPts = atr ? this.params.gapAtrMult * atr : null;
    return {
      kind: 'gapfade', state, seeded, atr14: atr ? roundTo(atr, 1) : null,
      decision: { label: '09:30 ET', secondsTo: secondsToNextDecision(now, this.params.rthOpenHour, this.params.rthOpenMinute, [1, 2, 3, 4, 5]) },
      direction: 'SHORT',
      condition: {
        kind: 'gap', label: 'Opening gap vs threshold',
        value: gapToday && gapToday.gapAtr != null ? roundTo(gapToday.gapAtr, 2) : null,
        valuePts: gapToday && gapToday.gapPts != null ? roundTo(gapToday.gapPts, 0) : null,
        threshold: this.params.gapAtrMult, thresholdPts: thrPts != null ? roundTo(thrPts, 0) : null,
        unit: 'ATR', met: gapToday ? gapToday.met : null,
        refPrice: this.priorRthClose != null ? roundTo(this.priorRthClose, 0) : null,
        // Provenance of the reference the gap is measured against — the input
        // that silently went stale on 2026-08-28.
        refDate: this.priorRthCloseDate,
        refVerified: this._liveMode ? this._verifiedFor === et.dateKey : null,
        refError: this._refreshError || null,
        blocked: gapToday ? (gapToday.blocked || null) : null,
      },
      firedToday, lastSignal: this._lastSignal, lastRefresh: this._lastRefresh,
    };
  }

  /**
   * Session reset (live engine, 18:00 ET Globex boundary). Intraday state only:
   * dayRanges (rolling ATR14) and priorRthClose are multi-day warmup state and
   * survive. Wiping them here made the 09:29 ET decision run un-seeded every
   * single day — the re-seed only landed at ~09:31 on a Schwab reconnect.
   *
   * Finalize FIRST. The engine's session-start reset lands at 18:00 ET, the same
   * boundary the Globex trade_date rolls on, and always beats the 18:00 bar's
   * ~18:01 delivery — so nulling sessTradeDate here skipped the tradeDate-change
   * branch in evaluateSignal that is the only other caller of _finalizeSession().
   * The day's RTH close and day_range were dropped on the floor every evening,
   * freezing priorRthClose and ATR14 at their seed values until the next process
   * restart (2026-08-28: a 4-session-stale close fired a phantom gap-up short).
   * _finalizeSession() is guarded by fullRthMinBars, so an off-hours or partial
   * reset contributes nothing.
   */
  reset() {
    super.reset();
    this._finalizeSession();
    this.sessTradeDate = null;
    this._resetSession();
    this._lastSignal = null;
    this._firedDate = null;
    this._lastGapEval = null;
  }

  getName() { return 'GAPUP_FADE'; }
  getDescription() { return 'Gap-Up Fade — short a large opening gap-up into its morning exhaustion (book hedge)'; }
  getRequiredMarketData() { return []; }
}

export default GapUpFadeStrategy;
