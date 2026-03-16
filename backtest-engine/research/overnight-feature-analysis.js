/**
 * Overnight Feature Analysis
 *
 * Tests correlations between end-of-day features (GEX, IV, LT, RTH return)
 * and overnight NQ + ES returns. Goal: identify predictive signals for a
 * long/short overnight strategy (8 PM - 8 AM EST).
 *
 * Also analyzes NQ/ES overnight divergence and correlation.
 *
 * Hypothesis: ES may be more driven by overnight mechanical dealer flows
 * (charm/vanna rebalancing) than NQ, making it a better target.
 *
 * Usage: node backtest-engine/research/overnight-feature-analysis.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');

// ============================================================================
// DATA LOADING
// ============================================================================

function loadOHLCV(ticker = 'nq') {
  const continuous = path.join(DATA_DIR, 'ohlcv', ticker, `${ticker.toUpperCase()}_ohlcv_1m_continuous.csv`);
  const hasContinuous = fs.existsSync(continuous);
  const filePath = hasContinuous
    ? continuous
    : path.join(DATA_DIR, 'ohlcv', ticker, `${ticker.toUpperCase()}_ohlcv_1m.csv`);

  console.log(`Loading ${ticker.toUpperCase()} OHLCV data (${hasContinuous ? 'continuous' : 'raw'})...`);
  const raw = fs.readFileSync(filePath, 'utf-8');
  const lines = raw.split('\n').filter(l => l.trim());

  const candles = [];

  if (hasContinuous) {
    // Continuous format: ts_event,open,high,low,close,volume,symbol,contract
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(',');
      if (parts.length < 6) continue;
      candles.push({
        timestamp: new Date(parts[0]).getTime(),
        open: parseFloat(parts[1]),
        high: parseFloat(parts[2]),
        low: parseFloat(parts[3]),
        close: parseFloat(parts[4]),
        volume: parseInt(parts[5]) || 0,
      });
    }
  } else {
    // Raw format: ts_event,rtype,publisher_id,instrument_id,open,high,low,close,volume,symbol
    // Need to filter primary contract by volume per hour
    const hourBuckets = {};
    const rawCandles = [];

    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(',');
      if (parts.length < 10) continue;
      const symbol = parts[9]?.trim() || '';
      if (symbol.includes('-')) continue; // Calendar spreads

      const ts = new Date(parts[0]).getTime();
      const c = {
        timestamp: ts,
        open: parseFloat(parts[4]),
        high: parseFloat(parts[5]),
        low: parseFloat(parts[6]),
        close: parseFloat(parts[7]),
        volume: parseInt(parts[8]) || 0,
        symbol,
      };
      rawCandles.push(c);

      // Group by hour for primary contract detection
      const hourKey = Math.floor(ts / 3600000);
      if (!hourBuckets[hourKey]) hourBuckets[hourKey] = {};
      if (!hourBuckets[hourKey][symbol]) hourBuckets[hourKey][symbol] = 0;
      hourBuckets[hourKey][symbol] += c.volume;
    }

    // Find primary contract per hour
    const primaryByHour = {};
    for (const [hour, symbols] of Object.entries(hourBuckets)) {
      let maxVol = 0, maxSym = '';
      for (const [sym, vol] of Object.entries(symbols)) {
        if (vol > maxVol) { maxVol = vol; maxSym = sym; }
      }
      primaryByHour[hour] = maxSym;
    }

    // Filter to primary contract only
    for (const c of rawCandles) {
      const hourKey = Math.floor(c.timestamp / 3600000);
      if (c.symbol === primaryByHour[hourKey]) {
        candles.push(c);
      }
    }
  }

  console.log(`  Loaded ${candles.length} ${ticker.toUpperCase()} candles`);
  return candles;
}

function loadDailyGEX() {
  console.log('Loading daily GEX levels...');
  const filePath = path.join(DATA_DIR, 'gex', 'nq', 'NQ_gex_levels.csv');
  const raw = fs.readFileSync(filePath, 'utf-8');
  const lines = raw.split('\n').filter(l => l.trim());

  const gexByDate = {};
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',');
    if (parts.length < 11) continue;

    const date = parts[0];
    gexByDate[date] = {
      date,
      gammaFlip: parseFloat(parts[1]),
      putWall1: parseFloat(parts[2]),
      putWall2: parseFloat(parts[3]),
      putWall3: parseFloat(parts[4]),
      callWall1: parseFloat(parts[5]),
      callWall2: parseFloat(parts[6]),
      callWall3: parseFloat(parts[7]),
      totalGex: parseFloat(parts[10]),
      regime: parts[11]?.trim() || 'unknown',
    };
  }

  console.log(`  Loaded ${Object.keys(gexByDate).length} daily GEX records`);
  return gexByDate;
}

function loadIntradayGEX(ticker = 'nq') {
  console.log(`Loading ${ticker.toUpperCase()} intraday GEX snapshots...`);
  const gexDir = path.join(DATA_DIR, 'gex', ticker);
  if (!fs.existsSync(gexDir)) {
    console.log(`  GEX directory not found for ${ticker}`);
    return {};
  }
  const prefix = `${ticker}_gex_`;
  const files = fs.readdirSync(gexDir).filter(f => f.startsWith(prefix) && f.endsWith('.json'));

  const eodGex = {}; // date → last snapshot before 4pm ET

  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(gexDir, file), 'utf-8'));
      const date = data.metadata?.date;
      if (!date || !data.data || data.data.length === 0) continue;

      // Find last snapshot — this is closest to EOD
      const lastSnapshot = data.data[data.data.length - 1];
      eodGex[date] = {
        gammaFlip: lastSnapshot.gamma_flip,
        callWall: lastSnapshot.call_wall,
        putWall: lastSnapshot.put_wall,
        totalGex: lastSnapshot.total_gex,
        totalVex: lastSnapshot.total_vex,
        totalCex: lastSnapshot.total_cex,
        regime: lastSnapshot.regime,
        resistance: lastSnapshot.resistance || [],
        support: lastSnapshot.support || [],
        spot: lastSnapshot.nq_spot || lastSnapshot.es_spot,
      };
    } catch (e) {
      // Skip corrupt files
    }
  }

  console.log(`  Loaded EOD GEX for ${Object.keys(eodGex).length} dates`);
  return eodGex;
}

function loadIV() {
  console.log('Loading IV data...');
  const filePath = path.join(DATA_DIR, 'iv', 'qqq', 'qqq_atm_iv_15m.csv');
  if (!fs.existsSync(filePath)) {
    console.log('  IV file not found, skipping');
    return {};
  }
  const raw = fs.readFileSync(filePath, 'utf-8');
  const lines = raw.split('\n').filter(l => l.trim());

  // Group by date, find EOD values and intraday stats
  const ivByDate = {};
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',');
    if (parts.length < 7) continue;

    const ts = new Date(parts[0]);
    // Get EST date
    const estParts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(ts);

    let year, month, day;
    for (const p of estParts) {
      if (p.type === 'year') year = p.value;
      if (p.type === 'month') month = p.value;
      if (p.type === 'day') day = p.value;
    }
    const dateStr = `${year}-${month}-${day}`;

    const iv = parseFloat(parts[1]);
    const callIV = parseFloat(parts[5]);
    const putIV = parseFloat(parts[6]);
    const dte = parseInt(parts[7] || parts[6]); // dte column

    if (!ivByDate[dateStr]) {
      ivByDate[dateStr] = { readings: [], firstIV: null, lastIV: null };
    }

    const reading = { ts: ts.getTime(), iv, callIV, putIV, dte };
    ivByDate[dateStr].readings.push(reading);
  }

  // Compute EOD features per day
  const ivFeatures = {};
  for (const [date, data] of Object.entries(ivByDate)) {
    const readings = data.readings.sort((a, b) => a.ts - b.ts);
    if (readings.length < 2) continue;

    const first = readings[0];
    const last = readings[readings.length - 1];

    ivFeatures[date] = {
      eodIV: last.iv,
      openIV: first.iv,
      ivChange: last.iv - first.iv,
      ivChangePercent: (last.iv - first.iv) / first.iv * 100,
      eodSkew: last.putIV - last.callIV,
      eodCallIV: last.callIV,
      eodPutIV: last.putIV,
      maxIV: Math.max(...readings.map(r => r.iv)),
      minIV: Math.min(...readings.map(r => r.iv)),
      ivRange: Math.max(...readings.map(r => r.iv)) - Math.min(...readings.map(r => r.iv)),
    };
  }

  console.log(`  Loaded IV features for ${Object.keys(ivFeatures).length} dates`);
  return ivFeatures;
}

function loadLT() {
  console.log('Loading LT levels...');
  const filePath = path.join(DATA_DIR, 'liquidity', 'nq', 'NQ_liquidity_levels.csv');
  const raw = fs.readFileSync(filePath, 'utf-8');
  const lines = raw.split('\n').filter(l => l.trim());

  // Get last reading per day
  const ltByDate = {};
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',');
    if (parts.length < 8) continue;

    const dtStr = parts[0];
    const dateOnly = dtStr.split(' ')[0];
    const sentiment = parts[2];
    const levels = [
      parseFloat(parts[3]), parseFloat(parts[4]),
      parseFloat(parts[5]), parseFloat(parts[6]),
      parseFloat(parts[7])
    ];

    // Keep overwriting — last entry per date wins (closest to EOD)
    ltByDate[dateOnly] = { sentiment, levels };
  }

  console.log(`  Loaded LT for ${Object.keys(ltByDate).length} dates`);
  return ltByDate;
}

// ============================================================================
// OVERNIGHT RETURN COMPUTATION
// ============================================================================

// Fast EST/EDT conversion without Intl (called millions of times)
// EDT: Mar second Sun 2am → Nov first Sun 2am (UTC-4)
// EST: Nov first Sun 2am → Mar second Sun 2am (UTC-5)
function isDST(utcMs) {
  const d = new Date(utcMs);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth(); // 0-indexed

  // Quick check: Apr-Oct is always DST, Dec-Feb is never DST
  if (month >= 3 && month <= 9) return true;
  if (month === 0 || month === 1 || month === 11) return false;

  // March: DST starts second Sunday at 2 AM EST (7 AM UTC)
  if (month === 2) {
    const firstDay = new Date(Date.UTC(year, 2, 1)).getUTCDay();
    const secondSunday = firstDay === 0 ? 8 : 15 - firstDay;
    const dstStartUTC = Date.UTC(year, 2, secondSunday, 7); // 2am EST = 7am UTC
    return utcMs >= dstStartUTC;
  }

  // October: DST ends first Sunday at 2 AM EDT (6 AM UTC)
  if (month === 10) {
    const firstDay = new Date(Date.UTC(year, 10, 1)).getUTCDay();
    const firstSunday = firstDay === 0 ? 1 : 8 - firstDay;
    const dstEndUTC = Date.UTC(year, 10, firstSunday, 6); // 2am EDT = 6am UTC
    return utcMs < dstEndUTC;
  }

  return false;
}

function utcToEST(utcMs) {
  const offset = isDST(utcMs) ? -4 : -5;
  return utcMs + offset * 3600000;
}

function getESTHour(timestamp) {
  const estMs = utcToEST(timestamp);
  const d = new Date(estMs);
  return d.getUTCHours() + d.getUTCMinutes() / 60;
}

function getESTDateStr(timestamp) {
  const estMs = utcToEST(timestamp);
  const d = new Date(estMs);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function getDayOfWeek(dateStr) {
  return new Date(dateStr + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long' });
}

/**
 * Compute overnight sessions from candle data.
 * For each trading day, extract:
 * - RTH close price (~4:00 PM EST)
 * - Overnight open (~6:00 PM EST same day)
 * - Overnight close (~8:00 AM EST next day)
 * - RTH open next day (~9:30 AM EST)
 * - RTH high/low for intraday range
 */
