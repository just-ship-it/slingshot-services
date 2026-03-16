/**
 * Overnight Composite Strategy Backtest
 *
 * Combines the strongest overnight predictive signals:
 *   1. LT Sentiment (BULLISH → long, BEARISH → short) — primary signal
 *   2. GEX Regime (positive → long bias, negative → short bias) — confirmation
 *   3. IBS (Internal Bar Strength) — enhancement filter
 *   4. Total GEX magnitude — conviction filter
 *
 * Entry: Market order at overnight open (~6 PM EST)
 * Exit: Stop loss, take profit, or forced exit at session end
 * Target: NQ futures
 *
 * Usage:
 *   node backtest-engine/research/overnight-composite-backtest.js
 *   node backtest-engine/research/overnight-composite-backtest.js --sweep
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const SWEEP_MODE = process.argv.includes('--sweep');

// ============================================================================
// FAST EST/EDT TIMEZONE HELPERS
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

function utcToEST(utcMs) {
  return utcMs + (isDST(utcMs) ? -4 : -5) * 3600000;
}

function getESTHour(ts) {
  const d = new Date(utcToEST(ts));
  return d.getUTCHours() + d.getUTCMinutes() / 60;
}

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
  const filePath = path.join(DATA_DIR, 'ohlcv', 'nq', 'NQ_ohlcv_1m_continuous.csv');
  const raw = fs.readFileSync(filePath, 'utf-8');
  const lines = raw.split('\n').filter(l => l.trim());
  const candles = [];
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split(',');
    if (p.length < 6) continue;
    candles.push({
      timestamp: new Date(p[0]).getTime(),
      open: parseFloat(p[1]),
      high: parseFloat(p[2]),
      low: parseFloat(p[3]),
      close: parseFloat(p[4]),
      volume: parseInt(p[5]) || 0,
    });
  }
  console.log(`  Loaded ${candles.length} candles`);
  return candles;
}

function loadIntradayGEX() {
  console.log('Loading NQ intraday GEX snapshots...');
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
        totalCex: last.total_cex,
        regime: last.regime,
        gammaFlip: last.gamma_flip,
        callWall: last.call_wall,
        putWall: last.put_wall,
        spot: last.nq_spot,
      };
    } catch (e) { /* skip */ }
  }
  console.log(`  Loaded EOD GEX for ${Object.keys(eodGex).length} dates`);
  return eodGex;
}

function loadDailyGEX() {
  console.log('Loading NQ daily GEX levels...');
  const filePath = path.join(DATA_DIR, 'gex', 'nq', 'NQ_gex_levels.csv');
  const raw = fs.readFileSync(filePath, 'utf-8');
  const lines = raw.split('\n').filter(l => l.trim());
  const gex = {};
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split(',');
    if (p.length < 11) continue;
    gex[p[0]] = {
      totalGex: parseFloat(p[10]),
      regime: p[11]?.trim() || 'unknown',
      gammaFlip: parseFloat(p[1]),
    };
  }
  console.log(`  Loaded ${Object.keys(gex).length} daily GEX records`);
  return gex;
}

function loadLT() {
  console.log('Loading NQ LT levels...');
  const filePath = path.join(DATA_DIR, 'liquidity', 'nq', 'NQ_liquidity_levels.csv');
  const raw = fs.readFileSync(filePath, 'utf-8');
  const lines = raw.split('\n').filter(l => l.trim());
  const lt = {};
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split(',');
    if (p.length < 8) continue;
    const dateOnly = p[0].split(' ')[0];
    lt[dateOnly] = {
      sentiment: p[2],
      levels: [parseFloat(p[3]), parseFloat(p[4]), parseFloat(p[5]), parseFloat(p[6]), parseFloat(p[7])],
    };
  }
  console.log(`  Loaded LT for ${Object.keys(lt).length} dates`);
  return lt;
}

// ============================================================================
// OVERNIGHT SESSION EXTRACTION
// ============================================================================

