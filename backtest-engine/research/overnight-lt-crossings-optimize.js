/**
 * Overnight LT Crossing Strategy Optimization
 *
 * Builds on the crossing research findings:
 *   - 3+ fib confluence crossings: 69% WR at 2hr
 *   - Weighted score >= 4, hold to end: 78% WR, 56.6 pts avg
 *   - r=0.41, t=11.96 for weighted score → overnight return
 *
 * Now optimizes: entry timing, stop loss, trailing stops, hold period,
 * score thresholds, and tests on the engine data pipeline.
 *
 * Usage: cd backtest-engine && node research/overnight-lt-crossings-optimize.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { CSVLoader } from '../src/data/csv-loader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'config', 'default.json'), 'utf-8'));

// ============================================================================
// TIMEZONE
// ============================================================================
function isDST(ms) {
  const d = new Date(ms), y = d.getUTCFullYear(), m = d.getUTCMonth();
  if (m >= 3 && m <= 9) return true;
  if (m === 0 || m === 1 || m === 11) return false;
  if (m === 2) { const fd = new Date(Date.UTC(y, 2, 1)).getUTCDay(); return ms >= Date.UTC(y, 2, fd === 0 ? 8 : 15 - fd, 7); }
  if (m === 10) { const fd = new Date(Date.UTC(y, 10, 1)).getUTCDay(); return ms < Date.UTC(y, 10, fd === 0 ? 1 : 8 - fd, 6); }
  return false;
}
function getESTHour(ts) { const d = new Date(ts + (isDST(ts) ? -4 : -5) * 3600000); return d.getUTCHours() + d.getUTCMinutes() / 60; }
function getESTDateStr(ts) { const d = new Date(ts + (isDST(ts) ? -4 : -5) * 3600000); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`; }
function getDayOfWeek(ds) { return new Date(ds + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long' }); }

// ============================================================================
// DATA LOADING
// ============================================================================
async function loadData() {
  console.log('Loading data (raw contracts)...\n');
  const csvLoader = new CSVLoader(DATA_DIR, CONFIG, { noContinuous: true });
  const { candles: rawCandles } = await csvLoader.loadOHLCVData('NQ', new Date('2023-03-28'), new Date('2025-12-25'));
  const candles = csvLoader.filterPrimaryContract(rawCandles);
  console.log(`  OHLCV: ${candles.length} candles`);

  const ltRecords = await csvLoader.loadLiquidityData('NQ', new Date('2023-03-28'), new Date('2025-12-25'));
  console.log(`  LT: ${ltRecords.length} records`);
  return { candles, ltRecords };
}

// ============================================================================
// BUILD NIGHTLY CROSSING SIGNALS WITH CANDLE-LEVEL TRADE DATA
// ============================================================================
function buildNightlySignals(candles, ltRecords) {
  console.log('\nBuilding nightly crossing signals...');

  const priceByTs = new Map();
  for (const c of candles) priceByTs.set(c.timestamp, c);
  function getPrice(ts) {
    if (priceByTs.has(ts)) return priceByTs.get(ts);
    for (let o = 60000; o <= 120000; o += 60000) {
      if (priceByTs.has(ts - o)) return priceByTs.get(ts - o);
      if (priceByTs.has(ts + o)) return priceByTs.get(ts + o);
    }
    return null;
  }

  const ltByDate = {};
  for (const lt of ltRecords) { const d = getESTDateStr(lt.timestamp); if (!ltByDate[d]) ltByDate[d] = []; ltByDate[d].push(lt); }

  const candlesByDate = {};
  for (const c of candles) { const d = getESTDateStr(c.timestamp); if (!candlesByDate[d]) candlesByDate[d] = []; candlesByDate[d].push({ ...c, estHour: getESTHour(c.timestamp) }); }

  const LEVELS = ['level_1', 'level_2', 'level_3', 'level_4', 'level_5'];
  const FIB_WEIGHTS = [1, 1, 2, 3, 4];

  const dates = Object.keys(candlesByDate).sort();
  const nights = [];

  for (let di = 0; di < dates.length - 1; di++) {
    const today = dates[di], tomorrow = dates[di + 1];
    const dayOfWeek = getDayOfWeek(today);
    if (dayOfWeek === 'Friday' || dayOfWeek === 'Saturday') continue;

    const tc = candlesByDate[today] || [], nc = candlesByDate[tomorrow] || [];

    // Full overnight candles (6pm - 8am) for trade simulation
    const overnight = [...tc.filter(c => c.estHour >= 18), ...nc.filter(c => c.estHour < 8)];
    if (overnight.length < 60) continue;

    // LT records overnight
    const ltOvernight = [
      ...(ltByDate[today] || []).filter(lt => getESTHour(lt.timestamp) >= 18),
      ...(ltByDate[tomorrow] || []).filter(lt => getESTHour(lt.timestamp) < 8),
    ].sort((a, b) => a.timestamp - b.timestamp);
    if (ltOvernight.length < 4) continue;

    // Detect all crossings and build running weighted score
    let runningScore = 0;
    const scoreTimeline = []; // {barIdx, score, crossings} at each crossing event
    let firstSignalBar = null;

    for (let i = 1; i < ltOvernight.length; i++) {
      const prev = ltOvernight[i - 1], curr = ltOvernight[i];
      const pPrev = getPrice(prev.timestamp), pCurr = getPrice(curr.timestamp);
      if (!pPrev || !pCurr) continue;
      const spotPrev = (pPrev.high + pPrev.low) / 2;
      const spotCurr = (pCurr.high + pCurr.low) / 2;

      let batchScore = 0;
      let batchCrossings = 0;

      for (let l = 0; l < 5; l++) {
        const lp = prev[LEVELS[l]], lc = curr[LEVELS[l]];
        if (lp == null || lc == null) continue;
        const prevAbove = lp > spotPrev, currAbove = lc > spotCurr;
        if (prevAbove === currAbove) continue;
        const signal = prevAbove && !currAbove ? 1 : -1; // down=bullish, up=bearish
        batchScore += signal * FIB_WEIGHTS[l];
        batchCrossings++;
      }

      if (batchCrossings > 0) {
        runningScore += batchScore;
        const barIdx = overnight.findIndex(c => c.timestamp >= curr.timestamp);
        if (barIdx >= 0) {
          scoreTimeline.push({ barIdx, runningScore, batchScore, batchCrossings, ts: curr.timestamp, estHour: getESTHour(curr.timestamp) });
        }
      }
    }

    if (scoreTimeline.length === 0) continue;

    nights.push({
      date: today, dayOfWeek,
      overnight, scoreTimeline,
      finalScore: runningScore,
    });
  }

  console.log(`  ${nights.length} nights with crossing signals`);
  return nights;
}

// ============================================================================
// TRADE SIMULATOR
// ============================================================================
function simulateTrade(candles, entryBar, side, params) {
  const { stopLoss, trailingTrigger, trailingOffset, exitHour, maxBars } = params;
  const entry = candles[entryBar].close;
  const isLong = side === 'buy';
  const stop = stopLoss < 9000 ? (isLong ? entry - stopLoss : entry + stopLoss) : null;
  let mfe = 0, mae = 0, trailingStop = null;

  for (let j = entryBar + 1; j < candles.length && j < entryBar + maxBars; j++) {
    const c = candles[j];

    // Time exit
    if (exitHour && c.estHour >= exitHour && c.estHour < 18) {
      const pnl = isLong ? c.open - entry : entry - c.open;
      return { pnl, mfe, mae, exit: 'time', bars: j - entryBar, entry, exitPrice: c.open };
    }

    // MFE/MAE
    if (isLong) { mfe = Math.max(mfe, c.high - entry); mae = Math.max(mae, entry - c.low); }
    else { mfe = Math.max(mfe, entry - c.low); mae = Math.max(mae, c.high - entry); }

    // Hard stop
    if (stop) {
      if (isLong && c.low <= stop) return { pnl: stop - entry, mfe, mae, exit: 'stop', bars: j - entryBar, entry, exitPrice: stop };
      if (!isLong && c.high >= stop) return { pnl: entry - stop, mfe, mae, exit: 'stop', bars: j - entryBar, entry, exitPrice: stop };
    }

    // Trailing stop
    if (trailingTrigger > 0 && trailingOffset > 0) {
      const unrealized = isLong ? c.high - entry : entry - c.low;
      if (unrealized >= trailingTrigger) {
        const newTrail = isLong ? c.high - trailingOffset : c.low + trailingOffset;
        if (trailingStop == null || (isLong && newTrail > trailingStop) || (!isLong && newTrail < trailingStop)) {
          trailingStop = newTrail;
        }
      }
      if (trailingStop != null) {
        if (isLong && c.low <= trailingStop) return { pnl: trailingStop - entry, mfe, mae, exit: 'trail', bars: j - entryBar, entry, exitPrice: trailingStop };
        if (!isLong && c.high >= trailingStop) return { pnl: entry - trailingStop, mfe, mae, exit: 'trail', bars: j - entryBar, entry, exitPrice: trailingStop };
      }
    }
  }

  const last = candles[Math.min(entryBar + maxBars - 1, candles.length - 1)];
  return { pnl: isLong ? last.close - entry : entry - last.close, mfe, mae, exit: 'end', bars: maxBars, entry, exitPrice: last.close };
}

// ============================================================================
// STRATEGY RUNNER
// ============================================================================
function runStrategy(nights, params) {
  const { scoreThreshold, entryMode, stopLoss, trailingTrigger, trailingOffset, exitHour, maxBars } = params;

  const trades = [];
  for (const night of nights) {
    const { overnight, scoreTimeline } = night;

    // Find the first moment the score crosses the threshold
    let entryEvent = null;
    for (const ev of scoreTimeline) {
      if (Math.abs(ev.runningScore) >= scoreThreshold) {
        entryEvent = ev;
        break;
      }
    }
    if (!entryEvent) continue;

    // Entry: at the candle where score threshold was reached
    const side = entryEvent.runningScore > 0 ? 'buy' : 'sell';
    const entryBar = entryEvent.barIdx;
    if (entryBar >= overnight.length - 30) continue; // Not enough candles left

    const result = simulateTrade(overnight, entryBar, side, { stopLoss, trailingTrigger, trailingOffset, exitHour, maxBars });

    trades.push({
      ...result, date: night.date, dayOfWeek: night.dayOfWeek, side,
      score: entryEvent.runningScore, entryHour: entryEvent.estHour,
      batchCrossings: entryEvent.batchCrossings,
    });
  }
  return trades;
}

// ============================================================================
// METRICS
// ============================================================================
function metrics(trades, label) {
  if (!trades.length) return null;
  const w = trades.filter(t => t.pnl > 0), l = trades.filter(t => t.pnl <= 0);
  const total = trades.reduce((s, t) => s + t.pnl, 0), avg = total / trades.length;
  const wr = w.length / trades.length * 100;
  const avgW = w.length ? w.reduce((s, t) => s + t.pnl, 0) / w.length : 0;
  const avgL = l.length ? l.reduce((s, t) => s + t.pnl, 0) / l.length : 0;
  const pf = l.length ? w.reduce((s, t) => s + t.pnl, 0) / Math.abs(l.reduce((s, t) => s + t.pnl, 0)) : Infinity;
  const std = Math.sqrt(trades.reduce((s, t) => s + Math.pow(t.pnl - avg, 2), 0) / trades.length);
  const sharpe = std > 0 ? avg / std : 0;
  const mfe = trades.reduce((s, t) => s + t.mfe, 0) / trades.length;
  const mae = trades.reduce((s, t) => s + t.mae, 0) / trades.length;
  let peak = 0, maxDD = 0, eq = 0;
  for (const t of trades) { eq += t.pnl; if (eq > peak) peak = eq; maxDD = Math.max(maxDD, peak - eq); }
  const exits = {}; for (const t of trades) exits[t.exit] = (exits[t.exit] || 0) + 1;
  return { label, n: trades.length, wr, total, avg, avgW, avgL, pf, sharpe, std, mfe, mae, maxDD, eq, exits };
}

function printRow(m) {
  if (!m) return;
  const pfStr = m.pf >= 99 ? '  Inf' : m.pf.toFixed(1).padStart(6);
  const exStr = Object.entries(m.exits).map(([k, v]) => `${k[0]}${v}`).join('/');
  console.log(`  ${m.label.padEnd(52)} ${String(m.n).padStart(4)} ${m.wr.toFixed(1).padStart(6)}% ${m.avg.toFixed(1).padStart(7)} ${m.total.toFixed(0).padStart(8)} ${m.sharpe.toFixed(3).padStart(7)} ${pfStr} ${m.maxDD.toFixed(0).padStart(6)} ${m.mfe.toFixed(0).padStart(5)} ${m.mae.toFixed(0).padStart(5)} ${exStr.padStart(12)}`);
}

function printMetrics(m) {
  if (!m) { console.log('  No trades'); return; }
  console.log(`\n  ═══ ${m.label} ═══`);
  console.log(`  Trades: ${m.n} | WR: ${m.wr.toFixed(1)}% | PF: ${m.pf === Infinity ? 'Inf' : m.pf.toFixed(2)} | Sharpe: ${m.sharpe.toFixed(3)}`);
  console.log(`  Total: ${m.total.toFixed(0)} pts | Avg: ${m.avg.toFixed(1)} pts | AvgWin: ${m.avgW.toFixed(1)} | AvgLoss: ${m.avgL.toFixed(1)}`);
  console.log(`  MFE: ${m.mfe.toFixed(1)} | MAE: ${m.mae.toFixed(1)} | MaxDD: ${m.maxDD.toFixed(0)} | Equity: ${m.eq.toFixed(0)}`);
  console.log(`  Exits: ${Object.entries(m.exits).map(([k, v]) => `${k}=${v}`).join(', ')}`);
}

// ============================================================================
// MAIN
// ============================================================================
async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  OVERNIGHT LT CROSSING STRATEGY OPTIMIZATION');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const { candles, ltRecords } = await loadData();
  const nights = buildNightlySignals(candles, ltRecords);

  const header = `  ${'Config'.padEnd(52)} ${'N'.padStart(4)} ${'WR'.padStart(7)} ${'Avg'.padStart(7)} ${'Total'.padStart(8)} ${'Sharpe'.padStart(7)} ${'PF'.padStart(6)} ${'MaxDD'.padStart(6)} ${'MFE'.padStart(5)} ${'MAE'.padStart(5)} ${'Exits'.padStart(12)}`;
  const divider = `  ${'─'.repeat(52)} ${'─'.repeat(4)} ${'─'.repeat(7)} ${'─'.repeat(7)} ${'─'.repeat(8)} ${'─'.repeat(7)} ${'─'.repeat(6)} ${'─'.repeat(6)} ${'─'.repeat(5)} ${'─'.repeat(5)} ${'─'.repeat(12)}`;

  // ════════════════════════════════════════════════════════════
  // PARAMETER SWEEP
  // ════════════════════════════════════════════════════════════
  console.log('\n╔════════════════════════════════════════════════════════════════╗');
  console.log('║  PARAMETER SWEEP                                              ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');

  const results = [];

  for (const scoreThreshold of [2, 3, 4, 5, 6, 7, 8]) {
    for (const sl of [50, 70, 100, 150, 200, 9999]) {
      for (const [tt, to] of [[0, 0], [20, 10], [30, 15], [40, 20], [50, 25], [70, 30]]) {
        for (const exitHour of [2, 4, 8]) {
          const trades = runStrategy(nights, {
            scoreThreshold, stopLoss: sl,
            trailingTrigger: tt, trailingOffset: to,
            exitHour, maxBars: 840, entryMode: 'threshold',
          });
          if (trades.length < 20) continue;
          const m = metrics(trades, '');
          results.push({ ...m, scoreThreshold, sl, tt, to, exitHour });
        }
      }
    }
  }

  // Top by Sharpe, min 50 trades
  results.sort((a, b) => b.sharpe - a.sharpe);
  const top50 = results.filter(r => r.n >= 50);
  console.log(`\n  ═══ TOP 30 BY SHARPE (min 50 trades) ═══  [${top50.length} configs]`);
  console.log(`  ${'Scr'.padStart(4)} ${'SL'.padStart(5)} ${'Trail'.padStart(7)} ${'Ex'.padStart(3)} ${'N'.padStart(5)} ${'WR%'.padStart(6)} ${'Avg'.padStart(7)} ${'Total'.padStart(8)} ${'Sharpe'.padStart(7)} ${'PF'.padStart(6)} ${'MaxDD'.padStart(6)} ${'MFE'.padStart(5)} ${'MAE'.padStart(5)}`);
  console.log(`  ${'─'.repeat(4)} ${'─'.repeat(5)} ${'─'.repeat(7)} ${'─'.repeat(3)} ${'─'.repeat(5)} ${'─'.repeat(6)} ${'─'.repeat(7)} ${'─'.repeat(8)} ${'─'.repeat(7)} ${'─'.repeat(6)} ${'─'.repeat(6)} ${'─'.repeat(5)} ${'─'.repeat(5)}`);
  for (let i = 0; i < Math.min(30, top50.length); i++) {
    const r = top50[i];
    const slStr = r.sl >= 9999 ? 'None' : String(r.sl);
    const trStr = r.tt > 0 ? `${r.tt}/${r.to}` : 'None';
    console.log(`  ${String(r.scoreThreshold).padStart(4)} ${slStr.padStart(5)} ${trStr.padStart(7)} ${String(r.exitHour).padStart(3)} ${String(r.n).padStart(5)} ${r.wr.toFixed(1).padStart(6)} ${r.avg.toFixed(1).padStart(7)} ${r.total.toFixed(0).padStart(8)} ${r.sharpe.toFixed(3).padStart(7)} ${(r.pf>=99?'Inf':r.pf.toFixed(1)).padStart(6)} ${r.maxDD.toFixed(0).padStart(6)} ${r.mfe.toFixed(0).padStart(5)} ${r.mae.toFixed(0).padStart(5)}`);
  }

  // Top by total PnL, min 100 trades
  const highFreq = results.filter(r => r.n >= 100).sort((a, b) => b.total - a.total);
  console.log(`\n  ═══ TOP 20 BY TOTAL PNL (min 100 trades) ═══  [${highFreq.length} configs]`);
  console.log(`  ${'Scr'.padStart(4)} ${'SL'.padStart(5)} ${'Trail'.padStart(7)} ${'Ex'.padStart(3)} ${'N'.padStart(5)} ${'WR%'.padStart(6)} ${'Avg'.padStart(7)} ${'Total'.padStart(8)} ${'Sharpe'.padStart(7)} ${'PF'.padStart(6)} ${'MaxDD'.padStart(6)}`);
  console.log(`  ${'─'.repeat(4)} ${'─'.repeat(5)} ${'─'.repeat(7)} ${'─'.repeat(3)} ${'─'.repeat(5)} ${'─'.repeat(6)} ${'─'.repeat(7)} ${'─'.repeat(8)} ${'─'.repeat(7)} ${'─'.repeat(6)} ${'─'.repeat(6)}`);
  for (let i = 0; i < Math.min(20, highFreq.length); i++) {
    const r = highFreq[i];
    const slStr = r.sl >= 9999 ? 'None' : String(r.sl);
    const trStr = r.tt > 0 ? `${r.tt}/${r.to}` : 'None';
    console.log(`  ${String(r.scoreThreshold).padStart(4)} ${slStr.padStart(5)} ${trStr.padStart(7)} ${String(r.exitHour).padStart(3)} ${String(r.n).padStart(5)} ${r.wr.toFixed(1).padStart(6)} ${r.avg.toFixed(1).padStart(7)} ${r.total.toFixed(0).padStart(8)} ${r.sharpe.toFixed(3).padStart(7)} ${(r.pf>=99?'Inf':r.pf.toFixed(1)).padStart(6)} ${r.maxDD.toFixed(0).padStart(6)}`);
  }

  // Top by WR, min 50 trades
  const topWR = results.filter(r => r.n >= 50).sort((a, b) => b.wr - a.wr);
  console.log(`\n  ═══ TOP 20 BY WIN RATE (min 50 trades) ═══`);
  console.log(`  ${'Scr'.padStart(4)} ${'SL'.padStart(5)} ${'Trail'.padStart(7)} ${'Ex'.padStart(3)} ${'N'.padStart(5)} ${'WR%'.padStart(6)} ${'Avg'.padStart(7)} ${'Total'.padStart(8)} ${'Sharpe'.padStart(7)} ${'PF'.padStart(6)} ${'MaxDD'.padStart(6)}`);
  console.log(`  ${'─'.repeat(4)} ${'─'.repeat(5)} ${'─'.repeat(7)} ${'─'.repeat(3)} ${'─'.repeat(5)} ${'─'.repeat(6)} ${'─'.repeat(7)} ${'─'.repeat(8)} ${'─'.repeat(7)} ${'─'.repeat(6)} ${'─'.repeat(6)}`);
  for (let i = 0; i < Math.min(20, topWR.length); i++) {
    const r = topWR[i];
    const slStr = r.sl >= 9999 ? 'None' : String(r.sl);
    const trStr = r.tt > 0 ? `${r.tt}/${r.to}` : 'None';
    console.log(`  ${String(r.scoreThreshold).padStart(4)} ${slStr.padStart(5)} ${trStr.padStart(7)} ${String(r.exitHour).padStart(3)} ${String(r.n).padStart(5)} ${r.wr.toFixed(1).padStart(6)} ${r.avg.toFixed(1).padStart(7)} ${r.total.toFixed(0).padStart(8)} ${r.sharpe.toFixed(3).padStart(7)} ${(r.pf>=99?'Inf':r.pf.toFixed(1)).padStart(6)} ${r.maxDD.toFixed(0).padStart(6)}`);
  }

  // ════════════════════════════════════════════════════════════
  // DETAILED ANALYSIS OF BEST CONFIG
  // ════════════════════════════════════════════════════════════
  if (top50.length > 0) {
    const best = top50[0];
    console.log(`\n\n╔════════════════════════════════════════════════════════════════╗`);
    console.log(`║  DETAILED: Score>=${best.scoreThreshold} SL=${best.sl>=9999?'None':best.sl} Trail=${best.tt>0?best.tt+'/'+best.to:'None'} Ex=${best.exitHour}am`.padEnd(65) + '║');
    console.log(`╚════════════════════════════════════════════════════════════════╝`);

    const trades = runStrategy(nights, {
      scoreThreshold: best.scoreThreshold, stopLoss: best.sl,
      trailingTrigger: best.tt, trailingOffset: best.to,
      exitHour: best.exitHour, maxBars: 840,
    });
    printMetrics(metrics(trades, 'Best Config'));

    // By side
    for (const side of ['buy', 'sell']) {
      const sub = trades.filter(t => t.side === side);
      if (sub.length > 5) {
        const m = metrics(sub, `  ${side.toUpperCase()}`);
        console.log(`  ${side.toUpperCase()}: ${sub.length} trades, WR=${m.wr.toFixed(1)}%, Avg=${m.avg.toFixed(1)}, Total=${m.total.toFixed(0)}`);
      }
    }

    // By entry hour
    console.log('\n  By Entry Hour:');
    for (let h = 18; h <= 23; h++) {
      const sub = trades.filter(t => Math.floor(t.entryHour) === h);
      if (sub.length > 3) {
        const m = metrics(sub, `${h}:00`);
        console.log(`    ${h}:00 EST: ${sub.length} trades, WR=${m.wr.toFixed(1)}%, Avg=${m.avg.toFixed(1)}`);
      }
    }
    for (let h = 0; h <= 7; h++) {
      const sub = trades.filter(t => Math.floor(t.entryHour) === h);
      if (sub.length > 3) {
        const m = metrics(sub, `${h}:00`);
        console.log(`    ${h}:00 EST: ${sub.length} trades, WR=${m.wr.toFixed(1)}%, Avg=${m.avg.toFixed(1)}`);
      }
    }

    // By day
    console.log('\n  By Day:');
    for (const day of ['Monday', 'Tuesday', 'Wednesday', 'Thursday']) {
      const sub = trades.filter(t => t.dayOfWeek === day);
      if (sub.length > 3) {
        const m = metrics(sub, day);
        console.log(`    ${day.padEnd(12)}: ${sub.length} trades, WR=${m.wr.toFixed(1)}%, Avg=${m.avg.toFixed(1)}`);
      }
    }

    // Monthly PnL
    console.log('\n  Monthly PnL:');
    const byMonth = {};
    for (const t of trades) { const mo = t.date.substring(0, 7); if (!byMonth[mo]) byMonth[mo] = { n: 0, pnl: 0, w: 0 }; byMonth[mo].n++; byMonth[mo].pnl += t.pnl; if (t.pnl > 0) byMonth[mo].w++; }
    let cum = 0;
    for (const [mo, d] of Object.entries(byMonth).sort()) {
      cum += d.pnl;
      const bar = d.pnl >= 0 ? '+' + '█'.repeat(Math.min(Math.round(d.pnl / 30), 40)) : '-' + '█'.repeat(Math.min(Math.round(-d.pnl / 30), 40));
      console.log(`    ${mo}: ${String(d.n).padStart(3)} trades, ${d.pnl.toFixed(0).padStart(7)}pts (WR ${(d.w / d.n * 100).toFixed(0).padStart(3)}%), cum: ${cum.toFixed(0).padStart(8)}  ${bar}`);
    }
  }

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  OPTIMIZATION COMPLETE');
  console.log('═══════════════════════════════════════════════════════════════');
}

main().catch(console.error);
