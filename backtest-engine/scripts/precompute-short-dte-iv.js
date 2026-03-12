#!/usr/bin/env node
/**
 * Precompute 0-2 DTE Implied Volatility from QQQ/SPY Options Data
 *
 * Two modes:
 *   TCBBO mode (intraday, QQQ only):
 *     Streams TCBBO files, extracts 0-2 DTE ATM IV at 15-min intervals
 *     Output: data/iv/qqq/qqq_short_dte_iv_15m.csv
 *
 *   Statistics mode (daily, QQQ + SPY):
 *     Loads daily statistics files (OI + close), computes IV for 0-2 DTE
 *     Output: data/iv/{product}/{product}_short_dte_iv_daily.csv
 *
 * Usage:
 *   node scripts/precompute-short-dte-iv.js --source tcbbo --product qqq --start 2025-01-29 --end 2026-01-28
 *   node scripts/precompute-short-dte-iv.js --source statistics --product qqq --start 2023-03-28 --end 2026-01-28
 *   node scripts/precompute-short-dte-iv.js --source statistics --product spy --start 2023-03-28 --end 2026-01-28
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '..', 'data');

const RISK_FREE_RATE = 0.05;
const MIN_IV = 0.05;
const MAX_IV = 5.0;
const BISECTION_HIGH = 5.0; // 0-DTE IVs can exceed 200%
const MIN_TIME = 1 / 365 / 24; // ~1 hour minimum to prevent divide-by-zero

// ============================================================================
// Black-Scholes Functions (from precompute-iv.js)
// ============================================================================

function normalCDF(x) {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.sqrt(2);
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1.0 + sign * y);
}

function normalPDF(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

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

function blackScholesVega(S, K, T, r, sigma) {
  if (T <= 0 || sigma <= 0) return 0;
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  return S * Math.sqrt(T) * normalPDF(d1);
}

function calculateIV(optionPrice, S, K, T, r, optionType) {
  if (optionPrice <= 0 || T <= 0) return null;

  const intrinsic = optionType === 'C' ? Math.max(0, S - K) : Math.max(0, K - S);
  if (optionPrice < intrinsic * 0.99) return null;

  let iv = 0.30; // Initial guess (higher for short-DTE)
  const maxIterations = 100;
  const tolerance = 0.0001;

  for (let i = 0; i < maxIterations; i++) {
    const price = blackScholesPrice(S, K, T, r, iv, optionType);
    const vega = blackScholesVega(S, K, T, r, iv);
    if (vega < 0.0001) return calculateIVBisection(optionPrice, S, K, T, r, optionType);
    const diff = price - optionPrice;
    if (Math.abs(diff) < tolerance) return iv;
    iv = iv - diff / vega;
    if (iv <= 0.001) iv = 0.001;
    if (iv > MAX_IV) iv = MAX_IV;
  }

  return calculateIVBisection(optionPrice, S, K, T, r, optionType);
}

function calculateIVBisection(optionPrice, S, K, T, r, optionType) {
  let low = 0.001;
  let high = BISECTION_HIGH;
  const maxIterations = 100;
  const tolerance = 0.0001;

  for (let i = 0; i < maxIterations; i++) {
    const mid = (low + high) / 2;
    const price = blackScholesPrice(S, K, T, r, mid, optionType);
    if (Math.abs(price - optionPrice) < tolerance) return mid;
    if (price > optionPrice) high = mid;
    else low = mid;
  }

  return (low + high) / 2;
}

/**
 * Brenner-Subrahmanyam IV approximation (from generate-intraday-gex.py)
 * Used as fallback for statistics mode where we only have close prices
 */
function brennerSubrahmanyamIV(price, S, K, T, optionType) {
  if (T <= 0 || price <= 0) return null;
  const intrinsic = optionType === 'C' ? Math.max(0, S - K) : Math.max(0, K - S);
  const timeValue = price - intrinsic;
  if (timeValue <= 0) return MIN_IV;
  const iv = (timeValue / S) * Math.sqrt(2 * Math.PI / T);
  if (iv < MIN_IV || iv > MAX_IV) return null;
  return iv;
}

// ============================================================================
// Option Symbol Parser (handles QQQ and SPY)
// ============================================================================

