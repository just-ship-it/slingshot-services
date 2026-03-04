/**
 * DC-MSTGAM Strategy — Backtestable / Live Strategy
 *
 * Loads trained weights from a GA optimization JSON file and runs
 * real-time weighted voting across 70 DC sub-strategies.
 *
 * Usage in backtest:
 *   node index.js --ticker NQ --start 2024-10-01 --end 2024-12-31 \
 *     --strategy mstgam --mstgam-weights results.json
 *
 * Usage in live multi-strategy-engine:
 *   new DCMSTGAMStrategy({ weightsFile: 'path/to/weights.json' })
 */

import fs from 'fs';
import { BaseStrategy } from './base-strategy.js';
import { isValidCandle, roundTo } from './strategy-utils.js';
import { DCEngine } from '../dc/dc-engine.js';

// Signal constants
const HOLD = 0;
const BUY  = 1;
const SELL = -1;

// Default thresholds (must match mstgam-optimizer.js)
const DEFAULT_THRESHOLDS_ST1_6 = [
  0.0002, 0.0005, 0.0008, 0.0012, 0.0018,
  0.0025, 0.0035, 0.0050, 0.0075, 0.0100
];

const DEFAULT_THRESHOLDS_ST7_8 = [
  0.0002, 0.0005, 0.0008, 0.0012, 0.0018
];

export class DCMSTGAMStrategy extends BaseStrategy {
  static getDataRequirements() {
    return {
      candles: { baseSymbol: 'NQ', quoteSymbols: ['CME_MINI:NQ1!'] },
      gex: false,
      lt: false,
      tradier: false,
      ivSkew: false
    };
  }

  constructor(params = {}) {
    super(params);

    // Load weights from file or inline
    let weightsData;
    if (params.weightsFile) {
      const raw = fs.readFileSync(params.weightsFile, 'utf8');
      weightsData = JSON.parse(raw);
    } else if (params.weights) {
      weightsData = { bestWeights: params.weights, config: params };
    } else {
      throw new Error('DCMSTGAMStrategy requires weightsFile or weights parameter');
    }

    this.weights = new Float64Array(weightsData.bestWeights);

    // Extract config from weights file (with fallbacks)
    const wConfig = weightsData.config || {};
    const dcParams = wConfig.dcParams || {};
    const tradeParams = wConfig.tradeParams || {};

    this.thresholdsSt1_6 = wConfig.thresholdsSt1_6 || params.thresholdsSt1_6 || DEFAULT_THRESHOLDS_ST1_6;
    this.thresholdsSt7_8 = wConfig.thresholdsSt7_8 || params.thresholdsSt7_8 || DEFAULT_THRESHOLDS_ST7_8;
    this.usePoints = wConfig.usePoints ?? params.usePoints ?? false;
    this.entryMultiplier = dcParams.entryMultiplier ?? params.entryMultiplier ?? 2.0;
    this.durationMultiplier = dcParams.durationMultiplier ?? params.durationMultiplier ?? 2.0;
    this.rdThreshold = dcParams.rdThreshold ?? params.rdThreshold ?? 2.0;
    this.consecutiveCount = dcParams.consecutiveCount ?? params.consecutiveCount ?? 3;

    // Trade params
    this.stopLossPoints = tradeParams.stopLossPoints ?? params.stopLossPoints ?? 15;
    this.takeProfitPoints = tradeParams.takeProfitPoints ?? params.takeProfitPoints ?? 30;
    this.tradingSymbol = params.tradingSymbol || 'NQ1!';
    this.defaultQuantity = params.defaultQuantity || 1;
    this.signalCooldownMs = params.signalCooldownMs ?? 60000;

    // Session filter
    this.useSessionFilter = params.useSessionFilter ?? true;
    this.allowedSessions = wConfig.allowedSessions || params.allowedSessions || ['rth'];

    // Trailing stop
    this.useTrailingStop = params.useTrailingStop ?? false;
    this.trailingTrigger = params.trailingTrigger ?? 10;
    this.trailingOffset = params.trailingOffset ?? 5;

    // Map CLI param names
    if (params.stopBuffer !== undefined && params.stopLossPoints === undefined) {
      this.stopLossPoints = params.stopBuffer;
    }
    if (params.targetPoints !== undefined && params.takeProfitPoints === undefined) {
      this.takeProfitPoints = params.targetPoints;
    }

    // Verify gene count matches threshold configuration
    this.numGenesSt1_6 = this.thresholdsSt1_6.length * 6;
    this.numGenesSt7_8 = this.thresholdsSt7_8.length * 2;
    this.numGenes = this.numGenesSt1_6 + this.numGenesSt7_8;

    if (this.weights.length !== this.numGenes) {
      throw new Error(`Weight count mismatch: got ${this.weights.length}, expected ${this.numGenes} (${this.thresholdsSt1_6.length} St1-6 thresholds + ${this.thresholdsSt7_8.length} St7-8 thresholds)`);
    }

    // Create one DC engine per unique threshold
    const allThresholds = new Set([...this.thresholdsSt1_6, ...this.thresholdsSt7_8]);
    this.engines = new Map();
    for (const theta of allThresholds) {
      this.engines.set(theta, new DCEngine({ theta, usePoints: this.usePoints }));
    }

    // Dedup state per gene
    this.dedup = new Array(this.numGenes).fill(null);
  }

