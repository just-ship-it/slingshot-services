/**
 * GEX-FLIP-IVPCT Strategy
 *
 * A 6-rule, day-trade-friendly multi-edge strategy. Combines GEX walls
 * (call/put wall proximity), gamma-flip side, regime classification, IV
 * percentile (rolling 20 calendar days), and skew sign into priority-ordered
 * entry rules. Each rule has its own MFE/MAE-derived stop and target.
 *
 * Origin: Phase 2 multi-edge research, variant V7DTSP13. The strategy is
 * intentionally restricted to entries between 04:00 and 13:00 ET to match
 * the user's day-trade margin window — broker liquidates open positions at
 * 4:45 PM ET, so morning-only entries leave room for targets to fill.
 *
 * Components in the name:
 *   GEX  — call/put wall proximity + regime + total gamma side
 *   FLIP — gamma flip (above vs below)
 *   IVPCT — rolling 20d IV percentile (low IV = drift longs; high IV = mean-revert shorts)
 *
 * Reference standalone results (V7DTSP13, Jan 2025–Apr 2026):
 *   197 trades, 78.9% WR, PF 5.87, $333,225 net, $6,065 max DD.
 *
 * Active rules (priority desc within side, side ties broken by priority then iteration):
 *   L1 (long, p100): putWall<=50 + ivPctile.low + skew.positive   stop 113 / tgt 198
 *   L4 (long, p90):  gex.neutral + above.gammaFlip + ivPctile.low stop 106 / tgt 187
 *   L3 (long, p80):  gex.strong_negative + above.gammaFlip        stop 184 / tgt 278
 *   S3 (short,p100): callWall<=50 + below.gammaFlip               stop 114 / tgt 196
 *   S1 (short,p90):  callWall<=50 + ivPctile.high + skew.positive stop 131 / tgt 211
 *   S2 (short,p80):  callWall<=50 + ivPctile.high                 stop 129 / tgt 211
 */

import { BaseStrategy } from './base-strategy.js';

const RULES = [
  { id: 'L1', side: 'long',  priority: 100, stopPts: 113, targetPts: 198, description: 'putWall<=50 + ivPctile.low + skew.positive' },
  { id: 'L4', side: 'long',  priority: 90,  stopPts: 106, targetPts: 187, description: 'gex.neutral + above.gammaFlip + ivPctile.low' },
  { id: 'L3', side: 'long',  priority: 80,  stopPts: 184, targetPts: 278, description: 'gex.strong_negative + above.gammaFlip' },
  { id: 'S3', side: 'short', priority: 100, stopPts: 114, targetPts: 196, description: 'callWall<=50 + below.gammaFlip' },
  { id: 'S1', side: 'short', priority: 90,  stopPts: 131, targetPts: 211, description: 'callWall<=50 + ivPctile.high + skew.positive' },
  { id: 'S2', side: 'short', priority: 80,  stopPts: 129, targetPts: 211, description: 'callWall<=50 + ivPctile.high' },
];

const DAY_MS = 24 * 60 * 60 * 1000;

export class GexFlipIvpctStrategy extends BaseStrategy {
  static getDataRequirements() {
    return {
      candles: {
        baseSymbol: 'NQ',
        quoteSymbols: ['CME_MINI:NQ1!', 'CME_MINI:MNQ1!', 'NASDAQ:QQQ']
      },
      gex: { etfSymbol: 'QQQ', futuresSymbol: 'NQ', defaultMultiplier: 41.5 },
      lt: false,
      tradier: true,
      tradierSymbols: ['QQQ'],
      ivSkew: true
    };
  }