function buildDailySessions(candles) {
  console.log('Building daily sessions...');

  // Group candles by EST date
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

    // RTH candles: 9:30 - 16:00 EST
    const rthCandles = todayCandles.filter(c => c.estHour >= 9.5 && c.estHour < 16);
    if (rthCandles.length < 30) continue;

    const rthHigh = Math.max(...rthCandles.map(c => c.high));
    const rthLow = Math.min(...rthCandles.map(c => c.low));
    const rthClose = rthCandles[rthCandles.length - 1].close;
    const rthOpen = rthCandles[0].open;

    // IBS = (Close - Low) / (High - Low)
    const ibs = (rthHigh - rthLow) > 0 ? (rthClose - rthLow) / (rthHigh - rthLow) : 0.5;

    // Overnight candles: 18:00 today through 08:00 tomorrow (or configurable end)
    const overnightCandles = [
      ...todayCandles.filter(c => c.estHour >= 18),
      ...tomorrowCandles.filter(c => c.estHour < 9.5)
    ];
    if (overnightCandles.length < 10) continue;

    sessions.push({
      date: today,
      nextDate: tomorrow,
      dayOfWeek: getDayOfWeek(today),

      // RTH stats
      rthOpen,
      rthClose,
      rthHigh,
      rthLow,
      rthReturn: rthClose - rthOpen,
      rthRange: rthHigh - rthLow,
      ibs,

      // Overnight candle data (for P&L simulation)
      overnightCandles,
      overnightOpen: overnightCandles[0].open,
    });
  }

  console.log(`  Built ${sessions.length} daily sessions`);
  return sessions;
}

// ============================================================================
// TRADE SIMULATOR
// ============================================================================

function simulateTrade(session, side, params) {
  const { stopLossPoints, takeProfitPoints, exitHourEST, trailingTrigger, trailingOffset } = params;
  const candles = session.overnightCandles;
  const entryPrice = session.overnightOpen;
  const isLong = side === 'buy';

  const stopPrice = isLong
    ? entryPrice - stopLossPoints
    : entryPrice + stopLossPoints;
  const targetPrice = isLong
    ? entryPrice + takeProfitPoints
    : entryPrice - takeProfitPoints;

  let mfe = 0;   // Max Favorable Excursion (points)
  let mae = 0;   // Max Adverse Excursion (points)
  let exitPrice = null;
  let exitReason = null;
  let exitTs = null;
  let trailingStop = null;

  for (const c of candles) {
    // Check forced exit time
    if (exitHourEST && c.estHour >= exitHourEST && c.estHour < 18) {
      exitPrice = c.open; // Exit at candle open of the exit hour
      exitReason = 'time_exit';
      exitTs = c.timestamp;
      break;
    }

    // Track MFE/MAE
    if (isLong) {
      const favorable = c.high - entryPrice;
      const adverse = entryPrice - c.low;
      if (favorable > mfe) mfe = favorable;
      if (adverse > mae) mae = adverse;
    } else {
      const favorable = entryPrice - c.low;
      const adverse = c.high - entryPrice;
      if (favorable > mfe) mfe = favorable;
      if (adverse > mae) mae = adverse;
    }

    // Check stop loss
    if (isLong && c.low <= stopPrice) {
      exitPrice = stopPrice;
      exitReason = 'stop_loss';
      exitTs = c.timestamp;
      break;
    }
    if (!isLong && c.high >= stopPrice) {
      exitPrice = stopPrice;
      exitReason = 'stop_loss';
      exitTs = c.timestamp;
      break;
    }

    // Check take profit
    if (isLong && c.high >= targetPrice) {
      exitPrice = targetPrice;
      exitReason = 'take_profit';
      exitTs = c.timestamp;
      break;
    }
    if (!isLong && c.low <= targetPrice) {
      exitPrice = targetPrice;
      exitReason = 'take_profit';
      exitTs = c.timestamp;
      break;
    }

    // Trailing stop logic
    if (trailingTrigger > 0 && trailingOffset > 0) {
      const currentPnL = isLong ? c.close - entryPrice : entryPrice - c.close;
      if (currentPnL >= trailingTrigger) {
        const newTrail = isLong
          ? c.close - trailingOffset
          : c.close + trailingOffset;
        if (trailingStop == null ||
            (isLong && newTrail > trailingStop) ||
            (!isLong && newTrail < trailingStop)) {
          trailingStop = newTrail;
        }
      }
      if (trailingStop != null) {
        if (isLong && c.low <= trailingStop) {
          exitPrice = trailingStop;
          exitReason = 'trailing_stop';
          exitTs = c.timestamp;
          break;
        }
        if (!isLong && c.high >= trailingStop) {
          exitPrice = trailingStop;
          exitReason = 'trailing_stop';
          exitTs = c.timestamp;
          break;
        }
      }
    }
  }

  // If no exit triggered, exit at last candle close
  if (!exitPrice) {
    const lastCandle = candles[candles.length - 1];
    exitPrice = lastCandle.close;
    exitReason = 'session_end';
    exitTs = lastCandle.timestamp;
  }

  const pointsPnL = isLong ? exitPrice - entryPrice : entryPrice - exitPrice;

  return {
    date: session.date,
    dayOfWeek: session.dayOfWeek,
    side,
    entryPrice,
    exitPrice,
    pointsPnL,
    mfePoints: mfe,
    maePoints: mae,
    exitReason,
    exitTs,
  };
}

