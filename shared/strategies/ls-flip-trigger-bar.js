/**
 * LS Flip Trigger-Bar Strategy (ls-flip-trigger-bar)
 *
 * Treats every 1m Liquidity Status (LS) flip as a structural trade:
 *   - Trigger bar = the 1m candle on which LS state changed.
 *   - Direction = LONG after state→1, SHORT after state→0.
 *   - Entry    = limit at fib retrace of trigger bar (default 0.5):
 *                LONG  = high − fib * range
 *                SHORT = low  + fib * range
 *   - Stop     = opposite bar extreme (LONG=low, SHORT=high).
 *   - Target   = same-side bar extreme  (LONG=high, SHORT=low).
 *   - Fill     = limit persists for `fillTimeoutCandles` 1m bars then cancels.
 *
 * Noise filter (primary edge per Phase I-3 sweep):
 *   - cb_atr = |close − open| / ATR(20) on primary 1m series.
 *   - Reject signal when cb_atr ≥ cbAtrMax (default 1.81).
 *     Drops "big body" momentum flips that fail to retrace into the limit.
 *
 * Research source: backtest-engine/research/ls-flip-edge/
 *   20-trigger-bar-trade.js   single-leg fib=0.5, 1s-honest stop/target
 *   24-trigger-bar-2phase.js  two-leg variant (fib=0.5 + 0.786)
 *   25-2phase-filter.js       cb_atr<1.81 filter on top
 *
 * 2-phase note: the chosen research config is two-phase ($273k baseline)
 *   but the engine's TradeSimulator allows only one active position at
 *   a time. This file ships the single-leg fib=0.5 variant ($199k research
 *   baseline) as the directly-tradeable MVP. To re-add the 0.786 leg, the
 *   engine needs concurrent-trade support — out of scope for this strategy.
 */

import { BaseStrategy } from './base-strategy.js';

const ONE_MIN_MS = 60_000;

export class LsFlipTriggerBarStrategy extends BaseStrategy {
  static getDataRequirements() {
    return {
      candles: { baseSymbol: 'NQ', quoteSymbols: ['CME_MINI:NQ1!'] },
      gex: false,
      lt: false,
      lt1m: false,
      ls1m: true,        // strategy reads --ls-1m-file (LS state change CSV)
      tradier: false,
      ivSkew: false,
    };
  }

