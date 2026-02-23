#!/usr/bin/env node
/**
 * ES Momentum Ignition Detection
 *
 * Detects momentum ignition: small probes followed by aggressive follow-through.
 *
 * Pattern:
 * 1. Probe phase: 2-3 minutes with small, directional trades (low volume, consistent direction)
 * 2. Ignition: Sudden volume spike (3x+) with large trades in same direction
 * 3. Cascade: Further volume spike with progressively worse prices (stop triggers)
 * 4. Reversal: Price reverses within 2-5 minutes
 *
 * Usage:
 *   node scripts/es-momentum-ignition.js [options]
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';

const args = process.argv.slice(2);
const getArg = (name, defaultValue) => {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 ? args[idx + 1] : defaultValue;
};

const startDateStr = getArg('start', '2025-01-01');
const endDateStr = getArg('end', '2026-01-31');
const outputPath = getArg('output', 'results/es-orderflow/momentum-ignition-results.json');

const startDate = new Date(startDateStr + 'T00:00:00Z');
const endDate = new Date(endDateStr + 'T23:59:59Z');
const dataDir = path.resolve(process.cwd(), 'data');

// Detection parameters
const PROBE_WINDOW = 3;               // Minutes for probe phase
const PROBE_MAX_VOLUME_RATIO = 1.2;   // Probe volume must be at or below average
const PROBE_MIN_IMBALANCE = 0.15;     // Minimum directional consistency during probe
const IGNITION_VOLUME_RATIO = 2.0;    // Volume spike threshold
const IGNITION_MIN_PRICE_MOVE = 1.0;  // Minimum ES points during ignition
const MIN_LARGE_TRADE_VOL = 10;       // Minimum large trade volume during ignition
const REVERSAL_WINDOW = 5;            // Minutes to check for reversal
const MIN_REVERSAL_RATIO = 0.3;       // Reversal must retrace at least 30% of the move
const FORWARD_WINDOWS = [5, 15, 30, 60];

console.log('='.repeat(80));
console.log('ES MOMENTUM IGNITION DETECTION');
console.log('='.repeat(80));
console.log(`Date range: ${startDateStr} to ${endDateStr}`);
console.log();

// ============================================================================
// Data Loading
// ============================================================================

function filterPrimaryContract(candles) {
  if (candles.length === 0) return candles;
  const contractVolumes = new Map();
  candles.forEach(candle => {
    const hourKey = Math.floor(candle.timestamp / 3600000);
    if (!contractVolumes.has(hourKey)) contractVolumes.set(hourKey, new Map());
    const hourData = contractVolumes.get(hourKey);
    hourData.set(candle.symbol, (hourData.get(candle.symbol) || 0) + (candle.volume || 0));
  });
  return candles.filter(candle => {
    const hourKey = Math.floor(candle.timestamp / 3600000);
    const hourData = contractVolumes.get(hourKey);
    if (!hourData) return true;
    let primarySymbol = '', maxVolume = 0;
    for (const [symbol, volume] of hourData) {
      if (volume > maxVolume) { maxVolume = volume; primarySymbol = symbol; }
    }
    return candle.symbol === primarySymbol;
  });
}

async function loadOHLCVData() {
  const filePath = path.join(dataDir, 'ohlcv/es/ES_ohlcv_1m.csv');
  console.log(`Loading OHLCV data...`);
  const candles = [];
  const rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });
  let headerSkipped = false;
  for await (const line of rl) {
    if (!headerSkipped) { headerSkipped = true; continue; }
    const parts = line.split(',');
    if (parts.length < 10) continue;
    const timestamp = new Date(parts[0]).getTime();
    if (timestamp < startDate.getTime() || timestamp > endDate.getTime()) continue;
    const symbol = parts[9]?.trim();
    if (symbol && symbol.includes('-')) continue;
    const open = parseFloat(parts[4]);
    const high = parseFloat(parts[5]);
    const low = parseFloat(parts[6]);
    const close = parseFloat(parts[7]);
    const volume = parseInt(parts[8]);
    if (open === high && high === low && low === close) continue;
    candles.push({ timestamp, open, high, low, close, volume, symbol });
  }
  candles.sort((a, b) => a.timestamp - b.timestamp);
  const filtered = filterPrimaryContract(candles);
  console.log(`  Loaded ${filtered.length} candles`);
  return filtered;
}

async function loadTradeOFI() {
  const filePath = path.join(dataDir, 'orderflow/es/trade-ofi-1m.csv');
  console.log(`Loading trade OFI...`);
  const data = new Map();
  const rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });
  let headerSkipped = false;
  for await (const line of rl) {
    if (!headerSkipped) { headerSkipped = true; continue; }
    const parts = line.split(',');
    if (parts.length < 17) continue;
    const timestamp = new Date(parts[0]).getTime();
    if (timestamp < startDate.getTime() || timestamp > endDate.getTime()) continue;
    data.set(timestamp, {
      buyVolume: parseInt(parts[1]),
      sellVolume: parseInt(parts[2]),
      netVolume: parseInt(parts[3]),
      totalVolume: parseInt(parts[4]),
      buyTrades: parseInt(parts[5]),
      sellTrades: parseInt(parts[6]),
      totalTrades: parseInt(parts[7]),
      volumeImbalance: parseFloat(parts[8]),
      avgTradeSize: parseFloat(parts[9]),
      maxTradeSize: parseInt(parts[10]),
      largeTradeBuyVol: parseInt(parts[11]),
      largeTradeSellVol: parseInt(parts[12])
    });
  }
  console.log(`  Loaded ${data.size} minute records`);
  return data;
}

async function loadGEXData() {
  const gexDir = path.join(dataDir, 'gex/es');
  const snapshots = new Map();
  if (!fs.existsSync(gexDir)) return snapshots;
  const files = fs.readdirSync(gexDir)
    .filter(f => f.startsWith('es_gex_') && f.endsWith('.json'))
    .filter(f => {
      const m = f.match(/es_gex_(\d{4}-\d{2}-\d{2})\.json/);
      if (!m) return false;
      const d = new Date(m[1]);
      return d >= startDate && d <= endDate;
    });
  console.log(`Loading GEX data from ${files.length} files...`);
  for (const file of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(gexDir, file), 'utf8'));
      for (const snap of raw.data) snapshots.set(new Date(snap.timestamp).getTime(), snap);
    } catch (e) { /* skip */ }
  }
  console.log(`  Loaded ${snapshots.size} GEX snapshots`);
  return snapshots;
}

