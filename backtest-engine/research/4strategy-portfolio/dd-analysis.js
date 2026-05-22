#!/usr/bin/env node
// Drawdown analysis on the 4-strategy portfolio, scaled to 1 MNQ contract.
//
// MNQ point value is $2 vs NQ's $20, so we scale all per-trade PnL by 0.1.
// Commission ratio is roughly preserved (broker-dependent), so we just scale netPnL.
//
// Reports:
//   1. Top-N peak-to-trough drawdown episodes (depth, duration, recovery)
//   2. Worst single trading day / week / month
//   3. Worst rolling 1d / 5d / 20d / 60d windows
//
// Defaults to the WITH-lstb (4-strategy) scenario; pass `--without-lstb` to flip.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { simulate, open, reject, realizeNativeClose } from '../multi-strategy-rules/rules/_base.js';
import { fmtET, fmtETDate, fmtETMonth } from '../multi-strategy-rules/lib/et-time.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '..', '..');
const OUT_DIR   = path.join(__dirname, 'output');
fs.mkdirSync(OUT_DIR, { recursive: true });

const STRATEGIES = [
  { key: 'lstb',           priority: 1, file: 'data/gold-standard/ls-flip-trigger-bar-v3.json' },
  { key: 'gex-lt-3m',      priority: 2, file: 'data/gold-standard/gex-lt-3m-crossover-v3.json' },
  { key: 'gex-flip-ivpct', priority: 3, file: 'data/gold-standard/gex-flip-ivpct-v2.json' },
  { key: 'gex-level-fade', priority: 4, file: 'data/gold-standard/gex-level-fade-v2.json' },
];

const MNQ_SCALE = 0.1; // NQ→MNQ contract size ratio.

function normSide(s) {
  if (!s) return null;
  const l = String(s).toLowerCase();
  if (l === 'long' || l === 'buy') return 'long';
  if (l === 'short' || l === 'sell') return 'short';
  return null;
}

function loadOne(def) {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, def.file), 'utf8'));
  const trades = raw.trades
    .filter(t => t.status === 'completed' && t.entryTime != null && t.exitTime != null && normSide(t.side) != null)
    .map(t => {
      const entryTime = t.entryTime;
      const rawExit   = t.exitTime ?? (entryTime + (t.duration ?? 0));
      const exitTime  = rawExit <= entryTime ? entryTime + 1 : rawExit;
      return {
        id: `${def.key}:${t.id}`,
        nativeId: t.id,
        strategyKey: def.key,
        side: normSide(t.side),
        entryTime,
        exitTime,
        duration: t.duration ?? (exitTime - entryTime),
        actualEntry: t.actualEntry ?? t.entryPrice,
        actualExit: t.actualExit,
        netPnL: t.netPnL,
        pointsPnL: t.pointsPnL,
        exitReason: t.exitReason,
        commission: t.commission ?? 5,
        pointValue: t.pointValue ?? 20,
        status: t.status,
      };
    });
  return trades;
}

const firstInWins = {
  name: 'first-in-wins',
  onSignal(state, trade) { if (state.position == null) open(state, trade); else reject(state); },
  onNativeExit(state, trade) {
    if (state.position && state.position.trade.id === trade.id) realizeNativeClose(state, trade);
  },
};

// ── Helpers ──────────────────────────────────────────────────────────────
function pad(s, n) { return String(s).padEnd(n); }
function fmtUsd(n) {
  if (n == null || Number.isNaN(n)) return '-';
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}
function round(n, d = 0) {
  if (n == null || !Number.isFinite(n)) return n;
  const k = Math.pow(10, d);
  return Math.round(n * k) / k;
}
function daysBetween(msA, msB) {
  return (msB - msA) / 86400000;
}

