/**
 * LT Structure Confirmation Strategy
 *
 * Trades when both LT34 and LT55 "scoop" entirely below the current bar (long)
 * or "crash" entirely above the current bar (short) during the overnight session
 * (6PM-8AM EST).
 *
 * The key filter is trend consistency — the LT levels must have been trending
 * steadily in one direction, not flipping above/below price on consecutive bars.
 * This captures the exhaustion move where LT overshoots price.
 *
 * Signal logic:
 *   - Both LT34 AND LT55 below candle.low → LONG
 *   - Both LT34 AND LT55 above candle.high → SHORT
 *   - LT must have been trending consistently for at least trendBars snapshots
 *     (no flipping — measured by counting side changes in the lookback window)
 *
 * Entry:
 *   market: enter at candle close on signal bar
 *   limit:  place limit at candle low (longs) or candle high (shorts)
 *
 * Exit:
 *   Wide initial stop (default 70pt) + optional MFE ratchet (--mfe-ratchet)
 *
 * Usage (backtest):
 *   node index.js --ticker NQ --strategy lt-structure-confirm --mfe-ratchet --stop-loss-points 70 \
 *     --minute-resolution --allow-overnight-holds --entry-mode market
 */

import { BaseStrategy } from './base-strategy.js';
import { roundToNQTick } from './strategy-utils.js';

export class LTStructureConfirmStrategy extends BaseStrategy {
  constructor(params = {}) {
    super(params);

    this.defaultParams = {
      // LT trend consistency params
      trendBars: 15,              // lookback window for trend consistency check
      minBarsOnSide: 12,          // of the last trendBars, at least this many must have had LT on the approaching side
                                  // (above candle.high for longs, below candle.low for shorts)
      slopeLookback: 12,          // snapshots for linear regression slope
      minSlopeMagnitude: 0.5,     // min slope magnitude (pts per snapshot) — 0 to disable slope check

      // Large bar filter — avoid entering after exhaustion moves
      largeBarThreshold: 40,      // bar range > this many points triggers retrace requirement
      retraceEntryPct: 50,        // require price to retrace this % of the large bar before entry (limit order)

      // Entry/exit
      entryMode: 'market',        // 'market' at candle close, 'limit' at candle low/high
      stopLossPoints: 70,
      takeProfitPoints: 0,        // 0 = no fixed target (use --mfe-ratchet)
      timeoutCandles: 5,          // limit order expiry

      // Session
      maxHoldBars: 840,           // ~14 hours on 1m resolution
      signalCooldownMs: 60000,
      blockHoursStart: 0,
      blockHoursEnd: 0,

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
    this._signalledLongTonight = false;
    this._signalledShortTonight = false;

    // Rolling LT history from real-time snapshots
    this._ltHistory = [];
    this._prevLTTimestamp = 0;

    // Track LT position relative to bar high/low for consistency check
    // Each entry: { lt34AboveHigh, lt55AboveHigh, lt34BelowLow, lt55BelowLow }
    this._ltPriceHistory = [];

    // LT data index (from loadLTData, for backtest mode)
    this._ltIndex = null;
    this._ltTimestamps = null;
  }

  /**
   * Called by the backtest engine at initialization to index all LT records
   * by timestamp for efficient lookup during evaluateSignal().
   */
  loadLTData(ltRecords) {
    this._ltIndex = new Map();
    for (const lt of ltRecords) {
      this._ltIndex.set(lt.timestamp, lt);
    }
    this._ltTimestamps = Array.from(this._ltIndex.keys()).sort((a, b) => a - b);
  }

  // ── Linear regression (inline helper) ──

  _linReg(values) {
    const n = values.length;
    if (n < 2) return { slope: 0, rSquared: 0 };
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
    for (let i = 0; i < n; i++) {
      sumX += i; sumY += values[i];
      sumXY += i * values[i]; sumX2 += i * i; sumY2 += values[i] * values[i];
    }
    const denom = n * sumX2 - sumX * sumX;
    if (denom === 0) return { slope: 0, rSquared: 0 };
    const slope = (n * sumXY - sumX * sumY) / denom;
    const intercept = (sumY - slope * sumX) / n;
    let ssRes = 0, ssTot = 0;
    const meanY = sumY / n;
    for (let i = 0; i < n; i++) {
      ssRes += (values[i] - (intercept + slope * i)) ** 2;
      ssTot += (values[i] - meanY) ** 2;
    }
    const rSquared = ssTot > 0 ? 1 - ssRes / ssTot : 0;
    return { slope, rSquared };
  }

  // ── LT history lookup ──

  _getLTHistoryAtTime(ts, count) {
    if (this._ltIndex && this._ltTimestamps) {
      let lo = 0, hi = this._ltTimestamps.length - 1, idx = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (this._ltTimestamps[mid] <= ts) { idx = mid; lo = mid + 1; }
        else { hi = mid - 1; }
      }
      if (idx < 0) return [];
      const start = Math.max(0, idx - count + 1);
      return this._ltTimestamps.slice(start, idx + 1).map(t => this._ltIndex.get(t));
    }
    return this._ltHistory.slice(-count);
  }

