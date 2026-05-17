#!/usr/bin/env node
// 06: Correlation/feature analysis on the first-in-wins portfolio.
// Look for slices that predictably under- or over-perform so we can design smart filters.
//
// Features computed per accepted portfolio trade:
//   - originStrategy           which strategy got the slot
//   - hourET, dayOfWeekET, monthET
//   - side                     long / short
//   - durationBucket
//   - rejDuringHold_same       count of same-side signals rejected during this hold
//   - rejDuringHold_opp        count of opposite-side signals rejected during this hold
//   - rejWithinNmin_opp        whether any opposite-side rejection arrived within 5 min of entry
//   - prevOutcome              W / L of the previous portfolio trade
//   - streakBefore             length of preceding same-outcome streak

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadAll } from './lib/load-trades.js';
import { calculateMetrics, fmtUsd, round } from './lib/metrics.js';
import { fmtET, fmtETDate, fmtETMonth } from './lib/et-time.js';
import { writeCsv } from './lib/csv.js';
import { firstInWins } from './rules/first-in-wins.js';
import { priorityFor } from './lib/load-trades.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'output');
fs.mkdirSync(OUT_DIR, { recursive: true });

function hourET(ms) { return parseInt(fmtET(ms).slice(11, 13), 10); }
function dayOfWeekET(ms) {
  // 0=Sun..6=Sat; compute via UTC offset hack with Intl.
  return new Date(fmtET(ms).replace(' ', 'T') + '-05:00').getUTCDay();
}
function durationBucket(min) {
  if (min < 5) return '0-5min';
  if (min < 15) return '5-15min';
  if (min < 60) return '15-60min';
  if (min < 240) return '1-4hr';
  if (min < 1440) return '4-24hr';
  return '>24hr';
}

function pad(s, n) { return String(s).padEnd(n); }
function pctStr(num, den) { return den === 0 ? '—' : ((num / den) * 100).toFixed(1) + '%'; }

// Simulate first-in-wins ourselves, tracking the rejection events during each hold.
function simulateWithRejTracking(allTrades) {
  const events = [];
  for (const t of allTrades) {
    events.push({ ts: t.entryTime, kind: 'entry-signal', trade: t });
    events.push({ ts: t.exitTime,  kind: 'native-exit',  trade: t });
  }
  events.sort((a, b) => {
    if (a.ts !== b.ts) return a.ts - b.ts;
    if (a.trade.id === b.trade.id) return a.kind === 'entry-signal' ? -1 : 1;
    if (a.kind !== b.kind) return a.kind === 'native-exit' ? -1 : 1;
    if (a.kind === 'entry-signal') return priorityFor(a.trade.strategyKey) - priorityFor(b.trade.strategyKey);
    return 0;
  });

  const portfolioTrades = [];
  let position = null;     // { trade, rej: [{side, strategyKey, ts}] }

  for (const ev of events) {
    if (ev.kind === 'entry-signal') {
      if (position == null) {
        position = { trade: ev.trade, rej: [] };
      } else {
        position.rej.push({ side: ev.trade.side, strategyKey: ev.trade.strategyKey, ts: ev.ts });
      }
    } else {
      if (position && position.trade.id === ev.trade.id) {
        // Realize the trade with rejection details.
        const t = position.trade;
        const rejSame = position.rej.filter(r => r.side === t.side).length;
        const rejOpp  = position.rej.filter(r => r.side !== t.side).length;
        const oppWithin5m = position.rej.some(r =>
          r.side !== t.side && (r.ts - t.entryTime) <= 5 * 60000
        );
        portfolioTrades.push({
          ...t,
          rejSame, rejOpp,
          oppWithin5m,
          rejAllSidesByStrategy: position.rej.map(r => `${r.strategyKey}:${r.side}`).join('|'),
        });
        position = null;
      }
    }
  }
  return portfolioTrades;
}

