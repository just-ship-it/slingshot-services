#!/usr/bin/env node
/**
 * ES Absorption Analysis
 *
 * Detects absorption events: heavy directional trade flow + price doesn't move
 * = institutional passive orders absorbing aggressive flow.
 *
 * Detection:
 * - Price within N points of a GEX support/resistance level
 * - High trade volume in the minute (> 2x average)
 * - Low price change relative to volume (|close - open| / volume < threshold)
 * - Directional volume skew (heavy sell volume but price holds = buy absorption)
 *
 * Data Sources:
 * - ES trade-ofi-1m.csv (precomputed per-minute aggregates)
 * - ES OHLCV 1m (price data)
 * - ES GEX intraday (support/resistance levels)
 * - ES LT levels (liquidity trigger levels)
 *
 * Usage:
 *   node scripts/es-absorption-analysis.js [options]
 *
 * Options:
 *   --start YYYY-MM-DD   Start date (default: 2025-01-01)
 *   --end YYYY-MM-DD     End date (default: 2026-01-31)
 *   --output FILE         Output path
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
const outputPath = getArg('output', 'results/es-orderflow/absorption-analysis-results.json');

const startDate = new Date(startDateStr + 'T00:00:00Z');
const endDate = new Date(endDateStr + 'T23:59:59Z');
const dataDir = path.resolve(process.cwd(), 'data');

// Absorption detection parameters
const VOLUME_MULTIPLIER = 2.0;     // Volume must be > Nx average
const PRICE_CHANGE_RATIO = 0.001;  // |close-open|/volume threshold (ES has larger ticks)
const GEX_PROXIMITY = 5.0;         // Points from GEX level
const LT_PROXIMITY = 10.0;         // Points from LT level
const VOLUME_SKEW_THRESHOLD = 0.3; // Min directional skew for absorption classification
const FORWARD_WINDOWS = [1, 5, 15, 30]; // Minutes forward for return analysis

console.log('='.repeat(80));
console.log('ES ABSORPTION ANALYSIS');
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
  console.log(`Loading OHLCV data from ${filePath}...`);
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
  console.log(`  Loaded ${filtered.length} candles (from ${candles.length} total)`);
  return filtered;
}

async function loadTradeOFI() {
  const filePath = path.join(dataDir, 'orderflow/es/trade-ofi-1m.csv');
  console.log(`Loading trade OFI from ${filePath}...`);
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
      largeTradeSellVol: parseInt(parts[12]),
      vwap: parseFloat(parts[13]),
      avgBuySize: parseFloat(parts[14]),
      avgSellSize: parseFloat(parts[15]),
      tradeImbalance: parseFloat(parts[16])
    });
  }
  console.log(`  Loaded ${data.size} minute records`);
  return data;
}

async function loadGEXData() {
  const gexDir = path.join(dataDir, 'gex/es');
  const snapshots = new Map();
  if (!fs.existsSync(gexDir)) {
    console.log('  No ES GEX directory found');
    return snapshots;
  }
  const files = fs.readdirSync(gexDir)
    .filter(f => f.startsWith('es_gex_') && f.endsWith('.json'))
    .filter(f => {
      const dateMatch = f.match(/es_gex_(\d{4}-\d{2}-\d{2})\.json/);
      if (!dateMatch) return false;
      const fileDate = new Date(dateMatch[1]);
      return fileDate >= startDate && fileDate <= endDate;
    });
  console.log(`Loading GEX data from ${files.length} files...`);
  for (const file of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(gexDir, file), 'utf8'));
      for (const snap of raw.data) {
        const ts = new Date(snap.timestamp).getTime();
        snapshots.set(ts, snap);
      }
    } catch (e) { /* skip */ }
  }
  console.log(`  Loaded ${snapshots.size} GEX snapshots`);
  return snapshots;
}

