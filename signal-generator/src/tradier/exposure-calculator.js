import { createLogger } from '../../../shared/index.js';

const logger = createLogger('exposure-calculator');

class ExposureCalculator {
  constructor(options = {}) {
    this.riskFreeRate = options.riskFreeRate || 0.05;
    this.dividendYield = options.dividendYield || 0.01; // Default 1% for SPY/QQQ
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
   * Calculate time to expiry in years
   */
  calculateTimeToExpiry(expiryDate) {
    const now = new Date();
    const timeToExpiry = Math.max(0, (expiryDate - now) / (1000 * 60 * 60 * 24 * 365.25));
    return timeToExpiry;
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
   * Calculate Gamma Exposure (GEX)
   */
  calculateGEX(option, spotPrice, gamma = null) {
    const { option_type, strike, open_interest } = option;
    const type = option_type;
    const openInterest = open_interest;

    if (!openInterest || openInterest === 0) {
      return 0;
    }

    // Use provided gamma or calculate it
    let optionGamma = gamma;
    if (gamma === null && option.greeks?.gamma) {
      optionGamma = option.greeks.gamma;
    } else if (gamma === null) {
      // Calculate gamma if not provided
      const tte = this.calculateTimeToExpiry(new Date(option.expiration_date));
      const vol = option.greeks?.mid_iv || 0.25; // Default IV
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
   */
  calculateVEX(option, spotPrice) {
    const { option_type, strike, open_interest, expiration_date } = option;
    const type = option_type;
    const openInterest = open_interest;

    if (!openInterest || openInterest === 0) {
      return 0;
    }

    const tte = this.calculateTimeToExpiry(new Date(expiration_date));
    const vol = option.greeks?.mid_iv || 0.25;

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
   */
  calculateCEX(option, spotPrice) {
    const { option_type, strike, open_interest, expiration_date } = option;
    const type = option_type;
    const openInterest = open_interest;

    if (!openInterest || openInterest === 0) {
      return 0;
    }

    const tte = this.calculateTimeToExpiry(new Date(expiration_date));
    const vol = option.greeks?.mid_iv || 0.25;

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

            if (openInterest === 0) continue;

            // Calculate exposures
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

    // Find call and put walls (highest OI)
    let callWall = null;
    let putWall = null;
    let maxCallOI = 0;
    let maxPutOI = 0;

    for (const [strike, data] of exposuresByStrike) {
      if (data.callOI > maxCallOI) {
        maxCallOI = data.callOI;
        callWall = strike;
      }
      if (data.putOI > maxPutOI) {
        maxPutOI = data.putOI;
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
      maxCallOI,
      maxPutOI
    };
  }

  /**
   * Find zero gamma crossing point
   */
  findZeroGammaCrossing(exposuresByStrike, spotPrice) {
    // Convert keys to numbers and sort by distance from spot (like CBOE does)
    const strikes = Object.keys(exposuresByStrike)
      .map(s => parseFloat(s))
      .sort((a, b) => Math.abs(a - spotPrice) - Math.abs(b - spotPrice));

    for (let i = 0; i < strikes.length - 1; i++) {
      const strike1 = strikes[i];
      const strike2 = strikes[i + 1];
      const gex1 = exposuresByStrike[strike1].gex;
      const gex2 = exposuresByStrike[strike2].gex;

      // Check for sign change
      if ((gex1 > 0 && gex2 < 0) || (gex1 < 0 && gex2 > 0)) {
        // Linear interpolation to find crossing point
        const ratio = Math.abs(gex1) / (Math.abs(gex1) + Math.abs(gex2));
        const crossing = strike1 + (strike2 - strike1) * ratio;
        return Math.round(crossing);
      }
    }

    // If no crossing found, return spot price
    return Math.round(spotPrice);
  }

  /**
   * Find resistance levels (above current price)
   */
  findResistanceLevels(exposuresByStrike, spotPrice, count = 5) {
    const strikesAbove = Array.from(exposuresByStrike.keys())
      .filter(strike => strike > spotPrice)
      .map(strike => ({
        strike,
        score: exposuresByStrike.get(strike).callOI + Math.abs(exposuresByStrike.get(strike).gex) / 1e6
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, count)
      .map(item => Math.round(item.strike))
      .sort((a, b) => a - b);

    return strikesAbove;
  }

  /**
   * Find support levels (below current price)
   */
  findSupportLevels(exposuresByStrike, spotPrice, count = 5) {
    const strikesBelow = Array.from(exposuresByStrike.keys())
      .filter(strike => strike < spotPrice)
      .map(strike => ({
        strike,
        score: exposuresByStrike.get(strike).putOI + Math.abs(exposuresByStrike.get(strike).gex) / 1e6
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, count)
      .map(item => Math.round(item.strike))
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