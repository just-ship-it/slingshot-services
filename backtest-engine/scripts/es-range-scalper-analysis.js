#!/usr/bin/env node

/**
 * ES Range Scalper Analysis
 *
 * Detects consolidation "boxes" in ES 1m data and measures the profitability
 * of fading range edges: buy near support, sell near resistance, stop just
 * outside the box, repeat until the range breaks, then wait for the next one.
 *
 * Core concept: ES spends significant time chopping in defined ranges.
 * This script quantifies how much value can be "sucked out" of those ranges
 * by systematically fading both edges.
 *
 * Approach:
 *   1. Detect ranges via rolling N-bar high/low with width threshold
 *   2. Confirm range (width stable for M bars)
 *   3. Lock boundaries — trade within the box
 *   4. Buy near range low, sell near range high
 *   5. Stop just outside box boundary → range break = stop out
 *   6. After break, wait for next range to form
 *
 * Usage:
 *   node es-range-scalper-analysis.js [options]
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { CSVLoader } from '../src/data/csv-loader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataDir = path.join(__dirname, '..', 'data');

// ─── CLI ────────────────────────────────────────────────────────────────

async function parseArgs() {
  return yargs(hideBin(process.argv))
    .usage('Usage: $0 [options]')
    .option('start', { type: 'string', default: '2024-01-01' })
    .option('end', { type: 'string', default: '2026-01-25' })
    .option('is-end', { type: 'string', default: '2024-12-31' })
    .option('commission', { type: 'number', default: 0.10, description: 'RT commission in ES points' })
    .option('output', { type: 'string', default: 'es-range-scalper-results.json' })
    .option('verbose', { alias: 'v', type: 'boolean', default: false })
    .help()
    .parse();
}

// ─── Session Utility ────────────────────────────────────────────────────

function getSession(timestamp) {
  const date = new Date(timestamp);
  const estString = date.toLocaleString('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric', minute: 'numeric', hour12: false
  });
  const [hourStr, minStr] = estString.split(':');
  const td = parseInt(hourStr) + parseInt(minStr) / 60;
  if (td >= 18 || td < 4) return 'overnight';
  if (td < 9.5) return 'premarket';
  if (td < 16) return 'rth';
  return 'afterhours';
}

function getDateKey(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

// ─── Range Detector ─────────────────────────────────────────────────────

class RangeDetector {
  /**
   * @param {object} params
   * @param {number} params.lookback      - N bars for rolling high/low
   * @param {number} params.confirmBars   - how many bars width must be stable
   * @param {number} params.minWidth      - minimum range width (points)
   * @param {number} params.maxWidth      - maximum range width (points)
   * @param {number} params.breakBuffer   - close beyond boundary by this much = break
   * @param {number} params.maxDuration   - max bars a range can last (prevent infinite)
   */
  constructor(params) {
    this.lookback = params.lookback;
    this.confirmBars = params.confirmBars;
    this.minWidth = params.minWidth;
    this.maxWidth = params.maxWidth;
    this.breakBuffer = params.breakBuffer || 0.50;
    this.maxDuration = params.maxDuration || 480;

    // Rolling window for high/low
    this.highWindow = [];
    this.lowWindow = [];

    // State machine
    this.state = 'LOOKING';  // LOOKING | CONFIRMING | IN_RANGE
    this.confirmCount = 0;
    this.rangeHigh = null;
    this.rangeLow = null;
    this.rangeStartIdx = null;
    this.rangeBarsInside = 0;
  }

  /**
   * Process one candle. Returns range state.
   * @param {object} candle - { high, low, close }
   * @param {number} idx - bar index
   * @returns {{ inRange: boolean, rangeHigh: number, rangeLow: number,
   *             justBroke: boolean, breakDir: string|null,
   *             justConfirmed: boolean }}
   */
  update(candle, idx) {
    // Update rolling window
    this.highWindow.push(candle.high);
    this.lowWindow.push(candle.low);
    if (this.highWindow.length > this.lookback) this.highWindow.shift();
    if (this.lowWindow.length > this.lookback) this.lowWindow.shift();

    if (this.highWindow.length < this.lookback) {
      return { inRange: false, rangeHigh: null, rangeLow: null, justBroke: false, breakDir: null, justConfirmed: false };
    }

    const rollingHigh = Math.max(...this.highWindow);
    const rollingLow = Math.min(...this.lowWindow);
    const width = rollingHigh - rollingLow;

    let result = { inRange: false, rangeHigh: null, rangeLow: null, justBroke: false, breakDir: null, justConfirmed: false };

    if (this.state === 'LOOKING') {
      if (width >= this.minWidth && width <= this.maxWidth) {
        this.state = 'CONFIRMING';
        this.confirmCount = 1;
        this.rangeHigh = rollingHigh;
        this.rangeLow = rollingLow;
      }
    } else if (this.state === 'CONFIRMING') {
      if (width >= this.minWidth && width <= this.maxWidth) {
        this.confirmCount++;
        // Update boundaries to latest rolling
        this.rangeHigh = rollingHigh;
        this.rangeLow = rollingLow;
        if (this.confirmCount >= this.confirmBars) {
          // Confirmed! Lock boundaries
          this.state = 'IN_RANGE';
          this.rangeStartIdx = idx;
          this.rangeBarsInside = 0;
          result.justConfirmed = true;
        }
      } else {
        // Width expanded, reset
        this.state = 'LOOKING';
        this.confirmCount = 0;
      }
    }

    if (this.state === 'IN_RANGE') {
      this.rangeBarsInside++;
      result.inRange = true;
      result.rangeHigh = this.rangeHigh;
      result.rangeLow = this.rangeLow;

      // Check for range break
      const brokeUp = candle.close > this.rangeHigh + this.breakBuffer;
      const brokeDown = candle.close < this.rangeLow - this.breakBuffer;
      const expired = this.rangeBarsInside >= this.maxDuration;

      if (brokeUp || brokeDown || expired) {
        result.justBroke = true;
        result.breakDir = brokeUp ? 'up' : brokeDown ? 'down' : 'timeout';
        this.state = 'LOOKING';
        this.confirmCount = 0;
        this.rangeHigh = null;
        this.rangeLow = null;
      }
    }

    return result;
  }

  reset() {
    this.highWindow = [];
    this.lowWindow = [];
    this.state = 'LOOKING';
    this.confirmCount = 0;
    this.rangeHigh = null;
    this.rangeLow = null;
    this.rangeStartIdx = null;
    this.rangeBarsInside = 0;
  }
}