function parseOptionSymbol(symbol, product) {
  symbol = symbol.trim();
  const prefix = product.toUpperCase();
  const regex = new RegExp(`${prefix}\\s+(\\d{6})([CP])(\\d{8})`);
  const match = symbol.match(regex);
  if (!match) return null;

  const dateStr = match[1]; // YYMMDD
  const optionType = match[2];
  const strikeStr = match[3];

  const year = 2000 + parseInt(dateStr.substring(0, 2));
  const month = parseInt(dateStr.substring(2, 4)) - 1;
  const day = parseInt(dateStr.substring(4, 6));
  const expiration = new Date(Date.UTC(year, month, day));
  const strike = parseInt(strikeStr) / 1000;

  return { expiration, optionType, strike };
}

// ============================================================================
// DST / ET Helpers
// ============================================================================

function isDST(utcMs) {
  const year = new Date(utcMs).getUTCFullYear();
  // 2nd Sunday of March
  let sundayCount = 0, dstStart;
  for (let d = 1; d <= 31; d++) {
    if (new Date(Date.UTC(year, 2, d)).getUTCDay() === 0) {
      if (++sundayCount === 2) { dstStart = Date.UTC(year, 2, d, 7, 0, 0); break; }
    }
  }
  // 1st Sunday of November
  let dstEnd;
  for (let d = 1; d <= 30; d++) {
    if (new Date(Date.UTC(year, 10, d)).getUTCDay() === 0) {
      dstEnd = Date.UTC(year, 10, d, 6, 0, 0); break;
    }
  }
  return utcMs >= dstStart && utcMs < dstEnd;
}

function toET(utcMs) {
  const offset = isDST(utcMs) ? -4 : -5;
  const etMs = utcMs + offset * 3600000;
  const d = new Date(etMs);
  return {
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    timeInMinutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
    date: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
  };
}

// ============================================================================
// Spot Price Loading
// ============================================================================

function loadSpotPrices(product) {
  const filename = `${product.toUpperCase()}_ohlcv_1m.csv`;
  const filePath = path.join(DATA_DIR, 'ohlcv', product.toLowerCase(), filename);

  if (!fs.existsSync(filePath)) {
    console.error(`OHLCV file not found: ${filePath}`);
    return new Map();
  }

  console.log(`Loading ${product.toUpperCase()} spot prices from ${filePath}...`);
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const header = lines[0].split(',');
  const tsIdx = header.indexOf('ts_event');
  const closeIdx = header.indexOf('close');

  const spotPrices = new Map();
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (cols.length < closeIdx + 1) continue;
    const ts = new Date(cols[tsIdx]).getTime();
    if (isNaN(ts)) continue;
    const close = parseFloat(cols[closeIdx]);
    if (isNaN(close)) continue;

    // Round to 15-min interval
    const intervalTs = Math.floor(ts / (15 * 60 * 1000)) * (15 * 60 * 1000);
    // Keep last price per interval
    spotPrices.set(intervalTs, close);
  }

  console.log(`Loaded ${spotPrices.size} spot price intervals`);
  return spotPrices;
}

/**
 * Load spot price at market close (~4 PM ET) per trading day
 */
function loadDailyCloseSpotPrices(product) {
  const filename = `${product.toUpperCase()}_ohlcv_1m.csv`;
  const filePath = path.join(DATA_DIR, 'ohlcv', product.toLowerCase(), filename);

  if (!fs.existsSync(filePath)) {
    console.error(`OHLCV file not found: ${filePath}`);
    return new Map();
  }

  console.log(`Loading ${product.toUpperCase()} daily close prices...`);
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const header = lines[0].split(',');
  const tsIdx = header.indexOf('ts_event');
  const closeIdx = header.indexOf('close');

  // Collect all prices, then find the last RTH price per day
  const dayPrices = new Map(); // date -> {lastTs, lastClose}
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (cols.length < closeIdx + 1) continue;
    const ts = new Date(cols[tsIdx]).getTime();
    if (isNaN(ts)) continue;
    const close = parseFloat(cols[closeIdx]);
    if (isNaN(close)) continue;

    const et = toET(ts);
    // Only consider RTH window (9:30 - 16:00 ET)
    if (et.timeInMinutes < 570 || et.timeInMinutes >= 960) continue;

    const existing = dayPrices.get(et.date);
    if (!existing || ts > existing.lastTs) {
      dayPrices.set(et.date, { lastTs: ts, lastClose: close });
    }
  }

  const result = new Map();
  for (const [date, data] of dayPrices) {
    result.set(date, data.lastClose);
  }

  console.log(`Loaded ${result.size} daily close prices`);
  return result;
}

