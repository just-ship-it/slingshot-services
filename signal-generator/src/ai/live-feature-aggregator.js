/**
 * Live Feature Aggregator
 *
 * Same public interface as the backtest FeatureAggregator, but backed by live
 * in-memory buffers instead of CSV files.  Imports prompt-builder, session-utils,
 * and market-structure directly from the backtest-engine (no copies).
 */

import { createLogger } from '../../../shared/index.js';
import { CandleAggregator } from '../../../shared/utils/candle-aggregator.js';
import { MarketStructureAnalyzer } from '../../../shared/indicators/market-structure.js';
import {
  isRTH, getSessionInfo, getRTHOpenTime, getRTHCloseTime,
  getOvernightStartTime, formatET, formatETDateTime, toET, etToUTC,
  getMorningSessionEnd, getAfternoonSessionStart,
} from '../../../backtest-engine/src/ai/session-utils.js';

const logger = createLogger('live-feature-aggregator');

export class LiveFeatureAggregator {
  /**
   * @param {Object} opts
   * @param {Object} opts.candle1mBuffer   - CandleBuffer for 1m candles
   * @param {Object} opts.candle1hBuffer   - CandleBuffer for 1h candles
   * @param {Object} [opts.candle1dBuffer] - CandleBuffer for 1D candles (primary source for PD High/Low)
   * @param {Object} opts.gexCalculator    - Live GEX calculator instance
   * @param {Object} [opts.ltMonitor]      - LT monitor instance (null for v1)
   * @param {Object} [opts.ivCalculator]   - IV calculator instance (null if unavailable)
   * @param {string} [opts.ticker='NQ']    - Ticker symbol
   */
  constructor({ candle1mBuffer, candle1hBuffer, candle1dBuffer, gexCalculator, ltMonitor, ivCalculator, ticker = 'NQ' }) {
    this.candle1mBuffer = candle1mBuffer;
    this.candle1hBuffer = candle1hBuffer;
    this.candle1dBuffer = candle1dBuffer || null;
    this.gexCalculator = gexCalculator;
    this.ltMonitor = ltMonitor;
    this.ivCalculator = ivCalculator;
    this.ticker = ticker.toUpperCase();

    this.aggregator = new CandleAggregator();

    // Rolling buffer of LT snapshots (for migration analysis)
    // Stores { datetime, timestamp, sentiment, level_1..level_5 } objects
    this.ltSnapshotBuffer = [];
    this.maxLtSnapshots = 20; // ~5 hours at 15-min intervals

    // LS (Liquidity Status) sentiment from TradingView indicator
    // Binary: 'BULLISH' or 'BEARISH' — matches backtest CSV sentiment field
    this.currentLsSentiment = null;

    // Swing analyzers (same config as backtest)
    this._swingStructureAnalyzer = new MarketStructureAnalyzer({
      swingLookback: 3,
      minSwingSize: 10,
      fibLevels: [0.5, 0.705, 0.79],
    });
    this._htfSwingAnalyzer = new MarketStructureAnalyzer({
      swingLookback: 9,
      minSwingSize: 50,
      fibLevels: [0.5, 0.705, 0.79],
    });

    // Caches
    this._priorDayHLCCache = {};
    this._overnightRangeCache = {};
    this._htfSwingCache = null;
    this._htfSwingCacheKey = null;

    this.dataReady = false;
  }

  // ── LT Snapshot Management ─────────────────────────────────

  /**
   * Push a new LT snapshot into the rolling buffer.
   * Called from the AI strategy engine when lt_levels events arrive.
   * @param {Object} ltLevels - Raw LT levels from monitor { L0..L6, timestamp, candleTime }
   */
  pushLtSnapshot(ltLevels) {
    if (!ltLevels) return;

    // Normalize to backtest format: { datetime, timestamp, sentiment, level_1..level_5 }
    const snapshot = {
      datetime: ltLevels.candleTime || new Date().toISOString(),
      timestamp: ltLevels.timestamp
        ? (typeof ltLevels.timestamp === 'number' ? ltLevels.timestamp * 1000 : new Date(ltLevels.timestamp).getTime())
        : Date.now(),
      sentiment: this._deriveSentiment(ltLevels),
      level_1: ltLevels.L2 ?? ltLevels.level_1 ?? null,
      level_2: ltLevels.L3 ?? ltLevels.level_2 ?? null,
      level_3: ltLevels.L4 ?? ltLevels.level_3 ?? null,
      level_4: ltLevels.L5 ?? ltLevels.level_4 ?? null,
      level_5: ltLevels.L6 ?? ltLevels.level_5 ?? null,
    };

    this.ltSnapshotBuffer.push(snapshot);
    if (this.ltSnapshotBuffer.length > this.maxLtSnapshots) {
      this.ltSnapshotBuffer.shift();
    }
  }

  /**
   * Set the current LS (Liquidity Status) sentiment.
   * Called when ls.status events arrive from data-service.
   * @param {string} sentiment - 'BULLISH' or 'BEARISH'
   */
  setLsSentiment(sentiment) {
    if (sentiment && (sentiment === 'BULLISH' || sentiment === 'BEARISH')) {
      this.currentLsSentiment = sentiment;
    }
  }