// ============================================================================
// SIGNAL GENERATION
// ============================================================================

function generateSignal(session, gex, lt, params) {
  const {
    useLT, useGexRegime, useIBS, useGexMagnitude,
    ibsLongThreshold, ibsShortThreshold,
    gexMagnitudeMin,
    requireGexConfirmation,
    blockedDays,
  } = params;

  // Day filter
  if (blockedDays && blockedDays.includes(session.dayOfWeek)) return 0;

  // Determine base signal from LT sentiment
  let signal = 0;
  if (useLT && lt) {
    if (lt.sentiment === 'BULLISH') signal = 1;
    else if (lt.sentiment === 'BEARISH') signal = -1;
  }

  // If no LT signal and LT is primary, skip
  if (useLT && signal === 0) return 0;

  // GEX regime confirmation
  if (useGexRegime && gex) {
    const posGex = gex.regime === 'positive' || gex.regime === 'strong_positive';
    const negGex = gex.regime === 'negative' || gex.regime === 'strong_negative';

    if (requireGexConfirmation) {
      // Only take trade if GEX agrees with LT direction
      if (signal === 1 && !posGex) return 0;
      if (signal === -1 && !negGex) return 0;
    } else if (!useLT) {
      // GEX-only mode
      if (posGex) signal = 1;
      else if (negGex) signal = -1;
      else return 0;
    }
  }

  // GEX magnitude filter
  if (useGexMagnitude && gex) {
    if (Math.abs(gex.totalGex) < gexMagnitudeMin) return 0;
  }

  // IBS filter
  if (useIBS) {
    if (signal === 1 && session.ibs > ibsLongThreshold) return 0;   // Only long when IBS is low
    if (signal === -1 && session.ibs < ibsShortThreshold) return 0;  // Only short when IBS is high
  }

  return signal;
}