  constructor(params = {}) {
    super(params);

    // Wall-proximity gate (used by L1, S1, S2, S3)
    this.params.wallProximity = params.wallProximity ?? 50;

    // IV percentile thresholds (rolling 20 calendar days)
    this.params.ivPctileWindowDays = params.ivPctileWindowDays ?? 20;
    this.params.ivPctileLowMax = params.ivPctileLowMax ?? 0.20;   // L1, L4: ivPctile <= 0.20
    this.params.ivPctileHighMin = params.ivPctileHighMin ?? 0.80; // S1, S2: ivPctile >= 0.80

    // Skew gate (positive skew = puts expensive)
    this.params.skewPositiveMin = params.skewPositiveMin ?? 0.015;

    // Regime gates
    this.params.neutralRegime = params.neutralRegime ?? 'neutral';
    this.params.strongNegativeRegime = params.strongNegativeRegime ?? 'strong_negative';

    // Entry window (ET hour-of-day, half-open: [start, end))
    this.params.entryWindowStartHour = params.entryWindowStartHour ?? 4;
    this.params.entryWindowEndHour = params.entryWindowEndHour ?? 13;

    // Cooldown between trades — V7DTSP13 production run used 6 5m bars = 30 minutes
    this.params.signalCooldownMs = params.signalCooldownMs ?? 30 * 60 * 1000;

    // Default max hold. The slingshot trade simulator increments barsSinceEntry
    // per-1m candle regardless of strategy timeframe, so this value is in MINUTES.
    // V7DTSP13's 120 5m bars = 600 minutes.
    // The trade-orchestrator should also force-flat at 4:45 PM ET as a
    // service-level safety against the broker auto-liquidating.
    this.params.maxHoldBars = params.maxHoldBars ?? 600;

    // Trading symbol
    this.params.tradingSymbol = params.tradingSymbol ?? 'NQ';
    this.params.defaultQuantity = params.defaultQuantity ?? 1;

    // Debug / live mode
    this.params.debug = params.debug ?? false;
    this.params.liveMode = params.liveMode ?? false;

    // IV data sources
    this.ivLoader = null;       // backtest path
    this.liveIVData = null;     // live path: most recent IV record
    this.liveIVHistory = [];    // live path: rolling buffer of {timestamp, iv}

    // Evaluation log for dashboard
    this.evaluationLog = [];
  }

  loadIVData(ivLoader) {
    this.ivLoader = ivLoader;
    if (this.params.debug) {
      const stats = ivLoader.getStats();
      console.log(`[GEX-FLIP-IVPCT] IV data loaded: ${stats.count} records, ${stats.startDate} → ${stats.endDate}`);
    }
  }

  setLiveIVData(ivData) {
    this.liveIVData = ivData;
    if (ivData && ivData.iv != null) {
      this.liveIVHistory.push({ timestamp: Date.now(), iv: ivData.iv, skew: ivData.skew });
      // Keep rolling 20-day window plus a small buffer
      const cutoff = Date.now() - (this.params.ivPctileWindowDays + 1) * DAY_MS;
      this.liveIVHistory = this.liveIVHistory.filter(s => s.timestamp >= cutoff);
    }
  }

  getIVAtTime(timestamp) {
    if (this.liveIVData) return this.liveIVData;
    if (this.ivLoader) return this.ivLoader.getIVAtTime(timestamp);
    return null;
  }

  /**
   * Rolling IV percentile over last N calendar days at-or-before the
   * reference timestamp. Returns the fraction of samples with iv <= current iv.
   */
  computeIVPercentile(timestamp) {
    const cur = this.getIVAtTime(timestamp);
    if (!cur || cur.iv == null) return null;

    const lookbackMs = this.params.ivPctileWindowDays * DAY_MS;
    const startTs = timestamp - lookbackMs;

    let samples;
    if (this.ivLoader && Array.isArray(this.ivLoader.ivData)) {
      // Backtest: scan series in window [startTs, timestamp]
      const arr = this.ivLoader.ivData;
      // Binary search lower bound
      let lo = 0, hi = arr.length - 1, startIdx = arr.length;
      while (lo <= hi) {
        const m = (lo + hi) >> 1;
        if (arr[m].timestamp >= startTs) { startIdx = m; hi = m - 1; }
        else lo = m + 1;
      }
      samples = [];
      for (let i = startIdx; i < arr.length && arr[i].timestamp <= timestamp; i++) {
        samples.push(arr[i].iv);
      }
    } else if (this.liveIVHistory.length > 0) {
      samples = this.liveIVHistory
        .filter(s => s.timestamp >= startTs && s.timestamp <= timestamp)
        .map(s => s.iv);
    } else {
      return null;
    }

    if (samples.length === 0) return null;

    let below = 0;
    for (const v of samples) if (v <= cur.iv) below++;
    return below / samples.length;
  }