  /**
   * Derive sentiment from LT level configuration.
   * Same logic as backtest: if more levels are below price → bullish, above → bearish.
   */
  _deriveSentiment(ltLevels) {
    // If monitor provides sentiment already, use it
    if (ltLevels.sentiment) return ltLevels.sentiment;

    // Otherwise derive from level positions relative to a reference
    const levels = [ltLevels.L2, ltLevels.L3, ltLevels.L4, ltLevels.L5, ltLevels.L6]
      .filter(l => l != null && l !== 0);

    if (levels.length === 0) return 'UNKNOWN';

    // Use the median level as reference — if most levels are clustered below
    // the highest level, it suggests bullish configuration
    const sorted = [...levels].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const avg = levels.reduce((a, b) => a + b, 0) / levels.length;

    return avg > median ? 'BULLISH' : 'BEARISH';
  }

  // ── Data Access Methods ────────────────────────────────────

  /**
   * Get 1m candles within a time range from the live buffer.
   */
  _getCandlesInRange(startTs, endTs) {
    const candles = this.candle1mBuffer.getCandles();
    const result = [];
    for (const c of candles) {
      const ts = typeof c.timestamp === 'number' ? c.timestamp : new Date(c.timestamp).getTime();
      if (ts >= startTs && ts <= endTs) {
        result.push({ ...c, timestamp: ts });
      }
    }
    return result;
  }

  /**
   * Get current GEX levels, normalized to backtest snake_case format.
   */
  _getGexAtTime() {
    const gex = this.gexCalculator?.getCurrentLevels();
    if (!gex) return null;

    return {
      gamma_flip: gex.gammaFlip ?? gex.gamma_flip ?? null,
      call_wall: gex.callWall ?? gex.call_wall ?? null,
      put_wall: gex.putWall ?? gex.put_wall ?? null,
      support: gex.support || [],
      resistance: gex.resistance || [],
      regime: gex.regime || 'unknown',
      total_gex: gex.totalGex ?? gex.total_gex ?? null,
    };
  }

  /**
   * Get LT snapshot nearest to a timestamp from the rolling buffer.
   */
  _getLTLevelsAtTime(timestamp) {
    if (this.ltSnapshotBuffer.length === 0) return null;

    let best = null;
    let bestDist = Infinity;
    for (const snap of this.ltSnapshotBuffer) {
      const dist = Math.abs(snap.timestamp - timestamp);
      if (dist < bestDist) {
        bestDist = dist;
        best = snap;
      }
    }
    return best;
  }

  /**
   * Get IV data (if available).
   */
  _getIVAtTime() {
    if (!this.ivCalculator) return null;
    return this.ivCalculator.getCurrentIVSkew?.() || null;
  }

  // ── Prior Daily Candles ────────────────────────────────────

  /**
   * Get prior daily candles for context.
   * Primary: use TradingView 1D candles (correct 6 PM ET session boundaries).
   * Fallback: aggregate from 1h candle buffer.
   */
  _getPriorDailyCandles(tradingDayStr, count = 5) {
    // Primary: use daily candles from TradingView (correct 6 PM ET session boundaries)
    if (this.candle1dBuffer) {
      const dailyCandles = this.candle1dBuffer.getCandles();
      if (dailyCandles.length > 0) {
        const prior = dailyCandles
          .map(c => ({
            ...c,
            timestamp: typeof c.timestamp === 'number' ? c.timestamp : new Date(c.timestamp).getTime()
          }))
          .filter(c => {
            // TradingView daily candle timestamps are the session open (6 PM ET).
            // Extract the trading day date in ET to compare against tradingDayStr.
            const et = toET(c.timestamp);
            // Session open at 6 PM ET belongs to the *next* trading day
            // (e.g., 6 PM ET on Mon = Tuesday's trading day)
            // Add 6 hours to push into the trading day's calendar date
            const tradingDayDate = new Date(c.timestamp + 6 * 60 * 60 * 1000);
            const dayStr = tradingDayDate.toISOString().slice(0, 10);
            return dayStr !== tradingDayStr;
          })
          .sort((a, b) => b.timestamp - a.timestamp)
          .slice(0, count)
          .reverse();

        if (prior.length > 0) {
          logger.debug(`_getPriorDailyCandles: using ${prior.length} 1D candles from TradingView`);
          return prior;
        }
      }
    }

    // Fallback: aggregate from 1h candles
    const candles1h = this.candle1hBuffer.getCandles();
    if (candles1h.length === 0) return [];

    // Normalize timestamps to numbers
    const normalized = candles1h.map(c => ({
      ...c,
      timestamp: typeof c.timestamp === 'number' ? c.timestamp : new Date(c.timestamp).getTime()
    }));

    // Build daily candles using 6 PM ET session boundaries (futures trading day)
    // Each trading day runs from 6 PM ET (prior calendar day) to 4 PM ET (trading day)
    const dailyCandles = [];
    let day = tradingDayStr;

    for (let i = 0; i < count; i++) {
      day = this._getPriorTradingDay(day);
      const sessionStart = getOvernightStartTime(day);  // 6 PM ET prior calendar day
      const sessionEnd = getRTHCloseTime(day);           // 4 PM ET on trading day

      const sessionCandles = normalized
        .filter(c => c.timestamp >= sessionStart && c.timestamp <= sessionEnd)
        .sort((a, b) => a.timestamp - b.timestamp);

      if (sessionCandles.length > 0) {
        const high = Math.max(...sessionCandles.map(c => c.high));
        const low = Math.min(...sessionCandles.map(c => c.low));
        const close = sessionCandles[sessionCandles.length - 1].close;
        dailyCandles.unshift({
          timestamp: sessionStart,
          open: sessionCandles[0].open,
          high,
          low,
          close,
          volume: sessionCandles.reduce((s, c) => s + (c.volume || 0), 0),
          candleCount: sessionCandles.length,
          tradingDay: day,
        });
      }
    }

    if (dailyCandles.length > 0) {
      logger.debug(`_getPriorDailyCandles: using ${dailyCandles.length} daily candles aggregated from 1h`);
    }

    return dailyCandles;
  }