// ─── Trade Simulator ────────────────────────────────────────────────────

class RangeTradeSimulator {
  /**
   * @param {object} params
   * @param {number} params.entryProximity  - pts from edge to trigger entry
   * @param {number} params.stopBuffer      - pts outside range for stop
   * @param {string} params.targetMode      - 'opposite' or 'fixed'
   * @param {number} params.targetPct       - fraction of range width (for 'opposite')
   * @param {number} params.targetPts       - fixed pts (for 'fixed')
   * @param {number} params.cooldownBars    - bars between trades
   * @param {number} params.commission      - RT commission in pts
   */
  constructor(params) {
    this.entryProximity = params.entryProximity;
    this.stopBuffer = params.stopBuffer;
    this.targetMode = params.targetMode;
    this.targetPct = params.targetPct || 0.75;
    this.targetPts = params.targetPts || 2.0;
    this.cooldownBars = params.cooldownBars || 2;
    this.commission = params.commission || 0.10;
  }

  /**
   * Simulate trades within a detected range using actual candle data.
   *
   * @param {Array} candles     - all candles
   * @param {number} startIdx  - index where range was confirmed
   * @param {number} endIdx    - index where range broke (or end of data)
   * @param {number} rangeHigh
   * @param {number} rangeLow
   * @returns {Array} trades - array of trade results
   */
  simulateRange(candles, startIdx, endIdx, rangeHigh, rangeLow) {
    const rangeWidth = rangeHigh - rangeLow;
    const trades = [];
    let position = null;  // { side, entry, stop, target, entryIdx }
    let cooldownUntil = startIdx;

    for (let i = startIdx; i <= endIdx && i < candles.length; i++) {
      const c = candles[i];

      // Check open position
      if (position) {
        let exitPrice = null;
        let exitReason = null;

        if (position.side === 'long') {
          // Check stop first (worst case)
          if (c.low <= position.stop) {
            exitPrice = position.stop;
            exitReason = 'stop';
          }
          // Check target
          else if (c.high >= position.target) {
            exitPrice = position.target;
            exitReason = 'target';
          }
        } else {
          // Short
          if (c.high >= position.stop) {
            exitPrice = position.stop;
            exitReason = 'stop';
          }
          else if (c.low <= position.target) {
            exitPrice = position.target;
            exitReason = 'target';
          }
        }

        if (exitPrice !== null) {
          const pnl = position.side === 'long'
            ? (exitPrice - position.entry) - this.commission
            : (position.entry - exitPrice) - this.commission;

          trades.push({
            side: position.side,
            entry: position.entry,
            exit: exitPrice,
            pnl,
            pnlDollars: pnl * 50,
            reason: exitReason,
            barsHeld: i - position.entryIdx,
            session: getSession(candles[position.entryIdx].timestamp),
            timestamp: candles[position.entryIdx].timestamp,
          });

          position = null;
          cooldownUntil = i + this.cooldownBars;
        }
        continue;  // don't open new position while in one
      }

      // Look for new entry (no position)
      if (i < cooldownUntil) continue;

      // Long: price near range low
      const distToLow = c.close - rangeLow;
      const distToHigh = rangeHigh - c.close;

      let signal = null;

      if (distToLow >= 0 && distToLow <= this.entryProximity) {
        // Long signal
        const entry = c.close;
        const stop = rangeLow - this.stopBuffer;
        let target;
        if (this.targetMode === 'fixed') {
          target = entry + this.targetPts;
        } else {
          // opposite edge, target = entry + pct * remaining distance to high
          target = entry + this.targetPct * (rangeHigh - entry);
        }
        // Only take if target is within range (don't overshoot)
        if (target <= rangeHigh + 0.25) {
          signal = { side: 'long', entry, stop, target };
        }
      } else if (distToHigh >= 0 && distToHigh <= this.entryProximity) {
        // Short signal
        const entry = c.close;
        const stop = rangeHigh + this.stopBuffer;
        let target;
        if (this.targetMode === 'fixed') {
          target = entry - this.targetPts;
        } else {
          target = entry - this.targetPct * (entry - rangeLow);
        }
        if (target >= rangeLow - 0.25) {
          signal = { side: 'short', entry, stop, target };
        }
      }

      if (signal) {
        position = { ...signal, entryIdx: i };
      }
    }

    // Force close any open position at range break
    if (position && endIdx < candles.length) {
      const exitC = candles[endIdx];
      const exitPrice = exitC.close;
      const pnl = position.side === 'long'
        ? (exitPrice - position.entry) - this.commission
        : (position.entry - exitPrice) - this.commission;
      trades.push({
        side: position.side,
        entry: position.entry,
        exit: exitPrice,
        pnl,
        pnlDollars: pnl * 50,
        reason: 'range_break',
        barsHeld: endIdx - position.entryIdx,
        session: getSession(candles[position.entryIdx].timestamp),
        timestamp: candles[position.entryIdx].timestamp,
      });
    }

    return trades;
  }
}

