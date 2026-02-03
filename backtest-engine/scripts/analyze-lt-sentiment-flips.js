/**
 * LT Sentiment Flip Analysis
 *
 * Analyzes whether LT sentiment flips (BULLISH <-> BEARISH transitions) correlate
 * with future price action, with special focus on flips after prolonged periods
 * of the same sentiment.
 *
 * Key question: Do flips after extended same-sentiment periods (20+ prints = 5+ hours)
 * predict direction better than short flips?
 *
 * Usage:
 *   node backtest-engine/scripts/analyze-lt-sentiment-flips.js [options]
 *
 * Options:
 *   --start <date>       Start date (default: 2023-03-09)
 *   --end <date>         End date (default: 2025-12-31)
 *   --min-duration <n>   Filter flips with N+ consecutive prints before
 *   --session <name>     Filter: all, rth, overnight, premarket
 *   --output-json <path> JSON output path
 *   --output-csv <path>  CSV output path
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataDir = path.join(__dirname, '..');

// ============================================================
// CLI ARGUMENT PARSING
// ============================================================

function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    startDate: new Date('2023-03-09'),
    endDate: new Date('2025-12-31'),
    minDuration: 0,
    session: 'all',
    outputJson: null,
    outputCsv: null,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--start':
        config.startDate = new Date(args[++i]);
        break;
      case '--end':
        config.endDate = new Date(args[++i]);
        break;
      case '--min-duration':
        config.minDuration = parseInt(args[++i]) || 0;
        break;
      case '--session':
        config.session = args[++i];
        break;
      case '--output-json':
        config.outputJson = args[++i];
        break;
      case '--output-csv':
        config.outputCsv = args[++i];
        break;
      case '--help':
      case '-h':
        console.log(`
LT Sentiment Flip Analysis

Usage:
  node analyze-lt-sentiment-flips.js [options]

Options:
  --start <date>       Start date (default: 2023-03-09)
  --end <date>         End date (default: 2025-12-31)
  --min-duration <n>   Filter flips with N+ consecutive prints before
  --session <name>     Filter: all, rth, overnight, premarket
  --output-json <path> JSON output path
  --output-csv <path>  CSV output path
  --help, -h           Show this help
`);
        process.exit(0);
    }
  }

  return config;
}

// ============================================================
// DATA LOADING
// ============================================================

function loadLTLevels(startDate, endDate) {
  const file = path.join(dataDir, 'data', 'liquidity', 'nq', 'NQ_liquidity_levels.csv');
  const lines = fs.readFileSync(file, 'utf-8').trim().split('\n');

  const records = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i].split(',');
    // Columns: datetime, unix_timestamp, sentiment, level_1..level_5
    const timestamp = parseInt(vals[1]);
    const datetime = vals[0];
    const sentiment = vals[2];
    const levels = [
      parseFloat(vals[3]),
      parseFloat(vals[4]),
      parseFloat(vals[5]),
      parseFloat(vals[6]),
      parseFloat(vals[7]),
    ];

    // Skip rows with invalid data
    if (isNaN(timestamp) || !sentiment) continue;
    if (levels.some(l => isNaN(l))) continue;

    const date = new Date(timestamp);
    if (date >= startDate && date <= endDate) {
      records.push({ timestamp, datetime, sentiment, levels });
    }
  }

  records.sort((a, b) => a.timestamp - b.timestamp);
  console.log(`📊 Loaded ${records.length} LT level records`);
  return records;
}

function loadNQCandles(startDate, endDate) {
  const file = path.join(dataDir, 'data', 'ohlcv', 'nq', 'NQ_ohlcv_1m.csv');
  const lines = fs.readFileSync(file, 'utf-8').trim().split('\n');

  // Columns: ts_event[0], rtype[1], publisher_id[2], instrument_id[3],
  //          open[4], high[5], low[6], close[7], volume[8], symbol[9]
  const byHour = new Map();
  const allCandles = [];

  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i].split(',');
    const symbol = vals[9]?.trim();

    // Filter out calendar spreads (symbol contains dash)
    if (symbol && symbol.includes('-')) continue;

    const ts = new Date(vals[0]).getTime();
    const candle = {
      timestamp: ts,
      open: parseFloat(vals[4]),
      high: parseFloat(vals[5]),
      low: parseFloat(vals[6]),
      close: parseFloat(vals[7]),
      volume: parseInt(vals[8]) || 0,
      symbol,
    };

    if (isNaN(candle.close)) continue;

    const candleDate = new Date(ts);
    if (candleDate < startDate || candleDate > endDate) continue;

    const hourKey = Math.floor(ts / 3600000);
    if (!byHour.has(hourKey)) byHour.set(hourKey, []);
    byHour.get(hourKey).push(candle);
    allCandles.push(candle);
  }

  // Primary contract filter: highest volume symbol per hour
  const primarySymbols = new Map();
  for (const [hourKey, hourCandles] of byHour) {
    const volBySymbol = new Map();
    for (const c of hourCandles) {
      volBySymbol.set(c.symbol, (volBySymbol.get(c.symbol) || 0) + c.volume);
    }
    let maxVol = 0, primarySym = null;
    for (const [sym, vol] of volBySymbol) {
      if (vol > maxVol) { maxVol = vol; primarySym = sym; }
    }
    primarySymbols.set(hourKey, primarySym);
  }

  const filtered = allCandles.filter(c => {
    const hourKey = Math.floor(c.timestamp / 3600000);
    return c.symbol === primarySymbols.get(hourKey);
  });

  filtered.sort((a, b) => a.timestamp - b.timestamp);

  console.log(`📊 Loaded ${filtered.length} NQ candles (primary contract filtered)`);
  return filtered;
}

// ============================================================
// FLIP DETECTION
// ============================================================

/**
 * Detect sentiment flips and calculate duration before each flip
 */
