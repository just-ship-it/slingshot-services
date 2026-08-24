/**
 * Pattern: Twin-high breakout retest (retest-long-5m_tuned) — LONG
 *
 * Price-structures program, phase-4 frozen config (2026-08-19, DEPLOY-CANDIDATE
 * shadow-grade): consume `double-top-test` forming events on 5m bars (twin-extreme
 * detector, both zigzag and fractal generators — the reference sim read events
 * unfiltered by gen). The event is a fade setup (direction 'down'); we trade the
 * INVERSE long via a native STOP-LIMIT placed AT EVENT EMISSION:
 *   entry order: BUY stop-limit, stop trigger = levels.invalidation (the break
 *   above the twin high + tolerance), limit = levels.extra.twinLevel (the broken
 *   twin acting as support on the retest). The order is inert until the trigger
 *   is touched (armTimeoutCandles = the event's working window,
 *   geometry.maxFormingBars × 5 = 300 1m bars), then works as a resting limit
 *   for timeoutCandles = 120 minutes — including same-minute post-break
 *   retouches on the engine's 1s path, exactly like the reference sim
 *   (PS-40-retest 'lim': jb = first 1s ≥ invalidation, fill = first later 1s
 *   ≤ twin). Exits: pattern stop = levels.trigger (the 5m test-bar low), pattern
 *   target = invalidation + max(|trigger − invalidation|, atr14(5m)) — ABSOLUTE
 *   levels (no re-anchoring to fill) — plus a 480-minute time cap.
 * Dev 2021-24: PF 1.15 / $15.1k/yr / DD $10.9k. Val 2025-26: PF 1.19 / $28.6k.
 * Survives 1-tick trade-through pessimism (dev PF 1.13). The baseline stop-entry
 * variant and its hold-480 PnL are DRIFT — only the limit-at-level entry with
 * pattern exits beat the drift twin. Shadow-grade, size accordingly.
 * Source: research/price-structures/analysis/tuning/retest-pair-5m.md (frozen
 * config §3) + PS-40-retest.py variant 'lim' (reference semantics).
 * Port parity: research/price-structures/analysis/out/parity/pattern-retest-long-parity.md.
 *
 * Mechanics / conventions:
 * - Embeds a streaming PatternEngine (['1m','5m'], twin-extreme detector) and
 *   feeds it every closed 1m candle. The engine is session-anchored (18:00 ET),
 *   hard-resets on contract rollover, and only runs detectors once features are
 *   warm (a cold-started range misses the first day's events).
 * - ATR = the event's context.atr14 (pattern-engine BarFeatures, Wilder on
 *   closed 5m bars) — per PARITY-GATE.md, never recomputed another way.
 * - FCFS single slot, one order/position at a time. The reference (PS-40) is a
 *   serial, EMISSION-ordered event walk: a filled trade books the slot for the
 *   FULL 480-bar horizon (busyUntil), every event emitted inside that horizon
 *   is dropped, and among overlapping candidates that both fill the earlier-
 *   emitted one always wins. Emulation (emission cursor):
 *     · the working order always belongs to the earliest-emitted viable
 *       candidate; later events queue (bounded, emission-ordered, with the
 *       reference expiries: 300-bar break window, 120-bar fill window);
 *     · new events queue while FREE or while an order is merely PENDING (the
 *       reference keeps such events alive when the pending order dies
 *       unfilled) but are DROPPED while a position is open or inside the
 *       480-bar post-fill occupancy cooldown;
 *     · on FILL, the queue is cleared and the cooldown starts;
 *     · queued candidates' 1m break touches are still tracked so that when
 *       the working order dies unfilled, the next candidate is placed with
 *       its REMAINING window — as a plain limit if its break already passed
 *       (fills that occurred while the slot was occupied are unrecoverable —
 *       documented parity residual; the reference honors them retroactively),
 *       or as a stop-limit with the remaining arm window otherwise.
 * - The strategy cannot observe fills/arms directly; it infers slot state from
 *   the shouldInvalidatePendingOrder heartbeat (called each eval bar for
 *   pending orders) + onPositionClosed, mirroring the engine's stop-limit
 *   cancel accounting (arm_timeout at armTimeoutCandles pre-arm bars; timeout
 *   at timeoutCandles bars counted FROM ARMING), with self-heal deadlines.
 * - exemptEodCutoff: live orchestrator field (this strategy trades all sessions
 *   and manages its own 480m cap); parity backtests don't set --eod-cutoff-et.
 * - Live path: place_stop_limit maps to a native Tradovate StopLimit (trigger
 *   in stopPrice, limit in price) — the broker arms the limit at the break
 *   instant and captures same-minute retouches like the research sim.
 */

