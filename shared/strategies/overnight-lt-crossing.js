/**
 * Overnight LT Level Crossing Strategy
 *
 * Trades based on LT Fibonacci level crossings through spot price during
 * the overnight session. When multiple LT levels cross through price in
 * the same direction, it signals a liquidity shift.
 *
 * Signal:
 *   - Level crossing DOWN through price → BULLISH (support forming)
 *   - Level crossing UP through price → BEARISH (liquidity deteriorating)
 *   - Each crossing weighted by Fib lookback: fib34=1, fib55=1, fib144=2, fib377=3, fib610=4
 *   - Running weighted score accumulated per overnight session
 *   - Entry when |score| >= threshold
 *
 * Baseline (score>=4, symmetric 20pt stop/target):
 *   454 trades, 58.5% WR, 1,427 pts total
 *
 * Requires: raw contract OHLCV data (--raw-contracts) for price/LT alignment
 */

import { BaseStrategy } from './base-strategy.js';
import { roundTo } from './strategy-utils.js';

export class OvernightLTCrossingStrategy extends BaseStrategy {
  constructor(params = {}) {
    super(params);

    this.defaultParams = {
      // Score threshold to trigger entry
      scoreThreshold: 4,

      // Stop/target
      stopLossPoints: 20,
      takeProfitPoints: 20,

      // Trailing stop (0 = disabled)
      trailingTrigger: 0,
      trailingOffset: 0,

      // Session
      maxHoldBars: 840,    // ~14 hours safety net
      signalCooldownMs: 60000,

      // Symbol
      tradingSymbol: 'NQ1!',
      defaultQuantity: 1,
      forceCloseAtMarketClose: false,
    };

    this.params = { ...this.defaultParams, ...params };
    this._initState();
  }

  _initState() {
    this._inRTH = false;
    this._overnightActive = false;
    this._signalledTonight = false;
    this._runningScore = 0;

    // Previous LT snapshot for crossing detection
    this._prevLT = null;       // { level_1..5 }
    this._prevSpot = null;     // midpoint price at prev LT snapshot
    this._prevLTTimestamp = 0;
  }

  // ── Timezone ──

  _isDST(ms) {
    const d = new Date(ms), y = d.getUTCFullYear(), m = d.getUTCMonth();
    if (m >= 3 && m <= 9) return true;
    if (m === 0 || m === 1 || m === 11) return false;
    if (m === 2) { const fd = new Date(Date.UTC(y, 2, 1)).getUTCDay(); return ms >= Date.UTC(y, 2, fd === 0 ? 8 : 15 - fd, 7); }
    if (m === 10) { const fd = new Date(Date.UTC(y, 10, 1)).getUTCDay(); return ms < Date.UTC(y, 10, fd === 0 ? 1 : 8 - fd, 6); }
    return false;
  }

  _getESTHour(ts) {
    const d = new Date(ts + (this._isDST(ts) ? -4 : -5) * 3600000);
    return d.getUTCHours() + d.getUTCMinutes() / 60;
  }

  // ── Crossing detection ──

  static FIB_WEIGHTS = [1, 1, 2, 3, 4]; // level_1=fib34, level_2=fib55, level_3=fib144, level_4=fib377, level_5=fib610
  static LEVEL_KEYS = ['level_1', 'level_2', 'level_3', 'level_4', 'level_5'];

  _detectCrossings(prevLT, currLT, prevSpot, currSpot) {
    let batchScore = 0;
    let crossingCount = 0;

    for (let l = 0; l < 5; l++) {
      const key = OvernightLTCrossingStrategy.LEVEL_KEYS[l];
      const prevLevel = prevLT[key];
      const currLevel = currLT[key];
      if (prevLevel == null || currLevel == null) continue;

      const prevAbove = prevLevel > prevSpot;
      const currAbove = currLevel > currSpot;
      if (prevAbove === currAbove) continue; // No crossing

      // Level crossed DOWN through price → bullish (+1)
      // Level crossed UP through price → bearish (-1)
      const signal = (prevAbove && !currAbove) ? 1 : -1;
      batchScore += signal * OvernightLTCrossingStrategy.FIB_WEIGHTS[l];
      crossingCount++;
    }

    return { batchScore, crossingCount };
  }

