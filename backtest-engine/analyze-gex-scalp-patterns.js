#!/usr/bin/env node
/**
 * Analyze price behavior around GEX levels for scalping opportunities
 */
import fs from 'fs';
import path from 'path';

const DATA_DIR = '/home/drew/projects/slingshot-services/backtest-engine/data';

// Load 1-minute OHLCV data
function loadOHLCV() {
  console.log('Loading 1-minute OHLCV data...');
  const csv = fs.readFileSync(path.join(DATA_DIR, 'ohlcv/NQ_ohlcv_1m.csv'), 'utf8');
  const lines = csv.split('\n').slice(1);
  
  const candles = new Map();
  for (const line of lines) {
    const parts = line.split(',');
    if (parts.length < 10) continue;
    const symbol = parts[9]?.trim();
    if (!symbol?.startsWith('NQ') || symbol.includes('-')) continue;
    
    const ts = new Date(parts[0]).getTime();
    const candle = {
      timestamp: ts,
      open: parseFloat(parts[4]),
      high: parseFloat(parts[5]),
      low: parseFloat(parts[6]),
      close: parseFloat(parts[7]),
      volume: parseInt(parts[8])
    };
    
    // Keep highest volume contract for each timestamp
    if (!candles.has(ts) || candles.get(ts).volume < candle.volume) {
      candles.set(ts, candle);
    }
  }
  
  // Convert to sorted array
  const arr = Array.from(candles.values()).sort((a, b) => a.timestamp - b.timestamp);
  console.log(`Loaded ${arr.length.toLocaleString()} unique 1-minute candles`);
  return arr;
}

// Load GEX data for a date range
function loadGEXData(startDate, endDate) {
  console.log(`Loading GEX data from ${startDate} to ${endDate}...`);
  const gexDir = path.join(DATA_DIR, 'gex');
  const files = fs.readdirSync(gexDir).filter(f => f.startsWith('nq_gex_') && f.endsWith('.json'));
  
  const snapshots = [];
  for (const file of files) {
    const dateMatch = file.match(/nq_gex_(\d{4}-\d{2}-\d{2})\.json/);
    if (!dateMatch) continue;
    const fileDate = dateMatch[1];
    if (fileDate < startDate || fileDate > endDate) continue;
    
    try {
      const data = JSON.parse(fs.readFileSync(path.join(gexDir, file), 'utf8'));
      for (const snap of data.data || []) {
        snapshots.push({
          timestamp: new Date(snap.timestamp).getTime(),
          gammaFlip: snap.gamma_flip,
          callWall: snap.call_wall,
          putWall: snap.put_wall,
          resistance: snap.resistance || [],
          support: snap.support || [],
          regime: snap.regime,
          nqSpot: snap.nq_spot
        });
      }
    } catch (e) {}
  }
  
  snapshots.sort((a, b) => a.timestamp - b.timestamp);
  console.log(`Loaded ${snapshots.length.toLocaleString()} GEX snapshots`);
  return snapshots;
}

// Find the active GEX levels for a given timestamp
function getGEXLevels(timestamp, gexSnapshots) {
  // Find the most recent GEX snapshot before this timestamp
  let latest = null;
  for (const snap of gexSnapshots) {
    if (snap.timestamp <= timestamp) {
      latest = snap;
    } else {
      break;
    }
  }
  return latest;
}