function computeOvernightSessions(candles) {
  console.log('Computing overnight sessions...');

  // Index candles by EST date and hour for fast lookup
  const byDateHour = {};
  for (const c of candles) {
    const dateStr = getESTDateStr(c.timestamp);
    const hour = getESTHour(c.timestamp);
    const key = dateStr;

    if (!byDateHour[key]) byDateHour[key] = [];
    byDateHour[key].push({ ...c, estHour: hour, estDate: dateStr });
  }

  const dates = Object.keys(byDateHour).sort();
  const sessions = [];

  for (let i = 0; i < dates.length - 1; i++) {
    const today = dates[i];
    const tomorrow = dates[i + 1];

    const todayCandles = byDateHour[today] || [];
    const tomorrowCandles = byDateHour[tomorrow] || [];

    // RTH close: last candle between 15:55-16:00 EST
    const rthCloseCandles = todayCandles.filter(c => c.estHour >= 15.9 && c.estHour <= 16.05);
    if (rthCloseCandles.length === 0) continue;
    const rthClose = rthCloseCandles[rthCloseCandles.length - 1];

    // RTH stats: candles between 9:30 and 16:00
    const rthCandles = todayCandles.filter(c => c.estHour >= 9.5 && c.estHour < 16);
    if (rthCandles.length < 10) continue;
    const rthOpen = rthCandles[0];
    const rthHigh = Math.max(...rthCandles.map(c => c.high));
    const rthLow = Math.min(...rthCandles.map(c => c.low));

    // Overnight open: first candle at or after 18:00 EST today
    const overnightOpenCandles = todayCandles.filter(c => c.estHour >= 18 && c.estHour < 23.99);
    if (overnightOpenCandles.length === 0) continue;
    const overnightOpen = overnightOpenCandles[0];

    // Overnight candles: 18:00 today through 08:00 tomorrow
    const overnightCandles = [
      ...todayCandles.filter(c => c.estHour >= 18),
      ...tomorrowCandles.filter(c => c.estHour < 8)
    ];
    if (overnightCandles.length < 10) continue;

    const overnightLast = overnightCandles[overnightCandles.length - 1];
    const overnightHigh = Math.max(...overnightCandles.map(c => c.high));
    const overnightLow = Math.min(...overnightCandles.map(c => c.low));

    // Next day RTH open
    const nextRthOpenCandles = tomorrowCandles.filter(c => c.estHour >= 9.5 && c.estHour <= 9.55);
    const nextRthOpen = nextRthOpenCandles.length > 0 ? nextRthOpenCandles[0] : null;

    // Overnight 2 AM checkpoint (common exit time)
    const overnight2am = [...todayCandles.filter(c => c.estHour >= 18), ...tomorrowCandles.filter(c => c.estHour <= 2.1)]
      .filter(c => {
        const h = c.estDate === tomorrow ? c.estHour : c.estHour;
        return c.estDate === tomorrow && c.estHour >= 1.9 && c.estHour <= 2.1;
      });
    const checkpoint2am = overnight2am.length > 0 ? overnight2am[overnight2am.length - 1] : null;

    sessions.push({
      date: today,
      nextDate: tomorrow,
      dayOfWeek: getDayOfWeek(today),

      // RTH stats
      rthOpenPrice: rthOpen.open,
      rthClosePrice: rthClose.close,
      rthHigh,
      rthLow,
      rthReturn: (rthClose.close - rthOpen.open),
      rthReturnPct: (rthClose.close - rthOpen.open) / rthOpen.open * 100,
      rthRange: rthHigh - rthLow,

      // Overnight stats
      overnightOpenPrice: overnightOpen.open,
      overnightClosePrice: overnightLast.close,
      overnightHigh,
      overnightLow,
      overnightReturn: overnightLast.close - rthClose.close,
      overnightReturnPct: (overnightLast.close - rthClose.close) / rthClose.close * 100,
      overnightRange: overnightHigh - overnightLow,
      overnightMFE_long: overnightHigh - overnightOpen.open,
      overnightMAE_long: overnightOpen.open - overnightLow,
      overnightMFE_short: overnightOpen.open - overnightLow,
      overnightMAE_short: overnightHigh - overnightOpen.open,

      // Gap (overnight close → RTH open)
      nextRthOpenPrice: nextRthOpen?.open || null,
      overnightToRthGap: nextRthOpen ? (nextRthOpen.open - overnightLast.close) : null,

      // 2am checkpoint
      checkpoint2amPrice: checkpoint2am?.close || null,
      returnTo2am: checkpoint2am ? (checkpoint2am.close - rthClose.close) : null,

      // Timestamps
      rthCloseTs: rthClose.timestamp,
      overnightOpenTs: overnightOpen.timestamp,
    });
  }

  console.log(`  Computed ${sessions.length} overnight sessions`);
  return sessions;
}