// ============================================================================
// TCBBO Mode Processing
// ============================================================================

function getTCBBOFiles(product) {
  const tcbboDir = path.join(DATA_DIR, 'tcbbo', product.toLowerCase());
  if (!fs.existsSync(tcbboDir)) {
    console.error(`TCBBO directory not found: ${tcbboDir}`);
    return [];
  }

  const files = fs.readdirSync(tcbboDir)
    .filter(f => f.endsWith('.csv') && f.includes('tcbbo'))
    .sort();

  return files.map(f => {
    const match = f.match(/opra-pillar-(\d{8})/);
    const dateStr = match ? match[1] : null;
    let date = null;
    if (dateStr) {
      const y = parseInt(dateStr.substring(0, 4));
      const m = parseInt(dateStr.substring(4, 6)) - 1;
      const d = parseInt(dateStr.substring(6, 8));
      date = new Date(Date.UTC(y, m, d));
    }
    return { filename: f, path: path.join(tcbboDir, f), date };
  });
}

/**
 * Process a single TCBBO file for 0-2 DTE IV
 * Returns per-interval ATM IV for each DTE bucket
 */
function processTCBBOFile(filePath, product, spotPrices) {
  return new Promise((resolve, reject) => {
    // Collect bid/ask quotes per 15-min interval, grouped by symbol
    // Then compute IV from the mid-price
    const intervals = new Map(); // intervalTs -> Map<symbol, {bid, ask, ts}>
    let header = null;
    let tsIdx, bidIdx, askIdx, symbolIdx;
    let lineCount = 0;

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

      lineCount++;
      const cols = line.split(',');
      if (cols.length < symbolIdx + 1) return;

      const ts = new Date(cols[tsIdx]).getTime();
      if (isNaN(ts)) return;

      const bid = parseFloat(cols[bidIdx]);
      const ask = parseFloat(cols[askIdx]);
      const symbol = cols[symbolIdx];

      if (isNaN(bid) || isNaN(ask) || bid <= 0 || ask <= 0) return;
      if (ask < bid) return;

      // Filter wide spreads: spread > 50% of mid
      const mid = (bid + ask) / 2;
      if ((ask - bid) / mid > 0.50) return;

      // Round to 15-min interval
      const intervalTs = Math.floor(ts / (15 * 60 * 1000)) * (15 * 60 * 1000);

      if (!intervals.has(intervalTs)) intervals.set(intervalTs, new Map());
      // Keep the latest quote per symbol in each interval
      intervals.get(intervalTs).set(symbol, { bid, ask });
    });

    rl.on('close', () => {
      const readings = [];

      for (const [intervalTs, quotes] of intervals) {
        const spotPrice = spotPrices.get(intervalTs);
        if (!spotPrice) continue;

        const et = toET(intervalTs);

        // Skip last 15 min of 0-DTE (3:45-4:00 PM ET) — too noisy
        // We'll handle this per-DTE below

        const currentDate = new Date(intervalTs);
        const dteBuckets = { 0: { calls: [], puts: [] }, 1: { calls: [], puts: [] }, 2: { calls: [], puts: [] } };

        for (const [symbol, quote] of quotes) {
          const parsed = parseOptionSymbol(symbol, product);
          if (!parsed) continue;

          const dte = Math.floor((parsed.expiration - currentDate) / (1000 * 60 * 60 * 24));
          if (dte < 0 || dte > 2) continue;

          // Skip 0-DTE after 3:45 PM ET
          if (dte === 0 && et.timeInMinutes >= 945) continue;

          // Check ATM (within 1% of spot for short-DTE)
          const moneyness = Math.abs(parsed.strike - spotPrice) / spotPrice;
          if (moneyness > 0.01) continue;

          const mid = (quote.bid + quote.ask) / 2;

          // Time to expiry in years, with floor
          const expiryMs = parsed.expiration.getTime() + 16 * 3600000; // 4 PM ET close
          let T = (expiryMs - intervalTs) / (365.25 * 24 * 3600000);
          T = Math.max(T, MIN_TIME);

          const iv = calculateIV(mid, spotPrice, parsed.strike, T, RISK_FREE_RATE, parsed.optionType);
          if (!iv || iv < MIN_IV || iv > MAX_IV) continue;

          const entry = { strike: parsed.strike, iv, moneyness };
          if (parsed.optionType === 'C') {
            dteBuckets[dte].calls.push(entry);
          } else {
            dteBuckets[dte].puts.push(entry);
          }
        }

        // For each DTE bucket, pick ATM call + put (closest to spot)
        const reading = {
          timestamp: new Date(intervalTs).toISOString(),
          spotPrice
        };
        let hasData = false;

        for (const dte of [0, 1, 2]) {
          const bucket = dteBuckets[dte];
          const sortByMoneyness = (a, b) => a.moneyness - b.moneyness;
          bucket.calls.sort(sortByMoneyness);
          bucket.puts.sort(sortByMoneyness);

          const atmCall = bucket.calls[0];
          const atmPut = bucket.puts[0];

          if (atmCall || atmPut) {
            hasData = true;
            const callIV = atmCall ? atmCall.iv : null;
            const putIV = atmPut ? atmPut.iv : null;
            const avgIV = callIV && putIV ? (callIV + putIV) / 2 : (callIV || putIV);
            const skew = callIV && putIV ? putIV - callIV : null;
            const strike = atmCall ? atmCall.strike : atmPut.strike;

            reading[`dte${dte}_atm_strike`] = strike;
            reading[`dte${dte}_call_iv`] = callIV;
            reading[`dte${dte}_put_iv`] = putIV;
            reading[`dte${dte}_avg_iv`] = avgIV;
            reading[`dte${dte}_skew`] = skew;
          } else {
            reading[`dte${dte}_atm_strike`] = null;
            reading[`dte${dte}_call_iv`] = null;
            reading[`dte${dte}_put_iv`] = null;
            reading[`dte${dte}_avg_iv`] = null;
            reading[`dte${dte}_skew`] = null;
          }
        }

        // Term slope: dte1 - dte0 (positive = contango / normal)
        const dte0 = reading.dte0_avg_iv;
        const dte1 = reading.dte1_avg_iv;
        const dte2 = reading.dte2_avg_iv;
        reading.term_slope = (dte1 && dte0) ? dte1 - dte0 : null;

        // Quality: how many DTE buckets have data
        let quality = 0;
        if (reading.dte0_avg_iv) quality++;
        if (reading.dte1_avg_iv) quality++;
        if (reading.dte2_avg_iv) quality++;
        reading.quality = quality;

        if (hasData) readings.push(reading);
      }

      resolve({ readings, lineCount });
    });

    rl.on('error', reject);
  });
}