  // ── Trend consistency check ──

  /**
   * Count how many of the last N bars (excluding current) had both LTs on the
   * specified side of price.
   *
   * For longs: count bars where both LT34 and LT55 were above candle.high
   *   (LT was clearly above price, descending toward it — the "scoop from above")
   * For shorts: count bars where both LT34 and LT55 were below candle.low
   *   (LT was clearly below price, rising toward it — the "crash from below")
   */
  _countBarsOnSide(lookback, side) {
    const hist = this._ltPriceHistory;
    // Exclude the current bar (last entry) — we already know it triggered
    const end = hist.length - 1;
    const start = Math.max(0, end - lookback);
    let count = 0;
    for (let i = start; i < end; i++) {
      if (side === 'above') {
        // For longs: LT was above the bar's high
        if (hist[i].lt34AboveHigh && hist[i].lt55AboveHigh) count++;
      } else {
        // For shorts: LT was below the bar's low
        if (hist[i].lt34BelowLow && hist[i].lt55BelowLow) count++;
      }
    }
    return count;
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

  _isRollWeek(ts) {
    const d = new Date(ts + (this._isDST(ts) ? -4 : -5) * 3600000);
    const month = d.getUTCMonth();
    if (month !== 2 && month !== 5 && month !== 8 && month !== 11) return false;
    const day = d.getUTCDate();
    return day >= 7 && day <= 15;
  }

  // ── Main evaluation ──

  evaluateSignal(candle, prevCandle, marketData, options = {}) {
    const ts = candle.timestamp;
    const estHour = this._getESTHour(ts);
    const { ltLevels } = marketData || {};

    const isRTH = estHour >= 9.5 && estHour < 16;
    const isOvernight = estHour >= 18 || estHour < 8;

    // ── RTH reset ──
    if (isRTH && !this._inRTH) {
      this._overnightActive = false;
      this._signalledLongTonight = false;
      this._signalledShortTonight = false;
      this._ltHistory = [];
      this._ltPriceHistory = [];
      this._prevLTTimestamp = 0;
    }
    this._inRTH = isRTH;

    if (!isOvernight) return null;
    if (this._isRollWeek(ts)) return null;
    if (!ltLevels) return null;

    // Check for new LT snapshot
    const ltTs = ltLevels.timestamp || 0;
    if (ltTs <= this._prevLTTimestamp) return null;
    this._prevLTTimestamp = ltTs;

    // Accumulate LT history (for live mode)
    this._ltHistory.push({ ...ltLevels, timestamp: ltTs });

    if (!this._overnightActive) this._overnightActive = true;

    const currLT34 = ltLevels.level_1;
    const currLT55 = ltLevels.level_2;
    if (currLT34 == null || currLT55 == null) return null;

    // Track LT position relative to current bar's high/low
    this._ltPriceHistory.push({
      lt34AboveHigh: currLT34 > candle.high,
      lt55AboveHigh: currLT55 > candle.high,
      lt34BelowLow: currLT34 < candle.low,
      lt55BelowLow: currLT55 < candle.low,
    });

    // Need enough history for trend check
    const trendBars = this.params.trendBars;
    if (this._ltPriceHistory.length < trendBars + 1) return null;

    // Current bar conditions
    const bothBelowLow = currLT34 < candle.low && currLT55 < candle.low;
    const bothAboveHigh = currLT34 > candle.high && currLT55 > candle.high;

    if (!bothBelowLow && !bothAboveHigh) return null;

    // ── Trend consistency: LT must have been on the OPPOSITE side for most of the lookback ──
    // Longs: LT was above price (above candle.high) and descended through to below candle.low
    // Shorts: LT was below price (below candle.low) and rose through to above candle.high
    const barsAbove = this._countBarsOnSide(trendBars, 'above');
    const barsBelow = this._countBarsOnSide(trendBars, 'below');
    const minRequired = this.params.minBarsOnSide;

    // ── Optional slope check ──
    let lt34Slope = 0, lt55Slope = 0, lt34R2 = 0, lt55R2 = 0;
    if (this.params.minSlopeMagnitude > 0) {
      const history = this._getLTHistoryAtTime(ts, this.params.slopeLookback);
      if (history.length < this.params.slopeLookback) return null;

      const lt34Values = history.map(h => h.level_1).filter(v => v != null);
      const lt55Values = history.map(h => h.level_2).filter(v => v != null);
      if (lt34Values.length < this.params.slopeLookback || lt55Values.length < this.params.slopeLookback) return null;

      const lt34Reg = this._linReg(lt34Values);
      const lt55Reg = this._linReg(lt55Values);
      lt34Slope = lt34Reg.slope;
      lt55Slope = lt55Reg.slope;
      lt34R2 = lt34Reg.rSquared;
      lt55R2 = lt55Reg.rSquared;
    }

    // Hour block filter
    if (this.params.blockHoursStart > 0 && estHour >= this.params.blockHoursStart && estHour < this.params.blockHoursEnd) {
      return null;
    }

    // ── Large bar detection: check signal bar and prior bar ──
    const barRange = candle.high - candle.low;
    const prevBarRange = prevCandle ? (prevCandle.high - prevCandle.low) : 0;
    const largeBar = barRange > this.params.largeBarThreshold || prevBarRange > this.params.largeBarThreshold;
    const largestBar = Math.max(barRange, prevBarRange) > this.params.largeBarThreshold
      ? (barRange >= prevBarRange ? candle : prevCandle)
      : null;

    const signalMeta = {
      lt34Slope, lt55Slope, lt34R2, lt55R2,
      barsAbove, barsBelow,
      lt34: currLT34, lt55: currLT55,
      largeBar,
    };

    // ── Check LONG: both LTs scooped below the bar after being well above price ──
    if (bothBelowLow && !this._signalledLongTonight) {
      // LT must have been above candle.high for most of the lookback — steady descent from above
      if (barsAbove >= minRequired) {
        const slopeOk = this.params.minSlopeMagnitude <= 0 ||
          (lt34Slope < -this.params.minSlopeMagnitude && lt55Slope < -this.params.minSlopeMagnitude);

        if (slopeOk && this.checkCooldown(ts, this.params.signalCooldownMs)) {
          this._signalledLongTonight = true;
          this.updateLastSignalTime(ts);

          // Large bar: force limit entry at retrace level instead of chasing
          if (largeBar && largestBar) {
            const retracePct = this.params.retraceEntryPct / 100;
            // For longs after a big selloff: entry at low + retrace% of the bar range
            const retracePrice = roundToNQTick(largestBar.low + (largestBar.high - largestBar.low) * retracePct);
            return this._buildRetraceSignal('long', retracePrice, candle, ts, estHour, signalMeta);
          }
          return this._buildSignal('long', candle, ts, estHour, signalMeta);
        }
      }
    }

    // ── Check SHORT: both LTs crashed above the bar after being well below price ──
    if (bothAboveHigh && !this._signalledShortTonight) {
      // LT must have been below candle.low for most of the lookback — steady rise from below
      if (barsBelow >= minRequired) {
        const slopeOk = this.params.minSlopeMagnitude <= 0 ||
          (lt34Slope > this.params.minSlopeMagnitude && lt55Slope > this.params.minSlopeMagnitude);

        if (slopeOk && this.checkCooldown(ts, this.params.signalCooldownMs)) {
          this._signalledShortTonight = true;
          this.updateLastSignalTime(ts);

          if (largeBar && largestBar) {
            const retracePct = this.params.retraceEntryPct / 100;
            // For shorts after a big rally: entry at high - retrace% of the bar range
            const retracePrice = roundToNQTick(largestBar.high - (largestBar.high - largestBar.low) * retracePct);
            return this._buildRetraceSignal('short', retracePrice, candle, ts, estHour, signalMeta);
          }
          return this._buildSignal('short', candle, ts, estHour, signalMeta);
        }
      }
    }

    return null;
  }

  _buildSignal(side, candle, ts, estHour, metadata) {
    const isLong = side === 'long';
    const isMarket = this.params.entryMode === 'market';
    // Limit mode: buy at bar's low, sell at bar's high (where LT confirmed)
    const entryPrice = isMarket
      ? roundToNQTick(candle.close)
      : roundToNQTick(isLong ? candle.low : candle.high);

    const stopLoss = isLong
      ? roundToNQTick(entryPrice - this.params.stopLossPoints)
      : roundToNQTick(entryPrice + this.params.stopLossPoints);

    const takeProfit = this.params.takeProfitPoints > 0
      ? (isLong
        ? roundToNQTick(entryPrice + this.params.takeProfitPoints)
        : roundToNQTick(entryPrice - this.params.takeProfitPoints))
      : undefined;

    return {
      strategy: 'LT_STRUCTURE_CONFIRM',
      action: isMarket ? 'place_market' : 'place_limit',
      side: isLong ? 'buy' : 'sell',
      symbol: this.params.tradingSymbol,
      price: entryPrice,
      stop_loss: stopLoss,
      take_profit: takeProfit,
      quantity: this.params.defaultQuantity,
      maxHoldBars: this.params.maxHoldBars,
      timeoutCandles: this.params.timeoutCandles,
      timestamp: new Date(ts).toISOString(),
      metadata: {
        entryMode: this.params.entryMode,
        lt34: metadata.lt34,
        lt55: metadata.lt55,
        lt34Slope: metadata.lt34Slope,
        lt55Slope: metadata.lt55Slope,
        barsAbove: metadata.barsAbove,
        barsBelow: metadata.barsBelow,
        entry_hour: Math.round(estHour * 100) / 100,
        stop_points: this.params.stopLossPoints,
      },
    };
  }

  _buildRetraceSignal(side, retracePrice, candle, ts, estHour, metadata) {
    const isLong = side === 'long';
    const entryPrice = retracePrice;

    const stopLoss = isLong
      ? roundToNQTick(entryPrice - this.params.stopLossPoints)
      : roundToNQTick(entryPrice + this.params.stopLossPoints);

    const takeProfit = this.params.takeProfitPoints > 0
      ? (isLong
        ? roundToNQTick(entryPrice + this.params.takeProfitPoints)
        : roundToNQTick(entryPrice - this.params.takeProfitPoints))
      : undefined;

    return {
      strategy: 'LT_STRUCTURE_CONFIRM',
      action: 'place_limit',
      side: isLong ? 'buy' : 'sell',
      symbol: this.params.tradingSymbol,
      price: entryPrice,
      stop_loss: stopLoss,
      take_profit: takeProfit,
      quantity: this.params.defaultQuantity,
      maxHoldBars: this.params.maxHoldBars,
      timeoutCandles: this.params.timeoutCandles,
      timestamp: new Date(ts).toISOString(),
      metadata: {
        entryMode: 'retrace',
        lt34: metadata.lt34,
        lt55: metadata.lt55,
        lt34Slope: metadata.lt34Slope,
        lt55Slope: metadata.lt55Slope,
        barsAbove: metadata.barsAbove,
        barsBelow: metadata.barsBelow,
        entry_hour: Math.round(estHour * 100) / 100,
        stop_points: this.params.stopLossPoints,
      },
    };
  }

  reset() {
    super.reset();
    this._initState();
  }

  getName() { return 'LT_STRUCTURE_CONFIRM'; }
  getDescription() { return 'LT structure confirmation — overnight mean-reversion when both LT34/LT55 scoop below bar low (long) or crash above bar high (short) after a steady trend'; }
  getRequiredMarketData() { return ['ltLevels']; }

  validateParams(params) {
    const errors = [];
    if (params.stopLossPoints <= 0) errors.push('stopLossPoints must be > 0');
    if (params.trendBars < 2) errors.push('trendBars must be >= 2');
    return { valid: errors.length === 0, errors };
  }
}
