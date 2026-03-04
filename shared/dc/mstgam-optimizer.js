/**
 * MSTGAM — Multi-Strategy/Threshold Genetic Algorithm Model
 *
 * Based on "A genetic algorithm for the optimization of multi-threshold trading
 * strategies in the directional changes paradigm" (Salman et al., 2025).
 *
 * Optimizes 70 weights for combining 8 DC sub-strategies across multiple thresholds.
 * Gene layout:
 *   genes 0–59:  St1–St6 × 10 thresholds
 *   genes 60–69: St7–St8 × 5 thresholds
 *
 * At each candle, sub-strategies vote Buy/Sell/Hold. Weighted votes determine
 * the aggregate action. Fitness = Sharpe Ratio.
 */

import { DCEngine } from './dc-engine.js';

// ─── Seeded PRNG (Mulberry32) ─────────────────────────────────────────────

function mulberry32(seed) {
  let s = seed | 0;
  return function () {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Signal constants ─────────────────────────────────────────────────────

const HOLD = 0;
const BUY  = 1;
const SELL = -1;

// ─── Default thresholds ───────────────────────────────────────────────────

const DEFAULT_THRESHOLDS_ST1_6 = [
  0.0002, 0.0005, 0.0008, 0.0012, 0.0018,
  0.0025, 0.0035, 0.0050, 0.0075, 0.0100
];

const DEFAULT_THRESHOLDS_ST7_8 = [
  0.0002, 0.0005, 0.0008, 0.0012, 0.0018
];

// ─── Chromosome ───────────────────────────────────────────────────────────

export class Chromosome {
  /**
   * @param {number} numGenes - Number of genes (weights)
   * @param {Function} [rng] - Random number generator
   */
  constructor(numGenes, rng) {
    this.genes = new Float64Array(numGenes);
    this.fitness = -Infinity;
    this.metrics = null;

    if (rng) {
      for (let i = 0; i < numGenes; i++) {
        this.genes[i] = rng();
      }
    }
  }

  clone() {
    const c = new Chromosome(this.genes.length);
    c.genes.set(this.genes);
    c.fitness = this.fitness;
    c.metrics = this.metrics;
    return c;
  }
}

// ─── Signal Precomputer ───────────────────────────────────────────────────

/**
 * Pre-computes Buy/Sell/Hold for all 70 sub-strategies across all candles
 * in a single forward pass. Sub-strategy recommendations are independent
 * of weights so we compute them once and reuse for all chromosome evaluations.
 */
export class SignalPrecomputer {
  /**
   * @param {Object} options
   * @param {number[]} [options.thresholdsSt1_6] - Thresholds for St1–St6 (10)
   * @param {number[]} [options.thresholdsSt7_8] - Thresholds for St7–St8 (5)
   * @param {boolean} [options.usePoints=false] - Points vs percentage mode
   * @param {number} [options.entryMultiplier=2.0] - St1 entry multiplier
   * @param {number} [options.durationMultiplier=2.0] - St2 duration multiplier
   * @param {number} [options.rdThreshold=2.0] - St5 RD threshold
   * @param {number} [options.consecutiveCount=3] - St7/St8 pattern count
   * @param {number} [options.seed=42] - PRNG seed for St6
   * @param {string[]} [options.allowedSessions] - Session filter (null = no filter)
   */
  constructor(options = {}) {
    this.thresholdsSt1_6 = options.thresholdsSt1_6 || DEFAULT_THRESHOLDS_ST1_6;
    this.thresholdsSt7_8 = options.thresholdsSt7_8 || DEFAULT_THRESHOLDS_ST7_8;
    this.usePoints = options.usePoints || false;
    this.entryMultiplier = options.entryMultiplier ?? 2.0;
    this.durationMultiplier = options.durationMultiplier ?? 2.0;
    this.rdThreshold = options.rdThreshold ?? 2.0;
    this.consecutiveCount = options.consecutiveCount ?? 3;
    this.seed = options.seed ?? 42;
    this.allowedSessions = options.allowedSessions || null;

    this.numGenesSt1_6 = this.thresholdsSt1_6.length * 6;
    this.numGenesSt7_8 = this.thresholdsSt7_8.length * 2;
    this.numGenes = this.numGenesSt1_6 + this.numGenesSt7_8;
  }

  /**
   * Build gene labels for output
   * @returns {string[]}
   */
  getGeneLabels() {
    const labels = [];
    const stratNames = ['St1', 'St2', 'St3', 'St4', 'St5', 'St6'];
    for (const name of stratNames) {
      for (const theta of this.thresholdsSt1_6) {
        const pct = (theta * 100).toFixed(2);
        labels.push(`${name}_θ=${pct}%`);
      }
    }
    for (const name of ['St7', 'St8']) {
      for (const theta of this.thresholdsSt7_8) {
        const pct = (theta * 100).toFixed(2);
        labels.push(`${name}_θ=${pct}%`);
      }
    }
    return labels;
  }

  /**
   * Pre-compute signal matrix for all candles
   * @param {Object[]} candles - Array of { timestamp, open, high, low, close, volume }
   * @returns {{ matrix: Int8Array, stats: Object }}
   */
  compute(candles) {
    const numCandles = candles.length;
    const numGenes = this.numGenes;
    const matrix = new Int8Array(numCandles * numGenes);

    // Collect all unique thresholds and create one DCEngine per threshold
    const allThresholds = new Set([...this.thresholdsSt1_6, ...this.thresholdsSt7_8]);
    const engines = new Map();
    for (const theta of allThresholds) {
      engines.set(theta, new DCEngine({ theta, usePoints: this.usePoints }));
    }

    // Per-strategy dedup state: one-shot triggers, keyed by (strategy, threshold)
    // St1: last extremum key that triggered. St2-St5: last extremum key. St6: DC event based. St7/8: pattern index.
    const dedup = this._initDedup();

    // Seeded PRNG for St6
    const rng = mulberry32(this.seed);

    // Signal stats
    const stats = {};
    const labels = this.getGeneLabels();
    for (const label of labels) {
      stats[label] = { buy: 0, sell: 0, hold: 0 };
    }

    // Forward pass through all candles
    for (let i = 0; i < numCandles; i++) {
      const candle = candles[i];
      const price = candle.close;
      const baseIdx = i * numGenes;

      // Session filter
      if (this.allowedSessions && !this._isAllowedSession(candle.timestamp)) {
        // All Hold — matrix is already zero-initialized
        for (let g = 0; g < numGenes; g++) {
          stats[labels[g]].hold++;
        }
        // Still need to feed engines to keep state consistent
        for (const engine of engines.values()) {
          engine.update(price, candle.timestamp);
        }
        continue;
      }

      // Feed all engines and collect events
      const events = new Map();
      for (const [theta, engine] of engines) {
        events.set(theta, engine.update(price, candle.timestamp));
      }

      // ── St1–St6 (10 thresholds each) ──
      let geneIdx = 0;
      for (let s = 0; s < 6; s++) {
        for (let t = 0; t < this.thresholdsSt1_6.length; t++) {
          const theta = this.thresholdsSt1_6[t];
          const engine = engines.get(theta);
          const dcEvent = events.get(theta);
          const state = engine.getState();
          let signal = HOLD;

          if (state.trend) {
            switch (s) {
              case 0: signal = this._evalSt1(engine, state, price, theta, dedup, geneIdx); break;
              case 1: signal = this._evalSt2(engine, state, dedup, geneIdx); break;
              case 2: signal = this._evalSt3(state, dedup, geneIdx); break;
              case 3: signal = this._evalSt4(state, dedup, geneIdx); break;
              case 4: signal = this._evalSt5(engine, state, dedup, geneIdx); break;
              case 5: signal = this._evalSt6(dcEvent, state, rng, dedup, geneIdx); break;
            }
          }

          matrix[baseIdx + geneIdx] = signal;
          const label = labels[geneIdx];
          if (signal === BUY) stats[label].buy++;
          else if (signal === SELL) stats[label].sell++;
          else stats[label].hold++;
          geneIdx++;
        }
      }

      // ── St7–St8 (5 thresholds each) ──
      for (let s = 0; s < 2; s++) {
        for (let t = 0; t < this.thresholdsSt7_8.length; t++) {
          const theta = this.thresholdsSt7_8[t];
          const engine = engines.get(theta);
          const dcEvent = events.get(theta);
          const state = engine.getState();
          let signal = HOLD;

          if (state.trend && dcEvent) {
            if (s === 0) {
              signal = this._evalSt7(engine, dcEvent, state, dedup, geneIdx);
            } else {
              signal = this._evalSt8(engine, dcEvent, state, dedup, geneIdx);
            }
          }

          matrix[baseIdx + geneIdx] = signal;
          const label = labels[geneIdx];
          if (signal === BUY) stats[label].buy++;
          else if (signal === SELL) stats[label].sell++;
          else stats[label].hold++;
          geneIdx++;
        }
      }
    }

    return { matrix, stats, numGenes, numCandles };
  }

  // ── Strategy evaluators ─────────────────────────────────────────────────

  _evalSt1(engine, state, price, theta, dedup, geneIdx) {
    const threshold = this.entryMultiplier * theta;

    // Long: downtrend, price dropped entryMultiplier*theta from high extremum
    if (state.trend === 'downtrend') {
      let triggered;
      if (this.usePoints) {
        triggered = state.p_ext_h - price >= threshold;
      } else {
        triggered = price <= state.p_ext_h * (1 - threshold);
      }
      if (triggered) {
        const key = `${state.p_ext_h}_${state.t_ext_h}`;
        if (dedup[geneIdx] !== key) {
          dedup[geneIdx] = key;
          return BUY;
        }
      }
    }

    // Short: uptrend, price rose entryMultiplier*theta from low extremum
    if (state.trend === 'uptrend') {
      let triggered;
      if (this.usePoints) {
        triggered = price - state.p_ext_l >= threshold;
      } else {
        triggered = price >= state.p_ext_l * (1 + threshold);
      }
      if (triggered) {
        const key = `${state.p_ext_l}_${state.t_ext_l}`;
        if (dedup[geneIdx] !== key) {
          dedup[geneIdx] = key;
          return SELL;
        }
      }
    }

    return HOLD;
  }

  _evalSt2(engine, state, dedup, geneIdx) {
    const currentOSDuration = engine.observationCount - engine.dcStartIdx;
    const lastDCDuration = state.T_DC || 1;
    if (currentOSDuration < this.durationMultiplier * lastDCDuration) return HOLD;

    if (state.trend === 'downtrend') {
      const key = `${state.p_ext_h}_${state.t_ext_h}`;
      if (dedup[geneIdx] !== key) { dedup[geneIdx] = key; return BUY; }
    }
    if (state.trend === 'uptrend') {
      const key = `${state.p_ext_l}_${state.t_ext_l}`;
      if (dedup[geneIdx] !== key) { dedup[geneIdx] = key; return SELL; }
    }
    return HOLD;
  }

  _evalSt3(state, dedup, geneIdx) {
    const currentOSV = Math.abs(state.OSV_CUR);

    if (state.trend === 'downtrend' && state.OSV_best_DT > 0 && currentOSV > state.OSV_best_DT) {
      const key = `${state.p_ext_h}_${state.t_ext_h}`;
      if (dedup[geneIdx] !== key) { dedup[geneIdx] = key; return BUY; }
    }
    if (state.trend === 'uptrend' && state.OSV_best_UT > 0 && currentOSV > state.OSV_best_UT) {
      const key = `${state.p_ext_l}_${state.t_ext_l}`;
      if (dedup[geneIdx] !== key) { dedup[geneIdx] = key; return SELL; }
    }
    return HOLD;
  }

  _evalSt4(state, dedup, geneIdx) {
    const currentTMV = Math.abs(state.TMV_CUR);

    if (state.trend === 'downtrend' && state.TMV_best_DT > 0 && currentTMV > state.TMV_best_DT) {
      const key = `${state.p_ext_h}_${state.t_ext_h}`;
      if (dedup[geneIdx] !== key) { dedup[geneIdx] = key; return BUY; }
    }
    if (state.trend === 'uptrend' && state.TMV_best_UT > 0 && currentTMV > state.TMV_best_UT) {
      const key = `${state.p_ext_l}_${state.t_ext_l}`;
      if (dedup[geneIdx] !== key) { dedup[geneIdx] = key; return SELL; }
    }
    return HOLD;
  }

  _evalSt5(engine, state, dedup, geneIdx) {
    const currentOSDuration = engine.observationCount - engine.dcStartIdx;
    const lastDCDuration = state.T_DC || 1;
    const currentRD = currentOSDuration / lastDCDuration;
    if (currentRD < this.rdThreshold) return HOLD;

    if (state.trend === 'downtrend') {
      const key = `${state.p_ext_h}_${state.t_ext_h}`;
      if (dedup[geneIdx] !== key) { dedup[geneIdx] = key; return BUY; }
    }
    if (state.trend === 'uptrend') {
      const key = `${state.p_ext_l}_${state.t_ext_l}`;
      if (dedup[geneIdx] !== key) { dedup[geneIdx] = key; return SELL; }
    }
    return HOLD;
  }

  _evalSt6(dcEvent, state, rng, dedup, geneIdx) {
    if (!dcEvent) return HOLD;

    const RN = state.RN;
    const roll = rng();
    if (roll < RN) return HOLD;

    if (dcEvent.type === 'upturn') {
      const key = `upturn_${state.eventCount}`;
      if (dedup[geneIdx] !== key) { dedup[geneIdx] = key; return BUY; }
    }
    if (dcEvent.type === 'downturn') {
      const key = `downturn_${state.eventCount}`;
      if (dedup[geneIdx] !== key) { dedup[geneIdx] = key; return SELL; }
    }
    return HOLD;
  }

  _evalSt7(engine, dcEvent, state, dedup, geneIdx) {
    const count = this.consecutiveCount;
    const events = engine.getRecentOSPattern(count * 2);
    if (events.length < count * 2) return HOLD;

    const patternKey = `pat_${state.eventCount}`;
    if (dedup[geneIdx] === patternKey) return HOLD;

    const recent = events.slice(-count * 2);

    // Buy pattern: ends with upturn, alternating backward
    if (dcEvent.type === 'upturn') {
      let valid = true;
      for (let i = 0; i < recent.length; i++) {
        const idx = recent.length - 1 - i;
        const expected = i % 2 === 0 ? 'upturn' : 'downturn';
        if (recent[idx].type !== expected) { valid = false; break; }
        if (recent[idx].osv !== undefined && Math.abs(recent[idx].osv) <= 0) { valid = false; break; }
      }
      if (valid) { dedup[geneIdx] = patternKey; return BUY; }
    }

    // Sell pattern: ends with downturn
    if (dcEvent.type === 'downturn') {
      let valid = true;
      for (let i = 0; i < recent.length; i++) {
        const idx = recent.length - 1 - i;
        const expected = i % 2 === 0 ? 'downturn' : 'upturn';
        if (recent[idx].type !== expected) { valid = false; break; }
        if (recent[idx].osv !== undefined && Math.abs(recent[idx].osv) <= 0) { valid = false; break; }
      }
      if (valid) { dedup[geneIdx] = patternKey; return SELL; }
    }

    return HOLD;
  }

  _evalSt8(engine, dcEvent, state, dedup, geneIdx) {
    const count = this.consecutiveCount;
    const events = engine.getRecentOSPattern(count * 2);
    if (events.length < count * 2) return HOLD;

    const patternKey = `pat_${state.eventCount}`;
    if (dedup[geneIdx] === patternKey) return HOLD;

    const recent = events.slice(-count * 2);

    // Contrarian buy: DT-UT pattern ending in downturn
    if (dcEvent.type === 'downturn') {
      let valid = true;
      for (let i = 0; i < recent.length; i++) {
        const idx = recent.length - 1 - i;
        const expected = i % 2 === 0 ? 'downturn' : 'upturn';
        if (recent[idx].type !== expected) { valid = false; break; }
        if (recent[idx].osv !== undefined && Math.abs(recent[idx].osv) <= 0) { valid = false; break; }
      }
      if (valid) { dedup[geneIdx] = patternKey; return BUY; }
    }

    // Contrarian sell: UT-DT pattern ending in upturn
    if (dcEvent.type === 'upturn') {
      let valid = true;
      for (let i = 0; i < recent.length; i++) {
        const idx = recent.length - 1 - i;
        const expected = i % 2 === 0 ? 'upturn' : 'downturn';
        if (recent[idx].type !== expected) { valid = false; break; }
        if (recent[idx].osv !== undefined && Math.abs(recent[idx].osv) <= 0) { valid = false; break; }
      }
      if (valid) { dedup[geneIdx] = patternKey; return SELL; }
    }

    return HOLD;
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  _initDedup() {
    // Simple array: one slot per gene. Value is the last dedup key.
    return new Array(this.numGenes).fill(null);
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
}

// ─── Lightweight Simulator ────────────────────────────────────────────────

/**
 * Fast trade simulation for fitness evaluation.
 * No limit order fills, no trailing stops, no contract rollover.
 * Market entry at close + fixed stop/target checked against candle high/low.
 */
export class LightweightSimulator {
  /**
   * @param {Object} options
   * @param {number} [options.stopLossPoints=15]
   * @param {number} [options.takeProfitPoints=30]
   * @param {number} [options.slippage=1]
   * @param {number} [options.commission=5]
   * @param {number} [options.pointValue=20] - Dollar value per point (NQ=20, ES=50)
   * @param {number} [options.riskFreeRate=0.02] - Annual risk-free rate for Sharpe
   * @param {number} [options.confirmThreshold=0] - Min |buyWeight - sellWeight| to trigger trade
   * @param {number} [options.cooldownCandles=0] - Candles to wait after exit before next entry
   * @param {number} [options.minNonHoldVotes=2] - Minimum non-Hold genes to trigger trade
   * @param {number} [options.maxTradesPerDay=0] - Daily trade cap (0 = unlimited)
   */
  constructor(options = {}) {
    this.stopLossPoints = options.stopLossPoints ?? 15;
    this.takeProfitPoints = options.takeProfitPoints ?? 30;
    this.slippage = options.slippage ?? 1;
    this.commission = options.commission ?? 5;
    this.pointValue = options.pointValue ?? 20;
    this.riskFreeRate = options.riskFreeRate ?? 0.02;
    this.confirmThreshold = options.confirmThreshold ?? 0;
    this.cooldownCandles = options.cooldownCandles ?? 0;
    this.minNonHoldVotes = options.minNonHoldVotes ?? 2;
    this.maxTradesPerDay = options.maxTradesPerDay ?? 0;
  }

  /**
   * Evaluate a chromosome against candles and signal matrix
   * @param {Object[]} candles
   * @param {Int8Array} matrix - Signal matrix from precomputer
   * @param {Float64Array} genes - Chromosome weights
   * @param {number} numGenes
   * @returns {Object} { trades, equityCurve, sharpeRatio, totalPnL, winRate, numTrades, maxDrawdown }
   */
  evaluate(candles, matrix, genes, numGenes) {
    const trades = [];
    let position = null;  // { side, entryPrice, stopLoss, takeProfit, entryIdx }
    let equity = 0;

    // Daily PnL tracking for Sharpe
    const dailyPnL = [];
    let currentDayPnL = 0;
    let currentDay = null;

    // Cooldown and daily cap tracking
    let lastExitIdx = -Infinity;
    let dailyTradeCount = 0;

    for (let i = 0; i < candles.length; i++) {
      const candle = candles[i];
      const candleDay = this._getDay(candle.timestamp);

      // New day: flush daily PnL, reset daily trade count
      if (currentDay !== null && candleDay !== currentDay) {
        dailyPnL.push(currentDayPnL);
        currentDayPnL = 0;
        dailyTradeCount = 0;
      }
      currentDay = candleDay;

      // Check exit conditions if in position
      if (position) {
        const exitResult = this._checkExit(position, candle);
        if (exitResult) {
          const pnl = exitResult.pnl - this.commission;
          equity += pnl;
          currentDayPnL += pnl;
          trades.push({
            entryIdx: position.entryIdx,
            exitIdx: i,
            side: position.side,
            entryPrice: position.entryPrice,
            exitPrice: exitResult.exitPrice,
            exitReason: exitResult.reason,
            pnl,
            equity
          });
          position = null;
          lastExitIdx = i;
        }
      }

      // If no position, compute weighted vote
      if (!position) {
        // Cooldown check
        if (this.cooldownCandles > 0 && i - lastExitIdx < this.cooldownCandles) continue;
        // Daily trade cap check
        if (this.maxTradesPerDay > 0 && dailyTradeCount >= this.maxTradesPerDay) continue;

        const action = this._weightedVote(matrix, i, genes, numGenes);

        if (action !== HOLD) {
          dailyTradeCount++;
          const side = action === BUY ? 'buy' : 'sell';
          const entryPrice = side === 'buy'
            ? candle.close + this.slippage
            : candle.close - this.slippage;

          const stopLoss = side === 'buy'
            ? entryPrice - this.stopLossPoints
            : entryPrice + this.stopLossPoints;

          const takeProfit = side === 'buy'
            ? entryPrice + this.takeProfitPoints
            : entryPrice - this.takeProfitPoints;

          position = { side, entryPrice, stopLoss, takeProfit, entryIdx: i };
        }
      }
    }

    // Force close at end of data
    if (position) {
      const lastCandle = candles[candles.length - 1];
      const exitPrice = position.side === 'buy'
        ? lastCandle.close - this.slippage
        : lastCandle.close + this.slippage;
      const rawPnL = position.side === 'buy'
        ? (exitPrice - position.entryPrice) * this.pointValue
        : (position.entryPrice - exitPrice) * this.pointValue;
      const pnl = rawPnL - this.commission;
      equity += pnl;
      currentDayPnL += pnl;
      trades.push({
        entryIdx: position.entryIdx,
        exitIdx: candles.length - 1,
        side: position.side,
        entryPrice: position.entryPrice,
        exitPrice,
        exitReason: 'end_of_data',
        pnl,
        equity
      });
      position = null;
    }

    // Flush last day
    if (currentDayPnL !== 0 || dailyPnL.length > 0) {
      dailyPnL.push(currentDayPnL);
    }

    // Compute metrics
    const numTrades = trades.length;
    const totalPnL = equity;
    const winRate = numTrades > 0
      ? trades.filter(t => t.pnl > 0).length / numTrades
      : 0;

    // Max drawdown
    let peak = 0;
    let maxDrawdown = 0;
    for (const trade of trades) {
      if (trade.equity > peak) peak = trade.equity;
      const dd = peak - trade.equity;
      if (dd > maxDrawdown) maxDrawdown = dd;
    }

    // Sharpe ratio from daily returns
    const sharpeRatio = this._computeSharpe(dailyPnL);

    return { trades, sharpeRatio, totalPnL, winRate, numTrades, maxDrawdown, dailyPnL };
  }

  _weightedVote(matrix, candleIdx, genes, numGenes) {
    const baseIdx = candleIdx * numGenes;
    let buyWeight = 0;
    let sellWeight = 0;
    let holdWeight = 0;
    let nonHoldCount = 0;

    for (let g = 0; g < numGenes; g++) {
      const signal = matrix[baseIdx + g];
      const weight = genes[g];
      if (signal === BUY) { buyWeight += weight; nonHoldCount++; }
      else if (signal === SELL) { sellWeight += weight; nonHoldCount++; }
      else { holdWeight += weight; }
    }

    // If enough non-Hold votes, ignore Hold and pick highest weighted action
    if (nonHoldCount >= this.minNonHoldVotes) {
      // Confirmation threshold: require minimum margin between buy/sell
      if (this.confirmThreshold > 0 && Math.abs(buyWeight - sellWeight) < this.confirmThreshold) {
        return HOLD;
      }
      if (buyWeight > sellWeight) return BUY;
      if (sellWeight > buyWeight) return SELL;
      return HOLD; // Tie
    }

    // Otherwise include Hold in comparison
    if (buyWeight > sellWeight && buyWeight > holdWeight) return BUY;
    if (sellWeight > buyWeight && sellWeight > holdWeight) return SELL;
    return HOLD;
  }

  _checkExit(position, candle) {
    const { side, entryPrice, stopLoss, takeProfit } = position;

    if (side === 'buy') {
      // Check stop loss (hit if candle low goes below stop)
      if (candle.low <= stopLoss) {
        const exitPrice = stopLoss - this.slippage;
        const pnl = (exitPrice - entryPrice) * this.pointValue;
        return { exitPrice, pnl, reason: 'stop_loss' };
      }
      // Check take profit (hit if candle high goes above target)
      if (candle.high >= takeProfit) {
        const exitPrice = takeProfit;
        const pnl = (exitPrice - entryPrice) * this.pointValue;
        return { exitPrice, pnl, reason: 'take_profit' };
      }
    } else {
      // Short: stop loss hit if candle high goes above stop
      if (candle.high >= stopLoss) {
        const exitPrice = stopLoss + this.slippage;
        const pnl = (entryPrice - exitPrice) * this.pointValue;
        return { exitPrice, pnl, reason: 'stop_loss' };
      }
      // Take profit hit if candle low goes below target
      if (candle.low <= takeProfit) {
        const exitPrice = takeProfit;
        const pnl = (entryPrice - exitPrice) * this.pointValue;
        return { exitPrice, pnl, reason: 'take_profit' };
      }
    }

    return null;
  }

  _computeSharpe(dailyPnL) {
    if (dailyPnL.length < 2) return 0;

    const n = dailyPnL.length;
    const mean = dailyPnL.reduce((a, b) => a + b, 0) / n;
    const variance = dailyPnL.reduce((sum, d) => sum + (d - mean) ** 2, 0) / (n - 1);
    const stdDev = Math.sqrt(variance);

    if (stdDev === 0) return 0;

    // Annualize: ~252 trading days
    const annualizedReturn = mean * 252;
    const annualizedStdDev = stdDev * Math.sqrt(252);

    return (annualizedReturn - this.riskFreeRate) / annualizedStdDev;
  }

  _computeSortino(dailyPnL) {
    if (dailyPnL.length < 2) return 0;

    const n = dailyPnL.length;
    const mean = dailyPnL.reduce((a, b) => a + b, 0) / n;
    const downsideVariance = dailyPnL.reduce((sum, d) => {
      const diff = d - mean;
      return sum + (diff < 0 ? diff * diff : 0);
    }, 0) / (n - 1);
    const downsideDev = Math.sqrt(downsideVariance);

    if (downsideDev === 0) return mean > 0 ? 10 : 0;

    const annualizedReturn = mean * 252;
    const annualizedDownside = downsideDev * Math.sqrt(252);

    return (annualizedReturn - this.riskFreeRate) / annualizedDownside;
  }

  _computeCalmar(dailyPnL, maxDrawdown) {
    if (maxDrawdown === 0) return 0;

    const n = dailyPnL.length;
    const totalReturn = dailyPnL.reduce((a, b) => a + b, 0);
    const annualizedReturn = (totalReturn / n) * 252;

    return annualizedReturn / maxDrawdown;
  }

  _getDay(timestamp) {
    const d = new Date(timestamp);
    return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
  }
}

// ─── MSTGAM Optimizer ─────────────────────────────────────────────────────

/**
 * Genetic algorithm optimizer for multi-strategy/threshold DC trading.
 *
 * GA params (paper Table 4 defaults):
 *   pop=150, gen=50, tournament=2, crossover=0.95, mutation=0.05, elitism=1
 */
export class MSTGAMOptimizer {
  /**
   * @param {Object} options
   * @param {number} [options.populationSize=150]
   * @param {number} [options.generations=50]
   * @param {number} [options.tournamentSize=2]
   * @param {number} [options.crossoverRate=0.95]
   * @param {number} [options.mutationRate=0.05]
   * @param {number} [options.elitismCount=1]
   * @param {number} [options.seed=42]
   * @param {string} [options.fitnessMode='sharpe'] - 'sharpe', 'sortino', 'calmar', 'composite'
   * @param {number} [options.minTradeCount=20] - Minimum trades; fewer → fitness = -Infinity
   * @param {Function} [options.onProgress] - Callback (gen, bestFitness, avgFitness)
   */
  constructor(options = {}) {
    this.populationSize = options.populationSize ?? 150;
    this.generations = options.generations ?? 50;
    this.tournamentSize = options.tournamentSize ?? 2;
    this.crossoverRate = options.crossoverRate ?? 0.95;
    this.mutationRate = options.mutationRate ?? 0.05;
    this.elitismCount = options.elitismCount ?? 1;
    this.seed = options.seed ?? 42;
    this.fitnessMode = options.fitnessMode ?? 'sharpe';
    this.minTradeCount = options.minTradeCount ?? 20;
    this.onProgress = options.onProgress || null;
  }

  /**
   * Run the GA optimization
   * @param {Object[]} candles
   * @param {Object} precomputerOptions - Options for SignalPrecomputer
   * @param {Object} simulatorOptions - Options for LightweightSimulator
   * @returns {{ bestChromosome: Chromosome, generationHistory: Object[], precomputer: SignalPrecomputer }}
   */
  optimize(candles, precomputerOptions = {}, simulatorOptions = {}) {
    const rng = mulberry32(this.seed);

    // 1. Pre-compute signal matrix
    const precomputer = new SignalPrecomputer({ ...precomputerOptions, seed: this.seed });
    const { matrix, stats, numGenes, numCandles } = precomputer.compute(candles);

    // 2. Create simulator
    const simulator = new LightweightSimulator(simulatorOptions);

    // 3. Initialize population
    let population = [];
    for (let i = 0; i < this.populationSize; i++) {
      population.push(new Chromosome(numGenes, rng));
    }

    // 4. Evaluate initial population
    this._evaluatePopulation(population, candles, matrix, numGenes, simulator);

    const generationHistory = [];
    let globalBest = this._getBest(population).clone();

    // 5. Evolution loop
    for (let gen = 0; gen < this.generations; gen++) {
      const newPopulation = [];

      // Elitism: carry best chromosomes
      const sorted = [...population].sort((a, b) => b.fitness - a.fitness);
      for (let e = 0; e < this.elitismCount; e++) {
        newPopulation.push(sorted[e].clone());
      }

      // Fill rest via selection + crossover + mutation
      while (newPopulation.length < this.populationSize) {
        // Tournament selection
        const parent1 = this._tournamentSelect(population, rng);
        const parent2 = this._tournamentSelect(population, rng);

        // Crossover
        let child1, child2;
        if (rng() < this.crossoverRate) {
          [child1, child2] = this._twoPointCrossover(parent1, parent2, rng);
        } else {
          child1 = parent1.clone();
          child2 = parent2.clone();
        }

        // Mutation
        this._mutate(child1, rng);
        this._mutate(child2, rng);

        newPopulation.push(child1);
        if (newPopulation.length < this.populationSize) {
          newPopulation.push(child2);
        }
      }

      // Evaluate new population
      population = newPopulation;
      this._evaluatePopulation(population, candles, matrix, numGenes, simulator);

      // Track best
      const best = this._getBest(population);
      if (best.fitness > globalBest.fitness) {
        globalBest = best.clone();
      }

      // Stats
      const avgFitness = population.reduce((s, c) => s + c.fitness, 0) / population.length;
      generationHistory.push({
        generation: gen + 1,
        bestFitness: best.fitness,
        avgFitness,
        globalBestFitness: globalBest.fitness
      });

      if (this.onProgress) {
        this.onProgress(gen + 1, this.generations, globalBest.fitness, avgFitness, best.metrics);
      }
    }

    return {
      bestChromosome: globalBest,
      generationHistory,
      precomputer,
      signalStats: stats
    };
  }

  _evaluatePopulation(population, candles, matrix, numGenes, simulator) {
    for (const chromo of population) {
      const result = simulator.evaluate(candles, matrix, chromo.genes, numGenes);

      // Min trade count guardrail
      if (result.numTrades < this.minTradeCount) {
        chromo.fitness = -Infinity;
        chromo.metrics = {
          sharpeRatio: result.sharpeRatio,
          totalPnL: result.totalPnL,
          winRate: result.winRate,
          numTrades: result.numTrades,
          maxDrawdown: result.maxDrawdown
        };
        continue;
      }

      // Compute fitness based on mode
      let fitness;
      switch (this.fitnessMode) {
        case 'sortino':
          fitness = simulator._computeSortino(result.dailyPnL);
          break;
        case 'calmar':
          fitness = simulator._computeCalmar(result.dailyPnL, result.maxDrawdown);
          break;
        case 'composite': {
          const sharpe = result.sharpeRatio;
          const ddFraction = result.maxDrawdown > 0 ? 1 - (result.maxDrawdown / 100000) : 1;
          fitness = 0.6 * sharpe + 0.3 * Math.max(0, Math.min(1, ddFraction)) + 0.1 * result.winRate;
          break;
        }
        case 'sharpe':
        default:
          fitness = result.sharpeRatio;
          break;
      }

      chromo.fitness = fitness;
      chromo.metrics = {
        sharpeRatio: result.sharpeRatio,
        totalPnL: result.totalPnL,
        winRate: result.winRate,
        numTrades: result.numTrades,
        maxDrawdown: result.maxDrawdown
      };
    }
  }

  _getBest(population) {
    let best = population[0];
    for (let i = 1; i < population.length; i++) {
      if (population[i].fitness > best.fitness) {
        best = population[i];
      }
    }
    return best;
  }

  _tournamentSelect(population, rng) {
    let best = population[Math.floor(rng() * population.length)];
    for (let i = 1; i < this.tournamentSize; i++) {
      const candidate = population[Math.floor(rng() * population.length)];
      if (candidate.fitness > best.fitness) {
        best = candidate;
      }
    }
    return best;
  }

  _twoPointCrossover(parent1, parent2, rng) {
    const len = parent1.genes.length;
    let p1 = Math.floor(rng() * len);
    let p2 = Math.floor(rng() * len);
    if (p1 > p2) [p1, p2] = [p2, p1];

    const child1 = new Chromosome(len);
    const child2 = new Chromosome(len);

    for (let i = 0; i < len; i++) {
      if (i >= p1 && i <= p2) {
        child1.genes[i] = parent2.genes[i];
        child2.genes[i] = parent1.genes[i];
      } else {
        child1.genes[i] = parent1.genes[i];
        child2.genes[i] = parent2.genes[i];
      }
    }

    return [child1, child2];
  }

  _mutate(chromosome, rng) {
    for (let i = 0; i < chromosome.genes.length; i++) {
      if (rng() < this.mutationRate) {
        // Uniform mutation: replace with random value in [0, 1]
        chromosome.genes[i] = rng();
      }
    }
  }
}

export default MSTGAMOptimizer;
