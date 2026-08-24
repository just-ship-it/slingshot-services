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

import Redis from 'ioredis';
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

      // ★ GEX deadband pool. |total_gex| varies by TIME OF DAY, so the reference
      // distribution must come from the AFTERNOON, not the whole session: an
      // all-day pool tested PF 1.54 vs 1.82 for 13:00-15:30. Pooling ~10
      // snapshots/day from 13:00 collapses warmup from 20 sessions to 2, costing
      // only PF 1.88->1.82 (net -7%, maxDD identical). Validated on the CLEAN
      // cbbo-IV period 2025-01..2026-01.
      gexPoolStartHour: 13, gexPoolStartMinute: 0,
      gexPoolMinObs: 20,
      gexPoolMax: 600,

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

      // Redis persistence of the rolling observation window. Without this ANY
      // data-service/signal-generator restart resets the 20-session warmup and the
      // sleeve silently never fires. Same failure class as
      // memory/session-reset-wipes-atr-warmup.md.
      redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
      redisKey: 'strategy:letf-gamma-close:observations',
      persist: true,

      tradingSymbol: 'NQ1!',
      defaultQuantity: 1,
      seedSymbol: 'NQ',
      debug: false
    };
    this.params = { ...this.defaultParams, ...this.params };

    // Dated observation log: [{date:'YYYY-MM-DD', move:<abs pts>, gex:<abs total_gex>}]
    // Dated so restarts can't double-count a day and so an external seed merges cleanly.
    this.obs = [];
    // Deduped afternoon |total_gex| pool: [{ts:<snapshot ms>, v:<abs gex>}]
    this.gexPool = [];
    this.redis = null;
    this._persistErr = null;
    this._persistDisabled = false;

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

  /**
   * Read total gamma exposure from a GEX snapshot.
   * 🚨 The BACKTEST loader emits snake_case `total_gex` (raw, e.g. 3.4e9) while the
   * LIVE gex-calculator publishes camelCase `totalGex` ALREADY IN BILLIONS
   * (gex-calculator.js:340 `totalGex: totalGex / 1e9`, surfaced at :524).
   * Reading only one shape made the sleeve see `undefined` live and pool nothing.
   * Units do not matter downstream — the deadband is a percentile of whichever
   * source is running, so it is scale-free — but the FIELD NAME does.
   */
  static readGex(snap) {
    if (!snap) return null;
    const v = snap.total_gex ?? snap.totalGex;
    return Number.isFinite(v) ? v : null;
  }

  /**
   * Format a gamma value as billions REGARDLESS of source scale. The backtest
   * loader emits raw (~3.4e9); the live bus emits billions (~3.07). Dividing
   * unconditionally printed "0.00B" on live. See readGex().
   */
  static fmtB(v) {
    if (!Number.isFinite(v)) return 'n/a';
    return `${(Math.abs(v) > 1e6 ? v / 1e9 : v).toFixed(2)}B`;
  }

  /** Deadband = percentile of the AFTERNOON |gex| pool; null until gexPoolMinObs. */
  _gexDeadband() {
    const vals = this.gexPool.map(o => o.v).filter(v => Number.isFinite(v));
    if (vals.length < this.params.gexPoolMinObs) return null;
    const a = vals.sort((x, y) => x - y);
    const idx = this.params.deadbandPct * (a.length - 1);
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    return lo === hi ? a[lo] : a[lo] + (a[hi] - a[lo]) * (idx - lo);
  }

  /** Record one afternoon GEX snapshot, deduped by snapshot timestamp. */
  _poolGex(snapMs, absGex) {
    if (!Number.isFinite(snapMs) || !Number.isFinite(absGex)) return;
    if (this.gexPool.some(o => o.ts === snapMs)) return;
    this.gexPool.push({ ts: snapMs, v: absGex });
    if (this.gexPool.length > this.params.gexPoolMax) {
      this.gexPool = this.gexPool.slice(-this.params.gexPoolMax);
    }
    // Persist on each NEW snapshot (~10/day after dedupe). Without this the
    // afternoon pool only reached Redis at the 15:30 decision, so a restart at
    // e.g. 14:00 silently threw away that day's samples.
    this._save();
  }

  /** Percentile over one field of the observation log; null until minSessions. */
  _pct(field, p) {
    const vals = this.obs.map(o => o[field]).filter(v => Number.isFinite(v));
    if (vals.length < this.params.trailMinSessions) return null;
    const a = vals.sort((x, y) => x - y);
    const idx = p * (a.length - 1);
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    return lo === hi ? a[lo] : a[lo] + (a[hi] - a[lo]) * (idx - lo);
  }

  /** Upsert one day's observation, trim to trailWindow, persist. Date-keyed so a
   *  restart mid-session cannot double-count, and an external seed merges cleanly. */
  _record(date, move, gex) {
    const i = this.obs.findIndex(o => o.date === date);
    const row = { date, move, ...(Number.isFinite(gex) ? { gex } : {}) };
    if (i >= 0) this.obs[i] = { ...this.obs[i], ...row };
    else this.obs.push(row);
    this.obs.sort((a, b) => (a.date < b.date ? -1 : 1));
    if (this.obs.length > this.params.trailWindow) {
      this.obs = this.obs.slice(-this.params.trailWindow);
    }
    this._save();
  }

  async _redis() {
    if (!this.params.persist || this._persistDisabled) return null;
    if (!this.redis) {
      this.redis = new Redis(this.params.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 2 });
      this.redis.on('error', () => {});           // never let redis noise kill the strategy
      try { await this.redis.connect(); }
      catch (e) {
        // Give up permanently after the first failure. Backtests have no Redis and
        // would otherwise retry on every one of ~700 observations.
        this._persistErr = e.message;
        this._persistDisabled = true;
        try { this.redis.disconnect(); } catch { /* ignore */ }
        this.redis = null;
        return null;
      }
    }
    return this.redis;
  }

  /** Fire-and-forget write. A persistence failure must never block trading. */
  _save() {
    if (!this.params.persist) return;
    this._redis().then(r => {
      if (!r) return;
      return r.set(this.params.redisKey, JSON.stringify({ obs: this.obs, gexPool: this.gexPool }));
    }).then(() => { this._persistErr = null; })
      .catch(e => { this._persistErr = e.message; });
  }

  /**
   * Engine startup hook (multi-strategy-engine calls this when present).
   * Restores the rolling window from Redis so a data-service / signal-generator
   * restart does NOT reset the 20-session warmup.
   * Also the injection point for an offline seed: write the same JSON shape to
   * `redisKey` and the sleeve picks it up on next boot.
   * 🚨 The `gex` values MUST come from the SAME source that will run live (CBOE).
   * Seeding with OPRA/CBBO magnitudes breaks the deadband — median |total_gex|
   * differs ~0.75x between sources, so the percentile would be measured off the
   * wrong scale. Price-derived `move` is source-independent and safe to seed.
   */
  async seedHistoricalData() {
    const r = await this._redis();
    if (!r) return { seeded: false, reason: this._persistErr || 'persist disabled' };
    try {
      const raw = await r.get(this.params.redisKey);
      if (!raw) return { seeded: false, reason: 'no stored observations' };
      const parsed = JSON.parse(raw);
      const arr = Array.isArray(parsed) ? parsed : parsed.obs;   // accept legacy array form
      if (!Array.isArray(arr)) return { seeded: false, reason: 'bad payload' };
      this.gexPool = Array.isArray(parsed.gexPool)
        ? parsed.gexPool.filter(o => o && Number.isFinite(o.ts) && Number.isFinite(o.v))
                        .slice(-this.params.gexPoolMax)
        : [];
      this.obs = arr
        .filter(o => o && typeof o.date === 'string' && Number.isFinite(o.move))
        .sort((a, b) => (a.date < b.date ? -1 : 1))
        .slice(-this.params.trailWindow);
      const withGex = this.obs.filter(o => Number.isFinite(o.gex)).length;
      return { seeded: true, sessions: this.obs.length, gexSessions: withGex,
               gexPool: this.gexPool.length,
               first: this.obs[0]?.date, last: this.obs[this.obs.length - 1]?.date };
    } catch (e) {
      this._persistErr = e.message;
      return { seeded: false, reason: e.message };
    }
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

    // --- Pool afternoon |total_gex| for the deadband reference distribution. ---
    // Runs on every candle from gexPoolStart to the decision; deduped by snapshot ts
    // so a 15-min GEX snapshot is counted once, not 15 times.
    const poolStart = this.params.gexPoolStartHour * 100 + this.params.gexPoolStartMinute;
    const decHHMM = this.params.decisionHour * 100 + this.params.decisionMinute;
    if (et.hhmm >= poolStart && et.hhmm <= decHHMM) {
      const ps = marketData?.gexLoader?.getGexLevels?.(new Date(timestamp)) || marketData?.gexLevels;
      const pv = LetfGammaCloseStrategy.readGex(ps);
      if (ps && pv !== null) {
        const pms = ps.timestamp instanceof Date ? ps.timestamp.getTime() : this.toMs(ps.timestamp);
        this._poolGex(pms, Math.abs(pv));
      }
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
    const totalGex = LetfGammaCloseStrategy.readGex(snap);
    if (snap == null || totalGex === null) {
      this._lastSkipReason = 'no_gex';
      this._record(et.tradeDate, absMove, undefined);   // move still counts; gex does not
      return null;
    }
    this._lastGex = totalGex;
    const snapMs = snap.timestamp instanceof Date ? snap.timestamp.getTime() : this.toMs(snap.timestamp);
    const ageMin = isFinite(snapMs) ? (timestamp - snapMs) / ONE_MIN_MS : 0;
    if (ageMin > this.params.maxGexAgeMin) {
      this._lastSkipReason = `gex_stale_${Math.round(ageMin)}m`;
      this._record(et.tradeDate, absMove, undefined);
      return null;
    }

    // Thresholds from the TRAILING windows (computed BEFORE pushing today's obs)
    const moveThr = this._pct('move', this.params.movePct);
    const gexThr = this._gexDeadband();          // afternoon pool, not once-a-day
    this._record(et.tradeDate, absMove, Math.abs(totalGex));

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
        + `thr=${moveThr.toFixed(1)} gex=${LetfGammaCloseStrategy.fmtB(totalGex)} `
        + `deadband=${LetfGammaCloseStrategy.fmtB(gexThr)} age=${ageMin.toFixed(0)}m`);
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
    // 🚨 DEADLOCK — do NOT re-add the gexPool condition here.
    // multi-strategy-engine gates runner.dataReady on isSeeded() and only calls
    // evaluateSignal() when dataReady is true (checkStrategyDataReady →
    // 'candle history' blocker). But gexPool is filled ONLY inside
    // evaluateSignal(). Requiring the pool here meant the pool could never fill,
    // so the sleeve sat at "gamma 0/20 samples" forever and never evaluated.
    // Safety is not weakened: the decision path independently refuses to trade
    // while the pool is shallow — _gexDeadband() returns null until
    // gexPoolMinObs and evaluateSignal bails with _lastSkipReason='warmup'.
    return this.obs.length >= this.params.trailMinSessions;
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

    const moveThr = this._pct('move', this.params.movePct);
    const gexThr = this._gexDeadband();

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
        // Warmup telemetry. `sessions` counts pooled AFTERNOON snapshots (~10/day
        // from gexPoolStart), NOT days — so a full pool is ~2 sessions, not 20.
        sessions: this.gexPool.length,
        needed: this.params.gexPoolMinObs,
        poolOpensAt: `${String(this.params.gexPoolStartHour).padStart(2,'0')}:${String(this.params.gexPoolStartMinute).padStart(2,'0')} ET`,
        poolOpen: et.minutesOfDay >= (this.params.gexPoolStartHour * 60 + this.params.gexPoolStartMinute)
                  && et.minutesOfDay <= decMin && isWeekday,
      },
      // Which gate is actually holding the sleeve dormant
      warmup: (() => {
        const g = this.gexPool.length, gN = this.params.gexPoolMinObs;
        const m = this.obs.length, mN = this.params.trailMinSessions;
        if (g >= gN && m >= mN) return null;
        const parts = [];
        if (g < gN) parts.push(`gamma ${g}/${gN} samples`);
        if (m < mN) parts.push(`day-move ${m}/${mN} sessions`);
        return { blocked: parts.join(' · '), gex: [g, gN], move: [m, mN] };
      })(),
      trailSessions: this.obs.length,
      persistError: this._persistErr,
      skipReason: this._lastSkipReason,
      firedToday, lastSignal: this._lastSignal,
    };
  }

  /**
   * Session reset (live engine, 18:00 ET Globex boundary). Clears INTRADAY state
   * ONLY. this.obs is the rolling MULTI-DAY percentile window — wiping it
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
    // NOTE: this.obs deliberately preserved (and it is Redis-backed anyway).
  }

  getName() { return 'LETF_GAMMA_CLOSE'; }
  getDescription() { return 'LETF Gamma Close — trade the 15:30->15:45 leveraged-ETF rebalance, faded or chased by dealer gamma sign'; }
  getRequiredMarketData() { return ['gex']; }
}

export default LetfGammaCloseStrategy;
