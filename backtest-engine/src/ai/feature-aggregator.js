/**
 * Feature Aggregator - Assembles market state snapshots from all available data sources.
 * Used by the AI trader to build structured context for LLM prompts.
 */

import fs from 'fs';
import path from 'path';
import { CSVLoader } from '../data/csv-loader.js';
import { GexLoader } from '../data-loaders/gex-loader.js';
import { IVLoader } from '../data-loaders/iv-loader.js';
import { CandleAggregator } from '../../../shared/utils/candle-aggregator.js';
import {
  isRTH, getSessionInfo, getRTHOpenTime, getRTHCloseTime,
  getOvernightStartTime, formatET, formatETDateTime, toET,
  getMorningSessionEnd, getAfternoonSessionStart,
} from './session-utils.js';
import { MarketStructureAnalyzer } from '../../../shared/indicators/market-structure.js';

const DEFAULT_CONFIG = {
  dataFormat: {
    ohlcv: {
      timestampField: 'ts_event',
      symbolField: 'symbol',
      openField: 'open',
      highField: 'high',
      lowField: 'low',
      closeField: 'close',
      volumeField: 'volume',
    },
    gex: {
      dateField: 'date',
      putWallFields: ['nq_put_wall_1', 'nq_put_wall_2', 'nq_put_wall_3'],
      callWallFields: ['nq_call_wall_1', 'nq_call_wall_2', 'nq_call_wall_3'],
      gammaFlipField: 'nq_gamma_flip',
      regimeField: 'regime',
      totalGexField: 'total_gex',
    },
    liquidity: {
      timestampField: 'datetime',
      sentimentField: 'sentiment',
      levelFields: ['level_1', 'level_2', 'level_3', 'level_4', 'level_5'],
    },
  },
};

export class FeatureAggregator {
  constructor({ dataDir, ticker = 'NQ' }) {
    this.dataDir = dataDir;
    this.ticker = ticker.toUpperCase();
    this.tickerLower = ticker.toLowerCase();

    // noContinuous: true — we need absolute prices to compare against GEX/LT levels
    this.csvLoader = new CSVLoader(dataDir, DEFAULT_CONFIG, { noContinuous: true });
    this.gexLoader = new GexLoader(
      path.join(dataDir, 'gex', this.tickerLower),
      this.tickerLower
    );
    this.ivLoader = new IVLoader(dataDir);
    this.aggregator = new CandleAggregator();

    // Loaded data
    this.candles1m = null;
    this.ltLevels = null;
    this.vixDaily = null;
    this.dataLoaded = false;

    // Caches
    this._priorDayHLCCache = {};
    this._overnightRangeCache = {};
    this._swingStructureAnalyzer = new MarketStructureAnalyzer({
      swingLookback: 3,    // 3 candles on 5m = 15min confirmation
      minSwingSize: 10,
      fibLevels: [0.5, 0.705, 0.79],
    });
    this._htfSwingAnalyzer = new MarketStructureAnalyzer({
      swingLookback: 9,    // 9 bars on 1h = 9 hours each side to confirm swing
      minSwingSize: 50,    // Only meaningful multi-day swings
      fibLevels: [0.5, 0.705, 0.79],
    });
    this._htfSwingCache = {};
    this._htfSwingCacheKey = null;
  }

  /**
   * Load all data sources into memory for the given date range.
   * Gracefully handles missing data sources.
   */
  async loadData(startDate, endDate) {
    const errors = [];
    // CSVLoader and GexLoader expect Date objects
    const startDateObj = new Date(startDate + 'T00:00:00Z');
    const endDateObj = new Date(endDate + 'T23:59:59Z');

    // Load OHLCV 1m candles
    try {
      const result = await this.csvLoader.loadOHLCVData(this.ticker, startDateObj, endDateObj);
      this.candles1m = this.csvLoader.filterPrimaryContract(result.candles);
      // Sort by timestamp
      this.candles1m.sort((a, b) => a.timestamp - b.timestamp);
      console.log(`  OHLCV: ${this.candles1m.length.toLocaleString()} 1m candles loaded`);
    } catch (e) {
      errors.push(`OHLCV: ${e.message}`);
      this.candles1m = [];
    }

    // Load GEX intraday levels
    try {
      const loaded = await this.gexLoader.loadDateRange(startDateObj, endDateObj);
      if (loaded) {
        const range = this.gexLoader.getDataRange();
        console.log(`  GEX: ${range.totalRecords.toLocaleString()} snapshots loaded`);
      } else {
        errors.push('GEX: No data found for date range');
      }
    } catch (e) {
      errors.push(`GEX: ${e.message}`);
    }

    // Load IV/skew
    try {
      const ivData = await this.ivLoader.load(startDateObj, endDateObj);
      if (ivData.length > 0) {
        console.log(`  IV: ${ivData.length.toLocaleString()} records loaded`);
      } else {
        errors.push('IV: No data for date range');
      }
    } catch (e) {
      errors.push(`IV: ${e.message}`);
    }

    // Load LT levels
    try {
      this.ltLevels = await this.csvLoader.loadLiquidityData(this.ticker, startDateObj, endDateObj);
      if (this.ltLevels.length > 0) {
        console.log(`  LT: ${this.ltLevels.length.toLocaleString()} level snapshots loaded`);
      } else {
        errors.push('LT: No data for date range');
      }
    } catch (e) {
      errors.push(`LT: ${e.message}`);
      this.ltLevels = [];
    }

    // Load VIX daily
    try {
      this.vixDaily = this._loadVixDaily();
      if (this.vixDaily.length > 0) {
        console.log(`  VIX: ${this.vixDaily.length.toLocaleString()} daily records loaded`);
      } else {
        errors.push('VIX: No data found');
      }
    } catch (e) {
      errors.push(`VIX: ${e.message}`);
      this.vixDaily = [];
    }

    if (errors.length > 0) {
      console.log(`  Warnings: ${errors.join('; ')}`);
    }

    this.dataLoaded = true;
    return { errors };
  }

