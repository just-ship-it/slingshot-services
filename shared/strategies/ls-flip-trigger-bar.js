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
      };
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

    // Step 3: trigger bar range. Skip degenerate bars.
    const range = candle.high - candle.low;
    if (!(range > 0)) {
      this._lastRejectReason = `degenerate bar (range=${range})`;
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
    const entryPrice = direction === 'long'
      ? candle.high - fib * range
      : candle.low + fib * range;
    const stopLoss = direction === 'long' ? candle.low : candle.high;
    const takeProfit = direction === 'long' ? candle.high : candle.low;

    // Sanity: entry should be strictly between stop and target.
    if (direction === 'long' && !(entryPrice > stopLoss && entryPrice < takeProfit)) {
      this._lastRejectReason = `sanity fail (long): entry ${entryPrice} not strictly between stop ${stopLoss} and target ${takeProfit}`;
      return null;
    }
    if (direction === 'short' && !(entryPrice < stopLoss && entryPrice > takeProfit)) {
      this._lastRejectReason = `sanity fail (short): entry ${entryPrice} not strictly between stop ${stopLoss} and target ${takeProfit}`;
      return null;
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
