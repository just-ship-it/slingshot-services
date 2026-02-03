#!/usr/bin/env node

/**
 * GEX Level Probability Matrix
 *
 * Analyzes: "When price touches a GEX level, what % of the time does it
 * hit +X points before hitting -Y points?"
 *
 * Uses 1-second data to track sequential price movement and determine
 * which threshold is hit FIRST.
 *
 * Usage:
 *   node scripts/gex-probability-matrix.js [options]
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');

// Configuration
const CONFIG = {
  proximityThreshold: 5,      // Points to consider "touching" a level
  trackingWindowSeconds: 1800, // 30 minutes max tracking
  levelTypes: ['support_1', 'resistance_1', 'support_2', 'resistance_2'],

  // Stop/Target ranges to test
  stops: [5, 7, 10, 12, 15, 20, 25, 30, 40, 50],
  targets: [5, 7, 10, 12, 15, 20, 25, 30, 40, 50]
};

// Parse arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    startDate: '2025-01-01',
    endDate: '2025-12-31',
    outputFile: path.join(projectRoot, 'results', 'gex-probability-matrix.json'),
    verbose: false
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--start' && args[i + 1]) config.startDate = args[++i];
    else if (args[i] === '--end' && args[i + 1]) config.endDate = args[++i];
    else if (args[i] === '--output' && args[i + 1]) config.outputFile = args[++i];
    else if (args[i] === '--verbose' || args[i] === '-v') config.verbose = true;
    else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`
GEX Level Probability Matrix

Calculates win probabilities for various stop/target combinations.

Usage:
  node scripts/gex-probability-matrix.js [options]

Options:
  --start <date>   Start date YYYY-MM-DD (default: 2025-01-01)
  --end <date>     End date YYYY-MM-DD (default: 2025-12-31)
  --output <file>  Output JSON file
  --verbose, -v    Show detailed progress
  --help, -h       Show this help
`);
      process.exit(0);
    }
  }

  return config;
}

// Load GEX levels from JSON files
function loadGexLevels(startDate, endDate) {
  const gexDir = path.join(projectRoot, 'data', 'gex');
  const levels = new Map();

  const start = new Date(startDate);
  const end = new Date(endDate);

  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const dateStr = d.toISOString().split('T')[0];
    const filePath = path.join(gexDir, `nq_gex_${dateStr}.json`);

    if (!fs.existsSync(filePath)) continue;

    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      for (const snapshot of data.data) {
        const ts = new Date(snapshot.timestamp).getTime();
        levels.set(ts, {
          support: snapshot.support || [],
          resistance: snapshot.resistance || [],
          gamma_flip: snapshot.gamma_flip,
          regime: snapshot.regime
        });
      }
    } catch (err) {
      // Skip invalid files
    }
  }

  return levels;
}

// Get active GEX levels for a timestamp
function getActiveLevels(gexLevels, timestamp) {
  let activeSnapshot = null;
  let closestTime = 0;

  for (const [ts, snapshot] of gexLevels) {
    if (ts <= timestamp && ts > closestTime) {
      closestTime = ts;
      activeSnapshot = snapshot;
    }
  }

  if (!activeSnapshot) return null;

  const result = [];

  if (activeSnapshot.support) {
    activeSnapshot.support.forEach((price, i) => {
      result.push({
        type: `support_${i + 1}`,
        price,
        side: 'long' // Long at support
      });
    });
  }

  if (activeSnapshot.resistance) {
    activeSnapshot.resistance.forEach((price, i) => {
      result.push({
        type: `resistance_${i + 1}`,
        price,
        side: 'short' // Short at resistance
      });
    });
  }

  return result;
}

// Track a level touch through 1-second bars
class TouchTracker {
  constructor(level, entryPrice, entryTime) {
    this.level = level;
    this.entryPrice = entryPrice;
    this.entryTime = entryTime;
    this.side = level.side;
    this.bars = [];
    this.results = {}; // {stop}_{target} -> 'win' | 'loss' | 'timeout'
    this.completed = new Set(); // Track which stop/target combos are resolved
  }

  addBar(bar) {
    this.bars.push(bar);

    // Check each stop/target combination
    for (const stop of CONFIG.stops) {
      for (const target of CONFIG.targets) {
        const key = `${stop}_${target}`;
        if (this.completed.has(key)) continue;

        let stopPrice, targetPrice;

        if (this.side === 'long') {
          stopPrice = this.entryPrice - stop;
          targetPrice = this.entryPrice + target;

          // Check stop first (more conservative)
          if (bar.low <= stopPrice) {
            this.results[key] = 'loss';
            this.completed.add(key);
          } else if (bar.high >= targetPrice) {
            this.results[key] = 'win';
            this.completed.add(key);
          }
        } else {
          // Short
          stopPrice = this.entryPrice + stop;
          targetPrice = this.entryPrice - target;

          if (bar.high >= stopPrice) {
            this.results[key] = 'loss';
            this.completed.add(key);
          } else if (bar.low <= targetPrice) {
            this.results[key] = 'win';
            this.completed.add(key);
          }
        }
      }
    }
  }

  isFullyResolved() {
    return this.completed.size === CONFIG.stops.length * CONFIG.targets.length;
  }

  isExpired(currentTime) {
    return (currentTime - this.entryTime) > CONFIG.trackingWindowSeconds * 1000;
  }

  finalize() {
    // Mark any unresolved combos as timeout
    for (const stop of CONFIG.stops) {
      for (const target of CONFIG.targets) {
        const key = `${stop}_${target}`;
        if (!this.completed.has(key)) {
          this.results[key] = 'timeout';
        }
      }
    }
    return this.results;
  }
}

// Main analysis
async function analyzeGexProbabilities(config) {
  console.log('═'.repeat(70));
  console.log('  GEX LEVEL PROBABILITY MATRIX');
  console.log('═'.repeat(70));
  console.log();

  // Load GEX levels
  console.log('Loading GEX levels...');
  const gexLevels = loadGexLevels(config.startDate, config.endDate);
  console.log(`Loaded ${gexLevels.size} GEX snapshots`);
  console.log();

  // 1-second data path
  const secondDataPath = path.join(projectRoot, 'data', 'ohlcv', 'NQ_ohlcv_1s.csv');
  if (!fs.existsSync(secondDataPath)) {
    console.error('1-second data file not found:', secondDataPath);
    process.exit(1);
  }

  const startTime = new Date(config.startDate).getTime();
  const endTime = new Date(config.endDate + 'T23:59:59').getTime();

  // Results by level type
  const results = {};
  for (const lt of CONFIG.levelTypes) {
    results[lt] = {
      touches: 0,
      matrix: {} // {stop}_{target} -> { wins, losses, timeouts }
    };
    for (const stop of CONFIG.stops) {
      for (const target of CONFIG.targets) {
        results[lt].matrix[`${stop}_${target}`] = { wins: 0, losses: 0, timeouts: 0 };
      }
    }
  }

  // Active touch trackers
  const activeTrackers = new Map(); // levelKey -> TouchTracker
  const cooldowns = new Map();
  const COOLDOWN_MS = 60000;

  console.log('Streaming 1-second data...');
  console.log(`Date range: ${config.startDate} to ${config.endDate}`);
  console.log(`Testing ${CONFIG.stops.length} stops x ${CONFIG.targets.length} targets = ${CONFIG.stops.length * CONFIG.targets.length} combinations`);
  console.log();

  let linesProcessed = 0;
  let touchCount = 0;
  let lastProgressTime = Date.now();

  await new Promise((resolve, reject) => {
    const fileStream = fs.createReadStream(secondDataPath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });

    let isHeader = true;

    rl.on('line', (line) => {
      if (isHeader) {
        isHeader = false;
        return;
      }

      linesProcessed++;

      if (Date.now() - lastProgressTime > 10000) {
        console.log(`  Processed ${(linesProcessed / 1000000).toFixed(1)}M lines, ${touchCount} touches, ${activeTrackers.size} active...`);
        lastProgressTime = Date.now();
      }

      const parts = line.split(',');
      if (parts.length < 10) return;

      const timestamp = new Date(parts[0]).getTime();
      if (timestamp < startTime || timestamp > endTime) return;

      const symbol = parts[9];
      if (symbol && symbol.includes('-')) return;

      const bar = {
        timestamp,
        open: parseFloat(parts[4]),
        high: parseFloat(parts[5]),
        low: parseFloat(parts[6]),
        close: parseFloat(parts[7])
      };

      // Update active trackers
      for (const [key, tracker] of activeTrackers) {
        tracker.addBar(bar);

        if (tracker.isFullyResolved() || tracker.isExpired(timestamp)) {
          const trackResults = tracker.finalize();
          const lt = tracker.level.type;

          if (results[lt]) {
            for (const [combo, outcome] of Object.entries(trackResults)) {
              if (outcome === 'win') results[lt].matrix[combo].wins++;
              else if (outcome === 'loss') results[lt].matrix[combo].losses++;
              else results[lt].matrix[combo].timeouts++;
            }
          }

          activeTrackers.delete(key);
        }
      }

      // Check for new level touches
      const levels = getActiveLevels(gexLevels, timestamp);
      if (!levels) return;

      for (const level of levels) {
        if (!CONFIG.levelTypes.includes(level.type)) continue;

        const levelKey = `${level.type}_${Math.round(level.price)}`;

        const lastTouch = cooldowns.get(levelKey);
        if (lastTouch && timestamp - lastTouch < COOLDOWN_MS) continue;
        if (activeTrackers.has(levelKey)) continue;

        if (Math.abs(bar.close - level.price) <= CONFIG.proximityThreshold) {
          const tracker = new TouchTracker(level, bar.close, timestamp);
          activeTrackers.set(levelKey, tracker);
          cooldowns.set(levelKey, timestamp);
          results[level.type].touches++;
          touchCount++;
        }
      }
    });

    rl.on('close', () => {
      // Finalize remaining trackers
      for (const [key, tracker] of activeTrackers) {
        const trackResults = tracker.finalize();
        const lt = tracker.level.type;

        if (results[lt]) {
          for (const [combo, outcome] of Object.entries(trackResults)) {
            if (outcome === 'win') results[lt].matrix[combo].wins++;
            else if (outcome === 'loss') results[lt].matrix[combo].losses++;
            else results[lt].matrix[combo].timeouts++;
          }
        }
      }
      resolve();
    });

    rl.on('error', reject);
    fileStream.on('error', reject);
  });

  console.log(`\nProcessed ${(linesProcessed / 1000000).toFixed(1)}M lines`);
  console.log(`Total touches: ${touchCount}`);
  console.log();

  // Display results
  for (const lt of ['support_1', 'resistance_1']) {
    const data = results[lt];
    if (data.touches === 0) continue;

    console.log('═'.repeat(70));
    console.log(`  ${lt.toUpperCase()} - WIN PROBABILITY MATRIX (${data.touches} touches)`);
    console.log('  "What % hit target BEFORE hitting stop?"');
    console.log('═'.repeat(70));
    console.log();

    // Header
    let header = 'Stop \\ Target │';
    for (const target of CONFIG.targets) {
      header += ` ${target.toString().padStart(5)}pt`;
    }
    console.log(header);
    console.log('─'.repeat(header.length));

    // Rows
    for (const stop of CONFIG.stops) {
      let row = `${stop.toString().padStart(6)}pt    │`;
      for (const target of CONFIG.targets) {
        const key = `${stop}_${target}`;
        const m = data.matrix[key];
        const total = m.wins + m.losses;
        const winRate = total > 0 ? (m.wins / total * 100).toFixed(1) : 'N/A';
        row += ` ${winRate.padStart(5)}%`;
      }
      console.log(row);
    }
    console.log();

    // Expectancy matrix
    console.log(`  ${lt.toUpperCase()} - EXPECTANCY MATRIX (points per trade)`);
    console.log('─'.repeat(70));

    header = 'Stop \\ Target │';
    for (const target of CONFIG.targets) {
      header += ` ${target.toString().padStart(6)}pt`;
    }
    console.log(header);
    console.log('─'.repeat(header.length));

    for (const stop of CONFIG.stops) {
      let row = `${stop.toString().padStart(6)}pt    │`;
      for (const target of CONFIG.targets) {
        const key = `${stop}_${target}`;
        const m = data.matrix[key];
        const total = m.wins + m.losses;
        if (total > 0) {
          const expectancy = (m.wins * target - m.losses * stop) / total;
          const expStr = expectancy >= 0 ? `+${expectancy.toFixed(1)}` : expectancy.toFixed(1);
          row += ` ${expStr.padStart(6)}`;
        } else {
          row += '    N/A';
        }
      }
      console.log(row);
    }
    console.log();

    // Find best configurations
    console.log(`  TOP 10 CONFIGURATIONS BY EXPECTANCY (${lt.toUpperCase()})`);
    console.log('─'.repeat(70));

    const configs = [];
    for (const stop of CONFIG.stops) {
      for (const target of CONFIG.targets) {
        const key = `${stop}_${target}`;
        const m = data.matrix[key];
        const total = m.wins + m.losses;
        if (total > 0) {
          const winRate = m.wins / total * 100;
          const expectancy = (m.wins * target - m.losses * stop) / total;
          configs.push({ stop, target, winRate, expectancy, wins: m.wins, losses: m.losses, timeouts: m.timeouts });
        }
      }
    }

    configs.sort((a, b) => b.expectancy - a.expectancy);

    console.log('Rank │ Stop │ Target │ Win%  │ Expectancy │ Wins │ Losses │ Timeouts');
    console.log('─'.repeat(70));

    for (let i = 0; i < Math.min(10, configs.length); i++) {
      const c = configs[i];
      console.log(
        `${(i + 1).toString().padStart(4)} │ ${c.stop.toString().padStart(4)} │ ${c.target.toString().padStart(6)} │ ` +
        `${c.winRate.toFixed(1).padStart(5)}% │ ${(c.expectancy >= 0 ? '+' : '') + c.expectancy.toFixed(2).padStart(9)} │ ` +
        `${c.wins.toString().padStart(4)} │ ${c.losses.toString().padStart(6)} │ ${c.timeouts.toString().padStart(8)}`
      );
    }
    console.log();
  }

  // Save full results
  const output = {
    config: {
      startDate: config.startDate,
      endDate: config.endDate,
      stops: CONFIG.stops,
      targets: CONFIG.targets,
      proximityThreshold: CONFIG.proximityThreshold,
      trackingWindowSeconds: CONFIG.trackingWindowSeconds
    },
    results
  };

  fs.writeFileSync(config.outputFile, JSON.stringify(output, null, 2));
  console.log(`Full results saved to: ${config.outputFile}`);

  console.log();
  console.log('═'.repeat(70));
  console.log('  ANALYSIS COMPLETE');
  console.log('═'.repeat(70));
}

const config = parseArgs();
analyzeGexProbabilities(config).catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
