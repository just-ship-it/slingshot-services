#!/usr/bin/env node
/**
 * ES Stop Hunt Strategy Backtest
 *
 * Full simulation with realistic order management: entries, stops, trailing stops,
 * time exits, and position tracking. Validates the stop hunt reversal edge with
 * actual trade mechanics (not just forward returns).
 *
 * Loads:
 * - ES OHLCV 1m data (with primary contract filtering)
 * - ES GEX intraday JSON (15-min snapshots)
 * - Trade OFI 1m data (for volume analysis)
 *
 * Usage:
 *   node scripts/es-stop-hunt-strategy-backtest.js [options]
 *
 *   --start        Start date (default: 2025-01-01)
 *   --end          End date (default: 2026-01-31)
 *   --stop-buffer  Points below extension low for stop (default: 1)
 *   --trail-trigger Points profit to activate trailing (default: 5)
 *   --trail-offset  Trailing stop distance in points (default: 4)
 *   --max-hold     Max hold in minutes (default: 60)
 *   --regime-filter all|exclude_strong|exclude_strong_neg_only (default: exclude_strong)
 *   --levels       tier1|all (default: all)
 *   --output       Output file path
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';

const args = process.argv.slice(2);
const getArg = (name, defaultValue) => {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 ? args[idx + 1] : defaultValue;
};

// Configuration
const config = {
  startDate: getArg('start', '2025-01-01'),
  endDate: getArg('end', '2026-01-31'),
  stopBuffer: parseFloat(getArg('stop-buffer', '1')),
  trailingTrigger: parseFloat(getArg('trail-trigger', '5')),
  trailingOffset: parseFloat(getArg('trail-offset', '4')),
  maxHoldBars: parseInt(getArg('max-hold', '60')),
  regimeFilter: getArg('regime-filter', 'exclude_strong'),
  levelFilter: getArg('levels', 'all'),
  minPenetration: parseFloat(getArg('min-penetration', '3.5')),
  volumeBurstRatio: parseFloat(getArg('volume-ratio', '2.0')),
  minMaxTradeSize: parseInt(getArg('min-max-trade', '50')),
  maxReversalBars: parseInt(getArg('max-reversal', '5')),
  slippage: parseFloat(getArg('slippage', '0.25')),
  targetPoints: parseFloat(getArg('target', '20')),
  output: getArg('output', 'results/es-orderflow/stop-hunt-strategy-backtest.json')
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

// Contract specs for P&L
const ES_POINT_VALUE = 50;   // $50 per point for ES
const MES_POINT_VALUE = 5;   // $5 per point for MES

console.log('='.repeat(80));
console.log('ES STOP HUNT STRATEGY BACKTEST');
console.log('='.repeat(80));
console.log(`Date range: ${config.startDate} to ${config.endDate}`);
console.log(`Levels: ${config.levelFilter} (${activeLevels.join(', ')})`);
console.log(`Regime filter: ${config.regimeFilter} (blocked: ${blockedRegimes.join(', ') || 'none'})`);
console.log(`Stop buffer: ${config.stopBuffer} pts | Trail: ${config.trailingTrigger}/${config.trailingOffset} pts`);
console.log(`Max hold: ${config.maxHoldBars} bars | Target: ${config.targetPoints} pts`);
console.log(`Slippage: ${config.slippage} pts | Volume ratio: ${config.volumeBurstRatio}x | Min max trade: ${config.minMaxTradeSize}`);
console.log();

// ============================================================================
// Data Loading (reused from stop-hunt-detection.js patterns)
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
  console.log('Loading OHLCV data...');
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
    if (symbol && symbol.includes('-')) continue; // Filter calendar spreads
    const open = parseFloat(parts[4]);
    const high = parseFloat(parts[5]);
    const low = parseFloat(parts[6]);
    const close = parseFloat(parts[7]);
    const volume = parseInt(parts[8]);
    if (open === high && high === low && low === close) continue; // Filter doji-zero bars
    candles.push({ timestamp, open, high, low, close, volume, symbol });
  }
  candles.sort((a, b) => a.timestamp - b.timestamp);
  const filtered = filterPrimaryContract(candles);
  console.log(`  Loaded ${filtered.length} candles (${candles.length - filtered.length} secondary contract bars removed)`);
  return filtered;
}

async function loadTradeOFI() {
  const filePath = path.join(dataDir, 'orderflow/es/trade-ofi-1m.csv');
  if (!fs.existsSync(filePath)) {
    console.log('  No trade OFI file found, using OHLCV volume instead');
    return null;
  }
  console.log('Loading trade OFI...');
  const data = new Map();
  const rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });
  let headerSkipped = false;
  for await (const line of rl) {
    if (!headerSkipped) { headerSkipped = true; continue; }
    const parts = line.split(',');
    if (parts.length < 5) continue;
    const timestamp = new Date(parts[0]).getTime();
    if (timestamp < startDate.getTime() || timestamp > endDate.getTime()) continue;
    data.set(timestamp, {
      totalVolume: parseInt(parts[4]),
      buyVolume: parseInt(parts[1]),
      sellVolume: parseInt(parts[2]),
      netVolume: parseInt(parts[3]),
      maxTradeSize: parseInt(parts[10]) || 0
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
// Helpers
// ============================================================================

function getGexSnapshot(gexSnapshots, timestamp) {
  // Find the most recent GEX snapshot at or before this timestamp
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
    hour: 'numeric',
    minute: 'numeric',
    hour12: false
  });
  const [hourStr, minStr] = estString.split(':');
  const timeDecimal = parseInt(hourStr) + parseInt(minStr) / 60;
  if (timeDecimal >= 18 || timeDecimal < 4) return 'overnight';
  if (timeDecimal >= 4 && timeDecimal < 9.5) return 'premarket';
  if (timeDecimal >= 9.5 && timeDecimal < 16) return 'rth';
  return 'afterhours';
}

// ============================================================================
// Trade Simulation Engine
// ============================================================================

class TradeManager {
  constructor() {
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
      entryBar: 0,
      barsHeld: 0,
      highWaterMark: signal.entryPrice,
      trailingStopActive: false,
      trailingStopLevel: null,
      mfe: 0,   // Maximum Favorable Excursion
      mae: 0,   // Maximum Adverse Excursion
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

    // Update MFE/MAE
    if (pnlFromHigh > trade.mfe) trade.mfe = pnlFromHigh;
    if (pnlFromLow < trade.mae) trade.mae = pnlFromLow;

    // Check stop loss (hit if low <= stop)
    if (candle.low <= trade.stopLoss) {
      return this.closeTrade(trade.stopLoss - config.slippage, candle.timestamp, 'stop_loss');
    }

    // Check target (hit if high >= target)
    if (candle.high >= trade.targetPrice) {
      return this.closeTrade(trade.targetPrice, candle.timestamp, 'target');
    }

    // Update trailing stop
    if (trade.trailingTrigger && trade.trailingOffset) {
      if (candle.high > trade.highWaterMark) {
        trade.highWaterMark = candle.high;
      }

      const profitFromEntry = trade.highWaterMark - trade.entryPrice;

      if (profitFromEntry >= trade.trailingTrigger) {
        trade.trailingStopActive = true;
        const newTrailingStop = trade.highWaterMark - trade.trailingOffset;

        // Only move trailing stop up, never down
        if (!trade.trailingStopLevel || newTrailingStop > trade.trailingStopLevel) {
          trade.trailingStopLevel = newTrailingStop;
        }
      }

      // Check trailing stop hit
      if (trade.trailingStopActive && trade.trailingStopLevel && candle.low <= trade.trailingStopLevel) {
        return this.closeTrade(trade.trailingStopLevel - config.slippage, candle.timestamp, 'trailing_stop');
      }
    }

    // Check max hold time exit
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
      entryPrice: trade.entryPrice,
      exitPrice,
      pointsPnL,
      dollarPnL_ES: pointsPnL * ES_POINT_VALUE,
      dollarPnL_MES: pointsPnL * MES_POINT_VALUE,
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
// Main Backtest
// ============================================================================

async function main() {
  const [candles, tradeOFI, gexSnapshots] = await Promise.all([
    loadOHLCVData(),
    loadTradeOFI(),
    loadGEXData()
  ]);

  if (candles.length === 0) {
    console.error('No candle data loaded. Exiting.');
    process.exit(1);
  }
  if (gexSnapshots.size === 0) {
    console.error('No GEX data loaded. Exiting.');
    process.exit(1);
  }

  console.log('\nRunning strategy simulation...\n');

  const tradeManager = new TradeManager();
  const pendingHunts = new Map();  // levelKey -> { level, type, penetrationLow, volumeRatio, startIdx }
  const rollingVolumes = [];
  const VOLUME_LOOKBACK = 20;

  let signalsGenerated = 0;
  let signalsBlocked = { regime: 0, position: 0, cooldown: 0, noGex: 0 };
  let lastSignalTime = 0;
  const COOLDOWN_MS = 5 * 60 * 1000;

  const progressInterval = Math.floor(candles.length / 20);

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];

    // Progress
    if (i > 0 && i % progressInterval === 0) {
      const pct = ((i / candles.length) * 100).toFixed(0);
      const trades = tradeManager.completedTrades.length;
      process.stdout.write(`\r  ${pct}% complete | ${trades} trades | ${signalsGenerated} signals`);
    }

    // Update active trade first
    if (tradeManager.hasActivePosition()) {
      tradeManager.updateTrade(candle);
    }

    // Get volume (prefer OFI, fall back to OHLCV)
    const volume = tradeOFI
      ? (tradeOFI.get(candle.timestamp)?.totalVolume || candle.volume || 0)
      : (candle.volume || 0);

    rollingVolumes.push(volume);
    if (rollingVolumes.length > VOLUME_LOOKBACK) rollingVolumes.shift();

    // Need enough data for rolling average
    if (rollingVolumes.length < VOLUME_LOOKBACK) continue;

    const avgVolume = rollingVolumes.reduce((a, b) => a + b, 0) / rollingVolumes.length;
    if (avgVolume <= 0) continue;

    // Get GEX snapshot
    const gex = getGexSnapshot(gexSnapshots, candle.timestamp);
    if (!gex) {
      signalsBlocked.noGex++;
      // Clean expired pending hunts even without GEX
      for (const [key, hunt] of pendingHunts) {
        if (i - hunt.startIdx > config.maxReversalBars) pendingHunts.delete(key);
      }
      continue;
    }

    const regime = gex.regime || 'unknown';

    // Clean expired pending hunts
    for (const [key, hunt] of pendingHunts) {
      if (i - hunt.startIdx > config.maxReversalBars) {
        pendingHunts.delete(key);
      }
    }

    // Check for reversal on pending hunts
    if (!tradeManager.hasActivePosition()) {
      for (const [key, hunt] of pendingHunts) {
        // Update extension low
        if (candle.low < hunt.penetrationLow) {
          hunt.penetrationLow = candle.low;
        }

        // Check reversal: close back above the hunted level
        if (candle.close > hunt.level) {
          // Cooldown check
          if (candle.timestamp - lastSignalTime < COOLDOWN_MS) {
            signalsBlocked.cooldown++;
            pendingHunts.delete(key);
            continue;
          }

          // Regime check (check current regime, not regime at penetration time)
          if (blockedRegimes.includes(regime)) {
            signalsBlocked.regime++;
            pendingHunts.delete(key);
            continue;
          }

          const entryPrice = candle.close + config.slippage;
          const stopPrice = hunt.penetrationLow - config.stopBuffer;
          const risk = entryPrice - stopPrice;

          const signal = {
            entryPrice,
            stopLoss: stopPrice,
            targetPrice: entryPrice + config.targetPoints,
            trailingTrigger: config.trailingTrigger,
            trailingOffset: config.trailingOffset,
            maxHoldBars: config.maxHoldBars,
            metadata: {
              hunted_level: hunt.level,
              level_type: hunt.type,
              penetration_low: hunt.penetrationLow,
              penetration_depth: hunt.level - hunt.penetrationLow,
              risk_points: risk,
              volume_ratio: hunt.volumeRatio,
              regime,
              session: getSession(candle.timestamp),
              bars_to_reversal: i - hunt.startIdx
            }
          };

          tradeManager.openTrade(signal, candle);
          signalsGenerated++;
          lastSignalTime = candle.timestamp;
          pendingHunts.delete(key);
          break; // One signal per bar
        }
      }
    }

    // Skip new detection if we have a position or just entered one
    if (tradeManager.hasActivePosition()) continue;

    // Volume burst check
    const volumeRatio = volume / avgVolume;
    if (volumeRatio < config.volumeBurstRatio) continue;

    // Max trade size filter (institutional activity proxy)
    if (config.minMaxTradeSize > 0 && tradeOFI) {
      const ofiRecord = tradeOFI.get(candle.timestamp);
      if (ofiRecord && (ofiRecord.maxTradeSize || 0) < config.minMaxTradeSize) continue;
    }

    // Get support levels
    const supportLevels = getGexSupportLevels(gex);
    if (supportLevels.length === 0) continue;

    // Detect new penetrations
    for (const { price: levelPrice, type: levelType } of supportLevels) {
      const penetration = levelPrice - candle.low;
      if (penetration < config.minPenetration) continue;

      const levelKey = `${levelType}_${levelPrice.toFixed(2)}`;
      if (pendingHunts.has(levelKey)) continue;

      // Check if instant reversal (close > level on same bar)
      if (candle.close > levelPrice) {
        // Cooldown check
        if (candle.timestamp - lastSignalTime < COOLDOWN_MS) {
          signalsBlocked.cooldown++;
          continue;
        }
        // Regime check
        if (blockedRegimes.includes(regime)) {
          signalsBlocked.regime++;
          continue;
        }

        const entryPrice = candle.close + config.slippage;
        const stopPrice = candle.low - config.stopBuffer;

        const signal = {
          entryPrice,
          stopLoss: stopPrice,
          targetPrice: entryPrice + config.targetPoints,
          trailingTrigger: config.trailingTrigger,
          trailingOffset: config.trailingOffset,
          maxHoldBars: config.maxHoldBars,
          metadata: {
            hunted_level: levelPrice,
            level_type: levelType,
            penetration_low: candle.low,
            penetration_depth: penetration,
            risk_points: entryPrice - stopPrice,
            volume_ratio: volumeRatio,
            regime,
            session: getSession(candle.timestamp),
            bars_to_reversal: 0
          }
        };

        tradeManager.openTrade(signal, candle);
        signalsGenerated++;
        lastSignalTime = candle.timestamp;
        break;
      }

      // No instant reversal — track as pending hunt
      pendingHunts.set(levelKey, {
        level: levelPrice,
        type: levelType,
        penetrationLow: candle.low,
        volumeRatio,
        startIdx: i
      });
    }
  }

  // Close any remaining position at the last candle
  if (tradeManager.hasActivePosition()) {
    const lastCandle = candles[candles.length - 1];
    tradeManager.closeTrade(lastCandle.close, lastCandle.timestamp, 'end_of_data');
  }

  process.stdout.write('\r' + ' '.repeat(80) + '\r');
  console.log('Simulation complete.\n');

  // ============================================================================
  // Performance Analysis
  // ============================================================================

  const trades = tradeManager.completedTrades;
  const winners = trades.filter(t => t.pointsPnL > 0);
  const losers = trades.filter(t => t.pointsPnL <= 0);

  const totalPnL = trades.reduce((s, t) => s + t.pointsPnL, 0);
  const totalDollarPnL_ES = trades.reduce((s, t) => s + t.dollarPnL_ES, 0);
  const avgWinner = winners.length > 0 ? winners.reduce((s, t) => s + t.pointsPnL, 0) / winners.length : 0;
  const avgLoser = losers.length > 0 ? losers.reduce((s, t) => s + t.pointsPnL, 0) / losers.length : 0;
  const profitFactor = losers.length > 0 && avgLoser !== 0
    ? Math.abs(winners.reduce((s, t) => s + t.pointsPnL, 0) / losers.reduce((s, t) => s + t.pointsPnL, 0))
    : Infinity;

  // Max drawdown
  let peakPnL = 0, maxDrawdown = 0, runningPnL = 0;
  const equityCurve = [0];
  for (const trade of trades) {
    runningPnL += trade.pointsPnL;
    equityCurve.push(runningPnL);
    if (runningPnL > peakPnL) peakPnL = runningPnL;
    const dd = peakPnL - runningPnL;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  // Trading days
  const tradeDays = new Set(trades.map(t => t.entryTime.split('T')[0]));
  const totalDays = tradeDays.size || 1;

  // Sharpe ratio (approximate: daily P&L)
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
    if (!byExitReason[trade.exitReason]) {
      byExitReason[trade.exitReason] = { count: 0, totalPnL: 0, winners: 0 };
    }
    byExitReason[trade.exitReason].count++;
    byExitReason[trade.exitReason].totalPnL += trade.pointsPnL;
    if (trade.pointsPnL > 0) byExitReason[trade.exitReason].winners++;
  }

  // By level type
  const byLevelType = {};
  for (const trade of trades) {
    const lt = trade.metadata.level_type;
    if (!byLevelType[lt]) {
      byLevelType[lt] = { count: 0, totalPnL: 0, winners: 0, avgPnL: 0, avgRisk: 0 };
    }
    byLevelType[lt].count++;
    byLevelType[lt].totalPnL += trade.pointsPnL;
    byLevelType[lt].avgRisk += trade.metadata.risk_points;
    if (trade.pointsPnL > 0) byLevelType[lt].winners++;
  }
  for (const lt of Object.keys(byLevelType)) {
    byLevelType[lt].avgPnL = byLevelType[lt].totalPnL / byLevelType[lt].count;
    byLevelType[lt].avgRisk = byLevelType[lt].avgRisk / byLevelType[lt].count;
    byLevelType[lt].winRate = (byLevelType[lt].winners / byLevelType[lt].count * 100).toFixed(1) + '%';
  }

  // By regime
  const byRegime = {};
  for (const trade of trades) {
    const r = trade.metadata.regime;
    if (!byRegime[r]) { byRegime[r] = { count: 0, totalPnL: 0, winners: 0 }; }
    byRegime[r].count++;
    byRegime[r].totalPnL += trade.pointsPnL;
    if (trade.pointsPnL > 0) byRegime[r].winners++;
  }

  // By session
  const bySession = {};
  for (const trade of trades) {
    const s = trade.metadata.session;
    if (!bySession[s]) { bySession[s] = { count: 0, totalPnL: 0, winners: 0 }; }
    bySession[s].count++;
    bySession[s].totalPnL += trade.pointsPnL;
    if (trade.pointsPnL > 0) bySession[s].winners++;
  }

  // ============================================================================
  // Output
  // ============================================================================

  console.log('='.repeat(80));
  console.log('RESULTS');
  console.log('='.repeat(80));
  console.log();
  console.log(`Total Trades:     ${trades.length}`);
  console.log(`Win Rate:         ${trades.length > 0 ? (winners.length / trades.length * 100).toFixed(1) : 0}%`);
  console.log(`Total P&L:        ${totalPnL.toFixed(2)} pts ($${totalDollarPnL_ES.toFixed(0)} on 1 ES)`);
  console.log(`Avg Winner:       ${avgWinner.toFixed(2)} pts`);
  console.log(`Avg Loser:        ${avgLoser.toFixed(2)} pts`);
  console.log(`Profit Factor:    ${profitFactor === Infinity ? 'Inf' : profitFactor.toFixed(2)}`);
  console.log(`Max Drawdown:     ${maxDrawdown.toFixed(2)} pts ($${(maxDrawdown * ES_POINT_VALUE).toFixed(0)} on 1 ES)`);
  console.log(`Sharpe Ratio:     ${sharpe.toFixed(2)}`);
  console.log(`Trades/Day:       ${(trades.length / totalDays).toFixed(2)}`);
  console.log(`Avg P&L/Day:      ${(totalPnL / totalDays).toFixed(2)} pts ($${(totalDollarPnL_ES / totalDays).toFixed(0)} on 1 ES)`);
  console.log();

  console.log('--- By Exit Reason ---');
  for (const [reason, data] of Object.entries(byExitReason).sort((a, b) => b[1].count - a[1].count)) {
    console.log(`  ${reason.padEnd(16)} n=${data.count}, P&L=${data.totalPnL.toFixed(1)}pts, win=${(data.winners / data.count * 100).toFixed(0)}%`);
  }
  console.log();

  console.log('--- By Level Type ---');
  for (const [lt, data] of Object.entries(byLevelType).sort((a, b) => b[1].count - a[1].count)) {
    console.log(`  ${lt.padEnd(12)} n=${data.count}, P&L=${data.totalPnL.toFixed(1)}pts, avg=${data.avgPnL.toFixed(1)}pts, win=${data.winRate}, avgRisk=${data.avgRisk.toFixed(1)}pts`);
  }
  console.log();

  console.log('--- By Regime ---');
  for (const [r, data] of Object.entries(byRegime).sort((a, b) => b[1].count - a[1].count)) {
    console.log(`  ${r.padEnd(18)} n=${data.count}, P&L=${data.totalPnL.toFixed(1)}pts, win=${(data.winners / data.count * 100).toFixed(0)}%`);
  }
  console.log();

  console.log('--- By Session ---');
  for (const [s, data] of Object.entries(bySession).sort((a, b) => b[1].count - a[1].count)) {
    console.log(`  ${s.padEnd(14)} n=${data.count}, P&L=${data.totalPnL.toFixed(1)}pts, win=${(data.winners / data.count * 100).toFixed(0)}%`);
  }
  console.log();

  console.log(`Signals generated: ${signalsGenerated}`);
  console.log(`Signals blocked:   regime=${signalsBlocked.regime}, position=${signalsBlocked.position}, cooldown=${signalsBlocked.cooldown}, noGex=${signalsBlocked.noGex}`);

  // Write results
  const results = {
    config,
    summary: {
      totalTrades: trades.length,
      winRate: trades.length > 0 ? (winners.length / trades.length * 100) : 0,
      totalPnL_pts: totalPnL,
      totalPnL_ES: totalDollarPnL_ES,
      avgWinner: avgWinner,
      avgLoser: avgLoser,
      profitFactor: profitFactor === Infinity ? 9999 : profitFactor,
      maxDrawdown_pts: maxDrawdown,
      maxDrawdown_ES: maxDrawdown * ES_POINT_VALUE,
      sharpeRatio: sharpe,
      tradesPerDay: trades.length / totalDays,
      avgPnLPerDay_pts: totalPnL / totalDays,
      tradingDays: totalDays,
      signalsGenerated,
      signalsBlocked
    },
    byExitReason,
    byLevelType,
    byRegime,
    bySession,
    trades: trades.map(t => ({
      ...t,
      // Round for readability
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

  const outDir = path.dirname(path.resolve(config.output));
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.resolve(config.output), JSON.stringify(results, null, 2));
  console.log(`\nResults written to ${config.output}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