  /**
   * Get the prior trading day (skips weekends).
   */
  _getPriorTradingDay(dateStr) {
    const d = new Date(dateStr + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() - 1);
    const dayOfWeek = d.getUTCDay();
    if (dayOfWeek === 0) d.setUTCDate(d.getUTCDate() - 2); // Sunday → Friday
    else if (dayOfWeek === 6) d.setUTCDate(d.getUTCDate() - 1); // Saturday → Friday
    return d.toISOString().slice(0, 10);
  }

  /**
   * Get prior day's high, low, close. Cached per trading day.
   */
  _getPriorDayHLC(tradingDayStr) {
    if (this._priorDayHLCCache[tradingDayStr]) {
      return this._priorDayHLCCache[tradingDayStr];
    }
    const priorDaily = this._getPriorDailyCandles(tradingDayStr, 1);
    if (priorDaily.length === 0) return null;
    const pd = priorDaily[priorDaily.length - 1];
    const result = { high: pd.high, low: pd.low, close: pd.close };
    this._priorDayHLCCache[tradingDayStr] = result;
    return result;
  }

  // ── GEX Level Helpers ──────────────────────────────────────

  _getAllGexLevels(gex) {
    const levels = [];
    const gf = gex.gamma_flip || gex.nq_gamma_flip;
    const cw = gex.call_wall || gex.nq_call_wall_1;
    const pw = gex.put_wall || gex.nq_put_wall_1;

    if (gf) levels.push({ price: gf, type: 'gex', label: 'Gamma Flip' });
    if (cw) levels.push({ price: cw, type: 'gex', label: 'Call Wall' });
    if (pw) levels.push({ price: pw, type: 'gex', label: 'Put Wall' });

    const support = gex.support || [];
    const resistance = gex.resistance || [];
    support.forEach((s, i) => { if (s) levels.push({ price: s, type: 'gex', label: `S${i + 1}` }); });
    resistance.forEach((r, i) => { if (r) levels.push({ price: r, type: 'gex', label: `R${i + 1}` }); });

    return levels;
  }

  // ── Phase 1: Pre-market Bias State ─────────────────────────

  /**
   * Build pre-market state for bias formation (same output as backtest).
   */
  getPreMarketState(tradingDay) {
    const rthOpen = getRTHOpenTime(tradingDay);
    const overnightStart = getOvernightStartTime(tradingDay);

    // Prior daily candles from hourly buffer
    const priorDailyCandles = this._getPriorDailyCandles(tradingDay, 10);

    // Overnight range from 1m buffer
    const overnightCandles = this._getCandlesInRange(overnightStart, rthOpen - 1);
    let overnightRange = null;
    if (overnightCandles.length > 0) {
      const oHigh = Math.max(...overnightCandles.map(c => c.high));
      const oLow = Math.min(...overnightCandles.map(c => c.low));
      const oOpen = overnightCandles[0].open;
      const oClose = overnightCandles[overnightCandles.length - 1].close;
      overnightRange = {
        open: oOpen, high: oHigh, low: oLow, close: oClose,
        range: oHigh - oLow,
        direction: oClose > oOpen ? 'up' : oClose < oOpen ? 'down' : 'flat',
        candleCount: overnightCandles.length,
      };
    }

    // GEX at open (live — always most recent)
    const gexRaw = this._getGexAtTime();
    const gexState = gexRaw ? {
      regime: gexRaw.regime,
      gammaFlip: gexRaw.gamma_flip,
      callWall: gexRaw.call_wall,
      putWall: gexRaw.put_wall,
      support: gexRaw.support,
      resistance: gexRaw.resistance,
      totalGex: gexRaw.total_gex,
    } : null;

    // IV
    const ivRaw = this._getIVAtTime();
    const ivState = ivRaw ? {
      iv: ivRaw.iv,
      skew: ivRaw.skew,
      callIV: ivRaw.callIV,
      putIV: ivRaw.putIV,
      dte: ivRaw.dte,
    } : null;

    // LT levels (most recent snapshot)
    const ltRaw = this._getLTLevelsAtTime(Date.now());
    const ltState = ltRaw ? {
      sentiment: ltRaw.sentiment,
      levels: [ltRaw.level_1, ltRaw.level_2, ltRaw.level_3, ltRaw.level_4, ltRaw.level_5].filter(l => l != null),
    } : null;

    // Prior day HLC
    const priorDayHLC = this._getPriorDayHLC(tradingDay);

    // Current spot price from most recent 1m candle
    const latestCandles = this.candle1mBuffer.getCandles(1);
    const currentSpotPrice = latestCandles.length > 0
      ? (latestCandles[0].close ?? latestCandles[0].c ?? null)
      : null;

    return {
      tradingDay,
      timestamp: rthOpen,
      priorDailyCandles,
      overnightRange,
      gex: gexState,
      iv: ivState,
      vix: null, // Skip VIX for v1
      lt: ltState,
      ls: this.currentLsSentiment ? { sentiment: this.currentLsSentiment } : null,
      priorDayHLC,
      currentSpotPrice,
    };
  }

