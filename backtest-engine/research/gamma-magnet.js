/**
 * Study 3: Gamma Magnet — Expiration Day Price Pinning
 *
 * Market Maker Logic: On expiration days, the strike with highest gamma concentration
 * creates a mechanical attractor. As price approaches, dealer hedging accelerates
 * convergence. This is code executing a hedging mandate — not discretionary trading.
 *
 * Core Questions:
 *  1. How close does RTH close get to various "magnet" candidates each day?
 *  2. Expiration days vs non-expiration: is convergence stronger?
 *  3. Does distance-to-magnet decrease hour-by-hour (intraday convergence)?
 *  4. Can you fade moves >25pts away from the magnet for a 10-15pt reversion?
 *  5. Does GEX regime or total_gex magnitude affect magnet strength?
 *  6. Which magnet candidate is most reliable?
 *
 * Magnet Candidates:
 *   - gamma_flip: Net gamma zero crossing
 *   - call_wall: Highest call OI concentration
 *   - put_wall: Highest put OI concentration
 *   - midpoint: (call_wall + put_wall) / 2
 *   - nearest: Closest support/resistance to current price
 *
 * Usage:
 *   node research/gamma-magnet.js [--product NQ|ES]
 */

import {
  loadContinuousOHLCV,
  extractTradingDates,
  getRTHCandlesFromArray,
  loadIntradayGEX,
  getGEXSnapshotAt,
  toET,
  fromET
} from './utils/data-loader.js';

import {
  round,
  bucket,
  saveResults,
  calculatePercentiles,
  correlation
} from './utils/analysis-helpers.js';

// --- CLI Args ---
const args = process.argv.slice(2);
const product = (args.find(a => a === '--product') ? args[args.indexOf('--product') + 1] : 'NQ').toUpperCase();

console.log(`\n=== Gamma Magnet Study: ${product} ===\n`);

// --- Expiration Day Classification ---

