/**
 * Pattern: Head & Shoulders Top (hs-top-5m) — SHORT
 *
 * Price-structures program, phase-4 frozen config (2026-08-19, DEPLOY-CANDIDATE):
 * detect a completed H&S top on 5m bars (streaming pattern-engine, forming
 * event = right-shoulder pivot confirmation), place a STOP-market SELL entry
 * at the neckline FROZEN at emission (slope forced to 0 — parity reference
 * out/parity/ref_pattern-hs-top.csv was produced with FREEZE_SLOPE, see
 * research/price-structures/analysis/PS-40-hs-frozen.py), cancel the pending
 * stop if unfilled after 10 minutes. Exit: stop 1.0 ATR14(5m) re-anchored to
 * the actual fill, time exit 30m, NO target (shorts bleed vs drift — edge is
 * the fast impulse).
 * Dev 2021-24: PF 2.04 / $18.3k/yr / DD $5.1k. Val 2025-26: PF 2.10 / $26.9k.
 * Source: research/price-structures/analysis/tuning/SUMMARY.md + tuning/hs-top-5m.md.
 *
 * Mechanics / conventions:
 * - Embeds a PatternEngine instance and feeds it every closed 1m candle. The
 *   engine is session-anchored (18:00 ET), hard-resets itself on contract
 *   rollover (symbol change), and only runs detectors once features are warm
 *   (expect a few missing signals in the first days of a cold-started range).
 * - ATR comes from the event's context.atr14 (pattern-engine BarFeatures,
 *   Wilder on closed 5m bars) — per the parity gate, never recomputed here.
 * - FCFS single slot: the strategy emits at most one signal per 1m close
 *   (first matching forming event wins); events that fire while an order is
 *   pending or a trade is open are DROPPED, not queued. The backtest engine
 *   enforces this via its single-position gate (processSignal rejects while
 *   any order/trade is active) and live the orchestrator's slot occupancy
 *   rule does the same — the strategy itself stays stateless about fills
 *   (it cannot observe them) and only dedupes per pattern instance.
 * - Entry requires the engine's `place_stop` action (stop-market entry, fills
 *   at neckline − stopOrderSlippage for the SELL; slip modeled 0.5pt).
 * - exemptEodCutoff: live orchestrator field (this strategy trades all
 *   sessions and manages its own 30m time exit); the backtest engine ignores
 *   it — parity runs use --allow-overnight-holds instead.
 */

import { BaseStrategy } from './base-strategy.js';
import { PatternEngine } from '../pattern-engine/engine.js';
import headShoulders from '../pattern-engine/patterns/chart/head-shoulders.js';
import { isValidCandle, roundTo } from './strategy-utils.js';

const ONE_MIN_MS = 60 * 1000;
const MAX_SIGNALED_INSTANCES = 4096;

