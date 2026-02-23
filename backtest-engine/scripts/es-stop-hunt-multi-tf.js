#!/usr/bin/env node
/**
 * ES Stop Hunt Multi-Timeframe Backtest
 *
 * Runs the stop hunt reversal strategy across multiple timeframes (15s, 30s, 1m, 5m, 15m)
 * in a single pass. Parameters scale with sqrt(timeframe_ratio) from the 1m baseline.
 *
 * Data sources:
 *   - 1-second candles (for 15s/30s timeframes) — streamed to avoid 6.5GB memory load
 *   - 1-minute candles (for 1m/5m/15m timeframes)
 *   - OFI 1-minute data (aggregated per timeframe)
 *   - ES GEX intraday JSON (15-min snapshots)
 *
 * Usage:
 *   node --max-old-space-size=8192 scripts/es-stop-hunt-multi-tf.js [options]
 *
 *   --start          Start date (default: 2025-01-01)
 *   --end            End date (default: 2026-01-31)
 *   --timeframes     Comma-separated list (default: 1m,5m,15m)
 *   --min-penetration  Override 1m baseline penetration (default: 3.5)
 *   --volume-ratio   Override 1m baseline volume burst ratio (default: 2.0)
 *   --min-max-trade  Override min max trade size filter (default: 50)
 *   --regime-filter  all|exclude_strong|exclude_strong_neg_only (default: exclude_strong)
 *   --levels         tier1|all (default: all)
 *   --output         Output file path
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { CandleAggregator } from '../../shared/utils/candle-aggregator.js';

const args = process.argv.slice(2);
const getArg = (name, defaultValue) => {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 ? args[idx + 1] : defaultValue;
};

// Configuration
const config = {
  startDate: getArg('start', '2025-01-01'),
  endDate: getArg('end', '2026-01-31'),
  timeframes: getArg('timeframes', '1m,5m,15m').split(',').map(s => s.trim()),
  regimeFilter: getArg('regime-filter', 'exclude_strong'),
  levelFilter: getArg('levels', 'all'),
  output: getArg('output', null),
  // 1m baseline parameters (scaled per timeframe)
  baseline: {
    minPenetration: parseFloat(getArg('min-penetration', '3.5')),
    volumeBurstRatio: parseFloat(getArg('volume-ratio', '2.0')),
    minMaxTradeSize: parseInt(getArg('min-max-trade', '50')),
    stopBuffer: 1.0,
    trailingTrigger: 5.0,
    trailingOffset: 4.0,
    targetPoints: 20.0,
    maxHoldBars: 60,
    maxReversalBars: 5,
    volumeLookback: 20,
    slippage: 0.25,
    cooldownMs: 5 * 60 * 1000,
  }
};

const startDate = new Date(config.startDate + 'T00:00:00Z');
const endDate = new Date(config.endDate + 'T23:59:59Z');
const dataDir = path.resolve(process.cwd(), 'data');

const SUPPORT_LEVELS_TIER1 = ['put_wall', 'S3', 'S4'];
const SUPPORT_LEVELS_ALL = ['put_wall', 'S2', 'S3', 'S4', 'S5'];
const activeLevels = config.levelFilter === 'tier1' ? SUPPORT_LEVELS_TIER1 : SUPPORT_LEVELS_ALL;

const BLOCKED_REGIMES = {
  'all': [],
  'exclude_strong': ['strong_negative', 'strong_positive'],
  'exclude_strong_neg_only': ['strong_negative']
};
const blockedRegimes = BLOCKED_REGIMES[config.regimeFilter] || BLOCKED_REGIMES['exclude_strong'];

const ES_POINT_VALUE = 50;

// Timeframe minutes mapping
const TF_MINUTES = { '15s': 1/4, '30s': 1/2, '1m': 1, '5m': 5, '15m': 15 };
const SUB_MINUTE_TFS = ['15s', '30s'];
const MINUTE_PLUS_TFS = ['1m', '5m', '15m'];

// ============================================================================
// Parameter Scaling
// ============================================================================

function scaleParams(tf) {
  const tfMin = TF_MINUTES[tf];
  const ratio = Math.sqrt(tfMin / 1); // sqrt scaling from 1m baseline
  const b = config.baseline;
  return {
    minPenetration: parseFloat((b.minPenetration * ratio).toFixed(2)),
    volumeBurstRatio: b.volumeBurstRatio,     // same across timeframes
    minMaxTradeSize: b.minMaxTradeSize,        // same (1m OFI resolution)
    stopBuffer: parseFloat((b.stopBuffer * ratio).toFixed(2)),
    trailingTrigger: parseFloat((b.trailingTrigger * ratio).toFixed(1)),
    trailingOffset: parseFloat((b.trailingOffset * ratio).toFixed(1)),
    targetPoints: parseFloat((b.targetPoints * ratio).toFixed(1)),
    maxHoldBars: Math.round(60 / tfMin),       // 60 minutes hold regardless of TF
    maxReversalBars: 5,                         // same number of bars
    volumeLookback: 20,                         // same number of bars
    slippage: b.slippage,                       // fixed slippage in points
    cooldownMs: b.cooldownMs,
    barDurationMs: Math.round(tfMin * 60 * 1000),
  };
}

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

async function loadOHLCV1m() {
  const filePath = path.join(dataDir, 'ohlcv/es/ES_ohlcv_1m.csv');
  console.log('Loading 1m OHLCV data...');
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
  console.log(`  Loaded ${filtered.length} 1m candles (${candles.length - filtered.length} secondary contract removed)`);
  return filtered;
}

/**
 * Stream 1s data, aggregate to sub-minute timeframes, and run detection inline.
 * Returns aggregated candles for each requested sub-minute timeframe.
 */
