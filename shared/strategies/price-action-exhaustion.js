/**
 * Price Action Exhaustion Strategy (Shorts Only)
 *
 * Detects 1-minute bars where intra-bar "buy absorption" (dip bought aggressively,
 * close near high) predicts SHORT continuation — the buying is exhaustion, not conviction.
 *
 * Uses 1-second candle microstructure within each 1m bar to compute 11 features and
 * a composite absorption score. High score = strong buy absorption = short signal.
 *
 * Validated over 12 months (Jan-Dec 2025):
 *   - Absorption score >= 0.70, min range >= 10pts, RTH only
 *   - pathEfficiency <= 0.38 filter (p=0.004, n=328, ~1.3/day)
 *   - Trailing stop: 10pt initial -> breakeven at 2pt profit -> trail 2pt behind
 *   - Result: 63.4% win, +3.53 pts/trade, PF 1.99
 *
 * Based on research: scripts/nq-price-action-classifier.js
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

  update(v) {
    this.n++;
    const d = v - this.mean;
    this.mean += d / this.n;
    this.M2 += d * (v - this.mean);
  }

  get stddev() {
    return this.n < 2 ? 0 : Math.sqrt(this.M2 / (this.n - 1));
  }

  zScore(v) {
    const s = this.stddev;
    return (s === 0 || this.n < 30) ? 0 : (v - this.mean) / s;
  }
}

export class PriceActionExhaustionStrategy extends BaseStrategy {
  static getDataRequirements() {
    return {
      candles: { baseSymbol: 'NQ', quoteSymbols: ['CME_MINI:NQ1!'] },
      gex: false,
      lt: false,
      secondData: true
    };
  }

  constructor(params = {}) {
    super(params);

    this.defaultParams = {
      // Absorption score threshold (0-1, higher = stronger exhaustion signal)
      scoreThreshold: 0.70,

      // Minimum 1m bar range in points
      minRange: 10,

      // Maximum path efficiency (choppy bars only — low efficiency = more exhaustion)
      maxPathEfficiency: 0.38,

      // Exit parameters
      stopLossPoints: 10,
      trailingTrigger: 2,
      trailingOffset: 2,
      maxHoldBars: 5,

      // Cooldown between signals
      signalCooldownMs: 60000,

      // Session filtering (RTH only by default)
      useSessionFilter: true,
      allowedSessions: ['rth'],

      // Entry cutoff (no new entries after 3:30 PM EST = 20:30 UTC)
      entryCutoffHour: 15,
      entryCutoffMinute: 30,

      // Symbol
      tradingSymbol: 'NQ',
      defaultQuantity: 1,

      debug: false
    };

    this.params = { ...this.defaultParams, ...params };

    // Rolling z-score trackers (persist across evaluateSignal calls)
    this.rangeTracker = new WelfordTracker();
    this.volumeTracker = new WelfordTracker();
  }

  /**
   * Evaluate a 1-minute candle for exhaustion short signal.
   *
   * @param {Object} candle - 1m candle { timestamp, open, high, low, close, volume, symbol }
   * @param {Object} prevCandle - Previous 1m candle
   * @param {Object} marketData - Must contain secondCandles (1s candles for this minute)
   * @param {Object} options - Additional options
   * @returns {Object|null} Signal or null
   */
  evaluateSignal(candle, prevCandle, marketData, options = {}) {
    const debug = options.debug || this.params.debug;
    const timestamp = typeof candle.timestamp === 'number'
      ? candle.timestamp
      : new Date(candle.timestamp).getTime();

    // Cooldown check
    if (!this.checkCooldown(timestamp, this.params.signalCooldownMs)) {
      return null;
    }

    // Session filter
    if (this.params.useSessionFilter && !this.isAllowedSession(timestamp)) {
      return null;
    }

    // Entry cutoff (no entries after 3:30 PM EST)
    if (this.isAfterEntryCutoff(timestamp)) {
      return null;
    }

    // Get 1-second candles for this minute
    const secondCandles = marketData?.secondCandles;
    if (!secondCandles || secondCandles.length < 10) {
      return null;
    }

    // Filter secondCandles to match the primary contract symbol
    const filteredSeconds = candle.symbol
      ? secondCandles.filter(s => s.symbol === candle.symbol)
      : secondCandles;

    if (filteredSeconds.length < 10) {
      return null;
    }

    // Compute microstructure features
    const features = this.computeBarFeatures(filteredSeconds);
    if (!features) return null;

    // Update rolling trackers
    this.rangeTracker.update(features.barRange);
    this.volumeTracker.update(features.totalVolume);

    const rangeZ = this.rangeTracker.zScore(features.barRange);
    const relativeVolume = this.volumeTracker.zScore(features.totalVolume);

    // Min range filter
    if (features.barRange < this.params.minRange) {
      return null;
    }

    // Compute composite absorption score
    const { score, rawScore, rangeSignificance, subScores } =
      this.computeAbsorptionScore(features, rangeZ);

    // Only short signals (positive score = buy absorption = exhaustion)
    if (score < this.params.scoreThreshold) {
      return null;
    }

    // Path efficiency filter (choppy/inefficient bars are better exhaustion signals)
    if (features.pathEfficiency > this.params.maxPathEfficiency) {
      return null;
    }

    // Build signal
    this.updateLastSignalTime(timestamp);

    const entryPrice = candle.close;
    const stopLoss = roundTo(entryPrice + this.params.stopLossPoints);

    const signal = {
      strategy: 'PRICE_ACTION_EXHAUSTION',
      side: 'sell',
      action: 'place_limit',
      symbol: this.params.tradingSymbol,
      price: roundTo(entryPrice),
      stop_loss: stopLoss,
      take_profit: this.params.takeProfitPoints
        ? roundTo(entryPrice - this.params.takeProfitPoints)
        : null,
      trailing_trigger: this.params.takeProfitPoints ? null : this.params.trailingTrigger,
      trailing_offset: this.params.takeProfitPoints ? null : this.params.trailingOffset,
      quantity: this.params.defaultQuantity,
      maxHoldBars: this.params.maxHoldBars,
      timestamp: new Date(timestamp).toISOString(),
      metadata: {
        detector: 'price_action_exhaustion',
        direction: 'short',
        score: roundTo(score, 4),
        rawScore: roundTo(rawScore, 4),
        rangeSignificance: roundTo(rangeSignificance, 2),
        subScores,
        closePosition: roundTo(features.closePosition, 4),
        pathEfficiency: roundTo(features.pathEfficiency, 4),
        lowTiming: roundTo(features.lowTiming, 4),
        highTiming: roundTo(features.highTiming, 4),
        dipSpeedAsymmetry: roundTo(features.dipSpeedAsymmetry, 4),
        dipVolumeRatio: roundTo(features.dipVolumeRatio, 4),
        ripVolumeRatio: roundTo(features.ripVolumeRatio, 4),
        vwapPosition: roundTo(features.vwapPosition, 4),
        closeVsVwap: roundTo(features.closeVsVwap, 4),
        pathChoppiness: roundTo(features.pathChoppiness, 4),
        relativeVolume: roundTo(relativeVolume, 2),
        rangeZ: roundTo(rangeZ, 2),
        barRange: roundTo(features.barRange, 2),
        secondCount: features.secondCount,
        stopLossPoints: this.params.stopLossPoints,
        entry_reason: `Exhaustion short: score=${score.toFixed(2)}, range=${features.barRange.toFixed(1)}pts, pathEff=${features.pathEfficiency.toFixed(2)}, close@${(features.closePosition * 100).toFixed(0)}%`
      }
    };

    if (debug) {
      console.log(`[PAE] SHORT @ ${signal.price} | score=${score.toFixed(3)} range=${features.barRange.toFixed(1)} pathEff=${features.pathEfficiency.toFixed(3)} close=${features.closePosition.toFixed(3)}`);
    }

    return signal;
  }

  /**
   * Compute intra-bar microstructure features from 1-second candles.
   * Identical formulas to the research script (nq-price-action-classifier.js).
   */
  computeBarFeatures(seconds) {
    if (seconds.length < 3) return null;

    const barOpen = seconds[0].open;
    const barClose = seconds[seconds.length - 1].close;
    let barHigh = -Infinity, barLow = Infinity, totalVolume = 0;

    for (const s of seconds) {
      if (s.high > barHigh) barHigh = s.high;
      if (s.low < barLow) barLow = s.low;
      totalVolume += s.volume;
    }

    const barRange = barHigh - barLow;
    if (barRange < 0.001) return null;

    // Close position within bar range (0=at low, 1=at high)
    const closePosition = (barClose - barLow) / barRange;

    // Path efficiency: net move / total path length (-1 to +1)
    const netMove = barClose - barOpen;
    let pathLength = 0;
    for (let i = 1; i < seconds.length; i++) {
      pathLength += Math.abs(seconds[i].close - seconds[i - 1].close);
    }
    const pathEfficiency = pathLength > 0 ? netMove / pathLength : 0;

    // Low/high timing (0=start, 1=end of bar)
    let lowIdx = 0, highIdx = 0, minLow = seconds[0].low, maxHigh = seconds[0].high;
    for (let i = 1; i < seconds.length; i++) {
      if (seconds[i].low < minLow) { minLow = seconds[i].low; lowIdx = i; }
      if (seconds[i].high > maxHigh) { maxHigh = seconds[i].high; highIdx = i; }
    }
    const n = seconds.length - 1;
    const lowTiming = n > 0 ? lowIdx / n : 0.5;
    const highTiming = n > 0 ? highIdx / n : 0.5;

    // Dip speed asymmetry
    const timeBefore = lowIdx;
    const timeAfter = seconds.length - 1 - lowIdx;
    const dipSpeedAsymmetry = (timeBefore + timeAfter) > 0
      ? (timeAfter - timeBefore) / (timeBefore + timeAfter) : 0;

    // Dip volume ratio (volume after low / volume before low)
    let volBeforeLow = 0, volAfterLow = 0;
    for (let i = 0; i < seconds.length; i++) {
      if (i <= lowIdx) volBeforeLow += seconds[i].volume;
      else volAfterLow += seconds[i].volume;
    }
    const dipVolumeRatio = volBeforeLow > 0 ? volAfterLow / volBeforeLow : 1;

    // Rip volume ratio (volume after high / volume before high)
    let volBeforeHigh = 0, volAfterHigh = 0;
    for (let i = 0; i < seconds.length; i++) {
      if (i <= highIdx) volBeforeHigh += seconds[i].volume;
      else volAfterHigh += seconds[i].volume;
    }
    const ripVolumeRatio = volBeforeHigh > 0 ? volAfterHigh / volBeforeHigh : 1;

    // VWAP position within bar
    let vwapNum = 0, vwapDen = 0;
    for (const s of seconds) {
      const tp = (s.high + s.low + s.close) / 3;
      vwapNum += tp * s.volume;
      vwapDen += s.volume;
    }
    const vwap = vwapDen > 0 ? vwapNum / vwapDen : (barHigh + barLow) / 2;
    const vwapPosition = (vwap - barLow) / barRange;
    const closeVsVwap = barClose - vwap;

    // Path choppiness (direction reversals / max possible)
    let reversals = 0;
    for (let i = 2; i < seconds.length; i++) {
      const prev = seconds[i - 1].close - seconds[i - 2].close;
      const curr = seconds[i].close - seconds[i - 1].close;
      if ((prev > 0 && curr < 0) || (prev < 0 && curr > 0)) reversals++;
    }
    const pathChoppiness = reversals / Math.max(seconds.length - 2, 1);

    return {
      barOpen, barClose, barHigh, barLow, barRange, totalVolume, netMove,
      closePosition, pathEfficiency, lowTiming, highTiming, dipSpeedAsymmetry,
      dipVolumeRatio, ripVolumeRatio, vwapPosition, closeVsVwap, pathChoppiness,
      secondCount: seconds.length
    };
  }

  /**
   * Compute composite absorption score.
   * Positive = buy absorption = SHORT signal strength.
   * Identical formula to the research script.
   */
  computeAbsorptionScore(features, rangeZ) {
    const closeScore = features.closePosition * 2 - 1;
    const pathScore = features.pathEfficiency;

    const lowTimingScore = 1 - 2 * features.lowTiming;
    const highTimingScore = 2 * features.highTiming - 1;
    const timingScore = (lowTimingScore + highTimingScore) / 2;

    const vwapScore = features.vwapPosition * 2 - 1;

    const dipVolSignal = Math.min(Math.max((features.dipVolumeRatio - 1) / 2, -1), 1);
    const ripVolSignal = Math.min(Math.max((features.ripVolumeRatio - 1) / 2, -1), 1);
    const volumeScore = Math.min(Math.max(dipVolSignal - ripVolSignal, -1), 1);

    const rawScore = 0.30 * closeScore + 0.20 * pathScore + 0.20 * timingScore
                   + 0.15 * vwapScore + 0.15 * volumeScore;

    const rangeSignificance = rangeZ <= -2 ? 0.2
                            : rangeZ <= -1 ? 0.5
                            : rangeZ <= 0  ? 0.8
                            : 1.0;

    const score = Math.min(Math.max(rawScore * rangeSignificance, -1), 1);

    return {
      score,
      rawScore,
      rangeSignificance,
      subScores: {
        close: +closeScore.toFixed(4),
        path: +pathScore.toFixed(4),
        timing: +timingScore.toFixed(4),
        vwap: +vwapScore.toFixed(4),
        volume: +volumeScore.toFixed(4)
      }
    };
  }

  /**
   * Session detection using UTC hours.
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

  /**
   * Check if timestamp is after entry cutoff (3:30 PM EST = 20:30 UTC).
   */
  isAfterEntryCutoff(timestamp) {
    const date = new Date(timestamp);
    const utcHour = date.getUTCHours();
    const utcMin = date.getUTCMinutes();
    // 3:30 PM EST = 20:30 UTC
    const cutoffHour = this.params.entryCutoffHour + 5; // EST to UTC
    const cutoffMin = this.params.entryCutoffMinute;
    const currentMinutes = utcHour * 60 + utcMin;
    const cutoffMinutes = cutoffHour * 60 + cutoffMin;
    return currentMinutes >= cutoffMinutes;
  }

  reset() {
    super.reset();
    this.rangeTracker = new WelfordTracker();
    this.volumeTracker = new WelfordTracker();
  }

  getName() { return 'PRICE_ACTION_EXHAUSTION'; }
  getDescription() { return 'Price Action Exhaustion - 1s microstructure buy-absorption short signals'; }
  getRequiredMarketData() { return []; }
}

export default PriceActionExhaustionStrategy;
