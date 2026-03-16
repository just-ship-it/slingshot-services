/**
 * Overnight LT Level Crossing Research
 *
 * Analyzes LT Fibonacci level crossings through spot price during overnight
 * as predictive signals for subsequent NQ direction.
 *
 * Theory:
 *   - LT level crossing DOWN through price → bullish liquidity (support forming)
 *   - LT level crossing UP through price → deteriorating liquidity (resistance forming)
 *   - Higher Fib lookback crossings (377, 610) should be more significant than short-term (34, 55)
 *
 * Uses raw contract OHLCV data so price space matches LT level space.
 *
 * Usage: cd backtest-engine && node research/overnight-lt-crossings.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { CSVLoader } from '../src/data/csv-loader.js';

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
// DATA LOADING
// ============================================================================
async function loadData() {
  console.log('Loading data (raw contracts)...\n');

  // Raw contract OHLCV — price space matches LT levels
  const csvLoader = new CSVLoader(DATA_DIR, CONFIG, { noContinuous: true });
  const { candles: rawCandles } = await csvLoader.loadOHLCVData('NQ', new Date(START), new Date(END));
  const candles = csvLoader.filterPrimaryContract(rawCandles);
  console.log(`  OHLCV: ${candles.length} candles (raw, primary filtered)`);

  // LT levels (15-min resolution)
  const ltRecords = await csvLoader.loadLiquidityData('NQ', new Date(START), new Date(END));
  console.log(`  LT: ${ltRecords.length} records`);

  return { candles, ltRecords };
}

// ============================================================================
// BUILD ALIGNED OVERNIGHT DATA
// ============================================================================
function buildOvernightData(candles, ltRecords) {
  console.log('\nBuilding overnight crossing data...');

  // Index candles by timestamp for price lookup
  const priceByTs = new Map();
  for (const c of candles) priceByTs.set(c.timestamp, c);

  // Build 1-min price interpolation: for each LT timestamp, find nearest candle
  function getPriceAtTs(ts) {
    if (priceByTs.has(ts)) return priceByTs.get(ts);
    // Search within 2 minutes
    for (let offset = 60000; offset <= 120000; offset += 60000) {
      if (priceByTs.has(ts - offset)) return priceByTs.get(ts - offset);
      if (priceByTs.has(ts + offset)) return priceByTs.get(ts + offset);
    }
    return null;
  }

  // Group LT records by EST date
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

  const LEVELS = ['level_1', 'level_2', 'level_3', 'level_4', 'level_5'];
  const FIB_NAMES = ['fib34', 'fib55', 'fib144', 'fib377', 'fib610'];
  const FIB_WEIGHTS = [1, 1, 2, 3, 4]; // Higher weight for longer lookback

  const dates = Object.keys(candlesByDate).sort();
  const events = []; // All crossing events

  for (let di = 0; di < dates.length - 1; di++) {
    const today = dates[di], tomorrow = dates[di + 1];
    const dayOfWeek = getDayOfWeek(today);
    if (dayOfWeek === 'Friday' || dayOfWeek === 'Saturday') continue;

    const todayCandles = candlesByDate[today] || [];
    const tomorrowCandles = candlesByDate[tomorrow] || [];

    // Get LT records for overnight period (6pm today through 8am tomorrow)
    const overnightLT = [
      ...(ltByDate[today] || []).filter(lt => getESTHour(lt.timestamp) >= 18),
      ...(ltByDate[tomorrow] || []).filter(lt => getESTHour(lt.timestamp) < 8),
    ].sort((a, b) => a.timestamp - b.timestamp);

    if (overnightLT.length < 4) continue;

    // Get overnight candles for measuring subsequent returns
    const overnightCandles = [
      ...todayCandles.filter(c => c.estHour >= 18),
      ...tomorrowCandles.filter(c => c.estHour < 8),
    ];
    if (overnightCandles.length < 30) continue;

    // Detect crossings: compare each consecutive pair of LT snapshots
    for (let i = 1; i < overnightLT.length; i++) {
      const prev = overnightLT[i - 1];
      const curr = overnightLT[i];

      // Get spot price at each LT timestamp
      const pricePrev = getPriceAtTs(prev.timestamp);
      const priceCurr = getPriceAtTs(curr.timestamp);
      if (!pricePrev || !priceCurr) continue;

      const spotPrev = (pricePrev.high + pricePrev.low) / 2; // midpoint
      const spotCurr = (priceCurr.high + priceCurr.low) / 2;

      const crossingHour = getESTHour(curr.timestamp);

      for (let l = 0; l < 5; l++) {
        const key = LEVELS[l];
        const fibName = FIB_NAMES[l];
        const weight = FIB_WEIGHTS[l];

        const levelPrev = prev[key];
        const levelCurr = curr[key];
        if (levelPrev == null || levelCurr == null) continue;

        // Crossing detection:
        // Level was above price, now below → level crossed DOWN through price → BULLISH
        // Level was below price, now above → level crossed UP through price → BEARISH
        const prevAbove = levelPrev > spotPrev;
        const currAbove = levelCurr > spotCurr;

        if (prevAbove === currAbove) continue; // No crossing

        const direction = prevAbove && !currAbove ? 'down' : 'up';
        const signal = direction === 'down' ? 1 : -1; // down=bullish, up=bearish

        // Measure returns at various lookforward windows from crossing time
        const crossingIdx = overnightCandles.findIndex(c => c.timestamp >= curr.timestamp);
        if (crossingIdx < 0 || crossingIdx >= overnightCandles.length - 10) continue;

        const entryPrice = overnightCandles[crossingIdx].close;

        // Lookforward returns: 15min, 30min, 1hr, 2hr, to-2am
        const returns = {};
        for (const [label, bars] of [['15m', 15], ['30m', 30], ['1hr', 60], ['2hr', 120], ['4hr', 240]]) {
          const exitIdx = Math.min(crossingIdx + bars, overnightCandles.length - 1);
          returns[label] = overnightCandles[exitIdx].close - entryPrice;
        }
        // Return to end of overnight
        returns['to_end'] = overnightCandles[overnightCandles.length - 1].close - entryPrice;

        events.push({
          date: today, dayOfWeek,
          crossingHour,
          fibName, fibIdx: l, weight,
          direction, signal,
          levelPrice: levelCurr, spotPrice: spotCurr,
          entryPrice,
          ...returns,
        });
      }
    }
  }

  console.log(`  ${events.length} crossing events detected`);
  return events;
}

// ============================================================================
// ANALYSIS
// ============================================================================
function correlation(xs, ys) {
  const n = xs.length;
  if (n < 10) return { r: NaN, t: NaN, n };
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let ssxy = 0, ssxx = 0, ssyy = 0;
  for (let i = 0; i < n; i++) { ssxy += (xs[i] - mx) * (ys[i] - my); ssxx += (xs[i] - mx) ** 2; ssyy += (ys[i] - my) ** 2; }
  const r = ssxy / Math.sqrt(ssxx * ssyy);
  const t = r * Math.sqrt((n - 2) / (1 - r * r));
  return { r, t, n };
}

function analyzeGroup(events, label, returnKey = '2hr') {
  if (events.length < 10) return null;
  const signaled = events.map(e => ({ sig: e.signal, ret: e[returnKey] }));
  const followThrough = signaled.filter(s => s.sig * s.ret > 0).length;
  const wr = followThrough / signaled.length * 100;
  const avgRet = signaled.reduce((s, e) => s + e.sig * e.ret, 0) / signaled.length;
  const totalRet = signaled.reduce((s, e) => s + e.sig * e.ret, 0);

  // Also measure raw directional accuracy
  const bullish = events.filter(e => e.direction === 'down');
  const bearish = events.filter(e => e.direction === 'up');
  const bullWR = bullish.length > 0 ? bullish.filter(e => e[returnKey] > 0).length / bullish.length * 100 : 0;
  const bearWR = bearish.length > 0 ? bearish.filter(e => e[returnKey] < 0).length / bearish.length * 100 : 0;

  return { label, n: events.length, wr, avgRet, totalRet,
    bullCount: bullish.length, bearCount: bearish.length, bullWR, bearWR };
}

function printGroup(g) {
  if (!g) return;
  console.log(`  ${g.label.padEnd(45)} ${String(g.n).padStart(5)} ${g.wr.toFixed(1).padStart(6)}% ${g.avgRet.toFixed(1).padStart(7)} ${g.totalRet.toFixed(0).padStart(8)}   bull:${g.bullCount}(${g.bullWR.toFixed(0)}%) bear:${g.bearCount}(${g.bearWR.toFixed(0)}%)`);
}

// ============================================================================
// MAIN
// ============================================================================
async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  OVERNIGHT LT LEVEL CROSSINGS — NQ (Raw Contracts)');
  console.log('  Level crossing DOWN through price → BULLISH');
  console.log('  Level crossing UP through price → BEARISH');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const { candles, ltRecords } = await loadData();
  const events = buildOvernightData(candles, ltRecords);

  // ════════════════════════════════════════════════════════════
  // CROSSING FREQUENCY
  // ════════════════════════════════════════════════════════════
  console.log('\n╔════════════════════════════════════════════════════════════════╗');
  console.log('║  CROSSING FREQUENCY                                           ║');
  console.log('╚════════════════════════════════════════════════════════════════╝\n');

  const FIB_NAMES = ['fib34', 'fib55', 'fib144', 'fib377', 'fib610'];
  for (const fib of FIB_NAMES) {
    const fibEvents = events.filter(e => e.fibName === fib);
    const down = fibEvents.filter(e => e.direction === 'down').length;
    const up = fibEvents.filter(e => e.direction === 'up').length;
    console.log(`  ${fib.padEnd(8)}: ${fibEvents.length} crossings (${down} down/bullish, ${up} up/bearish)`);
  }
  console.log(`  TOTAL  : ${events.length} crossings`);

  // Time distribution
  console.log('\n  Crossings by hour (EST):');
  const byHour = {};
  for (const e of events) { const h = Math.floor(e.crossingHour); byHour[h] = (byHour[h] || 0) + 1; }
  for (const h of Object.keys(byHour).sort((a, b) => +a - +b)) {
    const pct = (byHour[h] / events.length * 100).toFixed(1);
    console.log(`    ${String(h).padStart(2)}:00 EST: ${String(byHour[h]).padStart(5)} (${pct}%)`);
  }

  // ════════════════════════════════════════════════════════════
  // PREDICTIVE POWER BY FIB LOOKBACK
  // ════════════════════════════════════════════════════════════
  console.log('\n╔════════════════════════════════════════════════════════════════╗');
  console.log('║  PREDICTIVE POWER BY FIB LOOKBACK                             ║');
  console.log('╚════════════════════════════════════════════════════════════════╝\n');

  const header = `  ${'Group'.padEnd(45)} ${'N'.padStart(5)} ${'WR'.padStart(7)} ${'Avg'.padStart(7)} ${'Total'.padStart(8)}   ${'Details'}`;
  const divider = `  ${'─'.repeat(45)} ${'─'.repeat(5)} ${'─'.repeat(7)} ${'─'.repeat(7)} ${'─'.repeat(8)}   ${'─'.repeat(25)}`;

  for (const retKey of ['15m', '30m', '1hr', '2hr', '4hr', 'to_end']) {
    console.log(`\n  ── Lookforward: ${retKey} ──`);
    console.log(header); console.log(divider);

    printGroup(analyzeGroup(events, 'ALL crossings', retKey));
    for (const fib of FIB_NAMES) {
      printGroup(analyzeGroup(events.filter(e => e.fibName === fib), `  ${fib}`, retKey));
    }
    // Long-term only (377 + 610)
    printGroup(analyzeGroup(events.filter(e => e.fibIdx >= 3), '  LONG-TERM (fib377+610)', retKey));
    // Short-term only (34 + 55)
    printGroup(analyzeGroup(events.filter(e => e.fibIdx <= 1), '  SHORT-TERM (fib34+55)', retKey));
  }

  // ════════════════════════════════════════════════════════════
  // CROSSINGS BY TIME WINDOW
  // ════════════════════════════════════════════════════════════
  console.log('\n\n╔════════════════════════════════════════════════════════════════╗');
  console.log('║  CROSSINGS BY TIME WINDOW                                     ║');
  console.log('╚════════════════════════════════════════════════════════════════╝\n');

  console.log('  Using 2hr lookforward:');
  console.log(header); console.log(divider);

  // Early overnight (6-8pm)
  printGroup(analyzeGroup(events.filter(e => e.crossingHour >= 18 && e.crossingHour < 20), 'Early (6-8pm)', '2hr'));
  // Mid overnight (8pm-midnight)
  printGroup(analyzeGroup(events.filter(e => e.crossingHour >= 20 || e.crossingHour < 0), 'Mid (8pm-midnight)', '2hr'));
  // Late overnight (midnight-4am)
  printGroup(analyzeGroup(events.filter(e => e.crossingHour >= 0 && e.crossingHour < 4), 'Late (midnight-4am)', '2hr'));
  // Pre-market (4-8am)
  printGroup(analyzeGroup(events.filter(e => e.crossingHour >= 4 && e.crossingHour < 8), 'Pre-market (4-8am)', '2hr'));

  // Long-term by time window
  console.log('\n  Long-term (fib377+610) by time window:');
  console.log(header); console.log(divider);
  const lt = events.filter(e => e.fibIdx >= 3);
  printGroup(analyzeGroup(lt.filter(e => e.crossingHour >= 18 && e.crossingHour < 20), '  LT Early (6-8pm)', '2hr'));
  printGroup(analyzeGroup(lt.filter(e => e.crossingHour >= 20 || e.crossingHour < 0), '  LT Mid (8pm-midnight)', '2hr'));
  printGroup(analyzeGroup(lt.filter(e => e.crossingHour >= 0 && e.crossingHour < 4), '  LT Late (midnight-4am)', '2hr'));
  printGroup(analyzeGroup(lt.filter(e => e.crossingHour >= 4 && e.crossingHour < 8), '  LT Pre-market (4-8am)', '2hr'));

  // ════════════════════════════════════════════════════════════
  // MULTIPLE CROSSINGS IN SAME DIRECTION
  // ════════════════════════════════════════════════════════════
  console.log('\n\n╔════════════════════════════════════════════════════════════════╗');
  console.log('║  CONFLUENCE: MULTIPLE FIBS CROSSING SAME DIRECTION            ║');
  console.log('╚════════════════════════════════════════════════════════════════╝\n');

  // Group crossings by date+hour window (within 1 hour)
  const byDateHour = {};
  for (const e of events) {
    const key = e.date + '_' + Math.floor(e.crossingHour);
    if (!byDateHour[key]) byDateHour[key] = [];
    byDateHour[key].push(e);
  }

  // Find windows with multiple crossings in same direction
  const confluenceEvents = [];
  for (const [key, group] of Object.entries(byDateHour)) {
    const downCrossings = group.filter(e => e.direction === 'down');
    const upCrossings = group.filter(e => e.direction === 'up');

    if (downCrossings.length >= 2) {
      // Multiple fibs crossing down simultaneously → stronger bullish signal
      const maxWeight = Math.max(...downCrossings.map(e => e.weight));
      const fibNames = downCrossings.map(e => e.fibName).join('+');
      confluenceEvents.push({
        ...downCrossings[0], // Use first crossing's return data
        confluenceCount: downCrossings.length,
        confluenceWeight: downCrossings.reduce((s, e) => s + e.weight, 0),
        maxFibWeight: maxWeight,
        confluenceFibs: fibNames,
        confluenceDirection: 'down',
      });
    }
    if (upCrossings.length >= 2) {
      const maxWeight = Math.max(...upCrossings.map(e => e.weight));
      const fibNames = upCrossings.map(e => e.fibName).join('+');
      confluenceEvents.push({
        ...upCrossings[0],
        confluenceCount: upCrossings.length,
        confluenceWeight: upCrossings.reduce((s, e) => s + e.weight, 0),
        maxFibWeight: maxWeight,
        confluenceFibs: fibNames,
        confluenceDirection: 'down',
      });
    }
  }

  console.log(`  ${confluenceEvents.length} confluence events (2+ fibs crossing same direction within 1 hour)`);
  console.log('\n  By confluence count (2hr lookforward):');
  console.log(header); console.log(divider);

  for (const minCount of [2, 3, 4]) {
    const subset = confluenceEvents.filter(e => e.confluenceCount >= minCount);
    printGroup(analyzeGroup(subset, `  ${minCount}+ fibs crossing together`, '2hr'));
  }

  // By max fib weight in confluence
  console.log('\n  By max fib weight in confluence (2hr lookforward):');
  console.log(header); console.log(divider);
  for (const minWeight of [2, 3, 4]) {
    const subset = confluenceEvents.filter(e => e.maxFibWeight >= minWeight);
    printGroup(analyzeGroup(subset, `  Max fib weight >= ${minWeight} (${minWeight >= 4 ? 'fib610' : minWeight >= 3 ? 'fib377+' : 'fib144+'})`, '2hr'));
  }

  // ════════════════════════════════════════════════════════════
  // WEIGHTED CROSSING SCORE PER NIGHT
  // ════════════════════════════════════════════════════════════
  console.log('\n\n╔════════════════════════════════════════════════════════════════╗');
  console.log('║  WEIGHTED CROSSING SCORE PER OVERNIGHT SESSION                ║');
  console.log('╚════════════════════════════════════════════════════════════════╝\n');

  // For each overnight session, compute a weighted crossing score
  // score = sum(signal * weight) for all crossings in observation window
  const byNight = {};
  for (const e of events) {
    if (!byNight[e.date]) byNight[e.date] = { events: [], date: e.date, dayOfWeek: e.dayOfWeek };
    byNight[e.date].events.push(e);
  }

  const nightScores = [];
  for (const [date, night] of Object.entries(byNight)) {
    const score = night.events.reduce((s, e) => s + e.signal * e.weight, 0);
    const unweightedScore = night.events.reduce((s, e) => s + e.signal, 0);
    // Use the return from the first event (all on same night)
    const ret2hr = night.events[0]?.['2hr'] || 0;
    const retEnd = night.events[0]?.['to_end'] || 0;
    nightScores.push({ date, score, unweightedScore, ret2hr, retEnd,
      crossings: night.events.length, dayOfWeek: night.dayOfWeek });
  }

  console.log(`  ${nightScores.length} nights with at least 1 crossing`);

  // Correlation
  const corr2hr = correlation(nightScores.map(n => n.score), nightScores.map(n => n.ret2hr));
  const corrEnd = correlation(nightScores.map(n => n.score), nightScores.map(n => n.retEnd));
  console.log(`  Weighted score → 2hr return: r=${corr2hr.r.toFixed(4)}, t=${corr2hr.t.toFixed(2)}`);
  console.log(`  Weighted score → to_end return: r=${corrEnd.r.toFixed(4)}, t=${corrEnd.t.toFixed(2)}`);

  // Bucket analysis
  console.log('\n  Weighted score quintiles (2hr lookforward):');
  nightScores.sort((a, b) => a.score - b.score);
  const bSize = Math.ceil(nightScores.length / 5);
  console.log('  ┌──────────┬───────┬──────────────────────────┬───────────┬──────────┐');
  console.log('  │ Quintile │   N   │ Score Range              │ Avg 2hr   │ WR Sig   │');
  console.log('  ├──────────┼───────┼──────────────────────────┼───────────┼──────────┤');
  for (let b = 0; b < 5; b++) {
    const s = nightScores.slice(b * bSize, Math.min((b + 1) * bSize, nightScores.length));
    const avgRet = s.reduce((a, d) => a + (d.score > 0 ? d.ret2hr : d.score < 0 ? -d.ret2hr : 0), 0) / s.length;
    const wr = s.filter(d => (d.score > 0 && d.ret2hr > 0) || (d.score < 0 && d.ret2hr < 0)).length / s.length * 100;
    console.log(`  │   Q${b + 1}     │ ${String(s.length).padStart(4)}  │ ${s[0].score.toFixed(0).padStart(8)} to ${s[s.length - 1].score.toFixed(0).padStart(8)}      │ ${avgRet.toFixed(1).padStart(9)} │ ${wr.toFixed(1).padStart(6)}%  │`);
  }
  console.log('  └──────────┴───────┴──────────────────────────┴───────────┴──────────┘');

  // Simple strategy: trade in direction of weighted score
  console.log('\n  Strategy tests (trade in crossing direction):');
  console.log(`  ${'Strategy'.padEnd(50)} ${'N'.padStart(4)} ${'WR'.padStart(7)} ${'Avg'.padStart(7)} ${'Total'.padStart(8)}`);
  console.log(`  ${'─'.repeat(50)} ${'─'.repeat(4)} ${'─'.repeat(7)} ${'─'.repeat(7)} ${'─'.repeat(8)}`);

  for (const [label, filter, retKey] of [
    ['Any crossing score != 0, 2hr hold', n => n.score !== 0, 'ret2hr'],
    ['Score >= 2 or <= -2, 2hr hold', n => Math.abs(n.score) >= 2, 'ret2hr'],
    ['Score >= 4 or <= -4, 2hr hold', n => Math.abs(n.score) >= 4, 'ret2hr'],
    ['Score >= 6 or <= -6, 2hr hold', n => Math.abs(n.score) >= 6, 'ret2hr'],
    ['Score >= 8 or <= -8, 2hr hold', n => Math.abs(n.score) >= 8, 'ret2hr'],
    ['Any crossing score != 0, to-end hold', n => n.score !== 0, 'retEnd'],
    ['Score >= 4 or <= -4, to-end hold', n => Math.abs(n.score) >= 4, 'retEnd'],
    ['Score >= 8 or <= -8, to-end hold', n => Math.abs(n.score) >= 8, 'retEnd'],
  ]) {
    const eligible = nightScores.filter(filter);
    if (eligible.length < 15) { console.log(`  ${label.padEnd(50)} ${String(eligible.length).padStart(4)}  (too few)`); continue; }
    const trades = eligible.map(n => ({ sig: n.score > 0 ? 1 : -1, ret: n[retKey] }));
    const pnl = trades.reduce((s, t) => s + t.sig * t.ret, 0);
    const wins = trades.filter(t => t.sig * t.ret > 0).length;
    console.log(`  ${label.padEnd(50)} ${String(eligible.length).padStart(4)} ${(wins / eligible.length * 100).toFixed(1).padStart(6)}% ${(pnl / eligible.length).toFixed(1).padStart(7)} ${pnl.toFixed(0).padStart(8)}`);
  }

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  LT CROSSING RESEARCH COMPLETE');
  console.log('═══════════════════════════════════════════════════════════════');
}

main().catch(console.error);