  // ── Main evaluation ──

  evaluateSignal(candle, prevCandle, marketData, options = {}) {
    const ts = candle.timestamp;
    const estHour = this._getESTHour(ts);
    const { ltLevels } = marketData || {};

    const isRTH = estHour >= 9.5 && estHour < 16;
    const isOvernight = estHour >= 18 || estHour < 8;

    // ── New RTH session: reset overnight state ──
    if (isRTH && !this._inRTH) {
      this._overnightActive = false;
      this._signalledTonight = false;
      this._runningScore = 0;
      this._prevLT = null;
      this._prevSpot = null;
      this._prevLTTimestamp = 0;
    }
    this._inRTH = isRTH;

    // Only operate during overnight
    if (!isOvernight) return null;
    if (this._signalledTonight) return null;

    // Need LT data for crossing detection
    if (!ltLevels) return null;

    // Check if this is a new LT snapshot (avoid recounting same snapshot)
    const ltTs = ltLevels.timestamp || 0;
    if (ltTs <= this._prevLTTimestamp) return null; // Same or older snapshot

    const currSpot = (candle.high + candle.low) / 2;

    // Detect crossings against previous snapshot
    if (this._prevLT && this._prevSpot != null) {
      const { batchScore, crossingCount } = this._detectCrossings(
        this._prevLT, ltLevels, this._prevSpot, currSpot
      );

      if (crossingCount > 0) {
        this._runningScore += batchScore;
      }
    }

    // Update previous LT state
    this._prevLT = {
      level_1: ltLevels.level_1,
      level_2: ltLevels.level_2,
      level_3: ltLevels.level_3,
      level_4: ltLevels.level_4,
      level_5: ltLevels.level_5,
    };
    this._prevSpot = currSpot;
    this._prevLTTimestamp = ltTs;

    // Mark overnight as active (for session tracking)
    if (!this._overnightActive) {
      this._overnightActive = true;
    }

    // Check if score threshold reached
    if (Math.abs(this._runningScore) < this.params.scoreThreshold) return null;

    // Cooldown
    if (!this.checkCooldown(ts, this.params.signalCooldownMs)) return null;

    // ── Generate signal ──
    this._signalledTonight = true;
    this.updateLastSignalTime(ts);

    const isLong = this._runningScore > 0;
    const side = isLong ? 'buy' : 'sell';
    const entryPrice = candle.close;

    const stopLoss = isLong
      ? roundTo(entryPrice - this.params.stopLossPoints)
      : roundTo(entryPrice + this.params.stopLossPoints);
    const takeProfit = isLong
      ? roundTo(entryPrice + this.params.takeProfitPoints)
      : roundTo(entryPrice - this.params.takeProfitPoints);

    return {
      strategy: 'OVERNIGHT_LT_CROSSING',
      action: 'place_market',
      side,
      symbol: this.params.tradingSymbol,
      price: roundTo(entryPrice),
      stop_loss: stopLoss,
      take_profit: takeProfit,
      trailing_trigger: this.params.trailingTrigger || undefined,
      trailing_offset: this.params.trailingOffset || undefined,
      quantity: this.params.defaultQuantity,
      maxHoldBars: this.params.maxHoldBars,
      timestamp: new Date(ts).toISOString(),
      metadata: {
        score: this._runningScore,
        direction: isLong ? 'bullish' : 'bearish',
        entry_hour: roundTo(estHour, 2),
        stop_points: this.params.stopLossPoints,
        target_points: this.params.takeProfitPoints,
      },
    };
  }

  reset() {
    super.reset();
    this._initState();
  }

  getName() { return 'OVERNIGHT_LT_CROSSING'; }
  getDescription() { return 'Overnight LT Fibonacci level crossing strategy'; }
  getRequiredMarketData() { return ['ltLevels']; }

  validateParams(params) {
    const errors = [];
    if (params.scoreThreshold < 1) errors.push('scoreThreshold must be >= 1');
    if (params.stopLossPoints <= 0) errors.push('stopLossPoints must be > 0');
    if (params.takeProfitPoints <= 0) errors.push('takeProfitPoints must be > 0');
    return { valid: errors.length === 0, errors };
  }
}
