/**
 * Vanilla Black-Scholes pricing and implied-volatility solver.
 *
 * Single source of truth shared by:
 *   - backtest-engine/scripts/precompute-iv.js (CSV generation)
 *   - signal-generator/src/tradier/iv-skew-calculator.js (live IV skew)
 *
 * Keeping these implementations in lockstep is critical: the IV-SKEW-GEX
 * strategy was backtested against IV produced by this exact code path,
 * and live trading signals are only valid if the live calculator emits
 * identical values for identical inputs.
 */

export const BS_RISK_FREE_RATE = 0.05;

export function normalCDF(x) {
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

export function normalPDF(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

export function blackScholesPrice(S, K, T, r, sigma, optionType) {
  if (T <= 0 || sigma <= 0) return 0;

  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);

  if (optionType === 'C') {
    return S * normalCDF(d1) - K * Math.exp(-r * T) * normalCDF(d2);
  } else {
    return K * Math.exp(-r * T) * normalCDF(-d2) - S * normalCDF(-d1);
  }
}

export function blackScholesVega(S, K, T, r, sigma) {
  if (T <= 0 || sigma <= 0) return 0;

  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  return S * Math.sqrt(T) * normalPDF(d1);
}

export function calculateIV(optionPrice, S, K, T, r, optionType) {
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

export function calculateIVBisection(optionPrice, S, K, T, r, optionType) {
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
 * Backtest-identical ATM IV calculator. Mirrors precompute-iv.calculateATMIV
 * so live and backtest produce byte-identical skew on identical inputs.
 *
 * Algorithm:
 *   1. Iterate every option in `optionQuotes`.
 *   2. Skip if dte ∉ [minDTE, maxDTE].
 *   3. Skip if |strike − spot| / spot > maxMoneyness (default 2%).
 *   4. Compute mid = (bid + ask) / 2; reject zero/invalid bid/ask and
 *      spreads > 50% (matches CBBO loader filtering in precompute-iv.js).
 *   5. Compute vanilla BS IV; keep only IV ∈ [0.05, 2.0].
 *   6. Sort surviving calls / puts by |strike − spot|; pick the closest
 *      call and the closest put **independently** (different expirations
 *      allowed, exactly like backtest).
 *   7. Report dte = min(callDTE, putDTE).
 *
 * @param {Array<{symbol, strike, optionType, expiration, bid, ask}>} optionQuotes
 *   Flat list of every option in the chain. `optionType` is 'C' or 'P'.
 *   `expiration` is a Date object.
 * @param {number} spotPrice
 * @param {Date|number} now Reference time for DTE calculation
 * @param {object} [opts]
 * @param {number} [opts.minDTE=7]
 * @param {number} [opts.maxDTE=45]
 * @param {number} [opts.maxMoneyness=0.02]
 * @param {number} [opts.riskFreeRate=BS_RISK_FREE_RATE]
 * @returns {object|null} { iv, callIV, putIV, atmStrike, atmCallStrike, atmPutStrike, dte, callDTE, putDTE } or null
 */
export function calculateATMIVFromQuotes(optionQuotes, spotPrice, now, opts = {}) {
  const minDTE = opts.minDTE ?? 7;
  const maxDTE = opts.maxDTE ?? 45;
  const maxMoneyness = opts.maxMoneyness ?? 0.02;
  const r = opts.riskFreeRate ?? BS_RISK_FREE_RATE;

  if (!optionQuotes || optionQuotes.length === 0 || !spotPrice) return null;
  const nowMs = now instanceof Date ? now.getTime() : now;

  const atmOptions = [];
  for (const o of optionQuotes) {
    if (!o || !o.expiration || !o.strike || !o.optionType) continue;

    const expMs = o.expiration instanceof Date ? o.expiration.getTime() : new Date(o.expiration).getTime();
    const dte = Math.floor((expMs - nowMs) / (1000 * 60 * 60 * 24));
    if (dte < minDTE || dte > maxDTE) continue;

    const moneyness = Math.abs(o.strike - spotPrice) / spotPrice;
    if (moneyness > maxMoneyness) continue;

    const bid = o.bid;
    const ask = o.ask;
    if (!(bid > 0) || !(ask > 0) || ask < bid) continue;
    if ((ask - bid) / bid > 0.5) continue;
    const mid = (bid + ask) / 2;

    const T = dte / 365;
    const iv = calculateIV(mid, spotPrice, o.strike, T, r, o.optionType);
    if (iv === null || iv <= 0.05 || iv >= 2.0) continue;

    atmOptions.push({
      symbol: o.symbol,
      strike: o.strike,
      optionType: o.optionType,
      dte,
      mid,
      iv
    });
  }

  if (atmOptions.length === 0) return null;

  // Sort by moneyness ascending, then by DTE ascending. The DTE tiebreak is
  // critical: when several expirations have the SAME closest-to-money strike
  // (extremely common at ATM since multiple weeklies typically list the same
  // round strikes), the moneyness comparator alone returns 0 and falls back
  // to insertion order — which differs between Schwab snapshots (chains in
  // expiration order) and cbbo running maps (in order of first BBO update).
  // That made backtest pick a multi-week DTE while live picked the front-week
  // DTE for the same minute, producing IV/skew divergence even though both
  // call the same shared function. Preferring shorter DTE on ties matches
  // Schwab's incidental behavior and yields the front-month IV the strategy
  // was tuned on.
  const sortAtmCandidate = (a, b) => {
    const dm = Math.abs(a.strike - spotPrice) - Math.abs(b.strike - spotPrice);
    if (dm !== 0) return dm;
    return a.dte - b.dte;
  };

  const calls = atmOptions.filter(o => o.optionType === 'C').sort(sortAtmCandidate);
  const puts = atmOptions.filter(o => o.optionType === 'P').sort(sortAtmCandidate);

  const atmCall = calls[0] || null;
  const atmPut = puts[0] || null;

  let avgIV, callIV, putIV, atmStrike, dte;
  if (atmCall && atmPut) {
    callIV = atmCall.iv;
    putIV = atmPut.iv;
    avgIV = (callIV + putIV) / 2;
    atmStrike = (atmCall.strike + atmPut.strike) / 2;
    dte = Math.min(atmCall.dte, atmPut.dte);
  } else if (atmCall) {
    callIV = atmCall.iv;
    putIV = null;
    avgIV = callIV;
    atmStrike = atmCall.strike;
    dte = atmCall.dte;
  } else if (atmPut) {
    callIV = null;
    putIV = atmPut.iv;
    avgIV = putIV;
    atmStrike = atmPut.strike;
    dte = atmPut.dte;
  } else {
    return null;
  }

  return {
    iv: avgIV,
    callIV,
    putIV,
    atmStrike,
    atmCallStrike: atmCall?.strike ?? null,
    atmPutStrike: atmPut?.strike ?? null,
    dte,
    callDTE: atmCall?.dte ?? null,
    putDTE: atmPut?.dte ?? null
  };
}