import { BaseStrategy } from './base-strategy.js';
import { PatternEngine } from '../pattern-engine/engine.js';
import twinExtreme from '../pattern-engine/patterns/chart/twin-extreme.js';
import { isValidCandle, roundTo } from './strategy-utils.js';

const ONE_MIN_MS = 60 * 1000;
const STRATEGY_ID = 'PATTERN_RETEST_LONG';

export class PatternRetestLongStrategy extends BaseStrategy {
  /**
   * Pure price-action pattern strategy: needs candles only.
   * No GEX / LT / options data.
   */
  static getDataRequirements() {
    return { candles: true, gex: false, lt: false, tradier: false, ivSkew: false };
  }

  constructor(params = {}) {
    super(params);

    this.defaultParams = {
      // Pattern detection timeframe (embedded engine aggregates 1m → 5m)
      patternTimeframe: '5m',
      patternTimeframeMin: 5,
      patternId: 'double-top-test',
      product: 'NQ',
      // Entry: BUY stop-limit — trigger at the invalidation (break), limit at
      // the broken twin-high level (retest)
      entryAction: 'place_stop_limit',
      // Pre-arm window fallback: geometry.maxFormingBars (5m bars) × 5 → 1m bars
      defaultMaxFormingBars: 60,
      // Work the armed limit for 120 1m candles after the break, then cancel
      timeoutCandles: 120,
      // Time cap: flat 480 minutes after fill
      maxHoldBars: 480,
      // Bounded queue (safety; reference has no cap but expiries keep it small)
      maxArmedCandidates: 32,
      tradingSymbol: 'NQ1!',
      defaultQuantity: 1,
      debug: false
    };

    this.params = { ...this.defaultParams, ...params };
    this._initState();
  }

  _initState() {
    this.patternEngine = new PatternEngine({
      product: this.params.product,
      timeframes: ['1m', this.params.patternTimeframe],
      detectors: [twinExtreme],
    });
    this._lastFedTs = null;
    this._lastSymbol = null;
    // Emission-ordered candidate queue:
    // { instanceId, gen, twin, inval, stop, target, atr, armedTs,
    //   barsSinceArm, maxFormBars, broken, barsSinceBreak, breakTs }
    this._armed = [];
    // FCFS slot state machine: 'free' | 'pending' | 'position'
    this._slot = 'free';
    this._pending = null;      // { mode:'stoplimit'|'limit', timeout, cancelBsb, lastHeartbeatTs }
    this._pendingCand = null;  // candidate behind the working order (for state inference)
    this._cooldown = 0;        // reference 480-bar post-fill occupancy window
    this._positionBars = 0;
    this._posStop = NaN;       // absolute exit levels of the live position (self-heal)
    this._posTarget = NaN;
    this._lastSignal = null;   // status panel
  }

  /** Feed one closed 1m candle into the embedded pattern engine (idempotent per ts). */
  _feed(c) {
    if (!isValidCandle(c)) return [];
    const ts = this.toMs(c.timestamp);
    if (!Number.isFinite(ts) || (this._lastFedTs != null && ts <= this._lastFedTs)) return [];
    this._lastFedTs = ts;
    return this.patternEngine.onBar1m({
      ts,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: Number.isFinite(c.volume) ? c.volume : 0,
      symbol: c.symbol || this.params.tradingSymbol,
    });
  }