// ─── Configuration ──────────────────────────────────────────────────────

const RANGE_CONFIGS = [
  // Tight ranges (2-6 pts), quick lookback
  { lookback: 20, confirmBars: 10, minWidth: 2.0, maxWidth: 6.0, breakBuffer: 0.50, maxDuration: 240, label: 'tight-20' },
  { lookback: 30, confirmBars: 12, minWidth: 2.0, maxWidth: 6.0, breakBuffer: 0.50, maxDuration: 240, label: 'tight-30' },

  // Medium ranges (3-8 pts)
  { lookback: 20, confirmBars: 10, minWidth: 3.0, maxWidth: 8.0, breakBuffer: 0.75, maxDuration: 360, label: 'med-20' },
  { lookback: 30, confirmBars: 12, minWidth: 3.0, maxWidth: 8.0, breakBuffer: 0.75, maxDuration: 360, label: 'med-30' },
  { lookback: 45, confirmBars: 15, minWidth: 3.0, maxWidth: 8.0, breakBuffer: 0.75, maxDuration: 360, label: 'med-45' },

  // Wide ranges (4-10 pts)
  { lookback: 30, confirmBars: 12, minWidth: 4.0, maxWidth: 10.0, breakBuffer: 1.00, maxDuration: 480, label: 'wide-30' },
  { lookback: 45, confirmBars: 15, minWidth: 4.0, maxWidth: 10.0, breakBuffer: 1.00, maxDuration: 480, label: 'wide-45' },
  { lookback: 60, confirmBars: 20, minWidth: 4.0, maxWidth: 10.0, breakBuffer: 1.00, maxDuration: 480, label: 'wide-60' },

  // Extra wide (5-12 pts)
  { lookback: 45, confirmBars: 15, minWidth: 5.0, maxWidth: 12.0, breakBuffer: 1.25, maxDuration: 480, label: 'xwide-45' },
  { lookback: 60, confirmBars: 20, minWidth: 5.0, maxWidth: 12.0, breakBuffer: 1.25, maxDuration: 480, label: 'xwide-60' },
];

