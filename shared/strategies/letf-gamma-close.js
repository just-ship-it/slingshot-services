/**
 * LETF Gamma Close (LGC)
 *
 * Mechanism: leveraged and inverse ETFs must rebalance to their target exposure
 * at the close. For leverage L the required trade is ~ AUM * L * (L-1) * r, and
 * it is SAME-SIGNED as the day's move for BOTH long and inverse funds — so the
 * flow is momentum-amplifying and proportional to the day's return. Dealer gamma
 * then decides whether that flow is absorbed or amplified:
 *   positive gamma -> dealers fade it   -> the close REVERTS
 *   negative gamma -> dealers pile on   -> the close CASCADES
 * (Origin: Doc McGraw note c-279558356, pre-registered before we tested it.)
 *
 * Rule:
 *   At 15:30 ET, day_move = 15:30 price - 09:30 RTH open.
 *   Trade only if |day_move| >= median |day_move| of the trailing window
 *     (the LETF rebalance is proportional to the move; small moves are noise).
 *   Trade only if |total_gex| > the deadbandPct percentile of its trailing window
 *     (see DEADBAND below — this is what makes the sleeve source-independent).
 *   Direction: total_gex > 0 -> FADE the day move; total_gex < 0 -> CHASE it.
 *   Enter 1 contract MARKET. No stop, no target. Exit MARKET after holdBars (15:45).
 *
 * ★ DEADBAND — why it exists (2026-08-23):
 *   The sleeve was validated on OPRA-derived GEX but runs live on CBOE. On 11 days
 *   where two independent sources both exist (Schwab vs OPRA, 1,943 paired
 *   snapshots) raw gamma-SIGN agreement is only 76.9%, and disagreement is
 *   monotone in |total_gex|: bottom quintile 35.4% agree, top two quintiles 100%.
 *   Applying a 40th-percentile deadband gives 100% direction agreement across 936
 *   both-trade snapshots — ZERO opposite trades (vs 449/1943 = 23% without it).
 *   Residual disagreement becomes skip-vs-trade (a participation difference),
 *   never a wrong side.
 *   🚨 It MUST be a PERCENTILE of the source's own trailing distribution, never an
 *   absolute number: median |total_gex| runs 0.75x on Schwab vs OPRA, so a
 *   hardcoded threshold misclassifies whenever the feed changes.
 *
 * Backtest (1s-validated fills, costs applied, non-Monday, 15:45 exit, 1 contract,
 * 2023-03 -> 2026-01): NQ PF 1.81 / +$23,820 / maxDD $4,100 ; ES PF 1.77 / +$13,772.
 * FCFS book effect: PF 1.51->1.57, Sharpe 2.02->2.19, maxDD +$447.
 * Research: research/mcgraw-claims/ (t1_letf.py .. t1i_lag.py).
 */

import { BaseStrategy } from './base-strategy.js';
import { isValidCandle, roundTo, etParts, secondsToNextDecision } from './strategy-utils.js';

const ONE_MIN_MS = 60 * 1000;

export class LetfGammaCloseStrategy extends BaseStrategy {
  static getDataRequirements() {
    return {
      candles: true,
      gex: { etfSymbol: 'QQQ', futuresSymbol: 'NQ', defaultMultiplier: 41.5 },
      lt: false, tradier: false, ivSkew: false
    };
  }

  constructor(params = {}) {
    super(params);

    this.defaultParams = {
      // Decision + anchor times (ET)
      rthOpenHour: 9, rthOpenMinute: 30,
      decisionHour: 15, decisionMinute: 30,

      // Hold 15 x 1m bars -> exit 15:45 ET (the production EOD flatten time).
      // Exit-time sensitivity is NOISE (15:45 vs 16:00 bootstrap CI spans zero on
      // both instruments); 15:45 chosen for ~half the drawdown, not for PnL.
      holdBars: 15,

      // Trailing windows for BOTH percentile gates (sessions)
      trailWindow: 60,
      trailMinSessions: 20,

      // Gate 1: |day move| must be >= this percentile of its trailing window
      movePct: 0.50,
      // Gate 2: |total_gex| must be > this percentile of its trailing window
      deadbandPct: 0.40,

      allowLongs: true,
      allowShorts: true,
      signalCooldownMs: 12 * 60 * 60 * 1000,

      // Max age of the GEX snapshot at the decision. CBOE is ~15 min delayed and
      // the validated snapshot was already 15 min old; staleness is flat to 30 min
      // and degrades past 45. Beyond maxGexAgeMin -> SKIP (never trade unconditioned:
      // there is no valid unconditioned version, "always fade" is only PF 1.03 on ES).
      maxGexAgeMin: 120,

      tradingSymbol: 'NQ1!',
      defaultQuantity: 1,
      seedSymbol: 'NQ',
      debug: false
    };
    this.params = { ...this.defaultParams, ...this.params };

    this.moveBuf = [];   // trailing |day move|
    this.gexBuf = [];    // trailing |total_gex| observed at the decision instant

    this.sessTradeDate = null;
    this._resetSession();

    this._lastPrice = null;
    this._lastSignal = null;
    this._firedDate = null;
    this._lastSkipReason = null;
  }

