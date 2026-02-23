/**
 * Momentum Microstructure Strategy
 *
 * Detects momentum burst events from 1-second candle microstructure.
 * Within a rolling window (15s/30s/60s), measures:
 *   - Price velocity (pts/sec)
 *   - Volume surge vs 300s baseline
 *   - Move efficiency (|net| / sum(|tick-to-tick|))
 *   - Close position within window range
 *   - Tick direction ratio
 *   - Volume acceleration (2nd half / 1st half)
 *
 * Multi-window confirmation (2+ window sizes trigger simultaneously) is
 * the strongest predictor of continuation.
 *
 * Based on exploratory analysis (es-nq-momentum-microstructure.js):
 *   ES: 68% win at 1m, PF 3.02 (multi-window 2x, n=25)
 *   NQ: 60% win at 1m, PF 2.91 (multi-window 2x, n=25)
 *
 * This strategy is designed for 1-second candle evaluation.
 * Running via the main backtest engine (1m candle loop) will NOT produce
 * correct results — use the standalone runner instead:
 *   node scripts/run-momentum-microstructure-backtest.js
 */

import { BaseStrategy } from './base-strategy.js';
import { roundTo } from './strategy-utils.js';

// Welford's Online Algorithm for incremental mean/variance/z-score
class WelfordTracker {
  constructor() {
    this.n = 0;
    this.mean = 0;
    this.M2 = 0;
  }

  update(value) {
    this.n++;
    const delta = value - this.mean;
    this.mean += delta / this.n;
    const delta2 = value - this.mean;
    this.M2 += delta * delta2;
  }

  get variance() {
    return this.n < 2 ? 0 : this.M2 / (this.n - 1);
  }

  get stddev() {
    return Math.sqrt(this.variance);
  }

  zScore(value) {
    const sd = this.stddev;
    if (sd === 0 || this.n < 30) return 0;
    return (value - this.mean) / sd;
  }
}

export class MomentumMicrostructureStrategy extends BaseStrategy {
  static getDataRequirements() {
    return {
      candles: true,
      gex: false,
      lt: false,
      tradier: false,
      ivSkew: false
    };
  }

  constructor(params = {}) {
    super(params);

    // Detect product from symbol for sensible defaults
    const symbol = (params.tradingSymbol || params.symbol || 'ES').toUpperCase();
    const isNQ = symbol.includes('NQ');

    this.defaultParams = {
      // Microstructure detection thresholds
      velocityThreshold: isNQ ? 2.0 : 0.5,
      volumeRatioThreshold: 2.0,
      efficiencyThreshold: 0.6,
      closePositionThreshold: 0.7,     // bullish: close > 0.7, bearish: close < 0.3
      tickDirectionThreshold: 0.65,    // bullish: ratio > 0.65, bearish: < 0.35

      // Window sizes (seconds) for multi-window detection
      windowSizes: [15, 30, 60],

      // Require multiple windows to trigger simultaneously
      requireMultiWindow: false,
      minWindowCount: 2,

      // Direction filter
      longOnly: false,
      shortOnly: false,

      // Baseline volume window (seconds)
      baselineWindow: 300,

      // Cooldown between signals (seconds)
      cooldownSeconds: 30,

      // Rolling buffer size (seconds) — must cover max(windows, baseline) + padding
      rollingBufferSeconds: 420,

      // Z-score update interval (every N candles to save CPU)
      zUpdateInterval: 5,

      // Exit parameters — ES defaults
      targetPoints: isNQ ? 30 : 8,
      stopPoints: isNQ ? 20 : 6,
      trailingTrigger: isNQ ? 15 : 4,
      trailingOffset: isNQ ? 8 : 2,
      maxHoldBars: 300,  // 5 minutes of 1s bars

      // Session filtering
      useSessionFilter: true,
      allowedSessions: ['rth'],

      // Symbol configuration
      tradingSymbol: symbol,
      defaultQuantity: 1,

      // Force close at session end
      forceCloseAtMarketClose: true,

      debug: false
    };

    this.params = { ...this.defaultParams, ...params };

    // Internal state
    this.rollingBuffer = [];
    this.bufferStartIdx = 0;
    this.baselineVolume = 0;
    this.baselineStartPtr = 0;

    // Z-score trackers per window size
    this.zTrackers = {};
    for (const ws of this.params.windowSizes) {
      this.zTrackers[ws] = {
        velocity: new WelfordTracker(),
        volumeRatio: new WelfordTracker(),
        efficiency: new WelfordTracker()
      };
    }
    this.zUpdateCounter = 0;

    this.lastEventTimestamp = 0;
  }

