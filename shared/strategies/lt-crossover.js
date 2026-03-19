/**
 * LT Crossover Strategy
 *
 * Trades based on LT34 (level_1) and LT55 (level_2) crossing through spot
 * price during the overnight session (6PM-8AM EST).
 *
 * Signal logic:
 *   - Level crossing UNDER spot (level drops through price) → BULLISH (support forming)
 *   - Level crossing OVER spot (level rises through price)  → BEARISH (resistance stacking)
 *
 * Entry:
 *   LONGS:  Limit order at candle open where crossing occurred
 *   SHORTS: Limit order at max(open, close) of signal candle (better fill)
 *
 * Scaling:
 *   First LT34 or LT55 cross → 1 contract
 *   Second cross (other level, same direction, within 15 min) → add 1 contract
 *   "bothRequired" mode: only enter when both cross within 15 min (higher quality, fewer trades)
 *
 * Exit:
 *   Wide initial stop (default 70pt) + MFE ratchet (lock % of profit at tier thresholds)
 *
 * Research results (2023-2025, overnight NQ):
 *   - bothRequired mode: 149 trades, 84.6% WR, PF 3.36, +17.2 avg pts, MaxDD 155
 *   - anyLT mode:        739 trades, 80.9% WR, PF 1.48, +5.2 avg pts, MaxDD 481
 *
 * Usage (backtest):
 *   node index.js --ticker NQ --strategy lt-crossover --mfe-ratchet --stop-loss-points 70
 */

import { BaseStrategy } from './base-strategy.js';
import { roundToNQTick } from './strategy-utils.js';

