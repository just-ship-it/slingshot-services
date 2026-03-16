/**
 * Composite Overnight Strategy
 *
 * Multi-phase entry engine for overnight NQ trading (6 PM - 2 AM EST).
 * Uses LT sentiment for direction, GEX regime for confirmation, then
 * cascading entry phases: pullback → momentum confirm → fallback hold.
 *
 * Research results (PB=15, Mom=10, FB=120, SL=200, ex2am, GEX confirm):
 *   211 trades, 77.3% WR, PF 7.31, Sharpe 0.597, avg +32.7 pts/trade
 *
 * Entry Phases:
 *   Phase 1 (bars 0-240): Pullback entry — wait for 15pt pullback against LT
 *   Phase 2 (bar 60):     Momentum confirm — first-hour direction matches LT
 *   Phase 3 (bar 120):    Fallback hold — enter at market in LT direction
 *
 * Exit: 2 AM EST time-based exit (primary), 200pt stop loss (safety net)
 * Direction: Locked by LT sentiment. GEX regime must confirm.
 * Max 1 trade per overnight session.
 */

import { BaseStrategy } from './base-strategy.js';
import { roundTo } from './strategy-utils.js';

export class OvernightCompositeStrategy extends BaseStrategy {
  constructor(params = {}) {
    super(params);

    this.defaultParams = {
      // Phase 1: Pullback
      pullbackEnabled: true,
      pullbackPts: 15,           // Points of pullback to trigger entry
      pullbackMaxWait: 240,      // Max bars to wait for pullback (4 hours)

      // Phase 2: Momentum confirmation
      momentumEnabled: true,
      momentumLookback: 60,      // Bars to measure first-hour direction
      momentumMinMove: 10,       // Minimum points to confirm momentum

      // Phase 3: Fallback hold
      fallbackEnabled: true,
      fallbackAfterBars: 120,    // Enter at market after this many bars (~2 hours)

      // Risk management
      stopLossPoints: 200,
      takeProfitPoints: 9999,    // No target — time exit only
      exitHourET: 2,             // 2 AM EST forced exit
      maxHoldBars: 600,          // Safety: 10 hours

      // Filters
      requireGexConfirm: true,   // GEX regime must agree with LT direction

      // Session
      entryHourET: 18,
      signalCooldownMs: 60000,
      blockedDays: [],

      // Symbol
      tradingSymbol: 'NQ1!',
      defaultQuantity: 1,
      forceCloseAtMarketClose: false,
    };

    this.params = { ...this.defaultParams, ...params };
    this._initState();
  }