async function loadLTData() {
  const filePath = path.join(dataDir, 'liquidity/es/ES_liquidity_levels_15m.csv');
  console.log(`Loading LT levels from ${filePath}...`);
  const levels = [];
  if (!fs.existsSync(filePath)) {
    console.log('  LT file not found');
    return levels;
  }
  const rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });
  let headerSkipped = false;
  for await (const line of rl) {
    if (!headerSkipped) { headerSkipped = true; continue; }
    const parts = line.split(',');
    if (parts.length < 7) continue;
    const timestamp = parseInt(parts[1]);
    const date = new Date(timestamp);
    if (date < startDate || date > endDate) continue;
    levels.push({
      timestamp,
      sentiment: parts[2],
      level_1: parseFloat(parts[3]),
      level_2: parseFloat(parts[4]),
      level_3: parseFloat(parts[5]),
      level_4: parseFloat(parts[6]),
      level_5: parseFloat(parts[7])
    });
  }
  levels.sort((a, b) => a.timestamp - b.timestamp);
  console.log(`  Loaded ${levels.length} LT snapshots`);
  return levels;
}

// ============================================================================
// Helper Functions
// ============================================================================

function getGexSnapshot(gexSnapshots, timestamp) {
  // Find most recent snapshot <= timestamp (15-min intervals)
  const aligned = Math.floor(timestamp / (15 * 60000)) * (15 * 60000);
  for (let offset = 0; offset <= 4; offset++) {
    const checkTime = aligned - offset * 15 * 60000;
    if (gexSnapshots.has(checkTime)) return gexSnapshots.get(checkTime);
  }
  return null;
}

function getLTSnapshot(ltLevels, timestamp) {
  // Binary search for most recent LT snapshot
  let left = 0, right = ltLevels.length - 1, best = -1;
  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    if (ltLevels[mid].timestamp <= timestamp) {
      best = mid;
      left = mid + 1;
    } else {
      right = mid - 1;
    }
  }
  return best >= 0 ? ltLevels[best] : null;
}

function getSession(timestamp) {
  const date = new Date(timestamp);
  const hour = date.getUTCHours();
  const min = date.getUTCMinutes();
  const timeMin = hour * 60 + min;
  // EST = UTC-5; 9:30 EST = 14:30 UTC = 870min, 16:00 EST = 21:00 UTC = 1260min
  if (timeMin >= 870 && timeMin < 1260) return 'rth';
  if (timeMin >= 780 && timeMin < 870) return 'premarket'; // 8:00-9:30 EST
  if (timeMin >= 1260 && timeMin < 1380) return 'afterhours'; // 4:00-5:00 EST
  return 'overnight';
}

function getNearbyGexLevels(gex, price) {
  if (!gex) return [];
  const levels = [];
  const addLevel = (val, type) => {
    if (val && !isNaN(val)) {
      const dist = Math.abs(price - val);
      if (dist <= GEX_PROXIMITY) levels.push({ price: val, type, distance: dist });
    }
  };
  addLevel(gex.gamma_flip, 'gamma_flip');
  addLevel(gex.call_wall, 'call_wall');
  addLevel(gex.put_wall, 'put_wall');
  if (gex.support) gex.support.forEach((s, i) => addLevel(s, `S${i + 1}`));
  if (gex.resistance) gex.resistance.forEach((r, i) => addLevel(r, `R${i + 1}`));
  return levels.sort((a, b) => a.distance - b.distance);
}

function getNearbyLTLevels(lt, price) {
  if (!lt) return [];
  const levels = [];
  for (let i = 1; i <= 5; i++) {
    const val = lt[`level_${i}`];
    if (val && !isNaN(val)) {
      const dist = Math.abs(price - val);
      if (dist <= LT_PROXIMITY) levels.push({ price: val, type: `LT${i}`, distance: dist });
    }
  }
  return levels.sort((a, b) => a.distance - b.distance);
}

// ============================================================================
// Main Analysis
// ============================================================================