function detectFlips(ltRecords) {
  const flips = [];
  let consecutiveCount = 1;
  let streakStartIdx = 0;

  for (let i = 1; i < ltRecords.length; i++) {
    const prev = ltRecords[i - 1];
    const curr = ltRecords[i];

    // Check for data gap (> 30 minutes between records)
    const timeDiff = curr.timestamp - prev.timestamp;
    const hasGap = timeDiff > 30 * 60 * 1000;

    if (hasGap) {
      // Reset streak on data gap
      consecutiveCount = 1;
      streakStartIdx = i;
      continue;
    }

    if (prev.sentiment === curr.sentiment) {
      // Same sentiment, continue streak
      consecutiveCount++;
    } else {
      // FLIP DETECTED
      const flipType = `${prev.sentiment}_TO_${curr.sentiment}`;

      flips.push({
        timestamp: curr.timestamp,
        datetime: curr.datetime,
        flipType,
        fromSentiment: prev.sentiment,
        toSentiment: curr.sentiment,
        durationPrints: consecutiveCount,
        durationMinutes: consecutiveCount * 15,
        prevLevels: prev.levels,
        currLevels: curr.levels,
        streakStartTimestamp: ltRecords[streakStartIdx].timestamp,
      });

      // Reset for new sentiment streak
      consecutiveCount = 1;
      streakStartIdx = i;
    }
  }

  return flips;
}

/**
 * Classify duration into buckets
 */
function getDurationBucket(durationPrints) {
  if (durationPrints <= 4) return 'short (1-4 prints, 15-60min)';
  if (durationPrints <= 9) return 'medium (5-9 prints, 1.25-2.25hr)';
  if (durationPrints <= 19) return 'extended (10-19 prints, 2.5-4.75hr)';
  return 'prolonged (20+ prints, 5+ hr)';
}

// ============================================================
// SESSION CLASSIFICATION
// ============================================================

function getSession(timestamp) {
  const date = new Date(timestamp);
  const hours = date.getUTCHours();
  const minutes = date.getUTCMinutes();
  const dayOfWeek = date.getUTCDay();

  // Convert to EST (UTC-5, simplified - not handling DST)
  const estHours = (hours - 5 + 24) % 24;

  // Weekend check
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    return 'weekend';
  }

  // RTH: 9:30 AM - 4:00 PM EST
  if ((estHours === 9 && minutes >= 30) || (estHours >= 10 && estHours < 16)) {
    return 'rth';
  }

  // Pre-market: 4:00 AM - 9:30 AM EST
  if ((estHours >= 4 && estHours < 9) || (estHours === 9 && minutes < 30)) {
    return 'premarket';
  }

  // After-hours: 4:00 PM - 8:00 PM EST
  if (estHours >= 16 && estHours < 20) {
    return 'afterhours';
  }

  // Overnight: 6:00 PM - 4:00 AM EST (next day)
  return 'overnight';
}

// ============================================================
// PRICE ALIGNMENT & LOOKFORWARD
// ============================================================

/**
 * Binary search to find candle at or just after timestamp
 */
function findCandleAtTime(candles, timestamp) {
  let lo = 0, hi = candles.length - 1, best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].timestamp >= timestamp) {
      best = candles[mid];
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return best;
}

/**
 * Binary search to find candle at or just before timestamp
 */
function findCandleBeforeTime(candles, timestamp) {
  let lo = 0, hi = candles.length - 1, best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].timestamp <= timestamp) {
      best = candles[mid];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

/**
 * Calculate lookforward returns at various windows
 */
function calculateLookforwards(candles, entryTimestamp, entryPrice) {
  const lookforwardMinutes = [5, 15, 30, 60, 240]; // 5m, 15m, 30m, 1hr, 4hr
  const results = {};

  for (const minutes of lookforwardMinutes) {
    const targetTime = entryTimestamp + minutes * 60 * 1000;
    const exitCandle = findCandleBeforeTime(candles, targetTime);

    if (!exitCandle || exitCandle.timestamp <= entryTimestamp) {
      results[minutes] = null;
      continue;
    }

    const priceChange = exitCandle.close - entryPrice;
    const percentChange = (priceChange / entryPrice) * 100;

    results[minutes] = {
      exitPrice: exitCandle.close,
      priceChange,
      percentChange,
      direction: priceChange > 0 ? 'UP' : priceChange < 0 ? 'DOWN' : 'FLAT',
      exitTimestamp: exitCandle.timestamp,
    };
  }

  return results;
}

// ============================================================
// STATISTICAL TESTS
// ============================================================

/**
 * Binomial test - probability of observing k or more successes in n trials
 * given probability p (one-tailed)
 */
function binomialTest(successes, trials, nullProb = 0.5) {
  if (trials === 0) return 1;

  // Calculate cumulative probability using normal approximation for large n
  if (trials > 30) {
    const mean = trials * nullProb;
    const std = Math.sqrt(trials * nullProb * (1 - nullProb));
    const z = (successes - 0.5 - mean) / std; // continuity correction
    // One-tailed p-value
    return 1 - normalCDF(z);
  }

  // Exact calculation for small n
  let pValue = 0;
  for (let k = successes; k <= trials; k++) {
    pValue += binomialCoeff(trials, k) * Math.pow(nullProb, k) * Math.pow(1 - nullProb, trials - k);
  }
  return pValue;
}

function binomialCoeff(n, k) {
  if (k > n) return 0;
  if (k === 0 || k === n) return 1;
  let result = 1;
  for (let i = 0; i < k; i++) {
    result = result * (n - i) / (i + 1);
  }
  return result;
}

function normalCDF(z) {
  const a1 =  0.254829592;
  const a2 = -0.284496736;
  const a3 =  1.421413741;
  const a4 = -1.453152027;
  const a5 =  1.061405429;
  const p  =  0.3275911;

  const sign = z < 0 ? -1 : 1;
  z = Math.abs(z) / Math.sqrt(2);

  const t = 1.0 / (1.0 + p * z);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-z * z);

  return 0.5 * (1.0 + sign * y);
}