  /**
   * Get ET hour-of-day for a timestamp.
   */
  getETHour(timestamp) {
    const date = new Date(timestamp);
    return parseInt(date.toLocaleString('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      hour12: false
    }));
  }

  /**
   * Half-open entry window check: entryWindowStartHour <= hour < entryWindowEndHour
   */
  isInEntryWindow(timestamp) {
    const h = this.getETHour(timestamp);
    return h >= this.params.entryWindowStartHour && h < this.params.entryWindowEndHour;
  }

  /**
   * Evaluate every rule and return the highest-priority one whose conditions fire.
   */
  findFiringRule(features) {
    let best = null;
    for (const rule of RULES) {
      if (!this._ruleFires(rule, features)) continue;
      if (!best || rule.priority > best.priority) best = rule;
    }
    return best;
  }

  _ruleFires(rule, f) {
    const { close, gamma_flip, call_wall, put_wall, regime, ivPctile, skew } = f;

    switch (rule.id) {
      case 'L1':
        return put_wall != null
          && Math.abs(close - put_wall) <= this.params.wallProximity
          && ivPctile != null && ivPctile <= this.params.ivPctileLowMax
          && skew != null && skew > this.params.skewPositiveMin;

      case 'L4':
        return regime === this.params.neutralRegime
          && gamma_flip != null && (close - gamma_flip) > 0
          && ivPctile != null && ivPctile <= this.params.ivPctileLowMax;

      case 'L3':
        return regime === this.params.strongNegativeRegime
          && gamma_flip != null && (close - gamma_flip) > 0;

      case 'S3':
        return call_wall != null
          && Math.abs(close - call_wall) <= this.params.wallProximity
          && gamma_flip != null && (close - gamma_flip) < 0;

      case 'S1':
        return call_wall != null
          && Math.abs(close - call_wall) <= this.params.wallProximity
          && ivPctile != null && ivPctile >= this.params.ivPctileHighMin
          && skew != null && skew > this.params.skewPositiveMin;

      case 'S2':
        return call_wall != null
          && Math.abs(close - call_wall) <= this.params.wallProximity
          && ivPctile != null && ivPctile >= this.params.ivPctileHighMin;

      default:
        return false;
    }
  }

  evaluateSignal(candle, prevCandle, marketData, options = {}) {
    const timestamp = this.toMs(candle.timestamp);
    const gexLevels = marketData?.gexLevels;
    const iv = this.getIVAtTime(timestamp);

    // Cooldown
    if (!this.checkCooldown(timestamp, this.params.signalCooldownMs)) {
      this.logEval(candle, iv, gexLevels, null, 'cooldown active');
      return null;
    }

    // Entry window (04:00–13:00 ET)
    if (!this.isInEntryWindow(timestamp)) {
      this.logEval(candle, iv, gexLevels, null, `outside entry window (${this.getETHour(timestamp)} ET)`);
      return null;
    }

    if (!gexLevels) {
      this.logEval(candle, iv, gexLevels, null, 'no GEX levels');
      return null;
    }
    if (!iv) {
      this.logEval(candle, iv, gexLevels, null, 'no IV data');
      return null;
    }

    const ivPctile = this.computeIVPercentile(timestamp);

    const features = {
      close: candle.close,
      gamma_flip: gexLevels.gamma_flip ?? gexLevels.gammaFlip ?? null,
      call_wall: gexLevels.call_wall ?? gexLevels.callWall ?? null,
      put_wall: gexLevels.put_wall ?? gexLevels.putWall ?? null,
      regime: gexLevels.regime ?? null,
      ivPctile,
      skew: iv.skew ?? null,
    };

    const rule = this.findFiringRule(features);
    if (!rule) {
      this.logEval(candle, iv, gexLevels, null, `no rule fires (regime=${features.regime}, ivPctile=${ivPctile?.toFixed(2)})`);
      return null;
    }

    const signal = this.createSignal(rule, candle, features, iv, gexLevels);
    this.logEval(candle, iv, gexLevels, signal, null);
    return signal;
  }

  createSignal(rule, candle, features, iv, gexLevels) {
    const timestamp = this.toMs(candle.timestamp);
    this.updateLastSignalTime(timestamp);

    const entryPrice = candle.close;
    const sign = rule.side === 'long' ? 1 : -1;
    const stopLoss = entryPrice - sign * rule.stopPts;
    const takeProfit = entryPrice + sign * rule.targetPts;

    if (this.params.debug) {
      console.log(`[GEX-FLIP-IVPCT] ${rule.id} ${rule.side.toUpperCase()} @ ${entryPrice.toFixed(2)} ` +
        `stop=${stopLoss.toFixed(2)} tgt=${takeProfit.toFixed(2)} ` +
        `ivPct=${features.ivPctile?.toFixed(2)} regime=${features.regime}`);
    }

    return {
      timestamp,
      side: rule.side,
      price: entryPrice,
      strategy: 'GEX_FLIP_IVPCT',
      action: 'place_limit',
      symbol: this.params.tradingSymbol,
      quantity: this.params.defaultQuantity,
      stopLoss,
      takeProfit,
      maxHoldBars: this.params.maxHoldBars,

      // Rule metadata
      ruleId: rule.id,
      ruleDescription: rule.description,
      rulePriority: rule.priority,
      stopPoints: rule.stopPts,
      targetPoints: rule.targetPts,

      // Feature snapshot
      ivValue: iv.iv,
      ivSkew: iv.skew,
      ivPercentile: features.ivPctile,
      gexRegime: features.regime,
      gammaFlip: features.gamma_flip,
      callWall: features.call_wall,
      putWall: features.put_wall,

      // Snake_case for trade orchestrator bracket orders
      stop_loss: stopLoss,
      take_profit: takeProfit,
    };
  }

  reset() {
    super.reset();
  }

  /**
   * Anchor the cooldown timer to the exit timestamp instead of the signal
   * timestamp. The standalone V7DTSP13 simulator counts cooldown from the
   * last exit, not from the last entry signal — so signals fired *during*
   * an open position should not reset cooldown. The engine already rejects
   * them as "position already active"; we additionally push lastSignalTime
   * forward to the exit time so cooldown unblocks at exit + cooldownMs.
   * @param {{pnl, timestamp, metadata}} info
   */
  onPositionClosed(info) {
    if (info && info.timestamp) {
      this.lastSignalTime = this.toMs(info.timestamp);
    }
  }

  getName() {
    return 'GEX_FLIP_IVPCT';
  }

  getInternalState() {
    return {
      ivPctileWindowDays: this.params.ivPctileWindowDays,
      ivPctileLowMax: this.params.ivPctileLowMax,
      ivPctileHighMin: this.params.ivPctileHighMin,
      entryWindow: `${this.params.entryWindowStartHour}-${this.params.entryWindowEndHour} ET`,
      liveIVSamples: this.liveIVHistory.length,
      evaluationLog: this.evaluationLog.slice(-10),
    };
  }

  logEval(candle, iv, gexLevels, signal, reason) {
    if (!this.params.liveMode && !this.params.debug) return;

    const ts = this.toMs(candle.timestamp);
    const timeStr = new Date(ts).toLocaleString('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit', minute: '2-digit', hour12: false
    });

    const ivStr = iv ? `IV:${(iv.iv * 100).toFixed(1)}% Skew:${(iv.skew * 100).toFixed(2)}%` : 'IV:N/A';
    const result = signal
      ? `→ ${signal.ruleId} ${signal.side.toUpperCase()} SIGNAL`
      : `→ no signal: ${reason}`;

    this.evaluationLog.push({
      time: timeStr,
      price: candle.close,
      iv: iv?.iv ?? null,
      skew: iv?.skew ?? null,
      result: signal ? `${signal.ruleId} ${signal.side.toUpperCase()}` : reason,
      fired: !!signal,
    });
    if (this.evaluationLog.length > 15) {
      this.evaluationLog = this.evaluationLog.slice(-15);
    }

    console.log(`[GEX-FLIP-IVPCT] ${timeStr} | ${candle.close.toFixed(2)} | ${ivStr} | ${result}`);
  }
}

export default GexFlipIvpctStrategy;