async function loadLTData() {
  const filePath = path.join(dataDir, 'liquidity/es/ES_liquidity_levels_15m.csv');
  console.log(`Loading LT levels...`);
  const levels = [];
  if (!fs.existsSync(filePath)) return levels;
  const rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });
  let headerSkipped = false;
  for await (const line of rl) {
    if (!headerSkipped) { headerSkipped = true; continue; }
    const parts = line.split(',');
    if (parts.length < 7) continue;
    const timestamp = parseInt(parts[1]);
    if (timestamp < startDate.getTime() || timestamp > endDate.getTime()) continue;
    levels.push({
      timestamp, sentiment: parts[2],
      level_1: parseFloat(parts[3]), level_2: parseFloat(parts[4]),
      level_3: parseFloat(parts[5]), level_4: parseFloat(parts[6]),
      level_5: parseFloat(parts[7])
    });
  }
  levels.sort((a, b) => a.timestamp - b.timestamp);
  console.log(`  Loaded ${levels.length} LT snapshots`);
  return levels;
}

// ============================================================================
// Helpers
// ============================================================================

function getGexSnapshot(gexSnapshots, timestamp) {
  const aligned = Math.floor(timestamp / (15 * 60000)) * (15 * 60000);
  for (let offset = 0; offset <= 4; offset++) {
    const t = aligned - offset * 15 * 60000;
    if (gexSnapshots.has(t)) return gexSnapshots.get(t);
  }
  return null;
}

function getLTSnapshot(ltLevels, timestamp) {
  let left = 0, right = ltLevels.length - 1, best = -1;
  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    if (ltLevels[mid].timestamp <= timestamp) { best = mid; left = mid + 1; }
    else right = mid - 1;
  }
  return best >= 0 ? ltLevels[best] : null;
}