export class PatternHsTopStrategy extends BaseStrategy {
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
      patternId: 'head-shoulders-top',
      product: 'NQ',
      // Entry: stop-market SELL at the neckline value FROZEN at emission
      // (levels.trigger; triggerSlope deliberately ignored — frozen config)
      entryAction: 'place_stop',
      // Cancel the pending stop entry if unfilled after N 1m candles
      timeoutCandles: 10,
      // Stop distance: 1.0 × ATR(14, 5m) at signal time (via signal.stopDistance
      // so the engine re-anchors from the actual fill)
      stopAtrMult: 1.0,
      // Time exit: flat 30 minutes after entry, no profit target
      maxHoldBars: 30,
      useTarget: false,
      tradingSymbol: 'NQ1!',
      defaultQuantity: 1,
      debug: false
    };

    this.params = { ...this.defaultParams, ...params };
    this._initPatternEngine();
    this._lastFedTs = null;          // guard against double-feeding a bar
    this._signaledInstances = new Set(); // per-instance dedupe (safety net)
    this._lastSignal = null;         // status panel
  }

  _initPatternEngine() {
    this.patternEngine = new PatternEngine({
      product: this.params.product,
      timeframes: ['1m', this.params.patternTimeframe],
      detectors: [headShoulders],
    });
  }

  /**
   * @param {Object} candle - Closed 1m eval candle
   * @param {Object} prevCandle - Previous candle
   * @param {Object} marketData - Market data bundle (unused — candles only)
   * @param {Object} options - Engine options ({ symbol, quantity } overrides)
   * @returns {Object|null} Trade signal or null
   */
  evaluateSignal(candle, prevCandle, marketData, options = {}) {
    if (!isValidCandle(candle)) return null;

    const ts = this.toMs(candle.timestamp);
    // Feed each closed 1m bar exactly once, in order (live reconnects can
    // replay bars; the aggregator handles gaps itself).
    if (this._lastFedTs != null && ts <= this._lastFedTs) return null;
    this._lastFedTs = ts;

    const events = this.patternEngine.onBar1m({
      ts,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: Number.isFinite(candle.volume) ? candle.volume : 0,
      symbol: candle.symbol || this.params.tradingSymbol,
    });
    if (!events.length) return null;

    // First matching forming event on this close wins (FCFS); the rest are
    // dropped — the reference sim booked the slot for the first event per ts.
    let ev = null;
    for (const e of events) {
      if (e.patternId === this.params.patternId &&
          e.tf === this.params.patternTimeframe &&
          e.state === 'forming' &&
          !this._signaledInstances.has(e.instanceId)) {
        ev = e;
        break;
      }
    }
    if (!ev) return null;

    // FROZEN neckline: levels.trigger at emission; triggerSlope ignored.
    const neckline = ev.levels?.trigger;
    const atr = ev.context?.atr14;
    if (!Number.isFinite(neckline) || !Number.isFinite(atr) || atr <= 0) return null;

    this._rememberInstance(ev.instanceId);

    const symbol = options.symbol || this.params.tradingSymbol;
    const quantity = options.quantity || this.params.defaultQuantity;
    const stopDistance = roundTo(this.params.stopAtrMult * atr, 4);
    // Indicative pre-fill stop (SELL: stop above entry); the engine re-anchors
    // from the actual fill via signal.stopDistance.
    const stopLoss = roundTo(neckline + stopDistance, 4);
    const signalTs = ts + ONE_MIN_MS; // signal fires at bar CLOSE

    const signal = {
      timestamp: signalTs,
      side: 'sell',
      action: this.params.entryAction,        // 'place_stop'
      price: neckline,                        // stop-entry trigger level
      strategy: 'PATTERN_HS_TOP',
      symbol,
      quantity,
      timeoutCandles: this.params.timeoutCandles,
      stopLoss,
      takeProfit: null,                       // no target — time exit only
      stopDistance,                           // re-anchor stop from actual fill
      maxHoldBars: this.params.maxHoldBars,
      // Live orchestrator: this strategy trades all sessions and manages its
      // own 30m time exit — exempt from the production EOD flat. The backtest
      // engine ignores this field.
      exemptEodCutoff: true,
      metadata: {
        strategy: 'PATTERN_HS_TOP',
        instanceId: ev.instanceId,
        exemptEodCutoff: true,
        gen: ev.geometry?.gen ?? null,
        neckline,
        necklineSlopeIgnored: ev.levels?.triggerSlope ?? null,
        atr14: atr,
        headHeightAtr: ev.geometry?.headHeightAtr ?? null,
        session: ev.context?.session ?? null,
        tradeDate: ev.context?.tradeDate ?? null,
      },
      // snake_case duplicates for downstream consumers
      stop_loss: stopLoss,
      take_profit: null,
      max_hold_bars: this.params.maxHoldBars,
      stop_distance: stopDistance,
    };

    this.updateLastSignalTime(signalTs);
    this._lastSignal = {
      ts: signalTs,
      side: 'sell',
      price: roundTo(neckline),
      stopDistance,
      instanceId: ev.instanceId,
      note: `H&S top 5m · stop-SELL @ neckline · cancel ${this.params.timeoutCandles}m · flat ${this.params.maxHoldBars}m`,
    };

    if (this.params.debug) {
      console.log(`[PHS] ${new Date(signalTs).toISOString()} SELL stop @ ${neckline.toFixed(2)} ` +
        `(ATR ${atr.toFixed(2)}, ${ev.instanceId})`);
    }

    return signal;
  }

  _rememberInstance(instanceId) {
    this._signaledInstances.add(instanceId);
    if (this._signaledInstances.size > MAX_SIGNALED_INSTANCES) {
      // Drop the oldest half (Set preserves insertion order)
      const keep = [...this._signaledInstances].slice(MAX_SIGNALED_INSTANCES / 2);
      this._signaledInstances = new Set(keep);
    }
  }

  /** Readiness snapshot for the dashboard book panel. */
  getInternalState() {
    return {
      kind: 'pattern-hs-top',
      state: 'scanning',
      seeded: this._lastFedTs != null,
      direction: 'SHORT',
      condition: {
        kind: 'pattern',
        label: 'Forming 5m head-shoulders-top (pattern engine)',
        met: null,
      },
      lastSignal: this._lastSignal,
    };
  }

  reset() {
    super.reset();
    this._initPatternEngine();
    this._lastFedTs = null;
    this._signaledInstances = new Set();
    this._lastSignal = null;
  }
}