// ============================================================================
// Statistics Mode Processing
// ============================================================================

function getStatisticsFiles(product) {
  const statsDir = path.join(DATA_DIR, 'statistics', product.toLowerCase());
  if (!fs.existsSync(statsDir)) {
    console.error(`Statistics directory not found: ${statsDir}`);
    return [];
  }

  const files = fs.readdirSync(statsDir)
    .filter(f => f.endsWith('.csv') && f.includes('statistics'))
    .sort();

  return files.map(f => {
    const match = f.match(/opra-pillar-(\d{8})/);
    const dateStr = match ? match[1] : null;
    let date = null;
    if (dateStr) {
      const y = parseInt(dateStr.substring(0, 4));
      const m = parseInt(dateStr.substring(4, 6)) - 1;
      const d = parseInt(dateStr.substring(6, 8));
      date = new Date(Date.UTC(y, m, d));
    }
    return { filename: f, path: path.join(statsDir, f), date, dateStr };
  });
}

/**
 * Process a single statistics file for 0-2 DTE IV (daily)
 */
function processStatisticsFile(filePath, product, fileDate, spotPrice) {
  return new Promise((resolve, reject) => {
    // stat_type=9 → OI (quantity), stat_type=11 → close price (price)
    const contracts = new Map(); // symbol -> { oi, closePrice }
    let header = null;
    let statTypeIdx, priceIdx, quantityIdx, symbolIdx;

    const rl = readline.createInterface({
      input: fs.createReadStream(filePath),
      crlfDelay: Infinity
    });

    rl.on('line', (line) => {
      if (!header) {
        header = line.split(',');
        statTypeIdx = header.indexOf('stat_type');
        priceIdx = header.indexOf('price');
        quantityIdx = header.indexOf('quantity');
        symbolIdx = header.indexOf('symbol');
        return;
      }

      const cols = line.split(',');
      if (cols.length < symbolIdx + 1) return;

      const statType = parseInt(cols[statTypeIdx]);
      const symbol = cols[symbolIdx];

      if (!contracts.has(symbol)) contracts.set(symbol, { oi: 0, closePrice: 0 });
      const contract = contracts.get(symbol);

      if (statType === 9) {
        // OI — take max quantity
        const qty = parseFloat(cols[quantityIdx]);
        if (!isNaN(qty) && qty > contract.oi) contract.oi = qty;
      } else if (statType === 11) {
        // Close price — take max price
        const price = parseFloat(cols[priceIdx]);
        if (!isNaN(price) && price > contract.closePrice) contract.closePrice = price;
      }
    });

    rl.on('close', () => {
      const dteBuckets = { 0: { calls: [], puts: [] }, 1: { calls: [], puts: [] }, 2: { calls: [], puts: [] } };

      for (const [symbol, data] of contracts) {
        if (data.oi <= 0 || data.closePrice <= 0) continue;

        const parsed = parseOptionSymbol(symbol, product);
        if (!parsed) continue;

        const dte = Math.floor((parsed.expiration - fileDate) / (1000 * 60 * 60 * 24));
        if (dte < 0 || dte > 2) continue;

        // Check ATM (within 2% of spot)
        const moneyness = Math.abs(parsed.strike - spotPrice) / spotPrice;
        if (moneyness > 0.02) continue;

        // Time to expiry, with floor
        let T = dte / 365;
        T = Math.max(T, MIN_TIME);

        // Try Newton-Raphson first, then Brenner-Subrahmanyam fallback
        let iv = calculateIV(data.closePrice, spotPrice, parsed.strike, T, RISK_FREE_RATE, parsed.optionType);
        if (!iv || iv < MIN_IV || iv > MAX_IV) {
          iv = brennerSubrahmanyamIV(data.closePrice, spotPrice, parsed.strike, T, parsed.optionType);
        }
        if (!iv || iv < MIN_IV || iv > MAX_IV) continue;

        const entry = { strike: parsed.strike, iv, moneyness, oi: data.oi };
        if (parsed.optionType === 'C') {
          dteBuckets[dte].calls.push(entry);
        } else {
          dteBuckets[dte].puts.push(entry);
        }
      }

      const reading = {
        timestamp: fileDate.toISOString().split('T')[0],
        spotPrice
      };
      let hasData = false;

      for (const dte of [0, 1, 2]) {
        const bucket = dteBuckets[dte];
        // Sort by moneyness (closest to ATM first)
        const sortByMoneyness = (a, b) => a.moneyness - b.moneyness;
        bucket.calls.sort(sortByMoneyness);
        bucket.puts.sort(sortByMoneyness);

        const atmCall = bucket.calls[0];
        const atmPut = bucket.puts[0];

        if (atmCall || atmPut) {
          hasData = true;
          const callIV = atmCall ? atmCall.iv : null;
          const putIV = atmPut ? atmPut.iv : null;
          const avgIV = callIV && putIV ? (callIV + putIV) / 2 : (callIV || putIV);
          const skew = callIV && putIV ? putIV - callIV : null;
          const strike = atmCall ? atmCall.strike : atmPut.strike;

          reading[`dte${dte}_atm_strike`] = strike;
          reading[`dte${dte}_call_iv`] = callIV;
          reading[`dte${dte}_put_iv`] = putIV;
          reading[`dte${dte}_avg_iv`] = avgIV;
          reading[`dte${dte}_skew`] = skew;
        } else {
          reading[`dte${dte}_atm_strike`] = null;
          reading[`dte${dte}_call_iv`] = null;
          reading[`dte${dte}_put_iv`] = null;
          reading[`dte${dte}_avg_iv`] = null;
          reading[`dte${dte}_skew`] = null;
        }
      }

      reading.term_slope = (reading.dte1_avg_iv && reading.dte0_avg_iv)
        ? reading.dte1_avg_iv - reading.dte0_avg_iv : null;

      let quality = 0;
      if (reading.dte0_avg_iv) quality++;
      if (reading.dte1_avg_iv) quality++;
      if (reading.dte2_avg_iv) quality++;
      reading.quality = quality;

      resolve(hasData ? reading : null);
    });

    rl.on('error', reject);
  });
}

