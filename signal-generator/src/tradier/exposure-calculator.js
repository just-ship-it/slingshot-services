import { createLogger } from '../../../shared/index.js';

const logger = createLogger('exposure-calculator');

class ExposureCalculator {
  constructor(options = {}) {
    this.riskFreeRate = options.riskFreeRate || 0.05;
    // Dividend yield set to 0 to match the backtest GEX calculator
    // (generate-intraday-gex.py), which omits dividend yield from gamma.
    this.dividendYield = options.dividendYield ?? 0;
  }

  /**
   * Parse Tradier option symbol
   * Example: SPY260110C00600000 -> { symbol: 'SPY', expiry: Date, type: 'call', strike: 600 }
   */
  parseOptionSymbol(optionSymbol) {
    try {
      // Find the date portion (6 digits representing YYMMDD)
      const regex = /([A-Z]+)(\d{6})([CP])(\d{8})/;
      const match = optionSymbol.match(regex);

      if (!match) {
        throw new Error(`Invalid option symbol format: ${optionSymbol}`);
      }

      const [, underlying, dateStr, typeChar, strikeStr] = match;

      // Parse expiry date (YYMMDD format)
      const year = 2000 + parseInt(dateStr.substring(0, 2));
      const month = parseInt(dateStr.substring(2, 4)) - 1; // JS months are 0-based
      const day = parseInt(dateStr.substring(4, 6));
      const expiry = new Date(year, month, day, 16, 0, 0); // 4 PM ET

      // Parse option type
      const type = typeChar === 'C' ? 'call' : 'put';

      // Parse strike (8 digits, divide by 1000 for actual strike)
      const strike = parseInt(strikeStr) / 1000;

      return {
        underlying,
        expiry,
        type,
        strike,
        symbol: optionSymbol
      };
    } catch (error) {
      logger.warn(`Failed to parse option symbol ${optionSymbol}:`, error.message);
      return null;
    }
  }

  /**
   * Calculate time to expiry in years.
   * Matches backtest generate-intraday-gex.py: T = max(dte/365, 0.001).
   * No 2.5hr floor — backtest has no equivalent floor and we are converging
   * to the backtest's gamma surface for live-backtest parity.
   */
  calculateTimeToExpiry(expiryDate) {
    const now = new Date();
    const yearsToExpiry = (expiryDate - now) / (1000 * 60 * 60 * 24 * 365.25);
    return Math.max(yearsToExpiry, 0.001);
  }

  /**
   * Standard normal probability density function
   */
  normalPDF(x) {
    return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
  }

  /**
   * Standard normal cumulative distribution function
   */
  normalCDF(x) {
    // Approximation using error function
    const sign = x >= 0 ? 1 : -1;
    x = Math.abs(x) / Math.sqrt(2);

    const a1 = 0.254829592;
    const a2 = -0.284496736;
    const a3 = 1.421413741;
    const a4 = -1.453152027;
    const a5 = 1.061405429;
    const p = 0.3275911;

    const t = 1.0 / (1.0 + p * x);
    const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);

