import { createLogger, messageBus, CHANNELS } from '../../../shared/index.js';
import {
  BS_RISK_FREE_RATE,
  calculateIV,
  calculateATMIVFromQuotes
} from '../../../shared/utils/black-scholes.js';

const logger = createLogger('iv-skew-calculator');

/**
 * IV Skew Calculator
 *
 * Computes ATM implied volatility skew from an options chain. The selection
 * algorithm is intentionally identical to backtest-engine/scripts/precompute-iv.js
 * (see calculateATMIVFromQuotes in shared/utils/black-scholes.js) so the live
 * `iv-skew-gex` strategy receives the same skew distribution it was validated
 * against. Any divergence here will silently invalidate the backtest.
 *
 * Skew = putIV − callIV.
 *   - Negative skew = calls expensive = bullish flow/positioning
 *   - Positive skew = puts expensive = bearish hedging/fear
 *
 * Forward-based IV (greeks.mid_iv) is reported alongside as a supplementary
 * field for future re-optimization, but the live strategy reads vanilla BS.
 */
class IVSkewCalculator {
  constructor(options = {}) {
    this.symbol = options.symbol || 'QQQ';
    this.publishToRedis = options.publishToRedis !== false;

    // Mirror precompute-iv.calculateATMIV defaults (7-45 DTE, 2% moneyness).
    this.minDTE = options.minDTE ?? 7;
    this.maxDTE = options.maxDTE ?? 45;
    this.maxMoneyness = options.maxMoneyness ?? 0.02;

    this.currentSkew = null;

    this.skewHistory = [];
    this.maxHistoryLength = options.maxHistoryLength || 10;
  }

  /**
   * Flatten one symbol's cached chains into the shape calculateATMIVFromQuotes
   * expects: { symbol, strike, optionType ('C'|'P'), expiration (Date), bid, ask }.
   */
  _flattenChains(chains) {
    const flat = [];
    for (const chain of chains) {
      if (!chain?.options) continue;
      for (const option of chain.options) {
        if (!option || !option.strike || !option.option_type || !option.expiration_date) continue;
        const expDate = new Date(option.expiration_date + 'T16:00:00-05:00');
        flat.push({
          symbol: option.symbol,
          strike: option.strike,
          optionType: option.option_type === 'call' ? 'C' : 'P',
          expiration: expDate,
          bid: option.bid,
          ask: option.ask,
          openInterest: option.open_interest || 0,
          fwdIV: option.greeks?.mid_iv ?? null,
          rawExpirationDate: option.expiration_date
        });
      }
    }
    return flat;
  }

  /**
   * Compute forward-based call/put IV from greeks.mid_iv if available for the
   * chosen ATM call and put. Optional, supplementary; strategy ignores these.
   */
  _findFwdIVPair(flat, callStrike, putStrike, callDTE, putDTE, asOf) {
    const nowMs = asOf instanceof Date ? asOf.getTime() : (asOf ?? Date.now());
    let callFwd = null, putFwd = null, callOI = 0, putOI = 0;
    if (callStrike != null) {
      const match = flat.find(o =>
        o.optionType === 'C' &&
        o.strike === callStrike &&
        Math.floor((o.expiration.getTime() - nowMs) / 86400000) === callDTE
      );
      if (match) {
        callFwd = match.fwdIV;
        callOI = match.openInterest;
      }
    }
    if (putStrike != null) {
      const match = flat.find(o =>
        o.optionType === 'P' &&
        o.strike === putStrike &&
        Math.floor((o.expiration.getTime() - nowMs) / 86400000) === putDTE
      );
      if (match) {
        putFwd = match.fwdIV;
        putOI = match.openInterest;
      }
    }
    return { callFwd, putFwd, callOI, putOI };
  }

