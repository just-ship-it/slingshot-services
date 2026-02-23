#!/usr/bin/env node

/**
 * ES Range Scalper v2 — "Proven Range" Analysis
 *
 * Key insight from v1: Ranges that produce 3+ trades are consistently
 * profitable, but 70% of detected "ranges" die after 1-2 trades.
 *
 * v2 Solution: Don't trade immediately when a range is detected.
 * Wait for the range to prove itself with actual edge touches before
 * committing capital. Only start trading after N confirmed bounces.
 *
 * Three warmup modes tested:
 *   A) "Skip N" — detect entry signals but don't trade the first N;
 *      start trading on signal N+1 if range is still intact
 *   B) "Both edges" — require at least 1 touch of EACH edge before trading
 *   C) "Quality score" — require N total edge touches AND touches of both edges
 *
 * Also tests: using the touch points themselves to refine range boundaries
 * (instead of the initial rolling high/low, use actual bounce levels).
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
    .option('output', { type: 'string', default: 'es-range-scalper-v2-results.json' })
    .option('verbose', { alias: 'v', type: 'boolean', default: false })
    .help()
    .parse();
}

// ─── Fast Session Lookup ────────────────────────────────────────────────

function getSession(timestamp) {
  const ms = typeof timestamp === 'number' ? timestamp : new Date(timestamp).getTime();
  const utcHour = Math.floor((ms % 86400000) / 3600000);
  const utcMin = Math.floor((ms % 3600000) / 60000);
  let estHour = utcHour - 5;
  if (estHour < 0) estHour += 24;
  const td = estHour + utcMin / 60;
  if (td >= 18 || td < 4) return 'overnight';
  if (td < 9.5) return 'premarket';
  if (td < 16) return 'rth';
  return 'afterhours';
}

// ─── Range Detector (same as v1) ────────────────────────────────────────

class RangeDetector {
  constructor(params) {
    this.lookback = params.lookback;
    this.confirmBars = params.confirmBars;
    this.minWidth = params.minWidth;
    this.maxWidth = params.maxWidth;
    this.breakBuffer = params.breakBuffer || 0.50;
    this.maxDuration = params.maxDuration || 480;
    this.highWindow = [];
    this.lowWindow = [];
    this.state = 'LOOKING';
    this.confirmCount = 0;
    this.rangeHigh = null;
    this.rangeLow = null;
    this.rangeStartIdx = null;
    this.rangeBarsInside = 0;
  }

  update(candle, idx) {
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
        this.rangeHigh = rollingHigh;
        this.rangeLow = rollingLow;
        if (this.confirmCount >= this.confirmBars) {
          this.state = 'IN_RANGE';
          this.rangeStartIdx = idx;
          this.rangeBarsInside = 0;
          result.justConfirmed = true;
        }
      } else {
        this.state = 'LOOKING';
        this.confirmCount = 0;
      }
    }

    if (this.state === 'IN_RANGE') {
      this.rangeBarsInside++;
      result.inRange = true;
      result.rangeHigh = this.rangeHigh;
      result.rangeLow = this.rangeLow;

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

// ─── Proven Range Trade Simulator ───────────────────────────────────────

class ProvenRangeTradeSimulator {
  /**
   * @param {object} params
   * @param {number} params.entryProximity  - pts from edge to trigger entry
   * @param {number} params.stopBuffer      - pts outside range for stop
   * @param {string} params.targetMode      - 'opposite' or 'fixed'
   * @param {number} params.targetPct       - fraction of range width (for 'opposite')
   * @param {number} params.targetPts       - fixed pts (for 'fixed')
   * @param {number} params.cooldownBars    - bars between trades
   * @param {number} params.commission      - RT commission in pts
   * @param {string} params.warmupMode      - 'skip_n', 'both_edges', 'quality'
   * @param {number} params.warmupN         - number of signals/touches to skip/require
   * @param {boolean} params.refineBounds   - use touch points to refine boundaries
   */
  constructor(params) {
    this.entryProximity = params.entryProximity;
    this.stopBuffer = params.stopBuffer;
    this.targetMode = params.targetMode;
    this.targetPct = params.targetPct || 0.75;
    this.targetPts = params.targetPts || 2.0;
    this.cooldownBars = params.cooldownBars || 2;
    this.commission = params.commission || 0.10;
    this.warmupMode = params.warmupMode || 'skip_n';
    this.warmupN = params.warmupN || 2;
    this.refineBounds = params.refineBounds || false;
  }

  simulateRange(candles, startIdx, endIdx, rangeHigh, rangeLow) {
    const trades = [];
    let position = null;
    let cooldownUntil = startIdx;

    // Warmup tracking
    let totalSignals = 0;     // total entry signals seen (for skip_n mode)
    let topTouches = 0;       // touches near range high
    let bottomTouches = 0;    // touches near range low
    let warmedUp = false;     // have we satisfied warmup requirements?
    let lastTouchSide = null; // prevent double-counting same side

    // For boundary refinement
    let refinedHigh = rangeHigh;
    let refinedLow = rangeLow;
    const topTouchPrices = [];
    const bottomTouchPrices = [];

    for (let i = startIdx; i <= endIdx && i < candles.length; i++) {
      const c = candles[i];

      // Check open position first
      if (position) {
        let exitPrice = null;
        let exitReason = null;

        if (position.side === 'long') {
          if (c.low <= position.stop) {
            exitPrice = position.stop;
            exitReason = 'stop';
          } else if (c.high >= position.target) {
            exitPrice = position.target;
            exitReason = 'target';
          }
        } else {
          if (c.high >= position.stop) {
            exitPrice = position.stop;
            exitReason = 'stop';
          } else if (c.low <= position.target) {
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
            signalNumber: position.signalNumber,
          });

          position = null;
          cooldownUntil = i + this.cooldownBars;
        }
        continue;
      }

      // No position — check for signals
      if (i < cooldownUntil) continue;

      const activeHigh = this.refineBounds && topTouchPrices.length >= 2 ? refinedHigh : rangeHigh;
      const activeLow = this.refineBounds && bottomTouchPrices.length >= 2 ? refinedLow : rangeLow;

      const distToLow = c.close - activeLow;
      const distToHigh = activeHigh - c.close;

      let signal = null;

      if (distToLow >= 0 && distToLow <= this.entryProximity) {
        signal = 'long';
        if (lastTouchSide !== 'bottom') {
          bottomTouches++;
          lastTouchSide = 'bottom';
          bottomTouchPrices.push(c.low);
          if (bottomTouchPrices.length >= 2) {
            refinedLow = bottomTouchPrices.reduce((s, p) => s + p, 0) / bottomTouchPrices.length;
          }
        }
      } else if (distToHigh >= 0 && distToHigh <= this.entryProximity) {
        signal = 'short';
        if (lastTouchSide !== 'top') {
          topTouches++;
          lastTouchSide = 'top';
          topTouchPrices.push(c.high);
          if (topTouchPrices.length >= 2) {
            refinedHigh = topTouchPrices.reduce((s, p) => s + p, 0) / topTouchPrices.length;
          }
        }
      } else {
        // Reset last touch side when price moves away from edges
        const midRange = (activeHigh + activeLow) / 2;
        if (Math.abs(c.close - midRange) < (activeHigh - activeLow) * 0.25) {
          lastTouchSide = null;
        }
      }

      if (!signal) continue;

      totalSignals++;

      // Check warmup conditions
      if (!warmedUp) {
        if (this.warmupMode === 'skip_n') {
          warmedUp = totalSignals > this.warmupN;
        } else if (this.warmupMode === 'both_edges') {
          warmedUp = topTouches >= 1 && bottomTouches >= 1 && (topTouches + bottomTouches) >= this.warmupN;
        } else if (this.warmupMode === 'quality') {
          warmedUp = topTouches >= this.warmupN && bottomTouches >= this.warmupN;
        }
        if (!warmedUp) continue;
      }

      // Build trade
      const entry = c.close;
      let stop, target;

      if (signal === 'long') {
        stop = activeLow - this.stopBuffer;
        if (this.targetMode === 'fixed') {
          target = entry + this.targetPts;
        } else {
          target = entry + this.targetPct * (activeHigh - entry);
        }
        if (target > activeHigh + 0.25) continue;
      } else {
        stop = activeHigh + this.stopBuffer;
        if (this.targetMode === 'fixed') {
          target = entry - this.targetPts;
        } else {
          target = entry - this.targetPct * (entry - activeLow);
        }
        if (target < activeLow - 0.25) continue;
      }

      position = { side: signal, entry, stop, target, entryIdx: i, signalNumber: totalSignals };
    }

    // Force close open position at range break
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
        signalNumber: position.signalNumber,
      });
    }

    return {
      trades,
      warmupStats: {
        totalSignals,
        topTouches,
        bottomTouches,
        warmedUp,
      },
    };
  }
}