  _resetSession() {
    this.rthOpen = null;
    this.firedToday = false;
  }

  /** ET components + Globex trade_date (bars >= 18:00 ET belong to the next session). */
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

  /** Percentile of a buffer (linear interpolation), null until minSessions. */
  _pct(buf, p) {
    if (buf.length < this.params.trailMinSessions) return null;
    const a = [...buf].sort((x, y) => x - y);
    const idx = p * (a.length - 1);
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    return lo === hi ? a[lo] : a[lo] + (a[hi] - a[lo]) * (idx - lo);
  }

  _push(buf, v) {
    buf.push(v);
    if (buf.length > this.params.trailWindow) buf.shift();
  }

  evaluateSignal(candle, prevCandle, marketData, options = {}) {
    if (!isValidCandle(candle)) return null;
    const timestamp = this.toMs(candle.timestamp);
    const et = this.getETTime(timestamp);
    this._lastPrice = candle.close;

    if (et.tradeDate !== this.sessTradeDate) {
      this.sessTradeDate = et.tradeDate;
      this._resetSession();
    }
    if (et.hhmm === this.params.rthOpenHour * 100 + this.params.rthOpenMinute && this.rthOpen === null) {
      this.rthOpen = candle.open;
    }

    // Fire on the bar that CLOSES at the decision instant (15:30 ET) = the
    // 15:29-labeled bar. The 15:30-labeled bar doesn't close until 15:31, which
    // would ship the signal a minute late on a stale price.
    const decMin = this.params.decisionHour * 60 + this.params.decisionMinute;
    const barMin = (decMin - 1 + 1440) % 1440;
    const decisionBarHHMM = Math.floor(barMin / 60) * 100 + (barMin % 60);
    if (et.hhmm !== decisionBarHHMM || this.firedToday) return null;
    this.firedToday = true;               // fire-or-skip: one decision per day
    if (this.rthOpen === null) { this._lastSkipReason = 'no_rth_open'; return null; }

    const decisionPrice = candle.close;
    const move = decisionPrice - this.rthOpen;
    const absMove = Math.abs(move);

    // --- GEX at the decision (causal: last snapshot at/before this bar) ---
    const snap = marketData?.gexLoader?.getGexLevels?.(new Date(timestamp)) || marketData?.gexLevels;
    const totalGex = snap?.total_gex;
    if (snap == null || totalGex == null || !isFinite(totalGex)) {
      this._lastSkipReason = 'no_gex';
      this._push(this.moveBuf, absMove);
      return null;
    }
    this._lastGex = totalGex;
    const snapMs = snap.timestamp instanceof Date ? snap.timestamp.getTime() : this.toMs(snap.timestamp);
    const ageMin = isFinite(snapMs) ? (timestamp - snapMs) / ONE_MIN_MS : 0;
    if (ageMin > this.params.maxGexAgeMin) {
      this._lastSkipReason = `gex_stale_${Math.round(ageMin)}m`;
      this._push(this.moveBuf, absMove);
      return null;
    }

    // Thresholds from the TRAILING windows (computed BEFORE pushing today's obs)
    const moveThr = this._pct(this.moveBuf, this.params.movePct);
    const gexThr = this._pct(this.gexBuf, this.params.deadbandPct);
    this._push(this.moveBuf, absMove);
    this._push(this.gexBuf, Math.abs(totalGex));

    if (moveThr === null || gexThr === null) { this._lastSkipReason = 'warmup'; return null; }
    if (absMove < moveThr) { this._lastSkipReason = 'move_below_median'; return null; }
    if (Math.abs(totalGex) <= gexThr) { this._lastSkipReason = 'gex_in_deadband'; return null; }
    if (!this.checkCooldown(timestamp, this.params.signalCooldownMs)) return null;

    // positive gamma -> dealers fade the rebalance -> we FADE the day move
    // negative gamma -> dealers amplify it        -> we CHASE the day move
    const fade = totalGex > 0;
    const side = fade ? (move > 0 ? 'short' : 'long') : (move > 0 ? 'long' : 'short');
    if (side === 'long' && !this.params.allowLongs) return null;
    if (side === 'short' && !this.params.allowShorts) return null;

    this.updateLastSignalTime(timestamp);
    this._firedDate = et.tradeDate;
    this._lastSkipReason = null;
    this._lastSignal = { ts: timestamp + ONE_MIN_MS, side: side === 'long' ? 'buy' : 'sell',
      price: roundTo(decisionPrice), note: `${side.toUpperCase()} · ${fade ? 'FADE +gamma' : 'CHASE -gamma'} · exit 15:45` };

    if (this.params.debug) {
      console.log(`[LGC] ${et.tradeDate} ${side.toUpperCase()} move=${move.toFixed(1)} `
        + `thr=${moveThr.toFixed(1)} gex=${(totalGex / 1e9).toFixed(2)}B `
        + `deadband=${(gexThr / 1e9).toFixed(2)}B age=${ageMin.toFixed(0)}m`);
    }

    return {
      timestamp: timestamp + ONE_MIN_MS,
      side: side === 'long' ? 'buy' : 'sell',
      action: 'place_market',
      strategy: 'LETF_GAMMA_CLOSE',
      symbol: options.symbol || this.params.tradingSymbol,
      price: roundTo(decisionPrice),
      quantity: options.quantity || this.params.defaultQuantity,
      stopLoss: null,
      takeProfit: null,
      maxHoldBars: this.params.holdBars,
      metadata: {
        strategy: 'LETF_GAMMA_CLOSE',
        direction: side,
        regime: fade ? 'positive_gamma_fade' : 'negative_gamma_chase',
        day_move: roundTo(move),
        move_threshold: roundTo(moveThr),
        total_gex: totalGex,
        gex_deadband: gexThr,
        gex_age_min: Math.round(ageMin),
        rth_open: roundTo(this.rthOpen),
        decision_price: roundTo(decisionPrice),
        trading_date: et.tradeDate
      }
    };
  }