export class LTCrossoverStrategy extends BaseStrategy {
  constructor(params = {}) {
    super(params);

    this.defaultParams = {
      // Which levels to track for crossings
      trackLT34: true,        // level_1 (fib34 lookback)
      trackLT55: true,        // level_2 (fib55 lookback)

      // Entry mode
      requireBoth: false,     // true = only enter when BOTH LT34+LT55 cross within window
      bothWindowMs: 15 * 60 * 1000,  // 15 min window for simultaneous crossings

      // Stop/target
      stopLossPoints: 70,
      takeProfitPoints: 0,    // 0 = no fixed target (use MFE ratchet via --mfe-ratchet)

      // Limit order expiry
      timeoutCandles: 3,      // Cancel unfilled limit orders after N candles (15m = 45 min)

      // Session
      maxHoldBars: 840,
      signalCooldownMs: 60000,

      // Block early-session noise (optional)
      blockHoursStart: 0,     // EST hour to start blocking (0 = disabled)
      blockHoursEnd: 0,       // EST hour to stop blocking

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

    // Previous LT snapshot for crossing detection
    this._prevLT = null;
    this._prevSpot = null;
    this._prevLTTimestamp = 0;

    // Pending crossing state — track individual level crossings
    this._pendingCross = null;  // { dir, level, ts, candleOpen, candleClose, candleHigh, candleLow }
    this._emittedSignal = false;
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

  // ── Crossing detection (LT34 + LT55 only) ──

  _detectLTCrossings(prevLT, currLT, prevSpot, currSpot) {
    const crossings = [];

    const levels = [];
    if (this.params.trackLT34) levels.push({ key: 'level_1', name: 'LT34' });
    if (this.params.trackLT55) levels.push({ key: 'level_2', name: 'LT55' });

    for (const { key, name } of levels) {
      const prevLevel = prevLT[key];
      const currLevel = currLT[key];
      if (prevLevel == null || currLevel == null) continue;

      const prevAbove = prevLevel > prevSpot;
      const currAbove = currLevel > currSpot;
      if (prevAbove === currAbove) continue;

      // "under" = level dropped through price → bullish
      // "over"  = level rose through price → bearish
      const dir = (prevAbove && !currAbove) ? 'under' : 'over';
      crossings.push({ dir, level: name });
    }

    return crossings;
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
      this._pendingCross = null;
      this._prevLT = null;
      this._prevSpot = null;
      this._prevLTTimestamp = 0;
    }
    this._inRTH = isRTH;

    if (!isOvernight) return null;
    if (!ltLevels) return null;

    // Skip roll weeks
    if (this._isRollWeek(ts)) return null;

    // Check for new LT snapshot
    const ltTs = ltLevels.timestamp || 0;
    if (ltTs <= this._prevLTTimestamp) return null;

    // Use close price as spot — it's closest to the actual price when the LT
    // snapshot was recorded (end of the bar). Midpoint of high/low on 15m candles
    // creates phantom crossings due to the wide range.
    const currSpot = candle.close;

    // Detect crossings
    let newCrossings = [];
    if (this._prevLT && this._prevSpot != null) {
      newCrossings = this._detectLTCrossings(this._prevLT, ltLevels, this._prevSpot, currSpot);
    }

    // Update state
    this._prevLT = { level_1: ltLevels.level_1, level_2: ltLevels.level_2 };
    this._prevSpot = currSpot;
    this._prevLTTimestamp = ltTs;

    if (!this._overnightActive) this._overnightActive = true;

    if (newCrossings.length === 0) {
      // Check if pending cross expired (outside bothWindowMs)
      if (this._pendingCross && (ts - this._pendingCross.ts) > this.params.bothWindowMs) {
        // In requireBoth mode, pending expired without confirmation → no trade
        if (this.params.requireBoth) {
          this._pendingCross = null;
        }
        // In anyLT mode, the pending already fired a signal, so just clear
        if (!this.params.requireBoth) {
          this._pendingCross = null;
        }
      }
      return null;
    }

    // Process new crossings
    for (const cross of newCrossings) {
      // Hour block filter
      if (this.params.blockHoursStart > 0 && estHour >= this.params.blockHoursStart && estHour < this.params.blockHoursEnd) {
        continue;
      }

      // Check if this direction already signalled tonight
      const isLongSignal = cross.dir === 'under';
      if (isLongSignal && this._signalledLongTonight) continue;
      if (!isLongSignal && this._signalledShortTonight) continue;

      if (this.params.requireBoth) {
        // ── requireBoth mode ──
        // Need both LT34 and LT55 to cross in same direction within window
        if (this._pendingCross && this._pendingCross.dir === cross.dir && this._pendingCross.level !== cross.level) {
          if ((ts - this._pendingCross.ts) <= this.params.bothWindowMs) {
            if (!this.checkCooldown(ts, this.params.signalCooldownMs)) continue;

            if (isLongSignal) this._signalledLongTonight = true;
            else this._signalledShortTonight = true;
            this.updateLastSignalTime(ts);
            this._pendingCross = null;

            return this._buildSignal(cross.dir, candle, ts, estHour, 'both');
          } else {
            this._pendingCross = { dir: cross.dir, level: cross.level, ts };
          }
        } else {
          this._pendingCross = { dir: cross.dir, level: cross.level, ts };
        }
      } else {
        // ── anyLT mode ──
        if (!this.checkCooldown(ts, this.params.signalCooldownMs)) continue;

        if (isLongSignal) this._signalledLongTonight = true;
        else this._signalledShortTonight = true;
        this.updateLastSignalTime(ts);

        return this._buildSignal(cross.dir, candle, ts, estHour, cross.level);
      }
    }

    return null;
  }

  _buildSignal(dir, candle, ts, estHour, triggerLevel) {
    const isLong = dir === 'under';  // level dropped through price → buy
    const side = isLong ? 'buy' : 'sell';

    // Entry price logic:
    //   Longs:  limit at candle open (where crossing occurred)
    //   Shorts: limit at max(open, close) — get a better fill
    const entryPrice = isLong
      ? roundToNQTick(candle.open)
      : roundToNQTick(Math.max(candle.open, candle.close));

    const stopLoss = isLong
      ? roundToNQTick(entryPrice - this.params.stopLossPoints)
      : roundToNQTick(entryPrice + this.params.stopLossPoints);

    const takeProfit = this.params.takeProfitPoints > 0
      ? (isLong
        ? roundToNQTick(entryPrice + this.params.takeProfitPoints)
        : roundToNQTick(entryPrice - this.params.takeProfitPoints))
      : undefined;

    return {
      strategy: 'LT_CROSSOVER',
      action: 'place_limit',
      side,
      symbol: this.params.tradingSymbol,
      price: entryPrice,
      stop_loss: stopLoss,
      take_profit: takeProfit,
      quantity: this.params.defaultQuantity,
      maxHoldBars: this.params.maxHoldBars,
      timeoutCandles: this.params.timeoutCandles,
      timestamp: new Date(ts).toISOString(),
      metadata: {
        crossDirection: dir,
        triggerLevel,
        entry_hour: Math.round(estHour * 100) / 100,
        stop_points: this.params.stopLossPoints,
      },
    };
  }

  reset() {
    super.reset();
    this._initState();
  }

  getName() { return 'LT_CROSSOVER'; }
  getDescription() { return 'LT34/LT55 crossover strategy — overnight mean-reversion via liquidity level crossings'; }
  getRequiredMarketData() { return ['ltLevels']; }

  validateParams(params) {
    const errors = [];
    if (params.stopLossPoints <= 0) errors.push('stopLossPoints must be > 0');
    if (!params.trackLT34 && !params.trackLT55) errors.push('Must track at least one of LT34 or LT55');
    return { valid: errors.length === 0, errors };
  }
}