  // ── Phase 2: Real-time Entry State ─────────────────────────

  /**
   * Get session context (RTH open, high, low, range, position).
   */
  _getSessionContext(tradingDay, currentTimestamp, currentPrice) {
    const rthOpen = getRTHOpenTime(tradingDay);
    if (currentTimestamp < rthOpen) return null;

    const rthCandles = this._getCandlesInRange(rthOpen, currentTimestamp);
    if (rthCandles.length === 0) return null;

    const rthOpenPrice = rthCandles[0].open;
    const rthHigh = Math.max(...rthCandles.map(c => c.high));
    const rthLow = Math.min(...rthCandles.map(c => c.low));
    const rthRange = rthHigh - rthLow;
    const positionInRange = rthRange > 0 ? (currentPrice - rthLow) / rthRange : 0.5;

    const priorDaily = this._getPriorDailyCandles(tradingDay, 5);
    let avgDailyRange = 0;
    if (priorDaily.length > 0) {
      const ranges = priorDaily.map(c => c.high - c.low);
      avgDailyRange = ranges.reduce((a, b) => a + b, 0) / ranges.length;
    }
    const rangeRatio = avgDailyRange > 0 ? rthRange / avgDailyRange : 0;

    return {
      rthOpen: Math.round(rthOpenPrice * 100) / 100,
      rthHigh: Math.round(rthHigh * 100) / 100,
      rthLow: Math.round(rthLow * 100) / 100,
      rthRange: Math.round(rthRange * 100) / 100,
      distFromOpen: Math.round((currentPrice - rthOpenPrice) * 100) / 100,
      distFromHigh: Math.round((currentPrice - rthHigh) * 100) / 100,
      distFromLow: Math.round((currentPrice - rthLow) * 100) / 100,
      positionInRange: Math.round(positionInRange * 100) / 100,
      avgDailyRange: Math.round(avgDailyRange * 100) / 100,
      rangeRatio: Math.round(rangeRatio * 100) / 100,
    };
  }

  /**
   * Get recent momentum over a lookback window.
   */
  _getRecentMomentum(timestamp, recentCandles, lookbackMinutes = 15) {
    if (!recentCandles || recentCandles.length === 0) return null;

    const cutoff = timestamp - lookbackMinutes * 60 * 1000;
    const windowCandles = recentCandles.filter(c => {
      const ts = typeof c.timestamp === 'number' ? c.timestamp : new Date(c.timestamp).getTime();
      return ts >= cutoff;
    });
    if (windowCandles.length === 0) return null;

    const firstClose = windowCandles[0].open;
    const lastClose = windowCandles[windowCandles.length - 1].close;
    const priceDelta = lastClose - firstClose;
    const rangeCovered = Math.max(...windowCandles.map(c => c.high)) - Math.min(...windowCandles.map(c => c.low));

    const absDelta = Math.abs(priceDelta);
    let direction;
    if (absDelta > 80) direction = priceDelta > 0 ? 'strong_up' : 'strong_down';
    else if (absDelta > 30) direction = priceDelta > 0 ? 'up' : 'down';
    else direction = 'flat';

    return {
      priceDelta: Math.round(priceDelta * 100) / 100,
      rangeCovered: Math.round(rangeCovered * 100) / 100,
      direction,
      barsCount: windowCandles.length,
    };
  }

  /**
   * Compute basic price action context.
   */
  _computePriceAction(current, recentCandles) {
    if (recentCandles.length < 3) {
      return { trend: 'unknown', swingHigh: null, swingLow: null, avgVolume: 0, range: 0 };
    }

    const closes = recentCandles.map(c => c.close);
    const highs = recentCandles.map(c => c.high);
    const lows = recentCandles.map(c => c.low);
    const volumes = recentCandles.map(c => c.volume);

    const third = Math.max(1, Math.floor(closes.length / 3));
    const earlyAvg = closes.slice(0, third).reduce((a, b) => a + b, 0) / third;
    const lateAvg = closes.slice(-third).reduce((a, b) => a + b, 0) / third;
    const trendDiff = lateAvg - earlyAvg;
    const trend = trendDiff > 5 ? 'bullish' : trendDiff < -5 ? 'bearish' : 'choppy';

    const swingHigh = Math.max(...highs);
    const swingLow = Math.min(...lows);
    const avgVolume = Math.round(volumes.reduce((a, b) => a + b, 0) / volumes.length);
    const currentVolumeRatio = current.volume / Math.max(1, avgVolume);

    return {
      trend,
      swingHigh,
      swingLow,
      range: swingHigh - swingLow,
      avgVolume,
      currentVolumeRatio: Math.round(currentVolumeRatio * 100) / 100,
      priceFromSwingHigh: current.close - swingHigh,
      priceFromSwingLow: current.close - swingLow,
    };
  }