function statsForGroup(trades) {
  if (trades.length === 0) return { n: 0, wr: 0, pnl: 0, pf: 0, avgPnl: 0, avgLoss: 0, avgWin: 0 };
  const wins = trades.filter(t => t.netPnL > 0);
  const losses = trades.filter(t => t.netPnL <= 0);
  const gp = wins.reduce((s, t) => s + t.netPnL, 0);
  const gl = Math.abs(losses.reduce((s, t) => s + t.netPnL, 0));
  return {
    n: trades.length,
    wr: trades.length ? (wins.length / trades.length) * 100 : 0,
    pnl: gp - gl,
    pf: gl === 0 ? (gp > 0 ? Infinity : 0) : gp / gl,
    avgPnl: (gp - gl) / trades.length,
    avgWin: wins.length ? gp / wins.length : 0,
    avgLoss: losses.length ? gl / losses.length : 0,
  };
}

function reportGroupBy(label, trades, keyFn, sortFn) {
  const groups = new Map();
  for (const t of trades) {
    const k = keyFn(t);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  const rows = [...groups.entries()].map(([k, ts]) => ({ key: k, ...statsForGroup(ts) }));
  rows.sort(sortFn || ((a, b) => String(a.key).localeCompare(String(b.key))));
  console.log();
  console.log(`── ${label} ──`);
  console.log('  ' + pad('key', 18) + pad('n', 6) + pad('WR%', 7) + pad('PF', 6) + pad('avgPnL', 10) + pad('avgWin', 10) + pad('avgLoss', 10) + pad('totalPnL', 12));
  for (const r of rows) {
    console.log('  ' +
      pad(r.key, 18) +
      pad(r.n, 6) +
      pad(r.wr.toFixed(1), 7) +
      pad(isFinite(r.pf) ? r.pf.toFixed(2) : '∞', 6) +
      pad(fmtUsd(r.avgPnl), 10) +
      pad(fmtUsd(r.avgWin), 10) +
      pad(fmtUsd(r.avgLoss), 10) +
      pad(fmtUsd(r.pnl), 12));
  }
  return rows;
}

export function main() {
  const { allFlat } = loadAll();

  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  Step 06: Correlation Analysis on first-in-wins Portfolio');
  console.log('═══════════════════════════════════════════════════════════════════');

  // Replay first-in-wins, tracking rejections during each hold.
  const trades = simulateWithRejTracking(allFlat);

  // Add sequential features.
  let streak = 0;
  let lastOutcome = null;
  for (const t of trades) {
    t.prevOutcome = lastOutcome;
    t.streakBefore = streak;
    const outcome = t.netPnL > 0 ? 'W' : 'L';
    if (outcome === lastOutcome) streak += 1;
    else streak = 1;
    lastOutcome = outcome;
  }

  // Add display features.
  for (const t of trades) {
    t.hourET = hourET(t.entryTime);
    t.dowET = dayOfWeekET(t.entryTime);
    t.monthET = fmtETMonth(t.entryTime);
    t.durationMin = (t.exitTime - t.entryTime) / 60000;
    t.durationBucket = durationBucket(t.durationMin);
  }

  // Baseline.
  const base = statsForGroup(trades);
  console.log();
  console.log(`Baseline (first-in-wins): n=${base.n}, WR=${base.wr.toFixed(1)}%, PF=${base.pf.toFixed(2)}, totalPnL=${fmtUsd(base.pnl)}, avgPnL=${fmtUsd(base.avgPnl)}`);

  // ── Univariate cuts ────────────────────────────────────────────────────
  reportGroupBy('By origin strategy', trades, t => t.strategyKey);
  reportGroupBy('By side', trades, t => t.side);
  reportGroupBy('By exit reason', trades, t => t.exitReason);
  reportGroupBy('By duration bucket', trades, t => t.durationBucket,
    (a, b) => ['0-5min','5-15min','15-60min','1-4hr','4-24hr','>24hr'].indexOf(a.key) - ['0-5min','5-15min','15-60min','1-4hr','4-24hr','>24hr'].indexOf(b.key));
  reportGroupBy('By hour of entry (ET)', trades, t => String(t.hourET).padStart(2, '0'),
    (a, b) => parseInt(a.key) - parseInt(b.key));
  reportGroupBy('By day of week (ET, 0=Sun)', trades, t => String(t.dowET),
    (a, b) => parseInt(a.key) - parseInt(b.key));
  reportGroupBy('By month', trades, t => t.monthET);

  // ── Sequential ─────────────────────────────────────────────────────────
  reportGroupBy('By previous trade outcome', trades, t => t.prevOutcome ?? 'none');
  reportGroupBy('By streak length before (capped @5+)', trades, t => {
    const k = t.streakBefore;
    const outcome = t.prevOutcome ?? 'first';
    if (outcome === 'first') return 'first-trade';
    return `${outcome}-streak ${k >= 5 ? '5+' : k}`;
  });

  // ── Rejection-during-hold features (the "outside-the-box" angle) ───────
  console.log();
  console.log('── REJECTION-DURING-HOLD ANALYSIS ──');
  console.log('  Idea: while holding via first-in-wins, other strategies may emit signals that');
  console.log('  get rejected. Are those rejections (especially opposite-side ones) predictive');
  console.log('  of how our held trade performs?');

  reportGroupBy('By rejected-during-hold count (any side, bucketed)', trades, t => {
    const total = t.rejSame + t.rejOpp;
    if (total === 0) return '0';
    if (total === 1) return '1';
    if (total <= 3) return '2-3';
    if (total <= 6) return '4-6';
    return '7+';
  }, (a, b) => ['0','1','2-3','4-6','7+'].indexOf(a.key) - ['0','1','2-3','4-6','7+'].indexOf(b.key));

  reportGroupBy('By rejected SAME-side count during hold', trades, t => {
    const n = t.rejSame;
    if (n === 0) return '0';
    if (n === 1) return '1';
    if (n <= 3) return '2-3';
    return '4+';
  }, (a, b) => ['0','1','2-3','4+'].indexOf(a.key) - ['0','1','2-3','4+'].indexOf(b.key));

  reportGroupBy('By rejected OPPOSITE-side count during hold', trades, t => {
    const n = t.rejOpp;
    if (n === 0) return '0';
    if (n === 1) return '1';
    if (n <= 3) return '2-3';
    return '4+';
  }, (a, b) => ['0','1','2-3','4+'].indexOf(a.key) - ['0','1','2-3','4+'].indexOf(b.key));

  reportGroupBy('By opposite-side rejection within first 5min of entry', trades, t => t.oppWithin5m ? 'yes' : 'no');

  // ── Bivariate: origin × side ───────────────────────────────────────────
  reportGroupBy('By origin × side', trades, t => `${t.strategyKey}/${t.side}`);

  // ── Bivariate: hour × side ─────────────────────────────────────────────
  reportGroupBy('By hour × side', trades, t => `${String(t.hourET).padStart(2,'0')}/${t.side}`);

  // ── Smart-filter rule experiments ──────────────────────────────────────
  console.log();
  console.log('══════════════════════════════════════════════════════════════════');
  console.log('  Smart-filter experiments — apply a single rejection rule on top of');
  console.log('  first-in-wins. Re-simulating exit logic is NOT done — we simply drop');
  console.log('  trades matching the filter from the realized portfolio.');
  console.log('══════════════════════════════════════════════════════════════════');

  function experiment(label, predicate) {
    const kept = trades.filter(t => !predicate(t));
    const dropped = trades.filter(t => predicate(t));
    if (dropped.length === 0) {
      console.log(`  ${label}: 0 trades match — skipped`);
      return;
    }
    const m = calculateMetrics(kept.map(t => ({ ...t, exitTime: t.exitTime })));
    const droppedPnl = dropped.reduce((s, t) => s + t.netPnL, 0);
    console.log();
    console.log(`  ${label}`);
    console.log(`    dropped ${dropped.length} trades (${pctStr(dropped.length, trades.length)} of all) totaling ${fmtUsd(droppedPnl)}`);
    console.log(`    kept ${m.trades} trades: PnL=${fmtUsd(m.totalPnL)} (${m.totalPnL >= base.pnl ? '+' : ''}${fmtUsd(m.totalPnL - base.pnl)} vs baseline), PF=${m.profitFactor.toFixed(2)}, Sharpe=${m.sharpe.toFixed(2)}, DD%=${m.maxDD_pct.toFixed(2)} (${fmtUsd(m.maxDD_usd)}), WR=${m.winRate.toFixed(1)}%`);
  }

  // Run filter ideas.
  experiment('A) drop trades when opposite-side signal arrives in first 5 min',
    t => t.oppWithin5m);
  experiment('B) drop trades following a loss',
    t => t.prevOutcome === 'L');
  experiment('C) drop trades following a 3+ loss streak',
    t => t.prevOutcome === 'L' && t.streakBefore >= 3);
  experiment('D) drop trades with 3+ opposite-side rejections during hold',
    t => t.rejOpp >= 3);
  experiment('E) drop trades with NO same-side rejection during hold (no confirmation)',
    t => t.rejSame === 0);
  experiment('F) drop level-fade-origin trades (worst PF in prior analysis?)',
    t => t.strategyKey === 'gex-level-fade');
  experiment('G) drop entries in hour 13 ET (13:00)',
    t => t.hourET === 13);
  experiment('H) drop entries in afternoon (>=14 ET)',
    t => t.hourET >= 14);
  experiment('I) drop short trades during morning (10-12 ET)',
    t => t.side === 'short' && t.hourET >= 10 && t.hourET <= 11);
  experiment('J) keep only opposite-side-within-5min trades (inverted A)',
    t => !t.oppWithin5m);

  // ── Investigate the instant-stop-out problem ───────────────────────────
  console.log();
  console.log('── INSTANT STOP-OUT CHARACTERIZATION ──');
  console.log('  0-5min duration trades: 376 trades, -$107k. Where do they cluster?');
  const instant = trades.filter(t => t.durationMin < 5);
  reportGroupBy('  instant stop-outs by ORIGIN', instant, t => t.strategyKey);
  reportGroupBy('  instant stop-outs by HOUR', instant, t => String(t.hourET).padStart(2,'0'),
    (a, b) => parseInt(a.key) - parseInt(b.key));
  reportGroupBy('  instant stop-outs by HOUR × origin', instant, t => `${String(t.hourET).padStart(2,'0')}/${t.strategyKey}`);

  // ── Live-actionable filter combinations ────────────────────────────────
  console.log();
  console.log('══════════════════════════════════════════════════════════════════');
  console.log('  LIVE-ACTIONABLE filter experiments (entry-time features only)');
  console.log('══════════════════════════════════════════════════════════════════');

  experiment('K) drop morning short trades 10-12 ET (filter I)',
    t => t.side === 'short' && t.hourET >= 10 && t.hourET <= 11);
  experiment('L) drop level-fade entries (filter F)',
    t => t.strategyKey === 'gex-level-fade');
  experiment('M) drop level-fade SHORT entries only',
    t => t.strategyKey === 'gex-level-fade' && t.side === 'short');
  experiment('N) drop level-fade entries in mornings (10-12 ET)',
    t => t.strategyKey === 'gex-level-fade' && t.hourET >= 10 && t.hourET <= 11);
  experiment('O) drop level-fade SHORT mornings + filter I',
    t => (t.strategyKey === 'gex-level-fade' && t.side === 'short') || (t.side === 'short' && t.hourET >= 10 && t.hourET <= 11));
  experiment('P) drop lt-3m LONG entries 09 ET',
    t => t.strategyKey === 'gex-lt-3m' && t.side === 'long' && t.hourET === 9);
  experiment('Q) drop 09 ET entries (highest volume hour, mixed WR)',
    t => t.hourET === 9);
  experiment('R) drop AFTER losing month (preceding 30 days < 0 PnL)',
    t => false); // placeholder, computed separately below
  experiment('S) drop entries with rejected opposite signal within first 1 min of entry',
    t => false); // we don't have 1-min granularity; oppWithin5m is the proxy

  // R: drop entries when the prior 30-day P&L was negative.
  // Compute rolling 30d PnL up to entry time and filter.
  const rolling30 = [];
  let running = 0;
  const tradesByExitTime = [...trades].sort((a, b) => a.exitTime - b.exitTime);
  // We need to evaluate "at the moment of THIS entry, what is the PnL of trades whose
  // exit happened in the prior 30 days?"
  const dropFilter = (t) => {
    const cutoff = t.entryTime - 30 * 86400000;
    let p = 0;
    for (const o of tradesByExitTime) {
      if (o.exitTime > t.entryTime) break;
      if (o.exitTime >= cutoff && o.exitTime < t.entryTime) p += o.netPnL;
    }
    return p < 0;
  };
  experiment('R) drop entries when rolling 30-day portfolio PnL is negative (regime gate)',
    dropFilter);

  // ── Combined-filter stack experiments ──────────────────────────────────
  console.log();
  console.log('══════════════════════════════════════════════════════════════════');
  console.log('  Combined filter stacks — best-of breed combinations');
  console.log('══════════════════════════════════════════════════════════════════');

  experiment('STACK-1) drop level-fade @ 09-10 ET',
    t => t.strategyKey === 'gex-level-fade' && (t.hourET === 9 || t.hourET === 10));
  experiment('STACK-2) drop level-fade @ 09-10 ET + short morning 10-11 ET',
    t => (t.strategyKey === 'gex-level-fade' && (t.hourET === 9 || t.hourET === 10))
      || (t.side === 'short' && t.hourET >= 10 && t.hourET <= 11));
  experiment('STACK-3) drop level-fade @ 09-10 ET + level-fade short any time',
    t => (t.strategyKey === 'gex-level-fade' && (t.hourET === 9 || t.hourET === 10))
      || (t.strategyKey === 'gex-level-fade' && t.side === 'short'));
  experiment('STACK-4) drop level-fade @ 09-10 ET + lt-3m LONG @ 09 ET',
    t => (t.strategyKey === 'gex-level-fade' && (t.hourET === 9 || t.hourET === 10))
      || (t.strategyKey === 'gex-lt-3m' && t.side === 'long' && t.hourET === 9));
  experiment('STACK-5) drop level-fade @ 09-10 ET + short morning + lt-3m long 09',
    t => (t.strategyKey === 'gex-level-fade' && (t.hourET === 9 || t.hourET === 10))
      || (t.side === 'short' && t.hourET >= 10 && t.hourET <= 11)
      || (t.strategyKey === 'gex-lt-3m' && t.side === 'long' && t.hourET === 9));

  // Also let's see: what if we KEEP only gex-flip-ivpct (the highest-quality origin)?
  experiment('FOCUS) keep only gex-flip-ivpct origins (high WR)',
    t => t.strategyKey !== 'gex-flip-ivpct');

  // Write feature CSV for downstream offline analysis.
  const featureRows = trades.map(t => ({
    entry_et: fmtET(t.entryTime),
    exit_et: fmtET(t.exitTime),
    strategyKey: t.strategyKey,
    side: t.side,
    netPnL: round(t.netPnL),
    pointsPnL: round(t.pointsPnL, 2),
    exitReason: t.exitReason,
    durationMin: round(t.durationMin, 1),
    durationBucket: t.durationBucket,
    hourET: t.hourET,
    dowET: t.dowET,
    monthET: t.monthET,
    rejSame: t.rejSame,
    rejOpp: t.rejOpp,
    oppWithin5m: t.oppWithin5m ? 1 : 0,
    rejList: t.rejAllSidesByStrategy,
    prevOutcome: t.prevOutcome ?? 'none',
    streakBefore: t.streakBefore,
  }));
  const HDR = Object.keys(featureRows[0]);
  writeCsv(path.join(OUT_DIR, 'first-in-wins-features.csv'), HDR, featureRows);
  console.log();
  console.log('✓ Wrote output/first-in-wins-features.csv');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
