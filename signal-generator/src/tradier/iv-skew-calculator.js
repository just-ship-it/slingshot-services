import { createLogger, messageBus, CHANNELS } from '../../../shared/index.js';

const logger = createLogger('iv-skew-calculator');

// ============================================================================
// Vanilla Black-Scholes Functions (spot-based, no dividend adjustment)
// Matches backtest precompute-iv.js exactly for consistency
// ============================================================================

const BS_RISK_FREE_RATE = 0.05;

function normalCDF_BS(x) {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.sqrt(2);

  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);

  return 0.5 * (1.0 + sign * y);
}

function normalPDF_BS(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

function blackScholesPrice(S, K, T, r, sigma, optionType) {
  if (T <= 0 || sigma <= 0) return 0;

  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);

  if (optionType === 'C') {
    return S * normalCDF_BS(d1) - K * Math.exp(-r * T) * normalCDF_BS(d2);
  } else {
    return K * Math.exp(-r * T) * normalCDF_BS(-d2) - S * normalCDF_BS(-d1);
  }
}

function blackScholesVega(S, K, T, r, sigma) {
  if (T <= 0 || sigma <= 0) return 0;

  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  return S * Math.sqrt(T) * normalPDF_BS(d1);
}

function calculateIV(optionPrice, S, K, T, r, optionType) {
  if (optionPrice <= 0 || T <= 0) return null;

  const intrinsic = optionType === 'C'
    ? Math.max(0, S - K)
    : Math.max(0, K - S);

  if (optionPrice < intrinsic * 0.99) return null;

  let iv = 0.25;
  const maxIterations = 100;
  const tolerance = 0.0001;

  for (let i = 0; i < maxIterations; i++) {
    const price = blackScholesPrice(S, K, T, r, iv, optionType);
    const vega = blackScholesVega(S, K, T, r, iv);

    if (vega < 0.0001) {
      return calculateIVBisection(optionPrice, S, K, T, r, optionType);
    }

    const diff = price - optionPrice;

    if (Math.abs(diff) < tolerance) {
      return iv;
    }

    iv = iv - diff / vega;

    if (iv <= 0.001) iv = 0.001;
    if (iv > 5.0) iv = 5.0;
  }

  return calculateIVBisection(optionPrice, S, K, T, r, optionType);
}

function calculateIVBisection(optionPrice, S, K, T, r, optionType) {
  let low = 0.001;
  let high = 3.0;
  const maxIterations = 100;
  const tolerance = 0.0001;

  for (let i = 0; i < maxIterations; i++) {
    const mid = (low + high) / 2;
    const price = blackScholesPrice(S, K, T, r, mid, optionType);

    if (Math.abs(price - optionPrice) < tolerance) {
      return mid;
    }

    if (price > optionPrice) {
      high = mid;
    } else {
      low = mid;
    }
  }

  return (low + high) / 2;
}

/**
 * IV Skew Calculator
 *
 * Calculates ATM implied volatility skew from options chain data.
 * Skew = putIV - callIV
 *
 * - Negative skew = calls expensive = bullish flow/positioning
 * - Positive skew = puts expensive = bearish hedging/fear
 *
 * Based on academic research:
 * - Kolm/Turiel/Westray 2023: Order flow imbalance shows 60-65% directional accuracy
 * - Muravyev et al: Options contribute ~25% of price discovery
 */
class IVSkewCalculator {
  constructor(options = {}) {
    this.symbol = options.symbol || 'QQQ';
    this.publishToRedis = options.publishToRedis !== false;

    // DTE filters - backtest data uses 7-45 DTE exclusively
    // 0-DTE options have massively inflated IV that doesn't match backtest conditions
    this.minDTE = options.minDTE ?? 7;
    this.maxDTE = options.maxDTE ?? 45;

    // Current IV skew data
    this.currentSkew = null;

    // History for smoothing (optional)
    this.skewHistory = [];
    this.maxHistoryLength = options.maxHistoryLength || 10;
  }