  /**
   * Get swing structure from 5m candles.
   */
  _getSwingStructure(timestamp, lookbackCandles = 100) {
    const lookbackMs = lookbackCandles * 5 * 60 * 1000;
    const candles1m = this._getCandlesInRange(timestamp - lookbackMs, timestamp);
    if (candles1m.length < 30) return null;

    const candles5m = this.aggregator.aggregate(candles1m, '5m');
    if (candles5m.length < 7) return null;

    const swings = this._swingStructureAnalyzer.identifySwings(candles5m);
    if (swings.highs.length === 0 && swings.lows.length === 0) return null;

    const recentHigh = swings.highs[swings.highs.length - 1];
    const recentLow = swings.lows[swings.lows.length - 1];
    if (!recentHigh || !recentLow) return null;

    const swingHigh = recentHigh.price;
    const swingLow = recentLow.price;
    const swingRange = swingHigh - swingLow;
    if (swingRange < 10) return null;

    const fibRatios = [0.5, 0.705, 0.79];
    const fibLevels = fibRatios.map(ratio => ({
      price: Math.round((swingHigh - swingRange * ratio) * 100) / 100,
      ratio,
      label: `Fib ${(ratio * 100).toFixed(1)}%`,
    }));

    return { swingHigh, swingLow, swingRange, fibLevels };
  }

  /**
   * Get HTF (1h) swing structure directly from the hourly candle buffer.
   */
  _getHTFSwingStructure(timestamp) {
    const ONE_HOUR_MS = 60 * 60 * 1000;
    const hourBoundary = Math.floor(timestamp / ONE_HOUR_MS) * ONE_HOUR_MS;

    if (this._htfSwingCacheKey === hourBoundary && this._htfSwingCache) {
      return this._htfSwingCache;
    }

    // Use 1h candle buffer directly
    const candles1h = this.candle1hBuffer.getCandles();
    const normalized = candles1h.map(c => ({
      ...c,
      timestamp: typeof c.timestamp === 'number' ? c.timestamp : new Date(c.timestamp).getTime()
    }));

    const minCandles = this._htfSwingAnalyzer.params.swingLookback * 2 + 1;
    if (normalized.length < minCandles) {
      this._htfSwingCacheKey = hourBoundary;
      this._htfSwingCache = null;
      return null;
    }

    const swings = this._htfSwingAnalyzer.identifySwings(normalized);
    if (swings.highs.length === 0 && swings.lows.length === 0) {
      this._htfSwingCacheKey = hourBoundary;
      this._htfSwingCache = null;
      return null;
    }

    const recentHigh = swings.highs[swings.highs.length - 1];
    const recentLow = swings.lows[swings.lows.length - 1];
    if (!recentHigh || !recentLow) {
      this._htfSwingCacheKey = hourBoundary;
      this._htfSwingCache = null;
      return null;
    }

    const swingHigh = recentHigh.price;
    const swingLow = recentLow.price;
    const swingRange = swingHigh - swingLow;
    if (swingRange < 50) {
      this._htfSwingCacheKey = hourBoundary;
      this._htfSwingCache = null;
      return null;
    }

    const fibRatios = [0.5, 0.705, 0.79];
    const fibLevels = fibRatios.map(ratio => ({
      price: Math.round((swingHigh - swingRange * ratio) * 100) / 100,
      ratio,
      label: `HTF Fib ${(ratio * 100).toFixed(1)}%`,
    }));

    const result = { swingHigh, swingLow, swingRange, fibLevels, timeframe: '1h' };
    this._htfSwingCacheKey = hourBoundary;
    this._htfSwingCache = result;
    return result;
  }

  /**
   * Get overnight high/low for a trading day.
   */
  _getOvernightRange(tradingDay) {
    if (this._overnightRangeCache[tradingDay]) return this._overnightRangeCache[tradingDay];
    const rthOpen = getRTHOpenTime(tradingDay);
    const overnightStart = getOvernightStartTime(tradingDay);
    const overnightCandles = this._getCandlesInRange(overnightStart, rthOpen - 1);
    if (overnightCandles.length === 0) {
      this._overnightRangeCache[tradingDay] = null;
      return null;
    }
    const result = {
      high: Math.max(...overnightCandles.map(c => c.high)),
      low: Math.min(...overnightCandles.map(c => c.low)),
    };
    this._overnightRangeCache[tradingDay] = result;
    return result;
  }

  /**
   * Get 4h high/low (most recently completed 4h candle).
   */
  _get4hHighLow(timestamp) {
    const et = toET(timestamp);

    // 4h blocks anchored at 6 PM ET: 18, 22, 2, 6, 10, 14
    // Shift so 18:00 ET = hour 0, making blocks at offsets 0, 4, 8, 12, 16, 20
    const shiftedHour = ((et.hour - 18) + 24) % 24;
    const currentBlockStartHourET = (Math.floor(shiftedHour / 4) * 4 + 18) % 24;

    // If block start hour > current hour, the block started on the prior calendar day
    let blockYear = et.year, blockMonth = et.month, blockDay = et.day;
    if (currentBlockStartHourET > et.hour) {
      const d = new Date(Date.UTC(et.year, et.month - 1, et.day - 1, 12));
      const prev = toET(d.getTime());
      blockYear = prev.year;
      blockMonth = prev.month;
      blockDay = prev.day;
    }

    const currentBlockStartMs = etToUTC(blockYear, blockMonth, blockDay, currentBlockStartHourET, 0);

    // Prior completed 4h block
    const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
    const priorBlockStartMs = currentBlockStartMs - FOUR_HOURS_MS;
    const priorBlockEndMs = currentBlockStartMs - 1;

    const candles = this._getCandlesInRange(priorBlockStartMs, priorBlockEndMs);
    if (candles.length === 0) return null;

    return {
      high: Math.max(...candles.map(c => c.high)),
      low: Math.min(...candles.map(c => c.low)),
    };
  }