const TRADE_CONFIGS = [
  // Opposite edge targets (% of range)
  { entryProximity: 0.50, stopBuffer: 0.75, targetMode: 'opposite', targetPct: 0.50, cooldownBars: 2, label: '0.5in/0.75out/50%' },
  { entryProximity: 0.50, stopBuffer: 0.75, targetMode: 'opposite', targetPct: 0.75, cooldownBars: 2, label: '0.5in/0.75out/75%' },
  { entryProximity: 0.50, stopBuffer: 1.00, targetMode: 'opposite', targetPct: 0.50, cooldownBars: 2, label: '0.5in/1.0out/50%' },
  { entryProximity: 0.50, stopBuffer: 1.00, targetMode: 'opposite', targetPct: 0.75, cooldownBars: 2, label: '0.5in/1.0out/75%' },
  { entryProximity: 0.75, stopBuffer: 0.75, targetMode: 'opposite', targetPct: 0.50, cooldownBars: 2, label: '0.75in/0.75out/50%' },
  { entryProximity: 0.75, stopBuffer: 0.75, targetMode: 'opposite', targetPct: 0.75, cooldownBars: 2, label: '0.75in/0.75out/75%' },
  { entryProximity: 0.75, stopBuffer: 1.00, targetMode: 'opposite', targetPct: 0.50, cooldownBars: 2, label: '0.75in/1.0out/50%' },
  { entryProximity: 0.75, stopBuffer: 1.00, targetMode: 'opposite', targetPct: 0.75, cooldownBars: 2, label: '0.75in/1.0out/75%' },
  { entryProximity: 1.00, stopBuffer: 0.75, targetMode: 'opposite', targetPct: 0.50, cooldownBars: 2, label: '1.0in/0.75out/50%' },
  { entryProximity: 1.00, stopBuffer: 1.00, targetMode: 'opposite', targetPct: 0.50, cooldownBars: 2, label: '1.0in/1.0out/50%' },
  { entryProximity: 1.00, stopBuffer: 1.00, targetMode: 'opposite', targetPct: 0.75, cooldownBars: 2, label: '1.0in/1.0out/75%' },

  // Fixed point targets
  { entryProximity: 0.50, stopBuffer: 0.75, targetMode: 'fixed', targetPts: 1.5, cooldownBars: 2, label: '0.5in/0.75out/1.5pt' },
  { entryProximity: 0.50, stopBuffer: 1.00, targetMode: 'fixed', targetPts: 2.0, cooldownBars: 2, label: '0.5in/1.0out/2.0pt' },
  { entryProximity: 0.75, stopBuffer: 1.00, targetMode: 'fixed', targetPts: 1.5, cooldownBars: 2, label: '0.75in/1.0out/1.5pt' },
  { entryProximity: 0.75, stopBuffer: 1.00, targetMode: 'fixed', targetPts: 2.0, cooldownBars: 2, label: '0.75in/1.0out/2.0pt' },
  { entryProximity: 1.00, stopBuffer: 1.00, targetMode: 'fixed', targetPts: 2.0, cooldownBars: 2, label: '1.0in/1.0out/2.0pt' },
  { entryProximity: 1.00, stopBuffer: 1.50, targetMode: 'fixed', targetPts: 2.0, cooldownBars: 2, label: '1.0in/1.5out/2.0pt' },
  { entryProximity: 1.00, stopBuffer: 1.50, targetMode: 'fixed', targetPts: 3.0, cooldownBars: 2, label: '1.0in/1.5out/3.0pt' },
];

// ─── Main Analysis ──────────────────────────────────────────────────────

