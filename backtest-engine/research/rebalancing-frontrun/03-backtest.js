#!/usr/bin/env node
/**
 * 03-backtest.js — Backtest the Section-4 front-running strategy of
 * Harvey/Mazzoleni/Melone (NBER w33554) on the signals from 02.
 *
 * Strategy: R_strat[t+1] = (retE[t+1] - retB[t+1]) * wStrat[t]
 *   wThr[t]  = -ThresholdSignal[t] / 0.015
 *   wCal[t]  = last 5 BD of month:    sign(-CalendarSignal[t])
 *              first BD of new month: sign(CalendarSignal on 4th-to-last BD
 *                                          of the previous month)
 *              otherwise:             0
 *   wStrat[t] = (wThr[t] + wCal[t]) / 2
 *
 * Costs: |Δ wStrat| * costBps (round-trip across both legs, on notional).
 *
 * Validation targets (paper, 1997-09-10 → 2023-03-17):
 *   strategy 10.20%/yr, vol 9.17%, Sharpe 1.11, skew +5.23
 *   ex-GFC(2008-09→2009-03) & COVID(2020-03) Sharpe 0.90
 *   signal corr(Threshold, Calendar) ≈ 0.605; each modified leg vol ≈ 11.6%
 *
 * Usage: node 03-backtest.js [--bond etf|dgs10] [--cost-bps 1] [--lag 0]
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'output');

const args = process.argv.slice(2);
function argVal(name, dflt) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
}
const BOND = argVal('--bond', 'etf');
const COST_BPS = parseFloat(argVal('--cost-bps', '1'));
const LAG = parseInt(argVal('--lag', '0'), 10); // extra days between signal and position

function loadSignals(variant) {
  const lines = fs.readFileSync(path.join(OUT_DIR, `signals-${variant}.csv`), 'utf8').trim().split('\n');
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const [date, retE, retB, thr, cal, bdToME, firstBD] = lines[i].split(',');
    rows.push({
      date,
      retE: +retE,
      retB: +retB,
      thr: +thr,
      cal: +cal,
      bdToME: +bdToME,
      firstBD: firstBD === '1',
    });
  }
  return rows;
}

function stats(dailyRets, label) {
  const n = dailyRets.length;
  if (n === 0) return null;
  const mean = dailyRets.reduce((a, b) => a + b, 0) / n;
  const varr = dailyRets.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  const sd = Math.sqrt(varr);
  const skew = dailyRets.reduce((a, b) => a + (b - mean) ** 3, 0) / n / sd ** 3;
  let equity = 1, peak = 1, maxDD = 0;
  let worst = 0;
  for (const r of dailyRets) {
    equity *= 1 + r;
    if (equity > peak) peak = equity;
    maxDD = Math.max(maxDD, 1 - equity / peak);
    worst = Math.min(worst, r);
  }
  return {
    label,
    days: n,
    annRet: mean * 252,
    annVol: sd * Math.sqrt(252),
    sharpe: (mean * 252) / (sd * Math.sqrt(252)),
    skew,
    maxDD,
    worstDay: worst,
    totalCompounded: equity - 1,
  };
}

function fmt(s) {
  if (!s) return 'n/a';
  return `${s.label.padEnd(34)} n=${String(s.days).padStart(5)}  ret=${(s.annRet * 100).toFixed(2).padStart(7)}%  vol=${(s.annVol * 100).toFixed(2).padStart(6)}%  Sharpe=${s.sharpe.toFixed(2).padStart(5)}  skew=${s.skew.toFixed(2).padStart(6)}  maxDD=${(s.maxDD * 100).toFixed(1).padStart(5)}%  worst=${(s.worstDay * 100).toFixed(2)}%`;
}

function corr(a, b) {
  const n = a.length;
  const ma = a.reduce((x, y) => x + y, 0) / n;
  const mb = b.reduce((x, y) => x + y, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return num / Math.sqrt(da * db);
}

function main() {
  const rows = loadSignals(BOND);

  // Modified signals / strategy weights, indexed by signal day i
  const wThr = rows.map((r) => -r.thr / 0.015);
  const wCal = new Array(rows.length).fill(0);
  // Calendar signal on the 4th-to-last BD of each month, keyed by month
  const calMinus4ByMonth = new Map();
  for (const r of rows) if (r.bdToME === 4) calMinus4ByMonth.set(r.date.slice(0, 7), r.cal);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.bdToME <= 5) {
      wCal[i] = r.cal > 0 ? -1 : r.cal < 0 ? 1 : 0; // sign(-Calendar)
    } else if (r.firstBD && i > 0) {
      const prevMonth = rows[i - 1].date.slice(0, 7);
      const c4 = calMinus4ByMonth.get(prevMonth);
      if (c4 !== undefined) wCal[i] = c4 > 0 ? 1 : c4 < 0 ? -1 : 0; // sign(Calendar_{-4})
    }
  }
  const wStrat = rows.map((_, i) => (wThr[i] + wCal[i]) / 2);

  // Daily strategy returns: position formed at close i (+LAG), earns day i+1(+LAG)
  const dates = [];
  const gross = [];
  const net = [];
  const thrLeg = [];
  const calLeg = [];
  for (let i = 1 + LAG; i < rows.length; i++) {
    const sig = i - 1 - LAG;
    const xa = rows[i].retE - rows[i].retB;
    const g = xa * wStrat[sig];
    const turnover = Math.abs(wStrat[sig] - (sig > 0 ? wStrat[sig - 1] : 0));
    dates.push(rows[i].date);
    gross.push(g);
    net.push(g - (turnover * COST_BPS) / 10000);
    thrLeg.push(xa * wThr[sig]);
    calLeg.push(xa * wCal[sig]);
  }

  const inWindow = (d, from, to) => d >= from && d <= to;
  const PAPER_END = '2023-03-17';
  const idxPaper = dates.map((d, i) => i).filter((i) => dates[i] <= PAPER_END);
  const idxOOS = dates.map((d, i) => i).filter((i) => dates[i] > PAPER_END);
  const isCrisis = (d) =>
    inWindow(d, '2008-09-01', '2009-03-31') || inWindow(d, '2020-03-01', '2020-03-31');
  const idxExCrisis = idxPaper.filter((i) => !isCrisis(dates[i]));

  const pick = (arr, idx) => idx.map((i) => arr[i]);

  console.log(`\n=== Rebalancing front-run backtest — bond=${BOND}, cost=${COST_BPS}bp/turnover, lag=${LAG} ===`);
  console.log(`Sample: ${dates[0]} → ${dates[dates.length - 1]}\n`);

  console.log('— Validation vs paper (1997-09-10 → 2023-03-17: 10.20%/9.17%/1.11/skew 5.23) —');
  const idxPaperStart = idxPaper.filter((i) => dates[i] >= '1997-09-10');
  console.log(fmt(stats(pick(gross, idxPaperStart), 'GROSS paper window')));
  console.log(fmt(stats(pick(net, idxPaperStart), 'NET paper window')));
  console.log(fmt(stats(pick(gross, idxExCrisis.filter((i) => dates[i] >= '1997-09-10')), 'GROSS paper window ex-GFC/COVID')));
  console.log(fmt(stats(pick(thrLeg, idxPaperStart), 'Threshold leg (paper window)')));
  console.log(fmt(stats(pick(calLeg, idxPaperStart), 'Calendar leg (paper window)')));

  const thrSig = rows.filter((r) => r.date >= '1997-09-10' && r.date <= PAPER_END).map((r) => r.thr);
  const calSig = rows.filter((r) => r.date >= '1997-09-10' && r.date <= PAPER_END).map((r) => r.cal);
  console.log(`corr(Threshold, Calendar) paper window = ${corr(thrSig, calSig).toFixed(3)}  (paper: 0.605)`);

  console.log('\n— Full sample + true out-of-sample —');
  console.log(fmt(stats(gross, 'GROSS full sample')));
  console.log(fmt(stats(net, 'NET full sample')));
  console.log(fmt(stats(pick(gross, idxOOS), 'GROSS OOS (post 2023-03-17)')));
  console.log(fmt(stats(pick(net, idxOOS), 'NET OOS (post 2023-03-17)')));
  console.log(fmt(stats(pick(thrLeg, idxOOS), 'Threshold leg OOS')));
  console.log(fmt(stats(pick(calLeg, idxOOS), 'Calendar leg OOS')));

  console.log('\n— Per-year (net) —');
  const byYear = new Map();
  for (let i = 0; i < dates.length; i++) {
    const y = dates[i].slice(0, 4);
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y).push(net[i]);
  }
  for (const [y, rets] of byYear) {
    const s = stats(rets, y);
    console.log(`  ${y}: ret=${(s.annRet * 100).toFixed(1).padStart(6)}%  Sharpe=${s.sharpe.toFixed(2).padStart(6)}  (${s.days}d)`);
  }

  // Persist JSON for downstream analysis
  const out = {
    bond: BOND,
    costBps: COST_BPS,
    lag: LAG,
    generatedFrom: 'research/rebalancing-frontrun/03-backtest.js',
    validation: {
      grossPaperWindow: stats(pick(gross, idxPaperStart), 'gross'),
      netPaperWindow: stats(pick(net, idxPaperStart), 'net'),
      exCrisisGross: stats(pick(gross, idxExCrisis.filter((i) => dates[i] >= '1997-09-10')), 'exCrisis'),
      signalCorr: corr(thrSig, calSig),
    },
    oos: {
      gross: stats(pick(gross, idxOOS), 'gross'),
      net: stats(pick(net, idxOOS), 'net'),
    },
    daily: dates.map((d, i) => ({ d, g: +gross[i].toFixed(8), n: +net[i].toFixed(8) })),
  };
  fs.writeFileSync(path.join(OUT_DIR, `backtest-${BOND}-c${COST_BPS}-l${LAG}.json`), JSON.stringify(out));
  console.log(`\nSaved output/backtest-${BOND}-c${COST_BPS}-l${LAG}.json`);
}

main();