async function loadAndAggregate1s(subMinuteTFs) {
  const filePath = path.join(dataDir, 'ohlcv/es/ES_ohlcv_1s.csv');
  if (!fs.existsSync(filePath)) {
    // Try continuous version
    const altPath = path.join(dataDir, 'ohlcv/es/ES_ohlcv_1s_continuous.csv');
    if (!fs.existsSync(altPath)) {
      console.log('  No 1s data found, skipping sub-minute timeframes');
      return null;
    }
    return await streamAggregate1s(altPath, subMinuteTFs);
  }
  return await streamAggregate1s(filePath, subMinuteTFs);
}

async function streamAggregate1s(filePath, subMinuteTFs) {
  console.log(`Streaming 1s data for sub-minute aggregation (${subMinuteTFs.join(', ')})...`);
  const aggregator = new CandleAggregator();

  // Initialize incremental aggregators for each sub-minute TF
  for (const tf of subMinuteTFs) {
    aggregator.initIncremental(tf, 'stream');
  }

  // We need to collect all 1s candles first for primary contract filtering
  // But that's too much memory for 6.5GB. Instead, we do a two-pass approach:
  // Pass 1: Scan for primary contract per hour (just symbol + volume + hourKey)
  // Pass 2: Stream again, filter, and aggregate

  console.log('  Pass 1: Identifying primary contracts per hour...');
  const hourlyVolumes = new Map(); // hourKey -> Map(symbol -> totalVolume)
  let rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });
  let headerSkipped = false;
  let totalLines = 0;

  for await (const line of rl) {
    if (!headerSkipped) { headerSkipped = true; continue; }
    const parts = line.split(',');
    if (parts.length < 10) continue;

    const tsStr = parts[0];
    // Quick date range filter using string comparison (avoid Date parsing for speed)
    if (tsStr < config.startDate || tsStr > config.endDate + 'T23:59:59') continue;

    const symbol = parts[9]?.trim();
    if (symbol && symbol.includes('-')) continue;

    const timestamp = new Date(tsStr).getTime();
    if (timestamp < startDate.getTime() || timestamp > endDate.getTime()) continue;

    const volume = parseInt(parts[8]) || 0;
    const hourKey = Math.floor(timestamp / 3600000);

    if (!hourlyVolumes.has(hourKey)) hourlyVolumes.set(hourKey, new Map());
    const hv = hourlyVolumes.get(hourKey);
    hv.set(symbol, (hv.get(symbol) || 0) + volume);
    totalLines++;
  }

  // Build primary contract lookup
  const primaryByHour = new Map();
  for (const [hourKey, symbolMap] of hourlyVolumes) {
    let primary = '', maxVol = 0;
    for (const [sym, vol] of symbolMap) {
      if (vol > maxVol) { maxVol = vol; primary = sym; }
    }
    primaryByHour.set(hourKey, primary);
  }
  hourlyVolumes.clear(); // Free memory
  console.log(`  Pass 1 complete: ${totalLines} lines scanned, ${primaryByHour.size} hours mapped`);

  console.log('  Pass 2: Streaming and aggregating...');
  rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });
  headerSkipped = false;
  let aggregatedCount = 0;

  const results = {};
  for (const tf of subMinuteTFs) {
    results[tf] = [];
  }

  // Track completed candles per TF
  const lastPeriodStart = {};
  for (const tf of subMinuteTFs) {
    lastPeriodStart[tf] = null;
  }

  for await (const line of rl) {
    if (!headerSkipped) { headerSkipped = true; continue; }
    const parts = line.split(',');
    if (parts.length < 10) continue;

    const timestamp = new Date(parts[0]).getTime();
    if (timestamp < startDate.getTime() || timestamp > endDate.getTime()) continue;

    const symbol = parts[9]?.trim();
    if (symbol && symbol.includes('-')) continue;

    // Primary contract filter
    const hourKey = Math.floor(timestamp / 3600000);
    if (primaryByHour.get(hourKey) !== symbol) continue;

    const open = parseFloat(parts[4]);
    const high = parseFloat(parts[5]);
    const low = parseFloat(parts[6]);
    const close = parseFloat(parts[7]);
    const volume = parseInt(parts[8]) || 0;
    if (open === high && high === low && low === close && volume === 0) continue;

    const candle = { timestamp, open, high, low, close, volume, symbol };

    // Aggregate into each sub-minute TF
    for (const tf of subMinuteTFs) {
      const intervalMinutes = TF_MINUTES[tf];
      const periodStart = aggregator.getPeriodStart(timestamp, intervalMinutes);

      if (lastPeriodStart[tf] !== null && periodStart !== lastPeriodStart[tf]) {
        // Period completed — the addCandleIncremental will finalize it
      }

      aggregator.addCandleIncremental(candle, tf, 'stream');
      lastPeriodStart[tf] = periodStart;
    }

    aggregatedCount++;
    if (aggregatedCount % 5000000 === 0) {
      process.stdout.write(`\r  ${(aggregatedCount / 1000000).toFixed(1)}M 1s candles processed`);
    }
  }

  process.stdout.write('\r' + ' '.repeat(60) + '\r');

  // Extract final aggregated candles
  for (const tf of subMinuteTFs) {
    results[tf] = aggregator.getIncrementalCandles(tf, 'stream');
    console.log(`  ${tf}: ${results[tf].length} aggregated candles`);
  }

  return results;
}

