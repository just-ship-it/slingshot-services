/**
 * ES GEX Support Stop Hunt Strategy
 *
 * Goes long when price hunts through a GEX support level (put_wall, S2-S5),
 * confirms with volume burst, and reverses back above the level.
 *
 * Evidence (13 months ES data, Jan 2025 - Jan 2026):
 * - put_wall: 61.0% win, +8.53 pts avg, 1.84:1 R:R (n=41)
 * - S3: 67.6% win, +5.55 pts avg, 2.20:1 R:R (n=37)
 * - S4: 63.6% win, +6.52 pts avg, 2.23:1 R:R (n=33)
 * - S5: 58.6% win, +8.67 pts avg, 5.90:1 R:R (n=29)
 * - S2: 59.3% win, +1.82 pts avg, 1.94:1 R:R (n=27)
 *
 * Resistance hunts show continuation (not reversal), so this is long-only.
 * Regime filter: avoid strong_negative and strong_positive.
 */

import { BaseStrategy } from './base-strategy.js';
import { isValidCandle, roundTo } from './strategy-utils.js';

export class EsStopHuntStrategy extends BaseStrategy {
  static getDataRequirements() {
    return {
      candles: {
        baseSymbol: 'ES',
        quoteSymbols: ['CME_MINI:ES1!', 'CME_MINI:MES1!', 'AMEX:SPY']
      },
      gex: { etfSymbol: 'SPY', futuresSymbol: 'ES', defaultMultiplier: 10.5 },
      lt: false,
      tradier: false,
      ivSkew: false
    };
  }

  constructor(params = {}) {
    super(params);

    this.defaultParams = {
      // Detection parameters
      minPenetration: 3.5,         // Minimum points below GEX level to qualify as a hunt (tightened from 1.0 based on confluence analysis: 89.4% WR at >=3.5pts vs 67.1% at >=1pt)
      volumeBurstRatio: 2.0,       // Volume must be >= this multiple of 20-bar average (tightened from 1.5)
      minMaxTradeSize: 50,         // Minimum max trade size in bar (institutional activity proxy)
      maxReversalBars: 5,          // Max bars to wait for reversal after penetration
      volumeLookback: 20,          // Rolling average volume window

      // Which GEX support levels to trade
      supportLevels: ['put_wall', 'S2', 'S3', 'S4', 'S5'],
      tier1Only: false,            // If true, only trade put_wall + S3 + S4

      // Exit parameters
      stopBuffer: 1.0,             // Points below extension low for stop loss
      maxHoldBars: 60,             // Max candles to hold (60 minutes on 1m chart)

      // Trailing stop
      useTrailingStop: true,
      trailingTrigger: 5.0,        // Activate trailing when 5 pts in profit
      trailingOffset: 4.0,         // Trail 4 pts behind high water mark

      // Limit order timeout
      limitOrderTimeout: 0,        // Market orders, no timeout needed

      // Signal management
      signalCooldownMs: 5 * 60 * 1000,  // 5 min cooldown between signals

      // Regime filter
      blockedRegimes: ['strong_negative', 'strong_positive'],

      // Session filtering
      useSessionFilter: false,     // Stop hunts happen 24h
      allowedSessions: ['overnight', 'premarket', 'rth', 'afterhours'],

      // Symbol configuration
      tradingSymbol: 'ES1!',
      defaultQuantity: 1,

      // Slippage for market entry
      entrySlippage: 0.25,

      // Wide target (trailing stop manages the exit)
      targetPoints: 20.0,

      debug: false
    };

    this.params = { ...this.defaultParams, ...params };

    // If tier1Only is set, override supportLevels
    if (this.params.tier1Only) {
      this.params.supportLevels = ['put_wall', 'S3', 'S4'];
    }

    // State tracking for multi-bar detection
    this.pendingHunts = new Map();    // levelKey -> { level, levelType, penetrationLow, volumeBurst, startBar, startTimestamp }
    this.rollingVolumes = [];         // Recent volumes for rolling average
    this.lastSignalBar = -Infinity;
  }

