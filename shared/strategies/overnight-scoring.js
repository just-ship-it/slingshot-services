/**
 * Overnight Scoring Strategy
 *
 * Multi-factor scoring approach for overnight NQ trading (6 PM - 2 AM EST).
 * Combines LT sentiment, GEX regime, IBS, day-of-week, GEX magnitude,
 * last-hour direction, consecutive day patterns, and gamma flip position
 * into a composite score. Only trades when score >= threshold.
 *
 * Backtested results (Score>=7, 2AM exit, 200/200 stops):
 *   58 trades, 82.8% WR, PF 16.2, Sharpe 0.817, avg +48.5 pts/trade
 *
 * Score components:
 *   +2  LT Sentiment matches direction (BULLISH->long, BEARISH->short)
 *   +2  GEX regime confirms direction
 *   +1  Strong GEX regime (strong_positive or strong_negative)
 *   +1  IBS confirms (low IBS + long, high IBS + short)
 *   -1  IBS contradicts (high IBS + long, low IBS + short)
 *   +1  Monday or Wednesday (best overnight days)
 *   -1  Thursday (worst overnight day)
 *   +1  GEX magnitude > P75 of historical
 *   +1  GEX magnitude > P90 of historical
 *   +1  Last-hour selling + long bias (or last-hour rally + short bias)
 *   +1  2+ consecutive down days + long bias (or up days + short)
 *   +1  Above gamma flip + long bias (or below + short)
 *
 * Max possible score: ~12. Typical high-conviction: 7-9.
 */

import { BaseStrategy } from './base-strategy.js';
import { roundTo } from './strategy-utils.js';

export class OvernightScoringStrategy extends BaseStrategy {
  constructor(params = {}) {
    super(params);

    this.defaultParams = {
      scoreThreshold: 7,
      stopLossPoints: 200,
      takeProfitPoints: 200,
      entryHourET: 18,
      exitHourET: 2,
      maxHoldBars: 480,
      ibsLongThreshold: 0.3,
      ibsShortThreshold: 0.7,
      ibsContraLong: 0.8,
      ibsContraShort: 0.2,
      lastHourThreshold: 20,
      blockedDays: [],
      signalCooldownMs: 60000,
      tradingSymbol: 'NQ1!',
      defaultQuantity: 1,
    };

    this.params = { ...this.defaultParams, ...params };
    this._resetState();
  }

  _resetState() {
    this._rthHigh = -Infinity;
    this._rthLow = Infinity;
    this._rthOpen = null;
    this._rthClose = null;
    this._lastHourOpen = null;
    this._lastHourClose = null;
    this._consecutiveDown = 0;
    this._consecutiveUp = 0;
    this._signalledTonight = false;
    this._inRTH = false;
    this._cachedLTSentiment = null;
    this._cachedGexRegime = null;
    this._cachedTotalGex = null;
    this._cachedGammaFlip = null;
    this._gexHistory = [];
  }

  // ── Timezone helpers ──