  constructor(params = {}) {
    super(params);

    this.params.tradingSymbol = params.tradingSymbol ?? 'NQ';
    this.params.defaultQuantity = params.defaultQuantity ?? 1;

    // Fib retrace level for limit entry (0.5 = midpoint of trigger bar)
    this.params.fib = params.fib ?? 0.5;

    // cb_atr filter threshold: reject signals where bar body / ATR(20) >= max
    this.params.cbAtrMax = params.cbAtrMax ?? 1.81;
    this.params.atrPeriod = params.atrPeriod ?? 20;

    // Limit order fill window: cancel if not filled within N 1m bars
    this.params.fillTimeoutCandles = params.fillTimeoutCandles ?? 10;

    // Max hold AFTER fill (1m bars). Beyond this, exit at close.
    this.params.maxHoldBars = params.maxHoldBars ?? 60;

    // Blocked ET hours (entries skipped during these hours). Default skips
    // the three negative-expectancy hours identified in the per-hour analysis:
    // 5 ET (NY pre-EU lull), 16 ET (post-close drift), 21 ET (Asia drift).
    this.params.blockedHoursEt = new Set(params.blockedHoursEt ?? [5, 16, 21]);

    // Optional fixed-point stops/targets. When set, override bar-extreme defaults.
    //   stopPoints  : stop is entry ∓ stopPoints (signed by direction)
    //   targetPoints: target is entry ± targetPoints
    this.params.stopPoints = params.stopPoints ?? null;
    this.params.targetPoints = params.targetPoints ?? null;

    // Instrument tick size. Entry = high − fib*range can land off-tick
    // (e.g. mid of a 24.25-pt bar = .375), which the broker rejects. Round
    // entry to the tick grid, then derive stop/target from the rounded entry.
    this.params.tickSize = params.tickSize ?? 0.25;

    // Optional break-even / trail forwarded to engine.
    this.params.breakevenStop = params.breakevenStop ?? false;
    this.params.breakevenTrigger = params.breakevenTrigger ?? null;
    this.params.breakevenOffset = params.breakevenOffset ?? 0;
    this.params.trailingTrigger = params.trailingTrigger ?? null;
    this.params.trailingOffset = params.trailingOffset ?? null;

    // Optional minimum trigger-bar range filter (in points). Skip flips where
    // the trigger bar's range is too tight — tiny bars have negative expectancy.
    this.params.minTriggerRange = params.minTriggerRange ?? null;

    // Optional LT-sentiment alignment filter. When true, only take flips whose
    // direction agrees with the prevailing 15m LT sentiment (BULLISH→long,
    // BEARISH→short). Meta-label research (2026-06-20) found LT-aligned flips
    // run PF ~1.78 vs ~1.44 for misaligned, WR 73.8% vs 70.7%. When the LT
    // sentiment is unavailable for a bar, the flip is NOT blocked (fail-open).
    this.params.requireLtAlign = params.requireLtAlign ?? false;

    // Optional LT target-clearance filter. When true, reject flips where a 15m LT
    // level sits inside the take-profit path. Meta-label research (2026-06-21).
    this.params.requireLtTargetClear = params.requireLtTargetClear ?? false;

    // Optional flip-at-level filter. When true, only take flips firing within
    // flipAtLevelAtr × ATR(20) of a 1m LT level (raw space). Meta-label research
    // (2026-06-21, corrected price space): on top of ltAlign, flip-at-level PF
    // 1.99 vs 1.78, keeping ~48% of aligned trades. Requires --lt-1m-file loaded
    // (marketData.ltLevels1m). Fail-open when 1m LT levels are unavailable.
    this.params.requireLtFlipAtLevel = params.requireLtFlipAtLevel ?? false;
    this.params.flipAtLevelAtr = params.flipAtLevelAtr ?? 0.5;

    // ATR rolling state — true range list on the primary contract series.
    // Reset on contract rollover (symbol change) so TR doesn't span the
    // ~200pt roll spread.
    this._tr = [];
    this._lastSymbol = null;
    this._lastClose = null;

    // Prevent firing twice on the same flip event (defensive — engine
    // already calls evaluateSignal once per bar close).
    this._lastFlipTs = 0;

    // Dashboard-facing state (read by getInternalState()).
    this._lastSeenLs = null;      // { timestamp, state, sentiment } — latest flip we OBSERVED
    this._lastSignal = null;      // { ts, side, direction, entryPrice, stopLoss, takeProfit, cbAtr, atr20 }
    this._lastRejectReason = null; // last reason a flip didn't produce a signal

    this.params.debug = params.debug ?? false;
  }

  reset() {
    super.reset();
    this._tr = [];
    this._lastSymbol = null;
    this._lastClose = null;
    this._lastFlipTs = 0;
  }

  /**
   * Update rolling ATR(20) with the current bar. Returns ATR or null if
   * insufficient bars / contract just rolled.
   */
  _updateAtr(candle) {
    const sym = candle.symbol || null;
    if (sym !== this._lastSymbol) {
      this._tr = [];
      this._lastSymbol = sym;
      this._lastClose = null;
    }

    let tr;
    if (this._lastClose == null) {
      tr = candle.high - candle.low;
    } else {
      tr = Math.max(
        candle.high - candle.low,
        Math.abs(candle.high - this._lastClose),
        Math.abs(candle.low - this._lastClose),
      );
    }
    this._tr.push(tr);
    if (this._tr.length > this.params.atrPeriod) this._tr.shift();
    this._lastClose = candle.close;

    if (this._tr.length < this.params.atrPeriod) return null;
    let sum = 0;
    for (const v of this._tr) sum += v;
    return sum / this._tr.length;
  }