  evaluateSignal(candle, prevCandle, marketData, options = {}) {
    const debug = options.debug || this.params.debug;

    if (!isValidCandle(candle)) return null;

    // Cooldown
    const cooldownMs = options.cooldownMs || this.signalCooldownMs;
    if (!this.checkCooldown(candle.timestamp, cooldownMs)) return null;

    // Session filter
    if (this.useSessionFilter && !this._isAllowedSession(candle.timestamp)) return null;

    const price = candle.close;

    // Feed all DC engines
    const events = new Map();
    for (const [theta, engine] of this.engines) {
      events.set(theta, engine.update(price, candle.timestamp));
    }

    // Evaluate all 70 sub-strategies
    const signals = new Int8Array(this.numGenes);
    this._geneIdx = 0;

    // St1–St6 (10 thresholds each)
    for (let s = 0; s < 6; s++) {
      for (let t = 0; t < this.thresholdsSt1_6.length; t++) {
        const theta = this.thresholdsSt1_6[t];
        const engine = this.engines.get(theta);
        const dcEvent = events.get(theta);
        const state = engine.getState();
        let signal = HOLD;

        if (state.trend) {
          switch (s) {
            case 0: signal = this._evalSt1(engine, state, price, theta); break;
            case 1: signal = this._evalSt2(engine, state); break;
            case 2: signal = this._evalSt3(state); break;
            case 3: signal = this._evalSt4(state); break;
            case 4: signal = this._evalSt5(engine, state); break;
            case 5: signal = this._evalSt6(dcEvent, state); break;
          }
        }

        signals[this._geneIdx] = signal;
        this._geneIdx++;
      }
    }

    // St7–St8 (5 thresholds each)
    for (let s = 0; s < 2; s++) {
      for (let t = 0; t < this.thresholdsSt7_8.length; t++) {
        const theta = this.thresholdsSt7_8[t];
        const engine = this.engines.get(theta);
        const dcEvent = events.get(theta);
        const state = engine.getState();
        let signal = HOLD;

        if (state.trend && dcEvent) {
          if (s === 0) signal = this._evalSt7(engine, dcEvent, state);
          else signal = this._evalSt8(engine, dcEvent, state);
        }

        signals[this._geneIdx] = signal;
        this._geneIdx++;
      }
    }

    // Weighted vote
    let buyWeight = 0, sellWeight = 0, holdWeight = 0, nonHoldCount = 0;
    for (let g = 0; g < this.numGenes; g++) {
      const w = this.weights[g];
      if (signals[g] === BUY) { buyWeight += w; nonHoldCount++; }
      else if (signals[g] === SELL) { sellWeight += w; nonHoldCount++; }
      else { holdWeight += w; }
    }

    let action = HOLD;
    if (nonHoldCount >= 2) {
      if (buyWeight > sellWeight) action = BUY;
      else if (sellWeight > buyWeight) action = SELL;
    } else {
      if (buyWeight > sellWeight && buyWeight > holdWeight) action = BUY;
      else if (sellWeight > buyWeight && sellWeight > holdWeight) action = SELL;
    }

    if (action === HOLD) return null;

    if (debug) {
      console.log(`[MSTGAM] ${action === BUY ? 'BUY' : 'SELL'} signal: buyW=${buyWeight.toFixed(3)}, sellW=${sellWeight.toFixed(3)}, holdW=${holdWeight.toFixed(3)}, nonHold=${nonHoldCount}`);
    }

    this.updateLastSignalTime(candle.timestamp);
    return this._generateSignal(candle, action === BUY ? 'buy' : 'sell', buyWeight, sellWeight);
  }

  // ── Strategy evaluators (same logic as precomputer) ─────────────────────

  _evalSt1(engine, state, price, theta) {
    const threshold = this.entryMultiplier * theta;
    const geneIdx = this._currentGeneIdx();

    if (state.trend === 'downtrend') {
      let triggered = this.usePoints
        ? state.p_ext_h - price >= threshold
        : price <= state.p_ext_h * (1 - threshold);
      if (triggered) {
        const key = `${state.p_ext_h}_${state.t_ext_h}`;
        if (this.dedup[geneIdx] !== key) { this.dedup[geneIdx] = key; return BUY; }
      }
    }

    if (state.trend === 'uptrend') {
      let triggered = this.usePoints
        ? price - state.p_ext_l >= threshold
        : price >= state.p_ext_l * (1 + threshold);
      if (triggered) {
        const key = `${state.p_ext_l}_${state.t_ext_l}`;
        if (this.dedup[geneIdx] !== key) { this.dedup[geneIdx] = key; return SELL; }
      }
    }

    return HOLD;
  }