    return 0.5 * (1.0 + sign * y);
  }

  /**
   * Calculate d1 and d2 for Black-Scholes
   */
  calculateD1D2(spot, strike, rate, volatility, timeToExpiry, dividendYield = 0) {
    if (timeToExpiry <= 0 || volatility <= 0) {
      return { d1: 0, d2: 0 };
    }

    const volSqrt = volatility * Math.sqrt(timeToExpiry);
    const d1 = (Math.log(spot / strike) + (rate - dividendYield + 0.5 * volatility * volatility) * timeToExpiry) / volSqrt;
    const d2 = d1 - volSqrt;

    return { d1, d2 };
  }

  /**
   * Calculate option gamma
   */
  calculateGamma(spot, strike, rate, volatility, timeToExpiry, dividendYield = 0) {
    if (timeToExpiry <= 0 || volatility <= 0 || spot <= 0 || strike <= 0) {
      return 0;
    }

    const { d1 } = this.calculateD1D2(spot, strike, rate, volatility, timeToExpiry, dividendYield);
    const gamma = Math.exp(-dividendYield * timeToExpiry) * this.normalPDF(d1) /
                  (spot * volatility * Math.sqrt(timeToExpiry));

    return gamma;
  }

  /**
   * Calculate option vanna (sensitivity of delta to implied volatility)
   */
  calculateVanna(spot, strike, rate, volatility, timeToExpiry, dividendYield = 0) {
    if (timeToExpiry <= 0 || volatility <= 0 || spot <= 0 || strike <= 0) {
      return 0;
    }

    const { d1, d2 } = this.calculateD1D2(spot, strike, rate, volatility, timeToExpiry, dividendYield);
    const vanna = -Math.exp(-dividendYield * timeToExpiry) * this.normalPDF(d1) * d2 / volatility;

    return vanna;
  }

  /**
   * Calculate option charm (sensitivity of delta to time decay)
   */
  calculateCharm(spot, strike, rate, volatility, timeToExpiry, optionType, dividendYield = 0) {
    if (timeToExpiry <= 0 || volatility <= 0 || spot <= 0 || strike <= 0) {
      return 0;
    }

    const { d1, d2 } = this.calculateD1D2(spot, strike, rate, volatility, timeToExpiry, dividendYield);
    const sqrtT = Math.sqrt(timeToExpiry);
    const pdf_d1 = this.normalPDF(d1);

    let charm;
    if (optionType === 'call') {
      charm = -Math.exp(-dividendYield * timeToExpiry) * pdf_d1 *
              (2 * (rate - dividendYield) * timeToExpiry - d2 * volatility * sqrtT) /
              (2 * timeToExpiry * volatility * sqrtT);
    } else {
      charm = -Math.exp(-dividendYield * timeToExpiry) * pdf_d1 *
              (2 * (rate - dividendYield) * timeToExpiry - d2 * volatility * sqrtT) /
              (2 * timeToExpiry * volatility * sqrtT);
    }

    return charm;
  }

  /**
   * Approximate IV using the Brenner-Subrahmanyam method on the bid/ask mid.
   * Mirrors the backtest GEX calculator (generate-intraday-gex.py:189-204):
   * IV ≈ (time_value / spot) × √(2π / T), clamped to [0.05, 2.0].
   *
   * The 0.05 floor matches the backtest's "no time value" case. We never
   * fall back to a richer default like 0.20 — that would inflate gamma on
   * deep-OTM puts that have bid=0/ask=0.01, breaking the cumulative-GEX
   * cumsum that the gamma-flip detector walks.
   */
  bsApproxIV(option, spotPrice) {
    const bid = option.bid > 0 ? option.bid : 0;
    const ask = option.ask > 0 ? option.ask : 0;
    // Use mid when both sides quote, otherwise fall back to the available side.
    // Schwab returns bid=0, ask=0.01 for many deep-OTM contracts — that's a
    // real (tiny) premium quote, not a missing one.
    const optionPrice = bid > 0 && ask > 0 ? (bid + ask) / 2 : (bid > 0 ? bid : ask);
    if (optionPrice <= 0 || spotPrice <= 0) return 0.05;

    const tte = this.calculateTimeToExpiry(new Date(option.expiration_date));
    if (tte <= 0) return 0.05;

    const intrinsic = option.option_type === 'call'
      ? Math.max(0, spotPrice - option.strike)
      : Math.max(0, option.strike - spotPrice);
    const timeValue = optionPrice - intrinsic;
    if (timeValue <= 0) return 0.05;

    const iv = (timeValue / spotPrice) * Math.sqrt(2 * Math.PI / tte);
    return Math.max(0.05, Math.min(2.0, iv));
  }

  /**
   * Calculate Gamma Exposure (GEX)
   *
   * @param sharedIV  Optional pre-computed IV for this (strike, expiration).
   *                  When provided, used in place of bsApproxIV(option, ...) so
   *                  calls and puts at the same strike share an IV (put-call
   *                  parity). Falls back to per-option IV when omitted.
   */
  calculateGEX(option, spotPrice, gamma = null, sharedIV = null) {
    const { option_type, strike, open_interest } = option;
    const type = option_type;
    const openInterest = open_interest;

    if (!openInterest || openInterest === 0) {
      return 0;
    }

    // Always compute BS gamma from IV for GEX calculations.
    // Broker-provided greeks.gamma (e.g. Schwab) can be 2-3x lower than BS gamma
    // for short-dated options, which understates put gamma and flips the regime sign.
    let optionGamma = gamma;
    if (gamma === null) {
      const tte = this.calculateTimeToExpiry(new Date(option.expiration_date));
      const vol = sharedIV != null ? sharedIV : this.bsApproxIV(option, spotPrice);
      optionGamma = this.calculateGamma(spotPrice, strike, this.riskFreeRate, vol, tte, this.dividendYield);
    }

    if (!optionGamma || isNaN(optionGamma)) {
      return 0;
    }

    // Market maker positioning assumption:
    // - Short calls (positive GEX when spot moves up)
    // - Long puts (negative GEX when spot moves up)
    const positionSign = type === 'call' ? 1 : -1;

    // GEX = Position × Gamma × Open Interest × Contract Size × Spot²
    // Spot² term converts gamma per $1 move to gamma per 1% move
    const gex = positionSign * optionGamma * openInterest * 100 * Math.pow(spotPrice, 2) * 0.01;

    return gex;
  }

  /**
   * Calculate Vanna Exposure (VEX)
   *
   * @param sharedIV  Optional pre-computed IV for this (strike, expiration).
   */
  calculateVEX(option, spotPrice, sharedIV = null) {
    const { option_type, strike, open_interest, expiration_date } = option;
    const type = option_type;
    const openInterest = open_interest;

    if (!openInterest || openInterest === 0) {
      return 0;
    }

    const tte = this.calculateTimeToExpiry(new Date(expiration_date));
    const vol = sharedIV != null ? sharedIV : this.bsApproxIV(option, spotPrice);

    const vanna = this.calculateVanna(spotPrice, strike, this.riskFreeRate, vol, tte, this.dividendYield);

    if (!vanna || isNaN(vanna)) {
      return 0;
    }

    // Market maker positioning: short calls, long puts
    const positionSign = type === 'call' ? 1 : -1;

    // VEX = Position × Vanna × Open Interest × Contract Size × Spot
    const vex = positionSign * vanna * openInterest * 100 * spotPrice;

    return vex;
  }

  /**
   * Calculate Charm Exposure (CEX)
   *
   * @param sharedIV  Optional pre-computed IV for this (strike, expiration).
   */
  calculateCEX(option, spotPrice, sharedIV = null) {
    const { option_type, strike, open_interest, expiration_date } = option;
    const type = option_type;
    const openInterest = open_interest;

    if (!openInterest || openInterest === 0) {
      return 0;
    }

    const tte = this.calculateTimeToExpiry(new Date(expiration_date));
    const vol = sharedIV != null ? sharedIV : this.bsApproxIV(option, spotPrice);

    const charm = this.calculateCharm(spotPrice, strike, this.riskFreeRate, vol, tte, type, this.dividendYield);

    if (!charm || isNaN(charm)) {
      return 0;
    }

    // Market maker positioning: short calls, long puts
    const positionSign = type === 'call' ? 1 : -1;

    // CEX = Position × Charm × Open Interest × Contract Size × Spot
    // Note: Charm is typically negative, so this gives us the flow needed for time decay
    const cex = positionSign * charm * openInterest * 100 * spotPrice;

    return cex;
  }

  /**
   * Build a per-(strike, expiration) IV map using the OTM-side quote.
   *
   * Why: Black-Scholes gamma is type-agnostic — the same (S, K, T, σ) gives
   * the same gamma for the call and the put. Empirically, ITM contracts have
   * wide bid/ask spreads that inflate apparent time value, producing a
   * spurious high IV (e.g., 597C 5/29 reads time_value ≈ $5 vs the put's
   * authoritative $2.81 at the same strike). When call IV escapes the 0.05
   * floor but put IV stays clamped, call gamma comes out 4-5 orders of
   * magnitude larger than put gamma at the same strike, breaking the
   * cumulative-GEX flip detection at deep ITM/OTM strikes.
   *
   * The OTM-side quote is the more reliable IV source because intrinsic = 0,
   * so mid ≈ time value directly, with no spread-leverage on the small
   * time-value component. Apply that single IV to both call and put gamma.
   */
  buildIVByStrikeExp(chains, spotPrice) {
    // First pass: collect both sides per (strike, expiration).
    const quotes = new Map();
    for (const chain of chains) {
      if (!chain.options) continue;
      for (const o of chain.options) {
        if (!o || !o.strike || !o.expiration_date) continue;
        const key = `${o.strike}:${o.expiration_date}`;
        if (!quotes.has(key)) quotes.set(key, {});
        quotes.get(key)[o.option_type] = o;
      }
    }

    // Second pass: pick the OTM side, fall back to whichever exists.
    const ivMap = new Map();
    for (const [key, q] of quotes) {
      const strikeStr = key.split(':')[0];
      const strike = parseFloat(strikeStr);
      const otmType = strike >= spotPrice ? 'call' : 'put';
      const ref = q[otmType] || q.call || q.put;
      if (!ref) continue;
      ivMap.set(key, this.bsApproxIV(ref, spotPrice));
    }
    return ivMap;
  }

  /**
   * Process options chains to calculate all exposures
   */
  calculateExposures(chainsData, spotPrices) {
    const results = {};

    for (const [symbol, chains] of Object.entries(chainsData)) {
      const spotPrice = spotPrices[symbol];

      if (!spotPrice || !chains || chains.length === 0) {
        logger.warn(`Missing data for ${symbol}: spotPrice=${spotPrice}, chains=${chains?.length || 0}`);
        continue;
      }

      // Aggregate exposures by strike
      const exposuresByStrike = new Map();
      const openInterestByStrike = new Map();

      // Track total exposures
      let totalGEX = 0;
      let totalVEX = 0;
      let totalCEX = 0;

      // Process all chains for this symbol
      for (const chain of chains) {
        if (!chain.options) continue;

        for (const option of chain.options) {
          try {
            const strike = option.strike;
            const openInterest = option.open_interest || 0;
            const volume = option.volume || 0;

            // Match backtest's universe: include contracts that have OI AND
            // traded today. The backtest GEX (generate-intraday-gex.py) joins
            // OPRA OI (yesterday's close) with stat_type-11 close prices,
            // which are broadcast only for contracts that traded that day.
            // Without the volume gate, Schwab includes deep-ITM stale OI
            // (auto-exercising positions) that backtest never sees, which
            // shifts walls and pulls the gamma flip toward spot.
            if (openInterest === 0) continue;
            if (volume === 0) continue;

            // Calculate exposures using each contract's own bid/ask-derived IV.
            const gex = this.calculateGEX(option, spotPrice);
            const vex = this.calculateVEX(option, spotPrice);
            const cex = this.calculateCEX(option, spotPrice);

            // Aggregate by strike
            if (!exposuresByStrike.has(strike)) {
              exposuresByStrike.set(strike, { gex: 0, vex: 0, cex: 0, callOI: 0, putOI: 0 });
            }

            const strikeData = exposuresByStrike.get(strike);
            strikeData.gex += gex;
            strikeData.vex += vex;
            strikeData.cex += cex;

            if (option.option_type === 'call') {
              strikeData.callOI += openInterest;
            } else {
              strikeData.putOI += openInterest;
            }

            // Add to totals
            totalGEX += gex;
            totalVEX += vex;
            totalCEX += cex;

          } catch (error) {
            logger.warn(`Error processing option ${option.symbol}:`, error.message);
          }
        }
      }

      // Find key levels
      const keyLevels = this.findKeyLevels(exposuresByStrike, spotPrice);

      results[symbol] = {
        spotPrice,
        timestamp: new Date().toISOString(),
        totals: {
          gex: totalGEX,
          vex: totalVEX,
          cex: totalCEX
        },
        levels: keyLevels,
        exposuresByStrike: Object.fromEntries(exposuresByStrike),
        regime: this.classifyRegime(totalGEX, totalVEX, totalCEX),
        chainCount: chains.length,
        optionCount: chains.reduce((sum, chain) => sum + (chain.options?.length || 0), 0)
      };

      logger.info(`Calculated exposures for ${symbol}: GEX=${(totalGEX/1e9).toFixed(2)}B, VEX=${(totalVEX/1e9).toFixed(2)}B, CEX=${(totalCEX/1e9).toFixed(2)}B`);
    }

    return results;
  }

  /**
   * Find key levels from exposure data
   */
  findKeyLevels(exposuresByStrike, spotPrice) {
    const strikes = Array.from(exposuresByStrike.keys()).sort((a, b) => a - b);

    if (strikes.length === 0) {
      return {};
    }

    // Find gamma flip (zero gamma crossing)
    const gammaFlip = this.findZeroGammaCrossing(exposuresByStrike, spotPrice);

    // Call wall: strike with most POSITIVE GEX above spot (matching backtest
    // generate-intraday-gex.py:273-275). This selects the near-ATM strike where
    // dealer gamma hedging is strongest, not a deep OTM strike with high OI.
    // Previous logic used highest OI, which often landed on deep OTM institutional
    // hedges that don't act as true resistance — see memory/gex-wall-divergence.md.
    let callWall = null;
    let callWallGex = 0;
    for (const [strike, data] of exposuresByStrike) {
      if (strike > spotPrice && data.gex > callWallGex) {
        callWallGex = data.gex;
        callWall = strike;
      }
    }

    // Put wall: strike with most NEGATIVE GEX below spot (matching backtest
    // generate-intraday-gex.py:269-271).
    let putWall = null;
    let putWallGex = 0;
    for (const [strike, data] of exposuresByStrike) {
      if (strike < spotPrice && data.gex < putWallGex) {
        putWallGex = data.gex;
        putWall = strike;
      }
    }

    // Find resistance and support levels
    const resistance = this.findResistanceLevels(exposuresByStrike, spotPrice);
    const support = this.findSupportLevels(exposuresByStrike, spotPrice);

    return {
      gammaFlip,
      callWall,
      putWall,
      resistance,
      support,
      callWallGex,
      putWallGex
    };
  }

  /**
   * Find the gamma flip strike: the first strike where cumulative GEX
   * transitions from negative to positive, restricted to strikes within
   * ±10% of spot. Mirrors backtest generate-intraday-gex.py:256-267.
   *
   * Returns null when no crossing exists in the ±10% band — do NOT fall
   * back to spot. The previous fallback caused live's flip to always
   * read at spot, masking real gamma structure and diverging from the
   * backtest by ~64 QQQ points.
   */
  findZeroGammaCrossing(exposuresByStrike, spotPrice) {
    const lo = spotPrice * 0.9;
    const hi = spotPrice * 1.1;
    const nearStrikes = Array.from(exposuresByStrike.keys())
      .filter(s => s >= lo && s <= hi)
      .sort((a, b) => a - b);

    let cumsum = 0;
    for (const strike of nearStrikes) {
      const prev = cumsum;
      cumsum += exposuresByStrike.get(strike).gex;
      if (prev < 0 && cumsum >= 0) return strike;
    }
    return null;
  }

  /**
   * Find resistance levels (above current price).
   * Matches backtest generate-intraday-gex.py:273-283: strikes with most
   * positive GEX above spot, sorted by GEX magnitude descending then by
   * strike ascending for the final output.
   */
  findResistanceLevels(exposuresByStrike, spotPrice, count = 5) {
    const strikesAbove = Array.from(exposuresByStrike.entries())
      .filter(([strike, data]) => strike > spotPrice && data.gex > 0)
      .sort((a, b) => b[1].gex - a[1].gex) // Most positive GEX first
      .slice(0, count)
      .map(([strike]) => Math.round(strike))
      .sort((a, b) => a - b);

    return strikesAbove;
  }

  /**
   * Find support levels (below current price).
   * Matches backtest generate-intraday-gex.py:269-279: strikes with most
   * negative GEX below spot, sorted by GEX magnitude (most negative first)
   * then by strike descending for the final output.
   */
  findSupportLevels(exposuresByStrike, spotPrice, count = 5) {
    const strikesBelow = Array.from(exposuresByStrike.entries())
      .filter(([strike, data]) => strike < spotPrice && data.gex < 0)
      .sort((a, b) => a[1].gex - b[1].gex) // Most negative GEX first
      .slice(0, count)
      .map(([strike]) => Math.round(strike))
      .sort((a, b) => b - a);

    return strikesBelow;
  }

  /**
   * Classify market regime based on exposures
   */
  classifyRegime(totalGEX, totalVEX, totalCEX) {
    // GEX regime
    let gexRegime = 'neutral';
    if (totalGEX > 5e9) gexRegime = 'strong_positive';
    else if (totalGEX > 1e9) gexRegime = 'positive';
    else if (totalGEX < -5e9) gexRegime = 'strong_negative';
    else if (totalGEX < -1e9) gexRegime = 'negative';

    // VEX interpretation
    let vexSignal = 'neutral';
    if (Math.abs(totalVEX) > 1e9) {
      vexSignal = totalVEX > 0 ? 'vol_sensitive_upside' : 'vol_sensitive_downside';
    }

    // CEX interpretation
    let cexSignal = 'neutral';
    if (Math.abs(totalCEX) > 1e9) {
      cexSignal = totalCEX > 0 ? 'time_decay_bullish' : 'time_decay_bearish';
    }

    return {
      gex: gexRegime,
      vex: vexSignal,
      cex: cexSignal,
      overall: this.getOverallRegime(gexRegime, vexSignal, cexSignal)
    };
  }

  /**
   * Get overall market regime assessment
   */
  getOverallRegime(gexRegime, vexSignal, cexSignal) {
    if (gexRegime.includes('positive')) {
      return 'mean_reverting';
    } else if (gexRegime.includes('negative')) {
      return 'trending';
    } else {
      return 'transitional';
    }
  }
}

export default ExposureCalculator;