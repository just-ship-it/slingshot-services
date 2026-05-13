/**
 * GEX-Touch Confirm Strategy (gex-touch-confirm)
 *
 * Bounces off any GEX level (S1-S5, R1-R5, gamma_flip, call_wall, put_wall)
 * confirmed by two orthogonal signals:
 *   1. Strong intra-minute rejection: the touch minute's close finished at
 *      least s1VwapThreshold pts above (or below) its intra-minute VWAP in
 *      the rejection direction.
 *   2. Volatile regime: ATR(14) on 1m candles is at or above atrThreshold.
 *
 * Entry: LIMIT at the level price on the next bar with a 5-minute timeout.
 *   - approach from_above + touch → LONG limit (price came down to support,
 *     wait for retest, expect bounce up).
 *   - approach from_below + touch → SHORT limit (price came up to resistance,
 *     wait for retest, expect rejection down).
 * Stop:   stopDistance pts past the level (default 15pts; 20 = higher WR).
 * Target: targetPoints pts past the level in the trade direction (default 20).
 *
 * Filter thresholds are calibrated against the 16-month wide-net touch
 * dataset (research/gex-touch-confirm/FINDINGS.md):
 *   s1VwapThreshold = 2.99 pts (population p80 of |close − VWAP|)
 *   atrThreshold    = 28.95 pts (population p90 of ATR(14))
 *
 * Phase 4 / Phase 5 expectations (Candidate B):
 *   ~359 filled trades / 16 months
 *   stop=15: ~62% WR, PF ~2.2
 *   stop=20: ~76% WR, PF ~3.17 (split-half stable: H1 70% / H2 81%)
 *
 * The s1 VWAP feature requires intra-minute 1s data. The backtest engine
 * loads it via --s1-vwap-file (CSV produced by
 * research/gex-touch-confirm/06-precompute-s1-vwap.js). In live mode, the
 * signal-generator must aggregate the 1s TradingView feed into per-minute
 * (vwap, close) and expose it via marketData.s1Features.
 */

import { BaseStrategy } from './base-strategy.js';

export class GexTouchConfirmStrategy extends BaseStrategy {
  static getDataRequirements() {
    return {
      candles: { baseSymbol: 'NQ', quoteSymbols: ['CME_MINI:NQ1!'] },
      gex: { etfSymbol: 'QQQ', futuresSymbol: 'NQ', defaultMultiplier: 41.5 },
      lt: false,
      lt1m: false,
      tradier: false,
      ivSkew: true,    // Need QQQ ATM IV for skew filter (put_iv - call_iv)
      s1Vwap: false,    // No longer required (optional secondary filter)
    };
  }

