#!/usr/bin/env node
/**
 * Precompute ATM Implied Volatility from QQQ Options CBBO Data
 *
 * This script calculates implied volatility from QQQ option bid/ask prices
 * and saves it to a CSV file for use in backtesting with IV-adjusted trailing stops.
 *
 * Usage:
 *   node scripts/precompute-iv.js --start 2023-03-28 --end 2025-12-26
 *   node scripts/precompute-iv.js --start 2025-01-02 --end 2026-01-28 --interval 1
 *
 * Options:
 *   --interval <minutes>  Aggregation interval in minutes (default: 15). Use 1 for
 *                         1-minute resolution IV data that matches live trading refresh rates.
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// Black-Scholes Functions
// ============================================================================

/**
 * Standard normal cumulative distribution function
 */
function normalCDF(x) {
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

/**
 * Standard normal probability density function
 */
function normalPDF(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/**
 * Black-Scholes option price
 * @param {number} S - Spot price
 * @param {number} K - Strike price
 * @param {number} T - Time to expiration in years
 * @param {number} r - Risk-free rate
 * @param {number} sigma - Implied volatility
 * @param {string} optionType - 'C' for call, 'P' for put
 */
function blackScholesPrice(S, K, T, r, sigma, optionType) {
  if (T <= 0 || sigma <= 0) return 0;

  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);

  if (optionType === 'C') {
    return S * normalCDF(d1) - K * Math.exp(-r * T) * normalCDF(d2);
  } else {
    return K * Math.exp(-r * T) * normalCDF(-d2) - S * normalCDF(-d1);
  }
}

/**
 * Black-Scholes vega (sensitivity to volatility)
 */
function blackScholesVega(S, K, T, r, sigma) {
  if (T <= 0 || sigma <= 0) return 0;

  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  return S * Math.sqrt(T) * normalPDF(d1);
}

/**
 * Calculate implied volatility using Newton-Raphson iteration
 * @param {number} optionPrice - Observed option price (mid)
 * @param {number} S - Spot price
 * @param {number} K - Strike price
 * @param {number} T - Time to expiration in years
 * @param {number} r - Risk-free rate
 * @param {string} optionType - 'C' for call, 'P' for put
 * @returns {number|null} Implied volatility or null if calculation fails
 */
function calculateIV(optionPrice, S, K, T, r, optionType) {
  if (optionPrice <= 0 || T <= 0) return null;

  // Check for intrinsic value violations
  const intrinsic = optionType === 'C'
    ? Math.max(0, S - K)
    : Math.max(0, K - S);

  if (optionPrice < intrinsic * 0.99) return null; // Allow small tolerance

  let iv = 0.25; // Initial guess
  const maxIterations = 100;
  const tolerance = 0.0001;

  for (let i = 0; i < maxIterations; i++) {
    const price = blackScholesPrice(S, K, T, r, iv, optionType);
    const vega = blackScholesVega(S, K, T, r, iv);

    if (vega < 0.0001) {
      // Vega too small, try bisection instead
      return calculateIVBisection(optionPrice, S, K, T, r, optionType);
    }

    const diff = price - optionPrice;

    if (Math.abs(diff) < tolerance) {
      return iv;
    }

    iv = iv - diff / vega;

    // Keep IV in reasonable bounds
    if (iv <= 0.001) iv = 0.001;
    if (iv > 5.0) iv = 5.0;
  }

  // Newton-Raphson didn't converge, try bisection
  return calculateIVBisection(optionPrice, S, K, T, r, optionType);
}

/**
 * Bisection method for IV calculation (backup)
 */
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

// ============================================================================
// Black's Model Functions (forward-based pricing)
// ============================================================================

/**
 * Standard normal CDF — Abramowitz & Stegun 26.2.17 (corrected coefficients)
 * This matches schwab-client.js for consistency with live forward-based IV
 */
function normalCDF_fwd(x) {
  if (x < -8) return 0;
  if (x > 8) return 1;
  const b1 = 0.319381530, b2 = -0.356563782, b3 = 1.781477937;
  const b4 = -1.821255978, b5 = 1.330274429;
  const pp = 0.2316419;
  const ax = Math.abs(x);
  const t = 1.0 / (1.0 + pp * ax);
  const y = (1.0 / Math.sqrt(2 * Math.PI)) * Math.exp(-0.5 * x * x);
  const cdf = 1 - y * t * (b1 + t * (b2 + t * (b3 + t * (b4 + t * b5))));
  return x >= 0 ? cdf : 1 - cdf;
}

/**
 * Black's model option price (forward-based)
 * @param {number} F - Forward price
 * @param {number} K - Strike price
 * @param {number} T - Time to expiration in years
 * @param {number} r - Risk-free rate
 * @param {number} sigma - Implied volatility
 * @param {boolean} isCall - true for call, false for put
 */
function blackPrice(F, K, T, r, sigma, isCall) {
  if (T <= 0 || sigma <= 0) {
    const df = Math.exp(-r * T);
    return isCall ? Math.max(df * (F - K), 0) : Math.max(df * (K - F), 0);
  }
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(F / K) + 0.5 * sigma * sigma * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  const df = Math.exp(-r * T);
  if (isCall) {
    return df * (F * normalCDF_fwd(d1) - K * normalCDF_fwd(d2));
  } else {
    return df * (K * normalCDF_fwd(-d2) - F * normalCDF_fwd(-d1));
  }
}

/**
 * Black's model vega
 */
function blackVega(F, K, T, r, sigma) {
  if (T <= 0 || sigma <= 0) return 0;
  const d1 = (Math.log(F / K) + 0.5 * sigma * sigma * T) / (sigma * Math.sqrt(T));
  return Math.exp(-r * T) * F * Math.sqrt(T) * normalPDF(d1);
}

/**
 * Compute forward price from put-call parity: F = K + e^(rT) * (C - P)
 * Uses ATM call and put mid prices at the same strike
 */
function computeForwardPrice(spotPrice, callMid, putMid, strike, T, r) {
  if (!callMid || !putMid || T <= 0) return null;
  const F = strike + Math.exp(r * T) * (callMid - putMid);
  // Sanity check: forward should be within 5% of spot
  if (F <= 0 || Math.abs(F - spotPrice) / spotPrice > 0.05) return null;
  return F;
}

/**
 * Newton-Raphson IV solver for Black's model
 */
function impliedVolatilityFwd(midPrice, F, K, T, r, isCall) {
  if (midPrice <= 0 || T <= 0 || F <= 0 || K <= 0) return null;

  const df = Math.exp(-r * T);
  const intrinsic = isCall ? Math.max(df * (F - K), 0) : Math.max(df * (K - F), 0);
  if (midPrice <= intrinsic + 0.001) return null;

  // Brenner-Subrahmanyam initial guess (adapted for forward)
  let sigma = Math.sqrt(2 * Math.PI / T) * midPrice / (F * df);
  if (sigma <= 0.01 || !isFinite(sigma)) sigma = 0.3;
  if (sigma > 3) sigma = 1.0;

  for (let i = 0; i < 50; i++) {
    const price = blackPrice(F, K, T, r, sigma, isCall);
    const vega = blackVega(F, K, T, r, sigma);
    if (vega < 1e-10) break;

    const diff = price - midPrice;
    if (Math.abs(diff) < 1e-6) break;

    sigma -= diff / vega;
    if (sigma <= 0.001) sigma = 0.001;
    if (sigma > 5) sigma = 5;
  }

  if (sigma <= 0 || sigma > 5 || !isFinite(sigma)) return null;
  return sigma;
}

// ============================================================================
// Option Symbol Parser
// ============================================================================

/**
 * Parse option symbol to extract strike, expiration, and type
 * Format: "QQQ   YYMMDDTSSSSSSSS" where T is C/P and S is strike * 1000
 * Example: "QQQ   250113C00433000" = QQQ Jan 13 2025 $433 Call
 */
function parseOptionSymbol(symbol) {
  // Remove leading/trailing whitespace and normalize
  symbol = symbol.trim();

  // Expected format: "QQQ   YYMMDDTSSSSSSSS"
  // Find the date/strike portion (after the ticker and spaces)
  const match = symbol.match(/QQQ\s+(\d{6})([CP])(\d{8})/);

  if (!match) return null;

  const dateStr = match[1];  // YYMMDD
  const optionType = match[2]; // C or P
  const strikeStr = match[3];  // 8 digits, divide by 1000

  // Parse date
  const year = 2000 + parseInt(dateStr.substring(0, 2));
  const month = parseInt(dateStr.substring(2, 4)) - 1; // 0-indexed
  const day = parseInt(dateStr.substring(4, 6));
  const expiration = new Date(year, month, day);

  // Parse strike (8 digits, divide by 1000)
  const strike = parseInt(strikeStr) / 1000;

  return {
    expiration,
    optionType,
    strike
  };
}

// ============================================================================
// Data Loading
// ============================================================================

/**
 * Load QQQ spot prices from OHLCV CSV
 * @param {string} dataDir - Data directory path
 * @param {number} intervalMinutes - Aggregation interval in minutes (1, 5, 15)
 */
function loadQQQSpotPrices(dataDir, intervalMinutes = 15) {
  // Check multiple possible locations for QQQ OHLCV data
  const possiblePaths = [
    path.join(dataDir, 'ohlcv', 'qqq', 'QQQ_ohlcv_1m.csv'),  // Current location
    path.join(dataDir, 'ohlcv', 'QQQ_ohlcv_1m.csv'),         // Legacy location
  ];

  let csvPath = null;
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      csvPath = p;
      break;
    }
  }

  if (!csvPath) {
    console.error('QQQ OHLCV data not found. Checked:', possiblePaths);
    return new Map();
  }

  console.log(`Loading QQQ spot prices from ${csvPath}...`);

  const content = fs.readFileSync(csvPath, 'utf8');
  const lines = content.split('\n');
  const header = lines[0].split(',');

  const tsIdx = header.indexOf('ts_event');
  const closeIdx = header.indexOf('close');

  const intervalMs = intervalMinutes * 60 * 1000;
  const spotPrices = new Map(); // intervalTs -> close price (last price in each interval)

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (cols.length < closeIdx + 1) continue;

    const ts = new Date(cols[tsIdx]).getTime();
    if (isNaN(ts)) continue;

    const close = parseFloat(cols[closeIdx]);
    if (isNaN(close)) continue;

    // Bucket to interval — keep last price per interval
    const intervalTs = Math.floor(ts / intervalMs) * intervalMs;
    spotPrices.set(intervalTs, close);
  }

  console.log(`Loaded ${spotPrices.size} spot price records`);
  return spotPrices;
}