  /**
   * Calculate ATM IV skew from options chain data.
   *
   * @param {number} spotPrice
   * @param {Object} chainsData  Map of symbol → array of cached chains
   * @param {Date|number} [asOf=new Date()]  Reference time for DTE math.
   *   Defaults to wall-clock now in production; overridden by the parity
   *   harness when replaying historical snapshots.
   * @returns {Object|null}
   */
  calculateIVSkew(spotPrice, chainsData, asOf = new Date()) {
    if (!spotPrice || !chainsData) {
      logger.warn('Missing spotPrice or chainsData for IV skew calculation');
      return null;
    }

    const chains = chainsData[this.symbol];
    if (!chains || chains.length === 0) {
      logger.warn(`No chains data found for ${this.symbol}`);
      return null;
    }

    const flat = this._flattenChains(chains);
    if (flat.length === 0) {
      logger.warn(`No options found in chains for ${this.symbol}`);
      return null;
    }

    const result = calculateATMIVFromQuotes(flat, spotPrice, asOf, {
      minDTE: this.minDTE,
      maxDTE: this.maxDTE,
      maxMoneyness: this.maxMoneyness,
      riskFreeRate: BS_RISK_FREE_RATE
    });

    if (!result || result.callIV === null || result.putIV === null) {
      logger.warn(
        `Could not compute ATM IV for ${this.symbol} ` +
        `(spot=${spotPrice}, DTE=[${this.minDTE},${this.maxDTE}], moneyness<=${this.maxMoneyness}, ` +
        `flat.length=${flat.length})`
      );
      return null;
    }

    const { callIV, putIV, atmStrike, atmCallStrike, atmPutStrike, dte, callDTE, putDTE } = result;
    const skew = putIV - callIV;
    const iv = (callIV + putIV) / 2;

    const { callFwd, putFwd, callOI, putOI } = this._findFwdIVPair(
      flat, atmCallStrike, atmPutStrike, callDTE, putDTE, asOf
    );
    const skew_fwd = (callFwd != null && putFwd != null) ? putFwd - callFwd : null;
    const iv_fwd = (callFwd != null && putFwd != null) ? (callFwd + putFwd) / 2 : null;

    // Expiration label: the chosen call's expiration if call+put share one,
    // otherwise the shorter of the two (matches dte = min(callDTE, putDTE)).
    const expirationLabel = callDTE === putDTE
      ? this._dateForDTE(callDTE)
      : this._dateForDTE(Math.min(callDTE ?? Infinity, putDTE ?? Infinity));

    const skewData = {
      timestamp: new Date().toISOString(),
      symbol: this.symbol,
      spotPrice,
      atmStrike,
      atmCallStrike,
      atmPutStrike,
      expiration: expirationLabel,
      dte,
      callDTE,
      putDTE,
      callIV,
      putIV,
      iv,
      skew,
      callIV_fwd: callFwd,
      putIV_fwd: putFwd,
      iv_fwd,
      skew_fwd,
      callOI,
      putOI,
      signal: this.interpretSkew(skew)
    };

    this.currentSkew = skewData;
    this.skewHistory.push(skewData);
    if (this.skewHistory.length > this.maxHistoryLength) {
      this.skewHistory.shift();
    }

    const fwdSkewStr = skew_fwd !== null ? ` (fwd: ${(skew_fwd * 100).toFixed(3)}%)` : ' (fwd: n/a)';
    const dteStr = callDTE === putDTE ? `${dte}DTE` : `call=${callDTE}DTE/put=${putDTE}DTE`;
    logger.info(
      `📊 IV Skew: ${this.symbol} @ ${spotPrice.toFixed(2)} | ` +
      `K=${atmCallStrike}/${atmPutStrike} (${dteStr}) | ` +
      `Call IV=${(callIV * 100).toFixed(2)}% | Put IV=${(putIV * 100).toFixed(2)}% | ` +
      `Skew=${(skew * 100).toFixed(3)}%${fwdSkewStr} | Signal=${skewData.signal}`
    );

    if (this.publishToRedis) {
      this.publishSkewUpdate(skewData);
    }

    return skewData;
  }

  _dateForDTE(dte) {
    if (!Number.isFinite(dte)) return null;
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return new Date(d.getTime() + dte * 86400000).toISOString().slice(0, 10);
  }

  interpretSkew(skew) {
    if (skew < -0.02) return 'strongly_bullish';
    if (skew < -0.01) return 'bullish';
    if (skew > 0.02) return 'strongly_bearish';
    if (skew > 0.01) return 'bearish';
    return 'neutral';
  }

  getCurrentIVSkew() {
    return this.currentSkew;
  }

  /**
   * Adapter for the backtest's getIVAtTime() interface — live always returns
   * the most recent calculated skew regardless of the requested timestamp.
   */
  getIVAtTime(_timestamp) {
    return this.currentSkew;
  }

  getSkewHistory() {
    return this.skewHistory;
  }

  getSmoothedSkew(windowSize = 3) {
    if (this.skewHistory.length === 0) return null;
    const window = this.skewHistory.slice(-windowSize);
    const avgSkew = window.reduce((sum, d) => sum + d.skew, 0) / window.length;
    return {
      ...this.currentSkew,
      skew: avgSkew,
      smoothed: true,
      windowSize
    };
  }

  async publishSkewUpdate(skewData) {
    try {
      await messageBus.publish(CHANNELS.IV_SKEW, skewData);
      logger.debug('Published IV skew update to Redis');
    } catch (error) {
      logger.warn('Failed to publish IV skew update:', error.message);
    }
  }

  reset() {
    this.currentSkew = null;
    this.skewHistory = [];
    logger.info('IV Skew Calculator reset');
  }
}

// Re-export calculateIV so any existing callers importing from this module
// keep working without touching the shared module path.
export { calculateIV };
export default IVSkewCalculator;
