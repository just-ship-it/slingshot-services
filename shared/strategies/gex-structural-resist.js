/**
 * GEX Structural Resistance / Support Strategy (gex-structural-resist / gsr)
 *
 * Premise (per user research 2026-05-14):
 *   The first touch of a GEX level tells us nothing. What we want is a
 *   STRUCTURAL setup — a swing high (for resistance) or swing low (for support)
 *   that has been tested multiple times in the recent past without breaking.
 *   At the next touch of that validated swing, enter with a structural stop
 *   and let winners run via trailing.
 *
 * Detection:
 *   1. Maintain a rolling LOOKBACK_MIN buffer of recent 1m candles
 *   2. On each new candle, if price is within TOUCH_DISTANCE of a GEX
 *      resistance level (R1-R5/call_wall) AND the candle approaches from below:
 *      a. Find swing high = max(high) in the past LOOKBACK_MIN minutes
 *      b. Count rejections: bars where high >= swingHigh - REJ_RADIUS
 *         AND close < swingHigh - 1
 *      c. Require rejections >= MIN_REJECTIONS
 *      d. Require current bar IS at the swing (high >= swingHigh - REJ_RADIUS)
 *   3. If validated, fire SHORT at touch close with:
 *      - Stop = swingHigh + STOP_BUFFER (typically 5pt above the highest wick)
 *      - Target = small fixed (initial), but use trailing to let it run
 *
 * Mirror for support (LONG bounces) is supported via params.tradeSupport but
 * off by default — research showed support side WR was lower.
 *
 * Engine-tested numbers (research approximation, T15/Tr30/O15/H60):
 *   ~290 trades/yr, ~38% WR, ~$56k/yr/contract gross. Pending engine validation.
 */

import { BaseStrategy } from './base-strategy.js';

const SUPPORT_TYPES = new Set(['S1','S2','S3','S4','S5','put_wall']);
const RESIST_TYPES = new Set(['R1','R2','R3','R4','R5','call_wall']);

export class GexStructuralResistStrategy extends BaseStrategy {
  static dataRequirements() {
    return {
      candles: { baseSymbol: 'NQ', quoteSymbols: ['CME_MINI:NQ1!'] },
      gex: { etfSymbol: 'QQQ', futuresSymbol: 'NQ', defaultMultiplier: 41.5 },
      lt: false, lt1m: false, tradier: false, ivSkew: false, s1Vwap: false,
    };
  }

  constructor(params = {}) {
    super(params);
    this.params.tradingSymbol = params.tradingSymbol ?? 'NQ';
    this.params.defaultQuantity = params.defaultQuantity ?? 1;
    this.params.touchDistance = params.touchDistance ?? 10;
    this.params.lookbackMin = params.lookbackMin ?? 30;
    this.params.minRejections = params.minRejections ?? 2;
    this.params.rejRadius = params.rejRadius ?? 3;            // wick within N pt of swing
    this.params.rejCloseBuffer = params.rejCloseBuffer ?? 1;  // close at least N pt away from swing
    this.params.stopBuffer = params.stopBuffer ?? 5;          // stop N pt past swing
    this.params.maxStopPts = params.maxStopPts ?? 30;
    this.params.snapLagMin = params.snapLagMin ?? 16;
    // Trade direction config — research showed resistance shorts > support longs
    this.params.tradeResistance = params.tradeResistance ?? true;
    this.params.tradeSupport = params.tradeSupport ?? false;
    // Gamma regime filter — research showed pos-gamma cells had positive EV at structural
    // resists. Set to null to disable.
    this.params.requireRegime = params.requireRegime ?? null;  // 'positive' | 'negative' | null
    // Target sizing
    this.params.targetPoints = params.targetPoints ?? 20;
    this.params.maxHoldBars = params.maxHoldBars ?? 60;       // 60 1m bars = 60 minutes
    // Engine-handled trailing/breakeven
    this.params.trailingTrigger = params.trailingTrigger ?? 30;
    this.params.trailingOffset = params.trailingOffset ?? 15;
    this.params.breakevenTrigger = params.breakevenTrigger ?? 0;
    this.params.breakevenOffset = params.breakevenOffset ?? 0;
    // Entry window
    this.params.entryWindowStartHour = params.entryWindowStartHour ?? 7;
    this.params.entryWindowStartMinute = params.entryWindowStartMinute ?? 0;
    this.params.entryWindowEndHour = params.entryWindowEndHour ?? 16;
    this.params.entryWindowEndMinute = params.entryWindowEndMinute ?? 0;
    this.params.disableEntryWindow = params.disableEntryWindow ?? false;
    this.params.eodCutoffEt = params.eodCutoffEt ?? '16:40';
    this.params.signalCooldownMs = params.signalCooldownMs ?? 0;
    this.params.debug = params.debug ?? false;

    // Rolling candle buffer
    this._recentBars = [];   // {ts, open, high, low, close, volume}
    this._lastTriggerByLevel = new Map();  // level-key -> ts (avoid re-firing same swing repeatedly)
    this.lastUpdateTs = null;
  }

