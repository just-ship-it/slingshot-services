#!/usr/bin/env node
/**
 * Validate Charm/Vanna Signal Quality
 *
 * Loads precomputed daily CEX/VEX data + ES OHLCV to measure:
 * 1. Does CEX direction predict overnight ES move direction?
 * 2. What is the average overnight return by CEX direction?
 * 3. How does filtering by CEX percentile/VEX/VIX affect hit rate?
 *
 * Must beat 55% directional accuracy to have edge (accounting for spread/commission).
 *
 * Usage:
 *   node scripts/validate-charm-vanna.js
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'backtest-engine', 'data');

// ─── Load daily charm/vanna CSV ────────────────────────────────────────

async function loadDailyCSV() {
  const csvPath = path.join(DATA_DIR, 'charm-vanna', 'es', 'es_charm_vanna_daily.csv');
  if (!fs.existsSync(csvPath)) {
    console.error(`File not found: ${csvPath}`);
    console.error('Run: python backtest-engine/scripts/precompute-charm-vanna.py --start 2023-08-03 --end 2026-01-28');
    process.exit(1);
  }

  return new Promise((resolve, reject) => {
    const records = [];
    let headers = null;

    const rl = readline.createInterface({
      input: fs.createReadStream(csvPath),
      crlfDelay: Infinity
    });

    rl.on('line', (line) => {
      if (!headers) {
        headers = line.split(',').map(h => h.trim());
        return;
      }
      const values = line.split(',');
      const record = {};
      headers.forEach((h, i) => record[h] = values[i]);
      records.push(record);
    });

    rl.on('close', () => resolve(records));
    rl.on('error', reject);
  });
}

// ─── Load ES OHLCV (1s) for overnight returns ─────────────────────────

async function loadESOvernightReturns(dates) {
  // For each date, we need:
  // - ES close at ~4pm ET (entry)
  // - ES price at ~9:30am ET next day (exit)

  const esPath = path.join(DATA_DIR, 'ohlcv', 'es', 'ES_ohlcv_1s.csv');
  if (!fs.existsSync(esPath)) {
    console.error(`ES OHLCV not found: ${esPath}`);
    process.exit(1);
  }

  // Build a set of dates we need (entry date + next business day)
  const dateSet = new Set();
  for (const d of dates) {
    dateSet.add(d);
    // Add next few days to capture exit
    const dt = new Date(d + 'T12:00:00Z');
    for (let i = 1; i <= 4; i++) {
      const next = new Date(dt);
      next.setDate(next.getDate() + i);
      dateSet.add(next.toISOString().split('T')[0]);
    }
  }

  // Extract ES prices at key times using grep for each date
  const { execSync } = await import('child_process');
  const priceMap = new Map(); // date -> { close4pm, open930 }

  for (const dateStr of dateSet) {
    try {
      const result = execSync(
        `grep '${dateStr}' '${esPath}' | head -100000`,
        { encoding: 'utf8', timeout: 60000, maxBuffer: 50 * 1024 * 1024 }
      );

      const lines = result.trim().split('\n').filter(l => l);
      const prices = {};

      for (const line of lines) {
        const parts = line.split(',');
        if (parts.length < 10 || parts[parts.length - 1].includes('-')) continue;

        const ts = parts[0];
        const close = parseFloat(parts[7]);
        if (isNaN(close)) continue;

        // Parse hour in UTC (ES timestamps are UTC)
        const hourMatch = ts.match(/T(\d{2}):(\d{2})/);
        if (!hourMatch) continue;
        const utcHour = parseInt(hourMatch[1]);
        const utcMin = parseInt(hourMatch[2]);

        // 4pm ET = 21:00 UTC (EST) or 20:00 UTC (EDT)
        // Use 20:45-21:05 window for close
        if (utcHour === 20 && utcMin >= 45) {
          prices.close4pm = close;
          prices.close4pmTime = ts;
        } else if (utcHour === 21 && utcMin <= 5) {
          if (!prices.close4pm) {
            prices.close4pm = close;
            prices.close4pmTime = ts;
          }
        }

        // 9:30am ET = 14:30 UTC (EST) or 13:30 UTC (EDT)
        // Use 13:25-14:35 window for open
        if (utcHour === 14 && utcMin >= 25 && utcMin <= 35) {
          prices.open930 = close;
          prices.open930Time = ts;
        } else if (utcHour === 13 && utcMin >= 25 && utcMin <= 35) {
          prices.open930 = close;
          prices.open930Time = ts;
        }
      }

      if (Object.keys(prices).length > 0) {
        priceMap.set(dateStr, prices);
      }
    } catch (err) {
      // grep may return no results for some dates
    }
  }

  return priceMap;
}

// ─── Analysis ──────────────────────────────────────────────────────────

function getNextBusinessDay(dateStr) {
  const dt = new Date(dateStr + 'T12:00:00Z');
  for (let i = 1; i <= 4; i++) {
    const next = new Date(dt);
    next.setDate(next.getDate() + i);
    if (next.getDay() !== 0 && next.getDay() !== 6) {
      return next.toISOString().split('T')[0];
    }
  }
  return null;
}

async function main() {
  console.log('=== Charm/Vanna Signal Validation ===\n');

  // Load data
  console.log('Loading daily charm/vanna data...');
  const dailyData = await loadDailyCSV();
  console.log(`Loaded ${dailyData.length} days\n`);

  if (dailyData.length === 0) {
    console.error('No data to analyze');
    process.exit(1);
  }

  const dates = dailyData.map(d => d.date);

  console.log('Loading ES overnight returns...');
  const priceMap = await loadESOvernightReturns(dates);
  console.log(`ES price data for ${priceMap.size} dates\n`);

  // Build CEX percentile distribution
  const cexValues = dailyData
    .map(d => parseFloat(d.net_cex))
    .filter(v => !isNaN(v) && isFinite(v));

  const absCexSorted = cexValues.map(v => Math.abs(v)).sort((a, b) => a - b);

  function getCexPercentile(value) {
    const abs = Math.abs(value);
    let left = 0, right = absCexSorted.length;
    while (left < right) {
      const mid = (left + right) >> 1;
      if (absCexSorted[mid] < abs) left = mid + 1;
      else right = mid;
    }
    return (left / absCexSorted.length) * 100;
  }

  // Analyze each day
  const results = [];

  for (const day of dailyData) {
    const netCex = parseFloat(day.net_cex);
    const netVex = parseFloat(day.net_vex);
    const vixClose = day.vix_close ? parseFloat(day.vix_close) : null;
    const esSpot = parseFloat(day.es_spot);

    if (isNaN(netCex) || netCex === 0) continue;

    // Get entry price (4pm close on signal day)
    const entryPrices = priceMap.get(day.date);
    if (!entryPrices || !entryPrices.close4pm) continue;

    // Get exit price (9:30am open on next business day)
    const nextDay = getNextBusinessDay(day.date);
    if (!nextDay) continue;
    const exitPrices = priceMap.get(nextDay);
    if (!exitPrices || !exitPrices.open930) continue;

    const entryPrice = entryPrices.close4pm;
    const exitPrice = exitPrices.open930;
    const overnightReturn = exitPrice - entryPrice;

    const cexDirection = netCex > 0 ? 'long' : 'short';
    const expectedReturn = cexDirection === 'long' ? overnightReturn : -overnightReturn;
    const correct = expectedReturn > 0;
    const cexPercentile = getCexPercentile(netCex);
    const vexAgrees = (netCex > 0 && netVex > 0) || (netCex < 0 && netVex < 0);

    const dayOfWeek = new Date(day.date + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long' });

    results.push({
      date: day.date,
      dayOfWeek,
      netCex,
      netVex,
      vixClose,
      cexDirection,
      cexPercentile,
      vexAgrees,
      entryPrice,
      exitPrice,
      overnightReturn,
      expectedReturn,
      correct,
      esSpot
    });
  }

  console.log(`Analyzable days: ${results.length}\n`);

  // ─── Summary Statistics ────────────────────────────────────────────

  function printStats(label, subset) {
    if (subset.length === 0) {
      console.log(`${label}: No data`);
      return;
    }

    const wins = subset.filter(r => r.correct).length;
    const hitRate = (wins / subset.length * 100).toFixed(1);
    const avgReturn = (subset.reduce((s, r) => s + r.expectedReturn, 0) / subset.length).toFixed(2);
    const totalReturn = subset.reduce((s, r) => s + r.expectedReturn, 0).toFixed(2);
    const avgOvernight = (subset.reduce((s, r) => s + Math.abs(r.overnightReturn), 0) / subset.length).toFixed(2);
    const longs = subset.filter(r => r.cexDirection === 'long').length;
    const shorts = subset.filter(r => r.cexDirection === 'short').length;

    console.log(`${label}:`);
    console.log(`  Trades: ${subset.length} (${longs}L/${shorts}S) | Hit Rate: ${hitRate}% | Avg Return: ${avgReturn} pts | Total: ${totalReturn} pts`);
    console.log(`  Avg Overnight Move: ${avgOvernight} pts\n`);
  }

  // Baseline: all signals
  printStats('ALL SIGNALS', results);

  // Baseline: always long (known overnight drift)
  const alwaysLong = results.map(r => ({ ...r, correct: r.overnightReturn > 0, expectedReturn: r.overnightReturn }));
  printStats('ALWAYS LONG (baseline drift)', alwaysLong);

  // By CEX percentile threshold
  for (const pct of [0, 25, 50, 75]) {
    const filtered = results.filter(r => r.cexPercentile >= pct);
    printStats(`CEX >= P${pct}`, filtered);
  }

  // With VEX confirmation
  const vexConfirmed = results.filter(r => r.vexAgrees);
  printStats('VEX Confirms CEX', vexConfirmed);

  // With VEX + P50
  const vexP50 = results.filter(r => r.vexAgrees && r.cexPercentile >= 50);
  printStats('VEX + CEX >= P50', vexP50);

  // VIX filters
  if (results.some(r => r.vixClose != null)) {
    const vixNormal = results.filter(r => r.vixClose != null && r.vixClose >= 12 && r.vixClose <= 35);
    printStats('VIX 12-35 (normal regime)', vixNormal);

    const vixLow = results.filter(r => r.vixClose != null && r.vixClose < 20);
    printStats('VIX < 20 (low vol)', vixLow);

    const vixHigh = results.filter(r => r.vixClose != null && r.vixClose >= 20);
    printStats('VIX >= 20 (elevated)', vixHigh);
  }

  // Day of week analysis
  const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
  console.log('─── By Day of Week ───');
  for (const day of days) {
    const dayFiltered = results.filter(r => r.dayOfWeek === day);
    if (dayFiltered.length > 0) {
      const wins = dayFiltered.filter(r => r.correct).length;
      const avg = (dayFiltered.reduce((s, r) => s + r.expectedReturn, 0) / dayFiltered.length).toFixed(2);
      console.log(`  ${day}: ${dayFiltered.length} trades | ${(wins/dayFiltered.length*100).toFixed(1)}% hit | avg ${avg} pts`);
    }
  }

  // No Friday
  console.log('');
  const noFriday = results.filter(r => r.dayOfWeek !== 'Friday');
  printStats('Excluding Friday', noFriday);

  // Combined best filter
  const bestFilter = results.filter(r =>
    r.cexPercentile >= 50 &&
    r.dayOfWeek !== 'Friday' &&
    (r.vixClose == null || (r.vixClose >= 12 && r.vixClose <= 35))
  );
  printStats('P50 + No Friday + VIX 12-35', bestFilter);

  // Long vs Short breakdown
  console.log('─── Long vs Short ───');
  const longs = results.filter(r => r.cexDirection === 'long');
  const shorts = results.filter(r => r.cexDirection === 'short');
  printStats('LONG signals only', longs);
  printStats('SHORT signals only', shorts);

  // Print threshold guidance
  console.log('\n─── Threshold Guidance ───');
  console.log('Need >55% hit rate after commission (~$5 RT on ES = 0.1pt)');
  console.log('A random walk with 15pt stop / 20pt target gives ~43% hit rate at breakeven');
  console.log('The CEX signal must provide meaningful directional edge above drift');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
