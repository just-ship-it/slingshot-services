/**
 * Overnight Strategy Research — Built on Engine Data Pipeline
 *
 * Uses the SAME data loaders as the backtest engine (CSVLoader, GexLoader,
 * LT lookup) so research results match engine execution exactly.
 *
 * Usage: cd backtest-engine && node research/overnight-engine-research.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { CSVLoader } from '../src/data/csv-loader.js';
import { GexLoader } from '../src/data-loaders/gex-loader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'config', 'default.json'), 'utf-8'));

const START = '2023-03-28';
const END = '2025-12-25';

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
// DATA LOADING (same as engine)
// ============================================================================
async function loadAllData() {
  console.log('Loading data using engine pipeline...\n');

  // OHLCV — raw contracts with primary contract filtering (same as --raw-contracts)
  const csvLoader = new CSVLoader(DATA_DIR, CONFIG, { noContinuous: true });
  const startDate = new Date(START);
  const endDate = new Date(END);
  const { candles: rawCandles } = await csvLoader.loadOHLCVData('NQ', startDate, endDate);
  const candles = csvLoader.filterPrimaryContract(rawCandles);
  console.log(`  OHLCV: ${candles.length} candles (raw contracts, primary filtered)`);

  // GEX — 15-min JSON loader (same as engine)
  const gexLoader = new GexLoader(path.join(DATA_DIR, 'gex'), 'NQ');
  await gexLoader.loadDateRange(startDate, endDate);
  console.log(`  GEX: ${gexLoader.sortedTimestamps.length} snapshots`);

  // LT — same CSV loading + timestamp matching as engine
  const ltRecords = await csvLoader.loadLiquidityData('NQ', startDate, endDate);
  // Build timestamp-indexed map (same as engine's lookup.liquidity)
  const ltMap = new Map();
  for (const lt of ltRecords) {
    ltMap.set(lt.timestamp, lt);
  }
  const ltTimestamps = [...ltMap.keys()].sort((a, b) => a - b);
  console.log(`  LT: ${ltTimestamps.length} records`);

  return { candles, gexLoader, ltMap, ltTimestamps };
}

// LT lookup — same 15-min window as engine (backtest-engine.js line 1225)
function getLTForTimestamp(timestamp, ltMap, ltTimestamps) {
  const maxTimeDiff = 15 * 60 * 1000;
  let best = null;
  let bestDiff = Infinity;
  // Binary search for nearby timestamps
  let lo = 0, hi = ltTimestamps.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ltTimestamps[mid] <= timestamp) lo = mid + 1;
    else hi = mid - 1;
  }
  // Check nearby entries
  for (let i = Math.max(0, hi - 2); i <= Math.min(ltTimestamps.length - 1, hi + 2); i++) {
    const diff = Math.abs(timestamp - ltTimestamps[i]);
    if (diff <= maxTimeDiff && diff < bestDiff) {
      bestDiff = diff;
      best = ltMap.get(ltTimestamps[i]);
    }
  }
  return best;
}

// ============================================================================
// SESSION BUILDER
// ============================================================================
function buildSessions(candles, gexLoader, ltMap, ltTimestamps) {
  console.log('\nBuilding overnight sessions...');

  const byDate = {};
  for (const c of candles) {
    const d = getESTDateStr(c.timestamp);
    if (!byDate[d]) byDate[d] = [];
    byDate[d].push({ ...c, estHour: getESTHour(c.timestamp) });
  }

  const dates = Object.keys(byDate).sort();
  const sessions = [];

  for (let i = 0; i < dates.length - 1; i++) {
    const today = dates[i], tomorrow = dates[i + 1];
    const tc = byDate[today] || [], nc = byDate[tomorrow] || [];
    const dayOfWeek = getDayOfWeek(today);
    if (dayOfWeek === 'Friday' || dayOfWeek === 'Saturday') continue;

    const rth = tc.filter(c => c.estHour >= 9.5 && c.estHour < 16);
    if (rth.length < 30) continue;
    const rthClose = rth[rth.length - 1].close;
    const rthHigh = Math.max(...rth.map(c => c.high));
    const rthLow = Math.min(...rth.map(c => c.low));
    const ibs = rthHigh > rthLow ? (rthClose - rthLow) / (rthHigh - rthLow) : 0.5;

    // Overnight candles: 6PM today through 8AM tomorrow
    const on = [...tc.filter(c => c.estHour >= 18), ...nc.filter(c => c.estHour < 8)];
    if (on.length < 30) continue;

    // Get LT and GEX at overnight open (same as engine delivers to strategy)
    const onOpenTs = on[0].timestamp;
    const lt = getLTForTimestamp(onOpenTs, ltMap, ltTimestamps);
    const gex = gexLoader.getGexLevels(new Date(onOpenTs));

    sessions.push({
      date: today, dayOfWeek, rthClose, rthHigh, rthLow, ibs,
      ltSentiment: lt?.sentiment || null,
      gexRegime: gex?.regime || null,
      gexTotalGex: gex?.total_gex || null,
      overnightCandles: on,
      overnightOpen: on[0].open,
    });
  }

  console.log(`  ${sessions.length} sessions built`);
  return sessions;
}

// ============================================================================
// TRADE SIMULATION
// ============================================================================
function simulateFromBar(candles, startIdx, side, sl, tp, maxBars, exitHour) {
  const entry = candles[startIdx].close;
  const isLong = side === 'buy';
  const stop = isLong ? entry - sl : entry + sl;
  const target = tp < 9000 ? (isLong ? entry + tp : entry - tp) : null;
  let mfe = 0, mae = 0;

  for (let j = startIdx + 1; j < candles.length && j < startIdx + maxBars; j++) {
    const c = candles[j];
    if (exitHour && c.estHour >= exitHour && c.estHour < 18) {
      const pnl = isLong ? c.open - entry : entry - c.open;
      return { pnl, mfe, mae, exit: 'time_exit', bars: j - startIdx };
    }
    if (isLong) { mfe = Math.max(mfe, c.high - entry); mae = Math.max(mae, entry - c.low); }
    else { mfe = Math.max(mfe, entry - c.low); mae = Math.max(mae, c.high - entry); }
    if (isLong && c.low <= stop) return { pnl: stop - entry, mfe, mae, exit: 'stop', bars: j - startIdx };
    if (!isLong && c.high >= stop) return { pnl: entry - stop, mfe, mae, exit: 'stop', bars: j - startIdx };
    if (target) {
      if (isLong && c.high >= target) return { pnl: target - entry, mfe, mae, exit: 'target', bars: j - startIdx };
      if (!isLong && c.low <= target) return { pnl: entry - target, mfe, mae, exit: 'target', bars: j - startIdx };
    }
  }
  const last = candles[Math.min(startIdx + maxBars - 1, candles.length - 1)];
  return { pnl: isLong ? last.close - entry : entry - last.close, mfe, mae, exit: 'session_end', bars: maxBars };
}

// ============================================================================
// COMPOSITE STRATEGY
// ============================================================================
function runComposite(sessions, params) {
  const { pullbackPts, pullbackMaxWait, momentumEnabled, momentumLookback, momentumMinMove,
    fallbackEnabled, fallbackAfterBars, stopLoss, exitHour, maxBars, requireGexConfirm } = params;

  const trades = [];
  for (const s of sessions) {
    if (!s.ltSentiment) continue;
    const side = s.ltSentiment === 'BULLISH' ? 'buy' : 'sell';
    const isLong = side === 'buy';

    if (requireGexConfirm) {
      if (!s.gexRegime) continue;
      const posGex = s.gexRegime === 'positive' || s.gexRegime === 'strong_positive';
      const negGex = s.gexRegime === 'negative' || s.gexRegime === 'strong_negative';
      if (isLong && !posGex) continue;
      if (!isLong && !negGex) continue;
    }

    const cn = s.overnightCandles;
    const openPrice = s.overnightOpen;
    let entryBar = null, entryReason = null;

    // Phase 1: Pullback
    if (pullbackPts > 0) {
      for (let j = 1; j < Math.min(pullbackMaxWait, cn.length); j++) {
        if (isLong && cn[j].low <= openPrice - pullbackPts) { entryBar = j; entryReason = 'pullback'; break; }
        if (!isLong && cn[j].high >= openPrice + pullbackPts) { entryBar = j; entryReason = 'pullback'; break; }
      }
    }

    // Phase 2: Momentum
    if (!entryBar && momentumEnabled && cn.length > momentumLookback + 10) {
      const fhr = cn[momentumLookback - 1].close - cn[0].open;
      if (Math.abs(fhr) >= momentumMinMove && (fhr > 0 ? 'buy' : 'sell') === side) {
        entryBar = momentumLookback;
        entryReason = 'momentum';
      }
    }

    // Phase 3: Fallback
    if (!entryBar && fallbackEnabled && cn.length > fallbackAfterBars) {
      entryBar = fallbackAfterBars;
      entryReason = 'fallback';
    }

    if (!entryBar) continue;

    const result = simulateFromBar(cn, entryBar, side, stopLoss, 9999, maxBars, exitHour);
    trades.push({ ...result, date: s.date, side, entryReason, dayOfWeek: s.dayOfWeek,
      lt: s.ltSentiment, gex: s.gexRegime, ibs: s.ibs });
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
  const entries = {}; for (const t of trades) entries[t.entryReason] = (entries[t.entryReason] || 0) + 1;
  const exits = {}; for (const t of trades) exits[t.exit] = (exits[t.exit] || 0) + 1;
  return { label, n: trades.length, wr, total, avg, avgW, avgL, pf, sharpe, std, mfe, mae, maxDD, eq, entries, exits };
}

function printRow(m) {
  if (!m) return;
  const pfStr = m.pf >= 99 ? '  Inf' : m.pf.toFixed(1).padStart(6);
  const entStr = Object.entries(m.entries).map(([k, v]) => `${k[0]}${v}`).join('/');
  console.log(`  ${m.label.padEnd(55)} ${String(m.n).padStart(4)} ${m.wr.toFixed(1).padStart(6)}% ${m.avg.toFixed(1).padStart(7)} ${m.total.toFixed(0).padStart(8)} ${m.sharpe.toFixed(3).padStart(7)} ${pfStr} ${m.maxDD.toFixed(0).padStart(6)} ${entStr.padStart(14)}`);
}

function printMetrics(m) {
  if (!m) { console.log('  No trades'); return; }
  console.log(`\n  ═══ ${m.label} ═══`);
  console.log(`  Trades: ${m.n} | WR: ${m.wr.toFixed(1)}% | PF: ${m.pf === Infinity ? 'Inf' : m.pf.toFixed(2)} | Sharpe: ${m.sharpe.toFixed(3)}`);
  console.log(`  Total: ${m.total.toFixed(0)} pts | Avg: ${m.avg.toFixed(1)} pts | AvgWin: ${m.avgW.toFixed(1)} | AvgLoss: ${m.avgL.toFixed(1)}`);
  console.log(`  MFE: ${m.mfe.toFixed(1)} | MAE: ${m.mae.toFixed(1)} | MaxDD: ${m.maxDD.toFixed(0)} | Equity: ${m.eq.toFixed(0)}`);
  console.log(`  Entries: ${Object.entries(m.entries).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  console.log(`  Exits: ${Object.entries(m.exits).map(([k, v]) => `${k}=${v}`).join(', ')}`);
}

// ============================================================================
// MAIN
// ============================================================================
async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  OVERNIGHT RESEARCH — ENGINE DATA PIPELINE');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const { candles, gexLoader, ltMap, ltTimestamps } = await loadAllData();
  const sessions = buildSessions(candles, gexLoader, ltMap, ltTimestamps);

  // Quick data quality check
  const withLT = sessions.filter(s => s.ltSentiment).length;
  const withGex = sessions.filter(s => s.gexRegime).length;
  const withBoth = sessions.filter(s => s.ltSentiment && s.gexRegime).length;
  console.log(`  Sessions with LT: ${withLT}, with GEX: ${withGex}, with both: ${withBoth}`);

  const header = `  ${'Config'.padEnd(55)} ${'N'.padStart(4)} ${'WR'.padStart(7)} ${'Avg'.padStart(7)} ${'Total'.padStart(8)} ${'Sharpe'.padStart(7)} ${'PF'.padStart(6)} ${'MaxDD'.padStart(6)} ${'Entries'.padStart(14)}`;
  const divider = `  ${'─'.repeat(55)} ${'─'.repeat(4)} ${'─'.repeat(7)} ${'─'.repeat(7)} ${'─'.repeat(8)} ${'─'.repeat(7)} ${'─'.repeat(6)} ${'─'.repeat(6)} ${'─'.repeat(14)}`;

  // ════════════════════════════════════════════════════════════
  // BASELINES
  // ════════════════════════════════════════════════════════════
  console.log('\n╔════════════════════════════════════════════════════════════════╗');
  console.log('║  BASELINES                                                    ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');
  console.log(header); console.log(divider);

  // LT hold only (no GEX filter)
  for (const ex of [2, 4, 8]) {
    for (const sl of [100, 150, 200, 9999]) {
      const t = runComposite(sessions, { pullbackPts: 0, pullbackMaxWait: 0, momentumEnabled: false,
        fallbackEnabled: true, fallbackAfterBars: 0, stopLoss: sl, exitHour: ex, maxBars: 600, requireGexConfirm: false });
      const slStr = sl >= 9999 ? 'None' : String(sl);
      printRow(metrics(t, `LT Hold, SL=${slStr}, ex${ex}am`));
    }
  }

  // ════════════════════════════════════════════════════════════
  // COMPOSITE SWEEP
  // ════════════════════════════════════════════════════════════
  console.log('\n╔════════════════════════════════════════════════════════════════╗');
  console.log('║  COMPOSITE SWEEP                                              ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');

  const results = [];

  for (const pb of [0, 10, 15, 20, 25, 30]) {
    for (const pbWait of pb > 0 ? [120, 180, 240] : [0]) {
      for (const momEnabled of [true, false]) {
        for (const momMin of momEnabled ? [10, 20, 30] : [0]) {
          for (const fbEnabled of [true, false]) {
            for (const fbAfter of fbEnabled ? [0, 60, 120, 180] : [0]) {
              if (pb === 0 && !momEnabled && !fbEnabled) continue;
              for (const sl of [100, 150, 200]) {
                for (const ex of [2, 4]) {
                  for (const gexConfirm of [true, false]) {
                    const t = runComposite(sessions, {
                      pullbackPts: pb, pullbackMaxWait: pbWait,
                      momentumEnabled: momEnabled, momentumLookback: 60, momentumMinMove: momMin,
                      fallbackEnabled: fbEnabled, fallbackAfterBars: fbAfter,
                      stopLoss: sl, exitHour: ex, maxBars: 600, requireGexConfirm: gexConfirm,
                    });
                    if (t.length < 30) continue;
                    const m = metrics(t, '');
                    results.push({ ...m, pb, pbWait, momEnabled, momMin, fbEnabled, fbAfter, sl, ex, gexConfirm });
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  // Top by Sharpe, min 100 trades
  const top100 = results.filter(r => r.n >= 100).sort((a, b) => b.sharpe - a.sharpe);
  console.log(`\n  ═══ TOP 30 BY SHARPE (min 100 trades) ═══  [${top100.length} configs]`);
  console.log(`  ${'PB'.padStart(3)} ${'Wait'.padStart(4)} ${'Mom'.padStart(4)} ${'FB'.padStart(4)} ${'SL'.padStart(4)} ${'Ex'.padStart(3)} ${'GEX'.padStart(4)} ${'N'.padStart(5)} ${'WR%'.padStart(6)} ${'Avg'.padStart(7)} ${'Total'.padStart(8)} ${'Sharpe'.padStart(7)} ${'PF'.padStart(6)} ${'MaxDD'.padStart(6)} ${'Entries'.padStart(16)}`);
  console.log(`  ${'─'.repeat(3)} ${'─'.repeat(4)} ${'─'.repeat(4)} ${'─'.repeat(4)} ${'─'.repeat(4)} ${'─'.repeat(3)} ${'─'.repeat(4)} ${'─'.repeat(5)} ${'─'.repeat(6)} ${'─'.repeat(7)} ${'─'.repeat(8)} ${'─'.repeat(7)} ${'─'.repeat(6)} ${'─'.repeat(6)} ${'─'.repeat(16)}`);
  for (let i = 0; i < Math.min(30, top100.length); i++) {
    const r = top100[i];
    const entStr = Object.entries(r.entries).map(([k, v]) => `${k[0]}${v}`).join('/');
    console.log(`  ${String(r.pb).padStart(3)} ${String(r.pbWait).padStart(4)} ${(r.momEnabled ? String(r.momMin) : '-').padStart(4)} ${(r.fbEnabled ? String(r.fbAfter) : '-').padStart(4)} ${String(r.sl).padStart(4)} ${String(r.ex).padStart(3)} ${(r.gexConfirm ? 'Y' : 'N').padStart(4)} ${String(r.n).padStart(5)} ${r.wr.toFixed(1).padStart(6)} ${r.avg.toFixed(1).padStart(7)} ${r.total.toFixed(0).padStart(8)} ${r.sharpe.toFixed(3).padStart(7)} ${(r.pf >= 99 ? 'Inf' : r.pf.toFixed(1)).padStart(6)} ${r.maxDD.toFixed(0).padStart(6)} ${entStr.padStart(16)}`);
  }

  // Top by Sharpe, min 200 trades
  const top200 = results.filter(r => r.n >= 200).sort((a, b) => b.sharpe - a.sharpe);
  console.log(`\n  ═══ TOP 30 BY SHARPE (min 200 trades, ~1/night) ═══  [${top200.length} configs]`);
  console.log(`  ${'PB'.padStart(3)} ${'Wait'.padStart(4)} ${'Mom'.padStart(4)} ${'FB'.padStart(4)} ${'SL'.padStart(4)} ${'Ex'.padStart(3)} ${'GEX'.padStart(4)} ${'N'.padStart(5)} ${'WR%'.padStart(6)} ${'Avg'.padStart(7)} ${'Total'.padStart(8)} ${'Sharpe'.padStart(7)} ${'PF'.padStart(6)} ${'MaxDD'.padStart(6)} ${'Entries'.padStart(16)}`);
  console.log(`  ${'─'.repeat(3)} ${'─'.repeat(4)} ${'─'.repeat(4)} ${'─'.repeat(4)} ${'─'.repeat(4)} ${'─'.repeat(3)} ${'─'.repeat(4)} ${'─'.repeat(5)} ${'─'.repeat(6)} ${'─'.repeat(7)} ${'─'.repeat(8)} ${'─'.repeat(7)} ${'─'.repeat(6)} ${'─'.repeat(6)} ${'─'.repeat(16)}`);
  for (let i = 0; i < Math.min(30, top200.length); i++) {
    const r = top200[i];
    const entStr = Object.entries(r.entries).map(([k, v]) => `${k[0]}${v}`).join('/');
    console.log(`  ${String(r.pb).padStart(3)} ${String(r.pbWait).padStart(4)} ${(r.momEnabled ? String(r.momMin) : '-').padStart(4)} ${(r.fbEnabled ? String(r.fbAfter) : '-').padStart(4)} ${String(r.sl).padStart(4)} ${String(r.ex).padStart(3)} ${(r.gexConfirm ? 'Y' : 'N').padStart(4)} ${String(r.n).padStart(5)} ${r.wr.toFixed(1).padStart(6)} ${r.avg.toFixed(1).padStart(7)} ${r.total.toFixed(0).padStart(8)} ${r.sharpe.toFixed(3).padStart(7)} ${(r.pf >= 99 ? 'Inf' : r.pf.toFixed(1)).padStart(6)} ${r.maxDD.toFixed(0).padStart(6)} ${entStr.padStart(16)}`);
  }

  // Detailed analysis of the best high-freq config
  if (top200.length > 0) {
    const best = top200[0];
    console.log(`\n\n╔════════════════════════════════════════════════════════════════╗`);
    console.log(`║  DETAILED: PB=${best.pb} W=${best.pbWait} Mom=${best.momEnabled?best.momMin:'-'} FB=${best.fbEnabled?best.fbAfter:'-'} SL=${best.sl} Ex=${best.ex} GEX=${best.gexConfirm?'Y':'N'}`.padEnd(65) + '║');
    console.log(`╚════════════════════════════════════════════════════════════════╝`);

    const trades = runComposite(sessions, {
      pullbackPts: best.pb, pullbackMaxWait: best.pbWait,
      momentumEnabled: best.momEnabled, momentumLookback: 60, momentumMinMove: best.momMin,
      fallbackEnabled: best.fbEnabled, fallbackAfterBars: best.fbAfter,
      stopLoss: best.sl, exitHour: best.ex, maxBars: 600, requireGexConfirm: best.gexConfirm,
    });

    printMetrics(metrics(trades, 'Best High-Freq Config'));

    // By entry reason
    console.log('\n  By Entry Reason:');
    for (const reason of ['pullback', 'momentum', 'fallback']) {
      const sub = trades.filter(t => t.entryReason === reason);
      if (sub.length > 0) {
        const m = metrics(sub, reason);
        console.log(`    ${reason.padEnd(12)}: ${sub.length} trades, WR=${m.wr.toFixed(1)}%, Avg=${m.avg.toFixed(1)}pts, Sharpe=${m.sharpe.toFixed(3)}`);
      }
    }

    // By day
    console.log('\n  By Day:');
    for (const day of ['Monday', 'Tuesday', 'Wednesday', 'Thursday']) {
      const sub = trades.filter(t => t.dayOfWeek === day);
      if (sub.length > 0) {
        const m = metrics(sub, day);
        console.log(`    ${day.padEnd(12)}: ${sub.length} trades, WR=${m.wr.toFixed(1)}%, Avg=${m.avg.toFixed(1)}pts`);
      }
    }

    // By side
    console.log('\n  By Side:');
    for (const side of ['buy', 'sell']) {
      const sub = trades.filter(t => t.side === side);
      if (sub.length > 0) {
        const m = metrics(sub, side);
        console.log(`    ${side.padEnd(6)}: ${sub.length} trades, WR=${m.wr.toFixed(1)}%, Avg=${m.avg.toFixed(1)}pts, Total=${m.total.toFixed(0)}`);
      }
    }

    // Monthly equity
    console.log('\n  Monthly PnL:');
    const byMonth = {};
    for (const t of trades) { const mo = t.date.substring(0, 7); if (!byMonth[mo]) byMonth[mo] = { n: 0, pnl: 0, w: 0 }; byMonth[mo].n++; byMonth[mo].pnl += t.pnl; if (t.pnl > 0) byMonth[mo].w++; }
    let cum = 0;
    for (const [mo, d] of Object.entries(byMonth).sort()) {
      cum += d.pnl;
      const bar = d.pnl >= 0 ? '+' + '█'.repeat(Math.min(Math.round(d.pnl / 20), 40)) : '-' + '█'.repeat(Math.min(Math.round(-d.pnl / 20), 40));
      console.log(`    ${mo}: ${String(d.n).padStart(3)} trades, ${d.pnl.toFixed(0).padStart(7)}pts (WR ${(d.w / d.n * 100).toFixed(0).padStart(3)}%), cum: ${cum.toFixed(0).padStart(8)}  ${bar}`);
    }
  }

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  ENGINE-PIPELINE RESEARCH COMPLETE');
  console.log('═══════════════════════════════════════════════════════════════');
}

main().catch(console.error);
