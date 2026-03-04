/**
 * DC St1 Strategy - Scaling Law Entry
 *
 * Based on Strategy 1 from "A genetic algorithm for the optimization of
 * multi-threshold trading strategies in the directional changes paradigm"
 * (Salman et al., 2025).
 *
 * Entry Logic (adapted for bidirectional futures):
 * - Long: During downtrend, when price overshoots by entryMultiplier * theta
 *   from the high extremum (scaling law predicts reversal)
 * - Short: During uptrend, when price overshoots by entryMultiplier * theta
 *   from the low extremum
 *
 * The paper was long-only with 2x theta entry. We extend to bidirectional
 * with configurable multiplier and futures-appropriate risk management.
 */

import { BaseStrategy } from './base-strategy.js';
import { isValidCandle, roundTo } from './strategy-utils.js';
import { DCEngine } from '../dc/dc-engine.js';

export class DCSt1Strategy extends BaseStrategy {
  static getDataRequirements() {
    return {
      candles: {
        baseSymbol: 'NQ',
        quoteSymbols: ['CME_MINI:NQ1!']
      },
      gex: false,
      lt: false,
      tradier: false,
      ivSkew: false
    };
  }

  constructor(params = {}) {
    super(params);

    this.defaultParams = {
      // DC Engine parameters
      theta: 0.001,              // 0.1% threshold
      usePoints: false,          // Percentage mode by default
      entryMultiplier: 2.0,      // Enter at N*theta overshoot (paper default: 2)

      // Risk management
      stopLossPoints: 15,        // Fixed stop distance in points
      takeProfitPoints: 30,      // Fixed target distance in points
      useExtremumStop: false,    // Use extremum price for stop placement
      extremumStopBuffer: 5,     // Buffer beyond extremum for stop

      // Trailing stop
      useTrailingStop: false,
      trailingTrigger: 10,       // Points profit before trail activates
      trailingOffset: 5,         // Trail distance

      // Signal management
      signalCooldownMs: 60000,   // 60 seconds between signals
      allowLongs: true,
      allowShorts: true,

      // Symbol configuration
      tradingSymbol: 'NQ1!',
      defaultQuantity: 1,

      // Session filtering
      useSessionFilter: true,
      allowedSessions: ['rth'],

      // Max hold
      maxHoldBars: 0,            // 0 = no max hold limit

      // Limit order timeout
      limitOrderTimeout: 3,      // Cancel unfilled after 3 candles
    };

    this.params = { ...this.defaultParams, ...params };

    // Map CLI param names
    if (params.stopBuffer !== undefined && params.stopLossPoints === undefined) {
      this.params.stopLossPoints = params.stopBuffer;
    }
    if (params.targetPoints !== undefined && params.takeProfitPoints === undefined) {
      this.params.takeProfitPoints = params.targetPoints;
    }

    // Initialize DC engine
    this.dcEngine = new DCEngine({
      theta: this.params.theta,
      usePoints: this.params.usePoints
    });

    // Deduplication: track last extremum that triggered a signal
    // to avoid re-signaling the same overshoot move
    this.lastSignaledExtremumLong = null;
    this.lastSignaledExtremumShort = null;
  }

  /**
   * Check if price has overshot by the entry multiplier threshold
   * @param {number} price - Current price
   * @param {number} extremum - Extremum price to measure from
   * @param {string} direction - 'long' (price fell from high) or 'short' (price rose from low)
   * @returns {boolean}
   */
  hasEntryOvershoot(price, extremum, direction) {
    const threshold = this.params.entryMultiplier * this.params.theta;

    if (this.params.usePoints) {
      if (direction === 'long') {
        // Price dropped entryMultiplier*theta points from the high extremum
        return extremum - price >= threshold;
      } else {
        // Price rose entryMultiplier*theta points from the low extremum
        return price - extremum >= threshold;
      }
    } else {
      if (direction === 'long') {
        // Price dropped entryMultiplier*theta percent from high extremum
        return price <= extremum * (1 - threshold);
      } else {
        // Price rose entryMultiplier*theta percent from low extremum
        return price >= extremum * (1 + threshold);
      }
    }
  }

  /**
   * Get the current trading session based on timestamp (EST)
   */
  getSession(timestamp) {
    const date = new Date(timestamp);
    const estString = date.toLocaleString('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      minute: 'numeric',
      hour12: false
    });