  /**
   * Calculate ATM IV skew from options chain data
   *
   * @param {number} spotPrice - Current underlying spot price
   * @param {Object} chainsData - Options chains data from Tradier
   * @returns {Object} IV skew data
   */
  calculateIVSkew(spotPrice, chainsData) {
    if (!spotPrice || !chainsData) {
      logger.warn('Missing spotPrice or chainsData for IV skew calculation');
      return null;
    }

    // Get chains for our symbol
    const chains = chainsData[this.symbol];
    if (!chains || chains.length === 0) {
      logger.warn(`No chains data found for ${this.symbol}`);
      return null;
    }

    // Find ATM strike (closest to spot price)
    const atmStrike = this.findATMStrike(spotPrice, chains);
    if (!atmStrike) {
      logger.warn(`Could not find ATM strike for ${this.symbol} at spot ${spotPrice}`);
      return null;
    }

    // Get call and put IV at ATM strike (use shortest expiration >= minDTE)
    // Returns both vanilla BS IV and forward-based (Black's model) IV
    const atmData = this.getATMIVData(atmStrike, chains, spotPrice);

    if (atmData.callIV === null || atmData.putIV === null) {
      logger.warn(`Could not find ATM call/put IV for ${this.symbol} at strike ${atmStrike} (minDTE=${this.minDTE})`);
      return null;
    }

    const { callIV, putIV, callIV_fwd, putIV_fwd, expiration, callOI, putOI, dte } = atmData;

    // Calculate skew: putIV - callIV
    // Negative = calls expensive (bullish flow)
    // Positive = puts expensive (bearish hedging)
    const skew = putIV - callIV;
    const iv = (callIV + putIV) / 2;

    // Forward-based skew (from greeks.mid_iv / Black's model)
    const skew_fwd = (callIV_fwd !== null && putIV_fwd !== null) ? putIV_fwd - callIV_fwd : null;
    const iv_fwd = (callIV_fwd !== null && putIV_fwd !== null) ? (callIV_fwd + putIV_fwd) / 2 : null;

    const skewData = {
      timestamp: new Date().toISOString(),
      symbol: this.symbol,
      spotPrice,
      atmStrike,
      expiration,
      dte,
      // Primary fields (vanilla BS — backtest-compatible, strategy reads these)
      callIV,
      putIV,
      iv,
      skew,
      // Forward-based fields (Black's model — for future re-optimization)
      callIV_fwd,
      putIV_fwd,
      iv_fwd,
      skew_fwd,
      callOI,
      putOI,
      // Interpretation (based on vanilla BS skew)
      signal: this.interpretSkew(skew)
    };

    // Update current skew
    this.currentSkew = skewData;

    // Add to history
    this.skewHistory.push(skewData);
    if (this.skewHistory.length > this.maxHistoryLength) {
      this.skewHistory.shift();
    }

    const fwdSkewStr = skew_fwd !== null ? ` (fwd: ${(skew_fwd * 100).toFixed(3)}%)` : ' (fwd: n/a)';
    logger.info(`📊 IV Skew: ${this.symbol} @ ${spotPrice.toFixed(2)} | ` +
      `ATM=${atmStrike} (${dte}DTE) | Call IV=${(callIV * 100).toFixed(2)}% | ` +
      `Put IV=${(putIV * 100).toFixed(2)}% | Skew=${(skew * 100).toFixed(3)}%${fwdSkewStr} | ` +
      `Signal=${skewData.signal}`);

    // Publish to Redis if enabled
    if (this.publishToRedis) {
      this.publishSkewUpdate(skewData);
    }

    return skewData;
  }

  /**
   * Find ATM strike closest to spot price
   */
  findATMStrike(spotPrice, chains) {
    const allStrikes = new Set();

    // Collect all unique strikes from all chains
    for (const chain of chains) {
      if (!chain.options) continue;
      for (const option of chain.options) {
        if (option.strike) {
          allStrikes.add(option.strike);
        }
      }
    }

    if (allStrikes.size === 0) {
      return null;
    }

    // Find closest strike to spot
    const strikes = Array.from(allStrikes).sort((a, b) => a - b);
    let closestStrike = strikes[0];
    let minDiff = Math.abs(strikes[0] - spotPrice);

    for (const strike of strikes) {
      const diff = Math.abs(strike - spotPrice);
      if (diff < minDiff) {
        minDiff = diff;
        closestStrike = strike;
      }
    }

    return closestStrike;
  }

  /**
   * Calculate days to expiration from expiration date string
   * @param {string} expirationDate - Date string in YYYY-MM-DD format
   * @returns {number} Days until expiration
   */
  calculateDTE(expirationDate) {
    const expDate = new Date(expirationDate + 'T16:00:00-05:00'); // 4 PM ET expiration
    const now = new Date();
    const diffMs = expDate - now;
    return Math.ceil(diffMs / (1000 * 60 * 60 * 24));
  }