// ─── Configuration ──────────────────────────────────────────────────────

// Use only the better-performing range configs from v1
const RANGE_CONFIGS = [
  { lookback: 45, confirmBars: 15, minWidth: 3.0, maxWidth: 8.0, breakBuffer: 0.75, maxDuration: 360, label: 'med-45' },
  { lookback: 30, confirmBars: 12, minWidth: 4.0, maxWidth: 10.0, breakBuffer: 1.00, maxDuration: 480, label: 'wide-30' },
  { lookback: 45, confirmBars: 15, minWidth: 4.0, maxWidth: 10.0, breakBuffer: 1.00, maxDuration: 480, label: 'wide-45' },
  { lookback: 60, confirmBars: 20, minWidth: 4.0, maxWidth: 10.0, breakBuffer: 1.00, maxDuration: 480, label: 'wide-60' },
  { lookback: 45, confirmBars: 15, minWidth: 5.0, maxWidth: 12.0, breakBuffer: 1.25, maxDuration: 480, label: 'xwide-45' },
  { lookback: 60, confirmBars: 20, minWidth: 5.0, maxWidth: 12.0, breakBuffer: 1.25, maxDuration: 480, label: 'xwide-60' },
  // Even wider for longer-lasting ranges
  { lookback: 60, confirmBars: 20, minWidth: 6.0, maxWidth: 15.0, breakBuffer: 1.50, maxDuration: 600, label: 'xxwide-60' },
  { lookback: 90, confirmBars: 30, minWidth: 6.0, maxWidth: 15.0, breakBuffer: 1.50, maxDuration: 600, label: 'xxwide-90' },
];