async function loadTradeOFI() {
  const filePath = path.join(dataDir, 'orderflow/es/trade-ofi-1m.csv');
  if (!fs.existsSync(filePath)) {
    console.log('  No trade OFI file found');
    return null;
  }
  console.log('Loading trade OFI...');
  const data = new Map();
  const rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });
  let headerSkipped = false;
  for await (const line of rl) {
    if (!headerSkipped) { headerSkipped = true; continue; }
    const parts = line.split(',');
    if (parts.length < 11) continue;
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
      largeTradeBuyVol: parseInt(parts[11]) || 0,
      largeTradeSellVol: parseInt(parts[12]) || 0,
      vwap: parseFloat(parts[13]) || 0,
    });
  }
  console.log(`  Loaded ${data.size} OFI records`);
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
    } catch (e) { /* skip corrupt files */ }
  }
  console.log(`  Loaded ${snapshots.size} GEX snapshots`);
  return snapshots;
}

// ============================================================================
// OFI Aggregation
// ============================================================================

/**
 * Aggregate 1m OFI data to a higher timeframe.
 * For sub-minute timeframes, each sub-minute bar maps to its parent minute's OFI.
 */
function aggregateOFI(ofiMap, timeframe) {
  if (!ofiMap) return null;

  const tfMin = TF_MINUTES[timeframe];

  if (tfMin < 1) {
    // Sub-minute: return as-is, caller maps each bar to parent minute
    return ofiMap;
  }

  if (tfMin === 1) {
    return ofiMap;
  }

  // Aggregate to higher timeframes
  const aggregated = new Map();
  const buckets = new Map(); // periodStart -> [ofi records]

  for (const [timestamp, ofi] of ofiMap) {
    const periodMs = tfMin * 60 * 1000;
    const periodStart = Math.floor(timestamp / periodMs) * periodMs;

    if (!buckets.has(periodStart)) buckets.set(periodStart, []);
    buckets.get(periodStart).push(ofi);
  }

  for (const [periodStart, records] of buckets) {
    const agg = {
      buyVolume: 0, sellVolume: 0, netVolume: 0, totalVolume: 0,
      buyTrades: 0, sellTrades: 0, totalTrades: 0,
      largeTradeBuyVol: 0, largeTradeSellVol: 0,
      maxTradeSize: 0, vwap: 0,
    };

    let vwapNumerator = 0;
    for (const r of records) {
      agg.buyVolume += r.buyVolume;
      agg.sellVolume += r.sellVolume;
      agg.netVolume += r.netVolume;
      agg.totalVolume += r.totalVolume;
      agg.buyTrades += r.buyTrades;
      agg.sellTrades += r.sellTrades;
      agg.totalTrades += r.totalTrades;
      agg.largeTradeBuyVol += r.largeTradeBuyVol;
      agg.largeTradeSellVol += r.largeTradeSellVol;
      if (r.maxTradeSize > agg.maxTradeSize) agg.maxTradeSize = r.maxTradeSize;
      vwapNumerator += (r.vwap || 0) * r.totalVolume;
    }

    agg.volumeImbalance = agg.totalVolume > 0 ? agg.netVolume / agg.totalVolume : 0;
    agg.tradeImbalance = agg.totalTrades > 0
      ? (agg.buyTrades - agg.sellTrades) / agg.totalTrades : 0;
    agg.avgTradeSize = agg.totalTrades > 0 ? agg.totalVolume / agg.totalTrades : 0;
    agg.vwap = agg.totalVolume > 0 ? vwapNumerator / agg.totalVolume : 0;

    aggregated.set(periodStart, agg);
  }

  return aggregated;
}

/**
 * Look up OFI for a candle. For sub-minute TFs, map to parent minute.
 */
function getOFI(ofiMap, timestamp, tfMin) {
  if (!ofiMap) return null;
  if (tfMin < 1) {
    // Map to parent minute
    const minuteTs = Math.floor(timestamp / 60000) * 60000;
    return ofiMap.get(minuteTs) || null;
  }
  return ofiMap.get(timestamp) || null;
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

function getGexSupportLevels(gex) {
  if (!gex) return [];
  const levels = [];
  if (activeLevels.includes('put_wall') && gex.put_wall != null) {
    levels.push({ price: gex.put_wall, type: 'put_wall' });
  }
  if (gex.support && Array.isArray(gex.support)) {
    for (let i = 0; i < gex.support.length; i++) {
      const name = `S${i + 1}`;
      if (activeLevels.includes(name) && gex.support[i] != null) {
        levels.push({ price: gex.support[i], type: name });
      }
    }
  }
  return levels;
}

function getSession(timestamp) {
  const date = new Date(timestamp);
  const estString = date.toLocaleString('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric', minute: 'numeric', hour12: false
  });
  const [hourStr, minStr] = estString.split(':');
  const timeDecimal = parseInt(hourStr) + parseInt(minStr) / 60;
  if (timeDecimal >= 18 || timeDecimal < 4) return 'overnight';
  if (timeDecimal >= 4 && timeDecimal < 9.5) return 'premarket';
  if (timeDecimal >= 9.5 && timeDecimal < 16) return 'rth';
  return 'afterhours';
}

// ============================================================================
// Trade Simulation (per timeframe)
// ============================================================================

class TradeManager {
  constructor(timeframe, params) {
    this.timeframe = timeframe;
    this.params = params;
    this.activeTrade = null;
    this.completedTrades = [];
    this.tradeIdCounter = 0;
  }

  hasActivePosition() {
    return this.activeTrade !== null;
  }

