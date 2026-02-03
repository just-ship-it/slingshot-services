/**
 * LT Level Dynamics Correlation with CBBO Spread Widening
 *
 * Determines whether structural dynamics of LT price levels (proximity to spot,
 * migration direction, ordering, spacing) predict post-volatility-event NQ direction.
 *
 * Ignores LT sentiment column entirely — only uses the 5 price levels.
 * Test period: Jan 13–31, 2025
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataDir = path.join(__dirname, '..');

// ============================================================
// DATA LOADING
// ============================================================

function loadCBBOMetrics() {
  const file = path.join(dataDir, 'data', 'cbbo-1m', 'cbbo-metrics-1m.csv');
  const lines = fs.readFileSync(file, 'utf-8').trim().split('\n');

  const records = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i].split(',');
    records.push({
      timestamp: new Date(vals[0]).getTime(),
      avgSpread: parseFloat(vals[1]) || 0,
    });
  }

  records.sort((a, b) => a.timestamp - b.timestamp);
  console.log(`📊 Loaded ${records.length} CBBO minute records`);
  return records;
}

function loadLTLevels() {
  const file = path.join(dataDir, 'data', 'liquidity', 'nq', 'NQ_liquidity_levels.csv');
  const lines = fs.readFileSync(file, 'utf-8').trim().split('\n');

  const records = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i].split(',');
    // Columns: datetime, unix_timestamp, sentiment, level_1..level_5
    // Ignore sentiment (vals[2]) entirely per plan requirements
    const timestamp = parseInt(vals[1]);
    const levels = [
      parseFloat(vals[3]),
      parseFloat(vals[4]),
      parseFloat(vals[5]),
      parseFloat(vals[6]),
      parseFloat(vals[7]),
    ];

    // Skip rows with NaN levels
    if (levels.some(l => isNaN(l))) continue;

    records.push({ timestamp, levels });
  }

  records.sort((a, b) => a.timestamp - b.timestamp);
  console.log(`📊 Loaded ${records.length} LT level records (5 price levels each)`);
  return records;
}

function loadNQCandles() {
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

  // Filter to full year 2025
  const start = new Date('2025-01-02').getTime();
  const end = new Date('2026-01-01').getTime();
  const periodCandles = filtered.filter(c => c.timestamp >= start && c.timestamp < end);

  console.log(`📊 Loaded ${periodCandles.length} NQ candles (2025 primary contract)`);
  return periodCandles;
}

// ============================================================
// STEP 1: DETECT SPREAD WIDENING EVENTS
// ============================================================

function detectSpreadWidenings(cbboMetrics, lookbackMinutes = 30, threshold = 0.15) {
  const events = [];
  const lookbackMs = lookbackMinutes * 60 * 1000;

  for (let i = 0; i < cbboMetrics.length; i++) {
    const current = cbboMetrics[i];
    const lookbackTime = current.timestamp - lookbackMs;

    let pastMetric = null;
    for (let j = i - 1; j >= 0; j--) {
      if (cbboMetrics[j].timestamp <= lookbackTime) {
        pastMetric = cbboMetrics[j];
        break;
      }
    }

    if (!pastMetric || pastMetric.avgSpread === 0) continue;

    const percentChange = (current.avgSpread - pastMetric.avgSpread) / pastMetric.avgSpread;

    if (percentChange >= threshold) {
      events.push({
        timestamp: current.timestamp,
        currentSpread: current.avgSpread,
        pastSpread: pastMetric.avgSpread,
        percentChange,
      });
    }
  }

  return events;
}

// ============================================================
// STEP 2: COMPUTE LT METRICS FOR EACH EVENT
// ============================================================

function getLTSnapshot(ltLevels, timestamp) {
  // Binary search for most recent LT record at or before timestamp
  let lo = 0, hi = ltLevels.length - 1, best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ltLevels[mid].timestamp <= timestamp) {
      best = ltLevels[mid];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

function computeLTMetrics(ltLevels, eventTimestamp, price) {
  const current = getLTSnapshot(ltLevels, eventTimestamp);
  if (!current) return null;

  const levels = current.levels;

  // A. PROXIMITY
  const signedDistances = levels.map(l => l - price); // positive = level above price
  const aboveCount = signedDistances.filter(d => d > 0).length;
  const belowCount = signedDistances.filter(d => d <= 0).length;

  const absDistances = signedDistances.map(d => Math.abs(d));
  const nearestLevelDist = Math.min(...absDistances);
  const nearestLevelIdx = absDistances.indexOf(nearestLevelDist) + 1; // 1-based

  // Average inter-level spacing
  const sorted = [...levels].sort((a, b) => a - b);
  let totalSpacing = 0;
  for (let i = 1; i < sorted.length; i++) {
    totalSpacing += sorted[i] - sorted[i - 1];
  }
  const avgSpacing = totalSpacing / 4;

  const relativeProximity = avgSpacing > 0 ? nearestLevelDist / avgSpacing : 0;

  // Fixed-point proximity bucket
  let proximityBucket;
  if (nearestLevelDist < 10) proximityBucket = '<10pts';
  else if (nearestLevelDist < 25) proximityBucket = '10-25pts';
  else if (nearestLevelDist < 50) proximityBucket = '25-50pts';
  else proximityBucket = '>50pts';

  // B. CONFIGURATION
  let ordering;
  const isAsc = levels.every((l, i) => i === 0 || l >= levels[i - 1]);
  const isDesc = levels.every((l, i) => i === 0 || l <= levels[i - 1]);
  if (isAsc) ordering = 'ASCENDING';
  else if (isDesc) ordering = 'DESCENDING';
  else ordering = 'MIXED';

  // Spacing class
  let spacingClass;
  if (avgSpacing < 50) spacingClass = 'TIGHT';
  else if (avgSpacing < 150) spacingClass = 'MEDIUM';
  else spacingClass = 'WIDE';

  // Cluster count: levels within 25pts of each other near price
  let clusterCount = 0;
  for (let i = 0; i < levels.length; i++) {
    for (let j = i + 1; j < levels.length; j++) {
      if (Math.abs(levels[i] - levels[j]) <= 25) clusterCount++;
    }
  }

  // C. MIGRATION (compare to previous LT snapshot)
  const prevTs = current.timestamp - 15 * 60 * 1000; // 15-min prior
  const prev = getLTSnapshot(ltLevels, prevTs);

  let migration = null;
  if (prev && prev.timestamp < current.timestamp) {
    const deltas = levels.map((l, i) => l - prev.levels[i]);
    const netMigration = deltas.reduce((a, b) => a + b, 0);

    // Migration toward/away from price
    let towardCount = 0, awayCount = 0;
    for (let i = 0; i < levels.length; i++) {
      const prevDist = Math.abs(prev.levels[i] - price);
      const currDist = Math.abs(levels[i] - price);
      if (currDist < prevDist) towardCount++;
      else if (currDist > prevDist) awayCount++;
    }

    // Crossing detection: did any level cross price between snapshots?
    // Track which specific levels crossed (by index, 0-based)
    let crossedBelowPrice = 0; // was above, now below (bullish)
    let crossedAbovePrice = 0; // was below, now above (bearish)
    const levelsCrossedBelow = []; // indices of levels that crossed below price
    const levelsCrossedAbove = []; // indices of levels that crossed above price
    for (let i = 0; i < levels.length; i++) {
      const wasAbove = prev.levels[i] > price;
      const wasBelow = prev.levels[i] <= price;
      const isAbove = levels[i] > price;
      const isBelow = levels[i] <= price;

      if (wasAbove && isBelow) { crossedBelowPrice++; levelsCrossedBelow.push(i); }
      if (wasBelow && isAbove) { crossedAbovePrice++; levelsCrossedAbove.push(i); }
    }

    const hasCrossing = (crossedBelowPrice + crossedAbovePrice) > 0;

    migration = {
      netMigration,
      migratingToward: towardCount,
      migratingAway: awayCount,
      hasCrossing,
      crossedBelowPrice,
      crossedAbovePrice,
      levelsCrossedBelow,
      levelsCrossedAbove,
    };
  }

  return {
    timestamp: current.timestamp,
    levels,
    price,
    // Proximity
    aboveCount,
    belowCount,
    nearestLevelDist,
    nearestLevelIdx,
    avgSpacing,
    relativeProximity,
    proximityBucket,
    // Configuration
    ordering,
    spacingClass,
    clusterCount,
    // Migration
    migration,
  };
}

// ============================================================
// STEP 3: POST-EVENT PRICE DIRECTION
// ============================================================

function getCandleClose(candles, timestamp) {
  // Binary search for candle at or just after timestamp
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

function getPostEventDirections(candles, eventTimestamp, entryPrice) {
  const lookForwards = [5, 10, 15, 30, 60];
  const results = {};

  for (const lf of lookForwards) {
    const targetTime = eventTimestamp + lf * 60 * 1000;
    const exitCandle = getCandleClose(candles, targetTime);

    if (!exitCandle) continue;

    const change = exitCandle.close - entryPrice;
    results[lf] = {
      direction: change > 0 ? 'UP' : 'DOWN',
      magnitude: Math.abs(change),
    };
  }

  return results;
}

// ============================================================
// STEP 4: CROSS-TABULATION TABLES
// ============================================================

// Quintile assignment helper
function assignQuintiles(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const quintiles = new Map();

  for (let i = 0; i < values.length; i++) {
    // Find rank
    let rank = sorted.indexOf(values[i]);
    const q = Math.min(Math.floor(rank / (n / 5)), 4);
    quintiles.set(i, q);
  }

  return quintiles;
}

function buildCrossTab(events, groupFn, lookForwards) {
  // Group events by key, track direction at each lookforward
  const groups = new Map();

  for (const evt of events) {
    const key = groupFn(evt);
    if (key === null || key === undefined) continue;

    if (!groups.has(key)) groups.set(key, { total: 0 });
    const group = groups.get(key);
    group.total++;

    for (const lf of lookForwards) {
      if (!evt.directions[lf]) continue;
      const k = `${lf}m`;
      if (!group[k]) group[k] = { up: 0, down: 0 };
      if (evt.directions[lf].direction === 'UP') group[k].up++;
      else group[k].down++;
    }
  }

  return groups;
}

function formatTable(title, groups, lookForwards, expectedBias) {
  const lfs = lookForwards;
  const sortedKeys = [...groups.keys()].sort((a, b) => String(a).localeCompare(String(b)));

  // Header
  let header = `   ${'Group'.padEnd(22)}| ${'Count'.padEnd(7)}|`;
  for (const lf of lfs) header += ` ${(lf + 'm').padEnd(10)}|`;
  const sep = '   ' + '─'.repeat(header.length - 3);

  console.log(`\n   ${title}`);
  console.log(sep);
  console.log(header);
  console.log(sep);

  for (const key of sortedKeys) {
    const g = groups.get(key);
    let row = `   ${String(key).padEnd(22)}| ${g.total.toString().padEnd(7)}|`;

    for (const lf of lfs) {
      const k = `${lf}m`;
      const data = g[k];
      if (!data || (data.up + data.down) === 0) {
        row += ` ${'  --   '.padEnd(10)}|`;
        continue;
      }

      const total = data.up + data.down;
      // If expectedBias tells us what "accuracy" means for this group
      const accuracy = expectedBias
        ? expectedBias(key, data)
        : Math.max(data.up, data.down) / total;
      const pct = (accuracy * 100).toFixed(1);
      const dir = data.up > data.down ? 'UP' : 'DN';

      // Color coding
      let color = '';
      if (accuracy >= 0.55) color = '\x1b[32m'; // green
      else if (accuracy >= 0.50) color = '\x1b[33m'; // yellow
      else color = '\x1b[31m'; // red
      const reset = '\x1b[0m';

      row += ` ${color}${pct}%${dir}${reset}`.padEnd(10 + 10) + '|';
    }

    console.log(row);
  }

  console.log(sep);
}

function printTable(title, groups, lookForwards, biasNote) {
  const lfs = lookForwards;
  const sortedKeys = [...groups.keys()].sort((a, b) => {
    // Numeric sort if possible
    const numA = parseFloat(a), numB = parseFloat(b);
    if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
    return String(a).localeCompare(String(b));
  });

  console.log(`\n  ┌─ ${title} ${biasNote ? '(' + biasNote + ')' : ''}`);

  // Header
  let hdr = `  │ ${'Group'.padEnd(24)}│ ${'N'.padEnd(6)}│`;
  for (const lf of lfs) hdr += ` ${(lf + 'min').padEnd(9)}│`;
  console.log(hdr);

  const divider = '  ├' + '─'.repeat(26) + '┼' + '─'.repeat(7) + '┼' + lfs.map(() => '─'.repeat(10) + '┼').join('');
  console.log(divider);

  for (const key of sortedKeys) {
    const g = groups.get(key);
    let row = `  │ ${String(key).padEnd(24)}│ ${g.total.toString().padEnd(6)}│`;

    for (const lf of lfs) {
      const k = `${lf}m`;
      const data = g[k];
      if (!data || (data.up + data.down) === 0) {
        row += ` ${'  ---   '.padEnd(9)}│`;
        continue;
      }

      const total = data.up + data.down;
      const upPct = data.up / total;
      const dnPct = data.down / total;
      const winPct = Math.max(upPct, dnPct);
      const dir = data.up > data.down ? 'UP' : 'DN';
      const pctStr = `${(winPct * 100).toFixed(1)}%${dir}`;

      // Color: green >= 55%, yellow 50-55%, red < 50%
      let color;
      if (winPct >= 0.55) color = '\x1b[32m';
      else if (winPct >= 0.50) color = '\x1b[33m';
      else color = '\x1b[31m';
      const reset = '\x1b[0m';

      row += ` ${color}${pctStr}${reset}`.padEnd(9 + 9) + '│';
    }

    console.log(row);
  }

  console.log('  └' + '─'.repeat(divider.length - 4));
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log('═'.repeat(72));
  console.log('  LT LEVEL DYNAMICS vs CBBO SPREAD WIDENING');
  console.log('  Do LT level structures predict post-volatility-event direction?');
  console.log('  Test period: Full year 2025 (Jan 2 – Dec 31)');
  console.log('═'.repeat(72) + '\n');

  // Load data
  const cbbo = loadCBBOMetrics();
  const ltLevels = loadLTLevels();
  const candles = loadNQCandles();

  // Step 1: Detect spread widening events
  console.log('\n🔄 Step 1: Detecting spread widening events...');
  const widenings = detectSpreadWidenings(cbbo, 30, 0.15);
  console.log(`   Raw events: ${widenings.length}`);

  // Deduplicate to 1 event per 5-min window
  const deduped = [];
  let lastEventTime = -Infinity;
  for (const e of widenings) {
    if (e.timestamp - lastEventTime >= 5 * 60 * 1000) {
      deduped.push(e);
      lastEventTime = e.timestamp;
    }
  }
  console.log(`   After 5-min dedup: ${deduped.length} unique events`);

  // Filter to full year 2025
  const periodStart = new Date('2025-01-02').getTime();
  const periodEnd = new Date('2026-01-01').getTime();
  const periodEvents = deduped.filter(e => e.timestamp >= periodStart && e.timestamp < periodEnd);
  console.log(`   In 2025 window: ${periodEvents.length} events`);

  // Step 2: Compute LT metrics + Step 3: Get post-event directions
  console.log('\n📐 Step 2–3: Computing LT metrics and post-event directions...');

  const lookForwards = [5, 10, 15, 30, 60];
  const enrichedEvents = [];

  for (const event of periodEvents) {
    // Get NQ price at event time
    const entryCandle = getCandleClose(candles, event.timestamp);
    if (!entryCandle) continue;

    const price = entryCandle.close;

    // Compute LT metrics
    const ltMetrics = computeLTMetrics(ltLevels, event.timestamp, price);
    if (!ltMetrics) continue;

    // Get post-event directions
    const directions = getPostEventDirections(candles, event.timestamp, price);

    enrichedEvents.push({
      timestamp: event.timestamp,
      price,
      ...ltMetrics,
      directions,
    });
  }

  console.log(`   Enriched events with LT + price data: ${enrichedEvents.length}`);

  // Count events with migration data
  const withMigration = enrichedEvents.filter(e => e.migration !== null).length;
  console.log(`   Events with migration data: ${withMigration}`);

  // ============================================================
  // STEP 4: CROSS-TABULATION TABLES
  // ============================================================

  console.log('\n' + '═'.repeat(72));
  console.log('  CROSS-TABULATION RESULTS');
  console.log('═'.repeat(72));

  // TABLE 1: aboveCount (0,1,2,3,4,5) → direction
  // Bias: if aboveCount > belowCount → expect DOWN; else UP
  console.log('\n' + '─'.repeat(72));
  console.log('  TABLE 1: Levels Above vs Below Price');
  console.log('  Hypothesis: More levels above price → DOWN bias (resistance)');
  console.log('─'.repeat(72));

  const table1 = buildCrossTab(enrichedEvents, e => e.aboveCount, lookForwards);
  printTable('Above Count → Direction', table1, lookForwards, 'more above = bearish');

  // TABLE 2: Nearest level distance buckets
  console.log('\n' + '─'.repeat(72));
  console.log('  TABLE 2: Nearest Level Distance (Fixed Buckets)');
  console.log('─'.repeat(72));

  const table2 = buildCrossTab(enrichedEvents, e => e.proximityBucket, lookForwards);
  printTable('Proximity → Direction', table2, lookForwards);

  // TABLE 3: Relative proximity quintiles
  console.log('\n' + '─'.repeat(72));
  console.log('  TABLE 3: Relative Proximity Quintiles');
  console.log('─'.repeat(72));

  // Assign quintiles
  const relProxValues = enrichedEvents.map(e => e.relativeProximity);
  const sorted = [...relProxValues].sort((a, b) => a - b);
  const n = sorted.length;
  const quintileBounds = [
    sorted[Math.floor(n * 0.2)],
    sorted[Math.floor(n * 0.4)],
    sorted[Math.floor(n * 0.6)],
    sorted[Math.floor(n * 0.8)],
  ];

  const table3 = buildCrossTab(enrichedEvents, e => {
    if (e.relativeProximity < quintileBounds[0]) return 'Q1 (closest)';
    if (e.relativeProximity < quintileBounds[1]) return 'Q2';
    if (e.relativeProximity < quintileBounds[2]) return 'Q3';
    if (e.relativeProximity < quintileBounds[3]) return 'Q4';
    return 'Q5 (farthest)';
  }, lookForwards);
  printTable('Rel. Proximity Quintile → Dir', table3, lookForwards);

  // TABLE 4: Ordering
  console.log('\n' + '─'.repeat(72));
  console.log('  TABLE 4: Level Ordering (ASC/DESC/MIXED)');
  console.log('─'.repeat(72));

  const table4 = buildCrossTab(enrichedEvents, e => e.ordering, lookForwards);
  printTable('Ordering → Direction', table4, lookForwards);

  // TABLE 5: Spacing class
  console.log('\n' + '─'.repeat(72));
  console.log('  TABLE 5: Level Spacing Class');
  console.log('─'.repeat(72));

  const table5 = buildCrossTab(enrichedEvents, e => e.spacingClass, lookForwards);
  printTable('Spacing Class → Direction', table5, lookForwards);

  // TABLE 6: Crossing event × direction — THE KEY TABLE
  console.log('\n' + '─'.repeat(72));
  console.log('  TABLE 6: Level Crossing Events (KEY TABLE)');
  console.log('  Levels crossing below price = bullish migration');
  console.log('  Levels crossing above price = bearish migration');
  console.log('─'.repeat(72));

  const table6 = buildCrossTab(enrichedEvents, e => {
    if (!e.migration) return 'No migration data';
    if (!e.migration.hasCrossing) return 'No crossing';
    if (e.migration.crossedBelowPrice > 0 && e.migration.crossedAbovePrice > 0) return 'Crossed both directions';
    if (e.migration.crossedBelowPrice > 0) return 'Crossed below (bullish)';
    if (e.migration.crossedAbovePrice > 0) return 'Crossed above (bearish)';
    return 'No crossing';
  }, lookForwards);
  printTable('Crossing Event → Direction', table6, lookForwards);

  // TABLE 6B: Per-level crossing breakdown (bullish + bearish)
  // Each level is a Fibonacci lookback: L1=fib34, L2=fib55, L3=fib144, L4=fib377, L5=fib610
  console.log('\n' + '─'.repeat(72));
  console.log('  TABLE 6B: Per-Level Crossing Breakdown');
  console.log('  Which specific Fibonacci lookback level crossing drives the signal?');
  console.log('  Bullish = level crossed below price | Bearish = level crossed above price');
  console.log('─'.repeat(72));

  const fibLabels = ['L1 (fib34)', 'L2 (fib55)', 'L3 (fib144)', 'L4 (fib377)', 'L5 (fib610)'];

  // Build one row per level per direction
  const table6b = buildCrossTab(enrichedEvents, e => {
    if (!e.migration || !e.migration.hasCrossing) return null;
    // Return all crossing keys for this event (an event can have multiple)
    // We'll handle multi-level crossings by expanding below
    return '__multi__'; // placeholder, we expand manually
  }, lookForwards);

  // Manual expansion: for each event with crossings, emit one entry per crossed level
  const expandedEvents = [];
  for (const evt of enrichedEvents) {
    if (!evt.migration || !evt.migration.hasCrossing) continue;

    for (const idx of evt.migration.levelsCrossedBelow) {
      expandedEvents.push({ ...evt, _crossLabel: `${fibLabels[idx]} → bullish` });
    }
    for (const idx of evt.migration.levelsCrossedAbove) {
      expandedEvents.push({ ...evt, _crossLabel: `${fibLabels[idx]} → bearish` });
    }
  }

  const table6bReal = buildCrossTab(expandedEvents, e => e._crossLabel, lookForwards);
  printTable('Level Crossing → Direction', table6bReal, lookForwards);

  // TABLE 7: Net migration direction
  console.log('\n' + '─'.repeat(72));
  console.log('  TABLE 7: Net Migration Direction');
  console.log('─'.repeat(72));

  const table7 = buildCrossTab(enrichedEvents, e => {
    if (!e.migration) return 'No data';
    if (e.migration.netMigration > 0) return 'Net Up';
    if (e.migration.netMigration < 0) return 'Net Down';
    return 'Flat';
  }, lookForwards);
  printTable('Net Migration → Direction', table7, lookForwards);

  // TABLE 8: Combined crossing + proximity (interaction term)
  console.log('\n' + '─'.repeat(72));
  console.log('  TABLE 8: Crossing × Proximity (Interaction)');
  console.log('─'.repeat(72));

  const table8 = buildCrossTab(enrichedEvents, e => {
    if (!e.migration || !e.migration.hasCrossing) return 'No crossing';

    const crossDir = e.migration.crossedBelowPrice > 0
      ? (e.migration.crossedAbovePrice > 0 ? 'Both' : 'Below')
      : 'Above';

    return `${crossDir} + ${e.proximityBucket}`;
  }, lookForwards);
  printTable('Crossing + Proximity → Direction', table8, lookForwards);

  // ============================================================
  // STEP 5: SUMMARY + RAW DATA OUTPUT
  // ============================================================

  console.log('\n' + '═'.repeat(72));
  console.log('  SUMMARY: STRONGEST PREDICTIVE SIGNALS');
  console.log('═'.repeat(72));

  // Find strongest signal across all tables by scanning for highest accuracy at 15min
  const allTables = [
    { name: 'Above Count', groups: table1 },
    { name: 'Proximity Bucket', groups: table2 },
    { name: 'Rel. Proximity Quintile', groups: table3 },
    { name: 'Ordering', groups: table4 },
    { name: 'Spacing Class', groups: table5 },
    { name: 'Crossing Event', groups: table6 },
    { name: 'Per-Level Crossing', groups: table6bReal },
    { name: 'Net Migration', groups: table7 },
    { name: 'Crossing + Proximity', groups: table8 },
  ];

  const signals = [];

  for (const { name, groups } of allTables) {
    for (const [key, g] of groups) {
      for (const lf of lookForwards) {
        const k = `${lf}m`;
        const data = g[k];
        if (!data) continue;

        const total = data.up + data.down;
        if (total < 20) continue; // Minimum sample size

        const winPct = Math.max(data.up, data.down) / total;
        const dir = data.up > data.down ? 'UP' : 'DOWN';

        signals.push({
          table: name,
          group: String(key),
          lookforward: lf,
          accuracy: winPct,
          direction: dir,
          sampleSize: total,
        });
      }
    }
  }

  // Sort by accuracy descending
  signals.sort((a, b) => b.accuracy - a.accuracy);

  console.log('\n  Top 15 signals (min 20 samples):\n');
  console.log('  ' + '─'.repeat(70));
  console.log(`  ${'Table'.padEnd(22)}${'Group'.padEnd(22)}${'LF'.padEnd(6)}${'Acc'.padEnd(8)}${'Dir'.padEnd(6)}${'N'.padEnd(6)}`);
  console.log('  ' + '─'.repeat(70));

  const top15 = signals.slice(0, 15);
  for (const s of top15) {
    const accStr = `${(s.accuracy * 100).toFixed(1)}%`;
    let color;
    if (s.accuracy >= 0.55) color = '\x1b[32m';
    else if (s.accuracy >= 0.50) color = '\x1b[33m';
    else color = '\x1b[31m';
    const reset = '\x1b[0m';

    console.log(`  ${s.table.padEnd(22)}${s.group.padEnd(22)}${(s.lookforward + 'm').padEnd(6)}${color}${accStr}${reset}`.padEnd(58) + `${s.direction.padEnd(6)}${s.sampleSize}`);
  }
  console.log('  ' + '─'.repeat(70));

  // Verdict
  const bestSignal = signals[0];
  if (bestSignal && bestSignal.accuracy >= 0.55) {
    console.log(`\n  ✅ SIGNAL FOUND: ${bestSignal.table} → ${bestSignal.group}`);
    console.log(`     ${(bestSignal.accuracy * 100).toFixed(1)}% accuracy predicting ${bestSignal.direction} at ${bestSignal.lookforward}min (n=${bestSignal.sampleSize})`);
  } else {
    console.log(`\n  ❌ NO ACTIONABLE SIGNAL: Best accuracy = ${bestSignal ? (bestSignal.accuracy * 100).toFixed(1) + '%' : 'N/A'}`);
    console.log('     LT level dynamics do not break the continuation/reversal symmetry');
    console.log('     after CBBO spread widening events.');
  }

  // Save raw event data
  const outputDir = path.join(dataDir, 'results');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const outputPath = path.join(outputDir, 'lt-dynamics-analysis.json');
  const outputData = {
    metadata: {
      generatedAt: new Date().toISOString(),
      testPeriod: '2025-01-02 to 2025-12-31',
      totalEvents: enrichedEvents.length,
      eventsWithMigration: withMigration,
      lookForwards,
    },
    topSignals: top15,
    events: enrichedEvents.map(e => ({
      timestamp: e.timestamp,
      ts_iso: new Date(e.timestamp).toISOString(),
      price: e.price,
      aboveCount: e.aboveCount,
      belowCount: e.belowCount,
      nearestLevelDist: e.nearestLevelDist,
      nearestLevelIdx: e.nearestLevelIdx,
      avgSpacing: e.avgSpacing,
      relativeProximity: e.relativeProximity,
      proximityBucket: e.proximityBucket,
      ordering: e.ordering,
      spacingClass: e.spacingClass,
      clusterCount: e.clusterCount,
      migration: e.migration,
      directions: e.directions,
      levels: e.levels,
    })),
  };

  fs.writeFileSync(outputPath, JSON.stringify(outputData, null, 2));
  console.log(`\n  💾 Raw data saved to: results/lt-dynamics-analysis.json`);
  console.log('');
}

main().catch(err => {
  console.error('Error:', err.message);
  console.error(err.stack);
  process.exit(1);
});