  /** Queue qualifying double-top-test forming events from a batch of engine events. */
  _queueEvents(events) {
    for (const evt of events) {
      if (evt.patternId !== this.params.patternId) continue;
      if (evt.tf !== this.params.patternTimeframe) continue;
      if (evt.state !== 'forming') continue;
      if (evt.direction !== 'down') continue; // twin-HIGH test (we trade the inverse long)

      const atr = evt.context?.atr14;
      if (!Number.isFinite(atr) || atr <= 0) continue;
      const inval = evt.levels?.invalidation;
      const trigger = evt.levels?.trigger;
      const twin = evt.levels?.extra?.twinLevel;
      if (!Number.isFinite(inval) || !Number.isFinite(trigger) || !Number.isFinite(twin)) continue;

      const maxFormingBars = evt.geometry?.maxFormingBars || this.params.defaultMaxFormingBars;
      const height = Math.abs(trigger - inval);
      this._armed.push({
        instanceId: evt.instanceId,
        gen: evt.geometry?.gen ?? null,
        twin,
        inval,
        stop: trigger,                                     // pattern stop = test-bar low (absolute)
        target: roundTo(inval + Math.max(height, atr), 4), // pattern target (absolute)
        atr,
        armedTs: evt.ts,
        barsSinceArm: 0,
        maxFormBars: Math.round(maxFormingBars * this.params.patternTimeframeMin),
        broken: false,
        barsSinceBreak: 0,
        breakTs: null,
      });
      if (this.params.debug) {
        console.log(`[PRL] queued ${evt.instanceId} twin=${twin} inval=${inval} stop=${trigger}`);
      }
    }
    while (this._armed.length > this.params.maxArmedCandidates) this._armed.shift();
  }

  /**
   * Resolve the FCFS slot state at the top of each eval bar, using the
   * pending-order heartbeat (shouldInvalidatePendingOrder) + onPositionClosed.
   * The pending candidate's counters have already been advanced for this bar.
   */
  _resolveSlot(candleTs, candle) {
    if (this._slot === 'pending' && this._pending) {
      if (this._pending.lastHeartbeatTs !== candleTs) {
        // No heartbeat this bar → the order left the pending set during this
        // bar: it FILLED, or the engine cancelled it (arm_timeout / timeout).
        const pc = this._pendingCand;
        const brokenNow = pc && (pc.broken || (candle && candle.high >= pc.inval));
        if (!brokenNow) {
          // An unarmed stop-limit cannot fill → cancelled (arm_timeout, or an
          // engine-side cancel we don't model). Candidate's windows are spent.
          this._slot = 'free';
          this._pending = null;
          this._pendingCand = null;
        } else if (pc.broken && pc.barsSinceBreak >= this._pending.cancelBsb) {
          // Reached the engine's post-arm cancel bar (or an un-observable
          // final-bar fill; self-heals below). Discard the spent candidate.
          this._slot = 'free';
          this._pending = null;
          this._pendingCand = null;
        } else {
          // Filled → position open; reference drops every event emitted
          // inside the trade's horizon — the whole queue qualifies.
          this._enterPosition();
        }
      }
    } else if (this._slot === 'position') {
      this._positionBars++;
      // Self-heal 1: if a bar breaches the known absolute stop/target while we
      // still think we're in a position, the trade must already have exited
      // (a live trade would have exited on this bar's 1s update, firing
      // onPositionClosed BEFORE this eval).
      if (candle && Number.isFinite(this._posStop) &&
          (candle.low <= this._posStop || candle.high >= this._posTarget)) {
        this._slot = 'free';
      }
      // Self-heal 2: onPositionClosed always fires within maxHoldBars (+ exit
      // bar slack); if it never comes (mis-inferred fill), free the slot.
      if (this._positionBars > this.params.maxHoldBars + 10) {
        this._slot = 'free';
      }
    }
  }

  _enterPosition() {
    this._slot = 'position';
    this._positionBars = 0;
    this._pending = null;
    this._pendingCand = null;
    this._armed = []; // drop-on-fill: reference busyUntil skips every event
                      // emitted inside the trade's horizon
    this._posStop = this._lastSignal?.stopLoss ?? NaN;
    this._posTarget = this._lastSignal?.takeProfit ?? NaN;
    // Reference FCFS occupancy (PS-40: busyUntil = fill bar + horizon − 1):
    // the slot stays booked for the FULL 480-bar horizon after a fill — even
    // when the pattern stop/target exits the trade earlier — and every event
    // emitted inside that window is dropped. Without this the strategy takes
    // ~2× the reference's trades (diluting the edge, cf. tuning §2g).
    this._cooldown = this.params.maxHoldBars - 1;
  }