// Focus on better trade configs from v1 + fixed point targets
const TRADE_CONFIGS = [
  { entryProximity: 1.00, stopBuffer: 1.50, targetMode: 'fixed', targetPts: 2.0, cooldownBars: 2, label: '1.0in/1.5out/2.0pt' },
  { entryProximity: 1.00, stopBuffer: 1.50, targetMode: 'fixed', targetPts: 3.0, cooldownBars: 2, label: '1.0in/1.5out/3.0pt' },
  { entryProximity: 1.25, stopBuffer: 1.50, targetMode: 'fixed', targetPts: 2.0, cooldownBars: 2, label: '1.25in/1.5out/2.0pt' },
  { entryProximity: 1.25, stopBuffer: 2.00, targetMode: 'fixed', targetPts: 3.0, cooldownBars: 2, label: '1.25in/2.0out/3.0pt' },
  { entryProximity: 1.50, stopBuffer: 2.00, targetMode: 'fixed', targetPts: 2.0, cooldownBars: 3, label: '1.5in/2.0out/2.0pt' },
  { entryProximity: 1.50, stopBuffer: 2.00, targetMode: 'fixed', targetPts: 3.0, cooldownBars: 3, label: '1.5in/2.0out/3.0pt' },
  { entryProximity: 1.00, stopBuffer: 1.00, targetMode: 'opposite', targetPct: 0.50, cooldownBars: 2, label: '1.0in/1.0out/50%' },
  { entryProximity: 1.25, stopBuffer: 1.50, targetMode: 'opposite', targetPct: 0.50, cooldownBars: 2, label: '1.25in/1.5out/50%' },
];