  reset() {
    super.reset();
    this._recentBars = [];
    this._lastTriggerByLevel = new Map();
    this.lastUpdateTs = null;
  }

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
    if (et.weekday === 'Sat' || et.weekday === 'Sun') return false;
    if (this.params.disableEntryWindow) return true;
    const startMin = this.params.entryWindowStartHour * 60 + this.params.entryWindowStartMinute;
    const endMin = this.params.entryWindowEndHour * 60 + this.params.entryWindowEndMinute;
    return et.timeInMinutes >= startMin && et.timeInMinutes < endMin;
  }

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

  _isResistance(lvl, approach) {
    if (lvl.type === 'gamma_flip') return approach === 'from_below';
    return RESIST_TYPES.has(lvl.type);
  }
  _isSupport(lvl, approach) {
    if (lvl.type === 'gamma_flip') return approach === 'from_above';
    return SUPPORT_TYPES.has(lvl.type);
  }

  /**
   * Find swing high in recent buffer and count rejections.
   * Returns { swingHigh, rejections } or null if buffer too short.
   */
  _analyzeResistanceSwing() {
    const bars = this._recentBars;
    if (bars.length < 5) return null;
    let swingHigh = -Infinity;
    for (const b of bars) if (b.high > swingHigh) swingHigh = b.high;
    let rejections = 0;
    for (const b of bars) {
      if (b.high >= swingHigh - this.params.rejRadius && b.close < swingHigh - this.params.rejCloseBuffer) {
        rejections++;
      }
    }
    return { swingHigh, rejections };
  }
  _analyzeSupportSwing() {
    const bars = this._recentBars;
    if (bars.length < 5) return null;
    let swingLow = Infinity;
    for (const b of bars) if (b.low < swingLow) swingLow = b.low;
    let rejections = 0;
    for (const b of bars) {
      if (b.low <= swingLow + this.params.rejRadius && b.close > swingLow + this.params.rejCloseBuffer) {
        rejections++;
      }
    }
    return { swingLow, rejections };
  }

  evaluateSignal(candle, prevCandle, marketData, options = {}) {
    if (!candle) return null;
    const ts = this.toMs(candle.timestamp);
    if (this.lastUpdateTs === ts) return this._lastEvalSignal;

    const et = this._toEt(ts);
    this.lastUpdateTs = ts;

    // Append to recent bars, trim to lookback window
    const lookbackMs = this.params.lookbackMin * 60_000;
    this._recentBars.push({ ts, open: candle.open, high: candle.high, low: candle.low, close: candle.close, volume: candle.volume || 0 });
    this._recentBars = this._recentBars.filter(b => ts - b.ts <= lookbackMs);

    if (!this._isInEntryWindow(et)) { this._lastEvalSignal = null; return null; }

    if (!prevCandle) { this._lastEvalSignal = null; return null; }

    // Get GEX snapshot
    let gex = null;
    if (marketData?.gexLoader) {
      const lagTs = ts - this.params.snapLagMin * 60_000;
      gex = marketData.gexLoader.getGexLevels(new Date(lagTs)) || marketData.gexLevels;
    } else if (marketData?.gexLevels) {
      gex = marketData.gexLevels;
    }
    if (!gex) { this._lastEvalSignal = null; return null; }

    // Regime filter (if set)
    if (this.params.requireRegime && gex.regime !== this.params.requireRegime
        && gex.regime !== `strong_${this.params.requireRegime}`) {
      this._lastEvalSignal = null; return null;
    }

    const levels = this._gexLevels(gex);

    // ── RESISTANCE side (SHORT setups) ──
    if (this.params.tradeResistance) {
      // Find any resistance level the current bar touched (within TOUCH_DISTANCE)
      for (const lvl of levels) {
        if (lvl.price == null || isNaN(lvl.price)) continue;
        const distLow = Math.abs(candle.low - lvl.price);
        const distHigh = Math.abs(candle.high - lvl.price);
        const inside = candle.low <= lvl.price && lvl.price <= candle.high;
        const edgeMin = Math.min(distLow, distHigh);
        if (!inside && edgeMin > this.params.touchDistance) continue;
        if (!(prevCandle.close < lvl.price)) continue;  // approach from below
        if (!this._isResistance(lvl, 'from_below')) continue;

        // Validated swing high check
        const sw = this._analyzeResistanceSwing();
        if (!sw) continue;
        const { swingHigh, rejections } = sw;
        if (rejections < this.params.minRejections) continue;
        // Current bar must be at the swing
        if (candle.high < swingHigh - this.params.rejRadius) continue;
        // De-dup: don't re-fire on same swing within 30min
        const key = `${swingHigh.toFixed(2)}|R`;
        const lastFireTs = this._lastTriggerByLevel.get(key);
        if (lastFireTs != null && ts - lastFireTs < 30 * 60_000) continue;

        // Build signal
        const entryPrice = candle.close;
        const stopLoss = swingHigh + this.params.stopBuffer;
        const stopDist = stopLoss - entryPrice;
        if (stopDist > this.params.maxStopPts || stopDist <= 0) continue;
        if (!this.checkCooldown(ts, this.params.signalCooldownMs)) continue;

        const takeProfit = entryPrice - this.params.targetPoints;
        this._lastTriggerByLevel.set(key, ts);
        this.updateLastSignalTime(ts);

        const signal = {
          timestamp: ts,
          side: 'short',
          price: entryPrice,
          strategy: 'GEX_STRUCTURAL_RESIST',
          action: 'place_market',
          symbol: this.params.tradingSymbol,
          quantity: this.params.defaultQuantity,
          stopLoss, takeProfit,
          maxHoldBars: this.params.maxHoldBars,
          // Diagnostics
          levelType: lvl.type,
          levelPrice: lvl.price,
          swingHigh,
          rejections,
          regime: gex.regime,
          stopDistance: stopDist,
          // Mirror keys
          stop_loss: stopLoss, take_profit: takeProfit,
        };
        if (this.params.trailingTrigger && this.params.trailingOffset) {
          signal.trailingTrigger = this.params.trailingTrigger;
          signal.trailingOffset = this.params.trailingOffset;
        }
        if (this.params.breakevenTrigger) {
          signal.breakevenStop = true;
          signal.breakevenTrigger = this.params.breakevenTrigger;
          signal.breakevenOffset = this.params.breakevenOffset ?? 0;
        }
        if (this.params.debug) {
          console.log(`[GSR] SHORT ${lvl.type}@${lvl.price.toFixed(2)} swingHigh=${swingHigh.toFixed(2)} rej=${rejections} entry=${entryPrice.toFixed(2)} sl=${stopLoss.toFixed(2)} (stopDist=${stopDist.toFixed(1)})`);
        }
        this._lastEvalSignal = signal;
        return signal;
      }
    }

    // ── SUPPORT side (LONG setups) — mirror, off by default ──
    if (this.params.tradeSupport) {
      for (const lvl of levels) {
        if (lvl.price == null || isNaN(lvl.price)) continue;
        const distLow = Math.abs(candle.low - lvl.price);
        const distHigh = Math.abs(candle.high - lvl.price);
        const inside = candle.low <= lvl.price && lvl.price <= candle.high;
        const edgeMin = Math.min(distLow, distHigh);
        if (!inside && edgeMin > this.params.touchDistance) continue;
        if (!(prevCandle.close > lvl.price)) continue;  // approach from above
        if (!this._isSupport(lvl, 'from_above')) continue;

        const sw = this._analyzeSupportSwing();
        if (!sw) continue;
        const { swingLow, rejections } = sw;
        if (rejections < this.params.minRejections) continue;
        if (candle.low > swingLow + this.params.rejRadius) continue;
        const key = `${swingLow.toFixed(2)}|S`;
        const lastFireTs = this._lastTriggerByLevel.get(key);
        if (lastFireTs != null && ts - lastFireTs < 30 * 60_000) continue;

        const entryPrice = candle.close;
        const stopLoss = swingLow - this.params.stopBuffer;
        const stopDist = entryPrice - stopLoss;
        if (stopDist > this.params.maxStopPts || stopDist <= 0) continue;
        if (!this.checkCooldown(ts, this.params.signalCooldownMs)) continue;
        const takeProfit = entryPrice + this.params.targetPoints;
        this._lastTriggerByLevel.set(key, ts);
        this.updateLastSignalTime(ts);

        const signal = {
          timestamp: ts,
          side: 'long',
          price: entryPrice,
          strategy: 'GEX_STRUCTURAL_RESIST',
          action: 'place_market',
          symbol: this.params.tradingSymbol,
          quantity: this.params.defaultQuantity,
          stopLoss, takeProfit,
          maxHoldBars: this.params.maxHoldBars,
          levelType: lvl.type,
          levelPrice: lvl.price,
          swingLow,
          rejections,
          regime: gex.regime,
          stopDistance: stopDist,
          stop_loss: stopLoss, take_profit: takeProfit,
        };
        if (this.params.trailingTrigger && this.params.trailingOffset) {
          signal.trailingTrigger = this.params.trailingTrigger;
          signal.trailingOffset = this.params.trailingOffset;
        }
        if (this.params.debug) {
          console.log(`[GSR] LONG ${lvl.type}@${lvl.price.toFixed(2)} swingLow=${swingLow.toFixed(2)} rej=${rejections} entry=${entryPrice.toFixed(2)} sl=${stopLoss.toFixed(2)}`);
        }
        this._lastEvalSignal = signal;
        return signal;
      }
    }

    this._lastEvalSignal = null;
    return null;
  }

  onPositionClosed(info) {
    if (info?.timestamp) this.lastSignalTime = this.toMs(info.timestamp);
  }
}