/**
 * Get list of available CBBO files
 */
function getCBBOFiles(dataDir) {
  // Check multiple possible locations for CBBO data
  const possiblePaths = [
    path.join(dataDir, 'cbbo-1m', 'qqq'),           // Current location
    path.join(dataDir, 'qqq-raw', 'extracted', 'cbbo-1m'),  // Legacy location
  ];

  let cbboDir = null;
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      cbboDir = p;
      break;
    }
  }

  if (!cbboDir) {
    console.error('CBBO data directory not found. Checked:', possiblePaths);
    return [];
  }

  console.log(`Using CBBO data from: ${cbboDir}`);

  const files = fs.readdirSync(cbboDir)
    .filter(f => f.endsWith('.csv') && f.includes('cbbo-1m'))
    .sort();

  return files.map(f => ({
    filename: f,
    path: path.join(cbboDir, f),
    date: extractDateFromFilename(f)
  }));
}

/**
 * Extract date from CBBO filename
 * Format: opra-pillar-YYYYMMDD.cbbo-1m.0000.csv
 */
function extractDateFromFilename(filename) {
  const match = filename.match(/opra-pillar-(\d{8})/);
  if (!match) return null;

  const dateStr = match[1];
  const year = parseInt(dateStr.substring(0, 4));
  const month = parseInt(dateStr.substring(4, 6)) - 1;
  const day = parseInt(dateStr.substring(6, 8));

  // Use UTC to avoid timezone issues
  return new Date(Date.UTC(year, month, day));
}