// Warmup configurations — the key v2 variable
const WARMUP_CONFIGS = [
  // Baseline: no warmup (same as v1)
  { warmupMode: 'skip_n', warmupN: 0, refineBounds: false, label: 'no_warmup' },
  // Skip first N signals
  { warmupMode: 'skip_n', warmupN: 1, refineBounds: false, label: 'skip_1' },
  { warmupMode: 'skip_n', warmupN: 2, refineBounds: false, label: 'skip_2' },
  { warmupMode: 'skip_n', warmupN: 3, refineBounds: false, label: 'skip_3' },
  { warmupMode: 'skip_n', warmupN: 4, refineBounds: false, label: 'skip_4' },
  // Require both edges touched
  { warmupMode: 'both_edges', warmupN: 2, refineBounds: false, label: 'both_2' },
  { warmupMode: 'both_edges', warmupN: 3, refineBounds: false, label: 'both_3' },
  { warmupMode: 'both_edges', warmupN: 4, refineBounds: false, label: 'both_4' },
  // Quality: N touches of EACH edge
  { warmupMode: 'quality', warmupN: 2, refineBounds: false, label: 'qual_2ea' },
  { warmupMode: 'quality', warmupN: 3, refineBounds: false, label: 'qual_3ea' },
  // With boundary refinement
  { warmupMode: 'skip_n', warmupN: 2, refineBounds: true, label: 'skip_2+refine' },
  { warmupMode: 'both_edges', warmupN: 3, refineBounds: true, label: 'both_3+refine' },
  { warmupMode: 'quality', warmupN: 2, refineBounds: true, label: 'qual_2ea+refine' },
];

// ─── Main Analysis ──────────────────────────────────────────────────────

