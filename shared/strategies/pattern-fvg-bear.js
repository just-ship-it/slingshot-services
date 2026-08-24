/**
 * Pattern: Bearish Fair Value Gap retrace (fvg-bear-15m) — SHORT
 *
 * Price-structures program, phase-4 frozen config (2026-08-19, DEPLOY-CANDIDATE):
 * on a bearish FVG on 15m bars, rest a LIMIT SELL at fvgTop (full retrace into
 * the gap), skipped unless ema20Slope ≤ 0 (15m EMA20, with-trend only).
 * Exit: stop 1.5 ATR (re-anchored to actual fill), time cap 240m, NO target.
 * Dev 2021-24: PF 1.56 / $56.5k/yr / DD $13.4k. Val 2025-26: PF 1.57 / $66.2k.
 * Survives 1-tick trade-through pessimism (dev PF 1.50). Live queue behavior
 * to be observed in shadow before funding.
 * Source: research/price-structures/analysis/tuning/SUMMARY.md + tuning/fvg-bear-15m.md.
 * Reference semantics: research/price-structures/analysis/PS-40-fvgb.py
 * ("fvgb15-lim-top": limit at levels.extra.fvgTop, working from emission until
 * fill, a 1m bar CLOSE > levels.invalidation + 0.1×ATR, or the pattern's
 * maxFormingBars window — default 60 × 15m = 900 minutes).
 *
 * Mechanics:
 * - Embeds the streaming PatternEngine (shared/pattern-engine) with the fvg
 *   detector on ['1m','15m']; every closed 1m eval candle is fed via onBar1m.
 * - Consumes patternId 'fvg-bear', tf '15m', state 'forming' events. ATR and
 *   ema20Slope come from the EVENT's context (BarFeatures, Wilder-14 on closed
 *   15m bars) — never recomputed another way (parity mandate, PARITY-GATE.md).
 * - Pending-order invalidation (gap inversion): live orchestrator reads the
 *   top-level `cancelOnCloseBeyond` field; the backtest engine implements the
 *   same rule via the `shouldInvalidatePendingOrder` hook below (called each
 *   1m eval candle AFTER that candle's fill check — fill wins ties, matching
 *   the reference).
 * - FCFS one-at-a-time: the trade simulator (and live orchestrator slot)
 *   rejects signals while an order is pending or a position is open; new
 *   events during that window are dropped.
 */

import { BaseStrategy } from './base-strategy.js';
import { PatternEngine } from '../pattern-engine/engine.js';
import fvg from '../pattern-engine/patterns/structure/fvg.js';

const ONE_MIN_MS = 60 * 1000;
const STRATEGY_ID = 'PATTERN_FVG_BEAR';

