/**
 * LT Candle Regime Strategy
 *
 * Trades candle structure regime changes relative to LT levels.
 * When the full 1m candle structure transitions from one side of an LT level
 * to the other, enter in the direction of the transition.
 *
 * Core signal:
 *   BELOW→ABOVE: Full candle was below LT, now fully above → BUY
 *   ABOVE→BELOW: Full candle was above LT, now fully below → SELL
 *
 * Research basis (lt-candle-structure-analysis.js, 21,609 events, 2023-2025):
 *   BELOW→ABOVE: +9.01pts @ 30m, 64% directional, t=15.56
 *   ABOVE→BELOW: -11.02pts @ 30m, 62% directional, t=-16.90
 *   Sentiment alignment amplifies: BULL+ABOVE = +13.44pts (69%), BEAR+BELOW = -16.72pts (67%)
 *
 * Pure timed exit — no stops, no targets. Enter at market, exit after N bars.
 * This measures the raw structural edge without contamination from exit mechanics.
 *
 * CRITICAL: Must use raw contract OHLCV data (--raw-contracts) for correct
 * price space alignment with LT levels.
 */

import { BaseStrategy } from './base-strategy.js';

export class LTCandleRegimeStrategy extends BaseStrategy {
  static getDataRequirements() {
    return { lt: true, gex: false, ivSkew: false, shortDTEIV: false };
  }

  constructor(params = {}) {
    super(params);

    // Which levels to watch (default: all 5)
    this.levelKeys = params.levelKeys || ['level_1', 'level_2', 'level_3', 'level_4', 'level_5'];
    this.levelNames = params.levelNames || ['LT34', 'LT55', 'LT144', 'LT377', 'LT610'];

    // Transitions to trade
    // 'both' = trade BELOW→ABOVE (long) and ABOVE→BELOW (short)
    // 'long-only' = only BELOW→ABOVE
    // 'short-only' = only ABOVE→BELOW
    this.direction = params.direction || 'both';

    // Sentiment filter: require sentiment alignment
    // true = BULLISH for longs, BEARISH for shorts
    this.requireSentiment = params.requireSentiment !== undefined ? params.requireSentiment : false;

    // Hold duration in bars (1m candles)
    this.holdBars = params.holdBars || 15; // 15m default (research shows edge is fully realized by 15m)

    // Profit protection: when MFE >= ratchetTrigger, switch to trailing stop
    // and extend hold to maxHoldWithTrail bars
    this.ratchetTrigger = params.ratchetTrigger || 25; // pts profit before trail activates
    this.ratchetTrailDist = params.ratchetTrailDist || 15; // trail distance once activated
    this.maxHoldWithTrail = params.maxHoldWithTrail || 120; // extended hold when trailing

    // Signal cooldown (ms) — prevent rapid re-entry
    this.cooldownMs = params.cooldownMs || (15 * 60 * 1000); // 15 min

    // Session filter (null = all sessions)
    // Options: 'overnight', 'premarket', 'rth', or null for all
    this.sessionFilter = params.sessionFilter || null;

    // Only trade when level is far enough from price (research showed far > close)
    this.minLevelDistance = params.minLevelDistance || 0; // 0 = no filter

    // State tracking
    this._prevStates = {}; // levelKey -> 'ABOVE' | 'BELOW' | 'STRADDLE'
    this._prevLT = null;
    this._ltData = null;
    this._ltIndex = 0;

    // Live LT 15m sampling — only latch new LT values on 15m boundaries
    this._liveLatched15mLT = null;
    this._lastLatch15mBoundary = 0;
  }

  /**
   * Load full LT dataset for backtesting (called by engine)
   */
  loadLTData(ltRecords) {
    this._ltData = ltRecords;
    this._ltIndex = 0;
  }

  reset() {
    super.reset();
    this._prevStates = {};
    this._prevLT = null;
    this._ltIndex = 0;
    this._liveLatched15mLT = null;
    this._lastLatch15mBoundary = 0;
  }

  /**
   * Get candle structure state relative to an LT level
   */
  _getCandleState(candle, levelPrice) {
    if (levelPrice == null || isNaN(levelPrice)) return null;
    if (candle.low > levelPrice) return 'ABOVE';
    if (candle.high < levelPrice) return 'BELOW';
    return 'STRADDLE';
  }