  openTrade(signal, candle) {
    this.tradeIdCounter++;
    this.activeTrade = {
      id: this.tradeIdCounter,
      entryPrice: signal.entryPrice,
      stopLoss: signal.stopLoss,
      targetPrice: signal.targetPrice,
      trailingTrigger: signal.trailingTrigger,
      trailingOffset: signal.trailingOffset,
      maxHoldBars: signal.maxHoldBars,
      entryTime: candle.timestamp,
      barsHeld: 0,
      highWaterMark: signal.entryPrice,
      trailingStopActive: false,
      trailingStopLevel: null,
      mfe: 0,
      mae: 0,
      metadata: signal.metadata
    };
    return this.activeTrade;
  }

  updateTrade(candle) {
    if (!this.activeTrade) return null;
    const trade = this.activeTrade;
    trade.barsHeld++;

    const pnlFromHigh = candle.high - trade.entryPrice;
    const pnlFromLow = candle.low - trade.entryPrice;
    if (pnlFromHigh > trade.mfe) trade.mfe = pnlFromHigh;
    if (pnlFromLow < trade.mae) trade.mae = pnlFromLow;

    // Stop loss
    if (candle.low <= trade.stopLoss) {
      return this.closeTrade(trade.stopLoss - this.params.slippage, candle.timestamp, 'stop_loss');
    }

    // Target
    if (candle.high >= trade.targetPrice) {
      return this.closeTrade(trade.targetPrice, candle.timestamp, 'target');
    }

    // Trailing stop
    if (trade.trailingTrigger && trade.trailingOffset) {
      if (candle.high > trade.highWaterMark) trade.highWaterMark = candle.high;
      const profitFromEntry = trade.highWaterMark - trade.entryPrice;
      if (profitFromEntry >= trade.trailingTrigger) {
        trade.trailingStopActive = true;
        const newTS = trade.highWaterMark - trade.trailingOffset;
        if (!trade.trailingStopLevel || newTS > trade.trailingStopLevel) {
          trade.trailingStopLevel = newTS;
        }
      }
      if (trade.trailingStopActive && trade.trailingStopLevel && candle.low <= trade.trailingStopLevel) {
        return this.closeTrade(trade.trailingStopLevel - this.params.slippage, candle.timestamp, 'trailing_stop');
      }
    }

    // Max hold
    if (trade.barsHeld >= trade.maxHoldBars) {
      return this.closeTrade(candle.close, candle.timestamp, 'time_exit');
    }

    return null;
  }

  closeTrade(exitPrice, exitTime, exitReason) {
    const trade = this.activeTrade;
    if (!trade) return null;
    const pointsPnL = exitPrice - trade.entryPrice;
    const completed = {
      id: trade.id,
      timeframe: this.timeframe,
      entryPrice: trade.entryPrice,
      exitPrice,
      pointsPnL,
      dollarPnL_ES: pointsPnL * ES_POINT_VALUE,
      entryTime: new Date(trade.entryTime).toISOString(),
      exitTime: new Date(exitTime).toISOString(),
      barsHeld: trade.barsHeld,
      exitReason,
      mfe: trade.mfe,
      mae: trade.mae,
      metadata: trade.metadata
    };
    this.completedTrades.push(completed);
    this.activeTrade = null;
    return completed;
  }
}

// ============================================================================
// Stop Hunt Detection Engine (runs per timeframe)
// ============================================================================