async function main() {
  const [candles, tradeOFI, gexSnapshots, ltLevels] = await Promise.all([
    loadOHLCVData(),
    loadTradeOFI(),
    loadGEXData(),
    loadLTData()
  ]);

  console.log('\nDetecting absorption events...\n');

  // Build candle lookup by timestamp
  const candleMap = new Map();
  candles.forEach(c => candleMap.set(c.timestamp, c));

  // Compute rolling average volume (20-minute window)
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

  // Detect absorption events
  const events = [];

  for (let i = LOOKBACK; i < candles.length - Math.max(...FORWARD_WINDOWS); i++) {
    const candle = candles[i];
    const ofi = tradeOFI.get(candle.timestamp);
    const avg = volumeAvg.get(candle.timestamp);
    if (!ofi || !avg || avg === 0) continue;

    // Condition 1: High volume
    if (ofi.totalVolume < avg * VOLUME_MULTIPLIER) continue;

    // Condition 2: Low price change relative to volume
    const priceChange = Math.abs(candle.close - candle.open);
    const priceChangeRatio = priceChange / ofi.totalVolume;
    if (priceChangeRatio > PRICE_CHANGE_RATIO) continue;

    // Condition 3: Directional volume skew
    const absImbalance = Math.abs(ofi.volumeImbalance);
    if (absImbalance < VOLUME_SKEW_THRESHOLD) continue;

    // Classification: buy absorption = heavy sell flow but price holds/rises
    // sell absorption = heavy buy flow but price holds/falls
    const absorptionType = ofi.volumeImbalance < -VOLUME_SKEW_THRESHOLD ? 'buy_absorption' : 'sell_absorption';

    // Get level context
    const gex = getGexSnapshot(gexSnapshots, candle.timestamp);
    const lt = getLTSnapshot(ltLevels, candle.timestamp);
    const nearbyGex = getNearbyGexLevels(gex, candle.close);
    const nearbyLT = getNearbyLTLevels(lt, candle.close);
    const session = getSession(candle.timestamp);
    const regime = gex?.regime || 'unknown';

    // Compute forward returns
    const forwardReturns = {};
    for (const window of FORWARD_WINDOWS) {
      const futureCandle = candles[i + window];
      if (futureCandle) {
        const ret = futureCandle.close - candle.close;
        // For buy absorption, positive return = correct prediction
        // For sell absorption, negative return = correct prediction
        const direction = absorptionType === 'buy_absorption' ? 1 : -1;
        forwardReturns[`${window}m`] = {
          points: ret,
          correct: (ret * direction) > 0,
          magnitude: Math.abs(ret)
        };
      }
    }

    // Max adverse excursion and max favorable excursion over 30 minutes
    let mae = 0, mfe = 0;
    const direction = absorptionType === 'buy_absorption' ? 1 : -1;
    for (let f = 1; f <= 30 && (i + f) < candles.length; f++) {
      const fc = candles[i + f];
      const move = (fc.close - candle.close) * direction;
      if (move > mfe) mfe = move;
      if (move < mae) mae = move;
    }

    events.push({
      timestamp: new Date(candle.timestamp).toISOString(),
      price: candle.close,
      absorptionType,
      volumeRatio: ofi.totalVolume / avg,
      volumeImbalance: ofi.volumeImbalance,
      priceChange,
      priceChangeRatio,
      totalVolume: ofi.totalVolume,
      avgVolume: avg,
      largeTradeBuyVol: ofi.largeTradeBuyVol,
      largeTradeSellVol: ofi.largeTradeSellVol,
      session,
      regime,
      nearestGexLevel: nearbyGex[0] || null,
      nearestLTLevel: nearbyLT[0] || null,
      atGexLevel: nearbyGex.length > 0,
      atLTLevel: nearbyLT.length > 0,
      gexLevelTypes: nearbyGex.map(l => l.type),
      forwardReturns,
      mae,
      mfe
    });
  }

  console.log(`Found ${events.length} absorption events\n`);

  // ============================================================================
  // Statistical Analysis
  // ============================================================================

  const analyzeGroup = (group, label) => {
    if (group.length === 0) return null;
    const result = { label, count: group.length };

    for (const window of FORWARD_WINDOWS) {
      const key = `${window}m`;
      const withData = group.filter(e => e.forwardReturns[key]);
      if (withData.length === 0) continue;

      const correct = withData.filter(e => e.forwardReturns[key].correct).length;
      const points = withData.map(e => e.forwardReturns[key].points);
      const avgReturn = points.reduce((a, b) => a + b, 0) / points.length;

      result[key] = {
        winRate: (correct / withData.length * 100).toFixed(1) + '%',
        avgReturn: avgReturn.toFixed(2),
        avgMagnitude: (withData.reduce((s, e) => s + e.forwardReturns[key].magnitude, 0) / withData.length).toFixed(2),
        count: withData.length
      };
    }

    // MAE/MFE
    const maes = group.map(e => e.mae);
    const mfes = group.map(e => e.mfe);
    result.avgMAE = (maes.reduce((a, b) => a + b, 0) / maes.length).toFixed(2);
    result.avgMFE = (mfes.reduce((a, b) => a + b, 0) / mfes.length).toFixed(2);

    return result;
  };

  const results = {
    metadata: {
      startDate: startDateStr,
      endDate: endDateStr,
      totalEvents: events.length,
      parameters: {
        volumeMultiplier: VOLUME_MULTIPLIER,
        priceChangeRatio: PRICE_CHANGE_RATIO,
        gexProximity: GEX_PROXIMITY,
        ltProximity: LT_PROXIMITY,
        volumeSkewThreshold: VOLUME_SKEW_THRESHOLD
      }
    },

    // Overall
    overall: analyzeGroup(events, 'all'),
    byType: {
      buyAbsorption: analyzeGroup(events.filter(e => e.absorptionType === 'buy_absorption'), 'buy_absorption'),
      sellAbsorption: analyzeGroup(events.filter(e => e.absorptionType === 'sell_absorption'), 'sell_absorption')
    },

    // By GEX level type
    byGexLevel: {},

    // By regime
    byRegime: {},

    // By session
    bySession: {},

    // At GEX level vs not
    atGexLevel: analyzeGroup(events.filter(e => e.atGexLevel), 'at_gex_level'),
    notAtGexLevel: analyzeGroup(events.filter(e => !e.atGexLevel), 'not_at_gex_level'),

    // At LT level vs not
    atLTLevel: analyzeGroup(events.filter(e => e.atLTLevel), 'at_lt_level'),
    notAtLTLevel: analyzeGroup(events.filter(e => !e.atLTLevel), 'not_at_lt_level'),

    // Combined: at both GEX and LT
    atBothLevels: analyzeGroup(events.filter(e => e.atGexLevel && e.atLTLevel), 'at_both_levels'),

    // Sample events
    sampleEvents: events.slice(0, 20)
  };

  // By GEX level type
  const gexLevelTypes = new Set();
  events.forEach(e => e.gexLevelTypes.forEach(t => gexLevelTypes.add(t)));
  for (const type of gexLevelTypes) {
    const group = events.filter(e => e.gexLevelTypes.includes(type));
    results.byGexLevel[type] = analyzeGroup(group, type);
  }

  // By regime
  const regimes = [...new Set(events.map(e => e.regime))];
  for (const regime of regimes) {
    results.byRegime[regime] = analyzeGroup(events.filter(e => e.regime === regime), regime);
  }

  // By session
  const sessions = [...new Set(events.map(e => e.session))];
  for (const session of sessions) {
    results.bySession[session] = analyzeGroup(events.filter(e => e.session === session), session);
  }

  // Print summary
  console.log('=== ABSORPTION ANALYSIS RESULTS ===\n');
  console.log(`Total events: ${events.length}`);
  console.log(`  Buy absorption: ${events.filter(e => e.absorptionType === 'buy_absorption').length}`);
  console.log(`  Sell absorption: ${events.filter(e => e.absorptionType === 'sell_absorption').length}`);
  console.log(`  At GEX level: ${events.filter(e => e.atGexLevel).length}`);
  console.log(`  At LT level: ${events.filter(e => e.atLTLevel).length}`);
  console.log();

  const printGroup = (group) => {
    if (!group) return;
    const parts = [`  ${group.label} (n=${group.count})`];
    for (const w of FORWARD_WINDOWS) {
      const key = `${w}m`;
      if (group[key]) {
        parts.push(`${w}m: ${group[key].winRate} win, avg ${group[key].avgReturn}pts`);
      }
    }
    if (group.avgMAE) parts.push(`MAE: ${group.avgMAE}, MFE: ${group.avgMFE}`);
    console.log(parts.join(' | '));
  };

  console.log('Overall:');
  printGroup(results.overall);
  console.log('\nBy Type:');
  printGroup(results.byType.buyAbsorption);
  printGroup(results.byType.sellAbsorption);
  console.log('\nAt GEX Level:');
  printGroup(results.atGexLevel);
  printGroup(results.notAtGexLevel);
  console.log('\nBy Session:');
  for (const session of sessions) printGroup(results.bySession[session]);
  console.log('\nBy Regime:');
  for (const regime of regimes) printGroup(results.byRegime[regime]);
  console.log('\nBy GEX Level Type:');
  for (const type of gexLevelTypes) printGroup(results.byGexLevel[type]);

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