  getETHour(timestamp) {
    return parseInt(new Date(timestamp).toLocaleString('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      hour12: false,
    }), 10);
  }

  evaluateSignal(candle, prevCandle, marketData, options = {}) {
    // Step 1: maintain ATR(20) regardless of whether a signal fires this bar.
    const atr = this._updateAtr(candle);

    // Step 2: need LS state record at this bar's timestamp.
    // marketData.lsState1m is the record at candle.timestamp (or null).
    // Each record IS a flip — Pine emits only on state changes.
    const lsRec = marketData?.lsState1m;
    if (!lsRec) return null;

    // Step 2a: track latest observed flip (regardless of whether we trade it).
    // Used by the dashboard panel so the user can see when LS last flipped
    // even on bars where the trade was rejected.
    if (lsRec.timestamp !== this._lastSeenLs?.timestamp) {
      this._lastSeenLs = {
        timestamp: lsRec.timestamp,
        state: lsRec.state,
        sentiment: lsRec.sentiment || (lsRec.state === 1 ? 'BULLISH' : 'BEARISH'),
        gap: lsRec.gap === true,
      };
    }

    // Step 2a': gap rejection — the lt-monitor flagged this flip as following
    // a missing-bars window (TV reconnect or feed blip), which means we
    // CAN'T be sure THIS is the actual trigger bar. The real flip might
    // have happened on a bar we never saw. Trading off this would mean
    // entering at the wrong fib level of the wrong bar. Skip — but keep
    // _lastSeenLs updated so the dashboard reflects current sentiment.
    if (lsRec.gap === true) {
      this._lastRejectReason = `gap-catchup flip (gap=${lsRec.gapSec}s since prior confirmed bar) — actual trigger bar may have been missed`;
      return null;
    }

    // Step 2b: blocked ET hour check — skip entries during negative-expectancy hours.
    if (this.params.blockedHoursEt.has(this.getETHour(candle.timestamp))) {
      this._lastRejectReason = `blocked hour ${this.getETHour(candle.timestamp)} ET`;
      return null;
    }

    // Exact timestamp match required. The bar timestamp is bar start;
    // the LS record's unix_ms is also the bar start of the flip bar.
    if (lsRec.timestamp !== candle.timestamp) {
      this._lastRejectReason = `LS flip ts (${lsRec.timestamp}) != candle ts (${candle.timestamp}) — race or stale flip`;
      return null;
    }

    // Defensive: don't fire twice on the same flip.
    if (lsRec.timestamp === this._lastFlipTs) {
      this._lastRejectReason = `duplicate eval for flip @ ${new Date(lsRec.timestamp).toISOString()}`;
      return null;
    }

    const newState = lsRec.state;
    if (newState !== 0 && newState !== 1) {
      this._lastRejectReason = `invalid LS state ${newState}`;
      return null;
    }

    // Direction: state→1 = bullish flip → LONG; state→0 = bearish flip → SHORT
    const side = newState === 1 ? 'buy' : 'sell';
    const direction = newState === 1 ? 'long' : 'short';

    // Step 2c: LT-sentiment alignment filter (optional). Reject flips that fight
    // the prevailing 15m LT sentiment. Fail-open when sentiment is unavailable.
    if (this.params.requireLtAlign) {
      const sent = marketData?.ltLevels?.sentiment ?? marketData?.liquidityLevels?.sentiment;
      if (sent === 'BULLISH' || sent === 'BEARISH') {
        const bull = sent === 'BULLISH';
        const aligned = (direction === 'long' && bull) || (direction === 'short' && !bull);
        if (!aligned) {
          this._lastRejectReason = `LT sentiment ${sent} misaligned with ${direction} flip`;
          return null;
        }
      }
    }

    // Step 3: trigger bar range. Skip degenerate bars.
    const range = candle.high - candle.low;
    if (!(range > 0)) {
      this._lastRejectReason = `degenerate bar (range=${range})`;
      return null;
    }
    if (this.params.minTriggerRange != null && range < this.params.minTriggerRange) {
      this._lastRejectReason = `range=${range.toFixed(2)} < minTriggerRange=${this.params.minTriggerRange}`;
      return null;
    }

    // Step 4: cb_atr filter — reject big-body momentum flips that don't retrace.
    if (atr == null || atr <= 0) {
      this._lastRejectReason = `ATR not warm (${this._tr.length}/${this.params.atrPeriod} bars buffered)`;
      return null;
    }
    const body = Math.abs(candle.close - candle.open);
    const cbAtr = body / atr;
    if (cbAtr >= this.params.cbAtrMax) {
      this._lastRejectReason = `cb_atr=${cbAtr.toFixed(2)} >= ${this.params.cbAtrMax} (big-body filter)`;
      if (this.params.debug) {
        console.log(`[LS-FLIP] reject cb_atr=${cbAtr.toFixed(2)} >= ${this.params.cbAtrMax} @ ${new Date(candle.timestamp).toISOString()}`);
      }
      return null;
    }

    // Step 5: compute entry / stop / target.
    const fib = this.params.fib;
    const rawEntry = direction === 'long'
      ? candle.high - fib * range
      : candle.low + fib * range;
    // Round entry to tick grid. With fib=0.5 a 24.25-pt bar yields a .125
    // half-tick midpoint — brokers reject off-tick limit prices.
    const tick = this.params.tickSize;
    const entryPrice = Math.round(rawEntry / tick) * tick;
    // Stop/target defaults are the bar extremes, optionally overridden by fixed
    // points from entryPrice when stopPoints / targetPoints params are set.
    let stopLoss = direction === 'long' ? candle.low : candle.high;
    let takeProfit = direction === 'long' ? candle.high : candle.low;
    if (this.params.stopPoints != null) {
      stopLoss = direction === 'long'
        ? entryPrice - this.params.stopPoints
        : entryPrice + this.params.stopPoints;
    }
    if (this.params.targetPoints != null) {
      takeProfit = direction === 'long'
        ? entryPrice + this.params.targetPoints
        : entryPrice - this.params.targetPoints;
    }

    // Sanity: entry should be strictly between stop and target.
    if (direction === 'long' && !(entryPrice > stopLoss && entryPrice < takeProfit)) {
      this._lastRejectReason = `sanity fail (long): entry ${entryPrice} not strictly between stop ${stopLoss} and target ${takeProfit}`;
      return null;
    }
    if (direction === 'short' && !(entryPrice < stopLoss && entryPrice > takeProfit)) {
      this._lastRejectReason = `sanity fail (short): entry ${entryPrice} not strictly between stop ${stopLoss} and target ${takeProfit}`;
      return null;
    }

    // Step 5b: LT target-clearance filter (optional). Reject when a 15m LT level
    // sits inside the take-profit path (entry → takeProfit) — the level acts as a
    // wall the target must punch through, lowering hit probability. Meta-label
    // research (2026-06-21): blocked-target trades run PF 1.35 vs 1.66 clear, and
    // on top of ltAlign the clear subset is PF 1.85 vs 1.78. Fail-open when LT
    // levels are unavailable.
    if (this.params.requireLtTargetClear) {
      const lt = marketData?.ltLevels ?? marketData?.liquidityLevels;
      if (lt) {
        const levels = [lt.level_1, lt.level_2, lt.level_3, lt.level_4, lt.level_5]
          .filter(x => Number.isFinite(x) && x > 0);
        for (const L of levels) {
          const blocks = direction === 'long'
            ? (L > entryPrice && L < takeProfit)
            : (L < entryPrice && L > takeProfit);
          if (blocks) {
            this._lastRejectReason = `LT level ${L} blocks ${direction} target path (${entryPrice}→${takeProfit})`;
            return null;
          }
        }
      }
    }

    // Step 5c: flip-at-level filter (optional). Reject flips that fire far from
    // any 1m LT level (raw space). The trade thesis is a reversal at liquidity;
    // flips in open space are lower quality. Fail-open when 1m LT unavailable.
    if (this.params.requireLtFlipAtLevel) {
      const lt1m = marketData?.ltLevels1m;
      if (lt1m) {
        const levels = [lt1m.level_1, lt1m.level_2, lt1m.level_3, lt1m.level_4, lt1m.level_5]
          .filter(x => Number.isFinite(x) && x > 0);
        if (levels.length && atr > 0) {
          let nearest = Infinity;
          for (const L of levels) nearest = Math.min(nearest, Math.abs(candle.close - L));
          if (nearest > this.params.flipAtLevelAtr * atr) {
            this._lastRejectReason = `flip ${(nearest / atr).toFixed(2)} ATR from nearest 1m LT level > ${this.params.flipAtLevelAtr}`;
            return null;
          }
        }
      }
    }

    this._lastFlipTs = lsRec.timestamp;

    const symbol = options.symbol || this.params.tradingSymbol;
    const quantity = options.quantity || this.params.defaultQuantity;

    const signal = {
      timestamp: candle.timestamp + ONE_MIN_MS, // signal fires at bar CLOSE
      side,
      price: entryPrice,
      action: 'place_limit',
      timeoutCandles: this.params.fillTimeoutCandles,
      strategy: 'LS_FLIP_TRIGGER_BAR',
      symbol,
      quantity,
      stopLoss,
      takeProfit,
      maxHoldBars: this.params.maxHoldBars,
      // Structural invalidation: cancel the pending limit if price hits either
      // trigger-bar extreme before fill. Models the research's
      // no_fill_target_first / no_fill_stop_first outcomes — the trade thesis
      // requires a retrace to the fib midpoint; running through an extreme
      // first invalidates the setup.
      cancelOnPreFillExtreme: true,
      // Adverse-flip cancel: if a subsequent opposite-direction LS flip
      // occurs before fill, the directional bias is invalidated → cancel.
      // adverseFlipTs is precomputed by the LS loader (always the next
      // record's timestamp since every LS row is a state change).
      adverseFlipCancelTs: lsRec.adverseFlipTs || null,
      metadata: {
        strategy: 'LS_FLIP_TRIGGER_BAR',
        flipTs: lsRec.timestamp,
        newState,
        direction,
        fib,
        cbAtr: +cbAtr.toFixed(4),
        atr20: +atr.toFixed(4),
        triggerBar: {
          open: candle.open, high: candle.high,
          low: candle.low, close: candle.close, range,
        },
      },
      // snake_case duplicates for downstream consumers
      stop_loss: stopLoss,
      take_profit: takeProfit,
      max_hold_bars: this.params.maxHoldBars,
      // When fixed stop/target points are used, tell the engine to re-anchor
      // them to actualEntry on fill (handles favorable/unfavorable fill slip).
      // For bar-extreme stops (default), no re-anchoring — the bar levels are
      // the absolute trigger thresholds independent of fill.
      ...(this.params.stopPoints != null ? { stopDistance: this.params.stopPoints } : {}),
      ...(this.params.targetPoints != null ? { targetDistance: this.params.targetPoints } : {}),
      // Forward BE/trail to the engine — these are no-ops unless params are set.
      ...(this.params.breakevenStop ? {
        breakevenStop: true,
        breakevenTrigger: this.params.breakevenTrigger,
        breakevenOffset: this.params.breakevenOffset,
        breakeven_stop: true,
        breakeven_trigger: this.params.breakevenTrigger,
        breakeven_offset: this.params.breakevenOffset,
      } : {}),
      ...(this.params.trailingTrigger != null && this.params.trailingOffset != null ? {
        trailingTrigger: this.params.trailingTrigger,
        trailingOffset: this.params.trailingOffset,
        trailing_trigger: this.params.trailingTrigger,
        trailing_offset: this.params.trailingOffset,
      } : {}),
    };

    this.updateLastSignalTime(signal.timestamp);
    this._lastSignal = {
      ts: signal.timestamp,
      side,
      direction,
      entryPrice: +entryPrice.toFixed(2),
      stopLoss,
      takeProfit,
      cbAtr: +cbAtr.toFixed(4),
      atr20: +atr.toFixed(4),
      flipTs: lsRec.timestamp,
      symbol,
      triggerBar: { open: candle.open, high: candle.high, low: candle.low, close: candle.close, range },
    };
    this._lastRejectReason = null;
    return signal;
  }

  /**
   * Snapshot the strategy's runtime state for the dashboard. Returned object
   * is rendered by LsFlipTriggerBarPanel.jsx.
   */
  getInternalState() {
    return {
      params: {
        fib: this.params.fib,
        cbAtrMax: this.params.cbAtrMax,
        atrPeriod: this.params.atrPeriod,
        fillTimeoutCandles: this.params.fillTimeoutCandles,
        maxHoldBars: this.params.maxHoldBars,
        blockedHoursEt: Array.from(this.params.blockedHoursEt).sort((a, b) => a - b),
        eodCutoffEt: this.params.eodCutoffEt || null,
      },
      lastFlip: this._lastSeenLs,        // { timestamp, state, sentiment } or null
      lastSignal: this._lastSignal,      // last signal emitted (or null)
      lastRejectReason: this._lastRejectReason, // string or null
      atrWarm: this._tr.length >= this.params.atrPeriod,
      atrBarsBuffered: this._tr.length,
    };
  }
}