  /**
   * Evaluate a 1-second candle for momentum burst signal.
   *
   * @param {Object} candle - 1s candle { timestamp, open, high, low, close, volume, symbol }
   * @param {Object} prevCandle - Unused (kept for BaseStrategy interface compatibility)
   * @param {Object} marketData - Unused (pure OHLCV strategy)
   * @param {Object} options - { debug }
   * @returns {Object|null} Signal or null
   */
  evaluateSignal(candle, prevCandle, marketData, options = {}) {
    const debug = options.debug || this.params.debug;
    const timestamp = typeof candle.timestamp === 'number'
      ? candle.timestamp
      : new Date(candle.timestamp).getTime();

    // Skip degenerate candles
    if (candle.open === candle.high && candle.high === candle.low && candle.low === candle.close) {
      return null;
    }

    // Session filter
    if (this.params.useSessionFilter && !this.isAllowedSession(timestamp)) {
      // Still add to buffer for baseline tracking even if we don't generate signals
      this._addToBuffer(candle, timestamp);
      return null;
    }

    // Add candle to rolling buffer
    this._addToBuffer(candle, timestamp);

    const activeStart = this.bufferStartIdx;
    const activeEnd = this.rollingBuffer.length;
    const activeLen = activeEnd - activeStart;

    // Need enough data for baseline
    if (activeLen < 100) return null;

    // Cooldown check
    if (timestamp - this.lastEventTimestamp < this.params.cooldownSeconds * 1000) {
      return null;
    }

    // Baseline volume rate (O(1) — tracked incrementally)
    const baselineVolumeRate = this.baselineVolume / this.params.baselineWindow;

    // Evaluate each window size
    let bestBurst = null;
    const triggeredWindows = [];

    for (const ws of this.params.windowSizes) {
      const wsCutoff = timestamp - ws * 1000;
      const windowCandles = [];
      for (let b = activeEnd - 1; b >= activeStart; b--) {
        if (this.rollingBuffer[b].timestamp < wsCutoff) break;
        windowCandles.push(this.rollingBuffer[b]);
      }
      windowCandles.reverse();

      if (windowCandles.length < 3) continue;

      const metrics = this._computeMetrics(windowCandles, ws);
      if (!metrics) continue;

      const windowVolumeRate = metrics.totalVolume / ws;

      // Update z-score trackers periodically
      if (this.zUpdateCounter % this.params.zUpdateInterval === 0) {
        this.zTrackers[ws].velocity.update(Math.abs(metrics.velocity));
        this.zTrackers[ws].efficiency.update(metrics.efficiency);
        if (baselineVolumeRate > 0) {
          this.zTrackers[ws].volumeRatio.update(windowVolumeRate / baselineVolumeRate);
        }
      }

      const burst = this._checkMomentumBurst(metrics, windowVolumeRate, baselineVolumeRate);

      if (burst) {
        triggeredWindows.push(ws);
        if (!bestBurst || burst.absVelocity > bestBurst.absVelocity) {
          bestBurst = { ...burst, windowSize: ws, volumeRate: windowVolumeRate };
        }
      }
    }

    this.zUpdateCounter++;

    if (!bestBurst) return null;

    // Multi-window filter
    if (this.params.requireMultiWindow && triggeredWindows.length < this.params.minWindowCount) {
      return null;
    }

    // Direction filter
    if (this.params.longOnly && bestBurst.direction !== 'long') return null;
    if (this.params.shortOnly && bestBurst.direction !== 'short') return null;

    // Build signal
    this.lastEventTimestamp = timestamp;
    this.updateLastSignalTime(timestamp);

    const side = bestBurst.direction === 'long' ? 'buy' : 'sell';
    const entryPrice = candle.close;
    const stopLoss = side === 'buy'
      ? roundTo(entryPrice - this.params.stopPoints)
      : roundTo(entryPrice + this.params.stopPoints);
    const takeProfit = side === 'buy'
      ? roundTo(entryPrice + this.params.targetPoints)
      : roundTo(entryPrice - this.params.targetPoints);

    const signal = {
      strategy: 'MOMENTUM_MICROSTRUCTURE',
      side,
      action: 'place_market',
      symbol: this.params.tradingSymbol,
      price: roundTo(entryPrice),
      stop_loss: stopLoss,
      take_profit: takeProfit,
      trailing_trigger: this.params.trailingTrigger,
      trailing_offset: this.params.trailingOffset,
      quantity: this.params.defaultQuantity,
      maxHoldBars: this.params.maxHoldBars,
      timestamp: new Date(timestamp).toISOString(),
      metadata: {
        detector: 'momentum_microstructure',
        direction: bestBurst.direction,
        triggeredWindows,
        windowCount: triggeredWindows.length,
        multiWindow: triggeredWindows.length > 1,
        bestWindow: bestBurst.windowSize,
        velocity: roundTo(bestBurst.velocity, 4),
        absVelocity: roundTo(bestBurst.absVelocity, 4),
        volumeRatio: roundTo(bestBurst.volumeRatio),
        efficiency: roundTo(bestBurst.efficiency, 4),
        closePosition: roundTo(bestBurst.closePosition, 4),
        tickDirectionRatio: roundTo(bestBurst.tickDirectionRatio, 4),
        volumeAcceleration: roundTo(bestBurst.volumeAcceleration),
        netMove: roundTo(bestBurst.netMove, 4),
        range: roundTo(bestBurst.range, 4),
        velocityZ: roundTo(this.zTrackers[bestBurst.windowSize].velocity.zScore(bestBurst.absVelocity)),
        efficiencyZ: roundTo(this.zTrackers[bestBurst.windowSize].efficiency.zScore(bestBurst.efficiency)),
        volumeRatioZ: roundTo(this.zTrackers[bestBurst.windowSize].volumeRatio.zScore(bestBurst.volumeRatio)),
        targetPoints: this.params.targetPoints,
        stopPoints: this.params.stopPoints,
        entry_reason: `Momentum burst (${triggeredWindows.length} window${triggeredWindows.length > 1 ? 's' : ''}: ${triggeredWindows.join('s,')}s) ${bestBurst.direction}, vel=${bestBurst.absVelocity.toFixed(2)}, eff=${bestBurst.efficiency.toFixed(2)}, volR=${bestBurst.volumeRatio.toFixed(1)}x`
      }
    };

    if (debug) {
      console.log(`[MM] ${signal.side.toUpperCase()} @ ${signal.price} | windows: ${triggeredWindows.join(',')} | vel=${bestBurst.absVelocity.toFixed(3)} eff=${bestBurst.efficiency.toFixed(3)} volR=${bestBurst.volumeRatio.toFixed(1)}`);
    }

    return signal;
  }