  /**
   * Evaluate if a stop hunt reversal signal should be generated
   */
  evaluateSignal(candle, prevCandle, marketData, options = {}) {
    const debug = options.debug || this.params.debug;

    if (!isValidCandle(candle)) {
      if (debug) console.log('[ES_STOP_HUNT] Invalid candle');
      return null;
    }

    // Check cooldown
    if (!this.checkCooldown(candle.timestamp, this.params.signalCooldownMs)) {
      return null;
    }

    const { gexLevels } = marketData || {};
    if (!gexLevels) {
      if (debug) console.log('[ES_STOP_HUNT] No GEX levels');
      return null;
    }

    // Check session filter
    if (this.params.useSessionFilter && !this.isAllowedSession(candle.timestamp)) {
      return null;
    }

    // Check regime filter
    const regime = gexLevels.regime || 'unknown';
    if (this.params.blockedRegimes.includes(regime)) {
      if (debug) console.log(`[ES_STOP_HUNT] Regime blocked: ${regime}`);
      return null;
    }

    // Update rolling volume
    this.rollingVolumes.push(candle.volume || 0);
    if (this.rollingVolumes.length > this.params.volumeLookback) {
      this.rollingVolumes.shift();
    }

    const avgVolume = this.rollingVolumes.length >= this.params.volumeLookback
      ? this.rollingVolumes.reduce((a, b) => a + b, 0) / this.rollingVolumes.length
      : 0;

    // Get support levels from GEX data
    const supportLevels = this.getGexSupportLevels(gexLevels);

    if (supportLevels.length === 0) {
      if (debug) console.log('[ES_STOP_HUNT] No support levels available');
      return null;
    }

    // Clean up expired pending hunts
    const currentBar = this.toMs(candle.timestamp);
    for (const [key, hunt] of this.pendingHunts) {
      const barsElapsed = (currentBar - hunt.startTimestamp) / 60000; // Assume 1m bars
      if (barsElapsed > this.params.maxReversalBars) {
        if (debug) console.log(`[ES_STOP_HUNT] Expired hunt at ${hunt.levelType}=${hunt.level} (${barsElapsed.toFixed(0)} bars)`);
        this.pendingHunts.delete(key);
      }
    }

    // Check for reversal on existing pending hunts FIRST
    for (const [key, hunt] of this.pendingHunts) {
      // Update the extension low if price went even lower
      if (candle.low < hunt.penetrationLow) {
        hunt.penetrationLow = candle.low;
      }

      // Check reversal: close back above the hunted level
      if (candle.close > hunt.level) {
        if (debug) {
          console.log(`[ES_STOP_HUNT] REVERSAL at ${hunt.levelType}=${hunt.level}, close=${candle.close}, extensionLow=${hunt.penetrationLow}`);
        }

        // Generate signal
        this.pendingHunts.delete(key);
        this.updateLastSignalTime(candle.timestamp);

        const entryPrice = candle.close + this.params.entrySlippage;
        const stopPrice = hunt.penetrationLow - this.params.stopBuffer;
        const risk = entryPrice - stopPrice;

        return {
          strategy: 'ES_STOP_HUNT',
          side: 'buy',
          action: 'place_market',
          symbol: this.params.tradingSymbol,
          price: roundTo(entryPrice),
          stop_loss: roundTo(stopPrice),
          take_profit: roundTo(entryPrice + this.params.targetPoints),
          trailing_trigger: this.params.useTrailingStop ? this.params.trailingTrigger : null,
          trailing_offset: this.params.useTrailingStop ? this.params.trailingOffset : null,
          quantity: this.params.defaultQuantity,
          timestamp: new Date(candle.timestamp).toISOString(),
          metadata: {
            hunted_level: roundTo(hunt.level),
            level_type: hunt.levelType,
            penetration_low: roundTo(hunt.penetrationLow),
            penetration_depth: roundTo(hunt.level - hunt.penetrationLow),
            risk_points: roundTo(risk),
            volume_ratio: roundTo(hunt.volumeRatio),
            regime,
            bars_to_reversal: Math.round((currentBar - hunt.startTimestamp) / 60000),
            entry_reason: `Stop hunt reversal at ${hunt.levelType}=${roundTo(hunt.level)}, penetration=${roundTo(hunt.level - hunt.penetrationLow)}pts`
          }
        };
      }
    }

    // Detect new penetrations on this bar
    if (avgVolume <= 0) return null; // Need volume history

    const volumeRatio = (candle.volume || 0) / avgVolume;
    const hasVolumeBurst = volumeRatio >= this.params.volumeBurstRatio;

    if (!hasVolumeBurst) return null; // No volume burst, no new hunts

    // Check max trade size filter (institutional activity proxy)
    if (this.params.minMaxTradeSize > 0) {
      const ofi = marketData?.ofi;
      const maxTradeSize = ofi?.maxTradeSize || 0;
      if (maxTradeSize < this.params.minMaxTradeSize) return null;
    }

    for (const { price: levelPrice, type: levelType } of supportLevels) {
      const penetration = levelPrice - candle.low;

      // Check penetration: low must go below the level by at least minPenetration
      if (penetration < this.params.minPenetration) continue;

      const levelKey = `${levelType}_${roundTo(levelPrice)}`;

      // Don't re-detect if we already have a pending hunt for this level
      if (this.pendingHunts.has(levelKey)) continue;

      if (debug) {
        console.log(`[ES_STOP_HUNT] PENETRATION detected: ${levelType}=${levelPrice}, low=${candle.low}, pen=${penetration.toFixed(2)}, vol=${volumeRatio.toFixed(2)}x`);
      }

      // Check if reversal already happened on THIS bar (close back above level)
      if (candle.close > levelPrice) {
        // Instant reversal on same bar
        this.updateLastSignalTime(candle.timestamp);

        const entryPrice = candle.close + this.params.entrySlippage;
        const stopPrice = candle.low - this.params.stopBuffer;
        const risk = entryPrice - stopPrice;

        if (debug) {
          console.log(`[ES_STOP_HUNT] INSTANT REVERSAL at ${levelType}=${levelPrice}, entry=${entryPrice}`);
        }

        return {
          strategy: 'ES_STOP_HUNT',
          side: 'buy',
          action: 'place_market',
          symbol: this.params.tradingSymbol,
          price: roundTo(entryPrice),
          stop_loss: roundTo(stopPrice),
          take_profit: roundTo(entryPrice + this.params.targetPoints),
          trailing_trigger: this.params.useTrailingStop ? this.params.trailingTrigger : null,
          trailing_offset: this.params.useTrailingStop ? this.params.trailingOffset : null,
          quantity: this.params.defaultQuantity,
          timestamp: new Date(candle.timestamp).toISOString(),
          metadata: {
            hunted_level: roundTo(levelPrice),
            level_type: levelType,
            penetration_low: roundTo(candle.low),
            penetration_depth: roundTo(penetration),
            risk_points: roundTo(risk),
            volume_ratio: roundTo(volumeRatio),
            regime,
            bars_to_reversal: 0,
            entry_reason: `Instant stop hunt reversal at ${levelType}=${roundTo(levelPrice)}, penetration=${roundTo(penetration)}pts`
          }
        };
      }

      // No reversal yet — track this as a pending hunt
      this.pendingHunts.set(levelKey, {
        level: levelPrice,
        levelType,
        penetrationLow: candle.low,
        volumeRatio,
        startTimestamp: currentBar
      });
    }

    return null;
  }