  /** Seeded once BOTH trailing percentile buffers have enough sessions. */
  isSeeded() {
    return this.moveBuf.length >= this.params.trailMinSessions &&
           this.gexBuf.length >= this.params.trailMinSessions;
  }

  /** Latest |total_gex| seen at a decision, for the panel. */
  _lastGex = null;

  getInternalState() {
    const now = Date.now();
    const et = etParts(now);
    const seeded = this.isSeeded();
    const decMin = this.params.decisionHour * 60 + this.params.decisionMinute;
    const isWeekday = et.dow >= 1 && et.dow <= 5;
    const decisionPassed = isWeekday && et.minutesOfDay >= decMin;
    const firedToday = this._firedDate === et.dateKey;

    const moveThr = this._pct(this.moveBuf, this.params.movePct);
    const gexThr = this._pct(this.gexBuf, this.params.deadbandPct);

    let moveP = null, met = null, direction = null;
    if (this.rthOpen != null && this._lastPrice != null) {
      moveP = this._lastPrice - this.rthOpen;
      if (moveThr != null) met = Math.abs(moveP) >= moveThr;
      // direction needs the gamma sign; unknown until the decision snapshot
      if (this._lastGex != null) {
        const fade = this._lastGex > 0;
        direction = (fade ? (moveP > 0 ? 'SHORT' : 'LONG') : (moveP > 0 ? 'LONG' : 'SHORT'));
      }
    }

    let state;
    if (!seeded) state = 'dormant';
    else if (firedToday) state = 'fired';
    else if (!isWeekday) state = 'dormant';
    else if (decisionPassed) state = 'stood-down';
    else state = met === true ? 'armed' : 'watching';

    return {
      kind: 'letf', state, seeded,
      decision: {
        label: '15:30 ET',
        secondsTo: secondsToNextDecision(now, this.params.decisionHour, this.params.decisionMinute, [1, 2, 3, 4, 5])
      },
      direction: firedToday && this._lastSignal
        ? (this._lastSignal.side === 'buy' ? 'LONG' : 'SHORT') : direction,
      condition: {
        kind: 'threshold', label: 'Day move vs trailing median',
        value: moveP != null && moveThr ? roundTo(moveP / moveThr, 2) : null,
        valuePts: moveP != null ? roundTo(moveP, 0) : null,
        threshold: 1.0, thresholdPts: moveThr != null ? roundTo(moveThr, 0) : null,
        unit: 'x median', met,
        refPrice: this.rthOpen != null ? roundTo(this.rthOpen, 0) : null,
      },
      // GEX deadband — the gate that makes this sleeve source-independent
      gex: {
        totalGex: this._lastGex,
        deadband: gexThr,
        inDeadband: this._lastGex != null && gexThr != null ? Math.abs(this._lastGex) <= gexThr : null,
        regime: this._lastGex == null ? null : (this._lastGex > 0 ? 'positive (fade)' : 'negative (chase)'),
        sessions: this.gexBuf.length,
      },
      trailSessions: this.moveBuf.length,
      skipReason: this._lastSkipReason,
      firedToday, lastSignal: this._lastSignal,
    };
  }

  /**
   * Session reset (live engine, 18:00 ET Globex boundary). Clears INTRADAY state
   * ONLY. moveBuf/gexBuf are rolling MULTI-DAY percentile buffers — wiping them
   * here un-seeds the sleeve every evening and it would never fire live. This is
   * the exact bug that silently disabled gapup-fade (see
   * memory/session-reset-wipes-atr-warmup.md); do not "tidy" it.
   */
  reset() {
    super.reset();
    this.sessTradeDate = null;
    this._resetSession();
    this._lastPrice = null;
    this._lastSignal = null;
    this._firedDate = null;
    this._lastSkipReason = null;
    // NOTE: moveBuf / gexBuf deliberately preserved.
  }

  getName() { return 'LETF_GAMMA_CLOSE'; }
  getDescription() { return 'LETF Gamma Close — trade the 15:30->15:45 leveraged-ETF rebalance, faded or chased by dealer gamma sign'; }
  getRequiredMarketData() { return ['gex']; }
}

export default LetfGammaCloseStrategy;