/**
 * Load CBBO data for a specific date using streaming to handle large files
 * @param {string} filePath - Path to CBBO CSV file
 * @param {number} intervalMinutes - Aggregation interval in minutes (1, 5, 15)
 */
function loadCBBOForDate(filePath, intervalMinutes = 15) {
  const intervalMs = intervalMinutes * 60 * 1000;
  return new Promise((resolve, reject) => {
    const intervals = new Map(); // intervalTs -> Map<symbol, {bid, ask}>
    let header = null;
    let tsIdx, bidIdx, askIdx, symbolIdx;

    const rl = readline.createInterface({
      input: fs.createReadStream(filePath),
      crlfDelay: Infinity
    });

    rl.on('line', (line) => {
      if (!header) {
        header = line.split(',');
        tsIdx = header.indexOf('ts_event');
        bidIdx = header.indexOf('bid_px_00');
        askIdx = header.indexOf('ask_px_00');
        symbolIdx = header.indexOf('symbol');
        return;
      }

      const cols = line.split(',');
      if (cols.length < symbolIdx + 1) return;

      const ts = new Date(cols[tsIdx]).getTime();
      if (isNaN(ts)) return;

      // Round to configured interval
      const intervalTs = Math.floor(ts / intervalMs) * intervalMs;

      const bid = parseFloat(cols[bidIdx]);
      const ask = parseFloat(cols[askIdx]);
      const symbol = cols[symbolIdx];

      // Skip invalid quotes
      if (isNaN(bid) || isNaN(ask) || bid <= 0 || ask <= 0) return;
      if (ask < bid) return; // Invalid spread
      if ((ask - bid) / bid > 0.5) return; // Too wide spread (>50%)

      if (!intervals.has(intervalTs)) {
        intervals.set(intervalTs, new Map());
      }

      // Keep the latest quote for each symbol in the interval
      intervals.get(intervalTs).set(symbol, { bid, ask });
    });

    rl.on('close', () => resolve(intervals));
    rl.on('error', reject);
  });
}

