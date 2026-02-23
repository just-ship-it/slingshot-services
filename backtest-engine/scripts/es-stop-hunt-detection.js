#!/usr/bin/env node
/**
 * ES Stop Hunt Detection
 *
 * Detects stop hunts: rapid price extension beyond a known level followed by reversal.
 *
 * Detection:
 * 1. Price rapidly extends beyond a known level (GEX S/R, LT level, prior day H/L, round number)
 * 2. High volume burst during the extension (confirms stop triggers)
 * 3. Price reverses back through the level within 1-5 minutes
 * 4. Volume skew: initial extension has strong directional flow, reversal has opposite
 *
 * Usage:
 *   node scripts/es-stop-hunt-detection.js [options]
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
const outputPath = getArg('output', 'results/es-orderflow/stop-hunt-results.json');

const startDate = new Date(startDateStr + 'T00:00:00Z');
const endDate = new Date(endDateStr + 'T23:59:59Z');
const dataDir = path.resolve(process.cwd(), 'data');

// Detection parameters
const MAX_EXTENSION_MINUTES = 3;   // Max minutes for the extension phase
const MAX_REVERSAL_MINUTES = 5;    // Max minutes for reversal to occur
const MIN_PENETRATION = 1.0;       // Minimum points beyond level
const MIN_REVERSAL = 2.0;          // Minimum points reversal past level
const VOLUME_BURST_RATIO = 1.5;    // Volume during extension vs recent average
const ROUND_NUMBER_INTERVAL = 25;  // ES trades in 25-point round numbers (5800, 5825, etc.)
const FORWARD_WINDOWS = [5, 15, 30, 60]; // Forward return windows

console.log('='.repeat(80));
console.log('ES STOP HUNT DETECTION');
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
      volumeImbalance: parseFloat(parts[8]),
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

function getAllKnownLevels(gex, lt, priorDayHigh, priorDayLow, price) {
  const levels = [];

  // GEX levels
  if (gex) {
    const addGex = (val, type) => {
      if (val && !isNaN(val)) levels.push({ price: val, type, source: 'gex' });
    };
    addGex(gex.gamma_flip, 'gamma_flip');
    addGex(gex.call_wall, 'call_wall');
    addGex(gex.put_wall, 'put_wall');
    if (gex.support) gex.support.forEach((s, i) => addGex(s, `S${i + 1}`));
    if (gex.resistance) gex.resistance.forEach((r, i) => addGex(r, `R${i + 1}`));
  }

  // LT levels
  if (lt) {
    for (let i = 1; i <= 5; i++) {
      const val = lt[`level_${i}`];
      if (val && !isNaN(val)) levels.push({ price: val, type: `LT${i}`, source: 'lt' });
    }
  }

  // Prior day H/L
  if (priorDayHigh && !isNaN(priorDayHigh)) {
    levels.push({ price: priorDayHigh, type: 'prior_day_high', source: 'price' });
  }
  if (priorDayLow && !isNaN(priorDayLow)) {
    levels.push({ price: priorDayLow, type: 'prior_day_low', source: 'price' });
  }

  // Round numbers near current price
  const nearestRound = Math.round(price / ROUND_NUMBER_INTERVAL) * ROUND_NUMBER_INTERVAL;
  for (let offset = -2; offset <= 2; offset++) {
    const roundLevel = nearestRound + offset * ROUND_NUMBER_INTERVAL;
    levels.push({ price: roundLevel, type: 'round_number', source: 'price' });
  }

  return levels;
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

  console.log('\nDetecting stop hunts...\n');

  // Compute prior day high/low
  const dailyHL = new Map();
  let currentDayKey = '';
  let dayHigh = -Infinity, dayLow = Infinity;
  for (const candle of candles) {
    const dayKey = new Date(candle.timestamp).toISOString().split('T')[0];
    if (dayKey !== currentDayKey) {
      if (currentDayKey) dailyHL.set(currentDayKey, { high: dayHigh, low: dayLow });
      currentDayKey = dayKey;
      dayHigh = candle.high;
      dayLow = candle.low;
    } else {
      if (candle.high > dayHigh) dayHigh = candle.high;
      if (candle.low < dayLow) dayLow = candle.low;
    }
  }
  if (currentDayKey) dailyHL.set(currentDayKey, { high: dayHigh, low: dayLow });

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

  for (let i = LOOKBACK; i < candles.length - Math.max(...FORWARD_WINDOWS) - MAX_REVERSAL_MINUTES; i++) {
    const candle = candles[i];
    const ofi = tradeOFI.get(candle.timestamp);
    const avg = volumeAvg.get(candle.timestamp);
    if (!ofi || !avg) continue;

    // Need a volume burst
    if (ofi.totalVolume < avg * VOLUME_BURST_RATIO) continue;

    // Get prior day's H/L
    const dayKey = new Date(candle.timestamp).toISOString().split('T')[0];
    const prevDay = new Date(candle.timestamp);
    prevDay.setDate(prevDay.getDate() - 1);
    const prevDayKey = prevDay.toISOString().split('T')[0];
    const priorHL = dailyHL.get(prevDayKey);

    const gex = getGexSnapshot(gexSnapshots, candle.timestamp);
    const lt = getLTSnapshot(ltLevels, candle.timestamp);
    const levels = getAllKnownLevels(gex, lt, priorHL?.high, priorHL?.low, candle.close);

    // Check if this candle's high or low extends beyond any known level
    for (const level of levels) {
      // Upside stop hunt: price extends above level, then reverses below
      const upsidePenetration = candle.high - level.price;
      if (upsidePenetration >= MIN_PENETRATION && candle.open < level.price) {
        // Check for reversal in next N minutes
        let reversed = false;
        let reversalMinute = 0;
        let maxPenetration = upsidePenetration;
        let extensionVolume = ofi.totalVolume;
        let reversalVolume = 0;

        for (let r = 1; r <= MAX_REVERSAL_MINUTES && (i + r) < candles.length; r++) {
          const rc = candles[i + r];
          const rOfi = tradeOFI.get(rc.timestamp);

          const pen = rc.high - level.price;
          if (pen > maxPenetration) maxPenetration = pen;

          if (rc.close < level.price - MIN_REVERSAL) {
            reversed = true;
            reversalMinute = r;
            if (rOfi) reversalVolume = rOfi.totalVolume;
            break;
          }
        }

        if (reversed) {
          const session = getSession(candle.timestamp);
          const regime = gex?.regime || 'unknown';

          // Forward returns from the reversal point
          const reversalIdx = i + reversalMinute;
          const forwardReturns = {};
          for (const window of FORWARD_WINDOWS) {
            if (reversalIdx + window < candles.length) {
              const futureCandle = candles[reversalIdx + window];
              const ret = futureCandle.close - candles[reversalIdx].close;
              forwardReturns[`${window}m`] = {
                points: ret,
                // For upside stop hunt, we expect downward continuation after reversal
                correct: ret < 0,
                magnitude: Math.abs(ret)
              };
            }
          }

          events.push({
            timestamp: new Date(candle.timestamp).toISOString(),
            price: candle.close,
            huntDirection: 'upside',
            levelType: level.type,
            levelSource: level.source,
            levelPrice: level.price,
            penetration: maxPenetration,
            reversalMinutes: reversalMinute,
            extensionVolume,
            reversalVolume,
            volumeRatio: extensionVolume / avg,
            session,
            regime,
            forwardReturns
          });
          break; // Only record one stop hunt per candle
        }
      }

      // Downside stop hunt: price extends below level, then reverses above
      const downsidePenetration = level.price - candle.low;
      if (downsidePenetration >= MIN_PENETRATION && candle.open > level.price) {
        let reversed = false;
        let reversalMinute = 0;
        let maxPenetration = downsidePenetration;
        let extensionVolume = ofi.totalVolume;
        let reversalVolume = 0;

        for (let r = 1; r <= MAX_REVERSAL_MINUTES && (i + r) < candles.length; r++) {
          const rc = candles[i + r];
          const rOfi = tradeOFI.get(rc.timestamp);

          const pen = level.price - rc.low;
          if (pen > maxPenetration) maxPenetration = pen;

          if (rc.close > level.price + MIN_REVERSAL) {
            reversed = true;
            reversalMinute = r;
            if (rOfi) reversalVolume = rOfi.totalVolume;
            break;
          }
        }

        if (reversed) {
          const session = getSession(candle.timestamp);
          const regime = gex?.regime || 'unknown';

          const reversalIdx = i + reversalMinute;
          const forwardReturns = {};
          for (const window of FORWARD_WINDOWS) {
            if (reversalIdx + window < candles.length) {
              const futureCandle = candles[reversalIdx + window];
              const ret = futureCandle.close - candles[reversalIdx].close;
              forwardReturns[`${window}m`] = {
                points: ret,
                correct: ret > 0, // Upward continuation after downside hunt reversal
                magnitude: Math.abs(ret)
              };
            }
          }

          events.push({
            timestamp: new Date(candle.timestamp).toISOString(),
            price: candle.close,
            huntDirection: 'downside',
            levelType: level.type,
            levelSource: level.source,
            levelPrice: level.price,
            penetration: maxPenetration,
            reversalMinutes: reversalMinute,
            extensionVolume,
            reversalVolume,
            volumeRatio: extensionVolume / avg,
            session,
            regime,
            forwardReturns
          });
          break;
        }
      }
    }
  }

  console.log(`Found ${events.length} stop hunt events\n`);

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
      const correct = withData.filter(e => e.forwardReturns[key].correct).length;
      const avgReturn = withData.reduce((s, e) => s + e.forwardReturns[key].points, 0) / withData.length;
      result[key] = {
        winRate: (correct / withData.length * 100).toFixed(1) + '%',
        avgReturn: avgReturn.toFixed(2),
        avgMagnitude: (withData.reduce((s, e) => s + e.forwardReturns[key].magnitude, 0) / withData.length).toFixed(2),
        count: withData.length
      };
    }

    result.avgPenetration = (group.reduce((s, e) => s + e.penetration, 0) / group.length).toFixed(2);
    result.avgReversalMinutes = (group.reduce((s, e) => s + e.reversalMinutes, 0) / group.length).toFixed(1);
    result.avgVolumeRatio = (group.reduce((s, e) => s + e.volumeRatio, 0) / group.length).toFixed(2);

    return result;
  };

  const results = {
    metadata: {
      startDate: startDateStr, endDate: endDateStr,
      totalEvents: events.length,
      parameters: { MAX_EXTENSION_MINUTES, MAX_REVERSAL_MINUTES, MIN_PENETRATION, MIN_REVERSAL, VOLUME_BURST_RATIO }
    },
    overall: analyzeGroup(events, 'all'),
    byHuntDirection: {
      upside: analyzeGroup(events.filter(e => e.huntDirection === 'upside'), 'upside'),
      downside: analyzeGroup(events.filter(e => e.huntDirection === 'downside'), 'downside')
    },
    byLevelType: {},
    byLevelSource: {},
    bySession: {},
    byRegime: {},
    sampleEvents: events.slice(0, 20)
  };

  // By level type
  for (const type of [...new Set(events.map(e => e.levelType))]) {
    results.byLevelType[type] = analyzeGroup(events.filter(e => e.levelType === type), type);
  }

  // By level source
  for (const source of [...new Set(events.map(e => e.levelSource))]) {
    results.byLevelSource[source] = analyzeGroup(events.filter(e => e.levelSource === source), source);
  }

  // By session
  for (const session of [...new Set(events.map(e => e.session))]) {
    results.bySession[session] = analyzeGroup(events.filter(e => e.session === session), session);
  }

  // By regime
  for (const regime of [...new Set(events.map(e => e.regime))]) {
    results.byRegime[regime] = analyzeGroup(events.filter(e => e.regime === regime), regime);
  }

  // Print summary
  console.log('=== STOP HUNT DETECTION RESULTS ===\n');
  const printGroup = (g) => {
    if (!g) return;
    const parts = [`  ${g.label} (n=${g.count})`];
    for (const w of FORWARD_WINDOWS) {
      const k = `${w}m`;
      if (g[k]) parts.push(`${w}m: ${g[k].winRate} win, avg ${g[k].avgReturn}pts`);
    }
    if (g.avgPenetration) parts.push(`pen: ${g.avgPenetration}pts`);
    console.log(parts.join(' | '));
  };

  console.log(`Total stop hunts: ${events.length}`);
  console.log(`  Upside: ${events.filter(e => e.huntDirection === 'upside').length}`);
  console.log(`  Downside: ${events.filter(e => e.huntDirection === 'downside').length}`);
  console.log();

  console.log('Overall:');
  printGroup(results.overall);
  console.log('\nBy Direction:');
  printGroup(results.byHuntDirection.upside);
  printGroup(results.byHuntDirection.downside);
  console.log('\nBy Level Type (most hunted):');
  const sortedTypes = Object.entries(results.byLevelType)
    .sort((a, b) => (b[1]?.count || 0) - (a[1]?.count || 0));
  for (const [, group] of sortedTypes.slice(0, 10)) printGroup(group);
  console.log('\nBy Level Source:');
  for (const g of Object.values(results.byLevelSource)) printGroup(g);
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
