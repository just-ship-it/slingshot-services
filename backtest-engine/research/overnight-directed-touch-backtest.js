/**
 * Overnight Directed Touch Strategy Backtest
 *
 * Hypothesis: Combining directional bias (LT sentiment + GEX regime) with
 * precision level entries (first GEX support/resistance touches) should yield
 * 80%+ win rate with tight stops.
 *
 * Approach:
 * - Determine overnight direction from EOD LT sentiment + GEX regime
 * - Only take GEX level touches in the favored direction
 * - BULLISH bias → only long at support levels (S1, S2)
 * - BEARISH bias → only short at resistance levels (R1, R2)
 * - Tight stop/target (10-30 pts)
 * - Multiple trades per night allowed (each level touched once)
 * - Sub-session timing analysis (early overnight vs late)
 *
 * Usage:
 *   node backtest-engine/research/overnight-directed-touch-backtest.js
 *   node backtest-engine/research/overnight-directed-touch-backtest.js --sweep
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const SWEEP_MODE = process.argv.includes('--sweep');

// ============================================================================
// TIMEZONE HELPERS
// ============================================================================

function isDST(utcMs) {
  const d = new Date(utcMs);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth();
  if (month >= 3 && month <= 9) return true;
  if (month === 0 || month === 1 || month === 11) return false;
  if (month === 2) {
    const firstDay = new Date(Date.UTC(year, 2, 1)).getUTCDay();
    const secondSunday = firstDay === 0 ? 8 : 15 - firstDay;
    return utcMs >= Date.UTC(year, 2, secondSunday, 7);
  }
  if (month === 10) {
    const firstDay = new Date(Date.UTC(year, 10, 1)).getUTCDay();
    const firstSunday = firstDay === 0 ? 1 : 8 - firstDay;
    return utcMs < Date.UTC(year, 10, firstSunday, 6);
  }
  return false;
}

function utcToEST(utcMs) { return utcMs + (isDST(utcMs) ? -4 : -5) * 3600000; }
function getESTHour(ts) { const d = new Date(utcToEST(ts)); return d.getUTCHours() + d.getUTCMinutes() / 60; }
function getESTDateStr(ts) {
  const d = new Date(utcToEST(ts));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
function getDayOfWeek(dateStr) {
  return new Date(dateStr + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long' });
}

// ============================================================================
// DATA LOADING
// ============================================================================

function loadOHLCV() {
  console.log('Loading NQ OHLCV continuous data...');
  const raw = fs.readFileSync(path.join(DATA_DIR, 'ohlcv', 'nq', 'NQ_ohlcv_1m_continuous.csv'), 'utf-8');
  const lines = raw.split('\n').filter(l => l.trim());
  const candles = [];
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split(',');
    if (p.length < 6) continue;
    candles.push({
      timestamp: new Date(p[0]).getTime(),
      open: parseFloat(p[1]), high: parseFloat(p[2]),
      low: parseFloat(p[3]), close: parseFloat(p[4]),
      volume: parseInt(p[5]) || 0,
    });
  }
  console.log(`  ${candles.length} candles loaded`);
  return candles;
}

function loadIntradayGEX() {
  console.log('Loading NQ intraday GEX...');
  const gexDir = path.join(DATA_DIR, 'gex', 'nq');
  const files = fs.readdirSync(gexDir).filter(f => f.startsWith('nq_gex_') && f.endsWith('.json'));
  const eodGex = {};
  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(gexDir, file), 'utf-8'));
      const date = data.metadata?.date;
      if (!date || !data.data?.length) continue;
      const last = data.data[data.data.length - 1];
      eodGex[date] = {
        totalGex: last.total_gex,
        regime: last.regime,
        gammaFlip: last.gamma_flip,
        callWall: last.call_wall,
        putWall: last.put_wall,
        resistance: last.resistance || [],
        support: last.support || [],
        spot: last.nq_spot,
      };
    } catch (e) { /* skip */ }
  }
  console.log(`  ${Object.keys(eodGex).length} dates`);
  return eodGex;
}

function loadLT() {
  console.log('Loading NQ LT levels...');
  const raw = fs.readFileSync(path.join(DATA_DIR, 'liquidity', 'nq', 'NQ_liquidity_levels.csv'), 'utf-8');
  const lines = raw.split('\n').filter(l => l.trim());
  const lt = {};
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split(',');
    if (p.length < 8) continue;
    lt[p[0].split(' ')[0]] = { sentiment: p[2] };
  }
  console.log(`  ${Object.keys(lt).length} dates`);
  return lt;
}

// ============================================================================
// SESSION BUILDER
// ============================================================================