// ============================================================================
// METRICS COMPUTATION
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
  const profitFactor = losses.length > 0
    ? wins.reduce((s, t) => s + t.pointsPnL, 0) / Math.abs(losses.reduce((s, t) => s + t.pointsPnL, 0))
    : Infinity;

  const stdDev = Math.sqrt(trades.reduce((s, t) => s + Math.pow(t.pointsPnL - avgPnL, 2), 0) / trades.length);
  const sharpe = stdDev > 0 ? avgPnL / stdDev : 0;

  const avgMFE = trades.reduce((s, t) => s + t.mfePoints, 0) / trades.length;
  const avgMAE = trades.reduce((s, t) => s + t.maePoints, 0) / trades.length;

  // Max drawdown
  let peak = 0, maxDD = 0, equity = 0;
  for (const t of trades) {
    equity += t.pointsPnL;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDD) maxDD = dd;
  }

  // Exit reason breakdown
  const exitReasons = {};
  for (const t of trades) {
    exitReasons[t.exitReason] = (exitReasons[t.exitReason] || 0) + 1;
  }

  // Long vs short breakdown
  const longTrades = trades.filter(t => t.side === 'buy');
  const shortTrades = trades.filter(t => t.side === 'sell');
  const longPnL = longTrades.reduce((s, t) => s + t.pointsPnL, 0);
  const shortPnL = shortTrades.reduce((s, t) => s + t.pointsPnL, 0);

  return {
    label,
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: winRate.toFixed(1),
    totalPnL: totalPnL.toFixed(1),
    avgPnL: avgPnL.toFixed(2),
    avgWin: avgWin.toFixed(2),
    avgLoss: avgLoss.toFixed(2),
    profitFactor: profitFactor === Infinity ? 'Inf' : profitFactor.toFixed(2),
    sharpe: sharpe.toFixed(3),
    stdDev: stdDev.toFixed(2),
    avgMFE: avgMFE.toFixed(1),
    avgMAE: avgMAE.toFixed(1),
    maxDD: maxDD.toFixed(1),
    finalEquity: equity.toFixed(1),
    longTrades: longTrades.length,
    shortTrades: shortTrades.length,
    longPnL: longPnL.toFixed(1),
    shortPnL: shortPnL.toFixed(1),
    avgLongPnL: longTrades.length > 0 ? (longPnL / longTrades.length).toFixed(2) : 'N/A',
    avgShortPnL: shortTrades.length > 0 ? (shortPnL / shortTrades.length).toFixed(2) : 'N/A',
    exitReasons,
  };
}

function printMetrics(m) {
  if (!m) { console.log('  No trades'); return; }
  console.log(`\n  ═══ ${m.label} ═══`);
  console.log(`  Trades: ${m.trades} (${m.longTrades}L / ${m.shortTrades}S) | WR: ${m.winRate}% | PF: ${m.profitFactor}`);
  console.log(`  Total PnL: ${m.totalPnL} pts | Avg: ${m.avgPnL} pts/trade | Sharpe: ${m.sharpe}`);
  console.log(`  Avg Win: ${m.avgWin} | Avg Loss: ${m.avgLoss} | StdDev: ${m.stdDev}`);
  console.log(`  Long: ${m.longTrades} trades, ${m.longPnL} pts (avg ${m.avgLongPnL})`);
  console.log(`  Short: ${m.shortTrades} trades, ${m.shortPnL} pts (avg ${m.avgShortPnL})`);
  console.log(`  Avg MFE: ${m.avgMFE} | Avg MAE: ${m.avgMAE} | MFE/MAE: ${(parseFloat(m.avgMFE) / parseFloat(m.avgMAE)).toFixed(2)}`);
  console.log(`  Max DD: ${m.maxDD} pts | Final Equity: ${m.finalEquity} pts`);
  console.log(`  Exits: ${Object.entries(m.exitReasons).map(([k, v]) => `${k}=${v}`).join(', ')}`);
}

// ============================================================================
// MAIN BACKTEST
// ============================================================================

function runBacktest(sessions, gexData, dailyGex, ltData, params) {
  const trades = [];

  for (const session of sessions) {
    // Get features
    const gex = gexData[session.date] || dailyGex[session.date] || null;
    const lt = ltData[session.date] || null;

    // Generate signal
    const signal = generateSignal(session, gex, lt, params);
    if (signal === 0) continue;

    const side = signal > 0 ? 'buy' : 'sell';

    // Simulate trade
    const trade = simulateTrade(session, side, params);

    // Attach metadata
    trade.ibs = session.ibs;
    trade.gexRegime = gex?.regime || 'unknown';
    trade.ltSentiment = lt?.sentiment || 'unknown';
    trade.totalGex = gex?.totalGex || null;
    trade.rthReturn = session.rthReturn;

    trades.push(trade);
  }

  return trades;
}

// ============================================================================
// PARAMETER SWEEP
// ============================================================================

