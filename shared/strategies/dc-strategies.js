/**
 * DC Strategies St2-St8
 *
 * All 8 strategies from "A genetic algorithm for the optimization of
 * multi-threshold trading strategies in the directional changes paradigm"
 * (Salman et al., 2025).
 *
 * Each strategy uses the same DCEngine but differs in entry condition:
 * - St2: OS duration exceeds 2x DC duration
 * - St3: Current overshoot exceeds best historical overshoot
 * - St4: Current total move exceeds best historical total move
 * - St5: Duration ratio (T_OS/T_DC) exceeds threshold
 * - St6: Probabilistic entry at DC confirmation points using event count ratio
 * - St7: 3 consecutive overshoots in alternating UT-DT pattern (buy signal)
 * - St8: 3 consecutive overshoots in alternating DT-UT pattern (sell signal)
 */

import { BaseStrategy } from './base-strategy.js';
import { isValidCandle, roundTo } from './strategy-utils.js';
import { DCEngine } from '../dc/dc-engine.js';

// ─── Shared base class for all DC strategies ───────────────────────────────

class DCBaseStrategy extends BaseStrategy {
  static getDataRequirements() {
    return {
      candles: { baseSymbol: 'NQ', quoteSymbols: ['CME_MINI:NQ1!'] },
      gex: false,
      lt: false,
      tradier: false,
      ivSkew: false
    };
  }

  constructor(params = {}, strategyName = 'DC_BASE') {
    super(params);
    this.strategyName = strategyName;

    this.defaultParams = {
      theta: 0.001,
      usePoints: false,
      stopLossPoints: 15,
      takeProfitPoints: 30,
      useExtremumStop: false,
      extremumStopBuffer: 5,
      useTrailingStop: false,
      trailingTrigger: 10,
      trailingOffset: 5,
      signalCooldownMs: 60000,
      allowLongs: true,
      allowShorts: true,
      tradingSymbol: 'NQ1!',
      defaultQuantity: 1,
      useSessionFilter: true,
      allowedSessions: ['rth'],
      maxHoldBars: 0,
      limitOrderTimeout: 3,
    };

    this.params = { ...this.defaultParams, ...params };

    if (params.stopBuffer !== undefined && params.stopLossPoints === undefined) {
      this.params.stopLossPoints = params.stopBuffer;
    }
    if (params.targetPoints !== undefined && params.takeProfitPoints === undefined) {
      this.params.takeProfitPoints = params.targetPoints;
    }

    this.dcEngine = new DCEngine({
      theta: this.params.theta,
      usePoints: this.params.usePoints
    });

    this.lastSignaledExtremumLong = null;
    this.lastSignaledExtremumShort = null;
  }

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

  isAllowedSession(timestamp) {
    if (!this.params.useSessionFilter) return true;
    return this.params.allowedSessions.includes(this.getSession(timestamp));
  }

  /**
   * Common pre-checks: candle validity, cooldown, session filter.
   * Also feeds the DC engine. Returns { price, dcEvent, state } or null if blocked.
   */
  preCheck(candle, options = {}) {
    const debug = options.debug || this.params.debug;

    if (!isValidCandle(candle)) {
      if (debug) console.log(`[${this.strategyName}] Invalid candle`);
      return null;
    }

    const cooldownMs = options.cooldownMs || this.params.signalCooldownMs;
    if (!this.checkCooldown(candle.timestamp, cooldownMs)) {
      return null;
    }

    if (!this.isAllowedSession(candle.timestamp)) {
      return null;
    }

    const price = candle.close;
    const dcEvent = this.dcEngine.update(price, candle.timestamp);
    const state = this.dcEngine.getState();

    if (!state.trend) return null;

    return { price, dcEvent, state, debug };
  }

  /**
   * Deduplication check for long signal.
   * Returns true if this is a NEW signal (not a duplicate).
   */
  checkLongDedup(state) {
    const key = `${state.p_ext_h}_${state.t_ext_h}`;
    if (this.lastSignaledExtremumLong === key) return false;
    this.lastSignaledExtremumLong = key;
    return true;
  }

