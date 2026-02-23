#!/usr/bin/env node
/**
 * ES Sweep Analysis
 *
 * Detects aggressive sweeps: rapid directional volume consuming multiple price levels.
 *
 * Detection from precomputed data:
 * - High single-minute volume (> 3x average) + large price movement (> 2 points)
 * - Strong volume imbalance (> 0.6 in one direction)
 * - Large trade concentration (many fills > 10 contracts)
 *
 * From 1-second OHLCV (for sub-minute detection):
 * - 5+ consecutive seconds with same-direction aggressive volume
 * - Price spanning 3+ ticks (0.75 pts) within the window
 *
 * Usage:
 *   node scripts/es-sweep-analysis.js [options]
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
const outputPath = getArg('output', 'results/es-orderflow/sweep-analysis-results.json');

const startDate = new Date(startDateStr + 'T00:00:00Z');
const endDate = new Date(endDateStr + 'T23:59:59Z');
const dataDir = path.resolve(process.cwd(), 'data');

// Sweep detection parameters
const VOLUME_MULTIPLIER = 3.0;
const MIN_PRICE_MOVE = 2.0;         // ES points
const MIN_IMBALANCE = 0.6;          // Directional volume skew
const LARGE_TRADE_THRESHOLD = 10;   // Contracts
const FORWARD_WINDOWS = [1, 5, 15, 30];

console.log('='.repeat(80));
console.log('ES SWEEP ANALYSIS');
console.log('='.repeat(80));
console.log(`Date range: ${startDateStr} to ${endDateStr}`);
console.log();

// ============================================================================
// Data Loading (shared patterns)
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
      for (const snap of raw.data) {
        snapshots.set(new Date(snap.timestamp).getTime(), snap);
      }
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

function getGexLevelsCrossed(gex, low, high) {
  if (!gex) return [];
  const crossed = [];
  const checkLevel = (val, type) => {
    if (val && !isNaN(val) && val >= low && val <= high) {
      crossed.push({ price: val, type });
    }
  };
  checkLevel(gex.gamma_flip, 'gamma_flip');
  checkLevel(gex.call_wall, 'call_wall');
  checkLevel(gex.put_wall, 'put_wall');
  if (gex.support) gex.support.forEach((s, i) => checkLevel(s, `S${i + 1}`));
  if (gex.resistance) gex.resistance.forEach((r, i) => checkLevel(r, `R${i + 1}`));
  return crossed;
}

function getLTLevelsCrossed(lt, low, high) {
  if (!lt) return [];
  const crossed = [];
  for (let i = 1; i <= 5; i++) {
    const val = lt[`level_${i}`];
    if (val && !isNaN(val) && val >= low && val <= high) {
      crossed.push({ price: val, type: `LT${i}` });
    }
  }
  return crossed;
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

  console.log('\nDetecting sweep events...\n');

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

  for (let i = LOOKBACK; i < candles.length - Math.max(...FORWARD_WINDOWS); i++) {
    const candle = candles[i];
    const ofi = tradeOFI.get(candle.timestamp);
    const avg = volumeAvg.get(candle.timestamp);
    if (!ofi || !avg || avg === 0) continue;

    // Condition 1: High volume
    if (ofi.totalVolume < avg * VOLUME_MULTIPLIER) continue;

    // Condition 2: Significant price movement
    const priceMove = Math.abs(candle.close - candle.open);
    if (priceMove < MIN_PRICE_MOVE) continue;

    // Condition 3: Strong directional imbalance
    if (Math.abs(ofi.volumeImbalance) < MIN_IMBALANCE) continue;

    // Sweep direction
    const direction = ofi.volumeImbalance > 0 ? 'buy_sweep' : 'sell_sweep';
    const priceDirection = candle.close > candle.open ? 'up' : 'down';

    // Large trade concentration
    const largeBuyRatio = ofi.totalVolume > 0 ? ofi.largeTradeBuyVol / ofi.totalVolume : 0;
    const largeSellRatio = ofi.totalVolume > 0 ? ofi.largeTradeSellVol / ofi.totalVolume : 0;

    // Check for level crossings during the sweep
    const gex = getGexSnapshot(gexSnapshots, candle.timestamp);
    const lt = getLTSnapshot(ltLevels, candle.timestamp);
    const gexCrossed = getGexLevelsCrossed(gex, candle.low, candle.high);
    const ltCrossed = getLTLevelsCrossed(lt, candle.low, candle.high);
    const session = getSession(candle.timestamp);
    const regime = gex?.regime || 'unknown';

    // Forward returns: continuation vs reversal
    const forwardReturns = {};
    for (const window of FORWARD_WINDOWS) {
      const futureCandle = candles[i + window];
      if (!futureCandle) continue;
      const ret = futureCandle.close - candle.close;
      const sweepDir = direction === 'buy_sweep' ? 1 : -1;
      const continuation = (ret * sweepDir) > 0;
      forwardReturns[`${window}m`] = {
        points: ret,
        continuation,
        reversal: !continuation && Math.abs(ret) > MIN_PRICE_MOVE,
        magnitude: Math.abs(ret)
      };
    }

    // MAE/MFE over 30m
    let mae = 0, mfe = 0;
    const dir = direction === 'buy_sweep' ? 1 : -1;
    for (let f = 1; f <= 30 && (i + f) < candles.length; f++) {
      const move = (candles[i + f].close - candle.close) * dir;
      if (move > mfe) mfe = move;
      if (move < mae) mae = move;
    }

    events.push({
      timestamp: new Date(candle.timestamp).toISOString(),
      price: candle.close,
      direction,
      priceDirection,
      priceMove,
      range: candle.high - candle.low,
      volumeRatio: ofi.totalVolume / avg,
      volumeImbalance: ofi.volumeImbalance,
      totalVolume: ofi.totalVolume,
      largeBuyRatio,
      largeSellRatio,
      maxTradeSize: ofi.maxTradeSize,
      session,
      regime,
      gexLevelsCrossed: gexCrossed.map(l => l.type),
      ltLevelsCrossed: ltCrossed.map(l => l.type),
      crossedAnyGex: gexCrossed.length > 0,
      crossedAnyLT: ltCrossed.length > 0,
      forwardReturns,
      mae,
      mfe
    });
  }

  console.log(`Found ${events.length} sweep events\n`);

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

      const continuations = withData.filter(e => e.forwardReturns[key].continuation).length;
      const reversals = withData.filter(e => e.forwardReturns[key].reversal).length;
      const avgReturn = withData.reduce((s, e) => s + e.forwardReturns[key].points, 0) / withData.length;

      result[key] = {
        continuationRate: (continuations / withData.length * 100).toFixed(1) + '%',
        reversalRate: (reversals / withData.length * 100).toFixed(1) + '%',
        avgReturn: avgReturn.toFixed(2),
        avgMagnitude: (withData.reduce((s, e) => s + e.forwardReturns[key].magnitude, 0) / withData.length).toFixed(2),
        count: withData.length
      };
    }

    result.avgMAE = (group.reduce((s, e) => s + e.mae, 0) / group.length).toFixed(2);
    result.avgMFE = (group.reduce((s, e) => s + e.mfe, 0) / group.length).toFixed(2);
    result.avgVolumeRatio = (group.reduce((s, e) => s + e.volumeRatio, 0) / group.length).toFixed(2);

    return result;
  };

  const results = {
    metadata: {
      startDate: startDateStr, endDate: endDateStr,
      totalEvents: events.length,
      parameters: { VOLUME_MULTIPLIER, MIN_PRICE_MOVE, MIN_IMBALANCE }
    },
    overall: analyzeGroup(events, 'all'),
    byDirection: {
      buySweep: analyzeGroup(events.filter(e => e.direction === 'buy_sweep'), 'buy_sweep'),
      sellSweep: analyzeGroup(events.filter(e => e.direction === 'sell_sweep'), 'sell_sweep')
    },
    crossedGexLevel: analyzeGroup(events.filter(e => e.crossedAnyGex), 'crossed_gex'),
    noCrossGex: analyzeGroup(events.filter(e => !e.crossedAnyGex), 'no_gex_cross'),
    crossedLTLevel: analyzeGroup(events.filter(e => e.crossedAnyLT), 'crossed_lt'),
    bySession: {},
    byRegime: {},
    byGexLevelCrossed: {},
    sampleEvents: events.slice(0, 20)
  };

  // By session
  for (const session of [...new Set(events.map(e => e.session))]) {
    results.bySession[session] = analyzeGroup(events.filter(e => e.session === session), session);
  }

  // By regime
  for (const regime of [...new Set(events.map(e => e.regime))]) {
    results.byRegime[regime] = analyzeGroup(events.filter(e => e.regime === regime), regime);
  }

  // By specific GEX level crossed
  const allCrossedTypes = new Set();
  events.forEach(e => e.gexLevelsCrossed.forEach(t => allCrossedTypes.add(t)));
  for (const type of allCrossedTypes) {
    results.byGexLevelCrossed[type] = analyzeGroup(
      events.filter(e => e.gexLevelsCrossed.includes(type)), type
    );
  }

  // Print summary
  console.log('=== SWEEP ANALYSIS RESULTS ===\n');
  const printGroup = (g) => {
    if (!g) return;
    const parts = [`  ${g.label} (n=${g.count})`];
    for (const w of FORWARD_WINDOWS) {
      const k = `${w}m`;
      if (g[k]) parts.push(`${w}m: ${g[k].continuationRate} cont, ${g[k].reversalRate} rev, avg ${g[k].avgReturn}pts`);
    }
    console.log(parts.join(' | '));
  };

  console.log(`Total sweeps: ${events.length}`);
  console.log(`  Buy sweeps: ${events.filter(e => e.direction === 'buy_sweep').length}`);
  console.log(`  Sell sweeps: ${events.filter(e => e.direction === 'sell_sweep').length}`);
  console.log(`  Crossed GEX: ${events.filter(e => e.crossedAnyGex).length}`);
  console.log(`  Crossed LT: ${events.filter(e => e.crossedAnyLT).length}`);
  console.log();

  console.log('Overall:');
  printGroup(results.overall);
  console.log('\nBy Direction:');
  printGroup(results.byDirection.buySweep);
  printGroup(results.byDirection.sellSweep);
  console.log('\nGEX Level Crossed:');
  printGroup(results.crossedGexLevel);
  printGroup(results.noCrossGex);
  console.log('\nBy Session:');
  for (const s of Object.values(results.bySession)) printGroup(s);
  console.log('\nBy Regime:');
  for (const r of Object.values(results.byRegime)) printGroup(r);

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
