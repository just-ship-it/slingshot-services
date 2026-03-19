/**
 * LT34/LT55 Crossover Research
 *
 * Question: When LT34 (level_1) or LT55 (level_2) cross over or under spot
 * price during the overnight session, is that predictive of subsequent
 * upside or downside?
 *
 * "Cross over spot" = level was below price, now above → level moved UP through price
 * "Cross under spot" = level was above price, now below → level moved DOWN through price
 *
 * For each crossing event, measure:
 *   - Forward returns at 15m, 30m, 1h, 2h, 4h, and to 8AM
 *   - MFE/MAE over those windows
 *   - Win rate if fading or following the cross direction
 *   - Breakdown by hour, day-of-week, combined LT34+LT55
 *
 * Usage: cd backtest-engine && node research/lt34-lt55-crossover.js
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
// SESSION + CROSSING DETECTION
// ============================================================================
function detectCrossingEvents(candles, ltRecords) {
  // Index candles by timestamp for fast lookup
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

  // Group LT by EST date
  const ltByDate = {};
  for (const lt of ltRecords) {
    const d = getESTDateStr(lt.timestamp);
    if (!ltByDate[d]) ltByDate[d] = [];
    ltByDate[d].push(lt);
  }

  // Group candles by EST date
  const candlesByDate = {};
  for (const c of candles) {
    const d = getESTDateStr(c.timestamp);
    if (!candlesByDate[d]) candlesByDate[d] = [];
    candlesByDate[d].push({ ...c, estHour: getESTHour(c.timestamp) });
  }

  const dates = Object.keys(candlesByDate).sort();
  const events = [];

  for (let di = 0; di < dates.length - 1; di++) {
    const today = dates[di], tomorrow = dates[di + 1];
    const dow = getDayOfWeek(today);
    if (['Friday', 'Saturday'].includes(dow)) continue;

    // Build overnight candle array (6PM - 8AM)
    const tc = candlesByDate[today] || [], nc = candlesByDate[tomorrow] || [];
    const overnight = [
      ...tc.filter(c => c.estHour >= 18),
      ...nc.filter(c => c.estHour < 8)
    ].sort((a, b) => a.timestamp - b.timestamp);
    if (overnight.length < 60) continue;

    // Get overnight LT snapshots
    const ltOn = [
      ...(ltByDate[today] || []).filter(lt => getESTHour(lt.timestamp) >= 18),
      ...(ltByDate[tomorrow] || []).filter(lt => getESTHour(lt.timestamp) < 8)
    ].sort((a, b) => a.timestamp - b.timestamp);
    if (ltOn.length < 4) continue;

    // Skip roll weeks
    if (isRollWeek(overnight[0].timestamp)) continue;

    // Detect crossings between consecutive LT snapshots
    for (let i = 1; i < ltOn.length; i++) {
      const prev = ltOn[i - 1], curr = ltOn[i];
      const pCandle = getPrice(prev.timestamp);
      const cCandle = getPrice(curr.timestamp);
      if (!pCandle || !cCandle) continue;

      const pSpot = (pCandle.high + pCandle.low) / 2;
      const cSpot = (cCandle.high + cCandle.low) / 2;

      // Check LT34 (level_1) and LT55 (level_2)
      for (const [levelKey, levelName] of [['level_1', 'LT34'], ['level_2', 'LT55']]) {
        const pLevel = prev[levelKey];
        const cLevel = curr[levelKey];
        if (pLevel == null || cLevel == null) continue;

        const prevAbove = pLevel > pSpot;
        const currAbove = cLevel > cSpot;
        if (prevAbove === currAbove) continue; // No crossing

        // Cross direction:
        //   "cross_over" = level moved from below spot to above spot (level rose through price)
        //   "cross_under" = level moved from above spot to below spot (level dropped through price)
        const crossDir = (!prevAbove && currAbove) ? 'cross_over' : 'cross_under';

        // Find the candle index in overnight array closest to crossing time
        const crossTs = curr.timestamp;
        let crossIdx = overnight.findIndex(c => c.timestamp >= crossTs);
        if (crossIdx < 0) continue;

        events.push({
          date: today,
          dayOfWeek: dow,
          level: levelName,
          crossDir,
          crossTs,
          crossIdx,
          crossHour: getESTHour(crossTs),
          spotAtCross: cSpot,
          levelAtCross: cLevel,
          overnight,
          // Also note what the OTHER level is doing at this moment
          otherLevel: levelName === 'LT34' ? cLevel : curr.level_1,
          lt34: curr.level_1,
          lt55: curr.level_2,
          lt34AboveSpot: curr.level_1 > cSpot,
          lt55AboveSpot: curr.level_2 > cSpot,
        });
      }
    }
  }

  console.log(`  ${events.length} total crossing events detected\n`);
  return events;
}

// ============================================================================
// FORWARD RETURN MEASUREMENT
// ============================================================================
function measureForwardReturns(events) {
  const windows = [
    { name: '15m', bars: 15 },
    { name: '30m', bars: 30 },
    { name: '1h', bars: 60 },
    { name: '2h', bars: 120 },
    { name: '4h', bars: 240 },
    { name: 'to8AM', bars: 0 },  // special: until 8AM
  ];

  for (const ev of events) {
    const { overnight, crossIdx } = ev;
    const entryPrice = overnight[crossIdx].close;
    ev.entryPrice = entryPrice;
    ev.returns = {};

    for (const w of windows) {
      let endIdx;
      if (w.bars === 0) {
        // Find 8AM
        endIdx = overnight.length - 1;
        for (let j = crossIdx + 1; j < overnight.length; j++) {
          if (overnight[j].estHour >= 8) { endIdx = j; break; }
        }
      } else {
        endIdx = Math.min(crossIdx + w.bars, overnight.length - 1);
      }

      if (endIdx <= crossIdx) {
        ev.returns[w.name] = { ret: 0, mfe: 0, mae: 0, bars: 0 };
        continue;
      }

      const exitPrice = overnight[endIdx].close;
      const ret = exitPrice - entryPrice;

      // MFE/MAE
      let mfeUp = 0, mfeDown = 0;
      for (let j = crossIdx + 1; j <= endIdx; j++) {
        const upside = overnight[j].high - entryPrice;
        const downside = entryPrice - overnight[j].low;
        if (upside > mfeUp) mfeUp = upside;
        if (downside > mfeDown) mfeDown = downside;
      }

      ev.returns[w.name] = {
        ret,
        mfeUp,
        mfeDown,
        bars: endIdx - crossIdx,
      };
    }
  }
}

// ============================================================================
// ANALYSIS HELPERS
// ============================================================================
function analyzeGroup(events, label, windowName = '1h') {
  if (events.length === 0) return null;

  const rets = events.map(e => e.returns[windowName]?.ret ?? 0);
  const n = rets.length;
  const avg = rets.reduce((s, r) => s + r, 0) / n;
  const median = [...rets].sort((a, b) => a - b)[Math.floor(n / 2)];
  const std = Math.sqrt(rets.reduce((s, r) => s + Math.pow(r - avg, 2), 0) / n);
  const upPct = rets.filter(r => r > 0).length / n * 100;
  const downPct = rets.filter(r => r < 0).length / n * 100;
  const avgUp = rets.filter(r => r > 0);
  const avgDown = rets.filter(r => r < 0);
  const meanUp = avgUp.length ? avgUp.reduce((s, r) => s + r, 0) / avgUp.length : 0;
  const meanDown = avgDown.length ? avgDown.reduce((s, r) => s + r, 0) / avgDown.length : 0;
  const avgMfeUp = events.reduce((s, e) => s + (e.returns[windowName]?.mfeUp ?? 0), 0) / n;
  const avgMfeDown = events.reduce((s, e) => s + (e.returns[windowName]?.mfeDown ?? 0), 0) / n;

  return { label, n, avg, median, std, upPct, downPct, meanUp, meanDown, avgMfeUp, avgMfeDown };
}

function printAnalysis(result) {
  if (!result) return;
  const { label, n, avg, median, std, upPct, meanUp, meanDown, avgMfeUp, avgMfeDown } = result;
  console.log(`  ${label.padEnd(45)} n=${String(n).padStart(4)}  avg=${avg >= 0 ? '+' : ''}${avg.toFixed(1).padStart(6)}  med=${median >= 0 ? '+' : ''}${median.toFixed(1).padStart(6)}  up=${upPct.toFixed(0).padStart(3)}%  avgW=${('+' + meanUp.toFixed(1)).padStart(6)}  avgL=${meanDown.toFixed(1).padStart(7)}  MFE↑=${avgMfeUp.toFixed(1).padStart(5)} MFE↓=${avgMfeDown.toFixed(1).padStart(5)}`);
}

// ============================================================================
// TRADE SIMULATION
// ============================================================================
function simulateTrades(events, side, params) {
  const { stopPts, targetPts, trailTrigger = 0, trailOffset = 0, maxBars = 600 } = params;
  const trades = [];

  for (const ev of events) {
    const { overnight, crossIdx } = ev;
    const entry = overnight[crossIdx].close;
    const isLong = side === 'long';
    let stop = isLong ? entry - stopPts : entry + stopPts;
    const target = targetPts > 0 ? (isLong ? entry + targetPts : entry - targetPts) : null;
    let mfe = 0, mae = 0, trailActive = false;

    let pnl = 0, exit = 'end', bars = 0;
    for (let j = crossIdx + 1; j < overnight.length && j < crossIdx + maxBars; j++) {
      const c = overnight[j];
      const highPnl = isLong ? c.high - entry : entry - c.low;
      if (highPnl > mfe) mfe = highPnl;
      const adverse = isLong ? entry - c.low : c.high - entry;
      if (adverse > mae) mae = adverse;

      if (trailTrigger > 0 && mfe >= trailTrigger) {
        trailActive = true;
        const hwm = isLong ? entry + mfe : entry - mfe;
        const newTrail = isLong ? hwm - trailOffset : hwm + trailOffset;
        if (isLong && newTrail > stop) stop = newTrail;
        if (!isLong && newTrail < stop) stop = newTrail;
      }

      if (isLong && c.low <= stop) { pnl = Math.max(stop, c.low) - entry; exit = trailActive ? 'trail' : 'stop'; bars = j - crossIdx; break; }
      if (!isLong && c.high >= stop) { pnl = entry - Math.min(stop, c.high); exit = trailActive ? 'trail' : 'stop'; bars = j - crossIdx; break; }
      if (target) {
        if (isLong && c.high >= target) { pnl = targetPts; exit = 'target'; bars = j - crossIdx; break; }
        if (!isLong && c.low <= target) { pnl = targetPts; exit = 'target'; bars = j - crossIdx; break; }
      }
      bars = j - crossIdx;
      pnl = isLong ? c.close - entry : entry - c.close;
    }

    trades.push({ pnl, mfe, mae, exit, bars, date: ev.date, dayOfWeek: ev.dayOfWeek, level: ev.level, crossDir: ev.crossDir, crossHour: ev.crossHour });
  }
  return trades;
}

function tradeMetrics(trades, label) {
  if (!trades.length) return null;
  const w = trades.filter(t => t.pnl > 0), l = trades.filter(t => t.pnl <= 0);
  const total = trades.reduce((s, t) => s + t.pnl, 0), avg = total / trades.length;
  const wr = w.length / trades.length * 100;
  const avgW = w.length ? w.reduce((s, t) => s + t.pnl, 0) / w.length : 0;
  const avgL = l.length ? l.reduce((s, t) => s + t.pnl, 0) / l.length : 0;
  const grossW = w.reduce((s, t) => s + t.pnl, 0);
  const grossL = Math.abs(l.reduce((s, t) => s + t.pnl, 0));
  const pf = grossL > 0 ? grossW / grossL : Infinity;
  const mfe = trades.reduce((s, t) => s + t.mfe, 0) / trades.length;
  const mae = trades.reduce((s, t) => s + t.mae, 0) / trades.length;
  let peak = 0, maxDD = 0, eq = 0;
  for (const t of trades) { eq += t.pnl; if (eq > peak) peak = eq; maxDD = Math.max(maxDD, peak - eq); }
  const exits = {}; for (const t of trades) exits[t.exit] = (exits[t.exit] || 0) + 1;
  return { label, n: trades.length, wr, total, avg, avgW, avgL, pf, mfe, mae, maxDD, eq, exits };
}

function printTrade(r) {
  if (!r) return;
  const pfStr = r.pf >= 99 ? '  Inf' : r.pf.toFixed(2).padStart(6);
  const exAbbr = { stop: 's', target: 'T', trail: 'tr', time: 'ti', end: 'e' };
  const exStr = Object.entries(r.exits).map(([k, v]) => `${exAbbr[k] || k[0]}${v}`).join('/');
  console.log(`  ${r.label.padEnd(50)} ${String(r.n).padStart(5)} ${r.wr.toFixed(1).padStart(6)}% ${r.avg.toFixed(1).padStart(7)} ${r.total.toFixed(0).padStart(8)} ${pfStr} ${r.maxDD.toFixed(0).padStart(6)} ${r.mfe.toFixed(0).padStart(5)}/${r.mae.toFixed(0).padStart(2)} ${exStr.padStart(14)}`);
}

function printTradeHeader() {
  console.log(`  ${'Config'.padEnd(50)} ${'N'.padStart(5)} ${'WR'.padStart(7)} ${'Avg'.padStart(7)} ${'Total'.padStart(8)} ${'PF'.padStart(6)} ${'MaxDD'.padStart(6)} ${'MFE/MAE'.padStart(7)} ${'Exits'.padStart(14)}`);
  console.log(`  ${'─'.repeat(50)} ${'─'.repeat(5)} ${'─'.repeat(7)} ${'─'.repeat(7)} ${'─'.repeat(8)} ${'─'.repeat(6)} ${'─'.repeat(6)} ${'─'.repeat(7)} ${'─'.repeat(14)}`);
}

// ============================================================================
// MAIN
// ============================================================================
async function main() {
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  LT34 / LT55 CROSSOVER RESEARCH');
  console.log('═══════════════════════════════════════════════════════════════════\n');

  const { candles, ltRecords } = await loadData();
  const events = detectCrossingEvents(candles, ltRecords);

  // Measure forward returns for all events
  measureForwardReturns(events);

  // ════════════════════════════════════════════════════════════════════
  // 1. RAW CROSSING STATISTICS
  // ════════════════════════════════════════════════════════════════════
  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║  1. RAW CROSSING STATISTICS — forward returns from crossing point    ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');

  const lt34Over = events.filter(e => e.level === 'LT34' && e.crossDir === 'cross_over');
  const lt34Under = events.filter(e => e.level === 'LT34' && e.crossDir === 'cross_under');
  const lt55Over = events.filter(e => e.level === 'LT55' && e.crossDir === 'cross_over');
  const lt55Under = events.filter(e => e.level === 'LT55' && e.crossDir === 'cross_under');

  console.log(`\n  Event counts: LT34_over=${lt34Over.length}, LT34_under=${lt34Under.length}, LT55_over=${lt55Over.length}, LT55_under=${lt55Under.length}`);

  for (const windowName of ['15m', '30m', '1h', '2h', '4h', 'to8AM']) {
    console.log(`\n  ── Forward returns: ${windowName} ──`);
    printAnalysis(analyzeGroup(lt34Over, 'LT34 cross OVER spot (level↑)', windowName));
    printAnalysis(analyzeGroup(lt34Under, 'LT34 cross UNDER spot (level↓)', windowName));
    printAnalysis(analyzeGroup(lt55Over, 'LT55 cross OVER spot (level↑)', windowName));
    printAnalysis(analyzeGroup(lt55Under, 'LT55 cross UNDER spot (level↓)', windowName));
    // Combined
    const bothOver = events.filter(e => e.crossDir === 'cross_over');
    const bothUnder = events.filter(e => e.crossDir === 'cross_under');
    printAnalysis(analyzeGroup(bothOver, 'ANY cross OVER spot', windowName));
    printAnalysis(analyzeGroup(bothUnder, 'ANY cross UNDER spot', windowName));
  }

  // ════════════════════════════════════════════════════════════════════
  // 2. BOTH LT34 + LT55 SAME SIDE — does confluence matter?
  // ════════════════════════════════════════════════════════════════════
  console.log('\n╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║  2. CONFLUENCE: both LT34 and LT55 on same side of spot              ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');

  // After a crossing, check if both levels are now on same side
  const bothAbove = events.filter(e => e.lt34AboveSpot && e.lt55AboveSpot);
  const bothBelow = events.filter(e => !e.lt34AboveSpot && !e.lt55AboveSpot);
  const mixed = events.filter(e => e.lt34AboveSpot !== e.lt55AboveSpot);

  for (const windowName of ['30m', '1h', '2h', 'to8AM']) {
    console.log(`\n  ── ${windowName} ──`);
    printAnalysis(analyzeGroup(bothAbove, 'Both LT34+LT55 ABOVE spot', windowName));
    printAnalysis(analyzeGroup(bothBelow, 'Both LT34+LT55 BELOW spot', windowName));
    printAnalysis(analyzeGroup(mixed, 'LT34 and LT55 on DIFFERENT sides', windowName));
  }

  // ════════════════════════════════════════════════════════════════════
  // 3. HOUR-OF-NIGHT BREAKDOWN
  // ════════════════════════════════════════════════════════════════════
  console.log('\n╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║  3. HOUR-OF-NIGHT BREAKDOWN (1h forward return)                      ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');

  for (const [subset, subLabel] of [[lt34Under, 'LT34 cross_under'], [lt55Under, 'LT55 cross_under'], [lt34Over, 'LT34 cross_over'], [lt55Over, 'LT55 cross_over']]) {
    console.log(`\n  ── ${subLabel} by hour ──`);
    const byHour = {};
    for (const e of subset) {
      let h = Math.floor(e.crossHour);
      if (!byHour[h]) byHour[h] = [];
      byHour[h].push(e);
    }
    const sortedHours = Object.keys(byHour).map(Number).sort((a, b) => (a < 12 ? a + 24 : a) - (b < 12 ? b + 24 : b));
    for (const h of sortedHours) {
      const evts = byHour[h];
      if (evts.length < 5) continue;
      printAnalysis(analyzeGroup(evts, `  ${h}:00 EST`, '1h'));
    }
  }

  // ════════════════════════════════════════════════════════════════════
  // 4. DAY-OF-WEEK BREAKDOWN
  // ════════════════════════════════════════════════════════════════════
  console.log('\n╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║  4. DAY-OF-WEEK BREAKDOWN (1h forward return)                        ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');

  for (const [subset, subLabel] of [[lt34Under, 'LT34 cross_under'], [lt55Under, 'LT55 cross_under'], [lt34Over, 'LT34 cross_over'], [lt55Over, 'LT55 cross_over']]) {
    console.log(`\n  ── ${subLabel} by day ──`);
    for (const dow of ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday']) {
      const evts = subset.filter(e => e.dayOfWeek === dow);
      if (evts.length < 5) continue;
      printAnalysis(analyzeGroup(evts, `  ${dow}`, '1h'));
    }
  }

  // ════════════════════════════════════════════════════════════════════
  // 5. FIRST CROSSING OF NIGHT vs SUBSEQUENT
  // ════════════════════════════════════════════════════════════════════
  console.log('\n╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║  5. FIRST CROSSING vs SUBSEQUENT (per night)                         ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');

  // Group events by date and level
  const byDateLevel = {};
  for (const e of events) {
    const key = `${e.date}_${e.level}`;
    if (!byDateLevel[key]) byDateLevel[key] = [];
    byDateLevel[key].push(e);
  }

  const firstEvents = [];
  const laterEvents = [];
  for (const evts of Object.values(byDateLevel)) {
    evts.sort((a, b) => a.crossTs - b.crossTs);
    firstEvents.push(evts[0]);
    for (let i = 1; i < evts.length; i++) laterEvents.push(evts[i]);
  }

  for (const windowName of ['30m', '1h', '2h', 'to8AM']) {
    console.log(`\n  ── ${windowName} ──`);
    const firstUnder = firstEvents.filter(e => e.crossDir === 'cross_under');
    const firstOver = firstEvents.filter(e => e.crossDir === 'cross_over');
    const laterUnder = laterEvents.filter(e => e.crossDir === 'cross_under');
    const laterOver = laterEvents.filter(e => e.crossDir === 'cross_over');
    printAnalysis(analyzeGroup(firstUnder, 'FIRST cross_under of night', windowName));
    printAnalysis(analyzeGroup(laterUnder, 'SUBSEQUENT cross_under', windowName));
    printAnalysis(analyzeGroup(firstOver, 'FIRST cross_over of night', windowName));
    printAnalysis(analyzeGroup(laterOver, 'SUBSEQUENT cross_over', windowName));
  }

  // ════════════════════════════════════════════════════════════════════
  // 6. SIMULTANEOUS LT34+LT55 CROSSING (same snapshot)
  // ════════════════════════════════════════════════════════════════════
  console.log('\n╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║  6. SIMULTANEOUS LT34+LT55 CROSSING (within 15min)                   ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');

  // Find events where both LT34 and LT55 crossed in same direction within 15 minutes
  const lt34Events = events.filter(e => e.level === 'LT34');
  const lt55Events = events.filter(e => e.level === 'LT55');

  const simultaneousPairs = [];
  for (const e34 of lt34Events) {
    for (const e55 of lt55Events) {
      if (e34.date !== e55.date) continue;
      if (e34.crossDir !== e55.crossDir) continue;
      if (Math.abs(e34.crossTs - e55.crossTs) > 15 * 60 * 1000) continue; // within 15 min
      // Use the later one as the "signal" timestamp
      const signal = e34.crossTs > e55.crossTs ? e34 : e55;
      simultaneousPairs.push(signal);
      break; // only count first match per LT34 event
    }
  }

  console.log(`\n  ${simultaneousPairs.length} simultaneous LT34+LT55 crossings found`);
  const simOver = simultaneousPairs.filter(e => e.crossDir === 'cross_over');
  const simUnder = simultaneousPairs.filter(e => e.crossDir === 'cross_under');

  for (const windowName of ['30m', '1h', '2h', 'to8AM']) {
    console.log(`\n  ── ${windowName} ──`);
    printAnalysis(analyzeGroup(simOver, 'Simultaneous cross OVER', windowName));
    printAnalysis(analyzeGroup(simUnder, 'Simultaneous cross UNDER', windowName));
  }

  // ════════════════════════════════════════════════════════════════════
  // 7. TRADE SIMULATION — test if crossings are tradeable
  // ════════════════════════════════════════════════════════════════════
  console.log('\n╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║  7. TRADE SIMULATION                                                  ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');

  // Theory: "cross_under" = level dropped through price = support forming = BULLISH
  //         "cross_over"  = level rose through price = resistance forming = BEARISH
  // (This matches the existing overnight-lt-crossing strategy logic)

  printTradeHeader();

  // Test both interpretations
  for (const [evts, crossLabel, followSide, fadeSide] of [
    [lt34Under, 'LT34 under', 'long', 'short'],   // level drops → bullish?
    [lt34Over,  'LT34 over',  'short', 'long'],    // level rises → bearish?
    [lt55Under, 'LT55 under', 'long', 'short'],
    [lt55Over,  'LT55 over',  'short', 'long'],
  ]) {
    for (const [sl, tp] of [[15, 15], [20, 15], [20, 20], [25, 20], [30, 20], [30, 25], [30, 30]]) {
      // Following the signal (cross_under → buy, cross_over → sell)
      const followTrades = simulateTrades(evts, followSide, { stopPts: sl, targetPts: tp });
      printTrade(tradeMetrics(followTrades, `${crossLabel} → ${followSide} ${sl}/${tp}`));
    }
  }

  // Combined: all cross_under → buy, all cross_over → sell
  console.log('\n  ── Combined (all levels) ──');
  printTradeHeader();
  const allUnder = events.filter(e => e.crossDir === 'cross_under');
  const allOver = events.filter(e => e.crossDir === 'cross_over');

  for (const [sl, tp] of [[15, 15], [20, 15], [20, 20], [25, 20], [30, 20], [30, 25], [30, 30], [20, 30], [25, 35]]) {
    const buyTrades = simulateTrades(allUnder, 'long', { stopPts: sl, targetPts: tp });
    const sellTrades = simulateTrades(allOver, 'short', { stopPts: sl, targetPts: tp });
    const combined = [...buyTrades, ...sellTrades].sort((a, b) => (a.date > b.date ? 1 : -1));
    printTrade(tradeMetrics(combined, `under→buy + over→sell ${sl}/${tp}`));
  }

  // Simultaneous pairs
  console.log('\n  ── Simultaneous LT34+LT55 crossings ──');
  printTradeHeader();
  for (const [sl, tp] of [[15, 15], [20, 15], [20, 20], [25, 20], [30, 20], [30, 25], [30, 30], [20, 30], [25, 35]]) {
    const buyT = simulateTrades(simUnder, 'long', { stopPts: sl, targetPts: tp });
    const sellT = simulateTrades(simOver, 'short', { stopPts: sl, targetPts: tp });
    const combined = [...buyT, ...sellT].sort((a, b) => (a.date > b.date ? 1 : -1));
    printTrade(tradeMetrics(combined, `simul: under→buy + over→sell ${sl}/${tp}`));
  }

  // Trailing stop variants on best signals
  console.log('\n  ── Trailing stop variants ──');
  printTradeHeader();
  for (const [sl, tt, to] of [[25, 12, 6], [25, 15, 8], [25, 20, 10], [30, 15, 8], [30, 20, 10], [30, 25, 12]]) {
    const buyT = simulateTrades(allUnder, 'long', { stopPts: sl, targetPts: 0, trailTrigger: tt, trailOffset: to });
    const sellT = simulateTrades(allOver, 'short', { stopPts: sl, targetPts: 0, trailTrigger: tt, trailOffset: to });
    const combined = [...buyT, ...sellT].sort((a, b) => (a.date > b.date ? 1 : -1));
    printTrade(tradeMetrics(combined, `all: SL${sl} trail@${tt}/${to}`));
  }

  // First crossing only
  console.log('\n  ── First crossing of the night only ──');
  printTradeHeader();
  const firstUnder = firstEvents.filter(e => e.crossDir === 'cross_under');
  const firstOver = firstEvents.filter(e => e.crossDir === 'cross_over');
  for (const [sl, tp] of [[15, 15], [20, 15], [20, 20], [25, 20], [30, 20], [30, 25], [30, 30], [20, 30], [25, 35]]) {
    const buyT = simulateTrades(firstUnder, 'long', { stopPts: sl, targetPts: tp });
    const sellT = simulateTrades(firstOver, 'short', { stopPts: sl, targetPts: tp });
    const combined = [...buyT, ...sellT].sort((a, b) => (a.date > b.date ? 1 : -1));
    printTrade(tradeMetrics(combined, `first: under→buy + over→sell ${sl}/${tp}`));
  }

  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('  COMPLETE');
  console.log('═══════════════════════════════════════════════════════════════════');
}

main().catch(console.error);