  /**
   * Build consolidated structural levels map (same as backtest).
   */
  getStructuralLevels(timestamp, currentPrice, tradingDay) {
    const levels = [];

    // GEX levels
    const gex = this._getGexAtTime();
    if (gex) {
      for (const l of this._getAllGexLevels(gex)) {
        levels.push({
          price: l.price,
          label: l.label,
          type: l.label.match(/^[SR]\d/) ? (l.label.startsWith('S') ? 'gex_support' : 'gex_resistance') : 'gex',
        });
      }
    }

    // Prior day H/L/C
    if (tradingDay) {
      const pdHLC = this._getPriorDayHLC(tradingDay);
      if (pdHLC) {
        levels.push({ price: pdHLC.high, label: 'PD High', type: 'prior_day' });
        levels.push({ price: pdHLC.low, label: 'PD Low', type: 'prior_day' });
        levels.push({ price: pdHLC.close, label: 'PD Close', type: 'prior_day' });
      }
    }

    // 4h H/L
    const fourH = this._get4hHighLow(timestamp);
    if (fourH) {
      levels.push({ price: fourH.high, label: '4h High', type: '4h' });
      levels.push({ price: fourH.low, label: '4h Low', type: '4h' });
    }

    // Overnight H/L
    if (tradingDay) {
      const overnight = this._getOvernightRange(tradingDay);
      if (overnight) {
        levels.push({ price: overnight.high, label: 'ON High', type: 'overnight' });
        levels.push({ price: overnight.low, label: 'ON Low', type: 'overnight' });
      }
    }

    // Fib retracement levels
    const swingStructure = this._getSwingStructure(timestamp);
    if (swingStructure) {
      for (const fib of swingStructure.fibLevels) {
        levels.push({ price: fib.price, label: fib.label, type: 'fib_retracement' });
      }
    }

    // HTF fib levels
    const htfSwing = this._getHTFSwingStructure(timestamp);
    if (htfSwing) {
      for (const fib of htfSwing.fibLevels) {
        levels.push({ price: fib.price, label: fib.label, type: 'htf_fib_retracement' });
      }
    }

    // LT confluence annotation
    const ltSnapshot = this._getLTLevelsAtTime(timestamp);
    const ltPrices = [];
    if (ltSnapshot) {
      for (const key of ['level_1', 'level_2', 'level_3', 'level_4', 'level_5']) {
        if (ltSnapshot[key] != null) ltPrices.push(ltSnapshot[key]);
      }
    }

    // Deduplicate within 2 points
    const deduped = [];
    const sorted = levels.filter(l => l.price != null && !isNaN(l.price)).sort((a, b) => a.price - b.price);
    for (const level of sorted) {
      const existing = deduped.find(d => Math.abs(d.price - level.price) <= 2);
      if (existing) {
        if (!existing.label.includes(level.label)) {
          existing.label += ` / ${level.label}`;
        }
      } else {
        deduped.push({ ...level });
      }
    }

    return deduped.map(level => {
      const distance = Math.round((level.price - currentPrice) * 100) / 100;
      const ltConfluence = ltPrices.some(lp => Math.abs(lp - level.price) <= 10);
      return {
        ...level,
        distance,
        aboveBelow: distance >= 0 ? 'above' : 'below',
        ltConfluence,
      };
    }).sort((a, b) => b.price - a.price);
  }

  /**
   * Check if price is near any key level (gating function for LLM calls).
   */
  isNearKeyLevel(timestamp, price, threshold = 30, tradingDay = null) {
    const allLevels = [];

    const gex = this._getGexAtTime();
    if (gex) {
      for (const l of this._getAllGexLevels(gex)) {
        allLevels.push(l);
      }
    }

    if (tradingDay) {
      const pdHLC = this._getPriorDayHLC(tradingDay);
      if (pdHLC) {
        allLevels.push({ price: pdHLC.high, type: 'prior_day', label: 'PD High' });
        allLevels.push({ price: pdHLC.low, type: 'prior_day', label: 'PD Low' });
        allLevels.push({ price: pdHLC.close, type: 'prior_day', label: 'PD Close' });
      }
    }

    const fourH = this._get4hHighLow(timestamp);
    if (fourH) {
      allLevels.push({ price: fourH.high, type: '4h', label: '4h High' });
      allLevels.push({ price: fourH.low, type: '4h', label: '4h Low' });
    }

    if (allLevels.length === 0) return { near: false, levels: [] };

    const nearLevels = allLevels
      .map(l => ({ ...l, distance: Math.abs(price - l.price) }))
      .filter(l => l.distance <= threshold)
      .sort((a, b) => a.distance - b.distance);

    return {
      near: nearLevels.length > 0,
      nearest: nearLevels[0] || null,
      levels: nearLevels,
    };
  }