async function main() {
  const args = await parseArgs();
  const startDate = new Date(args.start);
  const endDate = new Date(args.end);
  const isEndDate = new Date(args.isEnd);
  const commission = args.commission;

  console.log(`
  ES Range Scalper Analysis
  ${'═'.repeat(50)}
  Data:        ${args.start} to ${args.end}
  In-sample:   ${args.start} to ${args.isEnd}
  OOS:         ${new Date(isEndDate.getTime() + 86400000).toISOString().slice(0, 10)} to ${args.end}
  Commission:  ${commission} pts ($${(commission * 50).toFixed(2)}/RT)
  Range configs: ${RANGE_CONFIGS.length}
  Trade configs: ${TRADE_CONFIGS.length}
  Total combos:  ${RANGE_CONFIGS.length * TRADE_CONFIGS.length}
`);

  // Load data
  const defaultConfig = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'config', 'default.json'), 'utf-8'));
  const loader = new CSVLoader(dataDir, defaultConfig);
  console.log(`  Loading ES 1m continuous data...`);
  const { candles } = await loader.loadOHLCVData('ES', startDate, endDate);
  console.log(`  Loaded ${candles.length.toLocaleString()} candles\n`);

  // ── Phase 1: Range Detection & Characterization ─────────────────────

  console.log('  Phase 1: Detecting ranges across all configurations...\n');

  const allResults = [];

  for (const rc of RANGE_CONFIGS) {
    const detector = new RangeDetector(rc);
    const ranges = [];
    let currentRange = null;

    for (let i = 0; i < candles.length; i++) {
      const result = detector.update(candles[i], i);

      if (result.justConfirmed) {
        currentRange = {
          startIdx: i,
          rangeHigh: result.rangeHigh,
          rangeLow: result.rangeLow,
          width: result.rangeHigh - result.rangeLow,
          startTime: candles[i].timestamp,
        };
      }

      if (result.justBroke && currentRange) {
        currentRange.endIdx = i;
        currentRange.endTime = candles[i].timestamp;
        currentRange.duration = i - currentRange.startIdx;
        currentRange.breakDir = result.breakDir;
        currentRange.period = new Date(currentRange.startTime) <= isEndDate ? 'IS' : 'OOS';
        ranges.push(currentRange);
        currentRange = null;
      }
    }

    // Close any open range at end of data
    if (currentRange) {
      currentRange.endIdx = candles.length - 1;
      currentRange.endTime = candles[candles.length - 1].timestamp;
      currentRange.duration = candles.length - 1 - currentRange.startIdx;
      currentRange.breakDir = 'data_end';
      currentRange.period = new Date(currentRange.startTime) <= isEndDate ? 'IS' : 'OOS';
      ranges.push(currentRange);
    }

    const isRanges = ranges.filter(r => r.period === 'IS');
    const oosRanges = ranges.filter(r => r.period === 'OOS');

    // Count unique days with ranges
    const isDays = new Set(isRanges.map(r => getDateKey(r.startTime))).size;
    const oosDays = new Set(oosRanges.map(r => getDateKey(r.startTime))).size;

    const stats = {
      label: rc.label,
      total: ranges.length,
      isCount: isRanges.length,
      oosCount: oosRanges.length,
      isDays,
      oosDays,
      isAvgWidth: isRanges.length ? isRanges.reduce((s, r) => s + r.width, 0) / isRanges.length : 0,
      oosAvgWidth: oosRanges.length ? oosRanges.reduce((s, r) => s + r.width, 0) / oosRanges.length : 0,
      isAvgDuration: isRanges.length ? isRanges.reduce((s, r) => s + r.duration, 0) / isRanges.length : 0,
      oosAvgDuration: oosRanges.length ? oosRanges.reduce((s, r) => s + r.duration, 0) / oosRanges.length : 0,
      isRangesPerDay: isDays ? isRanges.length / isDays : 0,
      oosRangesPerDay: oosDays ? oosRanges.length / oosDays : 0,
    };

    // ── Phase 2: Trade Simulation ─────────────────────────────────────

    for (const tc of TRADE_CONFIGS) {
      const sim = new RangeTradeSimulator({ ...tc, commission });

      let isTrades = [];
      let oosTrades = [];

      for (const range of ranges) {
        const trades = sim.simulateRange(
          candles, range.startIdx, range.endIdx,
          range.rangeHigh, range.rangeLow
        );
        if (range.period === 'IS') isTrades.push(...trades);
        else oosTrades.push(...trades);
      }

      const isMetrics = computeMetrics(isTrades);
      const oosMetrics = computeMetrics(oosTrades);

      allResults.push({
        rangeLabel: rc.label,
        tradeLabel: tc.label,
        rangeConfig: rc,
        tradeConfig: tc,
        rangeStats: stats,
        is: isMetrics,
        oos: oosMetrics,
      });
    }

    // Progress
    const pct = ((RANGE_CONFIGS.indexOf(rc) + 1) / RANGE_CONFIGS.length * 100).toFixed(0);
    process.stdout.write(`  Range "${rc.label}": ${ranges.length} ranges found (${isRanges.length} IS, ${oosRanges.length} OOS) — ${pct}% done\n`);
  }

  // ── Phase 3: Output Results ─────────────────────────────────────────

  console.log('\n');

  // Range characterization table
  console.log('  ' + '═'.repeat(90));
  console.log('  RANGE CHARACTERIZATION');
  console.log('  ' + '═'.repeat(90));
  console.log('  ' + pad('Config', 12) + pad('Ranges', 8) + pad('IS', 6) + pad('OOS', 6)
    + pad('IS/day', 8) + pad('OOS/day', 8) + pad('IS Width', 10) + pad('OOS Width', 10)
    + pad('IS Dur', 8) + pad('OOS Dur', 8));
  console.log('  ' + '─'.repeat(90));

  const rangeLabelsShown = new Set();
  for (const r of allResults) {
    if (rangeLabelsShown.has(r.rangeLabel)) continue;
    rangeLabelsShown.add(r.rangeLabel);
    const s = r.rangeStats;
    console.log('  ' + pad(s.label, 12)
      + pad(s.total, 8) + pad(s.isCount, 6) + pad(s.oosCount, 6)
      + pad(s.isRangesPerDay.toFixed(1), 8) + pad(s.oosRangesPerDay.toFixed(1), 8)
      + pad(s.isAvgWidth.toFixed(1) + 'pt', 10) + pad(s.oosAvgWidth.toFixed(1) + 'pt', 10)
      + pad(Math.round(s.isAvgDuration) + 'bar', 8) + pad(Math.round(s.oosAvgDuration) + 'bar', 8));
  }

  // Sort all results by IS profit factor (descending), filter to at least 50 IS trades
  const viable = allResults.filter(r => r.is.trades >= 50 && r.oos.trades >= 20);
  viable.sort((a, b) => b.is.totalPnl - a.is.totalPnl);

  // Top results table
  console.log('\n  ' + '═'.repeat(130));
  console.log('  TOP 30 CONFIGURATIONS (by IS total P&L, min 50 IS trades, 20 OOS trades)');
  console.log('  ' + '═'.repeat(130));
  console.log('  ' + pad('#', 4) + pad('Range', 12) + pad('Trade', 22)
    + pad('IS n', 7) + pad('IS WR%', 8) + pad('IS PF', 7) + pad('IS $/tr', 9) + pad('IS Total', 10)
    + pad('OOS n', 7) + pad('OOS WR%', 8) + pad('OOS PF', 8) + pad('OOS $/tr', 9) + pad('OOS Total', 10)
    + '  Verdict');
  console.log('  ' + '─'.repeat(130));

  const top = viable.slice(0, 30);
  for (let i = 0; i < top.length; i++) {
    const r = top[i];
    const verdict = getVerdict(r);
    console.log('  ' + pad(i + 1, 4)
      + pad(r.rangeLabel, 12)
      + pad(r.tradeLabel, 22)
      + pad(r.is.trades, 7)
      + pad(r.is.winRate.toFixed(1) + '%', 8)
      + pad(r.is.profitFactor.toFixed(2), 7)
      + pad('$' + r.is.avgPnlDollars.toFixed(0), 9)
      + pad('$' + r.is.totalPnlDollars.toFixed(0), 10)
      + pad(r.oos.trades, 7)
      + pad(r.oos.winRate.toFixed(1) + '%', 8)
      + pad(r.oos.profitFactor.toFixed(2), 8)
      + pad('$' + r.oos.avgPnlDollars.toFixed(0), 9)
      + pad('$' + r.oos.totalPnlDollars.toFixed(0), 10)
      + '  ' + verdict);
  }

  // Also show bottom configurations (worst) for contrast
  console.log('\n  ' + '═'.repeat(130));
  console.log('  BOTTOM 10 CONFIGURATIONS (worst IS P&L)');
  console.log('  ' + '═'.repeat(130));
  const bottom = viable.slice(-10).reverse();
  for (const r of bottom) {
    console.log('  ' + pad(r.rangeLabel, 12)
      + pad(r.tradeLabel, 22)
      + pad(r.is.trades, 7)
      + pad(r.is.winRate.toFixed(1) + '%', 8)
      + pad(r.is.profitFactor.toFixed(2), 7)
      + pad('$' + r.is.avgPnlDollars.toFixed(0), 9)
      + pad('$' + r.is.totalPnlDollars.toFixed(0), 10)
      + pad(r.oos.trades, 7)
      + pad(r.oos.winRate.toFixed(1) + '%', 8)
      + pad(r.oos.profitFactor.toFixed(2), 8)
      + pad('$' + r.oos.avgPnlDollars.toFixed(0), 9)
      + pad('$' + r.oos.totalPnlDollars.toFixed(0), 10));
  }

  // Session breakdown for top 5
  console.log('\n  ' + '═'.repeat(100));
  console.log('  SESSION BREAKDOWN (top 5 configs)');
  console.log('  ' + '═'.repeat(100));

  for (let i = 0; i < Math.min(5, top.length); i++) {
    const r = top[i];
    console.log(`\n  #${i + 1}: ${r.rangeLabel} + ${r.tradeLabel}`);
    console.log('  ' + pad('Session', 14) + pad('IS n', 7) + pad('IS WR%', 8) + pad('IS $/tr', 9)
      + pad('OOS n', 7) + pad('OOS WR%', 8) + pad('OOS $/tr', 9));
    console.log('  ' + '─'.repeat(65));

    // Re-run to get session breakdown
    for (const sess of ['overnight', 'premarket', 'rth', 'afterhours']) {
      // Filter from the full result set (we need the trades)
      // Re-simulate for this config to get trades
      const rc = r.rangeConfig;
      const tc = r.tradeConfig;
      const detector = new RangeDetector(rc);
      const sim = new RangeTradeSimulator({ ...tc, commission });
      let isTrades = [];
      let oosTrades = [];
      let currentRange = null;

      for (let j = 0; j < candles.length; j++) {
        const result = detector.update(candles[j], j);
        if (result.justConfirmed) {
          currentRange = { startIdx: j, rangeHigh: result.rangeHigh, rangeLow: result.rangeLow, startTime: candles[j].timestamp };
        }
        if (result.justBroke && currentRange) {
          currentRange.endIdx = j;
          const period = new Date(currentRange.startTime) <= isEndDate ? 'IS' : 'OOS';
          const trades = sim.simulateRange(candles, currentRange.startIdx, j, currentRange.rangeHigh, currentRange.rangeLow);
          if (period === 'IS') isTrades.push(...trades);
          else oosTrades.push(...trades);
          currentRange = null;
        }
      }

      const isFiltered = isTrades.filter(t => t.session === sess);
      const oosFiltered = oosTrades.filter(t => t.session === sess);
      const isM = computeMetrics(isFiltered);
      const oosM = computeMetrics(oosFiltered);

      console.log('  ' + pad(sess, 14)
        + pad(isM.trades, 7) + pad(isM.winRate.toFixed(1) + '%', 8) + pad('$' + isM.avgPnlDollars.toFixed(0), 9)
        + pad(oosM.trades, 7) + pad(oosM.winRate.toFixed(1) + '%', 8) + pad('$' + oosM.avgPnlDollars.toFixed(0), 9));
    }
  }

  // Trade exit reason breakdown for top 5
  console.log('\n  ' + '═'.repeat(80));
  console.log('  EXIT REASON BREAKDOWN (top 5 configs, IS period)');
  console.log('  ' + '═'.repeat(80));

  for (let i = 0; i < Math.min(5, top.length); i++) {
    const r = top[i];
    const rc = r.rangeConfig;
    const tc = r.tradeConfig;
    const detector = new RangeDetector(rc);
    const sim = new RangeTradeSimulator({ ...tc, commission });
    let allTrades = [];
    let currentRange = null;

    for (let j = 0; j < candles.length; j++) {
      const result = detector.update(candles[j], j);
      if (result.justConfirmed) {
        currentRange = { startIdx: j, rangeHigh: result.rangeHigh, rangeLow: result.rangeLow, startTime: candles[j].timestamp };
      }
      if (result.justBroke && currentRange) {
        currentRange.endIdx = j;
        if (new Date(currentRange.startTime) <= isEndDate) {
          const trades = sim.simulateRange(candles, currentRange.startIdx, j, currentRange.rangeHigh, currentRange.rangeLow);
          allTrades.push(...trades);
        }
        currentRange = null;
      }
    }

    const byReason = {};
    for (const t of allTrades) {
      if (!byReason[t.reason]) byReason[t.reason] = { count: 0, totalPnl: 0 };
      byReason[t.reason].count++;
      byReason[t.reason].totalPnl += t.pnlDollars;
    }

    console.log(`\n  #${i + 1}: ${r.rangeLabel} + ${r.tradeLabel} (${allTrades.length} trades)`);
    for (const [reason, data] of Object.entries(byReason).sort((a, b) => b[1].count - a[1].count)) {
      console.log(`    ${pad(reason, 14)} ${pad(data.count, 6)} trades  avg $${(data.totalPnl / data.count).toFixed(0)}  total $${data.totalPnl.toFixed(0)}`);
    }
  }

  // Trades per range breakdown for top 5
  console.log('\n  ' + '═'.repeat(80));
  console.log('  TRADES PER RANGE (top 5 configs, IS period)');
  console.log('  ' + '═'.repeat(80));

  for (let i = 0; i < Math.min(5, top.length); i++) {
    const r = top[i];
    const rc = r.rangeConfig;
    const tc = r.tradeConfig;
    const detector = new RangeDetector(rc);
    const sim = new RangeTradeSimulator({ ...tc, commission });
    const tradesPerRange = [];
    let currentRange = null;

    for (let j = 0; j < candles.length; j++) {
      const result = detector.update(candles[j], j);
      if (result.justConfirmed) {
        currentRange = { startIdx: j, rangeHigh: result.rangeHigh, rangeLow: result.rangeLow, startTime: candles[j].timestamp };
      }
      if (result.justBroke && currentRange) {
        if (new Date(currentRange.startTime) <= isEndDate) {
          const trades = sim.simulateRange(candles, currentRange.startIdx, j, currentRange.rangeHigh, currentRange.rangeLow);
          tradesPerRange.push({
            tradeCount: trades.length,
            rangePnl: trades.reduce((s, t) => s + t.pnlDollars, 0),
            rangeWidth: currentRange.rangeHigh - currentRange.rangeLow,
            rangeDuration: j - currentRange.startIdx,
          });
        }
        currentRange = null;
      }
    }

    const counts = {};
    for (const r of tradesPerRange) {
      const bucket = r.tradeCount;
      if (!counts[bucket]) counts[bucket] = { n: 0, totalPnl: 0 };
      counts[bucket].n++;
      counts[bucket].totalPnl += r.rangePnl;
    }

    console.log(`\n  #${i + 1}: ${r.rangeLabel} + ${r.tradeLabel} (${tradesPerRange.length} ranges)`);
    console.log(`    Avg trades/range: ${(tradesPerRange.reduce((s, r) => s + r.tradeCount, 0) / tradesPerRange.length).toFixed(1)}`);
    console.log(`    Avg P&L/range: $${(tradesPerRange.reduce((s, r) => s + r.rangePnl, 0) / tradesPerRange.length).toFixed(0)}`);
    for (const [count, data] of Object.entries(counts).sort((a, b) => parseInt(a) - parseInt(b))) {
      console.log(`    ${pad(count + ' trades:', 12)} ${pad(data.n, 5)} ranges  avg P&L $${(data.totalPnl / data.n).toFixed(0)}  total $${data.totalPnl.toFixed(0)}`);
    }
  }

  // Save JSON
  const outputPath = path.join(__dirname, args.output);
  const jsonResults = allResults.map(r => ({
    rangeLabel: r.rangeLabel,
    tradeLabel: r.tradeLabel,
    rangeConfig: r.rangeConfig,
    tradeConfig: r.tradeConfig,
    rangeStats: r.rangeStats,
    is: r.is,
    oos: r.oos,
  }));
  fs.writeFileSync(outputPath, JSON.stringify(jsonResults, null, 2));
  console.log(`\n  Results saved to ${args.output}`);
}