/**
 * T-test for comparing two means
 */
function tTest(group1, group2) {
  if (group1.length < 2 || group2.length < 2) return { tStat: 0, pValue: 1 };

  const mean1 = group1.reduce((a, b) => a + b, 0) / group1.length;
  const mean2 = group2.reduce((a, b) => a + b, 0) / group2.length;

  const var1 = group1.reduce((sum, x) => sum + Math.pow(x - mean1, 2), 0) / (group1.length - 1);
  const var2 = group2.reduce((sum, x) => sum + Math.pow(x - mean2, 2), 0) / (group2.length - 1);

  const pooledStdErr = Math.sqrt(var1 / group1.length + var2 / group2.length);
  if (pooledStdErr === 0) return { tStat: 0, pValue: 1 };

  const tStat = (mean1 - mean2) / pooledStdErr;
  const df = Math.min(group1.length - 1, group2.length - 1);

  // Approximate p-value using normal distribution for large df
  const pValue = 2 * (1 - normalCDF(Math.abs(tStat)));

  return { tStat, pValue, mean1, mean2 };
}

// ============================================================
// CROSS-TABULATION & TABLE FORMATTING
// ============================================================

function buildCrossTab(events, groupFn, lookforwardMinutes) {
  const groups = new Map();

  for (const evt of events) {
    const key = groupFn(evt);
    if (key === null || key === undefined) continue;

    if (!groups.has(key)) groups.set(key, { total: 0 });
    const group = groups.get(key);
    group.total++;

    for (const lf of lookforwardMinutes) {
      const lfData = evt.lookforwards[lf];
      if (!lfData) continue;

      const k = `${lf}m`;
      if (!group[k]) group[k] = { up: 0, down: 0, returns: [] };

      if (lfData.direction === 'UP') group[k].up++;
      else if (lfData.direction === 'DOWN') group[k].down++;

      group[k].returns.push(lfData.priceChange);
    }
  }

  return groups;
}

function printTable(title, groups, lookforwardMinutes, biasNote = '') {
  const lfs = lookforwardMinutes;
  const sortedKeys = [...groups.keys()].sort((a, b) => {
    // Sort by duration category for duration tables
    const order = ['short', 'medium', 'extended', 'prolonged'];
    const aIdx = order.findIndex(o => String(a).includes(o));
    const bIdx = order.findIndex(o => String(b).includes(o));
    if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;

    // Numeric sort if possible
    const numA = parseFloat(a), numB = parseFloat(b);
    if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
    return String(a).localeCompare(String(b));
  });

  console.log(`\n  ┌─ ${title} ${biasNote ? '(' + biasNote + ')' : ''}`);

  // Header
  let hdr = `  │ ${'Group'.padEnd(36)}│ ${'N'.padEnd(6)}│`;
  for (const lf of lfs) hdr += ` ${(lf + 'min').padEnd(11)}│`;
  console.log(hdr);

  const divider = '  ├' + '─'.repeat(38) + '┼' + '─'.repeat(7) + '┼' + lfs.map(() => '─'.repeat(12) + '┼').join('');
  console.log(divider);

  for (const key of sortedKeys) {
    const g = groups.get(key);
    let row = `  │ ${String(key).padEnd(36)}│ ${g.total.toString().padEnd(6)}│`;

    for (const lf of lfs) {
      const k = `${lf}m`;
      const data = g[k];
      if (!data || (data.up + data.down) === 0) {
        row += ` ${'  ---     '.padEnd(11)}│`;
        continue;
      }

      const total = data.up + data.down;
      const upPct = data.up / total;
      const winPct = Math.max(upPct, 1 - upPct);
      const dir = data.up > data.down ? 'UP' : 'DN';
      const pctStr = `${(winPct * 100).toFixed(1)}%${dir}`;

      // Statistical significance
      const pValue = binomialTest(Math.max(data.up, data.down), total, 0.5);
      const sig = pValue < 0.05 ? '*' : pValue < 0.10 ? '~' : ' ';

      // Color: green >= 55%, yellow 50-55%, red < 50%
      let color;
      if (winPct >= 0.60) color = '\x1b[32m';
      else if (winPct >= 0.55) color = '\x1b[92m'; // bright green
      else if (winPct >= 0.50) color = '\x1b[33m';
      else color = '\x1b[31m';
      const reset = '\x1b[0m';

      row += ` ${color}${pctStr}${sig}${reset}`.padEnd(11 + 9) + '│';
    }

    console.log(row);
  }

  console.log('  └' + '─'.repeat(divider.length - 4));
  console.log('  Note: * p<0.05, ~ p<0.10 (vs 50% baseline)');
}

// ============================================================
// STRATEGY SIMULATION
// ============================================================