    const [hourStr, minStr] = estString.split(':');
    const hour = parseInt(hourStr);
    const min = parseInt(minStr);
    const timeDecimal = hour + min / 60;

    if (timeDecimal >= 18 || timeDecimal < 4) return 'overnight';
    if (timeDecimal >= 4 && timeDecimal < 9.5) return 'premarket';
    if (timeDecimal >= 9.5 && timeDecimal < 16) return 'rth';
    return 'afterhours';
  }

  /**
   * Check if current session is allowed
   */
  isAllowedSession(timestamp) {
    if (!this.params.useSessionFilter) return true;
    return this.params.allowedSessions.includes(this.getSession(timestamp));
  }

  evaluateSignal(candle, prevCandle, marketData, options = {}) {
    const debug = options.debug || this.params.debug;

    // Validate candle
    if (!isValidCandle(candle)) {
      if (debug) console.log('[DC_ST1] Invalid candle');
      return null;
    }

    // Check cooldown
    const cooldownMs = options.cooldownMs || this.params.signalCooldownMs;
    if (!this.checkCooldown(candle.timestamp, cooldownMs)) {
      if (debug) {
        const currentMs = this.toMs(candle.timestamp);
        const remainingMs = (this.lastSignalTime + cooldownMs) - currentMs;
        console.log(`[DC_ST1] In cooldown (${Math.ceil(remainingMs / 1000)}s remaining)`);
      }
      return null;
    }

    // Check session filter
    if (!this.isAllowedSession(candle.timestamp)) {
      if (debug) console.log(`[DC_ST1] Session filter blocked (${this.getSession(candle.timestamp)})`);
      return null;
    }

    const price = candle.close;

    // Feed price to DC engine
    const dcEvent = this.dcEngine.update(price, candle.timestamp);
    const state = this.dcEngine.getState();

    // Need established trend to evaluate entries
    if (!state.trend) {
      if (debug) console.log('[DC_ST1] No trend established yet');
      return null;
    }

    // Log DC events for debugging
    if (debug && dcEvent) {
      console.log(`[DC_ST1] DC Event: ${dcEvent.type} at ${price}, extremum=${dcEvent.extremum}, theta=${this.params.theta}`);
    }

    // --- Long Entry ---
    // During downtrend: price has fallen far enough from the high extremum
    if (this.params.allowLongs && state.trend === 'downtrend') {
      if (this.hasEntryOvershoot(price, state.p_ext_h, 'long')) {
        // Deduplication: don't re-signal if we already signaled this overshoot
        const extremumKey = `${state.p_ext_h}_${state.t_ext_h}`;
        if (this.lastSignaledExtremumLong !== extremumKey) {
          this.lastSignaledExtremumLong = extremumKey;
          this.updateLastSignalTime(candle.timestamp);

          if (debug) {
            const drop = this.params.usePoints
              ? (state.p_ext_h - price).toFixed(2)
              : ((1 - price / state.p_ext_h) * 100).toFixed(4);
            console.log(`[DC_ST1] LONG SIGNAL: price=${price}, p_ext_h=${state.p_ext_h}, drop=${drop}${this.params.usePoints ? 'pts' : '%'}, DC_events=${state.N_DC}`);
          }

          return this.generateSignal(candle, 'buy', state);
        } else if (debug) {
          console.log(`[DC_ST1] Long dedup: already signaled this overshoot from ${state.p_ext_h}`);
        }
      }
    }

    // --- Short Entry ---
    // During uptrend: price has risen far enough from the low extremum
    if (this.params.allowShorts && state.trend === 'uptrend') {
      if (this.hasEntryOvershoot(price, state.p_ext_l, 'short')) {
        // Deduplication
        const extremumKey = `${state.p_ext_l}_${state.t_ext_l}`;
        if (this.lastSignaledExtremumShort !== extremumKey) {
          this.lastSignaledExtremumShort = extremumKey;
          this.updateLastSignalTime(candle.timestamp);

          if (debug) {
            const rise = this.params.usePoints
              ? (price - state.p_ext_l).toFixed(2)
              : ((price / state.p_ext_l - 1) * 100).toFixed(4);
            console.log(`[DC_ST1] SHORT SIGNAL: price=${price}, p_ext_l=${state.p_ext_l}, rise=${rise}${this.params.usePoints ? 'pts' : '%'}, DC_events=${state.N_DC}`);
          }

          return this.generateSignal(candle, 'sell', state);
        } else if (debug) {
          console.log(`[DC_ST1] Short dedup: already signaled this overshoot from ${state.p_ext_l}`);
        }
      }
    }

    // Debug: show current state periodically
    if (debug && this.dcEngine.observationCount % 100 === 0) {
      console.log(`[DC_ST1] State: trend=${state.trend}, p_ext_h=${state.p_ext_h?.toFixed(2)}, p_ext_l=${state.p_ext_l?.toFixed(2)}, DC_events=${state.N_DC}, OSV=${state.OSV_CUR?.toFixed(6)}`);
    }

    return null;
  }

  /**
   * Generate signal object
   */
  generateSignal(candle, side, dcState) {
    const entryPrice = candle.close;
    let stopPrice, targetPrice;

    if (side === 'buy') {
      if (this.params.useExtremumStop) {
        // Stop below the low extremum that we're bouncing from
        stopPrice = dcState.p_ext_l - this.params.extremumStopBuffer;
      } else {
        stopPrice = entryPrice - this.params.stopLossPoints;
      }
      targetPrice = entryPrice + this.params.takeProfitPoints;
    } else {
      if (this.params.useExtremumStop) {
        // Stop above the high extremum that we're fading
        stopPrice = dcState.p_ext_h + this.params.extremumStopBuffer;
      } else {
        stopPrice = entryPrice + this.params.stopLossPoints;
      }
      targetPrice = entryPrice - this.params.takeProfitPoints;
    }

    return {
      strategy: 'DC_ST1',
      side,
      action: 'place_limit',
      symbol: this.params.tradingSymbol,
      price: roundTo(entryPrice),
      stop_loss: roundTo(stopPrice),
      take_profit: roundTo(targetPrice),
      quantity: this.params.defaultQuantity,
      timestamp: new Date(candle.timestamp).toISOString(),

      trailing_trigger: this.params.useTrailingStop ? this.params.trailingTrigger : null,
      trailing_offset: this.params.useTrailingStop ? this.params.trailingOffset : null,

      metadata: {
        // DC engine state
        theta: this.params.theta,
        use_points: this.params.usePoints,
        entry_multiplier: this.params.entryMultiplier,
        trend: dcState.trend,
        p_ext_h: roundTo(dcState.p_ext_h),
        p_ext_l: roundTo(dcState.p_ext_l),
        p_DCC: dcState.p_DCC ? roundTo(dcState.p_DCC) : null,
        OSV_CUR: roundTo(dcState.OSV_CUR, 6),
        TMV_CUR: roundTo(dcState.TMV_CUR, 6),
        N_DC: dcState.N_DC,
        N_OS: dcState.N_OS,
        RD: roundTo(dcState.RD, 4),
        RN: roundTo(dcState.RN, 4),
        dc_event_count: dcState.eventCount,

        // Trade params
        stop_loss_points: side === 'buy' ? roundTo(entryPrice - stopPrice) : roundTo(stopPrice - entryPrice),
        take_profit_points: this.params.takeProfitPoints,
        use_extremum_stop: this.params.useExtremumStop,
        timeout_candles: this.params.limitOrderTimeout,
        max_hold_bars: this.params.maxHoldBars,

        entry_reason: side === 'buy'
          ? `DC downtrend: price dropped ${this.params.entryMultiplier}x theta from p_ext_h=${roundTo(dcState.p_ext_h)}`
          : `DC uptrend: price rose ${this.params.entryMultiplier}x theta from p_ext_l=${roundTo(dcState.p_ext_l)}`,

        candle_time: new Date(candle.timestamp).toISOString()
      }
    };
  }

  reset() {
    super.reset();
    this.dcEngine.reset();
    this.lastSignaledExtremumLong = null;
    this.lastSignaledExtremumShort = null;
  }

  getName() {
    return 'DC_ST1';
  }

  getDescription() {
    return `DC Scaling Law strategy (theta=${this.params.theta}, mult=${this.params.entryMultiplier}x, ${this.params.usePoints ? 'points' : 'pct'} mode)`;
  }

  getRequiredMarketData() {
    return []; // Pure price-based, no external data needed
  }
}

export default DCSt1Strategy;