  _initState() {
    // RTH tracking
    this._rthHigh = -Infinity;
    this._rthLow = Infinity;
    this._rthOpen = null;
    this._rthClose = null;
    this._inRTH = false;

    // Overnight session state
    this._signalledTonight = false;
    this._overnightBar = 0;           // Bars since overnight open
    this._overnightOpen = null;       // Price at overnight open (first candle >= 6pm)
    this._overnightActive = false;    // Whether we're in the overnight window
    this._firstHourClosePrice = null; // Price at bar momentumLookback

    // Cached EOD features
    this._cachedLTSentiment = null;
    this._cachedGexRegime = null;

    // Direction for tonight (set at overnight open)
    this._tonightSide = null;  // 'buy' or 'sell'
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

  _getESTDateStr(ts) {
    const d = new Date(ts + (this._isDST(ts) ? -4 : -5) * 3600000);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  }

  _getDayOfWeek(dateStr) {
    return new Date(dateStr + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long' });
  }

  _computeExitTime(entryTs) {
    const exitHour = this.params.exitHourET;
    const entryDate = this._getESTDateStr(entryTs);
    let exitDate;
    if (exitHour < 12) {
      const d = new Date(entryDate + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + 1);
      exitDate = d.toISOString().split('T')[0];
    } else {
      exitDate = entryDate;
    }
    const exitHourInt = Math.floor(exitHour);
    const exitMinInt = Math.round((exitHour - exitHourInt) * 60);
    const utcHour = exitHourInt + (this._isDST(entryTs) ? 4 : 5);
    return new Date(`${exitDate}T${String(utcHour).padStart(2, '0')}:${String(exitMinInt).padStart(2, '0')}:00Z`).getTime();
  }

  // ── Main evaluation ──

  evaluateSignal(candle, prevCandle, marketData, options = {}) {
    const ts = candle.timestamp;
    const estHour = this._getESTHour(ts);
    const { gexLevels, ltLevels } = marketData || {};

    const isRTH = estHour >= 9.5 && estHour < 16;
    const isOvernight = estHour >= 18 || estHour < 9.5;

    // ── New RTH session detection ──
    if (isRTH && !this._inRTH) {
      this._rthHigh = -Infinity;
      this._rthLow = Infinity;
      this._rthOpen = null;
      this._rthClose = null;
      this._signalledTonight = false;
      this._overnightActive = false;
      this._overnightBar = 0;
      this._overnightOpen = null;
      this._firstHourClosePrice = null;
      this._tonightSide = null;
      this._cachedLTSentiment = null;
      this._cachedGexRegime = null;
    }
    this._inRTH = isRTH;

    // ── Always cache LT and GEX when available ──
    // Don't freeze at any boundary — use the most recent data at signal time.
    // The engine provides the nearest 15-min snapshot for both LT and GEX.
    if (ltLevels?.sentiment) this._cachedLTSentiment = ltLevels.sentiment;
    if (gexLevels?.regime) this._cachedGexRegime = gexLevels.regime;

    // ── RTH: track stats ──
    if (isRTH) {
      if (this._rthOpen == null) this._rthOpen = candle.open;
      if (candle.high > this._rthHigh) this._rthHigh = candle.high;
      if (candle.low < this._rthLow) this._rthLow = candle.low;
      this._rthClose = candle.close;
      return null;
    }

    // ── Transition (4-6 PM): just cache, no signals ──
    if (!isOvernight) return null;

    // ── Overnight session ──
    if (this._signalledTonight) return null;
    if (this._rthClose == null) return null;

    // Initialize overnight tracking on first overnight candle
    if (!this._overnightActive) {
      this._overnightActive = true;
      this._overnightBar = 0;
      this._overnightOpen = candle.open;

      // Determine direction for tonight
      if (!this._cachedLTSentiment) return null;
      this._tonightSide = this._cachedLTSentiment === 'BULLISH' ? 'buy' : 'sell';

      // GEX regime filter — use the gexLoader to get the latest snapshot
      // (matches standalone behavior: last snapshot of the day, typically ~6:45pm EST)
      if (this.params.requireGexConfirm) {
        const gexLoader = marketData?.gexLoader;
        let eodRegime = this._cachedGexRegime; // Fallback to RTH-cached value

        if (gexLoader && typeof gexLoader.getGexLevels === 'function') {
          const eodGex = gexLoader.getGexLevels(new Date(ts));
          if (eodGex?.regime) eodRegime = eodGex.regime;
        }

        if (!eodRegime) { this._tonightSide = null; return null; }
        this._cachedGexRegime = eodRegime;
        const posGex = eodRegime === 'positive' || eodRegime === 'strong_positive';
        const negGex = eodRegime === 'negative' || eodRegime === 'strong_negative';
        if (this._tonightSide === 'buy' && !posGex) { this._tonightSide = null; return null; }
        if (this._tonightSide === 'sell' && !negGex) { this._tonightSide = null; return null; }
      }

      // Day of week filter
      const estDate = this._getESTDateStr(ts);
      const dayOfWeek = estHour >= 18
        ? this._getDayOfWeek(estDate)
        : this._getDayOfWeek(this._getESTDateStr(ts - 12 * 3600000));
      if (dayOfWeek === 'Sunday' || dayOfWeek === 'Friday') { this._tonightSide = null; return null; }
      if (this.params.blockedDays?.includes(dayOfWeek)) { this._tonightSide = null; return null; }
    }

    this._overnightBar++;
    if (!this._tonightSide) return null;

    const isLong = this._tonightSide === 'buy';
    const openPrice = this._overnightOpen;

    // Track first-hour close for momentum phase
    if (this._overnightBar === this.params.momentumLookback) {
      this._firstHourClosePrice = candle.close;
    }

    // ═══ Phase 1: Pullback Entry ═══
    if (this.params.pullbackEnabled && this._overnightBar <= this.params.pullbackMaxWait) {
      const pullbackLevel = isLong
        ? openPrice - this.params.pullbackPts
        : openPrice + this.params.pullbackPts;

      // Check if candle reached pullback level
      if (isLong && candle.low <= pullbackLevel) {
        return this._generateSignal(candle, ts, pullbackLevel, 'pullback');
      }
      if (!isLong && candle.high >= pullbackLevel) {
        return this._generateSignal(candle, ts, pullbackLevel, 'pullback');
      }
    }

    // ═══ Phase 2: Momentum Confirmation ═══
    if (this.params.momentumEnabled && this._overnightBar === this.params.momentumLookback) {
      const firstHourReturn = candle.close - openPrice;
      if (Math.abs(firstHourReturn) >= this.params.momentumMinMove) {
        const momDirection = firstHourReturn > 0 ? 'buy' : 'sell';
        if (momDirection === this._tonightSide) {
          return this._generateSignal(candle, ts, candle.close, 'momentum');
        }
      }
    }

    // ═══ Phase 3: Fallback Hold ═══
    if (this.params.fallbackEnabled && this._overnightBar === this.params.fallbackAfterBars) {
      return this._generateSignal(candle, ts, candle.close, 'fallback');
    }

    return null;
  }

  _generateSignal(candle, ts, entryPrice, entryReason) {
    this._signalledTonight = true;
    this.updateLastSignalTime(ts);

    const isLong = this._tonightSide === 'buy';
    const stopLoss = isLong
      ? roundTo(entryPrice - this.params.stopLossPoints)
      : roundTo(entryPrice + this.params.stopLossPoints);
    const takeProfit = this.params.takeProfitPoints < 9000
      ? (isLong ? roundTo(entryPrice + this.params.takeProfitPoints) : roundTo(entryPrice - this.params.takeProfitPoints))
      : (isLong ? roundTo(entryPrice + 9999) : roundTo(entryPrice - 9999));

    const forceExitTimeUTC = this._computeExitTime(ts);
    const action = entryReason === 'pullback' ? 'place_limit' : 'place_market';

    return {
      strategy: 'OVERNIGHT_COMPOSITE',
      action,
      side: this._tonightSide,
      symbol: this.params.tradingSymbol,
      price: roundTo(entryPrice),
      stop_loss: stopLoss,
      take_profit: takeProfit,
      quantity: this.params.defaultQuantity,
      maxHoldBars: this.params.maxHoldBars,
      forceExitTimeUTC,
      sameCandleFill: entryReason === 'pullback',
      timestamp: new Date(ts).toISOString(),
      metadata: {
        entry_reason: entryReason,
        overnight_bar: this._overnightBar,
        lt_sentiment: this._cachedLTSentiment,
        gex_regime: this._cachedGexRegime,
        overnight_open: roundTo(this._overnightOpen),
        rth_close: roundTo(this._rthClose),
        exit_time: new Date(forceExitTimeUTC).toISOString(),
        stop_points: this.params.stopLossPoints,
      },
    };
  }

  reset() {
    super.reset();
    this._initState();
  }

  getName() { return 'OVERNIGHT_COMPOSITE'; }
  getDescription() { return 'Composite overnight strategy: pullback + momentum + fallback hold'; }
  getRequiredMarketData() { return ['gexLevels', 'ltLevels']; }

  validateParams(params) {
    const errors = [];
    if (params.stopLossPoints <= 0) errors.push('stopLossPoints must be > 0');
    if (!params.pullbackEnabled && !params.momentumEnabled && !params.fallbackEnabled) {
      errors.push('At least one entry phase must be enabled');
    }
    return { valid: errors.length === 0, errors };
  }
}