  /**
   * @param {Object} candle - Closed 1m eval candle { timestamp, open, high, low, close, volume, symbol }
   * @param {Object} prevCandle - Previous candle
   * @param {Object} marketData - Market data bundle (unused — candles only)
   * @param {Object} options - Engine options ({ symbol, quantity } overrides)
   * @returns {Object|null} Trade signal or null
   */
  evaluateSignal(candle, prevCandle, marketData, options = {}) {
    if (!isValidCandle(candle)) return null;
    const ts = this.toMs(candle.timestamp);

    // The backtest engine starts eval at the 2nd candle; feed the very first
    // candle too so the aggregator/features see the full stream.
    if (prevCandle && (this._lastFedTs == null || this.toMs(prevCandle.timestamp) > this._lastFedTs)) {
      this._queueEvents(this._feed(prevCandle));
    }

    // 0) Post-fill occupancy cooldown (reference 480-bar horizon; see
    //    _enterPosition). Decremented per eval bar, index-based like the
    //    reference's bar arithmetic.
    if (this._cooldown > 0) this._cooldown--;

    // 1) Advance the working candidate's counters for THIS bar (the engine's
    //    arm/cancel accounting is mirrored from these), then resolve the slot.
    if (this._pendingCand) {
      const pc = this._pendingCand;
      pc.barsSinceArm++;
      if (pc.broken) pc.barsSinceBreak++;
      else if (candle.high >= pc.inval) { pc.broken = true; pc.barsSinceBreak = 0; pc.breakTs = ts; }
    }
    this._resolveSlot(ts, candle);

    // 2) Contract rollover: queued levels are in the old contract's price space
    const sym = candle.symbol || this.params.tradingSymbol;
    if (this._lastSymbol != null && sym !== this._lastSymbol) {
      this._armed = [];
      this._cooldown = 0; // reference horizon truncates at the roll
      if (this._slot === 'position') this._slot = 'free'; // ref force-ends the walk
      // A pending order is cancelled by shouldInvalidatePendingOrder below.
    }
    this._lastSymbol = sym;

    // 3) Age + expire queued candidates (index-based bar counting, like the
    //    reference's r0 + maxForm / ib + 1 + 120 windows), and track their 1m
    //    break touches (needed for remaining-window late placement when the
    //    working order dies unfilled).
    for (let i = this._armed.length - 1; i >= 0; i--) {
      const a = this._armed[i];
      a.barsSinceArm++;
      if (a.broken) {
        a.barsSinceBreak++;
        if (a.barsSinceBreak >= this.params.timeoutCandles) { this._armed.splice(i, 1); continue; }
      } else if (a.barsSinceArm > a.maxFormBars) {
        this._armed.splice(i, 1); continue;
      }
      if (!a.broken && candle.high >= a.inval) { a.broken = true; a.barsSinceBreak = 0; a.breakTs = ts; }
    }

    // 4) Feed the pattern engine this bar; queue its events unless in-position
    //    or in cooldown (reference: events emitted inside a trade's horizon
    //    are always dropped; while merely pending they stay alive). New events
    //    are queued BEFORE selection so an event emitted at this bar's close
    //    gets its stop-limit placed at emission.
    const events = this._feed(candle);
    if (this._slot !== 'position' && this._cooldown <= 0) this._queueEvents(events);

    // 5) Emission cursor: when the slot is free, the earliest-emitted viable
    //    candidate takes it — at emission (fresh event) or late (slot was
    //    busy). Later events wait; the reference books the earlier-emitted
    //    candidate whenever it fills.
    if (this._slot === 'free' && this._cooldown <= 0 && this._armed.length) {
      const a = this._armed.shift();
      return this._buildSignal(a, ts, options);
    }

    return null;
  }