function runSweep(sessions, gexData, dailyGex, ltData) {
  console.log('\n╔══════════════════════════════════════════════════════════════════╗');
  console.log('║  PARAMETER SWEEP                                               ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝\n');

  const results = [];

  // Stop/target sweep
  const stopTargets = [
    { sl: 30, tp: 30 }, { sl: 30, tp: 50 }, { sl: 30, tp: 70 },
    { sl: 50, tp: 50 }, { sl: 50, tp: 70 }, { sl: 50, tp: 100 },
    { sl: 70, tp: 70 }, { sl: 70, tp: 100 }, { sl: 70, tp: 150 },
    { sl: 100, tp: 100 }, { sl: 100, tp: 150 }, { sl: 100, tp: 200 },
    { sl: 150, tp: 150 }, { sl: 150, tp: 200 },
    { sl: 200, tp: 200 },
    { sl: 9999, tp: 9999 }, // No stop/target (time exit only)
  ];

  const exitHours = [2, 4, 8, 9.5]; // 2am, 4am, 8am, 9:30am EST

  // Strategy variants
  const stratVariants = [
    { name: 'LT only', useLT: true, useGexRegime: false, useIBS: false, requireGexConfirmation: false },
    { name: 'LT + GEX confirm', useLT: true, useGexRegime: true, useIBS: false, requireGexConfirmation: true },
    { name: 'LT + IBS<0.3 (long) / IBS>0.7 (short)', useLT: true, useGexRegime: false, useIBS: true, requireGexConfirmation: false, ibsLongThreshold: 0.3, ibsShortThreshold: 0.7 },
    { name: 'LT + GEX + IBS', useLT: true, useGexRegime: true, useIBS: true, requireGexConfirmation: true, ibsLongThreshold: 0.3, ibsShortThreshold: 0.7 },
    { name: 'GEX only', useLT: false, useGexRegime: true, useIBS: false, requireGexConfirmation: false },
    { name: 'LT + skip Thu', useLT: true, useGexRegime: false, useIBS: false, requireGexConfirmation: false, blockedDays: ['Thursday'] },
    { name: 'LT + GEX + skip Thu', useLT: true, useGexRegime: true, useIBS: false, requireGexConfirmation: true, blockedDays: ['Thursday'] },
  ];

  // Sweep: strategy variant × stop/target × exit hour
  for (const strat of stratVariants) {
    for (const { sl, tp } of stopTargets) {
      for (const exitHr of exitHours) {
        const params = {
          ...strat,
          stopLossPoints: sl,
          takeProfitPoints: tp,
          exitHourEST: exitHr,
          useGexMagnitude: false,
          gexMagnitudeMin: 0,
          trailingTrigger: 0,
          trailingOffset: 0,
          ibsLongThreshold: strat.ibsLongThreshold || 1.0,
          ibsShortThreshold: strat.ibsShortThreshold || 0.0,
        };

        const trades = runBacktest(sessions, gexData, dailyGex, ltData, params);
        if (trades.length < 20) continue;

        const m = computeMetrics(trades, '');
        results.push({
          strategy: strat.name,
          sl, tp, exitHr,
          trades: trades.length,
          winRate: parseFloat(m.winRate),
          totalPnL: parseFloat(m.totalPnL),
          avgPnL: parseFloat(m.avgPnL),
          sharpe: parseFloat(m.sharpe),
          profitFactor: m.profitFactor === 'Inf' ? 99 : parseFloat(m.profitFactor),
          maxDD: parseFloat(m.maxDD),
          avgMFE: parseFloat(m.avgMFE),
          avgMAE: parseFloat(m.avgMAE),
        });
      }
    }
  }

  // Sort by Sharpe
  results.sort((a, b) => b.sharpe - a.sharpe);

  // Print top 40
  console.log('  Top 40 configurations by Sharpe:');
  console.log('  ┌─────────────────────────────────────────┬───────┬────────┬────────┬────────────┬──────────┬─────────┬────────┬────────┐');
  console.log('  │ Strategy                                │ SL/TP │ Exit   │ Trades │ Total PnL  │ Avg PnL  │ Sharpe  │ WR%    │ PF     │');
  console.log('  ├─────────────────────────────────────────┼───────┼────────┼────────┼────────────┼──────────┼─────────┼────────┼────────┤');

  for (let i = 0; i < Math.min(40, results.length); i++) {
    const r = results[i];
    const sltp = r.sl >= 9999 ? 'None' : `${r.sl}/${r.tp}`;
    const exitStr = r.exitHr === 9.5 ? '9:30a' : `${r.exitHr}am`;
    console.log(`  │ ${r.strategy.padEnd(39)} │ ${sltp.padStart(5)} │ ${exitStr.padStart(6)} │ ${String(r.trades).padStart(6)} │ ${r.totalPnL.toFixed(0).padStart(10)} │ ${r.avgPnL.toFixed(1).padStart(8)} │ ${r.sharpe.toFixed(3).padStart(7)} │ ${r.winRate.toFixed(1).padStart(5)}% │ ${(r.profitFactor >= 99 ? 'Inf' : r.profitFactor.toFixed(2)).padStart(6)} │`);
  }
  console.log('  └─────────────────────────────────────────┴───────┴────────┴────────┴────────────┴──────────┴─────────┴────────┴────────┘');

  // Also sort by total PnL and show top 20
  results.sort((a, b) => b.totalPnL - a.totalPnL);
  console.log('\n  Top 20 configurations by Total PnL:');
  console.log('  ┌─────────────────────────────────────────┬───────┬────────┬────────┬────────────┬──────────┬─────────┬────────┬────────┐');
  console.log('  │ Strategy                                │ SL/TP │ Exit   │ Trades │ Total PnL  │ Avg PnL  │ Sharpe  │ WR%    │ PF     │');
  console.log('  ├─────────────────────────────────────────┼───────┼────────┼────────┼────────────┼──────────┼─────────┼────────┼────────┤');

  for (let i = 0; i < Math.min(20, results.length); i++) {
    const r = results[i];
    const sltp = r.sl >= 9999 ? 'None' : `${r.sl}/${r.tp}`;
    const exitStr = r.exitHr === 9.5 ? '9:30a' : `${r.exitHr}am`;
    console.log(`  │ ${r.strategy.padEnd(39)} │ ${sltp.padStart(5)} │ ${exitStr.padStart(6)} │ ${String(r.trades).padStart(6)} │ ${r.totalPnL.toFixed(0).padStart(10)} │ ${r.avgPnL.toFixed(1).padStart(8)} │ ${r.sharpe.toFixed(3).padStart(7)} │ ${r.winRate.toFixed(1).padStart(5)}% │ ${(r.profitFactor >= 99 ? 'Inf' : r.profitFactor.toFixed(2)).padStart(6)} │`);
  }
  console.log('  └─────────────────────────────────────────┴───────┴────────┴────────┴────────────┴──────────┴─────────┴────────┴────────┘');

  return results;
}