// ─── Helpers ────────────────────────────────────────────────────────────

function computeMetrics(trades) {
  if (!trades.length) {
    return {
      trades: 0, wins: 0, losses: 0, winRate: 0, profitFactor: 0,
      totalPnl: 0, totalPnlDollars: 0, avgPnl: 0, avgPnlDollars: 0,
      avgWin: 0, avgLoss: 0, maxWin: 0, maxLoss: 0,
      avgBarsHeld: 0,
    };
  }

  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const grossWins = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLosses = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));

  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: (wins.length / trades.length) * 100,
    profitFactor: grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? 999 : 0,
    totalPnl,
    totalPnlDollars: totalPnl * 50,
    avgPnl: totalPnl / trades.length,
    avgPnlDollars: (totalPnl * 50) / trades.length,
    avgWin: wins.length ? (grossWins * 50) / wins.length : 0,
    avgLoss: losses.length ? (grossLosses * 50) / losses.length : 0,
    maxWin: wins.length ? Math.max(...wins.map(t => t.pnl)) * 50 : 0,
    maxLoss: losses.length ? Math.max(...losses.map(t => Math.abs(t.pnl))) * 50 : 0,
    avgBarsHeld: trades.reduce((s, t) => s + t.barsHeld, 0) / trades.length,
  };
}

function getVerdict(r) {
  const isGood = r.is.profitFactor > 1.1 && r.is.avgPnlDollars > 5;
  const oosGood = r.oos.profitFactor > 1.0 && r.oos.avgPnlDollars > 0;
  if (isGood && oosGood) return '*** BOTH ***';
  if (isGood) return '* IS only';
  if (oosGood) return 'OOS only';
  return '';
}

function pad(val, width) {
  const s = String(val);
  return s.length >= width ? s + ' ' : s + ' '.repeat(width - s.length);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