  _buildSignal(a, ts, options) {
    const symbol = options.symbol || this.params.tradingSymbol;
    const quantity = options.quantity || this.params.defaultQuantity;
    const stopLoss = a.stop;      // ABSOLUTE pattern levels — no stopDistance /
    const takeProfit = a.target;  // targetDistance (never re-anchor to fill)

    // Fresh (or still-unbroken) candidate → native stop-limit: arms itself at
    // the break, works 120m from arming (incl. same-minute retouches, 1s path).
    // Candidate that broke while the slot was busy → plain limit for the
    // REMAINDER of its 120-bar fill window (its past touches are gone).
    const stopLimit = !a.broken;
    const armTimeout = Math.max(1, a.maxFormBars - a.barsSinceArm);
    const timeout = stopLimit
      ? this.params.timeoutCandles
      : Math.max(1, this.params.timeoutCandles - a.barsSinceBreak);

    const signal = {
      timestamp: ts + ONE_MIN_MS, // signal fires at bar CLOSE
      strategy: STRATEGY_ID,
      action: stopLimit ? 'place_stop_limit' : 'place_limit',
      side: 'buy',
      symbol,
      quantity,
      price: a.twin,                    // LIMIT price (fills exact, no slip)
      ...(stopLimit ? {
        stopTrigger: a.inval,           // arm level (the twin break)
        stop_trigger: a.inval,
        armTimeoutCandles: armTimeout,  // pre-break window (event working window)
        arm_timeout_candles: armTimeout,
      } : {}),
      timeoutCandles: timeout,          // limit working window (counts from arming)
      stopLoss,
      takeProfit,
      maxHoldBars: this.params.maxHoldBars,
      // Live orchestrator: this strategy trades all sessions and manages its
      // own 480m time cap — exempt from the production EOD flat. The backtest
      // engine ignores this field.
      exemptEodCutoff: true,
      // snake_case mirrors for downstream consumers
      stop_loss: stopLoss,
      take_profit: takeProfit,
      max_hold_bars: this.params.maxHoldBars,
      timeout_candles: timeout,
      exempt_eod_cutoff: true,
      metadata: {
        strategy: STRATEGY_ID,
        instanceId: a.instanceId,
        gen: a.gen,
        patternTs: a.armedTs,
        twinLevel: a.twin,
        invalidation: a.inval,
        patternStop: a.stop,
        patternTarget: a.target,
        atr14: +a.atr.toFixed(4),
        entryMode: stopLimit ? 'stop_limit_at_emission' : 'late_limit',
        latePlacementBars: stopLimit ? a.barsSinceArm : a.barsSinceBreak,
        breakTs: a.breakTs ? new Date(a.breakTs).toISOString() : null,
        exemptEodCutoff: true,
      },
    };

    this._lastSignal = signal;
    this._slot = 'pending';
    this._pendingCand = a;
    this._pending = {
      mode: stopLimit ? 'stoplimit' : 'limit',
      timeout,
      // Engine cancel accounting mirrored in candidate barsSinceBreak terms:
      // stop-limit: armedElapsed=1 at the END of the arming bar → cancel when
      //   barsSinceBreak reaches timeout−1; plain limit placed b0 bars after
      //   the break with timeout 120−b0 → cancel at barsSinceBreak = 120.
      cancelBsb: stopLimit ? timeout - 1 : this.params.timeoutCandles,
      lastHeartbeatTs: null,
    };

    if (this.params.debug) {
      console.log(`[PRL] ${signal.action} BUY lim@${a.twin}${stopLimit ? ` trig@${a.inval} armTtl=${armTimeout}` : ''} ` +
        `stop=${stopLoss} tgt=${takeProfit} timeout=${timeout}m (${a.instanceId})`);
    }
    this.updateLastSignalTime(signal.timestamp);
    return signal;
  }

  /**
   * Backtest hook: called each eval bar (after that bar's fill attempt) for
   * every still-pending order. Doubles as the strategy's pending heartbeat
   * (the slot state machine cannot observe fills/arms directly) and cancels
   * the working order on contract rollover (the reference cancels its limit
   * when the symbol changes: `if SYM[i] != SYM[ib]: break`; the engine's
   * calendar-spread adjustment does not translate stopTrigger).
   */
  shouldInvalidatePendingOrder(pendingSignal, candle /*, historicalCandles */) {
    if (!pendingSignal || pendingSignal.strategy !== STRATEGY_ID) return null;
    if (this._pending) {
      this._pending.lastHeartbeatTs = this.toMs(candle.timestamp);
    }
    const signalContract = pendingSignal.signalContract;
    if (signalContract && candle.symbol && candle.symbol !== signalContract) {
      this._slot = 'free';
      this._pending = null;
      this._pendingCand = null;
      return { shouldCancel: true, reason: `contract_roll: ${signalContract} → ${candle.symbol}` };
    }
    return null;
  }

  /**
   * Trade completed → slot free. The queue is normally already empty (cleared
   * at fill, no queueing while in-position); clearing again covers the
   * fill-and-exit-same-bar path where the fill was never separately inferred
   * (reference: every event emitted inside the trade's horizon is dropped).
   */
  onPositionClosed(/* info */) {
    this._slot = 'free';
    this._pending = null;
    this._pendingCand = null;
    this._positionBars = 0;
    this._posStop = NaN;
    this._posTarget = NaN;
    this._armed = [];
  }

  getStatus() {
    return {
      strategy: STRATEGY_ID,
      slot: this._slot,
      queuedCandidates: this._armed.length,
      lastSignal: this._lastSignal,
      engineStats: this.patternEngine?.stats || null,
    };
  }

  reset() {
    super.reset();
    this._initState();
  }
}
