/**
 * LT Structure Confirmation Strategy Research
 *
 * The LT34/LT55 crossover research found real edge (64% directional accuracy),
 * but instantaneous crossings are noisy. The REAL signal is LT **trajectory**
 * confirming price **structure**: LT34+LT55 trending down over ~20 bars, then
 * settling below a recent swing low = support confirmation → buy at that support.
 *
 * Core signal: LT slope (linear regression) confirming swing level settlement.
 *
 * Usage: cd backtest-engine && node research/lt-structure-confirm.js
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
function toEST(ts) { return ts + (isDST(ts) ? -4 : -5) * 3600000; }
function getESTHour(ts) { const d = new Date(toEST(ts)); return d.getUTCHours() + d.getUTCMinutes() / 60; }
function getESTDateStr(ts) { const d = new Date(toEST(ts)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`; }
function getESTTimeStr(ts) { const d = new Date(toEST(ts)); return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`; }
function getDayOfWeek(ds) { return new Date(ds + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long' }); }
function isRollWeek(ts) {
  const d = new Date(toEST(ts));
  const month = d.getUTCMonth();
  if (month !== 2 && month !== 5 && month !== 8 && month !== 11) return false;
  const day = d.getUTCDate();
  return day >= 7 && day <= 15;
}
function roundTick(p) { return Math.round(p * 4) / 4; }

// ============================================================================
// LINEAR REGRESSION
// ============================================================================
function linReg(values) {
  const n = values.length;
  if (n < 2) return { slope: 0, rSquared: 0 };
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += values[i];
    sumXY += i * values[i];
    sumX2 += i * i;
    sumY2 += values[i] * values[i];
  }
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return { slope: 0, rSquared: 0 };
  const slope = (n * sumXY - sumX * sumY) / denom;
  const meanY = sumY / n;
  let ssTot = 0, ssRes = 0;
  const intercept = (sumY - slope * sumX) / n;
  for (let i = 0; i < n; i++) {
    const predicted = intercept + slope * i;
    ssRes += (values[i] - predicted) ** 2;
    ssTot += (values[i] - meanY) ** 2;
  }
  const rSquared = ssTot > 0 ? 1 - ssRes / ssTot : 0;
  return { slope, rSquared };
}

// ============================================================================
// SWING LEVEL DETECTION
// ============================================================================
function findSwingLow(candles, fromIdx, toIdx) {
  let low = Infinity;
  for (let i = fromIdx; i <= toIdx && i < candles.length; i++) {
    if (candles[i].low < low) low = candles[i].low;
  }
  return low === Infinity ? null : low;
}

function findSwingHigh(candles, fromIdx, toIdx) {
  let high = -Infinity;
  for (let i = fromIdx; i <= toIdx && i < candles.length; i++) {
    if (candles[i].high > high) high = candles[i].high;
  }
  return high === -Infinity ? null : high;
}

// ============================================================================
// LT CONFIRMATION CHECK
// ============================================================================
function checkLTConfirm(ltSnapshots, idx, swingLevel, params, mode) {
  // mode: 'long' or 'short'
  const { slopeLookback, minSlopeMag, requireBothLT, ltBuffer } = params;

  if (idx < slopeLookback - 1) return null;

  // Gather slope data over lookback
  const lt34Values = [];
  const lt55Values = [];
  for (let i = idx - slopeLookback + 1; i <= idx; i++) {
    if (ltSnapshots[i].level_1 == null || ltSnapshots[i].level_2 == null) return null;
    lt34Values.push(ltSnapshots[i].level_1);
    lt55Values.push(ltSnapshots[i].level_2);
  }

  const lt34Reg = linReg(lt34Values);
  const lt55Reg = linReg(lt55Values);

  // Check slope direction and magnitude
  if (mode === 'long') {
    // For longs: require negative slope (LT trending down toward price)
    const lt34SlopeOk = lt34Reg.slope < 0 && Math.abs(lt34Reg.slope) >= minSlopeMag;
    const lt55SlopeOk = lt55Reg.slope < 0 && Math.abs(lt55Reg.slope) >= minSlopeMag;

    if (requireBothLT) {
      if (!lt34SlopeOk || !lt55SlopeOk) return null;
    } else {
      if (!lt34SlopeOk && !lt55SlopeOk) return null;
    }

    // Check settlement: at least one (or both) of LT34/LT55 at or below swingLevel - buffer
    const threshold = swingLevel - ltBuffer;
    const currLT34 = ltSnapshots[idx].level_1;
    const currLT55 = ltSnapshots[idx].level_2;
    const lt34Below = currLT34 <= threshold;
    const lt55Below = currLT55 <= threshold;

    if (requireBothLT) {
      if (!lt34Below || !lt55Below) return null;
    } else {
      if (!lt34Below && !lt55Below) return null;
    }
  } else {
    // For shorts: require positive slope (LT trending up toward price)
    const lt34SlopeOk = lt34Reg.slope > 0 && Math.abs(lt34Reg.slope) >= minSlopeMag;
    const lt55SlopeOk = lt55Reg.slope > 0 && Math.abs(lt55Reg.slope) >= minSlopeMag;

    if (requireBothLT) {
      if (!lt34SlopeOk || !lt55SlopeOk) return null;
    } else {
      if (!lt34SlopeOk && !lt55SlopeOk) return null;
    }

    // Check settlement: at least one (or both) of LT34/LT55 at or above swingLevel + buffer
    const threshold = swingLevel + ltBuffer;
    const currLT34 = ltSnapshots[idx].level_1;
    const currLT55 = ltSnapshots[idx].level_2;
    const lt34Above = currLT34 >= threshold;
    const lt55Above = currLT55 >= threshold;

    if (requireBothLT) {
      if (!lt34Above || !lt55Above) return null;
    } else {
      if (!lt34Above && !lt55Above) return null;
    }
  }

  return {
    lt34Slope: lt34Reg.slope,
    lt55Slope: lt55Reg.slope,
    lt34R2: lt34Reg.rSquared,
    lt55R2: lt55Reg.rSquared,
  };
}

// ============================================================================
// DATA LOADING
// ============================================================================
async function loadData() {
  console.log('Loading data...');
  const csvLoader = new CSVLoader(DATA_DIR, CONFIG, { noContinuous: true });
  const { candles: raw } = await csvLoader.loadOHLCVData('NQ', new Date('2023-03-28'), new Date('2025-12-25'));
  const candles = csvLoader.filterPrimaryContract(raw);
  const ltRecords = await csvLoader.loadLiquidityData('NQ', new Date('2023-03-28'), new Date('2025-12-25'));
  console.log(`  ${candles.length} candles, ${ltRecords.length} LT records`);
  return { candles, ltRecords };
}

// ============================================================================
// SESSION BUILDING
// ============================================================================
function buildNightlySessions(candles, ltRecords) {
  // Build timestamp → candle index lookup
  const candlesByDate = {};
  for (const c of candles) {
    const d = getESTDateStr(c.timestamp);
    if (!candlesByDate[d]) candlesByDate[d] = [];
    candlesByDate[d].push({ ...c, estHour: getESTHour(c.timestamp) });
  }

  const ltByDate = {};
  for (const lt of ltRecords) {
    const d = getESTDateStr(lt.timestamp);
    if (!ltByDate[d]) ltByDate[d] = [];
    ltByDate[d].push(lt);
  }

  const dates = Object.keys(candlesByDate).sort();
  const sessions = [];

  for (let di = 0; di < dates.length - 1; di++) {
    const today = dates[di], tomorrow = dates[di + 1];
    const dow = getDayOfWeek(today);
    if (['Friday', 'Saturday'].includes(dow)) continue;

    const tc = candlesByDate[today] || [], nc = candlesByDate[tomorrow] || [];
    const overnight = [...tc.filter(c => c.estHour >= 18), ...nc.filter(c => c.estHour < 8)].sort((a, b) => a.timestamp - b.timestamp);
    if (overnight.length < 60) continue;

    const ltOn = [
      ...(ltByDate[today] || []).filter(lt => getESTHour(lt.timestamp) >= 18),
      ...(ltByDate[tomorrow] || []).filter(lt => getESTHour(lt.timestamp) < 8)
    ].sort((a, b) => a.timestamp - b.timestamp);
    if (ltOn.length < 4) continue;
    if (isRollWeek(overnight[0].timestamp)) continue;

    sessions.push({
      date: today,
      dayOfWeek: dow,
      candles: overnight,
      ltSnapshots: ltOn,
    });
  }

  console.log(`  ${sessions.length} sessions\n`);
  return sessions;
}

// ============================================================================
// SIGNAL SCANNING
// ============================================================================
function scanSession(session, params) {
  const { slopeLookback, minSlopeMag, requireBothLT, swingMode, ltBuffer } = params;
  const { candles, ltSnapshots } = session;

  // Build candle timestamp → index lookup
  const tsToIdx = new Map();
  for (let i = 0; i < candles.length; i++) {
    tsToIdx.set(candles[i].timestamp, i);
  }

  // For each LT snapshot, find the closest candle index
  function findCandleIdx(ltTs) {
    if (tsToIdx.has(ltTs)) return tsToIdx.get(ltTs);
    // Search nearby (within 2 min)
    for (let o = 60000; o <= 120000; o += 60000) {
      if (tsToIdx.has(ltTs - o)) return tsToIdx.get(ltTs - o);
      if (tsToIdx.has(ltTs + o)) return tsToIdx.get(ltTs + o);
    }
    // Fallback: find closest
    let bestIdx = -1, bestDist = Infinity;
    for (let i = 0; i < candles.length; i++) {
      const dist = Math.abs(candles[i].timestamp - ltTs);
      if (dist < bestDist) { bestDist = dist; bestIdx = i; }
    }
    return bestDist < 15 * 60 * 1000 ? bestIdx : -1;
  }

  const signals = [];
  let signalledLongTonight = false;
  let signalledShortTonight = false;

  for (let li = 0; li < ltSnapshots.length; li++) {
    if (li < slopeLookback - 1) continue;

    const ltSnap = ltSnapshots[li];
    const candleIdx = findCandleIdx(ltSnap.timestamp);
    if (candleIdx < 0) continue;

    // --- LONG SIGNAL ---
    if (!signalledLongTonight) {
      let swingLevel = null;

      if (swingMode === 'session') {
        swingLevel = findSwingLow(candles, 0, candleIdx);
      } else if (swingMode.startsWith('rolling_')) {
        const rollingBars = parseInt(swingMode.split('_')[1]);
        const fromIdx = Math.max(0, candleIdx - rollingBars);
        swingLevel = findSwingLow(candles, fromIdx, candleIdx);
      }

      if (swingLevel != null) {
        const confirm = checkLTConfirm(ltSnapshots, li, swingLevel, params, 'long');
        if (confirm) {
          signals.push({
            side: 'long',
            entryPrice: roundTick(swingLevel),
            barIdx: candleIdx,
            timestamp: ltSnap.timestamp,
            ...confirm,
            swingLevel,
          });
          signalledLongTonight = true;
        }
      }
    }

    // --- SHORT SIGNAL ---
    if (!signalledShortTonight) {
      let swingLevel = null;

      if (swingMode === 'session') {
        swingLevel = findSwingHigh(candles, 0, candleIdx);
      } else if (swingMode.startsWith('rolling_')) {
        const rollingBars = parseInt(swingMode.split('_')[1]);
        const fromIdx = Math.max(0, candleIdx - rollingBars);
        swingLevel = findSwingHigh(candles, fromIdx, candleIdx);
      }

      if (swingLevel != null) {
        const confirm = checkLTConfirm(ltSnapshots, li, swingLevel, params, 'short');
        if (confirm) {
          signals.push({
            side: 'short',
            entryPrice: roundTick(swingLevel),
            barIdx: candleIdx,
            timestamp: ltSnap.timestamp,
            ...confirm,
            swingLevel,
          });
          signalledShortTonight = true;
        }
      }
    }

    if (signalledLongTonight && signalledShortTonight) break;
  }

  return signals;
}

// ============================================================================
// MFE RATCHET
// ============================================================================
const DEFAULT_RATCHET = [
  { minMFE: 100, lockPct: 0.60 },
  { minMFE: 60,  lockPct: 0.50 },
  { minMFE: 40,  lockPct: 0.40 },
  { minMFE: 20,  lockPct: 0.25 },
];
const TIGHT_EARLY_RATCHET = [
  { minMFE: 60, lockPct: 0.60 },
  { minMFE: 40, lockPct: 0.50 },
  { minMFE: 25, lockPct: 0.40 },
  { minMFE: 12, lockPct: 0.25 },
];

function applyRatchet(entry, mfe, isLong, tiers) {
  for (const tier of tiers) {
    if (mfe >= tier.minMFE) {
      const locked = mfe * tier.lockPct;
      return roundTick(isLong ? entry + locked : entry - locked);
    }
  }
  return null;
}

// ============================================================================
// TRADE SIMULATOR — single contract, limit entry
// ============================================================================
function simulatePosition(candles, signal, params) {
  const {
    initialStopPts = 70,
    ratchetTiers = DEFAULT_RATCHET,
    fixedTarget = 0,
    exitHour = 0,
    maxBars = 840,
    timeoutCandles = 5,
  } = params;

  const isLong = signal.side === 'long';
  const limitPrice = signal.entryPrice;
  const signalBar = signal.barIdx;

  // --- FILL PHASE: wait for limit fill ---
  let fillBar = -1;
  for (let j = signalBar; j < candles.length && j <= signalBar + timeoutCandles; j++) {
    if (isLong && candles[j].low <= limitPrice) { fillBar = j; break; }
    if (!isLong && candles[j].high >= limitPrice) { fillBar = j; break; }
  }
  if (fillBar < 0) return null; // Timeout — no fill

  const entry = limitPrice;
  let stop = roundTick(isLong ? entry - initialStopPts : entry + initialStopPts);
  const target = fixedTarget > 0 ? roundTick(isLong ? entry + fixedTarget : entry - fixedTarget) : null;
  let mfe = 0, mae = 0;
  let ratchetStop = null;
  let exitType = 'end';
  let exitBar = fillBar;
  let exitPrice = 0;

  for (let j = fillBar + 1; j < candles.length && j < fillBar + maxBars; j++) {
    const c = candles[j];

    // Time exit
    if (exitHour > 0 && c.estHour >= exitHour && c.estHour < 18) {
      exitPrice = c.open;
      exitType = 'time';
      exitBar = j;
      break;
    }

    // MFE/MAE
    const highPnl = isLong ? c.high - entry : entry - c.low;
    const lowPnl = isLong ? c.low - entry : entry - c.high;
    if (highPnl > mfe) mfe = highPnl;
    const adverse = isLong ? entry - c.low : c.high - entry;
    if (adverse > mae) mae = adverse;

    // MFE ratchet
    if (ratchetTiers.length > 0) {
      const newRatchetStop = applyRatchet(entry, mfe, isLong, ratchetTiers);
      if (newRatchetStop !== null) {
        if (ratchetStop === null ||
            (isLong && newRatchetStop > ratchetStop) ||
            (!isLong && newRatchetStop < ratchetStop)) {
          ratchetStop = newRatchetStop;
        }
        if (isLong && ratchetStop > stop) stop = ratchetStop;
        if (!isLong && ratchetStop < stop) stop = ratchetStop;
      }
    }

    // Check stop
    if (isLong && c.low <= stop) {
      exitPrice = Math.max(stop, c.low);
      exitType = ratchetStop !== null && stop === ratchetStop ? 'ratchet' : 'stop';
      exitBar = j;
      break;
    }
    if (!isLong && c.high >= stop) {
      exitPrice = Math.min(stop, c.high);
      exitType = ratchetStop !== null && stop === ratchetStop ? 'ratchet' : 'stop';
      exitBar = j;
      break;
    }

    // Check fixed target
    if (target) {
      if (isLong && c.high >= target) { exitPrice = target; exitType = 'target'; exitBar = j; break; }
      if (!isLong && c.low <= target) { exitPrice = target; exitType = 'target'; exitBar = j; break; }
    }

    exitBar = j;
    exitPrice = c.close;
  }

  const pnl = isLong ? exitPrice - entry : entry - exitPrice;

  return {
    pnl,
    mfe, mae,
    exit: exitType,
    bars: exitBar - fillBar,
    exitBar,
    fillBar,
    entry,
    exitPrice,
  };
}

// ============================================================================
// STRATEGY RUNNER
// ============================================================================
function runStrategy(sessions, signalParams, exitParams) {
  const {
    initialStopPts = 70,
    ratchetTiers = DEFAULT_RATCHET,
    fixedTarget = 0,
    exitHour = 0,
    maxBars = 840,
    timeoutCandles = 5,
  } = exitParams;

  const allTrades = [];
  let totalSignals = 0;
  let totalFills = 0;

  for (const session of sessions) {
    const signals = scanSession(session, signalParams);
    totalSignals += signals.length;

    for (const signal of signals) {
      const result = simulatePosition(session.candles, signal, {
        initialStopPts, ratchetTiers, fixedTarget, exitHour, maxBars, timeoutCandles,
      });
      if (result) {
        totalFills++;
        allTrades.push({
          ...result,
          date: session.date,
          dayOfWeek: session.dayOfWeek,
          side: signal.side,
          entryHour: getESTHour(signal.timestamp),
          lt34Slope: signal.lt34Slope,
          lt55Slope: signal.lt55Slope,
          lt34R2: signal.lt34R2,
          lt55R2: signal.lt55R2,
          swingLevel: signal.swingLevel,
          signalTs: signal.timestamp,
        });
      }
    }
  }

  return { trades: allTrades, totalSignals, totalFills };
}

// ============================================================================
// METRICS
// ============================================================================
function m(trades, label) {
  if (!trades.length) return null;
  const w = trades.filter(t => t.pnl > 0), l = trades.filter(t => t.pnl <= 0);
  const total = trades.reduce((s, t) => s + t.pnl, 0);
  const avg = total / trades.length;
  const wr = w.length / trades.length * 100;
  const avgW = w.length ? w.reduce((s, t) => s + t.pnl, 0) / w.length : 0;
  const avgL = l.length ? l.reduce((s, t) => s + t.pnl, 0) / l.length : 0;
  const grossW = w.reduce((s, t) => s + t.pnl, 0);
  const grossL = Math.abs(l.reduce((s, t) => s + t.pnl, 0));
  const pf = grossL > 0 ? grossW / grossL : Infinity;
  const std = Math.sqrt(trades.reduce((s, t) => s + Math.pow(t.pnl - avg, 2), 0) / trades.length);
  const sharpe = std > 0 ? avg / std : 0;
  const mfe = trades.reduce((s, t) => s + t.mfe, 0) / trades.length;
  const mae = trades.reduce((s, t) => s + t.mae, 0) / trades.length;
  let peak = 0, maxDD = 0, eq = 0;
  for (const t of trades) { eq += t.pnl; if (eq > peak) peak = eq; maxDD = Math.max(maxDD, peak - eq); }
  const exits = {}; for (const t of trades) exits[t.exit] = (exits[t.exit] || 0) + 1;
  return { label, n: trades.length, wr, total, avg, avgW, avgL, pf, sharpe, mfe, mae, maxDD, eq, exits };
}

function row(r, extra = '') {
  if (!r) return;
  const pfStr = r.pf >= 99 ? '  Inf' : r.pf.toFixed(2).padStart(6);
  const exAbbr = { stop: 's', target: 'T', ratchet: 'R', time: 'ti', end: 'e' };
  const exStr = Object.entries(r.exits).map(([k, v]) => `${exAbbr[k] || k[0]}${v}`).join('/');
  console.log(`  ${r.label.padEnd(55)} ${String(r.n).padStart(5)} ${r.wr.toFixed(1).padStart(6)}% ${r.avg.toFixed(1).padStart(7)} ${r.total.toFixed(0).padStart(8)} ${pfStr} ${r.sharpe.toFixed(3).padStart(7)} ${r.maxDD.toFixed(0).padStart(6)} ${r.mfe.toFixed(0).padStart(4)}/${r.mae.toFixed(0).padStart(2)} ${exStr.padStart(16)}${extra}`);
}

function hdr() {
  console.log(`  ${'Config'.padEnd(55)} ${'N'.padStart(5)} ${'WR'.padStart(7)} ${'Avg'.padStart(7)} ${'Total'.padStart(8)} ${'PF'.padStart(6)} ${'Sharpe'.padStart(7)} ${'MaxDD'.padStart(6)} ${'MFE/MAE'.padStart(7)} ${'Exits'.padStart(16)}`);
  console.log(`  ${'─'.repeat(55)} ${'─'.repeat(5)} ${'─'.repeat(7)} ${'─'.repeat(7)} ${'─'.repeat(8)} ${'─'.repeat(6)} ${'─'.repeat(7)} ${'─'.repeat(6)} ${'─'.repeat(7)} ${'─'.repeat(16)}`);
}

function printDetailed(r, trades) {
  if (!r) return;
  console.log(`\n  ═══ ${r.label} ═══`);
  console.log(`  Trades: ${r.n} | WR: ${r.wr.toFixed(1)}% | PF: ${r.pf.toFixed(2)} | Sharpe: ${r.sharpe.toFixed(3)}`);
  console.log(`  Total: ${r.total.toFixed(0)}pts | Avg: ${r.avg.toFixed(1)} | AvgWin: ${r.avgW.toFixed(1)} | AvgLoss: ${r.avgL.toFixed(1)}`);
  console.log(`  MFE: ${r.mfe.toFixed(1)} | MAE: ${r.mae.toFixed(1)} | MaxDD: ${r.maxDD.toFixed(0)} | Equity: ${r.eq.toFixed(0)}`);
  console.log(`  Exits: ${Object.entries(r.exits).map(([k, v]) => `${k}=${v}`).join(', ')}`);

  if (!trades) return;

  // Monthly
  console.log('\n  Monthly Breakdown:');
  console.log(`  ${'Month'.padEnd(10)} ${'N'.padStart(4)} ${'WR'.padStart(7)} ${'Total'.padStart(8)} ${'Avg'.padStart(7)}`);
  console.log(`  ${'─'.repeat(10)} ${'─'.repeat(4)} ${'─'.repeat(7)} ${'─'.repeat(8)} ${'─'.repeat(7)}`);
  const byMonth = {};
  for (const t of trades) { const mo = t.date.substring(0, 7); if (!byMonth[mo]) byMonth[mo] = []; byMonth[mo].push(t); }
  let profMonths = 0, lossMonths = 0;
  for (const mo of Object.keys(byMonth).sort()) {
    const ts = byMonth[mo], n = ts.length;
    const wr = (ts.filter(t => t.pnl > 0).length / n * 100).toFixed(1);
    const total = ts.reduce((s, t) => s + t.pnl, 0);
    if (total > 0) profMonths++; else lossMonths++;
    console.log(`  ${mo.padEnd(10)} ${String(n).padStart(4)} ${wr.padStart(6)}% ${total.toFixed(0).padStart(8)} ${(total / n).toFixed(1).padStart(7)}`);
  }
  console.log(`  Profitable months: ${profMonths}/${profMonths + lossMonths} (${(profMonths / (profMonths + lossMonths) * 100).toFixed(0)}%)`);

  // Day of week
  console.log('\n  Day-of-Week:');
  const byDow = {};
  for (const t of trades) { if (!byDow[t.dayOfWeek]) byDow[t.dayOfWeek] = []; byDow[t.dayOfWeek].push(t); }
  for (const dow of ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday']) {
    const ts = byDow[dow]; if (!ts) continue;
    const n = ts.length, wr = (ts.filter(t => t.pnl > 0).length / n * 100).toFixed(1);
    const total = ts.reduce((s, t) => s + t.pnl, 0);
    console.log(`    ${dow.padEnd(12)} ${String(n).padStart(4)} ${wr.padStart(6)}% ${total.toFixed(0).padStart(8)} ${(total / n).toFixed(1).padStart(7)}`);
  }

  // Long vs short
  console.log('\n  Side Breakdown:');
  for (const side of ['long', 'short']) {
    const ts = trades.filter(t => t.side === side);
    if (ts.length === 0) continue;
    const n = ts.length, wr = (ts.filter(t => t.pnl > 0).length / n * 100).toFixed(1);
    const total = ts.reduce((s, t) => s + t.pnl, 0);
    const avgPnl = total / n;
    console.log(`    ${side.padEnd(8)} ${String(n).padStart(4)} ${wr.padStart(6)}% ${total.toFixed(0).padStart(8)} ${avgPnl.toFixed(1).padStart(7)}`);
  }

  // Entry hour
  console.log('\n  Entry Hour:');
  const byHour = {};
  for (const t of trades) { const h = Math.floor(t.entryHour); if (!byHour[h]) byHour[h] = []; byHour[h].push(t); }
  const sortedH = Object.keys(byHour).map(Number).sort((a, b) => (a < 12 ? a + 24 : a) - (b < 12 ? b + 24 : b));
  for (const h of sortedH) {
    const ts = byHour[h]; if (ts.length < 3) continue;
    const n = ts.length, wr = (ts.filter(t => t.pnl > 0).length / n * 100).toFixed(1);
    const total = ts.reduce((s, t) => s + t.pnl, 0);
    console.log(`    ${String(h).padStart(2)}:00  ${String(n).padStart(4)} ${wr.padStart(6)}% ${total.toFixed(0).padStart(8)} ${(total / n).toFixed(1).padStart(7)}`);
  }

  // Exit type PnL
  console.log('\n  Exit Type PnL:');
  const byExit = {};
  for (const t of trades) { if (!byExit[t.exit]) byExit[t.exit] = []; byExit[t.exit].push(t); }
  for (const [ex, ts] of Object.entries(byExit)) {
    const n = ts.length;
    const total = ts.reduce((s, t) => s + t.pnl, 0);
    const wr = (ts.filter(t => t.pnl > 0).length / n * 100).toFixed(1);
    console.log(`    ${ex.padEnd(10)} ${String(n).padStart(4)} ${wr.padStart(6)}% ${total.toFixed(0).padStart(8)} ${(total / n).toFixed(1).padStart(7)}`);
  }

  // Fill rate
  console.log('\n  Fill Rate Info:');
  console.log(`    (Fill rate tracked at the strategy-runner level — see summary tables)`);

  // Sample trades
  console.log('\n  Sample Trades (first 10):');
  console.log(`  ${'Date'.padEnd(12)} ${'Side'.padEnd(6)} ${'Entry'.padStart(9)} ${'Exit'.padStart(9)} ${'PnL'.padStart(7)} ${'Type'.padEnd(8)} ${'Bars'.padStart(5)} ${'Time(EST)'.padStart(10)} ${'Swing'.padStart(9)} ${'LT34slp'.padStart(8)} ${'LT55slp'.padStart(8)}`);
  console.log(`  ${'─'.repeat(12)} ${'─'.repeat(6)} ${'─'.repeat(9)} ${'─'.repeat(9)} ${'─'.repeat(7)} ${'─'.repeat(8)} ${'─'.repeat(5)} ${'─'.repeat(10)} ${'─'.repeat(9)} ${'─'.repeat(8)} ${'─'.repeat(8)}`);
  for (let i = 0; i < Math.min(10, trades.length); i++) {
    const t = trades[i];
    const timeStr = getESTTimeStr(t.signalTs);
    console.log(`  ${t.date.padEnd(12)} ${t.side.padEnd(6)} ${t.entry.toFixed(2).padStart(9)} ${t.exitPrice.toFixed(2).padStart(9)} ${t.pnl.toFixed(1).padStart(7)} ${t.exit.padEnd(8)} ${String(t.bars).padStart(5)} ${timeStr.padStart(10)} ${t.swingLevel.toFixed(2).padStart(9)} ${t.lt34Slope.toFixed(2).padStart(8)} ${t.lt55Slope.toFixed(2).padStart(8)}`);
  }
}

// ============================================================================
// MAIN
// ============================================================================
async function main() {
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  LT STRUCTURE CONFIRMATION — TRAJECTORY + SWING LEVEL');
  console.log('═══════════════════════════════════════════════════════════════════\n');

  const { candles, ltRecords } = await loadData();
  const sessions = buildNightlySessions(candles, ltRecords);

  // ════════════════════════════════════════════════════════════════════════
  // PHASE A — Signal param sweep (fix exits at SL70 + default ratchet)
  // ════════════════════════════════════════════════════════════════════════
  console.log('╔═══════════════════════════════════════════════════════════════════╗');
  console.log('║  PHASE A — SIGNAL PARAMETER SWEEP                                ║');
  console.log('║  Fixed exits: SL70 + default ratchet                             ║');
  console.log('╚═══════════════════════════════════════════════════════════════════╝\n');

  const slopeLookbacks = [8, 12, 16, 20];
  const minSlopeMags = [0.5, 1.0, 1.5, 2.0];
  const requireBothOpts = [true, false];
  const swingModes = ['session', 'rolling_30', 'rolling_60', 'rolling_120'];
  const ltBuffers = [0, 5, 10];

  const defaultExitParams = {
    initialStopPts: 70,
    ratchetTiers: DEFAULT_RATCHET,
    fixedTarget: 0,
    exitHour: 0,
    timeoutCandles: 5,
  };

  const phaseAResults = [];
  let configCount = 0;
  const totalConfigs = slopeLookbacks.length * minSlopeMags.length * requireBothOpts.length * swingModes.length * ltBuffers.length;

  hdr();

  for (const slopeLookback of slopeLookbacks) {
    for (const minSlopeMag of minSlopeMags) {
      for (const requireBothLT of requireBothOpts) {
        for (const swingMode of swingModes) {
          for (const ltBuffer of ltBuffers) {
            configCount++;
            if (configCount % 50 === 0) {
              process.stdout.write(`  ... ${configCount}/${totalConfigs} configs\r`);
            }

            const signalParams = { slopeLookback, minSlopeMag, requireBothLT, swingMode, ltBuffer };
            const { trades, totalSignals, totalFills } = runStrategy(sessions, signalParams, defaultExitParams);

            if (trades.length >= 10) {
              const bothStr = requireBothLT ? 'both' : 'any';
              const label = `lb${slopeLookback} slp${minSlopeMag} ${bothStr} ${swingMode} buf${ltBuffer}`;
              const met = m(trades, label);
              if (met) {
                const fillRate = totalSignals > 0 ? (totalFills / totalSignals * 100).toFixed(0) : '0';
                phaseAResults.push({
                  metrics: met,
                  trades,
                  signalParams,
                  totalSignals,
                  totalFills,
                  fillRate,
                });
                row(met, `  ${totalFills}/${totalSignals} (${fillRate}%)`);
              }
            }
          }
        }
      }
    }
  }

  console.log(`\n  Phase A complete: ${phaseAResults.length} viable configs from ${totalConfigs} tested\n`);

  // Rank by Sharpe, collect top 10
  phaseAResults.sort((a, b) => b.metrics.sharpe - a.metrics.sharpe);
  const top10Signal = phaseAResults.slice(0, 10);

  console.log('  TOP 10 SIGNAL CONFIGS BY SHARPE:');
  hdr();
  for (const r of top10Signal) {
    row(r.metrics, `  ${r.totalFills}/${r.totalSignals} (${r.fillRate}%)`);
  }

  // ════════════════════════════════════════════════════════════════════════
  // PHASE B — Exit param sweep on top 10 signal configs
  // ════════════════════════════════════════════════════════════════════════
  console.log('\n╔═══════════════════════════════════════════════════════════════════╗');
  console.log('║  PHASE B — EXIT PARAMETER SWEEP (top 10 signal configs)          ║');
  console.log('╚═══════════════════════════════════════════════════════════════════╝\n');

  const stopPtsList = [50, 70, 100];
  const ratchetVariants = [
    { name: 'default', tiers: DEFAULT_RATCHET },
    { name: 'tight', tiers: TIGHT_EARLY_RATCHET },
    { name: 'none', tiers: [] },
  ];
  const fixedTargets = [0, 30, 50, 70];
  const exitHours = [0, 4, 8];

  const phaseBResults = [];
  let bCount = 0;
  const totalB = top10Signal.length * stopPtsList.length * ratchetVariants.length * fixedTargets.length * exitHours.length;

  hdr();

  for (let si = 0; si < top10Signal.length; si++) {
    const sigConfig = top10Signal[si];
    const sp = sigConfig.signalParams;
    const bothStr = sp.requireBothLT ? 'both' : 'any';
    const sigLabel = `lb${sp.slopeLookback} slp${sp.minSlopeMag} ${bothStr} ${sp.swingMode} buf${sp.ltBuffer}`;

    for (const stopPts of stopPtsList) {
      for (const rv of ratchetVariants) {
        for (const fixedTarget of fixedTargets) {
          for (const exitHour of exitHours) {
            bCount++;
            if (bCount % 50 === 0) {
              process.stdout.write(`  ... ${bCount}/${totalB} configs\r`);
            }

            const exitParams = {
              initialStopPts: stopPts,
              ratchetTiers: rv.tiers,
              fixedTarget,
              exitHour,
              timeoutCandles: 5,
            };

            const { trades, totalSignals, totalFills } = runStrategy(sessions, sp, exitParams);

            if (trades.length >= 10) {
              const ehStr = exitHour > 0 ? `ex${exitHour}` : 'noEx';
              const tpStr = fixedTarget > 0 ? `TP${fixedTarget}` : 'noTP';
              const label = `#${si + 1} SL${stopPts} ${rv.name} ${tpStr} ${ehStr}`;
              const met = m(trades, label);
              if (met) {
                const fillRate = totalSignals > 0 ? (totalFills / totalSignals * 100).toFixed(0) : '0';
                phaseBResults.push({
                  metrics: met,
                  trades,
                  signalParams: sp,
                  exitParams,
                  sigLabel,
                  totalSignals,
                  totalFills,
                  fillRate,
                });
                row(met, `  ${totalFills}/${totalSignals} (${fillRate}%)`);
              }
            }
          }
        }
      }
    }
  }

  console.log(`\n  Phase B complete: ${phaseBResults.length} viable configs from ${totalB} tested\n`);

  // ════════════════════════════════════════════════════════════════════════
  // PHASE C — Time/day analysis on best combined configs
  // ════════════════════════════════════════════════════════════════════════
  console.log('╔═══════════════════════════════════════════════════════════════════╗');
  console.log('║  PHASE C — TIME / DAY ANALYSIS (top configs)                     ║');
  console.log('╚═══════════════════════════════════════════════════════════════════╝\n');

  // Combine all results and rank
  const allCombined = [...phaseAResults.map(r => ({
    ...r,
    sigLabel: r.metrics.label,
    exitParams: defaultExitParams,
  })), ...phaseBResults];

  // Deduplicate by label, keep best sharpe
  const seen = new Map();
  for (const r of allCombined) {
    const key = r.metrics.label;
    if (!seen.has(key) || r.metrics.sharpe > seen.get(key).metrics.sharpe) {
      seen.set(key, r);
    }
  }
  const deduped = Array.from(seen.values());

  // Top 5 by Sharpe for Phase C analysis
  deduped.sort((a, b) => b.metrics.sharpe - a.metrics.sharpe);
  const top5 = deduped.slice(0, 5);

  for (let i = 0; i < top5.length; i++) {
    const cfg = top5[i];
    const trades = cfg.trades;
    console.log(`\n  ─── Config #${i + 1}: ${cfg.metrics.label} ───`);
    console.log(`  Signal: ${cfg.sigLabel || cfg.metrics.label}`);
    if (cfg.exitParams) {
      const ep = cfg.exitParams;
      console.log(`  Exit: SL${ep.initialStopPts} | Ratchet: ${ep.ratchetTiers.length > 0 ? 'yes' : 'none'} | TP: ${ep.fixedTarget || 'none'} | TimeExit: ${ep.exitHour || 'none'}`);
    }
    console.log(`  Fill rate: ${cfg.totalFills}/${cfg.totalSignals} (${cfg.fillRate}%)`);

    // Day-of-week breakdown
    console.log('\n  Day-of-Week:');
    console.log(`    ${'Day'.padEnd(12)} ${'N'.padStart(4)} ${'WR'.padStart(7)} ${'Total'.padStart(8)} ${'Avg'.padStart(7)}`);
    const byDow = {};
    for (const t of trades) { if (!byDow[t.dayOfWeek]) byDow[t.dayOfWeek] = []; byDow[t.dayOfWeek].push(t); }
    for (const dow of ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday']) {
      const ts = byDow[dow]; if (!ts) continue;
      const n = ts.length, wr = (ts.filter(t => t.pnl > 0).length / n * 100).toFixed(1);
      const total = ts.reduce((s, t) => s + t.pnl, 0);
      console.log(`    ${dow.padEnd(12)} ${String(n).padStart(4)} ${wr.padStart(6)}% ${total.toFixed(0).padStart(8)} ${(total / n).toFixed(1).padStart(7)}`);
    }

    // Entry hour breakdown
    console.log('\n  Entry Hour:');
    console.log(`    ${'Hour'.padEnd(8)} ${'N'.padStart(4)} ${'WR'.padStart(7)} ${'Total'.padStart(8)} ${'Avg'.padStart(7)}`);
    const byHour = {};
    for (const t of trades) { const h = Math.floor(t.entryHour); if (!byHour[h]) byHour[h] = []; byHour[h].push(t); }
    const sortedH = Object.keys(byHour).map(Number).sort((a, b) => (a < 12 ? a + 24 : a) - (b < 12 ? b + 24 : b));
    for (const h of sortedH) {
      const ts = byHour[h];
      const n = ts.length, wr = (ts.filter(t => t.pnl > 0).length / n * 100).toFixed(1);
      const total = ts.reduce((s, t) => s + t.pnl, 0);
      console.log(`    ${String(h).padStart(2)}:00    ${String(n).padStart(4)} ${wr.padStart(6)}% ${total.toFixed(0).padStart(8)} ${(total / n).toFixed(1).padStart(7)}`);
    }

    // Side breakdown
    console.log('\n  Side:');
    for (const side of ['long', 'short']) {
      const ts = trades.filter(t => t.side === side);
      if (ts.length === 0) continue;
      const n = ts.length, wr = (ts.filter(t => t.pnl > 0).length / n * 100).toFixed(1);
      const total = ts.reduce((s, t) => s + t.pnl, 0);
      console.log(`    ${side.padEnd(8)} ${String(n).padStart(4)} ${wr.padStart(6)}% ${total.toFixed(0).padStart(8)} ${(total / n).toFixed(1).padStart(7)}`);
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // LEADERBOARDS
  // ════════════════════════════════════════════════════════════════════════
  console.log('\n\n' + '═'.repeat(80));
  console.log('  LEADERBOARDS');
  console.log('═'.repeat(80));

  const allMetrics = deduped.map(r => r.metrics).filter(r => r.n >= 20);

  allMetrics.sort((a, b) => b.sharpe - a.sharpe);
  console.log(`\n  TOP 20 BY SHARPE [${allMetrics.length} configs with n>=20]`);
  hdr();
  for (let i = 0; i < Math.min(20, allMetrics.length); i++) row(allMetrics[i]);

  allMetrics.sort((a, b) => b.total - a.total);
  console.log(`\n  TOP 20 BY TOTAL PNL`);
  hdr();
  for (let i = 0; i < Math.min(20, allMetrics.length); i++) row(allMetrics[i]);

  allMetrics.sort((a, b) => b.avg - a.avg);
  console.log(`\n  TOP 20 BY AVG PNL/TRADE`);
  hdr();
  for (let i = 0; i < Math.min(20, allMetrics.length); i++) row(allMetrics[i]);

  // ════════════════════════════════════════════════════════════════════════
  // DETAILED ANALYSIS — TOP 3
  // ════════════════════════════════════════════════════════════════════════
  deduped.sort((a, b) => b.metrics.sharpe - a.metrics.sharpe);
  const top3 = deduped.filter(r => r.metrics.n >= 20).slice(0, 3);

  for (let rank = 0; rank < top3.length; rank++) {
    const entry = top3[rank];
    console.log(`\n${'─'.repeat(80)}`);
    console.log(`  RANK #${rank + 1}`);
    if (entry.sigLabel) console.log(`  Signal config: ${entry.sigLabel}`);
    if (entry.exitParams) {
      const ep = entry.exitParams;
      console.log(`  Exit config: SL${ep.initialStopPts} | Ratchet: ${ep.ratchetTiers.length > 0 ? 'yes' : 'none'} | TP: ${ep.fixedTarget || 'none'} | TimeExit: ${ep.exitHour || 'none'}`);
    }
    console.log(`  Fill rate: ${entry.totalFills}/${entry.totalSignals} (${entry.fillRate}%)`);
    printDetailed(entry.metrics, entry.trades);
  }

  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('  COMPLETE');
  console.log('═══════════════════════════════════════════════════════════════════');
}

main().catch(console.error);