// Analyze what happens when price touches a GEX level
function analyzeGEXTouches(candles, gexSnapshots) {
  console.log('\nAnalyzing price behavior at GEX levels...\n');
  
  const results = {
    gammaFlipTouches: [],
    support1Touches: [],
    resistance1Touches: [],
    putWallTouches: [],
    callWallTouches: []
  };
  
  const TOUCH_THRESHOLD = 5; // Within 5 points of level
  const LOOKFORWARD = 15; // Look 15 minutes ahead
  
  for (let i = 0; i < candles.length - LOOKFORWARD; i++) {
    const candle = candles[i];
    const gex = getGEXLevels(candle.timestamp, gexSnapshots);
    if (!gex) continue;
    
    const price = candle.close;
    
    // Check gamma flip touch
    if (Math.abs(price - gex.gammaFlip) <= TOUCH_THRESHOLD) {
      const future = candles.slice(i + 1, i + 1 + LOOKFORWARD);
      const maxUp = Math.max(...future.map(c => c.high)) - price;
      const maxDown = price - Math.min(...future.map(c => c.low));
      const endPrice = future[future.length - 1]?.close || price;
      
      results.gammaFlipTouches.push({
        timestamp: candle.timestamp,
        price,
        level: gex.gammaFlip,
        distance: price - gex.gammaFlip,
        regime: gex.regime,
        maxUp,
        maxDown,
        netMove: endPrice - price
      });
    }
    
    // Check support 1 touch
    if (gex.support[0] && Math.abs(price - gex.support[0]) <= TOUCH_THRESHOLD) {
      const future = candles.slice(i + 1, i + 1 + LOOKFORWARD);
      const maxUp = Math.max(...future.map(c => c.high)) - price;
      const maxDown = price - Math.min(...future.map(c => c.low));
      const endPrice = future[future.length - 1]?.close || price;
      
      results.support1Touches.push({
        timestamp: candle.timestamp,
        price,
        level: gex.support[0],
        distance: price - gex.support[0],
        regime: gex.regime,
        maxUp,
        maxDown,
        netMove: endPrice - price
      });
    }
    
    // Check resistance 1 touch
    if (gex.resistance[0] && Math.abs(price - gex.resistance[0]) <= TOUCH_THRESHOLD) {
      const future = candles.slice(i + 1, i + 1 + LOOKFORWARD);
      const maxUp = Math.max(...future.map(c => c.high)) - price;
      const maxDown = price - Math.min(...future.map(c => c.low));
      const endPrice = future[future.length - 1]?.close || price;
      
      results.resistance1Touches.push({
        timestamp: candle.timestamp,
        price,
        level: gex.resistance[0],
        distance: price - gex.resistance[0],
        regime: gex.regime,
        maxUp,
        maxDown,
        netMove: endPrice - price
      });
    }
  }
  
  return results;
}

// Calculate statistics for touch events
function calcStats(touches, levelName, direction) {
  if (touches.length === 0) return null;
  
  // direction: 'long' = expect bounce up, 'short' = expect bounce down
  const target = 5; // 5 point target
  const stop = 5; // 5 point stop
  
  let wins = 0;
  let losses = 0;
  let totalMFE = 0;
  let totalMAE = 0;
  
  for (const t of touches) {
    if (direction === 'long') {
      if (t.maxUp >= target) wins++;
      else if (t.maxDown >= stop) losses++;
      totalMFE += t.maxUp;
      totalMAE += t.maxDown;
    } else {
      if (t.maxDown >= target) wins++;
      else if (t.maxUp >= stop) losses++;
      totalMFE += t.maxDown;
      totalMAE += t.maxUp;
    }
  }
  
  const winRate = wins / (wins + losses) * 100;
  const avgMFE = totalMFE / touches.length;
  const avgMAE = totalMAE / touches.length;
  
  return {
    levelName,
    direction,
    count: touches.length,
    wins,
    losses,
    winRate: winRate.toFixed(1),
    avgMFE: avgMFE.toFixed(1),
    avgMAE: avgMAE.toFixed(1),
    edgeRatio: (avgMFE / avgMAE).toFixed(2)
  };
}

// Analyze by regime
function analyzeByRegime(touches, levelName, direction) {
  const regimes = ['strong_positive', 'positive', 'negative', 'strong_negative'];
  const results = [];
  
  for (const regime of regimes) {
    const filtered = touches.filter(t => t.regime === regime);
    if (filtered.length >= 10) {
      const stats = calcStats(filtered, `${levelName} (${regime})`, direction);
      if (stats) results.push(stats);
    }
  }
  
  return results;
}