function runDetection(candles, ofiMap, gexSnapshots, timeframe, params) {
  const tfMin = TF_MINUTES[timeframe];
  const tradeManager = new TradeManager(timeframe, params);
  const pendingHunts = new Map();
  const rollingVolumes = [];
  let signalsGenerated = 0;
  let lastSignalTime = 0;
  const blocked = { regime: 0, position: 0, cooldown: 0, noGex: 0, ofiFilter: 0 };

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];

    // Update active trade
    if (tradeManager.hasActivePosition()) {
      tradeManager.updateTrade(candle);
    }

    // Get volume (prefer OFI, fall back to candle volume)
    const ofi = getOFI(ofiMap, candle.timestamp, tfMin);
    const volume = ofi ? (ofi.totalVolume || candle.volume || 0) : (candle.volume || 0);

    rollingVolumes.push(volume);
    if (rollingVolumes.length > params.volumeLookback) rollingVolumes.shift();
    if (rollingVolumes.length < params.volumeLookback) continue;

    const avgVolume = rollingVolumes.reduce((a, b) => a + b, 0) / rollingVolumes.length;
    if (avgVolume <= 0) continue;

    // GEX snapshot
    const gex = getGexSnapshot(gexSnapshots, candle.timestamp);
    if (!gex) {
      blocked.noGex++;
      // Clean expired hunts
      for (const [key, hunt] of pendingHunts) {
        if (i - hunt.startIdx > params.maxReversalBars) pendingHunts.delete(key);
      }
      continue;
    }

    const regime = gex.regime || 'unknown';

    // Clean expired pending hunts
    for (const [key, hunt] of pendingHunts) {
      if (i - hunt.startIdx > params.maxReversalBars) {
        pendingHunts.delete(key);
      }
    }

    // Check for reversal on pending hunts
    if (!tradeManager.hasActivePosition()) {
      for (const [key, hunt] of pendingHunts) {
        if (candle.low < hunt.penetrationLow) hunt.penetrationLow = candle.low;

        if (candle.close > hunt.level) {
          if (candle.timestamp - lastSignalTime < params.cooldownMs) {
            blocked.cooldown++;
            pendingHunts.delete(key);
            continue;
          }
          if (blockedRegimes.includes(regime)) {
            blocked.regime++;
            pendingHunts.delete(key);
            continue;
          }

          const entryPrice = candle.close + params.slippage;
          const stopPrice = hunt.penetrationLow - params.stopBuffer;

          const signal = {
            entryPrice,
            stopLoss: stopPrice,
            targetPrice: entryPrice + params.targetPoints,
            trailingTrigger: params.trailingTrigger,
            trailingOffset: params.trailingOffset,
            maxHoldBars: params.maxHoldBars,
            metadata: {
              hunted_level: hunt.level,
              level_type: hunt.type,
              penetration_low: hunt.penetrationLow,
              penetration_depth: hunt.level - hunt.penetrationLow,
              risk_points: entryPrice - stopPrice,
              volume_ratio: hunt.volumeRatio,
              max_trade_size: hunt.maxTradeSize || 0,
              regime,
              session: getSession(candle.timestamp),
              bars_to_reversal: i - hunt.startIdx,
              timeframe
            }
          };

          tradeManager.openTrade(signal, candle);
          signalsGenerated++;
          lastSignalTime = candle.timestamp;
          pendingHunts.delete(key);
          break;
        }
      }
    }

    // Skip new detection if position active
    if (tradeManager.hasActivePosition()) continue;

    // Volume burst check
    const volumeRatio = volume / avgVolume;
    if (volumeRatio < params.volumeBurstRatio) continue;

    // Max trade size filter
    if (params.minMaxTradeSize > 0 && ofi) {
      if ((ofi.maxTradeSize || 0) < params.minMaxTradeSize) {
        blocked.ofiFilter++;
        continue;
      }
    }

    // Support levels
    const supportLevels = getGexSupportLevels(gex);
    if (supportLevels.length === 0) continue;

    // Detect new penetrations
    for (const { price: levelPrice, type: levelType } of supportLevels) {
      const penetration = levelPrice - candle.low;
      if (penetration < params.minPenetration) continue;

      const levelKey = `${levelType}_${levelPrice.toFixed(2)}`;
      if (pendingHunts.has(levelKey)) continue;

      // Instant reversal check
      if (candle.close > levelPrice) {
        if (candle.timestamp - lastSignalTime < params.cooldownMs) {
          blocked.cooldown++;
          continue;
        }
        if (blockedRegimes.includes(regime)) {
          blocked.regime++;
          continue;
        }

        const entryPrice = candle.close + params.slippage;
        const stopPrice = candle.low - params.stopBuffer;

        const signal = {
          entryPrice,
          stopLoss: stopPrice,
          targetPrice: entryPrice + params.targetPoints,
          trailingTrigger: params.trailingTrigger,
          trailingOffset: params.trailingOffset,
          maxHoldBars: params.maxHoldBars,
          metadata: {
            hunted_level: levelPrice,
            level_type: levelType,
            penetration_low: candle.low,
            penetration_depth: penetration,
            risk_points: entryPrice - stopPrice,
            volume_ratio: volumeRatio,
            max_trade_size: ofi?.maxTradeSize || 0,
            regime,
            session: getSession(candle.timestamp),
            bars_to_reversal: 0,
            timeframe
          }
        };

        tradeManager.openTrade(signal, candle);
        signalsGenerated++;
        lastSignalTime = candle.timestamp;
        break;
      }

      // Pending hunt
      pendingHunts.set(levelKey, {
        level: levelPrice,
        type: levelType,
        penetrationLow: candle.low,
        volumeRatio,
        maxTradeSize: ofi?.maxTradeSize || 0,
        startIdx: i
      });
    }
  }

  // Close remaining position
  if (tradeManager.hasActivePosition()) {
    const last = candles[candles.length - 1];
    tradeManager.closeTrade(last.close, last.timestamp, 'end_of_data');
  }

  return { trades: tradeManager.completedTrades, signalsGenerated, blocked };
}

// ============================================================================
// Cross-Timeframe Deduplication
// ============================================================================

function deduplicateSignals(allTrades) {
  // Sort all trades by entry time
  const sorted = [...allTrades].sort((a, b) =>
    new Date(a.entryTime).getTime() - new Date(b.entryTime).getTime()
  );

  const OVERLAP_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
  const groups = [];
  let currentGroup = null;

  for (const trade of sorted) {
    const entryMs = new Date(trade.entryTime).getTime();

    if (!currentGroup || entryMs - currentGroup.lastEntryMs > OVERLAP_WINDOW_MS) {
      currentGroup = {
        trades: [trade],
        firstEntryMs: entryMs,
        lastEntryMs: entryMs,
        timeframes: new Set([trade.timeframe])
      };
      groups.push(currentGroup);
    } else {
      currentGroup.trades.push(trade);
      currentGroup.lastEntryMs = entryMs;
      currentGroup.timeframes.add(trade.timeframe);
    }
  }

  return groups;
}

// ============================================================================
// Performance Analysis
// ============================================================================