  /**
   * Deduplication check for short signal.
   */
  checkShortDedup(state) {
    const key = `${state.p_ext_l}_${state.t_ext_l}`;
    if (this.lastSignaledExtremumShort === key) return false;
    this.lastSignaledExtremumShort = key;
    return true;
  }

  generateSignal(candle, side, state, entryReason) {
    const entryPrice = candle.close;
    let stopPrice, targetPrice;

    if (side === 'buy') {
      stopPrice = this.params.useExtremumStop
        ? state.p_ext_l - this.params.extremumStopBuffer
        : entryPrice - this.params.stopLossPoints;
      targetPrice = entryPrice + this.params.takeProfitPoints;
    } else {
      stopPrice = this.params.useExtremumStop
        ? state.p_ext_h + this.params.extremumStopBuffer
        : entryPrice + this.params.stopLossPoints;
      targetPrice = entryPrice - this.params.takeProfitPoints;
    }

    return {
      strategy: this.strategyName,
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
        theta: this.params.theta,
        use_points: this.params.usePoints,
        trend: state.trend,
        p_ext_h: roundTo(state.p_ext_h),
        p_ext_l: roundTo(state.p_ext_l),
        p_DCC: state.p_DCC ? roundTo(state.p_DCC) : null,
        OSV_CUR: roundTo(state.OSV_CUR, 6),
        TMV_CUR: roundTo(state.TMV_CUR, 6),
        N_DC: state.N_DC,
        RD: roundTo(state.RD, 4),
        RN: roundTo(state.RN, 4),
        dc_event_count: state.eventCount,
        stop_loss_points: side === 'buy' ? roundTo(entryPrice - stopPrice) : roundTo(stopPrice - entryPrice),
        take_profit_points: this.params.takeProfitPoints,
        timeout_candles: this.params.limitOrderTimeout,
        max_hold_bars: this.params.maxHoldBars,
        entry_reason: entryReason,
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

  getName() { return this.strategyName; }
  getRequiredMarketData() { return []; }
}

// ─── St2: OS Duration > 2x DC Duration ────────────────────────────────────

export class DCSt2Strategy extends DCBaseStrategy {
  constructor(params = {}) {
    super(params, 'DC_ST2');
    // St2-specific: duration multiplier threshold
    this.params.durationMultiplier = params.durationMultiplier ?? 2.0;
  }

  evaluateSignal(candle, prevCandle, marketData, options = {}) {
    const check = this.preCheck(candle, options);
    if (!check) return null;
    const { price, state, debug } = check;

    // St2: Enter when OS duration exceeds durationMultiplier * DC duration
    // The current OS duration is measured from dcStartIdx
    const currentOSDuration = this.dcEngine.observationCount - this.dcEngine.dcStartIdx;
    const lastDCDuration = state.T_DC || 1;

    if (currentOSDuration < this.params.durationMultiplier * lastDCDuration) {
      return null;
    }

    // Long: during downtrend (OS going down has lasted long enough)
    if (this.params.allowLongs && state.trend === 'downtrend') {
      if (this.checkLongDedup(state)) {
        this.updateLastSignalTime(candle.timestamp);
        if (debug) console.log(`[DC_ST2] LONG: OS_dur=${currentOSDuration} > ${this.params.durationMultiplier}x DC_dur=${lastDCDuration}`);
        return this.generateSignal(candle, 'buy', state,
          `OS duration (${currentOSDuration}) > ${this.params.durationMultiplier}x DC duration (${lastDCDuration})`);
      }
    }

    // Short: during uptrend
    if (this.params.allowShorts && state.trend === 'uptrend') {
      if (this.checkShortDedup(state)) {
        this.updateLastSignalTime(candle.timestamp);
        if (debug) console.log(`[DC_ST2] SHORT: OS_dur=${currentOSDuration} > ${this.params.durationMultiplier}x DC_dur=${lastDCDuration}`);
        return this.generateSignal(candle, 'sell', state,
          `OS duration (${currentOSDuration}) > ${this.params.durationMultiplier}x DC duration (${lastDCDuration})`);
      }
    }

    return null;
  }

  getDescription() {
    return `DC St2: OS duration > ${this.params.durationMultiplier}x DC duration (theta=${this.params.theta})`;
  }
}

// ─── St3: Current Overshoot > Best Historical Overshoot ────────────────────

export class DCSt3Strategy extends DCBaseStrategy {
  constructor(params = {}) {
    super(params, 'DC_ST3');
  }

  evaluateSignal(candle, prevCandle, marketData, options = {}) {
    const check = this.preCheck(candle, options);
    if (!check) return null;
    const { price, state, debug } = check;

    const currentOSV = Math.abs(state.OSV_CUR);

    // Long: downtrend, current OS exceeds best downtrend OS
    if (this.params.allowLongs && state.trend === 'downtrend') {
      if (state.OSV_best_DT > 0 && currentOSV > state.OSV_best_DT) {
        if (this.checkLongDedup(state)) {
          this.updateLastSignalTime(candle.timestamp);
          if (debug) console.log(`[DC_ST3] LONG: |OSV|=${currentOSV.toFixed(6)} > best_DT=${state.OSV_best_DT.toFixed(6)}`);
          return this.generateSignal(candle, 'buy', state,
            `|OSV|=${roundTo(currentOSV, 6)} > OSV_best_DT=${roundTo(state.OSV_best_DT, 6)}`);
        }
      }
    }

    // Short: uptrend, current OS exceeds best uptrend OS
    if (this.params.allowShorts && state.trend === 'uptrend') {
      if (state.OSV_best_UT > 0 && currentOSV > state.OSV_best_UT) {
        if (this.checkShortDedup(state)) {
          this.updateLastSignalTime(candle.timestamp);
          if (debug) console.log(`[DC_ST3] SHORT: |OSV|=${currentOSV.toFixed(6)} > best_UT=${state.OSV_best_UT.toFixed(6)}`);
          return this.generateSignal(candle, 'sell', state,
            `|OSV|=${roundTo(currentOSV, 6)} > OSV_best_UT=${roundTo(state.OSV_best_UT, 6)}`);
        }
      }
    }

    return null;
  }

  getDescription() {
    return `DC St3: Current overshoot > best historical overshoot (theta=${this.params.theta})`;
  }
}

// ─── St4: Current Total Move > Best Historical Total Move ──────────────────

export class DCSt4Strategy extends DCBaseStrategy {
  constructor(params = {}) {
    super(params, 'DC_ST4');
  }

  evaluateSignal(candle, prevCandle, marketData, options = {}) {
    const check = this.preCheck(candle, options);
    if (!check) return null;
    const { price, state, debug } = check;

    const currentTMV = Math.abs(state.TMV_CUR);

    // Long: downtrend, total move exceeds best downtrend TMV
    if (this.params.allowLongs && state.trend === 'downtrend') {
      if (state.TMV_best_DT > 0 && currentTMV > state.TMV_best_DT) {
        if (this.checkLongDedup(state)) {
          this.updateLastSignalTime(candle.timestamp);
          if (debug) console.log(`[DC_ST4] LONG: |TMV|=${currentTMV.toFixed(6)} > best_DT=${state.TMV_best_DT.toFixed(6)}`);
          return this.generateSignal(candle, 'buy', state,
            `|TMV|=${roundTo(currentTMV, 6)} > TMV_best_DT=${roundTo(state.TMV_best_DT, 6)}`);
        }
      }
    }

    // Short: uptrend, total move exceeds best uptrend TMV
    if (this.params.allowShorts && state.trend === 'uptrend') {
      if (state.TMV_best_UT > 0 && currentTMV > state.TMV_best_UT) {
        if (this.checkShortDedup(state)) {
          this.updateLastSignalTime(candle.timestamp);
          if (debug) console.log(`[DC_ST4] SHORT: |TMV|=${currentTMV.toFixed(6)} > best_UT=${state.TMV_best_UT.toFixed(6)}`);
          return this.generateSignal(candle, 'sell', state,
            `|TMV|=${roundTo(currentTMV, 6)} > TMV_best_UT=${roundTo(state.TMV_best_UT, 6)}`);
        }
      }
    }

    return null;
  }

  getDescription() {
    return `DC St4: Current total move > best historical total move (theta=${this.params.theta})`;
  }
}

// ─── St5: Duration Ratio RD >= Threshold ───────────────────────────────────

export class DCSt5Strategy extends DCBaseStrategy {
  constructor(params = {}) {
    super(params, 'DC_ST5');
    // St5-specific: RD threshold
    this.params.rdThreshold = params.rdThreshold ?? 2.0;
  }

  evaluateSignal(candle, prevCandle, marketData, options = {}) {
    const check = this.preCheck(candle, options);
    if (!check) return null;
    const { price, state, debug } = check;

    // Current OS/DC duration ratio
    const currentOSDuration = this.dcEngine.observationCount - this.dcEngine.dcStartIdx;
    const lastDCDuration = state.T_DC || 1;
    const currentRD = currentOSDuration / lastDCDuration;

    if (currentRD < this.params.rdThreshold) {
      return null;
    }

    // Long: downtrend, duration ratio exceeded
    if (this.params.allowLongs && state.trend === 'downtrend') {
      if (this.checkLongDedup(state)) {
        this.updateLastSignalTime(candle.timestamp);
        if (debug) console.log(`[DC_ST5] LONG: RD=${currentRD.toFixed(2)} >= threshold=${this.params.rdThreshold}`);
        return this.generateSignal(candle, 'buy', state,
          `RD (T_OS/T_DC) = ${roundTo(currentRD, 2)} >= ${this.params.rdThreshold}`);
      }
    }

    // Short: uptrend
    if (this.params.allowShorts && state.trend === 'uptrend') {
      if (this.checkShortDedup(state)) {
        this.updateLastSignalTime(candle.timestamp);
        if (debug) console.log(`[DC_ST5] SHORT: RD=${currentRD.toFixed(2)} >= threshold=${this.params.rdThreshold}`);
        return this.generateSignal(candle, 'sell', state,
          `RD (T_OS/T_DC) = ${roundTo(currentRD, 2)} >= ${this.params.rdThreshold}`);
      }
    }

    return null;
  }

  getDescription() {
    return `DC St5: Duration ratio >= ${this.params.rdThreshold} (theta=${this.params.theta})`;
  }
}

// ─── St6: Probabilistic Entry at DC Confirmation Points ────────────────────

export class DCSt6Strategy extends DCBaseStrategy {
  constructor(params = {}) {
    super(params, 'DC_ST6');
  }

  evaluateSignal(candle, prevCandle, marketData, options = {}) {
    const check = this.preCheck(candle, options);
    if (!check) return null;
    const { price, dcEvent, state, debug } = check;

    // St6 only acts at DC confirmation points (when a DC event fires)
    if (!dcEvent) return null;

    // The paper uses: if random() >= RN, then trade
    // RN = N_OS / N_DC. When RN is low, probability of trading is high.
    // This means: trade more aggressively when overshoots are rare relative to DCs.
    const RN = state.RN;
    const roll = Math.random();

    if (roll < RN) {
      if (debug) console.log(`[DC_ST6] Skipped: roll=${roll.toFixed(3)} < RN=${RN.toFixed(3)}`);
      return null;
    }

    // At upturn confirmation -> buy (reversal from downtrend)
    if (dcEvent.type === 'upturn' && this.params.allowLongs) {
      if (this.checkLongDedup(state)) {
        this.updateLastSignalTime(candle.timestamp);
        if (debug) console.log(`[DC_ST6] LONG at upturn: roll=${roll.toFixed(3)} >= RN=${RN.toFixed(3)}`);
        return this.generateSignal(candle, 'buy', state,
          `Upturn DCC, roll=${roundTo(roll, 3)} >= RN=${roundTo(RN, 3)}`);
      }
    }

    // At downturn confirmation -> sell (reversal from uptrend)
    if (dcEvent.type === 'downturn' && this.params.allowShorts) {
      if (this.checkShortDedup(state)) {
        this.updateLastSignalTime(candle.timestamp);
        if (debug) console.log(`[DC_ST6] SHORT at downturn: roll=${roll.toFixed(3)} >= RN=${RN.toFixed(3)}`);
        return this.generateSignal(candle, 'sell', state,
          `Downturn DCC, roll=${roundTo(roll, 3)} >= RN=${roundTo(RN, 3)}`);
      }
    }

    return null;
  }

  getDescription() {
    return `DC St6: Probabilistic entry at DC confirmation (RN-based, theta=${this.params.theta})`;
  }
}

// ─── St7: 3 Consecutive Overshoots in UT-DT-UT-DT-UT Pattern ──────────────

export class DCSt7Strategy extends DCBaseStrategy {
  constructor(params = {}) {
    super(params, 'DC_ST7');
    this.params.consecutiveCount = params.consecutiveCount ?? 3;
    this.lastPatternSignalIdx = -1;
  }

  evaluateSignal(candle, prevCandle, marketData, options = {}) {
    const check = this.preCheck(candle, options);
    if (!check) return null;
    const { price, dcEvent, state, debug } = check;

    // Only check pattern when a new DC event fires
    if (!dcEvent) return null;

    const count = this.params.consecutiveCount;
    const events = this.dcEngine.getRecentOSPattern(count * 2);

    // Need at least count*2 events to check the alternating pattern
    if (events.length < count * 2) return null;

    // Don't re-signal the same pattern
    if (this.lastPatternSignalIdx === state.eventCount) return null;

    // St7 buy pattern: alternating UT-DT ending in UT (upturn)
    // Check last count*2 events alternate: upturn, downturn, upturn, downturn, upturn...
    // and each had an overshoot (osv > 0)
    const recentEvents = events.slice(-count * 2);

    // Buy pattern: ends with upturn, preceded by alternating DT-UT
    if (dcEvent.type === 'upturn' && this.params.allowLongs) {
      let patternValid = true;
      for (let i = 0; i < recentEvents.length; i++) {
        const expectedType = i % 2 === 0 ? 'upturn' : 'downturn';
        // Reverse: the pattern ends with upturn, so work backward
        const idx = recentEvents.length - 1 - i;
        const expectedTypeRev = i % 2 === 0 ? 'upturn' : 'downturn';
        if (recentEvents[idx].type !== expectedTypeRev) {
          patternValid = false;
          break;
        }
        // Check that each event had meaningful overshoot
        if (recentEvents[idx].osv !== undefined && Math.abs(recentEvents[idx].osv) <= 0) {
          patternValid = false;
          break;
        }
      }

      if (patternValid && this.checkLongDedup(state)) {
        this.lastPatternSignalIdx = state.eventCount;
        this.updateLastSignalTime(candle.timestamp);
        if (debug) console.log(`[DC_ST7] LONG: ${count} consecutive alternating OS events ending in upturn`);
        return this.generateSignal(candle, 'buy', state,
          `${count} consecutive alternating OS (UT-DT pattern ending in upturn)`);
      }
    }

    // Sell pattern: ends with downturn
    if (dcEvent.type === 'downturn' && this.params.allowShorts) {
      let patternValid = true;
      for (let i = 0; i < recentEvents.length; i++) {
        const idx = recentEvents.length - 1 - i;
        const expectedType = i % 2 === 0 ? 'downturn' : 'upturn';
        if (recentEvents[idx].type !== expectedType) {
          patternValid = false;
          break;
        }
        if (recentEvents[idx].osv !== undefined && Math.abs(recentEvents[idx].osv) <= 0) {
          patternValid = false;
          break;
        }
      }

      if (patternValid && this.checkShortDedup(state)) {
        this.lastPatternSignalIdx = state.eventCount;
        this.updateLastSignalTime(candle.timestamp);
        if (debug) console.log(`[DC_ST7] SHORT: ${count} consecutive alternating OS events ending in downturn`);
        return this.generateSignal(candle, 'sell', state,
          `${count} consecutive alternating OS (DT-UT pattern ending in downturn)`);
      }
    }

    return null;
  }

  reset() {
    super.reset();
    this.lastPatternSignalIdx = -1;
  }

  getDescription() {
    return `DC St7: ${this.params.consecutiveCount} consecutive alternating overshoots (theta=${this.params.theta})`;
  }
}

// ─── St8: 3 Consecutive Overshoots in DT-UT-DT-UT-DT Pattern ──────────────
// St8 is the mirror of St7: enters in the continuation direction

export class DCSt8Strategy extends DCBaseStrategy {
  constructor(params = {}) {
    super(params, 'DC_ST8');
    this.params.consecutiveCount = params.consecutiveCount ?? 3;
    this.lastPatternSignalIdx = -1;
  }

  evaluateSignal(candle, prevCandle, marketData, options = {}) {
    const check = this.preCheck(candle, options);
    if (!check) return null;
    const { price, dcEvent, state, debug } = check;

    if (!dcEvent) return null;

    const count = this.params.consecutiveCount;
    const events = this.dcEngine.getRecentOSPattern(count * 2);

    if (events.length < count * 2) return null;
    if (this.lastPatternSignalIdx === state.eventCount) return null;

    const recentEvents = events.slice(-count * 2);

    // St8 buy: DT-UT pattern ending in downturn (contrarian - buy after extended selling)
    // The paper describes St8 as entering after 3 consecutive OS in the DT-UT-DT pattern
    if (dcEvent.type === 'downturn' && this.params.allowLongs) {
      let patternValid = true;
      for (let i = 0; i < recentEvents.length; i++) {
        const idx = recentEvents.length - 1 - i;
        const expectedType = i % 2 === 0 ? 'downturn' : 'upturn';
        if (recentEvents[idx].type !== expectedType) {
          patternValid = false;
          break;
        }
        if (recentEvents[idx].osv !== undefined && Math.abs(recentEvents[idx].osv) <= 0) {
          patternValid = false;
          break;
        }
      }

      if (patternValid && this.checkLongDedup(state)) {
        this.lastPatternSignalIdx = state.eventCount;
        this.updateLastSignalTime(candle.timestamp);
        if (debug) console.log(`[DC_ST8] LONG: ${count} consecutive OS in DT-UT pattern ending in downturn (contrarian buy)`);
        return this.generateSignal(candle, 'buy', state,
          `${count} consecutive OS (DT-UT pattern ending in downturn, contrarian buy)`);
      }
    }

    // St8 sell: UT-DT pattern ending in upturn (contrarian - sell after extended buying)
    if (dcEvent.type === 'upturn' && this.params.allowShorts) {
      let patternValid = true;
      for (let i = 0; i < recentEvents.length; i++) {
        const idx = recentEvents.length - 1 - i;
        const expectedType = i % 2 === 0 ? 'upturn' : 'downturn';
        if (recentEvents[idx].type !== expectedType) {
          patternValid = false;
          break;
        }
        if (recentEvents[idx].osv !== undefined && Math.abs(recentEvents[idx].osv) <= 0) {
          patternValid = false;
          break;
        }
      }

      if (patternValid && this.checkShortDedup(state)) {
        this.lastPatternSignalIdx = state.eventCount;
        this.updateLastSignalTime(candle.timestamp);
        if (debug) console.log(`[DC_ST8] SHORT: ${count} consecutive OS in UT-DT pattern ending in upturn (contrarian sell)`);
        return this.generateSignal(candle, 'sell', state,
          `${count} consecutive OS (UT-DT pattern ending in upturn, contrarian sell)`);
      }
    }

    return null;
  }

  reset() {
    super.reset();
    this.lastPatternSignalIdx = -1;
  }

  getDescription() {
    return `DC St8: ${this.params.consecutiveCount} consecutive alternating overshoots - contrarian (theta=${this.params.theta})`;
  }
}