// ============================================================================
// ANALYSIS FUNCTIONS
// ============================================================================

function correlation(xs, ys) {
  const n = xs.length;
  if (n < 5) return { r: NaN, p: NaN };

  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;

  let ssXY = 0, ssXX = 0, ssYY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    ssXY += dx * dy;
    ssXX += dx * dx;
    ssYY += dy * dy;
  }

  const r = ssXY / Math.sqrt(ssXX * ssYY);
  // t-statistic for significance
  const t = r * Math.sqrt((n - 2) / (1 - r * r));
  // Approximate p-value (two-tailed) using rough normal approximation for large n
  const p = n > 30 ? 2 * Math.exp(-0.5 * t * t) * 0.4 : NaN; // crude approximation

  return { r, t, n };
}

function bucketAnalysis(sessions, featureFn, featureName, bucketCount = 5) {
  const valid = sessions
    .map(s => ({ feature: featureFn(s), ret: s.overnightReturn, retPct: s.overnightReturnPct }))
    .filter(d => d.feature != null && !isNaN(d.feature) && isFinite(d.feature) && !isNaN(d.ret));

  if (valid.length < 20) {
    console.log(`  ${featureName}: insufficient data (${valid.length} records)`);
    return null;
  }

  // Sort by feature for bucketing
  valid.sort((a, b) => a.feature - b.feature);

  const bucketSize = Math.ceil(valid.length / bucketCount);
  const buckets = [];

  for (let b = 0; b < bucketCount; b++) {
    const start = b * bucketSize;
    const end = Math.min((b + 1) * bucketSize, valid.length);
    const slice = valid.slice(start, end);

    const avgRet = slice.reduce((s, d) => s + d.ret, 0) / slice.length;
    const avgRetPct = slice.reduce((s, d) => s + d.retPct, 0) / slice.length;
    const winRate = slice.filter(d => d.ret > 0).length / slice.length * 100;
    const avgFeature = slice.reduce((s, d) => s + d.feature, 0) / slice.length;
    const minFeature = slice[0].feature;
    const maxFeature = slice[slice.length - 1].feature;

    buckets.push({
      bucket: b + 1,
      n: slice.length,
      featureRange: `${minFeature.toFixed(2)} to ${maxFeature.toFixed(2)}`,
      avgFeature: avgFeature.toFixed(4),
      avgReturn: avgRet.toFixed(2),
      avgReturnPct: avgRetPct.toFixed(4),
      winRateLong: winRate.toFixed(1),
    });
  }

  // Correlation
  const xs = valid.map(d => d.feature);
  const ys = valid.map(d => d.ret);
  const corr = correlation(xs, ys);

  return { featureName, corr, buckets, n: valid.length };
}