  /**
   * Add a candle to the rolling buffer and maintain baseline volume incrementally.
   */
  _addToBuffer(candle, timestamp) {
    const entry = {
      timestamp,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume || 0
    };
    this.rollingBuffer.push(entry);
    this.baselineVolume += entry.volume;

    // Trim buffer: remove candles older than rolling buffer window
    const cutoffTs = timestamp - this.params.rollingBufferSeconds * 1000;
    while (this.bufferStartIdx < this.rollingBuffer.length && this.rollingBuffer[this.bufferStartIdx].timestamp < cutoffTs) {
      this.bufferStartIdx++;
    }

    // Advance baseline pointer
    const baselineCutoff = timestamp - this.params.baselineWindow * 1000;
    while (this.baselineStartPtr < this.rollingBuffer.length && this.rollingBuffer[this.baselineStartPtr].timestamp < baselineCutoff) {
      this.baselineVolume -= this.rollingBuffer[this.baselineStartPtr].volume;
      this.baselineStartPtr++;
    }

    // Periodically compact buffer to prevent memory growth
    if (this.bufferStartIdx > 10000) {
      const minPtr = Math.min(this.bufferStartIdx, this.baselineStartPtr);
      this.rollingBuffer.splice(0, minPtr);
      this.bufferStartIdx -= minPtr;
      this.baselineStartPtr -= minPtr;
    }
  }