function buildSessions(candles) {
  console.log('Building overnight sessions...');
  const byDate = {};
  for (const c of candles) {
    const dateStr = getESTDateStr(c.timestamp);
    if (!byDate[dateStr]) byDate[dateStr] = [];
    byDate[dateStr].push({ ...c, estHour: getESTHour(c.timestamp) });
  }

  const dates = Object.keys(byDate).sort();
  const sessions = [];

  for (let i = 0; i < dates.length - 1; i++) {
    const today = dates[i];
    const tomorrow = dates[i + 1];
    const todayCandles = byDate[today] || [];
    const tomorrowCandles = byDate[tomorrow] || [];

    // RTH stats
    const rthCandles = todayCandles.filter(c => c.estHour >= 9.5 && c.estHour < 16);
    if (rthCandles.length < 30) continue;
    const rthClose = rthCandles[rthCandles.length - 1].close;
    const rthHigh = Math.max(...rthCandles.map(c => c.high));
    const rthLow = Math.min(...rthCandles.map(c => c.low));
    const ibs = rthHigh > rthLow ? (rthClose - rthLow) / (rthHigh - rthLow) : 0.5;

    // Overnight candles: 6PM today through 9:30AM tomorrow
    const overnightCandles = [
      ...todayCandles.filter(c => c.estHour >= 18),
      ...tomorrowCandles.filter(c => c.estHour < 9.5)
    ];
    if (overnightCandles.length < 10) continue;

    sessions.push({
      date: today, nextDate: tomorrow,
      dayOfWeek: getDayOfWeek(today),
      rthClose, ibs,
      overnightCandles,
    });
  }

  console.log(`  ${sessions.length} sessions built`);
  return sessions;
}

// ============================================================================
// TOUCH DETECTION & TRADE SIMULATION
// ============================================================================