function categoricalAnalysis(sessions, categoryFn, categoryName) {
  const grouped = {};
  for (const s of sessions) {
    const cat = categoryFn(s);
    if (!cat || cat === 'unknown') continue;
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(s);
  }

  const results = {};
  for (const [cat, group] of Object.entries(grouped)) {
    const avgRet = group.reduce((s, d) => s + d.overnightReturn, 0) / group.length;
    const avgRetPct = group.reduce((s, d) => s + d.overnightReturnPct, 0) / group.length;
    const winRate = group.filter(d => d.overnightReturn > 0).length / group.length * 100;
    const avgRange = group.reduce((s, d) => s + d.overnightRange, 0) / group.length;
    const stdDev = Math.sqrt(group.reduce((s, d) => s + Math.pow(d.overnightReturn - avgRet, 2), 0) / group.length);

    results[cat] = {
      n: group.length,
      avgReturn: avgRet.toFixed(2),
      avgReturnPct: avgRetPct.toFixed(4),
      winRateLong: winRate.toFixed(1),
      avgRange: avgRange.toFixed(1),
      stdDev: stdDev.toFixed(2),
      sharpe: (avgRet / stdDev).toFixed(3),
    };
  }

  return { categoryName, results };
}

function printBucketResult(result) {
  if (!result) return;
  console.log(`\n═══ ${result.featureName} (n=${result.n}) ═══`);
  console.log(`  Correlation: r=${result.corr.r.toFixed(4)}, t=${result.corr.t.toFixed(2)}`);
  console.log('  ┌─────────┬────────┬──────────────────────────────┬──────────────┬──────────┬────────────┐');
  console.log('  │ Quintile│   N    │ Feature Range                │ Avg Return   │ Avg Ret% │ Win% Long  │');
  console.log('  ├─────────┼────────┼──────────────────────────────┼──────────────┼──────────┼────────────┤');
  for (const b of result.buckets) {
    console.log(`  │   Q${b.bucket}    │ ${String(b.n).padStart(5)} │ ${b.featureRange.padEnd(28)} │ ${b.avgReturn.padStart(12)} │ ${b.avgReturnPct.padStart(8)} │ ${b.winRateLong.padStart(8)}%  │`);
  }
  console.log('  └─────────┴────────┴──────────────────────────────┴──────────────┴──────────┴────────────┘');
}

function printCategoricalResult(result) {
  console.log(`\n═══ ${result.categoryName} ═══`);
  console.log('  ┌──────────────────────┬────────┬──────────────┬──────────┬────────────┬──────────┬─────────┐');
  console.log('  │ Category             │   N    │ Avg Return   │ Avg Ret% │ Win% Long  │ Avg Rng  │ Sharpe  │');
  console.log('  ├──────────────────────┼────────┼──────────────┼──────────┼────────────┼──────────┼─────────┤');
  for (const [cat, stats] of Object.entries(result.results)) {
    console.log(`  │ ${cat.padEnd(20)} │ ${String(stats.n).padStart(5)} │ ${stats.avgReturn.padStart(12)} │ ${stats.avgReturnPct.padStart(8)} │ ${stats.winRateLong.padStart(8)}%  │ ${stats.avgRange.padStart(8)} │ ${stats.sharpe.padStart(7)} │`);
  }
  console.log('  └──────────────────────┴────────┴──────────────┴──────────┴────────────┴──────────┴─────────┘');
}

// ============================================================================
// SIMPLE STRATEGY BACKTESTS
// ============================================================================

function simpleStrategyTest(sessions, signalFn, strategyName) {
  let totalPnL = 0;
  let wins = 0;
  let losses = 0;
  let trades = 0;
  let longTrades = 0;
  let shortTrades = 0;
  let longPnL = 0;
  let shortPnL = 0;

  for (const s of sessions) {
    const signal = signalFn(s);
    if (signal === 0) continue; // No trade

    trades++;
    const pnl = signal * s.overnightReturn; // +1 for long, -1 for short

    if (signal > 0) {
      longTrades++;
      longPnL += pnl;
    } else {
      shortTrades++;
      shortPnL += pnl;
    }

    totalPnL += pnl;
    if (pnl > 0) wins++;
    else losses++;
  }

  if (trades === 0) return null;

  return {
    strategyName,
    trades,
    winRate: (wins / trades * 100).toFixed(1),
    totalPnL: totalPnL.toFixed(1),
    avgPnL: (totalPnL / trades).toFixed(2),
    longTrades,
    shortTrades,
    longPnL: longPnL.toFixed(1),
    shortPnL: shortPnL.toFixed(1),
    avgLongPnL: longTrades > 0 ? (longPnL / longTrades).toFixed(2) : 'N/A',
    avgShortPnL: shortTrades > 0 ? (shortPnL / shortTrades).toFixed(2) : 'N/A',
    profitFactor: losses > 0 ? (wins / losses).toFixed(2) : 'inf',
  };
}

function printStrategyResult(result) {
  if (!result) return;
  console.log(`  ${result.strategyName}: ${result.trades} trades, WR=${result.winRate}%, ` +
    `Total=${result.totalPnL}pts, Avg=${result.avgPnL}pts/trade, ` +
    `Long(${result.longTrades})=${result.avgLongPnL}pts, Short(${result.shortTrades})=${result.avgShortPnL}pts`);
}

// ============================================================================
// MAIN
// ============================================================================