  _evalSt2(engine, state) {
    const geneIdx = this._currentGeneIdx();
    const currentOSDuration = engine.observationCount - engine.dcStartIdx;
    const lastDCDuration = state.T_DC || 1;
    if (currentOSDuration < this.durationMultiplier * lastDCDuration) return HOLD;

    if (state.trend === 'downtrend') {
      const key = `${state.p_ext_h}_${state.t_ext_h}`;
      if (this.dedup[geneIdx] !== key) { this.dedup[geneIdx] = key; return BUY; }
    }
    if (state.trend === 'uptrend') {
      const key = `${state.p_ext_l}_${state.t_ext_l}`;
      if (this.dedup[geneIdx] !== key) { this.dedup[geneIdx] = key; return SELL; }
    }
    return HOLD;
  }

  _evalSt3(state) {
    const geneIdx = this._currentGeneIdx();
    const currentOSV = Math.abs(state.OSV_CUR);

    if (state.trend === 'downtrend' && state.OSV_best_DT > 0 && currentOSV > state.OSV_best_DT) {
      const key = `${state.p_ext_h}_${state.t_ext_h}`;
      if (this.dedup[geneIdx] !== key) { this.dedup[geneIdx] = key; return BUY; }
    }
    if (state.trend === 'uptrend' && state.OSV_best_UT > 0 && currentOSV > state.OSV_best_UT) {
      const key = `${state.p_ext_l}_${state.t_ext_l}`;
      if (this.dedup[geneIdx] !== key) { this.dedup[geneIdx] = key; return SELL; }
    }
    return HOLD;
  }

  _evalSt4(state) {
    const geneIdx = this._currentGeneIdx();
    const currentTMV = Math.abs(state.TMV_CUR);

    if (state.trend === 'downtrend' && state.TMV_best_DT > 0 && currentTMV > state.TMV_best_DT) {
      const key = `${state.p_ext_h}_${state.t_ext_h}`;
      if (this.dedup[geneIdx] !== key) { this.dedup[geneIdx] = key; return BUY; }
    }
    if (state.trend === 'uptrend' && state.TMV_best_UT > 0 && currentTMV > state.TMV_best_UT) {
      const key = `${state.p_ext_l}_${state.t_ext_l}`;
      if (this.dedup[geneIdx] !== key) { this.dedup[geneIdx] = key; return SELL; }
    }
    return HOLD;
  }

  _evalSt5(engine, state) {
    const geneIdx = this._currentGeneIdx();
    const currentOSDuration = engine.observationCount - engine.dcStartIdx;
    const lastDCDuration = state.T_DC || 1;
    const currentRD = currentOSDuration / lastDCDuration;
    if (currentRD < this.rdThreshold) return HOLD;

    if (state.trend === 'downtrend') {
      const key = `${state.p_ext_h}_${state.t_ext_h}`;
      if (this.dedup[geneIdx] !== key) { this.dedup[geneIdx] = key; return BUY; }
    }
    if (state.trend === 'uptrend') {
      const key = `${state.p_ext_l}_${state.t_ext_l}`;
      if (this.dedup[geneIdx] !== key) { this.dedup[geneIdx] = key; return SELL; }
    }
    return HOLD;
  }

  _evalSt6(dcEvent, state) {
    if (!dcEvent) return HOLD;
    const geneIdx = this._currentGeneIdx();

    // In live/backtest mode, use Math.random (not seeded — only GA precompute is seeded)
    const RN = state.RN;
    if (Math.random() < RN) return HOLD;

    if (dcEvent.type === 'upturn') {
      const key = `upturn_${state.eventCount}`;
      if (this.dedup[geneIdx] !== key) { this.dedup[geneIdx] = key; return BUY; }
    }
    if (dcEvent.type === 'downturn') {
      const key = `downturn_${state.eventCount}`;
      if (this.dedup[geneIdx] !== key) { this.dedup[geneIdx] = key; return SELL; }
    }
    return HOLD;
  }