function runTouchStrategy(sessions, gexData, ltData, params) {
  const {
    stopLossPoints, takeProfitPoints,
    tradeLevels,          // ['S1','S2','R1','R2','S3','R3']
    maxTradesPerNight,
    entryStartHour,       // Earliest entry hour EST (e.g., 18 = 6pm)
    entryEndHour,         // Latest new entry hour EST (e.g., 8 = 8am)
    touchProximity,       // Points: level must be within candle range
    maxHoldBars,          // Force exit after N 1-min bars
    cooldownBars,         // Bars between trades
    useLTFilter,          // Require LT sentiment agreement
    useGexRegimeFilter,   // Require GEX regime agreement
    onlyWithBias,         // Only trade when we have a directional bias
    trailingTrigger,
    trailingOffset,
    blockedDays,
  } = params;

  const allTrades = [];

  for (const session of sessions) {
    const gex = gexData[session.date];
    const lt = ltData[session.date];
    if (!gex) continue; // Need GEX levels

    // Determine directional bias
    let bias = 0; // 0 = neutral, 1 = bullish, -1 = bearish
    const posGex = gex.regime === 'positive' || gex.regime === 'strong_positive';
    const negGex = gex.regime === 'negative' || gex.regime === 'strong_negative';
    const bullLT = lt?.sentiment === 'BULLISH';
    const bearLT = lt?.sentiment === 'BEARISH';

    if (useLTFilter && useGexRegimeFilter) {
      if (bullLT && posGex) bias = 1;
      else if (bearLT && negGex) bias = -1;
    } else if (useLTFilter) {
      if (bullLT) bias = 1;
      else if (bearLT) bias = -1;
    } else if (useGexRegimeFilter) {
      if (posGex) bias = 1;
      else if (negGex) bias = -1;
    }

    if (onlyWithBias && bias === 0) continue;
    if (blockedDays?.includes(session.dayOfWeek)) continue;

    // Build GEX level map
    const levels = {};
    if (gex.support?.length > 0) {
      gex.support.forEach((price, i) => { levels[`S${i + 1}`] = { price, type: 'support' }; });
    }
    if (gex.resistance?.length > 0) {
      gex.resistance.forEach((price, i) => { levels[`R${i + 1}`] = { price, type: 'resistance' }; });
    }
    if (gex.gammaFlip) levels['GF'] = { price: gex.gammaFlip, type: 'gamma_flip' };

    // Filter to requested levels
    const activeLevels = {};
    for (const name of tradeLevels) {
      if (levels[name]) activeLevels[name] = levels[name];
    }

    // Track state for this night
    const touchedLevels = new Set();
    let tradesThisNight = 0;
    let lastTradeBar = -999;
    let inPosition = false;
    let positionEntry = null;
    let positionSide = null;
    let positionStop = null;
    let positionTarget = null;
    let positionBar = 0;
    let mfe = 0, mae = 0;
    let trailingStop = null;
    let positionLevelName = null;
    let positionLevelPrice = null;

    const candles = session.overnightCandles;

    for (let bar = 0; bar < candles.length; bar++) {
      const c = candles[bar];

      // Check if in allowed time window
      const inEntryWindow = (c.estHour >= entryStartHour || c.estHour < entryEndHour);

      // === MANAGE EXISTING POSITION ===
      if (inPosition) {
        positionBar++;
        const isLong = positionSide === 'buy';

        // Track MFE/MAE
        if (isLong) {
          mfe = Math.max(mfe, c.high - positionEntry);
          mae = Math.max(mae, positionEntry - c.low);
        } else {
          mfe = Math.max(mfe, positionEntry - c.low);
          mae = Math.max(mae, c.high - positionEntry);
        }

        let exitPrice = null;
        let exitReason = null;

        // Stop loss
        if (isLong && c.low <= positionStop) { exitPrice = positionStop; exitReason = 'stop_loss'; }
        if (!isLong && c.high >= positionStop) { exitPrice = positionStop; exitReason = 'stop_loss'; }

        // Take profit
        if (!exitPrice) {
          if (isLong && c.high >= positionTarget) { exitPrice = positionTarget; exitReason = 'take_profit'; }
          if (!isLong && c.low <= positionTarget) { exitPrice = positionTarget; exitReason = 'take_profit'; }
        }

        // Trailing stop
        if (!exitPrice && trailingTrigger > 0 && trailingOffset > 0) {
          const pnl = isLong ? c.high - positionEntry : positionEntry - c.low;
          if (pnl >= trailingTrigger) {
            const newTrail = isLong ? c.high - trailingOffset : c.low + trailingOffset;
            if (trailingStop == null || (isLong && newTrail > trailingStop) || (!isLong && newTrail < trailingStop)) {
              trailingStop = newTrail;
            }
          }
          if (trailingStop != null) {
            if (isLong && c.low <= trailingStop) { exitPrice = trailingStop; exitReason = 'trailing_stop'; }
            if (!isLong && c.high >= trailingStop) { exitPrice = trailingStop; exitReason = 'trailing_stop'; }
          }
        }

        // Max hold
        if (!exitPrice && maxHoldBars > 0 && positionBar >= maxHoldBars) {
          exitPrice = c.close;
          exitReason = 'max_hold';
        }

        if (exitPrice) {
          const pointsPnL = isLong ? exitPrice - positionEntry : positionEntry - exitPrice;
          allTrades.push({
            date: session.date,
            dayOfWeek: session.dayOfWeek,
            side: positionSide,
            entryPrice: positionEntry,
            exitPrice,
            pointsPnL,
            mfePoints: mfe,
            maePoints: mae,
            exitReason,
            levelName: positionLevelName,
            levelPrice: positionLevelPrice,
            gexRegime: gex.regime,
            ltSentiment: lt?.sentiment || 'unknown',
            bias,
            ibs: session.ibs,
            entryHour: candles[bar - positionBar]?.estHour,
          });

          inPosition = false;
          lastTradeBar = bar;
        }

        continue; // Don't open new trades while in position
      }

      // === LOOK FOR NEW ENTRIES ===
      if (!inEntryWindow) continue;
      if (tradesThisNight >= maxTradesPerNight) continue;
      if (bar - lastTradeBar < cooldownBars) continue;

      // Check each active level for a touch
      for (const [levelName, levelInfo] of Object.entries(activeLevels)) {
        if (touchedLevels.has(levelName)) continue;

        const levelPrice = levelInfo.price;
        const touched = c.low <= levelPrice + touchProximity && c.high >= levelPrice - touchProximity;
        if (!touched) continue;

        touchedLevels.add(levelName);

        // Determine trade direction based on level type and bias
        let side = null;
        if (levelInfo.type === 'support') {
          // Support touch → potential long
          if (bias >= 0) side = 'buy'; // Long if bullish or neutral
          // If bearish bias, skip support touches (wrong direction)
          if (bias < 0 && onlyWithBias) continue;
          if (bias < 0 && !onlyWithBias) side = 'buy'; // Still take it
        } else if (levelInfo.type === 'resistance') {
          // Resistance touch → potential short
          if (bias <= 0) side = 'sell'; // Short if bearish or neutral
          if (bias > 0 && onlyWithBias) continue;
          if (bias > 0 && !onlyWithBias) side = 'sell';
        } else if (levelInfo.type === 'gamma_flip') {
          // Gamma flip: long if below (support), short if above (resistance)
          if (c.close < levelPrice) side = bias >= 0 ? 'buy' : null;
          else side = bias <= 0 ? 'sell' : null;
          if (!side) continue;
        }
        if (!side) continue;

        // Direction filter: only trade in bias direction
        if (onlyWithBias) {
          if (bias === 1 && side !== 'buy') continue;
          if (bias === -1 && side !== 'sell') continue;
        }

        // Enter trade
        const isLong = side === 'buy';
        positionEntry = levelPrice;
        positionSide = side;
        positionStop = isLong ? levelPrice - stopLossPoints : levelPrice + stopLossPoints;
        positionTarget = isLong ? levelPrice + takeProfitPoints : levelPrice - takeProfitPoints;
        positionBar = 0;
        positionLevelName = levelName;
        positionLevelPrice = levelPrice;
        mfe = 0; mae = 0;
        trailingStop = null;
        inPosition = true;
        tradesThisNight++;
        break; // One entry per candle
      }
    }

    // Force close any open position at session end
    if (inPosition) {
      const lastCandle = candles[candles.length - 1];
      const isLong = positionSide === 'buy';
      const exitPrice = lastCandle.close;
      const pointsPnL = isLong ? exitPrice - positionEntry : positionEntry - exitPrice;
      allTrades.push({
        date: session.date, dayOfWeek: session.dayOfWeek,
        side: positionSide, entryPrice: positionEntry, exitPrice,
        pointsPnL, mfePoints: mfe, maePoints: mae,
        exitReason: 'session_end',
        levelName: positionLevelName, levelPrice: positionLevelPrice,
        gexRegime: gex.regime, ltSentiment: lt?.sentiment || 'unknown',
        bias, ibs: session.ibs,
      });
    }
  }

  return allTrades;
}