function runTickerAnalysis(ticker, candles, dailyGex, intradayGex, ivData, ltData) {
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  OVERNIGHT FEATURE ANALYSIS — ${ticker.toUpperCase()} Futures`);
  console.log(`  Session: 6 PM - 8 AM EST`);
  console.log(`${'═'.repeat(70)}\n`);

  // Compute overnight sessions
  const sessions = computeOvernightSessions(candles);

  // Enrich sessions with features
  for (const s of sessions) {
    // GEX features (prefer intraday EOD, fallback to daily)
    const gex = intradayGex[s.date] || null;
    const gexDaily = dailyGex[s.date] || null;

    s.gexRegime = gex?.regime || gexDaily?.regime || null;
    s.totalGex = gex?.totalGex || gexDaily?.totalGex || null;
    s.totalVex = gex?.totalVex || null;
    s.totalCex = gex?.totalCex || null;
    s.gammaFlip = gex?.gammaFlip || gexDaily?.gammaFlip || null;
    s.callWall = gex?.callWall || gexDaily?.callWall1 || null;
    s.putWall = gex?.putWall || gexDaily?.putWall1 || null;

    // Distance features (relative to RTH close)
    if (s.gammaFlip && s.rthClosePrice) {
      s.distToGammaFlip = s.rthClosePrice - s.gammaFlip;
      s.distToGammaFlipPct = s.distToGammaFlip / s.rthClosePrice * 100;
      s.aboveGammaFlip = s.rthClosePrice > s.gammaFlip ? 1 : 0;
    }
    if (s.callWall && s.rthClosePrice) {
      s.distToCallWall = s.callWall - s.rthClosePrice;
      s.distToCallWallPct = s.distToCallWall / s.rthClosePrice * 100;
    }
    if (s.putWall && s.rthClosePrice) {
      s.distToPutWall = s.rthClosePrice - s.putWall;
      s.distToPutWallPct = s.distToPutWall / s.rthClosePrice * 100;
    }
    // GEX range: distance between call and put walls
    if (s.callWall && s.putWall) {
      s.gexRange = s.callWall - s.putWall;
      s.pricePositionInGex = s.rthClosePrice && s.gexRange > 0
        ? (s.rthClosePrice - s.putWall) / s.gexRange
        : null;
    }

    // IV features
    const iv = ivData[s.date] || null;
    s.eodIV = iv?.eodIV || null;
    s.ivChange = iv?.ivChange || null;
    s.ivChangePercent = iv?.ivChangePercent || null;
    s.eodSkew = iv?.eodSkew || null;
    s.ivRange = iv?.ivRange || null;

    // LT features
    const lt = ltData[s.date] || null;
    s.ltSentiment = lt?.sentiment || null;
    s.ltLevels = lt?.levels || null;

    // Derived: where price sits relative to LT levels
    if (s.ltLevels && s.rthClosePrice) {
      const above = s.ltLevels.filter(l => s.rthClosePrice > l).length;
      s.ltLevelsAbove = above;
      s.ltLevelsBelow = 5 - above;
    }
  }

  // ========================================================================
  // BASELINE STATS
  // ========================================================================
  console.log('\n═══ BASELINE: ALL OVERNIGHT SESSIONS ═══');
  const validSessions = sessions.filter(s => !isNaN(s.overnightReturn));
  const avgReturn = validSessions.reduce((s, d) => s + d.overnightReturn, 0) / validSessions.length;
  const winRate = validSessions.filter(s => s.overnightReturn > 0).length / validSessions.length * 100;
  const avgRange = validSessions.reduce((s, d) => s + d.overnightRange, 0) / validSessions.length;
  const stdDev = Math.sqrt(validSessions.reduce((s, d) => s + Math.pow(d.overnightReturn - avgReturn, 2), 0) / validSessions.length);

  console.log(`  Total sessions: ${validSessions.length}`);
  console.log(`  Date range: ${validSessions[0]?.date} to ${validSessions[validSessions.length - 1]?.date}`);
  console.log(`  Avg overnight return: ${avgReturn.toFixed(2)} pts (${(avgReturn / validSessions[0]?.rthClosePrice * 100 || 0).toFixed(4)}%)`);
  console.log(`  Win rate (long bias): ${winRate.toFixed(1)}%`);
  console.log(`  Avg overnight range: ${avgRange.toFixed(1)} pts`);
  console.log(`  StdDev: ${stdDev.toFixed(2)} pts`);
  console.log(`  Sharpe (overnight): ${(avgReturn / stdDev).toFixed(3)}`);

  // ========================================================================
  // FEATURE CORRELATIONS (continuous)
  // ========================================================================
  console.log('\n\n╔══════════════════════════════════════════════════════════╗');
  console.log('║  CONTINUOUS FEATURE ANALYSIS (quintile buckets)         ║');
  console.log('╚══════════════════════════════════════════════════════════╝');

  const continuousFeatures = [
    { name: 'RTH Return (mean reversion?)', fn: s => s.rthReturn },
    { name: 'RTH Return % (normalized)', fn: s => s.rthReturnPct },
    { name: 'RTH Range (volatility)', fn: s => s.rthRange },
    { name: 'Total GEX', fn: s => s.totalGex },
    { name: 'Total VEX (vega exposure)', fn: s => s.totalVex },
    { name: 'Total CEX (charm exposure)', fn: s => s.totalCex },
    { name: 'Dist to Gamma Flip (pts)', fn: s => s.distToGammaFlip },
    { name: 'Dist to Gamma Flip (%)', fn: s => s.distToGammaFlipPct },
    { name: 'Dist to Call Wall (pts)', fn: s => s.distToCallWall },
    { name: 'Dist to Put Wall (pts)', fn: s => s.distToPutWall },
    { name: 'GEX Range (call-put wall)', fn: s => s.gexRange },
    { name: 'Price Position in GEX (0=put,1=call)', fn: s => s.pricePositionInGex },
    { name: 'EOD IV', fn: s => s.eodIV },
    { name: 'IV Change (intraday)', fn: s => s.ivChange },
    { name: 'IV Change % (intraday)', fn: s => s.ivChangePercent },
    { name: 'EOD Put-Call Skew', fn: s => s.eodSkew },
    { name: 'IV Range (intraday)', fn: s => s.ivRange },
    { name: 'LT Levels Above Price', fn: s => s.ltLevelsAbove },
  ];

  for (const f of continuousFeatures) {
    const result = bucketAnalysis(sessions, f.fn, f.name);
    printBucketResult(result);
  }

  // ========================================================================
  // CATEGORICAL ANALYSIS
  // ========================================================================
  console.log('\n\n╔══════════════════════════════════════════════════════════╗');
  console.log('║  CATEGORICAL FEATURE ANALYSIS                          ║');
  console.log('╚══════════════════════════════════════════════════════════╝');

  const catResults = [
    categoricalAnalysis(sessions, s => s.gexRegime, 'GEX Regime'),
    categoricalAnalysis(sessions, s => s.dayOfWeek, 'Day of Week'),
    categoricalAnalysis(sessions, s => s.ltSentiment, 'LT Sentiment'),
    categoricalAnalysis(sessions, s => s.aboveGammaFlip != null ? (s.aboveGammaFlip ? 'Above' : 'Below') : null, 'Price vs Gamma Flip'),
    categoricalAnalysis(sessions, s => {
      if (!s.rthReturn) return null;
      if (s.rthReturn > 50) return 'Strong Up (>50)';
      if (s.rthReturn > 0) return 'Mild Up (0-50)';
      if (s.rthReturn > -50) return 'Mild Down (-50-0)';
      return 'Strong Down (<-50)';
    }, 'RTH Return Category'),
    categoricalAnalysis(sessions, s => {
      if (s.eodIV == null) return null;
      if (s.eodIV < 0.15) return 'Low IV (<15%)';
      if (s.eodIV < 0.20) return 'Med IV (15-20%)';
      if (s.eodIV < 0.30) return 'High IV (20-30%)';
      return 'V.High IV (>30%)';
    }, 'EOD IV Level'),
    categoricalAnalysis(sessions, s => {
      if (s.pricePositionInGex == null) return null;
      if (s.pricePositionInGex < 0.2) return 'Near Put Wall (0-20%)';
      if (s.pricePositionInGex < 0.4) return 'Lower Mid (20-40%)';
      if (s.pricePositionInGex < 0.6) return 'Middle (40-60%)';
      if (s.pricePositionInGex < 0.8) return 'Upper Mid (60-80%)';
      return 'Near Call Wall (80-100%)';
    }, 'Price Position in GEX Range'),
  ];

  for (const r of catResults) {
    printCategoricalResult(r);
  }

  // ========================================================================
  // SIMPLE STRATEGY TESTS
  // ========================================================================
  console.log('\n\n╔══════════════════════════════════════════════════════════╗');
  console.log('║  SIMPLE STRATEGY TESTS (signal=+1 long, -1 short)      ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  const strategies = [
    // Baseline: always long
    { name: 'Always Long', fn: s => 1 },

    // Mean reversion: short after up day, long after down day
    { name: 'RTH Mean Reversion', fn: s => s.rthReturn > 0 ? -1 : 1 },
    { name: 'RTH Momentum', fn: s => s.rthReturn > 0 ? 1 : -1 },

    // Strong moves only
    { name: 'Mean Rev (strong: |RTH| > 50pts)', fn: s => {
      if (Math.abs(s.rthReturn) < 50) return 0;
      return s.rthReturn > 0 ? -1 : 1;
    }},
    { name: 'Mean Rev (strong: |RTH| > 100pts)', fn: s => {
      if (Math.abs(s.rthReturn) < 100) return 0;
      return s.rthReturn > 0 ? -1 : 1;
    }},

    // GEX regime
    { name: 'Long in positive GEX, short in negative', fn: s => {
      if (s.gexRegime === 'positive' || s.gexRegime === 'strong_positive') return 1;
      if (s.gexRegime === 'negative' || s.gexRegime === 'strong_negative') return -1;
      return 0;
    }},

    // Gamma flip position
    { name: 'Long above gamma flip, short below', fn: s => {
      if (s.aboveGammaFlip == null) return 0;
      return s.aboveGammaFlip ? 1 : -1;
    }},
    { name: 'Short above gamma flip, long below (reversion)', fn: s => {
      if (s.aboveGammaFlip == null) return 0;
      return s.aboveGammaFlip ? -1 : 1;
    }},

    // IV-based
    { name: 'Long when IV dropped today, short when rose', fn: s => {
      if (s.ivChange == null) return 0;
      return s.ivChange < 0 ? 1 : -1;
    }},
    { name: 'Long when IV rose today (fear → reversal)', fn: s => {
      if (s.ivChange == null) return 0;
      return s.ivChange > 0 ? 1 : -1;
    }},

    // LT Sentiment
    { name: 'Long BULLISH LT, short BEARISH', fn: s => {
      if (s.ltSentiment === 'BULLISH') return 1;
      if (s.ltSentiment === 'BEARISH') return -1;
      return 0;
    }},

    // CEX/charm direction
    { name: 'Long positive CEX, short negative (charm)', fn: s => {
      if (s.totalCex == null) return 0;
      return s.totalCex > 0 ? 1 : -1;
    }},

    // GEX position
    { name: 'Long near put wall (<30%), short near call (>70%)', fn: s => {
      if (s.pricePositionInGex == null) return 0;
      if (s.pricePositionInGex < 0.3) return 1;
      if (s.pricePositionInGex > 0.7) return -1;
      return 0;
    }},

    // Day of week
    { name: 'Skip Mon/Fri, mean reversion other days', fn: s => {
      if (s.dayOfWeek === 'Monday' || s.dayOfWeek === 'Friday') return 0;
      return s.rthReturn > 0 ? -1 : 1;
    }},

    // Combo: GEX regime + mean reversion
    { name: 'Combo: pos GEX + down day → long', fn: s => {
      if (!s.gexRegime) return 0;
      const posGex = s.gexRegime === 'positive' || s.gexRegime === 'strong_positive';
      if (posGex && s.rthReturn < 0) return 1;
      return 0;
    }},
    { name: 'Combo: neg GEX + up day → short', fn: s => {
      if (!s.gexRegime) return 0;
      const negGex = s.gexRegime === 'negative' || s.gexRegime === 'strong_negative';
      if (negGex && s.rthReturn > 0) return -1;
      return 0;
    }},
    { name: 'Combo: neg GEX + up day → short OR pos GEX + down → long', fn: s => {
      if (!s.gexRegime) return 0;
      const posGex = s.gexRegime === 'positive' || s.gexRegime === 'strong_positive';
      const negGex = s.gexRegime === 'negative' || s.gexRegime === 'strong_negative';
      if (posGex && s.rthReturn < 0) return 1;
      if (negGex && s.rthReturn > 0) return -1;
      return 0;
    }},

    // IV skew
    { name: 'Long when put skew high (>0.02), short when call skew', fn: s => {
      if (s.eodSkew == null) return 0;
      if (s.eodSkew > 0.02) return 1;  // Put IV >> Call IV → fear → reversal overnight
      if (s.eodSkew < -0.02) return -1;
      return 0;
    }},

    // GEX magnitude
    { name: 'Long when GEX > 0 (positive gamma → mean revert)', fn: s => {
      if (s.totalGex == null) return 0;
      return s.totalGex > 0 ? 1 : -1;
    }},
  ];

  for (const strat of strategies) {
    const result = simpleStrategyTest(sessions, strat.fn, strat.name);
    printStrategyResult(result);
  }

  // ========================================================================
  // MULTI-FEATURE RANKING
  // ========================================================================
  console.log('\n\n╔══════════════════════════════════════════════════════════╗');
  console.log('║  FEATURE IMPORTANCE RANKING (by |correlation|)          ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  const featureCorrs = [];
  for (const f of continuousFeatures) {
    const valid = sessions
      .map(s => ({ x: f.fn(s), y: s.overnightReturn }))
      .filter(d => d.x != null && !isNaN(d.x) && isFinite(d.x) && !isNaN(d.y));

    if (valid.length >= 20) {
      const corr = correlation(valid.map(d => d.x), valid.map(d => d.y));
      featureCorrs.push({ name: f.name, r: corr.r, t: corr.t, n: valid.length });
    }
  }

  featureCorrs.sort((a, b) => Math.abs(b.r) - Math.abs(a.r));

  console.log('  Rank  Feature                                    r        t-stat   n');
  console.log('  ────  ───────────────────────────────────────────────────────────────');
  for (let i = 0; i < featureCorrs.length; i++) {
    const f = featureCorrs[i];
    const sig = Math.abs(f.t) > 2 ? ' **' : Math.abs(f.t) > 1.65 ? ' *' : '';
    console.log(`  ${String(i + 1).padStart(4)}  ${f.name.padEnd(45)} ${f.r.toFixed(4).padStart(7)}  ${f.t.toFixed(2).padStart(8)}  ${String(f.n).padStart(4)}${sig}`);
  }
  console.log('\n  ** = significant at p<0.05, * = significant at p<0.10');

  // ========================================================================
  // OVERNIGHT RETURN DISTRIBUTION
  // ========================================================================
  console.log('\n\n╔══════════════════════════════════════════════════════════╗');
  console.log('║  OVERNIGHT RETURN DISTRIBUTION                          ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  const returns = validSessions.map(s => s.overnightReturn).sort((a, b) => a - b);
  const p10 = returns[Math.floor(returns.length * 0.10)];
  const p25 = returns[Math.floor(returns.length * 0.25)];
  const p50 = returns[Math.floor(returns.length * 0.50)];
  const p75 = returns[Math.floor(returns.length * 0.75)];
  const p90 = returns[Math.floor(returns.length * 0.90)];

  console.log(`  P10: ${p10.toFixed(1)} pts`);
  console.log(`  P25: ${p25.toFixed(1)} pts`);
  console.log(`  P50 (median): ${p50.toFixed(1)} pts`);
  console.log(`  P75: ${p75.toFixed(1)} pts`);
  console.log(`  P90: ${p90.toFixed(1)} pts`);
  console.log(`  Max gain: ${returns[returns.length - 1].toFixed(1)} pts`);
  console.log(`  Max loss: ${returns[0].toFixed(1)} pts`);

  const avgMFE = validSessions.reduce((s, d) => s + d.overnightMFE_long, 0) / validSessions.length;
  const avgMAE = validSessions.reduce((s, d) => s + d.overnightMAE_long, 0) / validSessions.length;
  console.log(`\n  Avg MFE (long): ${avgMFE.toFixed(1)} pts`);
  console.log(`  Avg MAE (long): ${avgMAE.toFixed(1)} pts`);
  console.log(`  MFE/MAE ratio: ${(avgMFE / avgMAE).toFixed(2)}`);

  console.log(`\n  ${ticker.toUpperCase()} ANALYSIS COMPLETE`);

  return sessions;
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  OVERNIGHT FEATURE ANALYSIS — NQ & ES Futures');
  console.log('  Session: 6 PM - 8 AM EST');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // Load NQ data
  const nqCandles = loadOHLCV('nq');
  const nqDailyGex = loadDailyGEX();
  const nqIntradayGex = loadIntradayGEX('nq');
  const ivData = loadIV();
  const ltData = loadLT();

  // Load ES data
  const esCandles = loadOHLCV('es');
  const esIntradayGex = loadIntradayGEX('es');

  // Run analysis for each ticker
  const nqSessions = runTickerAnalysis('NQ', nqCandles, nqDailyGex, nqIntradayGex, ivData, ltData);
  const esSessions = runTickerAnalysis('ES', esCandles, {}, esIntradayGex, {}, {});

  // ========================================================================
  // NQ vs ES DIVERGENCE ANALYSIS
  // ========================================================================
  console.log('\n\n' + '═'.repeat(70));
  console.log('  NQ vs ES OVERNIGHT DIVERGENCE ANALYSIS');
  console.log('═'.repeat(70) + '\n');

  // Match sessions by date
  const nqByDate = {};
  for (const s of nqSessions) nqByDate[s.date] = s;
  const esByDate = {};
  for (const s of esSessions) esByDate[s.date] = s;

  const commonDates = Object.keys(nqByDate).filter(d => esByDate[d]);
  console.log(`  Common dates: ${commonDates.length}`);

  if (commonDates.length > 20) {
    const paired = commonDates.map(d => ({
      date: d,
      nqRet: nqByDate[d].overnightReturn,
      esRet: esByDate[d].overnightReturn,
      nqRetPct: nqByDate[d].overnightReturnPct,
      esRetPct: esByDate[d].overnightReturnPct,
      nqRthRet: nqByDate[d].rthReturn,
      esRthRet: esByDate[d].rthReturn,
    }));

    // Correlation between NQ and ES overnight returns
    const corrRet = correlation(paired.map(p => p.nqRet), paired.map(p => p.esRet));
    console.log(`  NQ-ES overnight return correlation: r=${corrRet.r.toFixed(4)}, t=${corrRet.t.toFixed(2)}`);

    // Avg returns
    const avgNQ = paired.reduce((s, p) => s + p.nqRet, 0) / paired.length;
    const avgES = paired.reduce((s, p) => s + p.esRet, 0) / paired.length;
    console.log(`  Avg NQ overnight: ${avgNQ.toFixed(2)} pts`);
    console.log(`  Avg ES overnight: ${avgES.toFixed(2)} pts`);

    // Win rate comparison
    const nqWR = paired.filter(p => p.nqRet > 0).length / paired.length * 100;
    const esWR = paired.filter(p => p.esRet > 0).length / paired.length * 100;
    console.log(`  NQ win rate (long bias): ${nqWR.toFixed(1)}%`);
    console.log(`  ES win rate (long bias): ${esWR.toFixed(1)}%`);

    // StdDev comparison
    const nqStd = Math.sqrt(paired.reduce((s, p) => s + Math.pow(p.nqRet - avgNQ, 2), 0) / paired.length);
    const esStd = Math.sqrt(paired.reduce((s, p) => s + Math.pow(p.esRet - avgES, 2), 0) / paired.length);
    console.log(`  NQ overnight stddev: ${nqStd.toFixed(2)} pts`);
    console.log(`  ES overnight stddev: ${esStd.toFixed(2)} pts`);
    console.log(`  NQ overnight Sharpe: ${(avgNQ / nqStd).toFixed(3)}`);
    console.log(`  ES overnight Sharpe: ${(avgES / esStd).toFixed(3)}`);

    // Divergence analysis: when NQ and ES move in opposite directions
    const divergent = paired.filter(p => (p.nqRet > 0) !== (p.esRet > 0));
    console.log(`\n  Divergent nights (NQ and ES opposite direction): ${divergent.length} (${(divergent.length / paired.length * 100).toFixed(1)}%)`);

    if (divergent.length > 10) {
      const nqWinsDiv = divergent.filter(p => Math.abs(p.nqRet) > Math.abs(p.esRet)).length;
      console.log(`  When divergent, NQ direction wins: ${nqWinsDiv}/${divergent.length} (${(nqWinsDiv / divergent.length * 100).toFixed(1)}%)`);
      console.log(`  When divergent, ES direction wins: ${divergent.length - nqWinsDiv}/${divergent.length}`);
    }

    // ES spread (ES ret - NQ ret normalized to points): does one consistently outperform?
    const spread = paired.map(p => p.esRet - p.nqRet * (5 / 20)); // normalize NQ $20/pt to ES $50/pt → multiply NQ by 0.25
    const avgSpread = spread.reduce((s, v) => s + v, 0) / spread.length;
    console.log(`\n  ES-NQ overnight spread ($ normalized): avg=${avgSpread.toFixed(2)}`);

    // RTH return → overnight NQ return vs RTH return → overnight ES return
    const corrNqRthToNqON = correlation(paired.map(p => p.nqRthRet), paired.map(p => p.nqRet));
    const corrEsRthToEsON = correlation(paired.map(p => p.esRthRet), paired.map(p => p.esRet));
    const corrNqRthToEsON = correlation(paired.map(p => p.nqRthRet), paired.map(p => p.esRet));
    const corrEsRthToNqON = correlation(paired.map(p => p.esRthRet), paired.map(p => p.nqRet));

    console.log('\n  Cross-correlations (RTH return → overnight return):');
    console.log(`    NQ RTH → NQ overnight: r=${corrNqRthToNqON.r.toFixed(4)}`);
    console.log(`    ES RTH → ES overnight: r=${corrEsRthToEsON.r.toFixed(4)}`);
    console.log(`    NQ RTH → ES overnight: r=${corrNqRthToEsON.r.toFixed(4)}`);
    console.log(`    ES RTH → NQ overnight: r=${corrEsRthToNqON.r.toFixed(4)}`);

    // Test: Use NQ GEX features to predict ES overnight (cross-product)
    console.log('\n  Cross-product strategies (NQ signals → ES trades):');

    const crossStrategies = [
      { name: 'NQ mean rev → ES overnight', fn: p => {
        return p.nqRthRet > 0 ? -1 : 1; // reverse NQ RTH direction, trade ES overnight
      }},
      { name: 'ES mean rev → ES overnight', fn: p => {
        return p.esRthRet > 0 ? -1 : 1;
      }},
      { name: 'NQ RTH momentum → ES overnight', fn: p => {
        return p.nqRthRet > 0 ? 1 : -1;
      }},
    ];

    for (const strat of crossStrategies) {
      let pnl = 0, trades = 0, wins = 0;
      for (const p of paired) {
        const sig = strat.fn(p);
        if (sig === 0) continue;
        trades++;
        const ret = sig * p.esRet;
        pnl += ret;
        if (ret > 0) wins++;
      }
      console.log(`    ${strat.name}: ${trades} trades, WR=${(wins/trades*100).toFixed(1)}%, Avg=${(pnl/trades).toFixed(2)} ES pts`);
    }

    // Charm/dealer flow analysis: does CEX predict ES better than NQ?
    console.log('\n  CEX (Charm Exposure) → Overnight by Product:');
    const nqWithCex = commonDates.filter(d => nqByDate[d].totalCex != null);
    if (nqWithCex.length > 20) {
      // NQ CEX → NQ overnight
      const corrCexNq = correlation(
        nqWithCex.map(d => nqByDate[d].totalCex),
        nqWithCex.map(d => nqByDate[d].overnightReturn)
      );
      console.log(`    NQ CEX → NQ overnight: r=${corrCexNq.r.toFixed(4)}, n=${corrCexNq.n}`);

      // NQ CEX → ES overnight (cross-product: QQQ options charm → ES movement)
      const nqCexEsPaired = nqWithCex.filter(d => esByDate[d]);
      if (nqCexEsPaired.length > 20) {
        const corrCexEs = correlation(
          nqCexEsPaired.map(d => nqByDate[d].totalCex),
          nqCexEsPaired.map(d => esByDate[d].overnightReturn)
        );
        console.log(`    NQ CEX → ES overnight: r=${corrCexEs.r.toFixed(4)}, n=${corrCexEs.n}`);
      }
    }

    // ES CEX (from SPY options) → ES overnight
    const esWithCex = commonDates.filter(d => esByDate[d].totalCex != null);
    if (esWithCex.length > 20) {
      const corrEsCex = correlation(
        esWithCex.map(d => esByDate[d].totalCex),
        esWithCex.map(d => esByDate[d].overnightReturn)
      );
      console.log(`    ES CEX → ES overnight: r=${corrEsCex.r.toFixed(4)}, n=${corrEsCex.n}`);
    }
  }

  console.log('\n' + '═'.repeat(70));
  console.log('  ALL ANALYSIS COMPLETE');
  console.log('═'.repeat(70));
}

main().catch(console.error);
