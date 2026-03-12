#!/usr/bin/env node
/**
 * Verify that the live IV calculator's vanilla BS functions produce
 * the same results as the backtest precompute-iv.js script.
 *
 * Loads CBBO data for a given date, computes IV using the same BS
 * functions as the live iv-skew-calculator.js, and compares against
 * the precomputed CSV values.
 *
 * Usage:
 *   node scripts/verify-live-vs-backtest-iv.js [--date 2025-06-16]
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataDir = path.join(__dirname, '..', 'data');

// ============================================================================
// Copy of vanilla BS functions from iv-skew-calculator.js (live system)
// These MUST be identical to what the live calculator uses
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
  const intrinsic = optionType === 'C' ? Math.max(0, S - K) : Math.max(0, K - S);
  if (optionPrice < intrinsic * 0.99) return null;

  let iv = 0.25;
  for (let i = 0; i < 100; i++) {
    const price = blackScholesPrice(S, K, T, r, iv, optionType);
    const vega = blackScholesVega(S, K, T, r, iv);
    if (vega < 0.0001) return calculateIVBisection(optionPrice, S, K, T, r, optionType);
    const diff = price - optionPrice;
    if (Math.abs(diff) < 0.0001) return iv;
    iv = iv - diff / vega;
    if (iv <= 0.001) iv = 0.001;
    if (iv > 5.0) iv = 5.0;
  }
  return calculateIVBisection(optionPrice, S, K, T, r, optionType);
}

function calculateIVBisection(optionPrice, S, K, T, r, optionType) {
  let low = 0.001, high = 3.0;
  for (let i = 0; i < 100; i++) {
    const mid = (low + high) / 2;
    const price = blackScholesPrice(S, K, T, r, mid, optionType);
    if (Math.abs(price - optionPrice) < 0.0001) return mid;
    if (price > optionPrice) high = mid;
    else low = mid;
  }
  return (low + high) / 2;
}

// ============================================================================
// Copy of precompute-iv.js functions (backtest)
// These are the ORIGINAL functions from the file, before our changes
// ============================================================================

function normalCDF_backtest(x) {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.sqrt(2);
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1.0 + sign * y);
}

function blackScholesPrice_backtest(S, K, T, r, sigma, optionType) {
  if (T <= 0 || sigma <= 0) return 0;
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  if (optionType === 'C') {
    return S * normalCDF_backtest(d1) - K * Math.exp(-r * T) * normalCDF_backtest(d2);
  } else {
    return K * Math.exp(-r * T) * normalCDF_backtest(-d2) - S * normalCDF_backtest(-d1);
  }
}

function blackScholesVega_backtest(S, K, T, r, sigma) {
  if (T <= 0 || sigma <= 0) return 0;
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  return S * Math.sqrt(T) * normalPDF_BS(d1);
}

function calculateIV_backtest(optionPrice, S, K, T, r, optionType) {
  if (optionPrice <= 0 || T <= 0) return null;
  const intrinsic = optionType === 'C' ? Math.max(0, S - K) : Math.max(0, K - S);
  if (optionPrice < intrinsic * 0.99) return null;

  let iv = 0.25;
  for (let i = 0; i < 100; i++) {
    const price = blackScholesPrice_backtest(S, K, T, r, iv, optionType);
    const vega = blackScholesVega_backtest(S, K, T, r, iv);
    if (vega < 0.0001) {
      // bisection fallback
      let lo = 0.001, hi = 3.0;
      for (let j = 0; j < 100; j++) {
        const mid = (lo + hi) / 2;
        const p = blackScholesPrice_backtest(S, K, T, r, mid, optionType);
        if (Math.abs(p - optionPrice) < 0.0001) return mid;
        if (p > optionPrice) hi = mid; else lo = mid;
      }
      return (lo + hi) / 2;
    }
    const diff = price - optionPrice;
    if (Math.abs(diff) < 0.0001) return iv;
    iv = iv - diff / vega;
    if (iv <= 0.001) iv = 0.001;
    if (iv > 5.0) iv = 5.0;
  }
  return null;
}

// ============================================================================
// Option symbol parser (from precompute-iv.js)
// ============================================================================

function parseOptionSymbol(symbol) {
  symbol = symbol.trim();
  const match = symbol.match(/QQQ\s+(\d{6})([CP])(\d{8})/);
  if (!match) return null;
  const dateStr = match[1];
  const optionType = match[2];
  const strikeStr = match[3];
  const year = 2000 + parseInt(dateStr.substring(0, 2));
  const month = parseInt(dateStr.substring(2, 4)) - 1;
  const day = parseInt(dateStr.substring(4, 6));
  const expiration = new Date(year, month, day);
  const strike = parseInt(strikeStr) / 1000;
  return { expiration, optionType, strike };
}

// ============================================================================
// Data loading
// ============================================================================

function loadQQQSpotPrices() {
  const csvPath = path.join(dataDir, 'ohlcv', 'qqq', 'QQQ_ohlcv_1m.csv');
  const content = fs.readFileSync(csvPath, 'utf8');
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
    if (!isNaN(close)) spotPrices.set(ts, close);
  }
  return spotPrices;
}

function loadPrecomputedIV(date) {
  const csvPath = path.join(dataDir, 'iv', 'qqq', 'qqq_atm_iv_15m.csv');
  const content = fs.readFileSync(csvPath, 'utf8');
  const lines = content.split('\n');
  const header = lines[0].split(',');
  const records = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (cols.length < 7) continue;
    const ts = cols[0];
    if (!ts.startsWith(date)) continue;
    records.push({
      timestamp: ts,
      iv: parseFloat(cols[1]),
      spotPrice: parseFloat(cols[2]),
      atmStrike: parseFloat(cols[3]),
      callIV: parseFloat(cols[4]),
      putIV: parseFloat(cols[5]),
      dte: parseInt(cols[6])
    });
  }
  return records;
}

function loadCBBOForDate(filePath) {
  return new Promise((resolve, reject) => {
    const intervals = new Map();
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
      const intervalTs = Math.floor(ts / (15 * 60 * 1000)) * (15 * 60 * 1000);
      const bid = parseFloat(cols[bidIdx]);
      const ask = parseFloat(cols[askIdx]);
      const symbol = cols[symbolIdx];
      if (isNaN(bid) || isNaN(ask) || bid <= 0 || ask <= 0) return;
      if (ask < bid) return;
      if ((ask - bid) / bid > 0.5) return;
      if (!intervals.has(intervalTs)) intervals.set(intervalTs, new Map());
      intervals.get(intervalTs).set(symbol, { bid, ask });
    });

    rl.on('close', () => resolve(intervals));
    rl.on('error', reject);
  });
}

// ============================================================================
// Live calculator simulation
// Mimics iv-skew-calculator.js getATMIVData() logic using CBBO data
// ============================================================================

function computeLiveIV(spotPrice, optionQuotes, currentDate) {
  // Find ATM options (same logic as precompute)
  const atmOptions = [];
  for (const [symbol, quote] of optionQuotes) {
    const parsed = parseOptionSymbol(symbol);
    if (!parsed) continue;
    const dte = Math.floor((parsed.expiration - currentDate) / (1000 * 60 * 60 * 24));
    if (dte < 7 || dte > 45) continue;
    const moneyness = Math.abs(parsed.strike - spotPrice) / spotPrice;
    if (moneyness > 0.02) continue;
    const mid = (quote.bid + quote.ask) / 2;
    const T = dte / 365;

    // Use the LIVE calculator's BS functions
    const optType = parsed.optionType;  // 'C' or 'P'
    const iv = calculateIV(mid, spotPrice, parsed.strike, T, BS_RISK_FREE_RATE, optType);
    if (iv && iv > 0.05 && iv < 2.0) {
      atmOptions.push({ symbol, strike: parsed.strike, optionType: optType, dte, mid, iv });
    }
  }

  if (atmOptions.length === 0) return null;

  const calls = atmOptions.filter(o => o.optionType === 'C');
  const puts = atmOptions.filter(o => o.optionType === 'P');
  const sortByMoneyness = (a, b) => Math.abs(a.strike - spotPrice) - Math.abs(b.strike - spotPrice);
  calls.sort(sortByMoneyness);
  puts.sort(sortByMoneyness);

  const atmCall = calls[0];
  const atmPut = puts[0];
  if (!atmCall || !atmPut) return null;

  return {
    callIV: atmCall.iv,
    putIV: atmPut.iv,
    iv: (atmCall.iv + atmPut.iv) / 2,
    atmStrike: (atmCall.strike + atmPut.strike) / 2,
    dte: Math.min(atmCall.dte, atmPut.dte)
  };
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const dateArg = process.argv.find((a, i) => process.argv[i - 1] === '--date') || '2025-06-16';
  const dateStr = dateArg;  // YYYY-MM-DD
  const cbboDate = dateStr.replace(/-/g, '');

  console.log(`\nVerifying live vs backtest IV for ${dateStr}\n`);

  // Load precomputed CSV values for this date
  const precomputed = loadPrecomputedIV(dateStr);
  if (precomputed.length === 0) {
    console.error(`No precomputed IV data found for ${dateStr}`);
    process.exit(1);
  }
  console.log(`Precomputed CSV: ${precomputed.length} records for ${dateStr}`);

  // Load CBBO data
  const cbboFile = path.join(dataDir, 'cbbo-1m', 'qqq', `opra-pillar-${cbboDate}.cbbo-1m.0000.csv`);
  if (!fs.existsSync(cbboFile)) {
    console.error(`CBBO file not found: ${cbboFile}`);
    process.exit(1);
  }
  console.log(`Loading CBBO data from ${path.basename(cbboFile)}...`);
  const intervals = await loadCBBOForDate(cbboFile);
  console.log(`Loaded ${intervals.size} 15-min intervals\n`);

  // Load spot prices
  console.log('Loading QQQ spot prices...');
  const spotPrices = loadQQQSpotPrices();

  // Compare each precomputed interval against live calculation
  console.log('Interval              | Spot    | ATM   | DTE | Precomputed Call/Put IV  | Live Calc Call/Put IV    | Diff Call   | Diff Put');
  console.log('─'.repeat(140));

  let matched = 0, total = 0, maxDiff = 0;

  for (const precomp of precomputed) {
    const ts = new Date(precomp.timestamp).getTime();
    const quotes = intervals.get(ts);
    const spotPrice = spotPrices.get(ts);

    if (!quotes || !spotPrice) continue;
    total++;

    const liveResult = computeLiveIV(spotPrice, quotes, new Date(ts));
    if (!liveResult) {
      console.log(`${precomp.timestamp} | ${precomp.spotPrice.toFixed(2)} | ${precomp.atmStrike} | ${precomp.dte}  | ${(precomp.callIV * 100).toFixed(2)}% / ${(precomp.putIV * 100).toFixed(2)}%    | FAILED                   |`);
      continue;
    }

    const callDiff = Math.abs(liveResult.callIV - precomp.callIV);
    const putDiff = Math.abs(liveResult.putIV - precomp.putIV);
    const maxD = Math.max(callDiff, putDiff);
    maxDiff = Math.max(maxDiff, maxD);

    const callMatch = callDiff < 0.0002 ? '✓' : '✗';
    const putMatch = putDiff < 0.0002 ? '✓' : '✗';
    const isMatch = callDiff < 0.0002 && putDiff < 0.0002;
    if (isMatch) matched++;

    console.log(
      `${precomp.timestamp} | ${precomp.spotPrice.toFixed(2)} | ${precomp.atmStrike.toFixed(0).padStart(5)} | ${String(precomp.dte).padStart(3)} ` +
      `| ${(precomp.callIV * 100).toFixed(2)}% / ${(precomp.putIV * 100).toFixed(2)}%        ` +
      `| ${(liveResult.callIV * 100).toFixed(2)}% / ${(liveResult.putIV * 100).toFixed(2)}%        ` +
      `| ${callMatch} ${(callDiff * 100).toFixed(4)}%  | ${putMatch} ${(putDiff * 100).toFixed(4)}%`
    );
  }

  console.log('─'.repeat(140));
  console.log(`\nResults: ${matched}/${total} intervals match exactly (tolerance < 0.02%)`);
  console.log(`Max IV difference: ${(maxDiff * 100).toFixed(4)}%`);

  if (matched === total && total > 0) {
    console.log('\n✓ PASS: Live calculator produces identical IV to backtest precompute');
  } else if (maxDiff < 0.001) {
    console.log('\n~ PASS: Differences within 0.1% tolerance (floating point)');
  } else {
    console.log('\n✗ FAIL: Significant differences detected');
  }
}

main().catch(err => { console.error(err); process.exit(1); });