// ============================================================================
// METRICS
// ============================================================================

function computeMetrics(trades, label = '') {
  if (trades.length === 0) return null;
  const wins = trades.filter(t => t.pointsPnL > 0);
  const losses = trades.filter(t => t.pointsPnL <= 0);
  const totalPnL = trades.reduce((s, t) => s + t.pointsPnL, 0);
  const avgPnL = totalPnL / trades.length;
  const winRate = wins.length / trades.length * 100;
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pointsPnL, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.pointsPnL, 0) / losses.length : 0;
  const pf = losses.length > 0
    ? wins.reduce((s, t) => s + t.pointsPnL, 0) / Math.abs(losses.reduce((s, t) => s + t.pointsPnL, 0))
    : Infinity;
  const stdDev = Math.sqrt(trades.reduce((s, t) => s + Math.pow(t.pointsPnL - avgPnL, 2), 0) / trades.length);
  const sharpe = stdDev > 0 ? avgPnL / stdDev : 0;
  const avgMFE = trades.reduce((s, t) => s + t.mfePoints, 0) / trades.length;
  const avgMAE = trades.reduce((s, t) => s + t.maePoints, 0) / trades.length;
  let peak = 0, maxDD = 0, equity = 0;
  for (const t of trades) { equity += t.pointsPnL; if (equity > peak) peak = equity; maxDD = Math.max(maxDD, peak - equity); }

  const exitReasons = {};
  for (const t of trades) exitReasons[t.exitReason] = (exitReasons[t.exitReason] || 0) + 1;

  const longTrades = trades.filter(t => t.side === 'buy');
  const shortTrades = trades.filter(t => t.side === 'sell');

  return {
    label, trades: trades.length, wins: wins.length,
    winRate: winRate.toFixed(1), totalPnL: totalPnL.toFixed(1),
    avgPnL: avgPnL.toFixed(2), avgWin: avgWin.toFixed(2), avgLoss: avgLoss.toFixed(2),
    profitFactor: pf === Infinity ? 'Inf' : pf.toFixed(2),
    sharpe: sharpe.toFixed(3), stdDev: stdDev.toFixed(2),
    avgMFE: avgMFE.toFixed(1), avgMAE: avgMAE.toFixed(1),
    maxDD: maxDD.toFixed(1), finalEquity: equity.toFixed(1),
    longCount: longTrades.length, shortCount: shortTrades.length,
    longPnL: longTrades.reduce((s, t) => s + t.pointsPnL, 0).toFixed(1),
    shortPnL: shortTrades.reduce((s, t) => s + t.pointsPnL, 0).toFixed(1),
    exitReasons,
  };
}

function printMetrics(m) {
  if (!m) { console.log('  No trades'); return; }
  console.log(`\n  ═══ ${m.label} ═══`);
  console.log(`  Trades: ${m.trades} (${m.longCount}L / ${m.shortCount}S) | WR: ${m.winRate}% | PF: ${m.profitFactor}`);
  console.log(`  Total: ${m.totalPnL} pts | Avg: ${m.avgPnL} pts | Sharpe: ${m.sharpe}`);
  console.log(`  AvgWin: ${m.avgWin} | AvgLoss: ${m.avgLoss} | StdDev: ${m.stdDev}`);
  console.log(`  Long PnL: ${m.longPnL} | Short PnL: ${m.shortPnL}`);
  console.log(`  MFE: ${m.avgMFE} | MAE: ${m.avgMAE} | MFE/MAE: ${(parseFloat(m.avgMFE) / Math.max(parseFloat(m.avgMAE), 0.01)).toFixed(2)}`);
  console.log(`  MaxDD: ${m.maxDD} | FinalEquity: ${m.finalEquity}`);
  console.log(`  Exits: ${Object.entries(m.exitReasons).map(([k, v]) => `${k}=${v}`).join(', ')}`);
}