  /**
   * Load VIX daily CSV (CBOE format: DATE,OPEN,HIGH,LOW,CLOSE).
   */
  _loadVixDaily() {
    const vixPath = path.join(this.dataDir, 'iv', 'vix', 'VIX_History.csv');
    if (!fs.existsSync(vixPath)) return [];

    const content = fs.readFileSync(vixPath, 'utf-8');
    const lines = content.trim().split('\n');
    const records = [];

    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(',');
      if (parts.length < 5) continue;

      // Parse MM/DD/YYYY
      const dateParts = parts[0].trim().split('/');
      if (dateParts.length !== 3) continue;
      const [month, day, year] = dateParts;
      const dateStr = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
      const timestamp = new Date(dateStr + 'T12:00:00Z').getTime();

      records.push({
        date: dateStr,
        timestamp,
        open: parseFloat(parts[1]),
        high: parseFloat(parts[2]),
        low: parseFloat(parts[3]),
        close: parseFloat(parts[4]),
      });
    }

    records.sort((a, b) => a.timestamp - b.timestamp);
    return records;
  }

  /**
   * Get VIX level for a date (or most recent prior date).
   */
  _getVixForDate(dateStr) {
    if (!this.vixDaily || this.vixDaily.length === 0) return null;
    const targetTs = new Date(dateStr + 'T12:00:00Z').getTime();

    // Binary search for closest prior date
    let lo = 0, hi = this.vixDaily.length - 1;
    let best = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.vixDaily[mid].timestamp <= targetTs) {
        best = this.vixDaily[mid];
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return best;
  }

  /**
   * Get recent VIX trend (last N days).
   */
  _getVixTrend(dateStr, lookback = 5) {
    if (!this.vixDaily || this.vixDaily.length === 0) return null;
    const targetTs = new Date(dateStr + 'T12:00:00Z').getTime();

    // Find index of target date
    let idx = -1;
    for (let i = this.vixDaily.length - 1; i >= 0; i--) {
      if (this.vixDaily[i].timestamp <= targetTs) {
        idx = i;
        break;
      }
    }
    if (idx < 0) return null;

    const startIdx = Math.max(0, idx - lookback + 1);
    const recent = this.vixDaily.slice(startIdx, idx + 1);
    if (recent.length < 2) return null;

    const first = recent[0].close;
    const last = recent[recent.length - 1].close;
    const change = last - first;
    const changePct = (change / first) * 100;

    return {
      current: last,
      priorClose: recent.length > 1 ? recent[recent.length - 2].close : null,
      change5d: change,
      changePct5d: changePct,
      high5d: Math.max(...recent.map(r => r.high)),
      low5d: Math.min(...recent.map(r => r.low)),
      trend: changePct > 10 ? 'elevated_sharply' : changePct > 3 ? 'rising' : changePct < -10 ? 'declining_sharply' : changePct < -3 ? 'falling' : 'stable',
    };
  }

  /**
   * Get LT levels at or before a timestamp.
   */
  _getLTLevelsAtTime(timestamp) {
    if (!this.ltLevels || this.ltLevels.length === 0) return null;

    let best = null;
    for (let i = this.ltLevels.length - 1; i >= 0; i--) {
      if (this.ltLevels[i].timestamp <= timestamp) {
        best = this.ltLevels[i];
        break;
      }
    }
    return best;
  }

  /**
   * Get candles within a time range from the 1m data.
   */
  _getCandlesInRange(startTs, endTs) {
    if (!this.candles1m) return [];
    // Binary search for start
    let lo = 0, hi = this.candles1m.length - 1;
    let startIdx = this.candles1m.length;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.candles1m[mid].timestamp >= startTs) {
        startIdx = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }

    const result = [];
    for (let i = startIdx; i < this.candles1m.length; i++) {
      if (this.candles1m[i].timestamp > endTs) break;
      result.push(this.candles1m[i]);
    }
    return result;
  }

  /**
   * Aggregate daily candles from 1m data for the prior N trading days.
   */
  _getPriorDailyCandles(tradingDayStr, count = 5) {
    const targetDate = new Date(tradingDayStr + 'T12:00:00Z');
    // Go back enough calendar days to find N trading days
    const lookbackMs = (count + 5) * 24 * 60 * 60 * 1000;
    const startTs = targetDate.getTime() - lookbackMs;
    const endTs = getRTHCloseTime(tradingDayStr);

    const candles = this._getCandlesInRange(startTs, endTs);
    if (candles.length === 0) return [];

    const dailyCandles = this.aggregator.aggregate(candles, '1d');
    // Only return up to count, excluding current day
    const currentDayStr = tradingDayStr;
    const priorDays = dailyCandles.filter(c => {
      const d = new Date(c.timestamp);
      return d.toISOString().slice(0, 10) !== currentDayStr;
    });

    return priorDays.slice(-count);
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

  /**
   * Phase 1: Build pre-market state for bias formation.
   * Called before RTH open on the trading day.
   */
  getPreMarketState(tradingDay) {
    if (!this.dataLoaded) throw new Error('Call loadData() first');

    const rthOpen = getRTHOpenTime(tradingDay);
    const overnightStart = getOvernightStartTime(tradingDay);

    // Prior daily candles (5-10 days)
    const priorDailyCandles = this._getPriorDailyCandles(tradingDay, 10);

    // Overnight range
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

    // GEX at open
    const gexAtOpen = this.gexLoader.getGexLevels(new Date(rthOpen));

    // IV at open
    const ivAtOpen = this.ivLoader.getIVAtTime(rthOpen);

    // VIX
    const vixTrend = this._getVixTrend(tradingDay);

    // LT levels
    const ltAtOpen = this._getLTLevelsAtTime(rthOpen);

    // Prior day HLC
    const priorDayHLC = this._getPriorDayHLC(tradingDay);

    return {
      tradingDay,
      timestamp: rthOpen,
      priorDailyCandles,
      overnightRange,
      gex: gexAtOpen ? {
        regime: gexAtOpen.regime,
        gammaFlip: gexAtOpen.gamma_flip || gexAtOpen.nq_gamma_flip,
        callWall: gexAtOpen.call_wall || gexAtOpen.nq_call_wall_1,
        putWall: gexAtOpen.put_wall || gexAtOpen.nq_put_wall_1,
        support: gexAtOpen.support || [],
        resistance: gexAtOpen.resistance || [],
        totalGex: gexAtOpen.total_gex,
      } : null,
      iv: ivAtOpen ? {
        iv: ivAtOpen.iv,
        skew: ivAtOpen.skew,
        callIV: ivAtOpen.callIV,
        putIV: ivAtOpen.putIV,
        dte: ivAtOpen.dte,
      } : null,
      vix: vixTrend,
      lt: ltAtOpen ? {
        sentiment: ltAtOpen.sentiment,
        levels: [ltAtOpen.level_1, ltAtOpen.level_2, ltAtOpen.level_3, ltAtOpen.level_4, ltAtOpen.level_5].filter(l => l != null),
      } : null,
      priorDayHLC,
    };
  }

  /**
   * Compute RTH session context: open, high, low, range, position in range, avg daily range.
   */
  _getSessionContext(tradingDay, currentTimestamp, currentPrice) {
    const rthOpen = getRTHOpenTime(tradingDay);

    // If before RTH open, no session context
    if (currentTimestamp < rthOpen) return null;

    // Get all RTH 1m candles from open to current timestamp
    const rthCandles = this._getCandlesInRange(rthOpen, currentTimestamp);
    if (rthCandles.length === 0) return null;

    const rthOpenPrice = rthCandles[0].open;
    const rthHigh = Math.max(...rthCandles.map(c => c.high));
    const rthLow = Math.min(...rthCandles.map(c => c.low));
    const rthRange = rthHigh - rthLow;

    // Position in range: 0 = at low, 1 = at high
    const positionInRange = rthRange > 0 ? (currentPrice - rthLow) / rthRange : 0.5;

    // Average daily range from prior 5 days
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
   * Compute recent momentum: price delta, range covered, and direction over a lookback window.
   */
  _getRecentMomentum(timestamp, recentCandles, lookbackMinutes = 15) {
    if (!recentCandles || recentCandles.length === 0) return null;

    // Filter to candles within the lookback window
    const cutoff = timestamp - lookbackMinutes * 60 * 1000;
    const windowCandles = recentCandles.filter(c => c.timestamp >= cutoff);
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
   * Phase 2: Build real-time state for entry evaluation.
   * Called when price is near a key level during RTH.
   */
  getRealTimeState(timestamp, currentCandle, recentCandles, tradingDay = null) {
    if (!this.dataLoaded) throw new Error('Call loadData() first');

    // GEX at current time
    const gexNow = this.gexLoader.getGexLevels(new Date(timestamp));
    let gexState = null;
    if (gexNow) {
      const price = currentCandle.close;
      const allLevels = this._getAllGexLevels(gexNow);
      gexState = {
        regime: gexNow.regime,
        totalGex: gexNow.total_gex,
        gammaFlip: gexNow.gamma_flip || gexNow.nq_gamma_flip,
        callWall: gexNow.call_wall || gexNow.nq_call_wall_1,
        putWall: gexNow.put_wall || gexNow.nq_put_wall_1,
        support: gexNow.support || [],
        resistance: gexNow.resistance || [],
        nearestLevels: allLevels
          .map(l => ({ ...l, distance: price - l.price }))
          .sort((a, b) => Math.abs(a.distance) - Math.abs(b.distance))
          .slice(0, 5),
      };
    }

    // IV at current time
    const ivNow = this.ivLoader.getIVAtTime(timestamp);

    // LT at current time
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

    // Price action context from recent candles
    const priceAction = this._computePriceAction(currentCandle, recentCandles);

    // Structural levels map
    let structuralLevels = null;
    const swingStructure = this._getSwingStructure(timestamp);
    const htfSwingStructure = this._getHTFSwingStructure(timestamp);
    if (tradingDay) {
      structuralLevels = this.getStructuralLevels(timestamp, currentCandle.close, tradingDay);
    }

    // Session context and recent momentum
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
        time: formatET(c.timestamp),
        open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
      })),
      gex: gexState,
      iv: ivNow ? { iv: ivNow.iv, skew: ivNow.skew, callIV: ivNow.callIV, putIV: ivNow.putIV } : null,
      lt: ltState,
      priceAction,
      structuralLevels,
      swingRange: swingStructure ? { high: swingStructure.swingHigh, low: swingStructure.swingLow, range: swingStructure.swingRange } : null,
      htfSwingStructure,
      sessionContext,
      recentMomentum,
    };
  }

  /**
   * Check if price is near any fixed structural level.
   * Uses GEX levels, prior day H/L/C, and 4h candle H/L — NOT LT levels (which move intraday).
   * This is the gating function — only call LLM when true.
   */
  isNearKeyLevel(timestamp, price, threshold = 30, tradingDay = null) {
    const allLevels = [];

    // GEX levels (update every 15m but levels themselves are structural)
    const gex = this.gexLoader.getGexLevels(new Date(timestamp));
    if (gex) {
      for (const l of this._getAllGexLevels(gex)) {
        allLevels.push(l);
      }
    }

    // Prior day high/low/close
    if (tradingDay) {
      const pdHLC = this._getPriorDayHLC(tradingDay);
      if (pdHLC) {
        allLevels.push({ price: pdHLC.high, type: 'prior_day', label: 'PD High' });
        allLevels.push({ price: pdHLC.low, type: 'prior_day', label: 'PD Low' });
        allLevels.push({ price: pdHLC.close, type: 'prior_day', label: 'PD Close' });
      }
    }

    // 4h candle high/low (most recently completed 4h candle)
    const fourHourLevels = this._get4hHighLow(timestamp);
    if (fourHourLevels) {
      allLevels.push({ price: fourHourLevels.high, type: '4h', label: '4h High' });
      allLevels.push({ price: fourHourLevels.low, type: '4h', label: '4h Low' });
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
   * Get high/low of the most recently completed 4h candle.
   * Cached per 4h boundary to avoid recomputing on every call.
   */
  _get4hHighLow(timestamp) {
    // 4h boundaries align to 0:00, 4:00, 8:00, 12:00, 16:00, 20:00 UTC
    const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
    const currentBoundary = Math.floor(timestamp / FOUR_HOURS_MS) * FOUR_HOURS_MS;
    const priorBoundaryStart = currentBoundary - FOUR_HOURS_MS;
    const priorBoundaryEnd = currentBoundary - 1;

    // Check cache
    if (this._4hCache && this._4hCacheKey === priorBoundaryStart) {
      return this._4hCache;
    }

    const candles = this._getCandlesInRange(priorBoundaryStart, priorBoundaryEnd);
    if (candles.length === 0) return null;

    const result = {
      high: Math.max(...candles.map(c => c.high)),
      low: Math.min(...candles.map(c => c.low)),
    };

    this._4hCache = result;
    this._4hCacheKey = priorBoundaryStart;
    return result;
  }

  /**
   * Extract all GEX levels into a flat array with labels.
   */
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
    support.forEach((s, i) => {
      if (s) levels.push({ price: s, type: 'gex', label: `S${i + 1}` });
    });
    resistance.forEach((r, i) => {
      if (r) levels.push({ price: r, type: 'gex', label: `R${i + 1}` });
    });

    return levels;
  }

  /**
   * Compute basic price action context from recent candles.
   */
  _computePriceAction(current, recentCandles) {
    if (recentCandles.length < 3) {
      return { trend: 'unknown', swingHigh: null, swingLow: null, avgVolume: 0, range: 0 };
    }

    const closes = recentCandles.map(c => c.close);
    const highs = recentCandles.map(c => c.high);
    const lows = recentCandles.map(c => c.low);
    const volumes = recentCandles.map(c => c.volume);

    // Simple trend: compare first third vs last third of closes
    const third = Math.max(1, Math.floor(closes.length / 3));
    const earlyAvg = closes.slice(0, third).reduce((a, b) => a + b, 0) / third;
    const lateAvg = closes.slice(-third).reduce((a, b) => a + b, 0) / third;
    const trendDiff = lateAvg - earlyAvg;
    const trend = trendDiff > 5 ? 'bullish' : trendDiff < -5 ? 'bearish' : 'choppy';

    // Swing high/low in the window
    const swingHigh = Math.max(...highs);
    const swingLow = Math.min(...lows);

    // Volume
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
   * Get all 1m candles for a trading day's RTH session.
   */
  getRTHCandles(tradingDay) {
    const rthOpen = getRTHOpenTime(tradingDay);
    const rthClose = getRTHCloseTime(tradingDay);
    return this._getCandlesInRange(rthOpen, rthClose);
  }

  /**
   * Get all 1m candles for the full trading day (overnight + RTH).
   */
  getAllDayCandles(tradingDay) {
    const start = getOvernightStartTime(tradingDay);
    const end = getRTHCloseTime(tradingDay);
    return this._getCandlesInRange(start, end);
  }

  /**
   * Aggregate candles to a target timeframe.
   */
  aggregateCandles(candles, timeframe) {
    return this.aggregator.aggregate(candles, timeframe);
  }

  /**
   * Forward-scan 1m candles from an entry to determine if stop or target hit first.
   * Returns trade outcome.
   */
  simulateOutcome(entryTimestamp, entryPrice, stopLoss, takeProfit, side, maxBars = 120) {
    // Find starting index
    let startIdx = -1;
    for (let i = 0; i < this.candles1m.length; i++) {
      if (this.candles1m[i].timestamp > entryTimestamp) {
        startIdx = i;
        break;
      }
    }
    if (startIdx < 0) return { outcome: 'no_data', bars: 0, pnl: 0 };

    const isLong = side === 'buy';

    for (let i = startIdx; i < Math.min(startIdx + maxBars, this.candles1m.length); i++) {
      const candle = this.candles1m[i];
      const barsHeld = i - startIdx + 1;

      if (isLong) {
        // Check stop first (assumes worst case)
        if (candle.low <= stopLoss) {
          return {
            outcome: 'stop',
            exitPrice: stopLoss,
            pnl: stopLoss - entryPrice,
            bars: barsHeld,
            exitTime: formatET(candle.timestamp),
          };
        }
        if (candle.high >= takeProfit) {
          return {
            outcome: 'target',
            exitPrice: takeProfit,
            pnl: takeProfit - entryPrice,
            bars: barsHeld,
            exitTime: formatET(candle.timestamp),
          };
        }
      } else {
        // Short
        if (candle.high >= stopLoss) {
          return {
            outcome: 'stop',
            exitPrice: stopLoss,
            pnl: entryPrice - stopLoss,
            bars: barsHeld,
            exitTime: formatET(candle.timestamp),
          };
        }
        if (candle.low <= takeProfit) {
          return {
            outcome: 'target',
            exitPrice: takeProfit,
            pnl: entryPrice - takeProfit,
            bars: barsHeld,
            exitTime: formatET(candle.timestamp),
          };
        }
      }
    }

    // Max bars reached — mark to market
    const lastCandle = this.candles1m[Math.min(startIdx + maxBars - 1, this.candles1m.length - 1)];
    const mtmPnl = isLong ? lastCandle.close - entryPrice : entryPrice - lastCandle.close;
    return {
      outcome: 'timeout',
      exitPrice: lastCandle.close,
      pnl: mtmPnl,
      bars: maxBars,
      exitTime: formatET(lastCandle.timestamp),
    };
  }

  /**
   * Get overnight high/low for a trading day. Cached per day.
   */
  _getOvernightRange(tradingDay) {
    if (this._overnightRangeCache[tradingDay]) {
      return this._overnightRangeCache[tradingDay];
    }
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
   * Get swing structure and fib retracement levels from recent candles.
   * Uses 5m candles with lookback of ~100 candles for intraday swing detection.
   */
  _getSwingStructure(timestamp, lookbackCandles = 100) {
    // Get ~500 1m candles (enough to produce ~100 5m candles)
    const lookbackMs = lookbackCandles * 5 * 60 * 1000;
    const candles1m = this._getCandlesInRange(timestamp - lookbackMs, timestamp);
    if (candles1m.length < 30) return null;

    // Aggregate to 5m for swing detection
    const candles5m = this.aggregator.aggregate(candles1m, '5m');
    if (candles5m.length < 7) return null; // need at least swingLookback*2+1

    const swings = this._swingStructureAnalyzer.identifySwings(candles5m);
    if (swings.highs.length === 0 && swings.lows.length === 0) return null;

    // Get most recent swing high and low
    const recentHigh = swings.highs.length > 0 ? swings.highs[swings.highs.length - 1] : null;
    const recentLow = swings.lows.length > 0 ? swings.lows[swings.lows.length - 1] : null;

    if (!recentHigh || !recentLow) return null;

    const swingHigh = recentHigh.price;
    const swingLow = recentLow.price;
    const swingRange = swingHigh - swingLow;
    if (swingRange < 10) return null; // too small for meaningful fibs

    // Calculate fib retracement levels
    const fibRatios = [0.5, 0.705, 0.79];
    const fibLevels = fibRatios.map(ratio => ({
      price: Math.round((swingHigh - swingRange * ratio) * 100) / 100,
      ratio,
      label: `Fib ${(ratio * 100).toFixed(1)}%`,
    }));

    return {
      swingHigh,
      swingLow,
      swingRange,
      fibLevels,
    };
  }

  /**
   * Get higher-timeframe (1h) swing structure with fib retracement levels.
   * Dynamically sizes lookback to ensure enough 1h candles for swing detection,
   * accounting for weekend gaps. Cached per 1h boundary.
   */
  _getHTFSwingStructure(timestamp) {
    // Cache per 1h boundary
    const ONE_HOUR_MS = 60 * 60 * 1000;
    const hourBoundary = Math.floor(timestamp / ONE_HOUR_MS) * ONE_HOUR_MS;

    if (this._htfSwingCacheKey === hourBoundary && this._htfSwingCache) {
      return this._htfSwingCache;
    }

    // We need enough 1h candles so swings aren't trapped at the edges.
    // swingLookback=9 means a swing can only be detected at indices [9, len-10].
    // Target: swingLookback * 6 hourly candles → swings detectable across
    // the middle ~67% of the window. Use trading-hour math: target N hourly
    // candles ÷ ~23 trading hours/day = trading days needed, then add buffer
    // for weekends (2 days per 5 trading days). Cap at 14 calendar days.
    const targetHourlyCandles = this._htfSwingAnalyzer.params.swingLookback * 6;
    const tradingDaysNeeded = Math.ceil(targetHourlyCandles / 23);
    const calendarDays = Math.min(Math.ceil(tradingDaysNeeded * 7 / 5) + 1, 14);
    const lookbackMs = calendarDays * 24 * 60 * 60 * 1000;
    const candles1m = this._getCandlesInRange(timestamp - lookbackMs, timestamp);
    if (candles1m.length < 60) {
      this._htfSwingCacheKey = hourBoundary;
      this._htfSwingCache = null;
      return null;
    }

    // Aggregate to 1h
    const candles1h = this.aggregator.aggregate(candles1m, '1h');
    const minCandles = this._htfSwingAnalyzer.params.swingLookback * 2 + 1;
    if (candles1h.length < minCandles) {
      this._htfSwingCacheKey = hourBoundary;
      this._htfSwingCache = null;
      return null;
    }

    const swings = this._htfSwingAnalyzer.identifySwings(candles1h);
    if (swings.highs.length === 0 && swings.lows.length === 0) {
      this._htfSwingCacheKey = hourBoundary;
      this._htfSwingCache = null;
      return null;
    }

    const recentHigh = swings.highs.length > 0 ? swings.highs[swings.highs.length - 1] : null;
    const recentLow = swings.lows.length > 0 ? swings.lows[swings.lows.length - 1] : null;

    if (!recentHigh || !recentLow) {
      this._htfSwingCacheKey = hourBoundary;
      this._htfSwingCache = null;
      return null;
    }

    const swingHigh = recentHigh.price;
    const swingLow = recentLow.price;
    const swingRange = swingHigh - swingLow;
    if (swingRange < 50) { // minSwingSize check
      this._htfSwingCacheKey = hourBoundary;
      this._htfSwingCache = null;
      return null;
    }

    // Calculate fib retracement levels
    const fibRatios = [0.5, 0.705, 0.79];
    const fibLevels = fibRatios.map(ratio => ({
      price: Math.round((swingHigh - swingRange * ratio) * 100) / 100,
      ratio,
      label: `HTF Fib ${(ratio * 100).toFixed(1)}%`,
    }));

    const result = {
      swingHigh,
      swingLow,
      swingRange,
      fibLevels,
      timeframe: '1h',
    };

    this._htfSwingCacheKey = hourBoundary;
    this._htfSwingCache = result;
    return result;
  }

  /**
   * Build a consolidated, sorted map of all structural levels visible at a given time.
   * Includes GEX, prior day H/L/C, 4h H/L, overnight H/L, fib retracements, and LT confluence.
   */
  getStructuralLevels(timestamp, currentPrice, tradingDay) {
    const levels = [];

    // GEX levels
    const gex = this.gexLoader.getGexLevels(new Date(timestamp));
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

    // Fib retracement levels from swing structure
    const swingStructure = this._getSwingStructure(timestamp);
    if (swingStructure) {
      for (const fib of swingStructure.fibLevels) {
        levels.push({ price: fib.price, label: fib.label, type: 'fib_retracement' });
      }
    }

    // HTF fib retracement levels from 1h swing structure
    const htfSwingStructure = this._getHTFSwingStructure(timestamp);
    if (htfSwingStructure) {
      for (const fib of htfSwingStructure.fibLevels) {
        levels.push({ price: fib.price, label: fib.label, type: 'htf_fib_retracement' });
      }
    }

    // Get LT levels for confluence annotation
    const ltSnapshot = this._getLTLevelsAtTime(timestamp);
    const ltPrices = [];
    if (ltSnapshot) {
      for (const key of ['level_1', 'level_2', 'level_3', 'level_4', 'level_5']) {
        if (ltSnapshot[key] != null) ltPrices.push(ltSnapshot[key]);
      }
    }

    // Deduplicate levels within 2 points
    const deduped = [];
    const sorted = levels.filter(l => l.price != null && !isNaN(l.price)).sort((a, b) => a.price - b.price);
    for (const level of sorted) {
      const existing = deduped.find(d => Math.abs(d.price - level.price) <= 2);
      if (existing) {
        // Merge labels if different types
        if (!existing.label.includes(level.label)) {
          existing.label += ` / ${level.label}`;
        }
      } else {
        deduped.push({ ...level });
      }
    }

    // Annotate each level
    return deduped.map(level => {
      const distance = Math.round((level.price - currentPrice) * 100) / 100;
      const ltConfluence = ltPrices.some(lp => Math.abs(lp - level.price) <= 10);
      return {
        ...level,
        distance,
        aboveBelow: distance >= 0 ? 'above' : 'below',
        ltConfluence,
      };
    }).sort((a, b) => b.price - a.price); // sorted by price descending (above first)
  }

  /**
   * Active trade management simulation — bar-by-bar with dynamic stop adjustments.
   * Returns enhanced outcome with MFE/MAE and stop adjustment log.
   */
  simulateManagedTrade(entryTimestamp, entryPrice, initialStop, initialTarget, side, tradingDay, maxBars = 120) {
    // Find starting index
    let startIdx = -1;
    for (let i = 0; i < this.candles1m.length; i++) {
      if (this.candles1m[i].timestamp > entryTimestamp) {
        startIdx = i;
        break;
      }
    }
    if (startIdx < 0) return { outcome: 'no_data', bars: 0, pnl: 0, stopAdjustments: [] };

    const isLong = side === 'buy';
    const initialRisk = Math.abs(entryPrice - initialStop);
    let currentStop = initialStop;
    let maxFavorableExcursion = 0;
    let maxAdverseExcursion = 0;
    let lastRatchetMFE = 0; // track MFE tier that last triggered a ratchet
    const stopAdjustments = [];

    // Helper: is the new stop tighter (more protective) than the current one?
    const isTighter = (newStop) => isLong ? newStop > currentStop : newStop < currentStop;
    // Helper: build exit result
    const exitResult = (outcome, exitPrice, barsHeld, exitTime) => ({
      outcome,
      exitPrice,
      pnl: Math.round((isLong ? exitPrice - entryPrice : entryPrice - exitPrice) * 100) / 100,
      bars: barsHeld,
      exitTime,
      maxFavorableExcursion: Math.round(maxFavorableExcursion * 100) / 100,
      maxAdverseExcursion: Math.round(maxAdverseExcursion * 100) / 100,
      stopAdjustments,
      finalStop: currentStop,
    });

    for (let i = startIdx; i < Math.min(startIdx + maxBars, this.candles1m.length); i++) {
      const candle = this.candles1m[i];
      const barsHeld = i - startIdx + 1;
      const unrealizedHigh = isLong ? candle.high - entryPrice : entryPrice - candle.low;
      const unrealizedLow = isLong ? candle.low - entryPrice : entryPrice - candle.high;

      maxFavorableExcursion = Math.max(maxFavorableExcursion, unrealizedHigh);
      maxAdverseExcursion = Math.min(maxAdverseExcursion, unrealizedLow);

      // 1. Check stop hit FIRST (worst case)
      const stopHit = isLong ? candle.low <= currentStop : candle.high >= currentStop;
      if (stopHit) {
        const isManaged = currentStop !== initialStop &&
          (isLong ? currentStop >= entryPrice : currentStop <= entryPrice);
        return exitResult(
          isManaged ? 'managed_exit' : 'stop',
          currentStop, barsHeld, formatET(candle.timestamp)
        );
      }

      // 2. Check target hit
      const targetHit = isLong ? candle.high >= initialTarget : candle.low <= initialTarget;
      if (targetHit) {
        return exitResult('target', initialTarget, barsHeld, formatET(candle.timestamp));
      }

      // ── 3. MFE RATCHET (every bar — cheap math, no data lookups) ──
      // Locks in a scaling percentage of peak profit. This is the PRIMARY
      // protection against giving back large gains.
      //   MFE  < 20:   no trail (let the trade breathe)
      //   MFE 20-39:   lock in breakeven
      //   MFE 40-59:   lock in 33% of MFE
      //   MFE 60-99:   lock in 40% of MFE
      //   MFE 100+:    lock in 50% of MFE
      if (maxFavorableExcursion >= 20 && maxFavorableExcursion > lastRatchetMFE) {
        let lockInPct = 0;
        if (maxFavorableExcursion >= 100) lockInPct = 0.50;
        else if (maxFavorableExcursion >= 60) lockInPct = 0.40;
        else if (maxFavorableExcursion >= 40) lockInPct = 0.33;
        // 20-39: lockInPct stays 0 → breakeven

        const lockedProfit = maxFavorableExcursion * lockInPct;
        const ratchetStop = isLong
          ? entryPrice + lockedProfit
          : entryPrice - lockedProfit;

        if (isTighter(ratchetStop)) {
          const prevStop = currentStop;
          currentStop = Math.round(ratchetStop * 100) / 100;
          lastRatchetMFE = maxFavorableExcursion;
          const reason = lockInPct === 0
            ? 'mfe_ratchet (breakeven)'
            : `mfe_ratchet (lock ${Math.round(lockInPct * 100)}% of ${maxFavorableExcursion.toFixed(0)}pt MFE = +${lockedProfit.toFixed(1)}pts)`;
          stopAdjustments.push({
            bar: barsHeld,
            from: Math.round(prevStop * 100) / 100,
            to: currentStop,
            reason,
          });
        }
      }

      // ── 4. STRUCTURAL TRAIL (every 5 bars — needs data lookup) ──
      // Trail behind structural levels when MFE >= 20pts.
      // Gates on MFE (not current unrealized) so it works even after a pullback.
      if (barsHeld % 5 === 0 && maxFavorableExcursion >= 20) {
        const structLevels = this.getStructuralLevels(candle.timestamp, candle.close, tradingDay);
        if (structLevels && structLevels.length > 0) {
          let bestTrailLevel = null;
          const buffer = 2;
          if (isLong) {
            // Find nearest support below current price that is tighter than current stop
            const candidates = structLevels
              .filter(l => l.aboveBelow === 'below' && isTighter(l.price - buffer))
              .sort((a, b) => b.price - a.price); // nearest to price first
            if (candidates.length > 0) bestTrailLevel = candidates[0];
          } else {
            // Find nearest resistance above current price that is tighter than current stop
            const candidates = structLevels
              .filter(l => l.aboveBelow === 'above' && isTighter(l.price + buffer))
              .sort((a, b) => a.price - b.price); // nearest to price first
            if (candidates.length > 0) bestTrailLevel = candidates[0];
          }

          if (bestTrailLevel) {
            const trailStop = isLong ? bestTrailLevel.price - buffer : bestTrailLevel.price + buffer;
            if (isTighter(trailStop)) {
              const prevStop = currentStop;
              currentStop = Math.round(trailStop * 100) / 100;
              stopAdjustments.push({
                bar: barsHeld,
                from: Math.round(prevStop * 100) / 100,
                to: currentStop,
                reason: `structural_trail (${bestTrailLevel.label})`,
              });
            }
          }
        }
      }

      // ── 5. CONDITION-BASED TIGHTENING (every 15 bars) ──
      // When LT conditions deteriorate, lock in 60% of current unrealized profit.
      if (barsHeld % 15 === 0 && barsHeld > 0) {
        const currentUnrealized = isLong ? candle.close - entryPrice : entryPrice - candle.close;
        if (currentUnrealized > 0) {
          const ltMig = this._computeLTMigration(
            tradingDay,
            Math.max(candle.timestamp - 15 * 60 * 1000, entryTimestamp),
            candle.timestamp,
          );
          if (ltMig) {
            const shouldTighten =
              (isLong && ltMig.overallSignal === 'deteriorating') ||
              (!isLong && ltMig.overallSignal === 'improving');

            if (shouldTighten) {
              const tightenStop = isLong
                ? entryPrice + currentUnrealized * 0.6
                : entryPrice - currentUnrealized * 0.6;

              if (isTighter(tightenStop)) {
                const prevStop = currentStop;
                currentStop = Math.round(tightenStop * 100) / 100;
                stopAdjustments.push({
                  bar: barsHeld,
                  from: Math.round(prevStop * 100) / 100,
                  to: currentStop,
                  reason: `condition_tightening (LT ${ltMig.overallSignal})`,
                });
              }
            }
          }
        }
      }
    }

    // Max bars reached — exit at market
    const lastIdx = Math.min(startIdx + maxBars - 1, this.candles1m.length - 1);
    const lastCandle = this.candles1m[lastIdx];
    const mtmPnl = isLong ? lastCandle.close - entryPrice : entryPrice - lastCandle.close;
    return {
      outcome: 'timeout',
      exitPrice: lastCandle.close,
      pnl: mtmPnl,
      bars: maxBars,
      exitTime: formatET(lastCandle.timestamp),
      maxFavorableExcursion: Math.round(maxFavorableExcursion * 100) / 100,
      maxAdverseExcursion: Math.round(maxAdverseExcursion * 100) / 100,
      stopAdjustments,
      finalStop: currentStop,
    };
  }

  /**
   * Build a window summary for bias reassessment.
   * Assembles OHLCV, GEX, IV, LT migration, and level interactions for a time window.
   */
  getWindowSummary(tradingDay, fromTimestamp, toTimestamp) {
    // Window OHLCV summary
    const windowCandles = this._getCandlesInRange(fromTimestamp, toTimestamp);
    let ohlcvSummary = null;
    if (windowCandles.length > 0) {
      const wOpen = windowCandles[0].open;
      const wClose = windowCandles[windowCandles.length - 1].close;
      const wHigh = Math.max(...windowCandles.map(c => c.high));
      const wLow = Math.min(...windowCandles.map(c => c.low));
      const totalVolume = windowCandles.reduce((s, c) => s + c.volume, 0);
      ohlcvSummary = {
        open: wOpen,
        high: wHigh,
        low: wLow,
        close: wClose,
        range: wHigh - wLow,
        direction: wClose > wOpen ? 'up' : wClose < wOpen ? 'down' : 'flat',
        changePts: wClose - wOpen,
        totalVolume,
        avgVolumePerCandle: Math.round(totalVolume / windowCandles.length),
        candleCount: windowCandles.length,
      };
    }

    // GEX comparison: start vs end of window
    const gexStart = this.gexLoader.getGexLevels(new Date(fromTimestamp));
    const gexEnd = this.gexLoader.getGexLevels(new Date(toTimestamp));
    let gexComparison = null;
    if (gexStart && gexEnd) {
      gexComparison = {
        startRegime: gexStart.regime,
        endRegime: gexEnd.regime,
        regimeChanged: gexStart.regime !== gexEnd.regime,
        startGammaFlip: gexStart.gamma_flip || gexStart.nq_gamma_flip,
        endGammaFlip: gexEnd.gamma_flip || gexEnd.nq_gamma_flip,
        startCallWall: gexStart.call_wall || gexStart.nq_call_wall_1,
        endCallWall: gexEnd.call_wall || gexEnd.nq_call_wall_1,
        startPutWall: gexStart.put_wall || gexStart.nq_put_wall_1,
        endPutWall: gexEnd.put_wall || gexEnd.nq_put_wall_1,
      };
    }

    // IV comparison
    const ivStart = this.ivLoader.getIVAtTime(fromTimestamp);
    const ivEnd = this.ivLoader.getIVAtTime(toTimestamp);
    let ivComparison = null;
    if (ivStart && ivEnd) {
      ivComparison = {
        startIV: ivStart.iv,
        endIV: ivEnd.iv,
        ivChange: ivEnd.iv - ivStart.iv,
        startSkew: ivStart.skew,
        endSkew: ivEnd.skew,
        skewChange: ivEnd.skew - ivStart.skew,
        trend: ivEnd.iv > ivStart.iv ? 'expanding' : ivEnd.iv < ivStart.iv ? 'contracting' : 'stable',
      };
    }

    // LT migration
    const ltMigration = this._computeLTMigration(tradingDay, fromTimestamp, toTimestamp);

    // Level interactions
    const gexLevels = gexEnd || gexStart;
    const ltSnapshot = this._getLTLevelsAtTime(toTimestamp);
    const levelInteractions = this._analyzeLevelInteractions(windowCandles, gexLevels, ltSnapshot);

    return {
      tradingDay,
      fromTime: formatET(fromTimestamp),
      toTime: formatET(toTimestamp),
      ohlcv: ohlcvSummary,
      gex: gexComparison,
      iv: ivComparison,
      ltMigration,
      levelInteractions,
    };
  }

  /**
   * Compute LT level migration over a time window.
   * For each fib level, tracks delta, direction relative to price, and crossings.
   */
  _computeLTMigration(tradingDay, fromTimestamp, toTimestamp) {
    const ltStart = this._getLTLevelsAtTime(fromTimestamp);
    const ltEnd = this._getLTLevelsAtTime(toTimestamp);
    if (!ltStart || !ltEnd) return null;

    // Get price at start and end of window
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
      const startRelative = priceStart - startLevels[i]; // positive = price above level
      const endRelative = priceEnd - endLevels[i];

      // Did this level cross through price during the window?
      const crossedPrice = (startRelative > 0 && endRelative < 0) || (startRelative < 0 && endRelative > 0);

      // Direction relative to price: moving toward or away
      const distStart = Math.abs(startRelative);
      const distEnd = Math.abs(endRelative);
      const direction = distEnd < distStart ? 'toward_price' : distEnd > distStart ? 'away_from_price' : 'stable';

      // Weight: all fib lookback periods weighted equally to avoid bias from lagging long-term fibs
      const weight = 1.0;

      // Score: positive = improving liquidity, negative = deteriorating
      // If price rising and levels moving away (below) → improving
      // If price rising and levels moving toward (from below, closing in) → deteriorating
      let levelScore = 0;
      if (direction === 'away_from_price') levelScore = 1;
      else if (direction === 'toward_price') levelScore = -1;
      if (crossedPrice) levelScore *= 2; // crossings are stronger signals

      weightedScore += levelScore * weight;
      totalWeight += weight;

      levels.push({
        fib: fibLookbacks[i],
        startPrice: startLevels[i],
        endPrice: endLevels[i],
        delta: Math.round(delta * 100) / 100,
        direction,
        crossedPrice,
      });
    }

    // Compute overall signal
    const normalizedScore = totalWeight > 0 ? weightedScore / totalWeight : 0;
    let overallSignal;
    if (normalizedScore > 0.3) overallSignal = 'improving';
    else if (normalizedScore < -0.3) overallSignal = 'deteriorating';
    else overallSignal = 'stable';

    // Short-term (fib 34/55) and long-term (fib 377/610) trends
    const shortTermLevels = levels.filter(l => l.fib <= 55);
    const longTermLevels = levels.filter(l => l.fib >= 377);

    const shortTermMoving = shortTermLevels.filter(l => l.direction === 'away_from_price').length >
                            shortTermLevels.filter(l => l.direction === 'toward_price').length;
    const longTermMoving = longTermLevels.filter(l => l.direction === 'away_from_price').length >
                           longTermLevels.filter(l => l.direction === 'toward_price').length;

    return {
      priceStart,
      priceEnd,
      priceDirection,
      priceDelta: Math.round((priceEnd - priceStart) * 100) / 100,
      levels,
      overallSignal,
      normalizedScore: Math.round(normalizedScore * 100) / 100,
      shortTermTrend: shortTermMoving ? 'improving' : shortTermLevels.length > 0 ? 'deteriorating' : 'unknown',
      longTermTrend: longTermMoving ? 'improving' : longTermLevels.length > 0 ? 'deteriorating' : 'unknown',
    };
  }

  /**
   * Analyze which GEX/LT levels were tested, held, or broke during a candle window.
   */
  _analyzeLevelInteractions(candles, gexSnapshot, ltSnapshot) {
    if (!candles || candles.length === 0) return null;

    const allLevels = [];
    const threshold = 5; // points — within 5 pts counts as "tested"

    // Gather GEX levels
    if (gexSnapshot) {
      for (const l of this._getAllGexLevels(gexSnapshot)) {
        allLevels.push({ ...l, source: 'gex' });
      }
    }

    // Gather LT levels
    if (ltSnapshot) {
      const fibNames = ['LT-34', 'LT-55', 'LT-144', 'LT-377', 'LT-610'];
      [ltSnapshot.level_1, ltSnapshot.level_2, ltSnapshot.level_3, ltSnapshot.level_4, ltSnapshot.level_5].forEach((lv, i) => {
        if (lv != null) {
          allLevels.push({ price: lv, type: 'lt', label: fibNames[i], source: 'lt' });
        }
      });
    }

    if (allLevels.length === 0) return { tested: [], held: [], broke: [], netDirection: 'neutral' };

    const tested = [];
    const held = [];
    const broke = [];

    for (const level of allLevels) {
      let wasTested = false;
      let closedThrough = false;

      for (const c of candles) {
        // Was level tested? (price came within threshold)
        if (Math.abs(c.low - level.price) <= threshold || Math.abs(c.high - level.price) <= threshold) {
          wasTested = true;
        }
        // Did a candle close through the level?
        // For support: close below level; for resistance: close above level
        if (c.close < level.price - threshold && c.open > level.price) {
          closedThrough = true; // broke support
        }
        if (c.close > level.price + threshold && c.open < level.price) {
          closedThrough = true; // broke resistance
        }
      }

      if (wasTested) {
        tested.push(level);
        if (closedThrough) {
          broke.push(level);
        } else {
          held.push(level);
        }
      }
    }

    // Net direction: more support breaks = bearish, more resistance breaks = bullish
    const currentPrice = candles[candles.length - 1].close;
    const supportBreaks = broke.filter(l => l.price < currentPrice).length;
    const resistanceBreaks = broke.filter(l => l.price > currentPrice).length;
    let netDirection = 'neutral';
    if (resistanceBreaks > supportBreaks) netDirection = 'bullish';
    else if (supportBreaks > resistanceBreaks) netDirection = 'bearish';

    return {
      tested: tested.map(l => ({ label: l.label, price: l.price, source: l.source })),
      held: held.map(l => ({ label: l.label, price: l.price, source: l.source })),
      broke: broke.map(l => ({ label: l.label, price: l.price, source: l.source })),
      netDirection,
    };
  }
}