  /**
   * Build real-time state for entry evaluation (same output as backtest).
   */
  getRealTimeState(timestamp, currentCandle, recentCandles, tradingDay = null) {
    const gexRaw = this._getGexAtTime();
    let gexState = null;
    if (gexRaw) {
      const price = currentCandle.close;
      const allLevels = this._getAllGexLevels(gexRaw);
      gexState = {
        regime: gexRaw.regime,
        totalGex: gexRaw.total_gex,
        gammaFlip: gexRaw.gamma_flip,
        callWall: gexRaw.call_wall,
        putWall: gexRaw.put_wall,
        support: gexRaw.support,
        resistance: gexRaw.resistance,
        nearestLevels: allLevels
          .map(l => ({ ...l, distance: price - l.price }))
          .sort((a, b) => Math.abs(a.distance) - Math.abs(b.distance))
          .slice(0, 5),
      };
    }

    const ivNow = this._getIVAtTime();
    const ltNow = this._getLTLevelsAtTime(timestamp);
    let ltState = null;
    if (ltNow) {
      const price = currentCandle.close;
      const ltLevelValues = [ltNow.level_1, ltNow.level_2, ltNow.level_3, ltNow.level_4, ltNow.level_5].filter(l => l != null);
      ltState = {
        sentiment: ltNow.sentiment,
        levels: ltLevelValues.map((lv, i) => ({
          level: i + 1,
          price: lv,
          distance: price - lv,
          fibLookback: [34, 55, 144, 377, 610][i],
        })),
      };
    }

    const priceAction = this._computePriceAction(currentCandle, recentCandles);
    const swingStructure = this._getSwingStructure(timestamp);
    const htfSwingStructure = this._getHTFSwingStructure(timestamp);
    let structuralLevels = null;
    if (tradingDay) {
      structuralLevels = this.getStructuralLevels(timestamp, currentCandle.close, tradingDay);
    }

    let sessionContext = null;
    let recentMomentum = null;
    if (tradingDay) {
      sessionContext = this._getSessionContext(tradingDay, timestamp, currentCandle.close);
      recentMomentum = this._getRecentMomentum(timestamp, recentCandles);
    }

    return {
      timestamp,
      time: formatET(timestamp),
      session: getSessionInfo(timestamp).session,
      currentCandle: {
        open: currentCandle.open,
        high: currentCandle.high,
        low: currentCandle.low,
        close: currentCandle.close,
        volume: currentCandle.volume,
      },
      recentCandles: recentCandles.slice(-10).map(c => ({
        time: formatET(typeof c.timestamp === 'number' ? c.timestamp : new Date(c.timestamp).getTime()),
        open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
      })),
      gex: gexState,
      iv: ivNow ? { iv: ivNow.iv, skew: ivNow.skew, callIV: ivNow.callIV, putIV: ivNow.putIV } : null,
      lt: ltState,
      ls: this.currentLsSentiment ? { sentiment: this.currentLsSentiment } : null,
      priceAction,
      structuralLevels,
      swingRange: swingStructure ? { high: swingStructure.swingHigh, low: swingStructure.swingLow, range: swingStructure.swingRange } : null,
      htfSwingStructure,
      sessionContext,
      recentMomentum,
    };
  }

  // ── RTH Candles ────────────────────────────────────────────

  getRTHCandles(tradingDay) {
    const rthOpen = getRTHOpenTime(tradingDay);
    const rthClose = getRTHCloseTime(tradingDay);
    return this._getCandlesInRange(rthOpen, rthClose);
  }

  aggregateCandles(candles, timeframe) {
    return this.aggregator.aggregate(candles, timeframe);
  }

  // ── Window Summary (for reassessment) ─────────────────────

  getWindowSummary(tradingDay, fromTimestamp, toTimestamp) {
    const windowCandles = this._getCandlesInRange(fromTimestamp, toTimestamp);
    let ohlcvSummary = null;
    if (windowCandles.length > 0) {
      const wOpen = windowCandles[0].open;
      const wClose = windowCandles[windowCandles.length - 1].close;
      const wHigh = Math.max(...windowCandles.map(c => c.high));
      const wLow = Math.min(...windowCandles.map(c => c.low));
      const totalVolume = windowCandles.reduce((s, c) => s + c.volume, 0);
      ohlcvSummary = {
        open: wOpen, high: wHigh, low: wLow, close: wClose,
        range: wHigh - wLow,
        direction: wClose > wOpen ? 'up' : wClose < wOpen ? 'down' : 'flat',
        changePts: wClose - wOpen,
        totalVolume,
        avgVolumePerCandle: Math.round(totalVolume / windowCandles.length),
        candleCount: windowCandles.length,
      };
    }

    // GEX comparison: live GEX is always current, so start == end for live
    const gexNow = this._getGexAtTime();
    let gexComparison = null;
    if (gexNow) {
      gexComparison = {
        startRegime: gexNow.regime,
        endRegime: gexNow.regime,
        regimeChanged: false,
        endGammaFlip: gexNow.gamma_flip,
        endCallWall: gexNow.call_wall,
        endPutWall: gexNow.put_wall,
      };
    }

    // IV
    const ivNow = this._getIVAtTime();
    let ivComparison = null;
    if (ivNow) {
      ivComparison = {
        startIV: ivNow.iv, endIV: ivNow.iv, ivChange: 0,
        startSkew: ivNow.skew, endSkew: ivNow.skew, skewChange: 0,
        trend: 'stable',
      };
    }

    // LT migration
    const ltMigration = this._computeLTMigration(tradingDay, fromTimestamp, toTimestamp);

    return {
      tradingDay,
      fromTime: formatET(fromTimestamp),
      toTime: formatET(toTimestamp),
      ohlcv: ohlcvSummary,
      gex: gexComparison,
      iv: ivComparison,
      ltMigration,
      lsSentiment: this.currentLsSentiment,
      levelInteractions: null, // Simplified for live — could add later
    };
  }