  /**
   * Extract relevant GEX support levels based on configuration
   */
  getGexSupportLevels(gexLevels) {
    const levels = [];
    const allowedTypes = this.params.supportLevels;

    // Put wall
    if (allowedTypes.includes('put_wall') && gexLevels.put_wall != null) {
      levels.push({ price: gexLevels.put_wall, type: 'put_wall' });
    }

    // Support array (S1-S5)
    if (gexLevels.support && Array.isArray(gexLevels.support)) {
      for (let i = 0; i < gexLevels.support.length; i++) {
        const levelName = `S${i + 1}`;
        if (allowedTypes.includes(levelName) && gexLevels.support[i] != null) {
          levels.push({ price: gexLevels.support[i], type: levelName });
        }
      }
    }

    return levels;
  }

  /**
   * Get current trading session
   */
  getSession(timestamp) {
    const date = new Date(timestamp);
    const estString = date.toLocaleString('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      minute: 'numeric',
      hour12: false
    });
    const [hourStr, minStr] = estString.split(':');
    const timeDecimal = parseInt(hourStr) + parseInt(minStr) / 60;

    if (timeDecimal >= 18 || timeDecimal < 4) return 'overnight';
    if (timeDecimal >= 4 && timeDecimal < 9.5) return 'premarket';
    if (timeDecimal >= 9.5 && timeDecimal < 16) return 'rth';
    return 'afterhours';
  }

  /**
   * Check if session is allowed
   */
  isAllowedSession(timestamp) {
    if (!this.params.useSessionFilter) return true;
    return this.params.allowedSessions.includes(this.getSession(timestamp));
  }

  /**
   * Reset strategy state
   */
  reset() {
    super.reset();
    this.pendingHunts.clear();
    this.rollingVolumes = [];
    this.lastSignalBar = -Infinity;
  }

  getName() { return 'ES_STOP_HUNT'; }
  getDescription() { return 'ES GEX Support Stop Hunt - long entries on stop hunt reversals at GEX support levels'; }
  getRequiredMarketData() { return ['gexLevels']; }
}

export default EsStopHuntStrategy;
