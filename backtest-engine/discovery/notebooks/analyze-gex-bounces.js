/**
 * Analyze price behavior at GEX support/resistance levels
 * Hypothesis: Price bounces off GEX levels have measurable reversion patterns
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '../../data');

// Parse CSV
function parseCSV(content) {
  const lines = content.trim().split('\n');
  const headers = lines[0].split(',');
  const data = [];

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',');
    if (values.length >= headers.length) {
      const row = {};
      headers.forEach((h, idx) => {
        row[h.trim()] = values[idx]?.trim() || '';
      });
      data.push(row);
    }
  }
  return data;
}

// Load OHLCV data for a specific date range
function loadOHLCV(startDate, endDate) {
  const filepath = path.join(DATA_DIR, 'ohlcv/nq/NQ_ohlcv_1m.csv');
  const content = fs.readFileSync(filepath, 'utf-8');
  const lines = content.trim().split('\n');
  const headers = lines[0].split(',');

  const data = [];
  const startMs = new Date(startDate).getTime();
  const endMs = new Date(endDate).getTime();

  // Parse and filter - using a streaming approach for large file
  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',');
    if (values.length < headers.length) continue;

    const ts = new Date(values[0]).getTime();
    if (ts < startMs) continue;
    if (ts > endMs) break;

    const symbol = values[9];
    // Skip calendar spreads and non-primary contracts
    if (symbol.includes('-')) continue;

    data.push({
      timestamp: ts,
      open: parseFloat(values[4]),
      high: parseFloat(values[5]),
      low: parseFloat(values[6]),
      close: parseFloat(values[7]),
      volume: parseFloat(values[8]),
      symbol: symbol
    });
  }

  return filterPrimaryContract(data);
}

// Filter to primary contract per hour
function filterPrimaryContract(candles) {
  // Group by hour
  const byHour = {};
  candles.forEach(c => {
    const hourKey = Math.floor(c.timestamp / 3600000);
    if (!byHour[hourKey]) byHour[hourKey] = [];
    byHour[hourKey].push(c);
  });

  // Find primary contract per hour (highest volume)
  const hourlyPrimary = {};
  Object.entries(byHour).forEach(([hour, hourCandles]) => {
    const volumeBySymbol = {};
    hourCandles.forEach(c => {
      volumeBySymbol[c.symbol] = (volumeBySymbol[c.symbol] || 0) + c.volume;
    });

    let maxVol = 0;
    let primary = null;
    Object.entries(volumeBySymbol).forEach(([symbol, vol]) => {
      if (vol > maxVol) {
        maxVol = vol;
        primary = symbol;
      }
    });
    hourlyPrimary[hour] = primary;
  });

  // Filter to primary contract only
  return candles.filter(c => {
    const hourKey = Math.floor(c.timestamp / 3600000);
    return c.symbol === hourlyPrimary[hourKey];
  });
}

// Load intraday GEX for a specific date
function loadIntradayGEX(date) {
  const filepath = path.join(DATA_DIR, `gex/nq/nq_gex_${date}.json`);
  if (!fs.existsSync(filepath)) return null;

  try {
    const content = fs.readFileSync(filepath, 'utf-8');
    return JSON.parse(content);
  } catch (e) {
    return null;
  }
}

// Get GEX levels at a specific time
function getGEXAtTime(gexData, timestamp) {
  if (!gexData || !gexData.data) return null;

  // Find closest snapshot before or at timestamp
  let closest = null;
  const ts = new Date(timestamp);

  for (const snapshot of gexData.data) {
    const snapTs = new Date(snapshot.timestamp);
    if (snapTs <= ts) {
      closest = snapshot;
    } else {
      break;
    }
  }

  return closest;
}

// Detect touches of GEX levels
function detectLevelTouches(candles, gexData, levelType, threshold = 5) {
  const touches = [];

  for (let i = 1; i < candles.length - 10; i++) {
    const candle = candles[i];
    const gex = getGEXAtTime(gexData, candle.timestamp);
    if (!gex) continue;

    let level = null;
    let levelName = '';

    if (levelType === 'support' && gex.support) {
      // Check S1 (first support level)
      level = gex.support[0];
      levelName = 'S1';
    } else if (levelType === 'resistance' && gex.resistance) {
      // Check R1 (first resistance level)
      level = gex.resistance[0];
      levelName = 'R1';
    } else if (levelType === 'put_wall') {
      level = gex.put_wall;
      levelName = 'PutWall';
    } else if (levelType === 'call_wall') {
      level = gex.call_wall;
      levelName = 'CallWall';
    }

    if (!level) continue;

    // Check if candle touched the level
    const touchedFromAbove = candle.low <= level + threshold && candle.close > level;
    const touchedFromBelow = candle.high >= level - threshold && candle.close < level;

    if (touchedFromAbove || touchedFromBelow) {
      // Calculate forward returns
      const returns = {};
      [5, 10, 15, 30, 60].forEach(bars => {
        if (i + bars < candles.length) {
          const futureCandle = candles[i + bars];
          returns[`${bars}m`] = futureCandle.close - candle.close;
        }
      });

      touches.push({
        timestamp: candle.timestamp,
        level,
        levelName,
        touchType: touchedFromAbove ? 'from_above' : 'from_below',
        entryPrice: candle.close,
        returns,
        regime: gex.regime
      });
    }
  }

  return touches;
}

// Calculate statistics for touches
function analyzeReturns(touches, label) {
  if (touches.length === 0) {
    console.log(`\n${label}: No touches found`);
    return;
  }

  console.log(`\n=== ${label} ===`);
  console.log(`Total touches: ${touches.length}`);

  // Separate by touch type
  const fromAbove = touches.filter(t => t.touchType === 'from_above');
  const fromBelow = touches.filter(t => t.touchType === 'from_below');

  console.log(`  From above (support test): ${fromAbove.length}`);
  console.log(`  From below (resistance test): ${fromBelow.length}`);

  // Analyze returns for support tests (from above)
  if (fromAbove.length > 0) {
    console.log('\n  Support Tests (long opportunity):');
    [5, 10, 15, 30, 60].forEach(bars => {
      const key = `${bars}m`;
      const returnsData = fromAbove.filter(t => t.returns[key] !== undefined).map(t => t.returns[key]);
      if (returnsData.length === 0) return;

      const avg = returnsData.reduce((a, b) => a + b, 0) / returnsData.length;
      const positive = returnsData.filter(r => r > 0).length;
      const winRate = (positive / returnsData.length * 100).toFixed(1);

      console.log(`    ${bars}m: avg=${avg.toFixed(2)} pts, win rate=${winRate}%, n=${returnsData.length}`);
    });
  }

  // Analyze returns for resistance tests (from below)
  if (fromBelow.length > 0) {
    console.log('\n  Resistance Tests (short opportunity):');
    [5, 10, 15, 30, 60].forEach(bars => {
      const key = `${bars}m`;
      const returnsData = fromBelow.filter(t => t.returns[key] !== undefined).map(t => -t.returns[key]); // Invert for shorts
      if (returnsData.length === 0) return;

      const avg = returnsData.reduce((a, b) => a + b, 0) / returnsData.length;
      const positive = returnsData.filter(r => r > 0).length;
      const winRate = (positive / returnsData.length * 100).toFixed(1);

      console.log(`    ${bars}m: avg=${avg.toFixed(2)} pts, win rate=${winRate}%, n=${returnsData.length}`);
    });
  }

  // Break down by regime
  const byRegime = {};
  touches.forEach(t => {
    const regime = t.regime || 'unknown';
    if (!byRegime[regime]) byRegime[regime] = [];
    byRegime[regime].push(t);
  });

  console.log('\n  By Regime:');
  Object.entries(byRegime).forEach(([regime, regimeTouches]) => {
    const returns15m = regimeTouches.filter(t => t.returns['15m'] !== undefined).map(t => t.returns['15m']);
    if (returns15m.length === 0) return;
    const avg = returns15m.reduce((a, b) => a + b, 0) / returns15m.length;
    console.log(`    ${regime}: avg 15m return=${avg.toFixed(2)} pts, n=${regimeTouches.length}`);
  });
}

// Get session from timestamp
function getSession(timestamp) {
  const date = new Date(timestamp);
  const estHour = (date.getUTCHours() - 5 + 24) % 24;

  if (estHour >= 18 || estHour < 4) return 'overnight';
  if (estHour >= 4 && estHour < 9.5) return 'premarket';
  if (estHour >= 9.5 && estHour < 16) return 'rth';
  return 'afterhours';
}

// Analyze by session
function analyzeBySession(touches) {
  const bySession = {
    overnight: [],
    premarket: [],
    rth: [],
    afterhours: []
  };

  touches.forEach(t => {
    const session = getSession(t.timestamp);
    bySession[session].push(t);
  });

  console.log('\n=== ANALYSIS BY SESSION ===');
  Object.entries(bySession).forEach(([session, sessionTouches]) => {
    if (sessionTouches.length === 0) return;

    const returns15m = sessionTouches.filter(t => t.returns['15m'] !== undefined).map(t => t.returns['15m']);
    if (returns15m.length === 0) return;

    const avg = returns15m.reduce((a, b) => a + b, 0) / returns15m.length;
    const positive = returns15m.filter(r => r > 0).length;
    const winRate = (positive / returns15m.length * 100).toFixed(1);

    console.log(`  ${session.padEnd(12)}: avg 15m=${avg.toFixed(2)} pts, win rate=${winRate}%, n=${sessionTouches.length}`);
  });
}

// Main
async function main() {
  console.log('Analyzing GEX level bounces...\n');

  // Test on recent data with GEX availability
  const testDates = [
    '2024-10-21', '2024-10-22', '2024-10-23', '2024-10-24', '2024-10-25',
    '2024-11-04', '2024-11-05', '2024-11-06', '2024-11-07', '2024-11-08',
    '2025-01-13', '2025-01-14', '2025-01-15', '2025-01-16', '2025-01-17'
  ];

  const allTouches = {
    support: [],
    resistance: [],
    put_wall: [],
    call_wall: []
  };

  for (const date of testDates) {
    const gexData = loadIntradayGEX(date);
    if (!gexData) {
      console.log(`No GEX data for ${date}`);
      continue;
    }

    const nextDate = new Date(date);
    nextDate.setDate(nextDate.getDate() + 1);
    const endDate = nextDate.toISOString().slice(0, 10);

    const candles = loadOHLCV(date, endDate);
    if (candles.length === 0) {
      console.log(`No OHLCV data for ${date}`);
      continue;
    }

    console.log(`Processing ${date}: ${candles.length} candles, ${gexData.data.length} GEX snapshots`);

    // Detect touches for each level type
    ['support', 'resistance', 'put_wall', 'call_wall'].forEach(levelType => {
      const touches = detectLevelTouches(candles, gexData, levelType, 10);
      allTouches[levelType].push(...touches);
    });
  }

  // Analyze results
  analyzeReturns(allTouches.support, 'S1 SUPPORT LEVEL');
  analyzeReturns(allTouches.resistance, 'R1 RESISTANCE LEVEL');
  analyzeReturns(allTouches.put_wall, 'PUT WALL');
  analyzeReturns(allTouches.call_wall, 'CALL WALL');

  // Combine all touches for session analysis
  const allCombined = [
    ...allTouches.support,
    ...allTouches.resistance,
    ...allTouches.put_wall,
    ...allTouches.call_wall
  ];

  analyzeBySession(allCombined);

  console.log('\n=== ANALYSIS COMPLETE ===');
}

main().catch(console.error);