  _isDST(utcMs) {
    const d = new Date(utcMs);
    const y = d.getUTCFullYear(), m = d.getUTCMonth();
    if (m >= 3 && m <= 9) return true;
    if (m === 0 || m === 1 || m === 11) return false;
    if (m === 2) {
      const fd = new Date(Date.UTC(y, 2, 1)).getUTCDay();
      return utcMs >= Date.UTC(y, 2, fd === 0 ? 8 : 15 - fd, 7);
    }
    if (m === 10) {
      const fd = new Date(Date.UTC(y, 10, 1)).getUTCDay();
      return utcMs < Date.UTC(y, 10, fd === 0 ? 1 : 8 - fd, 6);
    }
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

  _getGexPercentile(absGex) {
    if (this._gexHistory.length < 20) return 50;
    const sorted = [...this._gexHistory].sort((a, b) => a - b);
    let pos = 0;
    for (let i = 0; i < sorted.length; i++) {
      if (sorted[i] < absGex) pos++;
    }
    return (pos / sorted.length) * 100;
  }

  // ── Scoring engine (uses cached EOD features) ──

  _computeScore(session) {
    let score = 0;
    let direction = 0;

    const sentiment = this._cachedLTSentiment;
    if (sentiment === 'BULLISH') { score += 2; direction = 1; }
    else if (sentiment === 'BEARISH') { score += 2; direction = -1; }
    else return { score: 0, direction: 0 };

    const regime = this._cachedGexRegime;
    const posGex = regime === 'positive' || regime === 'strong_positive';
    const negGex = regime === 'negative' || regime === 'strong_negative';
    if (posGex && direction > 0) score += 2;
    else if (negGex && direction < 0) score += 2;
    else if (posGex && direction < 0) score -= 1;
    else if (negGex && direction > 0) score -= 1;
    if (regime === 'strong_positive' && direction > 0) score += 1;
    if (regime === 'strong_negative' && direction < 0) score += 1;

    const ibs = session.ibs;
    if (direction > 0 && ibs < this.params.ibsLongThreshold) score += 1;
    if (direction < 0 && ibs > this.params.ibsShortThreshold) score += 1;
    if (direction > 0 && ibs > this.params.ibsContraLong) score -= 1;
    if (direction < 0 && ibs < this.params.ibsContraShort) score -= 1;

    const day = session.dayOfWeek;
    if (day === 'Thursday') score -= 1;
    if (day === 'Monday' || day === 'Wednesday') score += 1;

    const totalGex = this._cachedTotalGex;
    if (totalGex != null) {
      const pctile = this._getGexPercentile(Math.abs(totalGex));
      if (pctile >= 75) score += 1;
      if (pctile >= 90) score += 1;
    }

    const lastHourRet = session.lastHourReturn || 0;
    if (direction > 0 && lastHourRet < -this.params.lastHourThreshold) score += 1;
    if (direction < 0 && lastHourRet > this.params.lastHourThreshold) score += 1;

    if (direction > 0 && session.consecutiveDown >= 2) score += 1;
    if (direction < 0 && session.consecutiveUp >= 2) score += 1;

    const gammaFlip = this._cachedGammaFlip;
    if (gammaFlip && session.rthClose) {
      const above = session.rthClose > gammaFlip;
      if (above && direction > 0) score += 1;
      if (!above && direction < 0) score += 1;
    }

    return { score, direction };
  }

  // ── Main evaluation ──

  evaluateSignal(candle, prevCandle, marketData, options = {}) {
    const ts = candle.timestamp;
    const estHour = this._getESTHour(ts);
    const estDate = this._getESTDateStr(ts);
    const { gexLevels, ltLevels } = marketData || {};

    const isRTH = estHour >= 9.5 && estHour < 16;
    const isLastHour = estHour >= 15 && estHour < 16;
    const isOvernight = estHour >= 18 || estHour < 9.5;

    // ── Detect new RTH session (non-RTH -> RTH transition) ──
    if (isRTH && !this._inRTH) {
      // Update consecutive day tracking from the RTH session that just ended
      if (this._rthClose != null && this._rthOpen != null) {
        if (this._rthClose - this._rthOpen < 0) {
          this._consecutiveDown++; this._consecutiveUp = 0;
        } else {
          this._consecutiveUp++; this._consecutiveDown = 0;
        }
      }
      // Reset for new RTH day
      this._rthHigh = -Infinity;
      this._rthLow = Infinity;
      this._rthOpen = null;
      this._rthClose = null;
      this._lastHourOpen = null;
      this._lastHourClose = null;
      this._signalledTonight = false;
      this._cachedLTSentiment = null;
      this._cachedGexRegime = null;
      this._cachedTotalGex = null;
      this._cachedGammaFlip = null;
    }
    this._inRTH = isRTH;

    // ── Cache LT and GEX during non-overnight (RTH + transition 4-6pm) ──
    // Freeze at overnight open so overnight-delivered data doesn't overwrite EOD snapshot
    if (!isOvernight) {
      if (ltLevels?.sentiment) this._cachedLTSentiment = ltLevels.sentiment;
      if (gexLevels?.regime) this._cachedGexRegime = gexLevels.regime;
      const _tg = gexLevels?.total_gex ?? gexLevels?.totalGex;
      if (_tg != null) this._cachedTotalGex = _tg;
      const _gf = gexLevels?.gamma_flip ?? gexLevels?.gammaFlip ?? gexLevels?.nq_gamma_flip;
      if (_gf != null) this._cachedGammaFlip = _gf;
    }

    // ── RTH: track stats, no signals ──
    if (isRTH) {
      if (this._rthOpen == null) this._rthOpen = candle.open;
      if (candle.high > this._rthHigh) this._rthHigh = candle.high;
      if (candle.low < this._rthLow) this._rthLow = candle.low;
      this._rthClose = candle.close;
      if (isLastHour) {
        if (this._lastHourOpen == null) this._lastHourOpen = candle.open;
        this._lastHourClose = candle.close;
      }
      const _tg = gexLevels?.total_gex ?? gexLevels?.totalGex;
      if (_tg != null && estHour >= 15.9) {
        this._gexHistory.push(Math.abs(_tg));
        if (this._gexHistory.length > 1000) this._gexHistory.shift();
      }
      return null;
    }

    // ── Transition (4-6 PM): no signals, just cache above ──
    if (!isOvernight) return null;

    // ── Overnight (6 PM - 9:30 AM): signal zone ──
    if (this._signalledTonight) return null;
    if (estHour < this.params.entryHourET && estHour >= 9.5) return null;
    if (this._rthClose == null || this._rthOpen == null) return null;

    // Day of week (use pre-midnight date for post-midnight candles)
    const dayOfWeek = estHour >= 18
      ? this._getDayOfWeek(estDate)
      : this._getDayOfWeek(this._getESTDateStr(ts - 12 * 3600000));
    if (this.params.blockedDays.includes(dayOfWeek)) return null;
    // Skip Sunday nights — no preceding RTH session to score from
    if (dayOfWeek === 'Sunday') return null;

    if (!this.checkCooldown(ts, this.params.signalCooldownMs)) return null;

    // Build session features
    const rthClose = this._rthClose;
    const rthHigh = this._rthHigh > -Infinity ? this._rthHigh : rthClose;
    const rthLow = this._rthLow < Infinity ? this._rthLow : rthClose;
    const ibs = rthHigh > rthLow ? (rthClose - rthLow) / (rthHigh - rthLow) : 0.5;

    const session = {
      ibs,
      dayOfWeek,
      lastHourReturn: this._lastHourClose && this._lastHourOpen
        ? this._lastHourClose - this._lastHourOpen : 0,
      consecutiveDown: this._consecutiveDown,
      consecutiveUp: this._consecutiveUp,
      rthClose,
    };

    // Compute score
    const { score, direction } = this._computeScore(session);

    if (score < this.params.scoreThreshold) return null;

    // Generate signal
    this._signalledTonight = true;
    this.updateLastSignalTime(ts);

    const isLong = direction > 0;
    const side = isLong ? 'buy' : 'sell';
    const entryPrice = candle.close;
    const stopLoss = isLong
      ? roundTo(entryPrice - this.params.stopLossPoints)
      : roundTo(entryPrice + this.params.stopLossPoints);
    const takeProfit = isLong
      ? roundTo(entryPrice + this.params.takeProfitPoints)
      : roundTo(entryPrice - this.params.takeProfitPoints);
    const forceExitTimeUTC = this._computeExitTime(ts);

    return {
      strategy: 'OVERNIGHT_SCORING',
      action: 'place_market',
      side,
      symbol: this.params.tradingSymbol,
      price: roundTo(entryPrice),
      stop_loss: stopLoss,
      take_profit: takeProfit,
      quantity: this.params.defaultQuantity,
      maxHoldBars: this.params.maxHoldBars,
      forceExitTimeUTC,
      timestamp: new Date(ts).toISOString(),
      metadata: {
        score,
        direction: isLong ? 'bullish' : 'bearish',
        ibs: roundTo(ibs, 3),
        lt_sentiment: this._cachedLTSentiment || 'unknown',
        gex_regime: this._cachedGexRegime || 'unknown',
        day_of_week: dayOfWeek,
        rth_close: roundTo(rthClose),
        consecutive_down: this._consecutiveDown,
        consecutive_up: this._consecutiveUp,
        last_hour_return: roundTo(session.lastHourReturn),
        exit_time: new Date(forceExitTimeUTC).toISOString(),
        target_points: this.params.takeProfitPoints,
        stop_points: this.params.stopLossPoints,
      },
    };
  }

  reset() {
    super.reset();
    this._resetState();
  }

  getName() { return 'OVERNIGHT_SCORING'; }
  getDescription() { return 'Multi-factor scoring overnight strategy (LT + GEX + IBS + day)'; }
  getRequiredMarketData() { return ['gexLevels', 'ltLevels']; }

  validateParams(params) {
    const errors = [];
    if (params.scoreThreshold < 1) errors.push('scoreThreshold must be >= 1');
    if (params.stopLossPoints <= 0) errors.push('stopLossPoints must be > 0');
    if (params.takeProfitPoints <= 0) errors.push('takeProfitPoints must be > 0');
    return { valid: errors.length === 0, errors };
  }
}