async function main() {
  const args = await parseArgs();
  const startDate = new Date(args.start);
  const endDate = new Date(args.end);
  const isEndDate = new Date(args.isEnd);
  const commission = args.commission;

  const totalCombos = RANGE_CONFIGS.length * TRADE_CONFIGS.length * WARMUP_CONFIGS.length;

  console.log(`
  ES Range Scalper v2 — "Proven Range" Analysis
  ${'═'.repeat(55)}
  Data:           ${args.start} to ${args.end}
  In-sample:      ${args.start} to ${args.isEnd}
  OOS:            ${new Date(isEndDate.getTime() + 86400000).toISOString().slice(0, 10)} to ${args.end}
  Commission:     ${commission} pts ($${(commission * 50).toFixed(2)}/RT)
  Range configs:  ${RANGE_CONFIGS.length}
  Trade configs:  ${TRADE_CONFIGS.length}
  Warmup configs: ${WARMUP_CONFIGS.length}
  Total combos:   ${totalCombos}
`);

  // Load data
  const defaultConfig = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'config', 'default.json'), 'utf-8'));
  const loader = new CSVLoader(dataDir, defaultConfig);
  console.log(`  Loading ES 1m continuous data...`);
  const { candles } = await loader.loadOHLCVData('ES', startDate, endDate);
  console.log(`  Loaded ${candles.length.toLocaleString()} candles\n`);

  // ── Phase 1: Detect all ranges per config (reusable) ──────────────────

  console.log('  Phase 1: Detecting ranges...\n');

  const rangesByConfig = {};

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

    if (currentRange) {
      currentRange.endIdx = candles.length - 1;
      currentRange.endTime = candles[candles.length - 1].timestamp;
      currentRange.duration = candles.length - 1 - currentRange.startIdx;
      currentRange.breakDir = 'data_end';
      currentRange.period = new Date(currentRange.startTime) <= isEndDate ? 'IS' : 'OOS';
      ranges.push(currentRange);
    }

    rangesByConfig[rc.label] = ranges;
    const isN = ranges.filter(r => r.period === 'IS').length;
    const oosN = ranges.filter(r => r.period === 'OOS').length;
    console.log(`    ${rc.label}: ${ranges.length} ranges (${isN} IS, ${oosN} OOS)`);
  }

  // ── Phase 2: Simulate trades with all warmup modes ────────────────────

  console.log('\n  Phase 2: Simulating trades across all configurations...\n');

  const allResults = [];
  let combosDone = 0;

  for (const rc of RANGE_CONFIGS) {
    const ranges = rangesByConfig[rc.label];

    for (const tc of TRADE_CONFIGS) {
      for (const wc of WARMUP_CONFIGS) {
        const sim = new ProvenRangeTradeSimulator({
          ...tc,
          commission,
          warmupMode: wc.warmupMode,
          warmupN: wc.warmupN,
          refineBounds: wc.refineBounds,
        });

        let isTrades = [];
        let oosTrades = [];
        let isRangesTraded = 0;
        let oosRangesTraded = 0;

        for (const range of ranges) {
          const { trades, warmupStats } = sim.simulateRange(
            candles, range.startIdx, range.endIdx,
            range.rangeHigh, range.rangeLow
          );
          if (range.period === 'IS') {
            isTrades.push(...trades);
            if (trades.length > 0) isRangesTraded++;
          } else {
            oosTrades.push(...trades);
            if (trades.length > 0) oosRangesTraded++;
          }
        }

        const isMetrics = computeMetrics(isTrades);
        const oosMetrics = computeMetrics(oosTrades);

        allResults.push({
          rangeLabel: rc.label,
          tradeLabel: tc.label,
          warmupLabel: wc.label,
          rangeConfig: rc,
          tradeConfig: tc,
          warmupConfig: wc,
          is: { ...isMetrics, rangesTraded: isRangesTraded },
          oos: { ...oosMetrics, rangesTraded: oosRangesTraded },
        });

        combosDone++;
      }
    }

    const pct = ((RANGE_CONFIGS.indexOf(rc) + 1) / RANGE_CONFIGS.length * 100).toFixed(0);
    console.log(`    ${rc.label} done — ${combosDone}/${totalCombos} combos (${pct}%)`);
  }

  // ── Phase 3: Output Results ───────────────────────────────────────────

  console.log('\n');

  // Filter for minimum trade count
  const viable = allResults.filter(r => r.is.trades >= 30 && r.oos.trades >= 15);
  viable.sort((a, b) => b.is.totalPnlDollars - a.is.totalPnlDollars);

  // ── Warmup comparison: how does each warmup mode affect results? ──
  console.log('  ' + '═'.repeat(120));
  console.log('  WARMUP MODE COMPARISON (aggregated across all range/trade configs)');
  console.log('  ' + '═'.repeat(120));
  console.log('  ' + pad('Warmup', 18) + pad('IS Configs', 12) + pad('IS Avg WR%', 12)
    + pad('IS Avg PF', 10) + pad('IS Avg $/tr', 12) + pad('IS Avg Trades', 14)
    + pad('OOS Avg WR%', 12) + pad('OOS Avg PF', 12) + pad('OOS Avg $/tr', 12));
  console.log('  ' + '─'.repeat(120));

  for (const wc of WARMUP_CONFIGS) {
    const subset = allResults.filter(r => r.warmupLabel === wc.label && r.is.trades >= 10);
    if (!subset.length) {
      console.log('  ' + pad(wc.label, 18) + '(no results with >=10 trades)');
      continue;
    }
    const avgIsWR = subset.reduce((s, r) => s + r.is.winRate, 0) / subset.length;
    const avgIsPF = subset.reduce((s, r) => s + r.is.profitFactor, 0) / subset.length;
    const avgIsDollar = subset.reduce((s, r) => s + r.is.avgPnlDollars, 0) / subset.length;
    const avgIsTrades = subset.reduce((s, r) => s + r.is.trades, 0) / subset.length;
    const oosSubset = subset.filter(r => r.oos.trades >= 5);
    const avgOosWR = oosSubset.length ? oosSubset.reduce((s, r) => s + r.oos.winRate, 0) / oosSubset.length : 0;
    const avgOosPF = oosSubset.length ? oosSubset.reduce((s, r) => s + r.oos.profitFactor, 0) / oosSubset.length : 0;
    const avgOosDollar = oosSubset.length ? oosSubset.reduce((s, r) => s + r.oos.avgPnlDollars, 0) / oosSubset.length : 0;

    console.log('  ' + pad(wc.label, 18)
      + pad(subset.length, 12) + pad(avgIsWR.toFixed(1) + '%', 12)
      + pad(avgIsPF.toFixed(3), 10) + pad('$' + avgIsDollar.toFixed(1), 12)
      + pad(Math.round(avgIsTrades), 14)
      + pad(avgOosWR.toFixed(1) + '%', 12) + pad(avgOosPF.toFixed(3), 12)
      + pad('$' + avgOosDollar.toFixed(1), 12));
  }

  // ── Top configurations ──
  console.log('\n  ' + '═'.repeat(150));
  console.log('  TOP 40 CONFIGURATIONS (by IS total P&L, min 30 IS trades, 15 OOS trades)');
  console.log('  ' + '═'.repeat(150));
  console.log('  ' + pad('#', 4) + pad('Range', 12) + pad('Trade', 20) + pad('Warmup', 16)
    + pad('IS n', 6) + pad('IS WR%', 8) + pad('IS PF', 7) + pad('IS $/tr', 9) + pad('IS Total', 10)
    + pad('OOS n', 6) + pad('OOS WR%', 8) + pad('OOS PF', 8) + pad('OOS $/tr', 9) + pad('OOS Total', 10)
    + '  Verdict');
  console.log('  ' + '─'.repeat(150));

  const top = viable.slice(0, 40);
  for (let i = 0; i < top.length; i++) {
    const r = top[i];
    const verdict = getVerdict(r);
    console.log('  ' + pad(i + 1, 4)
      + pad(r.rangeLabel, 12) + pad(r.tradeLabel, 20) + pad(r.warmupLabel, 16)
      + pad(r.is.trades, 6) + pad(r.is.winRate.toFixed(1) + '%', 8)
      + pad(r.is.profitFactor.toFixed(2), 7) + pad('$' + r.is.avgPnlDollars.toFixed(0), 9)
      + pad('$' + r.is.totalPnlDollars.toFixed(0), 10)
      + pad(r.oos.trades, 6) + pad(r.oos.winRate.toFixed(1) + '%', 8)
      + pad(r.oos.profitFactor.toFixed(2), 8) + pad('$' + r.oos.avgPnlDollars.toFixed(0), 9)
      + pad('$' + r.oos.totalPnlDollars.toFixed(0), 10)
      + '  ' + verdict);
  }

  // ── Check for ANY profitable configs ──
  const profitable = viable.filter(r => r.is.avgPnlDollars > 0 && r.oos.avgPnlDollars > 0);
  console.log('\n  ' + '═'.repeat(100));
  if (profitable.length > 0) {
    console.log(`  PROFITABLE IN BOTH PERIODS: ${profitable.length} configurations`);
    console.log('  ' + '═'.repeat(100));
    profitable.sort((a, b) => b.oos.avgPnlDollars - a.oos.avgPnlDollars);
    console.log('  ' + pad('#', 4) + pad('Range', 12) + pad('Trade', 20) + pad('Warmup', 16)
      + pad('IS n', 6) + pad('IS WR%', 8) + pad('IS $/tr', 9)
      + pad('OOS n', 6) + pad('OOS WR%', 8) + pad('OOS $/tr', 9)
      + pad('IS PF', 7) + pad('OOS PF', 8));
    console.log('  ' + '─'.repeat(100));
    for (let i = 0; i < profitable.length; i++) {
      const r = profitable[i];
      console.log('  ' + pad(i + 1, 4)
        + pad(r.rangeLabel, 12) + pad(r.tradeLabel, 20) + pad(r.warmupLabel, 16)
        + pad(r.is.trades, 6) + pad(r.is.winRate.toFixed(1) + '%', 8)
        + pad('$' + r.is.avgPnlDollars.toFixed(0), 9)
        + pad(r.oos.trades, 6) + pad(r.oos.winRate.toFixed(1) + '%', 8)
        + pad('$' + r.oos.avgPnlDollars.toFixed(0), 9)
        + pad(r.is.profitFactor.toFixed(2), 7) + pad(r.oos.profitFactor.toFixed(2), 8));
    }
  } else {
    console.log('  NO configurations profitable in BOTH IS and OOS periods');
    console.log('  ' + '═'.repeat(100));
    // Show IS-only profitable
    const isOnly = viable.filter(r => r.is.avgPnlDollars > 0);
    if (isOnly.length > 0) {
      console.log(`\n  IS-ONLY PROFITABLE: ${isOnly.length} configurations`);
      isOnly.sort((a, b) => b.is.avgPnlDollars - a.is.avgPnlDollars);
      for (let i = 0; i < Math.min(20, isOnly.length); i++) {
        const r = isOnly[i];
        console.log('  ' + pad(i + 1, 4) + pad(r.rangeLabel, 12) + pad(r.tradeLabel, 20) + pad(r.warmupLabel, 16)
          + pad('IS: n=' + r.is.trades, 10) + pad('WR=' + r.is.winRate.toFixed(1) + '%', 10)
          + pad('$/tr=$' + r.is.avgPnlDollars.toFixed(0), 12)
          + pad('OOS: n=' + r.oos.trades, 10) + pad('WR=' + r.oos.winRate.toFixed(1) + '%', 12)
          + pad('$/tr=$' + r.oos.avgPnlDollars.toFixed(0), 12));
      }
    }
  }

  // ── Session breakdown for best configs ──
  if (top.length > 0) {
    console.log('\n  ' + '═'.repeat(100));
    console.log('  SESSION BREAKDOWN (top 5 configs)');
    console.log('  ' + '═'.repeat(100));

    for (let k = 0; k < Math.min(5, top.length); k++) {
      const r = top[k];
      console.log(`\n  #${k + 1}: ${r.rangeLabel} + ${r.tradeLabel} + ${r.warmupLabel}`);
      console.log('  ' + pad('Session', 14) + pad('IS n', 7) + pad('IS WR%', 8) + pad('IS $/tr', 9)
        + pad('OOS n', 7) + pad('OOS WR%', 8) + pad('OOS $/tr', 9));
      console.log('  ' + '─'.repeat(65));

      const rc = r.rangeConfig;
      const tc = r.tradeConfig;
      const wc = r.warmupConfig;
      const ranges = rangesByConfig[rc.label];

      for (const sess of ['overnight', 'premarket', 'rth', 'afterhours']) {
        const sim = new ProvenRangeTradeSimulator({
          ...tc, commission,
          warmupMode: wc.warmupMode, warmupN: wc.warmupN, refineBounds: wc.refineBounds,
        });

        let isTrades = [];
        let oosTrades = [];

        for (const range of ranges) {
          const { trades } = sim.simulateRange(candles, range.startIdx, range.endIdx, range.rangeHigh, range.rangeLow);
          const filtered = trades.filter(t => t.session === sess);
          if (range.period === 'IS') isTrades.push(...filtered);
          else oosTrades.push(...filtered);
        }

        const isM = computeMetrics(isTrades);
        const oosM = computeMetrics(oosTrades);
        console.log('  ' + pad(sess, 14) + pad(isM.trades, 7) + pad(isM.winRate.toFixed(1) + '%', 8)
          + pad('$' + isM.avgPnlDollars.toFixed(0), 9)
          + pad(oosM.trades, 7) + pad(oosM.winRate.toFixed(1) + '%', 8)
          + pad('$' + oosM.avgPnlDollars.toFixed(0), 9));
      }
    }
  }

  // ── Per-warmup best config ──
  console.log('\n  ' + '═'.repeat(130));
  console.log('  BEST CONFIG PER WARMUP MODE (by IS $/trade)');
  console.log('  ' + '═'.repeat(130));

  for (const wc of WARMUP_CONFIGS) {
    const subset = viable.filter(r => r.warmupLabel === wc.label);
    if (!subset.length) {
      console.log(`  ${pad(wc.label, 16)}: No viable configs`);
      continue;
    }
    subset.sort((a, b) => b.is.avgPnlDollars - a.is.avgPnlDollars);
    const best = subset[0];
    console.log('  ' + pad(wc.label, 16) + ': '
      + pad(best.rangeLabel, 12) + pad(best.tradeLabel, 20)
      + pad('IS: n=' + best.is.trades, 10) + pad('WR=' + best.is.winRate.toFixed(1) + '%', 10)
      + pad('PF=' + best.is.profitFactor.toFixed(2), 8)
      + pad('$/tr=$' + best.is.avgPnlDollars.toFixed(0), 12)
      + pad('OOS: n=' + best.oos.trades, 10) + pad('WR=' + best.oos.winRate.toFixed(1) + '%', 12)
      + pad('$/tr=$' + best.oos.avgPnlDollars.toFixed(0), 12));
  }

  // Save JSON
  const outputPath = path.join(__dirname, args.output);
  fs.writeFileSync(outputPath, JSON.stringify(allResults.map(r => ({
    rangeLabel: r.rangeLabel, tradeLabel: r.tradeLabel, warmupLabel: r.warmupLabel,
    is: r.is, oos: r.oos,
  })), null, 2));
  console.log(`\n  Results saved to ${args.output}`);
}

// ─── Helpers ────────────────────────────────────────────────────────────

function computeMetrics(trades) {
  if (!trades.length) {
    return {
      trades: 0, wins: 0, losses: 0, winRate: 0, profitFactor: 0,
      totalPnl: 0, totalPnlDollars: 0, avgPnl: 0, avgPnlDollars: 0,
      avgWin: 0, avgLoss: 0, maxWin: 0, maxLoss: 0, avgBarsHeld: 0,
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