async function main() {
  console.log('═'.repeat(70));
  console.log('GEX LEVEL SCALPING PATTERN ANALYSIS');
  console.log('═'.repeat(70));
  
  // Use 2025 data for analysis
  const candles = loadOHLCV();
  const gexSnapshots = loadGEXData('2025-01-01', '2025-12-31');
  
  // Filter candles to 2025
  const candles2025 = candles.filter(c => {
    const d = new Date(c.timestamp);
    return d.getFullYear() === 2025;
  });
  console.log(`Filtered to ${candles2025.length.toLocaleString()} candles in 2025`);
  
  const touches = analyzeGEXTouches(candles2025, gexSnapshots);
  
  console.log('\n' + '═'.repeat(70));
  console.log('TOUCH EVENT COUNTS');
  console.log('═'.repeat(70));
  console.log(`Gamma Flip touches: ${touches.gammaFlipTouches.length}`);
  console.log(`Support 1 touches: ${touches.support1Touches.length}`);
  console.log(`Resistance 1 touches: ${touches.resistance1Touches.length}`);
  
  console.log('\n' + '═'.repeat(70));
  console.log('SCALP OPPORTUNITY ANALYSIS (5pt target, 5pt stop, 15-min window)');
  console.log('═'.repeat(70));
  
  const allStats = [];
  
  // Gamma flip - both directions possible
  const gfLong = calcStats(touches.gammaFlipTouches.filter(t => t.distance <= 0), 'Gamma Flip (from below)', 'long');
  const gfShort = calcStats(touches.gammaFlipTouches.filter(t => t.distance > 0), 'Gamma Flip (from above)', 'short');
  if (gfLong) allStats.push(gfLong);
  if (gfShort) allStats.push(gfShort);
  
  // Support - expect bounce up (long)
  const s1Long = calcStats(touches.support1Touches, 'Support 1', 'long');
  if (s1Long) allStats.push(s1Long);
  
  // Resistance - expect rejection down (short)
  const r1Short = calcStats(touches.resistance1Touches, 'Resistance 1', 'short');
  if (r1Short) allStats.push(r1Short);
  
  console.log('\n| Level                    | Dir   | Count | Wins | Losses | Win% | Avg MFE | Avg MAE | Edge |');
  console.log('|--------------------------|-------|-------|------|--------|------|---------|---------|------|');
  
  for (const s of allStats) {
    console.log(`| ${s.levelName.padEnd(24)} | ${s.direction.padEnd(5)} | ${s.count.toString().padStart(5)} | ${s.wins.toString().padStart(4)} | ${s.losses.toString().padStart(6)} | ${s.winRate.padStart(4)}% | ${s.avgMFE.padStart(7)} | ${s.avgMAE.padStart(7)} | ${s.edgeRatio.padStart(4)} |`);
  }
  
  console.log('\n' + '═'.repeat(70));
  console.log('BREAKDOWN BY GEX REGIME');
  console.log('═'.repeat(70));
  
  const regimeStats = [
    ...analyzeByRegime(touches.support1Touches, 'Support 1', 'long'),
    ...analyzeByRegime(touches.resistance1Touches, 'Resistance 1', 'short')
  ];
  
  console.log('\n| Level                              | Dir   | Count | Win% | Avg MFE | Edge |');
  console.log('|------------------------------------|-------|-------|------|---------|------|');
  
  for (const s of regimeStats.sort((a, b) => parseFloat(b.winRate) - parseFloat(a.winRate))) {
    console.log(`| ${s.levelName.padEnd(34)} | ${s.direction.padEnd(5)} | ${s.count.toString().padStart(5)} | ${s.winRate.padStart(4)}% | ${s.avgMFE.padStart(7)} | ${s.edgeRatio.padStart(4)} |`);
  }
  
  // Save detailed results
  fs.writeFileSync(
    path.join(DATA_DIR, '../results/gex-scalp-analysis.json'),
    JSON.stringify({ touches, allStats, regimeStats }, null, 2)
  );
  console.log('\nDetailed results saved to results/gex-scalp-analysis.json');
}

main().catch(console.error);