  _evalSt7(engine, dcEvent, state) {
    const geneIdx = this._currentGeneIdx();
    const count = this.consecutiveCount;
    const events = engine.getRecentOSPattern(count * 2);
    if (events.length < count * 2) return HOLD;

    const patternKey = `pat_${state.eventCount}`;
    if (this.dedup[geneIdx] === patternKey) return HOLD;

    const recent = events.slice(-count * 2);

    if (dcEvent.type === 'upturn') {
      let valid = true;
      for (let i = 0; i < recent.length; i++) {
        const idx = recent.length - 1 - i;
        const expected = i % 2 === 0 ? 'upturn' : 'downturn';
        if (recent[idx].type !== expected) { valid = false; break; }
        if (recent[idx].osv !== undefined && Math.abs(recent[idx].osv) <= 0) { valid = false; break; }
      }
      if (valid) { this.dedup[geneIdx] = patternKey; return BUY; }
    }

    if (dcEvent.type === 'downturn') {
      let valid = true;
      for (let i = 0; i < recent.length; i++) {
        const idx = recent.length - 1 - i;
        const expected = i % 2 === 0 ? 'downturn' : 'upturn';
        if (recent[idx].type !== expected) { valid = false; break; }
        if (recent[idx].osv !== undefined && Math.abs(recent[idx].osv) <= 0) { valid = false; break; }
      }
      if (valid) { this.dedup[geneIdx] = patternKey; return SELL; }
    }

    return HOLD;
  }

  _evalSt8(engine, dcEvent, state) {
    const geneIdx = this._currentGeneIdx();
    const count = this.consecutiveCount;
    const events = engine.getRecentOSPattern(count * 2);
    if (events.length < count * 2) return HOLD;

    const patternKey = `pat_${state.eventCount}`;
    if (this.dedup[geneIdx] === patternKey) return HOLD;

    const recent = events.slice(-count * 2);

    if (dcEvent.type === 'downturn') {
      let valid = true;
      for (let i = 0; i < recent.length; i++) {
        const idx = recent.length - 1 - i;
        const expected = i % 2 === 0 ? 'downturn' : 'upturn';
        if (recent[idx].type !== expected) { valid = false; break; }
        if (recent[idx].osv !== undefined && Math.abs(recent[idx].osv) <= 0) { valid = false; break; }
      }
      if (valid) { this.dedup[geneIdx] = patternKey; return BUY; }
    }

    if (dcEvent.type === 'upturn') {
      let valid = true;
      for (let i = 0; i < recent.length; i++) {
        const idx = recent.length - 1 - i;
        const expected = i % 2 === 0 ? 'upturn' : 'downturn';
        if (recent[idx].type !== expected) { valid = false; break; }
        if (recent[idx].osv !== undefined && Math.abs(recent[idx].osv) <= 0) { valid = false; break; }
      }
      if (valid) { this.dedup[geneIdx] = patternKey; return SELL; }
    }

    return HOLD;
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  /**
   * Track current gene index during evaluateSignal iteration.
   * This is set by the calling loop in evaluateSignal.
   */
  _currentGeneIdx() {
    return this._geneIdx;
  }

  _generateSignal(candle, side, buyWeight, sellWeight) {
    const entryPrice = candle.close;
    let stopPrice, targetPrice;

    if (side === 'buy') {
      stopPrice = entryPrice - this.stopLossPoints;
      targetPrice = entryPrice + this.takeProfitPoints;
    } else {
      stopPrice = entryPrice + this.stopLossPoints;
      targetPrice = entryPrice - this.takeProfitPoints;
    }

    return {
      strategy: 'DC_MSTGAM',
      side,
      action: 'place_limit',
      symbol: this.tradingSymbol,
      price: roundTo(entryPrice),
      stop_loss: roundTo(stopPrice),
      take_profit: roundTo(targetPrice),
      quantity: this.defaultQuantity,
      timestamp: new Date(candle.timestamp).toISOString(),
      trailing_trigger: this.useTrailingStop ? this.trailingTrigger : null,
      trailing_offset: this.useTrailingStop ? this.trailingOffset : null,
      metadata: {
        buy_weight: roundTo(buyWeight, 4),
        sell_weight: roundTo(sellWeight, 4),
        stop_loss_points: this.stopLossPoints,
        take_profit_points: this.takeProfitPoints,
        candle_time: new Date(candle.timestamp).toISOString()
      }
    };
  }

  _isAllowedSession(timestamp) {
    if (!this.allowedSessions) return true;
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

    let session;
    if (timeDecimal >= 18 || timeDecimal < 4) session = 'overnight';
    else if (timeDecimal >= 4 && timeDecimal < 9.5) session = 'premarket';
    else if (timeDecimal >= 9.5 && timeDecimal < 16) session = 'rth';
    else session = 'afterhours';

    return this.allowedSessions.includes(session);
  }

  reset() {
    super.reset();
    for (const engine of this.engines.values()) {
      engine.reset();
    }
    this.dedup.fill(null);
  }

  getName() {
    return 'DC_MSTGAM';
  }

  getDescription() {
    return `DC MSTGAM: ${this.numGenes} weighted sub-strategies (${this.usePoints ? 'points' : 'pct'} mode)`;
  }

  getRequiredMarketData() {
    return [];
  }
}

export default DCMSTGAMStrategy;