function simulateStrategy(flips, pointsPerTick = 0.25, tickValue = 5) {
  const results = {
    bullishToUp: { trades: [], totalPnL: 0, wins: 0, losses: 0 },
    bearishToDown: { trades: [], totalPnL: 0, wins: 0, losses: 0 },
    combined: { trades: [], totalPnL: 0, wins: 0, losses: 0 },
  };

  const lookforwardMinutes = [15, 30, 60];

  for (const flip of flips) {
    // Strategy: Go LONG on BEARISH_TO_BULLISH, SHORT on BULLISH_TO_BEARISH
    const isBullishFlip = flip.flipType === 'BEARISH_TO_BULLISH';

    for (const lf of lookforwardMinutes) {
      const lfData = flip.lookforwards[lf];
      if (!lfData) continue;

      // For bullish flip: we expect UP, so profit = priceChange
      // For bearish flip: we expect DOWN, so profit = -priceChange
      const expectedDir = isBullishFlip ? 'UP' : 'DOWN';
      const profit = isBullishFlip ? lfData.priceChange : -lfData.priceChange;

      const trade = {
        timestamp: flip.timestamp,
        flipType: flip.flipType,
        durationPrints: flip.durationPrints,
        entryPrice: flip.entryPrice,
        exitPrice: lfData.exitPrice,
        lookforward: lf,
        profit,
        isWin: profit > 0,
      };

      // Add to appropriate bucket
      const bucket = isBullishFlip ? results.bullishToUp : results.bearishToDown;
      bucket.trades.push(trade);
      bucket.totalPnL += profit;
      if (profit > 0) bucket.wins++;
      else bucket.losses++;

      results.combined.trades.push(trade);
      results.combined.totalPnL += profit;
      if (profit > 0) results.combined.wins++;
      else results.combined.losses++;
    }
  }

  return results;
}

// ============================================================
// MAIN ANALYSIS
// ============================================================