// ============================================================================
// CSV Output
// ============================================================================

const CSV_HEADER = [
  'timestamp', 'spot_price',
  'dte0_atm_strike', 'dte0_call_iv', 'dte0_put_iv', 'dte0_avg_iv', 'dte0_skew',
  'dte1_atm_strike', 'dte1_call_iv', 'dte1_put_iv', 'dte1_avg_iv', 'dte1_skew',
  'dte2_atm_strike', 'dte2_call_iv', 'dte2_put_iv', 'dte2_avg_iv', 'dte2_skew',
  'term_slope', 'quality'
].join(',');

function readingToCSVRow(r) {
  const fmt = (v) => v === null || v === undefined ? '' : typeof v === 'number' ? v.toFixed(6) : v;
  const fmtStrike = (v) => v === null || v === undefined ? '' : typeof v === 'number' ? v.toFixed(2) : v;
  const fmtSpot = (v) => v === null || v === undefined ? '' : typeof v === 'number' ? v.toFixed(2) : v;

  return [
    r.timestamp, fmtSpot(r.spotPrice),
    fmtStrike(r.dte0_atm_strike), fmt(r.dte0_call_iv), fmt(r.dte0_put_iv), fmt(r.dte0_avg_iv), fmt(r.dte0_skew),
    fmtStrike(r.dte1_atm_strike), fmt(r.dte1_call_iv), fmt(r.dte1_put_iv), fmt(r.dte1_avg_iv), fmt(r.dte1_skew),
    fmtStrike(r.dte2_atm_strike), fmt(r.dte2_call_iv), fmt(r.dte2_put_iv), fmt(r.dte2_avg_iv), fmt(r.dte2_skew),
    fmt(r.term_slope), r.quality
  ].join(',');
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  let source = 'tcbbo';
  let product = 'qqq';
  let startDate = null;
  let endDate = null;
  let outputPath = null;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--source': source = args[++i]; break;
      case '--product': product = args[++i].toLowerCase(); break;
      case '--start': {
        const [y, m, d] = args[++i].split('-').map(Number);
        startDate = new Date(Date.UTC(y, m - 1, d));
        break;
      }
      case '--end': {
        const [y, m, d] = args[++i].split('-').map(Number);
        endDate = new Date(Date.UTC(y, m - 1, d));
        break;
      }
      case '--output': outputPath = args[++i]; break;
      case '--help':
        console.log('Usage: node precompute-short-dte-iv.js --source <tcbbo|statistics> --product <qqq|spy> --start YYYY-MM-DD --end YYYY-MM-DD [--output path]');
        process.exit(0);
    }
  }

  if (!startDate || !endDate) {
    console.log('Usage: node precompute-short-dte-iv.js --source <tcbbo|statistics> --product <qqq|spy> --start YYYY-MM-DD --end YYYY-MM-DD');
    process.exit(1);
  }

  console.log(`\n0-2 DTE IV Precomputation`);
  console.log(`  Source: ${source}`);
  console.log(`  Product: ${product.toUpperCase()}`);
  console.log(`  Range: ${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]}`);

  if (source === 'tcbbo') {
    await runTCBBOMode(product, startDate, endDate, outputPath);
  } else if (source === 'statistics') {
    await runStatisticsMode(product, startDate, endDate, outputPath);
  } else {
    console.error(`Unknown source: ${source}. Use 'tcbbo' or 'statistics'.`);
    process.exit(1);
  }
}