  /**
   * Determine session from timestamp
   */
  _getSession(ts) {
    const h = this._getESTHour(ts);
    if (h >= 18 || h < 4) return 'overnight';
    if (h >= 4 && h < 9.5) return 'premarket';
    if (h >= 9.5 && h < 16) return 'rth';
    return 'afterhours';
  }

  _isDST(ms) {
    const d = new Date(ms), y = d.getUTCFullYear(), m = d.getUTCMonth();
    if (m >= 3 && m <= 9) return true;
    if (m === 0 || m === 1 || m === 11) return false;
    if (m === 2) { const fd = new Date(Date.UTC(y, 2, 1)).getUTCDay(); return ms >= Date.UTC(y, 2, fd === 0 ? 8 : 15 - fd, 7); }
    if (m === 10) { const fd = new Date(Date.UTC(y, 10, 1)).getUTCDay(); return ms < Date.UTC(y, 10, fd === 0 ? 1 : 8 - fd, 6); }
    return false;
  }

  _getESTHour(ts) {
    const offset = this._isDST(ts) ? -4 : -5;
    const d = new Date(ts + offset * 3600000);
    return d.getUTCHours() + d.getUTCMinutes() / 60;
  }

  /**
   * Get the current LT snapshot for a given timestamp.
   * Backtest: walks through preloaded LT data array.
   * Live: latches marketData.ltLevels only on 15m boundaries to match backtest behavior.
   */
  _getCurrentLT(timestamp, marketData) {
    // Live path: latch LT levels only on 15m bar close boundaries
    if (marketData?.ltLevels && (!this._ltData || this._ltData.length === 0)) {
      const ts = this.toMs(timestamp);
      const FIFTEEN_MIN = 15 * 60 * 1000;
      const currentBoundary = Math.floor(ts / FIFTEEN_MIN) * FIFTEEN_MIN;

      if (currentBoundary > this._lastLatch15mBoundary) {
        // New 15m period — snapshot the current LT levels
        this._liveLatched15mLT = { ...marketData.ltLevels };
        this._lastLatch15mBoundary = currentBoundary;
      }

      return this._liveLatched15mLT || marketData.ltLevels;
    }

    // Backtest: walk through preloaded LT data
    if (!this._ltData || this._ltData.length === 0) return null;

    // Advance index to find closest LT record <= current timestamp
    while (this._ltIndex < this._ltData.length - 1 &&
           this._ltData[this._ltIndex + 1].timestamp <= timestamp) {
      this._ltIndex++;
    }

    const lt = this._ltData[this._ltIndex];
    // Only use if within 15 min of current candle
    if (Math.abs(lt.timestamp - timestamp) > 15 * 60 * 1000) return null;

    return lt;
  }