function printCompactRow(m, extra = '') {
  if (!m) return;
  console.log(`  ${(m.label + extra).padEnd(55)} ${String(m.trades).padStart(5)} ${m.winRate.padStart(6)}% ${m.avgPnL.padStart(8)} ${m.totalPnL.padStart(10)} ${m.sharpe.padStart(7)} ${m.profitFactor.padStart(6)} ${m.maxDD.padStart(8)}`);
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  OVERNIGHT DIRECTED TOUCH STRATEGY — NQ');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const candles = loadOHLCV();
  const gexData = loadIntradayGEX();
  const ltData = loadLT();
  const sessions = buildSessions(candles);

  const baseParams = {
    tradeLevels: ['S1', 'S2', 'R1', 'R2'],
    maxTradesPerNight: 1,
    entryStartHour: 18,
    entryEndHour: 8,
    touchProximity: 3,
    maxHoldBars: 60,
    cooldownBars: 5,
    trailingTrigger: 0,
    trailingOffset: 0,
    blockedDays: [],
    useLTFilter: false,
    useGexRegimeFilter: false,
    onlyWithBias: false,
  };

  if (SWEEP_MODE) {
    // ========================================================================
    // PARAMETER SWEEP
    // ========================================================================
    console.log('\n  SWEEPING parameters...\n');
    console.log(`  ${'Configuration'.padEnd(55)} ${'Trades'.padStart(5)} ${'WR'.padStart(7)} ${'AvgPnL'.padStart(8)} ${'TotalPnL'.padStart(10)} ${'Sharpe'.padStart(7)} ${'PF'.padStart(6)} ${'MaxDD'.padStart(8)}`);
    console.log(`  ${'─'.repeat(55)} ${'─'.repeat(5)} ${'─'.repeat(7)} ${'─'.repeat(8)} ${'─'.repeat(10)} ${'─'.repeat(7)} ${'─'.repeat(6)} ${'─'.repeat(8)}`);

    const stopTargets = [
      [5, 5], [5, 10], [7, 7], [7, 10], [7, 15],
      [10, 10], [10, 15], [10, 20], [10, 25], [10, 30],
      [15, 15], [15, 20], [15, 25], [15, 30],
      [20, 20], [20, 30], [20, 40],
      [25, 25], [25, 35], [25, 50],
      [30, 30], [30, 50],
    ];

    const configs = [
      // Unfiltered baselines
      { name: 'Unfiltered', useLT: false, useGex: false, onlyBias: false },
      // LT only
      { name: 'LT bias only', useLT: true, useGex: false, onlyBias: true },
      // GEX only
      { name: 'GEX bias only', useLT: false, useGex: true, onlyBias: true },
      // LT + GEX combined
      { name: 'LT+GEX bias', useLT: true, useGex: true, onlyBias: true },
      // LT + GEX + skip Thu
      { name: 'LT+GEX-Thu', useLT: true, useGex: true, onlyBias: true, blocked: ['Thursday'] },
    ];

    const maxHolds = [30, 60, 120];
    const maxPerNight = [1, 2, 3];
    const entryEnds = [2, 4, 8];

    const results = [];

    for (const cfg of configs) {
      for (const [sl, tp] of stopTargets) {
        for (const mh of maxHolds) {
          for (const mpn of maxPerNight) {
            for (const ee of entryEnds) {
              const params = {
                ...baseParams,
                stopLossPoints: sl, takeProfitPoints: tp,
                maxHoldBars: mh, maxTradesPerNight: mpn,
                entryEndHour: ee,
                useLTFilter: cfg.useLT, useGexRegimeFilter: cfg.useGex,
                onlyWithBias: cfg.onlyBias,
                blockedDays: cfg.blocked || [],
              };

              const trades = runTouchStrategy(sessions, gexData, ltData, params);
              if (trades.length < 30) continue;

              const m = computeMetrics(trades, '');
              const wr = parseFloat(m.winRate);
              results.push({
                config: cfg.name, sl, tp, mh, mpn, ee,
                trades: trades.length, wr, avgPnL: parseFloat(m.avgPnL),
                totalPnL: parseFloat(m.totalPnL), sharpe: parseFloat(m.sharpe),
                pf: m.profitFactor === 'Inf' ? 99 : parseFloat(m.profitFactor),
                maxDD: parseFloat(m.maxDD),
              });
            }
          }
        }
      }
    }

    // Sort by win rate, then Sharpe
    results.sort((a, b) => b.wr - a.wr || b.sharpe - a.sharpe);

    console.log('\n\n  ═══ TOP 50 BY WIN RATE ═══');
    console.log(`  ${'Config'.padEnd(15)} ${'SL/TP'.padStart(7)} ${'MH'.padStart(4)} ${'MPN'.padStart(4)} ${'EE'.padStart(4)} ${'Trades'.padStart(6)} ${'WR%'.padStart(6)} ${'AvgPnL'.padStart(8)} ${'TotalPnL'.padStart(10)} ${'Sharpe'.padStart(7)} ${'PF'.padStart(6)} ${'MaxDD'.padStart(8)}`);
    console.log(`  ${'─'.repeat(15)} ${'─'.repeat(7)} ${'─'.repeat(4)} ${'─'.repeat(4)} ${'─'.repeat(4)} ${'─'.repeat(6)} ${'─'.repeat(6)} ${'─'.repeat(8)} ${'─'.repeat(10)} ${'─'.repeat(7)} ${'─'.repeat(6)} ${'─'.repeat(8)}`);

    for (let i = 0; i < Math.min(50, results.length); i++) {
      const r = results[i];
      console.log(`  ${r.config.padEnd(15)} ${(r.sl + '/' + r.tp).padStart(7)} ${String(r.mh).padStart(4)} ${String(r.mpn).padStart(4)} ${String(r.ee).padStart(4)} ${String(r.trades).padStart(6)} ${r.wr.toFixed(1).padStart(6)} ${r.avgPnL.toFixed(1).padStart(8)} ${r.totalPnL.toFixed(0).padStart(10)} ${r.sharpe.toFixed(3).padStart(7)} ${(r.pf >= 99 ? 'Inf' : r.pf.toFixed(1)).padStart(6)} ${r.maxDD.toFixed(0).padStart(8)}`);
    }

    // Also top 30 by Sharpe with WR >= 75%
    const highWR = results.filter(r => r.wr >= 75).sort((a, b) => b.sharpe - a.sharpe);
    console.log(`\n\n  ═══ TOP 30 BY SHARPE (WR >= 75%) ═══  [${highWR.length} configs qualify]`);
    console.log(`  ${'Config'.padEnd(15)} ${'SL/TP'.padStart(7)} ${'MH'.padStart(4)} ${'MPN'.padStart(4)} ${'EE'.padStart(4)} ${'Trades'.padStart(6)} ${'WR%'.padStart(6)} ${'AvgPnL'.padStart(8)} ${'TotalPnL'.padStart(10)} ${'Sharpe'.padStart(7)} ${'PF'.padStart(6)} ${'MaxDD'.padStart(8)}`);
    console.log(`  ${'─'.repeat(15)} ${'─'.repeat(7)} ${'─'.repeat(4)} ${'─'.repeat(4)} ${'─'.repeat(4)} ${'─'.repeat(6)} ${'─'.repeat(6)} ${'─'.repeat(8)} ${'─'.repeat(10)} ${'─'.repeat(7)} ${'─'.repeat(6)} ${'─'.repeat(8)}`);

    for (let i = 0; i < Math.min(30, highWR.length); i++) {
      const r = highWR[i];
      console.log(`  ${r.config.padEnd(15)} ${(r.sl + '/' + r.tp).padStart(7)} ${String(r.mh).padStart(4)} ${String(r.mpn).padStart(4)} ${String(r.ee).padStart(4)} ${String(r.trades).padStart(6)} ${r.wr.toFixed(1).padStart(6)} ${r.avgPnL.toFixed(1).padStart(8)} ${r.totalPnL.toFixed(0).padStart(10)} ${r.sharpe.toFixed(3).padStart(7)} ${(r.pf >= 99 ? 'Inf' : r.pf.toFixed(1)).padStart(6)} ${r.maxDD.toFixed(0).padStart(8)}`);
    }

    // Top 30 by total PnL with WR >= 75%
    const highWRbyPnL = results.filter(r => r.wr >= 75).sort((a, b) => b.totalPnL - a.totalPnL);
    console.log(`\n\n  ═══ TOP 30 BY TOTAL PNL (WR >= 75%) ═══`);
    console.log(`  ${'Config'.padEnd(15)} ${'SL/TP'.padStart(7)} ${'MH'.padStart(4)} ${'MPN'.padStart(4)} ${'EE'.padStart(4)} ${'Trades'.padStart(6)} ${'WR%'.padStart(6)} ${'AvgPnL'.padStart(8)} ${'TotalPnL'.padStart(10)} ${'Sharpe'.padStart(7)} ${'PF'.padStart(6)} ${'MaxDD'.padStart(8)}`);
    console.log(`  ${'─'.repeat(15)} ${'─'.repeat(7)} ${'─'.repeat(4)} ${'─'.repeat(4)} ${'─'.repeat(4)} ${'─'.repeat(6)} ${'─'.repeat(6)} ${'─'.repeat(8)} ${'─'.repeat(10)} ${'─'.repeat(7)} ${'─'.repeat(6)} ${'─'.repeat(8)}`);

    for (let i = 0; i < Math.min(30, highWRbyPnL.length); i++) {
      const r = highWRbyPnL[i];
      console.log(`  ${r.config.padEnd(15)} ${(r.sl + '/' + r.tp).padStart(7)} ${String(r.mh).padStart(4)} ${String(r.mpn).padStart(4)} ${String(r.ee).padStart(4)} ${String(r.trades).padStart(6)} ${r.wr.toFixed(1).padStart(6)} ${r.avgPnL.toFixed(1).padStart(8)} ${r.totalPnL.toFixed(0).padStart(10)} ${r.sharpe.toFixed(3).padStart(7)} ${(r.pf >= 99 ? 'Inf' : r.pf.toFixed(1)).padStart(6)} ${r.maxDD.toFixed(0).padStart(8)}`);
    }

  } else {
    // ========================================================================
    // KEY VARIANT COMPARISON
    // ========================================================================
    console.log('\n╔══════════════════════════════════════════════════════════════════╗');
    console.log('║  STRATEGY VARIANTS (SL/TP sweep, 1-min touch detection)        ║');
    console.log('╚══════════════════════════════════════════════════════════════════╝\n');

    console.log(`  ${'Configuration'.padEnd(55)} ${'Trades'.padStart(5)} ${'WR'.padStart(7)} ${'AvgPnL'.padStart(8)} ${'TotalPnL'.padStart(10)} ${'Sharpe'.padStart(7)} ${'PF'.padStart(6)} ${'MaxDD'.padStart(8)}`);
    console.log(`  ${'─'.repeat(55)} ${'─'.repeat(5)} ${'─'.repeat(7)} ${'─'.repeat(8)} ${'─'.repeat(10)} ${'─'.repeat(7)} ${'─'.repeat(6)} ${'─'.repeat(8)}`);

    const variants = [
      // Unfiltered touches at various SL/TP
      { label: 'Unfiltered S1S2R1R2, SL10/TP10', sl: 10, tp: 10, lt: false, gex: false, bias: false },
      { label: 'Unfiltered S1S2R1R2, SL10/TP15', sl: 10, tp: 15, lt: false, gex: false, bias: false },
      { label: 'Unfiltered S1S2R1R2, SL15/TP15', sl: 15, tp: 15, lt: false, gex: false, bias: false },
      { label: 'Unfiltered S1S2R1R2, SL10/TP20', sl: 10, tp: 20, lt: false, gex: false, bias: false },
      { label: 'Unfiltered S1S2R1R2, SL15/TP20', sl: 15, tp: 20, lt: false, gex: false, bias: false },
      { label: 'Unfiltered S1S2R1R2, SL20/TP20', sl: 20, tp: 20, lt: false, gex: false, bias: false },
      { label: 'Unfiltered S1S2R1R2, SL20/TP30', sl: 20, tp: 30, lt: false, gex: false, bias: false },

      // LT-filtered (only trade in LT direction)
      { label: 'LT-directed touches, SL10/TP10', sl: 10, tp: 10, lt: true, gex: false, bias: true },
      { label: 'LT-directed touches, SL10/TP15', sl: 10, tp: 15, lt: true, gex: false, bias: true },
      { label: 'LT-directed touches, SL10/TP20', sl: 10, tp: 20, lt: true, gex: false, bias: true },
      { label: 'LT-directed touches, SL15/TP15', sl: 15, tp: 15, lt: true, gex: false, bias: true },
      { label: 'LT-directed touches, SL15/TP20', sl: 15, tp: 20, lt: true, gex: false, bias: true },
      { label: 'LT-directed touches, SL20/TP20', sl: 20, tp: 20, lt: true, gex: false, bias: true },

      // LT + GEX directed
      { label: 'LT+GEX directed, SL10/TP10', sl: 10, tp: 10, lt: true, gex: true, bias: true },
      { label: 'LT+GEX directed, SL10/TP15', sl: 10, tp: 15, lt: true, gex: true, bias: true },
      { label: 'LT+GEX directed, SL10/TP20', sl: 10, tp: 20, lt: true, gex: true, bias: true },
      { label: 'LT+GEX directed, SL15/TP15', sl: 15, tp: 15, lt: true, gex: true, bias: true },
      { label: 'LT+GEX directed, SL15/TP20', sl: 15, tp: 20, lt: true, gex: true, bias: true },
      { label: 'LT+GEX directed, SL20/TP20', sl: 20, tp: 20, lt: true, gex: true, bias: true },
      { label: 'LT+GEX directed, SL20/TP30', sl: 20, tp: 30, lt: true, gex: true, bias: true },
      { label: 'LT+GEX directed, SL25/TP25', sl: 25, tp: 25, lt: true, gex: true, bias: true },

      // Multi-trade per night
      { label: 'LT+GEX 2/night, SL10/TP10', sl: 10, tp: 10, lt: true, gex: true, bias: true, mpn: 2 },
      { label: 'LT+GEX 3/night, SL10/TP10', sl: 10, tp: 10, lt: true, gex: true, bias: true, mpn: 3 },
      { label: 'LT+GEX 2/night, SL10/TP15', sl: 10, tp: 15, lt: true, gex: true, bias: true, mpn: 2 },
      { label: 'LT+GEX 3/night, SL10/TP15', sl: 10, tp: 15, lt: true, gex: true, bias: true, mpn: 3 },
      { label: 'LT+GEX 2/night, SL15/TP20', sl: 15, tp: 20, lt: true, gex: true, bias: true, mpn: 2 },

      // Early session only (6pm-2am)
      { label: 'LT+GEX early(6p-2a), SL10/TP10', sl: 10, tp: 10, lt: true, gex: true, bias: true, ee: 2 },
      { label: 'LT+GEX early(6p-2a), SL10/TP15', sl: 10, tp: 15, lt: true, gex: true, bias: true, ee: 2 },
      { label: 'LT+GEX early(6p-2a), SL15/TP15', sl: 15, tp: 15, lt: true, gex: true, bias: true, ee: 2 },
      { label: 'LT+GEX early(6p-4a), SL10/TP15', sl: 10, tp: 15, lt: true, gex: true, bias: true, ee: 4 },

      // S1/R1 only (tightest levels)
      { label: 'LT+GEX S1R1 only, SL10/TP10', sl: 10, tp: 10, lt: true, gex: true, bias: true, levels: ['S1', 'R1'] },
      { label: 'LT+GEX S1R1 only, SL10/TP15', sl: 10, tp: 15, lt: true, gex: true, bias: true, levels: ['S1', 'R1'] },
      { label: 'LT+GEX S1R1 only, SL15/TP20', sl: 15, tp: 20, lt: true, gex: true, bias: true, levels: ['S1', 'R1'] },

      // With trailing stops
      { label: 'LT+GEX SL10/TP20 trail@10/5', sl: 10, tp: 20, lt: true, gex: true, bias: true, tt: 10, to: 5 },
      { label: 'LT+GEX SL15/TP30 trail@15/7', sl: 15, tp: 30, lt: true, gex: true, bias: true, tt: 15, to: 7 },

      // Skip Thursday
      { label: 'LT+GEX-Thu SL10/TP10', sl: 10, tp: 10, lt: true, gex: true, bias: true, blocked: ['Thursday'] },
      { label: 'LT+GEX-Thu SL10/TP15', sl: 10, tp: 15, lt: true, gex: true, bias: true, blocked: ['Thursday'] },
      { label: 'LT+GEX-Thu SL15/TP20', sl: 15, tp: 20, lt: true, gex: true, bias: true, blocked: ['Thursday'] },
    ];

    for (const v of variants) {
      const params = {
        ...baseParams,
        stopLossPoints: v.sl, takeProfitPoints: v.tp,
        useLTFilter: v.lt, useGexRegimeFilter: v.gex, onlyWithBias: v.bias,
        maxTradesPerNight: v.mpn || 1,
        entryEndHour: v.ee || 8,
        tradeLevels: v.levels || ['S1', 'S2', 'R1', 'R2'],
        trailingTrigger: v.tt || 0, trailingOffset: v.to || 0,
        blockedDays: v.blocked || [],
      };
      const trades = runTouchStrategy(sessions, gexData, ltData, params);
      const m = computeMetrics(trades, v.label);
      printCompactRow(m);
    }

    // Detailed breakdown for top performer
    console.log('\n\n╔══════════════════════════════════════════════════════════════════╗');
    console.log('║  DETAILED: LT+GEX directed, SL10/TP10, max 1/night           ║');
    console.log('╚══════════════════════════════════════════════════════════════════╝');

    const bestParams = {
      ...baseParams,
      stopLossPoints: 10, takeProfitPoints: 10,
      useLTFilter: true, useGexRegimeFilter: true, onlyWithBias: true,
    };
    const bestTrades = runTouchStrategy(sessions, gexData, ltData, bestParams);
    printMetrics(computeMetrics(bestTrades, 'LT+GEX SL10/TP10 — All'));

    // By level
    console.log('\n  By Level:');
    for (const level of ['S1', 'S2', 'R1', 'R2']) {
      const subset = bestTrades.filter(t => t.levelName === level);
      if (subset.length > 3) {
        const m = computeMetrics(subset, level);
        console.log(`    ${level}: ${subset.length} trades, WR=${m.winRate}%, Avg=${m.avgPnL}pts, Total=${m.totalPnL}`);
      }
    }

    // By side
    console.log('\n  By Side:');
    printMetrics(computeMetrics(bestTrades.filter(t => t.side === 'buy'), 'LONG (support touches)'));
    printMetrics(computeMetrics(bestTrades.filter(t => t.side === 'sell'), 'SHORT (resistance touches)'));

    // By day
    console.log('\n  By Day of Week:');
    for (const day of ['Monday', 'Tuesday', 'Wednesday', 'Thursday']) {
      const subset = bestTrades.filter(t => t.dayOfWeek === day);
      if (subset.length > 3) {
        const m = computeMetrics(subset, day);
        console.log(`    ${day.padEnd(12)}: ${subset.length} trades, WR=${m.winRate}%, Avg=${m.avgPnL}pts`);
      }
    }

    // Monthly PnL
    console.log('\n  Monthly PnL:');
    const byMonth = {};
    for (const t of bestTrades) {
      const mo = t.date.substring(0, 7);
      if (!byMonth[mo]) byMonth[mo] = { n: 0, pnl: 0, w: 0 };
      byMonth[mo].n++;
      byMonth[mo].pnl += t.pointsPnL;
      if (t.pointsPnL > 0) byMonth[mo].w++;
    }
    let cum = 0;
    for (const [mo, d] of Object.entries(byMonth).sort()) {
      cum += d.pnl;
      const bar = d.pnl >= 0
        ? '+' + '█'.repeat(Math.min(Math.round(d.pnl / 5), 40))
        : '-' + '█'.repeat(Math.min(Math.round(-d.pnl / 5), 40));
      console.log(`    ${mo}: ${String(d.n).padStart(3)} trades, ${d.pnl.toFixed(0).padStart(6)}pts (WR ${(d.w / d.n * 100).toFixed(0).padStart(3)}%), cum: ${cum.toFixed(0).padStart(7)}  ${bar}`);
    }
  }

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  COMPLETE. Use --sweep for full parameter grid search.');
  console.log('═══════════════════════════════════════════════════════════════');
}

main().catch(console.error);