async function runTCBBOMode(product, startDate, endDate, outputPath) {
  outputPath = outputPath || path.join(DATA_DIR, 'iv', product.toLowerCase(), `${product.toLowerCase()}_short_dte_iv_15m.csv`);

  // Load spot prices
  const spotPrices = loadSpotPrices(product);

  // Get TCBBO files
  const files = getTCBBOFiles(product);
  console.log(`Found ${files.length} TCBBO files`);

  const filteredFiles = files.filter(f => f.date && f.date >= startDate && f.date <= endDate);
  console.log(`Processing ${filteredFiles.length} files in date range\n`);

  const allReadings = [];
  let processedDays = 0;

  for (const file of filteredFiles) {
    process.stdout.write(`Processing ${file.filename}...`);
    try {
      const { readings, lineCount } = await processTCBBOFile(file.path, product, spotPrices);
      allReadings.push(...readings);
      console.log(` ${readings.length} intervals (${lineCount.toLocaleString()} lines)`);
      processedDays++;
    } catch (err) {
      console.log(` ERROR: ${err.message}`);
    }
  }

  // Sort and write
  allReadings.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  writeOutput(allReadings, outputPath);
  printStats(allReadings, processedDays, 'TCBBO intraday');
}

async function runStatisticsMode(product, startDate, endDate, outputPath) {
  outputPath = outputPath || path.join(DATA_DIR, 'iv', product.toLowerCase(), `${product.toLowerCase()}_short_dte_iv_daily.csv`);

  // Load daily close spot prices
  const spotPrices = loadDailyCloseSpotPrices(product);

  // Get statistics files
  const files = getStatisticsFiles(product);
  console.log(`Found ${files.length} statistics files`);

  const filteredFiles = files.filter(f => f.date && f.date >= startDate && f.date <= endDate);
  console.log(`Processing ${filteredFiles.length} files in date range\n`);

  const allReadings = [];
  let processedDays = 0;

  for (const file of filteredFiles) {
    const dateStr = file.date.toISOString().split('T')[0];
    const spotPrice = spotPrices.get(dateStr);

    process.stdout.write(`Processing ${file.filename}...`);

    if (!spotPrice) {
      console.log(` no spot price for ${dateStr}`);
      continue;
    }

    try {
      const reading = await processStatisticsFile(file.path, product, file.date, spotPrice);
      if (reading) {
        allReadings.push(reading);
        console.log(` q=${reading.quality} dte0=${reading.dte0_avg_iv ? (reading.dte0_avg_iv * 100).toFixed(1) + '%' : 'n/a'}`);
      } else {
        console.log(` no 0-2 DTE options`);
      }
      processedDays++;
    } catch (err) {
      console.log(` ERROR: ${err.message}`);
    }
  }

  // Sort and write
  allReadings.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  writeOutput(allReadings, outputPath);
  printStats(allReadings, processedDays, 'Statistics daily');
}

