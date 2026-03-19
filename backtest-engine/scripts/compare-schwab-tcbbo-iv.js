#!/usr/bin/env node
/**
 * Compare IV calculations between Schwab live snapshots and Databento TCBBO data.
 *
 * Answers two questions:
 * 1. Does the TCBBO data format match what the backtest precompute uses?
 * 2. Do IVs from both sources agree when using the same calculation method?
 *
 * Approach:
 *   For each Schwab snapshot timestamp, find the nearest TCBBO bid/ask
 *   for matching options, then compute IV using the BACKTEST's vanilla BS
 *   method on both. This isolates data-source differences from calculation
 *   differences.
 *
 * Additionally reports the Schwab mid_iv (Black's model / forward-based)
 * so we can see how much the model choice matters.
 *
 * Usage:
 *   node scripts/compare-schwab-tcbbo-iv.js
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOTS_DIR = path.join(__dirname, '..', 'data', 'schwab-snapshots');

// === Backtest-identical Black-Scholes (from precompute-short-dte-iv.js) ===
const RISK_FREE_RATE = 0.05;
const MIN_IV = 0.05;
const MAX_IV = 5.0;
const BISECTION_HIGH = 5.0;
const MIN_TIME = 1 / 365 / 24;

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

  let iv = 0.30;
  for (let i = 0; i < 100; i++) {
    const price = blackScholesPrice(S, K, T, r, iv, optionType);
    const vega = blackScholesVega(S, K, T, r, iv);
    if (vega < 0.0001) return calculateIVBisection(optionPrice, S, K, T, r, optionType);
    const diff = price - optionPrice;
    if (Math.abs(diff) < 0.0001) return iv;
    iv = iv - diff / vega;
    if (iv <= 0.001) iv = 0.001;
    if (iv > MAX_IV) iv = MAX_IV;
  }
  return calculateIVBisection(optionPrice, S, K, T, r, optionType);
}

function calculateIVBisection(optionPrice, S, K, T, r, optionType) {
  let low = 0.001, high = BISECTION_HIGH;
  for (let i = 0; i < 100; i++) {
    const mid = (low + high) / 2;
    const price = blackScholesPrice(S, K, T, r, mid, optionType);
    if (Math.abs(price - optionPrice) < 0.0001) return mid;
    if (price > optionPrice) high = mid;
    else low = mid;
  }
  return (low + high) / 2;
}

// === Option symbol parser (TCBBO format) ===
function parseOptionSymbol(symbol) {
  symbol = symbol.trim();
  const regex = /(\w+)\s+(\d{6})([CP])(\d{8})/;
  const match = symbol.match(regex);
  if (!match) return null;

  const root = match[1];
  const dateStr = match[2];
  const optionType = match[3];
  const strikeStr = match[4];

  const year = 2000 + parseInt(dateStr.substring(0, 2));
  const month = parseInt(dateStr.substring(2, 4)) - 1;
  const day = parseInt(dateStr.substring(4, 6));
  const expiration = new Date(Date.UTC(year, month, day));
  const strike = parseInt(strikeStr) / 1000;

  return { root, expiration, optionType, strike, expirationStr: `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}` };
}

// === DST helper ===
function isDST(utcMs) {
  const year = new Date(utcMs).getUTCFullYear();
  let sundayCount = 0, dstStart;
  for (let d = 1; d <= 31; d++) {
    if (new Date(Date.UTC(year, 2, d)).getUTCDay() === 0) {
      if (++sundayCount === 2) { dstStart = Date.UTC(year, 2, d, 7, 0, 0); break; }
    }
  }
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
  return { hour: d.getUTCHours(), minute: d.getUTCMinutes() };
}

// === Load TCBBO into time-indexed structure ===
// For each option symbol, store the latest bid/ask per 2-minute window
async function loadTCBBO(filePath) {
  console.log(`Loading TCBBO: ${path.basename(filePath)}...`);
  const WINDOW_MS = 2 * 60 * 1000; // 2-minute windows to match Schwab poll
  // Map: windowTs -> Map<symbol, {bid, ask, ts}>
  const windows = new Map();
  let lineCount = 0;
  let header = null;
  let tsIdx, bidIdx, askIdx, symbolIdx;

  return new Promise((resolve, reject) => {
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

      const windowTs = Math.floor(ts / WINDOW_MS) * WINDOW_MS;
      if (!windows.has(windowTs)) windows.set(windowTs, new Map());
      // Keep the latest quote per symbol per window
      const existing = windows.get(windowTs).get(symbol);
      if (!existing || ts > existing.ts) {
        windows.get(windowTs).set(symbol, { bid, ask, ts });
      }
    });

    rl.on('close', () => {
      console.log(`  Loaded ${lineCount.toLocaleString()} lines, ${windows.size} time windows`);
      resolve(windows);
    });
    rl.on('error', reject);
  });
}

// === Find nearest TCBBO window to a given timestamp ===
function findNearestWindow(windows, targetTs, maxDriftMs = 3 * 60 * 1000) {
  let bestWindow = null;
  let bestDist = Infinity;

  for (const windowTs of windows.keys()) {
    const dist = Math.abs(windowTs - targetTs);
    if (dist < bestDist) {
      bestDist = dist;
      bestWindow = windowTs;
    }
  }

  if (bestWindow !== null && bestDist <= maxDriftMs) {
    return { windowTs: bestWindow, drift: bestDist, quotes: windows.get(bestWindow) };
  }
  return null;
}

// === Build Schwab lookup key from option contract ===
// Schwab symbol format: "QQQ   260313C00600000" (same as TCBBO)
function schwabOptionKey(option) {
  return `${option.strike}_${option.option_type === 'call' ? 'C' : 'P'}`;
}

// === Main comparison ===
async function main() {
  // Find the TCBBO file
  const tcbboFiles = fs.readdirSync(SNAPSHOTS_DIR).filter(f => f.includes('.tcbbo.csv'));
  if (tcbboFiles.length === 0) {
    console.error('No TCBBO files found in', SNAPSHOTS_DIR);
    process.exit(1);
  }

  const tcbboFile = tcbboFiles[0];
  const dateMatch = tcbboFile.match(/(\d{8})/);
  const tcbboDate = dateMatch ? `${dateMatch[1].slice(0, 4)}-${dateMatch[1].slice(4, 6)}-${dateMatch[1].slice(6, 8)}` : null;
  console.log(`TCBBO date: ${tcbboDate}`);

  // Find matching Schwab snapshot directory
  const snapshotDir = path.join(SNAPSHOTS_DIR, tcbboDate);
  if (!fs.existsSync(snapshotDir)) {
    console.error(`No Schwab snapshots for ${tcbboDate} at ${snapshotDir}`);
    process.exit(1);
  }

  const snapshotFiles = fs.readdirSync(snapshotDir)
    .filter(f => f.endsWith('.json'))
    .sort();
  console.log(`Found ${snapshotFiles.length} Schwab snapshots for ${tcbboDate}\n`);

  // Load TCBBO
  const tcbboWindows = await loadTCBBO(path.join(SNAPSHOTS_DIR, tcbboFile));

  // Process each Schwab snapshot
  const comparisons = [];
  let matchedSnapshots = 0;
  let skippedSnapshots = 0;

  // Sample every 5th snapshot to keep output manageable (~40 comparisons)
  const sampleRate = Math.max(1, Math.floor(snapshotFiles.length / 40));

  for (let i = 0; i < snapshotFiles.length; i += sampleRate) {
    const file = snapshotFiles[i];
    const snapshot = JSON.parse(fs.readFileSync(path.join(snapshotDir, file), 'utf8'));
    const snapshotTs = new Date(snapshot.timestamp).getTime();

    // Find nearest TCBBO window
    const nearest = findNearestWindow(tcbboWindows, snapshotTs);
    if (!nearest) {
      skippedSnapshots++;
      continue;
    }

    matchedSnapshots++;
    const et = toET(snapshotTs);
    const timeStr = `${String(et.hour).padStart(2, '0')}:${String(et.minute).padStart(2, '0')}`;

    // Compare QQQ options only (TCBBO is QQQ)
    const qqqChains = snapshot.chains?.QQQ || [];
    if (qqqChains.length === 0) continue;

    // Get spot price from Schwab (use a near-ATM option's context)
    // We need spot to compute IV — find it from the snapshot
    // ATM call delta ~0.5 tells us spot
    let spotPrice = null;
    for (const exp of qqqChains) {
      for (const opt of (exp.options || [])) {
        if (opt.option_type === 'call' && opt.greeks?.delta >= 0.48 && opt.greeks?.delta <= 0.52) {
          spotPrice = opt.strike; // ATM strike ≈ spot for near-dated
          break;
        }
      }
      if (spotPrice) break;
    }
    if (!spotPrice) {
      // Fallback: find closest delta to 0.5
      let bestDelta = Infinity;
      for (const exp of qqqChains) {
        for (const opt of (exp.options || [])) {
          if (opt.option_type === 'call') {
            const dist = Math.abs((opt.greeks?.delta || 0) - 0.5);
            if (dist < bestDelta) {
              bestDelta = dist;
              spotPrice = opt.strike;
            }
          }
        }
      }
    }
    if (!spotPrice) continue;

    // For each Schwab option near ATM, find matching TCBBO quote
    for (const exp of qqqChains) {
      const expDate = exp.expiration;
      if (!expDate) continue;

      // Compute time to expiry (matching backtest method)
      const expMs = new Date(expDate + 'T20:00:00Z').getTime(); // 4 PM ET = 20:00 UTC (during EDT)
      let T = (expMs - snapshotTs) / (365.25 * 24 * 3600000);
      T = Math.max(T, MIN_TIME);

      // DTE
      const dte = Math.round(T * 365.25);

      for (const opt of (exp.options || [])) {
        // Only compare near-ATM (within 2% of spot)
        const moneyness = Math.abs(opt.strike - spotPrice) / spotPrice;
        if (moneyness > 0.02) continue;

        // Skip if no meaningful bid/ask
        if (!opt.bid || !opt.ask || opt.bid <= 0 || opt.ask <= 0) continue;
        const schwabMid = (opt.bid + opt.ask) / 2;

        // Spread filter (same as backtest: 50% of mid)
        if ((opt.ask - opt.bid) / schwabMid > 0.50) continue;

        const optionType = opt.option_type === 'call' ? 'C' : 'P';

        // Build TCBBO symbol to look up
        // TCBBO format: "QQQ   260313C00600000"
        const expYY = expDate.slice(2, 4);
        const expMM = expDate.slice(5, 7);
        const expDD = expDate.slice(8, 10);
        const strikeStr = String(Math.round(opt.strike * 1000)).padStart(8, '0');
        const tcbboSymbol = `QQQ   ${expYY}${expMM}${expDD}${optionType}${strikeStr}`;

        const tcbboQuote = nearest.quotes.get(tcbboSymbol);
        if (!tcbboQuote) continue;

        const tcbboMid = (tcbboQuote.bid + tcbboQuote.ask) / 2;

        // Compute IV using BACKTEST vanilla BS on both data sources
        const schwabIV_bs = calculateIV(schwabMid, spotPrice, opt.strike, T, RISK_FREE_RATE, optionType);
        const tcbboIV_bs = calculateIV(tcbboMid, spotPrice, opt.strike, T, RISK_FREE_RATE, optionType);

        // Schwab's own mid_iv (Black's model / forward-based)
        const schwabIV_own = opt.greeks?.mid_iv || null;

        if (schwabIV_bs && tcbboIV_bs) {
          comparisons.push({
            time: timeStr,
            expiration: expDate,
            dte,
            strike: opt.strike,
            type: optionType,
            spotPrice,
            schwabBid: opt.bid,
            schwabAsk: opt.ask,
            schwabMid: schwabMid.toFixed(3),
            tcbboBid: tcbboQuote.bid,
            tcbboAsk: tcbboQuote.ask,
            tcbboMid: tcbboMid.toFixed(3),
            midDiff: (schwabMid - tcbboMid).toFixed(3),
            schwabIV_vanillaBS: schwabIV_bs,
            tcbboIV_vanillaBS: tcbboIV_bs,
            ivDiff_vanillaBS: schwabIV_bs - tcbboIV_bs,
            schwabIV_blackModel: schwabIV_own,
            ivDiff_models: schwabIV_own ? schwabIV_own - schwabIV_bs : null,
            driftMs: nearest.drift
          });
        }
      }
    }
  }

  // === Report ===
  console.log(`\n${'═'.repeat(80)}`);
  console.log(`SCHWAB vs TCBBO IV COMPARISON — ${tcbboDate}`);
  console.log(`${'═'.repeat(80)}`);
  console.log(`Snapshots matched: ${matchedSnapshots}/${matchedSnapshots + skippedSnapshots}`);
  console.log(`Option comparisons: ${comparisons.length}`);

  if (comparisons.length === 0) {
    console.log('\nNo matching options found. Check date alignment and data availability.');
    process.exit(0);
  }

  // Question 1: Do the bid/ask prices agree between Schwab and TCBBO?
  console.log(`\n${'─'.repeat(80)}`);
  console.log('Q1: DATA SOURCE AGREEMENT (Schwab bid/ask vs TCBBO bid/ask)');
  console.log(`${'─'.repeat(80)}`);

  const midDiffs = comparisons.map(c => Math.abs(parseFloat(c.midDiff)));
  const avgMidDiff = midDiffs.reduce((a, b) => a + b, 0) / midDiffs.length;
  const maxMidDiff = Math.max(...midDiffs);
  const pctSmallDiff = midDiffs.filter(d => d < 0.10).length / midDiffs.length;

  console.log(`  Avg |mid price diff|:    $${avgMidDiff.toFixed(3)}`);
  console.log(`  Max |mid price diff|:    $${maxMidDiff.toFixed(3)}`);
  console.log(`  Within $0.10:            ${(pctSmallDiff * 100).toFixed(1)}%`);

  // Question 2: Do IVs agree when using the SAME calculation (vanilla BS)?
  console.log(`\n${'─'.repeat(80)}`);
  console.log('Q2: IV AGREEMENT (same vanilla BS calculation on both data sources)');
  console.log(`${'─'.repeat(80)}`);

  const ivDiffs = comparisons.map(c => Math.abs(c.ivDiff_vanillaBS));
  const avgIvDiff = ivDiffs.reduce((a, b) => a + b, 0) / ivDiffs.length;
  const maxIvDiff = Math.max(...ivDiffs);
  const pctSmallIvDiff = ivDiffs.filter(d => d < 0.005).length / ivDiffs.length; // within 0.5% IV
  const pctTinyIvDiff = ivDiffs.filter(d => d < 0.001).length / ivDiffs.length; // within 0.1% IV

  console.log(`  Avg |IV diff|:           ${(avgIvDiff * 100).toFixed(3)}% (${avgIvDiff.toFixed(5)} decimal)`);
  console.log(`  Max |IV diff|:           ${(maxIvDiff * 100).toFixed(3)}%`);
  console.log(`  Within 0.5% IV:          ${(pctSmallIvDiff * 100).toFixed(1)}%`);
  console.log(`  Within 0.1% IV:          ${(pctTinyIvDiff * 100).toFixed(1)}%`);

  // Bonus: How much does the model choice matter? (Black's vs vanilla BS on Schwab data)
  console.log(`\n${'─'.repeat(80)}`);
  console.log('BONUS: MODEL DIFFERENCE (Schwab Black\'s model vs vanilla BS on same Schwab data)');
  console.log(`${'─'.repeat(80)}`);

  const modelDiffs = comparisons.filter(c => c.ivDiff_models !== null).map(c => c.ivDiff_models);
  if (modelDiffs.length > 0) {
    const absModelDiffs = modelDiffs.map(d => Math.abs(d));
    const avgModelDiff = absModelDiffs.reduce((a, b) => a + b, 0) / absModelDiffs.length;
    const maxModelDiff = Math.max(...absModelDiffs);
    const signedAvg = modelDiffs.reduce((a, b) => a + b, 0) / modelDiffs.length;

    console.log(`  Avg |model diff|:        ${(avgModelDiff * 100).toFixed(3)}%`);
    console.log(`  Max |model diff|:        ${(maxModelDiff * 100).toFixed(3)}%`);
    console.log(`  Signed avg (Black-BS):   ${(signedAvg * 100).toFixed(3)}%`);
    console.log(`  (Positive = Black's model gives higher IV than vanilla BS)`);
  }

  // Breakdown by DTE
  console.log(`\n${'─'.repeat(80)}`);
  console.log('BREAKDOWN BY DTE');
  console.log(`${'─'.repeat(80)}`);

  const byDTE = {};
  for (const c of comparisons) {
    if (!byDTE[c.dte]) byDTE[c.dte] = [];
    byDTE[c.dte].push(c);
  }

  for (const dte of Object.keys(byDTE).sort((a, b) => a - b)) {
    const group = byDTE[dte];
    const diffs = group.map(c => Math.abs(c.ivDiff_vanillaBS));
    const avg = diffs.reduce((a, b) => a + b, 0) / diffs.length;
    const midDiffsGroup = group.map(c => Math.abs(parseFloat(c.midDiff)));
    const avgMid = midDiffsGroup.reduce((a, b) => a + b, 0) / midDiffsGroup.length;
    console.log(`  DTE ${dte}: ${group.length} comparisons, avg IV diff=${(avg * 100).toFixed(3)}%, avg mid diff=$${avgMid.toFixed(3)}`);
  }

  // Sample detail rows
  console.log(`\n${'─'.repeat(80)}`);
  console.log('SAMPLE COMPARISONS (sorted by largest IV diff)');
  console.log(`${'─'.repeat(80)}`);

  const sorted = [...comparisons].sort((a, b) => Math.abs(b.ivDiff_vanillaBS) - Math.abs(a.ivDiff_vanillaBS));
  const samples = [
    ...sorted.slice(0, 5),  // 5 largest diffs
    ...sorted.slice(-5)     // 5 smallest diffs
  ];

  console.log(`${'Time'.padEnd(6)} ${'Exp'.padEnd(11)} ${'K'.padStart(6)} ${'T'.padStart(2)} ${'Schwab Mid'.padStart(11)} ${'TCBBO Mid'.padStart(10)} ${'Diff$'.padStart(7)} ${'SchIV(BS)'.padStart(10)} ${'TcIV(BS)'.padStart(10)} ${'IVdiff'.padStart(8)} ${'SchIV(Blk)'.padStart(11)}`);
  for (const c of samples) {
    console.log(
      `${c.time.padEnd(6)} ${c.expiration.padEnd(11)} ${String(c.strike).padStart(6)} ${c.type.padStart(2)} ` +
      `${('$' + c.schwabMid).padStart(11)} ${('$' + c.tcbboMid).padStart(10)} ${('$' + c.midDiff).padStart(7)} ` +
      `${(c.schwabIV_vanillaBS * 100).toFixed(2).padStart(9)}% ${(c.tcbboIV_vanillaBS * 100).toFixed(2).padStart(9)}% ` +
      `${(c.ivDiff_vanillaBS * 100).toFixed(2).padStart(7)}% ` +
      `${c.schwabIV_blackModel ? (c.schwabIV_blackModel * 100).toFixed(2).padStart(10) + '%' : '       N/A'}`
    );
  }

  // Summary verdict
  console.log(`\n${'═'.repeat(80)}`);
  console.log('VERDICT');
  console.log(`${'═'.repeat(80)}`);

  if (avgIvDiff < 0.005) {
    console.log('  IV calculations AGREE between Schwab and TCBBO data sources.');
    console.log(`  Average IV difference of ${(avgIvDiff * 100).toFixed(3)}% is within acceptable tolerance.`);
  } else if (avgIvDiff < 0.02) {
    console.log('  IV calculations show SMALL differences between data sources.');
    console.log(`  Average IV difference of ${(avgIvDiff * 100).toFixed(3)}% — likely due to quote timing differences.`);
  } else {
    console.log('  IV calculations show SIGNIFICANT differences between data sources.');
    console.log(`  Average IV difference of ${(avgIvDiff * 100).toFixed(3)}% — investigate data alignment.`);
  }

  if (avgMidDiff < 0.05) {
    console.log(`  Bid/ask prices closely aligned (avg diff $${avgMidDiff.toFixed(3)}).`);
  } else {
    console.log(`  Bid/ask prices diverge (avg diff $${avgMidDiff.toFixed(3)}) — likely timing offset between sources.`);
  }
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