// Find every peak-to-trough drawdown episode in the equity curve.
// An "episode" starts at a new equity high and ends when a new high is set again
// (i.e., the drawdown fully recovers). If equity never recovers, the episode is
// still recorded with `recoveredAt = null`.
function findDrawdownEpisodes(equityCurve) {
  if (equityCurve.length === 0) return [];
  const episodes = [];
  let peak = equityCurve[0].equity;
  let peakIdx = 0;
  let trough = peak;
  let troughIdx = 0;
  let inDrawdown = false;

  for (let i = 1; i < equityCurve.length; i++) {
    const e = equityCurve[i].equity;
    if (e >= peak) {
      if (inDrawdown) {
        episodes.push({
          peakIdx,
          peakTs: equityCurve[peakIdx].t,
          peakEquity: peak,
          troughIdx,
          troughTs: equityCurve[troughIdx].t,
          troughEquity: trough,
          recoveredIdx: i,
          recoveredAt: equityCurve[i].t,
          depthUsd: peak - trough,
          depthPct: (peak - trough) / peak * 100,
          tradesInDD: i - peakIdx,
          drawdownDays: daysBetween(equityCurve[peakIdx].t, equityCurve[troughIdx].t),
          recoveryDays: daysBetween(equityCurve[troughIdx].t, equityCurve[i].t),
        });
      }
      peak = e; peakIdx = i; trough = e; troughIdx = i; inDrawdown = false;
    } else {
      inDrawdown = true;
      if (e < trough) { trough = e; troughIdx = i; }
    }
  }
  // Open drawdown at end of series (never recovered).
  if (inDrawdown) {
    episodes.push({
      peakIdx,
      peakTs: equityCurve[peakIdx].t,
      peakEquity: peak,
      troughIdx,
      troughTs: equityCurve[troughIdx].t,
      troughEquity: trough,
      recoveredIdx: null,
      recoveredAt: null,
      depthUsd: peak - trough,
      depthPct: (peak - trough) / peak * 100,
      tradesInDD: equityCurve.length - peakIdx,
      drawdownDays: daysBetween(equityCurve[peakIdx].t, equityCurve[troughIdx].t),
      recoveryDays: null,
    });
  }
  return episodes;
}

function worstRollingWindow(dailySeries, windowDays) {
  // dailySeries: [{date, pnl}], sorted ascending. Lowest sum of `windowDays` consecutive
  // trading days. Reported even if positive (still useful as a "worst stretch" indicator).
  let worst = { startIdx: -1, endIdx: -1, sum: Infinity };
  for (let i = 0; i + windowDays <= dailySeries.length; i++) {
    let s = 0;
    for (let j = 0; j < windowDays; j++) s += dailySeries[i + j].pnl;
    if (s < worst.sum) worst = { startIdx: i, endIdx: i + windowDays - 1, sum: s };
  }
  if (worst.startIdx < 0) return null;
  return {
    startDate: dailySeries[worst.startIdx].date,
    endDate: dailySeries[worst.endIdx].date,
    sumPnL: worst.sum,
    tradingDays: windowDays,
  };
}