  /**
   * Get call and put IV for ATM strike using both methods:
   *   - Vanilla BS (spot-based): computed from bid/ask mid price — matches backtest data
   *   - Forward-based (Black's model): from greeks.mid_iv (computed by schwab-client)
   *
   * Uses the shortest expiration within [minDTE, maxDTE] for consistency with backtest data
   *
   * @param {number} atmStrike - ATM strike price
   * @param {Array} chains - Options chain data
   * @param {number} spotPrice - Current underlying spot price (for vanilla BS)
   */
  getATMIVData(atmStrike, chains, spotPrice) {
    // Group options by expiration to find shortest one with ATM data
    const byExpiration = new Map();

    for (const chain of chains) {
      if (!chain.options) continue;

      for (const option of chain.options) {
        if (option.strike !== atmStrike) continue;

        const exp = option.expiration_date;
        if (!byExpiration.has(exp)) {
          byExpiration.set(exp, {
            callBS: null, putBS: null,     // Vanilla BS IV
            callFwd: null, putFwd: null,   // Forward-based IV (greeks.mid_iv)
            callOI: 0, putOI: 0
          });
        }

        const expData = byExpiration.get(exp);
        const dte = this.calculateDTE(exp);
        const T = dte / 365;

        // IV from greeks.mid_iv (vanilla BS, from schwab-client)
        const fwdIV = option.greeks?.mid_iv || null;

        // Vanilla BS IV from bid/ask mid price
        let bsIV = null;
        const bid = option.bid;
        const ask = option.ask;
        if (bid > 0 && ask > 0 && ask >= bid && spotPrice > 0 && T > 0) {
          const spread = (ask - bid) / bid;
          if (spread <= 0.5) { // Skip >50% spread
            const mid = (bid + ask) / 2;
            const optType = option.option_type === 'call' ? 'C' : 'P';
            const iv = calculateIV(mid, spotPrice, atmStrike, T, BS_RISK_FREE_RATE, optType);
            if (iv !== null && iv > 0.05 && iv < 2.0) {
              bsIV = iv;
            }
          }
        }

        if (option.option_type === 'call') {
          expData.callBS = bsIV;
          expData.callFwd = fwdIV;
          expData.callOI = option.open_interest || 0;
        } else if (option.option_type === 'put') {
          expData.putBS = bsIV;
          expData.putFwd = fwdIV;
          expData.putOI = option.open_interest || 0;
        }
      }
    }

    // Find shortest expiration in [minDTE, maxDTE] that has both call and put vanilla BS IV
    const expirations = Array.from(byExpiration.keys())
      .filter(exp => {
        const data = byExpiration.get(exp);
        // Require both vanilla BS IVs (primary fields)
        if (data.callBS === null || data.putBS === null) return false;

        const dte = this.calculateDTE(exp);
        if (dte < this.minDTE) {
          logger.debug(`Skipping expiration ${exp} (DTE=${dte} < minDTE=${this.minDTE})`);
          return false;
        }
        if (dte > this.maxDTE) {
          logger.debug(`Skipping expiration ${exp} (DTE=${dte} > maxDTE=${this.maxDTE})`);
          return false;
        }
        return true;
      })
      .sort();

    if (expirations.length === 0) {
      logger.warn(`No expirations found with DTE in [${this.minDTE}, ${this.maxDTE}] for ATM strike ${atmStrike}`);
      return { callIV: null, putIV: null, callIV_fwd: null, putIV_fwd: null, expiration: null, callOI: 0, putOI: 0, dte: null };
    }

    // Use shortest valid expiration
    const shortestExp = expirations[0];
    const data = byExpiration.get(shortestExp);
    const dte = this.calculateDTE(shortestExp);

    return {
      callIV: data.callBS,
      putIV: data.putBS,
      callIV_fwd: data.callFwd,
      putIV_fwd: data.putFwd,
      expiration: shortestExp,
      callOI: data.callOI,
      putOI: data.putOI,
      dte
    };
  }

  /**
   * Interpret the skew value
   */
  interpretSkew(skew) {
    // Thresholds based on backtesting optimization
    if (skew < -0.02) return 'strongly_bullish';
    if (skew < -0.01) return 'bullish';
    if (skew > 0.02) return 'strongly_bearish';
    if (skew > 0.01) return 'bearish';
    return 'neutral';
  }

  /**
   * Get current IV skew data
   */
  getCurrentIVSkew() {
    return this.currentSkew;
  }

  /**
   * Get IV data at a specific time (adapter for strategy's getIVAtTime method)
   * For live trading, this returns the current skew regardless of timestamp
   */
  getIVAtTime(timestamp) {
    // For live trading, always return current data
    return this.currentSkew;
  }

  /**
   * Get skew history
   */
  getSkewHistory() {
    return this.skewHistory;
  }

  /**
   * Get smoothed skew (average of recent values)
   */
  getSmoothedSkew(windowSize = 3) {
    if (this.skewHistory.length === 0) {
      return null;
    }

    const window = this.skewHistory.slice(-windowSize);
    const avgSkew = window.reduce((sum, d) => sum + d.skew, 0) / window.length;

    return {
      ...this.currentSkew,
      skew: avgSkew,
      smoothed: true,
      windowSize
    };
  }

  /**
   * Publish skew update to Redis
   */
  async publishSkewUpdate(skewData) {
    try {
      await messageBus.publish(CHANNELS.IV_SKEW, skewData);
      logger.debug('Published IV skew update to Redis');
    } catch (error) {
      logger.warn('Failed to publish IV skew update:', error.message);
    }
  }

  /**
   * Reset calculator state
   */
  reset() {
    this.currentSkew = null;
    this.skewHistory = [];
    logger.info('IV Skew Calculator reset');
  }
}

export default IVSkewCalculator;