// ============================================================================
// IV Calculation
// ============================================================================

/**
 * Calculate ATM IV for a given timestamp
 */
function calculateATMIV(timestamp, spotPrice, optionQuotes, riskFreeRate = 0.05) {
  if (!optionQuotes || optionQuotes.size === 0) return null;

  const currentDate = new Date(timestamp);

  // Find options with valid expiration (7-45 DTE)
  const atmOptions = [];

  for (const [symbol, quote] of optionQuotes) {
    const parsed = parseOptionSymbol(symbol);
    if (!parsed) continue;

    // Calculate DTE
    const dte = Math.floor((parsed.expiration - currentDate) / (1000 * 60 * 60 * 24));
    if (dte < 7 || dte > 45) continue;

    // Check if ATM (within 2% of spot)
    const moneyness = Math.abs(parsed.strike - spotPrice) / spotPrice;
    if (moneyness > 0.02) continue;

    // Calculate mid price
    const mid = (quote.bid + quote.ask) / 2;

    // Calculate time to expiration in years
    const T = dte / 365;

    // Calculate IV
    const iv = calculateIV(mid, spotPrice, parsed.strike, T, riskFreeRate, parsed.optionType);

    if (iv && iv > 0.05 && iv < 2.0) { // Reasonable IV range (5% - 200%)
      atmOptions.push({
        symbol,
        strike: parsed.strike,
        optionType: parsed.optionType,
        dte,
        mid,  // Needed for forward price computation
        iv
      });
    }
  }

  if (atmOptions.length === 0) return null;

  // Separate calls and puts
  const calls = atmOptions.filter(o => o.optionType === 'C');
  const puts = atmOptions.filter(o => o.optionType === 'P');

  // Get ATM call and put IV (closest to spot)
  const sortByMoneyness = (a, b) =>
    Math.abs(a.strike - spotPrice) - Math.abs(b.strike - spotPrice);

  calls.sort(sortByMoneyness);
  puts.sort(sortByMoneyness);

  const atmCall = calls[0];
  const atmPut = puts[0];

  // Average call and put IV for final ATM IV (vanilla BS — unchanged)
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

  // Forward-based IV (Black's model) — new dual output
  let callIV_fwd = null;
  let putIV_fwd = null;

  if (atmCall && atmPut && atmCall.strike === atmPut.strike) {
    const T = dte / 365;
    const F = computeForwardPrice(spotPrice, atmCall.mid, atmPut.mid, atmCall.strike, T, riskFreeRate);
    if (F) {
      callIV_fwd = impliedVolatilityFwd(atmCall.mid, F, atmCall.strike, T, riskFreeRate, true);
      putIV_fwd = impliedVolatilityFwd(atmPut.mid, F, atmPut.strike, T, riskFreeRate, false);
      // Validate range
      if (callIV_fwd !== null && (callIV_fwd < 0.05 || callIV_fwd > 2.0)) callIV_fwd = null;
      if (putIV_fwd !== null && (putIV_fwd < 0.05 || putIV_fwd > 2.0)) putIV_fwd = null;
    }
  }

  return {
    iv: avgIV,
    callIV,
    putIV,
    callIV_fwd,
    putIV_fwd,
    atmStrike,
    dte
  };
}

// ============================================================================
// Main Processing
// ============================================================================