function analyzePerformance(trades, label) {
  if (trades.length === 0) {
    return { label, totalTrades: 0 };
  }

  const winners = trades.filter(t => t.pointsPnL > 0);
  const losers = trades.filter(t => t.pointsPnL <= 0);
  const totalPnL = trades.reduce((s, t) => s + t.pointsPnL, 0);
  const avgWinner = winners.length > 0 ? winners.reduce((s, t) => s + t.pointsPnL, 0) / winners.length : 0;
  const avgLoser = losers.length > 0 ? losers.reduce((s, t) => s + t.pointsPnL, 0) / losers.length : 0;
  const grossProfit = winners.reduce((s, t) => s + t.pointsPnL, 0);
  const grossLoss = Math.abs(losers.reduce((s, t) => s + t.pointsPnL, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0);

  // Max drawdown
  let peakPnL = 0, maxDrawdown = 0, runningPnL = 0;
  for (const trade of trades) {
    runningPnL += trade.pointsPnL;
    if (runningPnL > peakPnL) peakPnL = runningPnL;
    const dd = peakPnL - runningPnL;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  // Trading days
  const tradeDays = new Set(trades.map(t => t.entryTime.split('T')[0]));
  const totalDays = tradeDays.size || 1;

  // Sharpe
  const dailyPnL = new Map();
  for (const trade of trades) {
    const day = trade.entryTime.split('T')[0];
    dailyPnL.set(day, (dailyPnL.get(day) || 0) + trade.pointsPnL);
  }
  const dailyReturns = [...dailyPnL.values()];
  const avgDaily = dailyReturns.reduce((s, v) => s + v, 0) / dailyReturns.length;
  const stdDaily = Math.sqrt(dailyReturns.reduce((s, v) => s + Math.pow(v - avgDaily, 2), 0) / dailyReturns.length);
  const sharpe = stdDaily > 0 ? (avgDaily / stdDaily) * Math.sqrt(252) : 0;

  // By exit reason
  const byExitReason = {};
  for (const trade of trades) {
    if (!byExitReason[trade.exitReason]) byExitReason[trade.exitReason] = { count: 0, totalPnL: 0, winners: 0 };
    byExitReason[trade.exitReason].count++;
    byExitReason[trade.exitReason].totalPnL += trade.pointsPnL;
    if (trade.pointsPnL > 0) byExitReason[trade.exitReason].winners++;
  }

  // By level type
  const byLevelType = {};
  for (const trade of trades) {
    const lt = trade.metadata.level_type;
    if (!byLevelType[lt]) byLevelType[lt] = { count: 0, totalPnL: 0, winners: 0 };
    byLevelType[lt].count++;
    byLevelType[lt].totalPnL += trade.pointsPnL;
    if (trade.pointsPnL > 0) byLevelType[lt].winners++;
  }

  return {
    label,
    totalTrades: trades.length,
    winRate: (winners.length / trades.length * 100),
    totalPnL_pts: totalPnL,
    totalPnL_ES: totalPnL * ES_POINT_VALUE,
    avgWinner,
    avgLoser,
    profitFactor: profitFactor === Infinity ? 9999 : profitFactor,
    maxDrawdown_pts: maxDrawdown,
    sharpe,
    tradesPerDay: trades.length / totalDays,
    tradingDays: totalDays,
    byExitReason,
    byLevelType
  };
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log('='.repeat(80));
  console.log('ES STOP HUNT MULTI-TIMEFRAME BACKTEST');
  console.log('='.repeat(80));
  console.log(`Date range: ${config.startDate} to ${config.endDate}`);
  console.log(`Timeframes: ${config.timeframes.join(', ')}`);
  console.log(`Levels: ${config.levelFilter} (${activeLevels.join(', ')})`);
  console.log(`Regime filter: ${config.regimeFilter}`);
  console.log();

  // Print scaled parameters table
  console.log('Parameter Scaling (sqrt from 1m baseline):');
  console.log('-'.repeat(80));
  console.log('TF     | Penetration | Stop Buf | Trail Trig/Off | Target | Max Hold | Hold Time');
  console.log('-'.repeat(80));
  for (const tf of config.timeframes) {
    const p = scaleParams(tf);
    const holdMinutes = (p.maxHoldBars * TF_MINUTES[tf]).toFixed(0);
    console.log(`${tf.padEnd(6)} | ${p.minPenetration.toString().padEnd(11)} | ${p.stopBuffer.toString().padEnd(8)} | ${p.trailingTrigger}/${p.trailingOffset.toString().padEnd(10)} | ${p.targetPoints.toString().padEnd(6)} | ${p.maxHoldBars.toString().padEnd(8)} | ${holdMinutes}min`);
  }
  console.log();

  // Determine which data sources we need
  const needSubMinute = config.timeframes.some(tf => SUB_MINUTE_TFS.includes(tf));
  const needMinutePlus = config.timeframes.some(tf => MINUTE_PLUS_TFS.includes(tf));
  const requestedSubMinute = config.timeframes.filter(tf => SUB_MINUTE_TFS.includes(tf));
  const requestedMinutePlus = config.timeframes.filter(tf => MINUTE_PLUS_TFS.includes(tf));

  // Load shared data
  const [ofiRaw, gexSnapshots] = await Promise.all([
    loadTradeOFI(),
    loadGEXData()
  ]);

  if (gexSnapshots.size === 0) {
    console.error('No GEX data loaded. Exiting.');
    process.exit(1);
  }

  // Load and process minute-plus timeframes
  let candles1m = null;
  if (needMinutePlus) {
    candles1m = await loadOHLCV1m();
    if (candles1m.length === 0) {
      console.error('No 1m candle data loaded. Exiting.');
      process.exit(1);
    }
  }

  // Load and process sub-minute timeframes
  let subMinuteCandles = null;
  if (needSubMinute) {
    subMinuteCandles = await loadAndAggregate1s(requestedSubMinute);
  }

  console.log('\n' + '='.repeat(80));
  console.log('RUNNING DETECTION PER TIMEFRAME');
  console.log('='.repeat(80));

  const allResults = {};
  const allTrades = [];

  // Run minute-plus timeframes
  if (needMinutePlus) {
    const aggregator = new CandleAggregator();

    for (const tf of requestedMinutePlus) {
      const params = scaleParams(tf);
      const ofiAgg = aggregateOFI(ofiRaw, tf);

      let candles;
      if (tf === '1m') {
        candles = candles1m;
      } else {
        candles = aggregator.aggregate(candles1m, tf, { silent: true });
      }

      console.log(`\n--- ${tf} (${candles.length} candles, params: pen=${params.minPenetration}, trail=${params.trailingTrigger}/${params.trailingOffset}, target=${params.targetPoints}) ---`);

      const result = runDetection(candles, ofiAgg, gexSnapshots, tf, params);
      allResults[tf] = result;
      allTrades.push(...result.trades);

      const perf = analyzePerformance(result.trades, tf);
      console.log(`  Trades: ${perf.totalTrades} | Win Rate: ${perf.winRate?.toFixed(1) || 0}% | P&L: ${perf.totalPnL_pts?.toFixed(1) || 0} pts ($${perf.totalPnL_ES?.toFixed(0) || 0}) | PF: ${perf.profitFactor?.toFixed(2) || 0} | Sharpe: ${perf.sharpe?.toFixed(2) || 0}`);
      console.log(`  Signals: ${result.signalsGenerated} | Blocked: regime=${result.blocked.regime}, cooldown=${result.blocked.cooldown}, noGex=${result.blocked.noGex}, ofiFilter=${result.blocked.ofiFilter}`);
    }
  }

  // Run sub-minute timeframes
  if (needSubMinute && subMinuteCandles) {
    for (const tf of requestedSubMinute) {
      if (!subMinuteCandles[tf] || subMinuteCandles[tf].length === 0) {
        console.log(`\n--- ${tf}: No data available ---`);
        continue;
      }

      const params = scaleParams(tf);
      // Sub-minute uses parent-minute OFI mapping (handled inside getOFI)
      const ofiAgg = ofiRaw; // pass raw 1m OFI, getOFI maps to parent minute

      const candles = subMinuteCandles[tf];
      console.log(`\n--- ${tf} (${candles.length} candles, params: pen=${params.minPenetration}, trail=${params.trailingTrigger}/${params.trailingOffset}, target=${params.targetPoints}) ---`);

      const result = runDetection(candles, ofiAgg, gexSnapshots, tf, params);
      allResults[tf] = result;
      allTrades.push(...result.trades);

      const perf = analyzePerformance(result.trades, tf);
      console.log(`  Trades: ${perf.totalTrades} | Win Rate: ${perf.winRate?.toFixed(1) || 0}% | P&L: ${perf.totalPnL_pts?.toFixed(1) || 0} pts ($${perf.totalPnL_ES?.toFixed(0) || 0}) | PF: ${perf.profitFactor?.toFixed(2) || 0} | Sharpe: ${perf.sharpe?.toFixed(2) || 0}`);
      console.log(`  Signals: ${result.signalsGenerated} | Blocked: regime=${result.blocked.regime}, cooldown=${result.blocked.cooldown}, noGex=${result.blocked.noGex}, ofiFilter=${result.blocked.ofiFilter}`);
    }
  }

  // ============================================================================
  // Cross-Timeframe Analysis
  // ============================================================================

  console.log('\n' + '='.repeat(80));
  console.log('CROSS-TIMEFRAME ANALYSIS');
  console.log('='.repeat(80));

  // Deduplication
  const groups = deduplicateSignals(allTrades);
  const uniqueEvents = groups.length;
  const multiTfEvents = groups.filter(g => g.timeframes.size > 1).length;

  console.log(`\nTotal trades across all TFs: ${allTrades.length}`);
  console.log(`Unique events (15min dedup): ${uniqueEvents}`);
  console.log(`Multi-TF events (detected on 2+ TFs): ${multiTfEvents}`);

  // Per-timeframe unique signals (not overlapping with other TFs)
  const tfOnlyEvents = {};
  for (const tf of config.timeframes) {
    tfOnlyEvents[tf] = groups.filter(g => g.timeframes.has(tf) && g.timeframes.size === 1).length;
  }

  console.log('\nUnique-to-TF events (not detected on other TFs):');
  for (const tf of config.timeframes) {
    const totalForTf = allResults[tf]?.trades?.length || 0;
    console.log(`  ${tf}: ${tfOnlyEvents[tf]} unique / ${totalForTf} total`);
  }

  // Combined performance (best trade from each group)
  const dedupedTrades = groups.map(g => {
    // Pick the trade with the best P&L from overlapping events
    return g.trades.reduce((best, t) => t.pointsPnL > best.pointsPnL ? t : best, g.trades[0]);
  });
  const combinedPerf = analyzePerformance(dedupedTrades, 'Combined (deduped)');

  // ============================================================================
  // Summary Table
  // ============================================================================

  console.log('\n' + '='.repeat(80));
  console.log('SUMMARY');
  console.log('='.repeat(80));

  console.log('\n' + '-'.repeat(100));
  console.log(`${'TF'.padEnd(6)} | ${'Trades'.padEnd(7)} | ${'WR'.padEnd(6)} | ${'PnL (pts)'.padEnd(10)} | ${'PnL ($)'.padEnd(10)} | ${'Avg W'.padEnd(7)} | ${'Avg L'.padEnd(7)} | ${'PF'.padEnd(6)} | ${'MaxDD'.padEnd(7)} | ${'Sharpe'.padEnd(7)} | ${'Trades/Day'.padEnd(10)}`);
  console.log('-'.repeat(100));

  for (const tf of config.timeframes) {
    const trades = allResults[tf]?.trades || [];
    const perf = analyzePerformance(trades, tf);
    if (perf.totalTrades === 0) {
      console.log(`${tf.padEnd(6)} | ${'0'.padEnd(7)} | ${'N/A'.padEnd(6)} | ${'0'.padEnd(10)} | ${'$0'.padEnd(10)} | ${'N/A'.padEnd(7)} | ${'N/A'.padEnd(7)} | ${'N/A'.padEnd(6)} | ${'N/A'.padEnd(7)} | ${'N/A'.padEnd(7)} | ${'0'.padEnd(10)}`);
    } else {
      console.log(`${tf.padEnd(6)} | ${perf.totalTrades.toString().padEnd(7)} | ${perf.winRate.toFixed(1).padEnd(5)}% | ${perf.totalPnL_pts.toFixed(1).padEnd(10)} | ${'$' + perf.totalPnL_ES.toFixed(0).padEnd(9)} | ${perf.avgWinner.toFixed(1).padEnd(7)} | ${perf.avgLoser.toFixed(1).padEnd(7)} | ${perf.profitFactor.toFixed(2).padEnd(6)} | ${perf.maxDrawdown_pts.toFixed(1).padEnd(7)} | ${perf.sharpe.toFixed(2).padEnd(7)} | ${perf.tradesPerDay.toFixed(2).padEnd(10)}`);
    }
  }

  // Combined row
  if (config.timeframes.length > 1) {
    console.log('-'.repeat(100));
    const cp = combinedPerf;
    if (cp.totalTrades > 0) {
      console.log(`${'COMB'.padEnd(6)} | ${cp.totalTrades.toString().padEnd(7)} | ${cp.winRate.toFixed(1).padEnd(5)}% | ${cp.totalPnL_pts.toFixed(1).padEnd(10)} | ${'$' + cp.totalPnL_ES.toFixed(0).padEnd(9)} | ${cp.avgWinner.toFixed(1).padEnd(7)} | ${cp.avgLoser.toFixed(1).padEnd(7)} | ${cp.profitFactor.toFixed(2).padEnd(6)} | ${cp.maxDrawdown_pts.toFixed(1).padEnd(7)} | ${cp.sharpe.toFixed(2).padEnd(7)} | ${cp.tradesPerDay.toFixed(2).padEnd(10)}`);
    }
  }
  console.log('-'.repeat(100));

  // Exit reason breakdown per TF
  console.log('\n--- Exit Reason Breakdown ---');
  for (const tf of config.timeframes) {
    const perf = analyzePerformance(allResults[tf]?.trades || [], tf);
    if (perf.totalTrades === 0) continue;
    console.log(`  ${tf}:`);
    for (const [reason, data] of Object.entries(perf.byExitReason).sort((a, b) => b[1].count - a[1].count)) {
      console.log(`    ${reason.padEnd(16)} n=${data.count}, P&L=${data.totalPnL.toFixed(1)}pts, win=${(data.winners / data.count * 100).toFixed(0)}%`);
    }
  }

  // Level type breakdown per TF
  console.log('\n--- Level Type Breakdown ---');
  for (const tf of config.timeframes) {
    const perf = analyzePerformance(allResults[tf]?.trades || [], tf);
    if (perf.totalTrades === 0) continue;
    console.log(`  ${tf}:`);
    for (const [lt, data] of Object.entries(perf.byLevelType).sort((a, b) => b[1].count - a[1].count)) {
      console.log(`    ${lt.padEnd(12)} n=${data.count}, P&L=${data.totalPnL.toFixed(1)}pts, win=${(data.winners / data.count * 100).toFixed(0)}%`);
    }
  }

  // ============================================================================
  // Write results to file
  // ============================================================================

  const outputPath = config.output || `results/es-orderflow/stop-hunt-multi-tf-${config.timeframes.join('-')}.json`;
  const outputData = {
    config,
    parameterScaling: {},
    perTimeframe: {},
    crossTimeframe: {
      totalTrades: allTrades.length,
      uniqueEvents,
      multiTfEvents,
      uniqueByTf: tfOnlyEvents,
      combinedPerformance: combinedPerf
    },
    allTrades: allTrades.map(t => ({
      ...t,
      pointsPnL: parseFloat(t.pointsPnL.toFixed(2)),
      dollarPnL_ES: parseFloat(t.dollarPnL_ES.toFixed(2)),
      mfe: parseFloat(t.mfe.toFixed(2)),
      mae: parseFloat(t.mae.toFixed(2)),
      metadata: {
        ...t.metadata,
        hunted_level: parseFloat(t.metadata.hunted_level?.toFixed(2)),
        penetration_depth: parseFloat(t.metadata.penetration_depth?.toFixed(2)),
        risk_points: parseFloat(t.metadata.risk_points?.toFixed(2)),
        volume_ratio: parseFloat(t.metadata.volume_ratio?.toFixed(2))
      }
    }))
  };

  for (const tf of config.timeframes) {
    outputData.parameterScaling[tf] = scaleParams(tf);
    const trades = allResults[tf]?.trades || [];
    outputData.perTimeframe[tf] = {
      ...analyzePerformance(trades, tf),
      signalsGenerated: allResults[tf]?.signalsGenerated || 0,
      blocked: allResults[tf]?.blocked || {}
    };
  }

  const outDir = path.dirname(path.resolve(outputPath));
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.resolve(outputPath), JSON.stringify(outputData, null, 2));
  console.log(`\nResults written to ${outputPath}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