async function main() {
  const config = parseArgs();

  console.log('═'.repeat(80));
  console.log('  LT SENTIMENT FLIP ANALYSIS');
  console.log('  Do sentiment flips predict future price direction?');
  console.log('  Focus: Flips after prolonged same-sentiment periods');
  console.log('═'.repeat(80) + '\n');

  console.log(`  Configuration:`);
  console.log(`    Start Date: ${config.startDate.toISOString().split('T')[0]}`);
  console.log(`    End Date: ${config.endDate.toISOString().split('T')[0]}`);
  console.log(`    Min Duration Filter: ${config.minDuration} prints`);
  console.log(`    Session Filter: ${config.session}\n`);

  // Load data
  const ltRecords = loadLTLevels(config.startDate, config.endDate);
  const candles = loadNQCandles(config.startDate, config.endDate);

  // Detect flips
  console.log('\n🔄 Detecting sentiment flips...');
  const allFlips = detectFlips(ltRecords);
  console.log(`   Total flips detected: ${allFlips.length}`);

  // Enrich flips with price data and lookforwards
  console.log('\n📐 Enriching flips with price data and lookforward returns...');
  const lookforwardMinutes = [5, 15, 30, 60, 240];
  const enrichedFlips = [];

  for (const flip of allFlips) {
    // Get entry price at flip time
    // IMPORTANT: Use the candle that closes AT or just BEFORE the flip timestamp
    // because the LT data at timestamp T reflects conditions as of that time,
    // and we want to measure returns FROM that point forward
    const entryCandle = findCandleBeforeTime(candles, flip.timestamp);
    if (!entryCandle) continue;

    // Skip if entry candle is more than 5 minutes before flip (data gap)
    if (flip.timestamp - entryCandle.timestamp > 5 * 60 * 1000) continue;

    // Calculate lookforward returns
    const lookforwards = calculateLookforwards(candles, entryCandle.timestamp, entryCandle.close);

    // Skip if missing critical lookforward data
    if (!lookforwards[15]) continue;

    // Get session
    const session = getSession(flip.timestamp);

    // Apply filters
    if (config.minDuration > 0 && flip.durationPrints < config.minDuration) continue;
    if (config.session !== 'all' && session !== config.session) continue;

    enrichedFlips.push({
      ...flip,
      entryPrice: entryCandle.close,
      session,
      durationBucket: getDurationBucket(flip.durationPrints),
      lookforwards,
    });
  }

  console.log(`   Enriched flips with valid data: ${enrichedFlips.length}`);

  // Count by flip type
  const flipTypeCounts = new Map();
  for (const flip of enrichedFlips) {
    flipTypeCounts.set(flip.flipType, (flipTypeCounts.get(flip.flipType) || 0) + 1);
  }
  console.log(`   Flip type breakdown:`);
  for (const [type, count] of flipTypeCounts) {
    console.log(`     ${type}: ${count}`);
  }

  // Count by duration bucket
  const durationCounts = new Map();
  for (const flip of enrichedFlips) {
    durationCounts.set(flip.durationBucket, (durationCounts.get(flip.durationBucket) || 0) + 1);
  }
  console.log(`   Duration bucket breakdown:`);
  for (const [bucket, count] of [...durationCounts.entries()].sort()) {
    console.log(`     ${bucket}: ${count}`);
  }

  // ============================================================
  // CROSS-TABULATION TABLES
  // ============================================================

  console.log('\n' + '═'.repeat(80));
  console.log('  CROSS-TABULATION RESULTS');
  console.log('═'.repeat(80));

  // TABLE 1: Flip Type vs Direction
  console.log('\n' + '─'.repeat(80));
  console.log('  TABLE 1: Flip Type vs Future Direction');
  console.log('  Hypothesis: BEARISH→BULLISH predicts UP, BULLISH→BEARISH predicts DOWN');
  console.log('─'.repeat(80));

  const table1 = buildCrossTab(enrichedFlips, e => e.flipType, lookforwardMinutes);
  printTable('Flip Type → Direction', table1, lookforwardMinutes);

  // TABLE 2: Duration Bucket vs Win Rate (ALL FLIPS)
  console.log('\n' + '─'.repeat(80));
  console.log('  TABLE 2: Duration Before Flip vs Direction');
  console.log('  KEY QUESTION: Do prolonged flips predict better?');
  console.log('─'.repeat(80));

  const table2 = buildCrossTab(enrichedFlips, e => e.durationBucket, lookforwardMinutes);
  printTable('Duration Bucket → Direction', table2, lookforwardMinutes);

  // TABLE 3: Duration × Flip Type (Interaction)
  console.log('\n' + '─'.repeat(80));
  console.log('  TABLE 3: Duration × Flip Type (Interaction)');
  console.log('  Does duration matter more for one flip type?');
  console.log('─'.repeat(80));

  const table3 = buildCrossTab(enrichedFlips, e => {
    const shortDur = e.durationPrints < 10 ? 'short (<10)' : 'long (10+)';
    return `${shortDur} | ${e.flipType}`;
  }, lookforwardMinutes);
  printTable('Duration × Flip Type → Direction', table3, lookforwardMinutes);

  // TABLE 4: Session Breakdown
  console.log('\n' + '─'.repeat(80));
  console.log('  TABLE 4: Session vs Direction');
  console.log('─'.repeat(80));

  const table4 = buildCrossTab(enrichedFlips, e => e.session, lookforwardMinutes);
  printTable('Session → Direction', table4, lookforwardMinutes);

  // TABLE 5: Directional Accuracy (Expected Direction)
  // For BEARISH_TO_BULLISH, "correct" = UP
  // For BULLISH_TO_BEARISH, "correct" = DOWN
  console.log('\n' + '─'.repeat(80));
  console.log('  TABLE 5: Flip Type → Expected Direction Accuracy');
  console.log('  Does the flip predict the EXPECTED direction?');
  console.log('─'.repeat(80));

  const table5Groups = new Map();
  for (const flip of enrichedFlips) {
    const key = flip.flipType;
    if (!table5Groups.has(key)) table5Groups.set(key, { total: 0 });
    const group = table5Groups.get(key);
    group.total++;

    const expectedDir = flip.flipType === 'BEARISH_TO_BULLISH' ? 'UP' : 'DOWN';

    for (const lf of lookforwardMinutes) {
      const lfData = flip.lookforwards[lf];
      if (!lfData) continue;

      const k = `${lf}m`;
      if (!group[k]) group[k] = { correct: 0, incorrect: 0 };

      if (lfData.direction === expectedDir) group[k].correct++;
      else group[k].incorrect++;
    }
  }

  // Print TABLE 5 manually with correct/incorrect instead of up/down
  console.log(`\n  ┌─ Flip Type → Expected Direction Accuracy`);
  let hdr5 = `  │ ${'Flip Type'.padEnd(36)}│ ${'N'.padEnd(6)}│`;
  for (const lf of lookforwardMinutes) hdr5 += ` ${(lf + 'min').padEnd(11)}│`;
  console.log(hdr5);
  console.log('  ├' + '─'.repeat(38) + '┼' + '─'.repeat(7) + '┼' + lookforwardMinutes.map(() => '─'.repeat(12) + '┼').join(''));

  for (const [key, g] of table5Groups) {
    let row = `  │ ${String(key).padEnd(36)}│ ${g.total.toString().padEnd(6)}│`;

    for (const lf of lookforwardMinutes) {
      const k = `${lf}m`;
      const data = g[k];
      if (!data || (data.correct + data.incorrect) === 0) {
        row += ` ${'  ---     '.padEnd(11)}│`;
        continue;
      }

      const total = data.correct + data.incorrect;
      const accuracy = data.correct / total;
      const pctStr = `${(accuracy * 100).toFixed(1)}%`;

      const pValue = binomialTest(data.correct, total, 0.5);
      const sig = pValue < 0.05 ? '*' : pValue < 0.10 ? '~' : ' ';

      let color;
      if (accuracy >= 0.60) color = '\x1b[32m';
      else if (accuracy >= 0.55) color = '\x1b[92m';
      else if (accuracy >= 0.50) color = '\x1b[33m';
      else color = '\x1b[31m';
      const reset = '\x1b[0m';

      row += ` ${color}${pctStr}${sig}${reset}`.padEnd(11 + 9) + '│';
    }

    console.log(row);
  }
  console.log('  └' + '─'.repeat(100));
  console.log('  Note: * p<0.05, ~ p<0.10 (vs 50% baseline)');

  // TABLE 6: Prolonged Flips Only (20+ prints)
  console.log('\n' + '─'.repeat(80));
  console.log('  TABLE 6: PROLONGED FLIPS ONLY (20+ prints = 5+ hours)');
  console.log('  This is the primary analysis of interest');
  console.log('─'.repeat(80));

  const prolongedFlips = enrichedFlips.filter(f => f.durationPrints >= 20);
  console.log(`   Prolonged flips: ${prolongedFlips.length}`);

  if (prolongedFlips.length > 0) {
    const table6 = buildCrossTab(prolongedFlips, e => e.flipType, lookforwardMinutes);
    printTable('Prolonged Flip Type → Direction', table6, lookforwardMinutes);

    // Directional accuracy for prolonged flips
    const table6b = new Map();
    for (const flip of prolongedFlips) {
      const key = flip.flipType;
      if (!table6b.has(key)) table6b.set(key, { total: 0 });
      const group = table6b.get(key);
      group.total++;

      const expectedDir = flip.flipType === 'BEARISH_TO_BULLISH' ? 'UP' : 'DOWN';

      for (const lf of lookforwardMinutes) {
        const lfData = flip.lookforwards[lf];
        if (!lfData) continue;

        const k = `${lf}m`;
        if (!group[k]) group[k] = { correct: 0, incorrect: 0 };

        if (lfData.direction === expectedDir) group[k].correct++;
        else group[k].incorrect++;
      }
    }

    console.log(`\n  ┌─ Prolonged Flip → Expected Direction Accuracy`);
    let hdr6 = `  │ ${'Flip Type'.padEnd(36)}│ ${'N'.padEnd(6)}│`;
    for (const lf of lookforwardMinutes) hdr6 += ` ${(lf + 'min').padEnd(11)}│`;
    console.log(hdr6);
    console.log('  ├' + '─'.repeat(38) + '┼' + '─'.repeat(7) + '┼' + lookforwardMinutes.map(() => '─'.repeat(12) + '┼').join(''));

    for (const [key, g] of table6b) {
      let row = `  │ ${String(key).padEnd(36)}│ ${g.total.toString().padEnd(6)}│`;

      for (const lf of lookforwardMinutes) {
        const k = `${lf}m`;
        const data = g[k];
        if (!data || (data.correct + data.incorrect) === 0) {
          row += ` ${'  ---     '.padEnd(11)}│`;
          continue;
        }

        const total = data.correct + data.incorrect;
        const accuracy = data.correct / total;
        const pctStr = `${(accuracy * 100).toFixed(1)}%`;

        const pValue = binomialTest(data.correct, total, 0.5);
        const sig = pValue < 0.05 ? '*' : pValue < 0.10 ? '~' : ' ';

        let color;
        if (accuracy >= 0.60) color = '\x1b[32m';
        else if (accuracy >= 0.55) color = '\x1b[92m';
        else if (accuracy >= 0.50) color = '\x1b[33m';
        else color = '\x1b[31m';
        const reset = '\x1b[0m';

        row += ` ${color}${pctStr}${sig}${reset}`.padEnd(11 + 9) + '│';
      }

      console.log(row);
    }
    console.log('  └' + '─'.repeat(100));
  } else {
    console.log('   No prolonged flips found in the dataset.');
  }

  // ============================================================
  // STRATEGY SIMULATION
  // ============================================================

  console.log('\n' + '═'.repeat(80));
  console.log('  STRATEGY SIMULATION');
  console.log('  Long on BEARISH→BULLISH, Short on BULLISH→BEARISH');
  console.log('═'.repeat(80));

  // Simulate on all flips
  const strategyResults = simulateStrategy(enrichedFlips);

  console.log('\n  All Flips (Combined Strategy):');
  const combined = strategyResults.combined;
  const totalTrades = combined.wins + combined.losses;
  if (totalTrades > 0) {
    const winRate = combined.wins / totalTrades;
    console.log(`    Trades: ${totalTrades}`);
    console.log(`    Wins: ${combined.wins} (${(winRate * 100).toFixed(1)}%)`);
    console.log(`    Total P&L: ${combined.totalPnL.toFixed(2)} points`);
    console.log(`    Avg P&L per trade: ${(combined.totalPnL / totalTrades).toFixed(2)} points`);
  }

  // Simulate on prolonged flips only
  if (prolongedFlips.length > 0) {
    const prolongedStrategy = simulateStrategy(prolongedFlips);
    const prolongedCombined = prolongedStrategy.combined;
    const prolongedTrades = prolongedCombined.wins + prolongedCombined.losses;

    console.log('\n  Prolonged Flips Only (20+ prints):');
    if (prolongedTrades > 0) {
      const winRate = prolongedCombined.wins / prolongedTrades;
      console.log(`    Trades: ${prolongedTrades}`);
      console.log(`    Wins: ${prolongedCombined.wins} (${(winRate * 100).toFixed(1)}%)`);
      console.log(`    Total P&L: ${prolongedCombined.totalPnL.toFixed(2)} points`);
      console.log(`    Avg P&L per trade: ${(prolongedCombined.totalPnL / prolongedTrades).toFixed(2)} points`);
    }
  }

  // ============================================================
  // STATISTICAL TESTS
  // ============================================================

  console.log('\n' + '═'.repeat(80));
  console.log('  STATISTICAL TESTS');
  console.log('═'.repeat(80));

  // T-test: Compare returns between duration buckets
  console.log('\n  T-Test: Short Duration vs Prolonged Duration Returns (15min lookforward)');

  const shortReturns = enrichedFlips
    .filter(f => f.durationPrints <= 4 && f.lookforwards[15])
    .map(f => f.lookforwards[15].priceChange);

  const prolongedReturns = enrichedFlips
    .filter(f => f.durationPrints >= 20 && f.lookforwards[15])
    .map(f => f.lookforwards[15].priceChange);

  if (shortReturns.length > 1 && prolongedReturns.length > 1) {
    const tResult = tTest(prolongedReturns, shortReturns);
    console.log(`    Short duration (n=${shortReturns.length}): mean = ${tResult.mean2?.toFixed(2) || 'N/A'}`);
    console.log(`    Prolonged duration (n=${prolongedReturns.length}): mean = ${tResult.mean1?.toFixed(2) || 'N/A'}`);
    console.log(`    t-statistic: ${tResult.tStat.toFixed(3)}`);
    console.log(`    p-value: ${tResult.pValue.toFixed(4)}`);
    console.log(`    ${tResult.pValue < 0.05 ? '✅ Significant difference' : '❌ No significant difference'}`);
  } else {
    console.log('    Insufficient data for t-test');
  }

  // ============================================================
  // LOOKBACK ANALYSIS - Check for look-ahead bias
  // ============================================================

  console.log('\n' + '═'.repeat(80));
  console.log('  LOOKBACK ANALYSIS: Is sentiment a LAGGING indicator?');
  console.log('  Checking if price has ALREADY moved in expected direction before flip');
  console.log('═'.repeat(80));

  // For each flip, check the price 15 minutes BEFORE the flip
  const lookbackMinutes = [15, 30, 60];
  const lookbackResults = {
    BEARISH_TO_BULLISH: {},
    BULLISH_TO_BEARISH: {},
  };

  for (const lm of lookbackMinutes) {
    lookbackResults.BEARISH_TO_BULLISH[lm] = { alreadyUp: 0, alreadyDown: 0 };
    lookbackResults.BULLISH_TO_BEARISH[lm] = { alreadyUp: 0, alreadyDown: 0 };
  }

  for (const flip of enrichedFlips) {
    for (const lm of lookbackMinutes) {
      const priorTime = flip.timestamp - lm * 60 * 1000;
      const priorCandle = findCandleBeforeTime(candles, priorTime);

      if (!priorCandle) continue;

      const priceChange = flip.entryPrice - priorCandle.close;
      const alreadyUp = priceChange > 0;

      if (flip.flipType === 'BEARISH_TO_BULLISH') {
        if (alreadyUp) lookbackResults.BEARISH_TO_BULLISH[lm].alreadyUp++;
        else lookbackResults.BEARISH_TO_BULLISH[lm].alreadyDown++;
      } else {
        if (alreadyUp) lookbackResults.BULLISH_TO_BEARISH[lm].alreadyUp++;
        else lookbackResults.BULLISH_TO_BEARISH[lm].alreadyDown++;
      }
    }
  }

  console.log('\n  If sentiment is lagging, BEARISH→BULLISH flips should have price ALREADY UP');
  console.log('  and BULLISH→BEARISH flips should have price ALREADY DOWN.\n');

  console.log('  ┌─ Price Change in PRIOR Window (before flip)');
  console.log(`  │ ${'Flip Type'.padEnd(24)}│ ${'Window'.padEnd(10)}│ ${'Already Expected'.padEnd(18)}│`);
  console.log('  ├' + '─'.repeat(26) + '┼' + '─'.repeat(11) + '┼' + '─'.repeat(19) + '┼');

  for (const flipType of ['BEARISH_TO_BULLISH', 'BULLISH_TO_BEARISH']) {
    for (const lm of lookbackMinutes) {
      const data = lookbackResults[flipType][lm];
      const total = data.alreadyUp + data.alreadyDown;
      if (total === 0) continue;

      // For BEARISH→BULLISH, we expect UP (alreadyUp is "correct")
      // For BULLISH→BEARISH, we expect DOWN (alreadyDown is "correct")
      const expected = flipType === 'BEARISH_TO_BULLISH' ? data.alreadyUp : data.alreadyDown;
      const pct = (expected / total * 100).toFixed(1);

      let color;
      if (parseFloat(pct) >= 60) color = '\x1b[32m';
      else if (parseFloat(pct) >= 55) color = '\x1b[92m';
      else if (parseFloat(pct) >= 50) color = '\x1b[33m';
      else color = '\x1b[31m';
      const reset = '\x1b[0m';

      console.log(`  │ ${flipType.padEnd(24)}│ ${(lm + 'min ago').padEnd(10)}│ ${color}${pct}%${reset}`.padEnd(50) + `│`);
    }
  }
  console.log('  └' + '─'.repeat(57));

  // Key interpretation
  const b2b15 = lookbackResults.BEARISH_TO_BULLISH[15];
  const b2b15pct = b2b15.alreadyUp / (b2b15.alreadyUp + b2b15.alreadyDown) * 100;

  if (b2b15pct > 70) {
    console.log('\n  ⚠️  WARNING: High lookback correlation suggests SENTIMENT IS LAGGING!');
    console.log('     The indicator reflects what already happened, not predictions.');
    console.log('     Forward-looking results may be inflated due to momentum continuation.');
  } else if (b2b15pct > 55) {
    console.log('\n  ⚠️  CAUTION: Moderate lookback correlation suggests some lag in sentiment.');
  } else {
    console.log('\n  ✅ Sentiment appears to be a leading or coincident indicator.');
  }

  // Additional diagnostic: average price change magnitude
  console.log('\n  Average Price Change Magnitude by Lookforward:');
  const magnitudes = {};
  for (const lf of lookforwardMinutes) {
    magnitudes[lf] = { up: [], down: [] };
  }

  for (const flip of enrichedFlips) {
    for (const lf of lookforwardMinutes) {
      const lfData = flip.lookforwards[lf];
      if (!lfData) continue;

      if (lfData.direction === 'UP') {
        magnitudes[lf].up.push(lfData.priceChange);
      } else {
        magnitudes[lf].down.push(lfData.priceChange);
      }
    }
  }

  console.log(`  │ ${'LF'.padEnd(8)}│ ${'Avg UP'.padEnd(12)}│ ${'Avg DOWN'.padEnd(12)}│ ${'UP Count'.padEnd(10)}│ ${'DOWN Count'.padEnd(10)}│`);
  for (const lf of lookforwardMinutes) {
    const avgUp = magnitudes[lf].up.length > 0
      ? (magnitudes[lf].up.reduce((a, b) => a + b, 0) / magnitudes[lf].up.length).toFixed(2)
      : 'N/A';
    const avgDown = magnitudes[lf].down.length > 0
      ? (magnitudes[lf].down.reduce((a, b) => a + b, 0) / magnitudes[lf].down.length).toFixed(2)
      : 'N/A';
    console.log(`  │ ${(lf + 'min').padEnd(8)}│ ${('+' + avgUp).padEnd(12)}│ ${avgDown.padEnd(12)}│ ${magnitudes[lf].up.length.toString().padEnd(10)}│ ${magnitudes[lf].down.length.toString().padEnd(10)}│`);
  }

  // ============================================================
  // SUMMARY
  // ============================================================

  console.log('\n' + '═'.repeat(80));
  console.log('  SUMMARY: KEY FINDINGS');
  console.log('═'.repeat(80));

  // Find best signal across all tables
  const allSignals = [];

  // From table5 (directional accuracy)
  for (const [key, g] of table5Groups) {
    for (const lf of lookforwardMinutes) {
      const k = `${lf}m`;
      const data = g[k];
      if (!data) continue;

      const total = data.correct + data.incorrect;
      if (total < 10) continue;

      const accuracy = data.correct / total;
      const pValue = binomialTest(data.correct, total, 0.5);

      allSignals.push({
        table: 'Flip Type Accuracy',
        group: key,
        lookforward: lf,
        accuracy,
        pValue,
        sampleSize: total,
      });
    }
  }

  // Sort by accuracy
  allSignals.sort((a, b) => b.accuracy - a.accuracy);

  console.log('\n  Top signals (min 10 samples):');
  console.log('  ' + '─'.repeat(70));
  console.log(`  ${'Table'.padEnd(22)}${'Group'.padEnd(24)}${'LF'.padEnd(6)}${'Acc'.padEnd(10)}${'p-val'.padEnd(10)}${'N'.padEnd(6)}`);
  console.log('  ' + '─'.repeat(70));

  for (const s of allSignals.slice(0, 10)) {
    const accStr = `${(s.accuracy * 100).toFixed(1)}%`;
    const pStr = s.pValue < 0.001 ? '<0.001' : s.pValue.toFixed(3);

    let color;
    if (s.accuracy >= 0.55 && s.pValue < 0.05) color = '\x1b[32m';
    else if (s.accuracy >= 0.55) color = '\x1b[33m';
    else color = '\x1b[0m';
    const reset = '\x1b[0m';

    console.log(`  ${s.table.padEnd(22)}${s.group.padEnd(24)}${(s.lookforward + 'm').padEnd(6)}${color}${accStr}${reset}`.padEnd(58) + `${pStr.padEnd(10)}${s.sampleSize}`);
  }
  console.log('  ' + '─'.repeat(70));

  // Verdict
  const bestSignal = allSignals[0];
  if (bestSignal && bestSignal.accuracy >= 0.55 && bestSignal.pValue < 0.05) {
    console.log(`\n  ✅ SIGNIFICANT SIGNAL FOUND: ${bestSignal.group}`);
    console.log(`     ${(bestSignal.accuracy * 100).toFixed(1)}% accuracy at ${bestSignal.lookforward}min (n=${bestSignal.sampleSize}, p=${bestSignal.pValue.toFixed(3)})`);
  } else if (bestSignal && bestSignal.accuracy >= 0.55) {
    console.log(`\n  ⚠️  WEAK SIGNAL: ${bestSignal.group}`);
    console.log(`     ${(bestSignal.accuracy * 100).toFixed(1)}% accuracy but p=${bestSignal.pValue.toFixed(3)} (not significant)`);
  } else {
    console.log(`\n  ❌ NO ACTIONABLE SIGNAL FOUND`);
    console.log('     Sentiment flips do not reliably predict future direction');
  }

  // ============================================================
  // OUTPUT FILES
  // ============================================================

  const outputDir = path.join(dataDir, 'results');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  // JSON output
  const jsonPath = config.outputJson || path.join(outputDir, 'lt-sentiment-flip-analysis.json');
  const jsonData = {
    metadata: {
      generatedAt: new Date().toISOString(),
      startDate: config.startDate.toISOString(),
      endDate: config.endDate.toISOString(),
      minDurationFilter: config.minDuration,
      sessionFilter: config.session,
      totalFlips: enrichedFlips.length,
      prolongedFlips: prolongedFlips.length,
    },
    topSignals: allSignals.slice(0, 20),
    flipTypeCounts: Object.fromEntries(flipTypeCounts),
    durationCounts: Object.fromEntries(durationCounts),
    flips: enrichedFlips.map(f => ({
      timestamp: f.timestamp,
      datetime: f.datetime,
      flipType: f.flipType,
      durationPrints: f.durationPrints,
      durationMinutes: f.durationMinutes,
      durationBucket: f.durationBucket,
      session: f.session,
      entryPrice: f.entryPrice,
      lookforwards: f.lookforwards,
    })),
  };

  fs.writeFileSync(jsonPath, JSON.stringify(jsonData, null, 2));
  console.log(`\n  💾 JSON output saved to: ${path.relative(process.cwd(), jsonPath)}`);

  // CSV output
  const csvPath = config.outputCsv || path.join(outputDir, 'lt-sentiment-flips.csv');
  const csvHeader = [
    'datetime', 'timestamp', 'flip_type', 'from_sentiment', 'to_sentiment',
    'duration_prints', 'duration_minutes', 'duration_bucket', 'session',
    'entry_price',
    '5m_direction', '5m_change', '5m_exit',
    '15m_direction', '15m_change', '15m_exit',
    '30m_direction', '30m_change', '30m_exit',
    '60m_direction', '60m_change', '60m_exit',
    '240m_direction', '240m_change', '240m_exit',
  ].join(',');

  const csvRows = enrichedFlips.map(f => {
    const row = [
      f.datetime,
      f.timestamp,
      f.flipType,
      f.fromSentiment,
      f.toSentiment,
      f.durationPrints,
      f.durationMinutes,
      `"${f.durationBucket}"`,
      f.session,
      f.entryPrice.toFixed(2),
    ];

    for (const lf of [5, 15, 30, 60, 240]) {
      const lfData = f.lookforwards[lf];
      if (lfData) {
        row.push(lfData.direction, lfData.priceChange.toFixed(2), lfData.exitPrice.toFixed(2));
      } else {
        row.push('', '', '');
      }
    }

    return row.join(',');
  });

  fs.writeFileSync(csvPath, csvHeader + '\n' + csvRows.join('\n'));
  console.log(`  💾 CSV output saved to: ${path.relative(process.cwd(), csvPath)}`);

  console.log('');
}

main().catch(err => {
  console.error('Error:', err.message);
  console.error(err.stack);
  process.exit(1);
});
