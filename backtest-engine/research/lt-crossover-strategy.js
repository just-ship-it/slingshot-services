/**
 * LT Crossover Strategy Research
 *
 * Based on finding: LT34/LT55 crossing under spot → bullish, crossing over → bearish.
 * Simultaneous crossings (both within 15m) are strongest (63-65% WR, PF 1.77).
 *
 * Strategy design:
 *
 * LONGS:
 *   - 1 LT crosses under spot → take 1 long at limit = candle open where cross occurred
 *   - 2nd LT crosses under → add 1 more contract (scale in)
 *
 * SHORTS:
 *   - 1 LT crosses over spot → take 1 short at max(open, close) of signal candle
 *   - 2nd LT crosses over → add 1 more contract
 *
 * EXIT:
 *   - Wide 70pt initial stop (NQ needs room)
 *   - MFE ratchet (same as AI trader):
 *       MFE 20pt → lock 25% profit
 *       MFE 40pt → lock 40%
 *       MFE 60pt → lock 50%
 *       MFE 100pt → lock 60%
 *   - Also sweep: fixed targets, time exits, ratchet tier variants
 *
 * Usage: cd backtest-engine && node research/lt-crossover-strategy.js
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
// SESSION + SIGNAL DETECTION
// ============================================================================
function buildNightlySessions(candles, ltRecords) {
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

    // Detect crossing events for this night
    const crossings = [];
    for (let i = 1; i < ltOn.length; i++) {
      const prev = ltOn[i - 1], curr = ltOn[i];
      const pCandle = getPrice(prev.timestamp);
      const cCandle = getPrice(curr.timestamp);
      if (!pCandle || !cCandle) continue;
      const pSpot = (pCandle.high + pCandle.low) / 2;
      const cSpot = (cCandle.high + cCandle.low) / 2;

      for (const [key, name] of [['level_1', 'LT34'], ['level_2', 'LT55']]) {
        const pL = prev[key], cL = curr[key];
        if (pL == null || cL == null) continue;
        const prevAbove = pL > pSpot, currAbove = cL > cSpot;
        if (prevAbove === currAbove) continue;

        const crossDir = (!prevAbove && currAbove) ? 'over' : 'under';
        const crossTs = curr.timestamp;
        const crossIdx = overnight.findIndex(c => c.timestamp >= crossTs);
        if (crossIdx < 0) continue;

        crossings.push({
          level: name,
          dir: crossDir,
          ts: crossTs,
          barIdx: crossIdx,
          estHour: getESTHour(crossTs),
          candleAtCross: overnight[crossIdx],
        });
      }
    }

    sessions.push({ date: today, dayOfWeek: dow, candles: overnight, crossings });
  }

  const totalCrossings = sessions.reduce((s, n) => s + n.crossings.length, 0);
  console.log(`  ${sessions.length} sessions, ${totalCrossings} crossing events\n`);
  return sessions;
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

function applyRatchet(entry, mfe, isLong, tiers) {
  for (const tier of tiers) {
    if (mfe >= tier.minMFE) {
      const locked = mfe * tier.lockPct;
      return roundTick(isLong ? entry + locked : entry - locked);
    }
  }
  return null; // No tier hit
}

// ============================================================================
// TRADE SIMULATOR — supports scaling in (1 or 2 contracts)
// ============================================================================
function simulatePosition(candles, entries, params) {
  // entries: array of { barIdx, side, entryPrice, contracts }
  // side: 'long' or 'short'
  // Returns combined position result

  const {
    initialStopPts = 70,
    ratchetTiers = DEFAULT_RATCHET,
    fixedTarget = 0,      // 0 = no fixed target, use ratchet only
    exitHour = 0,         // 0 = no time exit
    maxBars = 840,
  } = params;

  if (entries.length === 0) return null;

  const side = entries[0].side;
  const isLong = side === 'long';
  const firstEntry = entries[0];
  const startBar = firstEntry.barIdx;

  // Track per-entry state
  const legs = entries.map(e => ({
    entry: e.entryPrice,
    contracts: e.contracts,
    filled: false,
    fillBar: -1,
  }));

  // First leg fills immediately (limit assumed to fill at the bar)
  legs[0].filled = true;
  legs[0].fillBar = startBar;

  let totalContracts = legs[0].contracts;
  let weightedEntry = legs[0].entry;

  // Position state
  let stop = roundTick(isLong ? weightedEntry - initialStopPts : weightedEntry + initialStopPts);
  const target = fixedTarget > 0 ? roundTick(isLong ? weightedEntry + fixedTarget : weightedEntry - fixedTarget) : null;
  let mfe = 0, mae = 0;
  let ratchetStop = null;
  let exitType = 'end';
  let exitBar = startBar;
  let exitPrice = 0;

  for (let j = startBar + 1; j < candles.length && j < startBar + maxBars; j++) {
    const c = candles[j];

    // Check if second leg should fill (limit order)
    for (let li = 1; li < legs.length; li++) {
      if (legs[li].filled) continue;
      if (j > legs[li].barIdx + 5) { legs[li].filled = false; continue; } // Expired after 5 bars
      if (j < legs[li].barIdx) continue;

      const limPrice = legs[li].entry;
      // For limit buys: fill if low <= limit price
      // For limit sells: fill if high >= limit price
      const filled = isLong ? c.low <= limPrice : c.high >= limPrice;
      if (filled) {
        legs[li].filled = true;
        legs[li].fillBar = j;
        // Recalculate weighted average entry
        const prevTotal = weightedEntry * totalContracts;
        totalContracts += legs[li].contracts;
        weightedEntry = roundTick((prevTotal + limPrice * legs[li].contracts) / totalContracts);
        // Recalculate stop from new weighted entry
        stop = roundTick(isLong ? weightedEntry - initialStopPts : weightedEntry + initialStopPts);
        // Recalculate target if applicable
      }
    }

    // Time exit
    if (exitHour > 0 && c.estHour >= exitHour && c.estHour < 18) {
      exitPrice = c.open;
      exitType = 'time';
      exitBar = j;
      break;
    }

    // MFE/MAE based on weighted entry
    const highPnl = isLong ? c.high - weightedEntry : weightedEntry - c.low;
    const lowPnl = isLong ? c.low - weightedEntry : weightedEntry - c.high;
    if (highPnl > mfe) mfe = highPnl;
    const adverse = isLong ? weightedEntry - c.low : c.high - weightedEntry;
    if (adverse > mae) mae = adverse;

    // MFE ratchet — update stop
    const newRatchetStop = applyRatchet(weightedEntry, mfe, isLong, ratchetTiers);
    if (newRatchetStop !== null) {
      if (ratchetStop === null ||
          (isLong && newRatchetStop > ratchetStop) ||
          (!isLong && newRatchetStop < ratchetStop)) {
        ratchetStop = newRatchetStop;
      }
      // Use tighter of initial stop and ratchet stop
      if (isLong && ratchetStop > stop) stop = ratchetStop;
      if (!isLong && ratchetStop < stop) stop = ratchetStop;
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

  // Calculate PnL
  let totalPnl = 0;
  for (const leg of legs) {
    if (!leg.filled) continue;
    const legPnl = isLong ? exitPrice - leg.entry : leg.entry - exitPrice;
    totalPnl += legPnl * leg.contracts;
  }

  const filledContracts = legs.filter(l => l.filled).reduce((s, l) => s + l.contracts, 0);

  return {
    pnl: totalPnl,
    pnlPerContract: filledContracts > 0 ? totalPnl / filledContracts : 0,
    mfe, mae,
    exit: exitType,
    bars: exitBar - startBar,
    exitBar,
    contracts: filledContracts,
    weightedEntry,
    exitPrice,
  };
}

// ============================================================================
// STRATEGY RUNNER
// ============================================================================
function runStrategy(sessions, params) {
  const {
    initialStopPts = 70,
    ratchetTiers = DEFAULT_RATCHET,
    fixedTarget = 0,
    exitHour = 0,
    maxBars = 840,
    requireBoth = false,       // Require both LT34+LT55 before entering
    scaleIn = true,            // Add contract on second crossing
    maxTradesPerNight = 1,     // Number of independent positions per night
    cooldownBars = 30,
    entryMode = 'limit',       // 'limit' for longs (open), 'aggressive' for shorts (max of open/close)
    blockHoursStart = 0,       // Block entries in this hour range
    blockHoursEnd = 0,
  } = params;

  const allTrades = [];

  for (const session of sessions) {
    const { candles, crossings, date, dayOfWeek } = session;
    if (crossings.length === 0) continue;

    let tradesThisNight = 0;
    let lastExitBar = -1;
    let lastTradeBar = -cooldownBars;

    // Track crossings by direction
    const underCrossings = crossings.filter(c => c.dir === 'under').sort((a, b) => a.ts - b.ts);
    const overCrossings = crossings.filter(c => c.dir === 'over').sort((a, b) => a.ts - b.ts);

    // Process long signals (cross_under → buy)
    if (underCrossings.length > 0 && tradesThisNight < maxTradesPerNight) {
      const first = underCrossings[0];
      const second = underCrossings.length > 1 ? underCrossings[1] : null;

      // Check if first crosses within 15min of second (simultaneous)
      const isBothQuick = second && (second.ts - first.ts <= 15 * 60 * 1000);

      if (requireBoth && !isBothQuick) {
        // Skip — need both LT34+LT55 and they didn't cross close together
      } else {
        // Check hour block
        const h = first.estHour;
        const blocked = blockHoursStart > 0 && h >= blockHoursStart && h < blockHoursEnd;

        if (!blocked && first.barIdx > lastExitBar && first.barIdx - lastTradeBar >= cooldownBars) {
          const c = first.candleAtCross;
          const entryPrice = roundTick(c.open); // Limit at open of signal candle

          const entries = [{ barIdx: first.barIdx, side: 'long', entryPrice, contracts: 1 }];

          // Scale in on second crossing
          if (scaleIn && second && second.barIdx > first.barIdx) {
            const c2 = second.candleAtCross;
            entries.push({ barIdx: second.barIdx, side: 'long', entryPrice: roundTick(c2.open), contracts: 1 });
          }

          const result = simulatePosition(candles, entries, { initialStopPts, ratchetTiers, fixedTarget, exitHour, maxBars });
          if (result) {
            allTrades.push({
              ...result,
              date, dayOfWeek,
              side: 'long',
              entryHour: first.estHour,
              crossLevel: first.level,
              scaled: result.contracts > 1,
            });
            tradesThisNight++;
            lastExitBar = result.exitBar;
            lastTradeBar = first.barIdx;
          }
        }
      }
    }

    // Process short signals (cross_over → sell)
    if (overCrossings.length > 0 && tradesThisNight < maxTradesPerNight) {
      const first = overCrossings[0];
      const second = overCrossings.length > 1 ? overCrossings[1] : null;
      const isBothQuick = second && (second.ts - first.ts <= 15 * 60 * 1000);

      if (requireBoth && !isBothQuick) {
        // Skip
      } else {
        const h = first.estHour;
        const blocked = blockHoursStart > 0 && h >= blockHoursStart && h < blockHoursEnd;

        if (!blocked && first.barIdx > lastExitBar && first.barIdx - lastTradeBar >= cooldownBars) {
          const c = first.candleAtCross;
          // Short entry at max(open, close) — get a better price
          const entryPrice = roundTick(Math.max(c.open, c.close));

          const entries = [{ barIdx: first.barIdx, side: 'short', entryPrice, contracts: 1 }];

          if (scaleIn && second && second.barIdx > first.barIdx) {
            const c2 = second.candleAtCross;
            entries.push({ barIdx: second.barIdx, side: 'short', entryPrice: roundTick(Math.max(c2.open, c2.close)), contracts: 1 });
          }

          const result = simulatePosition(candles, entries, { initialStopPts, ratchetTiers, fixedTarget, exitHour, maxBars });
          if (result) {
            allTrades.push({
              ...result,
              date, dayOfWeek,
              side: 'short',
              entryHour: first.estHour,
              crossLevel: first.level,
              scaled: result.contracts > 1,
            });
            tradesThisNight++;
            lastExitBar = result.exitBar;
            lastTradeBar = first.barIdx;
          }
        }
      }
    }
  }

  return allTrades;
}

// ============================================================================
// METRICS
// ============================================================================
function m(trades, label) {
  if (!trades.length) return null;
  const w = trades.filter(t => t.pnl > 0), l = trades.filter(t => t.pnl <= 0);
  const total = trades.reduce((s, t) => s + t.pnl, 0);
  const avg = total / trades.length;
  const totalContracts = trades.reduce((s, t) => s + t.contracts, 0);
  const avgContracts = totalContracts / trades.length;
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
  const scaled = trades.filter(t => t.scaled).length;
  return { label, n: trades.length, wr, total, avg, avgW, avgL, pf, sharpe, mfe, mae, maxDD, eq, exits, avgContracts, scaled };
}

function row(r) {
  if (!r) return;
  const pfStr = r.pf >= 99 ? '  Inf' : r.pf.toFixed(2).padStart(6);
  const exAbbr = { stop: 's', target: 'T', ratchet: 'R', time: 'ti', end: 'e' };
  const exStr = Object.entries(r.exits).map(([k, v]) => `${exAbbr[k] || k[0]}${v}`).join('/');
  console.log(`  ${r.label.padEnd(52)} ${String(r.n).padStart(5)} ${r.wr.toFixed(1).padStart(6)}% ${r.avg.toFixed(1).padStart(7)} ${r.total.toFixed(0).padStart(8)} ${pfStr} ${r.sharpe.toFixed(3).padStart(7)} ${r.maxDD.toFixed(0).padStart(6)} ${r.mfe.toFixed(0).padStart(4)}/${r.mae.toFixed(0).padStart(2)} ${r.avgContracts.toFixed(1).padStart(4)}c ${exStr.padStart(16)}`);
}

function hdr() {
  console.log(`  ${'Config'.padEnd(52)} ${'N'.padStart(5)} ${'WR'.padStart(7)} ${'Avg'.padStart(7)} ${'Total'.padStart(8)} ${'PF'.padStart(6)} ${'Sharpe'.padStart(7)} ${'MaxDD'.padStart(6)} ${'MFE/MAE'.padStart(7)} ${'Ctrs'.padStart(5)} ${'Exits'.padStart(16)}`);
  console.log(`  ${'─'.repeat(52)} ${'─'.repeat(5)} ${'─'.repeat(7)} ${'─'.repeat(7)} ${'─'.repeat(8)} ${'─'.repeat(6)} ${'─'.repeat(7)} ${'─'.repeat(6)} ${'─'.repeat(7)} ${'─'.repeat(5)} ${'─'.repeat(16)}`);
}

function printDetailed(r, trades) {
  if (!r) return;
  console.log(`\n  ═══ ${r.label} ═══`);
  console.log(`  Trades: ${r.n} | WR: ${r.wr.toFixed(1)}% | PF: ${r.pf.toFixed(2)} | Sharpe: ${r.sharpe.toFixed(3)}`);
  console.log(`  Total: ${r.total.toFixed(0)}pts | Avg: ${r.avg.toFixed(1)} | AvgWin: ${r.avgW.toFixed(1)} | AvgLoss: ${r.avgL.toFixed(1)}`);
  console.log(`  MFE: ${r.mfe.toFixed(1)} | MAE: ${r.mae.toFixed(1)} | MaxDD: ${r.maxDD.toFixed(0)} | Equity: ${r.eq.toFixed(0)}`);
  console.log(`  AvgContracts: ${r.avgContracts.toFixed(2)} | Scaled: ${r.scaled}/${r.n}`);
  console.log(`  Exits: ${Object.entries(r.exits).map(([k, v]) => `${k}=${v}`).join(', ')}`);

  if (!trades) return;

  // Monthly
  console.log('\n  Monthly Breakdown:');
  console.log(`  ${'Month'.padEnd(10)} ${'N'.padStart(4)} ${'WR'.padStart(7)} ${'Total'.padStart(8)} ${'Avg'.padStart(7)} ${'Scaled'.padStart(7)}`);
  console.log(`  ${'─'.repeat(10)} ${'─'.repeat(4)} ${'─'.repeat(7)} ${'─'.repeat(8)} ${'─'.repeat(7)} ${'─'.repeat(7)}`);
  const byMonth = {};
  for (const t of trades) { const mo = t.date.substring(0, 7); if (!byMonth[mo]) byMonth[mo] = []; byMonth[mo].push(t); }
  let profMonths = 0, lossMonths = 0;
  for (const mo of Object.keys(byMonth).sort()) {
    const ts = byMonth[mo], n = ts.length;
    const wr = (ts.filter(t => t.pnl > 0).length / n * 100).toFixed(1);
    const total = ts.reduce((s, t) => s + t.pnl, 0);
    const scaled = ts.filter(t => t.scaled).length;
    if (total > 0) profMonths++; else lossMonths++;
    console.log(`  ${mo.padEnd(10)} ${String(n).padStart(4)} ${wr.padStart(6)}% ${total.toFixed(0).padStart(8)} ${(total / n).toFixed(1).padStart(7)} ${String(scaled).padStart(7)}`);
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

  // Scaled vs single
  console.log('\n  Scaled vs Single:');
  for (const [label, filter] of [['Single (1c)', t => !t.scaled], ['Scaled (2c)', t => t.scaled]]) {
    const ts = trades.filter(filter);
    if (ts.length === 0) continue;
    const n = ts.length, wr = (ts.filter(t => t.pnl > 0).length / n * 100).toFixed(1);
    const total = ts.reduce((s, t) => s + t.pnl, 0);
    console.log(`    ${label.padEnd(14)} ${String(n).padStart(4)} ${wr.padStart(6)}% ${total.toFixed(0).padStart(8)} ${(total / n).toFixed(1).padStart(7)}`);
  }

  // Hour of entry
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

  // Exit type breakdown
  console.log('\n  Exit Type PnL:');
  const byExit = {};
  for (const t of trades) { if (!byExit[t.exit]) byExit[t.exit] = []; byExit[t.exit].push(t); }
  for (const [ex, ts] of Object.entries(byExit)) {
    const n = ts.length;
    const total = ts.reduce((s, t) => s + t.pnl, 0);
    const wr = (ts.filter(t => t.pnl > 0).length / n * 100).toFixed(1);
    console.log(`    ${ex.padEnd(10)} ${String(n).padStart(4)} ${wr.padStart(6)}% ${total.toFixed(0).padStart(8)} ${(total / n).toFixed(1).padStart(7)}`);
  }
}

// ============================================================================
// MAIN
// ============================================================================
async function main() {
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  LT CROSSOVER STRATEGY — SCALED ENTRY + MFE RATCHET');
  console.log('═══════════════════════════════════════════════════════════════════\n');

  const { candles, ltRecords } = await loadData();
  const sessions = buildNightlySessions(candles, ltRecords);

  const allResults = [];
  const collect = (config, label) => {
    const t = runStrategy(sessions, config);
    if (t.length >= 10) {
      const met = m(t, label);
      if (met) { allResults.push({ metrics: met, trades: t }); return met; }
    }
    return null;
  };

  // ════════════════════════════════════════════════
  // 1. BASELINE — 70pt stop, MFE ratchet, with and without scaling
  // ════════════════════════════════════════════════
  console.log('╔═══════════════════════════════════════════════════════════════════╗');
  console.log('║  1. BASELINE — 70pt stop + AI-trader MFE ratchet                 ║');
  console.log('╚═══════════════════════════════════════════════════════════════════╝');
  hdr();
  for (const si of [true, false]) {
    for (const rb of [false, true]) {
      const label = `SL70 ratchet ${si ? 'scale' : 'single'} ${rb ? 'bothReq' : 'anyLT'}`;
      const met = collect({ initialStopPts: 70, scaleIn: si, requireBoth: rb, maxTradesPerNight: 2 }, label);
      if (met) row(met);
    }
  }

  // ════════════════════════════════════════════════
  // 2. STOP SIZE SWEEP
  // ════════════════════════════════════════════════
  console.log('\n╔═══════════════════════════════════════════════════════════════════╗');
  console.log('║  2. INITIAL STOP SIZE SWEEP (with ratchet + scaling)              ║');
  console.log('╚═══════════════════════════════════════════════════════════════════╝');
  hdr();
  for (const sl of [30, 40, 50, 60, 70, 80, 100, 120, 150]) {
    const label = `SL${sl} ratchet scale anyLT`;
    const met = collect({ initialStopPts: sl, scaleIn: true, maxTradesPerNight: 2 }, label);
    if (met) row(met);
  }

  // ════════════════════════════════════════════════
  // 3. RATCHET TIER VARIANTS
  // ════════════════════════════════════════════════
  console.log('\n╔═══════════════════════════════════════════════════════════════════╗');
  console.log('║  3. RATCHET TIER VARIANTS                                         ║');
  console.log('╚═══════════════════════════════════════════════════════════════════╝');
  hdr();

  const ratchetVariants = [
    { name: 'AI-default', tiers: DEFAULT_RATCHET },
    { name: 'aggressive', tiers: [
      { minMFE: 80, lockPct: 0.65 }, { minMFE: 50, lockPct: 0.55 },
      { minMFE: 30, lockPct: 0.45 }, { minMFE: 15, lockPct: 0.30 },
    ]},
    { name: 'tight-early', tiers: [
      { minMFE: 60, lockPct: 0.60 }, { minMFE: 40, lockPct: 0.50 },
      { minMFE: 25, lockPct: 0.40 }, { minMFE: 12, lockPct: 0.25 },
    ]},
    { name: 'wide-patient', tiers: [
      { minMFE: 120, lockPct: 0.60 }, { minMFE: 80, lockPct: 0.45 },
      { minMFE: 50, lockPct: 0.30 }, { minMFE: 30, lockPct: 0.15 },
    ]},
    { name: 'breakeven-first', tiers: [
      { minMFE: 100, lockPct: 0.60 }, { minMFE: 60, lockPct: 0.50 },
      { minMFE: 40, lockPct: 0.30 }, { minMFE: 20, lockPct: 0.0 },  // BE at 20
    ]},
    { name: 'no-ratchet', tiers: [] },
  ];

  for (const rv of ratchetVariants) {
    for (const sl of [50, 70, 100]) {
      const label = `SL${sl} ${rv.name}`;
      const tiers = rv.tiers.length > 0 ? rv.tiers : [];
      const met = collect({ initialStopPts: sl, ratchetTiers: tiers, scaleIn: true, maxTradesPerNight: 2 }, label);
      if (met) row(met);
    }
  }

  // ════════════════════════════════════════════════
  // 4. RATCHET + FIXED TARGET COMBO
  // ════════════════════════════════════════════════
  console.log('\n╔═══════════════════════════════════════════════════════════════════╗');
  console.log('║  4. RATCHET + FIXED TARGET COMBO                                  ║');
  console.log('╚═══════════════════════════════════════════════════════════════════╝');
  hdr();
  for (const sl of [50, 70, 100]) {
    for (const tp of [30, 50, 70, 100, 150]) {
      const label = `SL${sl} ratchet+TP${tp} scale`;
      const met = collect({ initialStopPts: sl, fixedTarget: tp, scaleIn: true, maxTradesPerNight: 2 }, label);
      if (met) row(met);
    }
  }

  // ════════════════════════════════════════════════
  // 5. TIME EXIT VARIANTS
  // ════════════════════════════════════════════════
  console.log('\n╔═══════════════════════════════════════════════════════════════════╗');
  console.log('║  5. TIME EXIT VARIANTS                                             ║');
  console.log('╚═══════════════════════════════════════════════════════════════════╝');
  hdr();
  for (const eh of [0, 2, 4, 6, 8]) {
    const ehLabel = eh === 0 ? 'none' : `${eh}AM`;
    const label = `SL70 ratchet scale exit=${ehLabel}`;
    const met = collect({ initialStopPts: 70, scaleIn: true, exitHour: eh, maxTradesPerNight: 2 }, label);
    if (met) row(met);
  }

  // ════════════════════════════════════════════════
  // 6. HOUR BLOCKS
  // ════════════════════════════════════════════════
  console.log('\n╔═══════════════════════════════════════════════════════════════════╗');
  console.log('║  6. HOUR BLOCK FILTER                                              ║');
  console.log('╚═══════════════════════════════════════════════════════════════════╝');
  hdr();
  for (const [bs, be] of [[19, 21], [20, 22], [20, 23], [18, 20]]) {
    const label = `SL70 ratchet scale block ${bs}-${be}EST`;
    const met = collect({ initialStopPts: 70, scaleIn: true, blockHoursStart: bs, blockHoursEnd: be, maxTradesPerNight: 2 }, label);
    if (met) row(met);
  }

  // ════════════════════════════════════════════════
  // 7. MULTI-POSITION PER NIGHT
  // ════════════════════════════════════════════════
  console.log('\n╔═══════════════════════════════════════════════════════════════════╗');
  console.log('║  7. MULTI-POSITION PER NIGHT                                      ║');
  console.log('╚═══════════════════════════════════════════════════════════════════╝');
  hdr();
  for (const mt of [1, 2, 3]) {
    for (const cd of [15, 30, 60]) {
      const label = `SL70 ratchet scale x${mt} cd${cd}`;
      const met = collect({ initialStopPts: 70, scaleIn: true, maxTradesPerNight: mt, cooldownBars: cd }, label);
      if (met) row(met);
    }
  }

  // ════════════════════════════════════════════════
  // LEADERBOARDS
  // ════════════════════════════════════════════════
  console.log('\n\n' + '═'.repeat(75));
  console.log('  LEADERBOARDS');
  console.log('═'.repeat(75));

  const all = allResults.map(r => r.metrics).filter(r => r.n >= 20);
  const seen = new Map();
  for (const r of all) { if (!seen.has(r.label) || r.sharpe > seen.get(r.label).sharpe) seen.set(r.label, r); }
  const deduped = Array.from(seen.values());

  deduped.sort((a, b) => b.sharpe - a.sharpe);
  console.log(`\n  TOP 20 BY SHARPE [${deduped.length} configs]`);
  hdr();
  for (let i = 0; i < Math.min(20, deduped.length); i++) row(deduped[i]);

  deduped.sort((a, b) => b.total - a.total);
  console.log(`\n  TOP 20 BY TOTAL PNL`);
  hdr();
  for (let i = 0; i < Math.min(20, deduped.length); i++) row(deduped[i]);

  deduped.sort((a, b) => b.avg - a.avg);
  console.log(`\n  TOP 20 BY AVG PNL/TRADE`);
  hdr();
  for (let i = 0; i < Math.min(20, deduped.length); i++) row(deduped[i]);

  // ════════════════════════════════════════════════
  // DETAILED ANALYSIS — TOP 3
  // ════════════════════════════════════════════════
  deduped.sort((a, b) => b.sharpe - a.sharpe);
  for (let rank = 0; rank < Math.min(3, deduped.length); rank++) {
    const best = deduped[rank];
    const entry = allResults.find(r => r.metrics.label === best.label);
    if (entry) {
      console.log(`\n${'─'.repeat(75)}`);
      console.log(`  RANK #${rank + 1}`);
      printDetailed(best, entry.trades);
    }
  }

  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('  COMPLETE');
  console.log('═══════════════════════════════════════════════════════════════════');
}

main().catch(console.error);