// ── Main ────────────────────────────────────────────────────────────────
function main() {
  const argv = process.argv.slice(2);
  const withoutLstb = argv.includes('--without-lstb');
  const topN = (() => { const i = argv.indexOf('--top'); return i >= 0 ? parseInt(argv[i+1], 10) : 10; })();
  const scenarioLabel = withoutLstb ? '3-strategy (WITHOUT lstb)' : '4-strategy (WITH lstb)';

  const all = STRATEGIES
    .filter(s => !(withoutLstb && s.key === 'lstb'))
    .flatMap(loadOne)
    .sort((a, b) => a.entryTime - b.entryTime);

  const state = simulate(all, firstInWins);

  // Scale realized trades to MNQ.
  const trades = state.realizedTrades.map(r => ({
    ...r,
    netPnL_NQ: r.netPnL,
    netPnL_MNQ: r.netPnL * MNQ_SCALE,
  })).sort((a, b) => a.exitTime - b.exitTime);

  // Build per-trade equity curve.
  const STARTING_CAPITAL = 10000; // MNQ-scale starting capital — let's pick $10k since 1 MNQ has ~$1500 day margin.
  let eq = STARTING_CAPITAL;
  const curve = [{ t: trades[0]?.exitTime ?? Date.now(), equity: eq }];
  for (const t of trades) {
    eq += t.netPnL_MNQ;
    curve.push({ t: t.exitTime, equity: eq });
  }

  // Daily PnL series (one bucket per ET trading date), used for rolling-window worsts.
  const byDay = new Map();
  for (const t of trades) {
    const d = fmtETDate(t.exitTime);
    byDay.set(d, (byDay.get(d) || 0) + t.netPnL_MNQ);
  }
  const dailySeries = [...byDay.entries()]
    .map(([date, pnl]) => ({ date, pnl }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const byWeek = new Map();
  for (const d of dailySeries) {
    const dt = new Date(d.date + 'T12:00:00Z');
    const dayOfWeek = dt.getUTCDay();
    const monday = new Date(dt); monday.setUTCDate(dt.getUTCDate() - ((dayOfWeek + 6) % 7));
    const wk = monday.toISOString().slice(0, 10);
    byWeek.set(wk, (byWeek.get(wk) || 0) + d.pnl);
  }
  const byMonth = new Map();
  for (const t of trades) {
    const m = fmtETMonth(t.exitTime);
    byMonth.set(m, (byMonth.get(m) || 0) + t.netPnL_MNQ);
  }

  console.log('═══════════════════════════════════════════════════════════════════');
  console.log(`  Drawdown Analysis — ${scenarioLabel} @ 1 MNQ contract`);
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log();

  const totalPnL_MNQ = trades.reduce((s, t) => s + t.netPnL_MNQ, 0);
  const totalPnL_NQ  = trades.reduce((s, t) => s + t.netPnL_NQ, 0);
  console.log(`Trades: ${trades.length}    Period: ${fmtETDate(trades[0].exitTime)} → ${fmtETDate(trades[trades.length-1].exitTime)}`);
  console.log(`Total PnL (NQ scale, reference): ${fmtUsd(totalPnL_NQ)}`);
  console.log(`Total PnL (MNQ, what you'd see): ${fmtUsd(totalPnL_MNQ)}`);
  console.log(`Starting capital assumed for DD%: ${fmtUsd(STARTING_CAPITAL)}  (peak-relative DD% is capital-independent — listed too)`);
  console.log();

  // ── Top-N drawdown episodes ────────────────────────────────────────────
  const episodes = findDrawdownEpisodes(curve)
    .sort((a, b) => b.depthUsd - a.depthUsd)
    .slice(0, topN);

  console.log(`Top ${topN} peak-to-trough drawdown episodes (MNQ scale, deepest first):`);
  console.log();
  console.log('  ' + pad('peak date', 17) + pad('trough date', 17) + pad('recovered', 17) +
              pad('depth $', 12) + pad('depth %', 9) + pad('DD days', 9) + pad('recov days', 12) + pad('trades', 8));
  for (const e of episodes) {
    console.log('  ' +
      pad(fmtET(e.peakTs).slice(0, 16), 17) +
      pad(fmtET(e.troughTs).slice(0, 16), 17) +
      pad(e.recoveredAt ? fmtET(e.recoveredAt).slice(0, 16) : '(ongoing)', 17) +
      pad(fmtUsd(-e.depthUsd), 12) +
      pad(`-${round(e.depthPct, 2)}%`, 9) +
      pad(round(e.drawdownDays, 1), 9) +
      pad(e.recoveryDays == null ? '-' : round(e.recoveryDays, 1), 12) +
      pad(e.tradesInDD, 8));
  }
  console.log();

  // ── Worst single day / week / month ────────────────────────────────────
  const dayRanked  = [...dailySeries].sort((a, b) => a.pnl - b.pnl);
  const weekRanked = [...byWeek.entries()].map(([d, p]) => ({ date: d, pnl: p })).sort((a, b) => a.pnl - b.pnl);
  const monthRanked = [...byMonth.entries()].map(([d, p]) => ({ date: d, pnl: p })).sort((a, b) => a.pnl - b.pnl);

  console.log('Worst 10 single trading days (MNQ scale):');
  console.log('  ' + pad('date', 14) + 'pnl');
  for (const d of dayRanked.slice(0, 10)) console.log('  ' + pad(d.date, 14) + fmtUsd(d.pnl));
  console.log();

  console.log('Worst 10 weeks (Mon-anchored, MNQ scale):');
  console.log('  ' + pad('week-of', 14) + 'pnl');
  for (const w of weekRanked.slice(0, 10)) console.log('  ' + pad(w.date, 14) + fmtUsd(w.pnl));
  console.log();

  console.log('Worst 10 calendar months (MNQ scale):');
  console.log('  ' + pad('month', 10) + 'pnl');
  for (const m of monthRanked.slice(0, 10)) console.log('  ' + pad(m.date, 10) + fmtUsd(m.pnl));
  console.log();

  // ── Worst rolling windows ──────────────────────────────────────────────
  const windows = [1, 5, 10, 20, 60];
  console.log('Worst rolling N-trading-day windows (MNQ scale):');
  console.log('  ' + pad('window', 10) + pad('start', 14) + pad('end', 14) + 'sumPnL');
  for (const w of windows) {
    const r = worstRollingWindow(dailySeries, w);
    if (!r) continue;
    console.log('  ' + pad(`${w}d`, 10) + pad(r.startDate, 14) + pad(r.endDate, 14) + fmtUsd(r.sumPnL));
  }
  console.log();

  // ── Distribution of daily PnL ──────────────────────────────────────────
  const losingDays = dailySeries.filter(d => d.pnl < 0);
  const winningDays = dailySeries.filter(d => d.pnl > 0);
  const flatDays = dailySeries.filter(d => d.pnl === 0);
  console.log('Daily PnL distribution:');
  console.log(`  Total trading days:   ${dailySeries.length}`);
  console.log(`  Winning days:         ${winningDays.length} (${round(100 * winningDays.length / dailySeries.length, 1)}%)`);
  console.log(`  Losing days:          ${losingDays.length} (${round(100 * losingDays.length / dailySeries.length, 1)}%)`);
  console.log(`  Flat days:            ${flatDays.length}`);
  console.log(`  Avg winning day:      ${fmtUsd(winningDays.reduce((s,d)=>s+d.pnl,0) / Math.max(1, winningDays.length))}`);
  console.log(`  Avg losing day:       ${fmtUsd(losingDays.reduce((s,d)=>s+d.pnl,0) / Math.max(1, losingDays.length))}`);
  console.log();

  // ── CSV outputs ────────────────────────────────────────────────────────
  const suffix = withoutLstb ? '-3strat' : '-4strat';
  const epPath  = path.join(OUT_DIR, `dd-episodes-mnq${suffix}.csv`);
  fs.writeFileSync(epPath, ['peakTs_et,troughTs_et,recoveredAt_et,depthUsd_mnq,depthPct,drawdownDays,recoveryDays,tradesInDD']
    .concat(findDrawdownEpisodes(curve)
      .sort((a, b) => b.depthUsd - a.depthUsd)
      .map(e => [
        fmtET(e.peakTs), fmtET(e.troughTs), e.recoveredAt ? fmtET(e.recoveredAt) : '',
        round(-e.depthUsd), round(-e.depthPct, 2), round(e.drawdownDays, 2),
        e.recoveryDays == null ? '' : round(e.recoveryDays, 2), e.tradesInDD,
      ].join(','))).join('\n') + '\n');
  console.log(`✓ Wrote ${epPath}`);

  const eqPath = path.join(OUT_DIR, `equity-curve-mnq${suffix}.csv`);
  fs.writeFileSync(eqPath, ['t_et,equity_mnq']
    .concat(curve.map(p => [fmtET(p.t), round(p.equity)].join(',')))
    .join('\n') + '\n');
  console.log(`✓ Wrote ${eqPath}`);

  const dailyPath = path.join(OUT_DIR, `daily-pnl-mnq${suffix}.csv`);
  fs.writeFileSync(dailyPath, ['date,pnl_mnq']
    .concat(dailySeries.map(d => [d.date, round(d.pnl)].join(',')))
    .join('\n') + '\n');
  console.log(`✓ Wrote ${dailyPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