export class PatternFvgBearStrategy extends BaseStrategy {
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
      // Pattern detection timeframe (engine aggregates 1m eval bars → 15m)
      patternTimeframe: '15m',
      patternTimeframeMin: 15,
      // Engine product (drives instanceId namespace; NQ for parity with research)
      product: 'NQ',
      // Entry: limit SELL at the top of the bearish FVG (full retrace)
      entryAction: 'place_limit',
      entryLevel: 'fvgTop',
      // Trend filter: skip unless EMA20 slope (15m, ATR-normalized) is flat/down
      maxEma20Slope: 0,
      // Stop distance: 1.5 × ATR(14, 15m) at emission (via signal.stopDistance,
      // so the engine re-anchors from the actual fill price)
      stopAtrMult: 1.5,
      // Pending-limit cancel: 1m close > invalidation + invEpsAtr × ATR
      invEpsAtr: 0.1,
      // Working window fallback when the event geometry carries no maxFormingBars
      defaultMaxFormingBars: 60,
      // Time cap: flat 240 minutes after fill, no profit target
      maxHoldBars: 240,
      useTarget: false,
      tradingSymbol: 'NQ1!',
      defaultQuantity: 1,
      debug: false
    };

    this.params = { ...this.defaultParams, ...params };
    this._initEngine();
    this._lastSignal = null; // status panel
  }

  _initEngine() {
    this.patternEngine = new PatternEngine({
      product: this.params.product,
      timeframes: ['1m', this.params.patternTimeframe],
      detectors: [fvg],
    });
    this._lastFedTs = -Infinity;
  }

  /** Feed one closed 1m candle into the embedded pattern engine (idempotent per ts). */
  _feed(c) {
    if (!c) return [];
    const ts = this.toMs(c.timestamp);
    if (!Number.isFinite(ts) || ts <= this._lastFedTs) return [];
    this._lastFedTs = ts;
    return this.patternEngine.onBar1m({
      ts,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume || 0,
      symbol: c.symbol || this.params.tradingSymbol,
    });
  }

  /**
   * @param {Object} candle - Closed 1m eval candle { timestamp, open, high, low, close, volume, symbol }
   * @param {Object} prevCandle - Previous candle
   * @param {Object} marketData - Market data bundle (unused; candles only)
   * @param {Object} options - Engine options (symbol/quantity overrides)
   * @returns {Object|null} Trade signal or null
   */
  evaluateSignal(candle, prevCandle, marketData, options = {}) {
    // The backtest engine starts eval at the 2nd candle; feed the very first
    // candle too so the aggregator/features see the full stream.
    let events = [];
    if (prevCandle && this.toMs(prevCandle.timestamp) > this._lastFedTs) {
      events = events.concat(this._feed(prevCandle));
    }
    events = events.concat(this._feed(candle));
    if (events.length === 0) return null;

    for (const evt of events) {
      if (evt.patternId !== 'fvg-bear') continue;
      if (evt.tf !== this.params.patternTimeframe) continue;
      if (evt.state !== 'forming') continue;

      const atr = evt.context?.atr14;
      if (!Number.isFinite(atr) || atr <= 0) continue;

      // Entry filter: with-trend only (15m EMA20 slope, ATR-normalized, ≤ 0)
      const slope = evt.context?.trend?.ema20Slope;
      if (!Number.isFinite(slope) || slope > this.params.maxEma20Slope) {
        if (this.params.debug) {
          console.log(`[PFB] skip ${evt.instanceId}: ema20Slope ${slope} > ${this.params.maxEma20Slope}`);
        }
        continue;
      }

      const fvgTop = evt.levels?.extra?.[this.params.entryLevel];
      const invalidation = evt.levels?.invalidation;
      if (!Number.isFinite(fvgTop) || !Number.isFinite(invalidation)) continue;

      // Working window: event geometry maxFormingBars (15m bars) → minutes.
      const maxFormingBars = evt.geometry?.maxFormingBars || this.params.defaultMaxFormingBars;
      const timeoutCandles = Math.round(maxFormingBars * this.params.patternTimeframeMin);

      const stopDistance = this.params.stopAtrMult * atr;
      const stopLoss = fvgTop + stopDistance; // provisional; re-anchored from actual fill via stopDistance
      const cancelBeyond = invalidation + this.params.invEpsAtr * atr;

      const symbol = options.symbol || this.params.tradingSymbol;
      const quantity = options.quantity || this.params.defaultQuantity;

      const signal = {
        timestamp: this.toMs(candle.timestamp) + ONE_MIN_MS, // signal fires at bar CLOSE
        strategy: STRATEGY_ID,
        action: 'place_limit',
        side: 'sell',
        symbol,
        quantity,
        price: fvgTop,
        // Resting-limit working window (1m candles from placement)
        timeoutCandles,
        // Stop re-anchored to actual entry on fill; no target, 240m time cap
        stopDistance,
        stopLoss,
        takeProfit: null,
        maxHoldBars: this.params.maxHoldBars,
        // Live orchestrator fields (backtest engine ignores them; the backtest
        // path implements the same cancel via shouldInvalidatePendingOrder):
        // pattern trades keep their own 240m clock — exempt from EOD flatten.
        exemptEodCutoff: true,
        cancelOnCloseBeyond: { price: cancelBeyond, side: 'above' },
        // snake_case mirrors for downstream consumers
        stop_loss: stopLoss,
        take_profit: null,
        max_hold_bars: this.params.maxHoldBars,
        stop_distance: stopDistance,
        timeout_candles: timeoutCandles,
        exempt_eod_cutoff: true,
        cancel_on_close_beyond: { price: cancelBeyond, side: 'above' },
        metadata: {
          strategy: STRATEGY_ID,
          instanceId: evt.instanceId,
          patternTs: evt.ts,
          atr14: +atr.toFixed(4),
          ema20Slope: slope,
          fvgTop,
          fvgBottom: evt.levels?.extra?.fvgBottom ?? null,
          ce: evt.levels?.extra?.ce ?? null,
          invalidation,
          cancelBeyond: +cancelBeyond.toFixed(4),
          gapAtr: evt.geometry?.gapAtr ?? null,
          session: evt.context?.session ?? null,
        },
      };

      if (this.params.debug) {
        console.log(`[PFB] SELL limit @${fvgTop} inv=${invalidation} cancel>${cancelBeyond.toFixed(2)} ` +
          `stopDist=${stopDistance.toFixed(2)} timeout=${timeoutCandles}m (${evt.instanceId})`);
      }

      this._lastSignal = signal;
      this.updateLastSignalTime(signal.timestamp);
      return signal; // at most one 15m fvg-bear event per 1m bar; FCFS handled downstream
    }

    return null;
  }

  /**
   * Backtest hook (backtest-engine calls this each 1m eval candle, after that
   * candle's fill attempt): cancel the resting limit when a 1m bar CLOSES
   * beyond the pattern invalidation + eps (gap inversion). Mirrors the live
   * orchestrator's `cancelOnCloseBeyond` handling and the reference sim's
   * `C[i] > inv + eps` check (strict inequality, fill-first ordering).
   *
   * @param {Object} pendingSignal - The signal attached to the pending order
   * @param {Object} candle - Current closed 1m candle
   * @returns {Object|null} { shouldCancel, reason } or null
   */
  shouldInvalidatePendingOrder(pendingSignal, candle /*, historicalCandles */) {
    if (!pendingSignal || pendingSignal.strategy !== STRATEGY_ID) return null;
    const cb = pendingSignal.cancelOnCloseBeyond || pendingSignal.cancel_on_close_beyond;
    if (!cb || !Number.isFinite(cb.price)) return null;
    const beyond = cb.side === 'below' ? candle.close < cb.price : candle.close > cb.price;
    if (beyond) {
      return {
        shouldCancel: true,
        reason: `gap_inversion: 1m close ${candle.close} ${cb.side === 'below' ? '<' : '>'} invalidation+eps ${cb.price.toFixed(2)}`,
      };
    }
    return null;
  }

  getStatus() {
    return {
      strategy: STRATEGY_ID,
      lastSignal: this._lastSignal,
      engineStats: this.patternEngine?.stats || null,
    };
  }

  reset() {
    super.reset();
    this._initEngine();
    this._lastSignal = null;
  }
}