  constructor(params = {}) {
    super(params);

    this.params.tradingSymbol = params.tradingSymbol ?? 'NQ';
    this.params.defaultQuantity = params.defaultQuantity ?? 1;

    // Filter thresholds (calibrated on 2025-01-13 → 2026-04-23 dataset using
    // 1s-honest fill simulation — see research/gex-touch-confirm/01v3-build-1s-honest.js).
    // The winning composite is `touch_pinbar AND qqq_iv_skew < threshold AND
    // gex_regime in {positive, strong_positive}`:
    //   stop=10: 138 trades, 63.0% WR, PF 3.41, EV 8.91pts (Sharpe 0.616)
    //   stop=12: 138 trades, 64.5% WR, PF 3.03, EV 8.64pts
    //   stop=15: 138 trades, 67.4% WR, PF 2.76, EV 8.59pts
    //   stop=20: 138 trades, 71.5% WR, PF 2.51, EV 8.55pts
    // The triple is consistent across stop tiers — picks "shallow consolidation
    // pin-bar rejection of a GEX level under calm options skew + positive
    // gamma regime."
    // 0.0172 (just below the p10 boundary cluster at 0.0173) — using 0.0173
    // literally admits a 68-row floating-point cluster that the research strict
    // `< p10` filter excludes. Engine WR collapsed 10pp from this off-by-one.
    this.params.ivSkewThreshold = params.ivSkewThreshold ?? 0.0172;
    this.params.requirePinbar = params.requirePinbar ?? true;
    this.params.requirePositiveRegime = params.requirePositiveRegime ?? true;
    // Legacy optional filters (off by default)
    this.params.minDistThreshold = params.minDistThreshold ?? null;
    this.params.atrThreshold = params.atrThreshold ?? null;
    this.params.s1VwapThreshold = params.s1VwapThreshold ?? null;
    this.params.useS1VwapFilter = params.useS1VwapFilter ?? false;

    // Touch geometry
    this.params.touchDistance = params.touchDistance ?? 10;
    this.params.stopDistance = params.stopDistance ?? 12;  // best risk-adjusted PF tier
    this.params.targetPoints = params.targetPoints ?? 20;
    this.params.maxHoldBars = params.maxHoldBars ?? 120;
    this.params.limitTimeoutCandles = params.limitTimeoutCandles ?? 5;

    // Cooldown — defaults to 0; the 5-min limit timeout plus 1-position-at-
    // a-time concurrency already provides natural friction.
    this.params.signalCooldownMs = params.signalCooldownMs ?? 0;

    // RTH entry window (9:30-16:00 ET) — matches the Phase 1 research scope.
    this.params.entryWindowStartHour = params.entryWindowStartHour ?? 9;
    this.params.entryWindowStartMinute = params.entryWindowStartMinute ?? 30;
    this.params.entryWindowEndHour = params.entryWindowEndHour ?? 16;
    this.params.entryWindowEndMinute = params.entryWindowEndMinute ?? 0;
    this.params.disableEntryWindow = params.disableEntryWindow ?? false;
    this.params.blockedHoursEt = new Set(params.blockedHoursEt ?? []);

    // EOD cutoff mirror (purely informational for the panel; trade-orchestrator
    // enforces actual flatten)
    this.params.eodCutoffEt = params.eodCutoffEt ?? '16:40';

    // GEX snapshot lookback: research applied a 16-min lag to be defensive
    // around the pre-fix bucketing lookahead. Post-fix, snapshots are honestly
    // dated, but the filter thresholds (s1VwapThreshold, atrThreshold) were
    // calibrated against the research touch dataset which uses 16-min lag.
    // Set to 0 for fresh-GEX (requires re-tuning); 16 for parity with research.
    this.params.snapLagMin = params.snapLagMin ?? 16;

    this.params.debug = params.debug ?? false;

    // Allow optional breakeven / trailing layering (default off)
    this.params.breakevenTrigger = params.breakevenTrigger ?? 0;
    this.params.breakevenOffset = params.breakevenOffset ?? 0;
    this.params.trailingTrigger = params.trailingTrigger ?? 0;
    this.params.trailingOffset = params.trailingOffset ?? 0;

    // Internal state
    this._candleBuffer = [];      // last up to 15 candles for ATR(14) (only if used)
    this._currentSymbol = null;
    this._lastTouchByLevel = new Map();
    this._ivLoader = null;        // injected by engine via loadIVData()

    // Diagnostics
    this.lastUpdateTs = null;
    this.lastEvalLog = [];
  }

  /**
   * Called by the engine at startup to inject the IV loader for QQQ ATM IV
   * skew lookup. The IV loader exposes getIVAtTime(timestampMs) which returns
   * { callIV, putIV, skew, ... } or null.
   */
  loadIVData(ivLoader) {
    this._ivLoader = ivLoader;
  }

  reset() {
    super.reset();
    this._candleBuffer = [];
    this._currentSymbol = null;
    this._lastTouchByLevel.clear();
    this.lastUpdateTs = null;
    this.lastEvalLog = [];
  }

