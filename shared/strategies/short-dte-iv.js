/**
 * Short-DTE IV Strategy
 *
 * Trades NQ based on 0-DTE implied volatility dynamics from QQQ options.
 *
 * Core signals (from research: analyze-short-dte-iv-correlations.js):
 *
 *   1. IV Change → Direction (Analysis 1, r=-0.68 at 15m, Cohen's d=1.37)
 *      When 0-DTE IV drops sharply → NQ rallies (+38.9 pts avg 15m)
 *      When 0-DTE IV spikes sharply → NQ sells off (-38.8 pts avg 15m)
 *
 *   2. Skew Reversals (Analysis 3, p<0.0001)
 *      Skew sign flip to positive (puts getting expensive) → NQ rallies +6.2pts 15m
 *      Skew sign flip to negative (calls getting expensive) → NQ sells off -5.8pts 15m
 *
 *   3. Term Structure Filter (Analysis 4, r=-0.55)
 *      Inverted term structure (0-DTE > 1-DTE) → higher realized vol
 *      Used as volatility regime context, not direct entry signal
 *
 * Entry logic:
 *   LONG:  0-DTE IV dropped by > threshold over last 15m
 *          Optional confirmation: skew reversal to positive
 *   SHORT: 0-DTE IV spiked by > threshold over last 15m
 *          Optional confirmation: skew reversal to negative
 *
 * The strategy runs on 15m candles (matching the IV data resolution).
 */

import { BaseStrategy } from './base-strategy.js';
import { isValidCandle } from './strategy-utils.js';

const DEFAULT_PARAMS = {
  // IV change thresholds (absolute change in IV decimal, e.g. 0.01 = 1%)
  ivChangeThreshold: 0.008,         // Minimum 0-DTE IV change to trigger signal
  ivChangeField: 'dte0_avg_iv',     // Which IV field to track changes on

  // Direction modes
  enableLong: true,
  enableShort: true,

  // Skew confirmation
  useSkewConfirmation: false,       // Require skew reversal to confirm
  skewField: 'dte0_skew',          // Which skew field to check

  // Term structure filter
  useTermFilter: false,             // Filter by term structure state
  termFilterMode: 'normal_only',    // 'normal_only' (low vol), 'inverted_only' (high vol), 'none'

  // Quality filter
  minQuality: 2,                    // Minimum quality score (0-3, how many DTE buckets have data)

  // Trade parameters
  targetPoints: 20,
  stopPoints: 12,
  trailingTrigger: 10,              // Points in profit to activate trailing
  trailingOffset: 5,                // Trailing distance
  maxHoldBars: 8,                   // Max bars to hold (at 15m = 2 hours)
  timeoutCandles: 2,                // Cancel unfilled limit after N candles

  // Cooldown
  cooldownMs: 15 * 60 * 1000,      // 15 minutes between signals

  // GEX context (optional)
  useGexFilter: false,              // Use GEX regime as filter
  allowedGexRegimes: ['positive', 'strong_positive', 'neutral'], // For longs
};

export class ShortDTEIVStrategy extends BaseStrategy {
  constructor(params = {}) {
    super({ ...DEFAULT_PARAMS, ...params });
    this.shortDTEIVLoader = null;
    this.prevSkew = null;            // Track skew for reversal detection
    this.prevSkewTimestamp = null;
  }

  static getDataRequirements() {
    return { shortDTEIV: true };
  }

  /**
   * Called by backtest engine after data loading
   */
  loadShortDTEIVData(loader) {
    this.shortDTEIVLoader = loader;
  }