async function main() {
  // Parse command line arguments
  const args = process.argv.slice(2);
  let startDate = null;
  let endDate = null;
  let outputPath = null;
  let intervalMinutes = 15;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--start' && args[i + 1]) {
      // Parse as UTC date
      const [y, m, d] = args[i + 1].split('-').map(Number);
      startDate = new Date(Date.UTC(y, m - 1, d));
      i++;
    } else if (args[i] === '--end' && args[i + 1]) {
      // Parse as UTC date
      const [y, m, d] = args[i + 1].split('-').map(Number);
      endDate = new Date(Date.UTC(y, m - 1, d));
      i++;
    } else if (args[i] === '--output' && args[i + 1]) {
      outputPath = args[i + 1];
      i++;
    } else if (args[i] === '--interval' && args[i + 1]) {
      intervalMinutes = parseInt(args[i + 1]);
      if (![1, 5, 15].includes(intervalMinutes)) {
        console.error(`Invalid interval: ${intervalMinutes}. Must be 1, 5, or 15.`);
        process.exit(1);
      }
      i++;
    }
  }

  if (!startDate || !endDate) {
    console.log('Usage: node precompute-iv.js --start YYYY-MM-DD --end YYYY-MM-DD [--interval 1|5|15] [--output path]');
    process.exit(1);
  }

  const dataDir = path.join(__dirname, '..', 'data');
  outputPath = outputPath || path.join(dataDir, 'iv', 'qqq', `qqq_atm_iv_${intervalMinutes}m.csv`);

  console.log(`\nPrecomputing ATM IV from ${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]}`);
  console.log(`Interval: ${intervalMinutes}m`);
  console.log(`Output: ${outputPath}\n`);

  // Load QQQ spot prices (at the requested interval resolution)
  const spotPrices = loadQQQSpotPrices(dataDir, intervalMinutes);

  // Get list of CBBO files
  const cbboFiles = getCBBOFiles(dataDir);
  console.log(`Found ${cbboFiles.length} CBBO files\n`);

  // Filter to date range
  const filteredFiles = cbboFiles.filter(f =>
    f.date >= startDate && f.date <= endDate
  );
  console.log(`Processing ${filteredFiles.length} files in date range\n`);

  // Process each day and collect IV readings
  const ivReadings = [];
  let processedDays = 0;
  let totalIntervals = 0;
  let successfulIV = 0;

  for (const file of filteredFiles) {
    process.stdout.write(`Processing ${file.filename}...`);

    try {
      const intervals = await loadCBBOForDate(file.path, intervalMinutes);
      let daySuccess = 0;

      for (const [intervalTs, quotes] of intervals) {
        totalIntervals++;

        // Get spot price for this interval
        const spotPrice = spotPrices.get(intervalTs);
        if (!spotPrice) continue;

        // Calculate ATM IV
        const ivResult = calculateATMIV(intervalTs, spotPrice, quotes);
        if (!ivResult) continue;

        ivReadings.push({
          timestamp: new Date(intervalTs).toISOString(),
          iv: ivResult.iv.toFixed(4),
          spotPrice: spotPrice.toFixed(2),
          atmStrike: ivResult.atmStrike.toFixed(2),
          callIV: ivResult.callIV?.toFixed(4) || '',
          putIV: ivResult.putIV?.toFixed(4) || '',
          dte: ivResult.dte,
          callIV_fwd: ivResult.callIV_fwd?.toFixed(4) || '',
          putIV_fwd: ivResult.putIV_fwd?.toFixed(4) || ''
        });

        successfulIV++;
        daySuccess++;
      }

      console.log(` ${daySuccess} IV readings`);
      processedDays++;
    } catch (err) {
      console.log(` ERROR: ${err.message}`);
    }
  }

  console.log(`\nProcessed ${processedDays} days`);
  console.log(`Total intervals: ${totalIntervals}`);
  console.log(`Successful IV calculations: ${successfulIV} (${(successfulIV/totalIntervals*100).toFixed(1)}%)`);

  // Sort by timestamp
  ivReadings.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  // Write to CSV (new columns appended — backward compatible, old loaders ignore them)
  const header = 'timestamp,iv,spot_price,atm_strike,call_iv,put_iv,dte,call_iv_fwd,put_iv_fwd';
  const rows = ivReadings.map(r =>
    `${r.timestamp},${r.iv},${r.spotPrice},${r.atmStrike},${r.callIV},${r.putIV},${r.dte},${r.callIV_fwd},${r.putIV_fwd}`
  );

  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  fs.writeFileSync(outputPath, header + '\n' + rows.join('\n'));
  console.log(`\nWrote ${ivReadings.length} IV readings to ${outputPath}`);

  // Print sample statistics
  const ivValues = ivReadings.map(r => parseFloat(r.iv));
  const avgIV = ivValues.reduce((a, b) => a + b, 0) / ivValues.length;
  const minIV = Math.min(...ivValues);
  const maxIV = Math.max(...ivValues);

  console.log(`\nIV Statistics:`);
  console.log(`  Average: ${(avgIV * 100).toFixed(1)}%`);
  console.log(`  Min: ${(minIV * 100).toFixed(1)}%`);
  console.log(`  Max: ${(maxIV * 100).toFixed(1)}%`);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
