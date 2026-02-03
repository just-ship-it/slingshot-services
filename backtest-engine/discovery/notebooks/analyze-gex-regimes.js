/**
 * Analyze GEX Regime Distribution and Price Behavior
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '../../data');

// Parse CSV with proper handling
function parseCSV(content, delimiter = ',') {
  const lines = content.trim().split('\n');
  const headers = lines[0].split(delimiter);
  const data = [];

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(delimiter);
    const row = {};
    headers.forEach((h, idx) => {
      row[h.trim()] = values[idx]?.trim() || '';
    });
    data.push(row);
  }
  return data;
}

// Load GEX levels
function loadGEXLevels() {
  const filepath = path.join(DATA_DIR, 'gex/nq/NQ_gex_levels.csv');
  const content = fs.readFileSync(filepath, 'utf-8');
  return parseCSV(content);
}

// Load sample OHLCV data
function loadOHLCV(limit = 100000) {
  const filepath = path.join(DATA_DIR, 'ohlcv/nq/NQ_ohlcv_1m.csv');
  const content = fs.readFileSync(filepath, 'utf-8');
  const lines = content.trim().split('\n');

  const headers = lines[0].split(',');
  const data = [];

  // Sample from end of file (most recent)
  const start = Math.max(1, lines.length - limit);

  for (let i = start; i < lines.length; i++) {
    const values = lines[i].split(',');
    const row = {};
    headers.forEach((h, idx) => {
      row[h.trim()] = values[idx]?.trim() || '';
    });
    // Filter out calendar spreads
    if (!row.symbol.includes('-')) {
      data.push(row);
    }
  }
  return data;
}

// Analyze GEX regime distribution
function analyzeRegimeDistribution(gexData) {
  const regimeCounts = {};

  gexData.forEach(row => {
    const regime = row.regime || 'unknown';
    regimeCounts[regime] = (regimeCounts[regime] || 0) + 1;
  });

  console.log('\n=== GEX REGIME DISTRIBUTION ===');
  console.log(`Total trading days: ${gexData.length}`);

  Object.entries(regimeCounts)
    .sort((a, b) => b[1] - a[1])
    .forEach(([regime, count]) => {
      const pct = ((count / gexData.length) * 100).toFixed(1);
      console.log(`  ${regime}: ${count} days (${pct}%)`);
    });

  return regimeCounts;
}

// Analyze total GEX trends
function analyzeGEXMagnitude(gexData) {
  const gexValues = gexData
    .map(r => parseFloat(r.total_gex))
    .filter(v => !isNaN(v));

  const sorted = [...gexValues].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const mean = gexValues.reduce((a, b) => a + b, 0) / gexValues.length;
  const min = Math.min(...gexValues);
  const max = Math.max(...gexValues);

  console.log('\n=== TOTAL GEX STATISTICS ===');
  console.log(`  Mean: ${(mean / 1e9).toFixed(2)}B`);
  console.log(`  Median: ${(median / 1e9).toFixed(2)}B`);
  console.log(`  Min: ${(min / 1e9).toFixed(2)}B`);
  console.log(`  Max: ${(max / 1e9).toFixed(2)}B`);

  // Analyze by quartile
  const q1 = sorted[Math.floor(sorted.length * 0.25)];
  const q3 = sorted[Math.floor(sorted.length * 0.75)];

  console.log(`  Q1: ${(q1 / 1e9).toFixed(2)}B`);
  console.log(`  Q3: ${(q3 / 1e9).toFixed(2)}B`);
}

// Analyze gamma flip relative to price
function analyzeGammaFlipPosition(gexData) {
  console.log('\n=== GAMMA FLIP ANALYSIS ===');

  // Group by year
  const byYear = {};
  gexData.forEach(row => {
    const year = row.date.slice(0, 4);
    if (!byYear[year]) byYear[year] = [];
    byYear[year].push(row);
  });

  Object.entries(byYear).forEach(([year, rows]) => {
    const gammaFlips = rows
      .map(r => parseFloat(r.nq_gamma_flip))
      .filter(v => !isNaN(v));

    if (gammaFlips.length === 0) return;

    const mean = gammaFlips.reduce((a, b) => a + b, 0) / gammaFlips.length;
    console.log(`  ${year}: Avg Gamma Flip = ${mean.toFixed(0)} (n=${gammaFlips.length})`);
  });
}

// Analyze session patterns in OHLCV
function analyzeSessionPatterns(ohlcvData) {
  console.log('\n=== SESSION ANALYSIS (1-min candles) ===');

  const sessions = {
    overnight: { count: 0, avgVolume: 0, totalVolume: 0 },
    premarket: { count: 0, avgVolume: 0, totalVolume: 0 },
    rth: { count: 0, avgVolume: 0, totalVolume: 0 },
    afterhours: { count: 0, avgVolume: 0, totalVolume: 0 }
  };

  ohlcvData.forEach(row => {
    const ts = new Date(row.ts_event);
    const utcHour = ts.getUTCHours();
    const estHour = (utcHour - 5 + 24) % 24; // Rough EST conversion

    const volume = parseFloat(row.volume) || 0;

    let session;
    if (estHour >= 18 || estHour < 4) {
      session = 'overnight';
    } else if (estHour >= 4 && estHour < 9.5) {
      session = 'premarket';
    } else if (estHour >= 9.5 && estHour < 16) {
      session = 'rth';
    } else {
      session = 'afterhours';
    }

    sessions[session].count++;
    sessions[session].totalVolume += volume;
  });

  // Calculate averages
  Object.keys(sessions).forEach(s => {
    if (sessions[s].count > 0) {
      sessions[s].avgVolume = sessions[s].totalVolume / sessions[s].count;
    }
  });

  console.log(`Sample size: ${ohlcvData.length} candles`);
  Object.entries(sessions).forEach(([session, stats]) => {
    const pct = ((stats.count / ohlcvData.length) * 100).toFixed(1);
    console.log(`  ${session.padEnd(12)}: ${stats.count} candles (${pct}%), avg vol: ${stats.avgVolume.toFixed(0)}`);
  });
}

// Analyze GEX level distances from price
function analyzeGEXLevelDistances(gexData) {
  console.log('\n=== GEX LEVEL DISTANCES FROM GAMMA FLIP ===');

  const distances = {
    put_wall_1: [],
    put_wall_2: [],
    put_wall_3: [],
    call_wall_1: [],
    call_wall_2: [],
    call_wall_3: []
  };

  gexData.forEach(row => {
    const gammaFlip = parseFloat(row.nq_gamma_flip);
    if (isNaN(gammaFlip)) return;

    ['put_wall_1', 'put_wall_2', 'put_wall_3', 'call_wall_1', 'call_wall_2', 'call_wall_3'].forEach(level => {
      const value = parseFloat(row[`nq_${level}`]);
      if (!isNaN(value)) {
        distances[level].push(Math.abs(value - gammaFlip));
      }
    });
  });

  Object.entries(distances).forEach(([level, dists]) => {
    if (dists.length === 0) return;
    const mean = dists.reduce((a, b) => a + b, 0) / dists.length;
    const sorted = [...dists].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    console.log(`  ${level.padEnd(12)}: avg=${mean.toFixed(0)} pts, median=${median.toFixed(0)} pts`);
  });
}

// Main analysis
async function main() {
  console.log('Loading data...');

  const gexData = loadGEXLevels();
  console.log(`Loaded ${gexData.length} GEX daily records`);

  const ohlcvData = loadOHLCV(50000);
  console.log(`Loaded ${ohlcvData.length} OHLCV candles (sampled)`);

  // Run analyses
  analyzeRegimeDistribution(gexData);
  analyzeGEXMagnitude(gexData);
  analyzeGammaFlipPosition(gexData);
  analyzeGEXLevelDistances(gexData);
  analyzeSessionPatterns(ohlcvData);

  console.log('\n=== ANALYSIS COMPLETE ===');
}

main().catch(console.error);