  /**
   * Compute microstructure metrics for a window of 1s candles.
   */
  _computeMetrics(window, windowSize) {
    if (window.length < 3) return null;

    const first = window[0];
    const last = window[window.length - 1];
    const netMove = last.close - first.open;
    const elapsed = (last.timestamp - first.timestamp) / 1000;
    if (elapsed < windowSize * 0.5) return null;

    const velocity = netMove / Math.max(elapsed, 1);

    let totalVolume = 0;
    for (let i = 0; i < window.length; i++) totalVolume += window[i].volume;

    // Move efficiency
    let pathLength = 0;
    for (let i = 1; i < window.length; i++) {
      pathLength += Math.abs(window[i].close - window[i - 1].close);
    }
    const efficiency = pathLength > 0 ? Math.abs(netMove) / pathLength : 0;

    // Close position within window range
    let windowHigh = -Infinity, windowLow = Infinity;
    for (let i = 0; i < window.length; i++) {
      if (window[i].high > windowHigh) windowHigh = window[i].high;
      if (window[i].low < windowLow) windowLow = window[i].low;
    }
    const range = windowHigh - windowLow;
    const closePosition = range > 0 ? (last.close - windowLow) / range : 0.5;

    // Tick direction ratio
    let upTicks = 0, downTicks = 0;
    for (let i = 1; i < window.length; i++) {
      if (window[i].close > window[i - 1].close) upTicks++;
      else if (window[i].close < window[i - 1].close) downTicks++;
    }
    const totalTicks = upTicks + downTicks;
    const tickDirectionRatio = totalTicks > 0 ? upTicks / totalTicks : 0.5;

    // Volume acceleration: second half / first half
    const midIdx = Math.floor(window.length / 2);
    let firstHalfVol = 0, secondHalfVol = 0;
    for (let i = 0; i < midIdx; i++) firstHalfVol += window[i].volume;
    for (let i = midIdx; i < window.length; i++) secondHalfVol += window[i].volume;
    const volumeAcceleration = firstHalfVol > 0 ? secondHalfVol / firstHalfVol : 1;

    return {
      velocity,
      totalVolume,
      efficiency,
      closePosition,
      tickDirectionRatio,
      volumeAcceleration,
      netMove,
      range,
      windowHigh,
      windowLow,
      candleCount: window.length
    };
  }

  /**
   * Check if metrics qualify as a momentum burst event.
   */
  _checkMomentumBurst(metrics, volumeRate, baselineVolumeRate) {
    if (!metrics) return null;

    const absVelocity = Math.abs(metrics.velocity);
    if (absVelocity < this.params.velocityThreshold) return null;

    const volumeRatio = baselineVolumeRate > 0 ? volumeRate / baselineVolumeRate : 0;
    if (volumeRatio < this.params.volumeRatioThreshold) return null;

    if (metrics.efficiency < this.params.efficiencyThreshold) return null;

    const isBullish = metrics.velocity > 0;

    // Close position confirms direction
    if (isBullish && metrics.closePosition < this.params.closePositionThreshold) return null;
    if (!isBullish && metrics.closePosition > (1 - this.params.closePositionThreshold)) return null;

    // Tick direction confirms
    if (isBullish && metrics.tickDirectionRatio < this.params.tickDirectionThreshold) return null;
    if (!isBullish && metrics.tickDirectionRatio > (1 - this.params.tickDirectionThreshold)) return null;

    return {
      direction: isBullish ? 'long' : 'short',
      velocity: metrics.velocity,
      absVelocity,
      volumeRatio,
      efficiency: metrics.efficiency,
      closePosition: metrics.closePosition,
      tickDirectionRatio: metrics.tickDirectionRatio,
      volumeAcceleration: metrics.volumeAcceleration,
      netMove: metrics.netMove,
      range: metrics.range
    };
  }

  /**
   * Session detection using UTC hours (avoids locale issues in backtesting).
   * EST = UTC-5: RTH 9:30-16:00 EST = 14:30-21:00 UTC
   */
  getSession(timestamp) {
    const date = new Date(timestamp);
    const timeMin = date.getUTCHours() * 60 + date.getUTCMinutes();
    if (timeMin >= 870 && timeMin < 1260) return 'rth';        // 14:30-21:00 UTC
    if (timeMin >= 780 && timeMin < 870) return 'premarket';   // 13:00-14:30 UTC
    if (timeMin >= 1260 && timeMin < 1380) return 'afterhours'; // 21:00-23:00 UTC
    return 'overnight';
  }

  isAllowedSession(timestamp) {
    if (!this.params.useSessionFilter) return true;
    return this.params.allowedSessions.includes(this.getSession(timestamp));
  }

  reset() {
    super.reset();
    this.rollingBuffer = [];
    this.bufferStartIdx = 0;
    this.baselineVolume = 0;
    this.baselineStartPtr = 0;
    this.zTrackers = {};
    for (const ws of this.params.windowSizes) {
      this.zTrackers[ws] = {
        velocity: new WelfordTracker(),
        volumeRatio: new WelfordTracker(),
        efficiency: new WelfordTracker()
      };
    }
    this.zUpdateCounter = 0;
    this.lastEventTimestamp = 0;
  }

  getName() { return 'MOMENTUM_MICROSTRUCTURE'; }
  getDescription() { return 'Momentum Microstructure - 1s candle velocity & continuation detection'; }
  getRequiredMarketData() { return []; }
}

export default MomentumMicrostructureStrategy;