function writeOutput(readings, outputPath) {
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const rows = readings.map(readingToCSVRow);
  fs.writeFileSync(outputPath, CSV_HEADER + '\n' + rows.join('\n') + '\n');
  console.log(`\nWrote ${readings.length} records to ${outputPath}`);
}

function printStats(readings, processedDays, mode) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`${mode} Results`);
  console.log(`${'─'.repeat(60)}`);
  console.log(`  Days processed: ${processedDays}`);
  console.log(`  Total records: ${readings.length}`);

  for (const dte of [0, 1, 2]) {
    const ivValues = readings.map(r => r[`dte${dte}_avg_iv`]).filter(v => v !== null && v !== undefined);
    if (ivValues.length > 0) {
      const avg = ivValues.reduce((a, b) => a + b, 0) / ivValues.length;
      const min = Math.min(...ivValues);
      const max = Math.max(...ivValues);
      console.log(`  DTE ${dte}: ${ivValues.length} readings, avg=${(avg * 100).toFixed(1)}%, min=${(min * 100).toFixed(1)}%, max=${(max * 100).toFixed(1)}%`);
    } else {
      console.log(`  DTE ${dte}: no data`);
    }
  }

  const termSlopes = readings.map(r => r.term_slope).filter(v => v !== null && v !== undefined);
  if (termSlopes.length > 0) {
    const avgSlope = termSlopes.reduce((a, b) => a + b, 0) / termSlopes.length;
    const pctBackwardated = termSlopes.filter(s => s < 0).length / termSlopes.length;
    console.log(`  Term slope: avg=${(avgSlope * 100).toFixed(2)}%, backwardated=${(pctBackwardated * 100).toFixed(1)}%`);
  }

  const qualityCounts = [0, 0, 0, 0];
  readings.forEach(r => qualityCounts[r.quality]++);
  console.log(`  Quality: q3=${qualityCounts[3]} q2=${qualityCounts[2]} q1=${qualityCounts[1]} q0=${qualityCounts[0]}`);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