  evaluateSignal(candle, prevCandle, marketData, options = {}) {
    if (!isValidCandle(candle) || !prevCandle) return null;
    if (!this.shortDTEIVLoader) return null;
    if (!this.checkCooldown(candle.timestamp, this.params.cooldownMs)) return null;

    // Get IV pair (previous and current 15-min readings)
    const ivPair = this.shortDTEIVLoader.getIVPair(candle.timestamp);
    if (!ivPair) return null;

    const { prev: prevIV, curr: currIV } = ivPair;

    // Quality gate
    if (currIV.quality < this.params.minQuality) return null;

    // Extract IV change
    const ivField = this.params.ivChangeField;
    const currVal = currIV[ivField];
    const prevVal = prevIV[ivField];
    if (currVal === null || prevVal === null) return null;

    const ivChange = currVal - prevVal;
    const absChange = Math.abs(ivChange);

    // Must exceed threshold
    if (absChange < this.params.ivChangeThreshold) return null;

    // Determine direction: IV drop → long, IV spike → short
    const isIVDrop = ivChange < 0;
    const side = isIVDrop ? 'buy' : 'sell';

    if (side === 'buy' && !this.params.enableLong) return null;
    if (side === 'sell' && !this.params.enableShort) return null;

    // Skew confirmation filter
    if (this.params.useSkewConfirmation) {
      const skewField = this.params.skewField;
      const currSkew = currIV[skewField];
      const prevSkewVal = prevIV[skewField];

      if (currSkew === null || prevSkewVal === null) return null;

      // For longs: want skew reversal to positive (puts getting cheap relative to calls)
      // For shorts: want skew reversal to negative (puts getting expensive)
      if (side === 'buy' && !(prevSkewVal <= 0 && currSkew > 0)) return null;
      if (side === 'sell' && !(prevSkewVal >= 0 && currSkew < 0)) return null;
    }

    // Term structure filter
    if (this.params.useTermFilter && this.params.termFilterMode !== 'none') {
      const isInverted = currIV.dte0_avg_iv !== null && currIV.dte1_avg_iv !== null
        && currIV.dte0_avg_iv > currIV.dte1_avg_iv;

      if (this.params.termFilterMode === 'normal_only' && isInverted) return null;
      if (this.params.termFilterMode === 'inverted_only' && !isInverted) return null;
    }

    // GEX regime filter
    if (this.params.useGexFilter && marketData?.gexLevels) {
      const regime = marketData.gexLevels.regime;
      if (side === 'buy' && regime && !this.params.allowedGexRegimes.includes(regime)) return null;
      // For shorts, invert: allow negative regimes
      if (side === 'sell') {
        const shortRegimes = ['negative', 'strong_negative', 'neutral'];
        if (regime && !shortRegimes.includes(regime)) return null;
      }
    }

    // Build trade signal
    // IMPORTANT: Enter at candle.open (= period start price), NOT candle.close.
    // The IV change from T-15→T is available at time T (= candle open).
    // The research correlation (r=-0.68) predicts the T→T+15 move (= the current candle).
    // Using candle.close would miss the move entirely (it's the T+15 price, move already done).
    // sameCandleFill replays 1m/1s bars within this candle to fill at the open price.
    const entryPrice = candle.open;
    const stopLoss = side === 'buy'
      ? entryPrice - this.params.stopPoints
      : entryPrice + this.params.stopPoints;
    const takeProfit = side === 'buy'
      ? entryPrice + this.params.targetPoints
      : entryPrice - this.params.targetPoints;

    this.updateLastSignalTime(candle.timestamp);

    return {
      strategy: 'SHORT_DTE_IV',
      action: 'place_limit',
      sameCandleFill: true,
      side,
      symbol: candle.symbol || 'NQ1!',
      price: entryPrice,
      entryPrice,
      stop_loss: stopLoss,
      take_profit: takeProfit,
      stopLoss,
      takeProfit,
      trailing_trigger: this.params.trailingTrigger,
      trailing_offset: this.params.trailingOffset,
      quantity: 1,
      maxHoldBars: this.params.maxHoldBars,
      timeoutCandles: this.params.timeoutCandles,
      metadata: {
        iv_change: ivChange,
        iv_change_pct: (ivChange * 100).toFixed(2) + '%',
        dte0_iv: currVal,
        dte0_iv_prev: prevVal,
        dte0_skew: currIV.dte0_skew,
        dte1_iv: currIV.dte1_avg_iv,
        term_slope: currIV.term_slope,
        term_inverted: currIV.dte0_avg_iv > (currIV.dte1_avg_iv || Infinity),
        quality: currIV.quality,
        gex_regime: marketData?.gexLevels?.regime || null,
        entry_reason: isIVDrop
          ? `0-DTE IV dropped ${(ivChange * 100).toFixed(2)}% → long`
          : `0-DTE IV spiked +${(ivChange * 100).toFixed(2)}% → short`
      }
    };
  }

  reset() {
    super.reset();
    this.prevSkew = null;
    this.prevSkewTimestamp = null;
  }
}

export default ShortDTEIVStrategy;