// ============================================================================
// ENTRY POINT
// ============================================================================

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  OVERNIGHT COMPOSITE STRATEGY BACKTEST — NQ');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // Load data
  const candles = loadOHLCV();
  const gexData = loadIntradayGEX();
  const dailyGex = loadDailyGEX();
  const ltData = loadLT();

  // Build sessions
  const sessions = buildDailySessions(candles);

  // Quick IBS distribution check
  const ibsValues = sessions.map(s => s.ibs).sort((a, b) => a - b);
  console.log(`\n  IBS distribution: P10=${ibsValues[Math.floor(ibsValues.length * 0.1)].toFixed(3)}, ` +
    `P25=${ibsValues[Math.floor(ibsValues.length * 0.25)].toFixed(3)}, ` +
    `P50=${ibsValues[Math.floor(ibsValues.length * 0.5)].toFixed(3)}, ` +
    `P75=${ibsValues[Math.floor(ibsValues.length * 0.75)].toFixed(3)}, ` +
    `P90=${ibsValues[Math.floor(ibsValues.length * 0.9)].toFixed(3)}`);

  if (SWEEP_MODE) {
    runSweep(sessions, gexData, dailyGex, ltData);
  } else {
    // Run key strategy variants with sensible defaults
    console.log('\n╔══════════════════════════════════════════════════════════════════╗');
    console.log('║  STRATEGY VARIANT COMPARISON                                   ║');
    console.log('╚══════════════════════════════════════════════════════════════════╝');

    const baseParams = {
      stopLossPoints: 70,
      takeProfitPoints: 100,
      exitHourEST: 8,
      trailingTrigger: 0,
      trailingOffset: 0,
      useGexMagnitude: false,
      gexMagnitudeMin: 0,
      ibsLongThreshold: 1.0,
      ibsShortThreshold: 0.0,
      blockedDays: [],
    };

    const variants = [
      // Baseline
      { label: 'Always Long (baseline)', useLT: false, useGexRegime: false, useIBS: false, requireGexConfirmation: false,
        signalOverride: 1 },

      // Single signals
      { label: 'LT Sentiment only', useLT: true, useGexRegime: false, useIBS: false, requireGexConfirmation: false },
      { label: 'GEX Regime only', useLT: false, useGexRegime: true, useIBS: false, requireGexConfirmation: false },

      // Combinations
      { label: 'LT + GEX confirmation', useLT: true, useGexRegime: true, useIBS: false, requireGexConfirmation: true },
      { label: 'LT + IBS<0.3/IBS>0.7', useLT: true, useGexRegime: false, useIBS: true, requireGexConfirmation: false,
        ibsLongThreshold: 0.3, ibsShortThreshold: 0.7 },
      { label: 'LT + IBS<0.5/IBS>0.5', useLT: true, useGexRegime: false, useIBS: true, requireGexConfirmation: false,
        ibsLongThreshold: 0.5, ibsShortThreshold: 0.5 },
      { label: 'LT + GEX + IBS<0.3/>0.7', useLT: true, useGexRegime: true, useIBS: true, requireGexConfirmation: true,
        ibsLongThreshold: 0.3, ibsShortThreshold: 0.7 },

      // Day filters
      { label: 'LT + skip Thursday', useLT: true, useGexRegime: false, useIBS: false, requireGexConfirmation: false,
        blockedDays: ['Thursday'] },
      { label: 'LT + GEX + skip Thursday', useLT: true, useGexRegime: true, useIBS: false, requireGexConfirmation: true,
        blockedDays: ['Thursday'] },

      // Different stop/target
      { label: 'LT only — SL50/TP70', useLT: true, useGexRegime: false, useIBS: false, requireGexConfirmation: false,
        stopLossPoints: 50, takeProfitPoints: 70 },
      { label: 'LT only — SL100/TP150', useLT: true, useGexRegime: false, useIBS: false, requireGexConfirmation: false,
        stopLossPoints: 100, takeProfitPoints: 150 },
      { label: 'LT only — No stop (time exit)', useLT: true, useGexRegime: false, useIBS: false, requireGexConfirmation: false,
        stopLossPoints: 9999, takeProfitPoints: 9999 },

      // Different exit times
      { label: 'LT only — exit 2am', useLT: true, useGexRegime: false, useIBS: false, requireGexConfirmation: false,
        exitHourEST: 2 },
      { label: 'LT only — exit 4am', useLT: true, useGexRegime: false, useIBS: false, requireGexConfirmation: false,
        exitHourEST: 4 },
      { label: 'LT only — exit 9:30am', useLT: true, useGexRegime: false, useIBS: false, requireGexConfirmation: false,
        exitHourEST: 9.5 },
    ];

    for (const variant of variants) {
      const params = { ...baseParams, ...variant };

      let trades;
      if (variant.signalOverride) {
        // Always long baseline
        trades = [];
        for (const session of sessions) {
          trades.push(simulateTrade(session, 'buy', params));
        }
      } else {
        trades = runBacktest(sessions, gexData, dailyGex, ltData, params);
      }

      const metrics = computeMetrics(trades, variant.label);
      printMetrics(metrics);
    }

    // Detailed trade analysis for the best variant
    console.log('\n\n╔══════════════════════════════════════════════════════════════════╗');
    console.log('║  DETAILED ANALYSIS: LT Sentiment (SL70/TP100, exit 8am)       ║');
    console.log('╚══════════════════════════════════════════════════════════════════╝');

    const bestParams = {
      ...baseParams,
      useLT: true, useGexRegime: false, useIBS: false, requireGexConfirmation: false,
    };
    const bestTrades = runBacktest(sessions, gexData, dailyGex, ltData, bestParams);
    const bestMetrics = computeMetrics(bestTrades, 'LT Sentiment — Detailed');
    printMetrics(bestMetrics);

    // Breakdown by LT sentiment direction
    const longTrades = bestTrades.filter(t => t.side === 'buy');
    const shortTrades = bestTrades.filter(t => t.side === 'sell');
    printMetrics(computeMetrics(longTrades, 'BULLISH LT → Long'));
    printMetrics(computeMetrics(shortTrades, 'BEARISH LT → Short'));

    // Breakdown by GEX regime
    console.log('\n  By GEX Regime:');
    for (const regime of ['strong_positive', 'positive', 'neutral', 'negative', 'strong_negative']) {
      const subset = bestTrades.filter(t => t.gexRegime === regime);
      if (subset.length > 5) {
        const m = computeMetrics(subset, `  GEX=${regime}`);
        console.log(`    ${regime.padEnd(18)}: ${subset.length} trades, WR=${m.winRate}%, Avg=${m.avgPnL}pts, Sharpe=${m.sharpe}`);
      }
    }

    // Breakdown by day of week
    console.log('\n  By Day of Week:');
    for (const day of ['Monday', 'Tuesday', 'Wednesday', 'Thursday']) {
      const subset = bestTrades.filter(t => t.dayOfWeek === day);
      if (subset.length > 5) {
        const m = computeMetrics(subset, `  ${day}`);
        console.log(`    ${day.padEnd(12)}: ${subset.length} trades, WR=${m.winRate}%, Avg=${m.avgPnL}pts, Sharpe=${m.sharpe}`);
      }
    }

    // Breakdown by exit reason
    console.log('\n  By Exit Reason:');
    for (const reason of ['stop_loss', 'take_profit', 'time_exit', 'session_end', 'trailing_stop']) {
      const subset = bestTrades.filter(t => t.exitReason === reason);
      if (subset.length > 0) {
        const m = computeMetrics(subset, `  ${reason}`);
        console.log(`    ${reason.padEnd(16)}: ${subset.length} trades, WR=${m.winRate}%, Avg=${m.avgPnL}pts`);
      }
    }

    // Monthly equity curve
    console.log('\n  Monthly PnL:');
    const byMonth = {};
    for (const t of bestTrades) {
      const month = t.date.substring(0, 7);
      if (!byMonth[month]) byMonth[month] = { trades: 0, pnl: 0, wins: 0 };
      byMonth[month].trades++;
      byMonth[month].pnl += t.pointsPnL;
      if (t.pointsPnL > 0) byMonth[month].wins++;
    }
    let cumPnL = 0;
    for (const [month, data] of Object.entries(byMonth).sort()) {
      cumPnL += data.pnl;
      const wr = (data.wins / data.trades * 100).toFixed(0);
      const bar = data.pnl >= 0
        ? '+' + '█'.repeat(Math.min(Math.round(data.pnl / 20), 40))
        : '-' + '█'.repeat(Math.min(Math.round(Math.abs(data.pnl) / 20), 40));
      console.log(`    ${month}: ${String(data.trades).padStart(3)} trades, ${data.pnl.toFixed(0).padStart(8)}pts (WR ${wr.padStart(3)}%), cum: ${cumPnL.toFixed(0).padStart(8)}pts  ${bar}`);
    }
  }

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  BACKTEST COMPLETE');
  console.log('  Run with --sweep for full parameter optimization');
  console.log('═══════════════════════════════════════════════════════════════');
}

main().catch(console.error);