  evaluateSignal(candle, prevCandle, marketData, options = {}) {
    const timestamp = this.toMs(candle.timestamp);

    // Get current LT snapshot
    const lt = this._getCurrentLT(timestamp, marketData);
    if (!lt) return null;

    // Skip afterhours dead zone
    const session = this._getSession(timestamp);
    if (session === 'afterhours') return null;

    // Session filter
    if (this.sessionFilter && session !== this.sessionFilter) return null;

    // Cooldown check
    if (!this.checkCooldown(timestamp, this.cooldownMs)) return null;

    // Check each level for regime transitions
    for (let i = 0; i < this.levelKeys.length; i++) {
      const levelKey = this.levelKeys[i];
      const levelName = this.levelNames[i];
      const levelPrice = lt[levelKey];

      if (levelPrice == null || isNaN(levelPrice)) continue;

      // Get current candle state relative to this level
      const currentState = this._getCandleState(candle, levelPrice);
      if (!currentState) continue;

      // Get previous state (initialize if needed)
      const prevState = this._prevStates[levelKey];
      this._prevStates[levelKey] = currentState;

      if (!prevState) continue; // First observation, just set state
      if (prevState === currentState) continue; // No transition

      // Detect regime transitions
      let side = null;
      let transition = `${prevState}→${currentState}`;

      if (prevState === 'BELOW' && currentState === 'ABOVE') {
        // Full candle moved from below LT to above LT → BUY
        if (this.direction === 'both' || this.direction === 'long-only') {
          side = 'buy';
        }
      } else if (prevState === 'ABOVE' && currentState === 'BELOW') {
        // Full candle moved from above LT to below LT → SELL
        if (this.direction === 'both' || this.direction === 'short-only') {
          side = 'sell';
        }
      }

      if (!side) continue;

      // Sentiment filter
      if (this.requireSentiment) {
        const sentiment = lt.sentiment;
        if (side === 'buy' && sentiment !== 'BULLISH') continue;
        if (side === 'sell' && sentiment !== 'BEARISH') continue;
      }

      // Level distance filter
      const levelDist = Math.abs(levelPrice - candle.close);
      if (this.minLevelDistance > 0 && levelDist < this.minLevelDistance) continue;

      // Generate signal
      this.updateLastSignalTime(timestamp);

      // Reset all level states after signal to prevent rapid cascading signals
      // from multiple levels firing on the same candle
      for (const k of this.levelKeys) {
        this._prevStates[k] = null;
      }

      // Time-based trailing rules (processed by trade-simulator.js):
      //
      // Phase 1 (immediate): If MFE reaches ratchetTrigger pts at ANY time,
      //         activate trailing stop at ratchetTrailDist behind peak.
      //         This lets winners run beyond the default hold period.
      //
      // Phase 2 (at holdBars): If the trade hasn't hit ratchetTrigger yet,
      //         move stop to breakeven. This effectively closes the trade
      //         on the next tick back to entry — our "timed exit" for non-runners.
      //
      // Rules are evaluated in order; engine only advances forward through indices.
      // Rule 0 (BE) activates first at holdBars with no MFE requirement.
      // Rule 1 (trail) requires MFE >= trigger — once activated, it supersedes BE
      // because the trailing stop will be ahead of entry price.
      const timeBasedRules = [
        // At holdBars: move stop to breakeven (timed exit for non-runners)
        { afterBars: this.holdBars, ifMFE: 0, action: 'breakeven' },
        // At any time: if MFE hits trigger, trail behind peak (lets winners run)
        { afterBars: 0, ifMFE: this.ratchetTrigger, trailDistance: this.ratchetTrailDist },
      ];

      // Wide safety stop — protects against black swan moves
      const safetyStop = side === 'buy'
        ? candle.close - 100
        : candle.close + 100;

      return {
        strategy: 'LT_CANDLE_REGIME',
        action: 'place_market',
        side,
        symbol: candle.symbol || options.symbol || 'NQ1!',
        price: candle.close,
        stop_loss: safetyStop,
        quantity: 1,
        maxHoldBars: this.maxHoldWithTrail, // Extended hold — trail or timed exit
        timeBasedTrailing: true,
        timeBasedConfig: { rules: timeBasedRules },
        metadata: {
          transition,
          level: levelName,
          levelPrice: levelPrice,
          levelDist: levelDist.toFixed(1),
          sentiment: lt.sentiment,
          session,
          estHour: this._getESTHour(timestamp).toFixed(1),
          holdBars: this.holdBars,
          ratchetTrigger: this.ratchetTrigger,
          ratchetTrailDist: this.ratchetTrailDist,
        },
      };
    }

    return null;
  }

  /**
   * Return internal state for dashboard monitoring
   */
  getInternalState() {
    const now = Date.now();
    const cooldownRemaining = Math.max(0, (this.lastSignalTime + this.cooldownMs) - now);
    const lt = this._liveLatched15mLT || null;

    const levelStates = {};
    for (let i = 0; i < this.levelKeys.length; i++) {
      const key = this.levelKeys[i];
      const name = this.levelNames[i];
      levelStates[name] = {
        price: lt ? lt[key] : null,
        candleState: this._prevStates[key] || null,
      };
    }

    const FIFTEEN_MIN = 15 * 60 * 1000;
    const currentBoundary = Math.floor(now / FIFTEEN_MIN) * FIFTEEN_MIN;
    const nextLatch = currentBoundary + FIFTEEN_MIN;

    return {
      direction: this.direction,
      holdBars: this.holdBars,
      ratchetTrigger: this.ratchetTrigger,
      ratchetTrailDist: this.ratchetTrailDist,
      maxHoldWithTrail: this.maxHoldWithTrail,
      cooldownRemaining: Math.ceil(cooldownRemaining / 1000),
      inCooldown: cooldownRemaining > 0,
      sentiment: lt?.sentiment || null,
      levelStates,
      lastLatchBoundary: this._lastLatch15mBoundary,
      nextLatchIn: Math.ceil((nextLatch - now) / 1000),
      requireSentiment: this.requireSentiment,
    };
  }
}

export default LTCandleRegimeStrategy;