function getSession(timestamp) {
  const date = new Date(timestamp);
  const timeMin = date.getUTCHours() * 60 + date.getUTCMinutes();
  if (timeMin >= 870 && timeMin < 1260) return 'rth';
  if (timeMin >= 780 && timeMin < 870) return 'premarket';
  if (timeMin >= 1260 && timeMin < 1380) return 'afterhours';
  return 'overnight';
}

function getNearestLevel(gex, lt, price) {
  let nearest = null;
  let minDist = Infinity;

  if (gex) {
    const checkGex = (val, type) => {
      if (val && !isNaN(val)) {
        const dist = Math.abs(price - val);
        if (dist < minDist) { minDist = dist; nearest = { price: val, type, distance: dist }; }
      }
    };
    checkGex(gex.gamma_flip, 'gamma_flip');
    checkGex(gex.call_wall, 'call_wall');
    checkGex(gex.put_wall, 'put_wall');
    if (gex.support) gex.support.forEach((s, i) => checkGex(s, `S${i + 1}`));
    if (gex.resistance) gex.resistance.forEach((r, i) => checkGex(r, `R${i + 1}`));
  }

  if (lt) {
    for (let i = 1; i <= 5; i++) {
      const val = lt[`level_${i}`];
      if (val && !isNaN(val)) {
        const dist = Math.abs(price - val);
        if (dist < minDist) { minDist = dist; nearest = { price: val, type: `LT${i}`, distance: dist }; }
      }
    }
  }

  return nearest;
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const [candles, tradeOFI, gexSnapshots, ltLevels] = await Promise.all([
    loadOHLCVData(),
    loadTradeOFI(),
    loadGEXData(),
    loadLTData()
  ]);

  console.log('\nDetecting momentum ignition patterns...\n');

  // Compute rolling average volume
  const LOOKBACK = 20;
  const volumeAvg = new Map();
  for (let i = LOOKBACK; i < candles.length; i++) {
    let sum = 0;
    for (let j = i - LOOKBACK; j < i; j++) {
      const ofi = tradeOFI.get(candles[j].timestamp);
      if (ofi) sum += ofi.totalVolume;
    }
    volumeAvg.set(candles[i].timestamp, sum / LOOKBACK);
  }

  const events = [];
  const maxForward = Math.max(...FORWARD_WINDOWS);

  for (let i = LOOKBACK + PROBE_WINDOW; i < candles.length - maxForward - REVERSAL_WINDOW; i++) {
    const ignitionCandle = candles[i];
    const ignitionOFI = tradeOFI.get(ignitionCandle.timestamp);
    const avg = volumeAvg.get(ignitionCandle.timestamp);
    if (!ignitionOFI || !avg || avg === 0) continue;

    // Check ignition: volume spike + price move + large trades
    if (ignitionOFI.totalVolume < avg * IGNITION_VOLUME_RATIO) continue;

    const priceMove = ignitionCandle.close - ignitionCandle.open;
    if (Math.abs(priceMove) < IGNITION_MIN_PRICE_MOVE) continue;

    const ignitionDirection = priceMove > 0 ? 1 : -1;
    const largeTrades = ignitionDirection > 0
      ? ignitionOFI.largeTradeBuyVol
      : ignitionOFI.largeTradeSellVol;
    if (largeTrades < MIN_LARGE_TRADE_VOL) continue;

    // Check probe phase: preceding minutes should have low volume, same direction
    let probeValid = true;
    let probeImbalanceSum = 0;
    let probeVolumeSum = 0;

    for (let p = 1; p <= PROBE_WINDOW; p++) {
      const probeCandle = candles[i - p];
      const probeOFI = tradeOFI.get(probeCandle.timestamp);
      const probeAvg = volumeAvg.get(probeCandle.timestamp);

      if (!probeOFI || !probeAvg) { probeValid = false; break; }

      // Probe should have below-average volume
      if (probeOFI.totalVolume > probeAvg * PROBE_MAX_VOLUME_RATIO) { probeValid = false; break; }

      probeImbalanceSum += probeOFI.volumeImbalance;
      probeVolumeSum += probeOFI.totalVolume;
    }

    if (!probeValid) continue;

    // Probe direction should match ignition direction
    const probeAvgImbalance = probeImbalanceSum / PROBE_WINDOW;
    if (ignitionDirection > 0 && probeAvgImbalance < PROBE_MIN_IMBALANCE) continue;
    if (ignitionDirection < 0 && probeAvgImbalance > -PROBE_MIN_IMBALANCE) continue;

    // Check for reversal after ignition
    const ignitionHigh = ignitionCandle.high;
    const ignitionLow = ignitionCandle.low;
    const ignitionMoveSize = Math.abs(priceMove);
    let hasReversal = false;
    let reversalMinute = 0;
    let maxExtension = ignitionDirection > 0 ? ignitionHigh : ignitionLow;
    let reversalPrice = 0;

    for (let r = 1; r <= REVERSAL_WINDOW && (i + r) < candles.length; r++) {
      const rc = candles[i + r];

      // Track max extension
      if (ignitionDirection > 0) {
        if (rc.high > maxExtension) maxExtension = rc.high;
        // Reversal: price drops back by at least 50% of the ignition move
        if (rc.close < ignitionCandle.close - ignitionMoveSize * MIN_REVERSAL_RATIO) {
          hasReversal = true;
          reversalMinute = r;
          reversalPrice = rc.close;
          break;
        }
      } else {
        if (rc.low < maxExtension) maxExtension = rc.low;
        if (rc.close > ignitionCandle.close + ignitionMoveSize * MIN_REVERSAL_RATIO) {
          hasReversal = true;
          reversalMinute = r;
          reversalPrice = rc.close;
          break;
        }
      }
    }

    // Get context
    const gex = getGexSnapshot(gexSnapshots, ignitionCandle.timestamp);
    const lt = getLTSnapshot(ltLevels, ignitionCandle.timestamp);
    const nearestLevel = getNearestLevel(gex, lt, ignitionCandle.close);
    const session = getSession(ignitionCandle.timestamp);
    const regime = gex?.regime || 'unknown';

    // Forward returns from the reversal point (or ignition if no reversal)
    const returnIdx = hasReversal ? i + reversalMinute : i;
    const forwardReturns = {};
    for (const window of FORWARD_WINDOWS) {
      if (returnIdx + window < candles.length) {
        const futureCandle = candles[returnIdx + window];
        const ret = futureCandle.close - candles[returnIdx].close;
        forwardReturns[`${window}m`] = {
          points: ret,
          // After momentum ignition + reversal, expect continuation of reversal
          correctDirection: hasReversal ? (ret * -ignitionDirection > 0) : null,
          magnitude: Math.abs(ret)
        };
      }
    }

    events.push({
      timestamp: new Date(ignitionCandle.timestamp).toISOString(),
      price: ignitionCandle.close,
      direction: ignitionDirection > 0 ? 'up' : 'down',
      priceMove,
      ignitionVolume: ignitionOFI.totalVolume,
      ignitionVolumeRatio: ignitionOFI.totalVolume / avg,
      probeAvgImbalance,
      probeVolume: probeVolumeSum,
      largeTrades,
      hasReversal,
      reversalMinute,
      reversalPrice,
      maxExtension,
      extensionSize: Math.abs(maxExtension - ignitionCandle.open),
      session,
      regime,
      nearestLevel,
      nearestLevelDist: nearestLevel?.distance || null,
      forwardReturns
    });
  }

  console.log(`Found ${events.length} momentum ignition events\n`);
  console.log(`  With reversal: ${events.filter(e => e.hasReversal).length}`);
  console.log(`  Without reversal: ${events.filter(e => !e.hasReversal).length}`);

  // ============================================================================
  // Analysis
  // ============================================================================

  const analyzeGroup = (group, label) => {
    if (group.length === 0) return null;
    const result = { label, count: group.length };

    for (const window of FORWARD_WINDOWS) {
      const key = `${window}m`;
      const withData = group.filter(e => e.forwardReturns[key]);
      if (withData.length === 0) continue;
      const withDir = withData.filter(e => e.forwardReturns[key].correctDirection !== null);
      const correct = withDir.filter(e => e.forwardReturns[key].correctDirection).length;
      const avgReturn = withData.reduce((s, e) => s + e.forwardReturns[key].points, 0) / withData.length;
      result[key] = {
        winRate: withDir.length > 0 ? (correct / withDir.length * 100).toFixed(1) + '%' : 'N/A',
        avgReturn: avgReturn.toFixed(2),
        avgMagnitude: (withData.reduce((s, e) => s + e.forwardReturns[key].magnitude, 0) / withData.length).toFixed(2),
        count: withData.length
      };
    }

    result.avgIgnitionVolRatio = (group.reduce((s, e) => s + e.ignitionVolumeRatio, 0) / group.length).toFixed(2);
    result.avgPriceMove = (group.reduce((s, e) => s + Math.abs(e.priceMove), 0) / group.length).toFixed(2);
    result.reversalRate = (group.filter(e => e.hasReversal).length / group.length * 100).toFixed(1) + '%';

    return result;
  };

  const results = {
    metadata: {
      startDate: startDateStr, endDate: endDateStr,
      totalEvents: events.length,
      parameters: {
        PROBE_WINDOW, PROBE_MAX_VOLUME_RATIO, PROBE_MIN_IMBALANCE,
        IGNITION_VOLUME_RATIO, IGNITION_MIN_PRICE_MOVE, MIN_LARGE_TRADE_VOL,
        REVERSAL_WINDOW, MIN_REVERSAL_RATIO
      }
    },
    overall: analyzeGroup(events, 'all'),
    withReversal: analyzeGroup(events.filter(e => e.hasReversal), 'with_reversal'),
    withoutReversal: analyzeGroup(events.filter(e => !e.hasReversal), 'no_reversal'),
    byDirection: {
      up: analyzeGroup(events.filter(e => e.direction === 'up'), 'up'),
      down: analyzeGroup(events.filter(e => e.direction === 'down'), 'down')
    },
    bySession: {},
    byRegime: {},
    // Near a level vs not (within 10 points)
    nearLevel: analyzeGroup(events.filter(e => e.nearestLevelDist !== null && e.nearestLevelDist <= 10), 'near_level'),
    farFromLevel: analyzeGroup(events.filter(e => e.nearestLevelDist === null || e.nearestLevelDist > 10), 'far_from_level'),
    sampleEvents: events.slice(0, 20)
  };

  for (const session of [...new Set(events.map(e => e.session))]) {
    results.bySession[session] = analyzeGroup(events.filter(e => e.session === session), session);
  }
  for (const regime of [...new Set(events.map(e => e.regime))]) {
    results.byRegime[regime] = analyzeGroup(events.filter(e => e.regime === regime), regime);
  }

  // Print summary
  console.log('\n=== MOMENTUM IGNITION RESULTS ===\n');
  const printGroup = (g) => {
    if (!g) return;
    const parts = [`  ${g.label} (n=${g.count})`];
    parts.push(`rev: ${g.reversalRate}, vol: ${g.avgIgnitionVolRatio}x, move: ${g.avgPriceMove}pts`);
    for (const w of FORWARD_WINDOWS) {
      const k = `${w}m`;
      if (g[k]) parts.push(`${w}m: ${g[k].winRate} win, avg ${g[k].avgReturn}pts`);
    }
    console.log(parts.join(' | '));
  };

  printGroup(results.overall);
  printGroup(results.withReversal);
  printGroup(results.withoutReversal);
  console.log('\nBy Direction:');
  printGroup(results.byDirection.up);
  printGroup(results.byDirection.down);
  console.log('\nNear Level:');
  printGroup(results.nearLevel);
  printGroup(results.farFromLevel);
  console.log('\nBy Session:');
  for (const g of Object.values(results.bySession)) printGroup(g);

  // Write output
  const outDir = path.dirname(path.resolve(outputPath));
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.resolve(outputPath), JSON.stringify(results, null, 2));
  console.log(`\nResults written to ${outputPath}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