  /**
   * Compute LT level migration over a time window (same logic as backtest).
   */
  _computeLTMigration(tradingDay, fromTimestamp, toTimestamp) {
    const ltStart = this._getLTLevelsAtTime(fromTimestamp);
    const ltEnd = this._getLTLevelsAtTime(toTimestamp);
    if (!ltStart || !ltEnd) return null;

    // Get price at boundaries from 1m candles
    const startCandles = this._getCandlesInRange(fromTimestamp, fromTimestamp + 60000);
    const endCandles = this._getCandlesInRange(toTimestamp - 60000, toTimestamp);
    if (startCandles.length === 0 || endCandles.length === 0) return null;

    const priceStart = startCandles[0].close;
    const priceEnd = endCandles[endCandles.length - 1].close;
    const priceDirection = priceEnd > priceStart ? 'rising' : priceEnd < priceStart ? 'falling' : 'flat';

    const fibLookbacks = [34, 55, 144, 377, 610];
    const startLevels = [ltStart.level_1, ltStart.level_2, ltStart.level_3, ltStart.level_4, ltStart.level_5];
    const endLevels = [ltEnd.level_1, ltEnd.level_2, ltEnd.level_3, ltEnd.level_4, ltEnd.level_5];

    const levels = [];
    let weightedScore = 0;
    let totalWeight = 0;

    for (let i = 0; i < 5; i++) {
      if (startLevels[i] == null || endLevels[i] == null) continue;

      const delta = endLevels[i] - startLevels[i];
      const startRelative = priceStart - startLevels[i];
      const endRelative = priceEnd - endLevels[i];
      const crossedPrice = (startRelative > 0 && endRelative < 0) || (startRelative < 0 && endRelative > 0);
      const distStart = Math.abs(startRelative);
      const distEnd = Math.abs(endRelative);
      const direction = distEnd < distStart ? 'toward_price' : distEnd > distStart ? 'away_from_price' : 'stable';

      // Direction-aware scoring: account for whether level is above/below price
      const levelAbovePrice = endLevels[i] > priceEnd;
      const relativeToPrice = levelAbovePrice ? 'above' : 'below';

      let levelScore = 0;
      let crossingDirection = null;
      if (crossedPrice) {
        // Price rose through level (was below, now above) = bullish
        // Price fell through level (was above, now below) = bearish
        if (startRelative < 0 && endRelative > 0) {
          levelScore = 2;  // bullish crossing
          crossingDirection = 'bullish';
        } else {
          levelScore = -2; // bearish crossing
          crossingDirection = 'bearish';
        }
      } else {
        // Non-crossing: score depends on level position relative to price
        if (!levelAbovePrice) {
          // Level below price (support)
          // Moving toward price = support strengthening = bullish
          // Moving away = support eroding = bearish
          levelScore = direction === 'toward_price' ? 1 : direction === 'away_from_price' ? -1 : 0;
        } else {
          // Level above price (resistance)
          // Moving away from price = resistance retreating = bullish
          // Moving toward price = resistance approaching = bearish
          levelScore = direction === 'away_from_price' ? 1 : direction === 'toward_price' ? -1 : 0;
        }
      }

      weightedScore += levelScore;
      totalWeight += 1;

      levels.push({
        fib: fibLookbacks[i],
        startPrice: startLevels[i],
        endPrice: endLevels[i],
        delta: Math.round(delta * 100) / 100,
        direction,
        crossedPrice,
        crossingDirection,
        relativeToPrice,
        levelScore,
      });
    }

    const normalizedScore = totalWeight > 0 ? weightedScore / totalWeight : 0;
    let overallSignal;
    if (normalizedScore > 0.3) overallSignal = 'improving';
    else if (normalizedScore < -0.3) overallSignal = 'deteriorating';
    else overallSignal = 'stable';

    const shortTermLevels = levels.filter(l => l.fib <= 55);
    const longTermLevels = levels.filter(l => l.fib >= 377);
    const shortTermImproving = shortTermLevels.filter(l => l.levelScore > 0).length >
                               shortTermLevels.filter(l => l.levelScore < 0).length;
    const longTermImproving = longTermLevels.filter(l => l.levelScore > 0).length >
                              longTermLevels.filter(l => l.levelScore < 0).length;

    const levelsAbovePrice = levels.filter(l => l.relativeToPrice === 'above').length;
    const levelsBelowPrice = levels.filter(l => l.relativeToPrice === 'below').length;

    return {
      priceStart, priceEnd, priceDirection,
      priceDelta: Math.round((priceEnd - priceStart) * 100) / 100,
      levels,
      overallSignal,
      normalizedScore: Math.round(normalizedScore * 100) / 100,
      shortTermTrend: shortTermImproving ? 'improving' : shortTermLevels.length > 0 ? 'deteriorating' : 'unknown',
      longTermTrend: longTermImproving ? 'improving' : longTermLevels.length > 0 ? 'deteriorating' : 'unknown',
      levelsAbovePrice,
      levelsBelowPrice,
    };
  }

  /**
   * Mark data as ready (called after history is loaded).
   */
  setDataReady(ready = true) {
    this.dataReady = ready;
    if (ready) {
      const dailyCount = this.candle1dBuffer ? this.candle1dBuffer.getCandles().length : 0;
      logger.info(`LiveFeatureAggregator data ready: ${this.candle1mBuffer.getCandles().length} 1m candles, ${this.candle1hBuffer.getCandles().length} 1h candles, ${dailyCount} 1D candles, ${this.ltSnapshotBuffer.length} LT snapshots`);
    }
  }
}