function getMonthlyOpEx(year, month) {
  // 3rd Friday of the month
  const firstDay = new Date(Date.UTC(year, month, 1));
  let fridayCount = 0;
  for (let d = 1; d <= 31; d++) {
    const dt = new Date(Date.UTC(year, month, d));
    if (dt.getUTCMonth() !== month) break;
    if (dt.getUTCDay() === 5) { // Friday
      fridayCount++;
      if (fridayCount === 3) {
        return `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      }
    }
  }
  return null;
}

function buildExpirationCalendar(startYear, endYear) {
  const monthlyOpEx = new Set();
  const weeklyOpEx = new Set(); // All Fridays
  const allFridays = new Set();

  for (let y = startYear; y <= endYear; y++) {
    for (let m = 0; m < 12; m++) {
      const monthly = getMonthlyOpEx(y, m);
      if (monthly) monthlyOpEx.add(monthly);

      // All Fridays in this month
      for (let d = 1; d <= 31; d++) {
        const dt = new Date(Date.UTC(y, m, d));
        if (dt.getUTCMonth() !== m) break;
        if (dt.getUTCDay() === 5) {
          const dateStr = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
          allFridays.add(dateStr);
          if (!monthlyOpEx.has(dateStr)) weeklyOpEx.add(dateStr);
        }
      }
    }
  }

  return { monthlyOpEx, weeklyOpEx, allFridays };
}

function classifyExpirationDay(dateStr, expirationCal) {
  if (expirationCal.monthlyOpEx.has(dateStr)) return 'monthly_opex';
  if (expirationCal.weeklyOpEx.has(dateStr)) return 'weekly_opex';

  // Check if it's the day before an expiration (Thursday before Friday OpEx)
  const dt = new Date(dateStr + 'T12:00:00Z');
  const tomorrow = new Date(dt);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const tomorrowStr = tomorrow.toISOString().split('T')[0];
  if (expirationCal.allFridays.has(tomorrowStr)) return 'pre_expiration';

  // All trading days are 0DTE days post-2022 (QQQ/SPY daily expirations)
  const year = parseInt(dateStr.split('-')[0]);
  if (year >= 2023) return '0dte';

  return 'regular';
}

// --- Main ---
(async () => {
  const startDate = '2023-03-28'; // GEX data starts here
  const endDate = '2026-01-31';

  console.log('Loading continuous 1m data...');
  const candles = await loadContinuousOHLCV(product, '1m', startDate, endDate);
  const tradingDates = extractTradingDates(candles);
  console.log(`Found ${tradingDates.length} trading days with RTH data`);

  const expirationCal = buildExpirationCalendar(2023, 2026);
  console.log(`Monthly OpEx dates: ${expirationCal.monthlyOpEx.size}, Weekly OpEx: ${expirationCal.weeklyOpEx.size}\n`);

  const spotKey = product === 'NQ' ? 'nq_spot' : 'es_spot';

  const dayResults = [];
  let noGEX = 0;

  // Hourly checkpoints for convergence analysis (ET hours during RTH)
  const checkpointHours = [10, 11, 12, 13, 14, 15]; // 10 AM through 3 PM ET

  for (const dateStr of tradingDates) {
    const gexSnapshots = loadIntradayGEX(product, dateStr);
    if (!gexSnapshots || gexSnapshots.length === 0) {
      noGEX++;
      continue;
    }

    const rthCandles = getRTHCandlesFromArray(candles, dateStr);
    if (rthCandles.length < 30) continue;

    const rthOpen = rthCandles[0].open;
    const rthClose = rthCandles[rthCandles.length - 1].close;
    const rthHigh = Math.max(...rthCandles.map(c => c.high));
    const rthLow = Math.min(...rthCandles.map(c => c.low));

    // Morning GEX snapshot (closest to 9:30 AM ET)
    const [year, month, day] = dateStr.split('-').map(Number);
    const rthOpenUtc = fromET(year, month - 1, day, 9, 30);
    const morningGEX = getGEXSnapshotAt(gexSnapshots, rthOpenUtc);

    if (!morningGEX) continue;

    // Magnet candidates from morning snapshot
    const magnets = {
      gamma_flip: morningGEX.gamma_flip,
      call_wall: morningGEX.call_wall,
      put_wall: morningGEX.put_wall,
      midpoint: morningGEX.call_wall && morningGEX.put_wall
        ? round((morningGEX.call_wall + morningGEX.put_wall) / 2, 2)
        : null,
      nearest: null // Will be computed below
    };

    // Nearest support/resistance to RTH open price
    const allLevels = [
      ...(morningGEX.resistance || []),
      ...(morningGEX.support || []),
      morningGEX.gamma_flip,
      morningGEX.call_wall,
      morningGEX.put_wall
    ].filter(v => v && !isNaN(v));

    if (allLevels.length > 0) {
      allLevels.sort((a, b) => Math.abs(a - rthOpen) - Math.abs(b - rthOpen));
      magnets.nearest = allLevels[0];
    }

    // Distance from RTH close to each magnet
    const closeDistances = {};
    for (const [name, level] of Object.entries(magnets)) {
      if (level !== null && !isNaN(level)) {
        closeDistances[name] = round(Math.abs(rthClose - level), 2);
      }
    }

    // Hourly convergence: distance to each magnet at each checkpoint
    const hourlyConvergence = {};
    for (const [name, level] of Object.entries(magnets)) {
      if (level === null || isNaN(level)) continue;
      hourlyConvergence[name] = [];

      // Distance at open
      hourlyConvergence[name].push({
        hour: 'open',
        distance: round(Math.abs(rthOpen - level), 2)
      });

      for (const checkHour of checkpointHours) {
        const checkUtc = fromET(year, month - 1, day, checkHour, 0);
        // Find closest 1m candle
        let closest = null;
        let minDiff = Infinity;
        for (const c of rthCandles) {
          const diff = Math.abs(c.timestamp - checkUtc);
          if (diff < minDiff) { minDiff = diff; closest = c; }
        }
        if (closest && minDiff < 600000) { // Within 10 minutes
          hourlyConvergence[name].push({
            hour: checkHour,
            distance: round(Math.abs(closest.close - level), 2)
          });
        }
      }

      // Distance at close
      hourlyConvergence[name].push({
        hour: 'close',
        distance: round(Math.abs(rthClose - level), 2)
      });
    }

    // Is distance generally decreasing? (convergence score)
    const convergenceScores = {};
    for (const [name, points] of Object.entries(hourlyConvergence)) {
      if (points.length < 3) continue;
      let decreasing = 0;
      for (let i = 1; i < points.length; i++) {
        if (points[i].distance < points[i - 1].distance) decreasing++;
      }
      convergenceScores[name] = round(decreasing / (points.length - 1) * 100, 1);
    }

    // Fade trade simulation: if distance > 25pts at noon, fade toward magnet
    const fadeTrades = {};
    const noonUtc = fromET(year, month - 1, day, 12, 0);
    let noonCandle = null;
    for (const c of rthCandles) {
      if (Math.abs(c.timestamp - noonUtc) < 120000) { noonCandle = c; break; }
    }

    if (noonCandle) {
      const noonIdx = rthCandles.indexOf(noonCandle);

      for (const [name, level] of Object.entries(magnets)) {
        if (level === null || isNaN(level)) continue;
        const noonDist = noonCandle.close - level;
        const absDist = Math.abs(noonDist);

        if (absDist > 25) {
          // Fade: enter toward magnet
          const direction = noonDist > 0 ? -1 : 1; // Price above magnet → short; below → long
          const entryPrice = noonCandle.close;
          const target = 15; // points
          const stop = 15; // points
          let outcome = null;
          let mfe = 0, mae = 0;

          for (let j = noonIdx + 1; j < rthCandles.length; j++) {
            const c = rthCandles[j];
            const moveHigh = (c.high - entryPrice) * direction;
            const moveLow = (c.low - entryPrice) * direction;
            const favorableMove = Math.max(moveHigh, moveLow);
            const adverseMove = Math.min(moveHigh, moveLow);

            mfe = Math.max(mfe, favorableMove);
            mae = Math.min(mae, adverseMove);

            if (favorableMove >= target) { outcome = 'target'; break; }
            if (Math.abs(adverseMove) >= stop) { outcome = 'stopped'; break; }
          }

          if (outcome === null) outcome = 'expired'; // Held to close

          fadeTrades[name] = {
            noonDistance: round(absDist, 2),
            direction: direction === 1 ? 'long' : 'short',
            outcome,
            mfe: round(mfe, 2),
            mae: round(Math.abs(mae), 2),
            pnl: outcome === 'target' ? target * (product === 'NQ' ? 5 : 12.5)
               : outcome === 'stopped' ? -stop * (product === 'NQ' ? 5 : 12.5)
               : round((rthClose - entryPrice) * direction * (product === 'NQ' ? 5 : 12.5), 2)
          };
        }
      }
    }

    // Expiration classification
    const expType = classifyExpirationDay(dateStr, expirationCal);

    // GEX context
    const regime = morningGEX.regime;
    const totalGex = morningGEX.total_gex;
    const totalGexMagnitude = Math.abs(totalGex);
    const gexMagBucket = bucket(totalGexMagnitude, [50000000, 200000000, 500000000, 1000000000]);

    dayResults.push({
      date: dateStr,
      expirationType: expType,
      regime,
      totalGex: round(totalGex, 0),
      gexMagBucket,
      rthOpen: round(rthOpen, 2),
      rthClose: round(rthClose, 2),
      magnets,
      closeDistances,
      convergenceScores,
      hourlyConvergence,
      fadeTrades
    });
  }

  console.log(`Analyzed ${dayResults.length} days (${noGEX} skipped for no GEX data)\n`);

  // --- Aggregate Analysis ---

  // Close distance stats by magnet type
  const magnetNames = ['gamma_flip', 'call_wall', 'put_wall', 'midpoint', 'nearest'];
  const closeDistStats = {};

  for (const name of magnetNames) {
    const dists = dayResults.filter(d => d.closeDistances[name] !== undefined).map(d => d.closeDistances[name]);
    if (dists.length === 0) continue;
    closeDistStats[name] = {
      count: dists.length,
      avg: round(dists.reduce((a, b) => a + b, 0) / dists.length, 1),
      ...calculatePercentiles(dists, [25, 50, 75, 90]),
      within10pts: round(dists.filter(d => d <= 10).length / dists.length * 100, 1),
      within25pts: round(dists.filter(d => d <= 25).length / dists.length * 100, 1),
      within50pts: round(dists.filter(d => d <= 50).length / dists.length * 100, 1)
    };
  }

  // Close distance by expiration type
  const closeDistByExp = {};
  for (const expType of ['monthly_opex', 'weekly_opex', 'pre_expiration', '0dte', 'regular']) {
    const expDays = dayResults.filter(d => d.expirationType === expType);
    if (expDays.length < 5) continue;
    closeDistByExp[expType] = { days: expDays.length };
    for (const name of magnetNames) {
      const dists = expDays.filter(d => d.closeDistances[name] !== undefined).map(d => d.closeDistances[name]);
      if (dists.length === 0) continue;
      closeDistByExp[expType][name] = {
        avg: round(dists.reduce((a, b) => a + b, 0) / dists.length, 1),
        p50: calculatePercentiles(dists, [50]).p50,
        within25pts: round(dists.filter(d => d <= 25).length / dists.length * 100, 1)
      };
    }
  }

  // Convergence scores by magnet type
  const convergenceStats = {};
  for (const name of magnetNames) {
    const scores = dayResults.filter(d => d.convergenceScores[name] !== undefined).map(d => d.convergenceScores[name]);
    if (scores.length === 0) continue;
    convergenceStats[name] = {
      count: scores.length,
      avg: round(scores.reduce((a, b) => a + b, 0) / scores.length, 1),
      converging: round(scores.filter(s => s >= 50).length / scores.length * 100, 1), // >50% of checkpoints decrease
      stronglyConverging: round(scores.filter(s => s >= 75).length / scores.length * 100, 1)
    };
  }

  // Convergence by expiration type
  const convergenceByExp = {};
  for (const expType of ['monthly_opex', 'weekly_opex', '0dte', 'regular']) {
    const expDays = dayResults.filter(d => d.expirationType === expType);
    if (expDays.length < 5) continue;
    convergenceByExp[expType] = { days: expDays.length };
    for (const name of magnetNames) {
      const scores = expDays.filter(d => d.convergenceScores[name] !== undefined).map(d => d.convergenceScores[name]);
      if (scores.length === 0) continue;
      convergenceByExp[expType][name] = {
        avgScore: round(scores.reduce((a, b) => a + b, 0) / scores.length, 1),
        convergingPct: round(scores.filter(s => s >= 50).length / scores.length * 100, 1)
      };
    }
  }

  // Fade trade stats by magnet type
  const fadeStats = {};
  for (const name of magnetNames) {
    const trades = dayResults.filter(d => d.fadeTrades[name]).map(d => d.fadeTrades[name]);
    if (trades.length === 0) continue;
    const targets = trades.filter(t => t.outcome === 'target').length;
    const stopped = trades.filter(t => t.outcome === 'stopped').length;
    const expired = trades.filter(t => t.outcome === 'expired').length;
    const totalPnL = trades.reduce((s, t) => s + t.pnl, 0);
    fadeStats[name] = {
      count: trades.length,
      targetPct: round(targets / trades.length * 100, 1),
      stoppedPct: round(stopped / trades.length * 100, 1),
      expiredPct: round(expired / trades.length * 100, 1),
      totalPnL: round(totalPnL, 2),
      avgPnL: round(totalPnL / trades.length, 2),
      avgMFE: round(trades.reduce((s, t) => s + t.mfe, 0) / trades.length, 1),
      avgMAE: round(trades.reduce((s, t) => s + t.mae, 0) / trades.length, 1)
    };
  }

  // Fade trades by expiration type (using best magnet)
  const fadeByExp = {};
  // Find best magnet (highest target rate)
  let bestMagnet = null;
  let bestTargetRate = 0;
  for (const [name, stats] of Object.entries(fadeStats)) {
    if (stats.targetPct > bestTargetRate) { bestTargetRate = stats.targetPct; bestMagnet = name; }
  }

  if (bestMagnet) {
    for (const expType of ['monthly_opex', 'weekly_opex', '0dte', 'regular']) {
      const trades = dayResults
        .filter(d => d.expirationType === expType && d.fadeTrades[bestMagnet])
        .map(d => d.fadeTrades[bestMagnet]);
      if (trades.length < 3) continue;
      const targets = trades.filter(t => t.outcome === 'target').length;
      fadeByExp[expType] = {
        count: trades.length,
        targetPct: round(targets / trades.length * 100, 1),
        avgPnL: round(trades.reduce((s, t) => s + t.pnl, 0) / trades.length, 2)
      };
    }
  }

  // By regime
  const closeDistByRegime = {};
  for (const regime of ['strong_positive', 'positive', 'neutral', 'negative', 'strong_negative']) {
    const regDays = dayResults.filter(d => d.regime === regime);
    if (regDays.length < 5) continue;
    closeDistByRegime[regime] = { days: regDays.length };
    for (const name of magnetNames) {
      const dists = regDays.filter(d => d.closeDistances[name] !== undefined).map(d => d.closeDistances[name]);
      if (dists.length === 0) continue;
      closeDistByRegime[regime][name] = {
        avg: round(dists.reduce((a, b) => a + b, 0) / dists.length, 1),
        within25pts: round(dists.filter(d => d <= 25).length / dists.length * 100, 1)
      };
    }
  }

  // Correlations
  const totalGexMags = dayResults.map(d => Math.abs(d.totalGex));
  const corrByMagnet = {};
  for (const name of magnetNames) {
    const dists = dayResults.map(d => d.closeDistances[name] ?? NaN);
    const valid = dists.map((d, i) => [d, totalGexMags[i]]).filter(([d]) => !isNaN(d));
    if (valid.length > 10) {
      corrByMagnet[name] = correlation(valid.map(v => v[1]), valid.map(v => v[0]));
    }
  }

  // --- Console Summary ---
  console.log('Close Distance to Magnet (all days):');
  for (const [name, stats] of Object.entries(closeDistStats)) {
    console.log(`  ${name}: avg=${stats.avg} p50=${stats.p50} within25=${stats.within25pts}% (n=${stats.count})`);
  }
  console.log();

  console.log('Convergence Rate (>50% checkpoints decreasing):');
  for (const [name, stats] of Object.entries(convergenceStats)) {
    console.log(`  ${name}: avg_score=${stats.avg}% converging=${stats.converging}% strongly=${stats.stronglyConverging}%`);
  }
  console.log();

  console.log('Close Distance by Expiration Type:');
  for (const [expType, data] of Object.entries(closeDistByExp)) {
    const lines = Object.entries(data)
      .filter(([k]) => k !== 'days')
      .map(([k, v]) => `${k}:avg=${v.avg}`)
      .join(' ');
    console.log(`  ${expType} (${data.days}d): ${lines}`);
  }
  console.log();

  console.log('Fade Trade Stats (>25pts from magnet at noon):');
  for (const [name, stats] of Object.entries(fadeStats)) {
    console.log(`  ${name}: win=${stats.targetPct}% stop=${stats.stoppedPct}% avgPnL=$${stats.avgPnL} (n=${stats.count})`);
  }
  if (bestMagnet) {
    console.log(`  Best magnet: ${bestMagnet} (${bestTargetRate}% target rate)`);
    console.log('  By expiration:', JSON.stringify(fadeByExp));
  }
  console.log();

  console.log('By Regime:');
  for (const [regime, data] of Object.entries(closeDistByRegime)) {
    const mid = data.midpoint || data.gamma_flip;
    console.log(`  ${regime} (${data.days}d): midpoint avg=${mid?.avg || 'N/A'} within25=${mid?.within25pts || 'N/A'}%`);
  }

  // --- Save Results ---
  const results = {
    study: 'Gamma Magnet - Expiration Day Price Pinning',
    product,
    dateRange: { start: startDate, end: endDate },
    tradingDays: dayResults.length,
    noGEXDays: noGEX,
    timestamp: new Date().toISOString(),
    closeDistanceToMagnet: closeDistStats,
    closeDistanceByExpiration: closeDistByExp,
    convergenceScores: convergenceStats,
    convergenceByExpiration: convergenceByExp,
    fadeTradeStats: fadeStats,
    fadeByExpiration: fadeByExp,
    bestMagnet,
    closeDistanceByRegime: closeDistByRegime,
    correlations: {
      totalGexMagnitudeVsCloseDistance: corrByMagnet
    },
    // Include per-day data for deeper analysis
    dailyData: dayResults.map(d => ({
      date: d.date,
      expirationType: d.expirationType,
      regime: d.regime,
      closeDistances: d.closeDistances,
      convergenceScores: d.convergenceScores,
      fadeTrades: Object.keys(d.fadeTrades).length > 0 ? d.fadeTrades : undefined
    }))
  };

  const filename = `gamma-magnet-${product.toLowerCase()}.json`;
  saveResults(filename, results);

  console.log(`\nResults saved to results/research/${filename}`);
  console.log('Done.');
})();