  // ────────────────────────────────────────────────────────────────────────
  // ET conversion (lightweight, used only for entry-window gating)
  // ────────────────────────────────────────────────────────────────────────
  _toEt(ts) {
    const d = new Date(ts);
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour12: false,
      hour: '2-digit', minute: '2-digit', weekday: 'short',
    }).formatToParts(d);
    const hour = parseInt(parts.find(p => p.type === 'hour')?.value || '0', 10) % 24;
    const minute = parseInt(parts.find(p => p.type === 'minute')?.value || '0', 10);
    const weekday = parts.find(p => p.type === 'weekday')?.value || '';
    return { hour, minute, timeInMinutes: hour * 60 + minute, weekday };
  }

  _isInEntryWindow(et) {
    if (this.params.blockedHoursEt.has(et.hour)) return false;
    if (et.weekday === 'Sat' || et.weekday === 'Sun') return false;
    if (this.params.disableEntryWindow) return true;
    const startMin = this.params.entryWindowStartHour * 60 + this.params.entryWindowStartMinute;
    const endMin = this.params.entryWindowEndHour * 60 + this.params.entryWindowEndMinute;
    return et.timeInMinutes >= startMin && et.timeInMinutes < endMin;
  }

  // ────────────────────────────────────────────────────────────────────────
  // ATR(14) on the in-strategy candle buffer. Uses simple moving average of
  // true range (matches Phase 2's ATR convention).
  // Returns null until 14 bars have been seen on the current symbol.
  // ────────────────────────────────────────────────────────────────────────
  _computeAtr() {
    if (this._candleBuffer.length < 15) return null;  // need 14 TRs (=15 closes)
    const trs = [];
    for (let i = 1; i < this._candleBuffer.length; i++) {
      const cur = this._candleBuffer[i];
      const prev = this._candleBuffer[i - 1];
      const tr = Math.max(
        cur.high - cur.low,
        Math.abs(cur.high - prev.close),
        Math.abs(cur.low - prev.close),
      );
      trs.push(tr);
    }
    // Use the most recent 14
    const last14 = trs.slice(-14);
    return last14.reduce((s, v) => s + v, 0) / last14.length;
  }

  // ────────────────────────────────────────────────────────────────────────
  // Flatten a GEX snapshot into [{ type, price, isResistance, gex }].
  // Tolerates both snake_case (cbbo loader) and camelCase (live).
  // ────────────────────────────────────────────────────────────────────────
  _gexLevels(g) {
    const out = [];
    if (!g) return out;
    const cw = g.call_wall ?? g.callWall;
    const pw = g.put_wall ?? g.putWall;
    const gf = g.gamma_flip ?? g.gammaFlip;
    if (cw != null) out.push({ type: 'call_wall', price: cw, isResistance: true });
    if (pw != null) out.push({ type: 'put_wall', price: pw, isResistance: false });
    if (gf != null) out.push({ type: 'gamma_flip', price: gf, isResistance: null });
    const resistance = g.resistance || [];
    for (let i = 0; i < resistance.length; i++) {
      if (resistance[i] != null) out.push({ type: `R${i + 1}`, price: resistance[i], isResistance: true });
    }
    const support = g.support || [];
    for (let i = 0; i < support.length; i++) {
      if (support[i] != null) out.push({ type: `S${i + 1}`, price: support[i], isResistance: false });
    }
    return out;
  }

  // ────────────────────────────────────────────────────────────────────────
  // Main evaluation — called per 1m candle by the engine.
  //
  // Inputs:
  //   candle:     { timestamp, open, high, low, close, volume, symbol }
  //   prevCandle: previous 1m candle (same shape) — used for approach detection
  //   marketData: { gexLevels, s1Features: { vwap_close_diff }, ... }
  //   options:    {}
  // ────────────────────────────────────────────────────────────────────────
  evaluateSignal(candle, prevCandle, marketData, options = {}) {
    const ts = this.toMs(candle.timestamp);
    this.lastUpdateTs = ts;

    // ── 1. Update candle buffer (used for ATR) ───────────────────────────
    if (candle.symbol && this._currentSymbol && candle.symbol !== this._currentSymbol) {
      // Contract rollover — reset ATR seeding. Safe default; ATR will return
      // null until 14 bars have accumulated on the new contract.
      this._candleBuffer = [];
    }
    if (candle.symbol) this._currentSymbol = candle.symbol;
    this._candleBuffer.push({
      open: candle.open, high: candle.high, low: candle.low, close: candle.close,
    });
    if (this._candleBuffer.length > 15) this._candleBuffer.shift();

    // ── 2. Gate: entry window ────────────────────────────────────────────
    const et = this._toEt(ts);
    if (!this._isInEntryWindow(et)) {
      return this._logEval(ts, 'outside_window');
    }

    // ── 3. Gate: cooldown ────────────────────────────────────────────────
    if (!this.checkCooldown(ts, this.params.signalCooldownMs)) {
      return this._logEval(ts, 'cooldown');
    }

    // ── 4. Need prev close for approach + GEX levels ─────────────────────
    if (!prevCandle) return this._logEval(ts, 'no_prev');

    // Apply SNAP_LAG to GEX lookup. Defaults to 16min for parity with the
    // research touch dataset that calibrated the filter thresholds.
    let gexSnap = null;
    if (this.params.snapLagMin > 0 && marketData?.gexLoader) {
      const lagTs = ts - this.params.snapLagMin * 60000;
      gexSnap = marketData.gexLoader.getGexLevels(new Date(lagTs));
    }
    if (!gexSnap) gexSnap = marketData?.gexLevels;  // fallback to fresh
    const gexLevels = this._gexLevels(gexSnap);
    if (!gexLevels.length) return this._logEval(ts, 'no_gex');

    // ── 5. Regime gate (gex_regime must be positive) ─────────────────────
    if (this.params.requirePositiveRegime) {
      const regime = gexSnap?.regime || marketData?.gexLevels?.regime;
      if (regime !== 'positive' && regime !== 'strong_positive') {
        return this._logEval(ts, `regime=${regime}`);
      }
    }

    // ── 6. IV skew gate (QQQ put_iv − call_iv must be < threshold) ───────
    let ivSkew = null;
    if (this._ivLoader) {
      const ivRec = this._ivLoader.getIVAtTime(ts);
      if (ivRec && ivRec.skew != null) ivSkew = ivRec.skew;
    }
    if (ivSkew == null) return this._logEval(ts, 'iv_missing');
    if (ivSkew >= this.params.ivSkewThreshold) return this._logEval(ts, 'iv_skew_high');

    // ── 7. Find touched levels and compute pinbar geometry per level ─────
    const range = candle.high - candle.low;
    const body = Math.abs(candle.close - candle.open);
    const upperWick = candle.high - Math.max(candle.open, candle.close);
    const lowerWick = Math.min(candle.open, candle.close) - candle.low;

    const touched = [];
    for (const lvl of gexLevels) {
      const inside = candle.low <= lvl.price && lvl.price <= candle.high;
      const distLow = Math.abs(candle.low - lvl.price);
      const distHigh = Math.abs(candle.high - lvl.price);
      const edgeMin = Math.min(distLow, distHigh);
      if (edgeMin > this.params.touchDistance) continue;
      let approach;
      if (prevCandle.close > lvl.price) approach = 'from_above';
      else if (prevCandle.close < lvl.price) approach = 'from_below';
      else continue;
      // Rejection wick is the wick on the approached side.
      // from_above: price came DOWN to level → rejection = lower wick
      // from_below: price came UP to level → rejection = upper wick
      const rejWick = approach === 'from_above' ? lowerWick : upperWick;
      const isPinbar = body > 0 ? (rejWick >= 2 * body) : (rejWick > 0);
      touched.push({ lvl, approach, isPinbar, edgeMin, minDist: inside ? 0 : edgeMin });
    }
    if (!touched.length) return this._logEval(ts, 'no_touch');

    // ── 8. Pinbar gate + pick the nearest touch that passes ──────────────
    // (optional ATR / min_dist / s1 filters preserved for tuning experiments
    // but default-off in the production config)
    const atr14 = (this.params.atrThreshold != null) ? this._computeAtr() : null;
    if (this.params.atrThreshold != null) {
      if (atr14 == null) return this._logEval(ts, 'atr_unseeded');
      if (atr14 < this.params.atrThreshold) return this._logEval(ts, 'atr_below');
    }
    let rawVwapDiff = null;
    if (this.params.useS1VwapFilter) {
      rawVwapDiff = marketData?.s1Features?.vwap_close_diff;
      if (rawVwapDiff == null) return this._logEval(ts, 's1_missing');
    }
    touched.sort((a, b) => a.edgeMin - b.edgeMin);  // closest touch first
    let chosen = null;
    for (const t of touched) {
      if (this.params.requirePinbar && !t.isPinbar) continue;
      if (this.params.minDistThreshold != null && t.minDist < this.params.minDistThreshold) continue;
      if (this.params.useS1VwapFilter && this.params.s1VwapThreshold != null) {
        const signedS1 = t.approach === 'from_above' ? rawVwapDiff : -rawVwapDiff;
        if (signedS1 < this.params.s1VwapThreshold) continue;
      }
      chosen = t;
      break;
    }
    if (!chosen) return this._logEval(ts, 'filter_below');

    const side = chosen.approach === 'from_above' ? 'long' : 'short';
    const sign = side === 'long' ? 1 : -1;
    const entryPrice = chosen.lvl.price;
    const stopLoss = entryPrice - sign * this.params.stopDistance;
    const takeProfit = entryPrice + sign * this.params.targetPoints;

    this.updateLastSignalTime(ts);

    if (this.params.debug) {
      console.log(`[GEX-TOUCH-CONFIRM] ${side.toUpperCase()} ${chosen.lvl.type}@${entryPrice.toFixed(2)} ` +
        `approach=${chosen.approach} signedS1=${chosen.signedS1.toFixed(2)} atr=${atr14.toFixed(2)} ` +
        `stop=${stopLoss.toFixed(2)} tgt=${takeProfit.toFixed(2)}`);
    }

    const signal = {
      timestamp: ts,
      side,
      price: entryPrice,
      strategy: 'GEX_TOUCH_CONFIRM',
      action: 'place_limit',
      timeoutCandles: this.params.limitTimeoutCandles,
      symbol: this.params.tradingSymbol,
      quantity: this.params.defaultQuantity,
      stopLoss,
      takeProfit,
      maxHoldBars: this.params.maxHoldBars,
      // Diagnostics for the trade record
      levelType: chosen.lvl.type,
      levelPrice: entryPrice,
      approach: chosen.approach,
      minDistToLevel: chosen.minDist,
      isPinbar: chosen.isPinbar,
      ivSkew,
      regime: gexSnap?.regime ?? marketData?.gexLevels?.regime ?? null,
      atr14: atr14 ?? null,
      stopDistance: this.params.stopDistance,
      targetPoints: this.params.targetPoints,
      // Mirror keys for orchestrator
      stop_loss: stopLoss,
      take_profit: takeProfit,
    };

    if (this.params.breakevenTrigger) {
      signal.breakevenStop = true;
      signal.breakevenTrigger = this.params.breakevenTrigger;
      signal.breakevenOffset = this.params.breakevenOffset;
    }
    if (this.params.trailingTrigger && this.params.trailingOffset) {
      signal.trailingTrigger = this.params.trailingTrigger;
      signal.trailingOffset = this.params.trailingOffset;
    }

    this._logEval(ts, null, signal);
    return signal;
  }

  onPositionClosed(info) {
    if (info?.timestamp) this.lastSignalTime = this.toMs(info.timestamp);
  }

  _logEval(ts, blockedReason, signal = null) {
    const time = new Date(ts).toLocaleString('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
    this.lastEvalLog.push({
      ts, time, blockedReason, fired: !!signal,
      side: signal?.side ?? null, level: signal?.levelType ?? null,
    });
    if (this.lastEvalLog.length > 15) this.lastEvalLog = this.lastEvalLog.slice(-15);
    return signal;
  }

  getName() {
    return 'GEX_TOUCH_CONFIRM';
  }

  getInternalState() {
    return {
      s1VwapThreshold: this.params.s1VwapThreshold,
      atrThreshold: this.params.atrThreshold,
      touchDistance: this.params.touchDistance,
      stopDistance: this.params.stopDistance,
      targetPoints: this.params.targetPoints,
      limitTimeoutCandles: this.params.limitTimeoutCandles,
      maxHoldBars: this.params.maxHoldBars,
      signalCooldownMs: this.params.signalCooldownMs,
      entryWindowStartHour: this.params.entryWindowStartHour,
      entryWindowStartMinute: this.params.entryWindowStartMinute,
      entryWindowEndHour: this.params.entryWindowEndHour,
      entryWindowEndMinute: this.params.entryWindowEndMinute,
      atrBufferDepth: this._candleBuffer.length,
      currentSymbol: this._currentSymbol,
      lastUpdateTs: this.lastUpdateTs,
      lastEvalLog: this.lastEvalLog.slice(-10),
    };
  }
}

export default GexTouchConfirmStrategy;
